// READ-ONLY: scrape the FULL Meituan catalog via the getSpuListCommon API,
// paging every category from tagList. Writes each listing's title, spuId, and
// per-spec 货号/skuId/stock to data/meituan-catalog-<store>.json.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-scrape-catalog.js tianhe
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
  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  let tagListData = null, baseUrl = null;
  b.page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (/tag\/r\/tagList/.test(u) && !tagListData) tagListData = await resp.json().catch(()=>null);
      if (/getSpuListCommon/.test(u) && !baseUrl) baseUrl = u;
    } catch (e) {}
  });

  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await b.page.waitForTimeout(6000);
  if (!baseUrl) { console.log('no getSpuListCommon url captured'); await b.close(); process.exit(1); }
  const poi = b._wmPoiId || '29368525';

  function findTags(o, d) {
    if (!o || d > 6) return null;
    if (Array.isArray(o)) {
      if (o.length && o[0] && (o[0].tagName || o[0].name) && (o[0].tagId || o[0].id)) return o;
      for (const x of o) { const r = findTags(x, d+1); if (r) return r; }
      return null;
    }
    if (typeof o === 'object') for (const k of Object.keys(o)) { const r = findTags(o[k], d+1); if (r) return r; }
    return null;
  }
  const tags = (findTags(tagListData, 0) || []).map(t => ({ id: String(t.tagId||t.id), name: t.tagName||t.name }));
  if (!tags.length) { console.log('no tags'); await b.close(); process.exit(1); }
  console.log(`[scrape] ${tags.length} categories; poi ${poi}`);

  const frame = b.page.frames().find(f => { try { return f.url().includes('e.waimai.meituan.com'); } catch { return false; } }) || b.page.mainFrame();
  const spuById = new Map();

  async function fetchPage(tagId, pageNum) {
    return frame.evaluate(async ({ url, body }) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, credentials: 'include' });
      let j = null; try { j = await r.json(); } catch (e) {}
      return j;
    }, { url: baseUrl, body: `tagId=${tagId}&pageNum=${pageNum}&pageSize=30&needAllCount=1&tabStatus=-1&inRecycleBin=0&wmPoiId=${poi}&appType=3` });
  }

  for (const tag of tags) {
    let page = 1, got = 0;
    for (; page <= 20; page++) {
      const j = await fetchPage(tag.id, page);
      const vos = (j && j.data && j.data.spuListVos) || [];
      for (const v of vos) {
        if (!v || v.id == null) continue;
        const skuVos = Array.isArray(v.wmProductSkuVos) ? v.wmProductSkuVos : [];
        spuById.set(String(v.id), {
          name: v.name || '', spuId: String(v.id), tag: tag.name,
          skus: skuVos.filter(s => s && s.id != null).map(s => ({ spec: s.spec || '', code: b._skuCodeFromSpec(s.spec), skuId: String(s.id), stock: s.stock })),
        });
      }
      got += vos.length;
      if (vos.length < 30) break;
      await b.page.waitForTimeout(250);
    }
    console.log(`· ${tag.name} → ${got} spus (running total ${spuById.size})`);
  }

  const listings = Array.from(spuById.values());
  const withCode = listings.filter(l => l.skus.some(s => s.code));
  const outFile = path.join(__dirname, `../data/meituan-catalog-${store}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ store, scrapedAt: new Date().toISOString(), listings }, null, 1));
  console.log(`\n[scrape] DONE: ${listings.length} listings, ${withCode.length} with a 货号. Wrote ${outFile}`);

  const codeMap = new Map();
  for (const l of listings) for (const s of l.skus) if (s.code) { if (!codeMap.has(s.code)) codeMap.set(s.code, []); codeMap.get(s.code).push({ spu: l.spuId, title: l.name }); }
  const dupes = [...codeMap.entries()].filter(([, v]) => v.length > 1);
  console.log(`[scrape] distinct 货号: ${codeMap.size}; collisions: ${dupes.length}`);
  if (dupes.length) for (const [c, v] of dupes.slice(0, 20)) console.log(`  ⚠ ${c} in: ${v.map(x=>x.title).join(' | ')}`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
