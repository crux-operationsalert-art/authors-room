-- 0050 (25 Nov) BUG FIX: "versions since reopen" and "best version" measured from the paragraph's last author note only.
-- Revision plans (continuity audit, reader-emotion audit, re-audits) create no note, so for them the cap counted the
-- paragraph's WHOLE history (e.g. 37 versions) and "best" was picked from old versions scored under the old, lenient
-- rubric. Autopilot then restored old text after a few tries: on 25 Nov, 20 of 26 Love.. Du paragraphs and 14 of 19
-- Untitled paragraphs ended back on pre-audit text. The reopen point is now the latest of: the last author note on the
-- paragraph, and the moment the current revision-plan item for it started.
create or replace function app.reopen_point(p_block uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select max(n.created_at) from public.author_notes n where n.block_id = p_block), '-infinity'),
    coalesce((select max(i.started_at) from public.revision_plan_items i where i.block_id = p_block), '-infinity'))
$$;

create or replace function app.versions_since_reopen(p_block uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.block_versions v
   where v.block_id = p_block and v.created_at >= app.reopen_point(p_block)
$$;

create or replace function app.best_version(p_block uuid)
returns table(version_id uuid, version_no integer, score integer, instructions text)
language sql stable security definer set search_path = public as $$
  select v.id, v.version_no, (j.result->>'score')::int, j.result->>'instructions'
    from public.block_versions v
    join public.agent_jobs j on j.step = 'consolidate' and j.status = 'done' and j.payload->>'block_version_id' = v.id::text
   where v.block_id = p_block and j.result ? 'score' and v.created_at >= app.reopen_point(p_block)
   order by (j.result->>'score')::int desc, v.version_no desc
   limit 1
$$;
