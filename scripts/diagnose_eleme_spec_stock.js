#!/usr/bin/env node
/**
 * diagnose_eleme_spec_stock.js — the Eleme catalogue read PER STOCK BOX, not
 * per listing, with who claims each box and what its number should be.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_spec_stock.js
 *   STORE_CODE env var, default tianhe.
 *
 * READ-ONLY, AND IT PROVES IT. Opened `readonly: true, fileMustExist: true`,
 * with a write attempted and REQUIRED to fail before a single row is read; a
 * connection that accepts the write aborts with exit 2. No UPDATE, DELETE,
 * INSERT, ALTER or CREATE except that one probe, which exists to be rejected.
 * Nothing is written, enqueued, pushed or restarted.
 *
 * WHY LISTING-LEVEL IS THE WRONG UNIT
 * -----------------------------------
 * eleme_catalogue_cache.stock is ONE number for a listing that may hold several
 * stock boxes. Eleme sells per box (规格), our map claims per box (spec_id), and
 * lib/eleme-browser.js writes per box — so a comparison against the listing
 * figure cannot see a listing whose boxes disagree, and cannot see a box nothing
 * claims. The per-box truth is in the `specs` JSON column, and that is what this
 * reads.
 *
 * THE THREE STATES THAT MATTER, and why each is a fault:
 *
 *   UNCLAIMED BOX — no eleme_product_map row carries its specGlobalId. Nothing
 *     will ever push a real number to it. It keeps whatever the merchant first
 *     typed (commonly 10000) or whatever the guess below wrote, and sells on
 *     that figure forever.
 *
 *   PARTIALLY CLAIMED LISTING — some boxes claimed, some not. The claimed ones
 *     track stock; the rest do not. Worse than none claimed, because the listing
 *     looks maintained.
 *
 *   spec_key = '' ON A MULTI-BOX LISTING — the mapping says "the listing as a
 *     whole" about a thing that has no whole. lib/eleme-browser.js:876-889 then
 *     takes the GUESS branch: `N >= 3` writes 9999 to EVERY box. That is almost
 *     certainly where a 9999 comes from, and this script counts them.
 *
 * THE SKU-IN-SPEC-NAME PATTERN IS TESTED, NOT ASSUMED
 * ---------------------------------------------------
 * A bracketed number in a spec name — "150g (2420)" — looks like one of our
 * SKUs with its hyphen dropped (2420 -> 2-420). That is an inference from two
 * examples, so this does not rely on it: it extracts every bracketed token in
 * the catalogue, tries several normalisations against store_products.sku, and
 * REPORTS THE HIT RATE for each. If the pattern does not hold the numbers say
 * so, rather than a guess being presented as a mapping.
 *
 * Claim matching is by (eleme_name = cache.name) then (spec_id = specGlobalId),
 * which is exactly how scripts/eleme-daemon.js:526-537 resolves a push target —
 * name first, then the operator's chosen box. Matching any other way would grade
 * a different question from the one the daemon asks.
 *
 * EXIT CODES
 *   0  ran
 *   2  REFUSED: a connection accepted a write, or the database could not be read.
 */
'use strict';

const path = require('path');

