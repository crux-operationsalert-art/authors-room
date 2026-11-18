'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { app, kick, supabaseBrowser } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, input, page, Status } from '../ui';

type Msg = { id: string; role: string; content: string; created_at: string };
type Decision = { id: string; type: string; subject_ref: string | null; question: string; options: any[]; recommendation: string | null; status: string };
type Block = { id: string; order_key: string; status: string; current_version_id: string | null;
               block_versions: { text: string; version_no: number; provenance: string } | null };
type Issue = { id: string; block_version_id: string; raised_by: string; severity: string; category: string; issue: string; evidence: string | null; suggested_fix: string | null; status: string };
type Review = { block_version_id: string; role_code: string; score: number | null; summary: string | null };

const SEV: Record<string, string> = { critical: C.bad, major: C.bad, moderate: C.warn, minor: C.muted };
const ROLE: Record<string, string> = { voice_custodian: 'Voice', continuity_manager: 'Continuity', logic_fact_checker: 'Logic & facts',
  line_copy_editor: 'Language', reader_panel_manager: 'Reader (simulated)' };

function Workspace() {
  const id = useSearchParams().get('id')!;
  const sb = supabaseBrowser();
  const [book, setBook] = useState<any>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [cons, setCons] = useState<any>(null);
  const [ents, setEnts] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [guidance, setGuidance] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [b, m, d, c, e, bl, is, rv, j] = await Promise.all([
      sb.from('books').select('*').eq('id', id).single(),
      sb.from('intake_messages').select('*').eq('book_id', id).order('created_at'),
      sb.from('decisions').select('*').eq('book_id', id).eq('status', 'pending').order('created_at'),
      sb.from('book_constitutions').select('*').eq('book_id', id).order('version', { ascending: false }).limit(1).maybeSingle(),
      sb.from('entities').select('type, name, profile').eq('book_id', id).order('type'),
      sb.from('manuscript_blocks').select('id, order_key, status, current_version_id, block_versions!manuscript_blocks_current_fk(text, version_no, provenance)').eq('book_id', id).order('order_key'),
      sb.from('editorial_issues').select('*').eq('book_id', id).order('created_at'),
      sb.from('review_runs').select('block_version_id, role_code, score, summary').eq('book_id', id),
      sb.from('agent_jobs').select('workflow, step, role_code, status, last_error').eq('book_id', id).in('status', ['queued', 'running', 'waiting_quota', 'failed']),
    ]);
    setBook(b.data); setMsgs((m.data ?? []) as Msg[]); setDecisions((d.data ?? []) as Decision[]); setCons(c.data);
    setEnts(e.data ?? []); setBlocks((bl.data ?? []) as any); setIssues((is.data ?? []) as Issue[]);
    setReviews((rv.data ?? []) as Review[]); setJobs(j.data ?? []);
  }, [sb, id]);

  useEffect(() => {
    load();
    const ch = sb.channel(`book-${id}`);
    for (const t of ['intake_messages', 'decisions', 'manuscript_blocks', 'editorial_issues', 'agent_jobs', 'book_constitutions']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `book_id=eq.${id}` }, () => load());
    }
    ch.subscribe();
    const poll = setInterval(load, 20_000);   // safety net if realtime drops
    return () => { sb.removeChannel(ch); clearInterval(poll); };
  }, [sb, id, load]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length]);

  async function run<T>(p: PromiseLike<{ error: any; data?: T }>) {
    setErr(null);
    const { error } = await p;
    if (error) setErr(error.message); else { kick(); load(); }
  }

  if (!book) return <main style={page}><Header /><p>Loading…</p></main>;
  const failed = jobs.filter(j => j.status === 'failed');
  const activeJobs = jobs.filter(j => j.status !== 'failed');
  const busy = activeJobs.length > 0;
  const waiting = activeJobs.filter(j => j.status === 'waiting_quota').length;
  const genreDecision = decisions.find(d => d.type === 'genre_direction');
  const consolidations = decisions.filter(d => d.type === 'consolidation');
  const active = blocks.find(b => !['author_approved', 'cut'].includes(b.status));

  return (
    <main style={page}>
      <Header><span style={{ fontSize: 13, color: C.muted }}>{book.working_title} · {book.status}</span></Header>
      {err && <p role="alert" style={{ ...card, borderColor: C.bad, color: C.bad }}>{err}</p>}
      <p style={{ fontSize: 13, color: busy ? C.warn : C.muted, margin: '0 0 12px' }}>
        {busy ? `The team is working (${activeJobs.length} task${activeJobs.length > 1 ? 's' : ''}${waiting ? `, ${waiting} waiting for quota` : ''})…` : 'The team is idle.'}
      </p>
      {failed.length > 0 && (
        <div style={{ ...card, borderColor: C.bad }}>
          <b style={{ color: C.bad }}>{failed.length} step{failed.length > 1 ? 's' : ''} could not finish</b>
          <span style={{ fontSize: 13, color: C.muted }}> — usually Google’s models were busy. Last error: {failed[0].last_error}</span>
          <div><button style={{ ...btn, marginTop: 8 }} onClick={() => run(app().rpc('retry_failed_jobs', { p_book: id }))}>Retry now</button></div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.25fr)', gap: 16, alignItems: 'start' }}>
        {/* ---------- left: conversation + decisions ---------- */}
        <section>
          <div style={{ ...card, maxHeight: 460, overflowY: 'auto' }}>
            {msgs.map(m => (
              <div key={m.id} style={{ margin: '8px 0', textAlign: m.role === 'author' ? 'right' : 'left' }}>
                <div style={{ display: 'inline-block', maxWidth: '88%', padding: '8px 10px', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 14,
                              background: m.role === 'author' ? '#ddf4ff' : m.role === 'system' ? '#fff8c5' : C.soft, textAlign: 'left' }}>
                  {m.content}
                </div>
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          {book.status === 'intake' && !genreDecision && (
            <form onSubmit={e => { e.preventDefault(); if (!text.trim()) return; run(app().rpc('send_intake_message', { p_book: id, p_text: text })); setText(''); }}
                  style={{ display: 'flex', gap: 8 }}>
              <input style={input} placeholder="Reply to the team…" value={text} onChange={e => setText(e.target.value)} aria-label="Reply" />
              <button style={btnPrimary}>Send</button>
            </form>
          )}

          {genreDecision && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>{genreDecision.question}</h3>
              {genreDecision.options.map((o: any, i: number) => (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <b>{o.title}</b> <span style={{ color: C.muted, fontSize: 13 }}>· {o.genre} / {o.subgenre}</span>
                  <p style={{ margin: '6px 0', fontSize: 14 }}><b>Why it fits:</b> {o.why_it_fits}</p>
                  <p style={{ margin: '6px 0', fontSize: 14 }}><b>Reader experience:</b> {o.reader_experience}</p>
                  <p style={{ margin: '6px 0', fontSize: 14 }}><b>How it could develop:</b> {o.development}</p>
                  <p style={{ margin: '6px 0', fontSize: 14, color: C.warn }}><b>Risk:</b> {o.risk}</p>
                  <button style={btnPrimary} onClick={() => run(app().rpc('decide', { p_decision: genreDecision.id, p_choice: o }))}>Choose this direction</button>
                </div>
              ))}
              {genreDecision.recommendation && <p style={{ fontSize: 13, color: C.muted }}><b>Team’s view:</b> {genreDecision.recommendation}</p>}
            </div>
          )}

          {cons && cons.status !== 'draft' && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Book constitution {cons.status === 'approved' ? '✓ approved' : '— please review'}</h3>
              {[['Premise', cons.premise], ['Genre', `${cons.genre} / ${cons.subgenre}`], ['Audience', cons.audience],
                ['Themes', (cons.themes ?? []).join(', ')], ['Point of view', `${cons.pov}; ${cons.tense}`], ['Voice', cons.voice],
                ['Ending', cons.ending_intent], ['Length', cons.length_target], ['Never change', (cons.never_change ?? []).join('; ')]]
                .map(([k, v]) => <p key={k} style={{ margin: '4px 0', fontSize: 14 }}><b>{k}:</b> {v}</p>)}
              <details style={{ fontSize: 13, marginTop: 6 }}><summary>Your original idea (kept word for word)</summary><p>{cons.original_idea}</p></details>
              {cons.status === 'proposed' && (
                <button style={{ ...btnPrimary, marginTop: 8 }} onClick={() => run(app().rpc('approve_constitution', { p_book: id }))}>
                  Approve constitution
                </button>
              )}
            </div>
          )}

          {ents.length > 0 && (
            <details style={card}>
              <summary><b>Book Bible</b> · {ents.length} entries</summary>
              {ents.map((e, i) => <p key={i} style={{ fontSize: 13, margin: '6px 0' }}><b>{e.name}</b> <i style={{ color: C.muted }}>{e.type}</i> — {e.profile?.summary}</p>)}
            </details>
          )}
        </section>

        {/* ---------- right: manuscript ---------- */}
        <section>
          <h2 style={{ marginTop: 0 }}>Manuscript</h2>
          {blocks.length === 0 && <p style={{ color: C.muted }}>No text yet. Approve the constitution, then ask for the opening paragraph.</p>}
          {blocks.map((b, n) => {
            const v = b.block_versions;
            const its = issues.filter(i => i.block_version_id === b.current_version_id);
            const rvs = reviews.filter(r => r.block_version_id === b.current_version_id);
            const avg = rvs.length ? Math.round(rvs.reduce((s, r) => s + (r.score ?? 0), 0) / rvs.length) : null;
            const cdec = consolidations.find(d => d.subject_ref === b.id);
            return (
              <div key={b.id} style={card}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <b style={{ fontSize: 13 }}>¶ {n + 1}</b><Status s={b.status} />
                  {v && <span style={{ fontSize: 12, color: C.muted }}>v{v.version_no} · {v.provenance.replace('_', ' ')}</span>}
                  {avg !== null && <span style={{ fontSize: 12, color: C.muted, marginLeft: 'auto' }}>Review score {avg}/100</span>}
                </div>
                <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, margin: 0, fontFamily: 'Georgia, serif', fontSize: 16 }}>
                  {v?.text ?? <i style={{ color: C.muted }}>The Lead Writer is drafting…</i>}
                </p>
                {rvs.length > 0 && (
                  <details style={{ marginTop: 8, fontSize: 13 }}>
                    <summary>What the team said ({rvs.length} reviews, {its.length} notes)</summary>
                    {rvs.map(r => <p key={r.role_code} style={{ margin: '4px 0' }}><b>{ROLE[r.role_code] ?? r.role_code} {r.score}/100:</b> {r.summary}</p>)}
                    {its.map(i => (
                      <p key={i.id} style={{ margin: '6px 0', paddingLeft: 8, borderLeft: `3px solid ${SEV[i.severity]}` }}>
                        <b style={{ color: SEV[i.severity] }}>{i.severity}</b> · {i.issue}
                        {i.suggested_fix && <><br /><span style={{ color: C.muted }}>Fix: {i.suggested_fix}</span></>}
                      </p>
                    ))}
                  </details>
                )}
                {cdec && <p style={{ fontSize: 13, color: C.warn }}><b>Needs your decision:</b> {cdec.recommendation}</p>}
                {b.status === 'qc_passed' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button style={btnPrimary} onClick={async () => {
                      if (cdec) await app().rpc('decide', { p_decision: cdec.id, p_choice: { title: 'Accept this version as it is' } });
                      run(app().rpc('approve_block', { p_block_id: b.id }));
                    }}>Approve paragraph</button>
                    <input style={{ ...input, flex: '1 1 200px' }} placeholder="What should change?" value={notes[b.id] ?? ''}
                           onChange={e => setNotes({ ...notes, [b.id]: e.target.value })} aria-label="Revision note" />
                    <button style={btn} onClick={async () => {
                      if (!notes[b.id]) { setErr('Write what should change first.'); return; }
                      if (cdec) await app().rpc('decide', { p_decision: cdec.id, p_choice: { title: 'Ask for another revision', note: notes[b.id] } });
                      run(app().rpc('request_revision', { p_block: b.id, p_note: notes[b.id] }));
                      setNotes({ ...notes, [b.id]: '' });
                    }}>Ask for a revision</button>
                  </div>
                )}
              </div>
            );
          })}
          {cons?.status === 'approved' && !active && (
            <div style={card}>
              <input style={input} placeholder="Optional guidance for the next paragraph" value={guidance} onChange={e => setGuidance(e.target.value)} aria-label="Guidance" />
              <button style={{ ...btnPrimary, marginTop: 8 }} disabled={ents.length === 0}
                      onClick={() => { run(app().rpc('request_next_paragraph', { p_book: id, p_guidance: guidance || null })); setGuidance(''); }}>
                {blocks.length ? 'Write the next paragraph' : 'Write the opening paragraph'}
              </button>
              {ents.length === 0 && <p style={{ fontSize: 13, color: C.muted }}>Waiting for the Book Bible…</p>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default function BookPage() {
  return <Suspense fallback={<main style={page}>Loading…</main>}><Workspace /></Suspense>;
}
