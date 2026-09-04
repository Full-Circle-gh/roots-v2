#!/usr/bin/env node
// Automatic SKU generation — the engine, against a real SQLite database.
//
// Runs on a throwaway file, never on data/roots.db: the whole point of these
// assertions is that a counter ADVANCES, and a test that advanced the live
// catalogue's counters would leave gaps in a real series every time it ran.
//
//   node scripts/test_sku_generation.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const fmt = require('../lib/sku-format');
const rules = require('../lib/sku-rules');

let failures = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); return; }
  failures++;
  console.log('  ✗ ' + label + (detail ? '\n      ' + detail : ''));
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── a throwaway database with just the tables the engine touches ────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-test-'));
const db = new Database(path.join(dir, 'test.db'));
db.exec(`
  CREATE TABLE ingredients (id INTEGER PRIMARY KEY AUTOINCREMENT, name_en TEXT, sku TEXT UNIQUE, category TEXT, item_kind TEXT);
  CREATE TABLE sku_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL DEFAULT 'material',
    category TEXT NOT NULL DEFAULT '', subcategory TEXT NOT NULL DEFAULT '',
    code TEXT NOT NULL DEFAULT '', pattern TEXT NOT NULL, is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, category, subcategory));
  CREATE TABLE sku_counters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, scope_key TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1, updated_at DATETIME, UNIQUE(entity_type, scope_key));
  CREATE TABLE sku_settings (entity_type TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at DATETIME);
`);

// Saving a material the way routes/retail-materials.js does: claim only when
// the field is blank, and claim inside the same transaction as the insert.
function addMaterial({ name, kind, category, sku }) {
  const write = db.transaction(() => {
    let final = sku || null;
    if (!final) {
      const c = rules.claim(db, 'material', { category: kind, subcategory: category, name });
      if (c.ok) final = c.sku;
    }
    db.prepare('INSERT INTO ingredients (name_en, sku, category, item_kind) VALUES (?,?,?,?)')
      .run(name, final, category, kind);
    return final;
  });
  return write();
}

console.log('\n── the token template ───────────────────────────────────────────');
eq('a bare pattern passes through', fmt.render('ABC', { seq: 1 }), 'ABC');
eq('{SEQ} pads to 4 by default', fmt.render('B{SEQ}', { seq: 7 }), 'B0007');
eq('{SEQ:2} pads to 2', fmt.render('B{SEQ:2}', { seq: 7 }), 'B07');
eq('{SEQ:0} does not pad', fmt.render('B-{SEQ:0}', { seq: 7 }), 'B-7');
eq('{CAT} and {SUB} render their codes',
  fmt.render('{CAT}{SUB}-{SEQ:3}', { seq: 12, categoryCode: 'F', subcategoryCode: 'DF' }), 'FDF-012');
eq('{NAME:3} takes letters only',
  fmt.render('{NAME:3}{SEQ:2}', { seq: 3, name: 'Dried  Mango 2' }), 'DRI03');
eq('the output is uppercased', fmt.render('b-{SEQ:2}', { seq: 1 }), 'B-01');
eq('a date token reads the supplied date',
  fmt.render('{YY}{MM}-{SEQ:2}', { seq: 1, date: new Date(2026, 8, 4) }), '2609-01');

ok('an unknown token is an error', !fmt.validate('X-{NOPE}').ok);
ok('a space is an error', !fmt.validate('B {SEQ}').ok);
ok('an empty pattern is an error', !fmt.validate('').ok);
ok('a good pattern validates', fmt.validate('{CAT}{SUB}-{SEQ:4}').ok);
ok('a pattern with no {SEQ} is a warning, not an error',
  fmt.validate('FIXED').ok && fmt.validate('FIXED').warnings.some(w => w.code === 'no_seq'));
eq('a code is uppercased', fmt.validateCode(' b ').value, 'B');
ok('an unsafe code is refused', !fmt.validateCode('b b').ok);

console.log('\n── the plain builder (no formula on screen) ─────────────────────');
// The settings screen shows four controls; these two functions are the seam
// between them and the stored pattern. A round-trip that does not reproduce the
// pattern exactly must report CUSTOM rather than quietly rewrite it.
eq('a letter and four digits', fmt.fromSimple({ useCode: true, digits: 4, sep: '', year: 0 }, 'subcategory'), '{SUB}{SEQ:4}');
eq('a category-level rule uses the category token',
  fmt.fromSimple({ useCode: true, digits: 4, sep: '', year: 0 }, 'category'), '{CAT}{SEQ:4}');
eq('a separator goes between the parts',
  fmt.fromSimple({ useCode: true, digits: 4, sep: '-', year: 0 }, 'subcategory'), '{SUB}-{SEQ:4}');
eq('the year sits between the code and the number',
  fmt.fromSimple({ useCode: true, digits: 4, sep: '-', year: 2 }, 'subcategory'), '{SUB}-{YY}-{SEQ:4}');
