# AI Brand Studio — overnight build handoff

Branch: **`brand-designer`** (off `main`). **Nothing deployed** — every commit
printed `on 'brand-designer', not main — skipping deploy`. Production (Sprout,
the live storefront, all current AI) is untouched.

## TL;DR — what got built (all node-validated, 14/14 tests green)

A working, white-labeled, per-tenant storefront design generator:

1. **`lib/model-gateway.js`** — the single vendor-neutral model boundary. Reads
   neutral env vars (`MODEL_API_*`) **with fallback to the existing `ANTHROPIC_*`**,
   so it works in prod with **no .env change**.
2. **`lib/brand-tokens.js` / `lib/brand-theme.js`** — canonical colour tokens,
   theme schema + sanitiser, config-key expansion, and the CSS-var override map.
3. **`lib/brand-gates.js`** — deterministic quality gates (WCAG contrast,
   palette discipline, conservative China-market advisories).
4. **`lib/brand-designer.js`** — the engine: real-content conditioning, the
   opinionated house-style prompt, the forced tool, sanitiser, font guard, and
   an in-memory async job store.
5. **`lib/brand-fonts.js`** — curated, mostly-OFL font library (proposal); the
   engine only lets the model pick **installed** fonts.
6. **Routes in `routes/retail.js`** — `GET/POST /api/retail-admin/brand/{status,
   generate,job/:id,apply,publish}` (async, white-labeled).
7. **Mini-app** — `miniapp/utils/brand-tokens.js` (mirror), `theme.js`
   `buildThemeVars()`, and **Home page wired** to inject the brand vars.
8. **`public/brand-studio.html`** — a self-contained first-pass UI.
9. **`eval/brand/`** — 18 briefs (8 archetypes × 3 audiences), scorer, rubric.
10. **`scripts/test_brand.js`** — pure-logic test suite.

## The ONE thing to know: it already has a key path

The gateway uses `MODEL_API_KEY || ANTHROPIC_API_KEY` and
`MODEL_API_URL || ANTHROPIC_URL` and `MODEL_API_SECRET || ANTHROPIC_PROXY_SECRET`.
**Your HK prod box already has `ANTHROPIC_API_KEY` + the Singapore proxy set**
(Sprout uses them), so once this branch is deployed the brand feature works
through the **same key + proxy** with zero new configuration.

To test generation **locally**, set `ANTHROPIC_API_KEY` (and `ANTHROPIC_URL` /
`ANTHROPIC_PROXY_SECRET` if you route through the proxy) in your local env.
Without a key, endpoints return a clean "design service unavailable" — they
never crash.

## How to verify (you — browser parts I deliberately did NOT self-verify)

1. **Logic (safe now):** `node scripts/test_brand.js` → expect `14 passed, all green`.
2. **Eval (needs key):** `node eval/brand/run.js` → with a key set, it generates
   for all 18 briefs and prints deterministic scores.
3. **Full flow:** log into `/retail-admin`, then open **`/assets/brand-studio.html`**
   in the same browser. Fill the quiz → **Design my brand** → watch it poll →
   see palette/fonts/layout → **Apply as draft** → open the **Mini App Editor
   (/cms)** to preview the draft Home layout → **Publish live**.
4. **See the colours:** prefer a **sandbox/test tenant** (provision one) and
   **Publish** — see "Known limitation" below re: pre-publish preview.

## Known limitations / honest gaps (by design, for follow-up)

- **Pre-publish colour preview:** `apply` writes the theme to a draft key
  (`cms.draft.brand_theme`) that the mini-app preview does **not yet overlay**,
  so the draft preview shows the new **layout** but with current **live**
  colours. Colours apply on **Publish**. Wiring a draft-theme preview overlay
  is the top follow-up.
- **Injection wired on Home only.** Shop/Product/Cart/Me need the same one-liner
  (`buildThemeVars` on the page root — see `home.js`/`home.wxml` as the
  reference). ~5 small edits.
- **`block-renderer.js` still has its own inline COLOR_MAP.** I added the mirror
  + sync test but did NOT refactor the live renderer (avoided touching it blind).
- **Stage 1 is deterministic** (brief from quiz answers). The hybrid "Claude
  follow-up questions" + PDF/logo upload (vision) are not built yet.
- **Proposed fonts aren't hosted.** Only the 6 already-installed families
  render; the proposed library needs the font files added under
  `public/assets/fonts/` + registered in `miniapp/utils/fonts.js`.
- **UI is a rough first pass**, served standalone at `/assets/brand-studio.html`.
  Proper integration as a retail-admin tab is a follow-up.

## White-label status

- Application code + customer responses are vendor-neutral: responses strip
  `provider`/`usage`, errors are generic, git messages say "AI Brand Studio".
- The single tell remaining (Tier 1) lives **only** in `lib/model-gateway.js`
  (the `anthropic-version` header + default model literal). To remove ALL tells:
  rename the server `.env` to the neutral names, and/or adopt the **Tier-2
  relay** (point `MODEL_API_URL` at a translation proxy) — see the file header.
- **Optional .env rename** (do later, coordinated): add
  `MODEL_API_KEY`/`MODEL_API_URL`/`MODEL_NAME`/`MODEL_API_SECRET` and delete the
  `ANTHROPIC_*` ones. **Until you do, leave `ANTHROPIC_*` as-is** — renaming code
  without the .env would break the key (the fallback is what keeps prod safe).

## Reviewing / merging / deploying

- Review: `git diff main...brand-designer`.
- This branch does NOT deploy. To ship: **squash-merge to `main`** (which
  auto-deploys). That one deploy ships the new render code to **each tenant's
  mini-app** is NOT automatic — the mini-app side (Home injection) needs the
  usual **WeChat publish per tenant** to ship; the backend + `/assets` page go
  live on the merge.
- Recommend: verify on a sandbox tenant first; merge when happy.

## Next session (suggested order)

1. Draft-theme preview overlay (see colours before publish).
2. Wire the other 5 pages' injection.
3. Host the proposed fonts; finish the font-upload path.
4. Stage-1 Claude follow-ups + PDF/logo (vision) intake.
5. Refactor `block-renderer.js` to the shared tokens (with browser verify).
6. Vision-in-the-loop + multi-candidate (M4), then presets (M5).

Full design rationale: `memory/feature_ai_brand_designer.md`.
