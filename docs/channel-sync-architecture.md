# Channel Sync Engine — Architecture Spec (Phase 1)

**Companion to `docs/channel-sync-audit.md`.** The audit says what exists. This
says what gets built. Read the audit first; this document does not repeat its
evidence, only its conclusions.

**What this is.** A specification for one shared sync engine that owns all the
plumbing — locking, queuing, retries, recovery, alerting, health — with a thin
adapter per channel that owns only the platform-specific talking. Written for
the product owner, not for an engineer: plain language in the reasoning, exact
file and table names only where precision matters.

**What this is not.** It is not a migration script, not a UI design, and not an
implementation. No code is proposed line by line. Where a decision was locked in
the brief, it is treated as settled and specified, not re-argued. One place where
I think a locked decision has a real problem is in **OBJECTIONS** at the end,
along with a second objection that was raised, checked against the code, and
withdrawn. Nothing has been quietly changed.

**Scope of Phase 1: stock and orders only.** Price sync is explicitly out. So is
listing creation. So is the tenant-installed agent.

---

## 1. The problem, restated in one page

The audit found three integrations that solved the same problems separately and
to different standards. The specifics that matter:

- **No locks anywhere.** All three queue drains do a `SELECT … WHERE
  status='pending'` followed by a separate `UPDATE … SET status='processing'`.
  Two processes can select the same row. The only thing keeping Meituan's two
  daemons off each other is an environment variable and a comment.
- **Recovery exists on one channel.** Meituan has a drift sweep that re-reads
  actual stock and re-queues the gap. Eleme has nothing; a queue row that burns
  its three attempts is unreachable forever. Gzgrocery has a partial equivalent
  that only runs after a session recovery.
- **Alerting ranges from 17 calls to zero.** The gzgrocery order reader has no
  alerts, no admin route, and no health tile. An hour of total silence is
  indistinguishable from an hour with no orders.
- **Matching rules are inconsistent and, inbound, still fuzzy.** Name-substring
  matching was pulled out of Meituan's *push* path after it was measured at 133
  of 393 mappings sitting one rename away from writing stock at the wrong
  product. The same class of rule is still live *inbound*, where it decides
  which product a sale deducts from.
- **Single-tenant literals throughout**, including a store code hardcoded with
  no override, a store name compiled into a database column name, and a brand
  prefix compiled into a SKU matcher.

The pattern behind all of it: **every fix landed inside one integration and
never travelled.** Meituan learned that a stuck queue and a busy queue look the
same on screen, and added an "oldest pending" figure; Eleme and gzgrocery still
cannot tell those apart. Gzgrocery learned that a dead session can run unnoticed
for a month, and added session health probes; the gzgrocery *order* reader,
written later, has none.

**The fix is structural, not a list of patches.** If the plumbing lives in one
place, a lesson learned once is learned everywhere — including on channels
nobody has built yet.

---

## 2. Phasing, and where the seam sits

### Phase 1 — this spec

Build the engine server-side. Wrap the **existing** Meituan, Eleme and gzgrocery
transport code as adapters plugged into it.

**The way roots-v2 talks to each platform does not change.** The Playwright
browser automation in `lib/meituan-browser.js`, `lib/shangou-browser.js`,
`lib/eleme-browser.js` and `lib/guanyi-browser.js`, and the HTML scraping in
`lib/gzgrocery-admin.js`, are moved behind the adapter interface **as they
are**. Their fingerprint spoofing, their endpoint choices, their pacing, their
response parsing — all unchanged. Only the plumbing around them changes.

This is deliberate and it is the single most important constraint in the
document. Those files encode months of hard-won knowledge about how each
platform behaves and how not to get flagged. Rewriting them at the same time as
replacing the plumbing would mean that when something breaks, nobody can tell
which change broke it.

### Phase 2 — the tenant-installed agent (noted, not designed)

A small program the tenant installs on a machine in their own premises becomes
an **additional transport**. The adapter's job — "which listing is this
product", "what does a cancelled order look like on this platform" — does not
change. Only *where the browser runs* changes.

Agent updates in Phase 2: silent auto-update, staged rollout — our own tenant
first, wider release only after a healthy soak — with a manual override to push
to everyone immediately. Not designed here.

### Phase 3 — new tenants are agent-only (noted, not designed)

Server-side browsers remain only for connections that predate the agent.

### Where the seam sits — say it precisely

The seam is **between the adapter and the browser session it drives**, not
between the engine and the adapter.

```
  ENGINE  ──►  ADAPTER  ──►  TRANSPORT  ──►  the platform
                             ▲
                             └── this box is what Phase 2 replaces
```

Concretely, an adapter must never call `require('playwright')`, never open a
file under `data/*-sessions/`, and never construct a browser. It receives a
**session handle** from the engine and calls methods on it. In Phase 1 that
handle is backed by a server-side Playwright context. In Phase 2 the identical
handle is backed by a request/response channel to the tenant's agent, which runs
the browser locally.

For that to hold, the session handle's methods must be things that can survive a
network hop: *"fetch this URL from inside the logged-in page and give me the
JSON"*, *"navigate here"*, *"tell me if we are still logged in"*. They must not
be *"give me a Playwright Frame object"*. Today `lib/meituan-browser.js` and
`lib/eleme-browser.js` already work almost entirely through in-page `fetch`
calls returning plain JSON, so this is close to true already — the work is
drawing the line explicitly and removing the handful of places that reach for a
live browser object (notably the DOM-clicking `acceptOrder` at
`lib/meituan-browser.js:829-844`, which is gated off by default and can be
retired rather than ported).

**One consequence to accept now:** anything an adapter does that needs a live,
stateful browser *between* calls (a multi-step wizard where step 2 depends on
the DOM left by step 1) will be awkward in Phase 2. The re-login flow in §8 is
the one place this genuinely applies, and it is specified to survive the hop.

---

## 3. The connection model

**The unit is a connection. "Daemon" as a named concept goes away.**

A connection is four fields:

| Field | Meaning | Who chooses |
|---|---|---|
| **platform** | Meituan, Eleme, Gzgrocery | Us — a fixed list we maintain |
| **platform product** | 外卖, 闪购, … | The tenant, at connect time, from what we know that platform offers |
| **location** | One of the tenant's own locations | The tenant |
| **label** | Free text | Defaults to a readable combination of the above; tenant-editable |

The engine reasons about **platform, platform product and location only**. The
label exists for humans — it is what appears in a health screen, an alert, a log
line and the "Needs you" list. Changing a label changes nothing about behaviour.

A tenant may have many connections, including several on the same platform. A
tenant may use one platform product, some, or all.

**What this replaces.** Today the shape is: one pm2 process per integration, its
scope defined by environment variables (`SHANGOU_STORES=yuexiu`,
`MEITUAN_SKIP_STORES=yuexiu`, `GZGROCERY_STORE_CODE=tianhe`). Under the new
model those five environment variables become five rows in a table, created
through the admin, visible on a screen, each with its own health, its own
schedule, its own alerting.

**Roots' five connections after cutover:**

| # | Platform | Platform product | Location | Default label |
|---|---|---|---|---|
| 1 | Meituan | 外卖 | Tianhe | Meituan 外卖 · Tianhe |
| 2 | Meituan | 闪购 | Yuexiu | Meituan 闪购 · Yuexiu |
| 3 | Eleme | Napos | Tianhe | Eleme · Tianhe |
| 4 | Gzgrocery | Guanyi ERP (stock) | Tianhe | GZ Grocery stock · Tianhe |
| 5 | Gzgrocery | OpenCart admin (orders) | Tianhe | GZ Grocery orders · Tianhe |

Connections 4 and 5 are separate because they are separate systems with separate
credentials, separate failure modes and separate transports — a fact the audit
found buried and which the connection model now makes visible on screen. They
are two connections on the same platform for the same location, which is exactly
the case §4's locking exists to handle.

---

## 4. The engine / adapter boundary

### What the engine owns

Everything that is not platform-specific:

- **Connections** — creation, configuration, enable/pause/disable, labels.
- **The work queue** — one table for all channels, atomic claiming, retries,
  backoff, terminal handling, and the recovery that makes "terminal" survivable.
- **Locking** — per Tacet product, across all connections (§5).
- **Scheduling** — the tenant's clock schedule as a floor, the learned rate on
  top, our hard ceiling above both (§7).
- **Sessions** — storage, encryption, per-connection isolation, expiry
  detection, the re-login flow (§8, §9).
- **Health and liveness** — is this connection up, when did it last run, what
  failed, what is queued.
- **The recovery sweep** — periodic full-stock comparison and correction (§6).
- **Down handling** — the grace window and the push-to-zero behaviour (§7b).
- **Order ingestion** — creating the Tacet order, deducting stock, the
  idempotency ledger, the unmatched-line path (§10).
- **Product mapping** — storage, confirmation state, and the only lookup any
  adapter is allowed to use (§11).
- **Cancellation policy** — deciding whether stock may be restored (§13).
- **"Needs you"** — the single queue of things a person must resolve (§14).
- **Alerting** — what fires, to whom, how loudly (§15).
- **Logging and retention** (§16).

### What an adapter must implement

An adapter is a description of one platform product. It should be small. If an
adapter is large, the boundary is in the wrong place and the engine is missing a
capability.

An adapter provides:

| Capability | What it does | Roughly |
|---|---|---|
| `describe()` | Static facts: platform name, platform product name, what it can do (reads orders? writes stock?), what a connection needs to be configured (a shop id, an admin URL, …), and which cancellation signals it can supply (§13). | Data only |
| `probeSession(session)` | "Are we still logged in?" Returns connected / expired / challenged / unknown. | Small |
| `beginLogin(session, ctx)` / `submitChallenge(session, code)` | Drive the platform's login far enough to hand back "needs a password", "needs an SMS code", "done". Used by the phone re-login flow (§8). | Medium |
| `readCatalogue(session)` | The channel's listings for this connection: listing id, listing name, its options/specs, and current stock per option. Feeds mapping and the recovery sweep. | Medium |
| `readOrders(session, sinceWindow)` | Orders in a window, normalised to the engine's order shape (§10). | The largest piece |
| `readVoids(session, window)` | Cancellations/refunds, where the platform reports them separately. Optional — an adapter may declare it cannot. | Small or absent |
| `writeStock(session, targets)` | Set stock for a list of `(listing id, option id, quantity)`. Returns per-target outcome, classified as **succeeded / permanently-rejected / try-again**. | Medium |
| `writeOpenClosed(session, open)` | Optional. Only Meituan has it today. | Small |

That is the whole interface. Note what is **not** on it: no retry logic, no
queue access, no database handle, no alerting, no scheduling, no session file
handling, no locking. An adapter that reaches for any of those is a bug.

**Why the outcome classification matters more than it looks.** The audit found
that Eleme's most valuable single fix was distinguishing "the catalogue could not
be read" (try again) from "this name is not in a catalogue we did read"
(permanently rejected), because collapsing them burned three attempts in half a
minute and buried a healthy row. The engine cannot make that distinction — only
the adapter knows. So the engine demands it, in the interface, from every
adapter, on day one.

### Adapter sizes after Phase 1

The existing transport files are wrapped, not rewritten, so they keep their
current size. What should be small is the **adapter shim** — the file that
translates between the engine's vocabulary and the existing driver's:

| Adapter | Wraps | Expected shim size |
|---|---|---|
| Meituan 外卖 | `lib/meituan-browser.js` | small |
| Meituan 闪购 | `lib/shangou-browser.js` | small |
| Eleme Napos | `lib/eleme-browser.js` | small |
| Gzgrocery — Guanyi stock | `lib/guanyi-browser.js` | small–medium (its write is a create-and-approve document flow, not a stock set) |
| Gzgrocery — OpenCart orders | `lib/gzgrocery-admin.js` | small |

