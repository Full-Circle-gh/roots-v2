#!/usr/bin/env node
/**
 * A replacement order says what it replaces, and the order it replaces says so
 * (§425).
 *
 *   node scripts/test_replacement_link_line.js
 *
 * WHY THIS EXISTS. TC000916 was a proper replacement for TC000902 —
 * `replacement_for_order_id` set, the case answered — and NO SCREEN DREW THE
 * LINK, so it looked exactly like a no-charge order typed by hand. Ash took it
 * for one. §425 adds one line under "Order placed" on both surfaces.
 *
 * WHAT IT LOCKS DOWN, in order of what would actually hurt:
 *   1. The line reads right in both languages, on both surfaces: the number is
 *      the right order's, an order that is neither draws nothing, and an
 *      order number is escaped before it reaches innerHTML.
 *   2. THE ADMIN'S BILINGUAL PASS NEVER SPLITS IT. 10-extras.js splits a text
 *      node on " · " when the right half has Chinese and the left half has none,
 *      and shows one half. A line worded so that its Chinese sat only to the
 *      right of a " · " would silently lose its left half on the desktop. The
 *      rule is replayed here against every string, so a later rewording that
 *      tips over it fails a test instead of printing half a line.
 *   3. The server's two lookups return the order NUMBER, the right way round,
 *      and a replaced order's list is ordered. They are run, not just read.
 *   4. The Chinese is declared in the vocabulary document, as composed.
 *
 * No network, no keys, no server: the desktop helper and the phone's line are
 * lifted out of the shipped files and run in a vm; the SQL is lifted out of the
 * route and run against an in-memory SQLite.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('@libsql/client');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const DESK   = read('public/retail-admin/04-orders.js');
const PHONE  = read('public/m.html');
const ROUTES = read('routes/retail.js');
const VOCAB  = read('docs/tacet-delivery-vocabulary.md');
const I18N   = read('public/retail-admin/10-extras.js');

let pass = 0;
const fails = [];
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push([name, e.message]); console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// Lift a whole top-level function by name, so a rename fails here loudly.
function liftFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('could not find function ' + name);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 3);
}

// ── The desktop helper, run in both languages ──────────────────────────────
const deskHelper = liftFn(DESK, 'ordReplacementLine');
function desk(order, lang) {
  const ctx = {
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(deskHelper + '\nthis.out = ordReplacementLine(ORDER);', Object.assign(ctx, { ORDER: order }));
  return ctx.out;
}
// The text a reader sees: tags and nbsp reduced away.
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<');

const REPLACEMENT = { replacement_for: { id: 2227, order_no: 'TC000902' }, replaced_by: [] };
const ORIGINAL    = { replacement_for: null, replaced_by: [{ id: 2255, order_no: 'TC000916' }] };

it('desktop: the replacement says what it replaces, in English and in Chinese', () => {
  assert.strictEqual(plain(desk(REPLACEMENT, 'en')), 'Replacement for TC000902');
  assert.strictEqual(plain(desk(REPLACEMENT, 'cn')), '补发 · 原单 TC000902');
});

it('desktop: the original says a replacement was sent, with the live 已补发', () => {
  assert.strictEqual(plain(desk(ORIGINAL, 'en')), 'Replacement sent · TC000916');
  assert.strictEqual(plain(desk(ORIGINAL, 'cn')), '已补发 · TC000916');
});

it('desktop: an order that is neither draws nothing at all', () => {
  assert.strictEqual(desk({}, 'en'), '');
  assert.strictEqual(desk({ replacement_for: null, replaced_by: [] }, 'cn'), '');
});

it('desktop: several replacements are all named', () => {
  const o = { replaced_by: [{ order_no: 'TC000916' }, { order_no: 'TC000921' }] };
  assert.strictEqual(plain(desk(o, 'en')), 'Replacement sent · TC000916, TC000921');
});

it('desktop: an order number is escaped before it reaches innerHTML', () => {
  const html = desk({ replacement_for: { order_no: '<img src=x onerror=1>' } }, 'en');
  assert.ok(!/<img/.test(html), 'got ' + html);
});

// ── The phone's line, lifted out of orderHeadMarks and run ─────────────────
const m = PHONE.match(/const replLine=\[[\s\S]*?\]\.filter\(Boolean\);/);
function phone(o, lang) {
  if (!m) throw new Error('could not find the phone replLine block in m.html');
  const ctx = {
    T: (en, cn) => (lang === 'cn' ? cn : en),
    escAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    o,
  };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.out = replLine;', ctx);
  return Array.from(ctx.out);          // a vm's Array is another realm's; compare like with like
}

it('phone: the same two lines, in both languages, from the mapped fields', () => {
  assert.deepStrictEqual(phone({ replacementFor: 'TC000902', replacedBy: [] }, 'en'), ['Replacement for TC000902']);
  assert.deepStrictEqual(phone({ replacementFor: 'TC000902', replacedBy: [] }, 'cn'), ['补发 · 原单 TC000902']);
  assert.deepStrictEqual(phone({ replacementFor: null, replacedBy: ['TC000916'] }, 'en'), ['Replacement sent · TC000916']);
  assert.deepStrictEqual(phone({ replacementFor: null, replacedBy: ['TC000916'] }, 'cn'), ['已补发 · TC000916']);
});

it('phone: an order that is neither draws nothing, and several are all named', () => {
  assert.deepStrictEqual(phone({ replacementFor: null, replacedBy: [] }, 'en'), []);
  assert.deepStrictEqual(phone({ replacementFor: null, replacedBy: ['A1', 'B2'] }, 'en'), ['Replacement sent · A1, B2']);
});

it('phone: the number is escaped, and the early return knows about the new line', () => {
  assert.ok(!/<b>/.test(phone({ replacementFor: '<b>x</b>', replacedBy: [] }, 'en')[0]));
  assert.ok(/!replLine\.length\) return ''/.test(PHONE), 'an order with only a replacement link must still draw the strip');
});

it('phone: mapDetail carries both directions from the payload', () => {
  assert.ok(/base\.replacementFor=\(o\.replacement_for&&o\.replacement_for\.order_no\)\|\|null/.test(PHONE));
  assert.ok(/base\.replacedBy=\(o\.replaced_by\|\|\[\]\)\.map\(r=>r&&r\.order_no\)\.filter\(Boolean\)/.test(PHONE));
});

// ── 2. The admin's bilingual pass must never split these ───────────────────
// Replays 10-extras.js processNode's rule. First, that the rule is still what
// this test assumes — otherwise it would be asserting against a fiction.
it('the rule being replayed is still the shipped rule', () => {
  assert.ok(/if \(!hasChinese\(cn\) \|\| hasChinese\(en\)\) return;/.test(I18N),
    'processNode no longer reads "split only when the right has Chinese and the left has none" — update this test with it');
});
const hasChinese = (s) => /[一-鿿]/.test(s);
function wouldSplit(text) {
  const idx = text.indexOf(' · ');
  if (idx === -1) return false;
  const en = text.slice(0, idx).trim(), cn = text.slice(idx + 3).trim();
  if (!en || !cn) return false;
  return hasChinese(cn) && !hasChinese(en);
}
it('no string on this surface is ever split by that pass, in either language', () => {
  const samples = [];
  for (const lang of ['en', 'cn']) {
    for (const o of [REPLACEMENT, ORIGINAL, { ...REPLACEMENT, replaced_by: ORIGINAL.replaced_by },
                     { replaced_by: [{ order_no: 'TC000916' }, { order_no: 'TC000921' }] }]) {
      samples.push(plain(desk(o, lang)));
    }
    samples.push(...phone({ replacementFor: 'TC000902', replacedBy: ['TC000916'] }, lang));
  }
  for (const s of samples) assert.ok(!wouldSplit(s), JSON.stringify(s) + ' would be split by the bilingual pass');
});

// ── 3. The server's lookups, run ───────────────────────────────────────────
const handler = ROUTES.slice(ROUTES.indexOf("router.get('/api/retail-admin/orders/:id'"));
const FOR_SQL = (handler.match(/prepare\('(SELECT id, order_no FROM retail_orders WHERE id = \?)'\)/) || [])[1];
const BY_SQL  = (handler.match(/'(SELECT id, order_no FROM retail_orders WHERE replacement_for_order_id = \? ORDER BY id)'/) || [])[1];

it('the order-detail route reads both directions off replacement_for_order_id', () => {
  assert.ok(FOR_SQL, 'could not find the replacement_for lookup in the detail route');
  assert.ok(BY_SQL, 'could not find the replaced_by lookup in the detail route');
  assert.ok(/o\.replacement_for = o\.replacement_for_order_id/.test(handler));
  assert.ok(/o\.replaced_by = /.test(handler));
});

it('the lookups return the order NUMBER, the right way round, ordered', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, replacement_for_order_id INTEGER)');
  const ins = db.prepare('INSERT INTO retail_orders (id, order_no, replacement_for_order_id) VALUES (?,?,?)');
  ins.run(2227, 'TC000902', null);
  ins.run(2260, 'TC000921', 2227);      // inserted first, higher id
  ins.run(2255, 'TC000916', 2227);
  ins.run(2300, 'TC000999', null);
  // The replacement reads its original:
  assert.deepStrictEqual(db.prepare(FOR_SQL).get(2227), { id: 2227, order_no: 'TC000902' });
  // The original reads its replacements, lowest id first:
  assert.deepStrictEqual(db.prepare(BY_SQL).all(2227).map(r => r.order_no), ['TC000916', 'TC000921']);
  // An unrelated order is neither:
  assert.deepStrictEqual(db.prepare(BY_SQL).all(2300), []);
});

it('the lookups are tenant-scoped through tdb(), like every other read in the route', () => {
  const i = handler.indexOf('o.replacement_for = ');
  const block = handler.slice(i, handler.indexOf('// Pull fresh JD trace', i));
  assert.strictEqual((block.match(/tdb\(\)/g) || []).length, 2);
  assert.ok(!/\bdb\.prepare/.test(block.replace(/tdb\(\)/g, '')));
});

// ── Both desktop sites draw it ─────────────────────────────────────────────
it('the desktop draws the line in both places the drawer prints "Order placed"', () => {
  assert.strictEqual((DESK.match(/ordReplacementLine\(o\)/g) || []).length, 4,
    'the definition, one use in orderHeadMarks, and two in the mirrored-order header (the guard and the draw)');
  assert.ok(/<span class="od-placed"><span>Order placed · 下单于<\/span> \$\{formatDate\(o\.placed_at\)\}<\/span>\s*\n\s*\$\{ordReplacementLine\(o\)\}/.test(DESK),
    'the line must sit right after "Order placed" in the marks strip');
});

// ── 4. Declared, as composed ───────────────────────────────────────────────
it('the one composed string is declared in the vocabulary document, and the version is bumped', () => {
  // lastIndexOf on the heading: the FIRST mention is the changelog line at the top.
  const at = VOCAB.lastIndexOf('\n## The replacement link in the order drawer (§425)');
  assert.ok(at > 0, 'the §425 section must exist');
  const sec = VOCAB.slice(at);
  assert.ok(sec.slice(sec.indexOf('### Composed')).includes('`补发 · 原单 TC000902`'),
    '补发 · 原单 is on a screen but not declared composed');
  assert.ok(sec.slice(0, sec.indexOf('### Composed')).includes('Replacement sent · 已补发'),
    'the copied-whole pair must be declared');
  assert.ok(/^\*\*v1\.309 ·/m.test(VOCAB), 'the vocabulary version line must be bumped');
});

console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) process.exit(1);
