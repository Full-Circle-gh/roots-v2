#!/usr/bin/env node
/**
 * Which of Eleme's parsed fields have EVER landed on an order — and Meituan's
 * same fields beside them, as the control.
 *
 * WHY THIS AND NOT ANOTHER PAYLOAD CAPTURE. lib/eleme-browser.js reads by
 * candidate key through an EXACT lookup, so a list that guessed wrong returns
 * undefined forever and its column lands null on every order with nothing
 * saying so. On 2026-09-17 two such lists were found and fixed — the address
 * and the phone, which had missed `consigneeAddress` and `consigneePhones` by a
 * hair. The audit that found them (scripts/diagnose_eleme_candidate_keys.js)
 * then reported ten more lists matching nothing, and settling those needs a
 * DEEP capture of the order-detail payload, which needs a live Eleme order.
 *
 * Ash, 2026-09-18: *"eleme is really slow . not many orders"*. Waiting on one is
 * a bad bet, and it is not necessary for the lists that matter, because four of
 * them write into COLUMNS. What landed on the orders already in this database
 * answers the question without any new payload at all.
 *
 * THE CONTROL IS WHAT MAKES A ZERO MEAN SOMETHING. A column empty on every Eleme
 * order has two possible causes — the key list is wrong, or no customer ever
 * asked. Meituan fills the SAME columns through a DIFFERENT parser
 * (lib/meituan-order-fields.js) that is known to work, so it sits beside each
 * figure: Meituan carrying cutlery while Eleme never does is the parser, not the
 * customers. And `customer_note` is the control WITHIN Eleme — its key list is
 * one of the ones that matched (`remark`), so a populated note column alongside
 * an empty cutlery column says the pipe works and one list in it does not.
 *
 * WHAT A ZERO OVER A SMALL N DOES NOT PROVE. A column empty across four orders
 * is not evidence of anything, so the order count leads every line and the
 * verdict says so where the sample is thin.
 *
 * NO CUSTOMER DATA IS PRINTED. Counts only — how many orders carry a value,
 * never the value. `customer_note` is counted as present or absent and never
 * read out.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_parsed_fields.js
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

/* Each row is one parsed field: the column it lands in, the candidate list that
   fills it, and whether the candidate-key audit found that list matching any
   real key name. `note` is first and deliberately: its list DID match, so it is
   the proof that the pipe works at all. */
const FIELDS = [
  { label: 'customer note',   expr: "COALESCE(customer_note,'') != ''",  list: 'NOTE_KEYS',      audit: 'matched (remark)' },
  { label: 'cutlery asked',   expr: 'COALESCE(needs_cutlery,0) = 1',     list: 'CUTLERY_KEYS',   audit: 'matched nothing' },
  { label: 'pre-order time',  expr: 'channel_preorder_at IS NOT NULL',   list: 'BOOK_*_KEYS',    audit: 'matched nothing' },
  { label: 'shop discount',   expr: 'COALESCE(channel_discount,0) > 0',  list: 'SHOP_DISC/SUBSIDY', audit: 'path covers / nothing' },
  { label: 'settle amount',   expr: 'COALESCE(channel_settle_amount,0) > 0', list: 'INCOME_KEYS', audit: 'path covers' },
];

const CHANNELS = ['eleme', 'meituan'];

const totals = {};
for (const ch of CHANNELS) {
  totals[ch] = db.prepare(
    'SELECT COUNT(*) AS n, MIN(placed_at) AS first, MAX(placed_at) AS last FROM retail_orders WHERE channel = ?'
  ).get(ch);
}

console.log('orders on record');
for (const ch of CHANNELS) {
  const t = totals[ch];
  console.log(`  ${ch.padEnd(8)} ${String(t.n).padStart(6)}`
    + (t.n ? `   ${String(t.first || '').slice(0, 10)} → ${String(t.last || '').slice(0, 10)}` : ''));
}
console.log('');

if (!totals.eleme.n) {
  console.log('No Eleme orders at all. Nothing here can be concluded — the columns are empty');
  console.log('because there is nothing in them, not because a key list is wrong.');
  process.exit(0);
}

const W = 16;
console.log('field'.padEnd(W) + '  eleme          meituan        candidate list');
console.log('─'.repeat(W) + '  ─────────────  ─────────────  ' + '─'.repeat(30));

const suspects = [];
for (const f of FIELDS) {
  const got = {};
  for (const ch of CHANNELS) {
    got[ch] = db.prepare(
      `SELECT COUNT(*) AS n FROM retail_orders WHERE channel = ? AND ${f.expr}`
    ).get(ch).n;
  }
  const pct = (n, ch) => totals[ch].n ? ` (${Math.round(n / totals[ch].n * 100)}%)` : '';
  // The finding worth acting on: Eleme never, Meituan sometimes, through the
  // same column. One parser fills it and the other does not.
  if (got.eleme === 0 && got.meituan > 0) suspects.push(f);
  console.log(
    f.label.padEnd(W)
    + '  ' + (String(got.eleme) + pct(got.eleme, 'eleme')).padEnd(13)
    + '  ' + (String(got.meituan) + pct(got.meituan, 'meituan')).padEnd(13)
    + '  ' + f.list + ' — ' + f.audit);
}

console.log('');
console.log('────────────────────────────────────────────────────────────');

const thin = totals.eleme.n < 25;
if (!suspects.length) {
  console.log('Every field that Meituan fills, Eleme fills too. No candidate list is');
  console.log('provably wrong from what has landed on an order.');
} else {
  console.log(`${suspects.length} field(s) Meituan fills and Eleme NEVER has:`);
  for (const f of suspects) console.log(`  ${f.label}  →  ${f.list}`);
  console.log('');
  console.log('Both parsers write the same column, so the difference is the parser, not');
  console.log('the customers — unless the sample is too thin to say (below).');
  console.log('');
  console.log('To fix one: the real key name is in the order-detail shape digest, which');
  console.log('needs a DEEP capture (scripts/diagnose_eleme_candidate_keys.js says which');
  console.log('shapes are deep). Put it at the FRONT of the list, keep the guesses behind');
  console.log('it, and add a fixture using the real name — section H2 of');
  console.log('scripts/test_eleme_order_parse.js is the worked example.');
}

console.log('');
if (thin) {
  console.log(`⚠ THIN SAMPLE: ${totals.eleme.n} Eleme order(s). A column empty across that many`);
  console.log('  proves very little — some of these fields are rare even when they parse.');
  console.log('  Read the note row: if IT is populated, the pipe works and a zero beside it');
  console.log('  is worth more than the count suggests.');
} else {
  console.log(`Sample: ${totals.eleme.n} Eleme orders. A field never once present across that`);
  console.log('many, while Meituan has it, is a parser fault rather than a quiet feature.');
}
