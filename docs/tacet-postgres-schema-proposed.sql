-- ===========================================================================
-- PROPOSED PostgreSQL 16 SCHEMA — Tacet / roots-v2
-- Phase 1, step C+D. PROPOSAL ONLY. Nothing here has been run.
-- Generated 2026-08-03 from the LIVE SQLite database on the box,
-- /root/roots-v2/data/roots.db, read-only. The live database is the source of
-- truth throughout; where the code disagreed, the live database won.
-- Repo at generation time: origin/main = 44648781 (HEAD identical).
-- ===========================================================================
--
-- WHAT THIS FILE IS
--
-- Every table that exists in the live database today, rewritten as PostgreSQL.
-- Three changes are applied and nothing else: money becomes whole cents, every
-- "tenant" name becomes "account", and SQLite types become real Postgres types.
-- No account-scoping column is added — that is a later phase (§24). No new
-- table, column, index or constraint is invented.
--
-- TABLE COUNT
--
-- 162 tables. This is what the live database actually holds; the brief
-- expected roughly 158. The count matches the live database exactly — it was read
-- from sqlite_master, excluding SQLite's own internal tables. There are no views.
--
-- MONEY COLUMNS CONVERTED TO WHOLE CENTS (101)
--
-- All were REAL (floating-point ¥) and are now BIGINT holding cents. BIGINT
-- rather than INTEGER because multiplying by 100 costs headroom, and lifetime
-- and settlement totals should not sit near a 21-million-yuan ceiling.
--
--   expense_entries.amount
--   guanyi_product_pricing.excel_retail
--   guanyi_product_pricing.excel_gz_price
--   gzgrocery_orders.total
--   income_entries.amount
--   ingredient_price_history.price
--   ingredients.cost_per_unit
--   ingredients.buy_price
--   invoice_lines.allocated_amount
--   invoice_pos.allocated_amount
--   invoices.amount
--   markets.daily_target
--   meituan_balance_flow.amount
--   meituan_balance_flow.balance_after
--   meituan_orders.product_total
--   meituan_orders.package_fee
--   meituan_orders.customer_paid
--   meituan_orders.customer_delivery_fee
--   meituan_orders.merchant_subsidy
--   meituan_orders.platform_subsidy
--   meituan_orders.delivery_fee_paid
--   meituan_orders.delivery_tip_paid
--   meituan_orders.ad_spend
--   meituan_orders.coupon_subsidy_paid
--   meituan_orders.insurance_fee
--   meituan_orders.commission
--   meituan_orders.partial_refund
--   meituan_orders.gross_amount
--   meituan_orders.net_to_merchant
--   meituan_settlements.bill_amount
--   miniapp_order_lines.unit_price
--   miniapp_order_lines.line_total
--   miniapp_orders.product_total
--   miniapp_orders.delivery_fee
--   miniapp_orders.income
--   miniapp_orders.refund_amount
--   miniapp_orders.coupon_discount
--   packaging_types.cost
--   po_line_items.cost_per_unit
--   po_line_items.total_cost
--   price_alerts.old_price
--   price_alerts.new_price
--   products.sell_price
--   products.retail_price
--   products.flash_price
--   products.compare_at_price
--   purchase_orders.extra_freight
--   purchase_orders.extra_tax
--   purchase_orders.extra_handling
--   recipe_cost_data.labour
--   recipe_cost_data.packaging
--   recipe_cost_data.sell_price
--   retail_checkout_quotes.subtotal
--   retail_customers.lifetime_spend
--   retail_customers.balance
--   retail_delivery_zones.base_fee
--   retail_delivery_zones.max_fee
--   retail_delivery_zones.free_threshold
--   retail_delivery_zones.packing_fee_per_item
--   retail_delivery_zones.packing_fee_cap
--   retail_delivery_zones.same_day_surcharge
--   retail_delivery_zones.weight_first_kg_fee
--   retail_delivery_zones.weight_extra_kg_fee
--   retail_lifetime_commissions.base_amount
--   retail_lifetime_commissions.commission_amount
--   retail_migration_credits.balance
--   retail_migration_unmatched.balance
--   retail_order_addons.amount
--   retail_order_addons.addon_subtotal
--   retail_order_addons.freed_shipping
--   retail_order_items.unit_price
--   retail_order_items.line_total
--   retail_orders.subtotal
--   retail_orders.shipping_fee
--   retail_orders.voucher_amount
--   retail_orders.points_amount
--   retail_orders.total
--   retail_orders.packing_fee
--   retail_orders.same_day_surcharge_fee
--   retail_orders.refund_amount_requested
--   retail_orders.refund_amount_approved
--   retail_orders.refund_amount_paid
--   retail_orders.balance_used
--   retail_orders.refund_cash_amount
--   retail_payments.amount
--   retail_payments.refunded_amount
--   retail_product_option_choices.price_delta
--   retail_referrals.reward_amount
--   retail_referrals.referee_reward_amount
--   retail_refund_events.amount
--   retail_topup_packages.amount
--   retail_topup_transactions.amount
--   retail_vouchers.min_subtotal
--   sales_entries.unit_price
--   sales_entries.total
--   store_products.sell_price
--   store_products.retail_price
--   store_products.flash_price
--   store_products.compare_at_price
--   waste_entries.cost_lost
--   waste_entries.retail_value
--
-- MONEY-LOOKING COLUMNS DELIBERATELY NOT CONVERTED (7)
--
--   retail_vouchers.value
--       POLYMORPHIC — holds ¥ when type='fixed_amount' and a percentage when
--       type='percent' (live: 5 rows fixed_amount, 7 rows percent;
--       routes/retail.js:11364-11367). Converting to cents would corrupt the
--       percent rows. Needs splitting into two columns first — decision
--       required.
--   miniapp_orders.used_points
--       Points, not currency, despite sitting in the "Money" comment block of
--       the source schema (database.js:784). No live row has a non-zero value,
--       so the data cannot settle it either. Left as a floating-point number and
--       flagged.
--   recipe_cost_data.overhead_pct
--       Percentage, not money.
--   recipe_cost_data.target_food_cost
--       Percentage (DEFAULT 30 = 30%), not money.
--   guanyi_product_pricing.discount_pct
--       Percentage, not money.
--   price_alerts.change_pct
--       Percentage, not money.
--   retail_lifetime_commissions.rate_percent
--       Percentage, not money.
--
-- ALREADY INTEGER — LEFT ALONE
--
--   billing_invoices.amount_cents               already integer cents (platform billing) — untouched
--   billing_plans.price_cents                   already integer cents (platform billing) — untouched
--   plans.price_cents                           already integer cents (legacy billing copy) — untouched
--   tenants.setup_fee_cents                     already integer cents — untouched (column moves to accounts.setup_fee_cents by the rename rule)
--   tenants.commission_rate_bps                 basis points, not an amount — untouched
--   retail_customers.points_balance             points, not money
--   retail_points_transactions.delta / .balance_afterpoints, not money
--
-- OTHER REAL COLUMNS LEFT AS DOUBLE PRECISION (not money)
--
--   quantities, weights, batch sizes, stock deltas and map coordinates — 31 columns:
--     ingredients.buy_pack_size, ingredients.pack_contents_qty,
--     kitchen_order_items.qty, market_stock.qty, market_stock_ledger.delta,
--     markets.lat, markets.lng, miniapp_order_lines.units, po_line_items.qty,
--     po_line_items.weight_kg, po_line_items.qty_received,
--     po_line_items.damaged_qty, po_line_items.stock_applied_qty,
--     production_batches.batches_made, production_batches.servings_made,
--     products.weight, recipe_ingredients.qty, recipes.batch_size,
--     recipes.serving_size, restock_items.qty_requested,
--     restock_items.qty_sent, retail_customer_addresses.lat,
--     retail_customer_addresses.lng, retail_order_items.qty,
--     retail_stores.lat, retail_stores.lng, sale_addons.qty,
--     sales_entries.qty, store_products.weight, store_products.image_aspect,
--     waste_entries.qty
--
-- TENANT -> ACCOUNT RENAMES
--
--   Tables (12):
--     tenant_domains                 -> account_domains
--     tenant_integrations            -> account_integrations
--     tenant_onboarding              -> account_onboarding
--     tenant_operator_push_subs      -> account_operator_push_subs
--     tenant_secrets                 -> account_secrets
--     tenant_signup_requests         -> account_signup_requests
--     tenant_user_caps               -> account_user_caps
--     tenant_user_codes              -> account_user_codes
--     tenant_user_sessions           -> account_user_sessions
--     tenant_user_stores             -> account_user_stores
--     tenant_users                   -> account_users
--     tenants                        -> accounts
--   Columns (25):
--     billing_invoices.tenant_id             -> billing_invoices.account_id
--     billing_reminders.tenant_id            -> billing_reminders.account_id
--     billing_subscriptions.tenant_id        -> billing_subscriptions.account_id
--     integration_help_requests.tenant_id    -> integration_help_requests.account_id
--     integration_sessions.tenant_id         -> integration_sessions.account_id
--     invoices.tenant_id                     -> invoices.account_id
--     platform_broadcasts.tenant_id          -> platform_broadcasts.account_id
--     platform_impersonation_tokens.tenant_id -> platform_impersonation_tokens.account_id
--     platform_tickets.tenant_id             -> platform_tickets.account_id
--     purchase_orders.tenant_id              -> purchase_orders.account_id
--     subscriptions.tenant_id                -> subscriptions.account_id
--     suppliers.tenant_id                    -> suppliers.account_id
--     tenant_domains.tenant_id               -> account_domains.account_id
--     tenant_integrations.tenant_id          -> account_integrations.account_id
--     tenant_onboarding.tenant_id            -> account_onboarding.account_id
--     tenant_operator_push_subs.tenant_user_id -> account_operator_push_subs.account_user_id
--     tenant_operator_push_subs.tenant_id    -> account_operator_push_subs.account_id
--     tenant_secrets.tenant_id               -> account_secrets.account_id
--     tenant_user_caps.tenant_id             -> account_user_caps.account_id
--     tenant_user_caps.tenant_user_id        -> account_user_caps.account_user_id
--     tenant_user_codes.tenant_user_id       -> account_user_codes.account_user_id
--     tenant_user_sessions.tenant_user_id    -> account_user_sessions.account_user_id
--     tenant_user_sessions.tenant_id         -> account_user_sessions.account_id
--     tenant_user_stores.tenant_user_id      -> account_user_stores.account_user_id
--     tenant_users.tenant_id                 -> account_users.account_id
--   Index names (4):
--     idx_billing_subscriptions_tenant       -> idx_billing_subscriptions_account
--     idx_subscriptions_tenant               -> idx_subscriptions_account
--     idx_tenant_domains_host                -> idx_account_domains_host
--     idx_tenant_users_login                 -> idx_account_users_login
--   No existing table or column was already called account* , so nothing collides.
--   (eleme_tokens.account, ingredients.accounting_category,
--   purchase_orders.posted_to_accounting and retail_stores.meituan_account_id are
--   unrelated words and are left exactly as they are.)
--
-- store_products
--
--   Emitted as a real, literal CREATE TABLE with all 78 columns as they stand in
--   the live database — 64 mirrored from products plus 14 store-only. The
--   boot-time PRAGMA mirroring is NOT reproduced. See the flag above that table.
--
-- LIVE DATABASE vs CODE — WHERE THEY DISAGREED
--
--   store_products: code declares no columns at all (they are generated at boot).
--     Took the live table.
--   guanyi_product_pricing (187 rows) and meituan_listing_specs (0 rows): read and
--     written by the app but declared in no file. routes/retail.js:11787 even checks
--     sqlite_master before joining guanyi_product_pricing, so the code knows it may
--     not exist. Took the live tables — both are included here.
--   plans, subscriptions, retail_product_day_baseline: exist in the live database,
--     all empty, no CREATE TABLE and no code reads them. plans/subscriptions look
--     like predecessors of billing_plans/billing_subscriptions (which have 4 and 6
--     rows and are the live ones). Took the live tables and included them, but they
--     are candidates to drop rather than migrate — flagged, not decided here.
--   16 tables have a CREATE TABLE in more than one file (matching the survey
--     count): _migrations, supplier_documents, retail_customers,
--     retail_customer_addresses, retail_auth_tokens, retail_orders,
--     retail_order_items, retail_payments, retail_product_options,
--     retail_product_option_choices, storefront_config, retail_synthetic_reviews,
--     retail_migration_credits, retail_migration_unmatched, retail_shipments,
--     retail_order_drafts. In every case the duplicates are test/seed scripts
--     (scripts/test_retail_local.js, scripts/seed_*.js, scripts/verify-*.js) or a
--     bootstrap copy, never the running definition. database.js plus the live table
--     agree; the script copies are stale. Took the live database.
--
-- TYPE TRANSLATION
--
--   INTEGER PRIMARY KEY AUTOINCREMENT  ->  INTEGER GENERATED BY DEFAULT AS IDENTITY
--     Applied to all 139 tables whose sole primary key is an INTEGER column named
--     "id" — 118 declared AUTOINCREMENT, 21 relying on SQLite's rowid alias, which
--     auto-assigns the same way. BY DEFAULT (not ALWAYS) so the later data copy can
--     still insert explicit ids.
--   TEXT PRIMARY KEY                   ->  TEXT PRIMARY KEY (16 tables, unchanged)
--   Composite primary keys             ->  table-level PRIMARY KEY (5 tables)
--   guanyi_product_pricing.product_id and gzgrocery_orders.order_id are INTEGER
--     primary keys that are NOT identities — they are natural keys carrying an id
--     from elsewhere. Left as plain primary keys.
--   DATETIME -> TIMESTAMPTZ. SQLite's CURRENT_TIMESTAMP writes UTC, so the stored
--     strings are UTC and land correctly. DEFAULT CURRENT_TIMESTAMP -> DEFAULT now().
--     All 312 DATETIME/DATE columns were scanned in the live data: every value parses
--     as ISO except one (see flags below).
--   DATE -> DATE. TEXT -> TEXT. REAL -> DOUBLE PRECISION unless it is money.
--   INTEGER -> INTEGER. No live INTEGER column holds a value beyond int32, so no
--     widening was needed.
--   INTEGER 0/1 flags -> BOOLEAN (114 columns). Each was checked against the live
--     data: no value outside 0, 1 and NULL. Defaults become false/true.
--   TEXT columns holding JSON are left TEXT, not JSONB — that would be a change
--     beyond this brief. Worth raising separately.
--
-- 0/1-ONLY COLUMNS LEFT AS INTEGER ON PURPOSE (reviewer may promote any of these)
--
--   retail_order_addons.earn_points           name reads as a points amount, values happen to be 0/1 in 15 rows
--   retail_poll_votes.awarded_points          name reads as a points amount, values happen to be 0/1 in 51 rows
--   store_business_status.sub_status          named as a status value, not a flag; only 2 live rows
--   retail_otp_codes.send_count               a counter that has not exceeded 1 yet
--   retail_email_otp_codes.send_count         a counter, table is empty
--
-- COULD NOT BE TRANSLATED CLEANLY — FLAGGED, NOT GUESSED
--
--   1. retail_vouchers.value — one column holding two different kinds of number
--      (¥ for fixed_amount vouchers, a percentage for percent vouchers). Left as
--      DOUBLE PRECISION. It needs a decision, then a split, before it can be cents.
--   2. miniapp_orders.used_points — filed under "Money" in the source schema but
--      named as points, and every live row is 0 or NULL, so the data settles
--      nothing. Left as DOUBLE PRECISION.
--   3. retail_vouchers.expires_at holds one value written as 2026/10/6 instead of
--      an ISO date. The column type is fine; that one row will need cleaning
--      before the data copy, or it will not cast.
--   4. plans, subscriptions, retail_product_day_baseline — see above. Included
--      because they exist, but nobody reads them.
--   5. No SQLite column was untyped, so nothing had to be guessed on type alone.
--
-- CONSTRAINTS AND INDEXES
--
--   Primary keys and UNIQUE constraints are inline above. 144 foreign keys
--   follow the tables as ALTER TABLE statements, so table order cannot break the
--   file. 15 unique indexes created separately in SQLite (several partial)
--   follow as well, because they enforce uniqueness and dropping them would change
--   behaviour. Nothing was added that does not already exist.
--
--   NOTE: PRAGMA foreign_keys is 0 on the live database — the foreign keys are
--   declared but not enforced today. PRAGMA foreign_key_check reports no violations,
--   so turning enforcement on in Postgres should not reject existing rows.
--
--   The 148 plain (non-unique) performance indexes are listed at the foot of this
--   file as a comment, not emitted. They belong with the phase that copies data.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------------

