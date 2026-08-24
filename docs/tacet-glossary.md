# Tacet glossary

**These are the binding definitions for Tacet. Every document, every UI string and every new identifier uses these words with these meanings. Where existing code or documentation uses a different word for the same thing, the code is what needs changing, not this list. v1.8, 2026-08-24.**

**v1.8, 2026-08-24** — the three contradictions v1.7 only MARKED are now CLOSED. ITEM stops being a defined term and becomes a pointer to MATERIAL; PRODUCTION stops being defined as an app and is redefined as a module, since "merges into Tacet later" describes a merge that has nothing to merge; RECIPE now reads *material*, the last defined-term usage of the old word in this file. MATERIAL gains its locked Chinese label, 物料 — **the first locked CN label in this document**, recorded here rather than in `docs/tacet-delivery-vocabulary.md` because that document's own scope line binds it to *every delivery/fulfilment word*, and a material is not one. 物料 is copied from live admin markup, never composed, and 食材 is named explicitly as the food-kind label it actually is so the two are not traded for each other later.

**v1.7, 2026-08-24** — MATERIAL, MATERIALS SCREEN and PRODUCTION MODULE added, per the consolidation decisions record §28. ITEM is superseded by MATERIAL and PRODUCTION (the app) by PRODUCTION MODULE; both are marked in place rather than deleted, because they are the words every earlier document uses. The MODULE list and the States section are updated to read MATERIALS. INGREDIENT stays retired — its retirement now points at MATERIAL rather than ITEM.

---

## The things you stock

- ITEM — **retired as a defined term, 2026-08-24. See MATERIAL.** It was ambiguous with PRODUCT in conversation and is no longer used; the thing it named is unchanged and is defined below.
- MATERIAL — a stocked thing a tenant buys and holds but does not sell. Food, packaging, equipment, supplies. Has stock and a cost; has no price and no storefront listing. Contrast with PRODUCT, which is what a customer buys. The database calls these `ingredients` for historical reasons; that name is never shown to a tenant.
  - Chinese label: 物料. Locked. Not composed for this entry — it is already the live label for this concept in the production admin (the nav row, the page title `ITEMS · 物料库`, the new-item command, the `物料类型` form label) and in `database.js`, where the comment that introduced `item_kind` calls the broadened table *Items / 物料*.
  - 食材 IS NOT A SYNONYM AND THE TWO ARE NOT INTERCHANGEABLE. 食材 is the label for the FOOD KIND specifically — it is the `label_cn` of `item_kind: food`, one of four kinds alongside packaging, equipment and retail. 物料 names the whole list; 食材 names the food in it. Using 食材 for materials as a whole re-imports the exclusion that got INGREDIENT retired, in the other language, where an English reader would not catch it.
- MATERIALS SCREEN — the screen where a tenant manages their materials. Appears only for tenants with the Production module enabled.
- PRODUCT — something sold to customers. Visible in both apps.
- Materials and products are two separate lists. A thing is one or the other, never both. The bridge between them is a recipe.

## Places

- LOCATION — anywhere stock is held or selling happens. One list, one module, shared by both apps.
- PHYSICAL — a permanent location. A shop, a warehouse, a production site.
- TEMPORARY — a location with an end. A market stall, a pop-up.
- PRODUCTION (flag) — things are made at this location. May sit on any location, physical or temporary. Replaces the earlier working name "kitchen", which is retired as a type name. A business may still call the place a kitchen; that is its name, not its type.
- WAREHOUSE — not a type. A physical location with no sales channel attached.

## Selling

- ONLINE STORE — where customers browse and buy. ONE online store per account, appearing on more than one surface: the website and the WeChat mini-program today, others later. The surfaces are windows onto the same shop, not separate shops. An account sets its shop up ONCE; products, prices, stock and presentation are the same on every surface. Adding a future surface adds a window, not another shop to configure. Read-only with respect to the modules — it displays what staff maintain and never edits it.
- CUSTOMER — a person who buys from an account's online store. The plain word ALWAYS means this. Never "shopper", and never "user" — a USER works for an account and logs into an app.
- SALES CHANNEL — a way customers buy. Attached to a location. Configured per business; not a fixed list.
- ORDER — one customer purchase. One record regardless of channel.
- GZGROCERY — the sales channel operated with the Guangzhou grocery partner. It spans two distinct external systems: the partner's ERP (stock, product mapping, pricing, pickup drift detection) and the partner's OpenCart storefront (paid orders). Both belong to one channel and one commercial relationship.

### gzgrocery — one channel, two external systems

Tables and routes for this channel take the prefix `gzgrocery_erp_` for the partner's ERP system and `gzgrocery_shop_` for the partner's storefront. One prefix identifies the partner; the suffix identifies which external system the table mirrors.

Both halves are required. The storefront order daemon resolves store and pricing from the ERP tables, so they are one system with a shared spine, not two independent integrations.

## Stock

- STOCK — a quantity of one thing at one location. Nothing else.
- PHYSICAL — what is actually there.
- AVAILABLE — what can still be sold. Physical minus buffer minus held.
- BUFFER — stock deliberately held back from sale.
- HELD — stock committed to an order that is not yet complete.
- LEDGER — the record of every stock movement.
- RECOUNT — correcting a count to match what is on the shelf.
- TRANSFER — stock moving between two locations.

