-- 0036: AI Resource Manager (Document 4, Part H, sections 20-25).
-- is_active marks the single primary Gemini project (the worker relies on that); routing_eligible decides routing.
-- Hierarchy: Account -> Project -> Credentials -> Models -> Quota pools.
-- Policy (Google APIs Terms: accept usage limits, do not circumvent them): a project's keys are routed only when the
-- project is eligible (the primary project, or billing enabled with the author's authorisation). Extra free projects
-- are inventoried and verified but never used to multiply free quota.

-- 1. Accounts (Google accounts, OpenRouter/Groq/Mistral accounts)
create table if not exists public.ai_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google', 'openrouter', 'groq', 'mistral')),
  label text not null,
  ownership text not null default 'unverified' check (ownership in ('unverified', 'manual', 'verified_oauth')),
  oauth_status text not null default 'not_connected' check (oauth_status in ('not_connected', 'connected', 'error', 'revoked')),
  oauth_vault_id uuid,                  -- refresh token, encrypted in Vault; never sent to the browser
  oauth_scopes text[],
  last_discovery_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.ai_accounts enable row level security;
drop policy if exists accounts_read on public.ai_accounts;
create policy accounts_read on public.ai_accounts for select using (app.is_author());

-- 2. Projects: identity and eligibility
alter table public.ai_projects add column if not exists provider text not null default 'gemini';
alter table public.ai_projects add column if not exists account_id uuid references public.ai_accounts(id);
alter table public.ai_projects add column if not exists project_number text;
alter table public.ai_projects add column if not exists display_name text;
alter table public.ai_projects add column if not exists billing_enabled boolean;          -- null = unknown
alter table public.ai_projects add column if not exists api_enabled boolean;              -- generativelanguage.googleapis.com
alter table public.ai_projects add column if not exists routing_eligible boolean not null default false;
alter table public.ai_projects add column if not exists eligibility_reason text;
alter table public.ai_projects add column if not exists discovery_source text not null default 'manual'
  check (discovery_source in ('manual', 'oauth', 'provisioned'));
alter table public.ai_projects add column if not exists verified_at timestamptz;
create unique index if not exists ai_projects_gcp_ref on public.ai_projects (google_project_ref) where google_project_ref is not null;
update public.ai_projects set routing_eligible = true, eligibility_reason = 'primary project'
 where is_active and not routing_eligible;

-- 3. Credentials: ownership, verification, duplicates, model availability
alter table public.ai_keys add column if not exists alias text;
alter table public.ai_keys add column if not exists ownership text not null default 'unverified'
  check (ownership in ('unverified', 'manual', 'verified_oauth'));
alter table public.ai_keys add column if not exists project_confirmed boolean not null default false;
alter table public.ai_keys add column if not exists last_verified_at timestamptz;
alter table public.ai_keys add column if not exists models_available text[];
alter table public.ai_keys add column if not exists google_key_name text;              -- projects/N/locations/global/keys/UID (from lookupKey)

-- 4. Quota limits learnt per project and model (from 429 replies or entered manually) and quota events
create table if not exists public.quota_limits (
  project_id uuid not null references public.ai_projects(id),
  model_id text not null,
  dimension text not null check (dimension in ('rpm', 'tpm', 'rpd')),
  limit_value bigint not null,
  source text not null default 'observed',   -- observed (from a 429 message) | manual | provider
  observed_at timestamptz not null default now(),
  primary key (project_id, model_id, dimension)
);
create table if not exists public.quota_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  project_id uuid, key_id uuid, model_id text,
  dimension text not null check (dimension in ('rpm', 'tpm', 'rpd', 'unknown')),
  limit_value bigint, retry_after_seconds int, message text
);
create index if not exists quota_events_at on public.quota_events (at desc);
alter table public.quota_limits enable row level security;
alter table public.quota_events enable row level security;
drop policy if exists quota_limits_read on public.quota_limits;
create policy quota_limits_read on public.quota_limits for select using (app.is_author());
drop policy if exists quota_events_read on public.quota_events;
create policy quota_events_read on public.quota_events for select using (app.is_author());

