create or replace function app.retry_failed_jobs(p_book uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  update public.agent_jobs set status = 'queued', attempts = 0, run_after = now(), locked_by = null, updated_at = now()
   where book_id = p_book and status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.retry_failed_jobs(uuid) from public, anon;
grant execute on function app.retry_failed_jobs(uuid) to authenticated;
alter table public.agent_jobs alter column max_attempts set default 8;
