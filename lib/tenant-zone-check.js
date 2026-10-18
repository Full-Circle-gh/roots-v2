'use strict';

// A TENANT WITH NO TIMEZONE IS NAMED, LOUDLY, AT EVERY START (decisions §82).
//
// §82: time is a tenant property, and a tenant with no zone is a configuration
// error that must fail loudly at startup rather than default. Every tenant runs
// in this one process, so "fail" cannot mean the process: one tenant's missing
// setting would take every shop offline with it, and a deploy would become an
// outage. It means LOUD ABOUT THE ONE TENANT — a log line that names it and an
// alert to its group — and the server goes on starting.
//
// The refusing is done where the work is: zoneRefused() below, asked by checkout
// and by every shop-local job (§82 step 3), and lib/business-date.js, which has
// no fallback zone and throws NoShopTimezoneError (step 3 full).
//
// TWO WAYS TO BE WRONG, both reported:
//   • missing — no active store names a zone and there is no `shop.timezone`,
//     so every date and cutoff for the tenant is quietly Guangzhou's;
//   • invalid — a zone the runtime cannot read (`Asia/Shangai`), which
//     lib/business-date.js also quietly answers with Guangzhou's. Checked for
//     the tenant's zone AND every zone an active store names, because a store's
//     own zone is what its pickup window is judged in.

const businessDate = require('./business-date');

// null when `tz` is a zone the runtime can use; otherwise 'missing' or 'invalid'.
// One test, lib/business-date.js's, so what this check names is exactly what the
// date helpers refuse.
const { zoneProblem } = businessDate;

/**
 * Every active tenant whose zone is missing or unreadable, as
 * { tenantId, name, problem, detail }. A tenant whose database cannot be read
 * is reported as 'unreadable' rather than throwing: one bad file must not hide
 * the rest of the list.
 *
 * `hasTenantDb(id)` says whether the tenant's database already exists. ASKED
 * FIRST, because lib/tenant-db.js's getTenantDb CREATES a missing file and
 * builds its whole schema: a check that opened every active tenant that way
 * would write a database for each one that has none. A check writes nothing.
 */
function checkTenantZones({ mainDb, getTenantDb, hasTenantDb = () => true }) {
  const tenants = mainDb.prepare("SELECT id, name FROM tenants WHERE status = 'active' ORDER BY id").all();
  const found = [];
  for (const t of tenants) {
    let db;
    if (!hasTenantDb(t.id)) { found.push({ tenantId: t.id, name: t.name, problem: 'unreadable', detail: 'it has no database file' }); continue; }
    try { db = getTenantDb(t.id); }
    catch (e) { found.push({ tenantId: t.id, name: t.name, problem: 'unreadable', detail: e.message }); continue; }
    const tz = businessDate.shopTimezone(db);
    const p = zoneProblem(tz);
    if (p) found.push({ tenantId: t.id, name: t.name, problem: p, detail: p === 'invalid' ? `zone ${JSON.stringify(tz)}` : 'no store names a zone and shop.timezone is not set' });
    let stores = [];
    try {
      stores = db.prepare(`SELECT id, code, timezone FROM retail_stores
                            WHERE is_active = 1 AND timezone IS NOT NULL AND TRIM(timezone) <> ''`).all();
    } catch (e) { /* no stores table on an un-migrated account — the tenant zone above is the answer */ }
    for (const s of stores) {
      if (zoneProblem(s.timezone) === 'invalid' && String(s.timezone).trim() !== String(tz || '').trim()) {
        found.push({ tenantId: t.id, name: t.name, problem: 'invalid', detail: `store ${s.code || s.id} names zone ${JSON.stringify(s.timezone)}` });
      }
    }
  }
  return found;
}

function lineFor(f) {
  const what = f.problem === 'missing' ? 'HAS NO TIMEZONE'
    : f.problem === 'invalid' ? 'HAS A TIMEZONE THE SERVER CANNOT READ'
      : 'COULD NOT BE CHECKED';
  return `tenant ${f.tenantId} "${f.name}" ${what} (${f.detail}). It takes no orders that need a time, `
    + 'and its reminders and timed jobs do not run, until the time zone is set on its stores (Settings → Stores) — decisions §82.';
}

/**
 * Run the check and say so. Never throws, never stops the server: a check that
 * cannot run logs that it was skipped. Returns what it found.
 */
function runAtStartup({ mainDb, getTenantDb, hasTenantDb, alert = null, log = console }) {
  let found;
  try { found = checkTenantZones({ mainDb, getTenantDb, hasTenantDb }); }
  catch (e) { log.warn('[tz] tenant timezone check skipped: ' + e.message); return null; }
  if (!found.length) { log.log('[tz] every active tenant has a readable timezone.'); return found; }
  if (!alert) {
    try { alert = require('./ops-alert').alertBoth; } catch (e) { alert = null; }
  }
  for (const f of found) {
    const line = lineFor(f);
    log.error('[tz] ⛔ ' + line);
    if (alert) {
      try { Promise.resolve(alert(f.tenantId, '⛔ roots-v2: ' + line)).catch(() => {}); }
      catch (e) { /* alerting must never block or throw here */ }
    }
  }
  return found;
}

// ── STEP 3: A SHOP WITH NO ZONE DOES NO TIME-BOUND WORK (§82) ────────────────
// The startup check above names the shop. This is what makes the ruling bite:
// a job that would act at a shop-local hour (a reminder, a digest, closing a
// delivery off its ETA) asks here first and does nothing for a shop whose zone
// is missing or unreadable, instead of acting on Guangzhou's clock as if that
// were the shop's. Customer checkout asks the same question (routes/retail.js
// refuseWithoutShopZone). Said ONCE per shop and job per process: these jobs
// tick every minute and the startup line has already said why.
const _told = new Set();
function zoneRefused(tz, tenantId, job, log = console) {
  const p = zoneProblem(tz);
  if (!p) return false;
  const key = (tenantId == null ? 1 : tenantId) + ':' + job;
  if (!_told.has(key)) {
    _told.add(key);
    log.warn(`[tz] ⛔ ${job} is not running for tenant ${tenantId == null ? 1 : tenantId}: its timezone is ${p}. `
      + 'Set the time zone on its stores (Settings → Stores) — decisions §82.');
  }
  return true;
}

module.exports = { zoneProblem, checkTenantZones, runAtStartup, zoneRefused };
