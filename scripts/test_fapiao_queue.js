#!/usr/bin/env node
// THE PENDING COUNT MEANS ONE THING — on Home, on the dot, and on the list.
//
// THE DEFECT THIS COVERS. Five places asked "which fapiao are waiting?" and one
// of them asked it wrong. Home's "Needs you" row (/dashboard/ops), the unseen
// dot (/invoices/unseen-count), the Orders tab's needs_invoice pseudo-status
// and its badge all required the order to be alive — not cancelled, not still
// awaiting payment. The Invoices LIST endpoint filtered on `needs_invoice = 1`
// and stopped there.
//
// So a fapiao request left behind by a CANCELLED order was counted by the list
// as work waiting to be done, and ignored by Home. On 2026-09-11 an operator's
// phone read "Pending 2" on the Invoices screen with nothing on Home beside it.
// Both numbers were sincere and the operator's conclusion — "the alerting is
// broken" — was the reasonable one to draw and the wrong one: the alert was
// right, the list was counting the dead.
//
// THE RULE NOW. Every caller takes its predicate from lib/fapiao-queue.js.
// A cancelled or unpaid order's un-issued request is NOT pending work, is NOT
// deleted from the list, and is counted under its own name (`blocked`) so the
// All chip still adds up and "2 requests nobody can act on" stays visible.
//
// USAGE   node scripts/test_fapiao_queue.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 no SQLite driver

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const M_SRC      = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

const fq = require('../lib/fapiao-queue');
const MINI_SRC = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'invoices', 'invoices.js'), 'utf8');
const SHOP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'shop.html'), 'utf8');
const ORD_SRC  = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const BILL_SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '07-content-billing.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

let openMemoryDb, driver;
try { ({ openMemoryDb, driver } = require('./test-support/memory-db')); }
catch (e) { console.error('[test_fapiao_queue] no usable SQLite driver:', e.message); process.exit(2); }

console.log(`\ntest_fapiao_queue — driver: ${driver}\n`);

// ── A shop with one of everything ────────────────────────────────────────────
// Only the columns the predicates read. A narrower table than retail_orders on
// purpose: this suite is about the WHERE clause, and a schema-shaped fixture
// would let a column rename pass while the logic rotted.
const db = openMemoryDb();
db.exec(`
CREATE TABLE retail_orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT,
  status TEXT,
  needs_invoice INTEGER DEFAULT 0,
  invoice_status TEXT,
  placed_at TEXT
);
INSERT INTO retail_orders (id, order_no, status, needs_invoice, invoice_status, placed_at) VALUES
  -- The real pending queue: asked for, not issued, order alive.
  (1, 'TC000500', 'paid',      1, 'requested', '2026-09-01'),
  (2, 'TC000501', 'preparing', 1, NULL,        '2026-09-02'),
  (3, 'TC000502', 'delivered', 1, 'requested', '2026-09-03'),
  -- Issued. Done work, whatever happened to the order afterwards.
  (4, 'TC000503', 'delivered', 1, 'issued',    '2026-08-20'),
  (5, 'TC000504', 'cancelled', 1, 'issued',    '2026-08-21'),
  -- THE TWO FROM THE FLOOR. Requests stranded on orders nobody can invoice.
  (6, 'TC000342', 'cancelled',       1, 'requested', '2026-08-21'),
  (7, 'TC000407', 'pending_payment', 1, NULL,        '2026-08-26'),
  -- Never asked for one.
  (8, 'TC000505', 'paid',      0, NULL,        '2026-09-04');
`);

const count = (sql) => db.prepare(`SELECT COUNT(*) AS n FROM retail_orders o WHERE ${sql}`).get().n;
const nos   = (sql) => db.prepare(`SELECT order_no FROM retail_orders o WHERE ${sql} ORDER BY o.id`).all().map(r => r.order_no);

