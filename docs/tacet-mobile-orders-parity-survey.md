# Orders — what the phone cannot do that the desktop can

**2026-09-10 · Read-only survey. One page: Orders. Read `public/m.html` (the phone
build `server.js` serves to every mobile browser) against `public/retail-admin/04-orders.js`
and the routes both of them call in `routes/retail.js`. Every claim is cited to a
file and a line in the working tree at `origin/main` = `29444c2`. No code was
changed. This document reports; the staging in §5 is a proposal, not a decision.**

> Line numbers are from `29444c2`. Find the code by NAME — the function, the
> route string — and re-cite what you actually find. Two of the "decided, stays
> on desktop" rows in `docs/tacet-mobile-parity.md` are stale for exactly this
> reason: the reason they gave has since stopped being true (§3).

## Why this survey exists at all

`docs/tacet-mobile-parity.md` (2026-08-22) audits the same page and closes it.
It closes it against a **different rule**, stated in its own §"How the two
surfaces differ by design": *"The phone is deliberately not the desktop … a
missing capability is only a defect when it is part of that loop."* Under that
rule most of what follows is not a gap; it is a decision.

**Ash's instruction on 2026-09-10 is the opposite rule** — *"mobile version
functionality should be the same as PC"*. This survey re-reads Orders under the
new rule, so every `➖` in the old document is re-opened and re-counted as a gap
rather than a design choice. **The rule change itself is Ash's and is recorded
in `docs/tacet-consolidation-decisions.md` §97**, which retires the old rule
rather than deleting it: every `➖` in the old document stays where it is, and
what changes is that it now reads as an open gap rather than a settled one.

What the old audit got right is not re-litigated: the list row carries the
desktop's ten columns, the drawer carries its sections, the filters are
server-side, and the writes that existed were proven on the request. This is
about the **actions the phone has never had**.

---

## 1. The status machine — the phone is missing six of the desktop's transitions

Desktop `NEXT_STATUS` (`public/retail-admin/04-orders.js:3391`) against the
phone's `ORDER_NEXT` (`public/m.html:11289`), which offers **at most one forward
step per status** by construction — `orderNext` returns a single object, and
`orderActionRow` (`public/m.html:12737`) draws one primary button from it.

| Order sits at | Desktop offers | Phone offers | Missing |
|---|---|---|---|
| `pending_payment` | Mark paid, **Cancel** | Mark paid | Cancel |
| `paid` | Start preparing, **Mark dispatched**, **Refund**, **Cancel + refund** | Start preparing | 3 |
| `preparing` | Mark dispatched, **Refund**, **Cancel + refund** | Mark dispatched | 2 |
| `dispatched` | Mark delivered, **Refund** | Mark delivered | Refund |
| `delivered` | **Refund** | — | Refund |
| `awaiting_restock` | Restocked → preparing, **Cancel + refund** | Restocked → preparing | Cancel + refund |
| `rider_pickup` | — (platform drives it) | — | none |

**In one line: the phone cannot refund an order, and cannot cancel one.** Not
from any status. `sheetActions` (`public/m.html:12783`) offers Approve / Reject /
Pay a refund the **customer** requested, which is a different act — it moves a
request the customer opened. Nothing on the phone opens one.

Two guards ride on those transitions on the desktop and have no phone
equivalent:

- **The early-dispatch warning.** `transition()` asks before dispatching an
  order whose requested timing is still in the future
  (`04-orders.js:7048`, rules in `earlyDispatchWarning`, `04-orders.js:7017`).
  The phone dispatches with no question — the string "early" appears nowhere in
  its Orders code.
- **The cancellation reason.** `transition()` prompts for one and PATCHes it as
  `reason` (`04-orders.js:7073`). A phone Cancel that skipped it would add to
  the blank-reason population already flagged in another session's notes.

Also absent: **Undo preparing** (`undoPreparing`, `04-orders.js:7159`, gated by
`undoPreparable`, `:7188`). The phone has Undo dispatch / Undo delivery and
stops there, so a mis-tapped "Start preparing" has no way back.

---

## 2. Endpoints the desktop calls and the phone never does

Every route below exists and is live. The phone's whole Orders vocabulary is
ten calls (`grep "'/orders/'+" public/m.html`): the record, `status`,
`undo-dispatch`, `print`, `air-delay/ack`, `shipments/:sid/dispatch`,
`refund/approve`, `refund/reject`, `refund/payout`, `delivery-track`.

