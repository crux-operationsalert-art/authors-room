-- 0004_runtime.sql — expose the app schema to the API, and run the worker
-- Edge Function every minute with pg_cron + pg_net.
-- The worker token is generated here and kept in Vault; it never leaves the database
-- except in the cron call's header, and the function checks it via app.check_worker_token.

alter role authenticator set pgrst.db_schemas = 'public, graphql_public, app';
notify pgrst, 'reload config';

-- Worker token (random, in Vault)
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'worker_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'worker_token',
                                'Shared secret between pg_cron and the worker function');
  end if;
end $$;

create or replace function app.check_worker_token(p_token text) returns boolean
language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'worker_token' and decrypted_secret = p_token)
$$;
revoke all on function app.check_worker_token(text) from public;
grant execute on function app.check_worker_token(text) to service_role;

-- Settings the cron call needs (project URL), editable without a migration.
create table if not exists app.settings (key text primary key, value text not null);
alter table app.settings enable row level security;
