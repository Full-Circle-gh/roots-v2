// The next purchase-order number, for both series: kitchen PO- and retail RPO-.
//
// ── WHAT WAS WRONG, TWICE ─────────────────────────────────────────────────
// Round one: kitchen numbering was COUNT(*) + 1 over the whole purchase_orders
// table, which is only ever right while nothing is deleted and nothing else
// shares the table. Both stopped being true — retail orders live in the same
// table and were inflating the count, and clearing out test orders drops the
// count below numbers still in use. That was fixed by taking MAX over the
// series instead of counting it, which is how retail had always worked.
//
// Round two, and this file: MAX over the LIVE rows still hands a number back
// when the order that held it is gone. Delete draft RPO-0036 — the highest —
// and the live max falls to 0035, so the next order issued is 0036 again.
//
// That is not merely an untidy gap. Deleting a draft KEEPS A COPY for sixty
// days (lib/recycle.js, audit E-07), and restore() puts the row back under its
// original id AND its original po_number. So the sequence is:
//
//   1. RPO-0036 is raised, then deleted.       (copy kept, restorable)
//   2. A new order is raised and gets RPO-0036. (live max was 0035)
//   3. Someone restores the deleted one.        (different id — restore succeeds)
//   4. Two different orders, two suppliers, one number, in the books.
//
// Nothing downstream defends against that: there is no unique index on
// po_number, and the restore's only collision check is on the row id.
//
// ── WHAT THIS IS ──────────────────────────────────────────────────────────
// A number, once issued, is never issued again. The next one is one above the
// highest the series has EVER reached, which is the highest of three things:
//
//   * the live rows            — what the old code looked at, and only that
//   * the recycle bin          — numbers that are deleted but restorable
//   * po_number_highwater      — a floor that is written every time a number is
//                                issued, so a number survives its order being
//                                deleted AND the recycle copy being swept at
//                                sixty days, and survives being handed out to a
//                                caller whose INSERT then fails or is rolled
//                                back. Nothing lowers it.
//
// GAPS IN THE SEQUENCE ARE THE POINT, NOT A DEFECT. A purchase order number
// goes to a supplier. Reissuing one to a different order is the failure; a
// missing 0036 is a deleted draft, which is exactly what it should look like.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
// It does not scope numbering by tenant_id, and neither did the code it
// replaces. Tenants are separated by DATABASE FILE (lib/tenant-db.js): tenant 1
// is the shared roots.db, every other tenant gets data/tenants/<id>.db. So the
// series is already per-tenant wherever isolation is on, and adding a tenant_id
// filter on top would restart the count inside the shared file and mint numbers
// that collide with the ones already there. Left alone on purpose.

'use strict';

const KITCHEN = 'PO-';
const RETAIL = 'RPO-';

// Created here rather than only in database.js so the helper works on any
// handle it is given, including a tenant DB opened before this table existed.
// initTenantSchema() also self-heals it on every tenant open; this is the belt
// to that braces, and costs one no-op statement per handle.
const READY = new WeakSet();
function ensureTable(db) {
  if (READY.has(db)) return;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS po_number_highwater (
      series TEXT PRIMARY KEY,
      last_n INTEGER NOT NULL
    )`);
    READY.add(db);
  } catch (e) { /* read-only handle or racing creator — the reads below cope */ }
}

// The highest number the series reaches among the LIVE orders.
//
// LIKE 'PO-%' does not match 'RPO-0001': LIKE anchors at the start of the
// string, so the two series never read each other's numbers.
function liveMax(db, prefix) {
  try {
    const row = db.prepare(
      'SELECT MAX(CAST(SUBSTR(po_number, ?) AS INTEGER)) AS n FROM purchase_orders WHERE po_number LIKE ?'
    ).get(prefix.length + 1, prefix + '%');
    return (row && row.n) || 0;
  } catch (e) { return 0; }
}

// The highest number sitting in the recycle bin — deleted, but restorable, and
// a restore brings the number back with it.
//
// TWO PAYLOAD SHAPES. lib/recycle.js wrote a bare row before it learned to
// carry children and writes { v: 2, row, children } since; copies in both
// shapes are alive in production databases with sixty days to run, so both are
// read. Restored copies are counted too — they are back in purchase_orders, so
// liveMax has them anyway, and skipping them would only add a branch.
function recycledMax(db, prefix) {
  try {
    const row = db.prepare(`
      SELECT MAX(CAST(SUBSTR(n, ?) AS INTEGER)) AS n FROM (
        SELECT COALESCE(json_extract(payload_json, '$.row.po_number'),
                        json_extract(payload_json, '$.po_number')) AS n
          FROM deleted_records WHERE kind = 'purchase_order'
      ) WHERE n LIKE ?
    `).get(prefix.length + 1, prefix + '%');
    return (row && row.n) || 0;
  } catch (e) { return 0; }   // no deleted_records table, or no JSON1
}

function floorFor(db, prefix) {
  try {
    const row = db.prepare('SELECT last_n FROM po_number_highwater WHERE series = ?').get(prefix);
    return (row && row.last_n) || 0;
  } catch (e) { return 0; }
}

/**
 * Issue the next number in a series, and remember that it was issued.
 *
 * ISSUING IS A WRITE. The high-water row moves before the number is returned,
 * so two orders raised in the same request — a kitchen copy that fans out into
 * several retail drafts does exactly this — cannot both be handed the same
 * number while neither has INSERTed yet. The read and the write are one
 * transaction for the same reason.
 */
function nextPONumber(db, prefix) {
  ensureTable(db);
  const issue = () => {
    const n = Math.max(liveMax(db, prefix), recycledMax(db, prefix), floorFor(db, prefix)) + 1;
    try {
      db.prepare(`INSERT INTO po_number_highwater (series, last_n) VALUES (?, ?)
                  ON CONFLICT(series) DO UPDATE SET last_n = excluded.last_n
                  WHERE excluded.last_n > po_number_highwater.last_n`).run(prefix, n);
    } catch (e) { /* a lost floor costs the guarantee, never the order */ }
    return prefix + String(n).padStart(4, '0');
  };
  // Already inside a transaction at most call sites; better-sqlite3 refuses to
  // nest, so fall back to running it plain rather than failing the order.
  try { return db.transaction(issue)(); } catch (e) { return issue(); }
}

function nextKitchenPONumber(db) { return nextPONumber(db, KITCHEN); }
function nextRetailPONumber(db) { return nextPONumber(db, RETAIL); }

module.exports = { nextKitchenPONumber, nextRetailPONumber, nextPONumber, KITCHEN, RETAIL };
