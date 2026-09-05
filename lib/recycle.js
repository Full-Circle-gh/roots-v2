// What was deleted, and how to put it back (audit E-07).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// Products have proper version history — automatic checkpoints, an "Original"
// baseline, who edited, and a Restore button behind a clear confirmation.
// Nothing else in the admin had anything. A deleted coupon, a deleted delivery
// zone, a mistyped row removed from the ledger: all one-way, all everyday.
//
// ── WHAT THIS IS ──────────────────────────────────────────────────────────
// The row is COPIED before it goes, and can be put back. Not a soft delete: the
// record really is removed, every list and every query behaves exactly as
// before, and nothing has to learn about a new "deleted" flag. What changes is
// that the last sixty days of removals are kept somewhere a person can read.
//
// ── WHAT IT DELIBERATELY DOES NOT COVER ───────────────────────────────────
// A PURCHASE ORDER, which the audit lists alongside these. Deleting one removes
// a header, its lines, its receipts and the expense rows it posted, and putting
// that back means re-deriving stock that has moved and books that have been
// reported since. A restore that half-works on a purchase order is worse than
// no restore at all, and the honest version of it is a decision about
// accounting policy rather than a function in this file.
//
// AND IT IS NOT AN AUDIT TRAIL. activity_log already records who deleted what,
// and keeps recording it; this holds the CONTENTS, for sixty days, so somebody
// can undo a mistake made this morning.

'use strict';

// The retention window. Long enough that a mistake found at the end of a month
// is still recoverable; short enough that this never becomes a second copy of
// the database. A row past it is not shown and is swept.
const RETENTION_DAYS = 60;

// What can be captured, and how it goes back.
//
//   mode 'row'  — the record was really deleted. Restoring re-inserts it, with
//                 its original id, and refuses if something has taken that id.
//   mode 'flag' — the record was archived, not removed (a coupon is switched
//                 off, not deleted). Restoring switches it back on, which is
//                 why a coupon can be restored even after something else has
//                 been created since.
const KINDS = {
  delivery_zone: {
    table: 'retail_delivery_zones', mode: 'row',
    labelEn: 'Delivery zone', labelCn: '配送区域',
    name: (r) => r.name_cn || r.name_en || ('#' + r.id),
  },
  finance_in: {
    table: 'income_entries', mode: 'row',
    labelEn: 'Money in', labelCn: '收入',
    name: (r) => [r.date, r.category, r.description].filter(Boolean).join(' · '),
  },
  finance_out: {
    table: 'expense_entries', mode: 'row',
    labelEn: 'Money out', labelCn: '支出',
    name: (r) => [r.date, r.category, r.description].filter(Boolean).join(' · '),
  },
  voucher: {
    table: 'retail_vouchers', mode: 'flag', flag: 'is_active',
    labelEn: 'Coupon', labelCn: '优惠券',
    name: (r) => r.title_cn || r.title_en || r.code || ('#' + r.id),
  },
};

function kindOf(kind) { return KINDS[String(kind || '')] || null; }

/**
 * Copy a record before it is deleted. Returns the id of the kept copy, or null.
 *
 * NEVER THROWS. A capture that fails must not stop the delete the operator
 * asked for — they pressed a button that says delete, and a half-failure that
 * leaves the record in place while reporting an error is the worst of the three
 * possible outcomes. A failure here costs the undo, and says so in the log.
 */
function capture(db, kind, id, by) {
  const k = kindOf(kind);
  if (!k || !db || id == null) return null;
  try {
    const row = db.prepare(`SELECT * FROM ${k.table} WHERE id = ?`).get(id);
    if (!row) return null;
    const r = db.prepare(
      `INSERT INTO deleted_records (kind, record_id, label, payload_json, deleted_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(kind, Number(id), String(k.name(row) || ('#' + id)).slice(0, 200),
      JSON.stringify(row), by || null);
    return r.lastInsertRowid;
  } catch (e) {
    console.warn('[recycle] could not keep a copy of ' + kind + '#' + id + ': ' + e.message);
    return null;
  }
}

/** The last RETENTION_DAYS of removals that have not been put back. */
function list(db) {
  try {
    return db.prepare(
      `SELECT * FROM deleted_records
        WHERE restored_at IS NULL
          AND deleted_at > datetime('now', '-' || ? || ' days')
        ORDER BY deleted_at DESC, id DESC LIMIT 200`
    ).all(RETENTION_DAYS).map((r) => {
      const k = kindOf(r.kind) || {};
      return {
        id: r.id, kind: r.kind, record_id: r.record_id, label: r.label,
        kindEn: k.labelEn || r.kind, kindCn: k.labelCn || r.kind,
        deleted_by: r.deleted_by, deleted_at: r.deleted_at,
      };
    });
  } catch (e) { return []; }
}

/**
 * Put one back.
 *
 * Returns { ok } or { ok:false, error } — never throws, and never leaves a
 * half-restored record: the insert is one statement, so it either lands or it
 * does not.
 *
 * `taken` is the case worth naming: the record's original id has been used by
 * something created since. Restoring under a NEW id was considered and refused
 * — everything that referred to the old record (an order's zone, a line's
 * expense) refers to it by that id, so a copy under a different one looks
 * restored while every reference still points at nothing.
 */
function restore(db, deletedId, by) {
  let rec;
  try {
    rec = db.prepare('SELECT * FROM deleted_records WHERE id = ?').get(deletedId);
  } catch (e) { return { ok: false, error: 'lookup_failed' }; }
  if (!rec) return { ok: false, error: 'not_found' };
  if (rec.restored_at) return { ok: false, error: 'already_restored' };
  const k = kindOf(rec.kind);
  if (!k) return { ok: false, error: 'unknown_kind' };

  let row;
  try { row = JSON.parse(rec.payload_json); } catch (e) { return { ok: false, error: 'copy_unreadable' }; }
  if (!row || typeof row !== 'object') return { ok: false, error: 'copy_unreadable' };

  try {
    if (k.mode === 'flag') {
      const live = db.prepare(`SELECT id FROM ${k.table} WHERE id = ?`).get(rec.record_id);
      if (!live) return { ok: false, error: 'gone' };
      db.prepare(`UPDATE ${k.table} SET ${k.flag} = 1 WHERE id = ?`).run(rec.record_id);
    } else {
      const taken = db.prepare(`SELECT id FROM ${k.table} WHERE id = ?`).get(rec.record_id);
      if (taken) return { ok: false, error: 'taken' };
      // The columns the TABLE has now, not the ones it had when the copy was
      // made: a column added since would break the insert, and a column dropped
      // since is not somewhere to put a value. Anything in the copy that no
      // longer has a home is left behind rather than failing the restore.
      const cols = db.prepare(`PRAGMA table_info(${k.table})`).all().map((c) => c.name);
      const use = cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c));
      if (!use.length) return { ok: false, error: 'copy_unreadable' };
      db.prepare(
        `INSERT INTO ${k.table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`
      ).run(...use.map((c) => row[c]));
    }
    db.prepare('UPDATE deleted_records SET restored_at = CURRENT_TIMESTAMP, restored_by = ? WHERE id = ?')
      .run(by || null, rec.id);
    return { ok: true, kind: rec.kind, record_id: rec.record_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Drop copies past the window. Called from the retention sweep. */
function sweep(db) {
  try {
    return db.prepare(
      "DELETE FROM deleted_records WHERE deleted_at < datetime('now', '-' || ? || ' days')"
    ).run(RETENTION_DAYS).changes || 0;
  } catch (e) { return 0; }
}

module.exports = { KINDS, RETENTION_DAYS, capture, list, restore, sweep, kindOf };
