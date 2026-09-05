#!/usr/bin/env node
/**
 * Broadcasts have two ends: scheduled_for says when one starts, expires_at says
 * when it stops showing. Only the start existed before — this suite covers the
 * stop, on both sides of the wire.
 *
 *   node scripts/test_broadcast_expiry.js
 *
 * NOTHING HERE IS A MOCK OF THE THING UNDER TEST. The schema is rebuilt from
 * database.js by the shared harness (so a column added there and forgotten here
 * cannot make this pass); the feed predicate, the fanout guard and the create
 * handler's validation are SLICED OUT of routes/retail.js and evaluated, so
 * what runs below is the string the route hands SQLite and the branch the route
 * takes; the composer helpers are the shipped ones, loaded out of
 * public/retail-admin/05-marketing.js under a stub DOM. Every slicer asserts it
 * found its anchor, so a rename reads as "not found in the shipped file" rather
 * than a green run over code that no longer exists.
 *
 * What it holds:
 *   1 · both expires_at columns exist and default to NULL (= no end, which is
 *       how every broadcast written before the column behaves).
 *   2 · the customer feed hides a copy whose window has closed — from the list,
 *       from the unread badge, and from the greeting strip's broadcast flag —
 *       while a NULL or future one still shows. Hidden, not deleted: the row
 *       survives so a recall still has something to remove.
 *   3 · fanout copies the end onto every per-customer row, and refuses to write
 *       copies at all for a window that closed before the scheduler got there.
 *   4 · the create handler rejects an unparseable end and one at or before the
 *       moment the message goes out — for a send-now AND for a scheduled one —
 *       and stores it in the bare-UTC form CURRENT_TIMESTAMP compares against.
 *   5 · the composer reads its own inputs the same way the server does: local
 *       datetime-local in, UTC out, and a stored bare-UTC timestamp displayed
 *       in the operator's zone rather than eight hours early.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { openTablesDb, driver } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const RETAIL_JS   = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const MARKETING_JS = fs.readFileSync(
  path.join(ROOT, 'public', 'retail-admin', '05-marketing.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log(`  (sqlite driver: ${driver})`);

// ── Slicing the shipped source ────────────────────────────────────────────
/** A statement: from `anchor` to the first `;` outside a string. */
function sliceStatement(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === ';') return src.slice(start, j + 1);
  }
  throw new Error(`no statement terminator after ${anchor}`);
}
/** A braced block (function or `if`): from `anchor` to its matching `}`. */
function sliceBlock(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}
/** Everything from `from` up to (not including) `to`. */
function sliceRange(src, from, to) {
  const a = src.indexOf(from);
  assert.notStrictEqual(a, -1, `not found in the shipped file: ${from}`);
  const b = src.indexOf(to, a);
  assert.notStrictEqual(b, -1, `not found after ${from}: ${to}`);
  return src.slice(a, b);
}
/** The first template literal after `anchor`, WITH its backticks. */
function sliceTemplate(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('`', start + anchor.length);
  const close = src.indexOf('`', open + 1);
  assert.notStrictEqual(close, -1, `unterminated template literal after ${anchor}`);
  return src.slice(open, close + 1);
}

// The one predicate every customer-facing notification query carries, and the
// four queries that carry it, read off the route rather than retyped.
const NOTIF_LIVE_SRC = sliceStatement(RETAIL_JS, 'const NOTIF_LIVE =');
const feedSql = (anchor) => vm.runInNewContext(
  `(() => { ${NOTIF_LIVE_SRC} return ${sliceTemplate(RETAIL_JS, anchor)}; })()`, {});
// The list query as the handler assembles it: the base template plus the same
// ordering and limit it appends before preparing (the `before` cursor is a
// separate branch and doesn't bear on expiry).
const LIST_SQL        = feedSql('const before = req.query.before ?') + ' ORDER BY id DESC LIMIT ?';
const LIST_UNREAD_SQL = feedSql('const unread = tdb().prepare(');
const BADGE_SQL       = feedSql('// GET /api/retail/notifications/unread-count');
const HASBC_SQL       = feedSql('has_broadcast = tdb().prepare(');
const NOORDER_SQL     = feedSql('const noOrderN = tdb().prepare(');
// The fanout INSERT itself, evaluated so the columns it names are the shipped ones.
const FANOUT_INSERT_SQL = vm.runInNewContext(
  sliceTemplate(RETAIL_JS, 'const insert = tx.prepare('), {});

