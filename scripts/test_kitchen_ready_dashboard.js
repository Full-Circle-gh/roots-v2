#!/usr/bin/env node
/**
 * "The kitchen finished it" — the Needs-you row, on both dashboards.
 *
 *   node scripts/test_kitchen_ready_dashboard.js
 *
 * THE COMPLAINT. Ash, on the warehouse account: the kitchen makes what the
 * warehouse asked for and nothing anywhere says so in a way you can miss less
 * than completely. scripts/test_kitchen_ready_signal.js already covers the
 * PHONE'S DOT and the `seen_at` fact behind it. This file covers what was added
 * beside it: a row on Needs you — the strip at the top of the desktop dashboard
 * and the top of the phone's Home — because the dot was 6px of Sage two taps
 * inside More, and on the DESKTOP there was nothing at all. Grepping the shipped
 * admin for `kitchen-ready` returned zero: the code had never been written.
 *
 * No network, no keys, no browser. Both halves read the SHIPPED source, the same
 * technique scripts/test_inbox_fires.js and scripts/test_payment_mismatch.js
 * use: the server half slices the real SQL out of routes/retail.js and runs it
 * against tables built from the real schema, and the client half slices the real
 * fires.push out of 03-dashboard.js and evaluates it against stubs.
 *
 * What it locks down:
 *   1. ONE CLAUSE, NOT TWO. The row counts what the dot counts, because both
 *      require lib/kitchen-ready.js. A fire that disagrees with the queue it
 *      opens means one of the two is lying — so this asserts the shared clause
 *      is the one the route runs, AND that no second copy of it has grown back
 *      anywhere in the tree.
 *   2. WHAT COUNTS AS NEWS — kitchen direction only, made only, not archived,
 *      not already read. A dispatched store transfer is none of this business.
 *   3. THE CLOCK, and it is the reason the row is amber. Needs-you sorts by age
 *      and a fire with no age sorts LAST; on this role the only other fire is
 *      Restock needed, which has no clock by design. Proven by running the
 *      shipped comparator, not by reading it.
 *   4. THE TWO AUDIENCE GATES — the maker is not told about their own output,
 *      and an operator who cannot open the list is never told about it. Both on
 *      the server (where it keeps the data off the wire) and on the client.
 *   5. THE DOOR — /stock?go=ready, which is the URL that stamps `seen_at`. A row
 *      that only stated a count would never clear from the desktop at all.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function section(t) { console.log(`\n${t}`); }

const ROOT = path.join(__dirname, '..');
const RETAIL_JS   = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const RESTOCK_JS  = fs.readFileSync(path.join(ROOT, 'routes', 'restock.js'), 'utf8');
const DASH_JS     = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const M_HTML      = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SQL  = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

// The real module, required rather than re-read: what the routes run.
const kitchenReady = require('../lib/kitchen-ready');

// ── Slicing the shipped source ────────────────────────────────────────────
// Every reader asserts it found its anchor, so a rename produces "not found in
// the shipped file" rather than a quietly-passing test.

/** A braced block (function, `if`, `try`, or an arrow body): from `anchor` to
 *  its matching `}`.
 *
 *  THE BRACE IS SEARCHED FOR FROM `start`, NOT FROM THE END OF THE ANCHOR, and
 *  that is the one line where this differs from the copy in
 *  scripts/test_inbox_fires.js. Every anchor in that file stops short of its
 *  block's `{`; two in this one END with it ('try {', and the comparator's
 *  arrow). Skipping past the anchor therefore skipped past the very brace being
 *  balanced, and the scan ran on to the NEXT block in the file — silently
 *  returning a slice of unrelated code that still happened to contain the
 *  string being asserted on. Searching from `start` finds the same brace in
 *  both shapes, because an anchor that does not reach its block cannot contain
 *  a brace of its own. */
