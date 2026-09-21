#!/usr/bin/env node
/**
 * §90 caught this the hard way: Ash voided a claim on the live screen and it
 * stayed on the ledger, voidable again. scripts/test_staff_expenses.js never
 * would have found it — it tests `postClaim` and `readBody` as pure functions
 * against hand-built fixtures, never the real `/decide` and `/void` ROUTES
 * over a real HTTP request with the real schema's constraints behind them.
 *
 * Two bugs, found by finally doing that:
 *
 *   1. `withTransaction(db, fn)` was called WITHOUT `await` in both routes.
 *      Harmless-looking, because better-sqlite3 is synchronous — but
 *      lib/db-transaction.js's outermost-transaction queue (`acquire`)
 *      defers the body to a later microtask via `.then()` even when nothing
 *      is queued ahead of it. Unawaited, the route's own post-transaction
 *      read and its `res.json(...)` ran on the SAME tick as the call, before
 *      a single statement inside the transaction had executed — reporting
 *      the claim's PRE-decision state back to the caller, and turning any
 *      throw inside the transaction into an unhandled rejection outside the
 *      route's own try/catch.
 *
 *   2. `staff_expenses.expense_id` carries `FOREIGN KEY REFERENCES
 *      expense_entries(id)` (schema.sql). Reversing an approval calls
 *      `postClaim`, which DELETEs the posted `expense_entries` row — while
 *      `expense_id` on this very row still points at it. SQLite
 *      (foreign_keys=ON) refuses that delete. The unit-level fixture for
 *      `postClaim` declares no such column and so never exercised the
 *      constraint; only a real request against the real schema does.
 *
 * Together: void a claim on the live app, and the FK error thrown inside the
 * unawaited transaction never reached the route's catch block — the response
 * had already gone out reporting the OLD ('approved') state as success. This
 * suite boots the real routers (routes/staff-expenses.js,
 * routes/finance-transactions.js) behind a real HTTP server and a stubbed
 * session, on tenant 1 (Roots), which is the one tenant id that maps to the
 * shared `database.js` handle (lib/tenant-db.js `rawTenantDb`) rather than a
 * separate per-tenant file — so this runs against the real schema and the
 * real capability-resolution path, not a fixture standing in for either.
 *
 *   node scripts/test_staff_expenses_transaction_timing.js
 */
'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

