# Same-city courier push — pin gate survey

Read-only survey of the code path that refuses a Qingyun (青云聚信) same-city push with
`unverified stored pin could not be corroborated from the address text`. No code was changed.

All line numbers are from the working tree at the time of the survey (branch `claude/order-988-gd9vwb`).

---

## 1. THE GATE

### 1.1 Where the message is produced

`lib/qingyun-payload.js:334-339`, inside `buildCreatePayload()`:

```js
    } else {
      warn(`${norm(order.order_no)}: stored pin has no recorded provenance and the address `
        + `only resolves to ${(c && c.precision) || 'nothing'} (${verdict.reason}) — refusing`);
      throw geoError('unverified stored pin could not be corroborated from the address text',
        { source: storedSource || 'order_pin', precision: storedPrecision, translated });
    }
```

It is the final `else` of the "stored pin exists but is not trusted" branch
(`lib/qingyun-payload.js:297-339`).

### 1.2 The exact conditions

Every one of these must hold at push time:

1. **The order snapshot carries coordinates.** `lib/qingyun-payload.js:279-280`:
   ```js
   const dLng = Number(addr.lng), dLat = Number(addr.lat);
   const hasStoredPin = Number.isFinite(dLng) && Number.isFinite(dLat) && dLng !== 0 && dLat !== 0;
   ```

2. **Those coordinates are not "trusted".** `lib/qingyun-payload.js:289-292`:
   ```js
   const storedSource = norm(addr.geo_source);
   const storedPrecision = norm(addr.geo_precision);
   const pinIsTrusted = storedSource === 'customer_pin'
     || (/^geocode:/.test(storedSource) && (storedPrecision === 'rooftop' || storedPrecision === 'street'));
   ```
   So the untrusted set is: `geo_source` null/empty, `geo_source = 'client_unverified'`, or
   `geo_source = 'geocode:*'` **with `geo_precision = 'coarse'`** (or null).

3. **A fresh forward geocode of the address text does not clear `isDeliverablePin`.**
   `lib/qingyun-payload.js:303-304` calls `resolveText()` then `geocode.isDeliverablePin(c)`.
   `lib/geocode.js:110-118`:
   ```js
   function isDeliverablePin(result, { minPrecision = 'street' } = {}) {
     if (!result || result.lat == null) return { ok: false, reason: 'no_result' };
     const rank = PRECISION_RANK[result.precision] ?? 0;
     if (rank < (PRECISION_RANK[minPrecision] ?? 1)) { ... precision_<x> }
     if (result.cityMatch === false) return { ok: false, reason: 'city_mismatch' };
     return { ok: true, reason: null };
   }
   ```
   `PRECISION_RANK` is `{ coarse: 0, street: 1, rooftop: 2 }` (`lib/geocode.js:50`), so a `coarse`
   answer (province/city/district/town centroid — `lib/geocode.js:56-71`) fails, as does a
   result whose matched city/province disagrees with the address (`lib/geocode.js:100-106`).

4. **The geocoder actually answered** — i.e. `_freshFailure` is null. A network/quota/service
   failure takes the HOLD branch instead (`lib/qingyun-payload.js:321-325`, classification in
   `lib/geocode.js:641-668`). Note that a provider replying `no_result` is an *answer*, not a
   failure (`lib/geocode.js:640-647`), so it lands on the refusal.

5. **A maps key is configured.** With no key at all the code ships the unverified pin instead
   (`lib/qingyun-payload.js:326-333`).

Not required: the drift check. If the fresh resolve *is* deliverable, the order either ships with
the stored pin (drift ≤ `PIN_AGREE_KM`, default 0.5 km — `lib/qingyun-payload.js:75, 308-312`) or
ships with the resolved point instead (`lib/qingyun-payload.js:313-320`). The refusal is reached
only when the text itself cannot be resolved precisely.

Two properties make this deterministic rather than intermittent:

- `resolveText()` is memoised per call (`lib/qingyun-payload.js:251-277`), and
  `geocodeAddress` caches by normalized address string for 7 days in-process
  (`lib/geocode.js:35-36, 166-170`). Retries inside one daemon process re-read the same
  coarse answer.
- Nothing about the order changes between attempts, so all 5 attempts fail identically.

### 1.3 Every condition that blocks a push

**A. Enqueue-time — the order never gets a queue row at all.**

