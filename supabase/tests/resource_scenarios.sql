-- Part N §40 resource-management scenarios. Runs inside one DO block and ALWAYS rolls back (final RAISE),
-- so nothing it creates survives. The result table is returned in the exception message.
do $$
declare
  r text[] := '{}';
  v_primary uuid; v_free uuid; v_paid uuid; v_k1 uuid; v_k2 uuid; v_kx uuid; v_book uuid; v_job uuid; v_author uuid;
  v int; t text; j record; m text := 'test-sec40-a'; m2 text := 'test-sec40-b'; m3 text := 'test-sec40-c'; m4 text := 'test-sec40-d'; m5 text := 'test-sec40-e';
begin
  select id into v_primary from ai_projects where is_active;
  -- fixtures
  insert into ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, status)
  values (v_primary, 'T1A', 'aaaa', 'fp-test-1', gen_random_uuid(), 'gemini', 'active') returning id into v_k1;
  insert into ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, status)
  values (v_primary, 'T1B', 'bbbb', 'fp-test-2', gen_random_uuid(), 'gemini', 'active') returning id into v_k2;
  insert into ai_projects(label, google_project_ref, is_active, billing_enabled, routing_eligible)
  values ('test free extra', 'test-free-extra', false, false, false) returning id into v_free;
  insert into ai_projects(label, google_project_ref, is_active, billing_enabled, routing_eligible)
  values ('test paid', 'test-paid', false, true, false) returning id into v_paid;
  insert into ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, status)
  values (v_free, 'TX', 'xxxx', 'fp-test-x', gen_random_uuid(), 'gemini', 'active') returning id into v_kx;

  -- S1 same-project keys share one quota: limit rpm=2, two calls on two different keys -> gate says wait
  insert into quota_limits(project_id, model_id, dimension, limit_value, source) values (v_primary, m, 'rpm', 2, 'test');
  insert into agent_runs(role_code, team_code, key_id, project_id, model_id, status) values
    ('chief_editor','orchestration',v_k1,v_primary,m,'ok'), ('chief_editor','orchestration',v_k2,v_primary,m,'ok');
  v := app.quota_gate(m, 0);
  r := r || ('S01 same-project keys share quota: ' || case when v = 60 then 'PASS' else 'FAIL gate=' || v end);

  -- S2 different projects: a key in a non-eligible project is never routed; extra free projects cannot be enabled
  update key_assignments set key_id = v_kx where team_code = 'orchestration';
  select label into t from app.resolve_key_for_team('orchestration');
  r := r || ('S02b key in non-eligible project never routed, team still gets an eligible key: '
        || case when t is not null and t <> 'TX' then 'PASS (got ' || t || ')' else 'FAIL (got ' || coalesce(t, 'no key: team would stall') || ')' end);
  -- paid project requires explicit authorisation
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform app.admin_set_project_eligibility(v_paid, true, false);
    r := r || 'S02c paid project without authorisation: FAIL (accepted)'::text;
  exception when others then r := r || ('S02c paid project needs explicit authorisation: ' || case when sqlerrm ilike '%charges%' then 'PASS' else 'FAIL ' || sqlerrm end); end;
  begin
    perform app.admin_set_project_eligibility(v_free, true, false);
    r := r || 'S02d free extra project as service role: FAIL (accepted)'::text;
  exception when others then r := r || ('S02d free extra project refused even for service role: ' || case when sqlerrm ilike '%circumvent%' then 'PASS' else 'FAIL ' || sqlerrm end); end;

  -- S3 exhaustion / S7 daily exhaustion: rpd=3 and 3 calls today -> wait until the Pacific-midnight reset
  insert into quota_limits(project_id, model_id, dimension, limit_value, source) values (v_primary, m2, 'rpd', 3, 'test');
  insert into agent_runs(role_code, team_code, project_id, model_id, status) values ('chief_editor','orchestration',v_primary,m2,'ok'),('chief_editor','orchestration',v_primary,m2,'ok'),('chief_editor','orchestration',v_primary,m2,'ok');
  v := app.quota_gate(m2, 0);
  r := r || ('S03/S07 daily exhaustion waits for reset: ' || case when v > 600 then 'PASS (' || round(v/3600.0,1) || ' h)' else 'FAIL gate=' || v end);
  -- S8 recovery: the same number of calls, dated before today's reset, no longer count
  insert into quota_limits(project_id, model_id, dimension, limit_value, source) values (v_primary, m3, 'rpd', 3, 'test');
  insert into agent_runs(role_code, team_code, project_id, model_id, status, created_at) select 'chief_editor','orchestration',v_primary,m3,'ok', app.pacific_day_start() - interval '1 hour' from generate_series(1,3);
  v := app.quota_gate(m3, 0);
  r := r || ('S08 recovery after reset: ' || case when v = 0 then 'PASS' else 'FAIL gate=' || v end);
  insert into quota_limits(project_id, model_id, dimension, limit_value, source) values (v_primary, m4, 'rpd', 0, 'test');
  v := app.quota_gate(m4, 0);
  r := r || ('S07b model with 0 free requests/day skipped: ' || case when v = 86400 then 'PASS' else 'FAIL gate=' || v end);

  -- S6 temporary 429: one rate-limited reply in the last minute -> short wait, not a day
  insert into agent_runs(role_code, team_code, project_id, model_id, status, http_status) values ('chief_editor','orchestration',v_primary,m5,'rate_limited',429);
  v := app.quota_gate(m5, 0);
  r := r || ('S06 temporary 429 -> 60 s pause: ' || case when v = 60 then 'PASS' else 'FAIL gate=' || v end);

  -- S9 invalid credentials / permission are classified, never treated as quota (no key switching)
  r := r || ('S09 invalid credentials classified: ' || case when app.error_class('error', 401, 'API key not valid') = 'credential_invalid'
        and app.error_class('error', 403, 'permission denied') = 'permission' and app.error_class('error', 0, 'fetch failed') = 'network'
        and app.error_class('rate_limited', 429, 'Quota exceeded ... PerDay') = 'quota_daily' then 'PASS' else 'FAIL' end);

  -- S10 budget limits: paid use OFF blocks; ON with a $0 hard budget blocks; ON with headroom allows
  update app.settings set value = 'false' where key = 'paid_use_enabled';
  t := app.paid_call_blocked(null, v_paid, 'gemini');
  r := r || ('S10a paid use off blocks paid calls: ' || case when t ilike 'Paid use is switched off%' then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);
  update app.settings set value = 'true' where key = 'paid_use_enabled';
  update budgets set limit_usd = 0, hard = true where scope = 'global_daily';
  t := app.paid_call_blocked(null, v_paid, 'gemini');
  r := r || ('S10b hard budget reached blocks: ' || case when t ilike 'Budget reached%' then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);
  update budgets set limit_usd = 100 where scope in ('global_daily', 'global_monthly');
  t := app.paid_call_blocked(null, v_paid, 'gemini');
  r := r || ('S10c within budget allowed: ' || case when t is null then 'PASS' else 'FAIL ' || t end);
  update app.settings set value = 'false' where key = 'paid_use_enabled';

  -- S13 interrupted tasks: ordinary failure -> backoff retry; quota failure -> waits without using an attempt; max attempts -> failed
  select id, author_id into v_book, v_author from books order by created_at limit 1;
  insert into agent_jobs(book_id, workflow, step, role_code, status, attempts, max_attempts)
  values (v_book, 'test', 'draft', 'chief_editor', 'running', 2, 5) returning id into v_job;
  perform app.fail_job(v_job, 'network blip', 10, false);
  select * into j from agent_jobs where id = v_job;
  r := r || ('S13a interrupted step retried with backoff: ' || case when j.status = 'queued' and j.run_after > now() + interval '20 seconds' and j.run_after < now() + interval '40 seconds'
        then 'PASS (' || round(extract(epoch from j.run_after - now())) || ' s)' else 'FAIL ' || j.status || ' ' || j.run_after end);
  perform app.fail_job(v_job, '429', 120, true);
  select * into j from agent_jobs where id = v_job;
  r := r || ('S13b quota wait keeps attempt count: ' || case when j.status = 'waiting_quota' and j.attempts = 1 then 'PASS' else 'FAIL ' || j.status || ' a=' || j.attempts end);
  update agent_jobs set attempts = 5 where id = v_job;
  perform app.fail_job(v_job, 'bad output', 10, false);
  select * into j from agent_jobs where id = v_job;
  r := r || ('S13c gives up after max attempts: ' || case when j.status = 'failed' then 'PASS' else 'FAIL ' || j.status end);

  -- S12 pause/resume and S14 cancel/restart, run as the author
  perform set_config('request.jwt.claims', json_build_object('sub', '9b702742-1a31-49f1-95df-90d456613663', 'role', 'authenticated')::text, true);
  perform app.set_book_state(v_book, 'paused', 'test');
  select run_state into t from books where id = v_book;
  r := r || ('S12a pause: ' || case when t = 'paused' then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);
  perform app.set_book_state(v_book, 'running', null);
  select run_state into t from books where id = v_book;
  r := r || ('S12b resume: ' || case when t = 'running' then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);
  perform app.set_book_state(v_book, 'cancelled', 'test');
  select run_state into t from books where id = v_book;
  r := r || ('S14a cancel (nothing deleted): ' || case when t = 'cancelled' and exists (select 1 from books where id = v_book) then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);
  perform app.set_book_state(v_book, 'running', null);
  select run_state into t from books where id = v_book;
  r := r || ('S14b restart: ' || case when t = 'running' then 'PASS' else 'FAIL ' || coalesce(t, 'null') end);

  raise exception 'RESULTS%', E'\n' || array_to_string(r, E'\n');
end $$;
