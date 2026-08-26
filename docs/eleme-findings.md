# eleme — Findings

Seven findings. The first four come from a read-only survey on 2026-08-25, opened
by a dashboard row ("Eleme not syncing · 1") and ending in a wrong number on a
live listing. Findings 5 and 6 were added on 2026-08-26, from the mapping screen
that survey sent someone to. Most are not Eleme-specific: findings 1 and 4 hold
on every channel, finding 3 holds anywhere a mapping is stored against an
external system, finding 5 holds on any screen that counts work, and finding 7
holds anywhere a cached read is consulted by something that returns a verdict.

The rules these produced are in `docs/tacet-consolidation-decisions.md` §30. This
document is the evidence; that one is the intent. Where they disagree about what
the code does, this one is stale and should be re-checked against the code.

---

## 1. A failed sync row is terminal, on every channel (found 2026-08-25)

Status: open. No code changed.

Once a queue row exhausts its attempts nothing reads it again, on any of the
three channels. The row is not retried, not retired, and not reachable by any
supported operation — but it still counts toward the dashboard alarm, which it
therefore pins on indefinitely.

Three mechanisms have to line up for this, and they do:

1. **The drain filters it out by attempt count.** `scripts/eleme-daemon.js:476`
   and `scripts/meituan-daemon.js:845` both select
   `WHERE q.status = 'pending' AND q.attempts < 3`. A row that has burned its
   attempts, or that has been marked `error`, is outside the query.

2. **Meituan's drift sweep skips it.** The sweep is level-triggered and exists
   precisely to rescue rows the drain gave up on, but it re-queues *drift* — a
   difference between live stock and what the channel last accepted
   (`lib/meituan-drift-sweep.js` header). A row whose target is already at the
   right quantity presents no drift, so the sweep correctly does nothing, and
   the dead row stays. Separately, `skipQueued()` at
   `lib/meituan-drift-sweep.js:52-64` excludes any target holding a row in
   `('pending','processing')` — so a row left *pending* past the attempt cap
   blocks its own rescue as well.

3. **The dashboard counts it anyway.** `lib/channel-sync-stale.js:107-140` takes
   the newest queue row per (store, product) via
   `ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC)`
   and counts it when `rn = 1 AND status IN ('pending','error')`. `error` is
   counted with no attempts filter, so a permanently dead row is a permanent
   alarm.

**There is no supported way to retire such a row.** The one retirement path,
`scripts/eleme-daemon.js:511`, marks a row `'superseded'` — but it only ever
runs against rows the drain has *already selected*, i.e. rows still inside
`status='pending' AND attempts < 3`. It cannot reach a dead row by construction.

Observed: five `error` rows for product 195 on `eleme_sync_queue`, oldest
2026-08-23 06:32, each at `attempts = 3` with
`transient push failure — retries exhausted`. All five were still counted at
22:15 +08 on 2026-08-25.

---

## 2. Eleme has no level-triggered reconciliation (found 2026-08-25)

Status: open. No code changed.

The other two channels can recover a target from a bad state without anyone
noticing it was bad. Eleme cannot.

- **Meituan — drift sweep.** `lib/meituan-drift-sweep.js`, run every 30 minutes
  from `scripts/meituan-daemon.js`. Compares live stock against
  `last_pushed_qty` and re-enqueues the difference. Its own header records why
  it was built: on 2026-07-29 天河 held 502 error rows and zero pending, and
  "nothing was going to fix itself".

- **GZ Grocery — auto-heal.** `scripts/guanyi-daemon.js:646` `autoHeal()`,
  called at `:798`, gated at `:793-797` to run on the first healthy probe after
  start-up and after every recovery. It explicitly retires dead rows:
  `:690-696` selects `WHERE q.store_code = ? AND q.status = 'error'` and
  re-queues each at current stock with
  `last_error='auto-healed — re-queued at current stock'`. The comment above it
  names the exact defect finding 1 describes: *"processStockQueue only reads
  status='pending' AND attempts<3, so anything that burned its attempts … would
  sit dead for ever."*

- **Eleme — neither.** There is no drift module for Eleme in `lib/` (only
  `eleme-browser.js`, `eleme-client.js`, `eleme-sync.js`), and the string
  `drift` does not appear anywhere in `scripts/eleme-daemon.js`. Its only
  periodic sweep, `ORPHAN_SWEEP_MS` at `scripts/eleme-daemon.js:648`, heals rows
  stranded in `processing` by a crash — not rows that failed.

  The daemon acknowledges being the thinnest of the three at
  `scripts/eleme-daemon.js:177-179`: *"Deliberately smaller than
  meituan-daemon's (no heartbeat/queue-stall canary yet) — the browser lib is
  brand new and stock push is the only wired path."* That comment is about
  **alerting**, not reconciliation; the absence of reconciliation is established
  by the absence of any such code, not by a comment claiming it.

