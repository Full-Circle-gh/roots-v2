#!/usr/bin/env node
/**
 * Handle threading, batch 1 (decisions §24, Path A step 2): `generateRetailSku`
 * and `writeLayout` take the handle.
 *
 *   node scripts/test_handle_threading_batch1.js
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS
 * --------------------------------------
 * This is the exact work a commit message (`d7515a36`) already falsely claimed
 * was finished, and §24's RECORD CORRECTION entry is the record of that claim
 * being wrong. So "the parameter is in the signature" is emphatically NOT the
 * bar here. **A parameter that is accepted and then ignored is not threaded**,
 * and a suite that only reads the signature would pass on exactly that.
 *
 * THE STANDARD USED INSTEAD — TWO DATABASES, AND THE WRITE HAS TO PICK ONE.
 * Every behavioural test below runs the helper with `tdb()` pointing at one
 * database and an explicit handle pointing at a DIFFERENT one. A helper that
 * truly uses its parameter touches the handle database and leaves the tdb()
 * database untouched; a helper that accepts the parameter and quietly writes
 * through tdb() anyway fails, because the row lands in the wrong database.
 * There is no way to pass these by adding a parameter alone.
 *
 * THE REAL FUNCTIONS ARE UNDER TEST, NOT COPIES OF THEM. The sibling conversion
 * suites reproduce each route body verbatim, because a route body is welded to
 * its handler. A standalone helper is not, so these two are EXTRACTED FROM
 * `routes/retail.js` AND EXECUTED — with `tdb` injected as a scope variable. A
 * reproduced copy could be threaded in the test while the shipped function was
 * not, which is the same class of mistake as trusting the commit message.
 *
 * `generateRetailSku` WRITES NOTHING, so the two-database rule is applied to its
 * READ: the collision probe. Seeding the collision into one database and not the
 * other makes its return value report which one it consulted.
 *
 * SOURCE-LEVEL ASSERTIONS RUN ON COMMENT-STRIPPED SOURCE. Twice now a comment
 * has answered for the code in this section (§24 records both). Every check
 * below that reads source text reads it with comments removed, so the words in
 * a comment can never satisfy an assertion about the code.
 *
 * NO LOCAL ALIAS MAY STAND AS EVIDENCE. `generateRetailSku` used to open with
 * `const t = tdb();`, which reads exactly like a threaded handle and is not one.
 * Test 8 asserts that neither helper reintroduces an alias of tdb() — passing
 * that check requires the parameter itself to be the receiver.
 *
 * TO PROVE THE SUITE CAN FAIL:  HT1_SABOTAGE=1 node scripts/test_handle_threading_batch1.js
 * Sabotage flips ONE headline assertion per helper — two in total, one each —
 * so a partial red is visible rather than passing for a full one.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, addForkedStoreProducts, driver } =
  require('./test-support/memory-db');

const SABOTAGE = process.env.HT1_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

// Every column these two helpers touch. Read off the SQL in the helpers, not off
// the schema — the point is to catch a harness table that has grown THINNER than
// the code, which is how conversion batch 2 was nearly green and wrong.
const WRITTEN_COLUMNS = {
  storefront_config: ['key', 'value_json', 'updated_at', 'updated_by'],
  store_products: ['sku'],
};

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Source handling ────────────────────────────────────────────────────────
// String-aware comment stripper, same shape as scripts/check-tenant-als.js. A
// regex stripper is comment-blind inside strings and would mangle the SQL.
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

const CODE = stripComments(RETAIL_SRC);

/**
 * Replace every string/template literal body with a harmless placeholder.
 *
 * Only used for COUNTING arguments. A template literal carrying `${…}` is one
 * argument however many commas hide inside it, so blanking the whole literal is
 * the correct reading — and it makes paren/comma balancing trivial and safe.
 */
