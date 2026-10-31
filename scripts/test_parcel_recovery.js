#!/usr/bin/env node
/**
 * §189 — a box that went out on an order that was then cancelled is somebody's
 * job, and the shelf only gets it back if a person says it came back.
 *
 *   node scripts/test_parcel_recovery.js
 *
 * WHAT THIS IS FOR. §187 stopped a cancel crediting the shelf with units sitting
 * in a courier's van. That made the count honest and TOLD NOBODY: the money went
 * back, the number was right, and a box on its way to a person who is no longer
 * a customer had no screen anywhere saying so. This is the telling, and the
 * answer to it.
 *
 * THE CLAIMS THIS FILE EXISTS FOR, because each is silent when broken:
 *
 *   1. THE OUTCOME IS ASKED, NEVER ASSUMED. Ash's decision, 2026-09-19, over a
 *      flag-only version and an auto-return one: goods back from a customer are
 *      not automatically sellable — fresh food least of all — so only the person
 *      holding the box can say whether the shelf gets it. 'recovered' returns
 *      that parcel's units; 'not_recovered' moves nothing.
 *   2. PER PARCEL. Two boxes can be out on one cancelled order and only one come
 *      back. Returning the order's whole stock on the first answer would credit
 *      the shelf with a box still in a van — the exact defect §187 removed,
 *      reintroduced one door along.
 *   3. NOTHING IS RETURNED TWICE. The cancel already returned everything still
 *      in the building; this returns what it deliberately left out. The two sets
 *      are disjoint by construction, and section 4 proves it on real numbers
 *      rather than by reading the code.
 *   4. CLOSING IS ATOMIC. Two operators answering at once must not both move
 *      stock. The UPDATE carries `recovery_outcome IS NULL` and the loser gets
 *      `already_closed`.
 *
 * Runs against a THROWAWAY database, on the model of its siblings: the functions
 * under test are extracted from the live sources and executed. The route guards
 * and the three screens have no runnable shape and are read off the real files.
 *
 * TO PROVE THE SUITE CAN FAIL:  PARCEL_RECOVERY_SABOTAGE=1 node scripts/test_parcel_recovery.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let ROUTES  = read('routes/retail.js');
let DESKTOP = read('public/retail-admin/04-orders.js');
let DASH    = read('public/retail-admin/03-dashboard.js');
let HTML    = read('public/retail-admin.html');
const DB     = read('database.js');
const EXTRAS = read('public/retail-admin/10-extras.js');
const VOCAB  = read('docs/tacet-delivery-vocabulary.md');
const DECIDE = read('docs/tacet-consolidation-decisions.md');

const SABOTAGE = process.env.PARCEL_RECOVERY_SABOTAGE === '1';
if (SABOTAGE) {
  // Each mutation is one this change was genuinely at risk of.
  ROUTES  = ROUTES.replace(
    'AND (prepared_at IS NOT NULL OR dispatched_at IS NOT NULL OR delivered_at IS NOT NULL)',
    'AND 1 = 1');                                            // flags parcels that never left
  ROUTES  = ROUTES.replace(
    `WHERE order_id = ? AND shipment_id = ? AND product_id IS NOT NULL`,
    `WHERE order_id = ? AND ? IS NOT NULL AND product_id IS NOT NULL`);  // whole order, not the parcel
  ROUTES  = ROUTES.replace(
    'WHERE id = ? AND recovery_needed_at IS NOT NULL AND recovery_outcome IS NULL',
    'WHERE id = ?');                                         // the race guard
  HTML    = HTML.replace('data-status="recover_parcel"', 'data-status="recover_parcelX"');
  // §191 — the scoping dropped, which is the double-credit regression.
  ROUTES  = ROUTES.replace(
    'const lines = base\n    .map((r) => ({ product_id: r.product_id, qty: r.qty - (gone.get(r.product_id) || 0) }))',
    'const lines = base\n    .map((r) => ({ product_id: r.product_id, qty: r.qty }))');
}

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}
function section(t) { results.push({ heading: t }); }

function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}
const FNS = ['flagParcelsForRecovery', 'parcelStockLines', 'orderShippedQty',
  // §191 — RUN, not read. The assertions below used to read orderShippedQty
  // and reason about the helper; dropping the helper's subtraction left every
  // one of them green, which is a test that cannot fail about the exact
  // regression it was written for.
  'reverseOrderStockStillHere'];
const src = {};
for (const n of FNS) src[n] = extractFn(n, ROUTES);

section('── 0. Extraction');
check('every function under test was found in its source', FNS.filter((n) => !src[n]), []);

// ── Schema: only the columns these assertions read ──────────────────────────
const dbPath = path.join(os.tmpdir(), `parcel-recovery-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT
  );
  CREATE TABLE retail_order_items (
    id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty INTEGER,
    shipment_id INTEGER
  );
  CREATE TABLE retail_shipments (
    id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    prepared_at DATETIME, dispatched_at DATETIME, delivered_at DATETIME,
    recovery_needed_at DATETIME, recovery_outcome TEXT,
    recovery_closed_at DATETIME, recovery_closed_by TEXT,
    updated_at DATETIME
  );
`);
// Every call the helper makes to reverseOrderStock is recorded here, so what it
// hands the shelf is observed rather than inferred from its source.
const reversals = [];
const routes = new Function('db', 'reversals', `
  const tdb = () => db;
  const reverseOrderStock = (orderId, opts) => reversals.push({ orderId, lines: opts.lines || null });
  ${FNS.map((n) => src[n]).join('\n')}
  return { ${FNS.join(', ')} };
`)(db, reversals);

const ALMOND = 340, PITA = 251, CRISP = 800;
let nextOrder = 600, nextShip = 700;
function mkOrder() {
  const id = ++nextOrder;
  db.prepare("INSERT INTO retail_orders (id, order_no, status) VALUES (?,?,'cancelled')")
    .run(id, 'TC00' + id);
  return id;
}
function mkParcel(orderId, lines, { dispatched = false, prepared = false } = {}) {
  const id = ++nextShip;
  db.prepare(
    `INSERT INTO retail_shipments (id, order_id, mode, dispatched_at, prepared_at)
     VALUES (?,?,'land',?,?)`
  ).run(id, orderId, dispatched ? '2026-09-19 10:00:00' : null,
        prepared ? '2026-09-19 09:00:00' : null);
  for (const [pid, qty] of lines) {
    db.prepare('INSERT INTO retail_order_items (order_id, product_id, qty, shipment_id) VALUES (?,?,?,?)')
      .run(orderId, pid, qty, id);
  }
  return id;
}
const shipRow = (sid) => db.prepare('SELECT * FROM retail_shipments WHERE id = ?').get(sid);

// ─────────────────────────────────────────────────────────────────────────────
section('── 1. Which boxes become somebody\'s job');

const order = mkOrder();
const gone    = mkParcel(order, [[ALMOND, 2], [CRISP, 1]], { dispatched: true });
const packed  = mkParcel(order, [[CRISP, 1]], { prepared: true });
const onBench = mkParcel(order, [[PITA, 1]]);
check('the cancel flags exactly the boxes that had left the count', routes.flagParcelsForRecovery(order), 2);
check('…the dispatched one', !!shipRow(gone).recovery_needed_at, true);
/* §180 — A PACKED BOX COUNTS. Packing is when the stock comes off the count,
   and a packed box on the bench is the easiest recovery there is and the one
   most likely to be forgotten. */
