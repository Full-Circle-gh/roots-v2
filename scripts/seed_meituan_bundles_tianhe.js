#!/usr/bin/env node
/**
 * seed_meituan_bundles_tianhe.js — create empty Meituan-only bundle shells.
 *
 * Creates one `meituan_bundles` row per combo (套餐) title for the tianhe
 * store, with NO components yet (the operator adds the component products
 * afterwards in the admin → Meituan → "Meituan-only bundles" editor).
 *
 * The bundle title MUST match the listing title on Meituan exactly for the
 * push daemon to find and update it. Titles below are transcribed from the
 * Meituan merchant 商品管理 screen — verify/adjust in the editor if a push
 * doesn't land (or use "⟳ Fetch from Meituan" to pull the exact titles).
 *
 * Idempotent: a title that already exists for the store is left untouched.
 * Run ON THE SERVER where the prod DB lives:
 *
 *   node scripts/seed_meituan_bundles_tianhe.js          # dry-run (prints plan)
 *   node scripts/seed_meituan_bundles_tianhe.js --apply  # actually insert
 */
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const STORE_CODE = 'tianhe';

const TITLES = [
  'Beet Salad & Mushroom Soup',
  '纯素咸芝士+玉米片Nachos + Creamy Dip',
  '美式豆泥蔬沙拉套餐Chickpeas Salad Combo',
  '中东香料酸奶油+薄脆Labneh + Crackers',
  '甜菜根沙拉套餐Beet Salad Combo',
  '三明治套餐 Sandwich Combo',
  '冷拌荞麦面套餐Buckwheat Noodles Combo',
  '法拉费卷+Vanilla yogur纯素椰子酸奶',
  '鹰嘴豆泥Hummus & 3 Slices of Bread',
  '中东鹰嘴豆泥套餐 Hummus Combo',
  'Labneh + Pita Bread',
  'Green Chili Dip + Pita Bread',
  'Turkish Salad + Pita Bread',
  'Hummus + Pita Bread',
  '法拉费卷套餐Falafel + Carrot Juice',
  '藜麦沙拉套餐 Quinoa Salad Combo',
  '纯素罗勒鸡肉卷套餐Pesto Wrap Combo',
  '越式豆腐卷 Tofu Banh Mi Wrap+柴茶拿铁',
  '罗勒鸡肉卷 Pesto Wrap+Kombucha',
  '红咖喱奶茶套餐 Red Curry & Milk Combo',
  'Tofu Wrap + Musroom Soup',
  '冷面沙拉套餐 Buckwheat Noodles Combo',
];

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const store = db.prepare('SELECT id, code FROM retail_stores WHERE code = ?').get(STORE_CODE);
if (!store) {
  console.error(`No store with code "${STORE_CODE}". Known:`,
    db.prepare('SELECT code FROM retail_stores').all().map(r => r.code).join(', '));
  process.exit(1);
}

const exists = db.prepare('SELECT 1 FROM meituan_bundles WHERE retail_store_id = ? AND meituan_name = ?');
const insert = db.prepare(`
  INSERT INTO meituan_bundles (retail_store_id, store_code, meituan_name, max_qty, sync_enabled)
  VALUES (?, ?, ?, NULL, 1)
`);

let created = 0, skipped = 0;
const run = db.transaction(() => {
  for (const name of TITLES) {
    const title = name.trim();
    if (exists.get(store.id, title)) { console.log(`  skip (exists)  ${title}`); skipped++; continue; }
    if (APPLY) insert.run(store.id, store.code, title);
    console.log(`  ${APPLY ? 'created' : 'would create'}  ${title}`);
    created++;
  }
});
run();

console.log(`\n${APPLY ? 'Created' : 'Would create'} ${created} bundle(s), skipped ${skipped} existing, for store "${STORE_CODE}".`);
if (!APPLY) console.log('Dry-run only. Re-run with --apply to write.');
