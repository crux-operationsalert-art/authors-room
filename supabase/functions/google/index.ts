// Google account connector (Document 4, Part H §23): OAuth connect, project and key discovery, and supported provisioning.
// Uses only official APIs: Cloud Resource Manager v3, Service Usage v1, API Keys v2, Cloud Billing v1.
// Never: new Google account sign-ups, bypassing verification, or using extra free projects to add quota.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const FN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google`;
const APP_URL = 'https://crux-operationsalert-art.github.io/authors-room/resources/';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'];
const GEMINI_API = 'generativelanguage.googleapis.com';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const app = db.schema('app');

  // ---- OAuth redirect back from Google (GET ?code&state)
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const code = u.searchParams.get('code'), state = u.searchParams.get('state'), err = u.searchParams.get('error');
    const back = (q: string) => Response.redirect(`${APP_URL}?${q}`, 302);
    if (err) return back(`google=${encodeURIComponent(err)}`);
    if (!code || !state) return back('google=missing_code');
    const { data: st } = await app.from('oauth_states').select('*').eq('state', state).maybeSingle();
    await app.from('oauth_states').delete().eq('state', state);
    if (!st || Date.now() - Date.parse((st as any).created_at) > 15 * 60_000) return back('google=expired');
    const { clientId, secret } = await client(app);
    const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: FN_URL, grant_type: 'authorization_code' }) })).json();
    if (!tok.refresh_token) { await log(db, null, 'connect', 'Google account', 'error', tok.error_description ?? tok.error ?? 'no refresh token returned'); return back('google=token_error'); }
    const email = idTokenEmail(tok.id_token);
    const { data: acc, error } = await app.rpc('store_oauth_account', { p_label: mask(email), p_refresh_token: tok.refresh_token, p_scopes: String(tok.scope ?? '').split(' ') });
    if (error) return back('google=store_error');
    return back(`google=connected&account=${acc}`);
  }

  // ---- signed-in author only
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const { data: u } = jwt ? await db.auth.getUser(jwt) : { data: null };
  if (!u?.user) return json({ error: 'sign in first' }, 401);
  const { data: author } = await db.from('authors').select('id').eq('auth_user_id', u.user.id).maybeSingle();
  if (!author) return json({ error: 'not allowed' }, 403);
  const body = await req.json().catch(() => ({}));

  try {
    if (body.action === 'start') {
      await client(app);   // fails clearly if the OAuth client is not configured
      const state = crypto.randomUUID() + crypto.randomUUID();
      await app.from('oauth_states').insert({ state, author_auth_id: u.user.id });
      const { clientId } = await client(app);
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: clientId, redirect_uri: FN_URL,
        response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
      return json({ url, redirect_uri: FN_URL });
    }
    if (body.action === 'discover') return json(await discover(db, String(body.account_id)));
    if (body.action === 'provision') return json(await provision(db, body));
    if (body.action === 'disconnect') return json(await disconnect(db, String(body.account_id)));
    return json({ error: 'unknown action' }, 400);
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, 400); }
});