If any shim starts growing retry logic, alert calls or queue queries, that is
the signal the engine is missing something.

---

## 5. Locking — per product, not per connection

**The decision:** locks are per Tacet product, not per connection. All queue
claims are atomic.

**Why per product.** Two connections on the same platform can sell the same
item. Roots has exactly this today with the two gzgrocery connections, and would
have it again the moment a second Meituan 外卖 location shares a product with the
first. A lock scoped to a connection would let both connections compute a stock
target from the same starting number and write two different answers. The thing
that must not be raced is **the product's stock**, so that is what the lock
protects.

### The mechanism, concretely, against SQLite today

The database is SQLite via `better-sqlite3` (`package.json`, `^9.4.3`), in WAL
mode (`database.js:27`). SQLite allows many concurrent readers and **exactly one
writer at a time**, and it applies a single `UPDATE` statement atomically. That
is the whole basis of the design — no new locking primitive is needed, only
discipline about statement shape.

**Two mechanisms, both of them single statements:**

**(a) Atomic queue claim.** Replace every select-then-update pair with one
statement that both selects and claims:

> `UPDATE channel_work SET status='processing', claimed_by=<worker>,
> claimed_at=<now>, attempts=attempts+1 WHERE id IN (SELECT id FROM
> channel_work WHERE status='pending' AND … LIMIT n) RETURNING *`

Because the whole thing is one write statement, two workers cannot both come
away with the same row: the second one's `WHERE status='pending'` no longer
matches. `RETURNING` is available in the SQLite version bundled with
`better-sqlite3` 9.

This replaces the three current implementations:
`scripts/meituan-daemon.js:845` + `:902`, `scripts/eleme-daemon.js:480` + `:526`,
`scripts/guanyi-daemon.js:214` + `:261`.

**(b) Product lease.** A small table, one row per `(tenant, product)`, holding
who currently owns the right to write that product's stock anywhere, and when
that ownership expires. Acquired with a single insert-or-update statement that
only succeeds if the row is free or the previous lease has timed out. Released
on completion; expires on its own if a worker dies mid-flight, so a crash cannot
wedge a product permanently.

A worker takes the lease, computes the target once, writes it to every
connection that carries that product, then releases. This also removes a subtle
current bug class: today the same product's stock can be computed at two
different moments for two different channels and land as two different numbers.

**Three supporting changes that are not optional:**

1. **Set a busy timeout.** There is currently **no `busy_timeout` pragma
   anywhere in the codebase** — `database.js:27-28` sets only `journal_mode` and
   `foreign_keys`. With several processes writing, a writer that finds the
   database locked fails immediately instead of waiting. Every connection the
   engine opens must set a busy timeout (a few seconds).
2. **Use the async transaction helper.** `lib/db-transaction.js` exists precisely
   because better-sqlite3's own `db.transaction()` commits at the first `await`
   and cannot hold async work — which is exactly the shape of every sync
   operation. The engine uses `withTransaction`, not `db.transaction`.
3. **Keep the write short.** A lease held across a slow browser call blocks other
   work on that product. The rule is: take the lease, read the number, release the
   lease, *then* do the slow platform call, and record the result against the
   lease's identity. The lease guards the decision, not the network round trip.

### What changes if the Postgres migration lands

The design was chosen so the shapes carry over unchanged:

| Today (SQLite) | After Postgres |
|---|---|
| `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING *` | `SELECT … FOR UPDATE SKIP LOCKED` then update — a better-behaved version of the same claim; multiple workers proceed in parallel instead of serialising |
| Product lease row with an expiry | Either the same lease table, or a Postgres advisory lock keyed on the product id — advisory locks release automatically when a connection drops, removing the need for expiry sweeping |
| Single-writer serialisation | Real concurrent writes; the busy-timeout concern disappears |

The engine's own code should express these as two named functions —
"claim work" and "hold this product" — with one implementation today and a
second later. Nothing above the engine should know which is in use.

---

## 6. The recovery sweep

**The decision:** every connection gets a periodic sweep that reads the
channel's full stock and compares it against Tacet. On mismatch, the sweep
**corrects the channel automatically**. Tacet is the source of truth for stock.
It logs what it overwrote.

**Why this earns its place.** The audit's sharpest structural finding is that a
queue row which exhausts its retries is terminal and unreachable — and that only
Meituan has anything that rescues it. Meituan's `lib/meituan-drift-sweep.js`
does exactly this job and its header states the reason plainly: the push queue
is edge-triggered, one row per change, so a push that dies terminally leaves
that product frozen on the channel with nothing left to retry it. Generalising
that sweep makes every other recovery mechanism unnecessary — retries become an
optimisation rather than the last line of defence.

**Behaviour:**

- Runs per connection on its own cadence (see §7 — it is cheap and does not need
  the fast rate).
- Reads the channel's full catalogue with current stock via
  `adapter.readCatalogue()`.
- For every mapped product, compares the channel's number to Tacet's.
- On mismatch, queues a corrective write **through the same queue and the same
  product lease as any other write**. It does not write directly. This matters:
  it means a sweep correction cannot race an order deduction.
- Logs, per correction: the connection, the product, the channel's number, the
  Tacet number, and the time.
- Unmapped listings on the channel are **not** touched and **not** reported as
  errors. They are somebody else's products or products we have not mapped yet;
  §12 governs those.

**Guards, carried over from the existing implementations because they were
learned the hard way:**

- **A partial read must never drive a mass correction.** `scripts/guanyi-daemon.js`
  already refuses to act when most of its mapped SKUs are missing from a listing
  read. The engine applies this to every channel: if the catalogue read returns
  substantially fewer rows than we have mappings for, the sweep aborts and raises
  a health warning rather than "correcting" everything to zero.
- **A settle window.** A correction must not fire against a number the channel
  has not yet applied from our own recent write. Guanyi's daemon uses three
  minutes for this. The engine holds a per-product "recently written" marker and
  skips it until the marker ages out.
- **A per-cycle cap.** A large correction batch is suspicious. Cap it, apply the
  cap's worth, and raise the rest as a single "Needs you" item rather than a
  hundred.

### The consequence, stated plainly

**Editing stock directly in a channel's own app will not stick.** If someone
opens the Meituan merchant app and sets a product to 20, the next sweep will set
it back to whatever Tacet says. This is intentional — it is what "Tacet is the
source of truth" means — but it is surprising the first time it happens, so:

- The correction log must be readable in the admin, per connection, showing
  *what was overwritten, from what, to what, and when*, so "why did my change
  disappear" has an answer on screen and not in a terminal.
- The connection's health screen should say, in words, that the channel's stock
  is managed by Tacet and manual edits there will be reverted.

### 6b. The Guanyi pickup inference does not come across — decision

**What it is.** A legacy mechanism inside the Guanyi daemon that **guesses a
customer collected an order** when a stock number drops between two reads
(`scripts/guanyi-daemon.js:400-610`). It exists because we could not read
gzgrocery's orders at all when it was written — the audit calls it "3C". It
samples Guanyi's on-hand every 60 seconds, diffs against a stored baseline in
`guanyi_pickup_baseline`, and treats a drop as a sale.

**It is still firing in production.** Confirmed by operator screenshots dated
2026-08-29 at 10:55 and 18:07, both Guanyi tianhe, 184 products, following a
session expiry and a manual re-login. The message they show is the bad-read
guard's re-baseline notice — *"pickup baselines re-synced to live stock — N
product(s) after 5 identical reads"* — emitted when the guard has seen an
identical reading for `GUARD_RESYNC_AFTER` cycles and accepts it as the new
truth (`scripts/guanyi-daemon.js:465-505`).

**Note what those two screenshots actually show:** a session gap, then the
inference throwing its own baseline away and starting again from whatever number
Guanyi happened to be showing. Any units that moved during the gap are
unaccounted for — the code says so itself and deliberately infers no pickup from
the jump, because inventing a decrement from a number it has just admitted it
does not trust is how an earlier −1,863 unit incident happened.

**The decision: it must NOT be carried into the new engine.** It is a workaround
for not having real pickup data. It infers sales from a number that also moves
for reasons that are not sales — our own pushes settling, partial listing reads,
proxy blips, the ERP's own adjustments — and every one of those is a source of
drift, not a defence against it. The engine's recovery sweep (§6) does the
opposite job: it treats Tacet as the truth and corrects the channel. Running an
inference that treats the *channel's* number as evidence about our stock,
alongside a sweep that overwrites the channel's number, would have the two
fighting each other.

**One thing that is not a retirement:** on 2026-08-30 the re-baseline notice
stopped being pushed to the ops WeCom group (commit `b83fd15`), on the grounds
that nothing is lost and nobody needs to act. That is defensible as alerting
hygiene, but it changes nothing about the mechanism — it only removes the signal
the operator was using to notice it running. The inference is as active today as
it was in the screenshots.

**What "trusted" has to mean before it is deleted.** The order reader replaces it
only if the order reader is actually seeing the sales. Concretely, all four:

1. **The order reader is live**, not `off` and not `shadow` — connection 5 has
   completed cutover and is writing stock through the engine.
2. **Coverage is demonstrated, not assumed.** For an agreed observation period
   (a month is the natural unit, since gzgrocery's ordering is weekly-ish), every
   stock movement the inference *would* have made is compared against what the
   order reader *did* make. The inference is left running in shadow for exactly
   this purpose — it becomes the control, not the mechanism.
3. **The gap is explained, not just small.** Where the two disagree, each
   disagreement has a known cause — a cancelled order, an ERP adjustment, a
   partial read — rather than being written off as noise. A residual the engine
   cannot account for means the order reader is missing a class of sale, and that
   is exactly the thing the inference was covering for.
4. **No unresolved "Needs you" items on connection 5** attributable to unmatched
   lines, because an unmatched line is a sale the order reader saw and did not
   deduct — which the inference *would* have caught, and which would therefore be
   a real regression on deletion.

Until all four hold, the inference stays in shadow mode: logging what it would do
and changing nothing. `GUANYI_PICKUP_MODE` already has exactly this setting.

**Where in the cutover sequence.** Connection 5 (gzgrocery — OpenCart orders) is
last in the order in §20. Retirement is **after** it, not part of it:

| Point | State of the inference |
|---|---|
| Before connection 4 (Guanyi stock) cuts over | Unchanged — whatever mode the box is in today (§20 precondition 1 establishes which) |
| Connection 4 cutover | Unchanged. The engine takes over the stock push; the inference is left alone so only one thing changes at a time |
| Connection 5 cutover | Forced to `shadow` as part of the go-live step, if it is not already. This is the existing double-count guard, now enforced rather than conventional |
| Observation period after connection 5 is live | Runs in shadow as the control for criteria 2–4 above |
| Retirement | The daemon code, `guanyi_pickup_baseline`, `guanyi_pickup_log`, the `/guanyi/pickups` admin routes and the pickups panel are removed together. The `guanyi_pickup_log` history is retained read-only until the next schema migration, because it is the record of what the channel did before the order reader existed |

**The one thing that must not happen:** deleting the inference at the same moment
connection 5 goes live. That would remove the control and the mechanism in one
step, and if the order reader turns out to under-count, nothing would be left to
show it.

---

## 7. Poll rate

**The decision:** the tenant sets a clock schedule per connection. That schedule
is a **floor, not a ceiling**. The engine may go faster based on observed order
arrival rate. It may never go slower than the tenant's stated hours. A hard
maximum rate is set by us and is not tenant-editable.

**How the three numbers combine.** For any moment, the effective interval is:

1. **The tenant's floor.** "Fast between 10:00 and 21:00" means: during those
   hours, poll at least that often. Outside them, the tenant's slower rate (or
   their "don't poll" setting) applies.
