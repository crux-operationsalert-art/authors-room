-- 0002_ai_ops.sql — teams, agent roles, model registry, Gemini project + key
-- registry (secrets in Supabase Vault), job queue, call ledger, usage views.
--
-- Quota rule (Blueprint D-01): Gemini rate limits are per Google Cloud PROJECT,
-- not per key. Keys here exist for team attribution, isolation and rotation
-- (e.g. revoke one leaked key without stopping every team). All keys belong to
-- the single active project, and quota is measured against that project.

-- ---------------------------------------------------------------- teams & roles
create table public.teams (
  code        text primary key,
  name        text not null,
  description text not null,
  sort        int  not null
);

insert into public.teams(code, name, description, sort) values
  ('orchestration','Orchestration','Chief Editor: assigns work, consolidates reviews, enforces gates',1),
  ('ideation','Ideation','Interview, genre directions, research',2),
  ('writing','Writing','Book and story architecture, drafting, voice',3),
  ('editorial','Editorial','Continuity, developmental, line/copy, logic and facts',4),
  ('readers','Readers','Simulated reader panel and beta-reader feedback',5),
  ('assurance','Risk & Assurance','Originality and rights, authenticity, sensitivity',6),
  ('publishing','Publishing','Production, metadata, exports, release',7),
  ('retrieval','Retrieval','Embeddings for whole-book search',8);

create table public.agent_roles (
  code         text primary key,
  name         text not null,
  team_code    text not null references public.teams(code),
  default_tier text not null check (default_tier in ('fast','standard','deep','embedding'))
);

insert into public.agent_roles(code, name, team_code, default_tier) values
  ('chief_editor','Chief Editor','orchestration','deep'),
  ('author_interviewer','Author Interviewer','ideation','standard'),
  ('genre_strategist','Genre Strategist','ideation','deep'),
  ('literary_researcher','Literary Researcher','ideation','standard'),
  ('book_architect','Book Architect','writing','deep'),
  ('story_architect','Story Architect','writing','deep'),
  ('lead_writer','Lead Writer','writing','standard'),
  ('voice_custodian','Voice Custodian','writing','fast'),
  ('continuity_manager','Continuity Manager','editorial','standard'),
  ('developmental_editor','Developmental Editor','editorial','deep'),
  ('line_copy_editor','Line and Copy Editor','editorial','fast'),
  ('logic_fact_checker','Logic and Fact Checker','editorial','standard'),
  ('reader_panel_manager','Reader Panel Manager','readers','fast'),
  ('originality_rights_auditor','Originality and Rights Auditor','assurance','standard'),
  ('authenticity_reviewer','Authenticity and Voice Reviewer','assurance','standard'),
  ('sensitivity_accessibility_reviewer','Sensitivity and Accessibility Reviewer','assurance','standard'),
  ('production_editor','Production Editor','publishing','fast'),
  ('publishing_manager','Publishing Manager','publishing','standard'),
  ('embedder','Embedder','retrieval','embedding');

-- ---------------------------------------------------------------- models
-- Model ids and prices change often: they live here, never in code.
create table public.model_registry (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null default 'gemini',
  tier                  text not null check (tier in ('fast','standard','deep','embedding')),
  model_id              text not null,
  input_price_per_mtok  numeric(12,6) not null default 0,   -- USD per 1M input tokens
  output_price_per_mtok numeric(12,6) not null default 0,   -- USD per 1M output tokens
  context_limit         int,
  enabled               boolean not null default true,
  updated_at            timestamptz not null default now()
);
create unique index model_registry_one_enabled_per_tier
  on public.model_registry(provider, tier) where enabled;

-- ---------------------------------------------------------------- project & keys
create table public.ai_projects (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,
  google_project_ref text,            -- the project name/number shown in AI Studio
  usage_tier         text not null default 'free'
                     check (usage_tier in ('free','tier1','tier2','tier3')),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);
-- D-01: exactly one active Gemini project for this application.
create unique index ai_projects_single_active on public.ai_projects((true)) where is_active;

