# meituan — Findings

Nine findings from a read-only survey on 2026-08-26, opened by a dashboard row
("Meituan not syncing · 4") and ending somewhere else entirely: the badge that
opened it and the screen it sends you to count two different things, and the
real exposure was in neither of them.

Finding 1 is first because it is the one worth acting on, not because it was
found first. It was found last.

Most of these are not Meituan-specific. Finding 1 holds anywhere a target is
resolved by matching a truncated form of a name; finding 2 holds anywhere an
alarm and the screen it links to count different populations; finding 5 holds
anywhere a reconciliation compares our record against our record; finding 6
holds anywhere a per-row status is read as a per-target verdict; and findings 7
and 8 are the Eleme mapping-screen defects (`docs/eleme-findings.md` finding 5)
found again on a second screen, one of them verbatim.

`docs/eleme-findings.md` is the companion document and is cross-referenced
throughout rather than restated. The rules both documents produced are in
`docs/tacet-consolidation-decisions.md` §30. Those are the intent; these are the
evidence. Where they disagree about what the code does, this one is stale and
should be re-checked against the code.

Read finding 2 before finding 7. The two surfaces named in them look like one
system and are not.

---

## 1. 133 of 393 mappings sit one rename away from a neighbour, and the neighbours are size variants of themselves (found 2026-08-26)

Status: open. No code changed. **Latent, not live** — every one of the 133 is
resolving correctly today. Read this as a measured blast radius, not an incident.

**This finding is why Meituan now ranks worst of the four channels for standing
exposure**, ahead of Eleme, in `docs/tacet-consolidation-decisions.md` §30 and
in `docs/eleme-findings.md` finding 9 (rewritten 2026-08-26, v4.81). The
latent/live distinction above is recorded alongside that order, because without
it the order reads as though Meituan has been going wrong and Eleme has not,
which is the opposite of what happened: Eleme's matcher wrote to a wrong listing
at least once, Meituan's never has, and Meituan's would do more damage when it
does.

### What was measured

Of 394 mappings carrying a name, 393 resolve to their own listing on the exact
branch (finding 4). For each of those 393 the question asked was narrower than
"does it work": **if this mapping's own listing were renamed or removed
tomorrow, would the resolver refuse, or would it land on a different listing?**

**133 would land on a different listing.** No code change, no mapping change, no
notice — one edit on Meituan's side, made by a merchant for a merchant's reason,
and a stock quantity starts going to a neighbour.

### The damage does not come through whole-name containment

This is the part that matters, and it is the part
`docs/tacet-consolidation-decisions.md` §30 gets wrong (see the correction
recorded there).

The resolver's loose test is `_nameMatches` at `lib/meituan-browser.js:1129-1136`.
It looks like a one-direction substring rule — a candidate matches if it contains
our name — and read that way the exposure is almost nothing, because whole
product names are long and rarely contain each other. That reading is correct
and it is not where the damage is.

**`_nameMatches` does not only test our name against the candidate. Its middle
arm tests `_coreQuery(name)` against the candidate** —
`lib/meituan-browser.js:1132-1133` calling `lib/meituan-browser.js:1111`:

```js
  _coreQuery(term) {
    const t = String(term || '');
    const m = t.match(/^[一-鿿]+/) || t.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || t.match(/^[A-Za-z]+/);
    const c = m ? m[0].trim() : t;
    return c.length >= 2 ? c : t;
  }
```

`_coreQuery` returns the **leading same-script run** of the name and throws the
rest away. `椰子酸奶 250g Coconut Yogurt` becomes `椰子酸奶`. Every size of that
product reduces to the same four characters. The rule that reads as *"a candidate
must contain our whole name"* is in practice *"a candidate must contain our
name's leading run"*, and a family of size variants shares its leading run by
construction.

The same truncation also feeds `_searchTerms` at `lib/meituan-browser.js:1176-1191`,
which builds the fallback queries from `_coreQuery` first and then the longest
run of each other script — and those fallback terms are matched by plain
containment at `lib/meituan-browser.js:1156-1157`.

### The arm breakdown

Which test each of the 133 would land through, in the order the resolver tries
them. The exact-match preference at `lib/meituan-browser.js:1150` is what
currently stops all 133, and it is what a rename removes.

| arm | code | mappings |
|---|---|---|
| whole CN name contained in the neighbour | `_nameMatches` `:1131` | **1** |
| **`_coreQuery` core contained in the neighbour** | `_nameMatches` `:1132-1133` → `_coreQuery` `:1111` | **102** |
| whole EN name contained in the neighbour | `_nameMatches` `:1134` | **0** |
| a fallback `_searchTerms` query, matched under `requireToken` | `_searchTerms` `:1176-1191`, `_sugFromCapture` `:1156-1157` | **30** |

