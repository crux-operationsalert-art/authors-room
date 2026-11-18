'use client';
import { useCallback, useEffect, useState } from 'react';
import { app, kick, supabaseBrowser } from '@/lib/supabaseBrowser';
import { btn, btnPrimary, C, card, Header, input, page } from './ui';

type Book = { id: string; working_title: string; status: string; kind: string; privacy_mode: string; created_at: string };

export default function Home() {
  const sb = supabaseBrowser();
  const [session, setSession] = useState<any>(null);
  const [isAuthor, setIsAuthor] = useState<boolean | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [email, setEmail] = useState('');
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
          <p style={{ color: C.muted }}>We’ll email you a sign-in link. Open it on this computer.</p>
          <form onSubmit={async e => {
            e.preventDefault();
            const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
            setMsg(error ? error.message : 'Check your email for the sign-in link.');
          }}>
            <input style={input} type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email" />
            <div style={{ marginTop: 8 }}><button style={btnPrimary}>Email me a link</button></div>
          </form>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)', gap: 16 }}>
        <section>
          <h2 style={{ marginTop: 0 }}>Your books</h2>
          {books.length === 0 && <p style={{ color: C.muted }}>No books yet. Start one on the right.</p>}
          {books.map(b => (
            <a key={b.id} href={`/book?id=${b.id}`} style={{ ...card, display: 'block', textDecoration: 'none', color: C.ink }}>
              <b>{b.working_title}</b>
              <div style={{ fontSize: 13, color: C.muted }}>{b.kind.replace('_', '-')} · {b.status} · {b.privacy_mode}</div>
            </a>
          ))}
        </section>
        <section style={card}>
          <h2 style={{ marginTop: 0 }}>Start a new book</h2>
          <p style={{ color: C.muted, marginTop: 0 }}>Describe your idea in your own words. It doesn’t need to be complete — the team will ask what it needs.</p>
          <form onSubmit={async e => {
            e.preventDefault(); setBusy(true);
            const { data, error } = await app().rpc('create_book', { p_title: title, p_idea: idea, p_kind: kind, p_privacy: privacy });
            setBusy(false);
            if (error) { setMsg(error.message); return; }
            kick();
            window.location.href = `/book?id=${data}`;
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
          {msg && <p role="status" style={{ color: C.bad }}>{msg}</p>}
        </section>
      </div>
    </main>
  );
}
