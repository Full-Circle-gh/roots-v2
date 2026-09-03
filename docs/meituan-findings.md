# meituan — Findings

Nineteen findings, opened 2026-08-26 by a dashboard row ("Meituan not syncing ·
4") and ending somewhere else entirely: the badge that opened it and the screen
it sends you to count two different things, and the real exposure was in neither
of them.

**Findings 1 to 9 are a read-only survey and changed nothing. Findings 10 to 19
came from later passes the same day, and FOUR OF THEM SHIPPED CODE** —
`bc0c6144` (one line in the drift sweep), `d7848b62` (the mapping-name gate and
its audit trail), `693209e3` (the same gate on bundle titles) and `93aebe1a` (the
resolver itself). Read the Context section at the end before treating this
document as the record of an untouched system.

**Finding 19 is the one finding 1 was written for**, and the only one that
changes what the resolver does. Its live half is NOT yet observed: 天河 was shut
when it deployed. Read its last section before quoting any of it as proven.

**Findings 13 to 18 came from a second survey that started where finding 1
stopped**, and the first thing it found is that finding 1's replay had never
covered the bundles. Two of them are resolving onto another product's listing
today — not latently, now — and the number they write has been right by
coincidence. Finding 13 is that. Finding 15 is the one that changes what any
fix can be built on: the offline replay and production disagree about how many
mappings use the loose branch, and production is the higher number.

**Finding 11 carries a correction that was WRONG IN THIS DOCUMENT and was acted
on before it was caught** — a client-side gate that already existed was reported
as absent, and the brief commissioning finding 12 repeated the error back. The
gate was still the right fix; the reasoning given for it was not. Marked in
place, not folded away.

Finding 1 is first because it is the one worth acting on, not because it was
found first. It was found last.

Most of these are not Meituan-specific. Finding 1 holds anywhere a target is
resolved by matching a truncated form of a name; finding 2 holds anywhere an
alarm and the screen it links to count different populations; finding 5 holds
anywhere a reconciliation compares our record against our record; finding 6
holds anywhere a per-row status is read as a per-target verdict; and findings 7
and 8 are the Eleme mapping-screen defects (`docs/eleme-findings.md` finding 5)
found again on a second screen, one of them verbatim; finding 10 holds anywhere a
self-firing recovery loop selects its targets without asking whether they are
still in use; finding 11 holds anywhere a screen auto-applies a match without
recording that a matcher made it; and finding 12 holds anywhere a rule about
external identity is enforced by the callers of a write rather than by the write
itself.

The later ones generalise further. Finding 13 holds anywhere two writers reach
one target and agree by arithmetic rather than by design — the fault is invisible
for exactly as long as the coincidence lasts, and nothing announces when it ends.
Finding 14 holds anywhere a rule is moved to the write and one of the writes is
missed, and its divergence holds anywhere a single form carries a gated field and
several ungated ones. Finding 15 holds anywhere a check is verified against a
stored copy of a thing rather than the thing. Finding 16 holds anywhere a
wholesale replace is guarded only against emptiness. Finding 17 holds anywhere a
composite's name contains its parts' names. Finding 18 holds anywhere a rule is
tightened in the place everyone reads and left alone in the place nobody does.
Finding 19 holds anywhere a check that COULD NOT RUN and a check that ran and
said no are given the same verdict — they look identical from the caller, and
only one of them is worth retrying.

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

> **The cause was found and fixed later the same day — see finding 10.** The
> drift sweep had no `is_active` filter and this product is archived. Its row is
> still in the badge and always will be: the fix stops new queue rows, it does
> not retire the old one.

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

## 10. The drift sweep had no `is_active` filter, so it chased an archived product for 1551 hours and held the store's alarm shut for 28 days (found and FIXED 2026-08-26)

Status: **fixed on `main` at `bc0c6144`**, deployed, daemons restarted, latch
observed clearing. The related absences on GZ Grocery are open and untouched.

This is the fault behind finding 3's "254 — the one real signal", and it turned
out to be worth more than the one product. The wine is the symptom. The alarm is
the finding.

### The absence

`driftingProducts` (`lib/meituan-drift-sweep.js:66`) selected on
`m.sync_enabled = 1` and never asked whether the product was still active. So a
product archived in the catalogue kept being re-queued every two hours, for ever.

Product **254** (Yasmin White 2023, `is_active = 0`, no SKU) is the live case.
Its Tianhe mapping is row 957, `Recanati Winery Yasmin White - 2023`,
`sync_enabled = 1`, `last_pushed_qty` and `last_pushed_at` both NULL. It had
drifted **1551 hours**.

**No operator could have fixed it.** The Meituan screen lists active products
only — `routes/meituan-admin.js:423` ends `AND p.is_active = 1` — so the row is
not on the screen to switch off. The fault could only be closed in code.

**The sweep is the only path that re-queues a target on its own.** Every other
enqueue needs a stock movement, which an archived product does not get, or an
operator's click:

| Path | Self-firing | Had the filter |
|---|---|---|
| drift sweep, `lib/meituan-drift-sweep.js:66` | **yes, every 2h / 30min** | no, now **fixed** |
| edge enqueue, `lib/meituan-bundles.js:153` | no, needs a stock move | no |
| "Sync now", `routes/meituan-admin.js:569` | no, operator click | no |
| reopen refill, `lib/store-close.js:79` | no, operator reopens | no |

### Not one of its 207 queue rows ever pushed

Worth stating because the status column reads as if some did. 254's rows are
**189 `error`**, and **18 `done` that are retirements, not pushes**:

| status | `last_error` | n |
|---|---|---|
| `done` | `retired: pre-fix terminal-error residue` | 13 |
| `done` | `superseded, duplicate from repeated Sync now clicks, collapsed to latest` | 3 |
| `done` | `superseded` | 2 |
| `error` | `transient push failure, retries exhausted` | 188 |
| `error` | `page.waitForTimeout: … browser has been closed` | 1 |

The drain writes `status='done', last_error='superseded'` when it collapses
same-target rows (`scripts/meituan-daemon.js:888-891`), and writes
`last_pushed_qty` / `last_pushed_at` **only** on a genuine `ok`
(`scripts/meituan-daemon.js:958-960`). Both are NULL on row 957, and
`meituan_sync_log` holds **zero** `stock_push ok` rows naming the product. So
"never synced" holds on three independent readings.

> **A `done` row on this channel does not mean a push landed.** It means the row
> is no longer live, which includes being superseded and includes being retired
> by hand. Finding 6 says the row is dead and the target is not; this adds that
> a row can be *retired* without the target ever having been reached.

### The part that matters more than the wine: §30 rule 5 was failing on 天河

`driftingProducts` has three callers, all inside the module, and the filter
reaches all three:

| Caller | Effect |
|---|---|
| `sweepStockDrift` `:191` | the intended one, archived products stop being enqueued |
| `chronicDrift` `:256` | archived products stop raising the 24h alert |
| `anyDrift` `:278` | **decides whether the latched alarm may clear** |

`alertChronic` (`:299`) fires once and latches, and its fire branch
short-circuits on an already-latched key (`if (alerts[key]) continue`). Its clear
branch needs `alerts[key] && !anyDrift(db, sc)`. Product 254 held `anyDrift`
permanently true, so:

- the latch could never clear, **and**
- while latched, **no new chronic drift on 天河 could raise an alert either.**

The evidence is on disk and in the log.
`data/alert-latch/meituan--drift_tianhe.json` held
`{"latched_at":"2026-07-29T08:21:46.801Z"}`, closed **28 days**. The last
`drift_chronic` rows in `meituan_sync_log` are:

```
10846 | yuexiu | ok    | all listings back in sync         | 2026-07-30 02:46:36
10703 | tianhe | error | 12 listing(s) drifting over 24h   | 2026-07-29 08:21:46
10696 | yuexiu | error |  4 listing(s) drifting over 24h   | 2026-07-29 08:21:37
```

越秀 fired and cleared the next day. 天河 fired and never cleared again.

**§30 rule 5**, *an alarm must be clearable by the mechanism that raised it*, was
therefore failing on 天河 by construction rather than by accident. One archived
product with sync left on was enough to silence the store's drift alarm
entirely. That is a second costume for the same rule finding 2 already puts it
in, and the more expensive one: finding 2's alarm is merely hard to act on, this
one could not go off at all.

### The fix

One line, `lib/meituan-drift-sweep.js:116`:

```sql
AND COALESCE(p.is_active, 1) = 1
```

`COALESCE`, not a bare `is_active`: unknown reads as ACTIVE, so a mapping whose
product row has gone missing keeps the behaviour it had rather than being
silently dropped. Same rule and default as `lib/bundle-stock.js:125`
`bundlesContaining`, which already carried this filter with the same reasoning:
*"an `is_active = 0` bundle is not being sold, and pushing for it would resurrect
a listing the operator archived."*

**Reactivation needs no cleanup.** The read is level-triggered, so the filter is
re-evaluated every sweep: restore the product and the next cycle sees it again
and re-queues whatever it missed. No mapping row is touched, `sync_enabled` is
never moved, no queue row is deleted.

### Verified, then observed

Verified before shipping, headless, driving the real sweep against a fixture cut
read-only out of production. Baseline on 天河: `chronic 1`, the wine, 1551 hours,
and stepping past the 2-hour cool-down the sweep's **entire** output was that one
row. Because that made a null result indistinguishable from a working filter, a
positive control was added: ten active products forced to drift.

```
BEFORE  enqueued 12  pids 1,2,3,4,5,9,10,13,16,18,193,254
AFTER   enqueued 10  pids 1,2,3,4,5,9,10,13,16,18
dropped 193,254 · added none · active dropped none · chronic 11 to 9
anyDrift  true to false, and true again the moment 254 is reactivated
```

Observed after the deploy. `meituan-sync` restarted at **07:27:00.850Z**
(restart 154 to 155, `online`, no startup error of its own). **Sixteen seconds
later:**

```
17597 | tianhe | drift_chronic | ok | all listings back in sync | 2026-08-26 07:27:16
```

and `data/alert-latch/meituan--drift_tianhe.json` **no longer exists.** The alarm
that had been jammed for 28 days cleared on the first sweep cycle, on its own,
exactly as the clear branch is written to. That sweep created no queue row, and
254's newest row is still the `error` row from 06:32:14, untouched.

### What the fix does NOT do: the badge does not move

Stated plainly because it is the obvious thing to expect and it is wrong. The
badge counts the newest queue row per target (finding 2), and this change governs
only what gets **inserted**. 254's newest row is an `error` row, nothing rewrites
it, so **254 stays in the badge indefinitely.** Measured both ways against the
same fixture:

```
PATCHED    4 -> 158/error 315/error 257/error 254/error   (sweep enqueued 0)
UNPATCHED  4 -> 158/error 315/error 257/error 254/pending (sweep enqueued 1)
```

The count is **4 either way**. What changed is that 254's row stops flipping
`error` to `pending` to `error` every two hours and simply sits there. All four
badge entries are stale rows, findings 3 and 6 already say why for each, and
**nothing in the code retires them, on Meituan or on Eleme.**

> **Correction to an assumption made in the session that produced this finding.**
> "Nothing retires dead rows on either channel" was carried over to all three
> channels. **GZ Grocery does retire its own**, in
> `scripts/guanyi-daemon.js:693-698`: `autoHeal` selects every `status='error'`
> row for the store, re-queues each at today's stock, and marks the old row
> `done` with `last_error='auto-healed, re-queued at current stock'`. That is the
> mechanism Meituan and Eleme lack, and it is the shape a fix here would take.
>
> One qualification, so the claim is not stronger than the data. Meituan rows
> **have** been retired once: 1,657 of them, all at exactly
> `2026-06-27 11:44:05`, carrying
> `last_error='retired: pre-fix terminal-error residue'`, 13 of them 254's. That
> was a single maintenance action, not a code path. No code retires them.

**Retiring the dead rows is a separate change and was not done.**

### Product 193, the second one, dropped by the same fix

**193, Quinoa Green Lentil Buddha Bowl**, `is_active = 0`, Meituan map row 895
(`藜麦扁豆杂蔬碗 Quinoa Buddha Bowl`, Tianhe, `sync_enabled = 1`). It is **not**
drifting, and only by accident: its shelf count is 0 and its `last_pushed_qty` is
0, so the comparison agrees. Move either number and it becomes 254 with a
different name.

It was created in the same bulk run as 254, see finding 11, and it is also mapped
on GZ Grocery (`guanyi_product_map` row 118). The fix drops it from the Meituan
sweep. **It remains live on the GZ Grocery paths below.**

### The same shape on GZ Grocery: present, unfixed, less dangerous

GZ Grocery has **two** self-firing level-triggered paths, and neither filters
`is_active`:

- **`reconcile`**, `scripts/guanyi-daemon.js:408`, selects
  `FROM guanyi_product_map m … WHERE m.sync_enabled = 1 AND m.guanyi_sku_id IS NOT NULL`,
  on a timer.
- **`autoHeal`**, `scripts/guanyi-daemon.js:651`, runs on the first healthy probe
  after start-up and after every recovery, re-enabling mappings the daemon itself
  switched off and re-queueing every dead row.

Product 193 is mapped there, so the shape is not hypothetical. **It is unfixed,
deliberately: it was reported before it was widened, and that scope decision was
not this session's to take.**

**Why it is less dangerous**, which is why it can wait:

1. **It targets a stable value the channel supplied.**
   `guanyi_product_map.guanyi_sku_id` is an id, not a name, so a stale mapping
   cannot resolve to a stranger's listing, and §30 rule 3 is satisfied by
   construction. On Meituan the same staleness is a wrong-target risk (finding 1).
2. **`autoHeal` retires its own dead rows**, so a permanently-failing GZ Grocery
   target does not accumulate an unbounded pile of unreachable rows the way 254's
   207 did.
3. `reconcile` diffs against Guanyi's live on-hand rather than pushing an absolute
   our-record number blind.

So the absence is the same and the exposure is not. The ordering in §30 rule 7,
GZ Grocery least exposed because it targets a stored stable id, holds here too.

### Eleme has the absence but not the mechanism

Both Eleme enqueue paths lack the filter, `lib/eleme-sync.js:42`
`enqueueProductStock` and `:62` `enqueueAll`, but **neither is self-firing**: one
needs a stock movement, the other an operator's click on push-all. And **Eleme
has no drift sweep at all**, which finding 6 already establishes.

So there is nothing on Eleme to re-queue an archived product on a timer. The
census confirms it costs nothing today: `eleme_product_map` holds **zero** rows
whose product is inactive (196 active with sync on, 1 active with sync off).
Meituan held 2 before this fix; GZ Grocery holds 1.

**Nothing was changed on Eleme.**

---

## 11. "Match names" is a third matcher, client-side, unscored and auto-applying, and it wrote the wine mapping (found 2026-08-26)

Status: the matcher itself is **unchanged**; the route it writes through was
**gated the same day — finding 12**. Recorded separately from finding 10 because
it is a property of a screen rather than of the sweep, and because it is where
finding 10's worked example came from.

> **Line numbers below are as this finding was written**, before finding 12 added
> ~123 lines to `public/retail-admin/11-meituan.js`. Symbol names are stable;
> the numbers in the corrected sections at the end of the finding are current.

### Three different matchers, and they are routinely confused

Saying this plainly, because two of them have already been mistaken for each
other once: `docs/eleme-findings.md` finding 8's correction is exactly that
mistake, a screen's verdict read as the daemon's behaviour.

| | Where it runs | How it decides | Auto-applies |
|---|---|---|---|
| **Match names** `public/retail-admin/11-meituan.js:1168` | **in the operator's browser** | **no score, no threshold**, a ladder of exact/substring tests each requiring a **unique** hit | **yes, silently** |
| `scripts/eleme-match-products.js:44` | CLI on the box, needs `--apply` | **scores** 0/60/80/95/100 over normalised CJK+Latin cores, 0.85 length-ratio guard | only at `CONFIDENT = 80` (`:69`) |
| the Meituan daemon `lib/meituan-browser.js:1129-1136` | inside the push | one-directional substring, exact-first, shortest-name tiebreak | resolves a push target |

They are three implementations of one idea and they disagree. Finding 4 replays
the **daemon's**; this finding is about the **screen's**; neither says anything
about the other.

### What Match names does, end to end

Button at `public/retail-admin.html:11002`, `onclick="mtOpenMatch()"`. That only
opens a dialog; the work starts on **Start matching** inside it.

1. `mtMatchStart()` `public/retail-admin/11-meituan.js:1130`
2. `POST /api/retail-admin/meituan/listings/refresh` to
   `routes/meituan-admin.js:700`, one `meituan_listing_jobs` row per active store
3. the daemon scrapes, `scripts/meituan-daemon.js:1141-1216`
4. polls `GET …/meituan/listings` every 3s, cap 180s, `routes/meituan-admin.js:730`
5. `mtMatchApply(stores)` `:1206` matches **in the browser**, then per confident
   match `POST …/meituan/products/:id/map` to `routes/meituan-admin.js:161`

It targets **天河 外卖 only** (`mtOutletStores()` `:1633`), skips inactive products
(`:1211`), skips mappings that already hold a name (`:1214`), and never moves the
sync switch (`mtKeepSync` `:976`).

### The ladder, and what "confident" means here

`mtMatchListing` `:1168`, in order, each step requiring exactly one hit:

1. 货号 exact in `_listingSkus`, reason `sku`
2. `name_cn` exact, reason `exact`
3. listings **containing** `name_cn`, exactly one, reason `substring`
4. more than one: disambiguate by `variant_label`, exactly one, reason `variant`;
   otherwise **`ambiguous`, not applied**
5. `name_en` lowercased, exactly one containing listing, reason `substring-en`
6. otherwise `unmatched`

Anything reaching 1 to 5 is **written immediately, with no confirmation**. The
code says so at `:1204`: *"the dialog itself is the confirmation"*. Only
`ambiguous` and `unmatched` are put to a human, as chips.

**Uniqueness is doing all the work a score would do elsewhere.** There is no
notion of a close match, a weak match, or a tie to refuse, only "exactly one
listing contains this string", which is a different question from "this is the
right listing". Finding 1 is what that costs when a name is a truncated form of
its neighbour.

### It wrote 138 mappings in under four minutes, and two of them are finding 10

`mtMatchStart` is the **only** caller of the Meituan `listings/refresh` route, so
every row of `meituan_listing_jobs` is one press. There are **24 rows across 16
distinct timestamps**, so 16 presses, from `2026-06-22 14:25:30` to
`2026-08-24 06:44:59`. One of them, `2026-07-29 08:53:30`, is 32 minutes after
the chronic-drift alert of finding 10 fired: someone reacted to the alarm by
pressing this button.

The output is visible in `meituan_product_map` created-at clusters:

```
2026-06-22 15:42  tianhe  59
2026-06-22 15:43  tianhe  63   <- row 895, product 193
2026-06-22 15:44  tianhe  14
2026-06-22 15:45  tianhe   2   <- row 957, product 254, at 15:45:06
```

138 rows in under four minutes. **Both of finding 10's archived-product mappings
were created in this one run**, and neither has been touched since: `updated_at`
still equals `created_at` on both.

> **The names came from the Paste box, not the scrape. Labelled an inference.**
>
> The 天河 scrape job that day is recorded `error`, *"scrape returned null (not
> logged in)"*, job 1, `2026-06-22 14:25:30`, and the first 天河 `done` job is
> `2026-06-24 01:37:21`, after. So no successful 天河 scrape existed when the 138
> rows were written at 15:42, and the listings cache held no 天河 names to match
> against. The escape hatch `mtOpenPaste` feeds the identical `mtMatchApply`
> (`:1429`), and it is the only other way to reach that loop.
>
> **The inference is that a human pasted a list of titles and the auto-apply took
> them.** It is not directly recorded, since nothing logs a run (below), and it is
> the only path the timestamps leave open rather than a proven one.

