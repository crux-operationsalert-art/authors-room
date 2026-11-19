-- 0018: Author's choice (19 Nov): keep the bar (above 97), but stop when stuck.
-- If the best score has not improved in 8 tries, keep the best version, flag it "review later" and move on,
-- so the book never stays on one paragraph forever.
do $$
declare d text;
begin
  d := pg_get_functiondef('app.autopilot_tick'::regproc);
  d := replace(d, $old$      v_ver := app.versions_since_reopen(blk.id);
$old$, $new$      v_ver := app.versions_since_reopen(blk.id);
      -- stuck: no better score in the last 8 tries -> keep the best version and move on (flagged for the author)
      if v_ver >= 8 and best.version_no <= (select max(version_no) from public.block_versions where block_id = blk.id) - 8 then
        if best.version_id is distinct from blk.current_version_id then
          perform app.commit_block_version(blk.id, (select text from public.block_versions where id = best.version_id),
            format('restored best version (v%s, score %s)', best.version_no, best.score), 'agent', 'ai_edited');
          perform set_config('app.via_commit', 'on', true);
          update public.manuscript_blocks set status = 'qc_passed' where id = blk.id;
          perform set_config('app.via_commit', 'off', true);
        end if;
        perform app.autopilot_approve(blk.id, format('Best score %s did not improve in the last 8 tries (%s versions); kept the best version (v%s). Your bar is above %s.',
          best.score, v_ver, best.version_no, bk.autopilot_threshold));
        acted := acted || jsonb_build_object('book', bk.id, 'action', 'accepted_plateau', 'best', best.score);
        continue;
      end if;
$new$);
  if position('accepted_plateau' in d) = 0 then raise exception 'plateau rule not inserted'; end if;
  execute d;
end $$;
