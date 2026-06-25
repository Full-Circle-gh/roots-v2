// Build single-ingredient "raw product" cards (legumes, nuts, seeds, grains).
// Run on prod via:  base64 -w0 scripts/_raw_build.js | ssh ... "cd /root/roots-v2 && base64 -d | SUB=legume APPLY=1 node -"
// SUB filters which subtype to process (legume|nut|seed|grain|all). APPLY=1 writes; otherwise dry-run.
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('data/roots.db');
const APPLY = !!process.env.APPLY;
const SUB = process.env.SUB || 'all';

const nut = (be, bc, rows) => JSON.stringify({ basis_en: be, basis_cn: bc, rows: rows.map(r => ({ label_en: r[0], label_cn: r[1], value: r[2] })) });

function storage(kind, id) {
  if (kind === 'dry') return { type: 'storage_box',
    left:  { icon: '🫙', head_en: 'Keep it dry', head_cn: '干燥存放', num: '', unit_en: 'Cool, dry, airtight — away from sunlight', unit_cn: '阴凉干燥、密封,避免阳光直射', alt: false },
    right: { icon: '📅', head_en: 'Shelf life',  head_cn: '保质期',   num: '12', unit_en: 'months, sealed', unit_cn: '个月（密封）', alt: true },
    note_en: 'Reseal tightly after opening.', note_cn: '开封后请密封保存。', id: 'st' + id };
  if (kind === 'nut') return { type: 'storage_box',
    left:  { icon: '🫙', head_en: 'Cool & dry', head_cn: '阴凉干燥', num: '', unit_en: 'Airtight, away from heat & light', unit_cn: '密封,避免高温与阳光', alt: false },
    right: { icon: '❄️', head_en: 'To keep longer', head_cn: '延长保鲜', num: '', unit_en: 'Refrigerate or freeze — the oils stay fresh', unit_cn: '冷藏或冷冻——油脂更不易氧化', alt: true },
    note_en: 'Naturally high in oils — chilling keeps them fresh and crunchy.', note_cn: '天然油脂丰富——冷藏冷冻能更好保持新鲜与香脆。', id: 'st' + id };
  return null;
}

function card(c, id) {
  const b = [];
  b.push({ type: 'spec_strip', cells: c.spec.map(x => ({ k_en: x[0], k_cn: x[1], v_en: x[2], v_cn: x[3] })), id: 'sp' + id });
  b.push({ type: 'hero_intro', kicker_en: c.k[0], kicker_cn: c.k[1], body_en: c.be, body_cn: c.bc, highlight_en: c.he, highlight_cn: c.hc, id: 'he' + id });
  const _s = STATS[id]; if (_s) b.push({ type: 'big_stat', stat: _s.stat, what_en: _s.cap[0], what_cn: _s.cap[1], sub_en: _s.sub[0], sub_cn: _s.sub[1], bg: 'lime', id: 'bs' + id });
  b.push({ type: 'why', rows: c.why.map(w => ({ claim_en: w[0], claim_cn: w[1] })), id: 'wh' + id });
  if (c.cook) b.push({ type: 'recipe_steps', title_en: c.cook.t[0], title_cn: c.cook.t[1], steps: c.cook.s.map(s => ({ text_en: s[0], text_cn: s[1], time_en: s[2] || '', time_cn: s[3] || '' })), id: 'rc' + id });
  if (c.uses) b.push({ type: 'how_to_use', tiles: c.uses.map(u => ({ icon: u[0], label_en: u[1], label_cn: u[2], sub_en: u[3] || '', sub_cn: u[4] || '' })), id: 'hw' + id });
  b.push({ type: 'allergen_card', contains_en: c.al[0], contains_cn: c.al[1], may_contain_en: c.al[2], may_contain_cn: c.al[3], id: 'al' + id });
  b.push(storage(c.store, id));
  b.push({ type: 'notes_callout', text_en: c.note[0], text_cn: c.note[1], id: 'nt' + id });
  return b;
}

