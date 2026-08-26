# Handover — Eleme mapping groups, resolving against main

Written 2026-08-26 by the session that built this branch, for whoever resolves it
against `main` after the channel name-gate lands. That session starts cold. This
is everything it needs that lives nowhere else.

Status when this was written: **this branch's build is uncommitted** in the
worktree. Only this note is committed. Nothing has been pushed to `main`.

---

## 1. What this build does

One screen: the Eleme product-mapping tab, `public/retail-admin/14-eleme.js`.

It replaces the "Needs attention" count. The old test called a product work when
it had no listing name **anywhere** — which counted 47 products that hold no
`eleme_product_map` row at all and therefore cannot be queued by any path
(`lib/eleme-sync.js:46` needs a row to find one). Those could never be cleared,
which is §30 rule 5 as a defect.

It also missed the one mapping that was actually broken. Product 195 has a name,
so it passed the first test; its name matches no listing, so the `specCount`
sub-query at `routes/eleme-admin.js:217` — which joins the catalogue on that
exact name — returned `NULL`, so it passed the second. It rendered as
`{ k: 'ok', t: 'Synced' }`: a green dot on a mapping whose every push resolved to
nothing for two days. Ash checked all 53 flagged products by hand and 195 was
never among them.

The new axis is **can this mapping reach the right listing** — not whether the
sync switch is on. Three groups, every active product in exactly one:

| group | count on 2026-08-26 |
|---|---|
| Needs attention | 10 |
| Synced | 191 |
| Not on Eleme | 47 |

The switch does not decide a group, on purpose: the drain's SELECT at
`scripts/eleme-daemon.js:476` carries no `sync_enabled` clause, so the flag is
read when a job is **queued** and never when it is **sent**. Product 80 pushed 25
with the switch off and no listing name at all. See `docs/eleme-findings.md`
findings 5 and 6, both added by this branch.

Second change: the sync switch is shown on each list row as a **read-only** pip
beside the store dot, a smaller twin of the panel's toggle. Read-only was a
deliberate decision by Ash, not an omission — flipping sync on from a list arms
the next stock change to push. The panel keeps the only real switch.

Files: `public/retail-admin/14-eleme.js` (+202/−59), `public/retail-admin.css`
(+21/−0, all `.el-`-only, no shared `.mt-/.el-` rule touched), `public/sw.js`,
`docs/eleme-findings.md` (+119).

## 2. The four conflict regions, and which survive the gate's amend

Measured with a real three-way merge, not predicted. **Normalise line endings
before merging anything** — all three files are CRLF, and a scratch merge on
mixed endings reports the whole file as one conflict and tells you nothing.

Against the gate commit **as first written** (`679d8074`, before its amend) there
were four conflicts:

1. the classifier block — `elGroup`/`elStatesFor` here vs the gate's edit to `elNeedsAttention`
2. `EL_CHIPS` — four chips here vs the gate's fifth chip
3. `elStoreState` — full rewrite here vs the gate's splice into the old one
4. `elPanelStore` — the row-reason sentence here vs the gate's name field and hint

The gate is amending to drop its classification half. Once it does, **1, 2 and 3
resolve cleanly** — this branch replaces base code the gate no longer touches.
**4 remains**: both sides edit the panel's name-field region, a few lines apart.
Resolve it by hand and keep both — they are different things in the same block.

## 3. The hazard git does NOT flag

Both builds define `elNameKnown`, in different regions of the file. A three-way
merge keeps **both**, with no conflict marker. The file parses and lints, and the
later declaration silently wins.

Their contracts differ, and the difference is load-bearing:

- gate: returns `false` when the store's catalogue has not been read
- this branch: returns `null` when it has not been read, and `elStoreState` tests
  `=== false` so that an unread catalogue is never treated as evidence

**Resolution: delete this branch's `elNameKnown` and use the gate's.** Then in
this branch's `elStoreState`, replace

```js
if (elNameKnown(storeCode, name) === false) {
```

with

```js
if (elCatalogueRead(storeCode) && !elNameKnown(storeCode, name)) {
```

That is exactly equivalent and uses the gate's own helpers. Do not keep two
functions with one name.

Optional: this branch also builds `_catNames`, a per-store `Set` of exact listing
names, filled in `elLoadCatalogue`. The gate's `elNameKnown` re-scans the rows
array on every call, and it is called once per product per store on every
repaint. Keeping the Set and having `elNameKnown` read it is a straight win; it
is not required for correctness.

## 4. "Name not in catalogue" is a row reason, not a chip

The gate build added a fifth chip labelled "Name not in catalogue". **Ash
instructed that it be folded into Needs attention and not shipped.** That
instruction reached this session and not the gate's, which is why it was
committed there — it was not ignored.

In this model the check already lives inside `elStoreState`, and the row prints
the reason next to the product name. Do not re-add the chip when resolving. The
grouping is three chips plus All, and every active product is in exactly one, so
the counts add up to the list.

## 5. Versions and base

- `main` was `05e33123` when both branches were cut. It is now **`ef8f3b51`**,
  three commits ahead (the referral merge).
- One of those three touches `public/sw.js`. Both rebases land on that line.
- `main` already took **v854** (`v854-referral-selected-mode`).
- The gate takes **v855**. **This branch takes `v856`.** The working tree
  currently says `v854-eleme-mapping-groups`, which is stale — change it.

## 6. How this was verified, and what to reproduce

Not by a browser. The real `14-eleme.js` was driven headlessly against fixtures
pulled read-only from production, and the counts read back out of the DOM it
writes. No classifier was re-implemented to check itself.

Fixtures: `ssh root@47.239.89.63`, then `sqlite3 -json` against
`file:/root/roots-v2/data/roots.db?mode=ro` over `eleme_product_map` (including
the `specCount` sub-query from `routes/eleme-admin.js:217`), active
`store_products`, `eleme_catalogue_cache`, and `retail_stores` joined to
`eleme_shops`. Fold the map rows the way that route does, then stub `document`,
`api`, `cuT` and `esc`, and run `elAdminInit`.

Expected, and all of it held before the rebase:

```
CHIPS      All 248 · Needs attention 10 · Synced 191 · Not on Eleme 47
PARTITION  248 = 10 + 191 + 47
ROWS       first five: 195, 80, 256, 141, 357
FILTER att rows=10   pips: on=1  off=9
DOTSTATE   Synced 191 · Not on Eleme 47 · Ready-sync-off 0 · No-option-picked 0
```

Product 195 must be **row one**, and must be the only one of the ten with its
switch on. Ready-sync-off reads 0 because every sync-off mapping today is also
broken; No-option-picked reads 0 because finding 4 is not armed. Both are real
states that happen to be empty.

Re-run this after resolving. Do not carry the numbers above forward as proof —
they were true on 2026-08-26 and the data moves.

## 7. Do not

- Do not hide or delete any mapping. Nothing here is wrong data. The rows are
  correct; the labelling was wrong.
- Do not treat "has a name but sync off" as settled — see finding 6.
- Do not raise attention on a store whose catalogue has not been read. An alarm
  that cannot be substantiated is the one that teaches people to ignore the rest.
- Do not touch the shared `.mt-/.el-` CSS rules. The three new rules are
  `.el-`-only and say why in place.
- Do not push this and the gate at the same time. Concurrent CI runs overwrite
  each other's staged deploy, and `public/*` restarts the web server while Tianhe
  is trading. Ash picks the moment.
