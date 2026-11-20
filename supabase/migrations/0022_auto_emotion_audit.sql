-- Re-run the whole-book reader-emotion audit automatically: first after 3 approved paragraphs, then after every
-- 10 newly approved paragraphs, so drift in feeling is caught across the arc, not just paragraph by paragraph.
create or replace function app.maybe_emotion_audit() returns int
language plpgsql security definer set search_path = public as $$
declare bk record; v_last timestamptz; v_new int; v_total int; n int := 0;
begin
  for bk in select id from public.books where status in ('planning', 'writing') loop
    if exists (select 1 from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit'
                and status in ('queued', 'running', 'waiting_quota')) then continue; end if;
    select max(created_at) into v_last from public.agent_jobs where book_id = bk.id and workflow = 'emotion' and step = 'audit' and status = 'done';
    select count(*) into v_total from public.manuscript_blocks where book_id = bk.id and status = 'author_approved';
    select count(distinct a.subject_id) into v_new from public.approvals a
     where a.book_id = bk.id and a.subject_type = 'block' and a.decision = 'approved'
       and a.created_at > coalesce(v_last, '-infinity');
    if (v_last is null and v_total >= 3) or (v_last is not null and v_new >= 10) then
      perform app.enqueue(bk.id, 'emotion', 'audit', 'reader_panel_manager', 96, '{}'::jsonb);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function app.maybe_emotion_audit() from public, anon, authenticated;
grant execute on function app.maybe_emotion_audit() to service_role;
