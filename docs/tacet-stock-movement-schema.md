# Tacet stock movement — schema survey and migration plan

**v1.0 · 2026-09-03 · SURVEY AND PROPOSAL ONLY. No code has been written, no migration exists, no schema has changed.** This document answers the seven unknowns in the stock-movement brief and proposes the schema that would satisfy `docs/tacet-consolidation-decisions.md` §39. It is a plan to be reviewed, not a description of the product. Where the survey contradicts the brief it was written from, it says so and quotes the code.

Constraints taken as binding: **SQLite stays** (§24 — the Postgres migration is cancelled, and nothing here is deferred pending it); **every stock write goes through `lib/inventory.js` `adjustStock`** — no new direct writers; **everything must work on a tenant database**, not only Roots; **the markets / `retail_stores` split is out of scope** and is not touched anywhere below.

---

# PART A — SURVEY

## A0. Four findings that change the shape of the work

These came out of the survey rather than the brief, and two of them are live defects rather than gaps. They are stated first because B is built around them.

**A0.1 — `adjustStock` cannot record what a movement was for.** `lib/inventory.js:1066` takes `{ storeId, productId, newPhysicalQty, deltaQty, actorUserId, actorLabel, note, reason }` and hardcodes the ledger's provenance columns:

```js
INSERT INTO retail_stock_ledger
  (store_id, product_id, delta, reason, ref_table, ref_id, balance_after, actor_user_id, actor_label, note)
VALUES (?, ?, ?, ?, 'retail_store_stock', NULL, ?, ?, ?, ?)
```

`ref_table` is always the literal `'retail_store_stock'` and **`ref_id` is always NULL**, even though `retail_stock_ledger` declares both columns for exactly this purpose (`database.js:3112-3113`) and carries `idx_retail_ledger_ref ON (ref_table, ref_id)` — an index over a column nothing ever fills. The only link from a ledger row back to a restock order today is the free-text `note`, which `routes/restock.js:352` sets to `o.rs_number || ('RS#' + o.id)`.

**This matters far more under two steps than one.** With both halves inside one transaction, provenance was recoverable by inspection. With the halves hours apart, "has the OUT half for this transfer already been written?" becomes a question the system must answer from the ledger, and it currently cannot ask it except by string-matching a note.

**A0.2 — the zero clamp silently creates units.** Same function:

```js
if (deltaQty != null) newPhysicalQty = Math.max(0, oldQty + deltaQty);
```

Dispatching 50 from a warehouse holding 20 writes a delta of −20, not −50, and returns without error. Under the current one-step model the IN half then adds the full 50 and 30 units are created from nothing, inside a transaction that commits cleanly. Under the two-step model the OUT half is where the clamp bites and the IN half arrives hours later at the counted quantity, so the same 30 units still appear — with nothing on screen and nothing in the ledger saying so. **This is a live defect today, not one the new model introduces**, but the new model makes it harder to spot.

**A0.3 — quantities change type across the boundary.** `restock_items.qty_requested` and `qty_sent` are `REAL` (`schema.sql:330-331`). `retail_store_stock.physical_qty`, `retail_stock_ledger.delta` and `retail_stock_ledger.balance_after` are all `INTEGER` (`database.js:3073`, `3110`, `3114`). A restock line of 2.5 is accepted by the request and lands in SQLite's integer columns without complaint — SQLite applies INTEGER affinity and stores 2.5 as 2.5 anyway, because affinity is not a constraint. So the columns claim integer, the data may be fractional, and any reader that assumes integers is wrong. **Whichever way this is settled it must be settled deliberately** — see Q4.

**A0.4 — `data/roots.db` in this checkout is not live Roots data.** It holds **0 `restock_orders`, 0 `restock_items`, 0 `recipes`, 0 `production_batches`, 2 `store_products`** (both with `recipe_id` NULL), and four `retail_stores` of which two are fixtures (`tbt-warehouse`, `tbt-near`). There is no `tenants` table and `data/tenants/` does not exist. **A6 therefore cannot be answered from this repository** — see A6 for what that means for the migration.

---

## A1. Status lifecycle — the brief's reading is correct

`routes/restock.js:155`:

```js
const STATUS_FLOW = ['draft', 'sent', 'received', 'prepared', 'delivered'];
```

**Confirmed: `sent` and `received` describe the REQUEST, not the goods.** `sent` is the store submitting its request; `received` is the warehouse acknowledging it has the request. `public/kitchen.html:1238` is the clearest evidence — `const canCheck = o.status === 'sent' || o.status === 'received';` — the warehouse can only tick items off *while the order is in those two states*, which is only coherent if the goods have not moved yet.

The goods-bearing transitions are `prepared` and `delivered`, and the file's own comment (`routes/restock.js:159`) says so: *"status → 'prepared', the moment stock actually leaves the shelf"*.

**Timestamp columns that already exist on `restock_orders`** (`schema.sql:307-311`, all `DATETIME`, all nullable):

| Column | Set at |
|---|---|
| `created_at` | insert, `DEFAULT CURRENT_TIMESTAMP` |
| `sent_at` | transition to `sent` |
| `received_at` | transition to `received` |
| `prepared_at` | transition to `prepared` |
| `delivered_at` | transition to `delivered` |

