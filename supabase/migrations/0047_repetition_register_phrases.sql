-- 0047 (24 Nov, quality): the repetition register now reads the WHOLE manuscript (not the latest 12 paragraphs) and
-- reports repeated PHRASES (3-word runs shared by two or more paragraphs, with paragraph numbers) and sentence
-- openings used again and again, not just single words. The audit of 24 Nov found the same gags, images and
-- explanations repeated across 4-7 paragraphs, which the old single-word register could not see.
create or replace function app.repetition_register(p_book uuid, p_window integer default 80)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_phr text; v_open text; v_q int; v_n int; v_last text;
begin
  with paras as (
    select row_number() over (order by m.order_key) n, v.text
      from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key limit p_window),
  words as (
    select p.n, w.ord, w.w from paras p,
           regexp_split_to_table(lower(p.text), '[^a-zà-ɏ'']+') with ordinality as w(w, ord) where w.w <> ''),
  tri as (
    select n, w, lead(w, 1) over (partition by n order by ord) w2, lead(w, 2) over (partition by n order by ord) w3 from words),
  phr as (
    select distinct n, w || ' ' || w2 || ' ' || w3 t from tri
     where w3 is not null
       and (length(w) >= 4)::int + (length(w2) >= 4)::int + (length(w3) >= 4)::int >= 2
       and w not in ('the','and','that','with','this','from','into','your','you','his','her','their','was','were','had','have')
       and w3 not in ('the','and','that','with','this','from','into','your','you','his','her','their','was','were','had','have','a','an','of','to','in')),
  rep as (select t, count(*) c, string_agg('¶' || n, ',' order by n) where_ from phr group by t having count(*) >= 2)
  select string_agg(format('"%s" (%s)', t, where_), '; ' order by c desc, t) into v_phr
    from (select * from rep order by c desc, t limit 25) x;

  with paras as (
    select v.text from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key limit p_window),
  sents as (select trim(s) s from paras, regexp_split_to_table(paras.text, '[.!?]["”’*]?\s+') s where length(trim(s)) > 0),
  op as (select lower(split_part(s, ' ', 1) || ' ' || split_part(s, ' ', 2)) o from sents)
  select string_agg(format('"%s…" (%s times)', o, c), '; ' order by c desc) into v_open
    from (select o, count(*) c from op group by o having count(*) >= 3 order by count(*) desc limit 10) y;

  select count(*) filter (where trim(text) ~ '\?["”’*]?$'), count(*) into v_q, v_n from (
    select v.text from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key desc limit 8) e;
  select string_agg(s, ' / ') into v_last from (
    select split_part(trim(v.text), ' ', 1) || ' ' || split_part(trim(v.text), ' ', 2) s
      from public.manuscript_blocks m join public.block_versions v on v.id = m.current_version_id
     where m.book_id = p_book and m.status <> 'cut' order by m.order_key desc limit 6) o;
  if v_n = 0 then return ''; end if;
  return 'REPETITION REGISTER (whole manuscript so far; ¶ = paragraph number). Never reuse a phrase, gag, image, explanation or '
      || 'sentence pattern already used in another paragraph; vary required terms instead of repeating their wording:' || E'\n' ||
    coalesce('- Phrases already in more than one paragraph: ' || v_phr || E'\n', '') ||
    coalesce('- Sentence openings used again and again (avoid): ' || v_open || E'\n', '') ||
    format('- Paragraph endings: %s of the last %s ended on a question%s', v_q, v_n,
           case when v_q * 4 > v_n then '; do NOT end this one on a question' else '' end) || E'\n' ||
    coalesce('- Recent paragraph openings (do not start the same way): ' || v_last || E'\n', '') || E'\n';
end $$;
