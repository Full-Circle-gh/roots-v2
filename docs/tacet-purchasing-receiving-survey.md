# Purchase-order receiving — read-only survey of the path end to end

**2026-08-27 · A read-only survey of what happens between placing a purchase order and stock moving, written to answer twelve specific questions with file:line evidence. No file was changed, created or deleted except this one. No code was run against any database. No design is proposed and nothing found here was fixed — defects are written down and left.**

Judged against `docs/tacet-consolidation-decisions.md` §0 (governing rules) and §34 (stock is counted by item and place — nothing else), which decide what counts as a finding.

**Scope note — there are two receiving paths, not one.** `routes/retail-purchasing.js` (retail, `scope='retail'`) is the only one that moves stock. `routes/purchases.js` (kitchen, the default `scope='kitchen'`) moves no stock at all — a grep for `adjustStock|physical_qty|stock` across its 918 lines returns nothing. §28 already records this as current state: "its receive path silently skips any line without a store_product_id". Unless stated otherwise, every citation below is the retail path.

**Scope note — the mockup.** No receive-screen or landed-cost mockup exists in `reference/` (`po-print-redesign-mockup.html` is the printed PO document, a different screen), and no screenshot was supplied with this survey. Where the brief says "contradicts the mockup's copy", this document checks the copy that is actually **shipped** in `public/retail-admin/16-purchasing.js` — the receive screen's own on-screen sentences — and reports where the shipped code contradicts the shipped copy. If a screenshot exists that differs from the shipped screen, it has not been seen and those claims are unchecked.

---

## Summary of findings

| # | Finding | Kind |
|---|---|---|
| F1 | A purchase line has no destination; destination is one column on the PO header | Architectural — blocks §34 |
| F2 | Receiving branches on the KIND of item in nine places | §34 violation |
| F3 | "Confirm delivery" writes stock but never advances status, and that stock cannot then be undone | Defect, reachable |
| F4 | "Back to draft" and "Cancel order" leave received stock in place | Defect, reachable |
| F5 | Landed cost never reaches unit cost — it posts to Finance only | Contradicts on-screen copy |
| F6 | The "per unit across N units" figure sums mixed units of measure | Defect, display-only |
| F7 | The same figure divides by ORDERED qty, not received | Defect, display-only |
| F8 | "sync out to every sales channel" is a hardcoded three-channel list | §0 violation |
| F9 | The channel-sync sentence is false for every material line on the PO | Contradicts on-screen copy |
| F10 | Expense categories and currency are hardcoded Chinese-first / `¥` | §0 violation |
| F11 | A PO whose `store_id` is NULL silently receives nothing, reported as success | Defect, latent |
| F12 | No per-account setting governs capitalise-vs-expense anywhere in the codebase | Absence, recorded |

---

## DESTINATION

### 1. Where does a purchase line's destination live?

**Neither the line nor a dedicated location table — it lives on the PO HEADER, as `purchase_orders.store_id`.**

- `purchase_orders.store_id INTEGER` — [database.js:64](database.js:64), added by migration.
- `po_line_items` has **no** destination column of any kind. Its base definition is [schema.sql:191-209](schema.sql:191); every later column is added at [database.js:55](database.js:55), [:56](database.js:56), [:65](database.js:65), [:66](database.js:66), [:180](database.js:180), [:187-189](database.js:187), [:206-214](database.js:206), [:308](database.js:308). Not one names a location. The line's two identity columns are `store_product_id` ([database.js:65](database.js:65)) and `ingredient_id` ([schema.sql:194](schema.sql:194)) — both name the ITEM, neither names a place.
- `purchase_orders.warehouse TEXT` ([schema.sql:180](schema.sql:180)) exists but is free text and is never read by the retail receiving path.

**Against §34.** §34 says "A purchase line names the destination location". Today the line cannot: the column does not exist. This is F1, and it is the structural reason for F2 and F3 below.

### 2. When a delivery is confirmed, which location's stock is incremented, and how is that resolved?

`applyReceivedToStock()` — [routes/retail-purchasing.js:117](routes/retail-purchasing.js:117). The resolution is one property read, not a lookup:

