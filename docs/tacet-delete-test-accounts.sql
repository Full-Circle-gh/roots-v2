-- ══════════════════════════════════════════════════════════════════════════
-- DELETE THE FIVE TEST ACCOUNTS — tenant ids 2, 4, 5, 6, 7
-- ══════════════════════════════════════════════════════════════════════════
--
-- ⚠️  THIS IS DESTRUCTIVE AND PERMANENT. There is no undo.
--     BACK THE DATABASE UP FIRST. Do not skip this.
--
--     The app is running and writing, so take a hot backup:
--
--       sqlite3 /root/roots-v2/data/roots.db \
--         ".backup '/root/roots-v2/data/roots-before-test-account-delete.db'"
--
--     Check the backup is real before going further:
--
--       ls -lh /root/roots-v2/data/roots-before-test-account-delete.db
--       sqlite3 /root/roots-v2/data/roots-before-test-account-delete.db \
--         "PRAGMA integrity_check;"
--
-- WHAT THIS DOES
--   Removes tenants 2, 4, 5, 6 and 7 and everything belonging to them, from
--   every table that carries a tenant_id, plus the tables hanging off their
--   operator accounts. The tenants rows themselves go last.
--
-- WHAT THIS LEAVES ALONE
--   Tenant 1 (Roots). No statement here touches it. Every DELETE names the
--   five ids, directly or through a subquery over their tenant_users rows.
--   Rows where tenant_id is NULL are also left alone — in this database NULL
--   means Roots (queries read it as COALESCE(tenant_id,1)), and a
--   platform_broadcasts row with a NULL tenant_id is a broadcast to everyone.
--   `IN (2,4,5,6,7)` never matches NULL, which is the behaviour we want.
--
-- HOW TO RUN IT
--   1. Take the backup above.
--   2. Run the PREVIEW section first (it is commented out — copy it out and
--      run it on its own). It changes nothing and shows you exactly what
--      would go.
--   3. Read the two PRE-FLIGHT CHECKS. One of them can abort the delete.
--   4. Then run this file. Use -bail. It matters — see below:
--
--        sqlite3 -bail /root/roots-v2/data/roots.db < /root/roots-v2/docs/tacet-delete-test-accounts.sql
--
--   5. Restart the app so nothing is holding a deleted account in memory:
--
--        pm2 restart roots-v2
--
--   The whole delete is one transaction. If any statement fails, nothing is
--   written — the database is left exactly as it was.
--
--   WHY -bail: on its own, the sqlite3 command line prints an error and keeps
--   going to the next statement. If one DELETE failed and the rest carried on,
--   it would reach COMMIT and save a half-finished delete — accounts gone,
--   some of their rows still there. -bail stops at the first error instead,
--   with the transaction still open, so closing the connection throws all of
--   it away. The `.bail on` line below sets the same thing from inside the
--   file, so it holds even if you forget the flag. Both are deliberate.
--   If you run this through something other than the sqlite3 command line,
--   drop the `.bail on` line (it is a command-line instruction, not SQL) and
--   make sure that tool aborts the whole transaction on the first error.
--
-- ONE STATEMENT TO DECIDE ON
--   platform_ticket_messages is not in the twenty-table list, because it has
--   no tenant_id — it hangs off platform_tickets by ticket_id, with no
--   foreign key. If we delete a test account's tickets and leave it alone,
--   its messages stay behind forever, pointing at tickets that no longer
--   exist. So this script deletes them, scoped through the tickets being
--   removed. If you would rather leave them, delete that one statement
--   (marked STEP 2 below) before running.
--
-- NOT COVERED HERE
--   tenant_signup_requests has no tenant_id — it is a lead list keyed by
--   company name and contact, written before an account exists. If these five
--   came in through the signup form, their leads are still there. Look them
--   up by company name and clear them by hand if you want them gone.
--
-- ══════════════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────────────
-- PREVIEW — run this FIRST. Read-only. Nothing here changes anything.
-- Copy the lines below, strip the leading "-- ", and run them.
-- ──────────────────────────────────────────────────────────────────────────
--
-- -- Which accounts am I about to delete? Confirm these are the test ones.
-- SELECT id, name, brand_name, status, created_at
--   FROM tenants
--  WHERE id IN (2,4,5,6,7)
--  ORDER BY id;
--
-- -- Roots must be here and must stay. Sanity check only.
-- SELECT id, name, status FROM tenants WHERE id = 1;
--
-- -- Row counts per table for the five accounts.
-- SELECT 'tenants'                       AS table_name, COUNT(*) AS rows FROM tenants                       WHERE id        IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_users',              COUNT(*) FROM tenant_users              WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'purchase_orders',           COUNT(*) FROM purchase_orders           WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'suppliers',                 COUNT(*) FROM suppliers                 WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'invoices',                  COUNT(*) FROM invoices                  WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'subscriptions',             COUNT(*) FROM subscriptions             WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'billing_subscriptions',     COUNT(*) FROM billing_subscriptions     WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'billing_invoices',          COUNT(*) FROM billing_invoices          WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'billing_reminders',         COUNT(*) FROM billing_reminders         WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_onboarding',         COUNT(*) FROM tenant_onboarding         WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_secrets',            COUNT(*) FROM tenant_secrets            WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_domains',            COUNT(*) FROM tenant_domains            WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'platform_broadcasts',       COUNT(*) FROM platform_broadcasts       WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'platform_impersonation_tokens', COUNT(*) FROM platform_impersonation_tokens WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'platform_tickets',          COUNT(*) FROM platform_tickets          WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_integrations',       COUNT(*) FROM tenant_integrations       WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'integration_help_requests', COUNT(*) FROM integration_help_requests WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'integration_sessions',      COUNT(*) FROM integration_sessions      WHERE tenant_id IN (2,4,5,6,7)
-- -- keyed to the operator accounts, not to the tenant
-- UNION ALL SELECT 'tenant_user_caps',          COUNT(*) FROM tenant_user_caps          WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7)) OR tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_user_sessions',      COUNT(*) FROM tenant_user_sessions      WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7)) OR tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_operator_push_subs', COUNT(*) FROM tenant_operator_push_subs WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7)) OR tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_user_codes',         COUNT(*) FROM tenant_user_codes         WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7))
-- UNION ALL SELECT 'tenant_user_stores',        COUNT(*) FROM tenant_user_stores        WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7))
-- -- keyed to the tickets above, not to the tenant
-- UNION ALL SELECT 'platform_ticket_messages',  COUNT(*) FROM platform_ticket_messages  WHERE ticket_id IN (SELECT id FROM platform_tickets WHERE tenant_id IN (2,4,5,6,7));