| # | Condition | File | Hard / warn |
|---|---|---|---|
| A1 | `delivery.qingyunAutoPush` config is not `true` (**default off**) | `routes/retail.js:4298`; also `scripts/qingyun-daemon.js:552-564` | Hard (silent) |
| A2 | Pickup/counter order, or no `store_id` | `routes/retail.js:4302` | Hard |
| A3 | `isQingyunSameCityToday()` false — channel not `wechat`/`web`; address not Guangzhou; opt-in same-day outer district without a `today` slot; slot neither `right_away`/`today`/date-less `express`, nor scheduled for today | `routes/retail.js:4303`; `lib/inventory.js:1148, 1166-1200, 1070-1077` | Hard |
| A4 | Store has no `qingyun_status` row | `routes/retail.js:4309` | Hard |
| A5 | Reconcile sweep only picks up orders paid after `delivery.qingyunAutoPushSince`, in status `paid`/`preparing`/`dispatched` | `scripts/qingyun-daemon.js:576-593` | Hard |

**B. Drain-time, before the payload is built.**

| # | Condition | File | Hard / warn |
|---|---|---|---|
| B1 | Row status is not `pending` — the drain selects only `status IN ('pending')`, 3 rows per store per poll (~25 s, `QINGYUN_POLL_MS`) | `scripts/qingyun-daemon.js:598-599, 58` | Hard while it lasts |
| B2 | Store's Chrome session not logged in / in verification cool-down / cold-start warm-up / proxy down — `drainPushQueue` is never reached | `scripts/qingyun-daemon.js:680-714, 822-871` | Soft (row stays `pending`, no attempt spent) |
| B3 | `br.getShop()` fails | `scripts/qingyun-daemon.js:604` | Soft (retry) |
| B4 | Order row gone | `scripts/qingyun-daemon.js:613` | Hard → `error` |
| B5 | Order status is `cancelled`/`refunded`/`delivered` | `scripts/qingyun-daemon.js:622-627`; `lib/qingyun-queue.js:32-35` | Hard → `skipped` |
| B6 | `isQingyunSameCityToday()` false at drain time | `scripts/qingyun-daemon.js:629-633` | Hard → `skipped` |

**C. Payload-build gates (`lib/qingyun-payload.js`) — shared by both push paths.**

| # | Condition | File | Hard / warn |
|---|---|---|---|
| C1 | Missing recipient name, phone, or address text | `:200` | Hard |
| C2 | **Untrusted stored pin, text won't resolve precisely** — the message in question | `:334-339` | Hard |
| C3 | Untrusted stored pin + geocoder unreachable/quota | `:321-325` (+ `lib/qingyun-queue.js:95-105`) | HOLD — stays `pending`, attempt refunded |
| C4 | No stored pin, text won't resolve precisely, and Qingyun's POI fallback returns nothing (fallback is skipped entirely when the text still has Latin characters, `:354`) | `:368-369` | Hard |
| C5 | No stored pin + geocoder unreachable | `:361-367` | HOLD |
| C6 | Drop-off further than `QINGYUN_ABS_MAX_KM` (default 2 × 25 = 50 km) from the collecting store | `:394-399` | Hard, regardless of pin source |
| C7 | Drop-off further than `QINGYUN_MAX_DROP_KM` (default 25 km) **and** pin is not `customer_pin`/`rooftop` | `:400-405` | Hard |
| C8 | Same as C7 but pin *is* `customer_pin`/`rooftop` | `:403` | **Warning only** — ships |
| C9 | Fresh geocode rejected on precision or city mismatch, no stored pin, POI fallback rescued it | `:351-353` | Warning only |
| C10 | Address still English after translation attempt | `:226-229` | Warning only |
| C11 | Stored pin disagrees with a precise text resolve by any distance | `:313-320` | Warning only — resolved point wins |

**D. After the payload.** `br.createOrder()` returning `!ok` throws `create failed (code …)`
(`scripts/qingyun-daemon.js:634-640`) — retryable.

**E. Attempt budget.** `MAX_PUSH_ATTEMPTS` defaults to 5 (`scripts/qingyun-daemon.js:475`).
Each non-hold failure increments; on the 5th the row flips to `error` and ops is paged
(`scripts/qingyun-daemon.js:657-672`). Holds do not spend an attempt (`:651-655`).

### 1.4 Does manual push run the same checks?

**Yes — there is no path that bypasses `buildCreatePayload`.** Two manual entry points exist:

**Retry push** — `POST /api/retail-admin/orders/:id/qingyun/retry-push`
(`routes/retail.js:21890-21916`). It does not push anything itself; it flips the queue row back to
`pending` and lets the daemon re-run the identical path (comment at `:21886-21889`). Its own
blockers:

