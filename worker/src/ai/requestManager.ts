import { createHash } from 'node:crypto';
import { backoffMs, sleep } from './backoff.js';
import { callGemini, FetchLike } from './gemini.js';
import { ProjectRateLimiter, estimateTokens } from './rateLimiter.js';
import {
  GenerateRequest, GenerateResult, PolicyError, QuotaExhaustedError, Store,
} from './types.js';

export interface ManagerOptions {
  maxTransientRetries?: number;   // retries for 5xx / network errors (default 4)
  dailyCostCapUsd?: number;       // hard stop for the day (NFR-06)
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/**
 * The ONLY code path to Gemini (Blueprint §7).
 * - picks the model by tier from model_registry
 * - picks the key by TEAM (attribution); quota is enforced per PROJECT
 * - on HTTP 429 it records the event and throws QuotaExhaustedError so the job
 *   waits; it never switches to another key to get round the limit
 * - retries 5xx/network errors with exponential backoff and jitter
 * - writes every attempt to the agent_runs ledger
 */
export class AIRequestManager {
  private opts: Required<Omit<ManagerOptions, 'dailyCostCapUsd'>> & { dailyCostCapUsd?: number };

  constructor(private store: Store, private limiter: ProjectRateLimiter, opts: ManagerOptions = {}) {
    this.opts = {
      maxTransientRetries: opts.maxTransientRetries ?? 4,
      dailyCostCapUsd: opts.dailyCostCapUsd,
      fetchImpl: opts.fetchImpl ?? (fetch as unknown as FetchLike),
      sleepImpl: opts.sleepImpl ?? sleep,
      rand: opts.rand ?? Math.random,
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const project = await this.store.getActiveProject();

    // Privacy: confidential books never go through a free-tier project (D-05).
    if (req.bookId) {
      const privacy = await this.store.getBookPrivacy(req.bookId);
      if (privacy === 'confidential' && project.usageTier === 'free') {
        throw new PolicyError('This book is confidential and the Gemini project is on the free tier. ' +
          'Move the project to a paid tier or mark the book as standard.');
      }
    }
    if (this.opts.dailyCostCapUsd !== undefined &&
        (await this.store.getCostTodayUsd()) >= this.opts.dailyCostCapUsd) {
      throw new PolicyError(`Daily cost cap of $${this.opts.dailyCostCapUsd} reached.`);
    }

    const model = await this.store.getModelForTier(req.tier);
    const key = await this.store.resolveKeyForTeam(req.teamCode);
    if (!key) throw new PolicyError(`No active Gemini key for team "${req.teamCode}" or as fallback.`);
    const secret = await this.store.getKeySecret(key.keyId);
    if (!secret) throw new PolicyError(`Key ${key.label} has no readable secret.`);

    const promptHash = createHash('sha256').update(req.system + '\u0000' + req.prompt).digest('hex');
    const est = estimateTokens(req.system + req.prompt);
    const base = {
      jobId: req.jobId, bookId: req.bookId, roleCode: req.roleCode, teamCode: req.teamCode,
      keyId: key.keyId, projectId: key.projectId, modelId: model.modelId,
      promptHash, promptVersion: req.promptVersion,
    };

    // Local, project-wide pre-check: wait in the queue rather than earn a 429.
    const gate = this.limiter.tryAcquire(model.modelId, est);
    if (!gate.ok) {
      throw new QuotaExhaustedError(`Project ${gate.reason.toUpperCase()} limit reached for ${model.modelId}`,
        Math.ceil(gate.waitMs / 1000));
    }

    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      let r;
      try {
        r = await callGemini({ apiKey: secret, modelId: model.modelId, system: req.system, prompt: req.prompt,
                               jsonSchema: req.jsonSchema, maxOutputTokens: req.maxOutputTokens },
                             this.opts.fetchImpl);
      } catch (e: any) {
        r = { httpStatus: 0, text: '', inputTokens: 0, outputTokens: 0, errorMessage: String(e?.message ?? e) };
      }
      const latencyMs = Date.now() - t0;

      if (r.httpStatus === 200) {
        const cost = (r.inputTokens * model.inputPricePerMTok + r.outputTokens * model.outputPricePerMTok) / 1e6;
        let status: 'ok' | 'schema_invalid' = 'ok';
        if (req.jsonSchema) { try { JSON.parse(r.text); } catch { status = 'schema_invalid'; } }
        this.limiter.settle(model.modelId, est, r.inputTokens);
        await this.store.recordRun({ ...base, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          costEstimate: cost, latencyMs, status, httpStatus: 200 });
        if (status === 'schema_invalid') throw new Error('Model output was not valid JSON for the role schema.');
        return { text: r.text, modelId: model.modelId, inputTokens: r.inputTokens,
                 outputTokens: r.outputTokens, costEstimate: cost, keyLabel: key.label };
      }

      if (r.httpStatus === 429) {
        await this.store.recordRun({ ...base, inputTokens: 0, outputTokens: 0, costEstimate: 0, latencyMs,
          status: 'rate_limited', httpStatus: 429, error: r.errorMessage });
        throw new QuotaExhaustedError(`Gemini project quota reached (key ${key.label}): ${r.errorMessage}`,
          r.retryAfterSeconds ?? 60);
      }

      const transient = r.httpStatus === 0 || r.httpStatus >= 500;
      await this.store.recordRun({ ...base, inputTokens: 0, outputTokens: 0, costEstimate: 0, latencyMs,
        status: 'error', httpStatus: r.httpStatus || undefined, error: r.errorMessage });
      if (!transient || attempt > this.opts.maxTransientRetries) {
        throw new Error(`Gemini call failed (HTTP ${r.httpStatus}): ${r.errorMessage}`);
      }
      await this.opts.sleepImpl(backoffMs(attempt, 2000, 16_000, this.opts.rand));
    }
  }
}
