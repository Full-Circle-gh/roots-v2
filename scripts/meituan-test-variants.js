// Multi-variant (multi-SKU) product diagnostic + write test.
// Resolves a product's spuId + category from searchSugByName, opens that
// category so getSpuListCommon returns the full product (with ALL its skus),
// dumps every sku, and (if a value is given) sets EVERY sku to that value and
// verifies — then restores. Use to design the all-variants stock push.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-test-variants.js tianhe "Shawarma" 0
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
async function productFrame(b) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await b.page.waitForTimeout(700);
    const frames = b.page.frames().filter(f =>
      f !== b.page.mainFrame() && f.url().includes('meituan.com') &&
      !f.url().startsWith('about:') && !f.url().includes('imChat'));
    for (const f of frames) {
      const hit = await f.$('input[placeholder="搜索商品或规格名称"]').catch(() => null);
      if (hit) return f;
    }
    const byUrl = frames.find(f => f.url().includes('region_id'));
    if (byUrl) return byUrl;
  }
  return null;
}
function findSpu(captured, name) {
  for (const c of captured) {
    if (!/getSpuListCommon/.test(c.url)) continue;
    const vos = (c.data && c.data.data && c.data.data.spuListVos) || [];
    const v = vos.find(x => (x.name || '').includes(name) || (x.name||'').includes(coreOf(name)));
    if (v) return v;
  }
  return null;
}
// Set ONE sku's stock (skuIds lists just that sku, so it's isolated).
async function writeSku(b, { spuId, skuId, wmPoiId, stock }) {
  const frame = b.page.frames().find(f => { try { return f.url().includes('e.waimai.meituan.com') && !f.url().includes('imChat'); } catch(e){ return false; } }) || b.page.mainFrame();
  return frame.evaluate(async ({ spuId, skuId, wmPoiId, stock }) => {
    const body = new URLSearchParams({
      v2:'1', opTab:'0', tagCat:'1', spuIds:String(spuId), wmPoiId:String(wmPoiId),
      stock:String(stock), maxStock:'-1', viewStyle:'0', skuIds:String(skuId), autoRefresh:'0',
      newSupplyParam: JSON.stringify({ wmPoiId:Number(wmPoiId), spuIds:String(spuId), templateId:-1,
        stockInfo: JSON.stringify({ skuId:0, stock:Number(stock), maxStock:-1, autoRefresh:0 }), requestSource:'1' })
    }).toString();
    const r = await fetch('/reuse/product/food/w/batchUpdateSkuStock', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body, credentials:'include' });
    let j=null; try { j = await r.json(); } catch(e){}
    return { status:r.status, code:j&&j.code, msg:j&&j.msg };
  }, { spuId, skuId, wmPoiId, stock });
}

