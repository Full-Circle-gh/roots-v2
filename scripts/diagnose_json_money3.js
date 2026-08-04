#!/usr/bin/env node
/**
 * Read-only survey of money embedded in JSON/TEXT columns — pass 3.
 *
 * Passes 1 and 2 produced more output than could be read back in one go. This
 * pass prints only what the inventory needs: for every JSON-bearing column, the
 * money-named numeric leaf paths in full, and a single line naming the columns
 * that have none. Nothing is dropped without saying so.
 *
 * Every statement is a SELECT. The connection is opened read-only and PROVEN so
 * by attempting a CREATE TABLE and aborting if the write is accepted.
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: connection accepted a write.'); process.exit(2); }

const MONEYISH = /(price|amount|amt|fee|total|subtotal|cost|value|balance|spend|discount|paid|refund|delta|threshold|reward|surcharge|packing|shipping|commission|cents|fen|charge|money|worth|gmv|revenue|payable|due|owed|tip|subsidy|freight|tax|handling|payment)/i;
const leafOf = p => (p.split(/[.[]/).filter(Boolean).pop() || p);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

const jsonCols = [];
let sniffed = 0, skippedTyped = 0;
for (const t of tables) {
  let cols, total;
  try {
    cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    total = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  } catch (e) { continue; }
  if (!total) continue;
  for (const c of cols) {
    const ty = String(c.type || '').toUpperCase();
    if (/^(INTEGER|INT|REAL|FLOAT|DOUBLE|BLOB|NUMERIC|BOOLEAN|DATE|DATETIME|TIMESTAMP)/.test(ty)) { skippedTyped++; continue; }
    sniffed++;
    let probe;
    try {
      probe = db.prepare(`SELECT "${c.name}" v FROM "${t}"
         WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''
           AND (TRIM("${c.name}") LIKE '{%' OR TRIM("${c.name}") LIKE '[%') LIMIT 1`).get();
    } catch (e) { continue; }
    if (!probe) continue;
    try { const p = JSON.parse(probe.v); if (p === null || typeof p !== 'object') continue; } catch (e) { continue; }
    const nn = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''`).get().n;
    jsonCols.push({ t, c: c.name, rows: total, nn });
  }
}
console.log(`\n══ inventory ══`);
console.log(`  tables=${tables.length}  text-ish columns sniffed=${sniffed}  numeric/blob columns skipped=${skippedTyped}`);
console.log(`  columns holding JSON=${jsonCols.length}`);

function walkInto(acc, node, path, seen) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const v of node) walkInto(acc, v, path + '[]', seen); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) walkInto(acc, node[k], path ? path + '.' + k : k, seen);
    return;
  }
  if (typeof node === 'string') {
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 200000) {
      let inner; try { inner = JSON.parse(s); } catch (e) { inner = null; }
      if (inner !== null && typeof inner === 'object') { walkInto(acc, inner, path + '<json>', seen); return; }
    }
  }
  let e = acc.get(path);
  if (!e) { e = { n: 0, rows: 0, num: 0, str: 0, numStr: 0, frac: 0, min: null, max: null, ex: [] }; acc.set(path, e); }
  e.n++;
  if (!seen.has(path)) { seen.add(path); e.rows++; }
  if (typeof node === 'number') {
    e.num++;
    if (!Number.isInteger(node)) e.frac++;
    if (e.min === null || node < e.min) e.min = node;
    if (e.max === null || node > e.max) e.max = node;
    if (e.ex.length < 3) e.ex.push(node);
  } else if (typeof node === 'string') {
    e.str++;
    if (/^-?\d+(\.\d+)?$/.test(node.trim()) && node.trim() !== '') e.numStr++;
    if (e.ex.length < 3) e.ex.push(JSON.stringify(node.slice(0, 20)));
  }
}

const clean = [];
for (const j of jsonCols) {
  const acc = new Map();
  let parsed = 0, failed = 0;
  for (const r of db.prepare(`SELECT "${j.c}" v FROM "${j.t}" WHERE "${j.c}" IS NOT NULL AND TRIM("${j.c}") <> ''`).iterate()) {
    let p; try { p = JSON.parse(r.v); } catch (e) { failed++; continue; }
    if (p === null || typeof p !== 'object') { failed++; continue; }
    parsed++; walkInto(acc, p, '', new Set());
  }
  const numeric = [...acc.entries()].filter(([, e]) => e.num > 0 || e.numStr > 0);
  const money = numeric.filter(([p]) => MONEYISH.test(leafOf(p))).sort((a, b) => b[1].rows - a[1].rows);
  if (!money.length) {
    clean.push(`${j.t}.${j.c}(rows=${j.rows},nonempty=${j.nn},parsed=${parsed},bad=${failed},numeric_leaves=${numeric.length})`);
    continue;
  }
  console.log(`\n── ${j.t}.${j.c}  rows=${j.rows} non_empty=${j.nn} parsed=${parsed} unparseable=${failed}`
    + `  leaves=${acc.size} numeric=${numeric.length} money-named=${money.length}`);
  for (const [p, e] of money) {
    console.log(`    $ ${p.padEnd(38)} rows=${String(e.rows).padStart(6)} n=${String(e.n).padStart(6)}`
      + ` num=${e.num} str=${e.str} numstr=${e.numStr} nonint=${e.frac} range=${e.min}..${e.max} ex=${e.ex.join(',')}`);
  }
}
console.log(`\n── columns with NO money-named numeric leaf (${clean.length}):`);
for (const c of clean) console.log('     ' + c);

console.log('\nRESULT=SURVEY3_COMPLETE');
db.close();
