# Tacet shared-core consolidation — decisions record, v0.8

**2026-07-31 · A living record of what has been decided so far for the Tacet shared-core consolidation, so the decisions stop living in chat. Supersedes v0.1. The open questions in §23 are NOT decided and must not be treated as settled.**

v0.8 · 2026-07-31 — §10 gains two lines: the safety buffer is being BUILT, not adopted (nothing sets it today), and the reorder point is a separate number from the buffer. Both follow from `docs/tacet-stock-model.md` v1.1.

2026-07-30 · The app previously called the kitchen app is now the PRODUCTION APP. The KITCHEN flag on a location, kitchen locations and code identifiers keep their names.

---

## 0. Governing rules — these override everything below

These three rules govern every decision in this document and every decision made after it. Where anything in this document conflicts with them, these rules win and the conflicting decision is wrong.

1. FULL CIRCLE NO LONGER EXISTS. The name is retired completely. The system is Tacet. Any remaining Full Circle naming in code, documentation, UI or configuration is a defect to be removed.

2. TACET IS NOT BUILT FOR ROOTS. Roots is one customer that happens to be first. Nothing about Roots' business — its products, its city, its language, its currency, its sales channels, its suppliers, its way of working — may be assumed, hardcoded or treated as the default.

3. TACET IS A MULTI-BUSINESS PRODUCT. Businesses of any kind, in any country, must be able to register and use it. Every feature, every setting and every proposal must be evaluated against a business that is nothing like Roots.

### Consequences already identified
These follow directly from the rules above and correct earlier decisions in this document:
- SALES CHANNELS ARE NOT A FIXED LIST. The channel list recorded earlier (WeChat, Web, POS, Meituan, Eleme, GZ Grocery, Manual) is Roots' channel list, not Tacet's. Channels must be configured per business, with integrations offered as available options. GZ Grocery in particular is specific to one customer.
- CURRENCY IS PER BUSINESS. The codebase currently hardcodes CNY and the ¥ symbol in hundreds of places. This is a defect.
- UNITS OF MEASURE ARE PER BUSINESS. Grams and kilograms may not be assumed. A business using pounds and ounces must be equally well served.
- LANGUAGE IS PER BUSINESS. English-plus-Chinese may not be assumed or required. A single-language business must not be forced to supply two names for everything, and a business using two other languages must be supported.
- Already consistent with these rules, recorded for clarity: the business time zone is a per-business setting derived from the signup address, and the hardcoded category seed tree is being deleted rather than kept as a default.

### Standing test
Before any design decision is accepted, it must be checked against a business unlike Roots — for example a hardware shop in Ohio, or a bakery in Lisbon. If the decision only makes sense for a vegan food business in Guangzhou, it is wrong.

## 0.1 Domains and app structure

### Domains — DECIDED
Everything lives under tacet.com as a subdomain.
- `app.tacet.com` — where business users work. The Tacet app, Production, and Account settings all live here. ONE domain; moving between them never changes the domain.
- `backoffice.tacet.com` — Tacet staff only. Separate login and a hard wall: nothing internal may leak into a customer-facing screen.
- `shopname.tacet.com` — each account's storefront, issued automatically at signup. The account may attach its own domain later, at which point shoppers see that instead. Shoppers should not see Tacet's name on a storefront the account has branded.
- `tacet.com` itself is reserved for the marketing site and is not an application host.

Current state, for contrast: four separate hosts today — the store console, the production app, the internal console, and per-account storefronts — with the server deciding what to serve by Host header. This grew by accident, one host per app.

### Sections are paths, not hosts — DECIDED
Within `app.tacet.com`, everything is a path: `/orders`, `/products`, `/account/invoices`. One login, one session, no reload into a different application.

### Iframes — DECIDED
- NO NEW IFRAMES. New sections are built as paths within the app.
- Existing frames (Account, the product editor, the CMS) are left alone until other work brings someone into those files. This is not a cleanup project.
- Reasons: a framed section breaks the browser Back button, cannot be linked to directly, and forces a second copy of the styling and translation layer around it. Account demonstrates the cost — it is a standalone application with its own colour tokens and its own translation engine, which is why it looks like a different product.
- This directly conflicts with the module principle: a module is built once and used everywhere, and an iframe forces duplication of everything surrounding it.
- Most sections are NOT iframes today. Orders, Products and the rest are blocks within one page, shown and hidden. Only Account, the product editor and the CMS are genuinely framed.

