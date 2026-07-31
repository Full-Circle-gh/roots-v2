# Tacet Orders — specimen matrices (status + refund)

**v1.3 · 2026-07-17 · derived from the Orders action survey (Claude Code), verified line-by-line against `origin/main`. Two decisions recorded — see §2 and §3. v1.3 adds §6 (worst-case row) and §7 (disable audit — skeleton, cells owed to a grep).**

> **What this is.** Every state an order can occupy and every state a refund can occupy — including the ones **no button produces**. This document exists because prose loses them and a mockup never shows them. Read it as the worst case, not the happy path.
>
> **How to use it.** Claude Design: every row here is a state that must render. A row whose *forward actions* cell says **none** is not an oversight — it is the specimen. Claude Code: this is the implementation surface; every cell carries a citation.
>
> **Standing rule (`tacet-desktop-patterns.md` §1.12):** every page ships all six states. These tables are the *populated* state's real contents.

---

## 1. Order status specimens

**Nine distinct status values** (`humanStatus`, `04:2363`). **Three are operator-unreachable** — the operator machine (`STATUS_TRANSITIONS`, `retail.js:20635`) cannot write them.

| # | Status | Reached by | Forward actions (drawer) | Operator can write? | Renders |
|---|---|---|---|---|---|
| 1 | `pending_payment` | **Checkout only.** The entry node — no button produces it. | — (customer may cancel) | ❌ | Entry state. Auto-cancels ~6h (`retail.js:6492`); superseded by a new checkout twin (`:6547`) |
| 2 | `paid` | `markOrderPaid` — WeChat/Alipay callback, ¥0 order, poll (`retail.js:4128–4129`) · Alipay OCR auto-verify (`:4564`) · restock promotion (`inventory.js:1256`) · **operator `Mark paid`** | `preparing` · **`dispatched`** · `refunded` · `cancelled` (`04:2414`) — **`dispatched` button shipped `b1bed6a5`, 2026-07-17** | ✅ | Server already permits `paid→dispatched`; three writers use it |
| 3 | `awaiting_restock` | **System only.** `markOrderPaid` when stock is short (`retail.js:4126`) | — | ❌ | **Specimen.** Absent from `STATUS_TRANSITIONS`. Leaves only via restock promotion → `paid` (`inventory.js:1256`) |
| 4 | `preparing` | Operator forward · `undoDispatch` from dispatched/delivered (`retail.js:21178`) · **`cancelJdPickup`** reverts dispatched→preparing (`:20624`) | `dispatched` · `refunded` · `cancelled` | ✅ | Undo target |
| 5 | `rider_pickup` | **Meituan channel only** (`meituan-internal.js:122`) | **none — client transition list is empty (`04:2408`)** | ❌ | **The specimen §5 named.** No forward action exists. Read-only channel mirror (`ordIsReadonlyChannel`, `04:104`). Yet the auto-deliver sweep *does* act on it (`retail.js:6075`) |
| 6 | `dispatched` | Operator forward · first parcel dispatch (`retail.js:18646`) · JD label create (`:20466`) · bulk tracking (`:20255`) · Qingyun pickup sweep (`:6218`) | `delivered` · `refunded` · `cancelled` · undo → `preparing` | ✅ | Pickup relabels this **"Ready for pickup"** (`NEXT_STATUS_PICKUP_LABELS`, `04:2436`) |
| 7 | `delivered` | Operator forward · all parcels delivered (`retail.js:18786`) · local-ETA sweep (`:6134`) · Qingyun drop-off sweep (`:6294`) · kd100 callback (`:20184`) · JD trace (`:9888`) · Meituan past-ETA (`meituan-internal.js:318`) | `refunded` · `cancelled` · undo → `preparing` | ✅ | Pickup relabels this **"Picked up"** (`NEXT_STATUS_PICKUP_LABELS`, `04:2436`). **Seven writers reach it; one is a button.** No customer confirm-receipt route exists |
| 8 | `cancelled` | Operator (`transition`, danger menu `04:3809`) · auto-cancel stale unpaid (`retail.js:6492`) · superseded twin (`:6547`) | — | ✅ | Terminal. Force-closes a stuck refund request → `refund_status='paid'` (`:21043`) |
| 9 | `refunded` | Operator danger menu — **re-routes through `openDirectRefundDialog`** (`04:4574`), not a plain status write · full refund approval (`retail.js:21443`) | — | ✅ | Terminal. The only status whose "button" opens a dialog instead of writing |

**What the table says that prose didn't:**

- **Three of eight statuses have no operator path in.** `pending_payment`, `awaiting_restock`, `rider_pickup`.
- **One of eight has no path out.** `rider_pickup` — no forward action, no undo, no danger-menu entry. It leaves only when a sweep moves it.
- **`delivered` has seven writers and one button.** Any design that treats the status row as *the* way orders move is describing ~15% of reality.

---

## 2. Refund state specimens

**Backend defines 7** (`retail.js:21269`). **Front-end models 6** (`04:5634`). The gap is a rendering bug, not a naming quibble.

`NULL → pending → reviewing → approved → paying → paid`, with `↘ rejected` and `↘ withdrawn`.

