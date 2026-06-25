// Diagnose what Roots sources push to a Meituan listing — to find duplicate /
// conflicting mappings (e.g. two products, or a product + a bundle, sharing one
// meituan_name so an out-of-stock source overwrites an in-stock one).
//   node scripts/meituan-diag-name.js Oatly
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
const db = require('../database');
const q = process.argv[2] || 'Oatly';
const like = `%${q}%`;
const show = (t, rows) => { console.log(`\n=== ${t} (${rows.length}) ===`); for (const r of rows) console.log(JSON.stringify(r)); };

try {
  show('meituan_product_map (product mappings)', db.prepare(`
    SELECT pm.product_id, pm.retail_store_id, pm.store_code, pm.sync_enabled,
           pm.meituan_name, p.name_cn, p.name_en,
           (SELECT physical_qty FROM retail_store_stock s WHERE s.product_id=pm.product_id AND s.store_id=pm.retail_store_id) AS phys_qty
      FROM meituan_product_map pm
      LEFT JOIN products p ON p.id = pm.product_id
     WHERE pm.meituan_name LIKE ? OR p.name_cn LIKE ? OR p.name_en LIKE ?
     ORDER BY pm.meituan_name`).all(like, like, like));
} catch (e) { console.log('map query error:', e.message); }

try {
  show('meituan_bundles', db.prepare(`
    SELECT id, retail_store_id, store_code, meituan_name, sync_enabled
      FROM meituan_bundles WHERE meituan_name LIKE ? ORDER BY meituan_name`).all(like));
} catch (e) { console.log('bundles query error:', e.message); }

try {
  show('recent meituan_sync_queue', db.prepare(`
    SELECT id, product_id, bundle_id, store_code, new_qty, status, meituan_name, created_at
      FROM meituan_sync_queue WHERE meituan_name LIKE ? ORDER BY created_at DESC LIMIT 25`).all(like));
} catch (e) { console.log('queue query error:', e.message); }

// Highlight: meituan_names targeted by MORE THAN ONE source (the actual bug).
try {
  const dupes = db.prepare(`
    SELECT meituan_name, COUNT(*) n FROM (
      SELECT meituan_name FROM meituan_product_map WHERE sync_enabled=1 AND meituan_name LIKE ?
      UNION ALL
      SELECT meituan_name FROM meituan_bundles WHERE sync_enabled=1 AND meituan_name LIKE ?
    ) GROUP BY meituan_name HAVING n > 1`).all(like, like);
  show('⚠ meituan_names with >1 enabled source (the conflict)', dupes);
} catch (e) { console.log('dupe query error:', e.message); }

process.exit(0);