1. [routes/retail-purchasing.js:118](routes/retail-purchasing.js:118) loads the PO via `getRetailPO(poId)`.
2. [routes/retail-purchasing.js:119](routes/retail-purchasing.js:119) — `if (!po || !po.store_id) return { applied: 0, ... }`. No store on the header, no stock, no error (F11).
3. [routes/retail-purchasing.js:144](routes/retail-purchasing.js:144) — `storeId: po.store_id` is passed to `inventory.adjustStock` **inside the per-line loop** (`for (const l of lines)` opens at [:127](routes/retail-purchasing.js:127)), so every line of the PO necessarily uses the same header value.
4. `inventory.adjustStock` ([lib/inventory.js:1066](lib/inventory.js:1066)) upserts `retail_store_stock` keyed `(store_id, product_id)` — [lib/inventory.js:1069-1082](lib/inventory.js:1069) — and appends a `retail_stock_ledger` row at [lib/inventory.js:1083-1087](lib/inventory.js:1083).

The undo path resolves the location identically: `storeId: po.store_id` at [routes/retail-purchasing.js:1296](routes/retail-purchasing.js:1296).

**The stock table itself is §34-compliant.** `retail_store_stock` carries `UNIQUE(store_id, product_id)` — [database.js:2873](database.js:2873) — exactly the two-part key §34 mandates. The non-compliance is entirely in what routes *to* it.

### 3. Can two lines on one PO land in two different locations today?

**No.** Three things block it, in order of how hard they are to move:

1. **No column.** There is nowhere on `po_line_items` to put a second location (Q1).
2. **One value, read per line.** `po.store_id` is read inside the loop ([routes/retail-purchasing.js:144](routes/retail-purchasing.js:144)); every line necessarily gets the same one.
3. **The header value is mandatory and validated on write.** Create rejects a missing or unknown store with `store_required` — [routes/retail-purchasing.js:1168-1171](routes/retail-purchasing.js:1168); edit repeats the check at [routes/retail-purchasing.js:1206-1208](routes/retail-purchasing.js:1206).

Three related behaviours confirm the single-destination assumption is deliberate, not accidental:

- **The store freezes once receiving starts.** An edit that changes `store_id` after any line has a non-zero `stock_applied_qty` returns HTTP 409 `already_receiving` — [routes/retail-purchasing.js:1199-1203](routes/retail-purchasing.js:1199). The comment at [:1197-1198](routes/retail-purchasing.js:1197) is explicit: "a moved PO would strand its applied quantities at the old store."
- **A back-order inherits the parent's store**, hardcoded, with no opportunity to redirect — `src.store_id` at [routes/retail-purchasing.js:1054](routes/retail-purchasing.js:1054).
- The printed PO states one destination for the whole document: "Deliver to {store}" — [public/retail-admin/16-purchasing.js:1130](public/retail-admin/16-purchasing.js:1130).

### 4. Does the receiving path branch on what KIND of item a line holds?

**Yes — in nine places. This is F2, a direct §34 violation.** §34: "Nothing on the item record determines this… Any code or screen that infers a destination from the kind of item is wrong." Listed, not fixed:

