#!/usr/bin/env node
/**
 * A DELIVERY IS NOT ADDED TWICE (§504).
 *
 *   node scripts/test_delivery_double_add_warning.js
 *
 * Yuexiu's ledger showed goods raised by hand on the phone as the boxes came in,
 * then counted in again on Receive. Ash chose a warning at both doors:
 *
 *   • the stock screen's card says what is on a van to this shop;
 *   • a Receive line says what was already added by hand since the goods left,
 *     and "Everything arrived" leaves that line for a person.
 *
 * WHAT MUST HOLD:
 *   1. incomingByProduct counts only transfers IN TRANSIT TO THIS SHOP, at the
 *      sent figure (falling back to the request).
 *   2. handAddedSince is the NET of hand-written rows since the moment, only
 *      when positive, names the people who added, and ignores receipts, sales,
 *      waste and other shops.
 *   3. attachHandAdded answers only while the transfer is on its way, and reads
 *      an ISO dispatch stamp as well as SQLite's own shape.
 *   4. The phone draws both notes, in both stock-screen modes, and "Everything
 *      arrived" fills every other line but leaves a hand-added one blank, says
 *      so, and does not go to the confirm screen.
 *   5. The routes are wired, the words are the declared ones, and the decision
 *      is on record.
 *
 * The lib is driven against a real in-memory database. The phone's functions
 * are lifted out of public/m.html and run, because every m.html render suite is
 * in the slow shard, which is not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n' + t);

// ── 1-3 · the lib, against a real database ────────────────────────────────
let Database = null;
try { Database = require('better-sqlite3'); } catch (_) { /* reported below */ }
ok(!!Database, 'better-sqlite3 loads (the lib checks need a real database)');
const H = require(path.join(root, 'lib', 'delivery-hand-added'));

