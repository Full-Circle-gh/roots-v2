#!/usr/bin/env node
/**
 * Read-only survey of money embedded in JSON/TEXT columns — pass 2.
 *
 * Pass 1 established the leaf-path map; its section A/B output was too large to
 * read back in full. This pass reports the same sweep in a compact form: every
 * column sniffed, and per column the money-named numeric paths in full detail
 * with every other numeric path listed by name so nothing is silently dropped.
 * It also fixes the two probes that named columns that do not exist
 * (retail_refund_events.event, gzgrocery_orders.order_id) and adds the nested
 * blobs inside snapshot_json, activity_log.details, and storefront_config.
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

// ── find JSON-bearing columns by content, not by name ───────────────────────
const jsonCols = [];
let sniffed = 0;
for (const t of tables) {
  let cols, total;
  try {
    cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    total = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  } catch (e) { continue; }
  if (!total) continue;
  for (const c of cols) {
    const ty = String(c.type || '').toUpperCase();
    if (/^(INTEGER|INT|REAL|FLOAT|DOUBLE|BLOB|NUMERIC|BOOLEAN|DATE|DATETIME|TIMESTAMP)/.test(ty)) continue;
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
console.log(`\n══ A · ${sniffed} text-ish columns sniffed across ${tables.length} tables; ${jsonCols.length} hold JSON ══`);

function walkInto(acc, node, path, seen) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const v of node) walkInto(acc, v, path + '[]', seen); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) walkInto(acc, node[k], path ? path + '.' + k : k, seen);
    return;
  }
  // A string that is itself JSON is descended into — this is how snapshot_json
  // hides description_blocks/images/product_facts one level down.
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
    if (MONEYISH.test(leafOf(path)) && e.ex.length < 3) e.ex.push(JSON.stringify(node.slice(0, 24)));
  }
}

console.log('\n══ B · numeric leaf paths, money-named ones in full ══');
for (const j of jsonCols) {
  const acc = new Map();
  let parsed = 0, failed = 0;
  for (const r of db.prepare(`SELECT "${j.c}" v FROM "${j.t}" WHERE "${j.c}" IS NOT NULL AND TRIM("${j.c}") <> ''`).iterate()) {
    let p; try { p = JSON.parse(r.v); } catch (e) { failed++; continue; }
    if (p === null || typeof p !== 'object') { failed++; continue; }
    parsed++; walkInto(acc, p, '', new Set());
  }
  const numeric = [...acc.entries()].filter(([, e]) => e.num > 0 || e.numStr > 0).sort((a, b) => b[1].rows - a[1].rows);
  const money = numeric.filter(([p]) => MONEYISH.test(leafOf(p)));
  const rest  = numeric.filter(([p]) => !MONEYISH.test(leafOf(p)));
  console.log(`\n── ${j.t}.${j.c}  rows=${j.rows} non_empty=${j.nn} parsed=${parsed} unparseable=${failed}`
    + `  leaves=${acc.size} numeric=${numeric.length} money-named=${money.length}`);
  for (const [p, e] of money) {
    console.log(`    $ ${p.padEnd(40)} rows=${String(e.rows).padStart(6)} n=${String(e.n).padStart(6)}`
      + ` num=${e.num} str=${e.str} numstr=${e.numStr} nonint=${e.frac} range=${e.min}..${e.max} ex=${e.ex.join(',')}`);
  }
  if (rest.length) {
    console.log('      other numeric leaves (name:rows): '
      + rest.slice(0, 45).map(([p, e]) => `${leafOf(p)}:${e.rows}`).join(' ')
      + (rest.length > 45 ? `  …and ${rest.length - 45} more NOT listed` : ''));
  }
}

// ── the two probes pass 1 got wrong, plus the nested-blob questions ─────────
console.log('\n══ D2 · corrected paired-row probes ══');
console.log('\n   retail_refund_events.meta_json vs .amount  (column is `event`, not `kind`)');
for (const r of db.prepare(
  `SELECT id, order_id, event, amount, meta_json j FROM retail_refund_events
    WHERE meta_json IS NOT NULL AND TRIM(meta_json) <> '' ORDER BY id`).all().slice(0, 14)) {
  console.log(`      ev ${r.id} order ${r.order_id} event=${r.event} col.amount=${r.amount}  meta=${String(r.j).slice(0, 190)}`);
}
console.log('      total meta_json non-empty: ' + db.prepare(
  `SELECT COUNT(*) n FROM retail_refund_events WHERE meta_json IS NOT NULL AND TRIM(meta_json) <> ''`).get().n
  + ' of ' + db.prepare('SELECT COUNT(*) n FROM retail_refund_events').get().n);

console.log('\n   gzgrocery_orders.items_json vs .total  (pk is `order_id`)');
for (const r of db.prepare(
  `SELECT order_id, order_no, total, our_units, items_json j FROM gzgrocery_orders ORDER BY order_id DESC LIMIT 6`).all()) {
  console.log(`      gz ${r.order_id} ${r.order_no} col.total=${r.total} our_units=${r.our_units} items=${String(r.j).slice(0, 210)}`);
}

console.log('\n   retail_order_items.options_json vs unit_price / line_total');
{
  const n = db.prepare(`SELECT COUNT(*) n FROM retail_order_items
     WHERE options_json IS NOT NULL AND TRIM(options_json) <> '' AND options_json <> '[]'`).get().n;
  console.log(`      rows with non-empty options_json: ${n} of ${db.prepare('SELECT COUNT(*) n FROM retail_order_items').get().n}`);
  for (const r of db.prepare(`SELECT id, order_id, qty, unit_price, line_total, options_json j FROM retail_order_items
     WHERE options_json IS NOT NULL AND TRIM(options_json) <> '' AND options_json <> '[]' ORDER BY id DESC LIMIT 10`).all()) {
    console.log(`      item ${r.id} qty=${r.qty} unit_price=${r.unit_price} line_total=${r.line_total} options=${String(r.j).slice(0, 170)}`);
  }
}

console.log('\n   retail_order_addons.items_json vs amount / addon_subtotal');
for (const r of db.prepare(`SELECT id, order_id, amount, addon_subtotal, freed_shipping, items_json j FROM retail_order_addons ORDER BY id`).all()) {
  let s; try { s = JSON.parse(r.j); } catch { s = null; }
  const arr = Array.isArray(s) ? s : [];
  const sum = arr.reduce((a, i) => a + (Number(i.line_total) || 0), 0);
  console.log(`      addon ${r.id} order ${r.order_id} col.amount=${r.amount} addon_subtotal=${r.addon_subtotal} freed=${r.freed_shipping}`
    + ` | json lines=${arr.length} sum(line_total)=${sum} first=${JSON.stringify(arr[0] || null).slice(0, 150)}`);
}

console.log('\n   storefront_config.value_json — every key whose JSON carries a number');
for (const r of db.prepare('SELECT key, value_json FROM storefront_config ORDER BY key').all()) {
  let v; try { v = JSON.parse(r.value_json); } catch { continue; }
  const hits = [];
  (function w(node, path) {
    if (node === null) return;
    if (typeof node === 'number') { hits.push(`${path || '(scalar)'}=${node}`); return; }
    if (typeof node !== 'object') return;
    for (const k of Object.keys(node)) w(node[k], path ? path + '.' + k : k);
  })(v, '');
  if (hits.length) console.log(`      ${r.key.padEnd(34)} ${hits.slice(0, 12).join(' ')}${hits.length > 12 ? ` …+${hits.length - 12}` : ''}`);
}

console.log('\n   activity_log.details — money-named leaves (this blob records edits)');
{
  const acc = new Map();
  let parsed = 0;
  for (const r of db.prepare(`SELECT details v FROM activity_log WHERE details IS NOT NULL AND TRIM(details) <> ''`).iterate()) {
    let p; try { p = JSON.parse(r.v); } catch (e) { continue; }
    if (p === null || typeof p !== 'object') continue;
    parsed++; walkInto(acc, p, '', new Set());
  }
  const money = [...acc.entries()].filter(([p, e]) => MONEYISH.test(leafOf(p)) && (e.num > 0 || e.numStr > 0))
    .sort((a, b) => b[1].rows - a[1].rows);
  console.log(`      parsed=${parsed}  money-named numeric leaves=${money.length}`);
  for (const [p, e] of money.slice(0, 25)) {
    console.log(`      $ ${p.padEnd(38)} rows=${e.rows} num=${e.num} str=${e.str} range=${e.min}..${e.max} ex=${e.ex.join(',')}`);
  }
  if (money.length > 25) console.log(`      …${money.length - 25} more money-named leaves NOT listed`);
}

console.log('\n   snapshot_json nested blobs — do images/product_facts/description_blocks carry money?');
{
  const acc = new Map();
  let n = 0;
  for (const r of db.prepare('SELECT snapshot_json v FROM retail_product_versions').iterate()) {
    let s; try { s = JSON.parse(r.v); } catch (e) { continue; }
    n++;
    for (const k of ['images', 'product_facts', 'description_blocks', 'bundle_items', 'nutrition', 'tags', 'free_of', 'ship_modes']) {
      if (s[k] == null) continue;
      let inner = s[k];
      if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch (e) { continue; } }
      if (inner === null || typeof inner !== 'object') continue;
      walkInto(acc, inner, k, new Set());
    }
  }
  const numeric = [...acc.entries()].filter(([, e]) => e.num > 0 || e.numStr > 0).sort((a, b) => b[1].rows - a[1].rows);
  console.log(`      snapshots walked=${n}  numeric leaves inside nested blobs=${numeric.length}`);
  for (const [p, e] of numeric.slice(0, 30)) {
    const flag = MONEYISH.test(leafOf(p)) ? '$' : ' ';
    console.log(`      ${flag} ${p.padEnd(42)} rows=${e.rows} num=${e.num} range=${e.min}..${e.max} ex=${e.ex.join(',')}`);
  }
  if (numeric.length > 30) console.log(`      …${numeric.length - 30} more NOT listed`);
}

console.log('\nRESULT=SURVEY2_COMPLETE');
db.close();