2. **The learned rate.** The engine tracks how often orders actually arrive on
   this connection. A connection taking an order every four minutes gets polled
   faster than one taking an order an hour. This can only *increase* frequency
   relative to the floor, never decrease it.
3. **Our ceiling.** A hard minimum interval per platform, set by us, that no
   tenant setting and no learned rate can go below.

**Why the ceiling is ours and not theirs.** Every one of these platforms
actively detects automation. The audit found this is not theoretical: Meituan's
poll interval is 5 minutes *by design*, jittered ±40%, with the reasoning
recorded in the code — a slow, irregular poll minimises page loads and therefore
bot footprint, and order timing is not critical because Meituan prints its own
receipt. 闪购 had to be moved to a real Chrome over CDP because Playwright's
fingerprint was rejected outright. A tenant who sets "poll every 10 seconds
because I want to see orders instantly" is asking for their account to be
flagged. That risk is ours to manage, so the limit is ours to set.

**A connection with no schedule configured must still behave sensibly.** It runs
on the learned rate alone, between our ceiling and a conservative default floor.
A new tenant who configures nothing gets a working connection, not a dormant
one.

**What carries over:** jitter stays. A perfectly regular poll is itself a bot
signal. Every interval the engine computes is jittered before use.

**Store-hours gating stays, and generalises.** Meituan and Eleme currently sleep
outside the location's opening hours plus a grace window; gzgrocery reads no
hours at all. Under the engine, the tenant's schedule *is* the hours setting, so
the inconsistency disappears — gzgrocery gets one because every connection gets
one, and a wholesale connection can simply be scheduled around the clock.

### 7b. Connection down → stock to zero

**The decision:** when a connection is dead — session expired, repeated auth
failure — start a grace window. Its length is tenant-settable per connection,
with a sensible default. If the connection recovers inside the window, **nothing
happens and nothing is announced**. If the window expires, push that channel's
stock to zero and hold it there until the connection is restored, then resync
immediately.

**Why.** A dead connection means the channel is selling against numbers that
stopped updating. The audit documented what that costs: gzgrocery's stock push
failed roughly 78% of the time for a month — 8,902 failures all reading "not
logged in" — while gzgrocery went on selling against frozen numbers. Zero is the
only safe number to show when you have stopped knowing the real one.

**The details that make it usable:**

- **Silence inside the window is the point.** A session that blips and recovers
  in ninety seconds must not page anybody. Only the window *expiring* is an
  event.
- **Pushing to zero requires a working connection.** This is the awkward part
  and it must be stated: if the session is dead we usually cannot write either.
  So the zero-push is attempted, and if it fails, the connection is marked
  *"cannot be zeroed — stock on this channel is stale and we cannot correct
  it"*, which is a **loud** alert and a "Needs you" item. Do not pretend the
  channel is at zero when we failed to set it.
- **Holding at zero means the sweep participates.** While a connection is in the
  zeroed state, the recovery sweep's target for every mapped product on it is
  zero, not the Tacet number. Otherwise the sweep would immediately undo the
  zeroing.
- **Restoration is immediate and complete.** On reconnect, the connection leaves
  the zeroed state and a full sweep runs at once, before the normal cadence
  resumes. The tenant does not wait 30 minutes for their shop to come back.
- **The zeroing is logged as a distinct event**, so a later "why did we sell
  nothing on Tuesday" has an answer.

---

## 8. Re-login must be drivable from a phone

**The decision:** recovery from a dead session must be completable by a tenant
who is not at a computer.

**The flow:**

1. **Notification.** The connection is detected as expired or challenged. The
   tenant gets a push notification on their phone — "Meituan 外卖 · Tianhe needs
   you to log in again."
2. **Tap.** The notification opens that connection's page in Tacet on the phone.
3. **Drive.** The tenant taps "Reconnect". The engine tells the machine holding
   the browser to open the platform's login page, headlessly. No VNC, no
   screen-sharing, no remote desktop.
4. **Collect.** The adapter reports what the platform is asking for. Tacet
   renders the matching input:
   - *account and password* → a form in Tacet, submitted once, **never stored**
     (§9);
   - *SMS code* → Tacet shows the masked phone number the platform says it sent
     to, and a field for the code;
   - *QR scan* → Tacet displays the QR image the platform generated, for the
     tenant to scan with the platform's own app;
   - *slider or image challenge* → **see OBJECTIONS**.
5. **Relay.** The code or credential is passed to the machine running the
   browser; the adapter completes the login.
6. **Restore.** The session is captured, encrypted and stored (§9). The
   connection returns to connected. If it was in the zeroed state, a full resync
   runs immediately (§7b).

**Why this design survives Phase 2 unchanged.** Every step above is a message,
not a shared screen: *"start a login"*, *"what do you need?"*, *"here is a
code"*, *"done"*. None of them requires Tacet and the browser to be on the same
machine. In Phase 1 the browser is on our server and the messages are internal
function calls; in Phase 2 the browser is on the tenant's agent and the same
messages travel over the wire. Nothing above the transport changes.

**What exists to build on.** `lib/integrations/session-relay.js` already
implements this exact state machine —
`idle → connecting → awaiting_sms → connecting → ok`, with `captcha` and
`failed` branches and an `expired` state that re-enters `connecting` — behind a
deliberate driver seam, with the control-plane table `integration_sessions`
already defined. The wizard UI in `public/retail-admin/15-integrations.js`
already renders the SMS step. **What is missing is a real driver**: the only
implementation in the tree is the simulation. Phase 1's job is to register the
real driver, generalise the state machine from its current
`meituan | qingyun` restriction to every connection, and connect it to the phone
notification path.

**What this replaces.** Today re-login means opening the ops screen on
`system.rootskitchenchina.com` behind HTTP basic auth, which serves a VNC view
of a shared virtual display, and typing into a real Chrome window rendered on it
— with a global "one login at a time" lock because two browsers stacked on one
display is how an operator ends up typing into the wrong one. That machinery
covers Meituan and Guanyi. **Eleme is not on it at all**: reconnecting Eleme
today means a laptop with a display, running a script, and copying a file to the
server by hand. The ops screen was built after a Guanyi outage where re-login
took about forty minutes, almost all of it installing tooling — which is
precisely Eleme's current situation, unfixed.

The ops screen does not have to be deleted in Phase 1; it can remain as an
engineer's escape hatch. But it stops being the tenant-facing answer.

---

## 9. Sessions, not passwords

**The decision:** the engine stores sessions, not passwords.

### What happens today

| Connection | What is stored | Where | Protection |
|---|---|---|---|
| Meituan 外卖 / 闪购 | Browser session (cookies + local storage) | `data/meituan-sessions/<store>-session.json` | **Plaintext file.** Excluded from git by `/data/` in `.gitignore`; no encryption at rest |
| Eleme | Browser session | `data/eleme-sessions/<store>-session.json` | **Plaintext file** |
| Gzgrocery — Guanyi | Browser session | `data/guanyi-sessions/<store>-session.json` | **Plaintext file** |
| Gzgrocery — OpenCart | **A reusable username and password** | `GZGROCERY_ADMIN_USER` / `GZGROCERY_ADMIN_PASS` environment variables | **Plaintext env** |
| Eleme (dead path) | OAuth access and refresh tokens | `eleme_tokens` table | **Plaintext columns.** Written by a live route, read by nothing (§17) |

Two further credential stores exist and are read by nothing: environment
variables `MEITUAN_<CODE>_USER` / `MEITUAN_<CODE>_PASS`, read into fields no code
consumes; and encrypted `meituan.<code>.user` / `.pass` keys defined in
`lib/tenant-creds.js` that no daemon requires.

### What has to change

**1. Sessions move into the database, encrypted at rest.** One row per
connection. The encryption primitive already exists and is already used for
tenant credentials: `lib/secret-box.js` provides AES-256-GCM with a versioned
token format and a master key from `TENANT_SECRET_KEY`, and it fails loudly on a
tampered ciphertext rather than returning garbage. Sessions use it. Nothing new
is invented.

**2. Isolation is per connection, by construction.** Two connections on the same
platform must not be able to clobber each other's session. Today the session
filename is keyed on store code alone — which is why the two gzgrocery
connections and the two Meituan connections work only because they happen to use
different directories or different store codes. Under the engine:

- the session record is keyed on **connection id**, not store code;
- each connection gets its **own browser profile directory**, named by connection
  id, never shared;
- a connection's session is loaded only into a browser context created for that
  connection, and never written back to any other connection's record.

**3. The OpenCart password goes too — no exception.** gzgrocery's OpenCart admin
is the only path in the system that holds a reusable password, and its client
does attempt an unattended re-login. An earlier draft of this document argued for
a carve-out on the grounds that this was a working, proven capability worth
keeping. **That argument was checked and withdrawn** — see OBJECTIONS for the
facts. In short: nothing establishes that this re-login has ever succeeded, or
ever run, and the two gzgrocery logins had been conflated.

So gzgrocery's order reader is treated identically to every other connection.
This is straightforward for it, because OpenCart's authenticated state is an
ordinary session — an `OCSESSID` cookie plus a per-session `user_token`
(`lib/gzgrocery-admin.js:89-110`). Under the engine:

- the tenant enters the OpenCart password once, in the reconnect flow (§8);
- the engine performs the login, captures the resulting cookie jar and
  `user_token` as that connection's **session**, encrypts it, stores it, and
  **discards the password**;
- when the session expires, the connection enters "needs re-login" like any
  other and the tenant re-enters the password through the same phone flow.

No browser is involved, so the reconnect screen for this connection is a single
password field — the simplest of the five.

**4. What is deleted.** The two dead Meituan credential paths (the unused
environment variables and the unused `tenant-creds` keys) are removed, so that
nobody later mistakes them for the live mechanism. The `eleme_tokens` table and
its plaintext token columns go with the dead OAuth client (§17).

**5. Passwords typed during re-login are never persisted.** A password entered
in the flow in §8 is passed through to the login attempt and discarded. It is not
written to the database, not logged, and not held in memory beyond the attempt.

---

## 10. Orders always land

**The decision:** an inbound order is never rejected for containing an
unrecognised line. The order is created. Unmatched lines are flagged and deduct
nothing. They appear in "Needs you".

**This is close to current behaviour and mostly needs formalising.** Today all
three internal ingest paths create the order and mark an unresolvable line
`unmatched` or `ambiguous` rather than dropping it. What is missing is the
*second half*: nothing surfaces those lines to a person. An unmatched line today
is a string in a log column.

**The specified behaviour:**

- The order is created with all its lines, matched or not.
- A matched line deducts stock. An unmatched line deducts nothing and is marked
  as such on the order.
- The order's total and money are unaffected — they come from the platform's own
  totals, not from summing lines.
- Every unmatched line raises a **"Needs you"** item: *"An order on Meituan 外卖 ·
  Tianhe contained a line we do not recognise: «…». Which of your products is
  this?"* Resolving it creates the mapping (§11) and — this is the part that must
  work — **applies the deduction retroactively** for that order, and for any other
  order with the same unresolved line still in the window.
- Repeated unmatched lines for the same channel listing collapse into **one**
  "Needs you" item with a count, not one per order. §14's brevity rule.

**Why retroactive application matters.** Without it, resolving the mapping fixes
the future and silently leaves the past wrong — the stock is already sold and
still on our shelf count. With it, the tenant's action has an obvious and correct
effect.

