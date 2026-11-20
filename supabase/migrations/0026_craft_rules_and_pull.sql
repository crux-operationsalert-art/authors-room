-- Storytelling ground rules applied to every book by default (editable in app.settings without a redeploy),
-- and a page-turn "pull" score next to the reader-emotion match. Rules text: see app.settings 'craft_rules'
-- (same list as DEFAULT_CRAFT in functions/worker/roles.ts, which is the fallback).
alter table public.reader_emotions add column if not exists pull int check (pull between 0 and 100);
create or replace function app.craft_rules() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when app.is_author() or auth.role() = 'service_role'
              then coalesce((select value::jsonb from app.settings where key = 'craft_rules'), '[]'::jsonb) end
$$;
grant execute on function app.craft_rules() to authenticated, service_role;
