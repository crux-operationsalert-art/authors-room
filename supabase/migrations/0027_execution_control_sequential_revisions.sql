-- Part J: pause / resume / cancel and priority per book.
-- Part G: sequential revision engine. Dependent rewrites run top to bottom, one paragraph at a time.
-- Loop fix: the whole-book re-read is triggered only by NEW paragraphs, never by re-approved reworks.

-- 1. Execution control -------------------------------------------------------------------------------------------
alter table public.books add column if not exists run_state text not null default 'running';
alter table public.books drop constraint if exists books_run_state_chk;
alter table public.books add constraint books_run_state_chk check (run_state in ('running', 'paused', 'cancelled'));
alter table public.books add column if not exists priority text not null default 'normal';
alter table public.books drop constraint if exists books_priority_chk;
alter table public.books add constraint books_priority_chk check (priority in ('urgent', 'high', 'normal', 'low'));
alter table public.books add column if not exists paused_at timestamptz;
alter table public.books add column if not exists paused_reason text;

create or replace function app.priority_weight(p text) returns int language sql immutable as $$
  select case p when 'urgent' then 30 when 'high' then 15 when 'low' then -15 else 0 end $$;

-- Jobs of paused or cancelled books are never started; the rest are ordered by job priority + book priority,
-- with ageing (up to +20 after 200 minutes of waiting) so a low-priority book is never starved.
create or replace function app.claim_next_job(p_worker text) returns setof public.agent_jobs
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.agent_jobs set status = 'queued', locked_by = null, updated_at = now(),
         last_error = coalesce(last_error, '') || ' [recovered after worker timeout]'
   where status = 'running' and locked_at < now() - interval '4 minutes';
  return query
  update public.agent_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_at = now(), updated_at = now()
   where j.id = (
     select q.id from public.agent_jobs q left join public.books b on b.id = q.book_id
      where q.status in ('queued', 'waiting_quota') and q.run_after <= now()
        and (b.id is null or b.run_state = 'running')
      order by q.priority + app.priority_weight(coalesce(b.priority, 'normal'))
               + least(20, extract(epoch from now() - q.created_at) / 600) desc, q.created_at
      for update of q skip locked
      limit 1)
  returning j.*;
end $$;

create or replace function app.kick_worker() returns boolean
language plpgsql security definer set search_path to 'public', 'vault' as $$
declare v_running int; v_ready int;
begin
  select count(*) into v_running from public.agent_jobs where status = 'running';
  select count(*) into v_ready from public.agent_jobs j left join public.books b on b.id = j.book_id
   where j.status in ('queued', 'waiting_quota') and j.run_after <= now() and (b.id is null or b.run_state = 'running');
  if v_ready = 0 or v_running >= 3 then return false; end if;
  perform net.http_post(url := (select value from app.settings where key = 'worker_url'),
    body := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-token',
               (select decrypted_secret from vault.decrypted_secrets where name = 'worker_token')),
    timeout_milliseconds := 150000);
  return true;
end $$;

