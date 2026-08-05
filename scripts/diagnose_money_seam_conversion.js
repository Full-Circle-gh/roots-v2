#!/usr/bin/env node
/**
 * diagnose_money_seam_conversion.js — does the seam CONVERT a CENTS money value,
 * or does it hand it to the connection untouched?
 *
 * THROWAWAY. A verification instrument for one pass. It ships nothing and is
 * wired into nothing.
 *
 * THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT
 * ---------------------------------------------------
 * The previous pass proved the three joined-array money writes PREPARE through
 * the seam on the live path. Being on the seam and being converted correctly are
 * two different facts. This settles the second one, for the four CENTS columns:
 *
 *   products.sell_price                routes/products.js:454
 *   retail_referrals.reward_amount     routes/retail.js:15899
 *   store_products.sell_price          routes/retail.js:18197
 *   store_products.compare_at_price    routes/retail.js:18197
 *
 * HOW THE ANSWER IS OBSERVED RATHER THAN ASSERTED
 * -----------------------------------------------
 * The value itself is the evidence. A known money value is put into the request
 * body, the real handler is invoked, and the value that arrives at the CONNECTION
 * is captured with its JavaScript type. plan.json says these columns are CENTS —
 * bigint in Postgres — so a converted value would arrive as an INTEGER NUMBER OF
 * CENTS. A value that arrives as yuan with a fractional part has not been
 * converted, and no reading of the source is needed to see it.
 *
 * That is section A: the LIVE configuration, exactly as the box has it.
 *
 * Section B answers the follow-on question a passthrough raises — is the value
 * passed through because the seam does not REACH it, or because the seat it would
 * sit in is empty? Those have very different consequences. A RECORDING converter
 * is installed (identity: it returns its arguments unchanged and alters no value)
 * and the same handlers are driven again. If bindIn() is called with the money
 * parameter, the seat reaches it and the passthrough is a configuration fact. If
 * it is not, the passthrough is a coverage gap. Because installConverter() is
 * process-wide and cannot be undone, section B runs in a CHILD PROCESS, so
 * section A observes the untouched live configuration.
 *
 * TENANT GENERALITY — THE THING NOT TO ASSUME
 * -------------------------------------------
 * The previous pass observed SEAM and TENANT collapsing to one wrapper. That is
 * TRUE ONLY FOR ROOTS: getTenantDb(1) === mainDb, and seam() caches one wrapper
 * per raw handle, so tenant 1 shares products.js's wrapper. A second tenant has a
 * different raw handle and therefore a DIFFERENT wrapper. So every observation
 * here is repeated across three distinct wrappers — the live main handle and two
 * separate scratch tenant handles — and the report states whether what was seen
 * is Roots-specific or holds for an arbitrary tenant wrapper.
 *
 * NOTHING IS WRITTEN, ANYWHERE
 * ----------------------------
 * Live SQLite is opened readonly:true, PROVEN by a rejected write before the run
 * and again after it. On top of that every prepared statement's .run() records
 * its parameters and returns without executing, so no write is attempted on any
 * connection. Reads pass through because the handlers need them to reach the
 * write. The two tenant handles are in-memory; no tenant database file is
 * created. Nothing is deployed, restarted, or reconciled.
 *
 * Run:  node scripts/diagnose_money_seam_conversion.js
 *       (via .github/workflows/ro-query.yml, which stages this checkout's
 *        lib/ routes/ middleware/ beside it and points it at the live DB)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const PROBE = process.env.SEAM_PROBE === '1';          // section B, child process
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const LIVE_APP = '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');

const firstExisting = (c) => c.find((x) => x && fs.existsSync(x)) || null;
const PLAN_JSON = firstExisting([
  path.join(HOME, 'scripts', 'postgres-full-copy', 'plan.json'),
  path.join(LIVE_APP, 'scripts', 'postgres-full-copy', 'plan.json'),
  path.join(__dirname, 'postgres-full-copy', 'plan.json'),
]);

const DATABASE_JS = path.join(HOME, 'database.js');
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');
const TENANT_DB_JS = path.join(HOME, 'lib', 'tenant-db.js');
const PRODUCTS_JS = path.join(HOME, 'routes', 'products.js');
const RETAIL_JS = path.join(HOME, 'routes', 'retail.js');
for (const f of [DATABASE_JS, DB_SEAM_JS, TENANT_DB_JS, PRODUCTS_JS, RETAIL_JS]) {
  if (!fs.existsSync(f)) { console.error('FATAL: missing ' + f); process.exit(2); }
}
if (!PLAN_JSON) { console.error('FATAL: plan.json not found'); process.exit(2); }

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('better-sqlite3'); }
})();

let FAILURES = 0;
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const ok = (m) => console.log('   ok    ' + m);
const note = (m) => console.log('   ·     ' + m);

// ════════════════════════════════════════════════════════════════════════════
// The separately-asked fact: what commit is production actually running?
// Parent process only, and read with fs — nothing here can change it.
// ════════════════════════════════════════════════════════════════════════════
if (!PROBE) {
  console.log('══ deployed sha — read, not inferred ══');
  const STATE = path.join(LIVE_APP, '.deploy-state');
  const shaFile = path.join(STATE, 'last-success-sha');
  if (fs.existsSync(shaFile)) {
    console.log('   last-success-sha: ' + fs.readFileSync(shaFile, 'utf8').trim());
  } else {
    console.log('   last-success-sha: (absent at ' + shaFile + ')');
  }
  const hist = path.join(STATE, 'history.log');
  if (fs.existsSync(hist)) {
    const lines = fs.readFileSync(hist, 'utf8').trim().split('\n');
    console.log('   history.log — last 5 of ' + lines.length + ' entries:');
    for (const l of lines.slice(-5)) console.log('       ' + l);
  } else console.log('   history.log: (absent)');
  // The box is deployed by scp, not by checkout. If there is no .git there is no
  // second opinion to compare the record against, and that should be said.
  console.log('   ' + LIVE_APP + '/.git present: ' + fs.existsSync(path.join(LIVE_APP, '.git')));
  console.log('');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 0 · read-only proof, before anything else ══');

const mainDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { mainDb.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; ok('live connection rejected a write: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }
console.log('   db:   ' + DB_PATH);
console.log('   mode: ' + (PROBE ? 'B — recording converter INSTALLED (child process)'
                                 : 'A — live configuration, untouched'));

// ── plan.json: money class, and the column vocabulary ───────────────────────
const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const MONEY_CLS = 'CENTS';
const tableCols = new Map();
const pgTypeOf = new Map();
for (const [t, tv] of Object.entries(plan.tables)) {
  const m = new Map();
  for (const c of tv.cols) if (c.sq) { m.set(c.sq, c.cls); pgTypeOf.set(t + '.' + c.sq, c.pgtype); }
  tableCols.set(t, m);
}

// ════════════════════════════════════════════════════════════════════════════
// Statement capture at the CONNECTION — below the seam. Whatever .run() records
// here is what the seam handed down, after any conversion it chose to do.
// ════════════════════════════════════════════════════════════════════════════
const RECORDS = [];
let CAPTURING = false;

function instrument(conn, label) {
  const real = Object.getPrototypeOf(conn).prepare;
  Object.defineProperty(conn, '__realPrepare', { value: (sql) => real.call(conn, sql), configurable: true });
  Object.defineProperty(conn, 'prepare', {
    configurable: true, writable: true,
    value: function (sql) {
      const stmt = real.call(this, sql);
      if (!CAPTURING) return stmt;
      const rec = { sql, conn: this, connLabel: label, ran: false, out: null, stack: new Error().stack };
      RECORDS.push(rec);
      return new Proxy(stmt, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== 'function') return v;
          if (prop === 'run') {
            // Suppressed. `args` is exactly what reached the connection.
            return function (...args) { rec.ran = true; rec.out = args; return { changes: 0, lastInsertRowid: 0 }; };
          }
          return function (...args) {
            const out = v.apply(target, args);
            return out === target ? this : out;
          };
        },
      });
    },
  });
}
instrument(mainDb, 'live-main');

// ── module loading; database.js seeded with the read-only handle ────────────
const STUBBED = [];
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-conv-stub-'));
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return realResolve.call(this, request, parent, ...rest); }
  catch (e) {
    if (/^\.\.?\//.test(request)) {
      const guess = path.resolve(path.dirname(parent && parent.filename ? parent.filename : HOME), request);
      STUBBED.push(guess);
      const p = path.join(STUB_DIR, 'stub' + STUBBED.length + '.json');
      fs.writeFileSync(p, '{}');
      return p;
    }
    throw e;
  }
};
require.cache[DATABASE_JS] = {
  id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: mainDb,
};

const SEAM = require(DB_SEAM_JS);
const { seam, unwrap, isWrapped, currentConverter, installConverter } = SEAM;

// ── section B: the recording converter. IDENTITY — it changes no value. ─────
const BIND_CALLS = [];
if (PROBE) {
  installConverter({
    bindIn(sql, params) { BIND_CALLS.push({ sql, params, at: 'bindIn' }); return params; },
    readOut(sql, rows) { return rows; },
  });
}

console.log('\n══ 0b · the converter seat, as the process actually has it ══');
const conv = currentConverter();
if (PROBE) {
  if (conv) ok('a RECORDING converter is installed for this child process (identity — alters no value)');
  else fail('installConverter did not take effect');
} else {
  if (conv === null) ok('currentConverter() === null — NO converter is installed on the live configuration');
  else fail('a converter IS installed on the live path: every value below is post-conversion');
}

const T = require(TENANT_DB_JS);
let productsRouter = null, retailRouter = null;
try { productsRouter = require(PRODUCTS_JS); retailRouter = require(RETAIL_JS); }
catch (e) { console.error('FATAL: could not load the route modules: ' + e.stack); process.exit(2); }
if (STUBBED.length) { console.log('   stubbed (not staged by ro-query): ' + [...new Set(STUBBED)].join(', ')); }

// ════════════════════════════════════════════════════════════════════════════
// Three DISTINCT wrappers. Roots collapses onto mainDb; the other two do not.
// ════════════════════════════════════════════════════════════════════════════
function scratchTenant(label) {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = OFF');
  const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';
  for (const [t, tv] of Object.entries(plan.tables)) {
    const cols = tv.cols.filter((c) => c.sq);
    if (!cols.length) continue;
    try { d.exec('CREATE TABLE ' + qi(t) + ' (' + cols.map((c) => qi(c.sq) + ' ' + (c.sqtype || '')).join(', ') + ')'); }
    catch (e) { /* a table that will not build is one this pass does not need */ }
  }
  d.exec("INSERT INTO store_products (id, name_en, is_active) VALUES (1, 'scratch', 1)");
  d.exec("INSERT INTO retail_referrals (id, status) VALUES (1, 'joined')");
  instrument(d, label);
  return d;
}
const tenantA = scratchTenant('tenant-A');
const tenantB = scratchTenant('tenant-B');

