> Design hand-off — paste this when designing **1. App shell / core (top bar, nav, global UI)**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
