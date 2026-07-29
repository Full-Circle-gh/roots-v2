# Food → Tacet module: connection & duplication map

**Goal.** The food (kitchen/ERP) system becomes a **module inside Tacet**, not a
separate system. This document maps every place the two overlap today — the
duplicated concepts and the live cross-wiring — and proposes what happens to
each.

**Method.** Read of `database.js`, `schema.sql`, all of `routes/`, `lib/`,
`middleware/`, `server.js`, `public/app.html`. Line references are to the state
of `main` at the time of writing.

---

## 0. The headline

The two systems are not "connected" so much as **half-merged and half-forked**,
in different places, in different directions:

- The **catalog has already been hard-forked** (`products` → `store_products`,
  migration `store_products_seed_fk_v1`), but the fork link was never used and
  the kitchen still writes into store-owned tables using the *old* id space.
- The **identity systems were never merged** — two user tables, two permission
  models, two session keys, one cookie.
- **Locations and stock exist twice** (`markets`/`market_stock` vs
  `retail_stores`/`retail_store_stock`) and the kitchen writes both.
- The **schema duplication is self-perpetuating**: `database.js` mirrors every
  new `products` column into `store_products` on boot, forever.

So the work is not "disconnect" and not "merge". It is: **decide, per concept,
which side owns the record — then collapse the loser.**

---

## 1. Duplications — same concept, two implementations

| # | Concept | Food (kitchen) | Tacet | Verdict |
|---|---|---|---|---|
| D1 | **Product catalog** | `products` (34 refs in `routes/products.js`, 0 refs to `store_products`) | `store_products` (137 refs in `routes/retail.js`, 0 refs to `products`) | **Already forked.** Collapse into one. See §3. |
| D2 | **Locations** | `markets`, with `kind` ∈ market\|retail\|kitchen\|warehouse (`database.js:612`) | `retail_stores` (`database.js:2551`) | Same physical shops modelled twice. Collapse into `retail_stores`. |
| D3 | **Per-location stock** | `market_stock` (`database.js:449`) | `retail_store_stock` (`database.js:2569`) | Same shelves counted twice. Collapse. |
| D4 | **Stock audit trail** | `market_stock_ledger` (`database.js:464`) | `retail_stock_ledger` (`database.js:2606`) | Near-identical columns (delta / reason / ref_table / ref_id / user). Collapse. |
| D5 | **Identity** | `users` + `permissions` — boolean column per module (`schema.sql:7,26`; 7 more added via `addColumn`) | `tenant_users` + `lib/capabilities.js` — `section:action` caps, role presets, per-user grants/revokes, feature entitlements (`routes/backend-auth.js:43`) | Two realms, two permission philosophies. Tacet's is strictly more expressive. Collapse into it. |
| D6 | **Sessions** | `req.session.userId`, `sessions` table | `req.session.backendUserId`, `tenant_user_sessions` | Two session realms sharing one cookie. Follows D5. |
| D7 | **Revenue records** | `sales_entries` + `sale_addons` (`schema.sql:230`) | `retail_orders` + `retail_order_items` + `retail_order_addons` (`database.js:1169`) | Two revenue ledgers. **Plus a third:** `miniapp_orders` / `miniapp_order_lines` (`database.js:758`), a legacy import still queried by `routes/sales.js:453-547`. Needs a decision — see §4. |
| D8 | **Categories** | `categories` table + `products.top_category/subcategory` | `lib/category-tree.js` over `store_products.top_category/subcategory` | Taxonomy forked along with the catalog. Follows D1. |
| D9 | **Feedback** | `feedback` + `feedback_comments` + `feedback_attachments` (`database.js:921`) — staff bug reports | `retail_feedback` + `retail_feedback_messages` (`database.js:1491`) — shopper reports | Different audiences, near-identical thread model. **Probably legitimate** — rename rather than merge. |
| D10 | **"Invoices"** | `invoices` + `invoice_lines` + `invoice_pos` (`database.js:235`) — *supplier* invoices | retail customer invoices (`invoices:*` caps, `lib/capabilities.js`) **and** `billing_invoices` — *platform SaaS* invoices | Three unrelated concepts sharing one word. Naming problem, not a data problem. |
| D11 | **Purchasing** | `routes/purchases.js` over `purchase_orders` + `po_line_items` + `suppliers` | `routes/retail-purchasing.js` over **the same tables**, discriminated by `purchase_orders.scope='retail'` and `suppliers.tenant_id` | **Already shared** — two UIs over one table. The cleanest precedent in the codebase for how to do this. |
| D12 | **Push** | `push_subscriptions` via `routes/push.js` | operator push via `routes/backend-auth.js` on the same table | Shared table, two subscriber kinds. Fine. |
| D13 | **Platform console** | `saas-admin.html`, gated on a kitchen `admin` session (`server.js:455`) | `store-admin.html`, `platform_admins` realm (`routes/store-admin.js`) | Two back offices for the same platform. Collapse into store-admin. |
| D14 | **Design tokens** | `public/app.html` CSS, ~20 comments saying "mirrors retail-admin" | `retail-admin.html` + tacet tokens | Hand-copied token set that drifts silently. |