// ------------------------------------------------------------------ helpers
async function client(app: any) {
  const { data: id } = await app.from('settings').select('value').eq('key', 'google_oauth_client_id').maybeSingle();
  const { data: secret } = await app.rpc('google_client_secret');
  if (!id?.value || !secret) throw new Error('Set up the Google OAuth client first (Resources page, step 1).');
  return { clientId: String(id.value), secret: String(secret) };
}
function idTokenEmail(t?: string) {
  try { return JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? 'Google account'; } catch { return 'Google account'; }
}
// Only a masked form of the account email is stored (e.g. s•••@gmail.com).
function mask(email: string) { const [n, d] = email.split('@'); return d ? `${n.slice(0, 1)}•••@${d}` : email; }
async function log(db: SupabaseClient, account: string | null, operation: string, target: string, status: string, detail: string) {
  await db.from('provisioning_log').insert({ account_id: account, operation, target, status, detail: detail.slice(0, 500) });
}
async function accessToken(db: SupabaseClient, account: string) {
  const app = db.schema('app');
  const { data: refresh } = await app.rpc('oauth_refresh_token', { p_account: account });
  if (!refresh) throw new Error('This Google account is not connected.');
  const { clientId, secret } = await client(app);
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: String(refresh), client_id: clientId, client_secret: secret, grant_type: 'refresh_token' }) })).json();
  if (!t.access_token) {
    await db.from('ai_accounts').update({ oauth_status: 'error' }).eq('id', account);
    throw new Error(`Google refused the sign-in (${t.error ?? 'unknown'}). Reconnect the account.`);
  }
  return String(t.access_token);
}
async function g(token: string, url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
async function waitOp(token: string, base: string, op: any, tries = 20) {
  let o = op;
  for (let i = 0; i < tries && o?.name && !o.done; i++) { await new Promise(r => setTimeout(r, 2000)); o = (await g(token, `${base}/${o.name}`)).j; }
  if (o?.error) throw new Error(o.error.message ?? 'operation failed');
  return o;
}

// Discover projects, Gemini API state, billing, keys; verify which project each stored key belongs to (lookupKey).
async function discover(db: SupabaseClient, account: string) {
  const app = db.schema('app');
  const token = await accessToken(db, account);
  await log(db, account, 'discover', 'projects', 'started', 'listing projects');
  const projects: any[] = []; let page = '';
  do {
    const r = await g(token, `https://cloudresourcemanager.googleapis.com/v3/projects:search?pageSize=100${page ? `&pageToken=${page}` : ''}`);
    if (!r.ok) { await log(db, account, 'discover', 'projects', 'error', r.j?.error?.message ?? `HTTP ${r.status}`); throw new Error(r.j?.error?.message ?? 'project listing failed'); }
    projects.push(...(r.j.projects ?? []).filter((p: any) => p.state === 'ACTIVE')); page = r.j.nextPageToken ?? '';
  } while (page);
  const out: any[] = [];
  for (const p of projects) {
    const number = String(p.name).replace('projects/', '');
    const [svc, bill, keys] = await Promise.all([
      g(token, `https://serviceusage.googleapis.com/v1/projects/${number}/services/${GEMINI_API}`),
      g(token, `https://cloudbilling.googleapis.com/v1/projects/${p.projectId}/billingInfo`),
      g(token, `https://apikeys.googleapis.com/v2/projects/${p.projectId}/locations/global/keys`)]);
    const apiEnabled = svc.ok ? svc.j.state === 'ENABLED' : null;
    const billing = bill.ok ? !!bill.j.billingEnabled : null;
    const { data: existing } = await db.from('ai_projects').select('id, routing_eligible, eligibility_reason').eq('google_project_ref', p.projectId).maybeSingle();
    const row = { label: p.displayName ?? p.projectId, google_project_ref: p.projectId, project_number: number, display_name: p.displayName ?? null,
      billing_enabled: billing, api_enabled: apiEnabled, account_id: account, verified_at: new Date().toISOString(), discovery_source: 'oauth',
      usage_tier: billing ? 'paid' : 'free' };
    if (existing) await db.from('ai_projects').update(row).eq('id', existing.id);
    else await db.from('ai_projects').insert({ ...row, is_active: false, routing_eligible: false,
      eligibility_reason: billing ? 'billing enabled: needs the author\'s authorisation for paid use' : 'free project: inventoried, not used to add quota' });
    out.push({ project: p.projectId, number, api_enabled: apiEnabled, billing_enabled: billing, keys_in_google: keys.ok ? (keys.j.keys ?? []).length : null });
  }
  // Which project does each stored Gemini key belong to? (API Keys lookupKey; returns the owning project when you have access)
  const { data: mine } = await db.from('ai_keys').select('id, label, provider, status').eq('provider', 'gemini').neq('status', 'revoked');
  let verified = 0, unknown = 0;
  for (const k of mine ?? []) {
    const { data: secret } = await app.rpc('get_key_secret', { p_key_id: k.id });
    if (!secret) continue;
    const r = await g(token, `https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=${encodeURIComponent(String(secret))}`);
    if (!r.ok) { unknown++; continue; }
    const number = String(r.j.parent ?? '').split('/')[1];
    const { data: proj } = await db.from('ai_projects').select('id, google_project_ref').eq('project_number', number).maybeSingle();
    if (proj) {
      await db.from('ai_keys').update({ project_id: proj.id, ownership: 'verified_oauth', project_confirmed: true,
        google_key_name: r.j.name ?? null, last_verified_at: new Date().toISOString() }).eq('id', k.id);
      verified++;
    } else unknown++;
  }
  await db.from('ai_accounts').update({ last_discovery_at: new Date().toISOString() }).eq('id', account);
  await log(db, account, 'discover', 'projects and keys', 'ok', `${projects.length} projects; ${verified} keys verified with Google; ${unknown} keys not in this account's projects`);
  return { projects: out, keys_verified: verified, keys_not_found: unknown };
}

// Provisioning: every operation needs confirm=true and is logged. Policy checks first.
async function provision(db: SupabaseClient, b: any) {
  const account = String(b.account_id), op = String(b.op), ref = String(b.project_ref ?? '');
  if (b.confirm !== true) throw new Error('Confirm the operation first.');
  const token = await accessToken(db, account);
  const refuse = async (why: string) => { await log(db, account, op, ref, 'refused', why); throw new Error(why); };

  if (op === 'create_project') {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(ref)) await refuse('Project ID must be 6-30 lowercase letters, digits or hyphens, starting with a letter.');
    if (b.will_enable_billing !== true) await refuse('A new free project would only add free quota, which Google\'s terms do not allow, so it would never be used. Create it only if you will enable billing on it.');
    await log(db, account, op, ref, 'started', 'creating project');
    const r = await g(token, 'https://cloudresourcemanager.googleapis.com/v3/projects', { method: 'POST', body: JSON.stringify({ projectId: ref, displayName: String(b.display_name ?? ref).slice(0, 30) }) });
    if (!r.ok) { await log(db, account, op, ref, 'error', r.j?.error?.message ?? `HTTP ${r.status}`); throw new Error(r.j?.error?.message ?? 'create failed'); }
    await waitOp(token, 'https://cloudresourcemanager.googleapis.com/v3', r.j);
    await log(db, account, op, ref, 'ok', 'project created; enable billing in Google Cloud Console, then run discovery');
    return { created: ref };
  }
  if (op === 'enable_api') {
    await log(db, account, op, ref, 'started', `enabling ${GEMINI_API}`);
    const r = await g(token, `https://serviceusage.googleapis.com/v1/projects/${ref}/services/${GEMINI_API}:enable`, { method: 'POST', body: '{}' });
    if (!r.ok) { await log(db, account, op, ref, 'error', r.j?.error?.message ?? `HTTP ${r.status}`); throw new Error(r.j?.error?.message ?? 'enable failed'); }
    await waitOp(token, 'https://serviceusage.googleapis.com/v1', r.j);
    await db.from('ai_projects').update({ api_enabled: true }).eq('google_project_ref', ref);
    await log(db, account, op, ref, 'ok', 'Gemini API enabled');
    return { enabled: ref };
  }
  if (op === 'create_key') {
    const { data: proj } = await db.from('ai_projects').select('id, project_number').eq('google_project_ref', ref).maybeSingle();
    if (!proj) await refuse('Run discovery first so the project is known.');
    const { count } = await db.from('ai_keys').select('id', { count: 'exact', head: true }).eq('project_id', proj!.id).eq('status', 'active');
    if ((count ?? 0) > 0) await refuse('This project already has an active key. Extra keys in one project share the same quota, so another one adds nothing.');
    await log(db, account, op, ref, 'started', 'creating a key restricted to the Gemini API');
    const r = await g(token, `https://apikeys.googleapis.com/v2/projects/${ref}/locations/global/keys`, { method: 'POST',
      body: JSON.stringify({ displayName: "Author's Room", restrictions: { apiTargets: [{ service: GEMINI_API }] } }) });
    if (!r.ok) { await log(db, account, op, ref, 'error', r.j?.error?.message ?? `HTTP ${r.status}`); throw new Error(r.j?.error?.message ?? 'key create failed'); }
    const done = await waitOp(token, 'https://apikeys.googleapis.com/v2', r.j);
    const keyName = done?.response?.name;
    const ks = await g(token, `https://apikeys.googleapis.com/v2/${keyName}/keyString`);
    if (!ks.ok || !ks.j.keyString) { await log(db, account, op, ref, 'error', 'key created but its value could not be read'); throw new Error('Key created but its value could not be read.'); }
    const { error } = await db.schema('app').rpc('register_verified_key', { p_secret: ks.j.keyString, p_project: proj!.id, p_google_key_name: keyName, p_alias: `${ref} key` });
    if (error) throw new Error(error.message);
    await log(db, account, op, ref, 'ok', 'key created, stored encrypted, verified with Google (not routed until the project is eligible)');
    return { key_created: true };
  }
  await refuse(`Unknown operation ${op}`);
}

async function disconnect(db: SupabaseClient, account: string) {
  const app = db.schema('app');
  const { data: refresh } = await app.rpc('oauth_refresh_token', { p_account: account });
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(String(refresh))}`, { method: 'POST' });
  await db.from('ai_accounts').update({ oauth_status: 'revoked' }).eq('id', account);
  await log(db, account, 'disconnect', 'Google account', 'ok', 'access revoked at the author\'s request; projects and keys stay in the inventory');
  return { disconnected: true };
}
