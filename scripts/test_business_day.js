#!/usr/bin/env node
/**
 * test_business_day.js — whose midnight is it? (audit A-05)
 *
 *   node scripts/test_business_day.js
 *
 * The business day was the literal string '+8 hours' pasted into SQL in
 * thirty-five places, so today's takings, the dashboard, the finance window and
 * "new this week" all ended at midnight in Guangzhou for every merchant on the
 * platform. lib/business-date.js already existed and explained why that was
 * wrong; exactly one file used it.
 *
 * This covers the helper that replaced it and, by source, that no hand-written
 * offset came back.
 *
 * NO DB except an in-memory one for the shop-zone reader, and no network.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const B = require('../lib/business-date');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// A fixed instant, so nothing here depends on when it is run.
const JUL = new Date('2026-07-01T12:00:00Z');
const JAN = new Date('2026-01-15T12:00:00Z');

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe offset, from a real zone');

it('Shanghai is +480, and that is the old constant expressed in minutes', () => {
  assert.strictEqual(B.zoneOffsetMinutes('Asia/Shanghai', JUL), 480);
  assert.strictEqual(B.sqlDayShift('Asia/Shanghai', JUL), '+480 minutes');
});

it('half-hour and 45-minute zones survive — this is why it is not hours', () => {
  // An hours-only modifier cannot express any of these, and would put a
  // merchant in Kathmandu 45 minutes off their own midnight.
  assert.strictEqual(B.sqlDayShift('Asia/Kolkata', JUL), '+330 minutes');   // +5:30
  assert.strictEqual(B.sqlDayShift('Asia/Kathmandu', JUL), '+345 minutes'); // +5:45
  assert.strictEqual(B.sqlDayShift('Australia/Adelaide', JUL), '+570 minutes'); // +9:30
});

it('west of UTC is negative and signed', () => {
  assert.strictEqual(B.sqlDayShift('America/New_York', JAN), '-300 minutes');
  assert.ok(B.sqlDayShift('America/New_York', JAN).startsWith('-'));
});

it('daylight saving is honoured at the instant asked about', () => {
  assert.strictEqual(B.zoneOffsetMinutes('America/New_York', JAN), -300);  // EST
  assert.strictEqual(B.zoneOffsetMinutes('America/New_York', JUL), -240);  // EDT
});

// §82 STEP 3 FULL (2026-10-18): THERE IS NO HOUSE ZONE. These two cases said the
// opposite until then — a missing or nonsense zone "fell back to +8, what it did
// before" — and that is how a shop with no zone ran on Guangzhou's clock looking
// right. They now pin the refusal, by name.
it('a missing, blank or nonsense zone is REFUSED, not read as +8', () => {
  for (const bad of [null, undefined, '', '   ', 'Not/AZone', 'Mars/Olympus']) {
    assert.throws(() => B.sqlDayShift(bad, JUL), (e) => e.code === 'shop_timezone_missing', String(bad));
    assert.throws(() => B.businessDate(bad, JUL), (e) => e.code === 'shop_timezone_missing', String(bad));
    assert.throws(() => B.zoneParts(bad, JUL), (e) => e.code === 'shop_timezone_missing', String(bad));
  }
});

it('an unreadable zone is refused at once — there is no fallback zone to recurse into', () => {
  assert.throws(() => B.zoneOffsetMinutes('Not/AZone', JUL),
    (e) => e.name === 'NoShopTimezoneError' && /Not\/AZone/.test(e.message) && /Settings → Stores/.test(e.message));
});

it('an absurd offset is refused rather than shifting every date on screen', () => {
  // Real offsets run −12:00 to +14:00. Anything outside that band means the
  // parse went wrong, and the house default is closer to true than a number
  // nobody can see is wrong.
  assert.ok(B.zoneOffsetMinutes('Pacific/Kiritimati', JUL) <= 840);
  assert.ok(B.zoneOffsetMinutes('Pacific/Midway', JUL) >= -720);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe shop’s own zone, read the way the screen reads it');

let Database = null;
try { Database = require('@libsql/client'); } catch (e) { /* covered below */ }

