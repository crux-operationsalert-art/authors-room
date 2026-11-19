-- 0014: Author feedback that joins the flow, more models on the main project, combined review panel.
--
-- Author notes: a note on a paragraph goes to the Chief Editor, who decides which paragraphs to change
-- (the paragraph itself and, where needed, the ones around it, even approved ones) so the text flows.
-- A note can also become a standing direction for the rest of the book. Notes stay attached to their
-- paragraph and are given to the writer and every reviewer until the paragraph is approved, so later
-- automatic revisions can no longer drop them.

create table if not exists public.author_notes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  block_id uuid references public.manuscript_blocks(id) on delete set null,
  scope text not null default 'paragraph' check (scope in ('paragraph', 'book')),
  note text not null check (length(trim(note)) > 0),
  status text not null default 'open' check (status in ('open', 'applied', 'retired')),
  plan jsonb,
  created_at timestamptz not null default now()
);
alter table public.author_notes enable row level security;
drop policy if exists notes_owner on public.author_notes;
create policy notes_owner on public.author_notes for select using (app.owns_book(book_id));
create index if not exists author_notes_book on public.author_notes(book_id, status);

-- the author's entry point (paragraph note or whole-book direction)
create or replace function app.add_author_note(p_book uuid, p_block uuid, p_note text, p_scope text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_scope text := coalesce(p_scope, case when p_block is null then 'book' else 'paragraph' end);
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  if p_note is null or length(trim(p_note)) < 3 then raise exception 'write a short note first'; end if;
  insert into public.author_notes(book_id, block_id, scope, note) values (p_book, p_block, v_scope, trim(p_note)) returning id into v_id;
  insert into public.intake_messages(book_id, role, content)
  values (p_book, 'author', case when p_block is null then 'Direction for the whole book: ' else 'Note on a paragraph: ' end || trim(p_note));
  if p_block is not null then
    perform app.enqueue(p_book, 'feedback', 'plan', 'chief_editor', 97, jsonb_build_object('note_id', v_id, 'block_id', p_block));
  end if;
  return v_id;
end $$;

-- the old "Ask for a revision" button now goes through the feedback flow (works on approved paragraphs too)
create or replace function app.request_revision(p_block uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_book uuid;
begin
  select book_id into v_book from public.manuscript_blocks where id = p_block;
  perform app.add_author_note(v_book, p_block, p_note, 'paragraph');
end $$;

-- reopen a paragraph (approved or not) for a feedback revision; internal, used by the worker
create or replace function app.reopen_for_feedback(p_block uuid, p_instruction text, p_note uuid, p_priority int default 92) returns void
language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype;
begin
  select * into b from public.manuscript_blocks where id = p_block for update;
  if b.id is null or b.current_version_id is null then return; end if;
  update public.agent_jobs set status = 'cancelled', updated_at = now()
   where payload->>'block_id' = p_block::text and status in ('queued', 'waiting_quota', 'failed')
     and step in ('review', 'review_panel', 'consolidate', 'revise');
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'revision_requested' where id = p_block;
  perform set_config('app.via_commit', 'off', true);
  perform app.enqueue(b.book_id, 'paragraph', 'revise', 'lead_writer', p_priority,
    jsonb_build_object('block_id', p_block, 'loop', 0, 'author_note', p_instruction, 'note_id', p_note, 'feedback', true));
end $$;

-- a paragraph note is done once its paragraph is approved again
create or replace function app.close_notes_on_approval() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'author_approved' and old.status is distinct from 'author_approved' then
    update public.author_notes set status = 'applied' where block_id = new.id and scope = 'paragraph' and status = 'open';
  end if;
  return new;
end $$;
drop trigger if exists close_notes_on_approval on public.manuscript_blocks;
create trigger close_notes_on_approval after update of status on public.manuscript_blocks
  for each row execute function app.close_notes_on_approval();

-- autopilot counts revisions since the paragraph was last reopened, not since it was first written
create or replace function app.versions_since_reopen(p_block uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.block_versions v
   where v.block_id = p_block
     and v.created_at >= coalesce((select max(n.created_at) from public.author_notes n where n.block_id = p_block), '-infinity')
$$;

create or replace function app.autopilot_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare bk record; blk record; v_score int; v_ver int; v_pending boolean; v_instr text; acted jsonb := '[]';
begin
  for bk in select id, autopilot_threshold from public.books where autopilot and status in ('planning','writing') loop
    update public.agent_jobs set status = 'queued', attempts = 0, run_after = now(), locked_by = null, updated_at = now()
     where book_id = bk.id and status = 'failed' and updated_at < now() - interval '10 minutes';
    -- feedback being planned: wait for the Chief Editor's plan
    if exists (select 1 from public.agent_jobs where book_id = bk.id and step = 'plan' and workflow = 'feedback'
                and status in ('queued','running','waiting_quota')) then continue; end if;

    select m.id, m.current_version_id into blk from public.manuscript_blocks m
     where m.book_id = bk.id and m.status = 'qc_passed' order by m.order_key limit 1;
    if found then
      select (j.result->>'score')::int into v_score from public.agent_jobs j
       where j.book_id = bk.id and j.step = 'consolidate' and j.status = 'done'
         and j.payload->>'block_version_id' = blk.current_version_id::text
       order by j.updated_at desc limit 1;
      v_ver := app.versions_since_reopen(blk.id);
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

    if exists (select 1 from public.manuscript_blocks where book_id = bk.id
                and status in ('planned','drafted','in_review','revision_requested')) then continue; end if;
    if exists (select 1 from public.agent_jobs where book_id = bk.id and status in ('queued','running','waiting_quota')) then continue; end if;
    if not exists (select 1 from public.book_constitutions where book_id = bk.id and status = 'approved') then continue; end if;
    if not exists (select 1 from public.outline_units where book_id = bk.id and level = 'chapter' and target_words is not null) then
      if not exists (select 1 from public.agent_jobs where book_id = bk.id and step = 'plan' and workflow = 'outline' and status <> 'failed'
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

revoke all on function app.reopen_for_feedback(uuid, text, uuid, int) from public, anon, authenticated;
grant execute on function app.add_author_note(uuid, uuid, text, text) to authenticated;
grant execute on function app.request_revision(uuid, text) to authenticated;

-- Use every text model the main project offers (each has its own daily allowance in the same project).
-- Order: the steadiest first; the newer Flash models next; the lighter models last.
update public.model_registry set fallbacks = '[
  {"model_id":"gemini-3.5-flash","in":0.5,"out":3},
  {"model_id":"gemini-3.6-flash","in":0.75,"out":3.75},
  {"model_id":"gemini-3.7-flash","in":0.75,"out":3.75},
  {"model_id":"gemini-3.8-flash","in":0.75,"out":3.75},
  {"model_id":"gemini-3-flash-preview","in":0.5,"out":3},
  {"model_id":"gemini-flash-latest","in":0.5,"out":3},
  {"model_id":"gemini-3.5-flash-lite","in":0.3,"out":2.5},
  {"model_id":"gemini-2.5-flash-lite","in":0.1,"out":0.4}]'::jsonb
 where tier in ('standard', 'deep');
update public.model_registry set fallbacks = '[
  {"model_id":"gemini-3.5-flash-lite","in":0.3,"out":2.5},
  {"model_id":"gemini-2.5-flash-lite","in":0.1,"out":0.4},
  {"model_id":"gemini-flash-lite-latest","in":0.1,"out":0.4},
  {"model_id":"gemini-3.1-flash-lite-preview","in":0.25,"out":1.5}]'::jsonb
 where tier = 'fast';

-- Review panel: the five reviewers assess in one combined call (5 requests -> 1 per paragraph version).
insert into app.settings(key, value) values ('review_mode', 'panel')
on conflict (key) do update set value = excluded.value;

-- Work parked until tomorrow because backup models were busy (not used up) can start again now.
update public.agent_jobs set run_after = now(), updated_at = now()
 where status = 'waiting_quota' and last_error like 'Gemini daily free limits reached for every model%';