function blankStrings(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c; out += '0'; i++;
      while (i < n && src[i] !== q) { i += src[i] === '\\' ? 2 : 1; }
      i++; continue;
    }
    if (c === '`') {
      out += '0'; i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth--; i++; continue; }
        if (depth === 0 && src[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** A top-level `function NAME(` … matching `}` at column 0, from stripped source. */
function extractFunction(name) {
  const re = new RegExp(`^function ${name}\\(`, 'm');
  const m = re.exec(CODE);
  if (!m) throw new Error(`function ${name} not found in routes/retail.js`);
  const end = CODE.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`unterminated function ${name}`);
  return CODE.slice(m.index, end + 2);
}

/**
 * Instantiate an extracted helper with `tdb` bound to a test-controlled lookup.
 *
 * This is what makes the two-database rule enforceable: the helper's idea of
 * "the ambient connection" is ours, so a write through tdb() is observable as a
 * write to the wrong database rather than invisible.
 */
function instantiate(name, tdbFn) {
  const src = extractFunction(name);
  return new Function('tdb', `${src}\nreturn ${name};`)(tdbFn);
}

/** Argument counts at every CALL of `name` — the definition itself excluded. */
function callArgCounts(name) {
  const flat = blankStrings(CODE);
  const out = [];
  const re = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(flat)) !== null) {
    const before = flat.slice(Math.max(0, m.index - 30), m.index + m[0].length);
    if (/function\s+$/.test(flat.slice(0, m.index + m[0].length - name.length - 1))) continue;
    if (/\bfunction\s+\w*\s*$/.test(before.slice(0, before.length - name.length - 1))) continue;
    let i = m.index + m[0].length - 1, depth = 0, start = i + 1;
    for (; i < flat.length; i++) {
      if (flat[i] === '(') depth++;
      else if (flat[i] === ')') { depth--; if (depth === 0) break; }
    }
    const inner = flat.slice(start, i);
    if (!inner.trim()) { out.push(0); continue; }
    let d = 0, count = 1;
    for (const ch of inner) {
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d--;
      else if (ch === ',' && d === 0) count++;
    }
    out.push(count);
  }
  return out;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
function newDb() {
  const db = openTablesDb(DB_SRC, ['storefront_config']);
  addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
  return db;
}

const LAYOUT_SQL = "SELECT key, value_json, updated_by FROM storefront_config WHERE key = ?";

