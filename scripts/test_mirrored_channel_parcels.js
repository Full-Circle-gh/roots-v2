#!/usr/bin/env node
/**
 * A MIRRORED ORDER HAS NO PARCELS (§52).
 *
 *   node scripts/test_mirrored_channel_parcels.js
 *   MCP_SABOTAGE=guard node scripts/test_mirrored_channel_parcels.js   (expect RED)
 *
 * Meituan, Eleme and gzgrocery orders are mirrored in from someone else's
 * system. That platform accepts, prepares, ships and holds the waybill; we keep
 * the row to deduct stock and show progress. Nothing here ever puts one on a
 * courier — so it must never grow a shipment row.
 *
 * IT DID, ON EVERY DRAWER OPEN, and the failure is worth stating because none
 * of the four steps is wrong on its own:
 *
 *   1. The gzgrocery daemon mirrors the order in as fulfillment_type='delivery'
 *      with no address. That is honest — the goods did go somewhere — and there
 *      is no fourth fulfilment type meaning "not ours to fulfil".
 *   2. The order-detail read calls `shipsNothing(o) ? [] : ensureShipments(id)`.
 *      shipsNothing answers pickup and counter; it has never read a channel.
 *   3. planShipments finds no city, so it is neither Guangzhou nor Guangdong,
 *      and falls through to the air/land split — where an addressless mirrored
 *      line takes the Any bucket and lands on LAND.
 *   4. The order is `delivered`, so the legacy back-fill stamps that phantom
 *      parcel dispatched and delivered, which is what promotes it onto the
 *      phone as "Land — No waybill on this parcel yet — add it on the desktop."
 *
 * On a screen whose desktop half offers no waybill field for these orders at
 * all.
 *
 * THE REAL ensureShipments AND THE REAL planShipments ARE UNDER TEST, extracted
 * from routes/retail.js and run against an in-memory database built from the
 * real schema. planShipments is NOT stubbed here — the point of case 2 is that
 * the pre-fix planner really does answer "land" for an addressless order, which
 * a stub returning 'air' would have hidden.
 *
 * MUTATIONS MUST PROVE THEY MUTATED (the v4.27 rule): the sabotage below
 * asserts it changed the source before its red counts as evidence. No anchor
 * contains a newline — the tree is checked out CRLF.
 *
 * Offline. No network, no install, no production database.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { isMirroredChannel, MIRRORED_CHANNELS } = require('../lib/fulfilment');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SABOTAGE = process.env.MCP_SABOTAGE || '';

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling — the string-aware stripper the sibling suites use ──────
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const RETAIL = stripComments(RETAIL_SRC);

function extractFunction(code, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(code);
  if (!m) throw new Error(`function ${name} not found`);
  const end = code.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return code.slice(m.index, end + 2);
}

const MUTATIONS = {
  // Revert the guard. Every "no parcels" assertion below must go red, and the
  // storefront control must stay green — a mutation that reddens the control
  // too would be proving the harness broke, not that the guard works.
  guard: {
    why: 'reverts the isMirroredChannel guard inside ensureShipments',
    find: /if \(isMirroredChannel\(o\)\) return \[\];/,
    replace: 'if (false) return [];',
  },
};

function ensureSource() {
  let src = extractFunction(RETAIL, 'ensureShipments');
  if (!SABOTAGE) return src;
  const m = MUTATIONS[SABOTAGE];
  if (!m) throw new Error(`unknown MCP_SABOTAGE=${SABOTAGE}`);
  const before = src;
  src = src.replace(m.find, m.replace);
  assert.notStrictEqual(src, before,
    `SABOTAGE '${SABOTAGE}' (${m.find}) matched NOTHING — it changed no source, `
    + 'so every failure below would be meaningless');
  return src;
}

// ── Harness ────────────────────────────────────────────────────────────────
const TABLES = ['retail_orders', 'retail_order_items', 'retail_shipments', 'storefront_config'];

function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  let depth = 0;
  db.transaction = (fn) => (...args) => {
    const mine = depth, sp = `mcp_sp_${mine}`;
    if (mine === 0) db.exec('BEGIN'); else db.exec(`SAVEPOINT ${sp}`);
    depth = mine + 1;
    try {
      const r = fn(...args);
      depth = mine;
      if (mine === 0) db.exec('COMMIT'); else db.exec(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      depth = mine;
      try {
        if (mine === 0) db.exec('ROLLBACK');
        else { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); db.exec(`RELEASE SAVEPOINT ${sp}`); }
      } catch { /* already unwound */ }
      throw e;
    }
  };
  return db;
}

