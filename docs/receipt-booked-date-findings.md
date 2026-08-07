# Receipt: missing booked date — survey findings

**Question.** Order TC000180 shows `Booked Aug 10 · in 3d` in the admin order
drawer. The printed thermal slip for the same order shows no booked/reservation
date at all. Why?

**Scope.** Survey only — no code changed. All line references are against
`origin/main` @ `7ff831b`.

**One caveat stated up front.** This checkout has no database file (no `*.db` /
`*.sqlite*` anywhere in the tree), so TC000180's actual column values could not
be read. Everything below is derived from code. Where a claim depends on the
row's real values, it is marked **inferred** and the exact values that would
produce the reported symptom are named, so the inference can be checked with one
query.

---

## 1. The print template

The print path lives in `lib/feie.js`. There are three operator-selectable
templates (`TEMPLATES`, `lib/feie.js:491-639`, exposed as `TEMPLATE_IDS` at
`lib/feie.js:748`) plus two fixed non-selectable slips.

### Every date/time line the slip can emit

| # | Template | Line | Label string | Source field | Guard |
|---|---|---|---|---|---|
| 1 | `receipt` | `lib/feie.js:499` | `Time  ` | `o.paid_at \|\| o.placed_at` | none — always prints |
| 2 | `receipt` | `lib/feie.js:500` → `pushShipBy` | `Pickup 自提` / `Arrives 预计送达` / `Deliver 送达` | see §1.2 | `shipByPrintParts(o)` non-null |
| 3 | `packing` | `lib/feie.js:572` | *(no label — centered)* | `o.paid_at \|\| o.placed_at` | none — always prints |
| 4 | `packing` | `lib/feie.js:577` | `MAKE FRESH 当天现做 ` | `o.promised_ship_date` | `if (o.promised_ship_date)` |
| 5 | `packing` | `lib/feie.js:578` → `pushShipBy` | same three as #2 | see §1.2 | `shipByPrintParts(o)` non-null |
| 6 | `compact` | `lib/feie.js:626` | *(no label — centered)* | `o.paid_at \|\| o.placed_at` | none — always prints |
| 7 | `renderAddon` | `lib/feie.js:674` | `Time  ` | `o.addon_paid_at` | `if (o.addon_paid_at)` |
| 8 | `renderRefundRequest` | `lib/feie.js:707` | `Time  ` | `o.refund_requested_at` | `if (o.refund_requested_at)` |

