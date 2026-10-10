#!/usr/bin/env node
/**
 * "From the kitchen" on Needs you — §449.
 *
 *   node scripts/test_kitchen_asks_dashboard.js
 *
 * Ash, off the Purchasing screen's "From the kitchen" card: "from the kitchen
 * request should be for buying department in the need you dashboard". The card
 * stays; this row puts the same count on Home (phone) and on the dashboard
 * (desktop), for the people who buy.
 *
 * No network, no browser. The server half runs the SHIPPED SQL from
 * routes/retail.js against a database database.js itself built; the client
 * halves read the shipped source, as scripts/test_kitchen_ready_dashboard.js
 * does.
 *
 * What it locks down:
 *   1. ONE CLAUSE. The row and the Purchasing list both read
 *      lib/material-requests-pending, so they cannot disagree.
 *   2. WHAT COUNTS: sent lines only — never a draft, an archived request, a
 *      line already on an order, or a line the buyer struck off. Urgent lines
 *      are counted apart, and lead the preview.
 *   3. WHO SEES IT: purchasing:edit and the Production switch, on the server
 *      and on both clients.
 *   4. THE DOOR: the row opens the same picker the Purchasing card opens.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);
const section = t => console.log('\n' + t);

const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const MR_JS     = fs.readFileSync(path.join(ROOT, 'routes', 'retail-material-requests.js'), 'utf8');
const DASH_JS   = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const M_HTML    = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const pending   = require('../lib/material-requests-pending');

// The server block, from its banner to the end of its own try/catch.
function slice(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`not found in the shipped file: ${start}`);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`end not found after: ${start}`);
  return src.slice(a, b + end.length);
}
const SERVER = slice(RETAIL_JS, '/* ── From the kitchen (§449)', "console.warn('[dashboard/ops kitchen_asks]'");

// ── 1. One clause ───────────────────────────────────────────────────────────
section('1. One clause, two readers');
ok(/FROM \$\{PENDING_FROM\}\s+WHERE \$\{PENDING_WHERE\}/.test(MR_JS),
  'the Purchasing list reads the shared clause');
ok((SERVER.match(/FROM \$\{MR_PENDING_FROM\} WHERE \$\{MR_PENDING_WHERE\}/g) || []).length === 2,
  'the Needs-you count and its preview both read the shared clause');
ok(/require\('\.\.\/lib\/material-requests-pending'\)/.test(RETAIL_JS),
  'routes/retail.js takes it from lib/material-requests-pending');
ok(/parcel_recovery, kitchen_asks,/.test(RETAIL_JS), 'the key is on the /dashboard/ops payload');

// ── 2. What counts — the shipped SQL against a real schema ─────────────────
section('2. What counts');
// NEVER data/roots.db: a scratch copy, as scripts/test_material_requests.js does.
const SCRATCH = path.join(ROOT, `.test-scratch-ka-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'database.js'), path.join(SCRATCH, 'database.js'));
fs.copyFileSync(path.join(ROOT, 'schema.sql'),  path.join(SCRATCH, 'schema.sql'));
try { fs.symlinkSync(path.join(ROOT, 'lib'), path.join(SCRATCH, 'lib'), 'dir'); } catch {}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
const db = require(path.join(SCRATCH, 'database.js'));

const req = (id, status, sentAt, archived) => db.prepare(
  `INSERT INTO material_requests (id, mr_number, date, status, sent_at, archived_at)
   VALUES (?, ?, '2026-10-10', ?, ?, ?)`).run(id, 'MR-' + id, status, sentAt, archived ? '2026-10-10 09:00:00' : null);
const line = (id, rid, name, cn, extra = {}) => db.prepare(
  `INSERT INTO material_request_items (id, request_id, name_en, name_cn, qty, unit, urgent, sourced_po_id, declined_at)
   VALUES (?, ?, ?, ?, 1, 'bag', ?, ?, ?)`).run(id, rid, name, cn, extra.urgent ? 1 : 0, extra.po || null, extra.declined || null);

req(1, 'sent',  '2026-10-10 01:00:00');           // waiting
req(2, 'draft', null);                            // the cook is still typing
req(3, 'sent',  '2026-10-10 02:00:00', true);     // withdrawn
req(4, 'sourced', '2026-10-09 23:00:00');         // part ordered, older
line(11, 1, 'Flour', '面粉');
line(12, 1, 'Oat milk', '燕麦奶', { urgent: true });
line(21, 2, 'Draft thing', null);
line(31, 3, 'Archived thing', null);
line(41, 4, 'Ordered thing', null, { po: 99 });
line(42, 4, 'Struck thing', null, { declined: '2026-10-10 03:00:00' });
line(43, 4, 'Sugar', '糖');

// Run the shipped template literals, with the shared clause substituted.
const sqlOf = (marker) => {
  const at = SERVER.indexOf(marker);
  const open = SERVER.indexOf('`', at), close = SERVER.indexOf('`', open + 1);
  return new Function('MR_PENDING_FROM', 'MR_PENDING_WHERE', 'return `' + SERVER.slice(open + 1, close) + '`;')(
    pending.PENDING_FROM, pending.PENDING_WHERE);
};
const counted = db.prepare(sqlOf('const ka = tdb().prepare(')).get();
eq(counted.n, 3, 'three lines wait: two on the sent request, one left on the part-ordered one');
eq(counted.u, 1, 'one of them is urgent');
const preview = db.prepare(sqlOf('const kaItems = tdb().prepare(')).all({ preview: 8 });
eq(preview.map(r => r.id).join(','), '12,43,11', 'urgent first, then the longest-waiting');
ok(preview.every(r => 'name_en' in r && 'name_cn' in r), 'both languages travel with each line');
ok(preview.every(r => r.waiting_since), 'each line carries the time the kitchen sent it');
const listed = db.prepare(`SELECT i.id FROM ${pending.PENDING_FROM} WHERE ${pending.PENDING_WHERE}`).all();
eq(listed.length, counted.n, 'the count matches the list the row opens');

// ── 3. Who sees it ──────────────────────────────────────────────────────────
section('3. Who sees it');
ok(/req\.caps\.has\('purchasing:edit'\)/.test(SERVER), 'server: purchasing:edit');
ok(/productionEnabled\(tdb\(\)\)/.test(SERVER), 'server: the Production switch');
const PHONE = slice(M_HTML, "if(c('kitchen_asks')", "APP.cmd('pkOpen')\");");
ok(/&&pkOn\(\)/.test(PHONE), 'phone: the Purchasing card\'s own gate (pkOn)');
ok(/const pkOn=\(\)=>featOn\('production'\)&&mCan\('purchasing:edit'\)/.test(M_HTML), 'phone: pkOn is still Production + purchasing:edit');
ok(/kitchen_asks: 'purchasing:edit'/.test(DASH_JS), 'desktop: purchasing:edit in DASH_CARD_CAP');
const DESK = slice(DASH_JS, "const ka = DASH_OPS.kitchen_asks", "go: 'dashOpenKitchenAsks(event)'");
ok(/dashCardWants\('kitchen_asks'\) && dashFeatOn\('production'\)/.test(DESK), 'desktop: the cap and the Production switch');

// ── 4. What it says, and the door ──────────────────────────────────────────
section('4. Words and door');
ok(PHONE.includes("T('From the kitchen','厨房申请')"), 'phone: the card\'s own words');
ok(DESK.includes("cuT('From the kitchen', '厨房申请')"), 'desktop: the button\'s own words');
ok(/urgent\)>0\?'brick':'amber'/.test(PHONE), 'phone: brick when anything is urgent');
ok(/Number\(ka\.urgent\) > 0 \? 'brick' : 'amber'/.test(DESK), 'desktop: brick when anything is urgent');
ok(PHONE.includes("APP.cmd('pkOpen')"), 'phone: opens the same picker as the card');
const OPEN = slice(DASH_JS, 'function dashOpenKitchenAsks', '\n}');
ok(/dashJumpTab\('purchasing'\)/.test(OPEN) && /puMrOpen\(\)/.test(OPEN), 'desktop: goes to Purchasing and opens the picker');
ok(/function pkSyncOps\(\)/.test(M_HTML) && (M_HTML.match(/pkSyncOps\(\)/g) || []).length >= 3,
  'phone: a fresh list read updates the Home count at once');

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
