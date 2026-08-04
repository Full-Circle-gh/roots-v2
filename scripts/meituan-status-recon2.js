// READ-ONLY recon pass 2 (外卖 / tianhe): pin down the business-status shape and
// find the WRITE endpoint. Pass 1 found the reads (/api/poi/poiStatus,
// /common/businessStatus). Here we:
//   1. call those reads in-page and print the current-status JSON (no change),
//   2. capture the request BODY of any status-shaped POST fired on load,
//   3. deep-scan ALL loaded JS (page + iframe) for 'businessStatus' / 'poiStatus'
//      / 营业 / 休息 / 置休 and dump the code snippet around each hit so the SET
//      endpoint (a /w/ or set*/update* sibling) is visible.
// Never writes, never clicks the toggle.

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

const KW = ['businessStatus', 'poiStatus', '营业状态', '置休', '休息', '打烊', '自助营业', '停业'];

async function deepScan(frame, label) {
  const out = await frame.evaluate(async (KW) => {
    const urls = new Set();
    for (const s of document.querySelectorAll('script[src]')) urls.add(s.src);
    for (const r of performance.getEntriesByType('resource')) if (/\.js(\?|$)/.test(r.name)) urls.add(r.name);
    const PATHS = /['"`](\/[A-Za-z0-9_\-\/.]{3,}?)['"`]/g;
    const hits = [];
    let scanned = 0;
    for (const url of [...urls]) {
      let text = '';
      try { text = await (await fetch(url, { credentials: 'include' })).text(); } catch (e) { continue; }
      scanned++;
      for (const kw of KW) {
        let idx = text.indexOf(kw);
        let guard = 0;
        while (idx >= 0 && guard++ < 6) {
          const snippet = text.slice(Math.max(0, idx - 160), idx + 160).replace(/\s+/g, ' ');
          // nearby path literals
          const near = [];
          const region = text.slice(Math.max(0, idx - 400), idx + 400);
          let m; PATHS.lastIndex = 0;
          while ((m = PATHS.exec(region))) near.push(m[1]);
          hits.push({ kw, url: url.split('/').slice(-1)[0], snippet, near: [...new Set(near)] });
          idx = text.indexOf(kw, idx + 1);
        }
      }
    }
    return { scanned, total: urls.size, hits };
  }, KW);
  console.log(`\n===== deepScan ${label}: ${out.scanned}/${out.total} scripts, ${out.hits.length} keyword hits =====`);
  for (const h of out.hits.slice(0, 40)) {
    console.log(`\n[${h.kw}] in ${h.url}`);
    console.log('  near paths:', JSON.stringify(h.near));
    console.log('  …' + h.snippet + '…');
  }
}

(async () => {
  const { MeituanBrowser } = require('../lib/meituan-browser');
  const b = new MeituanBrowser('tianhe');
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('NOT logged in'); await b.close(); process.exit(1); }

  // Capture request bodies of status-shaped POSTs fired on load.
  const bodies = [];
  b.page.on('request', (req) => {
    try {
      const u = req.url();
      if (/businessStatus|poiStatus|poi\/status|operation\/w\/status/i.test(u)) {
        bodies.push({ method: req.method(), url: u.split('?')[0], post: (req.postData() || '').slice(0, 300) });
      }
    } catch (e) {}
  });

  await b.page.goto('https://e.waimai.meituan.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await b.page.waitForTimeout(11000);

  console.log('===== status POST bodies captured on load =====');
  console.log(JSON.stringify(bodies, null, 2));

  // Read the two status endpoints in-page (same-origin fetch, no change).
  const frame = (await b._getMainIframe().catch(() => null)) || b.page.mainFrame();
  const reads = await frame.evaluate(async () => {
    const res = {};
    try { res.poiStatusGET = await (await fetch('/api/poi/poiStatus', { credentials: 'include' })).text(); } catch (e) { res.poiStatusGET = 'ERR ' + e; }
    try { res.businessStatusPOST = await (await fetch('/common/businessStatus', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', credentials: 'include' })).text(); } catch (e) { res.businessStatusPOST = 'ERR ' + e; }
    return res;
  });
  console.log('\n===== READ /api/poi/poiStatus (GET) =====');
  console.log(String(reads.poiStatusGET).slice(0, 800));
  console.log('\n===== READ /common/businessStatus (POST empty) =====');
  console.log(String(reads.businessStatusPOST).slice(0, 800));

  await deepScan(b.page.mainFrame(), 'page');
  if (frame !== b.page.mainFrame()) await deepScan(frame, 'iframe');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('[recon2] error:', e && e.stack || e); process.exit(1); });
