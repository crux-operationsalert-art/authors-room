/** Thin Gemini REST client (native endpoint; works with auth keys). */
export interface GeminiCall {
  apiKey: string;
  modelId: string;
  system: string;
  prompt: string;
  jsonSchema?: object;
  maxOutputTokens?: number;
}

export interface GeminiResponse {
  httpStatus: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  retryAfterSeconds?: number;
  errorMessage?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<any> }>;

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function callGemini(c: GeminiCall, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<GeminiResponse> {
  const body: any = {
    systemInstruction: { parts: [{ text: c.system }] },
    contents: [{ role: 'user', parts: [{ text: c.prompt }] }],
    generationConfig: { maxOutputTokens: c.maxOutputTokens ?? 2048 },
  };
  if (c.jsonSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = c.jsonSchema;
  }
  const res = await fetchImpl(`${BASE}/${encodeURIComponent(c.modelId)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch { /* empty body */ }
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  if (res.status !== 200) {
    return { httpStatus: res.status, text: '', inputTokens: 0, outputTokens: 0,
             retryAfterSeconds: retryAfter, errorMessage: json?.error?.message ?? `HTTP ${res.status}` };
  }
  const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const u = json?.usageMetadata ?? {};
  return { httpStatus: 200, text,
           inputTokens: u.promptTokenCount ?? 0,
           outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}
