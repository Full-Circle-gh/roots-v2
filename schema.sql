-- ══════════════════════════════════════════════════════════════════
-- ROOTS SYSTEM v2 — Database Schema
-- PostgreSQL / SQLite compatible (using SQLite for v1)
-- ══════════════════════════════════════════════════════════════════

-- ── Users & Auth ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'kitchen', -- admin|manager|warehouse|kitchen
  display_name TEXT,
  is_active   INTEGER DEFAULT 1,
  last_login  DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE,
  dashboard   INTEGER DEFAULT 1,
  recipes     INTEGER DEFAULT 1,
  ingredients INTEGER DEFAULT 1,
  products    INTEGER DEFAULT 0,
  purchases   INTEGER DEFAULT 0,
  finance     INTEGER DEFAULT 0,
  sales       INTEGER DEFAULT 0,
  kitchen     INTEGER DEFAULT 1,
  waste       INTEGER DEFAULT 1,
  restock     INTEGER DEFAULT 0,
  alerts      INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── Ingredients ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingredients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en       TEXT NOT NULL,
  name_cn       TEXT,
  sku           TEXT UNIQUE,
  category      TEXT,
  unit          TEXT DEFAULT 'g',      -- recipe unit (g/ml/pcs)
  buy_unit      TEXT DEFAULT 'kg',     -- purchase unit
  buy_pack_size REAL DEFAULT 1000,     -- buy_units per package
  pack_contents_qty  REAL,             -- contents qty inside one buy_unit (e.g. 1.0 for a 1 kg bottle)
  pack_contents_unit TEXT,             -- contents unit (g/kg/ml/L) — required when buy_unit is bottle/bag/box/can/pcs
  cost_per_unit REAL DEFAULT 0,        -- cost per recipe unit (¥/g)
  -- Deliberately free: water, peel, anything the kitchen does not cost. It is
  -- NOT the same as "nobody typed a price" — a flagged item never counts as a
  -- missing cost and never takes a price from a PO. Without the distinction a
  -- warning fires on 26 recipes for tap water and gets trained away.
  free_by_design INTEGER DEFAULT 0,
  buy_price     REAL DEFAULT 0,        -- purchase price per package
  supplier      TEXT,                  -- free-text supplier name
  supplier_platform TEXT,              -- alibaba | taobao | wechat | other
  supplier_link TEXT,                  -- URL (for alibaba/taobao)
  supplier_qr_data TEXT,               -- base64 data URI (for wechat QR)
  allergens     TEXT,                  -- JSON array
  notes         TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ingredient_price_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL,
  price         REAL NOT NULL,
  buy_unit      TEXT,
  source        TEXT DEFAULT 'manual', -- manual|po_import|zoho_import
  notes         TEXT,
  recorded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  recorded_by   TEXT,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── Recipes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en       TEXT NOT NULL,
  name_cn       TEXT,
  sku           TEXT UNIQUE,
  category      TEXT,
  batch_size    REAL,                  -- total grams per batch
  servings      INTEGER,
  serving_size  REAL,                  -- grams per serving
  shelf_life    TEXT,
  storage       TEXT,
  notes         TEXT,
  -- 'made' | 'repacked'. Filing only: what kind of thing this recipe is, so a
  -- bulk sack poured into retail bags can be told from something genuinely
  -- cooked. Stored, never inferred, and editable per recipe -- the one-line
  -- heuristic the backfill uses (database.js recipe_type_backfill_v1) is a
  -- starting point, not a truth. NOTHING may gate on this: cost, margin, the
  -- recipe-to-product link, nested recipes and the material link all behave
  -- identically whichever value a recipe carries.
  recipe_type   TEXT DEFAULT 'made',
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL,
  ingredient_id INTEGER,               -- NULL if ingredient deleted
  name_en       TEXT NOT NULL,         -- snapshot at time of creation
  name_cn       TEXT,
  sku           TEXT,
  qty           REAL NOT NULL,
  unit          TEXT DEFAULT 'g',
  notes         TEXT,
  sort_order    INTEGER DEFAULT 0,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE IF NOT EXISTS recipe_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL,
  step_number   INTEGER NOT NULL,
  name          TEXT,
  instructions  TEXT,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipe_cost_data (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL UNIQUE,
  labour        REAL DEFAULT 0,
  packaging     REAL DEFAULT 0,        -- per serving
  packaging_type_id INTEGER,
  overhead_pct  REAL DEFAULT 0,
  sell_price    REAL DEFAULT 0,
  target_food_cost REAL DEFAULT 30,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

-- ── Products ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en         TEXT NOT NULL,
  name_cn         TEXT,
  sku             TEXT UNIQUE,
  category        TEXT,
  recipe_id       INTEGER,               -- linked recipe (for cost calc)
  status          TEXT DEFAULT 'Active', -- Active|Inactive|Seasonal|Coming Soon
  sell_price      REAL DEFAULT 0,
  weight          TEXT,                  -- freeform: "150g", "1 pc", "200ml"
  barcode         TEXT,
  description_en  TEXT,
  description_cn  TEXT,
  free_of         TEXT,                  -- comma-list: gluten,nuts,soy,dairy,egg,5spice
  image_data      TEXT,                  -- base64 data URI
  label_data      TEXT,                  -- base64 data URI
  image_url       TEXT,                  -- reserved for future CDN-hosted images
  label_url       TEXT,                  -- reserved for future CDN-hosted labels
  notes           TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id)
);