Consequence: on Meituan a failure is a delay, and on GZ Grocery a failure is a
delay. On Eleme a failure is permanent.

---

## 3. Nothing validates a channel mapping name when it is created (found 2026-08-25)

Status: partly closed on the screen, open everywhere else, as of 2026-08-26.
Mapping deliberately left unfixed — see Context below.

**The creation path is now gated, in the browser only.** The admin name field
on both channels accepts a value only when it exactly matches a name in the
cached catalogue for that store; anything else reverts the field to what it
held and is not saved. Nothing is auto-cleared: emptying the field would trade
a wrong-name fault for a missing-name fault, which is harder to notice.
`public/retail-admin/14-eleme.js` `elNameCommit`, `public/retail-admin/11-meituan.js`
`mtNameCommit`. A stored name that matches no listing is named as such under
the field on both screens, and on Meituan it also changes the row's state away
from "Synced". On Eleme that state change is deliberately absent for now: the
list's classification is being rebuilt around three groups on
`claude/eleme-three-group-split-7f6d32`, which will carry it as a reason on the
row, so this change leaves `elStoreState` untouched rather than colliding with
it. **Product 195 therefore still reads "Synced" in the Eleme list** until that
build lands; the panel tells the truth about it today.

Where no catalogue has been read, neither screen judges a name at all — not in
the list, not under the field, and not on save. A save attempted in that state
is refused and says both halves out loud: the check could not run, and nothing
was saved (§30 rule 4).

**The gate is front-end only and is NOT the fix.** `POST
/api/retail-admin/eleme/products/:id/map` and its Meituan twin still accept any
string, so anything that is not this screen — a direct call, a future importer,
a script — can still create a mapping that was never checked against the
catalogue. Nor does anything yet validate a stored name at rest or when the
catalogue is re-read. Read this status as "one door closed", not as closed.

`eleme_product_map` row id 61 (product 195, `4-650`, Smooth Sesame Tahini
(Hulled), store tianhe) was created 2026-08-23 06:31:19 carrying
`中东生芝麻酱(去皮) HSulled SesameTahini`. The listing on Eleme is
`中东生芝麻酱(去皮) Hulled SesameTahini`. Byte-diffed: **47 bytes stored against
46 cached, differing by exactly one byte — `0x53`, a capital `S`.** Everything
else identical, including half-width `(` `)` and a single ASCII space; no
zero-width or full-width character anywhere.

That one byte is fatal because **Eleme matches by name and nothing else.**
`lib/eleme-browser.js:816-820`: *"our Eleme items carry no extCode … so name is
the only matching key"*, and `ELEME_BROWSER_RECON.md:65-69` records the
underlying fact — `extCode` is empty on every one of our Eleme items, unlike
Meituan which matches on 货号.

**The failure was indistinguishable from a network fault.** An unresolved name
returns `{ ok: false, transient: true }` at `lib/eleme-browser.js:840` — the
same shape a proxy blip produces. The row therefore burned its three attempts in
about 36 seconds and landed as `transient push failure — retries exhausted`,
identical in the database to a genuine transient failure. `eleme_sync_log`
carried five such lines, all reading
`update failed after retries · 多次重试仍失败`.

**Duration and exposure.** Every push from 2026-08-23 06:31 to 2026-08-25
resolved to nothing. `last_pushed_qty` stayed `NULL` — the mapping never once
landed. The listing showed **10000** against a shelf holding **3**, for two
days, on a product with 12 orders in the preceding 30 days. **No alert fired at
any point**: Eleme has no heartbeat and no queue-stall canary (finding 2), and
the only surface that noticed was a dashboard row saying a number, not a name.

**The edit path already prevents this; the creation path does not.** The admin
name field is an autocomplete against the real catalogue —
`public/retail-admin/14-eleme.js:316-329` builds one `<datalist>` per store from
`eleme_catalogue_cache`, and `:637` binds the input to it. The comment at
`:628-631` shows the guard was built for exactly this class of fault: *"The name
field is an autocomplete against the real catalogue, not free text: a hand-typed
name once used a curly apostrophe and silently failed every push."*

