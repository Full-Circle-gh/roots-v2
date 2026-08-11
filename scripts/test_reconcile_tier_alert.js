#!/usr/bin/env node
/**
 * reconcileTier — the failure path, manufactured.
 *
 * WHY THIS SUITE EXISTS AND WHY IT HAS TO FAKE THE FAILURE
 * -------------------------------------------------------
 * `reconcileTier`'s catch has never executed in production: zero occurrences
 * across `roots-v2-error.log`, which was born 2026-05-11 and records 1,091
 * application boots. There is no natural failure to observe, so every test here
 * manufactures one by making the tier UPDATE — and only that statement — throw.
 *
 * That is also why the catch could rot unnoticed: a branch nothing reaches is a
 * branch nothing checks.
 *
 * WHAT IS BEING PROVEN, in the order it matters:
 *   1. The enclosing money transaction still COMMITS. This is the whole design
 *      decision — letting it throw would roll back awardOrderPoints and lose the
 *      order's points and lifetime_spend with nothing to retry it.
 *   2. The failure NAMES ITS VICTIM. The old line was
 *      `console.warn('[reconcileTier]', e.message)` and identified no customer,
 *      so an occurrence could not be attributed and therefore not repaired.
 *   3. The alert cannot mask the log. A throwing or rejecting sendOpsAlert must
 *      leave the console.error already written and the return value intact.
 *      This is the case most likely to be got wrong, so it is tested in BOTH
 *      shapes — a synchronous throw and a rejected promise.
 *   4. Log first, alert second, asserted against the source rather than trusted.
 *   5. The alert text carries NO customer id. That is a FLOOD GUARD, not a
 *      cosmetic choice — see the note on test 7.
 *
 * SIGNATURE COVERAGE IS DELIBERATELY NOT DUPLICATED HERE.
 * `scripts/test_handle_threading_batch1.js` and `_batch2.js` both already assert
 * `^function reconcileTier\(customerId, spend, storedTier\) \{$` against the
 * comment-stripped source. Verified by mutation on 2026-08-11: adding a fourth
 * parameter turns batch 1 red on 1 of 13 and batch 2 red on 1 of 19, both on
 * that named assertion. A third copy would add drift, not coverage.
 *
 * The REAL function is under test — extracted from `routes/retail.js` and
 * executed with its dependencies injected — never a reproduction. A copy can be
 * fixed in the test while the shipped function is not.
 *
 * Offline. No network, no install, no production database.
 *   node scripts/test_reconcile_tier_alert.js
 *   RT_SABOTAGE=1 node scripts/test_reconcile_tier_alert.js   (expect RED)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const SABOTAGE = process.env.RT_SABOTAGE === '1';

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling — the same string-aware stripper as the batch suites ────
// Required before ANY source-level assertion: twice in this section a comment
// has answered for the code, and test 8 below matches on `console.warn`, a
// string that appears in this file's own commentary.
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

// SABOTAGE returns reconcileTier EXACTLY as it shipped before 2026-08-11 — a
// console.warn naming nobody, and no alert at all. Every assertion that is about
// this change must go red against it; one that stays green is testing nothing.
//
// This branch is a verbatim reproduction of the OLD code, and that is correct
// here precisely because it is the code that no longer exists to be extracted.
// The NORMAL branch below extracts the REAL function from routes/retail.js and
// is what every green run tests — the reproduction is never the subject.
//
// Written as whole lines rather than as a splice into the live source: the
// working tree is checked out with CRLF (core.autocrlf=true, 30,229 CRLF pairs
// in routes/retail.js and zero bare LF), so any anchor containing "\n" silently
// fails to match. An earlier version of this function did exactly that and made
// all ten tests fail with "could not find the catch to revert" — ten red lines
// that proved nothing, which is the same false-confidence shape this suite
// exists to prevent.
const OLD_RECONCILE_TIER = [
  'function reconcileTier(customerId, spend, storedTier) {',
  '  const want = tierFromSpend(spend);',
  '  if (want !== storedTier) {',
  '    try {',
  "      tdb().prepare('UPDATE retail_customers SET tier_key = ? WHERE id = ?').run(want, customerId);",
  "    } catch (e) { console.warn('[reconcileTier]', e.message); }",
  '  }',
  '  return want;',
  '}',
].join('\n');

function reconcileSource() {
  if (SABOTAGE) return OLD_RECONCILE_TIER;
  const src = extractFunction(RETAIL, 'reconcileTier');
  // Guard against the extractor silently returning something inert: a normal
  // run must be testing the shipped function, not an empty shell.
  if (!/tdb\(\)\.prepare/.test(src)) throw new Error('extracted reconcileTier does not contain its UPDATE — extractor broken');
  return src;
}

function instantiate(scope) {
  const keys = Object.keys(scope);
  return new Function(...keys, `${reconcileSource()}\nreturn reconcileTier;`)(...keys.map(k => scope[k]));
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const TABLES = ['retail_customers', 'retail_points_transactions', 'storefront_config'];

function ensureTransactionMethod(db) {
  if (typeof db.transaction === 'function') return db;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
  return db;
}
function newDb() { return ensureTransactionMethod(openTablesDb(DB_SRC, TABLES)); }

const TIER_UPDATE = 'UPDATE retail_customers SET tier_key = ? WHERE id = ?';

/**
 * A handle that behaves exactly like the real one EXCEPT that the tier UPDATE
 * throws — the shape a dropped/renamed column would produce after a bad
 * migration. Everything else in the enclosing transaction must still work, or
 * the test would be proving something easier than the real case.
 */
