-- 0033: repetition register (Document 4, Part F) and chapter/book quality scores (Part C).

-- Words and endings over-used in the most recent paragraphs of a book, as a short instruction for writers and reviewers.
create or replace function app.repetition_register(p_book uuid, p_window int default 12)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare v_words text; v_q int; v_n int; v_open text;
begin
  with recent as (
    select m.id, v.text from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key desc limit p_window),
  toks as (
    select distinct r.id, w from recent r, regexp_split_to_table(lower(r.text), '[^a-zà-ɏ'']+') w
     where length(w) >= 5 and w not in ('about','after','again','against','always','around','because','before','being','below',
       'between','could','didn''t','doesn''t','every','first','their','there','these','those','thing','things','think','thought',
       'through','under','until','where','which','while','would','should','still','never','little','maybe','might','other',
       'people','really','something','nothing','someone','everyone','yourself','himself','herself','itself','without','though',
       'another','enough','whole','might','shall','can''t','won''t','you''re','you''ll','you''ve','that''s','there''s','what''s',
       'isn''t','wasn''t','aren''t','don''t','into','just','like','your','with','have','from','this','that','they','them','then',
       'when','what','were','will','been','more','some','only','even','over','also','much','very','such','each','same'))
  select string_agg(format('%s (%s of last %s)', w, n, p_window), ', ' order by n desc, w) into v_words
    from (select w, count(*) n from toks group by w having count(*) >= 3 order by count(*) desc, w limit 15) x;
  select count(*) filter (where trim(text) ~ '\?["”’]?$'), count(*) into v_q, v_n from (
    select v.text from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key desc limit 8) e;
  select string_agg(s, ' / ') into v_open from (
    select split_part(trim(v.text), ' ', 1) || ' ' || split_part(trim(v.text), ' ', 2) s
      from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key desc limit 6) o;
  if v_n = 0 then return ''; end if;
  return 'REPETITION REGISTER (from the latest paragraphs; avoid repeating these, vary them if they are required terms):' || E'\n' ||
    coalesce('- Words used in many recent paragraphs: ' || v_words || E'\n', '') ||
    format('- Paragraph endings: %s of the last %s ended on a question%s', v_q, v_n,
           case when v_q * 4 > v_n then '; do NOT end this one on a question' else '' end) || E'\n' ||
    coalesce('- Recent paragraph openings (do not start the same way): ' || v_open || E'\n', '') || E'\n';
end $$;

-- Chapter and book scores from the Chief Editor's score and the simulated reader, for the CURRENT text only.
create or replace function app.quality_scores(p_book uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb;
begin
  if not (auth.uid() is null or app.owns_book(p_book)) then raise exception 'not your book' using errcode = '42501'; end if;
  with para as (
    select m.id, coalesce(o.parent_id, o.id) as chapter_id, m.status,
           (select (j.result->>'score')::int from public.agent_jobs j where j.step = 'consolidate' and j.status = 'done'
              and j.payload->>'block_version_id' = m.current_version_id::text order by j.updated_at desc limit 1) as score,
           (select e.match from public.reader_emotions e where e.block_version_id = m.current_version_id order by e.source = 'audit' desc limit 1) as feel,
           (select e.pull from public.reader_emotions e where e.block_version_id = m.current_version_id order by e.source = 'audit' desc limit 1) as pull
      from public.manuscript_blocks m left join public.outline_units o on o.id = m.unit_id
     where m.book_id = p_book and m.status in ('qc_passed', 'ai_approved', 'author_approved')),
  ch as (
    select chapter_id, count(*) paras, round(avg(score)) score, round(avg(feel)) feel, round(avg(pull)) pull,
           count(*) filter (where status = 'author_approved') author_ok
      from para group by chapter_id)
  select jsonb_build_object(
    'chapters', coalesce(jsonb_object_agg(chapter_id, jsonb_build_object('paragraphs', paras, 'score', score, 'feel', feel, 'pull', pull,
                  'author_approved', author_ok)) filter (where chapter_id is not null), '{}'),
    'book', jsonb_build_object('score', (select round(avg(score)) from para), 'feel', (select round(avg(feel)) from para),
                               'pull', (select round(avg(pull)) from para), 'paragraphs', (select count(*) from para)))
    into r from ch;
  return r;
end $$;
revoke all on function app.repetition_register(uuid, int) from public, anon;
grant execute on function app.repetition_register(uuid, int) to service_role, authenticated;
revoke all on function app.quality_scores(uuid) from public, anon;
grant execute on function app.quality_scores(uuid) to service_role, authenticated;
