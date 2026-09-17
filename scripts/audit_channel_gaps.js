#!/usr/bin/env node
'use strict';

/**
 * audit_channel_gaps.js — the two lists, read off the live database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The two questions asked most often about the channels cannot be answered from
 * any screen we have:
 *
 *   A. Which products are NOT syncing on Eleme and Meituan right now, bundles
 *      included?
 *   B. Which products are on the mini app but on none of Eleme, Meituan or
 *      GZ Grocery?
 *
 * Neither is one query. The dashboard badge counts queue rows and the mapping
 * screen counts mappings, and `docs/meituan-findings.md` finding 2 is the record
 * of those two answering differently for the same store. A product can also be
 * broken with NOTHING in either count: an enabled mapping whose channel name
 * matches no listing pushes onto a neighbour and reports success
 * (`docs/meituan-findings.md` findings 13 and 19; `docs/eleme-findings.md`
 * finding 9). So this walks every way a target can be wrong and labels each one,
 * rather than returning a single number that hides the rest.
 *
 * IT READS. IT WRITES NOTHING — the handle is opened `readonly: true`, so an
 * accidental write throws rather than lands. Safe to run against production at
 * any time, including while the daemons are pushing.
 *
 * USAGE
 *   node scripts/audit_channel_gaps.js                    # the live SQLite file
 *   node scripts/audit_channel_gaps.js --db /path/roots.db
 *   node scripts/audit_channel_gaps.js --json             # machine-readable
 *   node scripts/audit_channel_gaps.js --store 天河        # one store only
 *
 * EXIT CODES
 *   0  ran and reported (findings are not a failure — this is a report)
 *   2  REFUSED — the database could not be read, so nothing is measurable.
 *      A check that cannot run must refuse, not return an empty list that reads
 *      as "nothing wrong" (docs/tacet-operating-findings.md, PART 2).
 *
 * WHAT IT DOES NOT KNOW
 * ---------------------
 * The listing caches (`meituan_listings`, `eleme_catalogue_cache`,
 * `guanyi_listings`) are snapshots taken by the daemons, not live reads. A
 * mapping flagged NO-LISTING may name a listing that exists and was added after
 * the last catalogue refresh. The report prints each cache's age so a stale one
 * is visible rather than silently believed — refresh the catalogue first when it
 * is old, then re-run.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };
const DB_PATH = at('--db') || path.join(ROOT, 'data', 'roots.db');
const AS_JSON = argv.includes('--json');
const ONE_STORE = at('--store') || null;

if (!fs.existsSync(DB_PATH)) {
  console.error(`REFUSED: no database at ${DB_PATH}`);
  console.error('This report reads the live SQLite file. Run it on the box that holds it,');
  console.error('or point --db at a copy.');
  process.exit(2);
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`REFUSED: cannot open ${DB_PATH} — ${e.message}`);
  process.exit(2);
}

const bundleStock = require('../lib/bundle-stock');

// ── helpers ────────────────────────────────────────────────────────────────
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// THESE THROW. They used to swallow and return an empty result, and the first
// run of this script proved why that is unacceptable: a missing column made two
// whole sections return nothing, and nothing printed the word "error" — the
// report simply read as "no problems on Eleme". A query that cannot run is
// unmeasured, not clean. Callers catch per section and the section is marked
// REFUSED, which is loud and which sets the exit code.
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const norm = (s) => String(s == null ? '' : s).trim();
const label = (p) => {
  const cn = norm(p.name_cn), en = norm(p.name_en), sku = norm(p.sku);
  const name = [cn, en].filter(Boolean).join(' ') || '(unnamed)';
  return `${name}${sku ? ` [${sku}]` : ' [no SKU]'}`;
};

// The three channels, each with the table names it actually uses. gzgrocery is
// stored under the `guanyi_*` prefix — the rename to gzgrocery_* was tied to the
// Postgres migration, which is cancelled (decisions §24), so the old prefix is
// the live one and this must read it.
const CHANNELS = [
  { key: 'eleme',     title: 'Eleme',      map: 'eleme_product_map',   queue: 'eleme_sync_queue',   nameCol: 'eleme_name',  listings: 'eleme_catalogue_cache', listingNameCol: 'name',         listingTimeCol: 'updated_at' },
  { key: 'meituan',   title: 'Meituan',    map: 'meituan_product_map', queue: 'meituan_sync_queue', nameCol: 'meituan_name', listings: 'meituan_listings',      listingNameCol: 'listing_name', listingTimeCol: 'scraped_at' },
  { key: 'gzgrocery', title: 'GZ Grocery', map: 'guanyi_product_map',  queue: 'guanyi_sync_queue',  nameCol: 'guanyi_name',  listings: 'guanyi_listings',       listingNameCol: 'guanyi_name',  listingTimeCol: 'scraped_at' },
];

const storeFilter = ONE_STORE
  ? ' AND (m.store_code = @store OR s.name LIKE @like OR s.name_cn LIKE @like)'
  : '';
const storeArgs = ONE_STORE ? { store: ONE_STORE, like: `%${ONE_STORE}%` } : {};

// Store names, for readable output. retail_stores' name columns have varied;
// probe rather than assume.
const storeCols = new Set(db.pragma('table_info(retail_stores)').map(c => c.name));
const storeNameExpr = ['name_cn', 'name', 'store_name', 'display_name']
  .filter(c => storeCols.has(c)).map(c => `s.${c}`).join(', ') || "''";
const storeNameStmt = db.prepare(`SELECT COALESCE(${storeNameExpr}, '') AS n FROM retail_stores s WHERE s.id = ?`);
const storeName = (id) => {
  const r = storeNameStmt.get(id);
  return r && r.n ? r.n : `store ${id}`;
};

// ── A. sync problems, per channel ──────────────────────────────────────────
// Each mapping gets every label that applies to it. A row can be several things
// at once (never pushed AND naming no listing), and collapsing that to one
// reason is how the real cause gets hidden behind a symptom.
function auditChannel(ch) {
  const out = { channel: ch.key, title: ch.title, listingCacheAge: null, listingCount: 0, rows: [], notes: [] };
  if (!has(ch.map)) { out.notes.push(`${ch.map} does not exist in this database`); return out; }

  // Listing cache — names we can prove exist on the channel, and how old that
  // proof is.
  const listings = new Set();
  if (has(ch.listings)) {
    for (const r of all(`SELECT ${ch.listingNameCol} AS n FROM ${ch.listings}`)) listings.add(norm(r.n));
    const age = one(`SELECT MAX(${ch.listingTimeCol}) AS t FROM ${ch.listings}`);
    out.listingCacheAge = age ? age.t : null;
    out.listingCount = listings.size;
  } else {
    out.notes.push(`no listing cache table (${ch.listings}) — NO-LISTING cannot be judged`);
  }

  const maps = all(`
    SELECT m.id AS map_id, m.retail_store_id, m.product_id, m.store_code,
           m.${ch.nameCol} AS channel_name, m.sync_enabled,
           m.last_pushed_qty, m.last_pushed_at,
           p.sku, p.name_cn, p.name_en, p.is_active, p.status, p.bundle_items
      FROM ${ch.map} m
      JOIN store_products p ON p.id = m.product_id
      LEFT JOIN retail_stores s ON s.id = m.retail_store_id
     WHERE 1 = 1${storeFilter}
  `, storeArgs);

  // Two enabled mappings pointing at one channel name overwrite each other —
  // last writer wins and neither number is reliable. Meituan's spec_key /
  // meituan_sku_id and Eleme's spec_id exist to separate sizes on one listing;
  // where they are empty the two rows genuinely collide.
  const byName = new Map();
  for (const m of maps) {
    if (!m.sync_enabled) continue;
    const n = norm(m.channel_name);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(m);
  }

  // The dashboard population: the NEWEST queue row per (store, product), counted
  // when it is pending or error — lib/channel-sync-stale.js:107-140. Rebuilt
  // here so the report and the badge cannot disagree about who is in it.
  const queueNewest = new Map();
  if (has(ch.queue)) {
    for (const q of all(`
      SELECT retail_store_id, product_id, status, attempts, last_error, created_at
        FROM (SELECT q.*, ROW_NUMBER() OVER (
                       PARTITION BY q.retail_store_id, q.product_id
                       ORDER BY q.id DESC) AS rn
                FROM ${ch.queue} q)
       WHERE rn = 1
    `)) queueNewest.set(`${q.retail_store_id}:${q.product_id}`, q);
  }

  for (const m of maps) {
    const flags = [];
    const key = `${m.retail_store_id}:${m.product_id}`;
    const q = queueNewest.get(key) || null;

    if (!m.is_active) flags.push('STRANDED — product archived, mapping still pushing');
    if (!m.sync_enabled) flags.push('SYNC OFF');

    if (m.sync_enabled && m.is_active) {
      if (!norm(m.channel_name)) {
        // With no channel name the driver falls back to the product's own name
        // (docs/eleme-findings.md finding 6) — it resolves against something,
        // and nothing records what.
        flags.push('NO CHANNEL NAME — pushes against the product name, target unrecorded');
      } else if (listings.size && !listings.has(norm(m.channel_name))) {
        flags.push('NO LISTING — name matches no listing in the catalogue; a loose match may land on a neighbour');
      }
      if (m.last_pushed_at == null) flags.push('NEVER PUSHED');

      const sellable = bundleStock.sellableAt(db, m.retail_store_id, m.product_id);
      if (m.last_pushed_qty != null && m.last_pushed_qty !== sellable) {
        flags.push(`DRIFT — channel holds ${m.last_pushed_qty}, shelf says ${sellable}`);
      }
      m._sellable = sellable;

      const dupes = byName.get(norm(m.channel_name));
      if (dupes && dupes.length > 1) {
        flags.push(`COLLISION — ${dupes.length} enabled mappings share this listing name (${dupes.map(d => d.product_id).join(', ')})`);
      }
    }

    if (q && (q.status === 'pending' || q.status === 'error')) {
      const dead = q.status === 'error' || (q.attempts != null && q.attempts >= 3);
      flags.push(
        `${dead ? 'DEAD QUEUE ROW' : 'QUEUED'} — ${q.status}, attempts ${q.attempts}, since ${q.created_at}` +
        (q.last_error ? ` — ${String(q.last_error).slice(0, 120)}` : '')
      );
      // Eleme has no level-triggered reconciliation (docs/eleme-findings.md
      // finding 2), so a dead row there never heals itself.
      if (dead && ch.key === 'eleme') flags.push('NOT SELF-HEALING — Eleme has no drift sweep; this needs a human');
    }

    if (flags.length) {
      out.rows.push({
        map_id: m.map_id, product_id: m.product_id,
        store: storeName(m.retail_store_id), store_code: m.store_code,
        product: label(m), channel_name: norm(m.channel_name) || null,
        is_bundle: !!bundleStock.parseBundleItems(m.bundle_items).length,
        sellable: m._sellable == null ? null : m._sellable,
        last_pushed_qty: m.last_pushed_qty, last_pushed_at: m.last_pushed_at,
        flags,
      });
    }
  }

  // Queue rows with no mapping behind them — the orphans. Nothing can push them
  // and nothing retires them (docs/meituan-findings.md finding 3, product 257).
  if (has(ch.queue)) {
    for (const [key, q] of queueNewest) {
      if (!(q.status === 'pending' || q.status === 'error')) continue;
      const [storeId, productId] = key.split(':').map(Number);
      const mapped = one(`SELECT 1 FROM ${ch.map} WHERE retail_store_id = ? AND product_id = ?`, storeId, productId);
      if (mapped) continue;
      const p = one('SELECT sku, name_cn, name_en, bundle_items FROM store_products WHERE id = ?', productId) || {};
      out.rows.push({
        map_id: null, product_id: productId,
        store: storeName(storeId), store_code: null,
        product: label(p), channel_name: null,
        is_bundle: !!bundleStock.parseBundleItems(p.bundle_items).length,
        sellable: null, last_pushed_qty: null, last_pushed_at: null,
        flags: [`ORPHAN QUEUE ROW — ${q.status} since ${q.created_at}, no mapping behind it; unreachable from both the drain and the sweep`],
      });
    }
  }

  return out;
}

// ── A2. Meituan's own bundles ──────────────────────────────────────────────
// `meituan_bundles` is Meituan's combo concept and is pushed through the same
// driver as a product, with the bundle TITLE as the target and no SKU. It is not
// in meituan_product_map, so every mapping-shaped check above misses it —
// exactly how docs/meituan-findings.md finding 13 stayed hidden under two
// earlier surveys of the same matcher.
function auditMeituanBundles() {
  const out = { rows: [], notes: [] };
  if (!has('meituan_bundles')) { out.notes.push('meituan_bundles does not exist in this database'); return out; }

  const listings = new Set();
  if (has('meituan_listings')) for (const r of all('SELECT listing_name AS n FROM meituan_listings')) listings.add(norm(r.n));

  // Every product name that is itself an enabled Meituan target — a bundle whose
  // title loosely matches one of these lands on that product's listing.
  const productTargets = new Map();
  for (const r of all(`SELECT meituan_name AS n, product_id FROM meituan_product_map WHERE sync_enabled = 1 AND COALESCE(meituan_name,'') <> ''`)) {
    productTargets.set(norm(r.n), r.product_id);
  }

  for (const b of all('SELECT * FROM meituan_bundles')) {
    const flags = [];
    const title = norm(b.meituan_name);
    const comps = all('SELECT c.product_id, c.qty, p.sku, p.name_cn, p.name_en FROM meituan_bundle_components c JOIN store_products p ON p.id = c.product_id WHERE c.bundle_id = ?', b.id);

    if (!b.sync_enabled) flags.push('SYNC OFF');
    if (!comps.length) flags.push('NO COMPONENTS — enqueueBundle returns null, so it has never pushed and never will');

    if (b.sync_enabled && comps.length) {
      if (listings.size && !listings.has(title)) {
        flags.push('NO LISTING — the title matches no listing exactly; the resolver falls to a loose match');
        // Name the neighbour it would land on, where one is obvious: a product
        // listing whose name contains, or is contained by, this title.
        for (const [n, pid] of productTargets) {
          if (n && (n.includes(title) || title.includes(n))) {
            flags.push(`WOULD LAND ON — "${n}" (product ${pid}); that product pushes its own number to the same listing`);
            break;
          }
        }
      }
      if (b.last_pushed_at == null) flags.push('NEVER PUSHED');

      // The bundle's stock is the floor across its components, each divided by
      // the units it contributes. The push is only correct while the product
      // that owns the landed listing is the scarcer component — which nothing
      // enforces and nothing would notice stopping.
      let floor = null;
      for (const c of comps) {
        const per = Math.max(1, c.qty || 1);
        const n = Math.floor(bundleStock.sellableAt(db, b.retail_store_id, c.product_id) / per);
        floor = floor == null ? n : Math.min(floor, n);
      }
      if (b.max_qty != null && floor != null) floor = Math.min(floor, b.max_qty);
      if (b.last_pushed_qty != null && floor != null && b.last_pushed_qty !== floor) {
        flags.push(`DRIFT — channel holds ${b.last_pushed_qty}, components make ${floor}`);
      }
      b._floor = floor;
    }

    if (flags.length) {
      out.rows.push({
        bundle_id: b.id, store: storeName(b.retail_store_id), store_code: b.store_code,
        title, components: comps.map(c => label(c)),
        assemblable: b._floor == null ? null : b._floor,
        last_pushed_qty: b.last_pushed_qty, last_pushed_at: b.last_pushed_at,
        flags,
      });
    }
  }
  return out;
}

// ── B. on the mini app, on no channel ──────────────────────────────────────
// "On the mini app" is a live shop listing: an active shop, the staff switch on,
// and the product itself not archived — the same three conditions
// routes/shop-menu.js draws the menu from. Anything else is not on sale, and
// listing it here would pad the answer with products nobody can buy.
function auditMiniAppOnly() {
  const out = { rows: [], notes: [] };
  if (!has('shop_listings')) { out.notes.push('shop_listings does not exist in this database'); return out; }

  const live = all(`
    SELECT sl.store_product_id AS product_id, sh.location_id AS store_id,
           sl.is_available, p.sku, p.name_cn, p.name_en, p.is_active, p.bundle_items
      FROM shop_listings sl
      JOIN shops sh ON sh.id = sl.shop_id AND sh.is_active = 1
      JOIN store_products p ON p.id = sl.store_product_id
     WHERE sl.is_available = 1 AND COALESCE(p.is_active, 1) = 1
  `);

  for (const r of live) {
    const missing = [];
    for (const ch of CHANNELS) {
      if (!has(ch.map)) { missing.push(ch.title); continue; }
      const m = one(
        `SELECT sync_enabled FROM ${ch.map} WHERE retail_store_id = ? AND product_id = ?`,
        r.store_id, r.product_id
      );
      if (!m) missing.push(ch.title);
      else if (!m.sync_enabled) missing.push(`${ch.title} (mapped, sync off)`);
    }
    if (!missing.length) continue;
    out.rows.push({
      product_id: r.product_id, store: storeName(r.store_id),
      product: label(r),
      is_bundle: !!bundleStock.parseBundleItems(r.bundle_items).length,
      sellable: bundleStock.sellableAt(db, r.store_id, r.product_id),
      missing_from: missing,
      on_no_channel: missing.filter(x => !x.includes('sync off')).length === CHANNELS.length,
    });
  }
  out.rows.sort((a, b) => (b.on_no_channel - a.on_no_channel) || a.product.localeCompare(b.product));
  return out;
}

// ── run ────────────────────────────────────────────────────────────────────
// A section that throws is REFUSED and says so. It is never folded into a clean
// result — see the note on the helpers above.
let refused = 0;
function section(name, fn, empty) {
  try { return fn(); }
  catch (e) {
    refused++;
    return Object.assign({}, empty, { refused: `${name} could not be measured — ${e.message}` });
  }
}

const report = {
  db: DB_PATH,
  generated_at: new Date().toISOString(),
  store_filter: ONE_STORE,
  channels: CHANNELS.map(ch => section(ch.title, () => auditChannel(ch),
    { channel: ch.key, title: ch.title, listingCacheAge: null, listingCount: 0, rows: [], notes: [] })),
  meituan_bundles: section('Meituan bundles', auditMeituanBundles, { rows: [], notes: [] }),
  mini_app_only: section('Mini app availability', auditMiniAppOnly, { rows: [], notes: [] }),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(refused ? 2 : 0);
}

const line = (s = '') => console.log(s);
const rule = (c = '─') => line(c.repeat(78));

line();
rule('═');
line(`CHANNEL SYNC + AVAILABILITY AUDIT   ${report.generated_at}`);
line(`source: ${DB_PATH}${ONE_STORE ? `   store filter: ${ONE_STORE}` : ''}`);
rule('═');

for (const ch of report.channels) {
  line();
  line(`## ${ch.title} — ${ch.rows.length} target${ch.rows.length === 1 ? '' : 's'} with a problem`);
  if (ch.refused) line(`   REFUSED: ${ch.refused}`);
  line(`   listing catalogue: ${ch.listingCount} names, last refreshed ${ch.listingCacheAge || 'never'}`);
  for (const n of ch.notes) line(`   ! ${n}`);
  rule();
  if (!ch.rows.length) { line('   nothing flagged.'); continue; }
  for (const r of ch.rows) {
    line(`   ${r.product}${r.is_bundle ? '  (bundle)' : ''}`);
    line(`     product ${r.product_id} · ${r.store}${r.channel_name ? ` · listing "${r.channel_name}"` : ''}`);
    for (const f of r.flags) line(`     - ${f}`);
    line();
  }
}

line();
line(`## Meituan bundles — ${report.meituan_bundles.rows.length} with a problem`);
if (report.meituan_bundles.refused) line(`   REFUSED: ${report.meituan_bundles.refused}`);
for (const n of report.meituan_bundles.notes) line(`   ! ${n}`);
rule();
if (!report.meituan_bundles.rows.length) line('   nothing flagged.');
for (const b of report.meituan_bundles.rows) {
  line(`   ${b.title}`);
  line(`     bundle ${b.bundle_id} · ${b.store} · components: ${b.components.join(' + ') || 'none'}`);
  for (const f of b.flags) line(`     - ${f}`);
  line();
}

const none = report.mini_app_only.rows.filter(r => r.on_no_channel);
line();
line(`## On the mini app, on NO channel — ${none.length} product${none.length === 1 ? '' : 's'}`);
if (report.mini_app_only.refused) line(`   REFUSED: ${report.mini_app_only.refused}`);
for (const n of report.mini_app_only.notes) line(`   ! ${n}`);
rule();
if (!none.length) line('   none.');
for (const r of none) {
  line(`   ${r.product}${r.is_bundle ? '  (bundle)' : ''}   ${r.store} · ${r.sellable} on shelf`);
}

const partial = report.mini_app_only.rows.filter(r => !r.on_no_channel);
line();
line(`## On the mini app, missing from SOME channels — ${partial.length}`);
rule();
if (!partial.length) line('   none.');
for (const r of partial) {
  line(`   ${r.product}${r.is_bundle ? '  (bundle)' : ''}   ${r.store}`);
  line(`     missing: ${r.missing_from.join(', ')}`);
}

line();
if (refused) {
  line(`REFUSED: ${refused} section${refused === 1 ? '' : 's'} could not be measured. The lists above are INCOMPLETE.`);
  process.exit(2);
}
process.exit(0);
