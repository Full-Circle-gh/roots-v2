# The money cluster — design record, v1.0

**2026-08-19 · What must stay true when a money helper is converted to async, what holds it true today, and how you would find out you broke it.**

Written for someone converting one of these helpers six months from now with no memory of any of this. Read it before you touch a helper, not after.

**This is not the survey.** The survey is recorded in `docs/tacet-consolidation-decisions.md` §24 and in `docs/tacet-postgres-status.md`; it is findable and it is not repeated here. This document exists because three separate pieces of work named it as a prerequisite and it did not exist.

**THIS DOCUMENT CONTAINS NO CONVERSION ORDER, NO BATCH PLAN AND NO SEQUENCING, DELIBERATELY.** Those follow from the invariants and belong in the work that does them. A design document that arrives with a plan attached gets read as a plan, and then the invariants are skimmed on the way to the schedule.

**FIGURES IN THIS FILE WERE RE-DERIVED AT `9d13d756`, not carried forward from the survey.** Line numbers move; several in the survey had already drifted by 600–800 lines when this was written. Every line reference below was taken at this head. If you are reading this at a later head, re-derive before trusting a number — and the derivation for each is stated so you can.

---

## 1. THE ONE THING TO KNOW BEFORE ANYTHING ELSE

**Every invariant in this cluster is held by a transaction boundary. Not one of them is held by a constraint.**

That is not a figure of speech. Measured against the cluster's own as-built record, `docs/tacet-postgres-schema-as-built-2026-08-11.sql`:

| Ledger table | Constraint beyond the primary key | Rows (2026-08-19 09:00 snapshot) |
|---|---|---|
| `retail_points_transactions` | **none** | **775** |
| `retail_topup_transactions` | **none** | **222** |
| `retail_refund_events` | **none** | 62 |
| `retail_order_addons` | **none** | 16 |
| `retail_customer_vouchers` | `UNIQUE (customer_id, voucher_id)` | 77 |
| `retail_lifetime_commissions` | `UNIQUE (order_id)` | 0 |
| `retail_referrals` | `UNIQUE (invitee_id)` | 1 |
| `retail_payments` | partial `UNIQUE (out_trade_no) WHERE out_trade_no IS NOT NULL` | 599 |

**Four of the eight carry nothing, and they include the two busiest of the four by a wide margin.** `retail_points_transactions` and `retail_topup_transactions` hold 997 of the 1,075 rows in the unconstrained set, and they are the two tables every points and wallet invariant is about.

**WHAT FOLLOWS FROM THAT, AND IT IS THE WHOLE REASON THIS FILE EXISTS.** A broken invariant here does not raise. It cannot: there is no constraint to violate. It commits, it returns success, and the customer's balance is wrong. The only thing that would notice is `scripts/check_ledger_invariants.js`, run by hand, after the fact — which is how check F found seven customers holding ¥3,669.64 that no ledger row explains, months after the rows were written.

So when you convert one of these helpers, **you are not protected by the database.** You are protected by the shape of the code you are changing, and this document is a description of that shape.

---

## 2. HOW TO READ SECTION 3

The invariants are grouped **by mechanism, not by helper**, because the mechanism is the thing you have to reason about. Two helpers with the same mechanism fail the same way; two helpers in the same feature can fail completely differently.

Each group answers four questions:

- **What must be true** — the invariant, stated so it could be checked.
- **What holds it today** — the actual construct, with a line reference.
- **Does it survive an async driver** — under `better-sqlite3` every statement is synchronous and a continuation runs to completion. Under `pg` every statement is a round trip and any point between two statements is a yield. The question is whether the mechanism still holds when another request interleaves there.
- **What a reader would see if it broke** — the detection signal.

**THE LAST COLUMN IS THE ONE THAT MAKES THIS DOCUMENT USABLE.** An invariant nobody can detect breaking is worse than one that errors, because the error at least stops. Where the answer is "nothing, until someone runs the checker", that is stated plainly rather than softened.

Detection signals refer to the checks in `scripts/check_ledger_invariants.js`: **E** points ledger sums to `points_balance` · **F** wallet ledger sums to `balance` · **G** `balance_after` matches the running sum · **H** no negative balance · **I** no orphaned ledger row · **J** no `out_trade_no` used twice in the wallet ledger · **K** every commission has its wallet row · **L** every paid-out referral has its reward row · **M** `lifetime_spend` reconciliation · **N** every settled add-on has its `order_addon_earn` row · **O** every swept batch has its expiry row · **P** forensic id-gap scan.

