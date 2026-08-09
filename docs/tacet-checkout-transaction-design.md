# The checkout transaction — conversion design, v2.0

**2026-08-09 · DESIGN ONLY. Nothing here is built. No code changes accompany this file.**
Path A step 3, the last and hardest item. `routes/retail.js` stands at **30** transaction blocks by AST (`scripts/diagnose_async_conversion_scope.js`). The checkout is one of them, and it is the one that blocks `ensureShipments` and the retirement of `.immediate()`.

**The decision this designs to, given and not re-litigated:** when two customers race for the last unit, one wins and the other is told it is out of stock. Checkouts stay concurrent; they do not queue. The out-of-stock answer arrives **before** payment is taken. The stock check and the stock decrement happen inside the same locked step.

**v2.0 supersedes v1.0, which was written against a helper that has since changed.** v1.0's headline finding — that `lib/db-transaction.js` folded concurrent requests into one transaction — was acted on: it is fixed and deployed at `dc91e62f`. This revision corrects every claim that depended on the old helper rather than annotating them, and answers the question v1.0 left open. What changed and why is listed at the end, under CHANGED FROM v1.0.

---

## THE PREREQUISITE THAT BLOCKED THIS IS DONE

v1.0 opened by saying the checkout could not be converted until the helper was repaired, because `withTransaction` set nesting depth on **per-handle state before awaiting the body**, so a request arriving mid-flight misread itself as nested and was folded into the in-flight transaction — two independent requests, one `BEGIN`, and either the second's write destroyed or its rolled-back write committed by the first's `COMMIT`.

**That is fixed and deployed.** Nesting is now decided by the **async context**: an `AsyncLocalStorage` store holds `Map(handle → depth)` for the duration of a body, so "nested" means *this call was made from within another transaction's body*, and a caller who merely shares the handle cannot read it. Per-handle depth is gone entirely. `scripts/test_db_transaction_nesting.js` was written red first — 4 passed, 10 failed against the unfixed helper — and now passes 14/14, including on the box against the real better-sqlite3 binding. No existing batch changed behaviour.

**One consequence matters for everything below: the mechanism the checkout needs is now sound, and what remains is a throughput question, not a correctness one.** The two are easy to conflate and v1.0 conflated them.

---

## PART 1 — THE SIX ANSWERS

### 1. What does `.immediate()` actually protect?

`tx.immediate()` maps to `BEGIN IMMEDIATE`, which takes SQLite's write lock at `BEGIN` instead of at the first write.

**The interleaving the code's own comment names** is `nextOrderNo()`. It runs `SELECT MAX(CAST(SUBSTR(order_no, 3) AS INTEGER))` over `retail_orders`, adds one, and the handler then `INSERT`s that value into `order_no`, which is `TEXT UNIQUE NOT NULL` (`database.js:1184`). Under a deferred `BEGIN` the `SELECT` runs holding only a read lock, so two writers can both read `MAX = 41`, both mint `TC000042`, and the second to reach the `INSERT` fails the UNIQUE constraint — surfacing as `order_create_failed`, a 500, on a checkout that was perfectly valid.

**The interleaving the comment does not name is the more serious one.** `inventory.reserveForOrder` reads availability and then writes a hold:

```
getAvailable(store, product)          →  SELECT physical_qty, safety_buffer, … FROM retail_store_stock
                                         SELECT SUM(qty) FROM retail_stock_reservations WHERE status='active'   (×2, global + channel)
if (av.available < it.qty) throw insufficient_stock
insRes.run(...)                       →  INSERT INTO retail_stock_reservations … 'active'
```

Availability is **derived**, not stored: `physical_qty − safety_buffer − SUM(active reservations)`. There is no row to lock and no counter to decrement conditionally. **The entire correctness of "one wins, one is told out of stock" rests on no other writer changing `retail_store_stock.physical_qty` or inserting into `retail_stock_reservations` between that `SELECT` and that `INSERT`.** `BEGIN IMMEDIATE` is what guarantees it.

