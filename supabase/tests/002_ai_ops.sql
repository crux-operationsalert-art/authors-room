-- AI ops tests: single project, vault-only secrets, team routing, queue, views.
\set QUIET on
begin;

select app.admin_set_project('Author''s Room', 'authors-room-prod', 'tier1');
-- T1: a second active project is refused (D-01)
do $$ begin
  begin insert into ai_projects(label) values ('second'); raise exception 'T1 fail: second active project';
  exception when unique_violation then raise notice 'T1 pass: one active project'; end;
end $$;

insert into project_model_limits(project_id, model_id, rpm, tpm, rpd)
select id, 'test-flash', 10, 100000, 5 from ai_projects where is_active;

-- Test keys only (fake values)
select app.admin_add_ai_key('K01', 'AQ.TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111', 'writing');
select app.admin_add_ai_key('K02', 'AQ.TEST-bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222', 'editorial');
select app.admin_add_ai_key('K03', 'AQ.TEST-cccccccccccccccccccccccccccc3333');

-- T2: secret not stored in ai_keys; last4 + vault reference only
do $$ begin
  if exists (select 1 from ai_keys where key_last4 not in ('1111','2222','3333')) then raise exception 'T2 fail: last4'; end if;
  if exists (select 1 from information_schema.columns where table_name='ai_keys' and column_name in ('secret','api_key','key'))
    then raise exception 'T2 fail: secret column exists'; end if;
  if app.get_key_secret((select id from ai_keys where label='K01')) <> 'AQ.TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111'
    then raise exception 'T2 fail: vault round trip'; end if;
  raise notice 'T2 pass: secrets only in vault';
end $$;

-- T3: duplicate key refused
do $$ begin
  begin perform app.admin_add_ai_key('K99', 'AQ.TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111'); raise exception 'T3 fail';
  exception when others then
    if sqlerrm like '%already registered%' then raise notice 'T3 pass: duplicate refused'; else raise; end if;
  end;
end $$;

-- T4: routing — team's own key; unassigned team falls back to first active key
set local request.jwt.claim.role = 'service_role';
do $$ begin
  if (select label from app.resolve_key_for_team('writing')) <> 'K01' then raise exception 'T4 fail: writing'; end if;
  if (select label from app.resolve_key_for_team('readers')) <> 'K01' then raise exception 'T4 fail: fallback'; end if;
  perform app.set_key_status((select id from ai_keys where label='K02'), 'revoked');
  if (select label from app.resolve_key_for_team('editorial')) <> 'K01' then raise exception 'T4 fail: revoked fallback'; end if;
  raise notice 'T4 pass: team routing and revoke fallback';
end $$;

-- T5: queue — priority order, quota wait does not burn attempts
insert into agent_jobs(workflow, step, role_code, priority) values
  ('paragraph','layer1','line_copy_editor',40), ('paragraph','draft','lead_writer',90);
do $$ declare j agent_jobs; begin
  select * into j from app.claim_next_job('w1');
  if j.role_code <> 'lead_writer' or j.status <> 'running' or j.attempts <> 1 then raise exception 'T5 fail: priority claim'; end if;
  perform app.fail_job(j.id, '429', 30, true);
  select * into j from agent_jobs where id = j.id;
  if j.status <> 'waiting_quota' or j.attempts <> 0 then raise exception 'T5 fail: quota wait'; end if;
  raise notice 'T5 pass: queue priority + quota wait';
end $$;

-- T6: views — usage counted per key, per team and against the PROJECT quota
insert into agent_runs(role_code, team_code, key_id, project_id, model_id, input_tokens, output_tokens, status)
select 'lead_writer','writing', k.id, k.project_id, 'test-flash', 1000, 200, 'ok' from ai_keys k where label='K01';
insert into agent_runs(role_code, team_code, key_id, project_id, model_id, input_tokens, output_tokens, status)
select 'line_copy_editor','editorial', k.id, k.project_id, 'test-flash', 500, 50, s
  from ai_keys k, unnest(array['ok','ok','ok','rate_limited']) s where label='K03';
do $$ begin
  if (select requests_today from v_key_status where label='K01') <> 1 then raise exception 'T6 fail: key requests'; end if;
  if (select rate_limited_today from v_key_status where label='K03') <> 1 then raise exception 'T6 fail: key 429s'; end if;
  if (select teams from v_key_status where label='K03') <> 'Standby (unassigned)' then raise exception 'T6 fail: standby label'; end if;
  if (select requests_today from v_project_quota) <> 4 then raise exception 'T6 fail: project total'; end if;
  if (select quota_state from v_project_quota) <> 'exhausted' then raise exception 'T6 fail: state'; end if;
  if (select requests_today from v_team_usage where team_code='editorial') <> 3 then raise exception 'T6 fail: team'; end if;
  raise notice 'T6 pass: key, team and project-quota views';
end $$;

-- T7: authenticated non-author sees no keys
set local request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
set local role authenticated;
do $$ begin
  if (select count(*) from v_key_status) <> 0 then raise exception 'T7 fail: non-author sees keys'; end if;
  begin perform app.get_key_secret((select id from ai_keys limit 1)); raise exception 'T7 fail: secret readable';
  exception when insufficient_privilege then raise notice 'T7 pass: keys hidden from non-authors'; end;
end $$;
reset role;

rollback;
