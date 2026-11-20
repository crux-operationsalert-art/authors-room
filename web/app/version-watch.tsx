'use client';
// Never show an old screen silently: compares this page's version with the live app's and offers the newer one.
import { useEffect, useState } from 'react';
import { APP_VERSION, LIVE_URL } from '@/lib/version';

export function VersionWatch() {
  const [live, setLive] = useState<string | null>(null);
  const local = typeof location !== 'undefined' && !location.hostname.endsWith('github.io');
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`${LIVE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' });
        const j = await r.json();
        if (!stop && j?.version) setLive(String(j.version));
      } catch { /* offline: try again later */ }
    };
    check();
    const id = setInterval(check, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  if (!live || live <= APP_VERSION) return null;
  const bar: React.CSSProperties = { position: 'sticky', top: 0, zIndex: 50, background: '#0969da', color: '#fff', padding: '8px 14px',
    display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontFamily: 'system-ui, sans-serif', fontSize: 14 };
  const b: React.CSSProperties = { background: '#fff', color: '#0969da', border: 0, borderRadius: 6, padding: '5px 12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'none' };
  return local ? (
    <div role="status" style={bar}>
      <span>This copy on your computer is older than the live app (yours {APP_VERSION}, live {live}).</span>
      <a style={b} href={LIVE_URL}>Open the live app</a>
    </div>
  ) : (
    <div role="status" style={bar}>
      <span>A newer version of Author’s Room is ready.</span>
      <button style={b} onClick={() => location.reload()}>Reload</button>
    </div>
  );
}