// ── The database ──────────────────────────────────────────────────────────
function freshDb() {
  return openTablesDb(DATABASE_JS, ['retail_broadcasts', 'retail_notifications']);
}
const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
// Bare-UTC ("YYYY-MM-DD HH:MM:SS"), the form both columns are stored in.
const utc = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600 * 1000;

function seedNotif(db, { customer_id = 1, category = 'broadcast', read_at = null,
                         expires_at = null, broadcast_id = null } = {}) {
  const info = db.prepare(
    `INSERT INTO retail_notifications
       (customer_id, category, type, title_en, read_at, expires_at, broadcast_id)
     VALUES (?, ?, 'announcement', 'Peanut butter is now 530g', ?, ?, ?)`
  ).run(customer_id, category, read_at, expires_at, broadcast_id);
  return Number(info.lastInsertRowid);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n1 · the columns');

it('retail_broadcasts carries expires_at', () => {
  assert.ok(cols(freshDb(), 'retail_broadcasts').includes('expires_at'),
    'database.js must bolt expires_at onto retail_broadcasts');
});

it('every fanned-out copy can carry it too', () => {
  assert.ok(cols(freshDb(), 'retail_notifications').includes('expires_at'),
    'database.js must bolt expires_at onto retail_notifications');
});

it('a broadcast written without one has no end', () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO retail_broadcasts (title_en, audience, status) VALUES ('Hi', 'all_active', 'sent')"
  ).run();
  const row = db.prepare('SELECT expires_at FROM retail_broadcasts').get();
  assert.strictEqual(row.expires_at, null, 'the old behaviour is "never expires"');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · what the customer sees');

it('a closed window drops out of the feed', () => {
  const db = freshDb();
  const live = seedNotif(db, { expires_at: utc(+HOUR) });
  seedNotif(db, { expires_at: utc(-HOUR) });
  const forever = seedNotif(db, { expires_at: null });
  const ids = db.prepare(LIST_SQL).all(1, 50).map(r => Number(r.id)).sort();
  assert.deepStrictEqual(ids, [live, forever].sort(),
    'only the expired copy may disappear');
});

it('it is hidden, not deleted — a recall still has a row to remove', () => {
  const db = freshDb();
  seedNotif(db, { expires_at: utc(-HOUR), broadcast_id: 7 });
  assert.strictEqual(db.prepare(LIST_SQL).all(1, 50).length, 0);
  const del = db.prepare('DELETE FROM retail_notifications WHERE broadcast_id = ?').run(7);
  assert.strictEqual(Number(del.changes), 1, 'the copy must still be on disk');
});

it('the unread badge stops counting it — on both endpoints that report it', () => {
  const db = freshDb();
  seedNotif(db, { expires_at: utc(-HOUR) });
  assert.strictEqual(Number(db.prepare(BADGE_SQL).get(1).n), 0);
  assert.strictEqual(Number(db.prepare(LIST_UNREAD_SQL).get(1).n), 0);
  seedNotif(db, { expires_at: utc(+HOUR) });
  assert.strictEqual(Number(db.prepare(BADGE_SQL).get(1).n), 1);
  assert.strictEqual(Number(db.prepare(LIST_UNREAD_SQL).get(1).n), 1);
});

it('the greeting strip stops flagging it as a broadcast', () => {
  const db = freshDb();
  seedNotif(db, { expires_at: utc(-HOUR) });
  assert.strictEqual(db.prepare(HASBC_SQL).get(1), undefined,
    'an expired broadcast must not swap the strip icon');
});

it('the order-excluded count drops it as well', () => {
  const db = freshDb();
  seedNotif(db, { category: 'broadcast', expires_at: utc(-HOUR) });
  seedNotif(db, { category: 'order', expires_at: null });
  assert.strictEqual(Number(db.prepare(NOORDER_SQL).get(1).n), 0,
    'the only non-order row has expired');
});

it('an order update is never filtered — it has no end', () => {
  const db = freshDb();
  seedNotif(db, { category: 'order', expires_at: null });
  assert.strictEqual(db.prepare(LIST_SQL).all(1, 50).length, 1);
  assert.strictEqual(Number(db.prepare(BADGE_SQL).get(1).n), 1);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · fanout');

it('the end is copied onto every per-customer row', () => {
  const db = freshDb();
  const ends = utc(+24 * HOUR);
  const insert = db.prepare(FANOUT_INSERT_SQL);
  for (const cid of [1, 2, 3]) insert.run(cid, 'T', 'T', null, null, null, null, 9, ends);
  const rows = db.prepare('SELECT expires_at FROM retail_notifications').all();
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => r.expires_at === ends), 'each copy carries the cap');
});

// The guard is the route's own: sliced, and run against a stub handle that
// records what it was asked to do.
const GUARD_SRC = sliceRange(RETAIL_JS,
  '  // Window already closed before we got here', '  const { where, params } = audienceWhere');
const BCTIME_SRC = sliceBlock(RETAIL_JS, 'function bcTimeMs(');

function runGuard(expires_at) {
  const runs = [];
  const db_ = { prepare: (sql) => ({ run: (...a) => runs.push({ sql, args: a }) }) };
  const reached = vm.runInNewContext(
    `${BCTIME_SRC}
     (function (db_, brd) { ${GUARD_SRC} return 'fanned-out'; })(db_, brd)`,
    { db_, brd: { id: 4, expires_at }, Date, Number });
  return { reached, runs };
}

it('a window that closed before the sweep reached it sends to nobody', () => {
  const { reached, runs } = runGuard(utc(-HOUR));
  assert.strictEqual(reached, 0, 'no copies, no recipients');
  assert.strictEqual(runs.length, 1);
  assert.ok(/status = 'expired'/.test(runs[0].sql),
    'the history should say what happened rather than claim a send');
});

it('a window still open fans out normally', () => {
  const { reached, runs } = runGuard(utc(+HOUR));
  assert.strictEqual(reached, 'fanned-out');
  assert.strictEqual(runs.length, 0);
});

it('no end at all fans out normally', () => {
  assert.strictEqual(runGuard(null).reached, 'fanned-out');
});

it('bare-UTC is read as UTC, not as local time', () => {
  const bcTimeMs = vm.runInNewContext(`${BCTIME_SRC} bcTimeMs`, { Date, Number });
  assert.strictEqual(bcTimeMs('2026-06-08 02:00:00'), Date.parse('2026-06-08T02:00:00Z'),
    'reading it as local would move the cap by the offset');
  assert.strictEqual(bcTimeMs('2026-06-08T02:00:00.000Z'), Date.parse('2026-06-08T02:00:00Z'));
  assert.ok(Number.isNaN(bcTimeMs(null)));
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4 · what the create handler accepts');

// The stored-form helper the handler shares with scheduled_for.
const BCSQLTIME_SRC = sliceBlock(RETAIL_JS, 'function bcSqlTime(');
const VALIDATE_SRC = sliceRange(RETAIL_JS,
  "  // expires_at: the other end of the window", '  const initialStatus =');

// The block as the handler runs it: `b` is the posted body, `startsAt` the
// moment the message goes out, and a rejection is a 400 with a code.
function validate(body, startsAt) {
  let rejected = null;
  const res = { status: (code) => ({ json: (j) => { rejected = { code, ...j }; } }) };
  const expiresAt = vm.runInNewContext(
    `${BCSQLTIME_SRC}
     (function (b, startsAt, res) {
       ${VALIDATE_SRC}
       return expiresAt;
     })(b, startsAt, res)`,
    { b: body, startsAt, res, Date, Number });
  return { expiresAt, rejected };
}

it('no end posted → no end stored', () => {
  const { expiresAt, rejected } = validate({}, Date.now());
  assert.strictEqual(expiresAt, null);
  assert.strictEqual(rejected, null);
});

it('an unparseable end is a 400, not a silent NULL', () => {
  const { rejected } = validate({ expires_at: 'next Tuesday-ish' }, Date.now());
  assert.strictEqual(rejected.code, 400);
  assert.strictEqual(rejected.error, 'bad_expires_at');
});

it('an end before the send time is refused — it would reach nobody', () => {
  const now = Date.now();
  const { rejected } = validate({ expires_at: new Date(now - HOUR).toISOString() }, now);
  assert.strictEqual(rejected.error, 'expires_before_send');
});

it('an end equal to the send time is refused too', () => {
  const now = Date.now();
  const { rejected } = validate({ expires_at: new Date(now).toISOString() }, now);
  assert.strictEqual(rejected.error, 'expires_before_send');
});

it('a scheduled broadcast is measured against its send time, not against now', () => {
  const sendsAt = Date.now() + 48 * HOUR;
  // 24h from now is in the future, but the message has not gone out by then.
  const early = validate({ expires_at: new Date(Date.now() + 24 * HOUR).toISOString() }, sendsAt);
  assert.strictEqual(early.rejected.error, 'expires_before_send');
  const ok = validate({ expires_at: new Date(sendsAt + HOUR).toISOString() }, sendsAt);
  assert.strictEqual(ok.rejected, null);
});

it('a valid end is stored in the form CURRENT_TIMESTAMP compares against', () => {
  const { expiresAt, rejected } = validate({ expires_at: '2099-06-08T02:00:00.000Z' }, Date.now());
  assert.strictEqual(rejected, null);
  assert.strictEqual(expiresAt, '2099-06-08 02:00:00');
  // And SQLite agrees on the ordering it will be filtered by.
  const db = freshDb();
  seedNotif(db, { expires_at: expiresAt });
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM retail_notifications WHERE expires_at > '2099-06-08 01:00:00'"
  ).get().n;
  assert.strictEqual(Number(n), 1);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n5 · the composer');

// The shipped file, loaded under enough of a DOM to define its functions. The
// inputs are real objects, so the helpers read values the way the page does.
function loadComposer(values) {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { value: values[id] || '', style: {}, textContent: '' }));
  for (const id of Object.keys(values)) el(id);
  const ctx = {
    console, Date, Math, JSON, isNaN, parseInt, setTimeout, clearTimeout,
    $: (sel) => els[String(sel).replace('#', '')] || null,
    cuT: (en) => en,                                  // assert on the EN half
    escapeHtml: (s) => String(s),
    // The REAL shared date formatter, not a stub. The composer used to build
    // dates from its own month table and now calls tdWhen (audit C-02), so the
    // sandbox has to supply it — and supplying the real one is what makes the
    // assertion below ("until Jun 8, 10:00") a test of the product's one date
    // shape rather than of a copy of it kept here.
    tdWhen: require(path.join(__dirname, '..', 'public', 'td-datetime.js')).tdWhen,
    tdFromShopLocal: require(path.join(__dirname, '..', 'public', 'td-datetime.js')).tdFromShopLocal,
    api: async () => ({ data: [] }),
    toast: () => {}, askConfirm: async () => false,
    document: {
      querySelector: () => ({ addEventListener: () => {}, scrollIntoView: () => {} }),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: { addEventListener: () => {} },
  };
  ctx.globalThis = ctx;
  // The file is one slice of a page that is assembled from several: its
  // top-level lines call helpers that live in the other slices (onDrawerClose,
  // 04-orders.js). Rather than stub each by name — a list that would go stale —
  // anything the sandbox doesn't hold resolves to a no-op, so the module loads
  // and its own functions are the real ones.
  // Language intrinsics (Set, Object, …) come from the host global, since the
  // trap below intercepts every lookup the contextified object would serve.
  const sandbox = vm.createContext(new Proxy(ctx, {
    has: () => true,
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in globalThis) return globalThis[k];
      return () => {};
    },
  }));
  vm.runInContext(MARKETING_JS, sandbox);
  return ctx;
}

it('a stored bare-UTC timestamp is shown in the operator’s zone', () => {
  const c = loadComposer({});
  const d = c.bxParseDate('2026-06-08 02:00:00');
  assert.strictEqual(d.getTime(), Date.parse('2026-06-08T02:00:00Z'),
    'reading it as local showed every stored time an offset early');
});

it('a datetime-local value is still read as local', () => {
  const c = loadComposer({});
  const d = c.bxParseDate('2026-06-08T10:00');
  assert.strictEqual(d.getTime(), new Date('2026-06-08T10:00').getTime(),
    'what the operator typed means what their clock says');
});

it('"never" sends no end at all', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'now', 'bc-expire-mode': 'never',
    'bc-expire-at': '2026-06-08T10:00' });
  assert.strictEqual(c.bxExpireMs(), null, 'the date input is ignored while the mode is never');
});

