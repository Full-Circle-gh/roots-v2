#!/usr/bin/env node
/**
 * diagnose_money_write_sites.js — verify the three joined-array money WRITES
 * on the LIVE path, by executing them.
 *
 * THROWAWAY. This is a verification instrument for one pass, not a fixture.
 * It ships nothing and it is not wired into anything.
 *
 * WHAT IT PROVES, AND WHY THE STATIC READ COULD NOT
 * -------------------------------------------------
 * The money census read source text. Three sites assemble their column list
 * through `array.join(...)`, so the census had to reason about what the array
 * would contain and which handle the variable would hold. Both are runtime
 * facts. This file settles them by running the real handlers:
 *
 *   routes/products.js:454   INSERT INTO products    (FIELDS.join(','))
 *   routes/retail.js:15899   UPDATE retail_referrals (updates.join(', '))
 *   routes/retail.js:18197   UPDATE store_products   (sets.join(', '))
 *
 * The real route modules are loaded, the real handler closure is pulled out of
 * the express router stack, and it is invoked. The SQL that reaches SQLite is
 * captured verbatim from the connection, together with the stack at the moment
 * of prepare(). The stack is the receiver trace: if the call passed through the
 * seam, lib/db-seam.js appears as a frame BETWEEN the call site and the
 * connection; if the handler held a raw handle, it does not. That is an
 * observation, not an inference from the variable's name.
 *
 * Handles are then identified by object identity — is the connection that
 * received prepare() the main database, or the tenant connection the
 * AsyncLocalStorage was carrying? For the two retail sites the handler is run
 * TWICE: once with no tenant scope, and once inside tenantAls.run(scratch),
 * where `scratch` is a private in-memory database. If the receiver follows the
 * ALS store, the handle is tenant-scoped. If it does not, it is not.
 *
 * NOTHING IS WRITTEN, ANYWHERE
 * ----------------------------
 * The live database is opened `readonly: true` and that is PROVEN on the
 * connection by a rejected write before anything else happens. On top of that,
 * every prepared statement is handed back through a guard whose .run() records
 * its parameters and returns without executing — so a write is never even
 * attempted, on the live connection or the scratch one. Reads (.get/.all) pass
 * through untouched, because the handlers need them to reach the write.
 *
 * The maximal-body pass matters for the third site: the handler pushes into
 * `sets` conditionally, key by key, so a small body produces a small column
 * list. Each handler is driven with a body containing every key it tests, so
 * the captured SQL carries every column the path can assemble — which is what
 * "is there a money column nobody recorded" actually requires.
 *
 * Columns are classified against scripts/postgres-full-copy/plan.json — the
 * live schema census — not by whether the name looks like money.
 *
 * Run:  node scripts/diagnose_money_write_sites.js
 *       (via .github/workflows/ro-query.yml, which stages this checkout's
 *        lib/ routes/ middleware/ beside it and points it at the live DB)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
console.log('══ 0 · read-only proof, before anything else ══');

const mainDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
let proven = false;
try { mainDb.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; ok('live connection rejected a write: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }
console.log('   db:   ' + DB_PATH);
console.log('   home: ' + HOME + (HOME === LIVE_APP ? '  (LIVE TREE)' : '  (staged scratch)'));

// ── plan.json: the money classification, and the column vocabulary ──────────
const plan = JSON.parse(fs.readFileSync(PLAN_JSON, 'utf8'));
const MONEY_CLS = 'CENTS';
const tableCols = new Map();        // table -> Map(col -> cls)
for (const [t, tv] of Object.entries(plan.tables)) {
  const m = new Map();
  for (const c of tv.cols) if (c.sq) m.set(c.sq, c.cls);
  tableCols.set(t, m);
}
const moneyColsOf = (t) => [...(tableCols.get(t) || new Map())].filter(([, c]) => c === MONEY_CLS).map(([n]) => n);

// ════════════════════════════════════════════════════════════════════════════
// Statement capture. Patched onto the RAW connection as an own property, so the
// seam's proxy (which does Reflect.get(target,'prepare')) forwards into it and
// leaves its own frame on the stack on the way.
// ════════════════════════════════════════════════════════════════════════════
const RECORDS = [];                 // {sql, conn, connLabel, stack, ran, params}
let CAPTURING = false;

function instrument(conn, label) {
  const real = Object.getPrototypeOf(conn).prepare;
  Object.defineProperty(conn, '__realPrepare', { value: (sql) => real.call(conn, sql), configurable: true });
  Object.defineProperty(conn, 'prepare', {
    configurable: true, writable: true,
    value: function (sql) {
      const stmt = real.call(this, sql);
      if (!CAPTURING) return stmt;
      const rec = { sql, conn: this, connLabel: label, stack: new Error().stack, ran: false, params: null };
      RECORDS.push(rec);
      // Guarded statement: reads pass through, writes are recorded and dropped.
      return new Proxy(stmt, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== 'function') return v;
          if (prop === 'run') {
            return function (...args) { rec.ran = true; rec.params = args; return { changes: 0, lastInsertRowid: 0 }; };
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

// ════════════════════════════════════════════════════════════════════════════
// Module loading. database.js is seeded in the cache so every `require('../database')`
// — routes/, lib/tenant-db.js, middleware/auth.js — resolves to the read-only handle.
// ════════════════════════════════════════════════════════════════════════════
const STUBBED = [];
// Substitute modules are written to the OS temp dir, never into HOME — HOME may
// be the live tree when this is run by hand on the box.
const STUB_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'money-write-stub-'));
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return realResolve.call(this, request, parent, ...rest); }
  catch (e) {
    // ro-query stages lib/ routes/ middleware/ only. A data file outside those
    // (reference/*.json) cannot resolve. Substitute an empty module and SAY SO,
    // rather than failing the load or pretending it was there.
    if (/^\.\.?\//.test(request)) {
      const guess = path.resolve(path.dirname(parent && parent.filename ? parent.filename : HOME), request);
      STUBBED.push(guess);
      const stubPath = path.join(STUB_DIR, 'stub' + STUBBED.length + '.json');
      fs.writeFileSync(stubPath, '{}');
      return stubPath;
    }
    throw e;
  }
};

require.cache[DATABASE_JS] = {
  id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: mainDb,
};

const { seam, unwrap, isWrapped, currentConverter } = require(DB_SEAM_JS);
const T = require(TENANT_DB_JS);

console.log('\n══ 0b · seam state ══');
if (currentConverter() === null) ok('no converter installed — the seam is a passthrough (as expected today)');
else fail('a converter IS installed; every value below is post-conversion');
if (isWrapped(seam(mainDb))) ok('seam(mainDb) is a wrapper; unwrap() returns the raw handle: ' + (unwrap(seam(mainDb)) === mainDb));
else fail('seam(mainDb) did not wrap');

let productsRouter = null, retailRouter = null, loadError = null;
try {
  productsRouter = require(PRODUCTS_JS);
  retailRouter = require(RETAIL_JS);
} catch (e) { loadError = e; }
if (loadError) { console.error('FATAL: could not load the route modules: ' + loadError.stack); process.exit(2); }
if (STUBBED.length) {
  console.log('   stubbed (not staged by ro-query, empty module substituted):');
  for (const s of STUBBED) console.log('       ' + s);
} else note('nothing needed stubbing — every require resolved');

// ── pull the real handler closure out of the router stack ───────────────────
function findHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== routePath) continue;
    if (!layer.route.methods[method]) continue;
    const inner = layer.route.stack;
    return inner[inner.length - 1].handle;      // the terminal handler, after middleware
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

// ── SQL structure, from the string that actually reached the connection ─────
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function parseStatement(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();
  let m = /^INSERT\s+INTO\s+["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*VALUES/i.exec(s);
  if (m) return { kind: 'INSERT', table: m[1], cols: splitTopLevel(m[2]).map((c) => c.replace(/["`]/g, '')) };
  m = /^UPDATE\s+["`]?(\w+)["`]?\s+SET\s+([\s\S]*?)(?:\s+WHERE\s|\s*$)/i.exec(s);
  if (m) {
    return {
      kind: 'UPDATE', table: m[1],
      cols: splitTopLevel(m[2]).map((a) => a.split('=')[0].trim().replace(/["`]/g, '')),
    };
  }
  return { kind: 'UNPARSED', table: null, cols: [] };
}

// ── receiver trace: read it off the stack, not off the variable name ────────
function traceReceiver(rec) {
  const frames = rec.stack.split('\n').slice(1).map((f) => f.trim());
  // frame 0 is this file's patched prepare. What comes next is the truth.
  const rest = frames.slice(1);
  const seamFrame = rest.findIndex((f) => /db-seam\.js:/.test(f));
  const siteFrame = rest.findIndex((f) => /[\\/]routes[\\/]\w+\.js:/.test(f));
  const site = siteFrame >= 0 ? (/([\w.-]+\.js:\d+:\d+)/.exec(rest[siteFrame]) || [])[1] : '(no routes frame)';
  const viaSeam = seamFrame >= 0 && (siteFrame < 0 || seamFrame < siteFrame);
  return { site, viaSeam, seamHop: seamFrame >= 0 ? (/([\w.-]+\.js:\d+:\d+)/.exec(rest[seamFrame]) || [])[1] : null, frames: rest.slice(0, 6) };
}

function report(title, expect, rec, connName) {
  console.log('\n── ' + title + ' ──');
  if (!rec) { fail('the statement was never prepared — the handler did not reach it'); return null; }
  const st = parseStatement(rec.sql);
  const tr = traceReceiver(rec);

  console.log('   parsed kind : ' + st.kind);
  console.log('   target table: ' + st.table);
  console.log('   call site   : ' + tr.site);

  if (st.kind === expect.kind) ok('kind matches the census claim (' + expect.kind + ')');
  else fail('kind DIVERGES: census said ' + expect.kind + ', live is ' + st.kind);
  if (st.table === expect.table) ok('table matches the census claim (' + expect.table + ')');
  else fail('table DIVERGES: census said ' + expect.table + ', live is ' + st.table);
  if (tr.site.endsWith(expect.line)) ok('the statement really is at ' + expect.line);
  else fail('call site DIVERGES: expected ' + expect.line + ', live is ' + tr.site);

  // Every extracted column must exist on the table per the census, or the parse
  // is not trustworthy and nothing below it means anything.
  const known = tableCols.get(st.table) || new Map();
  const bad = st.cols.filter((c) => !known.has(c));
  if (!bad.length) ok('all ' + st.cols.length + ' assembled columns exist on ' + st.table + ' per plan.json');
  else fail('columns not on ' + st.table + ' in plan.json (parse suspect): ' + bad.join(', '));

  // SQLite itself agrees the columns exist — prepare() against the live schema.
  try { mainDb.__realPrepare('SELECT ' + st.cols.filter((c) => known.has(c)).map((c) => '"' + c + '"').join(', ') + ' FROM ' + st.table + ' LIMIT 0'); ok('SQLite accepts every column against the LIVE ' + st.table + ' schema'); }
  catch (e) { fail('SQLite rejected the column list against live schema: ' + e.message); }

  const money = st.cols.filter((c) => known.get(c) === MONEY_CLS);
  console.log('   money-class columns written (plan.json cls=' + MONEY_CLS + '): ' +
              (money.length ? money.join(', ') : '(none)'));
  console.log('   all money-class columns that EXIST on ' + st.table + ': ' + moneyColsOf(st.table).join(', '));
  const notWritten = moneyColsOf(st.table).filter((c) => !money.includes(c));
  if (notWritten.length) note('present on the table but NOT written here: ' + notWritten.join(', '));

  const expSet = new Set(expect.money), gotSet = new Set(money);
  const extra = money.filter((c) => !expSet.has(c));
  const missing = expect.money.filter((c) => !gotSet.has(c));
  if (!extra.length && !missing.length) ok('money columns match the census exactly: ' + expect.money.join(', '));
  if (extra.length) fail('EXTRA money column(s) the census did not record: ' + extra.join(', '));
  if (missing.length) fail('census claimed money column(s) not present live: ' + missing.join(', '));

  console.log('   receiver    : prepare() landed on ' + connName +
              (tr.viaSeam ? ', THROUGH the seam (' + tr.seamHop + ')' : ', with NO db-seam frame — raw handle'));
  if (tr.viaSeam === expect.viaSeam) ok('seam routing matches the claim (' + (expect.viaSeam ? 'seam-wrapped' : 'raw') + ')');
  else fail('seam routing DIVERGES: expected ' + (expect.viaSeam ? 'seam-wrapped' : 'raw') + ', observed the opposite');
  if (rec.ran) ok('the statement was executed by the handler (parameters captured, execution suppressed)');
  else fail('the handler prepared but never ran it — this is not the live write path');
  console.log('   bound params: ' + JSON.stringify((rec.params && rec.params[0] !== undefined ? rec.params : []).slice(0, 40),
    (k, v) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : v)));
  return { st, tr, money, rec };
}

function pick(line, conn) {
  for (let i = RECORDS.length - 1; i >= 0; i--) {
    const r = RECORDS[i];
    if (conn && r.conn !== conn) continue;
    if (new RegExp('routes[\\\\/][\\w.-]+\\.js:' + line + ':').test(r.stack)) return r;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n\n════ SITE 1 · routes/products.js:454 ════');

const h1 = findHandler(productsRouter, 'post', '/api/products');
if (!h1) fail('could not find POST /api/products in the router stack');
let site1 = null;
if (h1) {
  CAPTURING = true;
  const res = fakeRes();
  try { h1(fakeReq({ method: 'POST', body: { name_en: 'ro-query probe', sell_price: '1.23' } }), res); }
  catch (e) { note('handler threw after the statement: ' + e.message); }
  CAPTURING = false;
  site1 = report('products.js:454 — no tenant scope', {
    kind: 'INSERT', table: 'products', line: 'products.js:454', money: ['sell_price'], viaSeam: true,
  }, pick(454, mainDb), 'the LIVE main connection (identity === require("../database"))');
}

// ════════════════════════════════════════════════════════════════════════════
// The retail sites. Two runs each: unscoped (tdb() → main), then inside
// tenantAls.run(scratch) — if the receiver follows the ALS store, tdb() is
// tenant-scoped. The scratch database is private and in-memory.
// ════════════════════════════════════════════════════════════════════════════
const scratch = new Database(':memory:');
scratch.pragma('foreign_keys = OFF');
{
  const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';
  for (const [t, tv] of Object.entries(plan.tables)) {
    const cols = tv.cols.filter((c) => c.sq);
    if (!cols.length) continue;
    try { scratch.exec('CREATE TABLE ' + qi(t) + ' (' + cols.map((c) => qi(c.sq) + ' ' + (c.sqtype || '')).join(', ') + ')'); }
    catch (e) { /* a table that will not build is one this pass does not need */ }
  }
  scratch.exec("INSERT INTO store_products (id, name_en, is_active) VALUES (1, 'scratch', 1)");
  scratch.exec("INSERT INTO retail_referrals (id, status) VALUES (1, 'joined')");
}
instrument(scratch, 'scratch-memory');
if (unwrap(seam(scratch)) === scratch) ok('scratch handle wraps and unwraps cleanly');

