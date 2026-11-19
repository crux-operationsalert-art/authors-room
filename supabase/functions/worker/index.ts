// Author's Room worker (Supabase Edge Function).
// Called every minute by pg_cron (x-worker-token) and immediately by the app after an
// author action (author's JWT). Starts queued jobs during the first 15 s of each call.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { generate, PolicyError, QuotaExhaustedError } from './ai.ts';
import * as R from './roles.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-worker-token, apikey' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const app = db.schema('app');

  // --- who is calling: cron (worker token) or the signed-in author
  const token = req.headers.get('x-worker-token');
  let allowed = false, isAdmin = false;
  if (token) {
    const { data } = await app.rpc('check_worker_token', { p_token: token });
    allowed = isAdmin = data === true;
  } else {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (jwt) {
      const { data: u } = await db.auth.getUser(jwt);
      if (u?.user) {
        const { data: a } = await db.from('authors').select('id').eq('auth_user_id', u.user.id).maybeSingle();
        allowed = isAdmin = !!a;
      }
    }
  }
  if (!allowed) return json({ error: 'not allowed' }, 401);

  const body = await req.json().catch(() => ({}));
  const action = body.action ?? 'tick';

  if (action === 'check_keys' && isAdmin) return json(await checkKeys(db));
  if (action === 'add_key' && isAdmin) return json(await addKey(db, body), 200);

  // --- tick: start new jobs only in the first 15 s (one slow call can take ~135 s)
  const started = Date.now(), done: unknown[] = [];
  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`;
  while (Date.now() - started < 15_000) {
    const { data, error } = await app.rpc('claim_next_job', { p_worker: workerId });
    if (error) return json({ error: error.message, done }, 500);
    const job = (data as any[])?.[0];
    if (!job) break;
    try {
      const { data: role } = await db.from('agent_roles').select('team_code, default_tier').eq('code', job.role_code).single();
      const { data: k } = await app.rpc('resolve_key_for_team', { p_team_code: role!.team_code });
      if ((k as any[])?.[0]) await app.rpc('set_job_key', { p_job: job.id, p_key: (k as any[])[0].key_id });
      const result = await runJob(db, job, role!);
      await app.rpc('complete_job', { p_job: job.id, p_result: result ?? {} });
      done.push({ id: job.id, step: `${job.workflow}/${job.step}`, ok: true });
    } catch (e) {
      const quota = e instanceof QuotaExhaustedError;
      const retry = quota ? (e as QuotaExhaustedError).retryAfterSeconds : e instanceof PolicyError ? 3600 : 30;
      await app.rpc('fail_job', { p_job: job.id, p_error: String((e as Error).message ?? e), p_retry_in_seconds: retry, p_quota: quota });
      if (e instanceof PolicyError) await note(db, job.book_id, `The team paused: ${(e as Error).message}`);
      done.push({ id: job.id, step: `${job.workflow}/${job.step}`, ok: false, error: String((e as Error).message ?? e) });
    }
  }
  return json({ done });
});

// ------------------------------------------------------------------ helpers
async function note(db: SupabaseClient, bookId: string | null, text: string) {
  if (bookId) await db.from('intake_messages').insert({ book_id: bookId, role: 'system', content: text });
}

async function bookContext(db: SupabaseClient, bookId: string) {
  const [{ data: book }, { data: cons }, { data: voice }, { data: ents }, { data: facts }] = await Promise.all([
    db.from('books').select('*').eq('id', bookId).single(),
    db.from('book_constitutions').select('*').eq('book_id', bookId).order('version', { ascending: false }).limit(1).single(),
    db.from('author_voice_profiles').select('*').eq('book_id', bookId).maybeSingle(),
    db.from('entities').select('type, name, profile').eq('book_id', bookId).neq('status', 'retired'),
    db.from('canon_facts').select('statement').eq('book_id', bookId).neq('status', 'retired').order('created_at').limit(200),
  ]);
  return { book, cons, voice, ents: ents ?? [], facts: facts ?? [] };
}

function constitutionText(c: any) {
  return [`Premise: ${c.premise}`, `Genre: ${c.genre} / ${c.subgenre}`, `Audience: ${c.audience}`,
    `Themes: ${(c.themes ?? []).join(', ')}`, `POV: ${c.pov}; tense: ${c.tense}`, `Voice: ${c.voice}`,
    `Ending intent: ${c.ending_intent}`, `Length: ${c.length_target}`,
    `Never change: ${(c.never_change ?? []).join('; ')}`].join('\n');
}

async function manuscriptSoFar(db: SupabaseClient, bookId: string, exceptBlock?: string) {
  const { data } = await db.from('manuscript_blocks')
    .select('id, order_key, status, block_versions!manuscript_blocks_current_fk(text)')
    .eq('book_id', bookId).in('status', ['qc_passed', 'author_approved']).order('order_key');
  return (data ?? []).filter((b: any) => b.id !== exceptBlock).map((b: any) => b.block_versions?.text ?? '').filter(Boolean);
}

const parse = (t: string) => JSON.parse(t);

// ------------------------------------------------------------------ jobs
async function runJob(db: SupabaseClient, job: any, role: { team_code: string; default_tier: string }) {
  const app = db.schema('app');
  const base = { roleCode: job.role_code, teamCode: role.team_code, tier: role.default_tier, bookId: job.book_id,
                 jobId: job.id, promptVersion: R.PROMPT_VERSION };
  const key = `${job.workflow}/${job.step}`;

  if (key === 'smoke_test/ping') {
    const r = await generate(db, { ...base, system: 'Reply with the single word OK.', prompt: 'Say OK.', maxOutputTokens: 64 });
    return { reply: r.text.trim(), model: r.modelId, key: r.keyLabel };
  }

  if (key === 'intake/interview') {
    const { data: msgs } = await db.from('intake_messages').select('role, content').eq('book_id', job.book_id).order('created_at');
    const { data: cons } = await db.from('book_constitutions').select('*').eq('book_id', job.book_id).order('version', { ascending: false }).limit(1).single();
    const convo = (msgs ?? []).map((m: any) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    const r = await generate(db, { ...base, system: R.interviewer.system, jsonSchema: R.interviewer.schema,
      prompt: `ORIGINAL IDEA (verbatim):\n${cons!.original_idea}\n\nCURRENT BRIEF:\n${JSON.stringify(cons!.brief)}\n\nCONVERSATION:\n${convo}` });
    const out = parse(r.text);
    // Safety net: never trap the author in the interview. Move on when the author asks to,
    // or after three team questions, even if the model still wants more.
    const authorMsgs = (msgs ?? []).filter((m: any) => m.role === 'author');
    const asked = (msgs ?? []).filter((m: any) => m.role === 'assistant').length;
    const lastAuthor = authorMsgs.at(-1)?.content ?? '';
    const wantsToMoveOn = /\b(propose|proceed|go ahead|move on|skip|directions|enough questions|just start|use defaults?)\b/i.test(lastAuthor);
    const forced = !out.ready && asked >= 1 && (wantsToMoveOn || asked >= 3);
    if (forced) {
      out.ready = true;
      const gaps = (out.missing ?? []).length ? ` I'll use sensible defaults for: ${out.missing.join(', ')} — you can change any of them when you review the constitution.` : '';
      out.reply = `Thank you — that's enough for the team to start.${gaps} The team will now propose directions for your book.`;
    }
    await db.from('book_constitutions').update({ brief: out.brief, missing: out.missing ?? [] }).eq('id', cons!.id);
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant', content: out.reply });
    if (out.ready) {
      const { count } = await db.from('decisions').select('id', { count: 'exact', head: true })
        .eq('book_id', job.book_id).eq('type', 'genre_direction');
      if (!count) await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'genre', p_step: 'directions',
                                             p_role: 'genre_strategist', p_priority: 94, p_payload: {} });
    }
    return { ready: out.ready, missing: out.missing, forced };
  }

  if (key === 'genre/directions') {
    const { data: cons } = await db.from('book_constitutions').select('*').eq('book_id', job.book_id).order('version', { ascending: false }).limit(1).single();
    const r = await generate(db, { ...base, system: R.genre.system, jsonSchema: R.genre.schema,
      prompt: `ORIGINAL IDEA:\n${cons!.original_idea}\n\nBRIEF:\n${JSON.stringify(cons!.brief, null, 1)}` });
    const out = parse(r.text);
    await db.from('decisions').insert({ book_id: job.book_id, type: 'genre_direction', question: out.question,
      options: out.directions, recommendation: out.recommendation });
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant',
      content: `The team has ${out.directions.length} possible directions for your book. Please choose one below.` });
    return { directions: out.directions.length };
  }

  if (key === 'constitution/draft') {
    const { data: cons } = await db.from('book_constitutions').select('*').eq('book_id', job.book_id).order('version', { ascending: false }).limit(1).single();
    const { data: dec } = await db.from('decisions').select('outcome, options').eq('id', job.payload.decision_id).single();
    const r = await generate(db, { ...base, system: R.constitution.system, jsonSchema: R.constitution.schema,
      prompt: `ORIGINAL IDEA:\n${cons!.original_idea}\n\nBRIEF:\n${JSON.stringify(cons!.brief, null, 1)}\n\nCHOSEN DIRECTION:\n${JSON.stringify(dec!.outcome, null, 1)}` });
    const o = parse(r.text);
    await db.from('book_constitutions').update({ premise: o.premise, genre: o.genre, subgenre: o.subgenre, audience: o.audience,
      themes: o.themes, pov: o.pov, tense: o.tense, voice: o.voice, ending_intent: o.ending_intent, length_target: o.length_target,
      never_change: o.never_change, status: 'proposed' }).eq('id', cons!.id);
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant', content: o.message });
    return { proposed: true };
  }

  if (key === 'bible/seed') {
    const { cons } = await bookContext(db, job.book_id);
    const r = await generate(db, { ...base, system: R.bible.system, jsonSchema: R.bible.schema, maxOutputTokens: 6000,
      prompt: `CONSTITUTION (approved):\n${constitutionText(cons)}\n\nBRIEF:\n${JSON.stringify(cons!.brief, null, 1)}` });
    const o = parse(r.text);
    const ids: Record<string, string> = {};
    for (const e of o.entities ?? []) {
      const { data } = await db.from('entities').upsert({ book_id: job.book_id, type: e.type, name: e.name, profile: e.profile ?? {}, status: 'canon' },
        { onConflict: 'book_id,type,name' }).select('id, name').single();
      if (data) ids[data.name] = data.id;
    }
    if (o.facts?.length) await db.from('canon_facts').insert(o.facts.map((f: any) => ({ book_id: job.book_id,
      entity_id: f.entity ? ids[f.entity] ?? null : null, statement: f.statement, status: 'canon' })));
    await db.from('author_voice_profiles').upsert({ book_id: job.book_id, traits: o.voice ?? {}, banned_phrases: o.voice?.avoid ?? [],
      updated_at: new Date().toISOString() }, { onConflict: 'book_id' });
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant', content: o.message });
    return { entities: o.entities?.length ?? 0, facts: o.facts?.length ?? 0 };
  }

  if (key === 'paragraph/draft' || key === 'paragraph/revise') {
    const blockId = job.payload.block_id, loop = Number(job.payload.loop ?? 0);
    const ctx = await bookContext(db, job.book_id);
    const prev = await manuscriptSoFar(db, job.book_id, blockId);
    const { data: blk } = await db.from('manuscript_blocks').select('id, current_version_id, block_versions!manuscript_blocks_current_fk(text)').eq('id', blockId).single();
    const current = (blk as any)?.block_versions?.text;
    let task = prev.length ? 'Write the next paragraph.' : 'Write the opening paragraph of the book.';
    if (job.payload.guidance) task += `\nAuthor's guidance: ${job.payload.guidance}`;
    if (key === 'paragraph/revise') task = `Revise this paragraph:\n"""${current}"""\n\nInstructions: ${job.payload.instructions ?? ''}${job.payload.author_note ? `\nAuthor's note (highest priority): ${job.payload.author_note}` : ''}\nKeep what works. Output only the revised paragraph.`;
    const r = await generate(db, { ...base, system: R.writer.system, maxOutputTokens: 1200, temperature: 0.9,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nVOICE PROFILE:\n${JSON.stringify(ctx.voice?.traits ?? {})}\nAvoid: ${(ctx.voice?.banned_phrases ?? []).join('; ')}\n\n` +
              `BOOK BIBLE:\n${ctx.ents.map((e: any) => `- ${e.type} ${e.name}: ${e.profile?.summary ?? ''}`).join('\n')}\n\n` +
              `CANON FACTS:\n${ctx.facts.map((f: any) => `- ${f.statement}`).join('\n')}\n\n` +
              `MANUSCRIPT SO FAR (${prev.length} paragraphs, last 8 shown):\n${prev.slice(-8).join('\n\n') || '(none yet)'}\n\nTASK:\n${task}` });
    const text = r.text.trim().replace(/^["“]|["”]$/g, '');
    const { data: vid, error } = await app.rpc('commit_block_version', { p_block_id: blockId, p_text: text,
      p_reason: key === 'paragraph/draft' ? 'first draft' : `revision ${loop}`, p_actor_type: 'agent',
      p_provenance: key === 'paragraph/draft' ? 'ai_generated' : 'ai_edited' });
    if (error) throw new Error(error.message);
    await app.rpc('set_block_status', { p_block_id: blockId, p_status: 'in_review' });
    for (const roleCode of Object.keys(R.LAYER1)) {
      await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'review', p_role: roleCode,
        p_priority: 88, p_payload: { block_id: blockId, block_version_id: vid, loop } });
    }
    return { block_version_id: vid, chars: text.length };
  }

  if (key === 'paragraph/review') {
    const { block_id, block_version_id, loop } = job.payload;
    const meta = R.LAYER1[job.role_code];
    const { data: cur } = await db.from('manuscript_blocks').select('current_version_id, status').eq('id', block_id).single();
    if (cur?.current_version_id !== block_version_id || cur?.status === 'author_approved') return { skipped: 'stale version' };
    const ctx = await bookContext(db, job.book_id);
    const prev = await manuscriptSoFar(db, job.book_id, block_id);
    const { data: v } = await db.from('block_versions').select('text').eq('id', block_version_id).single();
    const spec = R.reviewer(meta.name, meta.focus);
    const r = await generate(db, { ...base, system: spec.system, jsonSchema: spec.schema, temperature: 0.2,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nVOICE PROFILE:\n${JSON.stringify(ctx.voice?.traits ?? {})}\n\n` +
              `CANON FACTS:\n${ctx.facts.map((f: any) => `- ${f.statement}`).join('\n')}\n\n` +
              `EARLIER PARAGRAPHS (last 8):\n${prev.slice(-8).join('\n\n') || '(none — this is the opening)'}\n\nNEW PARAGRAPH TO REVIEW:\n"""${v!.text}"""` });
    const o = parse(r.text);
    await db.from('review_runs').upsert({ book_id: job.book_id, block_version_id, layer: 1, role_code: job.role_code,
      score: o.score, summary: o.summary, result: o }, { onConflict: 'block_version_id,role_code' });
    if (o.issues?.length) await db.from('editorial_issues').insert(o.issues.map((i: any) => ({ book_id: job.book_id, block_id,
      block_version_id, raised_by: job.role_code, severity: i.severity, category: i.category, issue: i.issue,
      evidence: i.evidence ?? null, suggested_fix: i.suggested_fix })));
    const { count } = await db.from('review_runs').select('id', { count: 'exact', head: true }).eq('block_version_id', block_version_id);
    if ((count ?? 0) >= Object.keys(R.LAYER1).length) {
      // unique index makes this idempotent if two reviewers finish together
      await db.from('agent_jobs').insert({ book_id: job.book_id, workflow: 'paragraph', step: 'consolidate', role_code: 'chief_editor',
        priority: 89, payload: { block_id, block_version_id, loop } });
    }
    return { score: o.score, issues: o.issues?.length ?? 0 };
  }

  if (key === 'paragraph/consolidate') {
    const { block_id, block_version_id } = job.payload, loop = Number(job.payload.loop ?? 0);
    const { data: cur } = await db.from('manuscript_blocks').select('current_version_id, status').eq('id', block_id).single();
    if (cur?.current_version_id !== block_version_id || cur?.status === 'author_approved') return { skipped: 'stale version' };
    const [{ data: runs }, { data: issues }, { data: v }] = await Promise.all([
      db.from('review_runs').select('role_code, score, summary').eq('block_version_id', block_version_id),
      db.from('editorial_issues').select('id, raised_by, severity, category, issue, evidence, suggested_fix').eq('block_version_id', block_version_id),
      db.from('block_versions').select('text').eq('id', block_version_id).single(),
    ]);
    const r = await generate(db, { ...base, system: R.consolidate.system, jsonSchema: R.consolidate.schema, temperature: 0.2,
      prompt: `PARAGRAPH:\n"""${v!.text}"""\n\nREVIEWS:\n${JSON.stringify(runs, null, 1)}\n\nISSUES:\n${JSON.stringify(issues, null, 1)}` });
    const o = parse(r.text);
    const blocking = (issues ?? []).some((i: any) => i.severity === 'critical' || i.severity === 'major');
    // A critical/major issue always forces revision; otherwise only a weak overall score does (minor notes are kept for the author).
    const revise = blocking || (o.decision === 'revise' && Number(o.overall_score) < 80);
    if (revise && loop < 2) {
      await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'revision_requested' });
      await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'revise', p_role: 'lead_writer',
        p_priority: 90, p_payload: { block_id, instructions: o.instructions, loop: loop + 1 } });
      await db.from('editorial_issues').update({ status: 'accepted' }).eq('block_version_id', block_version_id).in('severity', ['critical', 'major']);
      return { decision: 'revise', loop: loop + 1, score: o.overall_score };
    }
    if (revise) {
      // two loops used: the author decides (Brief: no silent acceptance)
      await db.from('decisions').insert({ book_id: job.book_id, type: 'consolidation', subject_ref: block_id,
        question: 'The team could not clear every serious issue in two revisions. How should we proceed?',
        options: [{ title: 'Accept this version as it is' }, { title: 'Ask for another revision with my note' }],
        recommendation: o.summary + (o.disagreements ? `\nReviewers disagreed: ${o.disagreements}` : '') });
      await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'qc_passed' });
      await note(db, job.book_id, 'A paragraph needs your decision: the team could not clear every serious issue in two revisions.');
      return { decision: 'escalated', score: o.overall_score };
    }
    await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'qc_passed' });
    await db.from('editorial_issues').update({ status: 'deferred' }).eq('block_version_id', block_version_id).eq('status', 'open');
    await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'extract_facts', p_role: 'continuity_manager',
      p_priority: 70, p_payload: { block_id, block_version_id } });
    return { decision: 'pass', score: o.overall_score };
  }

  if (key === 'paragraph/extract_facts') {
    const { block_version_id } = job.payload;
    const { data: v } = await db.from('block_versions').select('text').eq('id', block_version_id).single();
    const r = await generate(db, { ...base, system: R.facts.system, jsonSchema: R.facts.schema, temperature: 0,
      prompt: `PARAGRAPH:\n"""${v!.text}"""` });
    const o = parse(r.text);
    if (o.facts?.length) await db.from('canon_facts').insert(o.facts.map((f: any) => ({ book_id: job.book_id,
      statement: f.statement, source_block_version_id: block_version_id, status: 'proposed' })));
    return { facts: o.facts?.length ?? 0 };
  }

  throw new PolicyError(`No handler for ${key} yet.`);
}

