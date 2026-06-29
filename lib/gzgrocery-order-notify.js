'use strict';

// Dedicated WeCom group-robot push for gzgrocery orders that contain OUR products.
//
// This is SEPARATE from lib/ops-alert.js (System Alerts → disconnect paging) and
// from the customer order webhook. It exists so the team gets a clean, real-time
// feed of *only* the gzgrocery orders that touch Roots stock — customer name,
// order number, and each of our line items (English + Chinese name + SKU).
//
// Destination is resolved, in priority order:
//   1. env GZGROCERY_ORDER_WEBHOOK            (full URL or bare key)
//   2. storefront_config `gzgrocery_orders.wecom_webhook`  (+ `.enabled` !== false)
// Unset / disabled / non-qyapi host → silent no-op. Notification NEVER blocks or
// crashes the daemon.

const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data', 'roots.db');
let _ro = null;

function roConfig(key) {
  try {
    if (!_ro) {
      const Database = require('better-sqlite3');
      _ro = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    }
    const row = _ro.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : null;
  } catch (_) { return null; }
}

function webhookUrl() {
  // env wins — lets a box override without touching settings.
  let raw = String(process.env.GZGROCERY_ORDER_WEBHOOK || '').trim();
  if (!raw) {
    if (roConfig('gzgrocery_orders.enabled') === false) return '';
    raw = String(roConfig('gzgrocery_orders.wecom_webhook') || '').trim();
  }
  if (!raw) return '';
  try {
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${raw}`;
    if (new URL(url).hostname !== 'qyapi.weixin.qq.com') return '';
    return url;
  } catch (_) { return ''; }
}

// Asia/Shanghai HH:mm, independent of server TZ.
function shTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Anti-double-send within the process (the daemon already latches once-per-order,
// this is just a safety net against rapid re-runs).
const DEDUP_MS = 120_000;
const lastSent = new Map();

// items: [{ name_en, name_cn, sku, qty }]
function buildMarkdown(o, items) {
  const lines = [];
  lines.push(`**🛒 GZGROCERY 订单 / Order**`);
  if (o.customer) lines.push(`客户 Customer: **${o.customer}**`);
  lines.push(`订单号 Order: \`${o.orderNo || o.orderId}\``);
  lines.push('');
  for (const it of items) {
    const en = it.name_en || '';
    const cn = it.name_cn || '';
    lines.push(`• ${en}`);
    if (cn) lines.push(`　${cn}`);
    lines.push(`　SKU \`${it.sku}\` ×${it.qty}`);
  }
  lines.push('');
  lines.push(`<font color="comment">${shTime()}</font>`);
  return lines.join('\n');
}

// Fire-and-forget. o = { orderId, orderNo, customer }; items = matched our-products.
async function notifyOrder(o, items) {
  const url = webhookUrl();
  if (!url || !items || !items.length) return false;
  const dedupKey = String(o.orderNo || o.orderId);
  const now = Date.now();
  const prev = lastSent.get(dedupKey);
  if (prev && now - prev < DEDUP_MS) return false;
  lastSent.set(dedupKey, now);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: buildMarkdown(o, items) } }),
    });
    if (!res.ok) console.error(`[gzgrocery-notify] webhook HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error('[gzgrocery-notify] send failed:', e.message);
    return false;
  }
}

function notifyEnabled() { return !!webhookUrl(); }

module.exports = { notifyOrder, notifyEnabled };