-- ── Purchase Orders ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number     TEXT UNIQUE NOT NULL,
  date          DATE NOT NULL,
  delivery_date DATE,
  status        TEXT DEFAULT 'Requested', -- Requested|Ordered|Delivered|Confirmed|Cancelled
  warehouse     TEXT,
  supplier      TEXT,
  notes         TEXT,
  source        TEXT DEFAULT 'manual',  -- manual|kitchenOrder|import
  posted_to_accounting INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS po_line_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id         INTEGER NOT NULL,
  ingredient_id INTEGER,
  name_en       TEXT NOT NULL,
  name_cn       TEXT,
  sku           TEXT,
  qty           REAL NOT NULL,
  unit          TEXT,
  weight_kg     REAL,
  cost_per_unit REAL DEFAULT 0,
  total_cost    REAL DEFAULT 0,
  expense_category TEXT,
  lot_number    TEXT,                  -- supplier batch / lot number for recall traceability
  expiry_date   DATE,                  -- ingredient expiry from this delivery
  sort_order    INTEGER DEFAULT 0,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);
-- Indexes for lot_number / expiry_date are created by database.js *after* the
-- ALTER TABLE migration that adds those columns to existing prod databases.
-- Putting them here would fail on the existing po_line_items where the column
-- isn't present yet (since CREATE TABLE IF NOT EXISTS is a no-op on a
-- pre-existing table, the new columns only land via the migration block).

