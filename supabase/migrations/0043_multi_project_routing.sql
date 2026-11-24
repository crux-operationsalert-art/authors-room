-- 0043: Part H §24 routing across every routing-eligible Gemini project, weighted by capacity, health and latency.
-- * Daily-limit and "not available" rests are now per project (a used-up model in project A is still usable in B).
--   public.model_rest stays for project-independent rests (circuit breaker).
-- * app.quota_gate takes the project; counts only that project's calls.
-- * app.gemini_candidates ranks (model, project, key) options: keep the tier's quality order, push models that are
--   failing (<50% success over >=5 calls in the last 30 min) to the end, then within a model prefer: capacity now, free before
--   paid, lower latency. Never more than one key per project (keys in a project share one quota).
create table if not exists public.project_model_rest (
  project_id uuid not null references public.ai_projects(id) on delete cascade,
  model_id text not null, until timestamptz not null, reason text, updated_at timestamptz not null default now(),
  primary key (project_id, model_id)
);
alter table public.project_model_rest enable row level security;
drop policy if exists project_model_rest_read on public.project_model_rest;
create policy project_model_rest_read on public.project_model_rest for select using (app.is_author());

-- carry existing per-model daily rests over to the primary project
insert into public.project_model_rest(project_id, model_id, until, reason)
select (select id from public.ai_projects where is_active), r.model_id, r.until, r.reason
  from public.model_rest r where r.until > now() and r.reason in ('daily free limit used up', 'not available to this project')
    and r.model_id not like '%:%'
on conflict do nothing;
delete from public.model_rest where reason in ('daily free limit used up', 'not available to this project') and model_id not like '%:%';

drop function if exists app.quota_gate(text, integer);
create or replace function app.quota_gate(p_model text, p_est_tokens integer default 0, p_project uuid default null)
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_rpd bigint; v_rpm bigint; v_tpm bigint; v_day int; v_min int; v_tok int; v_limited int; v_proj uuid;
begin
  v_proj := coalesce(p_project, (select id from public.ai_projects where is_active limit 1));
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
    from public.agent_runs where model_id = p_model and (project_id = v_proj or project_id is null)
     and created_at >= least(app.pacific_day_start(), now() - interval '1 minute');
  if v_rpd is not null and v_rpd > 0 and v_day >= v_rpd then
    return greatest(1, extract(epoch from (app.pacific_day_start() + interval '1 day' - now()))::int);
  end if;
  if v_rpd = 0 then return 86400; end if;
  if v_limited > 0 then return 60; end if;
  if v_rpm is not null and v_min >= v_rpm then return 60; end if;
  if v_tpm is not null and v_tok > 0 and v_tok + p_est_tokens > v_tpm then return 60; end if;
  return 0;
end $$;

create or replace function app.gemini_candidates(p_team text, p_models text[], p_est integer default 0)
returns table(ord int, model_id text, project_id uuid, key_id uuid, key_label text, usage_tier text, paid boolean,
              wait int, success_pct numeric, avg_latency_ms int, calls_2h int)
language sql stable security definer set search_path = public as $$
  with m as (select distinct on (u.model_id) u.model_id, u.ord from unnest(p_models) with ordinality u(model_id, ord) order by u.model_id, u.ord),
  p as (select pr.id, pr.usage_tier, (coalesce(pr.billing_enabled, false) or coalesce(pr.usage_tier, 'free') <> 'free') paid,
               (select k.id from public.ai_keys k left join public.key_assignments ka on ka.key_id = k.id and ka.team_code = p_team
                 where k.project_id = pr.id and k.provider = 'gemini' and k.status = 'active'
                 order by (ka.key_id is not null) desc, k.created_at limit 1) key_id
          from public.ai_projects pr where pr.routing_eligible),
  h as (select r.model_id, r.project_id, count(*) n,
               count(*) filter (where r.status = 'ok')::numeric / nullif(count(*), 0) succ,
               avg(r.latency_ms) filter (where r.status = 'ok') lat
          from public.agent_runs r where r.created_at > now() - interval '30 minutes' and r.status <> 'rate_limited'
         group by 1, 2),
  c as (select m.ord, m.model_id, p.id project_id, p.key_id, p.usage_tier, p.paid,
               greatest(app.quota_gate(m.model_id, p_est, p.id),
                        coalesce((select ceil(extract(epoch from (pmr.until - now())))::int from public.project_model_rest pmr
                                   where pmr.project_id = p.id and pmr.model_id = m.model_id and pmr.until > now()), 0),
                        coalesce((select ceil(extract(epoch from (mr.until - now())))::int from public.model_rest mr
                                   where mr.model_id = m.model_id and mr.until > now()), 0)) wait,
               h.succ, h.lat, coalesce(h.n, 0) n
          from m cross join p left join h on h.model_id = m.model_id and h.project_id = p.id
         where p.key_id is not null)
  select (row_number() over (order by case when c.n >= 5 and c.succ < 0.5 then 1 else 0 end, c.ord,
                                       case when c.wait = 0 then 0 else 1 end, c.paid, c.lat nulls last))::int,
         c.model_id, c.project_id, c.key_id, k.label, c.usage_tier, c.paid, c.wait,
         round(c.succ * 100, 1), c.lat::int, c.n::int
    from c join public.ai_keys k on k.id = c.key_id
   order by 1
$$;
revoke all on function app.gemini_candidates(text, text[], integer) from public, anon, authenticated;
grant execute on function app.gemini_candidates(text, text[], integer) to service_role;
revoke all on function app.quota_gate(text, integer, uuid) from public, anon;
grant execute on function app.quota_gate(text, integer, uuid) to authenticated, service_role;
