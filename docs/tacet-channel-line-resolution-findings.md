# How a channel order line finds its product — the resolver, and what happens when it doesn't

**2026-08-27 · Read-only survey. No file was changed, created or deleted except this one and a
one-line pointer added to `docs/tacet-variant-name-findings.md`. No code was run against any database
except read-only `sqlite3 -readonly` SELECTs.**

**Sources.** Repository at `origin/main` `40f114a8`. Live rows read from the production database at
`/root/roots-v2/data/roots.db` over SSH on 2026-08-27. The 90-day window is 2026-05-29 → 2026-08-27.

**Why this document is separate.** It grew out of `docs/tacet-variant-name-findings.md` §C.1, but the
subject is different — that survey is about editing a variant's name, this one is about the channel
order resolver. Cross-linked both ways.

**No fix is proposed here. This is the shape of the problem only.**

---

## 1 · The four resolution paths, in order

`resolveProduct()` — `routes/meituan-internal.js:118-190`, and a near-twin at
`routes/eleme-internal.js:160-220`. Each step returns the moment it succeeds, so a step only runs
when every step above it missed.

### Step 0 · `claim` — the option this line was sold as

`claimForLine()`, `routes/meituan-internal.js:47-87`. Reads `meituan_product_map` rows that carry a
non-empty `spec_key` — a *claim*, meaning "this product owns this 规格 of this listing". Keyed on the
line's 货号: the code is resolved through `meituan_listing_specs` to the option's `sku_id`, and
failing that against the option's own label.

This step is **ahead of the SKU token deliberately**: a pack's code is a variant of the base
product's ("3-120*5"), so the token alone loses which pack it was. It is also the only path that
knows `units_per_pack`, so it is the only one that can deduct 6 for a six-pack.

**Reached always. Falls through when:** the line carries no 货号, or no claim exists for it, or the
code matches more than one claim.

### Step 1 · `sku` — the inline SKU token

`routes/meituan-internal.js:145-155`. Prefers Meituan's explicit `skuCode`, else a `(\d+-\d+)` token
scraped out of the listing/spec name. Looked up as `store_products.sku`, active rows first, then any
row.

**Falls through when:** there is no token, or the token is not a SKU we hold. A token that existed
but resolved to nothing sets `matchBy = 'sku_unknown'` and **keeps going** — it does not strand the
line.

### Step 2 · `map` — the operator's Meituan-listing-name bridge

`routes/meituan-internal.js:157-179`. Loads every `meituan_product_map` row for this store that has a
`meituan_name`, joined to an active product. Compares through `normName()`
(`routes/meituan-internal.js:31-37`), which drops half-width parenthesised specs, all whitespace
including full-width, all punctuation, and case. Exact normalised equality first; then substring in
either direction, **but only when exactly one candidate matches**.

This is the path that exists because a Meituan listing title often is not our product name at all.

**Falls through when:** the store has no map row whose normalised channel name equals or uniquely
contains the line's, or when two or more map rows are substring candidates.

### Step 3 · `name` — a unique active product-name match

`routes/meituan-internal.js:181-189`. The fallback under examination:

```js
const clean = String(item.name || '').replace(/\([^)]*\)/g, ' ').trim();
const cjk = (clean.match(/[一-鿿]+/) || [])[0];
const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
let matches = [];
if (cjk) matches = db.prepare('… WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
if (matches.length !== 1 && en) matches = db.prepare('… WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
if (matches.length === 1) { apply(matches[0], 'name'); }
else if (…) out.matchBy = matches.length > 1 ? 'ambiguous' : 'unmatched';
```

Three things about it are worth stating precisely, because they decide how much a name change can
move it:

- It matches on the **first CJK run** and, failing that, the **first English run** of the channel's
  line name — not the whole name. `[A-Za-z][A-Za-z ]+` stops at the first hyphen or digit.
- `clean` strips **half-width** parentheses only. Meituan writes weights in full-width ones
  (`（～630g）`), which survive into the probe.
- It requires **exactly one** row. Two is `ambiguous`, zero is `unmatched`, and both mean no
  deduction.

**A line reaches step 3 only when all of: no claim, no usable SKU token, and no map hit for its
store.** In practice that is a line whose 货号 is absent or in a channel-side format we do not hold,
on a listing nobody has mapped in that store.