(async () => {
  const store = process.argv[2] || 'tianhe';
  const name  = process.argv[3];
  const testVal = process.argv[4]; // optional; if given, set ALL skus to it
  if (!name) { console.log('usage: node scripts/meituan-test-variants.js <store> "<name>" [value]'); process.exit(1); }

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const captured = [];
  let wmPoiId = null;
  b.page.on('response', async (resp) => {
    const u = resp.url();
    const m = u.match(/[?&]wmPoiId=(\d+)/); if (m) wmPoiId = m[1];
    if (!/searchSugByName|getSpuListCommon/.test(u)) return;
    try { captured.push({ url:u.split('?')[0], data: await resp.json() }); } catch(e){}
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(3500);
  const frame = await productFrame(b);
  if (!frame) { console.log('no content frame'); await b.close(); process.exit(1); }
  await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display='none'; }).catch(()=>{});

  // search -> spuId + tagName (category)
  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]');
  await sh.click({ timeout:8000 }).catch(()=>{});
  await sh.fill(''); await sh.type(coreOf(name), { delay:90 });
  await b.page.waitForTimeout(2500);
  let sug = null;
  for (const c of captured) if (/searchSugByName/.test(c.url)) {
    const v = ((c.data.data||{}).searchSugVos||[]).find(x => (x.name||'').includes(coreOf(name)));
    if (v) sug = v;
  }
  if (!sug) { console.log('[var] not found in suggest for', JSON.stringify(coreOf(name))); await b.close(); process.exit(1); }
  console.log('[var] spuId:', sug.spuId, ' tagName:', sug.tagName);

  // open the product's category so getSpuListCommon returns it with all skus
  const cat = String(sug.tagName||'').replace(/[^一-鿿A-Za-z0-9]/g,'').trim() || sug.tagName;
  captured.length = 0;
  try { await frame.locator(`text=${cat}`).first().click({ timeout:6000 }); }
  catch (e) { console.log('[var] category click failed:', e.message); }
  await b.page.waitForTimeout(3500);

  const spu = findSpu(captured, name);
  if (!spu) { console.log('[var] spu not found in category list'); await b.close(); process.exit(1); }
  const skus = (spu.wmProductSkuVos || []).map(s => ({ id:String(s.id), spec:s.spec, stock:s.stock, maxStock:s.maxStock }));
  console.log('[var] product:', spu.name);
  console.log('[var] spu keys:', Object.keys(spu).join(','));
  console.log('[var] ALL SKUs (wmProductSkuVos):', JSON.stringify(skus, null, 1));
  // Toppings / add-ons live in a separate structure — dump every array on the spu
  // whose items carry an id (and show stock/name/spec), so we see the +sauce rows.
  for (const k of Object.keys(spu)) {
    const v = spu[k];
    if (Array.isArray(v) && v.length && v[0] && typeof v[0]==='object' && ('id' in v[0]) && k !== 'wmProductSkuVos') {
      console.log(`[var] [${k}] (${v.length}):`, JSON.stringify(v.map(x => ({ id:x.id, name:x.name, spec:x.spec, stock:x.stock, skuId:x.skuId })).slice(0,12)));
    } else if (v && typeof v==='object' && !Array.isArray(v) && /topping|combo|attr/i.test(k)) {
      console.log(`[var] [${k}] obj keys:`, Object.keys(v).join(','));
    }
  }
  console.log('[var] wmPoiId:', wmPoiId);

  if (testVal === undefined) { await b.close(); process.exit(0); }
  if (!wmPoiId || !skus.length) { console.log('[var] missing wmPoiId/skus'); await b.close(); process.exit(1); }

  // Apply the per-variant rule for a simulated Roots stock N:
  //   N >= 3 -> every sku = BIG; N <= 2 -> sku[0] (main) = N, others = 0.
  const N = Number(testVal), BIG = 999;
  const targets = skus.map((s, i) => (N >= 3) ? BIG : (i === 0 ? N : 0));
  const orig = skus.map(s => s.stock);
  console.log(`[var] rule for N=${N}: targets =`, JSON.stringify(targets));
  for (let i = 0; i < skus.length; i++) {
    const r = await writeSku(b, { spuId:String(spu.id), skuId:skus[i].id, wmPoiId, stock:targets[i] });
    console.log(`  sku[${i}] ${skus[i].spec} → ${targets[i]} :: ${JSON.stringify(r)}`);
    await b.page.waitForTimeout(500);
  }

  // verify — reload category, re-read all skus
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(3000);
  const f2 = await productFrame(b);
  await f2.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display='none'; }).catch(()=>{});
  captured.length = 0;
  try { await f2.locator(`text=${cat}`).first().click({ timeout:6000 }); } catch(e){}
  await b.page.waitForTimeout(3500);
  const spu2 = findSpu(captured, name);
  const after = spu2 ? (spu2.wmProductSkuVos||[]).map(s=>({ spec:s.spec, stock:s.stock })) : [];
  console.log('[var] AFTER:', JSON.stringify(after));
  const okAll = after.length===targets.length && after.every((s,i)=>String(s.stock)===String(targets[i]));
  console.log('[var] matches rule?', okAll ? 'YES ✓ (per-sku isolation works)' : 'NO ✗');

  // restore
  console.log('[var] restoring original per-sku stocks …');
  for (let i=0;i<skus.length;i++) {
    await writeSku(b, { spuId:String(spu.id), skuId:skus[i].id, wmPoiId, stock:orig[i] });
    await b.page.waitForTimeout(500);
  }

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
