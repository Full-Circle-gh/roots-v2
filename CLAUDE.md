# CLAUDE.md — start here

Guidance for Claude (any account/session) working in this repo. This file loads
automatically; it's the **guardrails + a map**, not the full picture.

## Read these first
- **`docs/PROJECT-KNOWLEDGE.md`** — the complete, self-contained handoff (superset). Read it before
  any non-trivial change; it's written so a fresh Claude absorbs the whole system from one file.
- `docs/DEEP-DIVE.md` — mechanism-level companion (how it actually works, minus the kitchen/ERP app).
- `README.md` — quick stack/layout/conventions.
- Root planning/audit docs for intent: `PERMISSIONS_PLAN.md`, `WEB-STOREFRONT-PLAN.md`,
  `CHANNELS-LOGISTICS-PLUGINS-PLAN.md`, `TENANT-ONBOARDING.md`, `PARITY_AUDIT.md`,
  `BUG-HUNT-OVERNIGHT.md` (risk ledger), `I18N-AUDIT-MINIAPP-BACKEND.md`.

## What this is (one line)
**Roots** — tenant #1 of **Full Circle**, a multi-tenant retail SaaS. One Node/Express +
`better-sqlite3` service (`server.js`, port 4000) serves five surfaces (WeChat Mini App, web
storefront, operator "Mini App Backend", kitchen/ERP, platform console) off one codebase + one schema.

## ⚠️ Non-negotiable guardrails
1. **A commit is a live production deploy.** A post-commit hook + `.github/workflows/deploy.yml` ship
   changed `public/ routes/ lib/ middleware/ scripts/` + `server.js`/`database.js`/`schema.sql` to the
   production box on every push to **`main`** (syntax-gate → backup → pm2 restart → health-probe →
   auto-rollback). Only `main` deploys. **`claude/*` feature branches are safe checkpoints** — develop
   there, never push to `main` without explicit permission. `.md`/`.csv`/`miniapp/` are non-deployable.
   `[skip deploy]` / `[no deploy]` in the commit **subject** bypasses. Never use `--no-verify`.
2. **After editing `public/retail-admin/*.js`, bump the cache version in `public/sw.js`** or clients
   keep stale JS.
3. **Bilingual UI is one live language at a time**, never both stacked. In JS use `cuT('English','中文')`;
   in static HTML write a single text node `English · 中文` (a global splitter shows one side). **Leak
   gotcha:** the ` · ` split runs per text node — don't interleave inline markup (`<b>`/`<span>`/`<code>`)
   between the EN and CN halves, or both languages show. Keep each `English · 中文` pair in one clean node.
4. **Multi-tenant scoping:** data-plane reads/writes use the tenant handle `tdb()`, not the shared `db`
   (only control-plane `users`/`sessions` etc. may use `db`). Channel-sync enqueues go **only** through
   `inventory.adjustStock`, never a direct `INSERT INTO *_sync_queue`.
5. **Migrations:** add columns via idempotent `addColumn(...)` in `database.js` (a table must be
   `CREATE`d before it's `addColumn`'d — see the cold-boot note in the handoff). Don't hand-edit live schema.
6. **Secrets** live in a gitignored `.env` on the box — never commit them. Keep PII `migration_*.json`
   inputs off git.

## Run it locally
```bash
npm install        # native better-sqlite3 + sharp (Node 18–22)
node server.js     # → http://localhost:4000   (no .env needed to boot; payments run in dev mode)
npm run lint       # eslint
```

## Known risk classes (respect when editing)
Money reversals on refund/cancel (cumulative-capped + idempotent); `tdb()` scoping; base64 blob leaks
in list endpoints (emit lazy `/image?v=` URLs); WeChat one-shot subscribe-consent burns; bare-date
coupon expiry as UTC midnight; i18n pair-hiding. Details + fixes in `docs/PROJECT-KNOWLEDGE.md §15`.
