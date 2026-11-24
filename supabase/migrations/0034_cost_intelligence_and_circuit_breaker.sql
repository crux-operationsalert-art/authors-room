-- 0034: cost intelligence (Document 4, Part L), error classification and circuit breaker (Part K), model scorecard.

-- 1. Pricing catalogue (USD per 1M tokens, paid tier, standard rate). Sources checked 2026-11-24.
create table if not exists public.model_pricing (
  id bigserial primary key,
  model_label text not null,                -- as recorded in agent_runs.model_id
  input_per_mtok numeric, output_per_mtok numeric,   -- null = not priced (no public paid equivalent)
  effective_from date not null default '2000-01-01', effective_to date,
  source text not null, checked_at date not null default current_date
);
alter table public.model_pricing enable row level security;
drop policy if exists model_pricing_read on public.model_pricing;
create policy model_pricing_read on public.model_pricing for select to authenticated using (true);

insert into public.model_pricing(model_label, input_per_mtok, output_per_mtok, effective_from, effective_to, source) values
 ('gemini-3.1-flash-lite', 0.25, 1.50, '2000-01-01', null, 'Google Gemini API / Vertex AI pricing page'),
 ('gemini-3.1-flash-lite-preview', 0.25, 1.50, '2000-01-01', null, 'Google pricing (same as 3.1 Flash-Lite)'),
 ('gemini-3.5-flash-lite', 0.30, 2.50, '2000-01-01', null, 'Google Vertex AI pricing page'),
 ('gemini-flash-lite-latest', 0.10, 0.40, '2000-01-01', null, 'model registry (alias)'),
 ('gemini-2.5-flash', 0.30, 2.50, '2000-01-01', null, 'model registry'),
 ('gemini-2.5-flash-lite', 0.10, 0.40, '2000-01-01', null, 'model registry'),
 ('gemini-3-flash-preview', 0.50, 3.00, '2000-01-01', null, 'model registry'),
 ('gemini-flash-latest', 0.50, 3.00, '2000-01-01', null, 'model registry (alias)'),
 ('gemini-3.5-flash', 0.50, 3.00, '2000-01-01', null, 'model registry'),
 ('gemini-3.6-flash', 0.75, 3.75, '2000-01-01', '2026-12-31', 'Google Vertex AI: introductory price to 31 Dec 2026'),
 ('gemini-3.6-flash', 1.50, 7.50, '2027-01-01', null, 'Google Vertex AI: standard price from 1 Jan 2027'),
 ('gemini-3.7-flash', 0.75, 3.75, '2000-01-01', '2026-12-31', 'Google Vertex AI: introductory price to 31 Dec 2026'),
 ('gemini-3.7-flash', 1.50, 7.50, '2027-01-01', null, 'Google Vertex AI: standard price from 1 Jan 2027'),
 ('gemini-3.8-flash', 0.75, 3.75, '2000-01-01', '2026-12-31', 'Google Vertex AI: introductory price to 31 Dec 2026'),
 ('gemini-3.8-flash', 1.50, 7.50, '2027-01-01', null, 'Google Vertex AI: standard price from 1 Jan 2027'),
 ('gemini-3.1-pro-preview', 2.00, 12.00, '2000-01-01', null, 'Google Vertex AI pricing page'),
 ('gemini-embedding-001', 0.15, 0, '2000-01-01', null, 'model registry'),
 ('groq/openai/gpt-oss-120b', 0.15, 0.60, '2000-01-01', null, 'Groq published pricing (GroqCloud docs)'),
 ('groq/openai/gpt-oss-20b', 0.075, 0.30, '2000-01-01', null, 'Groq published pricing (GroqCloud docs)'),
 ('openrouter/openrouter/free', null, null, '2000-01-01', null, 'OpenRouter free router: routes to varying free models; no single paid equivalent');

