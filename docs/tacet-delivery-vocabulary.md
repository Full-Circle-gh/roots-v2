# Tacet delivery vocabulary — locked

**v1.5 · 2026-08-27 · adds a THIRD amendment section, Receipt reversal refused — purchasing, and locks its one pair, `undoBlocked`, on the day it opens — the first entry in this document about goods ARRIVING rather than an order leaving, and the first about stock at all, which is why it needed a section of its own rather than a row in a table above. It serves three entry points that must not diverge, it must always carry both of its halves, and the per-product lines beneath it reuse a pair already live on the purchasing screen rather than minting a second copy here. Also of record: the recipe-line-unit pair WAS minted and locked 2026-08-27, as that section’s own heading says; the v1.4 note that follows still describes it as waiting on Ash and is left as written, being a dated record of that day rather than a claim about today. v1.4 (2026-08-26) adds a SECOND request section, for recipe line units, which like the first holds NO locked strings — one English string is waiting on Ash for its Chinese, bringing the pending total to seven across two sections, all unlocked until he supplies them. The concept is a recipe line counted in a unit that measures a different kind of thing than its material's stocking unit, so that line's cost cannot be worked out; two existing pairs were considered and rejected, and the section records which and why so the search is not repeated. The channel-mapping request section is unchanged (v1.3, 2026-08-26, adds it — six English strings waiting on Ash). The tables above are unchanged and remain locked by Ash as of v1.2 (2026-08-20, adds the admin form-caption table). Derived from `docs/tacet-delivery-status-survey.md` (2026-08-03). This document is a SPECIFICATION: every delivery/fulfilment word on every surface must come from these tables. The survey records what existed; this records what is allowed.**

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

## Date changed after printing

When a customer reschedules an order whose receipt has already printed, a short change slip is emitted. Three terms, two of them already locked elsewhere in this document and reused unchanged.

| Role | EN | CN | Source |
|---|---|---|---|
| Slip header | Date changed | 改期 | minted 2026-08-07, Ash |
| The new date | Booked | 顾客预约 | existing — Time labels, customer-booked window |
| The superseded date | Previously | 原定时间 | existing — Plan kickers, closed-order kicker |

`改期` is **fulfilment-neutral**: one term for delivery and pickup alike. The slip states that a date moved, which is equally true of both. Do not create a pickup variant — the three-way pickup relabelling recorded elsewhere in this document is a defect, not a pattern to extend.

`原定时间` carries its existing meaning — the date that was originally set — and is reused rather than re-minted. Its EN partner on the slip is `Previously`, not the `Requested timing` used by the orders-list kicker; the kicker names a plan, the slip names a superseded value.

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

## Admin form captions — operator register

Captions on admin forms that state a delivery rule. The one string here predates this document — it was written into the New-order wizard before the vocabulary existed and was never covered by the tables above — and is brought under lock on 2026-08-20, after the postal-code field was made optional and the count it names changed from six to five.

| Caption | EN | CN | Where |
|---|---|---|---|
| Required fields, delivery address | All five are required for a delivery order. | 配送订单五项均为必填。 | `public/retail-admin.html`, New-order wizard address block |

The numeral is part of the string, so it is only correct while the block asks for exactly five. Adding or removing a required field means amending this row, in both languages, in the same commit as the field — a caption that counts is a caption that goes stale silently.

## Tracking codes and scenarios

The nine `tracking_status` codes and seven `tracking_scenario` entries in `lib/tracking.js` are the canon, labels included. Surfaces must render `label_en`/`label_cn` verbatim; the admin's private relabels of scenarios are defects. `已签收` remains the CN for courier `delivered` (signed for) — it is a carrier fact, distinct from the order-status `已送达`.

## Channel mapping — awaiting a Chinese source (REQUEST, not locked)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This section is that amendment, opened rather than closed: the
six strings below are running English-on-both-sides in the product right now,
because composing their Chinese is exactly what Rule 4 forbids and no existing
pair covers them.

They came in with the Eleme and Meituan mapping-name gate on 2026-08-26
(`docs/tacet-consolidation-decisions.md` §30 rule 3, which cross-references Rule
4 here: copy from the source, never compose). The screens report a mapping name
that no channel listing carries, and refuse to claim anything when there is no
catalogue to check against.

**Ash to supply the CN column.** Filling it is five edits in the product, all of
them inside `EL_PENDING_CN` in `public/retail-admin/14-eleme.js` and
`MT_PENDING_CN` in `public/retail-admin/11-meituan.js` — one constant per screen.
Where both screens carry a key the wording is deliberately identical, so one CN
string serves both channels.

Two of these have no caller on the Eleme screen right now. `notInCat` and
`notChecked` were state words for `elStoreState`, and that classification is
being rebuilt around three groups on `claude/eleme-three-group-split-7f6d32`,
where "Name not in catalogue" becomes a reason on the row rather than a state of
its own. They are kept here and in the code so that build inherits them rather
than re-opening the question. Meituan still uses both. `noneRead` is Meituan's
alone — Eleme had a sourced pair for that case already and reuses it.

