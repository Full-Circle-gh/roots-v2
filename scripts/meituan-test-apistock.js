// END-TO-END test of the direct-API stock set, the basis for the daemon fix.
//   1. type product name  -> searchSugByName returns spuId
//   2. capture a list/detail response (getSpuListCommon / editor detail) that
//      carries wmProductSkuVos[].id (skuId) + current stock
//   3. POST /reuse/product/food/w/batchUpdateSkuStock (cookies only, no mtgsig)
//   4. verify by re-reading, then RESTORE the original stock
//
// Usage on the HK box:
//   pm2 stop meituan-sync
//   node scripts/meituan-test-apistock.js tianhe "红扁豆汤" 55
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

// Walk any JSON for a spu-shaped object matching the name; structure-agnostic:
// a spu has a name (matching term), an id, and a child array of SKUs where each
// item has an id + stock. Handles wmProductSkuVos / wmProductSkus / skus.
function skuArrayOf(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v) && v.length && v[0] && typeof v[0]==='object' &&
        ('id' in v[0]) && ('stock' in v[0]) && /sku/i.test(k)) return v;
  }
  return null;
}
function extractSku(node, term, hit) {
  if (!node || typeof node !== 'object' || hit.found) return;
  if (Array.isArray(node)) { for (const x of node) extractSku(x, term, hit); return; }
  if (typeof node.name === 'string' && node.name.includes(term) && ('id' in node)) {
    const skus = skuArrayOf(node);
    if (skus) {
      const sku = skus[0];
      hit.found = { spuId: String(node.id), skuId: String(sku.id), stock: sku.stock, maxStock: sku.maxStock, name: node.name };
      return;
    }
  }
  for (const k of Object.keys(node)) extractSku(node[k], term, hit);
}

async function writeStock(b, { spuId, skuId, wmPoiId, stock }) {
  // Fetch from a meituan frame so cookies + origin apply. No mtgsig needed.
  const frame = b.page.frames().find(f => f.url().includes('e.waimai.meituan.com') && !f.url().includes('imChat')) || b.page.mainFrame();
  return frame.evaluate(async ({ spuId, skuId, wmPoiId, stock }) => {
    const body = new URLSearchParams({
      v2:'1', opTab:'0', tagCat:'1', spuIds:String(spuId), wmPoiId:String(wmPoiId),
      stock:String(stock), maxStock:'-1', viewStyle:'0', skuIds:String(skuId), autoRefresh:'0',
      newSupplyParam: JSON.stringify({ wmPoiId:Number(wmPoiId), spuIds:String(spuId), templateId:-1,
        stockInfo: JSON.stringify({ skuId:0, stock:Number(stock), maxStock:-1, autoRefresh:0 }), requestSource:"1" })
    }).toString();
    const r = await fetch('/reuse/product/food/w/batchUpdateSkuStock', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body, credentials:'include'
    });
    let j = null; try { j = await r.json(); } catch(e){}
    return { status: r.status, code: j && j.code, msg: j && j.msg };
  }, { spuId, skuId, wmPoiId, stock });
}

