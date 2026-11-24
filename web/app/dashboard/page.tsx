'use client';
// Global dashboard (Document 4, Part M): every book's state, progress, quality and cost, the AI models' health,
// and run controls (pause, resume, priority) in one place.
import { useCallback, useEffect, useState } from 'react';
import { app, supabaseBrowser, BASE } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, page } from '../ui';
import { Bar, etcText, type Progress } from '../meters';

type Row = { book: any; progress: Progress | null; quality: any; kpi: any };
const usd = (n: any) => n == null ? '—' : `$${Number(n).toFixed(2)}`;
const num = (n: any) => n == null ? '—' : Number(n).toLocaleString('en-IN');
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export default function Dashboard() {
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Row[]>([]);
  const [all, setAll] = useState<any>(null);
  const [models, setModels] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data: books, error } = await sb.from('books').select('*').order('created_at', { ascending: false });
    if (error) { setErr(error.message); return; }
    const out = await Promise.all(((books ?? []) as any[]).map(async b => {
      const [p, q, k] = await Promise.all([
        app().rpc('book_progress', { p_book: b.id }), app().rpc('quality_scores', { p_book: b.id }), app().rpc('cost_kpis', { p_book: b.id })]);
      return { book: b, progress: (p.data as Progress) ?? null, quality: q.data, kpi: k.data } as Row;
    }));
    const [a, m] = await Promise.all([app().rpc('cost_kpis', { p_book: null }), app().rpc('model_scorecard', { p_days: 7 })]);
    setRows(out); setAll(a.data); setModels((m.data ?? []) as any[]); setLoaded(true);
  }, [sb]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  async function act(p: PromiseLike<{ error: any }>) {
    const { error } = await p; if (error) setErr(error.message); else load();
  }

  const k = all?.kpi ?? {};
  return (
    <main style={page}>
      <Header><span style={{ fontSize: 13, color: C.muted }}>Dashboard</span></Header>
      {err && <p role="alert" style={{ ...card, borderColor: C.bad, color: C.bad }}>{err}</p>}
      {!loaded && <p>Loading…</p>}

      {all && (
        <div style={card}>
          <h2 style={{ marginTop: 0 }}>Cost and efficiency (all books)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <Stat label="Actual spend" value={usd(all.actual_cost_usd)} note="free tiers cost nothing" />
            <Stat label="Same work at paid prices" value={usd(all.hypothetical_paid_cost_usd)} note={`${all.priced_token_share_pct ?? '—'}% of tokens priced`} />
            <Stat label="Cost per 1,000 approved words" value={k.hypothetical_cost_per_1000_words_usd == null ? '—' : `$${k.hypothetical_cost_per_1000_words_usd}`} note="at paid prices" />
            <Stat label="Tokens per approved word" value={num(k.tokens_per_approved_word)} />
            <Stat label="Calls that succeeded" value={k.call_success_pct == null ? '—' : `${k.call_success_pct}%`} />
            <Stat label="Versions per approved paragraph" value={k.versions_per_approved_paragraph ?? '—'} />
            <Stat label="Approved words per day" value={num(k.approved_words_per_day)} />
          </div>
        </div>
      )}

      <h2>Books</h2>
      {rows.map(({ book: b, progress: p, quality: q, kpi }) => (
        <div key={b.id} style={{ ...card, borderColor: b.run_state === 'paused' ? C.warn : undefined }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <a href={`${BASE}/book/?id=${b.id}`} style={{ fontWeight: 700, fontSize: 16 }}>{b.working_title}</a>
            {b.branch_of && <span style={{ fontSize: 12, color: C.muted }}>recovery copy</span>}
            <span style={{ fontSize: 12, color: b.run_state === 'running' ? C.ok : C.warn, marginLeft: 'auto' }}>
              {b.run_state === 'running' ? '● Running' : b.run_state === 'paused' ? '❚❚ Paused' : '■ Cancelled'}</span>
          </div>
          {b.paused_reason && b.run_state !== 'running' && <p style={{ fontSize: 13, color: C.muted, margin: '4px 0' }}>{b.paused_reason}</p>}
          {p && <div style={{ margin: '8px 0' }}><Bar pct={Number(p.percent ?? 0)} />
            <span style={{ fontSize: 13, color: C.muted }}>{num(p.approved_words)} of {num(p.target_words)} words · {etcText(p)}</span></div>}
          <p style={{ fontSize: 13, margin: '4px 0' }}>
            Quality {q?.book?.score ?? '—'} · feeling {q?.book?.feel ?? '—'} · pull {q?.book?.pull ?? '—'}
            {' · '}{kpi?.approved_paragraphs ?? 0} approved paragraphs ({(p as any)?.author_approved_paragraphs ?? 0} by you)
            {' · '}paid-price equivalent {usd(kpi?.hypothetical_paid_cost_usd)}
            {' · '}{kpi?.kpi?.tokens_per_approved_word ? `${num(kpi.kpi.tokens_per_approved_word)} tokens/word` : ''}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {b.run_state === 'running'
              ? <button style={btn} onClick={() => act(app().rpc('set_book_state', { p_book: b.id, p_state: 'paused', p_reason: 'Paused from the dashboard' }))}>Pause</button>
              : <button style={btnPrimary} onClick={() => act(app().rpc('set_book_state', { p_book: b.id, p_state: 'running' }))}>Resume</button>}
            <label style={{ fontSize: 13 }}>Priority{' '}
              <select value={b.priority ?? 'normal'} onChange={e => act(app().rpc('set_book_priority', { p_book: b.id, p_priority: e.target.value }))}>
                {PRIORITIES.map(x => <option key={x} value={x}>{x}</option>)}
              </select></label>
          </div>
        </div>
      ))}

      <h2>AI models (last 7 days)</h2>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: C.muted }}>
            <th>Model</th><th>Calls</th><th>OK</th><th>Quota hits</th><th>Too large</th><th>Busy/timeout</th><th>Bad output</th><th>Avg s</th><th>Status</th></tr></thead>
          <tbody>{models.map(m => (
            <tr key={m.model} style={{ borderTop: `1px solid ${C.line}` }}>
              <td>{m.model}</td><td>{num(m.calls)}</td><td>{m.ok_pct}%</td><td>{num(m.quota_hits)}</td><td>{num(m.too_large)}</td>
              <td>{num(m.busy_or_timeout)}</td><td>{num(m.bad_output)}</td><td>{m.avg_seconds ?? '—'}</td>
              <td style={{ color: m.resting_until ? C.warn : C.ok }}>{m.resting_until ? `resting until ${new Date(m.resting_until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'available'}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </main>
  );
}

function Stat({ label, value, note }: { label: string; value: any; note?: string }) {
  return <div><div style={{ fontSize: 12, color: C.muted }}>{label}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    {note && <div style={{ fontSize: 11, color: C.muted }}>{note}</div>}</div>;
}