async function main() {
  console.log('\nHandle threading batch 1 — generateRetailSku, writeLayout\n');

  // ── 1. The harness schema is not thinner than the code ───────────────────
  await it('the harness carries every column these helpers write', () => {
    const db = newDb();
    for (const [table, cols] of Object.entries(WRITTEN_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      for (const c of cols) {
        assert.ok(have.has(c), `${table}.${c} is missing from the harness-built schema`);
      }
    }
    // storefront_config is small enough to pin exactly: if it GAINS a column the
    // helper does not write, that is a real change worth failing on.
    const sc = db.prepare('PRAGMA table_info(storefront_config)').all().map(r => r.name).sort();
    assert.deepStrictEqual(sc, ['key', 'updated_at', 'updated_by', 'value_json'],
      'storefront_config has changed shape — writeLayout must be re-checked against it');
  });

  // ── 2. writeLayout writes through the PASSED handle ──────────────────────
  await it('HEADLINE writeLayout — the write lands in the passed handle, not tdb()', () => {
    const ambient = newDb(), handle = newDb();
    const writeLayout = instantiate('writeLayout', () => ambient);
    writeLayout('home.layout', '[{"t":"hero"}]', 7, handle);

    const inHandle = handle.prepare(LAYOUT_SQL).get('home.layout');
    const inAmbient = ambient.prepare(LAYOUT_SQL).get('home.layout');
    const expectHandle = SABOTAGE ? undefined : '[{"t":"hero"}]';
    assert.strictEqual(inHandle && inHandle.value_json, expectHandle,
      'the row did not land in the passed handle');
    assert.strictEqual(inAmbient, undefined,
      'the row ALSO landed in the tdb() database — the parameter is accepted but not used');
    assert.strictEqual(inHandle.updated_by, 7, 'updated_by did not survive the write');
  });

  // ── 3. The ON CONFLICT arm goes through the handle too ───────────────────
  await it('writeLayout — the upsert branch also runs on the passed handle', () => {
    const ambient = newDb(), handle = newDb();
    const writeLayout = instantiate('writeLayout', () => ambient);
    writeLayout('home.layout', '"first"', 1, handle);
    writeLayout('home.layout', '"second"', 2, handle);

    const row = handle.prepare(LAYOUT_SQL).get('home.layout');
    assert.strictEqual(row.value_json, '"second"', 'ON CONFLICT did not update through the handle');
    assert.strictEqual(row.updated_by, 2, 'updated_by was not refreshed by the conflict arm');
    const n = handle.prepare('SELECT COUNT(*) c FROM storefront_config').get().c;
    assert.strictEqual(n, 1, 'the upsert inserted a second row instead of updating');
    assert.strictEqual(ambient.prepare('SELECT COUNT(*) c FROM storefront_config').get().c, 0,
      'the tdb() database was touched');
  });

  // ── 4. Omitting the handle still works, and still resolves per call ──────
  await it('writeLayout — an existing caller that passes no handle still writes to tdb()', () => {
    const ambient = newDb(), unused = newDb();
    const writeLayout = instantiate('writeLayout', () => ambient);
    writeLayout('onboarding.version', '3', 5);
    const row = ambient.prepare(LAYOUT_SQL).get('onboarding.version');
    assert.strictEqual(row && row.value_json, '3', 'the default tdb() path stopped working');
    assert.strictEqual(unused.prepare('SELECT COUNT(*) c FROM storefront_config').get().c, 0);
  });

  await it('writeLayout — the default is evaluated PER CALL, not bound once', () => {
    // The tenant connection changes between requests. A default captured once
    // would send the second write to the first request's database.
    const first = newDb(), second = newDb();
    let current = first;
    const writeLayout = instantiate('writeLayout', () => current);
    writeLayout('a.layout', '"one"', 1);
    current = second;
    writeLayout('b.layout', '"two"', 2);

    assert.ok(first.prepare(LAYOUT_SQL).get('a.layout'), 'the first write missed the first database');
    assert.strictEqual(first.prepare(LAYOUT_SQL).get('b.layout'), undefined,
      'the second write landed in the FIRST database — the default was captured, not re-evaluated');
    assert.ok(second.prepare(LAYOUT_SQL).get('b.layout'), 'the second write missed the second database');
  });

  // ── 5-7. generateRetailSku reads through the handle ──────────────────────
  // It writes nothing, so the handle has to be proven on the READ. Math.random
  // is pinned so the candidate code is deterministic and a collision can be
  // planted in exactly one of the two databases.
  function withPinnedRandom(fn) {
    const real = Math.random;
    // Chosen so the base-36 expansion is long enough to yield a full five-char
    // tail. Pinning to 0 gives `DRAFT-` with an EMPTY tail, which is not a code
    // the helper would ever really produce and would prove nothing about a
    // realistic collision.
    Math.random = () => 0.123456789;
    try { return fn(); } finally { Math.random = real; }
  }
  // Derived by running the helper's own expression, not asserted from memory.
  const CANDIDATE = withPinnedRandom(() =>
    'DRAFT-' + Math.random().toString(36).slice(2, 7).toUpperCase());
  assert.strictEqual(CANDIDATE.length, 11, 'the pinned candidate is not a full DRAFT-XXXXX code');

  // store_products is the real 78-column fork, and `name_en` is NOT NULL with no
  // default — so a seed row must carry it. A thinner hand-written table would
  // have accepted `(sku)` alone and hidden that.
  const seedSku = (db, sku) =>
    db.prepare('INSERT INTO store_products (sku, name_en) VALUES (?, ?)').run(sku, 'seed');

  await it('HEADLINE generateRetailSku — the collision probe reads the passed handle', () => {
    const ambient = newDb(), handle = newDb();
    seedSku(handle, CANDIDATE);                // taken in the HANDLE only
    const generateRetailSku = instantiate('generateRetailSku', () => ambient);
    const got = withPinnedRandom(() => generateRetailSku(handle));
    const collided = SABOTAGE ? got === CANDIDATE : got !== CANDIDATE;
    assert.ok(collided,
      'it returned the taken code — it never saw the handle database\'s collision');
    assert.ok(/^DRAFT-/.test(got), 'the fallback lost the DRAFT- prefix');
  });

  await it('generateRetailSku — it does NOT read tdb() when a handle is passed', () => {
    const ambient = newDb(), handle = newDb();
    seedSku(ambient, CANDIDATE);               // taken in tdb()'s database ONLY
    const generateRetailSku = instantiate('generateRetailSku', () => ambient);
    const got = withPinnedRandom(() => generateRetailSku(handle));
    assert.strictEqual(got, CANDIDATE,
      'it avoided a code that is only taken in the tdb() database — it read tdb(), not the handle');
  });

  await it('generateRetailSku — an existing caller that passes no handle reads tdb()', () => {
    const ambient = newDb();
    seedSku(ambient, CANDIDATE);
    const generateRetailSku = instantiate('generateRetailSku', () => ambient);
    const got = withPinnedRandom(() => generateRetailSku());
    assert.notStrictEqual(got, CANDIDATE, 'the default tdb() path stopped consulting tdb()');
  });

  // ── 8. No alias, and no tdb() left inside either body ────────────────────
  await it('neither helper reaches tdb() anywhere except its own parameter default', () => {
    for (const name of ['writeLayout', 'generateRetailSku']) {
      const src = extractFunction(name);                 // comments already gone
      const header = src.slice(0, src.indexOf('{'));
      const body = src.slice(src.indexOf('{'));
      assert.ok(/=\s*tdb\(\)/.test(header), `${name}'s signature has no tdb() default`);
      assert.ok(!/tdb\(\)/.test(body),
        `${name} still calls tdb() in its body — the parameter is not the only source of the handle`);
      assert.ok(!/\b(const|let|var)\s+\w+\s*=\s*tdb\(\)/.test(src),
        `${name} keeps a local alias of tdb() — an alias reads like a threaded handle and is not one`);
    }
  });

  await it('every write/read statement in both helpers is prepared on the parameter', () => {
    for (const [name, param] of [['writeLayout', 'h'], ['generateRetailSku', 'h']]) {
      const body = extractFunction(name);
      const preps = [...body.matchAll(/(\w+(?:\(\))?)\s*\.prepare\s*\(/g)].map(m => m[1]);
      assert.ok(preps.length > 0, `${name} prepares nothing — the extraction is wrong`);
      for (const recv of preps) {
        assert.strictEqual(recv, param,
          `${name} prepares on \`${recv}\`, not on the handle parameter \`${param}\``);
      }
    }
  });

  // ── 9. Existing call sites are untouched ─────────────────────────────────
  await it('all nine writeLayout call sites still pass three arguments', () => {
    const counts = callArgCounts('writeLayout');
    assert.strictEqual(counts.length, 9, `expected 9 writeLayout call sites, found ${counts.length}`);
    assert.deepStrictEqual([...new Set(counts)], [3],
      `a writeLayout call site changed arity: ${counts.join(', ')}`);
  });

  await it('both generateRetailSku call sites still pass no arguments', () => {
    const counts = callArgCounts('generateRetailSku');
    assert.strictEqual(counts.length, 2, `expected 2 generateRetailSku call sites, found ${counts.length}`);
    assert.deepStrictEqual([...new Set(counts)], [0],
      `a generateRetailSku call site changed arity: ${counts.join(', ')}`);
  });

  // ── 10. The two helpers this batch must NOT have touched ─────────────────
  await it('reconcileTier and createOrReuseManualCustomer are untouched — out of scope', () => {
    assert.ok(/^function reconcileTier\(customerId, spend, storedTier\) \{$/m.test(CODE),
      'reconcileTier changed shape — it is money-adjacent and out of this batch');
    // createOrReuseManualCustomer HAS NOW TRAVELLED, and this assertion is
    // updated rather than deleted. It said the helper must not move until its
    // route was classified; the route was classified and converted, so the
    // pin moves to the threaded signature instead of disappearing. Its own
    // suite is scripts/test_handle_threading_manual_customer.js.
    assert.ok(/^function createOrReuseManualCustomer\(\{ nickname, email, phone, userId \}, h = tdb\(\)\) \{$/m.test(CODE),
      'createOrReuseManualCustomer changed shape — it is threaded now; see test_handle_threading_manual_customer.js');
  });

  console.log('');
  console.log(`  driver: ${driver}`);
  console.log(`  pinned candidate SKU: ${CANDIDATE}`);
  if (SABOTAGE) {
    console.log(`  sabotage: ${fail} of the 2 per-helper headline assertions failed`);
    console.log('  (fewer than 2 means a helper is NOT covered by a red-provable check)');
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
