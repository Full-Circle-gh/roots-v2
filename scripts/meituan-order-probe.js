// Standalone Meituan ORDER-PAGE probe — finds the real order-list JSON API.
//
// getPendingOrders() scrapes DOM cards by guessing CSS class names and returns
// 0 orders on the live markup. The robust fix is to read orders from Meituan's
// own cookie-authed JSON API (same pattern as the stock-push fix). This probe
// restores the saved session (read-only), opens the order page, and captures
// EVERY XHR/fetch response so we can see which endpoint carries the order list
// and what its shape is.
//
// Usage on the HK box (stop the daemon first so only one session is live):
//   pm2 stop meituan-sync
//   node scripts/meituan-order-probe.js tianhe
//   pm2 start meituan-sync
//
// Honours MEITUAN_PROXY_URL + the Tier 1/2 fingerprint via lib/meituan-browser,
// so what it sees is what the daemon would see.

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

(async () => {
  const store = process.argv[2] || 'tianhe';
  if (!['tianhe', 'yuexiu'].includes(store)) {
    console.error('usage: node scripts/meituan-order-probe.js <tianhe|yuexiu>');
    process.exit(1);
  }
  console.log(`[oprobe:${store}] proxy = ${process.env.MEITUAN_PROXY_URL || '(none — DIRECT)'}`);

  const b = new MeituanBrowser(store);
  await b.init();

  // Capture EVERY response — record url + a compact summary of the JSON body so
  // we can spot which endpoint carries the order list. Runs alongside the lib's
  // own narrow capture; this one is wide on purpose.
  const cap = [];
  const full = [];   // full detail for /order/ endpoints
  b.page.on('response', async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()['content-type'] || '');
      if (!/json/.test(ct)) return;
      const data = await resp.json();
      const s = JSON.stringify(data);
      cap.push({ url: u.split('?')[0], bytes: s.length });
      if (cap.length > 250) cap.shift();
      // Full detail for anything order-related OR any body that carries actual
      // order-detail fields (so we catch the list endpoint that returns items).
      const hasDetail = /(wmOrderViewId|wmOrderIdView|recipientName|recipient_name|orderIdView|wmOrderId|foodList|orderDetail|dinnersNumber|latestSendTime)/.test(s);
      if (/\/order\//.test(u) || /\/order$/.test(u) || hasDetail) {
        const req = resp.request();
        full.push({
          url: u,
          method: req.method(),
          postData: req.postData() || null,
          body: s.length > 6000 ? s.slice(0, 6000) + '…[truncated]' : s,
        });
      }
    } catch (e) {}
  });

  if (!await b.ensureLoggedIn()) {
    console.log(`[oprobe:${store}] NOT logged in. Re-run meituan-login.js ${store}.`);
    await b.close(); process.exit(1);
  }

  // Navigate to the order page exactly like getPendingOrders does, then sit a
  // while so list XHRs (and any tab-switch fetches) land.
  await b.page.goto(`${MERCHANT_URL}/#/order`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await b.page.waitForTimeout(7000);

  // Try clicking common order-status tabs to trigger the list fetch if the
  // default view didn't load it. Best-effort; ignore failures.
  const iframe = await b._getMainIframe();
  if (iframe) {
    // Report the visible top-level tab labels so we know what to click.
    try {
      const tabs = await iframe.evaluate(() => Array.from(
        document.querySelectorAll('[class*="tab"],[role="tab"],li,a,span'))
        .map(e => (e.innerText || '').trim())
        .filter(t => t && t.length <= 8 && /订单|配送|进行|完成|全部|待|处理|取消|售后/.test(t))
        .slice(0, 30));
      console.log('[oprobe] candidate tab labels:', JSON.stringify([...new Set(tabs)]));
    } catch (e) {}
    for (const label of ['配送中', '进行中', '全部订单', '全部', '待处理', '已完成']) {
      try {
        const el = await iframe.$(`text=${label}`);
        if (el) {
          await el.click({ timeout: 3000 });
          console.log(`[oprobe] clicked tab "${label}"`);
          await iframe.waitForTimeout(3500);
        }
      } catch (e) {}
    }
  }

  console.log('───── ORDER ENDPOINTS — full detail ─────');
  for (const f of full) {
    console.log(`\n### ${f.method} ${f.url}`);
    if (f.postData) console.log(`POST BODY: ${f.postData}`);
    console.log(`RESPONSE: ${f.body}`);
  }
  console.log('\n──────────────────────────────────');
  console.log(`iframe present: ${!!iframe}; order endpoints captured: ${full.length}; total JSON: ${cap.length}`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[oprobe] error:', e); process.exit(1); });
