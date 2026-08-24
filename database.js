const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ═══ ONE DRIVER. SQLITE. ══════════════════════════════════════
//
// A `TACET_DB` driver branch stood here from 2026-08-19 to 2026-08-23, selecting
// a Postgres handle via lib/db-driver.js, lib/pg.js and lib/pg-handle.js. The
// migration was cancelled (decisions §24, THE POSTGRES MIGRATION IS CANCELLED)
// and all three modules are deleted. The branch is removed with them.
//
// IF A SECOND DRIVER IS EVER WANTED, THIS IS STILL THE PLACE, AND THE REASON IS
// UNCHANGED: this file is the construction point. It builds the handle at
// `new Database(...)` below and exports it at the bottom, and ~94 files require
// it, most binding it at require time rather than per call. lib/db-seam.js
// cannot do the job — it receives an already-built handle and can neither
// substitute a driver nor alter return types.
//
// AND READ §24 (f) BEFORE BUILDING ONE. The cancelled attempt made the two
// handles deliberately incompatible and then needed 2,835 call sites converted
// before anything could run. A synchronous `.query(text, params)` on this handle
// is the shape that would have allowed it to be done a file at a time.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'roots.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ── Idempotent migrations for existing databases ────────────────────────────
// CREATE TABLE IF NOT EXISTS doesn't add new columns to an already-created
// table, so we ALTER TABLE individually. Adding a duplicate column throws,
// which we swallow — that's the "already migrated" case.
function addColumn(table, col, type) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
addColumn('products', 'description_en', 'TEXT');
addColumn('products', 'description_cn', 'TEXT');
addColumn('products', 'free_of',        'TEXT');
addColumn('products', 'image_data',     'TEXT');
addColumn('products', 'label_data',     'TEXT');
addColumn('purchase_orders', 'source',  "TEXT DEFAULT 'manual'");
addColumn('ingredient_cost_skips', 'resolved_at', 'DATETIME');
addColumn('ingredients', 'free_by_design',    'INTEGER DEFAULT 0');
addColumn('ingredients', 'supplier_platform', 'TEXT');
addColumn('ingredients', 'supplier_link',     'TEXT');
addColumn('ingredients', 'supplier_qr_data',  'TEXT');
addColumn('ingredients', 'image_data',        'TEXT');
addColumn('recipes',     'is_favorite',       'INTEGER DEFAULT 0');
addColumn('po_line_items', 'lot_number',      'TEXT');
addColumn('po_line_items', 'expiry_date',     'DATE');
// Retail purchasing (online store buying dept) shares the kitchen PO engine.
// scope splits the two worlds' lists ('kitchen' | 'retail'); retail POs pin a
// retail_stores.id they restock into, and their lines reference store_products
// (kitchen lines keep using ingredient_id — one of the two is always NULL).
// stock_applied_qty tracks how much of a retail line has already been pushed
// into retail_store_stock, so repeated receive edits apply only the delta.
addColumn('purchase_orders', 'scope',    "TEXT DEFAULT 'kitchen'");
addColumn('purchase_orders', 'store_id', 'INTEGER');
addColumn('po_line_items', 'store_product_id',  'INTEGER');
addColumn('po_line_items', 'stock_applied_qty', 'REAL DEFAULT 0');
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_po_line_items_store_product ON po_line_items(store_product_id)').run(); } catch {}
addColumn('recipes',       'image_data',      'TEXT');
addColumn('recipe_ingredients', 'substitutes', 'TEXT');
addColumn('ingredients', 'pack_contents_qty',  'REAL');
addColumn('ingredients', 'pack_contents_unit', 'TEXT');
// One-time: free SKUs still held by already soft-deleted ingredients so the
// codes can be reused (the DELETE handler now nulls SKU on delete going
// forward). A deleted item never needs a unique SKU; PO lines snapshot it.
try { db.prepare('UPDATE ingredients SET sku = NULL WHERE is_active = 0 AND sku IS NOT NULL').run(); } catch {}
addColumn('packaging_types', 'image_data',     'TEXT');
// Switching products from hard-delete to soft-delete (waste/restock reference
// product_id and would orphan otherwise). New rows default to active=1.
addColumn('products', 'is_active',  'INTEGER DEFAULT 1');
addColumn('products', 'updated_at', 'DATETIME');
// Columns added for the Zoho/upstream products import. external_id holds
// the upstream ID so we can re-sync without losing the link; sort_order
// honours the upstream display priority (negatives sort first); stock_qty
// is a snapshot updated by sales/waste/restock movements; tags is a
// comma-separated free-form bag (dietary, storage, heat — see the import
// script for normalization rules).
addColumn('products', 'external_id', 'INTEGER');
addColumn('products', 'sort_order',  'INTEGER DEFAULT 0');
addColumn('products', 'stock_qty',   'INTEGER DEFAULT 0');
addColumn('products', 'tags',        'TEXT');
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_products_external_id ON products(external_id)').run(); } catch {}
// Variant grouping — products that share `variant_group_id` are siblings
// of one another (e.g. "Foaming Hand Soap (Lemongrass / Mint / Lavender)").
// `variant_label` is the axis-specific tag for THIS variant (e.g. "Mint",
// "150g", "Crunchy"). NULL group_id = standalone product. The label is
// what the UI shows in chips next to siblings.
addColumn('products', 'variant_group_id', 'INTEGER');
addColumn('products', 'variant_label',    'TEXT');
// Operator-chosen display order of siblings within a group (drag-to-reorder in
// the product editor). Lower = shown first; ties fall back to label/id.
addColumn('products', 'variant_sort',     'INTEGER DEFAULT 0');
// "Buy together" bundle shown on this product's page — JSON:
// { title_en, title_cn, ids:[productId,…], price, voucher }. No bundle SKU:
// add-all-to-cart adds each listed product at its own price/stock.
addColumn('products', 'bundle',           'TEXT');
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_products_variant_group ON products(variant_group_id)').run(); } catch {}
// Storefront "compare-at" / was-price (划线价). When set and higher than
// sell_price, the mini-app shows it struck through next to the live price.
// NULL/0 = no strike-through shown.
addColumn('products', 'compare_at_price', 'REAL');
// Product photo gallery — JSON array of image srcs (data-URI or URL), ordered;
// element [0] mirrors image_data (the primary, used by shop cards/orders).
// Detail-only: kept OUT of list SELECTs so the shop-grid payload stays small.
addColumn('products', 'images', 'TEXT');
// Description rendering mode for the mini-app: 'plain' (text, ## headings) or
// 'rich' (formatted HTML authored in the editor, rendered via <rich-text>).
addColumn('products', 'description_format', "TEXT DEFAULT 'plain'");
// Barcode for the tablet POS (market vendors scan products in with a
// keyboard-wedge gun). Stored as text — keeps leading zeros (EAN-13 etc.)
// and lets us hold non-numeric internal codes too. Indexed for instant
// lookup on every scan; UNIQUE so a printed barcode can't be assigned to
// two products by accident.
addColumn('products', 'barcode', 'TEXT');
try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL').run(); } catch {}
// Backfill any existing rows so the COALESCE in the list query is unnecessary
// for old data. Idempotent.
try { db.prepare('UPDATE products SET is_active = 1 WHERE is_active IS NULL').run(); } catch {}

// Web Push subscriptions for OS-level notifications. One row per
// (user, device) — endpoint is the unique key from the push service.
// keys.p256dh / keys.auth are needed to encrypt payloads. We send to
// every active subscription when an event fires; failed sends (410
// Gone) are pruned from this table by routes/push.js.
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`);
try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)').run(); } catch {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)').run(); } catch {}

// "Available at markets" gate — when true, this product appears in the
// Markets POS search. Default 0 (OFF) so admins explicitly opt-in only
// the SKUs they actually carry at physical stalls; the catalog is
// usually much bigger than what fits on a market table.
addColumn('products', 'is_market', 'INTEGER DEFAULT 0');
// Idempotent one-time migration: set ALL existing products to 0 once.
// After this runs once, vendor edits to flip individual products on
// will stick (UPDATE WHERE is_market IS NULL is gated to NULLs only,
// and this migration only runs the first time).
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('default_is_market_off_v1');
  if (!ran) {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.prepare('UPDATE products SET is_market = 0').run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('default_is_market_off_v1');
  }
} catch (e) { console.error('[migration default_is_market_off_v1]', e); }
// Backfill any NULLs (legacy rows pre-migration) to 0.
try { db.prepare('UPDATE products SET is_market = 0 WHERE is_market IS NULL').run(); } catch {}
// "Restock only" — for items that are kitchen-internal (salad dressings,
// in-house sauces, bulk consumables) and never sold to customers. When 1,
// the product is excluded from POS / miniapp / Meituan search, but still
// appears in the Restock app's picker and the admin products page. Lets
// the kitchen track inventory on items the front of house never touches.
addColumn('products', 'is_restock_only', 'INTEGER DEFAULT 0');
try { db.prepare('UPDATE products SET is_restock_only = 0 WHERE is_restock_only IS NULL').run(); } catch {}
// Waste entries gained a cost_source column so reconciliation can tell
// recipe-derived costs from sell-price fallbacks.
addColumn('waste_entries', 'cost_source', 'TEXT');
// PO partial-receive: lines track ordered (qty) + received (qty_received).
// Null until the PO is marked Delivered; on first deliver we backfill it
// from qty so non-partial flows are unchanged.
addColumn('po_line_items', 'qty_received', 'REAL');
// Track which PO each backorder PO came from for traceability.
addColumn('purchase_orders', 'backorder_of', 'INTEGER');
// Per-line shipment tracking + damage report. Tracking number is what the
// supplier (Taobao etc) gives at ship time. carrier is optional ("sf"/"yto"/…)
// — left null we link to 17track which auto-detects. damaged_qty is part of
// the receive flow so the buyer can flag broken/missing units distinctly.
addColumn('po_line_items', 'tracking_number', 'TEXT');
addColumn('po_line_items', 'tracking_carrier', 'TEXT');
addColumn('po_line_items', 'damaged_qty',     'REAL DEFAULT 0');
// Per-ingredient accounting bucket. When a PO line is created from this
// ingredient (kitchen order, autocomplete pick, bulk import), the line's
// expense_category is auto-populated from this column so finance posts
// land in the right bucket without the buyer having to retype it.
addColumn('ingredients', 'accounting_category', 'TEXT');
// Per-line invoice tracking on POs. A single PO can mix lines from
// different suppliers (kitchen requests often consolidate orders), so
// supplier_name lives on the LINE, not the header. purchase_channel is
// free-text (美团闪购 / 京东 / market / direct…) so the report can group
// beyond just supplier name.
//
// invoice_status: 3-state enum the month-end report aggregates by.
//   'not_received' — default; we should get one but haven't yet (未收取)
//   'received'     — invoice in hand (已收取)
//   'no_invoice'   — supplier doesn't issue one (不开发票) — common for
//                    local market / cash transactions
addColumn('po_line_items', 'supplier_name',     'TEXT');
addColumn('po_line_items', 'purchase_channel',  'TEXT');
addColumn('po_line_items', 'invoice_received',  'INTEGER DEFAULT 0');           // legacy column, kept for compat
addColumn('po_line_items', 'invoice_status',    "TEXT DEFAULT 'not_received'");
// Free-text note on the LINE — the buyer's own remark about this one item
// ("substitute brand", "call before delivery", "short-dated stock"). The
// PO header already has `notes`, but a mixed shopping list needs the remark
// attached to the item it belongs to, not buried in one box at the top.
addColumn('po_line_items', 'note',              'TEXT');
// One-shot backfill: anything that already had invoice_received=1 maps to
// 'received'. Everything else keeps the default 'not_received'. Marker in
// _migrations so it's idempotent.
try {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const ranInvBackfill = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('po_invoice_status_v1');
  if (!ranInvBackfill) {
    db.prepare("UPDATE po_line_items SET invoice_status = 'received' WHERE invoice_received = 1 AND (invoice_status IS NULL OR invoice_status = 'not_received')").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('po_invoice_status_v1');
  }
} catch (e) { console.error('[migration po_invoice_status_v1]', e); }
// One-shot backfill #2: copy each PO's header-level supplier down to its
// line items where the line still has no supplier_name. Old POs created
// before the per-line supplier_name column existed all show up as "未指定
// Unspecified" in the invoice report — this gives them their PO supplier
// instead. New POs that legitimately have a blank header supplier stay
// blank so accounting can fill them in by hand.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('po_line_supplier_backfill_v1');
  if (!ran) {
    const r = db.prepare(`
      UPDATE po_line_items
         SET supplier_name = (SELECT supplier FROM purchase_orders WHERE id = po_line_items.po_id)
       WHERE (supplier_name IS NULL OR TRIM(supplier_name) = '')
         AND (SELECT supplier FROM purchase_orders WHERE id = po_line_items.po_id) IS NOT NULL
    `).run();
    console.log(`[migration po_line_supplier_backfill_v1] backfilled ${r.changes} lines with header-level supplier`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('po_line_supplier_backfill_v1');
  }
} catch (e) { console.error('[migration po_line_supplier_backfill_v1]', e); }

// ── Invoices entity (Option C from the redesign) ────────────────────────────
// A real-world 增值税专用发票 (VAT invoice) is one document covering one or
// more POs from the same supplier over a billing period. Modeling it as a
// first-class entity lets accounting:
//   • record the invoice once (number, amount, date)
//   • link it to N POs (many-to-many via invoice_pos)
//   • support partial allocation (allocated_amount per link), so a single
//     invoice can cover part of a PO and another invoice covers the rest
//   • see which POs are still uncovered for month-end reconciliation
//
// no_invoice_expected lives on purchase_orders — a flag the buyer flips
// when the supplier doesn't issue invoices at all (cash, market). Those
// POs disappear from the "awaiting invoice" list.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier        TEXT    NOT NULL,
    invoice_number  TEXT,
    amount          REAL    NOT NULL,
    date            DATE    NOT NULL,
    notes           TEXT,
    created_by      INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier);
  CREATE INDEX IF NOT EXISTS idx_invoices_date     ON invoices(date);

  -- Legacy table from the PO-level invoice model (one buying order = one
  -- supplier). We've moved to the line-level model since a single buying
  -- order can mix items from many suppliers — see invoice_lines below.
  -- Kept as-is so any pre-existing data isn't lost; not used by the new
  -- code path.
  CREATE TABLE IF NOT EXISTS invoice_pos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id        INTEGER NOT NULL,
    po_id             INTEGER NOT NULL,
    allocated_amount  REAL    NOT NULL,
    UNIQUE(invoice_id, po_id),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY (po_id)      REFERENCES purchase_orders(id) ON DELETE CASCADE
  );

  -- Line-level invoice allocation. A buying order is a mixed shopping
  -- list; each LINE knows its supplier (po_line_items.supplier_name).
  -- An invoice from supplier X covers a subset of lines from supplier X
  -- across one or more buying orders.
  CREATE TABLE IF NOT EXISTS invoice_lines (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id        INTEGER NOT NULL,
    line_id           INTEGER NOT NULL,
    allocated_amount  REAL    NOT NULL,
    UNIQUE(invoice_id, line_id),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY (line_id)    REFERENCES po_line_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_lines_inv  ON invoice_lines(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_invoice_lines_line ON invoice_lines(line_id);
`);
addColumn('purchase_orders', 'no_invoice_expected', 'INTEGER DEFAULT 0');
// Per-line "no invoice expected" flag — the supplier for THIS line doesn't
// issue invoices (cash, market, …). Used by the line-level invoice report.
addColumn('po_line_items', 'no_invoice_expected', 'INTEGER DEFAULT 0');

// Retail Bills reuse the same invoices + invoice_lines tables as the kitchen,
// separated by scope (mirrors purchase_orders.scope). store_id pins the bill
// to a retail store; due_date + paid_at drive the AP-aging / mark-paid view
// the retail Bills tab adds on top of the kitchen model. All additive.
addColumn('invoices', 'scope',    "TEXT DEFAULT 'kitchen'");
addColumn('invoices', 'store_id', 'INTEGER');
addColumn('invoices', 'due_date', 'DATE');
addColumn('invoices', 'paid_at',  'DATETIME');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_scope ON invoices(scope)'); } catch {}

// Landed cost — freight / tax / handling carried on the PO header, on top of
// the line goods. Posts to Finance as one "Freight & fees" expense line and
// feeds the true per-unit landed cost shown on the order. All additive, 0 default.
addColumn('purchase_orders', 'extra_freight',  'REAL DEFAULT 0');
addColumn('purchase_orders', 'extra_tax',      'REAL DEFAULT 0');
addColumn('purchase_orders', 'extra_handling', 'REAL DEFAULT 0');

// Tenant scoping for retail purchase orders + bills (mirrors suppliers.tenant_id).
// DEFAULT 1 tags every existing row (kitchen + Roots' retail) to Roots, so Roots
// is unchanged; new retail POs/bills stamp the creating tenant and retail reads
// filter by it, so a second business never sees Roots' orders, bills or prices.
addColumn('purchase_orders', 'tenant_id', 'INTEGER DEFAULT 1');
addColumn('invoices',        'tenant_id', 'INTEGER DEFAULT 1');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_tenant ON purchase_orders(tenant_id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id)'); } catch {}

// Supplier dossier columns. The first two are free-text notes the buyer
// keeps about the vendor (catalogue + price list snapshot). The three
// _data columns hold base64 image uploads — same pattern we use for
// ingredient.image_data and supplier_qr_data: stored as a TEXT data URI
// so a single .db backup carries everything.
addColumn('suppliers', 'products_supplied',     'TEXT');  // catalogue notes / what they sell
addColumn('suppliers', 'price_info',            'TEXT');  // pricing notes
addColumn('suppliers', 'business_license_data', 'TEXT');  // 营业执照 image
addColumn('suppliers', 'permits_data',          'TEXT');  // 许可证 image
addColumn('suppliers', 'payment_qr_data',       'TEXT');  // 收款码 image
// Tenant scoping. DEFAULT 1 tags every existing supplier (Roots' ~109 kitchen-
// derived vendors + any kitchen-created ones) to Roots (tenant 1), so Roots'
// purchasing keeps seeing them. Retail creates for another tenant stamp that
// tenant's id, and the retail supplier list filters by the requesting tenant —
// so a brand-new business opens with an empty supplier list, never Roots'.
addColumn('suppliers', 'tenant_id', 'INTEGER DEFAULT 1');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id)'); } catch {}

// Backfill: every distinct supplier name found on ingredients OR PO line
// items should exist in the suppliers master table. Pre-supplier-picker
// imports (Zoho CSV's "Preferred Vendor" field) wrote free-text names
// straight to ingredients.supplier without creating a master record, so
// the Admin → Suppliers list was empty even though items referenced 12+
// vendors. INSERT OR IGNORE keeps it idempotent (UNIQUE name constraint).
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('backfill_suppliers_from_items_v1');
  if (!ran) {
    const insert = db.prepare("INSERT OR IGNORE INTO suppliers (name) VALUES (?)");
    let added = 0;
    // Distinct names from ingredients.supplier
    db.prepare(`SELECT DISTINCT TRIM(supplier) AS name FROM ingredients
                WHERE supplier IS NOT NULL AND TRIM(supplier) != ''`).all().forEach(r => {
      const result = insert.run(r.name);
      if (result.changes > 0) added++;
    });
    // Distinct names from po_line_items.supplier_name
    db.prepare(`SELECT DISTINCT TRIM(supplier_name) AS name FROM po_line_items
                WHERE supplier_name IS NOT NULL AND TRIM(supplier_name) != ''`).all().forEach(r => {
      const result = insert.run(r.name);
      if (result.changes > 0) added++;
    });
    // Distinct names from purchase_orders.supplier (header-level)
    db.prepare(`SELECT DISTINCT TRIM(supplier) AS name FROM purchase_orders
                WHERE supplier IS NOT NULL AND TRIM(supplier) != ''`).all().forEach(r => {
      const result = insert.run(r.name);
      if (result.changes > 0) added++;
    });
    console.log(`[migration backfill_suppliers_from_items_v1] added ${added} supplier${added===1?'':'s'} to master list`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('backfill_suppliers_from_items_v1');
  }
} catch (e) { console.error('[migration backfill_suppliers_from_items_v1]', e); }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_line_items_supplier ON po_line_items(supplier_name)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_line_items_invstat  ON po_line_items(invoice_status)'); } catch {}
// Items / 物料 — broaden the "ingredients" table to cover everything the
// buying department orders (food, packaging, equipment, retail, …). The
// recipe picker filters to item_kind='food' so non-food items don't leak
// into recipes; the PO autocomplete still searches every kind.
addColumn('ingredients', 'item_kind', "TEXT DEFAULT 'food'");
// Seed the editable list of kinds via the existing categories table so the
// UI can manage them (add/rename/remove) the same way recipe + product
// categories are managed. Idempotent: INSERT OR IGNORE on (kind,name).
try {
  const ranKinds = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_item_kinds_v1');
  if (!ranKinds) {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    const ins = db.prepare("INSERT OR IGNORE INTO categories (kind, name, sort_order) VALUES ('item_kind', ?, ?)");
    [['food',0],['packaging',1],['equipment',2],['retail',3],['other',4]].forEach(([n,o]) => ins.run(n, o));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_item_kinds_v1');
  }
} catch (e) { console.error('[migration seed_item_kinds_v1]', e); }
// Payment methods used on the supplier form. Stored in the editable
// categories table so admin can add/remove options without a code change.
try {
  const ranPM = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_payment_methods_v1');
  if (!ranPM) {
    const ins = db.prepare("INSERT OR IGNORE INTO categories (kind, name, sort_order) VALUES ('payment_method', ?, ?)");
    [['WeChat 微信',0],['Alipay 支付宝',1],['Official Bank Account 对公账户',2]].forEach(([n,o]) => ins.run(n, o));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_payment_methods_v1');
  }
} catch (e) { console.error('[migration seed_payment_methods_v1]', e); }
// Granular delete control. Default 0 — only admins can delete records out of
// the box. Admin can flip this on per-user from the user permissions UI when
// they want a manager / warehouse lead to be allowed to delete transactions.
// Backend middleware (requireDelete) reads this flag.
addColumn('permissions', 'can_delete', 'INTEGER DEFAULT 0');
// Supplier management is now its own top-level module (not under Admin).
// Default 0 — admin can flip on for the buyer / warehouse lead. Reads
// (GET /api/suppliers) stay open to all authed users since dropdowns
// across PO / Items / Finance need that list. Writes (create / edit /
// delete) gate on this permission via requirePermission('suppliers').
addColumn('permissions', 'suppliers', 'INTEGER DEFAULT 0');
// Tablet POS for the markets sales channel. Default 0. Vendors who get this
// flag are auto-redirected to /pos on login and stay there. Admins always
// have access regardless of this flag.
addColumn('permissions', 'pos', 'INTEGER DEFAULT 0');
// AI agent (Sprout · 苗) — chat assistant with read-only DB access.
// Default off; admins always pass. Read-only tools so even if it leaks
// it can only describe data, never modify it.
addColumn('permissions', 'ai', 'INTEGER DEFAULT 0');
// Warehouse-side inbox view in the /restock mobile app. Lets a user
// see incoming requests from stores and mark them as prepared. Default
// off — admin grants explicitly. Independent from `restock` (which is
// the store-side flow) so a vendor doesn't accidentally see the
// fulfilment queue and vice-versa.
addColumn('permissions', 'warehouse_inbox', 'INTEGER DEFAULT 0');
// Kitchen-side inbox: lets a user see incoming restock requests that
// the warehouse pushed to the kitchen (items missing on shelves OR
// items missing for outgoing customer orders). Independent of the
// `kitchen` perm (production logging) — admin grants explicitly.
addColumn('permissions', 'kitchen_inbox', 'INTEGER DEFAULT 0');
// Restock direction columns — historically every restock_orders row
// was implicitly store→warehouse. Now warehouse can also raise
// requests to the kitchen (out of stock for shipping orders, or low
// shelf stock). New rows fill these explicitly; legacy rows default
// to the original direction.
addColumn('restock_orders', 'from_role', "TEXT DEFAULT 'store'");
addColumn('restock_orders', 'to_role',   "TEXT DEFAULT 'warehouse'");
// Why the warehouse needs this from kitchen (only meaningful for
// warehouse→kitchen rows): 'order' = needed to ship a customer order,
// 'shelf' = topping up warehouse shelves. NULL for store→warehouse.
addColumn('restock_orders', 'purpose',   'TEXT');
// Soft-delete / archive — set when a user explicitly archives a row
// from the inbox to keep their list manageable. Archived rows still
// exist (for activity log + future restore) but the default list
// endpoint excludes them. NULL = active.
addColumn('restock_orders', 'archived_at', 'DATETIME');
// Idempotency guard for the auto-stock-update hook — stamped the first
// time a restock_orders row transitions to 'delivered' and we apply
// the order's items to the receiving store's per-market inventory.
// Prevents double-counting if the status endpoint is hit twice for
// the same order (network retry, accidental re-tap, etc.).
addColumn('restock_orders', 'stock_applied_at', 'DATETIME');

// Per-store inventory. One row per (market, product). Incremented
// automatically when a restock_orders row is confirmed delivered to
// that market. Editable by admin via /api/markets/:id/stock for
// manual corrections (count adjustments, write-offs that aren't
// already covered by waste_entries).
db.exec(`CREATE TABLE IF NOT EXISTS market_stock (
  market_id   INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (market_id, product_id),
  FOREIGN KEY (market_id)  REFERENCES markets(id)  ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
)`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_market_stock_market  ON market_stock(market_id)').run();  } catch {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_market_stock_product ON market_stock(product_id)').run(); } catch {}

// Audit log for stock movements — every increment from a delivery (and
// future manual adjustments) is recorded so admins can reconstruct how
// a market's qty got to where it is.
db.exec(`CREATE TABLE IF NOT EXISTS market_stock_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id    INTEGER NOT NULL,
  product_id   INTEGER NOT NULL,
  delta        REAL NOT NULL,
  reason       TEXT NOT NULL,           -- 'restock_delivered' | 'manual_adjust' | 'sale' | …
  ref_table    TEXT,                    -- e.g. 'restock_orders'
  ref_id       INTEGER,                 -- e.g. the restock_orders.id
  user_id      INTEGER,
  notes        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id)  REFERENCES markets(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (user_id)    REFERENCES users(id)
)`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_market_stock_ledger_market ON market_stock_ledger(market_id, created_at)').run(); } catch {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_market_stock_ledger_ref    ON market_stock_ledger(ref_table, ref_id)').run(); } catch {}
// Payment method on income/expense — wechat / alipay / bank / cash / etc.
// Free-form so the user can add new methods on the fly. Independent of
// the existing `channel` column on income_entries (which means
// "Sales-derived channel" — meituan/eleme/etc.).
addColumn('income_entries',  'payment_method', 'TEXT');
addColumn('expense_entries', 'payment_method', 'TEXT');
// Edit stamp on income/expense. Nullable with no default: NULL means the
// entry has never been edited since it was logged, so the Finance list can
// tell "created and left alone" from "touched later" without a backfill
// inventing an edit that never happened. Set to CURRENT_TIMESTAMP by the
// PUT handlers in routes/finance.js; the full before/after diff of each
// edit lands in activity_log, not here.
addColumn('income_entries',  'updated_at', 'DATETIME');
addColumn('expense_entries', 'updated_at', 'DATETIME');
// Suppliers — primary communication channel for the buyer to reach
// this vendor. Type drives the UI (link vs QR vs plain text). Replaces
// the loose "WeChat ID / phone" stuff with a structured field that
// renders correctly on the supplier card.
addColumn('suppliers', 'channel_type',    'TEXT');   // 'taobao' | 'alibaba' | 'wechat' | 'phone' | 'website' | 'other'
addColumn('suppliers', 'channel_link',    'TEXT');   // URL or handle (taobao/alibaba/website store URL)
addColumn('suppliers', 'channel_qr_data', 'TEXT');
// Payment method — how we pay this supplier (WeChat / Alipay / Bank).
// Distinct from payment_terms (Net 30 / COD / Prepay), which is *when* we pay.
// Editable list of options lives in categories(kind='payment_method').
addColumn('suppliers', 'payment_method', 'TEXT');
// Multi-document support — replaces the three single-image columns
// (business_license_data / permits_data / payment_qr_data) with a row-per-doc
// table so a supplier can carry N files per kind, of any mime type
// (image / PDF / spreadsheet). Legacy columns stay for safety; one-shot
// backfill migration below moves existing values into this table.
db.exec(`CREATE TABLE IF NOT EXISTS supplier_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id  INTEGER NOT NULL,
  kind         TEXT NOT NULL,                   -- 'license' | 'permit' | 'payment_qr' | 'other'
  label        TEXT,
  filename     TEXT,
  mime_type    TEXT,
  size_bytes   INTEGER,
  data         TEXT NOT NULL,                   -- base64 data URI
  uploaded_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_supplier_docs_sup ON supplier_documents(supplier_id)'); } catch {}
try {
  const ranBF = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('backfill_supplier_documents_v1');
  if (!ranBF) {
    const cols = [
      ['business_license_data', 'license',    'Business License 营业执照'],
      ['permits_data',          'permit',     'Permits 许可证'],
      ['payment_qr_data',       'payment_qr', 'Payment QR 收款码'],
    ];
    const ins = db.prepare(`INSERT INTO supplier_documents (supplier_id, kind, label, filename, mime_type, size_bytes, data)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    for (const [col, kind, label] of cols) {
      const rows = db.prepare(`SELECT id, ${col} AS d FROM suppliers WHERE ${col} IS NOT NULL AND ${col} != ''`).all();
      for (const r of rows) {
        const mm = /^data:([^;]+);/.exec(r.d);
        const mime = mm ? mm[1] : 'image/jpeg';
        // base64 length × 3/4 ≈ raw byte size; strip the `data:...,` prefix first.
        const b64 = (r.d.split(',')[1] || '');
        const size = Math.floor(b64.length * 3 / 4);
        ins.run(r.id, kind, label, null, mime, size, r.d);
        n++;
      }
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('backfill_supplier_documents_v1');
    console.log(`[migration backfill_supplier_documents_v1] migrated ${n} legacy supplier docs`);
  }
} catch (e) { console.error('[migration backfill_supplier_documents_v1]', e); }
// Sprout's long-term business memory. Free-form key/value notes that get
// re-injected as system context on every chat, so the agent doesn't have
// to re-discover basic facts ("what's our margin target?", "main suppliers")
// on every conversation. Admin-curated; user can ask Sprout to remember
// something via natural language (later — for now they edit Admin → AI Memory).
db.exec(`CREATE TABLE IF NOT EXISTS ai_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  weight INTEGER DEFAULT 5,        -- 1-10 ranking; higher = more important to remember
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
)`);
// Seed a few useful starter facts on a fresh DB. Idempotent via _migrations.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_ai_memory_v1');
  if (!ran) {
    const ins = db.prepare('INSERT INTO ai_memory (key, value, weight) VALUES (?,?,?)');
    [
      ['business_type',     'Plant-based food business in Guangzhou. Recipes built around hummus, salads, dips, dates, nut butters, plant-based yogurts.', 9],
      ['margin_target',     'Owner targets ~30% food cost (i.e. ~70% gross margin). >40% food cost is a red flag.', 8],
      ['top_channels',      'Mini-app (official 小程序), GZGrocery (B2B), Meituan (delivery, multi-store), Markets (physical stalls via /pos).', 7],
      ['key_concerns',      'Sustained margin erosion, supplier price drift, waste cost above 5% of revenue, cross-channel pricing drift, slow-moving SKUs eating shelf space.', 8],
      ['tone_preference',   'Direct and concise. Owner reads on phone between tasks. No filler, no hedging.', 7],
    ].forEach(r => ins.run(r[0], r[1], r[2]));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_ai_memory_v1');
  }
} catch (e) { console.error('[migration seed_ai_memory_v1]', e); }
// Backfill: admins / managers get AI on by default.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_ai_perm_v1');
  if (!ran) {
    db.prepare("UPDATE permissions SET ai = 1 WHERE user_id IN (SELECT id FROM users WHERE role IN ('admin','manager'))").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_ai_perm_v1');
  }
} catch (e) { console.error('[migration seed_ai_perm_v1]', e); }

