// Meituan order-LIST probe v2 — discover the endpoint that returns actual order
// rows+items, via in-page authenticated fetch (H5guard auto-signs mtgsig the
// same way the stock-push batchUpdateSkuStock call is signed). The new-order
// poll (order/list/interval, isCountReq=true) returns only counts; we need the
// data call. We try the same endpoint with isCountReq=false + a few scIndex
// buckets, and a couple of likely list/history endpoints, and dump the bodies.
//
// Usage on the HK box (daemon stopped so only one session is live):
//   pm2 stop meituan-sync && node scripts/meituan-order-probe2.js tianhe ; pm2 start meituan-sync

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

(async () => {
  const store = process.argv[2] || 'tianhe';
  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('NOT logged in'); await b.close(); process.exit(1); }

  // Sit on the order page so H5guard is initialised and the auth/POI context is live.
  await b.page.goto(`${MERCHANT_URL}/#/order`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await b.page.waitForTimeout(6000);

  // Run candidate calls from inside the page so H5guard signs them automatically.
  const result = await b.page.evaluate(async () => {
    const out = [];
    const today = new Date();
    const ymd = today.getFullYear().toString()
      + String(today.getMonth() + 1).padStart(2, '0')
      + String(today.getDate()).padStart(2, '0');

    async function tryPost(label, url, bodyStr) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'include',
          body: bodyStr,
        });
        const t = await r.text();
        out.push({ label, url, status: r.status, body: t.slice(0, 4000) });
      } catch (e) { out.push({ label, url, error: String(e) }); }
    }
    async function tryGet(label, url) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        const t = await r.text();
        out.push({ label, url, status: r.status, body: t.slice(0, 4000) });
      } catch (e) { out.push({ label, url, error: String(e) }); }
    }

    // 1) Same interval endpoint but ask for DATA not just counts, across buckets.
    for (const sc of [0, 1, 2, 3]) {
      await tryPost(`interval isCountReq=false scIndex=${sc}`,
        '/gw/api/unified/r/order/list/interval',
        `isAutoAccept=0&dateAndSeq=&countDateAndSeq=${ymd}&isCountReq=false&scIndex=${sc}`);
    }
    // 2) Likely paged order-list endpoints (status: in-progress / all).
    await tryPost('order/list page (status all)',
      '/gw/api/unified/r/order/list',
      `pageNum=1&pageSize=20&orderStatus=&menuTag=all&dateAndSeq=`);
    await tryPost('order/list page (logisticsing)',
      '/gw/api/unified/r/order/list',
      `pageNum=1&pageSize=20&menuTag=order_logisticsing&dateAndSeq=`);
    // 3) History list endpoints (older Meituan b-side shapes).
    await tryGet('history list v2',
      `/v2/order/history/r/list?pageNum=1&pageSize=20&orderStatus=0`);
    await tryPost('history list gw',
      '/gw/api/order/history/r/list',
      `pageNum=1&pageSize=20&orderStatus=0`);
    return out;
  });

  console.log('───── IN-PAGE ORDER FETCH RESULTS ─────');
  for (const r of result) {
    console.log(`\n### ${r.label}  →  ${r.url}`);
    if (r.error) { console.log('ERROR:', r.error); continue; }
    console.log(`status ${r.status}`);
    console.log(r.body);
  }
  console.log('───────────────────────────────────────');
  await b.close();
  process.exit(0);
})().catch(e => { console.error('[oprobe2] error:', e); process.exit(1); });
