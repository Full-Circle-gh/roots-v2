#!/usr/bin/env node
/**
 * §180 — POST /api/retail-admin/orders/:id/shipments/:sid/prepare, and the two
 * screens that reach it.
 *
 *   node scripts/test_parcel_prepare.js
 *
 * WHAT THIS IS FIXING, so the assertions read as more than shape-checking.
 * An order split into two parcels, one shipped and one parked, had NO WAY to
 * move the parked box forward. Not a hidden button — there was no package-level
 * status at all. `shipmentState` derives three values from two timestamps, while
 * `paid` and `preparing` are ORDER words in one column, and the drawer's forward
 * buttons are a pure function of that column. The first parcel out flips the
 * order to 'dispatched', at which point NEXT_STATUS offers only Mark delivered
 * and Refund; STATUS_TRANSITIONS.preparing.prev is ['paid','awaiting_restock']
 * and undo-dispatch is refused once any parcel carries a waybill, so Start
 * preparing left the screen for good. The box sat there and its stock sat on the
 * count with it.
 *
 * THE LOAD-BEARING DESIGN CLAIM, and most of what this file guards: PREPARED IS
 * A SEPARATE AXIS, NOT A FOURTH VALUE OF `state`. A packed box HAS NOT LEFT, and
 * half a dozen call sites read `state === 'pending'` to mean "still here"
 * (canDispatch, canSplit, the local-ETA and tracking cards on both screens, the
 * partial rollup). All of them must keep answering the same way for a packed
 * parcel; a fourth value would have needed every one edited correctly, and the
 * failure mode is a prepared box nobody can dispatch. Section 2 pins that.
 *
 * WHAT IS DELIBERATELY NOT HERE: the route does not touch the order's status.
 * Rolling an order back to 'preparing' while its sibling parcel is genuinely in
 * transit would tell the customer their order is 备货中 again. §180 records the
 * refusal; section 3 makes it a test.
 *
 * The stock behaviour itself lives in test_fresh_stock_deferral.js, which owns
 * the §58 hold-back and now covers packing two parked boxes end to end. This
 * file owns the ROUTE and the two clients.
 *
 * TO PROVE THE SUITE CAN FAIL:  PARCEL_PREPARE_SABOTAGE=1 node scripts/test_parcel_prepare.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let ROUTES  = read('routes/retail.js');
let INV     = read('lib/inventory.js');
let DESKTOP = read('public/retail-admin/04-orders.js');
let MOBILE  = read('public/m.html');
const DB     = read('database.js');
const VOCAB  = read('docs/tacet-delivery-vocabulary.md');
const DECIDE = read('docs/tacet-consolidation-decisions.md');

// A sabotage mode, because a suite nobody has seen fail is a suite nobody
// should trust. Each mutation is one the change was actually at risk of.
if (process.env.PARCEL_PREPARE_SABOTAGE === '1') {
  ROUTES  = ROUTES.replace("if (ship.dispatched_at || ship.delivered_at) {", "if (false) {");
  DESKTOP = DESKTOP.replace("st === 'pending' && s.prepared", "s.prepared");
  MOBILE  = MOBILE.replace("prepared:'warning',", "");
}

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + '\n      expected ' + e + '\n      actual   ' + a); }
}

// ── 1. The route exists, exactly once ──────────────────────────────────────
// EXACTLY ONCE is §24's lesson and not ceremony: /shipments/split carried two
// registrations for eight weeks, Express matched the first, and the unreachable
// branch deleted every parcel on the order while reporting success.
const PREPARE_PATH = "'/api/retail-admin/orders/:id/shipments/:sid/prepare'";
check('the prepare route is registered exactly once',
  (ROUTES.match(new RegExp("router\\.post\\(" + PREPARE_PATH.replace(/[/:]/g, '\\$&'), 'g')) || []).length, 1);

// The handler body, so every assertion below reads the route and not the file.
const at = ROUTES.indexOf('router.post(' + PREPARE_PATH);
const nextRoute = ROUTES.indexOf('router.post(', at + 10);
const BODY = at === -1 ? '' : ROUTES.slice(at, nextRoute === -1 ? ROUTES.length : nextRoute);
check('the handler body was found', BODY.length > 200, true);

// ── 2. PREPARED IS A SEPARATE AXIS ─────────────────────────────────────────
// The design claim §180 turns on. shipmentState must still answer with exactly
// the three words it always did, or every `state === 'pending'` guard in the
// product silently changes meaning.
const stateFn = ROUTES.slice(ROUTES.indexOf('function shipmentState(s) {'),
                             ROUTES.indexOf('function shipmentPrepared(s) {'));
check('shipmentState still returns exactly three values, and prepared is not one',
  [/return 'delivered'/.test(stateFn), /return 'dispatched'/.test(stateFn),
   /return 'pending'/.test(stateFn), /'prepared'/.test(stateFn)],
  [true, true, true, false]);
check('packed-ness is its own derivation, beside state and not inside it',
  /function shipmentPrepared\(s\) \{[\s\S]*?return !!s\.prepared_at && !s\.dispatched_at && !s\.delivered_at;/.test(ROUTES), true);
check('and the drawer sends both to the client',
  [/prepared_at: s\.prepared_at \|\| null/.test(ROUTES), /prepared:\s+shipmentPrepared\(s\)/.test(ROUTES)], [true, true]);
check('the column is added to retail_shipments',
  /addColumn\('retail_shipments', 'prepared_at', 'DATETIME'\)/.test(DB), true);

// ── 3. THE ORDER'S STATUS IS NOT TOUCHED ───────────────────────────────────
// The refusal §180 records. The dispatch route flips the order on purpose; this
// one must not, or a customer watching parcel one in transit is told their
// order went back to 备货中.
check('the prepare route never writes retail_orders.status',
  /UPDATE retail_orders[\s\S]*?SET[\s\S]*?status/i.test(BODY), false);
check('and it says so in what it returns',
  /order_status: o\.status/.test(BODY), true);
// The one-line fix that was refused: preparing must still be unreachable from
// dispatched at order level.
check('preparing is still not reachable from dispatched at order level',
  /preparing:\s*\{ col: 'preparing_at',\s*prev: \['paid', 'awaiting_restock'\] \}/.test(ROUTES), true);

// ── 4. The guards ──────────────────────────────────────────────────────────
check('only a paid / preparing / dispatched order can have a box packed',
  /\['paid', 'preparing', 'dispatched'\]\.includes\(o\.status\)/.test(BODY), true);
// awaiting_restock is absent DELIBERATELY: §136 made that state move no stock,
// and packing a box out of a restock hold takes goods that have not landed.
check('awaiting_restock is not in that window',
  /awaiting_restock/.test(BODY), false);
check('the parcel must belong to the order',
  /FROM retail_shipments WHERE id = \? AND order_id = \?/.test(BODY), true);
check('a supplier drop-ship parcel is refused',
  /ship\.mode === 'supplier'[\s\S]{0,140}supplier_parcel_no_prepare/.test(BODY), true);
check('a parcel that has already gone is refused',
  /if \(ship\.dispatched_at \|\| ship\.delivered_at\)[\s\S]{0,120}already_dispatched/.test(BODY), true);
// Atomic, so a double-click cannot run the stock commit twice on a race.
check('the stamp is conditional on still being unpacked, and a lost race is refused',
  [/SET prepared_at = CURRENT_TIMESTAMP[\s\S]{0,120}WHERE id = \? AND prepared_at IS NULL/.test(BODY),
   /upd\.changes !== 1[\s\S]{0,120}already_prepared/.test(BODY)], [true, true]);

// ── 5. The stock call is the §58-addendum shape, not a new mechanism ────────
check('the route commits stock scoped to THIS parcel',
  /prepareCommitUnreservedOrder\(id, \{[^}]*shipmentId: sid \}\)/.test(BODY), true);
check('and it is labelled so the deferral suite can find it by name',
  /\[inventory\.prepareCommit \(parcel prepare\)\]/.test(BODY), true);
// A packed box is no longer holding another parcel's fresh line back — packing
// is exactly when the food came out of the fridge. Without this a product split
// across two parked boxes settles on neither.
check('a packed parcel is no longer "still in the building"',
  /WHERE order_id = \? AND id != \?\s*\n\s*AND prepared_at IS NULL/.test(ROUTES), true);

// ── 6. The signal, which is the other half of the defect ───────────────────
// isStockPending opened with `if (status !== 'paid') return false`, so the
// "Stock pending" note went dark on exactly the orders this section is about.
check('isStockPending answers past paid as well',
  /status !== 'preparing' && status !== 'dispatched'/.test(INV), true);
check('but only when a parcel is parked AND unpacked',
  /prepared_at IS NULL AND dispatched_at IS NULL AND delivered_at IS NULL/.test(INV), true);
// Cheapness matters: this runs once per row of the orders list.
const pendFn = INV.slice(INV.indexOf('function isStockPending('), INV.indexOf('function hasUndeductedFreshLine('));
check('the extra query is behind the status test, so a paid order pays nothing',
  pendFn.indexOf("status !== 'paid'") < pendFn.indexOf('FROM retail_shipments'), true);

// ── 7. Desktop back office ─────────────────────────────────────────────────
check('the pill reads Prepared · 已备货',
  /Prepared · 已备货/.test(DESKTOP), true);
// It replaces "Not shipped", never "Dispatched" — gated on state as well as the
// flag, so a dispatched parcel can never wear it.
check('and it only replaces Not shipped, never Dispatched',
  /st === 'pending' && s\.prepared/.test(DESKTOP), true);
check('the button is offered on a parked, unpacked, multi-parcel order',
  /showParcelPrepare = canDispatch && !s\.prepared && \(o\.shipments\?\.length \|\| 0\) > 1/.test(DESKTOP), true);
check('the button reads 标记此包裹已备货 and calls prepareShipment',
  /onclick="prepareShipment\(\$\{o\.id\}, \$\{s\.id\}, event\)">Mark this parcel prepared · 标记此包裹已备货/.test(DESKTOP), true);
check('prepareShipment posts to the prepare route',
  /shipments\/\$\{shipmentId\}\/prepare`,\s*\n\s*method: 'POST'/.test(DESKTOP), true);
// The guards that must NOT have moved.
check('canDispatch still keys on state === pending, untouched by this change',
  /const canDispatch = state === 'pending' &&/.test(DESKTOP), true);
check('and canSplit does too — a packed box can still be split',
  /const canSplit = state === 'pending' && lines >= 2;/.test(DESKTOP), true);

// ── 8. Mobile back office ──────────────────────────────────────────────────
check('the phone knows the prepared pill',
  /prepared:\{en:'Prepared',zh:'已备货',kind:'prepared'\}/.test(MOBILE), true);
// A kind with no entry in KIND2PILL falls back to 'clear', which is what
// "Not shipped" uses — the packed box would wear the pill it must not.
check('and its kind maps to warning, not the fallback clear',
  /prepared:'warning',/.test(MOBILE), true);
check('the phone maps the flag through mapDetail',
  /prepared:!!sp\.prepared, preparedAt:sp\.prepared_at\|\|null/.test(MOBILE), true);
check('the phone pill is reached through the flag, not through state',
  /sp\.state==='pending'&&sp\.prepared\)\?PARCEL_STATE\.prepared/.test(MOBILE), true);
check('the phone button is offered on the same conditions, plus not-already-packed',
  /const canPrepare = canDispatch && !sp\.prepared;/.test(MOBILE), true);
check('the phone command posts to the prepare route',
  /apiWrite\('\/orders\/'\+o\._id\+'\/shipments\/'\+sid\+'\/prepare',\{\}\)/.test(MOBILE), true);
check('and the phone re-reads the order rather than guessing the new state',
  /reg\('prepareParcel'[\s\S]{0,900}api\('\/orders\/'\+o\._id\)/.test(MOBILE), true);

// ── 9. The words are declared, and the decision is on the record ───────────
// An undeclared string is indistinguishable from a locked one to whoever comes
// next, which is how a wrong character survives.
check('已备货 is registered in the delivery vocabulary',
  /已备货/.test(VOCAB), true);
check('so is the parcel button',
  /标记此包裹已备货/.test(VOCAB), true);
check('and the three pills that had been shipping unrecorded',
  [/未发货/.test(VOCAB), /已发货/.test(VOCAB), /已送达/.test(VOCAB)], [true, true, true]);
check('§180 is on the record before the code that depends on it',
  /## §180 — A BOX THAT IS PACKED IS NOT A BOX THAT HAS LEFT/.test(DECIDE), true);

console.log('\n' + pass + '/' + (pass + fails.length) + ' passed');
if (fails.length) { console.log('\nfailed:\n  ' + fails.join('\n  ')); process.exit(1); }
