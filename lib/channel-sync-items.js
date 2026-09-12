'use strict';

// "Is this item in step with this channel?" — one answer for Meituan, Eleme and
// GZ Grocery, per item, per channel. §103.
//
// Until §103 there were three answers to that question, one per channel tab,
// each drawn by its own screen in its own words (18 phrases between them), and
// none of them read whether the last push actually LANDED. The Meituan tab
// said "Synced" off the link setup alone: a name that verified, a switch that
// was on, an option that was claimed. Harissa Chilli Paste read Synced for 75
// days while every push failed and Meituan held 18 against a shelf of 3
// (docs/channel-mapping-findings.md F4: ~400 such failures, "surfaced by
// nothing"). This module is what would have surfaced them.
//
// ── The four words ──────────────────────────────────────────────────────────
//
//   ok    Synced          the platform holds the number we would send it now
//   att   Needs attention the platform holds a WRONG number, or cannot be
//                         reached for this item, and the fix is on the item
//   off   Sync off        listed, switch off — settled, nothing pushes
//   none  Not listed      no mapping: not sold there, and that is normal
//
// plus one that is not a verdict:
//
//   unk   Not checked     mapped, but the store's catalogue has never been
//                         read, so the name cannot be checked either way.
//                         Drawn neutral, never amber — it is one fact about the
//                         STORE and belongs on the channel's own line, not on
//                         every item (docs/eleme-mapping-groups-handover.md §5:
//                         194 amber dots for one dropped fetch).
//
// `reason` says WHY, as a code the client translates. Every reason maps onto
// one of the phrases the channel tabs already show, so this page and those
// tabs cannot describe one row two ways.
//
// ── What "wrong number" means, and what it does not ─────────────────────────
//
// The comparison is the drift sweeps' own (lib/channel-drift-sweep.js,
// lib/meituan-drift-sweep.js): what channel-publish says we would TELL the
// platform right now, against what the platform last ACCEPTED
// (last_pushed_qty), per claim, through packQty. Nothing new is stored and no
// second definition of drift is introduced — a row this module calls wrong is
// a row the sweep would re-queue.
//
// A row with a push IN FLIGHT (latest queue row pending/processing) is `ok`
// with reason `sending`, whatever its age. How long a channel has been
// sitting on its queue is the CHANNEL's problem, answered once by
// lib/channel-sync-stale.js and carried on the channel's own card here — not
// repeated on the forty items behind it. One cause, shown once.
//
// A row whose latest queue row is `error` is `att` with reason `push_failed`
// and the channel's own sentence as `error`. That is the state F4 measured
// and nothing rendered.
//
// ── Worst store wins ────────────────────────────────────────────────────────
//
// Meituan has two stores; an item is one row. Its channel cell is the worst of
// its stores (att > ok > off > unk > none) and the per-store detail sits
// underneath for whoever opens the row. Six dots per row was drawn and
// rejected: nobody reads it.
//
// Stores not TRADING on a channel are out of scope entirely, the same rule and
// the same predicate (lib/store-trading.js) channel-sync-stale applies.

const channelPublish = require('./channel-publish');
const cadence = require('./batch-cadence');
const { packQty } = require('./pack-units');
const { isStoreTradingOnChannel } = require('./store-trading');
const { channelSyncStale } = require('./channel-sync-stale');

// Which Meituan stores link themselves by 货号 (闪购). There a missing name is a
// fact about the listing, not a job — the same env the daemon reads
// (scripts/shangou-daemon.js), so this and the tab cannot disagree about which
// store is which.
const SHANGOU_STORES = String(process.env.SHANGOU_STORES || 'yuexiu')
  .split(',').map(s => s.trim()).filter(Boolean);
// GZ Grocery is one warehouse (routes/guanyi-admin.js guanyiStore()).
const GUANYI_STORE_CODE = process.env.GUANYI_STORE_CODE || 'tianhe';

const RANK = { att: 4, ok: 3, off: 2, unk: 1, none: 0 };
const KEYS = ['ok', 'att', 'off', 'unk', 'none'];

function worstOf(states) {
  let best = null;
  for (const s of states) if (!best || RANK[s.k] > RANK[best.k]) best = s;
  return best;
}