Plus, added by migration in `database.js`: `archived_at` (826), `stock_applied_at` (832), and the direction columns `from_role` / `to_role` / `purpose` (816-821).

**What fires at each transition today** — all from the single handler at `routes/restock.js:694-733`:

| Transition | Timestamp | Stock | Push / SSE | Notes |
|---|---|---|---|---|
| → `sent` | `sent_at` | none | `_fireRestockPush` + `_broadcastRestock` | |
| → `received` | `received_at` | none | **none** — "internal warehouse state" (line 720) | |
| → `prepared` | `prepared_at` | **`_applyRestockTransfer`** — both halves, one transaction | push + broadcast | the real movement |
| → `delivered` | `delivered_at` | `_applyRestockTransfer` again — no-op via `stock_applied_at` | push + broadcast | "safety net" (line 712) |

Two properties of the handler that constrain B1. `toIdx <= fromIdx` is rejected outright (line 702), so **the flow is strictly forward and cannot skip backward** — but it *can* skip forward, e.g. `sent` → `delivered` directly, and that path fires the transfer with `prepared_at` left NULL. And a single `tsCol` map (line 705) means one status writes exactly one timestamp.

---

## A2. `restock_items` — full column list

From `schema.sql:323-337`. No migration adds columns to this table anywhere in `database.js`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `restock_id` | INTEGER | NOT NULL | FK → `restock_orders(id)` ON DELETE CASCADE |
| `product_id` | INTEGER | nullable | FK → `products(id)` — **a KITCHEN products id, see below** |
| `product_name` | TEXT | NOT NULL | snapshot |
| `product_cn` | TEXT | nullable | snapshot |
| `sku` | TEXT | nullable | snapshot |
| `qty_requested` | REAL | NOT NULL | **what the store asked for** |
| `qty_sent` | REAL | **nullable** | **what the warehouse actually allocated** |
| `unit` | TEXT | nullable | |
| `notes` | TEXT | nullable | |
| `is_checked` | INTEGER | DEFAULT 0 | warehouse tick-off, picking progress only |

**`qty_requested` and `qty_sent` both exist and mean what the brief expects.** `qty_sent` is nullable and the transfer treats NULL as "the warehouse did not override, so send what was asked": `routes/restock.js:326`, `const qty = (it.qty_sent != null) ? Number(it.qty_sent) : Number(it.qty_requested);`. That NULL-means-fallback convention is load-bearing and is preserved in B2.

**There is nothing resembling `qty_received`.** No column, no side table, no JSON blob. The received quantity has nowhere to go today, which is the single biggest gap between the schema and §39.

**A trap that the new column must not repeat.** `restock_items.product_id` is a *kitchen* `products.id`, while every table the transfer writes is keyed on `store_products.id`. `routes/restock.js:237-250` documents this at length: the two tables are separate AUTOINCREMENT counters over one integer space, the FK is satisfied either way, and a mismatched id silently moves the wrong product's stock. `_checkTransferIds` (line 251) exists solely to refuse a transfer where any line fails that check. **Any receipt path must run the same check**, and B8 says where.

---

## A3. Idempotency — one stamp is not enough, and nothing outside the tests reads it

`stock_applied_at` is added at `database.js:832` and its comment describes exactly one event: *"stamped the first time a restock_orders row transitions to 'delivered' and we apply the order's items"*. It is read in exactly three places in `routes/restock.js` — the guard at 306, the write at 370, and the doc comments — and **nowhere else in any route, page, script or daemon**. Outside `routes/restock.js` the only references in the entire repository are in the two test suites (`scripts/test_restock_tenant_handle.js`, `scripts/test_restock_tenant2_split.js`) and in `database.js` itself.

**So it can be replaced without breaking a reader.** It cannot simply be split, though, because it currently guards a *pair* of writes; under two steps each half needs its own guard, and the guards must be independent — the OUT half succeeding must never imply the IN half has run.

Proposal in B2: **two nullable stamps, `dispatched_at` and `received_confirmed_at`**, and `stock_applied_at` retained but frozen (see B8 for why it is not dropped).

---

## A4. Configuration — a working mechanism exists; do not build a second one

**The brief is correct that `settings` does not exist.** `routes/restock.js:186` queries `SELECT value FROM settings WHERE key = 'restock.warehouseStoreId'`, there is no `CREATE TABLE ... settings` anywhere in `schema.sql` or `database.js`, and the file's own comment (lines 179-184) already records that this lookup always throws and falls through. It is the only reader of that table in the repository.

**The working mechanism is `storefront_config`**, created at `database.js:1704`:

```sql
CREATE TABLE IF NOT EXISTS storefront_config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by  INTEGER
);
```

Read through `cfgValue(key, fallback)` at `routes/retail.js:8802`, which resolves on `tdb()` and JSON-parses the value. It is **data-plane** — absent from `CONTROL_PLANE_TABLES` in `lib/tenant-db.js:90-95` — so it is cloned per tenant and each tenant carries its own values, which is exactly what a warehouse-location setting needs.

