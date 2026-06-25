> Design hand-off — paste this when designing **13. Settings · 设置**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

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
