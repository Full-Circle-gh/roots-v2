# Phone parity — Recipes, Purchasing, Finance (survey, 2026-09-30)

Read-only survey against `main` at `4eb99ac` (main has since moved to
`197c9305`: #910 category banner and #911 promo cards, phone and docs only,
no recipe, purchasing or finance code). Line numbers are coordinates at
`4eb99ac` and will drift.

**Ask (Ash, 2026-09-30):** recipes in full on the phone, every PC feature;
the same for purchasing and everything to do with accounting; mockups of
every page in the Tacet design system.

**Standing ruling this falls under:** §97 (2026-09-10) — *"mobile version
functionality should be the same as PC"*, same capabilities not same layout,
every added write asserted on the request, every desktop guard comes with its
write, one PR per step. This request does not need a new principle. It does
overturn five later, narrower holds (listed below), and those need recording.

**Mockups:** canvas "Phone parity — Recipes, Purchasing, Finance", 36 phone
frames on three pages. Source: `design-handoff/phone-parity/src/`
(`node build.mjs <outdir>` regenerates every frame). Shell and tokens are the
live phone's (`public/m.html` `:root`, `headControls`), not the older
mobile-v2 canvas.

---

## 1. Where each area stands

| Area | Phone today | Missing on the phone |
|---|---|---|
| **Recipes** | List (search, Made/Repacked chips), one recipe read-only (Ingredients, Steps), "Make it" batch mode — phone-only | All editing, New, Duplicate, Archive, Version history, Print card, Cost & pricing, missing-cost / unit-mismatch warnings, category filter, Archived, Chinese name, "Makes N products", "Backs a material", materialize/unlink |
| **Materials** | Nothing (only "Ask to buy") | The whole screen: list, record, prices, supplier, allergens, cost + purchase history, archive |
| **Product ↔ recipe** | Nothing | Link/unlink a recipe, "from recipe" cost, build lines |
| **Purchasing — orders** | List (Open/Received/All), read-only order sheet, Mark ordered, Everything arrived, line-by-line receive, Receiving journal | Search, New order wizard (3 steps, price popover, running-low hints, typed lines), From the kitchen (§86 buyer side), order date / mixed-supplier / cost-each on the row, lifecycle stepper, Back to draft, Order again, Undo receiving (whole order), Back-order, Cancel, Landed cost, Finance panel, Print/send PO |
| **Purchasing — receiving** | Arrived / short / damaged / short reasons, store choice | Tracking number, invoice (发票) status per line, returns |
| **Purchasing — invoices (发票)** | Nothing | Everything: by supplier / recorded, month, KPIs, drill-down, no-invoice marks, add/edit/delete invoice with allocation, re-match, set supplier |
| **Purchasing — reorder, price history** | Nothing | Both |
| **Suppliers** | "Suppliers we owe" account in full, except the switch | Directory, search, Active/Disabled, supplier record (scorecard, fields, autosave + history, disable), price list, paperwork, orders, credit on/off, CSV import |
| **Finance** | Approvals (near complete), staff expense claims (phone-only) | Summary staircase + category and PO drill-downs + date range, Transactions (list, tiles, chips, filter, New/Edit/Delete, Return, Void, Re-file, Export CSV), Categories |
| **发票 on customer orders** | Read-only + snooze | Copy for accounting, number/link, upload, Mark issued, un-issue |
| **Reports** | Trend: 7/30/90, sparkline, four sections | Custom dates, store select, heatmap, cohorts, AI read/ask |

Not on either surface (nothing to port): recipe photos, recipe allergens,
recipe import/export, recurring expenses, bank accounts, settlements (§36).
Dead on desktop, not worth porting: "Copy from kitchen" (§78).

## 2. Holds this request overturns — each needs a line in the decisions doc before its code

| Hold | Where | Recommendation |
|---|---|---|
| Phone recipe screen is read-only; writes need "their own decision and survey of what reads those columns" | §164, §167; `m.html` Recipes header | **Overturn.** This request is the decision. The survey §167 asks for is part of the first recipe-writing PR. |
| "No money on this screen, for anybody" (recipes) | `m.html` Recipes header | **Overturn, gated like the desktop:** cost shown only with `recipes:costs`, failing **closed**. The phone's `mCan` fails open today — fix that for money keys first. |
| Supplier credit on/off is configured on the desktop only | §286; `m.html` supowed header | Overturn. One switch behind a confirm. |
| No purchase-return UI on the phone | `docs/purchase-returns.md` #5 | Overturn. It sits on the receive screen, where the damaged box is. |
| Fapiao issuing is a desktop job | `m.html` invoiceBlock | Already retired by §97; just not built. |