It is in live use: `data/roots.db` holds 31+ keys including `batch.schedule` (the blob `batchScheduleCfg()` reads), `inventory.lowStockThreshold`, `inventory.reservationTtlMinutes`, `fees.*`, `points.*`, `delivery.*`. The naming convention is `domain.camelCaseKey`.

**Recommendation: use `storefront_config`. Do not create a `settings` table.** Two keys, both holding a `retail_stores.id`:

- `stock.warehouseStoreId` — the location goods ship out of
- `production.outputStoreId` — where a logged batch lands (§39: per tenant, Roots points it at the warehouse)

The name `storefront_config` reads oddly for a warehouse setting, and that is a fair objection — but it is already the tenant's general key/value config store, holding `inventory.*` keys that have nothing to do with the storefront either. **Renaming it is a separate change and a much larger one.** Noted as Q1 rather than decided here.

---

## A5. Recipe → product — the mapping exists, is one-directional, and is not unique

**This is the piece the brief flagged as most likely missing. It is not missing, but it does not point the way production needs.**

What exists:

- **`store_products.recipe_id`** — a product → recipe pointer, populated by the one-off migration `store_products_recipe_link_v1` (`database.js:4560-4650`). Its rule is written out in the code rather than as an id list: a product is linked when two or more of {exact SKU, exact `name_en`, exact `name_cn`} agree, **exactly one** recipe qualifies, the recipe yields `costPerServing > 0`, and the product is not a sample size or multipack. Group-B pairs (one signal only — 36 of them, all SKU-only) are **deliberately left unlinked for Ash to confirm by hand**.
- **`products.recipe_id`** (`schema.sql:155`) — the kitchen-side equivalent, commented "linked recipe (for cost calc)". **The same migration explicitly refuses to use it as a signal** because the data is wrong: it cites kitchen product 23 "81% Hazel Chocolate Spread" pointing at recipe 46 "Pickle carrot（Do chua）", and concludes *"one bad row in four is not a signal"*.
- **`ingredients.source_recipe_id`** (`database.js:673`) — a made thing appearing as a material (§29, nested recipes). Different relationship, not a sellable-product link.
- No `product_recipes` join table exists. No `recipes.product_id` column exists.

**Three reasons this cannot carry production output as it stands:**

1. **The direction is wrong.** `production_batches.recipe_id` needs *recipe → product*; what exists is *product → recipe*. The reverse lookup is `SELECT id FROM store_products WHERE recipe_id = ?`.
2. **Nothing makes that reverse lookup single-valued.** There is no `UNIQUE` index on `store_products.recipe_id`. Two products legitimately made from one recipe — a 200g jar and a 500g jar — would both link to it, and the query returns two rows with nothing to choose between them.
3. **It is partial by design.** The migration leaves the 36 ambiguous pairs deliberately unlinked, so a recipe someone produces today may simply have no product.

There is also a unit problem underneath: a batch is `batches_made` × the recipe's `batch_size`, or `servings_made`. §39 wants a count of sellable units. `store_products_recipe_link_v1` asserts *"One serving is one sellable unit"*, but it asserts that only for the products it linked, and only to derive a cost.

**Verdict, plainly: the mapping is one-directional, non-unique and incomplete, and production-to-stock cannot be built on it as it stands.** B6 scopes the fix as its own piece of work, per the brief's instruction not to fold it in.

---

## A6. In-flight orders — cannot be answered from this repository

Queried `data/roots.db` directly:

```
restock_orders           0 rows
restock_items            0 rows
recipes                  0 rows
production_batches       0 rows
store_products           2 rows (both recipe_id NULL)
retail_stores            4 rows — tianhe, yuexiu, tbt-warehouse, tbt-near
```

There is no `tenants` table in this database and no `data/tenants/` directory, so no tenant database can be inspected either. **This checkout carries a development scaffold, not production data.**

**What this means for the migration, and it is not nothing:** the in-flight handling in B8 has to be written defensively rather than fitted to a known distribution. Specifically it must not assume that no order sits at `prepared`, that every `prepared` order has `stock_applied_at` set, or that `qty_sent` is populated. **Before the migration runs anywhere real, the counts in A6 must be re-taken against the actual production database** — that is a prerequisite step in B8, not an optional check. The query to run is recorded in B8.

---

## A7. Readers outside `routes/restock.js`

Grepped the whole repository for `stock_applied_at`, `restock_orders`, `restock_items` and `api/restock`.

**`stock_applied_at` — no production reader anywhere.** Only `scripts/test_restock_tenant_handle.js` (lines 123, 124, 131, 132, 153, 197, 198), `scripts/test_restock_tenant2_split.js` (79, 137, 167) and `database.js` (832, and a comment at 5971).

**`restock_orders` as a table:**