const SPEC_SOAK = [['Form', '形态', 'Dried · raw', '干豆 · 生'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Soak & cook', '泡发后烹煮']];
const SPEC_NOSOAK = [['Form', '形态', 'Dried · raw', '干豆 · 生'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'No soak needed', '无需浸泡']];
const ALL_FACILITY = ['None declared', '未声明常见致敏原', 'Tree nuts, Soy, Gluten', '坚果、大豆、麸质'];
const SPEC_NUT_WHOLE = [['Form', '形态', 'Raw · whole', '生 · 整粒'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Snack · bake · blend', '直接吃·烘焙·打浆']];
const SPEC_NUT_SLICED = [['Form', '形态', 'Raw · sliced', '生 · 切片'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Top · toast · bake', '点缀·烤香·烘焙']];
const ALN = (en, cn) => ['Tree nuts (' + en + ')', '坚果（' + cn + '）', 'Peanuts, other tree nuts, soy, gluten', '花生、其他坚果、大豆、麸质'];
const SPEC_SEED = [['Form', '形态', 'Raw seeds', '生 · 籽'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Sprinkle · blend · soak', '撒·打浆·泡发']];
const SPEC_SEED_HULLED = [['Form', '形态', 'Hulled · ready to eat', '脱壳 · 即食'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Sprinkle · blend', '撒·打浆']];
const SPEC_GRAIN = [['Form', '形态', 'Raw · dry', '生 · 干'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Rinse & cook', '冲洗后烹煮']];
const SPEC_OATS = [['Form', '形态', 'Whole rolled', '整粒压片'], ['Diet', '饮食', '100% plant', '纯植物'], ['Use', '用法', 'Cook in minutes', '几分钟煮好']];

// Big-stat per product: the single hero number. cap = caps caption, sub = italic line.
const PROT100 = ['PLANT PROTEIN · PER 100G', '植物蛋白 · 每100克'];
const SUB_PROT = ['Plant protein, nothing else.', '植物蛋白,别无他物。'];
const FIBER100 = ['FIBER · PER 100G', '膳食纤维 · 每100克'];
const OMEGA100 = ['OMEGA-3 · PER 100G', 'Omega-3 · 每100克'];
const SUB_OMEGA = ['Plant-based omega-3.', '植物来源 Omega-3。'];
const STATS = {
  149: { stat: '20g', cap: PROT100, sub: SUB_PROT },
  118: { stat: '25g', cap: PROT100, sub: SUB_PROT },
  159: { stat: '24g', cap: PROT100, sub: SUB_PROT },
  158: { stat: '21g', cap: PROT100, sub: SUB_PROT },
  274: { stat: '21g', cap: PROT100, sub: ['Raw, unsalted, whole.', '生杏仁,无盐,完整。'] },
  275: { stat: '21g', cap: PROT100, sub: ['Raw, unsalted, whole.', '生杏仁,无盐,完整。'] },
  276: { stat: '18g', cap: PROT100, sub: ['The dairy-free cream base.', '无奶的绵密基底。'] },
  277: { stat: '18g', cap: PROT100, sub: ['The dairy-free cream base.', '无奶的绵密基底。'] },
  273: { stat: '9g', cap: OMEGA100, sub: SUB_OMEGA },
  272: { stat: '9g', cap: OMEGA100, sub: SUB_OMEGA },
  125: { stat: '21g', cap: PROT100, sub: ['Raw, unsalted, sliced.', '生杏仁片,无盐。'] },
  278: { stat: '34g', cap: FIBER100, sub: ['Gut-friendly fiber.', '对肠胃友好的纤维。'] },
  279: { stat: '34g', cap: FIBER100, sub: ['Gut-friendly fiber.', '对肠胃友好的纤维。'] },
  192: { stat: '22g', cap: OMEGA100, sub: SUB_OMEGA },
  154: { stat: '32g', cap: ['COMPLETE PROTEIN · PER 100G', '完整蛋白 · 每100克'], sub: ['All nine amino acids.', '九种必需氨基酸齐全。'] },
  123: { stat: '30g', cap: PROT100, sub: ['Magnesium, zinc & iron.', '富含镁、锌、铁。'] },
  180: { stat: '100%', cap: ['WHOLE GRAIN', '全谷物'], sub: ['Nothing stripped away.', '未精磨,全保留。'] },
  127: { stat: '9', cap: ['ESSENTIAL AMINO ACIDS', '种必需氨基酸'], sub: ['A complete protein.', '完整的蛋白质。'] },
  181: { stat: '10g', cap: FIBER100, sub: ['Gut-friendly oat fiber.', '对肠胃友好的燕麦纤维。'] },
  150: { stat: '10g', cap: FIBER100, sub: ['Gut-friendly oat fiber.', '对肠胃友好的燕麦纤维。'] },
};

const CFG = [
  // ───────── LEGUMES ─────────
  { sub: 'legume', ids: [149], col: 'onion', spec: SPEC_SOAK, k: ['Pantry staple', '餐橱常备'],
    be: "Chickpeas are the workhorse of the pantry. Nutty and a little buttery, they soak overnight and simmer into hummus, curries, salads, or roasted snacks. One bag, a dozen meals.",
    bc: "鹰嘴豆是餐橱里最能干的一员。带点坚果香、口感微微绵密,泡发一晚、慢慢煮软,就能做成鹰嘴豆泥、咖喱、沙拉,或烤成香脆小食。一袋豆子，十几种吃法。",
    he: "One bag, a dozen meals.", hc: "一袋豆子，十几种吃法",
    why: [["High in plant protein and fiber — keeps you full.", "高蛋白、高纤维，饱腹感强。"], ["Just the bean — no salt, no additives.", "只有豆子本身——无盐、无添加。"], ["Endlessly versatile: hummus, curry, salad, roast.", "百搭:鹰嘴豆泥、咖喱、沙拉、烘烤皆可。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '378 kcal'], ['Protein', '蛋白质', '20 g'], ['Fat', '脂肪', '6 g'], ['Carbohydrate', '碳水化合物', '63 g'], ['Dietary fiber', '膳食纤维', '12 g'], ['Sodium', '钠', '24 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse, then soak overnight in plenty of water.", "冲洗后,加足量清水浸泡一晚。", "8h+", "8小时+"], ["Drain, cover with fresh water, bring to a boil.", "沥干,换清水没过豆子,大火煮开。"], ["Simmer until tender, about 45–60 min.", "转小火煮至软糯,约45–60分钟。", "45–60 min", "45–60分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% chickpeas, nothing added. Rinse before cooking.", "100% 鹰嘴豆,无任何添加。烹煮前请冲洗。"] },

  { sub: 'legume', ids: [118], col: 'peas', spec: SPEC_NOSOAK, k: ['Pantry staple', '餐橱常备'],
    be: "Green lentils hold their shape — a firm, peppery bite that doesn't turn to mush. No soaking needed; they go from bag to pot to plate in about half an hour. Quietly one of the most useful things in the kitchen.",
    bc: "绿扁豆久煮不烂,口感扎实、带一点胡椒般的微辛。无需浸泡,从袋子到锅里再到餐盘，大约半小时就能搞定。它是厨房里最低调好用的食材之一。",
    he: "bag to pot to plate", hc: "从袋子到锅里再到餐盘",
    why: [["Holds its shape — great in salads and stews.", "久煮不烂,适合沙拉与炖菜。"], ["No soaking — ready in about 30 minutes.", "无需浸泡,约30分钟即可。"], ["Plant protein and fiber, nothing added.", "植物蛋白与纤维,无任何添加。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '352 kcal'], ['Protein', '蛋白质', '25 g'], ['Fat', '脂肪', '1 g'], ['Carbohydrate', '碳水化合物', '60 g'], ['Dietary fiber', '膳食纤维', '11 g'], ['Sodium', '钠', '6 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse well — no soaking needed.", "冲洗干净——无需浸泡。"], ["Add about 3 cups water per cup of lentils, boil.", "每杯扁豆加约3杯水,大火煮开。"], ["Simmer 20–30 min until tender.", "小火煮20–30分钟至软。", "20–30 min", "20–30分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% green lentils. Rinse before cooking; no soaking needed.", "100% 绿扁豆。烹煮前冲洗,无需浸泡。"] },

  { sub: 'legume', ids: [159], col: 'radishes', spec: SPEC_NOSOAK, k: ['Pantry staple', '餐橱常备'],
    be: "Red lentils cook down fast and creamy — perfect for dals, soups, and quick weeknight curries. They break down as they simmer, thickening the pot on their own. Twenty minutes, no soaking, dinner's halfway there.",
    bc: "红扁豆煮得快、容易软烂出沙——做扁豆糊、汤品或快手咖喱最合适。一边煮一边自然化开,汤会变浓稠。二十分钟、不用泡发，一顿饭就成功了一半。",
    he: "Twenty minutes, no soaking", hc: "二十分钟、不用泡发",
    why: [["Cooks creamy in ~20 min, no soaking.", "约20分钟煮至软烂,无需浸泡。"], ["Thickens soups and dals naturally.", "自然让汤品、扁豆糊更浓稠。"], ["Plant protein and fiber, just the lentil.", "植物蛋白与纤维,只有扁豆本身。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '358 kcal'], ['Protein', '蛋白质', '24 g'], ['Fat', '脂肪', '2 g'], ['Carbohydrate', '碳水化合物', '63 g'], ['Dietary fiber', '膳食纤维', '11 g'], ['Sodium', '钠', '6 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse well — no soaking needed.", "冲洗干净——无需浸泡。"], ["Add about 3 cups water per cup of lentils, boil.", "每杯扁豆加约3杯水,大火煮开。"], ["Simmer 15–20 min until soft and creamy.", "小火煮15–20分钟至软烂出沙。", "15–20 min", "15–20分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% red lentils. Rinse before cooking; no soaking needed.", "100% 红扁豆。烹煮前冲洗,无需浸泡。"] },

  { sub: 'legume', ids: [158], col: 'mushroom', spec: SPEC_SOAK, k: ['Pantry staple', '餐橱常备'],
    be: "Black beans are dense, satisfying, and faintly sweet — the backbone of tacos, chili, and grain bowls. Soak overnight, then simmer until creamy inside with a skin that still holds. Hearty enough to make a meal on their own.",
    bc: "黑豆扎实、有饱腹感,带一丝隐隐的甜——是塔可、辣豆酱和谷物碗的主心骨。泡发一晚,煮到内里绵软、豆皮依旧完整。分量十足,单吃也能当一餐。",
    he: "Hearty enough to make a meal on their own.", hc: "单吃也能当一餐",
    why: [["Filling plant protein and fiber.", "高饱腹的植物蛋白与纤维。"], ["Creamy inside, holds its shape.", "内里绵软,豆形完整。"], ["Tacos, chili, bowls, soups.", "塔可、辣酱、碗餐、汤品皆宜。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '341 kcal'], ['Protein', '蛋白质', '21 g'], ['Fat', '脂肪', '1.4 g'], ['Carbohydrate', '碳水化合物', '62 g'], ['Dietary fiber', '膳食纤维', '16 g'], ['Sodium', '钠', '5 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse, then soak overnight in plenty of water.", "冲洗后,加足量清水浸泡一晚。", "8h+", "8小时+"], ["Drain, cover with fresh water, bring to a boil.", "沥干,换清水没过豆子,大火煮开。"], ["Simmer 60–90 min until tender.", "小火煮60–90分钟至软糯。", "60–90 min", "60–90分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% black beans, nothing added. Rinse before cooking.", "100% 黑豆,无任何添加。烹煮前请冲洗。"] },

  // ───────── NUTS ─────────
  { sub: 'nut', ids: [274, 275], col: 'flex', spec: SPEC_NUT_WHOLE, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Raw almonds, just as they are — firm, sweet, and clean-tasting. Snack them by the handful, slice them over oats, blend them into almond milk, or roast them with a pinch of salt. Nothing added, nothing roasted off.",
    bc: "生杏仁,原汁原味——质地扎实、自然回甜、口感干净。可以直接抓一把当零食,切片撒在燕麦上,打成杏仁奶,或加一撮盐烤香。没有添加,也没有过度加工。",
    he: "Nothing added, nothing roasted off.", hc: "没有添加,也没有过度加工",
    why: [["A good source of vitamin E and healthy fats.", "富含维生素E与健康脂肪。"], ["Plant protein and fiber in every handful.", "每一把都有植物蛋白与纤维。"], ["Raw and unsalted — you decide how to use them.", "生杏仁、无盐——怎么用你说了算。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '579 kcal'], ['Protein', '蛋白质', '21 g'], ['Fat', '脂肪', '50 g'], ['Carbohydrate', '碳水化合物', '22 g'], ['Dietary fiber', '膳食纤维', '12.5 g'], ['Sodium', '钠', '1 mg']]),
    uses: [['🥄', 'Snack', '直接吃', 'By the handful, raw or roasted', '生吃或烤香'], ['🥛', 'Almond milk', '杏仁奶', 'Soak + blend with water', '泡发后加水打浆'], ['🥣', 'Over oats', '拌燕麦', 'Slice or chop on top', '切片或切碎撒上'], ['🍪', 'Baking', '烘焙', 'Cookies, cakes, granola', '饼干、蛋糕、燕麦脆']],
    al: ALN('almonds', '杏仁'), store: 'nut', note: ["100% raw almonds — unsalted, unroasted. Refrigerate to keep them fresh.", "100% 生杏仁——无盐、未烘烤。冷藏可更好保鲜。"] },

  { sub: 'nut', ids: [276, 277], col: 'hula', spec: SPEC_NUT_WHOLE, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Raw cashews are soft, creamy, and mildly sweet — the secret behind so many plant-based sauces. Blend them into cheese, cream, or dressings, soak them for desserts, or just snack them straight from the bag.",
    bc: "生腰果柔软、绵密、淡淡回甜——许多纯植物酱汁背后的秘密。可以打成素芝士、奶油或酱汁,泡发后做甜点,也可以直接当零食。",
    he: "the secret behind so many plant-based sauces", hc: "许多纯植物酱汁背后的秘密",
    why: [["Creamy base for plant cheese, cream & sauces.", "素芝士、奶油、酱汁的绵密基底。"], ["Soft enough to blend smooth after soaking.", "泡发后可打到顺滑。"], ["Raw and unsalted, nothing added.", "生腰果、无盐,无任何添加。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '553 kcal'], ['Protein', '蛋白质', '18 g'], ['Fat', '脂肪', '44 g'], ['Carbohydrate', '碳水化合物', '30 g'], ['Dietary fiber', '膳食纤维', '3.3 g'], ['Sodium', '钠', '12 mg']]),
    uses: [['🧀', 'Cashew cheese', '素芝士', 'Soak + blend with lemon & salt', '泡发加柠檬与盐打浆'], ['🥛', 'Cashew cream', '腰果奶油', 'Blend smooth for sauces', '打成顺滑奶油酱'], ['🥗', 'Dressings', '沙拉酱', 'Creamy base, no dairy', '无奶的绵密酱底'], ['🥄', 'Snack', '直接吃', 'Straight from the bag', '直接当零食']],
    al: ALN('cashews', '腰果'), store: 'nut', note: ["100% raw cashews — unsalted. Soak 2–4 h for the smoothest blend.", "100% 生腰果——无盐。泡发2–4小时打浆最顺滑。"] },

  { sub: 'nut', ids: [273, 272], col: 'skater', spec: SPEC_NUT_WHOLE, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Walnuts bring a rich, buttery crunch with a gentle bitterness that balances sweet and savory alike. Toss them into salads, fold them into baking, or eat them as they are. One of the few nuts rich in plant-based omega-3.",
    bc: "核桃口感丰润、酥脆,带一点恰到好处的微苦,甜咸都能搭。撒进沙拉、揉进烘焙,或直接吃。它是少数富含植物性 Omega-3 的坚果之一。",
    he: "rich in plant-based omega-3", hc: "少数富含植物性 Omega-3 的坚果之一",
    why: [["Rich in plant-based omega-3 fats.", "富含植物性 Omega-3 脂肪。"], ["Buttery crunch for salads, baking, snacking.", "酥脆丰润,沙拉、烘焙、零食皆宜。"], ["Raw and unsalted — just the nut.", "生核桃、无盐——只有坚果本身。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '654 kcal'], ['Protein', '蛋白质', '15 g'], ['Fat', '脂肪', '65 g'], ['Omega-3 (ALA)', 'Omega-3（ALA）', '9 g'], ['Carbohydrate', '碳水化合物', '14 g'], ['Dietary fiber', '膳食纤维', '6.7 g'], ['Sodium', '钠', '2 mg']]),
    uses: [['🥗', 'In salads', '拌沙拉', 'Toasted, roughly chopped', '烤香后切碎'], ['🍪', 'Baking', '烘焙', 'Brownies, breads, cookies', '布朗尼、面包、饼干'], ['🥣', 'Over oats', '拌燕麦', 'Crunch on breakfast', '早餐里的酥脆'], ['🥄', 'Snack', '直接吃', 'By the handful', '直接抓一把']],
    al: ALN('walnuts', '核桃'), store: 'nut', note: ["100% raw walnuts — unsalted. Refrigerate or freeze to keep the oils fresh.", "100% 生核桃——无盐。冷藏或冷冻可保持油脂新鲜。"] },

  { sub: 'nut', ids: [125], col: 'broccoli', spec: SPEC_NUT_SLICED, k: ['Nuts & Seeds', '坚果与籽'],
    be: "The same clean, sweet almonds — just thinly sliced and ready to scatter. They toast in seconds and add instant crunch to oats, salads, pastries, and stir-fries. No prep, all texture.",
    bc: "和整粒一样干净回甜的杏仁——只是切成了薄片,随手一撒即可。几秒就能烤香,给燕麦、沙拉、糕点和小炒带来即时的酥脆。免处理,全是口感。",
    he: "No prep, all texture.", hc: "免处理,全是口感",
    why: [["Pre-sliced — instant crunch, zero prep.", "已切片——即时酥脆,免处理。"], ["Toasts in seconds to top anything.", "几秒烤香,百搭点缀。"], ["Raw and unsalted, just almonds.", "生杏仁、无盐,只有杏仁。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '579 kcal'], ['Protein', '蛋白质', '21 g'], ['Fat', '脂肪', '50 g'], ['Carbohydrate', '碳水化合物', '22 g'], ['Dietary fiber', '膳食纤维', '12.5 g'], ['Sodium', '钠', '1 mg']]),
    uses: [['🥣', 'Over oats', '拌燕麦', 'Toasted on top', '烤香后撒上'], ['🥗', 'On salads', '撒沙拉', 'Light, crunchy finish', '清爽酥脆收尾'], ['🥐', 'Baking', '烘焙', 'Pastries, cakes, granola', '糕点、蛋糕、燕麦脆'], ['🔥', 'Toast first', '先烤香', '30–60s in a dry pan', '干锅30–60秒']],
    al: ALN('almonds', '杏仁'), store: 'nut', note: ["100% raw sliced almonds — unsalted. Toast lightly to bring out the flavor.", "100% 生杏仁片——无盐。轻烤更香。"] },

  // ───────── SEEDS ─────────
  { sub: 'seed', ids: [278, 279], col: 'onion', spec: SPEC_SEED, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Tiny seeds with a big trick — chia soaks up to ten times its weight in liquid and turns into a soft, spoonable gel. Stir into oats, blend into smoothies, or whisk with plant milk overnight for an easy pudding. A little goes a long way.",
    bc: "小小的种子,本事不小——奇亚籽能吸收自身约十倍的水分,变成柔软可舀的凝胶。拌进燕麦、加进奶昔,或与植物奶一起冷藏一夜做成布丁。用一点点,就很顶用。",
    he: "A little goes a long way.", hc: "用一点点,就很顶用",
    why: [["High in fiber and plant-based omega-3.", "高纤维,富含植物性 Omega-3。"], ["Thickens puddings, smoothies, and jams.", "让布丁、奶昔、果酱自然变稠。"], ["No cooking — just soak or sprinkle.", "无需烹煮——泡发或直接撒。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '486 kcal'], ['Protein', '蛋白质', '17 g'], ['Fat', '脂肪', '31 g'], ['Carbohydrate', '碳水化合物', '42 g'], ['Dietary fiber', '膳食纤维', '34 g'], ['Sodium', '钠', '16 mg']]),
    uses: [['🍮', 'Chia pudding', '奇亚布丁', 'Soak overnight in plant milk', '植物奶中冷藏一夜'], ['🥤', 'Smoothies', '奶昔', 'Blend in for body', '打进去增加口感'], ['🥣', 'Over oats', '拌燕麦', 'Sprinkle on top', '直接撒上'], ['🍓', 'Quick jam', '快手果酱', 'Thickens mashed fruit', '让果泥变浓稠']],
    al: ALL_FACILITY, store: 'nut', note: ["100% chia seeds. Soak before eating large amounts, and drink water alongside.", "100% 奇亚籽。大量食用前先泡发,并搭配足量饮水。"] },

  { sub: 'seed', ids: [192], col: 'radishes', spec: SPEC_SEED, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Golden flaxseed has a mild, nutty taste and the same nutrition as brown flax — just lighter in color. Grind it fresh to unlock the omega-3s, then stir into oats, smoothies, or baking. It also makes a simple egg replacer.",
    bc: "黄金亚麻籽味道温和、带坚果香,营养与棕色亚麻籽相同,只是颜色更浅。现磨更能释放 Omega-3,拌进燕麦、奶昔或烘焙都合适。它还能当作简单的鸡蛋替代。",
    he: "It also makes a simple egg replacer.", hc: "它还能当作简单的鸡蛋替代",
    why: [["Plant-based omega-3 and fiber.", "植物性 Omega-3 与膳食纤维。"], ["Grind fresh for the most benefit.", "现磨吸收更好。"], ["A spoon + water = a vegan egg replacer.", "一勺加水=纯素鸡蛋替代。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '534 kcal'], ['Protein', '蛋白质', '18 g'], ['Fat', '脂肪', '42 g'], ['Omega-3 (ALA)', 'Omega-3（ALA）', '22 g'], ['Carbohydrate', '碳水化合物', '29 g'], ['Dietary fiber', '膳食纤维', '27 g'], ['Sodium', '钠', '30 mg']]),
    uses: [['🥣', 'In oats', '拌燕麦', 'Ground, stirred in', '磨碎后拌入'], ['🥚', 'Egg replacer', '鸡蛋替代', '1 tbsp ground + 3 tbsp water', '1勺磨碎+3勺水'], ['🥤', 'Smoothies', '奶昔', 'A spoon for fiber', '一勺增加纤维'], ['🍞', 'Baking', '烘焙', 'Breads and muffins', '面包与马芬']],
    al: ALL_FACILITY, store: 'nut', note: ["100% golden flaxseed. Grind before use and refrigerate to keep fresh.", "100% 黄金亚麻籽。使用前磨碎,冷藏保鲜。"] },

  { sub: 'seed', ids: [154], col: 'peas', spec: SPEC_SEED_HULLED, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Hulled hemp seeds are soft, nutty, and ready to eat — no soaking, no grinding. They carry a complete plant protein with all nine essential amino acids, so a couple of spoonfuls go a long way on oats, salads, or smoothies.",
    bc: "脱壳火麻仁柔软、带坚果香,开袋即食——无需泡发,也无需研磨。它是完整的植物蛋白,含全部九种必需氨基酸,撒一两勺在燕麦、沙拉或奶昔上就很够。",
    he: "a complete plant protein with all nine essential amino acids", hc: "完整的植物蛋白,含全部九种必需氨基酸",
    why: [["Complete protein — all nine essential amino acids.", "完整蛋白——九种必需氨基酸齐全。"], ["Soft and ready to eat, no prep.", "柔软即食,免处理。"], ["Nutty topping for oats, salads, smoothies.", "坚果香,撒燕麦、沙拉、奶昔都好。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '553 kcal'], ['Protein', '蛋白质', '32 g'], ['Fat', '脂肪', '49 g'], ['Carbohydrate', '碳水化合物', '9 g'], ['Dietary fiber', '膳食纤维', '4 g'], ['Sodium', '钠', '5 mg']]),
    uses: [['🥣', 'Over oats', '拌燕麦', 'A spoonful on top', '撒一勺'], ['🥗', 'On salads', '撒沙拉', 'Soft, nutty crunch', '柔软坚果香'], ['🥤', 'Smoothies', '奶昔', 'Protein boost', '增加蛋白'], ['🥄', 'Straight', '直接吃', 'By the spoonful', '直接吃一勺']],
    al: ALL_FACILITY, store: 'nut', note: ["100% hulled hemp seeds. Refrigerate after opening to keep fresh.", "100% 脱壳火麻仁。开封后冷藏保鲜。"] },

  { sub: 'seed', ids: [123], col: 'mushroom', spec: SPEC_SEED, k: ['Nuts & Seeds', '坚果与籽'],
    be: "Raw pumpkin seeds — pepitas — are flat, green, and quietly addictive. Toast them with a little salt for a snack, scatter them over soups and salads for crunch, or blend them into a green seed butter. Unsalted, so you're in charge.",
    bc: "生南瓜子（pepitas）扁扁的、绿绿的,越吃越上瘾。加一点盐烤香当零食,撒在汤品和沙拉上添酥脆,或打成绿色的籽酱。无盐,口味你来定。",
    he: "Unsalted, so you're in charge.", hc: "无盐,口味你来定",
    why: [["A good source of magnesium, zinc, and iron.", "富含镁、锌、铁。"], ["Plant protein with a satisfying crunch.", "植物蛋白,口感酥脆。"], ["Raw and unsalted — toast them your way.", "生的、无盐——按你喜欢的方式烤。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '559 kcal'], ['Protein', '蛋白质', '30 g'], ['Fat', '脂肪', '49 g'], ['Carbohydrate', '碳水化合物', '11 g'], ['Dietary fiber', '膳食纤维', '6 g'], ['Sodium', '钠', '7 mg']]),
    uses: [['🔥', 'Toast', '烤香', 'With a little salt', '加一点盐'], ['🥗', 'On salads', '撒沙拉', 'Green crunch', '绿色酥脆'], ['🍲', 'Over soup', '撒汤上', 'Texture on top', '增加口感'], ['🥄', 'Snack', '直接吃', 'By the handful', '直接抓一把']],
    al: ALL_FACILITY, store: 'nut', note: ["100% raw pumpkin seeds — unsalted. Toast for the best flavor.", "100% 生南瓜子——无盐。烤香风味更佳。"] },

  // ───────── GRAINS ─────────
  { sub: 'grain', ids: [180], col: 'hula', spec: SPEC_GRAIN, k: ['Grains', '谷物'],
    be: "Long-grain brown rice keeps its bran, so it cooks up with a firmer, nuttier bite than white rice — and more fiber to go with it. Rinse, simmer, and let it steam; it holds its shape under curries, stir-fries, and bowls. Whole grain, nothing stripped away.",
    bc: "长粒糙米保留了麸皮,所以比白米口感更扎实、更有坚果香,纤维也更多。冲洗、煮、再焖一会儿;盖在咖喱、小炒或谷物碗下面都不易软塌。全谷物,没有被磨掉的部分。",
    he: "Whole grain, nothing stripped away.", hc: "全谷物,没有被磨掉的部分",
    why: [["Whole grain — more fiber than white rice.", "全谷物——比白米纤维更多。"], ["Firm, nutty bite that holds its shape.", "扎实坚果香,粒粒分明。"], ["Just rice, nothing added.", "只有米,无任何添加。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '367 kcal'], ['Protein', '蛋白质', '8 g'], ['Fat', '脂肪', '3 g'], ['Carbohydrate', '碳水化合物', '76 g'], ['Dietary fiber', '膳食纤维', '3.5 g'], ['Sodium', '钠', '5 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse until the water runs clear.", "冲洗至水变清。"], ["Add about 2 cups water per cup of rice, boil.", "每杯米加约2杯水,大火煮开。"], ["Cover, simmer 35–40 min, then rest 10 min.", "加盖小火煮35–40分钟,再焖10分钟。", "35–40 min", "35–40分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% long-grain brown rice. Rinse before cooking.", "100% 长粒糙米。烹煮前请冲洗。"] },

  { sub: 'grain', ids: [127], col: 'flex', spec: SPEC_GRAIN, k: ['Grains', '谷物'],
    be: "A blend of white, red, and black quinoa — fluffy, with a gentle pop and a light nutty flavor. It's a complete plant protein, cooks in about 15 minutes, and works hot or cold, as a base or a side. Rinse first to keep it from tasting bitter.",
    bc: "白、红、黑三色藜麦的混合——煮后蓬松,带一点点爆口感和淡淡坚果香。它是完整的植物蛋白,约15分钟即熟,冷热皆宜,当主食或配菜都行。煮前先冲洗,可去掉天然的微苦。",
    he: "It's a complete plant protein", hc: "它是完整的植物蛋白",
    why: [["Complete plant protein, naturally gluten-free.", "完整植物蛋白,天然无麸质。"], ["Cooks in about 15 minutes.", "约15分钟即熟。"], ["Works hot or cold, base or side.", "冷热皆宜,主食配菜都行。"]],
    N: nut('Per 100g (dry)', '每100克（干）', [['Energy', '能量', '368 kcal'], ['Protein', '蛋白质', '14 g'], ['Fat', '脂肪', '6 g'], ['Carbohydrate', '碳水化合物', '64 g'], ['Dietary fiber', '膳食纤维', '7 g'], ['Sodium', '钠', '5 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Rinse well to remove the natural bitterness.", "充分冲洗,去除天然微苦。"], ["Add about 2 cups water per cup of quinoa, boil.", "每杯藜麦加约2杯水,大火煮开。"], ["Cover, simmer 15 min, then fluff with a fork.", "加盖小火煮15分钟,再用叉子拨松。", "15 min", "15分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% quinoa blend. Always rinse before cooking.", "100% 混合藜麦。烹煮前务必冲洗。"] },

  { sub: 'grain', ids: [181], col: 'broccoli', spec: SPEC_OATS, k: ['Grains', '谷物'],
    be: "Rolled whole oats — the old-fashioned kind, steamed and pressed but never cut fine. They keep a hearty, chewy texture and take about five minutes on the stove. The honest base for porridge, overnight oats, granola, and baking.",
    bc: "传统燕麦片——整粒燕麦蒸压而成,没有切得太碎。口感扎实有嚼劲,炉火上大约五分钟就好。是燕麦粥、隔夜燕麦、燕麦脆和烘焙最实在的基底。",
    he: "The honest base for porridge, overnight oats, granola, and baking.", hc: "最实在的基底",
    why: [["Whole rolled oats, hearty and chewy.", "整粒燕麦片,扎实有嚼劲。"], ["About 5 minutes on the stove.", "炉火上约5分钟。"], ["Porridge, overnight oats, granola, baking.", "燕麦粥、隔夜燕麦、燕麦脆、烘焙皆宜。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '379 kcal'], ['Protein', '蛋白质', '13 g'], ['Fat', '脂肪', '7 g'], ['Carbohydrate', '碳水化合物', '67 g'], ['Dietary fiber', '膳食纤维', '10 g'], ['Sodium', '钠', '6 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Use about 2 parts water or plant milk to 1 part oats.", "约2份水或植物奶配1份燕麦。"], ["Bring to a simmer, stirring now and then.", "煮至微沸,期间偶尔搅拌。"], ["Cook 5 min until creamy, then rest 1 min.", "煮约5分钟至绵软,焖1分钟。", "5 min", "5分钟"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% whole rolled oats. Naturally gluten-free grain; packed where gluten is present.", "100% 整粒燕麦片。谷物本身天然无麸质;生产环境涉及麸质。"] },

  { sub: 'grain', ids: [150], col: 'skater', spec: SPEC_OATS, k: ['Grains', '谷物'],
    be: "Quick oats are simply rolled thinner, so they cook in a minute or two and turn soft and creamy fast. Same whole-grain oat, less waiting — pour on hot water or plant milk, stir, and breakfast is ready. Made for busy mornings.",
    bc: "即食燕麦只是压得更薄,所以一两分钟就熟,很快变得软糯顺滑。还是同样的全谷物燕麦,只是更省时间——倒入热水或植物奶,搅一搅,早餐就好了。为忙碌的早晨而生。",
    he: "Made for busy mornings.", hc: "为忙碌的早晨而生",
    why: [["Ready in 1–2 minutes.", "1–2分钟即可。"], ["Soft, creamy texture, fast.", "口感软糯顺滑,快速。"], ["Same whole-grain oat, just thinner.", "同样的全谷物燕麦,只是更薄。"]],
    N: nut('Per 100g', '每100克', [['Energy', '能量', '379 kcal'], ['Protein', '蛋白质', '13 g'], ['Fat', '脂肪', '7 g'], ['Carbohydrate', '碳水化合物', '68 g'], ['Dietary fiber', '膳食纤维', '10 g'], ['Sodium', '钠', '6 mg']]),
    cook: { t: ['How to cook', '烹煮方法'], s: [["Add about 1 cup hot water or plant milk per ½ cup oats.", "每半杯燕麦加约1杯热水或植物奶。"], ["Stir and let sit 1–2 min, or microwave 1 min.", "搅拌后静置1–2分钟,或微波1分钟。", "1–2 min", "1–2分钟"], ["Top with fruit, nuts, or seeds.", "按喜好加水果、坚果或籽。"]] },
    al: ALL_FACILITY, store: 'dry', note: ["100% rolled oats. Naturally gluten-free grain; packed where gluten is present.", "100% 燕麦片。谷物本身天然无麸质;生产环境涉及麸质。"] },
];

let n = 0;
const rep = [];
for (const c of CFG) {
  if (SUB !== 'all' && c.sub !== SUB) continue;
  for (const id of c.ids) {
    const row = db.prepare("SELECT id,name_en,description_blocks,nutrition,colophon_character FROM store_products WHERE id=?").get(id);
    if (!row) { rep.push('!! MISSING ' + id); continue; }
    const blocks = card(c, id);
    const inE = c.be.toLowerCase().includes(c.he.toLowerCase());
    const inC = c.bc.includes(c.hc);
    rep.push('#' + id + ' ' + (row.name_en || '').padEnd(26) + ' sub=' + c.sub + ' | hlE=' + inE + ' hlC=' + inC + ' | blocks=' + blocks.length + ' | col->' + c.col);
    if (APPLY) {
      try { fs.mkdirSync('backups', { recursive: true }); } catch (e) {}
      fs.writeFileSync('backups/raw_' + id + '_' + Date.now() + '.json', JSON.stringify({ description_blocks: row.description_blocks, nutrition: row.nutrition, colophon_character: row.colophon_character }));
      db.prepare("UPDATE store_products SET description_blocks=?,nutrition=?,use_block_design=1,page_template='editorial_light',colophon_character=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(blocks), c.N, c.col, id);
      n++;
    }
  }
}
console.log(rep.join('\n'));
console.log(APPLY ? ('== APPLIED ' + n + ' rows (SUB=' + SUB + ') ==') : ('== DRY (SUB=' + SUB + ', set APPLY=1) =='));