**One pair, out of 393, is exposed through whole-name containment.** That is the
arm §30 describes, and it is 1 of 133. The other 132 come through a truncation:
102 through `_coreQuery` directly and 30 through the fallback terms it seeds.

**The shortest-name tiebreak does not help here and may hurt.** It is at
`lib/meituan-browser.js:1159-1161` and it sorts the surviving candidates by name
length and takes the first. It was written to prefer a base product over a 套餐
combo that shares its prefix, which is what it is good at. Among size variants of
one product it has no such meaning: the shortest name in a family of four pack
sizes is whichever size the merchant happened to name most tersely. The tiebreak
makes the choice deterministic. It does not make it right.

### The families

The 133 are not a scatter of unrelated products that happen to share a character.
They cluster, and they cluster into exactly the shape that makes a mis-resolve
expensive:

- **coconut yogurt** — sizes of one product
- **walnuts, almonds, cashews** — nut lines, sizes within each
- **nut butters** — jar sizes
- **chia**
- **kombucha** — pairs
- **foaming hand soap** — the scents, which the Eleme survey already flagged as
  separate products sharing one listing (`docs/eleme-findings.md` finding 4)

And a second group, from truncation at the front of a Latin name, where a whole
family collapses into a stub that is not even a word:

- **`Whole`** — every `Whole-Wheat …`; the hyphen stops the Latin run
- **`Sun`** — every `Sun-Dried …`
- **`Caca`** — `Caca0 Nibs 可可粒`; the digit `0` stops the run. The code comment
  at `lib/meituan-browser.js:1166-1173` names this exact product as the reason
  the fallback terms were added, so the truncation was known; that it also
  widens the *match* was not.

### The consequence, plainly

**These are not strangers. They are size variants of the same product.** A
resolver that picks a stranger produces an obviously wrong number on an obviously
wrong listing, and somebody notices. A resolver that picks the 500g jar instead
of the 250g jar writes a plausible number onto a live listing that sells, and
**two live stock figures are now wrong at once** — the sibling that took the
push, and our own product, which believes it pushed and did not.

Nothing downstream catches it. The drift sweep cannot (finding 5), the push
record does not say where it landed (finding 9), and the mapping screen shows a
green dot because a name string exists (finding 7).

### What would fix it

Not a guard on the caller. Either:

- **stop matching on names** — `meituan_product_map.meituan_spu_id` already
  exists for this (finding 9), is already populated on 32 rows, and is read by
  nothing; or
- **refuse instead of guessing** — an inexact match returns no target rather than
  the best of several, which is §30 rule 4 applied to the matcher. This is what
  Eleme did on 2026-08-26 in `0a66800d`, and the measurement there said the same
  thing this one does: every named mapping already resolves exactly, so removing
  the loose branch costs nothing that works today.

---

## 2. The dashboard badge counts queue rows; the mapping screen counts mappings. They are different mechanisms and neither moves the other (found 2026-08-26)

Status: open. No code changed. **This is the finding most likely to be
misremembered**, which is why it is second rather than buried.

The dashboard row reads `Meituan not syncing · 4`, and its button says **Open
channel** — `public/retail-admin/03-dashboard.js:2844`, `goTab('meituan')`. It
lands you on the Meituan mapping screen, whose chips read `Needs attention 40`.
The two numbers are on the same journey and describe disjoint populations.

**The badge is a queue count.** `lib/channel-sync-stale.js:137-140`:

```js
      waitingCount = (db.prepare(`${LATEST_CTE}
        SELECT COUNT(*) AS n FROM latest
         WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})`
      ).get(...trading) || {}).n || 0;
```

`latest` is the newest `meituan_sync_queue` row per (store, product) —
`ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC)`
at `lib/channel-sync-stale.js:107-111`. So the badge counts **targets whose most
recent queue row is pending or error**, on trading stores only. It reads
`meituan_sync_queue` and nothing else. **It never looks at
`meituan_product_map`.**

**The chip is a mapping count.** `mtChipMatch` at
`public/retail-admin/11-meituan.js:399-406` and `mtNeedsAttention` at `:588-597`
read `p.stores` — the mapping rows — and **never look at the queue at all.**

**Therefore:**

