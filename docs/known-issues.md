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

---

## RECIPIENT-PHONE-UNVALIDATED

**Nothing checks that a recipient phone number can take a rider's call, so a
number the courier will refuse is discovered at push time instead of at
checkout.**

*Area:* same-city courier push × every recipient-phone capture path ·
`lib/qingyun-payload.js`, `routes/retail.js`, `miniapp/pages/{addresses,checkout}`,
`public/shop.html`, `public/retail-admin/{04-orders,08-customers}.js`
*Status:* pre-existing; surveyed and characterised 2026-08-06. The address half
of the same payload validates itself thoroughly (pin provenance, corroboration,
distance ceilings); the phone half has no equivalent at any layer.

### Mechanics

The phone is carried end to end untouched. Every capture path checks that the
field is non-empty and nothing else:

| Path | Check | Where |
|---|---|---|
| mini-app address book | presence | `miniapp/pages/addresses/addresses.js:591` |
| mini-app WeChat import | none — `telNumber` copied verbatim | `miniapp/pages/addresses/addresses.js:421` |
| mini-app checkout | presence | `miniapp/pages/checkout/checkout.js:2424` |
| web address form | presence | `public/shop.html:1986` |
| admin customer address | presence | `public/retail-admin/08-customers.js:2176` |
| admin order edit | none | `public/retail-admin/04-orders.js:912` |
| `POST/PUT /api/retail/addresses` | presence, on a value `normalizeChinaAddress` never touches | `routes/retail.js:7751`, `:8023` |
| `POST/PUT` admin addresses | presence | `routes/retail.js:15345`, `:15382` |
| admin manual order | `/^\+?[0-9]{7,15}$/` — passes every failing shape below | `routes/retail.js:19445` |
| admin order patch | `.trim()` only | `routes/retail.js:20836` |

Checkout does not re-check: `POST /api/retail/orders` snapshots the saved
address row's phone straight onto the order (`routes/retail.js:9759`,
`address.phone`). `buildCreatePayload` then `trim()`s it and posts it as
`recipientPhone` with no transformation (`lib/qingyun-payload.js:191`, `:419`).

So the first thing in the chain that has an opinion about the format is Qingyun,
which answers **`code 40001 请输入合法的收货人电话`**. The daemon treats that as a
retryable error: the row burns all 5 attempts, then lands `status='error'` and
pages ops — for an order nobody can fix without phoning the customer back.

`normalizeChinaAddress` normalises province/city/district/address/detail and
**passes `phone` through raw** (`routes/retail.js:7642`), so the server-side
presence check can be satisfied by whitespace.

### Scope, measured

Across all 421 first-party (`wechat`/`web`) delivery orders, 413 (98.1%) carry a
well-formed mainland mobile. Seven orders across six customers do not; four of
those reached Qingyun and failed:

- **930, 873** (one customer), **868** — 8 digits, no separators, HK-shaped.
- **562** — 9 digits, no separators.
- **872, 842, 281** — same malformed shapes, never queued (not same-city
  same-day), so they never met Qingyun.

The other two error rows in the queue, **483 and 482**, are *not* this defect.
Both are `channel='meituan'` with `recipient_phone IS NULL` and an empty
`address_json` — a marketplace order with no recipient block, enqueued before
`isQingyunSameCityToday` existed. That gate now excludes them twice over
(channel, and no address), so the cause is already closed; the two rows are
inert legacy.

### Why it is bounded

Rare — 4 orders in the dataset's lifetime, 3 customers. Nothing is silently
mis-delivered: the push refuses rather than sending a rider to a number that
cannot be called, and ops is paged. The cost is 5 wasted attempts, an alert, and
a delivery that stalls until someone intervenes.

### Candidate fix

Validate at capture, centralised the way the address pipeline centralised into
`lib/`. The primitive already exists — `normalizeCnMobile` in `lib/aliyun-sms.js`
strips non-digits, unwraps `86`/`086`, and tests `^1\d{10}$` — and wants lifting
into a shared module so a client-side hint and a server-side check read the same
rule. The single server choke point is the address write path
(`POST`/`PUT /api/retail/addresses` plus the two admin equivalents); every
storefront path funnels through it, and the admin order-patch path needs the
same check added.

Validation must be conditional, not global: pickup orders, marketplace channels
and out-of-city deliveries never meet Qingyun, and a rule that blocks them would
reject numbers that are perfectly fine for their order type. The gate is the
same one the push uses — `inventory.isQingyunSameCityToday`.

**Open decision (Ash):** what checkout does when a customer's number cannot take
a rider's call — require a mainland contact number for same-city delivery,
accept with a warning, or accept and flag for ops. Not decided; the fix is not
started pending it.
