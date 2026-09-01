# Tacet delivery vocabulary — locked

**v1.9 · 2026-09-01 · adds an EIGHTH amendment section, What a material line's Arrived box does — receiving, locking one pair. It is the first section about a control that is CORRECT and looks broken: the Arrived box on a material line drives Finance and never stock, and the In-stock cell beside it shows an em dash for ever, so the two together read as "the number you typed did nothing" — which is how that box came to be proposed for deletion, tried and reverted on 2026-08-27. The pair sits on both cells because either alone leaves the other still saying it, and product rows carry none of it, since on them the sentence would be false. Its CN half is minted under the same delegation the fourth amendment records, and every clause of it is quoted from the screen the tooltip sits on. v1.8 · 2026-09-01 · adds a SEVENTH amendment section, Confirming arrival per product — receiving, locking ten pairs. It is the first section in this document to separate WHAT THE GOODS DID from WHAT THE RECORD SAYS: `未到货` is the supplier not sending, `待确认` is nobody having answered yet, and the phone's receive screen had one word for both because it opened with every line pre-filled at the quantity ordered and one button that booked all of them. Two of its pairs are reused rather than minted — the receive screen's own `未到货` and the PO sheet's `全部到货` — and the whole-order button's body no longer sends the operator to a desktop for per-product work, which stopped being true when Receive became a screen on the phone. v1.7 · 2026-09-01 · adds a SIXTH amendment section, A cost that cannot be put back — purchasing, locking three pairs. It is the first refusal in this document that names a remedy the operator can carry out: the two before it state a condition and stop, while this one ends in an instruction, because the system cannot know the old price and a person can decide it. Shipped without it, the condition reached the operator as a bare error code on a screen that had already told them to do the thing it was refusing. v1.6 · 2026-09-01 · adds a FIFTH amendment section, Purchase returns — purchasing, locking fifteen pairs on the day it opens. It is the first section about goods leaving the building in the direction they came from, and it exists because the receiving vocabulary could say SHORT and DAMAGED but had no word for SENT BACK — so a return had to be entered as a delivery that never happened. One of its reason codes reuses the mobile screen's existing `错货` rather than re-minting it, and its refusal headline deliberately does NOT reuse `undoBlocked`: same shelf test, different subject. This bump also covers the FOURTH amendment (Undo receiving clears the counts, LOCKED 2026-09-01), which landed without one — the sections below are the record, and the count in this banner is now caught up with them rather than rewritten to pretend it never slipped. v1.5 · 2026-08-27 · adds a THIRD amendment section, Receipt reversal refused — purchasing, and locks its one pair, `undoBlocked`, on the day it opens — the first entry in this document about goods ARRIVING rather than an order leaving, and the first about stock at all, which is why it needed a section of its own rather than a row in a table above. It serves three entry points that must not diverge, it must always carry both of its halves, and the per-product lines beneath it reuse a pair already live on the purchasing screen rather than minting a second copy here. Also of record: the recipe-line-unit pair WAS minted and locked 2026-08-27, as that section’s own heading says; the v1.4 note that follows still describes it as waiting on Ash and is left as written, being a dated record of that day rather than a claim about today. v1.4 (2026-08-26) adds a SECOND request section, for recipe line units, which like the first holds NO locked strings — one English string is waiting on Ash for its Chinese, bringing the pending total to seven across two sections, all unlocked until he supplies them. The concept is a recipe line counted in a unit that measures a different kind of thing than its material's stocking unit, so that line's cost cannot be worked out; two existing pairs were considered and rejected, and the section records which and why so the search is not repeated. The channel-mapping request section is unchanged (v1.3, 2026-08-26, adds it — six English strings waiting on Ash). The tables above are unchanged and remain locked by Ash as of v1.2 (2026-08-20, adds the admin form-caption table). Derived from `docs/tacet-delivery-status-survey.md` (2026-08-03). This document is a SPECIFICATION: every delivery/fulfilment word on every surface must come from these tables. The survey records what existed; this records what is allowed.**

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

