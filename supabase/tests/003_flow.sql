-- Author flow: claim, create book, intake, decide, approve constitution, request paragraph.
\set QUIET on
begin;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare b uuid; d uuid; blk uuid; begin
  perform app.claim_author('Test Author');
  b := app.create_book('Pilot', 'A lighthouse keeper finds letters from her future self.', 'fiction', 'standard');
  if (select count(*) from agent_jobs where book_id = b and workflow = 'intake') <> 1 then raise exception 'F1 fail: interview job'; end if;
  perform app.send_intake_message(b, 'It is for adults who like quiet mysteries.');
  if (select count(*) from agent_jobs where book_id = b and workflow = 'intake') <> 1 then raise exception 'F1 fail: duplicate interview job'; end if;
  raise notice 'F1 pass: book created, one interview job';

  insert into decisions(book_id, type, question, options) values (b, 'genre_direction', 'Which direction?', '[{"title":"Literary mystery"}]') returning id into d;
  perform app.decide(d, '{"title":"Literary mystery"}');
  if not exists (select 1 from agent_jobs where book_id = b and workflow = 'constitution') then raise exception 'F2 fail'; end if;
  raise notice 'F2 pass: direction chosen, constitution job queued';

  begin perform app.request_next_paragraph(b); raise exception 'F3 fail: paragraph before constitution';
  exception when others then if sqlerrm not like '%constitution%' then raise; end if; end;
  update book_constitutions set status = 'proposed' where book_id = b;
  perform app.approve_constitution(b);
  blk := app.request_next_paragraph(b);
  if not exists (select 1 from agent_jobs where workflow='paragraph' and payload->>'block_id' = blk::text) then raise exception 'F3 fail: draft job'; end if;
  begin perform app.request_next_paragraph(b); raise exception 'F3 fail: second paragraph while first in progress';
  exception when others then if sqlerrm not like '%still working%' then raise; end if; end;
  raise notice 'F3 pass: constitution gate and one paragraph at a time';
end $$;
-- F4: a second account cannot become author
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ begin
  begin perform app.claim_author('Intruder'); raise exception 'F4 fail';
  exception when sqlstate '42501' then raise notice 'F4 pass: single author'; end;
end $$;
-- F5: watchdog restarts a stalled draft and exports a backup
do $$ declare b uuid; r jsonb; begin
  select id into b from books limit 1;
  update manuscript_blocks set created_at = now() - interval '20 minutes' where book_id = b;
  delete from agent_jobs where workflow = 'paragraph';
  r := app.watchdog();
  if (r->>'drafts')::int <> 1 then raise exception 'F5 fail: watchdog %', r; end if;
  raise notice 'F5 pass: watchdog restarted a stalled draft';
end $$;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare b uuid; j jsonb; begin
  select id into b from books limit 1;
  j := app.export_book(b);
  if j->'book'->>'working_title' <> 'Pilot' or jsonb_array_length(j->'conversation') < 2 then raise exception 'F6 fail: export'; end if;
  raise notice 'F6 pass: backup export';
end $$;
rollback;
