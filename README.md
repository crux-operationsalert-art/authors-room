# Author's Room

Your AI writer's room: describe a book idea, answer a few questions, choose a direction, approve the
book's constitution, and the team writes it paragraph by paragraph. Every paragraph is reviewed by five
independent reviewers, revised when needed, and locked once you approve it.

**Live backend (already running):** Supabase project `authors-room` (Mumbai), worker function
`worker` running every minute, 12 keys loaded (3 active — see "Keys" below).

## Run the app on your PC (Windows, Mac or Linux)

1. Install **Node.js 20 or newer** from nodejs.org (LTS).
2. Unzip this folder, open a terminal in `author-room/web` and run:
   ```
   npm install
   npm run dev
   ```
3. Open **http://localhost:3000**, enter your email, click the link you receive.
   Use the same computer and browser; the link returns you to localhost:3000.
4. First sign-in only: enter your author name to claim this Author's Room. Nobody else can claim it after you.
5. Start a book. The team answers within about a minute; the page updates by itself.

`web/.env.local` already holds the project URL and its publishable key (both safe to be public).
No AI keys or server secrets are in the app.

## What works today (P0–P2)

| Step | What happens |
| --- | --- |
| Idea → interview | Author Interviewer asks up to two plain questions at a time and builds the brief |
| Directions | Genre Strategist proposes 3 directions with fit, reader experience, development and risk; you choose |
| Constitution | Chief Editor drafts protected parameters (premise, genre, POV, voice, ending, never-change list); you approve |
| Book Bible | Story Architect seeds characters, places, rules, canon facts and a voice profile |
| Paragraphs | Lead Writer drafts → Voice, Continuity, Logic/Fact, Language and simulated-Reader reviewers score it independently → Chief Editor consolidates → up to 2 automatic revisions → you approve or ask for a change |
| Memory | Every version is kept; approved text is locked in the database; canon facts are extracted from passed paragraphs |
| Keys & quota | `/keys` shows each key's team, what it is doing, usage, errors and the project quota |

Tested end to end on 18 Nov 2026 with a sample book: the reviewers caught a real contradiction in the
first draft ("words she had never written" vs letters in her own handwriting); the revision fixed it; the
paragraph passed at 88–100 and was locked on approval.

## Keys

Google applies Gemini quota **per project**. Tests showed your keys come from at least two projects:
K01, K02 and K12 behave alike; K03–K11 belong to a newer project (Google refuses gemini-2.5-flash to
them as "not available to new users"). Using several projects to raise quota breaks Google's terms and
the project brief, so K03–K11 are **disabled**, not deleted. If AI Studio shows any of them are in the same
project as K01, enable them on `/keys`.

Team routing now: Orchestration, Editorial, Publishing → K01 · Ideation, Readers, Retrieval → K02 ·
Writing, Assurance → K12.

**These keys were pasted into a chat — replace them:** in AI Studio create new keys in your chosen
project, add them on `/keys`, assign teams, then revoke the old ones there and delete them in AI Studio.

## Models (free tier, as tested)

| Tier | Model | Fallbacks when busy (never on quota) |
| --- | --- | --- |
| fast | gemini-3.1-flash-lite | gemini-3.5-flash-lite |
| standard / deep | gemini-2.5-flash | gemini-3.5-flash-lite, gemini-3-flash-preview |

Pro models have no free quota. Change models in the `model_registry` table; no code change needed.
When a quota is used up, work waits and resumes by itself; the book page shows "waiting for quota".

## Privacy

Books marked **Standard** run on the free tier, where Google may use content to improve its products.
Books marked **Confidential** pause until the Gemini project is on a paid tier.

## Reliability: what happens when things go wrong

- **Laptop off, browser closed, internet lost:** the work carries on in the cloud. A schedule in the database calls the
  worker every minute; a watchdog every 5 minutes restarts any step that was interrupted. Tested: browser closed for
  4 minutes mid-paragraph; on return the paragraph was written and had passed all five reviews.
- **While offline** the app shows a yellow banner. Actions do not go through and say so plainly; a reply you typed is
  kept in the box. The page refreshes itself when you reconnect.
- **Double clicks** never send twice (one action at a time; the database also refuses duplicates).
- **Where everything is stored:** Supabase Postgres in Mumbai (ap-south-1): ideas, chat, every paragraph version, reviews,
  decisions and the usage log. Gemini keys are in Supabase Vault. Nothing lives on the laptop except your sign-in.
- **Backups:** the free plan has no automatic backups. Use *Download backup (.json)* on each book regularly, or move to
  Supabase Pro ($25/month, daily backups) before relying on it for a real book.
- **Images:** not generated yet (cover and illustration work is a later phase).

## Watch progress remotely

- **Live app (phone or any computer):** https://crux-operationsalert-art.github.io/authors-room/ — sign in with your password.
  To update it: `cd web && NEXT_PUBLIC_BASE_PATH=/authors-room npx next build`, add an empty `.nojekyll` to `out/`, and push `out/` to the `gh-pages` branch.

- **Phone or any computer, read-only:** open the *Author's Room — progress* page in Claude (web or app). It reads your
  database through your Supabase connector and refreshes every minute. Source: `monitor/progress-page.html`.
- **Full app from anywhere:** host the `web/out` folder (for example on Netlify, free), then add the site's address to
  Supabase → Authentication → URL configuration → Redirect URLs.

## Testing

- `supabase/tests` — 26 database checks (`local/test.sh`).
- `e2e/test.mjs` — full browser test as an author against the live system; `e2e/recheck.mjs` — focused re-check.
- `supabase/scripts/reset-test-user.sql` — removes the test user and its books afterwards.

## Code

```
supabase/migrations/   database (0001–0010), applied to the live project
supabase/functions/worker/   the AI team (Edge Function): ai.ts, roles.ts, index.ts
supabase/tests/        SQL tests (22 checks)        local/test.sh runs them on Postgres 16
worker/                Node version of the request manager + unit tests (10 checks)
web/                   the app (Next.js, static export)
```

## Next build phases

P3 outline and multi-scene writing, Decision Centre · P4 chapter and whole-book reviews, ripple
analysis, real beta readers · P5 production: front/back matter, cover, DOCX/PDF/EPUB · P6 hardening.
