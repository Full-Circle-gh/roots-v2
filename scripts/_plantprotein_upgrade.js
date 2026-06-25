// Upgrade Plant Protein (meat alternatives): add big_stat (protein, or 100% plant
// for the lighter patties), fix yellow mark, assign mascot. Skips cards with no hero.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const SUB_P = ['Real plant protein.', '实打实的植物蛋白。'];
const P100 = (g) => ({ stat: g + 'g', cap: ['PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克'], sub: SUB_P });
const PSV = (g) => ({ stat: g + 'g', cap: ['PLANT PROTEIN · PER SERVING', '植物蛋白 · 每份'], sub: SUB_P });
const PLANT = { stat: '100%', cap: ['PLANT-BASED', '纯植物'], sub: ['No meat, no dairy — ever.', '无肉、无奶,始终如一。'] };
const S = {
  95: P100(20), 106: P100(19), 92: P100(20), 97: P100(19), 170: P100(20), 101: P100(16), 173: P100(50),
  229: PSV(16), 230: PSV(10), 224: PSV(25),
  100: PLANT, 172: PLANT, 175: PLANT, 171: PLANT,
};
const MASC = ['mushroom', 'peas', 'broccoli', 'onion', 'radishes', 'flex', 'hula', 'skater', 'kombucha-gang'];
const ids = [100, 95, 229, 106, 92, 230, 172, 224, 175, 101, 171, 173, 97, 170];

let n = 0; const rep = [];
ids.forEach((id, ix) => {
  const row = db.prepare("SELECT name_en,description_blocks FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); return; }
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + id); return; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (!hero) { rep.push('-- SKIP ' + id + ' ' + row.name_en + ' (no hero)'); return; }
  const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
  if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
  if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  b = b.filter(x => x.type !== 'big_stat');
  const s = S[id]; if (!s) { rep.push('-- SKIP ' + id + ' (no stat cfg)'); return; }
  const bs = { type: 'big_stat', stat: s.stat, what_en: s.cap[0], what_cn: s.cap[1], sub_en: s.sub[0], sub_cn: s.sub[1], bg: 'lime', id: 'bs' + id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  b.splice(hi + 1, 0, bs);
  const col = MASC[ix % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' stat=' + s.stat.padEnd(5) + ' hlE=' + inE + ' hlC=' + inC + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/pp_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, id);
    n++;
  }
});
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' plant-protein ==') : '== DRY (set APPLY=1) ==');
