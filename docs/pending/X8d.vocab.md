HEADLINE: MEITUAN BUNDLES ON THE PHONE — 12 CHINESE HALVES COMPOSED BY CLAUDE (THE DESKTOP BUNDLE STRINGS WERE ENGLISH-ONLY), THE REST COPIED.

## Meituan bundles on the phone (§NEW)

**Operator register (Rule 1), 2026-10-01.** The phone's Bundles screens
(`public/m.html`, the §325 X8d block). They are copied from `11-meituan.js`
and the Bundles tab markup. The desktop keeps the bundle title's four
sentences in `MT_PENDING_CN` (English-only), and its save and delete words
are plain English. The Chinese below is composed under the 2026-09-06
amendment; each string was searched for across `public/` first.

| String | Status |
|---|---|
| `Pick the title from the list. Typing it risks a difference you cannot see. · 请从列表中选择套餐名。手动输入可能产生看不出的差异。` | **Chinese composed by Claude (X8d)**; English `MT_PENDING_CN.bPick`. |
| `Matches a listing on this store. · 与本门店的一个商品相符。` | **Chinese composed by Claude (X8d)**; English `bMatches`. |
| `This stored title matches no listing on this store. It can be left alone, or replaced with one from the list. · 该已保存的套餐名与本门店的任何商品都不符。可以保持不变,或从列表中换一个。` | **Chinese composed by Claude (X8d)**; English `bStoredBad`. |
| `Refused — that name is not in the catalogue. Refresh it and try again. · 已拒绝 — 该名称不在商品名称中。请刷新后重试。` | **Chinese composed by Claude (X8d)**; English `refusedOne`. |
| `Pick a store. · 请选择门店。` | **Chinese composed by Claude (X8d).** |
| `Enter the Meituan bundle title. · 请选择美团套餐名。` | **Chinese composed by Claude (X8d).** It says 选择 (pick) rather than 填写 (enter), because on the phone the title can only be picked. |
| `Bundle saved. · 套餐已保存。` | **Chinese composed by Claude (X8d).** |
| `Delete this bundle? · 删除这个套餐?` | **Chinese composed by Claude (X8d).** |
| `This only stops auto-stock — it does not touch the Meituan listing. · 这只会停止自动同步库存 — 不会改动美团上的商品。` | **Chinese composed by Claude (X8d).** |
| `Delete bundle · 删除套餐` | **Chinese composed by Claude (X8d).** |
| `Deleted. · 已删除。` | **Chinese composed by Claude (X8d).** |
| `Delete failed: · 删除失败:` | **Chinese composed by Claude (X8d).** |

Copied whole (live pairs in `11-meituan.js` and the Bundles tab):
- **The tab and the list:** `Bundles · 套餐`; the tab's sentence `Combos sold on Meituan that use up your products. …`; `Add bundle · 新增套餐`, `Edit bundle · 编辑套餐`, `Suggest bundles · 套餐建议`; `No bundles yet. · 暂无套餐。`; `no components yet · 尚未添加组成商品`; `Available now · 当前可做`, `cap · 上限`, `sync off · 同步已关`, `pushed · 推送`; `Edit · 编辑`, `Delete · 删除`.
- **The editor:** `Store · 门店`; `Meituan bundle title — pick it from the list · 美团套餐名 — 从列表中选择`; `Maximum stock cap (optional) · 库存上限（可选）`, `none · 无`; `Components — the products this bundle uses up · 组成商品 — 该套餐消耗的商品`; `No components yet — add at least one. · 尚未添加组成商品，至少添加一个。`; `Search products… · 搜索商品…`; ` · inactive · · 已下架`; `qty · 数量`.
- **Suggest:** `N possible bundle(s) — Create sets the components · …`; `Create · 创建`; `No combo-looking titles found. …`.
- **The phone's own:** `Save · 保存`, `Save failed: · 保存失败:`, `No matches · 无匹配`.
