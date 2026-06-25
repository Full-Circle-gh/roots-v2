// Small food cats: sorbet, jams, pickles/olives big_stat + mark fix + mascot.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');
const S = {
  198: { stat: '100%', cap: ['FRUIT', '纯果'], sub: ['Dairy-free, real fruit.', '无乳,真实水果。'] },
  163: { stat: '0', cap: ['REFINED SUGAR', '零精制糖'], sub: ['Set with chia, sweetened by fruit.', '以奇亚籽凝固,水果增甜。'] },
  216: { stat: '0', cap: ['REFINED SUGAR', '零精制糖'], sub: ['Sweetened naturally.', '天然增甜。'] },
  91:  { stat: '100%', cap: ['PLANT-BASED', '纯植物'], sub: ['Simply brined olives.', '简单盐渍橄榄。'] },
  78:  { stat: '100%', cap: ['PLANT-BASED', '纯植物'], sub: ['Tangy, simple pickles.', '酸爽简单的腌洋葱。'] },
};
const MASC = ['radishes', 'onion', 'peas', 'broccoli', 'mushroom'];
const ids = Object.keys(S).map(Number);
let n = 0, ix = 0; const rep = [];
for (const id of ids) {
  const row = db.prepare("SELECT name_en,description_blocks FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); continue; }
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + id); continue; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (!hero) { rep.push('-- SKIP ' + id + ' (no hero)'); continue; }
  const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
  if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
  if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  b = b.filter(x => x.type !== 'big_stat');
  const s = S[id];
  const bs = { type: 'big_stat', stat: s.stat, what_en: s.cap[0], what_cn: s.cap[1], sub_en: s.sub[0], sub_cn: s.sub[1], bg: 'lime', id: 'bs' + id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  b.splice(hi + 1, 0, bs);
  const col = MASC[ix++ % MASC.length];
  rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 28).padEnd(29) + ' stat=' + (s.stat + ' ' + s.cap[0]) + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/sc_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' small-cats ==') : '== DRY ==');