- **Fixing every row the Meituan screen calls Needs attention will not move the
  badge by one.** All 40 of them have no mapping row on either store (finding 7),
  so none of them has ever had a queue row, so none of them is in the badge's
  population.
- **Clearing the badge will not move the chips.** The four rows behind the badge
  today (finding 3) are all mapped products; three of them read `Synced` on the
  screen the badge sends you to.

The Eleme chip and the Eleme badge have the same relationship, and
`docs/eleme-findings.md` finding 5 is about the chip only. Nothing in that
document should be read as describing this badge.

**The consequence is not cosmetic.** The badge is the alarm — it is the surface
that produced the two-day wrong number on Eleme, and it is the only one an
operator sees without going looking. Its CTA hands the operator a screen on which
the alarm's own rows are invisible, next to a count of 40 unrelated rows that
looks like the work. That is §30 rule 5 in a second costume: an alarm the
mechanism in front of you cannot clear.

---

## 3. What the four badge rows actually are: two dead, one orphan, one real (found 2026-08-26)

Status: open, and mostly not a code fault. Three of the four should not be in the
count; the code that puts them there is findings 5 and 6.

Read at 2026-08-26 against `meituan_sync_queue` and `meituan_product_map`. The
badge read 4. Earlier the same day it read 5.

| product | verdict |
|---|---|
| **158** | **In sync.** Its stock and its last landed push agree. Its newest queue row is an old `error` row the sweep can never clear. |
| **315** | **In sync.** Same shape as 158. |
| **257** | **Orphan.** A queue row with no Tianhe mapping behind it. Nothing can push it and nothing can clear it. |
| **254** | **The only real signal in the badge.** |
| **231** | **Cleared itself at 06:32:41.** Not one of the four; recorded here because it is why the badge read 5 earlier in the day. |

### 158 and 315 — correctly in sync, permanently alarmed

These two are the shape §30 rule 6 exists for: *a pending change whose desired
end state is already true is complete, whatever its recorded status.* Their shelf
stock and their `last_pushed_qty` agree. The push landed. The work is done.

Their newest queue row is nonetheless an `error` row, and
`lib/channel-sync-stale.js:139` counts `error` at `rn = 1` with no attempts
filter and no comparison against anything, so both are permanent alarm.

**The drift sweep cannot clear them, and the reason is structural.** The sweep is
the only thing that writes a fresher row (finding 6), and it only writes one for
a target that is **drifting** — `lib/meituan-drift-sweep.js:101-111`,
`m.last_pushed_qty IS NULL OR m.last_pushed_qty <> …`. A target already at the
right quantity presents no drift, so the sweep correctly does nothing, and the
dead row on top of it stays on top of it for ever.

So the sweep clears a dead row **only for targets that are broken**. A target
that is fine keeps its dead row indefinitely. That is exactly backwards from what
an operator would predict, and it is not a bug in the sweep — the sweep is doing
what it says. It is the badge reading a row the sweep was never going to touch.

This is `docs/eleme-findings.md` finding 1 with one correction: on Eleme the row
is terminal outright, and here it is terminal only while the target is healthy.
Finding 6 has the distinction.

### 257 — an orphan with no mapping

A queue row exists for product 257 on Tianhe and **no `meituan_product_map` row
does.** The drain's join at `scripts/meituan-daemon.js:843-844` is a `LEFT JOIN`,
so the row is selected, arrives with `map_id` and `map_meituan_name` null, and
cannot be pushed. Nothing retires it. The drift sweep reads
`FROM meituan_product_map m` (`lib/meituan-drift-sweep.js:91`), so a target with
no mapping row is outside its query entirely and can never be re-queued into a
fresher row either.

It is unreachable from both directions: the drain cannot complete it and the
sweep cannot supersede it. On the mapping screen product 257 is one of the 40 in
Needs attention (finding 7), where it is indistinguishable from 39 products that
are simply not sold on Meituan.

### 254 — the one real signal

The badge's only row that means what the badge says it means: a target with a
mapping, whose stock has not landed. It carries a **2026-06-23** date. See the
correction at the end of this finding — that date has been attributed to the
wrong product before.

### 231 — the fifth, and why the badge read 5

At **06:32:41** on 2026-08-26 the drift sweep wrote a fresh `pending` row for
product 231 and the drain took it. The push landed, the newest row per target
became a `done` row, and product 231 left the badge's population without anyone
touching it. The badge went 5 → 4 on its own.

Recorded because a count that changes with nobody acting reads afterwards as an
error in the count. It was not one. It is the mechanism in finding 6 working: a
target that is drifting gets a fresher row, and the fresher row is what `rn = 1`
returns.

