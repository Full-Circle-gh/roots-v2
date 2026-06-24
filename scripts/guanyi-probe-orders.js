#!/usr/bin/env node
/**
 * RECON (read-only): can the gzgrocery Guanyi sub-account see ORDER contents?
 *
 * The current sync is stock-OUT only. To also decrement our stock when gzgrocery
 * sells one of OUR products, we need to READ their orders (which SKUs, how many).
 * That requires an order-read permission this limited sub-account may not have.
 * This finds out empirically, using the existing logged-in session — it does NOT
 * log in fresh (no password) and does NOT create/modify anything.
 *
 * What it does:
 *   1. Restore the session, confirm logged in.
 *   2. Re-load the app while capturing every JSON response the SPA fires (the
 *      menu / permission tree loads this way) → reveals accessible modules and,
 *      crucially, whether any 订单/销售/交易 (order/sales/trade) API is reachable.
 *   3. Scan the left menu DOM for order/sales entries.
 *   4. Best-effort probe a few well-known 管易 sales-order LIST endpoints (POST
 *      data/list, harmless reads) and report status + row count.
 *
 * Run ON THE SERVER (needs the session + GZ proxy):
 *   node scripts/guanyi-probe-orders.js
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); } catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const { GuanyiBrowser } = require('../lib/guanyi-browser');
const STORE    = process.env.GUANYI_STORE_CODE || 'tianhe';
const HOME_URL = 'https://v2.guanyierp.com/index';
const ORDER_RE = /订单|销售|交易|出库|发货|配货|拣货|order|trade|sale|deliver|ship/i;

// Candidate sales-order LIST endpoints to probe (read-only data/list calls).
// 管易 list APIs are form-encoded and tolerate a minimal paging body.
const CANDIDATES = [
  '/trade/trade/trade_order_header/data/list',
  '/trade/trade/trade_order/data/list',
  '/oms/trade/trade_order_header/data/list',
  '/sale/sale/sale_order_header/data/list',
  '/stock/stock/stock_other_order_header/data/list',
  '/trade/order/data/list',
  '/oms/order/data/list',
];

(async () => {
  const b = new GuanyiBrowser(STORE);
  await b.init();
  const ok = await b.ensureLoggedIn();
  if (!ok) { console.log('\n❌ Not logged in — session expired. Run scripts/guanyi-login.js first.'); await b.close(); process.exit(1); }
  const page = b.page;
  console.log(`\n✅ Logged in as the gzgrocery sub-account (store=${STORE}).`);

  // ── Capture every JSON API the app fires on (re)load ──────────────────────
  const seen = new Map(); // url -> { status, len, orderish, sample }
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      if (seen.has(url)) return;
      let body = '';
      try { body = await resp.text(); } catch {}
      seen.set(url, {
        status: resp.status(),
        len: body.length,
        orderish: ORDER_RE.test(url) || ORDER_RE.test(body.slice(0, 4000)),
        sample: body.slice(0, 240).replace(/\s+/g, ' '),
      });
    } catch {}
  });

  console.log('\n── Re-loading app to capture menu / permission APIs … ──');
  await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.log('  (nav: ' + e.message.slice(0, 60) + ')'));
  await page.waitForTimeout(6000);

  // ── Scan the menu DOM for order/sales entries ─────────────────────────────
  const menuHits = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const out = new Set();
    document.querySelectorAll('a, li, span, div').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t && t.length <= 24 && re.test(t)) out.add(t);
    });
    return [...out];
  }, ORDER_RE.source).catch(() => []);

  // Full top-level menu text (so we see the whole accessible surface).
  const topMenu = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('a, li, span').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t && t.length <= 16 && /[一-龥]/.test(t)) out.add(t);
    });
    return [...out].slice(0, 120);
  }).catch(() => []);

  // ── Probe candidate sales-order list endpoints (read-only) ────────────────
  console.log('\n── Probing candidate order-list endpoints (read-only) … ──');
  const probes = [];
  for (const url of CANDIDATES) {
    const r = await page.evaluate(async (u) => {
      try {
        const body = new URLSearchParams({ page: '1', limit: '5', rows: '5', start: '0' }).toString();
        const resp = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body, credentials: 'include' });
        const t = await resp.text();
        let j = null; try { j = JSON.parse(t); } catch {}
        const rows = j && (j.rows || j.data);
        return { status: resp.status, ok: resp.ok, count: Array.isArray(rows) ? rows.length : null, msg: (j && (j.msg || j.message)) || t.slice(0, 120) };
      } catch (e) { return { status: 0, error: String(e.message).slice(0, 80) }; }
    }, url).catch(e => ({ status: -1, error: e.message }));
    probes.push({ url, ...r });
    console.log(`  ${String(r.status).padStart(4)}  ${url}  ${r.count != null ? `rows=${r.count}` : ''} ${r.msg ? '· ' + r.msg : (r.error || '')}`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('MENU entries matching order/sales/trade:');
  console.log(menuHits.length ? '  ' + menuHits.join('  ·  ') : '  (none found in DOM — account may not expose an order module)');

  console.log('\nTop-level menu surface (first 120 short labels):');
  console.log('  ' + (topMenu.join('  ') || '(none)'));

  const orderApis = [...seen.entries()].filter(([, v]) => v.orderish);
  console.log(`\nJSON APIs the app fired (${seen.size} total); ORDER-related (${orderApis.length}):`);
  for (const [url, v] of orderApis) console.log(`  ${v.status}  ${url.replace('https://v2.guanyierp.com', '')}  len=${v.len}\n        ${v.sample}`);
  if (!orderApis.length) {
    console.log('  (none) — listing all captured JSON endpoints for manual review:');
    for (const [url, v] of seen) console.log(`  ${v.status}  ${url.replace('https://v2.guanyierp.com', '')}  len=${v.len}`);
  }

  console.log('\nVERDICT:');
  const probeOk = probes.find(p => p.status === 200 && p.count != null);
  if (probeOk) console.log(`  ✅ Order list reachable → ${probeOk.url} (rows=${probeOk.count}). Capture its payload + fields next.`);
  else if (orderApis.length || menuHits.length) console.log('  🟡 Order/sales surface EXISTS in the UI but no list endpoint confirmed by blind probe.\n     Next: open an order in the UI (Chrome MCP, user logged in) and capture the real list/detail API.');
  else console.log('  🔴 No order/sales module visible to this sub-account. Likely needs gzgrocery to grant an order-read permission (or provide an order webhook/API). Confirm with them.');
  console.log('');

  await b.close();
})().catch(e => { console.error('probe fatal:', e); process.exit(1); });