- no queue row → 404 (`:21893`);
- `qingyun_order_id` already set → returns `already_created` (`:21894`);
- `manualRetryEligible(row)` false → returns `already_queued` (`:21895-21897`).
  `lib/qingyun-queue.js:55-59` allows only `error` and `skipped`:
  ```js
  function manualRetryEligible(row) {
    if (!row) return false;
    if (row.qingyun_order_id) return false;
    return row.status === 'error' || row.status === 'skipped';
  }
  ```
  The SQL carries the same guard (`lib/qingyun-queue.js:75-79`).

**Ship-from override** — `POST /api/retail-admin/orders/:id/qingyun/ship-from`
(`routes/retail.js:21768-21884`). It calls the same builder (`:21810-21815`) with the same deps, so
C1-C11 apply unchanged. It cannot be used to create a first copy: `:21778` rejects any row without
a `qingyun_order_id` (`push_not_completed`).

**Consequence for the reported symptom.** While the row is still `pending` (attempts 1-4, or
parked because of B1/B2), the drawer renders it as `Queued for push…` with no Retry button — the
button is gated on `needs_attention`, which is only set for `status === 'error'`:

- `routes/retail.js:21728` — `needs_attention: q.status === 'error'`
- `public/retail-admin/04-orders.js:3650, 3670-3678` — `refused = sf.needs_attention`; the
  `Retry push` button and the "fix the address and it retries" hint render only when `refused`.

The `push_error` text is shown regardless (`public/retail-admin/04-orders.js:3680`), which is why
the pin message is visible under a row that still says "Queued for push". In that state the manual
retry endpoint is also a no-op by design (`already_queued`), and the automatic requeue-on-address-
change is a no-op too — `REQUEUE_SQL` only matches `status = 'error'` (`lib/qingyun-queue.js:61-64`,
called from `routes/retail.js:21592-21599`, `:7998`, `:17438`, `:20985`). A `skipped` row is a
second blind spot: `manualRetryEligible` accepts it, but the drawer never offers the button for it.

---

## 2. PIN DATA MODEL

### 2.1 Where coordinates live

**Two independent places.**

**(a) The customer address row** — `retail_customer_addresses`, columns added in
`database.js:3229-3245`:

```js
addColumn('retail_customer_addresses', 'lat',         'REAL');
addColumn('retail_customer_addresses', 'lng',         'REAL');
addColumn('retail_customer_addresses', 'geocoded_at', 'DATETIME');
//   geo_source    — 'customer_pin' | 'geocode:amap' | 'geocode:tencent'
//   geo_precision — 'rooftop' | 'street' | 'coarse'
addColumn('retail_customer_addresses', 'geo_source',    'TEXT');
addColumn('retail_customer_addresses', 'geo_precision', 'TEXT');
```

**(b) The order's shipping snapshot** — `retail_orders.address_json`, a JSON blob carrying
`lat`, `lng`, `geo_source`, `geo_precision` alongside the text fields. Written at checkout
(`routes/retail.js:9885-9897`):

```js
lat: address.lat != null ? Number(address.lat) : null,
lng: address.lng != null ? Number(address.lng) : null,
geo_source: address.geo_source || null,
geo_precision: address.geo_precision || null,
```

**The courier push reads only (b)** — `lib/qingyun-payload.js:189` parses `order.address_json`
and everything downstream (`addr.lat`, `addr.geo_source`, …) comes from that blob. The customer
address row is never consulted at push time.

### 2.2 Verified / unverified flag

`geo_source` is the provenance flag; `geo_precision` is the quality grade. Known writers and values:

| `geo_source` | `geo_precision` | Set by |
|---|---|---|
| `customer_pin` | `'rooftop'` (asserted, not measured) | Client sent `pin_source='map'` — `lib/address-pin.js:67-68`; `routes/retail.js:7840-7842` |
| `client_unverified` | `null` | Coordinates in the body with no `pin_source` claim — `lib/address-pin.js:87`; `routes/retail.js:7841` |
| `geocode:amap` / `geocode:tencent` | `'rooftop'` / `'street'` / `'coarse'` — whatever the provider graded | Background geocode `routes/retail.js:7902-7968` (via `lib/address-pin.js:111-121`); checkout fallback `routes/retail.js:9458-9479`; admin order snapshot `routes/retail.js:7979-8000` |
| `null` | `null` | No pin, or the pin was cleared by a text edit (`lib/address-pin.js:89-91`; `routes/leads` n/a; order side `routes/retail.js:20969-20974`) |

