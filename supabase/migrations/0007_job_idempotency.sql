create unique index agent_jobs_one_consolidation on public.agent_jobs ((payload->>'block_version_id'))
  where workflow = 'paragraph' and step = 'consolidate';
create unique index agent_jobs_one_review_per_role on public.agent_jobs ((payload->>'block_version_id'), role_code)
  where workflow = 'paragraph' and step = 'review';
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
