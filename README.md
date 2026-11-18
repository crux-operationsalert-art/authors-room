# Author's Room — P0 Platform

Phase P0 of the build plan in the *AI Author's Room — Phase 1 Blueprint* doc:
database core, job queue, AI Request Manager with team-based Gemini keys, and the
Keys & Teams dashboard.

```
supabase/migrations/   0001 core manuscript + approvals + audit · 0002 AI ops · 0003 pgvector
supabase/tests/        SQL integrity tests (17 checks)
local/test.sh          runs migrations + tests on a throwaway Postgres 16
worker/                Node worker: AI Request Manager, rate limiter, queue loop, key loader
web/                   Next.js app: sign-in and /keys dashboard, /api/keys (server-side)
```

## What is guaranteed (and tested)

| Rule | Where | Test |
| --- | --- | --- |
| Manuscript versions are append-only | trigger on `block_versions` | 001 T2 |
| Text changes only through `app.commit_block_version` | pointer guard trigger | 001 T3 |
| Approved text never changes without the author's approval of that exact text | `commit_block_version` | 001 T4–T5 |
| Only the book's author can approve or roll back | `approve_block`, `rollback_block` | 001 T6, T10 |
| One book's data is invisible to other accounts | RLS | 001 T7–T8 |
| Every change is in the audit log | `app.audit` trigger | 001 T9 |
| One active Gemini project (quota is per project) | unique index | 002 T1 |
| Key secrets live only in Supabase Vault; the app stores last 4 + fingerprint | `admin_add_ai_key` | 002 T2–T3 |
| Each team uses its own key; a revoked key falls back to another active key | `resolve_key_for_team` | 002 T4 |
| HTTP 429 makes the job wait; it never retries on another key | `AIRequestManager` | worker tests |
| One project-wide limiter for all teams and keys | `ProjectRateLimiter` | worker tests |
| Confidential books never run on a free-tier project | `AIRequestManager` | worker tests |
| Daily cost cap stops calls | `AIRequestManager` | worker tests |

## Set-up (about 20 minutes)

1. **Supabase project.** Create one (or tell Claude which existing project to use). Then run
   the migrations in order in the SQL editor, or `supabase db push`.
2. **Expose the `app` schema.** Dashboard → Project Settings → API → *Exposed schemas*: add `app`.
   Function grants still restrict who can call what.
3. **Author account.** Supabase → Authentication → add your user (email). Then in the SQL editor:
   `insert into authors(auth_user_id, display_name) values ('<your auth user id>', 'Your Name');`
4. **Model registry and limits.** Insert one enabled model per tier (`fast`, `standard`, `deep`,
   `embedding`) with current prices, and copy your project's limits from AI Studio's rate-limit
   page into `project_model_limits`. Model ids and prices live only here, never in code.
5. **Keys.** From `worker/`, with `.env` filled in:
   `npm run load-keys` → paste your keys, one per line → Ctrl-D.
   They are assigned in order: Orchestration, Ideation, Writing, Editorial, Readers, Assurance,
   Publishing, Retrieval; the rest are standby. Load only keys from the app's one Gemini project.
6. **Run.** `cd worker && npm start` (worker) and `cd web && npm run dev` (app at `/keys`).
7. **Smoke test.** `insert into agent_jobs(workflow, step, role_code, payload)
   values ('smoke_test','ping','chief_editor','{"prompt":"Say OK."}');` — the dashboard should show
   one request on the Orchestration key.

## Local tests

```
./local/test.sh                       # as a non-root user; needs Postgres 16
cd worker && npm test && npm run typecheck
cd web && npx next build
```

## Security notes

- Never commit `.env`. Gemini keys are never in `.env`, code, logs or the browser.
- Keys pasted into a chat should be treated as exposed: after the app is running, create
  fresh keys in AI Studio, add them on `/keys`, and revoke the old ones there and in AI Studio.
- MFA for the author account is part of E0.3 (next step).
