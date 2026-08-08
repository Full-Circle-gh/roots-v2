# Delivery point confirmation — build spec

**Status:** approved for build
**Date:** 6 August 2026
**Supersedes:** nothing. New flow.
**Depends on:** `docs/qingyun-push-gate-survey.md` (branch `claude/order-988-gd9vwb`)

---

## 1. The problem

Three writers (background geocode, checkout fallback, admin snapshot) fill delivery coordinates from address text. None filters on precision, so they store `geocode:amap` at coarse grade. The payload builder then refuses exactly that state — originally at `lib/qingyun-payload.js:337`, now the `NEEDS_POINT_MESSAGE` throw around `:366` after stages 1 and 2.

The system manufactures the condition it rejects. No customer or operator has to do anything wrong.

Compounding it, the refusal is presented as an error with no way out:

- Retry is gated on `status === 'error'` (`routes/retail.js:21728`), so a `pending` row shows the error text with no Retry button.
- The requeue-on-address-change hook only matches `error` rows, so editing the ship-to on a `pending` row does nothing.
- `skipped` rows are accepted by the retry endpoint but never offered in the UI.

Map pin selection is optional in both storefronts, so the coarse path is the common path, not an edge case.

## 2. The principle

A coarse point is not a failure. It is an unfinished step.

The system already knows the difference between a trustworthy point and a guess — `geo_source` and `geo_precision` are recorded correctly. What is missing is a state that says "this needs a human to confirm the point" and a place to do it.

Precise is not the same as correct. A rooftop-grade match can still be the wrong building if the address text is wrong. We do not block on that; the rider phones on arrival.

## 3. Locked decisions

| # | Decision |
|---|---|
| D1 | Trustworthy points dispatch untouched. No map, no confirm, no extra tap. |
| D2 | "Trustworthy" is exactly what the gate already accepts: `geo_source = customer_pin`, or `geocode:*` at rooftop or street grade. |
| D3 | Coarse points enter a new state, `needs_point`. It is not an error state. |
| D4 | Operator confirms the point on a map inside the order drawer. |
| D5 | A confirmed point applies to that order only. It never writes back to the customer's saved address. |
| D6 | With auto-push off, a `needs_point` order holds indefinitely. Dispatch is attended; someone opens every order. |
| D7 | With auto-push on, the tenant chooses: hold indefinitely, or push the guessed point after a fixed delay. |
| D8 | The fallback delay is fixed in code, not configurable. |
| D9 | This is not a separate setting. It hangs off the existing auto-push setting. |
| ~~D10~~ | ~~Orders list gets a filter chip: **Needs delivery point · N**.~~ **DROPPED 2026-08-08 — stage 4 DECLINED, not deferred. See §6.** |
| D11 | Dashboard gets a worklist block listing the parked orders **themselves** — not a count, and not a link into a filtered Orders list. Amended 2026-08-08; see §7. |
| D12 | New orders only. Existing stuck `pending`, `error` and `skipped` rows are not migrated. |
| D13 | A genuine contradiction (stored pin conflicts with address text) stays a warning, but resolves through the same map. It never dead-ends. |

## 4. State model

Add `needs_point` alongside the existing queue states.

Entry: the payload builder hits the coarse-precision refusal (the `NEEDS_POINT_MESSAGE` throw, around `lib/qingyun-payload.js:366`). Instead of erroring, it sets `needs_point` and records the coarse point plus its grade.

Exit:
- Operator confirms a point → back to `pending`, normal push, attempts counter reset.
- Auto-push fallback fires (D7, tenant opted in) → push with the guessed point, flagged in the order timeline as an unconfirmed dispatch.
- Order cancelled or refunded → state discarded with the order.

`needs_point` does not consume retry attempts. Nothing about it is flaky — the survey confirms the geocode result is memoised per call and cached seven days by address string, so retrying is pointless by construction. Attempts only start once a real point exists.

### 4.1 Where the point is recorded

The coarse guess lives on the queue row. A confirmed point lives in the order's `address_json` snapshot (§5.1) — never in `retail_customer_addresses`.

The distinction matters because the accept rule reads `addr.geo_source` out of `order.address_json` (`lib/qingyun-payload.js:189`). A confirmed point recorded only on the queue row is invisible to the check that has to accept it, and the row will bounce.

The payload builder is deliberately dependency-free and holds no db handle (`lib/qingyun-payload.js:14-16`), so it cannot persist the guess itself. It signals the caller the way `geoHoldError` already does (`:149-155`), and the daemon and the ship-from route persist the result. Four nullable columns on the queue table, added through the existing idempotent helper: `needs_point_at`, `guessed_lat`, `guessed_lng`, `guessed_precision`.