### The worked example: a name that was never checkable

`Recanati Winery Yasmin White - 2023`, the name Match names wrote onto product
254, **exists on no 天河 listing. 0 of 267 cached titles.** No exact hit, none
containing `Yasmin`, none containing `Recanati`.

That is the mapping the drift sweep then chased for 1551 hours (finding 10), and
it is the clean worked example of what this button can do: a name auto-applied
with no confirmation, from a source the system never verified, onto a mapping
nothing afterwards could check. The screen *can* say the name matches nothing,
`mtNameBad` `:519` renders it amber, but only once the catalogue has been read,
and saying so changes nothing.

Note the first queue row for 254 is dated `2026-06-23 03:27:06`, which is the
`2026-06-23` date finding 3 attributes to this product. Both are right: the
**mapping** is 2026-06-22 15:45:06 and the **first queue row** is 2026-06-23.
They are different columns, and finding 3's correction was about which product
owned the date, not which column.

### Nothing logs a run

- **`activity_log` holds zero rows** matching `meituan` or `map`. This is the same
  absence `docs/eleme-findings.md` finding 8 establishes against 16,252 rows,
  found again on this channel.
- The map route `routes/meituan-admin.js:161` **writes no audit entry** of any
  kind.
- `meituan_sync_log` around the last press holds only `stock_push` rows.

