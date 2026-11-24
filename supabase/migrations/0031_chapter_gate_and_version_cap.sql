-- 0031: chapter gate (author reviews each finished chapter before the next starts) and a hard cap on versions per paragraph.

alter table public.books add column if not exists chapter_gate boolean not null default false;
alter table public.outline_units add column if not exists author_approved_at timestamptz;

-- start_next_paragraph: before opening a NEW chapter, stop if an earlier chapter is still waiting for the author.
create or replace function app.start_next_paragraph(p_book uuid, p_guidance text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_ch uuid; v_block uuid; v_n int; v_wait record;
begin
  if app.revision_open(p_book) then return null; end if;
  if exists (select 1 from public.manuscript_blocks where book_id = p_book
              and status in ('planned','drafted','in_review','revision_requested','qc_passed')) then
    return null;
  end if;
  update public.outline_units set status = 'reviewed'
   where book_id = p_book and level = 'chapter' and status in ('planned','drafting')
     and target_words is not null and app.chapter_words(id, true) >= target_words;
  v_ch := app.current_chapter(p_book);
  if v_ch is not null and (select chapter_gate from public.books where id = p_book)
     and not exists (select 1 from public.manuscript_blocks where unit_id = v_ch) then
    select o.id, o.title, (select count(*) from public.outline_units x where x.book_id = p_book and x.level = 'chapter' and x.order_key <= o.order_key) n
      into v_wait from public.outline_units o
     where o.book_id = p_book and o.level = 'chapter' and o.status = 'reviewed' and o.author_approved_at is null
       and o.order_key < (select order_key from public.outline_units where id = v_ch)
     order by o.order_key limit 1;
    if v_wait.id is not null then
      update public.books set run_state = 'paused', paused_at = now(),
             paused_reason = format('Chapter %s ("%s") is written and waiting for your review', v_wait.n, v_wait.title)
       where id = p_book;
      insert into public.intake_messages(book_id, role, content) values (p_book, 'system',
        format('Chapter %s ("%s") is complete. Read it, leave notes on any paragraph, then press "Approve chapter and continue". The team waits until you do.', v_wait.n, v_wait.title));
      return null;
    end if;
  end if;
  if v_ch is null and not exists (select 1 from public.outline_units where book_id = p_book and level = 'chapter') then
    insert into public.outline_units(book_id, level, order_key, title, purpose)
    values (p_book, 'chapter', 'a0', 'Chapter 1', 'Opening chapter') returning id into v_ch;
  end if;
  if v_ch is null then
    update public.books set status = 'production', autopilot = false where id = p_book and status = 'writing';
    insert into public.intake_messages(book_id, role, content)
    values (p_book, 'system', 'First draft complete: every chapter has reached its target length. Autopilot has stopped.');
    return null;
  end if;
  update public.outline_units set status = 'drafting' where id = v_ch and status = 'planned';
  select count(*) into v_n from public.manuscript_blocks where book_id = p_book;
  insert into public.manuscript_blocks(book_id, unit_id, order_key)
  values (p_book, v_ch, lpad(v_n::text, 6, '0')) returning id into v_block;
  update public.books set status = 'writing' where id = p_book and status = 'planning';
  perform app.enqueue(p_book, 'paragraph', 'draft', 'lead_writer', 90,
                      jsonb_build_object('block_id', v_block, 'guidance', p_guidance));
  return v_block;
end $$;

-- The author approves a finished chapter: every AI-approved paragraph in it becomes author-approved, and the book resumes.
create or replace function app.approve_chapter(p_chapter uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v_book uuid; blk record; n int := 0;
begin
  select book_id into v_book from public.outline_units where id = p_chapter and level = 'chapter';
  if v_book is null then raise exception 'chapter not found'; end if;
  if not app.owns_book(v_book) then raise exception 'only the book''s author can approve' using errcode = '42501'; end if;
  for blk in select m.id from public.manuscript_blocks m
              where m.book_id = v_book and m.status in ('ai_approved', 'qc_passed')
                and (m.unit_id = p_chapter or m.unit_id in (select id from public.outline_units where parent_id = p_chapter)) loop
    perform app.approve_block(blk.id); n := n + 1;
  end loop;
  update public.outline_units set author_approved_at = now() where id = p_chapter;
  insert into public.intake_messages(book_id, role, content)
  values (v_book, 'system', format('You approved this chapter (%s paragraphs).', n));
  if (select run_state from public.books where id = v_book) = 'paused'
     and (select paused_reason from public.books where id = v_book) like 'Chapter % is written and waiting for your review' then
    perform app.set_book_state(v_book, 'running', null);
  end if;
  return n;
end $$;
revoke all on function app.approve_chapter(uuid) from public, anon;
grant execute on function app.approve_chapter(uuid) to authenticated;

-- Version cap: a paragraph that has had 12 versions since it was opened keeps its best version and is AI-approved
-- with a flag for the author. Inserted as an extra condition in autopilot_tick's existing plateau rule.
do $$
declare d text;
begin
  select pg_get_functiondef('app.autopilot_tick()'::regprocedure) into d;
  if position('v_ver >= 12' in d) = 0 then
    d := replace(d, 'if v_ver >= 8 and best.version_no <= (select max(version_no) from public.block_versions where block_id = blk.id) - 8 then',
                    'if v_ver >= 12 or (v_ver >= 8 and best.version_no <= (select max(version_no) from public.block_versions where block_id = blk.id) - 8) then');
    d := replace(d, '''Best score %s did not improve in the last 8 tries (%s versions); kept the best version (v%s). Your bar is above %s.''',
                    '''Best score %s after %s versions (limit 12, or no gain in 8 tries); kept the best version (v%s). Your bar is above %s. Please review.''');
    if position('v_ver >= 12' in d) = 0 then raise exception 'autopilot_tick text did not match; cap not applied'; end if;
    execute d;
  end if;
end $$;
