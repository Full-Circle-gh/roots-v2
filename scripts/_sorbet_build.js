// Build design blocks for the Raspberry Mango Sorbet group OWNER (#315), then
// the existing inherit_variant_blocks.js pushes them to the 1-cup / 5-cup
// siblings (#198, #316). Content is the operator-supplied copy verbatim:
// a ready-to-eat frozen sorbet of raspberries + mango + lime juice/zest,
// sweetened with maple syrup; dairy-free + plant-based; 100 g/cup, made in
// Guangzhou. NO invented nutrition/health claims.
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
      { k_en: 'Type', k_cn: '类型', v_en: 'Ready-to-eat frozen sorbet', v_cn: '即食冷冻果味冰沙' },
      { k_en: 'Net Wt', k_cn: '净含量', v_en: '100 g per cup', v_cn: '每杯 100 克' },
      { k_en: 'Origin', k_cn: '产地', v_en: 'Guangzhou, China', v_cn: '中国广州' },
    ], id: 'sp315' },

  { type: 'hero_intro',
    kicker_en: 'Cold, bright, and straight to the point.',
    kicker_cn: '冰爽、明亮、直接',
    body_en: 'This sorbet blends juicy raspberries with tropical mango, sharpened by fresh lime juice and zest. Sweetened gently with maple syrup — just enough to let the fruit speak. No dairy. No heaviness. Just clean, frozen fruit energy.',
    body_cn: '覆盆子与芒果融合，加入新鲜青柠汁与青柠皮，风味清晰、有冲击力。以枫糖轻柔调甜，让水果本身成为主角。不含乳制品，不厚重，只有干净的冷冻果味。',
    highlight_en: 'No dairy. No heaviness. Just clean, frozen fruit energy.',
    highlight_cn: '不含乳制品，不厚重，只有干净的冷冻果味。',
    id: 'he315' },

  { type: 'big_stat', stat: '100%', what_en: 'PLANT-BASED', what_cn: '纯植物',
    sub_en: 'A dairy-free fruit sorbet.', sub_cn: '不含乳的水果冰沙。', bg: 'lime', id: 'bs315' },

  { type: 'why', rows: [
      { claim_en: 'Pure fruit flavor, not candy sweetness.', claim_cn: '真实水果风味，不是糖果味。' },
      { claim_en: 'Light, refreshing, and easy to enjoy year-round.', claim_cn: '清爽轻盈，四季都适合。' },
      { claim_en: 'A frozen dessert that actually feels good to eat.', claim_cn: '吃完没有负担感的冷冻甜点。' },
    ], id: 'wh315' },

  { type: 'ingredients_chips', items: [
      { name_en: 'Raspberries', name_cn: '覆盆子', pct: '', lead: true },
      { name_en: 'Mango', name_cn: '芒果', pct: '', lead: true },
      { name_en: 'Lime Juice', name_cn: '青柠汁', pct: '', lead: false },
      { name_en: 'Lime Zest', name_cn: '青柠皮', pct: '', lead: false },
      { name_en: 'Maple Syrup', name_cn: '枫糖浆', pct: '', lead: false },
    ], id: 'in315' },

  { type: 'how_to_use', tiles: [
      { icon: '🥶', label_en: 'Keep Frozen', label_cn: '冷冻保存', sub_en: 'Store in the freezer until ready', sub_cn: '食用前置于冷冻室保存' },
      { icon: '⏲', label_en: 'Soften If Firm', label_cn: '过硬先回温', sub_en: 'If too firm, let it sit a few minutes', sub_cn: '若过硬，可回温几分钟' },
      { icon: '🍨', label_en: 'Scoop & Serve', label_cn: '挖取享用', sub_en: 'Into a chilled bowl or cone', sub_cn: '盛入冰镇碗或蛋筒' },
      { icon: '🌿', label_en: 'Straight from Frozen', label_cn: '冷冻即食', sub_en: 'Designed to enjoy right out of the freezer', sub_cn: '专为冷冻状态食用设计' },
    ], id: 'hw315' },

  { type: 'storage_box',
    left:  { icon: '🧊', head_en: 'Keep Frozen', head_cn: '全程冷冻', num: '', unit_en: 'Keep frozen at all times', unit_cn: '需全程冷冻保存', alt: false },
    right: { icon: '📅', head_en: 'Shelf Life', head_cn: '保质期', num: '', unit_en: 'See packaging', unit_cn: '见包装标注', alt: true },
    note_en: 'Keep frozen at all times. If too firm, let it sit for a few minutes before scooping.',
    note_cn: '需全程冷冻保存。若过硬，可回温几分钟后再挖取食用。',
    id: 'st315' },

  { type: 'notes_callout',
    text_en: 'Plant-based frozen sorbet, made from real fruit and designed to be enjoyed straight from the freezer.',
    text_cn: '植物性冷冻果味冰沙，由真实水果制成，专为冷冻状态食用设计。',
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
