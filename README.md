# Roots System v2 (Full Circle)

Backend + storefront + operator tooling for **Roots**, built as the foundation of the
**Full Circle** multi-tenant retail platform. One Node/Express service powers an online
store, a WeChat Mini App, an operator "Mini App Backend," and a kitchen/ERP app, all on a
single SQLite database.

> **Private, commercial codebase.** Contains payment-integration and customer-data logic.
> Do not make public.

## Stack

- **Runtime:** Node.js + [Express](https://expressjs.com/) (`server.js` entry, port 4000)
- **Database:** [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — `data/roots.db` (gitignored; live data lives on the server)
- **Auth/security:** `express-session` (+ connect-sqlite3 store), `bcrypt`, `helmet`, `express-rate-limit`
- **Media:** `sharp` for image processing, `multer` for uploads
- **Push:** `web-push` (delivery/pickup reminders, order notifications)
- **Client:** WeChat Mini App (`miniapp/`) + browser admin/storefront (`public/`)

## Layout

| Path | What's there |
|------|--------------|
| `server.js` | App entry — wires routes, sessions, integrations |
| `database.js` | Schema + idempotent `addColumn` migrations (runs on boot) |
| `routes/` | HTTP route modules (`retail.js` is the storefront/mini-app API) |
| `lib/` | Domain logic (delivery reminders, secret-box, model gateway, …) |
| `middleware/` | Express middleware |
| `public/` | Browser apps — storefront, `retail-admin*` (Mini App Backend), `cms.html` |
| `public/retail-admin/` | Split admin JS (`01…10-*.js`, one global scope, load order matters) |
| `miniapp/` | WeChat Mini App (pages, components, utils) |
| `scripts/` | One-off migrations, imports, and tooling (run on the server) |
| `docs/`, `reference/`, `eval/` | Docs, design references, evaluation assets |

## Getting started

```bash
npm install
npm start          # node server.js → http://localhost:4000
npm run lint       # eslint
npm run lint:fix
```

Secrets are read from a local `.env` (gitignored — see `.gitignore` for the full
no-commit list: `.env*`, `data/*.db`, PII migration files, `DEPLOY.md`). Ask a maintainer
for the values; never commit them.

## ⚠️ Commits deploy to production

This repo has a **post-commit hook that lints and ships changed deployable files to the
production server, then restarts the app.** A `git commit` here is effectively a live
deploy. Non-deployable files (`.md`, `.csv`) are skipped. Be deliberate about what you
commit, and never bypass the hook (`--no-verify`) to dodge a failing check.

**The same deploy also runs from GitHub Actions** (`.github/workflows/deploy.yml`) on
every push to `main` — this is what actually ships a push made without the local
post-commit hook (e.g. from a Claude Code session with no repo-local git hooks, a PR
merge, or a push from a machine that never ran `npm install`'s hook setup). It's the
identical syntax-gate → backup → install → pm2-restart → health-check pipeline, run on
a GitHub-hosted runner that has real network access to the production server. **A
session without direct network access to the server should never fall back to
telling the user to run `scripts/deploy-changed.sh` / manual `ssh`+`scp` by hand** —
just push to `main` and confirm the deploy via `list_workflow_runs` for `deploy.yml`
(or ask the user to check the repo's Actions tab). A `[skip deploy]` / `[no deploy]`
token in the commit subject bypasses both paths.

## Conventions

- **Bilingual UI:** English and 中文 are **two separate versions** of every operator
  string — the user sees **one** live language, never both stacked or shown together.
  In JS use `cuT('English', '中文')`. In static HTML write a single text node as
  `English · 中文` (full English, ` · `, full Chinese); a global pass splits on ` · `
  and shows one side.
  - **Gotcha:** the ` · ` split runs **per text node**. Interleaving inline markup
    (`<b>`, `<span>`, `<code>`) *between* the EN and CN fragments the node, the ` · `
    no longer separates full-EN from full-CN, and **both languages leak through**.
    Keep each `English · 中文` pair in one clean text node (a trailing
    `<span>(optional · 选填)</span>` is its own clean pair and is fine); drop the
    inline tag if it would split a pair.
- **Migrations:** add columns through `addColumn(...)` in `database.js` (idempotent); don't
  hand-edit the live DB schema.
- **Multi-tenant:** catalog/data writes are tenant-scoped — use the tenant-scoped DB handle,
  not the shared one.