it('the end is measured from the send time, exactly as the server does', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'later', 'bc-schedule-at': '2026-06-08T10:00',
    'bc-expire-mode': 'at', 'bc-expire-at': '2026-06-08T09:00' });
  assert.strictEqual(c.bxStartMs(), new Date('2026-06-08T10:00').getTime());
  assert.ok(c.bxExpireMs() <= c.bxStartMs(),
    'this is the pair the composer refuses to send');
});

it('send-now measures from now', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'now', 'bc-schedule-at': '2026-06-08T10:00' });
  assert.ok(Math.abs(c.bxStartMs() - Date.now()) < 5000,
    'a leftover schedule time must not become the start of a send-now');
});

it('the When summary says where the broadcast ends', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'now', 'bc-expire-mode': 'at',
    'bc-expire-at': '2026-06-08T10:00' });
  // 12-hour in English is tdWhen's documented convention (Chinese renders
  // 24-hour); this asserted the composer's own retired 24-hour format. The
  // TIME is what matters and it is unchanged: 10:00 typed, 10:00 echoed.
  assert.match(c.bxUntilSuffix(), /until Jun 8, 10:00 AM/);
});

it('picking "on a date" without a date says so rather than reading as no end', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'now', 'bc-expire-mode': 'at', 'bc-expire-at': '' });
  assert.match(c.bxUntilSuffix(), /pick an end time/);
});