console.log('\n══ 0c · wrapper identity across tenants ══');
if (T.getTenantDb(1) === seam(mainDb)) ok('getTenantDb(1) === seam(mainDb) — Roots shares products.js\'s wrapper');
else note('getTenantDb(1) is not seam(mainDb) in this harness');
const wM = seam(mainDb), wA = seam(tenantA), wB = seam(tenantB);
if (wA !== wM && wB !== wM && wA !== wB) ok('the three wrappers are DISTINCT objects — the Roots collapse is not general');
else fail('wrappers collapsed; the tenant-generality check below would be vacuous');
if (isWrapped(wM) && isWrapped(wA) && isWrapped(wB)) ok('all three are seam wrappers');
else fail('not all three handles wrapped');
if (unwrap(wA) === tenantA && unwrap(wB) === tenantB) ok('each wrapper unwraps to its own raw handle');
else fail('unwrap did not return the expected raw handles');

// ════════════════════════════════════════════════════════════════════════════
// Driving the real handlers
// ════════════════════════════════════════════════════════════════════════════
function findHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route || layer.route.path !== routePath || !layer.route.methods[method]) continue;
    const inner = layer.route.stack;
    return inner[inner.length - 1].handle;
  }
  return null;
}
function fakeRes() {
  const r = { statusCode: 200, payload: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  r.send = (p) => { r.payload = p; return r; };
  r.set = () => r; r.type = () => r; r.end = () => r;
  return r;
}
function fakeReq(over) {
  return Object.assign({
    params: {}, body: {}, query: {}, headers: {}, ip: '127.0.0.1',
    user: { id: 0, username: 'ro-query' }, get: () => undefined, method: 'GET', originalUrl: '/',
  }, over);
}

// ── the known money inputs. Distinct, and fractional on purpose: a converted ──
// value would be an integer number of cents and could not be mistaken for these.
const IN_SELL = '12.34';        // → 1234 cents if converted
const IN_COMPARE = '56.78';     // → 5678 cents if converted
const IN_REWARD = 9.87;         // → 987 cents if converted

const BODY_PRODUCTS = { name_en: 'ro-query probe', sell_price: IN_SELL };
const BODY_REFERRAL = { status: 'void', voided_reason: 'ro-query probe', reward_amount: IN_REWARD };
const BODY_STORE = {
  is_published: 1,
  keywords_en: 'k', keywords_cn: 'k', tagline_en: 't', tagline_cn: 't',
  colophon_character: 'c', colophon_tagline_en: 'c', colophon_tagline_cn: 'c', page_template: 'editorial_light',
  description_blocks: [], use_block_design: 1,
  nutrition: { basis_en: 'per 100g', rows: [] }, product_facts: { origin: 'x' },
  name_en: 'ro-query probe', description_format: 'plain', sku: 'RO-QUERY-PROBE-SKU',
  name_cn: 'n', category: 'c', weight: '1', description_en: 'd', description_cn: 'd',
  image_data: null, image_url: null, barcode: 'b', free_of: 'f', notes: 'n',
  sell_price: IN_SELL, compare_at_price: IN_COMPARE,
  stock_qty: '0', low_stock_threshold: '', ship_modes: 'air',
  images: [], bundle: null, bundle_items: null, bundle_mode: 'prepacked',
  tags: null, is_batch_made: 1, oos_policy: 'strict',
  ship_from_supplier: 1, supplier_paused: 1, is_market: 1, is_restock_only: 1,
  status: 'Active', top_category: '', subcategory: '',
};

// ── map bound parameters onto the columns they carry ────────────────────────
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
// Returns [{column, index, value}] for every column that consumed a placeholder.
function mapParams(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();
  let m = /^INSERT\s+INTO\s+["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*VALUES/i.exec(s);
  if (m) {
    const cols = splitTopLevel(m[2]).map((c) => c.replace(/["`]/g, ''));
    return { table: m[1], kind: 'INSERT', binds: cols.map((c, i) => ({ column: c, index: i, value: params[i] })) };
  }
  m = /^UPDATE\s+["`]?(\w+)["`]?\s+SET\s+([\s\S]*?)(?:\s+WHERE\s|\s*$)/i.exec(s);
  if (!m) return { table: null, kind: 'UNPARSED', binds: [] };
  const binds = []; let i = 0;
  for (const entry of splitTopLevel(m[2])) {
    const col = entry.split('=')[0].trim().replace(/["`]/g, '');
    const n = (entry.match(/\?/g) || []).length;      // CURRENT_TIMESTAMP / NULL consume none
    for (let k = 0; k < n; k++) { binds.push({ column: col, index: i, value: params[i] }); i++; }
  }
  return { table: m[1], kind: 'UPDATE', binds };
}

const shape = (v) => {
  if (v === null) return 'null';
  const t = typeof v;
  if (t !== 'number') return t;
  return Number.isInteger(v) ? 'number(integer)' : 'number(fractional)';
};

function pick(line, conn) {
  for (let i = RECORDS.length - 1; i >= 0; i--) {
    const r = RECORDS[i];
    if (conn && r.conn !== conn) continue;
    if (new RegExp('routes[\\\\/][\\w.-]+\\.js:' + line + ':').test(r.stack)) return r;
  }
  return null;
}

const OBSERVED = [];   // {site, wrapper, column, sent, arrived, shape}

function reportMoney(title, rec, wrapperLabel, site, sent) {
  console.log('\n── ' + title + ' ──');
  if (!rec) { fail('the statement was never prepared — the handler did not reach it'); return; }
  if (!rec.ran) { fail('prepared but never run — this is not the write path'); return; }
  const mp = mapParams(rec.sql, rec.out);
  const known = tableCols.get(mp.table) || new Map();
  const money = mp.binds.filter((b) => known.get(b.column) === MONEY_CLS);
  if (!money.length) { fail('no CENTS parameter found in the bound set for ' + mp.table); return; }
  console.log('   ' + mp.kind + ' ' + mp.table + '   receiver: ' + wrapperLabel);
  for (const b of money) {
    const key = mp.table + '.' + b.column;
    const inVal = sent[b.column];
    const asCents = Number.isFinite(Number(b.value)) ? Math.round(Number(b.value) * 100) : null;
    console.log('   ' + key + '  [CENTS · pg ' + pgTypeOf.get(key) + ']');
    console.log('       request body    : ' + JSON.stringify(inVal) + '   (' + shape(inVal) + ')');
    console.log('       AT THE CONNECTION: ' + JSON.stringify(b.value) + '   (' + shape(b.value) + ')  param #' + b.index);
    const converted = Number.isInteger(b.value) && b.value === asCents && Number(inVal) !== b.value;
    if (converted) {
      ok(key + ': CONVERTED — arrived as an integer number of cents');
    } else if (Number(inVal) === Number(b.value)) {
      console.log('       → UNCHANGED. The value the request carried is the value the connection got.');
      console.log('         Converted, it would have arrived as ' + asCents + ' (integer cents).');
    } else {
      note(key + ': value differs from the request but is not cents — handler-side coercion only');
    }
    OBSERVED.push({ site, wrapper: wrapperLabel, column: key, sent: inVal, arrived: b.value, shape: shape(b.value) });
  }
  // Everything else this statement binds, so "only money is untouched" cannot hide here.
  const nonMoney = mp.binds.filter((b) => known.get(b.column) !== MONEY_CLS).length;
  note(nonMoney + ' non-money parameters also bound on this statement');
}

function drive(fn) {
  CAPTURING = true;
  try { fn(); } catch (e) { note('handler threw: ' + e.message); }
  CAPTURING = false;
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n\n════ A · what reaches the connection ════');

const hProducts = findHandler(productsRouter, 'post', '/api/products');
const hReferral = findHandler(retailRouter, 'patch', '/api/retail-admin/affiliate/referrals/:id');
const hStore = findHandler(retailRouter, 'patch', '/api/retail-admin/products/:id');
if (!hProducts || !hReferral || !hStore) fail('one or more handlers were not found in the router stacks');

const liveReferralId = (() => {
  try {
    const r = mainDb.__realPrepare("SELECT id FROM retail_referrals WHERE status IS NULL OR status <> 'ordered' ORDER BY id LIMIT 1").get();
    return r ? r.id : null;
  } catch (e) { return null; }
})();
const liveStoreId = (() => {
  try {
    const r = mainDb.__realPrepare('SELECT id FROM store_products WHERE COALESCE(is_active,1)=1 ORDER BY id LIMIT 1').get();
    return r ? r.id : null;
  } catch (e) { return null; }
})();

// ── site 1: module-level seam handle, Roots only by construction ────────────
if (hProducts) {
  drive(() => hProducts(fakeReq({ method: 'POST', body: { ...BODY_PRODUCTS } }), fakeRes()));
  reportMoney('products.js:454 — seam(mainDb)', pick(454, mainDb), 'seam(mainDb)', 'products.js:454', BODY_PRODUCTS);
}

// ── sites 2 and 3, across three DISTINCT wrappers ───────────────────────────
const WRAPPERS = [
  { label: 'seam(mainDb)  [Roots / unscoped]', conn: mainDb, scope: null, referralId: liveReferralId == null ? 0 : liveReferralId, storeId: liveStoreId == null ? 0 : liveStoreId },
  { label: 'seam(tenantA) [arbitrary tenant]', conn: tenantA, scope: tenantA, referralId: 1, storeId: 1 },
  { label: 'seam(tenantB) [arbitrary tenant]', conn: tenantB, scope: tenantB, referralId: 1, storeId: 1 },
];

for (const w of WRAPPERS) {
  const run = (fn) => (w.scope ? drive(() => T.tenantAls.run(w.scope, fn)) : drive(fn));
  if (hReferral) {
    run(() => hReferral(fakeReq({ method: 'PATCH', params: { id: String(w.referralId) }, body: { ...BODY_REFERRAL } }), fakeRes()));
    reportMoney('retail.js:15899 — ' + w.label, pick(15899, w.conn), w.label, 'retail.js:15899', BODY_REFERRAL);
  }
  if (hStore) {
    run(() => hStore(fakeReq({ method: 'PATCH', params: { id: String(w.storeId) }, body: { ...BODY_STORE } }), fakeRes()));
    reportMoney('retail.js:18197 — ' + w.label, pick(18197, w.conn), w.label, 'retail.js:18197', BODY_STORE);
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n\n════ ' + (PROBE ? 'B · did the converter seat REACH the money parameters?' : 'A · verdict') + ' ════');

if (PROBE) {
  const TARGETS = [
    { re: /^INSERT INTO products \(/, name: 'products INSERT (products.js:454)' },
    { re: /^UPDATE retail_referrals SET/, name: 'retail_referrals UPDATE (retail.js:15899)' },
    { re: /^UPDATE store_products SET/, name: 'store_products UPDATE (retail.js:18197)' },
  ];
  for (const t of TARGETS) {
    const calls = BIND_CALLS.filter((c) => t.re.test(c.sql.replace(/\s+/g, ' ').trim()));
    if (!calls.length) { fail('bindIn() was NEVER called for ' + t.name + ' — the seat does not reach it'); continue; }
    const mp = mapParams(calls[0].sql, calls[0].params);
    const known = tableCols.get(mp.table) || new Map();
    const money = mp.binds.filter((b) => known.get(b.column) === MONEY_CLS);
    ok('bindIn() called ' + calls.length + '× for ' + t.name);
    for (const b of money) {
      console.log('       seat sees ' + mp.table + '.' + b.column + ' = ' + JSON.stringify(b.value) +
                  ' (' + shape(b.value) + ') at param #' + b.index +
                  '  → cents would be ' + Math.round(Number(b.value) * 100));
    }
    if (!money.length) fail('bindIn() saw ' + t.name + ' but no CENTS parameter was in the set');
  }
  console.log('\n   The installed converter is IDENTITY: bindIn returns its arguments unchanged.');
  console.log('   No value was altered by this probe; the "cents would be" figures are arithmetic');
  console.log('   printed for illustration, not a transformation that was applied.');
} else {
  const unchanged = OBSERVED.filter((o) => Number(o.sent) === Number(o.arrived));
  const changed = OBSERVED.filter((o) => Number(o.sent) !== Number(o.arrived));
  console.log('   money parameters observed: ' + OBSERVED.length +
              '   unchanged: ' + unchanged.length + '   altered: ' + changed.length);
  const byWrapper = new Map();
  for (const o of OBSERVED) {
    const k = o.column + ' @ ' + o.wrapper;
    byWrapper.set(k, o.arrived);
  }
  for (const [k, v] of byWrapper) console.log('       ' + k + '  →  ' + JSON.stringify(v));
  // Does behaviour depend on which wrapper is in play?
  const perColumn = new Map();
  for (const o of OBSERVED) {
    if (!perColumn.has(o.column)) perColumn.set(o.column, new Set());
    perColumn.get(o.column).add(JSON.stringify(o.arrived));
  }
  let divergent = 0;
  for (const [c, vals] of perColumn) if (vals.size > 1) { divergent++; fail(c + ' arrived DIFFERENTLY depending on the wrapper: ' + [...vals].join(' vs ')); }
  if (!divergent) ok('every money column arrived identically across all wrappers tested — behaviour is NOT wrapper-specific');
  if (!changed.length) ok('NO money value was altered between .run() and the connection — the seam passed all ' + OBSERVED.length + ' through');
  else fail(changed.length + ' money value(s) were altered; the seam is not a passthrough');
}

// ── nothing was written ─────────────────────────────────────────────────────
console.log('\n══ writes attempted ══');
const wrote = RECORDS.filter((r) => r.ran && /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(r.sql));
console.log('   statements the handlers tried to execute as writes: ' + wrote.length + ' (all suppressed, none executed)');
try { mainDb.exec('CREATE TABLE __ro_probe2__ (x)'); fail('live connection accepted a write AFTER the run'); }
catch (e) { ok('live connection still read-only at the end: ' + e.message); }

try { fs.rmSync(STUB_DIR, { recursive: true, force: true }); } catch (e) { /* scratch */ }

// ── section B runs in a child, because installConverter() cannot be undone ──
let childCode = 0;
if (!PROBE) {
  console.log('\n\n════ handing off to section B (child process, converter installed there only) ════');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { SEAM_PROBE: '1' }),
  });
  childCode = r.status === 0 ? 0 : 1;
  if (r.status !== 0) console.log('   section B exited ' + r.status);
}

console.log('\n' + (FAILURES ? 'FAILURES: ' + FAILURES : 'ALL CHECKS PASSED') + (PROBE ? '  (section B)' : '  (section A)'));
process.exit(FAILURES || childCode ? 1 : 0);
