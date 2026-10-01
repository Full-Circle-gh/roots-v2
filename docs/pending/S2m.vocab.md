HEADLINE: CLOSING ELEME SAYS WHAT IT DOES — 5 STRINGS COMPOSED BY CLAUDE, ONE SENTENCE NO LONGER SHOWN FOR ELEME.

## Closing Eleme at a store, said truthfully (§NEW)

**Operator register (Rule 1), 2026-10-01.** The phone's Sales confirms
(`public/m.html` ELEME_CLOSE_WORDS), the desktop Sales grid's reopen confirm
(`public/retail-admin/01-core.js` csCell), and the desktop open/close panel's
note (`public/retail-admin.html`). The desktop strings copy the phone's
composed pairs word for word, so the two surfaces say one thing.

| String | Status |
|---|---|
| `Stock stops being sent to Eleme for this store: updates already waiting are dropped, and new ones wait until it reopens. Eleme is not told the store is closed — customers can still order there, and those orders still come in. · 将停止向饿了么推送该门店的库存：已排队的更新会被清除，新的更新等到重新开启后再发送。饿了么不会收到门店关闭的通知 — 顾客仍可下单，订单照常导入。` | **composed by Claude.** Built from X12's live `停止向美团推送库存`, the live `已排队` and `订单未导入`, and `门店关闭` from the shop switch. |
| The same for every store (`for every store` / `所有门店`, `the stores are closed`) | **composed by Claude.** The sentence above, with the store widened to every store. |
| `Stock is sent to Eleme for this store again. · 恢复向饿了么推送该门店的库存。` | **composed by Claude.** Built from X12's live `恢复向美团推送库存`. It is also shown on the desktop. |
| `Stock is sent to Eleme again. A shop that is closed stays closed. · 恢复向饿了么推送库存。已关闭的门店保持关闭。` | **composed by Claude.** The second sentence is copied from X12's whole-channel opening confirm. |
| `Eleme is the exception: it is not told, so Eleme orders can still come in. · 饿了么除外：它不会收到通知，饿了么订单仍可能进来。` | **composed by Claude.** Added to the shop switch and Close everything confirms, and to the desktop panel's note. |

**No longer shown for Eleme:** `No new orders arrive at this store on this channel. ·
该门店在此渠道将不再接到新订单。` and `New orders can arrive at this store again. ·
这家门店可以重新接单。`. Both are still live for every other channel, where they
are true.

**Rejected:** keeping the old sentence and adding "except Eleme" to it. On the
Eleme confirm, the exception would be the whole message.
