// AI Request Manager for the Edge Function worker (Deno). Same rules as
// worker/src/ai/requestManager.ts, with the rate limit kept in the database
// (app.quota_gate) because Edge Function instances share no memory.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export class QuotaExhaustedError extends Error {
  constructor(msg: string, public retryAfterSeconds: number) { super(msg); this.name = 'QuotaExhaustedError'; }
}
export class PolicyError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PolicyError'; }
}

export interface GenerateRequest {
  roleCode: string; teamCode: string; tier: string; bookId?: string | null; jobId?: string;
  system: string; prompt: string; jsonSchema?: unknown; maxOutputTokens?: number; promptVersion?: string;
  temperature?: number;
}
export interface GenerateResult {
  text: string; modelId: string; inputTokens: number; outputTokens: number; costEstimate: number; keyLabel: string;
}

async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Google says how long to wait, e.g. "Please retry in 17h37m58.0s" or "retry in 41.2s".
function parseRetry(msg: string): number {
  const m = msg.match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i);
  if (!m) return 0;
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}
const isDailyLimit = (msg: string) => /per ?day|PerDay|requests per day/i.test(msg);

async function generateGemini(db: SupabaseClient, req: GenerateRequest, budgetMs = 100_000): Promise<GenerateResult> {
  const app = db.schema('app');
  const { data: project } = await db.from('ai_projects').select('id, usage_tier').eq('is_active', true).single();
  if (!project) throw new PolicyError('No active Gemini project.');

  if (req.bookId) {
    const { data: book } = await db.from('books').select('privacy_mode').eq('id', req.bookId).single();
    if (book?.privacy_mode === 'confidential' && project.usage_tier === 'free') {
      throw new PolicyError('This book is confidential and the Gemini project is on the free tier. ' +
        'Move the project to a paid tier, or mark the book as standard in its settings.');
    }
  }
  const cap = Number(Deno.env.get('DAILY_COST_CAP_USD') ?? '5');
  const { data: spent } = await app.rpc('cost_today_usd');
  if (Number(spent ?? 0) >= cap) throw new PolicyError(`Daily cost cap of $${cap} reached.`);

  const { data: model } = await db.from('model_registry')
    .select('model_id, input_price_per_mtok, output_price_per_mtok, fallbacks').eq('tier', req.tier).eq('enabled', true).single();
  if (!model) throw new PolicyError(`No enabled model for tier "${req.tier}".`);
  // Fallbacks are used when a model is unavailable (5xx / timeout / 404) or its own DAILY limit is used up.
  const chain = [{ id: model.model_id, pin: Number(model.input_price_per_mtok), pout: Number(model.output_price_per_mtok) },
    ...((model.fallbacks ?? []) as any[]).map(f => ({ id: String(f.model_id), pin: Number(f.in ?? 0), pout: Number(f.out ?? 0) }))];

  // Skip models that are resting (daily limit used up, or retired) until their reset.
  const { data: rest } = await db.from('model_rest').select('model_id, until').gt('until', new Date().toISOString());
  const resting = new Map<string, number>(((rest ?? []) as any[]).map(r => [String(r.model_id), Date.parse(r.until)]));
  const live = chain.filter(m => !resting.has(m.id));
  if (!live.length) {
    const soonest = Math.min(...chain.map(m => resting.get(m.id) ?? Infinity));
    throw new QuotaExhaustedError(`Every model for tier "${req.tier}" is resting until its daily reset`,
      Math.max(60, Math.min(86400, Math.ceil((soonest - Date.now()) / 1000))));
  }
  const restModel = (model_id: string, seconds: number, reason: string) => db.from('model_rest').upsert(
    { model_id, until: new Date(Date.now() + seconds * 1000).toISOString(), reason, updated_at: new Date().toISOString() },
    { onConflict: 'model_id' });

  const { data: keyRows } = await app.rpc('resolve_key_for_team', { p_team_code: req.teamCode });
  const key = (keyRows as any[])?.[0];
  if (!key) throw new PolicyError(`No active Gemini key for team "${req.teamCode}".`);
  const { data: secret } = await app.rpc('get_key_secret', { p_key_id: key.key_id });
  if (!secret) throw new PolicyError(`Key ${key.label} has no readable secret.`);

  const est = Math.ceil((req.system.length + req.prompt.length) / 4);
  const { data: wait } = await app.rpc('quota_gate', { p_model: live[0].id, p_est_tokens: est });
  // First model at its limit: go straight to the next ones instead of waiting, if there are any.
  let startAt = 0;
  if (Number(wait) > 0) {
    if (live.length < 2) throw new QuotaExhaustedError(`Project quota for ${live[0].id} is used up for now.`, Number(wait));
    startAt = 1;
  }

  const promptHash = await sha256(req.system + '\u0000' + req.prompt);
  const base = { job_id: req.jobId ?? null, book_id: req.bookId ?? null, role_code: req.roleCode, team_code: req.teamCode,
                 key_id: key.key_id, project_id: key.project_id, prompt_hash: promptHash,
                 prompt_version: req.promptVersion ?? null };
  const record = (r: Record<string, unknown>) => db.from('agent_runs').insert({ ...base, ...r });

  const body: any = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig: { maxOutputTokens: Math.max(req.maxOutputTokens ?? 8192, 2048), temperature: req.temperature ?? 0.7 },
  };
  // Thinking tokens count against the output budget: keep thinking light so JSON is never cut off.
  const thinkingFor = (id: string) => id.startsWith('gemini-3') ? { thinkingLevel: 'low' }
    : id.startsWith('gemini-2.5') ? { thinkingBudget: 512 } : undefined;
  if (req.jsonSchema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = req.jsonSchema; }

  const t_all = Date.now();
  let lastMsg = '';
  let quotaWait = startAt ? Number(wait) : 0;   // set when a model's DAILY free limit is used up and we moved on
  let busyElsewhere = false;                     // a model was busy/failed (not used up): worth retrying soon
  for (let mi = startAt; mi < live.length; mi++) {
    const m = live[mi];
    if (mi > startAt && Date.now() - t_all > budgetMs) break;         // stay inside the function's time limit
    const t0 = Date.now();
    let status = 0, json: any = {}, retryAfter = 0;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m.id)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(secret) },
        body: JSON.stringify({ ...body, generationConfig: { ...body.generationConfig, ...(thinkingFor(m.id) ? { thinkingConfig: thinkingFor(m.id) } : {}) } }),
        signal: AbortSignal.timeout(mi === startAt ? 60_000 : 35_000),   // later models get less time so more of them can be tried
      });
      status = res.status; retryAfter = Number(res.headers.get('retry-after')) || 0;
      json = await res.json().catch(() => ({}));
    } catch (e) { json = { error: { message: String(e) } }; }
    const latency_ms = Date.now() - t0;

    if (status === 200) {
      const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      const u = json?.usageMetadata ?? {};
      const inTok = u.promptTokenCount ?? 0, outTok = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      const cost = (inTok * m.pin + outTok * m.pout) / 1e6;
      if (!text.trim()) {   // blocked or empty reply (e.g. safety filter): never save a blank paragraph
        lastMsg = `empty reply (finish=${json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? 'unknown'})`;
        await record({ model_id: m.id, input_tokens: inTok, output_tokens: outTok, cost_estimate: cost, latency_ms, status: 'error', http_status: 200, error: lastMsg });
        busyElsewhere = true;
        continue;
      }
      let st = 'ok';
      if (req.jsonSchema) { try { JSON.parse(text); } catch { st = 'schema_invalid'; } }
      await record({ model_id: m.id, input_tokens: inTok, output_tokens: outTok, cost_estimate: cost, latency_ms, status: st, http_status: 200,
                     error: st === 'ok' ? null : `finish=${json?.candidates?.[0]?.finishReason}; starts: ${text.slice(0, 150)}` });
      if (st === 'schema_invalid') { lastMsg = 'invalid JSON'; busyElsewhere = true; if (mi < live.length - 1) continue; throw new Error('Model output was not valid JSON for the role schema.'); }
      return { text, modelId: m.id, inputTokens: inTok, outputTokens: outTok, costEstimate: cost, keyLabel: key.label };
    }
    const msg = json?.error?.message ?? `HTTP ${status}`;
    lastMsg = msg;
    if (status === 429) {
      await record({ model_id: m.id, latency_ms, status: 'rate_limited', http_status: 429, error: msg });
      const wait = retryAfter || parseRetry(msg) || 60;
      // Never switch KEYS on quota: every key in the project shares it. A model's DAILY limit is its own,
      // so the next model in the chain (with its own allowance in the same project) may still work today.
      if (isDailyLimit(msg)) await restModel(m.id, wait, 'daily free limit used up');
      if (isDailyLimit(msg) && mi < live.length - 1) {
        quotaWait = quotaWait ? Math.min(quotaWait, wait) : wait;
        continue;
      }
      // Last model used up, but an earlier one was only busy (timeout/5xx): that one still has allowance today.
      if (isDailyLimit(msg) && busyElsewhere) throw new QuotaExhaustedError(`Backup models busy; ${m.id} used up for today. Trying again in 2 minutes`, 120);
      throw new QuotaExhaustedError(`Gemini ${isDailyLimit(msg) ? 'daily free limit' : 'per-minute limit'} reached for ${m.id}`, Math.min(quotaWait ? Math.min(quotaWait, wait) : wait, 86400));
    }
    await record({ model_id: m.id, latency_ms, status: 'error', http_status: status || null, error: msg });
    // 5xx, timeouts and 404 (model retired for this project) move on to the next model; other errors stop.
    if (!(status === 0 || status >= 500 || status === 404)) throw new Error(`Gemini call failed (HTTP ${status}): ${msg}`);
    if (status === 404) await restModel(m.id, 7 * 86400, 'not available to this project');
    if (status !== 404) busyElsewhere = true;
    await sleep(1500);   // brief pause, then the next model in the chain
  }
  // Park until tomorrow ONLY when every model really is used up; if some were just busy, try again soon.
  if (quotaWait && !busyElsewhere) throw new QuotaExhaustedError(`Gemini daily free limits reached for every model in tier "${req.tier}"`, Math.min(quotaWait, 86400));
  if (quotaWait) throw new QuotaExhaustedError(`Main model used up for today and the backup models are busy; trying again in 2 minutes`, 120);
  throw new Error(`All models for tier "${req.tier}" are unavailable right now: ${lastMsg}`);
}

