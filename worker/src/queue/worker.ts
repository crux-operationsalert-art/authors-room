import { hostname } from 'node:os';
import { AIRequestManager } from '../ai/requestManager.js';
import { ProjectRateLimiter } from '../ai/rateLimiter.js';
import { PolicyError, QuotaExhaustedError, TeamCode, Tier } from '../ai/types.js';
import { SupabaseStore } from '../db/supabaseStore.js';

/**
 * P0 worker loop: claim → run → complete / wait / fail.
 * Role handlers (Lead Writer, reviewers, ...) arrive in P2–P4; P0 ships an
 * `echo` handler so the pipeline can be smoke-tested end to end.
 */
type Handler = (job: any, ai: AIRequestManager) => Promise<unknown>;

const ROLE_TEAM: Record<string, { team: TeamCode; tier: Tier }> = {};

export const handlers: Record<string, Handler> = {
  smoke_test: async (job, ai) => {
    const meta = ROLE_TEAM[job.role_code];
    const r = await ai.generate({
      roleCode: job.role_code, teamCode: meta.team, tier: meta.tier, jobId: job.id, bookId: job.book_id ?? undefined,
      system: 'You are a connectivity check. Reply with the single word OK.',
      prompt: String(job.payload?.prompt ?? 'Say OK.'), maxOutputTokens: 16,
    });
    return { reply: r.text.trim(), model: r.modelId, key: r.keyLabel, tokens: r.inputTokens + r.outputTokens };
  },
};

async function main() {
  const url = process.env.SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only).');
  const store = new SupabaseStore(url, svc);
  const workerId = `${hostname()}-${process.pid}`;

  const { data: roles } = await store.db.from('agent_roles').select('code, team_code, default_tier');
  for (const r of roles ?? []) ROLE_TEAM[r.code] = { team: r.team_code, tier: r.default_tier };

  const project = await store.getActiveProject();
  const limiter = new ProjectRateLimiter(project.limits);
  for (const m of Object.keys(project.limits)) limiter.seedDaily(m, await store.getRequestsToday(project.projectId, m));
  const ai = new AIRequestManager(store, limiter, {
    dailyCostCapUsd: process.env.DAILY_COST_CAP_USD ? Number(process.env.DAILY_COST_CAP_USD) : undefined,
  });

  console.log(`worker ${workerId} started`);
  for (;;) {
    const { data, error } = await store.app.rpc('claim_next_job', { p_worker: workerId });
    if (error) { console.error(error.message); await new Promise(r => setTimeout(r, 5000)); continue; }
    const job = (data as any[])?.[0];
    if (!job) { await new Promise(r => setTimeout(r, 2000)); continue; }

    const handler = handlers[job.workflow];
    try {
      if (!handler) throw new PolicyError(`No handler for workflow "${job.workflow}" yet.`);
      const key = await store.resolveKeyForTeam(ROLE_TEAM[job.role_code].team);
      if (key) await store.app.rpc('set_job_key', { p_job: job.id, p_key: key.keyId });
      const result = await handler(job, ai);
      await store.app.rpc('complete_job', { p_job: job.id, p_result: result });
    } catch (e: any) {
      const quota = e instanceof QuotaExhaustedError;
      const retryIn = quota ? e.retryAfterSeconds : e instanceof PolicyError ? 86_400 : 30;
      await store.app.rpc('fail_job', { p_job: job.id, p_error: String(e.message ?? e),
                                        p_retry_in_seconds: retryIn, p_quota: quota });
      console.warn(`job ${job.id} ${quota ? 'waiting for quota' : 'failed'}: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
