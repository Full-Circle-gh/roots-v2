# Tacet delivery vocabulary — locked

**v1.1 · 2026-08-03 · adds the orders-list plan kickers. Locked by Ash. Derived from `docs/tacet-delivery-status-survey.md` (same date). This document is a SPECIFICATION: every delivery/fulfilment word on every surface must come from these tables. The survey records what existed; this records what is allowed.**

## Rules

1. **Two registers, one word each.** The OPERATOR register covers the admin (orders list, drawer, dashboard, chips, exports). The CUSTOMER register covers the mini app, web store, notifications, the customer timeline, and the printed slip. Within a register, each state has exactly one EN string and one CN string. Cross-register differences are deliberate; within-register differences are defects.
2. **Estimates and actuals never share a label.** An estimate (promised or predicted future time) is labelled `ETA` (operator) or `Estimated arrival` (customer). A recorded event time is labelled `Arrived`. The bare word `arrival` is banned as a user-facing label — it asserts a past event and has been used for estimates.
3. **No estimate survives completion as the live line.** Once an order is delivered, cancelled or refunded, no surface may present an ETA as its primary/live state. A never-resolved ETA on a closed order may render as historical (`ETA · 预计送达`, settled grey), never as an active promise.
4. **CN strings are locked here.** Never compose new Chinese; copy from these tables. Additions require an amendment to this document.
5. **Notifications branch on fulfilment type.** A pickup customer is never told an order "shipped" or "was delivered"; a counter sale sends no shipping copy at all.
6. **Labels have one definition site.** `lib/tracking.js` owns tracking-code and scenario labels; surfaces reuse `label_en`/`label_cn` and never relabel.
7. **Pickup and counter relabels are register entries, not new states.** One status column, per-fulfilment words applied at render, from these tables only.

## Order status — operator register

| status | fulfilment | EN | CN |
|---|---|---|---|
| `pending_payment` | all | Pending | 待付款 |
| `paid` | all | Paid | 已付款 |
| `preparing` | all | Preparing | 备货中 |
| `awaiting_restock` | all | Awaiting restock | 等待补货 |
| `rider_pickup` | (Meituan mirror) | Rider coming | 骑手前往取货 |
| `dispatched` | delivery | Dispatched | 已发货 |
| `dispatched` | pickup | Ready | 可取货 |
| `delivered` | delivery | Delivered | 已送达 |
| `delivered` | pickup | Picked up | 已取货 |
| `delivered` | counter | Completed | 已完成 |
| `cancelled` | all | Cancelled | 已取消 |
| `refunded` | all | Refunded | 已退款 |

## Order status — customer register

| status | fulfilment | EN | CN |
|---|---|---|---|
| `pending_payment` | all | Awaiting payment | 待付款 |
| `paid` | all | Paid | 已付款 |
| `preparing` | all | Preparing | 备货中 |
| `awaiting_restock` | all | Awaiting restock | 等待补货 |
| `rider_pickup` | (Meituan mirror) | Rider picking up | 骑手正在取货 |
| `dispatched` | delivery | On the way | 配送中 |
| `dispatched` | pickup | Ready to collect | 可取货 |
| `delivered` | delivery | Delivered | 已送达 |
| `delivered` | pickup | Collected | 已取货 |
| `delivered` | counter | Completed | 已完成 |
| `cancelled` | all | Cancelled | 已取消 |
| `refunded` | all | Refunded | 已退款 |

Every customer-facing status map must cover all nine statuses. Printing a raw internal value to a customer is a defect.

## Courier stages (live rider)

| stage | operator EN · CN | customer EN · CN |
|---|---|---|
| `scheduled` | (suppressed in admin) | Delivery scheduled · 等待配送 |
| `awaiting_dispatch` | Finding a rider · 正在找骑手 | Finding a courier · 正在为您找骑手 |
| `heading_to_pickup` | Rider coming · 骑手前往取货 | Rider picking up your order · 骑手正在取货 |
| `in_transit` | On the way · 配送中 | On the way · 骑手配送中 |
| `delivered` | Delivered · 已送达 | Delivered · 已送达 |