eq('no prefix means no leading separator',
  fmt.fromSimple({ useCode: false, digits: 5, sep: '-', year: 0 }, 'subcategory'), '{SEQ:5}');

ok('a simple pattern reads back', (() => {
  const s = fmt.toSimple('{SUB}{SEQ:4}');
  return s && s.useCode === true && s.digits === 4 && s.sep === '' && s.year === 0;
})());
ok('a literal prefix reads back as prefix + separator', (() => {
  const s = fmt.toSimple('GEN-{SEQ:4}');
  return s && s.text === 'GEN' && s.sep === '-' && s.digits === 4;
})());
ok('a year reads back', (() => {
  const s = fmt.toSimple('{SUB}-{YY}-{SEQ:4}');
  return s && s.year === 2 && s.sep === '-';
})());
ok('a name fragment is CUSTOM, not flattened', fmt.toSimple('{NAME:3}{SEQ:4}') === null);
ok('a token after the number is CUSTOM', fmt.toSimple('X{SEQ:4}Y') === null);
ok('mixed separators are CUSTOM', fmt.toSimple('{SUB}-{YY}.{SEQ:4}') === null);

ok('every builder output reads back to what built it', [
  { useCode: true,  digits: 4, sep: '',  year: 0 },
  { useCode: true,  digits: 3, sep: '-', year: 0 },
  { useCode: true,  digits: 6, sep: '.', year: 4 },
  { useCode: false, digits: 5, sep: '',  year: 0 },
  { text: 'PK-', useCode: true, digits: 3, sep: '', year: 0 },
].every(simple => {
  const pattern = fmt.fromSimple(simple, 'subcategory');
  const back = fmt.toSimple(pattern);
  return back && fmt.fromSimple(back, 'subcategory') === pattern;
}));

ok('saving from the builder stores the composed pattern', (() => {
  rules.saveRule(db, 'material', {
    category: 'retail', subcategory: 'Gift boxes', code: 'G',
    simple: { useCode: true, digits: 3, sep: '-', year: 0 },
  });
  const r = rules.listRules(db, 'material').find(x => x.subcategory === 'Gift boxes');
  return r && r.pattern === '{SUB}-{SEQ:3}';
})());
eq('and it numbers with it',
  addMaterial({ name: 'Gift Box Small', kind: 'retail', category: 'Gift boxes' }), 'G-001');

console.log('\n── which rule applies ───────────────────────────────────────────');
rules.saveRule(db, 'material', { category: '', subcategory: '', pattern: 'GEN-{SEQ:4}' });
rules.saveRule(db, 'material', { category: 'food', subcategory: '', code: 'F', pattern: '{CAT}{SEQ:4}' });
rules.saveRule(db, 'material', { category: 'food', subcategory: 'Dried fruits', code: 'B', pattern: '{SUB}{SEQ:4}' });

eq('the subcategory rule wins for its own category',
  rules.resolveRule(db, 'material', 'food', 'Dried fruits').pattern, '{SUB}{SEQ:4}');
eq('a category with no rule of its own falls to the category rule',
  rules.resolveRule(db, 'material', 'food', 'Flour').pattern, '{CAT}{SEQ:4}');
eq('a kind with no rule at all falls to the default',
  rules.resolveRule(db, 'material', 'equipment', 'Trays').pattern, 'GEN-{SEQ:4}');
eq('matching is case-insensitive',
  rules.resolveRule(db, 'material', 'FOOD', 'DRIED FRUITS').pattern, '{SUB}{SEQ:4}');

console.log('\n── Ash\'s example: dried fruits start with B ─────────────────────');
eq('the first dried fruit',  addMaterial({ name: 'Dried Mango',  kind: 'food', category: 'Dried fruits' }), 'B0001');
eq('the second dried fruit', addMaterial({ name: 'Dried Apple',  kind: 'food', category: 'Dried fruits' }), 'B0002');
eq('the third dried fruit',  addMaterial({ name: 'Dried Fig',    kind: 'food', category: 'Dried fruits' }), 'B0003');

console.log('\n── where the number restarts ────────────────────────────────────');
eq('another category under Food uses the Food rule, on its own counter',
  addMaterial({ name: 'Plain Flour', kind: 'food', category: 'Flour' }), 'F0001');
eq('and continues on that counter',
  addMaterial({ name: 'Rice Flour', kind: 'food', category: 'Rice flour' }), 'F0002');
eq('dried fruits are unaffected by either',
  addMaterial({ name: 'Dried Date', kind: 'food', category: 'Dried fruits' }), 'B0004');
eq('a kind with no rule lands on the default series',
  addMaterial({ name: 'Sheet Tray', kind: 'equipment', category: 'Trays' }), 'GEN-0001');

