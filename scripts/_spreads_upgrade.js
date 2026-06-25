// Add big_stat "100% PLANT-BASED" + fix mark + mascot to Spreads & Dips.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const STAT = { stat: '100%', cap: ['PLANT-BASED', '纯植物'], sub: ['No dairy, no animal products.', '不含乳、不含动物成分。'] };
const MASC = ['onion', 'broccoli', 'radishes', 'mushroom', 'peas', 'flex', 'hula', 'skater', 'kombucha-gang'];

const rows = db.prepare("SELECT id,name_en,description_blocks FROM store_products WHERE subcategory='Spreads & Dips' AND is_published=1 ORDER BY name_en").all();
let n = 0, ix = 0; const rep = [];
for (const row of rows) {
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + row.id); continue; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (!hero) { rep.push('-- SKIP ' + row.id + ' ' + row.name_en + ' (no hero)'); continue; }
  const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
  if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
  if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  b = b.filter(x => x.type !== 'big_stat');
  const bs = { type: 'big_stat', stat: STAT.stat, what_en: STAT.cap[0], what_cn: STAT.cap[1], sub_en: STAT.sub[0], sub_cn: STAT.sub[1], bg: 'lime', id: 'bs' + row.id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  b.splice(hi + 1, 0, bs);
  const col = MASC[ix++ % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + row.id + ' ' + (row.name_en || '').slice(0, 28).padEnd(29) + ' hlE=' + inE + ' hlC=' + inC + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/sp_' + row.id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, row.id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' spreads ==') : '== DRY (set APPLY=1) ==');