`pin_source='map'` is set in exactly four client places, all at the moment of a map tap:
`public/shop.html:1985` and `:3603`, `miniapp/pages/checkout/checkout.js:2800`,
`miniapp/pages/addresses/addresses.js:626`. The server never infers it
(`lib/address-pin.js:17-18, 26-33`).

The trust rule at push time (`lib/qingyun-payload.js:291-292`) accepts `customer_pin` **or**
`geocode:*` at `rooftop`/`street`. Everything else — including `geocode:*` at `coarse`, which is
what a vague or Latin-script address produces — is unverified and must be corroborated.

### 2.3 Can the order pin differ from the saved address pin?

**Yes — they are separate records, and they diverge routinely.**

- Checkout copies the address row's pin into `address_json` once
  (`routes/retail.js:9885-9897`); later edits to the customer address row do not propagate.
- A customer moving the ship-to re-snapshots from the new address row
  (`routes/retail.js:17409-17419`).
- Admin "Edit ship-to" / "Make address Chinese" rewrites the snapshot and **nulls the order's pin
  and its provenance** unless it is a tapped pin (`routes/retail.js:20969-20974`):
  ```js
  const keepOrderPin = addressPin.keepsPinThroughTextEdit(curJson);
  const newJson = { ...curJson, /* text fields */,
    ...(keepOrderPin ? {} : { lat: null, lng: null, geo_source: null, geo_precision: null }) };
  ```
  It can also write the pin back to the customer row separately (`routes/retail.js:21015-21030`).
- `geocodeOrderSnapshotAsync` (`routes/retail.js:7979-8000`) writes a pin onto the order snapshot
  only, for admin-created orders that have no address row behind them.

---

## 3. CHECKOUT

### 3.1 Is map pin selection offered?

**Offered, optional, and skippable on both storefronts. It is never required.**

**Mini-app.** The address form shows a `📍 Choose on map / 地图选点` button next to the WeChat
address-book button (`miniapp/pages/addresses/addresses.wxml:74-79`). It opens the in-app picker
(`miniapp/pages/addresses/addresses.js:488-556`). Save validation requires only name, phone,
street and city (`miniapp/pages/addresses/addresses.js:596-608`); `lat`/`lng`/`pin_source` are sent
as `undefined` when absent (`:623-626`).

**Web (`public/shop.html`).** At checkout the button is rendered **`hidden`**
(`public/shop.html:1968`) and revealed only if `/api/retail/maps-config` reports a JS key:

```js
async function coSetupMapButton(){
  ...
  if(!cfg||!cfg.provider)return;                 // no JS key → leave the button hidden
  b.hidden=false;
```
(`public/shop.html:2189-2197`.) That endpoint needs `AMAP_MAPS_JS_KEY` or `TENCENT_MAPS_JS_KEY` —
a **different key type** from the WebService key `lib/geocode` uses (`routes/retail.js:800-821`).
On the standalone address page the button is always visible but degrades to the region cascade
when no JS key is present (`public/shop.html:3572, 3584-3590`). Save validation requires name,
phone, area and street only (`public/shop.html:1986-1987`, `:3596`).

### 3.2 What is stored when the customer skips the pin

Not null for long. Three writers fill coordinates in from the address *text*, and **all of them
store the result at whatever precision the provider returned, including `coarse`**:

1. **Background geocode on address save** — `routes/retail.js:7902-7968`. `savePin(first, …)` is
   called on the unconditional paths at `:7927` and `:7931` with no precision test, writing
   `geo_source = 'geocode:<provider>'` and `geo_precision = <whatever>`
   (`lib/address-pin.js:111-121`).
2. **Synchronous fallback at checkout** — `routes/retail.js:9458-9480`, for a customer who checks
   out before the background job lands:
   ```js
   address.geo_source = `geocode:${coords.provider || 'maps'}`;
   address.geo_precision = coords.precision || null;
   ```
   These in-memory values are what the order snapshot then freezes (`:9893-9896`).
3. **Order-snapshot geocode for admin-created orders** — `routes/retail.js:7979-8000`, again with
   no precision filter (`:7987` only checks that a result came back).

So the common no-pin path does not leave `lat`/`lng` null at push time — it produces exactly the
state the gate refuses: coordinates present, `geo_source = 'geocode:*'`, `geo_precision = 'coarse'`.
An unflagged client coordinate produces the other refusable state, `client_unverified`
(`lib/address-pin.js:77-88`).

### 3.3 Proportion of orders carrying a pin

**Cannot be determined from this checkout.** This container holds the repository only — there is no
`data/roots.db` and no database credentials in the environment, so no query, heavy or light, is
possible here. I am not inferring a number.

