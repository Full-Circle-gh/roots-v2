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
 *      THE GRAIN IS THE LINE (§69): one product made out of three is news on
 *      its own, and the two legacy arms (a request at 'prepared' whose lines
 *      were never backfilled; a request acknowledged before restock_items had
 *      a seen_at) keep the new clause a strict superset of the old one.
 *   2b. AND THE ROW NAMES THEM. The names are what saves the trip to the
 *      order screen, so the payload carries both languages and the row spends
 *      its meta run on two of them plus an honest tail.
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
  // BOTH TABLES SINCE §69. The clause joins them — a fixture holding only
  // restock_orders would have proved nothing about a signal that is now
  // counted per line.
  return addTables(openMemoryDb(), SCHEMA_SQL, DATABASE_JS,
    ['restock_orders', 'restock_items']);
}

let seq = 0, itemSeq = 0;
/** One request AND its lines. Defaults are the case the row exists for: the
 *  kitchen made it and nobody has read it yet. Each fixture overrides the one
 *  field that makes it different.
 *
 *  `lines` is an array of per-line overrides — `[{}, {}]` is two lines both
 *  finished, `[{ status: 'sent' }, {}]` is the half-made request §69 exists
 *  for. A line inherits the request's own status when it names none, which is
 *  what every request looked like before §61 split them. */
