-- 0041: found by Part N §40 scenario S02b. If a team's assigned key is in a project that is not routing-eligible
-- (e.g. discovery shows it belongs to an extra free project), the team must fall back to an eligible key
-- instead of getting none and stalling.
create or replace function app.resolve_key_for_team(p_team_code text)
returns table(key_id uuid, project_id uuid, vault_secret_id uuid, label text)
language sql stable security definer set search_path = public as $$
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.key_assignments ka
     join public.ai_keys k on k.id = ka.key_id and k.provider = 'gemini'
     join public.ai_projects p on p.id = k.project_id and p.routing_eligible
    where ka.team_code = p_team_code and k.status = 'active')
  union all
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.ai_keys k join public.ai_projects p on p.id = k.project_id and p.routing_eligible
    where k.status = 'active' and k.provider = 'gemini'
      and not exists (select 1 from public.key_assignments ka
                        join public.ai_keys k2 on k2.id = ka.key_id
                        join public.ai_projects p2 on p2.id = k2.project_id and p2.routing_eligible
                       where ka.team_code = p_team_code and k2.status = 'active' and k2.provider = 'gemini')
    order by k.created_at limit 1)
  limit 1
$$;
