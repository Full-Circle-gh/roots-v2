# meituan_sync_queue — why 1,683 rows are parked on yuexiu

**2026-08-27 · Read-only survey. Nothing was changed, created or deleted except this document. No fix
was opened. Every box figure is a `mode=ro` query against `/root/roots-v2/data/roots.db`; every code
claim is cited to `file:line` at `origin/main` `d1bfce9b`.**

---

## 0 — The brief's premise does not survive the data

This survey was commissioned to establish *"why stock changes are being enqueued for a store that has
no Meituan configuration"*, on the stated basis that **yuexiu is not on Meituan yet, pending
hardware**, and that the defect is therefore on the producing side.

**Three parts of that are wrong, and the third changes what the real finding is.**

1. **Yuexiu IS configured for Meituan.** It holds **187 `meituan_product_map` rows with
   `sync_enabled = 1`** (measured). It also has a full `store_business_status` row — hours
   `11:00-20:15`, a Meituan POI status, and a recorded open/close command history.

2. **The queue is not without a consumer.** The 外卖 daemon's store list is tianhe-only because
   `.env` on the box sets **`MEITUAN_SKIP_STORES=yuexiu`**, and the reason is stated where it is read
   — `scripts/meituan-daemon.js:58-61`: *"Stores handled by a DIFFERENT channel daemon (e.g. yuexiu
   on 闪购/shangou-sync). Listed here so THIS 外卖 daemon never polls their (logged-out) e.waimai
   session or races the other daemon on their meituan_sync_queue rows."* The box also sets
   **`SHANGOU_STORES=yuexiu`**. Yuexiu's consumer is `scripts/shangou-daemon.js:298-309`, which reads
   the same table. **That daemon is stopped** (`shangou-sync`, `status=stopped`).

3. **These rows are not stock changes at all.** 187 distinct products, **exactly 9 copies each**,
   arriving in six bursts each an exact multiple of 187. That is the signature of nine
   full-catalogue pushes, not of edge-triggered stock movement.

| burst (UTC, to the minute) | rows | = 187 × |
|---|---:|---:|
| 2026-08-24 04:54 | 187 | 1 |
| 2026-08-24 05:16 | 187 | 1 |
| 2026-08-24 06:48 | 187 | 1 |
| 2026-08-25 03:34 | 187 | 1 |
| 2026-08-25 03:39 | 561 | 3 |
| 2026-08-25 03:57 | 374 | 2 |
| **total** | **1,683** | **9** |

**All 1,683 rows carry `attempts = 0` and `last_error = NULL`** — never attempted, not failing, not
stranded by a retry cap. Nothing has tried to push them.

**The real finding, stated once:** the producer-side gate exists and works everywhere except one
route. `routes/meituan-admin.js:563` **POST `/api/retail-admin/meituan/push-all`** selects every
mapped product with no store filter and no trading check, so it enqueues for a store that is shut.
The stock-change path — the one the brief suspected — is correctly gated and demonstrably was not
the producer here.

**Two dates prove that.** `storePushEnabled` was added to the stock-change path in `1f454617`
(2026-08-24 01:43), **three hours before the first burst**; if these rows had come through
`enqueueProductStock` the gate would already have refused them. And the last burst
(2026-08-25 03:57) lands in the same minute as the owner's close command —
`store_business_status.target_at = 2026-08-25 03:57:58`, `target_by = owner`, `target_open = 0` —
after which nothing more was enqueued at all.

**Yuexiu's current state is `停业中` — suspended, `is_open = 0`, `target_open = 0`**, with
`detail_desc` reading *"本店停业中，不会自动恢复营业"*. Its last successful push was
**2026-08-22 05:57:35**.

---

## 1 — THE PRODUCER

Five call sites insert into `meituan_sync_queue`. Four gate on the store; one does not.

| # | Site | Trigger | Store gate? |
|---|---|---|---|
| 1 | `lib/meituan-bundles.js:153` `enqueueProductStock` | any `physical_qty` change, via `lib/inventory.js:53` `enqueueChannelSync` | **YES — three of them** |
| 2 | `lib/meituan-bundles.js:101` `enqueueBundle` | a component's stock moved | **PARTIAL** |
| 3 | `lib/meituan-drift-sweep.js:214-222` | the daemons' periodic backstop | **YES — by construction** |
| 4 | `lib/store-close.js:77` `refillQueueForCell` | a location REOPENING on a channel | **YES — one store by argument** |
| 5 | `routes/meituan-admin.js:563` POST `/push-all` | an operator clicking "Sync now" | **NO** |

**1 — `enqueueProductStock`** (`lib/meituan-bundles.js:153-174`). Gated three ways, all inside one
`if`: a `meituan_product_map` row for this (store, product) with `sync_enabled = 1`; `storeTrading`
(`:74`, reads `retail_stores.is_active`); and `storePushEnabled` (`:140`, reads
`store_business_status.target_open` then `is_open`). Both helpers **fail open** — an unknown store or
an unreadable row returns `true` (`:78`, `:144`) — deliberately, so a missing row never silently
drops a real update.