### Correction — product 80's premise did not survive the data

> **Marked, not folded away**, in the same style as the correction inside
> `docs/eleme-findings.md` finding 8.
>
> The survey went in looking for a Meituan mapping whose name was a fragment
> pasted over itself, of the kind `docs/eleme-findings.md:439` records among the
> 11 Tianhe mappings the listings cache does not hold, and expected to find
> product 80 (Dried Sour Mango, `4-200`) among them, carrying a 2026-06-23 date.
>
> **None of that held.**
>
> - **Product 80's Meituan name was never doubled up.** No doubling is present in
>   the data and none can be shown to have been.
> - **It was fixed at 04:48:22 on 2026-08-26** and **it is in sync.** It is not
>   one of the four badge rows and there is nothing to do about it.
> - **The 2026-06-23 date belongs to product 254**, which is a different row with
>   a different fault — the one real signal above.
>
> **The prior mapping is not recoverable.** The fix replaced the row, and
> `meituan_product_map` is last-write-wins with no history. `activity_log` does
> not record channel-mapping edits on any channel — `docs/eleme-findings.md`
> finding 8 establishes that against 16,252 rows — so there is no second copy to
> read. What product 80's Meituan name was before 04:48:22 cannot now be
> established from anything stored.
>
> **That is §30 rule 7's absence demonstrating itself a second time**, and in a
> new place. The first time (`docs/eleme-findings.md` finding 9) it was a push
> that could not be traced to a listing. This time it is a mapping that cannot be
> traced to what it used to say. Same missing thing: the system recorded that a
> change happened, and not what it changed from or to.

---

## 4. The matcher replay: 393 of 394 resolve exactly, none through the substring branch (found 2026-08-26)

Status: measurement, not a defect. It is the floor finding 1 stands on and the
reason removing the loose branch would cost nothing today.

Every mapping on `meituan_product_map` carrying a name was replayed through the
resolver.

- **393 of 394 resolve on the exact branch** — `lib/meituan-browser.js:1150`,
  `cands.find(x => String(x.name).trim() === cnT)`.
- **Zero resolve via the substring branch.** Not one mapping in the table depends
  on `_nameMatches` to find its listing today.
- **One resolves to nothing: product 254**, the badge's one real row (finding 3).

That is the same result Eleme measured before removing its own loose branch — all
194 named mappings resolved exactly and none depended on the fallback
(`0a66800d`). Two channels, independently measured, same answer.

### The caveat, stated because it is load-bearing

**The live candidate pool is Meituan's own `searchSugByName`, and it cannot be
replayed offline.** The resolver types a query into the merchant page, captures
the suggest response (`lib/meituan-browser.js:1141-1145`), and matches within
whatever that response contained. That pool is a server-side ranked subset — not
our cache, not the whole catalogue, and not reproducible from anything we store.

The replay therefore substituted `meituan_listings` / `meituan_listing_specs`,
scraped 2026-08-24, as the pool.

**It was run two ways and the two agreed on all 394 rows.** That is real
corroboration and it is not the same as having run the live path: both readings
draw on the same stored catalogue, so it establishes that the replay is
internally consistent, not that Meituan's suggest would return the same
candidates.

**What this does and does not license.** It licenses *"no mapping depends on the
loose branch against the catalogue we hold"*. It does not license *"the loose
branch never fires in production"* — suggest could return a candidate set our
cache does not contain, and finding 1's 133 are measured within the same limit.
If anything, a ranked suggest pool for a truncated query is *more* likely to be
full of the same product's siblings than our flat catalogue is, so the 133 should
be read as a floor.

---

## 5. The drift sweep compares our record against our record, so a push that lands on the wrong listing shows no drift (found 2026-08-26)

Status: open. No code changed. This is the reason finding 1 is dangerous rather
than merely untidy.

The sweep is the channel's level-triggered backstop and it is good at what it was
built for. Its own header (`lib/meituan-drift-sweep.js:3-35`) says what that was:
on 2026-07-29 天河 held 502 error rows and zero pending, and "nothing was going
to fix itself."

**What it compares** — `lib/meituan-drift-sweep.js:101-111`:

```sql
       AND (m.last_pushed_qty IS NULL
            OR m.last_pushed_qty <> COALESCE(s.physical_qty, 0) / MAX(COALESCE(m.units_per_pack, 1), 1)
```

`m.last_pushed_qty` is **our note of what we sent**. `s.physical_qty` is **our
shelf count**. Both are ours. **The sweep never reads Meituan's stock.** There is
no channel read anywhere in the module.

