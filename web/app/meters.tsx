'use client';
// Progress bar with estimated time of completion, and the reader-mood meter (how readers feel vs how this book should feel).
import { C, card, btn } from './ui';

export type Progress = { target_words: number; approved_words: number; approved_paragraphs: number; percent: number | null;
  words_per_hour: number; words_left: number; hours_left: number | null; eta: string | null };
export type Reading = { block_id: string; block_version_id: string; source: 'panel' | 'audit'; felt: { emotion: string; intensity: number }[];
  match: number | null; drift: string | null; fix: string | null; created_at: string };

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
export function duration(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  const d = Math.floor(hours / 24), h = Math.round(hours % 24);
  return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}`;
}
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function Bar({ pct, color = C.accent, height = 10 }: { pct: number; color?: string; height?: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}
         style={{ background: '#eaeef2', borderRadius: height, height, width: '100%', overflow: 'hidden' }}>
      <div style={{ width: `${p}%`, minWidth: p > 0 ? 3 : 0, height: '100%', background: color, borderRadius: height, transition: 'width .6s' }} />
    </div>
  );
}

export function etcText(p: Progress | null) {
  if (!p) return '';
  if (!p.target_words) return 'No chapter plan yet, so no estimate.';
  if (p.words_left === 0) return 'All planned words are written.';
  if (!p.hours_left || !p.eta) return 'Estimate appears once the first paragraphs are approved.';
  return `About ${duration(p.hours_left)} to go · around ${when(p.eta)}`;
}

export function ProgressCard({ p }: { p: Progress | null }) {
  if (!p) return null;
  return (
    <section id="act-progress" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <b>Progress {p.percent != null ? `${p.percent}%` : ''}</b>
        <span style={{ fontSize: 13, color: C.muted }}>{etcText(p)}</span>
      </div>
      <Bar pct={p.percent ?? 0} />
      <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
        {fmt(p.approved_words)} of {fmt(p.target_words)} words approved · {p.approved_paragraphs} paragraphs
        {p.words_per_hour > 0 && <> · pace {fmt(p.words_per_hour)} words/hour (last 48 h)</>}
      </div>
      {p.hours_left != null && p.hours_left > 24 * 14 && (
        <p style={{ fontSize: 13, color: C.warn, margin: '6px 0 0' }}>
          At this pace the book takes weeks: most time goes on re-writing each paragraph many times to clear your score bar on the free
          AI allowance. A lower bar, or paid billing on the Gemini project, would shorten it a lot.
        </p>)}
    </section>
  );
}

// ---- reader mood
export function faceFor(profile: any, match: number | null) {
  const scale = profile?.scale?.length >= 5 ? profile.scale
    : [{ face: '😄', label: 'Loving it' }, { face: '🙂', label: 'Enjoying it' }, { face: '😐', label: 'Flat' }, { face: '🙁', label: 'Disappointed' }, { face: '😠', label: 'Put off' }];
  if (match == null) return { face: '…', label: 'Not read yet', color: C.muted };
  const i = match >= 90 ? 0 : match >= 80 ? 1 : match >= 65 ? 2 : match >= 50 ? 3 : 4;
  return { ...scale[i], color: [C.ok, C.ok, C.warn, C.bad, C.bad][i] };
}

// The reading that describes the paragraph as it is NOW (current version; audit preferred), else the latest one.
export function latestReading(readings: Reading[], blockId: string, currentVersion: string | null) {
  const mine = readings.filter(r => r.block_id === blockId);
  const now = mine.filter(r => r.block_version_id === currentVersion);
  const pick = now.find(r => r.source === 'audit') ?? now[0] ?? null;
  return pick ? { r: pick, current: true } : mine[0] ? { r: mine[0], current: false } : null;
}

export function ParagraphMood({ profile, reading }: { profile: any; reading: { r: Reading; current: boolean } | null }) {
  if (!reading) return null;
  const f = faceFor(profile, reading.r.match);
  const felt = reading.r.felt.slice(0, 3).map(e => `${e.emotion} ${e.intensity}`).join(', ');
  return (
    <span title={`Readers felt: ${felt}${reading.r.drift ? `\nWhat is off: ${reading.r.drift}` : ''}${reading.current ? '' : '\n(reading of an earlier version)'}`}
          style={{ fontSize: 12, color: f.color, border: `1px solid ${f.color}`, borderRadius: 10, padding: '0 8px', opacity: reading.current ? 1 : 0.6 }}>
      {f.face} {f.label} · {reading.r.match}/100
    </span>
  );
}

export function MoodMeter({ profile, readings, blocks, onAudit, auditRunning }:
  { profile: any; readings: Reading[]; blocks: { id: string; current_version_id: string | null }[]; onAudit: () => void; auditRunning: boolean }) {
  const perAll = blocks.map(b => latestReading(readings, b.id, b.current_version_id));
  const per = perAll.filter(Boolean) as { r: Reading; current: boolean }[];
  const recent = per.slice(-5);
  const avg = recent.length ? Math.round(recent.reduce((s, x) => s + (x.r.match ?? 0), 0) / recent.length) : null;
  const f = faceFor(profile, avg);
  const felt = new Map<string, number[]>();
  recent.forEach(x => x.r.felt.forEach(e => felt.set(e.emotion.toLowerCase(), [...(felt.get(e.emotion.toLowerCase()) ?? []), e.intensity])));
  const top = [...felt.entries()].map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / recent.length)] as [string, number])
    .sort((a, b) => b[1] - a[1]).slice(0, 6);
  const drifts = recent.map(x => x.r.drift).filter(Boolean).slice(-2) as string[];
  return (
    <section id="act-mood" style={{ ...card, borderColor: f.color }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 52, lineHeight: 1 }} aria-label={`Reader mood: ${f.label}`}>{f.face}</div>
        <div style={{ flex: '1 1 240px' }}>
          <b>How readers feel right now: <span style={{ color: f.color }}>{f.label}</span>{avg != null && <> · {avg}/100 match</>}</b>
          <div style={{ fontSize: 13, color: C.muted, margin: '2px 0 6px' }}>
            {profile?.summary ?? 'The team works out how this book should make readers feel from its constitution.'}
          </div>
          {avg != null && <Bar pct={avg} color={f.color} height={8} />}
        </div>
        <button style={btn} disabled={auditRunning} onClick={onAudit}>{auditRunning ? 'Readers are reading the book…' : 'Re-read the whole book as readers'}</button>
      </div>
      {profile?.intended && (
        <div style={{ fontSize: 13, marginTop: 10 }}>
          <span style={{ color: C.muted }}>Should feel: </span>
          {profile.intended.map((e: any) => <span key={e.emotion} style={{ marginRight: 6, padding: '1px 8px', borderRadius: 10, background: '#dafbe1' }}>{e.emotion}</span>)}
          <span style={{ color: C.muted, marginLeft: 6 }}>Must not feel: </span>
          {(profile.avoid ?? []).map((e: string) => <span key={e} style={{ marginRight: 6, padding: '1px 8px', borderRadius: 10, background: '#ffebe9' }}>{e}</span>)}
        </div>)}
      {top.length > 0 && (
        <div style={{ fontSize: 13, marginTop: 8 }}>
          <span style={{ color: C.muted }}>Actually felt (last {recent.length} paragraphs): </span>
          {top.map(([k, v]) => <span key={k} style={{ marginRight: 10 }}>{k} <b>{v}</b></span>)}
        </div>)}
      {per.length > 0 && (
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginTop: 8 }} aria-label="Reader mood by paragraph">
          {perAll.map((x, i) => { if (!x) return null; const g = faceFor(profile, x.r.match);
            return <span key={i} title={`¶ ${i + 1}: ${g.label} · ${x.r.match}/100`} style={{ fontSize: 18, opacity: x.current ? 1 : 0.45 }}>{g.face}</span>; })}
        </div>)}
      {drifts.length > 0 && <p style={{ fontSize: 13, color: C.warn, margin: '8px 0 0' }}>What readers noticed: {drifts.join(' · ')}</p>}
    </section>
  );
}
