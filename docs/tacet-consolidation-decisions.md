# Tacet shared-core consolidation — decisions record, v2.2

**2026-07-31 · A living record of what has been decided so far for the Tacet shared-core consolidation, so the decisions stop living in chat. Supersedes v0.1. The questions in §23 Open questions are NOT decided and must not be treated as settled.**

2026-08-03 · v1.0 — records the PostgreSQL database decision (§24). Note: v0.9 exists on an unmerged parallel branch (docs-glossary-stock-model-abi0fp) with different content; main skips to v1.0 to avoid a duplicate v0.9.

2026-08-05 · v2.2 — records the Language scaling decision (§25 Language scaling): six decisions, LOCKED. Related documents moves from §25 to §26. The §23 open question on scaling languages is resolved by it.

2026-08-05 · v2.1 — vocabulary only: one line in §9 now says "the multi-business move" instead of "the multi-tenant move", per the retired "tenant" glossary term. §24 is untouched — its dated standing entries are not rewritten.

2026-08-05 · v2.0 — MONEY STORAGE IS REVERSED: money is stored as DECIMAL, not whole cents. A locked technology decision changes, hence a full revision rather than a patch. Recorded in §24; the superseded line is left standing.

Cross-references in this document give both the section number and its name. If the two disagree, the NAME is correct — numbers shift when sections are inserted.

2026-07-30 · The app previously called the kitchen app is now the PRODUCTION APP. The KITCHEN flag on a location, kitchen locations and code identifiers keep their names.

2026-07-31 · The front end previously called the STOREFRONT is now the ONLINE STORE. Code identifiers, filenames and directories — `shop.html`, `miniapp/` and the like — keep their names.

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
- `shopname.tacet.com` — the address of an account's ONLINE STORE, issued automatically at signup. The account may attach its own domain later, at which point customers see that instead. Customers should not see Tacet's name on an online store the account has branded.
- `tacet.com` itself is reserved for the marketing site and is not an application host.

Current state, for contrast: four separate hosts today — the store console, the production app, the internal console, and per-account online stores — with the server deciding what to serve by Host header. This grew by accident, one host per app.

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

## 1. Architecture — LOCKED 2026-07-31

### Front end
FOUR front ends. The front end is the ONLY app-specific layer; everything beneath is shared.
- TACET — the main app. Staff.
- PRODUCTION — staff. Merges into Tacet later, leaving three.
- ONLINE STORE — customers. One shop per account, appearing as a website and as a WeChat mini-program, with further surfaces possible later. All surfaces show the same shop; an account configures it once. Read-only with respect to the modules.
- BACK OFFICE — Tacet staff only.

### Back end
- ONE service, ONE API. Not one per app.
- A set of SHARED MODULES, each built once. Eight named so far: Locations, Products, Items, Stock, Users, Orders, Purchasing, Recipes. MORE WILL BE NAMED — eight is not a ceiling. Already visible but not yet specified: suppliers, customers, marketing, content and media, integrations, reporting, billing.
- Every module is available to any front end. Which modules a front end uses depends on what that front end is for, not on staging. Production uses Items and Recipes; Tacet does not, because selling does not involve them. The online store reads Products, Stock and Locations and writes nothing. This does not change when the apps merge — the modules were always shared; the split was only ever in the interface.
- Permissions are capability-based and enforced in the back end.
- FRONT ENDS NEVER TOUCH THE DATABASE. A screen asks the back end; the back end reads the database.

### Database
- ONE database. Each thing exists in it exactly once. No duplicated tables, no sync jobs between them.
- Money stored as whole cents, never as a decimal.

### Technology decisions — LOCKED
1. FRONT END IS EXTENDED, NOT REBUILT. Screens are rebuilt one at a time as each stage reaches them. No wholesale rewrite — it would stop everything for months. Current state: hand-written JavaScript in very large files, one of 28,000 lines.
2. SQLITE STAYS through the consolidation. Revisit before a second business, not during. Changing the database engine and the data model at once doubles the risk. FLAG: SQLite permits one writer at a time. Adequate for one account; a genuine question for several. To be TESTED before onboarding a second business, not assumed either way.
3. ONE SHARED DATABASE STAYS FOR NOW; per-account databases are not adopted. FLAG WITH A DEADLINE: the per-account isolation switch is currently what locks every non-Roots account out of the app. This decision holds only until the open-signup stage, where it must be resolved.
4. THE ONLINE STORE REMAINS PART OF THIS SYSTEM. Not split into a separate service. Separating it would require an API between them and a second deployment.
5. THE BACK OFFICE IS BUILT PROPERLY AT THE OPEN-SIGNUP STAGE, not before. It half-exists today as a separate login and two consoles.

## 2. Permissions

- Permissions are per-capability, not per-frontend. A user holds capabilities; each frontend shows what that user's capabilities allow.
- Reason: a per-frontend model would have to be unpicked when the two apps merge into one interface. Capabilities survive the merge unchanged.

## 3. Items and products — CORRECTED, supersedes v0.1 §3

v0.1 stated one table with a SELLABLE switch. WITHDRAWN. The correct model:

- TWO separate lists. ITEMS and PRODUCTS are different entities with different tables and separate stock.
- ITEMS: kitchen only. Raw materials and anything produced for use in further production. Never sold. Never visible to Tacet.
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
- CLOSURE STATE MUST HANG OFF A LOCATION'S IDENTITY, NOT ITS CODE. Three switches mark a location closed and only one of them joins on the location itself: `retail_stores.is_active` on the row, `store_business_status.fulfillment_open` keyed on `store_code`, and `channel_status.is_open` keyed on `(channel, store_code)`. Both of those keys are plain TEXT with no foreign key, and an ABSENT ROW MEANS OPEN by design — see `storeClosedStores` and `channelClosedStores` in `lib/inventory.js`, which are also the only join sites.
- CONSEQUENCE: changing a location's code silently REOPENS a closed location. The closure rows stop matching, absence reads as open, and nothing errors — the same silent-failure class as the plain-integer location references above.
- The mechanism is OPEN — foreign key, immutable id, or forbidding code edits outright. What is DECIDED is that a label a person can edit must not be the thing closure depends on. This does not reopen THE LOCATION CODE SURVIVES above: that decision makes the code system-generated and permanent, which is exactly the mitigation. The point is that the join must not RELY on it. Today the protection is accidental rather than designed — `code` is simply absent from the store update allowlist (`routes/retail-inventory.js`), so nothing in the app can change it. The multi-business move puts far more hands on that field than today, and accidental protection does not survive it.
- ONE HOURS FIELD CANNOT ANSWER THREE QUESTIONS. `retail_stores.open_time` / `close_time` are read by three consumers with nothing to do with each other: `resolvePickupTime` (the customer-facing collection window), and `lib/store-hours.js`, which drives both the Qingyun ops-alert muting and — since 2026-08-02 — the 外卖 and 闪购 daemons' polling windows. Written from the store editor (`public/retail-admin/02-settings-ops.js`) through `PATCH /api/retail-admin/stores/:id`.
- BOTH PRODUCTION ROWS ARE BLANK, AND THE BLANKNESS IS LOAD-BEARING. Verified in code and against the live rows 2026-08-02. Blank is what makes collection fall back to the global `pickup.window` of 10:00–20:00. Filling one in to control a daemon would silently narrow that location's customer collection window — at yuexiu, from 10:00 to 11:00.
- DECIDED: a location's trading hours, its collection window, and when its staff should be paged are three different questions with three different answers. One field cannot answer all three, and they need three separate settings. NOBODY POPULATES `open_time` / `close_time` UNTIL THEY ARE SEPARATED. Resolve at the Locations stage.

## 10. Stock

- ONE stock record per thing per location. Nothing else. Totals are computed by summing, never stored.
- ONE movement ledger. Every stock change writes to it.
- The store's existing model is ADOPTED as the core: physical quantity, safety buffer, per-channel caps, reservations, ledger. Do not design a replacement.
- RETIRED: `products.stock_qty` and `market_stock`. `market_stock` has not been maintained by any real process; its numbers are untrustworthy and MUST NOT be migrated. Kitchen and market locations require a physical count at cutover.
- PHYSICAL and AVAILABLE are different numbers. Every screen must state which one it shows.
- The safety buffer holds stock back from sale. Set by whoever runs production. The shop can only sell what is above the buffer.
- NEGATIVE STOCK IS ALLOWED. A transfer always applies in full. If the origin holds less than the amount sent, it goes negative and the shortfall is recorded. Chosen over refusing the transfer, because goods have usually physically moved before anyone reaches the screen. SUBJECT TO §0 — this is a business policy and must become a setting, not a system law.
- A negative balance is a SIGNAL, not an error: the count is wrong and a recount is due. It must appear on a list someone checks, not be buried.
- Stock must never be silently clamped. Today `adjustStock`'s delta path quietly applies less than requested and discards the shortfall — withdrawn.
- The codebase currently has THREE rules for going below zero (order commit has no floor; the delta path clamps and discards; channel ingest clamps and records). All three are replaced by the single rule above, unified during the stock stage rather than piecemeal.
- THE SAFETY BUFFER IS EFFECTIVELY UNBUILT. Verified in code 2026-07-31: no screen in any of the five surfaces exposes a control that writes it; the column defaults to 0 on every insert path; no migration or seed sets it. A non-zero value could only exist via a hand-crafted API call or direct SQL. The API accepts the field and `upsertStockLayer` writes it, but nothing in the shipped front end sends it.
- CONSEQUENCE: the three channels not applying the buffer (Meituan, Eleme, Guanyi) are not overselling today, because nothing is being held back. That fix moves into the Stock stage rather than being urgent.
- WHEN BUILT: the buffer needs a screen, and every channel must respect it from day one. Default zero. The control should be hidden unless an account turns it on — many businesses will never need it, and multi-marketplace sellers will.
- HIDDEN RULE TO REMOVE: Purchasing substitutes 5 for a zero or unset buffer when computing its reorder point, server-side and again client-side. It never writes 5 back. So the Purchasing screen can display 5 while the stored value is 0. This is exactly the kind of baked-in business rule §0 forbids.

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
- FOUR front ends exist, not three: Tacet, Production, the customer-facing online store, and the Back Office. The online store is not a separately maintained app — it reads the same Products, Stock and Locations modules. What a customer sees is the same data staff edit, never a copy.

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

The PostgreSQL rebuild that stage 5 (Stock) depends on is specified in §24. The floating-point money fix folded into stage 5 happens as part of that rebuild.

## 23. Open questions — NOT DECIDED

- COST METHOD — still not decided, and now blocked: no cost field exists to decide against.
- Final PRODUCTION/STORE/BOTH classification of every product field — docs/tacet-product-fields.md now exists; classification not yet done.
- Whether `low_stock_threshold` and `supplier_paused` are store fields or operational fields Production also needs.
- The `tags` field: documented as dietary, now used as a display badge. Which it is, and whether it splits.
- Rules for the three worst contested writes identified in the product field inventory.
- A plan for scaling languages on both the admin and customer surfaces — RESOLVED 2026-08-05, see §25 Language scaling. No longer open.
- A business-neutral name for the KITCHEN location flag.

## 24. Database: PostgreSQL, one shared database, row-level account isolation — DECIDED 2026-08-03

DECISION: The platform moves from SQLite to PostgreSQL. One shared database holds every account. Each row is tagged with the account it belongs to, and the database itself enforces that no account can read or write another account's rows.

WHY THIS SHAPE: Chosen over a separate database file per account. With one shared database and row-level rules, the database enforces the wall between accounts. The file-per-account approach relied on every query filtering correctly by hand — one missed filter leaks another account's data. Making the database the enforcer removes that class of mistake.

RETIRED: The old file-per-account isolation (lib/tenant-db.js, gated by the TENANT_DATA_ISOLATION env flag, off everywhere) is superseded by this decision and is deleted in a later phase. Do not build on it.

DONE IN THE SAME REBUILD: Recreating all tables in PostgreSQL is also when two already-locked rules are applied, because the tables are being rebuilt anyway and a separate migration would touch everything twice — (a) money stored as whole cents as an integer, never a decimal (fixes the known floating-point money defect); (b) the tenant→account rename across tables, columns and identifiers, per the retired "tenant" glossary term.

NOTE — money conversion is near-total but not universal. During the Phase 1 schema translation, 101 REAL money columns were converted to integer cents. Two categories were deliberately left unconverted: percentage columns, and one polymorphic column, retail_vouchers.value, which holds a money amount for fixed-amount vouchers but a percentage for percent vouchers. Converting it as-is would corrupt the percent rows. Decision: leave retail_vouchers.value unconverted in Phase 1; split it into separate amount and percentage handling at the Stock stage, where the money model is built properly. Also flagged for the later data-copy phase: one retail_vouchers row has a non-ISO date (2026/10/6) that must be fixed before data is copied across.

ROLLED OUT IN PHASES, LIVE BUSINESS NEVER AT RISK: Phase 1 installs PostgreSQL alongside the running SQLite app; nothing points at it yet. Adding the account column, routing queries through one enforcement gate, copying Roots's data across, the switchover, and backups all come in later phases. Roots keeps trading on SQLite throughout, and does not move until the new account has run on PostgreSQL first.

WHAT THIS SERVES: The two-week goal — a second account live on Tacet plus their own web shop, both accounts sharing one PostgreSQL database and walled apart from each other, with Roots trading uninterrupted the whole time.

### Isolation is enforced by the database — DECIDED 2026-08-04

Row-level isolation is enforced by Postgres row-level security, not by hand-written query filters in application code. The database is the thing that blocks a cross-account read, so the wall holds even when application code is wrong. This is only possible in Postgres; SQLite cannot do it. That is why the Postgres switchover precedes the isolation work rather than following it — building the wall on SQLite first would mean building it twice.

### The account column is added staged, not all at once — DECIDED 2026-08-04