So there is no record of **who** pressed it, **what changed from and to**, or
**that a matcher rather than a person chose the name.** The only trace is
`meituan_listing_jobs` for the press and the timestamps on the rows it wrote for
the effect.

**§30 rule 7 is unmet here, less severely than on Eleme.** `meituan_name` at
least stores the chosen title, so the target itself is recoverable; Eleme's
finding 9 could not even say which listing took a number. What is missing on
Meituan is narrower: that the choice was *made by a matcher*, and what it
replaced. Finding 9 of this document records the same rule's other half, the
column that would record the target id existing and being read by nothing.

### The route had no catalogue gate, so the rule lived in the caller

Status of this section: **the gate was added on 2026-08-26 — see finding 12.**
The description below is of the state that produced the fault, and it carries a
correction that was shipped before it.

**Match names itself cannot write a name that is not in its own `_listings`.**
Every string it applies comes from `_listings` or `_listingSkus`, and the
"Use …" fallback chip runs through `mtSuggestionIfListed` `:966`, which composes
a name from the product and then returns `''` **unless the channel sent that
exact string back**. The load-bearing words are *its own* — see the correction.

**And the endpoint it wrote through did not check.**
`routes/meituan-admin.js:161` took `meituanName`, trimmed it, and stored it, with
no comparison against `meituan_listings` anywhere in the handler.

So the catalogue rule was **a property of the caller, not of the route** — §30
rule 3, *a value binding our record to an external system must be selected from
values that system supplied*, enforced by the callers and by nothing underneath
them.

> **Correction, 2026-08-26 — left visible on purpose**, in the same style as the
> correction in finding 3 and the one in `docs/eleme-findings.md` finding 8.
>
> This section first read: *"The same route backs the free-text field on the row
> panel … where a typed name matching nothing is **flagged amber by `mtNameBad`
> and never refused**."* **That was wrong.**
>
> - **`mtNameCommit` (`public/retail-admin/11-meituan.js:1569`) already refuses a
>   typed name the client's catalogue does not hold**, and reverts the field to
>   the stored value rather than saving. It has done since `c06d7b03`. A typed
>   non-match never reached the route.
> - **`mtNameBad` `:603` describes an ALREADY-STORED name**, not one being typed.
>   It is what paints a stored name amber when the catalogue does not carry it.
>   The two were conflated: a display rule was read as the commit rule.
>
> **This error propagated.** It was reported to Ash in that form, and the brief
> that commissioned the gate repeated it back — *"the free-text field on the row
> panel can write a name matching nothing"* — so the fault was carried into the
> instructions for fixing it. Recorded because that is the interesting part: a
> wrong finding does not stay in the document it was written in.
>
> **What does NOT change:** the route was ungated, and the gate in finding 12 is
> still the right fix. A client gate is a convention that every caller may
> decline; a route gate is a property. And the live hole was never typing —
> it is the paste path, below, which the old text did not name at all.

### The live hole was `mtPasteApply`, and it is how the wine was written

Found while building finding 12's gate. This is the mechanism the section above
was reaching for and missed.

`_listings` is a **client-side array**, and the Paste escape hatch assigns pasted
text straight into it — `public/retail-admin/11-meituan.js:1524`:

```js
    _listings[code] = Array.from(new Set(names));
```

**After that line every client check agrees the pasted string is a catalogue
name, because on the client it now is one.** `mtNameKnown` finds it.
`mtNameCommit` accepts it. `mtMatchListing` matches against it. `mtNameBad` calls
the stored result fine. Not one of those checks is wrong; they are all reading a
list that a person filled in.

That is how 2026-06-22 happened. The 天河 scrape had failed that day, so the
cache held no names, the titles came from the paste box, and 138 mappings were
written in under four minutes against a list nothing had verified — including
`Recanati Winery Yasmin White - 2023`, which 天河 has never reported.

**The route gate closes it, and the reason is worth stating precisely: it reads
`meituan_listings`, and the ONLY writer of that table is the scraping daemon**
(`scripts/meituan-daemon.js:1183-1195`, which deletes the store's rows and
re-inserts what the scrape returned; the 闪购 daemon adds to it from its own
catalogue read at `scripts/shangou-daemon.js:710`). A pasted name cannot reach
that table from any client path. The gate is not checking a better list — it is
checking a list the operator cannot write to.

### No capability gates it today

- **No `data-cap`** on the button (`public/retail-admin.html:11002`), and **no
  `can()` anywhere in `public/retail-admin/11-meituan.js`.** The client does not
  hide it from anyone.
- Server-side the capabilities exist but are **dormant**. `lib/cap-routes.js:130`
  maps `POST …/products/N/map` to `meituan:map` and the rest of `/meituan` to
  `meituan:sync`, but `routes/retail.js:149` only enforces when
  `tenant.rbac_enforce` is set, and it reads **0**.
- So **all seven active `tenant_users` pass `requireRetailAdmin`**, including two
  `kitchen` and one `warehouse` role, and any of them can auto-apply mappings on a
  live trading channel.

This is `docs/eleme-findings.md`'s reads-open / fail-open shape on a **write**
that is destructive in the §30 rule 3 sense. **Nothing was changed. It is
recorded for a decision, not fixed here.**
---

## 12. The mapping name is now gated at the route, and the write is recorded (built and SHIPPED 2026-08-26)

Status: **shipped on `main` at `d7848b62`**, deployed, CI green, all daemons back
up. This is the fix for finding 11; that finding is the evidence and this one is
what was done about it.

### The gate

`lib/meituan-map-write.js` `applyMapName()`, called by
`routes/meituan-admin.js:175` and by nothing else. **The name must appear in
`meituan_listings` for that store, byte for byte.** No override, no force flag,
no bypass parameter.

It sits in `lib/` rather than inline in the handler for one reason: the whole
behaviour can then be driven headless against a fixture. Requiring the route
pulls in `routes/retail.js` and the app's database layer, which is not read-only
— the working note at the end of this document. The lib requires **nothing**, so
a harness that loads it cannot reach production. The route adds no rule of its
own.

### Two refusal codes, and why they are not one

| code | when | what it means |
|---|---|---|
| `name_not_in_catalogue` | the store has listings, this name is not among them | a verdict about the name |
| `catalogue_not_read` | the store has **no** listings at all | the check could not run |

Both refuse, and the write is identical in both cases — so the split is not about
behaviour, it is about what the system is entitled to claim. **§30 rule 4 asks a
check that cannot run to say so rather than return a verdict.** With an empty
catalogue the comparison answers "no" for every string including the correct one,
and reporting that as *your name is wrong* is a verdict the code has no grounds
to reach. The screen's own `mtNameCommit` already made this distinction
(`MT_PENDING_CN.cannotCheck` versus `.reverted`); the route now makes the same
one, so the two surfaces cannot disagree about which fault an operator is
looking at.

Both carry the catalogue's age and name the remedy. Both are **English on both
sides**, in a `REFUSAL_PENDING_CN` const mirroring the screen's `MT_PENDING_CN`:
no sourced Chinese pair exists for either sentence and §30 rule 3 forbids
composing one. Live, on 2026-08-26:

```
That name is not one of the listings read from tianhe. The catalogue was last
read on 2026-08-24 06:46:51 UTC, so it may be out of date — refresh the
catalogue on the Meituan page, then pick the name from the list.
```

HTTP **409**, not 400: the request is well formed and the state is what refuses
it. `{ error, message, catalogue: {count, scrapedAt} }` — the admin `api()`
helper already renders `"<message> [<code>]"` and hands callers `err.code`, so
the sentence reaches the operator with no new mechanism.

### Clearing runs BEFORE the gate, deliberately

An empty or whitespace-only name is a **removal**, not a claim about a listing,
so there is nothing to verify and the gate must not stand in its way. The
ordering is load-bearing rather than incidental: gating the clear would freeze
every product whose stored name no longer verifies — which is product 254 today,
the one row in the estate that fails the check. A fault that makes its own
subject unremovable is worse than the fault it replaces.

### Write-time only, no sweep

**The gate never reads existing rows and nothing re-checks them.** A stored name
that does not verify stays exactly as it is — name, switch and `updated_at`
untouched — and is refused only if someone writes that name again. Product 254
still holds `Recanati Winery Yasmin White - 2023` with `sync_enabled = 1` and
`updated_at = 2026-06-22 15:45:06`, before the deploy and after it.

Nor does the gate hold a grudge: if 天河 lists that wine again, the next
catalogue refresh picks the name up and the same write is accepted. Verified.

**Re-saving all 394 stored names gives 393 accepted and 1 refused**, and the 1 is
the wine. Nothing else in the estate is affected by the gate's arrival.

### The catalogue got its own refresh

