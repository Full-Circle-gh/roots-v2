#!/usr/bin/env node
/**
 * Offline self-test for returns on money out (§269).
 *
 *   node scripts/test_expense_returns.js
 *
 * `lib/expense-returns.js` and `lib/expense-posting.js` are run for real against
 * an in-memory ledger. The properties that matter are arithmetic — a return
 * nets the category, cannot exceed the spend, follows its claim's category, and
 * moves the owed figure the right way — so they are tested as behaviour.
 * Then the shipped routes and screen are checked for the wiring a later edit
 * could quietly undo.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const R = require('../lib/expense-returns');
const { postClaim } = require('../lib/expense-posting');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE expense_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE NOT NULL, amount REAL NOT NULL,
      category TEXT, description TEXT, po_id INTEGER, created_at DATETIME, created_by INTEGER,
      payment_method TEXT, updated_at DATETIME, claim_id INTEGER, store_id INTEGER,
      returns_entry_id INTEGER, returns_claim_id INTEGER, return_reason TEXT, return_settled INTEGER);
    CREATE TABLE staff_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE NOT NULL, amount REAL NOT NULL,
      category TEXT, note TEXT, paid_by TEXT NOT NULL DEFAULT 'employee', payment_method TEXT,
      store_id INTEGER, status TEXT NOT NULL DEFAULT 'submitted', settled INTEGER NOT NULL DEFAULT 0,
      settled_at DATETIME, submitted_by INTEGER, decided_by INTEGER, awaiting_delivery INTEGER,
      po_id INTEGER, expense_id INTEGER);`);
  return db;
}
const claimRow = (db, id) => db.prepare('SELECT * FROM staff_expenses WHERE id = ?').get(id);
function approvedClaim(db, { amount = 19, paid_by = 'employee', settled = 0, who = 7, category = '其他费用' } = {}) {
  const id = db.prepare(`INSERT INTO staff_expenses (date, amount, category, note, paid_by, status, settled, submitted_by, decided_by)
                         VALUES ('2026-09-20', ?, ?, 'glass cups', ?, 'approved', ?, ?, 1)`)
    .run(amount, category, paid_by, settled, who).lastInsertRowid;
  const eid = postClaim(db, claimRow(db, id));
  return { claimId: id, entryId: eid };
}
const sumCat = (db, cat) => db.prepare('SELECT ROUND(COALESCE(SUM(amount),0),2) AS t FROM expense_entries WHERE category = ?').get(cat).t;
const owed = (db) => db.prepare(`${R.OWED_SQL} GROUP BY c.submitted_by HAVING ROUND(total, 2) <> 0`).all()
  .map(o => ({ who: o.submitted_by, total: Math.round(o.total * 100) / 100 }));
const body = (o = {}) => ({ date: '2026-09-26', amount: 19, reason: 'not_needed', ...o });

console.log('\n1 · a return nets the spend, under the same category');
it('a claim return writes one negative row and the category nets to zero', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db);
  const out = R.recordReturn(db, entryId, body(), 3);
  assert.ok(out.id, JSON.stringify(out));
  assert.strictEqual(sumCat(db, '其他费用'), 0);
  const row = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(out.id);
  assert.strictEqual(row.amount, -19);
  assert.strictEqual(row.returns_claim_id, 1);
  assert.strictEqual(row.returns_entry_id, null);
  assert.strictEqual(row.claim_id, null, 'a return must never carry claim_id — postClaim would delete it');
});
it('a typed row can be returned in part', () => {
  const db = fixture();
  const id = db.prepare("INSERT INTO expense_entries (date, amount, category) VALUES ('2026-09-01', 100, 'Supplies')").run().lastInsertRowid;
  assert.ok(R.recordReturn(db, id, body({ amount: 30.1 }), 1).id);
  assert.strictEqual(sumCat(db, 'Supplies'), 69.9);
  assert.strictEqual(R.returnedMinor(db, { entryId: id }), 3010);
});

console.log('\n2 · what it refuses');
it('more than was spent, across several returns', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db);
  assert.ok(R.recordReturn(db, entryId, body({ amount: 10 }), 1).id);
  const r = R.recordReturn(db, entryId, body({ amount: 9.01 }), 1);
  assert.strictEqual(r.error, R.ERR.tooMuch);
  assert.ok(R.recordReturn(db, entryId, body({ amount: 9 }), 1).id, 'exactly what is left is fine');
});
it('a purchase-order row — Purchasing returns those', () => {
  const db = fixture();
  const id = db.prepare("INSERT INTO expense_entries (date, amount, po_id) VALUES ('2026-09-01', 50, 4)").run().lastInsertRowid;
  assert.strictEqual(R.recordReturn(db, id, body(), 1).error, R.ERR.poEdit);
});
it('a return of a return', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db);
  const first = R.recordReturn(db, entryId, body({ amount: 5 }), 1);
  assert.strictEqual(R.recordReturn(db, first.id, body({ amount: 1 }), 1).status, 404);
});
it('no reason, an unknown reason, a zero amount, no date', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db);
  assert.strictEqual(R.recordReturn(db, entryId, body({ reason: '' }), 1).error, R.ERR.reason);
  assert.strictEqual(R.recordReturn(db, entryId, body({ reason: 'damaged' }), 1).error, R.ERR.reasonInvalid);
  assert.strictEqual(R.recordReturn(db, entryId, body({ amount: 0 }), 1).error, R.ERR.amount);
  assert.strictEqual(R.recordReturn(db, entryId, body({ date: '' }), 1).error, R.ERR.date);
});

console.log('\n3 · a return follows its claim when the claim is re-filed (§146)');
it('re-posting the claim under a new category moves the return with it', () => {
  const db = fixture();
  const { claimId, entryId } = approvedClaim(db);
  R.recordReturn(db, entryId, body({ amount: 4 }), 1);
  db.prepare("UPDATE staff_expenses SET category = 'Tableware' WHERE id = ?").run(claimId);
  postClaim(db, claimRow(db, claimId));
  assert.strictEqual(sumCat(db, '其他费用'), 0);
  assert.strictEqual(sumCat(db, 'Tableware'), 15);
  assert.strictEqual(R.returnedMinor(db, { claimId }), 400, 're-posting must not delete the return');
});

console.log('\n4 · who holds the money');
it('claim NOT yet paid back: the shop simply owes less', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db, { amount: 50 });
  const r = R.recordReturn(db, entryId, body({ amount: 19 }), 1);
  assert.strictEqual(r.open, false);
  assert.deepStrictEqual(owed(db), [{ who: 7, total: 31 }]);
});
it('a claim returned in full while unpaid drops off the owed list', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db);
  R.recordReturn(db, entryId, body(), 1);
  assert.deepStrictEqual(owed(db), []);
});
it('claim ALREADY paid back: the employee now owes the shop', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db, { settled: 1 });
  const r = R.recordReturn(db, entryId, body(), 1);
  assert.strictEqual(r.open, true);
  assert.deepStrictEqual(owed(db), [{ who: 7, total: -19 }]);
});
it('marking that claim settled records the refund handed over', () => {
  const db = fixture();
  const { claimId, entryId } = approvedClaim(db, { settled: 1 });
  R.recordReturn(db, entryId, body(), 1);
  R.settleClaimReturns(db, claimId);
  assert.deepStrictEqual(owed(db), []);
});
it('owed and owing net per person', () => {
  const db = fixture();
  const a = approvedClaim(db, { settled: 1 });          // paid back, then returned → −19
  approvedClaim(db, { amount: 40 });                     // still owed → +40
  R.recordReturn(db, a.entryId, body(), 1);
  assert.deepStrictEqual(owed(db), [{ who: 7, total: 21 }]);
});
it('a company-paid claim owes nobody either way', () => {
  const db = fixture();
  const { entryId } = approvedClaim(db, { paid_by: 'company', settled: 0 });
  assert.strictEqual(R.recordReturn(db, entryId, body(), 1).open, false);
  assert.deepStrictEqual(owed(db), []);
});

console.log('\n5 · the wiring in the shipped files');
const TX = read('routes', 'finance-transactions.js');
const SE = read('routes', 'staff-expenses.js');
const FIN = read('public', 'retail-admin', '22-finance.js');
const DBJS = read('database.js');
const VOCAB = read('docs', 'tacet-delivery-vocabulary.md');
it('the four columns are migrations in database.js', () => {
  for (const c of ['returns_entry_id', 'returns_claim_id', 'return_reason', 'return_settled']) {
    assert.ok(DBJS.includes(`addColumn('expense_entries', '${c}'`), c);
  }
});
it('the route exists and writes through lib/expense-returns.js', () => {
  assert.ok(TX.includes("'/api/retail-admin/finance/transactions/out/:id/return'"));
  assert.ok(TX.includes('expenseReturns.recordReturn('));
});
it('the typed-row list excludes returns, so a return is never offered Edit', () => {
  assert.ok(/claim_id IS NULL\s+AND returns_entry_id IS NULL AND returns_claim_id IS NULL/.test(TX));
});
it('a return is deleted without a recycle copy, and a row with a return cannot be deleted', () => {
  assert.ok(TX.includes('found.isReturn'));
  assert.ok(TX.includes("expenseReturns.hasReturns(db, { entryId: Number(id) })"));
});
it('void and re-decide refuse a claim with a return; settle absorbs its returns', () => {
  assert.strictEqual((SE.match(/expenseReturns\.hasReturns\(db, \{ claimId: claim\.id \}\)/g) || []).length, 2);
  assert.ok(SE.includes('expenseReturns.settleClaimReturns(db, claim.id)'));
  assert.ok(SE.includes('expenseReturns.OWED_SQL'));
});
it('the screen offers Return and a way to delete a return', () => {
  assert.ok(FIN.includes('finTxReturn('));
  assert.ok(FIN.includes('finTxDeleteReturn('));
  assert.ok(FIN.includes('/api/retail-admin/finance/transactions/out/${Number(row.id)}/return'));
  assert.ok(FIN.includes("/api/retail-admin/finance/transactions/out/${Number(id)}`, { method: 'DELETE' }"));
});
it('the phone shows owing the shop, in the owed list, the settle confirm, and your own screen', () => {
  const PHONE = read('public', 'm.html');
  assert.ok(PHONE.includes("const owed=(a.owed||[]).filter(o=>Number(o.total)!==0);"), 'negative totals are listed');
  assert.ok(PHONE.includes("T('Mark recovered','标记已收回')"), 'with their own verb');
  assert.ok(PHONE.includes("T('Recovered ¥'+abs+'?','已收回 ¥'+abs+'？')"), 'and their own confirm');
  assert.ok(PHONE.includes(":x.owed<0?"), 'the staff screen says when they owe the shop');
  assert.ok(PHONE.includes("(Number(r.amount)-Number(r.returned||0))>0"), 'the Owed pill nets returns');
  assert.ok(PHONE.includes("T('Owes the shop','应退还店里')"));
});
it('the return amount starts empty, says what goes in it, and the row shows its net', () => {
  assert.ok(!/id="fin-rt-amount"[^>]*value=/.test(FIN), 'the amount box is not prefilled');
  assert.ok(FIN.includes('只填卖家实际退回的金额。运费没退就不要算进去。'), 'the hint is under it');
  assert.ok(FIN.includes("if (!(Number(val('#fin-rt-amount')) > 0))"), 'an empty box is caught before the request');
  assert.ok(FIN.includes("cuT('Net', '净额')") && FIN.includes('finTxReturnLeft(r)'), 'the returned row shows its net');
});
it('every composed string is declared in the vocabulary', () => {
  for (const cn of ['退货金额不能超过支出金额', '该笔已登记退货，请先删除退货', '应退还店里', '标记已收回', '只填卖家实际退回的金额。运费没退就不要算进去。']) {
    assert.ok(VOCAB.includes(cn), cn);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