| Capability | Route (`routes/retail.js`) | Desktop caller (`04-orders.js`) |
|---|---|---|
| Staff note on an existing order | `PATCH …/note` **:29799** | `staffNoteBlock` :2858, `ordNoteSave` :2889 |
| Undo preparing | `POST …/undo-preparing` :30404 | `undoPreparing` :7159 |
| Mark one parcel **delivered** | `POST …/shipments/:sid/deliver` :26572 | `markParcelDelivered` :5423 |
| Partial / line-level refund | `POST …/refund/direct` :30779 | `openDirectRefundDialog` :8379 |
| Refund review (amount before approve) | `POST …/refund/review` :30499 | `refundReview` :8331 |
| Refund history | `GET …/refund/events` :30999 | `openRefundEvents` :8825 |
| Tracking number: set / clear / resubscribe | `PUT …/tracking` :28666, `DELETE` :29446, `POST …/tracking/resubscribe` :29266 | `saveTracking` :7979, `clearTracking` :8031, `resubscribeTracking` :7565 |
| Local ETA: set / clear | `PUT …/eta` :29486, `DELETE` :29514 | `saveLocalEta` :8075, `clearLocalEta` :8093 |
| Parcels: combine / split / method | `POST …/shipments/combine` :25967, `…/split` :26027, `…/shipments/:sid/method` :26515 | `combineParcels` :835, `splitParcels` :844, `setShipmentMethod` :8113 |
| Apply the split suggestion | `POST …/shipment-suggestion/apply` :25907 | `applySplitSuggestion` :788 |
| Tell the customer again | `POST …/renotify` :25693 | `ordRenotify` :2842 |
| Issue the fapiao | `PUT …/invoice` :25759, `POST …/invoice/finalize` :25826 | (invoice block, `invoiceLine` :518) |
| Ship-to: edit / to Chinese | `POST …/address/to-chinese` :26204, `…/address/apply-chinese` :26274 | `openAddressToChinese` :859, `openEditShipTo` :973 |
| Re-read the Alipay proof | `POST …/alipay-ocr/rerun` :30340 | `rerunAlipayOcr` :713 |
| JD waybill: create / cancel / print | `POST …/jd-waybill` :29300, `…/jd-waybill/cancel` :29540, `GET …/jd-waybill/print-data` :30302 | `submitJdLabel` :7791, `cancelJdPickup` :7885, `printJdLabel` :7743 |
| Qingyun local delivery — ten routes | `…/qingyun/*` :26852–:27839 | `renderQyDispatch` :4426 and the `qy*`/`qp*` family |
| Meituan action | `POST …/meituan-action` :25725 | (11-meituan.js) |
| Bulk tracking paste | `POST /orders/bulk-tracking` :29170 | `openBulkTracking` :7491 |
| CSV export | `GET /orders/export.csv` :24974 | `ordExportCsv` :1486 |

---

## 3. Two "decided: desktop only" rows whose reason has expired

`docs/tacet-mobile-parity.md` justifies each `➖` with a reason. Two of those
reasons are no longer facts about the tree, which matters more than the rows
themselves — a decision recorded with its reason can be re-opened when the
reason goes; one recorded bare cannot.

1. **"Staff note — no endpoint edits an existing order's note; it is written at
   creation only. Backend work, not a screen."** `PATCH /api/retail-admin/orders/:id/note`
   exists (`routes/retail.js:29799`), takes `staff_note`, caps it at 2000 chars
   and logs the activity. The backend work is done. The phone already collects a
   staff note when it **creates** an order (`public/m.html:5431`) and has no way
   to read or change one afterwards — the drawer renders no staff-note block at all.

2. **"Refund: partial / line-level amounts — editing lines is desktop work."**
   True as far as it goes, but it is filed under a heading that says approving is
   supported, which hides the larger fact in §1: **no refund can be started from
   the phone at any amount.**

The remaining `➖` reasons (address editing behind Chinese address matching;
parcel packing decisions; authoring) still describe the tree accurately. Under
the new rule they are still gaps — they are just gaps with a good argument
attached, and that argument is now Ash's to overrule, not a session's.

---

## 4. List-level features with no phone equivalent

The phone's Orders list is at parity on **filtering** — status, channel, `q` and
`store_id`, all server-side, same four params as `ordFilterQuery`
(`04-orders.js:1365`) — plus pagination the desktop does differently. What it
has no form of:

| Desktop | Where |
|---|---|
| The KPI band above the list | `ordLoadKpis` :1081, `ordRenderKpis` :1099 |
| Select rows → bulk status change | `ordSelectableRows` :1228, `ordBulkStatus` :1309 |
| Saved views (name a filter set, share it) | `ordViewRead` :1430, `ordViewApply` :1438 |
| CSV export | `ordExportCsv` :1486 |
| `customer_id` scope ("View all N orders") | `ordViewCustomerOrders` :45 |
| Order drafts on the New order form | `ordDraftsOpen` :9804 |
| Sort the items inside an open order | `setItemsSort` :3723 |
| New-order sound + tab-title badge | `toggleOrdersSound` :1818, `_paintOrdersBadge` :1786 |

The phone counts unseen orders (`/orders/unseen-count`) and badges the tab, so
the *notification* half of that last row exists; the sound and the title badge
do not, and a title badge is meaningless in a standalone PWA.

---

## 5. Proposed staging — for Ash to confirm, not decided here

One PR per group, in this order. The first is the one that changes what an
operator can do standing in the shop; the last is desk work that happens to be
missing.

**A. The refund and cancel half of the status machine.** §1 in full: Cancel,
Cancel + refund, Refund from all five statuses that offer it, the direct-refund
amount chooser (`refund/direct`), the cancellation-reason prompt, the
early-dispatch warning, and Undo preparing. Largest single gain; touches
`ORDER_NEXT`, `orderActionRow`, `sheetActions` and adds three ask-sheets.

**B. The staff note.** Read and write in the drawer against `PATCH …/note`.
Small, self-contained, and closes the stalest row in the old audit.

**C. Parcel completion.** Mark a parcel delivered, set its method, and the
tracking-number trio (set / clear / resubscribe) — the phone already dispatches
a parcel, so this is the rest of one card.

**D. Local ETA, renotify, Alipay OCR rerun.** Three small independent writes.

**E. The desk work**, each its own PR and each arguably still desktop: invoice
issuing, address editing + to-Chinese, parcel split/combine, JD waybill,
Qingyun, bulk tracking, CSV export, saved views, bulk status, KPI band.

**What is NOT proposed:** porting the courier map, the Qingyun point-picking map
surfaces and the JD label printer component to the phone as-is. Those are three
map/print integrations with desktop-shaped UI; if they are wanted on the phone
they need a phone design first, which is a separate question from parity.

Every write added under any of these is asserted on the **request** — the
endpoint, the method and every field of the body — in `scripts/test_mobile_orders.js`,
which is the standing rule in this app for a reason recorded twice in the old
audit.