---

## 11. Product matching

**The decision:** substring, prefix, leading-script-run and fuzzy name matching
are banned in both directions. Matching is by explicit stored mapping only,
confirmed by the tenant.

### What is banned, exactly, and where it lives today

| Rule | Location | Direction | Status |
|---|---|---|---|
| `_nameMatches` — whole-name *or* leading-script-run *or* case-insensitive English substring | `lib/meituan-browser.js:1220-1227` | outbound | Already removed from the push path. Still reachable via `_extractSku` (`:1436`) from three operator scripts |
| `_coreQuery` — leading same-script run | `lib/meituan-browser.js:1192-1197` | outbound | Still used to decide *what to type* into Meituan's suggest box |
| Map-name **unambiguous substring** fallback | `routes/meituan-internal.js:174-182` | **inbound** | **Live. Decides which product a sale deducts from** |
| Map-name **unambiguous substring** fallback | `routes/eleme-internal.js:217-223` | **inbound** | **Live. Same** |
| Unique-active-name `LIKE %first-CJK-run%` then `LIKE %first-English-run%` | `routes/meituan-internal.js:188-194`, `routes/eleme-internal.js:228-234` | **inbound** | **Live. The loosest rule in the system** |
| `attachChannelLines` exact-then-substring | `routes/meituan-internal.js:276-283` | inbound | Live — attaches prices, not stock |
| SKU token scraped out of a listing name: `(String(item.name).match(/\d+-\d+/) \|\| [])[0]` | `routes/meituan-internal.js:153` | inbound | Live |
| `extractSku` fallback arm `/\b(\d+-\d+[A-Za-z]?)\b/` | `lib/gzgrocery-admin.js:335` | inbound | Live |
| `skuFromGuanyiName` — first `\d+-\d+` in the listing name | `routes/guanyi-admin.js:23-26` | outbound | Live — **auto-match only**, not the write |

**The measured cost of the outbound version, from the code's own record:** 133
of 393 mappings and 13 of 19 bundles sat one rename away from resolving onto a
sibling product's listing; two bundles were doing it already, one of them
differing from its listing by a single space and pushing its count at a
different product's listing. The tiebreak that followed made the wrong choice
deterministic without making it right.

**The inbound version has never been measured.** It has the same shape and a
worse blast radius: outbound it writes a wrong stock number, which the sweep
would now correct; inbound it deducts the wrong product, which nothing corrects
because nothing knows it was wrong.

### What replaces them

**One lookup, used by everything, in both directions:** given a connection and a
channel listing identity, return the mapped Tacet product, or return nothing.

- The channel listing identity is the platform's own stable identifier where one
  exists — Meituan `spuId`/`skuId`, Eleme `itemGlobalId`/`specGlobalId`, Guanyi
  `sku_id` — and the listing name only as a **display label**, never as a key.
- If no mapping exists, the lookup returns nothing. It does not guess. Outbound,
  nothing is written; inbound, the line is flagged (§10).
- A mapping has a **confirmation state**: `suggested` (the system proposed it) or
  `confirmed` (a person accepted it). **Only `confirmed` mappings are used for
  stock writes and stock deductions.** A `suggested` mapping is a to-do, not a
  fact.

**Suggestion is allowed; matching is not.** Fuzzy comparison keeps one job: on
the mapping screen, proposing candidates for a human to confirm. It never
resolves anything on its own. This is the distinction that makes the ban
workable — the tenant does not have to map 393 products by hand from a blank
screen.

### Retiring the banned rules

| Rule | Action |
|---|---|
| `routes/meituan-internal.js` substring + `LIKE` tiers | Deleted. Replaced by the shared lookup. Unmatched → §10. |
| `routes/eleme-internal.js` substring + `LIKE` tiers | Deleted. Same. |
| `attachChannelLines` substring | Kept, but **scoped to price attachment only** and explicitly barred from influencing which product a line deducts from. Its current comment already says the copy-text parse is what deducts and the structured rows only attach prices; that becomes enforced rather than intended. |
| `_nameMatches`, `_coreQuery`, `_extractSku` | Deleted, along with the three operator scripts that reach them (`meituan-set-stock.js`, `meituan-test-libstock.js`, `meituan-test-libvariants.js`). If a "set one product's stock by hand" tool is still wanted, it takes a product id, not a name. |
| `_searchTerms`' use of `_coreQuery` | **Kept.** It decides what string to type into Meituan's own search box to find a listing; it does not decide what counts as a match. The distinction is real and the code already makes it explicitly. |
| SKU token scraped from a listing name (`routes/meituan-internal.js:153`) | Deleted as a *matching* rule. Retained as a *suggestion* input on the mapping screen. |
| `extractSku` fallback arm (`lib/gzgrocery-admin.js:335`) | Deleted. The `GV`/`GVF`-prefixed arm becomes a configured pattern (§16) and feeds suggestions only. |
| `skuFromGuanyiName` | Retained as a **suggestion** generator on the mapping screen. Its current use is already auto-match, not the write, and it already refuses ambiguous cases. |

### Migrating the existing mappings

There are roughly 393 Meituan mappings, plus Eleme's and Guanyi's. They cannot
simply be marked `confirmed` — the audit's whole point is that a third of them
were resolved by a rule we no longer trust.

**The migration:**

1. **Copy every existing mapping** from `meituan_product_map`,
   `eleme_product_map` and `guanyi_product_map` into the new mapping table, all
   marked `suggested`, carrying whatever platform identifiers they already hold
   (`meituan_spu_id`, `meituan_sku_id`, `eleme_item_id`, `spec_id`,
   `guanyi_sku_id`, …).
2. **Verify each one against a live catalogue read.** For each connection, read
   the channel's catalogue and check: does a listing with this stored identifier
   still exist, and does its current name still equal the stored name exactly?
   - **Identifier matches and name matches** → auto-promote to `confirmed`. This
     should be most of them and requires no human.
   - **Identifier matches, name differs** → `suggested`, flagged *"the listing
     was renamed"*. One click to confirm.
   - **No stored identifier, name matches a listing exactly** → `suggested`,
     flagged *"matched by exact name — please confirm"*, and the identifier is
     backfilled on confirmation.
   - **Anything else** → `suggested`, unresolved, on the mapping screen.
3. **Report the counts before cutover.** The tenant sees, per connection: *N
   auto-confirmed, N renamed, N need a decision*. That number is a cutover gate
   (§20).
4. **Nothing writes stock through an unconfirmed mapping**, so a connection can
   go live with some products unmapped — they simply show as "not on this
   channel" (§12) until confirmed.

**One thing this migration will surface, and it should be expected rather than
treated as a failure:** some of the 133 at-risk mappings are probably wrong
*today*. The verification will find them as name mismatches. That is the point.

---

## 12. Missing listings

**The decision:** a tenant setting with two values — **leave alone** (the
product shows as "not on this channel") or **auto-create the listing**. Build the
setting now. Ship Phase 1 with only "leave alone" available. Auto-create is a
later, per-platform addition. **Do not build listing creation in Phase 1.**

**What this means in practice:**

- The setting exists on the connection from day one, with "leave alone" selected
  and "auto-create" visible but disabled, labelled as coming later.
- A Tacet product with no confirmed mapping on a connection is displayed as
  **"not on this channel"** — a neutral state, not an error, not a "Needs you"
  item. Most tenants will legitimately sell different ranges on different
  channels.
- The mapping screen offers a filter for these, so a tenant who *does* want them
  all mapped can work the list.
- `adapter.describe()` declares whether the platform supports listing creation
  at all, so when auto-create ships it can be offered only where it works.

---

## 13. Cancellations and refunds

**The decision:** do not blanket-restore stock. If the engine can establish the
order was not yet made or picked up, restore automatically. If it cannot — the
order is already marked ready, a rider has it, it is past a fulfilment threshold
— do not touch stock; raise it in "Needs you".

**What happens today, and why it is wrong.** All three integrations restore stock
on the *transition* into a confirmed void, with no regard for whether the goods
have physically left. `routes/meituan-internal.js:369-376` and
`routes/eleme-internal.js:119-124` gate on the label being a *settled* void
rather than a request under review — which is a genuine improvement over doing
nothing, and it is not enough. A customer who cancels after the rider has
collected does not put the food back on our shelf, but the current code adds it
back to our count. That over-counts, and the over-count then propagates to every
other channel on the next push.

### The signals available, per connection

| Connection | Signals it can supply | Can it decide automatically? |
|---|---|---|
| **Meituan 外卖** | Rider assignment time, **rider collection time** (`rider.fetchedAt`), rider status text and status code, delivery time, and the platform's own status label (待接单 / 拣货中 / 配送中 / 已完成) | **Yes.** Rider-collected is an explicit timestamp. This is the richest of the five |
| **Meituan 闪购** | Same order API family and same field set | **Yes**, subject to confirming the rider fields are populated on 闪购 as they are on 外卖 — see OPEN |
| **Eleme** | The platform status label only. The label vocabulary distinguishes rider-assigned (骑手接单/待取餐) from rider-holding (已取货/已取餐/配送中) — see `routes/eleme-internal.js:81-85`. **No rider timestamps are collected**; the ingest writes no rider columns | **Partially.** Enough to tell "not yet collected" from "rider has it", but from a text label rather than a timestamp |
| **Gzgrocery — OpenCart orders** | The OpenCart order status string only, plus a delivery-time field. The configured active set already distinguishes `Paid` / `Processing` from `Shipped` / `全部发货` / `部分发货` | **Partially.** "Shipped" is a usable boundary; anything between paid and shipped is ambiguous |
| **Gzgrocery — Guanyi stock** | None. It does not carry orders | **N/A** |

### The rule

The engine asks the adapter one question: **"has this order passed the point of
no return?"** The adapter answers `no` / `yes` / `cannot tell`.

- **`no`** — the order was cancelled before anyone made or collected it.
  → Restore stock automatically, once, ledgered, with the existing
  `channel_stock_restored` guard so a repeating poll cannot restore twice, and
  the existing re-deduct path if the order later revives.
- **`yes`** — a rider has it, it is marked ready, or it is past the platform's
  fulfilment threshold.
  → **Do not touch stock.** Raise a "Needs you" item: *"An order on «connection»
  was cancelled after it was collected. Did the goods come back?"* with
  **Restore stock** and **Write it off** as the two actions. Writing it off
  records a loss against the existing waste/stock-movement path rather than
  silently doing nothing.
- **`cannot tell`** — the platform gave no usable signal.
  → Treated exactly as `yes`: **do not touch stock, raise it for a human.** The
  safe default when we do not know is to leave the count alone, because an
  incorrect restore silently inflates stock across every channel, while an
  un-restored cancel is visible as a shelf count that is one too low and is
  caught by the next physical count.

**The threshold is per adapter, not global,** because "the point of no return"
means different things on a food-delivery platform and a wholesale pickup order.
Each adapter states its own rule in code, in one place, with the signal it uses
named.

**Born-void orders keep their current handling.** An order whose very first
sighting is already cancelled never had stock deducted, so it must not be
restored. Both Meituan and Eleme already implement this (`bornVoid`); the engine
does it once, for all channels.

---

## 14. "Needs you"

**The decision:** one shared surface across all channels for anything where
Tacet is stuck and needs a person. It must stay short enough that people
actually clear it. Anything the engine can decide safely must not appear here.

**What already exists.** The Tacet dashboard already has a "Needs you" section,
fed by `GET /api/retail-admin/dashboard/ops` and rendered by
`public/retail-admin/03-dashboard.js`, with attention rows sorted by age. It
already carries one channel-related row: a stall row per channel from
`lib/channel-sync-stale.js`. **The engine extends this surface — it does not
build a second one.**

