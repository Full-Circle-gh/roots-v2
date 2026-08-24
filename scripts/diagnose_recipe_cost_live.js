#!/usr/bin/env node
/**
 * diagnose_recipe_cost_live.js — is the shared recipe cost derivation actually
 * RUNNING on the box, and is it still producing the old numbers there?
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/diagnose_recipe_cost_parity.js proves the MATHS: the new module and
 * the three old browser formulas agree across every live recipe. It proves
 * nothing about whether that module reached the server, whether the process
 * serving requests has loaded it, or whether a browser can fetch it.
 *
 * The deploy's own health probe cannot answer this either. It checks `/`,
 * `/api/retail/categories`, `/api/retail/config` and `/api/retail/products`
 * (scripts/deploy-apply.sh:141) — not one of which touches a recipe screen or
 * /lib/recipe-cost.js. A deploy that shipped a broken cost helper would pass
 * that probe and go green.
 *
 * Five sections, ordered by what could be wrong:
 *   1. Are the DEPLOYED bytes the COMMITTED bytes? (not "did the deploy say OK")
 *   2. Are the specific step-1 changes present in the deployed files by NAME —
 *      the browser footer, the server route, the sw.js skip, the app.html script
 *      tag, and the absence of the old inline formulas.
 *   3. Is the RUNNING process serving, settled, and started AFTER those bytes?
 *   4. Does GET /lib/recipe-cost.js actually answer, with no-store, and do the
 *      SERVED bytes parse and expose window.RootsRecipeCost?
 *   5. Does the module loaded FROM THE DEPLOYED PATH still agree with the old
 *      formulas across every live recipe? (the parity gate, re-run against what
 *      is really on disk rather than against the checkout)
 *
 * READ-ONLY, AND IT PROVES IT. The live database is opened with readonly:true
 * and a write is attempted and required to fail before anything else runs.
 * Section 4 issues GETs only. Nothing restarts, ships, or touches pm2 —
 * `pm2 jlist` reads state and does not change it.
 *
 * The OLD formulas in section 5 are transcribed verbatim from
 * `git show origin/main:public/app.html` at the lines named, exactly as in
 * diagnose_recipe_cost_parity.js. Do not refactor them; they are the control.
 *
 * Run through .github/workflows/ro-query.yml (workflow_dispatch), which stages
 * this file plus the CHECKOUT's lib/ routes/ middleware/ into a scratch dir and
 * runs it with ROOTS_HOME pointed there. That distinction is load-bearing:
 *   ROOTS_HOME/lib/recipe-cost.js  is the COMMITTED copy (from the checkout)
 *   DEPLOY_ROOT/lib/recipe-cost.js is the DEPLOYED copy (what the server has)
 * Section 1 compares the two. A script that read only the staged copy would be
 * grading the checkout's homework, not the server's.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const PORT = Number(process.env.ROOTS_PORT || 4000);

let failures = 0, checks = 0;
function ok(msg)  { checks++; console.log('  PASS  ' + msg); }
function bad(msg) { checks++; failures++; console.log('  FAIL  ' + msg); }
function assert(cond, msg) { if (cond) ok(msg); else bad(msg); }
function note(msg) { console.log('        · ' + msg); }

const deployed = f => path.join(DEPLOY_ROOT, f);
const staged   = f => path.join(HOME, f);
const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

console.log('db:          ' + DB_PATH);
console.log('deploy root: ' + DEPLOY_ROOT);
console.log('staged from: ' + HOME);
console.log('run at (UTC): ' + new Date().toISOString());

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · are the DEPLOYED bytes the COMMITTED bytes ══');
// Only lib/ routes/ middleware/ are staged by ro-query, so lib/recipe-cost.js is
// the one file here that can be compared byte for byte. public/ and server.js are
// checked by content in section 2 instead.
{
  const f = 'lib/recipe-cost.js';
  const d = readIf(deployed(f));
  const s = readIf(staged(f));
  if (d === null) bad(`${f} — MISSING from the deployed tree`);
  else if (s === null) note(`${f} — not staged for comparison, skipped`);
  else assert(sha256(d) === sha256(s),
    `${f} — deployed bytes identical to this commit's (sha256 ${sha256(d).slice(0, 12)})`);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · are the step-1 changes present in the deployed files, by name ══');
{
  const lib = readIf(deployed('lib/recipe-cost.js')) || '';
  assert(/globalThis\.window\.RootsRecipeCost\s*=\s*API/.test(lib),
    'lib/recipe-cost.js — publishes window.RootsRecipeCost (the browser half of the dual export)');
  assert(/module\.exports\s*=\s*API/.test(lib),
    'lib/recipe-cost.js — still module.exports for Node (the export route requires it)');

  const srv = readIf(deployed('server.js')) || '';
  assert(/app\.get\(['"]\/lib\/recipe-cost\.js['"]/.test(srv),
    'server.js — serves /lib/recipe-cost.js');
  const routeBlock = srv.slice(srv.indexOf("app.get('/lib/recipe-cost.js'"), srv.indexOf("app.get('/lib/recipe-cost.js'") + 900);
  assert(/no-store/.test(routeBlock),
    'server.js — that route sends no-store (a cached money formula is the failure this prevents)');

  const sw = readIf(deployed('public/sw.js')) || '';
  assert(/url\.pathname === ['"]\/lib\/recipe-cost\.js['"]\) return/.test(sw),
    'public/sw.js — skips /lib/recipe-cost.js so a phone cannot cache it');

  const app = readIf(deployed('public/app.html')) || '';
  assert(/<script src="\/lib\/recipe-cost\.js"><\/script>/.test(app),
    'public/app.html — loads /lib/recipe-cost.js');
  assert(/function _recipeCostLib\(\)/.test(app),
    'public/app.html — has the missing-library guard (refuses to paint rather than show zeros)');

  // The three converted call sites must no longer carry their own arithmetic.
  // These fragments are the old formulas; any survivor means a copy was missed.
  const gone = [
    ['ingTotal+labour+packTotal',        'csUpdate/renderCS batch cost'],
    ['ingTotal + labour + packTotal',    'viewRecipe batch cost'],
    ['packaging*(servings>0?servings:1)', 'renderCS/csUpdate packaging guard'],
    ['packaging * (servings>0?servings:1)', 'viewRecipe packaging guard'],
    ['cpServ/(targetFC/100)',            'suggested sell price'],
  ];
  for (const [frag, what] of gone) {
    assert(!app.includes(frag), `public/app.html — old inline formula gone: ${what}`);
  }
  // _loadProductCtx()'s dead block is step 2 and is EXPECTED to still be here.
  // Asserted positively so that when step 2 lands, this line fails and gets
  // updated deliberately rather than the check quietly meaning nothing.
  assert(app.includes('fcPct: sellPrice>0&&cpServ!==null?cpServ/sellPrice*100:null,'),
    'public/app.html — _loadProductCtx dead block still present (step 2 removes it; expected now)');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · is the RUNNING process serving those bytes ══');
{
  let jlist = null;
  try { jlist = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })); }
  catch (e) { bad('pm2 jlist — could not be read: ' + e.message); }
  const proc = jlist && jlist.find(p => p.name === 'roots-v2');
  if (!proc) bad('pm2 — no process named roots-v2');
  else {
    const env = proc.pm2_env || {};
    assert(env.status === 'online', `pm2 — status is "${env.status}"`);
    const upMs = env.pm_uptime || 0;
    let mtime = 0;
    try { mtime = fs.statSync(deployed('lib/recipe-cost.js')).mtimeMs; } catch (e) {}
    assert(upMs > mtime,
      'pm2 — the process started AFTER lib/recipe-cost.js landed '
      + `(process ${new Date(upMs).toISOString()} > file ${new Date(mtime).toISOString()})`);
    let appMtime = 0;
    try { appMtime = fs.statSync(deployed('public/app.html')).mtimeMs; } catch (e) {}
    note(`public/app.html mtime ${new Date(appMtime).toISOString()} (served from disk per request, no restart needed)`);
    const upSec = Math.round((Date.now() - upMs) / 1000);
    note(`process has been up ${upSec}s, ${env.restart_time} restarts`);
    assert(upSec > 20, `pm2 — process has settled (${upSec}s > 20s, i.e. not crash-looping)`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
function get(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
  });
}

async function main() {
  console.log('\n══ 4 · can a browser actually fetch it, and is what it gets usable ══');
  const res = await get('/lib/recipe-cost.js');
  assert(res.status === 200, `GET /lib/recipe-cost.js — returned ${res.status}`);
  const cc = String(res.headers['cache-control'] || '');
  assert(/no-store/.test(cc), `GET /lib/recipe-cost.js — Cache-Control is "${cc}"`);
  assert(/javascript/.test(String(res.headers['content-type'] || '')),
    `GET /lib/recipe-cost.js — Content-Type is "${res.headers['content-type']}"`);
  // The served bytes must BE the deployed file, not a 500 fallback comment.
  const onDisk = readIf(deployed('lib/recipe-cost.js'));
  assert(onDisk !== null && res.body === onDisk,
    'GET /lib/recipe-cost.js — served bytes are identical to the file on disk');
  assert(!/cost helper unavailable/.test(res.body),
    'GET /lib/recipe-cost.js — not the read-failure fallback stub');

  // Evaluate the SERVED source the way a browser would, and confirm it
  // publishes a working API. This is the closest thing to loading the page.
  let served = null;
  try {
    const sandbox = { window: {} };
    const fn = new Function('window', 'module', 'globalThis', res.body + '\n;return window.RootsRecipeCost;');
    served = fn(sandbox.window, undefined, sandbox);
  } catch (e) {
    bad('served bytes — threw when evaluated as a browser would: ' + e.message);
  }
  assert(served && typeof served.computeRecipeCost === 'function',
    'served bytes — publish window.RootsRecipeCost.computeRecipeCost');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 5 · does the DEPLOYED module still match the old formulas on live data ══');
  const Database = (() => {
    try { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
    catch (e) { return require('better-sqlite3'); }
  })();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; note('read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write. Aborting.');
    process.exit(2);
  }

  // The DEPLOYED module — the one actually on the box.
  const { computeRecipeCost } = require(deployed('lib/recipe-cost.js'));

  // origin/main public/app.html:6483-6505 — viewRecipe(). Frozen control.
  function OLD_viewRecipe(rec, ings) {
    let ingTotal = 0, missingCount = 0;
    ings.forEach(i => {
      const free = !!i.master_free;
      const cpu = i.master_cost || 0;
      const line = free ? 0 : (cpu > 0 ? i.qty * cpu : null);
      if (line === null) missingCount++; else ingTotal += line;
    });
    const costData = rec.costData || {};
    const labour = parseFloat(costData.labour || 0);
    const packaging = parseFloat(costData.packaging || 0);
    const overhead = parseFloat(costData.overhead_pct || 0);
    const servings = parseFloat(rec.servings || 0);
    const packTotal = packaging * (servings > 0 ? servings : 1);
    const batchCost = ingTotal + labour + packTotal + (ingTotal * overhead / 100);
    const cpServ = servings > 0 ? batchCost / servings : null;
    const sellPrice = parseFloat(costData.sell_price || 0);
    const margin = (sellPrice > 0 && cpServ !== null) ? sellPrice - cpServ : null;
    const foodCostPct = (sellPrice > 0 && cpServ !== null) ? cpServ / sellPrice * 100 : null;
    return { ingTotal, missingCount, batchCost, cpServ, margin, foodCostPct };
  }
  // origin/main public/app.html:7673-7685 — renderCS(cd). Frozen control.
  function OLD_renderCS(rec, ingTotal, cd) {
    const labour = parseFloat(cd.labour || 0), packaging = parseFloat(cd.packaging || 0),
          overhead = parseFloat(cd.overhead_pct || 0), sellPrice = parseFloat(cd.sell_price || 0),
          servings = parseFloat(rec.servings || 0);
    const packTotal = packaging * (servings > 0 ? servings : 1);
    const batchCost = ingTotal + labour + packTotal + (ingTotal * overhead / 100);
    const cpServ = servings > 0 ? batchCost / servings : null;
    const batch = parseFloat(rec.batch_size) || 0;
    const cpGram = batch > 0 ? batchCost / batch : null;
    const targetFC = parseFloat(cd.target_food_cost || 30);
    const suggestSell = cpServ !== null && targetFC > 0 ? cpServ / (targetFC / 100) : null;
    return { batchCost, cpServ, cpGram, targetFC, suggestSell };
  }

  const SQL_INGREDIENTS = `SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
         i.free_by_design AS master_free
    FROM recipe_ingredients ri
    LEFT JOIN ingredients i ON ri.ingredient_id = i.id
   WHERE ri.recipe_id = ?
   ORDER BY ri.sort_order`;
  const recipes = db.prepare('SELECT * FROM recipes ORDER BY id').all();
  const getIngs = db.prepare(SQL_INGREDIENTS);
  const getCost = db.prepare('SELECT * FROM recipe_cost_data WHERE recipe_id = ?');

  let compared = 0, lines = 0, deltas = 0;
  const money = v => (v === null || v === undefined) ? '—' : '¥' + v.toFixed(2);
  for (const r of recipes) {
    const ings = getIngs.all(r.id);
    const costData = getCost.get(r.id);
    lines += ings.length;
    const rec = { ...r, ingredients: ings, costData };
    const o = OLD_viewRecipe(rec, ings);
    const n = computeRecipeCost({ recipe: rec, ingredients: ings, costData: costData || {} });
    const cd = costData || {};
    const oR = OLD_renderCS(rec, o.ingTotal, cd);
    const nR = computeRecipeCost({
      recipe: rec, ingredients: ings,
      costData: {
        labour: parseFloat(cd.labour || 0), packaging: parseFloat(cd.packaging || 0),
        overhead_pct: parseFloat(cd.overhead_pct || 0), sell_price: parseFloat(cd.sell_price || 0),
        target_food_cost: parseFloat(cd.target_food_cost || 30),
      },
    });
    const pairs = [
      ['ingTotal',    o.ingTotal,     n.ingredientCost],
      ['missing',     o.missingCount, n.zeroCostIngredientLines],
      ['batchCost',   o.batchCost,    n.batchCost],
      ['cpServ',      o.cpServ,       n.costPerServing],
      ['margin',      o.margin,       n.marginPerServing],
      ['foodCostPct', o.foodCostPct,  n.foodCostPct],
      ['cs:batch',    oR.batchCost,   nR.batchCost],
      ['cs:cpServ',   oR.cpServ,      nR.costPerServing],
      ['cs:cpGram',   oR.cpGram,      nR.costPerGram],
      ['cs:targetFC', oR.targetFC,    nR.targetFoodCost],
      ['cs:suggest',  oR.suggestSell, nR.suggestedSellPrice],
      ['render:batch', money(o.batchCost), money(n.batchCost)],
      ['render:cpServ', o.cpServ !== null ? money(o.cpServ) : '—',
                        n.costPerServing !== null ? money(n.costPerServing) : '—'],
    ];
    for (const [what, a, b] of pairs) {
      compared++;
      if (a !== b) {
        deltas++;
        if (deltas <= 20) console.log(`  DELTA recipe ${r.id} "${(r.name_en || '').slice(0, 32)}" ${what}: OLD=${JSON.stringify(a)} NEW=${JSON.stringify(b)}`);
      }
    }
  }
  note(`${recipes.length} recipes, ${lines} ingredient lines, ${compared} value comparisons`);
  assert(deltas === 0, `the DEPLOYED module reproduces the old numbers exactly (${deltas} deltas)`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n══ ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed ══`);
  if (failures > 0) {
    console.log('The shared recipe cost derivation is NOT correctly live on this box.');
    process.exit(1);
  }
  console.log('lib/recipe-cost.js is deployed, served, loaded by a settled process,');
  console.log('and still computes exactly what the old inline formulas did.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(2); });
