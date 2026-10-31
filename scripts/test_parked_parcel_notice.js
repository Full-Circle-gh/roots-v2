#!/usr/bin/env node
/**
 * §188 — the customer of a parked order is told when one of its boxes leaves.
 *
 *   node scripts/test_parked_parcel_notice.js
 *
 * WHAT THIS IS FIXING. §187 let a parked order send the parcels its shortage
 * does not touch, and said nothing to the customer — deliberately, because the
 * order keeps its 'awaiting_restock' status, so `firstDispatch` is never set and
 * the order-level line never fires. That was right about the ORDER (订单已发货
 * is untrue while the kitchen lines have not been made) and it left the customer
 * with NOTHING AT ALL. A box arriving unannounced, days before the rest, reads
 * as a short delivery.
 *
 * THE TWO CLAIMS THIS FILE EXISTS FOR, because both are silent when broken:
 *
 *   1. NO WECHAT PUSH. A subscribe message costs one one-shot consent per send,
 *      and the send worth spending it on is the one saying the whole order is on
 *      its way. So the notification row is written and sendSubscribeMessage is
 *      never reached — which is why this does not go through
 *      notifyOrderStatusChange (whose entire back half is that push) and why
 *      ORDER_STATUS_NOTIF is untouched. A key added there would fire the push
 *      for a status the order does not hold, and nothing on screen would say so.
 *   2. RULE 5 — notifications branch on fulfilment type. A pickup customer is
 *      never told a parcel shipped; a counter sale's customer walked out with
 *      the goods. `shipsNothing` is the predicate, not `=== 'pickup'`.
 *
 * The notifier is extracted from the live source and RUN against a throwaway
 * database, so the row it writes and the row it declines to write are both
 * observed. The wiring and the two claims above have no runnable shape and are
 * read off the real files by name.
 *
 * TO PROVE THE SUITE CAN FAIL:  PARKED_NOTICE_SABOTAGE=1 node scripts/test_parked_parcel_notice.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// routes/retail.js and what moved out of it: notifyCustomer now sits in
// lib/customer-notify.js (decisions §477).
let ROUTES = require('./test-support/retail-source').retailSource();
const VOCAB  = read('docs/tacet-delivery-vocabulary.md');
const DECIDE = read('docs/tacet-consolidation-decisions.md');
const MINIAPP = read('miniapp/pages/notifications/notifications.js');

const SABOTAGE = process.env.PARKED_NOTICE_SABOTAGE === '1';
if (SABOTAGE) {
  // The four mutations this change was genuinely at risk of: the send dropped,
  // the fulfilment gate dropped, the push reinstated, the wiring detached.
  ROUTES = ROUTES.replace('if (!o || shipsNothing(o)) return;', 'if (!o) return;');
  ROUTES = ROUTES.replace(
    "  if (o.status === 'awaiting_restock') {\n    try { notifyParcelShippedWhileParked(id); }",
    "  if (false) {\n    try { notifyParcelShippedWhileParked(id); }");
  ROUTES = ROUTES.replace(
    "const whichCn = w ? `${w.cn}包裹已发货` : '其中一个包裹已发货';",
    "const whichCn = '其中一个包裹已发货';");                 // §190 — the mode word dropped
  ROUTES = ROUTES.replace(
    "  refunded:   { en: 'Your order was refunded',      cn: '订单已退款' },",
    "  refunded:   { en: 'Your order was refunded',      cn: '订单已退款' },\n  order_parcel_shipped: { en: 'Part of your order has shipped', cn: '订单部分已发货' },");
}

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}
function section(t) { results.push({ heading: t }); }

// ── Extraction ──────────────────────────────────────────────────────────────
function extractFn(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}
/* §190's mode table is a const, not a function, so the extractor above cannot
   see it — and a copy written here would pass while the product broke, which is
   the one thing this file's extraction style exists to prevent. Pulled from the
   real source by name, through the closing `};` in column one. */
