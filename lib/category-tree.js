// Single source of truth for the storefront's 2-level category scheme.
// 7 top categories, each with ordered subcategories, bilingual (EN/CN).
//
// Products are tagged with products.top_category + products.subcategory
// (see scripts/organize_categories.js) using the EXACT `name` strings below
// — keep them in sync. The mini-app shop fetches this via
// GET /api/retail/category-tree and uses it for the left-rail order and the
// CN labels; it only renders tops/subs that actually have published products.

const CATEGORY_TREE = [
  { name: 'Dry & Pantry', name_cn: '干货 & 杂货', subs: [
    { name: 'Nuts & Seeds',        name_cn: '坚果 & 籽' },
    { name: 'Dried Fruits',        name_cn: '果干' },
    { name: 'Legumes',             name_cn: '豆类' },
    { name: 'Grains & Pasta',      name_cn: '谷物 & 意面' },
    { name: 'Flours',              name_cn: '面粉' },
    { name: 'Spices',              name_cn: '香料' },
    { name: 'Oils',                name_cn: '食用油' },
    { name: 'Cacao',               name_cn: '可可' },
    { name: 'Granola',             name_cn: '燕麦脆' },
    { name: 'Nut Butters',         name_cn: '坚果酱' },
    { name: 'Jams',                name_cn: '果酱' },
    { name: 'Sauces & Condiments', name_cn: '酱料调味' },
  ] },
  { name: 'Fresh & Deli', name_cn: '鲜食 & 熟食', subs: [
    { name: 'Plant Protein',        name_cn: '植物蛋白' },
    { name: 'Plant Milks & Creams', name_cn: '植物奶 & 奶油' },
    { name: 'Yogurts',              name_cn: '酸奶' },
    { name: 'Sour Creams',          name_cn: '酸奶油' },
    { name: 'Cheese Alternatives',  name_cn: '植物芝士' },
    { name: 'Spreads & Dips',       name_cn: '抹酱 & 蘸酱' },
    { name: 'Pickles & Olives',     name_cn: '腌渍 & 橄榄' },
    { name: 'Bread',                name_cn: '面包' },
  ] },
  { name: 'Ready to Eat', name_cn: '即食', subs: [
    { name: 'Soups & Stews',        name_cn: '汤品 & 炖菜' },
    { name: 'Wraps & Sandwiches',   name_cn: '卷饼 & 三明治' },
    { name: 'Salads & Bowls',       name_cn: '沙拉 & 谷物碗' },
    { name: 'Cooked Grains',        name_cn: '熟谷物' },
    { name: 'Meals',                name_cn: '正餐' },
    { name: 'Breakfast',            name_cn: '早餐' },
  ] },
  { name: 'Drinks', name_cn: '饮品', subs: [
    { name: 'Juices',              name_cn: '果汁' },
    { name: 'Kombucha',            name_cn: '康普茶' },
    { name: 'Coffee & Tea',        name_cn: '咖啡 & 茶' },
    { name: 'Wines',               name_cn: '葡萄酒' },
    { name: 'Plant Milk Powders',  name_cn: '植物奶粉' },
  ] },
  { name: 'Snacks & Treats', name_cn: '零食 & 甜点', subs: [
    { name: 'Bites & Bars',        name_cn: '能量球 & 能量棒' },
    { name: 'Chips & Crackers',    name_cn: '薯片 & 脆饼' },
    { name: 'Frozen Treats',       name_cn: '冰品' },
  ] },
  { name: 'Wellness', name_cn: '健康营养', subs: [
    { name: 'Plant Powders',       name_cn: '植物粉' },
    { name: 'Protein Powders',     name_cn: '蛋白粉' },
    { name: 'Supplements',         name_cn: '营养补充剂' },
  ] },
  { name: 'Home & Body', name_cn: '家居 & 个护', subs: [
    { name: 'House Care',          name_cn: '家居清洁' },
    { name: 'Cosmetics',           name_cn: '彩妆' },
    { name: 'Personal Care',       name_cn: '个人护理' },
  ] },
];

// Validate a (top_category, subcategory) pair against the tree above so the
// products table only ever stores known names. Unknown top → both cleared;
// unknown/blank sub under a valid top → top kept, sub cleared. Shared by both
// backends (routes/retail.js for the Mini App Backend, routes/products.js for
// the Kitchen App) so they validate identically.
function normalizeCategoryPair(top, sub) {
  const t = String(top == null ? '' : top).trim();
  if (!t) return { top: null, sub: null };
  const topNode = CATEGORY_TREE.find(x => x.name === t);
  if (!topNode) return { top: null, sub: null };
  const s = String(sub == null ? '' : sub).trim();
  const subNode = s ? topNode.subs.find(x => x.name === s) : null;
  return { top: topNode.name, sub: subNode ? subNode.name : null };
}

module.exports = { CATEGORY_TREE, normalizeCategoryPair };