**No line anywhere in `lib/feie.js` is labelled "Booked".** The nearest
equivalent is `Deliver 送达` (#2/#5). That is a wording difference, not the
reported fault — the reported fault is that *no date at all* prints.

Also worth recording: **`channel_preorder_at` is never referenced in
`lib/feie.js`.** A full grep of the file for every candidate date column returns
hits only for `paid_at`, `placed_at`, `addon_paid_at`, `refund_requested_at`,
`scheduled_for`, `delivery_slot_label`, `delivery_slot_kind`,
`promised_ship_date`, `promised_delivery_date`.

### 1.2 `pushShipBy` and its guard chain

`pushShipBy` (`lib/feie.js:479-485`) prints nothing and returns `false` when
`shipByPrintParts(o)` returns `null` (`lib/feie.js:480-481`). All of the
decision lives in `shipByPrintParts` (`lib/feie.js:404-448`), in order:

| Step | Line | Condition | Result |
|---|---|---|---|
| 0 | `:411` | `isCounter(o)` | **`null` — nothing prints** |
| 1 | `:413-416` | `o.fulfillment_type === 'pickup'` | `Pickup 自提` + window from `slotValue(o.delivery_slot_label, o.scheduled_for)`; `null` if that resolves empty |
| 2 | `:420-423` | `o.promised_ship_date` truthy | `Arrives 预计送达` + `~` + `promised_delivery_date` (falling back to `promised_ship_date`) |
| 3 | `:430-438` | `explicitDate \|\| !isAsap` | `Deliver 送达` + `slotValue(o.delivery_slot_label, o.scheduled_for)` |
| 4a | `:442` | `kind === 'right_away'` | `Deliver 送达` + `Right away 立即配送` |
| 4b | `:447` | *(fallthrough)* | **`null` — nothing prints** |

The step-3 predicate is the one that matters (`lib/feie.js:430-435`):

```js
const kind = o.delivery_slot_kind;
const explicitDate = (kind === 'schedule' || kind === 'today');
const isAsap = kind === 'express' || kind === 'right_away' || kind === 'restock'
  || !o.scheduled_for
  || (kind == null && isGzMidnight(o.scheduled_for));
if (explicitDate || !isAsap) { … }
```

`isGzMidnight` (`lib/feie.js:317-324`) shifts the stored timestamp by +8h and
returns true when the Guangzhou wall-clock lands on `00:00`.

**So a slip prints no date whenever `delivery_slot_kind IS NULL` *and*
`scheduled_for` sits at GZ midnight** — `isAsap` is true, `explicitDate` is
false, step 3 is skipped, step 4a doesn't match, and `:447` returns `null`.
That combination is the whole finding; §3 and §4 show why the drawer does not
share it.

---

## 2. The booked value — what actually gets written

### 2.1 Where the six columns come from

| Column | Declared | Written by |
|---|---|---|
| `scheduled_for` | `database.js:2490` | checkout INSERT, `routes/retail.js:9864` |
| `delivery_slot_label` | `database.js:2491` | checkout INSERT, `routes/retail.js:9864` |
| `delivery_slot_kind` | `database.js:2856` | checkout INSERT, `routes/retail.js:9864` |
| `promised_ship_date` | `database.js:2846` | post-INSERT UPDATE, `routes/retail.js:10111` |
| `promised_delivery_date` | `database.js:2847` | post-INSERT UPDATE, `routes/retail.js:10111` |
| `channel_preorder_at` | `database.js:2737` | platform ingest only, `routes/meituan-internal.js:231`, `:381` |

### 2.2 Trace: checkout slot selection → `POST /api/retail/orders`

Handler starts at `routes/retail.js:8993`.

1. `deliverySlotId = body.delivery_slot_id` (`routes/retail.js:9041`).
2. `resolveDeliverySlot(zone, deliverySlotId, new Date())`
   (`routes/retail.js:9694`) returns `scheduled_for`
   (`routes/retail.js:9698`). Inside it (`routes/retail.js:26355-26413`) the
   slot id has two shapes:
   - `YYYY-MM-DDTHH:MM` → `dt` carries a real time (`routes/retail.js:26377`);
   - `YYYY-MM-DD` → **`dt` is built at midnight** (`routes/retail.js:26404`:
     `new Date(y, m-1, d, 0, 0)`), which is the GZ-midnight sentinel §1.2
     tests for. This is the branch for a day-only chip *and* for any
     schedule-for-later calendar pick (`routes/retail.js:26363-26367`).
3. `slotLabel` = client label, else the slot's `label_en`, else `'Right away'`
   (`routes/retail.js:9700-9702`).
4. `slotKind` (`routes/retail.js:9720-9722`):
   ```js
   const slotKind = isPickup ? 'pickup'
     : isWaitFlow ? 'restock'
     : (body.delivery_slot_kind || (deliverySlotId === 'right_away' ? 'right_away' : null));
   ```
   `body.delivery_slot_kind` is `''` from both live clients when the customer's
   pick has no derived kind — `public/shop.html:2727`
   (`delivery_slot_kind: co.slotKind || ''`) and
   `miniapp/pages/checkout/checkout.js:2865`
   (`delivery_slot_kind: this.data.selectedSlotKind || ''`). **`''` is falsy, so
   it is stored as `NULL`.**
5. INSERT (`routes/retail.js:9860-9910`). The column list at
   `routes/retail.js:9864` contains exactly three of the six:
   `scheduled_for, delivery_slot_label, delivery_slot_kind`.

**Populated at checkout:** `scheduled_for`, `delivery_slot_label`,
`delivery_slot_kind` (the last frequently `NULL` — see below).
**Left NULL at checkout:** `promised_ship_date`, `promised_delivery_date`,
`channel_preorder_at`.

### 2.3 Are `promised_ship_date` / `promised_delivery_date` set on a booked order?

**No — NULL.** They are written in exactly one place
(`routes/retail.js:10110-10112`), and only when `computeBatchNotice(...)`
returns non-null (`routes/retail.js:10108`). That is the outside-GZ
batch-made-item path only, per `database.js:2843-2845`: *"Promised production +
arrival dates stamped on outside-GZ orders that hold a batch-made item."* A
plain customer-scheduled delivery never enters it.

Consequence for §1.2: step 2 (`Arrives 预计送达`) cannot fire for TC000180, so
the slip's only remaining chance to print a date is step 3.

`channel_preorder_at` is likewise NULL — it is written only by the Meituan
ingest (`routes/meituan-internal.js:381`) for platform orders, and TC000180 is a
first-party order number.

### 2.4 Why `delivery_slot_kind` is NULL on real orders

Two client-side sources, both deliberate:

- `public/shop.html:2545-2551` (`coSlotKind`) returns `''` for time-slot zones.
  The comment at `public/shop.html:2542-2544` says so explicitly: *"Time-slot
  zones (Yuexiu/Tianhe) carry no surcharge and are never pinned, and their ''
  kind feeds the admin ship-by column — so they keep sending exactly what they
  sent before."*
- `miniapp/pages/checkout/checkout.js:2004` — `pickSlot` resets
  `selectedSlotKind: ''` for **any** slot chosen through the time-slot picker.

Plus legacy rows: `database.js:2852` records *"NULL on legacy orders placed
before this column existed."*

---

## 3. What the drawer reads

The drawer's `Booked` comes from `shipByPlan` (`public/retail-admin/04-orders.js:1766`),
scheduled branch, kicker set at `public/retail-admin/04-orders.js:1876`:

```js
kickerEn: done ? reqEn : 'Booked', kickerCn: done ? reqCn : '顾客预约',
```

Its value reads **`o.scheduled_for`** (parsed at `:1863`, rendered via
`slotWindowText(o.scheduled_for, o.delivery_slot_label)` at `:1867`, with
`fmtSlotShort(dt)` as the date sub-line at `:1873`). It is rendered by
`renderShipByTile` (`public/retail-admin/04-orders.js:2252-2254`), and the
`· in 3d` suffix is the urgency badge at
`public/retail-admin/04-orders.js:2288` (`` cuT(`in ${u.days}d`, …) ``).

**Same column as the print template.** Both sides read `scheduled_for` +
`delivery_slot_label` + `delivery_slot_kind`. `lib/feie.js:385-387` states the
intent outright: *"MIRRORS the admin's annotateShipBy() + shipByPlan() … keep
the precedence in sync"*, and `public/retail-admin/04-orders.js:1754-1756` says
the same from the other side.

**One incidental confirmation about TC000180.** The `in 3d` badge only renders
on the `u.dateOnly` branch (`public/retail-admin/04-orders.js:2280-2288`), and
`dateOnly` is set only when `urgencyDate` is a bare `YYYY-MM-DD`
(`public/retail-admin/04-orders.js:1913-1915`). `urgencyDate` here is
`slotEndAnchor(o.scheduled_for, o.delivery_slot_label)`
(`public/retail-admin/04-orders.js:1879`), which collapses to a bare date at
`public/retail-admin/04-orders.js:1747-1751` **only when the GZ wall-clock is
`00:00:00`**. So the drawer's own rendering proves TC000180's `scheduled_for`
sits at GZ midnight — the exact input `isGzMidnight` (`lib/feie.js:434`) keys
off.

There is a *second*, unrelated "Booked" in the same file —
`public/retail-admin/04-orders.js:4442` (`Booked for · 顾客预约`), which reads
`o.channel_preorder_at || o.channel_eta` (`:4439`). That one is in the
platform-channel block for Meituan/Eleme orders and is **not** the tile in this
report. (The `:4287` pointer in the brief lands on `orderDangerPick`, unrelated;
the tile is at `:2252` and the kicker at `:1876`.)

---

## 4. The payload handed to the printer

`printOrderById` (`routes/retail.js:22184-22213`):

```js
const order = tdb().prepare('SELECT * FROM retail_orders WHERE id = ?').get(orderId);   // :22187
…
const content = _feie.renderOrder(tpl, order, items, p.shop_name, shipments, …);         // :22211
```

The payload is:

- `order` — **the entire `retail_orders` row, `SELECT *`** (`routes/retail.js:22187`)
- `items` — order items + resolved bundle components (`routes/retail.js:22192-22208`)
- `shopName` — from printer prefs (`routes/retail.js:22211`)
- `shipments` — `id, mode, label` (`routes/retail.js:22209`)

The two other render paths are the same shape: preview uses `SELECT *`
(`routes/retail.js:22443`), and the drawer's manual reprint
(`routes/retail.js:22501`) delegates to `printOrderById`.

**The booked column is present.** `scheduled_for`, `delivery_slot_label` and
`delivery_slot_kind` all reach `lib/feie.js` intact — `SELECT *` drops nothing.
This is **not** a "data never arrives" failure for those three columns.

### 4.1 What the payload *does* drop — and this is the crux

The drawer endpoint does **not** hand the raw row to its renderer. `GET
/api/retail-admin/orders/:id` (`routes/retail.js:20306-20320`) JOINs the
delivery zone and then annotates:

```sql
z.zone_type AS zone_type,                                          -- :20311
z.day_only AS zone_day_only, z.same_day_surcharge AS zone_same_day_surcharge   -- :20312
LEFT JOIN retail_delivery_zones z ON z.id = o.delivery_zone_id     -- :20316
```
```js
annotateShipBy(o);   // :20320
```

`annotateShipBy` (`routes/retail.js:10203-10236`) carries a guard that
`shipByPrintParts` does not:

```js
if (r.zone_type === 'gz_district'
    && Number(r.zone_day_only) !== 1
    && !(Number(r.zone_same_day_surcharge) > 0)) return r;    // :10213-10215
```

An inner-GZ same-day district **returns early**, so `ship_by_mode` is never set
to `'asap'` (`:10226`) — and the midnight/NULL-kind test at `:10222-10224`,
which is byte-for-byte the same logic as `lib/feie.js:432-434`, **is never
reached**. `shipByPlan` then falls through its `o.ship_by_mode === 'asap' || !o.scheduled_for`
check (`public/retail-admin/04-orders.js:1829`) and lands on the scheduled
branch → **`Booked`**.

`zone_type`, `zone_day_only` and `zone_same_day_surcharge` are **not columns on
`retail_orders`** — they come only from that JOIN. `printOrderById`'s
`SELECT *` has no JOIN and never calls `annotateShipBy`, so `lib/feie.js` is
structurally incapable of applying the guard: the three fields it would need are
`undefined` inside `shipByPrintParts`.

---

## 5. Other print surfaces

| Surface | Where | Prints a booked date? |
|---|---|---|
| `receipt` (customer slip) | `lib/feie.js:494-564` | Yes — via `pushShipBy` at `:500`, labelled `Deliver 送达`, subject to the §1.2 guard |
| `packing` (packing/picking slip) | `lib/feie.js:568-620` | Yes — via `pushShipBy` at `:578`, **same guard, so it fails identically**; plus a `MAKE FRESH` line at `:577` gated on `promised_ship_date` |
| `compact` (minimal slip) | `lib/feie.js:623-638` | **No** — prints only `paid_at/placed_at` at `:626`; no `pushShipBy` call at all, by design |
| Add-on slip | `lib/feie.js:663-689` | **No** — only `addon_paid_at` at `:674` |
| Refund-request slip | `lib/feie.js:699-...` | **No** — only `refund_requested_at` at `:707` |
| JD waybill label | `public/retail-admin/04-orders.js:5725-5747` | **No** — carrier-templated label rendered by JD's local print component from encrypted `printData`; our template is not involved |

No kitchen slip or POS receipt template exists separately — `TEMPLATE_IDS`
(`lib/feie.js:748`) is exactly `receipt`, `packing`, `compact`.

Note the blast radius: the **packing slip is affected too**. Whatever suppresses
the date on the customer receipt also suppresses it for the packer, since both
call the same `pushShipBy`.

---

## Root cause

**(d) — something else: the print copy of the ship-by decision has drifted from
the admin copy, and cannot be reconciled because the data the admin guard
depends on is not in the print payload.**

Not (a): the receipt *does* have a date line — `pushShipBy` at
`lib/feie.js:500`, which emits `Deliver 送达` for a scheduled order.
Not (b): the print template reads the *same* columns as the drawer —
`scheduled_for`, `delivery_slot_label`, `delivery_slot_kind`.
Not (c), for those columns: `printOrderById` passes a full `SELECT *` row
(`routes/retail.js:22187`), so they all arrive intact.

What actually happens: `annotateShipBy` and `shipByPrintParts` share an
identical NULL-kind/GZ-midnight ASAP test (`routes/retail.js:10222-10224` vs
`lib/feie.js:432-434`), but the server-side copy is **preceded** by an
inner-GZ-district early return (`routes/retail.js:10213-10215`) that the print
copy has no counterpart for. On an order where `delivery_slot_kind IS NULL` and
`scheduled_for` sits at GZ midnight, in an inner-GZ same-day zone
(`zone_type='gz_district'`, `day_only≠1`, no same-day surcharge), the two sides
disagree: the drawer's guard fires and the order reads `Booked`, while the
print's guard does not exist, the ASAP test wins, and `shipByPrintParts` returns
`null` at `lib/feie.js:447` — no line is pushed and the slip prints no date.

The print side cannot simply adopt the same guard, because `zone_type`,
`zone_day_only` and `zone_same_day_surcharge` live on `retail_delivery_zones`
and reach the drawer only through the JOIN at `routes/retail.js:20316`. In that
narrow sense there *is* a (c) component — but the dropped fields are the zone
columns, not the booked column.

**Inferred, not verified:** no database was available in this checkout, so
TC000180's row was not read. The reasoning above is forced by two independent
code facts — a `Booked` kicker requires `shipByPlan` to reach its scheduled
branch (`public/retail-admin/04-orders.js:1876`), and an `in 3d` badge requires
`slotEndAnchor` to have collapsed `scheduled_for` to a bare date, which happens
only at GZ midnight (`public/retail-admin/04-orders.js:1747-1751`). Confirm with:

```sql
SELECT o.delivery_slot_kind, o.scheduled_for, o.delivery_slot_label,
       o.promised_ship_date, o.promised_delivery_date, o.channel_preorder_at,
       o.fulfillment_type, z.zone_type, z.day_only, z.same_day_surcharge
  FROM retail_orders o
  LEFT JOIN retail_delivery_zones z ON z.id = o.delivery_zone_id
 WHERE o.order_no = 'TC000180';
```

Expected if the above is right: `delivery_slot_kind` NULL, `scheduled_for` at
GZ midnight (`…T16:00:00.000Z` for the previous UTC day, or a local-midnight
string), both `promised_*` NULL, `channel_preorder_at` NULL,
`zone_type='gz_district'` with `day_only` not 1 and no same-day surcharge.

If instead `delivery_slot_kind` comes back as `'schedule'` or `'today'`, this
diagnosis is wrong — those values make `explicitDate` true at
`lib/feie.js:431` and the slip *would* print `Deliver 送达` — and the
investigation should move to the print-time path (`print_status` /
`print_error` on the row, and whether the slip that reached the counter was the
`compact` template, which carries no ship-by line at all by design).

No fix proposed here, per the task scope.
