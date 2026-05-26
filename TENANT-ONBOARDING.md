# Onboarding a new company (tenant) — runbook

How to set up a new customer ("tenant") on the Mini App Backend SaaS. Roots is
tenant #1; every other company is its own tenant with isolated data.

Legend: ✅ = works today (just do it) · ⚠️ = needs a code addition (not built
yet — these are the "first real customer" tasks).

---

## 0. What to collect from the customer first
- Company name + the brand name/colour they want shown in the backend.
- Their **WeChat mini-program** (registered at mp.weixin.qq.com under *their*
  company) → its **AppID** (`wx…`) and **AppSecret**.
- Their **WeChat Pay** merchant details (mch_id, API v3 key, cert serial,
  private key) — for taking shopper payments and, later, subscription billing.

(The AppID is enough to start; AppSecret + Pay are needed before their
storefront can take logins/payments.)

---

## 1. ✅ Create the tenant
1. Sign in to the kitchen app as an **admin**, then open **`/saas-admin`**.
2. Click **+ New tenant**. Enter Company, Owner name, and a Username + Password
   (≥10 chars) for their first operator.
3. This automatically creates: the company, the owner login, a **14-day trial**
   subscription, and an **isolated empty database** for them.

## 2. ✅ Set branding + their WeChat AppID
1. In `/saas-admin`, click **Brand** on the tenant's row.
2. Set Brand name + Accent colour.
3. Paste their **WeChat mini-program AppID** → **Save**.
   - This is what routes *their* shoppers to *their* data.

## 3. ✅ Hand the operator their login
- They sign in at **`/backend/login`** with the username/password from step 1,
  immediately change it at **`/backend/account`**, and manage their products /
  storefront / delivery in **`/retail-admin`**.

## 4. ⚠️ Wire their WeChat login + Pay credentials (needs code)
- Today the server reads ONE set of WeChat login + WeChat Pay credentials
  (Roots') from global config/`.env`. A tenant needs **their own**.
- **Remaining work:** store per-tenant WeChat creds (AppSecret for
  `jscode2session` login; mch_id/API-v3-key/cert for Pay) keyed to the tenant,
  and have the auth + payment flows pick the current tenant's creds.
- Until this exists, a tenant's shoppers can browse (read-only) but can't log
  in or pay on that tenant's storefront.

## 5. ⚠️ Their mini-app build sends its AppID (needs a one-time client change)
- Each tenant publishes the `miniapp/` WeChat mini-program under *their* AppID.
- **Remaining work:** the `miniapp/` client must send the **`x-wx-appid`**
  header (from `wx.getAccountInfoSync().miniProgram.appId`) on its API calls.
  This is one change that applies to every tenant build.

## 6. Verify isolation (before flipping switches)
1. Sign in as the new tenant's operator at `/backend/login`.
2. Confirm `/retail-admin` shows **their** (empty) products/orders — **not
   Roots'**. If you see Roots' data, stop and check the AppID + the switches.

## 7. Go-live switches (server `.env`, then `pm2 restart roots-v2`)
- `TENANT_DATA_ISOLATION=1` — turn on per-tenant data routing for backend
  operators (until set, non-Roots tenants are held at the billing page).
- `BACKEND_SIGNUP_OPEN=1` — only if you want public self-service signup at
  `/backend/signup` (otherwise leave off; you provision tenants from
  `/saas-admin`).

## 8. ✅ Billing
- New tenants start on a 14-day trial. They pick a plan at **`/backend/billing`**
  → an invoice is raised.
- **Recording payment today (manual):** `/saas-admin` → the tenant → **Details**
  → **Mark paid**. That activates the subscription and extends the period.
- The daily job sends renewal reminders (T-14/7/3/1) and walks unpaid
  subscriptions through past-due → grace → suspended automatically.
- ⚠️ **Automatic** online payment (WeChat/Alipay/Stripe) = Phase 3 #1 — the
  adapter is built; it needs the provider's merchant credentials wired in.

---

## Quick state of the system
- ✅ Separate branded backend login + per-tenant operator accounts
- ✅ Billing: plans, subscriptions, invoices, lifecycle/reminders, access-gating
- ✅ SaaS-admin console (manage tenants, branding, payments)
- ✅ Tenant provisioning + isolated per-tenant databases
- ✅ Data isolation across the backend (`retail.js`, inventory) + public
  storefront routing by AppID
- ⚠️ Per-tenant WeChat login + Pay credentials (step 4)
- ⚠️ `miniapp/` sends `x-wx-appid` (step 5)
- ⚠️ Automatic online subscription payment (step 8)