### The Eleme twin has never run

`eleme_order_import` holds **0 rows**, and `retail_orders` has never held a row with
`channel = 'eleme'`. `routes/eleme-internal.js`'s resolver — same four steps, same fallback — has
resolved nothing in production. Any judgement about the fallback is a judgement about the Meituan
copy.

## 2 · How load-bearing is the name step, in counts

**The honest answer first: the step that resolved a line is not recorded, so the counts you asked for
do not exist.** `retail_order_items` has no match-reason column (`product_id`, `name_en`, `name_cn`,
`sku`, `qty`, prices, `channel_food_id`, `pack_units` — nothing else), and `matchBy` is used only in
memory and then dropped. What can be counted is below.

### 2.1 · Resolved vs unresolved — complete, from the order lines themselves

Meituan, 90 days:

| | count |
|---|---|
| orders with lines | 210 |
| **lines total** | **594** |
| resolved (`product_id` not null) | 547 |
| **unresolved (`product_id` NULL)** | **47** — 7.9% |

### 2.2 · Per-step — a biased sample, the only one that exists

`meituan_sync_log` writes an `order_unsynced` row only for an order that had **at least one**
unresolved line, and that row's `detail.matched[]` carries `by` for the order's *other* lines. So this
is a sample of lines that shared an order with a failure — not of all lines. 90 days:

| step | lines |
|---|---|
| `sku` | 81 |
| `map` | 7 |
| **`name`** | **3** |
| `claim` | 0 |
| *(total sampled)* | *91* |

And the failures in those same events:

| reason | lines |
|---|---|
| `unmatched` | 31 |
| `ambiguous` | 14 |

Read carefully: within the sample the name step carries **3 of 91**. It is not nothing, and §6 shows
what those three actually did.

### 2.3 · The 47 unresolved lines, by name

| channel line name | lines | first | last |
|---|---|---|---|
| 皮塔饼（一个）Whole Wheat Pita（～80g） (加热 Heat Up) | 9 | 2026-06-29 | 2026-07-21 |
| Whole-Wheat Pita皮塔面包(一个)(Yes) | 7 | 2026-08-02 | 2026-08-24 |
| 无需餐具 No cutlery（0份） | 6 | 2026-07-07 | 2026-07-23 |
| （小）哈里萨辣椒酱 Harrisa（～30g） | 5 | 2026-07-01 | 2026-07-23 |
| 藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g） (加热Yes) | 5 | 2026-06-30 | 2026-07-20 |
| 1-380) | 3 | 2026-06-28 | 2026-07-03 |
| （小）腌红洋葱 Onion Pickles（20g） | 2 | 2026-06-30 | 2026-07-05 |
| 适量餐具 Cutlery based on product（1份） | 2 | 2026-07-03 | 2026-07-24 |
| 巧克力榛棒 Premium Nutella Bars | 1 | 2026-06-26 | 2026-06-26 |
| 加热Yes) | 1 | 2026-07-08 | 2026-07-08 |
| 加热 Yes) | 1 | 2026-08-05 | 2026-08-05 |
| Whole-Wheat Pita皮塔面包(一个 Yes) | 1 | 2026-08-07 | 2026-08-07 |
| Whole-Wheat Pita皮塔面包(一个 No) | 1 | 2026-07-15 | 2026-07-15 |
| 1-440) | 1 | 2026-06-30 | 2026-06-30 |
| 1-290) | 1 | 2026-06-28 | 2026-06-28 |
| 1-280) | 1 | 2026-06-29 | 2026-06-29 |

Three groups, and they are not the same problem:

- **8 lines are cutlery** (`无需餐具`, `适量餐具`). Correctly unresolved — they are not products, and
  nothing should come off a shelf for them. They are noise in this table, not loss.
- **7 lines are mangled name fragments** (`1-380)`, `加热Yes)`, `1-440)`, `1-290)`, `1-280)`) — Meituan
  truncating a name down to a tail. Five of them still carry a `\d+-\d+` token, which is why the
  comment at `routes/meituan-internal.js:146-149` exists; these are the residue it does not catch.
- **32 lines are real products that did not come off the shelf.** Pita alone is 18 of them.

## 3 · The 13 ambiguous events, one at a time

14 ambiguous lines across 13 events (2026-08-07 carried two). Two products, and **every one of the 14
had an empty 货号** — which is why step 1 never ran.

