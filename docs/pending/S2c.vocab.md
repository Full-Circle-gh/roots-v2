HEADLINE: A SAVE REFUSED AS STALE ON THE PHONE — 1 STRING COMPOSED BY CLAUDE, FROM THE DESKTOP'S OWN REFUSAL.

## A save someone else got to first, on the phone (§NEW)

**One pair composed, by Claude, 2026-10-01, under the standing delegation (Rule 4 as amended).**
Operator register only (Rule 1): `public/m.html`, `staleSaveText()`. It is shown in two places:
- the category banner card, when the tree save is refused as `stale_tree`;
- the Pop-ups screen, when the switch is refused as `stale_config`.

In both cases the screen has already reloaded what the server holds, so the sentence has to say
that, and no live pair does.

| shipped | built from |
|---|---|
| `Somebody else changed this while you had it open. It has been reloaded — try again.` · `该记录已被他人修改,现已刷新,请重试。` | `01-core.js`'s `row_moved` / `not_mapped` / `not_syncing` refusal, `Somebody else changed this while you had it open — reload and try again. · 该记录已被他人修改,请刷新后重试。`, which the phone already shows for Channel sync (`csErrText`). The first clause is copied whole in both languages. `已刷新` is the desktop's own (`12-guanyi.js`, `Guanyi product list refreshed · 已刷新`). `现` marks it as done rather than asked for. `请重试` is the live pair's own ending without `刷新后`, because the reload has already happened. The comma is the live pair's ASCII `,`. |

**Live candidates rejected:**
- The live pair itself, `…— reload and try again. · …请刷新后重试。`. It tells the operator to reload, but the screen has already done that. On the pop-up switch, a reload by hand would be a second trip for a list that is already on screen.
- `That did not save. Nothing has changed — try again. · 没有保存成功。数据没有变化 — 请重试。` (the pop-up switch's own failure line, still used for every other failure). It says nothing changed. Here something did change: somebody else's edit, which is why the list on screen is now different.
- `This order has already moved on. Close and open it again to see where it is now. · 这个订单已经进入下一步。请关闭后重新打开查看当前状态。`. It is about an order's status.

**Copied whole, unchanged:** `Save failed · 保存失败`, `Saved · 已保存`, `Pop-up is on · 弹窗已启用`,
`Pop-up is off · 弹窗已停用`.
