> Design hand-off — paste this when designing **3. Orders · 订单**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

## 3. Orders · 订单

### Orders list
- **Heading:** `Retail orders · 零售订单`.
- **KPI strip "Today's pulse":** `Orders today · 今日订单` / `Revenue today · 今日营收` / `Avg order value · 客单价` / `New customers · 新客`.
- **Status chip filter:** `All` / `Pending · pending_payment` / `Paid` / `Preparing` / `Dispatched` / `Delivered` / `Awaiting restock · awaiting_restock` / `Cancelled` / `Refunded` / `Refund queue · refunds_open` (open-work chips carry live counts).
- **Toolbar:** Store filter (2+ stores) · Search (order #/name/phone) · Refresh · **Bulk attach tracking** · **View** popover (Surface light/dark, Status signaling pill/bar/glyph, Row rhythm hairlines/striped/cards, Type mixed/mono).
- **Live refresh & notifications:** 12s poller; live pill (pause/resume); unseen-order tab badge + browser-title `(N)`; new-order chime + mute toggle; `NEW · 新` chip / fresh-row flash / unread bold.

**Table columns:** `Order # · 订单号` · `Customer · 顾客` (nickname + phone) · `Store · 门店` (+ `⚠ needs restock · 需补货`) · `Ship to · 收货地` (or `Pickup · 自提`) · `Items · 商品` · `Total · 合计` · `Status · 状态` · `Tracking · 物流` · `Ship by · 截止发货` · `Placed · 下单时间`.

**Row badges:**
- Refund: `↩ refunded · 已退款` / `part refund ¥ · 部分退款` / `refund req · 申请退款` / `reviewing · 处理中` / `approved · 已批准`.
- Add-on: `Updated · 加单`.
- Routing: `rerouted · 改派(缺货)` / `manually routed · 手动改派` / `out-of-city warehouse · 外地仓发货`.
- Tracking cell: pickup / local ETA / `⚠ missing · 缺运单号` / `{CARRIER} {waybill}` + sync state; multi-parcel rollup; live delivery-state chip (Delivered/Out for delivery/In transit/Picked up/Can't reach customer/Delivery issue/Returning/Returned/At pickup point/In a locker); **`⚠ AIR DELAYED · contact customer · 空运延误 · 联系客户`**.
- Ship-by cell: kicker (`Pickup time · 取货时间` / `Deliver · 送达时间` / `Ship by · 最迟发货` / `Requested timing · 原定时间`); urgency grey/amber/red; `OVERDUE · 已逾期` / `today · 今天` / `tomorrow · 明天`; `🥗 made fresh · 现做`; `Earliest courier day · 最早快递发出` + `placed Nd ago · N天前下单` + `no same-day paid · ship by courier · 未购当日达 · 快递发货`; `+¥ same-day · 当日`.
- **Bulk attach tracking modal:** default carrier select; `order#  waybill#` lines (optional per-line carrier); process → results table (`✓ saved` / `✗ error`, `auto-dispatched · 自动发货`).
- Empty: `No orders yet · 暂无订单` / `Inbox zero · 无待处理退款`.

### Order detail drawer
- **Header:** order #, status pill, `Partially shipped · 部分发货`, `+ Items added · 加单`, refund badge, `Order placed {date} · 下单于`, transition actions, **View** popover (Total placement banner/inline/footer, Items layout manifest/table/cards, Density comfortable/compact/editorial).
- **Top banners:** hoisted tracking card(s); refund banner; refund panel; order-total banner.
- **Info tiles:**
  - `Ship to · 收货人` / `Pickup · 到店自提` (recipient name·phone, address, `Edit ship-to · 修改收货地址`, `Make address Chinese · 转为中文地址`).
  - `Customer · 顾客` (nickname → customer drawer, `ID #`).
  - `Payment · 付款` (brand logo + status `paid/pending/refunded/failed`).
  - Alipay payment proof (thumbnail + OCR verdict: `✓ Auto-verified · 自动核对通过` / `⚠ Does not match · 不一致` / `Could not read · 无法识别`).
  - `Ship-by · 截止发货` tile (verbose urgency).
  - `Fulfilled by · 出货门店` (+ `⚠ Not in stock at this store · 该门店暂无库存`).
  - `Receipt · 小票` (status + `Reprint · 补打小票` / `Box label · 打印箱贴` / `Auto on waybill · 运单后自动`).
  - `Customer note · 顾客备注`, `🍴 Cutlery requested · 需要餐具`.
  - Invoice block (when `needs_invoice`).
- **Items & shipments:**
  - Split-suggestion banner (`📦 Suggested: split into 2 packages · 拆分为2个包裹`).
  - Outside-GZ split / combine notes + merge controls (`Combine into one parcel · 合并为一个包裹` / `Split into separate parcels · 拆分为多个包裹`).
  - Sort chips: `SKU` / `Shipping · 配送` / `As ordered · 原顺序`.
  - **Shipment cards** (per parcel): mode pill `Air shipment · 空运` / `Land shipment · 陆运` / `Local delivery · 同城配送` / `Supplier-direct · 供应商直发` / `Not yet in a parcel · 待分配`; state pill `Not shipped · 未发货` / `Dispatched · 已发货` / `Delivered · 已送达`; item rows; per-parcel dispatch; `Ship part later · 分批发货`; **GZ method toggle** `Rider · 骑手配送` / `JD logistics · 京东物流`; local ETA card; supplier tracking block.
  - **Item-row fields:** line #, thumbnail, primary name (→ editor), secondary name + size, `SKU` chip (`no SKU · 无货号`), `×qty` chip, `@ ¥unit`, `¥ line total`, chosen options (`▸ Question: Value`), bundle contents (`Inside this bundle · 套装内含`), pack/refund badges (`Supplier-direct · 供应商直发` / `Local · 仅广州` / `✈︎ Air only · 仅空运` / `Land only · 仅陆运` / `Refunded · do not ship · 已退款 · 勿发货` / `N of N refunded · 已退`).
- **Add-on timeline** (`Added later · 加单`), **Stock reservations** (Product/Qty/Channel/Status/Expires/Committed/Released).
- **Transition buttons** (per status): `Mark paid · 标记已付款` / `Start preparing · 开始备货` / `Mark dispatched · 标记已发货` (or `Mark all dispatched`) / `Mark delivered · 标记已送达` (pickup: `Mark ready for pickup` / `Mark picked up`) / `Restocked → Start preparing · 已补货 → 开始备货` / `Undo dispatch · 撤销发货` / `Undo preparing · 撤销备货` / `Refund · 退款` / `Cancel · 取消` / `Cancel + refund · 取消并退款`.
  - Mark-paid method picker: `Cash · 现金` / `Bank transfer · 银行转账` / `WeChat (off-app) · 微信(线下)` / `Alipay (off-app) · 支付宝(线下)` / `Other · 其他`.
- **Refund workflow:** state machine `pending → reviewing → approved → paid` (↘ rejected/withdrawn); panel with amount summary, staff note, history; dialogs for **Direct refund** (Full / Part by amount / Part by items — offers only un-refunded units → 2nd partial supported), **Approve** (+ reverse points), **Reject**, **Start review**, **Record payout** (method WeChat/Alipay/Bank/Wallet/Store credit/Cash/Other).
- **Tracking actions:** carrier select + waybill (`Save tracking · 保存运单号` / `Update` / `Clear`); `📦 Create JD label · 生成京东运单` (service: Fresh·Air `LL-SD-M` / Fresh·Ground `LL-HD-M` / Ambient·Ground `ed-m-0001`); `Cancel JD pickup · 取消揽收`; sync badges (JD/kd100 live / manual / inactive / retry); reuse banner; air-delay banner (🚨 contact customer + claim JD comp); recent events list + `View on carrier site →`.
- **Printing:** reprint receipt (Feie cloud printer, per-store picker); box label (local 70×45mm sticker, `BOX i/N`, auto-on-waybill toggle).

### Status / type enums (Orders)
- Order: `pending_payment, paid, preparing, dispatched, delivered, cancelled, refunded, awaiting_restock` (+ `refunds_open`).
- Refund: `pending, reviewing, approved, paid, rejected, withdrawn`.
- Shipment state: `pending, dispatched, delivered`.
- Shipment mode/type: `air, land, local (rider), supplier, pickup` (+ combined).
- Tracking: `picked_up, in_transit, out_for_delivery, delivered, exception, returning, returned`.
- Payment: `wechat, alipay, alipay_offline, cash, bank_transfer, wechat_offline, wallet, points, other`.
- JD services: `LL-SD-M, LL-HD-M, ed-m-0001`.

---