// ------------------------------------------------------------------ admin actions
async function checkKeys(db: SupabaseClient) {
  const { data: keys } = await db.from('ai_keys').select('id, label, key_last4, status').order('label');
  const out = [];
  for (const k of keys ?? []) {
    const { data: secret } = await db.schema('app').rpc('get_key_secret', { p_key_id: k.id });
    if (!secret) { out.push({ label: k.label, ok: false, note: 'inactive' }); continue; }
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': String(secret) } });
    const j = await res.json().catch(() => ({}));
    const models = (j.models ?? []).map((m: any) => String(m.name).replace('models/', ''));
    const note = res.ok ? `valid · checked ${new Date().toISOString().slice(0, 16)}Z` : `invalid: ${j?.error?.message ?? res.status}`;
    await db.from('ai_keys').update({ notes: note }).eq('id', k.id);
    out.push({ label: k.label, last4: k.key_last4, ok: res.ok, http: res.status, models: res.ok ? models : undefined, error: res.ok ? undefined : j?.error?.message });
  }
  return { keys: out };
}

async function addKey(db: SupabaseClient, body: any) {
  const secret = String(body.secret ?? '').trim();
  if (!/^AQ\.[A-Za-z0-9_\-]{20,}$/.test(secret)) return { error: 'That is not a Gemini auth key (they start with "AQ.")' };
  const { count } = await db.from('ai_keys').select('id', { count: 'exact', head: true });
  const label = `K${String((count ?? 0) + 1).padStart(2, '0')}`;
  const { error } = await db.schema('app').rpc('admin_add_ai_key', { p_label: label, p_secret: secret, p_team_code: body.team || null, p_notes: null });
  if (error) return { error: error.message };
  return { label, last4: secret.slice(-4), team: body.team || null };
}
