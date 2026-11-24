-- 0032: facts extracted from a paragraph version are retired (kept, not deleted) when that version is superseded or cut,
-- so prompts only see facts from the current text. Applies going forward; originals' history untouched.
create or replace function app.retire_superseded_facts()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if old.current_version_id is not null and new.current_version_id is distinct from old.current_version_id then
    update public.canon_facts set status = 'retired'
     where source_block_version_id = old.current_version_id and status <> 'retired';
  end if;
  if new.status = 'cut' and old.status is distinct from 'cut' then
    update public.canon_facts set status = 'retired'
     where source_block_version_id = new.current_version_id and status <> 'retired';
  end if;
  return new;
end $$;
drop trigger if exists retire_superseded_facts on public.manuscript_blocks;
create trigger retire_superseded_facts after update of current_version_id, status on public.manuscript_blocks
  for each row execute function app.retire_superseded_facts();
