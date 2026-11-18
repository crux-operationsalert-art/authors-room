-- 0005_book_intelligence.sql — P1/P2: constitution, intake conversation,
-- decisions, Book Bible (entities + canon facts), voice profile, reviews,
-- editorial issues, and the author's actions for the first working flow.

create table public.book_constitutions (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books(id),
  version       int  not null default 1,
  original_idea text not null,                 -- verbatim, never edited
  brief         jsonb not null default '{}'::jsonb,   -- interviewer's working fields
  missing       text[] not null default '{}',
  premise text, genre text, subgenre text, audience text, themes text[], pov text, tense text,
  voice text, ending_intent text, length_target text, never_change text[],
  status        text not null default 'draft' check (status in ('draft','proposed','approved','superseded')),
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (book_id, version)
);

create table public.intake_messages (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books(id),
  role       text not null check (role in ('author','assistant','system')),
  content    text not null,
  created_at timestamptz not null default now()
);

create table public.decisions (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references public.books(id),
  type           text not null,                 -- genre_direction, consolidation, change_request, disagreement
  subject_ref    text,
  question       text not null,
  options        jsonb not null default '[]'::jsonb,
  recommendation text,
  status         text not null default 'pending' check (status in ('pending','decided','withdrawn')),
  outcome        jsonb,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);