| Key | EN | CN | What it says |
|---|---|---|---|
| `notInCat` | Name not in catalogue |  | State word: this mapping holds a name no listing on this store carries. Amber. Live on Meituan; on Eleme it is waiting for the three-group build to consume it as a row reason. |
| `notChecked` | Name not checked |  | State word: a name is stored and no catalogue has been read, so the check could not run. Neutral, never all-clear. |
| `pickIt` | This name matches no listing on this store. Pick one from the list. |  | Panel line under the field, on a mapping whose stored name is not in the catalogue. |
| `reverted` | Not in the catalogue — not saved. |  | Line under the field when a typed value was refused and the field put back to what it held. |
| `cannotCheck` | The catalogue has not been read from this store yet, so this name cannot be checked — nothing was saved. |  | Line under the field when the save was attempted with no catalogue to check against. It has to carry BOTH halves: the check could not run, and nothing was saved. Not amber — the screen has no grounds to say anything is wrong with what was typed. |
| `noneRead` | no listings read from this store yet, so nothing can be checked here |  | Panel line, Meituan only: a name is stored and no listings have been scraped. Eleme's half of this reuses the pair already on that screen, `no catalogue read yet, so nothing can be matched here` / `尚未读取商品目录，无法匹配`. |

Everything else on that change reuses a pair that already exists in the admin —
`No matches` / `无匹配` and `Remove` / `移除` — and needs nothing here.

Sentence case, no exclamation marks, and `notInCat` doubles as a filter-chip
label, so it wants to stay short enough to sit in a chip beside a count.

## Recipe line units — 单位不符 · UNIT MISMATCH (LOCKED 2026-08-27)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is a second such amendment, opened 2026-08-26 and closed 2026-08-27.

THE CONCEPT NEEDING A PAIR. A recipe line is counted in a unit that measures a
different kind of thing than its material's stocking unit — 160 ml of an oil
stocked in grams — so that line's cost cannot be worked out and is left out of
the recipe total. The material's own cost is fine.

It arrives with the §7 addendum's refusal to convert without a stated factor
(`docs/tacet-consolidation-decisions.md` §7 addendum): volume to weight needs a
density, density is a property of the material, and there is no default. 82 live
lines across 36 recipes are in this state today.

TWO EXISTING PAIRS WERE CONSIDERED AND REJECTED, recorded so the search is not
repeated. `Order unit ≠ item buy unit · 采购单位与物料单位不一致` is PO-time and
about the BUY unit, saying nothing about a recipe line or an excluded cost.
`Recipe unit is not g / ml / pcs · 配方单位不是 克/毫升/件` is the unsupported-unit
case, but these units ARE valid — they simply measure different things. Either
would be untrue on this screen.

THREE DISTINCTIONS THE CHINESE MUST PRESERVE, because losing any one of them
turns a refusal into a defect report:

1. UNKNOWN, not missing and not zero. The cost has not gone away and is not nil;
   it cannot be worked out. A word meaning "missing" would send an operator to
   look for a price that is already there.
2. THE LINE is at fault, not the material. The material's cost is good. Copy that
   blames the material sends the fix to the wrong record.
3. The total is INCOMPLETE, not wrong. Everything shown is correct; something is
   absent from it.

WHERE IT IS USED. One string, the `.rcp-warn` pill on the Recipes record screen
(`public/retail-admin/19-recipes.js`), naming how many lines are affected. The
rollup's own blocked-reason copy needs nothing new — both BLOCK_REASON maps fall
an unmapped reason through to `This recipe's cost can't be worked out right
now. · 该食谱的成本暂无法计算。`, which is true for this case.

**THE PAIR — minted by Ash, 2026-08-27, locked.** The hold is lifted: the pill
ships, and with it the accounting change that drops 34 recipes' ingredient cost.

| Key | EN | CN | What it says |
|---|---|---|---|
| `unitMismatch` | UNIT MISMATCH | 单位不符 | The line's unit and the material's stocking unit are different kinds of quantity, so the line's cost cannot be trusted. |

CHOSEN OVER TWO OTHERS, recorded so the choice is not reopened. 无法换算
overstates — a recorded density will fix the volume↔mass cases. 待换算 implies a
remedy that does not exist for the mass↔count case.

It covers all three classes the counter flags: volume↔mass, mass↔count, and any
future dimension pair. It names the CAUSE, not the mechanism and not the fix —
see §29.

Used on the `.rcp-warn` pill on a recipe ingredient line. Note for whoever wires
it: `.rcp-warn` is a RECIPE-RECORD pill (`retail-admin.css` `#tab-recipes-record
.rcp-warn`) and there is no per-line variant of it, so the string paints once per
recipe beside the other cost warnings, not once per offending line.

**AMENDED 2026-09-01 — three more places, same pair, no new Chinese.** The note
above is now historic: a per-line variant exists (`.rcp-line-warn`), and the pair
is reused, not extended. Reuse of a locked pair in a new place needs no
amendment; this records where, so the search is not repeated.