### Why that makes a mislanded push invisible

Take a push of 12 that resolves to the wrong sibling and is accepted:

- Meituan accepts it, so the driver returns `ok`.
- The daemon writes `last_pushed_qty = 12` against **our** product.
- Shelf stock is 12. `12 <> 12` is false.
- **No drift. Never re-queued. Nothing to see.**

The sibling that took the 12 is wrong. Our own listing still holds whatever it
held. Both are wrong and the sweep's query returns neither, because the only two
numbers it compares agree.

**It heals failed pushes. It does not heal mislanded ones, and it cannot tell
them apart**, because the columns it reads are identical in both cases: a
successful push to the wrong target and a successful push to the right target
write the same row. The distinguishing fact — which listing answered — is never
stored (finding 9).

### The one stored observation of Meituan's real stock, and nothing reads it

`meituan_listing_specs.stock` exists. It is written by the catalogue scrape at
`scripts/meituan-daemon.js:1191-1201`, per spec, from the channel's own payload.
**It is the only place in the system that records what Meituan says its stock
is.**

**Last written 2026-08-24.** And nothing compares it to anything:

- `routes/meituan-admin.js:58-62` selects `store_code, listing_name, spec,
  sku_code, sku_id` — no `stock`.
- `routes/meituan-admin.js:744-750` selects `store_code, sku_code, listing_name`
  — no `stock`.
- `routes/meituan-internal.js:67` selects `sku_id` — no `stock`.
- `lib/meituan-drift-sweep.js` does not reference the table at all.

So the column that would answer §30 rule 1 — *a change is not synced until the
channel confirms it* — is populated on every scrape and read by nothing. The
read-back exists and is discarded.

**That is the cheapest available mitigation for finding 1**, and it is worth
saying plainly: a sweep arm comparing `meituan_listing_specs.stock` against
`last_pushed_qty` would catch a mislanded push on the next scrape, with no change
to the resolver and no new capture. It would not tell you *where* the push went —
only finding 9 does that — but it would tell you it did not go where you thought.

---

## 6. An error row is terminal per row, not per target — the opposite of Eleme (found 2026-08-26)

Status: open, and the distinction matters more than either fact.

`docs/eleme-findings.md` finding 1 says a failed sync row is terminal on every
channel. On Meituan that is true of the **row** and false of the **target**, and
reading it the Eleme way makes findings 3 and 5 unreadable.

**The row is dead.** The drain selects
`WHERE q.status = 'pending' AND q.attempts < 3` at
`scripts/meituan-daemon.js:845`. An `error` row is outside that query and nothing
marks it, retires it or retries it. It stays in the table for ever.

**The target is not.** The drift sweep does not resurrect the dead row — it
**writes a new one**. `lib/meituan-drift-sweep.js:194-198`:

```sql
      INSERT INTO meituan_sync_queue
        (retail_store_id, product_id, store_code, new_qty, status, last_error)
      VALUES (?, ?, ?, ?, 'pending', 'drift sweep — last push never landed')
```

The badge reads `rn = 1` — the newest row per target — so the new `pending` row
**supersedes** the dead `error` row in the count, and if it lands, the newest row
becomes `done` and the target leaves the badge entirely. The dead row is still in
the table. It is no longer the one being read.

**Product 231 is the worked example.** Its dead error row was still there at
06:32:41 on 2026-08-26. The sweep wrote a fresh pending row, the drain pushed it,
and 231 dropped out of the badge without anyone touching the error row —
finding 3's fifth row, and why the badge went 5 → 4 on its own.

**And 158 and 315 are the same mechanism failing to fire.** They are in sync, so
they present no drift, so the sweep writes them no fresher row, so their dead
error rows stay `rn = 1` and keep alarming. The mechanism that rescued 231 is the
same one that pins 158 and 315, and which one you get depends on whether the
target is broken.

**Contrast with Eleme, where they are terminal in both senses.** Eleme has no
drift sweep at all (`docs/eleme-findings.md` finding 2) — no module in `lib/`,
and the string `drift` does not appear in `scripts/eleme-daemon.js`. Nothing ever
writes a fresher row for an Eleme target, so a dead Eleme row is `rn = 1` for
ever and its target with it. The five error rows for product 195 sat that way
from 2026-08-23.

So the same sentence — "a failed row is terminal" — has a recovery path behind it
on one channel and none on the other. §30 rule 2 is satisfied on Meituan for any
target that is drifting, and on Eleme for none.

---

