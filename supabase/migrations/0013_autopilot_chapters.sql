-- 0013: Autopilot and chapter plan.
-- Autopilot: the team approves its own paragraphs when the Chief Editor's score is above the author's
-- threshold, revises (up to 3 times) when it is not, and moves on to the next paragraph by itself.
-- Paragraphs accepted below the threshold or with unresolved serious notes are flagged "review later".
-- Chapters: the Story Architect plans chapters with word targets; paragraphs belong to the current
-- chapter; when every chapter reaches its target the first draft is complete.

alter table public.books
  add column if not exists autopilot boolean not null default false,
  add column if not exists autopilot_threshold int not null default 97 check (autopilot_threshold between 50 and 100);
alter table public.outline_units
  add column if not exists target_words int,
  add column if not exists beats text[] not null default '{}';
alter table public.approvals
  add column if not exists via text not null default 'author' check (via in ('author', 'autopilot')),
  add column if not exists note text;

-- chapter a unit belongs to (a chapter itself, or a scene's parent chapter)
create or replace function app.chapter_of(p_unit uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case when u.level = 'chapter' then u.id else u.parent_id end from public.outline_units u where u.id = p_unit
$$;

-- words in a chapter's paragraphs; p_approved_only counts only approved text
create or replace function app.chapter_words(p_chapter uuid, p_approved_only boolean default true) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0)::int
    from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.status <> 'cut' and (not p_approved_only or m.status = 'author_approved')
     and (m.unit_id = p_chapter or m.unit_id in (select id from public.outline_units where parent_id = p_chapter))
$$;

-- the chapter being written: the first one still short of its word target (no target = open-ended placeholder)
create or replace function app.current_chapter(p_book uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.outline_units
   where book_id = p_book and level = 'chapter' and status in ('planned', 'drafting')
     and (target_words is null or app.chapter_words(id, true) < target_words)
   order by order_key limit 1
$$;

-- start the next paragraph (internal: used by the author's button and by autopilot)
create or replace function app.start_next_paragraph(p_book uuid, p_guidance text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_ch uuid; v_block uuid; v_n int;
begin
  if exists (select 1 from public.manuscript_blocks where book_id = p_book
              and status in ('planned','drafted','in_review','revision_requested','qc_passed')) then
    return null;                                   -- one paragraph at a time
  end if;
  -- close chapters that reached their target
  update public.outline_units set status = 'reviewed'
   where book_id = p_book and level = 'chapter' and status in ('planned','drafting')
     and target_words is not null and app.chapter_words(id, true) >= target_words;
  v_ch := app.current_chapter(p_book);
  if v_ch is null and not exists (select 1 from public.outline_units where book_id = p_book and level = 'chapter') then
    insert into public.outline_units(book_id, level, order_key, title, purpose)
    values (p_book, 'chapter', 'a0', 'Chapter 1', 'Opening chapter') returning id into v_ch;
  end if;
  if v_ch is null then
    -- every planned chapter has reached its target: first draft complete
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

-- the author's button keeps its checks, then uses the shared routine
create or replace function app.request_next_paragraph(p_book uuid, p_guidance text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  if not exists (select 1 from public.book_constitutions where book_id = p_book and status = 'approved') then
    raise exception 'approve the book constitution first';
  end if;
  if exists (select 1 from public.manuscript_blocks where book_id = p_book
              and status in ('planned','drafted','in_review','revision_requested')) then
    raise exception 'the team is still working on the current paragraph';
  end if;
  v := app.start_next_paragraph(p_book, p_guidance);
  if v is null and exists (select 1 from public.manuscript_blocks where book_id = p_book and status = 'qc_passed') then
    raise exception 'approve or revise the paragraph that is waiting for you first';
  end if;
  return v;
end $$;

-- approval on the author's behalf (recorded as autopilot, with an optional "review later" note)
create or replace function app.autopilot_approve(p_block uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype; v_author uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block for update;
  if b.status <> 'qc_passed' then return; end if;
  select author_id into v_author from public.books where id = b.book_id;
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id, via, note)
  values (b.book_id, 'block', p_block, 'approved', v_author, 'autopilot', p_note);
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'author_approved' where id = p_block;
  perform set_config('app.via_commit', 'off', true);
  update public.decisions set status = 'decided', outcome = jsonb_build_object('title', 'Accepted by autopilot', 'note', p_note)
   where book_id = b.book_id and type = 'consolidation' and subject_ref = p_block and status = 'pending';
  update public.agent_jobs set status = 'cancelled', updated_at = now()
   where payload->>'block_id' = p_block::text and status in ('queued','waiting_quota') and step in ('review','consolidate','revise');
  if not exists (select 1 from public.agent_jobs where step = 'extract_facts' and payload->>'block_version_id' = b.current_version_id::text) then
    perform app.enqueue(b.book_id, 'paragraph', 'extract_facts', 'continuity_manager', 70,
                        jsonb_build_object('block_id', p_block, 'block_version_id', b.current_version_id));
  end if;
end $$;

-- the autopilot itself: runs every minute
create or replace function app.autopilot_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare bk record; blk record; v_score int; v_ver int; v_pending boolean; v_instr text; acted jsonb := '[]';
begin
  for bk in select id, autopilot_threshold from public.books where autopilot and status in ('planning','writing') loop
    -- failed steps get another go after 10 minutes (usually Google was busy)
    update public.agent_jobs set status = 'queued', attempts = 0, run_after = now(), locked_by = null, updated_at = now()
     where book_id = bk.id and status = 'failed' and updated_at < now() - interval '10 minutes';

    select m.id, m.current_version_id into blk from public.manuscript_blocks m
     where m.book_id = bk.id and m.status = 'qc_passed' order by m.order_key limit 1;
    if found then
      select (j.result->>'score')::int into v_score from public.agent_jobs j
       where j.book_id = bk.id and j.step = 'consolidate' and j.status = 'done'
         and j.payload->>'block_version_id' = blk.current_version_id::text
       order by j.updated_at desc limit 1;
      select version_no into v_ver from public.block_versions where id = blk.current_version_id;
      v_pending := exists (select 1 from public.decisions where book_id = bk.id and type = 'consolidation'
                           and subject_ref = blk.id and status = 'pending');
      if v_pending then
        perform app.autopilot_approve(blk.id, format('Accepted after %s versions; reviewers still had serious notes (score %s).', v_ver, coalesce(v_score::text, '?')));
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'accepted_flagged');
      elsif v_score is not null and v_score > bk.autopilot_threshold then
        perform app.autopilot_approve(blk.id, null);
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'approved', 'score', v_score);
      elsif v_ver >= 4 or v_score is null then
        perform app.autopilot_approve(blk.id, format('Best of %s versions; score %s was not above %s.', v_ver, coalesce(v_score::text, '?'), bk.autopilot_threshold));
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'accepted_below_threshold', 'score', v_score);
      elsif not exists (select 1 from public.agent_jobs where payload->>'block_id' = blk.id::text and step = 'revise'
                        and status in ('queued','running','waiting_quota')) then
        select string_agg(format('- %s (%s): %s', i.issue, i.severity, coalesce(i.suggested_fix, '')), E'\n') into v_instr
          from public.editorial_issues i where i.block_version_id = blk.current_version_id;
        perform set_config('app.via_commit', 'on', true);
        update public.manuscript_blocks set status = 'revision_requested' where id = blk.id;
        perform set_config('app.via_commit', 'off', true);
        perform app.enqueue(bk.id, 'paragraph', 'revise', 'lead_writer', 90, jsonb_build_object('block_id', blk.id,
          'loop', v_ver, 'instructions', format('Raise this paragraph from %s to above %s out of 100. Address every reviewer note:%s%s',
            coalesce(v_score::text, '?'), bk.autopilot_threshold, E'\n', coalesce(v_instr, '- tighten wording, sharpen voice and humour'))));
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'revise', 'score', v_score);
      end if;
      continue;
    end if;

    -- nothing waiting: start the next paragraph (or the chapter plan) when the team is idle
    if exists (select 1 from public.manuscript_blocks where book_id = bk.id
                and status in ('planned','drafted','in_review','revision_requested')) then continue; end if;
    if exists (select 1 from public.agent_jobs where book_id = bk.id and status in ('queued','running','waiting_quota')) then continue; end if;
    if not exists (select 1 from public.book_constitutions where book_id = bk.id and status = 'approved') then continue; end if;
    if not exists (select 1 from public.outline_units where book_id = bk.id and level = 'chapter' and target_words is not null) then
      if not exists (select 1 from public.agent_jobs where book_id = bk.id and step = 'plan' and status <> 'failed'
                     and created_at > now() - interval '1 hour') then
        perform app.enqueue(bk.id, 'outline', 'plan', 'story_architect', 95, '{}'::jsonb);
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'plan_chapters');
      end if;
      continue;
    end if;
    perform app.start_next_paragraph(bk.id, null);
    acted := acted || jsonb_build_object('book', bk.id, 'action', 'next_paragraph');
  end loop;
  return acted;
end $$;

-- the author's switch
create or replace function app.set_autopilot(p_book uuid, p_on boolean, p_threshold int default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  update public.books set autopilot = p_on, autopilot_threshold = coalesce(p_threshold, autopilot_threshold) where id = p_book;
end $$;

revoke all on function app.autopilot_tick() from public, anon, authenticated;
revoke all on function app.autopilot_approve(uuid, text) from public, anon, authenticated;
revoke all on function app.start_next_paragraph(uuid, text) from public, anon, authenticated;
grant execute on function app.set_autopilot(uuid, boolean, int) to authenticated;
grant execute on function app.chapter_words(uuid, boolean) to authenticated;
grant execute on function app.chapter_of(uuid) to authenticated;

select cron.schedule('authors-room-autopilot', '* * * * *', $$ select app.autopilot_tick() $$);
