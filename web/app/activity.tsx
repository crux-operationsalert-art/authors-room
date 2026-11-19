'use client';
// Live activity panel: who is working on what right now, what just finished, and what the author should do next.
import { useEffect, useState } from 'react';
import { btn, C, card } from './ui';

export const ROLE_NAME: Record<string, string> = {
  chief_editor: 'Chief Editor', author_interviewer: 'Interviewer', genre_strategist: 'Genre Strategist',
  story_architect: 'Story Architect', lead_writer: 'Lead Writer', voice_custodian: 'Voice reviewer',
  continuity_manager: 'Continuity reviewer', logic_fact_checker: 'Logic & fact reviewer',
  line_copy_editor: 'Language reviewer', reader_panel_manager: 'Simulated reader',
};

type Job = { id: string; workflow: string; step: string; role_code: string; status: string; attempts: number;
  payload: any; result: any; last_error: string | null; created_at: string; updated_at: string;
  locked_at: string | null; run_after: string | null };
type Run = { job_id: string | null; role_code: string; model_id: string; input_tokens: number | null;
  output_tokens: number | null; latency_ms: number | null; status: string; created_at: string };

const doing = (j: Job) => {
  const who = ROLE_NAME[j.role_code] ?? j.role_code;
  const loop = Number(j.payload?.loop ?? 0);
  switch (`${j.workflow}/${j.step}`) {
    case 'intake/interview': return `${who} is reading your answer and updating the brief`;
    case 'genre/directions': return `${who} is preparing three possible directions for your book`;
    case 'constitution/draft': return `${who} is drafting the book's constitution (its fixed rules)`;
    case 'bible/seed': return `${who} is building the Book Bible: characters, places and facts`;
    case 'outline/plan': return `${who} is planning the chapters and their lengths`;
    case 'feedback/plan': return `${who} is working out how to apply your note so the book still flows`;
    case 'paragraph/review_panel': return `The review panel (5 reviewers) is assessing the paragraph`;
    case 'paragraph/draft': return `${who} is writing the next paragraph`;
    case 'paragraph/revise': return `${who} is revising the paragraph after review (round ${loop})`;
    case 'paragraph/review': return `${who} is reviewing the new paragraph`;
    case 'paragraph/consolidate': return `${who} is combining the five reviews and deciding`;
    case 'paragraph/extract_facts': return `${who} is recording new facts for continuity`;
    default: return `${who}: ${j.step.replace(/_/g, ' ')}`;
  }
};
const TYPICAL: Record<string, string> = { interview: '30–60 s', directions: '40–80 s', draft: '30–90 s', seed: '40–90 s', plan: '30–90 s', review_panel: '30–80 s',
  revise: '30–90 s', review: '20–60 s', consolidate: '20–60 s', extract_facts: '10–30 s' };

const finished = (j: Job) => {
  const r = j.result ?? {};
  if (r.skipped) return `${ROLE_NAME[j.role_code] ?? j.role_code} skipped an older version (nothing lost)`;
  switch (`${j.workflow}/${j.step}`) {
    case 'intake/interview': return r.ready ? 'Interviewer finished: the brief is complete' : 'Interviewer replied with a question for you';
    case 'genre/directions': return `Genre Strategist proposed ${r.directions ?? 3} directions`;
    case 'constitution/draft': return 'Chief Editor drafted the constitution for your approval';
    case 'bible/seed': return `Story Architect built the Book Bible: ${r.entities ?? '?'} entries, ${r.facts ?? '?'} facts`;
    case 'feedback/plan': return `Chief Editor planned your note: revising paragraph${(r.paragraphs ?? []).length > 1 ? 's' : ''} ${(r.paragraphs ?? []).join(', ')}${r.standing ? ' and adding a direction for the whole book' : ''}`;
    case 'paragraph/review_panel': return `Review panel scored it ${r.score ?? '?'}/100 on average with ${r.issues ?? 0} note${r.issues === 1 ? '' : 's'}`;
    case 'outline/plan': return `Story Architect planned ${r.chapters ?? '?'} chapters (~${Number(r.words ?? 0).toLocaleString('en-IN')} words)`;
    case 'paragraph/draft': return `Lead Writer wrote a paragraph (${r.chars ?? '?'} characters)`;
    case 'paragraph/revise': return `Lead Writer revised the paragraph (${r.chars ?? '?'} characters)`;
    case 'paragraph/review': return `${ROLE_NAME[j.role_code]} scored it ${r.score ?? '?'}/100 with ${r.issues ?? 0} note${r.issues === 1 ? '' : 's'}`;
    case 'paragraph/consolidate': return r.decision === 'pass' ? `Chief Editor passed the paragraph (score ${r.score})`
      : r.decision === 'revise' ? `Chief Editor sent it back for revision (score ${r.score})` : 'Chief Editor asked for your decision';
    case 'paragraph/extract_facts': return `Continuity reviewer recorded ${r.facts ?? 0} new facts`;
    default: return `${ROLE_NAME[j.role_code] ?? j.role_code} finished ${j.step.replace(/_/g, ' ')}`;
  }
};

const secs = (from: string | null, now: number) => from ? Math.max(0, Math.round((now - Date.parse(from)) / 1000)) : 0;
const dur = (s: number) => s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
const clock = (t: string) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export type NextStep = { who: 'you' | 'team'; text: string; target?: string } | null;

