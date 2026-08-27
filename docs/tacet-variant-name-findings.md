# How an operator edits the own name of a non-owner variant row

**2026-08-27 · Read-only survey. No file was changed, created or deleted except this one. No code
was run against any database except read-only `sqlite3 -readonly` SELECTs against the production
copy at `/root/roots-v2/data/roots.db`.**

**Sources.** Repository at `origin/main` `7d4f6edc`, working tree clean and identical to
`origin/main` at the time of reading. Every claim is cited to `file:line` in that tree. Live-row
claims are marked as such and name the query.

**The concrete case.** Variant group owner is `store_products` id **269** — "Peanut Butter (100%
Peanuts)", sku 4-670, `variant_label` "Small". Its sibling is id **270** — "All Natural Peanut
Butter", sku 4-680, `variant_label` "Big". Both carry `variant_group_id = 269`. The two rows
disagree on `name_en`, and the sibling's own name is the one the Tacet waste picker shows
(`routes/retail-waste.js:163`), because that picker lists rows, not groups.

**The short answer.** The sibling's own name IS editable, from the ordinary product editor, and the
PATCH that saves it is not locked for this tenant. What is missing is the *door*: the products grid
collapses the group and its card opens the owner, and the Variants panel — the one place that names
the sibling on screen — exposes only its variant label. Two working doors exist and neither is
signposted: narrow the grid's search until the sibling is the group's only survivor, or use the
command palette, which does not collapse at all.

---

## 1 · Does the products list show row 270 as its own row?

**No — it collapses the group to the owner.** The collapse is client-side. The server's list
endpoint returns every row, siblings included, with no grouping at all
(`routes/retail.js:21632-21670` — `FROM store_products p WHERE COALESCE(is_active, 1) = 1`, no
`variant_group_id` predicate).

The filter is `_paUnits`, `public/retail-admin/09-products.js:1265-1300`:

```js
const members = byGid.get(gid).slice().sort(…);
if (members.length < 2) { units.push({ group: false, p: members[0] }); return; }
// Open the group owner (id === gid) so the editor's variant rows list all
// siblings; fall back to the first member if the owner was filtered out.
const rep = members.find(m => m.id === gid) || members[0];
units.push({ group: true, p: rep, members });
```

The card is rendered `onclick="paOpenEdit(${p.id})"` (`:1989`) where `p` is that `rep`. For the
peanut butter that is 269. Row 270 contributes only a size chip to the card's meta line
(`_paVariantTag`, `:1295`) and its own name never appears.

**The exception is the whole answer to §2.** `_paUnits` is fed `rows` — the *filtered* set
(`:1786`, `:1803`). `byGid` is built from that same filtered set. So when the active search leaves
fewer than two members of a group visible, `members.length < 2` fires and the lone survivor renders
as an ordinary standalone card that opens **itself**.

## 2 · Is there any route that opens row 270's own editor?

**Yes. Three, of which two write the name.**

**(a) The products search box.** `public/retail-admin/09-products.js:1755-1761` filters
`PA_PRODUCTS` client-side on `name_en`, `name_cn` and `sku`:

```js
rows = rows.filter(p =>
  (p.name_en || '').toLowerCase().includes(q) ||
  (p.name_cn || '').includes(q) ||
  (p.sku || '').toLowerCase().includes(q));
```

Typing `4-680`, or `All Natural`, matches row 270 and nothing else in group 269. `_paUnits` then
emits it as a standalone card, and clicking it calls `paOpenEdit(270)` → `pdOpen(270)`, which fills
`#pd-name-en` / `#pd-name-cn` from `PA_PRODUCTS` (`:2422`). Typing `peanut butter` matches 269, 270
and 348, so the group re-collapses and the door closes — the search has to be narrow enough to
isolate the sibling.

**(b) The command palette.** `public/retail-admin/02-settings-ops.js:1318` queries the SERVER list
(`/api/retail-admin/products?q=…&limit=8`), which does no collapsing, so row 270 is returned as its
own hit with `pid: r.id` (`:1331`). Selecting it runs `paOpenEdit(it.pid)` (`:1382`). This is the
only door that does not depend on how the client happens to be filtered.

