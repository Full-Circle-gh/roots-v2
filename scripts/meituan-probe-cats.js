// READ-ONLY probe v2: capture the tagList (categories) response and the exact
// getSpuListCommon request (params + how it's called), so the catalog scraper
// can hit the API per category directly — no fragile UI scrolling.
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
  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  let tagListData = null;
  const spuReqs = [];
  b.page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (/tag\/r\/tagList/.test(u)) { tagListData = await resp.json().catch(()=>null); }
      if (/getSpuListCommon/.test(u)) {
        const req = resp.request();
        const data = await resp.json().catch(()=>null);
        const n = data && data.data && Array.isArray(data.data.spuListVos) ? data.data.spuListVos.length : 'n/a';
        spuReqs.push({ url: u, method: req.method(), post: req.postData(), nSpus: n });
      }
    } catch (e) {}
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(6000);

  console.log('=== tagList categories ===');
  // dig out tags regardless of envelope shape
  function findTags(o, depth) {
    if (!o || depth > 6) return null;
    if (Array.isArray(o)) {
      if (o.length && o[0] && (o[0].tagName || o[0].name) && (o[0].tagId || o[0].id)) return o;
      for (const x of o) { const r = findTags(x, depth+1); if (r) return r; }
      return null;
    }
    if (typeof o === 'object') { for (const k of Object.keys(o)) { const r = findTags(o[k], depth+1); if (r) return r; } }
    return null;
  }
  const tags = findTags(tagListData, 0);
  if (tags) for (const t of tags) console.log(`tagId ${t.tagId||t.id} | "${t.tagName||t.name}" | count ${t.spuCount!=null?t.spuCount:(t.count!=null?t.count:'?')}`);
  else console.log('no tags found; raw keys:', tagListData ? JSON.stringify(Object.keys(tagListData)) : 'null');

  console.log('\n=== getSpuListCommon requests seen ===');
  for (const r of spuReqs) console.log(`${r.method} nSpus=${r.nSpus}\n  url: ${r.url}\n  post: ${r.post}`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
