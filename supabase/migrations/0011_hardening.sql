-- 0011_hardening.sql — fixes from the 19 Nov 2026 review.

-- 1) An author-approved block can never be moved to another status by the workflow.
create or replace function app.set_block_status(p_block_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status = 'author_approved' then
    raise exception 'use app.approve_block() for author approval';
  end if;
  if (select status from public.manuscript_blocks where id = p_block_id) = 'author_approved' then
    return;   -- approved text is final; late reviewer results must not reopen it
  end if;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = p_status where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
end $$;

-- 2) The author approves only what has finished review; pending review jobs for it are cancelled.
create or replace function app.approve_block(p_block_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare b public.manuscript_blocks%rowtype; v_id uuid;
begin
  select * into b from public.manuscript_blocks where id = p_block_id for update;
  if not app.owns_book(b.book_id) then
    raise exception 'only the book''s author can approve' using errcode = '42501';
  end if;
  if b.status = 'author_approved' then return null; end if;          -- double click: nothing to do
  if b.status <> 'qc_passed' then
    raise exception 'the team is still reviewing this paragraph; you can approve it once it has passed review';
  end if;
  insert into public.approvals(book_id, subject_type, subject_id, decision, author_id)
  values (b.book_id, 'block', p_block_id, 'approved', app.current_author_id()) returning id into v_id;
  perform set_config('app.via_commit', 'on', true);
  update public.manuscript_blocks set status = 'author_approved' where id = p_block_id;
  perform set_config('app.via_commit', 'off', true);
  update public.agent_jobs set status = 'cancelled', updated_at = now()
   where payload->>'block_id' = p_block_id::text and status in ('queued','waiting_quota')
     and step in ('review','consolidate','revise');
  return v_id;
end $$;

-- 3) Watchdog: restarts work that stalled without a visible failure. Runs every 5 minutes.
create or replace function app.watchdog() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_cons int := 0; n_rev int := 0; n_draft int := 0; n_bible int := 0; n_const int := 0; r record;
begin
  -- a) all reviews done but no consolidation queued
  for r in
    select b.id block_id, b.book_id, b.current_version_id v
      from manuscript_blocks b
     where b.status = 'in_review'
       and (select count(*) from review_runs rr where rr.block_version_id = b.current_version_id) >= 5
       and not exists (select 1 from agent_jobs j where j.step = 'consolidate' and j.payload->>'block_version_id' = b.current_version_id::text)
  loop
    insert into agent_jobs(book_id, workflow, step, role_code, priority, payload)
    values (r.book_id, 'paragraph', 'consolidate', 'chief_editor', 89,
            jsonb_build_object('block_id', r.block_id, 'block_version_id', r.v, 'loop', 0))
    on conflict do nothing;
    n_cons := n_cons + 1;
  end loop;

  -- b) in review, a reviewer job is missing and nothing is queued for the block
  for r in
    select b.id block_id, b.book_id, b.current_version_id v, ro.code role
      from manuscript_blocks b
      cross join (values ('voice_custodian'),('continuity_manager'),('logic_fact_checker'),('line_copy_editor'),('reader_panel_manager')) ro(code)
     where b.status = 'in_review' and b.current_version_id is not null
       and b.created_at < now() - interval '10 minutes'
       and not exists (select 1 from review_runs rr where rr.block_version_id = b.current_version_id and rr.role_code = ro.code)
       and not exists (select 1 from agent_jobs j where j.step = 'review' and j.role_code = ro.code
                         and j.payload->>'block_version_id' = b.current_version_id::text)
  loop
    insert into agent_jobs(book_id, workflow, step, role_code, priority, payload)
    values (r.book_id, 'paragraph', 'review', r.role, 88, jsonb_build_object('block_id', r.block_id, 'block_version_id', r.v, 'loop', 0))
    on conflict do nothing;
    n_rev := n_rev + 1;
  end loop;

  -- c) a paragraph slot with no text and no draft job in any state
  for r in
    select b.id block_id, b.book_id from manuscript_blocks b
     where b.status = 'planned' and b.created_at < now() - interval '10 minutes'
       and not exists (select 1 from agent_jobs j where j.payload->>'block_id' = b.id::text and j.status <> 'cancelled')
  loop
    perform app.enqueue(r.book_id, 'paragraph', 'draft', 'lead_writer', 90, jsonb_build_object('block_id', r.block_id));
    n_draft := n_draft + 1;
  end loop;

  -- d) constitution approved but the Book Bible never started
  for r in
    select c.book_id from book_constitutions c
     where c.status = 'approved' and c.approved_at < now() - interval '10 minutes'
       and not exists (select 1 from entities e where e.book_id = c.book_id)
       and not exists (select 1 from agent_jobs j where j.book_id = c.book_id and j.workflow = 'bible')
  loop
    perform app.enqueue(r.book_id, 'bible', 'seed', 'story_architect', 85);
    n_bible := n_bible + 1;
  end loop;

  -- e) direction chosen but no constitution job
  for r in
    select d.book_id, d.id from decisions d
     where d.type = 'genre_direction' and d.status = 'decided' and d.decided_at < now() - interval '10 minutes'
       and exists (select 1 from book_constitutions c where c.book_id = d.book_id and c.status = 'draft')
       and not exists (select 1 from agent_jobs j where j.book_id = d.book_id and j.workflow = 'constitution')
  loop
    perform app.enqueue(r.book_id, 'constitution', 'draft', 'chief_editor', 90, jsonb_build_object('decision_id', r.id));
    n_const := n_const + 1;
  end loop;

  return jsonb_build_object('consolidations', n_cons, 'reviews', n_rev, 'drafts', n_draft, 'bibles', n_bible, 'constitutions', n_const);
end $$;
revoke all on function app.watchdog() from public, anon, authenticated;

-- 4) Full backup of one book as JSON (author only). Used by the app's "Download backup" button.
create or replace function app.export_book(p_book uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  return jsonb_build_object(
    'exported_at', now(), 'format', 'authors-room-backup-v1',
    'book', (select to_jsonb(b) from books b where b.id = p_book),
    'constitutions', (select coalesce(jsonb_agg(to_jsonb(c) order by c.version), '[]') from book_constitutions c where c.book_id = p_book),
    'conversation', (select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at), '[]') from intake_messages m where m.book_id = p_book),
    'decisions', (select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]') from decisions d where d.book_id = p_book),
    'voice_profile', (select to_jsonb(v) from author_voice_profiles v where v.book_id = p_book),
    'entities', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from entities e where e.book_id = p_book),
    'canon_facts', (select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at), '[]') from canon_facts f where f.book_id = p_book),
    'outline', (select coalesce(jsonb_agg(to_jsonb(o) order by o.order_key), '[]') from outline_units o where o.book_id = p_book),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b) order by b.order_key), '[]') from manuscript_blocks b where b.book_id = p_book),
    'block_versions', (select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at), '[]') from block_versions v where v.book_id = p_book),
    'reviews', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]') from review_runs r where r.book_id = p_book),
    'issues', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]') from editorial_issues i where i.book_id = p_book),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]') from approvals a where a.book_id = p_book),
    'ai_use', (select coalesce(jsonb_agg(jsonb_build_object('role', role_code, 'model', model_id, 'status', status,
                 'tokens', input_tokens + output_tokens, 'at', created_at) order by created_at), '[]') from agent_runs r where r.book_id = p_book));
end $$;
revoke all on function app.export_book(uuid) from public, anon;
grant execute on function app.export_book(uuid) to authenticated;
