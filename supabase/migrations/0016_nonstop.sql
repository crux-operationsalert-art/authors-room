-- 0016: Non-stop running and better use of the main project's quota.
-- * model_rest: a model that hit its daily limit (or was retired) is skipped until its reset, instead of being asked
--   (and refusing) on every step.
-- * kick_worker: when a step finishes and more work is ready, the next step starts at once instead of waiting for the
--   once-a-minute schedule (at most 3 steps run side by side).
-- * autopilot runs straight after every review decision (with a lock so two runs never overlap).
-- * Fixes: the worker can read app.settings (the combined review panel was not being used); retired model removed.

grant select on app.settings to service_role;

create table if not exists public.model_rest (
  model_id text primary key,
  until timestamptz not null,
  reason text,
  updated_at timestamptz not null default now()
);
alter table public.model_rest enable row level security;
drop policy if exists model_rest_read on public.model_rest;
create policy model_rest_read on public.model_rest for select using (app.is_author());
grant select, insert, update, delete on public.model_rest to service_role;

-- gemini-2.5-flash-lite is retired for this project (404 "no longer available to new users")
update public.model_registry
   set fallbacks = (select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(fallbacks) f
                     where f->>'model_id' <> 'gemini-2.5-flash-lite')
 where fallbacks @> '[{"model_id":"gemini-2.5-flash-lite"}]';

-- one autopilot run at a time
create or replace function app.autopilot_tick_safe() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not pg_try_advisory_xact_lock(724911) then return '[]'::jsonb; end if;
  return app.autopilot_tick();
end $$;

-- start another worker run now if work is ready and fewer than 3 are running
create or replace function app.kick_worker() returns boolean
language plpgsql security definer set search_path = public, vault as $$
declare v_running int; v_ready int;
begin
  select count(*) into v_running from public.agent_jobs where status = 'running';
  select count(*) into v_ready from public.agent_jobs where status in ('queued', 'waiting_quota') and run_after <= now();
  if v_ready = 0 or v_running >= 3 then return false; end if;
  perform net.http_post(url := (select value from app.settings where key = 'worker_url'),
    body := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-token',
               (select decrypted_secret from vault.decrypted_secrets where name = 'worker_token')),
    timeout_milliseconds := 150000);
  return true;
end $$;

revoke all on function app.autopilot_tick_safe() from public, anon, authenticated;
revoke all on function app.kick_worker() from public, anon, authenticated;
grant execute on function app.autopilot_tick_safe() to service_role;
grant execute on function app.kick_worker() to service_role;

select cron.schedule('authors-room-autopilot', '* * * * *', $$ select app.autopilot_tick_safe() $$);

-- models already used up today: rest them until the daily reset
insert into public.model_rest(model_id, until, reason)
select distinct model_id, app.pacific_day_start() + interval '1 day', 'daily free limit used up'
  from public.agent_runs
 where created_at >= app.pacific_day_start() and status = 'rate_limited' and error ilike '%per day%'
on conflict (model_id) do update set until = excluded.until, reason = excluded.reason, updated_at = now();
