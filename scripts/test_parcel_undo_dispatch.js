#!/usr/bin/env node
/**
 * §268 — POST /api/retail-admin/orders/:id/shipments/:sid/undo-dispatch, and
 * the two screens that reach it.
 *
 *   node scripts/test_parcel_undo_dispatch.js
 *
 * WHAT THIS IS FIXING. TC000851 had two parcels: one with a real waybill, and a
 * Land box that read Dispatched and had not left. The order-level undo-dispatch
 * is refused once ANY parcel carries a waybill, so neither screen had a way
 * back. Ash chose (2026-09-25) that one box goes back to PACKED, not to "not
 * shipped".
 *
 * THE LOAD-BEARING CLAIM: STOCK DOES NOT MOVE. Every stock reader treats
 * prepared_at exactly as dispatched_at, so swapping one stamp for the other must
 * leave them all answering the same. Section 2 runs the real readers, extracted
 * from routes/retail.js, before and after, and requires identical answers.
 *
 * Runs the real `undoParcelDispatch` extracted from the live source against a
 * throwaway database — never a mirror, because a mirror passes while the product
 * breaks. The screens have no runnable shape here, so they are read by name.
 *
 * TO PROVE THE SUITE CAN FAIL:  PARCEL_UNDO_SABOTAGE=1 node scripts/test_parcel_undo_dispatch.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let ROUTES  = read('routes/retail.js');
let DESKTOP = read('public/retail-admin/04-orders.js');
let MOBILE  = read('public/m.html');
const VOCAB  = read('docs/tacet-delivery-vocabulary.md');
const DECIDE = read('docs/tacet-consolidation-decisions.md');

// Each mutation is one this change was genuinely at risk of: the box sent to
// "not shipped" (stock readers change), the sibling guard dropped, the waybill
// guard dropped, a screen offering it on a single-parcel order.
if (process.env.PARCEL_UNDO_SABOTAGE === '1') {
  ROUTES  = ROUTES.replace('SET prepared_at = COALESCE(prepared_at, dispatched_at), dispatched_at = NULL,',
                           'SET dispatched_at = NULL,');
  ROUTES  = ROUTES.replace("if (!othersOut) return { code: 409, body: { success: false, error: 'last_parcel_out' } };", '');
  ROUTES  = ROUTES.replace("if (String(ship.tracking_number || '').trim()) {", 'if (false) {');
  MOBILE  = MOBILE.replace("(sp.mode==='air'||sp.mode==='land') && n>1", "(sp.mode==='air'||sp.mode==='land')");
}

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + '\n      expected ' + e + '\n      actual   ' + a); }
}

// A top-level `function NAME(` through the first `}` in column one — the rule
// the sibling suites use, so a reformat fails here by name.
function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

// ── 0. Extraction and registration ────────────────────────────────────────
const FNS = ['undoParcelDispatch', 'orderShippedQty', 'parcelsStillInTheBuilding', 'shipmentState', 'shipmentPrepared'];
const src = {};
for (const n of FNS) src[n] = extractFn(n, ROUTES);
check('every function under test was found in routes/retail.js', FNS.filter((n) => !src[n]), []);

// EXACTLY ONCE: §24's two registrations of /shipments/split, the first one
// winning in silence, is why.
const PATH = "router.post('/api/retail-admin/orders/:id/shipments/:sid/undo-dispatch'";
check('the route is registered exactly once', ROUTES.split(PATH).length - 1, 1);
const at = ROUTES.indexOf(PATH);
const BODY = at === -1 ? '' : ROUTES.slice(at, ROUTES.indexOf('\n});', at));
check('the route runs the rule under test, not a copy of it', /undoParcelDispatch\(id, sid\)/.test(BODY), true);
check('the route never writes retail_orders', /UPDATE retail_orders/.test(BODY), false);
check('…and neither does the rule', /UPDATE retail_orders/.test(src.undoParcelDispatch || ''), false);
check('the route is admin-only', /requireRetailAdmin/.test(BODY), true);

// ── Throwaway database ────────────────────────────────────────────────────
const dbPath = path.join(os.tmpdir(), `parcel-undo-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, status TEXT);
  CREATE TABLE retail_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
    qty INTEGER, shipment_id INTEGER);
  CREATE TABLE retail_shipments (id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    tracking_number TEXT, prepared_at DATETIME, dispatched_at DATETIME, delivered_at DATETIME,
    updated_at DATETIME);
`);
const tdb = () => db;
const lib = new Function('tdb', `${FNS.map((n) => src[n] || '').join('\n')}
  return { ${FNS.join(', ')} };`)(tdb);

let nextId = 850;
function mkOrder(status, parcels) {
  const id = ++nextId;
  db.prepare('INSERT INTO retail_orders (id, status) VALUES (?,?)').run(id, status);
  const sids = parcels.map((p, i) => {
    const r = db.prepare(
      `INSERT INTO retail_shipments (order_id, mode, tracking_number, prepared_at, dispatched_at, delivered_at)
       VALUES (?,?,?,?,?,?)`
    ).run(id, p.mode, p.waybill || null, p.prepared || null, p.out ? '2026-09-25 10:00:00' : null,
          p.landed ? '2026-09-25 12:00:00' : null);
    const sid = r.lastInsertRowid;
    db.prepare('INSERT INTO retail_order_items (order_id, product_id, qty, shipment_id) VALUES (?,?,?,?)')
      .run(id, 100 + i, 2, sid);
    return Number(sid);
  });
  return { id, sids };
}
const ship = (sid) => db.prepare('SELECT * FROM retail_shipments WHERE id = ?').get(sid);
const statusOf = (id) => db.prepare('SELECT status FROM retail_orders WHERE id = ?').get(id).status;
const stockView = (id, sids) => JSON.stringify({
  shipped: [...lib.orderShippedQty(id)].sort(),
  here: sids.map((s) => [...lib.parcelsStillInTheBuilding(id, 0)].includes(s)),
});

// ── 1. The reported case: TC000851 ────────────────────────────────────────
const tc = mkOrder('dispatched', [
  { mode: 'air',  out: true, waybill: 'JDVC00851' },
  { mode: 'land', out: true },
]);
const [airSid, landSid] = tc.sids;
const before = stockView(tc.id, tc.sids);
const r1 = lib.undoParcelDispatch(tc.id, landSid);
check('the Land box with no waybill goes back', r1.code, 200);
check('…to Packed: prepared, not dispatched',
  [lib.shipmentState(ship(landSid)), lib.shipmentPrepared(ship(landSid))], ['pending', true]);
check('…keeping when it was packed as when it was marked out',
  ship(landSid).prepared_at, '2026-09-25 10:00:00');
check('the order stays Dispatched — the Air box really left', statusOf(tc.id), 'dispatched');
check('the Air box is untouched', lib.shipmentState(ship(airSid)), 'dispatched');

// ── 2. STOCK DOES NOT MOVE ────────────────────────────────────────────────
check('every stock reader answers exactly as before', stockView(tc.id, tc.sids), before);

// ── 3. The refusals ───────────────────────────────────────────────────────
check('a second tap is refused (already back)', lib.undoParcelDispatch(tc.id, landSid).body.error, 'not_dispatched');
check('a box with a waybill is refused', lib.undoParcelDispatch(tc.id, airSid).body.error, 'already_shipped');

const alone = mkOrder('dispatched', [{ mode: 'land', out: true }, { mode: 'air' }]);
check('the last box out on a dispatched order is refused — the order-level undo owns it',
  lib.undoParcelDispatch(alone.id, alone.sids[0]).body.error, 'last_parcel_out');
check('…and nothing was written', lib.shipmentState(ship(alone.sids[0])), 'dispatched');

const parked = mkOrder('awaiting_restock', [{ mode: 'land', out: true }, { mode: 'air' }]);
check('a parked order needs no sibling out (§187: its status is not from parcels)',
  lib.undoParcelDispatch(parked.id, parked.sids[0]).code, 200);
check('…and stays parked', statusOf(parked.id), 'awaiting_restock');

const landed = mkOrder('dispatched', [{ mode: 'land', out: true, landed: true }, { mode: 'air', out: true }]);
check('a delivered box is refused', lib.undoParcelDispatch(landed.id, landed.sids[0]).body.error, 'already_delivered');

const local = mkOrder('dispatched', [{ mode: 'local', out: true }, { mode: 'land', out: true }]);
check('a same-city box is refused — its rider is booked per order',
  lib.undoParcelDispatch(local.id, local.sids[0]).body.error, 'mode_not_reversible');
const supp = mkOrder('dispatched', [{ mode: 'supplier', out: true }, { mode: 'land', out: true }]);
check('a supplier box is refused', lib.undoParcelDispatch(supp.id, supp.sids[0]).body.error, 'mode_not_reversible');

const done = mkOrder('delivered', [{ mode: 'land', out: true, landed: true }, { mode: 'air', out: true, landed: true }]);
check('a delivered order is refused', lib.undoParcelDispatch(done.id, done.sids[0]).body.error, 'not_reversible');
check('a parcel from another order is refused',
  lib.undoParcelDispatch(tc.id, alone.sids[0]).body.error, 'shipment_not_found');
check('an unknown order is refused', lib.undoParcelDispatch(999999, 1).body.error, 'not_found');

// A box packed earlier keeps its own packed time.
const packed = mkOrder('dispatched', [{ mode: 'land', out: true, prepared: '2026-09-24 09:00:00' }, { mode: 'air', out: true }]);
lib.undoParcelDispatch(packed.id, packed.sids[0]);
check('a box packed before it was marked out keeps its packed time', ship(packed.sids[0]).prepared_at, '2026-09-24 09:00:00');

// ── 4. Both screens ask the route's questions ─────────────────────────────
const mCard = MOBILE.slice(MOBILE.indexOf('function parcelCard('), MOBILE.indexOf('function countLabel('));
check('phone: offered only on an Air or Land box that is out, on a split order',
  /sp\.state==='dispatched' && \(sp\.mode==='air'\|\|sp\.mode==='land'\) && n>1/.test(mCard), true);
check('phone: not on a box with a waybill', /!\(sp\.trk&&sp\.trk\.number\)/.test(mCard), true);
check('phone: a dispatched order needs another box out; a parked one does not',
  /o\.rawStatus==='awaiting_restock'[\s\S]{0,80}o\.rawStatus==='dispatched' && \(ships\|\|\[\]\)\.some\(x=>x&&x\.id!==sp\.id&&x\.state!=='pending'\)/.test(mCard), true);
check('phone: the card is given the whole parcel list',
  /parcelCard\(o,sp,i,ships\.length,ships\)/.test(MOBILE), true);
check('phone: the button reaches the command, and the command the route',
  [/APP\.cmd\('undoParcelDispatch',\$\{sp\.id\}\)/.test(mCard),
   /reg\('undoParcelDispatch'[\s\S]{0,900}'\/shipments\/'\+sid\+'\/undo-dispatch'/.test(MOBILE)], [true, true]);
check('phone: it asks first', /reg\('undoParcelDispatch'[\s\S]{0,300}state\.ask=/.test(MOBILE), true);

const dCard = DESKTOP.slice(DESKTOP.indexOf('function renderShipmentCard('), DESKTOP.indexOf('function renderShipmentCard(') + 6000);
check('desktop: offered only on an Air or Land box that is out, on a split order',
  /state === 'dispatched' && \(mode === 'air' \|\| mode === 'land'\) &&\s*\(o\.shipments\?\.length \|\| 0\) > 1/.test(dCard), true);
check('desktop: not on a box with a waybill', /s\.tracking_number && String\(s\.tracking_number\)\.trim\(\)\) \|\| \(s\.tracking && s\.tracking\.number\)/.test(dCard), true);
check('desktop: a dispatched order needs another box out',
  /o\.status === 'dispatched' && o\.shipments\.some\(x => x\.id !== s\.id && \(x\.state \|\| 'pending'\) !== 'pending'\)/.test(dCard), true);
check('desktop: the button reaches the route, after asking',
  /async function undoShipmentDispatch\([\s\S]{0,300}askConfirm[\s\S]{0,900}\/shipments\/\$\{shipmentId\}\/undo-dispatch/.test(DESKTOP), true);

// ── 5. Recorded before it shipped ─────────────────────────────────────────
check('the decision is recorded as §268', /## §268 — /.test(DECIDE), true);
check('the composed Chinese is declared', /\(§268\)/.test(VOCAB) && /订单状态不变/.test(VOCAB), true);

db.close();
try { fs.unlinkSync(dbPath); } catch {}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
