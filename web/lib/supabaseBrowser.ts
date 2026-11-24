'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
/** Browser client: publishable key + the author's session. Never holds AI keys. */
export function supabaseBrowser(): SupabaseClient {
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}

/** Call the worker with only the headers it allows (supabase-js adds x-client-info, which the browser's CORS check rejects). */
export async function callWorker(body: Record<string, unknown>, fn = 'worker'): Promise<{ data: any; error: { message: string } | null }> {
  try {
    const { data: s } = await supabaseBrowser().auth.getSession();
    const token = s.session?.access_token;
    if (!token) return { data: null, error: { message: 'Please sign in again.' } };
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { data, error: { message: data?.error ?? `The worker answered ${res.status}.` } };
    return { data, error: null };
  } catch {
    return { data: null, error: { message: 'Could not reach the team right now. Check your internet connection and try again.' } };
  }
}

/** Google account connector (OAuth, discovery, provisioning). */
export const callGoogle = (body: Record<string, unknown>) => callWorker(body, 'google');

/** Ask the worker to start on queued jobs now instead of waiting for the next minute. */
export async function kick() {
  await callWorker({ action: 'tick' });   // failures are fine: the 1-minute schedule picks the job up anyway
}

/** Path prefix of the site ('' on your PC, '/authors-room' on GitHub Pages). */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const app = () => supabaseBrowser().schema('app');
