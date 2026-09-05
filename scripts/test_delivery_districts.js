#!/usr/bin/env node
/**
 * test_delivery_districts.js — whose city is it? (audit D-10)
 *
 *   node scripts/test_delivery_districts.js
 *
 * Same-city delivery, the dispatch-method choice and the stock routing were
 * expressed in named Guangzhou districts. The dispatch-method rule was the last
 * one still hard-coded: a set of six district names behind a hard-coded "is this
 * Guangzhou?" gate, so a merchant anywhere else could never offer the choice at
 * all — the function returned false on the city test before it ever looked at a
 * district.
 *
 * The REAL function is lifted out of routes/retail.js and run here, with tdb()
 * and isGuangzhou stubbed, because requiring that file pulls in the whole
 * database. Same split as scripts/test_signin_code_delivery.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Lift the real thing ────────────────────────────────────────────────────
function lift(name) {
  const at = SRC.search(new RegExp(`\\n(?:const|function) ${name}\\b`));
  assert.ok(at >= 0, `not found in routes/retail.js: ${name}`);
  // A const arrow ends at its line; a function ends at a column-0 brace.
  if (/\nconst /.test(SRC.slice(at, at + 8))) {
    const nl = SRC.indexOf('\n', at + 1);
    return SRC.slice(at + 1, nl + 1);
  }
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(at + 1, i + 1);
}

/** A sandbox whose storefront_config holds `rows` (or none at all). */
function withConfig(rows) {
  const ctx = {
    console: { warn() {}, error() {} },
    // Only the config read is stubbed; the predicate itself is the shipped one.
    tdb: () => ({
      prepare: () => ({ get: (key) => (rows && key in rows) ? { value_json: rows[key] } : undefined }),
    }),
    isGuangzhou: (c) => /广州|guangzhou/i.test(String(c || '')),
  };
  vm.createContext(ctx);
  vm.runInContext(
    [
      "const METHOD_CHOICE_CFG = 'delivery.methodChoiceDistricts';",
      lift('GZ_METHOD_TOGGLE_DISTRICTS'),
      lift('normDistrict'),
      lift('methodChoiceDistricts'),
      lift('gzMethodToggleAllowed'),
    ].join('\n'), ctx);
  return ctx;
}

const KEY = 'delivery.methodChoiceDistricts';
const NONE = withConfig(null);

// ─────────────────────────────────────────────────────────────────────────
console.log('\nUnconfigured — the rule this account has always had');

it('an outer Guangzhou district may choose the method', () => {
  for (const d of ['花都区', '番禺区', '南沙区', '从化区', '增城区', '白云区']) {
    assert.strictEqual(NONE.gzMethodToggleAllowed({ city: '广州市', district: d }), true, d);
  }
});

it('a central Guangzhou district stays rider-only', () => {
  for (const d of ['天河区', '越秀区', '海珠区', '荔湾区', '黄埔区']) {
    assert.strictEqual(NONE.gzMethodToggleAllowed({ city: '广州市', district: d }), false, d);
  }
});

it('the trailing 区 is optional, as it always was', () => {
  assert.strictEqual(NONE.gzMethodToggleAllowed({ city: '广州市', district: '白云' }), true);
});

it('no address, no district, no choice', () => {
  assert.strictEqual(NONE.gzMethodToggleAllowed(null), false);
  assert.strictEqual(NONE.gzMethodToggleAllowed({ city: '广州市' }), false);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe finding itself — a merchant somewhere else');

it('BEFORE: a Shenzhen merchant could never offer the choice', () => {
  // The city gate ran before the district was even read. This is the defect,
  // asserted so the fix below has something to be a fix OF.
  assert.strictEqual(NONE.gzMethodToggleAllowed({ city: '深圳市', district: '南山区' }), false);
});

it('AFTER: a merchant who names their own districts is taken at their word', () => {
  const ctx = withConfig({ [KEY]: JSON.stringify(['南山区', '福田区']) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '深圳市', district: '南山区' }), true);
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '深圳市', district: '罗湖区' }), false);
});

it('a configured list replaces the Guangzhou default — it does not add to it', () => {
  // Otherwise a merchant who listed their own districts would still be quietly
  // running somebody else's city's rule alongside their own.
  const ctx = withConfig({ [KEY]: JSON.stringify(['南山区']) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '广州市', district: '花都区' }), false);
});

it('the city gate does not apply once a merchant has said where', () => {
  const ctx = withConfig({ [KEY]: JSON.stringify(['Camden']) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: 'London', district: 'Camden' }), true);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe edges that decide real dispatches');

it('an EMPTY list is a decision — "nowhere", not "unset"', () => {
  // Turning a rule off must not silently turn the old one back on.
  const ctx = withConfig({ [KEY]: JSON.stringify([]) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '广州市', district: '花都区' }), false);
});

it('spelling is forgiving in both directions', () => {
  const ctx = withConfig({ [KEY]: JSON.stringify(['白云区', 'Baiyun']) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: 'x', district: '白云' }), true);
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: 'x', district: 'baiyun' }), true);
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: 'x', district: '  白云区 ' }), true);
});

it('a malformed config row falls back rather than deciding dispatch', () => {
  for (const junk of ['not json', '{"a":1}', 'null', '"南山区"']) {
    const ctx = withConfig({ [KEY]: junk });
    // Back to the old rule: Guangzhou yes, elsewhere no.
    assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '广州市', district: '花都区' }), true, junk);
    assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '深圳市', district: '南山区' }), false, junk);
  }
});

it('a blank entry in the list does not match a blank district', () => {
  // ['', '南山区'] must not make every address with no district eligible.
  const ctx = withConfig({ [KEY]: JSON.stringify(['', '南山区']) });
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '深圳市', district: '' }), false);
  assert.strictEqual(ctx.gzMethodToggleAllowed({ city: '深圳市', district: '南山区' }), true);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe sibling rule was already data — this one now matches it');

it('the express-exclusion list reads the same way, from config', () => {
  const inv = fs.readFileSync(path.join(ROOT, 'lib', 'inventory.js'), 'utf8');
  assert.match(inv, /routing\.gz_express_excluded_districts/,
    'lib/inventory.js is the pattern this follows');
});

it('the dispatch rule now reads its own key', () => {
  assert.match(SRC, /const METHOD_CHOICE_CFG = 'delivery\.methodChoiceDistricts'/);
  assert.match(SRC, /function methodChoiceDistricts\(\)/);
});

it('the key is settable through the existing config endpoint', () => {
  // No new screen is needed for a merchant to set it — PUT /config writes
  // storefront_config generically, which is how the sibling key is set too.
  assert.match(SRC, /router\.put\('\/api\/retail-admin\/config'/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
