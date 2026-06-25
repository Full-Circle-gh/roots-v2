// Build cards for Energy Cubes, 3 Yunnan coffees, and 4 branded items (Oatly, Kara, Iron, B12).
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');
const nut = (be, bc, rows) => JSON.stringify({ basis_en: be, basis_cn: bc, rows: rows.map(r => ({ label_en: r[0], label_cn: r[1], value: r[2] })) });

function storage(kind, id) {
  if (kind === 'fridge') return { type: 'storage_box', left: { icon: '❄️', head_en: 'Keep refrigerated', head_cn: '冷藏保存', num: '', unit_en: 'For freshness and texture', unit_cn: '保持新鲜与口感', alt: false }, right: { icon: '📅', head_en: 'Shelf life', head_cn: '保质期', num: '', unit_en: 'See packaging', unit_cn: '见包装标示', alt: true }, note_en: 'Best kept chilled.', note_cn: '建议冷藏保存。', id: 'st' + id };
  if (kind === 'fridgeopen') return { type: 'storage_box', left: { icon: '🫙', head_en: 'Sealed', head_cn: '未开封', num: '', unit_en: 'Store at room temperature', unit_cn: '常温保存', alt: false }, right: { icon: '❄️', head_en: 'Once opened', head_cn: '开封后', num: '5', unit_en: 'days in the fridge', unit_cn: '天内（冷藏）', alt: true }, note_en: 'Shake well; refrigerate after opening.', note_cn: '摇匀后使用;开封后请冷藏。', id: 'st' + id };
  if (kind === 'coffee') return { type: 'storage_box', left: { icon: '🫙', head_en: 'Cool & dark', head_cn: '阴凉避光', num: '', unit_en: 'Airtight, away from light', unit_cn: '密封避光', alt: false }, right: { icon: '⏳', head_en: 'Best fresh', head_cn: '趁新鲜', num: '', unit_en: 'Enjoy within a few weeks', unit_cn: '建议数周内享用', alt: true }, note_en: 'Roasted to order — fresher is better.', note_cn: '接单烘焙——越新鲜越好。', id: 'st' + id };
  return { type: 'storage_box', left: { icon: '🫙', head_en: 'Keep it dry', head_cn: '干燥存放', num: '', unit_en: 'Cool, dry, sealed', unit_cn: '阴凉干燥、密封', alt: false }, right: { icon: '🔒', head_en: 'Keep safe', head_cn: '妥善存放', num: '', unit_en: 'Out of reach of children', unit_cn: '请放在儿童无法触及处', alt: true }, note_en: 'Store in a cool, dry place.', note_cn: '请存放于阴凉干燥处。', id: 'st' + id };
}
function card(c, id) {
  const b = [];
  b.push({ type: 'spec_strip', cells: c.spec.map(x => ({ k_en: x[0], k_cn: x[1], v_en: x[2], v_cn: x[3] })), id: 'sp' + id });
  b.push({ type: 'hero_intro', kicker_en: c.k[0], kicker_cn: c.k[1], body_en: c.be, body_cn: c.bc, highlight_en: c.he, highlight_cn: c.hc, id: 'he' + id });
  b.push({ type: 'big_stat', stat: c.s.stat, what_en: c.s.cap[0], what_cn: c.s.cap[1], sub_en: c.s.sub[0], sub_cn: c.s.sub[1], bg: 'lime', id: 'bs' + id });
  b.push({ type: 'why', rows: c.why.map(w => ({ claim_en: w[0], claim_cn: w[1] })), id: 'wh' + id });
  if (c.ing) b.push({ type: 'ingredients_chips', items: c.ing.map((it, i) => ({ name_en: it[0], name_cn: it[1], pct: '', lead: i === 0 })), id: 'ig' + id });
  if (c.uses) b.push({ type: 'how_to_use', tiles: c.uses.map(u => ({ icon: u[0], label_en: u[1], label_cn: u[2], sub_en: u[3] || '', sub_cn: u[4] || '' })), id: 'hw' + id });
  if (c.al) b.push({ type: 'allergen_card', contains_en: c.al[0], contains_cn: c.al[1], may_contain_en: c.al[2], may_contain_cn: c.al[3], id: 'al' + id });
  b.push(storage(c.store, id));
  b.push({ type: 'notes_callout', text_en: c.note[0], text_cn: c.note[1], id: 'nt' + id });
  return b;
}

