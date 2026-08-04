// READ-ONLY recon pass 5 (外卖): resolve the BusinessStatus enum numeric values
// and the page `token` source so we can build /api/poi/change_status safely.
//   - enum: TS enums compile to  e[e.OPEN=1]="OPEN"  — so we grep ="OPEN"/="REST".
//   - token: dump window globals + cookies that look like the merchant token.
// No writes.

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

(async () => {
  const { MeituanBrowser } = require('../lib/meituan-browser');
  const b = new MeituanBrowser('tianhe');
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('NOT logged in'); await b.close(); process.exit(1); }
  await b.page.goto('https://e.waimai.meituan.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await b.page.waitForTimeout(11000);

  // Token / global recon in-page.
  const frame = (await b._getMainIframe().catch(() => null)) || b.page.mainFrame();
  const g = await frame.evaluate(() => {
    const out = { winKeys: [], token: null, cookieNames: [], samples: {} };
    try {
      out.winKeys = Object.keys(window).filter(k => /token|poi|acct|context|__|guard|csec/i.test(k)).slice(0, 60);
      out.token = window.token || (window.__context && window.__context.token) || null;
      out.cookieNames = document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean);
      for (const k of ['token', 'wmPoiId', 'acctId', '__context', 'globalConfig', 'PAGE_DATA', '__INITIAL_STATE__']) {
        try { const v = window[k]; if (v != null) out.samples[k] = (typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200)); } catch (e) {}
      }
    } catch (e) { out.err = String(e); }
    return out;
  });
  console.log('===== in-page globals / token recon =====');
  console.log(JSON.stringify(g, null, 2));

  const urls = await gatherScriptUrls(b.page);
  await b.close();

  // Enum values: grep ="OPEN" / ="REST" / ="WORKING" and the change_status token getter.
  const NEEDLES = ['="OPEN"', '="REST"', '="WORKING"', '="CLOSED"', '="STOP"', 'BusinessSubStatus'];
  for (const u of urls) {
    let text = '';
    try { const r = await fetch(u, { headers: { Referer: 'https://e.waimai.meituan.com/' } }); if (!r.ok) continue; text = await r.text(); }
    catch (e) { continue; }
    const file = u.split('?')[0].split('/').slice(-1)[0];
    for (const nd of NEEDLES) {
      let idx = text.indexOf(nd), n = 0;
      while (idx >= 0 && n < 2) {
        n++;
        console.log(`\n##### ${file} :: [${nd}] #####`);
        console.log(text.slice(Math.max(0, idx - 220), idx + 80));
        idx = text.indexOf(nd, idx + nd.length);
      }
    }
  }
  process.exit(0);
})().catch(e => { console.error('[recon5] error:', e && e.stack || e); process.exit(1); });
