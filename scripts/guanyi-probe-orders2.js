#!/usr/bin/env node
/**
 * RECON v2 (read-only): confirm the gzgrocery sub-account can read ORDER lists
 * + line items. v1 captured the real trade base path = /tc/trade/trade_order_header/
 * and fulfillment counts (未配货/未发货), so orders ARE visible — this nails the
 * exact list/detail endpoint and payload so we can build the order→stock poller.
 *
 * Does NOT log in fresh, does NOT create/modify anything. Run ON THE SERVER:
 *   node scripts/guanyi-probe-orders2.js
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
const STORE = process.env.GUANYI_STORE_CODE || 'tianhe';
const ORDER_RE = /订单|销售|交易|出库|发货|配货|拣货|售后|order|trade|sale/i;

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

(async () => {
  const b = new GuanyiBrowser(STORE);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('❌ session expired — run scripts/guanyi-login.js'); await b.close(); process.exit(1); }
  const page = b.page;
  console.log(`\n✅ Logged in (store=${STORE}).`);

  // Helper: cookie-auth fetch from the logged-in page. kind: 'form' | 'json'.
  const call = (url, body, kind = 'form') => page.evaluate(async ({ url, body, kind }) => {
    const headers = { 'Content-Type': kind === 'json' ? 'application/json; charset=UTF-8' : 'application/x-www-form-urlencoded; charset=UTF-8' };
    const payload = kind === 'json' ? JSON.stringify(body) : new URLSearchParams(body).toString();
    const r = await fetch(url, { method: 'POST', headers, body: payload, credentials: 'include' });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, raw: t.slice(0, 600) };
  }, { url, body, kind }).catch(e => ({ status: -1, error: e.message }));

  const get = (url) => page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, raw: t.slice(0, 400) };
  }, url).catch(e => ({ status: -1, error: e.message }));

  // ── 1. Full accessible menu tree ──────────────────────────────────────────
  console.log('\n── MENU TREE (/admin/function_menu/data/allNewMenuList) ──');
  const menu = await get('/admin/function_menu/data/allNewMenuList');
  const flat = [];
  (function walk(nodes, depth) {
    for (const n of (nodes || [])) {
      flat.push({ depth, name: n.name, url: n.url, code: n.code });
      if (n.list) walk(n.list, depth + 1);
    }
  })(menu.json, 0);
  for (const n of flat) {
    const tag = ORDER_RE.test(`${n.name} ${n.url || ''}`) ? '  ◄── ORDER/SALES' : '';
    console.log(`  ${'  '.repeat(n.depth)}${n.name || '?'}${n.url ? '  [' + n.url + ']' : ''}${tag}`);
  }
  const orderMenus = flat.filter(n => ORDER_RE.test(`${n.name} ${n.url || ''}`) && n.url);

  // ── 2. Permissions containing trade/order/sale/view ───────────────────────
  console.log('\n── PERMISSIONS matching trade/order/sale/view ──');
  const perms = await get('/info/user/user/permissions');
  const list = (perms.json && perms.json.data) || [];
  const pmatch = list.filter(p => /tc\/trade|trade_order|order|sale|trade|deliver|配货|发货|view:\/tc/i.test(String(p)));
  console.log('  ' + (pmatch.length ? pmatch.join('\n  ') : '(none — order module may be view-only via menu, or not granted)'));
  console.log(`  (total permissions on account: ${list.length})`);

  // ── 3. Probe the real trade-order LIST endpoint ───────────────────────────
  const now = new Date(); const from = new Date(now.getTime() - 30 * 86400000);
  const bodies = [
    { label: 'minimal',     body: { page: '1', limit: '20', start: '0' } },
    { label: 'date+page',   body: { page: '1', limit: '20', start: '0', dateType: '1', beginDate: ymd(from), endDate: ymd(now), startDate: ymd(from) } },
    { label: 'rows+date',   body: { page: '1', rows: '20', start: '0', dateType: '1', beginTime: ymd(from) + ' 00:00:00', endTime: ymd(now) + ' 23:59:59' } },
  ];
  const listUrls = [
    '/tc/trade/trade_order_header/data/list',
    '/tc/trade/trade_order_header/list',
    '/tc/trade/trade_order_header/dataList',
  ];
  console.log('\n── PROBE trade-order LIST under /tc/trade/ ──');
  let hit = null;
  for (const url of listUrls) {
    for (const { label, body } of bodies) {
      const r = await call(url, body, 'form');
      const rows = r.json && (r.json.rows || r.json.data);
      const n = Array.isArray(rows) ? rows.length : null;
      const total = r.json && (r.json.total != null ? r.json.total : (r.json.footer && r.json.footer.total));
      console.log(`  ${String(r.status).padStart(4)} ${url} [${label}]  rows=${n} total=${total ?? '?'}  ${r.json && (r.json.msg || r.json.errMessage) ? '· ' + (r.json.msg || r.json.errMessage) : ''}`);
      if (r.status === 200 && Array.isArray(rows) && !hit) { hit = { url, body, rows, sample: rows[0] }; }
    }
  }

  // ── 4. If we got an order, show its shape + try to pull line items ─────────
  if (hit) {
    console.log(`\n✅ ORDER LIST WORKS: ${hit.url}`);
    console.log('   payload:', JSON.stringify(hit.body));
    const o = hit.sample || {};
    console.log('   first order top-level keys:', Object.keys(o).join(', '));
    // Likely id / order-no / shop / status fields
    for (const k of ['id', 'tradeId', 'platformCode', 'tradeNo', 'orderNo', 'shopName', 'shopCode', 'status', 'tradeStatus', 'deliveryStatus', 'createDate', 'payTime', 'receiverName', 'totalQty', 'itemQty']) {
      if (o[k] !== undefined) console.log(`     ${k} = ${JSON.stringify(o[k]).slice(0, 80)}`);
    }
    const orderId = o.id || o.tradeId || o.tradeNo;
    if (orderId) {
      console.log(`\n── PROBE order DETAIL (line items) for order ${orderId} ──`);
      const detailUrls = [
        ['/tc/trade/trade_order_detail/data/list', { pid: String(orderId), page: '1', rows: '50', start: '0' }],
        ['/tc/trade/trade_order_detail/getDetailForSearch', { pid: String(orderId), page: '1', rows: '50', start: '0' }],
        ['/tc/trade/trade_order_header/getDetail', { id: String(orderId) }],
      ];
      for (const [url, body] of detailUrls) {
        const r = await call(url, body, 'form');
        const rows = r.json && (r.json.rows || r.json.data);
        const n = Array.isArray(rows) ? rows.length : (rows ? 1 : null);
        console.log(`  ${String(r.status).padStart(4)} ${url}  items=${n}`);
        if (Array.isArray(rows) && rows.length) {
          console.log('     detail keys:', Object.keys(rows[0]).join(', '));
          for (const it of rows.slice(0, 5)) {
            console.log(`       · ${it.itemName || it.itemSkuName || '?'}  code=${it.itemCode || it.skuCode || it.code || '?'}  skuId=${it.skuId || '?'}  qty=${it.qty != null ? it.qty : it.num}`);
          }
          break;
        }
      }
    }
  } else {
    console.log('\n🟡 No /tc/trade/ list shape worked with the tried params.');
    console.log('   The endpoint exists (getTaobaoSign/getKuaiDi100 are 200) but needs different params.');
    console.log('   Next: open the order screen in the UI (Chrome MCP, you logged in) so we capture the exact list payload.');
  }

  console.log('');
  await b.close();
})().catch(e => { console.error('probe2 fatal:', e); process.exit(1); });