### 3.1 · Whole-Wheat Pita — 9 lines, all 天河

`2026-08-24, 08-12, 08-11, 08-08, 08-07 ×2, 08-05, 08-02, 07-15`

Matched against two rows that already share a name:

| id | sku | name_en | name_cn | variant_label |
|---|---|---|---|---|
| 256 | 3-251 | Whole-Wheat Pita (Frozen) | 全麦皮塔饼（冷冻） | Set of 5 Pita's |
| 351 | S(3-251) | Whole-Wheat Pita (Frozen) | 全麦皮塔饼（冷冻） | One Pita |

**Why the line was not mapped: the map was missing, and then it wasn't.** Map rows for these two:

| product | store | meituan_name | created |
|---|---|---|---|
| 256 | tianhe | 皮塔面包Whole Wheat Pita (一包5个) | 2026-06-23 03:19:04 |
| 256 | yuexiu | 【速冻 Frozen】皮塔饼（一包5个）Whole Wheat Pita（400g） | 2026-06-28 08:45:08 |
| **351** | **tianhe** | **Whole-Wheat Pita皮塔面包(一个)** | **2026-08-24 09:15:11** |

The single-pita row had **no map at all until 2026-08-24 09:15:11**. The last failure is
**2026-08-24 07:19:52** — about two hours earlier. So every one of the nine is a line that arrived
before the mapping existed, and the mapping was made after (and, from its exactness, in response to)
the failure. Before it, the only tianhe map row was the FIVE-pack's, whose normalised name
(`皮塔面包wholewheatpita`) neither equals nor contains the line's (`wholewheatpita皮塔面包` — the same
words, the other way round), so step 2 could not fire. Step 3 then found two rows sharing a name.

Both halves had to be true. Had the names differed, step 3 would have resolved it; had the map
existed, step 3 would never have run.

### 3.2 · Quinoa Salad + Pumpkin Soup — 5 lines, all 越秀

`2026-07-20, 07-18, 07-07, 07-03, 06-30`

This one is a **combo**, and the combo is registered — for the wrong store. `meituan_bundles` row 16
is `藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g）` with `store_code = 'tianhe'`, and its
components are right: 196 (`1-300` Quinoa Salad) ×1 and 258 (`1-370` Roasted Pumpkin Soup) ×1. All
five failures are at **yuexiu**, where no bundle row exists, so the combo was never expanded into its
two components and the raw combo line went to the resolver as one item.

**Why the line was not mapped: it is not a product, it is a combo, and nothing at that store says so.**
No `meituan_product_map` row can name it, because the map maps products.

The ambiguity itself: the line's full-width `（～630g）` survives `clean`, the first CJK run is
`藜麦沙拉`, and `name_cn LIKE '%藜麦沙拉%'` returns two active rows —

| id | sku | name_en | name_cn |
|---|---|---|---|
| 196 | 1-300 | Quinoa Salad | 藜麦沙拉 |
| 288 | *(none)* | Quinoa salad dressing | 藜麦沙拉酱 |

— the salad and the salad **dressing**. Two rows, so `ambiguous`.

Note what "fixing" the ambiguity alone would have done here: resolved the combo to the salad and
silently ignored the soup. §6.2 shows exactly that happening to a different combo.

## 4 · What happens to an ambiguous line

**It is recorded, it is not deducted, it is never retried, and nobody is told.**

1. **The line is stored.** `retail_order_items` gets a row with `product_id = NULL`, carrying the
   channel's name, its 货号, qty and real prices (`routes/meituan-internal.js:455-472`). The order is
   complete and correctly priced. Only the link to a product is missing.
2. **No stock moves.** `routes/meituan-internal.js:483` — `if (!it.productId) { unresolved.push(…);
   continue; }`. No ledger row, no channel re-push.
3. **One log row.** A single `meituan_sync_log` row per order, `event_type = 'order_unsynced'`,
   `status = 'warn'`, holding `{ref, deducted, matched, unresolved}` and a one-line `error_msg`
   (`:524-537`). This is the whole audit trail.
4. **No retry, ever.** `scripts/meituan-daemon.js:600-605` skips ingest entirely for an order already
   in `meituan_order_import` — it only refreshes status. Resolution runs **exactly once per order, at
   first sighting**. Mapping the product afterwards does not recover the deduction; the pita mapping
   made on 2026-08-24 fixed the tenth sale, not the nine before it.
