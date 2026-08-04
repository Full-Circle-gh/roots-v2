// READ-ONLY recon (闪购 / yuexiu): find the business-status (营业/休息/打烊) read +
// write endpoint on shangoue.meituan.com. FULLY PASSIVE — attaches to the live
// shangou-chrome over CDP but NEVER reloads or navigates the shared page (the
// shangou-sync daemon owns it), so nothing is disrupted. It only:
//   1. reads the currently-loaded script URLs from the page,
//   2. downloads each bundle FROM NODE (CDN, no CORS) and greps for the status
//      endpoints + Chinese 营业/休息 keywords, dumping wide context so the setter
//      path + param shape are visible.
// No page reload, no navigation, no writes.

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

const KW = ['businessStatus', 'poiStatus', 'change_status', 'changeBusinessStatus', 'setBusinessStatus',
  'operationStatus', 'setRest', 'openRest', 'autoRest', 'shopStatus', 'storeStatus',
  '营业状态', '置休', '打烊', '停业', '歇业', '恢复营业', '停止营业', '休息'];
const PATH_RE = /['"`](\/[A-Za-z0-9_\-\/.]{3,}?)['"`]/g;

(async () => {
  const { getShangouBrowser } = require('../lib/shangou-browser');
  const b = await getShangouBrowser('yuexiu');
  const page = b.page;
  console.log(`[recon:yuexiu] attached (passive); page = ${page.url()}`);

  // Gather loaded script URLs across all frames — NO navigation.
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
  console.log(`[recon:yuexiu] ${urls.size} loaded script URLs`);
  try { await b.close(); } catch {} // detach CDP only — never closes the Chrome

  let hitFiles = 0;
  for (const u of [...urls]) {
    let text = '';
    try { const r = await fetch(u, { headers: { Referer: 'https://shangoue.meituan.com/' } }); if (!r.ok) continue; text = await r.text(); }
    catch (e) { continue; }
    const file = u.split('?')[0].split('/').slice(-1)[0];
    const found = [];
    for (const kw of KW) {
      let idx = text.indexOf(kw), n = 0;
      while (idx >= 0 && n < 3) {
        n++;
        const region = text.slice(Math.max(0, idx - 400), idx + 400);
        const near = []; let m; PATH_RE.lastIndex = 0;
        while ((m = PATH_RE.exec(region))) near.push(m[1]);
        found.push({ kw, near: [...new Set(near)], ctx: text.slice(Math.max(0, idx - 180), idx + 220).replace(/\s+/g, ' ') });
        idx = text.indexOf(kw, idx + kw.length);
      }
    }
    if (found.length) {
      hitFiles++;
      console.log(`\n##### ${file} (${text.length} bytes, ${new URL(u).host}) #####`);
      for (const h of found) {
        console.log(`[${h.kw}] near=${JSON.stringify(h.near)}`);
        console.log('   …' + h.ctx + '…');
      }
    }
  }
  console.log(`\n=== ${hitFiles} bundle(s) had status keywords, of ${urls.size} scanned ===`);
  process.exit(0);
})().catch(e => { console.error('[recon:yuexiu] error:', e && e.stack || e); process.exit(1); });