const db = require('../database');
require('../routes/backend-auth'); // schema + seed
const staffExpensesRouter = require('../routes/staff-expenses');
const financeTxRouter = require('../routes/finance-transactions');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack || e.message}`); fail++; }
}

const app = express();
let SESSION = {};
app.use((req, _res, next) => { req.session = SESSION; next(); });
app.use(staffExpensesRouter);
app.use(financeTxRouter);
const server = http.createServer(app);

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: url, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = { _raw: raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  // Tenant 1 (Roots) — see the header for why this id specifically.
  const owner = db.prepare("SELECT id FROM tenant_users WHERE tenant_id = 1 AND role = 'owner'").get();
  if (!owner) { console.log('  (skipped — no seeded owner on tenant 1)'); server.close(); return; }
  SESSION = { backendUserId: owner.id };
  // expense_entries.created_by -> users(id) (the legacy kitchen table). A dev
  // database that has never run the kitchen app has it empty; production's
  // does not. A row at this id is enough for the FK on a non-null created_by.
  try { db.prepare('INSERT OR IGNORE INTO users (id, username, password) VALUES (?, ?, ?)').run(owner.id, 'tx_timing_test', 'x'); } catch (e) {}

  const claimIds = [];
  async function submitClaim(paidBy) {
    const r = await call('POST', '/api/retail-admin/staff-expenses', {
      date: '2026-09-10', amount: 200, category: 'Transport', note: 'tx timing test', paid_by: paidBy || 'company',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    claimIds.push(r.body.id);
    return r.body.id;
  }

  console.log('\n1 · the response reports the POST-transaction state, not the pre-transaction one');

  await it('approving reports status=approved and a real expense_id in the SAME response', async () => {
    const claimId = await submitClaim();
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    assert.strictEqual(dec.status, 200, JSON.stringify(dec.body));
    // Before the fix this read 'submitted' — the state before the (unawaited,
    // still-pending) transaction had run a single statement.
    assert.strictEqual(dec.body.data.status, 'approved');
    assert.ok(dec.body.data.expense_id, 'a posted row must exist and be named');
    // And the database must agree with what the response just claimed —
    // the two diverging is exactly the bug.
    const row = db.prepare('SELECT status, expense_id FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.expense_id, dec.body.data.expense_id);
  });

  console.log('\n2 · voiding an approved claim actually removes it — end to end, over HTTP');

  await it('void reports status=voided, and the ledger no longer carries the row', async () => {
    const claimId = await submitClaim();
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    assert.strictEqual(dec.status, 200);

    const before = await call('GET', '/api/retail-admin/finance/transactions?from=2026-09-01&to=2026-09-30');
    assert.ok(before.body.data.rows.some(r => r.claim_id === claimId), 'the posted row must be on the ledger before voiding');

    const voided = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/void`, {});
    // This is the exact failure Ash hit: before the fix, this either threw an
    // unhandled rejection server-side (the process log would show it, the
    // client got whatever partial response express managed to send) or
    // reported success while the FK error meant nothing had actually voided.
    assert.strictEqual(voided.status, 200, JSON.stringify(voided.body));
    assert.strictEqual(voided.body.data.status, 'voided');
    assert.strictEqual(voided.body.data.expense_id, null);

    const after = await call('GET', '/api/retail-admin/finance/transactions?from=2026-09-01&to=2026-09-30');
    assert.ok(!after.body.data.rows.some(r => r.claim_id === claimId),
      'the row must be gone from the ledger — this is what "still here, and I can void it again" means when it fails');

    const row = db.prepare('SELECT status, decided_by, voided_by FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.status, 'voided');
    assert.ok(row.decided_by, 'the original approver is still on record');
    assert.ok(row.voided_by, 'and who voided it is recorded too');
  });

  await it('voiding again is refused — there is nothing left to reverse', async () => {
    const claimId = await submitClaim();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const first = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/void`, {});
    assert.strictEqual(first.status, 200);
    const second = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/void`, {});
    assert.strictEqual(second.status, 409);
  });

  console.log('\n3 · the pre-existing reject-after-approve path has the same FK ordering fix');

  await it('rejecting a PREVIOUSLY-approved claim also removes its posted row, over HTTP', async () => {
    const claimId = await submitClaim();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const posted = db.prepare('SELECT expense_id FROM staff_expenses WHERE id = ?').get(claimId);
    assert.ok(posted.expense_id, 'must actually be posted first');

    const rej = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'reject' });
    assert.strictEqual(rej.status, 200, JSON.stringify(rej.body));
    assert.strictEqual(rej.body.data.status, 'rejected');
    assert.strictEqual(rej.body.data.expense_id, null);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) n FROM expense_entries WHERE claim_id = ?').get(claimId).n, 0,
      'the posted row must be gone, not left dangling on a rejected claim');
  });

  console.log('\n4 · the ledger row names WHO PUT IT IN THE BOOKS (§92), over HTTP');

  await it('an approved claim reaches the ledger carrying the approver\'s name', async () => {
    // §87's LESSON, APPLIED: its own suite asserted the description carried a
    // name against a fixture that set the name itself, so the lib was covered
    // and the WIRING was dead in production for as long as it shipped. Every
    // §92 assertion in test_finance_transactions.js reads SOURCE. This one runs
    // the real route against the real schema and reads the payload — which is
    // the only kind of test that would have caught §87.
    const claimId = await submitClaim();
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    assert.strictEqual(dec.status, 200, JSON.stringify(dec.body));

    const list = await call('GET', '/api/retail-admin/finance/transactions?from=2026-09-01&to=2026-09-30');
    const row = list.body.data.rows.find(r => r.claim_id === claimId);
    assert.ok(row, 'the posted row must be on the ledger');

    // The approver is this suite's session user, and the name is whatever
    // tenant_users holds for them — resolved across the control-plane handle.
    const me = db.prepare('SELECT display_name, username FROM tenant_users WHERE id = ?').get(owner.id);
    const expected = me.display_name || me.username;
    assert.strictEqual(row.recorded_by, expected,
      'the ledger row must name who approved it — a null here is §87 all over again');

    // AND IT IS NOT THE SAME FACT AS THE SUBJECT. §87 puts the SPENDER in the
    // description; this is who let the money into the accounts. A row where the
    // new field merely echoed the description would look right and say nothing.
    assert.ok(String(row.subject || '').includes('tx timing test'),
      'the description still carries the claim, spender and note');
    assert.notStrictEqual(row.subject, row.recorded_by, 'two facts, not one repeated');

    // A PO row is deliberately unnamed — it collapses several ledger rows.
    for (const po of list.body.data.rows.filter(r => r.source === 'po')) {
      assert.ok(po.recorded_by == null, 'a Purchasing row names no single person');
    }
  });

  await it('the CSV export carries the same name in its own column', async () => {
    const claimId = await submitClaim();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });

    const csv = await call('GET', '/api/retail-admin/finance/transactions/export.csv?from=2026-09-01&to=2026-09-30');
    assert.strictEqual(csv.status, 200);
    // A CSV is not JSON, so `call` hands it back under `_raw` — the helper's own
    // fallback for a body it could not parse.
    const text = String((csv.body && csv.body._raw) || '');
    const [head, ...body] = text.replace(/^\ufeff/, '').split(/\r?\n/);
    const cols = head.split(',');
    assert.strictEqual(cols[cols.length - 1], 'Recorded by', 'the column is appended, not folded in');
    assert.deepStrictEqual(cols.slice(0, 8),
      ['Date', 'Direction', 'Description', 'Category', 'Amount', 'Signed amount', 'Entered by', 'Purchase order'],
      'and the columns a bookkeeper\'s spreadsheet already reads keep their positions');

    const me = db.prepare('SELECT display_name, username FROM tenant_users WHERE id = ?').get(owner.id);
    const expected = me.display_name || me.username;
    const mine = body.filter(l => l.includes('tx timing test'));
    assert.ok(mine.length, 'the claim row must be in the export');
    assert.ok(mine.every(l => l.split(',').pop() === expected),
      'every claim row in the file names its approver in the last column');
  });

  console.log('\n5 · filing a claim under a category, and re-filing one (§146)');

  /* §90's LESSON, APPLIED TO A NEW ROUTE. The re-filing route re-posts a ledger
     row the way `/void` removes one, so it walks into the same FK ordering trap:
     `staff_expenses.expense_id` still points at the `expense_entries` row
     `postClaim` is about to DELETE, and only the REAL schema refuses that. The
     fixture in test_staff_expenses.js declares no such constraint, so it can
     prove the category moves and cannot prove the write survives. This can. */

  async function submitUnfiled() {
    const r = await call('POST', '/api/retail-admin/staff-expenses', {
      date: '2026-09-10', amount: 299, note: 'tx timing test unfiled', paid_by: 'employee',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    claimIds.push(r.body.id);
    return r.body.id;
  }

  await it('a claim can be submitted with no category at all — the state this is about', async () => {
    const claimId = await submitUnfiled();
    const row = db.prepare('SELECT category FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.category, null);
  });

  await it('approving with a category files it, and the ledger row carries it', async () => {
    const claimId = await submitUnfiled();
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`,
      { decision: 'approve', category: 'Transport' });
    assert.strictEqual(dec.status, 200, JSON.stringify(dec.body));
    assert.strictEqual(dec.body.data.status, 'approved');
    const posted = db.prepare('SELECT category, amount FROM expense_entries WHERE claim_id = ?').get(claimId);
    assert.ok(posted, 'a row must be posted');
    assert.strictEqual(posted.category, 'Transport');
    assert.strictEqual(posted.amount, 299, 'and the sum is the one that was claimed');
  });

  await it('approving WITHOUT one leaves the claim as it was, never blanked', async () => {
    // The COALESCE. A bare `category = ?` here would blank the category on every
    // claim decided by a client that does not send the field.
    const r = await call('POST', '/api/retail-admin/staff-expenses', {
      date: '2026-09-10', amount: 88, category: 'Transport', note: 'tx timing test keep', paid_by: 'company',
    });
    claimIds.push(r.body.id);
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${r.body.id}/decide`, { decision: 'approve' });
    assert.strictEqual(dec.status, 200);
    const row = db.prepare('SELECT category FROM staff_expenses WHERE id = ?').get(r.body.id);
    assert.strictEqual(row.category, 'Transport', 'the claim keeps what it arrived with');
  });

  await it('re-filing an approved claim moves the LEDGER row, over HTTP, against the real FK', async () => {
    const claimId = await submitUnfiled();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const before = db.prepare('SELECT id, category, description FROM expense_entries WHERE claim_id = ?').get(claimId);
    assert.ok(before, 'posted, and filed under nothing');
    assert.strictEqual(before.category, null);

    const filed = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/category`, { category: 'Transport' });
    // Before the `expense_id = NULL` ordering, this is where SQLite refuses the
    // delete and the route 500s — the exact shape of §90's bug.
    assert.strictEqual(filed.status, 200, JSON.stringify(filed.body));
    assert.strictEqual(filed.body.data.category, 'Transport');
    assert.ok(filed.body.data.expense_id, 'and the claim names its new row');

    const rows = db.prepare('SELECT * FROM expense_entries WHERE claim_id = ?').all(claimId);
    assert.strictEqual(rows.length, 1, 'one row, re-written — never a second');
    assert.strictEqual(rows[0].category, 'Transport');
    assert.strictEqual(rows[0].amount, 299, 'no money moved');
    assert.strictEqual(rows[0].description, before.description,
      'and the line still says whose taxi it was — the name is re-resolved, not dropped');
    assert.strictEqual(rows[0].id, filed.body.data.expense_id,
      'the claim and the ledger agree on which row stands for it');
  });

  await it('the Transactions screen shows the new category, not the old blank', async () => {
    const claimId = await submitUnfiled();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/category`, { category: 'Transport' });
    const list = await call('GET', '/api/retail-admin/finance/transactions?from=2026-09-01&to=2026-09-30');
    const row = list.body.data.rows.find(r => r.claim_id === claimId);
    assert.ok(row, 'still on the ledger');
    assert.strictEqual(row.category, 'Transport');
  });

  await it('a claim still waiting cannot be re-filed — /decide is the route for that', async () => {
    const claimId = await submitUnfiled();
    const r = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/category`, { category: 'Transport' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  });

  await it('an empty category is refused rather than unfiling the claim', async () => {
    const claimId = await submitUnfiled();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`,
      { decision: 'approve', category: 'Transport' });
    const r = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/category`, { category: '' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    const row = db.prepare('SELECT category FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.category, 'Transport', 'and the refusal changed nothing');
  });

  await it('a SETTLED claim can still be re-filed — unlike voiding it', async () => {
    // Nothing leaves the books here, so the reason /void and /decide refuse a
    // settled claim does not apply. Refusing would mean a category could only
    // ever be corrected before payday.
    const claimId = await submitUnfiled();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const paid = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/settle`, { settled: true });
    assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
    const filed = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/category`, { category: 'Transport' });
    assert.strictEqual(filed.status, 200, JSON.stringify(filed.body));
    const row = db.prepare('SELECT settled, category FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.category, 'Transport');
    assert.ok(row.settled, 'and it is still paid back — re-filing is not a reversal');
  });

  await it('the approval queue carries the list its picker is drawn from', async () => {
    const q = await call('GET', '/api/retail-admin/staff-expenses/pending');
    assert.strictEqual(q.status, 200, JSON.stringify(q.body));
    assert.ok(Array.isArray(q.body.data.categories),
      'the queue and the picker travel together — a second request racing the list '
      + 'is how a queue renders before the options it offers exist');
  });

  console.log('\n6 · correcting who paid, on a claim already in the books (§207)');

  /* THE CLAIM THIS SECTION IS ABOUT. Submitted as own-money, which is what a
     person at a till taps by habit — and which, if it is wrong, is a debt the
     business does not owe sitting in *Owed to your team* until somebody makes a
     real transfer against it. */
  async function submitOwnMoney(amount) {
    const r = await call('POST', '/api/retail-admin/staff-expenses', {
      date: '2026-09-10', amount: amount || 100, category: 'Transport',
      note: 'tx timing test paid-by', paid_by: 'employee',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    claimIds.push(r.body.id);
    return r.body.id;
  }

  await it('an approver moves an approved claim from own money to company money', async () => {
    const claimId = await submitOwnMoney();
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const owedBefore = await call('GET', '/api/retail-admin/staff-expenses/pending');
    assert.ok((owedBefore.body.data.owed || []).some(o => String(o.ids || '').split(',').includes(String(claimId))),
      'it starts as a debt — that is the state being corrected');

    const moved = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: 'company' });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.data.paid_by, 'company');
    const row = db.prepare('SELECT paid_by, status FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.paid_by, 'company');
    assert.strictEqual(row.status, 'approved', 'and it is still approved — this is not a reversal');
  });

  await it('and the debt is gone from the owed list the moment it is', async () => {
    const claimId = await submitOwnMoney(137);
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: 'company' });
    const q = await call('GET', '/api/retail-admin/staff-expenses/pending');
    const stillOwed = (q.body.data.owed || [])
      .some(o => String(o.ids || '').split(',').includes(String(claimId)));
    assert.ok(!stillOwed, 'the whole point: what the shop owes its people is a query over this field');
  });

  await it('**THE LEDGER ROW DOES NOT MOVE** — not its id, not one column of it', async () => {
    /* THIS IS THE ASSERTION THE ROUTE'S DESIGN RESTS ON. It writes one column
       and calls no poster, which is only correct while `lib/expense-posting.js`
       ignores `paid_by`. An edit that makes the posted row depend on who paid
       turns this route into a silent no-op on the books — the claim would say
       one thing and the ledger another, with nothing on screen to say so — and
       this is what would catch it. */
    const claimId = await submitOwnMoney(211);
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const before = db.prepare('SELECT * FROM expense_entries WHERE claim_id = ?').get(claimId);
    assert.ok(before, 'posted');

    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: 'company' });
    const after = db.prepare('SELECT * FROM expense_entries WHERE claim_id = ?').get(claimId);
    assert.ok(after, 'still posted — nothing was deleted and left unreplaced');
    assert.deepStrictEqual(after, before,
      'a re-post here would take a new id for an unchanged row, and a poster that '
      + 'read paid_by would change the books behind an approver correcting a typo');
  });

  await it('it moves the other way too — a company-paid claim that was really out of pocket', async () => {
    const r = await call('POST', '/api/retail-admin/staff-expenses', {
      date: '2026-09-10', amount: 42, category: 'Transport',
      note: 'tx timing test paid-by back', paid_by: 'company',
    });
    claimIds.push(r.body.id);
    await call('POST', `/api/retail-admin/staff-expenses/${r.body.id}/decide`, { decision: 'approve' });
    const moved = await call('POST', `/api/retail-admin/staff-expenses/${r.body.id}/paid-by`, { paid_by: 'employee' });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    const q = await call('GET', '/api/retail-admin/staff-expenses/pending');
    assert.ok((q.body.data.owed || []).some(o => String(o.ids || '').split(',').includes(String(r.body.id))),
      'the correction runs both ways — a debt can be created as well as cleared');
  });

  await it('a SETTLED claim is refused — unlike re-filing, this one would strand a transfer', async () => {
    // The money has already been handed back. Saying the business never owed it
    // leaves a real transfer with nothing behind it, which is why /decide and
    // /void refuse a settled claim — and this borrows their sentence.
    const claimId = await submitOwnMoney(63);
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    const paid = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/settle`, { settled: true });
    assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
    const moved = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: 'company' });
    assert.strictEqual(moved.status, 409, JSON.stringify(moved.body));
    const row = db.prepare('SELECT paid_by FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.paid_by, 'employee', 'and nothing was written');
  });

  await it('a claim still WAITING is refused — /decide is the route that carries it', async () => {
    const claimId = await submitOwnMoney(71);
    const moved = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: 'company' });
    assert.strictEqual(moved.status, 409, JSON.stringify(moved.body));
  });

  await it('a third spelling of "my own money" is refused, in the validator\'s own words', async () => {
    const claimId = await submitOwnMoney(29);
    await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`, { decision: 'approve' });
    for (const bad of ['owner', 'EMPLOYEE', '', 'petty cash']) {
      const r = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/paid-by`, { paid_by: bad });
      assert.strictEqual(r.status, 400, `"${bad}" must be refused: ${JSON.stringify(r.body)}`);
    }
    const row = db.prepare('SELECT paid_by FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.paid_by, 'employee', 'and the field still says one of the two');
  });

  await it('the decision carries who paid, and a client that sends none blanks nothing', async () => {
    // The COALESCE, and it matters more here than for the category: a blank
    // `paid_by` has no meaning at all — it is the field that decides whether a
    // debt exists.
    const corrected = await submitOwnMoney(55);
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${corrected}/decide`,
      { decision: 'approve', paid_by: 'company' });
    assert.strictEqual(dec.status, 200, JSON.stringify(dec.body));
    assert.strictEqual(db.prepare('SELECT paid_by FROM staff_expenses WHERE id = ?').get(corrected).paid_by,
      'company', 'corrected at the moment of approval, in one request');

    const untouched = await submitOwnMoney(56);
    await call('POST', `/api/retail-admin/staff-expenses/${untouched}/decide`, { decision: 'approve' });
    assert.strictEqual(db.prepare('SELECT paid_by FROM staff_expenses WHERE id = ?').get(untouched).paid_by,
      'employee', 'every client older than this change sends no field and must change nothing');
  });

  await it('a bad value on the DECISION refuses the decision itself, rather than approving half of it', async () => {
    const claimId = await submitOwnMoney(57);
    const dec = await call('POST', `/api/retail-admin/staff-expenses/${claimId}/decide`,
      { decision: 'approve', paid_by: 'petty cash' });
    assert.strictEqual(dec.status, 400, JSON.stringify(dec.body));
    const row = db.prepare('SELECT status FROM staff_expenses WHERE id = ?').get(claimId);
    assert.strictEqual(row.status, 'submitted', 'the claim is untouched — refused before the transaction opens');
  });

  // Best-effort cleanup — this runs against the shared dev database (tenant 1
  // maps to it directly), so leave it as it was found.
  for (const id of claimIds) {
    try {
      const row = db.prepare('SELECT expense_id FROM staff_expenses WHERE id = ?').get(id);
      if (row && row.expense_id) db.prepare('DELETE FROM expense_entries WHERE id = ?').run(row.expense_id);
      db.prepare('DELETE FROM staff_expenses WHERE id = ?').run(id);
    } catch (e) { /* best-effort */ }
  }

  server.close();
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
