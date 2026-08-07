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

## 8. Width audit — OPEN

Recorded so the next session does not re-derive it. **Nothing about this has
shipped, and no width fix is in flight.** The audit that produced it was run
2026-08-07 against `lib/feie.js` at `16c64164`.

### 8.1 The corrected width rule

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

### 8.2 The unresolved contradiction

The comment at `lib/feie.js:471-478` records a firsthand observation going the
other way: `<B>Deliver 送达  Aug 03</B>` "ran 60+ columns and the head simply
dropped what didn't fit, which is the END of the line: the date itself."

That string is **20** display columns — under 31 either way. So:

- the **doubling** rule predicts TC000180's `Items` line truncating. It did not.
- the **no-doubling** rule predicts that `Deliver` line surviving. It did not.

**Neither rule explains both observations.** One of the two accounts is
incomplete. §8.1 follows the firsthand slip currently in hand over a narrative
recorded in a comment, but the disagreement is real and is why this section is
open rather than closed.

A second question is entirely unanswered by code: **when a line does exceed the
head, does this printer TRUNCATE or WRAP?** The comment says dropped; nothing
else in the repo tests it. It decides whether the survivors below lose text or
merely look bad.

### 8.3 Findings that survive the corrected rule

| file:line | template | width | why it matters |
|---|---|---|---|
| **`:277`** | `itemLines` (receipt + packing) | **46** | **PRIORITY.** `** 供应商直发 SUPPLIER-DIRECT · do not pack **` — over the limit under *either* rule, so the model question does not protect it. It is a packer instruction; losing its tail loses "do not pack". |
| `:577` | packing | **36** | `MAKE FRESH 当天现做 ‹timestamp›` — the timestamp is the part at risk. |
| `:589` | packing | **32** | `** ‹n› refunded 已退款 · pack ‹q› **` — one column over. |
| `:612` | packing | 6 + note | `Note: ‹customer_note›` — data-dependent; over at roughly 25 characters of note. |

### 8.4 The eight false alarms — do not re-audit

Each fits comfortably at its true (undoubled) width; they appeared in the first
audit only because of the doubling assumption:

`:520` (28) · `:543` (31) · `:733` (28) · `:734` (29) · `:765` (19) ·
`:776` `PARTIAL refund 部分退款` (23) · `:776` `FULL refund 全额退款` (20) ·
`:790` (31).

Note `:543` and `:790` share the `<B>${row(...)}</B>` shape — `row()` pads to
exactly 31, which is precisely at the limit and only fails under doubling.
`:543` is the line the paper vindicated.

### 8.5 The `改期` split was unnecessary

The two-line head shipped in `794dc601`
(`<CB>Date changed</CB>` + `<CB>改期</CB>`) was justified by measuring the glued
`Date changed 改期` at 34 doubled columns. Its true width is **17** — it would
have fit on one line. The split is **harmless** (both halves print, and an
enlarged two-line head arguably reads louder), but it was added on a wrong
measurement and should be recorded as such rather than cited as precedent.

### 8.6 What will settle it — three observations on paper

Every slip prints `rule()` — exactly 31 normal columns of `-`
(`lib/feie.js:120-122`). **That divider is the ruler.** Hold any enlarged line
against it.

1. **Refund slip, `退款金额 Refund   ￥…`** (`:790`) — the identical
   `<B>${row(...)}</B>` shape as `:543`. If the money right-aligns flush with
   the divider's right end, §8.1 is confirmed and §8.4's eight are closed.
2. **Refund slip, the `退款申请 REFUND REQ` header** (`:765`) — 19 undoubled,
   38 doubled. Prints in full ⇒ no doubling. Prints as `退款申请 REFU…` ⇒
   doubling is real and §8.1 is wrong.
3. **Packing slip, `MAKE FRESH 当天现做 ‹date›`** (`:577`) — 36 columns, over
   the limit under *both* rules. Whether it truncates or wraps answers §8.2's
   second question, which no code reading can.

Until those are read, no width fix should be written — eleven modelled defects
were already reduced to four by one look at a slip.
