HEADLINE: MATCHING AND CLAIMS ON THE PHONE — 6 STRINGS COMPOSED BY CLAUDE, THE REST COPIED FROM THE MEITUAN, ELEME AND CHANNEL SYNC PANELS.

## Matching and claims on the phone (§NEW)

**Operator register (Rule 1), 2026-10-01.** The phone's channel matching
screen (`public/m.html`, the §325 X8c block). It is copied from the desktop
Meituan and Eleme product panels and the GZ Grocery mapping table. The
exceptions are below. Each composed string was searched for across
`public/` first, and no live Chinese was found.

| String | Status |
|---|---|
| `no listings read from this store yet, so nothing can be checked here · 尚未从该门店读取商品名称,无法在此核对` | **Chinese composed by Claude (X8c).** English: `11-meituan.js MT_PENDING_CN.noneRead`. |
| `This name matches no listing on this store. Pick one from the list. · 该名称与本门店的任何商品都不符,请从列表中选择。` | **Chinese composed by Claude (X8c).** English: `MT_PENDING_CN.pickIt` / `EL_PENDING_CN.pickIt`. |
| `No Guanyi listing carries this product's SKU. Refresh the list on the gzgrocery screen, then look again. · 没有管易商品使用该商品的货号。请在 gzgrocery 页面刷新列表后再查看。` | **composed by Claude (X8c), both halves.** The desktop's cell says `no match`, English-only, beside a Refresh button that sits on another screen here. |
| `Bind · 绑定` | **Chinese composed by Claude (X8c)**, from the live toast `Bound · 已绑定`. The desktop button is `Bind →`, English-only. |
| `Unbind · 解绑` | **Chinese composed by Claude (X8c)**, from the live toast `Unbound · 已解绑`. The desktop's ✕ carries `Unbind` as its title. |
| `N matches · 共 N 个匹配` | **composed by Claude (X8c), both halves.** The desktop's name field is a native dropdown and never counts. |

Copied whole:
- **From the desktop:**
  - `Open {channel} · 前往{channel}` (the Channel sync page's button);
  - `Meituan delivery name · 美团外卖商品名`, `Eleme listing name · 饿了么商品名`;
  - `Remove · 移除`, with Eleme's whole remove explanation and `This mapping carries no listing name.`;
  - `Which options is this product? · 这是该商品的哪些规格？` and the "Tick every option…" help;
  - `claimed by another product · 已被其他商品占用`, `units · 份`;
  - the add-on sentence (`N options: …`, `The count goes to …. The add-ons open and close with it.`);
  - the 闪购 SKU sentences;
  - Eleme's three store sentences (no shop linked, still holds a mapping, the "pick one of the N read" line);
  - `Size N · 规格 N`, `No matches · 无匹配`, `Mapping removed · 已删除匹配`, `Saved · 已保存`, `Bound · 已绑定`, `Unbound · 已解绑`;
  - the auto-match hint.
- **From the phone:** `Save failed: · 保存失败:`, `Could not load this. · 无法加载。`, `Nothing here. · 暂无商品。`.

Server refusals (`name_not_in_catalogue`, `catalogue_not_read`) arrive in the
server's English and are shown as they come.