const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const STORE_CODE = process.env.STORE_CODE || 'tianhe';
// Figures Eleme/merchants use as "effectively unlimited". Counted, not assumed
// to be the only ones — the histogram below shows every high value found.
const DEFAULTISH = new Set([9999, 10000]);

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const NOW = Date.now();
const J = v => (v === null || v === undefined ? 'NULL' : String(v));
function shanghai(s) {
  if (s == null) return '—';
  const t = Date.parse(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t)
    ? new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08' : '—';
}
function section(t) { console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n'); }

console.log('diagnose_eleme_spec_stock.js — per-BOX catalogue read, claims, and real numbers');
console.log('store_code:      ' + STORE_CODE);
console.log('READ AT (UTC):   ' + new Date(NOW).toISOString());
console.log('READ AT (+08):   ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('db:              ' + DB_PATH);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error('FATAL: cannot open ' + DB_PATH + ': ' + e.message); process.exit(2); }

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('\nread-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.log('   QUERY FAILED: ' + e.message); return []; } };

// ── load ────────────────────────────────────────────────────────────────────
const listings = all(
  `SELECT id, store_code, name, item_global_id, stock, specs, updated_at
     FROM eleme_catalogue_cache WHERE store_code = ? ORDER BY name`, STORE_CODE);

const maps = all(
  `SELECT m.id, m.product_id, m.retail_store_id, m.store_code, m.eleme_name,
          m.spec_id, m.spec_name, m.spec_key, m.units_per_pack, m.sync_enabled,
          m.last_pushed_qty, m.last_pushed_at,
          p.sku, p.name_cn, p.name_en, p.is_active,
          (SELECT ss.physical_qty FROM retail_store_stock ss
            WHERE ss.product_id = m.product_id AND ss.store_id = m.retail_store_id) AS physical_qty
     FROM eleme_product_map m
     LEFT JOIN store_products p ON p.id = m.product_id
    WHERE m.store_code = ? ORDER BY m.id`, STORE_CODE);

const products = all('SELECT id, sku, name_cn, name_en, is_active FROM store_products');

// Every SKU, under several normalisations, so a bracketed token can be tested
// against each rule rather than one guessed rule.
const skuExact = new Map();      // '4-650'  -> product
const skuStripped = new Map();   // '4650'   -> product   (non-alphanumerics removed)
for (const p of products) {
  const s = String(p.sku == null ? '' : p.sku).trim();
  if (!s) continue;
  if (!skuExact.has(s)) skuExact.set(s, p);
  const stripped = s.replace(/[^0-9a-zA-Z]/g, '');
  if (stripped && !skuStripped.has(stripped)) skuStripped.set(stripped, p);
}

// specs JSON -> array of boxes. Never pattern-matched out of the text.
function boxesOf(row) {
  let a = null;
  try { a = JSON.parse(row.specs); } catch (e) { return null; }
  return Array.isArray(a) ? a : null;
}
const specIdOf = b => String((b && (b.specGlobalId || b.skuGlobalId)) || '');

// Claims indexed by listing name, then by the box id the operator picked.
const claimsByName = new Map();
for (const m of maps) {
  const n = String(m.eleme_name == null ? '' : m.eleme_name);
  if (!claimsByName.has(n)) claimsByName.set(n, []);
  claimsByName.get(n).push(m);
}
const claimKey = m => String((m.spec_id || m.spec_key || '')).trim();

// ════════════════════════════════════════════════════════════════════════════
section('4 · THE SCALE — is this a handful or most of the shop?');
let multi = 0, single = 0, unparsed = 0, totalBoxes = 0, boxesDefaultish = 0, boxesMultiDefaultish = 0;
const highHist = new Map();
for (const L of listings) {
  const b = boxesOf(L);
  if (!b) { unparsed++; continue; }
  totalBoxes += b.length;
  if (b.length > 1) multi++; else single++;
  for (const box of b) {
    const s = Number(box && box.stock);
    if (DEFAULTISH.has(s)) { boxesDefaultish++; if (b.length > 1) boxesMultiDefaultish++; }
    if (Number.isFinite(s) && s >= 1000) highHist.set(s, (highHist.get(s) || 0) + 1);
  }
}
console.log(`   cached listings for ${STORE_CODE}          : ${listings.length}`);
console.log(`     of which MULTI-spec (>1 box)          : ${multi}`);
console.log(`     of which single-spec                  : ${single}`);
console.log(`     specs column unparseable/absent       : ${unparsed}`);
console.log(`   total stock BOXES across all listings   : ${totalBoxes}`);
console.log(`   boxes showing 9999 or 10000             : ${boxesDefaultish}`
  + `  (${totalBoxes ? Math.round(boxesDefaultish * 1000 / totalBoxes) / 10 : 0}% of boxes)`);
console.log(`     of those, on MULTI-spec listings      : ${boxesMultiDefaultish}`);
console.log('\n   every stock value >= 1000 found, with how many boxes carry it');
console.log('   (9999 is the guess constant in lib/eleme-browser.js:879; 10000 is the');
console.log('    maxStock default at :911 and the usual merchant-typed figure)');
for (const [v, n] of Array.from(highHist.entries()).sort((a, b) => b[1] - a[1])) {
  console.log(`     stock=${String(v).padEnd(8)} boxes=${n}`);
}

// ════════════════════════════════════════════════════════════════════════════
section('1+2+3 · EVERY MULTI-SPEC LISTING — box by box, with claims and real numbers');
const unclaimedBoxes = [];
const partial = [];
const wholeOnMulti = [];

let shown = 0;
for (const L of listings) {
  const boxes = boxesOf(L);
  if (!boxes || boxes.length <= 1) continue;
  shown++;
  const cl = claimsByName.get(String(L.name)) || [];
  const byBox = new Map();
  const wholeRows = [];
  for (const m of cl) {
    const k = claimKey(m);
    if (!k) { wholeRows.push(m); continue; }
    if (!byBox.has(k)) byBox.set(k, []);
    byBox.get(k).push(m);
  }

  const claimedCount = boxes.filter(b => byBox.has(specIdOf(b))).length;
  const state = claimedCount === 0 ? 'NO BOX CLAIMED'
    : claimedCount === boxes.length ? 'all boxes claimed'
    : `PARTIAL — ${claimedCount}/${boxes.length} claimed`;

  console.log(`\n   ── ${L.name}`);
  console.log(`      cache id=${J(L.id)} item_global_id=${J(L.item_global_id)} listing-level stock=${J(L.stock)}`
    + `  boxes=${boxes.length}  [${state}]`);
  console.log(`      catalogue read ${shanghai(L.updated_at)}`);

  boxes.forEach((b, i) => {
    const sid = specIdOf(b);
    const owners = byBox.get(sid) || [];
    console.log(`      box[${i + 1}] specGlobalId=${sid || '(none)'}`);
    console.log(`             spec name    ${J(b && b.name)}`);
    console.log(`             price        ${J(b && b.price)}`);
    console.log(`             ELEME stock  ${J(b && b.stock)}`);
    if (owners.length) {
      for (const o of owners) {
        console.log(`             CLAIMED BY   product_id=${J(o.product_id)} sku=${J(o.sku)} `
          + `${J(o.name_cn)} / ${J(o.name_en)}`);
        console.log(`                          our physical_qty=${J(o.physical_qty)}   units_per_pack=${J(o.units_per_pack)}`
          + `   sync_enabled=${J(o.sync_enabled)}`);
        console.log(`                          last_pushed_qty=${J(o.last_pushed_qty)} at ${J(o.last_pushed_at)}`);
        const q = Number(o.physical_qty), u = Number(o.units_per_pack) || 1;
        const would = Number.isFinite(q) ? Math.floor(q / u) : null;
        console.log(`                          → a correct push would set this box to ${J(would)}`
          + `   (currently ${J(b && b.stock)})`);
      }
    } else {
      console.log('             CLAIMED BY   *** NOBODY — nothing will ever push a real number here ***');
      unclaimedBoxes.push({ listing: L.name, box: i + 1, specGlobalId: sid, specName: b && b.name, stock: b && b.stock, price: b && b.price });
    }
  });

  for (const m of wholeRows) {
    console.log(`      !! spec_key='' MAPPING on a ${boxes.length}-box listing:`);
    console.log(`             map id=${J(m.id)} product_id=${J(m.product_id)} sku=${J(m.sku)} `
      + `${J(m.name_cn)}  physical_qty=${J(m.physical_qty)} sync_enabled=${J(m.sync_enabled)}`);
    console.log('             This is the GUESS trigger (lib/eleme-browser.js:876-889).');
    wholeOnMulti.push({ listing: L.name, boxes: boxes.length, map_id: m.id, product_id: m.product_id, sku: m.sku, physical_qty: m.physical_qty, sync_enabled: m.sync_enabled });
  }

  if (claimedCount > 0 && claimedCount < boxes.length) {
    partial.push({ listing: L.name, claimed: claimedCount, boxes: boxes.length });
  }
}
if (!shown) console.log('   (no multi-spec listings found in the cache for this store)');

// ════════════════════════════════════════════════════════════════════════════
section('2b · SUMMARY OF THE THREE FAULT STATES');
console.log(`   multi-spec listings with NO box claimed        : `
  + `${listings.filter(L => { const b = boxesOf(L); if (!b || b.length <= 1) return false; const cl = claimsByName.get(String(L.name)) || []; return !cl.some(m => claimKey(m) && b.some(x => specIdOf(x) === claimKey(m))); }).length}`);
console.log(`   multi-spec listings PARTIALLY claimed          : ${partial.length}`);
for (const p of partial) console.log(`       ${p.claimed}/${p.boxes}  ${p.listing}`);
console.log(`   spec_key='' mappings on multi-box listings     : ${wholeOnMulti.length}`);
for (const w of wholeOnMulti) console.log(`       map id=${w.map_id} product ${w.product_id} (${J(w.sku)}) → "${w.listing}" [${w.boxes} boxes] sync_enabled=${w.sync_enabled}`);
console.log(`   UNCLAIMED boxes in total                       : ${unclaimedBoxes.length}`);

// ════════════════════════════════════════════════════════════════════════════
section('3b · UNCLAIMED BOXES — does the bracketed-SKU pattern resolve them?');
console.log('   Hypothesis under test: a bracketed number in the spec name is one of our');
console.log('   SKUs. Three rules are tried per token; the hit rates below say whether the');
console.log('   pattern holds. It is NOT used to assert a mapping.\n');

const TOKEN = /[（(]\s*([0-9A-Za-z][0-9A-Za-z\-_. ]{1,20}?)\s*[)）]/g;
function tokensOf(s) {
  const out = []; let m;
  const str = String(s == null ? '' : s);
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(str)) !== null) out.push(m[1].trim());
  return out;
}
// rule A: token matches a SKU exactly
// rule B: token, non-alphanumerics stripped, matches a stripped SKU  (2-420 ~ 2420)
// rule C: digits-only token gets a hyphen after the first digit       (2420 -> 2-420)
function resolve(tok) {
  const t = String(tok).trim();
  if (skuExact.has(t)) return { rule: 'A exact', p: skuExact.get(t) };
  const st = t.replace(/[^0-9a-zA-Z]/g, '');
  if (st && skuStripped.has(st)) return { rule: 'B stripped', p: skuStripped.get(st) };
  if (/^\d{3,}$/.test(t)) {
    const hy = t[0] + '-' + t.slice(1);
    if (skuExact.has(hy)) return { rule: 'C hyphen-after-1st', p: skuExact.get(hy) };
    const hy2 = t.slice(0, 2) + '-' + t.slice(2);
    if (skuExact.has(hy2)) return { rule: 'C2 hyphen-after-2nd', p: skuExact.get(hy2) };
  }
  return null;
}

let tokTotal = 0, tokResolved = 0;
const byRule = new Map();
const allBoxTokens = [];
for (const L of listings) {
  const boxes = boxesOf(L);
  if (!boxes) continue;
  boxes.forEach((b, i) => {
    for (const t of tokensOf(b && b.name)) {
      tokTotal++;
      const r = resolve(t);
      if (r) { tokResolved++; byRule.set(r.rule, (byRule.get(r.rule) || 0) + 1); }
      allBoxTokens.push({ listing: L.name, box: i + 1, boxes: boxes.length, specName: b && b.name, token: t, r });
    }
  });
}
console.log(`   bracketed tokens found across all spec names : ${tokTotal}`);
console.log(`   tokens that resolve to a store_products.sku  : ${tokResolved}`
  + (tokTotal ? `  (${Math.round(tokResolved * 1000 / tokTotal) / 10}%)` : ''));
for (const [r, n] of byRule) console.log(`       by rule ${r}: ${n}`);
if (!tokTotal) {
  console.log('   → THE PATTERN DOES NOT APPEAR AT ALL in this catalogue. The two examples');
  console.log('     it was inferred from are not representative; do not rely on it.');
} else if (tokResolved === 0) {
  console.log('   → tokens exist but NONE resolve to one of our SKUs. The bracketed figure');
  console.log('     is something else (Eleme-side code, weight, pack count). Do not rely on it.');
} else if (tokResolved < tokTotal) {
  console.log('   → PARTIAL. The pattern holds for some boxes and not others, so it can');
  console.log('     suggest a candidate but cannot be trusted to assign one unattended.');
}

console.log('\n   every unclaimed box, with what its token resolves to (or does not):');
if (!unclaimedBoxes.length) console.log('   (none)');
for (const u of unclaimedBoxes) {
  const toks = tokensOf(u.specName);
  const res = toks.map(t => { const r = resolve(t); return r ? `${t} → product ${r.p.id} sku=${r.p.sku} (${r.p.name_cn}) [${r.rule}]` : `${t} → NO MATCH`; });
  console.log(`     "${u.listing}" box[${u.box}] spec=${J(u.specName)} price=${J(u.price)} ELEME stock=${J(u.stock)}`);
  console.log(`         specGlobalId ${u.specGlobalId || '(none)'}`);
  console.log(`         tokens: ${res.length ? res.join(' | ') : '(no bracketed token in the spec name)'}`);
}

// ════════════════════════════════════════════════════════════════════════════
section('CROSS-CHECK · mappings whose listing name is not in the cache at all');
console.log('   These can never resolve on a push regardless of boxes — the 195 failure mode.');
const cacheNames = new Set(listings.map(l => String(l.name)));
const orphans = maps.filter(m => m.eleme_name && !cacheNames.has(String(m.eleme_name)));
console.log(`   count: ${orphans.length}`);
for (const o of orphans) {
  console.log(`     map id=${J(o.id)} product ${J(o.product_id)} sku=${J(o.sku)} sync_enabled=${J(o.sync_enabled)}`);
  console.log(`         eleme_name = ${J(o.eleme_name)}`);
  console.log(`         last_pushed_qty=${J(o.last_pushed_qty)} at ${J(o.last_pushed_at)}  physical_qty=${J(o.physical_qty)}`);
}

db.close();
section('DONE');
console.log('Nothing was written. Nothing was enqueued. No process was touched.');