-- Pause keeps every queued job in place (nothing is lost or duplicated on resume); a call already running finishes.
create or replace function app.set_book_state(p_book uuid, p_state text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (app.owns_book(p_book) or auth.role() = 'service_role') then raise exception 'not your book' using errcode = '42501'; end if;
  if p_state not in ('running', 'paused', 'cancelled') then raise exception 'unknown state %', p_state; end if;
  update public.books set run_state = p_state,
         paused_at = case when p_state = 'running' then null else now() end,
         paused_reason = case when p_state = 'running' then null else p_reason end
   where id = p_book;
  insert into public.intake_messages(book_id, role, content) values (p_book, 'system',
    case p_state when 'paused' then 'Book paused: no new work starts until you resume.' || coalesce(' Reason: ' || p_reason, '')
                 when 'cancelled' then 'Book work cancelled. The manuscript and its history are kept.'
                 else 'Book resumed: the team continues from where it stopped.' end);
  if p_state = 'running' then perform app.kick_worker(); end if;
end $$;
grant execute on function app.set_book_state(uuid, text, text) to authenticated, service_role;

create or replace function app.set_book_priority(p_book uuid, p_priority text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  update public.books set priority = p_priority where id = p_book;
end $$;
grant execute on function app.set_book_priority(uuid, text) to authenticated;

-- Autopilot ignores paused or cancelled books.
do $$
declare d text := pg_get_functiondef('app.autopilot_tick()'::regprocedure);
begin
  if position('run_state' in d) = 0 then
    d := replace(d, 'where autopilot and status in (''planning'',''writing'') loop',
                    'where autopilot and status in (''planning'',''writing'') and run_state = ''running'' loop');
    execute d;
  end if;
end $$;

-- 2. Sequential revision engine ---------------------------------------------------------------------------------
create table if not exists public.revision_plans (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.books(id) on delete cascade,
  note_id     uuid,                                   -- the author note or audit note that caused it
  source      text not null default 'feedback',       -- feedback | audit | recovery
  status      text not null default 'active' check (status in ('active', 'done', 'cancelled')),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists public.revision_plan_items (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.revision_plans(id) on delete cascade,
  block_id    uuid not null references public.manuscript_blocks(id) on delete cascade,
  instruction text not null,
  priority    int not null default 92,
  status      text not null default 'pending' check (status in ('pending', 'active', 'done', 'skipped')),
  started_at  timestamptz,
  finished_at timestamptz,
  unique (plan_id, block_id)
);
create index if not exists revision_plans_book on public.revision_plans(book_id, status);
alter table public.revision_plans enable row level security;
alter table public.revision_plan_items enable row level security;
drop policy if exists revision_plans_owner on public.revision_plans;
create policy revision_plans_owner on public.revision_plans for select using (app.owns_book(book_id));
drop policy if exists revision_plan_items_owner on public.revision_plan_items;
create policy revision_plan_items_owner on public.revision_plan_items for select
  using (exists (select 1 from public.revision_plans p where p.id = plan_id and app.owns_book(p.book_id)));
grant select on public.revision_plans, public.revision_plan_items to authenticated;
grant all on public.revision_plans, public.revision_plan_items to service_role;

-- The old immediate reopen, now used only by the engine for one paragraph at a time.
create or replace function app.reopen_block_now(p_block uuid, p_instruction text, p_note uuid, p_priority integer default 92)
returns void language plpgsql security definer set search_path to 'public' as $$
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
revoke all on function app.reopen_block_now(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function app.reopen_block_now(uuid, text, uuid, integer) to service_role;

-- Moves a book's revision plans on: the active paragraph must be finished (approved) before the next one opens.
create or replace function app.advance_revisions(p_book uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it record; nxt record; v_status text;
begin
  -- finish the active item once its paragraph is approved again (or has disappeared)
  for it in select i.id, i.block_id from public.revision_plan_items i join public.revision_plans p on p.id = i.plan_id
             where p.book_id = p_book and p.status = 'active' and i.status = 'active' loop
    select status into v_status from public.manuscript_blocks where id = it.block_id;
    if v_status is null or v_status in ('author_approved', 'cut') then
      update public.revision_plan_items set status = case when v_status = 'cut' then 'skipped' else 'done' end, finished_at = now() where id = it.id;
    else
      return jsonb_build_object('waiting_on', it.block_id);
    end if;
  end loop;
  -- next pending paragraph: oldest plan first, then reading order
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
grant execute on function app.advance_revisions(uuid) to service_role;

-- Every caller that used to reopen a paragraph at once (author feedback, the reader re-read) now adds it to the
-- book's revision plan for that note; the engine opens one paragraph at a time, top to bottom.
create or replace function app.reopen_for_feedback(p_block uuid, p_instruction text, p_note uuid, p_priority integer default 92)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_book uuid; v_plan uuid;
begin
  select book_id into v_book from public.manuscript_blocks where id = p_block;
  if v_book is null then return; end if;
  select id into v_plan from public.revision_plans
   where book_id = v_book and status = 'active' and note_id is not distinct from p_note order by created_at desc limit 1;
  if v_plan is null then
    insert into public.revision_plans(book_id, note_id, source) values (v_book, p_note, 'feedback') returning id into v_plan;
  end if;
  insert into public.revision_plan_items(plan_id, block_id, instruction, priority) values (v_plan, p_block, p_instruction, p_priority)
  on conflict (plan_id, block_id) do update set instruction = excluded.instruction, status = 'pending';
  perform app.advance_revisions(v_book);
end $$;

-- Autopilot also drives the revision engine, and does not start new paragraphs while a revision plan is open.
create or replace function app.autopilot_tick_safe() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r record; acted jsonb;
begin
  if not pg_try_advisory_xact_lock(724911) then return '[]'::jsonb; end if;
  for r in select distinct p.book_id from public.revision_plans p join public.books b on b.id = p.book_id
            where p.status = 'active' and b.run_state = 'running' loop
    perform app.advance_revisions(r.book_id);
  end loop;
  acted := app.autopilot_tick();
  return acted;
end $$;

create or replace function app.revision_open(p_book uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.revision_plans p join public.revision_plan_items i on i.plan_id = p.id
                  where p.book_id = p_book and p.status = 'active' and i.status in ('pending', 'active')) $$;

do $$
declare d text := pg_get_functiondef('app.start_next_paragraph(uuid,text)'::regprocedure);
begin
  if position('revision_open' in d) = 0 then
    d := replace(d, 'begin
  if exists (select 1 from public.manuscript_blocks where book_id = p_book',
                    'begin
  if app.revision_open(p_book) then return null; end if;   -- finish open revisions (top to bottom) before writing on
  if exists (select 1 from public.manuscript_blocks where book_id = p_book');
    execute d;
  end if;
end $$;

-- 3. Loop fix: re-read only after 10 NEW paragraphs (first approval), never while a revision plan is open --------
create or replace function app.maybe_emotion_audit() returns int
language plpgsql security definer set search_path = public as $$
declare bk record; v_last timestamptz; v_new int; v_total int; n int := 0;
begin
  for bk in select id from public.books where status in ('planning', 'writing') and run_state = 'running' loop
    if app.revision_open(bk.id) then continue; end if;
    if exists (select 1 from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit'
                and status in ('queued', 'running', 'waiting_quota')) then continue; end if;
    select max(created_at) into v_last from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit' and status = 'done';
    select count(*) into v_total from public.manuscript_blocks where book_id = bk.id and status = 'author_approved';
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
