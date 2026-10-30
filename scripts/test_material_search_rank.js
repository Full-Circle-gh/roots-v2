#!/usr/bin/env node
/**
 * test_material_search_rank.js — typing "ice" puts Ice Cubes first.
 *
 *   node scripts/test_material_search_rank.js
 *
 * THE DEFECT. GET /api/retail-admin/materials matched with `LIKE %query%` and
 * ordered A-Z. The recipe-line picker (public/retail-admin/19-recipes.js) shows
 * the first eight of that list. Typing "ice" therefore listed Apple Juice,
 * Brown Rice, Carrot-Ginger Juice... and hid Ice Cubes behind them — every
 * Juice and Rice contains the letters, and they sort earlier.
 *
 * The match set is unchanged (Juice still matches "ice"). Only the order
 * changes: exact name or SKU, then starts-with, then a later word that starts
 * with the query, then a match buried inside a word.
 *
 * USAGE   node scripts/test_material_search_rank.js
 * EXIT    0 every assertion held · 1 an assertion failed
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  \u2713 ' + m); };
const bad = (m, extra) => { fail++; console.log('  \u2717 ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

section('the recipe picker does not re-sort what it is given');

{
  const src = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '19-recipes.js'), 'utf8');
  const fn = src.slice(src.indexOf('window.rcpPickSearch'), src.indexOf('window.rcpPickAdd'));
  yes(fn.includes("api('/api/retail-admin/materials?for_recipe=1&search='"),
    'the ingredient picker searches the materials list');
  yes(fn.includes('_pickResults.slice(0, 8)'),
    'and shows the first eight of that response');
  yes(!/\.sort\s*\(/.test(fn),
    'without sorting them again — a local A-Z sort would hide Ice Cubes a second time');
}

const M = require('./test-support/memory-db');
console.log('(driver: ' + M.driver + ')');

function stub(rel, value) {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports: value };
}

const db = M.openMemoryDb();
db.exec(`
  CREATE TABLE ingredients (
    id INTEGER PRIMARY KEY,
    name_en TEXT, name_cn TEXT, sku TEXT, category TEXT,
    unit TEXT, buy_unit TEXT, buy_pack_size REAL,
    pack_contents_qty REAL, pack_contents_unit TEXT,
    cost_per_unit REAL DEFAULT 0, buy_price REAL DEFAULT 0, free_by_design INTEGER DEFAULT 0,
    supplier TEXT, supplier_platform TEXT, supplier_link TEXT,
    allergens TEXT, notes TEXT,
    is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
    accounting_category TEXT, item_kind TEXT DEFAULT 'food', source_recipe_id INTEGER,
    image_data TEXT, supplier_qr_data TEXT
  );
`);

const insert = db.prepare(`
  INSERT INTO ingredients (name_en, name_cn, sku, item_kind, is_active)
  VALUES (?, ?, ?, 'food', 1)
`);
insert.run('Apple Juice', '\u81ea\u69a8\u82f9\u679c\u6c41', 'F-44');
insert.run('Brown Rice', '\u957f\u7c92\u7cd9\u7c73', '4-20');
insert.run('Carrot-Ginger Juice', '\u80e1\u841d\u535c\u751f\u59dc\u6c41', '2-170');
insert.run('Celebration Juice', '\u82b9\u82b9\u6709\u5473', '2-180');
insert.run('Cooked Brown Rice', '\u73b0\u98df\u7cd9\u7c73\u996d', '1-280');
insert.run('Ice Cubes', '\u51b0\u5757', '3-ICE');
insert.run('Iceberg Lettuce', '\u751f\u83dc', 'V-12');
insert.run('Lemon Juice', '\u67e0\u6aac\u6c41', 'F-68');
insert.run('Rice Vinegar', '\u7c73\u918b', '4-90');
insert.run('Sesame Ice Cream', '\u829d\u9ebb\u51b0\u6dc7\u6dcb', 'D-9');

stub('../database', db);
stub('../lib/tenant-db', { tdb: () => db, rawTenantDb: () => db });
stub('../lib/recipe-rollup', { fireRecompute: () => {}, costOneRecipe: () => ({ ok: true }) });
stub('../lib/recipe-materialize', { materialConsumers: () => [] });
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });

const express = require('express');
const app = express();
app.use((req, res, next) => {
  req.caps = new Set(['materials:view', 'materials:costs']);
  req.user = { id: 3, username: 'ash' };
  next();
});
app.use(require(path.join('..', 'routes', 'retail-materials')));

function call(url) {
  return new Promise((resolve) => {
    const req = Object.assign(require('stream').Readable.from([]), {
      method: 'GET', url, originalUrl: url,
      headers: {}, body: {}, connection: {}, socket: {},
    });
    const res = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); return this; },
      send(p) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    app(req, res);
  });
}

function namesOf(body) {
  return (body.data || []).map((r) => r.name_en);
}

(async () => {
  section('typing "ice"');
  {
    const { status, body } = await call('/api/retail-admin/materials?search=ice');
    is(status, 200, 'the list answers');
    const names = namesOf(body);
    is(names[0], 'Ice Cubes', 'Ice Cubes is first — it starts with what was typed');
    is(names[1], 'Iceberg Lettuce', 'Iceberg Lettuce is second — same start, then A-Z');
    yes(names.includes('Apple Juice') && names.includes('Brown Rice'),
      'Juice and Rice still match — they just no longer hide the thing you meant');
    yes(names.indexOf('Ice Cubes') < names.indexOf('Sesame Ice Cream'),
      'a later word that starts with "ice" still beats a match inside Juice or Rice');
    yes(names.indexOf('Sesame Ice Cream') < names.indexOf('Apple Juice'),
      'and a later word beats a match buried inside another word');
  }

  section('the same order on the recipe picker');
  {
    const { body } = await call('/api/retail-admin/materials?for_recipe=1&search=ice');
    const names = namesOf(body);
    is(names[0], 'Ice Cubes', 'for_recipe=1 ranks the same way — that is the picker');
    is(names.slice(0, 8)[0], 'Ice Cubes',
      'so the eight rows the picker paints start with Ice Cubes');
  }

  section('closer matches still win on other queries');
  {
    const cubes = namesOf((await call('/api/retail-admin/materials?search=cubes')).body);
    is(cubes[0], 'Ice Cubes', 'typing "cubes" still finds Ice Cubes first — a later word, not a prefix');

    const exact = namesOf((await call('/api/retail-admin/materials?search=Ice Cubes')).body);
    is(exact[0], 'Ice Cubes', 'the full name is an exact match');

    const sku = namesOf((await call('/api/retail-admin/materials?search=3-ICE')).body);
    is(sku[0], 'Ice Cubes', 'an exact SKU lands on that row');

    const cn = namesOf((await call('/api/retail-admin/materials?search=' + encodeURIComponent('\u51b0'))).body);
    is(cn[0], 'Ice Cubes', 'a Chinese prefix ranks Ice Cubes first');
  }

  section('no search stays A-Z');
  {
    const names = namesOf((await call('/api/retail-admin/materials')).body);
    is(names[0], 'Apple Juice', 'without a query the list is still alphabetical');
    yes(names.indexOf('Ice Cubes') > names.indexOf('Apple Juice'),
      'and Ice Cubes sits where its name puts it');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
