> Design hand-off — paste this when designing **5. Customers · 顾客**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