---

## 3. THE INVARIANTS, BY MECHANISM

### 3.1 Compare-and-set flips — 5 helpers — THESE SURVIVE

**What must be true.** A settlement runs exactly once per thing settled, however many times the callback fires. WeChat retries; the customer refreshes; the reaper and the operator race. Each must produce one credit.

**What holds it today.** A single `UPDATE … SET status = 'x' WHERE id = ? AND status = 'y'`, with everything downstream gated on its `changes` count. The row is both the lock and the record of the decision, and the flip is atomic on both engines.

| Helper | The flip | The gate |
|---|---|---|
| `finalizeTopup` | `routes/retail.js:29079` — `WHERE id = ? AND status = 'pending'` | inside the tx opened at `:29077` |
| `finalizeOrderAddon` | `:29329` — same shape | `if (claim.changes === 0) return;` at `:29331` |
| `creditReferralReward` | `:16540` — `WHERE id = ? AND status = 'joined'` | inside the tx at `:16526` |
| `reverseLifetimeCommission` | inside the tx at `:16631` | `if (!won.changes) return;` at `:16636` |
| `reverseOrderReferral` | `:16707` — `WHERE id = ? AND status = …` | `if (!won.changes) return;` at `:16709` |

**Does it survive an async driver? YES, and this is the mechanism to copy.** A conditional `UPDATE` is resolved by the engine, in one statement, under its own row lock. Two concurrent callers both issue it; exactly one gets `changes = 1`. Nothing depends on the caller having read anything first, so there is no window to interleave into.

**Two things that would break it, both easy to do by accident:**

- **Splitting the flip into a read and a write.** `SELECT status` → `if (status === 'pending')` → `UPDATE`. That is the same code to a reviewer and a different mechanism to the engine, and it turns a surviving guard into §3.4.
- **Moving the gate.** If `changes` stops being checked, or is checked after work has already been done, the flip still runs and no longer protects anything.

**What a reader would see if it broke.** A double credit — so **F** on the wallet side, **E** on the points side, and **G** immediately, since the second row's `balance_after` cannot match a running sum that already counted the first. Loud, by this cluster's standards.

---

### 3.2 The one real UNIQUE constraint — `creditLifetimeCommission`

**What must be true.** One commission per order, forever, regardless of how many times payment settles.

**What holds it today.** `UNIQUE (order_id)` on `retail_lifetime_commissions`, plus `INSERT OR IGNORE` at `routes/retail.js:16600` and `if (!ins.changes) return;` at `:16604`. The insert is the claim; the constraint decides who wins; the wallet credit at `:16609` is reached only by the winner.

**This is the only member of the cluster whose idempotency is enforced by the database.** The comment at `:16596` says so correctly.

**Does it survive an async driver? YES — the only one that survives for a reason that has nothing to do with the code's shape.** The constraint holds across processes, across connections, across a restart. Every other guard in this document holds because of how the statements are arranged.

**What a reader would see if it broke.** It cannot break by interleaving. It could only break by someone dropping the constraint, at which point the `INSERT OR IGNORE` silently becomes an `INSERT` — see §3.5 for what that failure looks like, because that is exactly the state `retail_topup_transactions` is in. Detection is **K**.

**The rule this one carries: `INSERT OR IGNORE` is not a guard. A constraint is a guard, and `INSERT OR IGNORE` is how you consume it.** The same three words in front of a table with no constraint do nothing at all, and read identically.

---

### 3.3 Status guards read before the transaction — 2 helpers — SURVIVE ONLY BECAUSE OF §3.1

**What must be true.** The helper does nothing when the thing it would act on is not in the state it expects.

**What holds it today.** A read taken **before** the transaction opens:

- `creditReferralReward` at `routes/retail.js:16492` — `WHERE invitee_id = ? AND status = 'joined'`, read at `:16492`, transaction opened at `:16526`.
- `reverseOrderReferral` at `:16676` — `WHERE first_paid_order_id = ? AND status = 'ordered'`, read at `:16676`, transaction opened at `:16703`.

**Does it survive an async driver? THE READ DOES NOT. THE HELPER DOES.** The gap between the pre-read and the transaction is a yield point under `pg`, and the state can change inside it. What saves both helpers is that neither *relies* on the pre-read: each repeats the condition as a compare-and-set inside the transaction (`:16540`, `:16707`) and gates on `changes`. **The pre-read is an optimisation, not a guard.**