So a name picked from that dropdown is correct by construction. **The gap is
that a mapping can exist without ever having been checked against the
catalogue** — nothing validates a stored name at rest, on creation, or when the
catalogue is re-read, and nothing reports a mapping whose name matches no
listing. A survey on 2026-08-25 found five such mappings on tianhe; four were
half-typed fragments (`bre`, `brea`, `gra`, `芒`) left with `sync_enabled = 0`,
and product 195 was the only one still enabled, which is why it alone burned
queue rows.

---

## 4. A mapping that does not name its target box causes a fabricated quantity (found 2026-08-25)

Status: open. No code changed. **Not currently armed** — see below.

An Eleme listing may hold several 规格 (stock boxes), each with its own stock
figure, and several of our products may sit behind one listing, one per box.
When a mapping claims no specific box on such a listing, the push path does not
refuse — it guesses. `lib/eleme-browser.js:876-889`:

```js
    if (skus.length === 1) {
      return this._apiUpdateFoodStock(entry.itemGlobalId, skus[0], newQty, label);
    }
    const N = Number(newQty);
    const BIG = 9999;
    const targets = skus.map((_, i) => (N >= 3) ? BIG : (i === 0 ? N : 0));
```

**`BIG = 9999` written to every box** whenever the quantity is 3 or more. Below
3, box one gets the real number and every other box gets `0`.

Two consequences, both observed:

- **A box showing 9999 was written by us.** It is our constant, not Eleme's
  default; Eleme's own default is the `maxStock` figure, `10000`
  (`lib/eleme-browser.js:911`). On the 2026-08-25 catalogue read, 19 boxes stood
  at exactly 9999. (The most common high value was **8888**, on 34 boxes — that
  figure appears nowhere in our code and is merchant-typed, with 8887/8886/8882
  visible as it sells down untouched. The 9999s are ours; the 8888s are not.)

- **One product's stock movement overwrites boxes belonging to a different
  product.** The guess writes every box on the listing, and the other boxes may
  be claimed by other products entirely. A push triggered by one product's sale
  can therefore falsify a sibling product's quantity.

**The capability is not missing — the claims are.** With a box claimed, the push
targets exactly that box and nothing else: `scripts/eleme-daemon.js:534-537`
passes `specGlobalId: row.map_spec_id || null`, and
`lib/eleme-browser.js:864-873` resolves it with
`skus.find(sk => String(sk.specGlobalId || sk.skuGlobalId || '') === want)` and
writes that one box. Per-pack maths is honoured too (`units_per_pack`), verified
live on a three-box multipack. A claim pointing at a box that no longer exists
refuses rather than falling through — `:869-872`, *"not guessing"* — which is
the correct shape, and is what the no-claim case should do as well.

Scale at 2026-08-25 22:15 +08, store tianhe: 204 cached listings, 28 multi-box,
248 boxes total. 24 boxes claimed by nobody; 11 listings partially claimed; 1
listing with no box claimed at all. Of 49 claimed boxes on multi-box listings,
27 disagreed with our stock — 25 overstated, 2 understated.

**Not currently armed.** Zero mappings with an empty box claim now point at a
multi-box listing, so nothing today will take the guess branch. The 9999s are
residue from when those mappings had no claim, and they persist because a
claimed box only corrects when a push actually lands — and on most of these it
never has.

---

## 5. The mapping screen counted the wrong rows, and hid the right one (found 2026-08-26)

Status: FIXED 2026-08-26 in `public/retail-admin/14-eleme.js`. Data unchanged —
no mapping was written, hidden or deleted; only what the screen says about them.

The Eleme mapping screen read **"Needs attention 53"** against 248 active
products. All 53 were checked by hand. Every one had sync off, and most were
foundation shades, gift sets and household kits — things never sold on Eleme at
all.

**52 of the 53 were not work, and 47 of them could never become work.** The old
test was two lines:

```js
if (!maps.some(m => m.eleme_name)) return true;   // no listing name anywhere
return maps.some(m => m.eleme_name && Number(m.specCount || 0) > 1 && !elClaims(m).length);
```

A product with no `eleme_product_map` row at all has no name, so it passed the
first line and was counted. 47 of the 53 were exactly that. Such a product cannot
be queued by any path — `lib/eleme-sync.js:46` needs a map row to find one — so
it is not a job that has not been done, it is a product that is not sold here.
It would have sat in that count forever. That is §30 rule 5 written out as a
defect: the alarm had no mechanism that could clear it.