| Where | File | What it qualifies |
|---|---|---|
| The offending ingredient row itself | `public/retail-admin/19-recipes.js` `paintLineWarns()` | Which line. The record pill names the condition once; the operator still had to guess which of eleven lines caused it. |
| The recipe save | `public/retail-admin/19-recipes.js` `rcpSave()` | The moment the line is stored. The save is never blocked and the unit is never converted — it simply stops being silent. |
| The Products list margin cell, and the product editor's cost pill | `public/retail-admin/09-products.js` `_paMarginWarn()` / `pdRecipeHealthPaint()` | That the cost the percentage is drawn from is short an ingredient — the flattering direction. |

In all four places the LABEL is this pair, copied. The sentence around it is
English on both halves and marked CN PENDING in the source, exactly as the build
list's own strings are: rule 4 forbids composing the Chinese, and none is
sourced. Each of those sentences keeps the three distinctions above — UNKNOWN
rather than missing, the LINE at fault rather than the material, the total
INCOMPLETE rather than wrong — and `scripts/test_recipe_unit_mismatch_warnings.js`
asserts that (it fails the copy if it says "missing").

**DO NOT CONFUSE WITH UNCONVERTED**, which is the §6 addendum's state for a recipe
with a blank serving size. Different state, different screen region, different
cause.

## Receipt reversal refused — purchasing (LOCKED 2026-08-27)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the third such amendment, opened and closed the same day.
It is also the first entry here that is not about an order leaving the business:
it is about goods arriving and a receipt being taken back. The section was
created because no existing one fits — the tables above cover order delivery,
the two request sections cover channel mapping and recipe line units, and none of
them speaks about stock.

THE CONCEPT NEEDING A PAIR. A purchase receipt is reversed by asserting the goods
never arrived. That is only true while the goods are still on the shelf. Where
some have already been sold or consumed, the reversal cannot be honest, so it is
refused outright — no clamping to zero, no partial return, nothing written at
all. The operator is told which products block it and by how much.

THE DECISION IT REPORTS. `docs/tacet-consolidation-decisions.md` records the
receiving path's state; the rule this string speaks for is that a reversal tests
every line against current stock BEFORE it writes anything, and aborts before the
first write if any line would drive a count below zero. A partial reversal is
worse than a refusal, because it leaves stock and the order records disagreeing
with no sign that they do.

**THE PAIR — minted by Ash, 2026-08-27, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `undoBlocked` | Some of these goods have already left stock, so this delivery cannot be undone — nothing was changed. | 部分货品已出库，此次收货无法撤销 — 未作任何更改。 | Headline on a refused receipt reversal. Names the reason and states that the operation wrote nothing. |

**ONE STRING, THREE ENTRY POINTS.** It serves Undo receiving, Back to draft and
Cancel order alike. All three ask for the same thing — that a receipt be taken
back — and all three are refused on the same test, so all three report the same
fact in the same words. **They must not diverge.** Three wordings for one
condition would read as three different conditions, and an operator comparing two
screens would go looking for a difference that does not exist.

**BOTH HALVES ALWAYS, NEITHER DROPPED FOR BREVITY.** The string carries two
facts: the operation was REFUSED, and NOTHING WAS WRITTEN. Neither may be
shortened away, in either language. Dropping the first turns a refusal into a
vague complaint; dropping the second leaves the operator to guess whether the
order is now half-reversed, which is the exact anxiety the refusal exists to
prevent. This follows the same requirement `cannotCheck` carries in the
channel-mapping section above, and for the same reason.

**THE PER-PRODUCT LINES BENEATH IT ARE NOT MINTED HERE.** Each blocking product
renders under the headline using the pair already live on the purchasing screen,
`${n} short` / `${n} 短缺` (`public/retail-admin/16-purchasing.js`, the receive
toast). That pair is reused unchanged and is deliberately NOT re-minted in this
document — it already exists in the product, in context, and writing it here too
would give one string two definition sites, against Rule 6.

Sentence case, no exclamation marks. The em dash before the second half is part
of both strings and is not a substitute for a full stop.

**APPROVED BY ASH, 2026-08-27.** Both halves of the pair are his; nothing in this
section was composed.

## Deferred — recorded, not in scope of this lock

- **Pickup slots whose hour exists only in the stored label** (`scheduled_for` is a day-only date, the time lives in `delivery_slot_label`): deriving the display from the order's own data would drop the hour, so those rows still render the customer's stored words and can show a checkout-language clock. The fix is to persist the pickup time as a real timestamp — a schema change, Orders stage.

These are structural findings from the survey, deferred to the Orders stage of the consolidation: the six overlapping status vocabularies; the three sweeps bypassing `STATUS_TRANSITIONS` and `rider_pickup`'s absence from it; dead/half-dead states (`placed`, `arrived_local`'s missing render branch); schema-comment drift (7 vs 9 statuses, 8 vs 9 codes, missing `supplier` mode); four statuses collapsing to one amber; hardcoded status hex colours vs `--td-*` tokens. This document locks WORDS; it does not redesign machinery.
