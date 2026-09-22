#!/usr/bin/env node
/**
 * diagnose_option_wipe.js — were product questions DELETED and recreated, and
 * did that empty order lines that used to carry an answer?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-22, on TC000829's Beet Salad line showing no dressing:
 * "it was never empty before that you got wrong".
 *
 * He is right that the earlier diagnostic could not have seen it. That script
 * asked "does this line's snapshot answer a question that is required TODAY",
 * and scored a line as a miss whenever it did not. A question that was DELETED
 * and RECREATED comes back with a NEW id, so every older line — which answered
 * the OLD id, correctly, and still carries that answer in its snapshot — scores
 * as a miss and then lands in the "line predates the question" bucket, because
 * the new row's created_at really is later than the order. The two mistakes
 * hide each other and the output looks clean.
 *
 * THE SNAPSHOT IS THE EVIDENCE AND IT IS NOT AMBIGUOUS. retail_order_items
 * .options_json stores label, question and ids as they stood at order time, so
 * a line that once carried "Choose Dressing: Ginger Tahini" still says so
 * whatever happened to the option row afterwards. This reads the raw column
 * rather than joining to anything.
 *
 * WHAT IT ASKS, in order:
 *   1. Every Beet Salad line ever, raw options_json, newest first. If past
 *      lines carry a dressing and recent ones do not, "never empty before" is
 *      settled as fact and the window where it went empty is visible.
 *   2. Which option ids Beet Salad snapshots reference, and which of those
 *      still exist. A referenced id with no row is a DELETED question.
 *   3. created_at histogram of every option row on file. A recreate shows up
 *      as a cluster of rows all stamped within a few minutes of each other.
 *   4. The same dangling-id test across the whole catalogue, and, for each
 *      product, when its snapshots last referenced a now-dead option against
 *      when its current options were created — i.e. which products lost their
 *      questions and for how long they had none.
 *   5. Products carrying NO options at all today whose recent lines answered
 *      one. Those are the ones still broken right now.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Read-only, and it proves it: the
 * database is opened `readonly: true` and a write is attempted and REQUIRED to
 * fail before any query runs.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_option_wipe.js
 *   Dispatch it against THIS BRANCH — the workflow checks out the ref it is
 *   given, and this file does not exist on main.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

const out = (s = '') => console.log(s);
const rule = (t) => { out(); out('='.repeat(78)); out(t); out('='.repeat(78)); };
const sub = (t) => { out(); out('-- ' + t + ' ' + '-'.repeat(Math.max(0, 74 - t.length))); };

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`[wipe] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _wipe_write_probe (x INTEGER)').run();
  console.error('[wipe] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[wipe] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

const parseOpts = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; }
                           catch { return []; } };

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

const BEET = 71;

// ===========================================================================
rule('1 . EVERY BEET SALAD LINE, RAW SNAPSHOT, NEWEST FIRST');
const beetLines = db.prepare(
  `SELECT oi.id, oi.options_json, o.order_no, o.placed_at, o.status,
          COALESCE(o.channel,'?') AS channel
     FROM retail_order_items oi
     JOIN retail_orders o ON o.id = oi.order_id
    WHERE oi.product_id = ?
    ORDER BY o.placed_at DESC`).all(BEET);
out('  lines for product ' + BEET + ': ' + beetLines.length);
let beetEmpty = 0, beetFilled = 0;
for (const l of beetLines) {
  const a = parseOpts(l.options_json);
  if (!a.length) beetEmpty++; else beetFilled++;
}
out('  with at least one recorded answer: ' + beetFilled);
out('  with NOTHING recorded:             ' + beetEmpty);
sub('newest 40, verbatim');
for (const l of beetLines.slice(0, 40)) {
  const a = parseOpts(l.options_json);
  const summary = !a.length
    ? (l.options_json == null ? '*** NULL ***' : '*** EMPTY ***')
    : a.map(x => (x.question_en || '?') + ': ' + (x.label || '?') + ' [opt#' + x.option_id + ']').join('  |  ');
  out('  ' + String(l.placed_at || '').slice(0, 19).padEnd(20)
      + String(l.order_no || '').padEnd(18)
      + String(l.channel).padEnd(11)
      + String(l.status || '').padEnd(12) + summary);
}

// ===========================================================================
rule('2 . WHICH OPTION IDS DO BEET SALAD SNAPSHOTS REFERENCE, AND DO THEY EXIST?');
const beetRef = new Map();   // option_id -> { q, n, first, last }
for (const l of beetLines) {
  for (const a of parseOpts(l.options_json)) {
    const k = Number(a.option_id);
    if (!Number.isFinite(k)) continue;
    if (!beetRef.has(k)) beetRef.set(k, { q: a.question_en || '', n: 0, first: l.placed_at, last: l.placed_at });
    const r = beetRef.get(k);
    r.n++;
    if (String(l.placed_at) < String(r.first)) r.first = l.placed_at;
    if (String(l.placed_at) > String(r.last)) r.last = l.placed_at;
  }
}
if (!beetRef.size) out('  no snapshot on any Beet Salad line references an option id.');
for (const [id, r] of [...beetRef.entries()].sort((a, b) => a[0] - b[0])) {
  const row = db.prepare(
    `SELECT id, product_id, question_en, is_required, created_at
       FROM retail_product_options WHERE id = ?`).get(id);
  out('  opt#' + String(id).padEnd(7)
      + ('"' + r.q + '"').padEnd(26)
      + 'used ' + String(r.n).padStart(4) + 'x  '
      + String(r.first).slice(0, 10) + ' .. ' + String(r.last).slice(0, 10) + '  '
      + (row ? ('STILL EXISTS (pid ' + row.product_id + ', created ' + row.created_at + ')')
             : '*** DELETED - no such option row ***'));
}
sub('what product 71 carries RIGHT NOW');
for (const o of db.prepare(
  `SELECT id, question_en, type, is_required, created_at FROM retail_product_options
    WHERE product_id = ? ORDER BY id`).all(BEET)) {
  out('  opt#' + String(o.id).padEnd(7) + ('"' + (o.question_en || '') + '"').padEnd(26)
      + o.type.padEnd(8) + (o.is_required ? 'REQUIRED' : 'optional').padEnd(10)
      + 'created ' + o.created_at);
}

// ===========================================================================
rule('3 . WHEN WAS EVERY OPTION ROW CREATED?  (a recreate is a cluster)');
const hist = db.prepare(
  `SELECT substr(created_at,1,16) AS minute, COUNT(*) n
     FROM retail_product_options
    GROUP BY minute ORDER BY minute DESC LIMIT 40`).all();
out('  newest 40 distinct creation minutes:');
for (const h of hist) out('  ' + String(h.minute).padEnd(20) + String(h.n).padStart(5) + ' option rows');
const total = db.prepare('SELECT COUNT(*) n FROM retail_product_options').get().n;
out('  total option rows on file: ' + total);

// ===========================================================================
rule('4 . DANGLING OPTION IDS ACROSS THE WHOLE CATALOGUE');
// Every option id any snapshot ever recorded, against the rows that exist now.
const allLines = db.prepare(
  `SELECT oi.product_id, oi.options_json, o.placed_at, o.order_no
     FROM retail_order_items oi
     JOIN retail_orders o ON o.id = oi.order_id
    WHERE oi.options_json IS NOT NULL AND oi.options_json != ''`).all();
const refByOpt = new Map();
for (const l of allLines) {
  for (const a of parseOpts(l.options_json)) {
    const k = Number(a.option_id);
    if (!Number.isFinite(k)) continue;
    if (!refByOpt.has(k)) refByOpt.set(k, { pid: l.product_id, q: a.question_en || '', n: 0, last: l.placed_at });
    const r = refByOpt.get(k);
    r.n++;
    if (String(l.placed_at) > String(r.last)) r.last = l.placed_at;
  }
}
const liveIds = new Set(db.prepare('SELECT id FROM retail_product_options').all().map(r => r.id));
const dangling = [...refByOpt.entries()].filter(([id]) => !liveIds.has(id));
out('  distinct option ids referenced by snapshots: ' + refByOpt.size);
out('  of those, NO LONGER EXIST (deleted):         ' + dangling.length);
sub('deleted options, by how recently a live order used one (newest 40)');
for (const [id, r] of dangling.sort((a, b) => String(b[1].last).localeCompare(String(a[1].last))).slice(0, 40)) {
  out('  opt#' + String(id).padEnd(7) + 'pid=' + String(r.pid).padEnd(7)
      + ('"' + r.q + '"').padEnd(30)
      + 'used ' + String(r.n).padStart(4) + 'x  last ' + String(r.last).slice(0, 19));
}

// ===========================================================================
rule('5 . WHICH PRODUCTS LOST A QUESTION, AND HAVE THEY GOT ONE BACK?');
const perProduct = new Map();
for (const [id, r] of dangling) {
  if (!perProduct.has(r.pid)) perProduct.set(r.pid, { dead: [], last: r.last });
  const p = perProduct.get(r.pid);
  p.dead.push({ id, q: r.q, n: r.n, last: r.last });
  if (String(r.last) > String(p.last)) p.last = r.last;
}
out('  products with at least one deleted question: ' + perProduct.size);
sub('per product: dead questions, what it carries now, and the gap');
const nameOf = (pid) => {
  for (const t of ['store_products', 'products']) {
    try {
      const r = db.prepare(`SELECT name_en FROM ${t} WHERE id = ?`).get(pid);
      if (r && r.name_en) return r.name_en;
    } catch { /* table or column absent */ }
  }
  return '(unknown)';
};
const ordered = [...perProduct.entries()].sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)));
for (const [pid, p] of ordered.slice(0, 40)) {
  const now = db.prepare(
    `SELECT id, question_en, is_required, created_at FROM retail_product_options
      WHERE product_id = ? ORDER BY id`).all(pid);
  out();
  out('  pid ' + pid + '  ' + nameOf(pid));
  out('    dead:  ' + p.dead.map(d => '#' + d.id + ' "' + d.q + '" (' + d.n + 'x, last ' + String(d.last).slice(0, 16) + ')').join('; '));
  if (!now.length) {
    out('    now:   *** NO OPTIONS AT ALL - still asking nothing ***');
  } else {
    out('    now:   ' + now.map(o => '#' + o.id + ' "' + (o.question_en || '') + '"'
        + (o.is_required ? ' REQ' : '') + ' created ' + o.created_at).join('; '));
    // The window with no question: last order that answered a dead one, to the
    // moment the replacement row appeared.
    const earliestNew = now.map(o => String(o.created_at || '')).sort()[0];
    if (earliestNew > String(p.last)) {
      const gapLines = db.prepare(
        `SELECT COUNT(*) n FROM retail_order_items oi JOIN retail_orders o ON o.id = oi.order_id
          WHERE oi.product_id = ? AND o.placed_at > ? AND o.placed_at < ?
            AND o.status NOT IN ('cancelled','pending_payment')
            AND (oi.options_json IS NULL OR oi.options_json = '' OR oi.options_json = '[]')`
      ).get(pid, p.last, earliestNew).n;
      out('    GAP:   ' + String(p.last).slice(0, 19) + '  ->  ' + earliestNew
          + '   (' + gapLines + ' paid line(s) recorded nothing in that window)');
    }
  }
}

out();
out('done.');