// Sprout's editable in-app knowledge base. Hardcoded APP_HELP topics in
// routes/ai.js are the defaults; DB rows here OVERRIDE the default for the
// same topic key, or ADD brand-new topics admins authored. Sprout reads the
// merged map every chat. One row per topic. updated_by tracks last editor.
db.exec(`CREATE TABLE IF NOT EXISTS ai_app_help (
  topic        TEXT PRIMARY KEY,
  title        TEXT,
  content      TEXT NOT NULL,
  is_active    INTEGER DEFAULT 1,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by   TEXT
)`);

// Gap-feedback log. When Sprout's get_app_help is called with a topic that
// doesn't resolve (not in defaults, not in ai_app_help), we increment the
// miss row for that topic. Admin UI surfaces the top-N so the operator
// knows which topics real users tried to look up but didn't exist yet.
db.exec(`CREATE TABLE IF NOT EXISTS ai_app_help_misses (
  topic        TEXT PRIMARY KEY,
  hit_count    INTEGER DEFAULT 1,
  first_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_user_id INTEGER,
  resolved     INTEGER DEFAULT 0   -- admin marks 1 once they've added the topic
)`);

// Markets module — one row per physical market location (e.g. Yuexiu,
// Tianhe). Each POS user is assigned to one market via users.market_id;
// sales captured by that user are tagged so analytics can compare
// per-location performance.
db.exec(`CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_cn TEXT,
  location TEXT,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
)`);
// Markets table doubles as a generic "locations" table — the `kind` column
// says what each row is: 'market' (POS stalls, the default) / 'retail' /
// 'warehouse' / 'kitchen'. Used by restock notification routing (events fan
// out to users whose users.market_id matches the destination location).
// NOTE: this addColumn must run AFTER the CREATE above — it was moved here
// from before it so a from-scratch boot on an empty DB doesn't crash with
// "no such table: markets".
addColumn('markets', 'kind', "TEXT DEFAULT 'market'");
// GPS coords captured by the POS "📍 Use my location" feature. Optional —
// markets can also be created with just a typed address. Used for the
// admin-side map view and for spotting accidentally-duplicated stalls.
addColumn('markets', 'lat', 'REAL');
addColumn('markets', 'lng', 'REAL');
// Daily revenue target per market — used by the POS header progress chip.
// 0 means "no target set" (chip hidden).
addColumn('markets', 'daily_target', 'REAL DEFAULT 0');
addColumn('users', 'market_id', 'INTEGER');
// Optional assignment to a retail store. NULL = unassigned (read-only on
// per-store stock unless the user is admin). Admin always edits any store.
addColumn('users', 'retail_store_id', 'INTEGER');
// Existing admin/manager users get can_delete=1 once. Idempotent thanks to
// the OR IGNORE marker row in _migrations below.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_can_delete_v1');
  if (!ran) {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.prepare("UPDATE permissions SET can_delete = 1 WHERE user_id IN (SELECT id FROM users WHERE role IN ('admin','manager'))").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_can_delete_v1');
  }
} catch (e) { console.error('[migration seed_can_delete_v1]', e); }
// One-shot rename: the 'wechat' sales channel was always meant to mean
// the team's official mini app, not raw WeChat. Migrate any existing
// rows so analytics and the new mini-app import live under one channel
// id ('miniapp'). Idempotent via _migrations marker.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('rename_channel_wechat_to_miniapp_v1');
  if (!ran) {
    db.prepare("UPDATE sales_entries SET channel = 'miniapp' WHERE channel = 'wechat'").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('rename_channel_wechat_to_miniapp_v1');
  }
} catch (e) { console.error('[migration rename_channel_wechat_to_miniapp_v1]', e); }

// Backfill suppliers=1 for admin/manager so they retain access after
// the suppliers section moves out from under Admin. Buyer roles
// (warehouse) also get it — they're the ones wiring suppliers to items.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_suppliers_perm_v1');
  if (!ran) {
    db.prepare("UPDATE permissions SET suppliers = 1 WHERE user_id IN (SELECT id FROM users WHERE role IN ('admin','manager','warehouse'))").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_suppliers_perm_v1');
  }
} catch (e) { console.error('[migration seed_suppliers_perm_v1]', e); }
// Indexes for lot/expiry lookups — fine to call repeatedly, IF NOT EXISTS.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_line_items_lot    ON po_line_items(lot_number)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_line_items_expiry ON po_line_items(expiry_date)'); } catch {}

