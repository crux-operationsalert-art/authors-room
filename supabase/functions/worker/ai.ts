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

export async function generate(db: SupabaseClient, req: GenerateRequest): Promise<GenerateResult> {
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
  // Fallbacks are used ONLY when a model is unavailable (5xx / timeout), never on quota (429).
  const chain = [{ id: model.model_id, pin: Number(model.input_price_per_mtok), pout: Number(model.output_price_per_mtok) },
    ...((model.fallbacks ?? []) as any[]).map(f => ({ id: String(f.model_id), pin: Number(f.in ?? 0), pout: Number(f.out ?? 0) }))];

  const { data: keyRows } = await app.rpc('resolve_key_for_team', { p_team_code: req.teamCode });
  const key = (keyRows as any[])?.[0];
  if (!key) throw new PolicyError(`No active Gemini key for team "${req.teamCode}".`);
  const { data: secret } = await app.rpc('get_key_secret', { p_key_id: key.key_id });
  if (!secret) throw new PolicyError(`Key ${key.label} has no readable secret.`);

  const est = Math.ceil((req.system.length + req.prompt.length) / 4);
  const { data: wait } = await app.rpc('quota_gate', { p_model: chain[0].id, p_est_tokens: est });
  if (Number(wait) > 0) throw new QuotaExhaustedError(`Project quota for ${chain[0].id} is used up for now.`, Number(wait));

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
  for (let mi = 0; mi < chain.length; mi++) {
    const m = chain[mi];
    if (mi > 0 && Date.now() - t_all > 60_000) break;          // stay inside the function's time limit
    const t0 = Date.now();
    let status = 0, json: any = {}, retryAfter = 0;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m.id)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(secret) },
        body: JSON.stringify({ ...body, generationConfig: { ...body.generationConfig, ...(thinkingFor(m.id) ? { thinkingConfig: thinkingFor(m.id) } : {}) } }),
        signal: AbortSignal.timeout(75_000),
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
        continue;
      }
      let st = 'ok';
      if (req.jsonSchema) { try { JSON.parse(text); } catch { st = 'schema_invalid'; } }
      await record({ model_id: m.id, input_tokens: inTok, output_tokens: outTok, cost_estimate: cost, latency_ms, status: st, http_status: 200,
                     error: st === 'ok' ? null : `finish=${json?.candidates?.[0]?.finishReason}; starts: ${text.slice(0, 150)}` });
      if (st === 'schema_invalid') { lastMsg = 'invalid JSON'; if (mi < chain.length - 1) continue; throw new Error('Model output was not valid JSON for the role schema.'); }
      return { text, modelId: m.id, inputTokens: inTok, outputTokens: outTok, costEstimate: cost, keyLabel: key.label };
    }
    const msg = json?.error?.message ?? `HTTP ${status}`;
    lastMsg = msg;
    if (status === 429) {
      await record({ model_id: m.id, latency_ms, status: 'rate_limited', http_status: 429, error: msg });
      // Never switch keys or models on quota: every key in the project shares this quota.
      throw new QuotaExhaustedError(`Gemini quota reached: ${msg}`, retryAfter || 60);
    }
    await record({ model_id: m.id, latency_ms, status: 'error', http_status: status || null, error: msg });
    // 5xx, timeouts and 404 (model retired for this project) move on to the next model; other errors stop.
    if (!(status === 0 || status >= 500 || status === 404)) throw new Error(`Gemini call failed (HTTP ${status}): ${msg}`);
    await sleep(1500);   // brief pause, then the next model in the chain
  }
  throw new Error(`All models for tier "${req.tier}" are unavailable right now: ${lastMsg}`);
}