**What appears there, at minimum:**

| Item | Raised when | Actions offered |
|---|---|---|
| **Connection needs re-login** | A connection is expired or challenged | Reconnect (§8) |
| **Connection is down and cannot be zeroed** | The grace window expired and the zero-push failed (§7b) | Reconnect; acknowledge |
| **Unmatched order line** | An order arrived with a line we cannot resolve (§10) | Map it to a product; mark as not ours |
| **Cancellation needing judgement** | An order was voided past the point of no return, or the channel gave no usable signal (§13) | Restore stock; write it off |
| **Sweep conflict needing judgement** | The recovery sweep hit its per-cycle cap, or a catalogue read looked partial (§6) | Review and apply; ignore this cycle |
| **Mapping needs confirmation** | A mapping is `suggested`, not `confirmed`, and the product sells on that channel (§11) | Confirm; reject; choose a different product |

**The brevity rules, which are as much a part of the spec as the list:**

1. **Collapse by cause, not by occurrence.** Fifty orders containing the same
   unrecognised listing are **one** item with a count of fifty, not fifty items.
2. **Never raise what the engine can decide.** A transient push failure that the
   retry will fix, a stock mismatch the sweep will correct, a session blip that
   recovered inside its grace window — none of these appear. If it appears here,
   a human genuinely has to choose something.
3. **Every item has at least one action that closes it.** An item a person can
   only read is a notification, not a to-do, and belongs in the log.
4. **Items expire when they stop being true.** A re-login item disappears the
   moment the connection reconnects, whether or not it was clicked.
5. **One count, visible from anywhere.** The number of open items is the single
   signal for "does Tacet need me right now".

---

## 15. Alerting

**The decision:** alerting attaches to the connection, in the engine — never per
integration. Every connection gets identical coverage on day one, including
channels not yet built. Tenants choose which alert types push to their phone
versus waiting quietly in "Needs you". Ship with sensible defaults so a new
tenant is covered without configuring anything.

**Why this is the highest-leverage single change.** The audit's count:
Meituan 外卖 17 alert calls, 闪购 8, Eleme 7, Guanyi 7, **gzgrocery order reader
0**. And the gzgrocery findings document names "no alerting" as one of two root
causes of a month-long silent failure — a lesson applied to one half of that
channel and not the other, by the same team, months apart. Alerting written per
integration will always end up uneven, because it is written by whoever is
building that integration on the day.

**The alert types, defined once, fired by the engine for every connection:**

| Type | Fires when | Default |
|---|---|---|
| **Connection down** | Session expired or repeated auth failure, **after the grace window** | **Phone** |
| **Connection recovered** | A previously-down connection reconnects | Quiet (log only) |
| **Stock zeroed** | The grace window expired and stock was pushed to zero (§7b) | **Phone** |
| **Cannot zero** | The zero-push itself failed | **Phone** |
| **Sync stalled** | Work has been queued and unprocessed past a threshold, adjusted for the connection's own schedule | **Phone** |
| **Needs you is backing up** | Open items exceed a threshold, or the oldest passes an age | Quiet, then phone |
| **Sweep corrected a lot** | A sweep cycle corrected more than a threshold — usually means something upstream is wrong | Quiet |
| **Order import failed** | An order was read but could not be recorded | **Phone** |
| **Login challenge appeared** | Risk control interposed (Meituan's `verify.meituan.com`, Eleme's equivalents) | **Phone** |

**Mechanics that must carry over from what exists:**

- **Latching, on disk.** `lib/alert-latch.js` already ensures an alert fires once
  per transition rather than every tick, and that a process restart mid-incident
  cannot swallow the recovery message. The engine uses it.
- **Standing conditions need a different rule from transitions.** The Guanyi
  daemon learned this the hard way: a "your login expires Thursday" advisory is
  not a transition, so an in-memory debounce reset on every restart and the same
  message landed in the ops group roughly every twenty minutes until people
  stopped reading the channel. Standing advisories use a durable window, not a
  process-lifetime debounce.
- **Two audiences, deliberately separate.** The tenant's operators get alerts
  through their own channel — `lib/tenant-notify.js` (their WeCom app) and web
  push (`routes/push.js`, VAPID, already wired with subscription pruning). The
  platform ops desk keeps `lib/ops-alert.js`. A tenant should not be paged about
  our infrastructure, and we should not be silent about theirs.
- **`lib/gzgrocery-order-notify.js` is not alerting** and must not be counted as
  such. It is a per-order feed to a WeCom group and it silently does nothing when
  unconfigured. It can stay as a feed; it does not satisfy any row in the table
  above.

---

## 16. Observability and multi-tenancy

### 16a. Observability

**The decision:** every connection has a health view answerable without a
terminal. The audit's test must pass: *"did this sync in the last hour, and did
anything fail?"* answerable from the UI.

**What every connection shows, identically:**

- **Connected?** — connected / connecting / needs re-login / down / paused /
  zeroed, with how long it has been in that state.
- **Last successful run** — of each kind: last order poll, last stock write, last
  sweep. Absolute time and "how long ago".
- **Oldest queued item's age.** This one is not optional. The Meituan admin route
  carries the reason in a comment: without it, a stuck queue and a busy queue are
  the same number on screen — which is how a nineteen-hour stock freeze presented
  as "107 sending…", the display the UI describes as normal and clearing in
  seconds. Eleme and Guanyi still lack it. Every connection gets it.
- **Recent failures**, with the reason in words, and whether each will be retried.
- **What is queued**, by kind.
- **The sweep's recent corrections** (§6) — what was overwritten, from what, to
  what.

**Failure counts are windowed, not all-time.** Meituan's route already scopes its
failure tile to the last day, with the reasoning recorded: the column holds every
terminal failure ever recorded — 1,276 on Tianhe as of 2026-08-22, the oldest 55
days old — and a tile pinned to a permanent four-figure number is a tile nobody
reads. Eleme's and Guanyi's are still all-time. The engine windows all of them.

**Log retention becomes a real setting.** There is currently **no pruning, no
TTL and no vacuum for any `*_sync_log` table anywhere in the codebase**. The
engine's log gets a retention period, a scheduled prune, and a stated default.

### 16b. Multi-tenancy — every literal, and what it becomes

**The decision:** no business literals anywhere in the engine or adapters.

| Literal | Where it lives now | What it becomes |
|---|---|---|
| `readActive('yuexiu')` — hardcoded, **no environment override** | `scripts/shangou-daemon.js:126` | The connection's own location, passed in |
| `SHANGOU_STORES` default `'yuexiu'` | `scripts/shangou-daemon.js:54` | Gone. A connection's location is a field, not a default |
| `MEITUAN_PROXY_CHANNEL` default `'tianhe'` | `scripts/meituan-daemon.js:154` | Per-connection egress setting |
| `LEGACY_STORE_HOURS = { yuexiu: …, tianhe: … }` | `scripts/meituan-daemon.js:121-122`, `scripts/shangou-daemon.js:91` | Gone. Hours come from the location record, already the primary source |
| `MEITUAN_SKIP_STORES` | `scripts/meituan-daemon.js:58-62` | Gone. Two connections cannot collide; the product lease (§5) enforces it structurally rather than by convention |
| `ELEME_SKIP_STORES` | `scripts/eleme-daemon.js` | Gone, same reason |
| `GUANYI_STORE_CODE` default `'tianhe'` | `routes/guanyi-admin.js:18`, `scripts/guanyi-daemon.js:73` | The connection's location |
| `GZGROCERY_STORE_CODE` default `'tianhe'` | `scripts/gzgrocery-order-daemon.js:52` | The connection's location |
| `WHERE channel='gzgrocery' AND store_code='tianhe'` — literal, no override | `scripts/gzgrocery-order-daemon.js:552` | Connection-scoped query |
| **`tianhe_qty` as a column name** | `guanyi_pickup_log` schema (`scripts/guanyi-daemon.js:55`) and every query and log line that reads it | Renamed to a neutral name (`tacet_qty`). A column named after one shop of one tenant cannot survive a second tenant |
| **`GV`/`GVF` brand prefix compiled into the SKU matcher** — `/\bGVF?\s*[·\- ]?\s*(\d+-\d+[A-Za-z]?)\b/i` | `lib/gzgrocery-admin.js:331` | A per-connection **SKU pattern** setting: the tenant states how their SKU appears in that channel's data. Ships pre-filled with Roots' current value |
| `'no Roots products'` note text | `scripts/gzgrocery-order-daemon.js:483` | Neutral wording |
| `non-Roots` in the cycle log | `scripts/gzgrocery-order-daemon.js:605` | Neutral wording |
| `'roots-gzgrocery-sync/1.0'` user agent | `lib/gzgrocery-admin.js:59` | Product-level constant, tenant-neutral |
| `GZGROCERY_ADMIN_URL` | environment | Per-connection setting |
| `SHANGOU_WMPOIID`, `SHANGOU_REGION_ID`, `SHANGOU_REGION_VERSION` | environment | Per-connection settings |
| `GUANYI_WAREHOUSE_ID` | environment | Per-connection setting |
| `GZGROCERY_ACTIVE_STATUSES` / `GZGROCERY_VOID_STATUSES` | environment | Per-connection settings, editable in the admin |
| `MEITUAN_TIANHE_USER/PASS`, `MEITUAN_YUEXIU_USER/PASS` | `lib/tenant-creds.js:101-104` | **Deleted** — nothing reads them (§9) |
| `MEITUAN_<CODE>_USER/PASS` | `scripts/meituan-daemon.js:555-556` | **Deleted** — dead read (§9) |
| `shop 1304930646` | comments in `lib/eleme-browser.js:13`, `scripts/eleme-login.js` | Comment only; no behaviour |

**The structural change behind all of them.** Every daemon today does
`require('../database')` — the shared Roots database. They cannot see a second
tenant's database at all, because `lib/tenant-db.js` gives each non-Roots tenant
its own SQLite file. **The engine must resolve its database handle from the
connection's tenant**, using the existing `getTenantDb` path, on every operation.
This is the single largest non-obvious change in Phase 1 and it touches
everything.

**One table must move.** `gzgrocery_orders`, `gzgrocery_order_log` and
`gzgrocery_meta` are declared **inside the daemon**, not in `database.js`
(`scripts/gzgrocery-order-daemon.js:71-90`). `lib/tenant-db.js` clones a tenant's
schema by reading the main database's `sqlite_master`, so tables declared this
way are invisible to it and would simply not exist for a second tenant. All
engine tables are declared centrally.

---

## 17. Dead code

**The decision:** the unused Eleme OAuth client with routes still mounted is
removed. Confirm nothing depends on it first.

**The dependency check, run against the tree:**

| Thing | Referenced by | Verdict |
|---|---|---|
| `lib/eleme-client.js` | `routes/eleme-admin.js:20` (`const eleme = require('../lib/eleme-client')`) — the only functional require. Two comments in `scripts/eleme-daemon.js:6` and `lib/eleme-browser.js:9` both describing it as dead. One checksum entry in `scripts/diagnose_deployed_tree.js:367` | **Safe to remove** once the two routes below go |
| `GET /api/retail-admin/eleme/oauth/start` (`routes/eleme-admin.js:566`) | Calls `eleme.isConfigured()` and `eleme.authorizeUrl()`. Reachable from the admin | **Remove** |
| `GET /eleme/oauth/callback` (`routes/eleme-admin.js:579`) | **Public route.** Calls `eleme.exchangeCode()` and `eleme.user.getUser()`, writes `eleme_tokens` and `eleme_shops` | **Remove**, with the caveat below |
| `eleme_tokens` table (`database.js:5098-5112`) | Written by the callback. Read by **nothing** — the only other references are two comments and one comment in `routes/integrations-admin.js:34` | **Drop**, after confirming no live rows are needed |
| `ELEME_APP_KEY`, `ELEME_APP_SECRET`, `ELEME_REDIRECT_URI`, `ELEME_SANDBOX` | Only `lib/eleme-client.js` | Remove from the environment |
| `saveToken()` helper (`routes/eleme-admin.js:27`) | Only the callback | Remove with it |