**THIS IS THE MOST DANGEROUS SHAPE IN THE DOCUMENT, AND NOT BECAUSE IT IS BROKEN.** It is correct today, it looks exactly like §3.4 which is not correct, and the thing that makes it correct is forty lines further down. A converter who reads the top of `creditReferralReward` sees a stale-read bug, "fixes" it, and may well restructure the compare-and-set while doing so — removing the guard in the course of repairing something that was never wrong.

**If you touch either helper: the in-transaction compare-and-set is the guard. The pre-read is not. Do not reverse that.**

**What a reader would see if it broke.** A double referral reward — **F**, then **L**.

---

### 3.4 Read-then-write markers with nothing behind them — 3 helpers — THESE DO NOT SURVIVE

**What must be true.** The helper is idempotent: called twice for the same order, it acts once.

**What holds it today.** A read that looks for the marker row the helper itself would write, and returns early if it finds one. **The marker is an ordinary row with no constraint on it.**

| Helper | The read | The marker |
|---|---|---|
| `awardOrderPoints` | `:28528` — `SELECT id … WHERE order_id = ? AND source = 'order_earn'`, then `if (already) return` | the `order_earn` row it writes at `:28563` |
| `reverseOrderRedeem` | `:28433` — `SELECT COALESCE(SUM(delta), 0) …` | the `refund_redeem` row it writes at `:28444` |
| `reverseOrderPoints` | `:28591` — `SELECT COALESCE(SUM(delta), 0) … WHERE source = 'order_addon_earn'` | the row it writes at `:28607` |

**In `awardOrderPoints` the read is outside the transaction entirely** — `:28528` against a transaction opened at `:28549`. The comment at `:28545` states the design plainly: the `order_earn` row "is the single idempotency marker for both points-award AND lifetime_spend bump". That is true, and it is a marker with nothing enforcing it.

**Does it survive an async driver? NO. THIS IS THE GROUP THE CONVERSION HAS TO DEAL WITH.** Two callers both read, both find nothing, both insert. There is no constraint to catch the second. The result is a double award and a double `lifetime_spend` bump, and — because `lifetime_spend` drives tier — a customer promoted on money they did not spend.

**It is not a theoretical race.** `markOrderPaid` (§4.1) calls `awardOrderPoints` from every payment path, and WeChat retry callbacks are the normal case, not the edge case. Today the callbacks are serialised by a synchronous driver. That is the entire protection, and it is exactly what the flip removes.

**What a reader would see if it broke.** **E** fails, and **G** fails on the second row. `lifetime_spend` drift shows up in **M**, which is a reconciliation and not a pass/fail — so a tier promoted on doubled spend is visible only to someone reading M's number and asking why it moved. **Nothing raises. Nothing alerts. The customer sees more points than they earned and does not report it.**

**This group is the subject of the recommendation in §7.**

---

### 3.5 `out_trade_no` is believed unique and is not — 5 writers

**What must be true.** A WeChat callback that fires twice credits once.

**What actually holds.** `retail_topup_transactions.out_trade_no` carries **a plain, non-unique index on SQLite** (`idx_retail_topup_outtrade`) and **no constraint of any kind on PostgreSQL**. Its sibling `retail_payments.out_trade_no` carries a partial unique index. **Two tables in the same callback path, and only one is protected.**

**Five writers put a value in that column and treat it as a key:** `creditReferralReward` (`:16519`), `creditLifetimeCommission` (`:16610`), `reverseLifetimeCommission` (`:16649`), `reverseOrderReferral` (`:16696`), `reverseOrderBalance` (`:28478`). A sixth, `finalizeOrderAddon` (`:29396`), relies on it explicitly.

**THE CODE STATES BOTH POSITIONS, THIRTEEN THOUSAND LINES APART.**

- `creditReferralReward:16510` is **correct** and warns you off: the column "has only a plain (non-unique) index, so do not rely on it as an idempotency key."
- `finalizeOrderAddon:29393` asserts the opposite — *"Unique out_trade_no makes the credit idempotent across retry callbacks"* — and then relies on it at `:29396` with `INSERT OR IGNORE`, which has no constraint to conflict against. On a second call it does not ignore. It inserts. `credIns.changes === 1` at `:29400`, and the wallet is credited again.

**THE CREDIT IS SAFE TODAY, AND NOT FOR THE REASON THE COMMENT GIVES.** The real guard is the compare-and-set sixty lines above it at `:29329` — `UPDATE retail_order_addons SET status = 'success' … WHERE id = ? AND status = 'pending'` with `if (claim.changes === 0) return;` at `:29331`. A re-fire bails there and never reaches the credit.

