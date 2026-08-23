// Admin + OAuth API for the Eleme (饿了么开放平台) sales channel.
// Mounted in server.js alongside the other retail-admin routers.
//
// Auth: data endpoints use requireRetailAdmin (the dual-realm gate every other
// /api/retail-admin/* route uses). The OAuth callback is intentionally PUBLIC
// (Eleme redirects the merchant's browser to it) and is instead protected by a
// stateless HMAC-signed `state` we mint at start and verify on return.
//
// Response shape: { success: true, ... } so the admin api() helper is happy.

'use strict';

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const router  = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const eleme = require('../lib/eleme-client');
const elemeSync = require('../lib/eleme-sync');

// ── Token persistence (shared shape with the daemon) ───────────────────────────
function saveToken(db, account, tok) {
  const expiresAt = Date.now() + (Number(tok.expires_in) || 0) * 1000;
  db.prepare(`
    INSERT INTO eleme_tokens (account, access_token, refresh_token, token_type, scope, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=COALESCE(excluded.refresh_token, eleme_tokens.refresh_token),
      token_type=excluded.token_type, scope=excluded.scope,
      expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP
  `).run(account, tok.access_token, tok.refresh_token || null,
         tok.token_type || null, tok.scope || null, expiresAt);
}

// ── Stateless OAuth `state` (HMAC over storeId:storeCode:exp) ───────────────────
function stateSecret() { return process.env.ELEME_APP_SECRET || 'eleme-state'; }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function makeState(storeId, storeCode) {
  const payload = `${storeId}:${storeCode}:${Date.now() + 15 * 60_000}`; // 15-min validity
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}
function verifyState(state) {
  try {
    const [p, s] = String(state || '').split('.');
    if (!p || !s) return null;
    const payload = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const expect = b64url(crypto.createHmac('sha256', stateSecret()).update(payload).digest());
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
    const [storeId, storeCode, exp] = payload.split(':');
    if (Date.now() > Number(exp)) return null;
    return { storeId: parseInt(storeId, 10), storeCode };
  } catch { return null; }
}

