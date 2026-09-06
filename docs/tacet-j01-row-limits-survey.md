# J-01 re-verified — which list endpoints still have no row limit

**Read-only survey, 2026-09-06. No code changed.** Commissioned because J-01 is
the last High-severity finding in `docs/tacet-audit-2026-09.md` that nobody had
re-checked, and adding a row limit changes what an API returns — which is a
decision rather than a cleanup.

> ## ⚠️ CORRECTION, 2026-09-06 (same day, after the first version was merged)
>
> **This survey was wrong about `/finance/transactions`, which was its entire
> "one genuinely open item".** That endpoint has had a row ceiling since
> `188a50bf` (2026-09-04) — *two days before this survey was written* — under a
> comment that names this very finding: *"The row ceiling, applied to the MERGED
> list (audit J-01)"*.
>
> **How the error was made, because it is a repeatable one:** I read the
> handler, followed it into `readTransactions()`, saw three `.all(from, to)`
> calls with no `LIMIT`, and stopped there. The cap is applied ~120 lines
> further down, to the merged and re-sorted list, and the comment explains why
> it cannot be in the SQL: the three reads are interleaved by date afterwards,
> so capping each query separately *"would drop rows from the middle of the
> window and the screen would show a ledger with holes in it"*. Reading the
> query and not the function is how a present fix looks absent.
>
> **The recommendation below is also superseded.** It argued for capping the
> window span rather than paging, because *"the screen shows a net total under
> the list and a paged list whose total is computed from one page is worse than
> a slow one"*. That objection is real and had already been answered better:
> `totals` and `counts` are computed **before** the cut, on the whole window,
> and only `rows` is sliced — with `truncated` reported. The CSV export passes
> `{ cap: false }` for the same reason this survey gives for not paging
> `/products/export.csv`.
>
> **So J-01 is effectively closed:** six of the seven have ceilings, and the
> seventh should not have one. What genuinely remains is smaller and different
> from anything below — see *What is actually left* at the foot of this file.
>
> Everything from here to that section is the original text, left intact
> because a survey that quietly rewrites itself teaches the next reader
> nothing.

**The headline: five of the seven endpoints the audit named as "will bite
first" have been paged since it was written.** One of the two that remain
should probably not be paged at all. So the item is much smaller than its
severity suggests, and what is left is one endpoint and one question.

---

## Why the line numbers in the audit no longer resolve

Every citation in J-01 has drifted, which is the house rule at the head of
`tacet-consolidation-decisions.md` doing exactly what it warns about:

| Endpoint | Audit said | Actually at |
|---|---|---|
| `/materials` | `retail-materials.js:156` | `:160` |
| `/suppliers` | `retail-purchasing.js:639` | `:668` |
| `/recipes` | `retail-recipes.js:184` | `:188` |
| `/finance/transactions` | `finance-transactions.js:237` | `:409` |
| `/inventory/grid` | `retail-inventory.js:201` | `:229` |
| `/purchasing/invoices` | `retail-purchasing.js:1796` | `:1833` |
| `/products/export.csv` | `retail.js:21540` | `:22161` |

The prose beside each stayed true; the coordinates did not. Everything below is
read from the current tree.

---

## The seven, as they stand today

| Endpoint | Audit | Today | |
|---|---|---|---|
| `/materials` | no limit | `LIMIT ? OFFSET ?` | ✅ fixed |
| `/suppliers` | no limit | `LIMIT ? OFFSET ?` | ✅ fixed |
| `/recipes` | no limit | `LIMIT ? OFFSET ?` | ✅ fixed |
| `/inventory/grid` | no limit | `LIMIT ? OFFSET ?` | ✅ fixed |
| `/purchasing/invoices` | no limit | `LIMIT ? OFFSET ?` | ✅ fixed |
| `/finance/transactions` | no limit | still none | ⚠️ open |
| `/products/export.csv` | no limit | still none | ⚠️ by design |

`/purchasing/invoices` also carries a comment recording that **J-02's
query-per-row loop was fixed at the same time** — "This ran `linkStmt.all(inv.id)`
inside the map below" — so half of J-02 is closed too.

---

## The one that is genuinely open

### `/finance/transactions` — `routes/finance-transactions.js:409`

It delegates to `readTransactions(query)`, which runs three queries with
`.all(from, to)` and no `LIMIT` on any of them.

**It is not unbounded in the way the finding reads.** `resolveWindow()`
(`lib/finance-window.js:83`) defaults to **the last 30 days** — `to` is today,
`from` is 29 days back. An operator only exceeds that by passing explicit
`from`/`to`, and there is no cap on how wide that span may be.

**Today it is nowhere near a problem, and the numbers are real** — from the
production census in the 2026-09-06 money rehearsal:

- `expense_entries` — **183** money values, ever
- `income_entries` — **26** money values, ever