function runScoped(fn) { return T.tenantAls.run(scratch, fn); }

// ── site 2 ──────────────────────────────────────────────────────────────────
console.log('\n\n════ SITE 2 · routes/retail.js:15899 ════');
const h2 = findHandler(retailRouter, 'patch', '/api/retail-admin/affiliate/referrals/:id');
if (!h2) fail('could not find PATCH /api/retail-admin/affiliate/referrals/:id');

// A maximal body: every key the handler tests, so `updates` carries every
// column this path can assemble.
const BODY2 = { status: 'void', voided_reason: 'ro-query probe', reward_amount: 1.23 };

let site2live = null, site2scoped = null;
if (h2) {
  const liveId = (() => {
    try {
      const r = mainDb.__realPrepare("SELECT id FROM retail_referrals WHERE status IS NULL OR status <> 'ordered' ORDER BY id LIMIT 1").get();
      return r ? r.id : null;
    } catch (e) { return null; }
  })();
  if (liveId == null) note('no live retail_referrals row is editable (all paid/absent) — live pass will 404/409');
  else note('driving against live retail_referrals id=' + liveId);

  CAPTURING = true;
  const res = fakeRes();
  try { h2(fakeReq({ method: 'PATCH', params: { id: String(liveId == null ? 0 : liveId) }, body: { ...BODY2 } }), res); }
  catch (e) { note('handler threw: ' + e.message); }
  CAPTURING = false;
  if (res.payload && res.payload.error) note('live pass returned: ' + JSON.stringify(res.payload));
  site2live = report('retail.js:15899 — no tenant scope (tdb() outside ALS)', {
    kind: 'UPDATE', table: 'retail_referrals', line: 'retail.js:15899', money: ['reward_amount'], viaSeam: true,
  }, pick(15899, mainDb), 'the LIVE main connection');

  CAPTURING = true;
  const res2 = fakeRes();
  try { runScoped(() => h2(fakeReq({ method: 'PATCH', params: { id: '1' }, body: { ...BODY2 } }), res2)); }
  catch (e) { note('handler threw: ' + e.message); }
  CAPTURING = false;
  site2scoped = report('retail.js:15899 — inside tenantAls.run(scratch)', {
    kind: 'UPDATE', table: 'retail_referrals', line: 'retail.js:15899', money: ['reward_amount'], viaSeam: true,
  }, pick(15899, scratch), 'the SCRATCH tenant connection');
}