-- Limits as shown on AI Studio's rate-limit page for this project and tier.
create table public.project_model_limits (
  project_id uuid not null references public.ai_projects(id),
  model_id   text not null,
  rpm        int,
  tpm        int,
  rpd        int,
  primary key (project_id, model_id)
);

create table public.ai_keys (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.ai_projects(id),
  label           text not null unique,
  key_last4       text not null check (length(key_last4) = 4),
  key_fingerprint text not null unique,        -- sha256 of the key, to stop duplicates
  vault_secret_id uuid not null,               -- secret itself lives only in Vault
  status          text not null default 'active'
                  check (status in ('active','disabled','revoked')),
  notes           text,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);

-- One key per team; one key may serve several teams.
create table public.key_assignments (
  team_code   text primary key references public.teams(code),
  key_id      uuid not null references public.ai_keys(id),
  assigned_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- queue & ledger
create table public.agent_jobs (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid references public.books(id),
  workflow     text not null,
  step         text not null,
  role_code    text not null references public.agent_roles(code),
  priority     int  not null default 50,   -- higher runs first
  status       text not null default 'queued'
               check (status in ('queued','running','waiting_quota','done','failed','cancelled')),
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  run_after    timestamptz not null default now(),
  locked_by    text,
  locked_at    timestamptz,
  key_id       uuid references public.ai_keys(id),
  payload      jsonb not null default '{}'::jsonb,
  result       jsonb,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index agent_jobs_ready on public.agent_jobs(priority desc, created_at)
  where status in ('queued','waiting_quota');

create table public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references public.agent_jobs(id),
  book_id       uuid references public.books(id),
  role_code     text not null references public.agent_roles(code),
  team_code     text not null references public.teams(code),
  key_id        uuid references public.ai_keys(id),
  project_id    uuid references public.ai_projects(id),
  model_id      text not null,
  prompt_hash   text,
  prompt_version text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cost_estimate numeric(12,6) not null default 0,
  latency_ms    int,
  status        text not null check (status in ('ok','rate_limited','error','schema_invalid')),
  http_status   int,
  error         text,
  created_at    timestamptz not null default now()
);
create index agent_runs_time on public.agent_runs(created_at);
create index agent_runs_key_time on public.agent_runs(key_id, created_at);

-- ---------------------------------------------------------------- functions
-- RPD resets at midnight Pacific (Google docs), so "today" is a Pacific day.
create or replace function app.pacific_day_start() returns timestamptz
language sql stable as $$
  select (date_trunc('day', now() at time zone 'America/Los_Angeles')) at time zone 'America/Los_Angeles'
$$;

-- Register a key: secret goes to Vault, only last 4 + fingerprint stay here.
create or replace function app.admin_add_ai_key(p_label text, p_secret text, p_team_code text default null,
                                                p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_project uuid; v_secret uuid; v_key uuid; v_fp text;
begin
  if p_secret is null or length(p_secret) < 20 then raise exception 'secret looks invalid'; end if;
  select id into v_project from public.ai_projects where is_active;
  if v_project is null then
    raise exception 'create the active Gemini project first (app.admin_set_project)';
  end if;
  v_fp := encode(extensions.digest(p_secret, 'sha256'), 'hex');
  if exists (select 1 from public.ai_keys where key_fingerprint = v_fp) then
    raise exception 'this key is already registered';
  end if;
  v_secret := vault.create_secret(p_secret, 'gemini-key-' || p_label, 'Author''s Room Gemini key');
  insert into public.ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, notes)
  values (v_project, p_label, right(p_secret, 4), v_fp, v_secret, p_notes)
  returning id into v_key;
  if p_team_code is not null then
    insert into public.key_assignments(team_code, key_id) values (p_team_code, v_key)
    on conflict (team_code) do update set key_id = excluded.key_id, assigned_at = now();
  end if;
  return v_key;
end $$;

create or replace function app.admin_set_project(p_label text, p_google_ref text, p_tier text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from public.ai_projects where is_active;
  if v is null then
    insert into public.ai_projects(label, google_project_ref, usage_tier)
    values (p_label, p_google_ref, p_tier) returning id into v;
  else
    update public.ai_projects set label = p_label, google_project_ref = p_google_ref,
           usage_tier = p_tier where id = v;
  end if;
  return v;
end $$;

-- Reassign a team to a key (author action from the dashboard).
create or replace function app.assign_team_key(p_team_code text, p_key_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app.is_author() or auth.role() = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ai_keys where id = p_key_id and status = 'active') then
    raise exception 'key is not active';
  end if;
  insert into public.key_assignments(team_code, key_id) values (p_team_code, p_key_id)
  on conflict (team_code) do update set key_id = excluded.key_id, assigned_at = now();
end $$;

create or replace function app.set_key_status(p_key_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app.is_author() or auth.role() = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.ai_keys set status = p_status,
         revoked_at = case when p_status = 'revoked' then now() else revoked_at end
   where id = p_key_id;
end $$;

-- Which key a team should use. Falls back to another ACTIVE key in the same
-- project only when the team's key is disabled/revoked (availability), never
-- to escape a quota limit: quota is shared by every key in the project.
create or replace function app.resolve_key_for_team(p_team_code text)
returns table(key_id uuid, project_id uuid, vault_secret_id uuid, label text)
language sql stable security definer set search_path = public as $$
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.key_assignments ka
     join public.ai_keys k on k.id = ka.key_id
     join public.ai_projects p on p.id = k.project_id and p.is_active
    where ka.team_code = p_team_code and k.status = 'active')
  union all
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.ai_keys k join public.ai_projects p on p.id = k.project_id and p.is_active
    where k.status = 'active'
      and not exists (select 1 from public.key_assignments ka join public.ai_keys k2 on k2.id = ka.key_id
                       where ka.team_code = p_team_code and k2.status = 'active')
    order by k.created_at limit 1)
  limit 1
$$;

-- Service role only: decrypt a key for one outgoing request.
create or replace function app.get_key_secret(p_key_id uuid) returns text
language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds
  join public.ai_keys k on k.vault_secret_id = ds.id
  where k.id = p_key_id and k.status = 'active'
$$;

-- Queue: claim the next ready job (SKIP LOCKED: safe with several workers).
create or replace function app.claim_next_job(p_worker text)
returns setof public.agent_jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.agent_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker,
         locked_at = now(), updated_at = now()
   where j.id = (
     select id from public.agent_jobs
      where status in ('queued','waiting_quota') and run_after <= now()
      order by priority desc, created_at
      for update skip locked
      limit 1)
  returning j.*;
end $$;

create or replace function app.complete_job(p_job uuid, p_result jsonb)
returns void language sql security definer set search_path = public as $$
  update public.agent_jobs set status = 'done', result = p_result, locked_by = null,
         updated_at = now() where id = p_job
$$;

-- p_quota = true: provider said the PROJECT is out of quota -> wait, don't burn attempts.
create or replace function app.fail_job(p_job uuid, p_error text, p_retry_in_seconds int, p_quota boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.agent_jobs
     set status = case when p_quota then 'waiting_quota'
                       when attempts >= max_attempts then 'failed'
                       else 'queued' end,
         attempts = case when p_quota then greatest(attempts - 1, 0) else attempts end,
         run_after = now() + make_interval(secs => p_retry_in_seconds),
         last_error = p_error, locked_by = null, updated_at = now()
   where id = p_job;
end $$;

-- Project-wide pre-check shared by every worker invocation (stateless workers).
-- Returns 0 when a call may go now, else seconds to wait. Counts ALL keys.
create or replace function app.quota_gate(p_model text, p_est_tokens int default 0)
returns int language plpgsql stable security definer set search_path = public as $$
declare l public.project_model_limits%rowtype; v_day int; v_min int; v_tok int; v_limited int;
begin
  select pml.* into l from public.project_model_limits pml
    join public.ai_projects p on p.id = pml.project_id and p.is_active
   where pml.model_id = p_model;
  select count(*) filter (where status <> 'rate_limited' and created_at >= app.pacific_day_start()),
         count(*) filter (where status <> 'rate_limited' and created_at >= now() - interval '1 minute'),
         coalesce(sum(input_tokens) filter (where created_at >= now() - interval '1 minute'), 0),
         count(*) filter (where status = 'rate_limited' and created_at >= now() - interval '1 minute')
    into v_day, v_min, v_tok, v_limited
    from public.agent_runs where model_id = p_model;
  if l.rpd is not null and v_day >= l.rpd then
    return greatest(1, extract(epoch from (app.pacific_day_start() + interval '1 day' - now()))::int);
  end if;
  if v_limited > 0 then return 60; end if;                       -- provider said no in the last minute
  if l.rpm is not null and v_min >= l.rpm then return 60; end if;
  if l.tpm is not null and v_tok > 0 and v_tok + p_est_tokens > l.tpm then return 60; end if;
  return 0;
end $$;

create or replace function app.cost_today_usd() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_estimate), 0) from public.agent_runs where created_at >= app.pacific_day_start()
$$;