console.log('\n── a typed SKU always wins ──────────────────────────────────────');
eq('the operator\'s own code is kept',
  addMaterial({ name: 'Supplier Cocoa', kind: 'food', category: 'Dried fruits', sku: 'ACME-77' }), 'ACME-77');
eq('and it did not consume a number',
  addMaterial({ name: 'Dried Pear', kind: 'food', category: 'Dried fruits' }), 'B0005');

console.log('\n── a code already in the catalogue is stepped over ──────────────');
db.prepare("INSERT INTO ingredients (name_en, sku, category, item_kind) VALUES ('Legacy', 'B0006', 'Dried fruits', 'food')").run();
eq('the generator walks past the hand-typed B0006',
  addMaterial({ name: 'Dried Plum', kind: 'food', category: 'Dried fruits' }), 'B0007');

console.log('\n── a pattern with no {SEQ} still cannot collide ─────────────────');
rules.saveRule(db, 'material', { category: 'packaging', subcategory: 'Jars', code: 'J', pattern: 'JAR' });
eq('the first one is the pattern itself', addMaterial({ name: 'Jar 200ml', kind: 'packaging', category: 'Jars' }), 'JAR');
eq('the second is suffixed rather than refused', addMaterial({ name: 'Jar 400ml', kind: 'packaging', category: 'Jars' }), 'JAR-2');

console.log('\n── the master switch ────────────────────────────────────────────');
rules.setSettings(db, 'material', { enabled: false });
eq('nothing is generated while numbering is off',
  addMaterial({ name: 'Unnumbered', kind: 'food', category: 'Dried fruits' }), null);
ok('and peek says why', rules.peek(db, 'material', { category: 'food', subcategory: 'Dried fruits' }).reason === 'disabled');
rules.setSettings(db, 'material', { enabled: true });
eq('turning it back on resumes the series where it left off',
  addMaterial({ name: 'Dried Cherry', kind: 'food', category: 'Dried fruits' }), 'B0008');

console.log('\n── peek does not claim ──────────────────────────────────────────');
const p1 = rules.peek(db, 'material', { category: 'food', subcategory: 'Dried fruits' });
const p2 = rules.peek(db, 'material', { category: 'food', subcategory: 'Dried fruits' });
eq('two peeks answer the same code', p1.sku, p2.sku);
eq('and it is the next one', p1.sku, 'B0009');
eq('which the next save actually takes',
  addMaterial({ name: 'Dried Kiwi', kind: 'food', category: 'Dried fruits' }), 'B0009');
eq('peek names the level that answered', p1.matched, 'subcategory');
eq('and the fallback level too',
  rules.peek(db, 'material', { category: 'equipment', subcategory: 'Trays' }).matched, 'default');

console.log('\n── a failed save burns no number ────────────────────────────────');
const before = rules.peek(db, 'material', { category: 'food', subcategory: 'Dried fruits' }).sku;
try {
  db.transaction(() => {
    rules.claim(db, 'material', { category: 'food', subcategory: 'Dried fruits' });
    throw new Error('save failed after the claim');
  })();
} catch (_) { /* expected */ }
eq('the counter rolled back with the transaction',
  rules.peek(db, 'material', { category: 'food', subcategory: 'Dried fruits' }).sku, before);

console.log('\n── the default rule cannot be deleted, only reset ───────────────');
const def = rules.listRules(db, 'material').find(r => !r.category && !r.subcategory);
const delOut = rules.deleteRule(db, 'material', def.id);
ok('deleting it resets it instead', delOut.ok && delOut.reset);
ok('and it is still there',
  !!rules.listRules(db, 'material').find(r => !r.category && !r.subcategory));
const sub = rules.listRules(db, 'material').find(r => r.subcategory === 'Jars');
ok('a scoped rule does delete', rules.deleteRule(db, 'material', sub.id).ok
  && !rules.listRules(db, 'material').find(r => r.subcategory === 'Jars'));

console.log('\n── rules refuse what they cannot mean ───────────────────────────');
ok('a subcategory with no category is refused',
  !rules.saveRule(db, 'material', { category: '', subcategory: 'Dried fruits', pattern: 'X{SEQ}' }).ok);
ok('a bad pattern is refused',
  !rules.saveRule(db, 'material', { category: 'food', subcategory: 'Nuts', pattern: 'N {SEQ}' }).ok);
ok('saving the same scope twice updates rather than duplicates', (() => {
  rules.saveRule(db, 'material', { category: 'food', subcategory: 'Nuts', code: 'N', pattern: 'N{SEQ:3}' });
  rules.saveRule(db, 'material', { category: 'food', subcategory: 'Nuts', code: 'N', pattern: 'N{SEQ:4}' });
  return rules.listRules(db, 'material').filter(r => r.subcategory === 'Nuts').length === 1;
})());

db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n' + (failures ? `✗ ${failures} assertion(s) failed\n` : '✓ all assertions passed\n'));
process.exit(failures ? 1 : 0);