**Who the other writer is.** Not another checkout — a single shared better-sqlite3 handle in a single-threaded process cannot interleave a synchronous transaction with itself. It is the **other PM2 processes**, which open the same SQLite file directly: `meituan-sync`, `guanyi-sync`, `gzgrocery-orders`, `qingyun-sync`, plus the reservation sweeper. `lib/guanyi-sync.js`, `lib/eleme-sync.js` and `lib/meituan-drift-sweep.js` all touch `retail_store_stock` / `retail_stock_reservations`. The database is in WAL (`database.js:9`), so those readers never block the checkout — their **writes** are what `BEGIN IMMEDIATE` excludes.

**`busy_timeout` is 5000 ms, and v1.0 was wrong to flag it as unset.** It is not set by application code — only `journal_mode = WAL` and `foreign_keys = ON` are — but better-sqlite3's constructor applies its own default, and the running database reports it: `PRAGMA busy_timeout` returns **5000** on the box. So a daemon write colliding with the checkout's `BEGIN IMMEDIATE` **waits up to five seconds and then throws `SQLITE_BUSY`**, rather than failing instantly. Today's behaviour is therefore *correct and quiet*, not *correct and occasionally noisy*. The lesson for this document is narrower than the finding: a grep over application code is not a reading of runtime configuration, and v1.0 should not have published the weaker claim as an open question when one command would have settled it.

### 2. The full shape of the checkout transaction

`POST /api/retail/orders`. The transaction is the `tdb().transaction(() => { … })` whose result is invoked as `tx.immediate()`.

**Return value:** `orderId` — the `lastInsertRowid` of the `retail_orders` insert.

**What the response does with it:** everything after the transaction. A best-effort batch-notice `UPDATE` and customer notification; a best-effort `reroute_short_pids` `UPDATE`; `supersedeUnpaidOrdersForCustomer(...)` — explicitly run post-commit *because the release/reverse helpers open their own transactions*; then `loadOrderForCustomer(orderId, …)` and `res.json({ success: true, data: order })`.

**Writes, in order:**

1. `INSERT INTO retail_orders` (39 columns), status `pending_payment`
2. Voucher: conditional `UPDATE retail_vouchers SET used_count = used_count + 1 WHERE … (max_uses IS NULL OR used_count < max_uses)`, then `UPDATE retail_customer_vouchers` to spend a non-standing grant
3. `INSERT INTO retail_order_items`, one per resolved line
4. `ensureShipments(orderId)` — unless pickup
5. Flash: conditional `UPDATE store_products SET flash_sold = … WHERE … flash_sold + ? <= flash_stock_limit`, per flash line
6. `inventory.reserveForOrder({ … })` — unless wait-flow, and only when `stockGate`
7. `INSERT INTO retail_payments (… status 'pending' …)`
8. Points: conditional `UPDATE retail_customers SET points_balance = points_balance - ? WHERE … >= ?`, then `INSERT INTO retail_points_transactions`
9. Balance: conditional `UPDATE retail_customers SET balance = ROUND(… - ?, 2) WHERE ROUND(… - ?, 2) >= 0`, then `INSERT INTO retail_topup_transactions`

**The six typed errors.** Each is thrown inside the body, carries `e.code`, and is matched in the `catch` around `tx.immediate()`:

| `e.code` | Thrown by | Trigger | 409 body |
|---|---|---|---|
| `insufficient_stock` | `reserveForOrder` | `av.available < it.qty` | `{success:false, error, product_id, available}` |
| `product_not_stocked_here` | `reserveForOrder` | no `retail_store_stock` row at the routed store | `{success:false, error, product_id, available: 0}` |
| `flash_stock_exceeded` | checkout body | capped `flash_sold` bump changed 0 rows | `{success:false, error, product_id}` |
| `insufficient_points` | checkout body | floor-checked points `UPDATE` changed 0 rows | `{success:false, error}` |
| `insufficient_balance` | checkout body | floor-checked balance `UPDATE` changed 0 rows | `{success:false, error}` |
| `voucher_exhausted` | checkout body | conditional `used_count` bump changed 0 rows | `{success:false, error}` |

The first two share one `if` and therefore one response shape; `available` defaults to `0` via `e.available ?? 0`.

There is a **seventh** exit that is not a typed error: the idempotency backstop matches `/UNIQUE constraint failed:.*idempotency_key/i` **on the error message**, looks up the winner's order, and replays it as `{success:true, data, idempotent_replay:true}`. Anything below reaches `console.error` and a 500 `order_create_failed`.

