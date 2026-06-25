// Add big_stat to Kombucha ("LIVE CULTURES") + Juices ("100% JUICE"), carded published only.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const STAT = {
  Kombucha: { stat: 'LIVE', cap: ['CULTURES', '活性益生菌'], sub: ['Naturally fermented.', '天然发酵。'] },
  Juices: { stat: '100%', cap: ['JUICE', '纯果汁'], sub: ['Nothing added.', '无任何添加。'] },
};
const MASC = ['kombucha-gang', 'hula', 'flex', 'skater', 'peas', 'onion', 'broccoli', 'radishes', 'mushroom'];

const rows = db.prepare("SELECT id,name_en,subcategory,description_blocks FROM store_products WHERE subcategory IN ('Kombucha','Juices') AND is_published=1 ORDER BY subcategory,name_en").all();
let n = 0, ix = 0; const rep = [];
for (const row of rows) {
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + row.id); continue; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (!hero) { rep.push('-- SKIP ' + row.id + ' ' + row.name_en + ' (no hero)'); continue; }
  const st = STAT[row.subcategory]; if (!st) continue;
  const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
  if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
  if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  b = b.filter(x => x.type !== 'big_stat');
  const bs = { type: 'big_stat', stat: st.stat, what_en: st.cap[0], what_cn: st.cap[1], sub_en: st.sub[0], sub_cn: st.sub[1], bg: 'lime', id: 'bs' + row.id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  b.splice(hi + 1, 0, bs);
  const col = MASC[ix++ % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + row.id + ' [' + row.subcategory + '] ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' stat=' + st.stat.padEnd(5) + ' hlE=' + inE + ' hlC=' + inC + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/dr_' + row.id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, row.id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' drinks ==') : '== DRY (set APPLY=1) ==');
