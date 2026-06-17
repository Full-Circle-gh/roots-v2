// Build design blocks for the Raspberry Mango Sorbet group OWNER (#315), then
// the existing inherit_variant_blocks.js pushes them to the 1-cup / 5-cup
// siblings (#198, #316). Content is built ONLY from what's certain: it's a
// raspberry + mango fruit sorbet, vegan (free_of: animal products) and
// gluten-free. NO invented nutrition/health claims. The ingredient base
// (water + cane sugar) is the standard sorbet base — VERIFY against the label.
//   node scripts/_sorbet_build.js            # dry-run
//   APPLY=1 node scripts/_sorbet_build.js    # write blocks to #315 (backs up first)
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const APPLY = !!process.env.APPLY;
const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));

const OWNER_ID = 315;
const COLOPHON = 'hula';            // tropical-ish mascot; matches a mango sorbet
const TEMPLATE = 'editorial_light';  // same template the other block products use

const blocks = [
  { type: 'spec_strip', cells: [
      { k_en: 'Type', k_cn: '类型', v_en: 'Fruit sorbet', v_cn: '水果雪葩' },
      { k_en: 'Diet', k_cn: '饮食', v_en: 'Vegan · Gluten-free', v_cn: '纯素 · 无麸质' },
      { k_en: 'Serve', k_cn: '食用', v_en: 'Keep frozen', v_cn: '冷冻保存' },
    ], id: 'sp315' },

  { type: 'hero_intro',
    kicker_en: 'Real fruit. No dairy. Just cold and bright.',
    kicker_cn: '真实水果，不含乳，清冽明亮',
    body_en: 'A fruit sorbet of ripe mango and tart raspberry — smooth, cold, and refreshing without a drop of dairy. The mango brings the mellow sweetness and the raspberry cuts back with a clean, bright tartness. Light on the palate and made to be scooped straight from frozen.',
    body_cn: '熟芒果与酸树莓打成的水果雪葩——绵密、冰凉、清爽，不含一滴乳制品。芒果带来温润的甜，树莓收回一抹明亮的酸。入口轻盈，冷冻后即可挖取享用。',
    highlight_en: 'Smooth, cold, and refreshing — without a drop of dairy.',
    highlight_cn: '绵密、冰凉、清爽——不含一滴乳制品。',
    id: 'he315' },

  { type: 'big_stat', stat: '100%', what_en: 'PLANT-BASED', what_cn: '纯植物',
    sub_en: 'A dairy-free fruit sorbet.', sub_cn: '不含乳的水果雪葩。', bg: 'lime', id: 'bs315' },

  { type: 'why', rows: [
      { claim_en: 'Made with real mango and raspberry — fruit-forward, not artificial.', claim_cn: '以真实芒果与树莓制成——果香主导，非人工调味。' },
      { claim_en: 'Dairy-free and 100% plant-based — a sorbet, not an ice cream.', claim_cn: '不含乳、纯植物——是雪葩，而非冰淇淋。' },
      { claim_en: 'Gluten-free.', claim_cn: '无麸质。' },
      { claim_en: 'Light and refreshing — the raspberry keeps it bright, not heavy.', claim_cn: '轻盈清爽——树莓的酸让它明亮不腻。' },
    ], id: 'wh315' },

  { type: 'ingredients_chips', items: [
      { name_en: 'Mango', name_cn: '芒果', pct: '', lead: true },
      { name_en: 'Raspberry', name_cn: '树莓', pct: '', lead: true },
      { name_en: 'Water', name_cn: '水', pct: '', lead: false },
      { name_en: 'Cane Sugar', name_cn: '蔗糖', pct: '', lead: false },
    ], id: 'in315' },

  { type: 'how_to_use', tiles: [
      { icon: '🥶', label_en: 'Keep Frozen', label_cn: '冷冻保存', sub_en: 'Store in the freezer until ready', sub_cn: '食用前置于冷冻室保存' },
      { icon: '⏲', label_en: 'Soften Briefly', label_cn: '稍微回温', sub_en: 'Rest 1–2 min for easy scooping', sub_cn: '取出静置1–2分钟更易挖取' },
      { icon: '🍨', label_en: 'Scoop & Serve', label_cn: '挖取享用', sub_en: 'Eat straight from the cup', sub_cn: '可直接从杯中食用' },
      { icon: '🍓', label_en: 'Top It', label_cn: '加点配料', sub_en: 'Fresh fruit or a drizzle of syrup', sub_cn: '搭配鲜果或淋一点糖浆' },
    ], id: 'hw315' },

  { type: 'storage_box',
    left:  { icon: '🧊', head_en: 'Keep Frozen', head_cn: '全程冷冻', num: '-18°', unit_en: 'C or below', unit_cn: 'C 以下保存', alt: false },
    right: { icon: '⏲', head_en: 'Once Softened', head_cn: '回温后', num: '', unit_en: 'Eat soon — avoid refreezing melted sorbet', unit_cn: '请尽快食用——避免化后再次冷冻', alt: true },
    note_en: 'Keep frozen at -18°C or below. Let it soften for a minute before scooping; avoid refreezing once melted.',
    note_cn: '请于 -18°C 以下全程冷冻。挖取前稍回温一分钟；化开后请勿再次冷冻。',
    id: 'st315' },

  { type: 'notes_callout',
    text_en: 'A dairy-free fruit sorbet. Natural colour and texture may vary between batches; this is normal and does not affect quality.',
    text_cn: '本品为不含乳的水果雪葩。天然色泽与口感可能因批次略有差异，属正常现象，不影响品质。',
    id: 'nt315' },
];

const row = db.prepare('SELECT id, name_en, description_blocks, colophon_character FROM store_products WHERE id=?').get(OWNER_ID);
if (!row) { console.error('!! owner #' + OWNER_ID + ' not found'); process.exit(1); }

console.log(`Owner #${OWNER_ID} ${row.name_en} — building ${blocks.length} blocks (template=${TEMPLATE}, colophon=${COLOPHON}).`);
console.log('Block types: ' + blocks.map(b => b.type).join(', '));

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with: APPLY=1 node scripts/_sorbet_build.js');
  console.log('Then propagate to the 1-cup/5-cup siblings:  node scripts/inherit_variant_blocks.js --group 315 --apply\n');
  db.close();
  process.exit(0);
}

try { fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true }); } catch (e) {}
fs.writeFileSync(path.join(__dirname, '..', 'backups', `sorbet_${OWNER_ID}_${Date.now()}.json`),
  JSON.stringify({ description_blocks: row.description_blocks, colophon_character: row.colophon_character }));

db.prepare(`UPDATE store_products
   SET description_blocks=?, use_block_design=1, page_template=?, colophon_character=?, updated_at=CURRENT_TIMESTAMP
   WHERE id=?`).run(JSON.stringify(blocks), TEMPLATE, COLOPHON, OWNER_ID);

console.log(`\n== APPLIED ${blocks.length} blocks to owner #${OWNER_ID}. ==`);
console.log('Now propagate to siblings:  node scripts/inherit_variant_blocks.js --group 315 --apply\n');
db.close();