export function ActivityPanel({ jobs, runs, next }: { jobs: Job[]; runs: Run[]; next: NextStep }) {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(true);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const running = jobs.filter(j => j.status === 'running');
  const queued = jobs.filter(j => j.status === 'queued');
  const waiting = jobs.filter(j => j.status === 'waiting_quota');
  const done = jobs.filter(j => ['done', 'failed'].includes(j.status)).slice(0, 12);
  const runsByJob = new Map<string, Run[]>();
  for (const r of runs) if (r.job_id) runsByJob.set(r.job_id, [...(runsByJob.get(r.job_id) ?? []), r]);
  const tokens = runs.reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  const lastSignal = [...jobs.map(j => j.updated_at), ...runs.map(r => r.created_at)].sort().at(-1);

  const dot = (color: string, pulse = false) => (
    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: color, marginRight: 8, flex: 'none',
      animation: pulse ? 'arPulse 1.2s ease-in-out infinite' : undefined }} />
  );

  return (
    <section style={{ ...card, borderColor: running.length ? C.accent : C.line }} aria-live="polite">
      <style>{`@keyframes arPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b>Live activity</b>
        <span style={{ fontSize: 12, color: C.muted }}>
          {lastSignal ? `last signal ${dur(secs(lastSignal, now))} ago` : 'no activity yet'} · {runs.length} AI calls · {k(tokens)} tokens
        </span>
      </div>

      {next && (
        <div style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 8,
          background: next.who === 'you' ? '#fff8c5' : '#ddf4ff', borderWidth: 1, borderStyle: 'solid', borderColor: next.who === 'you' ? C.warn : C.accent }}>
          <b>{next.who === 'you' ? 'Your turn: ' : 'Team’s turn: '}</b>{next.text}
          {next.target && <button style={{ ...btn, marginLeft: 8, padding: '2px 10px', fontSize: 13 }}
            onClick={() => document.getElementById(next.target!)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Show me</button>}
        </div>
      )}

      {running.map(j => (
        <div key={j.id} style={{ display: 'flex', alignItems: 'center', margin: '6px 0' }}>
          {dot(C.accent, true)}
          <span><b>{doing(j)}</b>
            <span style={{ color: C.muted, fontSize: 13 }}> · {dur(secs(j.locked_at ?? j.updated_at, now))} so far
              {TYPICAL[j.step] ? ` (usually ${TYPICAL[j.step]})` : ''}{j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}</span></span>
        </div>
      ))}
      {waiting.map(j => {
        const left = j.run_after ? Math.max(0, Math.round((Date.parse(j.run_after) - now) / 1000)) : 0;
        return (
          <div key={j.id} style={{ display: 'flex', alignItems: 'center', margin: '6px 0' }}>
            {dot(C.warn, true)}
            <span>{doing(j)} <span style={{ color: C.warn, fontSize: 13 }}>
              {left > 3600
                ? `— paused: today’s free Google limit is used up for every model. Resumes by itself at ${new Date(j.run_after!).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (in ${dur(left)}). A paid Gemini plan removes this wait.`
                : `— paused: Google’s per-minute limit. ${left > 0 ? `Resumes by itself in about ${dur(left)}.` : 'Resuming now.'}`}</span></span>
          </div>
        );
      })}
      {queued.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', margin: '6px 0', color: C.muted, fontSize: 14 }}>
          {dot(C.muted)}<span>Next in line: {queued.slice(0, 5).map(j => ROLE_NAME[j.role_code] ?? j.role_code).join(', ')}
            {queued.length > 5 ? ` and ${queued.length - 5} more` : ''} (starts within a minute)</span>
        </div>
      )}
      {!running.length && !waiting.length && !queued.length && (
        <div style={{ display: 'flex', alignItems: 'center', margin: '6px 0', color: C.muted, fontSize: 14 }}>
          {dot(C.ok)}<span>No AI work running. {next?.who === 'you' ? 'The team is waiting for you.' : 'Nothing is queued.'}</span>
        </div>
      )}

      <button style={{ background: 'none', borderWidth: 0, padding: 0, color: C.accent, cursor: 'pointer', fontSize: 13, marginTop: 6 }}
        onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Recent steps ({done.length})</button>
      {open && done.length > 0 && (
        <ol style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', fontSize: 13 }}>
          {done.map(j => {
            const rs = runsByJob.get(j.id) ?? [];
            const ok = rs.filter(r => r.status === 'ok');
            const t = ok.reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
            const ms = ok.reduce((s, r) => s + (r.latency_ms ?? 0), 0);
            const hiccups = rs.length - ok.length;
            return (
              <li key={j.id} style={{ display: 'flex', gap: 8, padding: '4px 0', borderTop: `1px solid ${C.line}` }}>
                <span style={{ color: C.muted, flex: 'none', width: 40 }}>{clock(j.updated_at)}</span>
                <span style={{ color: j.status === 'failed' ? C.bad : undefined }}>
                  {j.status === 'failed' ? `✗ ${ROLE_NAME[j.role_code] ?? j.role_code} could not finish: ${j.last_error ?? 'unknown error'}` : `✓ ${finished(j)}`}
                  <span style={{ color: C.muted }}>
                    {ms ? ` · ${dur(Math.round(ms / 1000))}` : ''}{t ? ` · ${k(t)} tokens` : ''}{ok[0] ? ` · ${ok[0].model_id}` : ''}
                    {hiccups ? ` · ${hiccups} retr${hiccups === 1 ? 'y' : 'ies'} (Google busy or quota)` : ''}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
