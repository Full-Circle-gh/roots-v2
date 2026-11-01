# Tacet — roots-v2 (Qwen Code project context)

You are working in **Full Circle / Roots System v2**: private multi-tenant retail (storefront, WeChat mini app, operator admin, kitchen). Stack: Node + Express, SQLite (`better-sqlite3`), `public/` + `miniapp/`.

## Read first (every session)

1. **`CLAUDE.md`** — standing rules for all work in this repo (PR-only, no direct push to `main`, decisions before code, tests, Chinese strings, communication). Treat it as binding.
2. **`README.md`** — layout, conventions (`cuT`, migrations, deploy warning).
3. For architecture choices already made: **`docs/tacet-consolidation-decisions.md`** (section numbers are citations; line numbers in old entries may be stale — find code by name).
4. For operator/customer copy: **`docs/tacet-delivery-vocabulary.md`**.

## This machine

- **Project folder:** `c:\Users\Asher\Desktop\full circle\full circle\roots-v2`
- **Git remote:** `https://github.com/Full-Circle-gh/roots-v2.git`
- **GitHub CLI:** use `gh` for issues, PRs, checks, merges (already authenticated on this PC).

## Local dev

```powershell
cd "c:\Users\Asher\Desktop\full circle\full circle\roots-v2"
npm install
npm start          # http://localhost:4000
npm run test:fast  # gate; do not run test:slow unless Ash asks
```

- Copy **`.env`** from a maintainer (gitignored). Never commit secrets.
- **Node:** CI/deploy lint uses Node 20; this PC may have Node 24 — if `better-sqlite3` fails to load locally, use Node 20 LTS for this repo.
- **Local `git commit` can trigger production deploy** via the post-commit hook. Prefer **branch → PR → merge `main`** so GitHub Actions deploy runs (same pipeline). Do not use `--no-verify` to skip hooks unless Ash explicitly asks.

## How to ship (same as Cursor sessions)

1. `git fetch origin` and compare to any pinned SHA in the brief.
2. Branch from current `origin/main` (one PR per change).
3. Record architectural decisions in `docs/tacet-consolidation-decisions.md` before dependent code.
4. Composed Chinese/English pairs go in `docs/tacet-delivery-vocabulary.md` in the same commit as the UI that uses them.
5. Push branch, `gh pr create`, wait for checks, merge to `main`, confirm **Deploy to production** workflow succeeded.
6. Never force-push `main`.

## What to ignore when searching

Large local-only trees: `reference/` (mockups), `design/`, untracked scratch files. Respect `.gitignore`.

## Starting Qwen Code here

```powershell
cd "c:\Users\Asher\Desktop\full circle\full circle\roots-v2"
qwen
```

Use `/memory refresh` after editing this file or `CLAUDE.md`. Use `/doctor` if auth fails (API key lives in **`~/.qwen/settings.json`**, not in the repo).

Optional: `/setup-github` only if you want GitHub Actions bots (`@qwencoder`); not required for everyday coding.