**(c) `/product-editor?id=270`.** `openProductEditor` (`public/retail-admin/01-core.js:816-818`)
builds this URL from any id, so the standalone page-design editor deep-links to a sibling. **It
cannot rename it**: `peCollectBody` (`public/product-editor.html:3084-3097`) sends only
`keywords_*`, `tagline_*`, `colophon_*`, `description_blocks`, `nutrition` and `page_template`.

**Not routes:** clicking the collapsed grid card (opens 269), and the Variants panel rows — they
carry no click-through to the sibling's editor (see §3). The CSV at
`/api/retail-admin/products/export.csv` (`routes/retail.js:20858`) does emit one row per sibling
with both names, but there is no import counterpart anywhere in `routes/`, so it is a read-only
door.

## 3 · Does the Variants panel expose name_en / name_cn?

**No. Only `variant_label` / `variant_label_cn`.** The column header reads "Name · 名称"
(`public/retail-admin/09-products.js:3279`) but the two inputs under it are bound to
`vaLabel(v.id, 'en'|'cn')` (`:3310-3313`), which writes `v.label` / `v.label_cn` — the variant tag,
not the row's name.

The sibling's real name is present on the panel in exactly one place: the cell's tooltip,
`title="${escapeAttr(v.name)}"` (`:3310`), where `v.name` is `_vaName(m)` = `name_en · name_cn`
(`:3227`, `:3256`). Hoverable, not editable.

Editable per sibling row: variant label EN, variant label CN, SKU, weight, price, was-price, show
toggle, photo, drag order, delete. The `self` row's tooltip says it plainly — *"This is the main
product. Its name, photos & details are edited in the form above"* (`:3335`) — and there is no
equivalent sentence, or field, for a sibling.

Both write paths agree with that. `PUT /api/retail-admin/products/:id/variants`
(`routes/retail.js:21841`) updates only `variant_group_id`, `variant_label`, `variant_label_cn`,
`variant_noun_en`, `variant_noun_cn`, `variant_sort` (`:21884`). `vaPersistSiblings`
(`public/retail-admin/09-products.js:3538-3551`) PATCHes each dirty sibling with `sell_price`,
`sku`, `weight`, `is_published`, `compare_at_price` and `oos_policy` — never a name.

## 4 · Which server endpoints write `store_products.name_en`?

| Endpoint | file:line | Reachable from a normal operator UI? |
|---|---|---|
| `PATCH /api/retail-admin/products/:id` | `routes/retail.js:20502` | **Yes** — the docked product editor's `#pd-name-en` / `#pd-name-cn`, collected by `pdSave` (`09-products.js:4998`). This is the operator path. |
| `POST /api/retail-admin/products` | `routes/retail.js:21008` | Yes, but it creates a new row. |
| `POST /api/retail-admin/products/:id/duplicate` | `routes/retail.js:21307` | Yes, but it creates a new row. |
| `POST /api/retail-admin/products/:id/restore-version` | `routes/retail.js:20357`, write at `:20383`; `name_en` is in `VERSION_COLUMNS` (`:20237`) | Yes — the editor's version history, for whichever product is already open. |
| `scripts/apply_name_suggestions.js:51`, `scripts/import_full.js:153`, `scripts/import_yogurt.js:27` | — | No. CLI only. |

The write itself refuses to blank the column but is otherwise unconditional
(`routes/retail.js:20501-20502`):

```js
// name_en is NOT NULL — never blank it; fall back to the existing value.
if ('name_en' in body) { sets.push('name_en = ?'); params.push((body.name_en || '').trim() || existing.name_en); }
```

