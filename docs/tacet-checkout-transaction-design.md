# The checkout transaction — conversion design, v1.0

**2026-08-09 · DESIGN ONLY. Nothing here is built. No code changes accompany this file.**
Path A step 3, the last and hardest item. `routes/retail.js` stands at **30** transaction blocks by AST (`scripts/diagnose_async_conversion_scope.js`). The checkout is one of them, and it is the one that blocks `ensureShipments`, `mergeAddonItemsIntoShipments`, and the retirement of `.immediate()`.

**The decision this designs to, given and not re-litigated:** when two customers race for the last unit, one wins and the other is told it is out of stock. Checkouts stay concurrent; they do not queue. The out-of-stock answer arrives **before** payment is taken. The stock check and the stock decrement happen inside the same locked step.

---

## READ THIS FIRST — THE HELPER IS BROKEN FOR THE CASE THE CHECKOUT IS

Everything else in this document is secondary to one measured fact.

**`lib/db-transaction.js` does not serialise concurrent transactions. When a transaction body yields, it silently merges the next arrival into the in-flight one.** Two independent requests produce **one** `BEGIN`, and the second is given a `SAVEPOINT` inside the first.

This was measured, not reasoned about. Two request-shaped macrotasks, each calling `withTransaction` on the same handle, with a body that awaits:

```
trace:                          SQL actually issued:
   A sees depth=0                  BEGIN
   A body in                       SAVEPOINT tacet_sp_1
   B sees depth=1                  COMMIT
   B body in                       RELEASE SAVEPOINT tacet_sp_1
   A body out
   B body out                   BEGIN count: 1
```

Note the order: **`COMMIT` fires while B's body is still running**, and B's `RELEASE` executes against a database with no open transaction.

Run against a real SQLite handle, that produces two data-corrupting outcomes:

| | Scenario | Result |
|---|---|---|
| **1** | B succeeds, A rolls back | **B's write is destroyed**, and B is handed `no such savepoint: tacet_sp_1` instead of success |
| **2** | A succeeds, B fails | **B's rolled-back write is committed by A's COMMIT** |

In checkout terms: **case 1 is customer B's paid-for order vanishing because unrelated customer A's checkout failed. Case 2 is a checkout that returned `409 insufficient_stock` leaving its order and its stock reservation committed anyway — an oversell produced by the very code path that exists to prevent one.**

### Why it has not bitten yet

`withTransaction` sets `st.depth = 1` *before* awaiting the body, and `depth` is keyed per handle. Any outermost call arriving while another body is suspended reads `depth > 0` and takes `runNested`. The `acquire()` queue is therefore only reachable when `depth === 0` — which, once a body has started, it never is.

**Every converted body in batches 1–4 is fully synchronous.** With no `await` inside, the whole transaction completes inside one microtask drain and no second request can arrive mid-flight. Batch 2's suite asserts this (`assert.ok(!/\bawait\b/.test(body))`), and batch 4 asserts it again for the qingyun bodies. **That test assertion, not the helper, is what is holding this back.**

The existing concurrency test passes because it calls `withTransaction` twice in the *same synchronous block*, where `depth` is still 0 for both. Real HTTP requests do not arrive that way. **The suite is testing a shape that does not occur and missing the one that does.**

### Why this decides the whole design

- The checkout body **cannot stay synchronous under Postgres.** Every statement becomes a round trip. The moment the flip happens, every converted route is in the measured failure mode above, simultaneously.
- So the helper must be repaired **before** the checkout is converted, and the repair must land **on its own**, proven, exactly as the helper itself did — this is the same "do not let a flaw propagate to 56 call sites" argument that justified building `withTransaction` unused in the first place.
- The header comment in `lib/db-transaction.js` claiming per-handle serialisation is "a no-op cost under pg, where each transaction gets its own client and there is nothing to contend for" is **wrong in both directions**: it does not serialise when it should, and if the depth bug were fixed naively it would serialise *everything on the pool handle*, because `stateFor(db)` keys on the handle the caller passes — which under pg is the pool. Measured: three transactions on one shared handle ran strictly one after another.

**I am not proposing the repair here.** It is a separate piece of work with its own proof, and it should be reviewed on its own terms. This document assumes it lands first and says what the checkout needs from it.

---

## PART 1 — THE SIX ANSWERS

### 1. What does `.immediate()` actually protect?

`tx.immediate()` maps to `BEGIN IMMEDIATE`, which takes SQLite's write lock at `BEGIN` instead of at the first write.