Until now the only way to update `meituan_listings` was to run Match names — the
thing being gated. That is the wrong shape once a stale catalogue is what refuses
a write: the operator meets a refusal and the remedy must not be the action that
was refused. `mtRefreshCatalogue()` enqueues the scrape through the **same**
route the matcher uses (`POST …/listings/refresh`), polls, reloads the cache, and
**applies nothing** — it never calls `mtMatchApply`, `mtWriteMap` or the map
route. Proved by a sha256 over every column of every `meituan_product_map` row,
identical across both the route's enqueue and the daemon's catalogue replace.

`GET …/listings` now also returns `catalogue: { store_code: {count, scrapedAt} }`,
and the screen carries a row beneath the store lines saying how many names each
store reported and when. It could not say that before: on 2026-08-26 天河 was
267 names from 2026-08-24 and 越秀 203 from 2026-08-23, and nothing on screen
showed it. The row sits with the store lines rather than in the header because
§1.7 caps the header at three elements, and because a refusal points there.

**Match names itself was not changed.** Gating the route it writes through was
enough for this pass; changing the matcher in the same change would have made
neither half verifiable.

### The write is recorded — §30 rule 7, partly

Finding 11 records that nothing logged a mapping change. Now something does.

**Mechanism: `logActivity` (`middleware/auth.js:43`)** — the audit writer this
realm already uses (`routes/retail.js` calls it), whose `activity_log` table is
already backed up and already on a 90-day retention job. A new table would have
been a second thing to purge, back up and remember to read.

| | |
|---|---|
| events | `meituan_map_create`, `meituan_map_name`, `meituan_map_clear` |
| entity | `meituan_product_map`, id = the product |
| details | `store_code`, `from`, `to`, `source`, `sync_enabled`, `spec_cleared` |
| actor | `username` from the session |

`from` and `to` are the point: `meituan_product_map` is last-write-wins with no
history, which is why product 80's previous name could not be recovered (finding
3's correction). From now on it can be.

**`source` is CALLER-DECLARED, not established.** The client says `match_names`,
`manual` or `remove`; **nothing server-side can tell a matcher from a person**,
because both arrive as the same POST from the same session. It is a claim in the
trail rather than a fact, and it is recorded that way here so a later reader does
not treat it as evidence. It is still the difference between knowing and not
knowing — finding 11 had to reconstruct the answer from row-creation timestamps.

**A refusal writes no audit row.** It is not a change.

### Known, pre-existing, not fixed: `activity_log.user_id` can name the wrong person

Found while testing the audit path. **Not introduced by this change, not fixed by
it, and not being worked on** — written down so it is not rediscovered as new.

`tenant_users` and `users` are separate id sequences **and they collide**:
`tenant_users#6` is `warehouse`, `users#6` is `asher`. `logActivity`'s FK guard
(`middleware/auth.js:50-51`) only checks that *some* `users` row exists for the
id, so for a colliding id it keeps it, and the row ends up carrying one person's
id beside another person's username. Where there is no collision (`tenant_users#5`,
`jass`) the id is correctly nulled and the username kept, which is the documented
behaviour.

**Read the `username`. Never the `user_id`.** This affects every route that logs
from the tenant realm, not only this one, which is why fixing it belongs to
shared middleware and not to a channel change.

### Verification

53 assertions, all passing, headless against a fixture cut read-only out of
production (394 mappings, 470 listings, 16,255 activity rows): a present name is
written and audited, an absent one is refused with its reason and writes nothing,
blanking works including on 254, Match names applies against a current catalogue
and is refused against a stale or pasted one, the refresh leaves the mapping
table identical by sha256, and the audit row carries `from` and `to`.

After the deploy, the refusal path was exercised against the **live** database on
a read-only handle — it returns before any write, so it can be run that way, and
the acceptance path deliberately was not, because accepting is a write. `芒` —
the one-character fragment from `docs/eleme-findings.md` finding 9 — is refused.

---

## 13. Two bundles push their stock onto other products' listings, and the number has been right by coincidence (found 2026-08-26)

Status: open on the data. **Live, not latent** — this is finding 1's damage
happening, not finding 1's blast radius measured. The gate in finding 14 stops
new ones from being typed; these two are still in the table and still resolving
onto a neighbour every cycle.

`meituan_bundles` is Meituan's own combo concept — 19 rows, all 天河 — and a
bundle is pushed through exactly the same driver as a product:
`batchUpdateStock` → `updateStock` → `_sugFromCapture`, with `targetCn` set to
the bundle's title and `targetEn` and `sku` both null
(`scripts/meituan-daemon.js:917`). **Finding 4's replay covered
`meituan_product_map` and never touched them**, which is why this sat under a
survey that had already read the matcher twice.

Replayed the same way: **17 resolve exactly. Two do not.**

| bundle | stored title | resolves to | who owns that listing |
|---|---|---|---|
| **2** | `纯素咸芝士+玉米片Nachos + Creamy Dip` | `【速冻】纯素咸芝士酱 Frozen Nachos Dip` | product 9, SKU `3-230` |
| **16** | `藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g）` | `素食藜麦沙拉 Quinoa Salad` | product 196, SKU `1-300` |

Both through `_coreQuery` (`lib/meituan-browser.js:1111`) into `_nameMatches`
`:1132`, resolved by the shortest-name tiebreak at `:1159-1161`. Both were
pushing on the morning of 2026-08-26 — bundle 2 at 8, bundle 16 at 3, both at
09:28.

### Bundle 2 is one space

Its listing does exist. It is `纯素咸芝士+玉米片Nachos␣␣+ Creamy Dip`, with
**two** interior spaces where the stored title has one — 45 bytes against 44,
differing by exactly one `0x20` after `Nachos` and nothing else. Every space in
both strings is a plain ASCII `U+0020`; there is no NBSP and no fullwidth space
involved.

The exact test is `String(x.name).trim() === cnT` at
`lib/meituan-browser.js:1150`. `trim()` removes surrounding whitespace and does
not collapse interior whitespace, so **the exact branch can never fire for
bundle 2**, live or offline, for as long as that title is stored. It falls
through to the core `纯素咸芝士`, which the dip's listing also contains, and the
shortest name wins.

### Bundle 16's listing was removed from Meituan

It is not in the 271-listing catalogue read at **2026-08-26 09:01:55** — a fresh
read, via the API path (`tagList` + `getSpuListCommon` per category), not the DOM
fallback.

