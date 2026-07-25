/* global document --
   a browser global referenced INSIDE page.evaluate() callbacks, which run in the
   Chrome page context (not Node). Declaring it keeps the deploy's eslint no-undef
   gate happy without disabling the rule for genuine Node typos. Same treatment as
   lib/meituan-browser.js and lib/qingyun-browser.js. */

// Integration test for the multi-variant rule in lib/meituan-browser.js.
// Calls the REAL b.updateStock() for a multi-SKU product at N=2 (low) and N=5
// (plenty), verifies the per-variant result, then restores the originals.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-test-libvariants.js tianhe "Falafel Wrap"
//   pm2 start meituan-sync
'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
require('../database');
const { MeituanBrowser } = require('../lib/meituan-browser');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

function coreOf(term) {
  const m = term.match(/^[一-鿿]+/) || term.match(/^[A-Za-z][A-Za-z ]*[A-Za-z]/) || term.match(/^[A-Za-z]+/);
  const c = m ? m[0].trim() : term;
  return c.length >= 2 ? c : term;
}

// Fresh read of {spuId, skus:[{skuId,spec,stock}]} via the browser's own helpers.
async function readSkus(b, name) {
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(3500);
  const frame = await b._getProductFrame();
  if (!frame) return null;
  await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display='none'; }).catch(()=>{});
  b._apiCap = [];
  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]');
  if (!sh) return null;
  await sh.click({ timeout:8000 }).catch(()=>{});
  await sh.fill(''); await sh.type(coreOf(name), { delay:90 });
  await frame.waitForTimeout(2200);
  const sug = b._sugFromCapture(name, '');
  if (!sug) return null;
  const cat = String(sug.tagName||'').replace(/[^一-鿿A-Za-z0-9]/g,'');
  b._apiCap = [];
  if (cat) { try { await frame.locator(`text=${cat}`).first().click({ timeout:6000 }); } catch(e){} }
  await frame.waitForTimeout(3500);
  const skus = b._skusFromSpuList(sug.spuId, name, '');
  return skus ? { spuId: String(sug.spuId), skus } : null;
}

function fmt(skus) { return JSON.stringify((skus||[]).map(s => ({ spec:s.spec, stock:s.stock }))); }

(async () => {
  const store = process.argv[2] || 'tianhe';
  const name  = process.argv[3] || 'Falafel Wrap';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const before = await readSkus(b, name);
  if (!before || !before.skus.length) { console.log('[libvar] could not read product'); await b.close(); process.exit(1); }
  console.log(`[libvar] ${name}: ${before.skus.length} SKU(s)`);
  console.log('[libvar] ORIGINAL:', fmt(before.skus));

  // N = 2 (low): main = 2, others = 0
  b._idCache.delete(name); // force a fresh resolve through updateStock
  console.log('\n[libvar] updateStock(N=2) …');
  await b.updateStock(name, '', 2);
  const a2 = await readSkus(b, name);
  const want2 = before.skus.map((s,i) => i===0 ? 2 : 0);
  const ok2 = a2 && a2.skus.every((s,i) => String(s.stock) === String(want2[i]));
  console.log('[libvar] AFTER N=2:', fmt(a2 && a2.skus), '→', ok2 ? 'PASS ✓ (main=2, rest=0)' : 'FAIL ✗');

  // N = 5 (plenty): all = 999
  console.log('\n[libvar] updateStock(N=5) …');
  await b.updateStock(name, '', 5);
  const a5 = await readSkus(b, name);
  const ok5 = a5 && a5.skus.every(s => String(s.stock) === '999');
  console.log('[libvar] AFTER N=5:', fmt(a5 && a5.skus), '→', ok5 ? 'PASS ✓ (all=999)' : 'FAIL ✗');

  // restore originals (direct per-sku)
  console.log('\n[libvar] restoring originals …');
  for (const s of before.skus) {
    await b._apiSetSku(before.spuId, s.skuId, s.stock, `${name} [${s.spec}]`);
    await b.page.waitForTimeout(500);
  }
  const fin = await readSkus(b, name);
  console.log('[libvar] RESTORED:', fmt(fin && fin.skus));

  console.log(`\n[libvar] RESULT: N=2 ${ok2?'PASS':'FAIL'}, N=5 ${ok5?'PASS':'FAIL'}`);
  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