**The interleaving the code's own comment names** is `nextOrderNo()`. It runs `SELECT MAX(CAST(SUBSTR(order_no, 3) AS INTEGER))` over `retail_orders`, adds one, and the handler then `INSERT`s that value into `order_no`, which is `TEXT UNIQUE NOT NULL` (`database.js:1184`). Under a deferred `BEGIN` the `SELECT` runs holding only a read lock, so two writers can both read `MAX = 41`, both mint `TC000042`, and the second to reach the `INSERT` fails the UNIQUE constraint — surfacing as `order_create_failed`, a 500, on a checkout that was perfectly valid.

**The interleaving the comment does not name is the more serious one, and it is the reason this route is the last item on Path A.** `inventory.reserveForOrder` reads availability and then writes a hold:

```
getAvailable(store, product)          →  SELECT physical_qty, safety_buffer, … FROM retail_store_stock
                                         SELECT SUM(qty) FROM retail_stock_reservations WHERE status='active'   (×2, global + channel)
if (av.available < it.qty) throw insufficient_stock
insRes.run(...)                       →  INSERT INTO retail_stock_reservations … 'active'
```

Availability is **derived**, not stored: `physical_qty − safety_buffer − SUM(active reservations)`. There is no row to lock and no counter to decrement conditionally. **The entire correctness of "one wins, one is told out of stock" rests on no other writer changing `retail_store_stock.physical_qty` or inserting into `retail_stock_reservations` between that `SELECT` and that `INSERT`.** `BEGIN IMMEDIATE` is what guarantees it.

**Who the other writer is.** Not another checkout — a single shared better-sqlite3 handle in a single-threaded process cannot interleave a synchronous transaction with itself. It is the **other PM2 processes**, which open the same SQLite file directly: `meituan-sync`, `guanyi-sync`, `gzgrocery-orders`, `qingyun-sync`, plus the reservation sweeper. `lib/guanyi-sync.js`, `lib/eleme-sync.js` and `lib/meituan-drift-sweep.js` all touch `retail_store_stock` / `retail_stock_reservations`. The database is in WAL (`database.js:9`), so those readers never block the checkout — but their **writes** are exactly the ones `BEGIN IMMEDIATE` is excluding.

So the honest statement of what `.immediate()` protects is: **a cross-process read-then-write race on derived stock availability, and a cross-process read-then-insert race on the order number.** It is not protecting checkouts from each other; the runtime already does that, by accident.

> **Not verified:** I found no `busy_timeout` pragma anywhere in the codebase — only `journal_mode = WAL`. If `busy_timeout` is at SQLite's default of 0, a daemon write colliding with the checkout's `BEGIN IMMEDIATE` throws `SQLITE_BUSY` immediately rather than waiting. That would show up as sporadic `order_create_failed` 500s under concurrent load, not as an oversell. Worth confirming on the box before the conversion, because the answer changes whether the current behaviour is "correct but occasionally noisy" or "correct and quiet".

### 2. The full shape of the checkout transaction

`POST /api/retail/orders` (`routes/retail.js`, handler begins at the `router.post('/api/retail/orders'` registration). The transaction is the `tdb().transaction(() => { … })` whose result is invoked as `tx.immediate()`.

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

The first two share one `if` and therefore one response shape; `available` defaults to `0` via `e.available ?? 0`, which is what makes `product_not_stocked_here` report zero rather than `undefined`.

There is a **seventh** exit that is not a typed error and must not be forgotten: the idempotency backstop matches `/UNIQUE constraint failed:.*idempotency_key/i` **on the error message**, looks up the winner's order, and replays it as `{success:true, data, idempotent_replay:true}`. It depends on the driver's message text. Anything below reaches `console.error` and a 500 `order_create_failed`.

**Helpers called from inside**, and which carry their own transaction:

| Helper | Own transaction? |
|---|---|
| `nextOrderNo()` | No — two `SELECT`s |
| `voucherGrantIsStanding(v)` | No — pure, no database access |
| `expandStockLines(resolved)` | No — no database access |
| `ensureShipments(orderId)` | **Yes** — `tdb().transaction(…)` |
| `inventory.reserveForOrder({…})` | **Yes** — `tdb().transaction(…)` |

`markOrderPaid` appears in the body only inside a comment.

### 3. The nested helpers: real savepoint, or silent join?

**A real savepoint.** From `node_modules/better-sqlite3/lib/methods/transaction.js`:

```js
if (db.inTransaction) { before = savepoint; after = release; undo = rollbackTo; }
else                  { before = begin;     after = commit;  undo = rollback;  }
```