**Helpers called from inside**, and which carry their own transaction:

| Helper | Own transaction? |
|---|---|
| `nextOrderNo()` | No — two `SELECT`s |
| `voucherGrantIsStanding(v)` | No — pure, no database access |
| `expandStockLines(resolved)` | No — no database access |
| `ensureShipments(orderId)` | **Yes** — `tdb().transaction(…)` |
| `inventory.reserveForOrder({…})` | **Yes** — `tdb().transaction(…)` |

`markOrderPaid` appears in the body only inside a comment. **`mergeAddonItemsIntoShipments` is NOT called from the checkout at all** — see answer 3.

### 3. The nested helpers: real savepoint, or silent join?

**A real savepoint.** From `node_modules/better-sqlite3/lib/methods/transaction.js`:

```js
if (db.inTransaction) { before = savepoint; after = release; undo = rollbackTo; }
else                  { before = begin;     after = commit;  undo = rollback;  }
```

So `ensureShipments` and `reserveForOrder`, called inside the checkout's open transaction, each issue `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`. Not a no-op join, and not a nested `BEGIN`.

Two details the conversion must preserve:

- **better-sqlite3's savepoint name is a fixed constant**, `` `\t_bs3.\t` ``, reused at every depth. With one level of nesting that is harmless. `withTransaction` does better — `tacet_sp_${depth}`, with the depth now read from the async context rather than from handle state.
- **`.immediate()` does not propagate.** The `immediate` variant only swaps the `begin` statement, which is never executed on the nested path. So `reserveForOrder` inherits the write lock from the outer `BEGIN IMMEDIATE` and has none of its own. **A converted checkout that loses `BEGIN IMMEDIATE` silently removes a lock `reserveForOrder` has been relying on, and which nothing in `reserveForOrder` documents or requires.** It is also called *outside* any transaction by the add-on path, where it opens its own deferred `BEGIN` and has never had the lock at all — a pre-existing hole, narrower than checkout but the same shape.

**`mergeAddonItemsIntoShipments` is a third helper of this kind, and v1.0 misplaced it.** It is not blocked behind the checkout: **the checkout never calls it.** Its only call site is inside `finalizeOrderAddon`'s transaction, and it opens its own `tdb().transaction(…)` there, so it is a savepoint under a **money-cluster** transaction, not under the checkout. Structurally it is `ensureShipments`' twin — it prepares its statements on the outer handle, then opens a transaction and uses them inside — and it needs the identical step-2 treatment. **But it unblocks with `finalizeOrderAddon`, not with the checkout, and that is a separate pass.** Converting the checkout does nothing for it.

### 4. Where stock is read, where it is written, how far apart

**Inside the transaction — the authoritative gate.** In `reserveForOrder`'s per-item loop, the read is `getAvailable(...)` (three `SELECT`s) and the write is the `INSERT` into `retail_stock_reservations`. Between them: a `!av.exists` test and an `av.available < it.qty` test, and nothing else. **Zero intervening statements.** Under `BEGIN IMMEDIATE` that pair is atomic against other processes, which is what the decision requires.

The write is an **INSERT of a hold**, not a decrement. `physical_qty` is untouched at checkout; it is decremented later by `commitOrderReservations`, called from `markOrderPaid`.

**Outside the transaction — the read that is not a gate.** `inventory.routeOrder({ … })` is `await`ed well before the transaction opens and reads stock to choose a store; further bare `getAvailable(...)` calls sit in the fallback/reroute paths. **These are separated from the reservation by a genuine async gap** — `routeOrder` awaits `rankStoresByProximity`, which makes AMap distance calls.

This is the "a check that happens before the lock is a race" case, and the current code is already right about it: **routing is advisory, `reserveForOrder` is authoritative.** If stock disappears during the AMap round trip, the reservation throws `insufficient_stock`. The design keeps that split and must not be tempted to trust the routing read.

### 5. Is payment taken inside the transaction?

**No. It is taken in a different HTTP request, after this one has committed and responded.**

The checkout transaction writes `INSERT INTO retail_payments (…) VALUES (…, 'pending', …)` — an intent row. No gateway is called. Money moves later, in `POST /api/retail/payment/create`, which calls the gateway and then `markOrderPaid(orderId)`; `markOrderPaid` flips the status and calls `inventory.commitOrderReservations(orderId)`, where `physical_qty` actually decrements.