But it existed and it sold. Five Meituan orders carry the line
`藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g） (加热Yes)` between
2026-06-30 and 2026-07-20, under a title matching the bundle's byte for byte
(the ` (加热Yes)` is the order's attribute suffix, not part of the title).

And the spu numbering places it. 天河 holds a contiguous family of nine combo
listings, spu `21219302743` through `21219302752`, and **exactly one number is
missing — `21219302748`** — sitting between `罗勒鸡肉卷 Pesto Wrap+Kombucha`
(…747) and the nachos combo (…749). Bundle 16's is the hole. Nothing has sold on
it in 37 days.

So the listing was **removed** — deleted or moved to the recycle bin, which the
scrape cannot see because it passes `inRecycleBin: 0`. That cannot be proved from
stored data; what can be said is that a fresh full-category read taken today does
not contain it and its spu id is a gap in an unbroken run. **A catalogue refresh
will not bring it back unless the merchant restores the listing first — and
running the refresh is exactly how to tell which world we are in.**

### Why a wrong number has been invisible

This is the part worth carrying elsewhere.

- Bundle 2 = Nacho Cheese Dip **8** + Tortilla Chips **15** → floor **8**. It
  lands on the dip's listing, and product 9 pushes **8** to that same listing.
- Bundle 16 = Quinoa Salad **3** + Roasted Pumpkin Soup **112** → floor **3**. It
  lands on the salad's listing, and product 196 pushes **3** to that same
  listing.

**The bundle writes the correct number only for as long as the product that owns
the listing it lands on is the scarcer component.** Nothing enforces that, and
nothing would notice when it stopped being true. The margins:

- **Bundle 2 — margin 7.** Tortilla Chips falling from 15 to 7 or below makes the
  chips the floor, and the bundle then writes the chips' count onto product 9's
  live listing while product 9 writes 8. Last write wins, so neither figure is
  reliably the one that survives. A restock of the dip past 15 does the same
  thing from the other side. Chips have sold 8 units across 7 orders since
  2026-07-01, so this is weeks away rather than days — but it is the one that
  moves.
- **Bundle 16 — margin 109.** The soup would have to fall from 112 to 2 or below.
  Effectively never, so bundle 16 will go on being invisibly correct, for
  entirely the wrong reason, indefinitely.

Nothing downstream catches either. The drift sweep compares our record against
our record (finding 5). The push record does not say where the push landed
(finding 9). The driver's own log line names the BUNDLE, not the target —
`stock updated: 纯素咸芝士+玉米片Nachos + Creamy Dip → 8` is what a mis-landed
push prints, and it is indistinguishable from a correct one.

### The combo listing nothing writes to

`纯素咸芝士+玉米片Nachos␣␣+ Creamy Dip`, spu `21219302749`, as read at
09:01:55 on 2026-08-26:

```
{"id":37518213698,"spec":"1人份","stock":98,"maxStock":99,"price":98,
 "autoRefresh":0,"skuCode":"","boxNum":1,"boxPrice":0,"stockMode":0}
```

**98 units at ¥98, against a cap of 99, with auto-replenish off.** Nothing on our
side has ever pushed 98 — bundle 2's pushes across 28 days of process log are 3,
4, 5, 8 and 9. It is a number someone set once and which has stood ever since,
precisely because our pushes have been going to the dip.

**Whether it is on-shelf cannot be established from stored data, and that is
worth stating rather than guessing.** The catalogue scrape passes
`tabStatus: -1`, which deliberately includes off-shelf listings, and it stores
only the sku payload — the spu's sale status is read and discarded
(`lib/meituan-browser.js:1541-1556`). Against it: the combo has **never been
ordered**, zero lines across 1,844 `meituan_orders` rows and 211 Meituan
`retail_orders` going back to 2026-06-25. A listing showing 98 in stock for two
months with no sale is as consistent with off-shelf as with live-and-unpopular.
One look at the listing on Meituan settles it, and nothing in the database will.

### And one bundle does nothing at all

**Bundle 3** — `美式豆泥蔬沙拉套餐Chickpeas Salad Combo`, sync on, title verifies
— has **no components**. `enqueueBundle` returns null for a bundle with no
components, so it has never pushed and never will. Not a fault; a row that looks
live on the screen and is inert.

---

## 14. `meituan_bundles.meituan_name` had none of the four protections the product field had, and that is how both were typed in (found and FIXED 2026-08-26)

Status: **fixed on `main` at `693209e3`**, deployed, CI green in 1m35s.

Finding 12 moved the mapping-name rule to the write, where no caller could
decline it. It moved it to **one** write. The other table whose name column means
"a listing on this store" was left exactly as it had been.

### What the product field had, and the bundle field did not

| | product mapping name | bundle title |
|---|---|---|
| datalist of real listing names | `11-meituan.js:930` | — |
| client commit that reverts a non-catalogue value | `mtNameCommit` `:1569` | — |
| server refusal | `applyMapName` via `d7848b62` | — |
| audit entry on the write | `logActivity` `meituan-admin.js:191` | — |

The route took the string, trimmed it, and wrote it
(`routes/meituan-admin.js:641-645`). The client checked that it was non-empty
(`mtSaveBundle`). That was the whole of it, on both sides. **A title matching
nothing could be typed and saved silently, and that is how bundle 2's one space
and bundle 16's dead listing both came to be stored.**

### The fix

**One rule, one copy.** `verifyName(db, storeCode, name)` comes out of
`applyMapName` into `lib/meituan-map-write.js` as an exported function and is
called by both routes. `applyMapName`'s inline gate was 19 lines; it is now two.
The two refusal codes, their messages and the `catalogue` payload are unchanged,
so the map route answers exactly as it did — verified below and again after the
deploy.

The bundle route returns the same 409 shape, so the client's `e.code` branches
and the `api()` helper's `"<message> [<code>]"` rendering already work, and it
now writes a `logActivity` entry (`meituan_bundle_name` / `meituan_bundle_create`,
carrying `from` → `to`). `meituan_bundles` was last-write-wins with no history —
the same shape `meituan_product_map` had before `d7848b62`, and the same reason
bundle 2's original title could not be recovered.

### The one place the shape differs from the map route, and why

**The bundle route gates a title that is NEW or moved to another store. A title
re-submitted exactly as stored is not gated.** The map route gates every name
write including an unchanged one. That divergence is deliberate and structural.

On the map route, a name and its switch are separate concerns with separate
actions, and clearing is checked *before* the gate — which is what keeps product
254 removable rather than frozen. **On the bundle route a single POST carries the
title, the cap, the switch and the components together.** Gating an unchanged
title would freeze all four with it: bundle 16, whose listing is gone and whose
stored name can never verify again, could not be switched off, re-capped, or have
a component corrected. That is the trap §30 rule 4 warns about — a check that
refuses the remedy along with the fault.

The exemption is not a hole. The only titles that can pass unchecked are ones
already in the table, and every path that could put one there is now gated. What
it does mean is that **the gate does not retroactively refuse the two bad titles
already stored** — bundles 2 and 16 still have to be corrected by hand.

### The screen, and the whitespace problem the product field never had

The field gets the listings datalist, a commit that reverts anything not in the
catalogue, and a line under it saying which of three states it is in.

A check alone would not have been enough here, and this is the part worth
carrying. **Bundle 2's title differs from its listing by one space, and browsers
collapse runs of whitespace when they render text**, so on the bundle list the
right title and the wrong one drew identically. An operator retyping by eye could
neither produce the correct title reliably nor confirm afterwards that they had.
So the answer was to make typing unnecessary rather than to make the operator win
a fight they cannot see: **picking from the datalist inserts the listing's own
bytes**, and a whitespace difference cannot be created that way. Typing still
works and a typed value is still checked; it simply stopped being how the job is
done. `.mt-brow .bn` also gets `white-space: pre-wrap`, so a doubled space is
**visible** in the list — which is how the correction gets confirmed by looking.

Both commit branches normalise the field to the trimmed value, so what is on
screen is always exactly what Save will send.

### `mtSaveBundle` was sending a hard `syncEnabled: 1`

Found while wiring the above and fixed in the same commit. Every bundle save sent
`syncEnabled: 1` regardless of the row's actual state, so **saving a component
fix silently switched a paused bundle back on** — the one thing you least want
done for you on a bundle whose title no longer resolves. It now sends the row's
own flag.

**There is still no on/off switch in the bundle editor.** The route accepts
`syncEnabled` and always has; the screen has never offered a control for it. So
"turn this bundle off" is an API-only operation today, and from the screen the
only way to stop a bundle pushing is Delete. Recorded because an earlier draft of
this survey said the screen could turn a bundle off, and it cannot.

### Verified

Against a detached snapshot with the real route mounted in express — the three
modules that would open the live database (`lib/tenant-db`, `routes/retail`,
`middleware/auth`, all of which `require('../database')`) placed in
`require.cache` first, so `../database` is never evaluated.

- The corrected two-space title is accepted and stored byte for byte; the audit
  entry carries `from` → `to`.
- The one-space title is refused, `name_not_in_catalogue`, message and catalogue
  state reaching the caller, nothing written.
- An unread store answers `catalogue_not_read`, not a verdict.
- Bundle 16's switch, cap and components all save while its title does not
  verify; changing its title to another bad one is refused; deleting it works.
- All 19 bundles re-save under their own stored titles — 19 accepted, 0 refused,
  no sync flag flipped. With any title altered by one character, 0 accepted, 19
  refused.
- All 398 named mappings replayed through the real `applyMapName`: **397
  accepted, 1 refused — map 957, the wine.** The same answer as before the
  change. Clearing is still ungated.

The client half was checked the same way, the new functions lifted verbatim by
name out of `11-meituan.js` and run against the real 271/203 listing names: the
corrected title accepted, the one-space title reverted, an emptied field reverted
rather than unnaming the bundle, bundle 16's own title left alone and labelled as
a fact about the listing rather than a typing error, an empty catalogue answering
"cannot check" and not amber, and a 天河 listing refused on 越秀.

**The two routes share no write path.** The bundle handler writes only
`meituan_bundles` and `meituan_bundle_components`; `meituan_product_map` appears
in that block once, in a comment. The only shared code is `verifyName`, which is
two SELECTs and writes nothing.

---

## 15. Offline, zero of 398 mappings use a loose branch. Live, three do. (found 2026-08-26)

Status: open, and it is the finding that decides the shape of any exact-only
rule. **It corrects finding 4's licence, not its arithmetic.**

Finding 4 replayed every named mapping against the stored catalogue and found 393
of 394 resolving on the exact branch and none on the loose one, and stated the
caveat that the live candidate pool is `searchSugByName` and could not be
replayed. That caveat has now been tested against the process log, and the two
answers differ.

**Offline, re-run 2026-08-26 against 398 named mappings** (four more than finding
4 saw), both stores, with two independent pool models that agreed on all 398:
**397 exact, 1 resolving to nothing (map 957, the wine), zero loose.**

**Live, from 28 days of `meituan-sync` process log, three mappings resolve only
through the fallback arm**, and all three fired within 33 hours of the reading:

| map | product | SKU | stored name | `_coreQuery` | term that worked | resolves to |
|---|---|---|---|---|---|---|
| 819 | 10 Olive N' Cream | `1-80` | `OliveN‘Cream 地中海橄榄酱` | `OliveN` | `地中海橄榄酱` | its own listing |
| 817 | 139 Cacao Nibs | `2-310` | `Caca0 Nibs 可可粒` | `Caca` | `可可粒` | its own listing |
| 873 | 79 Za'atar | `4-630` | `Za‘atar绿百里香粉` | `Za` | `绿百里香粉` | its own listing |

(A fourth, `Old FashOld Fashioned Oats 传统快熟燕麦ioned Oats 传统快熟燕麦`, fired
16 times through 2026-08-25 and has since been removed from the table.)

All three resolve **correctly** — each fallback term is carried by exactly one
listing, and the log line prints the resolved name, which equals the stored name.

### Why the two readings disagree

All three stored names are byte-identical rows in `meituan_listings`, so the
exact branch fires against the stored catalogue. **It does not fire live, because
the live suggest returns nothing at all for their first search term.** Those terms
are `OliveN`, `Caca` and `Za` — `_coreQuery` truncations produced by a curly
apostrophe (`U+2018`) and a digit sitting inside the leading Latin run. The
resolver then tries the longest run of each other script (`_searchTerms`
`:1176-1191`) and matches under `requireToken` (`:1156-1157`), which is the loose
arm.

Crowding is not the mechanism, and it was the obvious hypothesis. Across all 398,
the number of catalogue listings containing the first term is p50 = 1, p90 = 2,
max = 9. Nothing is plausibly pushing an exact listing out of a capped suggest
response. **The disagreement is that suggest returns nothing for certain terms**,
not that it returns too much.

### What "exact" would have to mean

This is the reason to record the split rather than the three rows.

- **Exact against the suggest response** is the right shape. It is the only test
  available at the point of the write, and it **fails closed**: `_sugFromCapture`
  returns null on an empty capture (`:1146`) and, without the loose branch, on
  any capture holding no identical name, and null becomes
  `{ ok: false, transient: true }` at `:875` with no `_apiSetSku` call. A failed
  or partial suggest cannot produce a write. That is strictly safer than today,
  where "suggest returned a sibling but not the exact listing" is precisely the
  case the loose branch resolves, wrongly.
- **Exact against the stored `meituan_listings`** is the wrong shape for the push
  path. Those three mappings resolve live and would keep resolving; a
  stored-catalogue gate would tell them nothing is wrong, while the same gate
  would refuse names that genuinely exist whenever the cache is stale or partial
  — see finding 16, which is not hypothetical.
- The three would survive an exact test applied on the **fallback** term as well
  as the first, because the candidate they land on carries their name byte for
  byte. What is loose about them is the search term, not the comparison.

The stored catalogue and the live suggest are different endpoints and neither is
derivable from the other: the catalogue is `tagList` + `getSpuListCommon` walked
per category (`:1504-1531`), and the resolver's pool is `searchSugByName` typed
into the merchant search box (`:998-1007`). No suggest response is stored
anywhere.

---

## 16. The stored catalogue has twice held a partial read as though it were the whole store (found 2026-08-26)

Status: open. Finding 15 is why this matters — it is the reason a gate against
`meituan_listings` cannot sit in the push path.

`meituan_listings` is replaced wholesale per store: `DELETE` then `INSERT`, in one
transaction, at `scripts/meituan-daemon.js:1183-1186`. Its only guard is
`if (!names.length)` at `:1176` — **zero**. A read that comes back short passes
and replaces the entire cache.

Twice on record:

- **2026-07-29, job 16: `result_count = 2`** for a store holding 265 listings.
  The DOM fallback saw two pinned notices and nothing else. The next 天河 scrape
  was **2026-08-23**. **The cache held 2 of 265 for 25 days.** A gate reading that
  table in that window would have refused 263 of 265 real names.
- **2026-08-23 10:46, job 17: `result_count = 0`, status `done`.** The cache was
  genuinely emptied, for the fifteen minutes until job 18 restored 265.

**The zero-guard landed on 2026-08-23 in `48e1037c` — after the first of these —
and would not have caught it, because 2 is not 0.** It catches the second and
nothing between.

越秀's half of the table comes through a different path with no guard at all:
`scripts/shangou-daemon.js:713-719` deletes the store's listings inside the
transaction, and `getProducts` (`lib/shangou-browser.js:128-158`) throws only if
page 1 fails — a code-0 reply with an empty `productList` returns `[]`, and the
cache is wiped to nothing.

Freshness, for the same reason: 天河's catalogue refreshes **only when an operator
clicks Refresh** — 17 scrapes in two months — and it grew 265 → 266 → 267 → 271
across 2026-08-23 to 08-26, six new listings in three days, while the cache sat
still between clicks. 越秀's is written by the 闪购 auto-map, last successful
2026-08-23 02:45, with an error on 08-25 and a job left `pending` since 08-26
08:38.

**The write-time gate is a different question and is not affected.** Finding 12
and finding 14 both check a name a person is choosing right now, and both split
`catalogue_not_read` from `name_not_in_catalogue` so an unread cache says it
cannot check rather than returning a verdict. That split is correct — but it
splits at zero, and **2 of 265 reads as "read"**.

---

## 17. The 19 bundles as a shape: 11 would land on a product's own listing, 2 on each other, 6 would refuse (found 2026-08-26)

Status: open. Recorded as a shape, because two bad rows read as an accident and
this is not one.

Finding 1 asked of each mapping: if its own listing were renamed or removed
tomorrow, would the resolver refuse or land somewhere else? Asked of the 19
bundles, against the 271-listing catalogue:

| outcome | bundles |
|---|---|
| lands on a **product's own listing** | **11** — 2 (→ product 9), 4 (→ 194 Labneh), 8 (→ 210 Falafel Wrap), 9 (→ 360 Hummus Asli), 11 (→ 194), 12 (→ 5 Green Chili Dip), 13 (→ 16 Turkish Salad), 14 (→ 360), 16 (→ 196), 18 (→ 42 Tofu Banh Mi), 19 (→ 220 Pesto Wrap) |
| lands on **another bundle's listing** | **2** — 7 and 22, `冷拌荞麦面套餐Buckwheat Noodles Combo` and `冷面沙拉套餐 Buckwheat Noodles Combo`, near-twin combos that would take each other |
| **refuses** | **6** — 3, 5, 10, 15, 17, 20 |

Two of the eleven are not counterfactual: bundles 2 and 16 are there now
(finding 13).

The reason the rate is so much higher than finding 1's — 13 of 19 against 133 of
393 — is structural rather than bad luck. **A combo's title contains its
components' names by construction.** `藜麦沙拉+南瓜汤` reduces to `藜麦沙拉`,
which the plain salad's listing contains; `Labneh + Pita Bread` reduces to
`Labneh`, which the Labneh listing contains. A bundle's `_coreQuery` output is
almost always a component's name, and a component's listing is almost always
shorter than the combo's, so the shortest-name tiebreak hands the push to it.

The same run re-measured finding 1's number against today's data — 398 mappings,
271 + 203 listings — and got **133 again**: 75 天河 (57 `_coreQuery`, 17
`requireToken`, 1 whole-CN-name) and 58 越秀 (45 / 13). Same total as finding 1,
different day, four more mappings.

**But 58 of those 133 are 越秀, which does not use this matcher at all.** 越秀 is
闪购 and pushes by 货号 through `lib/shangou-browser.js:191-228`, falling back to
exact-then-plain-substring on the whole name with no `_coreQuery`
(`MEITUAN_SKIP_STORES=yuexiu`, `SHANGOU_STORES=yuexiu`). So the live latent
exposure of finding 1 is **75 mappings plus 13 bundles**, not 133. Finding 1's
figure should be read as a measurement of both stores' data, not of both stores'
risk.

---

## 18. `_skusFromSpuList` is a second loose match in the push path, with no exact-first preference and no tiebreak (found 2026-08-26)

Status: open. Recorded because an exact-only rule confined to `_sugFromCapture`
would leave it standing, and it is the one nobody is looking at.

`_nameMatches` is called from three places. Two are the resolver everyone reads.
The third is the **sku** step: `lib/meituan-browser.js:1252`, inside
`_skusFromSpuList`:

```js
      let v = spuId ? vos.find(x => String(x.id) === String(spuId)) : null;
      if (!v) v = vos.find(x => this._nameMatches(x.name, cn, en));
```

It matches by spuId first, so the name arm fires only when the resolved spuId is
absent from the `getSpuListCommon` capture — a category that loaded short, a
listing that moved category between the two calls. But when it does fire it picks
a spu by the same truncated-core rule, over a payload holding a whole category,
and **it has neither of the two things that make `_sugFromCapture` survivable**:
no exact-name preference tried first, and no shortest-name tiebreak. It is a
plain `Array.find` — first match in payload order.

The two remaining uses, `_skuFromCapture` and `_extractSku` (`:1265-1290`), are
reached only from `scripts/meituan-set-stock.js` and
`scripts/meituan-test-libstock.js`. The daemon never calls them.

---

## 19. The resolver takes a listing only when the name matches exactly, and the push now says where it went (built and SHIPPED 2026-08-26)

Status: **shipped on `main` at `93aebe1a`**, deployed 13:35 UTC, CI green. This is
findings 1, 9, 13, 15, 17 and 18 answered in one pass, and the last of them is
what decided the shape.

**The live half is NOT yet observed.** 天河 closed at 19:45 Shanghai and the
deploy landed at 21:35; its queue was drained at 11:56 UTC and nothing has been
pushed since. See "What production has and has not proved" at the end — the
distinction is load-bearing and this finding should not be read as though the
resolver has been exercised against the live suggest endpoint. It has not.

### What was removed

`_sugFromCapture` took a candidate through four arms and a tiebreak. Three arms
and the tiebreak are gone:

| removed | what it did |
|---|---|
| `_nameMatches` whole-CN-name containment | candidate contains our name |
| **`_coreQuery` containment** | candidate contains our name's LEADING SAME-SCRIPT RUN |
| `name_en` containment | candidate contains the Roots product's English name |
| `requireToken` containment | candidate contains the FRAGMENT we searched |
| shortest-name tiebreak (`:1159-1161`) | of the survivors, take the shortest |

The middle one is where the damage was. `椰子酸奶 250g Coconut Yogurt` reduces to
`椰子酸奶`, which every size of that product contains by construction, so the rule
that read as *"a candidate must contain our whole name"* was in practice *"a
candidate must contain our name's first few characters"*. The tiebreak then made
the wrong choice deterministic without making it right — among size variants the
shortest name is whichever the merchant happened to type most tersely.

What remains is one line: a candidate is ours when `String(x.name).trim()` equals
the mapped name. `en` is consulted only when there is no mapped name at all,
which is the test scripts calling `updateStock` with one argument; a Roots
product name equalling a listing title would be a coincidence, not a match.

### The exact test runs on every term, and that is what keeps three mappings alive

This is the part that would have been easy to get wrong, and finding 15 is why.

`_searchTerms` builds up to three queries from the mapped name. The old code
applied the exact test only to the first and a looser rule to the rest, on the
reasoning that a fragment search cannot be trusted. Under exact-only that
reasoning inverts: the term decides WHAT WE TYPE and has never had any business
deciding what counts as a match. **The exact test now applies to every term.**

Three live mappings depend on it and would have stopped pushing otherwise:

| map | product | stored name | `_coreQuery` | term that answers |
|---|---|---|---|---|
| 819 | 10 Olive N' Cream | `OliveN‘Cream 地中海橄榄酱` | `OliveN` | `地中海橄榄酱` |
| 817 | 139 Cacao Nibs | `Caca0 Nibs 可可粒` | `Caca` | `可可粒` |
| 873 | 79 Za'atar | `Za‘atar绿百里香粉` | `Za` | `绿百里香粉` |

Each resolves to a candidate carrying its own name byte for byte. What fails for
them is that suggest returns nothing for a query truncated at a curly apostrophe
(`U+2018`) or a digit inside the leading Latin run. **What needed loosening was
the query, never the comparison.**

### The loop that advanced only on a miss is now moot, not fixed

`_resolveProductIds` moves to the next term only when the current one yields no
match at all. That used to be a real defect — a term could return a WRONG match,
the loop would stop on it, and the later term that would have found the right
listing was never typed. Under the exact rule a wrong match cannot happen:
`_sugFromCapture` returns the right listing or null. The condition is now exactly
correct as it stands, and it was left unchanged on purpose rather than edited to
look like it had been considered.

### `_skusFromSpuList`: the fallback was removed, not tightened

Finding 18 named `lib/meituan-browser.js:1252` as a second loose match in the
push path — the same truncated-core rule, over a whole category's payload, with
no exact-first preference and no tiebreak, taking the first match in payload
order. Tightening it to an exact name comparison was the obvious repair and it
would have been wrong.

**The reason is WHEN that arm runs: only when the spuId already resolved is
absent from the capture.** spu ids are stable and unique, so a candidate whose
NAME matches exactly while its ID does not is, by construction, a DIFFERENT
listing that happens to share a title. An exact name rule there cannot pick the
right spu — it can only pick a wrong one more carefully.

And every condition that reaches that arm is transient: the category click timed
out, the list had not finished loading, the listing moved category between the
two calls. So the arm is gone and the function returns null, which produces
`could not resolve skuId`, no write, and a retry — the fail-closed direction.

`_nameMatches` itself survives, reached only by `_extractSku`, which nothing but
`scripts/meituan-set-stock.js` and `scripts/meituan-test-libstock.js` calls. It
now carries a warning saying so, kept next to the function rather than copied
into the scripts.

### The empty-reply distinction, and that it is narrower than the brief allowed

The brief commissioning this pass said: *"Suggest failing or returning empty
still fails closed as a transient, since that is a check that could not run."*
**What shipped is narrower than that, deliberately, and the disagreement is
recorded rather than resolved quietly.**

The first implementation followed the brief literally: any empty candidate list
was a transient. Its own verification caught the problem. That rule conflates two
different facts — *suggest answered and nothing it named is ours*, and *suggest
did not answer* — and treating both as retryable leaves a name that matches
nothing retrying every thirty minutes for ever. **That is precisely the shape
finding 10 measured on product 254: 1551 hours of a self-firing loop chasing a
target that could never resolve.** Building the rule that way would have removed
one instance of the fault and installed another.

**The signal that shipped is the reply's SHAPE, not its length**
(`_sugAnswered`):

- a well-formed `searchSugByName` reply — `data.data.searchSugVos` present and an
  array — **is an answer**, whether it names one listing, a hundred, or none. A
  merchant search that finds nothing is a true answer and a stable one.
- no reply at all, or a garbled one, is **a check that could not run**, and
  retries.

The residual risk runs the other way and is stated rather than hidden: a
200 carrying an empty list during a soft failure — rate-limited, session
half-expired — would be read as an answer and bury a healthy row terminally on
its first attempt.

**The asymmetry is the whole argument.** The cost of that mistake is one Activity
line and a thirty-minute wait for the drift sweep to re-queue the row. The cost
of the opposite mistake is 1551 hours. That is why the rule sits where it does,
and it is the sort of trade that should be written down at the time rather than
reconstructed later from the code.

### The failure is terminal on the first attempt, and says why

A name no listing carries returns `{ ok: false, transient: false, reason }`. The
daemon writes that sentence into `meituan_sync_queue.last_error` and into the
sync log's `error_msg`, marks the row `error`, and stops. **One attempt, not
three.** The "picked 规格 has gone" refusal — already terminal — gets a sentence
too, instead of the generic `browser update failed`.

Genuine transients are untouched: still `pending`, attempt kept not refunded, no
sync-log row, still terminal at three with the existing sourced bilingual pair
`update failed after retries · 多次重试仍失败`.

Two small changes on the screen, not a rebuild. The Activity row now appends
`error_msg` on an error row — the daemon has written a sentence there for years
and the row never showed it, so a failing push read as a red line with a number
and nothing else. And it falls back to `mapped_name` when there is no
`product_id` or SKU, which is why a failing bundle used to render as the bare
word "bundle" with no way to tell which one.

New sentences are English on both sides. §30 rule 3 forbids composing Chinese and
no sourced pair exists for either of them; same convention as
`lib/meituan-map-write.js` `REFUSAL_PENDING_CN`.

### §30 rule 7 is now met on Meituan

Finding 9 said the resolver had the answer and discarded it three calls before
the daemon could see it. It travels now:

- `_resolveProductIds` returns `targetName` alongside `{ spuId, skus }`.
- `_applyStockRule` spreads a `tgt` object into all six of its returns, and
  `_toTransient` takes a second argument and passes it through.
- `batchUpdateStock` carries `spuId`, `targetName`, `skuIds` and `reason`.
- The daemon writes `meituan_spu_id = COALESCE(?, meituan_spu_id)` on the
  existing `UPDATE meituan_product_map`, **on success only** — a failed push has
  no target to record — and via COALESCE so a driver that somehow returns no spu
  leaves the stored value standing rather than blanking it. All 32 rows the
  one-off scripts populated were checked against the 2026-08-26 scrape first: 32
  of 32 agree, so the column is an accurate fossil and safe to write over.
- The `stock_push` log line carries `target_spu_id`, `target_name`, `sku_id`,
  `mapped_name`, `product_id` or `bundle_id`, and `target_mismatch`.

`mapped_name` sits beside `target_name` because **the fact worth catching is that
they disagree**, and neither alone can say it. A mismatch also gets its own
`TARGET MISMATCH` line in the process log. Under the exact rule a mismatch is not
reachable, so one appearing means a bug rather than a mis-mapping.

`product_id` is there for a smaller reason that had been costing every reader:
`logSync` never carried it, so `mtRenderLog` could not name the product and fell
back to a bare SKU on every row.

**Bundles get the log line only.** `meituan_bundles` has no spu column, and
adding one is a schema change that did not belong in this pass. Their log line
carries `bundle_id` and the full target.

### What `mtRenderLog` still does not show

The new keys are stored and invisible. The screen renders a fixed set, and this
pass deliberately did not rebuild it. What a useful row would do is show the
target beside the mapped name **only when they differ** — under this rule they
always agree, so showing both always is noise that trains an operator to ignore
the one case that matters.

### The drift sweep still re-queues a terminal row every 30 minutes

Not changed, and the omission is deliberate. A row that goes terminal on a name
that cannot resolve still presents drift (`last_pushed_qty <> shelf`), so
`lib/meituan-drift-sweep.js` writes it a fresh `pending` row on its next pass and
the cycle repeats — now at one attempt per half hour instead of three.

**A guard there is a separate pass.** The sweep is the channel's only self-firing
recovery path and finding 10 is what happens when its selection is wrong in the
other direction: it chased an archived product for 1551 hours and held a store's
alarm latch shut for 28 days. It reads `last_error` today only to phrase an
alert, so a skip on that column would be a new behaviour rather than an extended
one, and folding an unmeasured change to the recovery loop into the same deploy
as a change to the resolver would leave neither verifiable if the day went wrong.

### What production has and has not proved

**Verified before the deploy**, against a detached snapshot with the real driver
prototype and the daemon's verdict block lifted verbatim by line range (the
daemon calls `main()` at require time and cannot be required against a fixture):
all 398 named mappings resolve with one exception — map 957, the wine, which
resolved to nothing before this change too; every resolved target name equals its
mapped name; the three fallback mappings resolve with `terms[0]` forced silent;
bundles 2 and 16 refuse instead of writing to products 9 and 196; a name absent
from suggest is terminal with a reason and no write; suggest never replying is a
transient; a well-formed reply naming nothing is terminal; suggest returning
siblings but not the exact listing refuses rather than taking one — that last is
the write the old rule made; the target fields travel and `meituan_spu_id` fills
in; a stated refusal consumes one attempt.