So `ensureShipments` and `reserveForOrder`, called inside the checkout's open transaction, each issue `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` rather than `BEGIN` / `COMMIT` / `ROLLBACK`. Not a no-op join, and not a nested `BEGIN` (which SQLite would reject).

Two details the conversion must preserve:

- **The savepoint name is a fixed constant**, `` `\t_bs3.\t` ``, reused at every depth. With one level of nesting that is harmless. `withTransaction` already does better — `tacet_sp_${depth}` — so this is a small improvement, not a regression, as long as depth is tracked correctly (see the section above, where it currently is not).
- **`.immediate()` does not propagate.** The `immediate` variant only swaps the `begin` statement, which is never executed on the nested path. So today `reserveForOrder` inherits the write lock from the outer `BEGIN IMMEDIATE` and has none of its own. **A converted checkout that loses `BEGIN IMMEDIATE` silently removes the lock `reserveForOrder` has been relying on without ever mentioning it** — and `reserveForOrder` is also called *outside* any transaction by the add-on path, where it opens its own deferred `BEGIN` and has never had the lock at all. That second case is a pre-existing hole, narrower than checkout but the same shape.

### 4. Where stock is read, where it is written, how far apart

**Inside the transaction — the authoritative gate.** In `reserveForOrder`'s per-item loop, the read is `getAvailable(...)` (three `SELECT`s: the stock row, the global reservation sum, the channel reservation sum) and the write is the `INSERT` into `retail_stock_reservations`. Between them: a `!av.exists` test and an `av.available < it.qty` test, and nothing else. **Zero intervening statements. They are adjacent.** Under `BEGIN IMMEDIATE` that pair is atomic against other processes, which is exactly what the decision requires.

Note the write is an **INSERT of a hold**, not a decrement. `physical_qty` is not touched at checkout at all; it is decremented later by `commitOrderReservations`, called from `markOrderPaid`.

**Outside the transaction — the read that is *not* a gate, and must not be mistaken for one.** `inventory.routeOrder({ … items: expandStockLines(mutatedItems) … })` is `await`ed well before the transaction opens, and reads stock to choose a store. There are further bare `inventory.getAvailable(...)` calls in the fallback/reroute paths, also pre-transaction. **These are separated from the reservation by a genuine async gap** — `routeOrder` awaits `rankStoresByProximity`, which makes AMap distance calls.

This is the "a check that happens before the lock is a race" case, and the current code is already right about it: **routing is advisory, `reserveForOrder` is authoritative.** If stock disappears during the AMap round trip, the reservation throws `insufficient_stock` and the customer is told. The design must keep that split and must not be tempted to "optimise" by trusting the routing read.

### 5. Is payment taken inside the transaction?

**No. It is taken in a different HTTP request, after this one has committed and responded.**

The checkout transaction writes `INSERT INTO retail_payments (order_id, method, amount, status, out_trade_no) VALUES (…, 'pending', …)` — an intent row. No gateway is called. The order is left at `pending_payment`.

Money moves later, in `POST /api/retail/payment/create`, which calls the gateway and then `markOrderPaid(orderId)`; `markOrderPaid` flips the status and calls `inventory.commitOrderReservations(orderId)`, which is where `physical_qty` actually decrements.

**So the decision's hardest clause — "the out-of-stock answer must arrive BEFORE payment is taken" — is already satisfied structurally, and the conversion's job is to not break it.** A rollback of the checkout transaction cannot strand a payment, because no payment exists yet; it discards the order, the items, the shipments, the reservations, the voucher bump, the points debit and the wallet debit together, and the customer receives a 409 with nothing charged.

The corollary matters for the design: **the checkout transaction has no external side effect that a rollback cannot undo.** No gateway call, no notification, no push. Every best-effort side effect — the batch notice, the supersede sweep — is deliberately placed after the commit. That is what makes this transaction convertible at all, and it is a property to assert, not assume.

### 6. Does the serialiser defeat the decision?

**Direct answer: no, because it does not currently serialise anything — and that is worse than if it did.**

Three separate findings, in order of how much they matter:

**(a) Today the serialiser is inert, and concurrent checkouts already do not overlap.** With one shared handle, a synchronous better-sqlite3 body, and a single-threaded runtime, a checkout runs from `BEGIN` to `COMMIT` without yielding. A second request cannot begin until the first has responded. **Checkouts are already effectively one-at-a-time, and have always been.** The decision "checkouts stay concurrent, they do not queue" is therefore **not achievable on SQLite at all** — not before the conversion, not after it. It becomes achievable only on Postgres, where transactions live on separate connections.

