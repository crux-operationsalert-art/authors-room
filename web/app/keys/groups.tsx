'use client';
// AI groups: one group per company account. A group's keys share one allowance, so a group works, rests and is
// replaced as a whole; when it is used up the next group in the order takes over.
import { useCallback, useEffect, useState } from 'react';
import { callWorker, supabaseBrowser } from '@/lib/supabaseBrowser';
import { C } from '../ui';

type Group = { group: string; label: string; position: number; keys: { label: string; last4: string; status: string }[];
  active_keys: number; models: number; models_resting: number; resting_until: string | null; resting_reason: string | null;
  answers_today: number; refused_today: number };

const SIGNUP: Record<string, { url: string; hint: string; placeholder: string }> = {
  gemini: { url: 'https://aistudio.google.com/apikey', hint: 'Only keys from the main project (same allowance as K01).', placeholder: 'AQ.…' },
  mistral: { url: 'https://console.mistral.ai/api-keys', hint: 'Best writing of the backups. Free plan; Mistral may learn from what is sent.', placeholder: 'Mistral API key' },
  groq: { url: 'https://console.groq.com/keys', hint: 'Very fast; small daily allowance of text.', placeholder: 'gsk_…' },
  openrouter: { url: 'https://openrouter.ai/settings/keys', hint: '50 free requests a day.', placeholder: 'sk-or-…' },
};
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function state(g: Group, firstWorking: boolean) {
  if (g.active_keys === 0) return g.keys.length ? { text: 'Paused', color: C.muted } : { text: 'No key yet', color: C.muted };
  if (g.resting_until) return { text: `Resting until ${when(g.resting_until)}`, color: C.warn };
  return firstWorking ? { text: 'Working now', color: C.ok } : { text: 'Ready (takes over when the groups above rest)', color: C.accent };
}

