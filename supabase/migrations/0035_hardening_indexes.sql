-- 0035: advisor fixes from the Phase 11 re-audit (applied live as pin_search_path and hot_path_indexes).
alter function app.priority_weight(text) set search_path = public;
alter function app.error_class(text, int, text) set search_path = public;
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'revision_open' loop
    execute format('alter function %s set search_path = public', f);
  end loop; end $$;
create index if not exists agent_runs_model_time on public.agent_runs (model_id, created_at desc);
create index if not exists agent_runs_book_time on public.agent_runs (book_id, created_at);
create index if not exists agent_runs_job on public.agent_runs (job_id);
create index if not exists agent_jobs_book_status on public.agent_jobs (book_id, status);
create index if not exists agent_jobs_block on public.agent_jobs ((payload->>'block_id'));
create index if not exists agent_jobs_version on public.agent_jobs ((payload->>'block_version_id'), step);
create index if not exists block_versions_book on public.block_versions (book_id);
create index if not exists manuscript_blocks_book_order on public.manuscript_blocks (book_id, order_key);
create index if not exists manuscript_blocks_current on public.manuscript_blocks (current_version_id);
create index if not exists manuscript_blocks_unit on public.manuscript_blocks (unit_id);
create index if not exists canon_facts_book on public.canon_facts (book_id, created_at);
create index if not exists canon_facts_source on public.canon_facts (source_block_version_id);
create index if not exists editorial_issues_version on public.editorial_issues (block_version_id);
create index if not exists editorial_issues_book on public.editorial_issues (book_id);
create index if not exists approvals_subject on public.approvals (subject_id);
create index if not exists approvals_book on public.approvals (book_id);
create index if not exists intake_messages_book on public.intake_messages (book_id, created_at);
create index if not exists outline_units_book on public.outline_units (book_id, order_key);
create index if not exists outline_units_parent on public.outline_units (parent_id);
create index if not exists author_notes_block on public.author_notes (block_id);
create index if not exists revision_plan_items_block on public.revision_plan_items (block_id);
create index if not exists books_author on public.books (author_id);
alter policy authors_self on public.authors using (auth_user_id = (select auth.uid()));