| # | Location | Branch |
|---|---|---|
| B1 | [routes/retail-purchasing.js:134](routes/retail-purchasing.js:134) | `if (l.ingredient_id) continue;` — a material line is skipped before any stock call. It receives **nothing**, anywhere. |
| B2 | [routes/retail-purchasing.js:135](routes/retail-purchasing.js:135) | `if (!l.store_product_id \|\| l.qty_received == null) continue;` — a line with neither id also silently no-ops. |
| B3 | [database.js:63](database.js:63) | `purchase_orders.scope TEXT DEFAULT 'kitchen'` — a purpose/department dimension stored on the order. The default value is a KIND, not a place. |
| B4 | [routes/retail-purchasing.js:62](routes/retail-purchasing.js:62) | `getRetailPO` filters `COALESCE(scope,'kitchen') = 'retail'`. The whole retail receiving path is gated on that kind marker; a kitchen-scope PO is invisible to it and reaches the stockless twin instead. |
| B5 | [routes/retail-purchasing.js:1094-1096](routes/retail-purchasing.js:1094) | `lineConflict()` — a line may carry `store_product_id` XOR `ingredient_id`, enforced before insert. Kind is a hard property of the line. |
| B6 | [routes/retail-purchasing.js:1130-1135](routes/retail-purchasing.js:1130) | `if (item.ingredient_id)` — unit and supplier defaults come from the `ingredients` master for material lines only (`ing.buy_unit` at [:1133](routes/retail-purchasing.js:1133)); product lines fall to `'pcs'` at [:1140](routes/retail-purchasing.js:1140). |
| B7 | [routes/retail-purchasing.js:165](routes/retail-purchasing.js:165) | `recipeOwnsProductCost(db, l.store_product_id)` — cost write-back is skipped for a product the tenant MAKES rather than buys. A second kind axis (made vs bought) layered on the first. |
| B8 | [public/retail-admin/16-purchasing.js:180](public/retail-admin/16-purchasing.js:180) | `matBadge` — renders a "Material 物料" pill on material rows in the receive table ([:1083](public/retail-admin/16-purchasing.js:1083)). |
| B9 | [public/retail-admin/16-purchasing.js:216-241](public/retail-admin/16-purchasing.js:216) | Two separate pickers and caches: `products(storeId)` is store-scoped, `materials()` is explicitly **not** — "Materials — not store-scoped stock, so one cache serves every store" ([:223](public/retail-admin/16-purchasing.js:223)). The kind of item decides whether a place applies at all. |

**The compounding effect (F9).** B1 and B8 together mean the receive table renders a material line with live, editable "Arrived" and "Damaged" inputs ([public/retail-admin/16-purchasing.js:1085-1086](public/retail-admin/16-purchasing.js:1085)), accepts the operator's counts, saves them to `po_line_items` ([routes/retail-purchasing.js:1322-1349](routes/retail-purchasing.js:1322)), and moves no stock. The "In stock" column for that row reads `—` forever, because `stock_applied_qty` is never written for it ([:1074](public/retail-admin/16-purchasing.js:1074)). Nothing on the screen says why.

**Not a violation, recorded for completeness.** `postRetailPOExpenses` ([routes/retail-purchasing.js:74](routes/retail-purchasing.js:74)) has **no** kind branch — it sums `COALESCE(qty_received, qty) * cost_per_unit` across every line ([routes/retail-purchasing.js:80-85](routes/retail-purchasing.js:80)). So a material line reaches Finance in full while reaching stock not at all. The two halves of receiving disagree about what a material line is.

### 5. Where does the channel-sync sentence come from, and is a sync actually triggered?

**The sentence** is [public/retail-admin/16-purchasing.js:1029](public/retail-admin/16-purchasing.js:1029), rendered only when `canReceive` (status `Ordered` or `Delivered`):

> **Confirmed counts go into {store} stock by themselves** and sync out to every sales channel. Damaged units are kept out of stock.

**A sync is genuinely triggered**, synchronously, inside the stock transaction: `adjustStock` → `enqueueChannelSync(storeId, productId)` at [lib/inventory.js:1088](lib/inventory.js:1088). That fans out at [lib/inventory.js:128-134](lib/inventory.js:128) to `enqueueMeituanSync`, `enqueueGuanyiSync`, `enqueueElemeSync` and `enqueueContainingBundles`.

So the sentence is not describing something that happens elsewhere or not at all. It is, however, wrong in two ways:

- **F8 — "every sales channel" is a hardcoded list of three.** [lib/inventory.js:129-131](lib/inventory.js:129) names Meituan, Guanyi and Eleme as literals. §0's first recorded consequence is "SALES CHANNELS ARE NOT A FIXED LIST… GZ Grocery in particular is specific to one customer." A tenant with none of those three syncs to nothing while being told it syncs to everything; a tenant with a fourth channel is not served at all.
- **F9 — the sentence is false for every material line on the PO**, per B1 above. The copy is rendered once for the whole order, above a table that may freely mix kinds ([:1092-1093](routes/retail-purchasing.js:1092): "one PO can freely mix lines of each kind").

The damaged clause is the one part that holds — see Q12.

---

## LANDED COST

### 6. Where are freight / tax / handling captured?

**Three REAL columns on the PO header**, added together at [database.js:365-367](database.js:365):