**The one caveat.** The OAuth callback also writes `eleme_shops` — which **is**
live and **is** read by the daemon (`scripts/eleme-daemon.js:164-174` joins on
it to decide which stores to poll). Removing the callback removes one way
`eleme_shops` gets populated. Under the engine, the Eleme shop id becomes a
connection setting entered in the admin, so the path is replaced rather than
lost — but the replacement must exist before the callback is deleted, or a new
Eleme connection has no way to record its shop id.

**Also removed while in there:** the two dead Meituan credential paths (§9), and
the three operator scripts that keep `_nameMatches` alive (§11).

**Not removed in Phase 1:** the ops screen (`ops/ops-screen/`) stays as an
engineer's escape hatch until the phone re-login flow has run in production for
all five connections.

---

## 18. Data model changes

Tables and columns with intent. Not migration SQL.

### New tables

| Table | Purpose | Key columns |
|---|---|---|
| `channel_connection` | The unit of everything (§3) | tenant, platform, platform product, location, label, status (connected/paused/down/zeroed/needs-login), config (per-platform settings: shop id, admin URL, warehouse id, SKU pattern, status vocabularies), created/updated |
| `channel_connection_schedule` | The tenant's clock floor (§7) | connection, day-of-week or "every day", start, end, interval — several rows per connection |
| `channel_connection_settings` | Tenant-tunable behaviour | connection, grace window before zeroing, missing-listing policy (leave-alone / auto-create), alert routing per alert type, log retention |
| `channel_session` | Encrypted sessions (§9) | connection (unique), encrypted session blob, browser-profile directory name, state, last-verified, expires-hint |
| `channel_product_map` | The only matching source (§11) | connection, Tacet product, listing id, option/spec id, listing name (display only), option name (display only), units-per-pack, confirmation state (suggested/confirmed), confirmed-by, confirmed-at. Unique on (connection, Tacet product, option) and on (connection, listing, option) |
| `channel_work` | One queue for every channel (§5) | connection, kind (stock-write / order-poll / catalogue-read / sweep / login), target (product or null), payload, status, attempts, claimed-by, claimed-at, last-error, error-class (retryable / permanent), created, processed |
| `channel_product_lease` | The per-product lock (§5) | tenant, product (together unique), holder, acquired, expires |
| `channel_order_ledger` | One idempotency ledger for all channels (§10) | connection, external order id (unique with connection), Tacet order, status, first-seen, raw payload, detail payload |
| `channel_order_line_issue` | Unmatched lines (§10, §14) | connection, external order id, channel line name, channel line id, quantity, state (open/resolved), resolved-to-product, resolved-at |
| `channel_sweep_correction` | The "why did my change disappear" log (§6) | connection, product, channel quantity found, Tacet quantity, corrected-to, at |
| `channel_event_log` | Replaces the three `*_sync_log` tables | connection, kind, status, detail, error, at — with an index on (connection, at) and a retention policy |
| `channel_attention` | Backing store for "Needs you" (§14) | tenant, connection, kind, collapse key, count, first-seen, last-seen, state, resolution |
| `channel_alert_state` | Latches and standing-advisory windows (§15) | connection, alert type, state, last-fired, window-until |

### Changed existing tables

| Table | Change | Intent |
|---|---|---|
| `retail_orders` | Add a reference to `channel_connection` | Today `channel` is a text field (`'meituan'`, `'eleme'`, `'gzgrocery'`) that cannot distinguish 外卖 from 闪购 or one location from another. Existing `channel` stays for compatibility |
| `retail_order_items` | Add an "unmatched" marker | So an unresolved line is a fact on the order, not only a log string |
| `guanyi_pickup_log` | Rename `tianhe_qty` → `tacet_qty` | §16b. **Only if the table outlives the pickup inference's retirement (§6b)** — if retirement lands first, the table goes read-only and the rename is wasted work. Sequence the two before doing either |
| `retail_stock_ledger` | Ensure the movement reason vocabulary covers sweep corrections, zeroing, and cancellation write-offs | So every automatic stock movement is attributable |

### Tables retired

| Table | Why | When |
|---|---|---|
| `eleme_tokens` | Dead OAuth (§17) | With the client |
| `meituan_sync_queue`, `eleme_sync_queue`, `guanyi_sync_queue` | Replaced by `channel_work` | After the last connection cuts over |
| `meituan_sync_log`, `eleme_sync_log`, `guanyi_sync_log` | Replaced by `channel_event_log` | After cutover; retain read-only for history |
| `meituan_order_import`, `eleme_order_import`, `gzgrocery_orders` | Replaced by `channel_order_ledger` | After cutover. **These must be migrated, not dropped** — they are the idempotency record, and losing them would re-import every order in the window |
| `meituan_product_map`, `eleme_product_map`, `guanyi_product_map` | Replaced by `channel_product_map` | After the mapping migration (§11) completes and is confirmed |
| `meituan_listings`, `eleme_catalogue_cache`, `guanyi_listings` | Replaced by one catalogue cache | After cutover |
| `meituan_listing_jobs`, `guanyi_listing_jobs` | Replaced by `channel_work` rows | After cutover |
| `meituan_order_actions` | The only action is an accept click that is gated off by default and whose DOM-clicking implementation should not be ported (§2) | Phase 1 |

**Not touched in Phase 1:** the Meituan settlement-import tables
(`meituan_stores`, `meituan_orders`, `meituan_settlements`,
`meituan_balance_flow`). They are fed by a separate manual spreadsheet flow and
are unrelated to live sync despite the overlapping names.

---

## 19. Admin screens

Described well enough to brief a designer. Not designed here.

### New

**1. Channels — list.**
Every connection as a card or row: label, platform and platform product,
location, status with a coloured state, last successful sync ("4 min ago"),
oldest queued item's age, count of open "Needs you" items for that connection.
An "Add connection" action. Sorted so anything unhealthy is at the top.

**2. Add connection — wizard.**
Pick platform → pick platform product (only what that platform offers) → pick
location (from the tenant's own locations) → enter platform settings (whatever
`adapter.describe()` says this platform product needs) → connect the session
(§8) → confirm mappings → dry run → go live. Every step can be left and resumed.
The existing wizard shell in `public/retail-admin/15-integrations.js` and the
step model in `lib/integrations/registry.js` are the starting point.

**3. Connection detail — health.**
The §16a list: state, last run of each kind, oldest queued age, recent failures
in plain words with whether each will retry, what is queued, recent sweep
corrections. A "this channel's stock is managed by Tacet; manual edits there will
be reverted" note. Actions: pause, resume, reconnect, run a sweep now, disconnect.

**4. Connection detail — schedule.**
The clock floor: days, time ranges, interval per range. Shows the *effective*
current rate alongside the floor, so a tenant can see the engine has sped up and
why ("orders arriving every ~4 min"). Our ceiling is shown as a fixed limit,
explained, not editable.

**5. Connection detail — settings.**
Grace window before stock is zeroed. Missing-listing policy (auto-create visible
but disabled). Alert routing per alert type — phone or quiet. Per-platform
config: shop id, admin URL, warehouse id, SKU pattern, status vocabularies.

**6. Connection detail — mapping.**
The full product list for this connection: Tacet product, mapped listing, mapped
option, confirmation state. Filters for *needs confirmation*, *renamed*, *not on
this channel*, *unmapped listings on the channel*. Bulk confirm for the
unambiguous cases. On the migration run, the counts from §11 step 3 appear here
as a banner.

**7. Connection detail — activity log.**
`channel_event_log` for this connection, filterable by kind, with the sweep
correction log as its own filter.

**8. Reconnect — phone-first flow.**
Deliberately its own screen, designed for a phone held one-handed. One state at
a time: "connecting…", "enter your password", "enter the code sent to
138****4321", "scan this QR with the Meituan app", "connected". Reachable from a
push notification in one tap.

### Changed

**9. Dashboard — "Needs you".**
Extended with the item types in §14. The existing per-channel stall row is
replaced by the richer connection-down and sync-stalled items. Collapse rules
apply: this section must not get longer as more connections are added, only when
more *distinct* things are wrong.

**10. Orders list and order detail.**
An order shows which connection it came from, by label, not just "meituan". An
order with unmatched lines shows them marked, with a link into the mapping flow.

**11. Product detail.**
A per-channel row: which connections this product is on, mapped to what, current
stock as that channel last accepted it, and "not on this channel" where
unmapped.

### Removed

**12. The Meituan, Eleme and Guanyi tabs** (`public/retail-admin/11-meituan.js`,
`14-eleme.js`, `12-guanyi.js` — 2,141, 1,405 and 533 lines respectively) are
replaced by the Channels screens. They come out one at a time as each connection
cuts over, not all at once.

**13. The Eleme OAuth connect action** goes with §17.

---

## 20. Cutover plan for Roots

Roots/GO VEGAN! is the only live tenant. Five connections. One at a time.

### What must be true before cutover begins

1. **The guard verification check has been run and its result is known.** The
   audit's first open question is whether `GZGROCERY_ORDER_MODE` and
   `GUANYI_PICKUP_MODE` are currently set such that the double-count guard
   holds — the two gzgrocery halves must not both be `live`, or the same sale is
   deducted twice. Read the live `.env` and record both values. **If both are
   `live`, that is a live data-correctness bug that must be fixed before any
   cutover work starts**, because cutover will otherwise inherit and obscure it.
   The same reading answers a second question: if `GZGROCERY_ORDER_MODE` is `off`,
   the OpenCart order reader has never run in production, and connection 5's dry
   run is its first real exercise rather than a comparison against known-good
   behaviour. Record which it is — it changes how much weight the dry run carries.
2. **`MEITUAN_SKIP_STORES` and `SHANGOU_STORES` are confirmed consistent** on the
   live box — `MEITUAN_SKIP_STORES` must contain `yuexiu` and `SHANGOU_STORES`
   must be `yuexiu`. If they disagree, two daemons are racing the same queue rows
   today.
3. **`TENANT_SECRET_KEY` is set on the box**, or session encryption (§9) cannot
   work.
4. **A `busy_timeout` is set on every database connection** (§5).
5. **A full database backup exists and a restore has been tested.**
   `scripts/db-backup.sh` and `scripts/restore-test.sh` exist; run them.
6. **The mapping migration has been run in report-only mode** for all five
   connections, and the counts (auto-confirmed / renamed / needs a decision) are
   known and acceptable.
7. **The engine has run in dry-run against at least one connection** and its
   output has been read by a person.

### The gate every connection passes through

Identical for all five, in this order:

1. **Freeze old.** Stop the old daemon and **verify it stopped**:
   - `pm2 stop <name>` and then `pm2 list` showing it stopped;
   - **and** confirm no new rows in that channel's `*_sync_log` for a period
     longer than its poll interval — a stopped supervisor entry is not proof the
     process is gone;
   - **and** confirm no process holding the session file or profile directory.
   This three-part check is the specified verification. A daemon that pm2 thinks
   is stopped but which is still running would write to the same channel as the
   new connection, which is the one thing that must never happen.