So the entire ledger is around two hundred rows, and a default window returns a
handful. The risk is a busy shop several years in asking for a multi-year
window, which returns every ledger row it has in one response.

**Two ways to close it, and they are not equivalent:**

1. **Cap the span.** `resolveWindow()` already computes `span_days`, so the
   value is in hand. Refusing a window over, say, a year is one comparison and
   changes nothing an operator does today.
2. **Add `LIMIT`/`OFFSET`.** Matches the shape Orders, Customers and Media
   already use — but the Transactions screen shows a **net total** under the
   list, and a paged list whose total is computed from one page is worse than a
   slow one. The total would have to be a separate aggregate query.

**Recommendation: cap the span.** It is smaller, it cannot make a figure lie,
and it fails in the direction of telling the operator rather than quietly
returning part of an answer.

---

## The one that should probably stay as it is

### `/products/export.csv` — `routes/retail.js:22161`

It assembles the whole catalogue in memory with three unlimited `.all()` calls.

**But it is an export, and an export that returns some of your data is worse
than one that is slow.** A `LIMIT` here would silently hand a merchant a
truncated CSV they would reasonably believe was complete — the same class of
failure as the mini-app upload that dropped a file and reported success.

If it needs fixing, the fix is **streaming** the rows to the response rather
than building an array, which bounds memory without bounding the answer. That
is a different piece of work from paging, and it is not urgent: the catalogue
is 278 products.

---

## About the "63"

The figure could not be reproduced and it is not clear what it counted.
Scanning every `router.get()` in `routes/` that calls `.all()`:

- **240** such handlers
- **99** have a `LIMIT` somewhere
- **141** have none

*Method: the text between each `router.get(` and the next `router.*(` is
searched for `LIMIT ?` or `LIMIT <digit>`. It over-counts handlers with several
queries where only one is limited, and it spans all of `routes/`, not just the
retail admin. It is an indication, not a census.*

**The count is not the useful thing.** The audit's own sentence is: *"Most of
the 63 are small lookup lists where it does not matter."* That is still true —
the unlimited ones include `/api/backend/team`, `/api/backend/plans`,
`/api/admin/users`, `/api/retail-admin/eleme/stores`. None of those grows with
trade.

**The question that sorts them is what the table grows with:**

- **Grows with USE** — a row per order, per transaction, per customer, per
  stock movement. These need a limit eventually, and the biggest are already
  paged. For scale, the largest tables in the production census are
  `retail_checkout_quotes` at **146,548** values and `sales_entries` at
  **28,400**.
- **Grows with SETUP** — a row per store, per user, per plan, per delivery
  zone. These are bounded by how big the business is, not by how much it sells.
  A limit on them is code nobody needs.

Anything worth doing after `/finance/transactions` should be picked with that
test, not by working down a list of 141.

---

## Suggested order

1. **Cap the window span on `/finance/transactions`.** Small, safe, closes the
   one genuinely open item.
2. **Nothing else, yet.** Five of seven are done, the export should not be
   paged, and the remainder are lookup lists.
3. **Amend J-01 in the audit** to say five of its seven are closed — otherwise
   the next reader re-derives this survey from scratch.

**Nothing here is urgent.** J-01 reads as High because an unbounded list is a
real class of fault, but the specific endpoints that carried the risk were
fixed, and the one left is bounded by a 30-day default over a two-hundred-row
ledger.

---

# What is actually left (2026-09-06 correction)

With `/finance/transactions` established as already capped, **no endpoint in
J-01 returns an unbounded number of rows to a client.** The finding is closed as
written.

One narrower thing is true and is worth recording so it is not rediscovered as
though it were J-01:

### `readTransactions()` reads the whole window into memory before it slices

The cap is applied in JavaScript, to the merged list. The three SQL reads still
fetch every income row, every hand-entered expense and every posted-PO group in
the window. So the **response** is bounded and **memory** is not.

**This is a deliberate trade with a stated reason** — the three are interleaved
by date, and a per-query `LIMIT` would punch holes in the middle of the ledger.
That reasoning is sound and a fix must not undo it.

**It is also nearly harmless today.** From the production census: 183 expense
values and 26 income values, ever — about two hundred rows in the entire
ledger, against a 30-day default window.

**If it is ever worth closing**, the shape is a cap on the window *span*, not on
the rows: `resolveWindow()` already computes `span_days`, and refusing a window
over a year is one comparison. That bounds the memory without touching the
interleave, and it fails by telling the operator rather than by quietly
returning part of an answer. `routes/finance-summary.js:91` and
`routes/finance-transactions.js:410` already refuse an inverted window in
exactly that shape, with a bilingual message — so the pattern to copy exists
and no new string would have to be composed.

**Recommendation: do nothing.** Two hundred rows does not justify a behaviour
change to an API, and the span cap is worth building the day a ledger is large
enough to notice — not before.