| File | Line | What it does | Breaks on a status change? |
|---|---|---|---|
| `routes/admin.js` | 108 | `{ tbl: 'restock_orders', col: 'created_by', label: 'restock' }` — a user-deletion sweep | No — status-blind |
| `routes/admin.js` | 248 | table name in a tenant-clone / reset list | No |
| `routes/ai.js` | 2491 | `restock_orders_total: cnt('SELECT COUNT(*) …')` — a bare count for the AI context | No |
| `database.js` | 816-832, 5946-5994 | the migrations themselves | No |
| `reference/roots_v1.html` | — | the archived v1 app | No — reference only, not served |

**Front ends that call `/api/restock`:** `public/app.html`, `public/kitchen.html`, `public/login.html`. `public/m.html` — the mobile app — **does not touch restock at all**, which contradicts the brief's expectation that the mobile app is a reader.

**Where the status literals actually live, and this is the exposure:**

- `public/kitchen.html:869` — `'received'` drives a row background colour
- `public/kitchen.html:1170-1172` — status pills for `sent` / `received` / `prepared`
- `public/kitchen.html:1213` — `o.status !== 'prepared'` gates a bulk-check affordance
- `public/kitchen.html:1238` — `const canCheck = o.status === 'sent' || o.status === 'received'`
- `public/kitchen.html:1247, 1249, 1283, 1296, 1314` — transition buttons and their guards
- `public/app.html:19190-19205, 19255, 19264, 19344` — the store-side and warehouse-side views, including `isWh && (status === 'received' || status === 'prepared')` gating the "Prepared 备货" column

**`public/app.html:18333`** is the one row-level reader of provenance: it renders a ledger line's `ref_table === 'restock_orders' && l.ref_id` as `RS #…`. **That branch is dead today** — per A0.1 `ref_id` is never written and `ref_table` is always `'retail_store_stock'`. Filling those columns (B4) would bring an existing, already-written UI affordance to life rather than requiring new front-end work.

**Conclusion for B1: every status reader is a front-end string comparison against the five existing values.** There is no server-side consumer to break. That is precisely why B1 refuses to redefine any of the five.

---

# PART B — PROPOSAL

## B1. Status model — keep the request lifecycle, add a goods lifecycle beside it

**Adopting the brief's starting proposal.** The survey supports it rather than contradicting it, for a reason worth stating: A7 shows that all five status values are consumed by front-end string equality in two large HTML files, and A1 shows the warehouse's own picking affordance is gated on `sent`/`received`. Redefining any existing value would silently change what a picker can do, in files with no tests over them.

```
REQUEST lifecycle   restock_orders.status       draft → sent → received → prepared → delivered
                    (unchanged, all five values keep their present meaning)

GOODS lifecycle     restock_orders.goods_state  none → in_transit → settled
                    (new column, new vocabulary, no overlap with the above)
```

- **`none`** — nothing has left the warehouse. Every existing row starts here.
- **`in_transit`** — the OUT half has been written. Units belong to no location.
- **`settled`** — the IN half has been written at the counted quantity. The transfer is closed.

**Which transition fires which half.** The outbound half moves from `prepared` — where it already is (A1) — and the inbound half fires on a **new, separate endpoint**, not on a status transition:

| Event | Request status | Goods state | Stock |
|---|---|---|---|
| warehouse packs | → `prepared` | `none` → `in_transit` | **OUT only**, at `qty_sent` |
| driver hands off | → `delivered` | unchanged | **none** — see below |
| store confirms receipt | unchanged | `in_transit` → `settled` | **IN only**, at `qty_received` |

**`delivered` stops moving stock, and that is the one behavioural change to an existing transition.** Today it re-runs `_applyRestockTransfer` as a "safety net" (`routes/restock.js:712`). Under two steps that net is wrong: `delivered` means the driver handed the boxes over, which is not the same event as someone counting them. It becomes a pure request-lifecycle transition. The safety net is not lost — it moves to the receipt endpoint's own idempotency guard (B2).

**Why a separate endpoint rather than a sixth status.** `receipt_confirmed` as a sixth `STATUS_FLOW` value was considered and rejected: `toIdx <= fromIdx` (line 702) makes the flow strictly ordered, so a store confirming receipt before the warehouse marked `delivered` would be refused — and at Roots the driver marking `delivered` and the store counting are genuinely concurrent. **A strictly-ordered request lifecycle cannot express two lifecycles that interleave.** That is the failure mode the brief names, arrived at from the other direction.

**The two lifecycles are readable apart** because they are two columns with disjoint vocabularies. No value of one can be mistaken for a value of the other.

---

## B2. Columns

All additions via the existing `addColumn()` helper in `database.js` — an idempotent `ALTER TABLE ADD COLUMN` — so nothing needs a table rebuild. All are nullable with no default, or defaulted where a backfill value is honest.

**`restock_items`**

| Column | Type | Null | Meaning |
|---|---|---|---|
| `qty_received` | `REAL` | **nullable, no default** | What the store counted. |

**NULL versus zero, which the brief is right to insist on:**

- **NULL = nobody has counted this line yet.** The line is outstanding. It is the state every line is in between dispatch and receipt, and the state a resumed count leaves untouched lines in (`Resume.dc.html` in the design set).
- **0 = someone counted, and found none.** A real observation with a real consequence: nothing lands on the shelf for that line and the whole dispatched quantity is a discrepancy.

