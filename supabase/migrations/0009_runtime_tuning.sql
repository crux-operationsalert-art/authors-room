-- Applied live on 18 Nov 2026 after end-to-end testing against Gemini.
-- 1) recover jobs whose Edge Function was killed mid-call
create or replace function app.claim_next_job(p_worker text)
returns setof public.agent_jobs language plpgsql security definer set search_path = public as $$
begin
  update public.agent_jobs set status = 'queued', locked_by = null, updated_at = now(),
         last_error = coalesce(last_error, '') || ' [recovered after worker timeout]'
   where status = 'running' and locked_at < now() - interval '4 minutes';
  return query
  update public.agent_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_at = now(), updated_at = now()
   where j.id = (select id from public.agent_jobs
                  where status in ('queued','waiting_quota') and run_after <= now()
                  order by priority desc, created_at for update skip locked limit 1)
  returning j.*;
end $$;

-- 2) availability fallbacks per tier (5xx / timeout / 404 only, never 429)
alter table public.model_registry add column if not exists fallbacks jsonb not null default '[]'::jsonb;

-- 3) model registry as tested on the free tier (prices USD per 1M tokens; Pro has no free quota)
insert into public.model_registry(tier, model_id, input_price_per_mtok, output_price_per_mtok, context_limit, fallbacks) values
 ('fast','gemini-3.1-flash-lite',0.25,1.50,1000000,'[{"model_id":"gemini-3.5-flash-lite","in":0.30,"out":2.50}]'),
 ('standard','gemini-2.5-flash',0.30,2.50,1000000,'[{"model_id":"gemini-3.5-flash-lite","in":0.30,"out":2.50},{"model_id":"gemini-3-flash-preview","in":0.50,"out":3.00}]'),
 ('deep','gemini-2.5-flash',0.30,2.50,1000000,'[{"model_id":"gemini-3.5-flash-lite","in":0.30,"out":2.50},{"model_id":"gemini-3-flash-preview","in":0.50,"out":3.00}]'),
 ('embedding','gemini-embedding-001',0.15,0,2048,'[]')
on conflict do nothing;

-- 4) key notes on the dashboard view
create or replace view public.v_key_status with (security_invoker = true) as
select k.id as key_id, k.label, '••••' || k.key_last4 as key_masked, k.status, p.label as project_label,
       coalesce((select string_agg(t.name, ', ' order by t.sort) from public.key_assignments ka join public.teams t on t.code = ka.team_code
                  where ka.key_id = k.id), 'Standby (unassigned)') as teams,
       coalesce((select string_agg(r.name, ', ' order by r.name) from public.key_assignments ka join public.agent_roles r on r.team_code = ka.team_code
                  where ka.key_id = k.id), '') as roles,
       (select r.name || ' — ' || j.workflow || ' / ' || j.step from public.agent_jobs j join public.agent_roles r on r.code = j.role_code
         where j.key_id = k.id and j.status = 'running' order by j.locked_at desc limit 1) as current_activity,
       count(ar.*) filter (where ar.status <> 'rate_limited') as requests_today,
       coalesce(sum(ar.input_tokens + ar.output_tokens), 0) as tokens_today,
       count(ar.*) filter (where ar.status = 'rate_limited') as rate_limited_today,
       count(ar.*) filter (where ar.status in ('error','schema_invalid')) as errors_today,
       coalesce(sum(ar.cost_estimate), 0) as cost_today_usd,
       (select max(created_at) from public.agent_runs where key_id = k.id) as last_used_at,
       k.notes
  from public.ai_keys k join public.ai_projects p on p.id = k.project_id
  left join public.agent_runs ar on ar.key_id = k.id and ar.created_at >= app.pacific_day_start()
 group by k.id, p.label;

-- 5) worker schedule: three parallel workers every minute (set worker_url for your project first)
-- insert into app.settings(key, value) values ('worker_url', 'https://<project-ref>.supabase.co/functions/v1/worker');
-- select cron.schedule('authors-room-worker', '* * * * *', $cron$
--   select net.http_post(url := (select value from app.settings where key='worker_url'), body := '{"action":"tick"}'::jsonb,
--     headers := jsonb_build_object('Content-Type','application/json','x-worker-token',
--                (select decrypted_secret from vault.decrypted_secrets where name='worker_token')),
--     timeout_milliseconds := 150000) from generate_series(1, 3) $cron$);
