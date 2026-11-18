import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ModelEntry, ProjectInfo, ResolvedKey, RunRecord, Store, TeamCode, Tier } from '../ai/types.js';

/** Store backed by Supabase, using the service role (server-side only). */
export class SupabaseStore implements Store {
  readonly db: SupabaseClient;
  readonly app: ReturnType<SupabaseClient['schema']>;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
    this.app = this.db.schema('app');
  }

  async resolveKeyForTeam(team: TeamCode): Promise<ResolvedKey | null> {
    const { data, error } = await this.app.rpc('resolve_key_for_team', { p_team_code: team });
    if (error) throw error;
    const row = (data as any[])?.[0];
    return row ? { keyId: row.key_id, projectId: row.project_id, label: row.label } : null;
  }

  async getKeySecret(keyId: string): Promise<string | null> {
    const { data, error } = await this.app.rpc('get_key_secret', { p_key_id: keyId });
    if (error) throw error;
    return (data as string) ?? null;
  }

  async getActiveProject(): Promise<ProjectInfo> {
    const { data: p, error } = await this.db.from('ai_projects').select('id, usage_tier').eq('is_active', true).single();
    if (error) throw new Error('No active Gemini project. Run the key loader first.');
    const { data: lims } = await this.db.from('project_model_limits').select('*').eq('project_id', p.id);
    const limits: ProjectInfo['limits'] = {};
    for (const l of lims ?? []) limits[l.model_id] = { rpm: l.rpm ?? undefined, tpm: l.tpm ?? undefined, rpd: l.rpd ?? undefined };
    return { projectId: p.id, usageTier: p.usage_tier, limits };
  }

  async getModelForTier(tier: Tier): Promise<ModelEntry> {
    const { data, error } = await this.db.from('model_registry')
      .select('model_id, tier, input_price_per_mtok, output_price_per_mtok')
      .eq('tier', tier).eq('enabled', true).single();
    if (error || !data) throw new Error(`No enabled model for tier "${tier}" in model_registry.`);
    return { modelId: data.model_id, tier: data.tier, inputPricePerMTok: Number(data.input_price_per_mtok),
             outputPricePerMTok: Number(data.output_price_per_mtok) };
  }

  async getRequestsToday(_projectId: string, modelId: string): Promise<number> {
    const { data } = await this.db.from('v_project_quota').select('requests_today').eq('model_id', modelId).maybeSingle();
    return Number(data?.requests_today ?? 0);
  }

  async getBookPrivacy(bookId: string) {
    const { data } = await this.db.from('books').select('privacy_mode').eq('id', bookId).single();
    return (data?.privacy_mode ?? 'confidential') as 'confidential' | 'standard';
  }

  async getCostTodayUsd(): Promise<number> {
    const { data } = await this.app.rpc('cost_today_usd');
    return Number(data ?? 0);
  }

  async recordRun(r: RunRecord): Promise<void> {
    const { error } = await this.db.from('agent_runs').insert({
      job_id: r.jobId ?? null, book_id: r.bookId ?? null, role_code: r.roleCode, team_code: r.teamCode,
      key_id: r.keyId ?? null, project_id: r.projectId ?? null, model_id: r.modelId,
      prompt_hash: r.promptHash, prompt_version: r.promptVersion ?? null,
      input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_estimate: r.costEstimate,
      latency_ms: r.latencyMs, status: r.status, http_status: r.httpStatus ?? null, error: r.error ?? null,
    });
    if (error) console.error('ledger write failed', error.message);
  }
}