### Not duplicated — food's genuine domain

These have no Tacet equivalent and shouldn't get one. They are what the food
module actually *is*:

`recipes`, `recipe_ingredients`, `recipe_steps`, `recipe_cost_data`,
`ingredients`, `ingredient_price_history`, `packaging_types`,
`production_batches`, `waste_entries`, `kitchen_orders`, `kitchen_order_items`,
`restock_orders`, `restock_items`, `price_alerts`, `expense_entries`,
`income_entries`, `supplier_documents`.

---

## 2. Connections — live cross-wiring

| # | Connection | Where | Direction |
|---|---|---|---|
| C1 | **Kitchen credentials open Tacet.** `requireRetailAdmin` branch (2): any kitchen user holding the `retail` permission gets the full store backend. | `routes/retail.js:86-160` | food → Tacet |
| C2 | **Tacet operator returned as a kitchen principal**, synthesised with `permissions:{retail:1}`. | `routes/auth.js:101-113` | Tacet → food |
| C3 | **Kitchen reads/writes Tacet's store stock.** `/api/products/:id/store-stocks` and `.../adjust`. | `routes/products.js:530-600` | food → Tacet |
| C4 | **Restock transfers write Tacet's stock ledger** via `inventory.adjustStock`, and resolve stores out of `retail_stores`. | `routes/restock.js:141-215, 581` | food → Tacet |
| C5 | **Kitchen UI calls the Tacet API** — ~15 `fetch('/api/retail-admin/…')` for stores, inventory grid, per-store stock, CMS media, substitutes; plus the `Mini App · 小程序` nav module. | `public/app.html:2585, 8624, 8885, 8921, 9032, 9056, 9076, 9087, 10145, 12446, 12473, 12512, 15741` | food → Tacet |
| C6 | **Host routing** — one process, hostname switch; `/retail-admin` 302s to the store host. | `server.js:480, 604, 645` | shared |
| C7 | **Platform gates on a kitchen role** — `/saas-admin`, platform-admin actor resolution, tenant signup. | `server.js:455`, `lib/platform-admin.js:105`, `routes/backend-signup.js:53` | food → platform |
| C8 | **Combined revenue reporting** — Tacet's report reads the kitchen's `sales_entries`; the kitchen's Sales module reads `miniapp_orders`. | `routes/retail.js:1683`, `routes/sales.js:453-547` | both |
| C9 | **Kitchen user rows carry Tacet assignments** — `users.retail_store_id`, `users.market_id`. | `database.js:637-641` | food ↔ Tacet |
| C10 | **Shared purchasing tables**, scope/tenant discriminated. | `routes/purchases.js:139`, `routes/retail-purchasing.js` | shared |

---

## 3. Live hazards — things that are wrong *now*

### H1 — The kitchen adjusts store stock through the wrong id space ⚠️

The fork migration (`database.js:3774-3830`) repointed every store-owned FK from
`products` to `store_products`, including `retail_store_stock`,
`retail_stock_ledger`, and `retail_stock_reservations`.

The kitchen was not updated. `routes/products.js:576` validates the product
against **`products`**:

```js
const product = db.prepare('SELECT id, name_en FROM products WHERE id = ? …').get(productId);
```

…then at line 580 reads, and via `inventory.adjustStock` writes,
`retail_store_stock` / `retail_stock_ledger` — both of which now mean
**`store_products.id`**. `routes/restock.js` moves stock the same way.

Ids were preserved at fork time, so **rows that existed at the fork still line
up**. But both tables carry independent `AUTOINCREMENT` counters seeded from the
same maximum, so **every product created after the fork on either side allocates
an id the other side also allocates to something different.** The kitchen's
stock adjuster would then read and write a different product's shelf quantity,
silently, with a plausible-looking ledger entry.

**Verify before anything else** (read-only, against production):

```sql
-- Post-fork rows whose ids exist on both sides but are different products
SELECT p.id, p.sku AS kitchen_sku, sp.sku AS store_sku, p.name_en, sp.name_en
  FROM products p JOIN store_products sp ON sp.id = p.id
 WHERE COALESCE(p.sku,'') <> COALESCE(sp.sku,'');

-- Stock rows pointing at a product the kitchen thinks is something else
SELECT rss.store_id, rss.product_id, p.sku, sp.sku
  FROM retail_store_stock rss
  LEFT JOIN products p ON p.id = rss.product_id
  LEFT JOIN store_products sp ON sp.id = rss.product_id
 WHERE COALESCE(p.sku,'') <> COALESCE(sp.sku,'');
```

If either returns rows, there is bad stock data to correct, not just code to fix.

### H2 — The duplication grows itself

`database.js:3658-3661` mirrors every column `products` gains into
`store_products` on each boot, "so the two schemas never drift". That keeps the
fork *identical* rather than letting it *specialise* — every kitchen-only field
(recipe_id, batch-made, packaging) is copied into the store catalog forever, and
the duplication can never shrink on its own.

### H3 — The fork link is dead