## 7. The chips are five overlapping filters, not a partition, and 'ok' means a name string exists (found 2026-08-26)

Status: open on the chips. **The dot is already fixed** — see below, which is why
the change needed here is narrower than the one Eleme needed.

This is `docs/eleme-findings.md` finding 5 on a second screen, and the `ok` half
of it is the same defect verbatim.

### Five filters over one set

`MT_CHIPS` at `public/retail-admin/11-meituan.js:389-397`:

```js
  const MT_CHIPS = [
    { id: 'all', en: 'All',             cn: '全部' },
    { id: 'att', en: 'Needs attention', cn: '待处理' },
    { id: 'ok',  en: 'Synced',          cn: '已同步' },
    { id: 'ms',  en: 'Has options',     cn: '有选项' },
    { id: 'bad', en: 'Name not in catalogue', cn: 'Name not in catalogue' },
  ];
```

Each renders its own count over the same set (`mtRenderChips`, `:408-418`).
**They are five independent predicates, not five groups.** `All` contains every
other chip. A product can be in `Synced` and `Name not in catalogue` at once, and
`bad` is a strict subset of `att` by construction — `mtNeedsAttention` at `:595`
returns true whenever `mtNameBad` does. The numbers do not add to 248 and were
never meant to; they read as though they should.

### 'ok' means a name string exists

`public/retail-admin/11-meituan.js:402`:

```js
    if (id === 'ok')  return maps.some(m => m.meituan_name);
```

**A non-empty string, on any store.** No catalogue check, no comparison against
anything Meituan sent, no read of whether a push ever landed. That is the Eleme
`ok` test word for word, and it is `docs/eleme-findings.md` finding 5's central
point: `sync_enabled` and a stored name are our record of our own intent, and the
screen renders them as the channel's state (§30 rule 1).

The chip therefore disagrees with the dot beside it. `mtStoreState` **does**
check the catalogue (below), so a mapping whose name the cache does not hold
draws an amber "Name not in catalogue" dot and is counted in the `Synced` chip
above it at the same moment. `docs/eleme-findings.md` finding 7 records the same
disagreement on the head tile at `public/retail-admin/11-meituan.js:216`, which
is still unfixed and is the same fault a third time on the same screen.

### All 40 in Needs attention cannot be queued by any path

`mtNeedsAttention` at `public/retail-admin/11-meituan.js:588-597` opens with:

```js
    if (!a && !b) return true;
```

No name on either store → attention. **A product with no `meituan_product_map`
row at all has no name on either store, so it lands here.** All 40 currently in
the chip are exactly that: no mapping row anywhere.

Such a product **cannot be queued by any path.** All four enqueue paths require a
mapping row:

- `lib/meituan-bundles.js:155-158` — `SELECT store_code FROM meituan_product_map
  … AND sync_enabled = 1`, and the insert is inside `if (map && …)`
- `routes/meituan-admin.js:570-574` — push-all,
  `FROM meituan_product_map m WHERE m.sync_enabled = 1`
- `lib/store-close.js:79-83` — reopen refill, same table, and
  `meituan_name IS NOT NULL` besides
- `lib/meituan-drift-sweep.js:91` — `FROM meituan_product_map m`

So it is not work that has not been done. It is a product that is not sold on
this channel. **The count can never go down by working it**, which is §30 rule 5
as a defect: an alarm with no mechanism that clears it. It is also why finding 2
matters — this is the 40 an operator is handed after clicking a badge about four
entirely different rows.

### What the same data reads under Eleme's shape

Eleme's replacement groups partition every active product into three: Needs
attention, Synced, Not on this channel (`docs/eleme-findings.md` finding 5).
Applied to the Meituan data unchanged:

| | now | under Eleme's shape |
|---|---|---|
| Not on Meituan | — | **40** |
| Needs attention | **40** | **0** |
| Synced | — | **208** |

40 + 208 = 248, the whole active set. The 40 move from an alarm nobody can clear
to a statement of fact, and the attention count becomes 0 — which is true.

### The dot is already right, so the split needed here is narrower

Eleme needed both halves rebuilt. Meituan needs one. `mtStoreState` at
`public/retail-admin/11-meituan.js:635-661` was fixed before this survey and is
already the shape Eleme's classifier was rebuilt into:

- `mtCatalogueRead(storeCode)` at `:503-505` — whether a scrape has landed
- `mtStoreState` `:647-652` asks it **first** and returns "Name not checked",
  neutral, when it is false — a check that cannot run refuses instead of
  answering (§30 rule 4, `docs/eleme-findings.md` finding 7)
