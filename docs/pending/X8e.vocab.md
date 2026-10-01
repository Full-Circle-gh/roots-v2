HEADLINE: GZGROCERY BILLING ON THE PHONE — 14 STRINGS OR HALVES COMPOSED BY CLAUDE (THE DESKTOP BILLING PANEL IS ALMOST ALL ENGLISH-ONLY), THE REST COPIED.

## gzgrocery billing on the phone (§NEW)

**Operator register (Rule 1), 2026-10-01.** The phone's Billing screen
(`public/m.html`, the §325 X8e block). The desktop panel (`12-guanyi.js`
`gyRenderAnalytics`) writes nearly all of its words in English only. The
Chinese below is composed under the 2026-09-06 amendment; each string was
searched for across `public/` first.

| String | Status |
|---|---|
| `Day · 日`, `Week · 周`, `Month · 月` | **Chinese composed by Claude (X8e).** No live pair for any of the three. Rejected: `Day-only · 仅按日` (a different meaning). |
| `gzgrocery price · gzgrocery 价格` | **Chinese composed by Claude (X8e).** |
| `Retail value · 零售价值` | **Chinese composed by Claude (X8e).** |
| `Avg discount · 平均折扣` | **Chinese composed by Claude (X8e).** |
| `N ordered product(s) have no gzgrocery price yet — counted in units but billed at full retail: · N 个已订货商品尚无 gzgrocery 价格 — 计入件数,但按零售全价计费:` | **Chinese composed by Claude (X8e).** |
| `Pickups appear here automatically as gzgrocery sells. · gzgrocery 售出后会自动出现在这里。` | **Chinese composed by Claude (X8e).** It sits under the live `No gzgrocery orders in this range yet · 暂无订货`. |
| `By day · 按日`, `By week · 按周`, `By month · 按月` | **Chinese composed by Claude (X8e).** |
| `Statement CSV · 对账单 CSV` | **Chinese composed by Claude (X8e)**, from the live `Billing · 对账`. |
| `Showing top 50 of N — full list in the CSV. · 显示前 50 个,共 N 个 — 完整列表见 CSV。` | **Chinese composed by Claude (X8e).** |
| `N units · 共 N 件`, `retail · 零售`, `u · 件` | **Chinese composed by Claude (X8e).** These are the desktop table's column words (Units, Retail), carried on each product's line, since a phone has no table. |
| `Could not save the file. · 无法保存文件。` | **composed by Claude (X8e), both halves.** The desktop has no failure path for the download. |

Copied whole:
- `Billing · 对账`.
- `They owe you · 欠款`, `Units ordered · 订货件数`, `Products · 商品数` (the desktop's Billing snapshot tiles).
- `No gzgrocery orders in this range yet · 暂无订货`.
- `From · 从`, `To · 至`.
- The phone's `Could not load this. · 无法加载。`.

The CSV file itself is the desktop's, English headers included, because it is
the same document.