**Note the trap inside the trap.** `finalizeOrderAddon` contains *two* `INSERT OR IGNORE` statements, forty lines apart. The one at `:29384` writes `retail_payments`, and its comment at `:29377` — "the out_trade_no is UNIQUE, so a retry…" — **is correct**, because that table does carry the constraint. The one at `:29396` writes `retail_topup_transactions` and the same claim is false. **Two identical-looking statements, one backed and one decorative, in one function.**

**THE GENERAL RULE, WHICH IS THE PART WORTH CARRYING OUT OF THIS SECTION:**

> **A guard that works for a reason its comment does not give is a guard nobody can safely move.**

The comment is not merely wrong; it is **load-bearing in the wrong place**. The next person to refactor `finalizeOrderAddon` reads it, concludes the `INSERT OR IGNORE` is the protection, preserves that, and restructures the compare-and-set — and breaks the function by a change made carefully, using the documentation, in good faith. This is the third instance of that family recorded in §24.

**Does it survive an async driver? THE BELIEF NEVER HELD ON EITHER ENGINE, SO THERE IS NOTHING TO SURVIVE.** What holds today is §3.1's flip, in every one of the six. If a converter moves the flip, the fallback the comment promises is not there.

**What a reader would see if it broke.** **J** exists specifically for this — "no `out_trade_no` is used twice in the wallet ledger" is a check written to stand in for the missing constraint. It is the clearest case in the system of a check compensating for a schema gap, and it only runs when someone runs it.

---

## 4. THREE MEMBERS THAT NEED THEIR OWN HEADING

### 4.1 `markOrderPaid` — writes no ledger, and excluding it is correct

`routes/retail.js:4377–4547`, 171 lines. **It is not in the population, and this heading exists so that the next person to exclude it does so for the right reason rather than by accident.**

It writes no ledger row. By write set it does not qualify, and that is the correct call. **But it orchestrates the money.** Inside one `if (r.changes > 0)` block it calls, in order:

1. `inventory.commitOrderReservations` — `:4460`
2. `prepareCommitUnreservedOrder` — `:4477`
3. **`awardOrderPoints`** — `:4483`
4. **`creditReferralReward`** — `:4486`
5. **`creditLifetimeCommission`** — `:4490`

Three of the five write ledger rows. **What it relies on, stated so it can be checked:**

- **A compare-and-set on `retail_orders.status`** at `:4389` / `:4392` — `WHERE id = ? AND status = 'pending_payment'` — with everything above gated on `r.changes > 0`. This is a genuine §3.1 flip and it is the reason retry callbacks do not re-run the five.
- **Each callee's own idempotency.** The three comments at `:4482`, `:4485`, `:4489` each say the callee is self-guarded. Two of those three guards are §3.1 and hold; **`awardOrderPoints` is §3.4 and does not.**
- **No transaction across the five.** Verified: `markOrderPaid` contains no `withTransaction` and no `.transaction(` anywhere in its 171 lines. Each callee opens its own. Every call is individually wrapped in `try`/`catch` that logs and continues.

**THE CONSEQUENCE, WHICH IS THE POINT OF THE HEADING.** There is no boundary here. If `awardOrderPoints` succeeds and `creditReferralReward` throws, the points are awarded and the referral is not, and the order is `paid`. That is the intended design — a failed referral must not un-award points — but it means **`markOrderPaid` is the place where partial money outcomes are legal**, and the only thing making the whole sequence run-once is the flip at the top.

**If you convert `markOrderPaid`: the flip is the invariant. Not the ordering, not the try/catch.**

### 4.2 `handleWechatPayCallback` — a ledger write outside every transaction

`routes/retail.js:4957–5074`. **It opens no transaction at all.** It writes `retail_topup_transactions` — a ledger table — with a bare statement, and then calls a helper that opens its own transaction.

```
:5014   UPDATE retail_topup_transactions SET transaction_id = ?, raw_callback_json = ? WHERE id = ?   ← transaction 1 (implicit, one statement)
:5017   finalizeTopup(tu.id)                                                                          ← transaction 2
```

The same shape repeats twice more: the add-on branch stamps at `:5039` then calls `finalizeOrderAddon` at `:5041`; the order branch stamps `retail_payments` at `:5061` then calls `markOrderPaid` at `:5063`.