const COFFEE = (id, alt, fl_en, fl_cn, roast_en, roast_cn) => ({
  ids: [id], store: 'coffee', k: ['Yunnan single-origin', '云南单一产区'],
  spec: [['Flavour', '风味', fl_en, fl_cn], ['Roast', '烘焙', roast_en, roast_cn], ['Net wt', '净含量', '100g', '100g']],
  be: "High-altitude coffee from Pu'er and Xishuangbanna — grown on the Tropic of Cancer in Yunnan's rich plateau soil. Zara, our cup-taster, hand-selects the best beans each harvest, and we roast them fresh: baked as soon as you order, shipped as soon as baked. Expect " + fl_en.toLowerCase() + ".",
  bc: "来自普洱与西双版纳的高海拔咖啡——生长在北回归线上的云南高原沃土。每个采收季,杯测师 Zara 亲手甄选最好的豆子,我们再新鲜烘焙:下单即烤,烤好即发。风味:" + fl_cn + "。",
  he: 'baked as soon as you order, shipped as soon as baked', hc: '下单即烤,烤好即发',
  s: { stat: alt, cap: ['GROWN AT ALTITUDE', '高海拔种植'], sub: ['Yunnan plateau coffee.', '云南高原咖啡。'] },
  why: [['Single-origin Yunnan, grown at high altitude.', '云南单一产区,高海拔种植。'], ['Cup-tested and hand-selected by Zara.', '由杯测师 Zara 亲手甄选。'], ['Roasted fresh — baked to order.', '新鲜烘焙——下单现烤。']],
  uses: [['☕', 'Pour-over', '手冲', 'Clean and bright', '干净明亮'], ['🫖', 'French press', '法压壶', 'Full-bodied', '醇厚饱满'], ['🟤', 'Moka pot', '摩卡壶', 'Rich and strong', '浓郁强劲'], ['💧', 'Drip', '滴滤', 'Easy everyday', '日常简单']],
  al: ['None declared', '未声明常见致敏原', 'Tree nuts, soy, gluten', '坚果、大豆、麸质'],
  note: ['Roasted to order for freshness. Whole bean or ground — see packaging.', '为保新鲜,接单后烘焙。整豆或研磨——见包装标示。'],
});

