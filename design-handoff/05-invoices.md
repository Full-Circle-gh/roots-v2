> Design hand-off — paste this when designing **4. Invoices · 发票 (operator fapiao queue)**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
