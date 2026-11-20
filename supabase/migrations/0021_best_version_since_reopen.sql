-- After a paragraph is reopened by a note (the author's or the reader-emotion audit), only versions written since then
-- count as "best": an older, higher-scoring version that ignores the note must never be restored.
create or replace function app.best_version(p_block uuid)
returns table(version_id uuid, version_no integer, score integer, instructions text)
language sql stable security definer set search_path to 'public' as $$
  select v.id, v.version_no, (j.result->>'score')::int, j.result->>'instructions'
    from public.block_versions v
    join public.agent_jobs j on j.step = 'consolidate' and j.status = 'done' and j.payload->>'block_version_id' = v.id::text
   where v.block_id = p_block and j.result ? 'score'
     and v.created_at >= coalesce((select max(n.created_at) from public.author_notes n where n.block_id = p_block), '-infinity')
   order by (j.result->>'score')::int desc, v.version_no desc
   limit 1
$$;
