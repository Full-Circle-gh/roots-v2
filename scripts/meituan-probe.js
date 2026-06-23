// Standalone Meituan product-list PROBE — for fast, iterative DOM diagnosis
// without touching the daemon's push loop. Restores the saved session
// (read-only: never overwrites it), opens the product list, searches for a
// product by name, and dumps everything needed to locate a row: the rendered
// candidate titles, whether the name is present, and the raw HTML of a row.
//
// Usage on the HK box (stop the daemon first so only one session is live):
//   pm2 stop meituan-sync
//   node scripts/meituan-probe.js tianhe "红扁豆汤Red Lentils Soup"
//   pm2 start meituan-sync
//
// It honours MEITUAN_PROXY_URL + the Tier 1/2 fingerprint via lib/meituan-browser,
// exactly like the daemon, so what it sees is what the daemon would see.

'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env the same way the daemon does (dotenv, else manual parse).
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
require('../database'); // hydrates integration env vars (proxy etc.) as a side effect

const { MeituanBrowser } = require('../lib/meituan-browser');
const MERCHANT_URL = 'https://e.waimai.meituan.com';

(async () => {
  const store = process.argv[2] || 'tianhe';
  const term  = process.argv[3] || '';
  if (!['tianhe', 'yuexiu'].includes(store)) {
    console.error('usage: node scripts/meituan-probe.js <tianhe|yuexiu> "<product name>"');
    process.exit(1);
  }
  console.log(`[probe:${store}] proxy = ${process.env.MEITUAN_PROXY_URL || '(none — DIRECT)'}`);
  console.log(`[probe:${store}] search term = ${JSON.stringify(term)}`);

  const b = new MeituanBrowser(store);
  await b.init(); // headless, restores saved session (not overwritten)

  if (!await b.ensureLoggedIn()) {
    console.log(`[probe:${store}] NOT logged in (session expired / challenged). Re-run meituan-login.js.`);
    await b.close(); process.exit(1);
  }

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);

  const iframe = await b._getMainIframe();
  if (!iframe) { console.log(`[probe:${store}] no content iframe`); await b.close(); process.exit(1); }

  // Type the term into the list search box (same as updateStock).
  if (term) {
    await iframe.evaluate((t) => {
      const s = Array.from(document.querySelectorAll('input')).find(i => i.placeholder === '搜索商品或规格名称');
      if (!s) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(s, t);
      s.dispatchEvent(new Event('input',  { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      for (const type of ['keydown', 'keyup'])
        s.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    }, term);
    await iframe.waitForTimeout(2200);
  }

  const dump = await iframe.evaluate((term) => {
    const body = document.body.innerText || '';
    const out = {
      searchBoxPresent: !!Array.from(document.querySelectorAll('input')).find(i => i.placeholder === '搜索商品或规格名称'),
      salesRows: (body.match(/月售/g) || []).length,
      nameFullInBody: !!term && body.includes(term),
      namePrefixInBody: term.length >= 4 ? body.includes(term.slice(0, 4)) : null,
      candidateNames: [],
      rowHtml: null,
      rowTextByLevel: [],
    };

    // Candidate product titles: leaf elements with short non-numeric, non-label text.
    const LABELS = ['月售','库存','无限','上架','下架','促销','编辑','删除','更多','批量','全选','改库存','打包费','已下架','售卖中','未录入','分时置顶','新建','分组','门店故事','智能排序'];
    const names = new Set();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      const t = (el.innerText || '').trim();
      if (t.length < 2 || t.length > 48) continue;
      if (/^[\d¥%./,\s-]+$/.test(t)) continue;
      if (LABELS.some(l => t.includes(l))) continue;
      names.add(t);
      if (names.size >= 20) break;
    }
    out.candidateNames = Array.from(names);

    // Anchor: leaf element holding the name (full or 4-char prefix); else the
    // first checkbox on the page.
    let anchor = null;
    const pfx = term.length >= 4 ? term.slice(0, 4) : term;
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      const t = el.innerText || '';
      if (term && (t.includes(term) || (pfx && t.includes(pfx)))) { anchor = el; break; }
    }
    if (!anchor) anchor = document.querySelector('input[type=checkbox]');

    if (anchor) {
      // Walk up to the product row (has a checkbox AND 月售), dump its HTML + text.
      let row = anchor;
      for (let i = 0; i < 16 && row.parentElement; i++) {
        row = row.parentElement;
        const txt = row.innerText || '';
        const hasCb = !!(row.querySelector && row.querySelector('input[type=checkbox]'));
        out.rowTextByLevel.push(`L${i}${hasCb ? '*' : ' '}: ` + txt.replace(/\s+/g, ' ').trim().slice(0, 90));
        if (hasCb && /月售/.test(txt)) { out.rowHtml = (row.outerHTML || '').slice(0, 3000); break; }
      }
    }
    return out;
  }, term);

  console.log('───── PROBE RESULT ─────');
  console.log(JSON.stringify({
    searchBoxPresent: dump.searchBoxPresent,
    salesRows: dump.salesRows,
    nameFullInBody: dump.nameFullInBody,
    namePrefixInBody: dump.namePrefixInBody,
  }, null, 2));
  console.log('candidateNames:', JSON.stringify(dump.candidateNames, null, 2));
  console.log('rowTextByLevel (* = has checkbox):');
  for (const l of dump.rowTextByLevel) console.log('  ' + l);
  console.log('rowHtml:\n' + (dump.rowHtml || '(none)'));
  console.log('────────────────────────');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[probe] error:', e); process.exit(1); });
