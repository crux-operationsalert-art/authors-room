-- 0030: recovery copies (Document 4, Phase 5: originals preserved, work on a branch) and clean fact memory.

alter table public.books add column if not exists branch_of uuid references public.books(id);
alter table public.books add column if not exists branch_label text;

-- Facts the team may rely on: the Book Bible's seeded canon, plus facts extracted from the CURRENT text of live paragraphs.
-- Facts from rejected or superseded drafts are ignored (they are kept, not deleted).
create or replace function app.book_facts(p_book uuid, p_limit int default 200)
returns table(statement text) language sql stable security definer set search_path to 'public' as $$
  select f.statement from public.canon_facts f
   where f.book_id = p_book and f.status <> 'retired'
     and (f.source_block_version_id is null
          or exists (select 1 from public.manuscript_blocks m where m.current_version_id = f.source_block_version_id and m.status <> 'cut'))
   order by f.created_at limit p_limit
$$;

-- Make a recovery copy: same author, constitution, voice, Bible and seeded facts; no manuscript text; chosen book-level notes.
-- The original is not modified.
create or replace function app.create_recovery_copy(p_book uuid, p_label text, p_skip_note_prefix text default '(Reader-emotion audit)')
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare b public.books%rowtype; v_new uuid; c public.book_constitutions%rowtype; e record; v_eid uuid;
begin
  if auth.uid() is not null and not app.owns_book(p_book) then
    raise exception 'not your book' using errcode = '42501';
  end if;
  select * into b from public.books where id = p_book;
  insert into public.books(author_id, working_title, kind, status, privacy_mode, autopilot, autopilot_threshold, emotion_profile,
                           run_state, priority, paused_at, paused_reason, direction_contract, branch_of, branch_label)
  values (b.author_id, b.working_title || ' — ' || p_label, b.kind, 'writing', b.privacy_mode, b.autopilot, b.autopilot_threshold,
          b.emotion_profile, 'paused', b.priority, now(), 'Recovery copy: waiting for its chapter plan', b.direction_contract, p_book, p_label)
  returning id into v_new;

  select * into c from public.book_constitutions where book_id = p_book order by version desc limit 1;
  insert into public.book_constitutions(book_id, version, original_idea, brief, missing, premise, genre, subgenre, audience, themes,
         pov, tense, voice, ending_intent, length_target, never_change, status, approved_at)
  values (v_new, 1, c.original_idea, c.brief, c.missing, c.premise, c.genre, c.subgenre, c.audience, c.themes,
          c.pov, c.tense, c.voice, c.ending_intent, c.length_target, c.never_change, c.status, c.approved_at);

  insert into public.author_voice_profiles(book_id, traits, banned_phrases, updated_at)
  select v_new, traits, banned_phrases, now() from public.author_voice_profiles where book_id = p_book;

  for e in select * from public.entities where book_id = p_book and status <> 'retired' loop
    insert into public.entities(book_id, type, name, profile, status) values (v_new, e.type, e.name, e.profile, e.status) returning id into v_eid;
    insert into public.canon_facts(book_id, entity_id, statement, status)
    select v_new, v_eid, statement, status from public.canon_facts
     where book_id = p_book and entity_id = e.id and source_block_version_id is null and status = 'canon';
  end loop;
  insert into public.canon_facts(book_id, statement, status)
  select v_new, statement, status from public.canon_facts
   where book_id = p_book and entity_id is null and source_block_version_id is null and status = 'canon';

  insert into public.author_notes(book_id, scope, note, status)
  select v_new, 'book', note, 'open' from public.author_notes
   where book_id = p_book and scope = 'book' and status = 'open' and note not like p_skip_note_prefix || '%'
   order by created_at;

  insert into public.intake_messages(book_id, role, content)
  values (v_new, 'system', 'Recovery copy of "' || b.working_title || '". The original book, its text, versions, notes and approvals are untouched.');
  return v_new;
end $$;

revoke all on function app.create_recovery_copy(uuid, text, text) from public, anon;
grant execute on function app.create_recovery_copy(uuid, text, text) to authenticated, service_role;
revoke all on function app.book_facts(uuid, int) from public, anon;
grant execute on function app.book_facts(uuid, int) to authenticated, service_role;