**So the decision's hardest clause — "the out-of-stock answer must arrive BEFORE payment is taken" — is already satisfied structurally, and the conversion's job is to not break it.** A rollback cannot strand a payment, because no payment exists yet.

The corollary matters: **the checkout transaction has no external side effect that a rollback cannot undo.** No gateway call, no notification, no push. Every best-effort side effect is deliberately placed after the commit. That is what makes this transaction convertible at all, and it is a property to assert, not assume.

### 6. Does the serialiser defeat the decision?

**Three findings. One is now fixed, one stands, and the third is the live question answered in Part 2.**

**(a) On SQLite the queue is inert, and concurrent checkouts already do not overlap.** With one shared handle, a synchronous better-sqlite3 body and a single-threaded runtime, a checkout runs from `BEGIN` to `COMMIT` without yielding; a second request cannot begin until the first has responded. **Checkouts are already effectively one-at-a-time and always have been.** The decision "checkouts stay concurrent" is **not achievable on SQLite** — not before the conversion, not after it. It becomes achievable only on Postgres.

*This conclusion is unchanged from v1.0, but the reason underneath it is sounder now.* In v1.0 it was true partly by luck: had a body yielded, the broken helper would have merged the two rather than queueing them. Now, if a body yields, the queue does what it says.

**(b) FIXED. With an async body the helper used to merge the second transaction into the first rather than queue it.** That was data corruption on the money cluster, not a throughput characteristic. Repaired and deployed at `dc91e62f`; measured green on better-sqlite3 on the box.

**(c) STANDS, and is the live question. The queue is keyed on the handle object.** Measured against the *deployed* helper with a pg-pool-shaped handle (`query()`, one object shared by all callers): three transactions ran **strictly sequentially**. They were correctly outermost — two BEGINs, zero SAVEPOINTs, so the corruption is genuinely gone — but they still took turns. **Under a pool that is a whole-application throughput ceiling, and it is what would defeat the decision after the flip.** Part 2 answers it.

---

## PART 2 — THE QUEUE UNDER POSTGRES

### What the queue is protecting today

A SQLite transaction belongs to a **connection**, and the application shares exactly one. Two overlapping outermost transactions on that one connection cannot both be honoured: the second `BEGIN` is an error, and worse, one block's `ROLLBACK` discards the other's committed-but-uncommitted work. The queue makes them take turns. **On SQLite it is load-bearing and must not be touched.**

### What changes under Postgres

A pool gives each transaction **its own connection**. Two transactions on two different clients cannot interfere at the protocol level — no shared `BEGIN`, no shared rollback scope. **Between transactions, the queue stops being the thing that protects correctness.** The connection does.

So the honest answer to "is it still load-bearing after the flip" is: **not for the reason it exists today, but do not remove it.** Its role changes rather than disappearing, and it changes into something cheap.

### The answer: scope the queue to the checked-out connection — which needs no change to `acquire()`

`stateFor(db)` already keys the queue on the handle **object**. Hand `withTransaction` a checked-out client rather than the pool, and each transaction gets its own state entry and therefore its own queue, trivially empty. Measured against the deployed helper: three transactions, each given its own client-shaped handle, **ran concurrently with no cross-transaction queueing** — `c1:in → c2:in → c3:in → c1:out → c2:out → c3:out`.

**The work is therefore not in `acquire()`. It is in making sure the CLIENT, not the pool, is what reaches `stateFor()`.** Concretely, the pg adapter must check out the client **before** the state lookup and the `BEGIN`, and pass that same client as both the state key and the `tx` argument. A design that checks the client out *inside* `runOutermost`, after `stateFor(pool)` has already run, keeps the pool-wide queue and gains nothing.

**Two things must come with it, and neither is optional:**

- **A nested `withTransaction` must reuse the outer transaction's client, never check out a second one.** Under load, a nested checkout against an exhausted pool deadlocks: the outer holds a client and waits for one that only the outer could release. The async context introduced by the nesting fix is the natural place to carry the client, and it already carries the handle — so this falls out of the existing mechanism rather than needing a new one.
- **The client must be released on both paths**, commit and rollback, including when the rollback itself fails. A leaked client under an error path is a pool that degrades to zero over hours and looks like a slow memory leak.

