'use client';
import { useCallback, useEffect, useState } from 'react';
import { callWorker, supabaseBrowser } from '@/lib/supabaseBrowser';
import { Header } from '../ui';

type KeyRow = {
  key_id: string; label: string; key_masked: string; status: string; project_label: string;
  teams: string; roles: string; current_activity: string | null; requests_today: number;
  tokens_today: number; rate_limited_today: number; errors_today: number; cost_today_usd: number;
  last_used_at: string | null; notes: string | null;
};
type TeamRow = {
  team_code: string; team: string; description: string; key_label: string | null; key_masked: string | null;
  key_status: string | null; requests_today: number; tokens_today: number; rate_limited_today: number; jobs_waiting: number;
};
type QuotaRow = {
  project_label: string; usage_tier: string; model_id: string; rpm: number | null; tpm: number | null; rpd: number | null;
  requests_last_minute: number; input_tokens_last_minute: number; requests_today: number;
  rpd_used_pct: number | null; rpm_used_pct: number | null; tpm_used_pct: number | null;
  quota_state: 'ok' | 'near_limit' | 'exhausted'; daily_reset_at: string;
};

const fmt = (n: number) => new Intl.NumberFormat('en-IN').format(Number(n ?? 0));
const ist = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const STATE = { ok: ['OK', '#1a7f37'], near_limit: ['Near limit', '#9a6700'], exhausted: ['Out of quota', '#cf222e'] } as const;

function Bar({ pct }: { pct: number | null }) {
  const p = Math.min(100, Number(pct ?? 0));
  const c = p >= 100 ? '#cf222e' : p >= 80 ? '#bf8700' : '#2f81f7';
  return (
    <div style={{ background: '#eaeef2', borderRadius: 4, height: 8, width: 140 }} aria-label={`${p}% used`}>
      <div style={{ width: `${p}%`, background: c, height: 8, borderRadius: 4 }} />
    </div>
  );
}