`store_products.kitchen_product_id`, `source_sku`, `synced_at`, and
`source='fork'` were written by the migration and are **read by no code
anywhere** in `routes/`, `lib/`, or `scripts/`. There is no reconciliation, no
sync, and no report that can answer "which store product is this kitchen
product?" — except by querying that unread column directly.

This is recoverable *today* and gets harder every week. It is the single
strongest argument for acting on D1 sooner rather than later.

---

## 4. Recommendation

### The principle

> **Tacet owns the record. Food owns the process.**

Anything that is a *thing the business has* — a product, a location, a stock
level, a person, an order — is a Tacet record with one table. Anything that is
*something the kitchen does to it* — a recipe, a batch, a waste entry, a
restock run, an ingredient cost — is the food module's own.

Applied to the catalog: food should not *master* products; it should
**annotate** them (`recipe_id`, `is_batch_made`, weight, cost inputs) on the
record Tacet owns.

### Bucket per duplicate

**Collapse into Tacet (one table, Tacet's):** D1 catalog · D2 locations ·
D3 stock · D4 ledger · D5 identity · D6 sessions · D8 categories ·
D13 console · D14 tokens.

**Keep, they're genuinely distinct — just rename:** D9 feedback (staff vs
shopper) · D10 invoices (supplier vs customer vs platform billing).

**Already right, use as the pattern:** D11 purchasing — one table, a `scope`
column, two UIs. This is what "a module inside Tacet" should look like
everywhere else.

**Needs a product decision:** D7 revenue — see §5.

### Order of work

Sequenced so each step de-risks the next, and so the riskiest thing happens last:

**Step 0 — Stop the bleeding.** *(days, no data migration)*
- Verify and fix **H1**. Either point the kitchen's stock endpoints at
  `store_products`, or remove them (they duplicate Tacet's own inventory grid).
- Freeze **H2** — stop auto-mirroring new `products` columns into
  `store_products`; let the two schemas specialise from here.
- Decide **H3** now: either start using `kitchen_product_id` as the real link,
  or accept the fork is permanent and drop the columns. Leaving it undecided is
  the only option with no upside.

**Step 1 — Cut the couplings that point the wrong way.** *(days)*
C1, C2, C5, C7 — kitchen credentials must stop being an entry route into Tacet,
and the kitchen UI must stop calling Tacet's API. While C1 exists, food is an
*identity provider for* Tacet, which is the exact inverse of being a module
inside it. Requires: Tacet accounts for any Roots staff who use those screens,
provisioned **before** the cut.

**Step 2 — Make food tenant-aware.** *(the long pole; invisible to users)*
~355 `db.prepare` → `tdb()` conversions across the twelve kitchen route files.
Currently: `routes/retail.js` has 1,197 `tdb()` calls; the entire kitchen has
**zero**. Because `getTenantDb(1) === mainDb`, this is a **literal no-op for
Roots** — shippable one file at a time, each independently verifiable. Nothing
else on this list can happen until it does.

**Step 3 — Collapse identity.** D5/D6. `users` + `permissions` → `tenant_users`
+ capabilities. Add food's caps (`recipes:view`, `waste:edit`, …) to
`lib/capabilities.js`, map them in `lib/cap-routes.js`. Note Tacet already
carries kitchen-shaped caps: `quickstock:add` — "Quick Stock — add (kitchen)",
feature `kitchenAdd` (`lib/capabilities.js:56`).

**Step 4 — Collapse locations and stock.** D2/D3/D4. `markets` rows with
`kind='retail'` become `retail_stores`; `market_stock` merges into
`retail_store_stock`. Real data migration, small table, low blast radius.

**Step 5 — Collapse the catalog.** D1. The biggest, and deliberately last —
by then the id space, the auth realm, and tenancy are all settled, which is most
of what makes it dangerous.

**Step 6 — Register food as a Tacet module.** Add the entitlement key to
`lib/features.js`, namespace the API under the `requireRetailAdmin` choke point,
retire `public/app.html` as a separate shell.

---

## 5. Open decisions

1. **Revenue (D7).** Is a market-stall / POS sale a **Tacet order** or a **food
   record**? Collapsing `sales_entries` into `retail_orders` gives one revenue
   truth and one reporting path; keeping them split means every revenue report
   stays a union query forever (as `routes/retail.js:1683` already is). Related:
   `miniapp_orders` is a legacy import that `routes/sales.js` still reads —
   retire it or fold it in?

2. **Is the food module sellable to other tenants, or Roots-only forever?**
   Roots-only makes Step 6 mostly optional and lets food keep a simpler
   permission model. Sellable makes Steps 2, 3 and 6 unavoidable.

3. **Migration posture for the catalog (Step 5).** Re-link the fork using
   `kitchen_product_id` and merge back to one table, or accept the fork and
   define a one-way publish (kitchen authors → store record)? The first is
   cleaner and only gets more expensive; the second is cheaper now and
   permanent.

4. **Who moves to Tacet logins, and when.** This is the only step in the whole
   plan with immediate operational blast radius for Roots staff.
