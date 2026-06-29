> Design hand-off — paste this when designing **0. App map (primary navigation, in order)**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
