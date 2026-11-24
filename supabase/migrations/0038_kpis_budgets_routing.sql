-- 0038: Part I (full cost capture, pricing catalogue fields, the author's five KPIs, budgets, projections) and
-- Part H §24 (routing uses learnt limits; deep tier tries the strongest models first).

-- Full usage capture
alter table public.agent_runs add column if not exists reasoning_tokens int;
alter table public.agent_runs add column if not exists cached_tokens int;

-- Pricing catalogue fields required by Part I §29
alter table public.model_pricing add column if not exists cached_input_per_mtok numeric;
alter table public.model_pricing add column if not exists batch_discount_pct numeric;
alter table public.model_pricing add column if not exists reasoning_treatment text;
alter table public.model_pricing add column if not exists currency text not null default 'USD';
alter table public.model_pricing add column if not exists source_url text;
update public.model_pricing set reasoning_treatment = 'thinking tokens billed as output', batch_discount_pct = 50,
       source_url = 'https://ai.google.dev/gemini-api/docs/pricing' where model_label like 'gemini%' and source_url is null;
update public.model_pricing set cached_input_per_mtok = round(input_per_mtok / 10, 4) where model_label like 'gemini%' and cached_input_per_mtok is null and input_per_mtok is not null;
update public.model_pricing set reasoning_treatment = 'reasoning tokens billed as output', batch_discount_pct = 50,
       cached_input_per_mtok = round(input_per_mtok / 2, 4), source_url = 'https://groq.com/pricing' where model_label like 'groq/%';
update public.model_pricing set source_url = 'https://openrouter.ai/api/v1/models', reasoning_treatment = 'n/a (free router)' where model_label like 'openrouter/%';

-- Routing: the rate gate uses limits learnt from 429 replies (quota_limits) when no manual limit exists.
create or replace function app.quota_gate(p_model text, p_est_tokens integer default 0)
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_rpd bigint; v_rpm bigint; v_tpm bigint; v_day int; v_min int; v_tok int; v_limited int; v_proj uuid;
begin
  select id into v_proj from public.ai_projects where is_active;
  select coalesce(pml.rpd, (select limit_value from public.quota_limits where project_id = v_proj and model_id = p_model and dimension = 'rpd')),
         coalesce(pml.rpm, (select limit_value from public.quota_limits where project_id = v_proj and model_id = p_model and dimension = 'rpm')),
         coalesce(pml.tpm, (select limit_value from public.quota_limits where project_id = v_proj and model_id = p_model and dimension = 'tpm'))
    into v_rpd, v_rpm, v_tpm
    from (select 1) one left join public.project_model_limits pml on pml.project_id = v_proj and pml.model_id = p_model;
  select count(*) filter (where status <> 'rate_limited' and created_at >= app.pacific_day_start()),
         count(*) filter (where status <> 'rate_limited' and created_at >= now() - interval '1 minute'),
         coalesce(sum(input_tokens) filter (where created_at >= now() - interval '1 minute'), 0),
         count(*) filter (where status = 'rate_limited' and created_at >= now() - interval '1 minute')
    into v_day, v_min, v_tok, v_limited
    from public.agent_runs where model_id = p_model and created_at >= least(app.pacific_day_start(), now() - interval '1 minute');
  if v_rpd is not null and v_rpd > 0 and v_day >= v_rpd then
    return greatest(1, extract(epoch from (app.pacific_day_start() + interval '1 day' - now()))::int);
  end if;
  if v_rpd = 0 then return 86400; end if;   -- not available on this tier (e.g. Pro on free)
  if v_limited > 0 then return 60; end if;
  if v_rpm is not null and v_min >= v_rpm then return 60; end if;
  if v_tpm is not null and v_tok > 0 and v_tok + p_est_tokens > v_tpm then return 60; end if;
  return 0;
end $$;

-- Creative-direction (deep) work tries the strongest models first; proofreading stays on the fast tier.
update public.model_registry set model_id = 'gemini-3.8-flash', fallbacks = '[
  {"model_id":"gemini-3.7-flash","in":0.75,"out":3.75},{"model_id":"gemini-3.6-flash","in":0.75,"out":3.75},
  {"model_id":"gemini-3.5-flash","in":0.5,"out":3},{"model_id":"gemini-3-flash-preview","in":0.5,"out":3},
  {"model_id":"gemini-flash-latest","in":0.5,"out":3},{"model_id":"gemini-2.5-flash","in":0.3,"out":2.5},
  {"model_id":"gemini-3.5-flash-lite","in":0.3,"out":2.5},{"model_id":"gemini-3.1-flash-lite","in":0.25,"out":1.5},
  {"model_id":"gemini-flash-lite-latest","in":0.1,"out":0.4},{"model_id":"gemini-3.1-flash-lite-preview","in":0,"out":0}]'::jsonb,
  input_price_per_mtok = 0.75, output_price_per_mtok = 3.75, updated_at = now()
 where tier = 'deep' and enabled;

