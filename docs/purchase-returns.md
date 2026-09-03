# Purchase returns — the model, and where it stops

**2026-09-01 · The design record for goods that arrived, were accepted, and went
back to the supplier. Written alongside the change that added them, not after
it. It states what a return is, what it moves, what it deliberately does not
move, and which known problems it declines to solve so that the next person does
not have to re-derive any of it from the diff.**

Reads against `docs/tacet-purchasing-receiving-survey.md` (2026-08-27), which
surveyed this path and is the reason several of the decisions below are stated
rather than assumed.

---

## The question this answers

> The flour arrived on the 25th. Today is the 1st and we have found it is the
> wrong thing. We are sending it back. Can I change the purchase order and have
> the invoice and the books follow — as an UPDATE, not a second record?

Before this change the answer was "partly, by lying". The only editable number
was the arrived count, so a return had to be entered as `15 → 0`, which asserts
the flour never turned up. That contradicted the receipt that said it had,
erased the delivery from the order's own reading of itself, and afterwards could
not be told apart from a supplier who had never shipped. Meanwhile the 发票
chase billed the ORDERED quantity, so it went on asking the supplier for a 发票
covering flour we no longer had.

The answer now is yes, on all three counts, and the rest of this document is the
detail of that yes.

---

## What a return is

A fourth quantity on the purchase line, drawn from the third:

```
ordered   po_line_items.qty            what the order asked for
arrived   po_line_items.qty_received   what turned up          (NULL = not yet)
damaged   po_line_items.damaged_qty    of that, what was broken
accepted  arrived − damaged            what we took onto the shelf
returned  po_line_items.returned_qty   of that, what went back
```

Each one is drawn from the one above it, so a line reads straight down and
`accepted − returned` is what we still hold.

`returned_qty` is **cumulative and absolute**, exactly as `qty_received` is. A
payload states where the line now stands, never what to add. Re-saving a screen
that already showed "3 returned" returns nothing further; every consumer reads
one column instead of replaying a history.

The rule lives in **`lib/po-returns.js`** — one definition site, four readers
(both receive routes, the retail 发票 chase, the older finance summary).

### A return is drawn from `accepted`, never from `damaged`

Both halves are load-bearing.

Drawn from accepted, because those are the only units that were ever ours to
send back — a unit that never reached the shelf cannot leave it.

Never from damaged, because a damaged unit is already its own quantity and
already excluded from stock. Letting a return draw from both needs an allocation
rule — *were those two the broken ones?* — that no screen in this product can
answer, and a wrong guess moves real stock. This codebase has already refused
damage once for the same kind of reason: it is not a receipt reason either
(`database.js`, the `receipt_reason` comment), because it is a quantity, not an
explanation.

**Consequence, stated plainly:** breakage the supplier makes good on is not
expressible as a return. It is a credit against the damage, and damaged units
are still expensed in full — pre-existing behaviour, unchanged here, recorded in
the survey as an undocumented quirk and now documented. See *What this does not
do*.

---

## What a return moves

### Stock — through the mechanism that was already there

`applyReceivedToStock` has always applied `good − stock_applied_qty` as a delta,
and has always been able to run that delta negative (that is how a corrected
count works, and how `/undo-receive` reverses). Returns change one expression:

```js
good = arrived − damaged − returned      // lib/po-returns.js onHandQty
```

So a return needs no path of its own, cannot double-apply, and converges on
repeated saves like every other correction on this route. Material lines move no
stock at all (§28) and returns change nothing about that.

**It refuses rather than clamps.** `inventory.adjustStock` clamps at zero, so a
return of three units against one on the shelf would remove one, record three,
and leave the line and the shelf disagreeing silently. The receive route
therefore plans the removal and refuses the whole save before opening its
transaction (`planReturnRemoval` → HTTP 409 `return_blocked`), which is the same
promise `undoBlocked` already makes for reversals: refused, and nothing written.

That check runs **only on a save that increases a return**. A save that merely
lowers an arrived count reaches `adjustStock` the same way and has always been
allowed to clamp; tightening that is a separate change to a path the warehouse
uses daily. See *What this does not do*.

### Money — by restating the purchase, not by appending a credit

`postRetailPOExpenses` and `postPOExpenses` have always been idempotent
DELETE-then-INSERT keyed on `po_id`. The quantity they bill becomes:

```sql
MAX(0, COALESCE(qty_received, qty) - COALESCE(returned_qty, 0))   -- billableQtySql
```

So there is one purchase and one set of expense rows, and a return **updates
them in place** — which is what was asked for. The rows keep `po.date`.

**The trade this makes, said out loud:** flour bought on 25 August and sent back
on 1 September lowers *August*, not September. That is the honest reading of "we
paid for less than we thought" and it is what "update, not a second record"
means. It also silently restates a month that may already have been reported,
and nothing in this codebase locks a period to stop it. Booking the credit in
the month the goods went back is a different accounting policy, not a bug fix,
and not one a route may pick on a tenant's behalf. The PO screen says which date
the money moved on (`returnedNetted`) so nobody has to discover it in a
month-end report that no longer matches the one they printed.

### The 发票 chase — which now agrees with Finance for the first time

The chase billed `qty × cost_per_unit` — the ORDERED quantity — while Finance
expensed `COALESCE(qty_received, qty)`. One purchase, two figures, no
explanation on either screen. Both now use `billableQty`. A short delivery is
chased for what turned up; a return comes off the chase.

Where a 发票 was already recorded for more than the line is now worth — the
ordinary case when goods are invoiced before they go back — the difference is
reported as `credit_due` per line, per supplier and in the totals. **Surfaced,
never corrected**, which is the stance this screen already takes on an invoice
allocated past its own header: the money is real and in the ledger, and what
closes the gap is a credit note from the supplier, not a route quietly writing
an allocation down.

