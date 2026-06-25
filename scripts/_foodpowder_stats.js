// Add big_stat (+ fix mark + mascot) to remaining food + powder cards, per approved angles.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const PLANT = ['No dairy, no animal products.', '不含乳、不含动物成分。'];
const C = (stat, en, cn, sen, scn) => ({ stat, cap: [en, cn], sub: [sen, scn] });
const PB = (stat, en, cn) => C(stat, en, cn, PLANT[0], PLANT[1]);

const S = {
  // Baking & Breakfast
  139: PB('100%', 'CACAO · UNSWEETENED', '纯可可 · 无糖'), 142: PB('100%', 'CACAO · UNSWEETENED', '纯可可 · 无糖'),
  165: C('20g', 'PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克', 'A high-protein flour.', '高蛋白面粉。'),
  137: C('75g', 'PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克', 'The base for seitan.', '素肉/面筋的基础。'),
  174: PB('100%', 'PLANT-BASED', '纯植物'), 226: PB('100%', 'PLANT-BASED', '纯植物'),
  // Bread
  64: C('100%', 'WHOLE WHEAT', '全麦', 'Whole-grain flour.', '全麦面粉。'),
  255: C('100%', 'GLUTEN-FREE', '无麸质', 'Made without gluten.', '不含麸质。'),
  185: C('100%', 'GLUTEN-FREE', '无麸质', 'Made without gluten.', '不含麸质。'),
  256: C('6g', 'FIBER · PER 100G', '膳食纤维 · 每100克', 'Whole-wheat, higher fiber.', '全麦,纤维更高。'),
  228: C('100%', 'WHOLE GRAIN', '全谷物', 'Whole-grain rye.', '全谷物黑麦。'),
  // Chips & Crackers
  96: C('100%', 'WHOLE WHEAT', '全麦', 'Whole-grain crackers.', '全麦薄脆。'),
  144: PB('100%', 'PLANT-BASED', '纯植物'),
  // Bites & Bars
  155: C('0g', 'ADDED SUGAR', '零添加糖', 'Sweetened only by fruit.', '仅以水果增甜。'),
  108: PB('100%', 'PLANT-BASED', '纯植物'), 104: PB('100%', 'PLANT-BASED', '纯植物'),
  63: PB('100%', 'PLANT-BASED', '纯植物'), 43: PB('100%', 'PLANT-BASED', '纯植物'), 160: PB('100%', 'PLANT-BASED', '纯植物'),
  // Plant Powders (clear headline nutrient)
  130: C('60%', 'PLANT PROTEIN · BY WEIGHT', '植物蛋白 · 占比', 'Among the richest in nature.', '自然界蛋白最丰富之一。'),
  37: C('27%', 'PLANT PROTEIN · BY WEIGHT', '植物蛋白 · 占比', 'A nutrient-dense green.', '营养密集的绿色超级食物。'),
  146: C('B12', '83% DAILY VALUE · PER SERVING', '每份 · 83% 每日所需', 'A natural vegan B12 source.', '天然纯素 B12 来源。'),
  // Protein Powders
  227: C('16g', 'PROTEIN · PER SERVING', '蛋白质 · 每份', 'Plant protein, per scoop.', '每勺植物蛋白。'),
  211: C('25g', 'PROTEIN · PER SERVING', '蛋白质 · 每份', 'Plant protein, per scoop.', '每勺植物蛋白。'),
};
const MASC = ['peas', 'broccoli', 'onion', 'radishes', 'mushroom', 'flex', 'hula', 'skater', 'kombucha-gang'];
const ids = Object.keys(S).map(Number);

let n = 0, ix = 0; const rep = [];
for (const id of ids) {
  const row = db.prepare("SELECT name_en,description_blocks FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); continue; }
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + id); continue; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (!hero) { rep.push('-- SKIP ' + id + ' ' + row.name_en + ' (no hero)'); continue; }
  const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
  if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
  if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  b = b.filter(x => x.type !== 'big_stat');
  const s = S[id];
  const bs = { type: 'big_stat', stat: s.stat, what_en: s.cap[0], what_cn: s.cap[1], sub_en: s.sub[0], sub_cn: s.sub[1], bg: 'lime', id: 'bs' + id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  b.splice(hi + 1, 0, bs);
  const col = MASC[ix++ % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' stat=' + (s.stat + ' ' + s.cap[0]).slice(0, 30).padEnd(31) + ' hlE=' + inE + ' hlC=' + inC + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/fp_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' food+powder ==') : '== DRY (set APPLY=1) ==');
