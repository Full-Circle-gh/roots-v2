// READ-ONLY: scrape every Meituan listing with its 货号 (sku code) and print the
// rows whose code is one of the yogurt variant SKUs, so we can map each Roots
// variant to its NEW single-spec listing title exactly (no transcription).
//
//   pm2 stop meituan-sync
//   node scripts/meituan-dump-listings.js tianhe
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

(async () => {
  const store = process.argv[2] || 'tianhe';
  const want = new Set(['1-130','1-140','1-150','1-160','1-180','1-190']);

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const r = await b.listProductsWithSpecs();
  if (!r) { console.log('scrape failed'); await b.close(); process.exit(1); }

  console.log('\n===== YOGURT LISTINGS (matched by 货号) =====');
  const rows = [];
  for (const l of r.listings) {
    for (const s of l.skus) {
      if (want.has(s.code)) {
        rows.push({ code: s.code, title: l.name, spuId: l.spuId, skuId: s.skuId, spec: s.spec, stock: s.stock, specsInSpu: l.skus.length });
      }
    }
  }
  rows.sort((a,b) => a.code.localeCompare(b.code));
  for (const x of rows) {
    console.log(`${x.code}  | "${x.title}"  | spu ${x.spuId} sku ${x.skuId} | spec "${x.spec}" | stock ${x.stock} | specsInSpu ${x.specsInSpu}`);
  }
  console.log(`\nmatched ${rows.length} yogurt sku rows across ${r.listings.length} listings`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
