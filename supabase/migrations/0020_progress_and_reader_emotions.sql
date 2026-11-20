-- Progress + estimated time of completion, and the reader-emotion layer (how readers FEEL after each paragraph,
-- compared with how this kind of book is meant to make them feel).

-- 1. The book's intended reader experience (generated once from the constitution; shown as the meter's scale).
alter table public.books add column if not exists emotion_profile jsonb;

-- 2. One emotion reading per paragraph version (from the review panel or a whole-book audit).
create table if not exists public.reader_emotions (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references public.books(id) on delete cascade,
  block_id         uuid not null references public.manuscript_blocks(id) on delete cascade,
  block_version_id uuid not null references public.block_versions(id) on delete cascade,
  source           text not null check (source in ('panel', 'audit')),
  felt             jsonb not null default '[]',      -- [{emotion, intensity 0-100}]
  match            int check (match between 0 and 100), -- how close the felt emotions are to the intended ones
  drift            text,                              -- what is off, in plain words
  fix              text,                              -- what would bring it back
  created_at       timestamptz not null default now(),
  unique (block_version_id, source)
);
alter table public.reader_emotions enable row level security;
drop policy if exists reader_emotions_owner on public.reader_emotions;
create policy reader_emotions_owner on public.reader_emotions for select using (app.owns_book(book_id));
grant select on public.reader_emotions to authenticated;
grant all on public.reader_emotions to service_role;
create index if not exists reader_emotions_book on public.reader_emotions(book_id, created_at);

-- 3. Progress and ETC: approved words against the chapter plan, at the pace of the last 48 hours of approvals.
create or replace function app.book_progress(p_book uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_target int; v_done int; v_paras int; v_first timestamptz; v_recent int; v_hours numeric; v_pace numeric; v_left int;
begin
  if not (app.owns_book(p_book) or auth.role() = 'service_role') then raise exception 'not your book' using errcode = '42501'; end if;
  select coalesce(sum(target_words), 0) into v_target from public.outline_units where book_id = p_book and level = 'chapter';
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0), count(*)
    into v_done, v_paras
    from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.book_id = p_book and m.status = 'author_approved';
  -- pace: words of paragraphs whose FIRST approval falls in the last 48 h, per hour of that window
  with firsts as (
    select a.subject_id, min(a.created_at) at from public.approvals a
     where a.book_id = p_book and a.subject_type = 'block' and a.decision = 'approved' group by a.subject_id)
  select min(f.at),
         coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1))
                  filter (where f.at > now() - interval '48 hours'), 0)
    into v_first, v_recent
    from firsts f join public.manuscript_blocks m on m.id = f.subject_id and m.status = 'author_approved'
    join public.block_versions v on v.id = m.current_version_id;
  v_hours := greatest(1, least(48, extract(epoch from now() - coalesce(v_first, now())) / 3600));
  v_pace := case when v_first is null then 0 else v_recent / v_hours end;
  v_left := greatest(0, v_target - v_done);
  return jsonb_build_object(
    'target_words', v_target, 'approved_words', v_done, 'approved_paragraphs', v_paras,
    'percent', case when v_target > 0 then round(100.0 * least(v_done, v_target) / v_target, 1) else null end,
    'words_per_hour', round(v_pace, 1),
    'words_left', v_left,
    'hours_left', case when v_pace > 0 then round(v_left / v_pace, 1) else null end,
    'eta', case when v_pace > 0 and v_left > 0 then now() + make_interval(secs => (v_left / v_pace) * 3600) else null end);
end $$;
grant execute on function app.book_progress(uuid) to authenticated, service_role;

-- 4. The author can ask for a whole-book reader-emotion audit (the team reworks paragraphs that miss the mark).
create or replace function app.request_emotion_audit(p_book uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  if exists (select 1 from public.agent_jobs where book_id = p_book and workflow = 'emotion' and step = 'audit'
              and status in ('queued', 'running', 'waiting_quota')) then return; end if;
  perform app.enqueue(p_book, 'emotion', 'audit', 'reader_panel_manager', 98, '{}'::jsonb);
  insert into public.intake_messages(book_id, role, content)
  values (p_book, 'system', 'Reader-emotion audit requested: the team will read the whole manuscript as your readers would and rework paragraphs that miss the intended feeling.');
end $$;
grant execute on function app.request_emotion_audit(uuid) to authenticated;