create or replace function app.set_job_key(p_job uuid, p_key uuid)
returns void language sql security definer set search_path = public as $$
  update public.agent_jobs set key_id = p_key where id = p_job
$$;

-- ---------------------------------------------------------------- dashboard views
-- Per key: who uses it, what it is doing now, usage today (Pacific day).
create or replace view public.v_key_status with (security_invoker = true) as
select k.id                                   as key_id,
       k.label,
       '••••' || k.key_last4                  as key_masked,
       k.status,
       p.label                                as project_label,
       coalesce((select string_agg(t.name, ', ' order by t.sort)
                   from public.key_assignments ka join public.teams t on t.code = ka.team_code
                  where ka.key_id = k.id), 'Standby (unassigned)') as teams,
       coalesce((select string_agg(r.name, ', ' order by r.name)
                   from public.key_assignments ka join public.agent_roles r on r.team_code = ka.team_code
                  where ka.key_id = k.id), '')  as roles,
       (select r.name || ' — ' || j.workflow || ' / ' || j.step
          from public.agent_jobs j join public.agent_roles r on r.code = j.role_code
         where j.key_id = k.id and j.status = 'running'
         order by j.locked_at desc limit 1)   as current_activity,
       count(ar.*) filter (where ar.status <> 'rate_limited')       as requests_today,
       coalesce(sum(ar.input_tokens + ar.output_tokens), 0)         as tokens_today,
       count(ar.*) filter (where ar.status = 'rate_limited')        as rate_limited_today,
       count(ar.*) filter (where ar.status in ('error','schema_invalid')) as errors_today,
       coalesce(sum(ar.cost_estimate), 0)                           as cost_today_usd,
       (select max(created_at) from public.agent_runs where key_id = k.id) as last_used_at
  from public.ai_keys k
  join public.ai_projects p on p.id = k.project_id
  left join public.agent_runs ar on ar.key_id = k.id and ar.created_at >= app.pacific_day_start()
 group by k.id, p.label;