// ------------------------------------------------------------------ backup providers
// Groq, Mistral and OpenRouter: separate companies, each giving one account its own free allowance under
// its own terms. Used only when Gemini cannot answer (all models used up or busy). OpenAI-compatible APIs.
const BACKUP_BASE: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export async function generate(db: SupabaseClient, req: GenerateRequest): Promise<GenerateResult> {
  const t0 = Date.now();
  const { data: bk } = await db.from('ai_keys').select('id, label, project_id, provider').neq('provider', 'gemini').eq('status', 'active');
  const backups = (bk ?? []) as any[];
  if (!backups.length) return generateGemini(db, req);
  let first: unknown;
  try { return await generateGemini(db, req, 55_000); }      // shorter Gemini budget leaves time for the backups
  catch (e) { if (e instanceof PolicyError) throw e; first = e; }
  const r = await generateBackup(db, req, backups, Math.max(25_000, 140_000 - (Date.now() - t0)));
  if ('result' in r) return r.result;
  // Nothing answered: retry when the soonest option is back (never later than Gemini's own wait).
  const gWait = first instanceof QuotaExhaustedError ? first.retryAfterSeconds : 30;
  throw new QuotaExhaustedError(`Gemini: ${(first as Error)?.message ?? first} | Backups: ${r.why}`,
    Math.max(30, Math.min(gWait, r.retryIn)));
}