(async () => {
  const store   = process.argv[2] || 'tianhe';
  const name    = process.argv[3] || '红扁豆汤';
  const testVal = process.argv[4] || '55';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const captured = [];
  let wmPoiId = null;
  b.page.on('response', async (resp) => {
    const u = resp.url();
    const m = u.match(/[?&]wmPoiId=(\d+)/); if (m) wmPoiId = m[1];
    if (!/searchByName|searchSugByName|getSpuListCommon|food\/r\/|getWmProductSpu|spuDetail|productDetail/i.test(u)) return;
    if (/lx\d?\.meituan|fingerprint|\/report/i.test(u)) return;
    try { captured.push({ url: u.split('?')[0], data: await resp.json() }); } catch (e) {}
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);
  const frame = await productFrame(b);
  if (!frame) { console.log('no content frame'); await b.close(); process.exit(1); }
  await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display='none'; }).catch(()=>{});

  // Type name -> searchSugByName (spuId), then click suggestion -> editor/detail (skuId).
  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]');
  await sh.click({ timeout: 8000 }).catch(()=>{});
  await sh.fill(''); await sh.type(coreOf(name), { delay: 90 });
  await b.page.waitForTimeout(2500);

  // spuId from searchSugByName
  let spuId = null;
  const sug = captured.find(c => /searchSugByName/.test(c.url));
  if (sug) { const v = ((sug.data.data||{}).searchSugVos||[]).find(x => (x.name||'').includes(name)); if (v) spuId = String(v.spuId); }
  console.log('[test] spuId (from suggest):', spuId);

  if (!spuId) { console.log('[test] no spuId from suggest'); await b.close(); process.exit(1); }

  // Navigate DIRECTLY to the product editor by spuId (deterministic — no flaky
  // suggestion click). editView/v2 fires and carries wmProductSpu with skuId+stock.
  captured.length = 0;
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/editView?spuId=${spuId}`,
    { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(4000);

  // skuId + current stock from any captured spu-shaped response
  const hit = {};
  for (const c of captured) extractSku(c.data, name, hit);
  console.log('[test] extracted:', JSON.stringify(hit.found || null));
  console.log('[test] wmPoiId:', wmPoiId);

  if (!hit.found || !hit.found.spuId || !hit.found.skuId || !wmPoiId) {
    console.log('[test] MISSING ids — captured endpoints:', captured.map(c=>c.url).join(', '));
    // Debug: dump the editor/detail responses so we can see where skuId/name live.
    for (const c of captured) {
      if (/editView/i.test(c.url)) {
        const d = c.data && c.data.data;
        console.log(`\n# DEBUG editView data keys:`, d ? Object.keys(d).slice(0,50).join(',') : '(none)');
        const spu = d && (d.wmProductSpu || d.comboSpu || d.spu);
        if (spu) {
          console.log('  spu keys:', Object.keys(spu).slice(0,50).join(','));
          console.log('  spu.name=', spu.name, ' spu.id=', spu.id);
          // Dump every array field + its first item's keys (find where sku/stock live).
          for (const k of Object.keys(spu)) {
            if (Array.isArray(spu[k]) && spu[k].length && typeof spu[k][0] === 'object') {
              console.log(`  [${k}][0] keys:`, Object.keys(spu[k][0]).slice(0,30).join(','));
              console.log(`  [${k}][0] =`, JSON.stringify(spu[k][0],(kk,v)=>(typeof v==='string'&&v.length>40)?v.slice(0,40)+'…':v).slice(0,500));
            }
          }
        }
        // Hunt anywhere in the response for objects with id+stock (the sku).
        const skuHits = [];
        (function dig(n,p,dep){ if(!n||dep>7||typeof n!=='object')return;
          if(!Array.isArray(n) && ('id' in n) && ('stock' in n)) skuHits.push({path:p, id:n.id, stock:n.stock, spec:n.spec, name:n.name});
          for(const kk of Object.keys(n)) dig(n[kk], p+'.'+kk, dep+1);
        })(d,'data',0);
        if (skuHits.length) console.log('  id+stock objects found at:', JSON.stringify(skuHits.slice(0,8)));
      }
      if (/editView|initSaveSpuInfo|getWmProductSpu|spuDetail/i.test(c.url)) {
        console.log(`\n# DEBUG ${c.url}`);
        const d = c.data && c.data.data;
        console.log('  data type:', Array.isArray(d)?'array':typeof d, ' keys:', d && typeof d==='object' ? Object.keys(d).slice(0,40).join(',') : '');
        // hunt for wmProductSkuVos anywhere
        const found = [];
        (function dig(n,p,dep){ if(!n||dep>6||typeof n!=='object')return; if(n.wmProductSkuVos){ found.push({path:p, name:n.name, id:n.id, skus:(n.wmProductSkuVos||[]).map(s=>({id:s.id,stock:s.stock,spec:s.spec}))}); } for(const k of Object.keys(n)) dig(n[k], p+'.'+k, dep+1); })(d,'data',0);
        if (found.length) console.log('  wmProductSkuVos hits:', JSON.stringify(found).slice(0,800));
        else console.log('  no wmProductSkuVos; preview:', JSON.stringify(c.data,(k,v)=>(typeof v==='string'&&v.length>40)?v.slice(0,40)+'…':v).slice(0,900));
      }
    }
    await b.close(); process.exit(1);
  }
  const ids = { spuId: hit.found.spuId, skuId: hit.found.skuId, wmPoiId };
  const original = hit.found.stock;
  console.log(`[test] ORIGINAL stock = ${original}`);

  // WRITE test value
  const wv = (String(original) === String(testVal)) ? String(Number(testVal)-1) : String(testVal);
  console.log(`[test] writing stock=${wv} via API …`);
  const w1 = await writeStock(b, { ...ids, stock: wv });
  console.log('[test] write response:', JSON.stringify(w1));

  // Verify: hop to listView then back to the editor by spuId so editView/v2
  // re-fires fresh (editView->editView on the same hash is a no-op).
  await b.page.waitForTimeout(1500);
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(2500);
  captured.length = 0;
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/editView?spuId=${ids.spuId}`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(4000);
  const hit2 = {}; for (const c of captured) extractSku(c.data, name, hit2);
  console.log(`[test] AFTER WRITE stock = ${hit2.found ? hit2.found.stock : '?'} (expected ${wv}) -> ${hit2.found && String(hit2.found.stock)===String(wv) ? 'PERSISTED ✓' : 'NOT ✗'}`);

  // RESTORE original
  console.log(`[test] restoring stock=${original} …`);
  const w2 = await writeStock(b, { ...ids, stock: original });
  console.log('[test] restore response:', JSON.stringify(w2));

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