**2 — `enqueueBundle`** (`:101-113`). Checks `hasComponents` and `storeTrading` (`:104`) but **not
`storePushEnabled`**. A bundle can therefore be enqueued for a store whose POI is shut, where a plain
product cannot. Reached from `enqueueBundlesForProduct` (`:116`), which `enqueueProductStock` calls
**unconditionally at `:171`** — outside the gated `if`. So a stock change at a closed store still
enqueues that product's bundles. Not the source of the 1,683 rows (they all carry a `product_id`,
none a `bundle_id`), but it is a second, narrower instance of the same gap.

**3 — the drift sweep** (`lib/meituan-drift-sweep.js:214-222`). Scoped by contract: `:188-190` states
*"storeCodes MUST be only the stores this daemon owns — the two channel daemons share
meituan_sync_queue, and enqueuing for a store the sibling handles would have it push through a
session that can't reach that store's backend."* Capped at `MAX_ROWS = 40` per sweep (`:42`). Its
rows are self-identifying: `last_error = 'drift sweep — last push never landed'`. **None of the 1,683
carry it**, which rules the sweep out as their producer.

**4 — `refillQueueForCell`** (`lib/store-close.js:77-91`). Fires on **reopen**, for one `storeCode`,
and covers `'meituan'` and `'shangou'` (`:78`). It queues *a fresh full push of current stock* rather
than replaying what the close dropped. This matters for §6.

**5 — `push-all`** (`routes/meituan-admin.js:563-599`). The one that does not gate:

```js
const mapped = db.prepare(`
  SELECT m.product_id, m.retail_store_id, m.store_code
    FROM meituan_product_map m
   WHERE m.sync_enabled = 1
`).all()
```
`routes/meituan-admin.js:569-573` — **no store predicate, no `storeTrading`, no `storePushEnabled`.**
It enqueues for every mapped store, open or shut. The file has a per-store helper of its own,
`csStorePushEnabled` (`:346`), and this handler does not call it.

It does now collapse repeats through `refreshPending` (`:589`), added in **`d504d44b`
(2026-08-25 12:30)** — *"Repeated Sync-now clicks stacked full duplicate sweeps on the queue"* —
whose own comment records the identical failure at another store: *"One store's backlog hit a 4x
multiplier this way — 877 pending for 208 products that actually needed a push."* **That fix landed
roughly 8½ hours after the final burst**, which is why nine copies survive here and why the stacking
cannot recur. **The missing store gate was not part of that fix and is still absent.**

---

## 2 — WHAT "CONFIGURED FOR MEITUAN" MEANS IN THE SCHEMA

**The authoritative test is per-PRODUCT, not per-store: a row in `meituan_product_map` for
(`retail_store_id`, `product_id`) with `sync_enabled = 1`.** That is the predicate every gated
producer uses (`lib/meituan-bundles.js:155-157`, `lib/store-close.js:80-83`,
`routes/meituan-admin.js:571-573`).

**There is no per-store "this store is on Meituan" flag, and nothing else is one.** Stated plainly
because the three candidates each mean something else:

- **`store_business_status.target_open` / `is_open`** — whether the POI is trading right now. A
  closed store is still a configured store. This is what `storePushEnabled` reads.
- **`.env MEITUAN_SKIP_STORES` / `SHANGOU_STORES`** — which *daemon* owns a store. Deployment
  configuration, invisible to every producer (all five run inside the web process, which never reads
  those variables).
- **`storefront_config` `meituan.enabled`** — tenant-wide, all-or-nothing, and absent means ON
  (`scripts/shangou-daemon.js:270-273`). Not per store.

The practical consequence: a producer that wants to ask *"can this store receive a push at all"* has
to compose `meituan_product_map` + `store_business_status` itself. Four of the five do. The fifth
does not, and there is no single flag it could have checked instead.

---

## 3 — THE DAEMON'S STORE LIST

**Source: the environment.** `const SKIP_STORES = (process.env.MEITUAN_SKIP_STORES || '').split(',')`
— `scripts/meituan-daemon.js:62-63`. On the box, `MEITUAN_SKIP_STORES=yuexiu`. Applied at four
points: `:558` (store configs), `:762` (order polling), `:1202` (jobs), `:1502` (the drift sweep's
`storeCodes`). Not hardcoded, not in the database.

