HEADLINE: CHANNEL UPKEEP ON THE PHONE — 13 STRINGS COMPOSED BY CLAUDE (MOSTLY THE DESKTOP'S ENGLISH-ONLY MEITUAN CATALOGUE AND GZGROCERY LINES), THE REST COPIED.

## Channel upkeep on the phone (§NEW)

**Operator register (Rule 1), 2026-10-01.** The phone's channel upkeep cards
(`public/m.html`, the §325 X8a block) on the Meituan, Eleme and gzgrocery
screens. Most of the desktop's strings here are English-only:
- `11-meituan.js` keeps its catalogue line in `MT_PENDING_CN`;
- `12-guanyi.js`'s auto-match and push buttons and toasts have no Chinese.

The Chinese below is composed under the 2026-09-06 amendment. No live
Chinese existed for any of these; each was searched for across `public/`.

| String | Status |
|---|---|
| `Listing names read from Meituan · 从美团读取的商品名称` | **Chinese composed by Claude (X8a)**. English: `MT_PENDING_CN.catLabel`. |
| `never read · 从未读取` | **Chinese composed by Claude (X8a)**. English: `catNever`. |
| `Reads the current listing names. Changes nothing and matches nothing. · 读取当前商品名称,不改动也不匹配任何内容。` | **Chinese composed by Claude (X8a)**. English: `catHint`. |
| `Refresh catalogue · 刷新商品名称` | **Chinese composed by Claude (X8a)**. English: `catRefresh`. It says 商品名称 rather than 目录 because what is read is the names. Rejected: `刷新` alone (the gzgrocery button's word, and too bare beside Sync now). |
| `Reading… · 读取中…` | **Chinese composed by Claude (X8a)**. English: `catReading`. |
| `Catalogue updated. Nothing was matched or changed. · 商品名称已更新,未匹配或改动任何内容。` | **Chinese composed by Claude (X8a)**. English: `catDone`. |
| `Could not read the listings — is the sync service signed in? · 无法读取商品名称 — 同步服务是否已登录?` | **Chinese composed by Claude (X8a)**. English: `catFailed`. |
| `Refresh failed · 刷新失败` | **Chinese composed by Claude (X8a)**. English from `gyRefreshListings`. |
| `Auto-match by SKU · 按货号自动匹配` | **Chinese composed by Claude (X8a)**. English from the desktop button (its ✨ dropped). 货号 is the word the live gzgrocery hint uses for that SKU. |
| `Matching… · 匹配中…` | **composed by Claude (X8a), both halves.** The desktop's button has no busy label. |
| `Matched N product(s) · N ambiguous · N unmatched · 已匹配 N 个商品 · N 个有歧义 · N 个未匹配` | **Chinese composed by Claude (X8a)**. English from `gyAutoMatch`. |
| `Auto-match failed · 自动匹配失败` | **Chinese composed by Claude (X8a)**. English from `gyAutoMatch`. |
| `No cached Guanyi listings — click Refresh first. · 尚无已缓存的管易商品 — 请先点击刷新。` | **Chinese composed by Claude (X8a)**. The English is the server's own note (`routes/guanyi-admin.js`). Any other note the server sends is shown as it comes. |
| `Push all stock · 推送全部库存` on gzgrocery | **a live pair (Eleme's) used in place of** the desktop's English-only `Push all stock now`. |
| `Queued N product(s) · 已排队 N 个商品` on gzgrocery | **a live pair (Eleme's) used in place of** `Queued N reconcile(s) to Guanyi`. |
| `Refresh list · 刷新` | **trimmed** (the ⟳). |
| `Guanyi product list refreshed · 已刷新` | **copied** from the desktop's toast. |

Copied whole: `Sync now · 立即同步`; `Queuing… · 排队中…`; `Queued N stock
push(es) to Meituan · 已排队 N 个库存推送`; `Push failed · 推送失败`; `Queue a
fresh stock push for every mapped product · 为所有已匹配商品排队推送库存`;
`Sync from · 同步开始` and its sentence, `defaults to … · 默认 …`, `no opening
hours set — syncs all day · 未设营业时间 — 全天同步`; `Syncing this store from
… · 该门店 … 起同步`; `Could not save the sync start: · 同步开始时间保存失败:`;
the gzgrocery list line (`N listings read · 已读取 N 个商品`, `refreshing… ·
刷新中`, `cached · 已缓存`, `never refreshed · 未刷新`); and the auto-match
hint (`Products are matched by the SKU embedded in the Guanyi name …`).
