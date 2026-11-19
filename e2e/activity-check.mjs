// Visual check of the Live activity panel with mocked data (no real account needed).
import { chromium } from 'playwright';
const BOOK = '11111111-1111-1111-1111-111111111111';
const now = Date.now(), ago = s => new Date(now - s * 1000).toISOString(), ahead = s => new Date(now + s * 1000).toISOString();
const scenario = process.argv[2] ?? 'idle';

const jobsDone = [
  { id: 'j6', workflow: 'bible', step: 'seed', role_code: 'story_architect', status: 'done', attempts: 1, payload: {}, result: { entities: 7, facts: 12 }, last_error: null, created_at: ago(700), updated_at: ago(640), locked_at: ago(670), run_after: null },
  { id: 'j5', workflow: 'constitution', step: 'draft', role_code: 'chief_editor', status: 'done', attempts: 2, payload: {}, result: { proposed: true }, last_error: null, created_at: ago(1100), updated_at: ago(680), locked_at: ago(700), run_after: null },
  { id: 'j4', workflow: 'genre', step: 'directions', role_code: 'genre_strategist', status: 'done', attempts: 1, payload: {}, result: { directions: 3 }, last_error: null, created_at: ago(1200), updated_at: ago(1150), locked_at: ago(1190), run_after: null },
  { id: 'j3', workflow: 'intake', step: 'interview', role_code: 'author_interviewer', status: 'done', attempts: 1, payload: {}, result: { ready: true }, last_error: null, created_at: ago(1250), updated_at: ago(1240), locked_at: ago(1248), run_after: null },
];
const runs = [
  { job_id: 'j6', role_code: 'story_architect', model_id: 'gemini-2.5-flash', input_tokens: 1800, output_tokens: 2400, latency_ms: 31000, status: 'ok', created_at: ago(640) },
  { job_id: 'j5', role_code: 'chief_editor', model_id: 'gemini-2.5-flash', input_tokens: 0, output_tokens: 0, latency_ms: 400, status: 'rate_limited', created_at: ago(1090) },
  { job_id: 'j5', role_code: 'chief_editor', model_id: 'gemini-2.5-flash', input_tokens: 1500, output_tokens: 900, latency_ms: 22000, status: 'ok', created_at: ago(680) },
  { job_id: 'j4', role_code: 'genre_strategist', model_id: 'gemini-2.5-flash', input_tokens: 1300, output_tokens: 1700, latency_ms: 36000, status: 'ok', created_at: ago(1150) },
  { job_id: 'j3', role_code: 'author_interviewer', model_id: 'gemini-2.5-flash', input_tokens: 900, output_tokens: 300, latency_ms: 8000, status: 'ok', created_at: ago(1240) },
];
let jobs = jobsDone, active = [], blocks = [], status = 'planning';
if (scenario === 'busy') {
  status = 'writing';
  const running = { id: 'j8', workflow: 'paragraph', step: 'review', role_code: 'continuity_manager', status: 'running', attempts: 1, payload: { loop: 0 }, result: null, last_error: null, created_at: ago(60), updated_at: ago(23), locked_at: ago(23), run_after: null };
  const wait = { id: 'j9', workflow: 'paragraph', step: 'review', role_code: 'reader_panel_manager', status: 'waiting_quota', attempts: 1, payload: {}, result: null, last_error: 'quota', created_at: ago(60), updated_at: ago(20), locked_at: null, run_after: ahead(185) };
  const q = ['voice_custodian', 'line_copy_editor'].map((r, i) => ({ id: 'q' + i, workflow: 'paragraph', step: 'review', role_code: r, status: 'queued', attempts: 0, payload: {}, result: null, last_error: null, created_at: ago(60), updated_at: ago(60), locked_at: null, run_after: null }));
  const drafted = { id: 'j7', workflow: 'paragraph', step: 'draft', role_code: 'lead_writer', status: 'done', attempts: 1, payload: {}, result: { chars: 812 }, last_error: null, created_at: ago(120), updated_at: ago(62), locked_at: ago(100), run_after: null };
  jobs = [running, wait, ...q, drafted, ...jobsDone];
  active = [running, wait, ...q];
  blocks = [{ id: 'b1', order_key: 'a0', status: 'in_review', current_version_id: 'v1', block_versions: { text: 'Listen. Before we begin, a confession…', version_no: 1, provenance: 'ai_generated' } }];
}
const tables = {
  books: { id: BOOK, working_title: 'Love.. Du', status, privacy_mode: 'standard' },
  intake_messages: [{ id: 'm1', role: 'author', content: 'My idea…', created_at: ago(1300) }, { id: 'm2', role: 'assistant', content: 'The Book Bible has been seeded.', created_at: ago(640) }],
  decisions: [], book_constitutions: { status: 'approved', premise: 'A witty guide…', genre: 'Humour', subgenre: 'Satire', audience: 'Adults', themes: ['work'], pov: 'Second person', tense: 'Present', voice: 'Irreverent', ending_intent: 'Uplifting', length_target: 'As needed', never_change: [], original_idea: '…' },
  entities: Array.from({ length: 7 }, (_, i) => ({ type: 'concept', name: 'Entry ' + i, profile: { summary: '…' } })),
  manuscript_blocks: blocks, editorial_issues: [], review_runs: [], agent_runs: runs,
};

const browser = await chromium.launch();
for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/rest/v1/**', route => {
    const u = new URL(route.request().url()); const t = u.pathname.split('/').pop();
    let body = tables[t] ?? [];
    if (t === 'agent_jobs') body = u.searchParams.get('select')?.startsWith('id,') ? jobs : active;
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(single ? (Array.isArray(body) ? body[0] ?? null : body) : (Array.isArray(body) ? body : [body])) });
  });
  await page.route('**/functions/v1/**', r => r.fulfill({ status: 200, body: '{}' }));
  await page.goto(`http://localhost:3001/book/?id=${BOOK}`);
  await page.getByText('Live activity').waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/home/claude/e2e/shots/activity-${scenario}-${tag}.png`, fullPage: tag === 'desktop' ? false : false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(scenario, tag, 'sideways overflow:', overflow);
  if (scenario === 'idle' && tag === 'desktop') {
    await page.getByRole('button', { name: 'Show me' }).click(); await page.waitForTimeout(1200);
    await page.screenshot({ path: `/home/claude/e2e/shots/activity-showme.png` });
  }
  await page.close();
}
await browser.close();
