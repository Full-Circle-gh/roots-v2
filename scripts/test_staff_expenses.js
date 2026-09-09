#!/usr/bin/env node
/**
 * Offline self-test for the staff expense claim (§87 step two).
 *
 *   node scripts/test_staff_expenses.js
 *
 * Four halves:
 *
 *   1 · THE VALIDATOR, run for real. `readBody` is exported from the shipped
 *       route and called here with a real in-memory database, the same
 *       technique scripts/test_tax.js uses on the finance summary — the rules
 *       it holds are arithmetic and a closed set, and both are the kind of
 *       thing a grep can be made to pass while the code is wrong.
 *
 *   2 · THE READS, over a fixture: what one person sees, and what the shop
 *       owes them, which is NOT the sum of what they have sent.
 *
 *   3 · THE DECISIONS, in the shipped source — the ones a later edit could
 *       quietly undo: that nothing here writes the ledger, that a submitter
 *       cannot submit an already-approved claim, that a receipt is not carried
 *       in a list, and that the key is not `finance:record`.
 *
 *   4 · THE SCREEN, in public/m.html.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ROUTE = read('routes', 'staff-expenses.js');
const SCHEMA = read('schema.sql');
const CAPS = read('lib', 'capabilities.js');
const CAPROUTES = read('lib', 'cap-routes.js');
const ROLES = read('lib', 'roles.js');
const SERVER = read('server.js');
const PHONE = read('public', 'm.html');

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const ROUTE_CODE = codeOnly(ROUTE);
const PHONE_CODE = codeOnly(PHONE);

console.log('\n1 · the validator, run for real');

// The shipped rules, required directly. NOT through the route: requiring that
// boots the express app and the dev database behind it, which this suite did
// once and left a neighbouring suite red — the reason lib/expense-claim.js is a
// file at all. What runs below is what ships, with nothing restated.
const { readBody } = require(path.join(ROOT, 'lib', 'expense-claim.js'));
const CLAIM = read('lib', 'expense-claim.js');

const vdb = new Database(':memory:');
vdb.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, sort_order INTEGER,
          is_operating INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1);`);
vdb.prepare("INSERT INTO categories VALUES (1,'accounting','Transport 交通',1,1,1)").run();

const OK = { date: '2026-09-09', amount: 38, paid_by: 'employee' };

it('a claim needs a date, an amount above zero, and an answer to who paid', () => {
  assert.ok(readBody({ ...OK, date: '' }, vdb).error, 'no date');
  assert.ok(readBody({ ...OK, date: '9 Sep' }, vdb).error, 'not a date');
  assert.ok(readBody({ ...OK, amount: 0 }, vdb).error, 'zero');
  assert.ok(readBody({ ...OK, amount: -5 }, vdb).error, 'negative');
  assert.ok(readBody({ ...OK, amount: 'taxi' }, vdb).error, 'not a number');
  assert.ok(!readBody(OK, vdb).error, 'a complete claim is accepted');
});

it('who paid is a CLOSED set — a third spelling is a debt nobody can query for', () => {
  assert.ok(!readBody({ ...OK, paid_by: 'company' }, vdb).error);
  assert.ok(!readBody({ ...OK, paid_by: 'employee' }, vdb).error);
  for (const bad of ['', 'mine', 'Employee', 'cash', null, undefined]) {
    assert.ok(readBody({ ...OK, paid_by: bad }, vdb).error, `must refuse ${JSON.stringify(bad)}`);
  }
});

it('the amount is rounded to the fen BEFORE it is stored, not after it is read', () => {
  // lib/finance-window.js's header records the residue this prevents
  // (1257.6799999999998) and the wrong penny Math.round produces on 1.005. A
  // claim is destined to become a ledger row, so a residue saved here is
  // inherited by every later reader.
  assert.strictEqual(readBody({ ...OK, amount: 1.005 }, vdb).amount, 1.01);
  assert.strictEqual(readBody({ ...OK, amount: '38.005' }, vdb).amount, 38.01);
  assert.strictEqual(readBody({ ...OK, amount: 0.1 + 0.2 }, vdb).amount, 0.3);
});

it('the category is snapped onto the shop\'s own list, spelling and all', () => {
  // The same normaliser Finance uses. A claim typed as "transport  交通" must
  // not become a second category one space away from the listed one.
  assert.strictEqual(readBody({ ...OK, category: 'transport  交通' }, vdb).category, 'Transport 交通');
  // And a category the shop never listed still STORES — the list is what the
  // form offers, never a vocabulary the writer enforces.
  assert.strictEqual(readBody({ ...OK, category: 'Parking' }, vdb).category, 'Parking');
  assert.strictEqual(readBody({ ...OK, category: '' }, vdb).category, null);
});

it('a receipt must be an image, and a big one is refused rather than stored', () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(64);
  assert.ok(!readBody({ ...OK, receipt_data: jpeg }, vdb).error, 'a small jpeg is fine');
  assert.ok(readBody({ ...OK, receipt_data: 'data:text/html;base64,AAAA' }, vdb).error, 'not an image');
  assert.ok(readBody({ ...OK, receipt_data: 'https://example.com/x.jpg' }, vdb).error, 'not a data URI');
  // Refused, never truncated: half a photograph stored is a receipt nobody can
  // read on a claim that looks like it has one.
  assert.ok(!/slice\(0, RECEIPT_MAX\)/.test(CLAIM), 'the ceiling refuses rather than trims');
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(3 * 1024 * 1024);
  assert.ok(readBody({ ...OK, receipt_data: huge }, vdb).error, 'a raw camera frame is refused');
});

it('a note is bounded, and an absent one is NULL rather than empty string', () => {
  assert.strictEqual(readBody({ ...OK, note: '' }, vdb).note, null);
  assert.strictEqual(readBody({ ...OK, note: 'x'.repeat(900) }, vdb).note.length, 500);
});

console.log('\n2 · the reads, over a fixture');

const db = new Database(':memory:');
// The real DDL, sliced out of schema.sql — never a hand-typed shape that could
// drift from the table the route writes.
const ddl = SCHEMA.match(/CREATE TABLE IF NOT EXISTS staff_expenses[\s\S]*?\n\);/);
assert.ok(ddl, 'staff_expenses must be declared in schema.sql');
// The ledger table is created too, empty, rather than the key being stripped out
// of the DDL: better-sqlite3 enforces foreign keys, and a fixture that quietly
// dropped the constraint would not be running the shape that ships.
db.exec('CREATE TABLE expense_entries (id INTEGER PRIMARY KEY);');
db.exec(ddl[0]);

const ins = db.prepare(`INSERT INTO staff_expenses
  (id, date, amount, category, paid_by, status, settled, submitted_by, receipt_data)
  VALUES (?,?,?,?,?,?,?,?,?)`);
//   mine, waiting                         mine, approved & owed
ins.run(1, '2026-09-09', 38,  'Transport', 'employee', 'submitted', 0, 7, 'data:image/jpeg;base64,AA');
ins.run(2, '2026-09-06', 52,  'Transport', 'employee', 'approved',  0, 7, null);
//   mine, approved & already settled       mine, company money — owes nobody
ins.run(3, '2026-09-02', 25,  'Transport', 'employee', 'approved',  1, 7, null);
ins.run(4, '2026-09-01', 120, 'Supplies',  'company',  'approved',  0, 7, null);
//   mine, rejected                         somebody ELSE's
ins.run(5, '2026-08-30', 90,  'Meals',     'employee', 'rejected',  0, 7, null);
ins.run(6, '2026-09-08', 400, 'Transport', 'employee', 'approved',  0, 9, null);

const mine = db.prepare(`
  SELECT id, amount, paid_by, status, settled,
         CASE WHEN receipt_data IS NULL THEN 0 ELSE 1 END AS has_receipt
    FROM staff_expenses WHERE submitted_by IS ? ORDER BY date DESC, id DESC`).all(7);

it('a claim is personal — one person sees their own and nobody else\'s', () => {
  assert.strictEqual(mine.length, 5);
  assert.ok(!mine.some(r => r.id === 6), "another employee's claim must not be in this list");
});

it('what the shop owes is NOT the sum of what was sent', () => {
  // Approved + own money + unsettled. A submitted claim might be rejected; a
  // company-account claim owes nobody; a settled one is finished.
  const owed = mine.filter(r => r.paid_by === 'employee' && r.status === 'approved' && !r.settled)
                   .reduce((t, r) => t + r.amount, 0);
  assert.strictEqual(owed, 52, 'only the approved, unsettled, own-money claim');
  const naive = mine.reduce((t, r) => t + r.amount, 0);
  assert.strictEqual(naive, 325, 'the sum of everything is a different, wrong number');
});

it('the list carries WHETHER there is a receipt, never the receipt', () => {
  assert.strictEqual(mine.find(r => r.id === 1).has_receipt, 1);
  assert.ok(!('receipt_data' in mine[0]),
    'twenty claims would otherwise drag twenty photographs into a phone to render none');
  assert.match(ROUTE_CODE, /CASE WHEN receipt_data IS NULL THEN 0 ELSE 1 END/);
});

it('the receipt route matches on the OWNER in the query, not after it', () => {
  assert.match(ROUTE_CODE, /FROM staff_expenses WHERE id = \? AND submitted_by IS \?/,
    'a fetch-then-compare is one early return away from serving anybody\'s receipt');
});

console.log('\n3 · the decisions, in the shipped source');

it('the validator is a pure module — a suite can run it without booting the app', () => {
  assert.match(ROUTE_CODE, /require\('\.\.\/lib\/expense-claim'\)/);
  assert.ok(!/require\('express'\)|tenant-db/.test(CLAIM),
    'lib/expense-claim.js must stay free of the app it serves');
});

it('nothing in this route writes the ledger', () => {
  assert.ok(!/expense_entries/.test(ROUTE_CODE),
    '§87 part one: a claim reaches the books through APPROVAL, and only there');
  assert.ok(!/INSERT INTO (?!staff_expenses)/.test(ROUTE_CODE), 'one table, and it is the claim table');
});

it('a submitter cannot submit an already-approved claim', () => {
  const insert = ROUTE_CODE.match(/INSERT INTO staff_expenses[\s\S]*?VALUES/);
  assert.ok(insert, 'the insert must be readable');
  assert.ok(!/status/.test(insert[0]),
    'status is the column default, written by the table rather than by the caller');
  assert.ok(!/decided_by|expense_id|settled/.test(insert[0]),
    'nothing a decision writes may be set by the person raising the claim');
});

it('there is no approve, reject or settle verb yet — those are step three', () => {
  for (const verb of ['approve', 'reject', 'settle']) {
    assert.ok(!new RegExp(`router\\.(post|put|patch)\\([^)]*${verb}`).test(ROUTE_CODE),
      `${verb} belongs with the screen that works it`);
  }
});

it('the capability is NOT finance:record, and carries no money mark', () => {
  const row = CAPS.match(/\{ key: 'expenses:submit'.*/);
  assert.ok(row, 'expenses:submit must be registered');
  assert.ok(!/money:/.test(row[0]),
    'submitting writes nothing to any total — the shape is waste:record');
  assert.match(CAPROUTES, /staff-expenses'\)\) return 'expenses:submit'/);
  // The floor presets hold it; none of them holds finance.
  for (const preset of ['staff', 'store_manager', 'kitchen', 'store_stock']) {
    const block = CAPS.match(new RegExp(`${preset}:\\s*\\[[\\s\\S]*?\\]`));
    assert.ok(block && /expenses:submit/.test(block[0]), `${preset} must hold it`);
    assert.ok(!/'finance:record'/.test(block[0]), `${preset} must NOT hold finance:record`);
  }
});