function sliceBlock(src, anchor, { from } = {}) {
  const base = from ? src.indexOf(from) : 0;
  assert.notStrictEqual(base, -1, `anchor comment not found: ${from}`);
  const start = src.indexOf(anchor, base);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

/** The first template literal after `anchor`, returned WITH its backticks. */
function sliceTemplate(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('`', start + anchor.length);
  assert.notStrictEqual(open, -1, `no template literal after ${anchor}`);
  const close = src.indexOf('`', open + 1);
  assert.notStrictEqual(close, -1, `unterminated template literal after ${anchor}`);
  return src.slice(open, close + 1);
}

// ── The queries, lifted out of routes/retail.js ───────────────────────────
// EVALUATED with the REAL lib in scope, so what runs below is the exact string
// the route hands to SQLite — clause included. Pattern-matching the SQL would
// pass just as happily against a clause that had quietly forked.
const krSql = (anchor) => vm.runInNewContext(
  `(() => (${sliceTemplate(RETAIL_JS, anchor)}))()`, { kitchenReady });
const KR_COUNT_SQL = krSql('const krCount = tdb().prepare(');
const KR_ITEMS_SQL = krSql('const krItems = tdb().prepare(');

// ── The database ──────────────────────────────────────────────────────────
const { openMemoryDb, addTables, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

// The CREATE comes from schema.sql (restock_orders is a tenant table); every
// addColumn() since — to_role, archived_at, seen_at among them — comes from
// database.js. Both, or the suite runs against a table thinner than the one the
// route reads, which is exactly the drift memory-db.js exists to end.
function freshDb() {
  return addTables(openMemoryDb(), SCHEMA_SQL, DATABASE_JS, ['restock_orders']);
}

let seq = 0;
/** One request. Defaults are the case the row exists for: the kitchen made it
 *  and nobody has read it yet. Each fixture overrides the one field that makes
 *  it different. */
function seedRequest(db, row = {}) {
  const r = {
    to_role: 'kitchen', from_role: 'warehouse', status: 'prepared',
    // `date` is NOT NULL on the real table and every insert path sets it; the
    // clause never reads it, but a fixture that skips it tests nothing at all.
    date: '2026-09-08',
    prepared_at: '2026-09-08 06:00:00', archived_at: null, seen_at: null, ...row,
  };
  const n = ++seq;
  db.prepare(`INSERT INTO restock_orders
      (id, rs_number, date, status, from_role, to_role, prepared_at, archived_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n, 'PR-260908-' + String(n).padStart(3, '0'), r.date, r.status, r.from_role,
      r.to_role, r.prepared_at, r.archived_at, r.seen_at);
  return n;
}
const krCount = (db) => db.prepare(KR_COUNT_SQL).get().n;
const krItems = (db) => db.prepare(KR_ITEMS_SQL).all({ preview: 8 });

// ══════════════════════════════════════════════════════════════════════════
section('1 · One clause, not two');

it('the row runs the SHARED clause, not a copy of its own', () => {
  // The clause is a private detail of lib/kitchen-ready.js as far as the route
  // is concerned; what matters is that the string SQLite receives contains it.
  assert.ok(KR_COUNT_SQL.includes(kitchenReady.KITCHEN_READY_WHERE),
    'the ops count query does not carry lib/kitchen-ready.js\'s clause');
  assert.ok(KR_ITEMS_SQL.includes(kitchenReady.KITCHEN_READY_WHERE),
    'the ops items query does not carry lib/kitchen-ready.js\'s clause');
});

it('and so does the phone\'s dot — the two cannot answer differently', () => {
  assert.ok(/KITCHEN_READY_WHERE\s*\}\s*=\s*_kready/.test(RESTOCK_JS)
    || /_kready\.KITCHEN_READY_WHERE/.test(RESTOCK_JS),
    'routes/restock.js no longer takes its clause from lib/kitchen-ready.js');
});

it('no second copy of the clause has grown back anywhere', () => {
  // A finding filed at one file:line is where it was found, not the extent of
  // it. The clause is four conditions; `seen_at IS NULL` next to a to_role test
  // is the fingerprint, and lib/kitchen-ready.js is the one place it may appear.
  const suspects = [];
  for (const rel of ['routes/retail.js', 'routes/restock.js',
                     'public/m.html', 'public/stock.html',
                     'public/retail-admin/03-dashboard.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/COALESCE\(to_role,\s*'warehouse'\)\s*=\s*'kitchen'[\s\S]{0,200}?seen_at IS NULL/.test(src)) {
      suspects.push(rel);
    }
  }
  assert.deepStrictEqual(suspects, [],
    `the clause is retyped in: ${suspects.join(', ')} — require lib/kitchen-ready.js instead`);
});

// ══════════════════════════════════════════════════════════════════════════
section('2 · What counts as news');

it('a request the kitchen has made, unread, is the fire', () => {
  const db = freshDb();
  seedRequest(db);
  assert.strictEqual(krCount(db), 1);
});

it('a request still in the kitchen\'s queue is not', () => {
  const db = freshDb();
  seedRequest(db, { status: 'sent' });
  seedRequest(db, { status: 'received' });   // "we have seen it" is not "it is made"
  assert.strictEqual(krCount(db), 0);
});

it('one somebody has already read is not', () => {
  // The acknowledgement is server-side, so one person opening the list puts this
  // row out on every other screen at once.
  const db = freshDb();
  seedRequest(db, { seen_at: '2026-09-08 07:00:00' });
  assert.strictEqual(krCount(db), 0);
});

it('an archived one is not — hiding a row and reading it are different facts', () => {
  const db = freshDb();
  seedRequest(db, { archived_at: '2026-09-08 07:00:00' });
  assert.strictEqual(krCount(db), 0);
});

it('a dispatched store transfer is none of this row\'s business', () => {
  // Same table, same 'prepared', different direction — and marking a TRANSFER
  // prepared means goods are packed and about to move, which is another
  // sentence entirely. Counting it would put "the kitchen finished it" over a van.
  const db = freshDb();
  seedRequest(db, { from_role: 'store', to_role: 'warehouse' });
  seedRequest(db, { from_role: 'warehouse', to_role: 'store' });
  assert.strictEqual(krCount(db), 0);
});

it('a row predating the direction columns defaults to a transfer, not a kitchen job', () => {
  // COALESCE(to_role,'warehouse') — historic rows carry NULL, and guessing
  // "kitchen" for them would light this row for every old transfer in the table.
  const db = freshDb();
  seedRequest(db, { to_role: null });
  assert.strictEqual(krCount(db), 0);
});

section('   …and the clock the row runs on');

it('items carry `waiting_since`, which is the key both dashboards read', () => {
  // tdOldestMins() on the desktop and oldestMins() on the phone both read
  // exactly this key. Renaming it silently costs the row its age — and the age
  // is the whole reason the row outranks its neighbour.
  const db = freshDb();
  seedRequest(db);
  const items = krItems(db);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].waiting_since, '2026-09-08 06:00:00',
    'waiting_since must be prepared_at — how long the NEWS has gone unread');
});

it('oldest first, so the preview always contains the true oldest', () => {
  const db = freshDb();
  seedRequest(db, { prepared_at: '2026-09-08 09:00:00' });
  seedRequest(db, { prepared_at: '2026-09-07 08:00:00' });
  seedRequest(db, { prepared_at: '2026-09-08 06:00:00' });
  assert.deepStrictEqual(krItems(db).map(r => r.waiting_since),
    ['2026-09-07 08:00:00', '2026-09-08 06:00:00', '2026-09-08 09:00:00']);
});

it('the count is exact even when the preview caps the list', () => {
  const db = freshDb();
  for (let i = 0; i < 12; i++) seedRequest(db);
  assert.strictEqual(krCount(db), 12, 'the count is never derived from the preview');
  assert.strictEqual(krItems(db).length, 8, 'while the preview stays capped');
});

// ══════════════════════════════════════════════════════════════════════════
section('3 · Who is told (server)');

const caps = (...keys) => ({ caps: new Set(keys) });

it('the maker is not told about their own output', () => {
  // fulfil WITHOUT pick is the operator confined to the making side. A row
  // telling them their own work is waiting is telling them about themselves.
  assert.strictEqual(kitchenReady.kitchenScopedSession(caps('restock:fulfil')), true);
});

it('holding pick as well puts them back in the audience', () => {
  assert.strictEqual(
    kitchenReady.kitchenScopedSession(caps('restock:fulfil', 'restock:pick')), false);
});

it('a kitchen-realm session is the maker whatever its caps say', () => {
  assert.strictEqual(kitchenReady.kitchenScopedSession({ restockRealm: 'kitchen' }), true);
});

it('the side that ASKS is the side that is told', () => {
  assert.strictEqual(kitchenReady.canSeeKitchenReady(caps('restock:request')), true);
  assert.strictEqual(kitchenReady.canSeeKitchenReady(caps('restock:pick')), true);
});

it('a role with no restock work at all is never told', () => {
  assert.strictEqual(kitchenReady.canSeeKitchenReady(caps('orders:view')), false);
});

it('unresolved caps fail OPEN, as every other cap read in this codebase does', () => {
  // null is "not resolved", not "denied" — the rule m.html's mCan() and the
  // desktop's applyCapGates both keep.
  assert.strictEqual(kitchenReady.canSeeKitchenReady({ caps: null }), true);
});

it('the endpoint answers a zero rather than a 403', () => {
  // This is polled in the background by every dashboard. A refusal here bounces
  // a phone sitting in a pocket to the login screen.
  const block = sliceBlock(RETAIL_JS, 'if (!kitchenReady.kitchenScopedSession(req)',
    { from: '── The kitchen finished what the warehouse asked for' });
  assert.ok(!/res\.status\(40[13]\)/.test(block),
    'the ops row must never refuse — it leaves kitchen_ready at its zero default');
});

it('a tenant whose restock table is not there loses this row and nothing else', () => {
  // It sits inside the shared try, and the channel-stall rollup is computed
  // AFTER it: without its own catch, a throw here would silently take a key
  // that worked before this row existed.
  const guarded = sliceBlock(RETAIL_JS, 'try {',
    { from: 'ITS OWN try/catch' });
  assert.ok(/kitchenReady\.KITCHEN_READY_WHERE/.test(guarded),
    'the kitchen_ready queries are not inside their own try');
  assert.ok(/catch \(e\) \{ console\.warn\('\[dashboard\/ops kitchen_ready\]'/
    .test(RETAIL_JS), 'the guard does not name itself when it fires');
});

it('the key actually ships in the payload', () => {
  // The queries can be perfect and the row still never appear.
  const res = RETAIL_JS.slice(RETAIL_JS.indexOf('reviews_unanswered, feedback_waiting'));
  assert.ok(/kitchen_ready/.test(res.slice(0, 400)),
    'kitchen_ready is missing from the /dashboard/ops response body');
});

// ══════════════════════════════════════════════════════════════════════════
section('4 · The row on the desktop dashboard');

const KR_FIRE_SRC = sliceBlock(DASH_JS, "if (kr.count && dashCardWants('kitchen_ready')",
  { from: '// The kitchen finished what the warehouse asked for' });

function kitchenFire(kitchen_ready, { can = true, mins = 240 } = {}) {
  const fires = [];
  vm.runInNewContext(
    `const kr = DASH_OPS.kitchen_ready || { count: 0, items: [] }; ${KR_FIRE_SRC}`, {
      fires, DASH_OPS: { kitchen_ready },
      dashCardWants: () => can,
      cuT: (en) => en,                    // assert on the EN half
      tdOldestMins: (items) => ((items || []).length ? mins : null),
    });
  return fires[0] || null;
}

it('a finished request raises an amber row that counts them', () => {
  const f = kitchenFire({ count: 3, items: [{ id: 1 }] });
  assert.strictEqual(f.n, 3);
  assert.strictEqual(f.sev, 'amber');
});

it('the row wears the list\'s own name, so both say the same words', () => {
  // The rule the Reviews row states: the fire and the page it opens name the
  // same thing. This pair is live in public/m.html and public/stock.html.
  assert.strictEqual(kitchenFire({ count: 1, items: [{}] }).label, 'Ready from the kitchen');
  assert.ok(M_HTML.includes("'Ready from the kitchen','厨房已完成'"),
    'the EN/CN pair this row copies is no longer live in m.html');
});

it('and it carries a clock — the reason it is amber at all', () => {
  assert.strictEqual(kitchenFire({ count: 1, items: [{}] }).mins, 240);
});

it('nothing finished raises nothing at all', () => {
  assert.strictEqual(kitchenFire({ count: 0, items: [] }), null);
});

it('an operator who cannot open the list is never told about it', () => {
  assert.strictEqual(kitchenFire({ count: 5, items: [{}] }, { can: false }), null);
});

it('the client gate names the pair that RAISES these requests', () => {
  const map = sliceBlock(DASH_JS, 'const DASH_CARD_CAP =');
  assert.ok(/kitchen_ready:\s*\['restock:request',\s*'restock:pick'\]/.test(map),
    'kitchen_ready is unmapped in DASH_CARD_CAP — an unknown key there means "always show"');
});

section('   …and it leads, which is the whole point of the clock');

it('it outranks Restock needed, every time', () => {
  /* THE CLAIM THE DESIGN RESTS ON. On the Stockroom role the only other fire
     that ever appears is Restock needed, and that one has no clock by design
     ("15 out of stock" is a state, not a queue). Needs-you sorts severity, then
     oldest-first, then no-age-last — so this row leads without anyone writing a
     rule to make it so. Run against the SHIPPED comparator: a change to the
     sort that reversed this would otherwise go unnoticed until Ash saw it. */
  // sliceBlock stops at the arrow body's closing brace, so the `)` that closes
  // the .sort( call is added back before this is evaluated — without it the
  // comparator's `return`s are top-level and V8 refuses the whole fragment.
  const SORT_SRC = sliceBlock(DASH_JS, 'fires.sort((a, b) => {',
    { from: '// Severity first, then oldest first' });
  const kitchen = kitchenFire({ count: 3, items: [{}] });
  const restock = { sev: 'amber', label: 'Restock needed', n: 4, mins: null };
  const fires = [restock, kitchen];                    // deliberately the wrong way round
  vm.runInNewContext(`${SORT_SRC});`, { fires, sevRank: { brick: 0, amber: 1 } });
  assert.strictEqual(fires[0].label, 'Ready from the kitchen',
    'a clockless fire must never outrank one carrying an age');
});

it('and a brick still beats it — news is not an emergency', () => {
  const SORT_SRC = sliceBlock(DASH_JS, 'fires.sort((a, b) => {',
    { from: '// Severity first, then oldest first' });
  const kitchen = kitchenFire({ count: 3, items: [{}] });
  const delivery = { sev: 'brick', label: 'Delivery needs a call', n: 1, mins: 10 };
  const fires = [kitchen, delivery];
  vm.runInNewContext(`${SORT_SRC});`, { fires, sevRank: { brick: 0, amber: 1 } });
  assert.strictEqual(fires[0].label, 'Delivery needs a call');
});

section('   …and where the click goes');

it('the door is the list that already exists, and stamping it read is the point', () => {
  const f = kitchenFire({ count: 1, items: [{}] });
  assert.strictEqual(f.go, 'dashOpenKitchenReady()');
  const open = sliceBlock(DASH_JS, 'function dashOpenKitchenReady()');
  assert.ok(/\/stock\?go=ready/.test(open),
    'the desktop row must open /stock?go=ready — the URL that stamps seen_at');
  assert.ok(!/window\.open/.test(open),
    'a popup blocker eats window.open silently, leaving a row that does nothing');
});

it('the row has a door at all', () => {
  // A count with nowhere to go would never clear from this dashboard: reading is
  // recorded by OPENING the list, and every other fire on the card opens something.
  const f = kitchenFire({ count: 1, items: [{}] });
  assert.ok(f.cta && f.go, 'the row must be clickable or it can never be put out');
});

// ══════════════════════════════════════════════════════════════════════════
section('5 · The same row on the phone\'s Home');

it('Home raises it from the same snapshot key', () => {
  const block = sliceBlock(M_HTML, "if(c('kitchen_ready')", { from: 'function opsFires' });
  assert.ok(/'amber'/.test(block), 'the phone must not disagree with the desktop on severity');
  assert.ok(/items\('kitchen_ready'\)/.test(block), 'without the items it has no age to sort on');
  assert.ok(/T\('Ready from the kitchen','厨房已完成'\)/.test(block),
    'the phone row must carry the live bilingual pair');
});

it('gated on the row it points at, like the inbox count', () => {
  const block = sliceBlock(M_HTML, "if(c('kitchen_ready')", { from: 'function opsFires' });
  assert.ok(/canRoute\('kitchenready'\)/.test(block),
    'a fire must never promise work behind a door this operator cannot open');
});

it('it opens the screen this app already has, not the other app', () => {
  const block = sliceBlock(M_HTML, "if(c('kitchen_ready')", { from: 'function opsFires' });
  assert.ok(/APP\.cmd\('push','kitchenready'\)/.test(block),
    'the phone has its own ready list (§48); sending it to /stock would be a detour');
});

it('the dot survives — it is what carries the fact off Home', () => {
  // On a flatNav role there is no tab bar at all and the More row's dot is the
  // only signal there is. The row is an addition to it, never a replacement.
  assert.ok(/function readyFromKitchen\(\)/.test(M_HTML), 'the dot has been removed');
  assert.ok(/moreRowDot\(key\)/.test(M_HTML), 'the More row dot has been removed');
});

it('reading the list clears the Home row too, not a minute later', () => {
  // Without this the operator reads the list, goes back, and Home tells them
  // again about the thing they just answered — for up to a poll cycle, which is
  // long enough to send somebody to look twice.
  const seen = sliceBlock(M_HTML, 'function krMarkSeen()');
  assert.ok(/state\.ops\.kitchen_ready/.test(seen),
    'krMarkSeen leaves the ops snapshot stale, so Home re-announces what was just read');
  assert.ok(/filter\(it=>ids\.indexOf\(it\.id\)<0\)/.test(seen),
    'it must drop the stamped ids, not zero the key — the kitchen can finish one mid-screen');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
