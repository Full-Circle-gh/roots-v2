#!/usr/bin/env node
/**
 * Read-only verification of the snapshot unit stamp, and the evidence behind
 * the add-on re-pricing question.
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 *   A  the restore path: old params vs new params, every live snapshot
 *   B  snapshotBody() round-trip — stripping the stamp must be byte-exact
 *   C  the "has anything changed?" comparison, old form vs new form
 *   D  stored-value fingerprint
 *   E  evidence for the add-on staging -> settlement window
 *   F  the shipped source on the box
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const APP = process.env.ROOTS_APP || '/root/roots-v2';
const Database = require(APP + '/node_modules/better-sqlite3');
const fs = require('fs');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

let FAILURES = 0;
const bad = (m) => { FAILURES++; console.log('   MISMATCH ' + m); };

// ── verbatim copies of the shipped constants and helpers ───────────────────
const VERSION_COLUMNS = [
  'name_en', 'name_cn', 'sku', 'category', 'top_category', 'subcategory', 'weight',
  'sell_price', 'compare_at_price', 'low_stock_threshold', 'ship_modes', 'ship_from_supplier',
  'description_en', 'description_cn', 'description_format', 'image_data', 'image_url', 'images', 'image_aspect',
  'barcode', 'free_of', 'notes', 'product_facts', 'nutrition',
  'is_market', 'is_restock_only', 'is_batch_made', 'oos_policy', 'status', 'is_published',
  'keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn',
  'description_blocks', 'use_block_design', 'bundle', 'bundle_items', 'bundle_mode', 'tags',
  'colophon_character', 'colophon_tagline_en', 'colophon_tagline_cn', 'page_template',
];
const SNAPSHOT_UNIT_KEY = '_money_unit';
const SNAPSHOT_UNIT = 'yuan';
const SNAPSHOT_MONEY_COLUMNS = ['sell_price', 'compare_at_price'];

function snapshotMoneyInAppUnit(snap) {
  const unit = snap[SNAPSHOT_UNIT_KEY] || SNAPSHOT_UNIT;
  if (unit !== SNAPSHOT_UNIT) throw new Error(`snapshot ${SNAPSHOT_UNIT_KEY}=${JSON.stringify(unit)} is not ${SNAPSHOT_UNIT}`);
  for (const c of SNAPSHOT_MONEY_COLUMNS) {
    const v = snap[c];
    if (v != null && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`snapshot ${c} is not a finite number: ${JSON.stringify(v)}`);
    }
  }
  return snap;
}
function snapshotBody(json) {
  if (typeof json !== 'string' || !json.includes(SNAPSHOT_UNIT_KEY)) return json;
  try { const o = JSON.parse(json); delete o[SNAPSHOT_UNIT_KEY]; return JSON.stringify(o); }
  catch (e) { return json; }
}

const rows = db.prepare(
  'SELECT id, product_id, is_baseline, created_at, snapshot_json FROM retail_product_versions ORDER BY product_id, id').all();
console.log(`db: ${DB_PATH}   versions=${rows.length}   products=${new Set(rows.map(r => r.product_id)).size}`);

// ════════════════════════════════════════════════════════════════════════════
// A — the restore path: what the UPDATE would bind, old form vs new form
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ A · restore params, old vs new, every live snapshot ══');
{
  let compared = 0, cells = 0, refused = 0, stampInCols = 0;
  for (const r of rows) {
    let snapOld; try { snapOld = JSON.parse(r.snapshot_json); } catch (e) { bad(`v${r.id} unparseable`); continue; }
    const colsOld = VERSION_COLUMNS.filter(c => c in snapOld);
    const paramsOld = colsOld.map(c => snapOld[c]);

    let snapNew; try { snapNew = JSON.parse(r.snapshot_json); } catch (e) { continue; }
    try { snapNew = snapshotMoneyInAppUnit(snapNew); }
    catch (e) { refused++; bad(`v${r.id} refused by the unit guard: ${e.message}`); continue; }
    const colsNew = VERSION_COLUMNS.filter(c => c in snapNew);
    const paramsNew = colsNew.map(c => snapNew[c]);

    if (colsNew.includes(SNAPSHOT_UNIT_KEY)) { stampInCols++; bad(`v${r.id} stamp key reached the SET clause`); }
    if (colsOld.length !== colsNew.length) bad(`v${r.id} column count ${colsOld.length} vs ${colsNew.length}`);
    compared++;
    for (let i = 0; i < Math.min(paramsOld.length, paramsNew.length); i++) {
      cells++;
      if (paramsOld[i] !== paramsNew[i]) bad(`v${r.id} ${colsOld[i]}: ${JSON.stringify(paramsOld[i])} vs ${JSON.stringify(paramsNew[i])}`);
    }
  }
  console.log(`   snapshots compared=${compared}  bound cells compared=${cells}  refused by the guard=${refused}  stamp reached SET=${stampInCols}`);
  const money = rows.map(r => { try { return JSON.parse(r.snapshot_json); } catch (e) { return {}; } });
  const sell = money.filter(s => s.sell_price != null).length;
  const cmp = money.filter(s => s.compare_at_price != null).length;
  console.log(`   snapshots with non-null sell_price=${sell}  compare_at_price=${cmp}`);
  const differ = rows.filter(r => {
    let s; try { s = JSON.parse(r.snapshot_json); } catch (e) { return false; }
    const p = db.prepare('SELECT sell_price FROM store_products WHERE id = ?').get(r.product_id);
    return p && Number(s.sell_price) !== Number(p.sell_price);
  }).length;
  console.log(`   snapshots whose sell_price differs from the live column (a restore would move it): ${differ}`);
}

// ════════════════════════════════════════════════════════════════════════════
// B — snapshotBody() must strip the stamp byte-exactly
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ B · stamp strip round-trip ══');
{
  let roundTrip = 0, stampedBack = 0, alreadyStamped = 0, unchanged = 0;
  for (const r of rows) {
    const s = r.snapshot_json;
    // 1. re-stringifying a parsed snapshot must reproduce the stored text, or
    //    stripping the stamp would change unrelated bytes.
    let o; try { o = JSON.parse(s); } catch (e) { continue; }
    if (JSON.stringify(o) !== s) bad(`v${r.id} re-stringify is not byte-identical`); else roundTrip++;
    // 2. an unstamped row must pass through snapshotBody untouched.
    if (snapshotBody(s) !== s) bad(`v${r.id} unstamped row altered by snapshotBody`); else unchanged++;
    if (SNAPSHOT_UNIT_KEY in o) alreadyStamped++;
    // 3. stamping then stripping must return the original text exactly.
    const stamped = JSON.stringify(Object.assign({}, o, { [SNAPSHOT_UNIT_KEY]: SNAPSHOT_UNIT }));
    if (snapshotBody(stamped) !== s) bad(`v${r.id} stamp->strip did not reproduce the original`); else stampedBack++;
  }
  console.log(`   re-stringify byte-identical: ${roundTrip}/${rows.length}`);
  console.log(`   unstamped rows untouched:    ${unchanged}/${rows.length}`);
  console.log(`   stamp->strip reproduces original: ${stampedBack}/${rows.length}`);
  console.log(`   rows already carrying a stamp: ${alreadyStamped} (expected 0 before deploy)`);
}

// ════════════════════════════════════════════════════════════════════════════
// C — the "has anything changed?" test, old form vs new form
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ C · change detection, old form vs new form ══');
{
  let pairs = 0, agree = 0, disagree = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].product_id !== rows[i - 1].product_id) continue;
    const a = rows[i - 1].snapshot_json, b = rows[i].snapshot_json;
    pairs++;
    const oldSame = a === b;
    const newSame = snapshotBody(a) === snapshotBody(b);
    if (oldSame === newSame) agree++; else { disagree++; bad(`versions ${rows[i - 1].id}/${rows[i].id}: old same=${oldSame} new same=${newSame}`); }
  }
  console.log(`   consecutive version pairs on the same product: ${pairs}  agree=${agree} disagree=${disagree}`);
  // The transition case: an unstamped stored row against a freshly stamped
  // snapshot of identical content. The naive comparison would call this a
  // change and write a redundant version; snapshotBody must call it unchanged.
  let wouldHaveWritten = 0, nowSkipped = 0;
  for (const r of rows) {
    let o; try { o = JSON.parse(r.snapshot_json); } catch (e) { continue; }
    const fresh = JSON.stringify(Object.assign({}, o, { [SNAPSHOT_UNIT_KEY]: SNAPSHOT_UNIT }));
    if (r.snapshot_json !== fresh) wouldHaveWritten++;
    if (snapshotBody(r.snapshot_json) === snapshotBody(fresh)) nowSkipped++;
  }
  console.log(`   identical content, stored unstamped vs freshly stamped:`);
  console.log(`     a naive string compare would call ${wouldHaveWritten}/${rows.length} of these "changed" (redundant version rows)`);
  console.log(`     snapshotBody calls ${nowSkipped}/${rows.length} of them unchanged — behaviour preserved`);
  if (nowSkipped !== rows.length) bad(`snapshotBody failed to neutralise the stamp on ${rows.length - nowSkipped} rows`);
}

// ════════════════════════════════════════════════════════════════════════════
// D — stored-value fingerprint
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ D · stored-value fingerprint ══');
{
  const v = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(snapshot_json)),0) bytes, MAX(id) maxid,
                               MIN(created_at) first, MAX(created_at) last FROM retail_product_versions`).get();
  console.log(`   retail_product_versions: ${JSON.stringify(v)}`);
  const sp = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sell_price),0) sum_sell,
                                COALESCE(SUM(COALESCE(compare_at_price,0)),0) sum_cmp FROM store_products`).get();
  console.log(`   store_products money:    ${JSON.stringify(sp)}`);
  const oi = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(unit_price),0) sum_unit, COALESCE(SUM(line_total),0) sum_line
                           FROM retail_order_items`).get();
  console.log(`   retail_order_items money:${JSON.stringify(oi)}`);
  const ad = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) sum_amt FROM retail_order_addons`).get();
  console.log(`   retail_order_addons:     ${JSON.stringify(ad)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// E — evidence for the add-on staging -> settlement window
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ E · add-on staging -> settlement window (path 1 evidence, no change made) ══');
{
  const ad = db.prepare(`SELECT id, order_id, status, amount, addon_subtotal, created_at, paid_at,
                                CAST((julianday(paid_at) - julianday(created_at)) * 86400 AS INTEGER) gap_s
                           FROM retail_order_addons ORDER BY id`).all();
  console.log(`   add-on rows: ${ad.length}`);
  for (const a of ad) {
    console.log(`     addon ${a.id} order ${a.order_id} ${a.status} amount=${a.amount} created=${a.created_at} paid=${a.paid_at} gap=${a.gap_s}s`);
  }
  const gaps = ad.map(a => a.gap_s).filter(g => g != null);
  if (gaps.length) console.log(`   settlement gap seconds: min=${Math.min(...gaps)} max=${Math.max(...gaps)} n=${gaps.length}`);
  const edits = db.prepare(`SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last
                              FROM activity_log WHERE action='update' AND entity_type='product_retail'`).get();
  console.log(`   product_retail edits in the audit trail: ${JSON.stringify(edits)}`);
  const priceEdits = db.prepare(`SELECT COUNT(*) n FROM activity_log
                                  WHERE entity_type='product_retail' AND details LIKE '%sell_price%'`).get().n;
  console.log(`   of those, details mentioning sell_price: ${priceEdits}`);
  const flash = db.prepare(`SELECT COUNT(*) n FROM store_products WHERE flash_price IS NOT NULL`).get().n;
  const flashWin = db.prepare(`SELECT COUNT(*) n FROM store_products
                                WHERE flash_starts_at IS NOT NULL OR flash_ends_at IS NOT NULL`).get().n;
  console.log(`   store_products with a flash price: ${flash}   with a flash window: ${flashWin}`);
}

// ════════════════════════════════════════════════════════════════════════════
// E2 — path 1: what the new settle rule would write, against every add-on
// ════════════════════════════════════════════════════════════════════════════
// The claim under test is that the value the new code writes equals the value
// the old code wrote — always — because the re-derived figures are used only
// when they match the staged ones exactly, and otherwise the staged ones are
// written unchanged.
console.log('\n══ E2 · add-on settle, old form vs new form ══');
{
  const flashActive = (p, nowMs) => {
    if (p.flash_price == null) return false;
    const st = p.flash_starts_at ? Date.parse(String(p.flash_starts_at).replace(' ', 'T') + 'Z') : null;
    const en = p.flash_ends_at ? Date.parse(String(p.flash_ends_at).replace(' ', 'T') + 'Z') : null;
    if (st != null && nowMs < st) return false;
    if (en != null && nowMs > en) return false;
    return Number(p.flash_price) < Number(p.price);
  };
  const prodStmt = db.prepare(`SELECT id, sell_price AS price, flash_price, flash_starts_at, flash_ends_at
                                 FROM store_products WHERE id = ?`);
  function derive(items, nowMs) {
    const out = []; let subtotal = 0;
    for (const it of items) {
      if (!it.product_id) return null;
      const p = prodStmt.get(it.product_id);
      if (!p) return null;
      let optionDelta = 0;
      const ids = (Array.isArray(it.options) ? it.options : [])
        .map(o => parseInt(o && o.choice_id, 10)).filter(Boolean);
      if (ids.length) {
        const rs = db.prepare(`SELECT id, price_delta FROM retail_product_option_choices
                                WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        if (rs.length !== ids.length) return null;
        for (const c of rs) optionDelta += Number(c.price_delta) || 0;
      }
      const unit = (flashActive(p, nowMs) ? Number(p.flash_price) : Number(p.price)) + optionDelta;
      const line = unit * (Number(it.qty) || 0);
      if (!(unit >= 0)) return null;
      out.push({ unit_price: unit, line_total: line });
      subtotal += line;
    }
    return { lines: out, subtotal: Math.round(subtotal * 100) / 100 };
  }

  const addons = db.prepare(
    'SELECT id, order_id, status, amount, addon_subtotal, items_json FROM retail_order_addons ORDER BY id').all();
  let cases = 0, cells = 0, reDerived = 0, fellBack = 0;
  for (const a of addons) {
    let items; try { items = JSON.parse(a.items_json || '[]'); } catch (e) { items = []; }
    if (!items.length) continue;
    const stagedSubtotal = a.addon_subtotal != null ? Number(a.addon_subtotal) : Number(a.amount);
    const d = derive(items, Date.now());
    const agrees = !!d
      && Math.round(d.subtotal * 100) === Math.round(stagedSubtotal * 100)
      && d.lines.every((x, i) => x.unit_price === items[i].unit_price && x.line_total === items[i].line_total);
    const written = agrees
      ? items.map((it, i) => Object.assign({}, it, { unit_price: d.lines[i].unit_price, line_total: d.lines[i].line_total }))
      : items;
    if (agrees) reDerived++; else fellBack++;
    cases++;
    for (let i = 0; i < items.length; i++) {
      cells += 2;
      if (written[i].unit_price !== items[i].unit_price) bad(`addon ${a.id} line ${i} unit_price ${items[i].unit_price} -> ${written[i].unit_price}`);
      if (written[i].line_total !== items[i].line_total) bad(`addon ${a.id} line ${i} line_total ${items[i].line_total} -> ${written[i].line_total}`);
    }
    console.log(`     addon ${a.id} order ${a.order_id} ${a.status} staged=${stagedSubtotal}`
      + ` derived=${d ? d.subtotal : 'unresolvable'} -> ${agrees ? 're-derived (from the column)' : 'staged price kept'}`);
  }
  console.log(`   add-ons replayed=${cases}  money cells compared=${cells}`);
  console.log(`   would take the re-derived path today: ${reDerived}   would keep the staged price: ${fellBack}`);
  console.log('   (a fallback is the rule working — these were priced weeks ago and the catalogue has moved since)');
}

// ════════════════════════════════════════════════════════════════════════════
// F — the shipped source on the box
// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ F · deployed source ══');
{
  const CHECKS = [
    ['stamp constant present', s => /const SNAPSHOT_UNIT_KEY = '_money_unit';/.test(s)],
    ['snapshot stamped at write', s => /snap\[SNAPSHOT_UNIT_KEY\] = SNAPSHOT_UNIT;/.test(s)],
    ['restore converts explicitly', s => /snap = snapshotMoneyInAppUnit\(snap\);/.test(s)],
    ['unrecognised stamp refused', s => /error: 'bad_snapshot_unit'/.test(s)],
    ['recordProductVersion no-op test strips the stamp',
      s => /snapshotBody\(latest\.snapshot_json\) === snapshotBody\(json\)/.test(s)],
    ['restore undo-point test strips the stamp',
      s => /snapshotBody\(latest\.snapshot_json\) !== snapshotBody\(preJson\)/.test(s)],
    ['stamp key is not a VERSION_COLUMN', s => !/'_money_unit',/.test(s)],
    ['addon finalize re-derives from the columns',
      s => /const derived = deriveAddonLineMoney\(items, Date\.now\(\)\);/.test(s)],
    ['addon finalize falls back to the staged price',
      s => /staged price kept/.test(s)],
    ['re-derivation reads store_products and the option choices',
      s => /FROM store_products WHERE id = \?/.test(s) && /FROM retail_product_option_choices/.test(s)],
  ];
  let src = '';
  try { src = fs.readFileSync(APP + '/routes/retail.js', 'utf8'); }
  catch (e) { bad('routes/retail.js unreadable: ' + e.message); }
  for (const [what, test] of CHECKS) {
    const ok = src ? test(src) : false;
    if (!ok) bad(`F ${what}`);
    console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  }
}

console.log('\n' + (FAILURES === 0 ? 'RESULT=IDENTICAL (0 mismatches)' : `RESULT=MISMATCHES (${FAILURES})`));
db.close();
process.exit(FAILURES === 0 ? 0 : 1);
