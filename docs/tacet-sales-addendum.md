# Tacet — Sales section addendum, 2026-07-19

> Slots into the canonical set next to the other handoffs. Method unchanged (mockups-first, Ash-is-not-a-dev, briefs in their own code blocks, one yes/no at a time). This records only the Sales work done this session. **Sales is paused by Ash's decision to move to Profile next — this is not a to-do list, it's a save point.**

## Rulebook confirmed
`tacet-desktop-patterns.md` **v1.8** is the live rulebook this session ran against. README state confirmed at start: Orders closed, Customers designed, Dashboard shipped, Batch 1 remaining (Reports · Products · Settings · Team). Sales was not on that Batch-1 list — Ash chose it independently.

## What Sales actually is (the finding that shaped everything)
"Sales" is **not** an analytics page. It's a **channel & location control room** — "which channels/stores are open?" plus a quick per-channel revenue glance. Every money figure on the live page has **never displayed real data**: `salesInit()` fetches `/api/retail-admin/sales/summary`, a route that **does not exist** (the real one is `/api/sales/summary`, different prefix + shape, consumed only by `app.html`). The `catch` swallows the 404 and leaves `—`. The "4 / 5 active channels" is a hardcoded literal in the HTML, not live. The only working live data is channel open/closed state (the toggles), which ARE write controls with real customer-facing blast radius.

Ash's decision: **keep the page's shape exactly** (overview of open channels/locations + quick revenue glance). This became a "make it honest + polish + one new capability" pass, not a redesign.