| # | State | Moved in by | Moved out by | Operator reachable? | FE models it? |
|---|---|---|---|---|---|
| 0 | `NULL` | Default | Customer request → `pending` · operator direct refund → `paying` | — | n/a |
| 1 | `pending` | **Customer only** — refund-request (`retail.js:15222`) | Operator review → `reviewing` · customer withdraw → `withdrawn` · cancel force-close → `paid` (`:21043`) | ❌ **in** / ✅ out | ✅ |
| 2 | `reviewing` | Operator `Start review` (`retail.js:21324`) | Approve → `approved` · reject → `rejected` · customer withdraw → `withdrawn` · cancel force-close → `paid` | ✅ | ✅ |
| 3 | `approved` | Operator approve (`retail.js:21403`). **Full approval also flips the order to `refunded`** (`:21443`, guarded `if (isFull && o.status!=='refunded' && o.status!=='cancelled')`). | Payout → `paying` · cancel force-close → `paid` | ✅ | ✅ |
| 4 | `paying` | Operator payout (`retail.js:21507`) · direct refund (`:21659`) · PATCH refunded/cancelled shortcut (`:20821`) | Success → `paid` · **gateway failure reverts → `approved`** (`:21530`) or → prior state (`:21671`, `:20837`) | ✅ | **❌ — see below** |
| 5 | `paid` | Payout (`retail.js:21550`) · direct (`:21713`) · PATCH shortcut (`:20863`) · cancel force-close (`:21043`) — **four independent writers** | **Re-enterable**: `/refund/direct` deliberately accepts `paid` for repeat partials (`:21610`) | ✅ | ✅ |
| 6 | `rejected` | Operator reject (`retail.js:21785`) | Terminal for this request. Customer may open a fresh `pending`. Direct refund can re-enter (`:21610`) | ✅ | ✅ |
| 7 | `withdrawn` | **Customer only** — withdraw from pending/reviewing (`retail.js:15261`) | Terminal. Direct refund can re-enter (`:21610`) | ❌ | ✅ |

### ✅ `paying` — found, specified, shipped (verified in code 2026-07-17)

**This section is now a record of a closed fix, not an open one.** Verified present in all four surfaces:

| Surface | Renders `paying`? | Line |
|---|---|---|
| `refundStepBadge` map | ✅ `'4. Paying · 退款中'`, Dusk tint + breathing dot (`dot: true`) | `04:5641` |
| `refundBadge` labels | ✅ `'paying · 退款中'` → renders `↩ paying · 退款中` | `04:311` |
| `drawerRefundBanner` labels | ✅ `{ en:'Refund paying out', cn:'退款打款中' }` | `04:359` |
| `renderRefundPanel` branch | ✅ no action buttons + "no action needed" note | fn `04:5654`, note `:5745` |

**🔴 Do not "fix" the missing buttons.** `paying` is deliberately excluded from `isTerminal` (`04:5659`) and gets `actions = ''` — it is neither actionable nor terminal. The panel shows *"Refund in progress … finishes on its own; no action needed"* and carries **the one Dusk breathing dot in the refund flow** — the brand's "the system is acting" signal. A future audit reading "no action branch" as a gap and adding buttons would be a regression, and would offer Approve/Payout while money is mid-flight.

**The history below is kept because it is the reason the fix exists** — the state was invisible in prose, absent from the FE, and no mockup would ever have included it.

**Backend wrote it. Front-end had no entry for it.** `refundStepBadge`'s map (`04:5634`) had six keys; `paying` was not one of them.

**`paying` is not decoration — it is the concurrency lock, surfaced as a state.**

The refund path cannot rely on request serialization the way the status path can, because it `await`s the WeChat gateway between check and settle. So it carries an **explicit atomic claim**:

```
UPDATE … refund_status='paying' WHERE COALESCE(refund_status,'') != 'paying'
if (claim.changes !== 1) return 409        ← retail.js:20819
```

That is a real lock, deliberately written. **The FE doesn't model the state because it was never told the lock existed.**

**Four render paths degrade when `paying` reaches the drawer** (all verified):

| Path | Line | Degrades to |
|---|---|---|
| `refundStepBadge('paying')` | `04:5633` | `map['paying']` undefined → returns `''` — **no step badge** |
| `refundBadge` | `04:307` | `labels[rs] \|\| rs` → prints raw **"paying"** |
| `drawerRefundBanner` | `04:345` | `{ en:'Refund · paying', cn:'' }` — **and note the `·`: see §1.11's DOM-walker** |
| `renderRefundPanel` | `04:5640` | `isOpen`/`isApproved`/`isTerminal` all false → **panel with no badge and no actions** |

- It is a **pure transient** — held only during the gateway call, never a resting state.
- But it is **not unobservable**: a WeChat push is a network round-trip, and a drawer open (or a poller repaint) during that window catches it.
- It is also the state a **failed** refund reverts *out of* (`:21530`). A slow or failing gateway *widens* the window.

**Fix scope — front-end only.** Backend writes and reads `paying` correctly: no schema change, no column, no server change. Four edits in `04-orders.js`:

1. **`refundStepBadge` map** (`04:5634`) — add `paying` with colour/bg + `labelEn`/`labelCn`.

   **✅ DECIDED 2026-07-17 — `paying` shares step 4 with `paid`. Do not renumber.**

   ```
   1. Requested   2. Reviewing   3. Approved   4. Paying → 4. Paid
   ```

   - `4. Paying` / `4. 退款中` — **`--td-dusk-tint` + breathing dot** (§1.10: Dusk-tint + breathing dot = the system is acting — and here it literally is).
   - Settles into `4. Paid` / `4. 已退款` — **`--td-sage-tint`**, dot stops breathing.
   - Same number, same slot. The badge changes state; the ladder does not.

   *Rationale: `paying` is a transient, not a step — steps are places you rest, and the operator never rests here. But it is not nothing (a failed refund reverts out of it), so it cannot hide inside Approved — Approved is where the Payout button lives, and the one job `paying` has is making clear that button is gone. Renumbering a shipped 1–2–3–4 ladder that lives in two languages, in operators' heads, and possibly in support docs costs more than the state is worth.*
2. **`refundBadge` labels** (`04:307`) and **`drawerRefundBanner` labels** (`04:345`) — add `paying` so both localize instead of echoing the literal.
3. **`renderRefundPanel`** (`04:5654`) — give `paying` its own branch: badge + a non-actionable "in progress" note, and **crucially no action buttons.** It must not offer Approve or Payout while money is mid-flight. Today it silently falls through to no-badge/no-action — which is the bug.
4. **Both language strings** (`Paying` / `退款中`), separate fields per §1.11 — never glued.

Then bump `sw.js` in the same commit.