async function generateBackup(db: SupabaseClient, req: GenerateRequest, keys: any[], budgetMs: number):
    Promise<{ result: GenerateResult } | { why: string; retryIn: number }> {
  const app = db.schema('app');
  const { data: cfgRow } = await app.from('settings').select('value').eq('key', 'backup_models').maybeSingle();
  let cfg: any = {};
  try { cfg = JSON.parse(String((cfgRow as any)?.value ?? '{}')); } catch { /* defaults below */ }
  const order: string[] = cfg.order ?? ['mistral', 'groq', 'openrouter'];
  const { data: rest } = await db.from('model_rest').select('model_id, until').gt('until', new Date().toISOString());
  const resting = new Map<string, number>(((rest ?? []) as any[]).map(r => [String(r.model_id), Date.parse(r.until)]));
  const restModel = (model_id: string, seconds: number, reason: string) => db.from('model_rest').upsert(
    { model_id, until: new Date(Date.now() + seconds * 1000).toISOString(), reason, updated_at: new Date().toISOString() },
    { onConflict: 'model_id' });
  const promptHash = await sha256(req.system + '\u0000' + req.prompt);
  const system = req.jsonSchema
    ? `${req.system}\n\nReply with ONLY one JSON object (no markdown fences, no commentary) that matches this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`
    : req.system;
  const required: string[] = ((req.jsonSchema as any)?.required ?? []) as string[];
  const t0 = Date.now();
  let soonest = Infinity;
  const why: string[] = [];

  for (const provider of order) {
    const key = keys.find(k => k.provider === provider);
    if (!key || !BACKUP_BASE[provider]) continue;
    const provRest = resting.get(`${provider}:*`);
    if (provRest) { soonest = Math.min(soonest, provRest); why.push(`${provider} resting`); continue; }
    const { data: secret } = await app.rpc('get_key_secret', { p_key_id: key.id });
    if (!secret) continue;
    const record = (r: Record<string, unknown>) => db.from('agent_runs').insert({
      job_id: req.jobId ?? null, book_id: req.bookId ?? null, role_code: req.roleCode, team_code: req.teamCode,
      key_id: key.id, project_id: key.project_id, prompt_hash: promptHash, prompt_version: req.promptVersion ?? null, ...r });

    for (const model of (cfg[provider] ?? []) as string[]) {
      const id = `${provider}:${model}`;
      const until = resting.get(id);
      if (until) { soonest = Math.min(soonest, until); continue; }
      const remaining = budgetMs - (Date.now() - t0);
      if (remaining < 10_000) { why.push('out of time'); return { why: why.join('; '), retryIn: 30 }; }
      const payload: any = {
        model, temperature: req.temperature ?? 0.7,
        max_tokens: Math.min(Math.max(req.maxOutputTokens ?? 3000, 1500), 6000),
        messages: [{ role: 'system', content: system }, { role: 'user', content: req.prompt }],
      };
      if (req.jsonSchema) payload.response_format = { type: 'json_object' };
      if (provider === 'groq' && model.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low';
      const t1 = Date.now();
      let status = 0, json: any = {}, retryAfter = 0;
      try {
        const res = await fetch(`${BACKUP_BASE[provider]}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`,
                     ...(provider === 'openrouter' ? { 'X-Title': "Author's Room" } : {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.min(50_000, remaining - 5_000)),
        });
        status = res.status; retryAfter = Number(res.headers.get('retry-after')) || 0;
        json = await res.json().catch(() => ({}));
      } catch (e) { json = { error: { message: String(e) } }; }
      const latency_ms = Date.now() - t1;
      const label = `${provider}/${model}`;

      if (status === 200) {
        let text = String(json?.choices?.[0]?.message?.content ?? '').trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const inTok = json?.usage?.prompt_tokens ?? 0, outTok = json?.usage?.completion_tokens ?? 0;
        let err: string | null = null;
        if (!text) err = `empty reply (finish=${json?.choices?.[0]?.finish_reason ?? 'unknown'})`;
        else if (req.jsonSchema) {
          try {
            const o = JSON.parse(text);
            const missing = required.filter(k => !(k in o));
            if (missing.length) err = `JSON missing ${missing.join(', ')}`;
          } catch { err = 'invalid JSON'; }
        }
        await record({ model_id: label, input_tokens: inTok, output_tokens: outTok, cost_estimate: 0, latency_ms,
                       status: err ? (err.startsWith('empty') ? 'error' : 'schema_invalid') : 'ok', http_status: 200, error: err });
        if (err) { why.push(`${label}: ${err}`); continue; }
        return { result: { text, modelId: label, inputTokens: inTok, outputTokens: outTok, costEstimate: 0, keyLabel: key.label } };
      }
      const msg = String(json?.error?.message ?? json?.message ?? json?.detail ?? `HTTP ${status}`).slice(0, 500);
      await record({ model_id: label, latency_ms, status: status === 429 ? 'rate_limited' : 'error', http_status: status || null, error: msg });
      why.push(`${label}: ${status || 'no answer'}`);
      if (status === 429) {
        const daily = /per day|RPD|TPD|daily|free-models-per-day/i.test(msg);
        const secs = Math.max(20, retryAfter || parseRetry(msg) || (daily ? 3600 : 60));
        await restModel(id, secs, daily ? 'daily free limit used up' : 'busy (per-minute limit)');
        soonest = Math.min(soonest, Date.now() + secs * 1000);
        continue;
      }
      if (status === 401 || status === 403) {      // key rejected or plan not allowed: skip this provider for an hour
        await restModel(`${provider}:*`, 3600, `key rejected (HTTP ${status})`);
        break;
      }
      if (status === 404) await restModel(id, 7 * 86400, 'model not available');
      // 400/413/422 (request too large for this model), 5xx, timeouts: try the next model
    }
  }
  return { why: why.join('; ') || 'no backup model available',
           retryIn: soonest === Infinity ? 60 : Math.max(30, Math.ceil((soonest - Date.now()) / 1000)) };
}