-- 429 dimension from the provider's message. Gemini: "Quota exceeded for metric: ...requests..., limit: N" plus
-- quotaId ...PerDay... / ...PerMinute...; tokens metrics mean TPM.
create or replace function app.quota_dimension(p_error text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_error ~* 'per ?day|PerDay|requests per day|RPD|daily|free-models-per-day' then 'rpd'
    when p_error ~* 'token' then 'tpm'
    when p_error ~* 'per ?minute|PerMinute|RPM|requests per min' then 'rpm'
    else 'unknown' end
$$;

create or replace function app.record_quota_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_dim text; v_limit bigint;
begin
  if new.http_status is distinct from 429 then return new; end if;
  v_dim := app.quota_dimension(new.error);
  v_limit := nullif(substring(new.error from 'limit:\s*([0-9]+)'), '')::bigint;
  insert into public.quota_events(project_id, key_id, model_id, dimension, limit_value, message)
  values (new.project_id, new.key_id, new.model_id, v_dim, v_limit, left(new.error, 400));
  if v_limit is not null and v_dim <> 'unknown' and new.project_id is not null then
    insert into public.quota_limits(project_id, model_id, dimension, limit_value, source)
    values (new.project_id, new.model_id, v_dim, v_limit, 'observed')
    on conflict (project_id, model_id, dimension) do update set limit_value = excluded.limit_value, observed_at = now()
      where public.quota_limits.source <> 'manual';
  end if;
  return new;
end $$;
drop trigger if exists record_quota_event on public.agent_runs;
create trigger record_quota_event after insert on public.agent_runs for each row execute function app.record_quota_event();

-- Quota pools: one per (eligible project, model) with usage now and today against known limits.
create or replace function app.quota_pools()
returns jsonb language sql stable security definer set search_path = public as $$
  with day0 as (select date_trunc('day', now() - interval '8 hours') + interval '8 hours' d),
  use as (
    select r.project_id, r.model_id,
           count(*) filter (where r.created_at > now() - interval '1 minute') req_1m,
           sum(coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0)) filter (where r.created_at > now() - interval '1 minute') tok_1m,
           count(*) filter (where r.created_at >= (select d from day0)) req_today,
           count(*) filter (where r.created_at >= (select d from day0) and r.status = 'ok') ok_today,
           round(100.0 * count(*) filter (where r.status = 'ok' and r.created_at > now() - interval '1 hour')
                 / nullif(count(*) filter (where r.created_at > now() - interval '1 hour'), 0)) ok_pct_1h,
           round(avg(r.latency_ms) filter (where r.status = 'ok' and r.created_at > now() - interval '1 hour')) latency_ms_1h
      from public.agent_runs r where r.created_at > now() - interval '30 hours' group by 1, 2)
  select coalesce(jsonb_agg(jsonb_build_object(
    'project', p.label, 'project_ref', p.google_project_ref, 'eligible', p.routing_eligible, 'model', u.model_id,
    'requests_last_minute', u.req_1m, 'tokens_last_minute', u.tok_1m, 'requests_today', u.req_today, 'ok_today', u.ok_today,
    'ok_pct_last_hour', u.ok_pct_1h, 'latency_ms_last_hour', u.latency_ms_1h,
    'rpm_limit', (select limit_value from public.quota_limits l where l.project_id = p.id and l.model_id = u.model_id and dimension = 'rpm'),
    'tpm_limit', (select limit_value from public.quota_limits l where l.project_id = p.id and l.model_id = u.model_id and dimension = 'tpm'),
    'rpd_limit', (select limit_value from public.quota_limits l where l.project_id = p.id and l.model_id = u.model_id and dimension = 'rpd'),
    'resting_until', (select until from public.model_rest m where m.model_id = case when u.model_id ~ '^(groq|mistral|openrouter)/'
                        then regexp_replace(u.model_id, '/', ':') else u.model_id end and m.until > now()))
    order by p.label, u.req_today desc), '[]')
  from use u join public.ai_projects p on p.id = u.project_id
$$;

-- 5. Provisioning log: every discovery and provisioning operation is visible
create table if not exists public.provisioning_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  account_id uuid references public.ai_accounts(id),
  operation text not null,        -- connect, discover, lookup_key, create_project, enable_api, create_key, verify, manual_link
  target text, status text not null check (status in ('started', 'ok', 'refused', 'error')),
  detail text
);
alter table public.provisioning_log enable row level security;
drop policy if exists provisioning_log_read on public.provisioning_log;
create policy provisioning_log_read on public.provisioning_log for select using (app.is_author());

-- 6. Routing respects eligibility: only keys of eligible projects are ever handed to the worker.
create or replace function app.resolve_key_for_team(p_team_code text)
returns table(key_id uuid, project_id uuid, vault_secret_id uuid, label text)
language sql stable security definer set search_path = public as $$
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.key_assignments ka
     join public.ai_keys k on k.id = ka.key_id and k.provider = 'gemini'
     join public.ai_projects p on p.id = k.project_id and p.routing_eligible
    where ka.team_code = p_team_code and k.status = 'active')
  union all
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.ai_keys k join public.ai_projects p on p.id = k.project_id and p.routing_eligible
    where k.status = 'active' and k.provider = 'gemini'
      and not exists (select 1 from public.key_assignments ka join public.ai_keys k2 on k2.id = ka.key_id
                       where ka.team_code = p_team_code and k2.status = 'active' and k2.provider = 'gemini')
    order by k.created_at limit 1)
  limit 1
$$;

