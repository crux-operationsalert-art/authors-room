-- 0044 (Part K audit): the Resources page's quota pools now (a) count "today" from Google's real reset
-- (app.pacific_day_start, DST-aware; the old fixed 08:00 UTC was an hour off in US summer time) and
-- (b) show per-project rests (0043) and whole-provider rests (e.g. OpenRouter's account-wide daily allowance).
create or replace function app.quota_pools()
returns jsonb language sql stable security definer set search_path = public as $$
  with use as (
    select r.project_id, r.model_id,
           count(*) filter (where r.created_at > now() - interval '1 minute') req_1m,
           sum(coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0)) filter (where r.created_at > now() - interval '1 minute') tok_1m,
           count(*) filter (where r.created_at >= app.pacific_day_start()) req_today,
           count(*) filter (where r.created_at >= app.pacific_day_start() and r.status = 'ok') ok_today,
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
    'resting_until', (select max(x.until) from (
        select m.until from public.model_rest m
         where m.until > now() and (m.model_id = case when u.model_id ~ '^(groq|mistral|openrouter)/'
                 then regexp_replace(u.model_id, '/', ':') else u.model_id end
                 or m.model_id = split_part(u.model_id, '/', 1) || ':*')
        union all
        select pr.until from public.project_model_rest pr where pr.project_id = p.id and pr.model_id = u.model_id and pr.until > now()) x))
    order by p.label, u.req_today desc), '[]')
  from use u join public.ai_projects p on p.id = u.project_id
$$;