function parseUtc(stamp) {
  if (!stamp) return null;
  const t = Date.parse(String(stamp).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

// ── Shared reads ─────────────────────────────────────────────────────────────

// The latest queue row per (store, product), keyed "store|product". One query
// per channel. Meituan's queue also carries combo rows (bundle_id set) that
// share a store and must not stand in for a product's own push; the column
// is absent on the other two queues, so it is only tested where it exists.
function latestQueueRows(db, table, bundleAware) {
  const idx = {};
  const read = (where) => db.prepare(`
      WITH latest AS (
        SELECT store_code, product_id, status, last_error, created_at,
               ROW_NUMBER() OVER (PARTITION BY store_code, product_id ORDER BY id DESC) AS rn
          FROM ${table} ${where})
      SELECT store_code, product_id, status, last_error, created_at FROM latest WHERE rn = 1
    `).all();
  let rows = [];
  try {
    rows = read(bundleAware ? 'WHERE bundle_id IS NULL' : '');
  } catch (_) {
    // An older box whose meituan_sync_queue predates bundle_id, or no queue at
    // all: the first falls back to the plain read, the second reads as empty.
    try { rows = bundleAware ? read('') : []; } catch (__) { rows = []; }
  }
  for (const r of rows) idx[`${r.store_code}|${r.product_id}`] = r;
  return idx;
}

function queueWaiting(db, table, storeCodes) {
  if (!storeCodes.length) return 0;
  try {
    const ph = storeCodes.map(() => '?').join(',');
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}
                        WHERE status IN ('pending','processing') AND store_code IN (${ph})`)
      .get(...storeCodes).n || 0;
  } catch (_) { return 0; }
}

function lastPushOk(db, logTable, storeCodes) {
  if (!storeCodes.length) return null;
  try {
    const ph = storeCodes.map(() => '?').join(',');
    return db.prepare(`SELECT MAX(created_at) AS t FROM ${logTable}
                        WHERE event_type = 'stock_push' AND status = 'ok' AND store_code IN (${ph})`)
      .get(...storeCodes).t || null;
  } catch (_) { return null; }
}

// What we would tell this channel for this (store, product) right now — the
// §85 figure, allowance included while a pre-order window is open. One window
// read per channel, one publish read per (store, product), memoised: three
// channels asking about the same shelf must not cost three reads.
function expectedReader(db, publishKey) {
  let window;
  try { window = cadence.preorderWindow(db, { channel: publishKey }); }
  catch (_) { window = { open: false, qty: 0 }; }
  const memo = new Map();
  return (storeId, productId) => {
    const key = `${storeId}|${productId}`;
    if (!memo.has(key)) {
      let q = 0;
      try { q = channelPublish.publishableAt(db, storeId, productId, { channel: publishKey, window }); }
      catch (_) { q = 0; }
      memo.set(key, q);
    }
    return memo.get(key);
  };
}

// The push half of a mapped, switched-on row: in flight / failed / never landed
// / holds a different number / in step. Shared by all three channels because
// the three queues and the three maps carry the same columns for exactly this
// (lib/channel-drift-sweep.js's header lists them).
function pushState(claims, queueRow, expected) {
  if (queueRow && (queueRow.status === 'pending' || queueRow.status === 'processing')) {
    return { k: 'ok', reason: 'sending' };
  }
  if (queueRow && queueRow.status === 'error') {
    return { k: 'att', reason: 'push_failed', error: queueRow.last_error || null, since: queueRow.created_at || null };
  }
  let never = false, wrong = false;
  for (const c of claims) {
    const want = packQty(expected, c.units_per_pack);
    if (c.last_pushed_qty == null) never = true;
    else if (Number(c.last_pushed_qty) !== want) wrong = true;
  }
  if (wrong) return { k: 'att', reason: 'wrong_number' };
  if (never) return { k: 'att', reason: 'never_synced' };
  return { k: 'ok', reason: 'synced' };
}

// The facts a cell carries besides its verdict: what the platform last took and
// when, and what we would send. `platform_qty` is the platform's number as far
// as we know it — what it last accepted — so the row can say "shows 18" beside
// a shelf of 3. Several claims (a multipack's options) each hold their own; the
// first claim's stands for the cell, the way both channel tabs already do it.
function facts(claims, expected) {
  const first = claims.find(c => c.last_pushed_at) || claims[0] || {};
  return {
    last_pushed_qty: first.last_pushed_qty == null ? null : Number(first.last_pushed_qty),
    last_pushed_at:  first.last_pushed_at || null,
    expected,
  };
}

// ── Meituan ──────────────────────────────────────────────────────────────────

function meituanChannel(db, ctx) {
  const stores = ctx.stores.filter(s => isStoreTradingOnChannel(db, s.code, 'meituan'));
  const codes = stores.map(s => s.code);
  const byStore = {};   // product_id → store_code → { claims, name, sync_enabled }
  let catalogue = {};   // store_code → { names:Set, count, at }
  let specIndex = {};   // store_code → listing_name → [{spec, sku}]

  try {
    for (const r of db.prepare(`SELECT store_code, COUNT(*) AS n, MAX(scraped_at) AS at
                                  FROM meituan_listings GROUP BY store_code`).all()) {
      catalogue[r.store_code] = { names: new Set(), count: Number(r.n || 0), at: r.at || null };
    }
    for (const r of db.prepare('SELECT store_code, listing_name FROM meituan_listings').all()) {
      const c = catalogue[r.store_code];
      if (c) c.names.add(String(r.listing_name || '').trim());
    }
  } catch (_) { catalogue = {}; }
  try {
    for (const r of db.prepare(`SELECT store_code, listing_name, spec, sku_code
                                  FROM meituan_listing_specs ORDER BY id`).all()) {
      const s = specIndex[r.store_code] = specIndex[r.store_code] || {};
      const spec = String(r.spec || '').trim();
      if (!spec) continue;
      (s[r.listing_name] = s[r.listing_name] || []).push({ spec, sku: String(r.sku_code || '').trim() });
    }
  } catch (_) { specIndex = {}; }

  try {
    for (const m of db.prepare(`
        SELECT product_id, retail_store_id, store_code, meituan_name, sync_enabled,
               spec_key, units_per_pack, last_pushed_qty, last_pushed_at
          FROM meituan_product_map ORDER BY product_id, store_code, id`).all()) {
      if (!codes.includes(m.store_code)) continue;
      const p = byStore[m.product_id] = byStore[m.product_id] || {};
      const e = p[m.store_code] = p[m.store_code] || {
        storeId: m.retail_store_id, name: m.meituan_name, sync_enabled: 0, claims: [],
      };
      if (Number(m.sync_enabled) === 1) e.sync_enabled = 1;
      if (!e.name && m.meituan_name) e.name = m.meituan_name;
      e.claims.push({ spec_key: m.spec_key || '', units_per_pack: Number(m.units_per_pack) || 1,
                      last_pushed_qty: m.last_pushed_qty, last_pushed_at: m.last_pushed_at });
    }
  } catch (_) { /* no Meituan on this box */ }

  const queue = latestQueueRows(db, 'meituan_sync_queue', true);
  const expected = expectedReader(db, 'meituan');

  const stateFor = (productId, store) => {
    const e = (byStore[productId] || {})[store.code];
    if (!e) return { k: 'none', reason: 'no_map' };
    const skuLinked = SHANGOU_STORES.includes(store.code);
    if (!e.name) {
      // 外卖 names by hand: a row with no name is work. 闪购 names itself from
      // 货号: no name is a fact about the listing, not a job on this page.
      return skuLinked ? { k: 'none', reason: 'no_map' } : { k: 'att', reason: 'no_name' };
    }
    if (!skuLinked) {
      const cat = catalogue[store.code];
      if (!cat || !cat.count) return { k: 'unk', reason: 'not_checked' };
      if (!cat.names.has(String(e.name).trim())) return { k: 'att', reason: 'name_not_found' };
    }
    if (e.sync_enabled !== 1) return { k: 'off', reason: 'sync_off' };
    // A shared listing (a 货号 per option) with no option claimed pushes one
    // number to every option — worse than not pushing at all.
    const specs = ((specIndex[store.code] || {})[e.name] || []);
    const shared = specs.length > 1 && specs.every(o => o.sku);
    if (shared && !e.claims.some(c => c.spec_key)) return { k: 'att', reason: 'no_option' };
    const want = expected(e.storeId, productId);
    return { ...pushState(e.claims, queue[`${store.code}|${productId}`], want), ...facts(e.claims, want) };
  };

  return {
    key: 'meituan', label: 'Meituan', tab: 'meituan',
    stores: stores.map(s => ({
      code: s.code, name: s.name, nameEn: s.nameEn, trading: true,
      connected: true,
      catalogue: { count: (catalogue[s.code] || {}).count || 0, at: (catalogue[s.code] || {}).at || null },
    })),
    waiting: queueWaiting(db, 'meituan_sync_queue', codes),
    lastPushAt: lastPushOk(db, 'meituan_sync_log', codes),
    stateFor,
  };
}

// ── Eleme ────────────────────────────────────────────────────────────────────

function elemeChannel(db, ctx) {
  const stores = ctx.stores.filter(s => isStoreTradingOnChannel(db, s.code, 'eleme'));
  const codes = stores.map(s => s.code);
  const shops = {};
  try {
    for (const r of db.prepare('SELECT store_code, shop_id FROM eleme_shops').all()) {
      shops[r.store_code] = !!(r.shop_id && String(r.shop_id).trim());
    }
  } catch (_) { /* no Eleme on this box */ }

  const catalogue = {};   // store_code → { names: Map name→specCount, count, at }
  try {
    for (const r of db.prepare('SELECT store_code, name, specs, updated_at FROM eleme_catalogue_cache').all()) {
      const c = catalogue[r.store_code] = catalogue[r.store_code] || { names: new Map(), count: 0, at: null };
      let n = 0;
      try { const a = r.specs ? JSON.parse(r.specs) : []; n = Array.isArray(a) ? a.length : 0; } catch (_) { n = 0; }
      c.names.set(String(r.name || '').trim(), n);
      c.count++;
      if (!c.at || String(r.updated_at) > String(c.at)) c.at = r.updated_at;
    }
  } catch (_) { /* table absent */ }

  const byStore = {};
  try {
    for (const m of db.prepare(`
        SELECT product_id, retail_store_id, store_code, eleme_name, sync_enabled,
               spec_key, units_per_pack, last_pushed_qty, last_pushed_at
          FROM eleme_product_map ORDER BY product_id, store_code, id`).all()) {
      if (!codes.includes(m.store_code)) continue;
      const p = byStore[m.product_id] = byStore[m.product_id] || {};
      const e = p[m.store_code] = p[m.store_code] || {
        storeId: m.retail_store_id, name: m.eleme_name, sync_enabled: 0, claims: [],
      };
      if (Number(m.sync_enabled) === 1) e.sync_enabled = 1;
      if (!e.name && m.eleme_name) e.name = m.eleme_name;
      e.claims.push({ spec_key: m.spec_key || '', units_per_pack: Number(m.units_per_pack) || 1,
                      last_pushed_qty: m.last_pushed_qty, last_pushed_at: m.last_pushed_at });
    }
  } catch (_) { /* no Eleme on this box */ }

  const queue = latestQueueRows(db, 'eleme_sync_queue', false);
  const expected = expectedReader(db, 'eleme');

  const stateFor = (productId, store) => {
    // A store with no shop linked cannot hold a mapping at all; the store's
    // own line says so. Its items stay quiet.
    if (!shops[store.code]) return { k: 'none', reason: 'store_not_connected' };
    const e = (byStore[productId] || {})[store.code];
    if (!e) return { k: 'none', reason: 'no_map' };
    // A mapping with no name still pushes — the drain falls back to the
    // product's own name — so this is a live wrong-target risk, checked before
    // the switch.
    if (!e.name) return { k: 'att', reason: 'no_name' };
    const cat = catalogue[store.code];
    if (!cat || !cat.count) return { k: 'unk', reason: 'not_checked' };
    const specCount = cat.names.get(String(e.name).trim());
    if (specCount === undefined) return { k: 'att', reason: 'name_not_found' };
    if (specCount > 1 && !e.claims.some(c => c.spec_key)) return { k: 'att', reason: 'no_option' };
    if (e.sync_enabled !== 1) return { k: 'off', reason: 'sync_off' };
    const want = expected(e.storeId, productId);
    return { ...pushState(e.claims, queue[`${store.code}|${productId}`], want), ...facts(e.claims, want) };
  };

  return {
    key: 'eleme', label: 'Eleme', tab: 'eleme',
    stores: stores.map(s => ({
      code: s.code, name: s.name, nameEn: s.nameEn, trading: true,
      connected: !!shops[s.code],
      catalogue: { count: (catalogue[s.code] || {}).count || 0, at: (catalogue[s.code] || {}).at || null },
    })),
    waiting: queueWaiting(db, 'eleme_sync_queue', codes),
    lastPushAt: lastPushOk(db, 'eleme_sync_log', codes),
    stateFor,
  };
}

// ── GZ Grocery (Guanyi ERP) ──────────────────────────────────────────────────
//
// One warehouse, bound by Guanyi sku id, no names to verify and no options to
// claim. last_pushed_qty is "the target we last reconciled to" (database.js),
// which is exactly the number to compare against what we would send now.

function guanyiChannel(db, ctx) {
  const store = ctx.stores.find(s => s.code === GUANYI_STORE_CODE) || ctx.stores[0] || null;
  const stores = store && isStoreTradingOnChannel(db, store.code, 'guanyi') ? [store] : [];
  const codes = stores.map(s => s.code);
  const maps = {};
  try {
    for (const m of db.prepare(`
        SELECT product_id, retail_store_id, store_code, guanyi_sku_id, sync_enabled,
               last_pushed_qty, last_pushed_at
          FROM guanyi_product_map`).all()) {
      if (!codes.includes(m.store_code)) continue;
      maps[m.product_id] = m;
    }
  } catch (_) { /* no Guanyi on this box */ }
  // Guanyi's own count for the bound sku, from the last listing read, so the
  // row can show what the ERP holds beside what we hold.
  const listingQty = {};
  try {
    if (codes.length) {
      for (const r of db.prepare('SELECT sku_id, current_qty FROM guanyi_listings WHERE store_code = ?').all(codes[0])) {
        listingQty[String(r.sku_id)] = r.current_qty;
      }
    }
  } catch (_) { /* table absent */ }
  let catalogue = { count: 0, at: null };
  try {
    if (codes.length) {
      const r = db.prepare('SELECT COUNT(*) AS n, MAX(scraped_at) AS at FROM guanyi_listings WHERE store_code = ?').get(codes[0]);
      catalogue = { count: Number(r?.n || 0), at: r?.at || null };
    }
  } catch (_) { /* table absent */ }

  const queue = latestQueueRows(db, 'guanyi_sync_queue', false);
  const expected = expectedReader(db, 'gzgrocery');

  const stateFor = (productId, st) => {
    const m = maps[productId];
    if (!m || !m.guanyi_sku_id) return { k: 'none', reason: 'no_map' };
    if (Number(m.sync_enabled) !== 1) return { k: 'off', reason: 'sync_off' };
    const want = expected(m.retail_store_id, productId);
    const claims = [{ units_per_pack: 1, last_pushed_qty: m.last_pushed_qty, last_pushed_at: m.last_pushed_at }];
    const s = { ...pushState(claims, queue[`${st.code}|${productId}`], want), ...facts(claims, want) };
    const erp = listingQty[String(m.guanyi_sku_id)];
    if (erp != null) s.platform_qty = Number(erp);
    return s;
  };

  return {
    key: 'guanyi', label: 'GZ Grocery', tab: 'guanyi',
    stores: stores.map(s => ({ code: s.code, name: s.name, nameEn: s.nameEn, trading: true, connected: true, catalogue })),
    waiting: queueWaiting(db, 'guanyi_sync_queue', codes),
    lastPushAt: lastPushOk(db, 'guanyi_sync_log', codes),
    stateFor,
  };
}

// ── The read ─────────────────────────────────────────────────────────────────

// `productIds` restricts the read to those products — the product editor's
// Channels block asks about ONE, and looping the whole catalogue to answer for
// one is work nobody sees. `compact` drops everything the Products list's three
// dots do not draw (per-store detail, push facts, names, shelf), because that
// list already holds the product's own row and only needs the verdict: 248
// products × 3 channels of detail is a payload for nobody.
//
// Both are projections of the SAME computation, deliberately. A second, lighter
// query written for the dots is how a dot and the page it links to start
// disagreeing about the same item.
function channelSyncItems(db, { nowMs = Date.now(), productIds = null, compact = false } = {}) {
  const stores = db.prepare(`
    SELECT id, code, COALESCE(name_cn, name_en, code) AS name, COALESCE(name_en, name_cn, code) AS nameEn
      FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`).all();
  const storeIdByCode = {};
  for (const s of stores) storeIdByCode[s.code] = s.id;
  const ctx = { stores };

  // A named id list is asked for BY ID and not filtered on is_active: the
  // editor is open on that product, and a paused one still holds mappings that
  // are still pushing. The catalogue-wide read keeps its active-only rule.
  const ids = Array.isArray(productIds) ? productIds.map(Number).filter(Number.isFinite) : null;
  const products = ids
    ? (ids.length
        ? db.prepare(`SELECT id, name_cn, name_en, sku, variant_label FROM store_products
                       WHERE id IN (${ids.map(() => '?').join(',')})
                       ORDER BY name_cn, variant_group_id, id`).all(...ids)
        : [])
    : db.prepare(`
        SELECT id, name_cn, name_en, sku, variant_label FROM store_products
         WHERE is_active = 1 ORDER BY name_cn, variant_group_id, id`).all();

  // Shelf per store for the active products, so the row can say what WE hold.
  const shelf = {};
  try {
    for (const r of db.prepare('SELECT store_id, product_id, physical_qty FROM retail_store_stock').all()) {
      (shelf[r.product_id] = shelf[r.product_id] || {})[r.store_id] = r.physical_qty;
    }
  } catch (_) { /* absent */ }

  // Channel-level: has this channel stopped taking updates? One source,
  // lib/channel-sync-stale.js, the same the dashboard row reads.
  const stale = {};
  try { for (const s of channelSyncStale(db, nowMs)) stale[s.channel] = s; } catch (_) { /* none */ }

  const channels = [meituanChannel(db, ctx), elemeChannel(db, ctx), guanyiChannel(db, ctx)];
  const counts = {};
  for (const ch of channels) counts[ch.key] = { ok: 0, att: 0, off: 0, unk: 0, none: 0 };
  const totals = { ok: 0, att: 0, off: 0, unk: 0, none: 0, all: products.length };
  const byChannelAtt = {};
  let oldestWrong = null;

  const items = products.map(p => {
    const cell = {};
    const perChannel = [];
    for (const ch of channels) {
      const storeStates = ch.stores.map(st => {
        const s = ch.stateFor(p.id, st);
        return { code: st.code, name: st.name, nameEn: st.nameEn, ...s };
      });
      const worst = storeStates.length ? worstOf(storeStates) : { k: 'none', reason: 'no_map' };
      const { code, name, nameEn, ...rest } = worst;   // eslint-disable-line no-unused-vars
      cell[ch.key] = { ...rest, stores: storeStates };
      counts[ch.key][rest.k]++;
      perChannel.push(rest);
      if (rest.k === 'att') {
        byChannelAtt[ch.key] = (byChannelAtt[ch.key] || 0) + 1;
        const since = parseUtc(rest.since || rest.last_pushed_at);
        if (since != null && (oldestWrong == null || since < oldestWrong)) oldestWrong = since;
      }
    }
    const worst = worstOf(perChannel).k;
    totals[worst]++;
    const sh = {};
    for (const st of stores) {
      const q = (shelf[p.id] || {})[st.id];
      if (q != null) sh[st.code] = q;
    }
    if (compact) {
      // Verdict only — one letter per channel. Everything else the dots do not
      // draw is dropped here rather than sent and ignored.
      const thin = {};
      for (const k of Object.keys(cell)) thin[k] = { k: cell[k].k };
      return { id: p.id, worst, channels: thin };
    }
    return {
      id: p.id, name_cn: p.name_cn, name_en: p.name_en, sku: p.sku, variant_label: p.variant_label,
      shelf: sh, worst, channels: cell,
    };
  });

  return {
    channels: channels.map(ch => ({
      key: ch.key, label: ch.label, tab: ch.tab,
      trading: ch.stores.length > 0,
      stale: stale[ch.key] ? { waiting_count: stale[ch.key].waiting_count, oldest_at: stale[ch.key].oldest_at } : null,
      waiting: ch.waiting,
      last_push_at: ch.lastPushAt,
      stores: ch.stores,
      counts: counts[ch.key],
    })),
    items,
    counts: totals,
    attention: {
      count: totals.att,
      by_channel: byChannelAtt,
      oldest_at: oldestWrong == null ? null : new Date(oldestWrong).toISOString().replace('T', ' ').slice(0, 19),
    },
    keys: KEYS,
  };
}

// The dashboard's number: how many items are wrong somewhere, and since when.
// Same read, summary only, so the row and the page can never disagree.
function channelSyncSummary(db, opts) {
  const r = channelSyncItems(db, opts);
  return r.attention;
}

module.exports = { channelSyncItems, channelSyncSummary, RANK, SHANGOU_STORES, GUANYI_STORE_CODE };
