# Tacet stock-movement schema — warehouse → store deliveries, plan and rulings

**2026-09-03 · DOCS ONLY. No code, no migration.** This records five rulings by Ash on the warehouse → store stock-movement design, the reasoning behind each, and their consequences for existing code. One question stays explicitly open. Mirrored into `docs/tacet-consolidation-decisions.md` §38.

**What this document is not.** It is not a schema migration and it does not ship a table. Where it names columns (`qty_sent`, `qty_received`, `is_counted`, `delivered_at`) it is describing the shape a later build must follow, not code that exists. The one table that already exists in this area — `restock_orders`/`restock_items` (`schema.sql:298-330`) — is a **kitchen-side, plain-`db` table**, not tenant-scoped, and is described below only as prior art and as the thing this plan's warehouse→store slice supersedes in behaviour (not necessarily in table identity — see §6).

---

## 0. The model in one paragraph

A warehouse dispatch and a store's count of what arrived are now two separate events, not one. **Dispatch moves stock at the warehouse the moment a picker sends it — honestly, uncapped, even below zero (§1).** The destination store's stock moves when a person counts the delivery, or — if nobody does — automatically at the end of that store's trading day, with the auto-settled lines marked as unverified forever (§2). **`delivered`** — the driver's own confirmation that he finished the leg — is kept, but it no longer triggers either of those two writes; it is a logistics fact, not a stock instruction (§5). The warehouse itself is just a `retail_stores` row, named per tenant through existing config (§3). And the new count column matches the type of the column it is compared against (§4).

---

## 1. RULING — a dispatch is never blocked by the record

**Decided by Ash, 2026-09-03.**

### The rule

If the warehouse's on-hand figure says 20 and the picker physically finds and sends 50, **the send goes through for 50.** The warehouse balance goes to −30. Nothing refuses the dispatch to protect a number that was already wrong.

### Why

His hands are right and the record is wrong. Blocking the dispatch stops real, physical work in order to defend a figure that reality has already contradicted. **−30 is an honest statement — at least 30 more units were physically at the warehouse than the system believed — and it is visible**, which the alternative (silently inventing 30 units so the arithmetic stays non-negative) is not.

### The bug this replaces

`lib/inventory.js:1078-1121`, `adjustStock()`'s delta path:

```js
// lib/inventory.js:1084
if (deltaQty != null) newPhysicalQty = Math.max(0, oldQty + deltaQty);
```

A warehouse→store transfer today calls `adjustStock` twice — once negative at the warehouse, once positive at the destination (`routes/restock.js`, `_applyRestockTransfer`, ledgered as `restock_transfer_out` / `restock_transfer_in`). If the warehouse's recorded balance is 20 and 50 are actually sent, the clamp floors the warehouse write at 0 (discarding the −30 that should have been recorded) while the destination still receives the full +50 it was told about. **A cleanly committed transaction just created 30 units of stock from nothing, and nothing anywhere says so.** This is not a side effect of the clamp; per `docs/tacet-stock-model.md` §6 ("Negative and missing"), which surveyed this exact code on 2026-07-30, the delta path already floors and **"the shortfall is silently discarded — asking to remove 5 from a shelf of 3 removes 3 and records a delta of −3, with no signal that 2 were unaccounted for."** That survey catalogued three different policies already live across the stock paths — go negative with no floor (order commit), clamp-and-forget (`adjustStock` delta), clamp-and-report (Meituan/Guanyi channel ingest) — and recommended clamp-and-report as the only lossless option of those three. Ash's ruling goes further than that recommendation for `adjustStock` specifically: rather than clamping and reporting the loss elsewhere, **keep the true number in the number itself.** Removing `Math.max(0, …)` is the fix, not a side effect of one.

### Consequence: the clamp comes out, and every caller needs to be re-judged individually

`adjustStock` is a shared primitive with roughly 18 call sites across POS/counter sale, Meituan sync, Eleme sync, Guanyi sync, waste, purchasing/receiving, and the warehouse↔store transfer itself. Removing the clamp changes behaviour for **all** of them at once, because none of them can lean on the clamp to protect them from a bad delta any more. **A negative balance is the right outcome for some of these callers and a real bug surfacing in the wrong place for others** — a transfer that goes negative because the paper count was wrong is exactly the case this ruling is written for; a POS sale that goes negative because two terminals raced for the last unit is a different problem that this ruling does not fix and must not be allowed to hide behind it.

