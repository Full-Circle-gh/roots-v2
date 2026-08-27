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