2. **Enable the new connection**, still in dry-run.
3. **Confirm product mapping.** Work the mapping screen until *needs a decision*
   is zero for that connection. Products deliberately not on that channel are
   marked "not on this channel" rather than left unresolved.
4. **Dry run.** The connection reads everything — catalogue, orders, stock — and
   **writes nothing**. It produces a report: which orders it would have imported,
   which lines it could not match, which stock values it would have corrected and
   from what to what. Run it for long enough to cover at least one full trading
   day, including the store's open and close.
5. **Tenant approves.** A person reads the dry-run report and says yes.
6. **Go live.** Writes enabled. Watch the connection's health screen for the
   first hour, then the first day.

### Recommended order — cheapest risk first

**1. Gzgrocery — Guanyi stock (connection 4).**
*Why first:* it is **stock-out only** — it never imports orders, so a mistake
cannot create or corrupt an order. It has exactly one location, one warehouse,
and mappings keyed on an identifier the ERP already gives us. Its failure mode is
"gzgrocery's numbers are wrong for a while", which is visible and reversible. And
it is the connection whose existing code is closest to what the engine wants: it
already reconciles against the channel's live number rather than blind-writing.
*Watch for:* the missing enqueue-time collapse means its queue may hold many
stale rows at freeze time; drain or discard them deliberately rather than letting
the new engine inherit them. Leave the pickup inference exactly as it is through
this cutover (§6b) — only one thing changes at a time.

**2. Eleme (connection 3).**
*Why second:* lowest order volume of the three order-bearing connections, so a
mistake affects fewest real customers. It is also the connection with **no
business literals at all**, so it exercises the engine's multi-tenancy path
cleanly. And it is the one that most needs the engine: no recovery sweep today,
no phone re-login today, all-time failure counts, no oldest-pending age.
*Watch for:* the multi-size guess (`N>=3 ? 9999 : …`) is live today for any
listing with more than one size and no mapped spec. The mapping confirmation step
will expose exactly which products those are. Confirm every one before go-live —
this is a real correctness improvement available at cutover and should not be
deferred.

**3. Meituan 外卖 · Tianhe (connection 1).**
*Why third:* the highest-volume and most-reworked connection, so it goes after
the engine has been proven twice. It also has the richest signals — rider
timestamps, structured order rows — so it is the one where §13's automatic
cancellation decision will work best, and that is worth having early on the
busiest channel.
*Watch for:* the copy-text order parser is the single most fragile thing in the
tree. It is being **ported unchanged** (§2) — the dry run's job is to confirm the
ported parser produces byte-identical line lists to the live one on the same
orders. Compare, do not assume.

**4. Meituan 闪购 · Yuexiu (connection 2).**
*Why fourth:* it shares tables with connection 1 today, so it must go after it —
otherwise the old 闪购 daemon and the new Meituan connection would both be
touching `meituan_sync_queue` and `meituan_order_import`. Once connection 1 is on
the engine, connection 2's freeze also removes the last writer to those tables.
*Watch for:* it attaches to a Chrome that a **separate** pm2 process
(`shangou-chrome`) launches and keeps alive. Freezing the daemon does not stop
that Chrome. The freeze verification must cover both processes, and the engine
must take ownership of the holder Chrome or launch its own — decide which before
this connection, not during it.

**5. Gzgrocery — OpenCart orders (connection 5).**
*Why last:* it is the connection with the least operational evidence behind it
and the most entanglement. It shares the double-count guard with connection 4
(§20 precondition 1); it has zero alerting and zero admin surface today, so there
is no baseline to compare a dry run against; its cold-start baseline
(`gzgrocery_meta.baseline_order_id`) must be carried across exactly or it will
either re-import history or skip a day; and — established while checking the
withdrawn objection — **it may never have run in production at all.** Its mode
defaults to `off`, at which the cycle returns before a client is even
constructed, so unless the live box overrides it, nothing here has been exercised
against the real gzgrocery admin. Going last means the engine is proven four
times over before it meets the least-known path.
*Watch for:* carry `baseline_order_id`, `decremented` and `reversed` for every
existing order into `channel_order_ledger` before enabling. A miss here
double-decrements real stock. Also expect the dry run to be the **first**
real exercise of the OpenCart login and parser for this connection — treat a
clean dry run as new information, not as confirmation of existing behaviour.
Force the pickup inference to `shadow` as part of go-live and **leave it
running** — it is the control against which the order reader's coverage is
measured, and it is retired only after that measurement passes (§6b).

### Rollback, per connection

Rollback is the same shape for all five, and it is fast because the old code is
not deleted until the connection has been stable:

| Step | What happens | How fast |
|---|---|---|
| 1 | Pause the new connection in the admin. It stops claiming work and stops writing immediately | Seconds |
| 2 | Restore the old daemon's environment variables (they are not deleted during cutover, only unset) | Minutes |
| 3 | `pm2 start <old daemon>` | Seconds |
| 4 | Verify the old daemon is writing again — a new row in its `*_sync_log` | One poll interval |

**What state is left behind, per connection, and what to do with it:**

| Connection | Left behind | Handling |
|---|---|---|
| All | Rows in `channel_work` for the paused connection | Left in place, unclaimed. Harmless — nothing drains a paused connection |
| All | Rows in `channel_order_ledger` for orders imported by the engine | **Must be reflected back into the old table** (`meituan_order_import` / `eleme_order_import` / `gzgrocery_orders`) before restarting the old daemon, or it will re-import those orders and double-deduct. This reverse-write is part of the rollback procedure, not an afterthought |
| All | Stock already written to the channel by the engine | Correct as of the moment it was written. The old daemon's next push or drift sweep reconciles it |
| All | Mappings confirmed during cutover | Kept. They are strictly better information than what the old tables hold, and the old tables are unchanged underneath |
| 1, 2 | Session moved into the encrypted store | The old file is **not deleted** during cutover, so the old daemon finds it. Delete only after the connection has been stable for a stated period |
| 5 | `baseline_order_id` | Unchanged — the engine reads it, does not move it |

**The one-way door:** dropping the old tables (§18) and deleting the old session
files. Neither happens during cutover. Both happen only after all five
connections have been live and stable for an agreed period.

---

## 21. Audit findings → where each is resolved

Every finding in `docs/channel-sync-audit.md`. Nothing dropped silently.

| # | Audit finding | Resolved in | How |
|---|---|---|---|
| 1 | No locks anywhere; non-atomic select-then-claim in all three drains | §5 | Single-statement atomic claim; per-product lease |
| 2 | 外卖/闪购 separated only by env-var convention | §3, §5 | Two connections; the product lease makes collision structurally impossible |
| 3 | gzgrocery double-count guard is two env vars and a comment | §5, §6b, §20 | One engine owns both halves; precondition 1 verifies the current state before cutover; the guard becomes enforced at connection 5's go-live and disappears entirely when the pickup inference is retired (§6b) |
| 3b | The Guanyi pickup inference infers sales from stock drift and re-baselines after a session gap — still firing in production | §6b | Not carried into the engine. Held in shadow as the control, then retired after connection 5 on four stated criteria |
| 4 | Recovery sweep on Meituan only; terminal rows unreachable elsewhere | §6 | Every connection gets the generalised sweep |
| 5 | Alerting 17 → 0 across channels | §15 | Alerting is engine-level; identical coverage per connection |
| 6 | gzgrocery order reader: no route, no UI, no alert | §15, §16a, §19 | It becomes a connection like any other |
| 7 | `_nameMatches` still live inbound in both internal routes | §11 | Deleted; replaced by confirmed-mapping-only lookup |
| 8 | `_extractSku` keeps the old rule alive for operator scripts | §11, §17 | Deleted along with the three scripts |
| 9 | 133 of 393 mappings one rename from a sibling | §11 | Verification pass against live catalogues at migration |
| 10 | Premature restock on cancellation | §13 | Point-of-no-return test per adapter; "Needs you" when it cannot be decided |
| 11 | `bornVoid` handling duplicated per channel | §13 | Once, in the engine |
| 12 | Orders with unmatched lines vanish into a log column | §10, §14 | Flagged on the order; collapsed "Needs you" item; retroactive deduction on resolution |
| 13 | No `queueOldestMin` on Eleme or Guanyi | §16a | Mandatory on every connection |
| 14 | All-time failure counts on Eleme and Guanyi | §16a | Windowed for all |
| 15 | No log retention anywhere | §16a, §18 | Retention setting and scheduled prune |
| 16 | No `busy_timeout` pragma anywhere | §5 | Required on every engine connection |
| 17 | Sessions plaintext on disk (3 channels) | §9 | Encrypted at rest via `lib/secret-box.js`, keyed per connection |
| 18 | OpenCart username/password in plaintext env | §9 | Password is not stored at all. The tenant enters it at reconnect; the engine keeps only the resulting `OCSESSID` + `user_token` session, encrypted |
| 19 | `eleme_tokens` plaintext columns, written by a live route, read by nothing | §17 | Dropped with the dead client |
| 20 | Dead `MEITUAN_<CODE>_USER/PASS` read | §9, §17 | Deleted |
| 21 | Unused encrypted `meituan.<code>.*` keys in `tenant-creds` | §9, §17 | Deleted |
| 22 | Eleme has no ops-screen entry; re-login needs a laptop and `scp` | §8 | Phone re-login covers every connection |
| 23 | `readActive('yuexiu')` hardcoded, no override | §16b | Connection's location |
| 24 | `tianhe` literals throughout gzgrocery | §16b | Connection's location |
| 25 | `tianhe_qty` as a column name | §16b, §18 | Renamed `tacet_qty` |
| 26 | `GV`/`GVF` compiled into the SKU matcher | §16b | Per-connection SKU pattern setting |
| 27 | Daemons `require('../database')` — Roots' shared DB only | §16b | Engine resolves the tenant's handle per operation |
| 28 | gzgrocery tables declared inside the daemon, invisible to tenant cloning | §16b, §18 | All engine tables declared centrally |
| 29 | Three `normName` copies | §11 | One lookup; no name normalisation in the matching path |
| 30 | Two different SKU regexes for the same convention | §11, §16b | One configured pattern, suggestion-only |
| 31 | Three queue drains, three `retryOrFail` shapes | §5 | One queue, one retry policy |
| 32 | Two `internalStatusForChannel` copies + gzgrocery's env sets | §13 | Status interpretation moves into the adapter's point-of-no-return answer; the vocabulary stays per-platform because it genuinely is |
| 33 | Three listing-cache tables with three shapes | §18 | One catalogue cache |
| 34 | Two `*_listing_jobs` hand-off tables, none for Eleme | §18 | `channel_work` rows |
| 35 | Two WeCom-webhook readers, only one with the inode fix | §15 | One alerting path |
| 36 | `guanyi-sync` lacks `refreshPending`; no drain-time collapse | §5 | One queue with one collapse rule |
| 37 | Eleme's `extend_code` schema comment contradicts the code | §11 | Comment and column both retired; mapping is by platform identifier |
| 38 | Stale comment at `meituan-daemon.js:906` | §17 | Removed with the file |
| 39 | Meituan's 120-min stall canary vs the shared 3-min threshold | §15, §16a | One stall definition per connection, schedule-aware |
| 40 | gzgrocery reads no store hours | §7 | Every connection has a schedule |
| 41 | `acceptOrder` DOM clicking | §2, §18 | Not ported; `meituan_order_actions` retired |
| 42 | Meituan copy-text order parser is the most fragile thing in the tree | **Deferred** | Ported unchanged in Phase 1 by the no-transport-change rule. The dry run compares old and new output. Replacing it with the structured rows is a separate, evidence-led change — the code's own comment explains that switching would change what gets deducted, because the copy text expands combos and the structured rows do not |
| 43 | Eleme's RPC contract comes from a single capture; five env vars exist because we do not know it | **Deferred** | Ported unchanged. The engine's adapter interface makes the uncertainty visible (the adapter declares which signals it can supply) but does not resolve it |
| 44 | Eleme order discovery by regex over observed method names | **Deferred** | Ported unchanged |
| 45 | Eleme's multi-size guess writes a fabricated number | §11, §20 | Not fixed by porting — fixed by the mapping confirmation step, which forces a spec choice per product before go-live |
| 46 | gzgrocery HTML parsing, English UI labels | **Deferred** | Ported unchanged. Now at least alerted on and visible (§15, §16a), which it is not today |
| 47 | gzgrocery status string sets; unknown status silently waits | §16b, §13 | Configurable per connection; an unrecognised status becomes a "Needs you" item instead of silence |
| 48 | Meituan's `10048` / `套餐` treated as success by message text | **Deferred** | Ported unchanged; it is correct behaviour resting on a fragile signal |
| 49 | Price sync | **Deferred by decision** | Explicitly out of Phase 1 scope. Noted as a later addition; the adapter interface has room for a `writePrices` capability |
| 50 | Listing creation | **Deferred by decision** | §12 — setting built, capability not |
| 51 | No ecosystem file; start commands live only in comments | §3 | Connections are database rows; there are no per-integration processes to start |
| 52 | Git history truncated to 2026-08-27 | Not applicable | An observation about the repository, not the system |

