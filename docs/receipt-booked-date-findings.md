# Receipt: missing booked date — survey findings

**Question.** Order TC000180 shows `Booked Aug 10 · in 3d` in the admin order
drawer. The printed thermal slip for the same order shows no booked/reservation
date at all. Why?

> **READ §7 FIRST — it carries the answer.** The printed slip has been
> transcribed and identifies the template from its own line inventory. Verdict:
> **(d), but not the drift in §Root cause** — the `receipt` template ran,
> `pushShipBy` was called and correctly printed nothing, because at print time
> the order had no customer-scheduled date. The booking was written afterwards
> by a path that never reprints.
>
> Reading order: **§7** (answer) → **§6** (why the earlier verdict fell) → §1-§5
> (inventory and traces, all still valid). The §Root cause verdict and one claim
> in §3 are withdrawn; superseded passages are banner-marked in place rather
> than deleted, so the reasoning that failed stays legible next to what replaced
> it.

**Scope.** Survey only — no code changed. Line references in §1-§5 are against
`origin/main` @ `7ff831b`; §6 against `3a86f955`. No line cited in §1-§5 moved
between the two.

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

> **⚠ SUPERSEDED — this paragraph is wrong. See §6.** It claimed the `in 3d`
> badge proves `scheduled_for` sits at GZ midnight. It does not: `in Nd` also
> renders on the **hours** branch at `public/retail-admin/04-orders.js:2294`
> (`u.level === 'later' && h != null && p.urgencyBasis === 'arrival'`), which
> requires no bare date at all. The badge is therefore consistent with a
> `scheduled_for` carrying a real time, and proves nothing about midnight. The
> original text is kept below so the error is legible rather than quietly
> rewritten.

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

> **⚠ SUPERSEDED for TC000180 — this diagnosis does not hold. See §6.**
> The confirming case below requires `zone_type = 'gz_district'`. TC000180 ships
> to 广东省 东莞市 厚街镇 (Dongguan), which cannot resolve to a `gz_district`
> zone by any path — see §6.1. With that guard unreachable, the two ship-by
> copies agree on every branch that can produce a `Booked` kicker for this
> order, and the mirror-drift explanation collapses. §6 works out what replaces
> it. The section is kept in full because the mechanism it describes is real —
> it is simply not what happened to this order.

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

*(The confirming SQL that stood here has been replaced — see §6.5. It queried
`zone_type`, which §6 shows is the wrong thing to look at for this order.)*

---

## 6. Zone contradiction — Dongguan address

**New fact.** TC000180 ships to **广东省 东莞市 厚街镇** — Dongguan, not
Guangzhou — and is fulfilled by Tianhe. §4.1 hangs the whole (d) diagnosis on
the inner-GZ-district early return at `routes/retail.js:10213-10215`, whose
confirming case requires `zone_type = 'gz_district'`. This section resolves
whether a Dongguan address can ever reach that branch, and what survives if it
cannot.

**Verdict up front: it cannot, and (d) does not survive.** The mechanism §4.1
describes is real, but it is unreachable for this order, and every path that
*can* produce a `Booked` kicker here is mirrored correctly on the print side.

### 6.1 Zone assignment — how a delivery address gets a `delivery_zone_id`

At checkout, `POST /api/retail/orders` resolves the zone from the normalized
address:

```js
if (!isPickup) address = normalizeChinaAddress(address);          // :9655
const zone = isPickup ? null : matchDeliveryZone(address);        // :9656
…
deliveryZoneId = zone.is_default ? null : zone.id;                // :9674
```

`matchDeliveryZone` (`routes/retail.js:25522-25602`) tries, in order:

1. **Hong Kong** — blob contains 香港 → the single HK `city` row
   (`routes/retail.js:25547-25553`).
2. **Guangzhou districts** — *only* when
   `isGuangzhou(address.city) || /广州/.test(blob) || /guangzhou/i.test(blob)`
   (`routes/retail.js:25555`), and only when `gz_district` rows exist
   (`routes/retail.js:25564-25579`). If districts are configured and none
   matches, it returns **null** (`routes/retail.js:25576`).
3. **Exact city** match against `zone_type='city'` rows
   (`routes/retail.js:25585-25587`).
4. **Province-level** — `match_city` equals the address's 省
   (`routes/retail.js:25589-25591`).
5. **Free-text blob** substring, full or suffix-stripped
   (`routes/retail.js:25593-25598`).
6. **National default** — `defaultDeliveryZone()`
   (`routes/retail.js:25601`).

### 6.2 What a Dongguan address resolves to

`isGuangzhou` (`routes/retail.js:25458-25461`, and the identical earlier copy at
`:8303-8307`) matches only the 广州 / guangzhou / gz aliases. **东莞市 is not
Guangzhou**, and the blob test at `routes/retail.js:25555` scans for `广州` —
which does *not* occur in `广东省 东莞市 厚街镇` (广东 ≠ 广州, different second
character). So step 2 is skipped outright, and the gz_district table is never
even read.

The address therefore lands on one of:

- a `zone_type='city'` row (an explicit 东莞市 zone, a 广东省 province-level
  zone, or a blob hit), **or**
- the **national default** (`routes/retail.js:25601`), which is a synthetic
  object with `id: 'default'`, `is_default: 1`, **`zone_type: 'city'`**
  (`routes/retail.js:25478-25480`).

**There is a catch-all, and its `zone_type` is `'city'`** — never `gz_district`.
And it has a second consequence that matters more than its type: because
`is_default` is 1, `routes/retail.js:9674` stores **`delivery_zone_id = NULL`**.
The drawer's `LEFT JOIN retail_delivery_zones z ON z.id = o.delivery_zone_id`
(`routes/retail.js:20316`) then matches no row, so `zone_type`, `zone_day_only`
and `zone_same_day_surcharge` all arrive at `annotateShipBy` as **NULL**. The
same `NULL` outcome follows from the `else` branch at `routes/retail.js:9675`
when `matchDeliveryZone` returns null altogether.

**Can a non-Guangzhou address ever end up `zone_type='gz_district'`?** From the
code, no. The only reads of `gz_district` rows are gated behind the
`inGuangzhou` test (`routes/retail.js:25564-25567`). The one theoretical route
is a mis-keyed zone row — a `gz_district` row whose `match_district` string
happens to appear in a non-GZ blob — but that still requires `inGuangzhou` to be
true first, which a Dongguan address cannot make true. **Not reachable.**

### 6.3 Does the diagnosis survive? — every branch that yields `Booked`

For the drawer to print the `Booked` kicker
(`public/retail-admin/04-orders.js:1876`), `shipByPlan` must reach its scheduled
branch, which requires all of:

- not counter (`:1772`), not pickup (`:1774`);
- **`promised_ship_date` NULL** — otherwise `:1791` returns the batch plan,
  whose kicker is `Deliver by` / `Ship by`, not `Booked`;
- `scheduled_for` set and `ship_by_mode !== 'asap'` (`:1829`).

So the question reduces to: which `annotateShipBy` branches return **without**
setting `ship_by_mode = 'asap'` (`routes/retail.js:10226`)?

| # | Line | Branch | Reachable for Dongguan? |
|---|---|---|---|
| 1 | `:10205` | `shipsNothing(r)` — pickup / counter (`lib/fulfilment.js:42-45`) | **No** — this is a delivery order |
| 2 | `:10213-10215` | inner-GZ district (`zone_type='gz_district'`, `day_only≠1`, no surcharge) | **No** — §6.1/6.2; `zone_type` is `'city'` or NULL |
| 3 | `:10218` | `kind === 'schedule' \|\| kind === 'today'` | **Yes** |
| 4 | `:10225` | `!isAsap` — `scheduled_for` set, `kind` not in {express, right_away, restock}, and not (`kind == null` && GZ-midnight) | **Yes** |

