# Handover — Eleme mapping groups

Written 2026-08-26 by the session that built this branch. It was written before
the channel name-gate landed, as a note for whoever would resolve this against
main cold. **That resolution has since been done, by this session.** What
follows is kept as the record of what was reconciled and why, not as pending
work.

State: rebased onto `c06d7b03` (the gate, on main). One conflict resolved, one
silent duplicate removed, one defect found and fixed on the way through. Cache
string `v857`. Nothing has been pushed to `main`; Ash picks that moment.

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

## 2. What the conflict actually was

Predicted four regions against the gate as first written. The gate then dropped
its classification half — `elStoreState`, `elNeedsAttention`, `elChipMatch` and
`EL_CHIPS` went back to byte-identical with main — and the surface shrank to
**one region of 14 lines**, confirmed by a real three-way merge before the
rebase and by the rebase itself.

That region is the panel's label row. The gate grew a Remove action beside the
"Eleme listing name" label; this branch inserts the row-reason sentence just
above it. **Both were kept** — they are different things that happen to sit in
one block.

`docs/eleme-findings.md` and `public/retail-admin.css` auto-merged, and both
sides survived: findings 1-6 are all present, and the gate's `.el-plbl-row`,
`.el-plink` and `.el-hint` rules sit alongside this branch's `.el-sw`,
`.el-pip` and `.el-why`.

**Normalise line endings before any scratch merge.** These files are CRLF, and
a merge run on mixed endings reports the whole file as one conflict and tells
you nothing. That cost an hour once already.

## 3. The hazard git did not flag — resolved

Both builds defined `elNameKnown`, in different regions. A three-way merge kept
**both, with no conflict marker**: the file parsed, it linted, and the later
declaration silently won. This is the thing to remember from the whole episode —
the dangerous merge was never the one git complained about.

Resolved by deleting this branch's copy and using the gate's, then asking the
gate's two questions explicitly at the call site:

```js
if (!elCatalogueRead(storeCode)) { /* no verdict */ }
if (!elNameKnown(storeCode, name)) { /* listing not found */ }
```

The `_catNames` Set this branch built was dropped with it. The gate's
`elNameKnown` re-scans the rows array per call; at 248 products that is
measurable but not felt. Reinstating the Set behind the gate's function is a
free win if this screen ever gets slow.

## 4. "Name not in catalogue" is a row reason, not a chip

The gate build first shipped it as a fifth chip. Ash's instruction to fold it
into Needs attention reached this session and not the gate's, so it was not
ignored — it had not arrived. The gate dropped it before landing.

In this model the check lives inside `elStoreState` and the row prints the
reason beside the product name. Do not re-add the chip. Three chips plus All,
every active product in exactly one, counts adding up to the list.

`EL_PENDING_CN` in `14-eleme.js` carries the English strings, tabled in
`docs/tacet-delivery-vocabulary.md` under "Channel mapping — awaiting a Chinese
source". They run English on both sides until Ash sources the Chinese. Do not
compose Chinese — §30 rule 3 and that document's Rule 4.


## 5. Versions and base — settled, and stale the moment you read it

**Re-read `main` rather than trusting any number here.** `main` moved four times
while this branch was held, once mid-commit. Other sessions push continuously.

```bash
git fetch origin && git show origin/main:public/sw.js | grep '^const CACHE'
gh run list --limit 3     # immediately before pushing, not once at the start
```

What was settled on 2026-08-26: main took v854 (referral), v855 (eligibility
dialog icon) and v856 (the name gate). **This branch carries `v857`.** The v855
and v856 figures written in earlier drafts of this note were both stale within
the hour — which is the point the section is making about itself.

## 5b. The unchecked state, and why it exists

Found while resolving, in this branch's own code — the same defect class the
gate had, pointing the other way.

With no catalogue, this branch's classifier fell through to `Synced`. And a
catalogue that FAILED to load is indistinguishable from one never read, because
`elLoadCatalogue`'s catch leaves rows empty either way. Measured against live
data with the read failing: Needs attention 10 → 6, Synced 191 → **195**, and
product 195 back behind a green dot. One dropped fetch would have restored the
exact fault this screen was built to end.

`elStoreState` now returns `k: 'unk'` when `elCatalogueRead` is false, before
any name test. §30 rule 4: a check that cannot run says so and returns no
verdict.

Two deliberate choices inside that, both cheap to reverse:

- **`unk` groups with Needs attention, not Synced.** A mapping we cannot check
  is not one we have checked. It clears itself when the catalogue reads, so the
  alarm is clearable by the mechanism that raises it.
- **Its dot stays neutral, not amber.** The cause is one store-level fact,
  already on the store's own line. 194 amber dots for one dropped fetch is the
  noise this list exists without.

Degraded mode therefore reads `0 synced · 201 need attention · 47 not on Eleme`.
That is loud. It is also true, and the alternative is 194 green lies. **Ash has
not ruled on this split** — it was built this way because it is the safe
direction and it is 0 products today.

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

Then re-run with the catalogue fetch forced to return `[]`. Expected:

```
CHIPS      All 248 · Needs attention 201 · Synced 0 · Not on Eleme 47
```

**Synced must read 0.** Any other number means something claimed a verdict from
an empty catalogue, which is the defect in §5b coming back.

Do not carry the numbers above forward as proof —
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