`retail_customer_addresses` is the customer's address as given. A coarse point derived by the system is Tacet's working guess; a confirmed point is an operator's correction for one dispatch. Neither belongs in the customer's saved record — that is D5 restated at the data layer. `retail_orders.address_json` is the order's own snapshot, which is exactly where a per-order correction belongs.

### 4.2 Stage 1 lands invisible

`qingyunShipFromState` maps anything that is not `error` to `needs_attention: false` (`routes/retail.js:21728`), so after stage 1 a `needs_point` row still reads as "Queued for push…" in the drawer. That is expected and acceptable. Stage 1 changes behaviour, not appearance; the state becomes visible to staff in stage 2.

Note that the drain (`scripts/qingyun-daemon.js:599`) and the held-order alert (`:527`) both filter on `status = 'pending'`, so `needs_point` rows drop out of the daemon's attention automatically. This is the intended outcome: it is what stops the paging.

## 5. Drawer

Replaces the current dead-end block in the shipment section.

**Heading:** Confirm delivery point
**Body line:** We could not place this address precisely. Check the point and confirm.

Below that:

- A map, roughly 240px tall, showing the AREA the address resolved to — a dashed circle around a hollow centre, labelled *Approximate · 大致位置*. **No pin is dropped.**
- The full Chinese address text above the map on a phone and beside it on desktop, unchanged and selectable, so the operator can read it against the map.
- The precision grade stated in plain words — "Placed to district level" or "Placed to block level", not `geocode:amap/coarse`. A grade that was never recorded says so in words; it is never a dash.
- Primary action: **Place the point** — *disabled*. It becomes **Confirm and dispatch**, enabled, once a point exists.
- Secondary action: **Edit ship-to**, existing behaviour, which re-runs the lookup on save.

**There is no point yet, so there is nothing to confirm.** This is the rule the surface enforces, and it is stronger than "you must interact before confirming".

A coarse match is an area, not a point: the system does not know where the door is, it knows a region. So the map opens with the region drawn and nothing else. The operator taps where the door is; the circle collapses and a solid pin stands on that spot. Only then is there something to confirm.

The weaker rule — require a gesture, then allow the confirm — is not enough. A gate satisfied by interaction is satisfied by a 1px nudge of a marker sitting on the district centre, and confirming that stamps `staff_pin` onto a centroid, which then passes both trust checks in §5.1. That is precisely the laundering those checks exist to prevent, performed by a person instead of by code. With no marker to nudge, there is nothing to launder.

D1 is untouched. A trusted point never parks, so no order that was already precise ever reaches this surface, and no extra tap is added to any of them.

Copy follows the same model: strings describe the STATE, not a marker. "No point placed yet · 尚未标记配送点" before placement, "Point placed · 配送点已标记" after. Nothing says "not moved yet", because before a placement there is no point to have moved.

No separate confirmation dialog on Confirm and dispatch. The map *is* the confirmation step; a second modal would be asking the same question twice. This is a deliberate exception to the blast-radius-confirm rule for live-customer actions, and the reason is recorded here. Rescheduling (§5.2) is not an exception and keeps its confirm.

For the D13 contradiction case, the same surface is used with a different heading — **Delivery point may be wrong** — and both candidate points shown, the stored one and the freshly geocoded one, either selectable. Distinguished by shape and number (square **1** / circle **2**, a dashed link between them, the existing `.od-seg` control below), never by colour alone.

**Not reachable as built, and deliberately not wired.** When a stored pin disagrees with a precise text resolve, the builder does not park the order — it warns and ships the resolved point (`lib/qingyun-payload.js`, the `verdict.ok` branch above the `needs_point` throw). So no order can currently enter this state, and stage 3 does not build a surface nothing reaches. The design stands; making it reachable means giving that branch its own parked state, which is a separate decision.

### 5.1 What a confirmed point records

A confirmed point is written with `geo_source = 'staff_pin'`. Not `customer_pin`.

`customer_pin` means the customer tapped this spot. `lib/address-pin.js` exists to prevent that claim being made on their behalf, and defeating it would also make a staff guess survive later address edits through `keepsPinThroughTextEdit` (`:98-100`) — a corrected street would keep a point chosen against the old one.

Two trust checks must therefore learn about `staff_pin` explicitly:

1. The accept rule at `lib/qingyun-payload.js:343-344` gains a third clause. Without it the drain re-geocodes, gets the same coarse answer, and re-parks the row — the operator confirms and watches it bounce back with no explanation.
2. The distance predicate at `:446` names `staff_pin` directly. It is a different test from the accept rule and governs whether a drop beyond `MAX_DROP_KM` (25 km) warns or refuses.