## 3. Defects found on the way — fix first, before any new screen

| # | Defect | Risk |
|---|---|---|
| 1 | Server: `PUT /purchases/:id/status` accepts `purchasing:receive` for **any** status, so a receive-only account can cancel an order or send it back to draft through the API | Permission hole |
| 2 | Kitchen-request decline: desktop shows ✕ to `purchasing:edit`, server requires `production:request` — the buyer is refused, a cook is not | Wrong gate both ways |
| 3 | Phone Approvals "Mark paid / recovered" writes on the first tap — its confirm calls `askConfirm`, which does not exist in `m.html` | Money write without the desktop's confirm (§97 rule) |
| 4 | Phone Approvals shows a **voided** claim as "Waiting" | Wrong status on money |
| 5 | Phone PO sheet shows Mark ordered / Everything arrived / Receive line by line to view-only accounts (refused or silently nothing after the tap) | Dead buttons |
| 6 | Phone `mCan` lets everything through while capabilities load — harmless only because no phone screen shows money yet | Must close before recipe/finance money lands |
| 7 | `tacet-mobile-parity.md` Purchasing table and `m.html` Purchasing header say per-line receive is desktop-only; it shipped on the phone | Stale record (point forward, do not edit the closed audit) |

## 4. Build order — one PR each, per §97

Money and permissions first; screens that only read before screens that write.

| # | PR | Touches | Risk |
|---|---|---|---|
| 0a | Fixes 3, 4, 5, 6 (phone only) | `m.html`, tests | Low |
| 0b | Fixes 1, 2 (server gates) | `lib/cap-routes.js`, routes, tests | Medium — permissions |
| 1 | Finance Summary + drill-downs + dates (read-only) | `m.html`, `ROUTE_CAP` `finance:view` + money gate | Low |
| 2 | Finance Transactions: list, New/Edit/Delete, Return, Void, Re-file, Export | `m.html` | Medium — money writes |
| 3 | Finance Categories | `m.html` | Low |
| 4 | 发票 issue from the order sheet | `m.html` | Medium — customer-facing |
| 5 | Recipes read gaps: warnings, Makes, Backs material, category, Archived, Chinese name, Print | `m.html` | Low |
| 6 | Recipes editing: Details, Ingredients (picker, reorder), Steps, autosave, history | `m.html`, `tacet-autosave.js` | **High** — §164's autosave once wiped labour/overhead/price |
| 7 | Recipes Cost tab (`recipes:costs`, fail closed) | `m.html` | Medium |
| 8 | Recipes Duplicate / Archive / Materialize | `m.html` | Medium |
| 9 | Materials list + record | `m.html` | Medium |
| 10 | Product ↔ recipe link + build lines | `m.html` | Medium |
| 11 | Purchasing list search + order manage actions + landed cost + finance panel | `m.html` | Medium |
| 12 | New order wizard + price sheet + running-low | `m.html` | **High** — largest screen |
| 13 | From the kitchen | `m.html` (after 0b) | Medium |
| 14 | Receive: tracking, 发票 status, returns | `m.html` | Medium |
| 15 | Invoices (发票) + add/match + re-match + set supplier | `m.html` | **High** — allocation maths |
| 16 | Reorder + price history | `m.html` | Low |
| 17 | Suppliers directory + record + paperwork + credit switch | `m.html` | Medium |
| 18 | Print / share a PO | `m.html`, `26-print.js` reuse | Low |
| 19 | Reports: custom dates, store, heatmap, cohorts, AI read | `m.html` | Medium |

Every PR: `npm run test:fast` plus the phone suites it touches; each new write
asserted on the request body; every new Chinese string declared in
`docs/tacet-delivery-vocabulary.md` in the same commit (CLAUDE.md, amended
2026-09-06).

**Not recommended:** supplier CSV import on the phone. It is a one-off setup
job and a phone rarely holds a CSV file. Drawn on P12 as a button only, so it
can be dropped without redrawing anything.

**Coordination:** every PR above edits `public/m.html`. Other sessions work in
the same file (the promo-cards session was live when this was written). Merge
one at a time and re-fetch before each.