function seedRequest(db, row = {}) {
  const { lines, ...rest } = row;
  const r = {
    to_role: 'kitchen', from_role: 'warehouse', status: 'prepared',
    // `date` is NOT NULL on the real table and every insert path sets it; the
    // clause never reads it, but a fixture that skips it tests nothing at all.
    date: '2026-09-08',
    prepared_at: '2026-09-08 06:00:00', archived_at: null, seen_at: null, ...rest,
  };
  const n = ++seq;
  db.prepare(`INSERT INTO restock_orders
      (id, rs_number, date, status, from_role, to_role, prepared_at, archived_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n, 'PR-260908-' + String(n).padStart(3, '0'), r.date, r.status, r.from_role,
      r.to_role, r.prepared_at, r.archived_at, r.seen_at);
  for (const line of (lines || [{}])) {
    const i = ++itemSeq;
    const L = {
      product_name: 'Peanut Butter ' + i, product_cn: '花生酱 ' + i,
      qty_requested: 1, status: r.status,
      prepared_at: r.status === 'prepared' ? r.prepared_at : null,
      seen_at: null, ...line,
    };
    db.prepare(`INSERT INTO restock_items
        (id, restock_id, product_name, product_cn, qty_requested, status, prepared_at, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i, n, L.product_name, L.product_cn, L.qty_requested, L.status,
        L.prepared_at, L.seen_at);
  }
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
  assert.ok(/KITCHEN_READY_WHERE[\s\S]{0,120}?\}\s*=\s*_kready/.test(RESTOCK_JS)
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
section('2b · One product made out of three (§69)');

it('a request with ONE of three lines made is the fire, and counts one', () => {
  /* THE DEFECT THIS SECTION EXISTS FOR. Ash, from the kitchen queue showing one
     product made of three: "if only 1 product marked as made, it wont show it
     on dashboard, thats a problem." §61 split the WORK to the line and left
     restock_orders.status a rollup that only catches up when every line is
     done — so the request below sits at 'sent' and the old clause, reading the
     order, answered zero about a jar already on the shelf. */
  const db = freshDb();
  seedRequest(db, { status: 'sent', prepared_at: null, lines: [
    { status: 'prepared', prepared_at: '2026-09-08 06:00:00' },
    { status: 'received' },
    { status: 'sent' },
  ] });
  assert.strictEqual(krCount(db), 1, 'a finished product is news whatever its request says');
});

it('and it counts PRODUCTS, so three made on one request is three', () => {
  const db = freshDb();
  seedRequest(db, { lines: [{}, {}, {}] });
  assert.strictEqual(krCount(db), 3, 'the pill counts what the kitchen made, not what was asked');
});

it('a zero line is not a product', () => {
  // Both screens already filter these out of the lists they draw, and a fire
  // counting what neither screen shows is the same lie as one that disagrees
  // with its queue.
  const db = freshDb();
  seedRequest(db, { lines: [{}, { qty_requested: 0 }] });
  assert.strictEqual(krCount(db), 1);
});

it('reading one product does not silence the next', () => {
  // The whole reason the stamp had to come down to the line with the count.
  const db = freshDb();
  seedRequest(db, { lines: [{ seen_at: '2026-09-08 07:00:00' }, {}] });
  assert.strictEqual(krCount(db), 1);
});

section('   …and the two legacy arms, which make it a superset and not a swap');

it('a request finished before §61 split the lines still counts', () => {
  // §61's backfill ran on the MAIN database only; a tenant file got the columns
  // with their plain 'sent' default and no data migration. Reading the rollup
  // as well is what keeps those requests on the screen.
  const db = freshDb();
  seedRequest(db, { status: 'prepared', lines: [{ status: 'sent', prepared_at: null }] });
  assert.strictEqual(krCount(db), 1);
});

it('…and takes the request\'s own prepared_at as its age', () => {
  const db = freshDb();
  seedRequest(db, { status: 'prepared', prepared_at: '2026-09-07 05:00:00',
    lines: [{ status: 'sent', prepared_at: null }] });
  assert.strictEqual(krItems(db)[0].waiting_since, '2026-09-07 05:00:00',
    'a line with no stamp of its own must fall back to its request\'s');
});

it('a request acknowledged before restock_items had a seen_at stays quiet', () => {
  /* NOTHING RE-LIGHTS ON THE DEPLOY THAT SHIPS THIS, and that is what the
     second arm buys. Under the order-level clause `seen_at` could only ever be
     stamped on a request whose every line was done, so an acknowledged order
     means acknowledged lines; dropping the arm would relight months of read
     history as unread news on the morning §69 ships. */
  const db = freshDb();
  seedRequest(db, { seen_at: '2026-09-08 07:00:00', lines: [{}, {}, {}] });
  assert.strictEqual(krCount(db), 0);
});

section('   …and the names the row spends its meta run on');

it('the preview carries BOTH languages, never just this request\'s', () => {
  /* The dashboard's language toggle repaints from the payload it already holds
     (dashRender) without re-fetching, so a payload carrying one language would
     flip the row into the wrong one until the next poll. */
  const db = freshDb();
  seedRequest(db, { lines: [{ product_name: 'Peanut Butter', product_cn: '花生酱' }] });
  const [row] = krItems(db);
  assert.strictEqual(row.name_en, 'Peanut Butter');
  assert.strictEqual(row.name_cn, '花生酱');
});

it('and the request it belongs to, so the list can still be opened at it', () => {
  const db = freshDb();
  const id = seedRequest(db, { lines: [{}] });
  const [row] = krItems(db);
  assert.strictEqual(row.restock_id, id);
  assert.ok(/^PR-/.test(row.rs_number), 'the request number travels with the line');
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

function kitchenFire(kitchen_ready, { can = true, mins = 240, cn = false } = {}) {
  const fires = [];
  // `window` and `cuLang` are stubbed because the row reads the LANGUAGE now:
  // product names are data and carry no EN/CN pair, so which of the two the row
  // prints is decided here rather than by cuT. The shipped guard is
  // `window.cuLang && cuLang() === 'cn'`, so both have to be present.
  const win = { cuLang: () => (cn ? 'cn' : 'en') };
  vm.runInNewContext(
    `const kr = DASH_OPS.kitchen_ready || { count: 0, items: [] }; ${KR_FIRE_SRC}`, {
      fires, DASH_OPS: { kitchen_ready },
      dashCardWants: () => can,
      window: win, cuLang: win.cuLang,
      cuT: (en, zh) => (cn ? zh : en),
      tdOldestMins: (items) => ((items || []).length ? mins : null),
    });
  return fires[0] || null;
}
const NAMED = (...names) => names.map((n, i) => ({ id: i + 1, name_en: n, name_cn: n + '(中)' }));

it('a finished request raises an amber row that counts them', () => {
  const f = kitchenFire({ count: 3, items: [{ id: 1 }] });
  assert.strictEqual(f.n, 3);
  assert.strictEqual(f.sev, 'amber');
});

section('   …and it names what was made, which is why it exists (§69)');

it('one product is named outright', () => {
  /* THE SECOND HALF OF THE REPORT: "why not to mention the specific product
     kitchen made directly on the dashboard this way the user wont need to open
     the order, too many clicks." A request NUMBER is the one fact about a
     finished jar the warehouse cannot act on. */
  const f = kitchenFire({ count: 1, items: NAMED('Peanut Butter') });
  assert.strictEqual(f.state, 'Peanut Butter');
});

it('two are named, and a third becomes an honest tail', () => {
  // The meta run truncates at a narrow width by design (retail-admin.css
  // .td-nmeta), so a third name would ellipsize mid-word rather than read.
  const f = kitchenFire({ count: 3, items: NAMED('Maple Almond', 'Peanut Butter', 'BioCurcumin+') });
  assert.strictEqual(f.state, 'Maple Almond, Peanut Butter +1 more');
});

it('the tail counts off the COUNT, never the capped preview', () => {
  // The server previews 8; a tail computed from the preview would say "+6"
  // while 14 sat waiting.
  const f = kitchenFire({ count: 14, items: NAMED('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H') });
  assert.strictEqual(f.state, 'A, B +12 more');
});

it('in Chinese it reads Chinese, from the same payload', () => {
  const f = kitchenFire({ count: 3, items: NAMED('Maple Almond', 'Peanut Butter') }, { cn: true });
  assert.strictEqual(f.state, 'Maple Almond(中)，Peanut Butter(中) +1 更多',
    'the row must repaint from the payload it holds, both names and tail');
});

it('a payload with no names still raises the row, just without them', () => {
  // The count and the clock are the row's floor; a preview that failed to
  // carry names must never cost the fire itself.
  const f = kitchenFire({ count: 2, items: [{ id: 1 }, { id: 2 }] });
  assert.strictEqual(f.n, 2);
  assert.strictEqual(f.state, null);
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

it('and it names the products too — the phone is where the report came from', () => {
  const block = sliceBlock(M_HTML, "if(c('kitchen_ready')", { from: 'function opsFires' });
  assert.ok(/name_en\|\|x\.name_cn|name_cn\|\|x\.name_en/.test(block),
    'the phone row must read the names out of the same payload the desktop does');
  assert.ok(/slice\(0,2\)/.test(block), 'two names, as on the desktop');
  assert.ok(/T\('more','更多'\)/.test(block),
    'the tail must carry the live bilingual pair, not an English-only "+N more"');
  assert.ok(/c\('kitchen_ready'\)-krNm\.length/.test(block),
    'the tail must count off the COUNT, never the capped preview');
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
section('6 · The list that row opens, on the phone');

/* THE ROW WORKED AND THE SCREEN BEHIND IT WAS EMPTY. Every assertion in
   section 5 passed while the list this app opens showed "Nothing finished yet"
   over a shelf with forty jars on it: `api()` unwraps the envelope, and
   `loadKr` unwrapped it a second time, so `k.list` was `[]` on every load.
   Nothing in the source LOOKED wrong — `(j&&j.data)||[]` is the right shape
   for this file's other helper — so nothing short of running the two halves
   together could have caught it. This runs them together: the real envelope
   the route answers with, through the shipped `api()` return, into the shipped
   assignment. Ash: *"this page doesnt show on mobile."* */

/** The one expression a shipped function ends on, evaluated later against a
 *  stub. Anchored on the function, so a rename fails loudly. */
function lastReturnExpr(src, anchor) {
  const block = sliceBlock(src, anchor);
  const returns = [...block.matchAll(/return\s+([^;]+);/g)];
  assert.ok(returns.length, `no return in ${anchor}`);
  return returns[returns.length - 1][1];
}

it('api() hands the loader the rows, not the envelope', () => {
  const expr = lastReturnExpr(M_HTML, 'async function api(path)');
  const rows = [{ id: 7, restock_id: 3, qty_requested: 2 }];
  // What routes/restock.js kitchen-ready/lines actually answers with.
  const out = vm.runInNewContext(`(function(j){ return ${expr}; })`)(
    { success: true, data: rows });
  assert.deepStrictEqual(out, rows,
    'api() no longer unwraps `data` — every loader below reads a different shape now');
});

it('and the loader keeps them — the list is not unwrapped twice', () => {
  const block = lockedLoadKr();
  const m = /k\.list\s*=\s*([^;]+);/.exec(block);
  assert.ok(m, 'loadKr no longer assigns k.list');
  const apiExpr = lastReturnExpr(M_HTML, 'async function api(path)');
  const rows = [{ id: 7 }, { id: 8 }];
  const j = vm.runInNewContext(`(function(j){ return ${apiExpr}; })`)(
    { success: true, data: rows });
  const list = vm.runInNewContext(`(function(j){ return ${m[1]}; })`)(j);
  assert.deepStrictEqual(list, rows,
    'the phone drew an empty list over a full shelf — the screen said "Nothing finished yet"');
});

it('an envelope that is not an array still degrades to a list', () => {
  // A tenant whose table is missing answers `{success:true}` with no data, and
  // a screen is a worse place to throw than to say nothing.
  const m = /k\.list\s*=\s*([^;]+);/.exec(lockedLoadKr());
  const list = vm.runInNewContext(`(function(j){ return ${m[1]}; })`)(undefined);
  // Array.isArray rather than deepStrictEqual: the empty array is minted inside
  // the sandbox, so it carries that realm's prototype and a strict deep compare
  // against this realm's `[]` fails on the prototype alone.
  assert.ok(Array.isArray(list) && list.length === 0,
    'k.list must be an empty array or the render throws');
});

it('it reads the LINES route, the one the fire counts', () => {
  assert.ok(/api\('\/api\/restock\/kitchen-ready\/lines'\)/.test(lockedLoadKr()),
    'the list must read the same clause the row counts, or one of the two is lying');
});

/** loadKr's body, anchored so a rename fails loudly rather than passing. */
function lockedLoadKr() { return sliceBlock(M_HTML, 'function loadKr(force)'); }

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
