## §NEW — THE DASHBOARD ANSWERS FOR THE STORE IT NAMES, AND §317'S CLAIM IS NOW TRUE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Step S2b, the parity survey's defect 4. `GET /api/retail-admin/dashboard` read
`store_id` into its cache key and nowhere else. So three places named one store
and showed every store's figures:
- the desktop's store picker;
- the desktop's store lock (`RA_STORE_LOCK`);
- the phone Trend's store select (§317).

**§317 point 2 said Trend "also closes a leak"** by pinning a store-scoped
operator to their store. **That was wrong when it was written.** The phone sent
the store and the server ignored it, so the operator still read the whole shop.
§325.2 recorded this without editing §317. **It is true as of this step.** No
screen changed: both clients already send `store_id`.

1. **Which stores an answer covers** (`dashStoreScope`, new):
   - **No store asked for, and the operator not store-scoped:** every store. This
     answer is exactly what it was: the same SQL text, the same payload, and no
     new key.
   - **A store asked for** (a positive whole number; `all` or blank means every
     store): that store.
   - **A store-scoped operator** (`req.scopeStores`, which `requireRetailAdmin`
     sets): held to their scope whatever they ask for. If they ask for a store
     that is theirs, they get that store; otherwise they get all of theirs,
     never another store's and never the whole shop. An operator scoped to no
     store sees nothing. This is the rule the restock counts already follow
     (`routes/restock.js`, pick-count).
   Because the server does this, **every screen that reads `/dashboard` for a
   store-scoped operator now shows only their stores**, including the phone's
   Home and the desktop's Dashboard, which do not send a store on their own.
2. **What is narrowed is everything that carries a store**, which means every
   figure read from `retail_orders`. The paid predicates are narrowed in one
   place, `scopedP`/`scopedPO`, so the headline, trend, baseline, payment split,
   delivery split, store and channel breakdowns, routing, top products and top
   customers, buyers by channel, geography, vouchers and points, heatmap,
   cohorts, composition, the funnel and the mini-app block all describe the same
   orders. Store credit redeemed is narrowed too; it reads orders.
3. **Money that belongs to no store is left out of a store's revenue.** Wallet
   top-up cash is paid to the shop, and the legacy gzgrocery drift pickups carry
   no store. Folding the shop's total into each store would overstate every
   store by the same amount, and the stores would stop adding up to the shop.
   With them left out, the stores plus the top-up cash add up to the shop's
   answer, and the suite asserts that.
4. **Counts that belong to no store stay shop-wide, and the answer says so.**
   These are mini-app visits and sessions, new customers, the tier snapshot,
   launch scenes, checkout abandonment and article views; none of those tables
   has a store column.
   - A narrowed answer carries
     `store_scope: {store_ids, shop_wide: [...], left_out: [...]}`, so a screen
     can say which figures are the shop's. The every-store answer does not carry
     it.
   - Conversion is null for a store: one store's orders divided by the whole
     shop's sessions would divide one group of people by another, the fault the
     route's own note on conversion describes.
5. **"New buyer" still means first-ever paid order anywhere.** The "when did
   they first buy" subquery stays across every store, for the reason the
   mini-app block already gives: being new is a fact about the person, not about
   the store. Cohort retention is the store's own (its customers' first order at
   that store), because its sizes and its activity have to describe the same
   people.
6. **The cache key carries the stores covered, not the raw query.** A store's
   answer is never served from another store's cached copy, and the every-store
   answer keys exactly as before.
7. **Not done here:** Home's needs-you counts ignoring the store lock (defect 5)
   are the phone lane's step. The clients do not yet read `store_scope` or say
   which figures are shop-wide. That is a screen change for the Dashboard lane.
8. **Tests.** `scripts/test_dashboard_store_scope.js` (fast shard, 35 checks)
   runs the real router over a scratch database with two stores that have
   different takings, a refund and ¥200 of top-up cash. It checks:
   - the every-store answer: the sum, no new key, and `store_id=all`;
   - each store on its own: its orders, revenue, average order value, refunds,
     payment split, trend and top customers; top-up cash left out; conversion
     null;
   - that the stores plus the top-up cash equal the shop;
   - a store-scoped operator, including asking for another store and having no
     store at all;
   - that the cache keeps the three answers apart.
9. **Nothing composed.** No operator strings were added.
