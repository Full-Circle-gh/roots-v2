# Tacet shared-core merge — decisions record, v0.1

**2026-07-30 · A living record of what has been decided so far for the Tacet shared-core merge, so the decisions stop living in chat. The open questions in §7 are not yet decided and must not be treated as settled.**

---

## 1. Architecture target

- One backend, one database. VERIFIED ALREADY TRUE — single Express process, single SQLite file (database.js:8). The split was never at the database; it is at the table level.
- Two frontends for now: Store and Kitchen. Each frontend is the only app-specific layer.
- Every core entity exists exactly once. No duplicated tables, no sync jobs.
- The end state is a single application with one interface. Every decision here is made to make that merge cheap.

## 2. Permissions

- Permissions are per-capability, not per-frontend. A user holds capabilities; each frontend shows what that user's capabilities allow.
- Reason: a per-frontend model would have to be unpicked when the two apps merge into one interface. Capabilities survive the merge unchanged.

## 3. The product/item model

- One table underneath for every stocked thing. One record per thing.
- One switch per record: SELLABLE (yes/no).
- On-screen vocabulary is retained: non-sellable records are called ITEMS, sellable records are called PRODUCTS. This is display language only; there is one entity underneath.
- Store app shows sellable records only. Kitchen app shows everything.
- Every record may be: bought from a supplier, produced from a recipe, consumed inside another recipe, or any combination of the three. These are independent facts, not a type.
- There is no `type` column. The former four types (ingredient-only, ingredient+retail, made-and-sold, bought-and-resold) are combinations of the switches above and are not stored as a label.
- Worked cases this model must support: cashews (bought, consumed in recipes, not sold); cashew cream (produced, consumed in recipes, not sold); vegan cheese (produced, consumed in recipes, AND sold); imported jerky (bought, not consumed in recipes, sold).

## 4. Product fields

- Every field on the merged record is classified into exactly one of three groups: KITCHEN, STORE, or BOTH.
- KITCHEN = production, recipes, costing. STORE = selling and presentation. BOTH = shared, e.g. nutritional facts.
- Shared (BOTH) fields are editable from BOTH apps. There is no single owning side. DECIDED — do not reintroduce field ownership.
- The classification itself is pending the tacet-product-fields.md inventory.

## 5. Concurrent edit safety

Because shared fields are editable from both apps, the merged product record must carry:

- A version stamp. On save, the server verifies the row has not changed since the client loaded it. On mismatch, reject the save and return a plain-English message telling the user the record was changed by someone else and to reload. Never silently overwrite.
- `updated_by` and `updated_at`, surfaced in the UI next to shared fields so a user can see who last touched them and when.

This supersedes the alternative of assigning an owning side per shared field, and closes risk R11 from tacet-core-survey.md.

## 6. Production is multi-level

- A recipe may produce any record, not only a sellable one.
- Cost rolls up through levels: supplier price of a bought record feeds the cost of a produced record, which feeds the cost of the record above it.
- This is identified as the largest single piece of work in the merge.

## 7. Open questions — NOT DECIDED

- How many levels deep production chains actually go.
- Final KITCHEN/STORE/BOTH classification of every product field.
- Whether `low_stock_threshold` and `supplier_paused` are store fields or operational fields visible to kitchen — flagged as probably not store-only.
- Locations: `markets` vs `retail_stores` — not yet discussed.
- Inventory: four separate quantity stores — not yet discussed.
- Users: two user tables, two permission models — model decided (§2), migration not yet designed.
- Divergent enums, timezone handling, delete semantics — not yet discussed.
- Rollout sequence and batch order — not yet decided.

## 8. Related documents

- docs/tacet-core-survey.md — verified current-state inventory, 2026-07-30.
- docs/tacet-product-fields.md — field-level inventory (pending).