`Rider coming` means exactly `heading_to_pickup` — a rider is travelling to the store. It is never used for `awaiting_dispatch` (no rider yet) or as the `rider_pickup` chip's stand-in for anything else. `En route` is retired; the word is `On the way`.

## Time labels

| kind | operator | customer |
|---|---|---|
| Estimate, in flight | ETA · 预计送达 (green) | Estimated arrival · 预计送达 |
| Estimate, order closed, never resolved | ETA · 预计送达 (settled grey) | (hidden — rule 3) |
| Customer-booked window | Booked · 顾客预约 | (slot/booking copy, unchanged) |
| Recorded arrival | Arrived · 已送达 | (timeline milestone) |
| No ETA | no ETA set · 未设送达时间 | (nothing) |
| Rider minutes | ~N min · 约 N 分钟 | ~N min · 约 N 分钟 |

Note: the drawer kicker for a recorded arrival currently reads `Arrived · 送达`; it aligns to `Arrived · 已送达`.

## Plan kickers (orders list, Delivery column)

| Condition | Kicker EN | Kicker CN | Kind |
|---|---|---|---|
| closed (dispatched/delivered/cancelled/refunded) | Requested timing | 原定时间 | historical |
| pickup | Pickup time | 取货时间 | promised window |
| batch with an arrival date | Deliver by | 送达时间 | commitment date |
| batch without one | Ship by | 最迟发货 | deadline |
| right-away | Right away | 立即配送 | — |
| ASAP / nothing chosen | Ship by | 最迟发货 (headline: Courier — ship when ready · 快递 · 备好即发) | deadline |
| customer-scheduled window | Booked | 顾客预约 | customer-chosen window |

- Batch sub-line: `made fresh · ship <date>` / `现做 · <date>发货`.
- Urgency tags: `OVERDUE · 已逾期`, `today · 今天`, `tomorrow · 明天` — suppressed once the order is closed.
- `Booked` here is the same word as the `Booked · 顾客预约` time label; a customer-chosen window uses that word everywhere. `Deliver by` is our commitment; `Booked` is the customer's choice. The bare kicker `Deliver` is retired. `Requested` (bare) is retired; `Requested timing` remains the closed-order kicker only.
- The right-away CN is `立即配送`, the live customer-facing string in the mini-app checkout slot picker (`miniapp/pages/checkout/checkout.wxml`). It is not `尽快`.

## Customer notifications (fulfilment-aware)

| status | fulfilment | EN | CN |
|---|---|---|---|
| `dispatched` | delivery | Your order has shipped | 订单已发货 |
| `dispatched` | pickup | Your order is ready to collect | 订单可取货 |
| `delivered` | delivery | Your order was delivered | 订单已送达 |
| `delivered` | pickup | Order collected | 订单已取货 |
| `delivered` | counter | (no notification) | — |

Other statuses keep their existing lines unchanged.

## Tracking codes and scenarios

The nine `tracking_status` codes and seven `tracking_scenario` entries in `lib/tracking.js` are the canon, labels included. Surfaces must render `label_en`/`label_cn` verbatim; the admin's private relabels of scenarios are defects. `已签收` remains the CN for courier `delivered` (signed for) — it is a carrier fact, distinct from the order-status `已送达`.

## Deferred — recorded, not in scope of this lock

- **Pickup slots whose hour exists only in the stored label** (`scheduled_for` is a day-only date, the time lives in `delivery_slot_label`): deriving the display from the order's own data would drop the hour, so those rows still render the customer's stored words and can show a checkout-language clock. The fix is to persist the pickup time as a real timestamp — a schema change, Orders stage.

These are structural findings from the survey, deferred to the Orders stage of the consolidation: the six overlapping status vocabularies; the three sweeps bypassing `STATUS_TRANSITIONS` and `rider_pickup`'s absence from it; dead/half-dead states (`placed`, `arrived_local`'s missing render branch); schema-comment drift (7 vs 9 statuses, 8 vs 9 codes, missing `supplier` mode); four statuses collapsing to one amber; hardcoded status hex colours vs `--td-*` tokens. This document locks WORDS; it does not redesign machinery.