/**
 * The REAL planShipments, with its three helpers.
 *
 * isGuangzhou / isGuangdong / bucketForItem are lifted from the same file, and
 * provinceForCity — which isGuangdong consults for a city with no province — is
 * the one stub: it reads a served-cities catalogue this suite has no rows for,
 * and answering null is exactly what it does for an address that carries
 * nothing, which is the address every mirrored order has.
 */
function realPlanner() {
  const parts = ['isGuangzhou', 'isGuangdong', 'parseShipModes', 'bucketForItem', 'planShipments']
    .map((n) => extractFunction(RETAIL, n)).join('\n');
  return new Function('provinceForCity', 'inventory',
    `${parts}\nreturn planShipments;`)(
    () => null,
    { isOptInSameDayDistrict: () => false });
}

function build() {
  const db = ensureTransactionMethod(openTablesDb(DB_SRC, TABLES));
  const tdb = () => db;
  const planShipments = realPlanner();
  const ensureShipments = new Function('tdb', 'planShipments', 'supplierShipmentLabel',
    'isMirroredChannel', `${ensureSource()}\nreturn ensureShipments;`)(
    tdb, planShipments, () => 'Supplier-direct · 供应商直发', isMirroredChannel);
  return { db, ensureShipments, planShipments };
}

/**
 * An order shaped the way a mirror writes one: fulfillment_type 'delivery',
 * status 'delivered', no address, and items with NO ship_modes — the gzgrocery
 * daemon's INSERT names neither column, which is why the planner sees the
 * COALESCE default and buckets everything to land.
 */
function seedMirroredOrder(db, channel, opts = {}) {
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, status, channel, fulfillment_type, total, address_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(1, 'GZ-140695', 'delivered', channel, 'delivery', 62.4, opts.address || null);
  const ins = db.prepare(
    'INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total) VALUES (?,?,?,?,?,?)'
  );
  ins.run(1, 101, 'Sourdough loaf', 2, 18, 36);
  ins.run(1, 102, 'Oat milk 1L', 2, 13.2, 26.4);
}

const countShipments = (db) => db.prepare('SELECT COUNT(*) c FROM retail_shipments').get().c;
const assignedItems = (db) => db.prepare(
  'SELECT COUNT(*) c FROM retail_order_items WHERE shipment_id IS NOT NULL').get().c;

