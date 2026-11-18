'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
/** Browser client: publishable key + the author's session. Never holds AI keys. */
export function supabaseBrowser(): SupabaseClient {
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}

/** Ask the worker to start on queued jobs now instead of waiting for the next minute. */
export async function kick() {
  try { await supabaseBrowser().functions.invoke('worker', { body: { action: 'tick' } }); } catch { /* cron will pick it up */ }
}

export const app = () => supabaseBrowser().schema('app');
