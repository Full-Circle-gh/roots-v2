# Channel mapping findings

Measured 2026-08-27 against the live database. Meituan unless stated.

## F1 — Deleting a product does not stop its channel mappings

Deleting a product in Tacet sets `store_products.is_active = 0` and leaves `status = 'Active'`. The row survives, hidden from every screen. Its channel mapping rows survive too, still `sync_enabled = 1`, and the daemons keep pushing them.

The operator cannot fix this from the app: the product no longer appears, so its mapping cannot be reached.

Measured: 72 products in this state. 3 carry a stranded mapping row — 2 Meituan, 1 gzgrocery, 0 Eleme. The other 69 were cleaned up correctly, so this is a missing guard, not a systemic failure of delete.

The three:
- map 957, product 254 Yasmin White 2023 — `last_pushed_at` NULL. Has NEVER pushed successfully. 190 terminal failures between 2026-06-28 and 2026-08-26.
- map 895, product 193 Quinoa Green Lentil Buddha Bowl — pushes succeed, holding the listing at qty 0.
- one gzgrocery row, not itemised.

Both Meituan products have an empty SKU.

## F2 — `status` and `is_active` are two fields for one idea, and the mapping layer reads the dead one

`store_products` carries both. Deactivation flips `is_active` and leaves `status` at 'Active'. Distribution: Active/1 = 248 products, Active/0 = 72, Inactive/0 = 5. The five are the only rows where the two agree about being off.

The channel mapping layer treats 'Active' as live, so it treats all 72 as live.

UNDECIDED: which field survives. This belongs to the Products stage.

## F3 — Tacet has no variants, so sizes of one product collide on one channel listing

Meituan models a size as a spec under one listing. Tacet models it as a separate product with no relationship to its sibling. `meituan_product_map.spec_key` is the only thing keeping two such rows apart, and it is empty on rows created by name matching.

Three pairs collide today — same listing, no spec on either row, both enabled, last writer wins:

| listing | regular | small |
|---|---|---|
| 格兰诺拉脆麦片 Crunchy Granola | map 839, product 226, SKU 4-240, qty 18 | map 1004, product 358, SKU S(4-240), qty 93 |
| 无糖荞麦片Anti Inflammatory Granola | map 833, product 174, SKU 4-360, qty 6 | map 995, product 357, SKU S(4-360), qty 97 |
| 荞麦面包Gulten Free Buckwheat Brea | map 888, product 255, SKU 3-252, qty 15 | map 996, product 353, SKU S(3-252), qty 25 |

`S(...)` in a SKU denotes the small serving of that SKU — confirmed by Ash. These are real distinct products, not duplicates.

Ash confirmed the small granola is NOT listed on Meituan. Whether the small bread and small anti-inflammatory granola are listed is UNVERIFIED.

Where a size genuinely exists on Meituan as a spec, the mechanism works: Oatly Barista (maps 797, 76663, 76665) and Raspberry Mango Sorbet carry distinct `spec_key` values and distinct `units_per_pack`, and do not collide.

This is the clearest evidence yet for how variants must work in the Products stage: a channel mapping has to attach to a variant, not to a product.

## F4 — ~400 terminal Meituan failures since June, surfaced by nothing

`error_msg` 'update failed after retries · 多次重试仍失败' appears every single day from 2026-08-13 to 2026-08-26, 17–35 per day. Earliest occurrence 2026-06-27. All Tianhe; no Yuexiu rows.

A terminal row is never read again. The stock it carried stays frozen on the marketplace.

The five largest, by failure count, first and last day:
- Harissa Chilli Paste 1-240 — 196, 06-28 to 08-26
- Yasmin White 2023 — 190, 06-28 to 08-26 (see F1)
- Super-Seed Crackers 4-271 — 187, 06-28 to 08-26
- Whole-Wheat Pita (Frozen) S(3-251) — 182, 06-28 to 08-23
- Dried Yunnan Mango 4-200 — 116, 06-28 to 08-23

Ash confirmed Yasmin White and Super-Seed Crackers are no longer sold on Meituan.

Harissa, Pita and Dried Sour Mango each have a SECOND mapping row that pushed successfully on 2026-08-26. The product syncs; one row of the pair fails. Which row and why is UNVERIFIED.

The drift sweep watches for drift. Nothing watches the error pile. Four hundred failures accumulated over two months without surfacing.

## F5 — Mapping rows were created in bulk and never retired

`meituan_product_map` creation by day: 2026-06-22 — 138 rows (ids 796–961); 06-23 — 57; 06-28 — 122; 06-29 — 64. All 387 still `sync_enabled = 1`. The 06-22 batch is the Match-names run that ran without a permission gate.

By contrast, 2026-08-26 created 5 rows of which 1 is enabled — so something disables rows now. The June generations predate it.

Only 2 products carry duplicate enabled mappings, both created 2026-08-24, and both are legitimate spec variants. The June bulk runs did NOT produce per-product duplicates.

## F6 — The exact-name resolver is working

One row on 2026-08-27 09:55: no Meituan listing has the exact name '藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g）'. A refusal, not a wrong match. One product, not a class.

## F7 — Opening-hours pause is correct, not a fault

`poll_paused` 07:34 'outside opening hours', `poll_resumed` 09:46 'within opening hours', pushes flowing 09:45–09:57. A 'not synced' dashboard reading before opening is the daemon working.

Superseded in part, 2026-09-02: the pause is still correct, but its edge was in the wrong place. Waimai customers PRE-ORDER before a shop opens, so stock that first moved at 09:45 was quoting the previous day's numbers to every pre-order taken that morning — an oversell that surfaces as a refund, not as anything on this dashboard. The daemons now gate on a SYNC window rather than the opening hours: `retail_stores.sync_start_time` ("Sync starts · 同步开始", set per store on the Meituan and Eleme tabs), defaulting to two hours before opening — 08:00 for a 10:00 shop. See `lib/store-hours.js` `syncWindow()`; the 04:00 half of this finding is unchanged, and no store syncs round the clock.

## Three operator-blocking errors in the week

闪购 Chrome not logged in (3 occurrences, a human must log in on the box), and 验证中心 captcha challenges (6). Same class as the gzgrocery ERP session expiry that ran silently for a month.

## Method note

Every figure here came from `sqlite3 -readonly` at an interactive SSH prompt. Heredoc SQL works when pasted at an interactive prompt; it fails silently when wrapped as `ssh root@host "…"` from PowerShell, because the quoting does not survive. Both halves matter — recording only the failure would strip a working method.