function extractConst(name, src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = {`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\};/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}
const MODE_TABLE = extractConst('PARCEL_MODE_WORD', ROUTES);

const FNS = ['notifyParcelShippedWhileParked', 'notifyForOrder', 'notifyCustomer'];
const src = {};
for (const n of FNS) src[n] = extractFn(n, ROUTES);

section('── 0. Extraction');
check('every function under test was found in its source', FNS.filter((n) => !src[n]), []);
check('…and §190\'s mode table came from the real source, not a copy', !!MODE_TABLE, true);

// ── A throwaway database with only the columns these assertions read ────────
const dbPath = path.join(os.tmpdir(), `parked-notice-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT,
    fulfillment_type TEXT, channel TEXT, customer_id INTEGER
  );
  CREATE TABLE retail_notifications (
    id INTEGER PRIMARY KEY, customer_id INTEGER, category TEXT, type TEXT,
    title_en TEXT, title_cn TEXT, body_en TEXT, body_cn TEXT,
    ref_type TEXT, ref_id TEXT, read_at DATETIME, expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// The category mute is a real gate in notifyCustomer and is handed in rather
// than re-spelled — a private copy here would pass while the product broke.
let categoryEnabled = true;
const pushes = [];
const notif = new Function('db', 'state', 'pushes', `
  const tdb = () => db;
  const notifCategoryEnabled = () => state.categoryEnabled;
  const shipsNothing = (o) => {
    const t = String((o && o.fulfillment_type) || '').toLowerCase();
    return t === 'pickup' || t === 'counter';
  };
  // If the notifier ever reaches for the push, this records it and the
  // assertion below fails by name instead of a consent being spent in silence.
  const sendSubscribeMessage = (...a) => { pushes.push(a); return Promise.resolve(); };
  ${MODE_TABLE || ''}
  ${FNS.map((n) => src[n]).join('\n')}
  return { ${FNS.join(', ')} };
`)(db, { get categoryEnabled() { return categoryEnabled; } }, pushes);

let nextOrder = 400;
function mkOrder({ ft = 'delivery', customer = 77, status = 'awaiting_restock' } = {}) {
  const id = ++nextOrder;
  db.prepare(
    'INSERT INTO retail_orders (id, order_no, status, fulfillment_type, channel, customer_id) VALUES (?,?,?,?,?,?)'
  ).run(id, 'TC00' + id, status, ft, 'wechat', customer);
  return id;
}
const rowsFor = (id) => db.prepare(
  'SELECT * FROM retail_notifications WHERE ref_id = ? ORDER BY id').all(String(id));

// ─────────────────────────────────────────────────────────────────────────────
section('── 1. A delivery customer is told, once, in both languages');

const courier = mkOrder();
notif.notifyParcelShippedWhileParked(courier, 'land');
const got = rowsFor(courier);
check('one notification row is written', got.length, 1);
check('…filed against the order, so the app can open it',
  [got[0].ref_type, got[0].ref_id, got[0].customer_id], ['order', String(courier), 77]);
check('…under its own type, not a status one',
  [got[0].category, got[0].type], ['order', 'order_parcel_shipped']);
check('…with the declared pair as its title',
  [got[0].title_en, got[0].title_cn],
  ['Part of your order has shipped', '订单部分已发货']);
check('…and a body that names the order and says what is still coming',
  [got[0].body_en, got[0].body_cn],
  ['Order TC00401 — the land parcel has shipped. The rest follows once the remaining items are back in stock.',
   '订单 TC00401 — 陆运包裹已发货，其余商品待补货后发货。']);

/* NO PUSH. This is the claim that is silent when broken: a consent spent here
   is a consent missing from the message that says the whole order is on its
   way, and nothing on any screen would show it had gone. */
check('no WeChat subscribe message is sent', pushes.length, 0);

// ─────────────────────────────────────────────────────────────────────────────
section('── 2. Rule 5 — who is NOT told');

for (const ft of ['pickup', 'counter']) {
  const o = mkOrder({ ft });
  notif.notifyParcelShippedWhileParked(o, 'land');
  check(`a ${ft} order sends nothing — no parcel of ours leaves`, rowsFor(o).length, 0);
}
// A guest order has nobody to tell. notifyForOrder already refuses it; asserted
// so a later rewrite of this notifier does not lose the guard.
const guest = mkOrder({ customer: null });
notif.notifyParcelShippedWhileParked(guest, 'land');
check('an order with no customer sends nothing', rowsFor(guest).length, 0);
// The operator's category mute is a real switch and must reach this line too.
categoryEnabled = false;
const muted = mkOrder();
notif.notifyParcelShippedWhileParked(muted, 'land');
check('a muted order category sends nothing', rowsFor(muted).length, 0);
categoryEnabled = true;

// ─────────────────────────────────────────────────────────────────────────────
section('── 2b. §190 — which box, named');

/* A split order is two boxes on different days, so "one of the parcels" made the
   customer count boxes to work out which had landed. Every mode already has a
   locked pair; nothing here is a new word. */
for (const [mode, en, cn] of [
  ['air',   'the air parcel has shipped',       '空运包裹已发货'],
  ['land',  'the land parcel has shipped',      '陆运包裹已发货'],
  ['local', 'the same-city parcel has shipped', '同城包裹已发货'],
]) {
  const o = mkOrder();
  notif.notifyParcelShippedWhileParked(o, mode);
  const r = rowsFor(o)[0] || {};
  check(`a ${mode} parcel names itself in both languages`,
    [(r.body_en || '').includes(en), (r.body_cn || '').includes(cn)], [true, true]);
}
/* THE FALLBACK IS NOT DEAD CODE. A supplier parcel cannot reach this sentence —
   the dispatch route refuses those — so the branch is for a mode added LATER,
   whose customer word will not exist on the day it is added. A new mode should
   read slightly vague, never wrong, and the fallback is what stops the next
   person inventing a pair in a hurry. */
for (const mode of ['supplier', '', null, 'something_new']) {
  const o = mkOrder();
  notif.notifyParcelShippedWhileParked(o, mode);
  const r = rowsFor(o)[0] || {};
  check(`an unknown mode (${JSON.stringify(mode)}) keeps the generic sentence`,
    [(r.body_en || '').includes('one of the parcels has shipped'),
     (r.body_cn || '').includes('其中一个包裹已发货')], [true, true]);
}
// The title does NOT vary — one notification with three shapes in the list
// would read as three different things.
check('the title is the same whatever the mode',
  /title_en: 'Part of your order has shipped',[\s\S]{0,80}title_cn: '订单部分已发货',/.test(ROUTES), true);
// The route hands the mode in; without this the whole section is unreachable.
check('the dispatch route passes the parcel it just sent',
  /notifyParcelShippedWhileParked\(id, ship\.mode\)/.test(ROUTES), true);

// ─────────────────────────────────────────────────────────────────────────────
section('── 3. The wiring, and the map that must stay untouched');

const disp = ROUTES.indexOf("router.post('/api/retail-admin/orders/:id/shipments/:sid/dispatch'");
const dispBody = ROUTES.slice(disp, disp + 7000);
check('the dispatch route calls it for a parked order',
  /if \(o\.status === 'awaiting_restock'\) \{\s*\n\s*try \{ notifyParcelShippedWhileParked\(id, ship\.mode\); \}/.test(dispBody), true);
// Best-effort, like its sibling: a failed notification must never undo a
// dispatch that has already happened.
/* SWALLOWED ON PURPOSE, AND SAYING SO IS A GATE, NOT A COURTESY:
   scripts/check-swallowed-errors.js holds a ceiling on catch blocks that do
   nothing without explaining themselves, and this change would otherwise have
   raised it by one. Four words is the gate's threshold; the reason here is a
   sentence because the case is a real one — the parcel is already stamped as
   gone and its stock already committed when this runs. */
check('…swallowed on purpose, so a failed notice cannot undo a dispatch that happened',
  /catch \(e\) \{\s*\n\s*\/\/ Swallowed on purpose: the parcel is already stamped as gone/.test(dispBody), true);
check('…and the order-level push still rides on firstDispatch, which §187 never sets here',
  /if \(firstDispatch\) \{\s*\n\s*try \{ notifyOrderStatusChange\(id, 'dispatched'\)/.test(dispBody), true);

/* §193 — THE SECOND DOOR. Minting a JD waybill stamps the parcel's
   dispatched_at itself, so a box can leave without ever going through the
   dispatch route above: the drawer offers "Create JD label" and "Mark this
   parcel dispatched" side by side and the operator may take either first.
   §193 opened that route to parked orders, which handed §188's silence a way
   back in — the box goes, the customer hears nothing, because firstDispatch is
   false for a parked order there too.

   ONCE PER PARCEL IS NOW A GUARD RATHER THAN A FREEBIE. This notice used to be
   once per parcel for nothing, because `already_dispatched` made the dispatch
   route unrepeatable. With two doors it takes the flag below: the JD route
   reads the parcel's dispatched_at BEFORE its own UPDATE and speaks only when
   that read was empty, so the customer is told once whichever door the box
   left by, and twice by neither. */
const jdAt = ROUTES.indexOf("router.post('/api/retail-admin/orders/:id/jd-waybill'");
const jdEnd = ROUTES.indexOf('\n});', jdAt);
const jdBody = ROUTES.slice(jdAt, jdEnd === -1 ? jdAt + 12000 : jdEnd);
check('the JD label route calls it for a parked order too',
  /if \(o\.status === 'awaiting_restock' && !parcelAlreadyOut\) \{\s*\n\s*try \{ notifyParcelShippedWhileParked\(id, shipment\.mode\); \}/.test(jdBody), true);
check('…reading the parcel\'s dispatched_at BEFORE its own UPDATE stamps it',
  jdBody.indexOf('const parcelAlreadyOut = !!shipment.dispatched_at;') <
  jdBody.indexOf('dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP)'), true);
check('…so the dispatch route\'s own call stays the only one for a box already out',
  /parcelAlreadyOut/.test(dispBody), false);
// The helper's own note is the place a third door would be told about this.
check('the notifier says once-per-parcel now takes a guard',
  /ONCE PER PARCEL, and §193 is why/.test(ROUTES), true);
/* SWALLOWED ON PURPOSE, AND THE REASON IS DIFFERENT FROM ITS SIBLING'S, which
   is why it is asserted separately rather than by the same regex. On the
   dispatch route a throw would fail a dispatch that happened; here it would
   report a failure for a waybill JD has already issued, and the operator's
   retry would mint a SECOND one. check-swallowed-errors.js holds the ceiling
   this would otherwise have raised. */
check('…swallowed on purpose, and says a retry would mint a second waybill',
  /catch \(e\) \{\s*\n\s*\/\/ Swallowed on purpose: the waybill is minted at JD[\s\S]{0,400}mint a SECOND waybill/.test(jdBody), true);

/* ORDER_STATUS_NOTIF IS KEYED ON THE STATUS COLUMN. A key added there fires the
   WeChat push, and the order's status is deliberately not this. */
const mapAt = ROUTES.indexOf('const ORDER_STATUS_NOTIF = {');
const mapBody = ROUTES.slice(mapAt, ROUTES.indexOf('};', mapAt));
check('the status→notification map gained no key',
  mapBody.includes('order_parcel_shipped') || mapBody.includes('部分'), false);
check('…and still holds exactly the six order statuses',
  (mapBody.match(/^\s{2}\w+:\s+\{ en:/gm) || []).length, 6);

// ─────────────────────────────────────────────────────────────────────────────
section('── 4. The customer screen can render a type it has never seen');

/* The reason a new `type` is safe, checked rather than assumed: the mini app's
   notification page routes on ref_type and renders title/body straight through.
   If it ever grows a switch on `type`, an unmapped row could render blank —
   which is exactly the silent failure this asserts against. */
check('the notification page routes on ref_type', /reftype === 'order'/.test(MINIAPP), true);
check('…and does not switch on the notification type',
  /switch\s*\(\s*(n|item|row)?\.?type\s*\)/.test(MINIAPP), false);

// ─────────────────────────────────────────────────────────────────────────────
section('── 5. The Chinese is declared, and the decision is on the record');

check('the vocabulary carries the section', /## One box of a parked order has left/.test(VOCAB), true);
check('…with both composed pairs in it',
  ['订单部分已发货', '其中一个包裹已发货，其余商品待补货后发货。'].filter((t) => !VOCAB.includes(t)), []);
check('…marked composed, per the standing delegation',
  /\*\*COMPOSED\*\* under the standing delegation, 2026-09-19/.test(VOCAB), true);
// The rejected candidates are half the value of a declaration: they stop the
// next session repeating the search and re-deciding it differently.
check('…and records the candidates it turned down',
  ['`分批发货`', '`订单已发货`', '`部分发货`'].filter((t) => !VOCAB.includes(t)), []);
check('§190 declares the three composed sentences',
  ['空运包裹已发货', '陆运包裹已发货', '同城包裹已发货'].filter((t) => !VOCAB.includes(t)), []);
// 同城 rather than 同城配送: the longer form is the OPERATOR register's word for
// the shipping METHOD, and the customer is being told about a box.
check('…and says why it shortens the same-city word',
  /\*\*同城 RATHER THAN 同城配送\.\*\*/.test(VOCAB), true);
check('§190 is recorded before the code that depends on it',
  /\*\*§190 · THE NOTIFICATION NAMES WHICH BOX/.test(DECIDE), true);
check('§188 is recorded before the code that depends on it',
  /\*\*§188 · THE PARKED ORDER'S CUSTOMER IS TOLD THAT ONE BOX HAS GONE/.test(DECIDE), true);

// ── Report ──────────────────────────────────────────────────────────────────
db.close();
try { fs.unlinkSync(dbPath); } catch {}

for (const r of results) {
  if (r.heading) { console.log('\n' + r.heading); continue; }
  if (r.ok) console.log('  PASS  ' + r.name);
  else console.log('  FAIL  ' + r.name + '\n        expected ' + JSON.stringify(r.expected)
    + '\n        actual   ' + JSON.stringify(r.actual));
}
const total = results.filter((r) => !r.heading).length;
console.log(`\n${total - failures}/${total} passed`);
if (SABOTAGE) {
  console.log(failures ? 'SABOTAGE: the suite went red, as it must.'
    : 'SABOTAGE: the suite stayed GREEN — it is not testing what it claims.');
  process.exit(failures ? 0 : 1);
}
process.exit(failures ? 1 : 0);
