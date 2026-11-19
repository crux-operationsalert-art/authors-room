-- 0015: Autopilot keeps improving a paragraph until it scores above the author's bar.
-- * No more "accept the best of 4": a paragraph is approved only when its score is above the threshold.
-- * Each revision starts from the BEST version so far (a weaker revision is never built on).
-- * The writer gets the Chief Editor's own revision instructions plus every reviewer note on that best version.
-- * Every 4th unsuccessful attempt asks for a noticeably different approach, so it does not go round in circles.
-- * Fix: the worker may now run reopen_for_feedback (author notes were planned but paragraphs were not reopened).

grant execute on function app.reopen_for_feedback(uuid, text, uuid, int) to service_role;
grant execute on function app.autopilot_approve(uuid, text) to service_role;
grant execute on function app.start_next_paragraph(uuid, text) to service_role;

-- best-scoring version of a paragraph, with the Chief Editor's score and instructions
create or replace function app.best_version(p_block uuid)
returns table (version_id uuid, version_no int, score int, instructions text)
language sql stable security definer set search_path = public as $$
  select v.id, v.version_no, (j.result->>'score')::int, j.result->>'instructions'
    from public.block_versions v
    join public.agent_jobs j on j.step = 'consolidate' and j.status = 'done' and j.payload->>'block_version_id' = v.id::text
   where v.block_id = p_block and j.result ? 'score'
   order by (j.result->>'score')::int desc, v.version_no desc
   limit 1
$$;

create or replace function app.autopilot_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare bk record; blk record; best record; v_score int; v_ver int; v_instr text; v_extra text; acted jsonb := '[]';
begin
  for bk in select id, autopilot_threshold from public.books where autopilot and status in ('planning','writing') loop
    update public.agent_jobs set status = 'queued', attempts = 0, run_after = now(), locked_by = null, updated_at = now()
     where book_id = bk.id and status = 'failed' and updated_at < now() - interval '10 minutes';
    if exists (select 1 from public.agent_jobs where book_id = bk.id and step = 'plan' and workflow = 'feedback'
                and status in ('queued','running','waiting_quota')) then continue; end if;

    select m.id, m.current_version_id into blk from public.manuscript_blocks m
     where m.book_id = bk.id and m.status = 'qc_passed' order by m.order_key limit 1;
    if found then
      select (j.result->>'score')::int into v_score from public.agent_jobs j
       where j.book_id = bk.id and j.step = 'consolidate' and j.status = 'done'
         and j.payload->>'block_version_id' = blk.current_version_id::text
       order by j.updated_at desc limit 1;
      if v_score is null then continue; end if;          -- review still to come; the watchdog restarts it if lost

      if v_score > bk.autopilot_threshold then
        perform app.autopilot_approve(blk.id, null);
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'approved', 'score', v_score);
        continue;
      end if;
      if exists (select 1 from public.agent_jobs where payload->>'block_id' = blk.id::text and step = 'revise'
                 and status in ('queued','running','waiting_quota')) then continue; end if;

      -- below the bar: improve again, starting from the best version so far
      update public.decisions set status = 'withdrawn'
       where book_id = bk.id and type = 'consolidation' and subject_ref = blk.id and status = 'pending';
      select * into best from app.best_version(blk.id);
      v_ver := app.versions_since_reopen(blk.id);
      select string_agg(format('- [%s, %s] %s Fix: %s', i.raised_by, i.severity, i.issue, coalesce(i.suggested_fix, '')), E'\n'
                        order by case i.severity when 'critical' then 1 when 'major' then 2 when 'moderate' then 3 else 4 end)
        into v_instr from public.editorial_issues i where i.block_version_id = best.version_id;
      v_extra := case when v_ver > 0 and v_ver % 4 = 0
        then E'\nSeveral revisions have not reached the bar: take a noticeably different approach to the flagged sentences '
             'while keeping the content, the voice and the author''s directions.' else '' end;
      perform set_config('app.via_commit', 'on', true);
      update public.manuscript_blocks set status = 'revision_requested' where id = blk.id;
      perform set_config('app.via_commit', 'off', true);
      perform app.enqueue(bk.id, 'paragraph', 'revise', 'lead_writer', 90, jsonb_build_object(
        'block_id', blk.id, 'loop', 0, 'base_version_id', best.version_id,
        'instructions', format(E'The author''s bar is a score above %s out of 100. The best version so far (shown) scored %s; the latest scored %s.\n'
                               'Chief Editor''s instructions: %s\nResolve EVERY reviewer note below, including the minor ones:\n%s%s',
          bk.autopilot_threshold, best.score, v_score, coalesce(best.instructions, '(none given)'),
          coalesce(v_instr, '- tighten wording, sharpen voice and humour'), v_extra)));
      acted := acted || jsonb_build_object('book', bk.id, 'action', 'revise', 'score', v_score, 'best', best.score, 'attempt', v_ver + 1);
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

revoke all on function app.best_version(uuid) from public, anon, authenticated;
grant execute on function app.best_version(uuid) to service_role;