it('an uncapped broadcast reads exactly as it did before', () => {
  const c = loadComposer({ 'bc-schedule-mode': 'now', 'bc-expire-mode': 'never' });
  assert.strictEqual(c.bxUntilSuffix(), '');
});

it('a sent broadcast past its end reads "Ended", and offers no recall', () => {
  const c = loadComposer({});
  const row = c.bxFeedRow({ id: 3, title_en: 'Peanut butter', status: 'sent',
    sent_at: '2026-06-01 02:00:00', expires_at: '2026-06-08 02:00:00', recipient_count: 12 });
  assert.match(row, /Ended/);
  assert.ok(!/Recall/.test(row), 'nothing is left to pull back');
});

it('a sent broadcast still inside its window reads "Sent · until …" and can be recalled', () => {
  const c = loadComposer({});
  const row = c.bxFeedRow({ id: 3, title_en: 'Peanut butter', status: 'sent',
    sent_at: utc(-HOUR), expires_at: utc(+24 * HOUR), recipient_count: 12 });
  assert.match(row, /Sent/);
  assert.match(row, /until/);
  assert.match(row, /Recall/);
});

it('a broadcast with no end is untouched by any of this', () => {
  const c = loadComposer({});
  const row = c.bxFeedRow({ id: 3, title_en: 'Peanut butter', status: 'sent',
    sent_at: '2026-06-01 02:00:00', expires_at: null, recipient_count: 12 });
  assert.match(row, /Sent/);
  assert.ok(!/Ended|until/.test(row));
  assert.match(row, /Recall/);
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
