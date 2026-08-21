-- G28, option 3 --- rename the Postgres relations back to the tenant* names.
--
-- The 2026-08-04 copy performed the tenant->account rename on the schema side
-- only; the 266 statements in the application were never moved. This reverses
-- the physical half so the two sides agree again. It does NOT reverse the
-- vocabulary decision --- the word `tenant` stays retired in prose.
--
-- Derived from scripts/postgres-full-copy/plan.json (tables, columns) and from
-- pg_catalog on the live cluster (indexes, sequences, constraints).
--
--   12  ALTER TABLE ... RENAME TO
--   25  ALTER TABLE ... RENAME COLUMN
--    4  ALTER INDEX ... RENAME TO       (standalone indexes only)
--    8  ALTER SEQUENCE ... RENAME TO
--   25  ALTER TABLE ... RENAME CONSTRAINT
--   --
--   74  statements
--
-- Postgres DDL is transactional. Everything below is one transaction: if any
-- statement fails the whole rename rolls back and the cluster is untouched.
--
-- NOT renamed, deliberately --- these carry the string "account" for reasons
-- that have nothing to do with tenancy:
--   eleme_tokens.account, eleme_tokens_account_key   (an Eleme platform login)
--   retail_stores.meituan_account_id                 (a Meituan platform id)
--   ingredients.accounting_category                  ("accounting")
--   purchase_orders.posted_to_accounting             ("accounting")

BEGIN;

-- ---------------------------------------------------------------- tables (12)
ALTER TABLE account_domains RENAME TO tenant_domains;
ALTER TABLE account_integrations RENAME TO tenant_integrations;
ALTER TABLE account_onboarding RENAME TO tenant_onboarding;
ALTER TABLE account_operator_push_subs RENAME TO tenant_operator_push_subs;
ALTER TABLE account_secrets RENAME TO tenant_secrets;
ALTER TABLE account_signup_requests RENAME TO tenant_signup_requests;
ALTER TABLE account_user_caps RENAME TO tenant_user_caps;
ALTER TABLE account_user_codes RENAME TO tenant_user_codes;
ALTER TABLE account_user_sessions RENAME TO tenant_user_sessions;
ALTER TABLE account_user_stores RENAME TO tenant_user_stores;
ALTER TABLE account_users RENAME TO tenant_users;
ALTER TABLE accounts RENAME TO tenants;

-- --------------------------------------------------------------- columns (25)
-- Named by the NEW table name --- the renames above have already happened.
ALTER TABLE billing_invoices RENAME COLUMN account_id TO tenant_id;
ALTER TABLE billing_reminders RENAME COLUMN account_id TO tenant_id;
ALTER TABLE billing_subscriptions RENAME COLUMN account_id TO tenant_id;
ALTER TABLE integration_help_requests RENAME COLUMN account_id TO tenant_id;
ALTER TABLE integration_sessions RENAME COLUMN account_id TO tenant_id;
ALTER TABLE invoices RENAME COLUMN account_id TO tenant_id;
ALTER TABLE platform_broadcasts RENAME COLUMN account_id TO tenant_id;
ALTER TABLE platform_impersonation_tokens RENAME COLUMN account_id TO tenant_id;
ALTER TABLE platform_tickets RENAME COLUMN account_id TO tenant_id;
ALTER TABLE purchase_orders RENAME COLUMN account_id TO tenant_id;
ALTER TABLE subscriptions RENAME COLUMN account_id TO tenant_id;
ALTER TABLE suppliers RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_domains RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_integrations RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_onboarding RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_operator_push_subs RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_operator_push_subs RENAME COLUMN account_user_id TO tenant_user_id;
ALTER TABLE tenant_secrets RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_user_caps RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_user_caps RENAME COLUMN account_user_id TO tenant_user_id;
ALTER TABLE tenant_user_codes RENAME COLUMN account_user_id TO tenant_user_id;
ALTER TABLE tenant_user_sessions RENAME COLUMN account_id TO tenant_id;
ALTER TABLE tenant_user_sessions RENAME COLUMN account_user_id TO tenant_user_id;
ALTER TABLE tenant_user_stores RENAME COLUMN account_user_id TO tenant_user_id;
ALTER TABLE tenant_users RENAME COLUMN account_id TO tenant_id;

-- ------------------------------------------------- standalone indexes (4)
-- The other 16 account* indexes back a primary key or unique constraint.
-- RENAME CONSTRAINT below renames those with their constraint; naming them
-- here as well would fail on the second statement.
ALTER INDEX idx_account_domains_host RENAME TO idx_tenant_domains_host;
ALTER INDEX idx_account_users_login RENAME TO idx_tenant_users_login;
ALTER INDEX idx_billing_subscriptions_account RENAME TO idx_billing_subscriptions_tenant;
ALTER INDEX idx_subscriptions_account RENAME TO idx_subscriptions_tenant;