5. **Effectively invisible to a human.** Two surfaces could show it and neither does in practice:
   - **The sync log panel** renders `recentSystem` — every non-`stock_push` event, **LIMIT 6**
     (`routes/meituan-admin.js:506-511` → `mtRenderLog('mt-log-sys', …)`,
     `public/retail-admin/11-meituan.js:187`). Non-stock events run **13-25 per day** (234
     `drift_sweep`, 107 `auto_map`, 47 `poll_paused`… in 30 days), against **8** `order_unsynced` in
     the same 30 days. A warn is off the end of that window within hours of landing.
   - **The order drawer** renders an unresolved line as ordinary text. `productHref()` returns `''`
     for a null `product_id` (`public/retail-admin/04-orders.js:2805-2808`), so the name simply is not
     a link (`:2979-2982`). No badge, no colour, no note. A person reading the order sees a normal
     line.

So: the money is right, the order is right, the shelf is wrong, and the only trace scrolls off a
six-row panel the same morning.

## 5 · What happens to an unmatched line

**Identical in every respect.** `unmatched` and `ambiguous` differ only in the string written into
`reason` inside that one log row (`routes/meituan-internal.js:189`). Same NULL `product_id`, same
skipped deduction, same single warn, same absence of retry, same silence.

The distinction is diagnostic only, and it is a real distinction worth keeping — `ambiguous` means
"we found it more than once", `unmatched` means "we did not find it" — but nothing downstream reads
it. Over 90 days it is 31 `unmatched` to 14 `ambiguous` in the sampled events.

## 6 · If the name fallback were removed, what breaks

Three lines matched by name in 90 days. They are not three of a kind, and only one is a save.

### 6.1 · A genuine save — a map that exists at the wrong store

`2026-07-07 · yuexiu · 全麦黑麦面包（3片）3 Slices Whole Wheat Bread（～150g） (加热 Heat Up) · 货号 3-250s`

The 货号 is `3-250s`; we hold `S(3-250)` (row 352). Different format, so step 1 missed. Row 352 **is**
mapped — `全麦黑麦面包Whole Wheat Bread(3片)`, but at **tianhe only** — so step 2 missed at yuexiu.
Step 3's CJK probe `全麦黑麦面包` hit row 352 uniquely and the deduction was correct.

Remove the fallback and this line stops deducting until someone maps 352 at yuexiu.

### 6.2 · A half-resolution — a combo resolved to one of its two halves

`2026-07-21 · yuexiu · 甜菜根沙拉+芹芹有味 Beet Salad+Celerybration（～660g）` · no 货号

The same shape as §3.2: a combo, with a `meituan_bundles` row (id 5, `甜菜根沙拉套餐Beet Salad Combo`)
registered at **tianhe** and not at yuexiu. Step 3's first CJK run is `甜菜根沙拉`, which resolved
uniquely to the beet salad — so **the salad came off the shelf and the drink did not**.

This is counted as a success by `matchBy`, and it is half a deduction. Removing the fallback would
change one silently-half-right line into one visibly-unresolved line.

### 6.3 · An over-deduction — a 50g side charged against a 250g tub

`2026-07-24 · yuexiu · （小）墨西哥牛油果泥 Guacamole（～50g） · 货号 3-170s`

There is exactly one guacamole row: id 44, sku `3-170`, `Guacamole` / `墨西哥牛油果泥`, mapped at both
stores as the frozen 250g listing. The line is the **small side portion**, sold under `3-170s`, which
has no row here at all. Step 1 missed (unknown code), step 2 missed (the map names the 250g tub),
and step 3's `墨西哥牛油果泥` hit row 44 uniquely — so one whole 250g tub was deducted for a ~50g side.

Removing the fallback would have left this line unresolved, which is **closer to the truth than what
it did**.

### 6.4 · The read

Of the three, one is a real save covering a cross-store map gap, one silently deducts half a combo,
and one over-deducts by roughly five times. The fallback's contribution over 90 days is one correct
deduction it alone made, and two wrong ones it alone made.

Against that, both ambiguity clusters in §3 exist *because* the fallback is the last thing tried:
without it, the 14 ambiguous lines would be reported as unresolved instead — the same NULL, the same
missing deduction, a different word in a log nobody reads.

