// Internal-only API for the eleme-daemon process.
// Localhost + X-Internal-Secret only. Mounted at /api/internal/eleme in server.js.
// Mirrors meituan-internal: ingest a parsed Eleme order, create a retail_order
// (channel='eleme') and deduct stock via the ledgered adjuster (which re-pushes
// the corrected number back to every channel, including Eleme itself).

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../database');
const inventory = require('../lib/inventory');

const INTERNAL_SECRET = process.env.ELEME_INTERNAL_SECRET || 'eleme-daemon-internal';

router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'forbidden' });
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
});

// Collapse a name for fuzzy comparison (drop spec parens, spaces, punctuation).
function normName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// Resolve one Eleme line item to a store_product. Order, most reliable first:
//   1. 货号 / extendCode → store_products.sku
//   2. eleme_product_map by Eleme listing name (per store)
//   3. unique active name match (CJK then English)
function resolveProduct(item, storeId) {
  const qty = parseInt(item.qty, 10) || 0;
  const out = { name: item.name, sku: item.sku || null, qty, productId: null, nameCn: item.name, nameEn: item.name, matchBy: null };
  const apply = (p, by) => { out.productId = p.id; out.nameCn = p.name_cn; out.nameEn = p.name_en; out.matchBy = by; };

  if (item.sku) {
    const p = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ? AND is_active = 1').get(item.sku)
           || db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE sku = ?').get(item.sku);
    if (p) { apply(p, 'sku'); return out; }
    out.matchBy = 'sku_unknown';
  }

  if (storeId) {
    const wanted = normName(item.name);
    if (wanted) {
      const rows = db.prepare(`
        SELECT p.id, p.name_cn, p.name_en, m.eleme_name
          FROM eleme_product_map m
          JOIN store_products p ON p.id = m.product_id
         WHERE m.retail_store_id = ? AND p.is_active = 1 AND m.eleme_name IS NOT NULL
      `).all(storeId);
      let hit = rows.find(r => normName(r.eleme_name) === wanted);
      if (!hit) {
        const cands = rows.filter(r => {
          const mn = normName(r.eleme_name);
          return mn && (mn.includes(wanted) || wanted.includes(mn));
        });
        if (cands.length === 1) hit = cands[0];
      }
      if (hit) { apply(hit, 'map'); return out; }
    }
  }

  const clean = String(item.name || '').replace(/\([^)]*\)/g, ' ').trim();
  const cjk = (clean.match(/[一-鿿]+/) || [])[0];
  const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
  let matches = [];
  if (cjk) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?').all(`%${cjk}%`);
  if (matches.length !== 1 && en) matches = db.prepare('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?').all(`%${en.trim()}%`);
  if (matches.length === 1) { apply(matches[0], 'name'); }
  else if (!out.matchBy || out.matchBy === 'sku_unknown') out.matchBy = matches.length > 1 ? 'ambiguous' : 'unmatched';
  return out;
}

// POST /api/internal/eleme/ingest-order
router.post('/ingest-order', (req, res) => {
  const { storeId, storeCode, order } = req.body || {};
  if (!storeId || !order) return res.status(400).json({ error: 'storeId and order required' });

  try {
    const now      = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand     = Math.floor(Math.random() * 900000) + 100000;
    const orderNo  = `EL${datePart}${rand}`;
    const ref      = order.elemeOrderId || orderNo;

    const items = (order.items || []).map(it => resolveProduct(it, storeId)).filter(i => i.qty > 0);
    const total = parseFloat(order.total) || 0;

    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO retail_orders (
          order_no, status, payment_method, subtotal, total,
          store_id, channel, fulfillment_type, placed_at, paid_at
        ) VALUES (?, 'paid', 'eleme', ?, ?, ?, 'eleme', 'delivery',
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(orderNo, total, total, storeId);
      const oid = r.lastInsertRowid;
      for (const it of items) {
        db.prepare(`
          INSERT INTO retail_order_items
            (order_id, product_id, name_cn, name_en, qty, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?, 0, 0)
        `).run(oid, it.productId, it.nameCn, it.nameEn, it.qty);
      }
      return oid;
    })();

    const unresolved = [];
    let deducted = 0;
    for (const it of items) {
      if (!it.productId) { unresolved.push({ name: it.name, sku: it.sku, qty: it.qty, reason: it.matchBy }); continue; }
      const cur  = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(storeId, it.productId);
      const oldQ = cur ? cur.physical_qty : 0;
      inventory.adjustStock({
        storeId, productId: it.productId,
        newPhysicalQty: Math.max(0, oldQ - it.qty),
        actorLabel: 'Eleme order',
        reason: 'eleme_order',
        note: `Eleme ${ref} — ${it.nameEn} x${it.qty}`,
      });
      deducted++;
    }

    if (unresolved.length) {
      try {
        const matched = items.filter(i => i.productId).map(i => ({ name: i.name, sku: i.sku, qty: i.qty, by: i.matchBy }));
        db.prepare(`
          INSERT INTO eleme_sync_log (store_code, event_type, status, detail, error_msg)
          VALUES (?, 'order_unsynced', 'warn', ?, ?)
        `).run(
          storeCode || null,
          JSON.stringify({ ref, deducted, matched, unresolved }),
          `${unresolved.length} item(s) not synced: ` +
            unresolved.map(u => `${u.name}${u.sku ? ` (${u.sku})` : ''} x${u.qty} [${u.reason}]`).join('; ')
        );
      } catch (logErr) { console.error('[eleme-internal] order_unsynced log failed:', logErr.message); }
    }

    res.json({ ok: true, orderId, orderNo, items: items.length, deducted, unresolved });
  } catch (err) {
    console.error('[eleme-internal] ingest-order error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
