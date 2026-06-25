// Insert a big_stat block (after hero_intro) into each Ready-to-Eat meal.
// base64 -w0 scripts/_meal_bigstat.js | ssh ... "cd /root/roots-v2 && base64 -d | APPLY=1 node -"
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const PROT_SV = ['PLANT PROTEIN · PER SERVING', '植物蛋白 · 每份'];
const SUB_PROT = ['Real food, real protein.', '真材实料的蛋白质。'];
const PLANT = ['PLANT-BASED', '纯植物'];
const SUB_PLANT = ['No meat, no dairy — ever.', '无肉、无奶,始终如一。'];
const P = (stat) => ({ stat, cap: PROT_SV, sub: SUB_PROT });
const PL = () => ({ stat: '100%', cap: PLANT, sub: SUB_PLANT });

const MS = {
  83: P('23g'), 66: P('20g'), 42: P('18g'), 210: P('10g'), 220: P('33g'),
  74: PL(), 204: PL(), 258: PL(), 259: PL(), 71: PL(), 121: PL(), 196: PL(), 72: PL(),
  161: { stat: '9', cap: ['ESSENTIAL AMINO ACIDS', '种必需氨基酸'], sub: ['A complete protein.', '完整的蛋白质。'] },
  177: { stat: '100%', cap: ['WHOLE GRAIN', '全谷物'], sub: ['Nothing stripped away.', '未精磨,全保留。'] },
  200: { stat: '100%', cap: ['WHOLE GRAIN', '全谷物'], sub: ['Whole oats, slow energy.', '整粒燕麦,慢释放能量。'] },
};

let n = 0; const rep = [];
for (const id of Object.keys(MS).map(Number)) {
  const m = MS[id];
  const row = db.prepare("SELECT name_en,description_blocks FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); continue; }
  let b = JSON.parse(row.description_blocks || '[]');
  b = b.filter(x => x.type !== 'big_stat');            // idempotent: drop any existing
  const hi = b.findIndex(x => x.type === 'hero_intro');
  const bs = { type: 'big_stat', stat: m.stat, what_en: m.cap[0], what_cn: m.cap[1], sub_en: m.sub[0], sub_cn: m.sub[1], bg: 'lime', id: 'bs' + id };
  if (hi >= 0) b.splice(hi + 1, 0, bs); else b.unshift(bs);
  rep.push('#' + id + ' ' + (row.name_en || '').padEnd(28) + ' stat=' + m.stat.padEnd(5) + m.cap[0] + ' | blocks=' + b.length);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/meal_' + id + '_bigstat_' + Date.now() + '.json', row.description_blocks);
    db.prepare("UPDATE store_products SET description_blocks=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' meals ==') : '== DRY (set APPLY=1) ==');