// One-time migration: ingredient.buy_pack_size used to mean "grams per buy_unit"
// (so 1 kg → 1000). It now means "how many buy_units in one package" (so 1 kg
// → 1). Both schemas yield the same cost_per_unit, so the math output is
// identical — we're just normalising the stored value so the form reads
// intuitively. Trigger flag stored in a tiny `_migrations` table so we run once.
db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
const ranPackSizeMigration = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('pack_size_semantics_v2');
if (!ranPackSizeMigration) {
  // Map of buy_unit → grams in one of that unit. If buy_pack_size matches this
  // exactly, it's almost certainly the old "grams-per-unit" value and should
  // become 1 (one buy_unit per package).
  const conversions = [
    { units: ['kg', 'L', 'liter'], grams: 1000 },
    { units: ['lb'],                grams: 453.6 },
    { units: ['oz'],                grams: 28.35 },
  ];
  let total = 0;
  const fix = db.prepare("UPDATE ingredients SET buy_pack_size = 1 WHERE buy_unit = ? AND buy_pack_size = ?");
  const tx = db.transaction(() => {
    for (const { units, grams } of conversions) {
      for (const u of units) {
        const r = fix.run(u, grams);
        total += r.changes;
      }
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('pack_size_semantics_v2');
  });
  tx();
  if (total > 0) console.log(`[migration] pack_size_semantics_v2: normalised ${total} ingredients`);
}

// Seed default categories and packaging types — runs once.
const ranLookupsSeed = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('lookups_seed_v1');
if (!ranLookupsSeed) {
  const seedCats = db.prepare('INSERT OR IGNORE INTO categories (kind, name, sort_order) VALUES (?,?,?)');
  const recipeCats = ['Dips & Spreads 酱料','Salads 沙拉','Hot Dishes 热菜','Cold Dishes 冷菜','Baked Goods 烘焙','Beverages 饮料','Snacks 小食','Sauces & Condiments 调味','Desserts 甜点','Other 其他'];
  const productCats = ['Bakery','Beverages','Desserts','Savory','Salads','Sandwiches','Meals','Snacks','Sauces & Condiments','Seasonal','Other'];
  recipeCats.forEach((n, i) => seedCats.run('recipe', n, i));
  productCats.forEach((n, i) => seedCats.run('product', n, i));
  // Default packaging types — only if table is empty
  if (db.prepare('SELECT COUNT(*) AS c FROM packaging_types').get().c === 0) {
    const seedPack = db.prepare('INSERT INTO packaging_types (name, name_cn, cost) VALUES (?,?,?)');
    seedPack.run('Small Box', '小盒', 2.50);
    seedPack.run('Kraft Bag', '牛皮纸袋', 1.20);
    seedPack.run('Plastic Tray', '塑料托盘', 0.80);
  }
  db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('lookups_seed_v1');
  console.log('[migration] lookups_seed_v1 applied');
}

// Allergens used to be JSON-stringified on save (e.g. '"gluten, soy"' or
// '["gluten","soy"]'), but every reader treats the column as a plain CSV
// string. Normalise existing rows so display code works uniformly.
const ranAllergenNormalize = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('allergens_normalize_v1');
if (!ranAllergenNormalize) {
  const rows = db.prepare("SELECT id, allergens FROM ingredients WHERE allergens IS NOT NULL AND allergens != ''").all();
  const upd  = db.prepare("UPDATE ingredients SET allergens = ? WHERE id = ?");
  let fixed = 0;
  for (const r of rows) {
    let next = r.allergens;
    try {
      const parsed = JSON.parse(r.allergens);
      if (Array.isArray(parsed)) next = parsed.join(', ');
      else if (typeof parsed === 'string') next = parsed;
    } catch { /* not JSON — leave as-is */ }
    if (next !== r.allergens) { upd.run(next, r.id); fixed++; }
  }
  db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('allergens_normalize_v1');
  if (fixed > 0) console.log(`[migration] allergens_normalize_v1: cleaned ${fixed} rows`);
}

// ─────────────────────────────────────────────────────────────────────────
// MINI APP ORDERS — high-fidelity capture of orders exported from the
// official mini app. One row in `miniapp_orders` per order, with line
// items in `miniapp_order_lines`. The richer schema preserves customer
// identity, location, coupon attribution, refund status, and delivery
// detail so we can build retention / cohort / geo / coupon-ROI charts
// without losing data. Sales analytics also see these via a projection
// into `sales_entries` (channel='miniapp') created during import.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS miniapp_orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Source identifiers (Order ID is the canonical upsert key)
    source_order_id     INTEGER UNIQUE,         -- 'Order ID' in the export (numeric)
    order_no            TEXT,                   -- 'Order #' (long string)
    -- Customer
    user_id             INTEGER,                -- 'User ID' in the export
    customer_phone      TEXT,
    customer_name       TEXT,
    -- Money
    product_total       REAL,                   -- 'Product price'
    delivery_fee        REAL,                   -- 'Delivery fees'
    income              REAL,                   -- 'Income' (after discounts)
    used_points         REAL,
    refund_amount       REAL,
    -- Status
    status              TEXT,                   -- 交易成功 / 订单关闭 / 待评价
    refund_status       TEXT,                   -- Yes / No
    payment_method      TEXT,                   -- WXAPP / OFFLINE-Cash / OFFLINE-Wechat
    payment_no          TEXT,
    -- Time
    order_date          DATETIME,
    delivery_date       TEXT,                   -- Free text: 'ETA：19:30' or actual date
    -- Address (split + raw)
    province            TEXT,
    city                TEXT,
    district            TEXT,
    address             TEXT,                   -- Full 'Customer address'
    compound            TEXT,                   -- Apartment / community
    address_details     TEXT,                   -- Floor, unit, etc.
    -- Marketing
    coupon_name         TEXT,
    coupon_discount     REAL,
    referrer_phone      TEXT,
    referrer_name       TEXT,
    -- Delivery
    delivery_company    TEXT,
    tracking_no         TEXT,
    pickup_store        TEXT,                   -- NULL = delivery, set = pickup
    -- Misc
    remarks             TEXT,
    admin_note          TEXT,
    -- Audit
    imported_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_miniapp_orders_user        ON miniapp_orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_miniapp_orders_phone       ON miniapp_orders(customer_phone);
  CREATE INDEX IF NOT EXISTS idx_miniapp_orders_date        ON miniapp_orders(order_date);
  CREATE INDEX IF NOT EXISTS idx_miniapp_orders_district    ON miniapp_orders(district);
  CREATE INDEX IF NOT EXISTS idx_miniapp_orders_coupon      ON miniapp_orders(coupon_name);

  CREATE TABLE IF NOT EXISTS miniapp_order_lines (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            INTEGER NOT NULL,        -- FK to miniapp_orders.id
    -- Resolved product (may be NULL if name didn't match anything)
    product_id          INTEGER,
    -- Raw product info from the export (kept verbatim for audit + name fallbacks)
    product_name_en     TEXT,
    product_name_cn     TEXT,
    -- Variant + add-on parsed from "Options::" / "Combine with::" suffixes
    variant_label       TEXT,                    -- e.g. 'Buy 2 Get 1 Free!'
    combine_with        TEXT,                    -- e.g. 'Nothing, Thanks :）'
    -- Quantities
    units               REAL,                    -- 'Product units:'
    unit_price          REAL,                    -- 'Price'
    line_total          REAL,                    -- units * unit_price (computed at import)
    -- Per-line refund info (mini app marks refund per line)
    refund_status       TEXT,
    FOREIGN KEY (order_id)   REFERENCES miniapp_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)        ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_miniapp_lines_order   ON miniapp_order_lines(order_id);
  CREATE INDEX IF NOT EXISTS idx_miniapp_lines_product ON miniapp_order_lines(product_id);
`);

// ─────────────────────────────────────────────────────────────────────────
// MEITUAN — settlement-style export from the Meituan B2B portal. Each
// "order" generates ~3.6 fee rows in the source file (order revenue +
// delivery fee + insurance + ad spend + …); we collapse them per order_no.
// Multiple physical stores live under one channel='meituan' so the
// channel-mix dashboard stays clean; the dedicated Meituan tab splits
// by store for per-location P&L.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_stores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_store_id TEXT UNIQUE,           -- 门店id from the export
    name            TEXT,                  -- 门店名称
    nickname        TEXT,                  -- friendly label set by user (e.g. 'Yuexiu')
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meituan_orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id            INTEGER NOT NULL,
    source_order_no     TEXT UNIQUE,        -- 订单号 — idempotent upsert key
    ordered_at          DATETIME,           -- 下单时间
    completed_at        DATETIME,           -- 完成时间
    refunded_at         DATETIME,           -- 退款时间
    status              TEXT,               -- 订单完成 / 订单已处理 / 订单取消
    delivery_method     TEXT,               -- 美团直送 / 商家自配 / 经济送 / 到店取餐
    customer_payment    TEXT,               -- 用户支付方式
    -- Money — all derived from 商家应收款 sums grouped by 交易类型
    product_total       REAL,               -- 商品总价 from 外卖订单 row(s)
    package_fee         REAL,               -- 打包费
    customer_paid       REAL,               -- 用户线上支付金额
    customer_delivery_fee REAL,             -- 用户支付配送费
    merchant_subsidy    REAL,               -- 商家对顾客的活动补贴
    platform_subsidy    REAL,               -- 美团活动补贴
    -- Fees deducted (all stored as positive numbers; net deducts)
    delivery_fee_paid   REAL DEFAULT 0,     -- 配送费用 (Meituan delivery cost)
    delivery_tip_paid   REAL DEFAULT 0,     -- 配送小费
    ad_spend            REAL DEFAULT 0,     -- 流量助手节省转入广告
    coupon_subsidy_paid REAL DEFAULT 0,     -- 津贴联盟 + 专属流量
    insurance_fee       REAL DEFAULT 0,     -- 保险 (food safety insurance)
    commission          REAL DEFAULT 0,     -- 佣金(实付)
    partial_refund      REAL DEFAULT 0,     -- 订单部分退款
    -- Outcome
    gross_amount        REAL DEFAULT 0,     -- product_total + package_fee
    net_to_merchant     REAL DEFAULT 0,     -- 商家应收款 sum across all rows
    item_count          INTEGER DEFAULT 0,  -- 商品数量
    -- Audit
    imported_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES meituan_stores(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_meituan_orders_store ON meituan_orders(store_id);
  CREATE INDEX IF NOT EXISTS idx_meituan_orders_date  ON meituan_orders(ordered_at);

  -- Daily settlement (账单明细 sheet) — one row per store per day. Useful
  -- for matching deposits to your bank statement.
  CREATE TABLE IF NOT EXISTS meituan_settlements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id            INTEGER NOT NULL,
    settlement_id       TEXT,                -- 结算id
    bill_date           DATE,                -- 账单日期
    bill_amount         REAL,                -- 账单金额
    status              TEXT,                -- 结算状态
    period              TEXT,                -- 归属账期 (e.g. '2026-01-01~2026-01-01')
    settled_on          DATE,                -- 结算日期
    UNIQUE(store_id, settlement_id, bill_date),
    FOREIGN KEY (store_id) REFERENCES meituan_stores(id) ON DELETE CASCADE
  );

  -- Cash flow (账户余额流水) — withdrawals + deposits to the Meituan balance.
  CREATE TABLE IF NOT EXISTS meituan_balance_flow (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER NOT NULL,
    txn_id          TEXT UNIQUE,             -- 交易号
    occurred_at     DATETIME,                -- 日期
    type            TEXT,                    -- 余额提现 / 账单入账 / etc.
    amount          REAL,                    -- 金额
    balance_after   REAL,                    -- 现有余额
    status          TEXT,
    FOREIGN KEY (store_id) REFERENCES meituan_stores(id) ON DELETE CASCADE
  );
`);

// ─── Staff feedback / bug reports ──────────────────────────────────────────
// Lets staff submit bugs, feature requests, and questions in-app (via the
// Sprout panel's Report tab). Owner sees an inbox with status workflow:
//   new → seen → in_progress → done   (or → wont_do)
// Images attached as base64 data URIs in feedback_attachments — same
// pattern we use elsewhere so a single .db backup carries everything.
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id     INTEGER NOT NULL,
  reporter_name   TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT DEFAULT 'bug',          -- bug | feature | question | other
  status          TEXT DEFAULT 'new',          -- new | seen | in_progress | done | wont_do
  owner_note      TEXT,
  page_context    TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  seen_at         DATETIME,
  done_at         DATETIME,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
)`);
db.exec(`CREATE TABLE IF NOT EXISTS feedback_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id   INTEGER NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  data          TEXT NOT NULL,                  -- base64 data URI
  uploaded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
)`);
// Comment thread on a feedback item — lets the owner and the reporter
// chat back and forth without leaving the app. Owner_note on `feedback`
// stays separate (it's an internal note, only admins see it); comments
// are visible to BOTH the owner and the reporter.
db.exec(`CREATE TABLE IF NOT EXISTS feedback_comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id   INTEGER NOT NULL,
  author_id     INTEGER NOT NULL,
  author_name   TEXT NOT NULL,
  author_role   TEXT,                            -- 'admin' | other; used by UI to align bubble L/R
  body          TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id)   REFERENCES users(id)    ON DELETE CASCADE
)`);
// Photos attached to a single reply in the comment thread. Same shape as
// feedback_attachments — data URI inline so a .db backup stays self-contained.
db.exec(`CREATE TABLE IF NOT EXISTS feedback_comment_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id    INTEGER NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  data          TEXT NOT NULL,                  -- base64 data URI
  uploaded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (comment_id) REFERENCES feedback_comments(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_status   ON feedback(status)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_reporter ON feedback(reporter_id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_atts     ON feedback_attachments(feedback_id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_comments ON feedback_comments(feedback_id, id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_comment_atts ON feedback_comment_attachments(comment_id)'); } catch {}

// ─────────────────────────────────────────────────────────────────────────
// RETAIL MINI APP (new native WeChat mini program) — tables back the new
// B2C storefront. Names are `retail_*` to avoid colliding with the legacy
// `miniapp_orders` (imported-from-old-platform audit trail). The two run
// in parallel; no FK between them.
//   customers          → openid-keyed buyer master
//   customer addresses → multi-address book
//   auth tokens        → opaque session tokens (header auth, not cookie)
//   orders / items     → live order ledger
//   payments           → wechat/alipay/points transaction records
//   product options    → per-product Q&A (size, cutlery, …)
//   storefront_config  → KV store driving theme/fees/home layout (§9 spec)
// Existing products table gets retail-only columns for publish + price +
// stock + sort + marketing copy; retail inventory is INDEPENDENT from
// kitchen stock_qty.
// ─────────────────────────────────────────────────────────────────────────
addColumn('products', 'is_published',           'INTEGER DEFAULT 0');
addColumn('products', 'retail_price',           'REAL DEFAULT 0');
addColumn('products', 'retail_stock',           'INTEGER DEFAULT 0');
addColumn('products', 'retail_display_order',   'INTEGER DEFAULT 0');
addColumn('products', 'retail_tagline',         'TEXT');
addColumn('products', 'retail_description_en',  'TEXT');
addColumn('products', 'retail_description_cn',  'TEXT');
// Nutrition facts panel. JSON-encoded for flexibility — different products
// list different fields (kcal/fat/carbs/sugar/protein/sodium…) and basis
// varies (per 100ml vs per 100g vs per serving). Shape:
//   { basis_en, basis_cn, rows:[{label_en,label_cn,value}] }
addColumn('products', 'nutrition',              'TEXT');
// Mini-app product-card chrome:
//   keywords_en / keywords_cn — short comma-separated descriptors that
//     appear in green next to the other-language name, e.g. "raw, alive"
//   tagline_en / tagline_cn   — the bold one-liner slogan below the
//     subtitle, e.g. "Your gut deserves better"
addColumn('products', 'keywords_en',            'TEXT');
addColumn('products', 'keywords_cn',            'TEXT');
addColumn('products', 'tagline_en',             'TEXT');
addColumn('products', 'tagline_cn',             'TEXT');
// Block-based product page body. JSON array of `{id, type, ...data}` blocks
// where each block type is rendered by a bespoke visual on the mini-app
// (hero_intro, stat_callout, allergen_card, ingredients, how_to_use,
//  storage, photo_strip, pull_quote, divider, …). When this column is
// non-empty the mini-app renders it INSTEAD of the legacy description_en/cn
// textareas — products that haven't been migrated to blocks fall back to
// the textareas so there's no flag day.
addColumn('products', 'description_blocks',     'TEXT');
// Per-product toggle: which description renderer the mini-app product page
// uses. 0/NULL (default) → classic description_en/cn path (rich-text or
// ## headings). 1 → designer block editor (description_blocks). Without
// this flag, blocks would silently win the moment any were authored — too
// sticky if the office wants to keep drafted blocks while still publishing
// the classic copy. Set from the kitchen product editor's Description card.
addColumn('products', 'use_block_design',       'INTEGER DEFAULT 0');
// Which product-page TEMPLATE the block design is built from. A template is a
// self-contained design system (a default block stack + its own per-block
// style/colour defaults). Stored as the template id string (e.g.
// 'editorial_light'); blank/NULL → no template chosen yet (legacy block pages
// that pre-date templates render fine — the id only drives the editor's
// template highlight + the per-template style layer added later). Switching
// template is destructive (reseeds the block stack), so this is just a label
// of provenance, not a constraint on what's stored in description_blocks.
addColumn('products', 'page_template',           'TEXT');
// Page colophon overrides — v1 design renders a single IP character + a
// brand tagline as the page sign-off. By default we auto-pick the
// character by product category and use "From Soil to Soul" as the line,
// but the office can override either per product:
//   colophon_character  — IP key like 'soilsoul' / 'skater' / 'kombucha-gang' / 'flex' / 'radishes' / 'mushroom' / 'peas' / 'onion' / 'broccoli' / 'hula'. Blank → auto-pick.
//   colophon_tagline_*  — bilingual override of "From Soil to Soul". Blank → default.
addColumn('products', 'colophon_character',     'TEXT');
addColumn('products', 'colophon_tagline_en',    'TEXT');
addColumn('products', 'colophon_tagline_cn',    'TEXT');
// Two-level shop category scheme. `top_category` is one of the 7 storefront
// categories (Dry & Pantry, Fresh & Deli, …); `subcategory` is the section
// heading within it (Nuts & Seeds, Legumes, …). Populated by
// scripts/organize_categories.js. The legacy free-form `category` column is
// left intact (still drives other admin views); the shop reads these two.
addColumn('products', 'top_category', 'TEXT');
addColumn('products', 'subcategory',  'TEXT');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_published ON products(is_published) WHERE is_published = 1'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_top_category ON products(top_category)'); } catch {}

// ─── Flash sales (秒杀) ─────────────────────────────────────────────────────
// A product is "on flash" between flash_starts_at and flash_ends_at, charged
// at flash_price instead of retail_price/sell_price. flash_stock_limit caps
// the number sold during the window (NULL = unlimited within window);
// flash_sold is incremented atomically inside order-create. retail.js owns
// the activation check + the pricing — these columns are just storage.
addColumn('products', 'flash_price',       'REAL');
addColumn('products', 'flash_starts_at',   'DATETIME');
addColumn('products', 'flash_ends_at',     'DATETIME');
addColumn('products', 'flash_stock_limit', 'INTEGER');
addColumn('products', 'flash_sold',        'INTEGER DEFAULT 0');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_products_flash_ends ON products(flash_ends_at) WHERE flash_price IS NOT NULL AND flash_ends_at IS NOT NULL'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS retail_customers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    openid          TEXT UNIQUE NOT NULL,
    unionid         TEXT,
    nickname        TEXT,
    avatar_url      TEXT,
    phone           TEXT,
    email           TEXT,
    gender          INTEGER,            -- 0 unknown, 1 male, 2 female (WeChat enum)
    birthday        DATE,
    tier_key        TEXT DEFAULT 'seed',    -- seed | sprout | root | tree
    lifetime_spend  REAL DEFAULT 0,
    points_balance  INTEGER DEFAULT 0,
    coupon_count    INTEGER DEFAULT 0,
    balance         REAL DEFAULT 0,         -- prepaid wallet balance
    is_blocked      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at   DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_retail_customers_phone ON retail_customers(phone);

  CREATE TABLE IF NOT EXISTS retail_customer_addresses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL,
    recipient_name  TEXT NOT NULL,
    phone           TEXT NOT NULL,
    province        TEXT,
    city            TEXT,
    district        TEXT,
    address         TEXT NOT NULL,          -- full street + building
    detail          TEXT,                   -- floor, unit, apt
    postal_code     TEXT,
    is_default      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_addrs_customer ON retail_customer_addresses(customer_id);

  CREATE TABLE IF NOT EXISTS retail_auth_tokens (
    token           TEXT PRIMARY KEY,
    customer_id     INTEGER NOT NULL,
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at    DATETIME,
    user_agent      TEXT,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_tokens_customer ON retail_auth_tokens(customer_id);
  CREATE INDEX IF NOT EXISTS idx_retail_tokens_expires  ON retail_auth_tokens(expires_at);

  -- One-time passcodes for browser (web) phone login. One active code per phone
  -- (phone is the PK); a fresh request overwrites the previous row. The code is
  -- short-lived (expires_at) and burns after a few wrong tries (attempts).
  CREATE TABLE IF NOT EXISTS retail_otp_codes (
    phone           TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    expires_at      DATETIME NOT NULL,
    attempts        INTEGER DEFAULT 0,   -- wrong-guess counter (burn at 5)
    send_count      INTEGER DEFAULT 0,   -- sends in the current day (abuse cap)
    last_sent_at    DATETIME,            -- for the resend cooldown
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- One-time passcodes for browser (web) EMAIL login. Same shape/lifecycle as
  -- retail_otp_codes but keyed by email. Accounts unify by verified email, so an
  -- email-OTP sign-in lands on the SAME record as a Google/Apple login on that
  -- address (see upsertWebCustomer in routes/retail.js).
  CREATE TABLE IF NOT EXISTS retail_email_otp_codes (
    email           TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    expires_at      DATETIME NOT NULL,
    attempts        INTEGER DEFAULT 0,
    send_count      INTEGER DEFAULT 0,
    last_sent_at    DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Short-lived rows that bridge the OAuth (Google/Apple/WeChat-web) redirect.
  --   kind='state'   outbound CSRF token; carries the SPA hash to return to.
  --   kind='handoff' inbound one-time code → the issued bearer token. The
  --                  callback redirects with ?oauth=<handoff> instead of putting
  --                  the long-lived token in the URL; the SPA POSTs it to
  --                  /oauth/claim to receive the token out of band. Both kinds
  --                  expire fast (10 min / 2 min) and are deleted on use.
  CREATE TABLE IF NOT EXISTS retail_oauth_states (
    id              TEXT PRIMARY KEY,        -- random state token or handoff code
    kind            TEXT NOT NULL,           -- 'state' | 'handoff'
    provider        TEXT,
    return_to       TEXT,                    -- SPA hash to restore after sign-in
    auth_token      TEXT,                    -- issued bearer token (handoff rows)
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS retail_orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no            TEXT UNIQUE NOT NULL,    -- public-facing, e.g. R2026051601234
    customer_id         INTEGER,                 -- nullable so ON DELETE SET NULL keeps the order (financial record) if a customer is ever removed
    -- Workflow
    status              TEXT NOT NULL DEFAULT 'pending_payment',
      -- pending_payment | paid | preparing | dispatched | delivered | cancelled | refunded
    payment_method      TEXT,                    -- wechat | alipay | points
    -- Snapshots (address + contact captured at order-time so later edits don't change history)
    recipient_name      TEXT,
    recipient_phone     TEXT,
    address_full        TEXT,                    -- one-line concatenated, audit-friendly
    address_json        TEXT,                    -- structured snapshot (province/city/district/address/detail)
    -- Money (¥ stored as REAL, two-decimal precision)
    subtotal            REAL DEFAULT 0,
    shipping_fee        REAL DEFAULT 0,
    voucher_code        TEXT,
    voucher_amount      REAL DEFAULT 0,
    points_used         INTEGER DEFAULT 0,
    points_amount       REAL DEFAULT 0,          -- ¥ value of points_used
    total               REAL DEFAULT 0,          -- amount actually charged
    -- Customer extras
    customer_note       TEXT,
    needs_cutlery       INTEGER DEFAULT 0,
    needs_invoice       INTEGER DEFAULT 0,
    invoice_title       TEXT,                    -- company/personal title for fapiao
    invoice_tax_id      TEXT,                    -- 税号 if company
    -- Staff workflow
    staff_note          TEXT,
    cancelled_reason    TEXT,
    -- Timestamps
    placed_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at             DATETIME,
    preparing_at        DATETIME,
    dispatched_at       DATETIME,
    delivered_at        DATETIME,
    cancelled_at        DATETIME,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_orders_customer ON retail_orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_retail_orders_status   ON retail_orders(status);
  CREATE INDEX IF NOT EXISTS idx_retail_orders_placed   ON retail_orders(placed_at);

  -- Customer in-app notification center. One row per event (order status,
  -- refund transition, invoice issued, …). read_at NULL = unread. ref_type +
  -- ref_id deep-link the mini app to the relevant order/invoice.
  CREATE TABLE IF NOT EXISTS retail_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    category    TEXT NOT NULL,          -- 'order' | 'refund' | 'invoice'
    type        TEXT NOT NULL,          -- specific event, e.g. 'order_preparing'
    title_en    TEXT, title_cn TEXT,
    body_en     TEXT, body_cn TEXT,
    ref_type    TEXT,                   -- 'order' | 'invoice'
    ref_id      TEXT,                   -- deep-link target id
    read_at     DATETIME,               -- NULL = unread
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_notif_customer ON retail_notifications(customer_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_retail_notif_created  ON retail_notifications(created_at);

  CREATE TABLE IF NOT EXISTS retail_order_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL,
    product_id      INTEGER,
    -- Snapshots at order-time so future product edits don't rewrite history
    name_en         TEXT,
    name_cn         TEXT,
    sku             TEXT,
    size            TEXT,                        -- weight/volume snapshot
    image_url       TEXT,
    qty             REAL NOT NULL,
    unit_price      REAL NOT NULL,               -- price snapshot AFTER option deltas
    line_total      REAL NOT NULL,
    options_json    TEXT,                        -- chosen option labels + price deltas, for the receipt
    FOREIGN KEY (order_id)   REFERENCES retail_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
  CREATE INDEX IF NOT EXISTS idx_retail_order_items_order   ON retail_order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_order_items_product ON retail_order_items(product_id);

  CREATE TABLE IF NOT EXISTS retail_payments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            INTEGER NOT NULL,
    method              TEXT NOT NULL,           -- wechat | alipay | points
    amount              REAL NOT NULL,
    status              TEXT DEFAULT 'pending',  -- pending | success | failed | refunded
    -- Provider-side identifiers (held even after order moves on so we can reconcile)
    transaction_id      TEXT,                    -- e.g. wechat transaction_id or alipay trade_no
    out_trade_no        TEXT,                    -- our local ref sent to provider
    qr_image_url        TEXT,                    -- alipay precreate result (saved for receipt screens)
    raw_callback_json   TEXT,                    -- full provider callback body for audit
    refunded_amount     REAL DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at        DATETIME,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_payments_order ON retail_payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_payments_txn   ON retail_payments(transaction_id);

  -- Per-product custom Q&A (e.g. "Choose size", "Add cutlery?", "Spice level?")
  -- The mini app renders one block per option, in sort_order. type controls UI:
  --   single  → radio (one choice)
  --   multi   → checkbox (zero-or-more choices)
  --   text    → free-text input (price_delta ignored, no choices needed)
  CREATE TABLE IF NOT EXISTS retail_product_options (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    question_en     TEXT NOT NULL,
    question_cn     TEXT,
    type            TEXT NOT NULL DEFAULT 'single',   -- single | multi | text
    is_required     INTEGER DEFAULT 0,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_opts_product ON retail_product_options(product_id);

  CREATE TABLE IF NOT EXISTS retail_product_option_choices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    option_id       INTEGER NOT NULL,
    label_en        TEXT NOT NULL,
    label_cn        TEXT,
    price_delta     REAL DEFAULT 0,                   -- added to product retail_price when chosen
    is_default      INTEGER DEFAULT 0,
    sort_order      INTEGER DEFAULT 0,
    FOREIGN KEY (option_id) REFERENCES retail_product_options(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_opt_choices_opt ON retail_product_option_choices(option_id);

  -- KV-style storefront config. Keys are dotted paths (e.g. 'theme.accent',
  -- 'fees.freeShippingThreshold', 'home.sections'). Values are JSON strings;
  -- primitives are JSON-encoded too (so '"lime-leaf"' for a string,  '399'
  -- for a number, '[{...},{...}]' for arrays). GET /api/retail/config
  -- reads all rows and assembles the nested response.
  CREATE TABLE IF NOT EXISTS storefront_config (
    key             TEXT PRIMARY KEY,
    value_json      TEXT NOT NULL,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by      INTEGER                            -- staff user_id (NULL if seed)
  );

  -- Editorial (Kitchen Notes) view tracking. The mini-app fires one row when a
  -- recipe_story block scrolls into view ('impression') and one when the
  -- customer taps READ MORE ('read'). viewer_key is 'c<customerId>' when
  -- logged in, else 's<session>' (per-launch) so anonymous reach still counts.
  -- The UNIQUE index dedupes per viewer per kind per GZ day, so a customer
  -- reloading home all day counts once — an honest "people reached", not raw
  -- reload counts. The dashboard aggregates per block id (headline lives in the
  -- storefront layout JSON, joined in at read time).
  CREATE TABLE IF NOT EXISTS retail_article_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id    TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'impression',   -- 'impression' | 'read'
    viewer_key  TEXT NOT NULL,                        -- 'c<customerId>' | 's<session>' | 'ip<ip>'
    day         TEXT NOT NULL,                        -- YYYY-MM-DD (GZ local)
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_article_views_uniq
    ON retail_article_views(block_id, kind, viewer_key, day);
  CREATE INDEX IF NOT EXISTS idx_article_views_day ON retail_article_views(day);

  -- Product VERSION HISTORY, powering the editor's "Version history" button.
  -- The product editor autosaves; each distinct saved state is checkpointed
  -- here as a JSON snapshot of the product's catalog content (name / price /
  -- description / photos / category / flags). is_baseline marks the very first
  -- snapshot (the product as it stood before this run of edits = "Original").
  -- A burst of autosaves within a couple of minutes collapses into one evolving
  -- checkpoint (the save handler UPDATEs the latest row in place); identical
  -- saves are skipped; old non-baseline rows are pruned so the list stays short.
  -- Inventory counts (stock_qty / per-store stock) are deliberately NOT
  -- captured, so restoring a version never rolls back sales or restocks. No FK:
  -- decoupled from store_products like the other retail_* satellite tables.
  CREATE TABLE IF NOT EXISTS retail_product_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL,                  -- store_products.id (no FK)
    snapshot_json TEXT NOT NULL,                     -- catalog content at save
    is_baseline   INTEGER NOT NULL DEFAULT 0,        -- 1 = the original (pre-edit) state
    edited_by     TEXT,                              -- operator who saved it
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_product_versions_pid
    ON retail_product_versions(product_id, id);
`);

// New `retail` permission — gates the storefront admin surface (publish
// products, edit storefront config, advance retail order statuses).
// Default 0; admin always passes via requirePermission's role check.
addColumn('permissions', 'retail', 'INTEGER DEFAULT 0');
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_retail_perm_v1');
  if (!ran) {
    db.prepare("UPDATE permissions SET retail = 1 WHERE user_id IN (SELECT id FROM users WHERE role IN ('admin','manager'))").run();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_retail_perm_v1');
  }
} catch (e) { console.error('[migration seed_retail_perm_v1]', e); }

// Retail subscribe-message tracking. WeChat's subscribeMessage API gives
// us ONE chance to push a notification per customer consent. The customer
// taps "Allow" at checkout → we record the row → status transition fires
// a send → row is marked used. Re-prompt next time customer interacts.
//
// template_id is set in mp console after AppID is registered; the office
// drops it into storefront_config.notifications.order_status_template_id.
// Vouchers / promo codes. Office creates them in /retail-admin; customer
// enters the code at checkout. Three types supported in v1:
//   • fixed_amount  → value is the ¥ discount (subtract from subtotal)
//   • percent       → value is 0..100, percent off subtotal
//   • free_shipping → value ignored; just zeroes the shipping fee
// Usage tracking: each voucher has used_count + max_uses. On apply we
// atomically increment used_count via a transaction.
db.exec(`CREATE TABLE IF NOT EXISTS retail_vouchers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL DEFAULT 'fixed_amount',
  value           REAL NOT NULL DEFAULT 0,
  min_subtotal    REAL NOT NULL DEFAULT 0,
  max_uses        INTEGER,                          -- NULL = unlimited
  used_count      INTEGER DEFAULT 0,
  per_customer_limit INTEGER DEFAULT 1,             -- 0 = no per-customer cap
  expires_at      DATETIME,                          -- NULL = no expiry
  is_active       INTEGER DEFAULT 1,
  description     TEXT,                              -- internal note
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by      INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id)
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_vouchers_code ON retail_vouchers(code)'); } catch {}

// Customer-owned vouchers — vouchers admin has granted to a specific
// customer. Show up in the customer's wallet / checkout as no-code, single-
// tap vouchers. Distinct from is_public (browseable by everyone). When a
// granted voucher is applied to an order, used_at + used_order_id are set.
db.exec(`CREATE TABLE IF NOT EXISTS retail_customer_vouchers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL,
  voucher_id    INTEGER NOT NULL,
  granted_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  granted_by    INTEGER,
  granted_note  TEXT,
  used_at       DATETIME,
  used_order_id INTEGER,
  FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (voucher_id)  REFERENCES retail_vouchers(id)  ON DELETE CASCADE,
  FOREIGN KEY (granted_by)  REFERENCES users(id),
  UNIQUE(customer_id, voucher_id)
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rcv_customer ON retail_customer_vouchers(customer_id, used_at)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_rcv_voucher  ON retail_customer_vouchers(voucher_id)'); } catch {}

// Customer product reviews. One row per (customer, product, order) so a
// repeat buyer can write a fresh review every time they order. Shown on
// the public product detail with aggregated avg + count + N most recent.
db.exec(`CREATE TABLE IF NOT EXISTS retail_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL,
  product_id    INTEGER NOT NULL,
  order_id      INTEGER NOT NULL,
  rating        INTEGER NOT NULL,        -- 1..5
  comment       TEXT,
  photos_json   TEXT,                    -- JSON array of media URLs (future)
  is_visible    INTEGER DEFAULT 1,       -- admin can hide
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id)  REFERENCES products(id)         ON DELETE CASCADE,
  FOREIGN KEY (order_id)    REFERENCES retail_orders(id)    ON DELETE CASCADE,
  UNIQUE(customer_id, product_id, order_id)
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_reviews_product ON retail_reviews(product_id, is_visible, created_at)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_reviews_customer ON retail_reviews(customer_id, created_at)'); } catch {}
// Quick-tag chips picked by the customer (e.g. 'fresh', 'fast-ship').
// JSON array of string ids; tag labels live client-side so we can change
// the wording without a migration.
addColumn('retail_reviews', 'tags_json', 'TEXT');
// Merchant reply to a customer review — a public "seller response" shown under
// the review on the storefront. Set/cleared by staff from the moderation list.
addColumn('retail_reviews', 'reply',    'TEXT');
addColumn('retail_reviews', 'reply_at', 'DATETIME');
// 1 while the review is hidden ONLY because a photo is still waiting on
// WeChat's content-safety verdict. Kept separate from is_visible so the
// verdict callback can release its own holds without ever un-hiding a review
// a human moderator deliberately hid.
addColumn('retail_reviews', 'sec_hold', 'INTEGER DEFAULT 0');
// The operator has READ this review and decided it needs no public answer — a
// duplicate, a thank-you with nothing to reply to, something already handled by
// phone. It leaves the triage queue and NOTHING is published.
//
// It needs its own column because the only other field that could clear that
// queue is `reply`, and `reply` is the PUBLIC seller response rendered under
// the review in the shop. Using it to make a worklist number go down would put
// text in front of customers for a reason that has nothing to do with them.
// Deliberately NOT on retail_synthetic_reviews: seeded rows never enter the
// queue in the first place.
addColumn('retail_reviews', 'dismissed_at', 'DATETIME');

// Synthetic ("seeded") product reviews — social-proof copy written by staff,
// NOT by a real buyer. Kept in their OWN table, fully decoupled from
// retail_customers / retail_orders (which are FK-enforced), so:
//   • real customer reviews stay 100% untouched,
//   • the whole set is reversible (drop rows / DELETE by id),
//   • they can never be mistaken for a real verified purchase internally.
// They merge into the PUBLIC rating summary + review lists (so the storefront
// shows a blended count/avg), but stay clearly tagged as source:'synthetic'
// in the admin moderation list, where each one can be hidden or hard-removed.
// `reviewer_name` is a made-up display name (never a real customer's).
db.exec(`CREATE TABLE IF NOT EXISTS retail_synthetic_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,        -- store_products.id (no FK: decoupled)
  reviewer_name TEXT NOT NULL,           -- fake display name
  rating        INTEGER NOT NULL,        -- 1..5
  comment       TEXT,
  lang          TEXT,                    -- 'en' | 'cn' (informational only)
  tags_json     TEXT,                    -- JSON array of review-tag ids
  is_visible    INTEGER DEFAULT 1,       -- admin can hide
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_synth_reviews_product ON retail_synthetic_reviews(product_id, is_visible, created_at)'); } catch {}
// Same merchant-reply fields as real reviews so the moderation list can treat
// both tables uniformly.
addColumn('retail_synthetic_reviews', 'reply',    'TEXT');
addColumn('retail_synthetic_reviews', 'reply_at', 'DATETIME');

// A paid add-on choice (e.g. "Pickles", "Spicy sauce") backed by a real
// store product so it has its OWN stock + SKU + packing line. When set, the
// option choice consumes that product's inventory at checkout (qty 1 per unit
// of the parent line) and is hidden/disabled when that product is sold out.
// NULL = an ordinary choice (dressing) with no stock link. See feie.js +
// expandStockLines (order-create reserves the linked product like a bundle
// component, so the existing atomic stock gate prevents overselling).
addColumn('retail_product_option_choices', 'stock_product_id', 'INTEGER');

// Customer-reported bugs / feedback submitted from the mini app "Found a bug?"
// form. Lands read-only in the Mini App Backend → Feedback tab — completely
// separate from the staff `feedback` table (which is the kitchen-app Sprout
// inbox). Photos are uploaded to retail_media first; we store their servable
// /api/retail/media/:id URLs as a JSON array (same shape as retail_reviews).
db.exec(`CREATE TABLE IF NOT EXISTS retail_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL,
  customer_name TEXT,
  message       TEXT NOT NULL,
  photos_json   TEXT,                    -- JSON array of /api/retail/media/:id URLs
  page_context  TEXT,                    -- which mini-app page the report came from
  app_version   TEXT,                    -- mini-app version string (best-effort)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_feedback_created ON retail_feedback(created_at)'); } catch {}

// Two-way conversation on a feedback report. The retail_feedback row is the
// thread root (the customer's first message); every later turn — operator
// reply or customer follow-up — is one row here. `author` is 'admin' or
// 'customer'; `author_name` snapshots the operator's display name so a reply
// can be attributed even after staff changes (NULL for customer turns).
db.exec(`CREATE TABLE IF NOT EXISTS retail_feedback_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  author      TEXT NOT NULL,          -- 'admin' | 'customer'
  author_name TEXT,                   -- operator display name (admin turns only)
  body        TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES retail_feedback(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_feedback_msg ON retail_feedback_messages(feedback_id, id)'); } catch {}

// Thread bookkeeping on the root row. *_msg_at track the latest turn from each
// side; *_read_at track when each side last opened the thread. From these we
// derive "needs reply" (admin) and "new reply" (customer) without per-row
// scans. last_customer_msg_at seeds from created_at on insert so existing
// reports sort correctly.
addColumn('retail_feedback', 'last_customer_msg_at', 'DATETIME');
addColumn('retail_feedback', 'last_admin_msg_at',    'DATETIME');
addColumn('retail_feedback', 'admin_read_at',        'DATETIME');
addColumn('retail_feedback', 'customer_read_at',     'DATETIME');

// A feedback thread is normally customer-initiated (a bug report). The same
// two-table structure also backs operator → customer direct messages: staff
// open a thread from the customer drawer and the customer replies in-app.
// `initiated_by` says who wrote the root turn (so buildFeedbackThread can
// attribute it correctly); `root_author_name` snapshots the operator's name on
// an admin-started thread (NULL for customer reports — mirrors author_name on a
// reply turn); `kind` separates a 'bug' report from a plain 'message' so the
// inbox can label them. Defaults keep every pre-existing row a customer bug.
addColumn('retail_feedback', 'initiated_by',     "TEXT DEFAULT 'customer'");
addColumn('retail_feedback', 'root_author_name', 'TEXT');
addColumn('retail_feedback', 'kind',             "TEXT DEFAULT 'bug'");

// Customer-initiated refund requests with multi-step processing workflow.
// States on retail_orders.refund_status:
//   null | pending | reviewing | approved | paid | rejected | withdrawn
//
// 'pending' is the customer-just-filed state. Name kept as 'pending' rather
// than 'requested' for back-compat with mini-app clients that predate the
// multi-step workflow (they only knew 'pending' / 'approved' / 'rejected').
//
// Customer files via /api/retail/orders/:id/refund-request which captures
// reason, amount (partial), and optional per-line items (refund_lines_json).
// Staff process via /api/retail-admin/orders/:id/refund/{review,approve,reject,payout}.
// Audit log lives in retail_refund_events — one row per state change.
addColumn('retail_orders', 'refund_requested_at',     'DATETIME');
addColumn('retail_orders', 'refund_reason',           'TEXT');
addColumn('retail_orders', 'refund_status',           'TEXT');
addColumn('retail_orders', 'refund_review_note',      'TEXT');
addColumn('retail_orders', 'refund_amount_requested', 'REAL');     // null = full order
addColumn('retail_orders', 'refund_amount_approved',  'REAL');
addColumn('retail_orders', 'refund_amount_paid',      'REAL');
addColumn('retail_orders', 'refund_lines_json',       'TEXT');     // [{item_id, qty, amount}]
addColumn('retail_orders', 'refund_payout_method',    'TEXT');     // wechat|alipay|bank|wallet|store_credit|other
addColumn('retail_orders', 'refund_payout_ref',       'TEXT');     // provider txn id or freeform
addColumn('retail_orders', 'refund_reviewed_at',      'DATETIME');
addColumn('retail_orders', 'refund_approved_at',      'DATETIME');
addColumn('retail_orders', 'refund_paid_at',          'DATETIME');
addColumn('retail_orders', 'refund_reviewer_id',      'INTEGER');
addColumn('retail_orders', 'refund_payer_id',         'INTEGER');
// When the REFUND slip printed. Distinct from printed_at, which belongs to the
// original order slip and must not be disturbed by a refund. Three routes can
// complete a refund (/refund/payout, /refund/direct, and the PATCH /status
// shortcut) and they are reachable in sequence on one order, so this doubles as
// the once-only guard: autoPrintRefundReceipt claims the stamp before printing.
addColumn('retail_orders', 'refund_printed_at',       'DATETIME');

// Provenance — how this order was created. NULL/'app' = customer checkout
// (mini app / web storefront); 'manual' = keyed in by staff via the Mini App
// Backend. created_by is the staff user id for manual orders. Manual orders
// also carry channel='manual' so they get their own filter chip; `source` is
// the durable audit marker (channel can be re-derived, source never changes).
addColumn('retail_orders', 'source',                  'TEXT');
addColumn('retail_orders', 'created_by',              'INTEGER');
// Guest-pay token — an unguessable handle that lets a customer WITHOUT an app
// account open a public pay page (/pay/:token) for a single manual order and
// pay by QR. Minted for manual orders at creation; NULL for app orders (those
// pay in-app). Unique so the public lookup is exact.
addColumn('retail_orders', 'pay_token',              'TEXT');
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_orders_pay_token ON retail_orders(pay_token) WHERE pay_token IS NOT NULL'); } catch {}

// Any rows mislabeled 'requested' from the prior migration version snap
// back to 'pending'. Safe no-op if no such rows exist.
try {
  db.prepare("UPDATE retail_orders SET refund_status = 'pending' WHERE refund_status = 'requested'").run();
} catch {}

db.exec(`CREATE TABLE IF NOT EXISTS retail_refund_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL,
  event       TEXT NOT NULL,   -- requested | reviewing | approved | rejected | paid | withdrawn | note
  amount      REAL,            -- relevant amount for this step (null = n/a)
  note        TEXT,
  user_id     INTEGER,         -- staff user (null if customer-initiated)
  customer_id INTEGER,         -- customer (null if staff-initiated)
  meta_json   TEXT,            -- freeform: payout method/ref, line breakdown, etc.
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_refund_events_order ON retail_refund_events(order_id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_refund_events_created ON retail_refund_events(created_at)'); } catch {}

// ── Order idempotency (mini-app double-submit guard) ────────────────────────
// The mini-app sends a stable idempotency_key per checkout; the partial UNIQUE
// index turns a double-tap / retry into a collision (caught + replayed by the
// route) instead of a second order — which, for points payment, would
// double-spend. NULL keys (legacy rows + clients that don't send one) are
// exempt: SQLite treats NULLs as distinct and the partial WHERE keeps the
// index to real keys only.
addColumn('retail_orders', 'idempotency_key', 'TEXT');

// WeChat mini-program 发货信息管理 (shipping-info upload). The mini-app/JSAPI pay
// flow REQUIRES merchants to upload shipping info per paid order, or WeChat
// auto-refunds it. We satisfy it automatically with a "virtual delivery"
// (logistics_type=3) upload when the order is marked delivered. These columns
// give us idempotency (never double-upload) + a record of the last attempt.
addColumn('retail_orders', 'wx_shipping_uploaded_at', 'DATETIME'); // set on a confirmed upload; NULL = not yet
addColumn('retail_orders', 'wx_shipping_status',      'TEXT');     // last result, e.g. 'ok' | 'err:<code> <msg>' | 'perm:<code> <msg>' (won't retry)
addColumn('retail_orders', 'wx_shipping_attempts',    'INTEGER DEFAULT 0'); // upload tries so far; the retry sweeper stops after a cap
// Single-flight claim. uploaded_at can't serve as the in-flight guard: it's only
// stamped AFTER WeChat replies, so for the whole round trip the row still reads
// "delivered, never uploaded" and a second writer (the retry sweeper, a second
// delivered transition) starts its own upload for the same 支付单. WeChat then
// rejects the loser with 10060019 写冲突. Held for the duration of one attempt
// and released in a finally; a stale lock (process died mid-flight) ages out.
addColumn('retail_orders', 'wx_shipping_locked_at',   'DATETIME'); // NULL = free; set = an upload is in flight

// Channel void bookkeeping: 1 once we've returned stock for a Meituan/channel
// cancel|refund, 0 otherwise. Makes the restock idempotent under a repeating
// poll AND lets us re-deduct if a *transient* void (a refund request that gets
// rejected) flips back to a live status — otherwise phantom stock accumulates.
addColumn('retail_orders', 'channel_stock_restored', 'INTEGER DEFAULT 0');

// Free-text origin for a staff-keyed order whose channel is 'other' — the New
// order form requires it, so the catch-all bucket stays auditable instead of
// becoming the next unattributable pile. NULL for every other channel.
addColumn('retail_orders', 'channel_note', 'TEXT');

try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_orders_idem
             ON retail_orders(customer_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL`);
} catch (e) { console.error('[migration retail_orders idempotency_key index]', e); }

// Defense-in-depth UNIQUE on payment out_trade_no. There is exactly one
// retail_payments row per order and its out_trade_no derives from the UNIQUE
// order_no, so values are already unique at all times; the constraint just
// makes a duplicate provider notify / re-insert physically impossible. Partial
// (non-null) + try/catch so any legacy duplicate can't crash boot.
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_payments_out_trade_no
             ON retail_payments(out_trade_no) WHERE out_trade_no IS NOT NULL`);
} catch (e) { console.error('[migration retail_payments out_trade_no unique]', e); }
addColumn('retail_vouchers', 'is_public',         'INTEGER DEFAULT 0');  // 1 = browseable, no code needed
addColumn('retail_vouchers', 'title_en',          'TEXT');               // customer-facing label for public coupons
addColumn('retail_vouchers', 'title_cn',          'TEXT');
addColumn('retail_vouchers', 'auto_grant_signup', 'INTEGER DEFAULT 0');  // 1 = auto-granted to new customers on first /api/retail/auth
addColumn('retail_vouchers', 'auto_apply',        'INTEGER DEFAULT 0');  // 1 = applied automatically at checkout (best one wins), no code/grant needed

db.exec(`CREATE TABLE IF NOT EXISTS retail_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL,
  template_id   TEXT NOT NULL,
  order_id      INTEGER,
  used          INTEGER DEFAULT 0,
  used_at       DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id)    REFERENCES retail_orders(id)    ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_sub_customer ON retail_subscriptions(customer_id, used)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_sub_order    ON retail_subscriptions(order_id)'); } catch {}

// Retail CMS media library — base64-in-row, same pattern as
// supplier_documents / products.image_data so a .db backup is self-contained.
// Image bytes get served publicly via GET /api/retail/media/:id (cached
// long; the mini app needs them without auth).
db.exec(`CREATE TABLE IF NOT EXISTS retail_media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  data         TEXT NOT NULL,          -- base64 data URI
  uploaded_by  INTEGER,                -- staff user_id
  uploaded_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
)`);
addColumn('retail_media', 'alt_text',  'TEXT');
addColumn('retail_media', 'tags',      "TEXT DEFAULT '[]'");
addColumn('retail_media', 'folder_id', 'INTEGER');
// WeChat content-safety verdict for images a CUSTOMER uploaded (avatars,
// review photos). NULL on staff uploads and on every row that predates the
// check. 'pending' from the moment we submit it to mediaCheckAsync until the
// wxa_media_check callback lands, then 'pass' / 'risky'; 'skipped' when the
// check couldn't run at all (no AppID, non-WeChat login, WeChat unreachable).
addColumn('retail_media', 'sec_status',     'TEXT');
addColumn('retail_media', 'sec_trace_id',   'TEXT');
addColumn('retail_media', 'sec_checked_at', 'DATETIME');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_media_sec ON retail_media(sec_trace_id)'); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS retail_media_folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  parent_id   INTEGER,                  -- nested folders (NULL = top-level)
  sort_order  INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES retail_media_folders(id) ON DELETE SET NULL
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_media_folder_id ON retail_media(folder_id)'); } catch {}

// Imported product-page templates. The product editor ships built-in templates
// (PA_TEMPLATES in product-editor.html); these are operator-uploaded ones from
// a template file (Claude-authored design). `id` is the slug saved to
// products.page_template, so it must not collide with a built-in id. `blocks`
// is the seeded block stack (JSON, same shape as products.page_blocks);
// `skin_css` is an optional CSS re-skin the editor injects scoped to
// .pa-tpl-<id>. Shared across all operators (one row = one selectable card).
db.exec(`CREATE TABLE IF NOT EXISTS retail_page_templates (
  id          TEXT PRIMARY KEY,              -- slug, e.g. 'bold_deli'
  label_en    TEXT NOT NULL,
  label_cn    TEXT NOT NULL,
  desc_en     TEXT DEFAULT '',
  desc_cn     TEXT DEFAULT '',
  blocks      TEXT NOT NULL DEFAULT '[]',    -- JSON array of blocks
  skin_css    TEXT DEFAULT '',               -- optional CSS scoped to .pa-tpl-<id>
  created_by  INTEGER,                       -- staff user_id or backend operator id
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Broadcasts — operator-composed announcements that fan out to every active
// (non-blocked) customer's notification feed. Each row here is the authored
// message; the per-customer copies live in retail_notifications with
// broadcast_id pointing back. Recall = DELETE those rows + flip status.
// scheduled_for IS NULL → send immediately; otherwise the scheduler picks
// it up when CURRENT_TIMESTAMP >= scheduled_for.
db.exec(`CREATE TABLE IF NOT EXISTS retail_broadcasts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en        TEXT, title_cn TEXT,
  body_en         TEXT, body_cn TEXT,
  deeplink        TEXT,                          -- mini-app route, e.g. /pages/shop/shop
  audience        TEXT NOT NULL DEFAULT 'all_active',
  scheduled_for   DATETIME,                      -- NULL = send immediately
  sent_at         DATETIME,                      -- NULL until fanout completes
  recipient_count INTEGER DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|sent|recalled|cancelled
  created_by      INTEGER,                       -- users.id
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_broadcasts_status ON retail_broadcasts(status, scheduled_for)'); } catch {}
addColumn('retail_notifications', 'broadcast_id', 'INTEGER');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_notif_broadcast ON retail_notifications(broadcast_id)'); } catch {}

// Seed a default ONBOARDING layout — first-launch customers in the mini
// app see this. The office can edit it later in /cms → Onboarding page.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_onboarding_layout_v1');
  if (!ran) {
    const layout = [
      { id: 'on1', type: 'spacer', height_px: 80 },
      { id: 'on4', type: 'announcement_bar', text_en: 'Food made from food.', text_cn: '食物源于食物。', bg_color: 'oat-milk', fg_color: 'ink' },
      { id: 'on5', type: 'announcement_bar', text_en: 'From soil to soul.',   text_cn: '从土壤到灵魂。',  bg_color: 'oat-milk', fg_color: 'forest-kale' },
      { id: 'on6', type: 'spacer', height_px: 40 },
    ];
    const blob = JSON.stringify(layout);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('onboarding.layout', ?)").run(blob);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('cms.draft.onboarding_layout', ?)").run(blob);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_onboarding_layout_v1');
  }
} catch (e) { console.error('[migration seed_onboarding_layout_v1]', e); }

// Seed a default home layout for the CMS so the editor opens to something
// non-empty on a fresh DB. The draft slot mirrors the live slot so opening
// the editor and hitting Publish without edits is a no-op.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_home_layout_v1');
  if (!ran) {
    const defaultLayout = [
      { id: 'b1', type: 'hero_banner',   image_url: '', cta_label: 'SHOP', cta_target: 'shop', height_px: 520 },
      { id: 'b2', type: 'announcement_bar', text_en: 'Free shipping over ¥399', text_cn: '满 399 元免邮', bg_color: 'lime-leaf', fg_color: 'ink' },
      { id: 'b3', type: 'category_tabs', category_ids: [], style: 'tiles' },
      { id: 'b4', type: 'product_grid',  source_type: 'category', category_id: null, columns: 2, limit: 6 },
    ];
    const blob = JSON.stringify(defaultLayout);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('home.layout', ?)").run(blob);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('cms.draft.home_layout', ?)").run(blob);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_home_layout_v1');
  }
} catch (e) { console.error('[migration seed_home_layout_v1]', e); }

// Seed the editable 2-level category tree (storefront_config['category.tree'])
// from the hard-coded SEED_TREE in lib/category-tree.js. After this, the tree
// is owned by the DB and edited from the Mini App Backend → Categories tab;
// SEED_TREE stays only as the seed + runtime fallback. INSERT OR IGNORE never
// clobbers an operator-edited tree.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_category_tree_v1');
  if (!ran) {
    const { SEED_TREE } = require('./lib/category-tree');
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('category.tree', ?)").run(JSON.stringify(SEED_TREE));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_category_tree_v1');
  }
} catch (e) { console.error('[migration seed_category_tree_v1]', e); }

// Seed Roots' Mini-app footer (Me page) so that flipping the SaaS-wide
// defaults to tacet ('Clarity with code', 'Powered by tacet')
// doesn't accidentally rebrand Roots' live customer footer. New tenants
// have no row → they fall through to the tacet defaults in me.js
// until their operator saves the Mini App Backend → Mini-app footer card.
// INSERT OR IGNORE preserves any existing operator-saved row.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_brand_me_footer_roots_v1');
  if (!ran) {
    const rootsFooter = {
      wordmark_image: '/assets/brand/roots-wordmark.png',
      wordmark_text:  null,
      tagline_en:     'Food made from food.',
      tagline_cn:     '食物源于食物。',
      credit_en:      'v1.0 · Built by your kitchen',
      credit_cn:      'v1.0 · 由您的厨房用心制作',
    };
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('brand.me_footer', ?)").run(JSON.stringify(rootsFooter));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_brand_me_footer_roots_v1');
  }
} catch (e) { console.error('[migration seed_brand_me_footer_roots_v1]', e); }

// Seed the customer-facing text for the store-move notice — shown at checkout
// when the location that WOULD have served an address is closed and a different
// one is fulfilling the order (see computeStoreMoveNotice in routes/retail.js).
//
// Only the two message strings are seeded here. The notice renders ONLY when
// every one of its six fields is set, so until an operator (or a later seed)
// fills in kicker/title it stays dark — which is deliberate: a notice must never
// appear half-written, and Chinese customer copy must never be machine-invented.
//
// INSERT OR IGNORE, so an operator's own wording is never overwritten. These
// name the shops because they are the OPERATOR'S text; the trigger that decides
// whether to show them names nothing and works for any pair of locations.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_notice_store_move_v1');
  if (!ran) {
    const put = db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)");
    put.run('notice.store_move.message_cn', JSON.stringify(
      '越秀门店暂时停业，您的订单将由天河中央厨房发出，送达时间可能会比平时稍长，敬请谅解。'
    ));
    put.run('notice.store_move.message_en', JSON.stringify(
      'Our Yuexiu store is temporarily closed. Your order will be sent from our Tianhe central kitchen, so delivery may take a little longer than usual.'
    ));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_notice_store_move_v1');
  }
} catch (e) { console.error('[migration seed_notice_store_move_v1]', e); }

// v2 — the remaining four fields, held back from v1 until the Chinese copy had
// been read by someone who speaks it. v1 seeded only the two message strings, and
// the notice renders only when all six are set, so it has been dark since it
// shipped. This is what turns it on.
//
// The title says 中央厨房 rather than 门店 because the message body calls the
// fulfilling location a 中央厨房, and a banner that called it a 门店 would
// contradict the sentence directly beneath it. The text is per-business config,
// so it is written to be ACCURATE for this business rather than reusable — the
// generic part is the trigger in routes/retail.js, which names no location at all.
//
// INSERT OR IGNORE, so an operator's own wording is never overwritten.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_notice_store_move_v2');
  if (!ran) {
    const put = db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)");
    put.run('notice.store_move.kicker_en', JSON.stringify('Delivery'));
    put.run('notice.store_move.kicker_cn', JSON.stringify('配送'));
    put.run('notice.store_move.title_en',  JSON.stringify('Sent from our central kitchen'));
    put.run('notice.store_move.title_cn',  JSON.stringify('改由中央厨房发出'));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_notice_store_move_v2');
  }
} catch (e) { console.error('[migration seed_notice_store_move_v2]', e); }

// v2 — self-heal pass. The v1 migration above uses INSERT OR IGNORE, which
// is a no-op when a brand.me_footer row already exists. If the operator
// clicked Save on an empty footer-settings card between the feature shipping
// and the v1 seed landing, that row exists but is all-nulls → v1 skipped →
// Roots' customers see the tacet SaaS fallbacks instead of their own
// branding. This pass replaces an all-empty row with the canonical Roots
// values; rows that have ANY real content (operator authored their own)
// are preserved untouched.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_brand_me_footer_roots_v2');
  if (!ran) {
    const existing = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'brand.me_footer'").get();
    let needsHeal = false;
    if (existing) {
      try {
        const v = JSON.parse(existing.value_json || '{}');
        needsHeal = !v.wordmark_image && !v.wordmark_text && !v.tagline_en && !v.tagline_cn && !v.credit_en && !v.credit_cn;
      } catch { needsHeal = true; }
    }
    if (needsHeal) {
      const rootsFooter = {
        wordmark_image: '/assets/brand/roots-wordmark.png',
        wordmark_text:  null,
        tagline_en:     'Food made from food.',
        tagline_cn:     '食物源于食物。',
        credit_en:      'v1.0 · Built by your kitchen',
        credit_cn:      'v1.0 · 由您的厨房用心制作',
      };
      db.prepare(
        "INSERT INTO storefront_config (key, value_json) VALUES ('brand.me_footer', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP"
      ).run(JSON.stringify(rootsFooter));
      console.log('[migration seed_brand_me_footer_roots_v2] healed empty Roots footer row');
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_brand_me_footer_roots_v2');
  }
} catch (e) { console.error('[migration seed_brand_me_footer_roots_v2]', e); }

// Seed a default ABOUT layout — the "Who we are" story page reached from
// the Me tab and from the Home tail. Two editorial blocks: the brand
// story up top, the promise below. Office can edit in /cms → About page.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_about_layout_v1');
  if (!ran) {
    const layout = [
      { id: 'ab1', type: 'spacer', height_px: 40 },
      {
        id: 'ab2', type: 'editorial', layout: 'image_top',
        kicker_en: 'NO. 11 · WHO WE ARE', kicker_cn: '第十一 · 关于我们',
        title_en: 'Food made from food.', title_cn: '食物源于食物。',
        body_en: 'Roots started in a small Guangzhou kitchen with one question: what if eating well felt like a celebration, not a sacrifice?\n\nWe cold-press, ferment, and bake — slow, raw, plant-forward. Every batch is small. Every ingredient earns its place.',
        body_cn: 'Roots 始于广州一间小厨房,源自一个问题:如果吃得健康也能像庆典一样令人愉悦,会怎样?\n\n我们冷压、发酵、烘焙——慢工出细活,生鲜,植物为本。每一批都不大,每一种原料都名副其实。',
        image_url: '', image_aspect: null,
      },
      {
        id: 'ab3', type: 'editorial', layout: 'text_only',
        kicker_en: 'OUR PROMISE', kicker_cn: '我们的承诺',
        title_en: 'From soil to soul.', title_cn: '从土壤到灵魂。',
        body_en: 'Real ingredients, traceable suppliers, recyclable packaging. No shortcuts, no powders pretending to be food. If we wouldn\'t feed it to our families, we won\'t sell it to yours.',
        body_cn: '真实的食材,可追溯的供应商,可回收的包装。不走捷径,不用假装成食物的粉末。我们不会给家人吃的东西,也不会卖给您。',
        image_url: '', image_aspect: null,
      },
      { id: 'ab4', type: 'spacer', height_px: 60 },
    ];
    const blob = JSON.stringify(layout);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('about.layout', ?)").run(blob);
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('cms.draft.about_layout', ?)").run(blob);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_about_layout_v1');
    console.log('[migration] seed_about_layout_v1 applied');
  }
} catch (e) { console.error('[migration seed_about_layout_v1]', e); }

// REPLACE about.layout with the full NO. 11 · WHO WE ARE design from
// screens/story.jsx — hero, manifesto, stat strip, founder card,
// IN/OUT promise grid, sign-off. v1 only seeded two generic editorial
// blocks as placeholders; v2 is the real designed flow.
// Only overwrites when the current layout still looks like the v1 seed
// (4 blocks, first editorial id = 'ab2'). If the office has already
// edited it via CMS, the new design is skipped — they'll need to add
// the new block types manually.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_about_layout_v2');
  if (!ran) {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'about.layout'").get();
    let current = [];
    try { current = row ? JSON.parse(row.value_json) : []; } catch {}
    const looksLikeV1 = Array.isArray(current) && current.length === 4
      && current[1] && current[1].id === 'ab2' && current[1].type === 'editorial';
    const isEmpty = !Array.isArray(current) || current.length === 0;
    if (looksLikeV1 || isEmpty) {
      const layout = [
        {
          id: 's_hero', type: 'hero_banner',
          image_url: '/assets/brand/welcome-roots.jpg',
          image_aspect: 1198 / 1085, height_px: 640,
          ctas: [],
        },
        {
          id: 's_manifesto', type: 'editorial', layout: 'text_only',
          kicker_en: 'WHO WE ARE', kicker_cn: '我们是谁',
          title_en: '', title_cn: '',
          body_en: 'We exist to make plant-based food so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
          body_cn: '我们存在的意义,是把植物食物做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
        },
        {
          id: 's_stats', type: 'stat_strip',
          value_color: 'lime-leaf',
          stats: [
            { value_en: '2017', value_cn: '2017',  label_en: 'EST.',      label_cn: '成立' },
            { value_en: '广州', value_cn: '广州',  label_en: 'MADE IN',   label_cn: '产地' },
            { value_en: '50+',  value_cn: '50+',   label_en: 'PRODUCTS',  label_cn: '产品' },
            { value_en: '100%', value_cn: '100%',  label_en: 'PLANT',     label_cn: '植物' },
          ],
        },
        {
          id: 's_founder', type: 'founder_card',
          kicker_en: 'MEET THE FOUNDER', kicker_cn: '创始人',
          image_url: '', tile_color: 'lime-leaf',
          name_en: 'Founder Name', name_cn: '创始人姓名',
          title_en: 'FOUNDER & CEO', title_cn: '创始人兼首席执行官',
          quote_en: 'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
          quote_cn: '我创立 Roots,是想证明植物从来不该是无聊的选择。',
          cta: { label_en: 'READ THE FULL STORY', label_cn: '阅读完整故事', target: '', style: 'link' },
        },
        {
          id: 's_promise', type: 'promise_in_out',
          kicker_en: 'OUR PROMISE', kicker_cn: '我们的承诺',
          title_in_en: 'in',  title_in_cn: '是',
          title_out_en: 'out', title_out_cn: '否',
          accent_color: 'lime-leaf',
          in_items: [
            { en: '100% plant-based',     cn: '100% 植物' },
            { en: 'Made from scratch',    cn: '原料自制' },
            { en: 'Real fermentation',    cn: '真发酵' },
            { en: 'Whole ingredients',    cn: '完整食材' },
            { en: 'Small batch',          cn: '小批量' },
            { en: 'Seasonal',             cn: '应季' },
            { en: 'Local-first · 广州',   cn: '本地优先' },
            { en: 'Recyclable packaging', cn: '可回收包装' },
          ],
          out_items: [
            { en: 'Preservatives',    cn: '防腐剂' },
            { en: 'Refined sugar',    cn: '精制糖' },
            { en: 'Artificial color', cn: '人造色素' },
            { en: 'Artificial flavor',cn: '人造香精' },
            { en: 'Additives',        cn: '添加剂' },
            { en: 'GMO',              cn: '转基因' },
            { en: 'Animal products',  cn: '动物产品' },
            { en: 'Cutting corners',  cn: '走捷径' },
          ],
        },
        {
          id: 's_outro', type: 'editorial', layout: 'text_only',
          kicker_en: '', kicker_cn: '',
          title_en: 'From soil to soul.', title_cn: '从土壤到灵魂。',
          body_en: '', body_cn: '',
          cta: { label_en: 'SHOP NOW', label_cn: '立即购买', target: 'shop', style: 'primary' },
        },
        { id: 's_tail', type: 'spacer', height_px: 40 },
      ];
      const blob = JSON.stringify(layout);
      db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('about.layout', ?)").run(blob);
      db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('cms.draft.about_layout', ?)").run(blob);
      console.log('[migration] seed_about_layout_v2: applied full story design');
    } else {
      console.log('[migration] seed_about_layout_v2: about.layout already customised — skipped');
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_about_layout_v2');
  }
} catch (e) { console.error('[migration seed_about_layout_v2]', e); }

// Append a small "Story" tail to home.layout pointing to /about, once.
// Read-modify-write rather than overwrite, so a curated home isn't lost.
// Skipped if home already has any editorial block (idempotent for re-runs
// and for layouts that already include the tail manually).
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_home_story_tail_v1');
  if (!ran) {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'home.layout'").get();
    let blocks = [];
    try { blocks = row ? JSON.parse(row.value_json) : []; } catch {}
    if (!Array.isArray(blocks)) blocks = [];
    const hasEditorial = blocks.some(b => b && b.type === 'editorial');
    if (!hasEditorial) {
      blocks.push({
        id: 'home_story_tail',
        type: 'editorial',
        layout: 'text_only',
        kicker_en: 'NO. 04 · STORY', kicker_cn: '第四 · 故事',
        title_en: 'Food made from food.', title_cn: '食物源于食物。',
        body_en: 'Roots started in a small Guangzhou kitchen — slow, raw, plant-forward.',
        body_cn: 'Roots 始于广州一间小厨房——慢工细作,生鲜,植物为本。',
        image_url: '', image_aspect: null,
        cta: { label_en: 'READ MORE', label_cn: '了解更多', target: 'about', style: 'secondary' },
      });
      const blob = JSON.stringify(blocks);
      db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('home.layout', ?)").run(blob);
      // Mirror into the draft slot so the CMS doesn't show "dirty" right away.
      const draftRow = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'cms.draft.home_layout'").get();
      let draft = [];
      try { draft = draftRow ? JSON.parse(draftRow.value_json) : []; } catch {}
      if (!Array.isArray(draft)) draft = [];
      if (!draft.some(b => b && b.type === 'editorial')) {
        draft.push(blocks[blocks.length - 1]);
        db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('cms.draft.home_layout', ?)").run(JSON.stringify(draft));
      }
      console.log('[migration] seed_home_story_tail_v1: appended editorial tail to home.layout');
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_home_story_tail_v1');
  }
} catch (e) { console.error('[migration seed_home_story_tail_v1]', e); }

// Replace the v1 home_story_tail (generic editorial) with the designed
// home-v5 "Brand story break" — full-bleed accent + IP overlay + 2-line
// headline + inline link. Only swaps if the existing block is the v1
// editorial we shipped; if the office has edited it, the swap is skipped.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_home_story_break_v1');
  if (!ran) {
    const story = {
      id: 'home_story_tail',
      type: 'story_break',
      bg_color: 'lime-leaf',
      ip_image: '/assets/brand/ip-kombucha-gang.jpg',
      kicker_en: 'NO. 03 · WHO WE ARE', kicker_cn: '第三 · 我们是谁',
      title_en: 'No fakers.\nNo fillers.', title_cn: '无虚假。\n无填料。',
      body_en: '100% plant. Made from scratch. Real ferment, real fruit, real veg.',
      body_cn: '100% 植物。原料自制。真发酵、真水果、真蔬菜。',
      link_label_en: 'READ THE STORY', link_label_cn: '阅读故事',
      link_target: 'about',
    };
    for (const key of ['home.layout', 'cms.draft.home_layout']) {
      const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = ?").get(key);
      if (!row) continue;
      let blocks = [];
      try { blocks = JSON.parse(row.value_json); } catch {}
      if (!Array.isArray(blocks)) continue;
      const idx = blocks.findIndex(b => b && b.id === 'home_story_tail' && b.type === 'editorial');
      if (idx === -1) continue;
      blocks[idx] = story;
      db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)").run(key, JSON.stringify(blocks));
      console.log(`[migration] seed_home_story_break_v1: swapped ${key} tail to story_break`);
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_home_story_break_v1');
  }
} catch (e) { console.error('[migration seed_home_story_break_v1]', e); }

// Retire the story content from CMS — the About page moved to a hardcoded
// mini app screen (pages/about/about) and is only reached from Me. Drop
// the home story tail from home.layout (+ draft) and delete the about
// page keys from storefront_config. One-shot, marker-guarded.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('retire_story_from_cms_v1');
  if (!ran) {
    // Strip home_story_tail from both the live home.layout and the draft.
    for (const key of ['home.layout', 'cms.draft.home_layout']) {
      const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = ?").get(key);
      if (!row) continue;
      let blocks = [];
      try { blocks = JSON.parse(row.value_json); } catch {}
      if (!Array.isArray(blocks)) continue;
      const next = blocks.filter(b => !(b && (b.id === 'home_story_tail' || b.type === 'story_break')));
      if (next.length !== blocks.length) {
        db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)").run(key, JSON.stringify(next));
        console.log(`[migration] retire_story_from_cms_v1: removed story tail from ${key}`);
      }
    }
    // Drop the About page from storefront_config entirely.
    const del = db.prepare("DELETE FROM storefront_config WHERE key IN ('about.layout', 'cms.draft.about_layout')");
    const r = del.run();
    if (r.changes) console.log(`[migration] retire_story_from_cms_v1: deleted ${r.changes} about.* config keys`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('retire_story_from_cms_v1');
  }
} catch (e) { console.error('[migration retire_story_from_cms_v1]', e); }

// Hard sweep — strip any remaining blocks of the retired story-page types
// (editorial / stat_strip / founder_card / promise_in_out / story_break)
// from every layout in storefront_config. Defensive: the prior migrations
// already pulled the known instances, but a draft saved in the window
// between deploys could still contain one and would fail validation now
// that these types are out of ALLOWED_BLOCK_TYPES.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('strip_retired_story_blocks_v1');
  if (!ran) {
    const RETIRED = new Set(['editorial', 'stat_strip', 'founder_card', 'promise_in_out', 'story_break']);
    const rows = db.prepare(
      "SELECT key, value_json FROM storefront_config WHERE key LIKE '%.layout' OR key LIKE 'cms.draft.%_layout'"
    ).all();
    const upd = db.prepare("UPDATE storefront_config SET value_json = ? WHERE key = ?");
    let touched = 0;
    for (const row of rows) {
      let blocks = [];
      try { blocks = JSON.parse(row.value_json); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      const next = blocks.filter(b => !(b && RETIRED.has(b.type)));
      if (next.length !== blocks.length) {
        upd.run(JSON.stringify(next), row.key);
        touched++;
      }
    }
    if (touched) console.log(`[migration] strip_retired_story_blocks_v1: cleaned ${touched} layout(s)`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('strip_retired_story_blocks_v1');
  }
} catch (e) { console.error('[migration strip_retired_story_blocks_v1]', e); }

// Seed default `about.content` so the admin editor opens to the designed
// copy on a fresh DB. Office can edit + save from retail-admin → About.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_about_content_v1');
  if (!ran) {
    const content = {
      kicker_en: 'WHO WE ARE',
      kicker_cn: '我们是谁',
      manifesto_en: 'We exist to make **plant-based food** so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
      manifesto_cn: '我们存在的意义,是把**植物食物**做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
      stats: [
        { value_en: '2017', value_cn: '2017', label_en: 'EST.',     label_cn: '成立' },
        { value_en: '广州', value_cn: '广州', label_en: 'MADE IN',  label_cn: '产地' },
        { value_en: '50+',  value_cn: '50+',  label_en: 'PRODUCTS', label_cn: '产品' },
        { value_en: '100%', value_cn: '100%', label_en: 'PLANT',    label_cn: '植物' },
      ],
      founder_kicker_en: 'MEET THE FOUNDER',
      founder_kicker_cn: '创始人',
      founder_name_en: 'Founder Name',
      founder_name_cn: '创始人姓名',
      founder_title_en: 'FOUNDER & CEO',
      founder_title_cn: '创始人兼首席执行官',
      founder_quote_en: 'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
      founder_quote_cn: '我创立 Roots,是想证明植物从来不该是无聊的选择。',
      founder_photo_url: '',
      promise_kicker_en: 'OUR PROMISE',
      promise_kicker_cn: '我们的承诺',
      in_items: [
        { en: '100% plant-based',     cn: '100% 植物' },
        { en: 'Made from scratch',    cn: '原料自制' },
        { en: 'Real fermentation',    cn: '真发酵' },
        { en: 'Whole ingredients',    cn: '完整食材' },
        { en: 'Small batch',          cn: '小批量' },
        { en: 'Seasonal',             cn: '应季' },
        { en: 'Local-first · 广州',   cn: '本地优先' },
        { en: 'Recyclable packaging', cn: '可回收包装' },
      ],
      out_items: [
        { en: 'Preservatives',     cn: '防腐剂' },
        { en: 'Refined sugar',     cn: '精制糖' },
        { en: 'Artificial color',  cn: '人造色素' },
        { en: 'Artificial flavor', cn: '人造香精' },
        { en: 'Additives',         cn: '添加剂' },
        { en: 'GMO',               cn: '转基因' },
        { en: 'Animal products',   cn: '动物产品' },
        { en: 'Cutting corners',   cn: '走捷径' },
      ],
      outro_en: 'From soil to soul.',
      outro_cn: '从土壤到灵魂',
      cta_en: 'SHOP NOW',
      cta_cn: '立即购买',
    };
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('about.content', ?)").run(JSON.stringify(content));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_about_content_v1');
    console.log('[migration] seed_about_content_v1 applied');
  }
} catch (e) { console.error('[migration seed_about_content_v1]', e); }

// Add `fees.standardShipping` to config. Charged when subtotal is below
// the free-shipping threshold and the customer picks Standard delivery
// (Same-day uses its own `fees.sameDayDelivery`). Lives in its own
// migration marker so existing DBs that were seeded via _v1 still pick it
// up on next boot.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_standard_shipping_v1');
  if (!ran) {
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('fees.standardShipping', ?)").run(JSON.stringify(12));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_standard_shipping_v1');
  }
} catch (e) { console.error('[migration seed_standard_shipping_v1]', e); }

// The free-shipping threshold a store falls back to when
// storefront_config['fees.freeShippingThreshold'] is missing entirely. It is
// seeded below, so a DB built through this file always has the row — but the
// readers need the same answer when it isn't there, and they used to disagree
// (399 seeded here, 199 assumed in two places in routes/retail.js, 399 again
// hardcoded in the mini-app cart). One definition, exported, so a store with
// no row can't be quoted one threshold and charged against another.
const FREE_SHIPPING_THRESHOLD_DEFAULT = 399;

// One-shot seed of storefront_config so a fresh DB has sensible defaults.
// Subsequent runs are no-ops via the _migrations marker — once admin edits
// land via the admin UI, seeding never overwrites them.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_storefront_config_v1');
  if (!ran) {
    const ins = db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)");
    const seed = [
      // Theme — accent name maps to a CSS var name client-side
      ['theme.accent',                JSON.stringify('lime-leaf')],
      ['theme.ipIntensity',           JSON.stringify('soft')],
      ['theme.language',              JSON.stringify('bilingual')],
      // Fees / thresholds
      ['fees.freeShippingThreshold',  JSON.stringify(FREE_SHIPPING_THRESHOLD_DEFAULT)],
      ['fees.standardShipping',       JSON.stringify(12)],
      ['fees.sameDayDelivery',        JSON.stringify(18)],
      ['fees.minOrder',               JSON.stringify(0)],
      // Home page composition — server picks featured products by id list
      ['home.heroImg',                JSON.stringify('')],
      ['home.ctaLabel',               JSON.stringify('SHOP')],
      ['home.sections',               JSON.stringify([
        { id: 'fresh',  kicker: "NO. 01 · FRESH",  title: "This week's juice",  type: 'hscroll',           productIds: [] },
        { id: 'browse', kicker: "NO. 02 · BROWSE", title: "Shop the garden",    type: 'categories' },
        { id: 'club',   kicker: "NO. 03 · ROOTS CLUB", title: "Grow with us.",  type: 'membership-promo' },
      ])],
      // Tab bar
      ['tabBar.theme',                JSON.stringify('oat')],
      ['tabBar.items',                JSON.stringify([
        { id: 'home', en: 'Home', cn: '首页' },
        { id: 'shop', en: 'Shop', cn: '商品' },
        { id: 'cart', en: 'Cart', cn: '购物车' },
        { id: 'me',   en: 'Me',   cn: '我的'   },
      ])],
    ];
    for (const [k, v] of seed) ins.run(k, v);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_storefront_config_v1');
    console.log(`[migration] seed_storefront_config_v1: seeded ${seed.length} config keys`);
  }
} catch (e) { console.error('[migration seed_storefront_config_v1]', e); }

// ─────────────────────────────────────────────────────────────────────────
// RETAIL DELIVERY / PACKING / POINTS / TOP-UP
//   delivery_zones        → per-GZ-district + per-other-city fee rules
//   topup_packages        → admin-managed top-up tiers (pay X, get X+bonus)
//   topup_transactions    → wallet top-up payment records
//   points_transactions   → points ledger (earn / redeem / bonus / adjust)
// retail_orders gains packing_fee, delivery_mode, delivery_zone_id, points_earned
// so a paid order's full fee breakdown survives forever.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_delivery_zones (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_type             TEXT NOT NULL,             -- 'gz_district' | 'city'
    name_en               TEXT,
    name_cn               TEXT,                      -- customer-facing label, e.g. '天河区' / '深圳市'
    match_city            TEXT,                      -- address.city must equal (for 'city') or be Guangzhou (for 'gz_district')
    match_district        TEXT,                      -- address.district must equal (only for gz_district rows)
    base_fee              REAL NOT NULL DEFAULT 0,   -- normal delivery fee
    max_fee               REAL,                      -- "MAX" cap option (NULL = not offered). GZ only.
    free_threshold        REAL,                      -- free delivery above this subtotal. NULL = no free option.
    packing_fee_per_item  REAL DEFAULT 0,            -- per-unit packing cost (used for 'city' rows)
    packing_fee_cap       REAL,                      -- max packing fee (NULL = no cap)
    is_active             INTEGER DEFAULT 1,
    sort_order            INTEGER DEFAULT 0,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_retail_dz_lookup ON retail_delivery_zones(zone_type, match_city, match_district, is_active);

  CREATE TABLE IF NOT EXISTS retail_topup_packages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    amount          REAL NOT NULL,                   -- ¥ user pays (credited to wallet 1:1)
    bonus_points    INTEGER NOT NULL DEFAULT 0,      -- extra points granted on success
    title_en        TEXT,
    title_cn        TEXT,
    description_en  TEXT,
    description_cn  TEXT,
    is_active       INTEGER DEFAULT 1,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS retail_topup_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL,
    package_id      INTEGER,
    amount          REAL NOT NULL,                   -- ¥ paid → credited to wallet
    bonus_points    INTEGER NOT NULL DEFAULT 0,      -- bonus points awarded on success
    payment_method  TEXT,                            -- wechat | alipay
    status          TEXT DEFAULT 'pending',          -- pending | success | failed | refunded
    out_trade_no    TEXT,
    transaction_id  TEXT,
    raw_callback_json TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at         DATETIME,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id)  REFERENCES retail_topup_packages(id)
  );
  CREATE INDEX IF NOT EXISTS idx_retail_topup_customer ON retail_topup_transactions(customer_id, status);
  CREATE INDEX IF NOT EXISTS idx_retail_topup_outtrade ON retail_topup_transactions(out_trade_no);

  -- "Forgot something?" add-on: stages items a customer adds to an EXISTING
  -- (already-paid) order and carries the top-up payment for the price
  -- difference. Mirrors retail_topup_transactions: rides the shared WeChat
  -- merchant ledger with its own 'FCAO…' out_trade_no so the async pay
  -- callback can tell it apart from an order ('FCR…') or a wallet top-up
  -- ('FCTU…'). items_json holds the server-resolved+priced lines; on success
  -- finalizeOrderAddon() injects them into retail_order_items and merges them
  -- into the order's un-dispatched parcel. Nothing touches the order until
  -- WeChat confirms the charge.
  CREATE TABLE IF NOT EXISTS retail_order_addons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL,
    customer_id     INTEGER NOT NULL,
    items_json      TEXT NOT NULL,                   -- staged resolved lines (server-priced)
    amount          REAL NOT NULL,                   -- ¥ price difference charged
    earn_points     INTEGER NOT NULL DEFAULT 0,      -- earn-points granted on success
    payment_method  TEXT,                            -- wechat
    status          TEXT DEFAULT 'pending',          -- pending | success | failed
    out_trade_no    TEXT,
    transaction_id  TEXT,
    raw_callback_json TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at         DATETIME,
    FOREIGN KEY (order_id)    REFERENCES retail_orders(id)    ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_order_addons_order ON retail_order_addons(order_id, status);
  CREATE INDEX IF NOT EXISTS idx_retail_order_addons_outtrade ON retail_order_addons(out_trade_no);

  CREATE TABLE IF NOT EXISTS retail_points_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL,
    delta           INTEGER NOT NULL,                -- + earned, − redeemed
    balance_after   INTEGER NOT NULL,
    source          TEXT NOT NULL,                   -- order_earn | order_redeem | topup_bonus | admin_adjust | refund_reverse
    order_id        INTEGER,
    topup_id        INTEGER,
    note            TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id)    REFERENCES retail_orders(id),
    FOREIGN KEY (topup_id)    REFERENCES retail_topup_transactions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_retail_pts_customer ON retail_points_transactions(customer_id, created_at);
`);

// "Forgot something?" add-ons net freed shipping off the charge: when the added
// items push an order's subtotal over the free-shipping threshold, the base
// delivery fee that's now waived is subtracted from what the customer pays for
// the add-on (tender-agnostic — no separate refund, which matters because there
// is no Alipay refund API). addon_subtotal = the real items value (bumps the
// order subtotal); freed_shipping = the base delivery waived (reduces the order
// shipping_fee); `amount` stays the gateway charge = addon_subtotal − freed_shipping.
addColumn('retail_order_addons', 'addon_subtotal', 'REAL');
addColumn('retail_order_addons', 'freed_shipping', 'REAL DEFAULT 0');

// ─── Customer migration credits (OUT1N → roots) ───────────────────────────
// Staging table for the one-time migration of wallet balance + points from
// the legacy OUT1N store. We can't pre-create retail_customers rows (openid is
// UNIQUE NOT NULL and we don't have openids), so balances wait here keyed by
// PHONE and are CLAIMED the moment a customer's phone is known (login if a
// phone is already on file, or when they set/confirm it). claimMigrationCredit()
// in routes/retail.js applies a row atomically and stamps claimed_at, so each
// phone is credited exactly once. Phone is normalized to bare digits (no +/86).
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_migration_credits (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone               TEXT NOT NULL UNIQUE,
    balance             REAL NOT NULL DEFAULT 0,
    points              INTEGER NOT NULL DEFAULT 0,
    source_uid          TEXT,                    -- OUT1N User ID, for audit
    name                TEXT,                    -- OUT1N display name, reference only
    claimed_at          DATETIME,                -- NULL = unclaimed
    claimed_customer_id INTEGER,                 -- retail_customers.id once claimed
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (claimed_customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_migr_unclaimed ON retail_migration_credits(phone) WHERE claimed_at IS NULL;
`);

// ─── Phone-less migration credits (manual / operator-credited) ─────────────
// OUT1N customers who hold balance/points but have NO phone on file (WeChat-
// only) — and no openid we can obtain — so the phone-claim path can't reach
// them. Preserved here as the canonical record; an operator credits them by
// hand (existing points-adjust / wallet-adjust on the customer) when the
// customer is identified, then stamps credited_at. Keyed by OUT1N uid.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_migration_unmatched (
    uid                 TEXT PRIMARY KEY,        -- OUT1N User ID
    name                TEXT,                    -- OUT1N display name (21/120 have one)
    balance             REAL NOT NULL DEFAULT 0,
    points              INTEGER NOT NULL DEFAULT 0,
    credited_at         DATETIME,                -- NULL = outstanding
    credited_customer_id INTEGER,                -- retail_customers.id once credited
    note                TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Order-level columns for the new fee model. Each added idempotently so
// existing DBs migrate cleanly without dropping data.
addColumn('retail_orders', 'packing_fee',      'REAL DEFAULT 0');
addColumn('retail_orders', 'delivery_mode',    "TEXT");                 // 'standard' | 'max' (GZ) | 'fixed' (city) | 'sameday' (legacy)
addColumn('retail_orders', 'delivery_zone_id', 'INTEGER');
addColumn('retail_orders', 'points_earned',    'INTEGER DEFAULT 0');
// Routing transparency: 1 = fulfilling store chosen by real GPS distance,
// 0 = coarse fallback (zone/district/sort_order) because the address had no
// coordinates to measure, NULL = not applicable (pickup, out-of-city pin,
// admin-created, or pre-feature orders). Ops surface the 0 case as a warning.
addColumn('retail_orders', 'routed_by_distance', 'INTEGER');

// Delivery scheduling. NULL scheduled_for = "right away" (deliver as soon as
// the kitchen can). When set, contains the earliest time the customer wants
// the order. delivery_slot_label snapshots the human-readable picker label
// at order time ("Tomorrow 10:00–12:00") so historical orders stay readable
// even if the slot definition is later edited. same_day_surcharge_fee captures
// any per-zone surcharge paid for same-day delivery (Panyu-style).
addColumn('retail_orders', 'scheduled_for',         'DATETIME');
addColumn('retail_orders', 'delivery_slot_label',   'TEXT');
addColumn('retail_orders', 'same_day_surcharge_fee', 'REAL DEFAULT 0');

// Per-zone delivery scheduling config. same_day_allowed=0 forces the
// customer to pick a future slot (min_lead_days kicks in). same_day_surcharge
// > 0 means same-day is gated behind a per-order fee (Panyu pattern).
// Slot hours/duration drive the time-slot enumerator on the checkout page.
addColumn('retail_delivery_zones', 'same_day_allowed',      'INTEGER DEFAULT 1');
addColumn('retail_delivery_zones', 'same_day_surcharge',    'REAL DEFAULT 0');
addColumn('retail_delivery_zones', 'min_lead_days',         'INTEGER DEFAULT 0');
addColumn('retail_delivery_zones', 'max_lead_days',         'INTEGER DEFAULT 14');
addColumn('retail_delivery_zones', 'slot_start_hour',       'INTEGER DEFAULT 10');
addColumn('retail_delivery_zones', 'slot_end_hour',         'INTEGER DEFAULT 20');
addColumn('retail_delivery_zones', 'slot_duration_minutes', 'INTEGER DEFAULT 120');
// day_only = 1 means the customer picks a DELIVERY DAY (no hour slots). Used
// for outer-GZ districts (Panyu / Conghua / Nansha) and all non-GZ cities.
// Combined with same_day_surcharge it gives the Panyu spec:
//   • Today  → base_fee + same_day_surcharge (e.g. ¥15 + ¥10 = ¥25)
//   • Tomorrow / +2 / +3 → base_fee only
addColumn('retail_delivery_zones', 'day_only', 'INTEGER DEFAULT 0');

// Per-area courier weight pricing (首重/续重). When BOTH are set, this zone
// charges weight_first_kg_fee for the first kilogram + weight_extra_kg_fee per
// additional started kg, instead of the flat base_fee — the standard rate-table
// model where each area prices by parcel weight. NULL (default) = flat pricing,
// so every existing zone is unchanged. base_fee stays the fallback when a cart's
// products have no parseable weight.
addColumn('retail_delivery_zones', 'weight_first_kg_fee', 'REAL');
addColumn('retail_delivery_zones', 'weight_extra_kg_fee', 'REAL');

// Non-GZ default: 3-day lead AND day-only. Bump existing rows once so admins
// don't have to touch every city. Idempotent.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('delivery_scheduling_v1');
  if (!ran) {
    db.prepare(`UPDATE retail_delivery_zones SET min_lead_days = 3 WHERE zone_type = 'city' AND (min_lead_days IS NULL OR min_lead_days = 0)`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('delivery_scheduling_v1');
  }
} catch (e) { console.warn('[migrate] delivery_scheduling_v1:', e.message); }

// City zones are always day-only; flip the flag on once.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('delivery_day_only_cities_v1');
  if (!ran) {
    db.prepare(`UPDATE retail_delivery_zones SET day_only = 1 WHERE zone_type = 'city'`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run('delivery_day_only_cities_v1');
  }
} catch (e) { console.warn('[migrate] delivery_day_only_cities_v1:', e.message); }

// Per-batch points expiration. Stamped on the row at earn time so each
// batch knows its own TTL — admin can override per grant. NULL = never
// expires (used for ledger rows that aren't earns: redeems, expiries).
// Existing rows stay NULL so legacy balances are grandfathered.
addColumn('retail_points_transactions', 'expires_at', 'DATETIME');
addColumn('retail_points_transactions', 'expired_at', 'DATETIME');  // when this earn was swept by sweepExpiredPoints
// "expiry" source is added to the comment-only domain — no schema CHECK to update.

// Seed delivery/points/topup config keys. One-shot — admin edits in the
// Delivery tab persist normally.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_delivery_points_v1');
  if (!ran) {
    const ins = db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)");
    // Earn rule: customers earn `earnPoints` points per `earnSpend` yuan
    // spent. Default = 1 point per ¥100. Legacy single-sided key earnRate
    // (= yuan per point) is kept for backward compatibility and is read
    // as a fallback by pointsEarnedFor() when the new pair is absent.
    ins.run('points.earnPoints',              JSON.stringify(1));
    ins.run('points.earnSpend',               JSON.stringify(100));
    ins.run('points.earnRate',                JSON.stringify(100));
    // Which amount earns points: 'paid' = net total after discounts (default,
    // points track real spend), 'subtotal' = goods value before discounts.
    ins.run('points.earnBase',                JSON.stringify('paid'));
    // 1 point = ¥1 when redeeming. redeemRate is "points per ¥1".
    ins.run('points.redeemRate',              JSON.stringify(1));
    // Points expire N months after earn. 0 = never expire. Admin can change
    // on the Top-up tab. Existing earn rows stay NULL → grandfathered.
    ins.run('points.expiryMonths',            JSON.stringify(12));
    // Used when a matched zone has no free_threshold set.
    ins.run('delivery.defaultFreeThreshold',  JSON.stringify(399));
    // Customer-facing copy for the kitchen, surfaced in the mini app
    // delivery-address screen + checkout error message when no zone matches.
    ins.run('delivery.kitchenAddress',        JSON.stringify('广州市天河区 (Roots Kitchen)'));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_delivery_points_v1');
    console.log('[migration] seed_delivery_points_v1: seeded points + delivery defaults');
  }
} catch (e) { console.error('[migration seed_delivery_points_v1]', e); }

// Backfill points.expiryMonths on databases that ran seed_delivery_points_v1
// before this key existed. INSERT OR IGNORE so it's a no-op once present.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_points_expiry_v1');
  if (!ran) {
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('points.expiryMonths', JSON.stringify(12));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_points_expiry_v1');
    console.log('[migration] seed_points_expiry_v1: backfilled points.expiryMonths default');
  }
} catch (e) { console.error('[migration seed_points_expiry_v1]', e); }

// Backfill the two-sided earn-rule keys (earnPoints + earnSpend) from the
// legacy single-sided earnRate. Live behavior is preserved: if earnRate=X,
// the new pair becomes (1 point per ¥X). INSERT OR IGNORE so manually-set
// values are never overwritten.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_points_earn_pair_v1');
  if (!ran) {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'points.earnRate'").get();
    let legacy = 100;
    try { legacy = Math.max(1, parseInt(JSON.parse(row?.value_json ?? '100'), 10) || 100); } catch {}
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('points.earnPoints', JSON.stringify(1));
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('points.earnSpend', JSON.stringify(legacy));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_points_earn_pair_v1');
    console.log(`[migration] seed_points_earn_pair_v1: backfilled earnPoints=1 earnSpend=${legacy}`);
  }
} catch (e) { console.error('[migration seed_points_earn_pair_v1]', e); }

// Backfill points.earnBase on databases seeded before it existed. 'paid' makes
// points earn on the net total the customer actually paid (after voucher +
// points discounts) rather than the pre-discount goods subtotal. INSERT OR
// IGNORE so an operator who already set 'subtotal' is never overwritten.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_points_earn_base_v1');
  if (!ran) {
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('points.earnBase', JSON.stringify('paid'));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_points_earn_base_v1');
    console.log('[migration] seed_points_earn_base_v1: backfilled points.earnBase=paid');
  }
} catch (e) { console.error('[migration seed_points_earn_base_v1]', e); }

// ─────────────────────────────────────────────────────────────────────────
// DUAL-LOCATION RETAIL INVENTORY (Phase 1)
//   retail_stores             → physical stores (Tianhe, future Pudong, …)
//   retail_store_stock        → per-store per-product stock with layers
//                               (physical, safety buffer, channel quotas)
//   retail_stock_reservations → soft-reserves on order, expire if unpaid
//   retail_stock_ledger       → append-only audit log of every movement
// retail_orders gains store_id, routing_reason, channel so each paid order
// remembers which store fulfilled it and why.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_stores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE NOT NULL,     -- short slug, e.g. 'tianhe'
    name_en         TEXT,
    name_cn         TEXT,
    address         TEXT,
    city            TEXT,                     -- the store's home city, e.g. '广州'
    district        TEXT,                     -- the store's home district, e.g. '天河区'
    lat             REAL,
    lng             REAL,
    phone           TEXT,
    meituan_account_id TEXT,                  -- Meituan merchant id for future sync
    is_active       INTEGER DEFAULT 1,
    sort_order      INTEGER DEFAULT 0,        -- routing priority — lower = preferred
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS retail_store_stock (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    physical_qty    INTEGER NOT NULL DEFAULT 0,   -- actual count at the store
    safety_buffer   INTEGER NOT NULL DEFAULT 0,   -- held back from any channel
    wechat_quota    INTEGER,                       -- NULL = no sub-cap (use global)
    meituan_quota   INTEGER,                       -- NULL = no sub-cap
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, product_id),
    FOREIGN KEY (store_id)   REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_store_stock_store   ON retail_store_stock(store_id);
  CREATE INDEX IF NOT EXISTS idx_retail_store_stock_product ON retail_store_stock(product_id);

  CREATE TABLE IF NOT EXISTS retail_stock_reservations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    order_id        INTEGER,                       -- nullable for pre-order holds
    qty             INTEGER NOT NULL,
    channel         TEXT NOT NULL DEFAULT 'wechat',   -- wechat | meituan | pos | walkin
    status          TEXT NOT NULL DEFAULT 'active',    -- active | committed | released | expired
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    committed_at    DATETIME,
    released_at     DATETIME,
    note            TEXT,
    FOREIGN KEY (store_id)   REFERENCES retail_stores(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (order_id)   REFERENCES retail_orders(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_res_active ON retail_stock_reservations(store_id, product_id, status);
  CREATE INDEX IF NOT EXISTS idx_retail_res_order  ON retail_stock_reservations(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_res_expiry ON retail_stock_reservations(status, expires_at);

  CREATE TABLE IF NOT EXISTS retail_stock_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    delta           INTEGER NOT NULL,                  -- + restock, − deduct
    reason          TEXT NOT NULL,                     -- order_commit | restock | transfer_in | transfer_out | waste | adjust
    ref_table       TEXT,
    ref_id          INTEGER,
    balance_after   INTEGER NOT NULL,                  -- physical_qty after this change
    actor_user_id   INTEGER,
    channel         TEXT,                              -- wechat/meituan/pos/walkin if applicable
    note            TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id)     REFERENCES retail_stores(id),
    FOREIGN KEY (product_id)   REFERENCES products(id)
    -- NOTE: actor_user_id is deliberately NOT an FK. It records WHO made a
    -- movement, but the actor can be a kitchen users(id) OR a Mini App Backend
    -- operator's tenant_users(id) — two id spaces. A hard FK to users(id)
    -- rejected every operator-driven write (same trap as retail_vouchers.
    -- created_by). It stays a plain audit integer; see drop_ledger_actor_fk_v1.
  );
  CREATE INDEX IF NOT EXISTS idx_retail_ledger_lookup ON retail_stock_ledger(store_id, product_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_retail_ledger_ref    ON retail_stock_ledger(ref_table, ref_id);
`);

// Order-level routing context. Each paid order remembers which store
// fulfilled it (store_id), why that store was chosen (routing_reason),
// and which sales channel placed it (channel). Idempotent ALTERs.
addColumn('retail_orders', 'store_id',        'INTEGER');
addColumn('retail_orders', 'routing_reason',  'TEXT');   // 'nearest' | 'fallback_no_stock' | 'manual' | 'only_store' | 'customer_pickup'
addColumn('retail_orders', 'channel',         "TEXT DEFAULT 'wechat'");
// Read-only channels (Meituan 外卖/闪购) carry their OWN order lifecycle that we
// don't own — the merchant fulfils on Meituan's side. We mirror the platform's
// current status label verbatim (e.g. 拣货中 / 配送中 / 已完成 / 已取消) so the
// combined Orders list shows the real Meituan status instead of a fixed "Paid".
// channel_status = the platform's Chinese status desc; refreshed each daemon poll.
addColumn('retail_orders', 'channel_status',    'TEXT');
addColumn('retail_orders', 'channel_status_at', 'DATETIME');
// Platform-promised delivery ETA (Meituan estimateArrivalTime), stored UTC
// 'YYYY-MM-DD HH:MM:SS' like the other timestamps so the admin renders it in
// store-local time. Read-only channels have no waybill/rider ETA of our own.
addColumn('retail_orders', 'channel_eta',       'DATETIME');
// The customer booked this order for a later window instead of "as soon as
// possible" (Meituan 预订单, basicVo.isPreOrder). Holds the START of the booked
// delivery window (deliveryBtime), stored UTC like channel_eta. NULL = a normal
// order to prepare now. Without it a pre-order is indistinguishable from an
// order due immediately, and the kitchen packs it hours early.
addColumn('retail_orders', 'channel_preorder_at', 'DATETIME');

// ── The rest of what a channel order already tells us ────────────────────────
// Everything below is read out of the SAME Meituan order-list response the
// daemons already fetch (lib/meituan-order-fields.js) — no extra call, no extra
// exposure. Until now the entire 26KB envelope was reduced to a status label, an
// ETA and a gross total, and every fact here was thrown away at parse time.
//
// Money. `total` is what the CUSTOMER paid and stays that. What we actually earn
// was nowhere: Meituan takes a commission and the fees split three ways, so a
// ¥65 order settles at ¥61.75. subtotal / shipping_fee / packing_fee (existing
// columns) now carry the 商品金额 / 配送费 / 打包袋 split instead of a lump sum.
addColumn('retail_orders', 'channel_commission',   'REAL');  // 平台服务费 taken by Meituan
addColumn('retail_orders', 'channel_settle_amount','REAL');  // 预计收入 — what lands with us
addColumn('retail_orders', 'channel_discount',     'REAL');  // merchant-funded activity spend
// Rider. Meituan's own fleet carries these orders, so this is the only delivery
// record that exists for them — our own dispatch columns were always empty.
// channel_rider_status_code is Meituan's numeric logistics state (40 = 已送达),
// kept beside the phrase because a code survives their wording changes.
addColumn('retail_orders', 'channel_rider_name',        'TEXT');
addColumn('retail_orders', 'channel_rider_status',      'TEXT');
addColumn('retail_orders', 'channel_rider_status_code', 'INTEGER');
addColumn('retail_orders', 'channel_rider_assigned_at', 'DATETIME'); // a rider took the job
addColumn('retail_orders', 'channel_rider_fetched_at',  'DATETIME'); // collected from the store
// Customer. wm_user_id is the ONLY stable customer identity Meituan gives a
// merchant — the same value across that person's orders — so repeat business on
// the channel becomes countable for the first time. TEXT: the ids run past 2^53.
// channel_customer_orders is their lifetime order count as Meituan reports it
// ("下单155次"), a fact we cannot derive ourselves because we only see the orders
// that arrived after this daemon existed.
addColumn('retail_orders', 'channel_customer_id',     'TEXT');
addColumn('retail_orders', 'channel_customer_orders', 'INTEGER');
// Delivery geography. The street address is masked by Meituan and un-masking it
// would cost a second, privacy-gated request per order (deliberately not done —
// see lib/meituan-order-fields.js). Distance + drop coordinates come free in the
// same payload and answer the same questions.
addColumn('retail_orders', 'channel_distance_m', 'INTEGER');
addColumn('retail_orders', 'channel_dest_lat',   'REAL');
addColumn('retail_orders', 'channel_dest_lng',   'REAL');
// Meituan's own listing id for a line. Their stable per-listing key: name
// matching and the "(1-380)" SKU token embedded in a title are both merchant-
// typed and both have lost lines before. Recorded now so a future resolver can
// key on the id instead — collecting it costs nothing and cannot be backfilled.
addColumn('retail_order_items', 'channel_food_id', 'TEXT');

// How many units of the product ONE of this line took off the shelf. 1 for
// everything sold as itself; more when the channel option was a pack — Meituan
// and Eleme both sell "咖啡大师 Oatly Barista" as 1瓶 / 3瓶 / 6瓶 behind one
// listing, and a sale of the last one is six bottles.
//
// Stored on the line rather than looked up at refund time: the claim that says
// "this option is six" can be re-pointed or released later, and a return has to
// give back what the sale actually took, not what the mapping says today. qty
// stays what the customer bought — one six-pack is one line of one.
addColumn('retail_order_items', 'pack_units', 'INTEGER NOT NULL DEFAULT 1');

// Store pickup: a store is offered as a pickup point at checkout only when
// this flag is on (admin toggles it per store in the mini-app backend).
// Independent of is_active routing — a store can fulfill deliveries without
// accepting walk-in pickup, and vice versa.
addColumn('retail_stores', 'pickup_enabled', 'INTEGER DEFAULT 0');

// Per-store opening hours ('HH:MM' local, both set or both NULL = always open).
// Captured by the Add-location wizard; replaces meituan-daemon's hardcoded
// STORE_HOURS map once the daemon is migrated to read these (worker phase).
addColumn('retail_stores', 'open_time', 'TEXT');
addColumn('retail_stores', 'close_time', 'TEXT');
// IANA timezone (e.g. 'Asia/Shanghai') the store's open/close hours are in, so
// checkout validates a pickup time against the store's LOCAL clock rather than
// the UTC+8 host. NULL = fall back to host-local (unchanged for China stores).
addColumn('retail_stores', 'timezone', 'TEXT');
// Per-store low-stock threshold (units). A product at this store is flagged
// "low" when its shelf qty is >0 and at/under this number. NULL = fall back to
// the tenant-wide default (storefront_config 'inventory.lowStockThreshold', 5).
// A product's own low_stock_threshold still wins over both.
addColumn('retail_stores', 'low_stock_threshold', 'INTEGER');

// Staff "seen" timestamp — stamped the first time ANY operator opens the
// order detail (shared across devices). NULL = unread; powers the bold + dot
// "unread until opened" treatment in the backend Orders list. On the deploy
// that first adds the column, backfill existing orders as already-seen so only
// orders placed AFTER this point show as unread. Guarded by a column-exists
// check so a later restart can't re-clear genuine unread flags.
{
  const hadSeenAt = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('retail_orders') WHERE name = 'seen_at'").get().n > 0;
  addColumn('retail_orders', 'seen_at', 'DATETIME');
  if (!hadSeenAt) {
    db.prepare("UPDATE retail_orders SET seen_at = COALESCE(placed_at, datetime('now')) WHERE seen_at IS NULL").run();
  }
}

// When the CUSTOMER last redirected this order to a different address from the
// mini app / web store (see the address-change endpoints in routes/retail.js).
// NULL = the ship-to is still the one they checked out with. Drives the "moved
// by the customer" line in the backend order drawer, so an operator who already
// read (or printed) the old ship-to knows to look again.
addColumn('retail_orders', 'address_changed_at', 'DATETIME');

// Outbound logistics — populated when staff (or the JD API, once wired)
// attaches a carrier + waybill to a dispatched order. tracking_events_json
// is the cached carrier feed so the customer mini app can render the
// timeline without re-hitting the upstream API on every load. tracking_status
// is the normalized code (see lib/tracking.js) so EN/CN labels can be
// rendered without parsing Chinese free-text events.
addColumn('retail_orders', 'tracking_carrier',     'TEXT');     // 'jd' | 'sf' | 'yto' | 'sto' | 'zto' | 'yunda' | 'ems' | 'other'
addColumn('retail_orders', 'tracking_number',      'TEXT');
addColumn('retail_orders', 'tracking_status',      'TEXT');     // normalized code: placed | picked_up | in_transit | out_for_delivery | delivered | exception | returning | returned
addColumn('retail_orders', 'tracking_events_json', 'TEXT');     // [{ time, status, location, description_cn }]
addColumn('retail_orders', 'tracking_synced_at',   'DATETIME');
addColumn('retail_orders', 'tracking_last_error',  'TEXT');
addColumn('retail_orders', 'tracking_kd100_subscribed', 'INTEGER DEFAULT 0');
// Delivery-scenario classification computed from the latest event's
// Chinese context. `tracking_scenario` is the typed code (pickup_point,
// locker, left_at_door, in_person, proxy, no_contact, out_for_delivery)
// and `tracking_scenario_data_json` carries the extracted bits (pickup
// code, signer name, location label). `tracking_scenario_notified` is
// the last scenario we pushed a subscribe-message for, so the customer
// doesn't get pinged twice for the same transition.
addColumn('retail_orders', 'tracking_scenario',           'TEXT');
addColumn('retail_orders', 'tracking_scenario_data_json', 'TEXT');
addColumn('retail_orders', 'tracking_scenario_notified',  'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_retail_orders_tracking_number ON retail_orders(tracking_number)');

// ── Warehouse / packing flags on products ──────────────────────────
// `ship_modes` is a comma-separated subset of {'air','land'}. Most items
// can go both ways (default 'air,land'); items rejected by airlines
// (liquids, lithium, frozen) should be set to 'land' only; items the
// kitchen wants to send rapidly (perishable, premium) can be set to
// 'air' only. `needs_ice_pack` triggers the cold-chain badge in retail-
// admin so the packer pulls ice from the freezer.
addColumn('products', 'ship_modes',     "TEXT DEFAULT 'air,land'");
addColumn('products', 'needs_ice_pack', 'INTEGER DEFAULT 0');

// ── Supplier-direct (drop-ship) flag ────────────────────────────────
// Marks products the supplier ships STRAIGHT to the customer rather than
// through our warehouse. When set, the fact is surfaced across the whole
// chain: the customer sees it on the product page + their order (and gets a
// one-time "ships separately, may take longer" notice on payment), and the
// warehouse packing slip + the backend order drawer flag the line so nobody
// tries to pull it from our own stock.
addColumn('products', 'ship_from_supplier', 'INTEGER DEFAULT 0');

// ── Batch-made (fresh) flag ─────────────────────────────────────────
// Marks short-shelf-life items (fresh meals, wraps) the kitchen makes on a
// fixed every-N-days cadence. Outside-Guangzhou orders containing one must
// wait for the next production batch so they ship the day they're made (an
// out-of-GZ parcel arrives next-day, eating the shelf life otherwise). The
// cadence itself lives in storefront_config['batch.schedule'].
addColumn('products', 'is_batch_made', 'INTEGER DEFAULT 0');

// Per-product out-of-stock policy — who may still order once stock hits 0:
//   'strict' (default/NULL) → not orderable in ANY region; the card shows a
//            hard SOLD OUT and the server refuses the order everywhere.
//   'backorder_gz'          → out-of-city shoppers may still pre-order (badge
//            现订现发 / SHIPS SOON, or 下批现做 / NEXT BATCH for batch meals);
//            only same-day Guangzhou stays hard-blocked. This generalises the
//            legacy is_batch_made rule to any product the operator chooses.
// NULL is treated as 'strict' UNLESS is_batch_made=1 (legacy back-compat).
addColumn('products', 'oos_policy', 'TEXT');

// Promised production + arrival dates stamped on outside-GZ orders that hold
// a batch-made item (YYYY-MM-DD). Drives the customer notice + the operator's
// "make on this day" cue in the Mini App Backend.
addColumn('retail_orders', 'promised_ship_date',     'TEXT');
addColumn('retail_orders', 'promised_delivery_date', 'TEXT');

// How the customer picked their delivery timing, captured at checkout:
// 'express' (out-of-GZ "as soon as possible", the day-only default),
// 'today' / 'right_away' (GZ same-day), 'schedule' (a deliberate future date),
// 'restock' (ships when restocked), or 'pickup'. NULL on legacy orders placed
// before this column existed. Lets the Mini App Backend tell an Express order
// (no specific date wanted → show a send-by deadline) apart from a customer
// who actually booked a calendar day (→ show that date).
addColumn('retail_orders', 'delivery_slot_kind', 'TEXT');

// Aliyun "package delivered" SMS — idempotency stamp so the every-60s
// auto-deliver sweep and a manual "Mark delivered" can't double-send. Stamped
// once when the delivered-notice SMS is dispatched (out-of-GZ orders only).
addColumn('retail_orders', 'sms_delivered_sent_at', 'DATETIME');

// Manual-Alipay payment proof: when the operator can't take 当面付 yet (open-
// platform 入驻 blocked), Alipay orders fall back to a static收款码 the customer
// scans + pays, then uploads the payment screenshot here. Staff eyeball it and
// hit "Mark paid". Single latest screenshot (data URL); re-upload overwrites.
addColumn('retail_orders', 'alipay_proof_image', 'TEXT');
addColumn('retail_orders', 'alipay_proof_at',    'DATETIME');
// Vision-AI read of the uploaded proof: verdict ('match'|'mismatch'|'error'),
// the extracted fields (JSON: amount/payee/paid_at/txn_id/reasons), and the
// payment txn-id pulled out for cross-order reuse dedup (an old/duplicate
// screenshot whose txn-id already settled another order is rejected).
addColumn('retail_orders', 'alipay_ocr_verdict', 'TEXT');
addColumn('retail_orders', 'alipay_ocr_json',    'TEXT');
addColumn('retail_orders', 'alipay_txn_id',      'TEXT');
// sha256 of the uploaded screenshot — the primary reuse guard for auto-flip
// (most Alipay success screens show no txn-id, so we dedup the image itself:
// the exact same screenshot can't settle two different orders).
addColumn('retail_orders', 'alipay_proof_hash',  'TEXT');

// Cloud-printer (Feie) auto-print outcome, so the backend can show whether a
// slip actually printed and offer a one-click reprint instead of the operator
// guessing. null = never attempted; 'printed' = Feieyun accepted the job;
// 'failed' = no printer resolved / Feieyun rejected / network error.
addColumn('retail_orders', 'print_status', 'TEXT');
addColumn('retail_orders', 'printed_at',   'DATETIME');
addColumn('retail_orders', 'print_error',  'TEXT');

// Snapshot the packing flags on each order item so later product edits
// don't rewrite what the warehouse was instructed to do.
addColumn('retail_order_items', 'ship_modes',     'TEXT');
addColumn('retail_order_items', 'needs_ice_pack', 'INTEGER DEFAULT 0');
addColumn('retail_order_items', 'shipment_id',    'INTEGER');
// Snapshot the product's supplier-direct (drop-ship) flag at order time so a
// later product edit can't rewrite how a past order was fulfilled/displayed.
addColumn('retail_order_items', 'ship_from_supplier', 'INTEGER DEFAULT 0');

// ── retail_shipments ───────────────────────────────────────────────
// Formal split-shipment table. An order can fan out into 1 or 2 (or
// theoretically more) shipments. Common case: when destination is
// outside Guangzhou and the items mix air-shippable + land-only, we
// create two shipments — each with its own carrier, waybill, status,
// and kd100 subscription. In-GZ orders and uniform-mode orders use a
// single shipment. The legacy `retail_orders.tracking_*` columns are
// preserved for back-compat and mirror the *primary* shipment.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_shipments (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id                    INTEGER NOT NULL,
    mode                        TEXT NOT NULL,          -- 'local' | 'air' | 'land'
    label                       TEXT,                   -- human-friendly for the office UI
    tracking_carrier            TEXT,
    tracking_number             TEXT,
    tracking_status             TEXT,
    tracking_events_json        TEXT,
    tracking_synced_at          DATETIME,
    tracking_last_error         TEXT,
    tracking_kd100_subscribed   INTEGER DEFAULT 0,
    tracking_scenario           TEXT,
    tracking_scenario_data_json TEXT,
    tracking_scenario_notified  TEXT,
    dispatched_at               DATETIME,
    delivered_at                DATETIME,
    created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_shipments_order ON retail_shipments(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_shipments_tracking ON retail_shipments(tracking_number);
`);

// Local (same-city / Guangzhou) delivery has no waybill — there's nothing to
// track via a carrier. Instead the operator sets a same-day estimated arrival
// time the customer sees on their order page. Stored as a 24h "HH:MM" string on
// the 'local' shipment row (NULL = no ETA set yet). Only ever set on local
// shipments; air/land parcels use tracking_number instead.
addColumn('retail_shipments', 'local_eta', 'TEXT');

// Where local_eta came from: 'auto' = stamped by the Qingyun daemon from the
// courier's promised arrival time (expected_delivery_at); 'manual' = an operator
// typed/edited it by hand. The daemon only auto-fills/refreshes when this is NOT
// 'manual', so an operator override permanently wins. NULL = never set (treated
// as auto-fillable). See scripts/qingyun-daemon.js stampLocalEta.
addColumn('retail_shipments', 'eta_source', 'TEXT');

// 一单多件 — how many physical boxes this waybill was created for (staff enters
// this when the parcel is too big for one box; JD keeps one tracking number
// across all of them). NULL/1 = the ordinary single-box case.
addColumn('retail_shipments', 'package_count', 'INTEGER');

// A late AIR parcel (arrived >1 day after dispatch) raises a food-safety alert:
// the "AIR DELAYED · contact customer" badge in the orders list and a matching
// "Delivery needs a call" card on the dashboard. Because the order is already
// 'delivered' (terminal), the alert never clears on its own — an operator marks
// it handled after they've contacted the customer / filed the JD claim. These
// stamp WHEN and WHO cleared it; NULL = still open. Once set, the list badge and
// the dashboard card both drop the order.
addColumn('retail_shipments', 'air_delay_cleared_at', 'DATETIME');
addColumn('retail_shipments', 'air_delay_cleared_by', 'TEXT');

// Per-store restock *target* — the level this store wants to keep on
// hand. When physical_qty < restock_target the cross-store grid flags
// it. Optional (NULL = no target set yet).
addColumn('retail_store_stock', 'restock_target', 'INTEGER');

// Human-readable actor name captured at write time. actor_user_id can be a
// kitchen users(id) OR a Mini App Backend operator's tenant_users(id) — two
// id spaces that COLLIDE, so the actor can't be resolved by id alone. Store
// the display name on the row; the ledger audit view reads this first and
// falls back to the users join for historical rows. (NULL on old/system rows.)
addColumn('retail_stock_ledger', 'actor_label', 'TEXT');

// Per-product substitutes — admin-curated list of "if we're out of X,
// these are acceptable swaps". Used by the mini-app's 5-option fallback
// flow when the customer picks "Replace missing item". Order-aware: the
// mini-app shows these first, then auto-fills with same-category in-stock
// products at the routing store if the curated list is empty.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_product_substitutes (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id            INTEGER NOT NULL,
    substitute_product_id INTEGER NOT NULL,
    sort_order            INTEGER DEFAULT 0,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, substitute_product_id),
    FOREIGN KEY (product_id)            REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (substitute_product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_subs_product ON retail_product_substitutes(product_id, sort_order);
`);

// ── retail_visits ──────────────────────────────────────────────────
// Lightweight traffic log for the mini app. One row per app-open
// (onShow) and optionally per page view, written best-effort by the
// public POST /api/retail/track endpoint. customer_id is NULL for
// anonymous opens (pre-login / silent-auth not yet resolved); openid is
// captured when the app already knows it. session_id groups events from
// a single app launch so we can count unique sessions, not just hits.
// scene is WeChat's launch scene code (how they entered: scan, share,
// ad, etc.). This table powers the dashboard's traffic + conversion
// metrics; orders/customers cover the rest.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_visits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER,                 -- NULL = anonymous / pre-login
    openid       TEXT,                    -- known when available, even sans customer row
    session_id   TEXT,                    -- per-launch id from the mini app
    page         TEXT,                    -- route, e.g. 'pages/home/home'
    scene        INTEGER,                 -- WeChat launch scene code
    referrer     TEXT,                    -- prior in-app page, if any
    user_agent   TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_visits_created  ON retail_visits(created_at);
  CREATE INDEX IF NOT EXISTS idx_retail_visits_customer ON retail_visits(customer_id);
  CREATE INDEX IF NOT EXISTS idx_retail_visits_session  ON retail_visits(session_id);

  -- Checkout-abandonment log. One row per /api/retail/checkout/quote call
  -- (the pricing step the mini-app hits when the customer opens checkout).
  -- A customer who quoted but placed no paid order in the same window is an
  -- abandoned checkout. Best-effort write (wrapped in try/catch at the call
  -- site) so a logging failure never breaks pricing. items_json mirrors the
  -- quote's items array ([{product_id, qty}]) so the dashboard can tally
  -- which products sit in abandoned checkouts.
  CREATE TABLE IF NOT EXISTS retail_checkout_quotes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER,
    openid       TEXT,
    item_count   INTEGER DEFAULT 0,        -- total qty across the cart
    subtotal     REAL    DEFAULT 0,        -- yuan-decimal product subtotal
    items_json   TEXT,                     -- JSON [{product_id, qty}]
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_checkout_quotes_created  ON retail_checkout_quotes(created_at);
  CREATE INDEX IF NOT EXISTS idx_retail_checkout_quotes_customer ON retail_checkout_quotes(customer_id);

  -- ── Reports AI: "The read" cache + "Ask" log ──────────────────────
  -- ai_report_reads caches the model-written analysis of a Reports window so
  -- one merchant costs at most a couple of billed calls a day per range.
  -- cache_key = "<from>|<to>|<store or all>"; payload_json carries the full
  -- bilingual read + per-chapter notes. Rows age out (server prunes >14d).
  -- Tenant-scoped like every retail_* table (cloned into per-tenant DBs).
  CREATE TABLE IF NOT EXISTS ai_report_reads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key    TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ai_report_reads_key ON ai_report_reads(cache_key, created_at);

  -- ai_report_asks logs each "Ask about your numbers" question — both the
  -- audit trail and the per-day cap counter (day = GZ-local YYYY-MM-DD).
  CREATE TABLE IF NOT EXISTS ai_report_asks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          TEXT NOT NULL,
    question     TEXT,
    answer_json  TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ai_report_asks_day ON ai_report_asks(day);

  -- ── retail_client_logs ────────────────────────────────────────────
  -- Mini-app self-diagnostics. The customer's phone posts here best-effort
  -- (POST /api/retail/client-log) so support can see WHAT happened on the
  -- device when a customer reports a problem — instead of guessing.
  -- Two kinds (kind column):
  --   'session' — one per app launch: device model, OS, WeChat + base-lib
  --               version, app version, launch scene. Answers "what app
  --               version / phone is this customer on?" even when nothing
  --               crashed (the most common support question).
  --   'error'   — a caught JS error / unhandled rejection / failed request,
  --               with message + stack + the page it happened on.
  -- customer_id is NULL pre-login (silent auth not yet resolved). Rows are
  -- pruned to ~30 days by the writer so the table can't grow unbounded.
  CREATE TABLE IF NOT EXISTS retail_client_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER,                 -- NULL = pre-login
    openid       TEXT,
    kind         TEXT,                    -- 'session' | 'error'
    page         TEXT,                    -- route the event happened on
    message      TEXT,                    -- error message / short label
    stack        TEXT,                    -- error stack (clipped)
    app_version  TEXT,                    -- mini-app version (envVersion + version)
    platform     TEXT,                    -- 'ios' | 'android' | 'devtools' …
    device_model TEXT,                    -- e.g. 'iPhone 13'
    system       TEXT,                    -- OS version, e.g. 'iOS 17.4'
    wx_version   TEXT,                    -- WeChat client version
    lib_version  TEXT,                    -- base-library (SDK) version
    scene        INTEGER,                 -- WeChat launch scene code
    extra        TEXT,                    -- JSON blob for anything else
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_retail_client_logs_customer ON retail_client_logs(customer_id, id);
  CREATE INDEX IF NOT EXISTS idx_retail_client_logs_created  ON retail_client_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_retail_client_logs_kind     ON retail_client_logs(kind, created_at);
`);

// Order-level columns for the 4-option / 5-option fallback flow:
//   fallback_choice          → which option the customer picked
//   awaiting_restock_pids    → JSON array of product_ids the order is
//                              waiting on (only set when fallback_choice
//                              = 'wait_for_restock')
addColumn('retail_orders', 'fallback_choice',         'TEXT');
addColumn('retail_orders', 'awaiting_restock_pids',   'TEXT');
// JSON array of product_ids the FULFILLING store can't currently cover, set
// only on orders whose stock was never gated/reserved at checkout (out-of-city,
// or scheduled-for-later GZ — see routeOrder ignoreStock). Pure warning signal:
// the order is accepted as normal, but the office is told to restock/transfer
// into the shipping warehouse before the fulfilment date. NULL = fully covered.
addColumn('retail_orders', 'fulfillment_short_pids',  'TEXT');
// JSON array of product ids the NEARER store was short on when this order was
// rerouted to a farther store (routing_reason='fallback_no_stock'). Purely
// diagnostic — turns an opaque "改派(缺货)" into "short at nearest: X, Y" in the
// order drawer. NULL for orders that weren't rerouted for stock.
addColumn('retail_orders', 'reroute_short_pids',  'TEXT');
// Fulfillment path: 'delivery' (default — ship to customer address) or
// 'pickup' (customer collects from a chosen store, no address/shipping fee).
// For pickup orders store_id holds the customer-chosen store, scheduled_for +
// delivery_slot_label hold the chosen pickup time window.
addColumn('retail_orders', 'fulfillment_type', "TEXT DEFAULT 'delivery'");
// Fapiao (发票) — invoice_title + invoice_tax_id were in the original schema;
// these add the e-general invoice extras the mini-app fapiao form collects.
addColumn('retail_orders', 'invoice_type',  'TEXT');   // 'personal' | 'company'
addColumn('retail_orders', 'invoice_email', 'TEXT');   // recipient for the 电子发票 (e-fapiao)
// Fapiao issuance workflow (Phase 3a). Status is DERIVED: a NULL invoice_status
// with needs_invoice reads as 'requested' (so legacy invoice orders show as
// requested); staff "mark issued" flips it to 'issued' and fills the rest.
addColumn('retail_orders', 'invoice_status',    'TEXT');      // null/'requested' | 'issued'
addColumn('retail_orders', 'invoice_file_url',  'TEXT');      // pasted link OR /api/retail/media/<id> (uploaded PDF)
addColumn('retail_orders', 'invoice_number',    'TEXT');      // 发票号码
addColumn('retail_orders', 'invoice_issued_at', 'DATETIME');
// Nuonuo auto-issue (lib/nuonuo.js). invoice_serial = the 流水号 returned by the
// async issue call (used to poll for the PDF + number, and as the idempotency
// marker so we never double-issue). invoice_auto_error = last auto-issue failure
// reason; non-null means it fell back to the manual office flow. Both NULL for
// orders issued manually or before auto-issue was enabled.
addColumn('retail_orders', 'invoice_serial',     'TEXT');
addColumn('retail_orders', 'invoice_auto_error', 'TEXT');
// Staff "ship it on time" reminder (see lib/delivery-reminders.js). Stamped the
// moment the one-and-only delivery reminder Web Push is fired for this order, so
// it never re-fires. NULL = not yet reminded / not eligible.
addColumn('retail_orders', 'reminder_ship_sent_at', 'DATETIME');
// Staff "start preparing" reminder for PICKUP orders (see lib/delivery-reminders.js).
// Stamped the moment the one-and-only pickup reminder Web Push is fired (20 min
// before the chosen pickup time), so it never re-fires. NULL = not yet reminded.
addColumn('retail_orders', 'reminder_pickup_sent_at', 'DATETIME');
// Item-level: when this row is a substitute, point back to the original
// product the customer was trying to buy. Lets us show "replaces X" on
// receipts and analytics.
addColumn('retail_order_items', 'replaced_for_product_id', 'INTEGER');
// Items added AFTER the order was paid, via the "Add to your order" flow.
// NULL = original line; set to the retail_order_addons.id that injected it, so
// the customer order page can tag it "added later" and prints/audits can tell
// the delta from the original ticket.
addColumn('retail_order_items', 'addon_id', 'INTEGER');
// How many units of this line have been refunded (0 = none). When it reaches
// `qty` the line is fully refunded → struck "do not ship" in the drawer, dropped
// from the packing slip, stamped 已退款 on the receipt. A partial value (0<n<qty)
// reduces the packing qty and shows "n of qty refunded". Written by the refund
// settlement paths (direct + approve) from refund_lines_json; mirrors the
// order-level ledger so prints/drawer read one field instead of parsing JSON.
addColumn('retail_order_items', 'refunded_qty', 'INTEGER DEFAULT 0');
// Wallet balance (prepaid store credit) spent on this order, ¥. Mirrors
// points_amount: deducted from retail_customers.balance inside the order-create
// tx and reversed to the wallet on cancel/refund. Store credit (balance OR
// points) never pays the shipping fee — see walletSpendableBase in routes/retail.js.
addColumn('retail_orders', 'balance_used', 'REAL DEFAULT 0');
// Cash portion (¥) of the cumulative APPROVED refund value. When an order paid
// with store credit (points/balance) is refunded, the refund value is split
// across tenders proportionally — credit goes back to the wallet/points and
// only this cash slice is settled via the gateway / paid out by hand.
// refund_amount_approved stays the TOTAL value refunded (cash + credit); this
// is the gateway/payout ceiling. NULL on legacy/credit-free orders → callers
// fall back to refund_amount_approved (where cash == value).
addColumn('retail_orders', 'refund_cash_amount', 'REAL');

// ── Unfinished "New order" forms ───────────────────────────────────────────────
// A SEPARATE TABLE, deliberately NOT a 'draft' value on retail_orders.status.
// That column is read by the Orders filter chips, the KPI tiles, reports and
// customer lifetime spend. Adding a status makes every one of those places
// responsible for remembering to exclude it, and the first one that forgets
// counts a half-typed order as revenue. A draft has no order number, no stock
// implication and no customer-history effect — it is not an order in an early
// state, it is not an order. A separate table cannot leak into a query written
// before it existed. (The manual-create endpoint also collapses any non-'paid'
// status to 'pending_payment', which a draft value would have to be special-cased
// around.)
//
// payload is the FORM STATE, opaque to the server and stored as JSON rather than
// normalised columns: a draft is allowed to be incomplete and invalid, which is
// the entire point of it. Nothing here is validated order data.
//
// created_by carries NO FOREIGN KEY, and owner_realm exists because req.user.id
// is TWO id spaces in one number: tenant_users(id) for a Mini App Backend
// operator, kitchen users(id) for the legacy path. Within the Roots tenant both
// realms share one database, so id 5 is two different people and scoping a
// personal draft on created_by alone would hand one operator the other's form.
// A hard FK to users(id) would also reject every operator-driven write — the
// same trap already documented on retail_stock_ledger.actor and
// retail_vouchers.created_by.
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_order_drafts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by   INTEGER NOT NULL,        -- audit integer, NOT an FK (see above)
    owner_realm  TEXT    NOT NULL,        -- 'backend' | 'kitchen' — disambiguates created_by
    payload      TEXT    NOT NULL,        -- opaque form state (JSON), never validated here
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_retail_order_drafts_owner
    ON retail_order_drafts(owner_realm, created_by, updated_at);
`);

// Seed default GZ-express excluded districts (editable from Admin →
// Integrations later). Customers in these districts get the simple
// fallback-yes/no modal even on right-away slots — the 5-option flow
// only kicks in for districts your same-day delivery actually serves.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_gz_excluded_districts_v1');
  if (!ran) {
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('routing.gz_express_excluded_districts', JSON.stringify(['番禺区', '花都区']));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_gz_excluded_districts_v1');
  }
} catch (e) { console.error('[migration seed_gz_excluded_districts_v1]', e); }

// Geocoded coordinates on customer addresses. Populated in the background
// by /lib/geocode.js when a Tencent Maps key is configured (TENCENT_MAPS_KEY
// in .env). NULL = not geocoded yet or geocoding failed; routing falls
// back to district-name matching in that case.
addColumn('retail_customer_addresses', 'lat',         'REAL');
addColumn('retail_customer_addresses', 'lng',         'REAL');
addColumn('retail_customer_addresses', 'geocoded_at', 'DATETIME');

// WHERE those coordinates came from, and how exact they are. Without this a
// pin the customer tapped on the map is indistinguishable from a district
// centroid a geocoder returned because it couldn't find the street — and the
// second kind must never be handed to a courier (lib/geocode PRECISION_RANK).
//   geo_source    — 'customer_pin' | 'geocode:amap' | 'geocode:tencent'
//   geo_precision — 'rooftop' | 'street' | 'coarse'
addColumn('retail_customer_addresses', 'geo_source',    'TEXT');
addColumn('retail_customer_addresses', 'geo_precision', 'TEXT');

// English companions for the (canonical Chinese) province/city/district so a
// saved address renders in whichever language the customer's app is set to,
// instead of being frozen in the language it was entered in. Populated on
// save by routes/retail.js (lib/region-i18n.js); back-filled below for rows
// that predate the columns.
addColumn('retail_customer_addresses', 'province_en', 'TEXT');
addColumn('retail_customer_addresses', 'city_en',     'TEXT');
addColumn('retail_customer_addresses', 'district_en', 'TEXT');
try {
  const ran = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('backfill_addr_region_en_v1');
  if (!ran) {
    const regionI18n = require('./lib/region-i18n');
    const rows = db.prepare(
      `SELECT id, province, city, district FROM retail_customer_addresses
        WHERE city IS NOT NULL OR district IS NOT NULL`
    ).all();
    const upd = db.prepare(
      `UPDATE retail_customer_addresses
          SET province = ?, city = ?, district = ?,
              province_en = ?, city_en = ?, district_en = ?
        WHERE id = ?`
    );
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const x = regionI18n.resolveRegion(r);
        upd.run(x.province, x.city, x.district, x.province_en, x.city_en, x.district_en, r.id);
        n++;
      }
    });
    tx();
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run('backfill_addr_region_en_v1');
    if (n) console.log(`[migration backfill_addr_region_en_v1] localized ${n} saved addresses`);
  }
} catch (e) { console.error('[migration backfill_addr_region_en_v1]', e); }

// Delivery zones gain a `preferred_store_id` link so the office can map
// a GZ district / city to its default fulfilling store. Routing reads
// this first; if the linked store is out of stock the inventory service
// falls back to the next active store by sort_order.
addColumn('retail_delivery_zones', 'preferred_store_id', 'INTEGER');

// Seed a default store (Tianhe — the kitchen address from delivery config).
// One-shot via _migrations marker so admin edits stick once it lands.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_default_store_v1');
  if (!ran) {
    const existing = db.prepare("SELECT id FROM retail_stores LIMIT 1").get();
    if (!existing) {
      const info = db.prepare(`
        INSERT INTO retail_stores (code, name_en, name_cn, address, city, district, sort_order, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('tianhe', 'Roots Kitchen — Tianhe', 'Roots 厨房 · 天河店', '广州市天河区 (Roots Kitchen)', '广州', '天河区', 0);
      console.log(`[migration] seed_default_store_v1: created default store id=${info.lastInsertRowid}`);

      // Migrate existing products.stock_qty → default store stock so the
      // mini app keeps selling without an admin re-entering everything.
      // Only products published in retail are seeded; the rest stay
      // kitchen-only.
      const storeId = info.lastInsertRowid;
      const products = db.prepare(`
        SELECT id, COALESCE(stock_qty, 0) AS qty
          FROM products
         WHERE is_published = 1 AND COALESCE(is_active, 1) = 1
      `).all();
      const insStock = db.prepare(`
        INSERT INTO retail_store_stock (store_id, product_id, physical_qty)
        VALUES (?, ?, ?)
      `);
      const seedTx = db.transaction(() => {
        for (const p of products) insStock.run(storeId, p.id, p.qty || 0);
      });
      seedTx();
      console.log(`[migration] seed_default_store_v1: seeded stock for ${products.length} retail products`);
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_default_store_v1');
  }
} catch (e) { console.error('[migration seed_default_store_v1]', e); }

// Seed the second retail store (Yuexiu — 越秀店). The online store now runs
// independent stock across BOTH Guangzhou locations (Tianhe + Yuexiu). We add
// only the store row: the inventory grid lists every active store and shows a
// missing stock row as an editable 0 (PATCH upserts on first edit), so we don't
// pre-seed 269 zero rows — Yuexiu starts un-counted and the operator enters its
// real stock. Tianhe keeps sort_order 0 (preferred for routing); Yuexiu is 1.
// lat/lng left NULL — the address-level seed geocodes via the admin backfill /
// next address edit. One-shot via _migrations so admin edits stick.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_yuexiu_store_v1');
  if (!ran) {
    const existing = db.prepare("SELECT id FROM retail_stores WHERE code = ?").get('yuexiu');
    if (!existing) {
      const info = db.prepare(`
        INSERT INTO retail_stores (code, name_en, name_cn, address, city, district, sort_order, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run('yuexiu', 'Roots Kitchen — Yuexiu', 'Roots 厨房 · 越秀店', '广州市越秀区', '广州', '越秀区', 1);
      console.log(`[migration] seed_yuexiu_store_v1: created Yuexiu store id=${info.lastInsertRowid}`);
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_yuexiu_store_v1');
  }
} catch (e) { console.error('[migration seed_yuexiu_store_v1]', e); }

// Backfill: any active product without a stock row in *any* store gets
// one in the default store using its legacy stock_qty. Runs once via the
// _migrations marker so existing per-store rows are never overwritten.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('backfill_all_products_to_default_store_v1');
  if (!ran) {
    const defaultStore = db.prepare("SELECT id FROM retail_stores WHERE is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1").get();
    if (defaultStore) {
      const missing = db.prepare(`
        SELECT p.id, COALESCE(p.stock_qty, 0) AS qty
          FROM products p
         WHERE COALESCE(p.is_active, 1) = 1
           AND NOT EXISTS (SELECT 1 FROM retail_store_stock s WHERE s.product_id = p.id)
      `).all();
      const ins = db.prepare("INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?, ?, ?)");
      const tx = db.transaction(() => { for (const p of missing) ins.run(defaultStore.id, p.id, p.qty); });
      tx();
      console.log(`[migration] backfill_all_products_to_default_store_v1: seeded ${missing.length} product(s) into store id=${defaultStore.id}`);
    }
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('backfill_all_products_to_default_store_v1');
  }
} catch (e) { console.error('[migration backfill_all_products_to_default_store_v1]', e); }

// Seed default reservation TTL config — minutes before an unpaid order's
// stock reservations expire and stock returns to the available pool.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('seed_reservation_ttl_v1');
  if (!ran) {
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES ('inventory.reservationTtlMinutes', ?)").run(JSON.stringify(15));
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('seed_reservation_ttl_v1');
  }
} catch (e) { console.error('[migration seed_reservation_ttl_v1]', e); }

// Shipping-spec alignment (2026-05-20):
//   • Expand gz_express_excluded_districts to the full 5-district set so
//     same-day delivery only the simple yes/no fallback modal kicks in for
//     all GZ "exception" districts (番禺/花都/南沙/从化/增城).
//   • Ensure 花都区 has a zone row (was missing in production) with the
//     spec defaults: ¥25 / free ¥199 / +¥30 same-day surcharge / day-only
//     chip for same-day.
//   • Backfill same_day_surcharge on the existing exception zones if and
//     only if currently 0 (preserves any admin override).
//   • Holiday-mode storefront_config keys (default OFF + message) so the
//     retail-admin Delivery tab can pause shipping with a custom banner
//     without code changes.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('shipping_spec_alignment_v1');
  if (!ran) {
    // 1. Expand the excluded-districts list
    db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('routing.gz_express_excluded_districts',
           JSON.stringify(['番禺区', '花都区', '南沙区', '从化区', '增城区']));

    // 2. Add 花都区 zone if missing
    const huadu = db.prepare(
      `SELECT id FROM retail_delivery_zones WHERE zone_type = 'gz_district' AND match_district = ?`
    ).get('花都区');
    if (!huadu) {
      db.prepare(
        `INSERT INTO retail_delivery_zones
           (zone_type, name_en, name_cn, match_district, base_fee, max_fee, free_threshold,
            packing_fee_per_item, packing_fee_cap, is_active, sort_order,
            same_day_allowed, same_day_surcharge, min_lead_days, max_lead_days,
            slot_start_hour, slot_end_hour, slot_duration_minutes, day_only)
         VALUES ('gz_district', ?, ?, ?, 25, NULL, 199, 0, NULL, 1, 0,
                 1, 30, 0, 14, 10, 20, 120, 1)`
      ).run('Huadu', '花都区', '花都区');
      console.log('[migration shipping_spec_alignment_v1] inserted 花都区 zone');
    }

    // 3. Backfill same_day_surcharge on exception zones (only if currently 0)
    //    so existing admin edits stick.
    const surcharges = [
      { district: '番禺区', amount: 20 },
      { district: '南沙区', amount: 40 },
      { district: '从化区', amount: 40 },
      { district: '增城区', amount: 40 },
    ];
    for (const s of surcharges) {
      db.prepare(
        `UPDATE retail_delivery_zones
            SET same_day_surcharge = ?, day_only = 1, same_day_allowed = 1
          WHERE zone_type = 'gz_district'
            AND match_district = ?
            AND (same_day_surcharge IS NULL OR same_day_surcharge = 0)`
      ).run(s.amount, s.district);
    }

    // 4. Holiday-mode keys (default OFF + customizable message)
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('delivery.holidayMode', JSON.stringify(false));
    db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)")
      .run('delivery.holidayMessage', JSON.stringify({
        en: "We're closed for a short holiday — your order will ship as soon as we're back. Thank you for your patience!",
        cn: '我们短暂休假中 — 订单将在我们回来后第一时间发货。感谢您的耐心等待！',
      }));

    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('shipping_spec_alignment_v1');
    console.log('[migration] shipping_spec_alignment_v1: expanded excluded districts, added 花都区, backfilled surcharges, seeded holiday-mode keys');
  }
} catch (e) { console.error('[migration shipping_spec_alignment_v1]', e); }

// Backfill retail_customers.lifetime_spend from existing orders. The column
// Affiliate / refer-a-friend. Each customer gets a stable referral_code
// (lazily issued on first /api/retail/affiliate hit). referred_by_customer_id
// records who invited them; set exactly once (immutable after first paid
// order) so the reward can't be double-claimed. retail_referrals is the
// relationship table — one row per (referrer, invitee) pair, state-machined
// through pending → joined → ordered. Settings (enabled, ¥reward) live
// in storefront_config under `affiliate.*` so the admin Affiliate tab is
// the single source of truth for program rules.
addColumn('retail_customers', 'referral_code',            'TEXT');
addColumn('retail_customers', 'referred_by_customer_id',  'INTEGER');
addColumn('retail_customers', 'referral_applied_at',      'DATETIME');
// Provenance — how this customer record was born. NULL/'app' = self-service
// signup (WeChat / web OAuth / phone-OTP); 'manual' = keyed in by staff via
// the Mini App Backend (walk-ins, phone orders). created_by is the staff
// user id that created a manual record. Reporting treats NULL as 'app'.
addColumn('retail_customers', 'source',                   'TEXT');
addColumn('retail_customers', 'created_by',               'INTEGER');
// Staff "seen" timestamp — stamped the first time ANY operator opens the
// customer detail. NULL = nobody on the team has opened this record yet.
//
// DELIBERATELY the SHARED model, mirroring retail_orders.seen_at: ONE
// timestamp, stamped by whoever opens the record first, with no operator
// identity attached. It means "nobody on this team has opened this", NOT
// "you haven't". Chosen 2026-07-25 to match Orders rather than build a
// per-operator seen table — do not "correct" this into per-operator.
addColumn('retail_customers', 'seen_at',                  'DATETIME');
// One-shot backfill: stamp every customer that existed when the column
// landed as already seen, so only records created from this point on read
// as unopened. Decided 2026-07-25, same call the Orders backfill made.
//
// WHY, so a later pass doesn't undo it: the unopened treatment exists to
// point an operator at what needs them. Ship it un-backfilled and all 683
// existing rows arrive tinted — the marker then means "everything", which
// means nothing, and operators learn to ignore it before it is ever used
// for its purpose. Marker in _migrations, so a restart can't re-stamp rows
// an operator has since left genuinely unopened.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('retail_customers_seen_at_backfill_v1');
  if (!ran) {
    const r = db.prepare("UPDATE retail_customers SET seen_at = COALESCE(created_at, datetime('now')) WHERE seen_at IS NULL").run();
    console.log(`[migration retail_customers_seen_at_backfill_v1] marked ${r.changes} existing customers as seen`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('retail_customers_seen_at_backfill_v1');
  }
} catch (e) { console.error('[migration retail_customers_seen_at_backfill_v1]', e); }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_customers_refcode ON retail_customers(referral_code) WHERE referral_code IS NOT NULL'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_customers_refby ON retail_customers(referred_by_customer_id)'); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS retail_referrals (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id           INTEGER NOT NULL,
  invitee_id            INTEGER NOT NULL,
  code_used             TEXT,
  status                TEXT NOT NULL DEFAULT 'joined',  -- joined | ordered | void
  reward_amount         REAL NOT NULL DEFAULT 0,         -- ¥ credited to referrer ("for you") on conversion
  referee_reward_amount REAL NOT NULL DEFAULT 0,         -- ¥ credited to the invited friend ("for them") on conversion
  first_paid_order_id   INTEGER,
  joined_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  rewarded_at           DATETIME,
  voided_at             DATETIME,
  voided_reason         TEXT,
  FOREIGN KEY (referrer_id)         REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_id)          REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (first_paid_order_id) REFERENCES retail_orders(id)    ON DELETE SET NULL,
  UNIQUE(invitee_id)
)`);
addColumn('retail_referrals', 'referee_reward_amount', 'REAL NOT NULL DEFAULT 0');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_referrals_referrer ON retail_referrals(referrer_id, status)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_referrals_order ON retail_referrals(first_paid_order_id)'); } catch {}

// Lifetime revenue-share ledger — one row per order that paid the referrer a
// percentage commission. SEPARATE from retail_referrals (which is the one-shot
// first-order bounty): a referrer earns the bounty ONCE, then a commission on
// every SUBSEQUENT paid order their invitee places. UNIQUE(order_id) is the
// idempotency guard (an order pays a lifetime commission at most once, even if
// the wechat callback re-fires). ONE LEVEL ONLY by construction — referrer_id is
// the invitee's DIRECT referrer; we never walk further up a chain (multi-level
// payout = 三级分销/传销, which WeChat bans). reversed_at is stamped when the
// triggering order is fully refunded/cancelled and the commission is clawed back.
db.exec(`CREATE TABLE IF NOT EXISTS retail_lifetime_commissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL,
  referrer_id       INTEGER NOT NULL,                -- the invitee's DIRECT referrer (paid)
  customer_id       INTEGER NOT NULL,                -- the invitee who placed the order
  base_amount       REAL NOT NULL DEFAULT 0,         -- order total the commission was computed on
  rate_percent      REAL NOT NULL DEFAULT 0,         -- snapshot of the % at payout time
  commission_amount REAL NOT NULL DEFAULT 0,         -- ¥ credited to the referrer's wallet
  reversed_at       DATETIME,                        -- set on refund/cancel clawback
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id)    REFERENCES retail_orders(id)    ON DELETE CASCADE,
  FOREIGN KEY (referrer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
  UNIQUE(order_id)
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_lifetime_comm_referrer ON retail_lifetime_commissions(referrer_id)'); } catch {}

// was in the schema since launch but was never written; the new Customers
// admin tab's "Top spenders" sort needs it populated. Sums subtotal (not
// total — vouchers/points discounts shouldn't reduce lifetime spend) for
// all non-cancelled / non-refunded / non-pending orders.
try {
  const ran = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('backfill_lifetime_spend_v1');
  if (!ran) {
    const r = db.prepare(`
      UPDATE retail_customers
         SET lifetime_spend = COALESCE((
           SELECT SUM(subtotal) FROM retail_orders
            WHERE customer_id = retail_customers.id
              AND status NOT IN ('cancelled', 'refunded', 'pending_payment')
         ), 0)
    `).run();
    console.log(`[migration backfill_lifetime_spend_v1] populated lifetime_spend on ${r.changes} customer rows`);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('backfill_lifetime_spend_v1');
  }
} catch (e) { console.error('[migration backfill_lifetime_spend_v1]', e); }

// Hydrate process.env from storefront_config `integrations.*` keys so
// the admin Integrations tab is the source of truth for third-party
// credentials. DB values win over pre-existing env vars (env stays
// available as a one-shot bootstrap path). Runs once at boot; the
// Integrations PUT endpoint also mirrors writes into process.env so a
// restart isn't required during the admin session.
try {
  const envMap = {
    'integrations.kd100.customer': 'KD100_CUSTOMER',
    'integrations.kd100.key':      'KD100_KEY',
    'integrations.kd100.callback': 'KD100_CALLBACK',
    'integrations.kd100.secret':   'KD100_SECRET',
    'integrations.jd.app_key':       'JD_APP_KEY',
    'integrations.jd.app_secret':    'JD_APP_SECRET',
    'integrations.jd.access_token':  'JD_ACCESS_TOKEN',
    'integrations.jd.customer_code': 'JD_CUSTOMER_CODE',
    'integrations.jd.env':           'JD_API_ENV',
    'integrations.feie.user':        'FEIE_USER',
    'integrations.feie.ukey':        'FEIE_UKEY',
    'integrations.wecom_app.corp_id':  'WECOM_CORP_ID',
    'integrations.wecom_app.agent_id': 'WECOM_AGENT_ID',
    'integrations.wecom_app.secret':   'WECOM_SECRET',
    'integrations.aliyun_sms.ak_id':              'ALIYUN_SMS_AK_ID',
    'integrations.aliyun_sms.ak_secret':          'ALIYUN_SMS_AK_SECRET',
    'integrations.aliyun_sms.sign_name':          'ALIYUN_SMS_SIGN',
    'integrations.aliyun_sms.template_delivered': 'ALIYUN_SMS_TPL_DELIV',
    'integrations.aliyun_sms.template_otp':       'ALIYUN_SMS_TPL_OTP',
  };
  let hydrated = 0;
  for (const [cfgKey, envKey] of Object.entries(envMap)) {
    const r = db.prepare("SELECT value_json FROM storefront_config WHERE key = ?").get(cfgKey);
    if (!r) continue;
    let v; try { v = JSON.parse(r.value_json); } catch { v = r.value_json; }
    if (typeof v === 'string' && v) { process.env[envKey] = v; hydrated++; }
  }
  if (hydrated > 0) console.log(`[integrations] hydrated ${hydrated} env vars from storefront_config`);
} catch (e) { console.error('[integrations.hydrate] failed', e); }

// ─────────────────────────────────────────────────────────────────────────
// COMMUNITY POLLS / VOTING (design page #23)
//   retail_polls         → one row per poll (draft / open / closed)
//   retail_poll_options  → 2–N answer options per poll, vote counts cached
//   retail_poll_votes    → audit ledger, one vote per (poll, customer)
// On vote, retail_polls.total_votes++ and the chosen option's votes++, and
// the customer gets reward_points credited via retail_points_transactions
// (source='poll_vote'). All inside one txn.
// Admin manages everything from the retail-admin "Voting" tab.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_polls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    question_en     TEXT NOT NULL,
    question_cn     TEXT,
    explainer_en    TEXT,
    explainer_cn    TEXT,
    category_en     TEXT,
    category_cn     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    closes_at       DATETIME,
    reward_points   INTEGER NOT NULL DEFAULT 5,
    is_featured     INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    total_votes     INTEGER NOT NULL DEFAULT 0,
    winner_option_id INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_retail_polls_status ON retail_polls(status, sort_order);

  CREATE TABLE IF NOT EXISTS retail_poll_options (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id         INTEGER NOT NULL,
    label_en        TEXT NOT NULL,
    label_cn        TEXT,
    color_hex       TEXT,
    image_url       TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    votes           INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (poll_id) REFERENCES retail_polls(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_poll_options_poll ON retail_poll_options(poll_id, sort_order);

  CREATE TABLE IF NOT EXISTS retail_poll_votes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id         INTEGER NOT NULL,
    option_id       INTEGER NOT NULL,
    customer_id     INTEGER NOT NULL,
    awarded_points  INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(poll_id, customer_id),
    FOREIGN KEY (poll_id)     REFERENCES retail_polls(id)        ON DELETE CASCADE,
    FOREIGN KEY (option_id)   REFERENCES retail_poll_options(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id)    ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_poll_votes_customer ON retail_poll_votes(customer_id, created_at);
`);

// Display-only vote inflation. `display_min_total` is a floor on how many votes
// CUSTOMERS see for a poll: when real turnout is below it, the customer API
// (hydratePoll) scales every option up by the same factor so percentages are
// unchanged and only the numbers look bigger. The real ledger + cached counts
// (and the admin Voting tab) are never altered. 0 = off (show real numbers).
addColumn('retail_polls', 'display_min_total', 'INTEGER NOT NULL DEFAULT 0');

// ─────────────────────────────────────────────────────────────────────────
// One-time: clone the live "hummus" poll into a fresh poll that INHERITS its
// vote counts but starts with an EMPTY vote ledger.
//
// Why: the mini-app bundle already published to customers reveals tallies only
// once the viewer has voted (showResults = voted || closed). A brand-new poll
// has no ledger rows, so every customer is "hasn't voted" → the installed app
// shows just the options (no tallies/percentages) until they personally vote,
// then displays the inherited totals (e.g. 17, Roasted Red Pepper leading). This
// lets us retire the old poll — which already showed numbers to past voters —
// WITHOUT a WeChat release. We copy only the cached counts (total_votes + each
// option's votes), never the retail_poll_votes ledger, and draft the old poll so
// it's hidden but preserved as a backup. Idempotent via the _migrations guard.
// (scripts/copy_poll_votes.js is the manual equivalent.)
// ─────────────────────────────────────────────────────────────────────────
try {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const alreadyRan = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('dup_hummus_poll_v1');
  if (!alreadyRan) {
    const src = db.prepare(
      "SELECT * FROM retail_polls WHERE LOWER(question_en) LIKE '%hummus%' AND total_votes > 0 ORDER BY total_votes DESC, id LIMIT 1"
    ).get();
    if (src) {
      const srcOpts = db.prepare(
        'SELECT * FROM retail_poll_options WHERE poll_id = ? ORDER BY sort_order, id'
      ).all(src.id);
      const tx = db.transaction(() => {
        const r = db.prepare(
          `INSERT INTO retail_polls
             (question_en, question_cn, explainer_en, explainer_cn, category_en, category_cn,
              status, closes_at, reward_points, is_featured, sort_order, total_votes, winner_option_id)
           VALUES (?,?,?,?,?,?, 'open', NULL, ?, 1, ?, ?, NULL)`
        ).run(
          src.question_en, src.question_cn, src.explainer_en, src.explainer_cn,
          src.category_en, src.category_cn,
          src.reward_points, src.sort_order, src.total_votes
        );
        const newId = r.lastInsertRowid;
        const insOpt = db.prepare(
          `INSERT INTO retail_poll_options
             (poll_id, label_en, label_cn, color_hex, image_url, sort_order, votes)
           VALUES (?,?,?,?,?,?,?)`
        );
        for (const o of srcOpts) {
          insOpt.run(newId, o.label_en, o.label_cn, o.color_hex, o.image_url, o.sort_order, o.votes);
        }
        // Hide the old poll from customers; keep it as the backup record.
        db.prepare("UPDATE retail_polls SET status = 'draft', is_featured = 0 WHERE id = ?").run(src.id);
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('dup_hummus_poll_v1');
        return newId;
      });
      const newId = tx();
      console.log(`[migration dup_hummus_poll_v1] cloned poll #${src.id} (${src.total_votes} votes) → new open poll #${newId}; old poll drafted`);
    } else {
      console.log('[migration dup_hummus_poll_v1] no source hummus poll with votes found; will retry next boot');
    }
  }
} catch (e) { console.error('[migration dup_hummus_poll_v1]', e); }

// ─────────────────────────────────────────────────────────────────────────
// FAVORITES — saved / wishlisted products per customer.
// Drives the Mini App Favorites page (NO. 21) and the home-page
// "favorites" CMS block. One row per (customer_id, product_id); duplicates
// are no-ops on the API layer.
// ─────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS retail_customer_favorites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, product_id),
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id)  REFERENCES products(id)         ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_retail_favorites_customer ON retail_customer_favorites(customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_retail_favorites_product  ON retail_customer_favorites(product_id);
`);

// Activity log retention — purge entries older than ACTIVITY_LOG_RETENTION_DAYS
// (default 90) on every startup. Cheap (indexed delete) and prevents
// unbounded growth on a long-lived install.
const RETENTION_DAYS = parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS || '90', 10);
if (RETENTION_DAYS > 0) {
  try {
    const r = db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', '-' || ? || ' days')").run(RETENTION_DAYS);
    if (r.changes > 0) console.log(`[retention] purged ${r.changes} activity_log entries older than ${RETENTION_DAYS} days`);
  } catch (e) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────
// STORE_PRODUCTS — the online store's OWN product catalog, forked from the
// kitchen `products` table so storefront product management is a fully
// independent entity: its own SKU namespace, its own per-store stock, its own
// merchandising. The kitchen app keeps editing `products`; the store edits
// `store_products`; the two no longer affect each other. `kitchen_product_id`
// / `source_sku` keep a link so a future one-way "pull from kitchen" sync can
// re-integrate the two (the sync job itself is NOT built yet).
//
// Built with FULL column parity to `products` so every kitchen field (sku,
// status, price, weight, barcode, …) AND every mini-app field (keywords,
// tagline, nutrition, description_blocks, flash_*, …) carries over. The shape
// is DERIVED from `products` at boot so the two schemas never drift: mirror
// the column list, then backfill any column `products` later gains. The only
// dropped constraint is the inline FK to recipes(id) — the store has no
// recipes (allergens live in the editable `free_of` column instead). mainDb
// only: this whole file runs against roots.db; tenant DBs get their schema
// cloned separately by lib/tenant-db.js.
// ─────────────────────────────────────────────────────────────────────────
try {
  const pcols = db.pragma('table_info(products)'); // [{name,type,notnull,dflt_value,pk}, …]
  const haveStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_products'").get();
  if (!haveStore) {
    const defs = pcols.map(c => {
      if (c.pk) return `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
      let d = `${c.name} ${c.type || 'TEXT'}`;
      if (c.notnull) d += ' NOT NULL';
      if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
      return d;
    });
    // Store-only link columns for the future kitchen↔store integration.
    defs.push('kitchen_product_id INTEGER');  // source products.id at fork time
    defs.push('source_sku TEXT');             // SKU at fork time (stable match key)
    defs.push('synced_at DATETIME');          // reserved: last pull-from-kitchen
    defs.push("source TEXT DEFAULT 'fork'");  // 'fork' | (future) 'sync'
    db.exec(`CREATE TABLE store_products (\n  ${defs.join(',\n  ')}\n)`);
  }
  // Parity backfill — if `products` later gains a column, mirror it here so the
  // two schemas never drift (idempotent; addColumn swallows duplicate columns).
  const spcols = new Set(db.pragma('table_info(store_products)').map(c => c.name));
  for (const c of pcols) if (!spcols.has(c.name)) addColumn('store_products', c.name, c.type || 'TEXT');
  // Store-only: a flexible per-product-type facts bag (origin/ingredients/…),
  // stored as JSON so a new product type needs no new columns.
  addColumn('store_products', 'product_facts', 'TEXT');
  // Store-only: the variant tag, split EN/CN (never glued). `variant_label`
  // holds the English option ("Big 200g"); `variant_label_cn` the Chinese ("大")
  // — the storefront/editor pick the right one per the language toggle.
  addColumn('store_products', 'variant_label_cn', 'TEXT');
  // Store-only: the variant AXIS noun for the whole group — what the size-picker
  // heading calls the choice. Operator types just the noun ("color", "flavor",
  // "size"); the storefront renders "Choose a {noun_en}" / "选择{noun_cn}". NULL
  // falls back to the legacy "size" / "规格". Propagated to every group member on
  // save so any rep row carries it. EN/CN split, each independent (never glued).
  addColumn('store_products', 'variant_noun_en', 'TEXT');
  addColumn('store_products', 'variant_noun_cn', 'TEXT');
  // Store-only: per-product low-stock alert threshold. NULL = use the tenant
  // global default (storefront_config 'inventory.lowStockThreshold', default 5).
  // A product gets flagged "low" when its stock is >0 and ≤ this number — drives
  // the products list amber dot, the Low-stock KPI tile, and the dashboard/alerts.
  addColumn('store_products', 'low_stock_threshold', 'INTEGER');
  // Store-only: BUNDLE PRODUCTS. A bundle is a normal store_products row (own
  // name/photo/price/category — one card, one PDP, one cart line) that is really
  // a fixed combination of OTHER products. bundle_items holds the recipe as JSON
  // [{ id, qty }] of component product ids + per-unit quantities. When non-empty
  // the row IS a bundle: its own stock_qty is ignored, availability is computed
  // as min(component stock ÷ qty), and at checkout the COMPONENT stock is
  // reserved/deducted (never the bundle's). Distinct from the legacy `bundle`
  // column, which is the "buy together" upsell shown inside another product.
  addColumn('store_products', 'bundle_items', 'TEXT');
  // Store-only: BUNDLE MODE — how a bundle product is stocked. Set only when the
  // operator marks a product a bundle in the editor.
  //   'assembled' = made from OTHER products (bundle_items lists them); its own
  //     stock_qty is ignored, availability = min(component stock ÷ qty), and at
  //     checkout the COMPONENT stock is deducted (see expandStockLines).
  //   'prepacked' = the operator stocks finished sets on a shelf; it behaves like
  //     an ordinary product with its own counted stock — the "bundle" flag is
  //     just so it reads as a set (badge/label). Carries no bundle_items.
  //   NULL = not a bundle. Back-compat: a row with bundle_items but no mode is
  //     treated as 'assembled'.
  addColumn('store_products', 'bundle_mode', 'TEXT');
  // Store-only: COUPON-ON-FLASH policy. 0/NULL (default) = vouchers stack on top
  // of the flash price as usual. 1 = while this product is on an ACTIVE flash
  // sale, its line is excluded from the voucher discount base (a sitewide coupon
  // won't pile on top of the deep flash price). Dormant when the product isn't on
  // flash — the checkout only honours it for items whose flash window is live.
  addColumn('store_products', 'no_coupon_on_flash', 'INTEGER');
  // Store-only mirror of products.oos_policy (see the products addColumn above):
  // 'strict' (default/NULL) = sold-out blocks ordering in every region;
  // 'backorder_gz' = out-of-city shoppers may still pre-order, only same-day
  // Guangzhou stays hard-blocked;
  // 'always' = stock is ignored entirely — always orderable in every region,
  //   never SOLD OUT. Used for supplier-direct items (ship_from_supplier=1),
  //   where we hold no inventory: the supplier is the source of truth. The only
  //   way to stop selling one is the supplier_paused switch below.
  // NULL falls back to is_batch_made for back-compat. Operator-set per product
  // in the store editor.
  addColumn('store_products', 'oos_policy', 'TEXT');
  // Operator's "the supplier is temporarily out" switch for supplier-direct
  // products. 1 = still visible on the shop but shown "Temporarily unavailable"
  // and not orderable; 0 (default) = available. Only meaningful when the item is
  // always-available (ship_from_supplier=1); a stock count never applies to it.
  addColumn('store_products', 'supplier_paused', 'INTEGER DEFAULT 0');
  // Mini-app PDP hero aspect ratio (width/height as a REAL). When present, the
  // product page sizes the hero box to the photo's true shape so nothing crops;
  // when NULL the mini-app self-corrects from the image's bindload event, then
  // the hero box falls back to a fixed height + aspectFill (which crops). Backfilled
  // by scripts/backfill_image_aspect.js; recomputed on image save in retail.js.
  addColumn('store_products', 'image_aspect', 'REAL');
  // Own indexes — store_products has its OWN sku namespace (independent of the
  // kitchen's), mirroring the products indexes the storefront relies on.
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_store_products_sku ON store_products(sku)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_variant_group ON store_products(variant_group_id)').run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_store_products_barcode ON store_products(barcode) WHERE barcode IS NOT NULL').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_kitchen_id ON store_products(kitchen_product_id)').run();
  // Every storefront / mini-app list query gates on (is_published, is_active)
  // and the shop's category filter hits `category` — index both so the catalogue
  // scan stays fast as the product count grows.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_pub_active ON store_products(is_published, is_active)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_category ON store_products(category)').run();
  // The shop's default ("featured") sort is ORDER BY sort_order, name_en under a
  // is_published = 1 filter. This composite lets SQLite satisfy both the filter
  // and the ordering straight from the index — no full-table sort as the catalogue
  // grows. (is_active is COALESCE'd, so it can't live in the index; it's a cheap
  // residual filter on the already-ordered rows.)
  db.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_sort ON store_products(is_published, sort_order, name_en)').run();
  // Release SKUs still held by soft-deleted rows. A deleted product is hidden
  // from the catalogue but used to keep its UNIQUE sku — blocking reuse of that
  // code and surfacing as "SKU in use, but I can't find it". Deletes now blank
  // the sku; this heals catalogues deleted before that fix. Idempotent (the set
  // shrinks to zero after the first boot).
  const freed = db.prepare("UPDATE store_products SET sku = NULL WHERE COALESCE(is_active, 1) = 0 AND sku IS NOT NULL").run();
  if (freed.changes) console.log('[store_products] freed', freed.changes, 'sku(s) from deleted rows');
} catch (e) { console.error('[store_products] schema migration failed:', e); }

