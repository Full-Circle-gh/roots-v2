// READ-ONLY: dump every search-suggest result for a term, with exact title +
// spuId + category. Used to capture the precise new single-spec listing titles
// so we can map each Roots variant without transcription errors.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-dump-suggest.js tianhe "椰子酸奶"
//   pm2 start meituan-sync
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
  const term  = process.argv[3] || '椰子酸奶';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(3500);
  const frame = await b._getProductFrame();
  if (!frame) { console.log('no content frame'); await b.close(); process.exit(1); }
  await frame.evaluate(() => { for (const el of document.querySelectorAll('.roo-modal,[class*="backdrop"]')) el.style.display = 'none'; }).catch(()=>{});

  b._apiCap = [];
  const sh = await frame.$('input[placeholder="搜索商品或规格名称"]');
  await sh.click({ timeout: 8000 }).catch(()=>{});
  await sh.fill('');
  await sh.type(term, { delay: 90 });
  await frame.waitForTimeout(2600);

  const seen = new Map();
  for (const c of b._apiCap) {
    if (!/searchSugByName/.test(c.url)) continue;
    for (const v of ((c.data && c.data.data && c.data.data.searchSugVos) || [])) {
      if (v && v.spuId != null) seen.set(String(v.spuId), { name: v.name, spuId: String(v.spuId), tag: v.tagName });
    }
  }
  console.log(`\n===== SUGGESTIONS for "${term}" =====`);
  for (const s of seen.values()) console.log(`spu ${s.spuId} | tag "${s.tag||''}" | "${s.name}"`);
  console.log(`\n${seen.size} distinct listing(s)`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
