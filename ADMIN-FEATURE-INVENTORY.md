# Admin Console — Full Feature Inventory

> **Surface:** the operator / back-office admin app (`store.rootskitchenchina.com`).
> **Purpose:** complete field-level map of every screen, panel, field, column, button,
> badge and status — the system in a *clean state* (structure only, no real catalog/customer data).
> Built for the Canva redesign / reorganization pass. Source of truth = the admin code itself
> (`public/retail-admin.html` + `public/retail-admin/01..10-*.js` + `public/product-editor.html`).
> Bilingual labels are shown as `English · 中文` exactly as they appear in the UI.

---

## 0. App map (primary navigation, in order)

The admin is a single-page app with a fixed **top bar** + a horizontal **tab bar**. Tabs are a
mix of flat tabs and dropdown groups.

**Flat tabs (daily essentials):**
1. Dashboard · 概览
2. Orders · 订单  *(unseen-order badge)*
3. Invoices · 发票  *(unseen-request badge)*
4. Customers · 顾客
5. Products · 产品
6. Categories · 分类
7. Editor · 编辑器  *(hosts Mini-App CMS + Product-Page editor iframes)*

**Dropdown groups:**
8. **Marketing · 营销** → Coupons · 优惠券 / Flash sales · 秒杀 / Pop-ups · 弹窗 / Affiliate · 分销 / Share cards · 分享卡片 / Broadcasts · 广播 / Social proof · 社交证明
9. **Loyalty & Wallet · 会员与钱包** → Membership & points · 会员积分 / Top-up · 充值 / Leaderboard · 排行榜 / Voting · 投票
10. **Content · 内容** → Copy · 文案 / About page · 关于页 / Media · 媒体库 / Legal pages · 法律条款 / FAQ & help · 常见问题
11. **Inbox · 收件箱** → Reviews · 评价 / Feedback · 反馈  *(unseen badges)*

**Flat tab again:**
12. Delivery · 配送

**Right-pinned:**
- Live/auto-refresh dot · order polling on/off
- Notification-sound toggle · chime mute
- Settings · 设置 (gear)  → sub-panels: Shop tab / Push notifications / Customer service / Operations

> Feature-gated tabs (Affiliate, Social proof, Membership, FAQ, Reviews, Feedback) dim when the
> plan entitles but the operator hasn't enabled them, and show an inline on/off "enable" card.

---

## 1. App shell / core (top bar, nav, global UI)

### Login
- Separate server-rendered page at `/backend/login` (cookie session). The SPA itself has no login form; a `401` from any API call hard-redirects to it.
- **Sign out:** account menu → `Sign out · 退出登录`.

### Global top bar
- **Brand block:** roundel logo + `Online Store` label.
- **Command search pill** — `Search · 搜索` + `Ctrl K` hint → opens command palette.
- **Account dropdown** (avatar):
  - Header: avatar, name, role line (role + tenant). Roles: `Owner · 负责人 / Admin · 管理员 / Staff · 员工`.
  - `Account · 账户` (→ `/backend/account`)
  - `Manage team · 团队管理` (→ `/backend/team`)
  - `Appearance · 外观` — light/dark toggle (value chip)
  - `Text size · 字号` — UI scale cycle (100/110/125%)
  - `Language · 语言` — EN ↔ 中文
  - `Sign out · 退出登录`

### Tab switching / groups
- Clicking a tab activates its section, closes any open drawer, closes open popovers, marks parent group active.
- Settings has its own left sub-nav (Shop / Push / CS / Operations).

### Mobile shell (≤720px)
- **Bottom tab bar:** Home · 概览 / Orders · 订单 / Customers · 顾客 / Products · 产品 / More · 更多.
- **"More" sheet** — every non-primary tab, grouped, + Text size / Theme / EN / 中文 controls.
- `?wx=1` adds WeChat-embed mode.

### Global UI framework
- **Toasts** (`#toast`) — ok/err variants.
- **Command palette** (Ctrl/⌘K) — keyword search over every page, settings panel, and individual setting; rebuilt from live DOM.
- **Side-drawers** — used by Orders / Customers / Categories / Pop-ups etc.; Esc / click-outside dismiss.
- **Feature gating** — body classes `ent-*` (entitled) / `feat-*` (enabled); dimmed nav + enable card when entitled-but-off; fully hidden when not entitled.
- **Multi-store switching** — NOT global; a store segment lives inside Products (only when 2+ stores).
- **Payment-brand badges** — reusable WeChat / Alipay logo chips + off-app labels (Cash / Bank transfer / WeChat off-app / Alipay off-app / Other).
- **Bilingual runtime** — `cuT(en,cn)` / EN↔中文 toggle, with a DOM auto-translate walker (see §15).

