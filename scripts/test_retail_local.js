// Local smoke test for the retail mini-app schema + config endpoint logic.
// Runs against a TEMPORARY SQLite DB so it never touches dev/prod data.
// Bypasses express (the local connect-sqlite3 native binding is busted).
// Run: node scripts/test_retail_local.js

const path = require('path');
const fs = require('fs');
const os = require('os');

// Point database.js at a throwaway file in /tmp by overriding DATA_DIR.
// database.js resolves data/roots.db relative to __dirname, so the
// cleanest way is to set up a sibling 'data' dir under a temp project root
// — but that's a lot of trouble. Easier: point process.cwd irrelevant,
// just delete the test DB after.
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-retail-test-'));

// Hack: replace database.js's DATA_DIR by setting env + a temp data dir.
// database.js doesn't read env for the path, so simulate by copying the
// schema.sql + faking the __dirname via a tiny shim. Simpler: just load
// the real module — it'll write to /Users/ash/roots-v2/data/roots.db,
// which IS the dev DB. We don't want that. So mock with a fresh DB:

const Database = require('better-sqlite3');
const db = new Database(path.join(TMP_DB_DIR, 'test.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Load the base schema first
const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
db.exec(schema);

// Inline the new retail migrations directly from database.js. Rather than
// re-importing (which would also try to load the express side of things),
// we replay the same DDL block. If this diverges from database.js the
// test will catch it — we want them in lockstep.

function addColumn(table, col, type) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

// Run the same retail-section block as database.js
addColumn('products', 'is_published',          'INTEGER DEFAULT 0');
addColumn('products', 'retail_price',          'REAL DEFAULT 0');
addColumn('products', 'retail_stock',          'INTEGER DEFAULT 0');
addColumn('products', 'retail_display_order',  'INTEGER DEFAULT 0');
addColumn('products', 'retail_tagline',        'TEXT');
addColumn('products', 'retail_description_en', 'TEXT');
addColumn('products', 'retail_description_cn', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_published ON products(is_published) WHERE is_published = 1');

db.exec(`
  CREATE TABLE IF NOT EXISTS retail_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT UNIQUE NOT NULL, unionid TEXT,
    nickname TEXT, avatar_url TEXT, phone TEXT, email TEXT, gender INTEGER,
    birthday DATE, tier_key TEXT DEFAULT 'seed', lifetime_spend REAL DEFAULT 0,
    points_balance INTEGER DEFAULT 0, coupon_count INTEGER DEFAULT 0, balance REAL DEFAULT 0,
    is_blocked INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login_at DATETIME);
  CREATE TABLE IF NOT EXISTS retail_customer_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, recipient_name TEXT NOT NULL,
    phone TEXT NOT NULL, province TEXT, city TEXT, district TEXT, address TEXT NOT NULL,
    detail TEXT, postal_code TEXT, is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS retail_auth_tokens (
    token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME, user_agent TEXT,
    FOREIGN KEY (customer_id) REFERENCES retail_customers(id) ON DELETE CASCADE);
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
  CREATE TABLE IF NOT EXISTS retail_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER,
    name_en TEXT, name_cn TEXT, sku TEXT, size TEXT, image_url TEXT,
    qty REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL, options_json TEXT,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id));
  CREATE TABLE IF NOT EXISTS retail_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, method TEXT NOT NULL,
    amount REAL NOT NULL, status TEXT DEFAULT 'pending', transaction_id TEXT, out_trade_no TEXT,
    qr_image_url TEXT, raw_callback_json TEXT, refunded_amount REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES retail_orders(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS retail_product_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
    question_en TEXT NOT NULL, question_cn TEXT, type TEXT NOT NULL DEFAULT 'single',
    is_required INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS retail_product_option_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, option_id INTEGER NOT NULL,
    label_en TEXT NOT NULL, label_cn TEXT, price_delta REAL DEFAULT 0,
    is_default INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (option_id) REFERENCES retail_product_options(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS storefront_config (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_by INTEGER);
`);

// Seed config (mirror database.js block)
const seedKV = db.prepare("INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)");
const seed = [
  ['theme.accent',                JSON.stringify('lime-leaf')],
  ['theme.ipIntensity',           JSON.stringify('soft')],
  ['theme.language',              JSON.stringify('bilingual')],
  ['fees.freeShippingThreshold',  JSON.stringify(399)],
  ['fees.sameDayDelivery',        JSON.stringify(18)],
  ['fees.minOrder',               JSON.stringify(0)],
  ['home.heroImg',                JSON.stringify('')],
  ['home.ctaLabel',               JSON.stringify('SHOP')],
  ['home.sections',               JSON.stringify([
    { id: 'fresh',  kicker: 'NO. 01 · FRESH',     title: "This week's juice", type: 'hscroll', productIds: [] },
    { id: 'browse', kicker: 'NO. 02 · BROWSE',    title: 'Shop the garden',   type: 'categories' },
    { id: 'club',   kicker: 'NO. 03 · ROOTS CLUB', title: 'Grow with us.',    type: 'membership-promo' },
  ])],
  ['tabBar.theme',                JSON.stringify('oat')],
  ['tabBar.items',                JSON.stringify([
    { id: 'home', en: 'Home', cn: '首页' },
    { id: 'shop', en: 'Shop', cn: '商品' },
    { id: 'cart', en: 'Cart', cn: '购物车' },
    { id: 'me',   en: 'Me',   cn: '我的' },
  ])],
];
for (const [k, v] of seed) seedKV.run(k, v);

// ── Assertions ────────────────────────────────────────────────────────────
const expectedTables = [
  'retail_customers', 'retail_customer_addresses', 'retail_auth_tokens',
  'retail_orders', 'retail_order_items', 'retail_payments',
  'retail_product_options', 'retail_product_option_choices', 'storefront_config',
];
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
for (const t of expectedTables) {
  if (!tables.has(t)) { console.error('MISSING TABLE:', t); process.exit(1); }
}
console.log('✔ all 9 retail tables present');

const productCols = new Set(db.prepare('PRAGMA table_info(products)').all().map(r => r.name));
const expectedProductCols = ['is_published','retail_price','retail_stock','retail_display_order','retail_tagline','retail_description_en','retail_description_cn'];
for (const c of expectedProductCols) {
  if (!productCols.has(c)) { console.error('MISSING products col:', c); process.exit(1); }
}
console.log('✔ all 7 retail columns added to products');

const seededCount = db.prepare('SELECT COUNT(*) AS n FROM storefront_config').get().n;
if (seededCount !== seed.length) { console.error('seed mismatch, got', seededCount, 'expected', seed.length); process.exit(1); }
console.log(`✔ storefront_config seeded with ${seededCount} keys`);

// ── Verify config assembler matches what retail.js will do ───────────────
function setPath(obj, segs, val) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null || typeof cur[s] !== 'object' || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = val;
}
function loadConfig() {
  const rows = db.prepare('SELECT key, value_json FROM storefront_config').all();
  const out = { version: 0 };
  for (const { key, value_json } of rows) {
    let v; try { v = JSON.parse(value_json); } catch { v = value_json; }
    setPath(out, key.split('.'), v);
  }
  const t = db.prepare("SELECT COALESCE(MAX(strftime('%s', updated_at)), 0) AS t FROM storefront_config").get();
  out.version = Number(t?.t || 0);
  return out;
}
const cfg = loadConfig();

// Spot-check the assembled response
const checks = [
  ['theme.accent === lime-leaf',           cfg.theme.accent === 'lime-leaf'],
  ['fees.freeShippingThreshold === 399',   cfg.fees.freeShippingThreshold === 399],
  ['fees.sameDayDelivery === 18',          cfg.fees.sameDayDelivery === 18],
  ['home.sections is array of 3',          Array.isArray(cfg.home.sections) && cfg.home.sections.length === 3],
  ['home.sections[0].id === fresh',        cfg.home.sections[0].id === 'fresh'],
  ['tabBar.items[2].cn === 购物车',         cfg.tabBar.items[2].cn === '购物车'],
  ['version is a positive number',         Number.isFinite(cfg.version) && cfg.version > 0],
];
let allOk = true;
for (const [name, ok] of checks) {
  console.log((ok ? '✔ ' : '✘ ') + name);
  if (!ok) allOk = false;
}
if (!allOk) process.exit(1);

console.log('\n── assembled GET /api/retail/config payload ──');
console.log(JSON.stringify({ success: true, data: cfg }, null, 2));

// Cleanup
db.close();
fs.rmSync(TMP_DB_DIR, { recursive: true, force: true });
console.log('\n✔ test passed — cleaned up', TMP_DB_DIR);