### Why it stays even though it stops being load-bearing

Per connection, a queue is a **cheap guard against a checkout bug**. If anything ever routes two concurrent transactions onto the same client — a caching mistake, a helper that reuses a client it should not, a nested call that resolves to the wrong context — Postgres answers a second `BEGIN` with a warning and silently folds the work into the first, which is precisely the failure the nesting fix just removed. The queue turns that into correct sequencing instead. It costs one already-resolved promise per transaction when uncontended.

**It also stays because removing it is unfalsifiable today.** Nothing in the repository runs against Postgres yet.

**What must be true before it could be removed — all three proven by test, not by reading:**

1. Every `withTransaction` call under pg receives a checked-out client and never the pool. A single call site passing the pool re-creates the application-wide queue silently.
2. The client is exclusive for the transaction's lifetime and released on every exit path.
3. Nested calls resolve to the **same** client through the async context, and a test demonstrates that a nested transaction does not consume a second pool slot.

Until all three hold, the queue is the thing standing between a checkout bug and the corruption that was just fixed. **Keep it. Do not remove it as part of the flip.**

---

## PART 3 — THE PROPOSED DESIGN

### Sequencing

Two of v1.0's three prerequisites are done:

1. ~~Repair `lib/db-transaction.js`~~ — **done**, deployed at `dc91e62f`.
2. ~~Add the failing test first~~ — **done**: `scripts/test_db_transaction_nesting.js`, written red (4/14), now 14/14 including on better-sqlite3.
3. **Convert `reserveForOrder` and `ensureShipments` to take the handle** — the §24 step-2 rule, so they can participate in a caller's transaction on either engine. They are dual-context today (`reserveForOrder` runs bare from the add-on path) and must keep working both ways. **Still outstanding, and still the next thing.**

Only then the checkout. `mergeAddonItemsIntoShipments` gets the same treatment on its own pass, with `finalizeOrderAddon`.

### What replaces `.immediate()`

**On SQLite: `BEGIN IMMEDIATE`, kept, not dropped.** `withTransaction` needs a mode argument — `withTransaction(db, fn, { mode: 'immediate' })` — that issues `BEGIN IMMEDIATE` instead of `BEGIN` on a SQLite handle. It is the only thing that preserves the cross-process guarantee traced in answer 1, and answer 3 is the reason it cannot simply be dropped: `reserveForOrder` depends on that lock without saying so.

**On Postgres: not the isolation level — an explicit row lock.** `BEGIN IMMEDIATE` has no pg equivalent and `SERIALIZABLE` is the wrong reach: it converts the race into a serialisation failure that must be caught and retried, and a retry loop around a checkout is a new source of double-writes. Instead, lock the thing actually contended:

```sql
SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota
  FROM retail_store_stock
 WHERE store_id = $1 AND product_id = $2
   FOR UPDATE
```

`FOR UPDATE` inside `reserveForOrder`'s read, **ordered deterministically by `product_id`** across the loop so two multi-line checkouts cannot deadlock against each other. Concurrent checkouts for *different* products proceed in parallel — the decision, honoured for the first time. Concurrent checkouts for the *same* product block briefly on the row, and then one reads the other's committed reservation and throws `insufficient_stock`. **One wins, the other is told, and neither queues behind unrelated traffic.**

`nextOrderNo` should not be carried onto pg as read-MAX-then-insert under a lock. It wants a sequence. That is a schema change belonging to the migration, but the conversion must not pretend the read-MAX form is safe on pg because a row lock happens to be held elsewhere in the transaction.

### How the stock lock is taken

One rule, both engines: **`reserveForOrder` takes the lock, because `reserveForOrder` is where the read and the write are adjacent.** Not the checkout. The checkout asks for a mode; the helper does the locking. That keeps the guarantee attached to the code that needs it and closes the bare add-on call site, which today has no lock at all.

### What happens to the nested helpers

They stop being nested transactions and become **plain functions that take the handle**:

```js
reserveForOrder({ db: tx, storeId, orderId, items, … })
ensureShipments(tx, orderId)
```

