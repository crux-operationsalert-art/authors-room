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
  // Non-stop: let autopilot act on what just finished, then start the next step at once if work is ready.
  if (done.length) {
    await app.rpc('autopilot_tick_safe');
    await app.rpc('kick_worker');
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

// The paragraphs around one paragraph, by position in the book (not "the latest ones").
async function neighbours(db: SupabaseClient, bookId: string, blockId: string) {
  const { data } = await db.from('manuscript_blocks')
    .select('id, order_key, block_versions!manuscript_blocks_current_fk(text)')
    .eq('book_id', bookId).neq('status', 'cut').order('order_key');
  const all = (data ?? []) as any[];
  const i = all.findIndex(b => b.id === blockId);
  const txt = (b: any) => b.block_versions?.text ?? '';
  const before = all.slice(0, i < 0 ? all.length : i).map(txt).filter(Boolean);
  const after = i < 0 ? [] : all.slice(i + 1).map(txt).filter(Boolean).slice(0, 1);
  return { before, after, number: i + 1 };
}
function aroundText(n: { before: string[]; after: string[] }, label = 'PARAGRAPHS BEFORE THIS ONE') {
  return `${label} (${n.before.length}, last 8 shown):\n${n.before.slice(-8).join('\n\n') || '(none: this opens the book)'}\n\n` +
    (n.after.length ? `THE PARAGRAPH THAT FOLLOWS (this one must lead into it naturally):\n${n.after[0]}\n\n` : '');
}
// The author's open notes: whole-book directions plus notes on this paragraph.
async function directions(db: SupabaseClient, bookId: string, blockId?: string) {
  const { data } = await db.from('author_notes').select('scope, note, block_id').eq('book_id', bookId).eq('status', 'open').order('created_at');
  const list = (data ?? []).filter((n: any) => n.scope === 'book' || (blockId && n.block_id === blockId));
  return list.length ? `AUTHOR'S DIRECTIONS (highest priority; must be followed):\n${list.map((n: any) =>
    `- ${n.scope === 'book' ? '(whole book) ' : '(this paragraph) '}${n.note}`).join('\n')}\n\n` : '';
}

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

  if (key === 'outline/plan') {
    const ctx = await bookContext(db, job.book_id);
    const prev = await manuscriptSoFar(db, job.book_id);
    const r = await generate(db, { ...base, system: R.outline.system, jsonSchema: R.outline.schema, maxOutputTokens: 8000,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nBRIEF:\n${JSON.stringify(ctx.cons!.brief, null, 1)}\n\n` +
              `BOOK BIBLE:\n${ctx.ents.map((e: any) => `- ${e.type} ${e.name}: ${e.profile?.summary ?? ''}`).join('\n')}\n\n` +
              `ALREADY WRITTEN (${prev.length} paragraphs):\n${prev.slice(0, 6).join('\n\n') || '(nothing yet)'}` });
    const o = parse(r.text);
    const chs = (o.chapters ?? []).filter((c: any) => c?.title);
    if (!chs.length) throw new Error('The chapter plan came back empty.');
    const { data: existing } = await db.from('outline_units').select('id').eq('book_id', job.book_id).eq('level', 'chapter').order('order_key');
    let total = 0;
    for (let i = 0; i < chs.length; i++) {
      const c = chs[i];
      const row = { title: String(c.title), purpose: c.purpose ?? null, beats: (c.beats ?? []).map(String),
                    target_words: Math.max(400, Math.round(Number(c.target_words) || 3000)) };
      total += row.target_words;
      if (i === 0 && existing?.[0]) await db.from('outline_units').update(row).eq('id', existing[0].id);
      else await db.from('outline_units').insert({ book_id: job.book_id, level: 'chapter', status: 'planned',
                                                    order_key: `a${String(i).padStart(2, '0')}`, ...row });
    }
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant',
      content: `${o.message}\n\nChapter plan (${chs.length} chapters, about ${total.toLocaleString('en-IN')} words):\n` +
               chs.map((c: any, i: number) => `${i + 1}. ${c.title} (~${Math.round(Number(c.target_words) || 0).toLocaleString('en-IN')} words)`).join('\n') });
    return { chapters: chs.length, words: total };
  }

  if (key === 'feedback/plan') {
    const { note_id, block_id } = job.payload;
    const { data: note } = await db.from('author_notes').select('*').eq('id', note_id).single();
    if (!note) return { skipped: 'note removed' };
    const { data: rows } = await db.from('manuscript_blocks').select('id, order_key, block_versions!manuscript_blocks_current_fk(text)')
      .eq('book_id', job.book_id).neq('status', 'cut').order('order_key');
    const all = ((rows ?? []) as any[]).filter(b => b.block_versions?.text);
    const idx = all.findIndex(b => b.id === block_id);
    if (idx < 0) return { skipped: 'paragraph has no text yet' };
    const lo = Math.max(0, idx - 4), hi = Math.min(all.length, idx + 3);
    const ctx = await bookContext(db, job.book_id);
    const r = await generate(db, { ...base, system: R.feedbackPlan.system, jsonSchema: R.feedbackPlan.schema, temperature: 0.3,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nAUTHOR'S NOTE ON PARAGRAPH ${idx + 1}:\n"${note.note}"\n\n` +
              `PARAGRAPHS ${lo + 1} TO ${hi}:\n${all.slice(lo, hi).map((b, k) => `[${lo + k + 1}] ${b.block_versions.text}`).join('\n\n')}` });
    const o = parse(r.text);
    const changes: { paragraph: number; instruction: string }[] = (o.changes ?? [])
      .filter((c: any) => Number.isInteger(c.paragraph) && c.paragraph >= lo + 1 && c.paragraph <= hi && c.instruction)
      .slice(0, 4);
    if (!changes.some(c => c.paragraph === idx + 1)) changes.push({ paragraph: idx + 1, instruction: note.note });
    changes.sort((a, b) => a.paragraph - b.paragraph);
    for (const [k, c] of changes.entries()) {
      const blk = all[c.paragraph - 1];
      if (blk.id !== block_id) await db.from('author_notes').insert({ book_id: job.book_id, block_id: blk.id, scope: 'paragraph',
        note: `(from your note on paragraph ${idx + 1}) ${c.instruction}` });
      const { error: reErr } = await app.rpc('reopen_for_feedback', { p_block: blk.id, p_note: note_id, p_priority: 93 - k,
        p_instruction: `Author's note on paragraph ${idx + 1}: "${note.note}"\nWhat THIS paragraph (${c.paragraph}) must achieve: ${c.instruction}` });
      if (reErr) throw new Error(`Could not reopen paragraph ${c.paragraph}: ${reErr.message}`);
      // one at a time, in reading order, so each revision sees its neighbour's new text
      if (k > 0) await db.from('agent_jobs').update({ run_after: new Date(Date.now() + k * 180_000).toISOString() })
        .eq('step', 'revise').eq('status', 'queued').eq('payload->>block_id', blk.id);
    }
    const standing = String(o.standing_direction ?? '').trim();
    if (standing) await db.from('author_notes').insert({ book_id: job.book_id, scope: 'book',
      note: `${standing} (from your note on paragraph ${idx + 1})` });
    await db.from('author_notes').update({ plan: { changes, standing_direction: standing || null } }).eq('id', note_id);
    await db.from('intake_messages').insert({ book_id: job.book_id, role: 'assistant',
      content: `${o.message}\n` + changes.map(c => `• Paragraph ${c.paragraph}: ${c.instruction}`).join('\n') +
               (standing ? `\nFrom now on, for the whole book: ${standing}` : '') +
               `\nAfter that, the team carries on from where it left off.` });
    return { changes: changes.length, paragraphs: changes.map(c => c.paragraph), standing: !!standing };
  }

  if (key === 'paragraph/draft' || key === 'paragraph/revise') {
    const blockId = job.payload.block_id, loop = Number(job.payload.loop ?? 0);
    const ctx = await bookContext(db, job.book_id);
    const around = await neighbours(db, job.book_id, blockId);
    const prev = around.before;
    const authorDirs = await directions(db, job.book_id, blockId);
    const { data: blk } = await db.from('manuscript_blocks').select('id, unit_id, current_version_id, block_versions!manuscript_blocks_current_fk(text)').eq('id', blockId).single();
    let current = (blk as any)?.block_versions?.text;
    if (job.payload.base_version_id) {   // autopilot revises from the best-scoring version so far
      const { data: bv } = await db.from('block_versions').select('text').eq('id', job.payload.base_version_id).maybeSingle();
      if (bv?.text) current = bv.text;
    }
    // chapter context: which chapter this paragraph belongs to, its plan and how far along it is
    let chapterText = '';
    if ((blk as any)?.unit_id) {
      const { data: chId } = await app.rpc('chapter_of', { p_unit: (blk as any).unit_id });
      const { data: chs } = await db.from('outline_units').select('id, title, purpose, beats, target_words').eq('book_id', job.book_id).eq('level', 'chapter').order('order_key');
      const idx = (chs ?? []).findIndex((c: any) => c.id === chId);
      if (idx >= 0) {
        const ch = (chs as any[])[idx];
        const { data: sofar } = await app.rpc('chapter_words', { p_chapter: ch.id, p_approved_only: true });
        const words = Number(sofar ?? 0), target = Number(ch.target_words ?? 0);
        chapterText = `CHAPTER PLAN:\n${(chs as any[]).map((c, i) => `${i + 1}. ${c.title}${i === idx ? '   <== CURRENT' : ''}`).join('\n')}\n\n` +
          `CURRENT CHAPTER ${idx + 1}: ${ch.title}\nPurpose: ${ch.purpose ?? ''}\nBeats: ${(ch.beats ?? []).join(' | ')}\n` +
          (target ? `Written so far in this chapter: ${words} of about ${target} words.\n` : '') +
          (words === 0 ? `This paragraph OPENS chapter ${idx + 1}.\n` : '') +
          (target && target - words < 200 ? 'This is the last paragraph of the chapter: bring it to a satisfying close.\n' : '') + '\n';
      }
    }
    let task = prev.length ? 'Write the next paragraph.' : 'Write the opening paragraph of the book.';
    if (job.payload.guidance) task += `\nAuthor's guidance: ${job.payload.guidance}`;
    if (key === 'paragraph/revise') task = `Revise this paragraph:\n"""${current}"""\n\nInstructions: ${job.payload.instructions ?? ''}${job.payload.author_note ? `\nAuthor's note (highest priority): ${job.payload.author_note}` : ''}\nKeep what works. Output only the revised paragraph.`;
    const r = await generate(db, { ...base, system: R.writer.system, maxOutputTokens: 1200, temperature: 0.9,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nVOICE PROFILE:\n${JSON.stringify(ctx.voice?.traits ?? {})}\nAvoid: ${(ctx.voice?.banned_phrases ?? []).join('; ')}\n\n` +
              `BOOK BIBLE:\n${ctx.ents.map((e: any) => `- ${e.type} ${e.name}: ${e.profile?.summary ?? ''}`).join('\n')}\n\n` +
              `CANON FACTS:\n${ctx.facts.map((f: any) => `- ${f.statement}`).join('\n')}\n\n` +
              chapterText + authorDirs + aroundText(around) + `TASK:\n${task}` });
    const text = r.text.trim().replace(/^["“]|["”]$/g, '');
    const { data: vid, error } = await app.rpc('commit_block_version', { p_block_id: blockId, p_text: text,
      p_reason: key === 'paragraph/draft' ? 'first draft' : `revision ${loop}`, p_actor_type: 'agent',
      p_provenance: key === 'paragraph/draft' ? 'ai_generated' : 'ai_edited' });
    if (error) throw new Error(error.message);
    await app.rpc('set_block_status', { p_block_id: blockId, p_status: 'in_review' });
    const { data: mode } = await app.from('settings').select('value').eq('key', 'review_mode').maybeSingle();
    if ((mode as any)?.value === 'panel') {
      // one combined call for the five reviewers (saves 4 requests per version)
      await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'review_panel', p_role: 'continuity_manager',
        p_priority: 88, p_payload: { block_id: blockId, block_version_id: vid, loop } });
    } else {
      for (const roleCode of Object.keys(R.LAYER1)) {
        await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'review', p_role: roleCode,
          p_priority: 88, p_payload: { block_id: blockId, block_version_id: vid, loop } });
      }
    }
    return { block_version_id: vid, chars: text.length };
  }

  if (key === 'paragraph/review') {
    const { block_id, block_version_id, loop } = job.payload;
    const meta = R.LAYER1[job.role_code];
    const { data: cur } = await db.from('manuscript_blocks').select('current_version_id, status').eq('id', block_id).single();
    if (cur?.current_version_id !== block_version_id || cur?.status === 'author_approved') return { skipped: 'stale version' };
    const ctx = await bookContext(db, job.book_id);
    const around = await neighbours(db, job.book_id, block_id);
    const authorDirs = await directions(db, job.book_id, block_id);
    const { data: v } = await db.from('block_versions').select('text').eq('id', block_version_id).single();
    const spec = R.reviewer(meta.name, meta.focus);
    const r = await generate(db, { ...base, system: spec.system, jsonSchema: spec.schema, temperature: 0.2,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nVOICE PROFILE:\n${JSON.stringify(ctx.voice?.traits ?? {})}\n\n` +
              `CANON FACTS:\n${ctx.facts.map((f: any) => `- ${f.statement}`).join('\n')}\n\n` + authorDirs +
              aroundText(around, 'EARLIER PARAGRAPHS') + `PARAGRAPH TO REVIEW (number ${around.number}):\n"""${v!.text}"""` });
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

  if (key === 'paragraph/review_panel') {
    const { block_id, block_version_id, loop } = job.payload;
    const { data: cur } = await db.from('manuscript_blocks').select('current_version_id, status').eq('id', block_id).single();
    if (cur?.current_version_id !== block_version_id || cur?.status === 'author_approved') return { skipped: 'stale version' };
    const ctx = await bookContext(db, job.book_id);
    const around = await neighbours(db, job.book_id, block_id);
    const authorDirs = await directions(db, job.book_id, block_id);
    const { data: v } = await db.from('block_versions').select('text').eq('id', block_version_id).single();
    const r = await generate(db, { ...base, system: R.panel.system, jsonSchema: R.panel.schema, temperature: 0.2,
      prompt: `CONSTITUTION:\n${constitutionText(ctx.cons)}\n\nVOICE PROFILE:\n${JSON.stringify(ctx.voice?.traits ?? {})}\n\n` +
              `CANON FACTS:\n${ctx.facts.map((f: any) => `- ${f.statement}`).join('\n')}\n\n` + authorDirs +
              aroundText(around, 'EARLIER PARAGRAPHS') + `PARAGRAPH TO REVIEW (number ${around.number}):\n"""${v!.text}"""` });
    const o = parse(r.text);
    const byRole = new Map<string, any>((o.reviews ?? []).map((x: any) => [x.role, x]));
    let total = 0, nIssues = 0;
    for (const roleCode of Object.keys(R.LAYER1)) {
      const rv = byRole.get(roleCode) ?? { score: null, summary: 'No separate assessment returned.', issues: [] };
      await db.from('review_runs').upsert({ book_id: job.book_id, block_version_id, layer: 1, role_code: roleCode,
        score: rv.score, summary: rv.summary, result: { ...rv, via: 'panel' } }, { onConflict: 'block_version_id,role_code' });
      if (rv.issues?.length) await db.from('editorial_issues').insert(rv.issues.map((i: any) => ({ book_id: job.book_id, block_id,
        block_version_id, raised_by: roleCode, severity: i.severity, category: i.category, issue: i.issue,
        evidence: i.evidence ?? null, suggested_fix: i.suggested_fix })));
      total += Number(rv.score ?? 0); nIssues += rv.issues?.length ?? 0;
    }
    await db.from('agent_jobs').insert({ book_id: job.book_id, workflow: 'paragraph', step: 'consolidate', role_code: 'chief_editor',
      priority: 89, payload: { block_id, block_version_id, loop } });
    return { score: Math.round(total / Object.keys(R.LAYER1).length), issues: nIssues, panel: true };
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
    const authorDirs = await directions(db, job.book_id, block_id);
    const { data: bk } = await db.from('books').select('autopilot, autopilot_threshold').eq('id', job.book_id).single();
    const bar = bk?.autopilot ? `THE AUTHOR'S BAR: a paragraph is approved only with an overall score above ${bk.autopilot_threshold}/100. ` +
      `Score honestly: give a score above ${bk.autopilot_threshold} only when nothing worth fixing remains. Your instructions must say exactly what would lift it over the bar.\n\n` : '';
    const r = await generate(db, { ...base, system: R.consolidate.system, jsonSchema: R.consolidate.schema, temperature: 0.2,
      prompt: bar + authorDirs + `PARAGRAPH:\n"""${v!.text}"""\n\nREVIEWS:\n${JSON.stringify(runs, null, 1)}\n\nISSUES:\n${JSON.stringify(issues, null, 1)}` });
    const o = parse(r.text);
    const blocking = (issues ?? []).some((i: any) => i.severity === 'critical' || i.severity === 'major');
    // A critical/major issue always forces revision; otherwise only a weak overall score does (minor notes are kept for the author).
    const revise = blocking || (o.decision === 'revise' && Number(o.overall_score) < 80);
    if (revise && loop < 2) {
      await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'revision_requested' });
      await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'revise', p_role: 'lead_writer',
        p_priority: 90, p_payload: { block_id, instructions: o.instructions, loop: loop + 1 } });
      await db.from('editorial_issues').update({ status: 'accepted' }).eq('block_version_id', block_version_id).in('severity', ['critical', 'major']);
      return { decision: 'revise', loop: loop + 1, score: o.overall_score, instructions: o.instructions, summary: o.summary };
    }
    if (revise) {
      // two loops used: the author decides (Brief: no silent acceptance)
      await db.from('decisions').insert({ book_id: job.book_id, type: 'consolidation', subject_ref: block_id,
        question: 'The team could not clear every serious issue in two revisions. How should we proceed?',
        options: [{ title: 'Accept this version as it is' }, { title: 'Ask for another revision with my note' }],
        recommendation: o.summary + (o.disagreements ? `\nReviewers disagreed: ${o.disagreements}` : '') });
      await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'qc_passed' });
      await note(db, job.book_id, 'A paragraph needs your decision: the team could not clear every serious issue in two revisions.');
      return { decision: 'escalated', score: o.overall_score, instructions: o.instructions, summary: o.summary };
    }
    await app.rpc('set_block_status', { p_block_id: block_id, p_status: 'qc_passed' });
    await db.from('editorial_issues').update({ status: 'deferred' }).eq('block_version_id', block_version_id).eq('status', 'open');
    await app.rpc('enqueue', { p_book: job.book_id, p_workflow: 'paragraph', p_step: 'extract_facts', p_role: 'continuity_manager',
      p_priority: 70, p_payload: { block_id, block_version_id } });
    return { decision: 'pass', score: o.overall_score, instructions: o.instructions, summary: o.summary };
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
const BACKUP_PROVIDERS = ['groq', 'mistral', 'openrouter'];
const BACKUP_URL: Record<string, string> = { groq: 'https://api.groq.com/openai/v1', mistral: 'https://api.mistral.ai/v1', openrouter: 'https://openrouter.ai/api/v1' };
async function checkKeys(db: SupabaseClient) {
  const { data: keys } = await db.from('ai_keys').select('id, label, key_last4, status, provider').order('label');
  const out = [];
  for (const k of keys ?? []) {
    const { data: secret } = await db.schema('app').rpc('get_key_secret', { p_key_id: k.id });
    if (!secret) { out.push({ label: k.label, ok: false, note: 'inactive' }); continue; }
    const gem = (k as any).provider === 'gemini';
    const res = gem
      ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': String(secret) } })
      : await fetch(`${BACKUP_URL[(k as any).provider]}/models`, { headers: { Authorization: `Bearer ${secret}` } });
    const j = await res.json().catch(() => ({}));
    const models = gem ? (j.models ?? []).map((m: any) => String(m.name).replace('models/', ''))
                       : (j.data ?? []).map((m: any) => String(m.id));
    const note = res.ok ? `valid · checked ${new Date().toISOString().slice(0, 16)}Z` : `invalid: ${j?.error?.message ?? res.status}`;
    await db.from('ai_keys').update({ notes: note }).eq('id', k.id);
    out.push({ label: k.label, provider: (k as any).provider, last4: k.key_last4, ok: res.ok, http: res.status, models: res.ok ? models : undefined, error: res.ok ? undefined : j?.error?.message });
  }
  return { keys: out };
}

