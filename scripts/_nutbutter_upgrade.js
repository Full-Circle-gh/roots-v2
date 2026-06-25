// Upgrade natural Nut Butters: add big_stat (ingredient purity / no added oil),
// fix yellow mark (prepend highlight if not in body), assign mascot.
// Leaves the 81% Hazelnut Spread (already has big_stat) + bundles/sets untouched.
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');

const PURE = (nut_en, nut_cn, sub_en, sub_cn) => ({ stat: '100%', cap: [nut_en, nut_cn], sub: [sub_en, sub_cn] });
const S = {
  270: PURE('PEANUTS · NOTHING ELSE', '纯花生 · 别无其他', 'No sugar, no oil, no palm.', '不加糖、不加油、无棕榈油。'),
  269: PURE('PEANUTS · NOTHING ELSE', '纯花生 · 别无其他', 'No sugar, no oil, no palm.', '不加糖、不加油、无棕榈油。'),
  348: PURE('PEANUTS · LIGHTLY SALTED', '花生 · 微盐', 'Roasted peanuts and a little salt.', '烤花生,加一点盐。'),
  266: PURE('ALMONDS · LIGHTLY SALTED', '杏仁 · 微盐', 'No added oil, no sugar.', '不加油、不加糖。'),
  267: PURE('ALMONDS · LIGHTLY SALTED', '杏仁 · 微盐', 'No added oil, no sugar.', '不加油、不加糖。'),
  199: PURE('CASHEWS · NOTHING ELSE', '纯腰果 · 别无其他', 'No sugar, no added oil.', '不加糖、不加油。'),
  49:  PURE('HAZELNUTS · NOTHING ELSE', '纯榛子 · 别无其他', 'No sugar, no oil.', '不加糖、不加油。'),
  195: PURE('HULLED SESAME', '纯去壳芝麻', 'Nothing but sesame.', '只有芝麻。'),
  189: PURE('WHOLE SESAME', '纯全芝麻', 'Nothing removed, nothing added.', '无去除、无添加。'),
  268: { stat: '0', cap: ['ADDED OIL', '零添加油'], sub: ['Real maple and cinnamon.', '真枫糖与肉桂。'] },
  305: { stat: '0', cap: ['ADDED OIL', '零添加油'], sub: ['Real maple and cinnamon.', '真枫糖与肉桂。'] },
};
const MASC = ['skater', 'hula', 'flex', 'broccoli', 'peas', 'onion', 'radishes', 'mushroom', 'kombucha-gang'];
const ids = [270, 269, 348, 266, 267, 199, 49, 195, 189, 268, 305];

let n = 0; const rep = [];
ids.forEach((id, ix) => {
  const row = db.prepare("SELECT name_en,description_blocks FROM store_products WHERE id=?").get(id);
  if (!row) { rep.push('!! MISSING ' + id); return; }
  let b; try { b = JSON.parse(row.description_blocks || '[]'); } catch (e) { rep.push('!! BADJSON ' + id); return; }
  const hero = b.find(x => x.type === 'hero_intro');
  if (hero) {
    const he = hero.highlight_en || '', hc = hero.highlight_cn || '';
    if (he && !(hero.body_en || '').toLowerCase().includes(he.toLowerCase())) hero.body_en = he + ' ' + (hero.body_en || '');
    if (hc && !(hero.body_cn || '').includes(hc)) hero.body_cn = hc + (hero.body_cn || '');
  }
  b = b.filter(x => x.type !== 'big_stat');
  const s = S[id];
  const bs = { type: 'big_stat', stat: s.stat, what_en: s.cap[0], what_cn: s.cap[1], sub_en: s.sub[0], sub_cn: s.sub[1], bg: 'lime', id: 'bs' + id };
  const hi = b.findIndex(x => x.type === 'hero_intro');
  if (hi >= 0) b.splice(hi + 1, 0, bs); else b.unshift(bs);
  const col = MASC[ix % MASC.length];
  const h2 = b.find(x => x.type === 'hero_intro') || {};
  const inE = h2.highlight_en ? ((h2.body_en || '').toLowerCase().includes(h2.highlight_en.toLowerCase())) : '-';
  const inC = h2.highlight_cn ? ((h2.body_cn || '').includes(h2.highlight_cn)) : '-';
  rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 28).padEnd(29) + ' stat=' + s.stat.padEnd(5) + s.cap[0].slice(0, 22).padEnd(23) + ' hlE=' + inE + ' hlC=' + inC + ' col=' + col);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/nb_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks }));
    db.prepare("UPDATE store_products SET description_blocks=?,colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(b), col, id);
    n++;
  }
});
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' nut butters ==') : '== DRY (set APPLY=1) ==');