- `purchase_orders.extra_freight  REAL DEFAULT 0`
- `purchase_orders.extra_tax      REAL DEFAULT 0`
- `purchase_orders.extra_handling REAL DEFAULT 0`

Written by one route, `PUT /api/retail-admin/purchases/:id/landed` — [routes/retail-purchasing.js:1079-1089](routes/retail-purchasing.js:1079). Values are clamped non-negative by `num = v => Math.max(0, parseFloat(v) || 0)` ([:1082](routes/retail-purchasing.js:1082)). There is **no** per-line freight/tax/handling column anywhere.

### 7. On save, where does that money go?

**Into an expense entry only. Not into unit cost. Not into both.** Traced:

1. `puSaveLanded` ([public/retail-admin/16-purchasing.js:982](public/retail-admin/16-purchasing.js:982)) PUTs the three values; the body carries only `{ freight, tax, handling }` ([:986](public/retail-admin/16-purchasing.js:986)).
2. The route writes the three columns — [routes/retail-purchasing.js:1084-1085](routes/retail-purchasing.js:1084).
3. It then calls `postRetailPOExpenses(po.id)` — [routes/retail-purchasing.js:1086](routes/retail-purchasing.js:1086) — **and nothing else.**
4. Inside that function, [routes/retail-purchasing.js:96-102](routes/retail-purchasing.js:96): the three are summed into `extras` and, if `> 0`, inserted as **one single expense row** in category `'运费及杂费 Freight & fees'`, described `"{po_number} · {supplier} · shipping & fees"`.

The whole function is idempotent DELETE-then-INSERT keyed on `po_id` ([routes/retail-purchasing.js:76](routes/retail-purchasing.js:76)) and posts only at status `Ordered` or `Delivered` ([:77](routes/retail-purchasing.js:77)).

**`applyReceivedToStock` never reads `extra_freight`, `extra_tax` or `extra_handling`.** Its SELECT is [routes/retail-purchasing.js:120-123](routes/retail-purchasing.js:120) and does not include them. The cost it writes back to `store_products.unit_cost` is the raw line price, `const cost = parseFloat(l.cost_per_unit)` at [routes/retail-purchasing.js:164](routes/retail-purchasing.js:164), written at [:171](routes/retail-purchasing.js:171).

**F5 — this contradicts the shipped copy.** The panel is titled "True landed cost" ([:959](public/retail-admin/16-purchasing.js:959)) and its own code comment claims it gives "a true per-unit cost" ([:948](public/retail-admin/16-purchasing.js:948)). No per-unit cost anywhere in the system is affected by it. Margin, reported from `store_products.unit_cost`, is computed on the goods price with freight excluded. The button label is the one fully honest string on the panel: "Save — posts freight & fees to Finance" ([:968](public/retail-admin/16-purchasing.js:968)).

### 8. If it reaches unit cost, how is it split across lines?

**It does not reach unit cost, so there is no split.** There is no allocation formula in the codebase — not by value, not by quantity, not by weight. The extras are summed once ([routes/retail-purchasing.js:96](routes/retail-purchasing.js:96)) and posted once ([routes/retail-purchasing.js:98](routes/retail-purchasing.js:98)). The only division that happens anywhere is the display-only one in Q9, which is never persisted and never read back.

### 9. Where is the "per unit across N units" number computed, and what does it divide by?

Computed twice, in the browser only, and never sent anywhere:

- First paint: [public/retail-admin/16-purchasing.js:956](public/retail-admin/16-purchasing.js:956) — `const perUnit = units > 0 ? landed / units : 0;`
- Live recalc on keystroke: [public/retail-admin/16-purchasing.js:980](public/retail-admin/16-purchasing.js:980) — the same expression inlined.

Rendered at [:967](public/retail-admin/16-purchasing.js:967) as "≈ {money} per unit across {units} units".

Where the two inputs come from:

- `landed = goods + f + t + h` ([:955](public/retail-admin/16-purchasing.js:955)), with `goods = Σ(qty × cost_per_unit)` ([:952](public/retail-admin/16-purchasing.js:952)).
- **`units = items.reduce((s, i) => s + (Number(i.qty) || 0), 0)`** — [public/retail-admin/16-purchasing.js:953](public/retail-admin/16-purchasing.js:953), repeated at [:975](public/retail-admin/16-purchasing.js:975).