**What would have to change for yuexiu to be picked up by this daemon — and why it must not be.**
Removing `yuexiu` from `MEITUAN_SKIP_STORES` would do it, and it is the wrong move. The daemon's own
comment (`:58-61`) says the variable exists so this daemon *"never polls their (logged-out) e.waimai
session or races the other daemon on their meituan_sync_queue rows."* Both daemons drain the same
table with the same `store_code IN (…)` shape (`scripts/meituan-daemon.js:841-847` vs
`scripts/shangou-daemon.js:298-309`), so two consumers on one store is a race, not redundancy.
**The correct consumer already exists and is simply stopped.**

**Would starting the right consumer alone drain it? No.** `shangou-daemon.js:281` computes
`pushableStores().filter(storePushEnabled)`, and `storePushEnabled('yuexiu')` returns `false` on
`target_open = 0` (`:257-267`). So even with `shangou-sync` running, yuexiu is excluded. **Reopening
the store is the actual gate**, not restarting the daemon — which is the correct behaviour: pushing
stock to a suspended POI accomplishes nothing.

---

## 4 — THE OTHER CHANNELS

**No, neither has this asymmetry today.** Measured on the box:

| queue | pending | error | done | oldest pending | newest done |
|---|---:|---:|---:|---|---|
| `meituan_sync_queue` (yuexiu) | **1,683** | — | — | 2026-08-24 04:54 | 2026-08-22 05:57 |
| `eleme_sync_queue` | 2 | 36 | 1,121 | 2026-08-20 02:42 | 2026-08-26 11:56 |
| `guanyi_sync_queue` | **0** | **0** | 4,871 | — | 2026-08-26 11:56 |

**Eleme** (`lib/eleme-sync.js:42-59`) gates on the tenant-wide `elemeEnabled` (`:16`) and on an
`eleme_product_map` row with `sync_enabled = 1` (`:45-48`), and collapses repeats via `refreshPending`
(`:30`). **It has no per-store open/closed check** — the same shape of gap as `push-all`, but it has
not bitten, because Eleme is single-store today. Its 2 stragglers (oldest 2026-08-20) and 36 errors
are a separate question this survey does not open.

**Guanyi** (`lib/guanyi-sync.js:17-33`) gates on a `guanyi_product_map` row with `sync_enabled = 1`
only. It has **no `refreshPending` at all** — every stock change appends a row. That is survivable
solely because its consumer keeps up: zero pending, zero error, 4,871 done. If that daemon ever
stopped, this queue would grow without the collapsing the other two have.

Both are declared alongside Meituan in one place — `lib/channel-sync-stale.js:48-51` — which is also
the only file that knows there are three of them.

---

## 5 — GROWTH AND BOUNDS

**Pruning: none. TTL: none.** A repo-wide grep for `DELETE FROM meituan_sync_queue`,
`eleme_sync_queue` or `guanyi_sync_queue` returns **nothing**. Rows are only ever `UPDATE`d to
`done`/`error`. `meituan_sync_queue` holds 17,230 `done` and 1,418 `error` rows going back to
2026-06-22; `guanyi_sync_queue` holds 4,871 back to 2026-06-24. These tables only grow.

**Retry cap: yes, and it creates a silent terminal state.** Both consumers select
`WHERE status = 'pending' AND attempts < 3` (`scripts/meituan-daemon.js:845`,
`scripts/shangou-daemon.js:306`). A row that fails three times stays `pending` forever and is
invisible to every consumer — **there is no dead-letter status**, so it is indistinguishable by
`status` from a row that is genuinely waiting. `scripts/diagnose_stock_queue.js:88-89` models exactly
this split, calling the two halves *drainable* and *stranded*. **The 1,683 rows here are drainable,
not stranded** (`attempts = 0`).

**Alarm: yes for staleness, no for depth.** `lib/channel-sync-stale.js` measures the oldest
unresolved row against `STALE_THRESHOLD_MS = 3 * MINUTE_MS` (`:28`), counting only time the channel
could have used — open hours, per `hoursAware` (`:48-51`). Meituan additionally runs a two-hour
canary of its own, `lib/meituan-queue-stall.js`, deliberately not shared (`channel-sync-stale.js:9-17`).
Nothing anywhere alarms on **queue depth**; `routes/meituan-admin.js:476-490` reports pending count,
failed count and oldest-pending age to a dashboard, but reporting is not alarming.

**Would a genuine stall be distinguishable from this situation today? Yes — and that is the problem.**
`channel-sync-stale.js` restricts itself to trading stores: it lists `retail_stores WHERE is_active = 1`
and filters through `isStoreTradingOnChannel` (`lib/store-trading.js:60-84`), which for Meituan and
闪购 returns `false` when `target_open = 0` (`:66-72`). **Yuexiu is excluded from the alarm entirely.**
So a stall at an open store fires in three minutes, while 1,683 rows parked behind a closed store are
silent by design — correct, in that a shut store's queue is parked rather than stalled, and costly, in
that nothing surfaced this backlog for three days. **The gap is not detection of stalls; it is that
there is no measure of a queue that is growing while nobody is allowed to drain it.**

