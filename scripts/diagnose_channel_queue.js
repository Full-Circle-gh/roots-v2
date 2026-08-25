#!/usr/bin/env node
/**
 * diagnose_channel_queue.js — the ACTUAL ROWS behind the "Needs you" channel
 * stock-sync rows, printed raw.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_channel_queue.js
 *
 * READ-ONLY, AND IT PROVES IT. Every database file is opened with
 * `readonly: true, fileMustExist: true`, and a write is attempted and REQUIRED
 * to fail before a single row is read. If any connection accepts a write the
 * script aborts with exit 2 rather than continuing. There is no UPDATE, DELETE,
 * INSERT, ALTER or CREATE anywhere in this file except that one probe, which
 * exists to be rejected. It starts, stops and restarts nothing.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard's "Meituan not syncing · 6" / "Eleme not syncing · 1" rows come
 * from channelSyncStale() (lib/channel-sync-stale.js), which returns only a
 * COUNT and the oldest created_at. Nothing in the product shows WHICH targets
 * are behind that count, what their attempts/last_error are, or what the channel
 * was last told. scripts/diagnose_stock_queue.js answers a narrower question
 * (Meituan only, counts only, "is the queue wedged"). This prints the rows.
 *
 * THE COUNTING RULE IS COPIED, NOT REINVENTED
 * -------------------------------------------
 * Section 2/3 reproduce lib/channel-sync-stale.js:127-140 exactly: the same
 * ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC),
 * the same `rn = 1 AND status IN ('pending','error')`, and the same restriction
 * to stores that isStoreTradingOnChannel() calls trading. The ONLY difference is
 * the projection — this selects the whole row instead of COUNT(*) — which cannot
 * change which rows match. If the count here disagrees with the badge, that
 * disagreement is a finding, not a bug in the copy, so it is reported loudly and
 * nothing downstream is silently adjusted to make it fit.
 *
 * isStoreTradingOnChannel is REQUIRED from lib/, never re-implemented here: the
 * whole point of that module is that one predicate answers this question, and a
 * local copy is exactly how a diagnostic ends up disagreeing with the thing it
 * is diagnosing. It takes a db handle and has no requires of its own, so it runs
 * unchanged against a read-only connection.
 *
 * BOTH PRODUCT MAPS ARE ONE-ROW-PER-CLAIM, so a (store, product) can hold
 * SEVERAL map rows — one per 规格 it claims (database.js:5072-5101, the
 * units_per_pack / spec_key migration that dropped UNIQUE(retail_store_id,
 * product_id)). Joining the map into the queue query would multiply the queue
 * rows and break the very count this script exists to check, so last_pushed_qty
 * is looked up per row afterwards and every claim is printed.
 *
 * EVERY TENANT DATABASE IS SCANNED, not just data/roots.db. The dashboard reads
 * through tdb() (the tenant handle), so a script that only opened the main file
 * could report a confident zero from the wrong database. Same candidate list as
 * scripts/diagnose_stock_queue.js.
 *
 * Sections are independently guarded: one missing column or older schema drops
 * that section and prints why, rather than losing the other six on a one-shot
 * production query that is expensive to re-run.
 *
 * EXIT CODES
 *   0  ran (whether or not the counts matched — the numbers are the output)
 *   2  REFUSED: a connection accepted a write, or no database could be read.
 *      Not a pass. A read-only check that cannot prove it is read-only must
 *      refuse, and a check that read nothing must not look like a clean bill.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

// ── The trading predicate, from lib/ ─────────────────────────────────────────
// Staged copy first (ro-query stages the CHECKOUT's lib/), deployed copy as the
// fallback. Both shas are printed below so the record says which answered.
let isStoreTradingOnChannel = null;
let tradingFrom = null;
for (const p of [path.join(HOME, 'lib', 'store-trading.js'),
                 path.join(DEPLOY_ROOT, 'lib', 'store-trading.js')]) {
  try {
    ({ isStoreTradingOnChannel } = require(p));
    if (typeof isStoreTradingOnChannel === 'function') { tradingFrom = p; break; }
  } catch (e) { /* try the next */ }
}

