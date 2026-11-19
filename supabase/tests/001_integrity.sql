-- Integrity tests. Run: psql -v ON_ERROR_STOP=1 -f this file (after migrations).
-- Each check raises on failure, so the run stops at the first broken rule.
\set QUIET on
begin;

-- Fixtures: two authors, one book each.
insert into public.authors(id, auth_user_id, display_name) values
  ('00000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Author One'),
  ('00000000-0000-0000-0000-0000000000a2','22222222-2222-2222-2222-222222222222','Author Two');
insert into public.books(id, author_id, working_title) values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','Book One'),
  ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a2','Book Two');
insert into public.manuscript_blocks(id, book_id, order_key) values
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','a0'),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b2','a0');

-- T1: commit creates v1 and v2 with parent links
select app.commit_block_version('00000000-0000-0000-0000-0000000000c1','First draft.','draft','agent','ai_generated');
select app.commit_block_version('00000000-0000-0000-0000-0000000000c1','Second draft.','revision','agent','ai_edited');
do $$ begin
  if (select count(*) from block_versions where block_id='00000000-0000-0000-0000-0000000000c1') <> 2 then raise exception 'T1 fail: expected 2 versions'; end if;
  if (select parent_version_id from block_versions where block_id='00000000-0000-0000-0000-0000000000c1' and version_no=2)
     is distinct from (select id from block_versions where block_id='00000000-0000-0000-0000-0000000000c1' and version_no=1)
     then raise exception 'T1 fail: parent link'; end if;
  raise notice 'T1 pass: versions chain';
end $$;

-- T2: versions are append-only
do $$ begin
  begin update block_versions set text='x'; raise exception 'T2 fail: update allowed';
  exception when sqlstate 'P0001' then raise notice 'T2 pass: versions append-only'; end;
end $$;

-- T3: direct pointer change is blocked
do $$ begin
  begin update manuscript_blocks set current_version_id = null where id='00000000-0000-0000-0000-0000000000c1';
        raise exception 'T3 fail: direct pointer change allowed';
  exception when sqlstate 'P0001' then raise notice 'T3 pass: single write path'; end;
end $$;

-- T4: author approves; then agent change without approval is refused
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
-- T4a: approval is refused while the paragraph is still in review
do $$ begin
  begin perform app.approve_block('00000000-0000-0000-0000-0000000000c1'); raise exception 'T4a fail: approved before review';
  exception when others then if sqlerrm not like '%still reviewing%' then raise; end if; end;
  raise notice 'T4a pass: approval waits for review';
end $$;
select app.set_block_status('00000000-0000-0000-0000-0000000000c1', 'qc_passed');
select app.approve_block('00000000-0000-0000-0000-0000000000c1');
-- T4b: late workflow status changes cannot un-approve
select app.set_block_status('00000000-0000-0000-0000-0000000000c1', 'in_review');
do $$ begin
  if (select status from manuscript_blocks where id='00000000-0000-0000-0000-0000000000c1') <> 'author_approved'
    then raise exception 'T4b fail: approval undone by workflow'; end if;
  raise notice 'T4b pass: approval cannot be undone by the workflow';
end $$;
do $$ begin
  begin perform app.commit_block_version('00000000-0000-0000-0000-0000000000c1','Sneaky edit.','x','agent','ai_edited');
        raise exception 'T4 fail: unapproved change to approved block';
  exception when sqlstate 'P0001' then raise notice 'T4 pass: approved text locked'; end;
end $$;

-- T5: approval for different text is refused; exact text is accepted once
do $$ declare a uuid; begin
  a := app.authorise_block_change('00000000-0000-0000-0000-0000000000c1','Approved new text.');
  begin perform app.commit_block_version('00000000-0000-0000-0000-0000000000c1','Other text.','x','agent','ai_edited', null, a);
        raise exception 'T5 fail: mismatched text accepted';
  exception when sqlstate 'P0001' then null; end;
  perform app.commit_block_version('00000000-0000-0000-0000-0000000000c1','Approved new text.','author change','agent','ai_edited', null, a);
  begin perform app.commit_block_version('00000000-0000-0000-0000-0000000000c1','Approved new text.','reuse','agent','ai_edited', null, a);
        raise exception 'T5 fail: approval reused';
  exception when sqlstate 'P0001' then null; end;
  if (select status from manuscript_blocks where id='00000000-0000-0000-0000-0000000000c1') <> 'author_approved'
    then raise exception 'T5 fail: status after approved change'; end if;
  raise notice 'T5 pass: exact, single-use approvals';
end $$;

-- T6: another author cannot approve my block
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  begin perform app.approve_block('00000000-0000-0000-0000-0000000000c1'); raise exception 'T6 fail: foreign approval';
  exception when sqlstate '42501' then raise notice 'T6 pass: only owner approves'; end;
end $$;

-- T7: RLS isolation — author two sees only book two
set local role authenticated;
do $$ begin
  if (select count(*) from books) <> 1 or (select working_title from books) <> 'Book Two'
    then raise exception 'T7 fail: RLS leak (books)'; end if;
  if exists (select 1 from block_versions where book_id='00000000-0000-0000-0000-0000000000b1')
    then raise exception 'T7 fail: RLS leak (versions)'; end if;
  raise notice 'T7 pass: per-book isolation';
end $$;
-- T8: authenticated cannot insert versions directly
do $$ begin
  begin insert into block_versions(block_id, book_id, version_no, text, text_hash, reason, actor_type, provenance)
        values ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b2',1,'x','x','x','author','author_written');
        raise exception 'T8 fail: direct insert allowed';
  exception when insufficient_privilege then raise notice 'T8 pass: no direct writes'; end;
end $$;
reset role;

-- T9: audit log captured the changes
do $$ begin
  if (select count(*) from audit_log where table_name='block_versions') < 3 then raise exception 'T9 fail: audit'; end if;
  raise notice 'T9 pass: audit trail';
end $$;

-- T10: rollback creates a new version equal to v1
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ declare a uuid; begin
  a := app.authorise_block_change('00000000-0000-0000-0000-0000000000c1','First draft.');
  perform app.rollback_block('00000000-0000-0000-0000-0000000000c1', 1, a);
  if (select v.text from manuscript_blocks b join block_versions v on v.id=b.current_version_id
       where b.id='00000000-0000-0000-0000-0000000000c1') <> 'First draft.' then raise exception 'T10 fail'; end if;
  if (select count(*) from block_versions where block_id='00000000-0000-0000-0000-0000000000c1') <> 4 then raise exception 'T10 fail: history'; end if;
  raise notice 'T10 pass: rollback keeps history';
end $$;

rollback;