---

## 6 — WHAT BREAKS WHEN YUEXIU COMES ONLINE

**`new_qty` is an ABSOLUTE target, not a delta.** Stated outright for Guanyi —
`lib/guanyi-sync.js:11-14`, *"new_qty is the ABSOLUTE target (the store's current physical_qty) — NOT
a delta; the daemon computes the delta against Guanyi's current stock so it never double-applies if
several queue rows pile up"* — and true for Meituan by construction: every producer resolves the
value through `bundleStock.sellableAt(...)` (`lib/meituan-bundles.js:163`, `lib/store-close.js:88`,
`routes/meituan-admin.js:574`), which reads current stock.

**So the backlog would not compound.** Nine copies of one product are nine writes of the same kind of
value, not nine subtractions. The daemon drains `ORDER BY created_at` (`shangou-daemon.js:307`), so
the last copy applied per product is the newest, and its `refreshPending`/supersede logic
(`shangou-daemon.js:330`) retires the rest.

**But every value in it is stale.** These are absolute counts as they stood on 2026-08-24 and
2026-08-25. Pushing them publishes **two-day-old stock to a live listing** and holds it there until
something corrects it. The correction exists — the drift sweep re-reads live stock against what the
channel last accepted and re-enqueues the gap (`lib/meituan-drift-sweep.js`) — but it runs on the
daemon's cadence, so there is a window in which the shop is selling against a stale number. Given the
store has been shut since 2026-08-25 and its stock has had two days of other movement, the staleness
is not hypothetical.

**And the backlog is redundant on the correct path.** Reopening a location already calls
`refillQueueForCell` (`lib/store-close.js:77-91`), which queues a **fresh full push of current stock**
for exactly the `sync_enabled = 1` mappings — the same 187 products, with today's numbers. So a
correct reopen enqueues everything the backlog would have said, correctly.

**Conclusion for the decision this question exists to settle: the 1,683 rows should be retired before
yuexiu is reopened.** They can only publish stale numbers that the reopen refill would then have to
correct, and retiring them costs nothing that the refill does not already provide. *(This survey does
not do it — no fix was opened.)*

---

## 7 — RECOMMENDATION

**The gate belongs in both places, and they answer different questions.**

**At enqueue — the one change that is actually missing.** `routes/meituan-admin.js:569-573` should
filter the mapped set the way `enqueueProductStock` already does: `storeTrading` **and**
`storePushEnabled`. It is the only producer of the five without a store gate, and it is the producer
that made this backlog. `lib/meituan-bundles.js:101` `enqueueBundle` should gain `storePushEnabled`
for the same reason — a narrower instance of the identical gap. Enqueue-time gating is what keeps a
queue from accumulating work nobody is permitted to do.

**At dequeue — already present, and must stay.** Both consumers filter through `storePushEnabled`
(`meituan-daemon` via its eligible list, `shangou-daemon.js:281`). This cannot be replaced by the
enqueue gate, because **a store can close after a row is queued** — which is precisely what happened
here at 03:57:58 on 2026-08-25. No enqueue-time check can anticipate a state change that has not
occurred yet.

**Why neither alone is sufficient, stated as the argument rather than the conclusion:** enqueue-only
leaves rows queued before a close to be pushed to a shut POI. Dequeue-only leaves the queue growing
without bound behind a closed store, invisible to the staleness alarm (which excludes closed stores by
design, §5) and with no pruning to reclaim it (§5). The two failures are different and each gate
closes one.

**A third item, separate from the gate and not a substitute for it:** these queues have no retention
policy at all. A `done` row from June is still on disk, and a `pending` row for a store that never
reopens is immortal. Whether that becomes a TTL, a dead-letter status for `attempts >= 3`, or a
depth alarm is a decision this survey does not make — but the absence of all three is why a
three-day-old backlog of 1,683 rows was found by reading a dashboard rather than by being told.

---

## UNVERIFIED

- **Who clicked "Sync now" nine times, and why.** The bursts are unmistakable in shape but the route
  writes no actor to the queue. `activity_log` was not read for this survey.
- **Why the four bursts of 2026-08-24 were not drained by `shangou-sync` while it was still
  running.** The daemon stopped roughly 2026-08-25 11:00 UTC, several hours after the last burst, so
  it was alive for all of them. Its logs before the stop were not read.
- **Whether yuexiu's suspension is temporary or permanent.** `detail_desc` says the store will not
  resume automatically; nothing in the schema records an intent or a date.
- **Eleme's 2 stragglers (oldest 2026-08-20) and 36 errors.** Out of scope here; noted because they
  are the only other non-empty pending set.
- **Whether `MEITUAN_SKIP_STORES` and `SHANGOU_STORES` are also set in any tenant environment other
  than the box's `.env`.** Only the production `.env` was read.