- `mtNameKnown(storeCode, name)` at `:507-511` — exact match against the cached
  listing names — and `:653-655` returns amber "Name not in catalogue" when it
  fails
- both sit **before** the `sync_enabled` test at `:657`, so the switch cannot
  hide a bad name
- `mtMatchCount` at `:528-535` returns `-1` for an unread cache rather than 0

So the dot already tells the truth. **What is left is the grouping:** replace five
overlapping predicates with a partition that has somewhere honest to put the 40,
and make the `Synced` chip ask `mtStoreState` rather than ask whether a string is
non-empty. The head tile at `:216` should be brought onto the same test in the
same pass.

---

## 8. Yuexiu draws a green "Linked by SKU" dot for any non-empty name, and 187 of 187 have no SKU (found 2026-08-26)

Status: open. No code changed. Distinct from finding 7: that one is a count, this
one is a claim made about individual rows that is not checked at all.

`mtStoreState` at `public/retail-admin/11-meituan.js:635-661` takes an `editable`
flag. Tianhe 外卖 is editable; **越秀 闪购 is not**, and every name check in the
function sits inside `if (editable)` at `:646-656`.

For 越秀, then:

- no name → `{ k: 'none', t: 'Not linked' }` (`:636-638`)
- **any non-empty name → falls straight past both name checks to
  `{ k: 'ok', t: 'Linked by SKU' }`** (`:659-660`)

Nothing between those two lines looks at anything. Not the catalogue, not the
listings cache, not a SKU column, not a push record.

**The reasoning behind the skip is sound and is written down** at `:632-634` and
`:516-518`: 闪购 sets its own name from 货号, so its name is source-derived by
construction, and checking it against a scrape that may be thin would invent
amber where there is no fault. The push path corroborates it —
`lib/shangou-browser.js:200-201` looks our 货号 up in `byCode` and only consults
the name at `:203-205` when that misses.

**The skip is defensible. The green dot is not.** They are different acts. Not
checking a name is a decision not to assert anything about it; returning
`{ k: 'ok' }` with the words "Linked by SKU" **is** an assertion, and it is made
on 187 mappings on the strength of a string being non-empty.

**And the SKU it names is empty on all 187.** `meituan_product_map.meituan_sku`
(`database.js:4542`) holds nothing on every 越秀 row. The dot's own words name the
one thing on the row that could have been checked, and that is the thing that is
false. Whatever the 闪购 push path resolves by, it is not that column — it is
`item.sku` at `lib/shangou-browser.js:200`, which arrives from
`COALESCE(mm.meituan_sku, p.sku)` at `scripts/meituan-daemon.js:835` and is
therefore the **product's** own SKU on all 187, falling through the COALESCE.

**Record it as a green dot asserted rather than established.** The right shape is
the one `mtStoreState` already uses for Tianhe when it cannot check: a neutral
state that says what is and is not known. "Linked by SKU" should either be
checked — the 货号 is in `meituan_listing_specs.sku_code`, and
`routes/meituan-internal.js:67` already looks a listing up by it — or should stop
claiming to be a link.

This is §30 rule 1 once more: our record of our own intent, rendered as the
channel's state, in green.

---

## 9. §30 rule 7 on Meituan: the column exists, is populated on 32 rows, and is read by nothing (found 2026-08-26)

Status: open. No code changed. This is the Meituan half of the rule
`docs/eleme-findings.md` finding 9 produced, and Eleme has since closed its half
(`0a66800d` writes `eleme_product_map.item_id` and logs `target_name` /
`target_item_id`). Meituan has not.

### `meituan_spu_id` — a record of the target, unused

Declared at `database.js:4543`:

```js
addColumn('meituan_product_map', 'meituan_spu_id', 'TEXT');
```

Every reference to it in the tree:

| file | what it does |
|---|---|
| `database.js:4531-4532` | comment: added after the table shipped, "created by a one-off catalog script and never declared" |
| `database.js:4543` | the column |
| `scripts/meituan-apply-catalog-changes.js:21` | one-off script, `SET meituan_name = ?, meituan_spu_id = ?` |
| `scripts/_apply_yogurt_mappings.js:22` | one-off script, same |

**Populated on 32 Tianhe rows by those two scripts, and read by nothing.** No
route selects it, no daemon selects it, the drift sweep does not select it, and
the drain's join at `scripts/meituan-daemon.js:833-849` does not select it. It is
a stable channel-supplied identifier for the target, sitting on a third of the
mappings, that the push path never consults and never updates.

### `meituan_sku_id` is wired, but it is an input

