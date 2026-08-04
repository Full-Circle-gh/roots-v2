// Meituan RETAIL order-list probe v3 — capture the real call the UI makes to
// render order rows. tianhe is on Meituan Retail (hasMigratedToRetail:true), so
// the waimai list endpoints only return counts. Here we drive the real order UI
// (across every frame), click the "全部 / 配送中" tabs to force the list load,
// and dump every XHR + full bodies of anything carrying order-detail fields.
//
// Usage on the HK box (daemon stopped):
//   pm2 stop meituan-sync && node scripts/meituan-order-probe3.js tianhe ; pm2 start meituan-sync

'use strict';
const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
require('../database');
const { MeituanBrowser } = require('../lib/meituan-browser');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

const DETAIL_RX = /(wmOrderId|orderViewId|wmOrderViewId|recipient|收货|skuName|foodName|productName|spuName|orderDaySeq|daySeq|商品|poiReceiveTime|latestArrivalTime)/;
const SKIP_RX   = /(horn_config|menuMatchConfig|menu\/list|H5guard|catfront|\.png|\.js|\.css|llog|logger|report|pushToken|notice|gray|switch|im\/|chat|neixin)/i;

(async () => {
  const store = process.argv[2] || 'tianhe';
  const b = new MeituanBrowser(store);
  await b.init();

  const allUrls = new Set();
  const detail  = [];
  b.page.on('response', async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()['content-type'] || '');
      if (!/json/.test(ct)) return;
      const short = u.split('?')[0];
      allUrls.add(short);
      if (SKIP_RX.test(u)) return;
      const t = await resp.text();
      if (DETAIL_RX.test(t) && t.length > 200) {
        const req = resp.request();
        // For the order-list pages, extract the STRUCTURED item list from each
        // order's orderInfo (JSON string) so we can see foodName/count/sku shape.
        let foodDump = null;
        if (/order\/list\/page\//.test(short)) {
          try {
            const j = JSON.parse(t);
            foodDump = (j.data?.orderList || []).map(o => {
              const oi = JSON.parse(o.orderInfo || '{}');
              const u = oi.unifiedOrderInfo || {};
              // Hunt for any array that looks like a food/product list.
              const arrays = {};
              for (const [k, v] of Object.entries(u)) {
                if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
                  const keys = Object.keys(v[0]);
                  if (keys.some(kk => /food|sku|product|name|count|qty|spec/i.test(kk)))
                    arrays[k] = v;
                }
              }
              return { wmOrderViewId: u.wmOrderViewId, copy: u.copyButtonVo?.clickCopyContent, foodArrays: arrays };
            });
          } catch (e) { foodDump = 'parse err: ' + e.message; }
        }
        detail.push({ url: short, method: req.method(), postData: req.postData() || null,
                      body: foodDump ? JSON.stringify(foodDump, null, 1).slice(0, 9000) : (t.length > 2500 ? t.slice(0, 2500) + '…[trunc]' : t) });
      }
    } catch (e) {}
  });

  if (!await b.ensureLoggedIn()) { console.log('NOT logged in'); await b.close(); process.exit(1); }
  // The REAL order list lives in the orderbusiness app, not #/order.
  // Visit "全部订单" (history) and "今日待办" (unprocessed) so their list XHR fires.
  for (const route of ['/new_fe/orderbusiness#/order/history',
                       '/new_fe/orderbusiness#/order/unprocessed']) {
    console.log(`[oprobe3] navigating ${route}`);
    await b.page.goto(`${MERCHANT_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await b.page.waitForTimeout(8000);
  }

  // Operate on EVERY frame (the order list lives in a nested content iframe).
  for (const frame of b.page.frames()) {
    // Report what clickable order-ish text this frame actually has.
    try {
      const labels = await frame.evaluate(() => Array.from(document.querySelectorAll('*'))
        .filter(e => e.children.length === 0)
        .map(e => (e.innerText || '').trim())
        .filter(t => t && t.length <= 10 && /全部|配送|进行|完成|取消|待|订单|详情|已取餐/.test(t)));
      if (labels.length) console.log(`[oprobe3] frame ${frame.url().slice(0,50)} labels:`, JSON.stringify([...new Set(labels)].slice(0,20)));
    } catch (e) {}
    for (const label of ['全部', '配送中', '进行中', '全部订单', '已完成', '查看配送详情', '骑手已取餐']) {
      try {
        const el = await frame.$(`text=${label}`);
        if (el) {
          await el.click({ timeout: 2500 });
          console.log(`[oprobe3] clicked "${label}"`);
          await frame.waitForTimeout(3000);
        }
      } catch (e) {}
    }
    try { await frame.evaluate(() => window.scrollBy(0, 1200)); await frame.waitForTimeout(1500); } catch (e) {}
  }
  await b.page.waitForTimeout(2000);

  console.log('\n───── ORDER-DETAIL-CARRYING RESPONSES ─────');
  const seen = new Set();
  for (const d of detail) {
    if (seen.has(d.url)) continue; seen.add(d.url);
    console.log(`\n### ${d.method} ${d.url}`);
    if (d.postData) console.log('POST:', d.postData);
    console.log(d.body);
  }
  console.log('\n───── ALL JSON ENDPOINTS HIT ─────');
  for (const u of [...allUrls].sort()) console.log('  ' + u);
  console.log(`\ndetail responses: ${detail.length}; unique endpoints: ${allUrls.size}`);
  await b.close();
  process.exit(0);
})().catch(e => { console.error('[oprobe3] error:', e); process.exit(1); });
