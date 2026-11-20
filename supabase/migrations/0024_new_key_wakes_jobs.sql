-- A new key (or a group switched back on) means new allowance: jobs parked for quota start again at once.
create or replace function app.wake_parked_jobs() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.agent_jobs set run_after = now(), updated_at = now()
   where status = 'waiting_quota' and run_after > now();
  get diagnostics n = row_count;
  begin perform app.kick_worker(); exception when others then null; end;   -- the 1-minute schedule is the fallback
  return n;
end $$;
revoke all on function app.wake_parked_jobs() from public, anon, authenticated;
grant execute on function app.wake_parked_jobs() to service_role;

create or replace function app.clear_group_rest_on_new_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.provider <> 'gemini' then delete from public.model_rest where model_id = new.provider || ':*'; end if;
  if new.status = 'active' then perform app.wake_parked_jobs(); end if;
  return new;
end $$;

create or replace function app.wake_on_key_enabled() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then perform app.wake_parked_jobs(); end if;
  return new;
end $$;
drop trigger if exists wake_on_key_enabled on public.ai_keys;
create trigger wake_on_key_enabled after update of status on public.ai_keys for each row execute function app.wake_on_key_enabled();