The repository does contain a read-only diagnostic that reports exactly this breakdown per address
and per recent delivery order (`source`, `precision`, city match, Latin text, drift):
`scripts/diagnose_address_pins.js` (`--orders`, `--bad-only`), which opens
`data/roots.db` read-only (`scripts/diagnose_address_pins.js:44`).

---

## 4. GEOCODING

### 4.1 Wired up and in active use

`lib/geocode.js` — two China providers, Amap first with Tencent as automatic fallback
(`lib/geocode.js:1-10, 157-193`), keyed by `AMAP_MAPS_KEY` / `TENCENT_MAPS_KEY`
(`lib/geocode.js:32-33`); `configured()` is `!!(AMAP_KEY || TENCENT_KEY)` (`:628`).

Not dormant. Live call sites:

- **Address save (background)** — `routes/retail.js:7902-7968`
- **Checkout fallback (synchronous)** — `routes/retail.js:9458-9480`
- **Order snapshot for admin orders** — `routes/retail.js:7979-8000`
- **Courier push corroboration / resolution** — `lib/qingyun-payload.js:252-277`, via
  `geocodeAddressResult` (`lib/geocode.js:657-668`)
- **Store routing** — `drivingDistanceKm` / `haversineKm` from `lib/inventory.js`
  (`lib/geocode.js:12-16, 543-626`)
- **Map picker support** — `searchPoi`, `ipLocate` (`lib/geocode.js:347-511`), exposed at
  `/api/retail/ip-locate` (`routes/retail.js:8055+`)

A third geocoder exists as a last-resort fallback inside the push: Qingyun's own POI search,
`br.geocode(text, shop.cityId)` (`lib/qingyun-payload.js:354-359`), tried only when there is no
stored pin and the text contains no Latin characters.

### 4.2 Is there a reverse check the corroboration depends on?

**No.** `reverseGeocode` exists (`lib/geocode.js:266-331`) but its only caller is
`POST /api/retail/reverse-geocode` (`routes/retail.js:8030-8046`), which serves the mini-app map
picker when WeChat hands back bare coordinates with an empty address.

The corroboration in `lib/qingyun-payload.js` is **forward-only**: it re-geocodes the address
*text* and compares the resulting point to the stored pin by Haversine distance
(`lib/qingyun-payload.js:303-312`, `PIN_AGREE_KM` default 0.5 km at `:72-75`). It never asks the
provider what address the stored coordinates correspond to. The other checks it leans on are the
provider's own precision grade (`lib/geocode.js:56-71`) and the region cross-check comparing the
matched city/province against the address text (`lib/geocode.js:76-106`) — both derived from the
forward call, not from a reverse lookup.

---

## 5. ARRIVAL TIME

**Unrelated to the push. An unset arrival time blocks nothing.**

The drawer's `12:00 AM` is the empty state of the manual ETA picker: with `local_eta` unset, the
hour/minute inputs render blank with `placeholder="12"` / `placeholder="00"` and the AM/PM toggle
defaults to `AM` (`public/retail-admin/04-orders.js:3248-3266`); the button reads
`Set arrival time · 设置送达时间` when `eta` is empty (`:3265`).

- The value is `retail_shipments.local_eta`, a `'HH:MM'` string with an `eta_source` of
  `'auto'` or `'manual'` (`routes/retail.js:20485-20486`; writers at `:23379-23403`).
- It is **downstream** of the courier, not upstream: the daemon stamps it from Qingyun's promised
  arrival *after* a courier is dispatched (`scripts/qingyun-daemon.js:409-423`).
- The push payload derives its delivery window from `order.scheduled_for`, never from `local_eta`
  (`lib/qingyun-payload.js:409-411`):
  ```js
  const slotEpoch = order.scheduled_for ? Math.floor(Date.parse(order.scheduled_for) / 1000) : 0;
  const target = (slotEpoch && slotEpoch > Math.floor(Date.now()/1000)) ? slotEpoch : Math.floor(Date.now()/1000) + 3600;
  ```
- `local_eta` appears nowhere in `scripts/qingyun-daemon.js`'s push path or in
  `lib/qingyun-payload.js`. Its readers are the customer order page, the admin drawer, delivery
  reminders and the auto-delivered sweep (`routes/retail.js:6668-6736, 10376-10394,
  14072-14105, 20033-20036`).

The ETA card and the courier push panel are rendered in the same drawer block
(`public/retail-admin/04-orders.js:3295-3302` → `renderQyDispatch` → `renderQyShipFrom`), which is
why the two appear together, but they share no state.
