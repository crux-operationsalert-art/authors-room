-- 0040: server-side admin calls to the worker (token from Vault) and daily model/price discovery + key verification.
create or replace function app.call_worker(p_action text)
returns bigint language plpgsql security definer set search_path = public, vault as $$
begin
  if p_action not in ('discover_models', 'check_keys') then raise exception 'unsupported action'; end if;
  return net.http_post(url := (select value from app.settings where key = 'worker_url'),
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-token',
               (select decrypted_secret from vault.decrypted_secrets where name = 'worker_token')),
    timeout_milliseconds := 150000);
end $$;
revoke all on function app.call_worker(text) from public, anon, authenticated;
grant execute on function app.call_worker(text) to service_role;
select cron.unschedule(jobid) from cron.job where jobname in ('daily_model_discovery', 'daily_key_check');
select cron.schedule('daily_model_discovery', '17 9 * * *', $$select app.call_worker('discover_models')$$);
select cron.schedule('daily_key_check', '23 9 * * *', $$select app.call_worker('check_keys')$$);