**Not proved, because the store was shut.** 天河 trades 10:00–19:45 and the
deploy landed at 21:35 Shanghai, with its queue drained since 11:56 UTC. **No
push has run under this code.** Everything above about resolution rests on the
stored catalogue standing in for `searchSugByName`, and findings 4 and 15 are the
record of those two disagreeing. The first real cycle is what proves it.

**Never testable offline, and only production can answer:**

- **Whether a well-formed empty reply ever arrives during a healthy session.**
  That is the residual risk in the empty-reply rule above, and no fixture can
  produce it.
- **The duplicate-title blind spot.** An exact match names exactly one spu only
  if no two listings share a title. The stored catalogue says none do — but
  `meituan_listings` carries `UNIQUE(store_code, listing_name)` and the scrape
  inserts with `INSERT OR IGNORE`, so **two spus sharing a title would collapse
  into one row and be invisible to any count taken from that table**.
  `meituan_listing_specs` has no such constraint and also reports zero, which is
  the stronger reading and still not proof. If a duplicate exists, the exact
  branch takes whichever the suggest response lists first.

---

## 20. The drift sweep's expected-quantity arithmetic is not the daemon's, and on a negative shelf count they can never agree (found 2026-09-02, NOT fixed)

Status: open. No Meituan code changed. Found while building the Eleme drift sweep
(`lib/channel-drift-sweep.js`) on the same shape, not by looking for it here.