-- ──────────────────────────────────────────────────────────────────────────
-- PRE-FLIGHT CHECK 1 — the one thing that can abort the delete
--
-- expense_entries.po_id points at purchase_orders with a foreign key that has
-- NO cascade. If one of these accounts has a purchase order that an expense
-- row still refers to, deleting the order fails and the whole transaction
-- rolls back (nothing lost, but nothing done either).
--
-- Expected result: 0. If it is not 0, stop and tell me — those are money
-- records and this script deliberately does not touch them.
--
-- SELECT COUNT(*) AS blocking_expense_rows
--   FROM expense_entries
--  WHERE po_id IN (SELECT id FROM purchase_orders WHERE tenant_id IN (2,4,5,6,7));
--
-- PRE-FLIGHT CHECK 2 — cascades that will fire on their own
--
-- These children come out automatically with their parents, because their
-- foreign keys are ON DELETE CASCADE: po_line_items and invoice_pos (with
-- purchase_orders), invoice_lines and invoice_pos (with invoices),
-- supplier_documents (with suppliers). They only cascade if foreign keys are
-- switched on, which the PRAGMA below does. Count them if you want to know
-- what goes with them:
--
-- SELECT 'po_line_items' AS table_name, COUNT(*) AS rows FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE tenant_id IN (2,4,5,6,7))
-- UNION ALL SELECT 'supplier_documents', COUNT(*) FROM supplier_documents WHERE supplier_id IN (SELECT id FROM suppliers WHERE tenant_id IN (2,4,5,6,7))
-- UNION ALL SELECT 'invoice_lines', COUNT(*) FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id IN (2,4,5,6,7));
-- ──────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════
-- THE DELETE
-- ══════════════════════════════════════════════════════════════════════════

-- Stop at the first error instead of carrying on to COMMIT with a half-done
-- delete. Command-line instruction, not SQL — see WHY -bail in the header.
.bail on