In all four places the LABEL is this pair, copied.

**THE EXPLANATIONS — minted by Ash, 2026-09-01, locked.** The five sentences that
sit around the label shipped English on both halves and marked CN PENDING, and
that is what an operator reading Chinese actually met: a triangle, a label he
could read, and a paragraph he could not. Ash, on the live screen: "make sure
that the mouse over in chinese version its in chinese language." Drafted against
the constraints below, put in front of him string by string, and minted.

| Key | Where | EN | CN |
|---|---|---|---|
| `unitMismatchLine` | the ingredient row's tooltip (`19-recipes.js` `lineMismatchTitle()`) | This line is counted in {a} but the material is stocked in {b}. Those measure different kinds of thing and nothing is converted, so this ingredient's cost is NOT included in the recipe total. The material's own cost is fine — change the line's unit to fix it. | 本条按 {a} 计量,而该物料按 {b} 库存。两者计量的不是同一类量,系统不作换算,因此本条原料不计入配方成本。该物料本身的成本没有问题 —— 修改本条的单位即可。 |
| `unitMismatchSave` | the save toast (`19-recipes.js` `rcpSave()`) | Saved — but N ingredients are NOT included in this recipe's cost: … UNIT MISMATCH — the line's unit and the material's stocking unit measure different kinds of thing, so nothing was converted. The cost shown is incomplete. | 已保存 —— 但有 N 项原料不计入本配方成本:… 单位不符 —— 该条的单位与物料的库存单位计量的不是同一类量,系统不作换算。显示成本不完整。 |
| `unitMismatchPill` | the product editor's cost pill (`09-products.js` `pdRecipeHealthPaint()`) | — N ingredients in this recipe are counted in a unit the material is not stocked in, so their cost is left out. The cost shown is incomplete. | —— 本配方中有 N 项原料所用单位与物料的库存单位计量的不是同一类量,其成本不计入。显示成本不完整。 |
| `unitMismatchMargin` | the Products list mark (`09-products.js` `_paMarginWarn()`) | UNIT MISMATCH — this product's recipe has an ingredient counted in a unit the material is not stocked in, so that ingredient's cost is left out. The cost shown is incomplete and the real margin is lower. | 单位不符 —— 本产品的配方中有原料所用单位与物料的库存单位计量的不是同一类量,该原料的成本不计入。显示成本不完整,实际毛利更低。 |
| `costIncompleteMargin` | the same tooltip's other half (`09-products.js` `_paMarginWarn()`) | Marked "cost is not complete" — this percentage is drawn from a cost that is missing something, so the real margin is lower. | 已标记"成本不完整" —— 此百分比所依据的成本缺少内容,实际毛利更低。 |

`costIncompleteMargin` is NOT part of the unit-mismatch work and is minted here
anyway. It shipped English-only with the `cost_incomplete` tag on 2026-08-31 and
shares one tooltip with `unitMismatchMargin`; half a tooltip in Chinese is worse
than none, so the pair is closed at the same time rather than left to be
rediscovered.