**Two pieces of code compute "what should this stock box be holding" and they are
not the same function.**

- The daemon WRITES `meituan_product_map.last_pushed_qty` from `packQty()`
  (`lib/pack-units.js:30-34`), by way of the push batch. `packQty` floors, and it
  **clamps a non-positive shelf count to 0**: `if (!Number.isFinite(have) || have <= 0) return 0`.
- The sweep RE-DERIVES the same figure with `Math.trunc(qty / units)`
  (`lib/meituan-drift-sweep.js:146`) and, in SQL, with a bare truncating integer
  division (`:122`). Neither clamps.

For any shelf count of 0 or more the two agree exactly, which is why this has
never been visible. They diverge only below zero:

| shelf | `packQty` (what is stored) | `Math.trunc` (what the sweep expects) | verdict |
|---|---|---|---|
| 40, units 6 | 6 | 6 | agree |
| 0 | 0 | 0 | agree |
| −3, units 1 | **0** | **−3** | disagree, permanently |

A product whose shelf count is negative therefore reads as drifted on every sweep,
for ever. Each sweep re-queues it, the push writes 0 again, the map still holds 0,
the sweep still expects −3. It costs a row of the 40-row budget every two hours
(the cool-down), it never resolves, and at 24 hours it starts holding that store's
chronic-drift latch closed — which is finding 10's failure mode reached by a
different road: **while the latch is held, no new drift on that store can raise an
alert either.**