CREATE TABLE _migrations (
  name                           TEXT PRIMARY KEY,
  applied_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE activity_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id                        INTEGER,
  username                       TEXT,
  action                         TEXT NOT NULL,
  entity_type                    TEXT,
  entity_id                      INTEGER,
  details                        TEXT,
  ip_address                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_app_help (
  topic                          TEXT PRIMARY KEY,
  title                          TEXT,
  content                        TEXT NOT NULL,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  updated_by                     TEXT
);

CREATE TABLE ai_app_help_misses (
  topic                          TEXT PRIMARY KEY,
  hit_count                      INTEGER DEFAULT 1,
  first_at                       TIMESTAMPTZ DEFAULT now(),
  last_at                        TIMESTAMPTZ DEFAULT now(),
  last_user_id                   INTEGER,
  resolved                       BOOLEAN DEFAULT false  -- was INTEGER 0/1
);

CREATE TABLE ai_memory (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  key                            TEXT NOT NULL,
  value                          TEXT NOT NULL,
  weight                         INTEGER DEFAULT 5,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ
);

CREATE TABLE ai_report_asks (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  day                            TEXT NOT NULL,
  question                       TEXT,
  answer_json                    TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_report_reads (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cache_key                      TEXT NOT NULL,
  payload_json                   TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE billing_invoices (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  subscription_id                INTEGER,
  invoice_no                     TEXT,
  period_start                   TIMESTAMPTZ,
  period_end                     TIMESTAMPTZ,
  amount_cents                   INTEGER NOT NULL DEFAULT 0,
  currency                       TEXT NOT NULL DEFAULT 'CNY',
  status                         TEXT NOT NULL DEFAULT 'open',
  due_date                       TIMESTAMPTZ,
  paid_at                        TIMESTAMPTZ,
  provider                       TEXT,
  provider_ref                   TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  kind                           TEXT
);

CREATE TABLE billing_plans (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code                           TEXT NOT NULL,
  name                           TEXT NOT NULL,
  name_cn                        TEXT,
  price_cents                    INTEGER NOT NULL DEFAULT 0,
  currency                       TEXT NOT NULL DEFAULT 'CNY',
  billing_interval               TEXT NOT NULL DEFAULT 'month',
  features_json                  TEXT,
  is_public                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (code)
);

CREATE TABLE billing_reminders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  subscription_id                INTEGER,
  period_end                     TIMESTAMPTZ,
  milestone                      INTEGER,
  channel                        TEXT DEFAULT 'in_app',
  sent_at                        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE billing_subscriptions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  plan_id                        INTEGER,
  status                         TEXT NOT NULL DEFAULT 'trialing',
  current_period_start           TIMESTAMPTZ,
  current_period_end             TIMESTAMPTZ,
  trial_end                      TIMESTAMPTZ,
  cancel_at                      TIMESTAMPTZ,
  is_internal                    BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE categories (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind                           TEXT NOT NULL,
  name                           TEXT NOT NULL,
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE TABLE channel_status (
  channel                        TEXT NOT NULL,
  store_code                     TEXT NOT NULL,
  is_open                        BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  updated_by                     TEXT,
  PRIMARY KEY (channel, store_code)
);

CREATE TABLE delivery_jobs (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  qingyun_order_id               TEXT NOT NULL,
  retail_order_id                INTEGER,
  store_code                     TEXT NOT NULL,
  channel_name                   TEXT,
  carrier_name                   TEXT,
  waybill_id                     TEXT,
  delivery_id                    TEXT,
  rider_name                     TEXT,
  rider_phone                    TEXT,
  order_status                   INTEGER,
  delivery_status                INTEGER,
  rider_lat                      INTEGER,
  rider_lng                      INTEGER,
  rider_to_cust_m                INTEGER,
  eta_seconds                    INTEGER,
  recipient_name                 TEXT,
  recipient_phone                TEXT,
  recipient_addr                 TEXT,
  recipient_lat                  INTEGER,
  recipient_lng                  INTEGER,
  expected_delivery_at           TEXT,
  raw_order                      TEXT,
  raw_track                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  superseded                     BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  UNIQUE (qingyun_order_id)
);

CREATE TABLE eleme_order_import (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  eleme_order_id                 TEXT NOT NULL,
  retail_order_id                INTEGER,
  store_code                     TEXT NOT NULL,
  imported_at                    TIMESTAMPTZ DEFAULT now(),
  status                         TEXT NOT NULL DEFAULT 'imported',
  raw_payload                    TEXT,
  UNIQUE (eleme_order_id)
);

CREATE TABLE eleme_product_map (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  extend_code                    TEXT,
  eleme_name                     TEXT,
  item_id                        TEXT,
  spec_id                        TEXT,
  last_pushed_qty                INTEGER,
  last_pushed_at                 TIMESTAMPTZ,
  sync_enabled                   BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (retail_store_id, product_id)
);

CREATE TABLE eleme_shops (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  shop_id                        TEXT,
  shop_name                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (retail_store_id)
);

CREATE TABLE eleme_sync_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  event_type                     TEXT NOT NULL,
  status                         TEXT NOT NULL,
  detail                         TEXT,
  error_msg                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE eleme_sync_queue (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  new_qty                        INTEGER NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  processed_at                   TIMESTAMPTZ
);

CREATE TABLE eleme_tokens (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account                        TEXT NOT NULL,
  access_token                   TEXT,
  refresh_token                  TEXT,
  token_type                     TEXT,
  scope                          TEXT,
  expires_at                     INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account)
);

CREATE TABLE expense_entries (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  date                           DATE NOT NULL,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  category                       TEXT,
  description                    TEXT,
  po_id                          INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  payment_method                 TEXT,
  updated_at                     TIMESTAMPTZ
);

CREATE TABLE feedback (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  reporter_id                    INTEGER NOT NULL,
  reporter_name                  TEXT NOT NULL,
  title                          TEXT NOT NULL,
  description                    TEXT,
  category                       TEXT DEFAULT 'bug',
  status                         TEXT DEFAULT 'new',
  owner_note                     TEXT,
  page_context                   TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  seen_at                        TIMESTAMPTZ,
  done_at                        TIMESTAMPTZ
);

CREATE TABLE feedback_attachments (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  feedback_id                    INTEGER NOT NULL,
  filename                       TEXT,
  mime_type                      TEXT,
  size_bytes                     INTEGER,
  data                           TEXT NOT NULL,
  uploaded_at                    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE feedback_comment_attachments (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  comment_id                     INTEGER NOT NULL,
  filename                       TEXT,
  mime_type                      TEXT,
  size_bytes                     INTEGER,
  data                           TEXT NOT NULL,
  uploaded_at                    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE feedback_comments (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  feedback_id                    INTEGER NOT NULL,
  author_id                      INTEGER NOT NULL,
  author_name                    TEXT NOT NULL,
  author_role                    TEXT,
  body                           TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guanyi_listing_jobs (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  result_count                   INTEGER,
  error                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  completed_at                   TIMESTAMPTZ
);

CREATE TABLE guanyi_listings (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  guanyi_name                    TEXT NOT NULL,
  code                           TEXT,
  sku_id                         TEXT,
  item_id                        TEXT,
  item_sku_id                    TEXT,
  warehouse_id                   TEXT,
  warehouse_name                 TEXT,
  current_qty                    INTEGER,
  scraped_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store_code, sku_id)
);

CREATE TABLE guanyi_pickup_baseline (
  store_code                     TEXT NOT NULL,
  product_id                     INTEGER NOT NULL,
  guanyi_sku_id                  TEXT,
  baseline_qty                   INTEGER,
  acked_push_at                  TEXT,
  settle_pending                 BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  settle_target                  INTEGER,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store_code, product_id)
);

CREATE TABLE guanyi_pickup_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT,
  product_id                     INTEGER,
  guanyi_sku_id                  TEXT,
  guanyi_name                    TEXT,
  observed_qty                   INTEGER,
  baseline_qty                   INTEGER,
  drift                          INTEGER,
  inferred_pickup                INTEGER,
  tianhe_qty                     INTEGER,
  mode                           TEXT,
  action                         TEXT,
  note                           TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  resolved                       BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  resolution                     TEXT,
  resolved_at                    TIMESTAMPTZ
);

CREATE TABLE guanyi_product_map (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  guanyi_name                    TEXT,
  guanyi_code                    TEXT,
  guanyi_sku_id                  TEXT,
  guanyi_item_id                 TEXT,
  guanyi_item_sku_id             TEXT,
  last_pushed_qty                INTEGER,
  last_delta                     INTEGER,
  last_pushed_at                 TIMESTAMPTZ,
  sync_enabled                   BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (retail_store_id, product_id)
);

CREATE TABLE guanyi_product_pricing (
  product_id                     INTEGER PRIMARY KEY,
  sku                            TEXT,
  discount_pct                   DOUBLE PRECISION,  -- NOT converted to cents, see header
  excel_retail                   BIGINT,  -- money: was REAL ¥, now whole cents
  excel_gz_price                 BIGINT,  -- money: was REAL ¥, now whole cents
  source                         TEXT,
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guanyi_sync_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  event_type                     TEXT NOT NULL,
  status                         TEXT NOT NULL,
  detail                         TEXT,
  error_msg                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guanyi_sync_queue (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  new_qty                        INTEGER NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  processed_at                   TIMESTAMPTZ
);

CREATE TABLE gzgrocery_meta (
  key                            TEXT PRIMARY KEY,
  value                          TEXT
);

CREATE TABLE gzgrocery_order_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER,
  order_no                       TEXT,
  action                         TEXT,
  mode                           TEXT,
  detail                         TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE gzgrocery_orders (
  order_id                       INTEGER PRIMARY KEY,
  order_no                       TEXT,
  status                         TEXT,
  total                          BIGINT,  -- money: was REAL ¥, now whole cents
  customer                       TEXT,
  date_added                     TEXT,
  delivery_time                  TEXT,
  items_json                     TEXT,
  our_units                      INTEGER DEFAULT 0,
  decremented                    BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  reversed                       BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  mode                           TEXT,
  note                           TEXT,
  first_seen_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE income_entries (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  date                           DATE NOT NULL,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  category                       TEXT,
  description                    TEXT,
  channel                        TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  payment_method                 TEXT,
  updated_at                     TIMESTAMPTZ
);

CREATE TABLE ingredient_price_history (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ingredient_id                  INTEGER NOT NULL,
  price                          BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  buy_unit                       TEXT,
  source                         TEXT DEFAULT 'manual',
  notes                          TEXT,
  recorded_at                    TIMESTAMPTZ DEFAULT now(),
  recorded_by                    TEXT
);

CREATE TABLE ingredients (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  category                       TEXT,
  unit                           TEXT DEFAULT 'g',
  buy_unit                       TEXT DEFAULT 'kg',
  buy_pack_size                  DOUBLE PRECISION DEFAULT 1000,
  cost_per_unit                  BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  buy_price                      BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  supplier                       TEXT,
  allergens                      TEXT,
  notes                          TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  supplier_platform              TEXT,
  supplier_link                  TEXT,
  supplier_qr_data               TEXT,
  image_data                     TEXT,
  pack_contents_qty              DOUBLE PRECISION,
  pack_contents_unit             TEXT,
  accounting_category            TEXT,
  item_kind                      TEXT DEFAULT 'food',
  UNIQUE (sku)
);

CREATE TABLE integration_help_requests (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  step_key                       TEXT,
  status                         TEXT NOT NULL DEFAULT 'open',
  attempts                       INTEGER DEFAULT 0,
  last_error                     TEXT,
  note                           TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE integration_sessions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  store_code                     TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'idle',
  phone_hint                     TEXT,
  last_error                     TEXT,
  attempt_at                     TIMESTAMPTZ,
  connected_at                   TIMESTAMPTZ,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, kind, store_code)
);

CREATE TABLE invoice_lines (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_id                     INTEGER NOT NULL,
  line_id                        INTEGER NOT NULL,
  allocated_amount               BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  UNIQUE (invoice_id, line_id)
);

CREATE TABLE invoice_pos (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_id                     INTEGER NOT NULL,
  po_id                          INTEGER NOT NULL,
  allocated_amount               BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  UNIQUE (invoice_id, po_id)
);

CREATE TABLE invoices (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  supplier                       TEXT NOT NULL,
  invoice_number                 TEXT,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  date                           DATE NOT NULL,
  notes                          TEXT,
  created_by                     INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  scope                          TEXT DEFAULT 'kitchen',
  store_id                       INTEGER,
  due_date                       DATE,
  paid_at                        TIMESTAMPTZ,
  account_id                     INTEGER DEFAULT 1
);

CREATE TABLE kitchen_order_items (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ko_id                          INTEGER NOT NULL,
  ingredient_id                  INTEGER,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit                           TEXT,
  notes                          TEXT
);

CREATE TABLE kitchen_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ko_number                      TEXT NOT NULL,
  date                           DATE NOT NULL,
  status                         TEXT DEFAULT 'pending',
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  UNIQUE (ko_number)
);

CREATE TABLE market_stock (
  market_id                      INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  qty                            DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (market_id, product_id)
);

CREATE TABLE market_stock_ledger (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  market_id                      INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  delta                          DOUBLE PRECISION NOT NULL,
  reason                         TEXT NOT NULL,
  ref_table                      TEXT,
  ref_id                         INTEGER,
  user_id                        INTEGER,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE markets (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                           TEXT NOT NULL,
  name_cn                        TEXT,
  location                       TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ,
  lat                            DOUBLE PRECISION,
  lng                            DOUBLE PRECISION,
  daily_target                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  kind                           TEXT DEFAULT 'market'
);

CREATE TABLE meituan_balance_flow (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  txn_id                         TEXT,
  occurred_at                    TIMESTAMPTZ,
  type                           TEXT,
  amount                         BIGINT,  -- money: was REAL ¥, now whole cents
  balance_after                  BIGINT,  -- money: was REAL ¥, now whole cents
  status                         TEXT,
  UNIQUE (txn_id)
);

CREATE TABLE meituan_bundle_components (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  bundle_id                      INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  qty                            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (bundle_id, product_id)
);

CREATE TABLE meituan_bundles (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  meituan_name                   TEXT NOT NULL,
  max_qty                        INTEGER,
  sync_enabled                   BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  last_pushed_qty                INTEGER,
  last_pushed_at                 TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (retail_store_id, meituan_name)
);

CREATE TABLE meituan_listing_jobs (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  result_count                   INTEGER,
  error                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  completed_at                   TIMESTAMPTZ
);

CREATE TABLE meituan_listing_specs (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  listing_name                   TEXT NOT NULL,
  spu_id                         TEXT,
  spec                           TEXT,
  sku_code                       TEXT,
  sku_id                         TEXT,
  stock                          INTEGER,
  raw                            TEXT,
  scraped_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE meituan_listings (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  listing_name                   TEXT NOT NULL,
  scraped_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store_code, listing_name)
);

CREATE TABLE meituan_order_actions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_order_id                INTEGER NOT NULL,
  meituan_order_no               TEXT NOT NULL,
  store_code                     TEXT NOT NULL,
  action_type                    TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  requested_by                   TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  processed_at                   TIMESTAMPTZ,
  UNIQUE (meituan_order_no, action_type)
);

CREATE TABLE meituan_order_import (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  meituan_order_no               TEXT NOT NULL,
  retail_order_id                INTEGER,
  store_code                     TEXT NOT NULL,
  accepted_at                    TIMESTAMPTZ,
  imported_at                    TIMESTAMPTZ DEFAULT now(),
  status                         TEXT NOT NULL DEFAULT 'accepted',
  raw_payload                    TEXT,
  UNIQUE (meituan_order_no)
);

CREATE TABLE meituan_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  source_order_no                TEXT,
  ordered_at                     TIMESTAMPTZ,
  completed_at                   TIMESTAMPTZ,
  refunded_at                    TIMESTAMPTZ,
  status                         TEXT,
  delivery_method                TEXT,
  customer_payment               TEXT,
  product_total                  BIGINT,  -- money: was REAL ¥, now whole cents
  package_fee                    BIGINT,  -- money: was REAL ¥, now whole cents
  customer_paid                  BIGINT,  -- money: was REAL ¥, now whole cents
  customer_delivery_fee          BIGINT,  -- money: was REAL ¥, now whole cents
  merchant_subsidy               BIGINT,  -- money: was REAL ¥, now whole cents
  platform_subsidy               BIGINT,  -- money: was REAL ¥, now whole cents
  delivery_fee_paid              BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  delivery_tip_paid              BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  ad_spend                       BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  coupon_subsidy_paid            BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  insurance_fee                  BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  commission                     BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  partial_refund                 BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  gross_amount                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  net_to_merchant                BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  item_count                     INTEGER DEFAULT 0,
  imported_at                    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_order_no)
);

CREATE TABLE meituan_product_map (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  meituan_name                   TEXT,
  last_pushed_qty                INTEGER,
  last_pushed_at                 TIMESTAMPTZ,
  sync_enabled                   BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  meituan_sku                    TEXT,
  meituan_spu_id                 TEXT,
  meituan_sku_id                 TEXT,
  UNIQUE (retail_store_id, product_id)
);

CREATE TABLE meituan_settlements (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  settlement_id                  TEXT,
  bill_date                      DATE,
  bill_amount                    BIGINT,  -- money: was REAL ¥, now whole cents
  status                         TEXT,
  period                         TEXT,
  settled_on                     DATE,
  UNIQUE (store_id, settlement_id, bill_date)
);

CREATE TABLE meituan_stores (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source_store_id                TEXT,
  name                           TEXT,
  nickname                       TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_store_id)
);