**The stamp and the settlement are two transactions with an ordering dependency, and the dependency is stated only in a comment** — at `:5012`:

> *"Stamp the WeChat refs while still 'pending' — finalizeTopup only touches status/paid_at/balance/points, so this must land first."*

That comment is correct and it is the entire specification. Nothing enforces the order. **If the process dies between `:5014` and `:5017`, the top-up carries its WeChat references and is still `pending`** — money taken, nothing credited, and no partially-applied state that any check would flag, because a pending top-up with a transaction id is indistinguishable from one that arrived a moment ago.

**Under an async driver the gap between the two widens from "between two synchronous statements" to "across a yield".**

**By write set this function is invisible**, because the population is derived from `INSERT` sites and this writes by `UPDATE`. That is a property of how the population was drawn, not a judgement that it is out of scope — and it is why the heading exists.

### 4.3 `reconcileTier` — in scope for a different reason from every other member

`routes/retail.js:7501–7537`. **It writes no ledger row and it opens no transaction.** A reader who files it alongside `finalizeTopup` has misunderstood what it is, so this is stated explicitly.

It is here because of what it does to **someone else's** boundary. It is called **inside** `awardOrderPoints`' transaction, at `:28556`, and its single `UPDATE retail_customers SET tier_key = …` is wrapped in a `try`/`catch` that logs, fires a rate-limited ops alert, and **returns normally**.

**Swallowing an error inside another function's transaction converts a failure into a silent success.** The enclosing transaction commits. The points are awarded, `lifetime_spend` is bumped, and `tier_key` is stale — and `awardOrderPoints` has no way to know. The catch reads as belt-and-braces and is an atomicity defeat; §24 records it as the second member of the "comment names a stronger mechanism than the one holding" family.

**The alert text is deliberately customer-free**, and that is a considered flood guard rather than an oversight: `sendOpsAlert` de-duplicates on exact message text for 60 seconds, this runs on every authenticated request via `requireRetailAuth`, and a per-customer message would defeat the dedup entirely. The log names the affected ids; the alert only says to go and read it. **Do not "improve" the alert by putting the customer id in it.**

**If you convert anything that calls it, the question is not whether `reconcileTier` is async-safe. It is whether its caller should still be able to commit when it fails.**

---

## 5. THE POST-COMMIT BOUNDARY PATTERN

**The pattern.** A transaction that cancels or settles orders does not call the money reversals inside itself. It returns the affected ids, and a hook fires them **after the commit**, each opening its own transaction.

**Where it is implemented.** `lib/inventory.js:42–43` holds the hook (`_onOrdersCancelled`, set through `setOnOrdersCancelled`); it fires at `:1047–1048`, outside the transaction body, guarded on the returned id list. The reasoning is recorded at `:997–1001`: nesting a helper's `tdb().transaction()` inside the sweeper's would map to a `SAVEPOINT`, **and Postgres has no equivalent** — so the pattern is not a style preference, it is what makes these paths convertible at all.

**Where it is used consistently, and where it is not.** `sweepExpiredReservations` uses it. `supersedeUnpaidOrdersForCustomer` uses it and says so. **The other cancel paths do not** — the customer's own `/orders/:id/cancel`, the unpaid-timeout reaper, and the admin `pending_payment` branch each call `reverseOrderRedeem` + `reverseOrderBalance` + `reverseOrderVoucher` directly, as recorded at `lib/inventory.js:990–995`.

**So the pattern is the rule in two places and the exception in three.** Both arrangements are correct today. They will not both remain correct: a direct call from inside a transaction body becomes a nested transaction at the flip, and that is the one shape with no Postgres translation.

**If you are converting a path that reverses money, establish which of the two arrangements it uses before you change a line.** They look similar and they have different failure modes.

---

## 6. TWO THINGS THAT WILL FAIL AT THE FLIP AND ARE NOT IN THE 96

The "96 statements will not run on Postgres" figure comes from `scripts/diagnose_statement_sweep.js`, whose `PG_INCOMPATIBLE` table carries twelve rules and **has no rule for two-argument `MAX()`/`MIN()`**. SQLite has `max(a, b)` as a scalar function; Postgres has `max` only as an aggregate, so `max(integer, integer)` does not resolve. The portable spellings are `GREATEST` and `LEAST`.

**Four real instances in static SQL. Two are inside money writers, re-derived at this head:**