check('…the packed one, because packing is when its stock left', !!shipRow(packed).recovery_needed_at, true);
check('…and never the one still on the bench', shipRow(onBench).recovery_needed_at, null);

/* IDEMPOTENT. The cancel branch can be reached more than once, and a re-run
   must not re-open a case somebody has already closed — closing one moves
   stock. */
db.prepare("UPDATE retail_shipments SET recovery_outcome = 'recovered' WHERE id = ?").run(gone);
check('a re-run re-opens nothing', routes.flagParcelsForRecovery(order), 0);
check('…leaving the closed case closed', shipRow(gone).recovery_outcome, 'recovered');

// An order that ends normally has nothing to chase, which is almost every order.
const normal = mkOrder();
mkParcel(normal, [[ALMOND, 1]]);
check('an order whose boxes never left flags nothing', routes.flagParcelsForRecovery(normal), 0);

// ─────────────────────────────────────────────────────────────────────────────
section('── 2. What goes back is THIS parcel, not the order');

/* Two boxes out on one cancelled order and only one comes back. Returning the
   order's whole stock on the first answer would credit the shelf with a box
   still in a van — the exact defect §187 removed, one door along. */
check('a parcel returns its own lines only',
  routes.parcelStockLines(order, gone).map((r) => [r.product_id, r.qty]).sort((a, b) => a[0] - b[0]),
  [[ALMOND, 2], [CRISP, 1]].sort((a, b) => a[0] - b[0]));