export function KeyGroups({ onChange }: { onChange?: () => void }) {
  const sb = supabaseBrowser();
  const [groups, setGroups] = useState<Group[]>([]);
  const [setAside, setSetAside] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.schema('app').rpc('key_groups');
    if (error) { setMsg(error.message); return; }
    setGroups((data as any).groups ?? []); setSetAside((data as any).set_aside ?? 0);
  }, [sb]);
  useEffect(() => { load(); const id = setInterval(load, 15_000); return () => clearInterval(id); }, [load]);

  async function act(p: PromiseLike<{ error: any; data?: any }>, ok: string) {
    setBusy(true);
    try { const { error } = await p; setMsg(error ? error.message : ok); }
    catch (e: any) { setMsg(e?.message ?? String(e)); }
    setBusy(false); load(); onChange?.();
  }
  async function addKey(g: string) {
    const secret = (draft[g] ?? '').trim();
    if (!secret) return;
    setBusy(true);
    const { data: j, error } = await callWorker({ action: 'add_key', secret, provider: g === 'gemini' ? undefined : g });
    setDraft(d => ({ ...d, [g]: '' }));
    const failed = error ? error.message : j?.error;
    // a backup group holds one account: the new key replaces the old one(s) only once it is safely stored
    let replaced = 0;
    if (!failed && g !== 'gemini') { const { data: n } = await sb.schema('app').rpc('retire_older_group_keys', { p_group: g }); replaced = Number(n ?? 0); }
    setBusy(false);
    setMsg(failed ? failed : `Added ${j.label} (••••${j.last4}) to the ${g} group${replaced ? `; the old key was retired` : ''}.` +
      (g === 'gemini' ? ' It is on standby: give it to a team in “Teams” below.' : ' It takes over whenever the groups above it rest.'));
    load(); onChange?.();
  }
  const backups = groups.filter(g => g.group !== 'gemini').map(g => g.group);
  function move(g: string, dir: -1 | 1) {
    const order = [...backups]; const i = order.indexOf(g), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    act(sb.schema('app').rpc('set_backup_order', { p_order: order }), 'Order saved.');
  }
  const firstWorking = groups.find(g => g.active_keys > 0 && !g.resting_until)?.group;
  const btn: React.CSSProperties = { padding: '4px 10px', fontSize: 13, cursor: 'pointer' };

  return (
    <section style={{ margin: '12px 0 20px' }}>
      <h2 style={{ marginBottom: 4 }}>AI groups</h2>
      <p style={{ marginTop: 0, color: C.muted }}>
        One group per AI company, from one free account each. All keys in a group share one daily allowance, so a group works,
        rests and is replaced as a whole. When a group is used up it rests until its reset and the next group takes over.
        {setAside > 0 && <> {setAside} keys from other Google projects are set aside and never used: pooling projects to stretch
          Google’s free limit breaks its terms.</>}
      </p>
      {msg && <p role="status" style={{ background: '#ddf4ff', padding: 8, borderRadius: 6 }}>{msg}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {groups.map(g => {
          const s = state(g, g.group === firstWorking); const info = SIGNUP[g.group];
          const bi = backups.indexOf(g.group);
          return (
            <div key={g.group} style={{ border: `1px solid ${s.color === C.ok ? C.ok : C.line}`, borderRadius: 8, padding: 12, background: '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <b>{g.position}. {g.label}</b>
                {g.group !== 'gemini' && (
                  <span>
                    <button style={btn} disabled={busy || bi <= 0} onClick={() => move(g.group, -1)} aria-label={`Move ${g.label} up`}>↑</button>{' '}
                    <button style={btn} disabled={busy || bi === backups.length - 1} onClick={() => move(g.group, 1)} aria-label={`Move ${g.label} down`}>↓</button>
                  </span>)}
              </div>
              <div style={{ color: s.color, fontWeight: 600, fontSize: 14, margin: '4px 0' }}>{s.text}</div>
              <div style={{ fontSize: 13, color: C.muted }}>
                {g.keys.length ? g.keys.map(k => `${k.label} ••••${k.last4}${k.status !== 'active' ? ` (${k.status})` : ''}`).join(', ') : 'No key added'}
                <br />Today: {g.answers_today} answers{g.refused_today ? `, ${g.refused_today} refused (limit)` : ''} · {g.models - g.models_resting} of {g.models} models available
              </div>
              <form onSubmit={e => { e.preventDefault(); addKey(g.group); }} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input type="password" autoComplete="off" placeholder={info.placeholder} value={draft[g.group] ?? ''}
                       onChange={e => setDraft(d => ({ ...d, [g.group]: e.target.value }))}
                       aria-label={`New ${g.label} key`} style={{ flex: 1, minWidth: 0, padding: 6 }} />
                <button type="submit" style={btn} disabled={busy || !(draft[g.group] ?? '').trim()}>{g.keys.length && g.group !== 'gemini' ? 'Replace' : 'Add key'}</button>
              </form>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                <a href={info.url} target="_blank" rel="noreferrer">Get a key</a> · {info.hint}
              </div>
              {g.keys.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {g.active_keys > 0
                    ? <button style={btn} disabled={busy} onClick={() => act(sb.schema('app').rpc('set_group_status', { p_group: g.group, p_status: 'disabled' }), `${g.label} group paused.`)}>Pause group</button>
                    : <button style={btn} disabled={busy} onClick={() => act(sb.schema('app').rpc('set_group_status', { p_group: g.group, p_status: 'active' }), `${g.label} group back on.`)}>Resume group</button>}
                  {g.group !== 'gemini' && (
                    <button style={btn} disabled={busy} onClick={() => { if (confirm(`Retire every ${g.label} key? Add the replacement key above first or afterwards.`))
                      act(sb.schema('app').rpc('set_group_status', { p_group: g.group, p_status: 'revoked' }), `${g.label} keys retired.`); }}>Retire group keys</button>)}
                </div>)}
            </div>);
        })}
      </div>
    </section>
  );
}