| Site | Statement | In this cluster? |
|---|---|---|
| `routes/retail.js:28598` | `reverseOrderPoints` — `lifetime_spend = MAX(0, COALESCE(lifetime_spend, 0) - ?)` | **yes** |
| `routes/retail.js:29365` | `finalizeOrderAddon` — `shipping_fee = MAX(0, COALESCE(shipping_fee, 0) - ?)` | **yes** |
| `routes/retail.js:17767` | refund lines — `refunded_qty = MIN(qty, …)` | no |
| `routes/retail.js:25009` | refund payments — `refunded_amount = MIN(amount, …)` | no |

*(The survey recorded these at `:27910`, `:28639`, `:17539` and `:24542`. All four have drifted by roughly 500–700 lines. The constructs are unchanged.)*

**THESE DO NOT DEGRADE. THEY ERROR — and both money instances sit inside a transaction, so the failure is not one bad column. It aborts the whole block.**

`reverseOrderPoints`' block also writes the ledger row that is its own §3.4 idempotency marker. **Losing the transaction loses the marker**, so the next call finds nothing, and tries again — against a `lifetime_spend` that may already have been decremented by a partially-applied earlier attempt on a different path. The failure is loud on the first call and its *consequence* is a §3.4 silent one.

**This is recorded here rather than left to the dialect sweep because the sweep will not find it.** The table is short; a rule added to `PG_INCOMPATIBLE` finds every instance forever, and until that rule exists these two are invisible to the tooling that everyone trusts to enumerate this class.

---

## 7. THE TWO BOOT MIGRATIONS — WHY THEY ARE IN THE INVARIANTS SECTION

**They are here, and not in the population, because whoever investigates a ledger inconsistency has to be able to find them.** Neither is reachable by reading `routes/retail.js`. Both run at boot from `database.js`, once, guarded by a row in `_migrations`.

**`fix_orphan_customer_fks_v1`** — `database.js:4019–4021`. **It DELETES ledger rows:**

```sql
DELETE FROM retail_customer_vouchers   WHERE customer_id NOT IN (SELECT id FROM retail_customers);
DELETE FROM retail_points_transactions WHERE customer_id NOT IN (SELECT id FROM retail_customers);
DELETE FROM retail_topup_transactions  WHERE customer_id NOT IN (SELECT id FROM retail_customers);
```

It rebuilds `retail_orders` to soften the customer FK, nulls dead order links, purges orphans from the three cascade tables, and verifies with `foreign_key_check` inside a transaction. On failure it logs `failed (left untouched)` and continues — **the boot does not stop.**

**THIS IS THE SINGLE MOST IMPORTANT ENTRY IN THIS DOCUMENT FOR ANYONE HOLDING AN UNEXPLAINED NUMBER.** If you are looking at the points or wallet ledger and the row ids have gaps, or a sum does not reconcile against a customer who no longer exists, **this migration is a candidate before any application bug is.** Check **P** — the forensic check "id gaps in the two ledgers only one migration ever deleted from" exists precisely to answer this question, and it is forensic rather than an invariant because a gap here is expected, not a defect.

**`drop_ledger_actor_fk_v1`** — `database.js:4049–4082`. It **drops and rebuilds `retail_stock_ledger`** to remove the `actor_user_id → users(id)` foreign key, because the actor can be a kitchen `users(id)` or a Mini App Backend `tenant_users(id)` — two id spaces — and the hard FK rejected every operator-driven ledger write. It reads the live `CREATE` from `sqlite_master` so ALTER-added columns survive, copies rows into a temp table, renames it into place, restores the indexes, and rolls back entirely on a residual `foreign_key_check`.

**It does not delete rows, and it does drop a table with your ledger in it.** A crash mid-migration is guarded by the transaction; the reason it is recorded here is that anyone diffing schema against the as-built record will find `retail_stock_ledger`'s definition does not match what `database.js` appears to create, and this is why.

**Neither migration has a Postgres equivalent, and neither should acquire one.** Both are SQLite table-rebuild idioms for a database that Postgres will replace. They are recorded as history a reader needs, not as work.

---

## 8. RECOMMENDATION — WHICH INVARIANTS SHOULD BECOME CONSTRAINTS BEFORE THE FLIP

**This is the only recommendation in this document. Everything above is description.**

The argument for acting before the flip rather than after: §3.4's three helpers are protected today **by the driver being synchronous**. That protection is removed by the flip itself, and it is removed from every path at the same moment. A constraint is the only guard in this cluster that does not depend on the shape of the code, which makes it the only one that cannot be undone by a later refactor that reads correct.