-- Per project and model: the quota that actually limits you (shared by all keys).
create or replace view public.v_project_quota with (security_invoker = true) as
with usage as (
  select project_id, model_id,
         count(*) filter (where status <> 'rate_limited' and created_at >= app.pacific_day_start()) as req_today,
         count(*) filter (where status <> 'rate_limited' and created_at >= now() - interval '1 minute') as req_last_min,
         coalesce(sum(input_tokens) filter (where created_at >= now() - interval '1 minute'), 0) as tok_last_min,
         count(*) filter (where status = 'rate_limited' and created_at >= now() - interval '15 minutes') as limited_15m
    from public.agent_runs group by project_id, model_id)
select p.id as project_id, p.label as project_label, p.usage_tier,
       l.model_id, l.rpm, l.tpm, l.rpd,
       coalesce(u.req_last_min, 0) as requests_last_minute,
       coalesce(u.tok_last_min, 0) as input_tokens_last_minute,
       coalesce(u.req_today, 0)    as requests_today,
       case when l.rpd > 0 then round(100.0 * coalesce(u.req_today,0) / l.rpd, 1) end as rpd_used_pct,
       case when l.rpm > 0 then round(100.0 * coalesce(u.req_last_min,0) / l.rpm, 1) end as rpm_used_pct,
       case when l.tpm > 0 then round(100.0 * coalesce(u.tok_last_min,0) / l.tpm, 1) end as tpm_used_pct,
       case when coalesce(u.limited_15m,0) > 0 or (l.rpd > 0 and coalesce(u.req_today,0) >= l.rpd) then 'exhausted'
            when l.rpd > 0 and coalesce(u.req_today,0) >= 0.8 * l.rpd then 'near_limit'
            else 'ok' end as quota_state,
       (app.pacific_day_start() + interval '1 day') as daily_reset_at
  from public.ai_projects p
  join public.project_model_limits l on l.project_id = p.id
  left join usage u on u.project_id = p.id and u.model_id = l.model_id
 where p.is_active;