Only branches **3** and **4** survive. Now re-check each against
`shipByPrintParts` (`lib/feie.js:404-448`):

- **Branch 3 — `kind = 'schedule'` or `'today'`.** `lib/feie.js:431` sets
  `explicitDate = true`, so `:435` is entered regardless of the midnight test.
  `slotValue(o.delivery_slot_label, o.scheduled_for)` (`lib/feie.js:466-469`)
  falls back to `fmtSlotDate(scheduled_for)`, which is non-empty for any valid
  timestamp — so `:437` returns `Deliver 送达`. **The print copy has this
  branch. It prints.**
- **Branch 4 — `kind == null`, `scheduled_for` not at GZ midnight.**
  `lib/feie.js:432-434` computes `isAsap`: the `kind == null && isGzMidnight(…)`
  clause is false precisely because the timestamp is not midnight, and the other
  clauses need a non-null kind or an absent `scheduled_for`. So `isAsap` is
  false, `!isAsap` is true, `:435` is entered, and `:437` returns
  `Deliver 送达`. **The print copy has this branch too. It prints.**

**The print copy lacks neither.** For a Dongguan address there is no state in
which the drawer reads `Booked` and `shipByPrintParts` returns `null`. The
divergence identified in §4.1 is real code, but it is dead code for this order.

This also removes the last support for the midnight claim: with branch 2
unreachable, branch 4 *requires* `scheduled_for` **not** to be at GZ midnight,
and branch 3 is indifferent to it. Combined with the corrected badge reading in
§3 (`in Nd` renders on the hours branch at
`public/retail-admin/04-orders.js:2294`), nothing in the drawer's output implies
a midnight timestamp.

### 6.4 The out-of-GZ batch path — why `promised_*` is NULL

§2.3 said `promised_ship_date` / `promised_delivery_date` are written only by
the outside-GZ batch path (`routes/retail.js:10110-10112`). Dongguan **is**
outside GZ, so the objection is fair. The resolution: being outside GZ is
**necessary but not sufficient**. `computeBatchNotice`
(`routes/retail.js:25732-25741`) returns `null` — writing nothing — on any of
four gates, only the first of which Dongguan passes:

| Gate | Line | Dongguan order |
|---|---|---|
| `if (!zone) return null` | `:25733` | passes (a zone object exists, even the default) |
| `isCity \|\| isShipDistrict` | `:25734-25737` | **passes** — `zone_type='city'` |
| `const cfg = batchScheduleCfg(); if (!cfg) return null` | `:25738-25739` | fails if `batch.schedule` is disabled/unset |
| `if (!batchItems.length) return null` | `:25740-25741` | **fails if the cart holds no batch-made product** |

A Dongguan order carrying no `is_batch_made` item (`database.js:2831`) writes
neither column. That is the ordinary case, not an anomaly — most carts contain
no fresh-batch item. And it is *forced* here: if `promised_ship_date` were set,
`shipByPlan` would have returned the batch plan at
`public/retail-admin/04-orders.js:1791-1821` and the drawer would read
`Deliver by` / `Ship by`, **not** `Booked`. So the observed kicker itself proves
both columns are NULL, and the `Arrives 预计送达` branch (`lib/feie.js:420-423`)
could not have fired either.

### 6.5 What replaces (d)

With the mirror shown to be in sync on every reachable branch, the blank slip
must come from somewhere other than the ship-by decision. Three candidates
remain, all supported by code, none decidable without live data:

1. **The template in use has no ship-by line at all — a genuine (a).** A
   Dongguan destination routes to the *out-of-city* printer by rule:
   `printerForOrder` (`routes/retail.js:22160-22178`) computes
   `outOfGZ = !!city && !isGuangzhou(city)` (`:22164`) and returns
   `outOfCityPrinter(prefs)` (`:22165-22168`) — the store named by
   `printer.out_of_city_store_id` (`routes/retail.js:22110-22111, 22147-22151`),
   whose own comment names Tianhe as that warehouse
   (`routes/retail.js:22122-22124, 22154-22155`). The template is read **from
   that printer's own config** — `printer.template`, resolved at
   `routes/retail.js:22210`. If the out-of-city printer is set to **`compact`**,
   no date can appear: `compact` (`lib/feie.js:623-638`) prints order no,
   `paid_at/placed_at`, items and total, and **never calls `pushShipBy`** — by
   design. This is the leading hypothesis: it explains "no booked date at all"
   on an out-of-GZ order without requiring any bug.
2. **The slip never printed, or printed stale.** `print_status`, `print_error`
   and `printed_at` (`database.js:2885-2887`) are stamped by
   `recordPrintResult` (`routes/retail.js:22219-22231`).
3. **It printed and was not recognised.** No slip anywhere is labelled
   "Booked" — the receipt says `Deliver 送达` (`lib/feie.js:437`). A line
   reading `Deliver 送达 / Aug 10` is easy to read as a shipping note rather
   than the reservation date. §1 already records that no "Booked" label exists
   in `lib/feie.js`.

### 6.6 Revised confirming SQL

The zone columns are no longer the thing to look at; the printer routing and
template are. Read-only:

```sql
SELECT o.order_no, o.delivery_slot_kind, o.scheduled_for, o.delivery_slot_label,
       o.promised_ship_date, o.promised_delivery_date, o.fulfillment_type,
       o.store_id, o.print_status, o.print_error, o.printed_at,
       json_extract(o.address_json, '$.city') AS dest_city,
       o.delivery_zone_id, z.zone_type,
       (SELECT value_json FROM storefront_config
         WHERE key = 'printer.out_of_city_store_id') AS ooc_store_id,
       (SELECT value_json FROM storefront_config
         WHERE key = 'printer.by_store')             AS printer_by_store
  FROM retail_orders o
  LEFT JOIN retail_delivery_zones z ON z.id = o.delivery_zone_id
 WHERE o.order_no = 'TC000180';
```

How to read it:

- **`dest_city` = 东莞市 and `ooc_store_id` set** → the slip printed on the
  out-of-city printer. Find that store's id inside `printer_by_store` and read
  its `template`. **`template` = `compact` confirms candidate 1** and the answer
  is (a): the template in use carries no ship-by line, and nothing is broken —
  it is configured that way.
- **`template` = `receipt` or `packing`, and `delivery_slot_kind` is
  `schedule` / `today` / NULL with a non-midnight `scheduled_for`** → the slip
  *should* have carried `Deliver 送达`. Then check `print_status` /
  `print_error` (candidate 2), and if those are clean, candidate 3 — ask whether
  the paper actually said `Deliver 送达` and was read as something else.
- **`zone_type` NULL with `delivery_zone_id` NULL** → the national default zone
  (`routes/retail.js:25478-25480, 9674`); expected for Dongguan, and further
  confirmation that the §4.1 gz_district branch was never in play.
- **`promised_ship_date` non-empty** → contradicts the `Booked` kicker (§6.4);
  the drawer would have read `Deliver by`. Re-open §6.3 if so.

### 6.7 Standing corrections to the earlier sections

- **§3's "incidental confirmation" is wrong** and is banner-marked in place:
  `in Nd` also renders on the hours branch
  (`public/retail-admin/04-orders.js:2294`), so the badge never proved a
  GZ-midnight `scheduled_for`.
- **The §Root cause verdict (d) is withdrawn for TC000180** and banner-marked
  in place. The drift it describes exists in the code, but requires
  `zone_type='gz_district'`, which this order cannot have.
- **§1, §2, §4 and §5 stand unchanged.** The template inventory, the write-path
  trace, the `SELECT *` payload finding and the print-surface table were not
  contingent on the zone.

