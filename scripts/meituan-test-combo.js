// Combo (套餐) stock test. Combos' full editor (editView/v2) is broken on
// Meituan's side (code 100036 "暂时不支持编辑"), so we get spuId+skuId from the
// LIST api (getSpuListCommon) by opening the combo's category, then set stock via
// batchUpdateSkuStock (the inline-editor api, separate from the broken editor).
//
//   pm2 stop meituan-sync
//   node scripts/meituan-test-combo.js tianhe "套餐" "法拉费卷套餐" 30
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

// Find the combo in any captured getSpuListCommon, return {spuId, skuId, stock}.
function findInList(captured, name) {
  for (const c of captured) {
    if (!/getSpuListCommon/.test(c.url)) continue;
    const vos = (c.data && c.data.data && c.data.data.spuListVos) || [];
    const v = vos.find(x => (x.name || '').includes(name));
    if (v && v.wmProductSkuVos && v.wmProductSkuVos[0]) {
      return { spuId: String(v.id), skuId: String(v.wmProductSkuVos[0].id), stock: v.wmProductSkuVos[0].stock, fullName: v.name };
    }
  }
  return null;
}

async function loadCategory(b, frame, captured, catHint) {
  captured.length = 0;
  // Click the category in the left rail (real click so the list reloads).
  try { await frame.locator(`text=${catHint}`).first().click({ timeout: 6000 }); }
  catch (e) { console.log('[combo] category click failed:', e.message); }
  await b.page.waitForTimeout(3500);
}

async function writeStock(b, { spuId, skuId, wmPoiId, stock }) {
  const frame = b.page.frames().find(f => { try { return f.url().includes('e.waimai.meituan.com') && !f.url().includes('imChat'); } catch (e) { return false; } }) || b.page.mainFrame();
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
  const store   = process.argv[2] || 'tianhe';
  const catHint = process.argv[3] || '套餐';
  const name    = process.argv[4] || '法拉费卷套餐';
  const testVal = process.argv[5] || '30';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const captured = [];
  let wmPoiId = null;
  b.page.on('response', async (resp) => {
    const u = resp.url();
    const m = u.match(/[?&]wmPoiId=(\d+)/); if (m) wmPoiId = m[1];
    if (!/getSpuListCommon/.test(u)) return;
    try { captured.push({ url: u.split('?')[0], data: await resp.json() }); } catch (e) {}
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(3500);
  const frame = await productFrame(b);
  if (!frame) { console.log('no content frame'); await b.close(); process.exit(1); }
  await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display='none'; }).catch(()=>{});

  await loadCategory(b, frame, captured, catHint);
  const found = findInList(captured, name);
  console.log('[combo] resolved from list:', JSON.stringify(found), ' wmPoiId:', wmPoiId);
  if (!found) {
    console.log('[combo] NOT FOUND in category. Names seen:');
    for (const c of captured) if (/getSpuListCommon/.test(c.url)) {
      const vos = (c.data && c.data.data && c.data.data.spuListVos) || [];
      console.log('  ', vos.map(v=>v.name).join(' | ').slice(0,400));
    }
    await b.close(); process.exit(1);
  }
  if (!wmPoiId) { console.log('[combo] no wmPoiId'); await b.close(); process.exit(1); }

  const wv = (String(found.stock)===String(testVal)) ? String(Number(testVal)-1) : String(testVal);
  console.log(`[combo] ORIGINAL stock=${found.stock}; writing ${wv} …`);
  const w1 = await writeStock(b, { spuId:found.spuId, skuId:found.skuId, wmPoiId, stock:wv });
  console.log('[combo] write response:', JSON.stringify(w1));

  // verify: reload category, re-read
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(3000);
  const f2 = await productFrame(b);
  await loadCategory(b, f2, captured, catHint);
  const after = findInList(captured, name);
  console.log(`[combo] AFTER stock=${after?after.stock:'?'} (expected ${wv}) -> ${after && String(after.stock)===String(wv) ? 'PERSISTED ✓':'NOT ✗'}`);

  console.log(`[combo] restoring ${found.stock} …`);
  await writeStock(b, { spuId:found.spuId, skuId:found.skuId, wmPoiId, stock:found.stock });

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