// ── site 3 ──────────────────────────────────────────────────────────────────
console.log('\n\n════ SITE 3 · routes/retail.js:18197 ════');
const h3 = findHandler(retailRouter, 'patch', '/api/retail-admin/products/:id');
if (!h3) fail('could not find PATCH /api/retail-admin/products/:id');

// Maximal body — every key the handler tests before building `sets`. This is
// the point of the exercise: a partial body yields a partial column list, and
// a money column that only appears under some other key would be invisible.
const BODY3 = {
  is_published: 1,
  keywords_en: 'k', keywords_cn: 'k', tagline_en: 't', tagline_cn: 't',
  colophon_character: 'c', colophon_tagline_en: 'c', colophon_tagline_cn: 'c', page_template: 'editorial_light',
  description_blocks: [], use_block_design: 1,
  nutrition: { basis_en: 'per 100g', rows: [] },
  product_facts: { origin: 'x' },
  name_en: 'ro-query probe', description_format: 'plain',
  name_cn: 'n', category: 'c', weight: '1', description_en: 'd', description_cn: 'd',
  image_data: null, image_url: null, barcode: 'b', free_of: 'f', notes: 'n',
  sell_price: '1.23', compare_at_price: '4.56',
  stock_qty: '0', low_stock_threshold: '', ship_modes: 'air',
  images: [], bundle: null, bundle_items: null, bundle_mode: 'prepacked',
  tags: null, is_batch_made: 1, oos_policy: 'strict',
  ship_from_supplier: 1, supplier_paused: 1, is_market: 1, is_restock_only: 1,
  status: 'Active', top_category: '', subcategory: '',
};

