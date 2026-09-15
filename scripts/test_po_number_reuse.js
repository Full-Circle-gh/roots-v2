#!/usr/bin/env node
// A purchase-order number, once issued, is never issued again.
//
// WHAT THIS GUARDS. Numbering used to be MAX over the LIVE purchase_orders
// rows. Delete the highest order and that max falls back, so the next order
// gets a number that is not free: a deleted draft is kept for sixty days
// (lib/recycle.js, audit E-07) and restore() puts it back under its ORIGINAL
// po_number. There is no unique index on po_number and restore's only clash
// check is on the row id, so the restore succeeds and two different orders —
// two suppliers, two totals — end up sharing one number in the books.
//
// The reporter's version: raise RPO-0036, delete it, raise another. The gap is
// correct. Filling the gap is the bug.
//
// Run:  node scripts/test_po_number_reuse.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// NEVER data/roots.db — scripts/ is deployed, so this file exists on the
// production box. Build a throwaway database.js of our own instead.
const SCRATCH = path.join(ROOT, `.test-scratch-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch { /* already linked */ }
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* gone */ } });

const db = require(path.join(SCRATCH, 'database.js'));
const { nextKitchenPONumber, nextRetailPONumber } = require(path.join(ROOT, 'lib', 'po-number'));
const recycle = require(path.join(ROOT, 'lib', 'recycle'));

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  — got ${got}, want ${want}`}`);
}

// A real order row, so the live-max query has something to read.
function raise(po_number, scope) {
  return db.prepare(
    `INSERT INTO purchase_orders (po_number, date, status, supplier, scope, tenant_id)
     VALUES (?, DATE('now'), 'Requested', 'Test supplier', ?, 1)`
  ).run(po_number, scope).lastInsertRowid;
}

// Start from a known floor rather than whatever the fixture happens to hold.
db.prepare("DELETE FROM purchase_orders WHERE supplier = 'Test supplier'").run();
db.prepare("DELETE FROM po_number_highwater").run();
db.prepare("DELETE FROM deleted_records WHERE kind = 'purchase_order'").run();

console.log('\n1. the two series are independent');
// Kitchen is PO-, retail is RPO-. LIKE anchors at the start of the string, so
// neither reads the other's numbers — the bug the COUNT(*) version had.
raise('RPO-0036', 'retail');
check('a retail order does not move the kitchen series', nextKitchenPONumber(db), 'PO-0001');
db.prepare("DELETE FROM po_number_highwater WHERE series = 'PO-'").run();

console.log('\n2. the reported case: delete the highest draft, raise another');
const doomedId = db.prepare("SELECT id FROM purchase_orders WHERE po_number = 'RPO-0036'").get().id;
check('next number while RPO-0036 is live', nextRetailPONumber(db), 'RPO-0037');
// Issuing is a write, so re-establish the floor before the delete to prove the
// recycle bin — not the floor — is what carries this case.
db.prepare("DELETE FROM po_number_highwater WHERE series = 'RPO-'").run();
recycle.capture(db, 'purchase_order', doomedId, 'tester');
db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(doomedId);
check('live rows no longer hold 0036',
  db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE po_number = 'RPO-0036'").get().c, 0);
check('the recycle bin still does',
  db.prepare("SELECT COUNT(*) AS c FROM deleted_records WHERE kind = 'purchase_order'").get().c, 1);
check('the deleted number is NOT reissued', nextRetailPONumber(db), 'RPO-0037');

console.log('\n3. and a restore cannot now collide');
raise('RPO-0037', 'retail');
const restored = recycle.restore(db,
  db.prepare("SELECT id FROM deleted_records WHERE kind = 'purchase_order'").get().id, 'tester');
check('the draft restores', restored && restored.ok === true, true);
check('exactly one order carries RPO-0036',
  db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE po_number = 'RPO-0036'").get().c, 1);

console.log('\n4. the floor outlives the recycle copy (sixty-day sweep)');
// Delete 0037 AND forget the copy, which is what the sweep does. Only the
// high-water row is left to remember that 0037 was ever handed out.
const id37 = db.prepare("SELECT id FROM purchase_orders WHERE po_number = 'RPO-0037'").get().id;
db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id37);
db.prepare("DELETE FROM deleted_records WHERE kind = 'purchase_order'").run();
check('0037 is gone from live rows and from the bin',
  db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE po_number = 'RPO-0037'").get().c, 0);
check('it is still not reissued', nextRetailPONumber(db), 'RPO-0038');

console.log('\n5. two numbers in one request, neither INSERTed yet');
// A kitchen copy fans out into several retail drafts inside one transaction.
// Under MAX-over-live both got the same number until the first INSERT landed.
const a = nextRetailPONumber(db);
const b = nextRetailPONumber(db);
check('the first is RPO-0039', a, 'RPO-0039');
check('the second is not the same number', b, 'RPO-0040');

console.log('\n6. gaps are kept, and that is the point');
check('nothing ever went back to fill 0001..0035', nextRetailPONumber(db), 'RPO-0041');

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