**This is the exact §7 failure mode caught before it shipped:** invisible in prose, absent from the FE, and no mockup would ever include it.

### The other two specimens

- **`withdrawn` — no button produces it.** Customer-initiated, terminal, and operator-unreachable. Exactly as `tacet-desktop-patterns.md` §5 predicted. Its badge must exist anyway.
- **`paid` is not a sink.** Four writers land on it and `/refund/direct` re-enters it for repeat partials. Any design treating `paid` as terminal will break on the second partial refund.
- **No `failed` state and no `partial` state exist.** A partial refund is `paid` with `refund_amount_paid < total`. A failed gateway call reverts out of `paying`. Do not invent either.

*(Name collision: `retail.js:5064`'s `refund_status==='SUCCESS'` is WeChat's gateway namespace, not this column.)*

---

## 3. Transitions with no control

| Transition | Reachable by | Drawer button? | Evidence |
|---|---|---|---|
| `paid → dispatched` | Bulk tracking (`retail.js:20255`) · JD label create (`:20466`) · direct API | **✅ DECIDED — add one.** See below | Server `dispatched.prev: ['preparing','paid']` (`:20642`) |
| `* → rider_pickup` | Meituan ingest (`meituan-internal.js:122`) | **No** — and `STATUS_TRANSITIONS` cannot write it at all | `retail.js:20635` has six targets, no `rider_pickup` |
| `awaiting_restock → paid` | Restock promotion (`inventory.js:1256`) | **No** | Absent from `STATUS_TRANSITIONS` |
| `dispatched → preparing` | `cancelJdPickup` (`retail.js:20624`) — a *side effect* of cancelling a pickup | Not as a status control | Reads as an undo the operator didn't press |

**The sweeps operate over a wider status set than the PATCH endpoint accepts.** `AUTO_DELIVER_FROM_STATUSES = ['paid','preparing','dispatched','rider_pickup']` (`retail.js:6075`) includes a status `STATUS_TRANSITIONS` cannot write.

### ✅ Closed 2026-07-17 — `ship_pickup` / `fulfillment_type` cannot drift

**The owed item asked for a count: how many orders have `ship_pickup` set but `fulfillment_type` unset? The answer is zero, structurally — and the question could not have been answered by a query.**

**`ship_pickup` is not a database column.** It is a runtime flag assigned in exactly one place:

```js
// routes/retail.js:9375 — inside annotateShipTo (:9373)
if (r.fulfillment_type === 'pickup') { r.ship_pickup = true; return r; }
```

That is the only assignment anywhere; every other occurrence reads it. Readers treat the two as synonyms (`04:2336` — `if (o.ship_pickup || o.fulfillment_type === 'pickup')`). Since `ship_pickup` is *derived from* `fulfillment_type === 'pickup'` at read time, the drifted state the item feared **cannot exist**. There is nothing to query.

**Do not "pick one flag and delete the other."** The addendum's proposed fix assumed two stored fields. There is one stored field and one derived alias. Deleting the alias is a refactor with no correctness payoff; deleting the column is impossible.

**The lesson, and it's §7's again:** the owed item was written from a *reading of the readers* — code that says `o.ship_pickup || o.fulfillment_type === 'pickup'` looks exactly like defensive handling of two independent fields. It isn't. **A defensive-looking read is not evidence that the thing it guards against can happen.** One grep for the write settled what a count never could have.

---

## 4. What this means for the rebuild

**For Claude Design — the states you must render that a calm mockup omits:**

1. A `rider_pickup` order — **no forward actions at all**. Not a disabled button. Nothing. Read-only mirror styling (`04:3915`).
2. A refund panel in `paying` — needs a designed badge (currently renders raw text).
3. A refund panel in `withdrawn` — customer-initiated, terminal, no operator action.
4. An `awaiting_restock` order — system-only, waiting on stock.
5. A `paid` refund that can be **re-entered** for a second partial.
6. A `dispatched` **pickup** order — the label reads "Ready for pickup", not "Dispatched".

**For Claude Code:**

1. `paying` needs an FE badge entry + both language strings (`04:5634`).
2. `rider_pickup`'s empty transition list (`04:2408`) is **correct** — do not "fix" it by adding actions.
3. **✅ SHIPPED `b1bed6a5`, 2026-07-17 — `paid→dispatched` has a drawer button.** One data entry: `['dispatched', 'Mark dispatched · 标记已发货']` added to `NEXT_STATUS.paid` (`04:2414`), **inserted after `preparing`** — see the ordering finding below. Server untouched; `dispatched.prev: ['preparing','paid']` (`retail.js:20642`) already accepted it, and three writers already exercised it. The button only exposed a path that was live the whole time.

   **🔑 `NEXT_STATUS` has two consumers, and insertion order is load-bearing.** The desktop drawer renders every forward entry as a button. **The mobile card renderer (`retail-admin.html:11204`) reads the same data and takes only the *first* FORWARD match** (`forwardAction`, `:11205`). Insert `dispatched` *before* `preparing` and the phone's primary action for every paid order silently changes. Inserted after, mobile is byte-identical — `forwardAction` still returns `preparing`, and paid→dispatched is a desktop-drawer affordance only.

   **This is the "a manifest" failure shape.** The brief called `NEXT_STATUS.paid` a list of buttons. **It is shared data that two surfaces read differently** — one maps over it, one takes `[0]`. A summary hid the second consumer. *Never let a data structure be summarised into what one of its readers does with it.*

   **Every modifier the brief demanded was already carried by existing machinery** — none needed touching: pickup relabel via `nextStatusFor` + `NEXT_STATUS_PICKUP_LABELS` (`04:2436`, applied centrally at `:2439`); multi-parcel → "Mark all dispatched" (`04:4058`); read-only channels never reach it (`renderReadonlyOrder` early-returns at `04:4044`; `roChan` guards mobile at `:11315`); and the disable guard came free because forward buttons already route through the now-guarded `transition(id, next, event)` (`04:4063`). **The brief listed four things to carry; the machine carried all four.**

   **Note the three entries in `NEXT_STATUS.paid` are still not one mechanism.** `refunded` re-routes through `openDirectRefundDialog` (`04:4574`); `preparing` and `cancelled` PATCH status directly. Don't lump them.

   *Rationale: three writers already use this transition — bulk tracking (`:20255`), JD label create (`:20466`), and the direct API. It is not a forgotten edge case; it is the normal path for a merchant processing a batch by pasting tracking numbers. The transition is already part of how the product works and has been the whole time. It simply had no button. Constraining the server would have broken three working paths to enforce a rule the code was already ignoring.*

   **Carry the modifiers:** the new button must respect the same axes as the existing forward controls — **pickup relabels it** ("Ready for pickup", `NEXT_STATUS_PICKUP_LABELS` `04:2436`), and **read-only channel orders never get it** (`ordIsReadonlyChannel`, `04:104`; `renderReadonlyOrder`, `04:3915`).