### The clamp removal is narrower than "18 callers" suggests

`adjustStock` has two independent call shapes, and **the clamp at `lib/inventory.js:1084` only fires on one of them.** Pass `deltaQty` and the clamp applies (`Math.max(0, oldQty + deltaQty)`). Pass `newPhysicalQty` (an absolute target) and there is **no floor today, on either side of this change** — whatever the caller computes is written verbatim. Most of the channel-ingest callers (Meituan, Eleme, Guanyi, gzgrocery) already compute their own `Math.max(0, oldQty - took)` in JavaScript and pass the *result* in as `newPhysicalQty`. **Deleting line 1084 does not touch those callers at all** — they clamp themselves, before `adjustStock` ever sees the number, and will go on clamping themselves unchanged. Making them honest too would be a second, separate, deliberate edit to each of those call sites, not a consequence of this ruling. That distinction is the spine of the survey below.

### Caller-by-caller survey

| # | Call site | Trigger | Shape | Pre-flight guard today | Reached by this clamp removal? | Judgment |
|---|---|---|---|---|---|---|
| 1 | `routes/retail-inventory.js:343` | Admin Quick Stock grid / kitchen page — delta add | `deltaQty` | None — sign isn't restricted server-side; UI is trusted to send only `+N` | **Yes** | (b) Needs a guard, mildly. Nothing stops a negative delta reaching this unguarded once the clamp is gone. Low real-world exposure (UI never sends negative today), but add an explicit `d < 0` rejection, or a documented ruling that a kitchen delta may legitimately go negative as a correction, before shipping. |
| 2 | `routes/retail-inventory.js:351` | Admin Quick Stock grid — absolute recount | `newPhysicalQty` | None (`<input min="0">` is UI-only) | No (absolute path was already unfloored) | (a) Unaffected either way; this is the honest-recount case already. Worth a server-side `< 0` typo guard, independent of this ruling. |
| 3 | `routes/products.js:601` | Kitchen legacy stock-adjust (`set_to` / `delta`) | Both, but caller pre-clamps/rejects before calling `adjustStock`: `set_to < 0` rejected outright; `delta` pre-resolved to `Math.max(0, oldQty + d)` and passed as `newPhysicalQty` | Caller-side clamp/reject | No | Unaffected by this change. If uniform "let it go negative" is ever wanted here too, this file's own guards are the thing that would need editing — flagged as a companion change, not part of this ruling. |
| 4 | `routes/eleme-internal.js:486` | Eleme order ingest, per-line deduction | `newPhysicalQty: Math.max(0, oldQ − took)` | Caller-side clamp, no availability pre-check | No | (b) An Eleme oversell is closer to "a race/stale-push problem to catch" than "an honest signal" — but it's self-clamped today and stays clamped after this ruling ships, unless separately edited. Flag as a deliberate follow-on decision, not silently swept in. |
| 5 | `routes/eleme-internal.js:670` | Eleme order void → restock | `newPhysicalQty: stock + qty` (always up) | N/A | No | (a) N/A, never negative. |
| 6 | `routes/eleme-internal.js:689` | Eleme un-void → re-deduct | `newPhysicalQty: Math.max(0, stock − qty)` | Caller-side clamp | No | Same as #4. |
| 7 | `routes/retail-waste.js:452` | Waste write-off | `deltaQty: −qty` | **Yes** — explicit pre-flight check inside the same transaction, `throw insufficient_stock` if `qty > onHand`; comment states outright *"REFUSE, DO NOT CLAMP… this does not fix adjustStock, it stops depending on it being wrong."* | Yes, but already guarded | (a) Already can't go negative; this is the pattern to copy for any other `deltaQty` caller that needs one. |
| 8 | `routes/retail-waste.js:582` | Waste void → restore | `deltaQty: +qty` | N/A | Yes | (a) N/A, never negative. |
| 9 | `routes/meituan-internal.js:536` | Meituan order ingest, per-line deduction | `newPhysicalQty: Math.max(0, oldQ − took)`, comment: *"a Meituan oversell shouldn't drive us negative"*; shortfall separately logged to an `oversold[]` list rather than lost | Caller-side clamp + explicit oversell reporting (best-behaved of the group per `docs/tacet-stock-model.md`) | No | (b) Deliberate existing policy, orthogonal to this ruling. Unaffected unless the policy itself is revisited. |
| 10 | `routes/meituan-internal.js:835` | Meituan order void → restock | `newPhysicalQty: stock + qty` | N/A | No | (a) N/A. |
| 11 | `routes/meituan-internal.js:853` | Meituan un-void → re-deduct | `newPhysicalQty: Math.max(0, stock − qty)` | Caller-side clamp | No | Same as #4/#9. |
| 12 | `routes/restock.js:319` | **Warehouse→store transfer, warehouse leg** | `deltaQty: −qty` | **None.** No on-hand check anywhere before the call. | **Yes** | **(a) — this is the ruling's own motivating case.** A negative warehouse balance after this is exactly "the record said 20, only 20 or fewer were actually here, and now that's visible" (or the inverse — more were sent than recorded). No new guard needed; the point is to stop hiding it. A non-blocking "this transfer drove a store negative" flag on the response is worth adding as UX, not as a gate. |
| 13 | `routes/restock.js:325` | Transfer, destination leg | `deltaQty: +qty` | N/A | Yes | (a) N/A, never negative. |
| 14 | `routes/retail-purchasing.js:232` | PO receiving, `applyReceivedToStock` — delta = `good − alreadyApplied` | `deltaQty` | **Partial, and already a known, named exception**: a save that *increases* a returned qty is blocked pre-flight (`retail-purchasing.js:2506-2509`); a save that only *lowers* an arrived count reaches `adjustStock` unguarded — an existing comment (lines 296-298, 411-413) and `docs/purchase-returns.md:103-106,206-210` both call this out as deliberately left alone, future work. | **Yes** | **(b) — the one call site where this ruling changes behaviour the team has already, separately, said it does not want changed yet.** Needs either its own local guard before the global clamp goes, or this ruling becomes the trigger to finally land the `docs/purchase-returns.md` fix at the same time. Flag prominently in sequencing. |
| 15 | `routes/retail-purchasing.js:366` | PO receipt reversal (`reversePOStock`) | `deltaQty: −qty` | **Yes** — `planPOReversal` computes shortfall inside the same transaction and refuses the whole op if short; also asserts `delta !== −qty` post-call and throws `reversal_clamped` if the (soon-gone) clamp ever bit | Yes, but already guarded | (a) Never reaches negative today; the post-call assertion becomes dead-but-harmless once the clamp is gone. |
| 16 | `routes/guanyi-admin.js:358` | Operator confirms a flagged Guanyi pickup → decrement | `newPhysicalQty: Math.max(0, cur − inferred)` | Caller-side clamp only | No | (b) Self-clamped today, unaffected unless edited — but worth a second look on its own merits: an operator confirming a real physical pickup is closer to the "honest signal" case (§1's rationale) than an automated channel oversell is. A candidate for its own future ruling, not swept into this one. |
| 17 | `scripts/guanyi-daemon.js:592` | Guanyi pickup-drift daemon, unattended | `newPhysicalQty: Math.max(0, tianhe_qty − pickup)`, logs `(CLAMPED at 0)` | Caller-side clamp + upstream cap + a "bad-read guard" (this repo already has a repair script for a −1,863-unit false-pickup incident) | No | (b) **Recommend leaving this caller's own clamp in place even after this ruling ships.** It is a headless daemon inferring loss from a scraped listing, already burned once by a bad read; letting a bad read go negative and read as a confirmed honest discrepancy is worse here than clamping and logging, precisely because no human is confirming a physical count. |
| 18 | `scripts/gzgrocery-order-daemon.js:495` | gzgrocery order ingest, per-line deduction | `newPhysicalQty: Math.max(0, cur − qty)` | Caller-side clamp only | No | (b) Same reasoning as #4 — self-clamped, unaffected unless edited; an unattended-polling oversell reads closer to "problem" than "signal." |
| 19 | `scripts/gzgrocery-order-daemon.js:522` | gzgrocery order void → reverse | `newPhysicalQty: cur + qty` | N/A | No | (a) N/A. |
| 20 | `scripts/repair_guanyi_false_pickup.js:50` | One-off repair for the 2026-06-27 bad-read incident | `newPhysicalQty: cur + back` | N/A | No | (a) N/A, historical/one-off. |
| 21–24 | `scripts/test_preorder_park.js:220,253,320,327` | Test harness | Reset to 0 / positive deltas only | N/A | Yes (deltaQty), but always non-negative in these tests | (a) N/A. |

**Not a caller, but the same surface**: `routes/retail.js`'s order-commit paths (`commitOrderReservations`, `commitUnreservedOrder`) never went through `adjustStock` or its clamp at all — `commitUnreservedOrder` in particular already has **no floor and no availability check today** (per `docs/tacet-stock-model.md` finding 4). Unaffected by this ruling, but the same "physical_qty went negative" surface, and worth a cross-reference so a later reader doesn't assume this ruling covers every negative-stock path in the app.

### Reading the survey

Of the ~20 real call sites, **only five are actually touched by deleting `lib/inventory.js:1084`**: the kitchen Quick Stock delta (#1, needs a small guard), the two waste calls (#7 already guarded, #8 N/A), the warehouse→store transfer (#12/#13 — the ruling's own motivating case, wants no guard), the PO-receiving downward correction (#14 — a **known, already-documented exception** the team previously chose to leave alone, and the one place this ruling picks that decision back up), and the PO reversal (#15, already guarded). Every channel-ingest caller (Eleme, Meituan, Guanyi, gzgrocery — #4/#6/#9/#11/#16/#18) computes its own clamp in JavaScript before ever calling `adjustStock`, and stays exactly as clamped as it is today unless someone separately decides to edit each of those sites too — that is real follow-on work this ruling exposes but does not itself require.

**Also found, requested by Ash**: a concrete UI gap that the visibility requirement below exists to close — see there for the citation and the fix.

### Sequencing implication

The clamp does not come out as a single one-line change with the other seventeen-odd callers along for the ride — most of them are not on the path it protects. What actually has to land together: (1) delete the `deltaQty` clamp at `lib/inventory.js:1084`; (2) add the small guard to caller #1; (3) resolve caller #14 — either a local guard or finally landing the `docs/purchase-returns.md` fix; (4) fix the dashboard's `out_of_stock` query. Callers #7/#8/#12/#13/#15 need nothing further; they are already correct under the new rule or already guarded. The channel-ingest callers (#4/#6/#9/#11/#16/#18) are explicitly **out of scope** for this pass — each keeping its own clamp is a valid, separate policy choice (per-channel, not uniform), and #17 in particular should keep its clamp on purpose, not by oversight. This is implementation-phase sequencing; this document fixes the destination and names what still needs a decision, not the code itself.

### The visibility requirement

A negative on-hand is only an honest signal if a person can actually see it, and the survey above already found a concrete place where it would not be: the admin dashboard's "Needs you" panel (`routes/retail.js:15248-15280`) queries `low` as `physical_qty > 0 AND physical_qty <= threshold` and `out_of_stock` as `physical_qty = 0`. **A negative balance matches neither clause and disappears from both cards** — worse than being shown wrong, it is shown nowhere. That query needs to become `physical_qty <= 0` for `out_of_stock` at minimum, as part of this ruling, not left for later.

Elsewhere the picture is mixed. The per-store stock grid (`public/retail-admin/09-products.js`, the editable stock cell a "Save stock" PATCH writes through) already renders `physical_qty` as a plain signed number — a −30 would show as −30, not as a clamped 0 — so the raw figure is not hidden from someone who opens that screen. But the higher-level "in stock / low / out" badges (`_paUnitStock`, `public/retail-admin/09-products.js:792-797`, summed via `Number(m.effective_stock) || 0`) collapse **zero** and **negative** into the same "out of stock" state. **This is a gap the ruling explicitly requires closing**: a negative balance needs a surface a person looks at without already knowing to go hunting for it — at minimum, the "out of stock" treatment must not read identically for a genuine zero and for a −30 that says the record itself is wrong. Beyond the dashboard query fix above, the exact surface (a distinct badge state, a report row) is implementation-phase; the requirement — negative on-hand must be visible somewhere a person looks, not only true in the database — is decided.

---

## 2. RULING — abandoned counts auto-settle at end of the trading day

**Decided by Ash, 2026-09-03. Conditional on the safeguard below.**

### The rule

A delivery that was part-counted and left open closes automatically at the end of the trading day it arrived on:

- **Counted lines land at the counted quantity.** Nothing changes for them.
- **Uncounted lines land at the sent quantity.** The goods are physically on the shelf whether or not anyone confirmed the count; leaving them out of the record would have the store selling stock the system believes it does not have.
- **Uncounted lines are marked as not counted, permanently.** An auto-settled line must never become indistinguishable from a line a person actually verified. If a discrepancy surfaces later, it must be possible to see which numbers a person checked and which the system assumed on the store's behalf.
- **End of trading day, not a rolling timer.** A fixed-duration timer fires at 8pm one day and 2am the next depending on when the delivery arrived; end-of-day is predictable and matches how a shop already thinks about "today's business."
- **The store is told the next morning, and so is the warehouse** — the warehouse needs to know because an auto-settle changes what an *unreported* discrepancy on that delivery means going forward (it is no longer "nobody has looked yet," it is "nobody looked, and the system guessed").
- **Any line stays correctable afterwards**, as an ordinary stock correction through the existing adjustment path. Auto-settling stops a delivery hanging open indefinitely; it is not a final, unchangeable number.

### Why a timer and not a button

Record this honestly rather than dressing it up: **this is a global accept, automated, with a timer standing in for a button a person would otherwise have to press.** A "mark the rest as sent" button was considered and rejected — it would become the fast path on the busiest days, exactly when an under-count is most likely and least likely to get caught, because it turns "I didn't have time to count" into a single tap that looks identical to a genuine reconciliation. **The timer is defensible only because it (a) catches genuinely abandoned counts rather than being reached for on purpose, and (b) leaves a permanent mark that distinguishes what it did from a real count.** Strip either property away and it degrades into the same shortcut the button was rejected for.

### MANDATORY SAFEGUARD — this ruling is conditional on it

**Repeated auto-settling at one store must surface somewhere a person actually looks.** One abandoned count in a fortnight is a busy Tuesday. Four is a store that has stopped counting deliveries, and nobody currently finds that out except by noticing stock keeps drifting. Without a surfaced repeat-offender signal, the timer stops being a safety net for a rare miss and becomes the store's normal way of receiving — which is precisely the failure mode the rejected button was rejected for, arrived at by a different door. **This safeguard is not optional polish on top of the ruling; the ruling does not stand without it.** The exact surface (a per-store counter on the warehouse dashboard, a weekly digest, an alert past a threshold) is implementation-phase; that a repeat-offender count exists and is shown to a person is decided.

### What the auto-settle job is

A per-tenant sweep that, once per trading day per tenant, finds every warehouse→store delivery still open past that store's day boundary and closes each open line per the rule above (counted → counted qty; uncounted → sent qty, flagged `is_counted = 0` / an equivalent permanent "auto-settled" marker), then notifies the store and the warehouse. It is a level-triggered job in the vocabulary `docs/tacet-stock-model.md` uses (§ terms) — it compares state against a boundary and fixes the difference, rather than reacting to a single event — which matters because a missed tick (a restart, a slow deploy) must not mean a delivery from three days ago sits open forever; the next tick still finds it and closes it against the day boundary it should have closed on.

### What schedules it — and why "every 24 hours" is the wrong shape

The codebase's existing scheduling primitive is a bare `setInterval` armed at process start (`docs/tacet-write-surface.md` §, "every `setInterval(` in `server.js`, `lib/` and `routes/`"). The one existing daily-cadence precedent, `startBillingScheduler()` in `lib/billing-lifecycle.js:143-154`, is exactly this shape — `setInterval(tick, 24 * 60 * 60 * 1000)` from a `setTimeout(tick, 60_000)` first run — and it is a cautionary example, not a template: it fires 24 hours after whenever the process last booted, with no anchor to any wall-clock instant, and per `docs/tacet-write-surface.md` it is also never started at all (`startBillingScheduler` is exported and called from nowhere). A fixed-interval timer anchored to boot time is precisely the "8pm one day, 2am the next" problem this ruling names and rejects. **The auto-settle job needs to compute the next occurrence of each tenant's trading-day-end instant and schedule to that instant specifically**, then recompute and reschedule after each run — not run on a bare interval. A frequent, cheap poll (e.g. every few minutes, checking "has any tenant crossed its boundary since the last tick") is a simpler and more restart-safe way to get the same effect without hand-rolling per-tenant wake-up scheduling, and is closer in shape to the existing reservation sweeper (`sweepExpiredReservations`, `lib/inventory.js:1166+`) than to `startBillingScheduler`.

### How it behaves per tenant — and why it cannot simply read `retail_stores`

Tenants keep different trading days and different timezones, so "end of day" cannot be one constant. The obvious source would be `retail_stores.open_time` / `close_time` / `timezone`, which already exist — but they are **not reliable enough to hang this job on directly**:

- **`open_time` / `close_time`** (`database.js:3231-3232`) are free-text `'HH:MM'`, captured only by the Add-location wizard, and are optional: `lib/store-hours.js:79-84` treats a store with either unset, or with `close` not strictly after `open`, as **"not configured"** and falls back to *always open* — the codebase's own handling of these columns assumes they are frequently absent, not that every store has them.
- **`timezone`** (`database.js:3236`) is written by exactly one place in the whole app — the setup-guide wizard (`public/retail-admin/17-setup-guide.js`), which defaults it to `Asia/Shanghai` — and `lib/inventory.js`'s own `listStores()` (the query every admin screen loads stores through) **omits the column entirely**, so most of the admin surface cannot see it even where it is set. `docs/tacet-multibusiness-audit.md` finding 7 calls this "half-wired," and its §8 goes further: **"No reporting, settlement, cut-off or day-boundary calculation currently reads a per-location time zone… This supports the decision that the business day is business-wide, not per location… The per-location `timezone` column has exactly one honest job — validating a collection time against the shop's own clock — and it should be allowed to keep it."**

That is a standing precedent this plan should not contradict without a reason, and there isn't one here: a per-*store* day boundary for auto-settle would mean deriving a cutover from a field that is routinely null, silently falls back to "always open" when it's wrong rather than erroring, and is invisible on the very admin screens a warehouse operator uses. **The auto-settle boundary should be per-tenant, not per-store** — one configured trading-day-end instant (and zone) per tenant, read the same way Ruling 3 reads the warehouse id: a `storefront_config` key via `cfgValue()`, e.g. `stock.tradingDayEnd` (a fallback such as `23:00` in `Asia/Shanghai` when unset, mirroring `lib/business-date.js`'s existing `SYSTEM_DEFAULT_TZ` fallback pattern). A tenant with stores that genuinely keep different hours from each other is a real case this does not solve — it is noted as an open implementation question, not decided here, rather than quietly assumed away.

---

## 3. RULING — `storefront_config`, as is

**Decided by Ash, 2026-09-03.**

### The rule

The warehouse — which `retail_stores` row is "the" warehouse for a tenant — is configured through the existing `storefront_config` table, read via `cfgValue('stock.warehouseStoreId')`. **`storefront_config` is not renamed and no dedicated settings table is built for this.** It already works, it is already per-tenant, and renaming a live config store mid-build is a gratuitous risk for a naming preference. The name `storefront_config` is a poor fit for a warehouse-identity setting that has nothing to do with the storefront — **that mismatch is recorded here as a known, deliberate debt**, not fixed now.

### Why this, and not the one dead alternative already in the codebase

A `restock.warehouseStoreId` key already exists — on the **kitchen-side, plain-`db` `settings` table**, read at `routes/restock.js:164-170`. It is dead: no `settings` table exists in the live schema (`docs/tacet-consolidation-decisions.md` and `docs/tacet-locations-survey.md` both record this), the read always falls through its own `catch`, and nothing anywhere writes the key. It has never had any effect. **`stock.warehouseStoreId` on `storefront_config` is a genuinely working replacement for a setting that has only ever existed as dead code**, not a second copy of a working one.

`cfgValue()` itself is small and already established (`routes/retail.js:8880-8884`):

```js
function cfgValue(key, fallback) {
  const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}
```

It is not currently exported from `routes/retail.js`, so wherever the warehouse-id read lands (`routes/retail-purchasing.js`, `routes/retail-inventory.js`, a new module) either needs its own copy of this four-line closure or a shared export — a small, implementation-phase decision, not a schema one.

### The tenant-handle requirement

`cfgValue()` already reads through `tdb()` — the tenant connection — not the raw/shared handle, so a request-scoped call is already tenant-safe by construction. **The risk is not in `cfgValue` itself; it is in any caller that runs outside a request's tenant scope** — a background daemon or scheduled sweep (exactly the shape the Ruling 2 auto-settle job takes) that isn't inside `tenantAls`'s scope would resolve `tdb()` to the wrong connection, or to the global one, and hand every tenant Roots' own warehouse. This is the same class of bug as the `:333` stamp: a shared handle read where a tenant-scoped one was required, silently returning the wrong tenant's data instead of erroring. **Any code that reads `stock.warehouseStoreId` — including the auto-settle sweep, which by its nature iterates every tenant rather than running inside one tenant's request — must explicitly enter that tenant's scope before calling `cfgValue`, never rely on an ambient scope that may not be there.**

---

## 4. RULING — `qty_received` is REAL

**Decided by Ash, 2026-09-03.**

### The rule

The new counted-quantity column is typed `REAL`, matching `qty_sent` (already `REAL` on `restock_items`, `schema.sql:324`) — the two columns that get compared against each other on the same line. **A column disagreeing in type with the one it is directly compared against is a worse defect than the wider REAL/INTEGER split in this schema, which is real, already known, and separate work.**

### The wider inconsistency, recorded as known debt (not fixed here)

Quantities are `REAL` all the way from the purchase order down to the warehouse's own request line — `po_line_items.qty` and `po_line_items.qty_received` (`database.js:212`, `addColumn('po_line_items', 'qty_received', 'REAL')`), `restock_items.qty_requested` and `qty_sent` (`schema.sql:323-324`) — and then land on `retail_store_stock.physical_qty`, a plain `INTEGER NOT NULL DEFAULT 0` (`database.js:3082`), with `retail_stock_ledger.delta` / `balance_after` also `INTEGER` (`database.js:3119,3123`). **This is not merely a type mismatch on paper — it already loses information in a live code path**: `routes/retail-purchasing.js:225-228`, applying a received PO line to store stock, rounds explicitly —

```js
// Whole units: retail_store_stock.physical_qty is an INTEGER, so both the
// applied bookkeeping and the delta are rounded the same way — repeated
// saves always converge instead of drifting on a fractional entry.
const good = Math.round(onHandQty(l) || 0);
```

— because a fractional receive (2.5 kg, say) cannot land on an integer shelf count without rounding somewhere. `qty_received` on the new counted-delivery lines inherits exactly this seam: it will be `REAL` (matching `qty_sent`) while whatever it ultimately writes to `retail_store_stock.physical_qty` still rounds at that boundary, the same way PO receiving already does. **This document does not resolve the REAL/INTEGER boundary** — that is wider than this schema and is separate work — it only makes sure the one new column does not add a second, narrower version of the same disagreement between two columns that are read side by side on one line.

---

## 5. RULING — `delivered` stays

**Decided by Ash, 2026-09-03.**

### The rule

The `delivered` status/timestamp on a warehouse→store movement is kept, even though it stops being the thing that moves stock.

### What it means today, and what it means after this plan

Today, on the existing kitchen-side `restock_orders`, the real stock transfer already happens at `prepared` — `routes/restock.js` calls `_applyRestockTransfer` on the `prepared` → and again, idempotently, on the `delivered` transition, guarded by `stock_applied_at` so the second call is a confirmed no-op (`routes/restock.js:274,333`). So `delivered` is **already** not the trigger for the stock write in the current code, even though the status exists right next to one.

Under Rulings 1 and 2, stock movement happens at two different moments that are neither of them `delivered`: the warehouse side moves at **dispatch** (Ruling 1, uncapped), and the store side moves at **count, or auto-settle at day's end** (Ruling 2). `delivered` — the driver confirming he physically finished the leg — sits between those two and drives neither. **It still records a true, distinct fact once it stops carrying stock meaning**: at Roots today, delivery and counting happen close enough together that the distinction is barely visible in practice — the driver hands it over and someone counts it more or less on the spot. On a longer route, or a tenant whose warehouse serves stores across town rather than across a counter, the two are genuinely different instants, and only one of them is "how long did this delivery sit un-counted after it physically arrived" — a question `delivered_at` still answers and nothing else does. **Keep it, and document that its job changed**: it used to (nominally) gate a stock write; now it is a pure logistics timestamp, useful for exactly the question above and for nothing that writes to `retail_store_stock`.

---

## 6. STILL OPEN — do not guess: one recipe, more than one sellable product

Ash has indicated a recipe/batch can plausibly produce more than one distinct sellable product — a roast yielding both a whole-cut product and a byproduct sold separately, for instance — but **the exact shape of that is not confirmed, and this document does not guess at it.**

### What is settled, and what is not

Today a product's link to a recipe is `store_products.recipe_id` (`docs/tacet-product-build-lines-design.md`) — one column, one recipe per product, and per §29 of the consolidation decisions, **"Recipes are not connected to retail Products in this phase"** at the shared-core level even where that link already exists on the Roots side. That is a single scalar reference. It cannot express "this one batch produced 8 of product A and 3 of product B in a split that isn't fixed batch to batch" — there is nowhere to put the second product, let alone the split.

### What this means for scoping — stated plainly, not left implicit

If one batch can genuinely yield several products in a split that varies each time it is made, **a batch record needs to say which products it produced and how many of each — that is a link table (batch → {product, qty}, one row per product per batch), not a column on anything that exists today.** And critically, **the split cannot be inferred** — nothing about a recipe or a batch tells Tacet in advance how a given cook divided the output between products, so **the person logging the batch has to type the split themselves**, the same way a restock's `qty_sent` or a delivery's `qty_received` is typed by a person rather than computed.

That makes production wiring for multi-output batches genuinely larger than "add a column": it needs its own link table, its own entry UI, and it sits **behind** the recipe-to-product mapping question §29 already left open (the lifecycle of an implied materials row) rather than beside it. It stays separate, explicit prerequisite work, not folded into this stock-movement plan.

---

## 7. Related documents

- `docs/tacet-consolidation-decisions.md` §38 — these five rulings, mirrored into the decisions record.
- `docs/tacet-stock-model.md` — the 2026-07-30 survey of `retail_store_stock` / `retail_stock_ledger` / `lib/inventory.js` that Ruling 1's clamp-removal reasoning builds on directly (§5 "adjustStock and upsertStockLayer", §6 "Negative and missing").
- `docs/tacet-multibusiness-audit.md` — finding 7 and §8, the existing survey of `retail_stores.open_time/close_time/timezone` that Ruling 2's per-tenant (not per-store) day-boundary reasoning relies on.
- `docs/tacet-write-surface.md` — the `setInterval` scheduler inventory, including `startBillingScheduler`'s dark, boot-anchored daily timer, cited in Ruling 2 as the shape the auto-settle job must not copy.
- `docs/tacet-product-build-lines-design.md` — the `store_products.recipe_id` / build-line design that §6's open question sits behind.
- `docs/tacet-glossary.md` — binding definitions, including WAREHOUSE ("not a type. A physical location with no sales channel attached").
- `lib/business-date.js`, `lib/store-hours.js` — the existing per-location date/hours helpers, cited for their fallback-default pattern (`SYSTEM_DEFAULT_TZ`, "not configured ⇒ always open") that Ruling 2's tenant-level default should mirror.