The account column is added to the unscoped tables module by module, following the locked consolidation sequence, rather than in a single migration across all ~140 tables. Each module gets its column and its row-level policy as that stage is reached. Rationale: each change stays small enough to verify against a live business, and no wall is needed on tables not yet reached — there is currently only one real account, so nothing can leak in the interim. Note this still requires a real schema-change mechanism; today schema changes happen via addColumn() calls in database.js on restart, with no migrations folder and no down-migrations. That mechanism is unresolved and must be settled before the staged rollout begins.

### The live schema conflates store-as-location with store-as-channel-shop — FINDING 2026-08-04

In the live SQLite schema the word "store" carries two unrelated meanings. retail_stores holds physical/pickup locations (address, coordinates, opening hours). The store_code / store_id / retail_store_id columns in the meituan_*, eleme_*, guanyi_* and qingyun_* tables hold channel-shop identifiers — an account's identity on a sales channel, not a place. retail_stores itself carries no account column, so the store layer is unscoped today. This conflation must be untangled at the Locations stage, separating Locations (physical, per account) from Channels (per-account settings, created by Tacet). Recorded here so it is not lost; no action now.

### Test accounts cleared from live data — DONE 2026-08-04

The five test accounts (tenant ids 2, 4, 5, 6, 7 — test, kelly1234567, test66, Boca LTD, test03) were deleted from the live SQLite database, leaving tenant id 1 (Roots) as the only account. 52 rows removed across tenants, tenant_users, billing_reminders, billing_invoices, billing_subscriptions, tenant_domains, platform_impersonation_tokens and tenant_user_sessions; all other tenant-scoped tables held zero rows for these accounts. The accounts held no trading data and nothing in the store or channel layer. Verified after the delete: only Roots remains and PRAGMA foreign_key_check returns empty. Script retained at docs/tacet-delete-test-accounts.sql. Separately, the one non-ISO date in retail_vouchers (id 1, code TAP20, expires_at 2026/10/6) was corrected to 2026-10-06, and retail_vouchers.value was confirmed not to block the Postgres data copy — it remains double precision and its split stays deferred to the Stock stage.

### Rehearsal migration to Postgres — DONE 2026-08-04

A rehearsal copy moved five tables from the live SQLite database into the Postgres "tacet" database: accounts (1 row), users (7), suppliers (210), purchase_orders (51), invoices (7). The live app was untouched throughout and remained on SQLite; SQLite was opened read-only and verified as such. Verification compared every cell by rendering the Postgres values back into the SQLite representation and string-comparing against source — 5,859 cells across the first four tables and 18 cells for accounts, zero differences.

Conversion rules established and proven:

- tenant_id maps to account_id, values unchanged.
- Integer flags map to boolean: 0 to false, 1 to true.
- Money stored as REAL yuan converts to bigint cents via round(value * 100). This does NOT apply to columns already named in cents — setup_fee_cents was copied verbatim, as multiplying it would have overstated the value 100-fold.
- Naive DATETIME text is interpreted as UTC. Verified rather than assumed: SQLite CURRENT_TIMESTAMP and datetime('now') are UTC by definition, and there is no 'localtime' modifier anywhere in the codebase. brand_updated_at was traced to its single writer (routes/backend-auth.js) before the rule was applied to it.
- Identity sequences do not advance on explicit-id inserts and require setval after each table copy, or the next application insert collides at id 1.

Findings carried forward:

- The accounts identity sequence was set to 7, not to max(id), preserving SQLite's AUTOINCREMENT high-water mark. Ids 2 to 7 were consumed by the deleted test accounts and stay burned, so no future account inherits an id that appears in older backups, logs or exports as a test tenant. The next account created will be id 8.
- Money is typed inconsistently in the Postgres schema: setup_fee_cents is integer (int4) while invoices.amount is bigint (int8). Safe at present values but worth settling before more money columns are added.
- One supplier row (id 106) contains embedded newlines in a text field. It copies correctly, but any line-oriented migration path such as CSV or COPY text format will silently corrupt it unless quoting is handled correctly.
- invoices.supplier and purchase_orders.supplier are free text with no foreign key, and hold values with no matching suppliers row — including two that are usernames rather than suppliers. If supplier is ever made a real reference, this data will not satisfy it as-is. A Purchasing-stage concern.
- The server has no Python Postgres driver installed, and installing one is not a free action while the app is live, as apt triggers needrestart which can restart services under pm2. The rehearsal generated SQL text and piped it to psql instead.
- Nine tables carry a foreign key to accounts(id): account_domains, account_integrations, account_secrets, account_users, billing_invoices, billing_subscriptions, integration_help_requests, integration_sessions, subscriptions. accounts must therefore be copied at or near the front of the real migration order.
- The application currently parses brand_updated_at as local time when generating cache-busting image URLs. Harmless, but the generated URLs will change once after the switchover to timestamptz.

### rbac_enforce is off by intent, not by settlement — NOTE 2026-08-04

rbac_enforce copied to Postgres as false, faithfully matching the live SQLite value. This must not be read as a decision that enforcement is settled or unwanted. The permission system is deliberately dark pending activation: shadow mode (deny-by-default with log-not-block) is the planned first step, followed by per-route requireCap. A future session encountering false in Postgres should read it as not yet switched on, not as already decided.

### gzgrocery table rename, at the Postgres migration — DECIDED 2026-08-04

The eleven tables of the gzgrocery channel are renamed at the Postgres migration, not before. Renaming live SQLite tables is surgery; creating them under the new names in Postgres is free, so the rename rides along with the migration in the same way as the app directory rename.

The rename is mechanical, not a merge. A read-only survey established that no two tables across the guanyi_* and gzgrocery_* families hold overlapping or duplicate data. This was tested directly rather than inferred: gzgrocery_orders.order_id appears in no guanyi_* table, and the event vocabularies of the two families are disjoint.

New names: guanyi_* becomes gzgrocery_erp_* (the partner's ERP: stock, product mapping, pricing, pickup drift) and the existing gzgrocery_* becomes gzgrocery_shop_* (the partner's OpenCart storefront: paid orders). Two names are kept deliberately. A single blanket prefix would erase the schema's only signal of which external system each table mirrors, and the storefront order daemon depends on the ERP tables for store resolution and pricing.

Scope beyond table names — the rename is larger than it appears and must be planned as one piece of work:

