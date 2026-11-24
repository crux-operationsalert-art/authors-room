-- 0042: found by Part N §40 scenario S11c. Part J §33 requires priority ageing that never starves lower-priority
-- books. The old ageing bonus was capped at 20 points while high vs low priority differ by 30, so a low-priority
-- book could wait forever behind a busy high-priority book. Ageing is now 1 point per 6 minutes, capped at 120:
-- low-priority work overtakes fresh high-priority work after ~3 h, urgent stays ahead for ~4.5 h.
create or replace function app.claim_next_job(p_worker text)
returns setof public.agent_jobs language plpgsql security definer set search_path = public as $$
begin
  update public.agent_jobs set status = 'queued', locked_by = null, updated_at = now(),
         last_error = coalesce(last_error, '') || ' [recovered after worker timeout]'
   where status = 'running' and locked_at < now() - interval '4 minutes';
  return query
  update public.agent_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_at = now(), updated_at = now()
   where j.id = (
     select q.id from public.agent_jobs q left join public.books b on b.id = q.book_id
      where q.status in ('queued', 'waiting_quota') and q.run_after <= now()
        and (b.id is null or b.run_state = 'running')
      order by q.priority + app.priority_weight(coalesce(b.priority, 'normal'))
               + least(120, extract(epoch from now() - q.created_at) / 360) desc, q.created_at
      for update of q skip locked
      limit 1)
  returning j.*;
end $$;