// ─────────────────────────────────────────────────────────────────────────
// STORE_PRODUCTS seed + FK repoint (one-time, mainDb only, atomic). Forks the
// live catalog into store_products and repoints the store-OWNED tables' product
// foreign keys at it, so the store can create its own products (with no kitchen
// counterpart) without violating REFERENCES products(id). Kitchen-owned tables
// (market_stock, market_stock_ledger, miniapp_order_lines, sales_entries,
// sale_addons, waste_entries, restock_items) keep pointing at products.
//
// Seed set = published products UNION every product referenced by a store-owned
// table — the union half is load-bearing: seeding only the published set would
// orphan historical order lines on now-unpublished products and the FK repoint
// would fail. Ids are preserved so existing retail_* rows resolve unchanged.
//
// The repoint reads each table's LIVE CREATE from sqlite_master (so ALTER-added
// columns like tags_json/restock_target come along), swaps only `REFERENCES
// products(` → `REFERENCES store_products(`, and rebuilds via a temp table that
// is renamed into place (never renaming the ORIGINAL — that would rewrite the
// FK in dependents like retail_product_option_choices). Wrapped in one
// transaction with foreign_keys OFF; a per-table foreign_key_check failure
// rolls the whole thing back and leaves prod untouched.
// ─────────────────────────────────────────────────────────────────────────
try {
  const done = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('store_products_seed_fk_v1');
  const haveStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_products'").get();
  if (!done && haveStore) {
    const STORE_OWNED = [
      'retail_order_items', 'retail_product_options', 'retail_reviews',
      'retail_store_stock', 'retail_stock_reservations', 'retail_stock_ledger',
      'retail_product_substitutes', 'retail_customer_favorites',
    ];
    const rebuildFk = (t) => {
      const trow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!trow) return; // not present on a fresh DB — nothing to repoint
      const idxSqls = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t).map(r => r.sql);
      const createSql = trow.sql.replace(/REFERENCES\s+products\s*\(/gi, 'REFERENCES store_products(');
      const tmp = `_fk_tmp_${t}`;
      const tmpSql = createSql.replace(new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`']?)${t}(["\`']?)`, 'i'), `$1${tmp}$2`);
      if (tmpSql === createSql) throw new Error(`[store_products] could not rename CREATE for ${t}`);
      db.exec(tmpSql);
      db.exec(`INSERT INTO ${tmp} SELECT * FROM ${t}`);
      db.exec(`DROP TABLE ${t}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${t}`);
      for (const s of idxSqls) db.exec(s);
    };
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    try {
      db.transaction(() => {
        // 1) Seed (preserve id, record the kitchen link).
        const colList = db.pragma('table_info(products)').map(c => c.name).join(', ');
        db.exec(`
          INSERT INTO store_products (${colList}, kitchen_product_id, source_sku, source)
          SELECT ${colList}, id, sku, 'fork' FROM products
          WHERE is_published = 1 OR id IN (
            SELECT product_id FROM retail_order_items WHERE product_id IS NOT NULL
            UNION SELECT product_id FROM retail_product_options
            UNION SELECT product_id FROM retail_reviews
            UNION SELECT product_id FROM retail_store_stock
            UNION SELECT product_id FROM retail_stock_reservations
            UNION SELECT product_id FROM retail_stock_ledger
            UNION SELECT product_id FROM retail_product_substitutes
            UNION SELECT substitute_product_id FROM retail_product_substitutes
            UNION SELECT product_id FROM retail_customer_favorites
          )`);
        // 2) Repoint store-owned FKs at store_products.
        for (const t of STORE_OWNED) rebuildFk(t);
        // 3) Verify only the rebuilt tables — a violation rolls everything back.
        for (const t of STORE_OWNED) {
          const issues = db.pragma(`foreign_key_check(${t})`);
          if (issues.length) throw new Error(`[store_products] FK check failed for ${t}: ${JSON.stringify(issues).slice(0, 300)}`);
        }
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('store_products_seed_fk_v1');
      })();
      console.log('[store_products] seeded + FK repoint complete:', db.prepare('SELECT COUNT(*) n FROM store_products').get().n, 'rows');
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) { console.error('[store_products] seed/FK migration failed (left untouched):', e); }

