// Verify spuId/skuId resolution for one product (combo or single) WITHOUT
// changing any stock. Exercises the live updateStock resolution path
// (_resolveProductIds -> getSpuListCommon), so it proves the combo fix.
//
//   pm2 stop meituan-sync
//   node scripts/meituan-test-resolve.js tianhe "藜麦沙拉套餐"
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
  const name  = process.argv[3];
  if (!name) { console.log('usage: node scripts/meituan-test-resolve.js <store> "<name_cn or name_en>"'); process.exit(1); }

  const b = new MeituanBrowser(store);
  await b.init();
  if (!await b.ensureLoggedIn()) { console.log('not logged in'); await b.close(); process.exit(1); }

  const ids = await b._resolveProductIds(name, name);
  console.log('[resolve]', name, '->', JSON.stringify(ids));
  console.log(ids ? '[resolve] OK ✓ (combo/product resolves)' : '[resolve] FAILED ✗');

  await b.close();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
