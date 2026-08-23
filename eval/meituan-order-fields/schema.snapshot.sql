CREATE TABLE store_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_cn TEXT,
  sku TEXT,
  category TEXT,
  recipe_id INTEGER,
  status TEXT DEFAULT 'Active',
  sell_price REAL DEFAULT 0,
  weight REAL,
  barcode TEXT,
  image_url TEXT,
  label_url TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description_en TEXT,
  description_cn TEXT,
  free_of TEXT,
  image_data TEXT,
  label_data TEXT,
  is_active INTEGER DEFAULT 1,
  external_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  stock_qty INTEGER DEFAULT 0,
  tags TEXT,
  variant_group_id INTEGER,
  variant_label TEXT,
  is_market INTEGER DEFAULT 1,
  is_restock_only INTEGER DEFAULT 0,
  is_published INTEGER DEFAULT 0,
  retail_price REAL DEFAULT 0,
  retail_stock INTEGER DEFAULT 0,
  retail_display_order INTEGER DEFAULT 0,
  retail_tagline TEXT,
  retail_description_en TEXT,
  retail_description_cn TEXT,
  nutrition TEXT,
  keywords_en TEXT,
  keywords_cn TEXT,
  tagline_en TEXT,
  tagline_cn TEXT,
  flash_price REAL,
  flash_starts_at DATETIME,
  flash_ends_at DATETIME,
  flash_stock_limit INTEGER,
  flash_sold INTEGER DEFAULT 0,
  ship_modes TEXT DEFAULT 'air,land',
  needs_ice_pack INTEGER DEFAULT 0,
  description_blocks TEXT,
  colophon_character TEXT,
  colophon_tagline_en TEXT,
  colophon_tagline_cn TEXT,
  compare_at_price REAL,
  images TEXT,
  description_format TEXT DEFAULT 'plain',
  variant_sort INTEGER DEFAULT 0,
  bundle TEXT,
  use_block_design INTEGER DEFAULT 0,
  is_batch_made INTEGER DEFAULT 0,
  top_category TEXT,
  subcategory TEXT,
  page_template TEXT,
  kitchen_product_id INTEGER,
  source_sku TEXT,
  synced_at DATETIME,
  source TEXT DEFAULT 'fork'
, product_facts TEXT, variant_label_cn TEXT, low_stock_threshold INTEGER, bundle_items TEXT, no_coupon_on_flash INTEGER, image_aspect REAL, ship_from_supplier INTEGER, oos_policy TEXT, variant_noun_en TEXT, variant_noun_cn TEXT, supplier_paused INTEGER DEFAULT 0, bundle_mode TEXT);
CREATE TABLE "retail_order_items" (
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
    options_json    TEXT, ship_modes TEXT, needs_ice_pack INTEGER DEFAULT 0, shipment_id INTEGER, replaced_for_product_id INTEGER, addon_id INTEGER, ship_from_supplier INTEGER DEFAULT 0, refunded_qty INTEGER DEFAULT 0,                        -- chosen option labels + price deltas, for the receipt
    FOREIGN KEY (order_id)   REFERENCES retail_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES store_products(id)
  );
CREATE TABLE "retail_store_stock" (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER NOT NULL,
    product_id      INTEGER NOT NULL,
    physical_qty    INTEGER NOT NULL DEFAULT 0,   -- actual count at the store
    safety_buffer   INTEGER NOT NULL DEFAULT 0,   -- held back from any channel
    wechat_quota    INTEGER,                       -- NULL = no sub-cap (use global)
    meituan_quota   INTEGER,                       -- NULL = no sub-cap
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP, restock_target INTEGER,
    UNIQUE(store_id, product_id),
    FOREIGN KEY (store_id)   REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES store_products(id)      ON DELETE CASCADE
  );
CREATE TABLE "retail_orders" (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no            TEXT UNIQUE NOT NULL,    -- public-facing, e.g. R2026051601234
    customer_id         INTEGER,
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
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP, refund_requested_at DATETIME, refund_reason TEXT, refund_status TEXT, refund_review_note TEXT, packing_fee REAL DEFAULT 0, delivery_mode TEXT, delivery_zone_id INTEGER, points_earned INTEGER DEFAULT 0, store_id INTEGER, routing_reason TEXT, channel TEXT DEFAULT 'wechat', scheduled_for DATETIME, delivery_slot_label TEXT, same_day_surcharge_fee REAL DEFAULT 0, tracking_carrier TEXT, tracking_number TEXT, tracking_status TEXT, tracking_events_json TEXT, tracking_synced_at DATETIME, tracking_last_error TEXT, tracking_kd100_subscribed INTEGER DEFAULT 0, tracking_scenario TEXT, tracking_scenario_data_json TEXT, tracking_scenario_notified TEXT, fallback_choice TEXT, awaiting_restock_pids TEXT, refund_amount_requested REAL, refund_amount_approved REAL, refund_amount_paid REAL, refund_lines_json TEXT, refund_payout_method TEXT, refund_payout_ref TEXT, refund_reviewed_at DATETIME, refund_approved_at DATETIME, refund_paid_at DATETIME, refund_reviewer_id INTEGER, refund_payer_id INTEGER, seen_at DATETIME, invoice_type TEXT, invoice_email TEXT, invoice_status TEXT, invoice_file_url TEXT, invoice_number TEXT, invoice_issued_at DATETIME, idempotency_key TEXT, fulfillment_type TEXT DEFAULT 'delivery', promised_ship_date TEXT, promised_delivery_date TEXT, print_status TEXT, printed_at DATETIME, print_error TEXT, reminder_ship_sent_at DATETIME, reminder_pickup_sent_at DATETIME, delivery_slot_kind TEXT, invoice_serial TEXT, invoice_auto_error TEXT, fulfillment_short_pids TEXT, sms_delivered_sent_at DATETIME, alipay_proof_image TEXT, alipay_proof_at DATETIME, alipay_ocr_verdict TEXT, alipay_ocr_json TEXT, alipay_txn_id TEXT, alipay_proof_hash TEXT, balance_used REAL DEFAULT 0, refund_cash_amount REAL, wx_shipping_uploaded_at DATETIME, wx_shipping_status TEXT, channel_status TEXT, channel_status_at DATETIME, channel_eta DATETIME, wx_shipping_attempts INTEGER DEFAULT 0, source TEXT, created_by INTEGER, pay_token TEXT, routed_by_distance INTEGER, reroute_short_pids TEXT, channel_stock_restored INTEGER DEFAULT 0, address_changed_at DATETIME, channel_preorder_at DATETIME, wx_shipping_locked_at DATETIME, refund_printed_at DATETIME, channel_note TEXT,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE SET NULL
  );
CREATE TABLE meituan_order_import (
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
CREATE TABLE meituan_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_code  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    status      TEXT NOT NULL,
    detail      TEXT,
    error_msg   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
CREATE TABLE meituan_product_map (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    retail_store_id   INTEGER NOT NULL,
    product_id        INTEGER NOT NULL,
    store_code        TEXT NOT NULL,
    meituan_name      TEXT,
    last_pushed_qty   INTEGER,
    last_pushed_at    DATETIME,
    sync_enabled      INTEGER NOT NULL DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP, meituan_sku TEXT, meituan_spu_id TEXT, meituan_sku_id TEXT, meituan_spec TEXT,
    UNIQUE(retail_store_id, product_id),
    FOREIGN KEY (retail_store_id) REFERENCES retail_stores(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id)      REFERENCES store_products(id)       ON DELETE CASCADE
  );
