// Build cards for clearly single-ingredient EMPTY published products
// (coconut oils, garlic/onion powder, nutritional yeast, coconut milk).
const Database = require('better-sqlite3');
const fs = require('fs');
const APPLY = !!process.env.APPLY;
const db = new Database('data/roots.db');
const nut = (be, bc, rows) => JSON.stringify({ basis_en: be, basis_cn: bc, rows: rows.map(r => ({ label_en: r[0], label_cn: r[1], value: r[2] })) });

function storage(kind, id) {
  if (kind === 'oil') return { type: 'storage_box', left: { icon: '🫙', head_en: 'Cool & dark', head_cn: '阴凉避光', num: '', unit_en: 'No need to refrigerate', unit_cn: '无需冷藏', alt: false }, right: { icon: '❄️', head_en: 'Solidifies cold', head_cn: '低温凝固', num: '24°', unit_en: 'C — gently warm to liquefy', unit_cn: 'C 以下凝固,温热即化', alt: true }, note_en: 'Solid or liquid is normal — coconut oil sets below ~24°C.', note_cn: '凝固或液态均属正常——椰子油约24°C以下会凝固。', id: 'st' + id };
  if (kind === 'dry') return { type: 'storage_box', left: { icon: '🫙', head_en: 'Keep it dry', head_cn: '干燥存放', num: '', unit_en: 'Cool, dry, airtight', unit_cn: '阴凉干燥、密封', alt: false }, right: { icon: '📅', head_en: 'Shelf life', head_cn: '保质期', num: '12', unit_en: 'months, sealed', unit_cn: '个月（密封）', alt: true }, note_en: 'Reseal tightly after opening.', note_cn: '开封后请密封保存。', id: 'st' + id };
  if (kind === 'fridgeopen') return { type: 'storage_box', left: { icon: '🫙', head_en: 'Sealed', head_cn: '未开封', num: '', unit_en: 'Store at room temperature', unit_cn: '常温保存', alt: false }, right: { icon: '❄️', head_en: 'Once opened', head_cn: '开封后', num: '3', unit_en: 'days in the fridge', unit_cn: '天内（冷藏）', alt: true }, note_en: 'Refrigerate after opening; shake or stir before use.', note_cn: '开封后请冷藏,使用前摇匀或搅拌。', id: 'st' + id };
}
function card(c) {
  const id = c.id; const b = [];
  b.push({ type: 'spec_strip', cells: c.spec.map(x => ({ k_en: x[0], k_cn: x[1], v_en: x[2], v_cn: x[3] })), id: 'sp' + id });
  b.push({ type: 'hero_intro', kicker_en: c.k[0], kicker_cn: c.k[1], body_en: c.be, body_cn: c.bc, highlight_en: c.he, highlight_cn: c.hc, id: 'he' + id });
  b.push({ type: 'big_stat', stat: c.s.stat, what_en: c.s.cap[0], what_cn: c.s.cap[1], sub_en: c.s.sub[0], sub_cn: c.s.sub[1], bg: 'lime', id: 'bs' + id });
  b.push({ type: 'why', rows: c.why.map(w => ({ claim_en: w[0], claim_cn: w[1] })), id: 'wh' + id });
  b.push({ type: 'how_to_use', tiles: c.uses.map(u => ({ icon: u[0], label_en: u[1], label_cn: u[2], sub_en: u[3] || '', sub_cn: u[4] || '' })), id: 'hw' + id });
  b.push({ type: 'allergen_card', contains_en: c.al[0], contains_cn: c.al[1], may_contain_en: c.al[2], may_contain_cn: c.al[3], id: 'al' + id });
  b.push(storage(c.store, id));
  b.push({ type: 'notes_callout', text_en: c.note[0], text_cn: c.note[1], id: 'nt' + id });
  return b;
}
const NONE_NUT = ['None declared', '未声明常见致敏原', 'Tree nuts, soy, gluten', '坚果、大豆、麸质'];

