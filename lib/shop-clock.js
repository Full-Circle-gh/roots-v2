// The shop's day boundary for SQL: the shift every "today", dashboard and
// finance figure is bucketed by, resolved from the account's own time zone and
// remembered for a minute per account. Moved out of routes/retail.js unchanged
// (decisions §477). scripts/test_business_day.js and
// scripts/test_shop_clock_per_account.js hold its behaviour.
'use strict';

const { tdb, currentTenantId, ROOTS_TENANT_ID } = require('./tenant-db');
const businessDate = require('./business-date');

// ── The shop's own day boundary, for SQL (audit A-05) ─────────────────────
// Thirty-five day-boundary calculations in this file were the literal string
// '+8 hours', so today's takings, the dashboard, the finance window and "new
// this week" ended at midnight in Guangzhou for every merchant on the platform.
// lib/business-date.js already existed and said why that was wrong; one file
// used it.
//
// THE SAME ZONE THE SCREEN USES. This resolves the first active location's
// timezone — character for character the query GET /api/retail-admin/config
// answers with, which is what the client hands to td-datetime.js as TD_TZ. They
// must agree: a screen that RENDERS a row at 00:30 Monday while the server
// BUCKETS it into Sunday is a screen arguing with itself, and the operator has
// no way to tell which half is lying.
//
// Memoised for a minute, per account. It is read many times per request and the
// answer changes when somebody edits a location's zone, which is not a thing
// that happens twice in a minute.
const _tzMemo = new Map();          // tenantId -> { at, shift }
function shopSqlShift() {
  const tid = (() => { try { return currentTenantId() || ROOTS_TENANT_ID; } catch (e) { return ROOTS_TENANT_ID; } })();
  const hit = _tzMemo.get(tid);
  const now = Date.now();
  if (hit && now - hit.at < 60_000) return hit.shift;
  // The library owns the resolution so every reader agrees — including
  // finance-summary.js and restock.js, which ask the same question. A column
  // absent on an old account database falls back to UTC+8 there, which is
  // exactly what this code did before, so an un-migrated account behaves
  // identically rather than shifting every date it shows.
  const shift = businessDate.sqlDayShiftForShop(tdb());
  _tzMemo.set(tid, { at: now, shift });
  return shift;
}

// The shop's offset from UTC in minutes, read off the same shift, so anything
// built on it agrees with the SQL to the minute.
function shopOffsetMinutes() {
  return parseInt(shopSqlShift(), 10);
}

// "UTC+8", "UTC-4", "UTC+5:30": the label for a column whose values were shifted
// by shopSqlShift(). It used to be the literal "(UTC+8)" beside values in the
// shop's own zone, which is right only for a shop in China (§82).
function shopUtcLabel() {
  return businessDate.utcLabel(shopOffsetMinutes());
}

// The shop's date today, "YYYY-MM-DD" (§82).
function shopToday() {
  return businessDate.businessDate(businessDate.shopTimezone(tdb()));
}

module.exports = { shopSqlShift, shopOffsetMinutes, shopUtcLabel, shopToday };
