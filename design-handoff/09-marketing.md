> Design hand-off — paste this when designing **8. Marketing · 营销**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
