-- NOTE: reconstructed from the session record; to be diffed against live pg_get_functiondef before relying on it for a rebuild.
-- 0039: Part H §26 model discovery, capability map and pricing retrieval for OpenRouter and Groq; Part H §25 network
-- failures and credential/permission errors as their own classes.
create table if not exists public.model_catalog (
  provider text not null, model_id text not null,
  context_length int, input_per_mtok numeric, output_per_mtok numeric, is_free boolean,
  capabilities jsonb, discovered_at timestamptz not null default now(),
  primary key (provider, model_id)
);
alter table public.model_catalog enable row level security;
drop policy if exists model_catalog_read on public.model_catalog;
create policy model_catalog_read on public.model_catalog for select using (app.is_author());

-- Upsert discovered models; record a new dated price row only when a price changes (historical snapshots preserved).
create or replace function app.upsert_model_catalog(p_provider text, p_models jsonb, p_source_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m jsonb; v_label text; v_in numeric; v_out numeric; cur record; n_new int := 0; n_changed int := 0;
begin
  for m in select * from jsonb_array_elements(p_models) loop
    v_in := nullif(m->>'in', '')::numeric; v_out := nullif(m->>'out', '')::numeric;
    insert into public.model_catalog(provider, model_id, context_length, input_per_mtok, output_per_mtok, is_free, capabilities, discovered_at)
    values (p_provider, m->>'id', nullif(m->>'context', '')::int, v_in, v_out, (m->>'free')::boolean, m->'caps', now())
    on conflict (provider, model_id) do update set context_length = excluded.context_length, input_per_mtok = excluded.input_per_mtok,
      output_per_mtok = excluded.output_per_mtok, is_free = excluded.is_free, capabilities = excluded.capabilities, discovered_at = now();
    if v_in is null then continue; end if;
    v_label := p_provider || '/' || (m->>'id');
    select * into cur from public.model_pricing where model_label = v_label and effective_to is null order by effective_from desc limit 1;
    if cur.id is null then
      insert into public.model_pricing(model_label, input_per_mtok, output_per_mtok, effective_from, source, source_url, checked_at)
      values (v_label, v_in, v_out, current_date, p_provider || ' models API', p_source_url, current_date);
      n_new := n_new + 1;
    elsif cur.input_per_mtok is distinct from v_in or cur.output_per_mtok is distinct from v_out then
      update public.model_pricing set effective_to = current_date - 1 where id = cur.id;
      insert into public.model_pricing(model_label, input_per_mtok, output_per_mtok, effective_from, source, source_url, checked_at)
      values (v_label, v_in, v_out, current_date, p_provider || ' models API (price changed)', p_source_url, current_date);
      n_changed := n_changed + 1;
    else
      update public.model_pricing set checked_at = current_date where id = cur.id;
    end if;
  end loop;
  insert into public.provisioning_log(operation, target, status, detail)
  values ('discover_models', p_provider, 'ok', jsonb_array_length(p_models) || ' models; ' || n_new || ' new prices; ' || n_changed || ' price changes');
  return jsonb_build_object('models', jsonb_array_length(p_models), 'new_prices', n_new, 'price_changes', n_changed);
end $$;
revoke all on function app.upsert_model_catalog(text, jsonb, text) from public, anon, authenticated;
grant execute on function app.upsert_model_catalog(text, jsonb, text) to service_role;

create or replace function app.error_class(p_status text, p_http int, p_error text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_status = 'ok' then 'ok'
    when p_status = 'schema_invalid' or p_error ilike '%JSON%' then 'bad_output'
    when p_http = 429 and p_error ~* 'per ?day|PerDay|requests per day|daily|RPD|TPD' then 'quota_daily'
    when p_http = 429 and p_error ~* 'token' then 'quota_tokens_minute'
    when p_http = 429 then 'quota_minute'
    when p_http = 413 then 'too_large'
    when p_http = 401 then 'credential_invalid'
    when p_http = 403 then 'permission'
    when p_http = 404 then 'not_available'
    when p_http >= 500 then 'provider_busy'
    when p_error ilike '%timeout%' or p_error ilike '%timed out%' then 'timeout'
    when p_error ~* 'fetch failed|network|ECONN|dns|connection (reset|refused|closed)|TypeError: error sending' then 'network'
    when p_error ilike 'empty reply%' then 'empty_reply'
    when p_http = 400 then 'bad_request'
    else 'other' end
$$;