-- Budgets (Part I §31). Actual spend only (free tiers cost nothing). Soft alert at soft_pct, hard stop at 100% when hard.
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global_daily', 'global_monthly', 'book', 'project', 'provider')),
  scope_ref text,                 -- book id, project id or provider name; null for global
  limit_usd numeric not null check (limit_usd >= 0),
  soft_pct int not null default 80,
  hard boolean not null default true,
  created_at timestamptz not null default now(),
  unique (scope, scope_ref)
);
alter table public.budgets enable row level security;
drop policy if exists budgets_read on public.budgets;
create policy budgets_read on public.budgets for select using (app.is_author());
insert into public.budgets(scope, scope_ref, limit_usd) values ('global_daily', null, 0), ('global_monthly', null, 0)
on conflict do nothing;
insert into app.settings(key, value) values ('paid_use_enabled', 'false') on conflict (key) do nothing;

create or replace function app.actual_spend(p_scope text, p_ref text)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(r.cost_estimate), 0) from public.agent_runs r join public.ai_projects p on p.id = r.project_id
   where p.usage_tier <> 'free'
     and case p_scope
       when 'global_daily' then r.created_at >= app.pacific_day_start()
       when 'global_monthly' then r.created_at >= date_trunc('month', now())
       when 'book' then r.book_id::text = p_ref
       when 'project' then r.project_id::text = p_ref
       when 'provider' then split_part(r.model_id, '/', 1) = p_ref or (p_ref = 'gemini' and r.model_id like 'gemini%')
       else false end
$$;

create or replace function app.budget_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'paid_use_enabled', (select value = 'true' from app.settings where key = 'paid_use_enabled'),
    'budgets', coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'scope', b.scope, 'scope_ref', b.scope_ref, 'limit_usd', b.limit_usd,
       'spent_usd', round(app.actual_spend(b.scope, b.scope_ref), 4), 'soft_pct', b.soft_pct, 'hard', b.hard,
       'state', case when b.limit_usd = 0 and app.actual_spend(b.scope, b.scope_ref) = 0 then 'no paid use allowed'
                     when app.actual_spend(b.scope, b.scope_ref) >= b.limit_usd then case when b.hard then 'STOPPED' else 'over' end
                     when app.actual_spend(b.scope, b.scope_ref) >= b.limit_usd * b.soft_pct / 100.0 then 'alert' else 'ok' end)
       order by b.scope), '[]'))
  from public.budgets b where app.is_author() or auth.role() = 'service_role'
$$;

