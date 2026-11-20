-- Key groups: one group per AI company account (Gemini main project, Mistral, Groq, OpenRouter). A group's keys share
-- one allowance, so the group works, rests and is replaced as a whole. When a group is used up, the next group in the
-- author's order takes over. Keys from other Google projects are not a group: they would stretch Google's free limit.

create or replace function app.key_groups() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_cfg jsonb; v_order text[]; v_day timestamptz; out jsonb := '[]'; g text; pos int := 0;
        v_models text[]; v_rest int; v_until timestamptz; v_reason text; v_keys jsonb; v_ok int; v_refused int;
begin
  if not (app.is_author() or auth.role() = 'service_role') then raise exception 'not allowed' using errcode = '42501'; end if;
  select coalesce((select value::jsonb from app.settings where key = 'backup_models'), '{}'::jsonb) into v_cfg;
  v_order := array['gemini'] || coalesce(array(select jsonb_array_elements_text(v_cfg->'order')), array['mistral','groq','openrouter']);
  -- Google's daily reset is 08:00 UTC; the same window is used for every group's "today"
  v_day := date_trunc('day', now() - interval '8 hours') + interval '8 hours';
  foreach g in array v_order loop
    pos := pos + 1;
    if g = 'gemini' then
      select array_agg(distinct m) into v_models from (
        select model_id m from public.model_registry where enabled and tier <> 'embedding'
        union select f->>'model_id' from public.model_registry, jsonb_array_elements(coalesce(fallbacks, '[]')) f where enabled and tier <> 'embedding') x;
      select count(*), max(until), min(reason) into v_rest, v_until, v_reason from public.model_rest where model_id = any(v_models) and until > now();
      select coalesce(jsonb_agg(jsonb_build_object('label', k.label, 'last4', k.key_last4, 'status', k.status) order by k.label), '[]') into v_keys
        from public.ai_keys k where k.provider = 'gemini' and exists (select 1 from public.key_assignments a where a.key_id = k.id);
      select count(*) filter (where status = 'ok'), count(*) filter (where status = 'rate_limited') into v_ok, v_refused
        from public.agent_runs where created_at >= v_day and model_id like 'gemini%';
    else
      v_models := array(select g || ':' || jsonb_array_elements_text(coalesce(v_cfg->g, '[]')));
      select count(*), max(until), min(reason) into v_rest, v_until, v_reason from public.model_rest
       where (model_id = any(v_models) or model_id = g || ':*') and until > now();
      if exists (select 1 from public.model_rest where model_id = g || ':*' and until > now()) then v_rest := coalesce(array_length(v_models, 1), 0); end if;
      select coalesce(jsonb_agg(jsonb_build_object('label', k.label, 'last4', k.key_last4, 'status', k.status) order by k.label), '[]') into v_keys
        from public.ai_keys k where k.provider = g and k.status <> 'revoked';
      select count(*) filter (where status = 'ok'), count(*) filter (where status = 'rate_limited') into v_ok, v_refused
        from public.agent_runs where created_at >= v_day and model_id like g || '/%';
    end if;
    out := out || jsonb_build_object(
      'group', g, 'position', pos,
      'label', case g when 'gemini' then 'Gemini (main project)' when 'mistral' then 'Mistral' when 'groq' then 'Groq' else 'OpenRouter' end,
      'keys', v_keys,
      'active_keys', (select count(*) from jsonb_array_elements(v_keys) e where e->>'status' = 'active'),
      'models', coalesce(array_length(v_models, 1), 0), 'models_resting', v_rest,
      'resting_until', case when v_rest >= coalesce(array_length(v_models, 1), 0) and v_rest > 0 then v_until end,
      'resting_reason', case when v_rest >= coalesce(array_length(v_models, 1), 0) and v_rest > 0 then v_reason end,
      'answers_today', v_ok, 'refused_today', v_refused);
  end loop;
  return jsonb_build_object('groups', out,
    'set_aside', (select count(*) from public.ai_keys k where k.provider = 'gemini' and k.status <> 'revoked'
                   and not exists (select 1 from public.key_assignments a where a.key_id = k.id)));
end $$;
grant execute on function app.key_groups() to authenticated, service_role;

-- The author's order of the backup groups (Gemini always goes first: it is the main project).
create or replace function app.set_backup_order(p_order text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg jsonb;
begin
  if not app.is_author() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_order is null or array_length(p_order, 1) <> 3 or not (p_order @> array['mistral','groq','openrouter']) then
    raise exception 'order must list mistral, groq and openrouter once each';
  end if;
  select coalesce((select value::jsonb from app.settings where key = 'backup_models'), '{}'::jsonb) into v_cfg;
  update app.settings set value = jsonb_set(v_cfg, '{order}', to_jsonb(p_order))::text where key = 'backup_models';
end $$;
grant execute on function app.set_backup_order(text[]) to authenticated;

-- Pause, resume or retire a whole group in one step (e.g. before replacing its key).
create or replace function app.set_group_status(p_group text, p_status text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_author() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('active', 'disabled', 'revoked') then raise exception 'unknown status %', p_status; end if;
  if p_group = 'gemini' then
    update public.ai_keys k set status = p_status, revoked_at = case when p_status = 'revoked' then now() else revoked_at end
     where k.provider = 'gemini' and k.status <> 'revoked' and exists (select 1 from public.key_assignments a where a.key_id = k.id);
  elsif p_group in ('mistral', 'groq', 'openrouter') then
    update public.ai_keys set status = p_status, revoked_at = case when p_status = 'revoked' then now() else revoked_at end
     where provider = p_group and status <> 'revoked';
    -- a fresh or re-enabled group must not stay benched by an old "key rejected" rest
    if p_status = 'active' then delete from public.model_rest where model_id = p_group || ':*'; end if;
  else raise exception 'unknown group %', p_group; end if;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function app.set_group_status(text, text) to authenticated;

-- A newly added backup key clears its group's "key rejected" rest, so the new key is tried at once.
create or replace function app.clear_group_rest_on_new_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.provider <> 'gemini' then delete from public.model_rest where model_id = new.provider || ':*'; end if;
  return new;
end $$;
drop trigger if exists clear_group_rest_on_new_key on public.ai_keys;
create trigger clear_group_rest_on_new_key after insert on public.ai_keys for each row execute function app.clear_group_rest_on_new_key();

-- "Replace" on a backup group: after the new key is added, retire the group's older keys (newest stays).
create or replace function app.retire_older_group_keys(p_group text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not app.is_author() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_group not in ('mistral', 'groq', 'openrouter') then raise exception 'only backup groups are replaced this way'; end if;
  update public.ai_keys set status = 'revoked', revoked_at = now()
   where provider = p_group and status <> 'revoked'
     and id <> (select id from public.ai_keys where provider = p_group and status <> 'revoked' order by created_at desc limit 1);
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function app.retire_older_group_keys(text) to authenticated;