### Account folds in — DECIDED
Account settings stop being a separate framed application and become part of the Tacet app, reachable the same way from any app. This is real work, not a configuration change: the current Account is a standalone four-pane application with its own token set and its own i18n engine.

## 1. Architecture target

- One backend, one database. VERIFIED ALREADY TRUE — single Express process, single SQLite file (database.js:8). The split was never at the database; it is at the table level.
- Two frontends for now: Store and Kitchen. Each frontend is the only app-specific layer.
- Every core entity exists exactly once. No duplicated tables, no sync jobs.
- The end state is a single application with one interface. Every decision here is made to make that merge cheap.

## 2. Permissions

- Permissions are per-capability, not per-frontend. A user holds capabilities; each frontend shows what that user's capabilities allow.
- Reason: a per-frontend model would have to be unpicked when the two apps merge into one interface. Capabilities survive the merge unchanged.

## 3. Items and products — CORRECTED, supersedes v0.1 §3

v0.1 stated one table with a SELLABLE switch. WITHDRAWN. The correct model:

- TWO separate lists. ITEMS and PRODUCTS are different entities with different tables and separate stock.
- ITEMS: kitchen only. Raw materials and anything produced for use in further production. Never sold. Never visible to the store app.
- PRODUCTS: sold to customers. Visible in both apps.
- There is NO sellable switch and no shared table.
- The bridge between the two is a RECIPE. Packing is production: bulk item in, product out.
- Worked example the model must support exactly as described: buy cashews (item) → produce cream (item) → produce cheese (product, from cream) AND pack cream into jars (product, from cream). The kitchen's bulk cream and the store's jarred cream are genuinely different things with separate stock. This is intended, not duplication.
- Confirmed: the store never sells directly from a kitchen container. Everything sold is packed first.

## 4. Product fields

Applies to the PRODUCT record only; items are kitchen-only and need no such split.

- Every field on the merged record is classified into exactly one of three groups: KITCHEN, STORE, or BOTH.
- KITCHEN = production, recipes, costing. STORE = selling and presentation. BOTH = shared, e.g. nutritional facts.
- Shared (BOTH) fields are editable from BOTH apps. There is no single owning side. DECIDED — do not reintroduce field ownership.
- The classification itself is pending the tacet-product-fields.md inventory.
- DIETARY INFORMATION IS CONSOLIDATED. DECIDED. It currently lives in four places — `nutrition`, `free_of`, `product_facts`, and blocks inside `description_blocks`. One dietary record per product; description blocks read from it rather than holding their own copy. Done as part of the Products stage; note it migrates content customers see.
- NO COST COLUMN EXISTS on either product table. Cost reaches a product only through `recipe_id`, which is dead on the store side. No product has a cost and margin cannot be computed at all. The cost method question therefore has nothing to decide against until a cost field exists.
- `needs_ice_pack` IS KNOWINGLY BROKEN. It is read live at checkout and decides the shipping label, but no screen can set it, so everything created since it was retired is permanently "no". DECIDED: not restored for now. Do not trust this field and do not build on it.

## 5. Concurrent edit safety

Because shared fields are editable from both apps, the merged product record must carry:

- A version stamp. On save, the server verifies the row has not changed since the client loaded it. On mismatch, reject the save and return a plain-English message telling the user the record was changed by someone else and to reload. Never silently overwrite.
- `updated_by` and `updated_at`, surfaced in the UI next to shared fields so a user can see who last touched them and when.

This supersedes the alternative of assigning an owning side per shared field, and closes risk R11 from tacet-core-survey.md.

## 6. Production