Worth separating, because the two columns look alike and are opposite in kind.

`meituan_sku_id` **is** read — `scripts/meituan-daemon.js:838` selects it as
`map_spec_sku_id`, and `lib/meituan-browser.js:900-905` matches on it first,
ahead of every guess. `routes/meituan-admin.js:292-296` writes it when an
operator picks a 规格 in the admin.

But it is **the operator's answer to "which option is this?"** —
`database.js:4535-4541` says so. It is a **claim made before the push**, not a
record of where the push went. It narrows the target; it does not observe it.
Rule 7 is about the second thing, and nothing on Meituan does the second thing.

### The target never travels back

The resolver **has** the answer and discards it.

`_resolveProductIds` at `lib/meituan-browser.js:969-1035` holds `sug.spuId`,
`sug.name` and `sug.tagName` from `_sugFromCapture` (`:1163`) at the moment the
choice is made. Line `:1010` returns null when there is no `sug.spuId`, so past
that line both the id and the listing's real name are in hand. `:1014` even
prints the name — but only on the fallback-term branch, and only to the process
log:

```js
      this._log(`resolved via fallback "${usedTerm}": mapped "${key}" is actually listed as "${sug.name}" — worth correcting the mapping`);
```

That line is the closest thing to a target record on this channel, and it fires
on the branch finding 1 says is the dangerous one — but it goes to PM2 and
nowhere else, and the ordinary case (core term, exact hit) prints nothing.

Then the shape narrows. `_resolveProductIds` returns `{ spuId, skus }`, and
`updateStock` at `:872-877` passes it into `_applyStockRule` and returns that
function's verdict, which is documented at `:889-891` as **`{ ok, transient }`**
and nothing else. The caller receives exactly that —
`lib/meituan-browser.js:1617`:

```js
        r = await this.updateStock(it.targetCn, it.targetEn, it.newQty, it.sku, it.specSkuId, it.specLabel);
```

— and reduces it further at `:1622` to `{ ...it, ok, transient }`. **The spuId
that was resolved three calls down is gone before the daemon ever sees the
result.** So even if the daemon wanted to write the target, it is not given one.

### What is stored instead

`meituan_product_map.last_pushed_qty` and `.last_pushed_at`: our product, our
quantity, our timestamp. Last-write-wins, no history. The same shape as Eleme's
was, and `docs/eleme-findings.md` finding 9 already says what that costs — *"a
right match that was not recorded is indistinguishable from one that was not
made."*

Finding 3's correction is the second demonstration and it is a different one:
there the un-recoverable thing was not where a push landed but **what a mapping
used to say**, and it was lost the same way, to a last-write-wins row with no
audit trail behind it.

### What closing it takes

Three small changes, in order of how much they buy:

1. **Return the target.** `_applyStockRule` already knows `ids.spuId` and the
   matched sku; widening the return to `{ ok, transient, spuId, targetName }`
   costs nothing and unblocks everything below it.
2. **Write it.** `meituan_spu_id` is already declared and already populated on 32
   rows — set it on every successful push, and the column stops being a fossil.
3. **Log it.** `meituan_sync_log` carries no target field, exactly as Eleme's did
   before `0a66800d`. Map columns are last-write-wins; the log line is the half
   that keeps history.

---

## Context — what was and was not done on 2026-08-26

- **Nothing was written.** No mapping was created, edited, hidden or deleted; no
  queue row was retired, re-queued or cleared; no stock was pushed; no process
  was started, stopped or restarted. No code changed on this channel.

- **Product 231 cleared itself during the survey**, by the drift sweep and the
  drain doing their ordinary work at 06:32:41 (finding 3). That was the system,
  not this session.

- **Product 80 was fixed at 04:48:22**, by Ash, before this survey read the
  table. This session did not touch it, and the row it replaced is not
  recoverable (finding 3's correction).

- **Finding 1 was found last**, after findings 2 through 8 had been written up,
  by asking a different question of data that had already been read: not "does
  this mapping resolve" but "what would it resolve to if its listing changed".
  Recorded because the question is reusable and the first one is not.

- **The chips were left alone.** Finding 7 is a screen change, and the screen's
  dots were fixed in a separate, already-shipped pass; changing the grouping in
  this window would put an unverified edit on a trading day next to a build that
  had been checked.

Source: read-only queries of `roots.db` on 2026-08-26 over SSH, the matcher
replayed against the cached catalogue outside the running process (finding 4's
caveat applies to every count derived from it), and the code cited above at
`0ef56667`.