The comment at `lib/meituan-drift-sweep.js:139-140` is aware of half of this — it
says `Math.trunc` rather than `Math.floor` was chosen because SQLite's `/`
truncates toward zero and "they differ only on a negative shelf count, which the
commit paths can produce". That is correct about `trunc` vs `floor` and it is the
wrong comparison: the number it has to match is neither, it is `packQty`, and
`packQty` clamps. So the file names the exact input that breaks it and then
matches the wrong function on it.

**Not fixed here, deliberately.** The Eleme build that found it was scoped to leave
`lib/meituan-drift-sweep.js` untouched, and this is a live channel that currently
works. The new module uses `packQty` in both halves from the start
(`lib/channel-drift-sweep.js`, `expectedQtySql()` and the JS re-test), with a
regression test for the negative case, so the defect is not carried forward.

**What is not known**, and would decide whether this is urgent or theoretical: how
many `retail_store_stock` rows currently hold a negative `physical_qty` on a
Meituan-mapped product. That is one read against production and it was not run —
this finding is from code, not from data. The fix, when someone takes it, is one
import and one call site: replace `Math.trunc(qty / units)` with
`packQty(qty, units)` at `:146` and `MAX(…, 0)` the SQL arm at `:122` so the
pre-filter stays a superset of the JS test.

---

## Context — what was and was not done on 2026-08-26

> **Amended after findings 10 and 11.** The bullet below was written when this
> document ended at finding 9 and it was true of that survey. It is no longer
> true of the day. It is amended in place rather than deleted, so a reader does
> not carry away a claim the document later contradicts.

- **The survey behind findings 1 to 9 wrote nothing.** No mapping was created,
  edited, hidden or deleted; no queue row was retired, re-queued or cleared; no
  stock was pushed; no process was started, stopped or restarted.

- **Finding 10 then changed code and shipped it.** One line in
  `lib/meituan-drift-sweep.js`, commit `bc0c6144`, pushed to `main` at 07:26 UTC,
  CI green in 1m08s. Being in `lib/` it restarted the channel daemons:
  `meituan-sync` 154 → 155, `guanyi-sync` 138 → 139, `eleme-sync` 62 → 63, all
  `online`. `shangou-sync` was already `stopped` before the deploy and still is.
  **Still nothing was written to any mapping, queue row or listing** — the change
  only removes rows from a SELECT.

- **One alarm cleared as a direct result**, 16 seconds after the restart:
  `drift_chronic ok, all listings back in sync`, and the latch file
  `data/alert-latch/meituan--drift_tianhe.json` was deleted by the daemon. That
  was the code doing what it is written to do, not a manual clear.

- **Finding 12 then shipped a second code change**, `d7848b62`, at 08:26 UTC —
  the mapping-name gate, the standalone catalogue refresh and the audit entry.
  CI green in 1m29s. `roots-v2` 1603 → 1604 and healthy on the deploy's own
  probes (`/api/retail/categories`, `/config`, `/products` all 200). Being a
  `lib/` file it bounced every channel daemon — `meituan-sync` 156 → 157,
  `guanyi-sync` 140 → 141, `eleme-sync` 64 → 65, `gzgrocery-orders` 138 → 139,
  `qingyun-sync` and `qingyun-sync-yuexiu` 215 → 216, `proxy-watchdog` 57 → 58 —
  all back `online`, no startup error of their own. `shangou-sync` was named by
  the installer and deliberately NOT restarted: it was stopped by hand and the
  deploy honours that. **None of those daemons loads the new file**; the
  installer's trigger is a `lib/*` prefix match, which is coarse rather than
  wrong.

- **Still nothing was written to any mapping.** Product 254 holds the same name,
  the same `sync_enabled` and the same `updated_at` before and after both
  deploys. The gate is write-time only, and the refusal path was the only half
  exercised against live data — deliberately, because accepting is a write.

- **No audit entry exists yet.** `activity_log` held zero `meituan_map%` rows
  before the deploy and zero after it, because no operator changed a mapping in
  the window. The path is verified against a fixture, not by a live occurrence,
  and that distinction is left standing rather than manufactured.

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

- **Finding 14 then shipped a third code change**, `693209e3`, at 12:15 UTC — the
  bundle-title gate, `verifyName` shared out of `applyMapName`, the datalist and
  commit on the bundle field, `white-space: pre-wrap` on the bundle list, and the
  `syncEnabled: 1` fix. CI green in 1m35s. Every process came back `online`:
  `roots-v2` 1611 → 1612, `meituan-sync` 159 → 160, `guanyi-sync` 143 → 144,
  `eleme-sync` 67 → 68, `gzgrocery-orders` 141 → 142, `qingyun-sync` and
  `qingyun-sync-yuexiu` 218 → 219, `proxy-watchdog` 60 → 61. No startup error of
  its own — the only stderr lines after the restart are the standing ones
  (`ALIPAY is not configured`, the `pack-claims` duplicate-option warning, the
  `price write-back` skips). `shangou-sync` was `stopped` before the deploy and
  still is, as it has been all day.

- **Nothing was written to any bundle, mapping or listing by this pass either.**
  Bundle 2 still holds its one-space title, bundle 16 is still `sync_enabled = 1`,
  and the table still holds 19 rows. The post-deploy checks ran the DEPLOYED route
  file — md5-matched to the one on the box — against a fresh snapshot, and the
  only calls that write ran against the snapshot. The refusal path, which writes
  nothing by construction, was the only half exercised against anything live.
  Same discipline as finding 12's, and the same reason.

- **The gate does not fix the two bad rows.** It refuses a title that is new or
  moved; bundles 2 and 16 hold titles written before it existed, so
  re-submitting them unchanged still passes. That is what keeps bundle 16
  editable (finding 14) and it means the correction is still a job for a person:
  bundle 2 needs its title re-picked from the list, and bundle 16 has no title to
  pick until its listing comes back.

- **Finding 19 then shipped a fourth code change**, `93aebe1a`, at 13:35 UTC —
  the exact-match resolver, `_skusFromSpuList` losing its name fallback, the
  target recording and the terminal verdict. CI green. It was pushed only after
  the in-flight deploy of PR #112 had finished, because concurrent runs share one
  staging directory. Every process came back `online`: `roots-v2` 1614 → 1615,
  `meituan-sync` 161 → 162, `guanyi-sync` 145 → 146, `eleme-sync` 69 → 70,
  `gzgrocery-orders` 143 → 144, `qingyun-sync` and `qingyun-sync-yuexiu` 220 →
  221, `proxy-watchdog` 62 → 63. `meituan-sync` restored its session, confirmed
  login and read an order under the new code, with no startup error of its own —
  the only stderr lines are the standing ALIPAY / pack-claims / price write-back
  ones. `shangou-sync` has been `stopped` all day and still is.

- **NO PUSH HAS RUN UNDER THE NEW RESOLVER, and that is the whole caveat on
  finding 19.** 天河 trades 10:00–19:45 Shanghai; the deploy landed at 21:35, and
  the store's queue had been drained since 11:56 UTC. `isStoreOpen` gates the
  drain, so the first cycle cannot happen until the store reopens. The offline
  verification is thorough and it is not the same thing as the endpoint answering.

- **The 1,683 pending queue rows are 越秀's and predate all of this.** They are
  dated 2026-08-24 and 2026-08-25, carry 0 attempts, and cover 187 products —
  越秀's whole mapping set. `shangou-sync` is stopped, so nothing drains them, and
  越秀 is 停业中 on Meituan besides. Recorded because a four-figure pending count
  read next to a resolver deploy invites exactly the wrong conclusion.

### Working note — requiring the app’s modules on production is not read-only

Not a finding; a method note, recorded because it is an easy mistake to repeat
and it silently invalidates a "read-only" claim.

A probe opened `roots.db` with `better-sqlite3` in `{ readonly: true }` and then
`require`d `lib/channel-sync-stale.js` to get the badge number from the real
function. **That require chain is not read-only.** `lib/channel-sync-stale.js`
pulls in `lib/store-hours.js`, which does `seam(require('../database'))` at module
load — opening its own **writable** handle to the same file, independently of the
read-only one. Loading it ran a scheduled retention job, which reported
`[retention] purged 3 activity_log entries older than 90 days`.

The rows were over-age ones the application deletes on its own schedule, so
nothing was lost that was not already going. That is not the point. **The point
is that the read wrote**, and the operator asking for a read-only check would
have been told the check was read-only.

**The method that is actually read-only** is the one the rest of this document
and finding 10’s verification used: dump the needed tables out of
`file:data/roots.db?mode=ro` into a **detached fixture file**, and drive the real
module against that. A module’s dependency closure is the thing to check first —
the drift sweep’s is only `lib/meituan-bundles.js` and `lib/bundle-stock.js`, and
neither touches the app’s database layer, which is why that harness is safe and
the badge probe was not.

Source: read-only queries of `roots.db` on 2026-08-26 over SSH, the matcher
replayed against the cached catalogue outside the running process (finding 4's
caveat applies to every count derived from it — and finding 15 is what that
caveat turned out to be worth), and the code cited above at
`0ef56667` for findings 1 to 9. Findings 10 and 11 were read at `2e95078e` and
finding 10’s fix landed at `bc0c6144`; its post-deploy observations were taken
against the running system between 07:26 and 07:28 UTC, and its before/after
selection counts against detached fixtures cut at 07:00 and 07:27 UTC.

Findings 13 to 18 were read at `832308a4` against fixtures cut at 17:32, 17:59
and 19:47 UTC and, after the deploy, at 20:20 UTC. Finding 19 was built at
`bb4b70e3` and verified against a fixture cut at 21:20 UTC, with the driver
driven through `Object.create(prototype)` and the daemon's verdict block lifted
verbatim by line range; its fix landed at `93aebe1a` and its post-deploy
observations were taken between 21:35 and 22:05 Shanghai, during which the store
was shut and no push ran. The live/offline split in
finding 15 comes from `~/.pm2/logs/meituan-sync-out.log`, 21,860 lines spanning
2026-07-29 to 2026-08-26 — the only record anywhere of what the resolver actually
matched, and the reason finding 4's caveat could be tested at all rather than
only stated. Finding 14's fix landed at `693209e3`.
