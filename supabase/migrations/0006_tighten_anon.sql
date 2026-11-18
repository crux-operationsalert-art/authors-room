revoke all on function app.approve_block(uuid), app.authorise_block_change(uuid,text), app.rollback_block(uuid,int,uuid),
  app.assign_team_key(text,uuid), app.set_key_status(uuid,text) from public, anon;
grant execute on function app.approve_block(uuid), app.authorise_block_change(uuid,text), app.rollback_block(uuid,int,uuid),
  app.assign_team_key(text,uuid), app.set_key_status(uuid,text) to authenticated, service_role;
revoke all on function app.audit(), app.forbid_change(), app.guard_block_pointer() from anon, authenticated;
revoke usage on schema app from anon;