create or replace function app.price_of(p_label text, p_at timestamptz)
returns table(pin numeric, pout numeric) language sql stable security definer set search_path to 'public' as $$
  select input_per_mtok, output_per_mtok from public.model_pricing
   where model_label = p_label and p_at::date >= effective_from and (effective_to is null or p_at::date <= effective_to)
   order by effective_from desc limit 1
$$;

-- 2. Real spend only: free-tier projects and free backup accounts cost nothing.
create or replace function app.cost_today_usd()
returns numeric language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(r.cost_estimate), 0) from public.agent_runs r join public.ai_projects p on p.id = r.project_id
   where r.created_at >= app.pacific_day_start() and p.usage_tier <> 'free'
$$;

-- 3. Error classes.
create or replace function app.error_class(p_status text, p_http int, p_error text)
returns text language sql immutable as $$
  select case
    when p_status = 'ok' then 'ok'
    when p_status = 'schema_invalid' or p_error ilike '%JSON%' then 'bad_output'
    when p_http = 429 and p_error ~* 'per ?day|PerDay|requests per day|daily|RPD|TPD' then 'quota_daily'
    when p_http = 429 then 'quota_minute'
    when p_http = 413 then 'too_large'
    when p_http in (401, 403) then 'auth'
    when p_http = 404 then 'not_available'
    when p_http >= 500 then 'provider_busy'
    when p_error ilike '%timeout%' or p_error ilike '%timed out%' then 'timeout'
    when p_error ilike 'empty reply%' then 'empty_reply'
    when p_http = 400 then 'bad_request'
    else 'other' end
$$;

-- 4. Circuit breaker: 5 failures in a row (busy, timeout, bad output, empty) within 10 minutes opens the circuit
--    for that model for 10 minutes (it is skipped); the first call after that is the half-open test.
create or replace function app.circuit_breaker()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_cls text; v_fails int; v_rest_id text;
begin
  v_cls := app.error_class(new.status, new.http_status, new.error);
  if v_cls not in ('provider_busy', 'timeout', 'bad_output', 'empty_reply') then return new; end if;
  select count(*) into v_fails from (
    select status, http_status, error from public.agent_runs
     where model_id = new.model_id and created_at > now() - interval '10 minutes'
     order by created_at desc limit 5) x
   where app.error_class(x.status, x.http_status, x.error) in ('provider_busy', 'timeout', 'bad_output', 'empty_reply');
  if v_fails >= 5 then
    v_rest_id := case when new.model_id ~ '^(groq|mistral|openrouter)/' then regexp_replace(new.model_id, '/', ':') else new.model_id end;
    insert into public.model_rest(model_id, until, reason, updated_at)
    values (v_rest_id, now() + interval '10 minutes', 'circuit open: 5 failures in a row (' || v_cls || ')', now())
    on conflict (model_id) do update set until = greatest(public.model_rest.until, excluded.until),
      reason = case when public.model_rest.until > excluded.until then public.model_rest.reason else excluded.reason end, updated_at = now();
  end if;
  return new;
end $$;
drop trigger if exists circuit_breaker on public.agent_runs;
create trigger circuit_breaker after insert on public.agent_runs for each row execute function app.circuit_breaker();

-- 5. Model scorecard (observed capability map) for the last p_days.
create or replace function app.model_scorecard(p_days int default 7)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(row_to_json(s) order by s.calls desc), '[]') from (
    select model_id as model, count(*) calls,
           round(100.0 * count(*) filter (where status = 'ok') / count(*)) ok_pct,
           count(*) filter (where app.error_class(status, http_status, error) like 'quota%') quota_hits,
           count(*) filter (where app.error_class(status, http_status, error) = 'too_large') too_large,
           count(*) filter (where app.error_class(status, http_status, error) in ('provider_busy', 'timeout')) busy_or_timeout,
           count(*) filter (where app.error_class(status, http_status, error) in ('bad_output', 'empty_reply')) bad_output,
           round(avg(latency_ms) filter (where status = 'ok') / 1000.0, 1) avg_seconds,
           max(input_tokens) filter (where status = 'ok') largest_prompt_ok,
           sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) tokens,
           (select r.until from public.model_rest r where r.model_id = case when a.model_id ~ '^(groq|mistral|openrouter)/' then regexp_replace(a.model_id, '/', ':') else a.model_id end and r.until > now()) resting_until
      from public.agent_runs a where created_at > now() - make_interval(days => p_days) group by model_id) s