---

## 2. Dashboard · 概览

### Delivery alerts banner (conditional)
- `Delivery alerts · 配送异常提醒` + count; up to 8 rows (state icon, order #, buyer, delivery-state label) → open order; `+N more · 更多`.

### "Right now · 实时" hero (bento, desktop)
- Sync stamp (`synced just now · 刚刚同步` …).
- **Live pane** — animated ring + live viewer count, `Viewing products · 浏览中`, sub line.
- **Today pane** — 3 count-up cells with delta badges + hover sparklines: `Revenue · 营收`, `Orders · 订单`, `New customers · 新客`.
- **Activity feed pane** — `Activity · 动态`; rows (time, icon, text) click through to order/customer/product/feedback. Event types: Paid · 已付 / Dispatched · 已发货 / Delivered · 已送达 / Cancelled · 已取消 / Refund · 退款 / Refunded · 已退款 / Refund rejected · 退款驳回 / Top-up · 充值 / Low · 缺货 / Out · 售罄 / New · 新客 / Feedback · 反馈. Toggle: show 5 / show all.

### Date-range bar
- Segments: `Today · 今日 / 7d / 30d / 90d`; from/to date pickers; `Apply · 应用`; `↻ Refresh · 刷新`. Drives bento tiles + Deep dive.

### 6 swappable bento tiles (each with `⋯` change-tile menu)
Default set: **Low stock · 缺货预警** (Low/Out sub-tabs) · **Refunds queue · 退款队列** · **Top products · 热销产品** · **Top customers · 顶级顾客** · **Top areas · 热门地区** · **Demand heatmap · 需求热力图**.
Swap-in options also include: **Customer mix · 顾客构成** · **Payment split · 支付构成** · **Delivery split · 配送构成** · **Abandoned checkouts · 弃单分析**.

### Deep dive (collapsible) — 8 KPIs + 12 charts
- **Display-options popover** — Trend chart style (Curve/Bars/Dots), Heatmap style (Cells/Dots/Dashes), Headline numbers (Light/Display/Mono).
- **KPI strip (8):** `Revenue · 营收`, `Orders · 订单`, `Avg order · 客单价`, `New customers · 新客`, `Visits · 访问`, `Unique visitors · 访客`, `Conversion · 转化率`, `Refund rate · 退款率` (each with delta/sub).
- **Charts / cards:**
  - `Trend · 趋势` — metric toggle Revenue/Orders/Visits; hover tooltip.
  - `Demand heatmap · 需求热力图` — 7 days × 24 hours, legend Fewer→More.
  - `Acquisition funnel · 转化漏斗` — Opened → Signed up → Checkout → Paid.
  - `Article views · 文章阅读` — Kitchen Notes seen → read.
  - `Order status · 订单状态` — bar per status.
  - `Payment & delivery · 支付与配送` — payment methods + delivery modes.
  - `Top products · 热销产品` / `Top customers · 顶级顾客` (ranked).
  - `Customer mix · 顾客构成` (Buyers/New/Returning + tier distribution Seed/Sprout/Root/Tree).
  - `Geography · 地域` (by city).
  - `Marketing impact · 营销效果` (point orders, points used/value, voucher redemptions).
  - `Traffic & sources · 流量与来源` (Opens/Sessions/Visitors/Conversion + WeChat entry-scene breakdown).
  - `Revenue composition · 收入构成` (Product vs Delivery, net revenue, discounts).
  - `Cohort retention · 客户留存` (M1/M3/M6/M12 + retention curve + cohort matrix table).

### Other
- **Activity drill-through drawer** (`Activity · 动态`).
- **Mobile dashboard** — dark live hero + report tiles that push full-screen reports.
- *No export/download button anywhere in the dashboard.*

---

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
- Ship-by cell: kicker (`Pickup time · 取货时间` / `Deliver · 送达时间` / `Ship by · 最迟发货` / `Requested timing · 原定时间`); urgency grey/amber/red; `OVERDUE · 已逾期` / `today · 今天` / `tomorrow · 明天`; `🥗 made fresh · 现做`; `As soon as possible · 尽快发货` + `placed Nd ago · N天前下单`; `+¥ same-day · 当日`.
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

## 4. Invoices · 发票 (operator fapiao queue)

> China VAT 发票 issuance queue — **not** SaaS billing. (No subscription/plan/usage UI exists in the admin.)

- **Filter segment:** `Pending · 待开` (count) / `Issued · 已开` (count) / `All · 全部` + `Refresh ↻`.
- **KPI tiles (clickable):** `Pending · 待开` / `Awaiting value · 待开金额` (+`across N orders · 共N单`) / `Issued · 已开` / `Oldest pending · 最久待开` (alert ≥7 days).
- **Per-order card → invoice block:**
  - Status badge `Issued · 已开` / `Requested · 待开` + type `企业 Company` / `个人 Personal`.
  - `Copy for accounting · 复制开票信息`.
  - Fields: `抬头 Title`, `税号 Tax ID` (company), `邮箱 Email`.
  - Issue form: fapiao link, `发票号码` (optional), `PDF / 图片` attach (≤10MB), `Mark issued · 标记已开`.
  - Issued view: `发票号码 No.`, `View fapiao · 查看发票`, issued date, `edit · 修改` (un-issue).
- Also surfaced inside the order drawer.

---

## 5. Customers · 顾客

### Customer list
- **KPI strip:** `Total customers · 顾客总数` / `New today · 今日新增` (delta + sparkline) / `Active base · 在册账户` / `Blocked · 已封禁` (alert when >0).
- **Toolbar:** search (name/phone/openid/order #); Tier filter (`All tiers · 全部等级` / Seed / Sprout / Root / Tree); Sort (`Recent login · 最近登录` / `Recent signup · 最近注册` / `Top spenders · 累计消费最多` / `Most points · 积分最多`); `Include blocked`; Refresh; **View** popover (Tier badge pill/square/underline, Recent-login highlight off/today/week, Empty value dash/no-name/Guest).
- **Table columns:** `# ` · `Customer · 顾客` · `Phone · 电话` · `Tier · 等级` (+ `Blocked · 已封禁`) · `Orders · 订单数` · `Points · 积分` · `Wallet ¥ · 钱包` · `Last login · 上次登录`.
- **Pager:** page size 20, total/page readout, Prev/Next.

### Customer detail drawer
- **Action bar:** `Edit profile · 编辑资料` / `Block · 封禁` ↔ `Unblock · 解封` / `Sign out all devices · 退出所有设备` / `Reset to new user (test) · 重置为新用户(测试)` / **View** popover (Recent orders collapsed/open, Chart height normal/tall).
- **Identity header:** avatar, name, `ID #`, phone/email, tier pill, `Blocked`, `Joined · 加入`, `Last login · 最近登录`, `N active sessions · 活跃会话`, app-build pill, openid.
- **Stats tiles:**
  - `Orders · 订单` — count, `Revenue · 收入`, `AOV · 客单价`, `Completed · 已完成`, `Refunded · 退款`, `Cancelled · 已取消`, `Last order · 最近订单`.
  - `Points · 积分` (+ `Adjust · 调整`) — balance, `Earned (lifetime) · 累计获得`, `Redeemed · 已兑换`, `Expired · 已过期`, `Admin adjust · 后台调整`, `Expiring next 30d · 30天内过期`.
  - `Wallet · 钱包` (+ `Adjust · 调整`) — balance, `Topped up (lifetime) · 累计充值`, `Bonus pts from top-up · 充值赠送积分`, `Admin adjust · 后台调整`, `Vouchers (unused/used) · 优惠券`, `Reviews · 评价`.
- **Orders-by-month chart** (last 12).
- **Detail pairs:** `Top items · 热销商品` (Item/Qty/Spend); `Addresses · 地址` (+ `+ Add address`, per-address Edit/Delete, Default badge).
- **Folds:**
  - `Diagnostics · 诊断` — error badge, `Copy summary · 复制摘要`, Device & app rows (App version / Phone / System / WeChat / Base library / Last seen), recent activity & errors table (When/Kind/Page/Message).
  - `Recent orders · 近期订单` (→ order drawer).
  - `Points ledger · 积分明细` (Source/Δ/After/Note/When).
  - `Top-up ledger · 充值明细` (Method/Amount/Bonus/Status/When).
  - `Affiliate · 推广` — their code (+ Reissue), referred-by, conversions, invites table.
- **Modals:** Edit customer (Nickname / Phone / Email / Gender / Birthday — tier auto-derived); Adjust balance (Delta + required Reason, points/wallet); Add/Edit address (Recipient / Phone / Province·City·District / Street / Detail / Postal / default).

### Enums
- Tiers (auto from lifetime spend): `seed / sprout / root / tree`. Gender: unknown/Male(1)/Female(2). Diagnostics kinds: `error / open`.

---

## 6. Products · 产品 (catalog management)

### Product list
- **KPI strip (clickable filters):** `Live` / `Out of stock` / `Low stock` (`≤ N left · 剩余 ≤ N`) / `Drafts`. + low-stock threshold input.
- **Toolbar:** search (name/SKU); Category filter; Subcategory filter; count readout; `Guided add · 向导添加`; `＋ Add manually · 手动新增`; **Layout** segment (Grid/Compact/List); **View** popover (Photo crop square/portrait/full, Status display badge/border/minimal, Empty photo icon/hatched/plain).
- **Multi-store stock switcher** (2+ stores) — `Stock for · 库存门店` All + per-store (editable when single store picked).
- **List columns:** drag grip · select · thumbnail · `Product · 产品` (EN+CN) · `Category · 分类` · `SKU` (or `N sizes · 规格`) · `Stock · 库存` (tinted; editable per store) · `Price · 价格` (or range) · `Shop · 上架` toggle.
- **Status pills:** `Designed` / `Plain` / `Draft` / `Variants` / `Bundle · 套装` / `Out of stock · 缺货`.
- **Bulk action bar:** Shop On/Off · Markets Yes/No · Fresh batch Yes/No · Shipping (Air+Land / Air only / Land only) · Badge (None/Auto/NEW/POP/SALE/HOT) · Delete.
- Drag-to-reorder; pager (50/100/200/All).

### Product editor (commercial form)
- **Main column:**
  - **Photos · 图片** — gallery (drag-reorder, Main · 主图, remove), upload, `🖼️ From library · 从图库选择` (≤8).
  - `Name EN · 名称(英文)` / `Name 中文`.
  - **Variants** (see below) · **Bundle (sold as one) · 套装产品** · **Buy together · 一起买** · **Options (customer chooses) · 选项**.
  - **Product details · 产品详情** (+ `Auto-fill from text · 智能填充`): Origin / Ingredients / Storage / Shelf life / Serving suggestion (each EN/CN).
  - **Description · 描述** — mode bar `Classic · 经典` / `Product editor ↗` / `Design On/Off` (`use_block_design`); stale-rebuild banner; full rich-text toolbar; side-by-side EN / 中文 editors.
- **Sidebar:**
  - `Show in shop · 在店面显示` publish.
  - **Flags · 标记:** `Sold at markets · 市集销售` / `Made fresh in batches · 分批现做` / `Ships directly from supplier · 供应商直发` / `Restock-only, internal · 仅内部补货`; **Out of stock policy** select (`Sold out everywhere · 全国售罄停售` strict / `Pre-order outside Guangzhou · 广州外可预订` backorder_gz).
  - **Pricing · 价格:** `Price ¥` / `Was price · 划线价`.
  - **Stock & status · 库存与状态:** `SKU · 货号`; Status select (`Active · 在售` / `Inactive · 停售` / `Seasonal · 季节性` / `Coming Soon · 即将上架`); per-variant×store stock matrix; `Low-stock alert at · 低库存提醒阈值`.
  - **Organization · 分类:** `Shop section · 商店分区` / `Subcategory · 子分类` / `Badge · 标签` (None/Auto/NEW/POP/SALE/HOT) / `Size · 规格`; `Free of (allergens) · 不含` (Nuts/Soy/Gluten/5 Spice); `Shipping · 配送方式` (Air/Land/Local only, Local exclusive).
  - **Internal notes · 内部备注**.
- **Footer:** Duplicate · 复制 / Delete · 删除 / autosave status / `Version history · 历史版本` (restore). Brand-new product auto-mints `DRAFT-` SKU; no manual save.

**Variants panel:** per-variant photo, Name EN/CN (`variant_label`/`_cn`), SKU, Weight, ¥, Was, Stock (per-store total), Show toggle, delete; `+ Add variant · 新增规格`, drag-reorder.
**Bundle-product panel:** component chips + `×qty`; `+ Add product`.
**Buy-together panel:** Title EN/CN, product chips, bundle price, auto-voucher.
**Options panel:** per option — Question EN/CN, type (`Pick one · 单选` / `Pick any · 多选` / `Type an answer · 填写`), Required; per choice — default, Choice EN/CN, `+¥` delta, stock-product link; `+ Add a pick (free)` / `+ Add paid extras`.

### Standalone Design-Block PDP editor (`/product-editor`)
- Top bar: Back · brand · product switcher · Live/Draft badge · language toggle · save status · `Save · 保存`.
- Left rail: Product list; **Card chrome** (Keywords EN/CN, Tagline EN/CN); **Colophon** (IP character grid of 10 mascots + Auto, Tagline EN/CN); **Sections** list (`+ Add section…`, `Smart paste · 智能粘贴`, draggable blocks).
- Center: phone-canvas preview. Right inspector: Block / Templates.
- **Block types:** `spec_strip · 规格条`, `hero_intro · 开篇引言`, `why · 为什么选它`, `ingredients_chips · 配料·云标签`, `ingredients_line · 配料·编辑式`, `allergen_card · 过敏原卡`, `how_to_use · 用法宫格`, `storage_box · 储存条件`, `notes_callout · 备注说明`, `big_stat · 大数字`, `callout_banner · 醒目横幅`, `pull_quote · 引文`, `image_band · 图片横幅`, `recipe_steps · 做法步骤`, `pairings · 搭配推荐`, `faq · 常见问题`, `nutrition_facts · 营养成分`.
- Smart-paste modal (split EN+CN copy into sections); template chooser.

### Enums
OOS policy `strict / backorder_gz`; Status `Active / Inactive / Seasonal / Coming Soon`; Badge `auto / new / pop / sale / hot`; Ship modes `air / land / local`; Option types `single / multi / text`.

---

## 7. Categories · 分类

- 2-level category tree (top → subcategory; `name` / `name_cn` / subs).
- Consumed by Products (filters + Organization selects); products list supports subcategory drag-reorder.
- *Tree create/edit/reorder UI is rendered outside the products module (core/marketing parts).*

---

## 8. Marketing · 营销

### 8.1 Coupons · 优惠券
- **Guided wizard** (`Start · 开始`): steps front (goal cards: Welcome gift / Store sale / Anyone can use / Free shipping / Start fresh) → deal (Money off / Percent off / Free shipping + value) → who (Automatic / Anyone / Welcome gift / I choose) → rules (min order, last day, per-person, total) → review (code, public labels EN/CN, heads-up notes; `Save & turn on` / `Save as draft`).
- **Advanced create:** Code · Type (`fixed_amount` / `percent` / `free_shipping`) · Value · Min subtotal · Max uses · Per customer · Expires · Public · Auto-grant · Auto-apply · Public label EN/CN.
- **List** `Active coupons · 启用中的优惠券`: Code (+badges PUBLIC/AUTO/AUTO-APPLY/GRANTED) · Public label · Type · Value · Min ¥ · Used · Expires · Status; actions Grant / Make public-private / Auto-grant / Auto-apply / Enable-Disable.
- **Grant modal:** grant-to-all, search+grant, already-granted list (Used/Unused, Revoke).

### 8.2 Flash sales · 秒杀
- Create/edit: Product picker · Flash price ¥ · Stock cap · Starts at (+ quick chips) · Ends at (+ quick chips) · "don't let coupons stack" checkbox.
- List: Product · Flash ¥ · Regular ¥ · Window · Sold/Cap · State.

### 8.3 Pop-ups · 弹窗
- List cards: on/off, name, status (Scheduled/Ended/Live/Disabled), meta, Edit.
- Editor (drawer + live preview):
  - **Basics:** internal name, Enabled, Dismissible.
  - **Where to show · 显示位置:** page chips (All / Home / Shop / Cart / Me / Product / Checkout / Order success / My orders / Membership / Addresses).
  - **When · 显示时机:** Trigger (`on_load` / `after_seconds` + delay), Frequency (`once` / `daily` / `session` / `every_visit`), Start/End date.
  - **Content:** image, Title EN/CN, Body EN/CN, CTA label EN/CN, CTA destination (dismiss / Shop / Cart / Home / Me / Membership / CMS pages / specific product / specific category).

### 8.4 Affiliate · 分销
- **Settings:** Reward (referrer) ¥ · Reward (referee) ¥ · Lifetime rate % · Lifetime months · Code prefix · Share-card picture.
- **List:** filters (status, search); summary (Total / Joined / Converted / Voided / Paid out); columns referrer / invitee / code / status (JOINED/ORDERED/VOIDED) / reward / joined / rewarded; actions Reward / Void / Restore.

### 8.5 Share cards · 分享卡片
- Per-page WeChat forward thumbnails: Home · 首页 / Product · 商品页 / Voting · 投票页 (upload + remove).

### 8.6 Broadcasts · 广播
- **Automatic notifications:** per-category switches Order & shipping / Invoices / Refunds.
- **Composer:** Title EN/CN, Body EN/CN, deep-link preset (Shop/Cart/My orders/Coupons/Membership/Refer/Voting/Top up/Custom), When (now / schedule), Activity audience (all/buyers/never/active/lapsed), Tier chips, Region chips, audience count; `Send broadcast` / `Schedule`.
- **Past & scheduled list:** status pills SENT/SCHEDULED/DRAFT/RECALLED/CANCELLED; Recall / Cancel.

### 8.7 Social proof · 社交证明
- **Checkout upsell pop-up:** enable; content (Bundles / Linked extras / Flash sales); max items 1–6.
- **5 engagement widgets** (enable + tuning): "N people bought this" (product) · Recent-buyers ticker (home, incl. manual fake entries) · "N viewing now" (product) · "Last ordered X ago" (product) · "X SOLD" badge (cards).

---

## 9. Loyalty & Wallet · 会员与钱包

### 9.1 Membership & points · 会员积分
- **Points settings:** earn rule (N pts per ¥M) · earn basis (`paid` / `subtotal`) · point value · expire months · points cover shipping.
- **Membership tiers table:** Key · Name EN · Name CN · Threshold ¥ · Points × · Perks EN/CN; `+ Add tier` / `Save tiers`. (seed/sprout/root/tree, auto-promote.)

### 9.2 Top-up · 充值
- **Create package:** Amount ¥ · Bonus points · Title EN/CN.
- **Packages table:** Amount / Bonus pts / titles / Active.
- **Recent transactions table:** When / Customer / ¥ / Bonus / Method / Status / Out trade #.

### 9.3 Leaderboard · 排行榜
- Visibility switch + status pill.
- Headline copy (Kicker/Title/Subhead EN/CN).
- Ranking rules: Metric (`lifetime_spend` / `points_balance` / `orders_count`), Period (all/year/month/week), Show top N, Reveal nicknames (`first_char` / `full` / `masked`).
- Rewards (Top 1 / Top 3 / Top 10, EN/CN).
- Placeholder board: show placeholder members, top spender ¥, member count, Generate, hide real members.
- Live preview; Save.

### 9.4 Voting · 投票
- Intro tagline EN/CN + Show vote counts.
- Poll list (question, meta, Featured badge, status Draft/Open/Closed; Edit / Open-Close-Reopen / Delete).
- Poll editor: Question EN/CN, Category kicker EN/CN, Explainer EN/CN, Options (2–8: letter, Label EN/CN, color, vote count), Status, Reward points, Closes at, Featured, "Show vote count as" display boost, (edit-only) Winner option / Sort / Hard-reset options.

---

## 10. Content · 内容

### 10.1 Copy · 文案 (mini-app snippets)
- Bilingual EN/中 text pairs grouped: **Cart** (kicker/title/empty/checkout button) · **Checkout** (kicker/title/place-order) · **Product detail** (add button/sold-out) · **Profile** (greeting `{name}`/kicker `{since}{level}`) · **Order tracking** (in-transit/delivered/help link) · **Onboarding** (skip/next/done).
- `Save all copy · 保存全部文案` / `Reset to saved · 重置为已保存`.

### 10.2 About page · 关于我们
- **Manifesto:** kicker EN + suffix CN, body EN/CN.
- **Stat strip** (4 cells: value EN/CN, label EN/CN).
- **Founder:** section kicker, name, title, quote (all EN/CN), photo.
- **What's IN / What's OUT:** kicker + two bullet lists (EN/CN, add/remove).
- **Sign-off:** headline EN/CN, button label EN/CN.

### 10.3 Media · 媒体库
- Folders sidebar (All / Unsorted / custom folders w/ rename·delete, + New folder).
- Toolbar: search, MIME filter (JPEG/PNG/WebP/GIF/SVG), Refresh, Upload, tag-chip filter.
- Grid cards (thumbnail, used-where badge, filename, dimensions+size); Load more; bulk bar (Move to / Tag / Delete / Clear).
- Detail drawer: Filename · Alt text · Folder · Tags · URL (copy) · Used in · uploaded-at; Delete/Save.

### 10.4 Legal pages · 法律条款
- Privacy policy (EN/CN body) · Terms of service (EN/CN body); `Save legal pages`.

### 10.5 FAQ & help · 常见问题
- **Categories table:** id · English label · 中文标签 · Colour (palette select); `+ Add category`.
- **Questions table:** per-Q Category, id, move ↑/↓/remove, Question EN/CN, Answer EN/CN; `+ Add question`, `Reset`.

> The home-page block CMS ("Mini App Editor") is an embedded iframe (`/cms`) — its block catalog is owned by that app.

---

## 11. Inbox · 收件箱

- **Reviews · 评价** (feature-gated; unseen badge) — customer product reviews queue.
- **Feedback · 反馈** (feature-gated; unseen badge) — customer feedback queue.

> (Inbox surfaces appear in nav with unseen-count badges; detailed field-level review/feedback panels are gated and live behind the `reviews` / `feedback` entitlements.)

---

## 12. Delivery · 配送

### Coverage KPI strip
- `Active zones · 启用配送区` / `Provinces · 覆盖省份` / `Same-day · 同日达` / `Disabled · 已停用`.

### Cards
- **Global defaults:** kitchen address.
- **Delivery & pickup fees:** Free-shipping threshold · Standard fee · Same-day fee · Pickup packing fee · Pickup hours (open/close) · Minimum order.
- **Holiday mode:** status toggle, message EN/CN.
- **Fresh batch schedule:** status, anchor date, interval days, skip dates, popup copy (eyebrow/title/notice EN/CN).
- **Fresh order reschedule cutoff:** lock-at-hour (evening before).
- **Default delivery — rest of China:** status, flat fee, free-over, packing/item, packing cap, lead time.
- **GZ excluded-districts** chip grid.

### Delivery-zone table
- Sub-tabs: `Pricing · 定价` / `Scheduling · 时间`; search; `Add zone`; **View** popover (row density, badge style).
- Pricing columns: Zone (type chip GZ/City/City-wide/Province) · Base ¥ · Free over ¥ · Extras · On.
- Scheduling columns: Zone · Mode (Day-only / Time-slot) · Lead→Max · Same-day · Hours · Slot.
- Row actions: Duplicate / Delete; row click → drawer.

### Zone add/edit drawer
- Type segment (GZ district / Other city); location picker (district/city chips); display-name overrides.
- Pricing: Base fee · Free over · MAX flat (GZ) · Packing ¥/item (city) · Packing cap (city).
- Scheduling: Earliest lead · Furthest day · Kitchen hours · Slot length · Allow same-day (+SD fee, GZ) · Day-only.
- Active toggle; Delete / `Apply to others` / Save.
- **Apply panel:** which fields (Pricing / Scheduling / Active toggle) → which zones (All GZ / All cities / All / Clear).

### Zone field set
`zone_type, match_district, match_city, name_cn, name_en, base_fee, free_threshold, max_fee, packing_fee_per_item, packing_fee_cap, min_lead_days, max_lead_days, slot_start_hour, slot_end_hour, slot_duration_minutes, same_day_allowed, same_day_surcharge, day_only, is_active`.

> Carriers / shipment modes (air/land/rider/JD) are configured in **Operations** (logistics integration) and set per-order in **Orders**, not here.

---

## 13. Settings · 设置

Left sub-nav: **Shop tab / Push notifications / Customer service / Operations**. Shared `Save settings · 保存设置` bar (Operations cards save independently).

### 13.1 Shop tab · 商城页
- **Layout** select (List+sidebar / List compact / Grid 2col / Grid 3col / Gallery).
- **Default sort** (Featured / Newest / Price ↑ / Price ↓ / Popular).
- **Filter & controls bar** checkboxes: show sort / dietary chips / in-stock toggle / NEW-POP-SALE filter / price filter / hide out-of-stock / lock layout.

### 13.2 Push notifications · 推送通知
- **Order-status subscribe template** ID (WeChat).
- **New-order alert (WeCom app):** Corp ID / Agent ID / App Secret; Save / Send a test.
- **Alipay manual收款:** enable, payee label, 收款码 image; **Vision-AI OCR** (toggle): Anthropic API key, expected payee, accept-within-minutes, auto-mark-paid on match.
- **SMS when delivered (Aliyun):** AccessKey ID / Secret / Signature / Delivered template / Login OTP template / test phone; Save / Send test.
- **Group-bot webhook** (alternative WeCom).
- "What customers receive" explainer (read-only).

### 13.3 Customer service · 客户服务
- Mode (Off / WeCom / WeChat 客服 / QR code).
- WeCom creds (Corp ID, Service URL) or QR image.
- Button label EN/CN, hours EN/CN, phone.
- Placement checkboxes (Me / Home / Product / Checkout / Order).
- Floating bubble look: size, shape, icon (+ custom emoji), colour, side, height off bottom.

### 13.4 Operations · 运营
- **Ownership** banner (Self-managed).
- **Stores · 门店:** list + Add/Edit store (Code, Phone, Name EN/CN, City, District, Street address, Sort, Offer store pickup, GPS lat/lng).
- **Order routing — Maps geocoding:** provider status; Refresh status / Geocode all now.
- **Logistics integration:** **Kuaidi100 · 快递100** (Customer ID, Authorization key, Callback URL, Callback secret) and **JD Logistics · 京东物流** (app_key, app_secret, access_token, customer_code, API environment production/sandbox); Save / Save & test.
- **Receipt printing — Feie cloud printer:** account, USERKEY, auto-print toggles (paid order / add-on slip / refund slip), receipt header; per-store printers (SN, Template receipt/packing/compact, copies, preview, test); out-of-GZ printer; Save all.

---

## 14. Inbox / Reviews / Feedback

*(Listed under nav group 11; gated by `reviews` / `feedback` entitlements — see §11.)*

---

## 15. Cross-cutting / global features (Extras module)

- **Bilingual auto-translate engine** — splits `EN · CN` text, translates `data-tip` tooltips / titles / opt-in placeholders / prose block-pairs; opt-out via `data-no-i18n`; MutationObserver covers JS-injected content. Globals `cuToggleLang / cuT / cuLang / onLangChange`.
- **Help tooltip** — single floating popup for any `.help-i[data-tip]`.
- **Topbar controls** — Text size (100/110/125%), Theme (light/dark), EN/中文.
- **Live Preview drawer** — phone-shaped iframe of the storefront (`/storefront?preview=1`); Refresh / Open in new tab.
- **`?tab=` deep-link boot** — `/retail-admin?tab=orders` auto-opens that tab (used by push notifications).
- **"A new version is available · 有新版本可用" banner** — polls `/api/version`; Reload / dismiss.

---

## Appendix — file map (for engineers)

| Area | File |
|---|---|
| Shell / login / nav / topbar | `public/retail-admin/01-core.js` |
| Settings & Operations | `public/retail-admin/02-settings-ops.js` |
| Dashboard | `public/retail-admin/03-dashboard.js` |
| Orders | `public/retail-admin/04-orders.js` |
| Marketing / Loyalty | `public/retail-admin/05-marketing.js` |
| Delivery zones | `public/retail-admin/06-delivery.js` |
| Content (CMS) + Invoices | `public/retail-admin/07-content-billing.js` |
| Customers | `public/retail-admin/08-customers.js` |
| Products / catalog | `public/retail-admin/09-products.js` |
| Extras / i18n / preview | `public/retail-admin/10-extras.js` |
| Shared HTML shell | `public/retail-admin.html` |
| Standalone PDP block editor | `public/product-editor.html` |