No fix proposed here, per the task scope. No live data was available for this
round either — §6 is derived from code alone, and §6.5 deliberately leaves three
candidates open rather than picking one without evidence.

> **§6.5 candidate 1 is now DISPROVEN by the printed artifact — see §7.**
> The slip TC000180 produced carries twelve lines that the `compact` template
> cannot emit. It was printed by the **full `receipt`** template, which means
> `pushShipBy` *was* called and returned false. Candidate 3 is disproven too.
> Candidate 2 survives in a refined form.

---

## 7. Template identified from the printed artifact

**New evidence.** The physical slip TC000180 produced has been transcribed. It
decides between §6.5's candidates without any database access, because the three
templates have disjoint line inventories.

### 7.1 What each template emits, in order

`renderOrder` (`lib/feie.js:645-655`) dispatches to one of three; `TEMPLATE_IDS`
is exactly `receipt`, `packing`, `compact` (`lib/feie.js:748`).

| # | `receipt` (`lib/feie.js:494-563`) | line | `compact` (`lib/feie.js:623-638`) | line |
|---|---|---|---|---|
| 1 | `<CB>` shop name | `:496` | — *(no shop name)* | — |
| 2 | `<CB>` order_no | `:497` | `<CB>` order_no | `:625` |
| 3 | divider | `:498` | `<C>` time, **unlabelled + centered** | `:626` |
| 4 | `Time  ` + `paid_at \|\| placed_at` | `:499` | divider | `:627` |
| 5 | **ship-by block** (`pushShipBy`) | `:500` | — *(never called)* | — |
| 6 | `To    ` recipient_name | `:506` | — | — |
| 7 | `Tel   ` recipient_phone | `:507` | — | — |
| 8 | divider | `:509` | — | — |
| 9 | per item — name (bold) | `:514`→`:267` | per item — name (bold) | `:630` |
| 10 | per item — `x{q}` + `SKU {sku}`, enlarged, one line, qty prefix only when `q > 1` | `:272-273` | per item — `x{q}` alone, **no SKU**, only when `q > 1` | `:631` |
| 11 | per item — supplier-direct flag | `:277` | — | — |
| 12 | per item — **size / weight**, 2-space indent | `:278` | — | — |
| 13 | per item — bundle components | `:279` | bundle components | `:632` |
| 14 | per item — **each option** `question: answer`, 2-space indent | `:282` | — | — |
| 15 | per item — **`  {q} x ¥unit`  ⟶  `¥line_total`** | `:283` | — | — |
| 16 | per item — refunded stamp (if any) | `:520` | — | — |
| 17 | `PKG n/N` + mode label (split shipments only) | `:531-532` | — | — |
| 18 | divider | `:539` | divider | `:634` |
| 19 | **`Items 件数`** + unit count | `:543` | — | — |
| 20 | **`Subtotal`** | `:544` | — | — |
| 21 | `Shipping` (only if `> 0`) | `:545` | — | — |
| 22 | **`Voucher`** (only if `> 0`) | `:546` | — | — |
| 23 | `Points` (only if `> 0`) | `:547` | — | — |
| 24 | `TOTAL` | `:548` | `TOTAL` | `:635` |
| 25 | refund summary (if any) | `:551-555` | — | — |
| 26 | **`Paid by`** | `:556` | — | — |
| 27 | divider + **`address_full`** | `:557` | — | — |
| 28 | `+ Cutlery 餐具` (if flagged) | `:558` | — | — |
| 29 | `Note:` + customer_note (if any) | `:559` | — | — |
| 30 | `=` divider | `:560` | — | — |
| 31 | **`Thank you!`** | `:561` | — | — |