**(b) With an async body — the checkout after conversion, and every route after the pg flip — the serialiser does not queue the second transaction. It merges it into the first**, per the measurements at the top of this document. That is not a throughput characteristic, it is data corruption, and it lands on the money cluster.

**(c) If (b) is fixed the obvious way, the queue then becomes real and application-wide.** `stateFor(db)` keys on the handle the caller passes. Under pg that is the pool, so a corrected depth check would put *every* transaction in the application behind one `tail` promise — measured: three concurrent transactions on one shared handle ran strictly sequentially. **That** is the version of the serialiser that would defeat the decision, and it is the trap to avoid when repairing it: the fix must key state on the **checked-out connection**, not on the pool, so that per-connection nesting is still detected while independent transactions run in parallel.

The serialiser's premise — "a SQLite transaction belongs to a CONNECTION, and the application shares one handle" — is sound for SQLite and obsolete for pg. It should be scoped explicitly to the single-handle backend rather than carried across the flip as if it were engine-neutral.

---

## PART 2 — THE PROPOSED DESIGN

### Sequencing (this is the design's main claim)

The checkout is not the next thing to convert. **Three pieces land first, each on its own branch, each proven independently:**

1. **Repair `lib/db-transaction.js`.** Depth must not be readable as "nested" by an unrelated concurrent caller, and state must be keyed on the connection that will actually run the statements. Without this, converting the checkout converts it straight into the two corruption cases above.
2. **Add the failing test first.** The current concurrency test passes because both calls happen in one synchronous block. Add the request-shaped version — two macrotasks, async bodies — and watch it fail against today's helper. It is the regression-executed pattern the split fix used, and this defect deserves it more.
3. **Convert `reserveForOrder` and `ensureShipments` to take the handle**, the §24 step-2 rule, so they can participate in a caller's transaction on either engine. They are dual-context today (`reserveForOrder` runs bare from the add-on path) and must keep working both ways.

Only then the checkout.

### What replaces `.immediate()`

**On SQLite: `BEGIN IMMEDIATE`, kept, not dropped.** `withTransaction` needs a mode argument — `withTransaction(db, fn, { mode: 'immediate' })` — that issues `BEGIN IMMEDIATE` instead of `BEGIN` on a SQLite handle. This is a small, honest addition and it is the only thing that preserves the cross-process guarantee traced in answer 1. The helper's header currently lists `.immediate()` as explicitly out of scope; that line stops being true and should be replaced rather than left standing.

**On Postgres: not the isolation level — an explicit row lock.** `BEGIN IMMEDIATE` has no pg equivalent and `SERIALIZABLE` is the wrong reach for it: it converts the race into a serialisation failure that must be caught and retried, and a retry loop around a checkout is a new source of double-writes. Instead, take the lock on the thing actually being contended:

```sql
SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota
  FROM retail_store_stock
 WHERE store_id = $1 AND product_id = $2
   FOR UPDATE
```

`FOR UPDATE` inside `reserveForOrder`'s read, ordered deterministically by `product_id` across the loop so two multi-line checkouts cannot deadlock against each other. Concurrent checkouts for *different* products proceed in parallel — which is the decision, honoured for the first time. Concurrent checkouts for the *same* product block briefly on the row and then one of them reads the other's committed reservation and throws `insufficient_stock`. **One wins, the other is told, and neither queues behind unrelated traffic.**

`nextOrderNo` should not be carried onto pg as read-MAX-then-insert under a lock. It wants a sequence. That is a schema change and belongs to the migration, not to this conversion — but the conversion must not pretend the read-MAX form is safe on pg just because a row lock happens to be held elsewhere in the transaction.

> **Not sure:** whether `FOR UPDATE` on `retail_store_stock` is sufficient on its own, or whether the reservation sum needs its own guard. Availability reads two tables; locking the stock row serialises writers who go through this path, but an `INSERT` into `retail_stock_reservations` by a path that does *not* first lock the stock row would slip past. Every current caller of `getAvailable`-then-write does go through `reserveForOrder`, so the invariant holds today by convention. Making it hold by construction — a constraint, or routing every reservation write through one function — is worth deciding before the flip, and I do not have a recommendation I trust yet.

### How the stock lock is taken

One rule, both engines: **`reserveForOrder` takes the lock, because `reserveForOrder` is where the read and the write are adjacent.** Not the checkout. The checkout asks for a mode; the helper does the locking. That keeps the guarantee attached to the code that needs it and fixes the bare add-on call site at the same time, which today has no lock at all.

