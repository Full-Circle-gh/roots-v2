#!/usr/bin/env node
/**
 * Read-only JSON-money survey — pass 4: one line per JSON-bearing column, so
 * the inventory index is complete and nothing is identified only by inference.
 * Every statement is a SELECT; the connection is opened read-only and PROVEN so.
 */
'use strict';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');
const db = new Database(process.env.ROOTS_DB || '/root/roots-v2/data/roots.db', { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; console.log('read-only PROVEN — ' + e.message); }
if (!proven) { console.error('FATAL: write accepted'); process.exit(2); }

const MONEYISH = /(price|amount|amt|fee|total|subtotal|cost|value|balance|spend|discount|paid|refund|delta|threshold|reward|surcharge|packing|shipping|commission|cents|fen|charge|money|worth|gmv|revenue|payable|due|owed|tip|subsidy|freight|tax|handling|payment)/i;
const leafOf = p => (p.split(/[.[]/).filter(Boolean).pop() || p);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

function walk(acc, node, path, seen) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const v of node) walk(acc, v, path + '[]', seen); return; }
  if (typeof node === 'object') { for (const k of Object.keys(node)) walk(acc, node[k], path ? path + '.' + k : k, seen); return; }
  if (typeof node === 'string') {
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 200000) {
      let inner; try { inner = JSON.parse(s); } catch (e) { inner = null; }
      if (inner !== null && typeof inner === 'object') { walk(acc, inner, path + '<json>', seen); return; }
    }
  }
  let e = acc.get(path);
  if (!e) { e = { rows: 0, num: 0, min: null, max: null }; acc.set(path, e); }
  if (!seen.has(path)) { seen.add(path); e.rows++; }
  if (typeof node === 'number') {
    e.num++;
    if (e.min === null || node < e.min) e.min = node;
    if (e.max === null || node > e.max) e.max = node;
  }
}

console.log('table.column | rows | non_empty | parsed | numeric_leaves | money_named | money leaf names (range)');
for (const t of tables) {
  let cols, total;
  try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); total = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch (e) { continue; }
  if (!total) continue;
  for (const c of cols) {
    const ty = String(c.type || '').toUpperCase();
    if (/^(INTEGER|INT|REAL|FLOAT|DOUBLE|BLOB|NUMERIC|BOOLEAN|DATE|DATETIME|TIMESTAMP)/.test(ty)) continue;
    let probe;
    try {
      probe = db.prepare(`SELECT "${c.name}" v FROM "${t}" WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''
        AND (TRIM("${c.name}") LIKE '{%' OR TRIM("${c.name}") LIKE '[%') LIMIT 1`).get();
    } catch (e) { continue; }
    if (!probe) continue;
    try { const p = JSON.parse(probe.v); if (p === null || typeof p !== 'object') continue; } catch (e) { continue; }
    const nn = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''`).get().n;
    const acc = new Map(); let parsed = 0;
    for (const r of db.prepare(`SELECT "${c.name}" v FROM "${t}" WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''`).iterate()) {
      let p; try { p = JSON.parse(r.v); } catch (e) { continue; }
      if (p === null || typeof p !== 'object') continue;
      parsed++; walk(acc, p, '', new Set());
    }
    const numeric = [...acc.entries()].filter(([, e]) => e.num > 0);
    const money = numeric.filter(([p]) => MONEYISH.test(leafOf(p)));
    const names = money.slice(0, 6).map(([p, e]) => `${leafOf(p)}(${e.min}..${e.max})`).join(' ');
    console.log(`${t}.${c.name} | ${total} | ${nn} | ${parsed} | ${numeric.length} | ${money.length} | ${names}${money.length > 6 ? ' …+' + (money.length - 6) : ''}`);
  }
}
console.log('RESULT=SURVEY4_COMPLETE');
db.close();