const CFG = [
  { id: 209, col: 'broccoli', spec: [['Form', '形态', 'Cold-pressed oil', '冷压椰子油'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Cook · bake · skin', '烹饪·烘焙·护肤']], k: ['Oils', '油'],
    be: 'Extra virgin coconut oil, cold-pressed from fresh coconut — nothing refined, nothing bleached. It carries a soft coconut aroma and turns liquid above 24°C, solid below. One jar for cooking, baking, and skin.',
    bc: '初榨椰子油,从新鲜椰子冷压而成——未精炼、未漂白。带着淡淡椰香,24°C以上为液态、以下为固态。一罐在手,做饭、烘焙、护肤都行。',
    he: 'One jar for cooking, baking, and skin.', hc: '一罐在手,做饭、烘焙、护肤都行',
    s: { stat: '100%', cap: ['COCONUT · COLD-PRESSED', '纯椰子 · 冷压'], sub: ['Unrefined, unbleached.', '未精炼、未漂白。'] },
    why: [['Cold-pressed and unrefined — real coconut aroma.', '冷压未精炼,保留真实椰香。'], ['Solid or liquid depending on the room.', '随室温在固态与液态间变化。'], ['Nothing bleached, nothing added.', '不漂白、无添加。']],
    uses: [['🍳', 'Cooking', '烹饪', 'Low to medium heat', '中低温烹饪'], ['🧁', 'Baking', '烘焙', 'A 1:1 butter swap', '可1:1替代黄油'], ['🥤', 'Smoothies', '奶昔', 'A spoon for richness', '一勺更醇厚'], ['💆', 'Skin & hair', '护肤护发', 'A natural moisturizer', '天然滋润']],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '862 kcal'], ['Fat', '脂肪', '100 g'], ['Saturated fat', '饱和脂肪', '87 g'], ['Carbohydrate', '碳水化合物', '0 g'], ['Protein', '蛋白质', '0 g'], ['Sodium', '钠', '0 mg']]),
    al: NONE_NUT, store: 'oil', note: ['100% extra virgin coconut oil. Solid below ~24°C — gently warm to liquefy.', '100% 初榨椰子油。约24°C以下凝固,温热即可化开。'] },

  { id: 219, col: 'onion', spec: [['Form', '形态', 'Refined oil', '精炼椰子油'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'High-heat cooking', '高温烹饪']], k: ['Oils', '油'],
    be: 'Refined coconut oil with a clean, neutral taste and a high smoke point — built for everyday cooking and frying. No coconut flavor to get in the way. Just a steady, reliable cooking oil.',
    bc: '精炼椰子油,味道干净中性、烟点高——为日常炒煮和油炸而生。没有椰子味来干扰菜品。是一瓶稳定可靠的食用油。',
    he: 'a steady, reliable cooking oil', hc: '一瓶稳定可靠的食用油',
    s: { stat: '100%', cap: ['COCONUT · HIGH HEAT', '纯椰子 · 耐高温'], sub: ['Neutral taste, high smoke point.', '味道中性,烟点高。'] },
    why: [['High smoke point — great for frying.', '烟点高,适合煎炸。'], ['Neutral flavor, no coconut taste.', '味道中性,无椰子味。'], ['100% coconut, nothing added.', '100% 椰子油,无添加。']],
    uses: [['🍳', 'Frying', '油炸', 'Holds high heat well', '耐高温'], ['🥘', 'Stir-fry', '爆炒', 'A neutral base oil', '中性底油'], ['🧁', 'Baking', '烘焙', 'No coconut flavor', '不带椰子味'], ['🌽', 'Popcorn', '爆米花', 'A classic choice', '经典之选']],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '862 kcal'], ['Fat', '脂肪', '100 g'], ['Saturated fat', '饱和脂肪', '87 g'], ['Carbohydrate', '碳水化合物', '0 g'], ['Protein', '蛋白质', '0 g'], ['Sodium', '钠', '0 mg']]),
    al: NONE_NUT, store: 'oil', note: ['100% refined coconut oil. Neutral taste, made for high-heat cooking.', '100% 精炼椰子油。味道中性,适合高温烹饪。'] },

  { id: 223, col: 'radishes', spec: [['Form', '形态', 'Organic powder', '有机粉'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Season anything', '万物可调味']], k: ['Spices', '香料'],
    be: 'USDA organic garlic, dried and milled into a fine powder. All the savory depth of fresh garlic, none of the peeling or chopping. A pinch lifts soups, dressings, roasts, and rubs. Nothing but garlic.',
    bc: '美国USDA有机大蒜,干燥后磨成细粉。保留新鲜大蒜的醇厚鲜香,却省去剥皮和切碎。一小撮就能提升汤品、沙拉酱、烤菜和腌料。只有大蒜,别无其他。',
    he: 'Nothing but garlic.', hc: '只有大蒜,别无其他',
    s: { stat: '100%', cap: ['GARLIC · USDA ORGANIC', '纯大蒜 · USDA有机'], sub: ['Nothing added.', '无任何添加。'] },
    why: [['All the flavor, none of the chopping.', '有味道,免切剁。'], ['USDA certified organic.', '美国USDA有机认证。'], ['Just garlic — no anti-caking agents.', '只有大蒜,无抗结剂。']],
    uses: [['🍲', 'Soups & stews', '汤与炖菜', 'A savory base note', '提鲜打底'], ['🥗', 'Dressings', '沙拉酱', 'Whisk straight in', '直接拌入'], ['🔥', 'Roasts & rubs', '烤菜与腌料', 'Rub on before roasting', '烤前抹匀'], ['🍞', 'Garlic bread', '蒜香面包', 'Mix into spread', '拌入抹酱']],
    al: ['None declared', '未声明常见致敏原', 'Tree nuts, soy, gluten', '坚果、大豆、麸质'], store: 'dry', note: ['100% organic garlic powder. Keep dry and sealed; a little goes a long way.', '100% 有机大蒜粉。密封防潮,用量宜少。'] },

  { id: 217, col: 'mushroom', spec: [['Form', '形态', 'Organic powder', '有机粉'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Season anything', '万物可调味']], k: ['Spices', '香料'],
    be: 'USDA organic onion, dried and milled fine. It brings the sweet, savory backbone that onions give a dish — without the tears or the prep. Stir into sauces, soups, dips, and spice blends. Just onion.',
    bc: '美国USDA有机洋葱,干燥后磨成细粉。它带来洋葱那股甜中带鲜的底味——却不用流泪、也不用处理。拌进酱汁、汤品、蘸酱和混合香料里。只有洋葱。',
    he: 'Just onion.', hc: '只有洋葱',
    s: { stat: '100%', cap: ['ONION · USDA ORGANIC', '纯洋葱 · USDA有机'], sub: ['Nothing added.', '无任何添加。'] },
    why: [['Sweet-savory onion depth, no prep.', '甜鲜洋葱味,免处理。'], ['USDA certified organic.', '美国USDA有机认证。'], ['Just onion — no fillers.', '只有洋葱,无填充剂。']],
    uses: [['🥫', 'Sauces', '酱汁', 'Stir in for depth', '拌入增味'], ['🍲', 'Soups', '汤品', 'A savory base', '提鲜打底'], ['🥣', 'Dips', '蘸酱', 'Mix into anything creamy', '拌入各种酱底'], ['🧂', 'Spice blends', '混合香料', 'A building block', '调香基础']],
    al: ['None declared', '未声明常见致敏原', 'Tree nuts, soy, gluten', '坚果、大豆、麸质'], store: 'dry', note: ['100% organic onion powder. Keep dry and sealed.', '100% 有机洋葱粉。密封防潮保存。'] },

  { id: 156, col: 'peas', spec: [['Form', '形态', 'Flakes', '片状'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Sprinkle on top', '撒在表面']], k: ['Pantry staple', '餐橱常备'],
    be: 'Nutritional yeast — affectionately called "nooch" — is a deactivated yeast with a savory, cheesy, umami flavor that plant-based cooks swear by. Sprinkle it over pasta, popcorn, or roasted veg. It is naturally rich in protein and B vitamins.',
    bc: '营养酵母——昵称"nooch"——是一种灭活酵母,带着咸香、近似芝士的鲜味,是纯植物料理的心头好。撒在意面、爆米花或烤蔬菜上即可。它天然富含蛋白质与B族维生素。',
    he: 'savory, cheesy, umami flavor', hc: '咸香、近似芝士的鲜味',
    s: { stat: '50g', cap: ['PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克'], sub: ['A cheesy, vegan staple.', '近似芝士的纯素常备。'] },
    why: [['Savory, cheesy flavor — no dairy.', '咸香近芝士,不含乳。'], ['Naturally rich in protein and B vitamins.', '天然富含蛋白质与B族维生素。'], ['A plant-based kitchen staple.', '纯植物厨房常备。']],
    uses: [['🍝', 'On pasta', '撒意面', 'Like a vegan parmesan', '像纯素帕玛森'], ['🍿', 'On popcorn', '撒爆米花', 'Savory and moreish', '咸香上瘾'], ['🥦', 'Roasted veg', '烤蔬菜', 'A finishing sprinkle', '出锅前撒上'], ['🥣', 'Into sauces', '拌酱汁', 'For cheesy depth', '增添芝士感']],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '350 kcal'], ['Protein', '蛋白质', '50 g'], ['Fat', '脂肪', '5 g'], ['Carbohydrate', '碳水化合物', '35 g'], ['Dietary fiber', '膳食纤维', '20 g'], ['Sodium', '钠', '30 mg']]),
    al: ['None declared', '未声明常见致敏原', 'Gluten, soy, tree nuts', '麸质、大豆、坚果'], store: 'dry', note: ['100% nutritional yeast flakes. Keep dry and sealed.', '100% 营养酵母片。密封防潮保存。'] },

  { id: 167, col: 'hula', spec: [['Form', '形态', 'Canned milk', '罐装椰浆'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Cook · curry · blend', '烹饪·咖喱·打浆']], k: ['Plant Milks', '植物奶'],
    be: 'Coconut milk the way it should be — just coconut and water, with no xanthan gum and no guar gum. Rich and creamy for curries, soups, and desserts, or thinned for drinks. Shake well; natural separation is normal.',
    bc: '椰浆本该有的样子——只有椰子和水,不加黄原胶、也不加瓜尔胶。浓郁顺滑,适合咖喱、汤品和甜点,稀释后也能做饮品。使用前摇匀;天然分层属正常现象。',
    he: 'no xanthan gum and no guar gum', hc: '不加黄原胶、也不加瓜尔胶',
    s: { stat: '0', cap: ['GUMS & STABILIZERS', '零胶质与稳定剂'], sub: ['Just coconut and water.', '只有椰子和水。'] },
    why: [['No xanthan or guar gum — just coconut.', '不加黄原胶或瓜尔胶,只有椰子。'], ['Rich and creamy for curries and soups.', '浓郁顺滑,咖喱汤品皆宜。'], ['Dairy-free and plant-based.', '不含乳,纯植物。']],
    uses: [['🍛', 'Curries', '咖喱', 'A creamy base', '顺滑底料'], ['🍲', 'Soups', '汤品', 'Adds body and richness', '增添浓度'], ['🍮', 'Desserts', '甜点', 'Puddings and ice cream', '布丁与冰淇淋'], ['🥤', 'Drinks', '饮品', 'Thin with water', '加水稀释']],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '197 kcal'], ['Fat', '脂肪', '21 g'], ['Saturated fat', '饱和脂肪', '18 g'], ['Carbohydrate', '碳水化合物', '3 g'], ['Protein', '蛋白质', '2 g'], ['Sodium', '钠', '15 mg']]),
    al: ['None declared', '未声明常见致敏原', 'Tree nuts', '坚果'], store: 'fridgeopen', note: ['Just coconut and water — no gums or stabilizers. Refrigerate after opening.', '只有椰子和水——无胶质或稳定剂。开封后请冷藏。'] },
];

let n = 0; const rep = [];
for (const c of CFG) {
  const row = db.prepare("SELECT name_en,description_blocks,nutrition,colophon_character FROM store_products WHERE id=?").get(c.id);
  if (!row) { rep.push('!! MISSING ' + c.id); continue; }
  const blocks = card(c);
  const inE = c.be.toLowerCase().includes(c.he.toLowerCase());
  const inC = c.bc.includes(c.hc);
  rep.push('#' + c.id + ' ' + (row.name_en || '').slice(0, 26).padEnd(27) + ' blocks=' + blocks.length + ' hlE=' + inE + ' hlC=' + inC + (c.N ? ' +NUT' : '') + ' stat=' + c.s.stat);
  if (APPLY) {
    try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
    fs.writeFileSync('backups/empty_' + c.id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks, nutrition: row.nutrition, colophon_character: row.colophon_character }));
    if (c.N) db.prepare("UPDATE store_products SET description_blocks=?,nutrition=?,use_block_design=1,page_template='editorial_light',colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(blocks), c.N, c.col, c.id);
    else db.prepare("UPDATE store_products SET description_blocks=?,use_block_design=1,page_template='editorial_light',colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(blocks), c.col, c.id);
    n++;
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' empties ==') : '== DRY (set APPLY=1) ==');