-- Worker check before any PAID call: returns null when allowed, else the reason.
create or replace function app.paid_call_blocked(p_book uuid, p_project uuid, p_provider text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when (select value from app.settings where key = 'paid_use_enabled') is distinct from 'true' then 'Paid use is switched off. Switch it on (and set budgets) on the Dashboard first.'
    else (select 'Budget reached: ' || b.scope || coalesce(' ' || b.scope_ref, '') || ' ($' || b.limit_usd || ')'
            from public.budgets b
           where b.hard and ((b.scope in ('global_daily', 'global_monthly'))
                   or (b.scope = 'book' and b.scope_ref = p_book::text) or (b.scope = 'project' and b.scope_ref = p_project::text)
                   or (b.scope = 'provider' and b.scope_ref = p_provider))
             and app.actual_spend(b.scope, b.scope_ref) >= b.limit_usd limit 1) end
$$;

create or replace function app.admin_set_budget(p_scope text, p_ref text, p_limit numeric, p_hard boolean default true, p_soft_pct int default 80)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.budgets(scope, scope_ref, limit_usd, hard, soft_pct) values (p_scope, p_ref, p_limit, p_hard, p_soft_pct)
  on conflict (scope, scope_ref) do update set limit_usd = excluded.limit_usd, hard = excluded.hard, soft_pct = excluded.soft_pct;
end $$;
create or replace function app.admin_set_paid_use(p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  update app.settings set value = case when p_enabled then 'true' else 'false' end where key = 'paid_use_enabled';
  insert into public.provisioning_log(operation, target, status, detail) values ('paid_use', 'all providers', 'ok', case when p_enabled then 'paid use switched ON by the author' else 'paid use switched off' end);
end $$;

-- The author's five KPIs (Part I §30). Measured values and projections are reported separately.
create or replace function app.kpis(p_book uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; v_words numeric; v_target numeric; v_paras int; v_versions int; v_first timestamptz; v_last timestamptz;
        v_ok int; v_calls int; v_hypo numeric; v_hypo_gem numeric; v_actual numeric; v_compute_s numeric;
        v_para_24h int; v_turn numeric; v_first_pass numeric; v_score numeric; v_recov numeric; v_interrupt numeric;
begin
  if p_book is not null and auth.uid() is not null and not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0), count(*)
    into v_words, v_paras from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.status in ('ai_approved', 'author_approved') and (p_book is null or m.book_id = p_book);
  select coalesce(sum(target_words), 0) into v_target from public.outline_units where level = 'chapter' and (p_book is null or book_id = p_book)
     and (p_book is not null or book_id in (select id from public.books where status in ('planning', 'writing')));
  select count(*) into v_versions from public.block_versions v join public.manuscript_blocks m on m.id = v.block_id
   where m.status in ('ai_approved', 'author_approved') and (p_book is null or m.book_id = p_book);
  select min(r.created_at), max(r.created_at), count(*) filter (where status = 'ok'), count(*),
         sum((coalesce(input_tokens, 0) * pr.pin + coalesce(output_tokens, 0) * pr.pout) / 1e6),
         sum((coalesce(input_tokens, 0) * pr.pin + coalesce(output_tokens, 0) * pr.pout) / 1e6) filter (where r.model_id like 'gemini%'),
         sum(r.cost_estimate) filter (where coalesce(p.usage_tier, 'free') <> 'free'),
         sum(latency_ms) filter (where status = 'ok') / 1000.0
    into v_first, v_last, v_ok, v_calls, v_hypo, v_hypo_gem, v_actual, v_compute_s
    from public.agent_runs r left join lateral app.price_of(r.model_id, r.created_at) pr on true
    left join public.ai_projects p on p.id = r.project_id
   where p_book is null or r.book_id = p_book;
  -- paragraphs first approved in the last 24h, and turnaround from first draft job to first approval
  with firsts as (select a.subject_id, min(a.created_at) at from public.approvals a
                   where a.subject_type = 'block' and a.decision = 'approved' and (p_book is null or a.book_id = p_book) group by 1),
       starts as (select (j.payload->>'block_id')::uuid bid, min(j.created_at) at from public.agent_jobs j
                   where j.step = 'draft' and (p_book is null or j.book_id = p_book) group by 1)
  select count(*) filter (where f.at > now() - interval '24 hours'),
         round(avg(extract(epoch from f.at - s.at) / 60) filter (where s.at is not null and f.at > s.at), 1)
    into v_para_24h, v_turn from firsts f left join starts s on s.bid = f.subject_id;
  -- first-pass acceptance: the first Chief Editor decision on a paragraph was "pass"
  select round(100.0 * count(*) filter (where d = 'pass') / nullif(count(*), 0)) into v_first_pass from (
    select distinct on (j.payload->>'block_id') j.result->>'decision' d from public.agent_jobs j
     where j.step = 'consolidate' and j.status = 'done' and (p_book is null or j.book_id = p_book) order by j.payload->>'block_id', j.created_at) x;
  select round(avg((j.result->>'score')::numeric)) into v_score from public.manuscript_blocks m
    join public.agent_jobs j on j.step = 'consolidate' and j.status = 'done' and j.payload->>'block_version_id' = m.current_version_id::text
   where m.status in ('ai_approved', 'author_approved') and (p_book is null or m.book_id = p_book);
  -- recovery: jobs that failed at least once and still completed
  select round(100.0 * count(*) filter (where status = 'done') / nullif(count(*), 0)) into v_recov
    from public.agent_jobs where attempts > 1 and (p_book is null or book_id = p_book);
  -- interruption: 10-minute slots in the last 7 days with work queued but no successful AI call
  select count(*) / 6.0 into v_interrupt from generate_series(date_trunc('hour', now() - interval '7 days'), now(), interval '10 minutes') s(t)
   where exists (select 1 from public.agent_jobs j where (p_book is null or j.book_id = p_book) and j.created_at <= s.t and j.updated_at >= s.t
                   and j.status in ('done', 'waiting_quota', 'queued', 'failed'))
     and not exists (select 1 from public.agent_runs r where r.status = 'ok' and (p_book is null or r.book_id = p_book)
                       and r.created_at >= s.t and r.created_at < s.t + interval '10 minutes');
  r := jsonb_build_object(
    'measured_note', 'Measured from recorded calls and approvals. Projections are labelled and assume the recent pace continues.',
    'kpi1_cost_per_book', jsonb_build_object(
      'actual_spend_so_far_usd', round(coalesce(v_actual, 0), 2),
      'paid_equivalent_so_far_usd', round(coalesce(v_hypo, 0), 2),
      'hybrid_paid_gemini_free_backups_so_far_usd', round(coalesce(v_hypo_gem, 0), 2),
      'projected_paid_equivalent_at_completion_usd', case when v_words > 0 and v_target > 0 then round(coalesce(v_hypo, 0) * v_target / v_words, 0) end,
      'projected_remaining_paid_equivalent_usd', case when v_words > 0 and v_target > v_words then round(coalesce(v_hypo, 0) * (v_target - v_words) / v_words, 0) end),
    'kpi2_completion_time', jsonb_build_object(
      'elapsed_days_so_far', round(extract(epoch from coalesce(v_last, now()) - coalesce(v_first, now())) / 86400, 1),
      'ai_compute_hours_so_far', round(coalesce(v_compute_s, 0) / 3600, 1),
      'projected_days_to_finish_at_current_pace', case when v_words > 0 and v_target > v_words and v_last > v_first
          then round((v_target - v_words) / (v_words / greatest(extract(epoch from v_last - v_first) / 86400, 0.1)), 0) end,
      'estimated_paid_completion_hours_no_quota_waits', case when v_words > 0 and v_target > 0 then round(coalesce(v_compute_s, 0) / 3600 * v_target / v_words, 0) end),
    'kpi3_processing_speed', jsonb_build_object('paragraphs_last_24h', v_para_24h, 'paragraphs_per_hour_last_24h', round(v_para_24h / 24.0, 2),
      'avg_paragraph_turnaround_minutes', v_turn),
    'kpi4_reliability', jsonb_build_object('success_pct', round(100.0 * v_ok / nullif(v_calls, 0)), 'failure_pct', round(100.0 * (v_calls - v_ok) / nullif(v_calls, 0)),
      'interruption_hours_last_7d', round(v_interrupt, 1), 'recovery_success_pct', v_recov),
    'kpi5_quality_rework', jsonb_build_object('first_pass_acceptance_pct', v_first_pass, 'avg_editorial_score', v_score,
      'versions_per_approved_paragraph', round(v_versions::numeric / nullif(v_paras, 0), 1)),
    'context', jsonb_build_object('approved_words', v_words, 'target_words', v_target, 'approved_paragraphs', v_paras, 'calls', v_calls));
  return r;
end $$;

revoke all on function app.kpis(uuid), app.budget_status(), app.admin_set_budget(text, text, numeric, boolean, int), app.admin_set_paid_use(boolean) from public, anon;
grant execute on function app.kpis(uuid), app.budget_status(), app.admin_set_budget(text, text, numeric, boolean, int), app.admin_set_paid_use(boolean) to authenticated, service_role;
revoke all on function app.paid_call_blocked(uuid, uuid, text), app.actual_spend(text, text) from public, anon, authenticated;
grant execute on function app.paid_call_blocked(uuid, uuid, text), app.actual_spend(text, text) to service_role;