check('…and its sibling returns a different set',
  routes.parcelStockLines(order, packed).map((r) => [r.product_id, r.qty]), [[CRISP, 1]]);
check('…so the two together are what the order had out, and no more',
  routes.parcelStockLines(order, gone).length + routes.parcelStockLines(order, packed).length, 3);

// ─────────────────────────────────────────────────────────────────────────────
section('── 3. The two reversals are disjoint, on real numbers');

/* THE CLAIM: §187's cancel returned everything still in the building, and this
   returns what it deliberately left out. Proven by arithmetic rather than by
   reading the code — CRISP is the interesting one, split across a box that went
   and a box that did not. */
const shipped = routes.orderShippedQty(order);            // what the cancel subtracted
const whole = db.prepare(
  `SELECT product_id, SUM(qty) AS qty FROM retail_order_items
    WHERE order_id = ? AND product_id IS NOT NULL GROUP BY product_id`).all(order);
const cancelReturned = whole
  .map((r) => [r.product_id, r.qty - (shipped.get(r.product_id) || 0)])
  .filter(([, q]) => q > 0);
const recoveryReturns = [...routes.parcelStockLines(order, gone),
                         ...routes.parcelStockLines(order, packed)]
  .reduce((m, r) => m.set(r.product_id, (m.get(r.product_id) || 0) + r.qty), new Map());

check('the cancel returned only the units still on the bench',
  cancelReturned.sort((a, b) => a[0] - b[0]), [[PITA, 1]]);
/* CRISP IS ×2 HERE AND THAT IS THE POINT OF THE FIXTURE: one unit in the
   dispatched box, one in the packed box, so BOTH come back through recovery and
   neither through the cancel. The first draft of this assertion expected 1 and
   was wrong about its own fixture — recorded because a summed-per-product
   expectation is exactly where a per-parcel feature gets mis-asserted. */
check('…and the recovery returns only the units that had gone, summed across both boxes',
  [...recoveryReturns.entries()].sort((a, b) => a[0] - b[0]),
  [[ALMOND, 2], [CRISP, 2]].sort((a, b) => a[0] - b[0]));
/* EVERY UNIT ACCOUNTED FOR EXACTLY ONCE. CRISP was ordered ×2 — one in the
   packed box, one in the dispatched box — and both come back through recovery,
   neither through the cancel. Nothing is returned twice and nothing is lost. */
const total = new Map(cancelReturned);
for (const [pid, q] of recoveryReturns) total.set(pid, (total.get(pid) || 0) + q);
check('together they account for every ordered unit exactly once',
  [...total.entries()].sort((a, b) => a[0] - b[0]),
  whole.map((r) => [r.product_id, r.qty]).sort((a, b) => a[0] - b[0]));

// ─────────────────────────────────────────────────────────────────────────────
section('── 4. The route: asked, atomic, one-way');

