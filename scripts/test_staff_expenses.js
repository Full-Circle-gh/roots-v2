#!/usr/bin/env node
/**
 * Offline self-test for the staff expense claim (§87 steps two and three).
 *
 *   node scripts/test_staff_expenses.js
 *
 * Five sections:
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
 *
 *   5 · APPROVAL AND THE ROW IT POSTS. `lib/expense-posting.js` is run against a
 *       fixture ledger — it is the one place a claim reaches the books, and the
 *       properties that matter (one row, re-postable, removed on reject) are
 *       behaviour rather than text.
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

it('the receipt route matches on the OWNER in the query, not after it — and an approver is an owner too (§109)', () => {
  assert.match(ROUTE_CODE, /FROM staff_expenses WHERE id = \? AND submitted_by IS \?/,
    'a fetch-then-compare is one early return away from serving anybody\'s receipt');
  // §109: an approver's branch drops the submitted_by filter entirely — the
  // ownership test is still IN the query, it is just a different query,
  // chosen by the same `isApprover` predicate `/pending` and `/decide` gate on.
  assert.match(ROUTE_CODE, /isApprover\(req\)\s*\n\s*\?\s*db\.prepare\('SELECT receipt_data FROM staff_expenses WHERE id = \?'\)/,
    'an approver must reach any claim\'s receipt, not just their own');
  assert.match(ROUTE_CODE, /function isApprover\(req\)/,
    'one predicate, shared by /pending, /decide and the receipt route — not three copies drifting');
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

  /* THE TABLE RULE, NARROWED BY §114 RATHER THAN DROPPED.
     It used to read "one table, and it is the claim table". That was the right
     shape while a claim could only ever become a ledger row — but §114 lets an
     APPROVAL raise an Ordered purchase order for goods that have not arrived, so
     this file now writes `purchase_orders` and `po_line_items` too.

     WHAT THE RULE WAS PROTECTING IS UNCHANGED and is now asserted more exactly
     than before: the claim must not reach the books except through a decision.
     So the allowed set is named, the two new tables are pinned to the function
     that raises the order, and the SUBMIT path is checked on its own below —
     which is the assertion that actually carries §87 part one, and which the old
     file-wide regex only ever implied. */
  const inserts = [...ROUTE_CODE.matchAll(/INSERT INTO (\w+)/g)].map(m => m[1]);
  const allowed = new Set(['staff_expenses', 'purchase_orders', 'po_line_items']);
  for (const t of inserts) {
    assert.ok(allowed.has(t), `this file may not write ${t}`);
  }
  // §270 split raiseOrderForClaim into openClaimOrder + addClaimLine so one
  // order can carry several claims. The rule is unchanged: each table is still
  // written in exactly one place, and that place is the order helpers.
  const raise = ROUTE_CODE.match(/function raiseOrderForClaim[\s\S]*?function addClaimLine[\s\S]*?\n}/);
  assert.ok(raise, 'the order-raising helpers must be readable');
  for (const t of ['purchase_orders', 'po_line_items']) {
    assert.strictEqual(ROUTE_CODE.split('INSERT INTO ' + t).length - 1, 1,
      `${t} is written in exactly one place`);
    assert.ok(raise[0].includes('INSERT INTO ' + t),
      `${t} is written only by the order helpers`);
  }
});

it('only a DECISION can raise an order — the submit path writes the claim and nothing else', () => {
  /* §114's half of §87 part one. An approval may now create a purchase order
     that carries real money; a submission still may not create anything but a
     waiting claim, whatever its sender puts in the body. */
  const submit = ROUTE_CODE.match(/router\.post\('\/api\/retail-admin\/staff-expenses',[\s\S]*?\n}\);/);
  assert.ok(submit, 'the submit route must be readable');
  const tables = [...submit[0].matchAll(/INSERT INTO (\w+)/g)].map(m => m[1]);
  assert.deepStrictEqual(tables, ['staff_expenses'],
    'the submit path writes the claim table and nothing else');
  assert.ok(!/raiseOrderForClaim|postRetailPOExpenses|postClaim/.test(submit[0]),
    'and it reaches none of the things a decision does');
});

it('a submitter cannot submit an already-approved claim', () => {
  const insert = ROUTE_CODE.match(/INSERT INTO staff_expenses[\s\S]*?VALUES/);
  assert.ok(insert, 'the insert must be readable');
  assert.ok(!/status/.test(insert[0]),
    'status is the column default, written by the table rather than by the caller');
  assert.ok(!/decided_by|expense_id|settled/.test(insert[0]),
    'nothing a decision writes may be set by the person raising the claim');
});