async function addKey(db: SupabaseClient, body: any) {
  const secret = String(body.secret ?? '').trim();
  // Backup providers: recognised by the key's shape, or chosen on the Keys page.
  const provider = String(body.provider ?? '') || (secret.startsWith('gsk_') ? 'groq' : secret.startsWith('sk-or-') ? 'openrouter'
    : /^[A-Za-z0-9]{32}$/.test(secret) ? 'mistral' : 'gemini');
  if (provider !== 'gemini') {
    if (!BACKUP_PROVIDERS.includes(provider)) return { error: `Unknown provider "${provider}".` };
    const { data, error } = await db.schema('app').rpc('admin_add_provider_key', { p_provider: provider, p_secret: secret });
    if (error) return { error: error.message };
    const row = (data as any[])?.[0];
    return { label: row?.label, last4: row?.last4, provider };
  }
  if (!/^AQ\.[A-Za-z0-9_\-]{20,}$/.test(secret)) return { error: 'That is not a Gemini auth key (they start with "AQ.")' };
  const { count } = await db.from('ai_keys').select('id', { count: 'exact', head: true }).eq('provider', 'gemini');
  const label = `K${String((count ?? 0) + 1).padStart(2, '0')}`;
  const { error } = await db.schema('app').rpc('admin_add_ai_key', { p_label: label, p_secret: secret, p_team_code: body.team || null, p_notes: null });
  if (error) return { error: error.message };
  return { label, last4: secret.slice(-4), team: body.team || null };
}