let site3live = null, site3scoped = null;
if (h3) {
  const liveId = (() => {
    try {
      const r = mainDb.__realPrepare('SELECT id FROM store_products WHERE COALESCE(is_active,1)=1 ORDER BY id LIMIT 1').get();
      return r ? r.id : null;
    } catch (e) { return null; }
  })();
  note(liveId == null ? 'no live store_products row found' : 'driving against live store_products id=' + liveId);

  CAPTURING = true;
  const res = fakeRes();
  try { h3(fakeReq({ method: 'PATCH', params: { id: String(liveId == null ? 0 : liveId) }, body: { ...BODY3 } }), res); }
  catch (e) { note('handler threw: ' + e.message); }
  CAPTURING = false;
  if (res.payload && res.payload.error) note('live pass returned: ' + JSON.stringify(res.payload));
  site3live = report('retail.js:18197 — no tenant scope (tdb() outside ALS)', {
    kind: 'UPDATE', table: 'store_products', line: 'retail.js:18197',
    money: ['sell_price', 'compare_at_price'], viaSeam: true,
  }, pick(18197, mainDb), 'the LIVE main connection');

  CAPTURING = true;
  const res2 = fakeRes();
  try { runScoped(() => h3(fakeReq({ method: 'PATCH', params: { id: '1' }, body: { ...BODY3 } }), res2)); }
  catch (e) { note('handler threw: ' + e.message); }
  CAPTURING = false;
  site3scoped = report('retail.js:18197 — inside tenantAls.run(scratch)', {
    kind: 'UPDATE', table: 'store_products', line: 'retail.js:18197',
    money: ['sell_price', 'compare_at_price'], viaSeam: true,
  }, pick(18197, scratch), 'the SCRATCH tenant connection');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n\n══ receiver resolution, stated plainly ══');

function receiverVerdict(label, liveRes, scopedRes) {
  if (!liveRes && !scopedRes) { fail(label + ': no observation at all'); return; }
  const lConn = liveRes && liveRes.rec.conn === mainDb;
  const sConn = scopedRes && scopedRes.rec.conn === scratch;
  console.log('   ' + label + ':');
  if (liveRes) console.log('       unscoped  → ' + (lConn ? 'the MAIN connection' : 'NOT the main connection') +
    (liveRes.tr.viaSeam ? ', seam-wrapped' : ', RAW'));
  if (scopedRes) console.log('       ALS-scoped→ ' + (sConn ? 'the SCRATCH connection carried by tenantAls' : 'NOT the ALS store — it did not follow the scope') +
    (scopedRes.tr.viaSeam ? ', seam-wrapped' : ', RAW'));
  if (liveRes && scopedRes) {
    if (lConn && sConn) ok(label + ': the receiver FOLLOWS the tenant scope — this is the TENANT handle, seam-wrapped');
    else fail(label + ': the receiver did NOT follow the tenant scope');
  }
}
if (site1) {
  console.log('   products.js:454:');
  console.log('       receiver → ' + (site1.rec.conn === mainDb ? 'the MAIN connection' : 'NOT main') +
    (site1.tr.viaSeam ? ', seam-wrapped' : ', RAW'));
  note('module-level binding, not request-scoped: it can only ever be this handle');
}
receiverVerdict('retail.js:15899', site2live, site2scoped);
receiverVerdict('retail.js:18197', site3live, site3scoped);

// ── nothing was written ─────────────────────────────────────────────────────
console.log('\n══ writes attempted ══');
const wrote = RECORDS.filter((r) => r.ran && /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(r.sql));
console.log('   statements the handlers tried to execute as writes: ' + wrote.length + ' (all suppressed, none executed)');
for (const w of wrote) console.log('       ' + w.connLabel + '  ' + w.sql.replace(/\s+/g, ' ').slice(0, 90));
try { mainDb.exec('CREATE TABLE __ro_probe2__ (x)'); fail('live connection accepted a write AFTER the run'); }
catch (e) { ok('live connection still read-only at the end: ' + e.message); }

try { fs.rmSync(STUB_DIR, { recursive: true, force: true }); } catch (e) { /* scratch */ }

console.log('\n' + (FAILURES ? 'FAILURES: ' + FAILURES : 'ALL CHECKS PASSED'));
process.exit(FAILURES ? 1 : 0);
