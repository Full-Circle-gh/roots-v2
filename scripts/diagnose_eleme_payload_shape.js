#!/usr/bin/env node
/**
 * Print the MONEY-BEARING SHAPE of the archived Eleme order payloads: every
 * numeric field whose key names money (fee / amount / total / price / pay /
 * income / discount / subsidy), with the full path that reaches it.
 *
 * lib/eleme-browser.js's header says Eleme's real order payload was never
 * captured — the recon got the RPC method names and nothing else — so its
 * TOTAL_KEYS are seven educated guesses read through a walk that descends into
 * sub-objects. The first survey (diagnose_eleme_order_money.js) showed what that
 * costs: EL20260901417897 recorded ¥17.50 against ¥267.00 of goods, and its
 * payload holds settlementInfo.subTotalFeeInfo.total = 269 and
 * printDataInfo.ticketPrintContext.totalAmount = 286. The guessed keys are
 * reading a FEE as the bill.
 *
 * This is the capture that was never made. With the real key names in hand the
 * candidate list stops being a guess, for the total and for the fee columns
 * beside it.
 *
 * FIELD NAMES AND NUMBERS ONLY, and only where the key names money. Names,
 * addresses and phone numbers are neither printed nor collected — the point is
 * the shape, and the Tier 3 rule in scripts/eleme-daemon.js's header applies
 * here as much as anywhere. Non-money keys are counted, never shown.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_payload_shape.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH + '\n');

// A key that names money. Deliberately generous on the key and strict on the
// value: the whole point is to find the money field nobody guessed, so the
// filter must not encode the same guesses that missed it.
const MONEY_KEY = /(fee|amount|total|price|pay|income|discount|subsidy|money|cash|charge)/i;
// …minus the ones that name a TIME or an ID and merely contain a money word.
const NOT_MONEY = /(time|timing|date|stamp|id$|Id$|count|num$|Num$|status|type|flag|second|minute)/i;

function moneyLeaves(value, path = '', out = { hits: [], skipped: 0 }) {
  if (value == null) return out;
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      // One representative element per array — an eight-line basket would
      // otherwise bury the order-level fields this exists to find.
      if (value.length) moneyLeaves(value[0], `${path}[0]`, out);
      if (value.length > 1) out.skipped += value.length - 1;
      return out;
    }
    for (const [k, v] of Object.entries(value)) moneyLeaves(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  const key = path.split('.').pop().replace(/\[0\]$/, '');
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  if (n == null) return out;
  if (!MONEY_KEY.test(key) || NOT_MONEY.test(key)) { out.skipped++; return out; }
  // A 13-digit epoch that slipped the key filter is not money.
  if (Math.abs(n) > 100000000) { out.skipped++; return out; }
  out.hits.push({ path, value: n });
  return out;
}
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const rows = db.prepare(`
  SELECT o.id, o.order_no, o.status, o.subtotal, o.total,
         i.raw_payload, i.detail_json, LENGTH(i.raw_payload) AS raw_len
    FROM retail_orders o
    JOIN eleme_order_import i ON i.retail_order_id = o.id
   WHERE o.channel = 'eleme'
   ORDER BY o.id DESC
`).all();

console.log(`${rows.length} Eleme order(s) with an archived payload\n`);

const itemStmt = db.prepare('SELECT qty, line_total FROM retail_order_items WHERE order_id = ?');
// How often each path appears across orders, and whether it tracked the basket.
const pathSeen = new Map();

for (const r of rows) {
  const items = itemStmt.all(r.id);
  const priced = items.length && items.every(it => Number(it.line_total) > 0);
  const itemsSum = priced ? round2(items.reduce((a, it) => a + Number(it.line_total), 0)) : null;

  console.log(`${r.order_no}  (id ${r.id}, ${r.status})`);
  console.log(`  recorded: subtotal ¥${r.subtotal} · total ¥${r.total}` +
    (itemsSum != null ? `   |   lines add up to ¥${itemsSum}` : '   |   lines carry no prices'));
  // safeJson caps the archive at 20000 chars, so a truncated payload is a fact
  // about the evidence and has to be visible before anyone reasons from it.
  console.log(`  raw_payload: ${r.raw_len} chars${r.raw_len >= 20000 ? '  ** AT THE 20000-CHAR CAP — TRUNCATED, fields may be missing **' : ''}`);

  const raw = parseJson(r.raw_payload);
  if (!raw) { console.log('  (payload did not parse — truncation, most likely)\n'); continue; }
  const { hits, skipped } = moneyLeaves(raw, 'raw');
  hits.sort((a, b) => a.path.localeCompare(b.path));
  console.log(`  ${hits.length} money-named numeric field(s), ${skipped} other value(s) not shown:`);
  for (const h of hits) {
    // Mark the ones that would each be a candidate answer, so the shape can be
    // read at a glance rather than reconstructed by hand.
    const marks = [];
    if (itemsSum != null && (round2(h.value) === itemsSum || Math.round(h.value) === Math.round(itemsSum * 100))) marks.push('== LINE SUM');
    if (round2(h.value) === round2(r.total) || Math.round(h.value) === Math.round(Number(r.total) * 100)) marks.push('== WHAT WE RECORDED');
    console.log(`    ${h.path} = ${h.value}${marks.length ? '   <<< ' + marks.join(' , ') : ''}`);
    const e = pathSeen.get(h.path) || { n: 0, eqLines: 0, eqRecorded: 0 };
    e.n++;
    if (marks.includes('== LINE SUM')) e.eqLines++;
    if (marks.includes('== WHAT WE RECORDED')) e.eqRecorded++;
    pathSeen.set(h.path, e);
  }
  console.log('');
}

console.log('── every money path, across all orders ───────────────────');
console.log('   seen  =lines  =recorded   path');
for (const [path, e] of [...pathSeen.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
  console.log(`   ${String(e.n).padStart(4)}  ${String(e.eqLines).padStart(6)}  ${String(e.eqRecorded).padStart(9)}   ${path}`);
}
console.log('');
console.log('A path with a high "seen" and a high "=lines" is the goods value.');
console.log('A path that only ever equals what we recorded is the field TOTAL_KEYS is hitting.');