4. Read-only channel orders must keep rendering at 100% legibility, 0% affordance (`tacet-desktop-patterns.md` A1).

**Rulebook amendment owed — `tacet-desktop-patterns.md` §1.12** currently says live Orders' primary status row is the control that doesn't disable while it writes. **Eight controls don't** (see the disable-audit specimen, owed separately). The rule is right; the receipt is understated.

---

## 5. 🟡 Double-click `Mark paid` — safe, for a fragile reason

**Verified: the cascade cannot double-run.** But *why* it can't matters more than *that* it can't.

`transition()` doesn't disable (fn `04:4562`, write `04:4602` — corrected from `04:4553` on 2026-07-17), so a fast double-click **does** fire two `PATCH /status {paid}` requests. They can't double-run the cascade because:

- **The paid branch has no `await` between the guard SELECT (`retail.js:20767`) and the UPDATE (`:20881`).** better-sqlite3 is synchronous; Node is single-threaded. The two requests **serialize.** The first flips `pending_payment→paid`; the second hits the guard at **`:20770`**, where `paid.prev = ['pending_payment']` no longer matches → **409 `invalid_transition`.**
- **Backstop:** every cascade helper is independently idempotent. `awardOrderPoints` bails on the `order_earn` marker row (`retail.js:23899`) · `commitOrderReservations` only commits `status='active'` reservations, so a second pass finds none (`inventory.js:430`) · `creditReferralReward` is guarded by `status='joined'` + `INSERT OR IGNORE` on `UNIQUE(order_id)` (`retail.js:14066`). `autoPrintOrder` / `sendWecomOrderAlert` are additionally gated `if (o.status !== 'paid')`.

**The load-bearing assumption:** nobody adds an `await` between `retail.js:20767` and `:20881`. If someone does, the guard stops serializing and safety falls back to helper idempotency alone.

**So the thing to protect is a comment at `retail.js:20767`, not the button.**

Two contrasts prove the codebase already knows this distinction:

| Path | Can it serialize? | Guard |
|---|---|---|
| **Status** (`paid`) | Yes — no `await` in the branch | Transition table + synchronous execution (`:20770`) |
| **Refund / cancel** | **No** — `await`s the WeChat gateway between check and settle | **Explicit atomic claim** → `refund_status='paying'` + 409 (`:20819`) |
| **Payment callback** | n/a | Structural: `UPDATE … WHERE id=? AND status='pending_payment'` + `if (r.changes>0)` (`:4125`/`:4134`) |

**§1.12 still wants the button to disable** — but for **double-submit feedback**, not double-write protection. The operator clicking twice and seeing nothing happen is a UX failure even when the data is safe. Different problem, same control.

---

## 6. The worst-case row — §1.10a made concrete

**One order, seven marks, four columns.** This is the row Claude Design must render before any Orders mockup is accepted. A status cell mocked with one pill is a status cell that hasn't been designed (§1.10a). **Every cell below is cited from the live row template — `04-orders.js:1057–1075`. Nothing here is survey prose.**

**The order:** paid, customer has requested a refund, the customer added to it after paying, one line is short on stock, fapiao not yet issued, the store is low on that SKU, and it arrived within the NEW window.

**The status cell as the code builds it** (`04:1072`):

```
<td class="status-cell">
  <div class="stack"> {status pill} {refundBadge} {addonBadge} </div>   ← 3 pills
  {stockPendingBadge}                                                    ← note-line, outside .stack
  {invoiceLine}                                                          ← note-line, outside .stack
</td>
```

| Mark | Column | Renders as | Line | Note |
|---|---|---|---|---|
| `Paid` | Status | **Pill 1 — primary**, in `.stack` | pill `04:3129`, label `humanStatus` `04:3154` | **Not always the raw status.** A live courier overrides it to "Finding a rider" / "On the way" (`04:3150–3151`). |
| `↩ refund req` | Status | **Pill 2**, in `.stack` | `refundBadge` `04:308`, `↩` at `:314` | **One of ~7 labels in this slot** — also `↩ reviewing` · `↩ approved` · `↩ paying` · `↩ part refund ¥X` · `↩ refunded` (`04:297, 305, 309–314`). Renders **regardless of the active status filter** (`04:284–286`). |
| `Updated · 加单` | Status | **Pill 3**, in `.stack` | `addonBadge` `04:1957` | 🔴 **Styled `pill st-paid`** (`04:1956`) — visually identical to the Paid pill. A Paid order shows **two green paid-looking pills**, one of which isn't a status. |
| `Stock pending` | Status | **Note-line 1**, outside `.stack` | `stockPendingBadge` `04:1969` | `.ord-note-line`, quiet, below the pills. |
| `Invoice to issue` | Status | **Note-line 2**, outside `.stack` | `invoiceLine` `04:332` | Same slot renders **"Invoice issued"** (muted) once done — the mark is present in both states. |
| `⚠ needs restock` | **Store** | Cell mark | `fulfillmentShortBadge` `04:1948`, placed `:1067` | Outside the status budget. |
| *routing note* | **Store** | Muted sub-line | `routingNote(...)` `04:1066` | **Sits above `⚠ needs restock`** — the Store cell carries two marks, not one. |
| `NEW · 新` | **Order #** | Chip, first `<td>` | `new-chip` `04:1059` | Outside the status budget. |

