# gzgrocery — Findings

## stock_push session death (found 2026-08-04)

Status: recovered, deferred to Postgres migration.

What happened: stock_push on gzgrocery failed ~78% (9,405 errors vs 2,620 ok) from 2026-06-24 to 2026-07-26. 8,902 of the failures were the single message "fetchListings returned null (not logged in?)". stock_push calls fetchListings first; the ERP login session had died and nothing re-authenticated, so every push failed silently for ~a month.

Recovery: a needs_login error at 2026-07-27 04:41 was followed by a successful re-login at 04:55 (manual). stock_push has been clean since — 653 ok, 0 errors through 2026-08-04. The 78% figure is historical scarring, not a live fire.

Root defect (two parts, both to fix at the Postgres migration, NOT before — guanyi_* tables get renamed to gzgrocery_erp_*/gzgrocery_shop_* then, so reauth code written against guanyi_* now is throwaway):
  1. No session self-heal: fetchListings has no auto-reauth path when the ERP session expires.
  2. No alerting: a dead session ran unnoticed for a month. A simple alert on rising stock_push error count would have caught it in hours.

Cheap interim option (optional, if picked up before migration): a threshold alert on stock_push error count. Do not build reauth logic against guanyi_* tables.

Source: read-only survey of guanyi_sync_log on 2026-08-04.
