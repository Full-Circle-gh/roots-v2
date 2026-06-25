// Upgrade published Dried Fruits: add big_stat, fix yellow mark (prepend punch line
// so the highlight is in-body), assign a mascot, and fill nutrition where missing.
// base64 -w0 scripts/_driedfruit_upgrade.js | ssh ... "cd /root/roots-v2 && base64 -d | APPLY=1 node -"
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');
const nut = (be, bc, rows) => JSON.stringify({ basis_en: be, basis_cn: bc, rows: rows.map(r => ({ label_en: r[0], label_cn: r[1], value: r[2] })) });

const DEF = { stat: '100%', cap: ['FRUIT · NOTHING ADDED', '纯果 · 零添加'], sub: ['No sugar, no oils, no preservatives.', '不加糖、不加油、无防腐剂。'] };
const STATS = {
  179: { stat: '14g', cap: ['PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克'], sub: ['Unusually protein-rich for dried fruit.', '果干中难得的高蛋白。'] },
  239: { stat: '16g', cap: ['FIBER · PER 100G', '膳食纤维 · 每100克'], sub: ['Naturally high in fiber.', '天然高纤维。'] },
};
const NUTR = {
  73: nut('Per 100g', '每100克', [['Energy', '能量', '320 kcal'], ['Protein', '蛋白质', '3.5 g'], ['Fat', '脂肪', '1 g'], ['Carbohydrate', '碳水化合物', '80 g'], ['Sugars', '糖', '47 g'], ['Dietary fiber', '膳食纤维', '7 g'], ['Sodium', '钠', '5 mg']]),
  13: nut('Per 100g', '每100克', [['Energy', '能量', '280 kcal'], ['Protein', '蛋白质', '2.2 g'], ['Fat', '脂肪', '0.4 g'], ['Carbohydrate', '碳水化合物', '75 g'], ['Sugars', '糖', '63 g'], ['Dietary fiber', '膳食纤维', '7 g'], ['Sodium', '钠', '2 mg']]),
  88: nut('Per 100g', '每100克', [['Energy', '能量', '243 kcal'], ['Protein', '蛋白质', '0.9 g'], ['Fat', '脂肪', '0.3 g'], ['Carbohydrate', '碳水化合物', '65 g'], ['Sugars', '糖', '57 g'], ['Dietary fiber', '膳食纤维', '8.7 g'], ['Sodium', '钠', '10 mg']]),
  85: nut('Per 100g', '每100克', [['Energy', '能量', '241 kcal'], ['Protein', '蛋白质', '3.4 g'], ['Fat', '脂肪', '0.5 g'], ['Carbohydrate', '碳水化合物', '63 g'], ['Sugars', '糖', '53 g'], ['Dietary fiber', '膳食纤维', '7.3 g'], ['Sodium', '钠', '10 mg']]),
  98: nut('Per 100g', '每100克', [['Energy', '能量', '317 kcal'], ['Protein', '蛋白质', '2.5 g'], ['Fat', '脂肪', '2.5 g'], ['Carbohydrate', '碳水化合物', '80 g'], ['Sugars', '糖', '60 g'], ['Dietary fiber', '膳食纤维', '7.5 g'], ['Sodium', '钠', '3 mg']]),
};
const MASC = ['radishes', 'mushroom', 'peas', 'onion', 'broccoli', 'flex', 'hula', 'skater', 'kombucha-gang'];
const ids = [215, 77, 239, 75, 4, 73, 169, 13, 157, 3, 148, 242, 88, 85, 179, 98, 162];

let n = 0; const rep = [];
ids.forEach((id, ix) => {
  const row = db.prepare("SELECT name_en,description_blocks,nutrition FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); return; }
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + id); return; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (hero) {
    const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
    if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
    if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  }
  b = b.filter(x => x.type !== 'big_stat');
  const s = STATS[id] || DEF;
  const bs = { type: 'big_stat', stat: s.stat, what_en: s.cap[0], what_cn: s.cap[1], sub_en: s.sub[0], sub_cn: s.sub[1], bg: 'lime', id: 'bs' + id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  if (hi >= 0) b.splice(hi + 1, 0, bs); else b.unshift(bs);
  const setNut = (NUTR[id] && (!row.nutrition || row.nutrition.length < 10)) ? NUTR[id] : null;
  const col = MASC[ix % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' stat=' + s.stat.padEnd(5) + ' hlE=' + inE + ' hlC=' + inC + (setNut ? ' +NUT' : '') + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/df_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks, nutrition: row.nutrition }));
    if (setNut) db.prepare("UPDATE store_products SET description_blocks=?,nutrition=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), setNut, col, id);
    else db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, id);
    n++;
  }
});
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' dried fruits ==') : '== DRY (set APPLY=1) ==');