if (Database) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE restock_orders (id INTEGER PRIMARY KEY, goods_state TEXT, to_store_id INT, dispatched_at TEXT);
    CREATE TABLE restock_items (id INTEGER PRIMARY KEY, restock_id INT, product_id INT, qty_requested REAL, qty_sent REAL);
    CREATE TABLE retail_stock_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INT, product_id INT,
      delta INT, reason TEXT, actor_label TEXT, created_at TEXT);
    INSERT INTO restock_orders VALUES
      (1, 'in_transit', 2, '2026-10-23 08:40:00'),   -- to Yuexiu, on the van
      (2, 'in_transit', 1, '2026-10-23 08:40:00'),   -- to the other shop
      (3, 'settled',    2, '2026-10-22 08:40:00'),   -- already counted in
      (4, 'in_transit', 2, '2026-10-23T09:20:00.000Z'); -- ISO stamp
    INSERT INTO restock_items VALUES
      (10, 1, 43, 5, 5), (11, 1, 72, 6, NULL), (12, 1, 99, 4, 0),
      (20, 2, 43, 9, 9), (30, 3, 43, 7, 7), (40, 4, 43, 2, 2);
    INSERT INTO retail_stock_ledger (store_id, product_id, delta, reason, actor_label, created_at) VALUES
      (2, 43,  4, 'adjust',          'Ash',  '2026-10-23 00:58:00'),  -- before dispatch: not counted
      (2, 43,  5, 'adjust',          'Ash',  '2026-10-23 09:11:00'),
      (2, 43,  3, 'kitchen_add',     'Jing', '2026-10-23 09:30:00'),
      (2, 43, -1, 'adjust',          'Jing', '2026-10-23 09:31:00'),
      (2, 43, -2, 'order_prepare',   NULL,   '2026-10-23 09:40:00'),  -- a sale: ignored
      (2, 43,  9, 'restock_transfer_in', 'restock', '2026-10-23 10:00:00'), -- a receipt: ignored
      (1, 43,  6, 'adjust',          'Shun', '2026-10-23 09:15:00'),  -- other shop: ignored
      (2, 72,  1, 'manual',          'Ash',  '2026-10-23 09:20:00'),
      (2, 72, -3, 'adjust',          'Jing', '2026-10-23 09:25:00');  -- net down: not reported
  `);

  section('1 · what is on a van to this shop');
  const inc = H.incomingByProduct(db, 2);
  ok(inc[43] === 7, 'product 43: 5 on order 1 + 2 on order 4, not the other shop\'s 9 or the settled 7 (got ' + inc[43] + ')');
  ok(inc[72] === 6, 'a line with no sent figure counts the request (6)');
  ok(!(99 in inc), 'a line sent at 0 is absent, not 0');
  ok(Object.keys(H.incomingByProduct(db, 3)).length === 0, 'a shop with nothing coming gets an empty map');

  section('2 · what was added by hand since a moment');
  const ha = H.handAddedSince(db, 2, '2026-10-23 08:40:00', [43, 72]);
  ok(ha[43] && ha[43].qty === 7, 'net of hand rows after dispatch: +5 +3 −1 = 7 (got ' + (ha[43] && ha[43].qty) + ')');
  ok(ha[43] && ha[43].who.join(',') === 'Ash,Jing', 'names the people who added, once each, in order');
  ok(!(72 in ha), 'a net decrease (+1 −3) is not a delivery added twice, so it is absent');
  ok(Object.keys(H.handAddedSince(db, 2, '2026-10-23 08:40:00', [])).length === 0, 'no products asked, nothing read');
  ok(H.HAND_REASONS.includes('adjust') && H.HAND_REASONS.includes('kitchen_add') && !H.HAND_REASONS.includes('restock_transfer_in'),
     'the hand reasons include the phone\'s recount and add, and never a receipt');

  section('3 · decorating a transfer\'s lines');
  const o1 = db.prepare('SELECT * FROM restock_orders WHERE id = 1').get();
  const lines = H.attachHandAdded(db, o1, db.prepare('SELECT * FROM restock_items WHERE restock_id = 1').all());
  const l43 = lines.find(l => l.product_id === 43), l72 = lines.find(l => l.product_id === 72);
  ok(l43.hand_added === 7 && l43.hand_added_by.join(',') === 'Ash,Jing', 'an in-transit line carries hand_added and the names');
  ok(l72.hand_added === null && l72.hand_added_by === null, 'a line with nothing added by hand carries nulls');
  const o3 = db.prepare('SELECT * FROM restock_orders WHERE id = 3').get();
  ok(H.attachHandAdded(db, o3, [{ product_id: 43 }])[0].hand_added === null, 'a settled transfer is not asked the question');
  const o4 = db.prepare('SELECT * FROM restock_orders WHERE id = 4').get();
  const l4 = H.attachHandAdded(db, o4, [{ product_id: 43 }])[0];
  ok(l4.hand_added === 2, 'an ISO dispatch stamp is read as UTC, counting only rows from 09:20 (+3 −1 = 2; got ' + l4.hand_added + ')');
  ok(H.attachHandAdded(db, { goods_state: 'in_transit', to_store_id: 2 }, [{ product_id: 43 }])[0].hand_added === null,
     'no dispatch stamp, no answer');
}

// ── 4 · the phone ─────────────────────────────────────────────────────────
const M = fs.readFileSync(path.join(root, 'public', 'm.html'), 'utf8');
const fn = name => {
  const i = M.indexOf('function ' + name + '(');
  return i < 0 ? '' : M.slice(i, M.indexOf('\nfunction ', i + 10));
};
const names = ['xfrNum', 'xfrSent', 'xfrHandAdded', 'xfrHandTag', 'xfrGot', 'xfrHeldFor', 'xfrCount', 'xfrItems', 'xfrAllArrived', 'qsIncoming'];
const src = names.map(n => fn(n));
section('4 · the phone');
ok(src.every(Boolean), 'the phone functions are found: ' + names.filter((n, i) => !src[i]).join(', '));

const writes = [];
const sandbox = (items) => {
  const state = { xfr: { busy: false, order: { id: 7, items }, held: null, err: '', step: 'count' } };
  const T = (en) => en, E = (en) => en;
  const escAttr = s => String(s);
  const render = () => {};
  const apiWrite = (url, body) => { writes.push({ url, body }); return { then: f => { f({}); return { catch: () => {} }; } }; };
  const api = new Function('state', 'T', 'E', 'escAttr', 'render', 'apiWrite',
    src.join('\n') + '\nreturn { xfrAllArrived, xfrHandTag, xfrHandAdded, qsIncoming };');
  return { state, fns: api(state, T, E, escAttr, render, apiWrite) };
};

{
  const items = [
    { id: 1, qty_sent: 5, qty_requested: 5, qty_received: null, hand_added: 10, hand_added_by: ['Ash'] },
    { id: 2, qty_sent: 3, qty_requested: 3, qty_received: null, hand_added: null },
    { id: 3, qty_sent: 2, qty_requested: 2, qty_received: null, hand_added: 0 },
  ];
  writes.length = 0;
  const { state, fns } = sandbox(items);
  fns.xfrAllArrived();
  const sent = writes[0] && writes[0].body.counts.map(c => c.item_id).sort().join(',');
  ok(writes.length === 1 && sent === '2,3', 'Everything arrived fills the other lines (2,3) and leaves the hand-added one (got ' + sent + ')');
  ok(items[0].qty_received === null, 'the hand-added line stays uncounted');
  ok(state.xfr.step === 'count', 'it stays on the count instead of going to the confirm screen');
  ok(state.xfr.err === 'Some lines are still uncounted.', 'and says why, in the screen\'s own words');
  ok(state.xfr.held === null, 'nothing is held back for a confirm that is not coming');

  writes.length = 0;
  const plain = sandbox([
    { id: 1, qty_sent: 5, qty_received: null, hand_added: null },
    { id: 2, qty_sent: 3, qty_received: null, hand_added: null },
  ]);
  plain.fns.xfrAllArrived();
  ok(plain.state.xfr.step === 'confirm' && plain.state.xfr.held && plain.state.xfr.held.item_id === 2,
     'with nothing added by hand it behaves exactly as before: fills, holds the last line, goes to confirm');

  const tag = fns.xfrHandTag(items[0]);
  ok(/Already added by hand/.test(tag) && /\+10/.test(tag) && /Ash/.test(tag) && /amber-ink/.test(tag), 'the Receive line says it, with the amount and the name, in amber');
  ok(fns.xfrHandTag(items[1]) === '' && fns.xfrHandTag(items[2]) === '', 'and says nothing where nothing was added');
  ok(/On its way/.test(fns.qsIncoming({ incoming_qty: 5 })) && /Count it in when it arrives\./.test(fns.qsIncoming({ incoming_qty: 5 })),
     'the stock card says what is on its way and where to count it in');
  ok(fns.qsIncoming({}) === '' && fns.qsIncoming({ incoming_qty: 0 }) === '', 'and nothing when nothing is coming');
}

{
  const card = M.slice(M.indexOf("const recount = qsMode()==='recount';"), M.indexOf("const recount = qsMode()==='recount';") + 4000);
  ok(/\n\s*\$\{qsIncoming\(p\)\}/.test(card) && !/recount\?'':qsIncoming/.test(card),
     'the on-its-way line is drawn in BOTH stock-screen modes (recount is the one Yuexiu used)');
  const confirm = M.slice(M.indexOf("x.step==='confirm'"), M.indexOf("x.step==='confirm'") + 3000);
  ok(/xfrHandAdded\(it\)>0\)/.test(confirm) && /xfrHandTag\(it\)/.test(confirm), 'the confirm screen lists a hand-added line and says why');
}

// ── 5 · wiring, words, record ─────────────────────────────────────────────
section('5 · wiring, words and the record');
const R = fs.readFileSync(path.join(root, 'routes', 'restock.js'), 'utf8');
const I = fs.readFileSync(path.join(root, 'routes', 'retail-inventory.js'), 'utf8');
ok(/_handAdded\.attachHandAdded\(tdb\(\), order, _attachRecorded\(order, items\)\)/.test(R), 'GET /api/restock/:id decorates its lines');
const shelfRoute = I.slice(I.indexOf("router.get('/api/retail-admin/stores/:id/stock',"), I.indexOf("router.get('/api/retail-admin/stores/:id/stock/added-today'"));
// Two shapes go through withIncoming; the full admin shape sets it in its loop.
ok((shelfRoute.match(/withIncoming\(\{/g) || []).length === 2 &&/r\.incoming_qty = incoming/.test(shelfRoute),
   'the shelf list carries incoming_qty on all three shapes, the add-only one included');

const V = fs.readFileSync(path.join(root, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
for (const [en, cn] of [['On its way', '在途'], ['Count it in when it arrives.', '到货后再清点入库。'],
                        ['Already added by hand', '已手动加库存'], ['Some lines are still uncounted.', '仍有未点数的项目。']]) {
  ok(M.includes(`T('${en}','${cn}')`), `the phone says ${en} · ${cn}`);
  ok(V.includes(cn), `and ${cn} is declared in the vocabulary`);
}
ok(/已手动加库存[^\n]*COMPOSED by Claude/.test(V), 'the one composed string is marked composed, with who composed it');
const D = fs.readFileSync(path.join(root, 'docs', 'tacet-consolidation-decisions.md'), 'utf8');
ok(/## §504 — A DELIVERY IS NOT ADDED TWICE/.test(D) && /DECIDED BY ASH/.test(D.slice(D.indexOf('## §504'))), 'the decision is on record as §504, decided by Ash');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
