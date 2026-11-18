'use client';
import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabaseBrowser';

/** P0 sign-in: email one-time code via Supabase Auth. MFA (TOTP) is enabled in E0.3. */
export default function Home() {
  const sb = supabaseBrowser();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { sb.auth.getSession().then(({ data }) => setSignedIn(!!data.session)); }, [sb]);

  if (signedIn) {
    return (
      <main style={{ fontFamily: 'system-ui', maxWidth: 560, margin: '48px auto', padding: 16 }}>
        <h1>Author’s Room</h1>
        <p>You are signed in.</p>
        <p><a href="/keys">AI keys, teams and quota →</a></p>
        <button onClick={async () => { await sb.auth.signOut(); setSignedIn(false); }}>Sign out</button>
      </main>
    );
  }
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 560, margin: '48px auto', padding: 16 }}>
      <h1>Author’s Room</h1>
      {!sent ? (
        <form onSubmit={async e => { e.preventDefault();
          const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
          if (error) setMsg(error.message); else { setSent(true); setMsg('Check your email for a 6-digit code.'); } }}>
          <input type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email" />{' '}
          <button>Send code</button>
        </form>
      ) : (
        <form onSubmit={async e => { e.preventDefault();
          const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
          if (error) setMsg(error.message); else setSignedIn(true); }}>
          <input inputMode="numeric" required placeholder="123456" value={code} onChange={e => setCode(e.target.value)} aria-label="Code" />{' '}
          <button>Sign in</button>
        </form>
      )}
      {msg && <p role="status">{msg}</p>}
    </main>
  );
}
