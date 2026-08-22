# Tacet mobile — parity with the desktop admin

**Audit, 2026-08-22, from source.** Read `public/m.html` (the phone build
`server.js:625` serves to every mobile browser) against the desktop modules
under `public/retail-admin/`. Every row below carries a file reference; nothing
here is inferred from a screenshot.

> **The finding, in one line: the phone is a monitoring app whose write
> controls are mockups.** Nine controls looked like they did something and
> wrote nothing. The order controls were fixed on 2026-08-22 (`9f84247`); the
> rest are listed here with what each would take.

---

## How the two surfaces differ by design

The phone is deliberately not the desktop. Authoring — a product with options
and variants, a coupon, a broadcast, a mini-app page — belongs to a keyboard
and a big screen, and the phone says so in its own words ("full authoring on
desktop"). What the phone owes an operator is the daily loop: see what needs
me, open a record, move it one step, and say something back to a customer.

So a missing capability is only a defect when it is part of that loop. Each row
below is judged on that, not on "the desktop has it."

---

## 1. The controls that pretended

Every one of these rendered a button, took a tap, showed a confirmation, and
sent nothing to the server.

| Control | Where | Was | Now |
|---|---|---|---|
| Mark delivered | order sheet | toast only — and offered from every state, so a **paid** order's only forward move skipped Preparing | **Fixed** — one step at a time, real `PATCH /orders/:id/status` |
| Reprint receipt | order sheet + ⋯ | toast only | **Fixed** — `POST /orders/:id/print`, reports the printer's real answer |
| Copy (ship-to, payment) | order sheet | toast said "Copied", clipboard untouched | **Fixed** — real clipboard write |
| Issue refund | order ⋯ | toast "Refund started" — on a money flow | **Removed** — a refund is full/partial and needs the chooser; desktop-only for now |
| Re-route order | order ⋯ | closed the menu | **Removed** |
| Save (product stock + price) | product sheet, `m.html` `sheetProduct` | toast "Saved" | **Still fake** — see §3 |
| Send reply (review) | reply sheet | toast "Reply sent" | **Still fake** — see §3 |
| Create (coupon / flash / broadcast) | create sheet | toast "Created" | **Still fake** — see §3 |
| Receive stock (PO) | purchase-order sheet | toast "Stock received" | **Still fake** — see §3 |
| Every settings + automation toggle | settings, delivery, operations | flips `state.sw[...]` in memory only; a reload undoes it | **Still fake** — see §3 |
| Sign out | account menu | toast "Signed out"; the session stays open | **Still fake** — see §3 |
| Search | topbar | a static list of five hardcoded results; the input does nothing | **Still fake** — see §3 |

---

## 2. Page by page

✅ on the phone · ⚠ present but fake · ✖ missing, worth adding · ➖ missing,
desktop is the right home

### Home (desktop: Dashboard, `03-dashboard.js`)

| Desktop capability | Phone |
|---|---|
| The Recap, real away-window figures | ✅ |
| Needs-you rows, deep-linked | ✅ (three rows; desktop has five fires) |
| Today's KPIs with deltas | ✅ |
| Unhandled-orders card (paid, nobody started) | ✖ — it is the same question the operator opens the phone to ask |
| Payment-mismatch fire (new, `a5ac97e`) | ✖ — add to Needs you |
| Low-stock drawer with per-store counts | ➖ |
| Activity feed ("Show the work") | ✖ — the Recap's fold is the brand's own affordance |
| Reports chapters | ➖ |

### Orders (`04-orders.js`)

| Desktop capability | Phone |
|---|---|
| Status + channel filter chips with live counts | ✅ |
| Row → record, full detail | ✅ |
| Forward transition, one step at a time | ✅ (fixed today) |
| Pickup relabelling (ready for pickup / picked up) | ✅ (fixed today) |
| Undo dispatch / delivery | ✅ (fixed today) |
| Print receipt | ✅ (fixed today) |
| Read-only marketplace mirrors carry no actions | ✅ (fixed today) |
| Mark paid, with the tender recorded | ➖ — a phone that guesses writes "unknown" to the books |
| Refund (full / partial chooser) + approve/reject a request | ✖ — refunds are a Needs-you fire; an operator on a phone is exactly who gets asked |
| Cancel + refund | ➖ |
| Edit ship-to address | ✖ — the most common phone-side correction |
| Tracking number entry / parcel split | ➖ |
| Staff note | ✖ — cheap, and it is how one operator tells the next what happened |
| Store filter (multi-store) | ✖ — the phone shows every store's orders with no way to narrow |
| Pagination | ✖ — the phone loads 50 and stops, silently |
| Search within orders | ✖ — see the search row in §1 |
| Bulk tracking paste, CSV export | ➖ |

### Customers (`08-customers.js`)

| Desktop capability | Phone |
|---|---|
| Segments with real counts, tier filter | ✅ |
| Roster with the unopened treatment | ✅ |
| Record: ordered / orders / avg, points, wallet, recent orders, addresses, diagnostics | ✅ (read-only) |
| Adjust points | ✖ |
| Top up wallet | ✖ |
| Block / unblock | ✖ |
| Message the customer | ✖ — the one that is genuinely phone-shaped |
| Edit profile, addresses CRUD | ➖ |
| Force logout, reset test account, CSV export | ➖ |

### Products (`09-products.js`)

| Desktop capability | Phone |
|---|---|
| Catalogue, stock activity, categories as sub-views | ✅ |
| Stock + price quick edit | ⚠ fake — the sheet exists and saves nothing |
| Category filter, search | ✖ (category filter only on desktop) |
| Add product (wizard or blank), options, variants, photos, bulk edit, reorder | ➖ |

### Inbox — Reviews + Feedback (`10-extras.js`)

| Desktop capability | Phone |
|---|---|
| Two lists, unseen marking | ✅ |
| Reply to a review / feedback | ⚠ fake — `PATCH /reviews/:id {reply}` and `POST /feedback/:id/reply` both exist |
| Hide / show a review | ✖ |

### Sales, Delivery, Settings

| Desktop capability | Phone |
|---|---|
| Channel board with live status | ✅ |
| Channel detail (mirror + config) | ✅ read-only |
| Delivery zones, fees, cut-off, couriers, pickup points | ✅ shown, ⚠ toggles fake |
| Every settings toggle | ⚠ fake — `PUT /api/retail-admin/config` exists |
| Sign out | ⚠ fake — `POST /api/backend/logout` exists |

---

## 3. What it would take

Ordered by what an operator loses today, not by effort.

| # | Build | Endpoint | Notes |
|---|---|---|---|
| 1 | **Reply to a review / feedback** | `PATCH /reviews/:id {reply}` · `POST /feedback/:id/reply` | One text field, one write. The most phone-shaped thing in the product. |
| 2 | **Product stock + price quick edit** | `PATCH /products/:id` | The sheet is already built and already says this is what it is for. |
| 3 | **Sign out** | `POST /api/backend/logout` | A control that lies about a session is its own kind of defect. |
| 4 | **Settings + automation toggles** | `PUT /api/retail-admin/config` | Read-modify-write of one config object; needs care not to clobber concurrent desktop edits. |
| 5 | **Refunds: approve / reject a request** | existing refund-review routes | Money. Needs the confirm + the amount, and the desktop's own guards. |
| 6 | **Orders: store filter, pagination, real search** | existing `/orders` params | The list quietly stops at 50 today. |
| 7 | **Customer: points, wallet, block** | existing per-customer routes | Each is a small modal on desktop. |
| 8 | **Staff note, edit ship-to** | existing order routes | Small, and both are corrections an operator makes while standing up. |

Nothing above needs a new endpoint. Every one of them needs the same three
states the rulebook already requires and the order actions now demonstrate:
the control disables and says what it is doing, a refusal renders where the
operator is looking and stays, and a toast confirms but never reports failure.