- Multi-level, any depth. Real-world depth today is three levels.
- A recipe may produce an item or a product.
- Cost rolls up through levels.
- A production batch records ACTUAL quantities used, not recipe quantities.
- Confirming a batch is what moves stock: inputs out, output in. Nothing moves before confirmation.
- Recipe output is FIXED. A recipe states its output quantity and a batch produces exactly that amount.
- Recipe INPUTS are recorded as actually used. Output is fixed. These two rules differ deliberately.
- Consequence, accepted: if a real batch under-yields, stock reads high. A stock recount is therefore required on the production side, matching the recount the store side already has.
- Packaging is consumed by production like any other input. A packing step consumes bulk item plus jar, lid and label and produces a product. Cost rolls up through it; no separate cost sheet exists.

## 7. Units

- Every item has ONE stocking unit. Its stock is always counted in that unit.
- Purchasing may use any unit, with a conversion stored on the item. Example: 1 sack = 25,000 g; ordering 2 sacks raises stock by 50,000 g.
- Recipes always use the item's stocking unit. No conversion at recipe level, no rounding.
- Roots weighs liquids in grams rather than measuring in ml, so an item purchased in ml needs a per-item ml-to-gram conversion, entered once. Per item, not global — oils and syrups differ.
- Products are counted in whole units.
- SUBJECT TO §0: units of measure are per business. Grams and kilograms are Roots' choice, not Tacet's default. A business working in pounds and ounces must be equally well served.

## 8. Packaging

- Jars, lids, labels and bags are ITEMS. Bought, stocked, costed and TRACKED by quantity.
- Consumed by the packing step, so cost rolls up automatically.
- Displayed separately from ingredients on screen — ingredients in one group, packaging in another. One mechanism underneath.
- Reason for tracking rather than costing only: running out of jars stops production exactly as running out of an ingredient does.

## 9. Locations

- Locations is a Tacet CORE module, shared by both apps. Not owned by either.
- Who can do what is decided by capability, not by which app the user is in.
- Two kinds: PHYSICAL and TEMPORARY. This is about permanence only.
- KITCHEN is a FLAG, not a kind. Any location may also be flagged as a kitchen. CONFIRMED.
- WAREHOUSE is not a kind. A warehouse is a physical location with no sales channel attached.
- Sales channels may be attached to any location, including one flagged as a kitchen.
- TEMPORARY locations: can be closed, can NEVER be deleted. Closing requires remaining stock to be moved to a named location and confirmed by a user.
- PHYSICAL locations: can be closed and continue to hold and manage stock.
- Replaces `markets`, `retail_stores`, and the plain-text warehouse/store names on purchase and restock orders.
- The existing `markets` rows are archived, not migrated. Only the warehouse and the kitchen carry across, by hand.
- MARKET STALLS ARE NOT RETIRED. The business will run market stalls again as new TEMPORARY locations. The old rows are retired; the capability is not.
- TEMPORARY locations are therefore REQUIRED IN THE FIRST BUILD, including the close-with-stock-move-out flow. Not a later phase.
- `retail_stores` IS THE SURVIVING TABLE and KEEPS ITS EXISTING IDS. Nothing is renumbered. Location ids are referenced by plain integer columns with NO foreign keys (`users.market_id`, `users.retail_store_id`, `retail_orders.store_id`, `purchase_orders.store_id`, others), so reassignment would fail silently — the same failure that caused the product id problem.
- THE LOCATION CODE SURVIVES. Around twenty integration tables key off the `code` string rather than the id. Kept and treated like a product SKU: validated on creation, permanent, never reused. Generated by the system and NOT shown on the location form — it appears only in integration screens.
- Migrating those twenty tables off the code was considered and REJECTED — more correct in principle, materially more risk, no visible benefit.
- `markets.kind` carries no behaviour worth inheriting. PHYSICAL / TEMPORARY and the KITCHEN flag are new construction, not a migration.
- SUBJECT TO §0: the KITCHEN flag needs a business-neutral name. A hardware shop has no kitchen. Rename pending.
- `meituan_stores` IS RETIRED, as part of the Orders stage. DECIDED — supersedes the earlier open question about folding it in or renaming it. It exists only so the Meituan tab can split takings by shop; that job is done properly by locations plus the Meituan channel plus one order record. It is read-only, populated solely by a manually run import script, and surfaces in exactly one place: the production app's Sales screen, Meituan tab.
- CARRY OVER WHEN RETIRING IT: the data is Meituan SETTLEMENT data — what Meituan actually paid. The live Meituan connection does not handle settlement; it handles stock and orders. The settlement import must land against a real location and the Meituan channel, in the single order record.
- Meanwhile the production app shows two lists both labelled "门店 Stores" — one editable (`retail_stores`), one not (`meituan_stores`) — with no visible link. Retiring this resolves it.
- SAFE CLOSING DOES NOT EXIST TODAY. Both deactivation paths are a bare `is_active = 0` with no stock check and no move-out. Deactivating a retail store leaves stock present but invisible and leaves user bindings pointing at it. The move-out-and-confirm flow is new build.
- Independent of the consolidation: the retail deactivation path should unassign its users, which the markets path already does.
- ONE FORM. Five separate screens currently create or edit a location, each with a different field set, so what a location holds depends on where it was created. The module provides ONE form used everywhere; other screens link to it rather than carrying their own.

