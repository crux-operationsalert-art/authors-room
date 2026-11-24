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
  const [kpi, setKpi] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [work, setWork] = useState<any>(null);
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
    const [a, m, k5, bs, jobs] = await Promise.all([app().rpc('cost_kpis', { p_book: null }), app().rpc('model_scorecard', { p_days: 7 }),
      app().rpc('kpis', { p_book: null }), app().rpc('budget_status'),
      sb.from('agent_jobs').select('book_id, step, role_code, status, run_after, last_error').in('status', ['running', 'queued', 'waiting_quota'])]);
    const js = (jobs.data ?? []) as any[];
    const soonest = js.filter(j => j.status === 'waiting_quota').map(j => j.run_after).sort()[0];
    setWork({ running: js.filter(j => j.status === 'running'), queued: js.filter(j => j.status === 'queued').length,
      waiting: js.filter(j => j.status === 'waiting_quota').length, soonest,
      pendingParas: js.filter(j => ['draft', 'revise', 'review_panel', 'consolidate'].includes(j.step)).length,
      bottleneck: js.find(j => j.status === 'waiting_quota')?.last_error ?? null });
    setRows(out); setAll(a.data); setModels((m.data ?? []) as any[]); setKpi(k5.data); setBudget(bs.data); setLoaded(true);
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

      {work && (
        <div style={card}>
          <h2 style={{ marginTop: 0 }}>Workload now</h2>
          <p style={{ margin: 0, fontSize: 14 }}>
            {work.running.length} agent{work.running.length === 1 ? '' : 's'} running{work.running.length ? ` (${work.running.map((j: any) => j.role_code.replace(/_/g, ' ')).join(', ')})` : ''}
            {' · '}{work.queued} queued · {work.waiting} waiting for AI capacity · {work.pendingParas} paragraph steps pending</p>
          {work.waiting > 0 && <p style={{ fontSize: 13, color: C.warn, margin: '6px 0 0' }}>Bottleneck: AI capacity{work.soonest ? `, next retry ${new Date(work.soonest).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}.
            {work.bottleneck ? ` ${String(work.bottleneck).slice(0, 160)}` : ''}</p>}
        </div>)}

      {kpi && (
        <div style={card}>
          <h2 style={{ marginTop: 0 }}>Five KPIs (all books)</h2>
          <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>Measured from recorded work. Lines marked “projected” assume the recent pace continues.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            <KpiBox n={1} title="Cost per book" lines={[
              ['Actual spend', usd(kpi.kpi1_cost_per_book.actual_spend_so_far_usd)],
              ['Same work at paid prices', usd(kpi.kpi1_cost_per_book.paid_equivalent_so_far_usd)],
              ['Hybrid (paid Gemini, free backups)', usd(kpi.kpi1_cost_per_book.hybrid_paid_gemini_free_backups_so_far_usd)],
              ['Projected remaining at paid prices', usd(kpi.kpi1_cost_per_book.projected_remaining_paid_equivalent_usd)]]} />
            <KpiBox n={2} title="Completion time" lines={[
              ['Elapsed', `${kpi.kpi2_completion_time.elapsed_days_so_far} days`],
              ['AI compute so far', `${kpi.kpi2_completion_time.ai_compute_hours_so_far} h`],
              ['Projected at current pace', kpi.kpi2_completion_time.projected_days_to_finish_at_current_pace != null ? `${kpi.kpi2_completion_time.projected_days_to_finish_at_current_pace} days` : '—'],
              ['Estimated if paid (no quota waits)', kpi.kpi2_completion_time.estimated_paid_completion_hours_no_quota_waits != null ? `${kpi.kpi2_completion_time.estimated_paid_completion_hours_no_quota_waits} h` : '—']]} />
            <KpiBox n={3} title="Processing speed" lines={[
              ['Paragraphs in last 24 h', kpi.kpi3_processing_speed.paragraphs_last_24h],
              ['Per hour', kpi.kpi3_processing_speed.paragraphs_per_hour_last_24h],
              ['Average paragraph turnaround', kpi.kpi3_processing_speed.avg_paragraph_turnaround_minutes != null ? `${kpi.kpi3_processing_speed.avg_paragraph_turnaround_minutes} min` : '—']]} />
            <KpiBox n={4} title="Reliability" lines={[
              ['Successful calls', `${kpi.kpi4_reliability.success_pct ?? '—'}%`], ['Failed calls', `${kpi.kpi4_reliability.failure_pct ?? '—'}%`],
              ['Interrupted (last 7 days)', `${kpi.kpi4_reliability.interruption_hours_last_7d} h`], ['Failed steps that recovered', `${kpi.kpi4_reliability.recovery_success_pct ?? '—'}%`]]} />
            <KpiBox n={5} title="Quality and rework" lines={[
              ['First-pass acceptance', `${kpi.kpi5_quality_rework.first_pass_acceptance_pct ?? '—'}%`],
              ['Average editorial score', kpi.kpi5_quality_rework.avg_editorial_score ?? '—'],
              ['Versions per approved paragraph', kpi.kpi5_quality_rework.versions_per_approved_paragraph ?? '—']]} />
          </div>
        </div>)}

      {budget && (
        <div style={card}>
          <h2 style={{ marginTop: 0 }}>Paid use and budgets</h2>
          <p style={{ fontSize: 14, margin: '0 0 8px' }}>Paid use is <b style={{ color: budget.paid_use_enabled ? C.warn : C.ok }}>{budget.paid_use_enabled ? 'ON' : 'OFF'}</b>.
            {' '}No charge can happen while it is off. Actual spend so far: {usd(all?.actual_cost_usd)}.</p>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', color: C.muted }}><th>Budget</th><th>Limit</th><th>Spent</th><th>Alert at</th><th>Hard stop</th><th>State</th><th></th></tr></thead>
            <tbody>{(budget.budgets ?? []).map((b: any) => (
              <tr key={b.id} style={{ borderTop: `1px solid ${C.line}` }}>
                <td>{b.scope.replace('global_', '').replace('_', ' ')}{b.scope_ref ? ` · ${rows.find(r => r.book.id === b.scope_ref)?.book.working_title ?? b.scope_ref}` : ''}</td>
                <td>{usd(b.limit_usd)}</td><td>{usd(b.spent_usd)}</td><td>{b.soft_pct}%</td><td>{b.hard ? 'yes' : 'no'}</td>
                <td style={{ color: b.state === 'ok' || b.state === 'no paid use allowed' ? C.ok : C.warn }}>{b.state}</td>
                <td><button style={btn} onClick={() => { const v = prompt('New limit in USD', String(b.limit_usd)); if (v !== null && !isNaN(Number(v)))
                  act(app().rpc('admin_set_budget', { p_scope: b.scope, p_ref: b.scope_ref, p_limit: Number(v), p_hard: b.hard, p_soft_pct: b.soft_pct })); }}>Change</button></td>
              </tr>))}</tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button style={btn} onClick={() => { const v = prompt('Monthly budget for one book (USD)?', '5'); const id = prompt('Book: type the first words of its title'); 
              const r = rows.find(x => id && x.book.working_title.toLowerCase().startsWith(id.toLowerCase()));
              if (v && r) act(app().rpc('admin_set_budget', { p_scope: 'book', p_ref: r.book.id, p_limit: Number(v) })); }}>Add a book budget</button>
            {budget.paid_use_enabled
              ? <button style={btnPrimary} onClick={() => act(app().rpc('admin_set_paid_use', { p_enabled: false }))}>Switch paid use OFF</button>
              : <button style={btn} onClick={() => { if (confirm('Switch paid use ON? Charges can then happen on paid projects you authorised, up to your budgets.')) act(app().rpc('admin_set_paid_use', { p_enabled: true })); }}>Switch paid use on…</button>}
          </div>
        </div>)}

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
              : <button style={btnPrimary} onClick={() => act(app().rpc('set_book_state', { p_book: b.id, p_state: 'running' }))}>{b.run_state === 'cancelled' ? 'Restart from last checkpoint' : 'Resume'}</button>}
            {b.run_state !== 'cancelled' && <button style={btn} onClick={() => { if (confirm('Cancel work on this book? Nothing is deleted; you can restart it from its last checkpoint.'))
              act(app().rpc('set_book_state', { p_book: b.id, p_state: 'cancelled', p_reason: 'Cancelled from the dashboard' })); }}>Cancel</button>}
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

function KpiBox({ n, title, lines }: { n: number; title: string; lines: [string, any][] }) {
  return <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 }}>
    <div style={{ fontSize: 12, color: C.muted }}>KPI {n}</div><div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
    {lines.map(([k, v]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}><span style={{ color: C.muted }}>{k}</span><b>{v}</b></div>)}
  </div>;
}

function Stat({ label, value, note }: { label: string; value: any; note?: string }) {
  return <div><div style={{ fontSize: 12, color: C.muted }}>{label}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    {note && <div style={{ fontSize: 11, color: C.muted }}>{note}</div>}</div>;
}