**I checked live data before proposing either of these**, against the 2026-08-19 09:00 hourly snapshot, `better-sqlite3` read-only, live file untouched.

### 8.1 RECOMMENDED — partial `UNIQUE (out_trade_no)` on `retail_topup_transactions`

```sql
CREATE UNIQUE INDEX retail_topup_out_trade_no_key
    ON retail_topup_transactions (out_trade_no)
 WHERE out_trade_no IS NOT NULL;
```

**Would it apply today? YES, cleanly. Measured: 222 rows, 0 NULLs, 0 duplicate values.** Nothing violates it.

**What it costs.** One index on a 222-row table. Nothing measurable. It is the exact treatment `retail_payments.out_trade_no` already carries, so it introduces no new pattern — it makes two sibling tables in one callback path consistent.

**What it buys, and this is the part that decided it.** `reverseOrderBalance` builds its key as `orderrefund:<orderId>:<n+1>` at `:28478`, where `n` comes from a `COUNT(*)` read at `:28466` — **outside the transaction it then writes in**. Under an async driver two concurrent partial refunds both read `n = 1`, both build `orderrefund:299:2`, and both insert. **With this constraint the second one fails loudly. Without it, the customer is refunded twice and check J is the only thing that would ever say so.** The constraint converts the single worst race in this cluster from a silent double-credit into an error.

It also makes the five writers' stated belief true, and turns `finalizeOrderAddon:29396`'s `INSERT OR IGNORE` from decorative into real — which means the wrong comment at `:29393` becomes correct rather than merely being deleted.

**What would break.** Any writer that legitimately needs two rows sharing one `out_trade_no`. **None does today** — verified: the redeem key is `orderspend:<id>`, the reversal keys are `orderrefund:<id>:<n>`, admin adjustments carry an `adminadjust…` value, migrations `migrat…`, top-ups `FCTU…`. All distinct by construction. The `WHERE out_trade_no IS NOT NULL` clause is deliberate even though there are no NULLs today: it keeps a future writer that omits the column from colliding with every other writer that omits it.

**Confidence: high.** It applies clean, it costs nothing, and it defuses a named race.

### 8.2 RECOMMENDED, NARROWLY SCOPED — partial `UNIQUE (order_id, source)` on `retail_points_transactions`

```sql
CREATE UNIQUE INDEX retail_points_order_source_key
    ON retail_points_transactions (order_id, source)
 WHERE order_id IS NOT NULL
   AND source IN ('order_earn', 'order_redeem', 'refund_redeem');
```

**Would it apply today? YES for those three sources, and NO for the general form — which is why it is scoped.** Measured across all 775 rows:

| source | rows | `order_id` NULL | duplicate `(order_id, source)` groups |
|---|---|---|---|
| `order_earn` | 498 | 0 | **0** |
| `order_redeem` | 77 | 0 | **0** |
| `refund_redeem` | 11 | 0 | **0** |
| `order_addon_earn` | 8 | 0 | **1** — order 873 |
| `refund_reverse` | 9 | 0 | **1** — order 299 |
| `migration` · `poll_vote` · `expiry` · `admin_adjust` · `topup_bonus` | 172 | all | n/a |

**A blanket `UNIQUE (order_id, source)` would fail to apply. Two existing rows violate it, and I checked both — both are legitimate:**

- **Order 873, two `order_addon_earn` rows** (ids 679, 680, one minute apart, 0 points each). The order genuinely has **two add-ons**, and the design is one row per add-on. Uniqueness is wrong for this source.
- **Order 299, two `refund_reverse` rows** (ids 359, 360, same second, `delta = -2` "Reversed on refund" and `delta = +1` "Redemption returned on refund"). **Two different economic events sharing one `source` label** — the earn clawback and the redemption return. Uniqueness is wrong for this source too, and the overloaded label is a separate finding worth recording: it is why `reverseOrderRedeem`'s own lookup at `:28432–28435` has to special-case `source = 'refund_reverse' AND delta > 0`, and says so in a comment calling those rows "legacy … written by the pre-split code".

**What it buys.** It converts §3.4 — the group that does not survive — into enforced invariants for the three sources that carry a genuine once-per-order meaning. `awardOrderPoints`' pre-transaction `already` read at `:28528` stops being the only thing standing between a retry callback and a double award, **and a double `lifetime_spend` bump, and a tier promoted on money nobody spent.** That is the failure this cluster is least able to detect and most able to embarrass itself with.

