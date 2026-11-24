# Document 4 upgrade: what changed and how to operate it

Status as of 24 Nov 2026. Worker v23, web 2026-11-24.04, migrations 0029–0034 plus `pin_search_path`, `hot_path_indexes`, `retire_facts_from_superseded_versions`.

## Statuses

| Paragraph status | Meaning |
| --- | --- |
| `qc_passed` | Passed the team's review; nobody has approved it yet |
| `ai_approved` | Approved by autopilot (AI). Still needs the author |
| `author_approved` | Approved by the author. AI cannot change it without an approval token; the reader audit only flags it |

History: 22 paragraphs approved only by autopilot were reclassified from `author_approved` to `ai_approved`. No approval record was deleted.

## Per-book controls

| Field / function | Purpose |
| --- | --- |
| `books.direction_contract` (jsonb) | Author-approved creative decisions. Injected into every writing, review, audit and planning prompt |
| `books.run_state`, `app.set_book_state()` | running / paused / cancelled |
| `books.priority`, `app.set_book_priority()` | urgent / high / normal / low (with ageing) |
| `books.chapter_gate` | Stop before each new chapter until the author approves the previous one |
| `app.approve_chapter(chapter)` | Author approves every paragraph in a chapter and resumes the book |
| `books.autopilot_threshold` | AI-approval bar on the 100-point scoring sheet (recovery copies: 90) |
| `books.branch_of`, `app.create_recovery_copy()` | Recovery copies; the original is never modified |

## Quality system

- Genre reader rules and 100-point scoring sheets: `roles.ts` `genreReaderRules()` / `genreRubric()`. Comedy, novel (psychological, mystery, literary, romance) and non-fiction sheets; critical failures force a revision whatever the score.
- Repetition register: `app.repetition_register(book)`; over-used words in the last 12 paragraphs, question-ending ratio, recent openings.
- Clean memory: `app.book_facts(book)` serves Bible facts plus facts from current text only; facts from superseded versions are retired automatically.
- Scores: `app.quality_scores(book)` (per chapter and book: scoring-sheet score, reader feeling, pull).
- Cut-off guard: writer replies without final punctuation, ending on a dangling word, or under 25 words are not saved.
- Version cap: 12 versions per paragraph, then the best version is kept and flagged for the author.

## AI resources and cost

- Error classes: `app.error_class(status, http, error)`.
- Circuit breaker: trigger on `agent_runs`; 5 consecutive busy/timeout/bad-output failures in 10 minutes rest that model for 10 minutes.
- Per-request limits for free tiers: `app.settings.backup_models.max_request_tokens` (learnt from 413 errors).
- Pricing catalogue: `public.model_pricing` (sources, effective dates). `app.price_of(model, at)`.
- KPIs: `app.cost_kpis(book or null)`: actual spend, paid-price equivalent, cost per 1,000 approved words, tokens per approved word, call success %, versions per approved paragraph, approved words per day, errors by class.
- Real spend cap: `app.cost_today_usd()` counts paid-tier projects only.
- Budget alert thresholds: `app.settings.budgets`.
- Model scorecard: `app.model_scorecard(days)`.

## Web

- `/dashboard`: all books, controls, KPIs, model table.
- Book page: paused banner, Resume, "Approve chapter and continue", chapter quality scores, AI-approved vs author-approved labels.

## Tests

- Database invariants (always rolled back): `supabase/tests/upgrade_invariants.sql`, 13 checks. Last run 24 Nov 2026: all pass.
- Worker logic: `npx esbuild supabase/functions/worker/roles.ts --format=esm --outfile=/tmp/roles.mjs && node supabase/functions/worker/logic.test.mjs`, 9 checks. Last run: all pass.

## Not done / needs the author

- Google OAuth project discovery (Phase 8) needs the author's Google Cloud OAuth client. Extra projects only with billing; free-project pooling stays excluded.
- Supabase Auth "leaked password protection" is a dashboard toggle (Authentication settings); it cannot be set from SQL.
- Recovery reports for both books are written after each copy reaches the chapter-1 gate.