// ── The counts ───────────────────────────────────────────────────────────────
ok(count(fq.pendingSql('o')) === 3,
   'pending counts only live orders with an un-issued request', nos(fq.pendingSql('o')));
ok(count(fq.issuedSql('o')) === 2,
   'issued counts both, including the one whose order was cancelled after the fapiao went out');
ok(count(fq.blockedSql('o')) === 2,
   'blocked counts the two stranded requests', nos(fq.blockedSql('o')));
ok(count(fq.requestedSql('o')) === 7,
   'requested counts every fapiao request there has ever been');

// THE INVARIANT THE DEFECT BROKE. The All chip sums the three; if they ever stop
// partitioning the requests, All disagrees with the rows under it again.
ok(count(fq.pendingSql('o')) + count(fq.issuedSql('o')) + count(fq.blockedSql('o'))
   === count(fq.requestedSql('o')),
   'pending + issued + blocked accounts for every request, with nothing double-counted');

// ── The two from the floor, by name ──────────────────────────────────────────
const pend = nos(fq.pendingSql('o'));
ok(!pend.includes('TC000342'),
   "the cancelled order's request is not pending work");
ok(!pend.includes('TC000407'),
   "the unpaid order's request is not pending work — a fapiao is issued against money received");
ok(nos(fq.unissuedSql('o')).includes('TC000342') && nos(fq.unissuedSql('o')).includes('TC000407'),
   'BUT BOTH ARE STILL THERE. unissuedSql is what the All tab lists: excluded from the '
   + 'count, never deleted from the list — a request that silently vanishes is the '
   + 'failure this module exists to stop');

// ── An issued fapiao outlives its order ──────────────────────────────────────
ok(nos(fq.issuedSql('o')).includes('TC000504'),
   'a fapiao issued before the order was cancelled still reads as issued — the document '
   + 'exists, and hiding it would lose the one row that needs a 红冲');
ok(!nos(fq.blockedSql('o')).includes('TC000504'),
   'and it is not blocked work: blocked is un-issued requests only');

// ── The row-level twin agrees with the SQL ───────────────────────────────────
ok(fq.isIssuableStatus('paid') && fq.isIssuableStatus('delivered'),
   'isIssuableStatus passes a live order');
ok(!fq.isIssuableStatus('cancelled') && !fq.isIssuableStatus('pending_payment'),
   'isIssuableStatus refuses both dead states');
ok(!fq.isIssuableStatus('CANCELLED'),
   'and it is case-insensitive — a status read off a row is not guaranteed lower-case');

// ── No call site restates the predicate ──────────────────────────────────────
// THE REGRESSION GUARD, and the point of the whole module. The defect was not a
// wrong clause; it was FIVE COPIES of a clause, one of which was never updated.
// A sixth copy typed into routes/retail.js would recreate it exactly.
const strays = RETAIL_SRC.split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => /status\s+NOT\s+IN\s*\(\s*'cancelled'\s*,\s*'pending_payment'\s*\)/i.test(line));
ok(strays.length === 0,
   'routes/retail.js states the cancelled/unpaid exclusion nowhere — every caller reads '
   + 'lib/fapiao-queue.js', strays.map(s => s.n));

ok(/require\('\.\.\/lib\/fapiao-queue'\)/.test(RETAIL_SRC),
   'routes/retail.js requires the shared module');

