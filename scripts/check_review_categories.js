#!/usr/bin/env node
/* eslint-disable no-console */
//
// Regression harness for lib/review-seeder.js categoryOf().
//
//   node scripts/check_review_categories.js      # exits 0 on pass, 1 on fail
//
// WHY THIS EXISTS
// ---------------
// Every bug the seeded-review generator has shipped was the same bug: a bucket
// placed in the wrong ORDER, never a missing keyword. It took four rounds and
// 22 deleted rows to find them all, because each one only shows up as odd copy
// on a live product page:
//
//   'drink' / 饮   in the milk branch swallowed category = 'Drinks'
//                  → kombucha reviewed as "rich and creamy, great with cereal"
//   'butter'       in the milk branch swallowed "Peanut Butter"
//                  → a jar of it reviewed as "孩子每天都要喝一杯"
//   'cheese'/'酸奶' in the milk branch swallowed "Nacho Cheese Dip" / "Tzatziki"
//                  → a dip reviewed as something you pour on cereal
//
// So the cases below are written in pairs on purpose: each guard is tested
// against the dairy/meat keyword it has to BEAT, and against the genuine
// product that must still reach the bucket it was taken from. Add a bucket,
// add both halves of the pair.
//
const seeder = require('../lib/review-seeder');

// [name_en, name_cn, category, subcategory, expected bucket]
const CASES = [
  // ── drinks: must beat the milk branch on category = 'Drinks' ──────────────
  ['Mango Kombucha',              '芒果康普茶',           'Drinks', 'Kombucha',     'drinks'],
  ['Lemongrass Kombucha',         '香茅康普茶',           'Drinks', 'Kombucha',     'drinks'],
  ['Green Glow Juice',            '绿焕汁',               'Drinks', 'Juices',       'drinks'],
  ['Celerybration Juice',         '芹菜汁',               'Drinks', 'Juices',       'drinks'],
  ['Yunnan Crisp',                '云南脆',               'Drinks', 'Coffee & Tea', 'drinks'],
  ['Oatly Barista',               'Oatly 咖啡大师',       'Fresh & Deli', '',       'drinks'],
  // ── spreads + condiments: must beat 'butter' / 'cheese' / '酸奶' ───────────
  ['All Natural Peanut Butter',   '天然花生酱',           'Nut Butters',  '',       'pantry'],
  ['Almond Butter',               '杏仁酱',               '',             '',       'pantry'],
  ['Roasted Hazelnut Butter',     '烤榛子酱',             'Dry & Pantry', '',       'pantry'],
  ['Hazelnut-Chocolate Spread',   '可可榛子酱',           'Dry & Pantry', '',       'pantry'],
  ['Strawberry Jam',              '草莓果酱',             'Pantry', 'Spreads',      'pantry'],
  ['Nacho Cheese Dip',            '纯素奶酪蘸酱',         'Fresh & Deli', '',       'pantry'],
  ['Tzatziki',                    '莳萝柠檬酸奶酱',       'Fresh & Deli', '',       'pantry'],
  ['Classic Hummus',              '鹰嘴豆泥',             'Fresh & Deli', '',       'pantry'],
  ['Caesar Dressing',             '凯撒沙拉酱',           'Pantry', 'Sauces',       'pantry'],
  // ── genuine dairy still reaches milk ──────────────────────────────────────
  ['Clean Coconut Milk (No Gums)', '丽尔泰椰浆 1L（无胶）', 'Fresh & Deli', '',      'milk'],
  ['Just-Add-Water Soy Milk',      '有机即溶豆奶粉',       'Fresh & Deli', '',      'milk'],
  ['Grass-fed Butter',             '草饲黄油',             'Fresh',  'Dairy',       'milk'],
  ['Probiotic Coconut Yogurt',     '纯素椰子酸奶',         'Fresh & Deli', '',      'milk'],
  // ── the bare-酱 trap: a braised dish must stay meat, not become pantry ─────
  ['Braised Beef',                 '酱牛肉',               'Fresh',  'Meat',        'meat'],
  // ── buckets none of the guards should disturb ──────────────────────────────
  ['Fruit & Vegetable Wash',       '果蔬清洗剂',           'Home',   'Cleaning',    'household'],
  ['Tinted Lip Oil',               '有色唇油',             'Beauty', '',            'household'],
  ['Baby Spinach',                 '嫩菠菜',               'Fresh',  'Veg',         'produce'],
  ['Jasmine Rice',                 '茉莉香米',             'Pantry', 'Grains',      'pantry'],
  ['Pumpkin Soup',                 '南瓜汤',               'Fresh & Deli', '',      'soup'],
];

// Phrasing that only makes sense for something you drink or pour on cereal.
// It must never appear in a pool a non-dairy product can be seeded from.
const DAIRY_PHRASING = /creamy|cereal|glass every morning|奶味|配麦片|喝一杯|给家里人喝/;
const NON_DAIRY_POOLS = ['drinks', 'pantry', 'produce', 'household', 'snack', 'bakery', 'meat'];

let failed = 0;

for (const [en, cn, category, subcategory, want] of CASES) {
  const got = seeder.categoryOf({ name_en: en, name_cn: cn, category, subcategory });
  const ok = got === want;
  if (!ok) failed++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + en.padEnd(34) + String(got).padEnd(11) +
    (ok ? '' : '(want ' + want + ')')
  );
}

for (const pool of NON_DAIRY_POOLS) {
  for (const [label, bank] of [['CN', seeder.CN], ['EN', seeder.EN]]) {
    for (const line of bank[pool] || []) {
      if (DAIRY_PHRASING.test(line)) {
        failed++;
        console.log('  FAIL  dairy phrasing in ' + label + '.' + pool + ': ' + line);
      }
    }
  }
}

console.log(failed
  ? '\n' + failed + ' FAILED'
  : '\nall ' + CASES.length + ' cases passed, no dairy phrasing outside the milk pool');
process.exit(failed ? 1 : 0);