CREATE TABLE meituan_sync_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  event_type                     TEXT NOT NULL,
  status                         TEXT NOT NULL,
  detail                         TEXT,
  error_msg                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE meituan_sync_queue (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_store_id                INTEGER NOT NULL,
  product_id                     INTEGER,
  store_code                     TEXT NOT NULL,
  new_qty                        INTEGER NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  processed_at                   TIMESTAMPTZ,
  meituan_name                   TEXT,
  bundle_id                      INTEGER,
  force                          BOOLEAN NOT NULL DEFAULT false  -- was INTEGER 0/1
);

CREATE TABLE miniapp_order_lines (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  product_id                     INTEGER,
  product_name_en                TEXT,
  product_name_cn                TEXT,
  variant_label                  TEXT,
  combine_with                   TEXT,
  units                          DOUBLE PRECISION,
  unit_price                     BIGINT,  -- money: was REAL ¥, now whole cents
  line_total                     BIGINT,  -- money: was REAL ¥, now whole cents
  refund_status                  TEXT
);

CREATE TABLE miniapp_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source_order_id                INTEGER,
  order_no                       TEXT,
  user_id                        INTEGER,
  customer_phone                 TEXT,
  customer_name                  TEXT,
  product_total                  BIGINT,  -- money: was REAL ¥, now whole cents
  delivery_fee                   BIGINT,  -- money: was REAL ¥, now whole cents
  income                         BIGINT,  -- money: was REAL ¥, now whole cents
  used_points                    DOUBLE PRECISION,  -- NOT converted to cents, see header
  refund_amount                  BIGINT,  -- money: was REAL ¥, now whole cents
  status                         TEXT,
  refund_status                  TEXT,
  payment_method                 TEXT,
  payment_no                     TEXT,
  order_date                     TIMESTAMPTZ,
  delivery_date                  TEXT,
  province                       TEXT,
  city                           TEXT,
  district                       TEXT,
  address                        TEXT,
  compound                       TEXT,
  address_details                TEXT,
  coupon_name                    TEXT,
  coupon_discount                BIGINT,  -- money: was REAL ¥, now whole cents
  referrer_phone                 TEXT,
  referrer_name                  TEXT,
  delivery_company               TEXT,
  tracking_no                    TEXT,
  pickup_store                   TEXT,
  remarks                        TEXT,
  admin_note                     TEXT,
  imported_at                    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_order_id)
);

CREATE TABLE packaging_types (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                           TEXT NOT NULL,
  name_cn                        TEXT,
  cost                           BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  created_at                     TIMESTAMPTZ DEFAULT now(),
  image_data                     TEXT
);

CREATE TABLE permissions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id                        INTEGER NOT NULL,
  dashboard                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  recipes                        BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  ingredients                    BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  products                       BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  purchases                      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  finance                        BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  sales                          BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  kitchen                        BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  waste                          BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  restock                        BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  alerts                         BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  can_delete                     BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  suppliers                      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  pos                            BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  ai                             BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  warehouse_inbox                BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  kitchen_inbox                  BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  retail                         BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  UNIQUE (user_id)
);

CREATE TABLE plans (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code                           TEXT NOT NULL,
  name                           TEXT NOT NULL,
  name_cn                        TEXT,
  price_cents                    INTEGER NOT NULL DEFAULT 0,
  currency                       TEXT NOT NULL DEFAULT 'CNY',
  billing_interval               TEXT NOT NULL DEFAULT 'month',
  features_json                  TEXT,
  is_public                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (code)
);

CREATE TABLE platform_admins (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username                       TEXT NOT NULL,
  password                       TEXT NOT NULL,
  display_name                   TEXT,
  role                           TEXT NOT NULL DEFAULT 'support',
  is_active                      BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  last_login                     TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (username)
);

