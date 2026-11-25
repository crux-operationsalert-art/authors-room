-- 0049 (25 Nov): AI-initiated revision plans (continuity audit, reader-emotion audit, re-audits) never reopen a paragraph
-- the author approved; those items are skipped. Plans from the author's own notes (source 'feedback') still may.
create or replace function app.advance_revisions(p_book uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it record; nxt record; v_status text;
begin
  update public.revision_plan_items i set status = 'skipped', finished_at = now()
    from public.revision_plans p, public.manuscript_blocks m
   where p.id = i.plan_id and m.id = i.block_id and p.book_id = p_book and p.status = 'active'
     and i.status = 'pending' and m.status = 'author_approved' and p.source <> 'feedback';
  for it in select i.id, i.block_id from public.revision_plan_items i join public.revision_plans p on p.id = i.plan_id
             where p.book_id = p_book and p.status = 'active' and i.status = 'active' loop
    select status into v_status from public.manuscript_blocks where id = it.block_id;
    if v_status is null or v_status in ('author_approved', 'ai_approved', 'cut') then
      update public.revision_plan_items set status = case when v_status = 'cut' then 'skipped' else 'done' end, finished_at = now() where id = it.id;
    else
      return jsonb_build_object('waiting_on', it.block_id);
    end if;
  end loop;
  select i.*, p.note_id into nxt from public.revision_plan_items i
    join public.revision_plans p on p.id = i.plan_id join public.manuscript_blocks m on m.id = i.block_id
   where p.book_id = p_book and p.status = 'active' and i.status = 'pending'
     and not exists (select 1 from public.revision_plan_items x where x.plan_id = p.id and x.added_at > now() - interval '15 seconds')
   order by p.created_at, m.order_key limit 1;
  if nxt.id is null then
    update public.revision_plans set status = 'done', finished_at = now()
     where book_id = p_book and status = 'active'
       and not exists (select 1 from public.revision_plan_items i where i.plan_id = revision_plans.id and i.status in ('pending', 'active'));
    return '{"idle":true}'::jsonb;
  end if;
  update public.revision_plan_items set status = 'active', started_at = now() where id = nxt.id;
  perform app.reopen_block_now(nxt.block_id, nxt.instruction, nxt.note_id, nxt.priority);
  return jsonb_build_object('opened', nxt.block_id);
end $$;