### The record — a return is its own event

`po_receipts` gains `kind` (`'receipt'` | `'return'`) and `po_receipt_lines`
gains `returned_qty`. A save that both corrects counts and records a return
writes **two rows**, because they are two movements in two directions.

`kind` is stamped at write time rather than derived, unlike the
delivery-vs-correction distinction beside it. That derivation asks "is this the
first receipt to cover this line", and a return is always *later* than the
delivery it takes back — so a return would derive as a correction to that
delivery, which is exactly the confusion this feature exists to end. Direction is
a property of the event, not something a reader can infer from ordering.

Two consequences follow, and both are in the code:

- The Received list judges a return on being a return, not on `new_lines`; a
  delivery is still judged the old way.
- `new_lines` counts coverage from **receipts only**, or a return would count as
  "this line has been received before" and quietly hide the next genuine
  correction to it.

`po_receipt_lines.returned_qty` is the **movement** — what went back on that
day — while the line's column is the running total. That asymmetry is
deliberate: a snapshot here would make every reader diff consecutive rows to
recover the only number a return event actually has.

---

## What the operator does

On the receive panel (which stays editable at `Delivered`), the line gains a
**Returned 退货** box and a reason picker that appears with the first unit.
Confirm delivery. Stock, Finance and the 发票 chase all follow the one save.

A reason is required — five codes, fixed and validated server-side, so "what do
we keep sending back to this supplier" is countable rather than readable one note
at a time. `wrong_item` is shared with the receipt-reason list; the other four
(`quality`, `expired`, `over_delivery`, `not_needed`) are reasons goods LEFT, not
reasons fewer arrived. Every string is locked in
`docs/tacet-delivery-vocabulary.md` (fifth amendment).

`/undo-receive` clears returns along with the counts. An undo asserts the goods
never arrived, and goods that never arrived cannot have been sent back. The
events survive — `po_receipts` is append-only.

---

## What this does not do

Every item here was considered and left. None is a defect introduced by this
change; each is a boundary.

1. **No supplier credit-note document.** A return reduces what we owe and
   reports `credit_due` where a 发票 already covers more than the line is worth.
   It does not model the red-letter invoice the supplier issues back, because
   `invoices` here is a hand-entered document with hand-entered allocations —
   the credit note belongs to that half of the system, and inventing one on the
   return would give the same money two records.
2. **Damaged units still cannot be returned, and are still expensed in full.**
   The reasoning is under *drawn from accepted, never from damaged*. Both halves
   of that are pre-existing; only the first is newly enforced.
3. ~~**A downward correction to an arrived count still clamps at zero stock**
   rather than refusing. Returns refuse; corrections behave as they always have.
   Making both refuse is a one-line change to `applyReceivedToStock` and a
   behavioural change to a path the warehouse uses daily, which is not something
   to smuggle in beside a new feature.~~

   **SUPERSEDED 2026-09-03 by §39 ruling 7. The correction no longer clamps, and
   it is not refused either — it takes the shelf NEGATIVE.** This entry named
   two options and Ash chose a third. **The reasoning: if only 8 boxes actually
   arrived, the 10 in the system is a lie, and blocking the correction protects
   the lie.** A negative balance is ugly but true — it says stock was sold that
   was never held, which really happened and which someone should be able to
   see. Same reasoning as the dispatch ruling, which settled the identical
   question at the warehouse end.

   **The asymmetry this entry recorded therefore STANDS, and is now deliberate
   rather than deferred: returns refuse, corrections go negative.** They are
   different assertions. A return says goods left the shelf, which is false if
   they were never there — so it is refused. A correction says the count was
   always wrong, which is a claim about the record rather than the goods, and
   refusing it would keep a number everybody already knows to be false.

   **What made this safe to change was not this file.** The clamp lived in
   `lib/inventory.js` and governed five call sites; removing it required the
   dispatch ruling, a guard on the Kitchen Quick Stock delta path, and a fix to
   the dashboard queries that filtered on `= 0` and would have hidden every
   negative it created. Recorded in `docs/tacet-stock-movement-schema.md`
   PART E.
4. **No period lock.** A return restates the month the purchase was booked in,
   and nothing stops it. Locking closed periods is a Finance-wide decision with
   nothing to do with returns.
5. **No return UI on the phone.** The phone records what arrives at the door; a
   return is decided afterwards, at a desk. The endpoint accepts returns from
   any caller and the phone reads them — it shows returned units on a delivery,
   marks return events in the Received list, and explains the refusal it can now
   provoke (lowering an arrived count below what has already gone back). What it
   does not offer is a control to record one.
6. **The kitchen route accepts returns; no kitchen screen sends them.** The rule,
   the validation and the money are shared by both receive endpoints — parity at
   the seam, so the two can never disagree about what a return is — but the only
   screen that records one today is the retail receive panel.
7. **Freight and fees are not netted.** The landed-cost extras post as their own
   expense row and stay whole: the shipping was paid whether or not the goods
   came back.
8. **A return does not create a back-order.** Short means the supplier owes us
   goods; returned means we sent them back deliberately. The back-order route
   still keys on the shortfall only.

---

## Testing

`scripts/test_purchase_returns.js` (`npm run test:purchase-returns`) covers the
model end to end against a real schema and real routes: the arithmetic in both
JS and SQL, stock coming back off the shelf, the books being restated in place
and at the original date, the 发票 chase following, the refusals (no receipt yet,
more than accepted, no reason, shelf too short — and that a refused save writes
nothing), the return event being recorded as its own row, and the undo clearing
it.
