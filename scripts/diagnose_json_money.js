#!/usr/bin/env node
/**
 * Read-only survey of money embedded in JSON/TEXT columns.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 * Sections
 *   A  every column in every table sniffed for JSON content
 *   B  every numeric leaf path in every JSON column, with counts and samples
 *   C  string leaves whose name reads as money (money stored as text)
 *   D  paired-row proofs: JSON value against the column that holds the twin
 *   E  retail_product_versions.snapshot_json in detail
 *   F  gateway callback payloads — fen or yuan, settled against the paired row
 *   G  activity_log evidence of version restores actually happening
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: connection accepted a write. Aborting.'); process.exit(2); }
console.log('db: ' + DB_PATH + '   sqlite: ' + db.prepare('select sqlite_version() v').get().v);
const t0 = Date.now();

const MONEYISH = /(price|amount|amt|fee|total|subtotal|cost|value|balance|spend|discount|paid|refund|delta|threshold|reward|surcharge|packing|shipping|commission|cents|fen|charge|money|worth|gmv|revenue|payable|due|owed|tip|subsidy|freight|tax|handling|payment|sum)/i;

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

// ════════════════════════════════════════════════════════════════════════════
// A — sniff every column of every table for JSON content
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ A · JSON detection across every column ══');
const jsonCols = [];       // {table, col, rows, nonNull, jsonRows, kind}
let colsSniffed = 0;
for (const t of tables) {
  let cols, total;
  try {
    cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    total = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  } catch (e) { console.log(`  ${t}: skipped (${e.message})`); continue; }
  if (!total) continue;
  for (const c of cols) {
    const ty = String(c.type || '').toUpperCase();
    // BLOB/INTEGER/REAL columns cannot hold JSON text worth walking; everything
    // else — TEXT, VARCHAR, untyped — is sniffed by content, not by name.
    if (/^(INTEGER|INT|REAL|FLOAT|DOUBLE|BLOB|NUMERIC|BOOLEAN|DATE|DATETIME|TIMESTAMP)/.test(ty)) continue;
    colsSniffed++;
    let probe;
    try {
      probe = db.prepare(
        `SELECT "${c.name}" v FROM "${t}"
          WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''
            AND (TRIM("${c.name}") LIKE '{%' OR TRIM("${c.name}") LIKE '[%')
          LIMIT 1`).get();
    } catch (e) { continue; }
    if (!probe) continue;
    let ok = false;
    try { const p = JSON.parse(probe.v); ok = p !== null && typeof p === 'object'; } catch (e) { ok = false; }
    if (!ok) continue;
    const nn = db.prepare(
      `SELECT COUNT(*) n FROM "${t}" WHERE "${c.name}" IS NOT NULL AND TRIM("${c.name}") <> ''`).get().n;
    jsonCols.push({ table: t, col: c.name, rows: total, nonNull: nn });
  }
}
console.log(`  columns sniffed: ${colsSniffed} across ${tables.length} tables`);
console.log(`  columns holding JSON: ${jsonCols.length}`);
for (const j of jsonCols) console.log(`    ${j.table}.${j.col}  rows=${j.rows} non_empty=${j.nonNull}`);

// ════════════════════════════════════════════════════════════════════════════
// B — every leaf path in every JSON column
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ B · leaf paths ══');
console.log('  legend: rows = rows in which the path appears; n = occurrences;');
console.log('          num/str = leaf type counts; then min..max and examples\n');

const PATH_CAP = 60;   // paths printed per column; any drop is stated, never silent

function walk(node, path, acc, seenPaths) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, path + '[]', acc, seenPaths);
    return;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], path ? path + '.' + k : k, acc, seenPaths);
    return;
  }
  let e = acc.get(path);
  if (!e) { e = { n: 0, rows: 0, num: 0, str: 0, other: 0, min: null, max: null, ex: [], frac: 0, numStr: 0 }; acc.set(path, e); }
  e.n++;
  if (!seenPaths.has(path)) { seenPaths.add(path); e.rows++; }
  if (typeof node === 'number') {
    e.num++;
    if (!Number.isInteger(node)) e.frac++;
    if (e.min === null || node < e.min) e.min = node;
    if (e.max === null || node > e.max) e.max = node;
    if (e.ex.length < 4) e.ex.push(node);
  } else if (typeof node === 'string') {
    e.str++;
    if (/^-?\d+(\.\d+)?$/.test(node.trim()) && node.trim() !== '') e.numStr++;
    if (e.ex.length < 4) e.ex.push(JSON.stringify(node.length > 28 ? node.slice(0, 28) + '…' : node));
  } else { e.other++; }
}

const colPaths = new Map();   // "table.col" -> Map(path -> entry)
for (const j of jsonCols) {
  const idc = db.prepare(`PRAGMA table_info("${j.table}")`).all().some(c => c.pk) ? 'rowid' : 'rowid';
  const acc = new Map();
  let parsed = 0, failed = 0;
  const stmt = db.prepare(
    `SELECT ${idc} AS k, "${j.col}" v FROM "${j.table}" WHERE "${j.col}" IS NOT NULL AND TRIM("${j.col}") <> ''`);
  for (const r of stmt.iterate()) {
    let p;
    try { p = JSON.parse(r.v); } catch (e) { failed++; continue; }
    if (p === null || typeof p !== 'object') { failed++; continue; }
    parsed++;
    walk(p, '', acc, new Set());
  }
  colPaths.set(j.table + '.' + j.col, acc);
  const all = [...acc.entries()];
  const numeric = all.filter(([, e]) => e.num > 0 || e.numStr > 0);
  numeric.sort((a, b) => b[1].rows - a[1].rows);
  console.log(`── ${j.table}.${j.col}   rows=${j.rows} non_empty=${j.nonNull} parsed=${parsed} unparseable=${failed}`);
  console.log(`     leaf paths total=${all.length}  carrying a number=${numeric.length}`);
  const show = numeric.slice(0, PATH_CAP);
  for (const [p, e] of show) {
    const flag = MONEYISH.test(p.split(/[.[]/).filter(Boolean).pop() || p) ? '$' : ' ';
    const rng = e.num ? `${e.min}..${e.max}` : '(as string)';
    console.log(`   ${flag} ${p.padEnd(46)} rows=${String(e.rows).padStart(6)} n=${String(e.n).padStart(6)}`
      + ` num=${e.num} str=${e.str} nonint=${e.frac}  ${rng}  ex=${e.ex.join(', ')}`);
  }
  if (numeric.length > show.length) console.log(`     … ${numeric.length - show.length} further numeric path(s) NOT printed (cap ${PATH_CAP})`);
  console.log('');
}

// ════════════════════════════════════════════════════════════════════════════
// C — string leaves whose NAME reads as money (money kept as text)
// ════════════════════════════════════════════════════════════════════════════
console.log('══ C · money-named leaves that hold strings ══');
let cN = 0;
for (const [key, acc] of colPaths) {
  for (const [p, e] of acc) {
    const leaf = p.split(/[.[]/).filter(Boolean).pop() || p;
    if (!MONEYISH.test(leaf)) continue;
    if (e.str === 0) continue;
    cN++;
    console.log(`   ${key}  ${p}  str=${e.str} num=${e.num} numeric-looking-strings=${e.numStr}  ex=${e.ex.join(', ')}`);
  }
}
if (!cN) console.log('   none');

// ════════════════════════════════════════════════════════════════════════════
// D — paired-row proofs: JSON value beside the column that holds its twin
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ D · paired rows — JSON value vs the column twin ══');
function pair(label, sql, fn, limit = 6) {
  console.log(`\n   ${label}`);
  let n = 0, shown = 0;
  try {
    for (const r of db.prepare(sql).iterate()) {
      n++;
      const line = fn(r);
      if (line && shown < limit) { console.log('      ' + line); shown++; }
    }
  } catch (e) { console.log('      query failed: ' + e.message); return; }
  console.log(`      rows examined: ${n}`);
}

pair('retail_product_versions.snapshot_json vs store_products (sell_price, compare_at_price)',
  `SELECT v.id AS vid, v.product_id, v.is_baseline, v.snapshot_json AS j,
          sp.sell_price, sp.compare_at_price
     FROM retail_product_versions v JOIN store_products sp ON sp.id = v.product_id
    ORDER BY v.product_id, v.id`,
  r => { let s; try { s = JSON.parse(r.j); } catch { return null; }
    return `v${r.vid} product ${r.product_id} baseline=${r.is_baseline}  snap.sell_price=${s.sell_price} col.sell_price=${r.sell_price}  snap.compare_at=${s.compare_at_price} col.compare_at=${r.compare_at_price}`; });

pair('retail_order_addons.items_json vs retail_order_addons.amount / addon_subtotal',
  `SELECT id, order_id, items_json AS j, amount, addon_subtotal, freed_shipping FROM retail_order_addons ORDER BY id`,
  r => { let s; try { s = JSON.parse(r.j); } catch { return null; }
    const arr = Array.isArray(s) ? s : (s.items || []);
    const sum = arr.reduce((a, i) => a + (Number(i.line_total ?? i.price ?? i.amount ?? 0) || 0), 0);
    return `addon ${r.id} order ${r.order_id}  json items=${arr.length} summed=${sum}  col.amount=${r.amount} addon_subtotal=${r.addon_subtotal}  first=${JSON.stringify(arr[0] || null)}`; });

pair('retail_order_items.options_json vs retail_order_items.unit_price / line_total',
  `SELECT id, order_id, options_json AS j, qty, unit_price, line_total FROM retail_order_items
    WHERE options_json IS NOT NULL AND TRIM(options_json) <> '' AND options_json <> '[]' ORDER BY id DESC`,
  r => { let s; try { s = JSON.parse(r.j); } catch { return null; }
    return `item ${r.id} order ${r.order_id} qty=${r.qty} unit_price=${r.unit_price} line_total=${r.line_total}  options=${JSON.stringify(s).slice(0, 180)}`; });

pair('retail_refund_events.meta_json vs retail_refund_events.amount',
  `SELECT id, order_id, kind, amount, meta_json AS j FROM retail_refund_events
    WHERE meta_json IS NOT NULL AND TRIM(meta_json) <> '' ORDER BY id`,
  r => `ev ${r.id} order ${r.order_id} kind=${r.kind} col.amount=${r.amount}  meta=${String(r.j).slice(0, 200)}`, 14);

pair('retail_orders.refund_lines_json vs retail_orders.refund_amount_* ',
  `SELECT id, order_no, refund_amount_requested AS req, refund_amount_approved AS app,
          refund_amount_paid AS paid, refund_cash_amount AS cash, total, refund_lines_json AS j
     FROM retail_orders WHERE refund_lines_json IS NOT NULL AND TRIM(refund_lines_json) <> '' ORDER BY id`,
  r => `order ${r.id} ${r.order_no} total=${r.total} req=${r.req} app=${r.app} paid=${r.paid} cash=${r.cash}  lines=${String(r.j).slice(0, 220)}`, 10);

pair('retail_checkout_quotes.items_json vs retail_checkout_quotes.subtotal',
  `SELECT id, subtotal, items_json AS j FROM retail_checkout_quotes ORDER BY id DESC LIMIT 2000`,
  r => { let s; try { s = JSON.parse(r.j); } catch { return null; }
    const arr = Array.isArray(s) ? s : (s.items || []);
    return `quote ${r.id} col.subtotal=${r.subtotal}  items=${JSON.stringify(arr).slice(0, 200)}`; }, 6);

pair('gzgrocery_orders.items_json vs gzgrocery_orders.total',
  `SELECT id, total, items_json AS j FROM gzgrocery_orders ORDER BY id DESC LIMIT 400`,
  r => { let s; try { s = JSON.parse(r.j); } catch { return null; }
    const arr = Array.isArray(s) ? s : (s.items || []);
    return `gz ${r.id} col.total=${r.total}  items=${JSON.stringify(arr).slice(0, 200)}`; }, 5);

pair('retail_orders.alipay_ocr_json vs retail_orders.total',
  `SELECT id, order_no, total, alipay_ocr_json AS j FROM retail_orders
    WHERE alipay_ocr_json IS NOT NULL AND TRIM(alipay_ocr_json) <> '' ORDER BY id DESC`,
  r => `order ${r.id} col.total=${r.total}  ocr=${String(r.j).slice(0, 200)}`, 8);

// ════════════════════════════════════════════════════════════════════════════
// E — snapshot_json in detail
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ E · retail_product_versions.snapshot_json ══');
{
  const rows = db.prepare('SELECT id, product_id, is_baseline, edited_by, created_at, snapshot_json FROM retail_product_versions ORDER BY id').all();
  console.log(`   versions=${rows.length}  distinct products=${new Set(rows.map(r => r.product_id)).size}`);
  console.log(`   baselines=${rows.filter(r => r.is_baseline).length}  non-baseline=${rows.filter(r => !r.is_baseline).length}`);
  const keyCount = new Map(); let bad = 0, withSell = 0, withCmp = 0, sellNonNull = 0;
  for (const r of rows) {
    let s; try { s = JSON.parse(r.snapshot_json); } catch { bad++; continue; }
    for (const k of Object.keys(s)) keyCount.set(k, (keyCount.get(k) || 0) + 1);
    if ('sell_price' in s) { withSell++; if (s.sell_price != null) sellNonNull++; }
    if ('compare_at_price' in s) withCmp++;
  }
  console.log(`   unparseable=${bad}  carry sell_price key=${withSell} (non-null ${sellNonNull})  compare_at_price key=${withCmp}`);
  console.log('   keys present, by frequency:');
  console.log('     ' + [...keyCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '));
  const first = rows[0] && JSON.parse(rows[0].snapshot_json);
  if (first) {
    const nested = Object.keys(first).filter(k => typeof first[k] === 'string' && /^[[{]/.test(first[k].trim()));
    console.log('   keys whose VALUE is itself JSON text (nested money risk): ' + (nested.join(', ') || 'none in row 1'));
  }
  // Does any snapshot value differ from the live column? (restore would move it)
  let differs = 0, same = 0, noProduct = 0;
  for (const r of rows) {
    let s; try { s = JSON.parse(r.snapshot_json); } catch { continue; }
    const sp = db.prepare('SELECT sell_price, compare_at_price FROM store_products WHERE id = ?').get(r.product_id);
    if (!sp) { noProduct++; continue; }
    if (Number(s.sell_price) !== Number(sp.sell_price)) differs++; else same++;
  }
  console.log(`   snapshot sell_price vs live column: same=${same} differs=${differs} product-missing=${noProduct}`);
  const dist = db.prepare(`SELECT COUNT(*) n, MIN(sell_price) mn, MAX(sell_price) mx FROM store_products`).get();
  console.log(`   store_products.sell_price: n=${dist.n} min=${dist.mn} max=${dist.mx}`);
  // bundle_items is a VERSION_COLUMN and is itself JSON — does it carry money?
  const bi = db.prepare(`SELECT id, bundle, bundle_mode, bundle_items FROM store_products
                          WHERE bundle_items IS NOT NULL AND TRIM(bundle_items) <> '' AND bundle_items <> '[]' LIMIT 6`).all();
  console.log(`   store_products.bundle_items non-empty rows (sample ${bi.length}):`);
  for (const b of bi) console.log(`      product ${b.id} bundle=${b.bundle} mode=${b.bundle_mode} items=${String(b.bundle_items).slice(0, 200)}`);
  const biN = db.prepare(`SELECT COUNT(*) n FROM store_products WHERE bundle_items IS NOT NULL AND TRIM(bundle_items) <> '' AND bundle_items <> '[]'`).get().n;
  console.log(`   store_products.bundle_items non-empty total: ${biN}`);
}

// ════════════════════════════════════════════════════════════════════════════
// F — gateway callback payloads: fen or yuan?
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ F · gateway callback payloads ══');
const CALLBACKS = [
  ['retail_payments', 'raw_callback_json', 'amount', 'id'],
  ['retail_order_addons', 'raw_callback_json', 'amount', 'id'],
  ['retail_topup_transactions', 'raw_callback_json', 'amount', 'id'],
];
for (const [t, jc, mc, idc] of CALLBACKS) {
  let rows;
  try {
    rows = db.prepare(`SELECT ${idc} AS id, ${mc} AS col, ${jc} AS j FROM "${t}"
                        WHERE ${jc} IS NOT NULL AND TRIM(${jc}) <> '' ORDER BY ${idc} DESC LIMIT 400`).all();
  } catch (e) { console.log(`   ${t}.${jc}: ${e.message}`); continue; }
  const total = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE ${jc} IS NOT NULL AND TRIM(${jc}) <> ''`).get().n;
  console.log(`\n   ${t}.${jc}  non_empty=${total} sampled=${rows.length}`);
  let fen = 0, yuan = 0, neither = 0, shown = 0;
  for (const r of rows) {
    let p; try { p = JSON.parse(r.j); } catch { neither++; continue; }
    // find every numeric leaf whose name reads as an amount
    const found = [];
    (function w(node, path) {
      if (node === null || typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        const v = node[k], np = path ? path + '.' + k : k;
        if (v !== null && typeof v === 'object') w(v, np);
        else if (typeof v === 'number' && MONEYISH.test(k)) found.push([np, v]);
      }
    })(p, '');
    const col = Number(r.col) || 0;
    let verdict = 'none';
    for (const [, v] of found) {
      if (Math.abs(v - col * 100) < 0.5) { verdict = 'fen'; break; }
      if (Math.abs(v - col) < 1e-6) { verdict = 'yuan'; break; }
    }
    if (verdict === 'fen') fen++; else if (verdict === 'yuan') yuan++; else neither++;
    if (shown < 4) { console.log(`      id=${r.id} col.${mc}=${r.col} verdict=${verdict} amounts=${JSON.stringify(found).slice(0, 220)}`); shown++; }
  }
  console.log(`      verdicts over ${rows.length} sampled: fen=${fen} yuan=${yuan} indeterminate=${neither}`);
}

// ════════════════════════════════════════════════════════════════════════════
// G — activity_log evidence
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ G · activity_log ══');
{
  const acts = db.prepare(
    `SELECT action, entity_type, COUNT(*) n, MIN(created_at) first, MAX(created_at) last
       FROM activity_log GROUP BY action, entity_type ORDER BY n DESC LIMIT 40`).all();
  console.log(`   total activity_log rows: ${db.prepare('SELECT COUNT(*) n FROM activity_log').get().n}`);
  console.log('   action / entity_type spread (top 40):');
  for (const a of acts) console.log(`      ${String(a.action).padEnd(18)} ${String(a.entity_type).padEnd(22)} n=${String(a.n).padStart(6)}  ${a.first} .. ${a.last}`);
  const restores = db.prepare(
    `SELECT * FROM activity_log WHERE action LIKE '%restore%' OR action LIKE '%version%' ORDER BY id DESC LIMIT 30`).all();
  console.log(`\n   restore/version entries: ${restores.length}`);
  for (const r of restores) console.log(`      ${r.created_at} user=${r.username} action=${r.action} entity=${r.entity_type}#${r.entity_id} details=${String(r.details).slice(0, 140)}`);
  const prodEdits = db.prepare(
    `SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM activity_log WHERE entity_type LIKE '%product%'`).get();
  console.log(`\n   product-entity activity: n=${prodEdits.n} ${prodEdits.first} .. ${prodEdits.last}`);
  const vAges = db.prepare(
    `SELECT MIN(created_at) first, MAX(created_at) last, COUNT(*) n FROM retail_product_versions`).get();
  console.log(`   retail_product_versions span: n=${vAges.n} ${vAges.first} .. ${vAges.last}`);
  const byEditor = db.prepare(
    `SELECT COALESCE(edited_by,'(null)') who, COUNT(*) n FROM retail_product_versions GROUP BY 1 ORDER BY n DESC LIMIT 10`).all();
  console.log('   versions by editor: ' + byEditor.map(b => `${b.who}:${b.n}`).join('  '));
}

console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('RESULT=SURVEY_COMPLETE');
db.close();