## Making things

- RECIPE — what goes in and what comes out. May produce a material or a product.
- BATCH — one run of a recipe. Confirming a batch is what moves stock.

## Buying

- SUPPLIER — who you buy from.
- PURCHASE ORDER — what was asked of a supplier.

## People

- USER — one person, one login.
- CAPABILITY — one specific thing a user is permitted to do. Permissions are made of capabilities.

## States

- Products have one state with three positions: IN SHOP, NOT IN SHOP, ARCHIVED.
- Materials have one state with two positions: IN USE, ARCHIVED.
- ARCHIVED — hidden from lists and pickers, retained in history, never deleted.

## Codes

- SKU — a product's permanent code. Never reused.
- LOCATION CODE — a location's permanent code. Generated by the system, hidden from the location form, used by integrations. Never reused.

## The system and its apps

- TACET — the product itself, and the name of its main staff app: selling, customers, orders.
- PRODUCTION — an optional MODULE within Tacet that adds materials handling. Never a separate app; none will be built, so there is no merge to perform. Tenants who enable it gain screens; tenants who do not see nothing. Not to be confused with the PRODUCTION flag on a location. Defined in full as PRODUCTION MODULE below. **Replaces the earlier definition — "the staff app for making things, merges into Tacet later" — which §28 of the consolidation decisions record made false on 2026-08-24.**
- PRODUCTION MODULE — the optional module that adds materials handling to Tacet. Phase 1 adds Materials and extends Purchases. Recipes are planned for a later phase. Not an app; not a separate product; not built for Roots.
- ONLINE STORE — customers. Defined in full under Selling.
- BACK OFFICE — Tacet's own staff app, for running Tacet itself. Separate login. Nothing in it is ever shown to an account.
- MODULE — one shared piece of the back end, built once and used by any front end. Locations, Products, Materials, Stock, Users, Orders, Purchasing and Recipes are modules; more will be named.
- ACCOUNT — one business using Tacet. A company signing up creates a Tacet account. It holds the apps it uses, its users, its settings, its plan and its invoices, and its own settings: language, currency, units of measure, time zone, sales channels. "Business" remains acceptable as the everyday word in prose, but ACCOUNT is the term for the record in the system.
- ACCOUNT SETTINGS — where an account is managed from inside the apps: plan, invoices, users, business settings, and each user's own personal settings. Reached the same way from any app.

### Two levels of customer — do not confuse them
There are two, one level apart:
- Tacet's customer is an ACCOUNT — a business paying to use Tacet.
- An account's customer is a CUSTOMER — a person buying from that account's online store.

The plain word CUSTOMER is reserved for the lower level: the person shopping. When referring to Tacet's own customers, say ACCOUNT, never "our customers".

Why this way round: the word appears constantly inside the product — customer list, customer orders, customer service — and in every case it means the person shopping. If CUSTOMER sometimes meant a business, every one of those would need qualifying.

Correct: "an account has customers." Wrong: "our customers" when an account is meant.

## Retired words — do not use

- FULL CIRCLE — the system is Tacet.
- STOREFRONT — it is the ONLINE STORE.
- STORE APP — the main app is simply Tacet.
- KITCHEN APP — now the production app.
- KITCHEN, as a location type — now the production flag.
- INGREDIENT, as a distinct entity from a material — ingredients are materials. Retired as TENANT-FACING vocabulary in particular: it excludes every non-food business. **It survives as a code identifier and is not a defect awaiting a fix** — `ingredients`, `ingredient_id` and the routes under `/api/ingredients` keep their names; the rename is deferred, per the consolidation decisions record §28.
- ITEM, as the name for a stocked thing that is never sold — the word is MATERIAL. Retired 2026-08-24 for ambiguity with PRODUCT in conversation, not because it was inaccurate. **It survives as a code identifier and is not a defect awaiting a fix** — `item_kind` and the `categories` rows that populate it keep their names.
- MARKET / RETAIL STORE, as separate concepts — both are locations.
- SHOPPER — the word is CUSTOMER.
- GUANYI — the channel is GZGROCERY. Retired 2026-08-04. Do not use it in documentation, briefs, UI copy, API paths or new code. It survives in the live schema and in stored data values pending the rename described in the consolidation decisions record.
- TENANT — the word is ACCOUNT. Retired as vocabulary: do not use it in documentation, briefs, UI copy, API paths or new code. **It survives as a code identifier AND as a physical relation name, and neither is a defect awaiting a fix.** tenant_id, tenant_users, lib/tenant-db.js and the twelve tenant_* tables keep their names, in SQLite and in Postgres alike. **The earlier reading of this entry — that they are renamed when those are rebuilt with the schema — was tried and declined.** The Postgres rebuild of 2026-08-04 did rename them; the application was never renamed with it, and on 2026-08-21 the schema was renamed back rather than the application forward. A rebuild is no longer the trigger for anything here. See §24 THE TENANT→ACCOUNT PHYSICAL RENAME IS DECLINED.
