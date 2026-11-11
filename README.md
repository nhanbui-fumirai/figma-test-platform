# Figma Test Platform

Compare websites with their Figma design: import a design (.fig file or Figma link), map its screens to URLs, give the
pages the data and state of the design (mock API, cookies, test login, steps), run Playwright, and read the differences.

## Architecture

```
apps/api            NestJS HTTP API: auth, projects, settings + secrets, Figma imports, screens, runs and reports, mocks,
                    AI jobs, repository (read-only), Storybook export, files, live job logs (SSE). Sends long work to the queue.
apps/worker         NestJS standalone app: runs the jobs from their pg-boss queues. Several workers can share a run.
apps/web            Next.js (App Router): the UI. Calls the API directly with the session cookie.
packages/contracts  zod schemas + typed client: the API contract (DTOs, steps DSL, mock ops, report shape), shared by api and web.
packages/db         TypeORM DataSource, entities, migrations, the job store, the credential store (sealed secrets).
packages/core       settings (.env, zod), logger with secret redaction, crypto (AES-256-GCM), blob storage, blob keys, queues.
packages/figma      .fig parser (kiwi + zstd) and REST client to one REST-shaped tree; pages/sections/frames; design area; spec; renderer.
packages/compare    DOM collector (script run in the page), text matching (coverage), checks (design score), the report.
packages/browser    Chromium contexts (viewport, phone emulation, cookies, login state), URL policy (SSRF), test login,
                    steps interpreter, settle, screenshots, auth-wall detection.
packages/mocks      API recorder, replay matcher (GraphQL closest variables, REST query near-match), ops + guards, Storybook export.
packages/ai         Anthropic / OpenRouter behind one interface, JSON answers validated and repaired; steps and mock-data tasks.
packages/git        read-only repository copy: bare shallow clone, token only in git's environment, push disabled, tree/file reads.
```

Rules the code follows:

- **A feature = a module** in apps/api (controller → service → @figtest/db). Its long work = a queue in
  `packages/core/src/queue.ts` and a handler in `apps/worker/src/handlers`. Domain logic lives in packages, so the api
  and the worker share it.
- **Every long operation is a Job** (table `jobs`) with log lines (`job_logs`): one SSE format for import, render,
  clone, record, AI and test runs. A reconnecting browser resumes after the last line it got (Last-Event-ID).
- **The schema only changes through migrations** (`packages/db/src/migrations`), applied by the api at start or by
  `pnpm db:migrate`. pg-boss keeps its own schema.
- **Secrets** (tokens, test logins, AI keys) are sealed with `APP_SECRET`, never returned to the web (only a hint), and
  masked in every log. The test password is only typed on the website host; the git token never reaches argv, URLs,
  `.git/config` or logs.
- **Big files** (designs, images, specs, screenshots, reports) go to the blob store; the database keeps their keys.
- **AI only prepares** (steps, mock data); a test run replays what was saved and never calls the AI.

## Run it (Windows, macOS, Linux)

Needs Node 24, pnpm 10, git and PostgreSQL 15 or later.

```bash
pnpm install
pnpm exec playwright install chromium   # once: the browser of the worker
cp .env.example .env                     # then set APP_SECRET (command in the file), the admin password and DATABASE_URL
pnpm build                               # the packages once (dev rebuilds them on change)
pnpm dev                                 # api :4000, worker, web :3000 (the api applies the migrations at start)
```

The database, either way:

- **A PostgreSQL you already run** (DBeaver, pgAdmin, psql), connected as a superuser, one statement at a time
  (auto-commit):
  ```sql
  CREATE ROLE figtest LOGIN PASSWORD 'choose-one';
  CREATE DATABASE figtest OWNER figtest ENCODING 'UTF8' TEMPLATE template0;
  ```
  then `DATABASE_URL=postgres://figtest:choose-one@localhost:5432/figtest`. The owner may create schemas and the
  `pg_trgm` extension (screen search): pg-boss creates `pgboss` itself.
- **Docker**: `pnpm db:up` starts PostgreSQL 18 on port 5433 (`DATABASE_URL=postgres://figtest:figtest@localhost:5433/figtest`).

Open http://localhost:3000 (use `localhost`, not `127.0.0.1`: the API accepts changes from `WEB_ORIGIN` only) and sign
in with ADMIN_EMAIL / ADMIN_PASSWORD.

Tests: `pnpm test`. Types: `pnpm typecheck`.

## Using it

1. **Project** — name, slug and the website URL (the staging site). Screen URLs may be paths of it.
2. **Settings** — Figma access token (link imports), GitHub token (read-only, fine-grained), test login (login URL,
   user, password), AI provider + model + key, API URL globs to record/mock (`**/api/**`, `**/graphql`), Storybook URL.
3. **Design** — upload a `.fig` (Figma: File › Save local copy) or paste a Figma link. Re-importing keeps the screens'
   config and only renders the frames that changed.
4. **Screens** — pages and sections as a tree (hide a page or a section in one click), search by name or URL, filters
   (with/without URL, last status, hidden, drafts and duplicates). On a screen: URL, cookies, requires login, steps,
   prompt, target (site or Storybook story); Preview opens it like a test and says if an auth wall is in the way.
5. **Mocks** — Record the API calls of a screen, edit the served data (or let the AI fill it from the design), the
   recorded body stays as recorded and the guards refuse edits that change value kinds or duplicate list items.
6. **Runs** — test all screens with a URL, or a selection. Each result: coverage (design texts found) and design score
   (checks on what matched) shown apart; `blocked` when a login / access page is in the way (no score).
7. **Report** — Figma and the page side by side with the differences drawn on both, filters by kind and property.
8. **Repository** — a read-only copy of the frontend source (browse files); nothing can be pushed.
9. **Storybook** — download MSW handlers, fixtures and stories made from the mocks; a screen can target a story.

## Settings (.env)

| Name | What |
|---|---|
| `DATABASE_URL` | PostgreSQL 15+ |
| `APP_SECRET` | 32 bytes base64: seals the secrets (changing it makes them unreadable) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin, created when there is no user |
| `API_PORT`, `WEB_ORIGIN` | API port, web origin (CORS + CSRF check) |
| `STORAGE_DIR` | blobs (designs, images, reports), repositories, uploads in progress |
| `ALLOW_PRIVATE_HOSTS` | let tests open localhost / private addresses (dev sites); keep `false` on a shared server |
| `WORKER_CONCURRENCY` | jobs of each queue a worker runs at the same time (a run screen = one job) |
| `MAX_UPLOAD_MB` | biggest `.fig` upload |
| `HEADLESS` | `false` shows the worker's browser |
