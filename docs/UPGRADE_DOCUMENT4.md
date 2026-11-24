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

## AI resources and cost (Parts H and I)

Resource manager (migration 0036):
- `ai_accounts` (masked email only), `ai_projects` (provider, number, billing, API enabled, `routing_eligible` and reason), `ai_keys` (alias, ownership `manual` or `verified_oauth`, project confirmed, last verified, models available).
- Only the primary project, or a billing-enabled project the author explicitly authorises, can be `routing_eligible`. Extra free projects are listed but never used for quota (`admin_set_project_eligibility` refuses them; Google's terms forbid circumventing limits).
- Keys in the same project share one quota. Quota is tracked per project and model, never per key, and keys are never switched on a 429.
- `quota_limits` holds RPM, TPM and RPD per project and model, learnt from "limit: N" in 429 replies; `quota_events` logs each one. `app.quota_pools()` reports the current position.
- `app.fail_job` retries with exponential backoff and jitter. Quota waits do not use up an attempt.

Google OAuth (Edge Function `google`, migration 0037):
- The client secret and refresh tokens are stored in Vault only. Scopes: openid, email, cloud-platform.
- Discovery: projects, whether the Gemini API is enabled, billing status, and the API keys in each project. Each stored key is looked up so its true project is recorded.
- Provisioning (create project, enable API, create a restricted key) runs only after an explicit confirmation. It refuses a second key in the same project and refuses a new project unless the author ticks that billing will be enabled. Every action is written to `provisioning_log`.

Models and errors (0039, 0040):
- `model_catalog` plus dated price rows from the OpenRouter and Groq model APIs; refreshed daily at 09:17 UTC.
- Every key is checked daily at 09:23 UTC.
- `app.error_class` separates per-minute requests, per-minute tokens, daily quota, invalid credentials, permission, not available, provider busy, timeout, network, too large and bad output.
- Circuit breaker on `agent_runs`.

Cost, budgets and KPIs (0034, 0038):
- `agent_runs` records reasoning and cached tokens. `model_pricing` has cached-input and batch rates, a source URL and effective dates.
- Paid use is OFF (`app.settings.paid_use_enabled`); global daily and monthly budgets are $0 and hard. `app.paid_call_blocked` is checked before any paid-project call.
- `app.kpis(book)` gives the five management KPIs: cost per book (actual, paid-equivalent, hybrid, projected), completion time, processing speed, reliability and quality/rework. Projections are labelled as projections.

Routing (0041) and scheduling (0042):
- A team whose assigned key is in a non-eligible project falls back to an eligible key instead of stalling.
- Priority ageing adds 1 point per 6 minutes (up to 120), so a low-priority book is never starved.
- A paused book is never claimed. A step whose worker died is re-queued after 4 minutes.

## Web

- `/dashboard`: workload now (running, queued, waiting for capacity, bottleneck); the five KPIs; paid use and budgets; per-book pause, resume, cancel, and restart from the last checkpoint; model table.
- `/resources`: Google account setup steps and connection; projects with eligibility; enable API and create key (with confirmation); key inventory (ownership, duplicates, manual link); quota pools and events; provisioning log.
- Book page: paused banner, chapter approval, quality scores, AI-approved vs author-approved labels.

## Tests (last run 24 Nov 2026)

| Suite | File | Result |
|---|---|---|
| Database invariants | `supabase/tests/upgrade_invariants.sql` | 13/13 pass |
| Part N §40 resource scenarios | `supabase/tests/resource_scenarios.sql` | 19/19 pass (S02b failed first; fixed by 0041) |
| Part N §40 scheduling | `supabase/tests/scheduling_scenarios.sql` | 4/4 pass (S11c failed first; fixed by 0042) |
| Worker logic | `supabase/functions/worker/logic.test.mjs` | 9/9 pass |
| S4/S5 all Gemini down, OpenRouter takes over | production history | after Gemini 429s, Groq completed 77 jobs and OpenRouter 12 |

All SQL suites end in a RAISE, so they always roll back.

## Honest status against Document 4

| Part | Status | Gap |
|---|---|---|
| H §20–22 resource manager, hierarchy, key discovery | Done | Each key's project is only confirmed once the author connects Google (needs the OAuth client). |
| H §23 OAuth and provisioning | Built and smoke-tested (callback, sign-in guard) | Not exercised end to end: needs the author's OAuth client ID and secret. |
| H §24 routing | Partial | Uses tier chains, quota gate, circuit breaker and priority. It does not weight by latency or success rate. Routing across several eligible Gemini projects is not built: the worker and quota gate use the single active project. This only matters once a paid project is authorised. |
| H §25 errors and recovery | Done | — |
| H §26 OpenRouter and others | Done | Discovery and prices for OpenRouter and Groq. Mistral has no key, so it is skipped. |
| I §27–31 cost, pricing, KPIs, paid protection | Done | Projections assume the recent pace continues. |
| J §32–34 control, priority, dashboard | Done | — |
| K re-audit | Partial | Database, security and resource audits done. A full UI/UX walkthrough of every screen is not done. |
| L data and security | Done | Leaked-password protection is a dashboard-only toggle. |
| M performance benchmark | Not done | No controlled before/after benchmark yet. |
| N §40 resource tests | Done (above) | — |
| N §41–42 writing and book tests | Partial | Covered by invariants and live recovery copies. A full test of all 18 writing scenarios waits for chapter 1 of each copy. |

## Needs the author

- Create a Google OAuth client and paste its ID and secret on the Resources page, then Connect and Discover (steps are on the page).
- Supabase Auth leaked-password protection: Authentication settings in the Supabase dashboard.
- Recovery reports for both books are written after each copy reaches the chapter-1 gate.