No inner `BEGIN`, no savepoint. Their atomicity comes from the caller's transaction, which is what already happens — a savepoint inside a transaction that will roll back wholesale on any throw does no work the outer rollback would not do.

Both are dual-context, so both keep working when called with no open transaction: the bare caller passes `tdb()` and wraps in `withTransaction` itself.

The savepoint path in `withTransaction` stays — it is correct, and now correctly scoped — but the checkout will not use it.

### How the six typed errors survive

**Unchanged**, provided one property holds: `withTransaction` rethrows the **original error object**, with `e.code`, `e.product_id` and `e.available` intact. It does, deliberately, and the reason in its header is exactly this case. Batch 4 proved the property on the qingyun `row_moved` path; the nesting fix did not touch it.

The `catch` block moves from around `tx.immediate()` to around `await withTransaction(...)` and its contents do not change. What must be **asserted** is that each of the six still produces its exact 409 body after conversion — six assertions, red-proven individually.

### The seventh exit is required pre-cutover work

**The idempotency backstop matches the driver's error MESSAGE with a regex, and its failure mode is a customer charged twice.** better-sqlite3 says `UNIQUE constraint failed: retail_orders.idempotency_key`; pg says `duplicate key value violates unique constraint "..."` and carries `err.code === '23505'`. **The regex silently stops matching at the flip.** It does not error — it falls through to `console.error` and a 500 `order_create_failed`, so the losing submit of a double-click gets an error instead of the winner's order, and a client that retries on 500 can produce a second real order.

**Marked as REQUIRED PRE-CUTOVER WORK, not as part of the checkout conversion.** It should move to an engine-neutral code check before the flip, and it needs a test that fails on the wrong engine rather than passing on both. It is small, it is independent of everything else here, and it is the item most likely to be forgotten because nothing fails until money moves.

### What the conversion must assert

Beyond the six errors and the written-column assertion, which is non-optional:

- **No `await` reaches the transaction body other than the helper's own** — the post-commit placement of `supersedeUnpaidOrdersForCustomer` and the batch notice must be pinned, because moving either inside would put a helper that opens its own transaction inside the outer one.
- **The routing read is advisory** — a test where stock disappears between routing and reservation must produce `insufficient_stock`, not a successful oversold order.
- **Rollback leaves nothing**: order, items, shipments, reservations, voucher bump, points debit and wallet debit all absent after a mid-body throw.
- **No payment row survives a rollback**, and no gateway call exists inside the body.

---

## PART 4 — WHAT REMAINS UNCERTAIN

Three of v1.0's six are resolved. Three stand, and one is new.

**RESOLVED**

- ~~`busy_timeout` may be unset~~ — **it is 5000 ms**, from better-sqlite3's constructor default, confirmed by `PRAGMA busy_timeout` on the live database. Application code sets only `journal_mode` and `foreign_keys`, which is why a grep missed it.
- ~~Whether the depth repair could be made without changing behaviour for the already-converted call sites~~ — **it could, and did.** All four conversion suites and the helper suite report identical counts before and after: 11 / 32 / 13 / 32 / 28.
- ~~`mergeAddonItemsIntoShipments` unread~~ — **read.** It is inside `finalizeOrderAddon`'s transaction, not the checkout's, and unblocks with the money cluster on its own pass. This corrected a v1.0 claim rather than confirming one.

**STILL OPEN**

1. **Whether `FOR UPDATE` on the stock row is a sufficient lock.** Availability reads two tables. Locking `retail_store_stock` serialises writers who go through this path, but an `INSERT` into `retail_stock_reservations` from a path that does *not* first lock the stock row would slip past. Every current caller does go through `reserveForOrder`, so the invariant holds **by convention**. Making it hold by construction — a constraint, or routing every reservation write through one function — is worth deciding before the flip, and I still do not have a recommendation I trust.
2. **`nextOrderNo` on Postgres.** It wants a sequence, but `order_no` is `TEXT UNIQUE` with a `TC%06d` shape and existing values. Not costed.
3. **Load.** No measurement of how often two checkouts genuinely contend for the same product at the same store. The design is correct either way, but if the answer is "twice a month", the parallelism the pg version buys is worth knowing about before the effort is spent. This is the cheapest of the three to settle and nobody has settled it.

