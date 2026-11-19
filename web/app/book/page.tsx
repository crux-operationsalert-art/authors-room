'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { app, kick, supabaseBrowser } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, input, page, Status } from '../ui';
import { ActivityPanel, NextStep } from '../activity';

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
  const sending = useRef(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [cons, setCons] = useState<any>(null);
  const [ents, setEnts] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [allJobs, setAllJobs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [guidance, setGuidance] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const [b, m, d, c, e, bl, is, rv, j, aj, ar] = await Promise.all([
      sb.from('books').select('*').eq('id', id).single(),
      sb.from('intake_messages').select('*').eq('book_id', id).order('created_at'),
      sb.from('decisions').select('*').eq('book_id', id).eq('status', 'pending').order('created_at'),
      sb.from('book_constitutions').select('*').eq('book_id', id).order('version', { ascending: false }).limit(1).maybeSingle(),
      sb.from('entities').select('type, name, profile').eq('book_id', id).order('type'),
      sb.from('manuscript_blocks').select('id, order_key, status, current_version_id, block_versions!manuscript_blocks_current_fk(text, version_no, provenance)').eq('book_id', id).order('order_key'),
      sb.from('editorial_issues').select('*').eq('book_id', id).order('created_at'),
      sb.from('review_runs').select('block_version_id, role_code, score, summary').eq('book_id', id),
      sb.from('agent_jobs').select('workflow, step, role_code, status, last_error').eq('book_id', id).in('status', ['queued', 'running', 'waiting_quota', 'failed']),
      sb.from('agent_jobs').select('id, workflow, step, role_code, status, attempts, payload, result, last_error, created_at, updated_at, locked_at, run_after')
        .eq('book_id', id).order('updated_at', { ascending: false }).limit(40),
      sb.from('agent_runs').select('job_id, role_code, model_id, input_tokens, output_tokens, latency_ms, status, created_at')
        .eq('book_id', id).order('created_at', { ascending: false }).limit(300),
    ]);
    setBook(b.data); setMsgs((m.data ?? []) as Msg[]); setDecisions((d.data ?? []) as Decision[]); setCons(c.data);
    setEnts(e.data ?? []); setBlocks((bl.data ?? []) as any); setIssues((is.data ?? []) as Issue[]);
    setReviews((rv.data ?? []) as Review[]); setJobs(j.data ?? []);
    setAllJobs(aj.data ?? []); setRuns(ar.data ?? []);
  }, [sb, id]);

  useEffect(() => {
    load();
    const ch = sb.channel(`book-${id}`);
    for (const t of ['intake_messages', 'decisions', 'manuscript_blocks', 'editorial_issues', 'agent_jobs', 'book_constitutions']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `book_id=eq.${id}` }, () => load());
    }
    ch.subscribe();
    const poll = setInterval(load, 10_000);   // safety net if realtime drops
    const back = () => { setErr(null); load(); };
    window.addEventListener('online', back);
    return () => { sb.removeChannel(ch); clearInterval(poll); window.removeEventListener('online', back); };
  }, [sb, id, load]);
  // scroll only inside the chat box, never the whole page (keeps Live activity in view on phones)
  useEffect(() => { const box = chatEnd.current?.parentElement; if (box) box.scrollTop = box.scrollHeight; }, [msgs.length]);

  const OFFLINE_MSG = 'Could not reach the server. Check your internet and try again; nothing was lost.';
  const friendly = (m?: string) => (!m || /fetch|network|load failed|internet|ERR_/i.test(m)) ? OFFLINE_MSG : m;
  // One action at a time: a double click or double tap never sends twice.
  async function run<T>(p: PromiseLike<{ error: any; data?: T }>): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true; setErr(null);
    try {
      const { error } = await p;
      if (error && !/already (decided|approved)/i.test(error.message)) { setErr(friendly(error.message)); return false; }
      kick(); load(); return true;
    } catch {
      setErr(OFFLINE_MSG); return false;
    } finally { sending.current = false; }
  }

  function save(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function downloadBackup() {
    let data: any, error: any;
    try { ({ data, error } = await app().rpc('export_book', { p_book: id })); } catch (e) { error = e; }
    if (error) { setErr(friendly(error.message)); return; }
    save(`${book.working_title.replace(/[^\w\- ]+/g, '')} backup ${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
  }
  function downloadManuscript() {
    const approved = blocks.filter(b => b.status === 'author_approved' && b.block_versions);
    const pending = blocks.filter(b => b.status !== 'author_approved' && b.block_versions);
    const text = `# ${book.working_title}\n\n` + approved.map(b => b.block_versions!.text).join('\n\n') +
      (pending.length ? `\n\n---\nNot yet approved:\n\n` + pending.map(b => `[${b.status}] ${b.block_versions!.text}`).join('\n\n') : '') +
      `\n\n---\nAI-use note: paragraphs were drafted by AI (Gemini) and reviewed by AI reviewers; approved by the author.\n`;
    save(`${book.working_title.replace(/[^\w\- ]+/g, '')}.md`, text, 'text/markdown');
  }

  if (!book) return <main style={page}><Header /><p>Loading…</p></main>;
  const failed = jobs.filter(j => j.status === 'failed');
  const activeJobs = jobs.filter(j => j.status !== 'failed');
  const busy = activeJobs.length > 0;
  const waiting = activeJobs.filter(j => j.status === 'waiting_quota').length;
  const genreDecision = decisions.find(d => d.type === 'genre_direction');
  const consolidations = decisions.filter(d => d.type === 'consolidation');
  const active = blocks.find(b => !['author_approved', 'cut'].includes(b.status));
  const lastMsg = msgs.at(-1);
  const paraNo = (bid: string) => blocks.findIndex(x => x.id === bid) + 1;
  const next: NextStep = failed.length ? { who: 'you', text: 'a step could not finish. Press “Retry now” below.' }
    : busy ? { who: 'team', text: 'the team is working. You can close this page; the work carries on in the cloud.' }
    : book.status === 'intake' && !genreDecision ? (lastMsg?.role === 'author'
        ? { who: 'team', text: 'your message is in the queue; the Interviewer starts within a minute.' }
        : { who: 'you', text: 'answer the Interviewer’s question in the chat, or press “Enough questions — propose directions”.', target: 'act-chat' })
    : genreDecision ? { who: 'you', text: 'pick one of the three directions for your book.', target: 'act-directions' }
    : cons?.status === 'proposed' ? { who: 'you', text: 'read the book’s constitution and approve it (or reply in chat with changes).', target: 'act-constitution' }
    : cons?.status === 'approved' && ents.length === 0 ? { who: 'team', text: 'the Story Architect will build the Book Bible next.' }
    : active?.status === 'qc_passed' ? { who: 'you', text: `read paragraph ${paraNo(active.id)} and approve it, or ask for a revision.`, target: `act-block-${active.id}` }
    : active ? { who: 'team', text: `paragraph ${paraNo(active.id)} is being written or reviewed.` }
    : cons?.status === 'approved' ? { who: 'you', text: blocks.length ? 'ask for the next paragraph (you can add guidance first).' : 'the Book Bible is ready. Ask the Lead Writer for the opening paragraph.', target: 'act-write' }
    : null;
  const STAGE: Record<string, string> = { intake: 'Interview', planning: 'Planning — writing not started', writing: 'Writing', production: 'Production', released: 'Released' };

  return (
    <main style={page}>
      <Header><span style={{ fontSize: 13, color: C.muted }}>{book.working_title} · {STAGE[book.status] ?? book.status}</span></Header>
      {err && <p role="alert" style={{ ...card, borderColor: C.bad, color: C.bad }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <button style={btn} onClick={downloadBackup}>Download backup (.json)</button>
        <button style={btn} onClick={downloadManuscript} disabled={!blocks.some(b => b.block_versions)}>Download manuscript (.md)</button>
      </div>
      <ActivityPanel jobs={allJobs} runs={runs} next={next} />
      {failed.length > 0 && (
        <div style={{ ...card, borderColor: C.bad }}>
          <b style={{ color: C.bad }}>{failed.length} step{failed.length > 1 ? 's' : ''} could not finish</b>
          <span style={{ fontSize: 13, color: C.muted }}> — usually Google’s models were busy. Last error: {failed[0].last_error}</span>
          <div><button style={{ ...btn, marginTop: 8 }} onClick={() => run(app().rpc('retry_failed_jobs', { p_book: id }))}>Retry now</button></div>
        </div>
      )}

      <div className="two-col wide">
        {/* ---------- left: conversation + decisions ---------- */}
        <section>
          <div id="act-chat" style={{ ...card, maxHeight: 460, overflowY: 'auto' }}>
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
            <form onSubmit={e => { e.preventDefault(); if (!text.trim()) return; const t = text; setText(''); run(app().rpc('send_intake_message', { p_book: id, p_text: t })).then(ok => { if (!ok) setText(t); }); }}
                  style={{ display: 'flex', gap: 8 }}>
              <input style={input} placeholder="Reply to the team…" value={text} onChange={e => setText(e.target.value)} aria-label="Reply" />
              <button style={btnPrimary}>Send</button>
            </form>
          )}
          {book.status === 'intake' && !genreDecision && msgs.some(m => m.role === 'assistant') && (
            <button type="button" style={{ ...btn, marginTop: 6 }}
              onClick={() => run(app().rpc('send_intake_message', { p_book: id, p_text: 'That is enough questions — please use sensible defaults and propose directions now.' }))}>
              Enough questions — propose directions
            </button>
          )}

          {genreDecision && (
            <div id="act-directions" style={card}>
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
            <div id="act-constitution" style={card}>
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
          {blocks.length === 0 && <p style={{ color: C.muted }}>No text yet. Once the constitution is approved and the Book Bible is ready, ask for the opening paragraph.</p>}
          {blocks.map((b, n) => {
            const v = b.block_versions;
            const its = issues.filter(i => i.block_version_id === b.current_version_id);
            const rvs = reviews.filter(r => r.block_version_id === b.current_version_id);
            const avg = rvs.length ? Math.round(rvs.reduce((s, r) => s + (r.score ?? 0), 0) / rvs.length) : null;
            const cdec = consolidations.find(d => d.subject_ref === b.id);
            return (
              <div key={b.id} id={`act-block-${b.id}`} style={card}>
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
            <div id="act-write" style={card}>
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
