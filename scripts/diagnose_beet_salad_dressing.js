#!/usr/bin/env node
/**
 * diagnose_beet_salad_dressing.js — why did TC000829 ship a Beet Salad with no
 * dressing recorded, when the dressing is supposed to be a required pick?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash, 2026-09-22: order TC000829 line 01 (Beet Salad, SKU 1-310) carries no
 * options at all, while line 02 on the same order carries two. The question is
 * whether the product is misconfigured, or whether an order path let the answer
 * through unanswered.
 *
 * READING THE CODE NARROWS IT TO FOUR CANDIDATES and cannot choose between
 * them, because every one of them turns on data this repo does not hold:
 *
 *   A. The question is not marked required. Then nothing is broken and the fix
 *      is one tick in the back office. Section 2 settles this first, because if
 *      it is the answer the other three do not matter.
 *   B. The order predates the question. An option added after the order was
 *      placed leaves earlier lines blank for ever — the snapshot is taken at
 *      order time and never backfilled. Section 2 prints created_at and
 *      section 3 prints placed_at, so the two can simply be compared.
 *   C. A client path that skips the product page. favorites.onAddAll() and
 *      home.onBundle() both call cart.add(p, 1, []) with no has_options check,
 *      and the mini-app cart is localStorage — a line added before the question
 *      existed keeps options:[] for ever, and reorder() copies it forward.
 *   D. The server never refused it. /api/retail/orders checks only
 *      checkOptionLimits(), which reads `type = 'multi' AND (min_choices > 0 OR
 *      max_choices > 0)` — so a REQUIRED SINGLE question is not checked at all
 *      by the customer checkout, unlike the QR menu and the till, which both go
 *      through lib/product-options.js resolveAnswers() and refuse with
 *      `choice_required`.
 *
 * C and D are not alternatives — D is what makes C reach the kitchen. Section 4
 * separates them by counting: if TC000829 is alone, it is one stale cart line;
 * if there are many and they span channels and dates, the open door is the
 * server's and the count is what it has cost.
 *
 * IT DECIDES NOTHING AND CHANGES NOTHING. Read-only, and it proves it: the
 * database is opened `readonly: true` and a write is attempted and REQUIRED to
 * fail before any query runs.
 *
 * HOW TO RUN IT
 *   .github/workflows/ro-query.yml (workflow_dispatch) with
 *     script = scripts/diagnose_beet_salad_dressing.js
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
  console.error(`[dressing] cannot open ${DB_PATH}: ${e && e.message}`);
  process.exit(1);
}
try {
  db.prepare('CREATE TABLE _dressing_write_probe (x INTEGER)').run();
  console.error('[dressing] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[dressing] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}

const hasTable = (t) => !!db.prepare(
  `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
const cols = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); }
                      catch { return []; } };
const has = (t, c) => cols(t).indexOf(c) >= 0;

out('db:           ' + DB_PATH);
out('run at (UTC): ' + new Date().toISOString());

// ===========================================================================
rule('1 . THE PRODUCT');
// The options table's FK names products(id), but every storefront read in
// routes/ goes through store_products. Look in both rather than assuming which
// id space this tenant's options actually live in.
const NAME_RE = 'beet';
const productTables = ['store_products', 'products'].filter(hasTable);
const found = [];           // { table, id, sku, name }
for (const t of productTables) {
  const c = cols(t);
  const nameCols = ['name_en', 'name_cn', 'name'].filter(x => c.indexOf(x) >= 0);
  if (!nameCols.length) continue;
  const where = nameCols.map(n => `LOWER(COALESCE(${n},'')) LIKE '%${NAME_RE}%'`).join(' OR ');
  const skuSel = c.indexOf('sku') >= 0 ? 'sku' : `'' AS sku`;
  const rows = db.prepare(
    `SELECT id, ${skuSel}, ${nameCols.map(n => `COALESCE(${n},'') AS ${n}`).join(', ')}
       FROM ${t} WHERE ${where} ORDER BY id`).all();
  for (const r of rows) {
    found.push({ table: t, id: r.id, sku: r.sku || '',
                 name: r.name_en || r.name || r.name_cn || '' });
  }
}
if (!found.length) {
  out('  No product matching "beet" in ' + productTables.join(' / ') + '.');
} else {
  out('  table            id     sku        name');
  for (const f of found) {
    out('  ' + f.table.padEnd(16) + String(f.id).padEnd(6) + ' '
        + String(f.sku).padEnd(10) + ' ' + f.name);
  }
}
// SKU 1-310 is what the order page printed under the line; pin on it too, in
// case the salad has been renamed since.
const skuHits = [];
for (const t of productTables) {
  if (!has(t, 'sku')) continue;
  for (const r of db.prepare(`SELECT id, sku FROM ${t} WHERE sku = '1-310'`).all()) {
    skuHits.push({ table: t, id: r.id, sku: r.sku });
  }
}
sub('by the SKU the order line printed (1-310)');
if (!skuHits.length) out('  no row with sku = 1-310');
else for (const h of skuHits) out('  ' + h.table + ' id=' + h.id);

const candidateIds = [...new Set([...found.map(f => f.id), ...skuHits.map(h => h.id)])];

// ===========================================================================
rule('2 . IS THE DRESSING QUESTION MARKED REQUIRED?  (candidate A)');
if (!hasTable('retail_product_options')) {
  out('  retail_product_options does not exist on this database.');
} else if (!candidateIds.length) {
  out('  no candidate product ids to look up.');
} else {
  const ph = candidateIds.map(() => '?').join(',');
  const oc = cols('retail_product_options');
  const createdSel = oc.indexOf('created_at') >= 0 ? 'created_at' : `'' AS created_at`;
  const opts = db.prepare(
    `SELECT id, product_id, question_en, question_cn, type, is_required,
            min_choices, max_choices, sort_order, ${createdSel}
       FROM retail_product_options WHERE product_id IN (${ph})
      ORDER BY product_id, sort_order, id`).all(...candidateIds);
  if (!opts.length) {
    out('  NO OPTION GROUPS AT ALL on these product ids.');
    out('  If the salad really does ask for a dressing on the menu, the question');
    out('  is hanging off a DIFFERENT id than the one the order line recorded —');
    out('  check section 1 for two ids with the same name.');
  } else {
    for (const o of opts) {
      out();
      out('  option #' + o.id + '  product_id=' + o.product_id
          + '  type=' + o.type
          + '  REQUIRED=' + (o.is_required ? 'YES' : 'no')
          + '  min=' + o.min_choices + ' max=' + o.max_choices
          + '  created=' + (o.created_at || '?'));
      out('    Q: ' + (o.question_en || '') + '  /  ' + (o.question_cn || ''));
      const ch = db.prepare(
        `SELECT id, label_en, label_cn, price_delta, is_default, stock_product_id
           FROM retail_product_option_choices WHERE option_id = ?
          ORDER BY sort_order, id`).all(o.id);
      if (!ch.length) out('    (NO CHOICES — a question with no answers is never asked)');
      for (const c of ch) {
        out('    choice #' + String(c.id).padEnd(6)
            + (c.label_en || '').padEnd(28)
            + (c.label_cn || '').padEnd(16)
            + ' delta=' + (Number(c.price_delta) || 0).toFixed(2)
            + (c.is_default ? ' [default]' : '')
            + (c.stock_product_id ? ' stock=' + c.stock_product_id : ''));
      }
    }
  }
}

// ===========================================================================
rule('3 . THE ORDER ITSELF  (candidate B)');
const ORDER_NO = 'TC000829';
if (!hasTable('retail_orders')) {
  out('  retail_orders does not exist.');
} else {
  const ordCols = cols('retail_orders');
  const pick = (n, d = `'' AS ${n}`) => ordCols.indexOf(n) >= 0 ? n : d;
  const o = db.prepare(
    `SELECT id, order_no, status, ${pick('channel')}, ${pick('source')},
            placed_at, ${pick('paid_at')}
       FROM retail_orders WHERE order_no = ?`).get(ORDER_NO);
  if (!o) {
    out('  ' + ORDER_NO + ' not found.');
  } else {
    out('  id=' + o.id + '  order_no=' + o.order_no + '  status=' + o.status);
    out('  channel=' + (o.channel || '?') + '  source=' + (o.source || '-'));
    out('  placed_at=' + o.placed_at + '  paid_at=' + (o.paid_at || '-'));
    sub('lines');
    const items = db.prepare(
      `SELECT id, product_id, sku, name_en, qty, unit_price, options_json
         FROM retail_order_items WHERE order_id = ? ORDER BY id`).all(o.id);
    for (const it of items) {
      let n = 0;
      try { n = (JSON.parse(it.options_json || '[]') || []).length; } catch { n = -1; }
      out('  item#' + String(it.id).padEnd(7)
          + 'pid=' + String(it.product_id).padEnd(7)
          + String(it.sku || '').padEnd(10)
          + String(it.name_en || '').padEnd(34)
          + ' x' + it.qty
          + '  options=' + (it.options_json == null ? 'NULL' : n + ' -> ' + it.options_json));
    }
    sub('did the question exist yet when this order was placed?');
    if (hasTable('retail_product_options') && has('retail_product_options', 'created_at')) {
      const pids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
      if (pids.length) {
        const ph2 = pids.map(() => '?').join(',');
        for (const r of db.prepare(
          `SELECT id, product_id, question_en, is_required, created_at
             FROM retail_product_options WHERE product_id IN (${ph2})
            ORDER BY product_id, id`).all(...pids)) {
          const later = String(r.created_at || '') > String(o.placed_at || '');
          out('  option #' + r.id + ' (pid ' + r.product_id + ', req='
              + (r.is_required ? 'Y' : 'n') + ') created ' + r.created_at
              + (later ? '   <-- AFTER the order was placed' : ''));
        }
      }
    } else {
      out('  (no created_at column on retail_product_options — cannot date it)');
    }
  }
}

// ===========================================================================
rule('4 . HOW WIDE IS THIS?  (candidates C and D)');
// Every paid line, for a product that carries a REQUIRED question, whose
// snapshot answers nothing for that question. One order is a stale cart line;
// many across dates and channels is the server door standing open.
if (!hasTable('retail_product_options') || !hasTable('retail_order_items')) {
  out('  tables missing; skipped.');
} else {
  const reqOpts = db.prepare(
    `SELECT id, product_id, question_en, type, is_required, min_choices
       FROM retail_product_options
      WHERE type IN ('single','multi') AND (is_required = 1 OR min_choices > 0)`).all();
  // A question with no choices is never asked — exclude it, exactly as both
  // the read and the write side of lib/product-options.js do.
  const live = reqOpts.filter(o => db.prepare(
    `SELECT COUNT(*) n FROM retail_product_option_choices WHERE option_id = ?`).get(o.id).n > 0);
  out('  required questions on file: ' + reqOpts.length
      + '  (with at least one choice: ' + live.length + ')');
  if (!live.length) {
    out('  Nothing required is configured anywhere, which is the whole answer:');
    out('  the salad is not asking, so no order could have answered.');
  } else {
    const byProduct = new Map();
    for (const o of live) {
      if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
      byProduct.get(o.product_id).push(o);
    }
    const pids = [...byProduct.keys()];
    const ph = pids.map(() => '?').join(',');
    const ordCols = cols('retail_orders');
    const chanSel = ordCols.indexOf('channel') >= 0 ? 'o.channel' : `'?'`;
    const rows = db.prepare(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.sku, oi.name_en, oi.options_json,
              o.order_no, o.status, o.placed_at, ${chanSel} AS channel
         FROM retail_order_items oi
         JOIN retail_orders o ON o.id = oi.order_id
        WHERE oi.product_id IN (${ph})
          AND o.status NOT IN ('cancelled','pending_payment')
        ORDER BY o.placed_at DESC`).all(...pids);
    out('  paid lines for products carrying a required question: ' + rows.length);

    const misses = [];
    for (const r of rows) {
      let answered = new Set();
      try {
        for (const a of (JSON.parse(r.options_json || '[]') || [])) {
          if (a && a.option_id != null) answered.add(Number(a.option_id));
        }
      } catch { /* unparseable snapshot counts as answering nothing */ }
      const unmet = (byProduct.get(r.product_id) || []).filter(o => !answered.has(o.id));
      if (unmet.length) misses.push({ ...r, unmet });
    }
    out('  of those, lines with a required question UNANSWERED: ' + misses.length);

    sub('by product');
    const perProd = new Map();
    for (const m of misses) {
      const k = m.product_id + ' | ' + (m.sku || '') + ' | ' + (m.name_en || '');
      perProd.set(k, (perProd.get(k) || 0) + 1);
    }
    for (const [k, n] of [...perProd.entries()].sort((a, b) => b[1] - a[1])) {
      out('  ' + String(n).padStart(5) + '  ' + k);
    }

    sub('by channel');
    const perChan = new Map();
    for (const m of misses) perChan.set(m.channel || '?', (perChan.get(m.channel || '?') || 0) + 1);
    for (const [k, n] of [...perChan.entries()].sort((a, b) => b[1] - a[1])) {
      out('  ' + String(n).padStart(5) + '  ' + k);
    }

    sub('most recent 30, newest first');
    for (const m of misses.slice(0, 30)) {
      out('  ' + String(m.placed_at || '').slice(0, 19).padEnd(20)
          + String(m.order_no || '').padEnd(11)
          + String(m.channel || '?').padEnd(9)
          + String(m.sku || '').padEnd(10)
          + String(m.name_en || '').padEnd(30)
          + ' missing: ' + m.unmet.map(u => '#' + u.id + ' "' + (u.question_en || '') + '"').join(', '));
    }

    sub('earliest and latest miss');
    if (misses.length) {
      const sorted = [...misses].sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)));
      out('  earliest: ' + sorted[0].placed_at + '  ' + sorted[0].order_no);
      out('  latest:   ' + sorted[sorted.length - 1].placed_at + '  ' + sorted[sorted.length - 1].order_no);
    }
  }
}