-- 7. Manual association (fallback when automated discovery is unavailable): register a project and link keys to it.
create or replace function app.admin_upsert_project(p_ref text, p_label text, p_number text default null,
                                                    p_billing boolean default null, p_account uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.ai_projects(label, google_project_ref, project_number, billing_enabled, account_id, usage_tier, is_active,
                                 routing_eligible, eligibility_reason, discovery_source)
  values (p_label, p_ref, p_number, p_billing, p_account, case when p_billing then 'paid' else 'free' end, false, false,
          'not eligible until billing is enabled and paid use is authorised', 'manual')
  on conflict (google_project_ref) where google_project_ref is not null do update
     set label = excluded.label, project_number = coalesce(excluded.project_number, ai_projects.project_number),
         billing_enabled = coalesce(excluded.billing_enabled, ai_projects.billing_enabled),
         account_id = coalesce(excluded.account_id, ai_projects.account_id)
  returning id into v;
  insert into public.provisioning_log(operation, target, status, detail) values ('manual_link', p_ref, 'ok', 'project registered or updated');
  return v;
end $$;

create or replace function app.admin_link_key(p_key uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.ai_keys set project_id = p_project, ownership = case when ownership = 'verified_oauth' then ownership else 'manual' end,
         project_confirmed = (ownership = 'verified_oauth') where id = p_key;
  insert into public.provisioning_log(operation, target, status, detail)
  select 'manual_link', k.label, 'ok', 'key linked to ' || coalesce(p.google_project_ref, p.label) || ' (not verified with Google)'
    from public.ai_keys k, public.ai_projects p where k.id = p_key and p.id = p_project;
end $$;

-- Routing eligibility can be switched on for a paid project only with an explicit authorisation from the author.
create or replace function app.admin_set_project_eligibility(p_project uuid, p_eligible boolean, p_authorise_paid boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare p public.ai_projects%rowtype;
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into p from public.ai_projects where id = p_project;
  if p_eligible and coalesce(p.billing_enabled, false) is false and p.eligibility_reason is distinct from 'primary project' then
    raise exception 'Only the primary project or a project with billing enabled can be used. Using extra free projects to add quota would circumvent Google''s usage limits.';
  end if;
  if p_eligible and coalesce(p.billing_enabled, false) and not p_authorise_paid then
    raise exception 'This project has billing enabled: using it can incur charges. Authorise paid use explicitly (and set a budget) first.';
  end if;
  update public.ai_projects set routing_eligible = p_eligible,
         eligibility_reason = case when p_eligible and coalesce(p.billing_enabled, false) then 'paid project, use authorised by the author ' || now()::date
                                   when p_eligible then eligibility_reason else 'switched off by the author' end
   where id = p_project;
  insert into public.provisioning_log(operation, target, status, detail)
  values ('eligibility', coalesce(p.google_project_ref, p.label), 'ok', case when p_eligible then 'routing on' else 'routing off' end);
end $$;

-- 8. Key inventory for the Resources page (never returns secrets)
create or replace function app.key_inventory()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', k.id, 'label', k.label, 'alias', k.alias, 'provider', k.provider, 'last4', k.key_last4,
    'fingerprint', left(k.key_fingerprint, 12), 'status', k.status, 'ownership', k.ownership,
    'project_id', k.project_id, 'project', coalesce(p.google_project_ref, p.label), 'project_confirmed', k.project_confirmed,
    'eligible', p.routing_eligible, 'assigned_team', (select string_agg(team_code, ', ') from public.key_assignments a where a.key_id = k.id),
    'last_verified_at', k.last_verified_at, 'models', coalesce(array_length(k.models_available, 1), 0),
    'duplicate_of', (select k2.label from public.ai_keys k2 where k2.key_fingerprint = k.key_fingerprint and k2.created_at < k.created_at limit 1),
    'calls_today', (select count(*) from public.agent_runs r where r.key_id = k.id and r.created_at > now() - interval '24 hours'))
    order by k.provider, k.label), '[]')
  from public.ai_keys k left join public.ai_projects p on p.id = k.project_id
  where app.is_author() or auth.role() = 'service_role'
$$;

revoke all on function app.admin_upsert_project(text, text, text, boolean, uuid) from public, anon;
revoke all on function app.admin_link_key(uuid, uuid) from public, anon;
revoke all on function app.admin_set_project_eligibility(uuid, boolean, boolean) from public, anon;
revoke all on function app.key_inventory() from public, anon;
revoke all on function app.quota_pools() from public, anon;
grant execute on function app.admin_upsert_project(text, text, text, boolean, uuid), app.admin_link_key(uuid, uuid),
  app.admin_set_project_eligibility(uuid, boolean, boolean), app.key_inventory(), app.quota_pools() to authenticated, service_role;

-- 9. Exponential backoff with jitter for non-quota failures; quota waits keep the provider's own time plus up to 15% jitter.
create or replace function app.fail_job(p_job uuid, p_error text, p_retry_in_seconds integer, p_quota boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_attempts int; v_wait numeric;
begin
  select attempts into v_attempts from public.agent_jobs where id = p_job;
  v_wait := case when p_quota then p_retry_in_seconds * (1 + random() * 0.15)
                 else least(900, greatest(p_retry_in_seconds, 15 * power(2, greatest(coalesce(v_attempts, 1) - 1, 0)))) * (0.8 + random() * 0.4) end;
  update public.agent_jobs
     set status = case when p_quota then 'waiting_quota' when attempts >= max_attempts then 'failed' else 'queued' end,
         attempts = case when p_quota then greatest(attempts - 1, 0) else attempts end,
         run_after = now() + make_interval(secs => v_wait),
         last_error = p_error, locked_by = null, updated_at = now()
   where id = p_job;
end $$;