Two more facts bear on the decision and neither is about the fallback:

- The single-pita map, made 2026-08-24, has removed the pita cluster going forward. The most
  expensive ambiguity in this data set is already closed by a mapping.
- The Eleme copy of this fallback has never resolved a line.

## 7 · Is there a surface that shows unmapped channel lines?

**No. There is a surface for unmapped PRODUCTS, and it cannot show an unmapped line.**

What exists is the Meituan tab's product list with filter chips
(`public/retail-admin/11-meituan.js:474-482`): All · **Needs attention** · Synced · Has options ·
Name not in catalogue. Per product per store, `mtStoreState()` (`:733-760`) resolves one word — a
天河 product with no `meituan_name` reads **"Add name · 待填名称"** and counts as attention.

That answers *"which of our products has nobody bridged to Meituan?"*, which is a useful question and
not this one. Three reasons it cannot surface what §3 found:

1. **It is product-first.** It enumerates `store_products` rows. A combo listing
   (`藜麦沙拉+南瓜汤`) is not one of our products, so it can never appear — and combos are 5 of the 14
   ambiguous lines and both of the half-resolutions in §6.
2. **It is store-asymmetric by design.** At 越秀 a missing name is deliberately neutral, never
   amber — *"闪购 links itself by 货号, so 'not linked' there is a fact about the listing, not a job on
   this page"* (`:731-733`). All five quinoa failures and all three name matches are 越秀.
3. **It never reads the orders.** Nothing anywhere joins `retail_order_items WHERE product_id IS NULL`
   to a screen. That query — the one that produced §2.3 — has no UI.

The nearest thing to a report is the `order_unsynced` log row, and §4.5 covers how long it stays
visible.

---

## Reproducing this

All read-only, over SSH (`ssh root@47.239.89.63 "sqlite3 -readonly -header -column
/root/roots-v2/data/roots.db '<SQL>'"`).

**Line resolution, 90 days**

```sql
SELECT COUNT(*) AS lines_total,
       SUM(CASE WHEN i.product_id IS NULL THEN 1 ELSE 0 END) AS unresolved,
       COUNT(DISTINCT o.id) AS orders
  FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
 WHERE o.channel = 'meituan' AND date(o.placed_at) >= date('now','-90 days');
```

**Unresolved lines by name**

```sql
SELECT COALESCE(i.name_en, i.name_cn) AS line_name, COUNT(*) n,
       MIN(date(o.placed_at)) first, MAX(date(o.placed_at)) last
  FROM retail_order_items i JOIN retail_orders o ON o.id = i.order_id
 WHERE o.channel='meituan' AND i.product_id IS NULL
   AND date(o.placed_at) >= date('now','-90 days')
 GROUP BY 1 ORDER BY n DESC;
```

**Per-step counts (biased sample) and failure reasons**

```sql
SELECT json_extract(m.value,'$.by') AS by_step, COUNT(*) n
  FROM meituan_sync_log l, json_each(json_extract(l.detail,'$.matched')) m
 WHERE l.event_type='order_unsynced' AND date(l.created_at) >= date('now','-90 days')
 GROUP BY 1 ORDER BY n DESC;

SELECT json_extract(u.value,'$.reason') AS reason, COUNT(*) n
  FROM meituan_sync_log l, json_each(json_extract(l.detail,'$.unresolved')) u
 WHERE l.event_type='order_unsynced' AND date(l.created_at) >= date('now','-90 days')
 GROUP BY 1 ORDER BY n DESC;
```

**The ambiguous lines, with store**

```sql
SELECT date(l.created_at) d, l.store_code,
       json_extract(u.value,'$.name') AS line_name,
       json_extract(u.value,'$.sku')  AS line_sku
  FROM meituan_sync_log l, json_each(json_extract(l.detail,'$.unresolved')) u
 WHERE l.event_type='order_unsynced' AND json_extract(u.value,'$.reason')='ambiguous'
 ORDER BY l.created_at DESC;
```

**How fast a warn scrolls off the six-row panel**

```sql
SELECT event_type, COUNT(*) n FROM meituan_sync_log
 WHERE event_type<>'stock_push' AND date(created_at) >= date('now','-30 days')
 GROUP BY 1 ORDER BY n DESC;
```
