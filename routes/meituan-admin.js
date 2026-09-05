// Admin API for Meituan bidirectional sync configuration.
// Mounted in server.js alongside retail-inventory.
//
// Auth: uses requireRetailAdmin (the dual-realm gate shared by every other
// /api/retail-admin/* endpoint). Using the kitchen-only requireAuth here would
// 401 backend operators, and that single 401 bounces retail-admin.html into a
// /backend/login → /retail-admin redirect (lands on the dashboard).
//
// Response shape: every endpoint returns { success: true, ... } because the
// admin api() helper treats a missing `success` flag as a thrown error.

'use strict';

const express = require('express');
const router  = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const bundleLib = require('../lib/meituan-bundles');
const bundleStock = require('../lib/bundle-stock');
// The mapping-name gate and its audit payload. Lives in lib/ so the whole
// behaviour can be driven headless against a fixture; this route adds no rule
// of its own beyond turning the result into a response.
const mapWrite = require('../lib/meituan-map-write');
const { logActivity } = require('../middleware/auth');
// Opening/closing a location on a channel is ONE operation (see lib/store-close):
// it owns the flag write AND the queued-push clear together, so no route can do
// half of it. Nothing in this file writes target_open or channel_status.is_open
// directly any more.
const { setChannelOpen } = require('../lib/store-close');

