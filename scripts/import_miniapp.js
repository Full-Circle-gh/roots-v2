#!/usr/bin/env node
/**
 * Mini-app order import.
 *
 * Reads scripts/miniapp_import.json (pre-built by the python converter)
 * and writes to two tables:
 *   - miniapp_orders        (1 row per order, full fidelity)
 *   - miniapp_order_lines   (1 row per item line, with variant + add-on)
 *
 * Also projects each order into the existing sales_entries table with
 * channel='miniapp' so the existing Sales dashboard sees the revenue.
 *
 * Idempotent: upsert key is source_order_id (the mini app's "Order ID").
 * Re-running with an updated XLSX is safe — existing orders update,
 * new ones insert. Lines for an existing order are wiped + re-inserted
 * inside the same transaction so partial updates don't leave stale rows.
 *
 * Run modes:
 *   node scripts/import_miniapp.js --dry-run
 *   node scripts/import_miniapp.js
 */
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const DB_PATH  = path.join(__dirname, '..', 'data', 'roots.db');
// Optional --src=path to import from a different snapshot (e.g. 2025 vs
// 2026 yearly exports). Defaults to scripts/miniapp_import.json.
const srcArg   = process.argv.find(a => a.startsWith('--src='));
const SRC_PATH = srcArg ? path.resolve(srcArg.slice(6)) : path.join(__dirname, 'miniapp_import.json');
if (!fs.existsSync(SRC_PATH)) {
  console.error(`Source missing: ${SRC_PATH}\nRun the python converter first.`);
  process.exit(1);
}
const { orders, lines_by_order } = JSON.parse(fs.readFileSync(SRC_PATH, 'utf8'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Enable cascade so deleting a sales_entries row also drops its sale_addons.
// Without this the on-re-import cleanup at line ~155 would leave orphans.
db.pragma('foreign_keys = ON');

// Confirm the schema migrations have run by checking the new tables exist.
const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='miniapp_orders'").get();
if (!ok) {
  console.error('miniapp_orders table missing — restart the app once to apply migrations, then retry.');
  process.exit(1);
}

// Resolve external_id (Zoho ID) → products.id once up front so each line
// insert is a single map lookup, not a query.
const productByExt = new Map();
for (const r of db.prepare('SELECT id, external_id FROM products WHERE external_id IS NOT NULL').all()) {
  productByExt.set(r.external_id, r.id);
}

const findOrder    = db.prepare('SELECT id FROM miniapp_orders WHERE source_order_id = ?');
const insertOrder  = db.prepare(`INSERT INTO miniapp_orders
  (source_order_id, order_no, user_id, customer_phone, customer_name,
   product_total, delivery_fee, income, used_points, refund_amount,
   status, refund_status, payment_method, payment_no,
   order_date, delivery_date,
   province, city, district, address, compound, address_details,
   coupon_name, coupon_discount, referrer_phone, referrer_name,
   delivery_company, tracking_no, pickup_store, remarks, admin_note)
  VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)`);
const updateOrder  = db.prepare(`UPDATE miniapp_orders SET
  order_no=?, user_id=?, customer_phone=?, customer_name=?,
  product_total=?, delivery_fee=?, income=?, used_points=?, refund_amount=?,
  status=?, refund_status=?, payment_method=?, payment_no=?,
  order_date=?, delivery_date=?,
  province=?, city=?, district=?, address=?, compound=?, address_details=?,
  coupon_name=?, coupon_discount=?, referrer_phone=?, referrer_name=?,
  delivery_company=?, tracking_no=?, pickup_store=?, remarks=?, admin_note=?
  WHERE id=?`);

const deleteLines  = db.prepare('DELETE FROM miniapp_order_lines WHERE order_id = ?');
const insertLine   = db.prepare(`INSERT INTO miniapp_order_lines
  (order_id, product_id, product_name_en, product_name_cn,
   variant_label, combine_with, units, unit_price, line_total, refund_status)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// Sales-entries projection — one row per LINE (not per order) so the
// existing Sales dashboard gets product-level breakdowns. Each line's
// notes column carries a synthetic ref `miniapp:<orderId>:<lineIdx>`
// for idempotent upsert on re-import.
const findSalesByRef = db.prepare("SELECT id FROM sales_entries WHERE notes LIKE ? AND channel = 'miniapp'");
const insertSale = db.prepare(`INSERT INTO sales_entries
  (date, product_id, product_name, channel, qty, unit_price, total, notes)
  VALUES (?,?,?,?,?,?,?,?)`);

// Add-on mapping — combine_with strings → addon_product_id. Loaded once.
// Keeps inventory/cost of bundled items (crackers, quinoa, etc.) tracked
// without polluting the primary sales line. See scripts/addon_mapping.json.
const addonMapping = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'addon_mapping.json'), 'utf8'));
    const map = new Map();
    const ignore = new Set(cfg.ignore || []);
    for (const [combineStr, sku] of Object.entries(cfg.mapping || {})) {
      const row = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
      if (row) map.set(combineStr, row.id);
    }
    return { map, ignore };
  } catch { return { map: new Map(), ignore: new Set() }; }
})();
const insertAddon = db.prepare(`INSERT INTO sale_addons
  (sale_id, addon_product_id, qty, source, source_combine_with)
  VALUES (?,?,?,?,?)`);
const updateSale = db.prepare(`UPDATE sales_entries SET
  date=?, product_id=?, product_name=?, channel=?, qty=?, unit_price=?, total=?, notes=?
  WHERE id=?`);

function buildSaleValues(o, line, lineIdx, productId) {
  const dateOnly = (o.order_date || '').slice(0, 10) || null;
  // Display-friendly product name. Append variant + combine info so the
  // existing dashboard can tell variants apart in the breakdown.
  const nameParts = [];
  if (line.product_name_en) nameParts.push(line.product_name_en);
  if (line.product_name_cn) nameParts.push(line.product_name_cn);
  let displayName = nameParts.join(' / ') || '(unnamed)';
  if (line.variant_label)  displayName += ` [${line.variant_label}]`;
  // Notes carries the upsert ref + customer + add-on info for traceability.
  const tag = `[miniapp:${o.source_order_id}:${lineIdx}]`;
  const extras = [];
  if (o.customer_name)   extras.push(`Customer: ${o.customer_name}`);
  if (line.combine_with) extras.push(`Add-on: ${line.combine_with}`);
  if (o.coupon_name)     extras.push(`Coupon: ${o.coupon_name}`);
  if (o.district)        extras.push(`Area: ${o.district}`);
  const notes = `${tag} ${extras.join(' · ')}`.trim();
  return [
    dateOnly, productId, displayName, 'miniapp',
    line.units || 0, line.unit_price || 0, line.line_total || 0,
    notes,
  ];
}

const stats = { ordersInserted: 0, ordersUpdated: 0, linesWritten: 0,
                salesInserted: 0, linesWithProduct: 0 };

const tx = db.transaction(() => {
  for (const o of orders) {
    const exists = findOrder.get(o.source_order_id);
    let dbOrderId;
    if (exists) {
      updateOrder.run(
        o.order_no, o.user_id, o.customer_phone, o.customer_name,
        o.product_total, o.delivery_fee, o.income, o.used_points, o.refund_amount,
        o.status, o.refund_status, o.payment_method, o.payment_no,
        o.order_date, o.delivery_date,
        o.province, o.city, o.district, o.address, o.compound, o.address_details,
        o.coupon_name, o.coupon_discount, o.referrer_phone, o.referrer_name,
        o.delivery_company, o.tracking_no, o.pickup_store, o.remarks, o.admin_note,
        exists.id,
      );
      dbOrderId = exists.id; stats.ordersUpdated++;
    } else {
      const r = insertOrder.run(
        o.source_order_id, o.order_no, o.user_id, o.customer_phone, o.customer_name,
        o.product_total, o.delivery_fee, o.income, o.used_points, o.refund_amount,
        o.status, o.refund_status, o.payment_method, o.payment_no,
        o.order_date, o.delivery_date,
        o.province, o.city, o.district, o.address, o.compound, o.address_details,
        o.coupon_name, o.coupon_discount, o.referrer_phone, o.referrer_name,
        o.delivery_company, o.tracking_no, o.pickup_store, o.remarks, o.admin_note,
      );
      dbOrderId = r.lastInsertRowid; stats.ordersInserted++;
    }

    // Lines: clear-and-reinsert. Lines are immutable per import — if the
    // user fixes the source XLSX and re-imports, lines should reflect that.
    deleteLines.run(dbOrderId);
    // Same for the sales projection: clear all sales rows tied to this
    // order, then re-insert. Match by the [miniapp:OID:*] tag.
    const refLike = `[miniapp:${o.source_order_id}:%]%`;
    db.prepare(`DELETE FROM sales_entries WHERE channel = 'miniapp' AND notes LIKE ?`).run(refLike);

    const lines = lines_by_order[o.source_order_id] || [];
    lines.forEach((l, idx) => {
      const productId = l.product_external_id ? (productByExt.get(l.product_external_id) || null) : null;
      if (productId) stats.linesWithProduct++;
      // High-fidelity line
      insertLine.run(
        dbOrderId, productId, l.product_name_en, l.product_name_cn,
        l.variant_label, l.combine_with, l.units, l.unit_price, l.line_total,
        l.refund_status,
      );
      stats.linesWritten++;
      // Sales projection (per-line)
      const saleRes = insertSale.run(...buildSaleValues(o, l, idx, productId));
      stats.salesInserted++;
      // Add-on row — only when combine_with maps to a real product.
      // sales_entries.id is the parent so the cracker/quinoa/etc. ties
      // back to the hummus (or whichever) line that triggered it.
      if (l.combine_with && !addonMapping.ignore.has(l.combine_with)) {
        const addonId = addonMapping.map.get(l.combine_with);
        if (addonId) {
          insertAddon.run(saleRes.lastInsertRowid, addonId, 1, 'miniapp', l.combine_with);
          stats.addonsInserted = (stats.addonsInserted || 0) + 1;
        }
      }
    });
  }
});

if (DRY) {
  console.log('DRY-RUN — would import:');
  console.log(`  Orders: ${orders.length}`);
  let totalLines = 0;
  let resolvable = 0;
  for (const o of orders) {
    const arr = lines_by_order[o.source_order_id] || [];
    totalLines += arr.length;
    for (const l of arr) {
      if (l.product_external_id && productByExt.has(l.product_external_id)) resolvable++;
    }
  }
  console.log(`  Lines:  ${totalLines}`);
  console.log(`  Resolvable to a product (real DB lookup): ${resolvable}/${totalLines} (${Math.round(resolvable*100/totalLines)}%)`);
  const existingOrders = db.prepare('SELECT COUNT(*) AS n FROM miniapp_orders').get().n;
  console.log(`  Existing miniapp_orders rows already in DB: ${existingOrders}`);
  const existingMiniappSales = db.prepare("SELECT COUNT(*) AS n FROM sales_entries WHERE channel='miniapp'").get().n;
  console.log(`  Existing sales_entries with channel='miniapp': ${existingMiniappSales} (will be replaced for these orders)`);
  process.exit(0);
}

tx();
console.log(`✅ Mini-app import complete`);
console.log(`  miniapp_orders inserted:    ${stats.ordersInserted}`);
console.log(`  miniapp_orders updated:     ${stats.ordersUpdated}`);
console.log(`  miniapp_order_lines:        ${stats.linesWritten}`);
console.log(`    of which linked to product: ${stats.linesWithProduct} (${Math.round(stats.linesWithProduct*100/Math.max(1,stats.linesWritten))}%)`);
console.log(`  sales_entries inserted:     ${stats.salesInserted} (one row per line)`);
