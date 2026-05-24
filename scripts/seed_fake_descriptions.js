#!/usr/bin/env node
/**
 * One-shot: seed editorial `description_blocks` JSON onto a hand-picked set
 * of products so the mini-app PDP renders with real-looking content while
 * the office writes the real copy.
 *
 * Matches each target by LOWER(name_en) LIKE pattern (and name_cn for the
 * kombuchas, which are bilingual). For kombucha, applies two different
 * block templates to the first two matches so each PDP looks distinct.
 *
 * Idempotent: re-running overwrites the seeded blocks. Will refuse to
 * touch a product whose description_blocks already contains the marker
 * `"_seed": "fake-2026-05-20"` ONLY if --skip-seeded is passed; default
 * is to overwrite (useful while iterating on the templates).
 *
 * Usage:
 *   node scripts/seed_fake_descriptions.js --dry-run
 *   node scripts/seed_fake_descriptions.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const SKIP_SEEDED = process.argv.includes('--skip-seeded');
const SEED_MARKER = 'fake-2026-05-20';

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'));
db.pragma('journal_mode = WAL');

// ─── Block templates ─────────────────────────────────────────────────────
// All templates carry a `_seed` marker on the FIRST block for traceability.
// Blocks intentionally cover ~5 of the 10 supported types so the PDP feels
// editorial without becoming a wall.

const blocks = {
  garlic_dill_sour_cream: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Made with', k_cn: '原料', v_en: 'Cashew base', v_cn: '腰果基底' },
      { k_en: 'Net wt.',   k_cn: '净含量', v_en: '200 g',     v_cn: '200 克' },
      { k_en: 'Cultures',  k_cn: '发酵',   v_en: 'Live',     v_cn: '活性益生菌' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'The story', kicker_cn: '关于这一罐',
      body_en: 'Tangy, herby, garlicky — but no dairy. We culture a cashew base for two days, then fold through fresh dill and slow-roasted garlic. It tastes like the bowl your grandmother stirred together.',
      body_cn: '酸爽、香草气、蒜香十足 —— 但没有一滴乳制品。我们用腰果发酵两天，再拌入新鲜莳萝和慢烤蒜，吃起来就像外婆亲手调的一碗。',
      highlight_en: 'no dairy', highlight_cn: '没有一滴乳制品' },
    { id: 'b3', type: 'why', rows: [
      { claim_en: 'Two-day cashew ferment for real tang',           claim_cn: '腰果两日发酵，自然带酸' },
      { claim_en: 'Fresh dill, never dried',                        claim_cn: '只用新鲜莳萝，不用干粉' },
      { claim_en: 'Slow-roasted garlic, not raw',                   claim_cn: '慢烤蒜香，不刺口' },
    ] },
    { id: 'b4', type: 'allergen_card',
      contains_en: 'cashew',          contains_cn: '腰果',
      may_contain_en: 'tree nuts',    may_contain_cn: '其他坚果' },
    { id: 'b5', type: 'how_to_use', tiles: [
      { icon: '🥖', label_en: 'On sourdough', label_cn: '抹酸面包' },
      { icon: '🥔', label_en: 'Baked potato', label_cn: '焗薯' },
      { icon: '🌮', label_en: 'Taco crown',   label_cn: '塔可顶料' },
      { icon: '🥗', label_en: 'Salad dollop', label_cn: '沙拉浇头' },
      { icon: '🍳', label_en: 'Egg side',     label_cn: '配蛋' },
      { icon: '🥒', label_en: 'Crudité dip',  label_cn: '蔬菜蘸' },
    ] },
    { id: 'b6', type: 'storage_box',
      left:  { icon: '❄️', head_en: 'Refrigerated', head_cn: '冷藏', num: '7', unit_en: 'days after opening', unit_cn: '开封后 7 天' },
      right: { icon: '⏱️', head_en: 'Best within',  head_cn: '最佳', num: '14', unit_en: 'days unopened',    unit_cn: '未开封 14 天', alt: true },
    },
    { id: 'b7', type: 'pull_quote',
      text_en: 'Tastes like the real thing. Maybe better.',
      text_cn: '吃起来比真的还像真的。',
      who_en: 'Mei, our test kitchen', who_cn: '梅，测试厨房' },
  ],

  chocolate_spread: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Cocoa',    k_cn: '可可',    v_en: '38 %',     v_cn: '38 %' },
      { k_en: 'Net wt.',  k_cn: '净含量',  v_en: '230 g',    v_cn: '230 克' },
      { k_en: 'Palm oil', k_cn: '棕榈油',  v_en: 'None',     v_cn: '不含' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'Why we made it', kicker_cn: '为什么做这一罐',
      body_en: 'A silky, deep-cocoa spread that swaps palm oil for cashew cream and refined sugar for dates. It is dark, glossy, and grown-up — pour it on toast and you will not look for the other jar again.',
      body_cn: '丝滑、可可味浓郁的巧克力酱，用腰果奶代替棕榈油，用椰枣代替精制糖。深邃、亮泽、不腻 —— 涂在面包上，你不会再想念另一罐。',
      highlight_en: 'no palm oil', highlight_cn: '不用棕榈油' },
    { id: 'b3', type: 'ingredients_chips', items: [
      { name_en: 'Cocoa',    name_cn: '可可',    pct: 38, lead: true },
      { name_en: 'Cashew',   name_cn: '腰果',    pct: 22 },
      { name_en: 'Dates',    name_cn: '椰枣',    pct: 18 },
      { name_en: 'Coconut oil', name_cn: '椰子油', pct: 14 },
      { name_en: 'Sea salt', name_cn: '海盐' },
      { name_en: 'Vanilla',  name_cn: '香草' },
    ] },
    { id: 'b4', type: 'big_stat', stat: '0 g',
      claim_en: 'palm oil per jar',   claim_cn: '每罐棕榈油用量',
      sub_en:   'we use cashew cream instead', sub_cn: '用腰果奶替代',
      bg: 'lime' },
    { id: 'b5', type: 'allergen_card',
      contains_en: 'cashew',                contains_cn: '腰果',
      may_contain_en: 'tree nuts, soy',     may_contain_cn: '其他坚果、大豆' },
    { id: 'b6', type: 'how_to_use', tiles: [
      { icon: '🥐', label_en: 'On croissant', label_cn: '抹可颂' },
      { icon: '🥞', label_en: 'Pancake swirl', label_cn: '拌松饼' },
      { icon: '🍓', label_en: 'Fruit dip', label_cn: '蘸水果' },
      { icon: '🥛', label_en: 'Warm milk', label_cn: '冲热奶' },
      { icon: '🥯', label_en: 'On bagel', label_cn: '抹贝果' },
      { icon: '🍦', label_en: 'Ice-cream sauce', label_cn: '雪糕酱' },
    ] },
  ],

  hummus_asli: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Style',    k_cn: '风味',   v_en: 'Tel Aviv',  v_cn: '特拉维夫风格' },
      { k_en: 'Net wt.',  k_cn: '净含量', v_en: '250 g',     v_cn: '250 克' },
      { k_en: 'Texture',  k_cn: '口感',   v_en: 'Silky',     v_cn: '丝滑' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'The recipe', kicker_cn: '关于配方',
      body_en: 'Asli means original. Chickpeas slow-soaked overnight, blitzed with stone-milled tahini, lemon, and a single clove of garlic. No shortcuts, no cumin shower — just the four ingredients done properly.',
      body_cn: 'Asli 在阿拉伯语里是"原汁原味"。鹰嘴豆夜里慢泡，加石磨芝麻酱、柠檬、一瓣蒜打到丝滑。不放孜然，不抄近路 —— 就这四样，认真做。',
      highlight_en: 'four ingredients', highlight_cn: '就这四样' },
    { id: 'b3', type: 'ingredients_line', items: [
      { name_en: 'Chickpea', name_cn: '鹰嘴豆', pct: 55, lead: true },
      { name_en: 'Tahini',   name_cn: '芝麻酱', pct: 24 },
      { name_en: 'Lemon',    name_cn: '柠檬',   pct: 8 },
      { name_en: 'Garlic',   name_cn: '大蒜' },
      { name_en: 'Olive oil', name_cn: '橄榄油' },
      { name_en: 'Sea salt',  name_cn: '海盐' },
    ] },
    { id: 'b4', type: 'allergen_card',
      contains_en: 'sesame',              contains_cn: '芝麻',
      may_contain_en: 'tree nuts',        may_contain_cn: '坚果' },
    { id: 'b5', type: 'how_to_use', tiles: [
      { icon: '🫓', label_en: 'Pita scoop',  label_cn: '蘸皮塔' },
      { icon: '🥒', label_en: 'Crudité dip', label_cn: '蔬菜蘸' },
      { icon: '🥙', label_en: 'Wrap base',   label_cn: '卷饼底' },
      { icon: '🥗', label_en: 'Bowl base',   label_cn: '碗底' },
      { icon: '🍞', label_en: 'Toast spread', label_cn: '吐司抹' },
      { icon: '🥚', label_en: 'Egg side',    label_cn: '配水煮蛋' },
    ] },
    { id: 'b6', type: 'storage_box',
      left:  { icon: '❄️', head_en: 'Refrigerated', head_cn: '冷藏', num: '5', unit_en: 'days after opening', unit_cn: '开封后 5 天' },
      right: { icon: '🫒', head_en: 'Top with',     head_cn: '建议',  num: '1', unit_en: 'spoon olive oil',  unit_cn: '勺橄榄油', alt: true },
    },
    { id: 'b7', type: 'pull_quote',
      text_en: 'Closest thing to Abu Hassan I have had outside Jaffa.',
      text_cn: '出了雅法，再没吃到比这家更接近 Abu Hassan 的。',
      who_en: 'a customer in Tianhe', who_cn: '一位天河客人' },
  ],

  kombucha_a: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Brew',     k_cn: '酿造',    v_en: '14 days',   v_cn: '14 天' },
      { k_en: 'Volume',   k_cn: '净含量',  v_en: '330 ml',    v_cn: '330 毫升' },
      { k_en: 'Sugar',    k_cn: '糖',      v_en: '< 3 g/100ml', v_cn: '< 3 克/百毫升' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'Brewed in-house', kicker_cn: '我们自己酿',
      body_en: 'A long, cool first ferment, then a second ferment with whole fruit. Lightly fizzy, dry on the finish — the kind of kombucha that actually replaces your fourth coffee.',
      body_cn: '低温长时间一次发酵，再用整颗水果做二次发酵。气泡轻、尾韵干 —— 真的能代替你下午第四杯咖啡。',
      highlight_en: 'second ferment with whole fruit', highlight_cn: '整颗水果二次发酵' },
    { id: 'b3', type: 'big_stat', stat: '< 0.5%',
      claim_en: 'trace alcohol',     claim_cn: '微量酒精',
      sub_en: 'natural by-product of the live ferment', sub_cn: '活性发酵自然产物',
      bg: 'oat' },
    { id: 'b4', type: 'why', rows: [
      { claim_en: '14-day slow first ferment',         claim_cn: '14 天慢一发' },
      { claim_en: 'Whole-fruit second ferment',         claim_cn: '整果二次发酵' },
      { claim_en: 'Unfiltered, live cultures in every bottle', claim_cn: '不过滤，每瓶都含活菌' },
    ] },
    { id: 'b5', type: 'storage_box',
      left:  { icon: '❄️', head_en: 'Keep cold', head_cn: '冷藏', num: '4', unit_en: '°C ideal', unit_cn: '°C 最佳' },
      right: { icon: '🫧', head_en: 'Open',     head_cn: '开瓶', num: '1', unit_en: 'slow turn', unit_cn: '慢拧一下', alt: true },
      note_en: 'Live cultures continue to ferment in-bottle — keep upright and chilled.',
      note_cn: '瓶内仍在发酵，请直立冷藏。' },
    { id: 'b6', type: 'notes_callout',
      text_en: 'Contains live cultures. Not for children under 3, pregnant women, or anyone advised to avoid trace alcohol.',
      text_cn: '含活性菌。3 岁以下儿童、孕妇及需避免微量酒精者请谨慎饮用。' },
  ],

  kombucha_b: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Brew',     k_cn: '酿造',   v_en: '14 days',   v_cn: '14 天' },
      { k_en: 'Volume',   k_cn: '净含量', v_en: '330 ml',    v_cn: '330 毫升' },
      { k_en: 'Style',    k_cn: '风格',   v_en: 'Dry, floral', v_cn: '干爽、花香' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'A different jar', kicker_cn: '另一种风味',
      body_en: 'Same long ferment, different finish. We push this batch toward dry — less residual sugar, more bite — and second-ferment it with whole botanicals instead of fruit. Crisp, faintly floral, food-friendly.',
      body_cn: '同样的慢发酵，但风味更干。残糖更少、口感更利，用整株植物（非水果）做二发。清冽、带一点花香，配饭也不抢戏。',
      highlight_en: 'whole botanicals', highlight_cn: '整株植物' },
    { id: 'b3', type: 'ingredients_chips', items: [
      { name_en: 'Green tea',      name_cn: '绿茶',     lead: true },
      { name_en: 'SCOBY culture',  name_cn: '红茶菌' },
      { name_en: 'Cane sugar',     name_cn: '蔗糖' },
      { name_en: 'Botanicals',     name_cn: '植物花草' },
      { name_en: 'Filtered water', name_cn: '过滤水' },
    ] },
    { id: 'b4', type: 'big_stat', stat: '< 2 g',
      claim_en: 'sugar per 100 ml', claim_cn: '每百毫升糖',
      sub_en: 'most of it eaten by the cultures', sub_cn: '大部分被菌吃掉',
      bg: 'lime' },
    { id: 'b5', type: 'storage_box',
      left:  { icon: '❄️', head_en: 'Keep cold', head_cn: '冷藏', num: '4', unit_en: '°C ideal', unit_cn: '°C 最佳' },
      right: { icon: '🍽️', head_en: 'Pair with', head_cn: '搭配', num: '1', unit_en: 'savoury meal', unit_cn: '咸味菜', alt: true },
    },
    { id: 'b6', type: 'pull_quote',
      text_en: 'Dry kombucha is the only kombucha that actually goes with dinner.',
      text_cn: '只有干型康普茶，才真的能配晚饭。',
      who_en: 'our head brewer', who_cn: '主理酿造师' },
  ],

  nutella_bars: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Weight',   k_cn: '克重',    v_en: '80 g',     v_cn: '80 克' },
      { k_en: 'Base',     k_cn: '底层',    v_en: 'Date-oat', v_cn: '椰枣燕麦' },
      { k_en: 'Top',      k_cn: '顶层',    v_en: 'Cocoa-hazelnut', v_cn: '可可榛子' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'The bar', kicker_cn: '关于这块',
      body_en: 'Chocolate-hazelnut on a chewy date-oat crust. No refined sugar in the body of the bar — the sweetness is from the dates and a finishing drizzle of dark chocolate.',
      body_cn: '可可榛子顶层 + 椰枣燕麦底层。主体不加精制糖，甜味来自椰枣和最后一层黑巧淋面。',
      highlight_en: 'No refined sugar', highlight_cn: '不加精制糖' },
    { id: 'b3', type: 'ingredients_chips', items: [
      { name_en: 'Hazelnut',  name_cn: '榛子',   pct: 28, lead: true },
      { name_en: 'Date',      name_cn: '椰枣',   pct: 24 },
      { name_en: 'Oat',       name_cn: '燕麦',   pct: 18 },
      { name_en: 'Cocoa',     name_cn: '可可',   pct: 14 },
      { name_en: 'Coconut oil', name_cn: '椰子油', pct: 8 },
      { name_en: 'Sea salt',  name_cn: '海盐' },
    ] },
    { id: 'b4', type: 'allergen_card',
      contains_en: 'hazelnut, oat',                contains_cn: '榛子、燕麦',
      may_contain_en: 'tree nuts, soy, sesame',    may_contain_cn: '其他坚果、大豆、芝麻' },
    { id: 'b5', type: 'how_to_use', tiles: [
      { icon: '🎒', label_en: 'Lunchbox', label_cn: '便当' },
      { icon: '🏃', label_en: 'On the go', label_cn: '随身吃' },
      { icon: '☕', label_en: 'Coffee side', label_cn: '配咖啡' },
      { icon: '🌙', label_en: 'Late snack', label_cn: '夜宵' },
      { icon: '🧊', label_en: 'Chilled', label_cn: '冷藏后更脆' },
      { icon: '🎁', label_en: 'Gift box', label_cn: '送礼' },
    ] },
  ],

  mango_bites: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Variety',  k_cn: '品种',   v_en: 'Alphonso',  v_cn: '阿方索' },
      { k_en: 'Net wt.',  k_cn: '净含量', v_en: '200 g',     v_cn: '200 克' },
      { k_en: 'Sugar',    k_cn: '糖',     v_en: 'None added', v_cn: '不加糖' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'One ingredient', kicker_cn: '只有一种原料',
      body_en: 'Frozen mango. That is it. Alphonso for the deep, almost custardy flavour — diced, individually frozen, no sugar and no syrups. Eat them straight from the bag.',
      body_cn: '冷冻芒果。就这一样。选阿方索品种，香气浓郁、近乎奶香 —— 切丁分粒急冻，不加糖、不加糖浆。从袋里拿出来直接吃。',
      highlight_en: 'no sugar and no syrups', highlight_cn: '不加糖、不加糖浆' },
    { id: 'b3', type: 'big_stat', stat: '1',
      claim_en: 'ingredient',          claim_cn: '种原料',
      sub_en:   'mango. nothing else.', sub_cn:   '芒果。仅此而已。',
      bg: 'mango' },
    { id: 'b4', type: 'how_to_use', tiles: [
      { icon: '🥤', label_en: 'Smoothie',     label_cn: '冰沙' },
      { icon: '🍦', label_en: 'Yogurt top',   label_cn: '酸奶顶' },
      { icon: '🥣', label_en: 'Granola bowl', label_cn: '麦片碗' },
      { icon: '❄️', label_en: 'Straight',    label_cn: '直接吃' },
      { icon: '🍹', label_en: 'In drinks',    label_cn: '调饮' },
      { icon: '🍰', label_en: 'Bake-in',      label_cn: '烘焙' },
    ] },
    { id: 'b5', type: 'storage_box',
      left:  { icon: '🧊', head_en: 'Freezer', head_cn: '冷冻', num: '6', unit_en: 'months sealed', unit_cn: '密封 6 月' },
      right: { icon: '⏱️', head_en: 'Once thawed', head_cn: '解冻后', num: '24', unit_en: 'hours', unit_cn: '小时内吃完', alt: true },
    },
  ],

  almonds_cashews: [
    { id: 'b1', type: 'spec_strip', _seed: SEED_MARKER, cells: [
      { k_en: 'Form',     k_cn: '形态',   v_en: 'Raw, whole', v_cn: '生、整粒' },
      { k_en: 'Net wt.',  k_cn: '净含量', v_en: '250 g',     v_cn: '250 克' },
      { k_en: 'Origin',   k_cn: '产地',   v_en: 'Xinjiang & Yunnan', v_cn: '新疆 & 云南' },
    ] },
    { id: 'b2', type: 'hero_intro',
      kicker_en: 'Just the nut', kicker_cn: '只是坚果',
      body_en: 'Raw almonds and cashews, sorted by hand, sealed in nitrogen. No roasting, no oil, no salt — so you can roast, salt, blitz, or eat them however you want.',
      body_cn: '生杏仁与腰果，人工分拣，氮气封袋。不烤、不加油、不加盐 —— 你想烤就烤，想打酱就打酱，想直接吃也行。',
      highlight_en: 'No roasting, no oil, no salt', highlight_cn: '不烤、不加油、不加盐' },
    { id: 'b3', type: 'allergen_card',
      contains_en: 'almond, cashew (tree nuts)',  contains_cn: '杏仁、腰果（树坚果）',
      may_contain_en: 'peanut, other tree nuts',  may_contain_cn: '花生、其他坚果' },
    { id: 'b4', type: 'how_to_use', tiles: [
      { icon: '🔥', label_en: 'Dry-roast', label_cn: '干烤' },
      { icon: '🥛', label_en: 'Nut milk',  label_cn: '坚果奶' },
      { icon: '🥣', label_en: 'On oats',   label_cn: '加燕麦' },
      { icon: '🥗', label_en: 'Salad',     label_cn: '撒沙拉' },
      { icon: '🍫', label_en: 'Chocolate', label_cn: '搭巧克力' },
      { icon: '🥖', label_en: 'Nut butter', label_cn: '打果酱' },
    ] },
    { id: 'b5', type: 'storage_box',
      left:  { icon: '🏠', head_en: 'Pantry',      head_cn: '常温', num: '2', unit_en: 'months sealed', unit_cn: '密封 2 月' },
      right: { icon: '❄️', head_en: 'Refrigerated', head_cn: '冷藏', num: '6', unit_en: 'months sealed', unit_cn: '密封 6 月', alt: true },
      note_en: 'Once opened, transfer to an airtight jar in the fridge to stop the oils oxidising.',
      note_cn: '开封后请移入密封罐冷藏，避免油脂氧化。' },
  ],
};

// ─── Match patterns ──────────────────────────────────────────────────────
// Each target says how to find the product(s) in the DB. Kombucha is the
// only one that consumes TWO slots (kombucha_a then kombucha_b applied to
// the first two LIKE matches).
const targets = [
  { key: 'garlic_dill_sour_cream', label: 'Garlic Dill Sour Cream',
    sql: `LOWER(name_en) LIKE '%garlic%' AND LOWER(name_en) LIKE '%dill%'` },
  { key: 'chocolate_spread',       label: 'Chocolate Spread',
    sql: `LOWER(name_en) LIKE '%chocolate%spread%' OR LOWER(name_en) LIKE '%choco%spread%'` },
  { key: 'hummus_asli',            label: 'Hummus Asli',
    sql: `LOWER(name_en) LIKE '%hummus%asli%' OR (LOWER(name_en) LIKE '%hummus%' AND LOWER(name_en) NOT LIKE '%pesto%')` },
  { key: 'kombucha_pair',          label: 'Kombucha × 2',
    sql: `LOWER(name_en) LIKE '%kombucha%' OR LOWER(name_cn) LIKE '%康普茶%' OR LOWER(name_cn) LIKE '%红茶菌%'`,
    pair: true },
  { key: 'nutella_bars',           label: 'Nutella Bars',
    sql: `LOWER(name_en) LIKE '%nutella%bar%' OR (LOWER(name_en) LIKE '%nutella%' AND LOWER(name_en) LIKE '%bar%')` },
  { key: 'mango_bites',            label: 'Mango Bites',
    sql: `LOWER(name_en) LIKE '%mango%bite%' OR (LOWER(name_en) LIKE '%mango%' AND LOWER(name_en) LIKE '%bite%')` },
  { key: 'almonds_cashews',        label: 'Almonds & Cashews (raw whole)',
    // Match the raw, unsalted whole-nut SKUs (not flour, not butter, not milk).
    sql: `(LOWER(name_en) LIKE '%almond%' OR LOWER(name_en) LIKE '%cashew%')
          AND LOWER(name_en) LIKE '%raw%'
          AND LOWER(name_en) NOT LIKE '%butter%'
          AND LOWER(name_en) NOT LIKE '%flour%'
          AND LOWER(name_en) NOT LIKE '%milk%'
          AND LOWER(name_en) NOT LIKE '%m!lk%'
          AND LOWER(name_en) NOT LIKE '%m*lk%'
          AND LOWER(name_en) NOT LIKE '%camembert%'` },
];

// ─── Run ─────────────────────────────────────────────────────────────────
const findRows = (where) => db.prepare(
  `SELECT id, name_en, name_cn, sku, description_blocks
   FROM products
   WHERE (${where})
   AND COALESCE(is_active, 1) = 1
   ORDER BY id ASC`
).all();

const updateBlocks = db.prepare(
  `UPDATE products SET description_blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
);

const summary = { matched: 0, updated: 0, skipped: 0, missed: [] };

function isAlreadySeeded(json) {
  if (!json) return false;
  return String(json).includes(`"${SEED_MARKER}"`);
}

function applyOne(productRow, blocksArr, label) {
  if (SKIP_SEEDED && isAlreadySeeded(productRow.description_blocks)) {
    summary.skipped++;
    console.log(`  · SKIP (already seeded): #${productRow.id} ${productRow.name_en}`);
    return;
  }
  const json = JSON.stringify(blocksArr);
  console.log(`  · ${DRY ? 'DRY' : 'SET '} #${productRow.id} ${productRow.name_en} ← ${label} (${blocksArr.length} blocks, ${json.length} bytes)`);
  if (!DRY) updateBlocks.run(json, productRow.id);
  summary.updated++;
}

for (const t of targets) {
  console.log(`\n→ ${t.label}`);
  const rows = findRows(t.sql);
  if (!rows.length) {
    summary.missed.push(t.label);
    console.log(`  ! no match`);
    continue;
  }
  summary.matched += rows.length;

  if (t.pair) {
    // Apply A to the first match, B to the second. If only one exists, just A.
    if (rows[0]) applyOne(rows[0], blocks.kombucha_a, 'kombucha_a');
    if (rows[1]) applyOne(rows[1], blocks.kombucha_b, 'kombucha_b');
    if (rows.length > 2) console.log(`  · (${rows.length - 2} more kombucha rows left untouched)`);
  } else {
    // Apply the corresponding template to ALL matches (usually 1).
    const tmpl = blocks[t.key];
    if (!tmpl) { console.log(`  ! no template defined for ${t.key}`); continue; }
    for (const r of rows) applyOne(r, tmpl, t.key);
  }
}

console.log(`\n─ Summary ─`);
console.log(`  matched products : ${summary.matched}`);
console.log(`  ${DRY ? 'would update' : 'updated'}    : ${summary.updated}`);
console.log(`  skipped          : ${summary.skipped}`);
if (summary.missed.length) {
  console.log(`  no-match targets : ${summary.missed.join(' · ')}`);
}
console.log(DRY ? '\n(dry-run — no DB writes)\n' : '\nDone.\n');