// ─────────────────────────────────────────────────────────────────────────
// Repair orphaned retail_customers child rows + harden the retail_orders FK.
// A historical out-of-band hard-delete of a few customers (bypassing FK
// enforcement) left dangling rows that PRAGMA foreign_key_check flags:
// retail_orders (no on-delete rule → orphaned), and retail_customer_vouchers /
// retail_points_transactions / retail_topup_transactions (already ON DELETE
// CASCADE, so their orphans only exist because the delete skipped FK checks).
// Fix: rebuild retail_orders to ON DELETE SET NULL (an order is a financial
// record — keep it, drop the dead customer link) and NULL its orphans; for the
// CASCADE tables, DELETE the orphans (what CASCADE intended). Guarded + atomic;
// a residual foreign_key_check failure rolls the whole thing back.
// ─────────────────────────────────────────────────────────────────────────
try {
  const done = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('fix_orphan_customer_fks_v1');
  if (!done) {
    const ordFk = db.pragma('foreign_key_list(retail_orders)').find(f => f.from === 'customer_id' && f.table === 'retail_customers');
    const needsRebuild = ordFk && ordFk.on_delete !== 'SET NULL';
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    try {
      db.transaction(() => {
        if (needsRebuild) {
          // Rebuild retail_orders: customer_id nullable + ON DELETE SET NULL.
          // Read the LIVE schema (so ALTER-added columns come along), swap only
          // the customer_id NOT NULL + its FK rule, rebuild via a temp table.
          const trow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='retail_orders'").get();
          const idxSqls = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='retail_orders' AND sql IS NOT NULL").all().map(r => r.sql);
          const createSql = trow.sql
            .replace(/customer_id(\s+)INTEGER\s+NOT\s+NULL/i, 'customer_id$1INTEGER')
            .replace(/REFERENCES\s+retail_customers\s*\(\s*id\s*\)(?!\s+ON\s+DELETE)/i, 'REFERENCES retail_customers(id) ON DELETE SET NULL');
          const tmpSql = createSql.replace(/(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?)retail_orders(["`']?)/i, '$1_fk_tmp_retail_orders$2');
          if (tmpSql === createSql) throw new Error('[fix_orphan_customer_fks_v1] could not rename CREATE for retail_orders');
          db.exec(tmpSql);
          db.exec('INSERT INTO _fk_tmp_retail_orders SELECT * FROM retail_orders');
          db.exec('DROP TABLE retail_orders');
          db.exec('ALTER TABLE _fk_tmp_retail_orders RENAME TO retail_orders');
          for (const s of idxSqls) db.exec(s);
        }
        // Orders: preserve the record, null the dead link.
        db.exec("UPDATE retail_orders SET customer_id = NULL WHERE customer_id IS NOT NULL AND customer_id NOT IN (SELECT id FROM retail_customers)");
        // CASCADE tables: purge orphans (the customer is gone).
        db.exec("DELETE FROM retail_customer_vouchers   WHERE customer_id NOT IN (SELECT id FROM retail_customers)");
        db.exec("DELETE FROM retail_points_transactions WHERE customer_id NOT IN (SELECT id FROM retail_customers)");
        db.exec("DELETE FROM retail_topup_transactions  WHERE customer_id NOT IN (SELECT id FROM retail_customers)");
        const bad = db.pragma('foreign_key_check');
        if (bad.length) throw new Error('[fix_orphan_customer_fks_v1] residual FK violations: ' + JSON.stringify(bad).slice(0, 300));
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('fix_orphan_customer_fks_v1');
      })();
      console.log('[fix_orphan_customer_fks_v1] orphan customer FKs repaired');
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) { console.error('[fix_orphan_customer_fks_v1] failed (left untouched):', e); }

// ─────────────────────────────────────────────────────────────────────────
// Drop the retail_stock_ledger.actor_user_id → users(id) FK.
// actor_user_id records who made a stock movement, but the actor can be a
// kitchen users(id) OR a Mini App Backend operator's tenant_users(id) — two
// separate id spaces. The hard FK to users(id) rejected EVERY operator-driven
// ledger write with "FOREIGN KEY constraint failed" (stock save, order
// commit/reverse/refund) — the same trap as retail_vouchers.created_by. Make
// it a plain audit integer so any actor id is accepted; the operator's identity
// is still captured in logActivity + the ledger note.
//
// Rebuild reads the LIVE CREATE from sqlite_master (so ALTER-added columns and
// the already-repointed product FK come along), strips only the actor FK clause,
// and renames a temp table into place. Guarded + atomic; a residual
// foreign_key_check rolls the whole thing back and leaves prod untouched.
// ─────────────────────────────────────────────────────────────────────────
try {
  const done = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get('drop_ledger_actor_fk_v1');
  const haveLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retail_stock_ledger'").get();
  const hasActorFk = haveLedger && db.pragma('foreign_key_list(retail_stock_ledger)')
    .some(f => f.from === 'actor_user_id' && f.table === 'users');
  if (!done && hasActorFk) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    try {
      db.transaction(() => {
        const trow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='retail_stock_ledger'").get();
        const idxSqls = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='retail_stock_ledger' AND sql IS NOT NULL").all().map(r => r.sql);
        // Remove the actor FK clause (with its leading comma so no dangling comma
        // is left). Everything else — including the product FK already repointed
        // to store_products by store_products_seed_fk_v1 — is preserved verbatim.
        const createSql = trow.sql.replace(
          /,\s*FOREIGN\s+KEY\s*\(\s*actor_user_id\s*\)\s*REFERENCES\s+users\s*\(\s*id\s*\)/i, '');
        if (createSql === trow.sql) throw new Error('[drop_ledger_actor_fk_v1] actor FK clause not found in CREATE');
        const tmpSql = createSql.replace(
          /(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?)retail_stock_ledger(["`']?)/i,
          '$1_fk_tmp_retail_stock_ledger$2');
        if (tmpSql === createSql) throw new Error('[drop_ledger_actor_fk_v1] could not rename CREATE');
        db.exec(tmpSql);
        db.exec('INSERT INTO _fk_tmp_retail_stock_ledger SELECT * FROM retail_stock_ledger');
        db.exec('DROP TABLE retail_stock_ledger');
        db.exec('ALTER TABLE _fk_tmp_retail_stock_ledger RENAME TO retail_stock_ledger');
        for (const s of idxSqls) db.exec(s);
        const bad = db.pragma('foreign_key_check(retail_stock_ledger)');
        if (bad.length) throw new Error('[drop_ledger_actor_fk_v1] residual FK violations: ' + JSON.stringify(bad).slice(0, 300));
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run('drop_ledger_actor_fk_v1');
      })();
      console.log('[drop_ledger_actor_fk_v1] retail_stock_ledger actor FK dropped');
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) { console.error('[drop_ledger_actor_fk_v1] failed (left untouched):', e); }

// ── Meituan bidirectional sync (2026-06-22) ────────────────────────────────
// Four tables supporting automated stock push (roots-v2 → Meituan) and
// order ingestion (Meituan → roots-v2).

// Maps a roots-v2 (store, product) pair to Meituan product details.
// Populated via the admin Meituan→Products mapping UI or auto-match by name.
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_product_map (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id   INTEGER NOT NULL,
    product_id        INTEGER NOT NULL,
    store_code        TEXT NOT NULL,
    meituan_name      TEXT,
    last_pushed_qty   INTEGER,
    last_pushed_at    DATETIME,
    sync_enabled      INTEGER NOT NULL DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(retail_store_id, product_id),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id)      REFERENCES store_products(id) ON DELETE CASCADE
  );
`);

// Columns added after that table shipped. meituan_sku / meituan_spu_id /
// meituan_sku_id were created by a one-off catalog script and never declared
// here, so a fresh tenant DB went without them while the live one had them.
//
// meituan_sku_id + meituan_spec are the operator's answer to "which 规格 on this
// listing is this product?". A listing can hold several (the sorbet's pack
// counts, the hand soap's scents) and Meituan gives each its own stock; without
// a choice the driver writes the same number to all of them, so three Roots
// variants sharing one listing all read the same count. The id is the stock
// target; the label is cached for the admin row and as a fallback match when a
// listing edit re-issues sku ids.
addColumn('meituan_product_map', 'meituan_sku',    'TEXT');
addColumn('meituan_product_map', 'meituan_spu_id', 'TEXT');
addColumn('meituan_product_map', 'meituan_sku_id', 'TEXT');
addColumn('meituan_product_map', 'meituan_spec',   'TEXT');

// Queue of stock changes to push to Meituan. Written by retail.js whenever
// retail_store_stock is updated; consumed by the meituan-daemon process.
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_sync_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id  INTEGER NOT NULL,
    product_id       INTEGER NOT NULL,
    store_code       TEXT NOT NULL,
    new_qty          INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at     DATETIME,
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id),
    FOREIGN KEY (product_id)      REFERENCES store_products(id)
  );
`);

// Tracks which Meituan orders have been imported into roots-v2 (idempotency).
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_order_import (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    meituan_order_no  TEXT UNIQUE NOT NULL,
    retail_order_id   INTEGER,
    store_code        TEXT NOT NULL,
    accepted_at       DATETIME,
    imported_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    status            TEXT NOT NULL DEFAULT 'accepted',
    raw_payload       TEXT,
    FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE SET NULL
  );
`);

// Per-order action commands the admin enqueues for the daemon to click on Meituan
// (currently only 接单 / accept). Same hand-off pattern as meituan_sync_queue: the
// web server can't drive the daemon's Playwright Chrome, so it writes a row and the
// daemon drains it. GATED by MEITUAN_WRITEBACK on the daemon — with the flag off the
// rows just sit pending and nothing is ever clicked on the live merchant account.
// UNIQUE(order, action) makes a double-tap idempotent (a second accept can't refire).
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_order_actions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_order_id   INTEGER NOT NULL,
    meituan_order_no  TEXT NOT NULL,
    store_code        TEXT NOT NULL,
    action_type       TEXT NOT NULL,          -- accept (only, for now)
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|error
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    requested_by      TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at      DATETIME,
    UNIQUE(meituan_order_no, action_type),
    FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE CASCADE
  );
`);

// Append-only log of all sync events (order polls, stock pushes) for the
// admin sync-status panel and debugging.
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    status      TEXT NOT NULL,
    detail      TEXT,
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Cache of the actual product/listing titles scraped from each store's Meituan
// merchant backend. Written by the meituan-daemon when it runs a listing job;
// read by the admin Meituan tab to match roots products to their real Meituan
// names (instead of guessing from name_cn).
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code   TEXT NOT NULL,
    listing_name TEXT NOT NULL,
    scraped_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_code, listing_name)
  );
`);

// On-demand request channel: the admin enqueues a job, the daemon (which owns the
// logged-in browser sessions) picks it up, scrapes the Meituan product list, and
// fills meituan_listings. The web server can't drive Playwright itself, so the DB
// is the hand-off — same pattern as meituan_sync_queue.
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_listing_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|error
    result_count INTEGER,
    error        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
`);

// ── Store business-status (Meituan 营业/休息 open-close toggle) ────────────────
// Per-store open/closed state, shared between the web server and the sync daemons
// via the same DB hand-off as meituan_listing_jobs (the web server can't drive
// Playwright itself). The web server WRITES target_open (the operator's toggle)
// and READS the live status for the toggle UI; the daemon that owns the logged-in
// Meituan session APPLIES target_open by POSTing /api/poi/change_status
// (status=1 营业 / 3 停业), then reads /common/businessStatus back into these
// columns. See feature_meituan_store_open_close memory for the captured contract.
//   is_open     — last live read: 1 = 营业中 (mt_status 1), 0 = closed
//   mt_status   — raw Meituan status (1 open / 3 停业); sub_status = subStatus
//   target_open — pending operator command (1 open, 0 close); NULL = none. The
//                 daemon clears it to NULL once applied (result → last_result).
//   read_ok     — 1 if the last read reached the merchant API (else stale/logged out)
db.exec(`
  CREATE TABLE IF NOT EXISTS store_business_status (
    store_code   TEXT PRIMARY KEY,
    is_open      INTEGER,
    mt_status    INTEGER,
    sub_status   INTEGER,
    status_desc  TEXT,
    detail_desc  TEXT,
    hours_desc   TEXT,
    read_ok      INTEGER DEFAULT 0,
    read_at      DATETIME,
    target_open  INTEGER,
    target_by    TEXT,
    target_at    DATETIME,
    last_result  TEXT,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// fulfillment_open: whether this store still FULFILLS online orders — the whole
// shop, not one channel — SEPARATE from the Meituan-POI sales close
// (target_open/is_open above). When 0, lib/inventory drops the store from
// routeOrder's candidate pool, from analyzeShortage's (so a closed shop is never
// named as the customer's nearest store in the out-of-stock modal), from the
// pickup list and from the out-of-city shipper, so its online orders reroute to
// the store that is still open. Default 1 = fulfilling.
addColumn('store_business_status', 'fulfillment_open', 'INTEGER DEFAULT 1');
try { db.prepare('UPDATE store_business_status SET fulfillment_open = 1 WHERE fulfillment_open IS NULL').run(); } catch {}

// ── channel_status: per-(channel, store) open/closed matrix ───────────────────
// The sales grid is channel × location. This holds the closable cells for the
// OWNED / aggregator channels — mini_app + web (online storefront; per-store
// FULFILLMENT: an order for that channel won't route to a store whose cell is 0,
// and independently per channel — Tianhe can fulfill web but not mini_app), eleme
// (placeholder until integrated), and gzgrocery (tianhe-only). Meituan is NOT here
// — its per-POI 置休 lives in store_business_status (daemon-applied). A MISSING row
// means OPEN (default): we only store closures / explicit sets, and routeOrder +
// the admin matrix treat absent as open. Composes with (does NOT supersede)
// store_business_status.fulfillment_open: a store is closed for a channel when
// its cell here is 0 OR the whole shop is closed there.
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_status (
    channel     TEXT NOT NULL,   -- 'mini_app' | 'web' | 'eleme' | 'gzgrocery'
    store_code  TEXT NOT NULL,   -- retail_stores.code (gzgrocery: 'tianhe' only)
    is_open     INTEGER DEFAULT 1,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (channel, store_code)
  );
`);

// ── 青云聚信 (Qingyun, Meituan's delivery AGGREGATOR) courier-tracking ─────────
// Mirrors a delivery dispatched through saas.cyanclouds.com back to a roots order so
// we can relay live status + rider GPS to the customer. One row per Qingyun order
// (qingyun_order_id). Matched to a roots order via the 备注/userRemark we stamp with
// the roots order ref (fallback: recipient phone+address). Written by the
// qingyun-daemon; read by the customer order-tracking endpoint.
//   order_status / delivery_status — raw Qingyun enums (orderStatus: 20 待配送 →
//     30 in-flight → 50 已送达; deliveryStatus parallels). rider_lat/lng are GCJ-02
//     ×1e6 (store raw; divide by 1e6 for AMap). NULL once delivered (coords stop).
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    qingyun_order_id TEXT UNIQUE NOT NULL,
    retail_order_id  INTEGER,
    store_code       TEXT NOT NULL,
    channel_name     TEXT,            -- order source platform (channelName)
    carrier_name     TEXT,            -- 运力 that grabbed it (orderDeliveryInfo.carrierName)
    waybill_id       TEXT,            -- 运单号
    delivery_id      TEXT,
    rider_name       TEXT,
    rider_phone      TEXT,
    order_status     INTEGER,         -- raw Qingyun orderStatus enum
    delivery_status  INTEGER,         -- raw Qingyun deliveryStatus enum
    rider_lat        INTEGER,         -- GCJ-02 ×1e6 (NULL once delivered)
    rider_lng        INTEGER,
    rider_to_cust_m  INTEGER,         -- riderRecipientDistance (metres)
    eta_seconds      INTEGER,         -- routeInfo.duration
    recipient_name   TEXT,
    recipient_phone  TEXT,
    recipient_addr   TEXT,
    recipient_lat    INTEGER,         -- dropoff GCJ-02 ×1e6 (from order/list)
    recipient_lng    INTEGER,
    expected_delivery_at TEXT,
    raw_order        TEXT,            -- last order/list object (debug / first-capture)
    raw_track        TEXT,            -- last order/detail/coordinate payload
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE SET NULL
  );
`);
// An abandoned copy of a delivery: staff moved the order's pickup point to another
// store (the ship-from override in routes/retail.js re-creates it under that store's
// Qingyun account), so THIS row is the old location's leftover. It still sits in the
// old store's 待配送 list until staff cancel it there, and it still carries the roots
// order_no in its 备注 — so without this flag the daemon would keep re-linking it to
// the order and the drawer could show the abandoned copy instead of the live one.
// A superseded row is never matched to a roots order again.
addColumn('delivery_jobs', 'superseded', 'INTEGER NOT NULL DEFAULT 0');

// Append-only log of qingyun-daemon events (polls, track fetches, login/verify,
// proxy) for the admin sync-status panel and debugging. Same shape as
// meituan_sync_log so the panel can reuse its renderer.
db.exec(`
  CREATE TABLE IF NOT EXISTS qingyun_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    status      TEXT NOT NULL,
    detail      TEXT,
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Per-store heartbeat + login state for the qingyun-daemon, so the admin Delivery
// card can show a truthful "connected / not set up" status per store WITHOUT
// depending on delivery volume (an idle-but-connected store logs no polls). One
// row per store, upserted every poll — bounded, never grows.
db.exec(`
  CREATE TABLE IF NOT EXISTS qingyun_status (
    store_code  TEXT PRIMARY KEY,
    logged_in   INTEGER DEFAULT 0,   -- 1 = Chrome session valid on last poll
    last_ok     DATETIME,            -- last successful (logged-in) poll
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Auto-push queue: a paid mini-app/web DELIVERY order to create in Qingyun as a
// 待配送 order (no courier — staff still pick the carrier). The main app enqueues
// on payment (markOrderPaid); the qingyun-daemon (which holds the signed browser)
// drains it, calling order/create and stamping the roots order_no into 备注 so the
// existing tracking match links the rider back. One row per retail order (UNIQUE) =
// idempotent; never double-creates. Only first-party (mini-app/web) Guangzhou
// same-city, same-day orders are eligible (inventory.isQingyunSameCityToday) —
// out-of-city, later-day, and marketplace (Meituan/Eleme) orders are never queued.
// status: pending → processing → done | error | skipped (ineligible at drain)
//                 | needs_point (waiting for a human to confirm the drop-off)
//                 | awaiting_choice (the name search found several places and
//                   could not choose — waiting for a human to pick one).
db.exec(`
  CREATE TABLE IF NOT EXISTS qingyun_push_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_order_id  INTEGER NOT NULL UNIQUE,
    store_code       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|ready|done|error|skipped|needs_point|awaiting_choice
    -- 'ready' = address checked, copy deliberately NOT created yet: a booked order
    -- waiting for staff to call the delivery (lib/qingyun-queue.awaitingDispatch).
    qingyun_order_id TEXT,                             -- the created Qingyun order id
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE CASCADE
  );
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_qingyun_push_pending ON qingyun_push_queue(store_code, status)"); } catch {}
// A leftover the ship-from override couldn't clean up: when an order's pickup point
// moves, the copy at the OLD location is deleted from Qingyun automatically. If that
// delete fails (session blip, Qingyun refuses), the old copy is still sitting in that
// store's list where someone could dispatch it — so we remember which one, and the
// order drawer offers a Remove button until it's gone. Cleared on success.
addColumn('qingyun_push_queue', 'stale_qingyun_order_id', 'TEXT');
addColumn('qingyun_push_queue', 'stale_store_code', 'TEXT');
// When a push was held because the GEOCODER was unreachable (quota, timeout,
// network) rather than because anything was wrong with the address. Such a push
// must not spend a retry attempt — nothing was learned — so the row stays
// pending and this records when the hold began, which is what the daemon's
// outage alert measures. NULL = not held. See lib/qingyun-queue HOLD_SQL.
addColumn('qingyun_push_queue', 'geo_held_at', 'DATETIME');

// ── Waiting for a human to say where the door is ──────────────────────────
// The address only resolves to a coarse AREA (a district or city centre) and
// the coordinates the order carries have no provenance — so nothing here knows
// the door to within kilometres. We used to call that an error and give up
// after five identical attempts, which was wrong twice over: the coordinate was
// almost always minted by one of our OWN text geocodes (nobody did anything
// wrong), and retrying re-asks a question whose answer cannot change. It is an
// unfinished step, not a failure.
//
// So the row parks in status='needs_point', spends no attempt, and waits.
//   needs_point_at    — when it started waiting (first entry wins, so the age
//                       is the age of the wait, not of the last drain).
//   guessed_*         — the point we WOULD have sent and how exact the provider
//                       said it was. Kept so the confirm map opens on the best
//                       guess we have instead of on an empty country.
// NULL on every row that predates this — see lib/qingyun-queue NEEDS_POINT_SQL.
addColumn('qingyun_push_queue', 'needs_point_at',    'DATETIME');
addColumn('qingyun_push_queue', 'guessed_lat',       'REAL');
addColumn('qingyun_push_queue', 'guessed_lng',       'REAL');
addColumn('qingyun_push_queue', 'guessed_precision', 'TEXT');

// ── Waiting for a human to say WHICH PLACE ────────────────────────────────
// The other half of the same idea, and a different question. A Chinese
// residential address is a named place plus a last-mile tail
// (祈福新村倚湖湾 · 5座1106); the named half is looked up by NAME SEARCH, because
// geocoding indexes streets and house numbers and has no 小区 index at all.
// When that search comes back with several places and none is obviously the
// one (lib/qingyun-payload POI_AUTO_SCORE), the row parks here instead — with
// the candidates, because they are what the operator answers with.
//
//   candidates_json — the ranked top few, as stored by AWAITING_CHOICE_SQL:
//                     [{ lat, lng, name, address, score, shared, dropKm,
//                        provider, rank }] with lat/lng as GCJ-02 ×1e6 ints,
//                     matching what order/create takes. Read through
//                     lib/qingyun-queue readCandidates(), which treats absent
//                     or unparseable JSON as "no candidates" — that degrades
//                     to the map surface rather than to an empty question.
//
// needs_point_at is REUSED as the parked-at stamp for both states rather than
// growing a second timestamp: every reader wants "how long has this been
// waiting", the two states are mutually exclusive on a row, and a second column
// would be null in exactly the cases the first one is set. The status says
// which kind of wait it is.
addColumn('qingyun_push_queue', 'candidates_json',   'TEXT');

// Meituan-only bundles (套餐/combos) that have no single roots product. Each is
// defined as a set of component products; its sellable stock is computed as the
// minimum of what its components can make, and pushed to the bundle's Meituan
// listing. When any component runs out, the bundle auto-drops to 0.
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_bundles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id  INTEGER NOT NULL,
    store_code       TEXT NOT NULL,
    meituan_name     TEXT NOT NULL,
    max_qty          INTEGER,            -- optional cap on the pushed stock
    sync_enabled     INTEGER NOT NULL DEFAULT 1,
    last_pushed_qty  INTEGER,
    last_pushed_at   DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(retail_store_id, meituan_name),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS meituan_bundle_components (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id   INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 1,   -- units of this product per bundle
    UNIQUE(bundle_id, product_id),
    FOREIGN KEY (bundle_id)  REFERENCES meituan_bundles(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES store_products(id)  ON DELETE CASCADE
  );
`);

// The sync queue can carry bundle pushes too: when bundle_id is set, the daemon
// updates the listing named meituan_name instead of looking up a product.
for (const [col, ddl] of [['meituan_name', 'TEXT'], ['bundle_id', 'INTEGER']]) {
  try { db.exec(`ALTER TABLE meituan_sync_queue ADD COLUMN ${col} ${ddl}`); } catch (e) { /* column exists */ }
}

// ── Migration: repoint Meituan product_id FKs to store_products ──────────────
// These three tables were created with product_id → products(id) (the kitchen
// catalog). The storefront forked to store_products (own id space), which is
// what the Meituan admin, stock, and bundles key off — so a product_id that
// only exists in store_products (any post-fork variant) failed the FK on save
// ("FOREIGN KEY constraint failed"). SQLite can't ALTER a constraint, so rebuild
// each table verbatim with the one word changed. Idempotent: skips a table whose
// product_id FK already targets store_products. Existing rows are copied as-is
// (validation is off during the swap; forked-era ids match 1:1 anyway).
function repointMeituanProductFk(database, table) {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
  if (!row || !row.sql) return;
  const fks = database.pragma(`foreign_key_list(${table})`);
  if (!fks.some(f => f.from === 'product_id' && f.table === 'products')) return;
  // \s+ before "products" means "store_products" (no leading space) is left alone.
  const newSql = row.sql.replace(/REFERENCES\s+products\s*\(/gi, 'REFERENCES store_products(');
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(`ALTER TABLE ${table} RENAME TO ${table}__fkmig`);
      database.exec(newSql);
      database.exec(`INSERT INTO ${table} SELECT * FROM ${table}__fkmig`);
      database.exec(`DROP TABLE ${table}__fkmig`);
    })();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
for (const t of ['meituan_product_map', 'meituan_bundle_components', 'meituan_sync_queue']) {
  try { repointMeituanProductFk(db, t); } catch (e) { console.error(`[meituan-fk] ${t}:`, e.message); }
}

// ── Migration: meituan_sync_queue.product_id must be NULLABLE ────────────────
// Bundle pushes carry product_id = NULL (the listing is keyed by bundle_id +
// meituan_name, not a single product). The table was first created with
// product_id INTEGER NOT NULL, so "Push all stock now" blew up on the first
// bundle with "NOT NULL constraint failed: meituan_sync_queue.product_id".
// SQLite can't drop a NOT NULL in place, so rebuild the table verbatim with
// that one constraint removed. Idempotent: skips if product_id is already
// nullable.
(function dropMeituanQueueProductNotNull(database) {
  const col = database.pragma('table_info(meituan_sync_queue)')
    .find(c => c.name === 'product_id');
  if (!col || col.notnull === 0) return;  // already nullable (or table absent)
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='meituan_sync_queue'"
  ).get();
  if (!row || !row.sql) return;
  const newSql = row.sql.replace(
    /(product_id\s+INTEGER)\s+NOT\s+NULL/i, '$1'
  );
  if (newSql === row.sql) return;  // pattern didn't match — leave it alone
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec('ALTER TABLE meituan_sync_queue RENAME TO meituan_sync_queue__nnmig');
      database.exec(newSql);
      database.exec('INSERT INTO meituan_sync_queue SELECT * FROM meituan_sync_queue__nnmig');
      database.exec('DROP TABLE meituan_sync_queue__nnmig');
    })();
  } finally {
    database.pragma('foreign_keys = ON');
  }
})(db);

// ── Eleme open-platform sync (饿了么开放平台, 2026-06-28) ─────────────────────
// A third sales channel, structurally parallel to the Meituan layer above but
// driven by Eleme's GENUINE OAuth2 + JSON-RPC open API (open-api.shop.ele.me) —
// no headless browser, proxy, or risk-control dance. The eleme-daemon process
// holds a per-account access_token, pulls new orders (decrementing our stock),
// and pushes stock changes (resolve item by 货号/extendCode → batchUpdateStock).
// Feature is on/off per tenant via storefront_config key 'eleme.enabled'.

// Per-authorised-account OAuth token store. One row per `account` (we key it by
// store_code so each store authorises its own Eleme shop). access_token is
// short-lived; refresh_token rotates it. expires_at is an absolute epoch-ms so
// the daemon can refresh proactively. Written by the OAuth callback + daemon.
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account       TEXT UNIQUE NOT NULL,      -- store_code (one Eleme shop per store)
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT,
    scope         TEXT,
    expires_at    INTEGER,                   -- epoch-ms when access_token expires
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Maps a roots store to its Eleme shop. The OAuth grant exposes the merchant's
// shop ids; the operator picks which Eleme shop this roots store mirrors. shop_id
// is the argument every product/order API call needs.
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_shops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id INTEGER NOT NULL,
    store_code      TEXT NOT NULL,
    shop_id         TEXT,
    shop_name       TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(retail_store_id),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE
  );
`);

// Roots product ↔ Eleme listing bridge. Eleme resolves a listing by its 货号
// (extendCode) which we hold in store_products.sku, so most products auto-map by
// SKU and no manual name entry is needed (unlike Meituan 外卖). extend_code is an
// optional override when a store's Eleme 货号 differs from our SKU; spec_id /
// item_id cache the resolved Eleme ids so the daemon skips re-lookup.
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_product_map (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id   INTEGER NOT NULL,
    product_id        INTEGER NOT NULL,
    store_code        TEXT NOT NULL,
    extend_code       TEXT,                  -- override 货号; NULL = use store_products.sku
    eleme_name        TEXT,                  -- cached Eleme item title (display only)
    item_id           TEXT,                  -- cached Eleme item id
    spec_id           TEXT,                  -- cached Eleme spec id (the stock target)
    last_pushed_qty   INTEGER,
    last_pushed_at    DATETIME,
    sync_enabled      INTEGER NOT NULL DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(retail_store_id, product_id),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id)      REFERENCES store_products(id) ON DELETE CASCADE
  );
