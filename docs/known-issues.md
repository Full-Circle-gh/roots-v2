# Known issues

Accepted defects — understood, bounded, and deliberately not fixed yet. Each
entry records the exact mechanics so the next person doesn't have to re-derive
them, and a candidate fix so picking one up doesn't start from scratch.

An entry belongs here when we can state precisely what goes wrong, how often,
and what it costs. Anything we can't characterise that well is a bug, not a
known issue.

---

## CANCEL-DURING-IN-FLIGHT-PUSH

**A live Qingyun delivery can outlive the order it was created for.**

*Area:* same-city courier push · `scripts/qingyun-daemon.js`, `routes/retail.js`
*Status:* pre-existing; confirmed and characterised 2026-08-06. Not introduced
by the address-pin work, and not closed by it either.

### Mechanics

The drain marks a queue row `processing`, then awaits `createOrder`. If the
order is cancelled or refunded during that window:

1. `qingyunDropCopyForClosedOrder` (`routes/retail.js`) runs on the cancel. It
   reads the queue row, sees no `qingyun_order_id` yet — because the create
   hasn't returned — and takes the copy-less branch: it retires the row and
   returns **without deleting anything, because there is nothing to delete yet**.
2. `createOrder` then succeeds. The daemon's success UPDATE is
   `WHERE id = ?`, unconditional on status, so `qingyun_order_id` lands on the
   now-retired row: `status='done'` with a real courier id.
3. Nothing re-runs the delete. `qingyunDropCopyForClosedOrder` fires once per
   cancel transition, and there is no sweep behind it.

Net: a live 待配送 job on the courier platform for an order that no longer
exists. Someone at that store can dispatch it, and it is billable.

### Why it is bounded

The id **is** recorded locally, so nothing becomes untracked: the order drawer
shows a normal ship-from panel, and staff can delete the copy from the Qingyun
app. The window is the duration of one `createOrder` call — seconds — and only
for an order cancelled inside it.

### Candidate fix

Re-read `retail_orders.status` immediately after `createOrder` returns, and if
the order closed while the call was in flight, delete the copy through the
existing `_qingyunDeleteCopy` path. Alternatively (or additionally) a periodic
sweep for `status='done'` rows whose order is in `CLOSED_ORDER_STATUSES` and
whose copy has not been deleted.

A status guard on `RETIRE_CLOSED_SQL` does **not** fix this — the retirement
isn't winning wrongly, it's being overwritten by the success UPDATE.

---

## OUTAGE-OUTLASTS-ETA

**A long geocoder outage can end in silent abandonment rather than a late
delivery.**

*Area:* same-city courier push × the auto-deliver ETA sweep ·
`scripts/qingyun-daemon.js`, `routes/retail.js`
*Status:* accepted 2026-08-06, as a consequence of two behaviours that are each
correct on their own.

### Mechanics

1. A push whose geocoder call fails (quota, timeout, network) is **held**: the
   queue row stays `pending`, spends no retry attempt, and carries
   `geo_held_at`. It retries every drain and goes out by itself on recovery.
2. Independently, the auto-deliver ETA sweep (`routes/retail.js`) marks a
   delivery order `delivered` once its `local_eta + grace` has passed and no
   live `delivery_jobs` row contradicts it. A held order has no delivery job at
   all, so it satisfies that condition.
3. The push's closed-order gate then sees `status='delivered'` and retires the
   row permanently.

So an outage longer than the order's remaining ETA window ends with the order
recorded as delivered and **never dispatched** — where previously it would have
gone out late.

### Why it is bounded

The geocoder-hold alert pages ops after 10 minutes (`QINGYUN_GEO_HOLD_ALERT_MIN`)
and repeats every 15, so a human should be on it long before an ETA lapses. The
false `delivered` flip is the ETA sweep's own pre-existing behaviour and happens
whether or not the push is held; what the gate changes is that the delivery is
then abandoned instead of arriving late.

### Candidate fix

Exclude rows with a live `geo_held_at` from the ETA sweep's false-delivered
flip — an order the system knows it hasn't been able to dispatch should not be
auto-marked as delivered. That keeps both behaviours and removes the interaction.
