-- Part H §24 routing (0043): quality order, free before paid, per-project daily rests, health demotion,
-- per-project quota, ineligible projects never offered. Always rolls back (final RAISE). Last run 24 Nov 2026: 5/5 pass.
do $$
declare r text[] := '{}'; v_primary uuid; v_b uuid; v_kb uuid; m1 text := 'test-route-a'; m2 text := 'test-route-b'; t text;
begin
  select id into v_primary from ai_projects where is_active;
  insert into ai_projects(label, google_project_ref, is_active, billing_enabled, routing_eligible, usage_tier)
  values ('test paid B', 'test-paid-b', false, true, true, 'tier1') returning id into v_b;
  insert into ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, status)
  values (v_b, 'KB', 'bbbb', 'fp-route-b', gen_random_uuid(), 'gemini', 'active') returning id into v_kb;
  select string_agg(model_id || '@' || case when project_id = v_primary then 'free' else 'paid' end, ' > ' order by ord) into t
    from app.gemini_candidates('drafting', array[m1, m2], 100);
  r := r || ('R1 order (quality first, free before paid): ' || case when t = m1||'@free > '||m1||'@paid > '||m2||'@free > '||m2||'@paid' then 'PASS' else 'FAIL ' || t end);
  insert into project_model_rest(project_id, model_id, until, reason) values (v_primary, m1, now() + interval '5 hours', 'test');
  select model_id || '@' || case when project_id = v_primary then 'free' else 'paid' end into t from app.gemini_candidates('drafting', array[m1, m2], 100) where wait = 0 order by ord limit 1;
  r := r || ('R2 daily rest is per project (falls to project B, same model): ' || case when t = m1||'@paid' then 'PASS' else 'FAIL ' || coalesce(t,'none') end);
  insert into agent_runs(role_code, team_code, project_id, model_id, status, http_status) select 'chief_editor','orchestration', v_b, m1, 'error', 503 from generate_series(1,6);
  select model_id into t from app.gemini_candidates('drafting', array[m1, m2], 100) where project_id = v_b order by ord limit 1;
  r := r || ('R3 failing model demoted: ' || case when t = m2 then 'PASS' else 'FAIL ' || t end);
  insert into quota_limits(project_id, model_id, dimension, limit_value, source) values (v_primary, m2, 'rpm', 1, 'test'), (v_b, m2, 'rpm', 1, 'test');
  insert into agent_runs(role_code, team_code, project_id, model_id, status) values ('chief_editor','orchestration', v_primary, m2, 'ok');
  r := r || ('R4 quota counted per project: ' || case when app.quota_gate(m2, 0, v_primary) = 60 and app.quota_gate(m2, 0, v_b) = 0 then 'PASS' else 'FAIL' end);
  update ai_projects set routing_eligible = false where id = v_b;
  r := r || ('R5 ineligible project never offered: ' || case when not exists (select 1 from app.gemini_candidates('drafting', array[m1, m2], 100) where project_id = v_b) then 'PASS' else 'FAIL' end);
  raise exception 'RESULTS%', E'\n' || array_to_string(r, E'\n');
end $$;
