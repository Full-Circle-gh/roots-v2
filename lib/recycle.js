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
// ── THE PURCHASE ORDER, AND WHAT MADE IT SAFE ─────────────────────────────
// This file used to say a purchase order could not be covered: deleting one
// removes a header, its lines, its receipts and the expense rows it posted, and
// putting that back would mean re-deriving stock that has moved and books that
// have been reported since. That reasoning was sound and it was about the wrong
// order. THE ROUTE ONLY DELETES A DRAFT — `if (po.status !== 'Requested')` is a
// 409 (routes/retail-purchasing.js) — and a draft has posted no expense, moved
// no stock and taken no delivery. There is nothing to re-derive.
//
// A delivered order can still get there, and the path is the safe one: it has
// to be stood down to Requested first, and that transition already reverses the
// stock and unposts the expenses, refusing outright when it cannot ("all of it
// or none of it"). By the time the delete button is reachable, the reversal has
// happened and been logged.
//
// SO THE RESTORE IS THE ROW AND ITS LINES, PUT BACK AS THEY WERE — INCLUDING
// THE DATE. A purchase order carries its own `date`, and the expense poster
// writes that date onto every row it posts (`insert.run(po.date, …)`), so an
// order restored in October and re-ordered still lands in the books in the
// month the purchase actually happened. That is the decision, stated: a
// restored purchase restates the month it was in, which is how a purchase
// RETURN already behaves. Re-dating it to today would silently move a purchase
// between accounting periods, which is the one thing a restore must not do.
//
// It is the first kind here with CHILDREN, and they go back inside one
// transaction: a header with no lines is worse than no restore at all.
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
//
// `children` names rows that belong TO the record and go with it: they are
// copied on the way out and re-inserted on the way back, under their own
// original ids, inside the same transaction as the header.
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
  // Only ever a DRAFT — see the header. Its lines travel with it.
  purchase_order: {
    table: 'purchase_orders', mode: 'row',
    labelEn: 'Purchase order', labelCn: '采购单',
    name: (r) => [r.po_number || ('#' + r.id), r.supplier].filter(Boolean).join(' · '),
    children: [{ table: 'po_line_items', fk: 'po_id' }],
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
    /* TWO PAYLOAD SHAPES, and the old one is still read. Everything captured
       before this was a bare row object, and copies made then are sitting in
       live databases with sixty days to run — so the versioned envelope is used
       only where there is something a bare row cannot hold, and restore() reads
       both. `v: 2` is the marker; a bare row has no such key. */
    const payload = k.children
      ? { v: 2, row, children: childrenOf(db, k, id) }
      : row;
    const r = db.prepare(
      `INSERT INTO deleted_records (kind, record_id, label, payload_json, deleted_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(kind, Number(id), String(k.name(row) || ('#' + id)).slice(0, 200),
      JSON.stringify(payload), by || null);
    return r.lastInsertRowid;
  } catch (e) {
    console.warn('[recycle] could not keep a copy of ' + kind + '#' + id + ': ' + e.message);
    return null;
  }
}

/* The rows that belong to a record, read before it goes. Read here rather than
   at the delete site so a caller cannot forget one: capture(db, 'purchase_order',
   id) is the whole contract, and what travels with it is this file's business. */
function childrenOf(db, k, id) {
  const out = {};
  for (const c of (k.children || [])) {
    try { out[c.table] = db.prepare(`SELECT * FROM ${c.table} WHERE ${c.fk} = ?`).all(id); }
    catch (e) { out[c.table] = []; }   // a table that is not there holds nothing
  }
  return out;
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

  let payload;
  try { payload = JSON.parse(rec.payload_json); } catch (e) { return { ok: false, error: 'copy_unreadable' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'copy_unreadable' };
  // Both shapes — see capture(). A copy made before children existed is a bare
  // row and still restores.
  const versioned = payload.v === 2 && payload.row && typeof payload.row === 'object';
  const row = versioned ? payload.row : payload;
  const children = versioned && payload.children && typeof payload.children === 'object'
    ? payload.children : {};

  try {
    if (k.mode === 'flag') {
      const live = db.prepare(`SELECT id FROM ${k.table} WHERE id = ?`).get(rec.record_id);
      if (!live) return { ok: false, error: 'gone' };
      db.prepare(`UPDATE ${k.table} SET ${k.flag} = 1 WHERE id = ?`).run(rec.record_id);
    } else {
      const taken = db.prepare(`SELECT id FROM ${k.table} WHERE id = ?`).get(rec.record_id);
      if (taken) return { ok: false, error: 'taken' };
      // A child id taken by something created since is the same refusal as a
      // header id taken, and it is checked BEFORE anything is written: a
      // purchase order restored without one of its lines is a purchase order
      // for the wrong money, which is worse than no restore at all.
      for (const c of (k.children || [])) {
        for (const kid of (children[c.table] || [])) {
          if (kid == null || kid.id == null) continue;
          if (db.prepare(`SELECT id FROM ${c.table} WHERE id = ?`).get(kid.id)) {
            return { ok: false, error: 'taken' };
          }
        }
      }
      // The columns the TABLE has now, not the ones it had when the copy was
      // made: a column added since would break the insert, and a column dropped
      // since is not somewhere to put a value. Anything in the copy that no
      // longer has a home is left behind rather than failing the restore.
      const put = (table, r) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        const use = cols.filter((c) => Object.prototype.hasOwnProperty.call(r, c));
        if (!use.length) return false;
        db.prepare(
          `INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`
        ).run(...use.map((c) => r[c]));
        return true;
      };
      // ONE TRANSACTION, because a record with children is not one statement any
      // more. A header restored without its lines would read as a purchase order
      // of zero, and the operator would have no way to tell it from a real one.
      const writeAll = db.transaction(() => {
        if (!put(k.table, row)) { const e = new Error('copy_unreadable'); e.recycle = true; throw e; }
        for (const c of (k.children || [])) {
          for (const kid of (children[c.table] || [])) put(c.table, kid);
        }
      });
      try { writeAll(); }
      catch (e) { return { ok: false, error: e.recycle ? e.message : e.message }; }
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