## DESIGN — done this session (mockups passed Ash's eye, rulebook-checked)
Sales page, English view, reviewed across several rounds:
- **Summary strip** — 4 KPI tiles (Channels revenue / Total orders / Avg order value / Active channels), all `today`.
- **Locations** — one row per store, master open/close toggle, state line. **Rows are expandable** → per-channel breakdown (channel name · that store's today revenue · the store×channel toggle). Collapsed headline = sum of channel sub-rows (reconciles on screen; verified: Tianhe 2,300+1,320+760+740 = 5,120; Panyu 1,240+940.50+200 = 2,380.50).
- **Channels** — 5 cards (WeChat, Web shop, Meituan, gzgrocery, Eleme). Fourth metric cell is channel-specific and REAL: Items sold (WeChat/Web), Stock pushes (Meituan/Eleme), Pickups (gzgrocery). Each connected card has a **configure gear**; Eleme is locked with a **Set up** CTA. Meituan shows **Needs attention** (amber pill).
- **Three honest data states (§1.12)** — populated worst-case, genuine zero day (¥0/0, calm), load-failed (inline "Couldn't load today's figures · Retry", no toast). **The dash is banned** except on a locked/not-set-up channel. This killed the live page's ambiguity where `—` meant zero, missing, AND broken all at once.
- **English rendering fixed** — the `en · 中文` notation in briefs is a SOURCE PAIR (system shows one language), never a glued display string. An early round rendered both glued; corrected to English-only.
- **Channel chips** — in the English view, two-letter Latin marks: **WC · WB · MT · GZ · EL** (Chinese-character chips 微/网/美/管/饿 still exist in source for the Chinese view).

### Rulebook discipline applied
- **Zero Dusk on this page** — toggles are the merchant acting, not the AI. Open state = Sage.
- gzgrocery special-cased: **single location** (Tianhe only) — its channel sub-row appears only under Tianhe, never elsewhere.
- Sentence case throughout (§1.6); genuine `en · 中文` pairs never glued (§1.11).

### Design decisions locked
1. Page keeps its existing shape — no analytics rebuild.
2. Location rows expand to reveal per-store-per-channel revenue (this is buildable — see data findings).
3. gzgrocery = single location, official number, never recomputed from mirror rows.
4. Two-letter Latin chips in English view; gear restored on connected cards; Eleme uses Set up.

## DATA FINDINGS (Claude Code, read-only surveys — no counts, can't reach live DB)

### Revenue per location per channel — BUILDABLE (display job, not schema change)
`retail_orders` carries **both** `store_id` (INTEGER, added by migration, no default → legacy rows may be NULL) **and** `channel` (TEXT DEFAULT 'wechat') on the same row, alongside `total`. All four write paths populate both (mini-app/web checkout in `routes/retail.js`; meituan/eleme/gzgrocery daemons). So store×channel revenue is computable. **No existing endpoint crosses the two** — would need a new `GROUP BY store_id, channel`.

### Three snags flagged (decide before build):
1. **gzgrocery double-sourced — RESOLVED.** `retail_orders channel='gzgrocery'` rows are a **display-only MIRROR** of the gzgrocery **OpenCart order feed** (not Guanyi stock drift). Authoritative revenue = `guanyiPickupSales()` reading `retail_stock_ledger` (reason `gzgrocery_order`), which **excludes** the mirror rows — no double count. **Rule for build: gzgrocery headline always from the official source, never re-summed from order rows.** Single store (Tianhe).
2. **Eleme inconsistency** — `eleme-internal.js` DOES insert `retail_orders` rows with revenue + store_id, but `sales/summary` hardcodes eleme to zero (connected:false). Raw-data computation would surface Eleme revenue the summary insists doesn't exist. Reconcile at build.
3. **Per-item revenue missing for platform channels** — Meituan/Eleme `retail_order_items` insert with unit_price/line_total = 0 (order-level total only). Store×channel works; store×channel×product does not for those two.

### Unverified (needs a live-box check before building revenue-per-cell):
- Actual populated-vs-null counts on `store_id`/`channel` (whether legacy orders predate the store_id migration). One query settles it: `SELECT channel, COUNT(*) n, SUM(store_id IS NULL) null_store, SUM(total) rev FROM retail_orders GROUP BY channel;`

## BUILD — nothing coded this session (design + surveys only)
When/if Ash returns to the Sales build, dependency-ordered:
1. **Wire the dead revenue endpoint** — create `/api/retail-admin/sales/summary` (or re-point the frontend call) so the KPI tiles + channel revenue stop being permanent `—`. Data layer exists in `routes/sales.js`.
2. **Kill the hardcoded "4 / 5"** active-channels literal.
3. **Fix the stale "coming soon" title** on `.sales-toggle` — the toggle works; `csRender()` unlocks it, but on any channel-status fetch failure it stays locked with a lying tooltip.
4. **Revenue-per-location-per-channel endpoint** — new `GROUP BY store_id, channel` over `retail_orders`, with the gzgrocery/Eleme rules above baked in. AFTER the live-box null-count check.
5. **§1.12 disable guards** on the channel-status write buttons (card toggles don't disable while writing today).

## MEITUAN CONFIG — surveyed, structure UNDECIDED (in progress when Sales was paused)
Ash asked to design "everything" for the Meituan channel behind the gear. Two read-only Claude Code surveys done:

### Survey 1 — config sheet + relay wizard
- **Gear (connected)** → `igMeituanConfig`, a mostly READ-ONLY status sheet in overlay `#cfg-host`. **Set up / not-connected** → `igRelayWizard` (box → creds → sms → done) inline in `#sales-setup-host`. **Two renderers, two mounts** — not one surface in two states.
- Wizard's **creds step captures Meituan username + password** (stored encrypted via `setTenantSecret`, cap-gated `integrations:manage` — done right).
- 🔴 **"Needs attention" is effectively unreachable for the live account.** It only fires from a RELAY session `expired`/`failed`. Roots runs Meituan the **legacy way** (env creds + daemon), where `legacyChannelLive()` returns connected if Meituan has EVER worked — so a live session death shows green "Connected." The one warning that matters can't fire when needed.
- **Fix path mis-routes** — an expired session's "Fix" opens the wizard at "Request the box" (first-timer step), not re-login.
- ROT: glued bilingual strings in the wizard (English mode shows both languages), the "coming soon" lie, overlay bar reads generic "Configuration" not "Meituan", stores-list has no error state.
- 🔴 CAPS: `/channel-status/{cell,channel,location}` is **UNMAPPED → fail-open** when `rbac_enforce` flips — the customer-facing open/close (置休 at every store). Belongs on PERMISSIONS_PLAN.md §11.

### Survey 2 — management tab (#tab-meituan, mtAdminInit, 11-meituan.js)
- Sections: status strip · Products/Bundles sub-tabs · mapping table · bundle editor.
- 🔴 **ONE SURFACE, THREE TRUTHS** — the Sales card, config sheet, and management tab each compute Meituan health differently and can contradict:
  1. Three different "products live" counts.
  2. **"Needs attention" means two unrelated things** — login broken (card/sheet) vs products unmatched (tab). Same words, different emergency.
  3. Sync tile can show "Active" (= our server reachable) while sheet shows "Needs sign-in" (= Meituan login dead).
- **Two dangerous taps:** (1) **Sync now** — one UNCONFIRMED click pushes stock for all synced products+bundles to Meituan at both stores; wrong local stock → wrong availability live to customers in seconds. (2) **Match names auto-apply** — up to hundreds of sequential writes, no confirm, no cancel (the ~1000-request analog).
- ROT: half the tab bilingual, half English-only (paste + bundle modals have NO Chinese); `fmtAgo` English-only; **column header lies** ("by name" — it's SKU-first); dead endpoints (`/meituan/orders`, per-bundle push, business-status, store-status); `mtLoadBusinessStatus` pings a deleted element every 12s.
- 🔴 CAPS: orphaned `/store-status/{online,master,store/:code}` also **unmapped → fail-open** — same customer-facing open/close family as `channel-status/*`. Add to §11.
- Good news: everything the tab actually uses IS cap-gated (`meituan:map`, `meituan:sync`).
- Caveats: never rendered live; daemon/`lib` layer (the actual push logic) not opened; `retail_store_stock.physical_qty` correctness (what "Sync now" pushes) unverified; `app.html` twin not diffed.

### Meituan structure decision — OPEN
Ash chose "show me both, I'll pick." A brief was written for **A (two surfaces: quick sheet + working tab, one shared status truth)** vs **B (one unified page: glance on top, machinery below)**, with the status-vocabulary fix baked in ("Signed in / Needs sign-in" for login; "N not matched" for catalogue; **"Needs attention" banned**) and a blast-radius confirm on Sync now. **The A/B variants were never confirmed rendered** — the last screenshots showed the Sales page, not the Meituan comparison. If Meituan resumes, re-issue that A/B brief (in this addendum's spirit) and confirm the variants actually build.

## OPEN COSMETIC (raised, not resolved)
- **Rail out of scale** — the global left rail's type/icons read smaller/tighter than page content; they should share one type scale. A fix brief was written (rail labels 15px Inter 400, ~20px icons, 8px rhythm, Ink active fill, no Dusk). **Not confirmed rendered.** This is global chrome — fixing it touches every page, so worth doing deliberately.
- Note: Claude Design reported it "can't survey the retail-admin source" and offered to survey if given the repo. **Ignore that** — surveying is Claude Code's job (it has the real code); Claude Design only builds from briefs. Don't let it "survey" or it will invent.

## PARKED for later (Ash's call, not defaults)
- Sales build (the 5 items above).
- Meituan A/B structure decision, then full Meituan design (card behaviour · config sheet · wizard · management tab as one coherent surface, one truth).
- The **Set up flow** design (the `#sales-setup-host` wizard — smaller, on the Sales surface). Ash wanted "both eventually" for config surfaces; Set-up-flow-first was suggested.
- Per-channel config for the OTHER channels (WeChat, Web shop, gzgrocery) — each its own survey, own batch.
- Rail scale fix (global).

## Reality check (unchanged from house rules)
Ash has never used the Sales section with real habits/data. Design being done does NOT oblige the build to be next. Any "worst case" figures in the Sales mockups are invented for design.