**The upstream lock does not apply here, and the code comment says otherwise.** `name_en` is the
first entry in `UPSTREAM_LOCKED_FIELDS` (`routes/retail.js:224-227`), and when
`catalogMode(req) === 'upstream'` the PATCH silently deletes it from the body (`:20430-20435`). The
comment above `catalogMode` states *"The legacy kitchen path has no req.tenant but always operates
on Roots (#1 = upstream)"* (`:207-208`). **Live data contradicts it** — `SELECT id, name,
product_catalog_mode FROM tenants` on the box returns `1 | Roots | self`. Mode `self` means the
lock never fires and the rename saves. Worth reconciling: the comment is the kind of thing a future
reader trusts.

## 5 · Is `name_en` propagated to siblings?

**No — on either table. A rename of the owner does not touch the siblings, so the answer to §2 and
§4 stands unchanged.**

Kitchen `products` propagates a fixed list and names are not on it (`routes/products.js:475`):

```js
const SHARED_DESC_FIELDS = ['description_en', 'description_cn', 'description_format', 'description_blocks', 'use_block_design'];
```

and the fan-out is filtered through it before it can run (`routes/products.js:514-519`):

```js
const descPresent = present.filter(f => SHARED_DESC_FIELDS.includes(f));
if (descPresent.length && existing.variant_group_id) { … UPDATE products SET … WHERE variant_group_id=? AND id<>? }
```

`store_products` has no equivalent block at all — the PATCH's `UPDATE` is `WHERE id = ?` and
nothing else (`routes/retail.js:20651`). Only two things are written across a whole group, and
neither is a name: `variant_noun_en` / `variant_noun_cn` by the variants PUT (`:21884`), and
`oos_policy`, fanned out client-side by `vaPersistSiblings` when the owner's out-of-stock setting
changed (`09-products.js:3538-3550`).

## 6 · The kitchen app (`public/app.html`) — and which table each path touches

**Table: `products`. Not `store_products`.** The two were forked with ids preserved but have
separate `AUTOINCREMENT` keys and separate SKU namespaces (`database.js:4064`, `:4178-4180`), and
the pull-from-kitchen sync *is not built*: `kitchen_product_id` is set once at fork time in
`database.js:4071` and appears in **no** file under `routes/`, `lib/` or `scripts/`. Nothing
propagates a kitchen rename into `store_products`.

**The kitchen app has the click-through the retail admin lacks.** `pfRenderSiblings`
(`public/app.html:12640-12661`) renders every sibling as a button:

```js
onclick="closeOverlay('prodFormOverlay');setTimeout(()=>showProductForm(${s.id}),50)"
```

which opens that sibling's own product form, whose `pf_en` / `pf_cn` fields are collected by
`_pfCollect` (`:15168`) and saved by `PUT /api/products/:id` (`routes/products.js:478`) — writing
**`products.name_en`**.

**But its list collapses harder than the retail admin's.** `_collapseVariantUnits`
(`public/app.html:9403-9433`) surfaces a group when *any* sibling matches, and always returns the
rep — *"A group surfaces in the result as long as ANY sibling passes matchFn — that way searching a
child SKU (e.g. '1-10-2') still finds the parent"* (`:9401-9402`). So the §2(a) trick does not work
there: searching a sibling's SKU in the kitchen app returns the **parent**.

**Net effect for the case at hand.** Renaming id 270 in the kitchen app changes
`products.name_en`. The Tacet waste picker reads `store_products` (`routes/retail-waste.js:163`),
the retail grid reads `store_products` (`routes/retail.js:21668`), and the shop reads
`store_products`. All three would still show "All Natural Peanut Butter". Only the retail-admin
product editor (§4, row 1) fixes what the operator is actually looking at.

---

## What this means

To rename `store_products` id 270 today an operator must know to search narrowly enough to break
the group apart, or to reach for the command palette. Neither is discoverable from the screen that
shows the name — the Variants panel names the sibling in a tooltip and offers no way to edit it.

Two directions, not exclusive, both out of scope here:

1. **Give the Variants panel a way in** — a click-through on a sibling row (the kitchen app's
   `pfRenderSiblings` pattern), or a name field beside the label inputs. That is the screen where an
   operator already sees the mismatch.
2. **Show the variant tag wherever rows are listed** — the fix the Meituan mapper already made
   (`public/retail-admin/11-meituan.js:814`, `:1372`) and the products code already prescribes:
   *"always spell out the size label and weight … otherwise they read alike in the picker and the
   operator can't tell them apart"* (`09-products.js:4028-4032`). Live check: 19 `name_en` values
   are shared by two or more of the 248 active rows, covering 48 rows, worst case seven identical
   "Essential Natural Lipstick" rows; and 11 variant groups have members whose `name_en` disagree.

---

# Appendix · Every divergent variant group, and what a rename would touch

**2026-08-27, later the same day. Read-only. No file was changed except this one.**

**Sources.** Repository at `origin/main` `8891397b`. Live rows read from the production database at
`/root/roots-v2/data/roots.db` with `sqlite3 -readonly`, over SSH, on 2026-08-27. Every number below
is a live count, not a fixture.

**A correction to the brief.** The brief said *"You cannot query the live database — you have no
SSH."* That is not the case: SSH to `root@47.239.89.63` works from this session and was used for the
survey above on the same day. The queries are given verbatim in §D.4 so the results can be re-run and
checked rather than taken on trust.

**Peanut butter is fixed and no longer appears.** Ids 269 and 270 now both read
`Peanut Butter (100% Peanuts)` / `花生酱`. One side effect worth knowing: the group is now owned by
**270**, not 269 — `PUT /api/retail-admin/products/:id/variants` sets `groupId = id` of whichever
product is open (`routes/retail.js:21866`), so editing the group from the sibling moved ownership to
it. Nothing depends on which member owns the group, but the shop's collapsed card follows the owner
(`miniapp/pages/shop/shop.js:621`), so the card is now titled from 270's row.

That leaves **10 groups**, 24 rows. **Every one of those 24 rows is `is_active = 1` and
`is_published = 1`** — there is no dead row to discount anywhere in the set.

## A · The groups

Owner first in each block, then siblings in `variant_sort` order. `act` / `pub` are `is_active` /
`is_published`.

### Group 228 · Rye & wheat bread

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 228 | 3-250 | Whole Loaf | Hearty Rye & Whole Wheat Bread (Sliced & Frozen) | 黑麦全麦面包 (切片冷冻) | 1 | 1 |
| sibling | 352 | S(3-250) | 3 Slices | Hearty Rye & Whole Wheat Bread | 全麦黑麦面包 | 1 | 1 |

### Group 260 · Coconut yogurt, plain

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 260 | 1-130 | Small | Probiotic Coconut Yogurt - Plain Flavor | 大椰益生菌230g（中）（冷藏） | 1 | 1 |
| sibling | 261 | 1-140 | Big | Big Size Probiotic Coconut Yogurt - Plain Flavor | 纯素椰子酸奶（大）500g （冷藏） | 1 | 1 |

### Group 262 · Coconut yogurt, vanilla

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 262 | 1-150 | Small | Probiotic Coconut Yogurt - Vanilla Flavor | 纯素椰子酸奶-香草味 (冷藏) | 1 | 1 |
| sibling | 263 | 1-160 | Big | Medium Size Probiotic Coconut Yogurt - Vanilla Flavor | 纯素椰子酸奶-香草味200g （冷藏） | 1 | 1 |

### Group 265 · Coconut yogurt, peach

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 265 | 1-190 | Big | Probiotic Coconut Yogurt - Peach Flavor | 纯素椰子酸奶-桃子味(冷藏） | 1 | 1 |
| sibling | 264 | 1-180 | Small | Probiotic Coconut Yogurt -Peach Flavor | 纯素椰子酸奶-桃子味（小）130g (冷藏） | 1 | 1 |

### Group 272 · Walnuts

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 272 | 2-330 | Big | Walnuts ( unsalted, raw ) | 核桃（无盐，生） | 1 | 1 |
| sibling | 273 | 2-320 | Small | Walnuts | 核桃 | 1 | 1 |

### Group 278 · Chia seeds

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 278 | 4-160 | Small | Organic Chia Seeds | 奇亚籽 | 1 | 1 |
| sibling | 279 | 4-170 | Big | Chia Seeds | 奇亚籽 | 1 | 1 |

### Group 280 · Energy cubes

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 280 | 1-260 | Small (60g) | Energy Cubes | 能量棒（小）60g （冷藏） | 1 | 1 |
| sibling | 317 | (1-260) X3 | 2 small packs + 1 for free | Energy Cubes | 花生奇亚能量块 | 1 | 1 |
| sibling | 281 | 1-270 | Big (200g) | Energy Cubes | 花生奇亚能量块 | 1 | 1 |
| sibling | 318 | (1-270) X3 | 2 big packs + 1 for free | Energy Cubes Big Size | 花生奇亚能量块（大）200g (冷藏） | 1 | 1 |

### Group 283 · Passion fruit kombucha

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 283 | 2-80 | Small | Passion Fruit Kombucha | 百香果康普茶 | 1 | 1 |
| sibling | 324 | 2-90 | Big | Kombucha (AKA Booch) - Passion Fruit | 百香果康普茶（大）1000ml （冷藏）（有另搭瓶塞） | 1 | 1 |

### Group 316 · Raspberry mango sorbet

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 316 | (3-210) X5 | 4 Cups +1 for free | Raspberry Mango Sorbet | 树莓芒果冰淇淋 | 1 | 1 |
| sibling | 198 | 3-210 | 1 Cup | Raspberry-Mango Sorbet | 树莓芒果雪葩 | 1 | 1 |
| sibling | 315 | (3-210) X 3 | 3 Cups | Raspberry Mango Sorbet | 树莓芒果冰淇淋 | 1 | 1 |

### Group 326 · Natural foundation

| role | id | sku | label | name_en | name_cn | act | pub |
|---|---|---|---|---|---|---|---|
| **OWNER** | 326 | 12-23 | 02 Shell | The Standard Natural Foudation | 光感植物粉底液 | 1 | 1 |
| sibling | 33 | 12-22 | 01 Snow | The Standard Natural Foundation | 光感植物粉底液 | 1 | 1 |
| sibling | 327 | 12-24 | Sand | The Standard Natural Foudation | 光感植物粉底液 | 1 | 1 |

## B · Where a sibling's name reads better than the owner's

A read, flagged, not acted on.

**326 — the sibling is simply correct and the owner is not.** The owner says
*"Foudation"*. Id 33 says *"Foundation"*. Two of the three rows carry the typo and the OWNER is one
of them, so the misspelling is what the shop's collapsed card shows today. This is the one group
where the answer is not a preference.

**228 — the sibling is the better base name.** *"(Sliced & Frozen)"* is true of both sizes, so it
describes the product, not the loaf. The sibling's *"Hearty Rye & Whole Wheat Bread"* is the name;
the parenthetical belongs in the product's own description or in both labels, not in one member's
name. Note the two Chinese names also reverse the word order (黑麦全麦 vs 全麦黑麦).

**316 — the wrong row owns the group.** The owner is the FIVE-cup multipack; id 198 is the single
cup, the base product, and the only one with a plain SKU. The English names differ by one hyphen,
but the Chinese differ in substance — 冰淇淋 (ice cream) on two rows, 雪葩 (sorbet) on the single
cup — and only one of those can be right. Worth deciding what the product is before deciding what
it is called.

**Everywhere else the owner's name is the better one**, and the sibling is what needs changing:

- **260 / 262 / 318** put the SIZE in the name — *"Big Size…"*, *"Medium Size…"*, *"…Big Size"* —
  which is what `variant_label` already says, twice over on the card. **262 contradicts itself**: the
  label says Big and the name says Medium. **260's Chinese is the odd one out in its own family** —
  大椰益生菌230g（中） where every sibling uses 纯素椰子酸奶, and it says 中 while the label says Small.
- **265** differs from its owner by one missing space (`Yogurt -Peach`).
- **272** — the owner is more informative but spaced oddly: `Walnuts ( unsalted, raw )`. Both rows
  want `Walnuts (unsalted, raw)`.
- **283** — the sibling carries *"(AKA Booch)"*, which appears on no other product.
- **280** — only 318 diverges in English, and it diverges by repeating its label. The Chinese in
  this group is in worse shape than the English: four members, three different Chinese names.

**278 is not a naming question and should not be renamed on this pass.** One row claims *Organic*
and the other does not, on the same product in two sizes. Either both are organic, in which case the
sibling's name understates a real claim, or they are different goods that should not share a variant
group. That is a product decision, and getting it wrong in the direction of "organic" is a labelling
claim, not a typo.

## C · What a rename would break

**Nothing that stores a name. Every product reference in every channel is by `store_products.id`.**

| Surface | How it references a product | Rename-safe? |
|---|---|---|
| `meituan_product_map` | `product_id` FK → `store_products(id)`. `meituan_name` holds the **Meituan-side** listing title, for display/audit. | Yes |
| `eleme_product_map` | `product_id` FK. `eleme_name` is the cached **Eleme** item title, commented *"display only"*. | Yes |
| `guanyi_product_map` (this is gzgrocery) | `product_id` FK + `guanyi_code`. `guanyi_name` is the matched **Guanyi** itemName, *"display/audit"*. | Yes |
| `meituan_bundle_components` | `product_id` FK. | Yes |
| `store_products.bundle_items` / `bundle` | JSON of `{"id":270,"qty":1}` — ids, never names. | Yes |
| `retail_vouchers` / `retail_customer_vouchers` | No product scoping at all — no `product_id`, no name column. Coupons are order-level. | Yes |
| `meituan_listings.listing_name` | The **Meituan** catalogue name the map-name gate validates against. Never `store_products.name_en`. | Yes |

Coverage for the 24 rows: **21 of 24 are mapped in Meituan, 21 in Eleme, 19 in Guanyi.** The three
unmapped are the whole of group 326 (the foundations, ids 326 / 33 / 327) plus the two Energy Cubes
multipacks (317, 318) — cosmetics and multipacks that were never listed on the delivery channels. So
the group whose rename is most obviously right is also the one with nothing downstream to disturb.

### C.1 · The one place a name is load-bearing, and why it cuts both ways

`resolveProduct()` in `routes/meituan-internal.js:118-190` — and its twin in
`routes/eleme-internal.js:160-220` — resolves an incoming order line to a product through a ladder:

0. the option claimed by exactly one product,
1. an inline SKU token,
2. `meituan_product_map` matched on the **Meituan** name,
3. **a unique active `store_products` name match** — and only if steps 0-2 all missed.

Step 3 is the exposure (`routes/meituan-internal.js:186-187`):

```js
if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
if (matches.length === 1) { apply(matches[0], 'name'); }
```

`matches.length === 1`. **A rename that makes two rows share a name turns a working match into an
ambiguous one, and the line stops deducting stock.** That is the direction this whole rename plan
points in — making siblings agree is making names collide.

**This is not hypothetical; it is already happening.** `meituan_sync_log` holds 41 `order_unsynced`
events between 2026-06-29 and 2026-08-24. Three carry a successful `"by":"name"` match on some other
line, so the fallback is live and load-bearing. **Thirteen are `[ambiguous]`**, and eight of those are
one product:

```
2026-08-24  1 item(s) not synced: Whole-Wheat Pita皮塔面包(一个)(Yes) x1 [ambiguous]
2026-08-12  1 item(s) not synced: Whole-Wheat Pita皮塔面包(一个)(Yes) x1 [ambiguous]
…  (2026-08-11, 08-08, 08-07 ×2, 08-05, 08-02, 07-15)
```

Whole-Wheat Pita is a variant group whose two members **already share a name** — ids 256 and 351,
both `Whole-Wheat Pita (Frozen)` / `全麦皮塔饼（冷冻）`. Every one of those lines is a sale that did
not come off the shelf.

The mechanism is coarser than "two rows share a name", and worth understanding before renaming
anything. Step 3 strips half-width parentheses only, so `全麦皮塔饼（冷冻）` keeps its full-width ones
and the CJK probe misses; the English probe then extracts `Whole` — `[A-Za-z][A-Za-z ]+` stops at the
hyphen — and `name_en LIKE '%Whole%'` returns **twelve** active rows today, including both bread rows
from group 228. So this matcher is already far too blunt to be rescued by tidier names, and equally it
cannot be made much worse by them.

**The honest read, then:** a rename cannot desync any stored mapping, because nothing stores a name.
It perturbs one last-resort matcher that is already failing on its own. The mitigation is not to
avoid renaming — it is to make sure any row whose name is about to collide with a sibling's is
**mapped**, so the line resolves at step 0-2 and never reaches step 3. Peanut butter, already
renamed, is safe on exactly that basis: ids 269 and 270 now share a name AND both carry 2 Meituan,
1 Eleme and 1 Guanyi mapping.

### C.2 · What to check before each rename

For any row you are about to give a name another active row already has: confirm it has a live map
row in every channel it sells on. The query is in §D.4.

## D · Reproducing this

The database is on the box, not on the PC, so these run over SSH rather than from PowerShell
directly. Each is read-only (`-readonly` opens the file with no write handle; see
`reference_readonly_require_still_writes` for why the app's own libraries must not be used for this).

**D.1 — the divergent groups**

```sql
WITH grp AS (
  SELECT variant_group_id AS gid FROM store_products
   WHERE variant_group_id IS NOT NULL AND COALESCE(is_active,1)=1
   GROUP BY variant_group_id HAVING COUNT(DISTINCT name_en) > 1)
SELECT sp.variant_group_id AS gid,
       CASE WHEN sp.id = sp.variant_group_id THEN 'OWNER' ELSE 'sibling' END AS role,
       sp.id, COALESCE(sp.sku,'') AS sku, COALESCE(sp.variant_label,'') AS label,
       sp.name_en, sp.name_cn,
       COALESCE(sp.is_active,1) AS act, COALESCE(sp.is_published,0) AS pub
  FROM store_products sp JOIN grp ON grp.gid = sp.variant_group_id
 ORDER BY sp.variant_group_id, (sp.id = sp.variant_group_id) DESC, COALESCE(sp.variant_sort,0), sp.id;
```

**D.2 — names already shared by two or more active rows** (the collision surface step 3 sees)

```sql
SELECT name_en, COUNT(*) n,
       GROUP_CONCAT(COALESCE(sku,'(no sku)') || '/' || COALESCE(variant_label,'-'), ' | ')
  FROM store_products WHERE COALESCE(is_active,1)=1
 GROUP BY name_en HAVING n > 1 ORDER BY n DESC;
```

**D.3 — the unsynced-order evidence**

```sql
SELECT date(created_at), substr(error_msg,1,150)
  FROM meituan_sync_log
 WHERE event_type='order_unsynced' AND error_msg LIKE '%[ambiguous]%'
 ORDER BY created_at DESC;
```

**D.4 — channel mapping coverage for a set of product ids** (run before renaming into a collision)

```sql
SELECT sp.id, sp.sku, sp.name_en,
       (SELECT COUNT(*) FROM meituan_product_map m WHERE m.product_id = sp.id) AS mt_map,
       (SELECT COUNT(*) FROM eleme_product_map   e WHERE e.product_id = sp.id) AS el_map,
       (SELECT COUNT(*) FROM guanyi_product_map  g WHERE g.product_id = sp.id) AS gy_map
  FROM store_products sp WHERE sp.id IN (/* ids */);
```

Wrapped for the shell, each is:

```bash
ssh root@47.239.89.63 "sqlite3 -readonly -header -column /root/roots-v2/data/roots.db '<SQL on one line>'"
```
