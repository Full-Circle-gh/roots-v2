# Shipping rules — Roots' current configuration

**Last updated:** 2026-05-20 · **Status:** a record of one business's setup, verified against the codebase

> **This is NOT a Tacet specification.** It records how **one business** — Roots, in Guangzhou, pricing in ¥ — has its shipping configured today. The two store codes, the Guangzhou district exceptions, the zone/fee table and the currency are that business's settings, not product defaults, and nothing here may be treated as one (`docs/tacet-consolidation-decisions.md` §0). Zones, districts, carriers, currency and thresholds are all per-business configuration.

The retail-admin Logistics tab is the source of truth for per-zone prices/thresholds; this doc describes the policy, the routing, and the customer-visible flows **as Roots configures them**.

---

## Stores

| Code | Role | Ships to |
|---|---|---|
| `tianhe` (Warehouse) | Warehouse | GZ exceptions, all out-of-GZ, all nationwide. Also fulfills main GZ when GPS-nearer than yuexiu. |
| `yuexiu` (Store) | Shop | Main GZ only, when GPS-nearer than tianhe. Does NOT ship out of GZ. |

Routing logic (`lib/inventory.js → routeOrder`):
- Address geocoded to lat/lng (Tencent Maps), falls back to district-name matching if no geo.
- For main GZ orders: pick whichever store is GPS-nearer.
- For GZ exceptions + non-GZ orders: always `tianhe` (Warehouse).
- If picked store is OOS: trigger OOS choice flow (see below).

---

## Group 1 — GZ Main

**Districts:** 越秀 · 黄埔 · 荔湾 · 天河 · 海珠 · 白云

| Dimension | Rule |
|---|---|
| Routing | GPS-nearest of `tianhe` / `yuexiu` |
| Flat fee | ¥15 |
| Free above | ¥199 |
| Surcharges | None |
| Method | On-demand rider — ops picks 跑腿 / JD达达 / 闪送 per order |
| Cutoff | Same-day until 20:00 (kitchen 10:00–20:00, 7 days/week) |
| Slots | ASAP · 10-12 · 12-14 · 14-17 · 17-19 · 19-21 · next-day · multi-day calendar (14 days) |

---

## Group 2 — GZ Exceptions

**Districts:** 番禺 · 花都 · 南沙 · 从化 · 增城

| District | Next-day fee | Free above | Same-day surcharge |
|---|---|---|---|
| 番禺 Panyu | ¥15 | ¥199 | +¥20 |
| 花都 Huadu | ¥25 | ¥199 | +¥30 |
| 南沙 Nansha | ¥25 | ¥199 | +¥40 |
| 从化 Conghua | ¥25 | ¥199 | +¥40 |
| 增城 Zengcheng | ¥25 | ¥199 | +¥40 |

- Routing: always `tianhe` (Warehouse)
- Default method: express courier (SF / JD), next-day
- Same-day option: on-demand rider, surcharge above is **always charged** (never covered by free-ship threshold)
- Same-day customer sees **"ASAP today" only** — no window picker
- Default customer sees next-day + multi-day (14d) calendar

---

## Group 3 — Other cities / regions

| Region | Flat fee | Free above |
|---|---|---|
| Other GD cities (深圳/珠海/韶关 + 17) | ¥15 | ¥299 |
| Other provinces (上海/江苏/浙江 + 36) | ¥25 | ¥329 |
| Tibet / Xinjiang | ¥29 | ¥329 |
| Hong Kong (中西区/东区 + 16) | ¥50 | ¥500 |
| Default fallback | ¥25 | ¥329 |

- Routing: always `tianhe` (Warehouse)
- Items: everything ships (incl. cold-chain) — customer accepts risk
- Schedule copy: *"Ships within 1-2 working days"*
- No slot picker

---

## Slot picker rules

| Rule | Behavior |
|---|---|
| ASAP visibility | Always shown; greyed out + reason when kitchen closed (e.g. *"Closed — reopens 10am tomorrow"*) |
| Per-slot cutoff | Slot closes when slot **ends** (no lead-time buffer) |
| After 20:00 close | Same-day fully hidden — only next-day + multi-day calendar |
| Closed days | Open 7 days/week, **no blackout dates** |
| Holiday mode | Boolean + custom message in retail-admin. When ON: customer can still order; checkout shows banner *"Orders ship when we're back from holiday"* |
| Booking horizon | 14 days ahead (multi-day calendar) |
| Slot capacity | No cap — unlimited orders per slot |
| Tier privileges | None — same slots & rules for everyone |

### Per-group slot visibility

| Group | What customer sees |
|---|---|
| GZ main | Full picker: ASAP · windows · next-day · multi-day (14d) |
| GZ exceptions — default (next-day courier) | Next-day + multi-day (14d). No same-day windows. |
| GZ exceptions — same-day surcharge chosen | "ASAP today" only — no window choice |
| Other cities | No slot picker — checkout shows *"Ships within 1-2 working days"* |

---

## Out-of-Stock flow

### GZ main + exceptions (two-store)
Live stock check **before payment**, against the GPS-assigned store. Race-condition fallback: 'Pay' button blocks if stock changes between cart and pay tap → re-surface OOS choice.

**If nearest store is out:**
1. **Ship from other store** — we absorb extra rider cost
2. **Replace** with any in-stock item — any price; top up or refund the diff
3. **Cancel just the missing item** — keep rest of order
4. **Cancel entire order**

**If both stores out:** same 4 minus "ship from other store", plus **backorder/wait**.

Backend: `lib/inventory.js → analyzeShortage` + `routes/retail.js` checkout/quote (lines 6207-6394).
DB: `retail_orders.fallback_choice` ∈ `cancel_missing | replace_missing | full_from_fallback | wait_for_restock`.

### Other cities
- Stock check = `tianhe` warehouse only.
- Stock = 0 → item shows OOS in mini-app, cannot add to cart.
- No post-pay OOS flow.

---

## Edge cases

### GZ
| Scenario | Rule |
|---|---|
| Not home | Case-dependent: leave at 丰巢/guardhouse with photo, OR ops calls customer |
| Address change pre-dispatch | Allowed if same district & before cutoff |
| Add items pre-dispatch | Allowed if stock & before cutoff; pays difference |
| Damaged / wrong / missing | Case-by-case, ops decides refund vs redeliver |

### Other cities
| Scenario | Rule |
|---|---|
| Return-to-sender | Full refund only after goods returned intact |
| Cold-chain spoilage | Case-by-case |
| Mid-transit address change | Same-city only, via ops contact |
| Lost package | Case-by-case |

---

## Implementation references

| Area | File:Line |
|---|---|
| Zone schema | `database.js:1782-1899` |
| Store schema | `database.js:2185-2203` |
| Per-store stock | `database.js:2205-2217` |
| Order fallback fields | `database.js:2146-2147` |
| Excluded districts (no same-day) | `database.js:2161` → `storefront_config['routing.gz_express_excluded_districts']` |
| Zone admin API | `routes/retail.js:6488-6578` |
| Zone admin UI | `public/retail-admin.html:3765-3933` (Delivery tab) |
| Address → zone match | `routes/retail.js → matchDeliveryZone` (line 5619) |
| Slot computation | `routes/retail.js → computeDeliverySlots` (line 5688) |
| OOS pre-pay analysis | `lib/inventory.js → analyzeShortage` (line 666) |
| Store routing | `lib/inventory.js → routeOrder` (line 103) |
| Quote endpoint | `routes/retail.js:6207-6394` (POST `/api/retail/checkout/quote`) |
| Order endpoint | `routes/retail.js:1170-1850` (POST `/api/retail/checkout/orders`) |