## 10. Stock

- ONE stock record per thing per location. Nothing else. Totals are computed by summing, never stored.
- ONE movement ledger. Every stock change writes to it.
- The store's existing model is ADOPTED as the core: physical quantity, safety buffer, per-channel caps, reservations, ledger. Do not design a replacement.
- RETIRED: `products.stock_qty` and `market_stock`. `market_stock` has not been maintained by any real process; its numbers are untrustworthy and MUST NOT be migrated. Kitchen and market locations require a physical count at cutover.
- PHYSICAL and AVAILABLE are different numbers. Every screen must state which one it shows.
- The safety buffer holds stock back from sale. Set by whoever runs production. The shop can only sell what is above the buffer.
- 🔴 **THE BUFFER IS BEING BUILT, NOT ADOPTED. Recorded 2026-07-31.** The line above describes intent, not anything that exists. `safety_buffer` is a column with **no way in — no screen anywhere sets it** — so it is 0 on every row and the availability formula's `− safety_buffer` term subtracts nothing. Its only live consumer is purchasing, which reads it as a reorder point and, because it is always zero, **invents a buffer of 5 for every product in the system**. The Stock stage owes it a screen, a capability and a ledger row (raising a buffer reduces what can be sold exactly as removing units does, and today writes no ledger entry). `wechat_quota` and `meituan_quota` are unbuilt on the same terms; `restock_target` is the only layer column an operator can set. Full evidence and citations: `docs/tacet-stock-model.md` §1, *The buffer is unbuilt* and *Purchasing invents a buffer of 5*.
- The reorder point is NOT the safety buffer. They are two different numbers sharing one column today. Whatever the Stock stage builds must separate them, and the reorder point is a per-business setting — 5 is one codebase's magic number, not a Tacet default (§0 rule 2).
- NEGATIVE STOCK IS ALLOWED. A transfer always applies in full. If the origin holds less than the amount sent, it goes negative and the shortfall is recorded. Chosen over refusing the transfer, because goods have usually physically moved before anyone reaches the screen. SUBJECT TO §0 — this is a business policy and must become a setting, not a system law.
- A negative balance is a SIGNAL, not an error: the count is wrong and a recount is due. It must appear on a list someone checks, not be buried.
- Stock must never be silently clamped. Today `adjustStock`'s delta path quietly applies less than requested and discards the shortfall — withdrawn.
- The codebase currently has THREE rules for going below zero (order commit has no floor; the delta path clamps and discards; channel ingest clamps and records). All three are replaced by the single rule above, unified during the stock stage rather than piecemeal.

## 11. Users

- ONE list of people. ONE login.
- What a user can see and do comes from capabilities, not from which account or app.
- Migration: the two existing user lists both number from 1, so ids collide. Ids must be reassigned and every historical reference repointed. Flagged as careful, high-risk work.
- Fixes the existing gap where the activity log cannot record a store-side actor.

## 12. Purchasing

