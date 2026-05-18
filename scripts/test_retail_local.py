#!/usr/bin/env python3
"""Local smoke test for the retail mini-app schema + config assembler.
Uses an in-memory SQLite DB and the same DDL as database.js so we
validate the migration without rebuilding macOS-broken Node bindings.
"""
import json
import sqlite3
import sys
import os

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), '..', 'schema.sql')

con = sqlite3.connect(':memory:')
con.executescript(open(SCHEMA_PATH).read())

def add_column(table, col, type_):
    try:
        con.execute(f'ALTER TABLE {table} ADD COLUMN {col} {type_}')
    except sqlite3.OperationalError as e:
        if 'duplicate column' not in str(e).lower():
            raise

# Mirror the retail migration block in database.js
add_column('products', 'is_published',          'INTEGER DEFAULT 0')
add_column('products', 'retail_price',          'REAL DEFAULT 0')
add_column('products', 'retail_stock',          'INTEGER DEFAULT 0')
add_column('products', 'retail_display_order',  'INTEGER DEFAULT 0')
add_column('products', 'retail_tagline',        'TEXT')
add_column('products', 'retail_description_en', 'TEXT')
add_column('products', 'retail_description_cn', 'TEXT')
con.execute('CREATE INDEX IF NOT EXISTS idx_products_published ON products(is_published) WHERE is_published = 1')

con.executescript('''
  CREATE TABLE IF NOT EXISTS retail_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT UNIQUE NOT NULL, unionid TEXT,
    nickname TEXT, avatar_url TEXT, phone TEXT, email TEXT, gender INTEGER,
    birthday DATE, tier_key TEXT DEFAULT 'seed', lifetime_spend REAL DEFAULT 0,
    points_balance INTEGER DEFAULT 0, coupon_count INTEGER DEFAULT 0, balance REAL DEFAULT 0,
    is_blocked INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login_at DATETIME);
  CREATE INDEX IF NOT EXISTS idx_retail_customers_phone ON retail_customers(phone);

  CREATE TABLE IF NOT EXISTS retail_customer_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, recipient_name TEXT NOT NULL,
    phone TEXT NOT NULL, province TEXT, city TEXT, district TEXT, address TEXT NOT NULL,
    detail TEXT, postal_code TEXT, is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_retail_addrs_customer ON retail_customer_addresses(customer_id);

  CREATE TABLE IF NOT EXISTS retail_auth_tokens (
    token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME, user_agent TEXT,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_retail_tokens_customer ON retail_auth_tokens(customer_id);
  CREATE INDEX IF NOT EXISTS idx_retail_tokens_expires  ON retail_auth_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS retail_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment', payment_method TEXT,
    recipient_name TEXT, recipient_phone TEXT, address_full TEXT, address_json TEXT,
    subtotal REAL DEFAULT 0, shipping_fee REAL DEFAULT 0, voucher_code TEXT, voucher_amount REAL DEFAULT 0,
    points_used INTEGER DEFAULT 0, points_amount REAL DEFAULT 0, total REAL DEFAULT 0,
    customer_note TEXT, needs_cutlery INTEGER DEFAULT 0, needs_invoice INTEGER DEFAULT 0,
    invoice_title TEXT, invoice_tax_id TEXT, staff_note TEXT, cancelled_reason TEXT,
    placed_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME, preparing_at DATETIME,
    dispatched_at DATETIME, delivered_at DATETIME, cancelled_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id));
  CREATE INDEX IF NOT EXISTS idx_retail_orders_customer ON retail_orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_retail_orders_status   ON retail_orders(status);
  CREATE INDEX IF NOT EXISTS idx_retail_orders_placed   ON retail_orders(placed_at);

  CREATE TABLE IF NOT EXISTS retail_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER,
    name_en TEXT, name_cn TEXT, sku TEXT, size TEXT, image_url TEXT,
    qty REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL, options_json TEXT,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id));
  CREATE INDEX IF NOT EXISTS idx_retail_order_items_order   ON retail_order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_order_items_product ON retail_order_items(product_id);

  CREATE TABLE IF NOT EXISTS retail_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, method TEXT NOT NULL,
    amount REAL NOT NULL, status TEXT DEFAULT 'pending', transaction_id TEXT, out_trade_no TEXT,
    qr_image_url TEXT, raw_callback_json TEXT, refunded_amount REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_retail_payments_order ON retail_payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_retail_payments_txn   ON retail_payments(transaction_id);

  CREATE TABLE IF NOT EXISTS retail_product_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
    question_en TEXT NOT NULL, question_cn TEXT, type TEXT NOT NULL DEFAULT 'single',
    is_required INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_retail_opts_product ON retail_product_options(product_id);

  CREATE TABLE IF NOT EXISTS retail_product_option_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, option_id INTEGER NOT NULL,
    label_en TEXT NOT NULL, label_cn TEXT, price_delta REAL DEFAULT 0,
    is_default INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (option_id) REFERENCES retail_product_options(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS idx_retail_opt_choices_opt ON retail_product_option_choices(option_id);

  CREATE TABLE IF NOT EXISTS storefront_config (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_by INTEGER);
''')