function handleWithFailingTierUpdate(db, message) {
  return {
    prepare(sql) {
      if (sql === TIER_UPDATE) {
        return { run() { throw new Error(message); } };
      }
      return db.prepare(sql);
    },
    exec: (...a) => db.exec(...a),
    transaction: (...a) => db.transaction(...a),
  };
}

/** Collects console output instead of printing it, and shadows the global. */
function fakeConsole() {
  const errors = [], warns = [];
  return { errors, warns, error: (...a) => errors.push(a.join(' ')), warn: (...a) => warns.push(a.join(' ')) };
}

// `openid` is NOT NULL with no default in the real schema, and `balance_after`
// is on the ledger row. Both were discovered by the fixture failing against the
// REAL table rather than a thinned one — the same class §24 records twice, where
// a harness table grown thinner than the code made a suite green and wrong. The
// fixture is fixed here; the table is not.
function seedCustomer(db, { id = 1, spend = 0, tier = 'seed' } = {}) {
  db.prepare('INSERT INTO retail_customers (id, openid, lifetime_spend, tier_key) VALUES (?, ?, ?, ?)')
    .run(id, `openid-test-${id}`, spend, tier);
}

// A ladder matching the shipped defaults, so `want` is predictable.
const tierFromSpend = (s) => {
  const v = Math.max(0, Number(s) || 0);
  if (v >= 10000) return 'tree';
  if (v >= 6000) return 'root';
  if (v >= 4000) return 'sprout';
  return 'seed';
};

/** Build the function under test plus the spies around it. */
function build({ alertImpl } = {}) {
  const db = newDb();
  const con = fakeConsole();
  const alerts = [];
  const sendOpsAlert = (text) => {
    alerts.push(text);
    if (alertImpl) return alertImpl(text);
    return Promise.resolve(true);
  };
  const tdbHandle = handleWithFailingTierUpdate(db, 'no such column: tier_key');
  const fn = instantiate({ tierFromSpend, tdb: () => tdbHandle, sendOpsAlert, console: con });
  return { db, con, alerts, fn, tdbHandle };
}