- ONE purchasing flow for the whole business. Same screen, same suppliers, same orders.
- An order line is simply: a thing, a quantity, a delivery location.
- Users see only what their capabilities and locations allow.

## 13. Sales record

- ONE sales record for the whole business. Every sale from every channel, written once, one shape.
- The kitchen's separate sales log is RETIRED, not consolidated. Confirmed: no kitchen-only sales exist.
- POS is REMOVED from the production app and becomes a sales channel like any other. A POS sale creates an order, moves stock, and lands in the sales record.
- Existing spreadsheet importers are repointed at the single record.
- A staff-created order MUST have a location. DECIDED. Today the field is optional; when left blank the order saves with no location, nothing routes it afterwards, and no screen can fix it, so it is permanently unfulfillable. The field becomes required, and a way to change an order's location afterwards is added.
- Fulfilment is by nearest location to the customer, computed from coordinates. Fulfilment priority survives only as a tiebreaker, not as the rule — confirmed by survey that it decides almost nothing once an address has coordinates.
- `ORDER_FULFILLMENT_TYPES` carries a third value, `counter`, that never reaches the customer path. Dead; delete it.

## 14. Channels

The agreed list, replacing two divergent sets of names:

- WeChat (mini-program shop) — absorbs the old `miniapp`
- Web (website) — absorbs the old `retail`
- POS — absorbs the old `dinein`
- Meituan
- Eleme
- GZ Grocery
- Manual

Channels are attachable to any location.

## 15. Time and dates

- Tacet is a product for multiple businesses. Nothing is hardcoded to Guangzhou.
- Each business has ONE business time zone, applying to every report and every "today".
- Set automatically from the address given at signup; changeable afterwards in settings.
- Business-wide, NOT per location, even for businesses spanning time zones.
- Displayed timestamps may render in the viewer's local time, always labelled with the zone.
- Business-day boundaries never follow the viewer's device.
- CONFIRMED BY SURVEY: no date or business-day calculation anywhere reads a per-location time zone; everything currently uses a fixed UTC+8. The only genuine consumer of `retail_stores.timezone` is collection-time validation at checkout. Making the business day business-wide breaks nothing.

## 16. Product state — replaces three overlapping flags

Today a product carries `status` (Active/Inactive/Seasonal/Coming Soon), `is_active` and `is_published`. All three are replaced by ONE state with three positions:

- IN SHOP — visible to customers
- NOT IN SHOP — still in use, not on display
- ARCHIVED — out of use, hidden everywhere automatically, retained in historical orders and reports

Archiving requires no other switch to be set first. Seasonal and Coming Soon are withdrawn as states; if wanted they become customer-facing tags, not states.

## 17. Item state

ONE state with two positions:

- IN USE
- ARCHIVED — removed from recipe pickers and purchase screens, retained in historical batches and orders

## 18. SKU on archive

- An archived product KEEPS its SKU permanently. The code is never released for reuse.
- Reason: a reused code makes historical orders and reports point at the wrong thing.
- This overrides the store side's current behaviour, which nulls the SKU on delete.

## 19. Categories

- TWO separate category systems with no overlap.
- PRODUCTS: keep the existing two-level tree (top category + subcategory). It is what customers navigate.
- ITEMS: their own separate category list, for finding things in the kitchen.
- DELETED: the legacy free-text `category` column on products, and the hardcoded fallback seed tree.
- Reason for separation: customer categories are shop navigation; item categories are a filing system. They would never share vocabulary.

## 20. Deletion policy

- Nothing with history is ever truly deleted. Everything archives.
- Archived things disappear from pickers and lists but remain visible in the historical records that reference them.
- People who leave keep their name on the work they did.
- SINGLE EXCEPTION: a record with no references anywhere may be hard-deleted — a mistake, a typo, a duplicate created minutes ago. The system must check for references before allowing it.
- This replaces today's inconsistent behaviour, where categories and kitchen users are hard-deleted with no reference check.

## 21. Modules — the shared components

Eight modules, each built once and used by any app:

Locations · Products · Items · Stock · Users · Orders · Purchasing · Recipes