Conflating them would make an uncounted delivery indistinguishable from a delivery that entirely failed to arrive — and `Main.dc.html`'s inactive `Confirm receipt` button, whose only explanation is "4 of 14 lines counted", is built directly on the distinction.

This mirrors `qty_sent`'s existing NULL-means-not-overridden convention (A2), which is why `REAL` rather than `INTEGER` — matching its neighbours matters more than being right about a type both of them already get wrong (A0.3, Q4).

**`restock_orders`**

| Column | Type | Null | Meaning |
|---|---|---|---|
| `goods_state` | `TEXT` | `DEFAULT 'none'` | `none` \| `in_transit` \| `settled` — B1 |
| `dispatched_at` | `DATETIME` | nullable | OUT half written. **The idempotency guard for the outbound half.** |
| `received_confirmed_at` | `DATETIME` | nullable | IN half written. **The idempotency guard for the inbound half.** |

`goods_state` is derivable from the two stamps and is stored anyway — it is the column every list query filters on, and a stored enum indexes where a `CASE` over two timestamps does not. The stamps remain the authority; `goods_state` is written in the same transaction and never independently.

**`stock_applied_at` is kept, and frozen.** No new code reads or writes it. It stays because it is the only record that a pre-migration order moved its stock under the old one-step model, and B8 uses it to decide what an in-flight order becomes. Its `database.js:827-832` comment gains a note saying it is historical.

**Nothing is added for the two yardsticks.** `qty_requested`, `qty_sent` and `qty_received` on one row are sufficient — see B5.

---

## B3. In-transit — derived, not stored

**Agreeing with the brief, and more strongly than it puts it.** In-transit is:

```sql
SELECT ri.product_id, SUM(COALESCE(ri.qty_sent, ri.qty_requested)) AS qty_in_transit
  FROM restock_items ri
  JOIN restock_orders ro ON ro.id = ri.restock_id
 WHERE ro.goods_state = 'in_transit'
   AND ri.product_id IS NOT NULL
 GROUP BY ri.product_id
```

A stored counter would be a third place a quantity lives, incremented by one code path and decremented by another hours later, with a crash between them leaving it wrong forever and nothing to reconcile it against. The derived form **cannot** disagree with the rows it is derived from.

Cost: one indexed join per read, over rows whose count is bounded by orders currently on a van — at Roots, single digits. `idx` on `restock_orders(goods_state)` is added with the column.

**No pseudo-location.** A `retail_stores` row called "In transit" was considered and rejected: it would appear in every store picker, every stock report and every channel-availability sweep, and `_resolveDestStoreId` (`routes/restock.js:230-233`) already falls back on "exactly one active store that isn't the warehouse" — a rule a phantom store silently breaks. §39 says in-transit stock belongs to **neither** location, and a row in the locations table is a location.

**Where in-transit is not derivable, and the honest limit:** if an order is edited after dispatch — a line deleted, a `qty_sent` changed — the derived total changes retroactively while the ledger's OUT rows do not. This is not a reason to store a counter; it is a reason to **refuse edits to `restock_items` once `goods_state != 'none'`**, which B8 includes as a guard.

---

## B4. Ledger — no new reasons, one real change

**Confirmed: `restock_transfer_out` and `restock_transfer_in` are sufficient.** They already name the two halves separately (`routes/restock.js:352`, `358`); the only thing that changes is that they are written hours apart. A reason names *what kind of movement this was*, and neither half's kind has changed. Inventing `restock_dispatch` / `restock_receipt` would orphan every existing row.

Checked against every reason in use: `restock`, `restock_transfer_out`, `restock_transfer_in`, `restock_undo` (`routes/retail-purchasing.js:369`), `waste`, `repack`, `undo_preparing`, `undo_fulfillment`, `qingyun_pickup`, `qingyun_dropoff`. No collision.

**The real change is provenance, and it is a prerequisite, not a nicety.** Per A0.1, `adjustStock` hardcodes `ref_table='retail_store_stock', ref_id=NULL`. **`adjustStock` must accept `refTable` and `refId` and write them**, defaulting to today's literals so no existing caller changes behaviour. Without it:

- the receipt path cannot verify from the ledger that the OUT half was written;
- a reconciliation between derived in-transit (B3) and the ledger is impossible;
- `public/app.html:18333`'s `RS #…` rendering stays dead.

This is a change to `lib/inventory.js`, which is the file the constraint "all stock writes go through the ledgered path" protects. It **widens the ledgered path's record-keeping without adding a writer**, which is the letter and the spirit of the constraint — but it is a change to shared inventory code and is flagged as such in B8's ordering.

**Also required here: A0.2's zero clamp.** `Math.max(0, oldQty + deltaQty)` must stop silently absorbing an over-decrement. Recommendation: `adjustStock` gains a `refuseNegative` option that **throws** rather than clamping, and the restock OUT half passes it — so a dispatch exceeding warehouse stock rolls the whole transfer back and reports it, exactly as `_checkTransferIds` failures already do. Defaulting it off leaves every other caller unchanged. **This is a behaviour change to a live path and needs Ash — see Q3.**

---