const CFG = [
  // ── Energy Cubes (one product, 4 variant rows in group 317) ──
  { ids: [280, 281, 317, 318], col: 'flex', store: 'fridge', k: ['Plant-based energy', '植物能量'],
    spec: [['Type', '类型', 'Energy cubes', '能量块'], ['Net wt', '净含量', '60g / 200g', '60g / 200g'], ['Origin', '产地', 'Guangzhou, China', '中国广州']],
    be: "Sweet. Nutty. Crunchy. These energy cubes are built for real hunger. Quinoa, seeds, oats, nuts, and cranberries come together in a peanut butter base that's chewy, crunchy, and deeply satisfying. No fake energy, no sugar rush — just steady fuel that holds.",
    bc: "甜、坚果香、酥脆。这些能量块为真正的饥饿而生。藜麦、籽、燕麦、坚果与蔓越莓在花生酱基底里融合,口感有嚼劲又酥脆,扎实满足。没有虚假能量,也没有糖分骤升——只有稳稳托住你的持久能量。",
    he: 'just steady fuel that holds', hc: '稳稳托住你的持久能量',
    s: { stat: 'STEADY', cap: ['ENERGY · NOT A SPIKE', '持久能量 · 不骤升'], sub: ['Whole grains, seeds & nuts.', '全谷物、籽与坚果。'] },
    why: [['Whole ingredients you can taste.', '看得见、尝得到的天然食材。'], ['Balanced carbs, fats, and protein — no shortcuts.', '碳水、脂肪与蛋白均衡——不走捷径。'], ['Chewy and crunchy — every bite stays interesting.', '有嚼劲又酥脆,每一口都不无聊。']],
    ing: [['Quinoa', '藜麦'], ['Chia seeds', '奇亚籽'], ['Flaxseeds', '亚麻籽'], ['Coconut floss', '椰丝'], ['Oats', '燕麦'], ['Almonds', '杏仁'], ['Organic cranberries', '有机蔓越莓'], ['Peanut butter', '花生酱'], ['Organic agave', '有机龙舌兰糖浆']],
    uses: [['🎒', 'On the go', '随手吃', 'Straight from the pack', '开袋即食'], ['💪', 'Pre-workout', '运动前', 'Steady fuel', '稳定能量'], ['🕛', 'Midday bite', '午后', 'A solid pick-me-up', '扎实加餐'], ['🥄', 'Real hunger', '真饿时', 'Built to satisfy', '为饱腹而生']],
    al: ['Peanuts, Tree nuts (almond), Gluten (oats)', '花生、坚果（杏仁）、麸质（燕麦）', 'Other nuts, Soy', '其他坚果、大豆'],
    N: nut('Per 60g serving', '每60克', [['Energy', '能量', '250 kcal'], ['Fat', '脂肪', '16 g'], ['Carbohydrate', '碳水化合物', '23 g'], ['Protein', '蛋白质', '7 g']]),
    note: ['Plant-based energy snack — whole grains, seeds and nuts. Built for steady energy, not sugar spikes.', '植物能量小食——全谷物、籽与坚果。为持久能量而生,不为糖分骤升。'] },

  // ── 3 Yunnan single-origin coffees ──
  COFFEE(191, '1400m', 'Caramel · nuts · dark chocolate', '焦糖 · 坚果 · 黑巧克力', 'Medium–deep', '中深烘焙'),
  COFFEE(81, '1500m', 'Citrus · wine · wild flower · white chocolate', '柑橘 · 红酒 · 野花 · 白巧克力', 'Medium–deep', '中深烘焙'),
  COFFEE(82, '1600m', 'Black plum · Yunnan black tea', '黑李 · 云南红茶', 'Light · fine roast', '浅烘 · 精细烘焙'),

  // ── Branded ──
  { ids: [58], col: 'kombucha-gang', store: 'fridgeopen', k: ['Oat milk · barista', '燕麦奶 · 咖啡师版'],
    spec: [['Type', '类型', 'Oat milk · barista', '燕麦奶 · 咖啡师版'], ['Net wt', '净含量', '1L', '1L'], ['Diet', '饮食', '100% plant', '纯植物']],
    be: "Oatly's Barista Edition — the oat milk baristas reach for. It steams and foams like dairy, so your lattes and cappuccinos get a proper silky microfoam, with a clean, lightly sweet oat taste that doesn't fight the coffee. Dairy-free, no fuss.",
    bc: "Oatly 咖啡师版——咖啡师都爱用的燕麦奶。它能像牛奶一样打发出绵密奶泡,让你的拿铁和卡布奇诺拥有顺滑细腻的奶沫;清爽微甜的燕麦味,不会盖过咖啡。无乳,省心。",
    he: 'steams and foams like dairy', hc: '像牛奶一样打发出绵密奶泡',
    s: { stat: '100%', cap: ['DAIRY-FREE', '纯素 · 无乳'], sub: ['Foams like dairy.', '像牛奶一样打发。'] },
    why: [['Steams and foams for latte art.', '可蒸打奶泡,拉花顺手。'], ['Clean, lightly sweet oat taste.', '清爽微甜的燕麦味。'], ['100% plant-based, no dairy.', '纯植物,不含乳。']],
    uses: [['☕', 'Lattes', '拿铁', 'Silky microfoam', '绵密奶沫'], ['🥛', 'Cappuccino', '卡布奇诺', 'Holds its foam', '奶泡稳定'], ['🥣', 'Cereal', '麦片', 'Pour over the top', '直接倒入'], ['🍳', 'Cooking', '烹饪', 'A 1:1 dairy swap', '1:1替代牛奶']],
    al: ['Oats (gluten)', '燕麦（麸质）', 'Tree nuts', '坚果'],
    N: nut('Per 100ml', '每100毫升', [['Energy', '能量', '60 kcal'], ['Fat', '脂肪', '3 g'], ['Carbohydrate', '碳水化合物', '6.7 g'], ['Protein', '蛋白质', '1 g'], ['Sodium', '钠', '90 mg']]),
    note: ['Oatly Barista Edition. Shake well; refrigerate after opening.', 'Oatly 咖啡师版。摇匀后使用;开封后请冷藏。'] },

  { ids: [131], col: 'hula', store: 'fridgeopen', k: ['Coconut cream', '椰浆'],
    spec: [['Type', '类型', 'Coconut cream', '椰浆'], ['Net wt', '净含量', '200ml', '200ml'], ['Diet', '饮食', '100% plant', '纯植物']],
    be: "Kara's rich coconut cream — thick, velvety, and ready to pour. It brings instant body to curries, soups, and desserts, whips up for dairy-free toppings, and makes a luscious base for plant-based ice cream. A little goes a long way.",
    bc: "Kara 浓椰浆——浓稠、丝滑、即开即倒。它能瞬间为咖喱、汤品和甜点增添浓度,可打发做无乳奶油,也是纯植物冰淇淋的绵密基底。用一点点,就很够。",
    he: 'A little goes a long way.', hc: '用一点点,就很够',
    s: { stat: '100%', cap: ['DAIRY-FREE CREAM', '无乳 · 纯素奶油'], sub: ['Rich and pourable.', '浓郁顺滑、即倒即用。'] },
    why: [['Thick and velvety for curries and desserts.', '浓稠丝滑,咖喱甜点皆宜。'], ['Whips up for dairy-free toppings.', '可打发做无乳奶油。'], ['Plant-based, no dairy.', '纯植物,不含乳。']],
    uses: [['🍛', 'Curries', '咖喱', 'Stir in for richness', '增添浓度'], ['🍮', 'Desserts', '甜点', 'Ice cream & puddings', '冰淇淋与布丁'], ['☕', 'Coffee', '咖啡', 'A creamy splash', '顺滑一抹'], ['🥥', 'Whip it', '打发', 'For dairy-free cream', '做无乳奶油']],
    al: ['None declared', '未声明常见致敏原', 'Tree nuts', '坚果'],
    N: nut('Per 100ml', '每100毫升', [['Energy', '能量', '330 kcal'], ['Fat', '脂肪', '34 g'], ['Saturated fat', '饱和脂肪', '30 g'], ['Carbohydrate', '碳水化合物', '3 g'], ['Protein', '蛋白质', '3 g'], ['Sodium', '钠', '10 mg']]),
    note: ['Kara coconut cream. Refrigerate after opening; natural separation is normal.', 'Kara 椰浆。开封后请冷藏;天然分层属正常现象。'] },

  { ids: [134], col: 'peas', store: 'dry', k: ['Iron supplement', '铁补充剂'],
    spec: [['Type', '类型', 'Iron supplement', '铁补充剂'], ['Form', '形态', 'Veg capsules', '植物胶囊'], ['Strength', '含量', 'Double strength', '双倍含量']],
    be: "NOW Foods Double Strength Iron — a gentle, easily-absorbed form of iron (ferrous bisglycinate) that's kind on the stomach. Plant-based eaters can run low on iron, so this is a simple daily top-up. One small capsule covers it.",
    bc: "NOW Foods 双倍铁——采用易吸收、对肠胃温和的甘氨酸亚铁。纯植物饮食者容易缺铁,这是每日简单的补充。一粒小胶囊就够了。",
    he: 'One small capsule covers it.', hc: '一粒小胶囊就够了',
    s: { stat: '36mg', cap: ['IRON · PER CAPSULE', '铁 · 每粒'], sub: ['Gentle, easily absorbed.', '温和、易吸收。'] },
    why: [['Gentle, easily-absorbed iron (bisglycinate).', '温和易吸收的甘氨酸亚铁。'], ['Handy for plant-based diets.', '适合纯植物饮食者。'], ['One capsule a day.', '每日一粒。']],
    uses: [['💊', 'Daily', '每日', 'One capsule with food', '随餐一粒'], ['🌿', 'Plant-based', '植物饮食', 'Tops up dietary iron', '补充膳食铁'], ['🔒', 'Keep safe', '妥善存放', 'Out of reach of children', '儿童勿触']],
    al: ['Vegan · non-GMO', '纯素 · 非转基因', 'Free from gluten, soy, dairy', '不含麸质、大豆、乳'],
    note: ['Vegan. Take as directed; not a substitute for a varied diet. Keep out of reach of children.', '纯素。请按说明服用;不能替代均衡饮食。请放在儿童无法触及处。'] },

  { ids: [124], col: 'broccoli', store: 'dry', k: ['B12 supplement', 'B12 补充剂'],
    spec: [['Type', '类型', 'B12 supplement', 'B12 补充剂'], ['Form', '形态', 'Capsules', '胶囊'], ['Diet', '饮食', 'Vegan', '纯素']],
    be: "Vitamin B12 — the one nutrient a plant-based diet can't reliably provide, since it comes from neither plants nor sunlight. This simple daily capsule keeps your levels topped up. Small habit, big peace of mind.",
    bc: "维生素 B12——纯植物饮食里最难稳定获取的营养,因为它既不来自植物,也不来自阳光。每天一粒,简单地把水平补足。小习惯,大安心。",
    he: 'Small habit, big peace of mind.', hc: '小习惯,大安心',
    s: { stat: 'B12', cap: ['THE VEGAN ESSENTIAL', '纯素必备'], sub: ['Not from plants or sun.', '植物与阳光都无法提供。'] },
    why: [['The nutrient plants can’t provide.', '植物无法提供的营养。'], ['A simple daily top-up.', '每日简单补充。'], ['Vegan and easy to take.', '纯素,服用简单。']],
    uses: [['💊', 'Daily', '每日', 'One capsule', '每日一粒'], ['🌱', 'Plant-based', '植物饮食', 'An essential top-up', '必要补充'], ['🔒', 'Keep safe', '妥善存放', 'Out of reach of children', '儿童勿触']],
    al: ['Vegan', '纯素', '', ''],
    note: ['Vegan. Take as directed; keep out of reach of children.', '纯素。请按说明服用;请放在儿童无法触及处。'] },
];

let n = 0; const rep = [];
for (const c of CFG) {
  for (const id of c.ids) {
    const row = db.prepare("SELECT name_en,description_blocks,nutrition,colophon_character FROM store_products WHERE id=?").get(id);
    if (!row) { rep.push('!! MISSING ' + id); continue; }
    const blocks = card(c, id);
    const inE = c.be.toLowerCase().includes(c.he.toLowerCase());
    const inC = c.bc.includes(c.hc);
    rep.push('#' + id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' blk=' + blocks.length + ' hlE=' + inE + ' hlC=' + inC + (c.N ? ' +NUT' : '') + ' stat=' + c.s.stat);
    if (APPLY) {
      try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
      fs.writeFileSync('backups/new_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks, nutrition: row.nutrition, colophon_character: row.colophon_character }));
      if (c.N) db.prepare("UPDATE store_products SET description_blocks=?,nutrition=?,use_block_design=1,page_template='editorial_light',colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(blocks), c.N, c.col, id);
      else db.prepare("UPDATE store_products SET description_blocks=?,use_block_design=1,page_template='editorial_light',colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(blocks), c.col, id);
      n++;
    }
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' new products ==') : '== DRY (set APPLY=1) ==');
