import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

/**
 * POST /api/keys — add a Gemini key. Runs on the server only: the secret goes
 * straight from this request into Supabase Vault and is never stored or
 * returned anywhere else. Caller must be the signed-in author.
 */
export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc) return NextResponse.json({ error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { data: user } = await createClient(url, anon).auth.getUser(token);
  if (!user?.user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const admin = createClient(url, svc, { auth: { persistSession: false } });
  const { data: author } = await admin.from('authors').select('id').eq('auth_user_id', user.user.id).maybeSingle();
  if (!author) return NextResponse.json({ error: 'Only the author can add keys' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const secret = String(body.secret ?? '').trim();
  const team = body.team ? String(body.team) : null;
  if (!/^AQ\.[A-Za-z0-9_\-]{20,}$/.test(secret)) {
    return NextResponse.json({ error: 'That is not a Gemini auth key (they start with "AQ.")' }, { status: 400 });
  }
  const { count } = await admin.from('ai_keys').select('id', { count: 'exact', head: true });
  const label = `K${String((count ?? 0) + 1).padStart(2, '0')}`;

  const { error } = await admin.schema('app').rpc('admin_add_ai_key', {
    p_label: label, p_secret: secret, p_team_code: team, p_notes: body.notes ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ label, last4: secret.slice(-4), team });
}