- Approximately eleven API paths under /api/retail-admin/guanyi/*
- JSON response keys guanyi_name, guanyi_code, guanyi_sku_id
- User-facing copy: five toast messages, row text, a button tooltip, bilingual body copy, and the tab heading, which currently reads "gzgrocery 同步 · Guanyi Sync" — both names already appear on the same screen
- Four stored values in retail_stock_ledger.reason: guanyi_pickup, guanyi_pickup_reversal, gzgrocery_order, gzgrocery_order_reverse. These are historical records. Whether to rewrite them or leave them is not decided here.

Findings recorded at the same time, no action now:

- The pickup-drift mechanism (guanyi_pickup_*) is retired and runs in shadow mode; order-read (gzgrocery_orders) is live and is the declared source of truth. The handover was clean on 2026-06-26 and the two were never live simultaneously, so no sale was double-counted.
- Seven gzgrocery scripts exist on the server but are not tracked in git, including scripts/import_guanyi_pricing.js, which is the sole writer of the pricing table. Untracked means unbacked-up and undeployed. This needs resolving independently of the migration.
- stock_push records 9,405 failures against 2,615 successes. Unrelated to the migration, but it is the channel's primary job failing most of the time and warrants separate attention.
- 42,913 of 54,942 rows in the sync log are pickup_guard/skip entries from the parked drift detector, still accruing.

### gzgrocery is Roots' own sales channel — NOTE 2026-08-04

The gzgrocery integration belongs to Roots as a business, not to Tacet as a platform. It is one business's channel, not a feature every account receives. This is consistent with the existing rule that channels are created by Tacet rather than by individual businesses: another account would only have gzgrocery if Tacet built that integration for it.

The consequence for isolation: the eleven gzgrocery tables hold Roots-specific data and must be account-scoped like everything else when the staged rollout reaches them. They are not shared platform infrastructure and must not be treated as such.

Also recorded, from the untracked-source survey of 2026-08-04:

- 40 scripts/*.js files were untracked and have now been brought into the repository. None contained secrets; all read credentials from process.env, which is the correct pattern. No pm2 service or cron job depended on an untracked file, so the exposure was lost tooling rather than a server that would fail to restore.
- scripts/_guanyi_pricing.json was tracked deliberately. It holds the discount Roots gives gzgrocery across 203 products. The decision was taken knowing the file is permanent in repository history.
- The .env files remain untracked and are the only copy of every channel credential on the machine. Losing the server means losing access to every channel until each partner reissues. This is the largest single point of failure identified and is not addressed by this work.

### The schema-change mechanism is unresolved — RESOLVED 2026-08-04

Resolved 2026-08-04 — see "Schema changes are managed with pgroll" below.

The staged account-column rollout and the row-level security policies both require a way to make schema changes that does not exist yet. A read-only survey was completed on 2026-08-04 and is recorded at docs/tacet-schema-change-survey.md. No option has been chosen.

Corrections to earlier records, established by that survey:

- The `_migrations` table is NOT empty and is not a fossil. The live SQLite table holds 144 rows and is load-bearing. The empty one is in the Postgres `tacet` database, created by the phase-1 dump and never written to. Note that 91 of the 144 rows are release-announcement markers rather than schema markers — anything reading this table as a migration ledger will find mostly push-notification bookkeeping.
- The live database has 162 tables. Earlier references to "~140" or "137" are wrong.
- The current mechanism has not been failing. The survey parsed every CREATE TABLE in the repo against the live database and found zero column drift across 157 tables. The case for replacing it is what the staged rollout requires, not a defect.

Findings that must inform whatever is chosen:

- Schema reaches the database by seven distinct mechanisms, not one: 294 `addColumn()` calls, 32 literal ALTER TABLE sites in try/catch, ~127 CREATE TABLE IF NOT EXISTS, 54 `_migrations`-guarded blocks, two tables whose shape is derived at boot from another table, schema mirroring into per-tenant database files, and lazy DDL executed from a catch block inside a sweeper that runs every 60 seconds during normal operation.
- Eight pm2 processes each require database.js and therefore each run the full DDL sequence on start, against the same database. Any runner needs a lock or must run in exactly one place outside the app boot path.
- The repository is not the source of truth for the schema. Five live tables have no CREATE TABLE anywhere in the repo: `meituan_listing_specs` (live code reads and writes it; its DDL was added on the unmerged guanyi-stock-sync branch and exists in production only because that branch once ran on the box), `store_products` (derived at boot by mirroring the products table's runtime shape, so the storefront's entire catalogue has no written definition), and the three known fossils `plans`, `subscriptions` and `retail_product_day_baseline`. Any desired-state tool would propose dropping what it cannot see. This must be reconciled before such a tool is pointed at anything.
- Deploy rollback restores files, not schema. After a failed deploy the previous code version runs against the new schema, so every migration must leave the prior code able to function — additive-only, or genuinely two-phase.
- The health probe rolls back on 5xx from four endpoints. A migration that leaves those unable to serve triggers an automatic file rollback and leaves the schema half-applied.
- Deploys complete in 20 to 55 seconds with roughly a 20 second settle window. A migration slower than that triggers the auto-rollback.
- During the transition one account runs on Postgres while another runs on SQLite, served by the same application code. Applied migrations must be tracked per engine; the current single name-set cannot express this.
- A migrations/ folder at the repo root would never ship — the deploy allowlist covers public/, routes/, lib/, middleware/, scripts/, server.js, database.js, schema.sql and package*.json only. Deletions never reach the box either, so a removed migration file stays live.
- Disk headroom is thin: 40 GB volume at 78 percent used, 8.3 GB free, with roots.db at 510 MB and hourly backups holding about 7.7 GB.
- Five orphaned per-account database files remain at data/tenants/{2,4,5,6,7}.db, each carrying its own copy of roughly 150 tables, and they are still listed in db-backup.sh despite those accounts being deleted on 2026-08-04.
- Ordering in database.js is a positional accident. `store_products` mirrors `products` at line 3793 and all 51 `addColumn('products', ...)` calls sit above it. Nothing enforces this; an `addColumn` appended at the end of the file — the natural place — would silently desync the two catalogues for one boot.

### The Production app's product surface is parked until the Products stage — DECIDED 2026-08-04

Removing products from the Production app was raised and deliberately deferred. It belongs to the Products stage of the consolidation sequence, not to Phase 2, and nothing depends on it.

Context established by survey on 2026-08-04:

- The store catalogue was forked from `products` into `store_products` on 2026-06-09. Everything customer-facing reads and writes `store_products` only: Tacet, the WeChat mini-app, the web storefront, and the Meituan, Eleme and gzgrocery channels. All three channel mapping tables key off `store_products`, and 27 Meituan and 9 gzgrocery mappings point at store-born products that do not exist in the `products` table at all.
- The `products` table has had no write since 2026-06-08. The two tables have drifted: of the 269 rows they share, 77 percent disagree on category, 61 percent on name, and 52 percent on published flag.
- The kitchen SPA is NOT dormant — roughly 20,000 requests over 15 days, staff working in it daily on kitchen, purchases, finance and orders. The product endpoints are read-only in practice: zero writes in the retained log window, but the Products screen was opened on four days and the per-store stock card fifteen times.
- Ash has confirmed nobody needs products in the Production app and nobody creates products or adjusts stock there.

The hazard this leaves open, to be resolved at the Products stage:

The two tables run independent AUTOINCREMENT counters over one integer space — `products` at 305, `store_products` at 361. The next product created in the kitchen app takes id 306, which already belongs to a different store product. routes/restock.js:210-242 guards this correctly. routes/products.js:569-580, the kitchen per-store stock adjuster, does not: it validates against `products` then writes `retail_store_stock`, which is foreign-keyed to `store_products`. No error would occur — the stock would silently land on the wrong product. Dormant only because nobody creates products in the kitchen app.

Two live data errors found at the same time, not yet fixed:

- `store_products` ids 272 and 273 have their SKUs swapped relative to `products` — the regular and big-size walnuts have exchanged codes 2-320 and 2-330. A script named scripts/fix_products_swap.js exists in the repo, suggesting this has occurred before.
- `store_products` id 104, "Medjool Boat", holds the raw Unix epoch integer 1781757233 in its `updated_at` DATETIME column, written by scripts/backfill_weight_from_spec_strip.js:129. SQLite accepts it; Postgres will not. This will fail the Products stage of the migration on load unless caught first.

Also recorded, from the same work:

- public/pos.html and public/restock.html were removed and deployed on 2026-08-04, along with their routes, manifests, icons and every entry point. Both had zero human traffic. The restock removal fixed a pre-existing bug on the way: Quick Stock was installing under the restock PWA identity while its own correct manifest already existed unused.
- Two endpoints lost their only caller with the restock page and remain in place: PUT /api/restock/:id/archive and POST /api/restock/archive-bulk.
- The deploy installer only adds files; deletions never reach the box and must be removed by hand. Removed files remain fetchable at `/assets/<name>` until that is done. public/app.html.bak is stale weight still reachable this way.

### Schema changes are managed with pgroll — DECIDED 2026-08-04

The schema-change mechanism recorded as OPEN on 2026-08-04 is decided. pgroll is the chosen approach. The survey behind this decision is at docs/tacet-schema-change-survey.md, and its six options stand as the record of what was considered.

Why pgroll: it is the only candidate that addresses the rollback hole. Deploy rollback restores files but not schema, so after a failed deploy the previous code version runs against the new schema. pgroll keeps both the old and the new schema version live at once behind views, so the rolled-back code continues to be served the shape it expects. Rollback while a migration is in flight is instant and lossless. Every other option requires that all changes be additive-only forever, which cannot express the renames the consolidation already commits to — the gzgrocery table rename among them.

What this decision does not do: pgroll is Postgres-only and contributes nothing to the SQLite-to-Postgres migration itself. It becomes relevant only once Roots is fully on Postgres and the staged account-column rollout begins. It is not a blocker for the migration work, and it is not installed.

Consequences to plan for:

- Schema changes become two-phase. A change is started, then completed as a separate action, and both schema versions are live in between. This is the property that makes rollback safe, and it is a change to working practice, not only to tooling.
- pgroll is a command-line tool and can be driven by Claude Code in the same way as everything else on the server. The decision to complete a migration stays with Ash, since that is the point of no return.
- pgroll is not installed. Installing packages on the box is not a free action — apt triggers needrestart, which can restart services under pm2. Installation must be planned, not done as a side effect.
- The constraints in §4 of the survey still apply and are not solved by this choice: the health probe rolls back on 5xx from four endpoints; deploys complete in 20 to 55 seconds and a slower migration triggers auto-rollback; a migrations folder at the repo root would never ship, as the deploy allowlist does not cover it; and deletions never reach the box.
- The five live tables with no CREATE TABLE anywhere in the repo remain unreconciled. pgroll does not require the repository to be the source of truth in the way a desired-state tool would, so this is no longer a blocker for the tooling choice, but it remains a real gap.

Parked items:

- Rename the app directory from /root/roots-v2/ to a tacet-branded path. Do NOT do this standalone — it breaks the hardcoded SQLite path, pm2, GitHub Actions deploy, deploy-apply.sh, and likely nginx all at once. Bundle it into the Postgres switchover, which already edits the hardcoded path and deploy wiring, so the rename rides along at low marginal risk. Update all references in lockstep, redeploy, and test.

### Full data copy to Postgres — DONE 2026-08-04

All 129 non-empty tables were copied from the live SQLite database into the Postgres "tacet" database: 353,220 rows in 86 seconds. The live app was untouched and remained on SQLite throughout. SQLite was opened read-only and proven so on every connection by a rejected write, not assumed.

Verification: row counts matched exactly with zero mismatches; 3,244,556 cells were round-trip compared with 43 differences, all proved to be live trading during the run rather than copy errors; all 144 foreign keys were validated by Postgres itself; Chinese character counts were exact once the two drifted rows are excluded; 2,112 base64 values were byte-identical by SHA-256, the widest 3,331,931 characters. 139 identity sequences were set, 117 of them from SQLite's AUTOINCREMENT high-water mark rather than max(id), which matters on 20 tables where ids are burned.

Money precision — DECIDED. Whole cents remains correct for transaction amounts and is wrong for per-unit costs, which get multiplied by quantity. Nine cost columns were retyped from bigint to numeric(14,6): ingredients.cost_per_unit, ingredients.buy_price, ingredient_price_history.price, price_alerts.new_price, price_alerts.old_price, po_line_items.cost_per_unit, po_line_items.total_cost, expense_entries.amount, waste_entries.cost_lost. Twelve genuine unit costs would otherwise have rounded to zero, and 188 values were off by more than 10 percent. numeric was chosen over a micro-cents integer for three reasons: Postgres numeric is exact decimal arithmetic and so does not reintroduce the binary floating-point defect the cents rule exists to kill; the scale is enforced by the type rather than carried in a column name, which is the trap setup_fee_cents already sprang once; and values stay in yuan, matching the source and the UI. One value rounds — waste_entries.cost_lost id 1 loses 0.00000039 yuan. All others are exact.

Weight — DECIDED. products.weight and store_products.weight were retyped from double precision to text and copied verbatim. The values are free text with mixed units — '220 g', '500ml', '1L', '120g (4 bars)', and one malformed '5--g'. No numeric conversion is correct, since stripping units would equate 500ml with 500g. Parsing weight into a number and a unit belongs to the Products stage.

Smaller decisions applied: ISO-8601 timestamps with a trailing Z are accepted as UTC verbatim, 4,437 values across 15 columns, milliseconds preserved. Voucher TAP20 expiry was set to 2026-10-06 15:59:59Z, end of day China time, matching every other dated voucher. store_products id 104 was corrected at source before the copy, from the raw epoch integer 1781757233 to 2026-06-18 04:33:53. recipe_cost_data.packaging_type_id was set to NULL, as the reference pt1778315688913 never existed. Four storefront_config.updated_by rows were set to NULL, having held script names rather than user ids.

Findings carried forward:

- Any SQLite to Postgres row comparison keyed on text requires COLLATE "C". SQLite orders text by byte and Postgres by locale, which ignores punctuation. This produced 117 false differences during verification by pairing the wrong rows on each side, and looked exactly like data corruption.
- Drift, not speed, is the cutover constraint. The copy takes 86 seconds, which is trivial, but the source gained 48 rows during that window and continues to move. A clean cutover needs a quiet window or a delta pass over the tables that take writes — the sync logs, retail_checkout_quotes, activity_log, and the auth tables.
- Setting sequences from max(id) would have set some behind live reality. guanyi_sync_log copied to max id 55,186 while SQLite's high-water was already 55,189.
- docs/tacet-postgres-schema-phase1.sql is now stale on eleven columns and is retained as a historical record only. See the new dump committed alongside it, docs/tacet-postgres-schema-as-built-2026-08-04.sql.

The scripts that performed this copy are preserved at scripts/postgres-full-copy/, alongside the five-table rehearsal at scripts/postgres-migration/.

### The money-unit gap and the boundary layer — 2026-08-04

The full data copy changed the unit of 92 columns from REAL yuan to bigint cents, plus nine unit-cost columns to numeric(14,6). The application reads and writes yuan and has zero conversion sites. Pointed at Postgres unchanged, every price displays 100 times too high and every total sums in the wrong unit. This is the largest single item in Part 2 and is not solved by any driver or compatibility work. Survey recorded at docs/tacet-money-model-survey.md.

DECIDED — the conversion happens at the boundary, not in the application. One layer between the application and the database converts on the way out and on the way back in, rather than hundreds of edits across the call sites. The alternative was rejected because there is no test suite and no automated correctness gate beyond node --check, so hundreds of hand edits carry worse odds than one carefully built converter.

DECIDED — the layer returns yuan. The application already contains a working conversion boundary at the payment gateway: seven sites do Math.round(Number(order.total) * 100) on the way out and verify fen on the callback. If the layer returned cents, all seven would double-convert and charge customers 100 times the correct amount.

DECIDED — expense_entries.amount becomes whole cents, matching income_entries.amount and sales_entries.total. It had been retyped to numeric(14,6) on precision grounds, which matched the symptom rather than the cause: routes/finance.js sums all three within six lines to build the P&L, so the expense side of the accounts was in a different unit from the income side.

The seven sub-cent expense values were examined and are all calculation artifacts, not money that changed hands. Each is a per-category subtotal of a purchase order, computed in SQL by postPOExpenses(), written with created_by NULL, and deleted and re-inserted on every PO status change — a live projection of the PO rather than a record of a payment. All 65 hand-entered expense rows are clean; no human has ever entered a sub-cent expense. Rounding does not lose information, it removes an error: the values derive from truncated unit rates such as 4.16666, which is 25/6, so 4.16666 x 3 yields 12.49998 instead of the intended 12.50. Rounding recovers the exact intended figure in all eight underlying line totals. Whole-ledger impact is 0.0118 yuan.

Two requirements for whoever applies this: the rounding must go into postPOExpenses() and postRetailPOExpenses(), not only the column type, or the next PO status change regenerates a sub-cent value and fails the whole-cent write. And the rounding must be applied to the category subtotal rather than to each line, so the expense rows continue to sum exactly to the PO total.

Income and sales confirmed clean: income_entries.amount has no values above two decimal places, and the twelve in sales_entries.total are float noise within 1e-12 of a whole cent.

THE SECOND MONEY MODEL — the finding the boundary layer structurally cannot reach. storefront_config.value_json is TEXT holding 151 rows, and every money rule in the business lives there in yuan: the free-shipping threshold, the pickup packing fee, the default delivery zone's base fee and per-item packing fee and cap, the affiliate reward per order, the points earn-spend rate, and the loyalty tier thresholds. Each meets a converted column. defaultDeliveryZone() synthesises a zone object from config as the fallback for all of mainland China and returns it alongside real retail_delivery_zones rows, so one shape is yuan and the other cents and computeDeliveryAndPacking cannot tell them apart. tierFromSpend() compares lifetime_spend in cents against thresholds in yuan, so every customer past 40 yuan reaches the top tier and reconcileTier() writes it back. pointsEarnedFor() divides by an earn-spend of 100, giving 100 times the points. Affiliate rewards of 20 and 15 yuan land in cents columns and pay out as 0.20 and 0.15. None of this errors. This must be solved separately from the boundary layer.

ROUNDING IS NOT A PROBLEM. The copy halts on any value that is not within one millionth of a whole cent, and it halted zero times across all 92 columns and 176,015 rows. No genuine sub-cent value exists in any transaction column today, so the layer has no existing fraction to preserve. Every place a fraction is created — percentage vouchers, points converted to cash, the proportional refund split across tenders, wallet spend — already rounds at the point of creation, and that rounding must stay where it is rather than move to the boundary; the refund split in particular relies on cash absorbing the remainder, an invariant that breaks if the boundary rounds the parts independently. Two gaps remain: the packing fee, per_item multiplied by quantity, is the only fraction source in the checkout path with no rounding of its own, and it needs an explicit decision; and the nine unit-cost columns must be exempt from the cents rule entirely, since ingredient_price_history.price bottoms out at 0.004 yuan and whole cents would zero it.

### The unit-mixing statements are retired — DONE 2026-08-04

The boundary layer converts per column, so it can only convert a value that still has a column. A statement that builds money inside SQL — `SUM`, `AVG`, an arithmetic expression — hands back a scalar with no column identity, and if a different unit is present in the same payload the layer cannot tell the two apart. Seven sites had that shape. All seven now read the money as a plain column and sum it in JavaScript, so the column survives to the boundary.

Six were statement-level: two units inside one SQL statement. `GET /api/retail-admin/bills/outstanding`, the two allocation clamps in `routes/finance.js` and the one in `routes/retail-purchasing.js`, `GET /api/finance/outstanding-lines`, and the Bills KPI at `/api/retail-admin/bills/summary`.

The seventh is handler-level and was missed by the first classifier: `GET /api/retail-admin/suppliers/:id` builds `spend` (yuan, `po_line_items.total_cost`) and `owed` (cents, `invoices.amount`) in two separate statements and folds them into one `scorecard`, which the supplier screen renders as adjacent tiles. No single statement carries two units. Survey §2e (vi).

Every one of the seven was correct on SQLite before the change and would have been wrong only after cutover. None of the seven changed a value the application displays; each was compared old-against-new on live SQLite opened `mode=ro`, proven read-only by a rejected write, before it was touched.

The classifier is `scripts/diagnose_money_unit_mixing.py` and the live comparison is `scripts/diagnose_money_unit_split.js`, run through the `ro-query` workflow. The first classifier unioned units found only inside aggregate bodies, so `SUM(cents_column)` beside a plain `yuan_column` looked single-unit — which is how all of these were missed. The corrected one unions the unit of every money reference wherever it sits, separates DERIVED from CARRIED, and adds the handler pass that found the seventh.

STILL OPEN, deliberately not touched by this work: the three `ROUND(x, 2)` guards at `routes/retail.js:9745`, `15111` and `26243`, which are yuan-native operations that need deleting rather than translating (survey §2e (iii)); and `delivery_jobs.raw_order`, the JSON money the standing rule leaves in yuan.

### Money embedded in JSON stays in yuan — DECIDED 2026-08-04

DECISION: money held inside a JSON or TEXT column stays in yuan. No migration converts it — not the full copy, not the boundary-layer work, not any later pass. This applies to every JSON money value in the schema: retail_product_versions.snapshot_json, retail_order_addons.items_json, retail_order_items.options_json, retail_refund_events.meta_json, retail_orders.refund_lines_json, retail_orders.alipay_ocr_json, storefront_config.value_json, activity_log.details and products.bundle. Survey recorded at docs/tacet-money-model-survey.md; the full inventory is 45 JSON-bearing columns, of which 14 carry money.

WHY, AND WHY IT IS NOT OBVIOUS: the temptation is to "make everything cents" so one rule covers the whole database. That is the wrong instinct here, and it is worth stating plainly because the reasoning runs backwards from the usual one. The application speaks yuan and the boundary layer returns yuan — both already decided above. JSON money is also yuan. A value snapshotted out of a column and later written back into one therefore needs no conversion whatsoever: the layer multiplies by a hundred on the way in, exactly as it does for any other write. Convert the JSON to cents and that write becomes a hundredth of the right number.

The deeper reason is that the conversion would be invisible. A converted column announces itself — it has a type, it appears in plan.json with a conversion class, a per-column rule can find it. A number inside a text column has none of that. Converting the JSON creates a second conversion boundary that no type system, no column rule and no schema diff can see, inside data that is also read by hand during support work. The one place the system converts units must stay the one place.

WHAT THIS COSTS, AND WHERE IT IS PAID: the rule holds only while the boundary layer covers every write path. Where it does not — getTenantDb() rather than the request-scoped handle, and the gzgrocery, meituan, eleme and qingyun daemons, which open the database directly — yuan JSON meets a cents column with nothing in between, and fails silently by a factor of a hundred. That is a requirement on the layer, not a reason to convert the JSON.

THE STAMP: retail_product_versions.snapshot_json now carries "_money_unit": "yuan", written by productContentSnapshot() in routes/retail.js and read by the version-restore handler, which converts explicitly at that one site rather than relying on the standing rule holding everywhere. Rows written before the stamp existed carry no key and are read as yuan. That default is safe because nothing has ever written another unit into the column and the full copy of 2026-08-04 left every JSON value untouched — so absent and "yuan" describe the same data. An unrecognised stamp is refused rather than guessed: the restore returns an error instead of writing a price wrong by a hundredfold into a live product.

THE OTHER WRITE-BACK IS UNRESOLVED. finalizeOrderAddon() (routes/retail.js) reads unit_price and line_total verbatim out of retail_order_addons.items_json and writes them into retail_order_items on the WeChat payment callback, unattended. Re-deriving that money from the column at settlement — the pattern refund_lines_json already uses, discarding the stored amount and recomputing from retail_order_items.line_total — would make it unit-safe, but it would also re-price the customer's paid lines. The staged price and the settlement price genuinely can differ: sell_price is edited constantly, and effectivePriceFor() is time-dependent so a flash window opening or closing between staging and callback changes the unit price on its own. The customer is charged retail_order_addons.amount, fixed at staging, so re-pricing would break the invariant that an order's line totals sum to what was paid, and would move the ceiling that normalizeRefundLines() applies to a later refund. Referred as a product decision, not a units decision. Until it is settled, this path relies on the boundary layer covering the write.

### The database seam is built, and lib/store-hours.js is the first module through it — 2026-08-04

The boundary layer decided above needs somewhere to live before it can convert anything. `lib/db-seam.js` is that place: it wraps a `better-sqlite3` handle and intercepts `prepare()`, so every prepared statement — the only construct that carries both bound parameters going in and identified columns coming out — passes through one point that a converter can later occupy. No converter is installed. With none installed the wrapper forwards each call to the raw handle and returns the result untouched, so the seam is a zero-cost passthrough and cannot alter a value even by accident. It was built and proven behaviour-neutral first, deliberately, so that the converter arrives into a seat that is already covered and already measured rather than being written and wired in the same step.

`lib/store-hours.js` is the first module routed through it, and was chosen because it is the smallest real consumer: one statement, three columns, no money, one table. It reads `retail_stores.code / open_time / close_time` for the Qingyun ops-alert muting and the 外卖 and 闪购 polling windows.

STANDING RULE — RAW HANDLES ONLY IN `tenantAls.run()` AND `dbToId`, NEVER A WRAPPER. Both live in `lib/tenant-db.js`. The ALS store is compared by identity against `mainDb` in `currentTenantId()`, and `dbToId` is keyed by handle identity; a wrapper in either place changes what those two answer. Those sites hold the raw handle. A later step that finds it needs a wrapper in either one must stop and raise it, because it is a behaviour change and not a refactor. Note that `tdb()` and `getTenantDb()` are NOT yet routed through the seam, which is why coverage starts where it does — and note that roughly fifteen call sites outside `tenant-db.js` pass `getTenantDb(tid)` straight into `tenantAls.run(...)`, so the step that wraps `getTenantDb()` has to give those sites a raw accessor at the same time or it will put wrappers into the ALS.

STANDING RULE — `exec` AND `pragma` ARE PERMANENT PASS-THROUGHS. This is a property of what they are, not a gap to be closed later. `exec()` takes raw SQL with no bound parameters and returns no rows: there is nothing to convert on the way in because there are no parameters, and nothing to convert on the way out because there is no result set and therefore no column identity. The converter is per-column and needs a column to act on; `exec` offers none in either direction. It carries DDL and batch statements — `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, the schema self-heal in `tenant-db.js`. `pragma()` addresses SQLite's own settings and never carries application money. If a future change appears to need conversion inside `exec`, the fix is to move that statement to `prepare()` where it has parameters and columns, not to widen the converter. Recorded in the header of `lib/db-seam.js` as well, because that is where someone about to widen it will be looking.

COVERAGE IS A MEASURED NUMBER, NOT A CLAIM. `scripts/db-seam-coverage.js` is a static reader over the deployed application. It counts every `<handle>.prepare(` site — each one a place a money value can cross — and attributes it to how its handle was obtained: through the seam, through `tdb()`/`getTenantDb()`, from a module-level `require('../database')`, or from a `new Database(...)` of its own. At this step: **1 of 3,074 statement sites, 0.03%** across the whole application; **1 of 2,630, 0.04%** on the runtime surface alone. The remainder is 1,363 TENANT, 1,015 DIRECT, 637 RAW_OPEN and 58 UNRESOLVED. Receivers the reader cannot resolve — a handle arriving as a function parameter — are counted in the denominator and never as covered, so the number understates rather than flatters. The 637 `RAW_OPEN` sites are the ones §24 already named as where the yuan-JSON rule is paid for: the daemons that open the database directly. Two files are excluded and named in the output, on the same precedent as the SKIP set in `diagnose_money_unit_mixing.py`: the coverage reader itself and the comparison harness, which holds a raw handle because being the un-seamed side of the comparison is its entire purpose — counting it would report a deficit that must never be closed.

THE COMPARISON HAD TO ASSERT THAT NOTHING THREW, NOT THAT NOTHING LOOKED BROKEN. `scripts/diagnose_store_hours_seam.js` loads the real `store-hours.js` twice against one read-only connection, identically except that one run has the seam stubbed to the identity function — byte-for-byte the module's previous behaviour — and the other has the real seam. It compares the SQL issued, the rows off the wire, the primitive type of every column value, `storeHours()` for every code on file plus absent-code cases, and `within()` sampled every fifteen minutes across a full day at four grace settings. It runs against live SQLite opened `mode=ro`, proven read-only by a rejected write, through the `ro-query` workflow — the same mechanism the unit-mixing comparison used. It passed on live before the code shipped: identical SQL, identical rows, identical column types, no throw at either level.

The workflow had to be changed to make that ordering possible. `ro-query` copied one script to prod and ran it against the *deployed* application, so a comparison of not-yet-deployed code failed with `FATAL: missing lib/db-seam.js` — the harness's own guard. A comparison that can only run after the code ships cannot gate the ship, so the workflow now stages the checkout's `lib/` in a scratch directory beside the script and runs the candidate code against the live database. `data/` is not staged and the read-only proof is unchanged.

A FINDING, PRE-EXISTING AND NOT CAUSED BY THIS WORK: on live, `retail_stores` holds two rows — `tianhe` and `yuexiu` — and **neither has a usable open/close pair**, so `storeHours()` returns null for every store in production and every consumer treats every store as always-open. The module's own header calls that the intended reading of null, so nothing is misbehaving; but it means the live run's hours and `within()` comparisons are vacuous, and the harness says so in its output rather than presenting them as passes. The behavioural half of the proof is carried by the fixture run, which has three configured stores and 2,304 agreeing `within()` evaluations; the live run carries the no-throw assertions and the row-level identity on real data. Worth knowing separately from the seam: the Qingyun ops-alert muting and the 外卖/闪购 polling windows are configured in the admin but are not in effect, because the two live stores have no hours set.

The no-throw assertion is separate and explicit because `store-hours.js` catches its own read errors and keeps serving its last good cache. A seam that broke the read would therefore be invisible from outside — the daemons would still get hours and the app would still be up. So the harness asserts the absence of a throw at two levels: it issues store-hours' own statement through a seam-wrapped handle with no `try`/`catch` in the way, which catches a fault originating inside the seam; and it sits a probe underneath the seam that records every exception the handle raises whether or not the module swallows it. Both must be clean, and the read must be shown to have actually completed, since a swallowed failure leaves an empty map that otherwise compares equal to an empty database. The harness was verified against two deliberately broken seams — one that alters a value and one that throws — and fails on both, so a green result means something.

### A FAILED DEPLOY SILENTLY SKIPS ITS CHANGES FOREVER — FINDING 2026-08-04

Found the hard way while shipping Step B, and it is a property of the pipeline rather than of that change.

`deploy.yml` computes what to ship as `git diff ${{ github.event.before }} ${{ github.sha }}` — the diff against the PREVIOUS PUSH, not against what was last successfully deployed. So when a run fails before its "Ship changed files" step, the files in that commit are never shipped, and the NEXT push diffs against the failed commit and does not include them either. They are skipped permanently, and every subsequent deploy reports success.

WHAT HAPPENED. Deploy 901 carried the Step B flip (`lib/tenant-db.js`). It failed at the lint gate — correctly, on an error in a diagnostic file — and shipped nothing. Deploy 902 then diffed against 901's commit, found only the diagnostic, and shipped that. It reported `RESULT=SUCCESS`. Production kept running the Step A version of `tenant-db.js` while `main`, the merge commit, the coverage checker and the decisions record all said Step B was live. Recovered with a `workflow_dispatch` run using `full_sync: true`.

WHY IT IS DANGEROUS BEYOND THIS INSTANCE. The failure mode is silent and the signal is inverted: the deploy that skips your change is the one that says SUCCESS. Nothing compares what is on the box against what is in the repository, so the drift persists until someone happens to look. Any failed deploy in this repository's history may have left files behind in the same way.

WHAT WAS DONE ABOUT IT NOW. `scripts/diagnose_tenant_step_b.js` gained a check that reads the DEPLOYED `/root/roots-v2/lib/tenant-db.js` and asserts it is the version the repository claims — verifying the artifact rather than the checkout. That covers one file.

WHAT IS STILL OWED, AND IS NOT DONE. The general fix belongs in the pipeline, not in a diagnostic: compute the diff against the last SUCCESSFULLY deployed commit rather than the previous push. That means recording the deployed SHA on the server after a successful install and reading it back on the next run, or falling back to `full_sync` when the previous run did not succeed. Not attempted here — it changes deployment behaviour, which is outside what this work was asked to touch.

### The failed-deploy skip is FIXED, and it had bitten 197 times — DONE 2026-08-05

The fix owed above is done, landed in four stages on 2026-08-05 (deploy runs 905–909).

HOW BAD IT ACTUALLY WAS. Replaying all 904 deploy runs from 2026-06-22 to 2026-08-04 against full git history — the push history is perfectly linear across all 898 push runs, so the reconstruction is exact rather than approximate — found **939 moments where a run reported SUCCESS while production did not match the repository at that commit**. Those group into **197 stranding episodes across 141 distinct files**. Median episode 0.5 days; 71 ran longer than a week; the longest ran 43 days. **79 episodes were never healed by a later commit at all** and were cleared only by the unrelated `full_sync` on 2026-08-04 — which means that dispatch accidentally cleared a six-week backlog nobody knew existed. Twenty-two of those were runtime code, not throwaway scripts: `lib/proxy-manager.js`, `lib/ops-alert.js`, `lib/eleme-client.js`, `lib/social-auth.js`, `lib/operator-caps.js`, `routes/eleme-admin.js`, `routes/eleme-internal.js`, `routes/guanyi-admin.js`, `public/editor.html` and others. `lib/tenant-db.js` was one of 197, found only because someone happened to check that one file.

WHAT THE FIX IS. The diff base is now the commit recorded on the server at `/root/roots-v2/.deploy-state/last-success-sha` — what production actually holds. The record lives on the box, beside the artifact it describes, because a record kept in the repository or in Actions cache would describe what CI INTENDED, and CI's intent is exactly what was wrong. There is one writer, gated behind the installer's `RESULT=SUCCESS`, so the recorded sha cannot advance unless the files were installed; a failed run never reaches it. Replaying the same 904 runs against the new logic gives **0** mismatches where the old gave 939.

EVERY FAILURE MODE OVER-SHIPS. Record missing, not a 40-hex sha, or not a commit in this repository: warn and fall back to the previous-push base, which is exactly the pre-fix behaviour — never a silent no-op. Record valid but not an ancestor of HEAD, meaning history was rewritten: use the merge-base, which can only ship a superset. The record is never trusted enough to NARROW the set beyond what it can prove. Only a record running AHEAD of reality could skip files, and no path can produce one.

HOW YOU WOULD KNOW. `deploy.yml` now hashes the files it just shipped on the server and fails the run on any mismatch. It runs BEFORE the record is written, so a verification failure leaves the record behind and the next deploy re-ships that range — the failure mode heals itself. Two files are excluded because the installer rewrites them after installing them: `public/sw.js` (the CACHE stamp, by design) and `package-lock.json` (see below).

TESTS. `scripts/test-deploy-base.sh` extracts the base-resolution step out of the workflow itself — so the test cannot drift from what it tests — stubs ssh for the deploy record, and drives ten cases including the headline failed-deploy case and a control that reproduces the old skip. `scripts/diagnose_deployed_tree.js` compares the whole deployed tree against the repository, read-only, via `ro-query.yml`. Run it whenever the box's fidelity is in question; regenerate its manifest first.

### MONEY IS RESOLVED BY SCHEMA CLASS, NEVER BY COLUMN NAME — RULE 2026-08-05

THE RULE: a column is money if and only if `scripts/postgres-full-copy/plan.json` gives it conversion class **CENTS** or **NUM6**. 92 columns are CENTS, 9 are NUM6, 101 in total. Nothing else counts, and no other test is permitted — not the column's name, not its SQLite type, not what it looks like it means. Any tool that needs to know whether something is money reads `cls` from the census.

WHY THIS IS A RULE AND NOT A PREFERENCE: name-based classification has now been wrong twice, in both directions.

- `display_min_total` reads like a money column and is not one.
- On 2026-08-05 `routes/billing.js` was classified as money-touching from a file-level grep for money-ish column names. It touches no CENTS or NUM6 column at all. The `price` the grep matched is a **JavaScript object property** in a seed array, and the money it does handle lives in `price_cents` and `amount_cents` — integer-cents columns of class INT, the category the full copy deliberately copied verbatim rather than multiplying. The only schema column named `price` with a money class is `ingredient_price_history.price`, which that file never touches.

Both directions matter. A false positive wastes a full every-statement verification pass on a file that needs none. A false negative is worse: it lets a file that really does carry money through on sampled verification, which is the failure the converter cannot afford.

HOW TO DO IT CORRECTLY: resolve the statement, not the text. `scripts/diagnose_seam_statements.js` prepares each statement against a scratch database built from the census and reads `statement.columns()`, which returns the real table and column each output column comes from. That is a resolved answer from the schema; a grep over source text is a guess about it. For writes it parses the target table and column list and checks those against the census the same way.

WHERE THIS BITES NEXT: the money-conversion work itself. A converter driven by a name pattern would convert `price_cents` twice and miss `display_min_total`'s neighbours. The converter must be driven by the same census `cls` field, from the same file.

### ON CONFLICT after cutover — CHECKED AND CLEAN, 2026-08-05

Raised as a risk and then settled, so the scare does not outlive the check.

THE WORRY: `scripts/postgres-full-copy/plan.json` carries 215 PRIMARY KEY and UNIQUE constraints and **no indexes**. `routes/push.js` upserts with `ON CONFLICT(endpoint)` against `push_subscriptions`, whose uniqueness in live SQLite comes from `database.js:125` — a `CREATE UNIQUE INDEX`, not a constraint. If the Postgres schema had been built from that census alone, the uniqueness would be missing and the upsert would fail after cutover rather than at build time.

THE ANSWER: it is fine. `docs/tacet-postgres-schema-as-built-2026-08-04.sql` is pg_dump output and **does** record indexes, including `CREATE UNIQUE INDEX idx_push_endpoint ON public.push_subscriptions USING btree (endpoint)`. The as-built schema carries 230 unique constraints and indexes across 162 tables.

CHECKED EXHAUSTIVELY, NOT SPOT-CHECKED. All **62** `ON CONFLICT` sites in scope were enumerated, their target table and columns resolved, mapped from SQLite to Postgres names via the census, and matched against the as-built schema's constraints and unique indexes. **62 matched. 0 would fail after cutover.** That includes the renamed tables, where the SQLite and Postgres names differ: `tenant_user_sessions` to `account_user_sessions`, `tenant_secrets` to `account_secrets`, `tenant_integrations` to `account_integrations`, `tenant_onboarding` to `account_onboarding`.

THE LESSON, WHICH IS THE SAME ONE AS THE MONEY RULE: the gap was in the tool's INPUT, not in the migration. The census is a column census; it is not a schema. Anything asking a question about schema shape — uniqueness, indexes, constraints — must read the as-built dump, not the census. The census answers questions about columns and their conversion classes, and nothing else.

### Two statements will not survive the cutover — FINDING 2026-08-05

Found while verifying seam batch 3, by preparing every statement in a file against a schema built from the live census. Both blocked their file from the batch, which is how they surfaced. Neither is fixed.

**1. `sqlite_sequence` has no Postgres equivalent — and the failure is SILENT.**

`routes/ingredients.js:299` and `routes/admin.js:238` both run `DELETE FROM sqlite_sequence WHERE name IN (…)` to reset AUTOINCREMENT counters after a data wipe, so that ids start again at 1. `sqlite_sequence` is a SQLite internal table; Postgres has no such thing, and identity sequences are reset with `setval` — the same mechanism the rehearsal migration already needed after each table copy, and which is already recorded in this section as a rule ("Identity sequences do not advance on explicit-id inserts and require setval after each table copy, or the next application insert collides at id 1").

Both call sites are wrapped in `try {} catch {}`. So after cutover they do not raise — they fail silently and the counters are simply not reset. **The next insert then continues from the old high-water mark instead of from 1, which is the exact opposite of what the surrounding code is written to achieve.** A wipe-and-reset that leaves ids continuing from 4,000 looks like it worked and did not. This is on the cutover checklist because it must be converted to `setval` at the same time the application moves, not discovered afterwards from odd-looking ids.

**2. `routes/restock.js:167` reads a `settings` table that does not exist — today, not after cutover.**

`SELECT value FROM settings WHERE key = 'restock.warehouseStoreId'`. There is no `settings` table in the live census, none in the as-built Postgres schema, and none created by `database.js`. The census was taken from the live database, so this statement is failing **now**.

WHAT IT IS FOR. `_resolveWarehouseStoreId()` decides which `retail_stores.id` is the warehouse — the location restock goods ship OUT of. It is a three-tier preference chain: (1) this explicit `settings` override, described in the code as "for a future multi-warehouse world"; (2) the store a `warehouse`-role user is bound to; (3) fallback — whichever active store currently carries the most on-hand stock.

WHAT BREAKS. Tier 1 is unreachable. The throw is caught by `catch { /* no settings table / row — fall through */ }`, so the code is already written as though the table may be absent — but the consequence is that **there is no way to configure which store is the warehouse.** Setting `restock.warehouseStoreId` has no effect and never has. Resolution always falls to tier 2 or tier 3.

That matters most at tier 3, which is data-dependent: the warehouse is whichever store happens to hold the most stock right now. **Without a `warehouse`-role user bound to a store, the identity of the warehouse can change by itself as stock moves between locations**, with no configuration change and no signal. Downstream, `_resolveDestStoreId(order, warehouseStoreId)` picks the destination by excluding the warehouse, and line 279 abandons the restock entirely when the two resolve equal — so a drifting tier-3 answer shows up as transfers between the wrong pair of locations, or as restocks that quietly do not happen.

Not fixed here. Settling it is a decision about whether the override should exist at all: either create the `settings` table and honour it, or delete tier 1 and make tier 2 the documented mechanism. `routes/ingredients.js` and `routes/restock.js` are held out of the seam batches until it is settled.

### The restock warehouse override has never worked — OPEN 2026-08-05

`routes/restock.js:167` reads a `settings` table that exists nowhere: not in the live census, not in the as-built Postgres schema, and not in `database.js`. It fails silently inside its own `catch { /* no settings table / row — fall through */ }` and has done since it was written.

That statement is tier 1 of `_resolveWarehouseStoreId()` — the explicit override naming which store is the warehouse, the location restock goods ship OUT of. Because it has never returned anything, resolution always falls through to tier 2 (a `warehouse`-role user's bound store) or tier 3 (whichever active store currently holds the most on-hand stock).

THE CONSEQUENCE: with no warehouse-role user, the warehouse's identity is data-dependent and can change by itself as stock moves, with no configuration change and no signal. `_resolveDestStoreId(order, warehouseStoreId)` picks the destination by excluding the warehouse, and line 279 abandons the restock entirely when the two resolve equal. So this surfaces as transfers between the wrong locations, or restocks that quietly do not happen.

NOT A MIGRATION ISSUE — it is failing today. The restock station shell was removed on 2026-08-04 and `server.js:723` records that the flow is unused, but `routes/restock.js` is still mounted at `server.js:325` and `/api/restock` is still called from `public/app.html`, `public/kitchen.html` and `public/login.html`. Removed page, live route.

TO SETTLE: either create the `settings` table and honour tier 1, or delete tier 1 and make tier 2 the documented mechanism. This is a decision, not a fix. `routes/restock.js` and `routes/ingredients.js` remain held from the seam batches until this and the `sqlite_sequence` finding are settled.

### A third statement queries a column that does not exist — FINDING 2026-08-05

Same class as the two above, found the same way — by preparing every statement in a file against a schema built from the live census, while verifying seam batch 5.

`routes/ai.js:2188` runs `SELECT created_at, price, buy_unit, source FROM ingredient_price_history WHERE ingredient_id = ? AND created_at >= ?`. That table has **`recorded_at`**, not `created_at` — twice over, in the projection and in the WHERE. The statement cannot prepare, so it throws every time this AI tool is invoked, today, against live SQLite.

It sits inside the `current_stock` tool handler of the AI assistant's function set, so the failure surfaces as that tool erroring rather than as a crash — the price-history question it exists to answer simply never gets answered. The fix is a two-word rename, and it is not made here: `routes/ai.js` is held from the seam batch alongside `ingredients.js` and `restock.js`, for the same reason. A file whose statements do not all prepare cannot be verified by the every-statement method, and routing an unverified file is exactly what these batches exist to avoid.

Three findings of this shape now — `settings`, `sqlite_sequence`, `ingredient_price_history.created_at`. All three were invisible to the application because each sits behind a `catch` or inside a tool handler, and all three were found by preparing statements against the schema rather than by running the app. That is worth generalising: **preparing every statement in the application against the live schema would find the rest of them, and nothing currently does it.**

### Statement-preparation sweep of the whole application — DONE 2026-08-05

Three defects had been found as a SIDE EFFECT of routing seam batches. Finding the same shape of thing three times by accident is a signal to look on purpose. `scripts/diagnose_statement_sweep.js` prepares every statically-written statement in every in-scope file against a schema built from the live census. It compiles and resolves every table and column named; it executes nothing, so it cannot write.

**2,524 statements across 109 files. 6 fail today. 96 fail at cutover. 371 are built dynamically and cannot be reached this way** — a blind spot stated rather than hidden, and it already conceals one known case: the `sqlite_sequence` reset in `routes/admin.js:238` is assembled by concatenation, so the sweep sees only its sibling in `routes/ingredients.js`.

FAILING TODAY — throwing in production every time the path is reached:

| site | fault |
|---|---|
| `routes/ai.js:2188` | `ingredient_price_history.created_at` — the column is `recorded_at` |
| `routes/restock.js:167` | `settings` table does not exist |
| `routes/store-admin.js:528` | `retail_orders.created_at` — no such column |
| `routes/store-admin.js:551` | `retail_orders.created_at` — no such column |
| `lib/brand-designer.js:61` | `store_products.is_on_flash` — no such column |
| `scripts/gzgrocery-order-daemon.js:126` | `retail_stores.store_code` — no such column |

Two were already recorded. Four are new, and the two `store-admin.js` sites are the most interesting: they are the operator's order search and a customer's recent-order list, so **order lookup by number and a customer's order history are both failing** wherever that route is reached.

FAILS AT CUTOVER — compiles on SQLite, errors on Postgres, across 22 files:

| construct | count | Postgres equivalent |
|---|---|---|
| `INSERT OR IGNORE/REPLACE` | 60 | `ON CONFLICT` |
| `sqlite_master` | 21 | `information_schema` / `pg_catalog` |
| `strftime()` | 5 | `to_char()` / `date_trunc()` |
| `GROUP_CONCAT()` | 5 | `string_agg()` |
| `julianday()` | 4 | date arithmetic |
| `sqlite_sequence` | 1 (+1 hidden in a dynamic statement) | `setval()` |

That is 96 statements needing rewriting before the switchover, and the count is a floor, not a total, because of the 371 dynamic statements. **This is the first measured size of the SQL-dialect work.** It was not previously on the cutover checklist in any form.

NOTHING IS FIXED. Several are two-word changes and every one is a live behaviour change on a running business, so each is decided individually.

WHAT IS GATED ON A DECISION RATHER THAN ON EFFORT. Of the six failing today, three block a file from the seam: `routes/ai.js` (72 sites), `routes/restock.js` (38) and `scripts/gzgrocery-order-daemon.js` (23) — 133 sites, plus `routes/ingredients.js` (29) held on `sqlite_sequence`. `routes/store-admin.js` and `lib/brand-designer.js` are not blocked by this pattern; they are in the mixed-TENANT and UNRESOLVED groups and were never movable. So **162 of the remaining sites are waiting on decisions, not on work.**

### The daemons are through the seam — DONE 2026-08-05

Five of the six: guanyi, meituan, shangou, qingyun, eleme. 154 of 177 daemon sites, 87.01%. `gzgrocery-order-daemon.js` is held on the `store_code` fault above.

Their risk profile differs from a route file and the difference is worth stating. A route file fails in front of a person who retries; **a daemon runs unattended against live channel data on a timer**, so a fault surfaces as stock drifting out of sync with Meituan or Eleme, orders not being collected, or a sync loop erroring in a log nobody reads — hours later and attributed to the channel rather than to us. They also hold no HTTP request to fail; there is no 500 to notice.

Two things made that acceptable rather than merely hoped for. First, the seam is a proven passthrough with no converter installed — 2,781 assertions across the whole better-sqlite3 surface — so there is no mechanism by which a value can change. Second, every one of the 150 statements in these five files was extracted and executed raw against wrapped before they shipped, and none touches a money column.

`deploy-apply.sh` bounces each daemon whose files ship, so they picked the change up on the deploy rather than running stale — which is itself a thing that had to be true and is worth having checked.

### Six statements are failing in production today — OPEN 2026-08-05

Found by preparing all 2,524 in-scope statements against the live schema on 2026-08-05 (`scripts/diagnose_statement_sweep.js`). Each fails every time its path is reached, and each is invisible because it sits behind a `catch` or inside a tool handler. None would ever surface by using the product.

- **`routes/store-admin.js:528` and `:551`** — `retail_orders.created_at`, no such column. These are the operator's order search by number and a customer's recent-order list. Both fail wherever that route is reached. **The most consequential of the six.**
- **`lib/brand-designer.js:61`** — `store_products.is_on_flash`, no such column. A flash-sale existence probe, so the designer behaves as though no flash sale is ever active.
- **`scripts/gzgrocery-order-daemon.js:126`** — `retail_stores.store_code`, no such column. The daemon cannot resolve a store by code at all.
- **`routes/ai.js:2188`** — `ingredient_price_history.created_at`, which is `recorded_at`. The AI assistant's `current_stock` tool throws every time, so the price-history question it exists to answer is never answered.
- **`routes/restock.js:167`** — the `settings` table does not exist. Already recorded separately as "The restock warehouse override has never worked".

**THESE ARE NOT TYPO FIXES.** Each is a code path that has never executed successfully, so downstream code has only ever seen the empty case — an empty result set, a caught exception, a falsy probe. Whoever fixes them must establish, per statement, whether making it work surfaces behaviour nobody has ever seen: a search that starts returning rows, a designer that starts believing a flash sale is active, a daemon that starts resolving stores it previously could not. The fix is one line; the change in behaviour may not be.

Four of the six block a file from the database seam: `routes/ai.js` (72 sites), `routes/restock.js` (38), `routes/ingredients.js` (29, held on `sqlite_sequence`) and `scripts/gzgrocery-order-daemon.js` (23). `routes/store-admin.js` and `lib/brand-designer.js` are in the mixed-TENANT and UNRESOLVED groups and were never movable by that pattern.

### 96 statements will not run on Postgres — FINDING 2026-08-05

From the same sweep. These compile on SQLite and **error** on Postgres — they are not behavioural differences, they are statements that will not execute after the switchover. Across 22 files:

| construct | count | Postgres equivalent |
|---|---|---|
| `INSERT OR IGNORE` / `OR REPLACE` | 60 | `ON CONFLICT` |
| `sqlite_master` reads | 21 | `information_schema` / `pg_catalog` |
| `strftime()` | 5 | `to_char()` / `date_trunc()` |
| `GROUP_CONCAT()` | 5 | `string_agg()` |
| `julianday()` | 4 | date arithmetic |
| `sqlite_sequence` | 1 | `setval()` |

**This is the first measured size of the SQL-dialect work, and it was not on the cutover checklist in any form.** The rehearsal migration proved the DATA converts; nothing had yet asked whether the QUERIES run.

**It is a floor, not a total.** 371 statements are built dynamically — by template interpolation or string concatenation — and are unreachable by static preparation. That blind spot already conceals one known case: the `sqlite_sequence` reset in `routes/admin.js:238` is assembled by concatenation, so only its sibling in `routes/ingredients.js` appears in the count above. Whatever the true number is, it is larger than 96.

### RAW_OPEN is closed, and the pre-converter sequencing constraint — 2026-08-05

**CLOSED — RAW_OPEN is not a scattered-connections problem.** There are **four** raw `new Database(` opens in runtime scope, not 230. The 230 was a statement-site count, 226 of them inside `database.js`. All four opens are correctly raw and **none is reclassified**:

- **`database.js`** — the shared handle and schema bootstrapper. Its statement sites are **17 DDL + 211 DML** (not 226 DDL, as earlier mis-stated). The DML is real outstanding work and stays in the coverage denominator.
- **`lib/tenant-db.js`** — stays raw **by identity comparison**: `tenantAls` and `dbToId` compare handles by identity, and a wrapper changes behaviour. Structure-only replay against `sqlite_master`, 5 SELECT + 2 ALTER, zero DML, **no money writes by construction**. It has no `_migrations` table because it runs no migrations; the presence-check guard is stateless and self-correcting, which is stronger than a flag table.
- **`lib/ops-alert.js`** and **`lib/gzgrocery-order-notify.js`** — stay raw: `readonly: true` opens on the health-watchdog path, deliberately avoiding the schema-migration load that `require('../database')` would pull into every tick. **This is the point of those files, not incidental.**

**No reclassification of the coverage denominator.** An earlier proposal to exclude 226 sites as DDL was withdrawn: 211 are DML and four of them touch money columns — `database.js:731`, `:3398`, `:3419`, `:3545`, the last recomputing lifetime spend across the customer table. Coverage stays **75.28%** and is honest.

**MEASURED THIS PASS** — live SQLite, read-only, `ro-query` run 32, head_sha `54188c0a`, `scripts/diagnose_migrations_ledger.js`:

- All four money writes are one-time and migration-guarded: `lookups_seed_v1` (`:731`), `shipping_spec_alignment_v1` (`:3398`, `:3419`), `backfill_lifetime_spend_v1` (`:3545`).
- **All three migration names are present in the live `_migrations` ledger** (144 rows). Therefore **on live SQLite these four bodies are dead code on every boot** — already applied, and they will not re-fire.

**THE CONSTRAINT — a design requirement, not a defect.** No converter exists yet: the only `installConverter(` call in the codebase is in a discarded diagnostic instance. There is no converter and no install site, so the sequencing requirement can be **designed in rather than discovered wrong**:

> **The converter must be installable BEFORE `database.js` executes its migration list — or migrations must be moved out of module load.**

Rationale: `database.js` runs its migrations at module load. A converter installed later in startup cannot, by construction, reach a migration that runs at load; and on a database where a given migration has **not** yet been applied, that migration runs fresh at load. **The window is open now, and every money-writing migration authored before this constraint is satisfied lands in it.** That growing edge is stated here explicitly rather than left implied.

This belongs next to the pgroll / no-migrations-folder item recorded above ("Schema changes are managed with pgroll", and the constraint that a migrations folder at the repo root would never ship because the deploy allowlist does not cover it). **Same knot.**

**OPEN VERIFICATION GATES — none inferred into fact:**

1. **POSTGRES-SIDE OF THE GUARD: NOT VERIFIED.** The three names are confirmed on live **SQLite only**. That the same three are in the Postgres copy is **inference from row-count equality** — 144 live, the copy established at 144 — which is suggestive, not a read. No Postgres connection was made; the no-pg-connection constraint holds. **Do not treat matched row counts as verification.** Closing this requires a Postgres read, which is a separate decision under a separate constraint.
2. **THE GROWING EDGE.** Any migration authored after the copy cutover, or added between now and the converter's install point, is not covered by gate 1 **even once gate 1 closes**, and fires fresh in the pre-converter window.
3. **THE 62 UNRESOLVED.** Separately open. This is where a tenant-side money write would hide if one exists outside `lib/tenant-db.js` — a backfill taking a tenant handle as a parameter. Survey briefed, not yet run.

**HONEST LIMITS:**

- The `readonly` watchdog reasoning is verified against code and comment, **not against runtime behaviour**.
- The RAW_OPEN survey sees `new Database(` and the checker's attribution. A handle obtained another way lands in the 62 UNRESOLVED (gate 3), not here.
- Two facts were corrected mid-investigation — "230 opens" → four, and "226 DDL" → 211 DML including four money writes. **Both were inferences presented as measurements.** The corrected picture is the one recorded above.

### Three deploy findings recorded, NOT fixed — 2026-08-05

Found while fixing the diff-base bug, deliberately left alone so the fix stayed one change. All three are live today.

1. **DELETIONS NEVER PROPAGATE. A file deleted from `main` stays on the production box forever.** `deploy.yml` skips deletions (`[ -f "$f" ] || continue`) and `deploy-apply.sh` only ever copies — and `full_sync` does not delete either, so the recovery path does not clear them. Confirmed with a live instance, not inferred: **`public/retail-admin.js` was deleted from main on 2026-06-11 in `64c55e7a` ("Mini App Backend: split app JS into 10 per-feature files (Step 2b)") and was still present on the server on 2026-08-05, 54 days later.** Whatever still references it keeps resolving. This matters beyond housekeeping — §24 says `lib/tenant-db.js` is deleted in a later phase, and on today's pipeline it will linger on the box after that deletion ships.

2. **The deployed `package-lock.json` is not the committed one.** `deploy-apply.sh` runs `npm install --omit=dev` whenever `package.json` or `package-lock.json` ships, and npm rewrites the lockfile in place afterwards. The 2026-08-05 tree comparison found it as the ONLY file differing from main — main `0eb15c94`, box `bc8875c0` — despite the `full_sync` having installed the committed bytes hours earlier and nothing touching it since. So the server's lockfile is npm's regeneration, and a future `npm install` there can resolve differently from a clean install of the repository. Same class as the `sw.js` stamp: a file the installer mutates after installing it. Not drift from the skip bug.

3. **`scripts/deploy-changed.sh` has the identical diff-base bug.** The local post-commit hook ships only `git diff-tree HEAD`, so a failed local deploy strands its files exactly the same way, and it does not write `.deploy-state/last-success-sha`. The direction is safe — a stale record makes the NEXT CI deploy ship a wider set, never a narrower one — but the hook itself can still skip files silently, and nothing about the CI fix protects a developer deploying from their own machine.

Also noticed, lower stakes: the ship step's `ssh … | tee … || true` discards the installer's exit code, so `ABORTED_NPM_INSTALL` is reported as the generic "did not report SUCCESS"; and the ship loop runs one `ssh` per directory and one `scp` per file, which is why a `full_sync` of 480 files takes 37 minutes (`$DIRS` is also unquoted and would word-split on a path containing spaces — none exist today).

### Postgres cutover checklist — items recorded as they are found

Actionable items that must happen AT the cutover and cannot be solved by the code beforehand. This section exists because the first such item was found while drawing the seam's scope line, and there was nowhere to put it. `GO-LIVE-CUTOVER.md` is the WeChat mini-app runbook and is a different cutover; this list is the Postgres one.

- [ ] **REPLACE THE `sqlite_sequence` RESETS WITH `setval` AT CUTOVER.** `routes/ingredients.js:299` and `routes/admin.js:238` reset AUTOINCREMENT counters by deleting from `sqlite_sequence`, which does not exist in Postgres. Both are inside `try {} catch {}`, so after the switchover they fail silently and the counters do not reset — the next insert continues from the old high-water mark, the opposite of the intent, and nothing warns. Must be converted at the same time the application moves, not afterwards.

- [ ] **DELETE RETIRED FILES ON THE BOX BY HAND — THE DEPLOY WILL NOT.** The pipeline never removes a file: `deploy.yml` skips deletions and `deploy-apply.sh` only copies, so anything dropped from `main` keeps running in production. Proven live on 2026-08-05: `public/retail-admin.js` was still on the server 54 days after being deleted from main. At the cutover this stops being housekeeping — `lib/tenant-db.js` and the file-per-account isolation it carries are deleted in a later phase per §24, and a file that is supposed to be gone but is still importable is exactly the kind of thing that gets loaded by something nobody remembered. Take a `diagnose_deployed_tree.js` reading first, then remove the EXTRA entries deliberately.

- [ ] **REMOVE OR RENAME `data/roots.db` AT CUTOVER.** About 80 one-off scripts in `scripts/` open the live SQLite database by path and would run unedited tomorrow. They are deliberately out of scope for the database seam — see the scope decision below — and that exclusion is only safe if the file they reach for is gone. Left in place, every one of them keeps working against a stale database after the application has moved to Postgres: reads return figures that look right and are months old, and writes land somewhere nothing reads. Nothing warns. The notable ones a person might actually reach for: `reset_test_orders.js`, `restore_recipe_data.js`, `seed_missing_store_stock.js`, `guanyi-pickup-report.js`, `meituan-queue-status.js`. Renaming is preferable to deleting — it keeps the rollback path and still breaks the scripts loudly with "unable to open database file".

### What the database seam is responsible for, and what it is not — DECIDED 2026-08-04

THE RULE: a file is IN SCOPE for the seam if it can reach the LIVE database on an ongoing, unattended basis. That is the criterion because the converter exists to protect live money values. A file that cannot reach live data cannot corrupt it, and a script that ran once and would have to be edited before it ran again is not part of the system's steady state.

IN — everything in `routes/`, `lib/`, `middleware/`, plus `server.js` and `database.js`, and the six channel daemons: `guanyi-daemon.js`, `meituan-daemon.js`, `shangou-daemon.js`, `gzgrocery-order-daemon.js`, `qingyun-daemon.js`, `eleme-daemon.js`. They run continuously under pm2 and write live order, stock and sync data. Together: 2,799 statement sites.

OUT — one-off backfills, fixups, imports, seeds and hand-run diagnostics in `scripts/`, and verifiers that only ever touch a temporary database. 437 sites across 135 files.

RECURRENCE IS NOT THE TEST, REACH IS. `scripts/verify-fulfilment-types.js` runs on every deploy that touches fulfilment — it is one of the most frequently executed scripts in the repository — and it is out of scope, because it builds a throwaway SQLite database in the OS temp directory and never opens the live one. Conversely a backfill that has not run since June is in the same category as one that ran yesterday if both would open `data/roots.db` on demand.

THE COST OF THE EXCLUSION, RECORDED RATHER THAN BURIED. About 80 of the excluded scripts open the live database by path and would do so again tomorrow if someone ran them unedited. Excluding them is a judgement that they will not be run AFTER the Postgres cutover — not a claim that they cannot be. Notable ones that a person might plausibly reach for: `reset_test_orders.js`, `restore_recipe_data.js`, `seed_missing_store_stock.js`, `guanyi-pickup-report.js` and `meituan-queue-status.js`. If the SQLite file is left in place at cutover, every one of them keeps working against stale data, silently, and any write lands in a database the application no longer reads. **Removing or renaming `data/roots.db` at cutover is what actually makes this exclusion safe, and it belongs on the cutover checklist.** The seam cannot make it safe.

BOTH NUMBERS ARE ALWAYS REPORTED. `scripts/db-seam-coverage.js` prints coverage with and without the excluded scripts, and states how many sites the exclusion removes from the denominator, so the scope decision stays visible instead of quietly improving the figure.

### The coverage checker was measuring less than it claimed — CORRECTED 2026-08-04

Three blind spots, each of which silently shrank the denominator rather than announcing itself:

1. A `.prepare(` whose receiver could not be recovered was DROPPED instead of counted as UNRESOLVED, despite the file's own header promising the opposite.
2. Regex literals were not recognised. `scripts/guanyi-daemon.js` contains `.replace(/^['"]|['"]$/g, '')`; the scanner entered string mode inside the regex, desynchronised, and swallowed the rest of the file. That daemon reported **0** statement sites when it has **40**. Across the six daemons the count went from 20 to 177 once fixed.
3. Nested template literals inside `${...}` are still not tracked. An attempt to handle them made the measurement worse, not better — `routes/retail.js` fell from 1,124 attributed sites to 476 — so it was reverted deliberately.

THE FIX THAT MATTERS IS NOT ANY OF THOSE THREE. It is the reconciliation check now in the checker: every file's attributed site count is compared against a naive count of `.prepare(` in the same source, and any shortfall is reported as a SCANNER GAP. That is what turns a silent under-count into a visible one, and it is the same lesson as `operator-caps` — it is not enough that nothing complained; the thing has to be shown to have happened. One gap is currently open and stated: `routes/retail.js` attributes 1,124 of 1,220 sites, the missing 96 being statements inside nested template literals.

Coverage numbers quoted before 2026-08-04 were therefore measured against a denominator that was too small in `scripts/` and too large nowhere. The seam's covered count was never wrong; the total was.

### Step A of the tenant step — raw accessors, a guard, and currentTenantId() stops guessing — DONE 2026-08-04

The seam's next move is to route `tdb()` and `getTenantDb()` through it, which covers 1,333 statement sites — about half the in-scope application — in one change. That is the opposite of the incremental pattern that has worked, so it is split. Step A does everything except the wrapping; Step B is then a two-line flip whose entire risk surface has already been retired.

THE CALL SITES WERE 23, NOT 15. The first estimate was made by eye. Enumerated properly: 10 pass `getTenantDb(tid)` straight into `tenantAls.run()`, 8 pass a local `tdb_` bound from `tdb()`/`getTenantDb()`, 3 pass `req.tenantDb`, and 2 pass an already-raw handle. Every path into the ALS except those last 2 originates from `getTenantDb()`, so wrapping it without this step would put a wrapper into 21 of them.

WHAT STEP A DID. `rawTenantDb(id)` and `rawTdb()` are exported and always return raw handles; `rawTenantDb()` remains the only writer of `dbToId`, so everything it hands out is identifiable. All 21 sites were converted. `getTenantDb()` and `tdb()` still return raw, so **Step A changes no behaviour except the one below** and coverage is unchanged.

`tenantAls` IS NOW A GUARDED FACADE, not the AsyncLocalStorage itself. It exposes the same `.run` and `.getStore` the 29 existing call sites already use, and throws if handed a seam-wrapped handle. Nothing changes shape; a missed site fails loudly at first execution instead of silently mis-identifying the tenant.

THE AGREED BEHAVIOUR CHANGE: `currentTenantId()` no longer answers "Roots" when confused. It was `return dbToId.get(store) || ROOTS_TENANT_ID`. A handle this module never created fell through that `||` and became a confident wrong answer — and this value selects a tenant's credentials. Now: no scope at all → Roots, a scope explicitly entered with `mainDb` → Roots, and anything else throws. A system that guesses "it must be Roots" when it cannot tell is the leak the isolation work exists to prevent.

WHAT CAN REACH THE THROW, CHECKED BEFORE SHIPPING. The branch needs an active scope holding a handle that is neither `mainDb` nor in `dbToId`. In production that cannot happen: only Roots exists, `TENANT_DATA_ISOLATION` is off, every ALS value comes from `rawTenantDb()` or the shared handle, and `openTenantDb()` has no callers outside this module. One place in the repository does reach it — `scripts/verify-closed-store-routing.js` enters a scope with its own temporary-file handle. It is hand-run, automated nowhere, and out of the seam's scope; and the only `currentTenantId()` call reachable from it is `lib/inventory.js`'s `_bumpStockLive()`, which already wraps it in `try`/`catch` and returns, documented as best-effort and never part of a write's contract. So it degrades exactly as it already does in daemon processes with no live hub.

PROVEN BY ENUMERATION, NOT BY MEMORY. `scripts/check-tenant-als.js` discovers every `tenantAls.run()` call site by scanning and fails unless each one's first argument provably produces a raw handle. A site added next month is caught by default. The gate found its own blind spots while being built: it initially missed `routes/retail.js:5670` because comment-stripping was not string-aware, so a `//` inside a URL string ate the rest of the line — the same class of bug as the coverage checker's regex-literal gap, and the reason it now reconciles what it classified against what is actually there.

### Step B of the tenant step — the flip — DONE 2026-08-04

Two lines. `tdb()` and `getTenantDb()` now return `seam(...)` instead of the raw handle. Seam coverage went from **18 of 2,799 in-scope statement sites (0.64%) to 1,351 of 2,799 (48.27%)** — 51.53% of the runtime surface alone. Including the excluded one-off scripts: 41.80%. Everything that made it safe was built in Step A, which is why the flip itself is two lines.

THE ALS STILL HOLDS RAW HANDLES. The wrapping happens on read, in the accessor, not in the store. `rawTenantDb()` and `rawTdb()` are unchanged and still raw, `dbToId` is still keyed on raw identity, and `seam()` is idempotent and caches one wrapper per handle so `getTenantDb(1)` keeps a stable identity across calls.

THE PROPERTY THE STEP TURNS ON, PROVEN FOR MORE THAN ONE TENANT. For every row in `tenants`, `tenantAls.run(rawTenantDb(id), () => currentTenantId()) === id`, asserted with the seam active and with it stubbed to the identity function. This matters because `currentTenantId()` selects a tenant's credentials: if the flip broke it, one account would act with another's WeChat and payment configuration.

The check is run against a fixture carrying three tenants, not just Roots, and that is not a detail. Driven against a deliberately broken build — the ALS accepting wrappers, `rawTenantDb()` handing one out, and `currentTenantId()` falling back to Roots, i.e. exactly Step B without Step A — **tenant 1 still passes** while tenants 2 and 7 both silently report as Roots. On live there is only Roots, so the live run cannot see this failure mode at all. The fixture is what catches it.

TENANT DATABASES ARE MATERIALISED IN A SCRATCH TREE, NOT THE LIVE ONE. `rawTenantDb(id)` for a non-Roots id creates `data/tenants/<id>.db` and writes schema into it. That path resolves relative to `tenant-db.js`'s own location, so under the `ro-query` staging directory it lands in scratch. The diagnostic asserts this before opening any non-Roots handle and refuses the sweep if the resolved directory is inside the live application — so a future change to how diagnostics are staged cannot quietly turn a read-only check into a writer.

COVERAGE IS NOT SELF-CERTIFIED. `tdb()` and `getTenantDb()` are indirections, so whether a `tdb().prepare(...)` site counts as covered depends on what those functions return. Rather than hard-code that — which is how a measured number turns back into a claim — the coverage checker reads `lib/tenant-db.js` and tests whether the accessors actually return `seam(...)`. Unwrapping `tdb()` drops the reported figure from 51.53% to 0.69% on its own, with the basis printed on every run.

WHAT THE STEP A DIAGNOSTIC NOW ASSERTS. Its §1 originally checked that nothing was wrapped, which was Step A's whole point and is deliberately false after Step B. Those assertions were retired and replaced with the invariants that survive — the raw accessors staying raw — rather than left to fail and be ignored. A check that is expected to fail teaches people to skip the output.

### Store opening hours are not configured — OPEN 2026-08-04

Live `retail_stores` holds two rows, `tianhe` and `yuexiu`, and neither has a usable `open_time` / `close_time` pair. `storeHours()` therefore returns null for every store in production, and every consumer treats every store as always-open.

What is consequently not in effect: the Qingyun ops-alert muting, and the Meituan (外卖) and Shangou (闪购) polling windows. These are configured in the admin but have no effect. Those three daemons — `scripts/qingyun-daemon.js`, `scripts/meituan-daemon.js`, `scripts/shangou-daemon.js` — are the only consumers of `lib/store-hours.js`. Eleme is NOT among them: `scripts/eleme-daemon.js` does not read the module, and no eleme daemon is running under pm2. Separately and not investigated, `routes/retail.js` and `routes/retail-inventory.js` read the same two columns directly rather than through the module, which is the `resolvePickupTime` consumer already recorded in §9's "one hours field cannot answer three questions".

Pre-existing, unrelated to the Postgres migration, and not blocking. Found incidentally on 2026-08-04 while routing `lib/store-hours.js` through the database seam. Not investigated — it is not known whether this is a feature built and never configured, or configured and later cleared, or which admin surface sets these values.

To resolve later: identify which screen sets `open_time` and `close_time`, name each consumer and what it would do differently if hours were set, and decide whether the windows should be configured or the feature removed.

### The seam passes money through untouched — the converter seat is EMPTY — MEASURED 2026-08-05

Measured on branch `claude/money-seam-conversion-verify`, commit `491af07`, `ro-query` run 35. Read-only throughout: `roots.db` opened `readonly: true`, the read-only property proven by a rejected write both before and after the run, and the 18 writes the real handlers attempted were suppressed — none executed.

**THE SEAM DOES NOT TOUCH THE MONEY VALUE. IT IS A PURE PASSTHROUGH.** The three money writes verified last pass — `products.js:454` (`sell_price`), `retail.js:15899` (`reward_amount`), `retail.js:18197` (`sell_price` and `compare_at_price`), four columns, all class CENTS — were driven on the live production box and every one of them arrived at the connection exactly as it left the request.

**`currentConverter() === null` ON THE LIVE CONFIGURATION, OBSERVED AT RUNTIME.** In `wrapStatement` the guard `if (!converter || !STMT_INTERCEPT.has(prop))` takes the raw path — `value.apply(target, args)`, verbatim. So the seam does not merely decline to convert: with no converter seated it never inspects the value at all.

**PROVEN BY THE VALUE, NOT BY THE SOURCE LINE.** A known fractional-yuan amount went in the request body, the real handler ran, and what arrived at the connection was captured together with its JavaScript type. `12.34` in, `12.34` out — a fractional number, not an integer — at the connection, for all four columns. A converted value would have arrived as integer cents, `1234`. **10 money-parameter observations, 10 unchanged, 0 altered.** Reading the guard would have suggested this; the captured value is what establishes it.

**AN EMPTY SEAT, NOT A COVERAGE GAP — the distinction is the point.** A recording identity converter installed in a throwaway child process received all four values, so **the seat REACHES all four**. The passthrough is therefore a configuration fact — no converter is installed — and not the seam failing to see these writes. When a real converter is seated, these four writes are already in its path and need no further routing work.

**GENERAL, NOT ROOTS-ONLY.** Both retail sites were driven across three distinct wrappers — the live main handle plus two separate in-memory tenant handles, confirmed to be distinct objects each unwrapping to its own raw handle — and every money column arrived identically at all three. The structural reason: `converter` is a single module-level variable in `lib/db-seam.js`, consulted per call, with no per-handle, per-tenant or per-wrapper branch anywhere; the WeakMaps cache wrappers, not converter state. The prior pass's SEAM/TENANT same-wrapper collapse stays boxed as a Roots-only artefact of `getTenantDb(1) === mainDb` and was deliberately NOT allowed to carry this claim.

**THE RISK, STATED AS THE MONEY BUG THE CONVERTER MUST FIX.** This is not a SQLite problem today. Those columns are REAL in SQLite, the application reads and writes yuan end to end, storing `12.34` is consistent with everything around it, and nothing is wrong on the live box. The risk is entirely Postgres-side: the target type is `bigint`, and `12.34` into `bigint` is either a rejection or a truncation to `12` — **a 100× understatement of every price and every reward**. A converter MUST be seated before these writes reach Postgres.

### The deployed sha is `ffe232e`, READ rather than assumed — CORRECTION 2026-08-05

The deployed production sha, read from `/root/roots-v2/.deploy-state/last-success-sha`, is **`ffe232e`** (`ffe232e62749df5ded998d54cd632a1831bb71d3`).

**THIS CORRECTS TWO PRIOR ASSUMPTIONS.**

1. **`54188c0a` is stale.** The box moved to HEAD roughly ninety minutes after that figure was recorded. Every standing line in this document that asserts `54188c0a` as production is left standing and is superseded by this entry — none of them is edited.
2. **There is NO 4-commit gap.** `c9d896c`, `7c44a87` and `ccdf274` shipped no deployable file, so the deploy record never advanced for them. The record advances only when a push ships a deployable file; three docs-and-workflow commits leaving it unmoved is the record working, not the record lagging.

**PROVENANCE AND CAVEAT, RECORDED HONESTLY.** This is the deploy's own record of itself. `/root/roots-v2/.git` is absent — the box is `scp`'d, not checked out — so there is no independent working-tree second opinion available from the box. `scripts/diagnose_deployed_tree.js` exists and would give a byte-level comparison against the repository if one is ever wanted; **it was NOT run this pass.** One line was requested and read; the read is not reconciled against the artefact.

**THE META-FACT, PLAINLY.** This figure had been stated twice in prior passes and was read once here. Reading it dissolved a four-commit gap that would otherwise have been reasoned about — the gap was never there. The cost of reading the record was one line.

### Ten money writes were hiding in the `routes/retail.js` scanner blind spot — FINDING 2026-08-05

Read-only, static survey. No database was opened; the no-pg-connection constraint holds; nothing was routed, no scanner was changed and no coverage figure moved.

**THE BLIND SPOT IS ONE CONTIGUOUS WINDOW, AND IT IS THE REFUND PATH.** The coverage scrubber desynchronises on a nested `${...}` template and cannot parse `routes/retail.js` lines **22368–24197** — the shipping, tracking and refund region. The **96** statement sites in that window were absent from BOTH the numerator and the denominator: neither counted covered nor counted uncovered, invisible to the measurement in either direction.

**96 IS EXACT, NOT A FLOOR — ESTABLISHED TWICE, INDEPENDENTLY.** The scanner's own arithmetic (1220 naive − 1124 attributed) could not be trusted to give it, because the naive count is produced by the same desynchronising `scrub()` and can lose occurrences itself. So the set was established two other ways: a nested-template-aware lexer with full `${...}` recursion, which finds **1220** `.prepare(` occurrences and puts **all 1220 in genuine code positions** — none hidden inside emitted HTML; and lifting the scanner's own `scrub()` out of its source at runtime and diffing what survives it, which gives **1124 visible, 96 invisible, 0 false positives**. Both agree. The window is clean at both ends: all 96 true sites inside 22368–24197 are blind, and **0** of the 1,124 sites outside it are — 933 before, 191 after. One desync, one resync.

**TEN OF THEM ARE MONEY WRITES.** All ten are on `tdb()`, which returns `seam(...)` — **on the seam, none raw**. All ten are on the refund path. All bind **fractional-yuan** values into CENTS columns: the surrounding code reads `+(priorApproved + amount).toFixed(2)`, `+(Number(_row.total) || 0).toFixed(2)` and the like. They are **distinct from the three characterised in run 35** — `retail.js:15899` and `:18197` are below 22368 and were always in the visible region. They sit in the **same untouched-passthrough / 100×-bigint condition** as those three, except that until now they were unrecorded AND invisible to coverage in both directions.

Every column below is classified from `plan.json` `cls`, never from its name; every site was read in source and the parse confirmed verbatim.

| site | kind | table | money columns (all CENTS) |
|---|---|---|---|
| `23102` | UPDATE | `retail_payments` | `refunded_amount` (SET), `amount` referenced |
| `23289` | UPDATE | `retail_payments` | `amount` |
| `23295` | INSERT | `retail_payments` | `amount` |
| `23380` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_amount_paid` |
| `23392` | UPDATE | `retail_payments` | `refunded_amount = amount` |
| `23429` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_amount_paid`, `refund_cash_amount` |
| `23451` | UPDATE | `retail_payments` | `refunded_amount = amount` |
| `23784` | UPDATE | `retail_orders` | `refund_amount_approved`, `refund_cash_amount` |
| `23936` | UPDATE | `retail_orders` | `refund_amount_paid` |
| `24097` | UPDATE | `retail_orders` | `refund_amount_requested`, `refund_amount_approved`, `refund_amount_paid`, `refund_cash_amount` |

**THE READS, RECORDED FOR COMPLETENESS AND NOT AS THE HEADLINE.** 16 money reads in the same window: 13 that name their columns, plus three `SELECT * FROM retail_orders` at `23474`, `23593` and `23629`, each returning all **12** CENTS columns of that table — a case column-name matching would have missed, stated because it is the false negative this method was prone to. One read is behaviourally load-bearing under conversion: **`23123` compares `COALESCE(refunded_amount, 0) + 0.005 < amount`** — a half-fen epsilon expressed in yuan and decided SQL-side. Under bigint cents that comparison stops meaning what it was written to mean.

**THE TALLY, AND THE ZERO THAT WAS CHECKED RATHER THAN ASSUMED.** 96 = **10 money writes + 16 money reads + 70 non-money**, with **0 unresolved**. Every site resolved to a table present in the census. The one genuinely dynamic column list — `23237`, `UPDATE retail_orders SET ${sets.join(', ')}` — was hand-resolved by enumerating every `sets.push` in its handler and class-checking each candidate against `plan.json`: `status`, `updated_at`, `def.col` ∈ {`paid_at`, `preparing_at`, `dispatched_at`, `delivered_at`, `cancelled_at`, null}, `payment_method`, `cancelled_reason`, `staff_note`, `refund_status` — TEXT and TS only, **no money column can appear**. One raw handle is noted in the window and is not a money site: `22775` uses a bare `db`, which resolves to the module-level `require('../database')` (DIRECT, not seam) because its enclosing handler declares no local `db`; its table is `activity_log`, which carries no money columns.

### A CONVERTER CANNOT REACH SQL-SIDE MONEY EXPRESSIONS — STRUCTURAL LIMIT 2026-08-05

This is a limit on what the converter design can achieve, not a fact about any particular set of sites.

**A JavaScript boundary converter fixes BOUND PARAMETERS — the `?` values the application hands the driver. It structurally CANNOT reach money that lives on the SQL right-hand side**: column-to-column assignments and arithmetic performed inside the statement. Those values never cross the JavaScript boundary, so there is no point at which a converter could see them.

**THE DANGEROUS PART IS THAT IT LOOKS LIKE COVERAGE.** Seating a converter at such a site converts the bound parameter and leaves the column-side expression exactly as it was. The site is then reported as covered, the statement still carries an unconverted money value, and nothing anywhere announces the difference. **That is worse than an open gap: an open gap is counted, and this is not.**

Five of the ten writes recorded in the blind-spot finding above are of this kind and are named here as **converter-unreachable**:

| site | the expression a converter cannot reach |
|---|---|
| `23102` | `MIN(amount, COALESCE(refunded_amount, 0) + ?)` and `CASE WHEN amount <= COALESCE(refunded_amount, 0) + ?` |
| `23392` | `refunded_amount = amount` — column to column |
| `23429` | `COALESCE(refund_amount_approved, ?)` |
| `23451` | `refunded_amount = amount` — column to column |
| `24097` | `MAX(COALESCE(refund_amount_requested, 0), ?)` |

At each of these, seating a converter fixes the bound `?` and leaves the column-side expression untouched.

**THE DESIGN CONSEQUENCE, WHICH IS THE DURABLE POINT.** The converter-seating work **cannot be planned as though seating the converter closes the money risk on the refund path.** It closes the parameter half of it. SQL-side money expressions need a separate mechanism — rewriting the statements, or handling the schema and units so that the in-SQL arithmetic is correct under bigint cents. **Which mechanism is an OPEN DESIGN QUESTION and is deliberately not answered here.** It is recorded now so that the converter's scope is drawn with this limit already in it, rather than discovered after the converter is seated and believed to be sufficient.

### MONEY IS STORED AS DECIMAL, NOT WHOLE CENTS — DECIDED 2026-08-05

**This supersedes the earlier decision that money is stored as whole cents, never as a decimal.** That line is left standing where it is and is superseded by this entry, not edited.

**WHY THE EARLIER DECISION IS REVERSED.**

Whole cents assume every currency has exactly two minor units. That is false — JPY has none, KWD has three. A fixed two-decimal model therefore hardcodes an assumption about the world, which **§0 Governing rules forbids**: accounts each set their own currency, and nothing may be built around one business's situation. The cents rule was adopted to kill a floating-point defect, and it does kill it; but it pays for that with a Roots-shaped assumption baked into the storage type itself.

A measurement pass on 2026-08-05 — read-only, static, no database opened, 185 files, **3,785 statement sites**, **565 money-touching**, lexed with full nested-template awareness so it does not inherit the blind spot that hid the ten refund-path writes — established the rest of the case.

- **The in-SQL problems that cents would force us to chase are small.** 7 hardcoded money constants (the `0.005` half-fen guard appears **3 times**, not once); **5** unit-sensitive expressions, all of them the same store-credit `ROUND(..., 2)` construct on `retail_customers.balance`; **24** money parameters buried inside expressions rather than bound as bare assignments.
- **The two-decimal assumption, by contrast, is pervasive.** 51 round-to-two sites, 90 lines carrying `toFixed(2)`, 105 identifiers containing `cents` or `fen`. Under a cents model every one of those must be kept, and defended per currency, forever.
- **Trading money carries no currency anywhere.** The only columns that store a currency at all are on the billing tables — `billing_invoices`, `billing_plans`, `plans` — and those are **already integer cents**. The currency lives exactly where multi-currency is not needed, and is absent from every column where it is.
- **107 money statements are built by string interpolation and cannot be read by any static scan** — 49 in `routes/retail.js` alone. This is the decisive asymmetry. Under cents, a hidden constant in that set is a silent 100× bug. Under decimal, a hidden yuan constant like `0.005` remains correct. **Decimal is safe against the part we cannot see; cents is not.**

**CONSEQUENCES — each is its own downstream decision and NONE is settled by this entry.**

- Postgres money columns become decimal. The completed full data copy of 2026-08-04, which landed as bigint cents, must be rebuilt as decimal. Scripted work, not hand work.
- Every money amount needs a currency stored beside it, and cross-currency arithmetic must be blocked or explicitly converted. **This requirement is independent of cents-versus-decimal** and would have been owed either way.
- **The decimal SCALE is unsettled.** The nine columns already migrated are `numeric(14,6)`. Whether six fractional digits is the right scale for money, and whether a precision of 14 leaves enough headroom, is an open question and is **NOT decided here**.
- **The seam still needs a read-side converter.** The Postgres driver returns both `bigint` and `numeric` as text. Decimal removes the RESCALING from the converter; it does not remove the converter.
- **The `0.005` half-fen epsilon and the five `ROUND(..., 2)` sites are correct under decimal yuan and need no change.** They were only ever wrong under cents. **Do not "fix" them.**

**STATUS: a design decision, recorded. No code, no schema and no data is changed by this entry.** The build that follows from it — schema rebuild, currency column, scale decision, copy re-run — is separate and is not yet briefed.

## 25. Language scaling — LOCKED 2026-08-05

GOVERNING PRINCIPLE, restated from §0 Governing rules: Tacet assumes NO fixed language set. Language is per account. No mechanism below may hard-require English, Chinese, or any two-language pairing. Rulebook §1.11 (one language on screen at a time — tacet-desktop-patterns.md) continues to apply.

### Decision 1 — Two separate systems for text

- UI CHROME — Tacet's own text: buttons, labels, menus, errors, empty states — is Tacet-owned and lives in Tacet's translation files, shipped with the product.
- MERCHANT CONTENT — product names, descriptions, storefront copy — is account-owned data stored in the account's database records, in whichever languages the merchant chooses to write. Never mixed with chrome.
- Super-admin visibility is unaffected — this governs authorship, not access.

### Decision 2 — UI strings move to one file per language

- The hardcoded bilingual pair pattern — `cuT('en','中文')`, 2,510 call sites, roughly 3,300 string pairs per the audit's §E (docs/tacet-multibusiness-audit.md) — is REPLACED by key-based lookup into per-language files: one English file, one Chinese file, and so on.
- Adding a language = adding one translated file. Zero code edits.
- THE EXTRACTION/MIGRATION ITSELF IS A SEPARATE, DEFERRED BUILD STAGE. This entry decides the mechanism; it does not begin the work.
- Bilingual database columns (e.g. `name_cn`) are merchant-content shape questions for the Postgres schema rebuild (§24 Database), governed by Decision 1, also deferred.

### Decision 3 — Admin language: account default plus per-user override

- Each account sets a default admin language.
- Each user may override it for their own session/profile. The override affects only that user's screen, never account data.

### Decision 4 — Missing-string fallback

- A key missing in the chosen language displays the ENGLISH string. Never render blank/empty.
- English is the REFERENCE FILE and must always be complete.

### Decision 5 — Storefront language

- Each account selects a LIST of storefront languages — one or many, from languages Tacet has files for — and designates one as the DEFAULT. Storefront language selection is independent of the account's admin language.
- More than one language on the list → the storefront shows a language switcher offering exactly that list. One language → no switcher.
- Chrome follows the selected storefront language. Merchant content displays as written by the merchant in that language where provided; otherwise it falls back to the account's storefront default language. NO AUTO/MACHINE TRANSLATION of merchant content, ever.
- NO BROWSER-LANGUAGE AUTO-DETECTION. The merchant's configured default governs first load.

### Decision 6 — Language roadmap and translation process

- Ship with ENGLISH and CHINESE only — the current state. No pre-built language list.
- New languages are added ON DEMAND when a real market appears: one file per language.
- Translation process: AI-generated first draft, MANDATORY native-speaker review before ship.

### Sequencing

This proposal PRECEDES and is a DEPENDENCY OF the Products and Stock consolidation stages (§22 Rollout order and priority). Any schema or code touching bilingual text must conform to Decisions 1 and 2.

Resolves the §23 open question "a plan for scaling languages on both the admin and customer surfaces."

## 26. Related documents

- docs/tacet-glossary.md — binding definitions, v1.4, 2026-07-31. The words in this document are used with the meanings defined there.
- docs/tacet-desktop-patterns.md — the rulebook for how a desktop admin page is put together, v4.2, 2026-08-03. Prescriptive except on Orders: when a rule and an unbuilt page disagree, that document wins.
- docs/tacet-core-survey.md — verified current-state inventory, 2026-07-30
- docs/tacet-product-fields.md — product field inventory, 2026-07-31. 78 columns; 41 contested writes.
- docs/tacet-stock-model.md — stock and reservation behaviour, 2026-07-30. Records 14 inconsistencies in the store stock model; three were live bugs.
- docs/tacet-locations-survey.md — locations current state, 2026-07-30. Records that `markets` and `retail_stores` are two complete competing models, and that `retail_stores` already holds everything operationally real.
- docs/tacet-order-routing.md — how a fulfilment location is chosen, and what happens on stock shortage, 2026-07-31. Read-only behavioural survey.
- docs/tacet-multibusiness-audit.md — audit against §0, 2026-07-31. 121 findings, 26 blockers. Headline: Roots is the default database, not a row in it.
- docs/tacet-money-model-survey.md — the money-unit gap between the application and Postgres, 2026-08-04. Read-only survey behind the boundary-layer decision in §24. 92 columns changed unit, plus nine to numeric(14,6); records the read and write sites, the SQL-side arithmetic a JavaScript boundary cannot reach, the mixed-engine transition hazard, and the second money model in storefront_config that the boundary layer structurally cannot reach.