-- Foreign keys are OFF by default in SQLite and this PRAGMA is IGNORED inside
-- a transaction, so it has to be set here, before BEGIN. With it on, the
-- cascades above fire and a missed child aborts the run instead of leaving a
-- dangling row.
PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ── STEP 1 — rows keyed to the operator accounts ──────────────────────────
-- These must go before tenant_users, both because their foreign keys point at
-- it and because the subquery stops resolving once those rows are gone.
--
-- tenant_user_sessions and tenant_operator_push_subs have a tenant_id too, but
-- it is nullable, so the subquery is what actually catches their rows; the
-- extra OR only picks up a row tagged to one of the five ids whose parent user
-- has already vanished. Both halves name the five accounts.

DELETE FROM tenant_user_codes
 WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7));

DELETE FROM tenant_user_stores
 WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7));

DELETE FROM tenant_user_caps
 WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7))
    OR tenant_id IN (2,4,5,6,7);

DELETE FROM tenant_user_sessions
 WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7))
    OR tenant_id IN (2,4,5,6,7);

DELETE FROM tenant_operator_push_subs
 WHERE tenant_user_id IN (SELECT id FROM tenant_users WHERE tenant_id IN (2,4,5,6,7))
    OR tenant_id IN (2,4,5,6,7);

-- ── STEP 2 — support ticket messages ──────────────────────────────────────
-- No tenant_id and no foreign key, so nothing removes these for us. Scoped
-- through the tickets being deleted in step 3. Delete this statement if you
-- would rather keep them (see the header).

DELETE FROM platform_ticket_messages
 WHERE ticket_id IN (SELECT id FROM platform_tickets WHERE tenant_id IN (2,4,5,6,7));

-- ── STEP 3 — everything keyed by tenant_id ────────────────────────────────
-- Business records first, then billing, then platform and integration rows.
-- invoices before purchase_orders so the invoice links go with the invoice.

DELETE FROM invoices                      WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM purchase_orders               WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM suppliers                     WHERE tenant_id IN (2,4,5,6,7);

DELETE FROM billing_reminders             WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM billing_invoices              WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM billing_subscriptions         WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM subscriptions                 WHERE tenant_id IN (2,4,5,6,7);

DELETE FROM tenant_onboarding             WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM tenant_secrets                WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM tenant_domains                WHERE tenant_id IN (2,4,5,6,7);

DELETE FROM platform_broadcasts           WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM platform_impersonation_tokens WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM platform_tickets              WHERE tenant_id IN (2,4,5,6,7);

DELETE FROM integration_help_requests     WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM integration_sessions          WHERE tenant_id IN (2,4,5,6,7);
DELETE FROM tenant_integrations           WHERE tenant_id IN (2,4,5,6,7);

-- ── STEP 4 — the operator accounts ────────────────────────────────────────
-- After everything keyed to them (step 1), before the tenants rows.

DELETE FROM tenant_users                  WHERE tenant_id IN (2,4,5,6,7);

-- ── STEP 5 — the accounts themselves. LAST. ───────────────────────────────

DELETE FROM tenants                       WHERE id IN (2,4,5,6,7);

COMMIT;


-- ──────────────────────────────────────────────────────────────────────────
-- AFTER — check it did what you expected. Read-only.
-- Strip the leading "-- " and run.
-- ──────────────────────────────────────────────────────────────────────────
--
-- -- Should return no rows at all.
-- SELECT id, name FROM tenants WHERE id IN (2,4,5,6,7);
--
-- -- Should return exactly Roots, untouched.
-- SELECT id, name, status FROM tenants ORDER BY id;
--
-- -- Should return no rows. Anything listed here is a leftover — tell me.
-- SELECT 'tenant_users' AS table_name, COUNT(*) AS rows FROM tenant_users WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'purchase_orders',  COUNT(*) FROM purchase_orders  WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'suppliers',        COUNT(*) FROM suppliers        WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'invoices',         COUNT(*) FROM invoices         WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_secrets',   COUNT(*) FROM tenant_secrets   WHERE tenant_id IN (2,4,5,6,7)
-- UNION ALL SELECT 'tenant_domains',   COUNT(*) FROM tenant_domains   WHERE tenant_id IN (2,4,5,6,7);
--
-- -- Nothing should be broken. Expect an empty result.
-- PRAGMA foreign_key_check;
--
-- The deleted pages stay allocated inside the file, so it will not shrink on
-- its own. Reclaiming that space is optional and rewrites the whole file —
-- do it only with the app stopped, and never inside a transaction:
--
--   pm2 stop roots-v2
--   sqlite3 /root/roots-v2/data/roots.db "VACUUM;"
--   pm2 start roots-v2