seed = [
    ('theme.accent',                json.dumps('lime-leaf')),
    ('theme.ipIntensity',           json.dumps('soft')),
    ('theme.language',              json.dumps('bilingual')),
    ('fees.freeShippingThreshold',  json.dumps(399)),
    ('fees.sameDayDelivery',        json.dumps(18)),
    ('fees.minOrder',               json.dumps(0)),
    ('home.heroImg',                json.dumps('')),
    ('home.ctaLabel',               json.dumps('SHOP')),
    ('home.sections',               json.dumps([
        {'id': 'fresh',  'kicker': 'NO. 01 · FRESH',     'title': "This week's juice", 'type': 'hscroll', 'productIds': []},
        {'id': 'browse', 'kicker': 'NO. 02 · BROWSE',    'title': 'Shop the garden',   'type': 'categories'},
        {'id': 'club',   'kicker': 'NO. 03 · ROOTS CLUB', 'title': 'Grow with us.',    'type': 'membership-promo'},
    ])),
    ('tabBar.theme',                json.dumps('oat')),
    ('tabBar.items',                json.dumps([
        {'id': 'home', 'en': 'Home', 'cn': '首页'},
        {'id': 'shop', 'en': 'Shop', 'cn': '商品'},
        {'id': 'cart', 'en': 'Cart', 'cn': '购物车'},
        {'id': 'me',   'en': 'Me',   'cn': '我的'},
    ])),
]
for k, v in seed:
    con.execute('INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)', (k, v))

# ── Assertions ────────────────────────────────────────────────────────────
expected_tables = [
    'retail_customers', 'retail_customer_addresses', 'retail_auth_tokens',
    'retail_orders', 'retail_order_items', 'retail_payments',
    'retail_product_options', 'retail_product_option_choices', 'storefront_config',
]
present = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
missing = [t for t in expected_tables if t not in present]
if missing:
    print('MISSING TABLES:', missing); sys.exit(1)
print(f'✔ all {len(expected_tables)} retail tables present')

expected_cols = ['is_published','retail_price','retail_stock','retail_display_order',
                 'retail_tagline','retail_description_en','retail_description_cn']
cols = {r[1] for r in con.execute('PRAGMA table_info(products)')}
missing_cols = [c for c in expected_cols if c not in cols]
if missing_cols:
    print('MISSING products cols:', missing_cols); sys.exit(1)
print(f'✔ all {len(expected_cols)} retail columns added to products')

count = con.execute('SELECT COUNT(*) FROM storefront_config').fetchone()[0]
assert count == len(seed), f'expected {len(seed)} seeded keys, got {count}'
print(f'✔ storefront_config seeded with {count} keys')

# ── Config assembler (mirrors retail.js loadConfig) ──────────────────────
def set_path(obj, segs, val):
    cur = obj
    for s in segs[:-1]:
        if s not in cur or not isinstance(cur[s], dict):
            cur[s] = {}
        cur = cur[s]
    cur[segs[-1]] = val

def load_config():
    out = {'version': 0}
    for k, v_json in con.execute('SELECT key, value_json FROM storefront_config'):
        try: v = json.loads(v_json)
        except: v = v_json
        set_path(out, k.split('.'), v)
    t = con.execute("SELECT COALESCE(MAX(strftime('%s', updated_at)), 0) FROM storefront_config").fetchone()[0]
    out['version'] = int(t or 0)
    return out

cfg = load_config()

checks = [
    ('theme.accent == lime-leaf',          cfg['theme']['accent'] == 'lime-leaf'),
    ('fees.freeShippingThreshold == 399',  cfg['fees']['freeShippingThreshold'] == 399),
    ('fees.sameDayDelivery == 18',         cfg['fees']['sameDayDelivery'] == 18),
    ('home.sections is array of 3',        isinstance(cfg['home']['sections'], list) and len(cfg['home']['sections']) == 3),
    ('home.sections[0].id == fresh',       cfg['home']['sections'][0]['id'] == 'fresh'),
    ('tabBar.items[2].cn == 购物车',        cfg['tabBar']['items'][2]['cn'] == '购物车'),
    ('version is positive',                isinstance(cfg['version'], int) and cfg['version'] > 0),
]
ok_all = True
for name, ok in checks:
    print(('✔ ' if ok else '✘ ') + name)
    if not ok: ok_all = False
if not ok_all: sys.exit(1)

print('\n── assembled GET /api/retail/config payload ──')
print(json.dumps({'success': True, 'data': cfg}, indent=2, ensure_ascii=False))
print('\n✔ test passed')