No precision grade is invented. A `staff_pin` is not recorded as rooftop to slip past the distance check; the check names the source instead. Nothing in the data should assert a confidence that was never measured.

The `ABS_MAX_KM` ceiling (50 km, `:453`) still applies and is not overridden by confirmation. Past that there is no same-city rider trip whatever anyone confirmed.

A `staff_pin` does not survive an address text edit. The point was chosen against the old text; if the text changes it is discarded and the order re-parks. This is D5 holding at the edges.

**On D2.** This widens the accept rule, which D2 said not to touch. The widening is deliberate and consistent with D2's intent: the rule was written to stop the automatic path weakening itself, and a human deliberately pointing at a building is a stronger signal than anything already on the list. D2 is amended to: automatic sources are unchanged; a new explicitly-human source is added.

### 5.2 Expiry for date-scheduled orders

The drain re-checks `isQingyunSameCityToday` on every pass (`scripts/qingyun-daemon.js:629-633`). Slot kinds `right_away` and `today` never expire. A date-scheduled order compares its promised day against today, so one parked on Monday and confirmed on Wednesday is retired to `skipped` the moment it re-enters the queue.

This is not recoverable by retry — a past date cannot become today.

- **Warn before.** A date-scheduled order still awaiting a point on the day before its promised date is surfaced through the existing dashboard line and Orders chip. No ops page, no new alert channel.
- **Distinguish after.** An expired order shows as **Delivery date passed**, not as a refusal. They are different problems and must not wear the same badge.
- **Offer a way out.** The drawer offers **Reschedule delivery** on an expired order, which sets a new date and returns the row to the queue. Confirming the point and rescheduling are one flow when both are needed.

Rescheduling changes what the customer was promised, so it takes a blast-radius confirm naming the old date and the new one. This is a live-customer action and the general rule applies; the confirm-the-point step does not, because there the map is itself the confirmation.

**How it re-enters the queue.** An expired row is `skipped`, which stage 2 deliberately excluded from the automatic requeue hook, and the customer reschedule endpoint (`routes/retail.js:17234`) makes no call into the queue at all. Reschedule routes through `MANUAL_RETRY_SQL`, which already accepts `skipped`, rather than adding a fourth statement. This is consistent with the stage 2 reasoning: a `skipped` row returns to the queue only by deliberate human action, and choosing a new delivery date is exactly that.

**Write order, which is the whole thing.** The new `scheduled_for` goes onto the order FIRST and the queue row is requeued SECOND, both inside one transaction across the two tables. Reversed, the drain polls every ~25s and re-reads `isQingyunSameCityToday` off the order: it would find the OLD passed date on a row that had just returned to `pending` and retire it again within the poll — a reschedule that silently did nothing.

**Today only, until stage 6.** The date list offers one option: today. Not today plus greyed-out future dates — an option you can see but not choose still says it is coming, and it is not.

A future date would write onto the order and requeue cleanly, and then be retired the next morning, and every morning after: nothing re-queues a `skipped` row on its own day, so the drain re-checks `isQingyunSameCityToday` on each pass and a tomorrow-dated order fails it today. The operator would pick Friday, watch it be accepted, and find it gone with no error and no trace — the same silent no-op this build exists to remove, with a caption on it. A warning sentence does not make that acceptable, so the option is not offered.

The gate is in the endpoint as well as the UI (`today_only`), so an API caller gets the same answer as a button. For any other day the copy says the delivery has to be created by hand in the Qingyun app; it never implies Tacet will pick it up later.

**Stage 6 dependency.** Multi-day reschedule unlocks when a `skipped` row can be re-queued on its own morning — i.e. when the queue can hold a row that waits for its day instead of being retired on sight. That is the same missing capability D6/D9 need (§5.3), and both should be settled together.

**Stage 3 ships with expiry visible only in the drawer.** The dashboard line and Orders chip it otherwise leans on do not exist until stages 4 and 5. Acceptable, since stages 1–3 deploy together and a parked order is still visible in the drawer with a Retry button from stage 2.

### 5.3 Open problem: D6 describes a state that cannot occur

With auto-push off, `maybeEnqueueQingyunPush` never inserts a row (`routes/retail.js:4298`) and the drain returns immediately (`scripts/qingyun-daemon.js:552`). No row exists, so nothing can reach `needs_point`. The ship-from route cannot rescue it either, since it refuses any order without an existing Qingyun copy.