**It divides by the arithmetic sum of the `qty` column across every line of the PO.** Two defects follow:

- **F6 — mixed units of measure are added together.** `po_line_items.unit` is per line ([schema.sql:199](schema.sql:199)); a material line defaults it from `ingredients.buy_unit` ([routes/retail-purchasing.js:1133](routes/retail-purchasing.js:1133), where `buy_unit` itself defaults to `'kg'` — [schema.sql:51](schema.sql:51)) while a product line defaults to `'pcs'` ([routes/retail-purchasing.js:1140](routes/retail-purchasing.js:1140)). A PO of 5 kg + 3 pcs + 2 L reports `units = 10`. The unit is displayed on every other row of the same screen ([:1084](public/retail-admin/16-purchasing.js:1084)) and ignored here. §0 also bears directly: "UNITS OF MEASURE ARE PER BUSINESS. Grams and kilograms may not be assumed."
- **F7 — it divides by ORDERED quantity, never received.** `i.qty`, not `qty_received`. Every other money figure in the receiving path uses `COALESCE(qty_received, qty)` ([routes/retail-purchasing.js:82](routes/retail-purchasing.js:82), [:84](routes/retail-purchasing.js:84)). After a short delivery the panel divides the full freight bill by units that never arrived, and the number drifts further from truth the larger the shortage. It also never subtracts `damaged_qty`.

### 10. Is there any per-account setting governing whether purchase overheads capitalise or expense?

**No. Plainly: no such setting exists anywhere in the codebase.**

A repo-wide search for `capitalis|capitaliz|landed_cost_(mode|policy)|overhead_(mode|policy)|expense_policy|allocat.*(freight|overhead)` across `*.js`, `*.json` and `*.html` returns only `autocapitalize` form attributes and `text-transform: capitalize` CSS rules. Not one hit is a setting.

The behaviour is therefore hardcoded to **expense**, at exactly one place — [routes/retail-purchasing.js:97-102](routes/retail-purchasing.js:97) — with no branch, no flag, and no read of any config table. §33 records the parallel packaging question as "an ACCOUNT POLICY, not a platform rule, and neither answer may be hardcoded"; the equivalent question for purchase overheads has not been asked in the decisions record, and the code has answered it by default.

---

## STATE

### 11. What happens on "Confirm delivery" vs "All arrived as ordered" vs "Back to draft"?

The three buttons are rendered together at [public/retail-admin/16-purchasing.js:1033-1035](public/retail-admin/16-purchasing.js:1033).

| Button | Handler | Route | Writes stock? | Changes status? |
|---|---|---|---|---|
| **Confirm delivery** | `puReceiveSave` [:1145](public/retail-admin/16-purchasing.js:1145) | `PUT …/receive` [routes/retail-purchasing.js:1313](routes/retail-purchasing.js:1313) | **Yes** | **No** |
| **All arrived as ordered** | `puAllArrived` [:1193](public/retail-admin/16-purchasing.js:1193) | `PUT …/status` `{status:'Delivered'}` [routes/retail-purchasing.js:1249](routes/retail-purchasing.js:1249) | **Yes** | Yes → `Delivered` |
| **Back to draft** | `puSetStatus('Requested')` [:1035](public/retail-admin/16-purchasing.js:1035) | `PUT …/status` [routes/retail-purchasing.js:1249](routes/retail-purchasing.js:1249) | **No** — and reverses none | Yes → `Requested` |

**Confirm delivery.** Collects every row's inputs ([public/retail-admin/16-purchasing.js:1148-1159](public/retail-admin/16-purchasing.js:1148)), saves them in one transaction ([routes/retail-purchasing.js:1322-1350](routes/retail-purchasing.js:1322)), then calls `applyReceivedToStock` at [routes/retail-purchasing.js:1354](routes/retail-purchasing.js:1354) and re-posts expenses if any quantity was entered ([:1355](routes/retail-purchasing.js:1355)). **The route contains no status write of any kind.**

**All arrived as ordered.** Sets status first ([routes/retail-purchasing.js:1254](routes/retail-purchasing.js:1254)), then seeds every line `qty_received = COALESCE(qty_received, qty)` ([:1258](routes/retail-purchasing.js:1258)) and calls the same `applyReceivedToStock` ([:1259](routes/retail-purchasing.js:1259)). Also fires price write-back ([:1267](routes/retail-purchasing.js:1267)) and posts expenses ([:1269](routes/retail-purchasing.js:1269)).