const at = ROUTES.indexOf("router.post('/api/retail-admin/orders/:id/shipments/:sid/recovery'");
const body = at === -1 ? '' : ROUTES.slice(at, ROUTES.indexOf('\n});', at));
check('the route exists', at !== -1, true);
check('it takes exactly two outcomes and refuses anything else',
  [/RECOVERY_OUTCOMES = new Set\(\['recovered', 'not_recovered'\]\)/.test(ROUTES),
   /bad_outcome/.test(body)], [true, true]);
check('a parcel with no open case is refused', /no_recovery_open/.test(body), true);
/* ATOMIC. Two operators answering at once must not both move stock — closing
   one returns units to the shelf, and doing it twice would invent them. */
check('closing carries the race guard, and the loser is told',
  [/WHERE id = \? AND recovery_needed_at IS NOT NULL AND recovery_outcome IS NULL/.test(body),
   /already_closed/.test(body)], [true, true]);
/* ONLY 'recovered' MOVES STOCK. This is Ash's decision in one line of code, and
   the whole difference between this design and the auto-return one. */
check("only 'recovered' reaches the shelf",
  /if \(outcome === 'recovered'\) \{[\s\S]{0,400}?reverseOrderStock/.test(body), true);
check('…through the same door the cancel uses, scoped to this parcel',
  /const lines = parcelStockLines\(id, sid\);/.test(body), true);
check('…and the stock move is stamped with who said so',
  /parcel recovered — \$\{o\.order_no\} parcel \$\{sid\}/.test(body), true);
// The cancel is what opens a case. A refund is deliberately not wired: the goods
// are legitimately with the customer there, and returns are their own thing.
check('the cancel branch opens the cases', /flagParcelsForRecovery\(id\);/.test(ROUTES), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 4b. §191 — a refund chases boxes too, and cannot pay for them twice');

/* THE HAZARD THIS SECTION EXISTS FOR, and it is why §191 could not be "add one
   call". Every refund path reversed the WHOLE order's stock, including units
   already with the customer. Open a recovery case on top of that and "it came
   back" returns the same units a SECOND time — the shop credited twice for one
   box. So the reversal had to be scoped in the same change, not after it. */
check('the shared helper is what every path reverses through',
  /function reverseOrderStockStillHere\(orderId, rows, opts\) \{/.test(ROUTES), true);
check('…and no refund path reverses the whole order unscoped any more',
  (ROUTES.match(/reverseOrderStock\(id, \{/g) || []).length, 1);   // §189's recovery close, which must
check('…which is §189\'s recovery close, the one call that SHOULD return what has gone',
  /note: `parcel recovered — \$\{o\.order_no\} parcel \$\{sid\}`/.test(ROUTES), true);

/* THE FAST PATH IS PRESERVED AND IS NOT AN OPTIMISATION. With nothing shipped,
   rows pass through untouched — including null, which reverseOrderStock turns
   into reverseCommittedOrder and ledger reason 'order_reverse'. The scoped form
   writes 'order_reverse_partial', whose rows reverseCommittedOrder's idempotency
   guard cannot see. Routing the ordinary refund down the scoped path would
   change the ledger reason on the overwhelming majority of refunds for nothing. */
check('an order with nothing shipped still takes the unscoped reverse',
  /if \(!gone\.size\) \{ reverseOrderStock\(orderId, \{ lines: rows, \.\.\.opts \}\); return; \}/.test(ROUTES), true);

/* FULL REFUNDS FLAG, PARTIAL ONES DO NOT, and that is a judgement stated out
   loud rather than an omission. A partial refund of a delivered order is a
   goodwill or short-shipment adjustment — the shop is not asking for the box
   back, and a chase job for one would be work nobody wants done. */
for (const [label, marker] of [
  ['the approve path', "note: 'refund approved (full)' });"],
  ['the direct path',  "note: 'refund (direct full)' });"],
  ['the completing remainder', "note: 'refund (direct completing remainder)' });"],
]) {
  const at = ROUTES.indexOf(marker);
  check(`${label} opens the recovery cases`,
    at !== -1 && /^\s*flagParcelsForRecovery\(id\);/.test(ROUTES.slice(at + marker.length, at + marker.length + 60)), true);
}
for (const marker of ["note: 'refund approved (partial lines)' });", "note: 'refund (direct partial lines)' });"]) {
  const at = ROUTES.indexOf(marker);
  check('a partial refund does not ask for the box back',
    at !== -1 && !/flagParcelsForRecovery/.test(ROUTES.slice(at, at + 200)), true);
}

/* ON REAL NUMBERS: a full refund of an order whose box has gone returns only
   what is still here, and the recovery returns the rest — each unit once. The
   fixture reuses §189's order above, where ALMOND ×2 and CRISP ×2 went and
   PITA ×1 did not. */
const refunded = mkOrder();
const rGone = mkParcel(refunded, [[ALMOND, 3]], { dispatched: true });
mkParcel(refunded, [[PITA, 2]]);
const rShipped = routes.orderShippedQty(refunded);
const rWhole = db.prepare(
  `SELECT product_id, SUM(qty) AS qty FROM retail_order_items
    WHERE order_id = ? AND product_id IS NOT NULL GROUP BY product_id`).all(refunded);
check('a full refund returns only the units still on the bench',
  rWhole.map((r) => [r.product_id, r.qty - (rShipped.get(r.product_id) || 0)]).filter(([, q]) => q > 0),
  [[PITA, 2]]);
check('…and the refund opens a case for the box that went',
  [routes.flagParcelsForRecovery(refunded), !!shipRow(rGone).recovery_needed_at], [1, true]);
check('…whose recovery returns the other three, so each unit moves exactly once',
  routes.parcelStockLines(refunded, rGone).map((r) => [r.product_id, r.qty]), [[ALMOND, 3]]);

/* AND THE HELPER IS RUN, not reasoned about. This is the assertion that fails
   when the subtraction is dropped — the double-credit regression, which every
   source-reading assertion above stayed green through. */
reversals.length = 0;
routes.reverseOrderStockStillHere(refunded, null, { note: 'full refund' });
check('the helper hands the shelf only the units still here',
  reversals.map((r) => (r.lines || []).map((l) => [l.product_id, l.qty])), [[[PITA, 2]]]);

// The fast path, observed: nothing shipped means rows pass through untouched,
// null included, so the ordinary refund keeps its 'order_reverse' ledger reason.
const clean = mkOrder();
mkParcel(clean, [[CRISP, 1]]);
reversals.length = 0;
routes.reverseOrderStockStillHere(clean, null, { note: 'full refund' });
check('…and passes null straight through when nothing has shipped',
  reversals.map((r) => r.lines), [null]);

// Every unit on the order already gone → the call is SKIPPED, never made with
// [], which reverseOrderStock would read as "reverse the whole order".
const allGone = mkOrder();
mkParcel(allGone, [[CRISP, 4]], { dispatched: true });
reversals.length = 0;
routes.reverseOrderStockStillHere(allGone, null, { note: 'full refund' });
check('…and reverses nothing at all when every unit has gone', reversals.length, 0);

// ─────────────────────────────────────────────────────────────────────────────
section('── 5. Three screens, and the chip that is load-bearing');

check('the parcel payload carries the case', /recovery_needed_at: s\.recovery_needed_at \|\| null/.test(ROUTES), true);
check('the drawer draws a control for an open one',
  /function renderParcelRecovery\(o, s\) \{[\s\S]{0,200}?if \(!s \|\| !s\.recovery_needed_at\) return '';/.test(DESKTOP), true);
check('…with both answers on it',
  ["closeParcelRecovery(${o.id}, ${s.id}, 'recovered'", "closeParcelRecovery(${o.id}, ${s.id}, 'not_recovered'"]
    .filter((t) => !DESKTOP.includes(t)), []);
check('…and states the closed outcome instead once answered',
  /if \(s\.recovery_outcome\) \{/.test(DESKTOP), true);
check('the dashboard counts open cases only',
  /recovery_needed_at IS NOT NULL AND recovery_outcome IS NULL/.test(ROUTES), true);
check('…and the Needs-you row reads that block', /DASH_OPS\.parcel_recovery/.test(DASH), true);
check('…and is published in the ops payload', /feedback_waiting, kitchen_ready, batch_owed, parcel_recovery,/.test(ROUTES), true);

/* THE CHIP HAS TO EXIST FOR THE ROW TO WORK AT ALL. tdSecOpenOrders finds the
   chip by data-status and does nothing QUIETLY when there is none — which is how
   §98's "Needs a call" card jumped to Orders and applied no filter for six days.
   The <select> fails the same way from the other side: it refuses a value it has
   no <option> for, and the list WIDENS to everything with the chip lit. */
check('the orders chip exists', /data-status="recover_parcel"/.test(HTML), true);
check('…and the hidden select has its option, or the filter is silently dropped',
  /<option value="recover_parcel">/.test(HTML), true);
check('…and the server resolves it as a pseudo-status',
  /status === 'recover_parcel'/.test(ROUTES), true);
/* Registered in the admin dictionary, which its neighbour is not: "Needs a
   call" has had no entry since §98 and shows English in a Chinese admin. */
check('the chip has its Chinese, unlike the neighbour it sits beside',
  /'To recover': '待收回',/.test(EXTRAS), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 6. Schema, Chinese, and the decision');

check('the four columns are added the way every column beside them is',
  ['recovery_needed_at', 'recovery_outcome', 'recovery_closed_at', 'recovery_closed_by']
    .filter((c) => !DB.includes(`addColumn('retail_shipments', '${c}'`)), []);
check('the vocabulary carries the section',
  /## A box that went out on an order that was cancelled/.test(VOCAB), true);
check('…with the live pair it copied and the words built on it',
  ['已收回', '未收回', '待收回', '待收回包裹'].filter((t) => !VOCAB.includes(t)), []);
/* 收回 is what the SHOP does to a thing it handed out; 退回 is what the STOCK
   does. Collapsing them would make "did it come back" and "does the shelf get
   it" read as one question, which is the distinction this control exists for. */
check('…and keeps 收回 and 退回 apart, on the record',
  /\*\*WHY 收回 AND NOT 退回\.\*\*/.test(VOCAB), true);
check('…recording the candidates it turned down',
  ['`退回中`', '`召回`', '`作废`'].filter((t) => !VOCAB.includes(t)), []);
check('§191 is recorded before the code that depends on it',
  /\*\*§191 · A REFUND CHASES ITS BOXES TOO/.test(DECIDE), true);
check('§189 is recorded before the code that depends on it',
  /\*\*§189 · A BOX THAT WENT OUT ON AN ORDER THAT WAS THEN CANCELLED IS SOMEBODY'S JOB/.test(DECIDE), true);

// ── Report ──────────────────────────────────────────────────────────────────
db.close();
try { fs.unlinkSync(dbPath); } catch {}

for (const r of results) {
  if (r.heading) { console.log('\n' + r.heading); continue; }
  if (r.ok) console.log('  PASS  ' + r.name);
  else console.log('  FAIL  ' + r.name + '\n        expected ' + JSON.stringify(r.expected)
    + '\n        actual   ' + JSON.stringify(r.actual));
}
const total2 = results.filter((r) => !r.heading).length;
console.log(`\n${total2 - failures}/${total2} passed`);
if (SABOTAGE) {
  console.log(failures ? 'SABOTAGE: the suite went red, as it must.'
    : 'SABOTAGE: the suite stayed GREEN — it is not testing what it claims.');
  process.exit(failures ? 0 : 1);
}
process.exit(failures ? 1 : 0);
