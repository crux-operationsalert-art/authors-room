/**
 * One-time key loader. Reads Gemini keys from STDIN (never from arguments or
 * files in the repo), stores each in Supabase Vault and assigns teams.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   GEMINI_PROJECT_LABEL="Author's Room" GEMINI_PROJECT_REF="my-project" GEMINI_USAGE_TIER=tier1 \
 *   npm run load-keys            # then paste keys, one per line, and press Ctrl-D
 *
 * Optional per line:  <key> <team>      e.g.  AQ.xxxx editorial
 * Without a team, keys are assigned in this order, then kept as standby:
 *   orchestration, ideation, writing, editorial, readers, assurance, publishing, retrieval
 *
 * IMPORTANT: load only keys from the ONE Gemini project the app uses. Quota is
 * per project; keys from other projects do not belong here (Google terms, D-01).
 */
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline';

const TEAM_ORDER = ['orchestration','ideation','writing','editorial','readers','assurance','publishing','retrieval'];

async function main() {
  const url = process.env.SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const app = createClient(url, svc, { auth: { persistSession: false } }).schema('app');

  const { error: pErr } = await app.rpc('admin_set_project', {
    p_label: process.env.GEMINI_PROJECT_LABEL ?? "Author's Room",
    p_google_ref: process.env.GEMINI_PROJECT_REF ?? null,
    p_tier: process.env.GEMINI_USAGE_TIER ?? 'free',
  });
  if (pErr) throw pErr;

  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const t = line.trim().replace(/^\d+\)\s*/, '');   // accepts "1) AQ...." too
    if (t) lines.push(t);
  }
  let i = 0;
  for (const line of lines) {
    const [secret, teamArg] = line.split(/\s+/);
    if (!/^AQ\.[A-Za-z0-9_\-]{20,}$/.test(secret)) { console.warn(`skipped a line that is not an auth key (…${secret.slice(-4)})`); continue; }
    const label = `K${String(++i).padStart(2, '0')}`;
    const team = teamArg ?? TEAM_ORDER[i - 1] ?? null;
    const { error } = await app.rpc('admin_add_ai_key', { p_label: label, p_secret: secret, p_team_code: team });
    if (error) console.error(`${label} (…${secret.slice(-4)}): ${error.message}`);
    else console.log(`${label} (…${secret.slice(-4)}) → ${team ?? 'standby'}`);
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
