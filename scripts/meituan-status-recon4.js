// READ-ONLY recon pass 4 (外卖): dump WIDE context around the write endpoint
// /api/poi/change_status and the BusinessStatus enum, so we get the exact POST
// param shape + status codes. Pure JS grep from Node — no writes.

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

// keyword -> [before, after] window sizes
const TARGETS = [
  { kw: 'change_status', before: 120, after: 900, max: 3 },
  { kw: 'changeBusinessStatus:function', before: 40, after: 1100, max: 2 },
  { kw: 'BusinessStatus=', before: 20, after: 400, max: 3 },
  { kw: 'BusinessStatus={', before: 20, after: 400, max: 3 },
  { kw: 'REST:', before: 40, after: 200, max: 3 },
];

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
  const urls = await gatherScriptUrls(b.page);
  await b.close();

  for (const u of urls) {
    let text = '';
    try { const r = await fetch(u, { headers: { Referer: 'https://e.waimai.meituan.com/' } }); if (!r.ok) continue; text = await r.text(); }
    catch (e) { continue; }
    const file = u.split('?')[0].split('/').slice(-1)[0];
    for (const t of TARGETS) {
      let idx = text.indexOf(t.kw), n = 0;
      while (idx >= 0 && n < t.max) {
        n++;
        console.log(`\n##### ${file} :: [${t.kw}] #####`);
        console.log(text.slice(Math.max(0, idx - t.before), idx + t.after));
        idx = text.indexOf(t.kw, idx + t.kw.length);
      }
    }
  }
  process.exit(0);
})().catch(e => { console.error('[recon4] error:', e && e.stack || e); process.exit(1); });