-- ------------------------------------------------------------- sequences (8)
ALTER SEQUENCE account_domains_id_seq RENAME TO tenant_domains_id_seq;
ALTER SEQUENCE account_integrations_id_seq RENAME TO tenant_integrations_id_seq;
ALTER SEQUENCE account_onboarding_id_seq RENAME TO tenant_onboarding_id_seq;
ALTER SEQUENCE account_secrets_id_seq RENAME TO tenant_secrets_id_seq;
ALTER SEQUENCE account_signup_requests_id_seq RENAME TO tenant_signup_requests_id_seq;
ALTER SEQUENCE account_user_codes_id_seq RENAME TO tenant_user_codes_id_seq;
ALTER SEQUENCE account_users_id_seq RENAME TO tenant_users_id_seq;
ALTER SEQUENCE accounts_id_seq RENAME TO tenants_id_seq;

-- ----------------------------------------------------------- constraints (25)
-- Postgres carries a foreign key's REFERENCE across a table rename by oid, so
-- no FK definition is edited here. It does NOT rename the constraint itself,
-- which is what these statements are for.
ALTER TABLE integration_sessions RENAME CONSTRAINT integration_sessions_account_id_kind_store_code_key TO integration_sessions_tenant_id_kind_store_code_key;
ALTER TABLE tenant_domains RENAME CONSTRAINT account_domains_pkey TO tenant_domains_pkey;
ALTER TABLE tenant_domains RENAME CONSTRAINT fk_account_domains_1 TO fk_tenant_domains_1;
ALTER TABLE tenant_integrations RENAME CONSTRAINT account_integrations_account_id_kind_key TO tenant_integrations_tenant_id_kind_key;
ALTER TABLE tenant_integrations RENAME CONSTRAINT account_integrations_pkey TO tenant_integrations_pkey;
ALTER TABLE tenant_integrations RENAME CONSTRAINT fk_account_integrations_1 TO fk_tenant_integrations_1;
ALTER TABLE tenant_onboarding RENAME CONSTRAINT account_onboarding_account_id_step_key_key TO tenant_onboarding_tenant_id_step_key_key;
ALTER TABLE tenant_onboarding RENAME CONSTRAINT account_onboarding_pkey TO tenant_onboarding_pkey;
ALTER TABLE tenant_operator_push_subs RENAME CONSTRAINT account_operator_push_subs_pkey TO tenant_operator_push_subs_pkey;
ALTER TABLE tenant_operator_push_subs RENAME CONSTRAINT fk_account_operator_push_subs_1 TO fk_tenant_operator_push_subs_1;
ALTER TABLE tenant_secrets RENAME CONSTRAINT account_secrets_account_id_key_key TO tenant_secrets_tenant_id_key_key;
ALTER TABLE tenant_secrets RENAME CONSTRAINT account_secrets_pkey TO tenant_secrets_pkey;
ALTER TABLE tenant_secrets RENAME CONSTRAINT fk_account_secrets_1 TO fk_tenant_secrets_1;
ALTER TABLE tenant_signup_requests RENAME CONSTRAINT account_signup_requests_pkey TO tenant_signup_requests_pkey;
ALTER TABLE tenant_user_caps RENAME CONSTRAINT account_user_caps_pkey TO tenant_user_caps_pkey;
ALTER TABLE tenant_user_caps RENAME CONSTRAINT fk_account_user_caps_1 TO fk_tenant_user_caps_1;
ALTER TABLE tenant_user_codes RENAME CONSTRAINT account_user_codes_pkey TO tenant_user_codes_pkey;
ALTER TABLE tenant_user_codes RENAME CONSTRAINT fk_account_user_codes_1 TO fk_tenant_user_codes_1;
ALTER TABLE tenant_user_sessions RENAME CONSTRAINT account_user_sessions_pkey TO tenant_user_sessions_pkey;
ALTER TABLE tenant_user_sessions RENAME CONSTRAINT fk_account_user_sessions_1 TO fk_tenant_user_sessions_1;
ALTER TABLE tenant_user_stores RENAME CONSTRAINT account_user_stores_pkey TO tenant_user_stores_pkey;
ALTER TABLE tenant_user_stores RENAME CONSTRAINT fk_account_user_stores_1 TO fk_tenant_user_stores_1;
ALTER TABLE tenant_users RENAME CONSTRAINT account_users_pkey TO tenant_users_pkey;
ALTER TABLE tenant_users RENAME CONSTRAINT fk_account_users_1 TO fk_tenant_users_1;
ALTER TABLE tenants RENAME CONSTRAINT accounts_pkey TO tenants_pkey;

COMMIT;