**The status cell resolves to exactly 3 pills + 2 note-lines — the §1.10a maximum, hit by the live code.** Not a hypothetical worst case: this is what the template produces.

**Row-level states, which are not cell marks but change the whole row:**
- `is-fresh` — transient arrival flash · `is-unread` — persistent bold/lit. Driven by `seen_at` / `isActionable` (`04:1044–1048`).
- `order-row--ro` — read-only channel rows (Meituan / gzgrocery) **suppress the NEW chip and the chime entirely** (`04:1053, 1058`).
- The **Delivery cell** (`renderDeliveryCell`, `04:1073`) carries its own marks — ETA, air-delay, dispatch-deadline. **A sixth badge-bearing column**, outside status-cell scope but inside per-row density.

**Two corrections this table makes to the §1.10a prose:**
1. §1.10a says the worst case is "~8 marks across three columns." The template says **7 marks across four columns** (Status ×5, Store ×2, Order# ×1) — and the Delivery cell can add more.
2. **The pill/note-line split is not a design choice — it's already built.** `.stack` holds the pills; `stockPendingBadge` and `invoiceLine` sit outside it. §1.10a's rule and the live DOM already agree. The rule isn't prescribing here; it's describing.

**For the brief, verbatim:** *"Render the §6 worst-case row from `tacet-orders-specimens.md`: three pills in the stack (Paid · ↩ refund req · Updated·加单) + two note-lines below (Stock pending · Invoice to issue), plus routing note and ⚠ needs restock in the Store cell, and the NEW·新 chip on the order number. Do not simplify it. Note that Updated·加单 currently ships styled identically to the Paid pill — fix that; two green pills where one is not a status is the §1.10 violation this row exposes."*

---

## 7. Disable audit — settled from the grep

**The doc said eight. The grep says the number is neither surface's count.** Orders has **6**; Customers has **7 controls / 8 call sites**. "Eight" matched Customers' *site* count by coincidence — the audit that produced it was almost certainly looking at Orders. Both numbers are below.

**Four failure shapes.** The model grew twice — each time because a grep found the previous model couldn't see the next one:

- **Shape A — no busy call at all.** The control never asks for a disable.
- **Shape B — `adminWrite` without `btn`.** The call site looks correct; the busy state silently never engages.
- **🔴 Shape B-variant — `adminWrite` with a `btnId` that doesn't exist in the markup.** `getElementById` returns null, the disable no-ops. **This one survives a grep for `btnId:`** — it looks guarded in *both* the code and the audit. It fails more quietly than B, which at least never pretended.
- **🔴🔴 Shape C — the button is passed, but it's `null` by the time it's read.** *Found 2026-07-17 while fixing the other three.* The house pattern is `adminWrite(..., { btn: ev?.currentTarget })` — read **inline, at the call**. `event.currentTarget` is nulled once dispatch ends, so **any handler that `await`s a confirm/reason dialog before its write passes null.** **All 12 controls fixed in this pass ran a dialog first.** The fix: capture `const btn = ev && ev.currentTarget` **synchronously at the top of the handler**, before any `await`, then pass the captured reference.

**Shape C is the worst of the four for auditing.** It survives a grep for `btnId:`, a grep for `btn`, *and* a reading of the call site — the code is idiomatic, matches the house pattern, and is wrong only because of when it runs. **It is invisible to every static check and visible only by tracing execution order.** A "fix" written from the spec alone (*"pass the button"*) would have produced Shape C on all 12 controls: a guard that looks right, greps right, reviews right, and does nothing. Claude Code caught this by reading the house pattern before applying it, not after.

**The rule that falls out:** *audit by whether the reference is live when it's read, never by whether the argument is present.* Each shape defeated the check that caught the one before it.

**Excluded — not failures.** Handlers that disable manually: `omSubmit` (`04:6457`), `rerunAlipayOcr` (`04:471`), `applySplitSuggestion` (`04:547`), `qyDispatch` (`04:3445`), `submitBulkTracking` (`04:5028`), the full-refund path (`04:5904`), and the reprint handler. All ~18 `adminWrite` calls that pass a real `btn` are fine.

### Orders — `04-orders.js` · 6 controls (4 A + 2 B)

| # | Control | Write | Line | Shape |
|---|---|---|---|---|
| 1 | `transition()` — Paid / Preparing / Dispatched / Delivered / Cancel | `PATCH /orders/:id/status` | `04:4602` (fn `:4562`) | **A** |
| 2 | `undoDispatch()` | `POST /orders/:id/undo-dispatch` | `04:4630` | **A** |
| 3 | `undoPreparing()` | `POST /orders/:id/undo-preparing` | `04:4670` | **A** |
| 4 | `markParcelDelivered()` | `POST /orders/:id/shipments/:sid/deliver` | `04:3505` | **A** |
| 5 | `combineParcels()` | `adminWrite POST /shipments/combine` | `04:595` | **B** |
| 6 | `splitParcels()` | `adminWrite POST /shipments/split` | `04:603` | **B** |

**#4 is the one the doc's "eight" missed** — same Shape-A pattern as transition/undo, but it sits far from them in the file.

### Customers — `08-customers.js` · 7 controls / 8 sites (1 A + 3 B + 3 B-variant)

| # | Control | Write | Line | Shape |
|---|---|---|---|---|
| 7 | `afReissueCode()` — Reissue (affiliate) | `POST /customers/:id/referral-code` | `08:1051` | **A** |
| 8 | `cuToggleBlock()` — Block | `adminWrite POST /customers/:id/block` | `08:1240` | **B** |
| 8b | `cuToggleBlock()` — Unblock (same control, other branch) | `adminWrite POST /customers/:id/unblock` | `08:1252` | **B** |
| 9 | `cuForceLogout()` — Sign out all devices | `adminWrite POST /customers/:id/force-logout` | `08:1271` | **B** |
| 10 | `cuDeleteAddr()` — per-address Delete | `adminWrite DELETE …/addresses/:aid` | `08:1460` | **B** |
| 11 | `cuSaveEdit()` — Save changes | `adminWrite PATCH /customers/:id` | `08:1218` | **B-variant** (`cu-edit-save` absent from markup) |
| 12 | `cuSaveAdjust()` — Apply adjustment | `adminWrite POST …/points-adjust` \| `/wallet-adjust` | `08:1312` | **B-variant** (`cu-adjust-save` absent) |
| 13 | `cuSaveAddr()` — Save address | `adminWrite PUT` \| `POST …/addresses` | `08:1441` | **B-variant** (`cu-addr-save` absent) |

Only `cu-new-save` (`retail-admin.html:3042`) and `cu-msg-send` (`:3065`) exist in the markup.

### What this changes

1. **Customers is in Batch 1** (patterns §4, row 4). Seven of these thirteen are on a page being rebuilt next — the audit isn't Orders-only work, and #11–13 must be fixed **in the markup or the call**, not by adding a disable that was already asked for.
2. **Shape B-variant defeats the obvious grep.** Any future audit that classifies by "passes `btnId`?" buckets three controls as safe. **Classify by whether the element exists**, not by whether the argument is present.
3. **The fix is one rule applied 13 times**, in four flavours: A gets a busy call; B gets `btn` passed; B-variant gets its id reconciled with the markup; **and all of them get the capture-before-await treatment or they become Shape C.**
4. §5's finding stands alongside: for `Mark paid` the disable is **feedback, not safety** — the data is already safe for a fragile reason worth a code comment at `retail.js:20767`.

### ✅ Shipped 2026-07-17 — all 13

**Commit 1 — `74c5f83d`** — the 12. Three ids · Shape B ×5 · Shape A ×4. `sw.js` v592.
**Commit 2 — `b078697a`** — `transition()`, the 13th. `ev` threaded through all three call sites (forward button, single danger button, and the danger menu via `orderDangerPick`). Disable sits after every early return, so an aborted dialog never strands a disabled button. `sw.js` v593.

- **The three ids** (`cu-edit-save` `:3019` · `cu-adjust-save` `:3091` · `cu-addr-save` `:3149`) — markup only, JS was already correct.
- **Shape B ×5** — `combineParcels`, `splitParcels`, `cuToggleBlock` (both branches), `cuForceLogout`, `cuDeleteAddr`. Each now takes a trailing `ev`, **captures `btn` before the confirm dialog**, passes it.
- **Shape A ×4** — `undoDispatch`, `undoPreparing`, `markParcelDelivered`, `afReissueCode`. These use `api()`, not `adminWrite`, so they keep their bespoke error handling and get a minimal manual guard. **Disable sits after the early-return branches** — a cancelled dialog never strands a disabled button.

**Both verified live on the box by grepping the deployed files** — not by trusting the deploy hook's exit code. That check earned its keep; see the deploy note below.

**The commit message for `b078697a` carries the `retail.js:20767` warning** — the one place the next person editing that server path will actually find it.

### 🔴 Two deploy findings from shipping this

**1 — ✅ The deploy race is closed (`ecbce2dd`, 2026-07-17). CI owns deploys.**

**Four strikes before the fix:** `94e38c7`, `4bb2f7b`, `74c5f83d`, `53910791`. The first three failed loudly at ship-to-stage — harmless, before install, never a half-installed box. **The fourth changed character:** the hook did not fail; its install step listed **only `sw.js`**, omitting the `04-orders.js` that was the commit's entire point, and reported success. The file was live via CI. **The hook's staged/install list is not a record of what was deployed, and looks exactly like one.**

**The first three trained everyone that the red text is noise. The fourth printed no red text at all.** A warning that is always wrong is bad; a report that is quietly incomplete is worse — nothing to ignore, so nothing to notice.

**🔑 The finding that decided it: the eslint gate never gated.** The rule was *"if the hook does real work CI doesn't, un-share `__stage__` — don't delete."* The hook **did** do one thing CI didn't: eslint. But `auto-push.sh` pushes — **firing CI's deploy** — *before* `deploy-changed.sh` runs eslint. So a lint error only ever aborted the redundant local `scp` **while CI shipped the commit anyway.** The gate the rule protected could not block a bad deploy and never had.

Everything that touches the server was already byte-identical: **both paths call the same `deploy-apply.sh`** (syntax-check → backup → pm2 restart → health probes → auto-rollback). That is *why* the hook could lose four races without breaking anything.

**So the fix wasn't to preserve a broken gate — it was to move eslint into CI, where it now genuinely blocks.** The false warning is dead *and* the bug-catcher is upgraded from advisory to gating.

**🔴 The tracked hook source was a trap, not just stale.** `scripts/post-commit.hook` had **no `auto-push.sh` line at all.** Re-installing from it stops commits reaching GitHub — CI never fires, nothing deploys, **and the failure is silent.** Now synced. This is `:1202` with teeth: a tracked artifact that looks authoritative, describes something the live system doesn't do, and breaks the system when believed.

**⬜ The lint gate is unexercised.** `ecbce2dd` was `[skip deploy]` with no `.js`. **The next real admin-JS commit is its live test.** It fails *closed* — deploy blocked, visible, fixable — which is the safe direction, but expect to see it.

**Break-glass preserved:** `scripts/deploy-changed.sh` stays on disk. To ship without GitHub, run it by hand — same `deploy-apply.sh` installer.

**2 — 🔑 The deploy hook re-stamps `sw.js`, and the standing rule doesn't say so.** The hook replaces the committed literal with a timestamp: `v593` shipped and the box now serves `roots-v2-shell-20260718-004023`.

**So the footgun rule — "admin JS needs `sw.js` in the same commit" — is right, but not for the reason it implies.** The literal is **not** the cache token. It is a **trigger**: changing it is what tells the hook to re-stamp. The stamp is what actually evicts stale admin JS.

**Why this matters:** the next person to check reads the rule, greps the box, finds a token that matches nothing in the source, and concludes the rule is broken or the deploy is. It isn't. **Write the mechanism, not the ritual** — a rule that states *what to do* without *why* is one survey away from being "corrected" into a bug. Same shape as §1.11's walker: the over-warning was safe until someone acted on it.

**🟡 Decision — `cuToggleBlock` and `cuForceLogout` took the manual-disable pattern, not `adminWrite`'s.** They're icon+text menu items and `adminWrite` sets `textContent = '…'`, which destroys the SVG. Invisible on success (the menu is closed, and the action bar re-renders). **But on the error path `adminWrite`'s `finally` restores text only** — reopening the menu after a failed block shows the item icon-less until the next re-render. *Rationale: block and force-logout are the two most consequential controls on the page, and the error path is exactly when the operator is looking. A control that returns cosmetically broken after a failed write is worse than the 2-line divergence.* Text-only controls (combine/split/delete) keep `adminWrite`.

### ✅ `transition()` — shipped `b078697a`

Fn `04:4568`, write `04:4602`. **The highest-traffic write in the product** — every forward status move plus full-refund and cancel. Shape A pattern (capture-before-await + manual disable). **Three call sites, none exported, all threaded:**

| Site | What | Done |
|---|---|---|
| `04:4063` | Forward-status button (Mark paid / preparing / dispatched) | `, event` |
| `04:3792` | Single-option danger button (Refund / Cancel + refund) | `, event` |
| `04:3826` | `orderDangerPick(id, next) → transition(id, next, ev)`, itself the onclick of multi-option danger items (`04:3795`) | `ev` threaded through `orderDangerPick` — the two-hop path is covered |

**Recorded in the commit message, because it will be forgotten:** `transition()`'s disable is **feedback, not safety** (§5). The data is already safe for a fragile reason — there is no `await` between the guard SELECT (`retail.js:20767`) and the UPDATE (`:20881`), so two requests serialize and the second 409s. **If anyone ever adds an `await` there, that serialization breaks and this button becomes the only guard.** The commit message is where the next person editing that server path will actually see it — the doc is not.

---

## 8. Customers — findings, 2026-07-17

> **These specimens are one business's live production rows** (Roots), used as **evidence that a mechanism behaves a certain way** — not as Tacet reference data or product examples. Customer names are withheld; ids and amounts are kept only where they are the evidence. The ¥ figures are that business's currency, not the product's (`docs/tacet-consolidation-decisions.md` §0).

Surveyed from the live box (`roots.db`, 626 customers / 469 orders). **Customers is Batch 1** and carries 7 of the 13 non-disabling write controls (§7).

### 🔴 Test data — ignore `asher` (customer 233)

**`asher` is Ash's own test account** from early app testing. Its numbers are not data: ¥1,430 cached vs ¥790 live across 53 orders. **Any survey that finds a large multi-order spend gap and chases it is chasing a test.** Recorded here because this is exactly how a stale finding survives — the gap is real, the meaning isn't.

### The two numbers — both correct, one label

**The list's "Total spent" and the drawer's "lifetime" are different measures wearing the same word.**

- **List** — cached `lifetime_spend` column (`08:365`), sorted on (`retail.js:13116`). **Order value.**
- **Drawer** — live-computed `revenue`, SUM of non-cancelled/refunded/pending order totals (`retail.js:13253`, rendered `08:787`). **Cash actually paid.**

**145 of 626 diverge — and that is exactly the set of customers with any spend.** The 481 that agree are all zero-on-both-sides. So the two numbers disagree for **100% of customers where the number matters.**

**Why — and it is not a bug.** Verified against customer 427 on live data:

| | Cached (list) | Live (drawer) |
|---|---|---|
| Migrated in from OUT1N with 1,155 points | — | — |
| Order 322: ¥1,124 of goods, **paid with 1,134 points** | **¥1,124** | **¥0** |

The points ledger says it plainly: `Order_redeem −1134` and `Order_earn +0 — "earn base ¥0.00, below earn threshold"`. Customer 427 received ¥1,124 of goods and paid no cash. **Both numbers are honest.** Same shape: id 104 (¥709/¥0), id 85 (¥414/¥0).

The other direction — **101 customers where live > cached** — is the cache lagging: orders paid/preparing/dispatched are counted live but not yet folded into `lifetime_spend`, which only increments at the award event (`retail.js:23922`).

**⚠️ A prior draft of this section called the 44 cached-over-live customers "over-tiered on spend that no longer exists" and framed the split as refunds. That was wrong.** Nothing was refunded. The migration-credit cause was in the survey and got read past. **Ash found it by opening the points ledger.** The greps find what exists; only Ash finds what's reachable — again.

**What follows from it:**
1. **Tier derives from the cached column** (`tierFromSpend`/`reconcileTier`, `retail.js:6654`). Points-paying customers are tiered on order value, not cash. **That is a policy question, not an error** — OUT1N points were an inherited liability; those customers did pay, on the old platform.
2. **"Total spent" sort ranks on cached** (`retail.js:13116`) — the top-spenders view is by order value.
3. **The design fix is the label, not the data.** Two measures need two words. Operator-facing wording is Ash's call; the requirement is that the list and the drawer stop sharing "spent."

### Settled, cheap

- **Three missing ids — a two-minute fix, proven safe.** `cuSaveEdit`/`cuSaveAdjust`/`cuSaveAddr` pass `btnId`s (`cu-edit-save`/`cu-adjust-save`/`cu-addr-save`) that exist nowhere in the markup; the buttons are id-less at `retail-admin.html:3019`, `:3091`, **`:3149`**. `cuShowModal` (`08:1068`) uses `appendChild`, which **moves** and never clones, and is guarded to run once — so a static id is safe. Proven by `cu-new-save` (`:3042`) and `cu-msg-send` (`:3065`), which use this exact pattern and disable correctly today. **Add three ids.**
- **Empty ≠ no-results — not distinguished.** One branch, `if (!rows.length)` (`08:339`), renders `"No customers found. · 未找到客户。"` (`08:340`) for both. Violates §1.12. Loading is `"Loading…"` (`08:322`) — **English-only, unlike its bilingual siblings**, and duplicated in static markup (`retail-admin.html:2973`).

### 🟡 The middot hazard is unshielded — safe by data, not by design

Customer nicknames and address recipients carry **no `data-no-i18n`**: list `.nm` (`08:355`), drawer `.cux-name` (`08:855`), address recipient (`08:760`), address phone (`08:761`).

`Liana Anthony 利安纳安东尼` (customer 415) survives **only because it has a plain space, not `" · "`** — `processNode` requires space-middot-space (`retail-admin.html:10541`). Confirmed on live data: **0 of 626 nicknames and 0 recipient names contain `" · "`**; 19 are the Latin-space-Chinese shape and all pass through.

**The code already knows about this hazard.** It deliberately shields the *constructed* `"Customer #id · joined …"` eyebrow (`08:852`) precisely because it contains a middot. **Constructed bilingual strings get shielded; free-text user fields don't.** A customer who types a middot into their WeChat nickname gets their name silently half-blanked. **It has not happened yet. That is a data accident, not a guarantee.**

---

*v1.9 · 2026-07-17 · §1–5 cited and verified · 2 decisions recorded · idempotency answered (§5) · §6 worst-case row cited from the live template `04:1057–1075` · §7 disable audit: 13 controls, 3 shapes · §3 `ship_pickup` closed — a derived flag, not a column · **§8 Customers added** — the two-numbers finding, `asher` marked as test data, three missing ids, empty≠no-results, the unshielded middot hazard.*

**🔴 Line numbers in this document drift, and re-anchoring does not fix it.** Re-anchored at v1.4; **drifted again by v1.6, in the same session.** `NEXT_STATUS.paid` `2410→2414` · `NEXT_STATUS_PICKUP_LABELS` `2424→2436` (2424 is now an unrelated comment) — because this session's own commits moved the file. Earlier the drift was transcription (v1.4 corrected `5625→5634`, `5637→5654`, `350→345`, `4553→4562`, `3160→3149`); **now it is the code changing under the doc.**

**So the rule is not "re-anchor carefully." It is: a line number in this document is a hint, never an address.** Claude Code re-read every ref before touching it on all three commits today and caught drift each time. **That habit is the control — not the accuracy of these numbers.** Never transcribe a citation from here into a brief without re-reading the file. Cite the *symbol* (`NEXT_STATUS.paid`, `refundStepBadge`) — the name survives what the number doesn't.

**Function and structure names in this doc have never been wrong. Only the numbers have.**

**v1.6 — all 13 disables shipped** (`74c5f83d`, `b078697a`), verified live by grepping the box. **Two deploy findings recorded in §7:** the shared-stage race fired a **third** time (three identical, three harmless — a standing bug whose workaround is a manual check on every deploy), and **the deploy hook re-stamps `sw.js`**, so the committed literal is a *trigger*, not the cache token. The footgun rule was right and its stated reason was wrong.

**v1.5 — the fourth shape.** §7's model grew from two to four in one session, each time because a grep couldn't see the next one. **Shape C** — the button passed but `null` when read — was found *while fixing the other three*: every one of the 12 controls `await`s a confirm dialog before its write, so the house `btn: ev?.currentTarget` inline form would have passed null on all of them. **A fix written from the spec alone would have produced 12 guards that look right, grep right, review right, and do nothing.** 12 of 13 shipped (`sw.js` v592); `transition()` approved and owed.

**v1.9 — the deploy race is closed** (`ecbce2dd`). CI owns deploys; the local hook only pushes. **The deciding finding: the eslint gate never gated** — `auto-push.sh` fired CI's deploy *before* the local eslint ran, so a lint error aborted only the redundant `scp` while CI shipped anyway. The rule said "un-share, don't delete, if it does real work CI doesn't." It did do one thing CI didn't — and that thing was already broken. **Checking whether the unique work actually works is the step the rule didn't have.** eslint moved into CI where it now blocks; false warning dead, bug-catcher upgraded. **The tracked `scripts/post-commit.hook` was a trap** — no `auto-push.sh` line at all, so a re-install would silently stop every deploy. Synced.

**v1.8 — the deploy race escalated.** Fourth strike (`53910791`): the local hook **did not fail loudly** — its install step listed only `sw.js`, omitting the `04-orders.js` that was the commit's entire point, and reported success. CI deployed the file correctly. **The first three trained everyone that the red text is noise; the fourth prints no red text at all.** The hook's staged/install list is not a record of what was deployed and looks exactly like one. Grepping the box caught it, as it has every time today.

**v1.7 — `paid→dispatched` shipped** (`b1bed6a5`). One data entry; every modifier the brief demanded was already carried by existing machinery. **The finding is `NEXT_STATUS`'s second consumer:** the mobile card renderer (`retail-admin.html:11204`) reads the same array and takes only `[0]`, so **insertion order is load-bearing** — `dispatched` went after `preparing` to leave mobile byte-identical. The brief called it "a list of buttons." It is shared data two surfaces read differently. **"A manifest," again.**

**Orders status, 2026-07-17 — closed.** Design **final** (no v2 — the page is done). Code: `paying` shipped · all 13 disables shipped (`74c5f83d`, `b078697a`) · `paid→dispatched` shipped (`b1bed6a5`). **Nothing on Orders is owed.** `paying`'s missing action buttons are **the design** and must not be "fixed."***