it('the submitting route cannot decide anything', () => {
  // The verbs exist now (steps three and four) and are separate routes behind a
  // separate key. What must stay true is that the SUBMIT path reaches none of
  // them: a claim arrives waiting, whatever its sender puts in the body.
  const post = ROUTE_CODE.slice(ROUTE_CODE.indexOf("router.post('/api/retail-admin/staff-expenses'"),
                                ROUTE_CODE.indexOf('staff-expenses/mine'));
  // `res.status(…)` is an HTTP helper, not the claim's column — stripped first,
  // because an assertion that matches the wrong `status` proves nothing about
  // this handler and would go green on a version that did write the real one.
  const noHttp = post.replace(/res\.status\(/g, 'res.httpCode(');
  assert.ok(!/status|settled|decided_by|expense_id|postClaim/.test(noHttp),
    'the submit handler must not touch a single field a decision writes');
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

it('§114 — the form asks whether it has arrived, and sends the answer', () => {
  assert.match(PHONE_CODE, /APP\.cmd\('expComing'\)/, 'the opt-in is on the form');
  assert.match(PHONE_CODE, /awaiting_delivery:!!x\.coming/, 'and the answer reaches the server');
  // AN OPT-IN, NOT A PAIR OF CHIPS. Unticked has to mean exactly what this form
  // has always meant, or every claim ever submitted changes meaning — so there
  // is no "it has arrived" chip to be the other half of a default. Counted on
  // the COMMANDS rather than on the file's Chinese: `已到货` is live on the
  // receiving screen ("N arrived"), which is a different screen saying a
  // different thing, and an assertion that tripped over it would be measuring
  // the wrong file.
  assert.strictEqual(PHONE_CODE.split("APP.cmd('expComing')").length - 1, 1,
    'one control, once');
  assert.ok(!/expArrived|expNotComing/.test(PHONE_CODE), 'and no opposite command to pair it with');
});

it('§114 — the two things an order cannot do without are refused on the phone too', () => {
  // The server is the rule (lib/expense-claim.js); this is the same rule said
  // sooner, so the person is told beside the control rather than after a round
  // trip. Both sentences are the server's own.
  const send = PHONE_CODE.match(/reg\('expSend'[\s\S]*?\n\}\);/);
  assert.ok(send, 'the send command must be readable');
  assert.ok(/x\.coming && !x\.storeId/.test(send[0]), 'no shop is refused');
  assert.ok(/x\.coming && !String\(x\.note\|\|''\)\.trim\(\)/.test(send[0]), 'no description is refused');
  assert.match(CLAIM, /awaitingDelivery && !storeId/, 'and the server refuses it regardless');
  assert.match(CLAIM, /awaitingDelivery && !note/, 'both of them');
});

it('§114 — the flag does not survive onto the next claim', () => {
  // "Record another" keeps who paid and which shop — facts about the person —
  // and clears what the claim was. Whether the LAST thing was still coming says
  // nothing about the next one, and a sticky flag would silently raise an order
  // for a taxi.
  assert.match(PHONE_CODE, /x\.cat=''; x\.coming=false;/,
    'the reset clears it with the amount and the note');
});

it('§114 — the approver is told before deciding, and can reach the order after', () => {
  const FIN = codeOnly(read('public', 'retail-admin', '22-finance.js'));
  assert.match(FIN, /goes on a purchase order', '将记入采购单'/,
    'the meta line says approving this raises one');
  assert.match(FIN, /finTxOpenPO\(\$\{Number\(r\.po_id\)\}\)/,
    'and once raised, the row opens it — the claim has no ledger row of its own to read');
});

it('§114 — the terms the two composed strings were built from are still live', () => {
  /* The house rule for a composed pair: say where its Chinese came from, and
     FAIL if that source stops being live, so a rename cannot quietly orphan the
     composition. `到货` is `Arrives · 到货` on the purchasing screen and the
     phone's own receiving screen; `尚未` is `Not on any purchase order yet. ·
     尚未出现在任何采购单中。` on the materials screen. Recorded in
     docs/tacet-delivery-vocabulary.md v1.72.

     `记入采购单` WAS DECLARED AGAINST v1.70's `该笔记入采购单` — the toast §111 part
     two showed on an already-answered category — and §160 withdrew that whole
     mechanism, which made THIS CASE FAIL. That is the guard doing its job. The
     term is not orphaned: ERR.onOrder in routes/staff-expenses.js is live, is
     older than these compositions, and is where v1.81's sibling refusal already
     lifted its first half from. The anchor moves there; neither composed string
     changes. See v1.111 for the full note. */
  const PURCH = read('public', 'retail-admin', '16-purchasing.js');
  assert.ok(/'Arrives', ?'到货'/.test(PURCH), '到货 must stay live where it was taken from');
  const MATS = read('public', 'retail-admin', '18-materials.js');
  assert.ok(/尚未出现在任何采购单中/.test(MATS), '尚未 must stay live where it was taken from');
  assert.ok(/该笔已记入采购单/.test(ROUTE), '记入采购单 must stay live where it is now taken from');
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

it('§226 — who paid defaults to the company, from ONE constant', () => {
  // Ash, 2026-09-22: *"defult should be company money. not own money"*. The
  // value itself is the assertion — this is the field that decides whether the
  // business owes a person, and a default flipped back by a later edit would be
  // invisible on a screen that looks identical either way.
  assert.match(PHONE_CODE, /const EXP_PAID_DEFAULT = 'company';/,
    'the default is company money, named once');
  // TWO PLACES SET IT — the state literal and the reset run on every entry to
  // the screen — and both must read the constant. A literal in either is how
  // the two halves drift and the form opens on one answer the second time.
  assert.ok(!/paid *[:=] *'employee'/.test(PHONE_CODE),
    'no hard-coded employee default anywhere on the form');
  assert.strictEqual(PHONE_CODE.split('EXP_PAID_DEFAULT').length - 1, 3,
    'declared once and read by both the initial state and the entry reset');
  const reset = PHONE_CODE.match(/if\(route==='expense'\)\{[\s\S]*?\}/);
  assert.match(reset[0], /x\.paid=EXP_PAID_DEFAULT;/,
    'entering the screen resets who paid to the default, not to what was left');
  // WHAT THE DEFAULT COSTS WHEN IT IS WRONG IS STATED ON SCREEN, which is what
  // makes either default recoverable: the sentence under the chips re-renders
  // with the choice, and §207 lets the approver correct it in both directions.
  assert.ok(PHONE.includes('由本店账户支付，无需付给你。'),
    'the company half of the consequence line is live');
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

console.log('\n5 · approval, and the row it posts (step three)');

const POST = require(path.join(ROOT, 'lib', 'expense-posting.js'));
const POSTING = read('lib', 'expense-posting.js');
const FINTX = read('routes', 'finance-transactions.js');
const FINTX_CODE = codeOnly(FINTX);
const CLIENT = read('public', 'retail-admin', '22-finance.js');

const pdb = new Database(':memory:');
pdb.exec(`
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, amount REAL, category TEXT,
    description TEXT, po_id INTEGER, payment_method TEXT, store_id INTEGER,
    claim_id INTEGER, created_by INTEGER,
    -- §269: a return is a negative row pointing at its claim; postClaim moves it.
    returns_entry_id INTEGER, returns_claim_id INTEGER
  );`);
const claim = {
  id: 41, date: '2026-09-09', amount: 38, category: 'Transport 交通',
  note: 'airport run', submitted_name: 'Wei', status: 'approved',
  paid_by: 'employee', store_id: 3, payment_method: null, decided_by: 2,
};

it('approving writes exactly ONE ledger row, carrying the claim id', () => {
  const id = POST.postClaim(pdb, claim);
  const rows = pdb.prepare('SELECT * FROM expense_entries WHERE claim_id = 41').all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, id);
  assert.strictEqual(rows[0].amount, 38);
  assert.strictEqual(rows[0].category, 'Transport 交通');
  assert.strictEqual(rows[0].store_id, 3, '§87 part three: the claim carries the shop to the ledger');
});

it('the row says who spent it — a line with no supplier and no PO behind it', () => {
  const row = POST.postedRow(pdb, 41);
  const full = pdb.prepare('SELECT description, created_by FROM expense_entries WHERE claim_id = 41').get();
  assert.ok(row);
  assert.match(full.description, /Wei/, 'the name is what makes the line answerable months later');
  assert.match(full.description, /airport run/);
  // `created_by` on this table has always meant "who put this in the books".
  assert.strictEqual(full.created_by, 2, 'the approver, not the person who spent it');
});

it('approving twice re-posts rather than double-posting', () => {
  POST.postClaim(pdb, claim);
  POST.postClaim(pdb, claim);
  assert.strictEqual(pdb.prepare('SELECT COUNT(*) n FROM expense_entries WHERE claim_id = 41').get().n, 1,
    'the PO shape: delete every row carrying this id, then re-insert from the document');
});

it('rejecting after approving REMOVES the row rather than writing a negative one', () => {
  const gone = POST.postClaim(pdb, { ...claim, status: 'rejected' });
  assert.strictEqual(gone, null);
  assert.strictEqual(pdb.prepare('SELECT COUNT(*) n FROM expense_entries WHERE claim_id = 41').get().n, 0);
  // §36 decided a hand-typed row is freely deletable because mistakes here are
  // typos; an offsetting entry turns a two-row ledger into four nobody can read.
  assert.ok(!/-\s*amount|amount \* -1/.test(codeOnly(POSTING)), 'no reversal row');
});

it('a claim-posted row is NOT hand-typed, and the predicate says so', () => {
  // The trap §87 named when the claim table was designed: a claim-posted row
  // satisfies `po_id IS NULL`, so before `claim_id` was named here it arrived on
  // the Transactions screen looking freely editable — and the edit would have
  // been undone by the next decision.
  assert.match(FINTX_CODE, /WHERE po_id IS NULL AND claim_id IS NULL/);
  assert.match(FINTX_CODE, /row\.claim_id != null/, 'edit and delete refuse it too');
  assert.match(FINTX_CODE, /claimEdit|claimDelete/);
});

it('the screen refuses it visibly rather than merely enforcing it', () => {
  const code = codeOnly(CLIENT);
  assert.match(code, /const claim = r\.source === 'claim';/);
  assert.match(code, /row\.source === 'manual'/,
    "`!== 'po'` reads the same with one projection and is the bug with two");
  assert.ok(CLIENT.includes('费用申请 · 个人支付'), 'whose money it was is on the mark');
});

it('the approving key exists now, moves money, and is in no floor preset', () => {
  const row = CAPS.match(/\{ key: 'expenses:approve'.*/);
  assert.ok(row, 'expenses:approve must be registered');
  assert.match(row[0], /money: 'moves'/, 'this is the tap that writes the ledger');
  for (const preset of ['staff', 'store_manager', 'kitchen', 'store_stock', 'warehouse']) {
    const block = CAPS.match(new RegExp(`${preset}:\\s*\\[[\\s\\S]*?\\]`));
    assert.ok(block && !/expenses:approve/.test(block[0]), `${preset} must NOT approve by default`);
  }
});

it('the decide route is gated ABOVE the submit route, and the order is the guard', () => {
  const i = CAPROUTES.indexOf("return 'expenses:approve'");
  const j = CAPROUTES.indexOf("return 'expenses:submit'");
  assert.ok(i > -1 && j > -1 && i < j,
    'below the general rule, every submitter would be an approver');
  // And the route does not rely on that alone: rbac_enforce is off by default,
  // so a money route that fell open would let anyone approve on every tenant.
  assert.match(ROUTE_CODE, /function requireApprover/);
  assert.match(ROUTE_CODE, /requireRetailAdmin, requireApprover/);
});

it('a settled claim can no longer be un-approved', () => {
  // Money has changed hands outside this system. Taking the expense back out
  // would leave the payment made and the cost unrecorded.
  assert.match(ROUTE_CODE, /if \(claim\.settled\) return res\.status\(409\)/);
});

it('the claim status and the ledger row move together or not at all', () => {
  assert.match(ROUTE_CODE, /withTransaction\(db, \(tx\) => \{[\s\S]*?postClaim\(tx, fresh\)/,
    'a claim that says approved with no row behind it is a discrepancy nobody would find');
  assert.match(ROUTE_CODE, /const fresh = tx\.prepare/,
    'posted from the row as it now stands, not the one read before the update');
});

it('the route gives the ledger row the spender\'s name — the lib cannot find it alone', () => {
  // THE FIXTURE ABOVE HANDS `submitted_name` OVER BY HAND, and for months that
  // was the ONLY place it was ever set. A `staff_expenses` row carries the
  // integer `submitted_by` and nothing else, so `claimDescription`'s name branch
  // was dead in production and every posted row said the note alone — §87's
  // "who spent it is in the description" true in the lib and false in the books.
  // The lib test passing is exactly what hid it, so this one reads the route.
  assert.match(ROUTE_CODE, /const submittedName = submitterNames\(\[claim\.submitted_by\]\)/,
    'resolved from submitted_by through the one lookup the approval queue also uses');
  assert.match(ROUTE_CODE, /fresh\.submitted_name\s*=/,
    'and set on the row postClaim is actually handed');
  // OUTSIDE THE TRANSACTION. It reads the control-plane handle, and a
  // cross-handle read held inside a tenant write adds a second database's
  // latency to a lock this one is holding, for a value the write cannot fail on.
  const decide = ROUTE_CODE.slice(ROUTE_CODE.indexOf("decision !== 'approve'"));
  assert.ok(decide.indexOf('const submittedName') >= 0
         && decide.indexOf('const submittedName') < decide.indexOf('withTransaction(db'),
    'the control-plane read happens before the tenant transaction opens');
});

it('one name lookup serves both the queue and the books', () => {
  // Two reads of `tenant_users` shaped slightly differently are two things that
  // can drift, and the drift would show as a screen and a ledger naming the same
  // claim differently.
  //
  // §92 MOVED THE LOOKUP OUT OF THIS ROUTE AND THE ASSERTION FOLLOWED IT, rather
  // than being deleted for going red. Finance's ledger became a third reader in
  // a SECOND route file, so §87's one function had to become one FILE — and the
  // property this test defends is now stronger, not weaker: the route carries no
  // copy of the query at all, and the one it calls is the one the ledger calls.
  assert.strictEqual((ROUTE_CODE.match(/FROM tenant_users/g) || []).length, 0,
    'the query lives in lib/user-names.js, never inline here');
  assert.ok(/require\('\.\.\/lib\/user-names'\)/.test(ROUTE_CODE),
    'and this route resolves names through it');
  const LIB = fs.readFileSync(path.join(ROOT, 'lib', 'user-names.js'), 'utf8');
  assert.strictEqual((LIB.match(/FROM tenant_users/g) || []).length, 1,
    'exactly one place in the codebase turns an id into a name');
});

it('the approval list is a different route from the personal one', () => {
  assert.match(ROUTE_CODE, /staff-expenses\/pending/);
  assert.match(ROUTE_CODE, /staff-expenses\/mine/);
  // A flag on one endpoint is one typo away from handing every submitter the
  // whole shop's spending.
  assert.ok(!/req\.query\.(all|everyone|scope)/.test(ROUTE_CODE));
});

it('whose claim it is, is decided by the server', () => {
  assert.match(ROUTE_CODE, /mine: r\.submitted_by != null && r\.submitted_by === \(req\.user\?\.id \|\| null\)/);
  assert.match(PHONE_CODE, /const mine=!!r\.mine;/);
  // The phone has no operator id to compare against — this is why.
  assert.ok(!/state\.me&&state\.me\.id/.test(PHONE_CODE));
});

it('self-approval is allowed, and marked', () => {
  assert.ok(PHONE.includes('本人提交'), '§87 part five: the guard is the record, not the refusal');
  assert.ok(!/cannot approve your own|不能审批自己/.test(PHONE), 'no refusal of self-approval');
  assert.match(ROUTE_CODE, /self: claim\.submitted_by === decidedBy/, 'and it is logged as such');
});

it('the phone screen says what approving does', () => {
  assert.ok(PHONE.includes('审批通过后即记入本月账目。'),
    'the mirror of the line under Submit on the other screen');
});

console.log('\n5b · voiding a posted claim (§90)');

it('voiding removes the ledger row without writing rejected over it', () => {
  POST.postClaim(pdb, claim); // re-post so a row exists to void
  const gone = POST.postClaim(pdb, { ...claim, status: 'voided' });
  assert.strictEqual(gone, null, 'the same non-approved branch rejected already takes');
  assert.strictEqual(pdb.prepare('SELECT COUNT(*) n FROM expense_entries WHERE claim_id = 41').get().n, 0);
});

it('the void route is its own capability, checked above the generic prefix', () => {
  const i = CAPROUTES.indexOf("return 'expenses:cancel'");
  const j = CAPROUTES.indexOf("return 'expenses:submit'");
  assert.ok(i > -1 && j > -1 && i < j,
    'below the general rule, the money-reversing route would answer expenses:submit');
  assert.match(CAPROUTES, /\/staff-expenses\\\/\\d\+\\\/void\$\/\.test\(P\)/);
});

it('the void route exists, is gated apart from approve, and fails closed', () => {
  assert.match(ROUTE_CODE, /function requireCanceller/);
  assert.match(ROUTE_CODE, /requireRetailAdmin, requireCanceller/);
  assert.match(ROUTE_CODE, /req\.caps\.has\('expenses:cancel'\)/);
  // Not the approver's gate — the whole reason the key exists.
  const voidFn = ROUTE_CODE.slice(ROUTE_CODE.indexOf('function requireCanceller'));
  const body = voidFn.slice(0, voidFn.indexOf('router.post'));
  assert.ok(!/expenses:approve/.test(body), 'requireCanceller must not fall back to the approver key');
});

it('only an approved, unsettled claim can be voided', () => {
  const voidRoute = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/void"));
  const body = voidRoute.slice(0, voidRoute.indexOf('module.exports'));
  assert.match(body, /claim\.status !== 'approved'/);
  assert.match(body, /if \(claim\.settled\) return res\.status\(409\)/,
    'the same settled guard /decide already enforces');
});

it('voiding writes its own columns rather than overwriting who approved it', () => {
  const voidRoute = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/void"));
  const body = voidRoute.slice(0, voidRoute.indexOf('module.exports'));
  assert.match(body, /SET status = 'voided', voided_by = \?, voided_at = datetime\('now'\), void_note = \?/);
  assert.ok(!/decided_by\s*=\s*\?/.test(body), 'decided_by is not touched — it still says who approved it');
});

it('the schema carries voided_by/voided_at/void_note beside decided_by, never in place of it', () => {
  assert.match(SCHEMA, /voided_by\s+INTEGER/);
  assert.match(SCHEMA, /voided_at\s+DATETIME/);
  assert.match(SCHEMA, /void_note\s+TEXT/);
});

it('the capability exists, moves money, and is distinct from expenses:approve', () => {
  const row = CAPS.match(/\{ key: 'expenses:cancel'.*/);
  assert.ok(row, 'expenses:cancel must be registered');
  assert.match(row[0], /money: 'moves'/, 'this is what removes a posted row from the books');
  for (const preset of ['staff', 'store_manager', 'kitchen', 'store_stock', 'warehouse', 'admin', 'manager']) {
    const block = CAPS.match(new RegExp(`${preset}:\\s*(?:'\\*'|ALL_KEYS\\.filter[\\s\\S]*?\\)|\\[[\\s\\S]*?\\])`));
    if (preset === 'admin' || preset === 'manager') continue; // ALL_KEYS minus a short exclusion list — they DO hold it
    assert.ok(block && !/expenses:cancel/.test(block[0]), `${preset} must NOT void by default`);
  }
});

it('bookkeeper holds it without holding expenses:approve', () => {
  const block = CAPS.match(/bookkeeper:\s*\[[\s\S]*?\],\n\n/);
  assert.ok(block && /'expenses:cancel'/.test(block[0]), 'a bookkeeper can undo a mistaken approval');
  // Quoted form only — the block's own comment names `expenses:approve` in
  // backticks to explain the split, which is prose, not a grant.
  assert.ok(!/'expenses:approve'/.test(block[0]), 'without being made an approver');
});

it('the Transactions row offers Void, gated on the capability and hidden once settled', () => {
  const code = codeOnly(CLIENT);
  assert.match(code, /can\('expenses:cancel'\) && !r\.settled/,
    'both the permission and the already-paid-back state gate the link');
  assert.match(code, /finTxVoidClaim\(\$\{Number\(r\.claim_id\)\}\)/);
  assert.match(code, /window\.finTxVoidClaim = async function finTxVoidClaim/);
  assert.match(code, /api\(`\/api\/retail-admin\/staff-expenses\/\$\{Number\(claimId\)\}\/void`/);
});

it('the migration reaches admin/manager/bookkeeper only, edited or not', () => {
  assert.match(ROLES, /function migrateExpenseCancelCap/);
  assert.match(ROLES, /EXPENSE_CANCEL_ROLE_KEYS\s*=\s*\['admin', 'manager', 'bookkeeper'\]/);
  // No untouched-role guard — the reason migrateKitchenRequestCap gives:
  // nobody can have unticked a key that did not exist yesterday.
  const fn = ROLES.slice(ROLES.indexOf('function migrateExpenseCancelCap'));
  const body = fn.slice(0, fn.indexOf('module.exports'));
  assert.ok(!/JSON\.stringify\(caps\.presetCapsFor/.test(body), 'read from the tenant row, not stamped fresh');
});

console.log('\n6 · settlement — the step that posts nothing (step four)');

it('settling writes ONE column and touches the ledger in no way at all', () => {
  const settle = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/settle"));
  const body = settle.slice(0, settle.indexOf('module.exports'));
  assert.match(body, /UPDATE staff_expenses SET settled = \?/);
  assert.ok(!/expense_entries|postClaim/.test(body),
    'the ¥38 was recorded once, at approval — a second row would report ¥76 of taxis');
});

it('only a debt can be settled, and the refusal says which it is not', () => {
  const settle = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/settle"));
  assert.match(settle, /claim\.status !== 'approved'[\s\S]*?ERR\.notApproved/);
  assert.match(settle, /claim\.paid_by !== 'employee'[\s\S]*?ERR\.notOwed/);
  // "cannot settle" on its own sends somebody looking for a permission problem.
  assert.ok(ROUTE.includes('该笔由公司账户支付'));
});

it('un-settling exists, because the un-approve refusal depends on it', () => {
  // A claim marked paid by mistake can no longer be un-approved (409), so if it
  // could not be un-marked either it would be stuck for good.
  assert.match(ROUTE_CODE, /req\.body\.settled === false \? 0 : 1/);
  assert.match(ROUTE_CODE, /settled \? 'settle' : 'unsettle'/, 'and both are logged');
});

it('what is owed is counted over EVERY claim, not the queue page', () => {
  const q = ROUTE_CODE.slice(ROUTE_CODE.indexOf('let owed'));
  // §269: the query moved to lib/expense-returns.js so it can net returns; the
  // predicate is the same one, with settled claims holding a refund added.
  const OWED = require('../lib/expense-returns').OWED_SQL;
  assert.match(OWED, /WHERE c\.status = 'approved' AND c\.paid_by = 'employee'\s+AND \(COALESCE\(c\.settled, 0\) = 0 OR/);
  assert.ok(!/LIMIT/.test(OWED));
  assert.match(q, /expenseReturns\.OWED_SQL/);
  assert.match(q, /GROUP BY c\.submitted_by/, 'grouped by person, because that is how it is paid');
  assert.ok(!/LIMIT/.test(q.slice(0, q.indexOf('res.json'))),
    'a debt does not stop existing because it fell off the end of a list');
});

it('the owed totals carry the rows behind them', () => {
  assert.match(require('../lib/expense-returns').OWED_SQL, /GROUP_CONCAT\(c\.id\) AS ids/);
  assert.match(PHONE_CODE, /aprSettle/);
  assert.match(PHONE_CODE, /for\(const id of list\) await apiWrite/,
    'sequential: four writes racing on a shop wifi is how two of them land');
});

it('a name is resolved for everyone the payload mentions, queue or not', () => {
  // §269: the same owed query, so the names cover exactly the people it lists.
  assert.match(ROUTE_CODE, /SELECT DISTINCT submitted_by FROM \(\$\{expenseReturns\.OWED_SQL\} GROUP BY c\.submitted_by\)/,
    'an owed person outside the 200-row queue would otherwise have a total and no name');
});

it('the phone says marking paid changes nothing in the accounts', () => {
  assert.ok(PHONE.includes('标记已付不会改动账目 — 该费用在审批通过时已记入。'));
  assert.ok(PHONE.includes('Marking paid does not change the accounts'));
  // And it asks first, naming the person and the figure: this asserts money has
  // already changed hands somewhere this app cannot see.
  // §300: through the phone's own ask-sheet. It used to be the desktop's
  // askConfirm, which the phone does not have, so the question was never asked
  // and the write went out on the first tap; this line pinned that shape.
  // scripts/test_mobile_finance_guards.js runs it and checks the request.
  assert.match(PHONE_CODE, /state\.ask = owes[\s\S]*?title:T\('Paid ¥'\+total\+' back\?'[\s\S]*?confirmLabel:T\('Mark paid','标记已付'\), run\}/);
  assert.ok(!/askConfirm\s*\(/.test(PHONE_CODE), 'no call to a dialog the phone does not define');
});

it('the owed block is absent when nothing is owed', () => {
  // §269: a negative total (a refund the employee holds) is listed too; only a
  // zero is dropped, and the server's HAVING drops it first.
  assert.match(PHONE_CODE, /const owed=\(a\.owed\|\|\[\]\)\.filter\(o=>Number\(o\.total\)!==0\);/);
  assert.match(PHONE_CODE, /owed\.length \? `<div/, '§1.12: a zero here is a row that only says nothing happened');
});

console.log('\n7 · the category picker (§87 amendment — Ash chose option B)');

it('the form offers ONE row, not one chip per category', () => {
  // The live list is 31 entries. As chips it filled the screen and pushed the
  // amount field off the top.
  const field = PHONE_CODE.slice(PHONE_CODE.indexOf('const catField = cats.length'),
                                 PHONE_CODE.indexOf('const stores=x.stores'));
  assert.ok(!/cats\.map\(/.test(field), 'the form must not render the whole list');
  assert.match(field, /APP\.cmd\('expPickOpen'\)/);
  assert.ok(PHONE.includes('选择分类'), 'and it says what it is for when nothing is chosen');
});

it('the search box stores the query and repaints the RESULTS, never the app', () => {
  // The rule #437 and its follow-up established across four screens: render()
  // rebuilds the <input>, and a rebuilt field reopens the soft keyboard on its
  // letter page.
  const cmd = PHONE_CODE.slice(PHONE_CODE.indexOf("reg('expQ'"));
  const body = cmd.slice(0, cmd.indexOf('});') + 3);
  assert.match(body, /getElementById\('mExpPickBody'\)/);
  assert.match(body, /host\.innerHTML=expPickBodyHtml\(\)/);
  // render() only as the fallback when the box is not on screen, exactly as
  // rqSearch does it.
  assert.match(body, /else render\(\);/);
  assert.ok(!/^\s*render\(\);/m.test(body.replace(/else render\(\);/, '')),
    'no unconditional repaint of the app');
});

it('the input sits OUTSIDE the box that gets repainted', () => {
  const picker = PHONE.slice(PHONE.indexOf('function screenExpensePicker()'),
                             PHONE.indexOf('function screenExpense()'));
  const inputAt = picker.indexOf('id="mExpQ"');
  const boxAt = picker.indexOf('id="mExpPickBody"');
  assert.ok(inputAt > -1 && boxAt > -1 && inputAt < boxAt,
    'an input inside the repainted container is destroyed on every keystroke');
});

it('recents are THIS PERSON\'S, and a hidden category cannot return through them', () => {
  const meta = ROUTE_CODE.slice(ROUTE_CODE.indexOf('let recent = []'));
  assert.match(meta, /WHERE submitted_by IS \?/, "a driver and an office manager want different six");
  assert.match(meta, /active\.has\(c\)/,
    'a category the tenant has hidden must not come back through somebody\'s history');
  assert.match(meta, /ORDER BY last DESC/);
  assert.match(meta, /\.slice\(0, 5\)/);
});

it('recents step aside while searching', () => {
  // Somebody typing has declined the shortcut, and leaving them up would show
  // the same category twice in one result set.
  assert.match(PHONE_CODE, /const recent=q\?\[\]:/);
});

it('a search with no hit says so rather than rendering an empty list', () => {
  assert.ok(PHONE.includes('没有匹配的分类。'));
  assert.match(PHONE_CODE, /if\(!shown\.length\) return/);
});

it('choosing closes the picker, and choosing again clears the category', () => {
  const cmd = PHONE_CODE.slice(PHONE_CODE.indexOf("reg('expCat'"));
  const body = cmd.slice(0, cmd.indexOf('});') + 3);
  assert.match(body, /x\.cat=\(x\.cat===c\)\?'':String\(c\)/, 'a mis-tap must be removable');
  assert.match(body, /x\.pick=false/);
});

it('the picker opens closed, and a reopened screen never opens on it', () => {
  const reset = PHONE_CODE.match(/if\(route==='expense'\)\{[\s\S]*?\}/);
  assert.match(reset[0], /x\.pick=false; x\.q='';/);
});

console.log('\n8 · one language on screen, and where the photo comes from');

/* The phone's splitter and the desktop's, RUN SIDE BY SIDE over the same values.
   The phone's copy says in its own comment that the two are held to one answer
   by this suite; this is that. A copy nobody compares is a copy that drifts. */
const vm2 = require('vm');
const PHONE_CAT = PHONE.slice(PHONE.indexOf('const CAT_CJK'), PHONE.indexOf("/* The claim's own day."));
const DESK = read('public', 'retail-admin', '22-finance.js');
const DESK_CAT = DESK.slice(DESK.indexOf('const FIN_CJK'), DESK.indexOf('function finRow('));

function phoneCtx(lang) {
  const ctx = { LANG: lang, Map, Array, String };
  vm2.createContext(ctx);
  new vm2.Script(PHONE_CAT + '\nthis.catLabel=catLabel; this.catLabels=catLabels; this.catSplit=catSplit;')
    .runInContext(ctx);
  return ctx;
}
function deskCtx(lang) {
  const ctx = { window: { cuLang: () => lang }, Map, Array, String };
  ctx.cuLang = ctx.window.cuLang;
  vm2.createContext(ctx);
  new vm2.Script(DESK_CAT + '\nthis.finCatLabel=finCatLabel; this.finCatLabels=finCatLabels;')
    .runInContext(ctx);
  return ctx;
}

const VALUES = [
  'Logistics&Delivery 物流与配送费用',      // the one Ash photographed
  'Ingredients(Kitchen+Retail Use) 原材料（厨房及零售通用）',
  'Rent+Management Fee 房租+物业管理费',
  '营销 Marketing',                          // Chinese first
  '销货成本',                                // one language only
  'Rent',                                    // one language only
  '其他 Other',
  null, '',
];

it('the English screen shows the English half, and only that', () => {
  const en = phoneCtx('en');
  assert.strictEqual(en.catLabel('Logistics&Delivery 物流与配送费用'), 'Logistics&Delivery');
  assert.strictEqual(en.catLabel('营销 Marketing'), 'Marketing', 'either order splits');
  // The defect, stated as an assertion: no CJK reaches an English screen from a
  // value that carries an English half.
  for (const v of VALUES) {
    const out = en.catLabel(v);
    if (v && /[A-Za-z]/.test(v) && /[\u4e00-\u9fff]/.test(v)) {
      assert.ok(!/[\u4e00-\u9fff]/.test(out), `both languages still on screen: ${out}`);
    }
  }
});

it('the Chinese screen shows the Chinese half', () => {
  const zh = phoneCtx('zh');
  assert.strictEqual(zh.catLabel('Logistics&Delivery 物流与配送费用'), '物流与配送费用');
  assert.strictEqual(zh.catLabel('营销 Marketing'), '营销');
});

it('a value with only one language renders WHOLE, in both languages', () => {
  // Showing half of a name that has no other half is worse than showing a word
  // the reader does not need.
  for (const lang of ['en', 'zh']) {
    const c = phoneCtx(lang);
    assert.strictEqual(c.catLabel('销货成本'), '销货成本');
    assert.strictEqual(c.catLabel('Rent'), 'Rent');
  }
});

it('the phone and the desktop give the SAME answer, value for value', () => {
  // The two copies exist because one file is a retail-admin bundle and the other
  // a standalone document. This is what stops them drifting.
  for (const [pl, dl] of [['en', 'en'], ['zh', 'cn']]) {
    const ph = phoneCtx(pl), dk = deskCtx(dl);
    for (const v of VALUES) {
      assert.strictEqual(ph.catLabel(v), dk.finCatLabel(v), `${pl}: ${JSON.stringify(v)}`);
    }
  }
});

it('two categories that read alike in this language both render WHOLE', () => {
  // The live list holds exactly this: `Marketing&Promotion 市场推广费用` beside
  // `营销 Marketing`, and the two spellings of 低值易耗品. Drawing two rows a
  // person cannot tell apart is §36's defect arriving through the display.
  const en = phoneCtx('en');
  const m = en.catLabels(['Rent 房租', 'Rent 租金', 'Office Supplies 办公用品']);
  assert.strictEqual(m.get('Rent 房租'), 'Rent 房租', 'the collision renders whole');
  assert.strictEqual(m.get('Rent 租金'), 'Rent 租金');
  assert.strictEqual(m.get('Office Supplies 办公用品'), 'Office Supplies', 'and the rest still split');
  // And the desktop agrees.
  const dk = deskCtx('en');
  const d = dk.finCatLabels(['Rent 房租', 'Rent 租金', 'Office Supplies 办公用品']);
  for (const k of ['Rent 房租', 'Rent 租金', 'Office Supplies 办公用品']) {
    assert.strictEqual(m.get(k), d.get(k), k);
  }
});

it('the picker searches the STORED value, not the half on screen', () => {
  // An English operator typing 物流 and a Chinese one typing logistics must both
  // find the row; searching the rendered half makes half the vocabulary
  // unreachable in each language.
  assert.match(PHONE_CODE, /const hit=c=>!q\|\|String\(c\)\.toLowerCase\(\)\.indexOf\(q\)>=0;/);
});

it('every place a category is drawn goes through the splitter', () => {
  // CLAUDE.md: a finding is where it was found, not the extent of the problem.
  // These are the five: the collapsed row, the picker, the receipt, the
  // submitter's list and the approver's.
  assert.strictEqual((PHONE_CODE.match(/catLabel\(/g) || []).length >= 5, true,
    'a new render site that skips it puts both languages back on screen');
  assert.ok(!/bits\.push\(r\.category\)/.test(PHONE_CODE), 'the two list rows are covered');
  assert.ok(!/escAttr\(x\.sent\.cat\)/.test(PHONE_CODE), 'the receipt is covered');
});

it('a store name follows the live language too', () => {
  assert.match(PHONE_CODE, /function mStoreName\(st\)/);
  assert.match(PHONE_CODE, /LANG==='en'\?\(en\|\|cn\):\(cn\|\|en\)/,
    'it shipped as name_cn||name_en, which put Chinese on an English screen');
  // Scoped to THIS screen's chip rather than to the file: `name_cn||name_en` is
  // correct elsewhere as the zh branch of a language-aware expression, and an
  // assertion that forbade it everywhere would be red for correct code.
  const chip = PHONE_CODE.slice(PHONE_CODE.indexOf("APP.cmd('expStore'"));
  assert.match(chip.slice(0, 200), /mStoreName\(st\)/);
});

it('the photo can come from the gallery, not only the camera', () => {
  // `capture="environment"` opens the camera and offers nothing else, so a
  // receipt already photographed or sent by a supplier could not be attached.
  assert.ok(!/capture=/.test(PHONE_CODE.replace(/capture="environment"` Android/g, '')),
    'no capture attribute may remain on the file input');
  assert.match(PHONE, /<input type="file" accept="image\/\*" style="display:none"/);
});

console.log('\n9 · re-filing a claim that is already in the books (§146)');

/* WHAT THIS SECTION IS FOR. A claim approved with no category posted a ledger
   row with none, and nothing could then fix it: `finance-transactions.js`
   refuses to edit a claim-posted row (rightly — it is a projection), and no
   route edited the CLAIM. The only way to file a ¥299 taxi that arrived blank
   was to void it and ask the employee to send it again. Both halves of the fix
   are asserted here: the approver may file it as they approve, and an approved
   claim may be re-filed afterwards. */

const rdb = new Database(':memory:');
rdb.exec(`
  CREATE TABLE expense_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date DATE, amount REAL, category TEXT,
    description TEXT, po_id INTEGER, payment_method TEXT, store_id INTEGER,
    claim_id INTEGER, created_by INTEGER,
    -- §269: a return is a negative row pointing at its claim; postClaim moves it.
    returns_entry_id INTEGER, returns_claim_id INTEGER
  );`);
const unfiled = {
  id: 77, date: '2026-09-16', amount: 299, category: null,
  note: 'take taxi to the office and Ramada', submitted_name: 'bai',
  status: 'approved', paid_by: 'employee', store_id: 2, payment_method: null,
  decided_by: 2,
};

it('an approved claim with no category posts a row filed under nothing', () => {
  POST.postClaim(rdb, unfiled);
  const row = rdb.prepare('SELECT * FROM expense_entries WHERE claim_id = 77').get();
  assert.ok(row, 'the money is in the books either way — that is the problem');
  assert.strictEqual(row.category, null);
});

it('re-filing rewrites the SAME one row, under the new category', () => {
  POST.postClaim(rdb, { ...unfiled, category: 'Transport 交通' });
  const rows = rdb.prepare('SELECT * FROM expense_entries WHERE claim_id = 77').all();
  assert.strictEqual(rows.length, 1, 'DELETE-then-INSERT, never a second row');
  assert.strictEqual(rows[0].category, 'Transport 交通');
});

it('and nothing else about the money moves', () => {
  const row = rdb.prepare('SELECT * FROM expense_entries WHERE claim_id = 77').get();
  assert.strictEqual(row.amount, 299, 'same sum');
  assert.strictEqual(row.date, '2026-09-16', 'same day');
  assert.strictEqual(row.store_id, 2, 'same shop');
  assert.match(row.description, /bai/, 'and still says whose taxi it was');
});

it('the name is resolved BEFORE the write, or re-filing would strip it', () => {
  // `claimDescription` reads `submitted_name`, which a `staff_expenses` row does
  // not carry — the route resolves it. A re-post that forgot would rewrite the
  // ledger line without the one fact that makes a ¥299 line answerable later.
  const route = ROUTE_CODE.match(/staff-expenses\/:id\/category[\s\S]*?^\}\);/m);
  assert.ok(route, 'the re-filing route must exist');
  const body = route[0];
  assert.match(body, /submitterNames\(\[claim\.submitted_by\]\)/);
  assert.ok(body.indexOf('submitterNames') < body.indexOf('withTransaction'),
    'resolved outside the transaction, as /decide does — it reads the other handle');
  assert.match(body, /fresh\.submitted_name = submittedName/);
});

it('it clears expense_id in the same UPDATE, before postClaim deletes the row', () => {
  // §90's FK trap, third occurrence: schema.sql's FK on `expense_id` still
  // points at the row postClaim is about to DELETE, and SQLite refuses.
  const route = ROUTE_CODE.match(/staff-expenses\/:id\/category[\s\S]*?^\}\);/m)[0];
  assert.match(route, /SET category = \?, expense_id = NULL/);
  assert.ok(route.indexOf('expense_id = NULL') < route.indexOf('postClaim('),
    'cleared first, or the delete is refused');
});

it('it refuses what has no ledger row to re-file, and names which', () => {
  const route = ROUTE_CODE.match(/staff-expenses\/:id\/category[\s\S]*?^\}\);/m)[0];
  assert.match(route, /claim\.status !== 'approved'[\s\S]*?ERR\.notApprovedCat/,
    'a submitted claim may still be rejected; a rejected one was taken back out');
  assert.match(route, /claim\.po_id \|\| claim\.awaiting_delivery[\s\S]*?ERR\.onOrderCat/,
    'the order owns that cost, under the LINE category');
  assert.match(route, /!category[\s\S]*?ERR\.needCategory/, 'and an empty value is a mistake');
  for (const key of ['notApprovedCat', 'needCategory', 'onOrderCat']) {
    const line = ROUTE.match(new RegExp(`${key}:\\s*'([^']+)'`));
    assert.ok(line, `${key} must be defined`);
    assert.match(line[1], /·/, 'every refusal a person reads carries both languages');
  }
});

it('a SETTLED claim can still be re-filed — deliberately, unlike void', () => {
  const route = ROUTE_CODE.match(/staff-expenses\/:id\/category[\s\S]*?^\}\);/m)[0];
  // /decide and /void refuse a settled claim because they would take an expense
  // out of the books while leaving the repayment made. Nothing leaves the books
  // here, and refusing would mean a category could only be fixed before payday.
  assert.ok(!/claim\.settled/.test(route), 'no settled guard on this route');
});

it('the bookkeeper can re-file, having been able to VOID all along', () => {
  /* THE ASYMMETRY THIS CLOSES. `bookkeeper` holds `expenses:cancel` and not
     `expenses:approve`, so a route gated on `approve` alone let the accountant
     take a claim out of the books entirely while refusing them the heading it
     sat under — the bigger hammer and not the small screwdriver, for the person
     whose job is the books. Re-filing moves no money and is strictly less power
     than the void they already hold. */
  const preset = CAPS.match(/bookkeeper:\s*\[[\s\S]*?\]/)[0];
  assert.ok(preset.includes("'expenses:cancel'"), 'the premise: they can void');
  assert.ok(!preset.includes("'expenses:approve'"),
    'and cannot approve — which stays an owner/admin/manager default');

  assert.match(ROUTE_CODE,
    /staff-expenses\/:id\/category', requireRetailAdmin, requireFiler/);
  const guard = ROUTE_CODE.match(/function requireFiler\(req, res, next\) \{[\s\S]*?\n\}/)[0];
  assert.match(guard, /caps\.has\('expenses:approve'\) && !req\.caps\.has\('expenses:cancel'\)/,
    'either key opens it');
  assert.match(guard, /role === 'owner'/, 'the owner always passes, as everywhere else');
  assert.match(guard, /typeof req\.caps\.has !== 'function'/,
    'and an unresolved capability set is a refusal, not a fall-through — this re-posts a ledger row');

  // The map has to agree with the route, or the RBAC layer refuses first.
  assert.match(CAPROUTES,
    /staff-expenses\\\/\\d\+\\\/category\$\/\.test\(P\)\) \{\s*\n\s*return \['expenses:approve', 'expenses:cancel'\]/,
    'both keys, above the generic prefix that would gate it on expenses:submit');
});

it('and it is reachable from the screen that role can actually open', () => {
  /* A PERMISSION WITH NO SCREEN IS NOT A PERMISSION. `/pending` — the approvals
     queue, where the picker was first put — is gated on `expenses:approve`,
     which the bookkeeper does not hold. Transactions is the finance screen they
     DO reach, and where Void already lives for the same reason (§90). */
  assert.match(ROUTE_CODE, /staff-expenses\/pending', requireRetailAdmin, requireApprover/,
    'the queue stays approver-only');
  const code = codeOnly(CLIENT);
  const filing = code.match(/function finTxClaimFiling\(r\) \{[\s\S]*?\n\}/)[0];
  assert.match(filing, /can\('expenses:approve'\) \|\| can\('expenses:cancel'\)/,
    'the ledger row offers it under either key, same test as the server');
  assert.match(filing, /typeof can === 'function'/,
    'fail-closed: a control that appears when the capability layer could not '
    + 'answer is one that refuses every time it is pressed');
  assert.ok(!/settled/.test(filing),
    're-filing is NOT hidden by settled — nothing leaves the books, so it would '
    + 'mean a category could only be corrected before payday');
  assert.match(code, /can\('expenses:cancel'\) && !r\.settled/,
    'while Void, an action rather than a field, stays hidden once paid back');
});

it('the ledger picker offers EXPENSE categories whatever the form is set to', () => {
  // `finTxCatOptions()` branches on FIN_TX_KIND — the FORM's kind. A claim row
  // is always money out, so calling it here would have offered income
  // categories to a claim whenever the income form had last been opened.
  const code = codeOnly(CLIENT);
  const filing = code.match(/function finTxClaimFiling\(r\) \{[\s\S]*?\n\}/)[0];
  assert.match(filing, /finTxExpenseCats\(\)/);
  assert.ok(!/finTxCatOptions\(\)/.test(filing));
  assert.match(code, /function finTxExpenseCats\(\)/, 'the split exists');
});

it('re-filing from the ledger calls the CLAIM, never the ledger row', () => {
  // finTxSave refuses a claim-linked row outright and is right to: the row is a
  // projection, and a value typed onto it is lost at the next re-post.
  const fn = codeOnly(CLIENT).match(/finTxFileClaim = async function[\s\S]*?^\};/m)[0];
  assert.match(fn, /staff-expenses\/\$\{Number\(claimId\)\}\/category/);
  assert.match(fn, /FIN_TX = null/);
  assert.match(fn, /FIN_APR = null/, 'the queue shows the same claim');
  assert.match(fn, /if \(!category\)/, 'the blank row closes the picker rather than unfiling a cost');
});

it('the decision may carry a category, and a client that sends none blanks nothing', () => {
  assert.match(ROUTE_CODE, /category = COALESCE\(\?, category\)/,
    'a bare `category = ?` would blank every claim decided by an older client');
  assert.match(ROUTE_CODE, /decision === 'approve'\s*\?\s*storeCategory\(db, \(req\.body \|\| \{\}\)\.category, 'accounting'\)/,
    'snapped onto the tenant list by the same function the submit path uses');
});

it('the queue carries the list its picker is drawn from', () => {
  assert.match(ROUTE_CODE, /categories: activeCategories\(db\)/);
  // One function, or the two surfaces come to offer different lists.
  assert.strictEqual((ROUTE_CODE.match(/function activeCategories/g) || []).length, 1);
  assert.match(ROUTE_CODE, /const categories = activeCategories\(db\);/, '/meta uses it too');
});

it('both screens offer the picker where the server allows it, and nowhere else', () => {
  for (const [name, src] of [['desktop', codeOnly(CLIENT)], ['phone', PHONE_CODE]]) {
    assert.match(src, /awaiting_delivery\)\s*\|\|\s*r\.po_id\) return false/,
      `${name}: a claim on an order is filed on the order`);
    assert.match(src, /status === 'submitted' \|\| r\.status === 'approved'|status==='submitted'\|\|r\.status==='approved'/,
      `${name}: waiting and approved, never rejected or voided`);
  }
});

it('a blank category is VISIBLE on both queues rather than rendering as nothing', () => {
  // How a ¥299 taxi reached the books unfiled with nobody noticing: a claim with
  // no category and one filed under Transport drew the same meta line.
  assert.match(codeOnly(CLIENT), /else if \(!filing\) bits\.push\(cuT\('Not recorded', '未记录'\)\)/);
  assert.match(PHONE_CODE, /else if\(!filing\) bits\.push\(T\('Not recorded','未记录'\)\)/);
});

it('a pick made on a waiting claim survives opening the receipt', () => {
  // Both screens re-render for reasons that have nothing to do with the pick.
  // Held in the DOM alone, checking the photo before approving would throw it
  // away — silently, and at the exact moment the approver was being careful.
  assert.match(codeOnly(CLIENT), /let FIN_APR_CAT = \{\}/);
  assert.match(codeOnly(CLIENT), /delete FIN_APR_CAT\[claim\]/, 'and is spent by the decision');
  assert.match(PHONE_CODE, /cat:\{\}/);
  assert.match(PHONE_CODE, /delete a\.cat\[Number\(id\)\]/);
});

it('the category rides WITH the approval, in one request', () => {
  // A second call afterwards could fail on its own and leave the ledger holding
  // a classification nobody chose.
  assert.match(codeOnly(CLIENT), /\{ decision, category: picked \} : \{ decision \}/);
  assert.match(PHONE_CODE, /\{decision:decision,category:picked\}:\{decision:decision\}/);
});

/* THE PICKER, RUN RATHER THAN GREPPED. The two functions are lifted out of the
   shipped files and executed against stubs, the technique section 8 uses on the
   category splitter. A source assertion cannot see two rows marked `selected`,
   a value that reaches the markup unescaped, or an option list that closed one
   tag short — and all three are how a <select> built by string concatenation
   actually fails. */
function catCellCtx(which) {
  const ctx = {
    Map, Array, String, Number, Object,
    escapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  ctx.escapeAttr = ctx.escapeHtml;
  ctx.escAttr = ctx.escapeHtml;
  ctx.cuT = (en) => en;
  ctx.T = (en) => en;
  ctx.finCatLabel = ctx.catLabel = (v) => String(v == null ? '' : v);
  ctx.finCatLabels = ctx.catLabels = (list) => new Map(list.map(v => [v, String(v)]));
  vm2.createContext(ctx);
  if (which === 'desk') {
    const src = DESK.slice(DESK.indexOf('function finAprFileable('), DESK.indexOf('window.finAprCatPick'));
    ctx.FIN_APR = { categories: [] };
    ctx.FIN_APR_CAT = {};
    ctx.FIN_APR_BUSY = 0;
    new vm2.Script(src + '\nthis.cell = finAprCatCell;').runInContext(ctx);
  } else {
    const src = PHONE.slice(PHONE.indexOf('function aprFileable('), PHONE.indexOf('function aprRow('));
    ctx.state = { apr: { cats: [], cat: {}, busy: 0 } };
    new vm2.Script(src + '\nthis.cell = aprCatCell;').runInContext(ctx);
  }
  return ctx;
}
function setCats(ctx, which, list) {
  if (which === 'desk') ctx.FIN_APR.categories = list;
  else ctx.state.apr.cats = list;
}
const CLAIM_WAITING  = { id: 9, status: 'submitted', category: null, awaiting_delivery: 0, po_id: null };
const CLAIM_APPROVED = { id: 9, status: 'approved',  category: 'Transport 交通', awaiting_delivery: 0, po_id: null };

for (const which of ['desk', 'phone']) {
  it(`${which}: the picker draws one option per category and marks exactly one`, () => {
    const ctx = catCellCtx(which);
    setCats(ctx, which, ['Transport 交通', 'Rent 房租', 'Other 其他']);
    const html = ctx.cell(CLAIM_APPROVED);
    assert.strictEqual((html.match(/<option/g) || []).length, 3, 'three categories, no blank row');
    assert.strictEqual((html.match(/selected/g) || []).length, 1, 'two marked rows is a browser coin-toss');
    assert.match(html, /value="Transport 交通" selected/);
    assert.strictEqual((html.match(/<\/select>/g) || []).length, 1);
  });

  it(`${which}: a waiting claim is offered the blank row, an approved one is not`, () => {
    const ctx = catCellCtx(which);
    setCats(ctx, which, ['Transport 交通']);
    assert.match(ctx.cell(CLAIM_WAITING), /value=""/, 'choosing it means "not yet", which is today\'s behaviour');
    assert.ok(!/value=""/.test(ctx.cell(CLAIM_APPROVED)),
      'on an approved claim it would mean UNfiling a cost, which the server refuses');
  });

  it(`${which}: a category with a quote in it cannot break out of the markup`, () => {
    const ctx = catCellCtx(which);
    setCats(ctx, which, ['Rent" onfocus="x']);
    const html = ctx.cell(CLAIM_WAITING);
    assert.ok(!/onfocus="x/.test(html), 'the value reaches the attribute escaped');
    assert.match(html, /&quot;/);
  });

  it(`${which}: no list, no picker — and none on a claim that raised an order`, () => {
    const ctx = catCellCtx(which);
    assert.strictEqual(ctx.cell(CLAIM_WAITING), '', 'an empty list offers nothing rather than something wrong');
    setCats(ctx, which, ['Transport 交通']);
    assert.strictEqual(ctx.cell({ ...CLAIM_WAITING, awaiting_delivery: 1 }), '');
    assert.strictEqual(ctx.cell({ ...CLAIM_APPROVED, po_id: 12 }), '');
    assert.strictEqual(ctx.cell({ ...CLAIM_APPROVED, status: 'rejected' }), '');
    assert.strictEqual(ctx.cell({ ...CLAIM_APPROVED, status: 'voided' }), '');
  });

  it(`${which}: the two rows send to two different places`, () => {
    const ctx = catCellCtx(which);
    setCats(ctx, which, ['Transport 交通']);
    // A waiting claim remembers; an approved one saves. Crossed, a decision
    // would post a category to a claim with no ledger row, or a correction
    // would sit in memory and never reach the books.
    assert.match(ctx.cell(CLAIM_WAITING), /CatPick/);
    assert.ok(!/CatPick/.test(ctx.cell(CLAIM_APPROVED)));
    assert.match(ctx.cell(CLAIM_APPROVED), /aprFile|finAprFile/);
  });
}

/* THE LEDGER ROW'S PICKER, RUN. Same technique as the approval pickers above,
   and the same reason: which control a role is shown is the kind of thing a
   source grep reports as present while the condition around it is inverted. */
function txFilingCtx(caps) {
  const held = new Set(caps);
  const ctx = {
    Map, Array, String, Number, Object, Set,
    can: (k) => held.has(k),
    escapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    cuT: (en) => en,
    finCatLabel: (v) => String(v == null ? '' : v),
    finCatLabels: (list) => new Map(list.map(v => [v, String(v)])),
    finTxExpenseCats: () => ['Transportation 交通', 'Software Service Fee 软件服务费'],
  };
  ctx.escapeAttr = ctx.escapeHtml;
  vm2.createContext(ctx);
  const src = DESK.slice(DESK.indexOf('function finTxClaimFiling(r) {'), DESK.indexOf('/* §146 — RE-FILING FROM THE LEDGER.'));
  new vm2.Script(src + '\nthis.filing = finTxClaimFiling;').runInContext(ctx);
  return ctx;
}
const LEDGER_CLAIM = { claim_id: 5, source: 'claim', category: null, settled: 0 };

it('ledger row: the SAME control the queue draws, not a link to one', () => {
  /* It shipped as a `Change` link, on the reasoning that a dropdown per row
     would make a list somebody opened to READ into a wall of controls. Ash, off
     the live screen: "why is it not similar?" Claim rows are a small minority
     of a ledger, so the wall never arrives — and one screen hiding a control
     the other shows is two products for one act. */
  const html = txFilingCtx(['expenses:cancel']).filing(LEDGER_CLAIM);
  assert.match(html, /<select/, 'drawn, not linked to');
  assert.ok(!/finTxFileOpen/.test(html), 'and there is no open-the-picker step left');
  assert.match(html, /class="fin-apr-cat"/,
    "the approval row's own classes, so the two cannot drift into two shapes");
  assert.match(html, /finTxFileClaim\(5, this\.value\)/);
  assert.strictEqual((html.match(/<option/g) || []).length, 3, 'two categories and the blank');
  assert.strictEqual((html.match(/selected/g) || []).length, 1);
});

it('ledger row: a filed claim shows its category and is not offered a blank', () => {
  const html = txFilingCtx(['expenses:cancel']).filing({ ...LEDGER_CLAIM, category: 'Transportation 交通' });
  assert.ok(!/value=""/.test(html), 'unfiling a cost is what the server refuses');
  assert.match(html, /value="Transportation 交通" selected/);
});

it('ledger row: either capability draws it, neither draws nothing', () => {
  for (const caps of [['expenses:cancel'], ['expenses:approve'], ['expenses:approve', 'expenses:cancel']]) {
    assert.match(txFilingCtx(caps).filing(LEDGER_CLAIM), /<select/, caps.join('+'));
  }
  assert.strictEqual(txFilingCtx(['finance:record']).filing(LEDGER_CLAIM), '');
});

it('ledger row: a SETTLED claim keeps the picker — only Void is withdrawn', () => {
  // Voiding after the employee has been paid back would take the expense out of
  // the books while leaving the payment made. Re-filing takes nothing out.
  assert.match(txFilingCtx(['expenses:cancel']).filing({ ...LEDGER_CLAIM, settled: 1 }), /<select/);
  assert.match(codeOnly(CLIENT), /can\('expenses:cancel'\) && !r\.settled/, 'Void still is');
});

it('ledger row: nothing is drawn on a row that is not a claim', () => {
  const ctx = txFilingCtx(['expenses:approve', 'expenses:cancel']);
  assert.strictEqual(ctx.filing({ ...LEDGER_CLAIM, source: 'po', claim_id: null }), '');
  assert.strictEqual(ctx.filing({ ...LEDGER_CLAIM, source: 'manual', claim_id: null }), '');
  // And none at all for a tenant with no categories — §36's empty-list rule.
  const bare = txFilingCtx(['expenses:cancel']);
  bare.finTxExpenseCats = () => [];
  assert.strictEqual(bare.filing(LEDGER_CLAIM), '');
});

it('re-filing drops the ledger caches it just invalidated', () => {
  const fn = codeOnly(CLIENT).match(/finAprFile = async function[\s\S]*?^\};/m);
  assert.ok(fn, 'the desktop re-filing call must exist');
  assert.match(fn[0], /FIN_TX = null/, 'the Transactions list is drawn from the row it re-posted');
  assert.match(fn[0], /FIN_DATA = null/, 'and so is the staircase');
});

console.log('\n10 · correcting who paid (§207)');

it('the route exists, is gated on approve alone, and is mapped above the generic prefix', () => {
  assert.match(ROUTE_CODE, /router\.post\('\/api\/retail-admin\/staff-expenses\/:id\/paid-by', requireRetailAdmin, requireApprover/,
    'it asserts whether the business owes a person money — that is /settle\'s axis, not a heading');
  // Below `staff-expenses` the general rule returns `expenses:submit`, which
  // EVERY floor preset holds — so a submitter could mark their own approved
  // claim as own-money and conjure a debt the shop would pay out.
  const mapped = CAPROUTES.indexOf("paid-by$/.test(P)) return 'expenses:approve'");
  const generic = CAPROUTES.indexOf("P.startsWith('/api/retail-admin/staff-expenses')");
  assert.ok(mapped > 0, 'the route must be mapped in cap-routes at all, on expenses:approve');
  assert.ok(mapped < generic, 'and above the prefix that would gate it on expenses:submit');
});

it('it writes ONE column and calls no poster at all', () => {
  const fn = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/paid-by'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  assert.match(body, /UPDATE staff_expenses SET paid_by = \? WHERE id = \?/);
  assert.ok(!/postClaim|postRetailPOExpenses|expense_entries/.test(body),
    'the ledger row does not read paid_by — a re-post here would take a new id for an unchanged row');
  assert.ok(!/withTransaction/.test(body),
    'one column on one table needs no transaction, which is the shape /settle has');
});

it('and the claim it is about is the ONE thing the poster must keep ignoring', () => {
  /* THE ROUTE'S WHOLE DESIGN RESTS ON THIS. If `postClaim` or
     `claimDescription` ever reads `paid_by`, the route above becomes a silent
     no-op on the books: the claim says one thing, the ledger another, and
     nothing on screen says so. Asserted here as well as end-to-end in
     test_staff_expenses_transaction_timing.js, because this is the file a
     change to lib/expense-posting.js is most likely to be run against. */
  assert.ok(!/paid_by|paidBy/.test(POSTING),
    'lib/expense-posting.js must not read who paid — see the /paid-by route header');
});

it('it refuses a settled claim, where re-filing allows one', () => {
  const fn = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/paid-by'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  // Marking an already-repaid claim as company-paid says the business never
  // owed money it has already handed over — a real transfer with nothing
  // behind it. /decide and /void refuse a settled claim for the same class of
  // reason, and this borrows their sentence rather than minting a second one.
  assert.match(body, /if \(claim\.settled\) return res\.status\(409\)\.json\(\{ error: ERR\.settled \}\)/);
  assert.match(body, /claim\.status !== 'approved'.*ERR\.notApprovedPaid/s);
});

it('it does NOT refuse a claim on a purchase order, though /category does', () => {
  // That refusal is about the ledger — the order owns the cost, so a category
  // set on the claim moves nothing. This route never touches the ledger, and
  // somebody who paid out of their own pocket is owed the money whether the
  // goods have arrived or not. Refusing would leave the one debt nobody could
  // correct.
  const fn = ROUTE_CODE.slice(ROUTE_CODE.indexOf("staff-expenses/:id/paid-by'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  assert.ok(!/po_id|awaiting_delivery/.test(body));
});

it('who paid stays a CLOSED set — the route reuses the validator\'s Set, not a copy', () => {
  // Two copies of a closed set is how the third spelling gets in, and a third
  // spelling of "my own money" is a debt nobody can query for.
  assert.match(ROUTE_CODE, /require\('\.\.\/lib\/expense-claim'\)/);
  assert.match(ROUTE_CODE, /PAID_BY/);
  assert.match(ROUTE_CODE, /!PAID_BY\.has\(paidBy\)\) return res\.status\(400\)\.json\(\{ error: CLAIM_ERR\.paidBy \}\)/);
  assert.ok(!/new Set\(\['company', 'employee'\]\)/.test(ROUTE_CODE),
    'the route must not declare a second copy of the set');
});

it('the decision carries it, COALESCEd so an older client blanks nothing', () => {
  // A blank `paid_by` has no meaning at all — it is the field that decides
  // whether a debt exists — so a bare assignment here is worse than the same
  // mistake would have been for the category.
  assert.match(ROUTE_CODE, /paid_by = COALESCE\(\?, paid_by\)/);
  assert.match(ROUTE_CODE, /const filedPaidBy = decision === 'approve' && paidByRaw \? paidByRaw : null;/);
});

it('the correction is logged with the value it replaced, on both paths', () => {
  /* IT OVERRIDES WHAT THE SUBMITTER ASSERTED, and §87 part five's rule for
     that is that the RECORD is the guard rather than a refusal. A log that
     reported only the new value would be indistinguishable from the claim
     having always said this, which is the whole point of recording it. */
  assert.match(ROUTE_CODE, /was_paid_by: claim\.paid_by/);
  assert.match(ROUTE_CODE, /was_paid_by: \(filedPaidBy && filedPaidBy !== claim\.paid_by\) \? claim\.paid_by : undefined/);
});

/* THE PICKER, RUN RATHER THAN GREPPED — the technique section 9 uses on the
   category cell, and for the same reason: a source assertion cannot see two
   rows marked `selected` or a value that reaches the markup unescaped. */
function paidCellCtx(which) {
  const ctx = {
    Map, Array, String, Number, Object,
    escapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  ctx.escapeAttr = ctx.escapeHtml;
  ctx.escAttr = ctx.escapeHtml;
  ctx.cuT = (en) => en;
  ctx.T = (en) => en;
  vm2.createContext(ctx);
  if (which === 'desk') {
    const src = DESK.slice(DESK.indexOf('function finAprPaidable('), DESK.indexOf('window.finAprPaidPick'));
    ctx.FIN_APR_PAID = {};
    ctx.FIN_APR_BUSY = 0;
    new vm2.Script(src + '\nthis.cell = finAprPaidCell;').runInContext(ctx);
  } else {
    const src = PHONE.slice(PHONE.indexOf('function aprPaidable('), PHONE.indexOf('function aprRow('));
    ctx.state = { apr: { paid: {}, busy: 0 } };
    new vm2.Script(src + '\nthis.cell = aprPaidCell;').runInContext(ctx);
  }
  return ctx;
}
const PAID_WAITING  = { id: 9, status: 'submitted', paid_by: 'employee', settled: 0, awaiting_delivery: 0, po_id: null };
const PAID_APPROVED = { id: 9, status: 'approved',  paid_by: 'employee', settled: 0, awaiting_delivery: 0, po_id: null };

for (const which of ['desk', 'phone']) {
  it(`${which}: two options, exactly one marked, and the claim's own is the one`, () => {
    const ctx = paidCellCtx(which);
    const html = ctx.cell(PAID_APPROVED);
    assert.strictEqual((html.match(/<option/g) || []).length, 2, 'who paid is a closed set of two');
    assert.strictEqual((html.match(/selected/g) || []).length, 1, 'two marked rows is a browser coin-toss');
    assert.match(html, /value="employee" selected/);
    assert.strictEqual((html.match(/<\/select>/g) || []).length, 1);
    assert.match(ctx.cell({ ...PAID_APPROVED, paid_by: 'company' }), /value="company" selected/);
  });

  it(`${which}: there is NO blank option, unlike the category`, () => {
    // A category may honestly be "not yet"; who paid may not. It is the field
    // that decides whether a debt exists, and the validator refuses a third
    // answer for exactly that reason.
    const ctx = paidCellCtx(which);
    assert.ok(!/value=""/.test(ctx.cell(PAID_WAITING)));
    assert.ok(!/value=""/.test(ctx.cell(PAID_APPROVED)));
  });

  it(`${which}: a claim that has never said returns the safe half of the pair`, () => {
    // `paid_by` is NOT NULL in practice, but a row read from an older write, or
    // a payload that lost the field, must not render with nothing selected —
    // the operator would then be one click from setting a value they never
    // chose. `company` is the half that owes nobody.
    const ctx = paidCellCtx(which);
    assert.match(ctx.cell({ ...PAID_APPROVED, paid_by: null }), /value="company" selected/);
  });

  it(`${which}: it is offered on a waiting claim and an approved one, and nowhere else`, () => {
    const ctx = paidCellCtx(which);
    assert.ok(ctx.cell(PAID_WAITING), 'a waiting claim — it rides with the Approve click');
    assert.ok(ctx.cell(PAID_APPROVED), 'and an approved one — this is the half nothing could do before');
    // A settled claim: the server refuses it, and the screen says so before the
    // click rather than after it.
    assert.strictEqual(ctx.cell({ ...PAID_APPROVED, settled: 1 }), '');
    assert.strictEqual(ctx.cell({ ...PAID_APPROVED, status: 'rejected' }), '');
    assert.strictEqual(ctx.cell({ ...PAID_APPROVED, status: 'voided' }), '');
  });

  it(`${which}: a purchase order does NOT withdraw it, though it withdraws the category`, () => {
    // The debt is owed whether the food processor has arrived or not.
    const ctx = paidCellCtx(which);
    assert.ok(ctx.cell({ ...PAID_APPROVED, awaiting_delivery: 1 }));
    assert.ok(ctx.cell({ ...PAID_APPROVED, po_id: 12 }));
  });

  it(`${which}: the two rows send to two different places`, () => {
    // Crossed, a correction on an approved claim would sit in memory and never
    // reach the books, or a waiting claim would be written before it was
    // decided.
    const ctx = paidCellCtx(which);
    assert.match(ctx.cell(PAID_WAITING), /PaidPick/);
    assert.ok(!/PaidPick/.test(ctx.cell(PAID_APPROVED)));
    assert.match(ctx.cell(PAID_APPROVED), /aprPaidSet|finAprPaidSet/);
  });

  it(`${which}: the picker is LABELLED, where the category picker is not`, () => {
    // Every option in a category picker is a category and it announces itself.
    // `own money / company` read cold beside a name and an amount could be a
    // payment method, a supplier or an account.
    const ctx = paidCellCtx(which);
    assert.match(ctx.cell(PAID_APPROVED), /Who paid/);
  });
}

it('the meta line does not say who paid twice on a row that carries the picker', () => {
  // The rule the blank category already follows: said only where no picker
  // follows, and the one that can be changed is the one worth reading.
  assert.match(codeOnly(CLIENT), /if \(!whoPaid\) bits\.push\(r\.paid_by === 'employee'/);
  assert.match(PHONE_CODE, /if\(!whoPaid\) bits\.push\(own\?/);
});

it('the pick rides WITH the approval, and only where it actually differs', () => {
  // Sending it unchanged would be a no-op the server has to absorb; sending it
  // on a reject would be an edit made in passing.
  for (const [name, src] of [['desk', codeOnly(CLIENT)], ['phone', PHONE_CODE]]) {
    assert.match(src, /decision === 'approve' && paid && row && paid !== row\.paid_by|decision==='approve'&&paid&&row&&paid!==row\.paid_by/,
      `${name}: the pick must be sent only on approve and only when it moves`);
  }
});

it('a pick made on a waiting claim survives opening the receipt', () => {
  // Held in the DOM alone it would be thrown away by the very act of checking
  // the photo before approving — the queue re-renders for reasons that have
  // nothing to do with the pick.
  assert.match(codeOnly(CLIENT), /let FIN_APR_PAID = \{\};/);
  assert.match(codeOnly(CLIENT), /delete FIN_APR_PAID\[claim\];/);
  assert.match(PHONE_CODE, /paid:\{\}/);
  assert.match(PHONE_CODE, /delete a\.paid\[Number\(id\)\];/);
});

it('the correction drops the Transactions cache and NOT the staircase', () => {
  /* THE OMISSION IS THE POINT, and it is the one place this parts company with
     re-filing. A decision drops both because it writes `expense_entries`; this
     writes one column on `staff_expenses` and no total in Finance moves by a
     fen. What DOES go stale is the Transactions list, which prints
     `Staff claim · own money` off this very field. */
  const fn = codeOnly(CLIENT).match(/finAprPaidSet = async function[\s\S]*?^\};/m);
  assert.ok(fn, 'the desktop correction call must exist');
  assert.match(fn[0], /FIN_TX = null; FIN_TX_SEEN = false;/, 'the row whose mark reads off paid_by');
  assert.ok(!/FIN_DATA = null/.test(fn[0]),
    'no total moved — dropping the staircase would re-pull the whole of Finance for nothing');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
