-- Part N §40 S11 (competing books) and S13d (crashed worker). Always rolls back (final RAISE).
do $$
declare r text[] := '{}'; v_author uuid; b_hi uuid; b_lo uuid; b_paused uuid; j_hi uuid; j_lo uuid; j_p uuid; j_old uuid; j_stale uuid; got record; s text;
begin
  select author_id into v_author from books limit 1;
  insert into books(author_id, working_title, run_state, priority) values (v_author, 'T high', 'running', 'high') returning id into b_hi;
  insert into books(author_id, working_title, run_state, priority) values (v_author, 'T low', 'running', 'low') returning id into b_lo;
  insert into books(author_id, working_title, run_state, priority) values (v_author, 'T paused', 'paused', 'high') returning id into b_paused;
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, run_after) values
    (b_paused, 'test', 'draft', 'chief_editor', 'queued', 5000, now() - interval '1 min') returning id into j_p;
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, run_after) values
    (b_lo, 'test', 'draft', 'chief_editor', 'queued', 1000, now() - interval '1 min') returning id into j_lo;
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, run_after) values
    (b_hi, 'test', 'draft', 'chief_editor', 'queued', 1000, now() - interval '1 min') returning id into j_hi;
  select * into got from app.claim_next_job('test-worker');
  r := r || ('S11a paused book never claimed; high-priority book first: ' || case when got.id = j_hi then 'PASS' when got.id = j_p then 'FAIL (paused claimed)' else 'FAIL' end);
  select * into got from app.claim_next_job('test-worker');
  r := r || ('S11b lower-priority book still served next: ' || case when got.id = j_lo then 'PASS' else 'FAIL' end);
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, run_after, created_at) values
    (b_lo, 'test', 'draft', 'chief_editor', 'queued', 2000, now() - interval '1 min', now() - interval '5 hours') returning id into j_old;
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, run_after) values
    (b_hi, 'test', 'draft', 'chief_editor', 'queued', 2000, now() - interval '1 min');
  select * into got from app.claim_next_job('test-worker');
  r := r || ('S11c waiting work ages up (no starvation): ' || case when got.id = j_old then 'PASS' else 'FAIL' end);
  insert into agent_jobs(book_id, workflow, step, role_code, status, priority, locked_by, locked_at, run_after) values
    (b_hi, 'test', 'draft', 'chief_editor', 'running', 0, 'dead-worker', now() - interval '10 minutes', now() + interval '1 hour') returning id into j_stale;
  perform app.claim_next_job('test-worker');
  select status into s from agent_jobs where id = j_stale;
  r := r || ('S13d crashed worker''s step recovered: ' || case when s = 'queued' then 'PASS' else 'FAIL ' || s end);
  raise exception 'RESULTS%', E'\n' || array_to_string(r, E'\n');
end $$;
