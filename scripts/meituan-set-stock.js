// Manually set a product's Meituan stock to a chosen value and read it back, so
// you can watch the change. Uses the same direct-API path as the daemon.
//   node scripts/meituan-set-stock.js <store> "<name>" <value>
// e.g.
//   pm2 stop meituan-sync
//   node scripts/meituan-set-stock.js tianhe "红扁豆汤" 123
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
  const store = process.argv[2];
  const name  = process.argv[3];
  const value = process.argv[4];
  if (!store || !name || value === undefined) {
    console.log('usage: node scripts/meituan-set-stock.js <store> "<name>" <value>');
    process.exit(1);
  }

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const before = await readStock(b, name);
  console.log(`[set-stock] BEFORE: "${name}" stock = ${before.stock}`);
  if (!before.ids) { console.log('[set-stock] product not found on Meituan'); await b.close(); process.exit(1); }

  console.log(`[set-stock] setting → ${value} …`);
  const ok = await b.updateStock(name, '', Number(value));
  console.log('[set-stock] updateStock returned:', ok);

  const after = await readStock(b, name);
  console.log(`[set-stock] AFTER: "${name}" stock = ${after.stock}`);
  console.log(String(after.stock) === String(value)
    ? `[set-stock] ✓ CHANGED ${before.stock} → ${after.stock}`
    : `[set-stock] ✗ value did not stick (got ${after.stock})`);

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