**What it costs.** One partial index on a 775-row table — negligible now, and both engines support the partial form natively. The real cost is **honesty about scope**: it protects three of ten sources, and the two it cannot protect are precisely the two with a history of duplicate rows. It is a smaller win than it looks, and pretending otherwise would be the wrong way to sell it.

**What would break.** A future path that legitimately writes two `order_earn` rows for one order. None exists, and `awardOrderPoints:28545` states in a comment that the row is *the single* marker — so the constraint would be enforcing the design's own stated intent rather than adding a new rule.

**Confidence: medium-high on the three scoped sources. I would not widen it without re-measuring**, and the two exclusions should carry a comment naming order 873 and order 299 so the next person does not re-propose the blanket form and get a failed migration.

### 8.3 NOT RECOMMENDED — anything on `retail_refund_events` or `retail_order_addons`

`retail_refund_events` (62 rows) is an append-only event log; uniqueness on it would be asserting something the design does not claim. `retail_order_addons` (16 rows) is already protected where it matters by the compare-and-set at `:29329`, which is a §3.1 mechanism and survives the flip on its own merits. **Adding a constraint to a table whose guard already survives buys nothing and creates a second thing to keep true.**

### 8.4 The honest summary of the recommendation

**Add 8.1. It is free, it applies clean, and it converts a real silent double-credit into an error.**

**Add 8.2 scoped as written, or not at all.** It is the one that protects the group that does not survive the flip, and it is also the one whose blanket form fails on live data — so it is worth doing precisely and not worth doing casually.

**Everything else in this cluster should stay discipline**, because §3.1's flips and §3.2's constraint already survive, and a constraint added where a mechanism already holds is a maintenance obligation disguised as safety.

---

## 9. THE POPULATION — 19, RE-DERIVED AT THIS HEAD

Derived mechanically: every `INSERT` into one of the eight ledger tables in `routes/retail.js`, mapped to its enclosing top-level function or route registration. **31 insert sites, 25 owners.** Excluding the six that cite this document rather than living in it leaves **19**.

**Fourteen named helpers:** `grantSignupVouchers` · `claimMigrationCredit` · `creditReferralReward` · `creditLifetimeCommission` · `reverseLifetimeCommission` · `reverseOrderReferral` · `logRefundEvent` · `sweepExpiredPoints` · `reverseOrderRedeem` · `reverseOrderBalance` · `awardOrderPoints` · `reverseOrderPoints` · `finalizeTopup` · `finalizeOrderAddon`

**Five money routes:** `POST /api/retail/vouchers/claim` · `POST /api/retail-admin/vouchers/:id/grant` · `POST /api/retail/affiliate/apply` · `POST /api/retail/topup/create` · `POST /api/retail/orders/:id/addon/create`

**Six owners cite this document and are out of scope, as fixed:** the checkout (`POST /api/retail/orders`), the poll vote (`POST /api/retail/polls/:id/vote`), and the four adjust/admin routes (`POST …/customers/:id/points-adjust`, `POST …/customers/:id/wallet-adjust`, `POST /api/retail-admin/orders`, `PATCH /api/retail-admin/orders/:id/status`).

**Three functions are covered by §4 and are not in the 19 by insert write set:** `markOrderPaid` (writes no ledger), `handleWechatPayCallback` (writes the ledger by `UPDATE`, so an `INSERT`-derived population cannot see it), `reconcileTier` (writes no ledger, opens no transaction, and runs inside someone else's).

**Two names the survey used no longer exist at this head.** `creditWallet` and `debitWallet` are not present in `routes/retail.js`; the wallet writes at the line numbers the survey gave now belong to `creditReferralReward` and `reverseOrderReferral`. The behaviour described is unchanged — the names are not. **Re-derive before citing a helper by name from a document older than this one.**

---

## 10. WHAT THIS DOCUMENT DOES NOT COVER

- **The checkout.** `docs/tacet-checkout-transaction-design.md` owns it. It is money and it is deliberately not here.
- **Conversion order, batching or sequencing.** Not an omission. See the header.
- **`claimMigrationCredit`'s missing ledger row** — it credits the wallet and writes no ledger row, measured at 7 customers and ¥3,669.64, with 53 unclaimed credits carrying ¥17,362.32 that will each repeat it. That is an open defect tracked as item 42 in `docs/tacet-postgres-status.md`, not an invariant of this cluster. **It is named here only because a cutover verification that rebuilds balances from the ledger will zero those seven customers**, and whoever writes that verification will come looking in this file.