This means D9 — hanging the hold-or-fallback choice off the auto-push setting — rests on a distinction that does not currently exist in the code. It does not bite until stage 6, and it is recorded here so it is not rediscovered then. Stage 6 must either give the manual path its own route into the queue, or D6 and D9 need rewriting.

## 6. Orders list — ⛔ DECLINED 2026-08-08

> **Stage 4 was declined, not deferred.** There is no Orders filter chip and none
> is planned. D10 is dropped. This section is kept, struck through, so the idea
> is not rediscovered and built later as an oversight.

~~Filter chip **Needs delivery point** with a Graphite-filled count pill,
matching existing chip pattern. No new pattern.~~

~~Rows in this state use the existing unseen/attention row treatment. They do
not get a new colour.~~

**Why it was declined.** The chip was only ever a way to *reach* the parked
orders, and §7 now reaches them directly: the dashboard block lists the orders
themselves and each row opens its own drawer. A chip would be a second route to
the same place, and a filter that exists to be a shortcut to a list of five is a
list of five wearing a filter's clothes. Ash's call.

The consequence to know: **the dashboard block is now the only surface that
gathers parked orders.** Nothing else counts them, and nothing else warns about
a promised day (§5.2). If that block is ever removed, the warning goes with it.

## 7. Dashboard

A **worklist block** listing the parked orders themselves — one row per order,
not a count and not a link to a filtered list.

Each row: order number, customer name, store, and the promised day when the
order is date-scheduled. Clicking a row opens that order's drawer, straight to
the confirm surface (§5).

Rules:

- **Absent entirely when nothing is parked.** Not an empty state, not a zero.
  Every other dashboard block renders a "nothing waiting" line; this one does
  not exist at all, because a delivery point is either owed or it is not.
- **`needs_point` only.** `error` and `skipped` rows are the untouched backlog
  (D12) and would fill this with noise it cannot resolve.
- **Capped at five**, with a line saying how many more. No pagination on a
  dashboard.
- **Sorted by urgency:** date-scheduled orders promised soonest first, then
  everything else oldest-parked first.
- **An order promised tomorrow is marked on its row.** This is the §5.2
  day-before warning, and with stage 4 declined this block is the only place it
  appears outside the drawer.

Brand: Variant C — plain background, rule separator, no card box on the rows.
Inter; headings 600; figures 700 and tabular. No Dusk: nothing here is the
system acting on its own, it is a list of work a person must do. **Never a dash
as a value** — a missing field is said in words.

## 8. Retry and requeue fixes

Three narrow corrections, all inside the existing dispatch paths:

1. Retry availability must key off "is this actionable" rather than `status === 'error'` (`routes/retail.js:21728`). `needs_point` and `skipped` are both actionable.
2. The requeue-on-address-change hook must match `needs_point` rows as well as `error` rows, so editing a ship-to re-runs the lookup.
3. The refusal message is currently inaccurate. It says the pin "could not be corroborated from the address text", but corroboration is forward-only — the gate never checks where the stored point falls. Reword to describe what actually happened: the address could only be resolved to a coarse area.

## 9. Explicitly out of scope

- Migrating the existing backlog (D12). Those clear by hand. Whether a one-off cleanup is worth it is a separate decision.
- Making pin selection mandatory at checkout. Customers will not change behaviour and the design does not require them to.
- The web storefront's pin button staying hidden unless a separate maps JS key is configured. Real, but a configuration issue, not this build.
- Reverse geocoding in the gate. `reverseGeocode` exists but serves only the mini-app map picker. Not needed here.
- Arrival time. The survey confirms it is unrelated; `local_eta` is written after dispatch and the payload window comes from `scheduled_for`. The 12:00 AM is an empty picker.

## 10. Build order

1. ✅ State model and gate change — `needs_point` instead of refusal.
2. ✅ Retry and requeue corrections (§8).
3. ✅ Drawer confirm surface, including the `staff_pin` provenance and trust-check clauses (§5.1), the expired badge, and Reschedule delivery (§5.2). Designed as a mockup before it is built.
4. ⛔ ~~Orders chip.~~ **DECLINED 2026-08-08 — see §6. Not deferred. Do not build it.**
5. Dashboard worklist block (§7). Numbered 5 for continuity; it is now the stage that follows 3.
6. Auto-push fallback (D7), last, since it is the only part Roots does not use.

Each stage ships and is verified before the next begins.

**Stage numbering is deliberately not compacted.** Renumbering 5 → 4 would make
every earlier reference to "stage 4" — in this document, in commit messages, and
in `docs/qingyun-push-gate-survey.md` — point at the wrong thing, and the one
fact worth preserving is that stage 4 was considered and declined rather than
skipped. A gap in the numbering is the record.