`);

// Queue of stock changes to push to Eleme. Written by enqueueChannelSync whenever
// retail_store_stock moves; consumed by the eleme-daemon.
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_sync_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id  INTEGER NOT NULL,
    product_id       INTEGER NOT NULL,
    store_code       TEXT NOT NULL,
    new_qty          INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at     DATETIME,
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id),
    FOREIGN KEY (product_id)      REFERENCES store_products(id)
  );
`);

// Idempotency ledger for Eleme orders mirrored into roots (deducts stock once).
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_order_import (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    eleme_order_id  TEXT UNIQUE NOT NULL,
    retail_order_id INTEGER,
    store_code      TEXT NOT NULL,
    imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    status          TEXT NOT NULL DEFAULT 'imported',
    raw_payload     TEXT,
    FOREIGN KEY (retail_order_id) REFERENCES retail_orders(id) ON DELETE SET NULL
  );
`);

// Append-only sync event log for the admin Eleme tab + debugging.
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    status      TEXT NOT NULL,
    detail      TEXT,
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// A cached copy of each store's live Eleme listing names, refreshed
// periodically by eleme-daemon.js (lib/eleme-browser.js's catalogueSnapshot).
// Eleme's real catalogue only exists inside the daemon's browser session — a
// separate process from this admin server — so the admin can't fetch it live
// on page load without driving a second, competing browser login. This table
// is the bridge: the daemon writes it, the admin API just reads it. Powers
// the "Eleme listing name" autocomplete in the product mapping table (built
// after a live mismatch — a hand-typed name used the wrong apostrophe
// character and silently failed every push).
db.exec(`
  CREATE TABLE IF NOT EXISTS eleme_catalogue_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code      TEXT NOT NULL,
    name            TEXT NOT NULL,
    item_global_id  TEXT,
    stock           INTEGER,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_code, name)
  );
