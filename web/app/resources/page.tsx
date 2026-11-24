'use client';
// AI Resource Manager (Document 4, Part H): Google account -> projects -> keys -> models -> quota pools,
// with discovery, verified ownership, eligibility, provisioning and a full log. Secrets never reach this page.
import { useCallback, useEffect, useState } from 'react';
import { app, callGoogle, supabaseBrowser } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, input, page } from '../ui';

const FN_REDIRECT = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/google`;
const OWN: Record<string, [string, string]> = { verified_oauth: ['Verified with Google', C.ok], manual: ['Linked by you (not verified)', C.warn], unverified: ['Unverified', C.muted] };
const t = (s?: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export default function Resources() {
  const sb = supabaseBrowser();
  const [status, setStatus] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [keys, setKeys] = useState<any[]>([]);
  const [pools, setPools] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [logRows, setLogRows] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid, setCid] = useState(''); const [csec, setCsec] = useState('');
  const [mref, setMref] = useState(''); const [mlabel, setMlabel] = useState(''); const [mnum, setMnum] = useState('');

  const load = useCallback(async () => {
    const [s, p, k, q, e, l] = await Promise.all([
      app().rpc('google_client_status'),
      sb.from('ai_projects').select('*').order('is_active', { ascending: false }).order('label'),
      app().rpc('key_inventory'), app().rpc('quota_pools'),
      sb.from('quota_events').select('*').order('at', { ascending: false }).limit(15),
      sb.from('provisioning_log').select('*').order('at', { ascending: false }).limit(25)]);
    const firstErr = [s, p, k, q].find(x => x.error)?.error;
    if (firstErr) setErr(firstErr.message);
    setStatus(s.data); setProjects(p.data ?? []); setKeys((k.data ?? []) as any[]); setPools((q.data ?? []) as any[]);
    setEvents(e.data ?? []); setLogRows(l.data ?? []);
  }, [sb]);
  useEffect(() => {
    load();
    const q = new URLSearchParams(location.search).get('google');
    if (q) setMsg(q === 'connected' ? 'Google account connected. Press “Discover projects and keys” next.' : `Google sign-in did not finish (${q}).`);
  }, [load]);

  async function run(p: PromiseLike<{ data?: any; error: any }>, ok?: (d: any) => string) {
    setBusy(true); setErr(null);
    const { data, error } = await p; setBusy(false);
    if (error) setErr(error.message); else { if (ok) setMsg(ok(data)); load(); }
  }

  const google = (status?.accounts ?? []) as any[];
  return (
    <main style={page}>
      <Header><span style={{ fontSize: 13, color: C.muted }}>AI resources</span></Header>
      {err && <p role="alert" style={{ ...card, borderColor: C.bad, color: C.bad }}>{err}</p>}
      {msg && <p role="status" style={{ ...card, borderColor: C.ok }}>{msg}</p>}

      <div style={card}>
        <h2 style={{ marginTop: 0 }}>Google account</h2>
        <p style={{ fontSize: 13, color: C.muted, marginTop: 0 }}>
          Connecting lets the app list your Google Cloud projects, check which project each key belongs to, and create a project or key when you ask.
          Extra free projects are recorded but never used to add free quota (Google's terms do not allow getting around usage limits).
          Paid use needs your explicit authorisation and a budget.
        </p>
        {!status?.client_configured ? (
          <>
            <h3>Step 1: create a Google sign-in client (once)</h3>
            <ol style={{ fontSize: 14, lineHeight: 1.6 }}>
              <li>In Google Cloud Console, pick (or create) a project for this app.</li>
              <li>APIs &amp; Services → Library: enable <b>Cloud Resource Manager API</b>, <b>Service Usage API</b>, <b>API Keys API</b> and <b>Cloud Billing API</b>.</li>
              <li>APIs &amp; Services → OAuth consent screen: External, add yourself as a test user.</li>
              <li>Credentials → Create credentials → OAuth client ID → Web application. Authorised redirect URI:<br />
                <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{FN_REDIRECT}</code></li>
              <li>Paste the client ID and secret below. The secret is stored encrypted on the server and never shown again.</li>
            </ol>
            <input style={input} placeholder="Client ID (…apps.googleusercontent.com)" value={cid} onChange={e => setCid(e.target.value)} aria-label="Client ID" />
            <input style={{ ...input, marginTop: 6 }} type="password" placeholder="Client secret" value={csec} onChange={e => setCsec(e.target.value)} aria-label="Client secret" />
            <button style={{ ...btnPrimary, marginTop: 8 }} disabled={busy || !cid || !csec}
              onClick={() => run(app().rpc('admin_set_google_client', { p_client_id: cid.trim(), p_client_secret: csec.trim() }), () => { setCsec(''); return 'Sign-in client saved.'; })}>Save sign-in client</button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13 }}>Sign-in client: {status.client_id_hint} ✓</p>
            {google.map(a => (
              <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
                <b>{a.label}</b>
                <span style={{ fontSize: 12, color: a.oauth_status === 'connected' ? C.ok : C.warn }}>{a.oauth_status}</span>
                <span style={{ fontSize: 12, color: C.muted }}>last discovery {t(a.last_discovery_at)}</span>
                {a.oauth_status === 'connected' && <>
                  <button style={btnPrimary} disabled={busy} onClick={() => run(callGoogle({ action: 'discover', account_id: a.id }),
                    d => `Found ${d?.projects?.length ?? 0} projects; ${d?.keys_verified ?? 0} of your keys verified with Google; ${d?.keys_not_found ?? 0} not found in this account's projects.`)}>
                    {busy ? 'Working…' : 'Discover projects and keys'}</button>
                  <button style={btn} disabled={busy} onClick={() => { if (confirm('Disconnect this Google account? Its projects and keys stay in the list.')) run(callGoogle({ action: 'disconnect', account_id: a.id }), () => 'Disconnected.'); }}>Disconnect</button>
                </>}
              </div>))}
            <button style={{ ...btn, marginTop: 6 }} disabled={busy} onClick={async () => {
              const { data, error } = await callGoogle({ action: 'start' });
              if (error) setErr(error.message); else location.href = data.url;
            }}>{google.length ? 'Connect another Google account' : 'Connect Google account'}</button>
          </>
        )}
      </div>

      <div style={{ ...card, overflowX: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Projects</h2>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: C.muted }}><th>Project</th><th>Number</th><th>Billing</th><th>Gemini API</th><th>Used by the team</th><th>Source</th><th></th></tr></thead>
          <tbody>{projects.map(p => {
            const acc = google.find(a => a.id === p.account_id && a.oauth_status === 'connected');
            return (
              <tr key={p.id} style={{ borderTop: `1px solid ${C.line}` }}>
                <td><b>{p.label}</b>{p.google_project_ref && <div style={{ color: C.muted }}>{p.google_project_ref}</div>}</td>
                <td>{p.project_number ?? '—'}</td>
                <td>{p.billing_enabled == null ? 'unknown' : p.billing_enabled ? 'on' : 'off'}</td>
                <td>{p.api_enabled == null ? 'unknown' : p.api_enabled ? 'enabled' : 'off'}</td>
                <td style={{ color: p.routing_eligible ? C.ok : C.muted }}>{p.routing_eligible ? 'Yes' : 'No'}<div style={{ fontSize: 11 }}>{p.eligibility_reason}</div></td>
                <td>{p.discovery_source}{p.verified_at ? ` · ${t(p.verified_at)}` : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!p.is_active && (p.routing_eligible
                    ? <button style={btn} onClick={() => run(app().rpc('admin_set_project_eligibility', { p_project: p.id, p_eligible: false }), () => 'Project switched off.')}>Stop using</button>
                    : p.billing_enabled && <button style={btn} onClick={() => {
                        if (confirm('This project has billing on: using it can incur charges. Authorise paid use? Set a budget on the Dashboard first.'))
                          run(app().rpc('admin_set_project_eligibility', { p_project: p.id, p_eligible: true, p_authorise_paid: true }), () => 'Paid use authorised for this project.');
                      }}>Authorise paid use</button>)}
                  {acc && p.google_project_ref && p.api_enabled === false && <button style={btn} onClick={() => {
                    if (confirm(`Enable the Gemini API in ${p.google_project_ref}?`)) run(callGoogle({ action: 'provision', op: 'enable_api', account_id: acc.id, project_ref: p.google_project_ref, confirm: true }), () => 'Gemini API enabled.');
                  }}>Enable Gemini API</button>}
                  {acc && p.google_project_ref && p.api_enabled && !keys.some(k => k.project_id === p.id && k.status === 'active') && <button style={btn} onClick={() => {
                    if (confirm(`Create one Gemini key in ${p.google_project_ref}? It is stored encrypted and is not used unless the project is eligible.`))
                      run(callGoogle({ action: 'provision', op: 'create_key', account_id: acc.id, project_ref: p.google_project_ref, confirm: true }), () => 'Key created and verified.');
                  }}>Create key</button>}
                </td>
              </tr>);
          })}</tbody>
        </table>
        <details style={{ marginTop: 10, fontSize: 13 }}>
          <summary>Add a project by hand (when Google sign-in is not available)</summary>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <input style={{ ...input, flex: '1 1 160px' }} placeholder="Project ID" value={mref} onChange={e => setMref(e.target.value)} />
            <input style={{ ...input, flex: '1 1 160px' }} placeholder="Name" value={mlabel} onChange={e => setMlabel(e.target.value)} />
            <input style={{ ...input, flex: '1 1 120px' }} placeholder="Project number (optional)" value={mnum} onChange={e => setMnum(e.target.value)} />
            <button style={btn} disabled={!mref || !mlabel} onClick={() => run(app().rpc('admin_upsert_project', { p_ref: mref.trim(), p_label: mlabel.trim(), p_number: mnum.trim() || null }), () => { setMref(''); setMlabel(''); setMnum(''); return 'Project added.'; })}>Add</button>
          </div>
        </details>
        {google.some(a => a.oauth_status === 'connected') && (
          <details style={{ marginTop: 10, fontSize: 13 }}>
            <summary>Create a new Google Cloud project</summary>
            <p style={{ color: C.muted }}>Only useful if you will enable billing on it: a new free project would only add free quota, which is not allowed, so the team would never use it.</p>
            <NewProject onCreate={(ref, name) => run(callGoogle({ action: 'provision', op: 'create_project', account_id: google.find(a => a.oauth_status === 'connected').id,
              project_ref: ref, display_name: name, confirm: true, will_enable_billing: true }), () => `Project ${ref} created. Enable billing for it in Google Cloud Console, then press Discover.`)} />
          </details>)}
      </div>

      <div style={{ ...card, overflowX: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Keys</h2>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>Only the last 4 characters and a short fingerprint are ever shown. Keys in the same project share one quota.</p>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: C.muted }}><th>Key</th><th>Provider</th><th>Project</th><th>Ownership</th><th>In use</th><th>Calls 24h</th><th>Link to project</th></tr></thead>
          <tbody>{keys.map(k => (
            <tr key={k.id} style={{ borderTop: `1px solid ${C.line}` }}>
              <td><b>{k.label}</b> ••••{k.last4}<div style={{ color: C.muted, fontSize: 11 }}>fp {k.fingerprint}{k.duplicate_of ? ` · duplicate of ${k.duplicate_of}` : ''}</div></td>
              <td>{k.provider}</td>
              <td>{k.project}{!k.project_confirmed && k.provider === 'gemini' && <div style={{ fontSize: 11, color: C.warn }}>not confirmed</div>}</td>
              <td style={{ color: OWN[k.ownership]?.[1] }}>{OWN[k.ownership]?.[0] ?? k.ownership}</td>
              <td>{k.status !== 'active' ? k.status : k.eligible ? (k.assigned_team ? `yes (${k.assigned_team})` : 'standby') : 'no: project not eligible'}</td>
              <td>{k.calls_today}</td>
              <td>{k.provider === 'gemini' && k.ownership !== 'verified_oauth' && (
                <select defaultValue="" onChange={e => e.target.value && run(app().rpc('admin_link_key', { p_key: k.id, p_project: e.target.value }), () => `${k.label} linked (marked as linked by you, not verified).`)}>
                  <option value="">choose…</option>{projects.map(p => <option key={p.id} value={p.id}>{p.google_project_ref ?? p.label}</option>)}
                </select>)}</td>
            </tr>))}</tbody>
        </table>
      </div>

      <div style={{ ...card, overflowX: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Quota pools (per project and model)</h2>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>Limits are learnt from Google's own rate-limit replies. RPM = requests per minute, TPM = tokens per minute, RPD = requests per day (resets 13:30 IST).</p>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: C.muted }}><th>Model</th><th>Project</th><th>Last minute</th><th>Today</th><th>RPM / RPD limit</th><th>OK % (1h)</th><th>Latency</th><th>Status</th></tr></thead>
          <tbody>{pools.map((q, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
              <td>{q.model}</td><td>{q.project}</td><td>{q.requests_last_minute}</td>
              <td>{q.requests_today}{q.rpd_limit ? ` / ${q.rpd_limit}` : ''}</td>
              <td>{q.rpm_limit ?? '—'} / {q.rpd_limit ?? '—'}</td><td>{q.ok_pct_last_hour ?? '—'}%</td>
              <td>{q.latency_ms_last_hour ? `${(q.latency_ms_last_hour / 1000).toFixed(1)} s` : '—'}</td>
              <td style={{ color: q.resting_until ? C.warn : C.ok }}>{q.resting_until ? `resting to ${t(q.resting_until)}` : 'available'}</td>
            </tr>))}</tbody>
        </table>
      </div>

      <div style={{ ...card, fontSize: 13 }}>
        <h2 style={{ marginTop: 0 }}>Recent quota events</h2>
        {events.length === 0 ? <p style={{ color: C.muted }}>None yet.</p> : events.map(e => (
          <div key={e.id}>{t(e.at)} · {e.model_id} · <b>{e.dimension.toUpperCase()}</b>{e.limit_value != null ? ` (limit ${e.limit_value})` : ''}</div>))}
        <h2>Provisioning and discovery log</h2>
        {logRows.length === 0 ? <p style={{ color: C.muted }}>Nothing yet.</p> : logRows.map(l => (
          <div key={l.id}>{t(l.at)} · {l.operation} · {l.target} · <span style={{ color: l.status === 'ok' ? C.ok : l.status === 'started' ? C.muted : C.bad }}>{l.status}</span>{l.detail ? ` · ${l.detail}` : ''}</div>))}
      </div>
    </main>
  );
}

function NewProject({ onCreate }: { onCreate: (ref: string, name: string) => void }) {
  const [ref, setRef] = useState(''); const [name, setName] = useState(''); const [ok, setOk] = useState(false);
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
    <input style={{ ...input, flex: '1 1 160px' }} placeholder="project-id" value={ref} onChange={e => setRef(e.target.value.toLowerCase())} />
    <input style={{ ...input, flex: '1 1 160px' }} placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
    <label style={{ fontSize: 12 }}><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /> I will enable billing on it</label>
    <button style={btn} disabled={!ref || !ok} onClick={() => { if (confirm(`Create project ${ref} in your Google account?`)) onCreate(ref, name || ref); }}>Create project</button>
  </div>;
}
