import { describe, expect, it } from 'vitest';
import { AIRequestManager } from '../src/ai/requestManager.js';
import { ProjectRateLimiter } from '../src/ai/rateLimiter.js';
import { backoffMs } from '../src/ai/backoff.js';
import { PolicyError, QuotaExhaustedError, RunRecord, Store, TeamCode } from '../src/ai/types.js';
import type { FetchLike } from '../src/ai/gemini.js';

const KEYS: Record<string, { keyId: string; label: string; secret: string }> = {
  writing:   { keyId: 'k-w', label: 'K03', secret: 'AQ.secret-writing' },
  editorial: { keyId: 'k-e', label: 'K04', secret: 'AQ.secret-editorial' },
};

function makeStore(over: Partial<Store> = {}, tier: 'free' | 'tier1' = 'tier1') {
  const runs: RunRecord[] = [];
  const store: Store = {
    resolveKeyForTeam: async (t: TeamCode) => KEYS[t] ? { keyId: KEYS[t].keyId, projectId: 'p1', label: KEYS[t].label } : null,
    getKeySecret: async id => Object.values(KEYS).find(k => k.keyId === id)?.secret ?? null,
    getActiveProject: async () => ({ projectId: 'p1', usageTier: tier, limits: {} }),
    getModelForTier: async t => ({ modelId: `model-${t}`, tier: t, inputPricePerMTok: 1, outputPricePerMTok: 4 }),
    getRequestsToday: async () => 0,
    getBookPrivacy: async () => 'confidential',
    getCostTodayUsd: async () => 0,
    recordRun: async r => { runs.push(r); },
    ...over,
  };
  return { store, runs };
}

function fakeFetch(responses: Array<{ status: number; body?: any; retryAfter?: string }>) {
  const calls: { url: string; key: string }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, key: init.headers['x-goog-api-key'] });
    const r = responses.shift() ?? { status: 200, body: ok('OK') };
    return { status: r.status, headers: { get: (n: string) => (n === 'retry-after' ? r.retryAfter ?? null : null) },
             json: async () => r.body ?? {} };
  };
  return { f, calls };
}
const ok = (text: string, inTok = 1000, outTok = 100) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok },
});
const req = (team: TeamCode = 'writing') => ({
  roleCode: 'lead_writer', teamCode: team, tier: 'standard' as const, bookId: 'b1',
  system: 'sys', prompt: 'Write one paragraph.',
});
const noSleep = async () => {};