// ── GET /api/retail-admin/meituan/products ─────────────────────────────────
// All products with their meituan_product_map entries per store.
router.get('/api/retail-admin/meituan/products', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    // Mapping list wants active products only; the bundle-component picker passes
    // ?includeInactive=1 so an operator can attach a paused/unpublished variant.
    const includeInactive = req.query.includeInactive === '1';
    // store_products is the storefront's OWN catalog (forked from kitchen
    // `products`, own id space) and is what retail_store_stock / the editor
    // key off — so variants created in the store editor live here, not in
    // `products`. Read it so every sellable variant shows in the mapping +
    // bundle picker.
    const products = db.prepare(`
      SELECT p.id, p.name_cn, p.name_en, p.category, p.is_active,
             p.variant_label, p.variant_group_id, p.sku, p.updated_at,
             CASE WHEN (p.image_data IS NOT NULL AND p.image_data != '')
                    OR (p.image_url  IS NOT NULL AND p.image_url  != '')
                  THEN 1 ELSE 0 END AS has_image
        FROM store_products p
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY p.name_cn, p.variant_group_id, p.id
    `).all();

    // A listing can hold more than one 规格, and the 货号 on them says which
    // kind it is. No 货号 → add-ons on ONE product ("单点 OnlyWrap" plus a
    // sauce); a 货号 per option → real variants of DIFFERENT products (the
    // soap's scents, the sorbet's pack counts). The driver pushes each kind
    // differently, so send the 货号 with the option name and let the page say
    // which it is. 15 of 265 listings at 天河 have options.
    const specIndex = {};
    try {
      const specRows = db.prepare(`
        SELECT store_code, listing_name, spec, sku_code, sku_id
          FROM meituan_listing_specs
         ORDER BY store_code, listing_name, id
      `).all();
      for (const r of specRows) {
        const byStore = specIndex[r.store_code] = specIndex[r.store_code] || {};
        (byStore[r.listing_name] = byStore[r.listing_name] || []).push({
          spec:  String(r.spec || '').trim(),
          sku:   String(r.sku_code || '').trim(),
          skuId: String(r.sku_id || '').trim(),
        });
      }
    } catch (_) { /* specs table may predate this feature on old boxes */ }

    // One row per CLAIM: a product can hold several options of one listing (a
    // multipack sells the same bottle as 1瓶 / 3瓶 / 6瓶, each with its own stock
    // box on Meituan), folded below into one entry per (product, store).
    const maps = db.prepare(`
      SELECT m.id, m.product_id, m.retail_store_id, m.store_code,
             m.meituan_name, m.sync_enabled, m.spec_key, m.units_per_pack,
             m.meituan_sku_id AS specSkuId, m.meituan_spec AS specLabel,
             m.last_pushed_qty, m.last_pushed_at
        FROM meituan_product_map m
       ORDER BY m.product_id, m.store_code, m.id
    `).all();

    // Which product owns each option, so the page can say "claimed by X" rather
    // than let two products quietly fight over one stock box.
    const optionOwners = {};
    for (const m of maps) {
      if (!m.spec_key || !m.meituan_name) continue;
      (optionOwners[m.store_code] = optionOwners[m.store_code] || {})[m.spec_key] =
        { product_id: m.product_id, meituan_name: m.meituan_name };
    }

    const mapIndex = {};
    for (const m of maps) {
      const byStore = (mapIndex[m.product_id] = mapIndex[m.product_id] || {});
      let entry = byStore[m.store_code];
      if (!entry) {
        const specs = ((specIndex[m.store_code] || {})[m.meituan_name] || []).filter(o => o.spec);
        entry = byStore[m.store_code] = {
          product_id: m.product_id, retail_store_id: m.retail_store_id, store_code: m.store_code,
          meituan_name: m.meituan_name,
          // The switch is per product+store, not per option: every claim of one
          // product on one store shares it, so the panel keeps ONE toggle.
          sync_enabled: 0, claims: [],
          specCount: specs.length,
          specSkuId: null, specLabel: null, last_pushed_qty: null, last_pushed_at: null,
        };
        // Only the multi-option listings carry their names: a one-spec listing has
        // nothing to say, and 265 single names per store is payload for nobody.
        if (specs.length > 1) entry.specs = specs;
      }
      if (Number(m.sync_enabled) === 1) entry.sync_enabled = 1;
      entry.claims.push({
        id: m.id, spec_key: m.spec_key || '', specSkuId: m.specSkuId, specLabel: m.specLabel,
        units_per_pack: Number(m.units_per_pack) || 1,
        last_pushed_qty: m.last_pushed_qty, last_pushed_at: m.last_pushed_at,
      });
      if (entry.specSkuId == null && m.specSkuId) { entry.specSkuId = m.specSkuId; entry.specLabel = m.specLabel; }
      if (entry.last_pushed_at == null) { entry.last_pushed_qty = m.last_pushed_qty; entry.last_pushed_at = m.last_pushed_at; }
    }

    res.json({
      success: true,
      // image = small lazy thumbnail URL, never the blob (list-image footgun);
      // the public /image route serves store_products images on demand.
      data: products.map(p => ({
        ...p,
        has_image: undefined,
        image: p.has_image
          ? `/api/retail/products/${p.id}/image?v=${encodeURIComponent(p.updated_at || '')}&w=96`
          : null,
        stores: mapIndex[p.id] || {},
      })),
      optionOwners,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/stores ──────────────────────────────────
router.get('/api/retail-admin/meituan/stores', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(`
      SELECT id, code,
             COALESCE(name_cn, name_en, code) AS name,
             COALESCE(name_en, name_cn, code) AS nameEn,
             -- The sync window the daemon works this store in, so the tab can
             -- both show it and let an operator move its start (pre-orders come
             -- in before the doors open — see lib/store-hours.js).
             open_time  AS openTime,
             close_time AS closeTime,
             sync_start_time AS syncStartTime
        FROM retail_stores
       ORDER BY sort_order, id
    `).all();
    res.json({ success: true, data: stores });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/products/:id/map ───────────────────────
// Upsert a product's meituan mapping for one store. Empty name → delete.
//
// THE NAME MUST BE ONE THE CHANNEL REPORTED. The check is in
// lib/meituan-map-write.js and runs here rather than in the caller, so it holds
// for Match names, for the row panel's field, for the paste path and for
// anything written later. There is no override and no force flag: an
// unverifiable name is refused. See docs/meituan-findings.md finding 11.
//
// Clearing a name is a removal, not a claim about a listing, so it is not
// gated — a product whose stored name no longer verifies stays removable.
router.post('/api/retail-admin/meituan/products/:id/map', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const productId = parseInt(req.params.id);
  const { storeId, storeCode, meituanName, syncEnabled, source } = req.body || {};
  if (!storeId || !storeCode) return res.status(400).json({ success: false, error: 'storeId and storeCode required' });

  try {
    const r = mapWrite.applyMapName(db, {
      productId, storeId, storeCode, meituanName, syncEnabled,
      // Caller-declared, and recorded as such. The client says whether the
      // string came from Match names or from a person; nothing server-side can
      // tell those apart, so this is a claim in the audit trail rather than a
      // fact — which is still infinitely more than the nothing recorded before.
      source: typeof source === 'string' && source ? source : 'unknown',
      audit: (entry) => {
        try {
          logActivity(req.user && req.user.id, (req.user && req.user.username) || 'unknown',
            entry.action, 'meituan_product_map', entry.productId,
            { store_code: entry.storeCode, from: entry.from, to: entry.to,
              source: entry.source, sync_enabled: entry.syncEnabled,
              spec_cleared: entry.specCleared, rows: entry.rows },
            req.ip);
        } catch (_) { /* the mapping change already happened; the log is best-effort */ }
      },
    });

    // 409, not 400: the request is well formed and the STATE is what refuses it.
    // `message` reaches the operator through the admin api() helper, which
    // renders "<message> [<code>]" and hands the caller err.code for branching.
    if (!r.ok) {
      return res.status(409).json({ success: false, error: r.code,
                                    message: r.message, catalogue: r.catalogue });
    }
    res.json({ success: true, deleted: !!r.deleted, specCleared: !!r.specCleared });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/products/:id/claim ─────────────────────
// Claim ONE 规格 of the mapped listing for this product, or release it.
//
// A listing can hold several options and the 货号 on them says what kind they
// are. No 货号 → add-ons on ONE product ("单点 OnlyWrap" plus a sauce), which the
// driver's rule already handles. A 货号 per option → separate stock boxes, and
// those are what get claimed here: either as a multipack of one product
// ("咖啡大师 Oatly Barista" as 1瓶 / 3瓶 / 6瓶, one product, three claims) or as
// different products behind one name (the soap's scents, one claim apiece).
//
// `units` — how many Roots units one sale of this option consumes — is typed by
// the operator, not read out of the option name: the catalogue already writes
// the same thing three ways (X3, *2, 3-260X2), and a number guessed wrong here
// silently multiplies every future deduction.
router.post('/api/retail-admin/meituan/products/:id/claim', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const productId = parseInt(req.params.id);
  const { storeId, storeCode, specSkuId, specLabel, units, on } = req.body || {};
  if (!storeId) return res.status(400).json({ success: false, error: 'storeId required' });
  const key = String(specSkuId || '').trim();
  if (!key) return res.status(400).json({ success: false, error: 'specSkuId required' });

  try {
    const cur = db.prepare(
      `SELECT * FROM meituan_product_map
        WHERE product_id = ? AND retail_store_id = ?
        ORDER BY spec_key = '' DESC, id LIMIT 1`
    ).get(productId, storeId);
    // No row means the product isn't mapped to a listing yet — there is no
    // listing to have an option ON, so this is a stale page, not a save.
    if (!cur) return res.status(404).json({ success: false, error: 'no mapping for this product and store' });
    const name = String(cur.meituan_name || '').trim();
    const code = storeCode || cur.store_code;

    if (on === false) {
      db.transaction(() => {
        db.prepare('DELETE FROM meituan_product_map WHERE product_id = ? AND retail_store_id = ? AND spec_key = ?')
          .run(productId, storeId, key);
        // Releasing the last option would leave the product with no row at all
        // and lose the listing name with it, so fall back to a base row.
        const left = db.prepare('SELECT COUNT(*) AS n FROM meituan_product_map WHERE product_id = ? AND retail_store_id = ?')
                       .get(productId, storeId).n;
        if (!left) {
          db.prepare(`
            INSERT INTO meituan_product_map
              (product_id, retail_store_id, store_code, meituan_name, spec_key, units_per_pack, sync_enabled, updated_at)
            VALUES (?, ?, ?, ?, '', 1, ?, CURRENT_TIMESTAMP)
          `).run(productId, storeId, code, name, Number(cur.sync_enabled) === 1 ? 1 : 0);
        }
      })();
      return res.json({ success: true, released: true });
    }

    // An option belongs to ONE product: that is the whole point of claiming. If
    // another product on this store already holds it, say whose it is rather
    // than let two rows push two different counts at one box.
    const taken = db.prepare(`
      SELECT m.product_id, COALESCE(p.name_en, p.name_cn) AS name
        FROM meituan_product_map m LEFT JOIN store_products p ON p.id = m.product_id
       WHERE m.retail_store_id = ? AND m.spec_key = ? AND m.product_id <> ?
    `).get(storeId, key, productId);
    if (taken) {
      return res.status(409).json({ success: false, error: 'option already claimed',
                                    takenBy: taken.product_id, takenByName: taken.name || null });
    }

    const per = Math.max(1, parseInt(units, 10) || 1);
    db.transaction(() => {
      // The base row means "the whole listing", which an explicit option
      // replaces — otherwise the product would push twice, once at a box and
      // once at the driver's guess.
      db.prepare(`DELETE FROM meituan_product_map
                   WHERE product_id = ? AND retail_store_id = ? AND spec_key = ''`)
        .run(productId, storeId);
      db.prepare(`
        INSERT INTO meituan_product_map
          (product_id, retail_store_id, store_code, meituan_name, meituan_sku,
           meituan_sku_id, meituan_spec, spec_key, units_per_pack, sync_enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(retail_store_id, product_id, spec_key) DO UPDATE SET
          meituan_name   = excluded.meituan_name,
          meituan_sku_id = excluded.meituan_sku_id,
          meituan_spec   = excluded.meituan_spec,
          store_code     = excluded.store_code,
          units_per_pack = excluded.units_per_pack,
          updated_at     = CURRENT_TIMESTAMP
      `).run(productId, storeId, code, name, cur.meituan_sku || null,
             key, String(specLabel || '').trim() || null, key, per,
             Number(cur.sync_enabled) === 1 ? 1 : 0);
    })();
    res.json({ success: true, units: per });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Channel switch ─────────────────────────────────────────────────────────
// Mirrors the Eleme switch (storefront_config 'eleme.enabled'), which the Eleme
// daemon, lib/eleme-sync and the inventory fan-out all honour. Meituan had no
// switch at all: the only way to stop the channel was to kill the daemon.
//
// ⚠️ DEFAULTS TO ON when the key is absent. Meituan is live for every tenant
// that has it set up today, so an absent key must not read as "off" and
// silently stop a working channel the first time this ships.
function meituanEnabled(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'meituan.enabled'").get();
    return row ? JSON.parse(row.value_json) !== false : true;
  } catch (e) { return true; }
}

router.get('/api/retail-admin/meituan/config', requireRetailAdmin, (req, res) => {
  try { res.json({ success: true, enabled: meituanEnabled(tdb()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/api/retail-admin/meituan/enable', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  try {
    const enabled = !!(req.body && req.body.enabled);
    db.prepare(`
      INSERT INTO storefront_config (key, value_json, updated_at)
      VALUES ('meituan.enabled', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(enabled));
    res.json({ success: true, enabled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Mirrors lib/meituan-bundles.js storePushEnabled: the Sales card's
// per-location toggle is the one switch, and this is the admin's copy of the
// read so the store lines can show a paused store as paused.
function csStorePushEnabled(db, code) {
  try {
    const row = db.prepare('SELECT target_open, is_open FROM store_business_status WHERE store_code = ?').get(code);
    if (!row) return true;
    if (row.target_open === 0 || row.target_open === 1) return row.target_open === 1;
    if (row.is_open === 0 || row.is_open === 1) return row.is_open === 1;
    return true;
  } catch (e) { return true; }
}

// Per-store health, derived from what the daemons actually recorded.
//
// The page used to report one "Sync · Active" for the whole channel, and that
// word only ever meant "this HTTP call succeeded" — it never looked at a daemon
// or a login. On 2026-08-23 越秀 had been signed out for 24 days behind a
// verification challenge while the page showed green.
//
// Truth lives in meituan_sync_log. A store is BLOCKED when its most recent
// health event is a blocking one and no stock has pushed successfully since.
// That last clause matters: 天河 logs a queue_stalled now and then and recovers
// on its own, and a store that is visibly still pushing is not blocked.
// ⚠️ Only rows the daemon wrote with status='error' count. poll_paused is
// logged with status 'ok' and means "outside opening hours" — a closed store,
// not a broken one. Treating the event type alone as blocking turned 天河 amber
// the moment it shut for the night. Any future informational event is now
// harmless here for the same reason.
const MT_BLOCKING = ['needs_login', 'verify_required', 'queue_stalled', 'proxy_stale'];
const MT_CLEARING = ['verify_cleared', 'queue_resumed', 'poll_resumed', 'proxy_elected'];

function meituanStoreHealth(db) {
  const stores = db.prepare(`
    SELECT id, code, COALESCE(name_cn, name_en, code) AS name,
           COALESCE(name_en, name_cn, code) AS nameEn
      FROM retail_stores ORDER BY sort_order, id
  `).all();

  // Latest genuine failure, and latest thing that would clear one.
  const lastFault = db.prepare(`
    SELECT event_type, status, error_msg, created_at
      FROM meituan_sync_log
     WHERE store_code = ? AND status = 'error'
       AND event_type IN (${MT_BLOCKING.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1
  `);
  const lastClear = db.prepare(`
    SELECT MAX(created_at) AS t FROM meituan_sync_log
     WHERE store_code = ? AND event_type IN (${MT_CLEARING.map(() => '?').join(',')})
  `);
  // Shop hours. poll_paused/poll_resumed are a normal nightly pair; a closed
  // store is reported plainly, never as a fault.
  const lastPause  = db.prepare("SELECT MAX(created_at) AS t FROM meituan_sync_log WHERE store_code = ? AND event_type = 'poll_paused'");
  const lastResume = db.prepare("SELECT MAX(created_at) AS t FROM meituan_sync_log WHERE store_code = ? AND event_type = 'poll_resumed'");
  const lastOkPush = db.prepare(`
    SELECT MAX(created_at) AS t FROM meituan_sync_log
     WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok'
  `);
  const queueRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'error' AND processed_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS failed
      FROM meituan_sync_queue WHERE store_code = ?
  `);
  const lastOrder = db.prepare(
    'SELECT MAX(imported_at) AS t FROM meituan_order_import WHERE store_code = ?');
  const ordersToday = db.prepare(
    "SELECT COUNT(*) AS n FROM meituan_order_import WHERE store_code = ? AND date(imported_at) = date('now')");
  // 营业/休息 as Meituan itself reports it, written by the daemon's status read.
  // This was only ever visible in the Configure panel; the page it describes
  // never showed it. read_ok guards against reporting a stale/failed read as
  // "closed", which would be a worse lie than saying nothing.
  const bizStatus = db.prepare(
    'SELECT is_open, read_ok FROM store_business_status WHERE store_code = ?');
  const liveCount = db.prepare(`
    SELECT COUNT(*) AS n FROM meituan_product_map m
      JOIN store_products p ON p.id = m.product_id
     WHERE m.store_code = ? AND m.meituan_name IS NOT NULL AND m.sync_enabled = 1 AND p.is_active = 1
  `);
  const activeProducts = db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE is_active = 1').get()?.n || 0;

  return stores.map(st => {
    const ev  = lastFault.get(st.code, ...MT_BLOCKING) || null;
    const ok  = lastOkPush.get(st.code)?.t || null;
    const cleared = lastClear.get(st.code, ...MT_CLEARING)?.t || null;
    const blockedEvent = ev;
    // Recovered on its own if anything good happened after the fault: a
    // successful push, or an explicit clearing event.
    const recovered = !!(blockedEvent && (
      (ok      && String(ok)      > String(blockedEvent.created_at)) ||
      (cleared && String(cleared) > String(blockedEvent.created_at))));
    const pausedAt  = lastPause.get(st.code)?.t || null;
    const resumedAt = lastResume.get(st.code)?.t || null;
    const closed = !!(pausedAt && (!resumedAt || String(pausedAt) > String(resumedAt)));
    const q = queueRow.get(st.code) || {};
    const live = liveCount.get(st.code)?.n || 0;
    return {
      id: st.id,
      code: st.code,
      name: st.name,
      nameEn: st.nameEn || st.name,
      enabled:    csStorePushEnabled(db, st.code),
      blocked:    !!blockedEvent && !recovered,
      blockedBy:  blockedEvent && !recovered ? blockedEvent.event_type : null,
      blockedAt:  blockedEvent && !recovered ? blockedEvent.created_at : null,
      blockedMsg: blockedEvent && !recovered ? (blockedEvent.error_msg || null) : null,
      closed,
      lastPushAt: ok,
      pending:    Number(q.pending    || 0),
      // Rows the daemon claimed and never finished. Counted nowhere before, so
      // 40 stranded pushes showed up in neither "sending" nor "failed".
      processing: Number(q.processing || 0),
      failed:     Number(q.failed     || 0),
      lastOrderAt: lastOrder.get(st.code)?.t || null,
      ordersToday: ordersToday.get(st.code)?.n || 0,
      openOnMeituan: (() => {
        let b = null;
        try { b = bizStatus.get(st.code); } catch (e) { b = null; }
        return (b && b.read_ok) ? b.is_open === 1 : null;   // null = not read yet
      })(),
      live,
      unmatched: Math.max(0, activeProducts - live),
    };
  });
}

// ── GET /api/retail-admin/meituan/status ─────────────────────────────────
router.get('/api/retail-admin/meituan/status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queuePending = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='pending'").get()?.n || 0;
    // 'error' is the status the daemon actually writes on a terminal push failure.
    // This counted 'failed', which nothing in the system has ever written, so the
    // tile read 0 no matter how badly pushes were going.
    //
    // Scoped to the last day on purpose: the column holds every terminal failure
    // ever recorded (1276 of them on 天河 as of 2026-08-22, the oldest 55 days
    // old), and a tile pinned to a permanent four-figure number is a tile nobody
    // reads. What an operator needs is "is something failing NOW".
    const queueFailed  = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE status='error' AND processed_at >= datetime('now','-1 day')").get()?.n || 0;
    // How long the oldest waiting push has been waiting. Without this a stuck
    // queue and a busy one are the same number on the screen — which is how a
    // 19-hour stock freeze presented as "107 sending…", the display the UI
    // describes as normal and clearing in seconds.
    const oldestPending = db.prepare("SELECT MIN(created_at) AS t FROM meituan_sync_queue WHERE status='pending'").get()?.t || null;
    const queueOldestMin = oldestPending
      ? Math.max(0, Math.round((Date.now() - (Date.parse(String(oldestPending).replace(' ', 'T') + 'Z') || Date.now())) / 60000))
      : 0;
    const recentLogs = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log ORDER BY created_at DESC LIMIT 20
    `).all();
    // Stock changes only (per-product pushes) — what the operator actually reads:
    // name + SKU + in/out. Queried on its own so system noise (restart, opening
    // hours, proxy) can't push these off the 20-row window.
    const recentStock = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log WHERE event_type='stock_push'
        ORDER BY created_at DESC LIMIT 25
    `).all();
    // System/status events (everything that is NOT a per-product push), kept few.
    const recentSystem = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, created_at
        FROM meituan_sync_log WHERE event_type<>'stock_push'
        ORDER BY created_at DESC LIMIT 6
    `).all();
    const lastOrder = db.prepare(`
      SELECT meituan_order_no, store_code, imported_at, status
        FROM meituan_order_import ORDER BY imported_at DESC LIMIT 5
    `).all();
    const mappedCount = db.prepare('SELECT COUNT(*) AS n FROM meituan_product_map WHERE sync_enabled=1').get()?.n || 0;

    let stores = [];
    try { stores = meituanStoreHealth(db); } catch (e) { stores = []; }
    res.json({ success: true, enabled: meituanEnabled(db), stores,
               queuePending, queueFailed, queueOldestMin, recentLogs, recentStock, recentSystem, lastOrder, mappedCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/orders ──────────────────────────────────
// Read-only record of orders that arrived from Meituan. The daemon mirrors
// every Meituan order into retail_orders (channel='meituan') to deduct stock;
// this surfaces them as a plain ledger in the Meituan tab. The storefront does
// NOT manage these — no status workflow, no printing — so the list is just
// "an order came in": when, how much, what, and (when Meituan exposes it) who.
// Deliberately excluded from the main Orders worklist + count badges.
router.get('/api/retail-admin/meituan/orders', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const orders = db.prepare(`
      SELECT o.id, o.order_no, o.total, o.placed_at,
             o.recipient_name, o.recipient_phone, o.address_full,
             s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
        FROM retail_orders o
        LEFT JOIN retail_stores s ON s.id = o.store_id
       WHERE o.channel = 'meituan'
       ORDER BY o.placed_at DESC
       LIMIT ?
    `).all(limit);

    const itemStmt = db.prepare(`
      SELECT name_cn, name_en, qty FROM retail_order_items
       WHERE order_id = ? ORDER BY id
    `);
    for (const o of orders) o.items = itemStmt.all(o.id);

    res.json({ success: true, data: orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/push-all ──────────────────────────────
// Queue a stock push for every mapped product ("sync now").
router.post('/api/retail-admin/meituan/push-all', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    // Quantity resolved per row rather than joined: a bundle's figure is its
    // component floor, which lives inside bundle_items JSON. Non-bundle rows
    // resolve to the same COALESCE the join returned. See lib/bundle-stock.
    const mapped = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code
        FROM meituan_product_map m
       WHERE m.sync_enabled = 1
    `).all().map(m => ({ ...m, qty: bundleStock.sellableAt(db, m.retail_store_id, m.product_id) }));

    const insert = db.prepare(`
      INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    let bundleCount = 0;
    const tx = db.transaction(() => {
      // Bundles already go through refreshPending (update the existing pending
      // row's qty in place, only insert if none exists) — this loop was the one
      // path that didn't, a raw INSERT every call. A queue that's still draining
      // from click #1 got a full second copy on click #2: every mapped product
      // duplicated once per click, none of them collapsing until they happened to
      // land in the same 40-row batch. One store's backlog hit a 4x multiplier
      // this way — 877 pending for 208 products that actually needed a push.
      for (const row of mapped) {
        if (bundleLib.refreshPending(db, { retailStoreId: row.retail_store_id, productId: row.product_id, qty: row.qty })) continue;
        insert.run(row.retail_store_id, row.product_id, row.store_code, row.qty);
      }
      bundleCount = bundleLib.enqueueAllBundles(db);
    });
    tx();

    res.json({ success: true, queued: mapped.length + bundleCount, products: mapped.length, bundles: bundleCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Bundles (Meituan-only combos) ──────────────────────────────────────────
// GET list with components + live computed availability.
router.get('/api/retail-admin/meituan/bundles', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const bundles = db.prepare('SELECT * FROM meituan_bundles ORDER BY store_code, meituan_name').all();
    const comps = db.prepare(`
      SELECT c.bundle_id, c.product_id, c.qty, p.name_cn, p.name_en, p.variant_label
        FROM meituan_bundle_components c
        JOIN store_products p ON p.id = c.product_id
    `).all();
    const byBundle = {};
    for (const c of comps) (byBundle[c.bundle_id] = byBundle[c.bundle_id] || []).push(c);
    const data = bundles.map(b => ({
      ...b,
      components: byBundle[b.id] || [],
      available: bundleLib.bundleStock(db, b),
    }));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upsert a bundle + its components. body: { id?, storeId, storeCode, meituanName,
// maxQty?, syncEnabled?, components: [{ productId, qty }] }
//
// THE BUNDLE TITLE MUST BE ONE THE CHANNEL REPORTED, on the same rule and
// through the same code as a product's mapping name — mapWrite.verifyName.
// Until 2026-08-26 this route took the string, trimmed it and wrote it, with no
// datalist and no client check either, which is how two bundles came to hold
// titles no listing carries: bundle 2 differs from its listing by ONE space and
// bundle 16's listing no longer exists. Both resolve through the matcher's loose
// branch onto a DIFFERENT product's listing, and 11 of 19 bundles would do the
// same if their combo listing were ever renamed. See docs/meituan-findings.md.
//
// WHAT IS GATED IS A NAME THAT CHANGES, not every save.
// This is the one place the rule is shaped differently from the map route, and
// the reason is structural rather than a softening. On the map route a name and
// its switch are separate concerns with separate actions — Remove is ungated, so
// a product holding an unverifiable name (254) stays reachable. Here one POST
// carries the title, the cap, the switch and the components, so gating an
// unchanged title would freeze everything else about the row with it: bundle 16,
// whose listing is gone and whose stored name can never verify again, could not
// be switched off, re-costed or have a component fixed. That is the trap §30
// rule 4 warns about — a check that refuses the remedy along with the fault.
// So: a title that is new, or moved to another store, is verified. A title
// re-submitted exactly as stored is not a fresh claim about a listing and is
// left alone. Nothing unverifiable can ENTER the table this way, because the
// only names that pass unchecked are ones already in it.
router.post('/api/retail-admin/meituan/bundles', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { id, storeId, storeCode, meituanName, maxQty, syncEnabled, components } = req.body || {};
  if (!storeId || !storeCode || !meituanName || !meituanName.trim()) {
    return res.status(400).json({ success: false, error: 'storeId, storeCode and meituanName are required' });
  }
  const sync = syncEnabled === undefined ? 1 : (syncEnabled ? 1 : 0);
  const cap  = (maxQty === undefined || maxQty === null || maxQty === '') ? null : parseInt(maxQty, 10);
  const name = meituanName.trim();
  try {
    // Read before anything changes, so the audit entry can carry the previous
    // title. meituan_bundles is last-write-wins with no history, the same shape
    // meituan_product_map had before d7848b62 — and the same reason a mapping's
    // former name could not be recovered when it mattered.
    const cur = id
      ? db.prepare('SELECT meituan_name, store_code FROM meituan_bundles WHERE id = ?').get(parseInt(id, 10))
      : null;
    const prev = cur ? String(cur.meituan_name || '').trim() : null;
    const nameIsNew = !(cur && prev === name && cur.store_code === storeCode);

    if (nameIsNew) {
      const refusal = mapWrite.verifyName(db, storeCode, name);
      // 409, not 400: the request is well formed and the STATE is what refuses
      // it. Same shape the map route returns, so the client's `e.code` branches
      // and the api() helper's "<message> [<code>]" rendering both work here.
      if (refusal) {
        return res.status(409).json({ success: false, error: refusal.code,
                                      message: refusal.message, catalogue: refusal.catalogue });
      }
    }

    const tx = db.transaction(() => {
      let bundleId = id ? parseInt(id, 10) : null;
      if (bundleId) {
        db.prepare(`
          UPDATE meituan_bundles
             SET meituan_name=?, store_code=?, retail_store_id=?, max_qty=?, sync_enabled=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?
        `).run(name, storeCode, storeId, cap, sync, bundleId);
      } else {
        db.prepare(`
          INSERT INTO meituan_bundles (retail_store_id, store_code, meituan_name, max_qty, sync_enabled)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(retail_store_id, meituan_name) DO UPDATE SET
            store_code=excluded.store_code, max_qty=excluded.max_qty,
            sync_enabled=excluded.sync_enabled, updated_at=CURRENT_TIMESTAMP
        `).run(storeId, storeCode, name, cap, sync);
        bundleId = db.prepare('SELECT id FROM meituan_bundles WHERE retail_store_id=? AND meituan_name=?')
          .get(storeId, name).id;
      }
      db.prepare('DELETE FROM meituan_bundle_components WHERE bundle_id=?').run(bundleId);
      const ins = db.prepare('INSERT OR IGNORE INTO meituan_bundle_components (bundle_id, product_id, qty) VALUES (?, ?, ?)');
      for (const c of (components || [])) {
        if (c && c.productId) ins.run(bundleId, parseInt(c.productId, 10), c.qty > 0 ? parseInt(c.qty, 10) : 1);
      }
      return bundleId;
    });
    const bundleId = tx();

    // Recorded only when the title actually moved, and carrying what it moved
    // FROM: "someone changed this bundle's listing" is the fact no one could
    // establish about bundles 2 and 16 after the event.
    if (nameIsNew) {
      try {
        logActivity(req.user && req.user.id, (req.user && req.user.username) || 'unknown',
          prev == null ? 'meituan_bundle_create' : 'meituan_bundle_name',
          'meituan_bundles', bundleId,
          { store_code: storeCode, from: prev, to: name, sync_enabled: sync },
          req.ip);
      } catch (_) { /* the bundle change already happened; the log is best-effort */ }
    }

    res.json({ success: true, id: bundleId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/api/retail-admin/meituan/bundles/:id', requireRetailAdmin, (req, res) => {
  const db = tdb();
  const id = parseInt(req.params.id, 10);
  try {
    db.prepare('DELETE FROM meituan_bundle_components WHERE bundle_id=?').run(id);
    db.prepare('DELETE FROM meituan_bundles WHERE id=?').run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Enqueue a single bundle's stock now.
router.post('/api/retail-admin/meituan/bundles/:id/push', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const b = db.prepare('SELECT * FROM meituan_bundles WHERE id=?').get(parseInt(req.params.id, 10));
    if (!b) return res.status(404).json({ success: false, error: 'bundle not found' });
    const qty = bundleLib.enqueueBundle(db, b);
    if (qty == null) return res.json({ success: false, error: 'Bundle has no components yet — add at least one product first.' });
    res.json({ success: true, qty });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/retail-admin/meituan/listings/refresh ───────────────────────
// Enqueue a listing-scrape job per store for the daemon to run. Skips stores
// that already have a pending/processing job so repeated clicks don't pile up.
router.post('/api/retail-admin/meituan/listings/refresh', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(
      `SELECT code FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();

    const pending = db.prepare(
      `SELECT store_code FROM meituan_listing_jobs WHERE status IN ('pending','processing')`
    ).all().map(r => r.store_code);

    const insert = db.prepare(
      `INSERT INTO meituan_listing_jobs (store_code, status) VALUES (?, 'pending')`
    );
    const queued = [];
    for (const s of stores) {
      if (pending.includes(s.code)) continue;
      insert.run(s.code);
      queued.push(s.code);
    }

    res.json({ success: true, queued, alreadyRunning: pending });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/retail-admin/meituan/listings ────────────────────────────────
// Cached listing names per store + the latest job status per store (so the UI
// can poll until the scrape finishes).
router.get('/api/retail-admin/meituan/listings', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const rows = db.prepare(
      `SELECT store_code, listing_name FROM meituan_listings ORDER BY store_code, listing_name`
    ).all();
    const listings = {};
    for (const r of rows) (listings[r.store_code] = listings[r.store_code] || []).push(r.listing_name);

    // 货号 → listing name per store, from the captured specs, so Match names can
    // link by SKU before falling back to name similarity. A 货号 that appears on
    // more than one listing is ambiguous and left out (name matching handles it).
    const skus = {};
    try {
      const specRows = db.prepare(`
        SELECT store_code, sku_code, MIN(listing_name) AS listing_name,
               COUNT(DISTINCT listing_name) AS names
          FROM meituan_listing_specs
         WHERE sku_code IS NOT NULL AND TRIM(sku_code) <> ''
         GROUP BY store_code, sku_code
      `).all();
      for (const r of specRows) {
        if (r.names !== 1) continue;
        (skus[r.store_code] = skus[r.store_code] || {})[r.sku_code.trim()] = r.listing_name;
      }
    } catch (_) { /* specs table may predate this feature on old boxes */ }

    // Latest job per store
    const jobs = db.prepare(`
      SELECT j.store_code, j.status, j.result_count, j.error, j.created_at, j.completed_at
        FROM meituan_listing_jobs j
        JOIN (SELECT store_code, MAX(id) AS mx FROM meituan_listing_jobs GROUP BY store_code) m
          ON m.store_code = j.store_code AND m.mx = j.id
    `).all();

    const running = db.prepare(
      `SELECT COUNT(*) AS n FROM meituan_listing_jobs WHERE status IN ('pending','processing')`
    ).get()?.n || 0;

    // How many names each store's catalogue holds and when they were read.
    // The screen had no way to say this, so "the catalogue is two days old" was
    // not a thing an operator could find out — which matters now that a stale
    // catalogue is what refuses a mapping write.
    const catalogue = {};
    for (const row of db.prepare(
      `SELECT store_code, COUNT(*) AS n, MAX(scraped_at) AS at
         FROM meituan_listings GROUP BY store_code`
    ).all()) catalogue[row.store_code] = { count: Number(row.n || 0), scrapedAt: row.at || null };

    res.json({ success: true, listings, skus, jobs, running, catalogue });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Store open/closed (Meituan 营业/休息) ──────────────────────────────────
// The daemon that owns each store's logged-in session reads the live status into
// store_business_status and applies target_open. The web server can't drive
// Playwright, so this just reads that row and (for the toggle) writes target_open.

// GET current open/closed status for every active store.
router.get('/api/retail-admin/meituan/business-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(
      `SELECT code, COALESCE(name_cn, name_en, code) AS name FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();
    const rows = db.prepare('SELECT * FROM store_business_status').all();
    const byCode = {};
    for (const r of rows) byCode[r.store_code] = r;
    const data = stores.map((s) => {
      const r = byCode[s.code] || {};
      let lastResult = null;
      try { lastResult = r.last_result ? JSON.parse(r.last_result) : null; } catch (_) {}
      return {
        storeCode: s.code, name: s.name,
        isOpen: r.is_open === 1,
        mtStatus: r.mt_status != null ? r.mt_status : null,
        subStatus: r.sub_status != null ? r.sub_status : null,
        statusDesc: r.status_desc || null,
        detailDesc: r.detail_desc || null,
        hoursDesc: r.hours_desc || null,
        readOk: r.read_ok === 1,
        readAt: r.read_at || null,
        pending: r.target_open != null,
        targetOpen: r.target_open === 1 ? true : (r.target_open === 0 ? false : null),
        lastResult,
        updatedAt: r.updated_at || null,
      };
    });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST a target: { storeCode, open }. Queues the flip for the daemon to apply.
router.post('/api/retail-admin/meituan/business-status', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { storeCode, open } = req.body || {};
  if (!storeCode || typeof open !== 'boolean') {
    return res.status(400).json({ success: false, error: 'storeCode and open (boolean) are required' });
  }
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code = ? AND is_active = 1').get(storeCode);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    const r = setChannelOpen(db, { channel: 'meituan', storeCode, open, by });
    res.json({ success: true, storeCode, target: open ? 'open' : 'closed',
      cleared: r.cleared, refilled: r.refilled,
      note: 'Queued — the sync daemon applies it within ~1 min and refreshes the live status.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Master store status (online storefront + Meituan) ─────────────────────────
// One panel over every sales channel we control: the online storefront (mini-app +
// web, a storefront_config 'store_status' flag enforced at POST /api/retail/orders)
// + each Meituan store (置休 via store_business_status, applied by the sync daemons).
// gzgrocery is a read-only B2B mirror, so it's not a closable channel here.

function readOnlineStatus(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key='store_status'").get();
    const v = row ? JSON.parse(row.value_json) : {};
    return {
      online_open: !(v.online_open === false || v.online_open === 0),
      message_en: v.message_en || '',
      message_cn: v.message_cn || '',
    };
  } catch (e) { return { online_open: true, message_en: '', message_cn: '' }; }
}
function writeOnlineStatus(db, val, by) {
  db.prepare(`
    INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
      VALUES ('store_status', ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
  `).run(JSON.stringify(val), by || 'backend');
}

// GET the whole panel: online storefront + each Meituan store + derived master.
router.get('/api/retail-admin/store-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const online = readOnlineStatus(db);
    const stores = db.prepare(
      `SELECT code, COALESCE(name_cn, name_en, code) AS name FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id`
    ).all();
    const rows = db.prepare('SELECT * FROM store_business_status').all();
    const byCode = {};
    for (const r of rows) byCode[r.store_code] = r;
    const meituan = stores.map((s) => {
      const r = byCode[s.code];
      const row = r || {};
      return {
        storeCode: s.code, name: s.name,
        // `linked` — is this shop known to the marketplace channel AT ALL? A shop
        // with no status row has never been read or pushed, which is a different
        // fact from "closed" and must not be shown as one.
        linked: !!r,
        isOpen: row.is_open === 1, readOk: row.read_ok === 1,
        pending: row.target_open != null, statusDesc: row.status_desc || null,
        fulfillmentOpen: row.fulfillment_open !== 0, // whether it still ships online orders
      };
    });
    // Master reflects the union: open only if EVERYTHING is open, closed only if
    // EVERYTHING is closed, else 'mixed'.
    //
    // A shop counts as open when it is still fulfilling orders AND — only if it
    // is linked to the marketplace — the marketplace shop is open too. Counting
    // an unlinked shop's `is_open` (which is false because there is no row, not
    // because anybody closed anything) told a merchant with no marketplace
    // integration that their whole business was closed while it was trading.
    const flags = [online.online_open,
      ...meituan.map((m) => m.fulfillmentOpen && (m.linked ? m.isOpen : true))];
    const master = flags.every(Boolean) ? 'open' : (flags.every((f) => !f) ? 'closed' : 'mixed');
    res.json({ success: true, online, meituan, master });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Flip just the online storefront (mini-app + web). Optional custom closed message.
router.post('/api/retail-admin/store-status/online', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { open, message_en, message_cn } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    const cur = readOnlineStatus(db);
    const val = {
      online_open: open,
      message_en: message_en != null ? String(message_en).slice(0, 300) : cur.message_en,
      message_cn: message_cn != null ? String(message_cn).slice(0, 300) : cur.message_cn,
    };
    writeOnlineStatus(db, val, by);
    res.json({ success: true, online: val });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Master flip: EVERY sales channel at once — online storefront + queue every
// Meituan store closed/open (the daemons apply the Meituan side within ~1 min).
router.post('/api/retail-admin/store-status/master', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { open } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    const cur = readOnlineStatus(db);
    const val = { online_open: open, message_en: cur.message_en, message_cn: cur.message_cn };
    const stores = db.prepare('SELECT code FROM retail_stores WHERE is_active = 1').all();
    // Master flips the whole store: Meituan POI (via setChannelOpen, which also
    // deals with that store's queued pushes) AND online fulfillment
    // (fulfillment_open, immediate) together. fulfillment_open is written here
    // rather than inside setChannelOpen because it is shop-wide, not per-channel.
    const setFulfilment = db.prepare(`
      INSERT INTO store_business_status (store_code, fulfillment_open, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(store_code) DO UPDATE SET
        fulfillment_open = excluded.fulfillment_open, updated_at = CURRENT_TIMESTAMP
    `);
    let cleared = 0;
    db.transaction(() => {
      writeOnlineStatus(db, val, by);
      for (const s of stores) {
        const r = setChannelOpen(db, { channel: 'meituan', storeCode: s.code, open, by });
        cleared += r.cleared || 0;
        setFulfilment.run(s.code, open ? 1 : 0);
      }
    })();
    res.json({ success: true, online: val, meituanQueued: stores.map((s) => s.code),
      target: open ? 'open' : 'closed', cleared });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Close/open a WHOLE store: its Meituan POI (置休, daemon-applied within ~1 min)
// AND its online fulfillment (fulfillment_open, effective immediately — reroutes
// its pickup + deliveries + out-of-city shipping to the other store). This is the
// per-store "the shop isn't operating" switch, distinct from the Meituan-channel-
// only toggle on the Meituan tab.
router.post('/api/retail-admin/store-status/store/:code', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const code = req.params.code;
  const { open } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'open (boolean) is required' });
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code = ? AND is_active = 1').get(code);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend';
    // Meituan POI + its queued pushes go through the one close operation;
    // fulfillment_open is shop-wide, so it is written alongside rather than
    // inside it.
    let r;
    db.transaction(() => {
      r = setChannelOpen(db, { channel: 'meituan', storeCode: code, open, by });
      db.prepare(`
        INSERT INTO store_business_status (store_code, fulfillment_open, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(store_code) DO UPDATE SET
          fulfillment_open = excluded.fulfillment_open, updated_at = CURRENT_TIMESTAMP
      `).run(code, open ? 1 : 0);
    })();
    res.json({
      success: true, storeCode: code, target: open ? 'open' : 'closed',
      cleared: r.cleared, refilled: r.refilled,
      note: 'Fulfillment reroute is immediate; the Meituan close applies within ~1 min.',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Channel × location status matrix (Sales grid) ─────────────────────────────
// The sales grid is channel × location. mini_app/web/eleme/gzgrocery live in
// channel_status (absent row = open); meituan uses store_business_status (the
// daemon applies 置休). gzgrocery is tianhe-only. This drives the Sales-page cards:
// per-channel popup (Yuexiu/Tianhe/close-all) + the two location masters.
// 'pos' is the counter till (/till). It joins the grid rather than getting a
// switch of its own because a shop closing its counter is the same KIND of
// act as closing Meituan — and the location master, which closes every
// channel at a store, would otherwise leave the till selling from a shop the
// operator had just marked shut. It needs no special-casing anywhere below:
// it stores in channel_status like mini_app/web/eleme, and serves every
// active store (unlike gzgrocery, which is tianhe-only).
//
// eleme used to be excluded from `integrated` below (OAuth was dead, so there
// was no real channel to open/close) — it's browser automation now
// (lib/eleme-browser.js), stores in channel_status exactly like mini_app/web/
// gzgrocery/pos with no special-casing needed here, and eleme-daemon.js
// already reads this same table via channelClosedStores('eleme') to gate
// stock pushes. Marking it integrated is what the Sales-page card needs to
// unlock its toggle and show the per-location rows.
const GRID_CHANNELS = ['mini_app', 'web', 'meituan', 'eleme', 'gzgrocery', 'pos'];
function csStores(db, channel) {
  const all = db.prepare("SELECT code, name_en, name_cn, COALESCE(name_cn,name_en,code) AS name FROM retail_stores WHERE is_active=1 ORDER BY sort_order,id").all();
  return channel === 'gzgrocery' ? all.filter(s => s.code === 'tianhe') : all;
}
function csCellOpen(db, channel, storeCode) {
  if (channel === 'meituan') {
    // The Meituan cell is the POI's own 营业/停业 state, read back off the merchant
    // site — a shop-wide fulfilment close doesn't change what Meituan reports.
    const r = db.prepare('SELECT is_open FROM store_business_status WHERE store_code=?').get(storeCode);
    return r && r.is_open != null ? r.is_open === 1 : true; // unknown → assume open
  }
  // Shop-wide close (fulfillment_open = 0) beats the per-channel cell: the routing
  // in lib/inventory drops the store from every channel, so the grid says so too
  // rather than showing cells "open" that can no longer receive an order.
  const f = db.prepare('SELECT fulfillment_open FROM store_business_status WHERE store_code=?').get(storeCode);
  if (f && f.fulfillment_open === 0) return false;
  const r = db.prepare('SELECT is_open FROM channel_status WHERE channel=? AND store_code=?').get(channel, storeCode);
  return r ? r.is_open === 1 : true; // absent = open
}
// Closing a Meituan location also stops its stock sync (lib/meituan-bundles.js
// storePushEnabled reads the same target_open), so the queue has to be dealt
// with here: drop what it was holding, because a push to a store the operator
// switched off will never be wanted. Re-opening queues a fresh FULL push rather
// than replaying the dropped rows — after a pause only the current stock is
// worth sending, not a trail of stale intermediate values.
// The flag write and the queued-push clear are ONE operation now, and it lives in
// lib/store-close.js — so no route in this file can perform half of it, and none
// of them writes target_open or channel_status.is_open directly any more.
function csSetCell(db, channel, storeCode, open, by) {
  setChannelOpen(db, { channel, storeCode, open, by });
}
function csBy(req) { return (req.backendUser && (req.backendUser.username || req.backendUser.name)) || 'backend'; }

// GET the whole matrix: each channel's per-location cells + card state, plus the
// two location masters.
router.get('/api/retail-admin/channel-status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare("SELECT code, name_en, name_cn, COALESCE(name_cn,name_en,code) AS name FROM retail_stores WHERE is_active=1 ORDER BY sort_order,id").all();
    const mt = {}; for (const r of db.prepare('SELECT * FROM store_business_status').all()) mt[r.store_code] = r;
    const channels = GRID_CHANNELS.map((ch) => {
      const cells = csStores(db, ch).map((s) => {
        const cell = { storeCode: s.code, name: s.name, nameEn: s.name_en || s.name, nameCn: s.name_cn || s.name, open: csCellOpen(db, ch, s.code) };
        if (ch === 'meituan') { const r = mt[s.code] || {}; cell.readOk = r.read_ok === 1; cell.pending = r.target_open != null; cell.statusDesc = r.status_desc || null; }
        return cell;
      });
      return { channel: ch, integrated: true, single: ch === 'gzgrocery' ? 'tianhe' : null,
               cells, cardOpen: cells.some((c) => c.open) };
    });
    const locations = stores.map((s) => {
      const applies = GRID_CHANNELS.filter((ch) => ch !== 'gzgrocery' || s.code === 'tianhe');
      return { storeCode: s.code, name: s.name, nameEn: s.name_en || s.name, nameCn: s.name_cn || s.name, allOpen: applies.every((ch) => csCellOpen(db, ch, s.code)) };
    });
    res.json({ success: true, stores, channels, locations });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// What reopening a cell is about to publish — read-only, no side effects. Only
// Meituan pushes a full snapshot on reopen today (csSyncQueueForCell); every
// other channel currently just flips channel_status with nothing behind it, so
// this returns an empty preview for those rather than guessing at a shape that
// doesn't exist yet. No new column, no recount tracking: "how recently
// touched" reads straight off retail_store_stock.updated_at, the same column
// every stock edit already writes — a product with no row at all (never
// touched at this store) sorts first, ahead of any real timestamp, because
// that is the least trustworthy number of all.
router.get('/api/retail-admin/channel-status/reopen-preview', requireRetailAdmin, (req, res) => {
  const db = tdb();
  const { channel, storeCode } = req.query || {};
  if (!GRID_CHANNELS.includes(channel) || !storeCode) {
    return res.status(400).json({ success: false, error: 'channel, storeCode required' });
  }
  try {
    if (channel !== 'meituan') return res.json({ success: true, count: 0, items: [] });
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(p.name_en), ''), NULLIF(TRIM(p.name_cn), '')) AS name,
             p.sku, s.updated_at
        FROM meituan_product_map m
        LEFT JOIN retail_store_stock s ON s.store_id = m.retail_store_id AND s.product_id = m.product_id
        LEFT JOIN store_products p ON p.id = m.product_id
       WHERE m.store_code = ? AND m.sync_enabled = 1 AND m.meituan_name IS NOT NULL
       ORDER BY (s.updated_at IS NOT NULL), s.updated_at ASC
    `).all(storeCode);
    const previewLimit = Math.min(Math.max(parseInt(req.query.preview || '5', 10) || 5, 1), 50);
    res.json({
      success: true,
      count: rows.length,
      items: rows.slice(0, previewLimit).map((r) => ({ name: r.name || r.sku || '—', sku: r.sku || null, updatedAt: r.updated_at || null })),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Set one cell (channel × store).
router.post('/api/retail-admin/channel-status/cell', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { channel, storeCode, open } = req.body || {};
  if (!GRID_CHANNELS.includes(channel) || !storeCode || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'channel, storeCode, open (boolean) required' });
  if (channel === 'gzgrocery' && storeCode !== 'tianhe') return res.status(400).json({ success: false, error: 'gzgrocery is tianhe-only' });
  try { csSetCell(db, channel, storeCode, open, csBy(req)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Set every location of one channel (the popup's "close all").
router.post('/api/retail-admin/channel-status/channel', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { channel, open } = req.body || {};
  if (!GRID_CHANNELS.includes(channel) || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'channel, open (boolean) required' });
  try {
    const by = csBy(req); const stores = csStores(db, channel);
    db.transaction(() => { for (const s of stores) csSetCell(db, channel, s.code, open, by); })();
    res.json({ success: true, stores: stores.map((s) => s.code) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Location master: set EVERY channel for one location, plus the shop-wide
// fulfilment switch. "Close this location" means the shop isn't operating, so it
// must also stop being a routing/pickup candidate (fulfillment_open) — leaving
// that at 1 while every channel cell reads closed is the state that let a closed
// shop keep being named as the customer's nearest store at checkout.
router.post('/api/retail-admin/channel-status/location', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { storeCode, open } = req.body || {};
  if (!storeCode || typeof open !== 'boolean') return res.status(400).json({ success: false, error: 'storeCode, open (boolean) required' });
  try {
    const st = db.prepare('SELECT code FROM retail_stores WHERE code=? AND is_active=1').get(storeCode);
    if (!st) return res.status(404).json({ success: false, error: 'unknown store' });
    const by = csBy(req);
    const applies = GRID_CHANNELS.filter((ch) => ch !== 'gzgrocery' || storeCode === 'tianhe');
    db.transaction(() => {
      for (const ch of applies) csSetCell(db, ch, storeCode, open, by);
      db.prepare(`
        INSERT INTO store_business_status (store_code, fulfillment_open, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(store_code) DO UPDATE SET
          fulfillment_open = excluded.fulfillment_open, updated_at = CURRENT_TIMESTAMP
      `).run(storeCode, open ? 1 : 0);
    })();
    res.json({ success: true, channels: applies });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