## B5. The two yardsticks — supported, with one arithmetic rule

Per line, after receipt:

| Gap | Computation | Owner |
|---|---|---|
| **counted vs sent** (the road) | `qty_received − COALESCE(qty_sent, qty_requested)` | transit |
| **counted vs asked** (the warehouse) | `qty_received − qty_requested` | allocation |
| *(allocation gap alone)* | `COALESCE(qty_sent, qty_requested) − qty_requested` | warehouse, visible before dispatch |

All three come off one row of `restock_items` with no joins and no aggregation. `Received.dc.html` renders exactly `asked 18 · sent 14 · counted 10` from `qty_requested`, `qty_sent`, `qty_received`.

**Can this disagree with the ledger? Only in one way, and it is closable.** The IN half writes `qty_received` and the OUT half writes `COALESCE(qty_sent, qty_requested)`, so:

- **counted vs sent is exactly the ledger's own arithmetic** — `ledger IN delta + ledger OUT delta` for that product and transfer equals the same number. Given B4's `ref_id`, this is checkable by query rather than by trust.
- **counted vs asked has no ledger counterpart**, because `qty_requested` never moves stock. It is a fact about the request, not about goods. It cannot disagree with the ledger because the ledger makes no claim about it.

**The rule that keeps them honest: the ledger is written from the same column the screen reads, in the same transaction, and neither is recomputed afterwards.** Concretely — the IN half's `deltaQty` must be `qty_received` read back from the row it just wrote, not a value carried in from the request body. Same discipline the OUT half already keeps with `qty_sent`.

