// Integration test for the ported lib/meituan-browser.js updateStock (direct API).
// Calls the REAL library method, verifies the value persisted, then restores it.
//
// Usage on the HK box:
//   pm2 stop meituan-sync
//   node scripts/meituan-test-libstock.js tianhe "红扁豆汤" 66
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

// Read the product's current stock by reusing the browser's own resolver +
// editView capture (so this verifies through the same code path).
async function readStock(b, cn) {
  const ids = await b._resolveProductIds(cn, '');
  if (!ids) return { ids: null, stock: null };
  b._apiCap = [];
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/listView`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(2500);
  b._apiCap = [];
  await b.page.goto(`${MERCHANT_URL}/#/gw/static_resource/product#/editView?spuId=${ids.spuId}`, { waitUntil:'domcontentloaded', timeout:20000 });
  await b.page.waitForTimeout(4000);
  const sku = b._skuFromCapture(cn, '');
  return { ids, stock: sku ? sku.stock : null };
}

(async () => {
  const store   = process.argv[2] || 'tianhe';
  const name    = process.argv[3] || '红扁豆汤';
  const testVal = process.argv[4] || '66';

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const before = await readStock(b, name);
  console.log('[lib-test] ids:', JSON.stringify(before.ids), ' ORIGINAL stock:', before.stock);
  if (!before.ids) { console.log('[lib-test] could not resolve product'); await b.close(); process.exit(1); }

  const wv = (String(before.stock) === String(testVal)) ? String(Number(testVal)-1) : String(testVal);
  console.log(`[lib-test] calling updateStock("${name}", "", ${wv}) …`);
  const ok = await b.updateStock(name, '', Number(wv));
  console.log('[lib-test] updateStock returned:', ok);

  const after = await readStock(b, name);
  console.log(`[lib-test] AFTER stock = ${after.stock} (expected ${wv}) -> ${String(after.stock)===String(wv) ? 'PERSISTED ✓' : 'NOT ✗'}`);

  console.log(`[lib-test] restoring to ${before.stock} …`);
  await b.updateStock(name, '', Number(before.stock));

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
