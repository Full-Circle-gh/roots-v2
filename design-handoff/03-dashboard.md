> Design hand-off — paste this when designing **2. Dashboard · 概览**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