**Back to draft.** Sets status `Requested`, which is not in `['Ordered','Delivered']`, so the else branch runs: `DELETE FROM expense_entries WHERE po_id = ?` ([routes/retail-purchasing.js:1270](routes/retail-purchasing.js:1270)). **No stock call on this path at all.**

#### Reversibility

**Exactly one route reverses stock: `PUT …/undo-receive`** ([routes/retail-purchasing.js:1285](routes/retail-purchasing.js:1285)). It is carefully built — it reverses precisely `stock_applied_qty` per line ([:1296](routes/retail-purchasing.js:1296)), zeroes that column ([:1299](routes/retail-purchasing.js:1299)) so a later correction cannot double-reverse, and logs `stock_lines_reversed` ([:1305](routes/retail-purchasing.js:1305)).

**F3 — but it is gated on a status that "Confirm delivery" never sets.** Two independent gates:

- The route returns HTTP 409 `not_delivered` unless `po.status === 'Delivered'` — [routes/retail-purchasing.js:1288](routes/retail-purchasing.js:1288).
- The button only renders when `p.status === 'Delivered'` — [public/retail-admin/16-purchasing.js:1037](public/retail-admin/16-purchasing.js:1037).

**Failure scenario.** A PO sits at `Ordered`. The operator ticks in the arrived counts and clicks the primary button, "Confirm delivery". Stock is written, the ledger records it, the channels sync. The order remains at `Ordered`, so the lifecycle stepper still shows it as un-delivered, no "Undo receiving" button appears, and the route would refuse it if one did. The only way to reach an undoable state afterwards is to click "All arrived as ordered" — which overwrites the operator's entered counts with `qty` on every line left blank ([:1258](routes/retail-purchasing.js:1258)). Booked stock sits behind a button labelled for a state the booking did not produce.

**F4 — two paths abandon received stock in place.** Neither is reachable only by accident:

- **Back to draft** from a PO already received via Confirm delivery (status still `Ordered`, so the button is rendered — [:1035](public/retail-admin/16-purchasing.js:1035)): status drops to `Requested`, expenses are deleted ([routes/retail-purchasing.js:1270](routes/retail-purchasing.js:1270)), and the stock stays on the shelf with no order accounting for it. Books and stock now disagree in opposite directions. `stock_applied_qty` is left non-zero, so a later re-receive computes its delta against it and does not double-apply — the stock figure is stable, just unexplained.
- **Cancel order** ([:1040](public/retail-admin/16-purchasing.js:1040)) reaches the same else branch. The comment at [routes/retail-purchasing.js:1236-1238](routes/retail-purchasing.js:1236) describes Cancel as the "reversible exit" that "keeps the row, zeroes it out — see the /status route", but the /status route zeroes only `expense_entries`. `stock_applied_qty` and the stock itself are untouched.

For contrast, delete IS correctly guarded — draft-only, HTTP 409 `not_draft` otherwise — [routes/retail-purchasing.js:1242](routes/retail-purchasing.js:1242).

**F11 — a header with no store silently receives nothing.** `applyReceivedToStock` returns `{ applied: 0, costed: 0, costSkippedRecipe: 0 }` on `!po.store_id` ([routes/retail-purchasing.js:119](routes/retail-purchasing.js:119)). The caller reports that as success ([:1358-1359](routes/retail-purchasing.js:1358)) and the toast simply omits the "stock updated" clause, which is conditional on a non-zero count ([public/retail-admin/16-purchasing.js:1163](public/retail-admin/16-purchasing.js:1163)). Create and edit both require a valid store today ([routes/retail-purchasing.js:1169](routes/retail-purchasing.js:1169), [:1206](routes/retail-purchasing.js:1206)), so this is latent rather than live — reachable only by a row written before that validation existed or from outside these routes. Recorded because the failure mode is silence, not an error.

### 12. Are damaged units excluded from stock, and where?

**Yes.** One line, in one place — [routes/retail-purchasing.js:139](routes/retail-purchasing.js:139):