// ===========================================================================
rule('5 . THE HONEST NUMBER  (section 4 corrected)');
// SECTION 4 OVERCOUNTS AND MUST NOT BE READ AS A LEAK. It counts every paid
// line whose product carries a required question today, including two whole
// classes of line where answering nothing was CORRECT at the time:
//
//   * the line was placed BEFORE the question was created. The option snapshot
//     is taken at order time; an option added afterwards cannot appear on an
//     older line and its absence is not a failure. TC000829 is exactly this.
//   * the line came from a marketplace daemon (meituan / eleme / gzgrocery).
//     Those orders are imported from someone else's basket; our questions were
//     never put to that buyer, so there was no answer to record.
//
// What is left is the only figure that says whether the missing server-side
// check on /api/retail/orders has actually cost anything: a line placed after
// its question existed, on a channel that goes through our own checkout.
const OWN_CHANNELS = ['wechat', 'web', 'pickup', 'wechat_chat', 'manual'];
if (!hasTable('retail_product_options') || !hasTable('retail_order_items')
    || !has('retail_product_options', 'created_at')) {
  out('  tables or created_at missing; cannot correct the count.');
} else {
  const reqOpts = db.prepare(
    `SELECT id, product_id, question_en, type, is_required, min_choices, created_at
       FROM retail_product_options
      WHERE type IN ('single','multi') AND (is_required = 1 OR min_choices > 0)`).all();
  const live = reqOpts.filter(o => db.prepare(
    `SELECT COUNT(*) n FROM retail_product_option_choices WHERE option_id = ?`).get(o.id).n > 0);
  const byProduct = new Map();
  for (const o of live) {
    if (!byProduct.has(o.product_id)) byProduct.set(o.product_id, []);
    byProduct.get(o.product_id).push(o);
  }
  const pids = [...byProduct.keys()];
  if (!pids.length) {
    out('  nothing required is configured.');
  } else {
    const ph = pids.map(() => '?').join(',');
    const ordCols = cols('retail_orders');
    const chanSel = ordCols.indexOf('channel') >= 0 ? 'o.channel' : `'?'`;
    const rows = db.prepare(
      `SELECT oi.id, oi.product_id, oi.sku, oi.name_en, oi.options_json,
              o.order_no, o.status, o.placed_at, ${chanSel} AS channel
         FROM retail_order_items oi
         JOIN retail_orders o ON o.id = oi.order_id
        WHERE oi.product_id IN (${ph})
          AND o.status NOT IN ('cancelled','pending_payment')
        ORDER BY o.placed_at DESC`).all(...pids);

    let predate = 0, marketplace = 0;
    const realMisses = [];
    for (const r of rows) {
      const answered = new Set();
      try {
        for (const a of (JSON.parse(r.options_json || '[]') || [])) {
          if (a && a.option_id != null) answered.add(Number(a.option_id));
        }
      } catch { /* unparseable counts as answering nothing */ }
      // Only questions that ALREADY EXISTED when this line was placed can have
      // been skipped; the rest were not askable yet.
      const askable = (byProduct.get(r.product_id) || [])
        .filter(o => String(o.created_at || '') <= String(r.placed_at || ''));
      const unmetAll = (byProduct.get(r.product_id) || []).filter(o => !answered.has(o.id));
      if (!unmetAll.length) continue;
      const unmet = askable.filter(o => !answered.has(o.id));
      if (!unmet.length) { predate++; continue; }
      if (OWN_CHANNELS.indexOf(String(r.channel || '')) < 0) { marketplace++; continue; }
      realMisses.push({ ...r, unmet });
    }
    out('  excluded - line predates every question it "missed":  ' + String(predate).padStart(5));
    out('  excluded - marketplace channel (daemon-imported):     ' + String(marketplace).padStart(5));
    out('  REAL MISSES - our checkout, question already existed: ' + String(realMisses.length).padStart(5));

    if (realMisses.length) {
      sub('real misses by channel');
      const perChan = new Map();
      for (const m of realMisses) perChan.set(m.channel, (perChan.get(m.channel) || 0) + 1);
      for (const [k, n] of [...perChan.entries()].sort((a, b) => b[1] - a[1])) {
        out('  ' + String(n).padStart(5) + '  ' + k);
      }
      sub('real misses by product');
      const perProd = new Map();
      for (const m of realMisses) {
        const k = m.product_id + ' | ' + (m.sku || '') + ' | ' + (m.name_en || '');
        perProd.set(k, (perProd.get(k) || 0) + 1);
      }
      for (const [k, n] of [...perProd.entries()].sort((a, b) => b[1] - a[1])) {
        out('  ' + String(n).padStart(5) + '  ' + k);
      }
      sub('every real miss, newest first (max 60)');
      for (const m of realMisses.slice(0, 60)) {
        out('  ' + String(m.placed_at || '').slice(0, 19).padEnd(20)
            + String(m.order_no || '').padEnd(18)
            + String(m.channel || '?').padEnd(12)
            + String(m.sku || '').padEnd(10)
            + String(m.name_en || '').padEnd(32)
            + ' missing: ' + m.unmet.map(u => '#' + u.id + ' "' + (u.question_en || '') + '"').join(', '));
      }
    } else {
      out();
      out('  NONE. Every unanswered line is explained by one of the two exclusions');
      out('  above, so the missing required-check on /api/retail/orders is a hole');
      out('  that has not yet been fallen through - a fix to make, not damage to');
      out('  repair.');
    }
  }
}

out();
out('done.');
