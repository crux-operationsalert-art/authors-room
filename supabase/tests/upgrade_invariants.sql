-- Document 4 upgrade: invariant tests. Runs inside one transaction and always rolls back (the final RAISE),
-- reporting PASS/FAIL per test in the error message. Safe on production data.
do $$
declare
  r text[] := '{}'; b uuid; v uuid; v2 uuid; st text; n int; t text; ok boolean;
  bk uuid := (select id from public.books where branch_of is not null order by created_at limit 1);
begin
  select id into b from public.manuscript_blocks where book_id = bk and current_version_id is not null order by order_key limit 1;

  -- T1 set_block_status cannot grant author approval
  begin perform app.set_block_status(b, 'author_approved'); r := array_append(r, 'T1 FAIL'); exception when others then r := array_append(r, 'T1 PASS'); end;

  -- T2 autopilot approval is AI approval, recorded as autopilot
  perform set_config('app.via_commit', 'on', true); update public.manuscript_blocks set status = 'qc_passed' where id = b; perform set_config('app.via_commit', 'off', true);
  perform app.autopilot_approve(b, 'test');
  select status into st from public.manuscript_blocks where id = b;
  r := array_append(r, ('T2 ' || case when st = 'ai_approved' and exists (select 1 from public.approvals where subject_id = b and via = 'autopilot' and note = 'test') then 'PASS' else 'FAIL ' || st end));

  -- T3 approve_block refuses a caller who does not own the book (no signed-in author here)
  begin perform app.approve_block(b); r := array_append(r, 'T3 FAIL'); exception when others then r := array_append(r, 'T3 PASS'); end;

  -- T4 error classes
  ok := app.error_class('rate_limited', 429, 'requests per day exceeded') = 'quota_daily'
    and app.error_class('rate_limited', 429, 'per minute') = 'quota_minute'
    and app.error_class('error', 413, 'Request too large') = 'too_large'
    and app.error_class('error', 503, 'high demand') = 'provider_busy'
    and app.error_class('error', null, 'TimeoutError: Signal timed out.') = 'timeout'
    and app.error_class('schema_invalid', 200, null) = 'bad_output'
    and app.error_class('ok', 200, null) = 'ok';
  r := array_append(r, ('T4 ' || case when ok then 'PASS' else 'FAIL' end));

  -- T5 circuit breaker opens after 5 consecutive busy errors
  for n in 1..5 loop
    insert into public.agent_runs(book_id, role_code, team_code, model_id, prompt_hash, status, http_status, error)
    select bk, role_code, team_code, 'test-model-x', 'x', 'error', 503, 'high demand' from public.agent_runs where role_code is not null limit 1;
  end loop;
  r := array_append(r, ('T5 ' || case when exists (select 1 from public.model_rest where model_id = 'test-model-x' and until > now() and reason like 'circuit open%') then 'PASS' else 'FAIL' end));

  -- T6 repetition register: text for a book with paragraphs, empty for a book without
  t := app.repetition_register(bk);
  r := array_append(r, ('T6 ' || case when t like 'REPETITION REGISTER%' and app.repetition_register(gen_random_uuid()) = '' then 'PASS' else 'FAIL' end));

  -- T7 an author-approved paragraph cannot be changed without an approval token
  perform set_config('app.via_commit', 'on', true); update public.manuscript_blocks set status = 'author_approved' where id = b; perform set_config('app.via_commit', 'off', true);
  begin perform app.commit_block_version(b, 'changed text', 'test', 'agent', 'ai_edited'); r := array_append(r, 'T7 FAIL');
  exception when others then r := array_append(r, 'T7 PASS'); end;

  -- T8/T9 facts from a superseded version are retired and no longer served
  perform set_config('app.via_commit', 'on', true); update public.manuscript_blocks set status = 'in_review' where id = b; perform set_config('app.via_commit', 'off', true);
  select current_version_id into v from public.manuscript_blocks where id = b;
  insert into public.canon_facts(book_id, statement, source_block_version_id, status) values (bk, 'TEST FACT ZZ', v, 'proposed');
  r := array_append(r, ('T9a ' || case when exists (select 1 from app.book_facts(bk, 1000) f where f.statement = 'TEST FACT ZZ') then 'PASS' else 'FAIL' end));
  v2 := app.commit_block_version(b, 'A replacement paragraph for testing, long enough to be a paragraph.', 'test', 'agent', 'ai_edited');
  r := array_append(r, ('T8 ' || case when (select status from public.canon_facts where statement = 'TEST FACT ZZ') = 'retired' then 'PASS' else 'FAIL' end));
  r := array_append(r, ('T9b ' || case when not exists (select 1 from app.book_facts(bk, 1000) f where f.statement = 'TEST FACT ZZ') then 'PASS' else 'FAIL' end));

  -- T10 real spend on a free project is zero
  r := array_append(r, ('T10 ' || case when app.cost_today_usd() = 0 then 'PASS' else 'FAIL' end));

  -- T11 dated prices: Gemini 3.8 Flash doubles on 1 Jan 2027
  r := array_append(r, 'T11 ' || case when (select pin from app.price_of('gemini-3.8-flash', '2026-12-15')) = 0.75
                                and (select pin from app.price_of('gemini-3.8-flash', '2027-02-01')) = 1.50 then 'PASS' else 'FAIL' end);

  -- T12 KPIs are computed and actual cost is 0
  r := array_append(r, ('T12 ' || case when (app.cost_kpis(null)->>'actual_cost_usd')::numeric = 0 and app.cost_kpis(null)->'kpi' ? 'tokens_per_approved_word' then 'PASS' else 'FAIL' end));

  raise exception 'TEST RESULTS (rolled back): %', array_to_string(r, ', ');
end $$;