create table public.author_voice_profiles (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books(id) unique,
  traits     jsonb not null default '{}'::jsonb,
  banned_phrases text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.entities (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books(id),
  type       text not null check (type in ('character','location','object','organisation','concept','rule','theme')),
  name       text not null,
  aliases    text[] not null default '{}',
  profile    jsonb not null default '{}'::jsonb,
  status     text not null default 'proposed' check (status in ('proposed','canon','retired')),
  created_at timestamptz not null default now(),
  unique (book_id, type, name)
);

create table public.canon_facts (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books(id),
  entity_id  uuid references public.entities(id),
  statement  text not null,
  fact_type  text not null default 'general',
  source_block_version_id uuid references public.block_versions(id),
  status     text not null default 'proposed' check (status in ('proposed','canon','retired')),
  created_at timestamptz not null default now()
);

create table public.review_runs (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references public.books(id),
  block_version_id uuid references public.block_versions(id),
  layer            int  not null check (layer in (1,2,3)),
  role_code        text not null references public.agent_roles(code),
  score            int,
  summary          text,
  result           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (block_version_id, role_code)
);

create table public.editorial_issues (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references public.books(id),
  block_id         uuid references public.manuscript_blocks(id),
  block_version_id uuid references public.block_versions(id),
  raised_by        text not null references public.agent_roles(code),
  severity         text not null check (severity in ('critical','major','moderate','minor')),
  category         text not null,
  issue            text not null,
  evidence         text,
  suggested_fix    text,
  status           text not null default 'open' check (status in ('open','accepted','rejected','resolved','deferred')),
  created_at       timestamptz not null default now()
);

-- RLS: the author reads everything of their books; writes go through functions or the worker.
do $$ declare t text; begin
  foreach t in array array['book_constitutions','intake_messages','decisions','author_voice_profiles',
                           'entities','canon_facts','review_runs','editorial_issues'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (app.owns_book(book_id))', t || '_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- author actions
-- First signed-in user becomes the author (single-author v1). Later users cannot.
create or replace function app.claim_author(p_display_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select id into v from public.authors where auth_user_id = auth.uid();
  if v is not null then return v; end if;
  if exists (select 1 from public.authors) then
    raise exception 'this Author''s Room already has an author' using errcode = '42501';
  end if;
  insert into public.authors(auth_user_id, display_name) values (auth.uid(), coalesce(nullif(p_display_name,''),'Author'))
  returning id into v;
  return v;
end $$;

create or replace function app.enqueue(p_book uuid, p_workflow text, p_step text, p_role text,
                                       p_priority int, p_payload jsonb default '{}'::jsonb)
returns uuid language sql security definer set search_path = public as $$
  insert into public.agent_jobs(book_id, workflow, step, role_code, priority, payload)
  values (p_book, p_workflow, p_step, p_role, p_priority, p_payload) returning id
$$;

create or replace function app.create_book(p_title text, p_idea text, p_kind text default 'fiction',
                                           p_privacy text default 'standard')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_author uuid := app.current_author_id(); v_book uuid;
begin
  if v_author is null then raise exception 'not an author' using errcode = '42501'; end if;
  if length(coalesce(p_idea,'')) < 10 then raise exception 'tell me a little more about your idea'; end if;
  insert into public.books(author_id, working_title, kind, privacy_mode)
  values (v_author, coalesce(nullif(p_title,''),'Untitled book'), p_kind, p_privacy) returning id into v_book;
  insert into public.book_constitutions(book_id, original_idea) values (v_book, p_idea);
  insert into public.intake_messages(book_id, role, content) values (v_book, 'author', p_idea);
  perform app.enqueue(v_book, 'intake', 'interview', 'author_interviewer', 95);
  return v_book;
end $$;

create or replace function app.send_intake_message(p_book uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  insert into public.intake_messages(book_id, role, content) values (p_book, 'author', p_text);
  -- one interview job at a time per book
  if not exists (select 1 from public.agent_jobs where book_id = p_book and workflow = 'intake'
                  and status in ('queued','running','waiting_quota')) then
    perform app.enqueue(p_book, 'intake', 'interview', 'author_interviewer', 95);
  end if;
end $$;

create or replace function app.decide(p_decision uuid, p_choice jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.decisions%rowtype;
begin
  select * into d from public.decisions where id = p_decision for update;
  if not app.owns_book(d.book_id) then raise exception 'not your book' using errcode = '42501'; end if;
  if d.status <> 'pending' then raise exception 'already decided'; end if;
  update public.decisions set status = 'decided', outcome = p_choice, decided_at = now() where id = p_decision;
  if d.type = 'genre_direction' then
    insert into public.intake_messages(book_id, role, content)
    values (d.book_id, 'author', 'I choose: ' || coalesce(p_choice->>'title', p_choice::text));
    perform app.enqueue(d.book_id, 'constitution', 'draft', 'chief_editor', 90, jsonb_build_object('decision_id', p_decision));
  end if;
end $$;

create or replace function app.approve_constitution(p_book uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.book_constitutions%rowtype;
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  select * into c from public.book_constitutions where book_id = p_book order by version desc limit 1 for update;
  if c.status <> 'proposed' then raise exception 'no proposed constitution to approve'; end if;
  update public.book_constitutions set status = 'approved', approved_at = now() where id = c.id;
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id)
  values (p_book, 'constitution', c.id, 'approved', app.current_author_id());
  update public.books set status = 'planning' where id = p_book;
  perform app.enqueue(p_book, 'bible', 'seed', 'story_architect', 85);
end $$;

-- Ask the Writer's Room for the next paragraph of chapter 1, scene 1 (P2 demo scope).
create or replace function app.request_next_paragraph(p_book uuid, p_guidance text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ch uuid; v_sc uuid; v_block uuid; v_n int;
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  if not exists (select 1 from public.book_constitutions where book_id = p_book and status = 'approved') then
    raise exception 'approve the book constitution first';
  end if;
  if exists (select 1 from public.manuscript_blocks where book_id = p_book
              and status in ('planned','drafted','in_review','revision_requested')) then
    raise exception 'the team is still working on the current paragraph';
  end if;
  select id into v_ch from public.outline_units where book_id = p_book and level = 'chapter' order by order_key limit 1;
  if v_ch is null then
    insert into public.outline_units(book_id, level, order_key, title, purpose)
    values (p_book, 'chapter', 'a0', 'Chapter 1', 'Opening chapter') returning id into v_ch;
    insert into public.outline_units(book_id, parent_id, level, order_key, title, purpose)
    values (p_book, v_ch, 'scene', 'a0', 'Opening scene', 'Hook the reader and establish voice') returning id into v_sc;
  else
    select id into v_sc from public.outline_units where parent_id = v_ch and level = 'scene' order by order_key limit 1;
  end if;
  select count(*) into v_n from public.manuscript_blocks where book_id = p_book;
  insert into public.manuscript_blocks(book_id, unit_id, order_key)
  values (p_book, v_sc, lpad(v_n::text, 6, '0')) returning id into v_block;
  update public.books set status = 'writing' where id = p_book and status = 'planning';
  perform app.enqueue(p_book, 'paragraph', 'draft', 'lead_writer', 90,
                      jsonb_build_object('block_id', v_block, 'guidance', p_guidance));
  return v_block;
end $$;

-- Author decides on an issue the team could not resolve, or on the paragraph itself.
create or replace function app.set_issue_status(p_issue uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.owns_book((select book_id from public.editorial_issues where id = p_issue)) then
    raise exception 'not your book' using errcode = '42501';
  end if;
  update public.editorial_issues set status = p_status where id = p_issue;
end $$;

-- Author asks for a revision of the current paragraph with their own note.
create or replace function app.request_revision(p_block uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype;
begin
  select * into b from public.manuscript_blocks where id = p_block;
  if not app.owns_book(b.book_id) then raise exception 'not your book' using errcode = '42501'; end if;
  if b.status = 'author_approved' then raise exception 'approved text is locked; use a change request'; end if;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'revision_requested' where id = p_block;
  perform set_config('app.via_commit', 'off', true);
  perform app.enqueue(b.book_id, 'paragraph', 'revise', 'lead_writer', 92,
                      jsonb_build_object('block_id', p_block, 'author_note', p_note, 'loop', 0));
end $$;

revoke all on function app.enqueue(uuid,text,text,text,int,jsonb) from public, anon, authenticated;
grant execute on function app.enqueue(uuid,text,text,text,int,jsonb) to service_role;
revoke all on function app.claim_author(text), app.create_book(text,text,text,text), app.send_intake_message(uuid,text),
  app.decide(uuid,jsonb), app.approve_constitution(uuid), app.request_next_paragraph(uuid,text),
  app.set_issue_status(uuid,text), app.request_revision(uuid,text) from public, anon;
grant execute on function app.claim_author(text), app.create_book(text,text,text,text), app.send_intake_message(uuid,text),
  app.decide(uuid,jsonb), app.approve_constitution(uuid), app.request_next_paragraph(uuid,text),
  app.set_issue_status(uuid,text), app.request_revision(uuid,text) to authenticated;

-- Live updates in the app
alter publication supabase_realtime add table public.intake_messages, public.decisions,
  public.manuscript_blocks, public.editorial_issues, public.agent_jobs, public.book_constitutions;