```js
const good = Math.round(Math.max(0, (parseFloat(l.qty_received) || 0) - (parseFloat(l.damaged_qty) || 0)));
```

`good` is then differenced against `stock_applied_qty` ([:140-141](routes/retail-purchasing.js:140)) and only the delta is applied ([:142-149](routes/retail-purchasing.js:142)). `damaged_qty` is stored per line ([database.js:189](database.js:189)) and written by the receive route ([routes/retail-purchasing.js:1332-1336](routes/retail-purchasing.js:1332)). The on-screen claim "Damaged units are kept out of stock" is **accurate**.

Three qualifications, none of which contradict that copy:

- `Math.round` is applied because `retail_store_stock.physical_qty` is an `INTEGER` ([database.js:2868](database.js:2868)). A fractional damaged count is rounded, not preserved. The receive inputs enforce `step="1"` ([public/retail-admin/16-purchasing.js:1085-1086](public/retail-admin/16-purchasing.js:1085)) — coherent for `pcs`, wrong for a material bought in kg. The §0 units problem again, and moot today only because material lines never reach stock at all (B1).
- **Damaged units are excluded from stock but NOT from the books.** `postRetailPOExpenses` uses `COALESCE(qty_received, qty)` with no `damaged_qty` subtraction ([routes/retail-purchasing.js:82](routes/retail-purchasing.js:82)). Damaged goods are expensed in full. That may well be correct accounting — the supplier was paid — but it is undocumented and nothing on screen says so.
- Damaged units are subtracted from neither the numerator nor the denominator of the Q9 per-unit figure (F7).

---

## §0 findings incidental to the path

**F10 — hardcoded currency and Chinese-first accounting categories.** §0: "CURRENCY IS PER BUSINESS. The codebase currently hardcodes CNY and the ¥ symbol in hundreds of places. This is a defect." and "LANGUAGE IS PER BUSINESS TO OFFER". In this path specifically:

- `'门店进货 Retail stock'` — the default expense category for any line without one, [routes/retail-purchasing.js:80](routes/retail-purchasing.js:80).
- `'运费及杂费 Freight & fees'` — the landed-cost category, written as a literal with no lookup, [routes/retail-purchasing.js:98](routes/retail-purchasing.js:98).

These two are **stored** strings, not display strings: they land in `expense_entries.category` and surface in Finance reports, so a single-language tenant inherits Chinese rows it cannot read. (Line-level categories do pass through `storeCategory()` — [lib/category-text.js:141](lib/category-text.js:141) — which matches against the tenant's own `categories` table; these two defaults bypass that.)

- A literal `¥` is prefixed to every money input on the landed-cost panel ([public/retail-admin/16-purchasing.js:957](public/retail-admin/16-purchasing.js:957)) and to the line-cost input on the build screen ([:658](public/retail-admin/16-purchasing.js:658)).

**Adjacent to §34, recorded not asserted.** `retail_store_stock` carries `wechat_quota` and `meituan_quota` columns ([database.js:2870-2871](database.js:2870)) — named channels as columns on the stock row. These are per-channel *caps*, not a third key on the *count*, so they do not breach §34's two-part key. They do breach §0's "sales channels are not a fixed list".

---

## What was NOT surveyed

- **The kitchen twin's internals.** `routes/purchases.js` was checked only far enough to establish that it writes no stock (scope note above). Its price write-back, `firePriceAlertsForPO`, is invoked by the retail path ([routes/retail-purchasing.js:43](routes/retail-purchasing.js:43)) but its body was not read.
- **`lib/recipe-rollup.js`'s `recipeOwnsProductCost`** — cited as branch B7 by call site only.
- **Any live database.** No query was run against production or any copy. Every claim here is from source.
- **The supplier-invoice half** (`invoice_lines`, allocations, `invoice_status`) — it hangs off the same lines but is not part of the stock path.
- **Whether `applyReceivedToStock`'s `db` handle and `adjustStock`'s `tdb()` handle resolve to the same tenant database.** The two are different accessors ([routes/retail-purchasing.js:120](routes/retail-purchasing.js:120) vs [lib/inventory.js:1068](lib/inventory.js:1068)); confirming they agree needs the db-seam read, which was out of scope here.
