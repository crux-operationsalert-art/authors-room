export type Tier = 'fast' | 'standard' | 'deep' | 'embedding';
export type TeamCode =
  | 'orchestration' | 'ideation' | 'writing' | 'editorial'
  | 'readers' | 'assurance' | 'publishing' | 'retrieval';

export interface ModelEntry {
  modelId: string;
  tier: Tier;
  inputPricePerMTok: number;   // USD per 1M input tokens
  outputPricePerMTok: number;  // USD per 1M output tokens
}

export interface ResolvedKey {
  keyId: string;
  projectId: string;
  label: string;
}

export interface ProjectInfo {
  projectId: string;
  usageTier: 'free' | 'tier1' | 'tier2' | 'tier3';
  limits: Record<string, { rpm?: number; tpm?: number; rpd?: number }>; // by modelId
}

export interface RunRecord {
  jobId?: string;
  bookId?: string;
  roleCode: string;
  teamCode: TeamCode;
  keyId?: string;
  projectId?: string;
  modelId: string;
  promptHash: string;
  promptVersion?: string;
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
  latencyMs: number;
  status: 'ok' | 'rate_limited' | 'error' | 'schema_invalid';
  httpStatus?: number;
  error?: string;
}

/** Everything the request manager needs from the database. */
export interface Store {
  resolveKeyForTeam(team: TeamCode): Promise<ResolvedKey | null>;
  getKeySecret(keyId: string): Promise<string | null>;
  getActiveProject(): Promise<ProjectInfo>;
  getModelForTier(tier: Tier): Promise<ModelEntry>;
  getRequestsToday(projectId: string, modelId: string): Promise<number>;
  getBookPrivacy(bookId: string): Promise<'confidential' | 'standard'>;
  getCostTodayUsd(): Promise<number>;
  recordRun(run: RunRecord): Promise<void>;
}

export interface GenerateRequest {
  roleCode: string;
  teamCode: TeamCode;
  tier: Tier;
  bookId?: string;
  jobId?: string;
  system: string;
  prompt: string;
  promptVersion?: string;
  jsonSchema?: object;      // when set, ask for JSON output
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
  keyLabel: string;
}

/** The project is out of quota: the job must wait. Another key will not help. */
export class QuotaExhaustedError extends Error {
  constructor(message: string, public retryAfterSeconds: number) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

/** Refused before any call (privacy, missing key, cost cap). Not retried. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}
