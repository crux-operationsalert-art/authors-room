-- 0037: Google OAuth support. Client credentials and refresh tokens stay in Vault (server side only).
create table if not exists app.oauth_states (
  state text primary key, author_auth_id uuid not null, created_at timestamptz not null default now()
);
alter table app.oauth_states enable row level security;

create or replace function app.admin_set_google_client(p_client_id text, p_client_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v uuid;
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_client_id !~ '\.apps\.googleusercontent\.com$' then raise exception 'That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).'; end if;
  if length(coalesce(p_client_secret, '')) < 10 then raise exception 'Client secret missing.'; end if;
  insert into app.settings(key, value) values ('google_oauth_client_id', p_client_id)
  on conflict (key) do update set value = excluded.value;
  select (value)::uuid into v from app.settings where key = 'google_oauth_secret_vault_id';
  if v is null then
    v := vault.create_secret(p_client_secret, 'google-oauth-client-secret', 'Author''s Room Google OAuth client secret');
    insert into app.settings(key, value) values ('google_oauth_secret_vault_id', v::text);
  else
    perform vault.update_secret(v, p_client_secret);
  end if;
  insert into public.provisioning_log(operation, target, status, detail) values ('configure', 'Google OAuth client', 'ok', 'client ID saved; secret stored in Vault');
end $$;

create or replace function app.google_client_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'client_configured', exists (select 1 from app.settings where key = 'google_oauth_secret_vault_id'),
    'client_id_hint', (select left(value, 8) || '…' from app.settings where key = 'google_oauth_client_id'),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'oauth_status', oauth_status,
                   'ownership', ownership, 'last_discovery_at', last_discovery_at) order by created_at), '[]')
                 from public.ai_accounts where provider = 'google'))
  where app.is_author() or auth.role() = 'service_role'
$$;

create or replace function app.google_client_secret()
returns text language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds
   where ds.id = (select value::uuid from app.settings where key = 'google_oauth_secret_vault_id')
$$;
create or replace function app.store_oauth_account(p_label text, p_refresh_token text, p_scopes text[])
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_acc uuid; v_vault uuid;
begin
  select id, oauth_vault_id into v_acc, v_vault from public.ai_accounts where provider = 'google' and label = p_label;
  if v_vault is null then v_vault := vault.create_secret(p_refresh_token, 'google-refresh-' || gen_random_uuid(), 'Google OAuth refresh token');
  else perform vault.update_secret(v_vault, p_refresh_token); end if;
  if v_acc is null then
    insert into public.ai_accounts(provider, label, ownership, oauth_status, oauth_vault_id, oauth_scopes)
    values ('google', p_label, 'verified_oauth', 'connected', v_vault, p_scopes) returning id into v_acc;
  else
    update public.ai_accounts set ownership = 'verified_oauth', oauth_status = 'connected', oauth_vault_id = v_vault, oauth_scopes = p_scopes where id = v_acc;
  end if;
  insert into public.provisioning_log(account_id, operation, target, status, detail) values (v_acc, 'connect', p_label, 'ok', 'Google account connected');
  return v_acc;
end $$;
create or replace function app.oauth_refresh_token(p_account uuid)
returns text language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds join public.ai_accounts a on a.oauth_vault_id = ds.id
   where a.id = p_account and a.oauth_status = 'connected'
$$;
create or replace function app.register_verified_key(p_secret text, p_project uuid, p_google_key_name text, p_alias text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_fp text := encode(extensions.digest(p_secret, 'sha256'), 'hex'); v_key uuid; v_vault uuid; v_n int;
begin
  select id into v_key from public.ai_keys where key_fingerprint = v_fp;
  if v_key is not null then
    update public.ai_keys set project_id = p_project, ownership = 'verified_oauth', project_confirmed = true,
           google_key_name = p_google_key_name, last_verified_at = now() where id = v_key;
    return v_key;
  end if;
  select count(*) into v_n from public.ai_keys where provider = 'gemini';
  v_vault := vault.create_secret(p_secret, 'gemini-key-G' || (v_n + 1), 'Author''s Room Gemini key (provisioned)');
  insert into public.ai_keys(project_id, label, key_last4, key_fingerprint, vault_secret_id, provider, alias, ownership,
                             project_confirmed, google_key_name, last_verified_at, notes)
  values (p_project, 'K' || lpad((v_n + 1)::text, 2, '0'), right(p_secret, 4), v_fp, v_vault, 'gemini', p_alias, 'verified_oauth',
          true, p_google_key_name, now(), 'created through Google OAuth')
  returning id into v_key;
  return v_key;
end $$;

revoke all on function app.google_client_secret(), app.store_oauth_account(text, text, text[]), app.oauth_refresh_token(uuid),
  app.register_verified_key(text, uuid, text, text) from public, anon, authenticated;
grant execute on function app.google_client_secret(), app.store_oauth_account(text, text, text[]), app.oauth_refresh_token(uuid),
  app.register_verified_key(text, uuid, text, text) to service_role;
revoke all on function app.admin_set_google_client(text, text), app.google_client_status() from public, anon;
grant execute on function app.admin_set_google_client(text, text), app.google_client_status() to authenticated, service_role;
