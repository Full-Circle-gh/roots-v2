# Tacet glossary — v1.1 · 2026-07-31

**These are the binding definitions for Tacet. Every document, every UI string and every new identifier uses these words with these meanings. Where existing code or documentation uses a different word for the same thing, the code is what needs changing, not this list.**

---

## The work

- CONSOLIDATION — the programme of work bringing the two sides onto shared modules: one backend, one database, every core entity existing exactly once, each module built once and used by any app (`docs/tacet-consolidation-decisions.md` §1, §21). This is the name of the work. Use it in prose, in headings, in commit messages and in file names.
- MERGE — reserved, and correct in exactly three places: the `products` and `store_products` tables becoming one table; the two apps eventually becoming one interface (`docs/tacet-consolidation-decisions.md` §1); and a git branch merge. Everywhere else it is the wrong word for this work — say consolidation.

## The two apps

- STORE APP — selling, customers, orders. Surfaced as the Tacet app (see FRONT END).
- PRODUCTION APP — making things. Formerly called the kitchen app; that name is retired.

## Apps, modules and front ends

Derived from `docs/tacet-consolidation-decisions.md` §0.1 (domains and app structure) and §21 (modules).

- APP — what a business user works in, and the only unit a customer ever deals with. The Tacet app, Production and Account settings are apps. They all live at one domain and moving between them never changes it (§0.1). **A customer adds apps. A customer never sees, chooses or buys a module.** Decided 2026-07-31.
- MODULE — a shared component, built once and used by any app (§0.1, §21). There are eight: Locations, Products, Items, Stock, Users, Orders, Purchasing, Recipes. Products and Items are separate modules and must never be presented, grouped or built as one. Orders is a single module; there is no separate "sales" module. Not every front end uses every module — Items and Recipes are Production-only until the apps merge. A module is an internal building block: it has no price, no name a customer reads, and no place in the interface as a thing to be turned on.
- FRONT END — one of the four surfaces a module can be used from (§21): the Tacet app, Production, the customer storefront, and the Back Office. The storefront is not a separately maintained app — it reads the same Products, Stock and Locations modules, so what a shopper sees is the same data staff edit, never a copy.
- SECTION — a part of an app, reached as a path, not a host: `/orders`, `/products`, `/account/invoices`. One login, one session, no reload into a different application (§0.1).

## Domains

From `docs/tacet-consolidation-decisions.md` §0.1. Everything lives under `tacet.com` as a subdomain.

- `app.tacet.com` — where business users work. The Tacet app, Production and Account settings all live here. ONE domain; moving between them never changes the domain.
- `backoffice.tacet.com` — Tacet staff only. Separate login and a hard wall: nothing internal may leak into a customer-facing screen.
- `shopname.tacet.com` — each account's storefront, issued automatically at signup. The account may attach its own domain later, at which point shoppers see that instead.
- `tacet.com` — the marketing site. Reserved; not an application host.

## The things you stock

- ITEM — something held in stock and never sold. Raw materials, packaging, part-made goods. Production app only.
- PRODUCT — something sold to customers. Visible in both apps.
- Items and products are two separate lists. A thing is one or the other, never both. The bridge between them is a recipe.

## Places

- LOCATION — anywhere stock is held or selling happens. One list, one module, shared by both apps.
- PHYSICAL — a permanent location. A shop, a warehouse, a production site.
- TEMPORARY — a location with an end. A market stall, a pop-up.
- PRODUCTION (flag) — things are made at this location. May sit on any location, physical or temporary. Replaces the earlier working name "kitchen", which is retired as a type name. A business may still call the place a kitchen; that is its name, not its type.
- WAREHOUSE — not a type. A physical location with no sales channel attached.

## Selling

- SALES CHANNEL — a way customers buy. Attached to a location. Configured per business; not a fixed list.
- ORDER — one customer purchase. One record regardless of channel.

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

- RECIPE — what goes in and what comes out. May produce an item or a product.
- BATCH — one run of a recipe. Confirming a batch is what moves stock.

## Buying

- SUPPLIER — who you buy from.
- PURCHASE ORDER — what was asked of a supplier.

## People

- USER — one person, one login.
- CAPABILITY — one specific thing a user is permitted to do. Permissions are made of capabilities.

## States

- Products have one state with three positions: IN SHOP, NOT IN SHOP, ARCHIVED.
- Items have one state with two positions: IN USE, ARCHIVED.
- ARCHIVED — hidden from lists and pickers, retained in history, never deleted.

## Codes

- SKU — a product's permanent code. Never reused.
- LOCATION CODE — a location's permanent code. Generated by the system, hidden from the location form, used by integrations. Never reused.

## The customer

- BUSINESS — one company using Tacet. Holds its own settings: language, currency, units of measure, time zone, sales channels.

## Retired words — do not use

- FULL CIRCLE — the system is Tacet.
- KITCHEN APP — now the production app.
- KITCHEN, as a location type — now the production flag.
- INGREDIENT, as a distinct entity from an item — ingredients are items.
- MARKET / RETAIL STORE, as separate concepts — both are locations.
- MERGE, as a name for this programme of work — it is the CONSOLIDATION. "Merge" keeps only the three narrow meanings listed above.

---

## Changelog

**v1.1 · 2026-07-31**

- The version moved from the end of the subtitle onto the `#` title line, where it can be seen.
- Added `## The work` — CONSOLIDATION as a binding word, and MERGE as a reserved one with its three correct uses named. This file was not among the sixteen edited by the consolidation-vocabulary pass (`98efab92`); it did not define either word.
- Added `## Apps, modules and front ends` and `## Domains`, derived from `docs/tacet-consolidation-decisions.md` §0.1 and §21. The binding point: **a customer adds apps and never sees or buys a module.** That sentence is a new decision recorded on 2026-07-31 — §0.1 does not state it and no other document in `docs/` does either. It needs a governing home in `tacet-consolidation-decisions.md`.
- Added `MERGE, as a name for this programme of work` to the retired list.

**v1.0 · 2026-07-31** — first version (`66b51dec`).