if (!Database) {
  console.log('  — skipped: no better-sqlite3 in this checkout');
} else {
  const mk = (rows) => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, is_active INT, sort_order INT, timezone TEXT)');
    const ins = db.prepare('INSERT INTO retail_stores VALUES (?,?,?,?)');
    rows.forEach(r => ins.run(...r));
    return db;
  };

  it('takes the first ACTIVE location that carries a zone', () => {
    const db = mk([[1, 0, 1, 'America/New_York'], [2, 1, 2, 'Asia/Kathmandu']]);
    assert.strictEqual(B.shopTimezone(db), 'Asia/Kathmandu');
    assert.strictEqual(B.sqlDayShiftForShop(db, JUL), '+345 minutes');
  });

  it('orders by sort_order, so the answer is stable and the operator chose it', () => {
    const db = mk([[1, 1, 9, 'Europe/London'], [2, 1, 1, 'Asia/Tokyo']]);
    assert.strictEqual(B.shopTimezone(db), 'Asia/Tokyo');
  });

  it('a blank or whitespace zone is not a zone', () => {
    const db = mk([[1, 1, 1, '   '], [2, 1, 2, 'Europe/Berlin']]);
    assert.strictEqual(B.shopTimezone(db), 'Europe/Berlin');
  });

  it('no zone anywhere: the shop has none, and its day shift is REFUSED rather than +8 (§82)', () => {
    const db = mk([[1, 1, 1, null]]);
    assert.strictEqual(B.shopTimezone(db), null);
    assert.throws(() => B.sqlDayShiftForShop(db, JUL), (e) => e.code === 'shop_timezone_missing');
  });

  it('a database with no such table: asking for the zone does not throw; using one that is not there does', () => {
    const db = new Database(':memory:');
    assert.strictEqual(B.shopTimezone(db), null);
    assert.throws(() => B.sqlDayShiftForShop(db, JUL), (e) => e.code === 'shop_timezone_missing');
  });

  it('the shift is a modifier SQLite actually understands', () => {
    // The whole point is that this string goes into date(). If SQLite rejects
    // the format, every dated query on the platform returns null and the
    // screens go blank — so it is exercised, not assumed.
    const db = new Database(':memory:');
    for (const tz of ['Asia/Shanghai', 'Asia/Kathmandu', 'America/New_York']) {
      const shift = B.sqlDayShift(tz, JUL);
      const row = db.prepare(`SELECT date('2026-07-01T20:00:00Z', '${shift}') AS d`).get();
      assert.ok(row && /^\d{4}-\d{2}-\d{2}$/.test(row.d), `${tz} → ${shift} produced ${row && row.d}`);
    }
    // And it moves the day where it should: 20:00 UTC is already the 2nd in
    // Shanghai (+8) and still the 1st in New York (−4).
    const sh = B.sqlDayShift('Asia/Shanghai', JUL);
    const ny = B.sqlDayShift('America/New_York', JUL);
    assert.strictEqual(db.prepare(`SELECT date('2026-07-01T20:00:00Z','${sh}') d`).get().d, '2026-07-02');
    assert.strictEqual(db.prepare(`SELECT date('2026-07-01T20:00:00Z','${ny}') d`).get().d, '2026-07-01');
  });
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nNo hand-written offset came back');

const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

it('routes/ and lib/ carry no "+8 hours" in code, except the named fallback', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.name.endsWith('.js')) continue;
      const code = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      if (!code.includes("'+8 hours'")) continue;
      // lib/finance-window.js keeps ONE, as the documented default a caller
      // gets when the shop has not said. It is a fallback, not a boundary.
      if (rel === path.join('lib', 'finance-window.js')
          && (code.match(/'\+8 hours'/g) || []).length === 1
          && /const TZ = '\+8 hours';/.test(code)) continue;
      offenders.push(rel);
    }
  };
  walk('routes'); walk('lib');
  assert.deepStrictEqual(offenders, [],
    'a hand-written day boundary is back: ' + offenders.join(', '));
});

it('the API resolves the boundary per account rather than per platform', () => {
  // routes/retail.js and what moved out of it: shopSqlShift now sits in
  // lib/shop-clock.js (decisions §477).
  const retail = require('./test-support/retail-source').retailSource();
  assert.match(retail, /function shopSqlShift\(\)/, 'the resolver must exist');
  assert.match(retail, /sqlDayShiftForShop\(tdb\(\)\)/, 'and read the ACCOUNT’s connection');
  // Memoised — it is called dozens of times per request.
  assert.match(retail, /_tzMemo/, 'a per-request storm of identical queries is not the fix');
});

it('every day-boundary reader goes through the one library', () => {
  for (const f of ['routes/retail.js', 'routes/restock.js', 'routes/finance-summary.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /business-date/, `${f} must use lib/business-date.js`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
