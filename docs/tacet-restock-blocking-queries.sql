-- Eleven blocking read-only queries for the Restock / stock-movement work.
--
-- Derived 2026-09-04 from docs/tacet-consolidation-decisions.md §39 and
-- docs/tacet-stock-movement-schema.md (branch
-- claude/roots-v2-stock-movement-survey-gkss7v). Neither document wrote the
-- eleven down as a list; §39's own open items (A6, A8.8, B8 step 0) are a
-- different set, aimed at production wiring and the migration. These eleven
-- answer the four questions that gate the Restock build:
--
--   Q1  Is the warehouse its own store row, or the same row as Tianhe?   -> 1,2,3
--   Q2  Has stock ever moved through the transfer path?                   -> 4,5,6,7
--   Q3  Is stock.warehouseStoreId set anywhere?                           -> 8,9
--   Q4  Can anything create a kitchen request at all?                     -> 10,11
--
-- HOW TO RUN. On roots-v2-hk, at an INTERACTIVE prompt — one statement at a
-- time, pasted in. Do NOT pipe a heredoc through PowerShell: it fails silently
-- and returns false-empty results.
--
--     sqlite3 -readonly /root/roots-v2/data/roots.db
--     sqlite> .headers on
--     sqlite> .mode column
--
-- roots.db IS tenant 1 (Roots); lib/tenant-db.js gives every other tenant its
-- own data/tenants/<id>.db. Queries 8 and 10 are worth repeating there if any
-- other tenant is live.

.headers on
.mode column

-- ── Q1 — is the warehouse its own store row? ───────────────────────────────

-- 1. Every location row. If the warehouse is its own row it is here, beside
--    Tianhe, with its own id.
SELECT id, code, name_en, name_cn, city, district, is_active, sort_order
  FROM retail_stores
 ORDER BY id;

-- 2. Tier 2 of routes/restock.js:_resolveWarehouseStoreId — the store a
--    warehouse-role user is bound to. This is what actually decides the
--    source location today, because tier 1 always throws (query 9).
SELECT id, username, role, retail_store_id
  FROM users
 WHERE role = 'warehouse'
 ORDER BY id;

-- 3. Tier 3, the last-resort fallback — whichever active store carries the
--    most on-hand stock. Verbatim from restock.js:177-182, plus names.
SELECT rss.store_id AS id, s.code, s.name_en,
       SUM(rss.physical_qty) AS q, COUNT(*) AS stock_rows
  FROM retail_store_stock rss
  JOIN retail_stores s ON s.id = rss.store_id AND COALESCE(s.is_active,1) = 1
 GROUP BY rss.store_id
 ORDER BY q DESC;

-- ── Q2 — has stock ever moved through the transfer path? ───────────────────

-- 4. The transfer path's own ledger reasons. Empty = schema-only; the path
--    has never run to completion.
SELECT reason, COUNT(*) AS n, SUM(delta) AS net,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM retail_stock_ledger
 WHERE reason IN ('restock_transfer_out','restock_transfer_in')
 GROUP BY reason;

-- 5. Every ledger reason ever written, for contrast — distinguishes "the
--    transfer never ran" from "the ledger is empty altogether".
SELECT reason, COUNT(*) AS n,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
  FROM retail_stock_ledger
 GROUP BY reason
 ORDER BY n DESC;

-- 6. The idempotency stamp. stock_applied_at is set ONLY inside the
--    transaction that moved every line, so a non-null stamp is proof a
--    transfer completed.
SELECT COUNT(*) AS orders_total,
       SUM(stock_applied_at IS NOT NULL) AS orders_stock_applied
  FROM restock_orders;

SELECT id, rs_number, date, status,
       COALESCE(from_role,'store') AS from_role,
       COALESCE(to_role,'warehouse') AS to_role,
       stock_applied_at
  FROM restock_orders
 WHERE stock_applied_at IS NOT NULL
 ORDER BY id;

-- 7. Direction and status census — shows whether any order has ever reached
--    'prepared' or 'delivered', the two statuses that trigger the transfer.
SELECT COALESCE(from_role,'store')    AS from_role,
       COALESCE(to_role,'warehouse')  AS to_role,
       status, COUNT(*) AS n,
       MIN(date) AS first_date, MAX(date) AS last_date
  FROM restock_orders
 GROUP BY 1,2,3
 ORDER BY n DESC;

-- ── Q3 — is stock.warehouseStoreId set anywhere? ───────────────────────────

-- 8. The key §39 Ruling 3 settles on: storefront_config, read through
--    cfgValue on the tenant handle. Neighbouring keys are pulled in so an
--    empty result is distinguishable from an empty table.
SELECT key, value_json, updated_at, updated_by
  FROM storefront_config
 WHERE key LIKE 'stock.%'
    OR key LIKE 'inventory.%'
    OR key LIKE '%warehouse%'
 ORDER BY key;

-- 9. What the LIVE code on main reads instead: a `settings` table.
--    restock.js:167 wraps it in a bare try/catch, so if `settings` is absent
--    tier 1 throws on every call and is silently skipped.
SELECT name FROM sqlite_master
 WHERE type = 'table' AND name IN ('settings','storefront_config');

-- ── Q4 — can anything create a kitchen request? ────────────────────────────

-- 10. Every kitchen-direction request ever written. `purpose` is NOT NULL on
--     any request the create route accepted, because the route rejects a
--     kitchen request without one (restock.js:556-560).
SELECT id, rs_number, date, status,
       COALESCE(from_role,'store')   AS from_role,
       COALESCE(to_role,'warehouse') AS to_role,
       purpose, created_by, created_at
  FROM restock_orders
 WHERE COALESCE(to_role,'warehouse') = 'kitchen'
    OR COALESCE(from_role,'store')   = 'kitchen'
 ORDER BY id;

-- 11. Who could originate one. _inferDirection sends role 'warehouse' or
--     'admin' down the kitchen branch by default; everyone else goes
--     store -> warehouse and can never reach it.
SELECT role, COUNT(*) AS n,
       SUM(retail_store_id IS NOT NULL) AS bound_to_a_store
  FROM users
 GROUP BY role
 ORDER BY n DESC;
