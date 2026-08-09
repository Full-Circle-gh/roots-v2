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
*Status:* **FIXED, pending deploy** — built on `claude/recipient-phone-warn-flag`,
not yet merged or shipped. Surveyed 2026-08-06; decided and built the same day.
The address half of the same payload validates itself thoroughly (pin
provenance, corroboration, distance ceilings); the phone half had no equivalent
at any layer. Everything below the Mechanics heading describes the behaviour as
it was, and stays for the record until this ships — then this entry moves out of
known-issues, because it will no longer be one.

### Decided (Ash, 2026-08-06)

**Checkout never blocks on phone format.** Not for a foreign number, not for a
malformed one, not for anything. Three changes instead, none of which can stop
an order:

1. **Warn the customer at checkout** — only when a same-city rider is actually
   going to carry the order, and only when a number is present but can't be
   rung. Inline, with a way to correct it on the spot, and the order proceeds
   either way.
2. **Flag ops at enqueue** — one alert per order, the moment it joins the push
   queue, so someone can ring the customer while the push runs rather than after
   it fails.
3. **Stop retrying a rejection that can't improve** — a `40001` that clearly
   names the recipient phone ends the row at the FIRST failure instead of the
   fifth, with a reason the order drawer already renders and a Retry that works
   once staff correct the number.

The reason it warns rather than rejects is at the top of `lib/phone-cn.js`:
Qingyun's accepted format is still not documented, so the `^1\d{10}$` rule is
inferred from which numbers they refused. An inference is good enough to warn a
customer and to stop wasting attempts; it is not good enough to turn a paying
customer away.

### Decided during verification (2026-08-09)

Four things the review settled, recorded here because none is obvious from the
diff.

**A leading `+` is decisive, and this fixed a worse bug than the one it targeted.**
`^1\d{10}$` matches every US and Canadian number in E.164 form — `+1 415 555
2671` is eleven digits beginning 1 once the `+` is stripped. The first version
tested the digits and ignored the `+`, so a foreign number was called mainland,
stored as `14155552671`, and never warned about. Worse, the same rule sits under
`normalizeCnMobile`: `+13800138000` (country code 1) was rewritten to the
mainland number `13800138000` — **a real, different subscriber** — so an SMS or
a login OTP would have gone to a stranger. A `+` now means international unless
it is `+86` wrapping an actual mobile, and such a value is stored exactly as
typed. This deliberately NARROWS what SMS accepts, which the first review
certified as widening-only; the narrowing is exactly the `+`-prefixed non-`+86`
set, verified over a 441-input corpus, and every mainland form still passes.

**A bare `14155552671` is read as mainland.** Without the `+` the two are the
same eleven digits and nothing in the value says which was meant. For a
Guangzhou grocery the mainland reading is overwhelmingly the likelier one, and
being wrong costs a warning that doesn't appear — never a rejected order.

**The `recipient_name` trim is intentional and kept.** The two POST address
routes also tightened the name to a trimmed presence check. That is scope beyond
"phone", and it stays: it is the same whitespace hole in the same funnel — a
field of spaces satisfying a truthiness check and reaching the waybill as blank
— and fixing one while leaving its neighbour would be odd. Presence only; no
name format is judged.

**Two limitations accepted, not fixed.** A separator-only extension with no
words (`13800138000-8001`) keeps every digit but loses the hyphen; and
`HAS_WORDS` recognises Latin and CJK, so a note in kana or Cyrillic would be
reformatted rather than preserved. Both are vanishingly rare for a Guangzhou
delivery address, neither can drop a digit or fail a presence check, and
`转8001` / `ext 8001` are preserved verbatim. Recorded at the top of
`lib/phone-cn.js` so the next reader does not rediscover them as bugs.

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

### What was built

`lib/phone-cn.js` — the rule, lifted out of `lib/aliyun-sms.js` (which now
consumes it, contract unchanged). `normalize` for comparing, `isMainlandMobile`
for the question, and `normalizeForStorage` for what gets written: deliberately
timid, so a field holding a note keeps its words, a number it can't parse keeps
its original, and only a mainland country code is ever dropped. The mini-app
and `shop.html` carry their own copies of the same regex because they are
separate bundles; a test asserts all three agree, shape by shape.

**Storage** — the five paths that write a phone all normalize now, including the
admin order patch, which sits outside the address funnel and writes
`retail_orders` directly. The whitespace-only hole is closed at its root:
`normalizeChinaAddress` used to pass `phone` through untouched, so `'   '`
satisfied every presence check; it now trims, and the presence checks test
trimmed values. Both partial-update PUTs needed the normalization applied
separately — an edit that changes only the phone skips `normalizeChinaAddress`
entirely, and that is precisely the edit this feature asks customers to make.

**Checkout notice** — `POST /api/retail/checkout/quote` returns
`same_city_rider`, computed with `inventory.isQingyunSameCityToday`, the same
predicate the enqueue hook and the daemon use. The clients never re-implement
the gate, so the notice can't claim a rider is coming when none is. Quote-time
caveat: `scheduled_for` isn't resolved yet, so an Express pick that will land
today reads as not-eligible and shows nothing — under-showing an advisory is
the harmless direction.

**Ops flag** — one alert per order, gated on the enqueue `INSERT OR IGNORE`
reporting `changes === 1`. That is the entire throttle: a requeue is an UPDATE
and a re-run of the hook ignores, so neither can page twice. Both enqueue points
carry it (the app hook, and the daemon's reconcile sweep, which is the only path
a cash/COD/mark-paid order takes).

**First-failure stop** — `qingyunQueue.pushFailureOutcome` decides what a failed
attempt means, so the one-attempt-vs-five rule is testable without a courier
account. Classification is conservative on purpose: Qingyun must have actually
answered (a structured code came back), and the message must name both the
recipient and a phone. The code is deliberately not part of the test — `40001`
is the generic invalid-parameter code and identifies nothing on its own, while
the message is the evidence. Anything unclear keeps all five attempts, because
being wrong in that direction only wastes attempts, while being wrong the other
way abandons a recoverable order after one try.

Tests: `scripts/test_recipient_phone.js` (55 assertions), `npm run test:phone`.

### Still true after the fix

The numbers this warns about are still delivered — that is the decision, not an
oversight. A customer with only a Hong Kong number places their order, ops is
told at once, the push is refused once rather than five times, and someone rings
them. What changed is that nobody finds out by accident.