### What happens to the nested helpers

They stop being nested transactions and become **plain functions that take the handle**:

```js
reserveForOrder({ db: tx, storeId, orderId, items, … })
ensureShipments(tx, orderId)
```

No inner `BEGIN`, no savepoint. Their atomicity comes from the caller's transaction, which is what actually happens today anyway — a savepoint inside a transaction that will roll back wholesale on any throw is doing no work the outer rollback would not do.

Both are dual-context, so both keep working when called with no open transaction: the bare caller passes `tdb()` and wraps in `withTransaction` itself. This is the step-2 rule applied unchanged, and it is what finally unblocks the two helpers that batches 1–4 have been steering around.

The savepoint path in `withTransaction` stays — it is correct and other call sites may nest — but the checkout will no longer use it.

### How the six typed errors survive

They survive **unchanged**, and this is the one part of the conversion that is genuinely low-risk, provided one property of the helper holds: `withTransaction` rethrows the **original error object**, with `e.code`, `e.product_id` and `e.available` intact. It already does this deliberately, and the reason recorded in its header is exactly this case — "a wrapper would turn every one of those 409s into a 500". Batch 4 proved the property on the qingyun `row_moved` path.

So the `catch` block moves from around `tx.immediate()` to around `await withTransaction(...)` and its contents do not change. What must be **asserted**, per typed error, is that each one still produces its exact 409 body after conversion — six assertions, one per error, red-proven individually, the batch-4 standard.

**The seventh exit is the fragile one.** The idempotency backstop matches the driver's error *message* with a regex. better-sqlite3 says `UNIQUE constraint failed: retail_orders.idempotency_key`; pg says `duplicate key value violates unique constraint "..."` and carries `err.code === '23505'`. **That regex silently stops matching at the flip**, and its failure mode is not an error — it is a customer being charged twice, or seeing `order_create_failed` where they used to get their order back. It should move to a code check with an engine-neutral shape *before* the flip, and it needs a test that fails on the wrong engine rather than passing on both.

### What the conversion must assert

Beyond the six errors and the written-column assertion, which is now non-optional:

- **No `await` reaches the transaction body other than the helper's own** — the body's external side effects must stay outside, and the post-commit placement of `supersedeUnpaidOrdersForCustomer` and the batch notice must be pinned, because moving either inside would put a helper that opens its own transaction inside the outer one.
- **The routing read is advisory** — a test where stock disappears between routing and reservation must produce `insufficient_stock`, not a successful oversold order.
- **Rollback leaves nothing**: order, items, shipments, reservations, voucher bump, points debit and wallet debit all absent after a mid-body throw. Nine writes, one assertion each.
- **No payment row survives a rollback**, and no gateway call exists inside the body.

---

## PART 3 — WHAT I AM NOT SURE ABOUT

1. **`busy_timeout`.** Not set anywhere I could find; only `journal_mode = WAL`. If it is 0, today's `BEGIN IMMEDIATE` may already be throwing `SQLITE_BUSY` under daemon contention and surfacing as `order_create_failed`. Check the box before designing around the current behaviour.
2. **Whether `FOR UPDATE` on the stock row is a sufficient lock**, given availability is derived from two tables. Stated in full above.
3. **`nextOrderNo` on Postgres.** It wants a sequence, but `order_no` is `TEXT UNIQUE` with a `TC%06d` shape and existing values; converting it is a migration question I have not costed.
4. **Whether the depth repair can be made without a behaviour change for the already-converted 26 call sites.** I believe it can, because all of them have synchronous bodies and never reach the contended path — but "I believe" is not "I measured", and the repair should be proven against all four existing conversion suites before the checkout goes anywhere near it.
5. **`mergeAddonItemsIntoShipments`.** Named in the brief as blocked behind the checkout, and it is — but it is called from `finalizeOrderAddon`, a 10-statement transaction I have not surveyed. It may unblock with `ensureShipments` or it may have its own reasons. I did not read it, and I am not going to assert it is easy.
6. **Load.** I have no measurement of how often two checkouts genuinely contend for the same product at the same store. The design is correct either way, but whether the parallelism the pg version buys is worth anything in practice is unknown, and if the answer is "this happens twice a month" that is worth knowing before the effort is spent.

---

## RELATED

- `docs/tacet-consolidation-decisions.md` §24 — Path A, the conversion batches, and the standing requirements this design inherits
- `lib/db-transaction.js` — the helper, its header, and the two claims in it that this document contradicts
- `scripts/diagnose_async_conversion_scope.js` — the count authority; 30 at the time of writing
