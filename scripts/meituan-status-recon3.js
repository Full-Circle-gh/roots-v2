// READ-ONLY recon pass 3 (外卖 / tianhe): find the business-status WRITE endpoint
// by grepping the merchant's JS bundles FROM NODE (no CORS limit, unlike the
// in-page fetch which Meituan's cross-origin CDN blocked). We enumerate every
// script URL the logged-in page loaded, download each from Node, and print the
// code around 'businessStatus' / 营业 / 休息 / 置休 plus nearby endpoint paths so
// the setter (e.g. a /w/ or set*/update* sibling) becomes visible. No writes.

'use strict';
const path = require('path');
const fs = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
require('../database');

const KW = ['businessStatus', 'setBusinessStatus', 'updateBusinessStatus', 'poiStatus', 'setPoiStatus',
  '营业状态', '置休', '休息', '打烊', '自助营业', '停业', '手动营业', '营业中'];
const PATH_RE = /['"`](\/[A-Za-z0-9_\-\/.]{3,}?)['"`]/g;

async function gatherScriptUrls(page) {
  const urls = new Set();
  for (const f of page.frames()) {
    try {
      const list = await f.evaluate(() => {
        const s = new Set();
        for (const el of document.querySelectorAll('script[src]')) s.add(el.src);
        for (const r of performance.getEntriesByType('resource')) if (/\.js(\?|$)/.test(r.name)) s.add(r.name);
        return [...s];
      });
      for (const u of list) urls.add(u);
    } catch (e) {}
  }
  return [...urls];
}

async function grepUrl(url) {
  let text = '';
  try {
    const r = await fetch(url, { headers: { 'Referer': 'https://e.waimai.meituan.com/' } });
    if (!r.ok) return null;
    text = await r.text();
  } catch (e) { return null; }
  const hits = [];
  for (const kw of KW) {
    let idx = text.indexOf(kw), guard = 0;
    while (idx >= 0 && guard++ < 4) {
      const region = text.slice(Math.max(0, idx - 400), idx + 400);
      const near = [];
      let m; PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(region))) near.push(m[1]);
      hits.push({ kw, snippet: text.slice(Math.max(0, idx - 140), idx + 140).replace(/\s+/g, ' '), near: [...new Set(near)] });
      idx = text.indexOf(kw, idx + 1);
    }
  }
  return { size: text.length, hits };
}

(async () => {
  const { MeituanBrowser } = require('../lib/meituan-browser');
  const b = new MeituanBrowser('tianhe');
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('NOT logged in'); await b.close(); process.exit(1); }
  await b.page.goto('https://e.waimai.meituan.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await b.page.waitForTimeout(11000);

  const urls = await gatherScriptUrls(b.page);
  console.log(`gathered ${urls.length} script URLs`);
  await b.close(); // don't need the browser anymore; grep from Node

  let totalHits = 0;
  for (const u of urls) {
    const res = await grepUrl(u);
    if (!res || !res.hits.length) continue;
    const file = u.split('?')[0].split('/').slice(-1)[0];
    console.log(`\n##### ${file}  (${res.size} bytes, host ${new URL(u).host}) #####`);
    for (const h of res.hits) {
      totalHits++;
      console.log(`[${h.kw}] near=${JSON.stringify(h.near)}`);
      console.log('   …' + h.snippet + '…');
    }
  }
  console.log(`\n=== total keyword hits: ${totalHits} across ${urls.length} scripts ===`);
  process.exit(0);
})().catch(e => { console.error('[recon3] error:', e && e.stack || e); process.exit(1); });