**NEW**

4. **Two claims in `lib/db-transaction.js`'s own header are now stale, and this document cannot fix them.** Line 10 still says *"THIS FILE IS UNUSED TODAY, BY DESIGN. Nothing requires it. No transaction has been converted"* — there are **26** live call sites in `routes/retail.js`. Line 264 still says the per-handle queue is *"a no-op cost under pg, where each transaction gets its own client and there is nothing to contend for"* — true only if the **client** is what is passed, and measurably false if the pool is. Both should be corrected in a small, separate pass; they are exactly the kind of confidently-worded stale comment that a future reader trusts over the code.

---

## CHANGED FROM v1.0

Claim by claim, so the reasoning can be reviewed and not just the conclusions.

| v1.0 claim | Status in v2.0 | Why |
|---|---|---|
| The helper folds concurrent requests into one transaction; this is the headline and everything is secondary to it | **Corrected — fixed and deployed** | Repaired at `dc91e62f`; nesting decided by async context. The section is now a resolved prerequisite, not a blocker. |
| The helper must be repaired before the checkout is converted | **Still true, now satisfied** | Prerequisites 1 and 2 are done; prerequisite 3 (handle-taking helpers) is now the next thing. |
| "If the depth bug were fixed naively it would serialise everything on the pool handle" | **Corrected — wrong as stated** | The fix was not naive: nesting moved to the async context, so pool-sharing callers are correctly **outermost** (measured: 2 BEGINs, 0 SAVEPOINTs). What survives is narrower — the **queue**, not the nesting, still applies to a shared handle. |
| The helper's header claim about pg is "wrong in both directions" | **Corrected — half of it was** | The "does not serialise when it should" half is fixed. The "would serialise everything on the pool" half stands, conditionally: only if the pool is what is passed. |
| Q6(a): checkouts already run one at a time on SQLite | **Unchanged conclusion, sounder reason** | v1.0 was right by luck — a yielding body would have been *merged*, not queued. Now the queue genuinely does it. Worth stating because the old reasoning would not survive review. |
| Q6(b): with an async body the serialiser does not queue, it merges | **Corrected — past tense** | Fixed and measured green on better-sqlite3 on the box. |
| Q6(c): a corrected depth check would serialise the whole pool | **Restated and re-measured** | Re-run against the deployed helper: still serialises on a *shared* handle, runs concurrently on *per-client* handles. This is now Part 2's question, with an answer. |
| `mergeAddonItemsIntoShipments` is blocked behind the checkout | **Corrected** | The checkout never calls it. It is inside `finalizeOrderAddon`'s transaction and unblocks with the money cluster. |
| `busy_timeout` is not set anywhere; `BEGIN IMMEDIATE` may be throwing `SQLITE_BUSY` immediately | **Corrected — resolved** | 5000 ms at runtime. Contention waits, it does not fail fast. |
| `.immediate()` protects a cross-process read-then-write race on derived availability and on `nextOrderNo` | **Unchanged** | Nothing about the helper fix touches this. |
| The nested helpers are real savepoints; `.immediate()` does not propagate | **Unchanged** | This is better-sqlite3's behaviour, not ours. |
| Payment is taken in a later request; a rollback cannot strand it | **Unchanged** | Verified again; no gateway call inside the body. |
| The six typed errors survive because the original error object is rethrown | **Unchanged** | The nesting fix did not touch the error path; batch 4's proof still stands. |
| The idempotency regex breaks at the flip | **Unchanged, now marked REQUIRED pre-cutover work** | Elevated from an aside to a named deliverable with its own failure mode written out. |
| `FOR UPDATE` on the stock row, in `product_id` order, inside `reserveForOrder` | **Unchanged** | Still the proposal; sufficiency still open (uncertainty 1). |

---

## RELATED

- `docs/tacet-consolidation-decisions.md` §24 — Path A, the conversion batches, the helper repair (v4.16), and the standing requirements this design inherits
- `lib/db-transaction.js` — the helper; two header claims it carries are stale, see uncertainty 4
- `scripts/test_db_transaction_nesting.js` — the request-shaped suite that proved the nesting defect and now guards it
- `scripts/diagnose_async_conversion_scope.js` — the count authority; 30 at the time of writing