(async () => {
  console.log(`\nreconcileTier — manufactured failure path  (driver: ${driver})${SABOTAGE ? '   [SABOTAGE ON — expect RED]' : ''}\n`);

  // ── 1. The design decision itself ────────────────────────────────────────
  await it('the tier UPDATE fails and the ENCLOSING TRANSACTION STILL COMMITS', () => {
    const { db, fn } = build();
    seedCustomer(db, { id: 7, spend: 0, tier: 'seed' });
    // The shape of awardOrderPoints: spend + points first, reconcile, then the
    // ledger row that is the idempotency marker.
    const tx = db.transaction(() => {
      db.prepare('UPDATE retail_customers SET lifetime_spend = ? WHERE id = ?').run(6500, 7);
      fn(7, 6500, 'seed');
      db.prepare("INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source) VALUES (?, ?, ?, 'order_earn')").run(7, 12, 12);
    });
    tx();   // must NOT throw
    const c = db.prepare('SELECT lifetime_spend, tier_key FROM retail_customers WHERE id = 7').get();
    assert.strictEqual(Number(c.lifetime_spend), 6500, 'lifetime_spend was rolled back — the whole point was that it must not be');
    const led = db.prepare("SELECT COUNT(*) n FROM retail_points_transactions WHERE customer_id = 7").get();
    assert.strictEqual(Number(led.n), 1, 'the points ledger row was rolled back');
    assert.strictEqual(c.tier_key, 'seed', 'tier_key should be STALE — that is the accepted cost');
  });

  await it('reconcileTier still RETURNS the derived tier after the failure', () => {
    const { db, fn } = build();
    seedCustomer(db, { id: 8, spend: 0, tier: 'seed' });
    assert.strictEqual(fn(8, 6500, 'seed'), 'root', 'callers use the return value; it must be the derived tier');
    assert.strictEqual(fn(8, 12000, 'seed'), 'tree');
  });

  // ── 2. Attributability — the defect that mattered ────────────────────────
  await it('the error line NAMES THE CUSTOMER, both tiers, and the driver message', () => {
    const { db, con, fn } = build();
    seedCustomer(db, { id: 4242, spend: 0, tier: 'seed' });
    fn(4242, 6500, 'seed');
    assert.strictEqual(con.errors.length, 1, `expected exactly 1 console.error, got ${con.errors.length}`);
    const line = con.errors[0];
    assert.ok(/\[reconcileTier\]/.test(line), 'line is not tagged [reconcileTier]');
    assert.ok(/customer=4242/.test(line), `the line does not name the customer: ${line}`);
    assert.ok(/want=root/.test(line), `the line does not carry the intended tier: ${line}`);
    assert.ok(/stored=seed/.test(line), `the line does not carry the stored tier: ${line}`);
    assert.ok(/no such column: tier_key/.test(line), `the line dropped the driver message: ${line}`);
  });

  await it('nothing is logged and no alert fires when the tier is already correct', () => {
    const { db, con, alerts, fn } = build();
    seedCustomer(db, { id: 9, spend: 6500, tier: 'root' });
    assert.strictEqual(fn(9, 6500, 'root'), 'root');
    assert.strictEqual(con.errors.length, 0, 'a no-op reconcile must not log');
    assert.strictEqual(alerts.length, 0, 'a no-op reconcile must not alert');
  });

  // ── 3. The alert ─────────────────────────────────────────────────────────
  await it('sendOpsAlert is called EXACTLY ONCE per failure', () => {
    const { db, alerts, fn } = build();
    seedCustomer(db, { id: 10, spend: 0, tier: 'seed' });
    fn(10, 6500, 'seed');
    assert.strictEqual(alerts.length, 1, `expected 1 alert, got ${alerts.length}`);
  });

  await it('the alert text carries NO customer id — the flood guard', () => {
    const { db, alerts, fn } = build();
    seedCustomer(db, { id: 987654, spend: 0, tier: 'seed' });
    fn(987654, 6500, 'seed');
    assert.strictEqual(alerts.length, 1);
    assert.ok(!/987654/.test(alerts[0]),
      'the alert names the customer — that defeats ops-alert\'s 60s exact-text dedup, and this runs on EVERY '
      + 'authenticated request, so a broken column would page the WeCom group once per request');
    assert.ok(/reconcileTier/.test(alerts[0]), 'the alert must point the reader at the log lines that DO name customers');
  });

  // ── 4. Masking — the case most likely to be got wrong ────────────────────
  await it('a SYNCHRONOUSLY THROWING sendOpsAlert cannot mask the error or the return', () => {
    const { db, con, fn } = build({ alertImpl: () => { throw new Error('webhook module exploded'); } });
    seedCustomer(db, { id: 11, spend: 0, tier: 'seed' });
    let ret;
    assert.doesNotThrow(() => { ret = fn(11, 6500, 'seed'); }, 'a failing alert must not escape reconcileTier');
    assert.strictEqual(ret, 'root', 'the return value was lost to the alert failure');
    assert.strictEqual(con.errors.length, 1, 'the console.error must already have happened BEFORE the alert ran');
    assert.ok(/customer=11/.test(con.errors[0]), 'the attributable line was replaced by the alert failure');
    assert.ok(con.warns.some(w => /ops alert failed/.test(w)), 'the alert failure should still be noted, at warn level');
  });

  await it('a REJECTING sendOpsAlert cannot mask the error, and leaves no unhandled rejection', async () => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { db, con, fn } = build({ alertImpl: () => Promise.reject(new Error('webhook 500')) });
      seedCustomer(db, { id: 12, spend: 0, tier: 'seed' });
      let ret;
      assert.doesNotThrow(() => { ret = fn(12, 6500, 'seed'); });
      assert.strictEqual(ret, 'root');
      assert.strictEqual(con.errors.length, 1, 'the console.error must survive a rejected alert');
      assert.ok(/customer=12/.test(con.errors[0]));
      // Let the rejection settle — an unattached .catch would surface here.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      assert.strictEqual(seen.length, 0,
        'the alert promise rejected with no .catch attached — in production that is a process-level unhandledRejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // ── 5. Order, asserted against the source ────────────────────────────────
  await it('LOG FIRST, ALERT SECOND — asserted on comment-stripped source, not trusted', () => {
    const src = reconcileSource();
    const iErr = src.indexOf('console.error');
    const iAlert = src.indexOf('sendOpsAlert');
    assert.ok(iErr !== -1, 'no console.error in reconcileTier — the durable record is missing');
    assert.ok(iAlert !== -1, 'no sendOpsAlert in reconcileTier');
    assert.ok(iErr < iAlert,
      'the alert runs before the log: the unreliable network call must never precede the durable local record');
  });

  await it('the old bare console.warn handler is gone from the catch', () => {
    const src = reconcileSource();
    assert.ok(!/console\.warn\('\[reconcileTier\]', e\.message\)/.test(src),
      'the original un-attributable handler is still present');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
