'use client';
import { useCallback, useEffect, useState } from 'react';
import { app, kick, supabaseBrowser, BASE } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, input, page } from './ui';
import { Bar, etcText, faceFor, type Progress } from './meters';

type Book = { id: string; working_title: string; status: string; kind: string; privacy_mode: string; created_at: string };

export default function Home() {
  const sb = supabaseBrowser();
  const [session, setSession] = useState<any>(null);
  const [isAuthor, setIsAuthor] = useState<boolean | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [prog, setProg] = useState<Record<string, { p: Progress | null; match: number | null }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPw, setNewPw] = useState('');
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [idea, setIdea] = useState('');
  const [kind, setKind] = useState('fiction');
  const [privacy, setPrivacy] = useState('standard');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data: a } = await sb.from('authors').select('id').maybeSingle();
    setIsAuthor(!!a);
    if (a) {
      const { data } = await sb.from('books').select('*').order('created_at', { ascending: false });
      setBooks((data ?? []) as Book[]);
      // progress, ETC and the latest reader mood for every book
      const entries = await Promise.all(((data ?? []) as any[]).map(async b => {
        const [{ data: p }, { data: r }] = await Promise.all([
          app().rpc('book_progress', { p_book: b.id }),
          sb.from('reader_emotions').select('match').eq('book_id', b.id).order('created_at', { ascending: false }).limit(5),
        ]);
        const ms = ((r ?? []) as any[]).map(x => Number(x.match)).filter(n => !isNaN(n));
        return [b.id, { p: (p as Progress) ?? null, match: ms.length ? Math.round(ms.reduce((a, c) => a + c, 0) / ms.length) : null }] as const;
      }));
      setProg(Object.fromEntries(entries));
    }
  }, [sb]);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [sb]);
  useEffect(() => { if (session) load(); }, [session, load]);

  if (!session) {
    return (
      <main style={page}>
        <Header />
        <div style={{ ...card, maxWidth: 480 }}>
          <h2 style={{ marginTop: 0 }}>Sign in</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button style={mode === 'link' ? btnPrimary : btn} onClick={() => setMode('link')}>Email me a link</button>
            <button style={mode === 'password' ? btnPrimary : btn} onClick={() => setMode('password')}>Use my password</button>
          </div>
          {mode === 'link' ? (
            <form onSubmit={async e => {
              e.preventDefault();
              const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + BASE + '/' } });
              setMsg(error ? (error.message.toLowerCase().includes('rate') ? 'Too many sign-in emails were sent recently. Wait an hour, or use your password.' : error.message)
                           : 'Check your email for the sign-in link. Open it in this browser.');
            }}>
              <input style={input} type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email" />
              <div style={{ marginTop: 8 }}><button style={btnPrimary}>Send the link</button></div>
              <p style={{ fontSize: 12.5, color: C.muted }}>First time? Use the link. Once signed in, set a password so you never depend on email.</p>
            </form>
          ) : (
            <form onSubmit={async e => {
              e.preventDefault();
              const { error } = await sb.auth.signInWithPassword({ email, password });
              setMsg(error ? 'That email and password did not match. Use “Email me a link” if you have not set a password yet.' : null);
            }}>
              <input style={input} type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email" />
              <input style={{ ...input, marginTop: 8 }} type="password" required placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} aria-label="Password" />
              <div style={{ marginTop: 8 }}><button style={btnPrimary}>Sign in</button></div>
            </form>
          )}
          {msg && <p role="status">{msg}</p>}
        </div>
      </main>
    );
  }

  if (isAuthor === false) {
    return (
      <main style={page}>
        <Header><button style={btn} onClick={() => sb.auth.signOut()}>Sign out</button></Header>
        <div style={{ ...card, maxWidth: 520 }}>
          <h2 style={{ marginTop: 0 }}>Welcome</h2>
          <p>This Author’s Room has no author yet. Claim it with the name you write under.</p>
          <form onSubmit={async e => {
            e.preventDefault();
            const { error } = await app().rpc('claim_author', { p_display_name: name });
            if (error) setMsg(error.message); else load();
          }}>
            <input style={input} required placeholder="Your author name" value={name} onChange={e => setName(e.target.value)} aria-label="Author name" />
            <div style={{ marginTop: 8 }}><button style={btnPrimary}>Claim this Author’s Room</button></div>
          </form>
          {msg && <p role="status" style={{ color: C.bad }}>{msg}</p>}
        </div>
      </main>
    );
  }

  return (
    <main style={page}>
      <Header><button style={btn} onClick={() => sb.auth.signOut()}>Sign out</button></Header>
      <div className="two-col">
        <section>
          <h2 style={{ marginTop: 0 }}>Your books</h2>
          {books.length === 0 && <p style={{ color: C.muted }}>No books yet. Start one on the right.</p>}
          <details style={{ ...card, fontSize: 14 }}>
            <summary>Account: set or change your password</summary>
            <p style={{ color: C.muted, fontSize: 13 }}>With a password you can sign in even when sign-in emails are delayed or limited.</p>
            <form onSubmit={async e => {
              e.preventDefault();
              if (newPw.length < 10) { setMsg('Use at least 10 characters.'); return; }
              const { error } = await sb.auth.updateUser({ password: newPw });
              setMsg(error ? error.message : 'Password saved. You can now sign in with it.'); setNewPw('');
            }} style={{ display: 'flex', gap: 8 }}>
              <input style={input} type="password" placeholder="New password (10+ characters)" value={newPw} onChange={e => setNewPw(e.target.value)} aria-label="New password" />
              <button style={btn}>Save</button>
            </form>
          </details>
          {books.map(b => (
            <a key={b.id} href={`${BASE}/book/?id=${b.id}`} style={{ ...card, display: 'block', textDecoration: 'none', color: C.ink }}>
              <b>{b.working_title}</b>
              <div style={{ fontSize: 13, color: C.muted }}>{b.kind.replace('_', '-')} · {b.status} · {b.privacy_mode}</div>
              {prog[b.id]?.p?.target_words ? (() => { const g = prog[b.id]; const f = faceFor((b as any).emotion_profile, g.match); return (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
                    <span><b>{g.p!.percent ?? 0}%</b> · {etcText(g.p)}</span>
                    {g.match != null && <span title="How readers feel about the latest paragraphs" style={{ color: f.color }}>{f.face} {f.label}</span>}
                  </div>
                  <Bar pct={g.p!.percent ?? 0} height={8} />
                </div>); })() : null}
            </a>
          ))}
        </section>
        <section style={card}>
          {msg && <p role="status" style={{ background: '#ddf4ff', padding: 8, borderRadius: 6 }}>{msg}</p>}
          <h2 style={{ marginTop: 0 }}>Start a new book</h2>
          <p style={{ color: C.muted, marginTop: 0 }}>Describe your idea in your own words. It doesn’t need to be complete — the team will ask what it needs.</p>
          <form onSubmit={async e => {
            e.preventDefault(); setBusy(true);
            const { data, error } = await app().rpc('create_book', { p_title: title, p_idea: idea, p_kind: kind, p_privacy: privacy });
            setBusy(false);
            if (error) { setMsg(error.message); return; }
            kick();
            window.location.href = `${BASE}/book/?id=${data}`;
          }}>
            <input style={input} placeholder="Working title (optional)" value={title} onChange={e => setTitle(e.target.value)} aria-label="Working title" />
            <textarea style={{ ...input, minHeight: 140, marginTop: 8 }} required placeholder="I have an idea for a story about…" value={idea} onChange={e => setIdea(e.target.value)} aria-label="Your idea" />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <select style={{ ...input, width: 'auto' }} value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind of book">
                <option value="fiction">Fiction</option><option value="non_fiction">Non-fiction</option>
                <option value="children">Children’s</option><option value="poetry">Poetry</option>
              </select>
              <select style={{ ...input, width: 'auto' }} value={privacy} onChange={e => setPrivacy(e.target.value)} aria-label="Privacy">
                <option value="standard">Standard (works on free tier)</option>
                <option value="confidential">Confidential (needs paid Gemini tier)</option>
              </select>
            </div>
            <p style={{ fontSize: 12.5, color: C.muted }}>
              On Gemini’s free tier, Google may use what you send to improve its products. Use “Confidential” for unpublished
              work you want kept out of that; the team will pause until the project is on a paid tier.
            </p>
            <button style={btnPrimary} disabled={busy}>{busy ? 'Starting…' : 'Start my book'}</button>
          </form>
        </section>
      </div>
    </main>
  );
}
