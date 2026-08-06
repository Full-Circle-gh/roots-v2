# Delivery point confirmation — build spec

**Status:** approved for build
**Date:** 6 August 2026
**Supersedes:** nothing. New flow.
**Depends on:** `docs/qingyun-push-gate-survey.md` (branch `claude/order-988-gd9vwb`)

---

## 1. The problem

Three writers (background geocode, checkout fallback, admin snapshot) fill delivery coordinates from address text. None filters on precision, so they store `geocode:amap` at coarse grade. The payload builder at `lib/qingyun-payload.js:337` then refuses exactly that state.

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
| D10 | Orders list gets a filter chip: **Needs delivery point · N**. |
| D11 | Dashboard gets an attention worklist line that opens Orders filtered to that chip. |
| D12 | New orders only. Existing stuck `pending`, `error` and `skipped` rows are not migrated. |
| D13 | A genuine contradiction (stored pin conflicts with address text) stays a warning, but resolves through the same map. It never dead-ends. |

## 4. State model

Add `needs_point` alongside the existing queue states.

Entry: the payload builder hits the coarse-precision refusal at `lib/qingyun-payload.js:337`. Instead of erroring, it sets `needs_point` and records the coarse point plus its grade.

Exit:
- Operator confirms a point → back to `pending`, normal push, attempts counter reset.
- Auto-push fallback fires (D7, tenant opted in) → push with the guessed point, flagged in the order timeline as an unconfirmed dispatch.
- Order cancelled or refunded → state discarded with the order.

`needs_point` does not consume retry attempts. Nothing about it is flaky — the survey confirms the geocode result is memoised per call and cached seven days by address string, so retrying is pointless by construction. Attempts only start once a real point exists.

## 5. Drawer

Replaces the current dead-end block in the shipment section.

**Heading:** Confirm delivery point
**Body line:** We could not place this address precisely. Check the point and confirm.

Below that:

- A map, roughly 240px tall, with the guessed point already dropped and draggable.
- The full Chinese address text beside or beneath the map, unchanged and selectable, so the operator can read it against the map.
- The precision grade stated in plain words — "district level" or "block level", not `geocode:amap/coarse`.
- Primary action: **Confirm and dispatch**.
- Secondary action: **Edit ship-to**, existing behaviour, which re-runs the lookup on save.

No separate confirmation dialog on Confirm and dispatch. The map *is* the confirmation step; a second modal would be asking the same question twice. This is a deliberate exception to the blast-radius-confirm rule for live-customer actions, and the reason is recorded here.

For the D13 contradiction case, the same surface is used with a different heading — **Delivery point may be wrong** — and both candidate points shown, the stored one and the freshly geocoded one, either selectable.

## 6. Orders list

Filter chip **Needs delivery point** with a Graphite-filled count pill, matching existing chip pattern. No new pattern.

Rows in this state use the existing unseen/attention row treatment. They do not get a new colour.

## 7. Dashboard

One worklist line in the attention area:

> 3 orders need a delivery point

Plain background, rule separator, no card box — Variant C. Inter, tabular figures on the count. Clicking opens Orders with the chip applied. Line is absent entirely at zero, never rendered as an empty or dashed value.

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

1. State model and gate change — `needs_point` instead of refusal.
2. Retry and requeue corrections (§8).
3. Drawer confirm surface.
4. Orders chip.
5. Dashboard line.
6. Auto-push fallback (D7), last, since it is the only part Roots does not use.

Each stage ships and is verified before the next begins.
