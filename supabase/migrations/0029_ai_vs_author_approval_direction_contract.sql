-- 0029: AI approval kept separate from author approval (Document 4, Part D), and a per-book Direction Contract.
-- Nothing is deleted: approval rows stay; only the block status of autopilot-only approvals is corrected.

-- 1. New status
alter table public.manuscript_blocks drop constraint manuscript_blocks_status_check;
alter table public.manuscript_blocks add constraint manuscript_blocks_status_check check (status = any (array[
  'planned','drafted','in_review','revision_requested','qc_passed','ai_approved','author_approved','reopened','cut']));

-- 2. Autopilot now records AI approval only
create or replace function app.autopilot_approve(p_block uuid, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare b public.manuscript_blocks%rowtype; v_author uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block for update;
  if b.status <> 'qc_passed' then return; end if;
  select author_id into v_author from public.books where id = b.book_id;
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id, via, note)
  values (b.book_id, 'block', p_block, 'approved', v_author, 'autopilot', p_note);
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'ai_approved' where id = p_block;
  perform set_config('app.via_commit', 'off', true);
  update public.decisions set status = 'decided', outcome = jsonb_build_object('title', 'Accepted by the AI team (awaiting the author)', 'note', p_note)
   where book_id = b.book_id and type = 'consolidation' and subject_ref = p_block::text and status = 'pending';
  update public.agent_jobs set status = 'cancelled', updated_at = now()
   where payload->>'block_id' = p_block::text and status in ('queued','waiting_quota') and step in ('review','consolidate','revise');
  if not exists (select 1 from public.agent_jobs where step = 'extract_facts' and payload->>'block_version_id' = b.current_version_id::text) then
    perform app.enqueue(b.book_id, 'paragraph', 'extract_facts', 'continuity_manager', 70,
                        jsonb_build_object('block_id', p_block, 'block_version_id', b.current_version_id));
  end if;
end $$;

-- 3. The author can approve a paragraph the team passed or the AI approved
create or replace function app.approve_block(p_block_id uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare b public.manuscript_blocks%rowtype; v_id uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block_id for update;
  if not app.owns_book(b.book_id) then
    raise exception 'only the book''s author can approve' using errcode = '42501';
  end if;
  if b.status = 'author_approved' then return null; end if;
  if b.status not in ('qc_passed', 'ai_approved') then
    raise exception 'the team is still reviewing this paragraph; you can approve it once it has passed review';
  end if;
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id, via)
  values (b.book_id, 'block', p_block_id, 'approved', app.current_author_id(), 'author') returning id into v_id;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'author_approved' where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
  update public.agent_jobs set status = 'cancelled', updated_at = now()
   where payload->>'block_id' = p_block_id::text and status in ('queued','waiting_quota')
     and step in ('review','consolidate','revise');
  return v_id;
end $$;

-- 4. "Done" for pipeline purposes = AI- or author-approved
create or replace function app.chapter_words(p_chapter uuid, p_approved_only boolean default true)
returns integer language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0)::int
    from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.status <> 'cut' and (not p_approved_only or m.status in ('author_approved', 'ai_approved'))
     and (m.unit_id = p_chapter or m.unit_id in (select id from public.outline_units where parent_id = p_chapter))
$$;

create or replace function app.book_progress(p_book uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_target int; v_done int; v_paras int; v_author int; v_first timestamptz; v_recent int; v_hours numeric; v_pace numeric; v_left int;
begin
  if not (app.owns_book(p_book) or auth.role() = 'service_role') then raise exception 'not your book' using errcode = '42501'; end if;
  select coalesce(sum(target_words), 0) into v_target from public.outline_units where book_id = p_book and level = 'chapter';
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0), count(*),
         count(*) filter (where m.status = 'author_approved')
    into v_done, v_paras, v_author
    from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.book_id = p_book and m.status in ('author_approved', 'ai_approved');
  with firsts as (
    select a.subject_id, min(a.created_at) at from public.approvals a
     where a.book_id = p_book and a.subject_type = 'block' and a.decision = 'approved' group by a.subject_id)
  select min(f.at),
         coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)) filter (where f.at > now() - interval '48 hours'), 0)
    into v_first, v_recent
    from firsts f join public.manuscript_blocks m on m.id = f.subject_id and m.status in ('author_approved', 'ai_approved')
    join public.block_versions v on v.id = m.current_version_id;
  v_hours := greatest(1, least(48, extract(epoch from now() - coalesce(v_first, now())) / 3600));
  v_pace := case when v_first is null then 0 else v_recent / v_hours end;
  v_left := greatest(0, v_target - v_done);
  return jsonb_build_object(
    'target_words', v_target, 'approved_words', v_done, 'approved_paragraphs', v_paras,
    'author_approved_paragraphs', v_author, 'ai_approved_paragraphs', v_paras - v_author,
    'percent', case when v_target > 0 then round(100.0 * least(v_done, v_target) / v_target, 1) else null end,
    'words_per_hour', round(v_pace, 1), 'words_left', v_left,
    'hours_left', case when v_pace > 0 then round(v_left / v_pace, 1) else null end,
    'eta', case when v_pace > 0 and v_left > 0 then now() + make_interval(secs => (v_left / v_pace) * 3600) else null end);