it('the approving key is not registered until it gates something', () => {
  assert.ok(!/expenses:approve/.test(CAPS),
    'a key in the matrix that grants nothing is a permission an owner ticks and sees no effect from');
});

it('the grant reaches roles that already exist, edited or not', () => {
  // The lesson lib/roles.js records at length: the untouched-role guard protects
  // a DECISION an admin made by unticking something, and nobody can have
  // unticked a key that did not exist yesterday. On the live box that guard
  // skipped every role there was.
  assert.match(ROLES, /function migrateExpenseSubmitCap/);
  assert.match(ROLES, /SELECT id, tenant_id, role_key, caps_json FROM tenant_roles'\)/,
    'every role, not only one role_key');
  assert.match(ROLES, /EXPENSE_SUBMIT_MIGRATION\)\) return 0;/, 'once-only through the ledger');
  const fn = ROLES.slice(ROLES.indexOf('function migrateExpenseSubmitCap'));
  assert.ok(!/WAS\.every|list\.length === /.test(fn.slice(0, 2000)),
    'no untouched-role guard: it would skip exactly the roles a real business has edited');
});

it('the route is mounted', () => {
  assert.match(SERVER, /require\('\.\/routes\/staff-expenses'\)/);
});

console.log('\n4 · the screen');

it('the phone route exists and is gated on the key its own Submit is gated on', () => {
  assert.match(PHONE_CODE, /SUBS\.expense=\{title:\['Expense','费用申请'\]/);
  assert.match(PHONE_CODE, /expense:'expenses:submit'/);
  assert.match(PHONE_CODE, /\['expense','banknote','Expense','费用申请'\]/);
});

it('the form opens empty every time — a reopened screen is not a second claim', () => {
  const reset = PHONE_CODE.match(/if\(route==='expense'\)\{[\s\S]*?\}/);
  assert.ok(reset, 'entering the screen must reset it');
  for (const f of ['amount', 'photo', 'sent', 'note']) {
    assert.ok(new RegExp(`x\\.${f}=`).test(reset[0]), `${f} must be cleared on entry`);
  }
  assert.ok(!/x\.cats=/.test(reset[0]),
    'the categories are the shop\'s vocabulary, not something this person typed');
});

it('the screen says the money is not in the accounts yet', () => {
  // §87 part one is a decision about where a claim lives; this is what it means
  // to the person pressing the button.
  assert.ok(PHONE.includes('审批通过后才会记入账目。'),
    'the line under the button, in both languages');
  assert.ok(PHONE.includes('This is not recorded in the accounts until it is approved.'));
});

it('who paid says what it does to the person tapping it', () => {
  assert.ok(PHONE.includes('审批通过后本店应付给你。'));
  assert.ok(PHONE.includes('Nothing is owed to you.'));
});

it('the photo is downscaled on the phone before it is sent', () => {
  assert.match(PHONE_CODE, /toDataURL\('image\/jpeg',0\.7\)/);
  assert.match(PHONE_CODE, /const max=1280;/);
});

it('typing the amount does not repaint the screen', () => {
  // The rule every typed field in this app follows: a field rebuilt by its own
  // typing drops the soft keyboard on a real phone.
  const cmd = PHONE_CODE.match(/reg\('expAmt',[\s\S]*?\}\);/);
  assert.ok(cmd, 'the amount command must exist');
  assert.ok(!/render\(\)/.test(cmd[0]), 'no repaint while a field is open');
});

it('an unreadable amount is refused with the reason, never stripped to its digits', () => {
  assert.match(PHONE_CODE, /if\(!\(n>0\)\)\{ x\.err=E\(/);
  assert.ok(PHONE.includes('请输入大于零的金额。'));
});

it('the shop with no categories is told, and is not given a free-text box', () => {
  // §36: an empty list cannot offer a wrong option — and the answer to an empty
  // one is not a field where every driver invents their own spelling.
  assert.ok(PHONE.includes('本店尚未设置支出分类。'));
  const screen = PHONE.slice(PHONE.indexOf('function screenExpense()'), PHONE.indexOf('function screenExpense()') + 9000);
  assert.ok(!/id="mExpCat"/.test(screen), 'no category text field');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