**One case the columns do not cover**, and it should be named rather than discovered: a line dispatched but *absent* from the delivery entirely — not "counted zero", but never counted. `qty_received` stays NULL and the line never settles. Under B1 the order cannot reach `settled` while any line is NULL, which is correct (`Main.dc.html`'s inactive button says so) but means an abandoned count leaves an order stuck `in_transit` forever, holding phantom in-transit stock. **This needs a decision — Q2.**

---

## B6. Production — scoped separately, as the brief instructs

**Per A5, the recipe-to-product mapping does not exist in a usable form, so this is a prerequisite piece of work and not part of the stock-movement migration.** Scoped here, not planned in detail, and not to be started alongside B1-B5.

**Prerequisite P1 — a recipe → product link that is single-valued and explicit.** The options, for a separate brief to choose between:

- a `recipes.output_product_id` column (`store_products.id`), authored per recipe;
- a `UNIQUE` index on `store_products.recipe_id`, reusing what exists and declaring that one recipe makes at most one product;
- a `recipe_outputs` join table, if one recipe genuinely yields several products in one run.

The third is the only one that survives a recipe producing both a 200g and a 500g jar, and nothing in the survey tells us whether Roots does that. **That question is Ash's — Q5.**

**Prerequisite P2 — units.** `production_batches` records `batches_made` (a multiplier on `recipes.batch_size`) and `servings_made`. `store_products_recipe_link_v1` asserts one serving is one sellable unit, but only for the products it costed. Whether that holds generally is unestablished. Without it, "increment stock by N" has no N.

**Once P1 and P2 exist**, the production work itself is small and follows the shape B1-B5 establishes: logging a batch calls `adjustStock` at `cfgValue('production.outputStoreId')` with a new reason `production_output`, `refTable='production_batches'`, `refId` the batch id, guarded by a `stock_applied_at`-style stamp on `production_batches`. §39's "closes off the request that asked for it" is a second link — `production_batches` has no column pointing at the `restock_orders` row that prompted it — and is part of the same separate brief.

**Nothing in B1-B5 depends on any of this.** The two can ship in either order.

---

## B7. Warehouse and output location as real settings

Replace `_resolveWarehouseStoreId()`'s three tiers (`routes/restock.js:177-206`) with a single read:

```js
const id = cfgValue('stock.warehouseStoreId', null);
```

**Tier 1** (`settings` table) becomes this read — same intent, a table that exists.
**Tier 2** (a warehouse-role user's bound store) is dropped. It reaches across the control/data plane, taking a `retail_store_id` off control-plane `users` and using it as a tenant `retail_stores.id` — the file's own comment flags this at lines 190-193.
**Tier 3** (whichever store holds the most stock) is dropped, and the brief's objection is right: the day a second warehouse exists it silently picks whichever happens to be fuller, and nothing on any screen says a guess was made. It is also wrong *before* that day — a store that has just taken a large delivery can outweigh the warehouse.

**When the setting is unset, refuse and say so.** `_applyRestockTransfer` already has the shape for this — it returns `{ ok: false, error: … }` and `routes/restock.js:729` already puts that message in front of whoever pressed the button. The message names the setting rather than the failure.

`production.outputStoreId` is read the same way and defaults to nothing. §39 makes it per-tenant, and Roots' value happens to equal its warehouse — that is a value, not a default.

**Backfill on migration**, for tenants that never had a setting: if exactly one active `retail_stores` row has `code LIKE '%warehouse%'`, write it and log it. Otherwise write nothing and log that the tenant must set it before restock can move stock. **Never guess by stock volume, even once.**

---

## B8. Migration order and in-flight handling

**Step 0 — re-take A6 against the real database.** Per A6 this repository has no live data. Before anything runs:

```sql
SELECT status, goods_state_would_be, COUNT(*) FROM (
  SELECT status,
         CASE WHEN stock_applied_at IS NOT NULL THEN 'settled' ELSE 'none' END AS goods_state_would_be
    FROM restock_orders
) GROUP BY 1, 2;

SELECT COUNT(*) FROM restock_orders WHERE status IN ('prepared','delivered') AND stock_applied_at IS NULL;
SELECT COUNT(*) FROM restock_items WHERE qty_sent IS NULL;
```

The second query is the one that matters: an order at `prepared` or `delivered` whose stock never applied is the case the backfill cannot classify honestly.

**Step 1 — `lib/inventory.js`: `adjustStock` accepts and writes `refTable` / `refId`** (B4), defaulting to today's literals. Ships alone, changes no behaviour, is independently testable. **Everything else depends on it.**

**Step 2 — columns.** `addColumn()` for `qty_received`, `goods_state`, `dispatched_at`, `received_confirmed_at`, plus `CREATE INDEX idx_restock_goods_state ON restock_orders(goods_state)`. Pure additions; no rebuild; safe on a populated table.

**Step 3 — backfill `goods_state`**, guarded by `_migrations` (`database.js:192`, the established pattern):

| Existing row | `goods_state` | `dispatched_at` | `received_confirmed_at` | `qty_received` |
|---|---|---|---|---|
| `stock_applied_at` set | `settled` | ← `stock_applied_at` | ← `stock_applied_at` | **left NULL** |
| `stock_applied_at` NULL, status `prepared`/`delivered` | `none` | NULL | NULL | NULL |
| everything else | `none` | NULL | NULL | NULL |

**Two deliberate choices here.**

*Backfilled `qty_received` stays NULL even on settled orders.* Nobody counted those lines — the old model moved `qty_sent` and never asked. Writing `qty_received = qty_sent` would fabricate an observation, and every historical discrepancy report would then read "no gaps" for a period where gaps were simply never recordable. NULL on a settled order means *closed under the old model*, and any reader of `qty_received` must handle it.

*An order at `prepared` with `stock_applied_at` NULL becomes `none`, not `in_transit`.* Its stock genuinely never moved — that is what the empty stamp means — so it has nothing on a van. It is dispatchable again under the new model, which is the honest state. **This is the case Step 0's second query counts, and if it returns anything non-trivial it should be looked at by hand before the migration runs.**

**Step 4 — routes.** Split `_applyRestockTransfer` into `_applyDispatch` and `_applyReceipt`; `prepared` calls the first; `delivered` calls neither; a new `PUT /api/restock/:id/receive` calls the second. `_checkTransferIds` (A2) runs on **both** halves — the catalogue can drift between dispatch and receipt. Guard: reject `restock_items` writes when `goods_state != 'none'` (B3).

**Step 5 — `_resolveWarehouseStoreId` → `cfgValue`** (B7), with the single-warehouse backfill.

**Step 6 — front ends.** `public/app.html` and `public/kitchen.html` gain the receipt screen and read `goods_state`. No existing status literal changes (A7), so nothing already on screen breaks.

**What is reversible.** Steps 1, 2 and 3 are: added columns can be ignored, the backfill is derived entirely from `stock_applied_at` which is never modified, and it can be re-derived after a revert. **Step 4 is the point of no return** — once a dispatch has written an OUT half with no IN half, reverting to one-step code leaves those units nowhere. If Step 4 needs backing out, in-transit orders must be settled first.

SQLite adds no obstacle: every step is `ALTER TABLE ADD COLUMN`, `CREATE INDEX` or `UPDATE`. **No table rebuild, so none of `drop_created_by_user_fk_v1`'s machinery is needed.**

---

## B9. Test plan

Both suites use `scripts/test-support/tenant-fixture.js` — `harness()`, `openTenant()`, `inTenant()`, `seedProduct()`, `setShelf()`, `shelf()`, `ledgerFor()`, `callRoute()`, `stubAuth()`, `captureNotifications()` — run under one `npm run test:stock-movement`, alongside the existing `test:restock-handles`.

**Tenant 1 (`scripts/test_stock_two_step.js`)**

| # | Assertion | Fails on today's code because |
|---|---|---|
| 1 | `prepared` decrements the warehouse and **leaves the destination unchanged** | today both halves fire together; destination is already incremented |
| 2 | after `prepared`, `goods_state = 'in_transit'` and `dispatched_at` is set | column does not exist |
| 3 | derived in-transit for the product equals `qty_sent` | no query to derive |
| 4 | `delivered` moves **no** stock | today it re-runs the transfer (no-op only via the stamp) |
| 5 | receipt at `qty_received < qty_sent` increments the destination by **`qty_received`** | no receipt path; destination got `qty_sent` |
| 6 | after receipt, `goods_state = 'settled'` and derived in-transit is 0 | no state |
| 7 | ledger holds exactly one `restock_transfer_out` and one `restock_transfer_in`, **each with `ref_table='restock_orders'` and `ref_id` = the order id** | `ref_id` is always NULL (A0.1) |
| 8 | over-receipt (`qty_received > qty_sent`) is accepted and increments by the counted figure | no path; §39 forbids blocking |
| 9 | a line left `qty_received IS NULL` prevents `settled` | no state machine |
| 10 | double-calling receipt is a no-op — one IN row only | no guard |
| 11 | double-calling `prepared` is a no-op — one OUT row only | passes today via `stock_applied_at`; must keep passing on the new guard |
| 12 | editing `restock_items` after dispatch is refused | no guard (B3) |
| 13 | dispatch exceeding warehouse stock rolls back rather than clamping | **fails today**: `Math.max(0, …)` clamps silently (A0.2) |
| 14 | unset `stock.warehouseStoreId` refuses with a message naming the setting | today it falls through to the most-stock guess (B7) |

**Tenant 2 (`scripts/test_stock_two_step_tenant2.js`)** — same discipline as `test_restock_tenant2_split.js`, which exists because a tenant-1 suite cannot catch a handle bug: reverting the `:333` fix left all 54 tenant-1 assertions green.

| # | Assertion |
|---|---|
| 15 | dispatch on tenant 2 writes `dispatched_at` **in tenant 2's database** |
| 16 | receipt on tenant 2 writes `qty_received` and `received_confirmed_at` in tenant 2 |
| 17 | tenant 1's shelves and ledger are untouched by either half |
| 18 | a receipt that throws mid-way rolls back **both** the stamp and the stock — the order stays `in_transit` and retryable |
| 19 | `stock.warehouseStoreId` resolves per tenant — tenant 2's value, not tenant 1's |
| 20 | derived in-transit on tenant 2 counts only tenant 2's orders |

**19 is the one that would fail loudest on a careless implementation**, and it is the direct descendant of the `:333` bug: a config read that resolved on the shared handle would give every tenant Roots' warehouse.

`scripts/check-tenant-als.js` must still pass — any new `tenantAls.run()` takes a raw handle.

---

# PART C — OPEN QUESTIONS

## For Ash

**Q1 — `storefront_config` for warehouse settings, or a rename first?** A4 recommends reusing it: it works, it is per-tenant, and it already holds `inventory.*` keys unrelated to any storefront. But `stock.warehouseStoreId` living in a table called `storefront_config` will read as a mistake to whoever finds it next. Options: use it as-is (recommended, zero risk); use it and rename the table in a separate pass; or create a `tenant_config` table now and accept two config mechanisms during the transition.

**Q2 — an abandoned count.** B5: a delivery someone starts counting and never finishes leaves lines at NULL, so the order never settles and holds phantom in-transit stock indefinitely. §39 forbids a global accept, which rules out the easy answer. Options: leave it open forever and surface it on a warehouse screen; let the *warehouse* close it at dispatched quantities after N days, recorded as a warehouse action rather than a store count; or a manual "close this transfer" with a reason. **§39 does not settle this and neither should I.**

**Q3 — should a dispatch exceeding warehouse stock be refused?** A0.2: today `adjustStock` clamps at zero and creates units. B4 proposes throwing instead, for the restock OUT half only. This is a behaviour change to a live path — a picker who could previously dispatch 50 from a shelf showing 20 would now be stopped. Whether that is a correct refusal or an obstruction depends on how much Roots trusts its warehouse counts, which is Ash's to judge. **Note that leaving it as-is means the migration knowingly preserves a path that invents stock.**

**Q5 — can one recipe make more than one sellable product?** A5/B6: a 200g and a 500g jar from one batch. The answer picks the shape of the recipe→product link, and getting it wrong means redoing it. Nothing in the survey answers it.

## For you and me

**Q4 — `REAL` or `INTEGER` for quantities?** A0.3: `restock_items` says `REAL`, `retail_store_stock` and `retail_stock_ledger` say `INTEGER`, and SQLite enforces neither. B2 proposes `qty_received REAL` to match its neighbours. If stock is genuinely always whole units this should be settled and enforced in application code; if it is not, the ledger's `INTEGER` columns are already lying. **Either way this is bigger than the stock-movement work and should not be fixed inside it** — but a decision is needed on which way `qty_received` leans, and this document's answer is "match `qty_sent`".

**Q6 — does `delivered` stay in `STATUS_FLOW` at all?** B1 empties it of stock meaning, leaving it as "the driver handed the boxes over" — a fact nobody currently records except by pressing a button that used to do something else. It may be worth keeping purely as a request-lifecycle milestone, or it may become a button that no longer earns its place on the screen. Design question more than schema, and it does not block anything.

---

## What this document does not cover

- **The markets / `retail_stores` split.** Out of scope by instruction and untouched throughout.
- **Production-to-stock.** Scoped in B6 as prerequisites P1 and P2; not planned.
- **`store_products` versus `products` id spaces.** A2 records the trap and B8 keeps `_checkTransferIds` on both halves. The underlying fork is not addressed.
- **The receiving UI itself.** Drawn in `design-handoff/store-receiving/`; this document covers only what the schema owes it.
