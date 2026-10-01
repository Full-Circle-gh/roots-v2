## §NEW — BILLING NEEDS A PERMISSION, AND THE TWO DOORS THAT SEND EVERYONE TO PAY STAY OPEN

**Built 2026-10-01 under §325** (§325.3's rule; found while building the phone's Billing, §325 X13).
Every `/api/backend/billing*` route (`routes/billing.js`, `routes/billing-pay.js`)
accepted any signed-in operator. So anyone in the back office could raise an
invoice, change the shop's plan (which also marks the subscription past due) or
start a checkout. The capability keys `billing:view` and `billing:pay` existed
but nothing on the server checked them.

1. **Reads and writes now take `billing:view` or `billing:pay`**
   (`lib/cap-routes.js` billingCap). Those are the keys that open the two screens
   using these routes today:
   - The desktop Billing page. Its door is the Settings link tagged
     `data-cap="billing:view"`, and the page then draws Choose for whoever is on
     it. So `billing:view` alone can pay there today, and keeps that.
   - The phone's Billing screen (X13): `billing:view` to open it, `billing:pay`
     to choose a plan.

   The owner holds every key. The admin and manager presets hold `billing:view`
   and keep their access. The shop-floor and narrower presets hold neither and
   are now refused.

   The gate is the six routes: billing, plans, providers, select-plan, checkout
   and payment-status. `mark-paid` and `run-lifecycle` stay SaaS-admin only. The
   WeChat callback stays unauthenticated, because its signature is the gate.
2. **Two doors reach the Billing page with no key at all, and both stay open**
   (`lib/require-cap.js` requireBillingAccess):
   - **A shop that is not active** (suspended for non-payment). `serveRetailAdmin`
     sends every operator of it to `/backend/billing?suspended=1` to pay.
   - **The provisioning hold.** Until `TENANT_DATA_ISOLATION=1`, every operator
     of a tenant other than Roots is sent to `/backend/billing?provisioning=1`.

   Shutting either door would take paying away from people who can pay from a
   screen today, which §325.3 does not allow. Whether these doors should stay
   keyless is Ash's decision. Until isolation is cut over, the second door means
   the gate bites only on Roots' own operators, and Roots' internal plan already
   refuses a plan change.
3. **Enforced whether or not the shop has switched enforcement on.** This works
   like the Team and store-staff writes, which use `requireCap` the same way.
4. **Not changed** (both go to Ash): choosing a plan still marks the
   subscription past due at once, and the desktop page does not yet show a
   refusal. A refused operator, who can only reach the page by its URL, sees it
   stay on "Loading…".
