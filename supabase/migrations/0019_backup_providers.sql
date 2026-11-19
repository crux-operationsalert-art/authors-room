-- Backup AI providers (Groq, Mistral, OpenRouter): each account has its own free allowance under
-- that provider's terms. Used only when every Gemini model is used up or busy.
alter table public.ai_keys add column if not exists provider text not null default 'gemini';
alter table public.ai_keys drop constraint if exists ai_keys_provider_chk;
alter table public.ai_keys add constraint ai_keys_provider_chk check (provider in ('gemini','groq','mistral','openrouter'));

-- Gemini routing must never pick a backup provider's key.
create or replace function app.resolve_key_for_team(p_team_code text)
returns table(key_id uuid, project_id uuid, vault_secret_id uuid, label text)
language sql stable security definer set search_path to 'public' as $$
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.key_assignments ka
     join public.ai_keys k on k.id = ka.key_id and k.provider = 'gemini'
     join public.ai_projects p on p.id = k.project_id and p.is_active
    where ka.team_code = p_team_code and k.status = 'active')
  union all
  (select k.id, k.project_id, k.vault_secret_id, k.label
     from public.ai_keys k join public.ai_projects p on p.id = k.project_id and p.is_active
    where k.status = 'active' and k.provider = 'gemini'
      and not exists (select 1 from public.key_assignments ka join public.ai_keys k2 on k2.id = ka.key_id
                       where ka.team_code = p_team_code and k2.status = 'active' and k2.provider = 'gemini')
    order by k.created_at limit 1)
  limit 1
$$;

create or replace function app.admin_add_provider_key(p_provider text, p_secret text)
returns table(label text, last4 text)
language plpgsql security definer set search_path to 'public', 'vault' as $$
declare v_project uuid; v_secret uuid; v_fp text; v_label text; v_n int;
begin
  if p_provider not in ('groq','mistral','openrouter') then raise exception 'unknown provider %', p_provider; end if;
  if p_secret is null or length(p_secret) < 20 then raise exception 'that key looks too short'; end if;
  select id into v_project from public.ai_projects where is_active;
  v_fp := encode(extensions.digest(p_secret, 'sha256'), 'hex');
  if exists (select 1 from public.ai_keys where key_fingerprint = v_fp) then raise exception 'this key is already registered'; end if;
  select count(*) + 1 into v_n from public.ai_keys where provider = p_provider;
  v_label := upper(p_provider) || '-' || v_n;
  v_secret := vault.create_secret(p_secret, 'backup-key-' || v_label, 'Author''s Room backup provider key');
  insert into public.ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, notes)
  values (v_project, v_label, right(p_secret, 4), v_fp, v_secret, p_provider, 'backup provider');
  return query select v_label, right(p_secret, 4);
end $$;
revoke all on function app.admin_add_provider_key(text, text) from public, anon, authenticated;
grant execute on function app.admin_add_provider_key(text, text) to service_role;

-- Order and models of the backups (editable without redeploying).
insert into app.settings(key, value) values ('backup_models', '{
  "order": ["mistral", "groq", "openrouter"],
  "mistral": ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  "groq": ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
  "openrouter": ["openrouter/free"]
}') on conflict (key) do update set value = excluded.value;