---

## 22. Phase 2 and Phase 3 — noted only

**Phase 2 — the agent.** A tenant-installed program becomes a second transport
behind the same session handle (§2). The adapter interface does not change; the
engine does not change; the admin screens gain an "installed on: our servers /
your machine" fact per connection. Agent updates are silent and staged: our own
tenant first, wider release only after a healthy soak, with a manual override to
push to everyone immediately.

**Phase 3 — agent-only for new tenants.** Server-side browsers remain only for
connections that predate the agent.

**The Phase 1 obligation:** do not let anything above the transport learn that
the browser is local. The one place this is at risk is the re-login flow, which
is why §8 specifies it as a sequence of messages rather than a shared screen.

---

## 23. OPEN — needs Ash

Short list. Each is a plain question with a concrete example.

1. **How long should a connection be down before its stock goes to zero?**
   What is the default grace window? Example: Meituan 外卖 · Tianhe loses its
   session at 11:40 on a Saturday. At what point do we set every product on that
   channel to zero and stop taking orders we cannot fulfil — 15 minutes? An hour?
   *(Tenants can change it per connection; this is the number a new connection
   starts with.)*

2. **When a cancellation cannot be auto-resolved and nobody clears it, what
   happens?** Example: a Meituan order is cancelled after the rider collected it,
   at 20:55. It raises a "Needs you" item. Nobody looks at it for four days. Does
   it stay open forever, auto-expire and leave stock untouched, or escalate to a
   phone alert after some period?

3. **Should the recovery sweep be able to correct a channel while that
   connection is paused?** Example: a tenant pauses Eleme · Tianhe for a week
   while they rework their menu. Meanwhile Eleme's numbers drift. On resume, do we
   correct everything immediately (the shop is suddenly accurate but the tenant
   did not ask), or wait for them to confirm?

4. **How many "needs a decision" mappings is an acceptable number to go live
   with?** Example: the migration reports Meituan 外卖 · Tianhe as 340
   auto-confirmed, 31 renamed, 22 needing a decision. Do we require zero before
   go-live, or is it acceptable to go live with those 22 showing as "not on this
   channel" until someone works the list?

5. **For the two Meituan connections, do we keep 外卖 and 闪购 as separate
   platform products the tenant picks, or is "Meituan" one thing that internally
   knows which product each location is on?** Example: a new tenant with three
   locations, two on 外卖 and one force-migrated to 闪购. Do they create three
   connections and choose the product each time, or one Meituan connection per
   location with us detecting which product applies? *(The spec assumes the
   former, per the locked connection model — confirming because it is the shape
   every tenant sees at connect time.)*

---

## OBJECTIONS

One objection stands. A second was raised in an earlier draft, checked against
the code, and withdrawn — it is kept below rather than deleted, because the
finding that killed it is worth having on the record. Nothing in the spec above
departs from a locked decision.

### Objection 1 — WITHDRAWN. No stored passwords, no exceptions.

An earlier draft of this document objected that the no-stored-passwords rule
would cost gzgrocery an automatic unattended recovery it relies on today. **That
objection rested on an assumption I never verified, and on a conflation of two
different logins. It is withdrawn.** The facts, established by reading the code:

**There are two gzgrocery logins, and the password belongs to only one of them.**

| | **(a) Guanyi ERP** — outbound stock | **(b) OpenCart admin** — inbound orders |
|---|---|---|
| Credential held | **None.** Session only, plaintext at `data/guanyi-sessions/<store>-session.json`. There is no `GUANYI_USER`/`GUANYI_PASS` anywhere in the tree | **Username + password**, `GZGROCERY_ADMIN_USER` / `GZGROCERY_ADMIN_PASS`, plaintext environment variables, read at `lib/gzgrocery-admin.js:33-35` |
| Login sequence | Entirely human. `scripts/guanyi-login.js` opens a headed browser; `interactiveLogin()` (`lib/guanyi-browser.js:234-262`) types nothing and simply polls for up to six minutes until the dashboard appears | Two HTTP requests, `lib/gzgrocery-admin.js:89-110`: GET `common/login`, scrape `name="csrfToken" value="…"`, POST `{username, password, csrfToken}`, succeed if `user_token=` appears in the redirect `Location` |
| Steps the code cannot complete alone | **All of them.** `lib/guanyi-browser.js:8-10`: *"Login is username+password (no QR). The session is created once by the standalone `scripts/guanyi-login.js` (a human types the password — **we never automate credential entry**)"*. `scripts/guanyi-login.js:25` prompts the operator for *"the Guanyi account + password **(and SMS code if asked)**"* — so SMS is anticipated, though the code cannot confirm it because a human handles every step | **None in the code.** Grepping `lib/gzgrocery-admin.js` and `scripts/gzgrocery-order-daemon.js` for SMS / 短信 / 验证码 / captcha / 2FA / OTP returns **nothing**. The code's model of this login is password-only |
| On failure or expiry | `ensureLoggedIn()` (`lib/guanyi-browser.js:196-229`) **never attempts a credential re-login**. It re-reads a newer session file if one appeared on disk, otherwise logs *"session expired or missing — run `scripts/guanyi-login.js` to create one"* and returns false. The daemon then alerts | `_get()` (`lib/gzgrocery-admin.js:114-121`) detects a logged-out reply and calls `login()` once, then retries the request. A thrown login error reaches the daemon's catch at `scripts/gzgrocery-order-daemon.js:599-603` (a log line and a `gzgrocery_order_log` row) or `:628`. **No alert** |
| Evidence it has ever expired and been recovered | **Yes, documented.** `docs/gzgrocery-findings.md`: the ERP session died and stock pushes failed ~78% (9,405 errors) from 2026-06-24 to 2026-07-26, 8,902 of them the single message "not logged in". Recovery was a **manual** re-login at 2026-07-27 04:55. The same document names the root defect: *"No session self-heal: `fetchListings` has no auto-reauth path when the ERP session expires"* | **UNKNOWN — not determinable from code, requires observation** (below) |

**Why the objection collapses.**

1. **The password belongs to (b), not (a).** The login the product owner believes
   requires an SMS code is (a) Guanyi — and (a) holds **no password at all**. A
   stored password buys (a) nothing, because there is nothing in (a) that would
   use one. A human is needed for (a) either way, today and under the engine.
2. **My original argument credited (b) with surviving (a)'s outage.** It does not
   follow. They are separate systems with separate credentials and separate
   transports. (a) failed for a month because it has no self-heal *by design*;
   (b) played no part in that, and its existence prevented nothing.
3. **Nothing establishes that (b)'s unattended re-login works.** Storing a
   password is not evidence, and attempting a re-login is not evidence of one
   succeeding. Specifically:
   - No dated incident note, findings entry or known-issue records an OpenCart
     session expiry. The only date in `lib/gzgrocery-admin.js` (`:199`,
     `2026-06-27`) is a date-format example inside a parser comment.
   - **The code could not produce such evidence even if it worked.** `login()` is
     called silently from inside `_get()`. No console line, no
     `gzgrocery_order_log` action, no counter and no sync-log row records a
     re-login. A successful unattended re-authentication would leave no trace
     anywhere.
   - `GZGROCERY_ORDER_MODE` **defaults to `off`**, and at `off` the cycle returns
     before the client is ever constructed (`scripts/gzgrocery-order-daemon.js:548`).
     If the live box is on the default, **this login has never run in production
     even once.** The audit already lists the live value of that variable as
     unknown from the repository.
   - The re-login is attempted **once** per request. If the second attempt also
     comes back logged out, the parser receives a login page and returns zero
     rows — which is indistinguishable from a quiet day with no orders, and is
     not alerted on.

**What would need to be observed to settle it** (none of it available from the
code): the live `GZGROCERY_ORDER_MODE` value on the box; whether the daemon's
stdout or `gzgrocery_order_log` show any completed cycles at all; and a
deliberate session invalidation — clear the cookie jar, or let `OCSESSID` age out
— with the following cycle watched to see whether it recovers unaided.

**The decision, recorded:** **no stored passwords, no exceptions. Gzgrocery is
treated identically to every other connection.** The carve-out is removed from
§9. The consequences noted in the withdrawn objection — a generous grace window
because a self-healing blip would now page somebody — are also withdrawn, because
the self-healing was never demonstrated.

**One thing this does cost, stated honestly:** if (b)'s unattended re-login *does*
work in production, we are giving up a capability we never measured. That is an
acceptable trade — an unproven capability is not grounds for an exception to a
rule about credential storage — but if the observation above is ever run and
shows it working, it is worth revisiting on evidence rather than on intent.

### Objection 2 — phone re-login cannot cover an image or slider challenge

**The decision (§8, brief item 6):** re-login must be completable by a tenant who
is not at the computer, without a shared screen.

**The problem.** Password entry, SMS codes and QR display all work fine as
messages. **Slider and image challenges do not.** Meituan's login explicitly
includes one — `lib/meituan-browser.js:479` instructs the operator to "log in
(account+password or SMS), **solve any slider**" — and Meituan's risk-control
interstitial at `verify.meituan.com` is a first-class state the daemon already
detects and backs off from.

A slider challenge is a continuous drag gesture measured for human-like motion.
It cannot be reduced to "here is a value, send it back". You can relay the
challenge *image* to a phone and relay a *drag path* back, but the resulting
motion is synthesised, arrives with wrong timing characteristics, and is exactly
the signal the challenge exists to detect. Attempting it may be worse than not
attempting it: a failed automated-looking solve on a risk-control page is a
stronger flag than not reaching the page at all.

**What this means in practice.** The flow in §8 covers the common cases —
expired session, SMS re-verification, QR re-scan — which is most re-logins most
of the time. It does not cover a hard risk-control challenge. For that, the spec
keeps the ops screen (`ops/ops-screen/`) as an escape hatch and the connection
enters a state that says, honestly, *"this one needs a computer"*.

I do not think that undermines the decision — it satisfies its intent for the
large majority of cases — but the spec should not claim 100% phone coverage when
the platform can present something a phone cannot solve. It is written above as
a fifth challenge type with a pointer here, rather than silently omitted.
