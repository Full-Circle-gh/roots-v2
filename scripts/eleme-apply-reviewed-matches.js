// One-time apply for a hand-reviewed batch of Eleme name matches.
//
// scripts/eleme-match-products.js's automatic pass only auto-applies matches
// where the two names' CJK cores are near-identical in length — deliberately
// conservative, since a wrong auto-match silently corrupts a live listing's
// stock. That left 109 "needs review" + 84 "no match" products unresolved.
// This batch is the human (well, LLM) judgment pass over those two buckets:
// each pair below was read for actual product-category agreement (not just
// string overlap) — e.g. rejecting "raw red lentils" for "red lentil SOUP",
// or "chickpea flour" for whole chickpeas — and cross-checked against the
// mappings scripts/eleme-match-products.js already applied so this batch
// can't silently steal a listing another product is already using.
//
// Usage: node scripts/eleme-apply-reviewed-matches.js <storeCode> [--apply]
// (dry run by default, same as the automatic matcher)

'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); } catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const elemeSync = require('../lib/eleme-sync');

// [our product name_cn, the real Eleme listing name]
const MATCHES = [
  ['超级绿粉', '超级绿  Super Greens Powder'],
  ['超级莓粉', '超级莓 SuperBerries Blend'],
  ['生可可粉', 'Natural Cocoa Powder 可可粉'],
  ['谷朊粉（面筋粉）', 'Wheat Gluten Flour 谷朊粉'],
  ['云南玛卡粉', '玛咖粉玛卡粉 Maca Powder'],
  ['烘烤榛子酱', '经典榛子酱 Roasted Hazelnut Butter'],
  ['地板清洁液', 'Floor Cleaner 地板清洁（7-502)'],
  ['沙瓦玛素肉卷', '沙瓦玛卷 Shawarma Wrap'],
  ['苏马克粉（漆树果）', '苏模粉/漆树果粉Sumac'],
  ['扎塔香料', "Za'atar绿百里香粉"],
  ['西双版纳易武咖啡豆', '易武咖啡豆 Black Plum Coffee Beans'],
  ['烤榛子', 'Roasted Hazelnuts熟榛子仁'],
  ['法拉费小饼', '【速冻】法拉费小饼（非油炸）Baked Falafel'],
  ['夏日柠檬棒', '清新夏日柠檬棒 Lemon Bars'],
  ['全麦螺旋意面', 'WholeWheat Fusilli 螺旋面'],
  ['多用途清洁喷雾', 'Multi Purpose Spray多用途喷雾*7-507'],
  ['生南瓜子（无盐）', 'Pumpkin Seeds 南瓜子（无盐，生）'],
  ['天然强效去渍液', 'Stain Remover 除污剂（7-506)'],
  ['佳乐高浓度椰浆', 'Kara Coconut Cream佳乐椰浆'],
  ['NOW Foods 双倍铁元素', 'Double Strength 铁 iron'],
  ['墨西哥玉米片', '玉米片 Tortilla Chips'],
  ['以色列帝王椰枣（大果）', '帝王椰枣 Medjool Dates'],
  ['营养酵母（芝士风味）', 'Nutritional Yeast 营养酵母'],
  ['大豆组织蛋白（素肉碎）', 'TVP大豆蛋白'],
  ['酱香藜麦排', '【速冻】酱香藜麦排  3块 Quinoa Pattie'],
  ['衣物浸泡粉', '浸泡粉 Laundry Soaker'],
  ['长粒糙米', 'Brown Rice 糙米（生）'],
  ['马桶清洁液', 'Toilet Cleaner 洗手间清洁液（7-504)'],
  ['亚麻籽', 'Flaxseed 亚麻籽（生）'],
  ['中东芝麻酱（带皮）', '芝麻酱(未去皮) Whole Sesame Tahini'],
  ['藜麦沙拉', '素食藜麦沙拉 Quinoa Salad'],
  ['苹果派隔夜燕麦', '苹果绵绵燕麦 Apple Pie Overnight Oat'],
  ['脆红枣片', '红枣片 Crunchy Jujube'],
  ['素腐乳（无油）', 'Fermented Tofu (oil free)无油素腐乳'],
  ['香菇汉堡饼', '【速冻】香菇汉堡饼 3块 Mushroom Patties'],
  ['胡萝卜生姜汁', '姜胡萝卜汁 Carrot Ginger Juice'],
  ['诺意椰枣', '椰枣 Nour Dates'],
  ['蒜香莳萝酸奶油', 'Garlic Dill Sour Cream 大蒜莳萝酸奶酪'],
];

async function main() {
  const storeCode = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!storeCode) { console.error('usage: node scripts/eleme-apply-reviewed-matches.js <storeCode> [--apply]'); process.exit(1); }
  const store = db.prepare('SELECT id FROM retail_stores WHERE code = ?').get(storeCode);
  if (!store) { console.error(`[reviewed] no store with code ${storeCode}`); process.exit(1); }

  // Names already claimed by another product's map row for this store — never
  // let this batch steal a listing scripts/eleme-match-products.js (or an
  // earlier manual entry) already assigned.
  const taken = new Map(); // eleme_name -> product_id
  for (const r of db.prepare('SELECT product_id, eleme_name FROM eleme_product_map WHERE retail_store_id = ? AND eleme_name IS NOT NULL').all(store.id)) {
    taken.set(r.eleme_name, r.product_id);
  }

  const ok = [], skipped = [];
  for (const [nameCn, target] of MATCHES) {
    const p = db.prepare('SELECT id, name_cn FROM store_products WHERE name_cn = ? AND is_active = 1').get(nameCn);
    if (!p) { skipped.push([nameCn, target, 'no active product with this exact name_cn']); continue; }
    const holder = taken.get(target);
    if (holder != null && holder !== p.id) { skipped.push([nameCn, target, `listing already used by product #${holder}`]); continue; }
    ok.push({ productId: p.id, nameCn, target });
    taken.set(target, p.id);
  }

  console.log(`[reviewed] ${ok.length} match(es) ready, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  SKIP "${s[0]}" → "${s[1]}" — ${s[2]}`);

  if (!apply) {
    console.log(`\n[reviewed] dry run — nothing written. Re-run with --apply to write and queue the push.`);
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO eleme_product_map (retail_store_id, product_id, store_code, eleme_name, sync_enabled, updated_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(retail_store_id, product_id) DO UPDATE SET
      eleme_name = excluded.eleme_name, sync_enabled = 1, updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const m of ok) upsert.run(store.id, m.productId, storeCode, m.target);
  });
  tx();
  console.log(`[reviewed] applied ${ok.length} mapping(s).`);

  const queued = elemeSync.enqueueAll(db);
  console.log(`[reviewed] queued ${queued} product(s) for their first push.`);
}

main().catch(e => { console.error('[reviewed] fatal:', e); process.exit(1); });
