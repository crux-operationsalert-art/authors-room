-- 0048 (25 Nov): stop hammering a backup model that keeps refusing. Overnight, OpenRouter's free Gemma models answered
-- 429 "Provider returned error" (the upstream provider was overloaded) about 490 times: each refusal rested the model for
-- only ~20 s, so the job retried every minute all night. Now, when a model has been refused 3+ times in 15 minutes,
-- any short rest written for it is stretched to 30 minutes (works whatever the worker asks for; no redeploy needed).
create or replace function app.escalate_model_rest()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_label text; v_n int;
begin
  if new.model_id like '%:*' or new.until > now() + interval '10 minutes' then return new; end if;
  -- model_rest ids are "provider:model" for backups, plain ids for Gemini; agent_runs uses "provider/model"
  v_label := case when new.model_id ~ '^(groq|mistral|openrouter):' then regexp_replace(new.model_id, ':', '/') else new.model_id end;
  select count(*) into v_n from public.agent_runs
   where model_id = v_label and status in ('rate_limited', 'error') and created_at > now() - interval '15 minutes';
  if v_n >= 3 then
    new.until := now() + interval '30 minutes';
    new.reason := coalesce(new.reason, '') || format(' (refused %s times in 15 min: resting 30 min)', v_n);
  end if;
  return new;
end $$;
drop trigger if exists escalate_rest on public.model_rest;
create trigger escalate_rest before insert or update on public.model_rest for each row execute function app.escalate_model_rest();