`);
// One Eleme listing can hold several sizes (规格) behind one name — a size picker
// on the customer's side. `specs` is the JSON array of them, written by the
// daemon from the same catalogue read that fills the row above:
// [{ specGlobalId, name, price, stock }]. Without it the admin has no way to
// offer "which size is this", so both Roots size-variants pointed at the one
// listing name and their pushes overwrote each other (天河, 17 groups).
addColumn('eleme_catalogue_cache', 'specs', 'TEXT');
// The size the operator picked, resolved against specs above. spec_id already
// existed on the table (declared, never written); spec_name is display-only so
// the admin can show the choice back without re-reading the catalogue.
addColumn('eleme_product_map', 'spec_name', 'TEXT');
// Tier 1 order collection: the per-order economics Eleme only exposes on the
// order-detail read (merchant income after commission, the platform-vs-merchant
// discount split, packaging/delivery fees), plus the raw list row. Kept here
// rather than as new retail_orders columns because only this channel populates
// them and nothing in the UI reads them yet — and because a raw copy is what
// makes a wrong money-unit guess (ELEME_MONEY_SCALE) recoverable from stored
// data instead of needing the order re-read from Eleme.
addColumn('eleme_order_import', 'detail_json', 'TEXT');

// ── One claim per option, and how many units that option sells ──────────────
// Both channel maps were UNIQUE(retail_store_id, product_id): a Roots product
// could point at exactly ONE 规格. That is wrong for a multipack listing —
// "咖啡大师 Oatly Barista" sells the same bottle as 1瓶 / 3瓶 / 6瓶, three
// options behind one name, each with its own stock box on the platform. One row
// claimed one box; the other two kept the 999/9999 the merchant first typed and
// sold without limit, and a 6-bottle sale deducted one bottle.
//
// A map row is now a claim on ONE option, and a product may hold several:
//
//   • units_per_pack — how many Roots units one sale of this option consumes.
//     The push writes floor(stock / units); an order deducts qty × units. 1 for
//     every row that already existed, which is what they all meant.
//
//   • spec_key — which option this row claims, '' meaning the listing as a whole
//     (what every pre-existing row means, and what a single-option listing still
//     means). Kept as a plain column rather than an expression index so every
//     ON CONFLICT target stays a column list.
//
// Two unique indexes take over from the dropped constraint:
//   • (store, product, spec_key) — a product claims an option at most once.
//   • (store, listing, spec_key) for a real option — an option belongs to at
//     most one product, so two products can't overwrite each other's box.
//
// The second one can legitimately fail to build on an existing DB: 天河 has two
// Roots products (a whole loaf and a 3-slice pack) both claiming one Eleme
// option, which is the exact collision it exists to stop. A live conflict is
// the operator's to resolve in the admin, not a reason to refuse to boot — so
// it logs what collided and carries on, and the admin write path enforces the
// same rule for anything new.
const PACK_MAPS = [
  { table: 'meituan_product_map', listing: 'meituan_name', spec: 'meituan_sku_id', label: 'meituan_spec' },
  { table: 'eleme_product_map',   listing: 'eleme_name',   spec: 'spec_id',        label: 'spec_name'    },
];

for (const m of PACK_MAPS) {
  addColumn(m.table, 'units_per_pack', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(m.table, 'spec_key',       "TEXT NOT NULL DEFAULT ''");

  // Backfill the key from whichever spec column the row already carried. The id
  // is preferred; the label is the fallback for a row mapped before ids were
  // read (Meituan has 3 of those, and a label is still a stable key for a
  // listing whose options are named). Only rows that are still blank, so this
  // is idempotent and never overwrites a key the admin has since written.
  try {
    db.prepare(`
      UPDATE ${m.table}
         SET spec_key = COALESCE(NULLIF(TRIM(${m.spec}), ''), NULLIF(TRIM(${m.label}), ''), '')
       WHERE spec_key = ''
    `).run();
  } catch (e) { console.error(`[pack-claims] ${m.table} spec_key backfill:`, e.message); }

  // Drop UNIQUE(retail_store_id, product_id). SQLite can't drop a constraint in
  // place, so rebuild the table verbatim with that one line removed. Idempotent:
  // skips a table that no longer declares it.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(m.table);
    if (row && row.sql && /UNIQUE\s*\(\s*retail_store_id\s*,\s*product_id\s*\)/i.test(row.sql)) {
      const newSql = row.sql
        .replace(/,?\s*UNIQUE\s*\(\s*retail_store_id\s*,\s*product_id\s*\)/i, '');
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`ALTER TABLE ${m.table} RENAME TO ${m.table}__packmig`);
          db.exec(newSql);
          db.exec(`INSERT INTO ${m.table} SELECT * FROM ${m.table}__packmig`);
          db.exec(`DROP TABLE ${m.table}__packmig`);
        })();
      } finally { db.pragma('foreign_keys = ON'); }
      console.log(`[pack-claims] ${m.table}: product uniqueness moved to the option`);
    }
  } catch (e) { console.error(`[pack-claims] ${m.table} rebuild:`, e.message); }

  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${m.table}_claim
               ON ${m.table} (retail_store_id, product_id, spec_key)`);
  } catch (e) { console.error(`[pack-claims] ${m.table} claim index:`, e.message); }

  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${m.table}_option
               ON ${m.table} (retail_store_id, ${m.listing}, spec_key)
            WHERE spec_key <> '' AND ${m.listing} IS NOT NULL`);
  } catch (e) {
    // Name the collision rather than just the failure — "index not created" is
    // not actionable, "these two products claim this option" is.
    let detail = '';
    try {
      detail = db.prepare(`
        SELECT GROUP_CONCAT(x, ' | ') AS s FROM (
          SELECT ${m.listing} || ' [' || spec_key || '] ×' || COUNT(*) AS x
            FROM ${m.table}
           WHERE spec_key <> '' AND ${m.listing} IS NOT NULL
           GROUP BY retail_store_id, ${m.listing}, spec_key
          HAVING COUNT(*) > 1)
      `).get()?.s || '';
    } catch (_) {}
    console.error(`[pack-claims] ${m.table}: two products share one option, left unindexed — ${detail || e.message}`);
  }
}

// ── Guanyi ERP sync (gzgrocery backoffice, 2026-06-24) ──────────────────────
// Mirrors the Meituan sync layer for a second sales channel: 管易C-ERP
// (v2.guanyierp.com). Roots has a limited sub-account that sees only Roots
// products in gzgrocery's tenant. Goal: keep gzgrocery's on-hand equal to our
// Tianhe warehouse stock. Unlike Meituan (which SETs an absolute number), Guanyi
// is an ERP — stock only moves via inbound/outbound documents — so the daemon
// computes a delta (target − Guanyi current) and creates an 其他入库单 (inbound)
// or 其他出库单 (outbound), then approves it. See lib/guanyi-browser.js.

// Maps a roots-v2 (store, product) pair to its Guanyi product. Guanyi's own code
// (商品规格代码, e.g. 7000110821) is NOT our SKU; instead our SKU ("1-180") is
// embedded in the Guanyi product name ("GVF 1-180 …"). The admin tab auto-matches
// by that SKU and caches Guanyi's internal ids here so the daemon writes without
// re-resolving. guanyi_code is the barCode used to look a line item up / build it.
db.exec(`
  CREATE TABLE IF NOT EXISTS guanyi_product_map (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id     INTEGER NOT NULL,
    product_id          INTEGER NOT NULL,
    store_code          TEXT NOT NULL,
    guanyi_name         TEXT,          -- matched Guanyi itemName (display/audit)
    guanyi_code         TEXT,          -- Guanyi itemCode/skuCode/barCode (resolution + line item)
    guanyi_sku_id       TEXT,          -- Guanyi internal sku id (row id in skuDTO)
    guanyi_item_id      TEXT,          -- Guanyi item id
    guanyi_item_sku_id  TEXT,          -- Guanyi itemSkuId
    last_pushed_qty     INTEGER,       -- the target we last reconciled to
    last_delta          INTEGER,       -- last inbound(+)/outbound(−) amount applied
    last_pushed_at      DATETIME,
    sync_enabled        INTEGER NOT NULL DEFAULT 1,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(retail_store_id, product_id),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id)      REFERENCES store_products(id) ON DELETE CASCADE
  );
