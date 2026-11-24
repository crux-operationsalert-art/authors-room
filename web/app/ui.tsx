'use client';
import { BASE } from '@/lib/supabaseBrowser';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export const C = { ink: '#1f2328', muted: '#59636e', line: '#d0d7de', soft: '#f6f8fa', accent: '#0969da', ok: '#1a7f37', warn: '#9a6700', bad: '#cf222e' };
export const page: CSSProperties = { fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: C.ink, maxWidth: 1100, margin: '0 auto', padding: '16px' };
export const card: CSSProperties = { borderWidth: 1, borderStyle: 'solid', borderColor: C.line, borderRadius: 8, padding: 14, background: '#fff', marginBottom: 12 };
export const btn: CSSProperties = { padding: '7px 12px', borderRadius: 6, borderWidth: 1, borderStyle: 'solid', borderColor: C.line, background: C.soft, cursor: 'pointer', fontSize: 14 };
export const btnPrimary: CSSProperties = { ...btn, background: C.accent, color: '#fff', borderColor: C.accent };
export const input: CSSProperties = { padding: 8, borderRadius: 6, borderWidth: 1, borderStyle: 'solid', borderColor: C.line, fontSize: 14, width: '100%', boxSizing: 'border-box' };

/** Shows a banner when the browser loses its connection. Work already sent keeps running in the cloud. */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  if (online) return null;
  return (
    <div role="alert" style={{ background: '#fff8c5', border: `1px solid ${C.warn}`, borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 14 }}>
      <b>You are offline.</b> Nothing is lost: your book is stored in the cloud and the team keeps working on anything already
      sent. Actions you take now will not go through until you are back online; this page refreshes itself when you reconnect.
    </div>
  );
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <>
    <OfflineBanner />
    <header style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: `1px solid ${C.line}`, paddingBottom: 10, marginBottom: 16 }}>
      <a href={`${BASE}/`} style={{ fontWeight: 700, fontSize: 18, color: C.ink, textDecoration: 'none' }}>Author’s Room</a>
      <nav style={{ display: 'flex', gap: 12, fontSize: 14 }}>
        <a href={`${BASE}/`}>Books</a><a href={`${BASE}/keys/`}>AI keys & quota</a>
      </nav>
      <div style={{ marginLeft: 'auto' }}>{children}</div>
    </header>
    </>
  );
}

const STATUS: Record<string, [string, string]> = {
  planned: ['Planned', C.muted], drafted: ['Drafted', C.warn], in_review: ['Team reviewing', C.warn],
  revision_requested: ['Being revised', C.warn], qc_passed: ['Passed review — awaiting you', C.accent], ai_approved: ['Approved by the AI team — awaiting you', C.accent],
  author_approved: ['Approved by you', C.ok], reopened: ['Reopened', C.bad], cut: ['Cut', C.muted],
};
export function Status({ s }: { s: string }) {
  const [label, color] = STATUS[s] ?? [s, C.muted];
  return <span style={{ fontSize: 12, fontWeight: 600, color, border: `1px solid ${color}`, borderRadius: 10, padding: '1px 8px' }}>{label}</span>;
}