export default function KeysPage() {
  const sb = supabaseBrowser();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [quota, setQuota] = useState<QuotaRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newTeam, setNewTeam] = useState('');

  const load = useCallback(async () => {
    const [k, t, q] = await Promise.all([
      sb.from('v_key_status').select('*').order('label'),
      sb.from('v_team_usage').select('*'),
      sb.from('v_project_quota').select('*'),
    ]);
    if (k.error || t.error || q.error) setMsg((k.error ?? t.error ?? q.error)!.message);
    setKeys((k.data ?? []) as KeyRow[]); setTeams((t.data ?? []) as TeamRow[]); setQuota((q.data ?? []) as QuotaRow[]);
  }, [sb]);

  useEffect(() => { load(); const id = setInterval(load, 15_000); return () => clearInterval(id); }, [load]);

  async function assign(team: string, keyId: string) {
    const { error } = await sb.schema('app').rpc('assign_team_key', { p_team_code: team, p_key_id: keyId });
    setMsg(error ? error.message : `Team reassigned.`); load();
  }
  async function setStatus(keyId: string, status: string) {
    if (status === 'revoked' && !confirm('Revoke this key in the app? Also delete it in Google AI Studio.')) return;
    const { error } = await sb.schema('app').rpc('set_key_status', { p_key_id: keyId, p_status: status });
    setMsg(error ? error.message : `Key ${status}.`); load();
  }
  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    const { data: j, error } = await callWorker({ action: 'add_key', secret: newKey, team: newTeam || null });
    setNewKey('');
    setMsg(error ? error.message : j.error ? j.error : `Added ${j.label} (••••${j.last4})${j.team ? ` for ${j.team}` : ' as standby'}.`);
    load();
  }
  async function checkKeys() {
    setMsg('Checking every key with Google…');
    const { data: j, error } = await callWorker({ action: 'check_keys' });
    if (error) { setMsg(error.message); return; }
    const bad = (j.keys ?? []).filter((k: any) => !k.ok);
    setMsg(bad.length ? `Problem keys: ${bad.map((k: any) => `${k.label} (${k.error ?? k.note})`).join(', ')}` : `All ${j.keys.length} keys are valid.`);
    load();
  }

  const exhausted = quota.some(q => q.quota_state === 'exhausted');
  const activeKeys = keys.filter(k => k.status === 'active');
  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #d0d7de', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eaeef2', verticalAlign: 'top' };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '24px auto', padding: '0 16px', color: '#1f2328' }}>
      <Header><button onClick={checkKeys}>Check all keys</button></Header>
      <h1 style={{ marginBottom: 4 }}>AI keys, teams and quota</h1>
      <p style={{ marginTop: 0, color: '#59636e' }}>
        Quota belongs to the Gemini <b>project</b>, so every key below draws on the same limits. Keys give each team its own
        identity, so you can see who used what and revoke one key without stopping the rest. Refreshes every 15 seconds.
      </p>
      {msg && <p role="status" style={{ background: '#ddf4ff', padding: 8, borderRadius: 6 }}>{msg}</p>}

      <h2>Project quota (shared by all keys)</h2>
      {quota.length === 0 && <p>No limits recorded yet. Copy them from AI Studio’s rate-limit page into <code>project_model_limits</code>.</p>}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{['Model', 'Today vs daily limit', 'Last minute', 'State', 'Daily reset (IST)'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{quota.map(q => (
          <tr key={q.model_id}>
            <td style={td}><b>{q.model_id}</b><br /><small>{q.project_label} · {q.usage_tier}</small></td>
            <td style={td}><Bar pct={q.rpd_used_pct} /> {fmt(q.requests_today)} / {q.rpd ? fmt(q.rpd) : '—'} requests ({q.rpd_used_pct ?? 0}%)</td>
            <td style={td}>{fmt(q.requests_last_minute)} / {q.rpm ?? '—'} req · {fmt(q.input_tokens_last_minute)} / {q.tpm ? fmt(q.tpm) : '—'} tokens</td>
            <td style={{ ...td, color: STATE[q.quota_state][1], fontWeight: 600 }}>{STATE[q.quota_state][0]}</td>
            <td style={td}>{ist(q.daily_reset_at)}</td>
          </tr>))}
        </tbody>
      </table>
      {exhausted && (
        <div style={{ border: '1px solid #cf222e', borderRadius: 6, padding: 12, marginTop: 12 }}>
          <b>Quota reached.</b> Waiting jobs resume automatically after the reset. Adding another key from this project will
          not help, because they share this quota. What does help: let author-facing work go first (already automatic), move
          milestone reviews to batch, switch strict mode off, or move the project to a higher paid tier in AI Studio.
        </div>
      )}

      <h2>Teams — who uses which key</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{['Team', 'Does', 'Key', 'Requests today', 'Tokens today', '429s', 'Jobs waiting', 'Change key'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{teams.map(t => (
          <tr key={t.team_code}>
            <td style={td}><b>{t.team}</b></td>
            <td style={td}>{t.description}</td>
            <td style={td}>{t.key_label ? `${t.key_label} ${t.key_masked}` : <i>shared fallback</i>}{t.key_status && t.key_status !== 'active' ? ` (${t.key_status})` : ''}</td>
            <td style={td}>{fmt(t.requests_today)}</td>
            <td style={td}>{fmt(t.tokens_today)}</td>
            <td style={td}>{fmt(t.rate_limited_today)}</td>
            <td style={td}>{fmt(t.jobs_waiting)}</td>
            <td style={td}>
              <select aria-label={`Key for ${t.team}`} value="" onChange={e => e.target.value && assign(t.team_code, e.target.value)}>
                <option value="">Move to…</option>
                {activeKeys.map(k => <option key={k.key_id} value={k.key_id}>{k.label} {k.key_masked}</option>)}
              </select>
            </td>
          </tr>))}
        </tbody>
      </table>

      <h2>Keys — what each one is doing</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{['Key', 'Status', 'Team(s)', 'Doing now', 'Last check', 'Requests', 'Tokens', '429s', 'Errors', 'Cost (USD)', 'Last used (IST)', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{keys.map(k => (
          <tr key={k.key_id} style={{ opacity: k.status === 'active' ? 1 : 0.55 }}>
            <td style={td}><b>{k.label}</b> {k.key_masked}</td>
            <td style={td}>{k.status}</td>
            <td style={td} title={k.roles}>{k.teams}</td>
            <td style={td}>{k.current_activity ?? 'Idle'}</td>
            <td style={td}><small>{k.notes ?? '—'}</small></td>
            <td style={td}>{fmt(k.requests_today)}</td>
            <td style={td}>{fmt(k.tokens_today)}</td>
            <td style={td}>{fmt(k.rate_limited_today)}</td>
            <td style={td}>{fmt(k.errors_today)}</td>
            <td style={td}>{Number(k.cost_today_usd).toFixed(4)}</td>
            <td style={td}>{ist(k.last_used_at)}</td>
            <td style={td}>
              {k.status === 'active'
                ? <button onClick={() => setStatus(k.key_id, 'disabled')}>Disable</button>
                : k.status === 'disabled' ? <button onClick={() => setStatus(k.key_id, 'active')}>Enable</button> : null}{' '}
              {k.status !== 'revoked' && <button onClick={() => setStatus(k.key_id, 'revoked')}>Revoke</button>}
            </td>
          </tr>))}
        </tbody>
      </table>

      <h2>Add a key</h2>
      <p style={{ color: '#59636e' }}>
        Use this to give a team its own key or to replace a revoked one. Only add keys from this app’s one Gemini project;
        keys from other projects must not be used to stretch quota (Google’s terms and the project brief). The key goes straight to encrypted
        storage; only its last four characters are shown.
      </p>
      <form onSubmit={addKey} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="password" autoComplete="off" placeholder="AQ.…" value={newKey} onChange={e => setNewKey(e.target.value)}
               style={{ flex: '1 1 360px', padding: 6 }} aria-label="Gemini auth key" required />
        <select value={newTeam} onChange={e => setNewTeam(e.target.value)} aria-label="Assign to team">
          <option value="">Standby (no team)</option>
          {teams.map(t => <option key={t.team_code} value={t.team_code}>{t.team}</option>)}
        </select>
        <button type="submit">Add key</button>
      </form>
    </main>
  );
}
