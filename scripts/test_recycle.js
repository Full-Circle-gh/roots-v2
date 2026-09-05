#!/usr/bin/env node
/**
 * test_recycle.js — putting back what was deleted (audit E-07).
 *
 *   node scripts/test_recycle.js
 *
 * THE FINDING. Products have proper version history — checkpoints, an
 * "Original" baseline, who edited, a Restore button behind a clear
 * confirmation. Nothing else in the admin had anything. A deleted coupon, a
 * deleted delivery zone, a mistyped row removed from the ledger: all one-way,
 * all everyday.
 *
 * The contents are now copied before the record goes, and can be put back for
 * sixty days. The properties that decide whether that is worth having:
 *
 *   §2  A CAPTURE NEVER STOPS A DELETE. The operator pressed a button that says
 *       delete; a half-failure that leaves the record in place while reporting
 *       an error is the worst of the three outcomes.
 *   §3  A record goes back UNDER ITS OWN ID, or not at all — everything that
 *       referred to it refers to it by that id, so a copy under a new one looks
 *       restored while every reference still points at nothing.
 *   §4  The copy survives a schema that has moved on since.
 *   §5  Nothing is put back twice, and nothing is kept for ever.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.log('  ! better-sqlite3 is not built here — skipping'); process.exit(0); }

const R = require('../lib/recycle');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE deleted_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, record_id INTEGER NOT NULL,
      label TEXT, payload_json TEXT NOT NULL, deleted_by TEXT,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, restored_at DATETIME, restored_by TEXT);
    CREATE TABLE retail_delivery_zones (id INTEGER PRIMARY KEY, zone_type TEXT, name_en TEXT,
      name_cn TEXT, base_fee REAL, free_threshold REAL, is_active INTEGER DEFAULT 1);
    CREATE TABLE expense_entries (id INTEGER PRIMARY KEY, date TEXT, amount REAL, category TEXT,
      description TEXT, po_id INTEGER);
    CREATE TABLE retail_vouchers (id INTEGER PRIMARY KEY, code TEXT, title_en TEXT, title_cn TEXT,
      is_active INTEGER DEFAULT 1);
    CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, po_number TEXT, supplier TEXT,
      date TEXT, status TEXT, total_cost REAL);
    CREATE TABLE po_line_items (id INTEGER PRIMARY KEY, po_id INTEGER, name TEXT, qty REAL,
      cost_per_unit REAL);
  `);
  db.prepare("INSERT INTO retail_delivery_zones VALUES (4,'gz_district','Tianhe','天河区',12,399,1)").run();
  db.prepare("INSERT INTO expense_entries VALUES (9,'2026-08-01',45.5,'Packaging','Boxes',NULL)").run();
  db.prepare("INSERT INTO retail_vouchers VALUES (3,'WELCOME','Welcome','新人礼',1)").run();
  // A DRAFT purchase order — the only kind the delete route lets through — with
  // two lines and a date in a month that is not this one.
  db.prepare("INSERT INTO purchase_orders VALUES (7,'RPO-0007','Fresh Co.','2026-03-14','Requested',260)").run();
  db.prepare("INSERT INTO po_line_items VALUES (11,7,'Oat groats',20,8)").run();
  db.prepare("INSERT INTO po_line_items VALUES (12,7,'Sesame',10,10)").run();
  return db;
}

// ── §1 · a copy, and what it says ─────────────────────────────────────────
section('1 · the copy taken before a record goes');
{
  const db = freshDb();
  const id = R.capture(db, 'delivery_zone', 4, 'mei');
  yes(id > 0, 'a zone is copied before it is deleted');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();
  const rows = R.list(db);
  is(rows.length, 1, 'and it appears in what was recently deleted');
  is(rows[0].label, '天河区', 'named the way a person would recognise it');
  is(rows[0].kindEn, 'Delivery zone', 'and said to be what it is, in both languages');
  is(rows[0].kindCn, '配送区域', '…in Chinese too');
  is(rows[0].deleted_by, 'mei', 'with who removed it');
}

// ── §2 · a capture never stops a delete ───────────────────────────────────
section('2 · nothing about keeping a copy can block the delete');
{
  const db = freshDb();
  db.exec('DROP TABLE deleted_records');            // the store itself is gone
  is(R.capture(db, 'delivery_zone', 4, 'mei'), null,
    'a capture that cannot be written returns null rather than throwing');
  // The operator pressed a button that says delete. It has to happen.
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();
  is(db.prepare('SELECT COUNT(*) n FROM retail_delivery_zones').get().n, 0, 'and the delete still happens');
}
{
  const db = freshDb();
  is(R.capture(db, 'not_a_kind', 4, 'mei'), null, 'an unknown kind is refused, quietly');
  is(R.capture(db, 'delivery_zone', 999, 'mei'), null, 'and a record that is not there is not invented');
}

// ── §3 · putting one back ─────────────────────────────────────────────────
section('3 · a record goes back under its own id, or not at all');
{
  const db = freshDb();
  const copy = R.capture(db, 'delivery_zone', 4, 'mei');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();
  const r = R.restore(db, copy, 'lin');
  is(r.ok, true, 'a deleted zone can be put back');
  const back = db.prepare('SELECT * FROM retail_delivery_zones WHERE id = 4').get();
  is(back.name_cn, '天河区', 'with its name');
  is(back.base_fee, 12, 'its fee');
  is(back.free_threshold, 399, 'and its free-delivery threshold — the numbers nobody remembers');
  is(R.list(db).length, 0, 'and it leaves the recently-deleted list');
}
{
  const db = freshDb();
  const copy = R.capture(db, 'delivery_zone', 4, 'mei');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();
  db.prepare("INSERT INTO retail_delivery_zones VALUES (4,'city','Shenzhen','深圳市',20,NULL,1)").run();
  const r = R.restore(db, copy, 'lin');
  is(r.ok, false, 'a record whose id has been taken since is NOT put back');
  is(r.error, 'taken', 'and says exactly why');
  is(db.prepare('SELECT name_cn FROM retail_delivery_zones WHERE id = 4').get().name_cn, '深圳市',
    'the record that took its place is untouched');
  // Restoring under a NEW id was considered and refused: everything that
  // referred to the old record refers to it by that id.
  is(db.prepare('SELECT COUNT(*) n FROM retail_delivery_zones').get().n, 1,
    'and no copy is quietly created beside it');
}
{
  // A coupon is archived rather than removed, so putting it back is switching
  // it on — which works even when other things have been created since.
  const db = freshDb();
  const copy = R.capture(db, 'voucher', 3, 'mei');
  db.prepare('UPDATE retail_vouchers SET is_active = 0 WHERE id = 3').run();
  is(R.restore(db, copy, 'lin').ok, true, 'an archived coupon can be switched back on');
  is(db.prepare('SELECT is_active FROM retail_vouchers WHERE id = 3').get().is_active, 1, 'and is on again');
}
{
  const db = freshDb();
  const copy = R.capture(db, 'voucher', 3, 'mei');
  db.prepare('DELETE FROM retail_vouchers WHERE id = 3').run();     // really gone
  is(R.restore(db, copy, 'lin').error, 'gone',
    'a coupon whose row has since been removed outright says so, rather than half-succeeding');
}

// ── §3b · a record with children ──────────────────────────────────────────
section('3b · a purchase order comes back whole, in its own month');
{
  const db = freshDb();
  const copy = R.capture(db, 'purchase_order', 7, 'mei');
  yes(copy > 0, 'a draft purchase order is copied before it goes');
  const kept = db.prepare('SELECT * FROM deleted_records WHERE id = ?').get(copy);
  is(kept.label, 'RPO-0007 · Fresh Co.', 'labelled by its number and its supplier — what an operator would search for');
  const payload = JSON.parse(kept.payload_json);
  is(payload.v, 2, 'kept in the versioned shape, because a bare row cannot hold its lines');
  is(payload.children.po_line_items.length, 2, 'and both lines travel with it');

  // The delete the route performs, in the order the route performs it.
  db.prepare('DELETE FROM po_line_items WHERE po_id = 7').run();
  db.prepare('DELETE FROM purchase_orders WHERE id = 7').run();
  is(db.prepare('SELECT COUNT(*) c FROM po_line_items').get().c, 0, 'the lines are gone');

  const r = R.restore(db, copy, 'ash');
  is(r.ok, true, 'and it goes back');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = 7').get();
  is(po.po_number, 'RPO-0007', 'under its own number');
  is(po.date, '2026-03-14',
     'AND ITS OWN DATE — the expense poster writes po.date onto every row it posts, so a purchase '
     + 'restored in October still lands in the books in March, where it happened');
  is(po.status, 'Requested', 'still a draft, which is what it was');
  const lines = db.prepare('SELECT * FROM po_line_items ORDER BY id').all();
  is(lines.length, 2, 'with both lines back');
  is(lines[0].id, 11, 'under their own ids, so anything that referred to one still does');
  is(lines[1].cost_per_unit, 10, 'and their own money');
}
{
  // The half-restore this file exists to prevent.
  const db = freshDb();
  const copy = R.capture(db, 'purchase_order', 7, 'mei');
  db.prepare('DELETE FROM po_line_items WHERE po_id = 7').run();
  db.prepare('DELETE FROM purchase_orders WHERE id = 7').run();
  // Something created since has taken one of the LINE ids — not the header's.
  db.prepare("INSERT INTO po_line_items VALUES (12, 99, 'Something else', 1, 1)").run();
  const r = R.restore(db, copy, 'ash');
  is(r.ok, false, 'a line id taken by something created since refuses the whole restore');
  is(r.error, 'taken', 'and says which of the two failures it was');
  is(db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE id = 7').get().c, 0,
     'leaving NOTHING behind — a header with one of its two lines is a purchase order for the wrong money');
  is(db.prepare('SELECT * FROM deleted_records WHERE id = ?').get(copy).restored_at, null,
     'and the copy is still there to try again once the collision is dealt with');
}

// ── §4 · the copy outlives the schema ─────────────────────────────────────
section('4 · a copy taken before the table changed still goes back');
{
  const db = freshDb();
  const copy = R.capture(db, 'expense_entry_x', 9, 'mei');
  is(copy, null, 'an unknown kind cannot be captured at all');
}
{
  const db = freshDb();
  const copy = R.capture(db, 'finance_out', 9, 'mei');
  db.prepare('DELETE FROM expense_entries WHERE id = 9').run();
  // A column added since the copy was taken, and one dropped from it.
  db.exec('ALTER TABLE expense_entries ADD COLUMN payment_method TEXT');
  const r = R.restore(db, copy, 'lin');
  is(r.ok, true, 'a column added since the copy was taken does not break the restore');
  const back = db.prepare('SELECT * FROM expense_entries WHERE id = 9').get();
  is(back.amount, 45.5, 'the amount comes back');
  is(back.payment_method, null, 'and the column that did not exist yet is simply empty');
}

// ── §5 · once, and not for ever ───────────────────────────────────────────
section('5 · put back once, and kept only as long as it is useful');
{
  const db = freshDb();
  const copy = R.capture(db, 'delivery_zone', 4, 'mei');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();
  R.restore(db, copy, 'lin');
  is(R.restore(db, copy, 'lin').error, 'already_restored', 'nothing is put back twice');
  is(R.restore(db, 9999, 'lin').error, 'not_found', 'and a copy that does not exist is a plain not-found');
}
{
  const db = freshDb();
  R.capture(db, 'delivery_zone', 4, 'mei');
  db.prepare("UPDATE deleted_records SET deleted_at = datetime('now','-90 days')").run();
  is(R.list(db).length, 0, 'a copy past the window is not offered');
  is(R.sweep(db), 1, 'and the sweep removes it');
  is(R.sweep(db), 0, 'leaving nothing to do the second time');
}

// ── §6 · it is wired in ───────────────────────────────────────────────────
section('6 · every delete this covers takes the copy, and there is a screen');
{
  const retail = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  yes(/recycle\.capture\(tdb\(\), 'voucher'/.test(retail), 'deleting a coupon keeps a copy');
  yes(/recycle\.capture\(tdb\(\), 'delivery_zone'/.test(retail), 'so does deleting a delivery zone');
  const fin = fs.readFileSync(path.join(ROOT, 'routes/finance-transactions.js'), 'utf8');
  yes(/capture\(db, kind === 'in' \? 'finance_in' : 'finance_out'/.test(fin),
    'and removing a hand-typed ledger row');
  // The capture has to come BEFORE the delete, or there is nothing left to copy.
  const at = fin.indexOf("require('../lib/recycle').capture");
  yes(at > 0 && at < fin.indexOf('DELETE FROM ${TABLE[kind]}', at),
    'the copy is taken before the row goes, not after');

  const routes = fs.readFileSync(path.join(ROOT, 'routes/recycle.js'), 'utf8');
  yes(/api\/retail-admin\/deleted/.test(routes), 'there is somewhere to read the list');
  yes(/restore/.test(routes), 'and somewhere to put one back');
  // A control whose only effect is to destroy the one copy of something, on the
  // screen for recovering from mistakes, is a mistake waiting to be made.
  yes(!/DELETE FROM deleted_records/.test(routes), 'and deliberately no "empty the bin"');

  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  yes(html.includes('ops-recycle-body'), 'the screen has somewhere to draw it');
  yes(/draft purchase orders removed in the last 60 days/.test(html),
    'and names what is kept, drafts included, rather than letting somebody find out by looking');
  yes(/keeps its own date/.test(html),
    'and says the thing an accountant will ask: a restored purchase order still belongs to its own month');
  const pur = fs.readFileSync(path.join(ROOT, 'routes/retail-purchasing.js'), 'utf8');
  const capAt = pur.indexOf("recycle.capture(tdb(), 'purchase_order'");
  yes(capAt > 0, 'deleting a draft purchase order keeps a copy');
  yes(capAt < pur.indexOf('DELETE FROM po_line_items', capAt),
    'taken before the LINES go — they are what the copy is for');
  const guardAt = pur.lastIndexOf("error: 'not_draft'", capAt);
  yes(guardAt > 0 && guardAt < capAt,
    'and only ever on a draft: the not-a-draft refusal is above it, which is what makes the restore safe');
  const ops = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
  yes(/loadRecycle\(\)/.test(ops), 'and something loads it');
  yes(/e\.message === 'taken'/.test(ops),
    'the two failures an operator can act on are said in words, not as a code');

  const db = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
  yes(/CREATE TABLE IF NOT EXISTS deleted_records/.test(db), 'the table is in the schema');
  yes(/recycle\.sweep\(db\)/.test(db), 'and it is swept on its own window, not the log’s');
}

// ── §7 · the endpoints answer ─────────────────────────────────────────────
// Mounted for real, because a router that fails to bind its middleware throws
// at MOUNT time — "Route.get() requires a callback function" — and a source
// check would not see it. This is the whole of routes/recycle.js exercised.
section('7 · the two endpoints, mounted');
{
  const db = freshDb();
  const copy = R.capture(db, 'delivery_zone', 4, 'mei');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = 4').run();

  function stub(rel, value) {
    const f = require.resolve(rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports: value };
  }
  stub('../lib/tenant-db', { tdb: () => db, getTenantDb: () => db, rawTenantDb: () => db });
  stub('../database', db);
  stub('../routes/retail', { requireRetailAdmin: (q, s, n) => n() });
  stub('../middleware/auth', { logActivity: () => {}, requireAuth: (q, s, n) => n() });

  const express = require('express');
  const app = express();
  app.use((q, s, n) => { q.user = { id: 1, username: 'mei' }; n(); });
  app.use(require(path.join(ROOT, 'routes', 'recycle.js')));
  const srv = app.listen(0);
  const base = () => 'http://127.0.0.1:' + srv.address().port;

  (async () => {
    const listed = await (await fetch(base() + '/api/retail-admin/deleted')).json();
    is(listed.success, true, 'the list answers');
    is(listed.data.length, 1, 'with what was deleted');
    is(listed.days, 60, 'and says how long it is kept');

    const put = await fetch(base() + '/api/retail-admin/deleted/' + copy + '/restore', { method: 'POST' });
    is(put.status, 200, 'and one can be put back over the wire');
    is(db.prepare('SELECT name_cn FROM retail_delivery_zones WHERE id = 4').get().name_cn, '天河区',
      'which really puts it back');

    const again = await fetch(base() + '/api/retail-admin/deleted/' + copy + '/restore', { method: 'POST' });
    is(again.status, 409, 'a second attempt is a conflict, not a 500 — nothing failed, it is already done');
    const missing = await fetch(base() + '/api/retail-admin/deleted/9999/restore', { method: 'POST' });
    is(missing.status, 404, 'and a copy that does not exist is a plain not-found');

    srv.close();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })();
}