// lib/channel-sync-stale.js:46-50 — the declared channel list, verbatim.
const CHANNELS = [
  { key: 'meituan', label: 'Meituan',    queueTable: 'meituan_sync_queue', mapTable: 'meituan_product_map' },
  { key: 'eleme',   label: 'Eleme',      queueTable: 'eleme_sync_queue',   mapTable: 'eleme_product_map' },
  { key: 'guanyi',  label: 'GZ Grocery', queueTable: 'guanyi_sync_queue',  mapTable: 'guanyi_product_map' },
];

// lib/channel-sync-stale.js:28 — a channel is only stale once its head has
// waited this long, so a queue under the threshold raises no row at all.
const STALE_THRESHOLD_MS = 3 * 60_000;

const sha256File = p => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch (e) { return 'unreadable'; }
};

const NOW = Date.now();

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' with no zone marker and IS
// UTC. Parsing it bare reads hours off — the same trap lib/channel-sync-stale.js
// parseUtc() and the Eleme activity log both had to fix. Force UTC.
function parseUtc(stamp) {
  if (stamp == null) return null;
  const t = Date.parse(String(stamp).replace(' ', 'T') + (String(stamp).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}
function ageOf(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return 'unparseable';
  const m = Math.round((NOW - t) / 60_000);
  if (Math.abs(m) < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}
// Same rendering the dashboard row uses, so a timestamp here can be compared
// against the one on screen without arithmetic (Asia/Shanghai, fixed UTC+8).
function shanghai(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return '—';
  return new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08';
}

const J = v => (v === null || v === undefined ? 'NULL' : String(v));

function section(title) { console.log('\n' + '═'.repeat(78) + '\n══ ' + title + '\n'); }
function sub(title) { console.log('\n── ' + title); }

// Print rows verbatim, one key: value block each. No aggregation, no tidying.
function dumpRows(rows, order) {
  if (!rows.length) { console.log('   (no rows)'); return; }
  rows.forEach((r, i) => {
    const keys = order && order.length ? order : Object.keys(r);
    console.log(`   [${i + 1}]`);
    for (const k of keys) if (k in r) console.log(`       ${k.padEnd(22)} ${J(r[k])}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Which database files to look at
// ════════════════════════════════════════════════════════════════════════════
function candidates() {
  const dataDir = path.dirname(DB_PATH);
  const list = [DB_PATH];
  try {
    const tenants = path.join(dataDir, 'tenants');
    for (const f of fs.readdirSync(tenants)) if (f.endsWith('.db')) list.push(path.join(tenants, f));
  } catch (e) { /* single tenant — no tenants dir */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

console.log('diagnose_channel_queue.js — raw rows behind the channel sync-stall dashboard rows');
console.log('run at (UTC):    ' + new Date(NOW).toISOString());
console.log('run at (+08):    ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('primary db:      ' + DB_PATH);
console.log('staged from:     ' + HOME);
console.log('deploy root:     ' + DEPLOY_ROOT);
console.log('store-trading:   ' + (tradingFrom || 'NOT LOADED'));
console.log('  staged sha256:   ' + sha256File(path.join(HOME, 'lib', 'store-trading.js')));
console.log('  deployed sha256: ' + sha256File(path.join(DEPLOY_ROOT, 'lib', 'store-trading.js')));
console.log('  channel-sync-stale.js deployed sha256: '
  + sha256File(path.join(DEPLOY_ROOT, 'lib', 'channel-sync-stale.js')));

if (!isStoreTradingOnChannel) {
  console.error('FATAL: could not load isStoreTradingOnChannel from lib/store-trading.js.');
  console.error('Refusing to re-implement the trading predicate locally — the badge and this');
  console.error('script must answer that question with the same code or the comparison is void.');
  process.exit(2);
}

const files = candidates();
console.log('\ndatabase files to scan (' + files.length + '):');
for (const f of files) console.log('   ' + f);
if (!files.length) {
  console.error('FATAL: no readable database file. Refusing to report zero rows from nothing.');
  process.exit(2);
}

let examined = 0;

for (const file of files) {
  section('DATABASE  ' + file);

  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.log('   cannot open: ' + e.message + ' — skipped');
    continue;
  }

  // ── read-only proof, before a single row is read ──────────────────────────
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('   read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write on ' + file + '. Aborting.');
    process.exit(2);
  }
  examined++;

  const has = t => {
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
    catch (e) { return false; }
  };
  const cols = t => {
    try { return new Set(db.pragma(`table_info(${t})`).map(c => c.name)); }
    catch (e) { return new Set(); }
  };
  const guard = (title, fn) => {
    try { fn(); }
    catch (e) { console.log('   SECTION FAILED (' + title + '): ' + e.message); }
  };

  if (!has('retail_stores')) {
    console.log('   no retail_stores table — not an application database, skipped');
    db.close();
    continue;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1 · which stores the badge considers in scope, per channel
  // ══════════════════════════════════════════════════════════════════════════
  // lib/channel-sync-stale.js:117-124 — active stores, filtered by the trading
  // predicate. A channel with no trading store left produces no row AT ALL, so
  // this is the first thing that has to be established: an empty list here and
  // an empty list of waiting rows mean completely different things.
  const tradingByChannel = {};
  guard('scope', () => {
    section('1 · STORES IN SCOPE (lib/channel-sync-stale.js:117-124)');
    const active = db.prepare('SELECT id, code, name_en, is_active FROM retail_stores WHERE is_active = 1').all();
    console.log('   active stores (is_active = 1): ' + (active.map(s => s.code).join(', ') || '(none)'));
    for (const ch of CHANNELS) {
      const trading = active.map(s => s.code).filter(code => isStoreTradingOnChannel(db, code, ch.key));
      tradingByChannel[ch.key] = trading;
      const excluded = active.map(s => s.code).filter(c => !trading.includes(c));
      console.log(`   ${ch.label.padEnd(11)} trading: [${trading.join(', ')}]`
        + `   EXCLUDED (not trading): [${excluded.join(', ')}]`);
    }
    console.log('\n   A store in the EXCLUDED list contributes nothing to its badge and its age is');
    console.log('   not measured, however many rows its queue holds.');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2/3 · the badge rows themselves, per channel
  // ══════════════════════════════════════════════════════════════════════════
  const badgeRowsByChannel = {};
  for (const ch of CHANNELS) {
    guard(ch.key + ' badge rows', () => {
      const N = { meituan: '2', eleme: '3', guanyi: '8a' }[ch.key] || '·';
      section(`${N} · ${ch.label.toUpperCase()} — rows the badge counts  (${ch.queueTable})`);
      if (!has(ch.queueTable)) { console.log('   table absent — skipped'); return; }
      const trading = tradingByChannel[ch.key] || [];
      if (!trading.length) {
        console.log('   NO TRADING STORE on this channel → channelSyncStale() skips it entirely');
        console.log('   (lib/channel-sync-stale.js:124) — no dashboard row is possible regardless');
        console.log('   of queue contents. The unrestricted counts below are for information only.');
      }

      // ── verbatim from lib/channel-sync-stale.js:127-140 ──────────────────
      // Partition, order, rn filter and status predicate are byte-identical.
      // Only the projection is widened (SELECT * instead of COUNT/store_code),
      // which cannot change the matching row set.
      const ph = trading.map(() => '?').join(',');
      const LATEST = `
        WITH latest AS (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC) AS rn
          FROM ${ch.queueTable}
        )`;

      let rows = [];
      if (trading.length) {
        rows = db.prepare(`${LATEST}
          SELECT * FROM latest
           WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})
           ORDER BY created_at ASC, id ASC`).all(...trading);
      }
      badgeRowsByChannel[ch.key] = rows;

      // The same count, unrestricted by trading — so "excluded" and "empty" are
      // never confused with each other.
      const anyStore = db.prepare(`${LATEST}
        SELECT COUNT(*) AS n FROM latest WHERE rn = 1 AND status IN ('pending','error')`).get().n;

      console.log(`   BADGE COUNT (trading stores only) = ${rows.length}`);
      console.log(`   same rule, ALL stores regardless of trading = ${anyStore}`);
      if (rows.length) {
        const oldest = rows[0].created_at;
        const t = parseUtc(oldest);
        console.log(`   oldest created_at = ${J(oldest)} UTC  →  ${shanghai(oldest)}  (${ageOf(oldest)})`);
        if (t != null && NOW - t < STALE_THRESHOLD_MS) {
          console.log(`   NOTE: head is younger than the ${STALE_THRESHOLD_MS / 60000}-minute threshold`);
          console.log('         (lib/channel-sync-stale.js:28) — rows waiting, but no dashboard row yet.');
        }
      }

      // Expected badge figures from the dashboard as observed.
      const EXPECT = { meituan: 6, eleme: 1 };
      if (ch.key in EXPECT) {
        if (rows.length === EXPECT[ch.key]) {
          console.log(`   ✓ matches the observed badge of ${EXPECT[ch.key]}`);
        } else {
          console.log('');
          console.log('   ' + '!'.repeat(70));
          console.log(`   !! DISCREPANCY: observed badge said ${EXPECT[ch.key]}, this query returns ${rows.length}.`);
          console.log('   !! The badge rule was copied verbatim from lib/channel-sync-stale.js:127-140,');
          console.log('   !! so the queue has MOVED between the dashboard read and this run, or the');
          console.log('   !! deployed lib/ differs from the staged copy (shas above), or the dashboard');
          console.log('   !! was reading a different tenant database. Do not reconcile — report it.');
          console.log('   ' + '!'.repeat(70));
        }
      }

      sub('the rows, verbatim');
      dumpRows(rows);

      // ── per-row detail the queue table does not carry ─────────────────────
      if (!rows.length) return;
      sub('per-row: product identity, every map claim, and what the channel was last told');
      const spCols = cols('store_products');
      const mapCols = cols(ch.mapTable);
      const hasMap = has(ch.mapTable);

      for (const r of rows) {
        console.log(`\n   queue row id=${J(r.id)}  store_code=${J(r.store_code)}  product_id=${J(r.product_id)}`
          + `  bundle_id=${J(r.bundle_id)}`);

        // Product identity. product_id is NULL on a Meituan bundle row.
        if (r.product_id != null && has('store_products')) {
          const sel = ['id'];
          for (const c of ['sku', 'name_cn', 'name_en', 'is_active']) if (spCols.has(c)) sel.push(c);
          const p = db.prepare(`SELECT ${sel.join(', ')} FROM store_products WHERE id = ?`).get(r.product_id);
          if (p) { console.log('     store_products:'); for (const k of Object.keys(p)) console.log(`       ${k.padEnd(22)} ${J(p[k])}`); }
          else console.log('     store_products:      NO ROW for product_id ' + J(r.product_id));
        } else if (r.product_id == null) {
          console.log('     store_products:      n/a — product_id is NULL (bundle row)');
          if (r.bundle_id != null && has('meituan_bundles')) {
            const b = db.prepare('SELECT id, store_code, meituan_name, max_qty, sync_enabled, last_pushed_qty, last_pushed_at FROM meituan_bundles WHERE id = ?').get(r.bundle_id);
            if (b) { console.log('     meituan_bundles:'); for (const k of Object.keys(b)) console.log(`       ${k.padEnd(22)} ${J(b[k])}`); }
            else console.log('     meituan_bundles:     NO ROW for bundle_id ' + J(r.bundle_id));
          }
        }

        // Every claim this (store, product) holds. Several is normal since the
        // spec_key migration; each carries its OWN last_pushed_qty.
        if (hasMap && r.product_id != null) {
          const want = ['id', 'store_code', 'sync_enabled', 'last_pushed_qty', 'last_pushed_at',
                        'units_per_pack', 'spec_key',
                        'meituan_name', 'meituan_sku', 'meituan_sku_id', 'meituan_spec',
                        'eleme_name', 'spec_id', 'spec_name', 'extend_code', 'item_id',
                        'guanyi_sku_id', 'guanyi_name'];
          const sel = want.filter(c => mapCols.has(c));
          const claims = db.prepare(
            `SELECT ${sel.join(', ')} FROM ${ch.mapTable} WHERE retail_store_id = ? AND product_id = ?`
          ).all(r.retail_store_id, r.product_id);
          if (!claims.length) {
            console.log(`     ${ch.mapTable}: NO MAP ROW — this target is not mapped on this channel`);
          } else {
            console.log(`     ${ch.mapTable}: ${claims.length} claim(s)`);
            claims.forEach((c, i) => {
              console.log(`       claim[${i + 1}]`);
              for (const k of Object.keys(c)) console.log(`         ${k.padEnd(20)} ${J(c[k])}`);
            });
          }

          // Eleme only: what the LISTING actually shows, which is a different
          // number from last_pushed_qty (what we last got Eleme to accept).
          // The daemon resolves the listing by eleme_name || name_cn
          // (scripts/eleme-daemon.js:534), so both keys are tried here.
          if (ch.key === 'eleme' && has('eleme_catalogue_cache')) {
            const p = has('store_products')
              ? db.prepare('SELECT name_cn FROM store_products WHERE id = ?').get(r.product_id) : null;
            const keys = [];
            for (const c of claims) if (c.eleme_name) keys.push({ via: 'eleme_product_map.eleme_name', name: c.eleme_name });
            if (p && p.name_cn) keys.push({ via: 'store_products.name_cn', name: p.name_cn });
            if (!keys.length) console.log('     eleme_catalogue_cache: no listing name to look up');
            for (const k of keys) {
              const c = db.prepare(
                'SELECT name, item_global_id, stock, specs, updated_at FROM eleme_catalogue_cache WHERE store_code = ? AND name = ?'
              ).get(r.store_code, k.name);
              if (!c) {
                console.log(`     eleme_catalogue_cache: NO ENTRY for "${k.name}" (${k.via}) in store ${J(r.store_code)}`);
              } else {
                console.log(`     eleme_catalogue_cache (matched via ${k.via}):`);
                console.log(`       name                 ${J(c.name)}`);
                console.log(`       item_global_id       ${J(c.item_global_id)}`);
                console.log(`       stock                ${J(c.stock)}   ← what the LISTING showed at last catalogue read`);
                console.log(`       updated_at           ${J(c.updated_at)} UTC  →  ${shanghai(c.updated_at)}  (${ageOf(c.updated_at)})`);
                console.log(`       specs                ${J(c.specs)}`);
              }
            }
          }
        }

        // What the shelf actually holds right now, for contrast with new_qty.
        if (r.product_id != null && has('retail_store_stock')) {
          const s = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?')
            .get(r.retail_store_id, r.product_id);
          console.log(`     retail_store_stock.physical_qty  ${s ? J(s.physical_qty) : 'NO ROW'}`
            + `   (queue row new_qty = ${J(r.new_qty)})`);
        }

        console.log(`     created_at           ${J(r.created_at)} UTC  →  ${shanghai(r.created_at)}  (${ageOf(r.created_at)})`);
        if (r.processed_at != null) {
          console.log(`     processed_at         ${J(r.processed_at)} UTC  →  ${shanghai(r.processed_at)}  (${ageOf(r.processed_at)})`);
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4 · bundle collapse — is 6 understating the Meituan figure?
  // ══════════════════════════════════════════════════════════════════════════
  guard('bundle collapse', () => {
    section('4 · MEITUAN BUNDLE COLLAPSE — does PARTITION BY (store, NULL) hide bundles?');
    if (!has('meituan_sync_queue')) { console.log('   table absent — skipped'); return; }
    const qCols = cols('meituan_sync_queue');
    if (!qCols.has('bundle_id')) { console.log('   no bundle_id column on this schema — nothing to collapse'); return; }
    const trading = tradingByChannel.meituan || [];
    if (!trading.length) { console.log('   no trading store on Meituan — badge is zero regardless'); return; }
    const ph = trading.map(() => '?').join(',');

    // (a) what the badge's own partition yields for bundle rows: product_id is
    //     NULL on every one of them, and SQLite groups NULLs together for
    //     PARTITION BY, so a store's bundles share ONE partition.
    const collapsed = db.prepare(`
      WITH latest AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC) AS rn
        FROM meituan_sync_queue
      )
      SELECT * FROM latest
       WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph}) AND product_id IS NULL
       ORDER BY created_at ASC, id ASC`).all(...trading);

    // (b) the same question partitioned CORRECTLY — one partition per bundle.
    const perBundle = db.prepare(`
      WITH latest AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY retail_store_id, bundle_id ORDER BY id DESC) AS rn
        FROM meituan_sync_queue
        WHERE bundle_id IS NOT NULL
      )
      SELECT * FROM latest
       WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})
       ORDER BY created_at ASC, id ASC`).all(...trading);

    console.log(`   bundle rows the badge actually counts (product_id IS NULL, rn=1) : ${collapsed.length}`);
    console.log(`   distinct waiting BUNDLES if partitioned by bundle_id             : ${perBundle.length}`);
    console.log(`   understatement                                                  : `
      + `${Math.max(0, perBundle.length - collapsed.length)}`);
    if (perBundle.length === collapsed.length) {
      console.log('   → the two agree, so the badge is NOT understating on bundles in this data.');
    } else {
      console.log('   → the badge IS understating: ' + perBundle.length + ' bundles are waiting but they');
      console.log('     contribute only ' + collapsed.length + ' to the count.');
    }

    sub('(a) bundle rows as the badge counts them');
    dumpRows(collapsed);
    sub('(b) every waiting bundle, partitioned by bundle_id');
    dumpRows(perBundle);
    if (perBundle.length && has('meituan_bundles')) {
      sub('(b) bundle identities');
      for (const r of perBundle) {
        const b = db.prepare('SELECT id, store_code, meituan_name, max_qty, sync_enabled, last_pushed_qty, last_pushed_at FROM meituan_bundles WHERE id = ?').get(r.bundle_id);
        console.log(`   queue id=${J(r.id)} bundle_id=${J(r.bundle_id)} → ` + (b ? JSON.stringify(b) : 'NO meituan_bundles ROW'));
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5 · the wedged class — pending with attempts >= 3
  // ══════════════════════════════════════════════════════════════════════════
  guard('wedged class', () => {
    section("5 · WEDGED: status='pending' AND attempts >= 3");
    console.log('   Invisible to the drain (scripts/meituan-daemon.js:845 / eleme-daemon.js:476 both');
    console.log('   select `status=\'pending\' AND attempts < 3`) AND excluded from drift-sweep rescue,');
    console.log("   because the sweep skips any target holding a row in ('pending','processing')");
    console.log('   (lib/meituan-drift-sweep.js:54). A row here is reachable by nothing.');
    console.log('   The Meituan queue-stall canary cannot see it either — its head query carries the');
    console.log('   same attempts < 3 filter (scripts/meituan-daemon.js:480-486).');

    for (const ch of CHANNELS) {
      sub(`${ch.label} (${ch.queueTable})`);
      if (!has(ch.queueTable)) { console.log('   table absent — skipped'); continue; }
      const rows = db.prepare(
        `SELECT * FROM ${ch.queueTable} WHERE status = 'pending' AND attempts >= 3 ORDER BY created_at ASC, id ASC`
      ).all();
      console.log(`   count = ${rows.length}`);
      dumpRows(rows);

      // Are any of THESE the rows the badge is counting? That is the question.
      const badge = badgeRowsByChannel[ch.key] || [];
      if (badge.length) {
        const wedgedIds = new Set(rows.map(r => r.id));
        const overlap = badge.filter(r => wedgedIds.has(r.id));
        console.log(`   of the ${badge.length} badge row(s) on this channel, ${overlap.length} `
          + `${overlap.length === 1 ? 'is' : 'are'} in this wedged state`
          + (overlap.length ? ` (queue ids: ${overlap.map(r => r.id).join(', ')})` : ''));
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6 · daemon liveness from the append-only sync logs
  // ══════════════════════════════════════════════════════════════════════════
  guard('daemon liveness', () => {
    section('6 · DAEMON LIVENESS — MAX(created_at) from the append-only sync logs');
    console.log('   These logs are written ONLY by the daemons. A fresh timestamp is work; a stale');
    console.log('   one is silence. Being "online" in pm2 is not evidence either way.');
    for (const t of ['meituan_sync_log', 'eleme_sync_log', 'guanyi_sync_log']) {
      sub(t);
      if (!has(t)) { console.log('   table absent — skipped'); continue; }
      const m = db.prepare(`SELECT MAX(created_at) AS t, COUNT(*) AS n FROM ${t}`).get();
      console.log(`   rows total       ${J(m.n)}`);
      console.log(`   MAX(created_at)  ${J(m.t)} UTC  →  ${shanghai(m.t)}  (${ageOf(m.t)})`);
      const perStore = db.prepare(
        `SELECT store_code, COUNT(*) AS n, MAX(created_at) AS t FROM ${t} GROUP BY store_code ORDER BY t DESC`
      ).all();
      console.log('   per store_code:');
      for (const s of perStore) {
        console.log(`       ${String(s.store_code).padEnd(14)} n=${String(s.n).padEnd(8)} last=${J(s.t)} UTC  →  ${shanghai(s.t)}  (${ageOf(s.t)})`);
      }
      sub(t + ' — last 8 rows, verbatim');
      dumpRows(db.prepare(
        `SELECT id, store_code, event_type, status, detail, error_msg, created_at FROM ${t} ORDER BY id DESC LIMIT 8`
      ).all());
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7 · trading flags for every store
  // ══════════════════════════════════════════════════════════════════════════
  guard('trading flags', () => {
    section('7 · TRADING FLAGS — store_business_status + channel_status, every store');
    console.log('   lib/store-trading.js reads these. fulfillment_open = 0 beats everything;');
    console.log('   for meituan/shangou, target_open (a pending command) outranks is_open (the');
    console.log('   observed 营业/置休 state); every other channel answers from channel_status.');
    console.log('   ABSENT ROW = TRADING, in both tables.');

    const stores = db.prepare('SELECT id, code, name_en, name_cn, is_active, open_time, close_time FROM retail_stores ORDER BY sort_order, id').all();
    for (const s of stores) {
      console.log(`\n   store ${J(s.code)}  (id=${J(s.id)}, ${J(s.name_en)} / ${J(s.name_cn)}, is_active=${J(s.is_active)}, hours ${J(s.open_time)}–${J(s.close_time)})`);
      if (has('store_business_status')) {
        const bs = db.prepare('SELECT * FROM store_business_status WHERE store_code = ?').get(s.code);
        if (!bs) console.log('     store_business_status: NO ROW  → absent = trading');
        else {
          const sbCols = cols('store_business_status');
          for (const k of ['is_open', 'target_open', 'fulfillment_open', 'target_by', 'target_at', 'last_result', 'read_ok', 'read_at', 'status_desc', 'updated_at']) {
            if (sbCols.has(k)) console.log(`       ${k.padEnd(20)} ${J(bs[k])}`);
          }
        }
      }
      if (has('channel_status')) {
        const cs = db.prepare('SELECT channel, is_open, updated_at, updated_by FROM channel_status WHERE store_code = ? ORDER BY channel').all(s.code);
        if (!cs.length) console.log('     channel_status: NO ROWS  → absent = trading on every channel');
        else for (const c of cs) console.log(`       channel_status[${String(c.channel).padEnd(10)}] is_open=${J(c.is_open)}  updated_at=${J(c.updated_at)}  by=${J(c.updated_by)}`);
      }
      console.log('     isStoreTradingOnChannel() says:');
      for (const ch of CHANNELS) {
        console.log(`       ${ch.key.padEnd(10)} ${isStoreTradingOnChannel(db, s.code, ch.key) ? 'TRADING' : 'not trading'}`);
      }
      // shangou is answered from store_business_status like meituan, and is the
      // channel whose own daemon is stopped — worth stating explicitly.
      console.log(`       ${'shangou'.padEnd(10)} ${isStoreTradingOnChannel(db, s.code, 'shangou') ? 'TRADING' : 'not trading'}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8 · GZ Grocery / Guanyi — healthy, under threshold, or excluded?
  // ══════════════════════════════════════════════════════════════════════════
  guard('guanyi', () => {
    section('8 · GZ GROCERY (guanyi) — why is there no dashboard row?');
    if (!has('guanyi_sync_queue')) { console.log('   guanyi_sync_queue absent — the channel would be skipped by the catch at lib/channel-sync-stale.js:145'); return; }
    const trading = tradingByChannel.guanyi || [];
    console.log('   trading stores on guanyi: [' + trading.join(', ') + ']');
    console.log('   (channel_status key for guanyi is \'gzgrocery\' — lib/store-trading.js:38-40)');

    const LATEST = `
      WITH latest AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY retail_store_id, product_id ORDER BY id DESC) AS rn
        FROM guanyi_sync_queue
      )`;
    const all = db.prepare(`${LATEST}
      SELECT COUNT(*) AS n FROM latest WHERE rn = 1 AND status IN ('pending','error')`).get().n;
    let rows = [];
    if (trading.length) {
      const ph = trading.map(() => '?').join(',');
      rows = db.prepare(`${LATEST}
        SELECT * FROM latest
         WHERE rn = 1 AND status IN ('pending','error') AND store_code IN (${ph})
         ORDER BY created_at ASC, id ASC`).all(...trading);
    }

    console.log(`   latest-per-target pending/error, TRADING stores only = ${rows.length}`);
    console.log(`   latest-per-target pending/error, ALL stores          = ${all}`);
    console.log('');
    if (!trading.length && all > 0) {
      console.log('   VERDICT: EXCLUDED — rows are waiting but no store is trading on this channel,');
      console.log('            so channelSyncStale() drops guanyi before measuring (line 124).');
    } else if (rows.length === 0) {
      console.log('   VERDICT: HEALTHY — no target on a trading store has pending/error as its latest row.');
    } else {
      const t = parseUtc(rows[0].created_at);
      const stale = t != null && (NOW - t) >= STALE_THRESHOLD_MS;
      console.log(`   oldest = ${J(rows[0].created_at)} UTC → ${shanghai(rows[0].created_at)} (${ageOf(rows[0].created_at)})`);
      console.log('   VERDICT: ' + (stale
        ? 'ROWS WAITING PAST THRESHOLD — a dashboard row would be expected. Its absence is a finding.'
        : `UNDER THE ${STALE_THRESHOLD_MS / 60000}-MINUTE THRESHOLD — waiting, but not yet stale (line 28).`));
      console.log('   NOTE: guanyi is hoursAware:false (lib/channel-sync-stale.js:49) — plain wall clock,');
      console.log('         no opening-hours discount, unlike Meituan and Eleme.');
    }

    sub('rows on trading stores, verbatim');
    dumpRows(rows);

    // guanyi-sync.js has no refreshPending, so this queue grows one row per
    // stock movement rather than collapsing in place. Raw table size says how
    // far that has gone; it does not affect the badge, which reads rn=1 only.
    const bulk = db.prepare("SELECT status, COUNT(*) AS n FROM guanyi_sync_queue GROUP BY status ORDER BY n DESC").all();
    sub('whole guanyi_sync_queue by status (lib/guanyi-sync.js inserts without collapsing)');
    for (const b of bulk) console.log(`   ${String(b.status).padEnd(12)} ${J(b.n)}`);
  });

  db.close();
}

section('DONE');
console.log(`databases examined: ${examined} of ${files.length}`);
if (!examined) {
  console.error('FATAL: no database could be opened and proven read-only. Refusing to report.');
  process.exit(2);
}
console.log('Nothing was written. No process was touched.');