function main() {
  console.log(`\nA mirrored order has no parcels — §52  (driver: ${driver})\n`);

  // ── 1. The ruling itself, one case per channel ────────────────────────────
  for (const channel of MIRRORED_CHANNELS) {
    it(`a ${channel} order gets NO parcels, and no item is assigned to one`, () => {
      const { db, ensureShipments } = build();
      seedMirroredOrder(db, channel);
      const rows = ensureShipments(1);
      assert.deepStrictEqual(rows, [], `ensureShipments handed back parcels for a ${channel} order`);
      assert.strictEqual(countShipments(db), 0, `a parcel row was written for a ${channel} order`);
      assert.strictEqual(assignedItems(db), 0,
        `items were assigned to a parcel on a ${channel} order`);
    });
  }

  // ── 2. What the guard is standing in front of ────────────────────────────
  //
  // Runs the REAL planner over the REAL mirrored-order shape, so the "it would
  // have been a Land parcel" claim is measured rather than asserted from
  // memory. If this ever answers 'air' or splits, the phone's card was saying
  // something different from what this suite documents and §52 needs re-reading.
  it('the planner really does answer ONE LAND parcel for an addressless order', () => {
    const { planShipments } = build();
    const plan = planShipments(
      [{ id: 1, ship_modes: 'air,land' }, { id: 2, ship_modes: 'air,land' }], '', '', {});
    assert.strictEqual(plan.length, 1, 'the addressless order did not plan exactly one parcel');
    assert.strictEqual(plan[0].mode, 'land', 'the phantom parcel was not the Land one');
  });

  // ── 3. The control — the guard must not have eaten the normal path ───────
  it('a storefront order still gets its parcel', () => {
    const { db, ensureShipments } = build();
    seedMirroredOrder(db, 'wechat');
    const rows = ensureShipments(1);
    assert.strictEqual(rows.length, 1, 'a wechat order stopped getting parcels');
    assert.strictEqual(countShipments(db), 1);
    assert.strictEqual(assignedItems(db), 2, 'the storefront order\'s items were not assigned');
  });

  it('a NULL channel is a storefront order, not a mirrored one', () => {
    const { db, ensureShipments } = build();
    db.prepare(
      `INSERT INTO retail_orders (id, order_no, status, fulfillment_type, total)
       VALUES (1,'RT-1','paid','delivery',20)`).run();
    db.prepare(
      'INSERT INTO retail_order_items (order_id, product_id, name_en, qty, unit_price, line_total) VALUES (1,101,\'x\',1,20,20)'
    ).run();
    assert.strictEqual(ensureShipments(1).length, 1, 'a channel-less order lost its parcel');
  });

  // A channel arrives from a daemon, not from a form. 'GZGROCERY' and
  // 'Meituan' are the same channel as 'gzgrocery' and 'meituan', and a guard
  // that reads one and not the other is a guard that works until someone
  // changes a daemon's string literal.
  it('the channel is matched case-insensitively', () => {
    const { db, ensureShipments } = build();
    seedMirroredOrder(db, 'GZGrocery');
    assert.deepStrictEqual(ensureShipments(1), [], 'a differently-cased channel slipped past');
    assert.strictEqual(countShipments(db), 0);
  });

  // ── 4. Idempotence: the guard returns [], it does not delete ─────────────
  //
  // Every mirrored order opened before this guard shipped still carries the row
  // it created. Those are left in place deliberately (§52) — nothing reads them
  // once both halves are in, and a delete migration over live order data is a
  // bigger decision than this one. What must NOT happen is the guard silently
  // becoming a sweeper, so this pins the behaviour rather than assuming it.
  it('a phantom parcel already on the row is returned, not deleted', () => {
    const { db, ensureShipments } = build();
    seedMirroredOrder(db, 'gzgrocery');
    db.prepare(
      `INSERT INTO retail_shipments (order_id, mode, label) VALUES (1,'land','Land shipment · 陆运')`
    ).run();
    const rows = ensureShipments(1);
    assert.strictEqual(rows.length, 1, 'the pre-existing row was not handed back');
    assert.strictEqual(countShipments(db), 1, 'the guard deleted a row it should have left alone');
  });

  // ── 5. The guard is where it cannot be forgotten ─────────────────────────
  //
  // Asserted on source, because "inside ensureShipments rather than at each
  // caller" IS the decision (§52) and the next reader is free to move it out to
  // a call site in the name of consistency with the fulfilment-type guards.
  it('the guard sits INSIDE ensureShipments, not at a call site', () => {
    const src = extractFunction(RETAIL, 'ensureShipments');
    assert.ok(/isMirroredChannel\(o\)/.test(src),
      'ensureShipments no longer guards on the channel — the eleven callers now each have to');
    assert.ok(/SELECT id, channel,/.test(src),
      'ensureShipments stopped selecting channel — the guard cannot read what it is not given');
  });

  // shipsNothing gates maybeEnqueueQingyunPush, and a Meituan order IS
  // delivered by a Qingyun rider. Folding mirrored channels into it would read
  // as tidying and would stop the rider push on the channel that needs it most.
  it('shipsNothing is NOT the mirrored-channel predicate', () => {
    const { shipsNothing } = require('../lib/fulfilment');
    for (const channel of MIRRORED_CHANNELS) {
      assert.strictEqual(shipsNothing({ channel, fulfillment_type: 'delivery' }), false,
        `shipsNothing now answers true for ${channel} — the Qingyun rider push is gated on it`);
    }
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