// The list endpoint specifically — the one that was wrong.
const listBlock = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.get('/api/retail-admin/invoices'"));
ok(/fapiaoQueue\.pendingSql/.test(listBlock.slice(0, 2500)),
   'the Invoices list endpoint builds its `requested` filter from pendingSql');
ok(/blocked:\s+tdb\(\)/.test(listBlock.slice(0, 3000)),
   'and ships a `blocked` count so the All chip can still add up');

// ── The phone stops calling them Pending ─────────────────────────────────────
ok(/const INV_DEAD=\{cancelled:1,pending_payment:1\}/.test(M_SRC),
   'm.html knows which order states a request cannot leave');
ok(/\(!v\.issued&&!v\.dead\)/.test(M_SRC),
   'the Pending chip filters the dead rows out client-side too — the count and the rows '
   + 'under it are one number');
ok(/\(c\.requested\|\|0\)\+\(c\.issued\|\|0\)\+\(c\.blocked\|\|0\)/.test(M_SRC),
   'and All sums three, not two');

// ── The customer's own list ──────────────────────────────────────────────────
// THE DEFECT THIS ROUND. Operator screens already refused to call a cancelled
// order's request pending. "Your invoices" did not: it mapped every unissued
// row to requested, and the mini app printed that as Processing. TCO01436 was
// cancelled and still sat on that list as work in progress.
const stateOf = (row) => db.prepare(
  `SELECT ${fq.customerStateSql('o')} AS invoice_state FROM retail_orders o WHERE o.id = ?`
).get(row).invoice_state;
ok(stateOf(1) === 'requested',
   'a live unissued request is still requested — the customer sees Processing');
ok(stateOf(6) === 'closed',
   "the cancelled order's unissued request is closed, not requested");
ok(stateOf(7) === 'requested',
   'an unpaid order that has not been cancelled is still a request — cancel is what closes it');
ok(stateOf(5) === 'issued',
   'a fapiao issued and then cancelled stays issued');
ok(fq.isActiveRequest({ needs_invoice: 1, invoice_status: 'requested', status: 'paid' }),
   'isActiveRequest passes a live unissued request');
ok(!fq.isActiveRequest({ needs_invoice: 1, invoice_status: 'requested', status: 'cancelled' }),
   'isActiveRequest refuses the cancelled one — there is nothing to issue');
ok(!fq.isActiveRequest({ needs_invoice: 1, invoice_status: 'issued', status: 'paid' }),
   'and an issued fapiao is not an open request');

const custBlock = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.get('/api/retail/invoices'"));
ok(/fapiaoQueue\.customerStateSql\(/.test(custBlock.slice(0, 1200)),
   "the customer's invoice list takes its state from customerStateSql");
ok(!/CASE WHEN invoice_status = 'issued' THEN 'issued' ELSE 'requested'/.test(custBlock.slice(0, 1200)),
   'and no longer folds every unissued row into requested');

const issueBlock = RETAIL_SRC.slice(RETAIL_SRC.indexOf("router.put('/api/retail-admin/orders/:id/invoice'"));
ok(/fapiao_closed/.test(issueBlock.slice(0, 1800)),
   'mark-issued refuses a cancelled order — the request cannot be completed after the cancel');
ok(/action !== 'unissue'/.test(issueBlock.slice(0, 1800)),
   'un-issue is still allowed, so a fapiao written by mistake can come back off');

ok(/stateClosed: 'Cancelled'/.test(MINI_SRC) && /stateClosed: '已取消'/.test(MINI_SRC),
   "the mini app's invoice badge says Cancelled / 已取消 for a closed request — the live order-status pair");
ok(/invoice_state === 'closed' \? c\.stateClosed/.test(MINI_SRC),
   'and it only uses that pair when the server says closed, not for every unissued row');
ok(/invoice_state==='closed'/.test(SHOP_SRC) && /已取消/.test(SHOP_SRC),
   'the web store reads the same state and the same pair');
ok(/!issued && o\.status === 'cancelled'/.test(ORD_SRC),
   'the desktop orders list does not mark a cancelled request as still to issue');
ok(/const closed = !issued && o\.status === 'cancelled'/.test(BILL_SRC)
   && /closed \? ''/.test(BILL_SRC),
   'the desktop drawer keeps the request and drops Mark issued once the order is cancelled');
ok(/o\.raw==='cancelled'/.test(M_SRC) && /closed\?T\('Cancelled','已取消'\)/.test(M_SRC),
   "the phone's order sheet uses the same closed pill and does not offer Mark issued");

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
process.exit(fail ? 1 : 0);