// ── Feature switch ─────────────────────────────────────────────────────────────
router.get('/api/retail-admin/eleme/config', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'eleme.enabled'").get();
    const enabled = row ? JSON.parse(row.value_json) === true : false;
    res.json({
      success: true,
      configured: eleme.isConfigured(),
      sandbox: process.env.ELEME_SANDBOX === '1',
      redirectUri: process.env.ELEME_REDIRECT_URI || '',
      enabled,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/api/retail-admin/eleme/enable', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  try {
    const enabled = !!(req.body && req.body.enabled);
    db.prepare(`
      INSERT INTO storefront_config (key, value_json, updated_at)
      VALUES ('eleme.enabled', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(enabled));
    res.json({ success: true, enabled });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Catalogue cache (Eleme-name autocomplete source) ────────────────────────────
// Written by scripts/eleme-daemon.js (the only process holding a live Eleme
// session); this just reads it. `refreshedAt` is the oldest row's timestamp
// (a partial refresh mid-write would otherwise report the newest row's time
// as if the whole set were that fresh) so the UI can be honest about staleness.
router.get('/api/retail-admin/eleme/catalogue', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const storeCode = String(req.query.storeCode || '').trim();
    if (!storeCode) return res.status(400).json({ success: false, error: 'storeCode required' });
    const raw = db.prepare(`
      SELECT name, stock, specs, updated_at FROM eleme_catalogue_cache
       WHERE store_code = ? ORDER BY name
    `).all(storeCode);
    // `specs` is the JSON array of sizes behind this one listing name (written
    // by the daemon). Parsed here so the admin can offer a size picker; a row
    // cached before that column existed simply has none.
    const rows = raw.map(r => {
      let specs = [];
      try { specs = r.specs ? JSON.parse(r.specs) : []; } catch (_) { specs = []; }
      return { name: r.name, stock: r.stock, updated_at: r.updated_at, specs: Array.isArray(specs) ? specs : [] };
    });
    const refreshedAt = rows.length
      ? rows.reduce((min, r) => (r.updated_at < min ? r.updated_at : min), rows[0].updated_at)
      : null;
    res.json({ success: true, data: rows, refreshedAt });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Stores + connection state ──────────────────────────────────────────────────
// Eleme is browser automation (lib/eleme-browser.js), not OAuth — the open
// platform rejects our single-store accounts (see ELEME_BROWSER_RECON.md).
// "connected" used to mean an eleme_tokens.access_token; that path is dead and
// permanently empty now. The real signal is whether the store's login session
// is on disk (written by scripts/eleme-login.js, restored by lib/eleme-
// browser.js) — sessionActive below. `connected` is kept (now meaning
// "shop id linked") only so any older caller reading that field still gets a
// sane boolean rather than a silently-wrong one.
router.get('/api/retail-admin/eleme/stores', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const stores = db.prepare(`
      SELECT s.id, s.code, COALESCE(s.name_cn, s.name_en, s.code) AS name,
             COALESCE(s.name_en, s.name_cn, s.code) AS nameEn,
             e.shop_id, e.shop_name,
             (e.shop_id IS NOT NULL AND e.shop_id <> '') AS connected
        FROM retail_stores s
        LEFT JOIN eleme_shops  e ON e.retail_store_id = s.id
       WHERE s.is_active = 1
       ORDER BY s.sort_order, s.id
    `).all();
    const sessionDir = path.join(__dirname, '..', 'data', 'eleme-sessions');
    for (const s of stores) s.sessionActive = fs.existsSync(path.join(sessionDir, `${s.code}-session.json`));
    res.json({ success: true, data: stores });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Manually set / clear a store's Eleme shop id (after connecting).
router.post('/api/retail-admin/eleme/shop', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const { storeId, storeCode, shopId, shopName } = req.body || {};
  if (!storeId || !storeCode) return res.status(400).json({ success: false, error: 'storeId and storeCode required' });
  try {
    db.prepare(`
      INSERT INTO eleme_shops (retail_store_id, store_code, shop_id, shop_name, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(retail_store_id) DO UPDATE SET
        shop_id = excluded.shop_id, shop_name = excluded.shop_name,
        store_code = excluded.store_code, updated_at = CURRENT_TIMESTAMP
    `).run(storeId, storeCode, shopId ? String(shopId).trim() : null, shopName || null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Merge one incoming /map body over the row already in eleme_product_map.
//
// The write below is a WHOLE-ROW upsert, so any column the caller didn't send
// would be wiped. The rule here: `undefined` keeps what's stored, an explicit
// null or '' clears it. (Before this, every caller had to echo eleme_name back
// on a sync toggle or silently lose the operator's override.)
//
// The one non-obvious part is the size. A size id belongs to ONE listing, so if
// the listing name just changed and no size came with it, the stored pick now
// points at a size on a different listing — drop it rather than push against
// it. Exported for tests; pure, no DB.
function mergeMapFields(cur, body) {
  const keep = (incoming, existing) => {
    if (incoming === undefined) return existing == null ? null : existing;
    const v = incoming == null ? '' : String(incoming).trim();
    return v || null;
  };
  const nextExtend = keep(body.extendCode, cur.extend_code);
  const nextName   = keep(body.elemeName,  cur.eleme_name);
  const nameChanged = nextName !== (cur.eleme_name == null ? null : cur.eleme_name);
  const specGiven   = body.specId !== undefined;
  return {
    nextExtend,
    nextName,
    nextSpecId:   specGiven ? keep(body.specId, null)   : (nameChanged ? null : (cur.spec_id   || null)),
    nextSpecName: specGiven ? keep(body.specName, null) : (nameChanged ? null : (cur.spec_name || null)),
  };
}

// ── Product mapping ────────────────────────────────────────────────────────────
router.get('/api/retail-admin/eleme/products', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const includeInactive = req.query.includeInactive === '1';
    const products = db.prepare(`
      SELECT p.id, p.name_cn, p.name_en, p.sku, p.category, p.is_active,
             p.variant_label, p.variant_group_id
        FROM store_products p
       ${includeInactive ? '' : 'WHERE p.is_active = 1'}
       ORDER BY p.name_cn, p.variant_group_id, p.id
    `).all();
    const maps = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code, m.extend_code, m.eleme_name,
             m.spec_id, m.spec_name,
             m.sync_enabled, m.last_pushed_qty, m.last_pushed_at,
             -- How many sizes the mapped listing holds. Drives the Multi-size
             -- filter and the "pick a size" flag: on Eleme a size CAN be
             -- targeted, so a multi-size listing with none picked is a real
             -- gap, not just a note.
             (SELECT json_array_length(c.specs) FROM eleme_catalogue_cache c
               WHERE c.store_code = m.store_code AND c.name = m.eleme_name) AS specCount
        FROM eleme_product_map m
    `).all();
    const idx = {};
    for (const m of maps) { (idx[m.product_id] = idx[m.product_id] || {})[m.store_code] = m; }
    res.json({ success: true, data: products.map(p => ({ ...p, stores: idx[p.id] || {} })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Upsert/clear a product's Eleme mapping for one store. By default Eleme maps by
// 货号 (the product's SKU), so a row only needs to exist to ENABLE sync; the
// extendCode/elemeName fields are optional overrides.
router.post('/api/retail-admin/eleme/products/:id/map', requireRetailAdmin, express.json(), (req, res) => {
  const db = tdb();
  const productId = parseInt(req.params.id, 10);
  const { storeId, storeCode, extendCode, elemeName, specId, specName, syncEnabled, remove } = req.body || {};
  if (!storeId || !storeCode) return res.status(400).json({ success: false, error: 'storeId and storeCode required' });
  try {
    if (remove) {
      db.prepare('DELETE FROM eleme_product_map WHERE product_id = ? AND retail_store_id = ?').run(productId, storeId);
      return res.json({ success: true, deleted: true });
    }
    const cur = db.prepare('SELECT * FROM eleme_product_map WHERE product_id = ? AND retail_store_id = ?')
                  .get(productId, storeId) || {};
    const { nextExtend, nextName, nextSpecId, nextSpecName } =
      mergeMapFields(cur, { extendCode, elemeName, specId, specName });
    db.prepare(`
      INSERT INTO eleme_product_map
        (product_id, retail_store_id, store_code, extend_code, eleme_name, spec_id, spec_name, sync_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(retail_store_id, product_id) DO UPDATE SET
        extend_code = excluded.extend_code, eleme_name = excluded.eleme_name,
        spec_id = excluded.spec_id, spec_name = excluded.spec_name,
        store_code = excluded.store_code, sync_enabled = excluded.sync_enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(productId, storeId, storeCode, nextExtend, nextName, nextSpecId, nextSpecName,
           syncEnabled === undefined ? 1 : (syncEnabled ? 1 : 0));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Per-store health, on the same contract as the Meituan page's store cards.
//
// A store is blocked when it cannot push at all: no shop id linked (never set
// up) or no saved session (needs a login). Unlike Meituan there is no
// needs_login event to read — eleme_sync_log only carries stock_push rows — so
// the session file on disk is the signal, exactly as /eleme/stores reports it.
//
// A run of push errors is deliberately NOT "blocked": pushes fail for ordinary
// reasons (a renamed listing, a 审核 queue) while the channel itself is fine,
// and colouring that amber would cry wolf on the one state that means "a
// person is needed".
function elemeStoreHealth(db) {
  const stores = db.prepare(`
    SELECT s.id, s.code, COALESCE(s.name_cn, s.name_en, s.code) AS name,
             COALESCE(s.name_en, s.name_cn, s.code) AS nameEn,
           e.shop_id, e.shop_name
      FROM retail_stores s
      LEFT JOIN eleme_shops e ON e.retail_store_id = s.id
     WHERE s.is_active = 1
     ORDER BY s.sort_order, s.id
  `).all();

  const sessionDir = path.join(__dirname, '..', 'data', 'eleme-sessions');
  const queueRow = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'error' AND processed_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS failed
      FROM eleme_sync_queue WHERE store_code = ?
  `);
  const lastPush = db.prepare(`
    SELECT MAX(created_at) AS t FROM eleme_sync_log
     WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok'
  `);
  const lastOrder = db.prepare(
    'SELECT MAX(imported_at) AS t FROM eleme_order_import WHERE store_code = ?');
  const liveCount = db.prepare(`
    SELECT COUNT(*) AS n FROM eleme_product_map m
      JOIN store_products p ON p.id = m.product_id
     WHERE m.store_code = ? AND m.sync_enabled = 1 AND p.is_active = 1
  `);
  // The catalogue cache is what the name + size pickers read. Stale or missing
  // is worth saying on the card: without it an operator cannot map anything.
  const cat = db.prepare(`
    SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM eleme_catalogue_cache WHERE store_code = ?
  `);
  const activeProducts = db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE is_active = 1').get()?.n || 0;

  return stores.map(st => {
    let sessionActive = false;
    try { sessionActive = fs.existsSync(path.join(sessionDir, `${st.code}-session.json`)); } catch (e) {}
    const shopSet = !!(st.shop_id && String(st.shop_id).trim());
    const q = queueRow.get(st.code) || {};
    const live = liveCount.get(st.code)?.n || 0;
    const c = cat.get(st.code) || {};
    return {
      id: st.id,
      code: st.code,
      name: st.name,
      shopId: st.shop_id || null,
      shopName: st.shop_name || null,
      blocked: !shopSet || !sessionActive,
      blockedBy: !shopSet ? 'no_shop' : (!sessionActive ? 'needs_login' : null),
      lastPushAt:  lastPush.get(st.code)?.t || null,
      lastOrderAt: lastOrder.get(st.code)?.t || null,
      pending:    Number(q.pending    || 0),
      processing: Number(q.processing || 0),
      failed:     Number(q.failed     || 0),
      live,
      unmatched: Math.max(0, activeProducts - live),
      catalogueCount: Number(c.n || 0),
      catalogueAt: c.t || null,
    };
  });
}

// ── Status dashboard ───────────────────────────────────────────────────────────
router.get('/api/retail-admin/eleme/status', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queuePending = db.prepare("SELECT COUNT(*) AS n FROM eleme_sync_queue WHERE status='pending'").get()?.n || 0;
    const queueError   = db.prepare("SELECT COUNT(*) AS n FROM eleme_sync_queue WHERE status='error'").get()?.n || 0;
    const mappedCount  = db.prepare("SELECT COUNT(*) AS n FROM eleme_product_map WHERE sync_enabled=1").get()?.n || 0;
    // created_at/imported_at are raw SQLite CURRENT_TIMESTAMP (UTC, no zone
    // marker) — localize to Guangzhou (+8h) here, matching the convention
    // routes/retail.js's activity ledger uses (datetime(x,'+8 hours')), so the
    // admin never has to reason about timezones on the display side.
    const recentStock = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, datetime(created_at,'+8 hours') AS created_at
        FROM eleme_sync_log WHERE event_type='stock_push'
        ORDER BY created_at DESC LIMIT 25
    `).all();
    const recentSystem = db.prepare(`
      SELECT store_code, event_type, status, detail, error_msg, datetime(created_at,'+8 hours') AS created_at
        FROM eleme_sync_log WHERE event_type<>'stock_push'
        ORDER BY created_at DESC LIMIT 8
    `).all();
    const lastOrder = db.prepare(`
      SELECT eleme_order_id, store_code, datetime(imported_at,'+8 hours') AS imported_at, status
        FROM eleme_order_import ORDER BY imported_at DESC LIMIT 5
    `).all();
    let stores = [];
    try { stores = elemeStoreHealth(db); } catch (e) { stores = []; }
    res.json({ success: true, stores, queuePending, queueError, mappedCount, recentStock, recentSystem, lastOrder });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Incoming Eleme orders (read-only ledger) ───────────────────────────────────
router.get('/api/retail-admin/eleme/orders', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const orders = db.prepare(`
      SELECT o.id, o.order_no, o.total, o.placed_at,
             s.code AS store_code, s.name_en AS store_name_en, s.name_cn AS store_name_cn
        FROM retail_orders o
        LEFT JOIN retail_stores s ON s.id = o.store_id
       WHERE o.channel = 'eleme'
       ORDER BY o.placed_at DESC LIMIT ?
    `).all(limit);
    const itemStmt = db.prepare('SELECT name_cn, name_en, qty FROM retail_order_items WHERE order_id = ? ORDER BY id');
    for (const o of orders) o.items = itemStmt.all(o.id);
    res.json({ success: true, data: orders });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Push all mapped stock now ──────────────────────────────────────────────────
router.post('/api/retail-admin/eleme/push-all', requireRetailAdmin, (req, res) => {
  const db = tdb();
  try {
    const queued = elemeSync.enqueueAll(db);
    res.json({ success: true, queued });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── OAuth: start ───────────────────────────────────────────────────────────────
// Returns the Eleme authorize URL the operator opens to connect a store.
router.get('/api/retail-admin/eleme/oauth/start', requireRetailAdmin, (req, res) => {
  try {
    if (!eleme.isConfigured()) return res.status(400).json({ success: false, error: 'Eleme app credentials not set on the server (ELEME_APP_KEY / ELEME_APP_SECRET).' });
    const storeId   = parseInt(req.query.storeId, 10);
    const storeCode = String(req.query.storeCode || '');
    if (!storeId || !storeCode) return res.status(400).json({ success: false, error: 'storeId and storeCode required' });
    if (!process.env.ELEME_REDIRECT_URI) return res.status(400).json({ success: false, error: 'ELEME_REDIRECT_URI not set on the server.' });
    const url = eleme.authorizeUrl(makeState(storeId, storeCode));
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── OAuth: callback (PUBLIC — Eleme redirects the merchant browser here) ────────
router.get('/eleme/oauth/callback', async (req, res) => {
  const { code, state } = req.query || {};
  const fail = (msg) => res.status(400).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto"><h2>Eleme connection failed</h2><p>${msg}</p><p><a href="/retail-admin">Back to admin</a></p></body>`);
  const st = verifyState(state);
  if (!st) return fail('Invalid or expired authorization state. Please start the connection again from the admin.');
  if (!code) return fail('No authorization code returned by Eleme.');
  try {
    const tok = await eleme.exchangeCode(code);
    const db  = tdb();
    saveToken(db, st.storeCode, tok);

    // Best-effort shop discovery so the operator doesn't have to paste a shop id.
    // The exact getUser shape varies by API version; probe common fields and only
    // auto-set when there is exactly one shop. Otherwise leave it for manual entry.
    let shopId = null, shopName = null;
    try {
      const u = await eleme.user.getUser(tok.access_token);
      const shops = (u && (u.authorizedShops || u.shops || u.shopIds)) || [];
      const list = Array.isArray(shops) ? shops : [];
      if (list.length === 1) {
        const s0 = list[0];
        shopId = String(s0.id || s0.shopId || s0) || null;
        shopName = s0.name || s0.shopName || null;
      }
    } catch { /* discovery optional */ }
    if (shopId) {
      db.prepare(`
        INSERT INTO eleme_shops (retail_store_id, store_code, shop_id, shop_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(retail_store_id) DO UPDATE SET
          shop_id=excluded.shop_id, shop_name=excluded.shop_name, updated_at=CURRENT_TIMESTAMP
      `).run(st.storeId, st.storeCode, shopId, shopName);
    } else {
      // Ensure a row exists so the admin shows "connected, shop not set".
      db.prepare(`
        INSERT OR IGNORE INTO eleme_shops (retail_store_id, store_code, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `).run(st.storeId, st.storeCode);
    }
    db.prepare(`INSERT INTO eleme_sync_log (store_code, event_type, status, detail) VALUES (?, 'oauth_connected', 'ok', ?)`)
      .run(st.storeCode, JSON.stringify({ shopId: shopId || null }));

    res.redirect(`/retail-admin?eleme=connected${shopId ? '' : '&shop=unset'}`);
  } catch (err) {
    console.error('[eleme-admin] oauth callback error:', err);
    return fail(`Token exchange failed: ${String(err.message).slice(0, 200)}`);
  }
});

module.exports = router;
module.exports.mergeMapFields = mergeMapFields;