describe('AIRequestManager', () => {
  it('uses the team key, the tier model, and records tokens and cost', async () => {
    const { store, runs } = makeStore();
    const { f, calls } = fakeFetch([{ status: 200, body: ok('A paragraph.', 2000, 500) }]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}), { fetchImpl: f, sleepImpl: noSleep });
    const r = await m.generate(req('editorial'));
    expect(r.text).toBe('A paragraph.');
    expect(calls[0].key).toBe('AQ.secret-editorial');
    expect(calls[0].url).toContain('model-standard:generateContent');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', keyId: 'k-e', teamCode: 'editorial', inputTokens: 2000, outputTokens: 500 });
    expect(r.costEstimate).toBeCloseTo((2000 * 1 + 500 * 4) / 1e6);
  });

  it('on 429 records it and waits — it never retries with another key', async () => {
    const { store, runs } = makeStore();
    const { f, calls } = fakeFetch([{ status: 429, body: { error: { message: 'quota' } }, retryAfter: '42' }]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}), { fetchImpl: f, sleepImpl: noSleep });
    const err = await m.generate(req()).catch(e => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect(err.retryAfterSeconds).toBe(42);
    expect(calls).toHaveLength(1);                     // exactly one call, one key
    expect(runs.map(r => r.status)).toEqual(['rate_limited']);
  });

  it('retries 5xx with backoff on the same key, then succeeds', async () => {
    const { store, runs } = makeStore();
    const slept: number[] = [];
    const { f, calls } = fakeFetch([{ status: 503 }, { status: 500 }, { status: 200, body: ok('done') }]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}),
      { fetchImpl: f, sleepImpl: async ms => { slept.push(ms); }, rand: () => 1 });
    const r = await m.generate(req());
    expect(r.text).toBe('done');
    expect(new Set(calls.map(c => c.key))).toEqual(new Set(['AQ.secret-writing']));
    expect(slept).toEqual([2000, 4000]);
    expect(runs.map(x => x.status)).toEqual(['error', 'error', 'ok']);
  });

  it('refuses a confidential book on a free-tier project before calling', async () => {
    const { store } = makeStore({}, 'free');
    const { f, calls } = fakeFetch([]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}), { fetchImpl: f, sleepImpl: noSleep });
    await expect(m.generate(req())).rejects.toBeInstanceOf(PolicyError);
    expect(calls).toHaveLength(0);
  });

  it('stops at the daily cost cap', async () => {
    const { store } = makeStore({ getCostTodayUsd: async () => 5 });
    const { f, calls } = fakeFetch([]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}), { fetchImpl: f, dailyCostCapUsd: 5 });
    await expect(m.generate(req())).rejects.toThrow(/cost cap/);
    expect(calls).toHaveLength(0);
  });

  it('project limiter is shared across teams/keys: RPM blocks the second team too', async () => {
    const { store } = makeStore();
    const { f, calls } = fakeFetch([{ status: 200, body: ok('1') }]);
    const limiter = new ProjectRateLimiter({ 'model-standard': { rpm: 1 } });
    const m = new AIRequestManager(store, limiter, { fetchImpl: f, sleepImpl: noSleep });
    await m.generate(req('writing'));
    const err = await m.generate(req('editorial')).catch(e => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toHaveLength(1);
  });

  it('flags invalid JSON when a schema was requested', async () => {
    const { store, runs } = makeStore();
    const { f } = fakeFetch([{ status: 200, body: ok('not json') }]);
    const m = new AIRequestManager(store, new ProjectRateLimiter({}), { fetchImpl: f, sleepImpl: noSleep });
    await expect(m.generate({ ...req(), jsonSchema: { type: 'object' } })).rejects.toThrow(/valid JSON/);
    expect(runs[0].status).toBe('schema_invalid');
  });
});

describe('ProjectRateLimiter', () => {
  it('enforces RPD per Pacific day and resets the next day', () => {
    let now = Date.parse('2026-11-18T10:00:00-08:00');
    const l = new ProjectRateLimiter({ m: { rpd: 2 } }, { now: () => now });
    expect(l.tryAcquire('m', 10).ok).toBe(true);
    expect(l.tryAcquire('m', 10).ok).toBe(true);
    const d = l.tryAcquire('m', 10);
    expect(d.ok).toBe(false);
    if (!d.ok) { expect(d.reason).toBe('rpd'); expect(d.waitMs).toBe(14 * 3600 * 1000); }
    now = Date.parse('2026-11-19T00:00:05-08:00');
    expect(l.tryAcquire('m', 10).ok).toBe(true);
  });

  it('enforces TPM in a 60-second window', () => {
    let now = 0;
    const l = new ProjectRateLimiter({ m: { tpm: 1000 } }, { now: () => now });
    expect(l.tryAcquire('m', 800).ok).toBe(true);
    expect(l.tryAcquire('m', 300).ok).toBe(false);
    now = 61_000;
    expect(l.tryAcquire('m', 300).ok).toBe(true);
  });
});

describe('backoff', () => {
  it('doubles and caps at 16s', () => {
    const top = (a: number) => backoffMs(a, 2000, 16_000, () => 1);
    expect([1, 2, 3, 4, 5, 6].map(top)).toEqual([2000, 4000, 8000, 16000, 16000, 16000]);
  });
});