-- Per team: usage today and which key it is on.
create or replace view public.v_team_usage with (security_invoker = true) as
select t.code as team_code, t.name as team, t.description,
       k.label as key_label, '••••' || k.key_last4 as key_masked, k.status as key_status,
       count(ar.*) filter (where ar.status <> 'rate_limited') as requests_today,
       coalesce(sum(ar.input_tokens + ar.output_tokens), 0)  as tokens_today,
       count(ar.*) filter (where ar.status = 'rate_limited') as rate_limited_today,
       (select count(*) from public.agent_jobs j join public.agent_roles r on r.code = j.role_code
         where r.team_code = t.code and j.status in ('queued','waiting_quota')) as jobs_waiting
  from public.teams t
  left join public.key_assignments ka on ka.team_code = t.code
  left join public.ai_keys k on k.id = ka.key_id
  left join public.agent_runs ar on ar.team_code = t.code and ar.created_at >= app.pacific_day_start()
 group by t.code, t.name, t.description, t.sort, k.label, k.key_last4, k.status
 order by t.sort;

-- ---------------------------------------------------------------- RLS
alter table public.teams                enable row level security;
alter table public.agent_roles          enable row level security;
alter table public.model_registry       enable row level security;
alter table public.ai_projects          enable row level security;
alter table public.project_model_limits enable row level security;
alter table public.ai_keys              enable row level security;
alter table public.key_assignments      enable row level security;
alter table public.agent_jobs           enable row level security;
alter table public.agent_runs           enable row level security;

create policy teams_read   on public.teams                for select to authenticated using (app.is_author());
create policy roles_read   on public.agent_roles          for select to authenticated using (app.is_author());
create policy models_read  on public.model_registry       for select to authenticated using (app.is_author());
create policy proj_read    on public.ai_projects          for select to authenticated using (app.is_author());
create policy limits_rw    on public.project_model_limits for all    to authenticated using (app.is_author()) with check (app.is_author());
create policy keys_read    on public.ai_keys              for select to authenticated using (app.is_author());
create policy assign_read  on public.key_assignments      for select to authenticated using (app.is_author());
create policy jobs_read    on public.agent_jobs           for select to authenticated using (app.is_author());
create policy runs_read    on public.agent_runs           for select to authenticated using (app.is_author());

grant select on public.v_key_status, public.v_project_quota, public.v_team_usage to authenticated;

revoke all on function app.admin_add_ai_key(text,text,text,text) from public, anon, authenticated;
revoke all on function app.admin_set_project(text,text,text)     from public;
revoke all on function app.get_key_secret(uuid)                   from public;
revoke all on function app.claim_next_job(text)                   from public;
revoke all on function app.complete_job(uuid,jsonb)               from public;
revoke all on function app.fail_job(uuid,text,int,boolean)        from public;
revoke all on function app.set_job_key(uuid,uuid)                 from public;
revoke all on function app.resolve_key_for_team(text)             from public;
revoke all on function app.cost_today_usd()                       from public;
revoke all on function app.quota_gate(text,int)                   from public;
grant execute on function app.quota_gate(text,int) to service_role;
grant execute on function app.cost_today_usd() to service_role, authenticated;
grant execute on function app.admin_add_ai_key(text,text,text,text), app.admin_set_project(text,text,text),
  app.get_key_secret(uuid), app.claim_next_job(text), app.complete_job(uuid,jsonb),
  app.fail_job(uuid,text,int,boolean), app.set_job_key(uuid,uuid), app.resolve_key_for_team(text)
  to service_role;
grant execute on function app.assign_team_key(text,uuid), app.set_key_status(uuid,text) to authenticated;
