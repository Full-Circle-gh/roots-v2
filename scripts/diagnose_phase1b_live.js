#!/usr/bin/env node
/**
 * diagnose_phase1b_live.js — is Materials Phase 1b actually RUNNING on the box?
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1b (§28 addendum item 2) was proven against a FIXTURE database before
 * it shipped. A fixture proves the logic is right; it proves nothing about
 * whether the code is on the server or loaded into the process serving
 * requests. This is that second question, asked on the box.
 *
 * It answers five things, in order of what could be wrong:
 *   1. Are the DEPLOYED bytes the COMMITTED bytes? (not "did the deploy say OK")
 *   2. Are the specific Phase 1b changes present in the deployed files, by name
 *      — ingredient_id in insertLineItems, the branch in applyReceivedToStock,
 *      the backorder fix, the shared alert path, the picker, the tag?
 *   3. Is the RUNNING process serving, settled, and running THOSE bytes?
 *   4. Does the line_conflict guard actually reject a both-ids line, executed
 *      out of the deployed file rather than read out of it?
 *   5. Does the Materials "Bought in" read path still return kitchen POs after
 *      the scope filter was dropped — run against LIVE data?
 *
 * READ-ONLY, AND IT PROVES IT
 * ---------------------------
 * The live database is opened with `readonly: true` and the connection is
 * proven read-only by attempting a write and aborting if the write is
 * accepted — the same contract every other diagnose_* script in here honours.
 *
 * Section 4 loads the DEPLOYED route module, so it is worth being explicit
 * about what that does NOT do: every one of that module's own requires is
 * replaced in the module cache before it is compiled, INCLUDING `../database`,
 * which is replaced with a stub that has no connection to anything. The real
 * database.js, routes/retail.js (which arms interval sweeps) and
 * routes/purchases.js (which schedules a backfill that writes) are never
 * executed. The handler under test therefore cannot reach the live database
 * even in principle, and the guard it exercises returns before any write in
 * any case.
 *
 * Nothing here restarts, ships, or touches a pm2 process — `pm2 jlist` reads
 * state and does not change it.
 *
 * Run through .github/workflows/ro-query.yml (workflow_dispatch), which stages
 * this file plus the CHECKOUT's lib/ routes/ middleware/ into a scratch dir and
 * runs it with ROOTS_HOME pointed there. That distinction is load-bearing here:
 *   ROOTS_HOME/routes/...  is the COMMITTED copy (from the checkout)
 *   DEPLOY_ROOT/routes/... is the DEPLOYED copy (what the server actually has)
 * Section 1 compares the two. A script that read only the staged copy would be
 * grading the checkout's homework, not the server's.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const { execFileSync } = require('child_process');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const PORT = Number(process.env.ROOTS_PORT || 4000);

let failures = 0;
let checks = 0;
function ok(msg)   { checks++; console.log('  PASS  ' + msg); }
function bad(msg)  { checks++; failures++; console.log('  FAIL  ' + msg); }
function assert(cond, msg) { if (cond) ok(msg); else bad(msg); }
function note(msg) { console.log('        · ' + msg); }

const deployed = f => path.join(DEPLOY_ROOT, f);
const staged   = f => path.join(HOME, f);
const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Pull one function's body out of a source file by name, so an assertion can
// say "inside insertLineItems" rather than "somewhere in this 900-line file".
// Brace-counting from the declaration; string/comment nesting is not modelled
// because these three functions contain no unbalanced braces in a literal.
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

console.log('db:          ' + DB_PATH);
console.log('deploy root: ' + DEPLOY_ROOT);
console.log('staged from: ' + HOME);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · are the DEPLOYED bytes the COMMITTED bytes ══');
// Only lib/ routes/ middleware/ are staged by ro-query, so only those two route
// files can be compared. public/ is grepped in section 2 instead — which is
// what the deploy's own sha1 gate already covered for all four files.
for (const f of ['routes/retail-purchasing.js', 'routes/retail-materials.js']) {
  const d = readIf(deployed(f));
  const s = readIf(staged(f));
  if (d === null) { bad(`${f} — MISSING from the deployed tree`); continue; }
  if (s === null) { note(`${f} — not staged for comparison, skipped`); continue; }
  assert(sha256(d) === sha256(s),
    `${f} — deployed bytes identical to this commit's (sha256 ${sha256(d).slice(0, 12)})`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · are the Phase 1b changes present in the DEPLOYED files ══');

const rp = readIf(deployed('routes/retail-purchasing.js'));
if (!rp) { bad('routes/retail-purchasing.js unreadable — cannot check further'); }
else {
  // 2a. insertLineItems carries ingredient_id in its INSERT column list.
  const ili = functionBody(rp, 'function insertLineItems');
  if (!ili) bad('insertLineItems — not found in the deployed file');
  else {
    const cols = (ili.match(/INSERT INTO po_line_items\s*\(([^)]*)\)/) || [])[1] || '';
    assert(/\bingredient_id\b/.test(cols),
      'insertLineItems — ingredient_id is in the INSERT column list');
    // The placeholder count must match the column count, or every line after
    // the inserted column would bind one position to the left.
    const colN = cols.split(',').filter(c => c.trim()).length;
    const vals = (ili.match(/VALUES\s*\(([^)]*)\)/) || [])[1] || '';
    const valN = vals.split(',').filter(c => c.trim() === '?').length;
    assert(colN === valN && colN > 0,
      `insertLineItems — ${colN} columns bind ${valN} placeholders`);
    assert(/ing\.buy_unit/.test(ili),
      'insertLineItems — a material line defaults its unit from ingredients.buy_unit');
  }

  // 2b. applyReceivedToStock branches on line type.
  const ars = functionBody(rp, 'function applyReceivedToStock');
  if (!ars) bad('applyReceivedToStock — not found in the deployed file');
  else {
    assert(/if\s*\(\s*l\.ingredient_id\s*\)\s*continue\s*;/.test(ars),
      'applyReceivedToStock — a material line short-circuits before any stock write');
    assert(/\bingredient_id\b/.test((ars.match(/SELECT([\s\S]*?)FROM po_line_items/) || [])[1] || ''),
      'applyReceivedToStock — its SELECT reads ingredient_id (so the branch can see it)');
    // The branch must come BEFORE the adjustStock call, or it guards nothing.
    const iBranch = ars.indexOf('l.ingredient_id');
    const iAdjust = ars.indexOf('inventory.adjustStock');
    assert(iBranch !== -1 && iAdjust !== -1 && iBranch < iAdjust,
      'applyReceivedToStock — the branch precedes inventory.adjustStock');
  }

  // 2c. The backorder fix — carried-over lines keep ingredient_id.
  const boIdx = rp.indexOf("purchases/:id/backorder");
  const boSlice = boIdx === -1 ? '' : rp.slice(boIdx, boIdx + 2600);
  const boCols = (boSlice.match(/INSERT INTO po_line_items\s*\(([^)]*)\)/) || [])[1] || '';
  assert(/\bingredient_id\b/.test(boCols),
    'backorder route — ingredient_id is in its INSERT column list (the fix)');
  assert(/ins\.run\(\s*newId,\s*l\.store_product_id,\s*l\.ingredient_id/.test(boSlice),
    'backorder route — l.ingredient_id is actually bound, not just declared');

  // 2d. One alert path, shared with the kitchen — not a second implementation.
  assert(/require\(['"]\.\/purchases['"]\)/.test(rp),
    "retail-purchasing requires ./purchases (the kitchen's write-back)");
  assert(/firePriceAlertsForPO/.test(rp),
    'retail-purchasing calls firePriceAlertsForPO');
  assert(!/INSERT INTO ingredient_price_history/.test(rp),
    'retail-purchasing does NOT write ingredient_price_history itself (no second path)');
  assert(!/INSERT INTO price_alerts/.test(rp),
    'retail-purchasing does NOT write price_alerts itself (no second path)');
  const fireCalls = (rp.match(/firePriceAlertsForPO\(po\.id/g) || []).length;
  assert(fireCalls >= 2,
    `retail-purchasing fires the write-back from ${fireCalls} call sites (status + items-edit)`);

  // 2e. The mutual-exclusivity guard, wired into both write paths.
  assert(/function lineConflict/.test(rp), 'lineConflict — defined in the deployed file');
  const guardCalls = (rp.match(/if\s*\(lineConflict\(items\)\)/g) || []).length;
  assert(guardCalls === 2,
    `lineConflict — called on ${guardCalls} write paths (expected 2: POST and PUT)`);
}

const rm = readIf(deployed('routes/retail-materials.js'));
if (!rm) bad('routes/retail-materials.js unreadable');
else {
  const boughtIn = (rm.match(/const purchases = db\.prepare\(`([\s\S]*?)`\)/) || [])[1] || '';
  assert(boughtIn.length > 0, 'Materials record — the Bought-in query was located');
  assert(!/scope/.test(boughtIn),
    "Bought-in query — the scope='kitchen' filter is GONE (retail POs can appear)");
  assert(/pli\.ingredient_id = \?/.test(boughtIn),
    'Bought-in query — still keyed on ingredient_id');
}

const pu = readIf(deployed('public/retail-admin/16-purchasing.js'));
if (!pu) bad('public/retail-admin/16-purchasing.js unreadable');
else {
  for (const [sym, what] of [
    ['puPickMaterial',      'the material picker entry point'],
    ['addOrSetMaterialLine', 'the material line builder'],
    ['matBadge',            'the material tag'],
    ['materialsFeatureOn',  'the tenant feature gate'],
    ['/api/retail-admin/materials', 'the materials search endpoint'],
  ]) assert(pu.includes(sym), `16-purchasing.js — ${what} (${sym}) is deployed`);
  assert(/ingredient_id: it\.ingredient_id/.test(pu),
    '16-purchasing.js — ingredient_id round-trips in the save payload');
  assert(/m\.buy_unit/.test(pu),
    '16-purchasing.js — a picked material seeds its unit from buy_unit');
}

const css = readIf(deployed('public/retail-admin.css'));
assert(css !== null && css.includes('pu2-mattag'),
  'retail-admin.css — the material tag style is deployed');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · is the RUNNING process serving, and running THOSE bytes ══');

let proc = null;
try {
  const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  proc = JSON.parse(raw).find(p => p.name === 'roots-v2') || null;
} catch (e) { note('pm2 jlist failed: ' + e.message); }

if (!proc) bad('pm2 — roots-v2 process not found');
else {
  const env = proc.pm2_env || {};
  assert(env.status === 'online', `pm2 — status is "${env.status}"`);
  const unstable = env.unstable_restarts || 0;
  assert(unstable === 0, `pm2 — unstable_restarts = ${unstable}`);
  note(`pm2 — restart_time = ${env.restart_time}, pid = ${proc.pid}`);

  // The decisive one: a file on disk is not code in memory. If the process
  // started AFTER the new bytes landed, the running process is running them.
  const upMs = env.pm_uptime || 0;
  const mtime = fs.statSync(deployed('routes/retail-purchasing.js')).mtimeMs;
  assert(upMs > mtime,
    'pm2 — the process started AFTER the new routes/retail-purchasing.js landed '
    + `(process ${new Date(upMs).toISOString()} > file ${new Date(mtime).toISOString()})`);
  note(`process has been up ${Math.round((Date.now() - upMs) / 1000)}s`);
}

// /health, which the installer's own probe set does not cover.
function get(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: e.message }));
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Sections 4 and 5 need async / the database, so the rest runs in main().
async function main() {
  const health = await get('/health');
  assert(health.status === 200, `/health — returned ${health.status}`);
  let hj = null;
  try { hj = JSON.parse(health.body); } catch (e) { /* reported below */ }
  assert(hj && hj.status === 'ok', `/health — body reports status "${hj && hj.status}"`);
  if (hj) note(`/health — version ${hj.version}, time ${hj.time}`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 4 · does the deployed line_conflict guard actually reject ══');
  // The DEPLOYED module is compiled with every one of its requires replaced,
  // so the real database / retail / purchases modules never execute and the
  // handler cannot reach the live database. See the header note.
  let router = null;
  try {
    const rpPath = deployed('routes/retail-purchasing.js');
    const rpDir = path.dirname(rpPath);
    const SENTINEL = '__phase1b_probe_reached_the_db_layer__';
    const dbStub = {
      prepare() { return { get() { throw new Error(SENTINEL); }, all() { return []; }, run() { throw new Error(SENTINEL); } }; },
      transaction(fn) { return fn; },
    };
    const stubs = {
      'database.js':            dbStub,
      'lib/tenant-db.js':       { tdb: () => dbStub, currentTenantId: () => 1 },
      'lib/inventory.js':       { getStore: () => ({ id: 1, name_en: 'probe' }), listStores: () => [], adjustStock: () => {} },
      'lib/category-text.js':   { storeCategory: (_d, v) => v || null },
      'middleware/auth.js':     { logActivity: () => {} },
      'routes/retail.js':       { requireRetailAdmin: (req, res, next) => next() },
      'routes/purchases.js':    { firePriceAlertsForPO: () => {} },
    };
    for (const [rel, exp] of Object.entries(stubs)) {
      const abs = path.join(DEPLOY_ROOT, rel);
      require.cache[abs] = { id: abs, filename: abs, path: path.dirname(abs), loaded: true, children: [], paths: [], exports: exp };
    }
    const mod = new Module(rpPath, null);
    mod.filename = rpPath;
    mod.paths = Module._nodeModulePaths(rpDir);
    mod._compile(fs.readFileSync(rpPath, 'utf8'), rpPath);
    router = mod.exports;

    const handler = (() => {
      for (const layer of router.stack || []) {
        if (layer.route && layer.route.path === '/api/retail-admin/purchases' && layer.route.methods.post) {
          return layer.route.stack[layer.route.stack.length - 1].handle;
        }
      }
      return null;
    })();

    if (!handler) bad('POST /api/retail-admin/purchases — handler not found in the deployed router');
    else {
      // The route logs its own catch to console.error, and the control cases
      // are SUPPOSED to land there (that is how we detect they got past the
      // guard). Silenced for the duration so an expected log does not read as
      // a fault in the report.
      const call = items => {
        const res = { statusCode: 200, body: null };
        res.status = c => { res.statusCode = c; return res; };
        res.json = b => { res.body = b; return res; };
        const realErr = console.error;
        console.error = () => {};
        try {
          handler({ body: { date: '2026-01-01', store_id: 1, items }, params: {}, query: {},
                    user: { id: 0, username: 'ro-probe' }, ip: '127.0.0.1' }, res);
        } finally { console.error = realErr; }
        return res;
      };

      // The case that must be refused.
      const conflict = call([{ store_product_id: 1, ingredient_id: 1, qty: 1, cost_per_unit: 1 }]);
      assert(conflict.statusCode === 400 && conflict.body && conflict.body.error === 'line_conflict',
        `both-ids line — refused ${conflict.statusCode} ${conflict.body && conflict.body.error}`);

      // Controls: a single-id line of EITHER kind must pass the guard. It then
      // reaches the DB layer and hits the stub's sentinel, which is how we know
      // it got past the guard rather than being refused for some other reason.
      for (const [label, item] of [
        ['product-only line', { store_product_id: 1, qty: 1, cost_per_unit: 1 }],
        ['material-only line', { ingredient_id: 1, qty: 1, cost_per_unit: 1 }],
      ]) {
        const r = call([item]);
        const refusedByGuard = r.body && r.body.error === 'line_conflict';
        const reachedDb = r.body && typeof r.body.error === 'string' && r.body.error.includes(SENTINEL);
        assert(!refusedByGuard && reachedDb,
          `${label} — passes the guard and proceeds (reached the write path)`);
      }
    }
  } catch (e) {
    bad('line_conflict probe — could not exercise the deployed handler: ' + e.message);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 5 · Bought-in read path, against LIVE data ══');
  if (!fs.existsSync(DB_PATH)) { bad('no database at ' + DB_PATH); return; }
  const Database = require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('  read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) { console.error('FATAL: the connection accepted a write.'); process.exit(2); }

  const boughtInSql = (rm.match(/const purchases = db\.prepare\(`([\s\S]*?)`\)/) || [])[1];
  if (!boughtInSql) { bad('could not extract the deployed Bought-in query'); return; }

  // A real material with real KITCHEN purchase history — the read path that
  // must not have regressed when the scope filter came off.
  const subject = db.prepare(`
    SELECT pli.ingredient_id AS id, COUNT(*) AS n
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.ingredient_id IS NOT NULL AND COALESCE(po.scope,'kitchen') = 'kitchen'
     GROUP BY 1 ORDER BY n DESC LIMIT 1`).get();

  if (!subject) { bad('no material on the box has kitchen PO history — cannot test the read path'); }
  else {
    const ing = db.prepare('SELECT id, name_en, sku FROM ingredients WHERE id = ?').get(subject.id) || {};
    note(`subject: ingredient #${subject.id} "${ing.name_en || '?'}" (${ing.sku || 'no sku'}), ${subject.n} kitchen PO line(s)`);

    const now = db.prepare(boughtInSql).all(subject.id);
    assert(now.length > 0, `deployed Bought-in query returns ${now.length} row(s) for it`);
    assert(now.some(r => String(r.po_number || '').startsWith('PO-')),
      'the result still contains kitchen POs (PO-…) — the scope drop did not break the kitchen read');

    // The old query, for a like-for-like comparison on today's data.
    const before = db.prepare(boughtInSql.replace(
      /WHERE pli\.ingredient_id = \?/,
      "WHERE pli.ingredient_id = ? AND COALESCE(po.scope, 'kitchen') = 'kitchen'")).all(subject.id);
    assert(before.length === now.length,
      `identical to the pre-change query on today's data (${before.length} rows before, ${now.length} now)`);
  }

  // Why those two are identical today, stated rather than assumed: nothing has
  // bought a material through a retail PO yet. The moment one does, the new
  // query returns MORE than the old one — which is the point of the change.
  const retailMatLines = db.prepare(`
    SELECT COUNT(*) AS n FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.ingredient_id IS NOT NULL AND COALESCE(po.scope,'kitchen') = 'retail'`).get().n;
  note(`retail PO lines carrying a material, live right now: ${retailMatLines}`);

  const schema = db.prepare("SELECT name FROM pragma_table_info('ingredients')").all().map(r => r.name);
  const stockish = schema.filter(n => n !== 'pack_contents_qty' && /qty|stock|on_hand/i.test(n));
  assert(stockish.length === 0,
    `ingredients still has no on-hand-quantity column (§28) — found: ${stockish.join(',') || 'none'}`);

  db.close();
}

main().then(() => {
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — ${checks} checks`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(e => { console.error('PROBE ERROR:', e); process.exit(2); });