CREATE TABLE platform_audit_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  actor_kind                     TEXT NOT NULL,
  actor_id                       INTEGER,
  actor_name                     TEXT,
  action                         TEXT NOT NULL,
  target_type                    TEXT,
  target_id                      TEXT,
  meta_json                      TEXT,
  ip                             TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE platform_broadcasts (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  title_en                       TEXT,
  title_cn                       TEXT,
  body_en                        TEXT,
  body_cn                        TEXT,
  level                          TEXT NOT NULL DEFAULT 'info',
  audience                       TEXT NOT NULL DEFAULT 'all',
  account_id                     INTEGER,
  active                         BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  starts_at                      TIMESTAMPTZ,
  ends_at                        TIMESTAMPTZ,
  created_by                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE platform_impersonation_tokens (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  token                          TEXT NOT NULL,
  account_id                     INTEGER NOT NULL,
  operator_id                    INTEGER NOT NULL,
  by_kind                        TEXT,
  by_id                          INTEGER,
  by_name                        TEXT,
  expires_at                     TIMESTAMPTZ NOT NULL,
  used_at                        TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (token)
);

CREATE TABLE platform_ticket_messages (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ticket_id                      INTEGER NOT NULL,
  sender_kind                    TEXT NOT NULL,
  sender_name                    TEXT,
  body                           TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE platform_tickets (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  operator_id                    INTEGER,
  operator_name                  TEXT,
  subject                        TEXT,
  status                         TEXT NOT NULL DEFAULT 'open',
  last_sender                    TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE po_line_items (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  po_id                          INTEGER NOT NULL,
  ingredient_id                  INTEGER,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit                           TEXT,
  weight_kg                      DOUBLE PRECISION,
  cost_per_unit                  BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  total_cost                     BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  expense_category               TEXT,
  sort_order                     INTEGER DEFAULT 0,
  lot_number                     TEXT,
  expiry_date                    DATE,
  qty_received                   DOUBLE PRECISION,
  tracking_number                TEXT,
  tracking_carrier               TEXT,
  damaged_qty                    DOUBLE PRECISION DEFAULT 0,
  supplier_name                  TEXT,
  purchase_channel               TEXT,
  invoice_received               BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  invoice_status                 TEXT DEFAULT 'not_received',
  no_invoice_expected            BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  store_product_id               INTEGER,
  stock_applied_qty              DOUBLE PRECISION DEFAULT 0,
  note                           TEXT
);

CREATE TABLE price_alerts (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ingredient_id                  INTEGER NOT NULL,
  old_price                      BIGINT,  -- money: was REAL ¥, now whole cents
  new_price                      BIGINT,  -- money: was REAL ¥, now whole cents
  change_pct                     DOUBLE PRECISION,  -- NOT converted to cents, see header
  is_read                        BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE production_batches (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  date                           DATE NOT NULL,
  recipe_id                      INTEGER,
  recipe_name                    TEXT NOT NULL,
  recipe_sku                     TEXT,
  batches_made                   DOUBLE PRECISION DEFAULT 1,
  servings_made                  DOUBLE PRECISION,
  staff_name                     TEXT,
  shift                          TEXT,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER
);

CREATE TABLE products (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  category                       TEXT,
  recipe_id                      INTEGER,
  status                         TEXT DEFAULT 'Active',
  sell_price                     BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  weight                         DOUBLE PRECISION,
  barcode                        TEXT,
  image_url                      TEXT,
  label_url                      TEXT,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  description_en                 TEXT,
  description_cn                 TEXT,
  free_of                        TEXT,
  image_data                     TEXT,
  label_data                     TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  external_id                    INTEGER,
  sort_order                     INTEGER DEFAULT 0,
  stock_qty                      INTEGER DEFAULT 0,
  tags                           TEXT,
  variant_group_id               INTEGER,
  variant_label                  TEXT,
  is_market                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  is_restock_only                BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  is_published                   BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  retail_price                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  retail_stock                   INTEGER DEFAULT 0,
  retail_display_order           INTEGER DEFAULT 0,
  retail_tagline                 TEXT,
  retail_description_en          TEXT,
  retail_description_cn          TEXT,
  nutrition                      TEXT,
  keywords_en                    TEXT,
  keywords_cn                    TEXT,
  tagline_en                     TEXT,
  tagline_cn                     TEXT,
  flash_price                    BIGINT,  -- money: was REAL ¥, now whole cents
  flash_starts_at                TIMESTAMPTZ,
  flash_ends_at                  TIMESTAMPTZ,
  flash_stock_limit              INTEGER,
  flash_sold                     INTEGER DEFAULT 0,
  ship_modes                     TEXT DEFAULT 'air,land',
  needs_ice_pack                 BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  description_blocks             TEXT,
  colophon_character             TEXT,
  colophon_tagline_en            TEXT,
  colophon_tagline_cn            TEXT,
  compare_at_price               BIGINT,  -- money: was REAL ¥, now whole cents
  images                         TEXT,
  description_format             TEXT DEFAULT 'plain',
  variant_sort                   INTEGER DEFAULT 0,
  bundle                         TEXT,
  use_block_design               BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  is_batch_made                  BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  top_category                   TEXT,
  subcategory                    TEXT,
  page_template                  TEXT,
  ship_from_supplier             BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  oos_policy                     TEXT,
  UNIQUE (sku)
);

CREATE TABLE purchase_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  po_number                      TEXT NOT NULL,
  date                           DATE NOT NULL,
  delivery_date                  DATE,
  status                         TEXT DEFAULT 'Requested',
  warehouse                      TEXT,
  supplier                       TEXT,
  notes                          TEXT,
  posted_to_accounting           BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  source                         TEXT DEFAULT 'manual',
  backorder_of                   INTEGER,
  no_invoice_expected            BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  scope                          TEXT DEFAULT 'kitchen',
  store_id                       INTEGER,
  extra_freight                  BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  extra_tax                      BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  extra_handling                 BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  account_id                     INTEGER DEFAULT 1,
  UNIQUE (po_number)
);

CREATE TABLE push_subscriptions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id                        INTEGER NOT NULL,
  endpoint                       TEXT NOT NULL,
  p256dh                         TEXT NOT NULL,
  auth                           TEXT NOT NULL,
  user_agent                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_seen_at                   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qingyun_push_queue (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  retail_order_id                INTEGER NOT NULL,
  store_code                     TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  qingyun_order_id               TEXT,
  attempts                       INTEGER NOT NULL DEFAULT 0,
  last_error                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  stale_qingyun_order_id         TEXT,
  stale_store_code               TEXT,
  UNIQUE (retail_order_id)
);

CREATE TABLE qingyun_status (
  store_code                     TEXT PRIMARY KEY,
  logged_in                      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  last_ok                        TIMESTAMPTZ,
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qingyun_sync_log (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_code                     TEXT NOT NULL,
  event_type                     TEXT NOT NULL,
  status                         TEXT NOT NULL,
  detail                         TEXT,
  error_msg                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE recipe_cost_data (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  recipe_id                      INTEGER NOT NULL,
  labour                         BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  packaging                      BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  packaging_type_id              INTEGER,
  overhead_pct                   DOUBLE PRECISION DEFAULT 0,  -- NOT converted to cents, see header
  sell_price                     BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  target_food_cost               DOUBLE PRECISION DEFAULT 30,  -- NOT converted to cents, see header
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (recipe_id)
);

CREATE TABLE recipe_ingredients (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  recipe_id                      INTEGER NOT NULL,
  ingredient_id                  INTEGER,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit                           TEXT DEFAULT 'g',
  notes                          TEXT,
  sort_order                     INTEGER DEFAULT 0,
  substitutes                    TEXT
);

CREATE TABLE recipe_steps (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  recipe_id                      INTEGER NOT NULL,
  step_number                    INTEGER NOT NULL,
  name                           TEXT,
  instructions                   TEXT
);

CREATE TABLE recipes (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  category                       TEXT,
  batch_size                     DOUBLE PRECISION,
  servings                       INTEGER,
  serving_size                   DOUBLE PRECISION,
  shelf_life                     TEXT,
  storage                        TEXT,
  notes                          TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  is_favorite                    BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  image_data                     TEXT,
  UNIQUE (sku)
);

CREATE TABLE restock_items (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  restock_id                     INTEGER NOT NULL,
  product_id                     INTEGER,
  product_name                   TEXT NOT NULL,
  product_cn                     TEXT,
  sku                            TEXT,
  qty_requested                  DOUBLE PRECISION NOT NULL,
  qty_sent                       DOUBLE PRECISION,
  unit                           TEXT,
  notes                          TEXT,
  is_checked                     BOOLEAN DEFAULT false  -- was INTEGER 0/1
);

CREATE TABLE restock_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  rs_number                      TEXT NOT NULL,
  date                           DATE NOT NULL,
  status                         TEXT DEFAULT 'draft',
  store_name                     TEXT,
  store_cn                       TEXT,
  notes                          TEXT,
  wh_notes                       TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  sent_at                        TIMESTAMPTZ,
  received_at                    TIMESTAMPTZ,
  prepared_at                    TIMESTAMPTZ,
  delivered_at                   TIMESTAMPTZ,
  created_by                     INTEGER,
  from_role                      TEXT DEFAULT 'store',
  to_role                        TEXT DEFAULT 'warehouse',
  purpose                        TEXT,
  archived_at                    TIMESTAMPTZ,
  stock_applied_at               TIMESTAMPTZ,
  UNIQUE (rs_number)
);

CREATE TABLE retail_article_views (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  block_id                       TEXT NOT NULL,
  kind                           TEXT NOT NULL DEFAULT 'impression',
  viewer_key                     TEXT NOT NULL,
  day                            TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_auth_tokens (
  token                          TEXT PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  expires_at                     TIMESTAMPTZ NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_used_at                   TIMESTAMPTZ,
  user_agent                     TEXT
);

CREATE TABLE retail_broadcasts (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  title_en                       TEXT,
  title_cn                       TEXT,
  body_en                        TEXT,
  body_cn                        TEXT,
  deeplink                       TEXT,
  audience                       TEXT NOT NULL DEFAULT 'all_active',
  scheduled_for                  TIMESTAMPTZ,
  sent_at                        TIMESTAMPTZ,
  recipient_count                INTEGER DEFAULT 0,
  status                         TEXT NOT NULL DEFAULT 'scheduled',
  created_by                     INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_checkout_quotes (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER,
  openid                         TEXT,
  item_count                     INTEGER DEFAULT 0,
  subtotal                       BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  items_json                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_client_logs (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER,
  openid                         TEXT,
  kind                           TEXT,
  page                           TEXT,
  message                        TEXT,
  stack                          TEXT,
  app_version                    TEXT,
  platform                       TEXT,
  device_model                   TEXT,
  system                         TEXT,
  wx_version                     TEXT,
  lib_version                    TEXT,
  scene                          INTEGER,
  extra                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_customer_addresses (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  recipient_name                 TEXT NOT NULL,
  phone                          TEXT NOT NULL,
  province                       TEXT,
  city                           TEXT,
  district                       TEXT,
  address                        TEXT NOT NULL,
  detail                         TEXT,
  postal_code                    TEXT,
  is_default                     BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  lat                            DOUBLE PRECISION,
  lng                            DOUBLE PRECISION,
  geocoded_at                    TIMESTAMPTZ,
  province_en                    TEXT,
  city_en                        TEXT,
  district_en                    TEXT
);

CREATE TABLE retail_customer_favorites (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_id, product_id)
);

CREATE TABLE retail_customer_vouchers (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  voucher_id                     INTEGER NOT NULL,
  granted_at                     TIMESTAMPTZ DEFAULT now(),
  granted_by                     INTEGER,
  granted_note                   TEXT,
  used_at                        TIMESTAMPTZ,
  used_order_id                  INTEGER,
  UNIQUE (customer_id, voucher_id)
);

CREATE TABLE retail_customers (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  openid                         TEXT NOT NULL,
  unionid                        TEXT,
  nickname                       TEXT,
  avatar_url                     TEXT,
  phone                          TEXT,
  email                          TEXT,
  gender                         INTEGER,
  birthday                       DATE,
  tier_key                       TEXT DEFAULT 'seed',
  lifetime_spend                 BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  points_balance                 INTEGER DEFAULT 0,
  coupon_count                   INTEGER DEFAULT 0,
  balance                        BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  is_blocked                     BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_login_at                  TIMESTAMPTZ,
  referral_code                  TEXT,
  referred_by_customer_id        INTEGER,
  referral_applied_at            TIMESTAMPTZ,
  source                         TEXT,
  created_by                     INTEGER,
  seen_at                        TIMESTAMPTZ,
  UNIQUE (openid)
);

CREATE TABLE retail_delivery_zones (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  zone_type                      TEXT NOT NULL,
  name_en                        TEXT,
  name_cn                        TEXT,
  match_city                     TEXT,
  match_district                 TEXT,
  base_fee                       BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  max_fee                        BIGINT,  -- money: was REAL ¥, now whole cents
  free_threshold                 BIGINT,  -- money: was REAL ¥, now whole cents
  packing_fee_per_item           BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  packing_fee_cap                BIGINT,  -- money: was REAL ¥, now whole cents
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  preferred_store_id             INTEGER,
  same_day_allowed               BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  same_day_surcharge             BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  min_lead_days                  INTEGER DEFAULT 0,
  max_lead_days                  INTEGER DEFAULT 14,
  slot_start_hour                INTEGER DEFAULT 10,
  slot_end_hour                  INTEGER DEFAULT 20,
  slot_duration_minutes          INTEGER DEFAULT 120,
  day_only                       BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  weight_first_kg_fee            BIGINT,  -- money: was REAL ¥, now whole cents
  weight_extra_kg_fee            BIGINT  -- money: was REAL ¥, now whole cents
);

CREATE TABLE retail_email_otp_codes (
  email                          TEXT PRIMARY KEY,
  code                           TEXT NOT NULL,
  expires_at                     TIMESTAMPTZ NOT NULL,
  attempts                       INTEGER DEFAULT 0,
  send_count                     INTEGER DEFAULT 0,
  last_sent_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_feedback (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  customer_name                  TEXT,
  message                        TEXT NOT NULL,
  photos_json                    TEXT,
  page_context                   TEXT,
  app_version                    TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_customer_msg_at           TIMESTAMPTZ,
  last_admin_msg_at              TIMESTAMPTZ,
  admin_read_at                  TIMESTAMPTZ,
  customer_read_at               TIMESTAMPTZ,
  initiated_by                   TEXT DEFAULT 'customer',
  root_author_name               TEXT,
  kind                           TEXT DEFAULT 'bug'
);

CREATE TABLE retail_feedback_messages (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  feedback_id                    INTEGER NOT NULL,
  author                         TEXT NOT NULL,
  author_name                    TEXT,
  body                           TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_lifetime_commissions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  referrer_id                    INTEGER NOT NULL,
  customer_id                    INTEGER NOT NULL,
  base_amount                    BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  rate_percent                   DOUBLE PRECISION NOT NULL DEFAULT 0,  -- NOT converted to cents, see header
  commission_amount              BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  reversed_at                    TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (order_id)
);

CREATE TABLE retail_media (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  filename                       TEXT,
  mime_type                      TEXT NOT NULL,
  size_bytes                     INTEGER NOT NULL,
  width                          INTEGER,
  height                         INTEGER,
  data                           TEXT NOT NULL,
  uploaded_by                    INTEGER,
  uploaded_at                    TIMESTAMPTZ DEFAULT now(),
  alt_text                       TEXT,
  tags                           TEXT DEFAULT '[]',
  folder_id                      INTEGER,
  sec_status                     TEXT,
  sec_trace_id                   TEXT,
  sec_checked_at                 TIMESTAMPTZ
);

CREATE TABLE retail_media_folders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                           TEXT NOT NULL,
  parent_id                      INTEGER,
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_migration_credits (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  phone                          TEXT NOT NULL,
  balance                        BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  points                         INTEGER NOT NULL DEFAULT 0,
  source_uid                     TEXT,
  name                           TEXT,
  claimed_at                     TIMESTAMPTZ,
  claimed_customer_id            INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (phone)
);

CREATE TABLE retail_migration_unmatched (
  uid                            TEXT PRIMARY KEY,
  name                           TEXT,
  balance                        BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  points                         INTEGER NOT NULL DEFAULT 0,
  credited_at                    TIMESTAMPTZ,
  credited_customer_id           INTEGER,
  note                           TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_notifications (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  category                       TEXT NOT NULL,
  type                           TEXT NOT NULL,
  title_en                       TEXT,
  title_cn                       TEXT,
  body_en                        TEXT,
  body_cn                        TEXT,
  ref_type                       TEXT,
  ref_id                         TEXT,
  read_at                        TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  broadcast_id                   INTEGER
);

CREATE TABLE retail_oauth_states (
  id                             TEXT PRIMARY KEY,
  kind                           TEXT NOT NULL,
  provider                       TEXT,
  return_to                      TEXT,
  auth_token                     TEXT,
  expires_at                     TIMESTAMPTZ NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_order_addons (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  customer_id                    INTEGER NOT NULL,
  items_json                     TEXT NOT NULL,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  earn_points                    INTEGER NOT NULL DEFAULT 0,
  payment_method                 TEXT,
  status                         TEXT DEFAULT 'pending',
  out_trade_no                   TEXT,
  transaction_id                 TEXT,
  raw_callback_json              TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  paid_at                        TIMESTAMPTZ,
  addon_subtotal                 BIGINT,  -- money: was REAL ¥, now whole cents
  freed_shipping                 BIGINT DEFAULT 0  -- money: was REAL ¥, now whole cents
);

CREATE TABLE retail_order_drafts (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_by                     INTEGER NOT NULL,
  owner_realm                    TEXT NOT NULL,
  payload                        TEXT NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_order_items (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  product_id                     INTEGER,
  name_en                        TEXT,
  name_cn                        TEXT,
  sku                            TEXT,
  size                           TEXT,
  image_url                      TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit_price                     BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  line_total                     BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  options_json                   TEXT,
  ship_modes                     TEXT,
  needs_ice_pack                 BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  shipment_id                    INTEGER,
  replaced_for_product_id        INTEGER,
  addon_id                       INTEGER,
  ship_from_supplier             BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  refunded_qty                   INTEGER DEFAULT 0
);

CREATE TABLE retail_orders (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_no                       TEXT NOT NULL,
  customer_id                    INTEGER,
  status                         TEXT NOT NULL DEFAULT 'pending_payment',
  payment_method                 TEXT,
  recipient_name                 TEXT,
  recipient_phone                TEXT,
  address_full                   TEXT,
  address_json                   TEXT,
  subtotal                       BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  shipping_fee                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  voucher_code                   TEXT,
  voucher_amount                 BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  points_used                    INTEGER DEFAULT 0,
  points_amount                  BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  total                          BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  customer_note                  TEXT,
  needs_cutlery                  BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  needs_invoice                  BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  invoice_title                  TEXT,
  invoice_tax_id                 TEXT,
  staff_note                     TEXT,
  cancelled_reason               TEXT,
  placed_at                      TIMESTAMPTZ DEFAULT now(),
  paid_at                        TIMESTAMPTZ,
  preparing_at                   TIMESTAMPTZ,
  dispatched_at                  TIMESTAMPTZ,
  delivered_at                   TIMESTAMPTZ,
  cancelled_at                   TIMESTAMPTZ,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  refund_requested_at            TIMESTAMPTZ,
  refund_reason                  TEXT,
  refund_status                  TEXT,
  refund_review_note             TEXT,
  packing_fee                    BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  delivery_mode                  TEXT,
  delivery_zone_id               INTEGER,
  points_earned                  INTEGER DEFAULT 0,
  store_id                       INTEGER,
  routing_reason                 TEXT,
  channel                        TEXT DEFAULT 'wechat',
  scheduled_for                  TIMESTAMPTZ,
  delivery_slot_label            TEXT,
  same_day_surcharge_fee         BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  tracking_carrier               TEXT,
  tracking_number                TEXT,
  tracking_status                TEXT,
  tracking_events_json           TEXT,
  tracking_synced_at             TIMESTAMPTZ,
  tracking_last_error            TEXT,
  tracking_kd100_subscribed      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  tracking_scenario              TEXT,
  tracking_scenario_data_json    TEXT,
  tracking_scenario_notified     TEXT,
  fallback_choice                TEXT,
  awaiting_restock_pids          TEXT,
  refund_amount_requested        BIGINT,  -- money: was REAL ¥, now whole cents
  refund_amount_approved         BIGINT,  -- money: was REAL ¥, now whole cents
  refund_amount_paid             BIGINT,  -- money: was REAL ¥, now whole cents
  refund_lines_json              TEXT,
  refund_payout_method           TEXT,
  refund_payout_ref              TEXT,
  refund_reviewed_at             TIMESTAMPTZ,
  refund_approved_at             TIMESTAMPTZ,
  refund_paid_at                 TIMESTAMPTZ,
  refund_reviewer_id             INTEGER,
  refund_payer_id                INTEGER,
  seen_at                        TIMESTAMPTZ,
  invoice_type                   TEXT,
  invoice_email                  TEXT,
  invoice_status                 TEXT,
  invoice_file_url               TEXT,
  invoice_number                 TEXT,
  invoice_issued_at              TIMESTAMPTZ,
  idempotency_key                TEXT,
  fulfillment_type               TEXT DEFAULT 'delivery',
  promised_ship_date             TEXT,
  promised_delivery_date         TEXT,
  print_status                   TEXT,
  printed_at                     TIMESTAMPTZ,
  print_error                    TEXT,
  reminder_ship_sent_at          TIMESTAMPTZ,
  reminder_pickup_sent_at        TIMESTAMPTZ,
  delivery_slot_kind             TEXT,
  invoice_serial                 TEXT,
  invoice_auto_error             TEXT,
  fulfillment_short_pids         TEXT,
  sms_delivered_sent_at          TIMESTAMPTZ,
  alipay_proof_image             TEXT,
  alipay_proof_at                TIMESTAMPTZ,
  alipay_ocr_verdict             TEXT,
  alipay_ocr_json                TEXT,
  alipay_txn_id                  TEXT,
  alipay_proof_hash              TEXT,
  balance_used                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  refund_cash_amount             BIGINT,  -- money: was REAL ¥, now whole cents
  wx_shipping_uploaded_at        TIMESTAMPTZ,
  wx_shipping_status             TEXT,
  channel_status                 TEXT,
  channel_status_at              TIMESTAMPTZ,
  channel_eta                    TIMESTAMPTZ,
  wx_shipping_attempts           INTEGER DEFAULT 0,
  source                         TEXT,
  created_by                     INTEGER,
  pay_token                      TEXT,
  routed_by_distance             BOOLEAN,  -- was INTEGER 0/1
  reroute_short_pids             TEXT,
  channel_stock_restored         BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  address_changed_at             TIMESTAMPTZ,
  channel_preorder_at            TIMESTAMPTZ,
  wx_shipping_locked_at          TIMESTAMPTZ,
  UNIQUE (order_no)
);

CREATE TABLE retail_otp_codes (
  phone                          TEXT PRIMARY KEY,
  code                           TEXT NOT NULL,
  expires_at                     TIMESTAMPTZ NOT NULL,
  attempts                       INTEGER DEFAULT 0,
  send_count                     INTEGER DEFAULT 0,
  last_sent_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_page_templates (
  id                             TEXT PRIMARY KEY,
  label_en                       TEXT NOT NULL,
  label_cn                       TEXT NOT NULL,
  desc_en                        TEXT DEFAULT '',
  desc_cn                        TEXT DEFAULT '',
  blocks                         TEXT NOT NULL DEFAULT '[]',
  skin_css                       TEXT DEFAULT '',
  created_by                     INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_payments (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  method                         TEXT NOT NULL,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  status                         TEXT DEFAULT 'pending',
  transaction_id                 TEXT,
  out_trade_no                   TEXT,
  qr_image_url                   TEXT,
  raw_callback_json              TEXT,
  refunded_amount                BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  created_at                     TIMESTAMPTZ DEFAULT now(),
  completed_at                   TIMESTAMPTZ
);

CREATE TABLE retail_points_transactions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  delta                          INTEGER NOT NULL,
  balance_after                  INTEGER NOT NULL,
  source                         TEXT NOT NULL,
  order_id                       INTEGER,
  topup_id                       INTEGER,
  note                           TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  expires_at                     TIMESTAMPTZ,
  expired_at                     TIMESTAMPTZ
);

CREATE TABLE retail_poll_options (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  poll_id                        INTEGER NOT NULL,
  label_en                       TEXT NOT NULL,
  label_cn                       TEXT,
  color_hex                      TEXT,
  image_url                      TEXT,
  sort_order                     INTEGER NOT NULL DEFAULT 0,
  votes                          INTEGER NOT NULL DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_poll_votes (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  poll_id                        INTEGER NOT NULL,
  option_id                      INTEGER NOT NULL,
  customer_id                    INTEGER NOT NULL,
  awarded_points                 INTEGER NOT NULL DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (poll_id, customer_id)
);

CREATE TABLE retail_polls (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  question_en                    TEXT NOT NULL,
  question_cn                    TEXT,
  explainer_en                   TEXT,
  explainer_cn                   TEXT,
  category_en                    TEXT,
  category_cn                    TEXT,
  status                         TEXT NOT NULL DEFAULT 'draft',
  closes_at                      TIMESTAMPTZ,
  reward_points                  INTEGER NOT NULL DEFAULT 5,
  is_featured                    BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  sort_order                     INTEGER NOT NULL DEFAULT 0,
  total_votes                    INTEGER NOT NULL DEFAULT 0,
  winner_option_id               INTEGER,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  display_min_total              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE retail_product_day_baseline (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id                     INTEGER NOT NULL,
  day                            TEXT NOT NULL,
  snapshot_json                  TEXT NOT NULL,
  product_name                   TEXT,
  edited_by                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_product_option_choices (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  option_id                      INTEGER NOT NULL,
  label_en                       TEXT NOT NULL,
  label_cn                       TEXT,
  price_delta                    BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  is_default                     BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  stock_product_id               INTEGER
);

CREATE TABLE retail_product_options (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id                     INTEGER NOT NULL,
  question_en                    TEXT NOT NULL,
  question_cn                    TEXT,
  type                           TEXT NOT NULL DEFAULT 'single',
  is_required                    BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_product_substitutes (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id                     INTEGER NOT NULL,
  substitute_product_id          INTEGER NOT NULL,
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_id, substitute_product_id)
);

CREATE TABLE retail_product_versions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id                     INTEGER NOT NULL,
  snapshot_json                  TEXT NOT NULL,
  is_baseline                    BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  edited_by                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_referrals (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  referrer_id                    INTEGER NOT NULL,
  invitee_id                     INTEGER NOT NULL,
  code_used                      TEXT,
  status                         TEXT NOT NULL DEFAULT 'joined',
  reward_amount                  BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  first_paid_order_id            INTEGER,
  joined_at                      TIMESTAMPTZ DEFAULT now(),
  rewarded_at                    TIMESTAMPTZ,
  voided_at                      TIMESTAMPTZ,
  voided_reason                  TEXT,
  referee_reward_amount          BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  UNIQUE (invitee_id)
);

CREATE TABLE retail_refund_events (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  event                          TEXT NOT NULL,
  amount                         BIGINT,  -- money: was REAL ¥, now whole cents
  note                           TEXT,
  user_id                        INTEGER,
  customer_id                    INTEGER,
  meta_json                      TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_reviews (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  order_id                       INTEGER NOT NULL,
  rating                         INTEGER NOT NULL,
  comment                        TEXT,
  photos_json                    TEXT,
  is_visible                     BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  tags_json                      TEXT,
  reply                          TEXT,
  reply_at                       TIMESTAMPTZ,
  sec_hold                       BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  UNIQUE (customer_id, product_id, order_id)
);

CREATE TABLE retail_shipments (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id                       INTEGER NOT NULL,
  mode                           TEXT NOT NULL,
  label                          TEXT,
  tracking_carrier               TEXT,
  tracking_number                TEXT,
  tracking_status                TEXT,
  tracking_events_json           TEXT,
  tracking_synced_at             TIMESTAMPTZ,
  tracking_last_error            TEXT,
  tracking_kd100_subscribed      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  tracking_scenario              TEXT,
  tracking_scenario_data_json    TEXT,
  tracking_scenario_notified     TEXT,
  dispatched_at                  TIMESTAMPTZ,
  delivered_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  local_eta                      TEXT,
  eta_source                     TEXT,
  air_delay_cleared_at           TIMESTAMPTZ,
  air_delay_cleared_by           TEXT,
  package_count                  INTEGER
);

CREATE TABLE retail_stock_ledger (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  delta                          INTEGER NOT NULL,
  reason                         TEXT NOT NULL,
  ref_table                      TEXT,
  ref_id                         INTEGER,
  balance_after                  INTEGER NOT NULL,
  actor_user_id                  INTEGER,
  channel                        TEXT,
  note                           TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  actor_label                    TEXT
);

CREATE TABLE retail_stock_reservations (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  order_id                       INTEGER,
  qty                            INTEGER NOT NULL,
  channel                        TEXT NOT NULL DEFAULT 'wechat',
  status                         TEXT NOT NULL DEFAULT 'active',
  expires_at                     TIMESTAMPTZ NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  committed_at                   TIMESTAMPTZ,
  released_at                    TIMESTAMPTZ,
  note                           TEXT
);

CREATE TABLE retail_store_stock (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  store_id                       INTEGER NOT NULL,
  product_id                     INTEGER NOT NULL,
  physical_qty                   INTEGER NOT NULL DEFAULT 0,
  safety_buffer                  INTEGER NOT NULL DEFAULT 0,
  wechat_quota                   INTEGER,
  meituan_quota                  INTEGER,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  restock_target                 INTEGER,
  UNIQUE (store_id, product_id)
);

CREATE TABLE retail_stores (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code                           TEXT NOT NULL,
  name_en                        TEXT,
  name_cn                        TEXT,
  address                        TEXT,
  city                           TEXT,
  district                       TEXT,
  lat                            DOUBLE PRECISION,
  lng                            DOUBLE PRECISION,
  phone                          TEXT,
  meituan_account_id             TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  pickup_enabled                 BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  open_time                      TEXT,
  close_time                     TEXT,
  timezone                       TEXT,
  low_stock_threshold            INTEGER,
  UNIQUE (code)
);

CREATE TABLE retail_subscriptions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  template_id                    TEXT NOT NULL,
  order_id                       INTEGER,
  used                           BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  used_at                        TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_synthetic_reviews (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  product_id                     INTEGER NOT NULL,
  reviewer_name                  TEXT NOT NULL,
  rating                         INTEGER NOT NULL,
  comment                        TEXT,
  lang                           TEXT,
  tags_json                      TEXT,
  is_visible                     BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  reply                          TEXT,
  reply_at                       TIMESTAMPTZ
);

CREATE TABLE retail_topup_packages (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  bonus_points                   INTEGER NOT NULL DEFAULT 0,
  title_en                       TEXT,
  title_cn                       TEXT,
  description_en                 TEXT,
  description_cn                 TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  sort_order                     INTEGER DEFAULT 0,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_topup_transactions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER NOT NULL,
  package_id                     INTEGER,
  amount                         BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  bonus_points                   INTEGER NOT NULL DEFAULT 0,
  payment_method                 TEXT,
  status                         TEXT DEFAULT 'pending',
  out_trade_no                   TEXT,
  transaction_id                 TEXT,
  raw_callback_json              TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  paid_at                        TIMESTAMPTZ
);

CREATE TABLE retail_visits (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id                    INTEGER,
  openid                         TEXT,
  session_id                     TEXT,
  page                           TEXT,
  scene                          INTEGER,
  referrer                       TEXT,
  user_agent                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE retail_vouchers (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code                           TEXT NOT NULL,
  type                           TEXT NOT NULL DEFAULT 'fixed_amount',
  value                          DOUBLE PRECISION NOT NULL DEFAULT 0,  -- NOT converted to cents, see header
  min_subtotal                   BIGINT NOT NULL DEFAULT 0,  -- money: was REAL ¥, now whole cents
  max_uses                       INTEGER,
  used_count                     INTEGER DEFAULT 0,
  per_customer_limit             INTEGER DEFAULT 1,
  expires_at                     TIMESTAMPTZ,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  description                    TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  is_public                      BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  title_en                       TEXT,
  title_cn                       TEXT,
  auto_grant_signup              BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  auto_apply                     BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  UNIQUE (code)
);

CREATE TABLE sale_addons (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  sale_id                        INTEGER NOT NULL,
  addon_product_id               INTEGER NOT NULL,
  qty                            DOUBLE PRECISION NOT NULL DEFAULT 1,
  source                         TEXT,
  source_combine_with            TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sales_entries (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  date                           DATE NOT NULL,
  product_id                     INTEGER,
  product_name                   TEXT NOT NULL,
  channel                        TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit_price                     BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  total                          BIGINT NOT NULL,  -- money: was REAL ¥, now whole cents
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER
);

CREATE TABLE sessions (
  id                             TEXT PRIMARY KEY,
  user_id                        INTEGER NOT NULL,
  expires_at                     TIMESTAMPTZ NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE store_business_status (
  store_code                     TEXT PRIMARY KEY,
  is_open                        BOOLEAN,  -- was INTEGER 0/1
  mt_status                      INTEGER,
  sub_status                     INTEGER,
  status_desc                    TEXT,
  detail_desc                    TEXT,
  hours_desc                     TEXT,
  read_ok                        BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  read_at                        TIMESTAMPTZ,
  target_open                    BOOLEAN,  -- was INTEGER 0/1
  target_by                      TEXT,
  target_at                      TIMESTAMPTZ,
  last_result                    TEXT,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  fulfillment_open               BOOLEAN DEFAULT true  -- was INTEGER 0/1
);

-- ###########################################################################
-- store_products — WAS BOOT-GENERATED, NOW MADE LITERAL.
-- In SQLite this table has no hand-written CREATE TABLE. At every boot the app
-- reads PRAGMA table_info(products), re-emits those columns, then appends the
-- store-only ones (database.js:3646-3778). What follows is the column list as it
-- actually stands in the live database today: 78 columns = the 64 mirrored from
-- products + 14 store-only (kitchen_product_id, source_sku, synced_at, source,
-- product_facts, variant_label_cn, low_stock_threshold, bundle_items,
-- no_coupon_on_flash, image_aspect, variant_noun_en, variant_noun_cn,
-- supplier_paused, bundle_mode). Frozen here on purpose — the mirroring is NOT
-- reproduced. If products gains a column later, this table no longer follows it.
-- ###########################################################################
CREATE TABLE store_products (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name_en                        TEXT NOT NULL,
  name_cn                        TEXT,
  sku                            TEXT,
  category                       TEXT,
  recipe_id                      INTEGER,
  status                         TEXT DEFAULT 'Active',
  sell_price                     BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  weight                         DOUBLE PRECISION,
  barcode                        TEXT,
  image_url                      TEXT,
  label_url                      TEXT,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  description_en                 TEXT,
  description_cn                 TEXT,
  free_of                        TEXT,
  image_data                     TEXT,
  label_data                     TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  external_id                    INTEGER,
  sort_order                     INTEGER DEFAULT 0,
  stock_qty                      INTEGER DEFAULT 0,
  tags                           TEXT,
  variant_group_id               INTEGER,
  variant_label                  TEXT,
  is_market                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  is_restock_only                BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  is_published                   BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  retail_price                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  retail_stock                   INTEGER DEFAULT 0,
  retail_display_order           INTEGER DEFAULT 0,
  retail_tagline                 TEXT,
  retail_description_en          TEXT,
  retail_description_cn          TEXT,
  nutrition                      TEXT,
  keywords_en                    TEXT,
  keywords_cn                    TEXT,
  tagline_en                     TEXT,
  tagline_cn                     TEXT,
  flash_price                    BIGINT,  -- money: was REAL ¥, now whole cents
  flash_starts_at                TIMESTAMPTZ,
  flash_ends_at                  TIMESTAMPTZ,
  flash_stock_limit              INTEGER,
  flash_sold                     INTEGER DEFAULT 0,
  ship_modes                     TEXT DEFAULT 'air,land',
  needs_ice_pack                 BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  description_blocks             TEXT,
  colophon_character             TEXT,
  colophon_tagline_en            TEXT,
  colophon_tagline_cn            TEXT,
  compare_at_price               BIGINT,  -- money: was REAL ¥, now whole cents
  images                         TEXT,
  description_format             TEXT DEFAULT 'plain',
  variant_sort                   INTEGER DEFAULT 0,
  bundle                         TEXT,
  use_block_design               BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  is_batch_made                  BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  top_category                   TEXT,
  subcategory                    TEXT,
  page_template                  TEXT,
  kitchen_product_id             INTEGER,
  source_sku                     TEXT,
  synced_at                      TIMESTAMPTZ,
  source                         TEXT DEFAULT 'fork',
  product_facts                  TEXT,
  variant_label_cn               TEXT,
  low_stock_threshold            INTEGER,
  bundle_items                   TEXT,
  no_coupon_on_flash             BOOLEAN,  -- was INTEGER 0/1
  image_aspect                   DOUBLE PRECISION,
  ship_from_supplier             BOOLEAN,  -- was INTEGER 0/1
  oos_policy                     TEXT,
  variant_noun_en                TEXT,
  variant_noun_cn                TEXT,
  supplier_paused                BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  bundle_mode                    TEXT
);

CREATE TABLE storefront_config (
  key                            TEXT PRIMARY KEY,
  value_json                     TEXT NOT NULL,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  updated_by                     INTEGER
);

CREATE TABLE subscriptions (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  plan_id                        INTEGER,
  status                         TEXT NOT NULL DEFAULT 'trialing',
  current_period_start           TIMESTAMPTZ,
  current_period_end             TIMESTAMPTZ,
  trial_end                      TIMESTAMPTZ,
  cancel_at                      TIMESTAMPTZ,
  is_internal                    BOOLEAN DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE supplier_documents (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  supplier_id                    INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  label                          TEXT,
  filename                       TEXT,
  mime_type                      TEXT,
  size_bytes                     INTEGER,
  data                           TEXT NOT NULL,
  uploaded_at                    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE suppliers (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                           TEXT NOT NULL,
  name_cn                        TEXT,
  contact_name                   TEXT,
  contact_phone                  TEXT,
  contact_wechat                 TEXT,
  payment_terms                  TEXT,
  rating                         INTEGER DEFAULT 0,
  notes                          TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  products_supplied              TEXT,
  price_info                     TEXT,
  business_license_data          TEXT,
  permits_data                   TEXT,
  payment_qr_data                TEXT,
  channel_type                   TEXT,
  channel_link                   TEXT,
  channel_qr_data                TEXT,
  payment_method                 TEXT,
  account_id                     INTEGER DEFAULT 1,
  UNIQUE (name)
);

CREATE TABLE account_domains (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  host                           TEXT NOT NULL,
  kind                           TEXT NOT NULL DEFAULT 'subdomain',
  status                         TEXT NOT NULL DEFAULT 'active',
  is_primary                     BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_integrations (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  kind                           TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'not_configured',
  config_json                    TEXT,
  health_json                    TEXT,
  setup_state                    TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, kind)
);

CREATE TABLE account_onboarding (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  step_key                       TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'pending',
  value                          TEXT,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, step_key)
);

CREATE TABLE account_operator_push_subs (
  endpoint                       TEXT PRIMARY KEY,
  account_user_id                INTEGER NOT NULL,
  account_id                     INTEGER,
  p256dh                         TEXT NOT NULL,
  auth                           TEXT NOT NULL,
  user_agent                     TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_seen_at                   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_secrets (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  key                            TEXT NOT NULL,
  value_enc                      TEXT NOT NULL,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, key)
);

CREATE TABLE account_signup_requests (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company                        TEXT NOT NULL,
  contact_name                   TEXT,
  contact                        TEXT,
  note                           TEXT,
  status                         TEXT NOT NULL DEFAULT 'new',
  ip                             TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_user_caps (
  account_id                     INTEGER NOT NULL,
  account_user_id                INTEGER NOT NULL,
  capability_key                 TEXT NOT NULL,
  mode                           TEXT NOT NULL DEFAULT 'grant',
  updated_by                     INTEGER,
  updated_at                     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account_user_id, capability_key)
);

CREATE TABLE account_user_codes (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_user_id                INTEGER NOT NULL,
  purpose                        TEXT NOT NULL,
  email                          TEXT,
  code_hash                      TEXT NOT NULL,
  attempts                       INTEGER NOT NULL DEFAULT 0,
  used                           BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  expires_at                     TIMESTAMPTZ NOT NULL,
  created_at                     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_user_sessions (
  sid                            TEXT PRIMARY KEY,
  account_user_id                INTEGER NOT NULL,
  account_id                     INTEGER,
  user_agent                     TEXT,
  ip                             TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  last_seen                      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_user_stores (
  account_user_id                INTEGER NOT NULL,
  store_id                       INTEGER NOT NULL,
  PRIMARY KEY (account_user_id, store_id)
);

CREATE TABLE account_users (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id                     INTEGER NOT NULL,
  username                       TEXT NOT NULL,
  password                       TEXT NOT NULL,
  display_name                   TEXT,
  role                           TEXT NOT NULL DEFAULT 'staff',
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  last_login                     TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  avatar_url                     TEXT,
  retail_store_id                INTEGER,
  scope_all                      BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  recovery_email                 TEXT,
  recovery_email_verified        BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  twofa_enabled                  BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  phone                          TEXT,
  phone_verified                 BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  twofa_method                   TEXT NOT NULL DEFAULT 'email',
  twofa_email_enabled            BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  twofa_sms_enabled              BOOLEAN NOT NULL DEFAULT false  -- was INTEGER 0/1
);

CREATE TABLE accounts (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name                           TEXT NOT NULL,
  brand_name                     TEXT,
  status                         TEXT NOT NULL DEFAULT 'active',
  created_at                     TIMESTAMPTZ DEFAULT now(),
  brand_accent                   TEXT,
  wx_appid                       TEXT,
  product_catalog_mode           TEXT NOT NULL DEFAULT 'self',
  onboarding_model               TEXT,
  business_category              TEXT,
  setup_fee_cents                INTEGER,
  features_json                  TEXT,
  commission_rate_bps            INTEGER,
  rbac_enforce                   BOOLEAN NOT NULL DEFAULT false,  -- was INTEGER 0/1
  brand_logo_data                TEXT,
  brand_mark_data                TEXT,
  brand_credit                   BOOLEAN NOT NULL DEFAULT true,  -- was INTEGER 0/1
  brand_updated_at               TIMESTAMPTZ
);

CREATE TABLE users (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username                       TEXT NOT NULL,
  password                       TEXT NOT NULL,
  role                           TEXT NOT NULL DEFAULT 'kitchen',
  display_name                   TEXT,
  is_active                      BOOLEAN DEFAULT true,  -- was INTEGER 0/1
  last_login                     TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  market_id                      INTEGER,
  retail_store_id                INTEGER,
  UNIQUE (username)
);

CREATE TABLE waste_entries (
  id                             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  date                           DATE NOT NULL,
  product_id                     INTEGER,
  product_name                   TEXT NOT NULL,
  product_sku                    TEXT,
  qty                            DOUBLE PRECISION NOT NULL,
  unit                           TEXT,
  reason                         TEXT,
  cost_lost                      BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  retail_value                   BIGINT DEFAULT 0,  -- money: was REAL ¥, now whole cents
  staff_name                     TEXT,
  shift                          TEXT,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ DEFAULT now(),
  created_by                     INTEGER,
  cost_source                    TEXT
);


-- ---------------------------------------------------------------------------
-- UNIQUE INDEXES (created separately in SQLite; several are partial)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX idx_billing_reminders_unique ON billing_reminders (subscription_id, period_end, milestone);
CREATE UNIQUE INDEX idx_billing_subscriptions_account ON billing_subscriptions (account_id);
CREATE UNIQUE INDEX idx_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX idx_push_endpoint ON push_subscriptions (endpoint);
CREATE UNIQUE INDEX idx_article_views_uniq ON retail_article_views (block_id, kind, viewer_key, day);
CREATE UNIQUE INDEX idx_retail_customers_refcode ON retail_customers (referral_code) WHERE referral_code IS NOT NULL;
CREATE UNIQUE INDEX idx_retail_orders_pay_token ON retail_orders (pay_token) WHERE pay_token IS NOT NULL;
CREATE UNIQUE INDEX idx_retail_orders_idem ON retail_orders (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_retail_payments_out_trade_no ON retail_payments (out_trade_no) WHERE out_trade_no IS NOT NULL;
CREATE UNIQUE INDEX idx_product_day_baseline_uniq ON retail_product_day_baseline (product_id, day);
CREATE UNIQUE INDEX idx_store_products_barcode ON store_products (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX idx_store_products_sku ON store_products (sku);
CREATE UNIQUE INDEX idx_subscriptions_account ON subscriptions (account_id);
CREATE UNIQUE INDEX idx_account_domains_host ON account_domains (host);
CREATE UNIQUE INDEX idx_account_users_login ON account_users (account_id, username);


-- ---------------------------------------------------------------------------
-- FOREIGN KEYS (144) — applied after all tables exist
-- ---------------------------------------------------------------------------

ALTER TABLE activity_log ADD CONSTRAINT fk_activity_log_1 FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE billing_invoices ADD CONSTRAINT fk_billing_invoices_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE billing_subscriptions ADD CONSTRAINT fk_billing_subscriptions_1 FOREIGN KEY (plan_id) REFERENCES billing_plans (id);
ALTER TABLE billing_subscriptions ADD CONSTRAINT fk_billing_subscriptions_2 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE delivery_jobs ADD CONSTRAINT fk_delivery_jobs_1 FOREIGN KEY (retail_order_id) REFERENCES retail_orders (id) ON DELETE SET NULL;
ALTER TABLE eleme_order_import ADD CONSTRAINT fk_eleme_order_import_1 FOREIGN KEY (retail_order_id) REFERENCES retail_orders (id) ON DELETE SET NULL;
ALTER TABLE eleme_product_map ADD CONSTRAINT fk_eleme_product_map_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE eleme_product_map ADD CONSTRAINT fk_eleme_product_map_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE eleme_shops ADD CONSTRAINT fk_eleme_shops_1 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE eleme_sync_queue ADD CONSTRAINT fk_eleme_sync_queue_1 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE eleme_sync_queue ADD CONSTRAINT fk_eleme_sync_queue_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id);
ALTER TABLE expense_entries ADD CONSTRAINT fk_expense_entries_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE expense_entries ADD CONSTRAINT fk_expense_entries_2 FOREIGN KEY (po_id) REFERENCES purchase_orders (id);
ALTER TABLE feedback ADD CONSTRAINT fk_feedback_1 FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE feedback_attachments ADD CONSTRAINT fk_feedback_attachments_1 FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE;
ALTER TABLE feedback_comment_attachments ADD CONSTRAINT fk_feedback_comment_attachments_1 FOREIGN KEY (comment_id) REFERENCES feedback_comments (id) ON DELETE CASCADE;
ALTER TABLE feedback_comments ADD CONSTRAINT fk_feedback_comments_1 FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE feedback_comments ADD CONSTRAINT fk_feedback_comments_2 FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE;
ALTER TABLE guanyi_product_map ADD CONSTRAINT fk_guanyi_product_map_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE guanyi_product_map ADD CONSTRAINT fk_guanyi_product_map_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE guanyi_sync_queue ADD CONSTRAINT fk_guanyi_sync_queue_1 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE guanyi_sync_queue ADD CONSTRAINT fk_guanyi_sync_queue_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id);
ALTER TABLE income_entries ADD CONSTRAINT fk_income_entries_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE ingredient_price_history ADD CONSTRAINT fk_ingredient_price_history_1 FOREIGN KEY (ingredient_id) REFERENCES ingredients (id);
ALTER TABLE integration_help_requests ADD CONSTRAINT fk_integration_help_requests_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE integration_sessions ADD CONSTRAINT fk_integration_sessions_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_1 FOREIGN KEY (line_id) REFERENCES po_line_items (id) ON DELETE CASCADE;
ALTER TABLE invoice_lines ADD CONSTRAINT fk_invoice_lines_2 FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE;
ALTER TABLE invoice_pos ADD CONSTRAINT fk_invoice_pos_1 FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE;
ALTER TABLE invoice_pos ADD CONSTRAINT fk_invoice_pos_2 FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE;
ALTER TABLE kitchen_order_items ADD CONSTRAINT fk_kitchen_order_items_1 FOREIGN KEY (ingredient_id) REFERENCES ingredients (id);
ALTER TABLE kitchen_order_items ADD CONSTRAINT fk_kitchen_order_items_2 FOREIGN KEY (ko_id) REFERENCES kitchen_orders (id) ON DELETE CASCADE;
ALTER TABLE kitchen_orders ADD CONSTRAINT fk_kitchen_orders_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE market_stock ADD CONSTRAINT fk_market_stock_1 FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE;
ALTER TABLE market_stock ADD CONSTRAINT fk_market_stock_2 FOREIGN KEY (market_id) REFERENCES markets (id) ON DELETE CASCADE;
ALTER TABLE market_stock_ledger ADD CONSTRAINT fk_market_stock_ledger_1 FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE market_stock_ledger ADD CONSTRAINT fk_market_stock_ledger_2 FOREIGN KEY (product_id) REFERENCES products (id);
ALTER TABLE market_stock_ledger ADD CONSTRAINT fk_market_stock_ledger_3 FOREIGN KEY (market_id) REFERENCES markets (id);
ALTER TABLE meituan_balance_flow ADD CONSTRAINT fk_meituan_balance_flow_1 FOREIGN KEY (store_id) REFERENCES meituan_stores (id) ON DELETE CASCADE;
ALTER TABLE meituan_bundle_components ADD CONSTRAINT fk_meituan_bundle_components_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE meituan_bundle_components ADD CONSTRAINT fk_meituan_bundle_components_2 FOREIGN KEY (bundle_id) REFERENCES meituan_bundles (id) ON DELETE CASCADE;
ALTER TABLE meituan_bundles ADD CONSTRAINT fk_meituan_bundles_1 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE meituan_order_actions ADD CONSTRAINT fk_meituan_order_actions_1 FOREIGN KEY (retail_order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE meituan_order_import ADD CONSTRAINT fk_meituan_order_import_1 FOREIGN KEY (retail_order_id) REFERENCES retail_orders (id) ON DELETE SET NULL;
ALTER TABLE meituan_orders ADD CONSTRAINT fk_meituan_orders_1 FOREIGN KEY (store_id) REFERENCES meituan_stores (id) ON DELETE CASCADE;
ALTER TABLE meituan_product_map ADD CONSTRAINT fk_meituan_product_map_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE meituan_product_map ADD CONSTRAINT fk_meituan_product_map_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE meituan_settlements ADD CONSTRAINT fk_meituan_settlements_1 FOREIGN KEY (store_id) REFERENCES meituan_stores (id) ON DELETE CASCADE;
ALTER TABLE meituan_sync_queue ADD CONSTRAINT fk_meituan_sync_queue_1 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE meituan_sync_queue ADD CONSTRAINT fk_meituan_sync_queue_2 FOREIGN KEY (retail_store_id) REFERENCES retail_stores (id);
ALTER TABLE miniapp_order_lines ADD CONSTRAINT fk_miniapp_order_lines_1 FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL;
ALTER TABLE miniapp_order_lines ADD CONSTRAINT fk_miniapp_order_lines_2 FOREIGN KEY (order_id) REFERENCES miniapp_orders (id) ON DELETE CASCADE;
ALTER TABLE permissions ADD CONSTRAINT fk_permissions_1 FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE po_line_items ADD CONSTRAINT fk_po_line_items_1 FOREIGN KEY (ingredient_id) REFERENCES ingredients (id);
ALTER TABLE po_line_items ADD CONSTRAINT fk_po_line_items_2 FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE;
ALTER TABLE price_alerts ADD CONSTRAINT fk_price_alerts_1 FOREIGN KEY (ingredient_id) REFERENCES ingredients (id);
ALTER TABLE production_batches ADD CONSTRAINT fk_production_batches_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE production_batches ADD CONSTRAINT fk_production_batches_2 FOREIGN KEY (recipe_id) REFERENCES recipes (id);
ALTER TABLE products ADD CONSTRAINT fk_products_1 FOREIGN KEY (recipe_id) REFERENCES recipes (id);
ALTER TABLE purchase_orders ADD CONSTRAINT fk_purchase_orders_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE push_subscriptions ADD CONSTRAINT fk_push_subscriptions_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE qingyun_push_queue ADD CONSTRAINT fk_qingyun_push_queue_1 FOREIGN KEY (retail_order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE recipe_cost_data ADD CONSTRAINT fk_recipe_cost_data_1 FOREIGN KEY (recipe_id) REFERENCES recipes (id) ON DELETE CASCADE;
ALTER TABLE recipe_ingredients ADD CONSTRAINT fk_recipe_ingredients_1 FOREIGN KEY (ingredient_id) REFERENCES ingredients (id);
ALTER TABLE recipe_ingredients ADD CONSTRAINT fk_recipe_ingredients_2 FOREIGN KEY (recipe_id) REFERENCES recipes (id) ON DELETE CASCADE;
ALTER TABLE recipe_steps ADD CONSTRAINT fk_recipe_steps_1 FOREIGN KEY (recipe_id) REFERENCES recipes (id) ON DELETE CASCADE;
ALTER TABLE restock_items ADD CONSTRAINT fk_restock_items_1 FOREIGN KEY (product_id) REFERENCES products (id);
ALTER TABLE restock_items ADD CONSTRAINT fk_restock_items_2 FOREIGN KEY (restock_id) REFERENCES restock_orders (id) ON DELETE CASCADE;
ALTER TABLE restock_orders ADD CONSTRAINT fk_restock_orders_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE retail_auth_tokens ADD CONSTRAINT fk_retail_auth_tokens_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_checkout_quotes ADD CONSTRAINT fk_retail_checkout_quotes_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE SET NULL;
ALTER TABLE retail_client_logs ADD CONSTRAINT fk_retail_client_logs_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE SET NULL;
ALTER TABLE retail_customer_addresses ADD CONSTRAINT fk_retail_customer_addresses_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_customer_favorites ADD CONSTRAINT fk_retail_customer_favorites_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_customer_favorites ADD CONSTRAINT fk_retail_customer_favorites_2 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_customer_vouchers ADD CONSTRAINT fk_retail_customer_vouchers_1 FOREIGN KEY (granted_by) REFERENCES users (id);
ALTER TABLE retail_customer_vouchers ADD CONSTRAINT fk_retail_customer_vouchers_2 FOREIGN KEY (voucher_id) REFERENCES retail_vouchers (id) ON DELETE CASCADE;
ALTER TABLE retail_customer_vouchers ADD CONSTRAINT fk_retail_customer_vouchers_3 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_feedback ADD CONSTRAINT fk_retail_feedback_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_feedback_messages ADD CONSTRAINT fk_retail_feedback_messages_1 FOREIGN KEY (feedback_id) REFERENCES retail_feedback (id) ON DELETE CASCADE;
ALTER TABLE retail_lifetime_commissions ADD CONSTRAINT fk_retail_lifetime_commissions_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_lifetime_commissions ADD CONSTRAINT fk_retail_lifetime_commissions_2 FOREIGN KEY (referrer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_lifetime_commissions ADD CONSTRAINT fk_retail_lifetime_commissions_3 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_media ADD CONSTRAINT fk_retail_media_1 FOREIGN KEY (uploaded_by) REFERENCES users (id);
ALTER TABLE retail_media_folders ADD CONSTRAINT fk_retail_media_folders_1 FOREIGN KEY (parent_id) REFERENCES retail_media_folders (id) ON DELETE SET NULL;
ALTER TABLE retail_migration_credits ADD CONSTRAINT fk_retail_migration_credits_1 FOREIGN KEY (claimed_customer_id) REFERENCES retail_customers (id) ON DELETE SET NULL;
ALTER TABLE retail_notifications ADD CONSTRAINT fk_retail_notifications_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_order_addons ADD CONSTRAINT fk_retail_order_addons_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_order_addons ADD CONSTRAINT fk_retail_order_addons_2 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_order_items ADD CONSTRAINT fk_retail_order_items_1 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE retail_order_items ADD CONSTRAINT fk_retail_order_items_2 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_orders ADD CONSTRAINT fk_retail_orders_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE SET NULL;
ALTER TABLE retail_payments ADD CONSTRAINT fk_retail_payments_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_points_transactions ADD CONSTRAINT fk_retail_points_transactions_1 FOREIGN KEY (topup_id) REFERENCES retail_topup_transactions (id);
ALTER TABLE retail_points_transactions ADD CONSTRAINT fk_retail_points_transactions_2 FOREIGN KEY (order_id) REFERENCES retail_orders (id);
ALTER TABLE retail_points_transactions ADD CONSTRAINT fk_retail_points_transactions_3 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_poll_options ADD CONSTRAINT fk_retail_poll_options_1 FOREIGN KEY (poll_id) REFERENCES retail_polls (id) ON DELETE CASCADE;
ALTER TABLE retail_poll_votes ADD CONSTRAINT fk_retail_poll_votes_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_poll_votes ADD CONSTRAINT fk_retail_poll_votes_2 FOREIGN KEY (option_id) REFERENCES retail_poll_options (id) ON DELETE CASCADE;
ALTER TABLE retail_poll_votes ADD CONSTRAINT fk_retail_poll_votes_3 FOREIGN KEY (poll_id) REFERENCES retail_polls (id) ON DELETE CASCADE;
ALTER TABLE retail_product_option_choices ADD CONSTRAINT fk_retail_product_option_choices_1 FOREIGN KEY (option_id) REFERENCES retail_product_options (id) ON DELETE CASCADE;
ALTER TABLE retail_product_options ADD CONSTRAINT fk_retail_product_options_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_product_substitutes ADD CONSTRAINT fk_retail_product_substitutes_1 FOREIGN KEY (substitute_product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_product_substitutes ADD CONSTRAINT fk_retail_product_substitutes_2 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_referrals ADD CONSTRAINT fk_retail_referrals_1 FOREIGN KEY (first_paid_order_id) REFERENCES retail_orders (id) ON DELETE SET NULL;
ALTER TABLE retail_referrals ADD CONSTRAINT fk_retail_referrals_2 FOREIGN KEY (invitee_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_referrals ADD CONSTRAINT fk_retail_referrals_3 FOREIGN KEY (referrer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_refund_events ADD CONSTRAINT fk_retail_refund_events_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_reviews ADD CONSTRAINT fk_retail_reviews_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_reviews ADD CONSTRAINT fk_retail_reviews_2 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_reviews ADD CONSTRAINT fk_retail_reviews_3 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_shipments ADD CONSTRAINT fk_retail_shipments_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_stock_ledger ADD CONSTRAINT fk_retail_stock_ledger_1 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE retail_stock_ledger ADD CONSTRAINT fk_retail_stock_ledger_2 FOREIGN KEY (store_id) REFERENCES retail_stores (id);
ALTER TABLE retail_stock_reservations ADD CONSTRAINT fk_retail_stock_reservations_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE SET NULL;
ALTER TABLE retail_stock_reservations ADD CONSTRAINT fk_retail_stock_reservations_2 FOREIGN KEY (product_id) REFERENCES store_products (id);
ALTER TABLE retail_stock_reservations ADD CONSTRAINT fk_retail_stock_reservations_3 FOREIGN KEY (store_id) REFERENCES retail_stores (id);
ALTER TABLE retail_store_stock ADD CONSTRAINT fk_retail_store_stock_1 FOREIGN KEY (product_id) REFERENCES store_products (id) ON DELETE CASCADE;
ALTER TABLE retail_store_stock ADD CONSTRAINT fk_retail_store_stock_2 FOREIGN KEY (store_id) REFERENCES retail_stores (id) ON DELETE CASCADE;
ALTER TABLE retail_subscriptions ADD CONSTRAINT fk_retail_subscriptions_1 FOREIGN KEY (order_id) REFERENCES retail_orders (id) ON DELETE CASCADE;
ALTER TABLE retail_subscriptions ADD CONSTRAINT fk_retail_subscriptions_2 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_topup_transactions ADD CONSTRAINT fk_retail_topup_transactions_1 FOREIGN KEY (package_id) REFERENCES retail_topup_packages (id);
ALTER TABLE retail_topup_transactions ADD CONSTRAINT fk_retail_topup_transactions_2 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE CASCADE;
ALTER TABLE retail_visits ADD CONSTRAINT fk_retail_visits_1 FOREIGN KEY (customer_id) REFERENCES retail_customers (id) ON DELETE SET NULL;
ALTER TABLE retail_vouchers ADD CONSTRAINT fk_retail_vouchers_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE sale_addons ADD CONSTRAINT fk_sale_addons_1 FOREIGN KEY (addon_product_id) REFERENCES products (id);
ALTER TABLE sale_addons ADD CONSTRAINT fk_sale_addons_2 FOREIGN KEY (sale_id) REFERENCES sales_entries (id) ON DELETE CASCADE;
ALTER TABLE sales_entries ADD CONSTRAINT fk_sales_entries_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE sales_entries ADD CONSTRAINT fk_sales_entries_2 FOREIGN KEY (product_id) REFERENCES products (id);
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_1 FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_1 FOREIGN KEY (plan_id) REFERENCES plans (id);
ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_2 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE supplier_documents ADD CONSTRAINT fk_supplier_documents_1 FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE;
ALTER TABLE account_domains ADD CONSTRAINT fk_account_domains_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE account_integrations ADD CONSTRAINT fk_account_integrations_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE account_operator_push_subs ADD CONSTRAINT fk_account_operator_push_subs_1 FOREIGN KEY (account_user_id) REFERENCES account_users (id);
ALTER TABLE account_secrets ADD CONSTRAINT fk_account_secrets_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE account_user_caps ADD CONSTRAINT fk_account_user_caps_1 FOREIGN KEY (account_user_id) REFERENCES account_users (id);
ALTER TABLE account_user_codes ADD CONSTRAINT fk_account_user_codes_1 FOREIGN KEY (account_user_id) REFERENCES account_users (id);
ALTER TABLE account_user_sessions ADD CONSTRAINT fk_account_user_sessions_1 FOREIGN KEY (account_user_id) REFERENCES account_users (id);
ALTER TABLE account_user_stores ADD CONSTRAINT fk_account_user_stores_1 FOREIGN KEY (account_user_id) REFERENCES account_users (id);
ALTER TABLE account_users ADD CONSTRAINT fk_account_users_1 FOREIGN KEY (account_id) REFERENCES accounts (id);
ALTER TABLE waste_entries ADD CONSTRAINT fk_waste_entries_1 FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE waste_entries ADD CONSTRAINT fk_waste_entries_2 FOREIGN KEY (product_id) REFERENCES products (id);


-- ---------------------------------------------------------------------------
-- NOT EMITTED: 148 non-unique performance indexes that exist in SQLite.
-- Listed here so nothing is lost; they belong with the data-copy phase.
-- ---------------------------------------------------------------------------
--   activity_log (created_at)
--   activity_log (user_id)
--   ai_report_asks (day)
--   ai_report_reads (cache_key, created_at)
--   billing_invoices (account_id, created_at)
--   feedback (reporter_id)
--   feedback (status)
--   feedback_attachments (feedback_id)
--   feedback_comment_attachments (comment_id)
--   feedback_comments (feedback_id, id)
--   guanyi_listings (store_code)
--   guanyi_pickup_log (created_at)
--   gzgrocery_orders (status)
--   ingredients (category)
--   ingredients (sku)
--   integration_help_requests (status, created_at)
--   invoice_lines (line_id)
--   invoice_lines (invoice_id)
--   invoice_pos (po_id)
--   invoice_pos (invoice_id)
--   invoices (account_id)
--   invoices (scope)
--   invoices (date)
--   invoices (supplier)
--   market_stock (product_id)
--   market_stock (market_id)
--   market_stock_ledger (ref_table, ref_id)
--   market_stock_ledger (market_id, created_at)
--   meituan_listing_specs (store_code, listing_name)
--   meituan_orders (ordered_at)
--   meituan_orders (store_id)
--   miniapp_order_lines (product_id)
--   miniapp_order_lines (order_id)
--   miniapp_orders (coupon_name)
--   miniapp_orders (district)
--   miniapp_orders (order_date)
--   miniapp_orders (customer_phone)
--   miniapp_orders (user_id)
--   platform_audit_log (target_type, target_id)
--   platform_audit_log (created_at)
--   platform_ticket_messages (ticket_id, id)
--   platform_tickets (status, updated_at)
--   po_line_items (store_product_id)
--   po_line_items (invoice_status)
--   po_line_items (supplier_name)
--   po_line_items (expiry_date)
--   po_line_items (lot_number)
--   po_line_items (po_id)
--   production_batches (recipe_id)
--   production_batches (date)
--   products (top_category)
--   products (flash_ends_at)
--   products (is_published)
--   products (variant_group_id)
--   products (external_id)
--   purchase_orders (account_id)
--   push_subscriptions (user_id)
--   qingyun_push_queue (store_code, status)
--   recipe_ingredients (ingredient_id)
--   recipe_ingredients (recipe_id)
--   recipes (sku)
--   retail_article_views (day)
--   retail_auth_tokens (expires_at)
--   retail_auth_tokens (customer_id)
--   retail_broadcasts (status, scheduled_for)
--   retail_checkout_quotes (customer_id)
--   retail_checkout_quotes (created_at)
--   retail_client_logs (kind, created_at)
--   retail_client_logs (created_at)
--   retail_client_logs (customer_id, id)
--   retail_customer_addresses (customer_id)
--   retail_customer_favorites (product_id)
--   retail_customer_favorites (customer_id, created_at)
--   retail_customer_vouchers (voucher_id)
--   retail_customer_vouchers (customer_id, used_at)
--   retail_customers (referred_by_customer_id)
--   retail_customers (phone)
--   retail_delivery_zones (zone_type, match_city, match_district, is_active)
--   retail_feedback (created_at)
--   retail_feedback_messages (feedback_id, id)
--   retail_lifetime_commissions (referrer_id)
--   retail_media (sec_trace_id)
--   retail_media (folder_id)
--   retail_migration_credits (phone)
--   retail_notifications (broadcast_id)
--   retail_notifications (created_at)
--   retail_notifications (customer_id, read_at)
--   retail_order_addons (out_trade_no)
--   retail_order_addons (order_id, status)
--   retail_order_drafts (owner_realm, created_by, updated_at)
--   retail_order_items (product_id)
--   retail_order_items (order_id)
--   retail_orders (tracking_number)
--   retail_orders (placed_at)
--   retail_orders (status)
--   retail_orders (customer_id)
--   retail_payments (transaction_id)
--   retail_payments (order_id)
--   retail_points_transactions (customer_id, created_at)
--   retail_poll_options (poll_id, sort_order)
--   retail_poll_votes (customer_id, created_at)
--   retail_polls (status, sort_order)
--   retail_product_day_baseline (day)
--   retail_product_option_choices (option_id)
--   retail_product_options (product_id)
--   retail_product_substitutes (product_id, sort_order)
--   retail_product_versions (product_id, id)
--   retail_referrals (first_paid_order_id)
--   retail_referrals (referrer_id, status)
--   retail_refund_events (created_at)
--   retail_refund_events (order_id)
--   retail_reviews (customer_id, created_at)
--   retail_reviews (product_id, is_visible, created_at)
--   retail_shipments (tracking_number)
--   retail_shipments (order_id)
--   retail_stock_ledger (ref_table, ref_id)
--   retail_stock_ledger (store_id, product_id, created_at)
--   retail_stock_reservations (status, expires_at)
--   retail_stock_reservations (order_id)
--   retail_stock_reservations (store_id, product_id, status)
--   retail_store_stock (product_id)
--   retail_store_stock (store_id)
--   retail_subscriptions (order_id)
--   retail_subscriptions (customer_id, used)
--   retail_synthetic_reviews (product_id, is_visible, created_at)
--   retail_topup_transactions (out_trade_no)
--   retail_topup_transactions (customer_id, status)
--   retail_visits (session_id)
--   retail_visits (customer_id)
--   retail_visits (created_at)
--   retail_vouchers (code)
--   sale_addons (addon_product_id)
--   sale_addons (sale_id)
--   sales_entries (date)
--   store_products (is_published, sort_order, name_en)
--   store_products (category)
--   store_products (is_published, is_active)
--   store_products (kitchen_product_id)
--   store_products (variant_group_id)
--   supplier_documents (supplier_id)
--   suppliers (account_id)
--   account_domains (account_id)
--   account_operator_push_subs (account_id)
--   account_operator_push_subs (account_user_id)
--   account_user_caps (account_user_id)
--   account_user_codes (account_user_id, purpose)
--   account_user_sessions (account_user_id)
--   waste_entries (date)
