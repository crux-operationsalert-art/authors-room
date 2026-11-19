-- Records the two background schedules that are live on the project (applied by hand after 0011).
-- Re-running is safe: cron.schedule replaces a job with the same name.
select cron.schedule('authors-room-worker', '* * * * *', $$
  select net.http_post(url := (select value from app.settings where key='worker_url'), body := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-token',
               (select decrypted_secret from vault.decrypted_secrets where name='worker_token')),
    timeout_milliseconds := 150000)
  from generate_series(1, 3)
$$);
select cron.schedule('authors-room-watchdog', '*/5 * * * *', $$ select app.watchdog() $$);