**The one real problem was not in the 53. It was showing green.** Product 195
(finding 3) has a listing name, so it passed line one. Its name matches no
listing, so the `specCount` sub-query at `routes/eleme-admin.js:217` — which
joins the catalogue **on that exact name** — returned `NULL`, so it passed line
two as well. It therefore fell through to `elStoreState`'s final branch and
rendered as **`{ k: 'ok', t: 'Synced' }`**: a green dot, the word Synced, and
`last_pushed_qty` still `NULL` because not one push had ever landed. Anyone
working the 53 by hand would never have reached it.

That is §30 rule 1 rendered as pixels. `sync_enabled = 1` is our record of our
own intent; the screen showed it as the channel's state.

**Counts on 2026-08-26, read-only.** Old test: 53 need attention, of 248. New
test — grouped by whether a mapping can reach the right listing, over connected
stores only: **10 need attention, 191 synced, 47 not on this channel**, which
partitions all 248 exactly. The 10 break down as 6 mappings with a blank name and
4 whose name matches no listing; 0 with options unclaimed, consistent with
finding 4 not being armed. Of the 10, exactly one has sync on: product 195.

---

## 6. A mapping with no listing name pushes against the product's own name (found 2026-08-26)

Status: open. No code changed. This is a **distinct fault from finding 3** —
that one is a stored name that is wrong by one byte; this one is a stored name
that is absent, and the absence is filled in rather than refused.

Two mechanisms combine, neither of them visible from the mapping screen:

1. **The drain never reads the sync switch.** The select at
   `scripts/eleme-daemon.js:476` filters on `q.status` and `q.attempts` and
   nothing else. `sync_enabled` is read in exactly one place —
   `lib/eleme-sync.js:46`, when a job is **queued**. A row already waiting when
   the switch is turned off still goes out. The switch is a tap on the inlet, not
   a valve on the outlet.

2. **A missing name is substituted, not refused.**
   `scripts/eleme-daemon.js:530` builds each push as
   `targetCn: row.map_eleme_name || row.name_cn`. When the mapping carries no
   name, the target becomes **the product's own Chinese name** — a string that
   was never checked against the catalogue and never chosen by anyone as a match.
   Eleme matches by name and nothing else (finding 3), so this either resolves to
   a listing nobody nominated, or to nothing.

**Observed.** `eleme_product_map` for product 80 (Dried Sour Mango, `4-200`,
store tianhe) holds `eleme_name` empty and `sync_enabled = 0`. It is also the
only sync-off row in the table carrying a push: `last_pushed_qty = 25`,
`last_pushed_at = 2026-08-25 11:21:07`. Queue row 656 was created 11:20:51 and
finished `done` at 11:21:07 on one attempt. Its name had been one of the
half-typed fragments finding 3 lists (`芒`), later cleared; clearing the name did
not stop it pushing, and neither did the switch.

**So "blank and switched off" is not a safe state**, and the mapping screen must
not present it as one. It is a live wrong-target risk that happens to be quiet.
Finding 5's replacement groups it under Needs attention for this reason, with the
switch reported beside it rather than deciding it.

The fix belongs in the daemon, not the screen: §30 rule 4 — where the correct
target cannot be determined the system refuses and surfaces the problem, it never
substitutes. A queue row whose mapping carries no name should fail visibly rather
than guess a target. Not done.

---

## 7. A check with an empty input returns a verdict instead of refusing (found 2026-08-26)

Status: FIXED 2026-08-26 in all three known places. The condition that keeps
producing it is NOT fixed and probably cannot be — see "Why it recurs" below.

This is not findings 3, 4 or 6 in another costume. Those are about **names** —
a name typed wrong, a name absent, a target that cannot be identified. This one
is about a **check that cannot run and answers anyway**. It appeared three times
in one day, in three separate pieces of code, written by two people who had each
already read the rule it breaks.

### The shared condition

The admin screen reads the Eleme catalogue into `_catalogue[storeCode]` in
`public/retail-admin/14-eleme.js`. When the fetch throws, the catch stores
`{ rows: [] }`.

**A failed read is therefore indistinguishable from a store nobody has read**
— empty rows, both times, no flag saying which. Every consumer sees the same
thing: nothing. And "nothing" is one keystroke away from "no match", which is a
verdict. That is the whole fault, and it is why it keeps arriving in new code
rather than staying fixed: nothing about the empty array announces that it is
not an answer.

### The three instances