-- ── Finance ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS income_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  amount        REAL NOT NULL,
  category      TEXT,
  description   TEXT,
  channel       TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expense_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  amount        REAL NOT NULL,
  category      TEXT,
  description   TEXT,
  po_id         INTEGER,               -- linked PO if from purchasing
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ── Sales ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  product_id    INTEGER,
  product_name  TEXT NOT NULL,
  channel       TEXT,                  -- Dine-in|Takeout|Delivery|etc
  qty           REAL NOT NULL,
  unit_price    REAL NOT NULL,
  total         REAL NOT NULL,
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Add-ons that came bundled with a sale (e.g. "Hummus + Pack of Crackers").
-- Revenue stays on the parent sales_entries row — this table only tracks
-- the secondary product so its inventory & cost can be accounted for.
CREATE TABLE IF NOT EXISTS sale_addons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id             INTEGER NOT NULL,
  addon_product_id    INTEGER NOT NULL,
  qty                 REAL NOT NULL DEFAULT 1,
  source              TEXT,    -- 'miniapp' | 'pos' | 'manual'
  source_combine_with TEXT,    -- raw string from import for traceability
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sale_id)          REFERENCES sales_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (addon_product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_sale_addons_sale    ON sale_addons(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_addons_product ON sale_addons(addon_product_id);

-- ── Waste ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waste_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  product_id    INTEGER,
  product_name  TEXT NOT NULL,
  product_sku   TEXT,
  qty           REAL NOT NULL,
  unit          TEXT,
  reason        TEXT,
  cost_lost     REAL DEFAULT 0,
  retail_value  REAL DEFAULT 0,
  staff_name    TEXT,
  shift         TEXT,
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ── Restock ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restock_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rs_number     TEXT UNIQUE NOT NULL,
  date          DATE NOT NULL,
  status        TEXT DEFAULT 'draft',  -- draft|sent|received|prepared|delivered
  store_name    TEXT,
  store_cn      TEXT,
  notes         TEXT,
  wh_notes      TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at       DATETIME,
  received_at   DATETIME,
  prepared_at   DATETIME,
  delivered_at  DATETIME,
  created_by    INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS restock_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restock_id    INTEGER NOT NULL,
  product_id    INTEGER,
  product_name  TEXT NOT NULL,
  product_cn    TEXT,
  sku           TEXT,
  qty_requested REAL NOT NULL,
  qty_sent      REAL,
  unit          TEXT,
  notes         TEXT,
  is_checked    INTEGER DEFAULT 0,
  FOREIGN KEY (restock_id) REFERENCES restock_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ── Production Batches (kitchen production log) ─────────────────────
-- Logs that we made N servings (or N batches) of a recipe on a given date.
-- Pairs with the recipe scaler: scale up → produce → log here. Becomes
-- the foundation for inventory deduction once that's wired in.
CREATE TABLE IF NOT EXISTS production_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          DATE NOT NULL,
  recipe_id     INTEGER,                 -- nullable: recipe might be deleted later
  recipe_name   TEXT NOT NULL,           -- snapshot
  recipe_sku    TEXT,                    -- snapshot
  batches_made  REAL DEFAULT 1,          -- multiplier on the recipe's batch_size
  servings_made REAL,                    -- absolute serving count (computed if null)
  staff_name    TEXT,
  shift         TEXT,
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_production_date ON production_batches(date);
CREATE INDEX IF NOT EXISTS idx_production_recipe ON production_batches(recipe_id);

-- ── Kitchen Orders ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kitchen_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ko_number     TEXT UNIQUE NOT NULL,
  date          DATE NOT NULL,
  status        TEXT DEFAULT 'pending',
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS kitchen_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ko_id         INTEGER NOT NULL,
  ingredient_id INTEGER,
  name_en       TEXT NOT NULL,
  name_cn       TEXT,
  sku           TEXT,
  qty           REAL NOT NULL,
  unit          TEXT,
  notes         TEXT,
  FOREIGN KEY (ko_id) REFERENCES kitchen_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── Packaging Types ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS packaging_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  name_cn       TEXT,
  cost          REAL DEFAULT 0,
  image_data    TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── Suppliers (separate entity so ratings + payment terms aren't
--    duplicated across every ingredient row) ──────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  name_cn       TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  contact_wechat TEXT,
  payment_terms TEXT,                  -- e.g. "Net 30", "COD", "Prepay" (WHEN we pay)
  payment_method TEXT,                 -- e.g. "WeChat", "Alipay", "Bank" (HOW we pay)
  rating        INTEGER DEFAULT 0,     -- 0..5
  notes         TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Multi-document store for suppliers (license, permits, payment QR, other).
-- Supports images / PDFs / Excel / CSV — mime_type tells the UI how to render.
CREATE TABLE IF NOT EXISTS supplier_documents (
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
);

-- ── Shared Categories (multi-user; replaces localStorage) ─────────
-- kind: 'recipe' | 'product' (extensible)
CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  sort_order    INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, name)
);

-- ── Price Alerts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL,
  old_price     REAL,
  new_price     REAL,
  change_pct    REAL,
  is_read       INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── Cost write-back skips ─────────────────────────────────────────
-- One row each time a PO price was NOT written into an ingredient's
-- cost_per_unit, and why. The write-back refuses rather than store a
-- number it cannot defend (routes/purchases.js firePriceAlertsForPO),
-- so without this the refusal would be invisible and the item's cost
-- would quietly go stale. Surfaced in the Alerts page.
CREATE TABLE IF NOT EXISTS ingredient_cost_skips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL,
  po_id         INTEGER,
  -- One of a fixed set, stored raw so each can be counted on its own:
  -- no_pack_contents | unit_mismatch | unsupported_recipe_unit |
  -- no_pack_size | no_price | marked_free | source_recipe_linked.
  -- Display text lives in the Alerts page.
  reason        TEXT NOT NULL,
  line_unit     TEXT,            -- the unit written on the PO line
  line_price    REAL,            -- the price we declined to write
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Set when a later PO priced this item cleanly. The row stays as a record of
  -- what once went unpriced; only open rows (resolved_at IS NULL) alert.
  resolved_at   DATETIME,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── Activity Log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  username      TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,                  -- ingredient|recipe|product|po|etc
  entity_id     INTEGER,
  details       TEXT,                  -- JSON
  ip_address    TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── Indexes for performance ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ingredients_sku ON ingredients(sku);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category);
CREATE INDEX IF NOT EXISTS idx_recipes_sku ON recipes(sku);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ingredient ON recipe_ingredients(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_po ON po_line_items(po_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_entries(date);
CREATE INDEX IF NOT EXISTS idx_waste_date ON waste_entries(date);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