`);

// Queue of stock targets to reconcile into Guanyi. new_qty is the ABSOLUTE target
// (our Tianhe physical_qty at enqueue time); the daemon reads Guanyi's current
// qty and creates an inbound/outbound document for the difference. Written by
// lib/inventory.js on any stock change; consumed by the guanyi-daemon process.
db.exec(`
  CREATE TABLE IF NOT EXISTS guanyi_sync_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id  INTEGER NOT NULL,
    product_id       INTEGER NOT NULL,
    store_code       TEXT NOT NULL,
    new_qty          INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at     DATETIME,
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id),
    FOREIGN KEY (product_id)      REFERENCES store_products(id)
  );
`);

// Append-only log of sync events (listing refreshes, stock pushes) for the admin
// Guanyi tab status panel and debugging.
db.exec(`
  CREATE TABLE IF NOT EXISTS guanyi_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    status      TEXT NOT NULL,
    detail      TEXT,
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Cache of the Guanyi product list (POST /stock/message/stock_tenant/data/list)
// scraped by the daemon. Read by the admin tab to auto-match each Roots product
// to its Guanyi entry by the SKU embedded in guanyi_name, and to show current
// Guanyi on-hand. Replaced wholesale per store on each refresh.
db.exec(`
  CREATE TABLE IF NOT EXISTS guanyi_listings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code    TEXT NOT NULL,
    guanyi_name   TEXT NOT NULL,
    code          TEXT,         -- itemCode/skuCode/barCode
    sku_id        TEXT,         -- Guanyi internal sku id
    item_id       TEXT,
    item_sku_id   TEXT,
    warehouse_id  TEXT,
    warehouse_name TEXT,
    current_qty   INTEGER,      -- Guanyi salable/on-hand at scrape time
    scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_code, sku_id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gyl_store ON guanyi_listings(store_code)`); } catch (e) {}

// On-demand request channel (same hand-off pattern as meituan_listing_jobs): the
// admin enqueues a refresh job, the daemon (which owns the logged-in browser)
// runs it and fills guanyi_listings.
db.exec(`
  CREATE TABLE IF NOT EXISTS guanyi_listing_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|processing|done|error
    result_count INTEGER,
    error        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
`);

module.exports = db;
module.exports.repointMeituanProductFk = repointMeituanProductFk;
module.exports.FREE_SHIPPING_THRESHOLD_DEFAULT = FREE_SHIPPING_THRESHOLD_DEFAULT;