The per-item lines (#9-#15) come from `itemLines(it, { price: true })`
(`lib/feie.js:261-285`), which **only the `receipt` template calls**
(`lib/feie.js:514`). `compact` hand-rolls its three item lines inline
(`lib/feie.js:630-632`) and never touches `itemLines`.

### 7.2 Diff against the actual slip

Every content line on the slip maps to a `receipt` line, in order:

| Slip line | Template | Source |
|---|---|---|
| `Roots` | receipt `:496` | `shopName` |
| `TC000180` | receipt `:497` | `o.order_no` |
| divider | receipt `:498` | `rule()` |
| `Time   2026-08-07 09:17` | receipt `:499` | `fmtTime(o.paid_at)` |
| *(ship-by line absent)* | receipt `:500` | `pushShipBy` returned **false** |
| `To     王宇` | receipt `:506` | `o.recipient_name` |
| `Tel    18928777635` | receipt `:507` | `o.recipient_phone` |
| divider | receipt `:509` | `rule()` |
| `中东鹰嘴豆泥 / Hummus Asli` | `:267` | `itemName(it)` |
| `SKU 1-10` | `:272-273` | `big`, `q = 1` so no `x` prefix |
| `  200g` | `:278` | `it.size` |
| `  1 x ￥38.00      ￥38.00` | `:283` | `row(…)`, `price: true` |
| `  需要加热吗? / heat up?: 不要 / No` | `:282` | `optLine(op)` |
| `x4   SKU 3-251` | `:272-273` | `q = 4 > 1` → `x4` + 2-space sep + SKU |
| `Items 件数                8` | receipt `:543` | `shipQty` sum = 1+1+1+4+1 = **8** ✓ |
| `Subtotal            ￥323.00` | receipt `:544` | `o.subtotal` |
| `Voucher              -￥25.84` | receipt `:546` | `o.voucher_amount > 0` |
| `TOTAL               ￥303.56` | receipt `:548` | `o.total` |
| `Paid by               wechat` | receipt `:556` | `o.payment_method` |
| divider + `广东省 东莞市 …` | receipt `:557` | `o.address_full` |
| `Thank you!` | receipt `:561` | literal |

**Lines on the slip that the `receipt` template cannot produce: none.**

**Lines the template would emit that the transcription does not show: two
dividers** — `rule()` at `:539` (immediately before `Items 件数`) and
`rule('=')` at `:560` (immediately before `Thank you!`). Called out as
instructed. This is almost certainly transcription fidelity rather than a third
path: a divider is visually the least salient line on a slip, the transcript
does record the other three (`:498`, `:509`, `:557`), and no template in the
repo emits the twelve receipt-only content lines while omitting exactly those
two rules. `TEMPLATE_IDS` has only three entries (`lib/feie.js:748`), and the
two non-selectable slips are excluded by their headers alone — `renderAddon`
prints `+ ADD-ON 加单` (`lib/feie.js:668`) and `renderRefundRequest` prints
`退款申请 REFUND REQ` (`lib/feie.js:704`). It is worth one glance at the photo
to confirm, but nothing hangs on it.

**Incidental, and unrelated to the booked date — the money column does not
reconcile on paper.** ¥323.00 − ¥25.84 = ¥297.16, but the printed TOTAL is
¥303.56, a gap of **¥6.40**. The receipt template prints `Subtotal`, `Shipping`,
`Voucher`, `Points` and `TOTAL` (`lib/feie.js:544-548`) but has **no packing-fee
line**, and `packing_fee` (`database.js:2474`, written at
`routes/retail.js:9673`) appears nowhere in `lib/feie.js` at all. So a charged
packing fee is invisible on every slip while still sitting inside TOTAL, which
is what the ¥6.40 looks like. Noted for a separate ticket; it has no bearing on
the booked-date question, and the check is the same one query — compare
`packing_fee` against the gap.

Absent lines that are correctly absent, each by its own guard: `Shipping`
(`:545`, `shipping_fee = 0` — subtotal ¥323 clears the free-ship threshold),
`Points` (`:547`), `PKG n/N` (`:531`, single shipment → `groupByShipment`
returns null at `lib/feie.js:292`), refund lines (`:520`, `:551-555`), cutlery
(`:558`), note (`:559`).

### 7.3 The six discriminators

Asked directly — does `compact` emit these?

| Discriminator | On the slip | `compact` emits it? | Verdict |
|---|---|---|---|
| Per-item weight (`200g`, `330g`, `300ml`, `400g`, `600g`) | yes | **No** — `:278` lives in `itemLines`, which `compact` never calls | receipt only |
| Per-item option (`需要加热吗? / heat up?: 不要 / No`) | yes | **No** — `:282`, same reason | receipt only |
| `x4` qty prefix | yes | **Partially** — `:631` emits `x4`, but **never the `SKU 3-251` on the same line**. The slip's combined `x4   SKU 3-251` is `:272-273` | receipt only |
| `Items 件数` count | yes | **No** — `:543` has no counterpart | receipt only |
| `Voucher` line | yes | **No** — `:546` has no counterpart | receipt only |
| Trailing delivery address | yes | **No** — `:557` has no counterpart | receipt only |

Six for six. Adding the shop name (`:496`), `To`/`Tel` (`:506-507`), per-line
prices (`:283`), `Subtotal` (`:544`), `Paid by` (`:556`) and `Thank you!`
(`:561`), the slip carries **twelve** lines `compact` cannot emit.

**The slip was printed by the full `receipt` template.** §6.5 candidate 1 is
disproven.

### 7.4 What that forces

`receipt` calls `pushShipBy(L, o)` unconditionally at `lib/feie.js:500`. The
slip has no ship-by line, so `pushShipBy` returned `false`, which happens only
when `shipByPrintParts(o)` returned `null` (`lib/feie.js:480-481`). Working back
through §1.2 with counter and pickup excluded (the slip prints `To`/`Tel`, which
`:505` suppresses for a counter sale, and a pickup would have returned the
`Pickup 自提` branch at `:415`), and `promised_ship_date` excluded (it would have
returned `Arrives 预计送达` at `:422`), the only exit left is **`:447`** — the
express / restock / nothing-scheduled fallthrough.

**So at 09:17 on 2026-08-07, when this slip printed, the order had no
customer-scheduled date.** Meanwhile the drawer now reads `Booked Aug 10`, and
§6.3 established that *every* state producing a `Booked` kicker also produces a
printed line. Both cannot be true of the same row at the same time.

They are true of the same row at **different** times. The slip is a snapshot
taken at payment; the booking was written afterwards.

The code has exactly one post-print writer of these columns. Grepping every
write of `scheduled_for` in `routes/retail.js` returns two sites:

- `:4390-4392` — the Express "Earliest …" re-anchor inside `markOrderPaid`.
  This runs **before** the print (`autoPrintOrder` is at `:4469`), so it cannot
  create post-print drift. Note it writes a local-midnight ISO and leaves
  `delivery_slot_kind` untouched.
- `:17309-17314` — the customer self-service reschedule
  (`POST /api/retail/orders/:id/reschedule`, `routes/retail.js:17234`), which
  sets `scheduled_for`, `delivery_slot_label` **and** `delivery_slot_kind`
  together, and clears `seen_at` to re-flag the order for staff (`:17312`).

That endpoint **does not reprint**: there is no print call anywhere in
`routes/retail.js:17234-17320`, and the only two `autoPrintOrder` call sites in
the file are `:4469` (gateway payment) and `:23789` (admin "Mark paid", guarded
to genuine pending→paid transitions). A customer who rebooks after paying
changes the database and nothing on paper. The web date-picker sets
`slotKind = 'schedule'` when it posts (`public/shop.html:3090`), and the
mini-app reschedule does the same (`miniapp/pages/order/order.js:916`) — which
is exactly the `kind` that makes `annotateShipBy` return early at
`routes/retail.js:10218` and the drawer read `Booked`.

### 7.5 Root cause

**(d) — something else: the paper is older than the booking.**

Not (a): the `receipt` template has the line and called it — proven by the
artifact, not inferred. Not (b): it reads the right columns. Not (c): the full
row reaches it via `SELECT *` (`routes/retail.js:22187`). And not the §4.1
mirror drift, which §6 already retired.

The template, the columns and the payload are all correct. At the instant
`printOrderById` ran, the order genuinely had no customer-scheduled date, so
`shipByPrintParts` correctly returned `null` and correctly printed nothing. The
booked date the drawer shows was written **after** that, by a path that updates
the row and never reprints (`routes/retail.js:17309-17314`). Nothing in the
print stack is broken; the slip is simply a stale snapshot, and there is no
mechanism that would ever refresh it.

**§6's three candidates collapse to one.** Candidate 1 (compact template) is
disproven by §7.3. Candidate 3 (printed but misread) is disproven by §7.2 —
there is no ship-by line on the paper to misread. Candidate 2 survives, refined:
the print did not fail, it succeeded against a row that had not yet been booked.

### 7.6 Is it settled? — the one fact still missing

**Settled from the artifact plus code, with no live data:** which template
printed (§7.3), that `pushShipBy` ran and returned false (§7.4), that the order
carried no customer date at print time (§7.4), and therefore that the slot
columns changed after the slip was cut. That chain is closed.

**Not settled:** that the change arrived via the reschedule endpoint. The code
offers exactly one post-print writer, so that is where the evidence points, but
a manual database edit or an admin action outside these two sites would look
identical on paper. One query closes it — a timestamp comparison, not a
column-value guess:

```sql
SELECT o.order_no, o.paid_at, o.printed_at, o.print_status, o.print_error,
       o.updated_at, o.seen_at,
       o.delivery_slot_kind, o.scheduled_for, o.delivery_slot_label,
       o.promised_ship_date, o.promised_delivery_date
  FROM retail_orders o
 WHERE o.order_no = 'TC000180';
```

Reading it:

- **`updated_at` later than `printed_at`**, with `delivery_slot_kind` now
  `'schedule'` and `scheduled_for` on Aug 10 → **confirms §7.5 outright**. The
  row was booked after the slip printed. `seen_at` NULL is corroborating: the
  reschedule clears it (`routes/retail.js:17312`).
- **`print_status = 'printed'` with a `printed_at` near 09:17** → confirms the
  slip in hand is the one this order produced, and that the print itself
  succeeded (`routes/retail.js:22219-22231`).
- **`updated_at` at or before `printed_at`** → §7.5 is wrong. The row already
  held its booking when the slip printed, and §6.3's proof that such a state
  always prints a line would then be the thing to re-examine.
- `promised_*` empty throughout, as §6.4 requires.

Note this supersedes §6.6's query, which looked at printer routing and template
config. §7.3 answered the template question from the paper itself, so those
columns are no longer the discriminator — the timestamps are.

No fix proposed here, per the task scope.

---

## 8. Width audit — SETTLED (doubling confirmed, wrap confirmed)

Recorded so the next session does not re-derive it. **Nothing about this has
shipped, and no width fix is in flight.** The audit that produced it was run
2026-08-07 against `lib/feie.js` at `16c64164`; this rewrite is against
`c26651f0`, where the cited lines have moved — see §8.7 for the mapping.

> **§8.1–§8.5 as written on 2026-08-07 are WITHDRAWN.** They recorded the
> no-doubling rule as *corrected*, eight findings as *false alarms*, and the
> `改期` split as *unnecessary*. All three are wrong. The withdrawn text is
> banner-marked in place below, not deleted — the error is the point.
>
> A printed refund slip (TC000193, 2026-08-08 08:19) settles both open
> questions: **enlarged lines ARE doubled**, and the head **WRAPS, it does not
> truncate**. Read §8.0 first; §8.1–§8.5 survive only as the record of a wrong
> turn.
>
> **The rule this produced now lives in `docs/tacet-desktop-patterns.md` §1.20**
> — cite that for the rule, this section for how it was arrived at. **Two of the
> eleven findings were fixed and deployed on 2026-08-08 (`f459e3de`); the other
> nine stand. §8.8 records what shipped, the one line still open on the refund
> slip, and the CJK-compound hazard the fix uncovered.**

### 8.0 What the paper settled

Ash printed a refund-request slip on 2026-08-08 08:19 and read it against
`rule()` — 31 normal columns of `-`, the ruler every slip carries
(`lib/feie.js:120-122`). Three over-width lines, transcribed:

```
退款申请 REFUND          ← source is ONE line, <CB>
REQ                      ← continuation, centred
TC000193
-------------------------------
Time   2026-08-08 08:19
...
退款金额 Refund           ← source is ONE line, <B>row(…)
              ￥20.00     ← continuation, hard against the right edge
```

**Every character survived on every over-width line.** `REQ` is on line two,
not lost.

#### (a) Doubling is real

`<CB>退款申请 REFUND REQ</CB>` (`:781`) is **19** display columns — comfortably
inside 31. Under the no-doubling rule of §8.1 it prints on one line. **It did
not.** It broke. Only doubling explains a 19-column line breaking on a
31-column head: doubled, it is 38.

The same holds for `<B>${row('退款金额 Refund', money(…))}</B>` (`:806`).
`row()` measured `退款金额 Refund` at 15 and `￥20.00` at 7, found
`gap = 31 − 15 − 7 = 9 ≥ 1`, and returned **one** line of exactly 31 columns
(`:110-118`). The paper shows two. Undoubled, 31 columns is by construction a
fit — `row()` computes against `WIDTH`. Doubled, it is 62 on a 31-column head.

Two independent lines, two independent breaks, both predicted by doubling and
neither by its absence.

This is also what the code already said. Two comments assert double-width, and
one line **enforces** it in shipped production code:

- `:471-477` — "Feieyun's `<B>` is double-WIDTH, so an enlarged line only fits
  ~15 half-width columns of the 31-column head".
- `:680-685` — "`<CB>` is double-WIDTH, so a glued `Date changed 改期` measures
  34 of the 31-column head".
- `:482` — `dispLen(sb.value) * 2 <= WIDTH`. The guard on the one value that
  must survive the slip has been doubling since the file was written.

§8.1 did not merely pick the wrong model; it contradicted the model the file
implements. That should have been the tell.

#### (b) The head WRAPS — it does not truncate

No code reading could answer this. The paper does: on all three over-width
lines every character is present, carried to a continuation line. `REQ` was
never dropped — it was on the next line, unread.

#### (c) Where the break falls

Both breaks land at the same place, and it is **not** `WIDTH`.

`退款金额 Refund` is 30 head columns doubled (`退款金额` 4 CJK × 4 = 16, space 2,
`Refund` 6 × 2 = 12). The nine pad spaces `row()` inserted follow. The paper
shows `￥20.00` on line two ending flush right — *one* continuation line, not
two.

- If the head wrapped at **31** columns, all nine spaces (18 columns) would move
  to line two, giving `18 + 14 = 32` — over again, splitting `￥20.00` across a
  **third** line. The paper shows no third line.
- If the head wrapped at **32** columns, line one absorbs one space (30 + 2 =
  32) and line two carries eight spaces + `￥20.00` = `16 + 14 = 30` columns,
  ending at column 30 — flush right. **This is what the paper shows.**

So the head's own wrap point is **32 head columns = 16 source display columns
when enlarged**. `WIDTH = 31` is a *software* margin — chosen because the 32nd
column prints poorly (`:97-100`) — and is a different number from the column at
which the head breaks a line. Conflating the two is what made §8.1 look
arithmetically clean.

**Safe enlarged width is therefore `dispLen ≤ 16`.** The `:482` guard uses
`dispLen * 2 <= 31`, i.e. `≤ 15` — conservative by one column. Not a defect;
worth knowing before anyone "fixes" it.

#### (d) Word boundary or column limit?

**Column limit, at character granularity.** A doubled glyph is atomic (2 head
columns for ASCII, 4 for CJK), so a break can never land mid-character — but it
is not word-aware either:

| line | break falls | on a word boundary? |
|---|---|---|
| `退款申请 REFUND REQ` | after `REFUND`, col 32 | yes — the space sits exactly at cols 31-32 |
| `退款金额 Refund` + 9 pad spaces + `￥20.00` | after the **first** pad space | no — mid-run-of-spaces |
| `Items 件数` + 20 pad spaces + `8` | after the **sixth** pad space | no — mid-run-of-spaces |

The `REFUND`/`REQ` break coincides with a space by arithmetic accident, not by
rule: the space is simply the glyph occupying columns 31-32.

**Honest residual:** all three paper breaks fall inside whitespace, so the paper
alone does not *exclude* a word-wrapping head. The only mid-word break on record
is the `Deliver 送达  Aug 03` account (§8.C) — a comment, not paper. A hard
column limit is the simpler model, it matches all four observations, and nothing
contradicts it. If it ever matters, one enlarged line with a long unbroken token
would decide it.

#### (e) Alignment of the continuation — two different mechanisms

The paper shows `REQ` centred and `￥20.00` right-aligned, which reads as
"inherits the line's alignment". Half right:

- **Centre is inherited.** `<CB>` sets centre justification as printer state;
  the head re-applies it to *every physical line* it emits, continuations
  included. That is why `REQ` is centred rather than at the left margin.
- **Right is not inherited — there is no right-align tag in this file.** The
  right-hand column exists only as pad spaces `row()` inserted (`:114`).
  `￥20.00` sits at the right edge because those spaces **survived the wrap**
  and were carried onto line two. Had the head stripped leading whitespace on a
  continuation, `￥20.00` would have landed at the left margin. It did not.

The distinction matters: a `row()` placed inside `<C>` would not behave like
either example.

#### (f) TC000180 — the misreading, and what the slip actually showed

§8.1 rested on Ash's reading of TC000180's `Items 件数` line
(`<B>${row('Items 件数', String(totalUnits))}</B>`, `:543`):

> "prints on ONE line, enlarged, intact — label left, `8` right-aligned at the
> paper edge, wide gap between, no truncation and no wrap."

**Ash has withdrawn this reading (2026-08-08).** Run it through the model
confirmed above. `row()` emits `Items 件数` + 20 spaces + `8` = 31 columns; that
is 62 doubled. Breaking at 32:

- line 1 — `Items 件数` + 6 spaces (32 columns; the trailing spaces are invisible)
- line 2 — 14 spaces + `8`, the `8` landing at columns 29-30 — **flush right**

Two lines. Label at the left, `8` at the right edge, and the "wide gap between"
was **vertical**, not horizontal. The slip was reporting a wrap; it was read as
one line. Nothing about TC000180 was inconsistent with doubling — the
observation was sound, the interpretation of it was not.

#### (g) Consequence

**No line anywhere on any slip is losing text.** All eleven findings are ugly
wraps, not missing words. They are a cosmetic backlog. `:277` is not a packer
losing a supplier-direct instruction; it is that instruction spread over three
lines.

Per Ash: **do not fix any of them.** Whether they are worth touching at all is
his call.

---

### 8.1 The corrected width rule — ⛔ WITHDRAWN 2026-08-08

> **This section is wrong and is kept only as the record.** Its rule
> ("enlarged lines are NOT doubled") is refuted by §8.0(a). Its evidence — the
> TC000180 `Items 件数` line — was a misread wrap, see §8.0(f). Its three
> "eliminated" explanations are re-examined at the end of the section.

**Limit is 31 display columns. Enlarged lines are NOT doubled.**

`WIDTH = 31` (`lib/feie.js:101`) — 58mm is nominally 32 half-width columns but
the FP-V58-D head does not print the 32nd (`lib/feie.js:97-100`). CJK counts as
2 (`dispLen`, `:103-107`).

The first audit assumed `<CB>` / `<B>` occupy **double** width, so an enlarged
line had to satisfy `dispLen × 2 ≤ 31`. That model is contradicted by paper:

> On TC000180, `Items 件数` prints on ONE line, enlarged, intact — label left,
> `8` right-aligned at the paper edge, wide gap between, no truncation and no
> wrap. (Ash, from the physical slip, 2026-08-07.)

That line is `<B>${row('Items 件数', String(totalUnits))}</B>`
(`lib/feie.js:543`). `row()` pads to exactly `WIDTH` (`:110-118`), so its output
is 31 display columns. Under the doubling model it would need 62 columns on a
31-column head, and the last character — the `8` — would be the first thing
lost. **A doubled line cannot right-align at the paper edge.** The geometry
forces the conclusion: `<B>` did not double the width of that line.

Three of the candidate explanations are eliminated from code:

- **`row()` padding is correct** — computed against 31 (`:113`), not against an
  enlarged width, and it produced exactly 31.
- **The preview legend is not authority.** `02-settings-ops.js:652-653` maps
  `<CB>`→`tc tbig`, `<B>`→`tbig`, `<L>`→`ttall` — a CSS font-size in a *faux*
  preview, explicitly "roughly how the slip prints". It was never a statement
  about the head. The first audit treated it as one.
- **The deployed path is the one we read.** `git log -L 543,543:lib/feie.js`
  shows that line unchanged since the file entered the repo, and TC000180
  printed at 09:17 on 2026-08-07 from that same source.

> **The three "eliminated explanations", re-examined.** Two of them were sound
> and remain true; they simply did not bear on the question.
>
> - *`row()` padding is correct* — **true, and still true.** `row()` pads
>   against 31 and produced exactly 31. That is a fact about the **software**
>   string. The head then doubles it. §8.1's error was treating a correct
>   31-column string as proof of a 31-column *printed* line.
> - *The preview legend is not authority* — **true, and still true.**
>   `02-settings-ops.js:661` maps `CB`→`tc tbig`, `B`→`tbig`, `L`→`ttall` — CSS
>   in a faux preview. It is not evidence either way. It happens to agree with
>   doubling, which is a coincidence, not a confirmation.
> - *The deployed path is the one we read* — **true, and still true.** The line
>   is unchanged. What was misread was the paper, not the source.
>
> None of the three was a bad observation. The conclusion drawn from them was
> the bad step: they eliminated *alternatives to* the paper's reading without
> ever testing the reading itself.

### 8.2 The `Deliver 送达` contradiction — CLOSED

> **The §8.2 written on 2026-08-07 is withdrawn.** It framed two observations as
> irreconcilable. They are reconciled — by the *other* variable.

The comment at `lib/feie.js:471-477` records a firsthand observation:
`<B>Deliver 送达  Aug 03</B>` "ran 60+ columns and the head simply dropped what
didn't fit, which is the END of the line: the date itself."

**Does wrap-not-truncate explain it? Yes — and the contradiction is closed.**

The old §8.2 posed the two accounts as a fork: doubling predicted TC000180's
`Items` line truncating (it appeared not to), no-doubling predicted the
`Deliver` line surviving (it did not). Both horns assumed the printer
**truncates**. That assumption was the error, and it was doing the work in both
directions:

| observation | doubling? | truncate or wrap? | reconciled |
|---|---|---|---|
| TC000180 `Items 件数` — label left, `8` at the right edge | yes, 31 → 62 | **wrapped** to 2 lines; read as 1 line with a gap | §8.0(f) |
| `Deliver 送达  Aug 03` — "the date itself was dropped" | yes, 20 → 40 | **wrapped**; the continuation was not noticed | here |

`Deliver 送达  Aug 03` is 20 display columns — over the 16-column enlarged limit
(§8.0(c)), so **the line genuinely did not fit**, exactly as the comment says.
Doubling was right about that all along. Breaking at 32 head columns:

- line 1 — `Deliver 送达  Au` (`Deliver` 14, space 2, `送达` 8, two spaces 4,
  `A` 2 = 30; `u` takes 31-32)
- line 2 — `g 03`

Read at a glance, line 1 ends mid-token with the date gone — indistinguishable
from truncation unless you notice `g 03` on the following line. **That is a
wrapped line misreported as a lost tail**, the same error as TC000180 in the
opposite direction.

Two consequences:

- **The two-line `pushShipBy` treatment stays justified.** The fix was right
  even though the mechanism was misnamed: at 20 columns the line really did
  over-run, and the day really would have been carried off the first line. The
  guard at `:482` should not be relaxed.
- **One number in that comment is wrong.** "ran 60+ columns" — it is 40 doubled
  (20 × 2), not 60+. Harmless to the conclusion; noted so it is not cited as a
  measurement.

Nothing about the printer's width behaviour is now open. The residual named in
§8.0(d) — whether a break inside an unbroken *word* falls at the column or at
the word — is a granularity question, not a contradiction, and no slip depends
on it.

### 8.3 All eleven findings — reinstated, cosmetic only

**Every enlarged line over 16 display columns wraps.** All eleven exceed it, so
all eleven are reinstated as real wraps — and, because the head wraps rather
than truncates, **none of them loses a character.** They are ugly, not broken.

Line numbers are against `c26651f0`; the 2026-08-07 audit's numbers are in the
second column (see §8.7).

| `:line` | was | template | width | wraps into |
|---|---|---|---|---|
| `:277` | `:277` | `itemLines` (receipt + packing) | **46** | `** 供应商直发 SUPPLIER-DIRECT · do not pack **` — 3 lines |
| `:520` | `:520` | receipt | 28 | `已退款 REFUNDED x‹n›  -￥‹amt›` — 2 lines |
| `:543` | `:543` | receipt | 31 | `Items 件数` / `‹n›` right — 2 lines (the TC000180 line, §8.0(f)) |
| `:593` | `:577` | packing | **36** | `MAKE FRESH 当天现做 ‹timestamp›` — 3 lines |
| `:605` | `:589` | packing | 32 | `** ‹n› refunded 已退款 · pack ‹q› **` — 2 lines |
| `:628` | `:612` | packing | 6 + note | `Note: ‹customer_note›` — data-dependent, 2+ lines |
| `:749` | `:733` | add-on | 28 | `ADD to this order 补入原订单` — 2 lines |
| `:750` | `:734` | add-on | 29 | `Order already placed 此单已下` — 2 lines |
| `:781` | `:765` | refund req | 19 | `退款申请 REFUND` / `REQ` — 2 lines, **confirmed on paper** · still open, see §8.8 |
| ~~`:792`~~ | `:776` | refund req | 23 / 20 | ✅ **FIXED 2026-08-08** (`f459e3de`) — see §8.8 |
| ~~`:806`~~ | `:790` | refund req | 31 | ✅ **FIXED 2026-08-08** (`f459e3de`) — see §8.8 |

**`:277` is downgraded from PRIORITY.** The 2026-08-07 audit flagged it as the
one finding that survived "under either rule", on the reasoning that losing its
tail loses "do not pack". With wrap confirmed, nothing is lost — the instruction
prints in full across three lines. It is the ugliest of the eleven, not the most
dangerous, and it ranks by ugliness alone.

**§8.9 is the live status of all eleven.** This table is the 2026-08-08 audit as
first written; four findings have been actioned since and two are now closed as
*deliberately unchanged*. Read §8.9 before treating any row here as open.

### 8.4 The eight "false alarms" — ⛔ WITHDRAWN 2026-08-08

> **This section is wrong.** It declared `:520` `:543` `:733` `:734` `:765`
> `:776` (×2) `:790` closed on the strength of the no-doubling rule, and told
> the next session not to re-audit them. All eight are reinstated in §8.3.
> Three of them — `:765`, `:776`, `:790` (now `:781`, `:792`, `:806`) — are the
> lines TC000193 printed, and all three wrapped.
>
> Its closing note was the sharpest thing in the old §8 and pointed the right
> way without being followed: *"`:543` and `:790` share the `<B>${row(...)}</B>`
> shape — `row()` pads to exactly 31, which is precisely at the limit and only
> fails under doubling."* Both did fail. Both wrapped.

Each fits comfortably at its true (undoubled) width; they appeared in the first
audit only because of the doubling assumption:

`:520` (28) · `:543` (31) · `:733` (28) · `:734` (29) · `:765` (19) ·
`:776` `PARTIAL refund 部分退款` (23) · `:776` `FULL refund 全额退款` (20) ·
`:790` (31).

Note `:543` and `:790` share the `<B>${row(...)}</B>` shape — `row()` pads to
exactly 31, which is precisely at the limit and only fails under doubling.
`:543` is the line the paper vindicated.

### 8.5 The `改期` split was unnecessary — ⛔ WITHDRAWN 2026-08-08

> **Wrong. The split was necessary and is correct as shipped.**
> `Date changed 改期` is 17 display columns, over the 16-column enlarged limit
> (§8.0(c)); glued, it would have wrapped. Split, both halves fit: `Date
> changed` is 12 and `改期` is 4, i.e. 24 and 8 doubled — which is exactly what
> the comment at `:680-685` says. That comment was right; §8.5 called it a
> wrong measurement on the strength of the no-doubling rule.
>
> `794dc601` should be cited as precedent, not as a cautionary tale.

The two-line head shipped in `794dc601`
(`<CB>Date changed</CB>` + `<CB>改期</CB>`) was justified by measuring the glued
`Date changed 改期` at 34 doubled columns. Its true width is **17** — it would
have fit on one line. The split is **harmless** (both halves print, and an
enlarged two-line head arguably reads louder), but it was added on a wrong
measurement and should be recorded as such rather than cited as precedent.

### 8.6 What settled it — the three observations, and their answers

The old §8.6 named three observations that would settle the question. Ash made
them on 2026-08-08 with TC000193. All three came back the same way:

1. **`退款金额 Refund   ￥…`** (`:806`) — *"If the money right-aligns flush with
   the divider's right end, §8.1 is confirmed."* It right-aligns flush **on the
   next line down**. The test had no branch for that, and the missing branch is
   the answer: §8.1 refuted, §8.4's eight reopened.
2. **`退款申请 REFUND REQ`** (`:781`) — *"Prints in full ⇒ no doubling. Prints
   as `退款申请 REFU…` ⇒ doubling is real."* It printed in full **across two
   lines**. Under a truncating head that reads as "no doubling"; under a
   wrapping head it is doubling with every character kept. Question 2 could not
   be answered before question 3.
3. **Truncate or wrap** — **wrap.** This is the observation that reorders the
   other two, and no code reading could have produced it.

The lesson worth keeping: **both earlier width verdicts were drawn from paper
read under an unstated assumption about truncation.** The 2026-08-07 audit
assumed doubling and read `Items 件数` as intact; §8.1 assumed no-doubling and
read the same line as proof. Neither considered that the line had wrapped. The
model was never the hard part — the reading was.

### 8.7 Line-number drift

The 2026-08-07 audit cited `lib/feie.js` at `16c64164`. Two commits since —
`76757ba2` (receipt money block) and `79c8fd43` — shifted everything from ~`:560`
down by **+16**. Lines above that are unmoved.

| audit cited | now | line |
|---|---|---|
| `:277` | `:277` | `供应商直发 SUPPLIER-DIRECT` |
| `:520` | `:520` | `已退款 REFUNDED` |
| `:543` | `:543` | `Items 件数` |
| `:577` | `:593` | `MAKE FRESH 当天现做` |
| `:589` | `:605` | `‹n› refunded 已退款` |
| `:612` | `:628` | `Note:` |
| `:733` | `:749` | `ADD to this order 补入原订单` |
| `:734` | `:750` | `Order already placed 此单已下` |
| `:765` | `:781` | `退款申请 REFUND REQ` |
| `:776` | `:792` | `PARTIAL/FULL refund` |
| `:790` | `:806` | `退款金额 Refund` |

The `Deliver` comment moved from `:471-478` to **`:471-477`**; `pushShipBy`'s
guard is at `:482`. The preview legend moved to
`public/retail-admin/02-settings-ops.js:661` (was `:652-653`).

### 8.8 The refund slip — what shipped, and what is still open

*Merged and deployed 2026-08-08 as `f459e3de`. Scope was `renderRefundRequest`
only; the other nine findings were not touched, and the five other slips
(receipt, packing, compact, datechange, add-on) were proven byte-identical by
rendering all 17 template/fulfilment combinations before and after, not by
reading the diff. Line numbers below are against `main` after the merge.*

**Two of the eleven are closed.** Both took the same shape — the one §1.20 of
`tacet-desktop-patterns.md` now names: **label at normal size on its own line,
value enlarged beneath it.**

| was | now | shipped as |
|---|---|---|
| `<B>${row('退款金额 Refund', money(…))}</B>` — 31 cols, wrapped | `:822-823` | `<BOLD>退款金额 Refund</BOLD>` (15 of 31) + `<B>￥‹amt›</B>` (7 of 16) |
| `<B>PARTIAL refund 部分退款</B>` / `<B>FULL refund 全额退款</B>` — 23 / 20 cols, wrapped | `:797-799` | EN and CN on separate enlarged lines — 14/8 and 11/8 |

Wrapping lines on the slip went **3 → 1**, and the paper is the same length
either way — 19 physical lines before and after. The amount reads *larger* than
it did, not smaller: it was already being pushed onto its own line, just not on
purpose.

#### 🔴 A break inside a Chinese compound is worse than an English wrap

**This is the finding worth carrying beyond the one case that produced it.**

Glued at 20 columns, `FULL refund 全额退款` broke at 32 head columns — which
lands **inside 全额退款**, leaving `全额` alone on the first line and `退款` on
the second.

An English wrap degrades gracefully. `Plant-based beef ba` / `lls` is ugly and
unmistakably broken; nobody reads `ba` as a word. **A CJK compound does not
degrade — it re-reads.** 全额 ("full amount") and 退款 ("refund") are both real
words on their own, so the first line of a `FULL refund` slip said *full
amount* and the second said *refund*, each looking like a complete, deliberate
line. The slip did not look broken. It looked like it said something else.

**The general hazard, for any enlarged CN line:** the failure mode of an
over-width Chinese line is not illegibility, it is **a plausible wrong
reading** — the same shape §1.17 rule 2 legislates against on screen (*visibly
odd beats plausibly wrong*), arriving through a printer instead of a lookup
table. English gives you a broken-looking fragment and therefore a bug report.
Chinese gives you a different sentence and silence.

*The test:* for an enlarged line containing CJK, do not only ask whether it
fits — ask what the fragment on each side of the break would read as on its
own. If either half is a word, the wrap is not cosmetic.

#### Open — `退款申请 REFUND REQ` (`:781`), and why it was not fixed with the others

**It is now the only wrapping line on the refund slip.** 19 display columns
against the 16 an enlarged line holds; it prints as `退款申请 REFUND` / `REQ`.

The same restructure would close it — and it is *not* being deferred because
it is hard. It is deferred because **it is the slip's header, and changing a
header's shape is a design decision, not a defect fix.**

The distinction matters and is the reason this is recorded rather than done:

- The two lines that shipped were **fixing an accident.** `row()` produced a
  break nobody chose, in a place nobody chose, and the restructure put the
  break where it belongs. Nothing about the slip's design changed.
- The header is **three `<CB>` lines that read as one block** — shop name,
  slip name, order number. Splitting `退款申请 REFUND REQ` into a label line
  and a value line would make it four, and would impose a
  label/value relationship on a phrase that is not one: `REQ` is not the value
  of `退款申请 REFUND`. Every option — drop `REQ`, split EN from CN as the
  `改期` head does, shrink it to normal size — changes how loud the slip's
  identity is, which is the one thing this slip was built to control
  (`lib/feie.js:769-775`: *"Headed loudly so it can't be mistaken for a packing
  slip"*).

So it stays as it is until someone decides what the header should say. **It
loses no text** — `REQ` prints, centred, on the second line — so there is no
correctness argument for touching it. Do not "fix" it as a wrap; it is a
wording question wearing a width question's clothes.

#### Recorded so it is not rediscovered — the itemised branch wraps on long names

When a refund is itemised, `renderRefundRequest` prints each item's name at
`:803` as `<BOLD>${itemName(it)}</BOLD>` — **normal size, limit 31**. A long
bilingual name overruns it: `素食牛肉丸 / Plant-based beef balls` is **35**
display columns and wraps to `素食牛肉丸 / Plant-based beef ba` / `lls`.

**This is not one of the eleven** and it is not a new defect:

- The eleven are **template strings** — fixed text whose width is knowable from
  the source. This is **data**, and its width is a property of the product
  catalogue, not of the slip.
- It is not enlarged, so §1.20's 16-column limit does not reach it. It is a
  normal-size line that a long enough value overruns, the same shape as `:628`
  (`Note: ‹customer_note›`) which *is* on the list only because its prefix is a
  template string.
- `itemName()` (`:185`) glues CN and EN with ` / ` (`bilingual()`, `:146-151`),
  so the combined width is roughly the sum of both names. Any catalogue with
  descriptive English names will exceed 31 routinely.

The same construct is on the packing slip (`:602`) and the receipt (`:646`), so
this is not specific to refunds. **No fix proposed**, and deliberately no
truncation suggested: the head wraps and loses nothing, so a shortening rule
would destroy information the current behaviour keeps. Recorded here only so the
next reader who prints an itemised refund does not file it as a regression from
`f459e3de`.

### 8.9 The eleven — live status, and two closed as deliberately unchanged

*Updated 2026-08-08. This supersedes §8.3's table as the status of record;
§8.3 stays as the audit was first written.*

| `:line` | width | status |
|---|---|---|
| `:792` → `:797` | 23 / 20 | ✅ **fixed, deployed** `f459e3de` — EN/CN split |
| `:806` → `:822` | 31 | ✅ **fixed, deployed** `f459e3de` — label normal, amount enlarged |
| `:781` → `:792` | 19 | ✅ **fixed, deployed** `118a141c` — `REFUND REQ` / `退款申请` |
| `:628` → `:644` | 6 + note | ✅ **fixed, deployed** `b8a774ea` — `<B>` → `<BOLD>` (§1.21) |
| `:605` | 32 | ✅ **fixed, deployed** `57906719` — line removed; the pack count was already on the next line |
| `:264` `:602` `:662` `:831` `:252` | data | ✅ **fixed, deployed** `c3b09f7f` — names split at ` / `, one language per line |
| **`:593`** | **36** | ⛔ **CLOSED — staying as it is** (Ash, 2026-08-08) |
| **`:277`** | **46** | ⛔ **CLOSED — staying as it is** (Ash, 2026-08-08) |
| `:520` | 28 | open, cosmetic |
| `:543` | 31 | open, cosmetic |
| `:749` `:750` | 28 / 29 | open, cosmetic |

#### `:593` and `:277` are decided, not deferred — do not re-propose them

**Both were triaged MISREADS in §8.8's terms and Ash has decided they stay as
they are.** They are recorded here so a later reader does not find them on the
MISREADS list, assume they were missed, and reopen them.

- **`:593`** — `MAKE FRESH 当天现做 ‹timestamp›`, 36 columns, prints as
  `MAKE FRESH 当天` / `现做 2026-08-10 ` / `10:00`. It splits 当天现做, and both
  halves are real terms.
- **`:277`** — `** 供应商直发 SUPPLIER-DIRECT · do not pack **`, 46 columns,
  prints across three lines with `do not pack **` landing alone. 供应商直发
  survives intact; the hazard is a bare imperative that has lost its subject.

**Neither loses a character** — the head wraps (§8.0(b)) — so neither is a
correctness defect. That is the distinction the decision turns on: the four
already fixed each produced a *wrong number or an inverted instruction*; these
two produce an *ugly* line whose meaning survives.

**If either is reopened it should be for a new reason**, with new evidence —
not as unfinished work from this audit.

#### The consequence of the `:605` removal — an accepted trade, not an open defect

**The packing slip now carries no trace that anything was refunded.** That is
deliberate. The packer needs one number, `x‹q›` at `:617` is that number, and
`q` is `shipQty()` — ordered minus refunded — so it is already the count to
pack. Nothing else on the slip states a different one. *(Ash, 2026-08-08,
deployed `57906719`.)*

**The consequence, stated so it is not later mistaken for a bug:** the packing
slip **alone can no longer be reconciled against the receipt.** The receipt says
`x3`, the packing slip says `x2`, and **nothing on either paper explains the
difference.** Anyone reconciling the two has to open the order in admin.

That cost was known and accepted when the line was removed. The line it replaced
was not paying for itself: at 32 display columns it printed as
`** 1 refunded 已` / `退款 · pack 2 **` — two lines carrying two different
numbers, with `退款` opening line two as a standalone "refund". **It was more
likely to make a packer act on the wrong number than to help anyone reconcile.**

**If the discrepancy needs explaining on paper, that is a new requirement**, and
it should be designed as one — not treated as restoring something that was
removed by mistake. The obvious candidate is a line on the **receipt**, which
has 31 columns to work with and already carries `已退款 REFUNDED x‹n›` at
`:520`.

##### The principle underneath it — the two slips are supposed to disagree

**The receipt states what the customer ordered. The packing slip states what
goes in the bag.** Two different questions, two correct answers, and on a
partly-refunded order they *must* differ.

This is worth writing down before someone "fixes" the receipt to match:

- **The receipt showing `x3` is not stale.** It is the record of the order the
  customer placed and paid for. Changing it to `x2` would misdescribe what was
  bought and break the money block, which is arithmetic on the original line.
- **The packing slip showing `x2` is not a subtraction error.** It is an
  instruction, and an instruction about three units would be wrong.
- **Neither is derived from the other.** They read the same row and ask
  different questions of it — `qty` versus `shipQty()`.

*The test:* before making two printed surfaces agree on a number, name the
question each one answers. If the questions differ, so may the answers, and
forcing agreement makes one of them lie.

#### Also closed by decision, recorded in the rulebook

**A generic `wrapText()` helper is declined**, not deferred — surveyed,
prototyped, costed, and rejected because the hazard it was built for is closed
by the width change and no break rule can make a wrapped Chinese clause safe.
The reasoning lives in `docs/tacet-desktop-patterns.md` §1.21. The ` / ` name
split above is **not** that helper: it is a semantic split at a separator the
author supplied, and needs no column arithmetic beyond deciding whether to split.