**THE CHINESE SAYS 不作换算, AND THAT IS THE CAREFUL PART.** The nearest existing
string in the codebase is Materials' `That recipe unit can't be divided into. ·
该配方单位无法折算。`, and it is NOT reusable here: 无法换算 was considered and
REJECTED when the label above was minted, because it says IMPOSSIBLE and a
recorded density will one day settle the volume↔mass cases. 待换算 was rejected for
the mirror reason. 不作换算 — the system DOES NOT convert — is the §7 addendum's
own position rather than a claim about what can ever be known, so it survives the
day the density field lands. `scripts/test_recipe_unit_mismatch_warnings.js`
fails if either rejected phrasing reappears.

Each sentence keeps the three distinctions above in BOTH halves — UNKNOWN rather
than missing (不计入, never 缺少成本, which names the wrong record), the LINE at
fault rather than the material (该物料本身的成本没有问题), the total INCOMPLETE
rather than wrong (显示成本不完整). The test asserts all three on the Chinese, not
only on the English.

**HOW FOUR ENGLISH STRINGS SHIPPED UNNOTICED, so the next pair does not.** The
suite stubbed the translator to return the ENGLISH half, so every assertion
passed whether or not a Chinese half existed. Section 6 of that file now flips
the language and asserts the output CHANGED, and scans both files for the shape
the bug wore — `T(x, x)` / `cuT(x, x)`, the same variable passed as both halves.

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

## Undo receiving clears the counts — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the fourth such amendment, opened and closed 2026-09-01.

HOW THE CN HALF WAS ARRIVED AT, since Rule 4 exists to stop exactly this being
waved through. Ash delegated the wording explicitly ("you decide the chinese")
rather than minting it himself, which is the owner exercising the rule, not a
route around it — but a delegated pair is still weaker than a minted one, so it
was built from words ALREADY IN THE PRODUCT rather than composed fresh:
`实收` and `破损` are the two column headers standing directly above this dialog
(`receiveRow`, public/retail-admin/16-purchasing.js), and `已收货` is the segment
name the undone delivery remains in. That is the rule's own instruction — copy
from the source — applied to the screen rather than to this document. **Ash
should correct the wording if it reads wrong to a Chinese operator; nothing else
depends on the exact phrasing.**

WHY THE STRING IS NEEDED. Undo receiving now clears `qty_received` and
`damaged_qty` on the order's lines, where it used to leave them in place. The
old behaviour left an order sitting at Sent with every ARRIVED box holding a
number, which reads as fully received — RPO-0001 went to Delivered and back
three times on 2026-08-27 and looked received for days afterwards, and was
reported as the system filling in counts by itself. An undo asserts the goods
never arrived, so the counts going with it is the honest reading, and it is the
same assertion `undoBlocked` above is built on.

WHAT THE OPERATOR MUST BE TOLD, AND WHEN. Before they confirm, not after. The
undo is already destructive of stock and says so; it is now also destructive of
the counts, and an operator who expected to re-confirm without re-entering
anything would otherwise find out by losing them. The sentence also carries the
reassurance that the receipt itself survives — `po_receipts` /
`po_receipt_lines` keep their own copy of every number, so the delivery stays
readable in Receiving.

**THE PAIR — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `undoClearsCounts` | The arrived and damaged counts are cleared — the delivery stays in Receiving. | 实收与破损数量将被清空 —— 该次收货记录仍保留在「已收货」中。 | Second sentence of the Undo receiving confirmation. Says what the undo destroys and what it does not. |

**BOTH HALVES ALWAYS**, for the same reason `undoBlocked` carries two: dropping
the first hides what is about to be lost, and dropping the second leaves the
operator believing the delivery record is gone too.


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

## Purchase returns — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the fifth such amendment, opened and closed 2026-09-01,
the same day as the fourth and for the same feature area.

WHY THE STRINGS ARE NEEDED. Receiving could say a delivery came up SHORT and it
could say some of it arrived DAMAGED. It could not say the thing that happens
after the door closes: 15 kg of buckwheat flour taken in on 25 August, found
wrong on 1 September, sent back to the supplier. The only way to record that was
to edit the arrived count down — which asserts the goods never turned up,
contradicts the receipt that says they did, and afterwards cannot be told apart
from a supplier who short-shipped. **Sent back and came up short are two
different facts about a supplier, and this vocabulary is what keeps them apart
on screen.** They are also two different facts about the money: a shortfall was
never billed, a return has to be taken back off a bill that was.

HOW THE CN HALVES WERE ARRIVED AT. Under the same delegation the fourth
amendment records (Ash: "you decide the chinese"), and built the same way — from
words ALREADY IN THE PRODUCT wherever the product had one:

- `退货` is the word the admin already uses for goods going back
  (`04-orders.js`, `03-dashboard.js`), and the column header is the bare noun so
  it sits beside `实收` and `破损` in the same register — two characters, no verb.
- `错货` for `wrong_item` is **not minted here**. It is the pair the mobile
  receive screen already ships (`RCV_REASONS`, `public/m.html`) and it is reused
  verbatim, per Rule 6 — one string, one definition site. It is the only reason
  code the two lists share, which is itself the point: the other four are
  reasons goods LEFT, not reasons fewer arrived.
- `未作任何更改。` in `returnBlocked` is lifted character-for-character from
  `undoBlocked` above. The two refusals rest on the same shelf test and must
  make the same promise in the same words; only the half naming the operation
  differs.

**Ash should correct any of these if they read wrong to a Chinese operator;
nothing else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `returnedColumn` | Returned | 退货 | The receive table's fifth column, and the box in it. Sits beside 实收 and 破损. |
| `returnReasonPrompt` | Why? | 原因？ | Empty state of the reason picker that appears with the first returned unit. |
| `returnQuality` | Quality | 质量问题 | Return reason: arrived intact, not good enough to sell or cook with. |
| `returnExpired` | Expired | 过期 | Return reason: out of date, or too near it to use. |
| `returnOverDelivered` | Over-delivered | 多送 | Return reason: more turned up than was ordered, the surplus went back. |
| `returnNotNeeded` | Not needed | 无需要 | Return reason: ordered in error, the supplier took it back. |
| `returnBlockedTitle` | Cannot record this return | 无法登记此次退货 | Title of the refusal dialog when the shelf cannot cover the return. |
| `returnBlocked` | Some of these goods are no longer in stock, so they cannot be sent back — nothing was changed. | 部分货品已不在库存中，无法退货 — 未作任何更改。 | Headline on a refused return. Names the reason and states that the operation wrote nothing. |
| `returnedToSupplier` | Returned to supplier | 已退回供应商 | Label on the PO's Finance panel, above the value that came back off the books. |
| `returnedNetted` | already taken off the total above, dated to the order | 已从上方合计中扣除，记在采购单原日期 | The rest of that sentence. Says the money has ALREADY moved and WHICH DATE it moved on. |
| `returnsComeOffBoth` | Returned units come back off both. | 退货数量会从库存和支出中同时扣除。 | Third clause of the receive note, rendered only on an order that has a return. |
| `returnSentBack` | sent back | 已退回 | The Receiving list's own word for a return row, where a delivery row counts lines. |
| `creditDue` | credit due | 应退 | Pill on an invoice line covering more than the line is now worth. The supplier owes this back. |
| `returnedAfterInvoicing` | Returned after invoicing | 开票后退货 | Label on the Invoices strip that totals those credits. |
| `askForCreditNote` | ask the supplier for a credit note | 需向供应商索取红字发票 | The instruction beside that total. `红字发票` is the standing term for the document; it is named because nothing in this system issues one. |

**`returnBlocked` CARRIES BOTH HALVES, ALWAYS**, exactly as `undoBlocked` does
and for the reason that section gives: dropping the refusal turns it into a
vague complaint, and dropping "nothing was changed" leaves the operator guessing
whether the return half-landed — the one anxiety a refusal exists to prevent.

**IT IS NOT `undoBlocked` AND MUST NOT BE COLLAPSED INTO IT.** The two share a
shelf test, a shape and a second half. They do not share a subject: one says a
DELIVERY cannot be taken back, the other that GOODS cannot go back to the
supplier. An operator handed the wrong one goes looking for the wrong order.
That is the mirror image of the rule `undoBlocked` states for its own three
entry points — one condition, one wording — applied to a second condition.

Sentence case, no exclamation marks. The em dash before the second half of
`returnBlocked` is part of both strings and is not a substitute for a full stop.

## A cost that cannot be put back — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the sixth such amendment, opened and closed 2026-09-01.

WHY THE STRINGS ARE NEEDED. Taking a purchase order off its placed state has to
give back what the order took, including any ingredient cost its material lines
wrote. Where nothing recorded what the cost was BEFORE the order touched it, the
transition is refused — correctly. What the operator got was the bare code
`cost_not_recoverable` in a toast, on a screen whose own advice is "return it to
draft to change it", and the purchasing wizard only opens a draft. So the code
was the end of the road: the order could not be edited, and nothing on screen
said why or what to do about it.

WHAT MUST BE SAID, AND THE ORDER IT IS SAID IN. The refusal first, then the
materials it is about, then the way out. The way out is the part with no
precedent in this document: the system does not know the old price, so a PERSON
has to decide what it should be, and setting the material's cost by hand makes
the order's write no longer the standing one — which clears the refusal by
itself. A refusal that names its own remedy is the difference between a rule and
a dead end.

HOW THE CN HALVES WERE ARRIVED AT. Under the delegation the fourth amendment
records, and built the same way — from words already shipped:
`物料` is the Materials tab's own name (`18-materials.js`), quoted in 「」 as
that screen's settings copy already quotes it (`02-settings-ops.js`), and
`未作任何更改。` is lifted character-for-character from `undoBlocked`, because
this refusal makes the same promise and must make it in the same words.

**Ash should correct these if they read wrong to a Chinese operator; nothing
else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `costBlockedTitle` | This order cannot go back yet | 该采购单暂时无法退回 | Title of the refusal dialog. "Yet" is load-bearing — there is a way out, and the next lines give it. |
| `costBlocked` | These materials still carry the price this order set, and nothing recorded what they cost before it — nothing was changed. | 这些物料当前的价格仍是本采购单写入的，而系统没有记录写入前的价格 — 未作任何更改。 | Headline. Names the reason and states that the operation wrote nothing. |
| `costBlockedWayOut` | Set their price yourself under Materials, then try again. | 请先在「物料」中手动设置这些物料的价格，然后再试。 | The remedy. A person decides the price; that clears the refusal. |

**BOTH HALVES OF `costBlocked`, ALWAYS**, for the reason `undoBlocked` and
`returnBlocked` each carry two: dropping the first leaves a vague complaint,
dropping the second leaves the operator guessing whether the order is now
half-reversed.

**IT IS NOT `undoBlocked` OR `returnBlocked`.** All three refuse a transition and
all three end in the same six characters, and they are still three different
conditions: stock that has left the shelf, goods that cannot go back to a
supplier, and a price with no recorded predecessor. Only this one has a remedy
the operator can carry out, which is why only this one has a third line.

Sentence case, no exclamation marks. The em dash before the second half of
`costBlocked` is part of both strings and is not a substitute for a full stop.

## Confirming arrival per product — receiving (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the seventh such amendment, opened and closed 2026-09-01.

WHY THE STRINGS ARE NEEDED. The phone's receive screen (`public/m.html`,
`screenReceive`) opened with every line already showing the quantity ordered and
one button underneath, so the only sentence it could say was THE WHOLE ORDER
CAME. A buyer looking at a twelve-line order with one box on the step had no way
to say which box: "I only see an option to mark that all the PO arrived." The
screen now takes the answer PER PRODUCT, and a product nobody has answered is
not sent at all — it stays outstanding on the order for the van that brings it.

THE DISTINCTION EVERY PAIR HERE EXISTS TO HOLD. **Nothing arrived** and **nobody
has said yet** are different facts, and the old screen had one word for both.
`未到货` is a statement about the goods — the supplier did not send them, it is
recorded, it books a zero and takes a reason. `待确认` is a statement about the
RECORD — nothing has been claimed either way, nothing will be written, and the
order keeps waiting. A screen that renders the first where it means the second
tells the buyer their delivery is short when it has simply not been counted yet.

TWO EXISTING PAIRS WERE REUSED RATHER THAN RE-MINTED, recorded so the search is
not repeated. `Not arrived` / `未到货` is the receive screen's own pair and is
unchanged — it is now on every product as well as on the supplier. `All arrived`
takes the CN half of the PO sheet's `Everything arrived` / `全部到货`, which is
the same claim about the same goods made one screen earlier.

HOW THE CN HALVES WERE ARRIVED AT. Under the delegation the fourth amendment
records, and built the same way — from words already shipped: `到货` is this
feature's verb throughout (`未到货`, `全部到货`, `到货` on the order rows), and
`待确认` is lifted from the payments and drops queues in the same app, where it
already means "recorded nothing yet, still needs a person". `逐项收货` is the PO
sheet's own button name, quoted in 「」 as that screen quotes screen names.

**Ash should correct these if they read wrong to a Chinese operator; nothing
else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `lineArrived` | Arrived | 已到货 | The per-product answer, on the product. Its counter opens at the quantity ordered; pressing it again takes the answer back. The direct antonym of `未到货` beside it, and deliberately not `已送达` (that pair is a customer's parcel reaching them, a different subject). |
| `groupAllArrived` | All arrived | 全部到货 | The same answer for one supplier's whole group, in one tap. CN reused from the PO sheet. |
| `stateNotConfirmed` | Not confirmed | 待确认 | Supplier pill: nobody has answered any of this supplier's products. NOT `未到货` — nothing is being claimed about the goods. |
| `statePartConfirmed` | Part confirmed | 部分确认 | Supplier pill: some of this supplier's products are answered and some are not. |
| `statePartArrived` | Part arrived | 部分到货 | Row pill in To receive: this order has been received in part and still has products to come. About the GOODS, unlike the two above, which is why it is `到货` and not `确认`. |
| `stillToCome` | %d of %d still to come | 还有 %d/%d 项待收 | Under a part-received order in To receive. Counts what is LEFT, which is the reason the row is in that list. |
| `nothingConfirmed` | Nothing confirmed yet. Mark what arrived, product by product. | 尚未确认。请逐项标记到货情况。 | The summary card before anything has been answered. |
| `markOneFirst` | Mark at least one product before recording. | 请先标记至少一项到货情况。 | Under the disabled record button. Says what would make it live; not a warning, and not amber. |
| `restStayOnOrder` | %d products not answered yet — they stay on this order for a later delivery. | 还有 %d 项未确认 —— 将保留在本单，可在下次到货时收货。 | The last line of the summary. States what the save does NOT say, so a part-confirmed delivery does not read as one that dropped the rest. |
| `stillToComeShort` | %d still to come | %d 项待收 | On the confirmation screen after a part delivery, beside the counts that were recorded. |

**`restStayOnOrder` MUST CARRY BOTH HALVES** — what is unanswered, and that it
stays. The first half alone reads as an accusation of unfinished work; the
second is the promise that makes leaving products unanswered safe to do.

The whole-order button on the PO sheet keeps its title `Everything arrived?` /
`全部到货了吗？` and now names the other way in its body: `If only some of it
came, close this and use Receive line by line — you can mark each product on
its own.` / `如只到了部分商品，请返回并使用「逐项收货」，可逐项标记到货情况。` It used
to send the operator to a desktop for per-line work, which stopped being true
when Receive became a screen on the phone.

Sentence case, no exclamation marks. `%d` marks a number the screen fills in; the
EN halves take a plural `s` on their nouns and the CN halves do not.

## What a material line's Arrived box does — receiving (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the eighth such amendment, opened and closed 2026-09-01.

WHY THE STRING IS NEEDED. On the desktop purchase receiving screen
(`receiveRow`, `public/retail-admin/16-purchasing.js`), a MATERIAL line's Arrived
box behaves differently from a product line's, and nothing on the row said so.
The count typed there never reaches stock — `applyReceivedToStock()` skips any
line carrying an `ingredient_id` before it reaches a stock call — but it is not
ignored either: `postRetailPOExpenses()` sums `COALESCE(qty_received, qty)` with
no kind branch, so that box is the ONLY way to record a short material delivery.
A 20-unit line with 15 delivered posts 160.00 if the box is left blank and
120.00 if 15 is entered.

Meanwhile the row's In-stock cell shows an em dash for ever, because
`stock_applied_qty` is never written for a material line. The two together read
as "the number you typed did nothing", which is wrong in the direction that
costs money — and is how the box came to be proposed for deletion, tried and
reverted on 2026-08-27. The pair is on BOTH cells, because either one alone
leaves the other still saying it.

TWO EXISTING PAIRS WERE CONSIDERED AND REJECTED, recorded so the search is not
repeated. `posts to Finance → Expenses by itself.` / `会自动记入财务 → 支出。`
is about the ORDER TOTAL at placing time — it says nothing about stock and
nothing about one line, and on a per-row tooltip it would read as a claim about
the whole order. `Nothing touches stock until the goods arrive and you tick them
in.` / `在到货并勾选收货之前,库存不会有任何变动。` is the opposite case: it
promises stock movement later, which for a material line never comes.

TWO DISTINCTIONS THE CHINESE MUST PRESERVE, because losing either turns the
tooltip back into the confusion it exists to remove:

1. THE NUMBER COUNTS, it is not ignored. Copy reading "materials don't use this"
   would tell an operator to leave a short delivery unrecorded, which posts the
   full ordered quantity to Expenses.
2. IT COUNTS FOR MONEY, NOT STOCK. A word meaning "recorded" or "saved" without
   naming WHERE leaves the operator still hunting for the number in the stock
   column.

HOW THE CN HALF WAS ARRIVED AT. Under the delegation the fourth amendment
records ("you decide the chinese"), and built the same way — from words already
on this very screen rather than composed fresh. `记入财务 → 支出` and
`库存不会有任何变动` are lifted from the order-total banner in this same file;
`物料` is the row's own badge; `计入` and `门店库存` come from the confirmed-counts
line beneath the receive table; `数量` is the word the empty-state uses for a
counted delivery. Every clause is quoted from the screen the tooltip sits on.
**Ash should correct it if it reads wrong to a Chinese operator; nothing else
depends on the exact phrasing.**

**THE PAIR — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `materialArrived` | This count goes to Finance → Expenses. Materials are not stocked here, so it never changes stock. | 此数量会记入财务 → 支出。物料不计入门店库存,库存不会有任何变动。 | Tooltip on a material line's Arrived input and on its In-stock cell, on the desktop purchase receiving screen. Both carry the same string because they are two halves of one wrong impression. |

**PRODUCT ROWS CARRY NONE OF IT.** Their Arrived box does move stock, so the
sentence would be false on them.

Sentence case, no exclamation marks. **Neither half may contain ` · `** — the
value is set through `T()`/`cuT()` so the attribute holds one language, and the
walker in `public/retail-admin/10-extras.js` splits `data-tt` on that separator,
so a middle dot inside either half would cut the sentence in two. The `→` is
part of both halves and is the same arrow the Finance banner above already uses.

## Deferred — recorded, not in scope of this lock

- **Pickup slots whose hour exists only in the stored label** (`scheduled_for` is a day-only date, the time lives in `delivery_slot_label`): deriving the display from the order's own data would drop the hour, so those rows still render the customer's stored words and can show a checkout-language clock. The fix is to persist the pickup time as a real timestamp — a schema change, Orders stage.

These are structural findings from the survey, deferred to the Orders stage of the consolidation: the six overlapping status vocabularies; the three sweeps bypassing `STATUS_TRANSITIONS` and `rider_pickup`'s absence from it; dead/half-dead states (`placed`, `arrived_local`'s missing render branch); schema-comment drift (7 vs 9 statuses, 8 vs 9 codes, missing `supplier` mode); four statuses collapsing to one amber; hardcoded status hex colours vs `--td-*` tokens. This document locks WORDS; it does not redesign machinery.