end $$;

create or replace function app.close_notes_on_approval()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status in ('author_approved', 'ai_approved') and old.status is distinct from new.status then
    update public.author_notes set status = 'applied' where block_id = new.id and scope = 'paragraph' and status = 'open';
  end if;
  return new;
end $$;

create or replace function app.advance_revisions(p_book uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare it record; nxt record; v_status text;
begin
  for it in select i.id, i.block_id from public.revision_plan_items i join public.revision_plans p on p.id = i.plan_id
             where p.book_id = p_book and p.status = 'active' and i.status = 'active' loop
    select status into v_status from public.manuscript_blocks where id = it.block_id;
    if v_status is null or v_status in ('author_approved', 'ai_approved', 'cut') then
      update public.revision_plan_items set status = case when v_status = 'cut' then 'skipped' else 'done' end, finished_at = now() where id = it.id;
    else
      return jsonb_build_object('waiting_on', it.block_id);
    end if;
  end loop;
  select i.*, p.note_id into nxt from public.revision_plan_items i
    join public.revision_plans p on p.id = i.plan_id join public.manuscript_blocks m on m.id = i.block_id
   where p.book_id = p_book and p.status = 'active' and i.status = 'pending'
     and not exists (select 1 from public.revision_plan_items x where x.plan_id = p.id and x.added_at > now() - interval '15 seconds')
   order by p.created_at, m.order_key limit 1;
  if nxt.id is null then
    update public.revision_plans set status = 'done', finished_at = now()
     where book_id = p_book and status = 'active'
       and not exists (select 1 from public.revision_plan_items i where i.plan_id = revision_plans.id and i.status in ('pending', 'active'));
    return '{"idle":true}'::jsonb;
  end if;
  update public.revision_plan_items set status = 'active', started_at = now() where id = nxt.id;
  perform app.reopen_block_now(nxt.block_id, nxt.instruction, nxt.note_id, nxt.priority);
  return jsonb_build_object('opened', nxt.block_id);
end $$;

create or replace function app.maybe_emotion_audit()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare bk record; v_last timestamptz; v_new int; v_total int; n int := 0;
begin
  for bk in select id from public.books where status in ('planning', 'writing') and run_state = 'running' loop
    if app.revision_open(bk.id) then continue; end if;
    if exists (select 1 from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit'
                and status in ('queued', 'running', 'waiting_quota')) then continue; end if;
    select max(created_at) into v_last from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit' and status = 'done';
    select count(*) into v_total from public.manuscript_blocks where book_id = bk.id and status in ('author_approved', 'ai_approved');
    select count(*) into v_new from (
      select a.subject_id from public.approvals a
       where a.book_id = bk.id and a.subject_type = 'block' and a.decision = 'approved'
       group by a.subject_id having min(a.created_at) > coalesce(v_last, '-infinity')) f;
    if (v_last is null and v_total >= 3) or (v_last is not null and v_new >= 10) then
      perform app.enqueue(bk.id, 'emotion', 'audit', 'reader_panel_manager', 96, '{}'::jsonb);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- 5. Correct history: a block whose only approvals came from autopilot was never approved by the author.
--    Approval rows are kept untouched (audit trail); only the block status changes.
do $$
begin
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks m set status = 'ai_approved'
   where m.status = 'author_approved'
     and exists (select 1 from public.approvals a where a.subject_type = 'block' and a.subject_id = m.id and a.decision = 'approved')
     and not exists (select 1 from public.approvals a where a.subject_type = 'block' and a.subject_id = m.id
                       and a.decision = 'approved' and coalesce(a.via, 'author') <> 'autopilot');
  perform set_config('app.via_commit', 'off', true);
end $$;

-- 6. Direction Contract: the author-approved creative decisions every agent must honour (Document 4, Part B)
alter table public.books add column if not exists direction_contract jsonb not null default '{}'::jsonb;
comment on column public.books.direction_contract is
  'Author-approved creative decisions (core idea, voice, must-keep devices, must-avoid, decisions log). Injected into every writing and review prompt.';