- PRODUCTS and ITEMS are SEPARATE modules, matching the two-list decision. They must never be presented, grouped or built as one.
- ORDERS is a single module. An order is a sale; there is one record and reporting reads from it. There is no separate "sales" module.
- Not every front end uses every module. Items and Recipes are Production-only until the apps merge. Locations, Products, Stock, Users and Orders are used by both.
- FOUR front ends exist, not three: Tacet, Production, the customer storefront, and the Back Office. The storefront is not a separately maintained app — it reads the same Products, Stock and Locations modules. What a shopper sees is the same data staff edit, never a copy.

## 22. Rollout order and priority — REVISED 2026-07-31

CONTEXT: a second business is a TARGET, months away. No specific customer is waiting. Confirmed: no blackout periods, and nothing needs to jump the queue.

1. LIVE BUGS. Restock stock loss and the R1 id guard — FIXED (commit ff4c049a). Safety buffer not reaching Meituan, Eleme and Guanyi — STILL OPEN, live overselling. Catalogue showing a stock number checkout will not honour — handled in the Stock stage.
2. OPEN SIGNUP. The cheap multi-business blockers only: public signup, provisioning without a Roots admin, and removing Roots seed data so a fresh account starts empty. Contained, does not touch the consolidation.
3. LOCATIONS.
4. USERS.
5. STOCK. The floating-point money defect is FOLDED IN HERE, not done separately — those tables are being rebuilt anyway and a standalone migration would touch everything twice.
6. PRODUCTS AND ITEMS.
7. PURCHASING.
8. ORDERS. Includes retiring `meituan_stores` and the separate production sales log.
9. DEFERRED, after all of the above: multi-currency, additional languages, and the Production app merging into Tacet. These are entangled with everything being rebuilt; doing them first means doing them twice.

NEW ACCOUNTS START IN TACET. DECIDED, recorded as a decision rather than an assumption. To be revisited when Production can be sold on its own — a business that only manufactures would otherwise start in an app about selling to customers.

DO NOT ONBOARD A SECOND BUSINESS BEFORE STAGE 5 COMPLETES. Whatever is sold must be supported. A business arriving on the current model inherits two user lists, a forked catalogue and drifting stock, and unpicking that for two businesses is far worse than for one.

## 23. Open questions — NOT DECIDED

- COST METHOD — still not decided, and now blocked: no cost field exists to decide against.
- Final PRODUCTION/STORE/BOTH classification of every product field — docs/tacet-product-fields.md now exists; classification not yet done.
- Whether `low_stock_threshold` and `supplier_paused` are store fields or operational fields Production also needs.
- The `tags` field: documented as dietary, now used as a display badge. Which it is, and whether it splits.
- Rules for the three worst contested writes identified in the product field inventory.
- A plan for scaling languages on both the admin and customer surfaces.
- A business-neutral name for the KITCHEN location flag.

## 24. Related documents

- docs/tacet-glossary.md — binding definitions, v1.1, 2026-07-31. The words in this document are used with the meanings defined there. v1.1 adds CONSOLIDATION and the reserved uses of MERGE, and the APP / MODULE / FRONT END / domain vocabulary derived from §0.1 and §21 of this document.
- docs/tacet-core-survey.md — verified current-state inventory, 2026-07-30
- docs/tacet-product-fields.md — product field inventory, 2026-07-31. 78 columns; 41 contested writes.
- docs/tacet-stock-model.md — stock and reservation behaviour, v1.1, surveyed 2026-07-30. Records 14 inconsistencies in the store stock model; three were live bugs. v1.1 adds the two facts §10 above depends on: the safety buffer is unbuilt, and purchasing invents a value of 5 for it.
- docs/tacet-locations-survey.md — locations current state, 2026-07-31. Records that `markets` and `retail_stores` are two complete competing models, and that `retail_stores` already holds everything operationally real.
- docs/tacet-order-routing.md — how a fulfilment location is chosen (pending).
- docs/tacet-multibusiness-audit.md — audit against §0, 2026-07-31. 121 findings, 26 blockers. Headline: Roots is the default database, not a row in it.