**1. The save gate.** `elNameCommit` refused every name typed on a store with no
catalogue, correct ones included, with "Not in the catalogue — not saved" and no
way forward. `elNameKnown` answers `false` for every name when there are no rows
to match against. Unreachable only because 越秀 holds no shop id, so the field
never rendered there; linking one would have made it reachable immediately,
before the first catalogue read, and it would have read as the feature simply
not working on a new store.

**2. The match counter.** `elMatchCount` counted 0 matches against a catalogue it
had never seen and printed "No matches" under the field — an assertion about
listings nobody had looked at.

**3. The classifier — the worst of the three.** `elStoreState` fell through an
unanswerable name check to its final branch and returned `Synced`. Measured
against live data with the catalogue read forced to fail: **Needs attention
10 → 6, Synced 191 → 195, and product 195 back behind a green dot** — the exact
state finding 5 exists to end, restored in full by one dropped fetch.

### Why the third one is the dangerous one

The first needs a store with no shop id. The second is visible nonsense under a
field someone is looking at. The third needs **one failed HTTP request**, says
nothing at all, and **repairs itself on the next successful poll**.

A fault that heals before anyone can look at it cannot be investigated from a
report. Nobody would have filed one: the screen would have read 195 synced for a
few minutes and then read 191 again, and the wrong number would have gone out to
a live listing in between with no trace anywhere that a check had been skipped.

### The fix, and the rule it comes from

§30 rule 4: where the correct answer cannot be determined the system refuses and
surfaces the problem, never substituting. Applied here as: **every consumer of
the catalogue asks `elCatalogueRead(storeCode)` first and declines to judge when
it is false.** The save gate says the check could not run and nothing was saved;
the counter says nothing; the classifier returns a state of its own —
"Name not checked" — that groups with Needs attention rather than Synced and
draws a neutral dot rather than an amber one.

The grouping is deliberate and was ruled on: **if it cannot be verified it is not
verified.** Synced has to mean checked and good or the word is worth nothing. The
dot is neutral for the mirror reason: amber asserts something is wrong with that
mapping, and what is actually known is only that nobody could look.

### Why it recurs, and what to do about the next one

The three fixes are three guards. None of them stops a fourth consumer being
written next month that reads `_catalogue[code].rows`, finds it empty, and draws
a conclusion — because the empty array still does not say why it is empty.

The durable fix is to make absence unrepresentable as an answer: hold read state
alongside the rows (never-read / failed / read-at) so a consumer cannot get to
the rows without passing the question, or return a value that throws rather than
compares. Not done, and deliberately not done today — it changes a shape three
live surfaces depend on, on a trading day.

Until then, the standing rule for this file: **anything that consults the
catalogue asks whether it was read before asking what is in it.**

---

## Context — what was and was not done on 2026-08-25

- **Product 195's Eleme listing was corrected to 3 by hand in the merchant app**
  at approximately 22:10 +08. Single box, known quantity, no guess path
  reachable.

- **The mapping typo was deliberately left unfixed.** Correcting the name would
  re-open an automated push path for that product while finding 4 remains open.
  The listing is right; the mapping is still wrong, on purpose. Anyone fixing
  the name should check finding 4 first.

- Nothing else was written. No queue row was retired, re-queued or cleared; no
  process was started, stopped or restarted; no stock was pushed.

Source: read-only surveys of `roots.db` on 2026-08-25 via
`.github/workflows/ro-query.yml`, plus the code cited above at `4cc2b1d1`.

## Context — what was and was not done on 2026-08-26

- **The mapping screen's grouping was replaced** — finding 5. Three groups that
  partition every active product: Needs attention, Synced, Not on Eleme. The
  sync switch is reported on each row as a read-only marker and no longer decides
  any group. Rows needing attention sort first, and inside them the ones still
  pushing sort above the ones that are not, so product 195 is the first row on
  the page instead of absent from the count.

- **Nothing was written.** No mapping was created, edited, hidden or deleted; no
  queue row was retired or re-queued; no stock was pushed; no process was
  started, stopped or restarted. The rows are correct; only the labelling changed.

- **Finding 7 was found in this branch's own classifier** and fixed there, after
  the same fault had already been fixed twice that morning in the name gate. All
  three fixes are guards on consumers; the shape that produces the fault is
  unchanged and is recorded as open in that finding.

- **Finding 6 was left unfixed on purpose.** It is a daemon change, and product
  195's mapping is still deliberately wrong (see the 2026-08-25 context above) —
  the same reason applies.

Source: read-only queries of `roots.db` on 2026-08-26 over SSH, plus the code
cited above at `05e33123`.