$$;

-- 6. Five KPIs plus actual vs hypothetical cost, per book (p_book) or for everything (null).
create or replace function app.cost_kpis(p_book uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb; v_words numeric; v_paras numeric; v_versions numeric; v_first timestamptz; v_days numeric;
begin
  if p_book is not null and auth.uid() is not null and not app.owns_book(p_book) then raise exception 'not your book' using errcode = '42501'; end if;
  select coalesce(sum(array_length(regexp_split_to_array(trim(v.text), '\s+'), 1)), 0), count(*)
    into v_words, v_paras
    from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
   where m.status in ('ai_approved', 'author_approved') and (p_book is null or m.book_id = p_book);
  select count(*) into v_versions from public.block_versions v join public.manuscript_blocks m on m.id = v.block_id
   where m.status in ('ai_approved', 'author_approved') and (p_book is null or m.book_id = p_book);
  select min(created_at) into v_first from public.agent_runs where p_book is null or book_id = p_book;
  v_days := greatest(1, extract(epoch from now() - coalesce(v_first, now())) / 86400);
  with runs as (
    select a.*, pr.pin, pr.pout, coalesce(p.usage_tier, 'free') tier
      from public.agent_runs a
      left join lateral app.price_of(a.model_id, a.created_at) pr on true
      left join public.ai_projects p on p.id = a.project_id
     where p_book is null or a.book_id = p_book),
  t as (
    select count(*) calls, count(*) filter (where status = 'ok') ok_calls,
           sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) tokens,
           sum((coalesce(input_tokens, 0) * pin + coalesce(output_tokens, 0) * pout) / 1e6) hypo,
           sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) filter (where pin is not null) priced_tokens,
           sum(cost_estimate) filter (where tier <> 'free') actual
      from runs),
  e as (select coalesce(jsonb_object_agg(cls, n), '{}') errs from (
          select app.error_class(status, http_status, error) cls, count(*) n from runs where status <> 'ok' group by 1) x)
  select jsonb_build_object(
    'approved_words', v_words, 'approved_paragraphs', v_paras, 'calls', calls, 'tokens', tokens,
    'actual_cost_usd', round(coalesce(actual, 0)::numeric, 2),
    'hypothetical_paid_cost_usd', round(coalesce(hypo, 0)::numeric, 2),
    'priced_token_share_pct', case when tokens > 0 then round(100.0 * priced_tokens / tokens) end,
    'kpi', jsonb_build_object(
      'hypothetical_cost_per_1000_words_usd', case when v_words > 0 then round((1000 * coalesce(hypo, 0) / v_words)::numeric, 3) end,
      'tokens_per_approved_word', case when v_words > 0 then round(tokens / v_words) end,
      'call_success_pct', case when calls > 0 then round(100.0 * ok_calls / calls) end,
      'versions_per_approved_paragraph', case when v_paras > 0 then round(v_versions / v_paras, 1) end,
      'approved_words_per_day', round(v_words / v_days)),
    'errors', errs)
  into r from t, e;
  return r;
end $$;

-- 7. Budgets (alerts, not hard stops; the real-spend cap stays in the worker).
insert into app.settings(key, value) values ('budgets', '{"per_book_hypothetical_usd": 25, "tokens_per_word_alert": 2000, "success_pct_alert": 60}')
on conflict (key) do nothing;

revoke all on function app.cost_kpis(uuid) from public, anon;
grant execute on function app.cost_kpis(uuid) to authenticated, service_role;
revoke all on function app.model_scorecard(int) from public, anon;
grant execute on function app.model_scorecard(int) to authenticated, service_role;
