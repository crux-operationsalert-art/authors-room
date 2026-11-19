-- 0017: decisions.subject_ref is text; autopilot compared it with a uuid, which failed at run time and stopped
-- autopilot (it could not send a below-bar paragraph back for improvement). Cast the paragraph id to text.
do $$
declare d text;
begin
  d := pg_get_functiondef('app.autopilot_tick'::regproc);
  d := replace(d, 'subject_ref = blk.id', 'subject_ref = blk.id::text');
  execute d;
  d := pg_get_functiondef('app.autopilot_approve'::regproc);
  d := replace(d, 'subject_ref = p_block', 'subject_ref = p_block::text');
  execute d;
end $$;
