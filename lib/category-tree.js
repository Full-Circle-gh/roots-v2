// Single source of truth for the storefront's 2-level category scheme.
// 7 top categories, each with ordered subcategories, bilingual (EN/CN).
//
// The tree is now EDITABLE from the Mini App Backend (Categories tab). The live
// tree is stored in storefront_config['category.tree'] (a JSON blob, same KV
// pattern as home.layout); SEED_TREE below is the first-boot seed AND the
// fallback when the DB row is missing/corrupt. Every node carries a STABLE
// `id` so the editor can rename a node and the server can migrate the product
// rows that still reference the old name (see PUT /api/retail-admin/category-tree).
//
// Products are tagged with products.top_category + products.subcategory using
// the EXACT `name` strings from the tree — renames migrate those rows. The
// mini-app shop fetches the tree via GET /api/retail/category-tree and uses it
// for the left-rail order and the CN labels; it only renders tops/subs that
// actually have published products.

const SEED_TREE = [
  { id: 'dry', name: 'Dry & Pantry', name_cn: '干货 & 杂货', subs: [
    { id: 'nuts',       name: 'Nuts & Seeds',        name_cn: '坚果 & 籽' },
    { id: 'dried',      name: 'Dried Fruits',        name_cn: '果干' },
    { id: 'legumes',    name: 'Legumes',             name_cn: '豆类' },
    { id: 'grains',     name: 'Grains & Pasta',      name_cn: '谷物 & 意面' },
    { id: 'flours',     name: 'Flours',              name_cn: '面粉' },
    { id: 'spices',     name: 'Spices',              name_cn: '香料' },
    { id: 'oils',       name: 'Oils',                name_cn: '食用油' },
    { id: 'cacao',      name: 'Cacao',               name_cn: '可可' },
    { id: 'granola',    name: 'Granola',             name_cn: '燕麦脆' },
    { id: 'nutbutter',  name: 'Nut Butters',         name_cn: '坚果酱' },
    { id: 'jams',       name: 'Jams',                name_cn: '果酱' },
    { id: 'sauces',     name: 'Sauces & Condiments', name_cn: '酱料调味' },
  ] },
  { id: 'fresh', name: 'Fresh & Deli', name_cn: '鲜食 & 熟食', subs: [
    { id: 'protein',    name: 'Plant Protein',        name_cn: '植物蛋白' },
    { id: 'milks',      name: 'Plant Milks & Creams', name_cn: '植物奶 & 奶油' },
    { id: 'yogurts',    name: 'Yogurts',              name_cn: '酸奶' },
    { id: 'sourcream',  name: 'Sour Creams',          name_cn: '酸奶油' },
    { id: 'cheese',     name: 'Cheese Alternatives',  name_cn: '植物芝士' },
    { id: 'spreads',    name: 'Spreads & Dips',       name_cn: '抹酱 & 蘸酱' },
    { id: 'pickles',    name: 'Pickles & Olives',     name_cn: '腌渍 & 橄榄' },
    { id: 'bread',      name: 'Bread',                name_cn: '面包' },
  ] },
  { id: 'ready', name: 'Ready to Eat', name_cn: '即食', subs: [
    { id: 'soups',      name: 'Soups & Stews',        name_cn: '汤品 & 炖菜' },
    { id: 'wraps',      name: 'Wraps & Sandwiches',   name_cn: '卷饼 & 三明治' },
    { id: 'salads',     name: 'Salads & Bowls',       name_cn: '沙拉 & 谷物碗' },
    { id: 'cookedgr',   name: 'Cooked Grains',        name_cn: '熟谷物' },
    { id: 'meals',      name: 'Meals',                name_cn: '正餐' },
    { id: 'breakfast',  name: 'Breakfast',            name_cn: '早餐' },
  ] },
  { id: 'drinks', name: 'Drinks', name_cn: '饮品', subs: [
    { id: 'juices',     name: 'Juices',              name_cn: '果汁' },
    { id: 'kombucha',   name: 'Kombucha',            name_cn: '康普茶' },
    { id: 'coffeetea',  name: 'Coffee & Tea',        name_cn: '咖啡 & 茶' },
    { id: 'wines',      name: 'Wines',               name_cn: '葡萄酒' },
    { id: 'milkpowder', name: 'Plant Milk Powders',  name_cn: '植物奶粉' },
  ] },
  { id: 'snacks', name: 'Snacks & Treats', name_cn: '零食 & 甜点', subs: [
    { id: 'bites',      name: 'Bites & Bars',        name_cn: '能量球 & 能量棒' },
    { id: 'chips',      name: 'Chips & Crackers',    name_cn: '薯片 & 脆饼' },
    { id: 'frozen',     name: 'Frozen Treats',       name_cn: '冰品' },
  ] },
  { id: 'wellness', name: 'Wellness', name_cn: '健康营养', subs: [
    { id: 'plantpow',    name: 'Plant Powders',       name_cn: '植物粉' },
    { id: 'proteinpow',  name: 'Protein Powders',     name_cn: '蛋白粉' },
    { id: 'supplements', name: 'Supplements',         name_cn: '营养补充剂' },
  ] },
  { id: 'home', name: 'Home & Body', name_cn: '家居 & 个护', subs: [
    { id: 'housecare',  name: 'House Care',          name_cn: '家居清洁' },
    { id: 'cosmetics',  name: 'Cosmetics',           name_cn: '彩妆' },
    { id: 'personal',   name: 'Personal Care',       name_cn: '个人护理' },
  ] },
];

// Coerce an arbitrary parsed blob into a clean tree shape. Drops malformed
// nodes, trims strings, ensures subs is an array. Used on both read (defensive)
// and write (canonicalize before persisting).
function sanitizeTree(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const name = String(t.name == null ? '' : t.name).trim();
    if (!name) continue;
    const subsIn = Array.isArray(t.subs) ? t.subs : [];
    const subs = [];
    for (const s of subsIn) {
      if (!s || typeof s !== 'object') continue;
      const sn = String(s.name == null ? '' : s.name).trim();
      if (!sn) continue;
      subs.push({
        id: String(s.id == null ? '' : s.id).trim() || null,
        name: sn,
        name_cn: String(s.name_cn == null ? '' : s.name_cn).trim(),
      });
    }
    out.push({
      id: String(t.id == null ? '' : t.id).trim() || null,
      name,
      name_cn: String(t.name_cn == null ? '' : t.name_cn).trim(),
      subs,
    });
  }
  return out;
}

// Read the live tree for a given DB connection (caller passes tdb() / db so
// this stays tenant-correct). Falls back to SEED_TREE when the row is missing
// or unparseable, so the shop never renders an empty rail.
function getCategoryTree(db) {
  if (db && typeof db.prepare === 'function') {
    try {
      const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'category.tree'").get();
      if (row && row.value_json) {
        const parsed = sanitizeTree(JSON.parse(row.value_json));
        if (parsed && parsed.length) return parsed;
      }
    } catch (e) { /* fall through to seed */ }
  }
  return SEED_TREE;
}

// Validate a (top_category, subcategory) pair against the live tree so the
// products table only ever stores known names. Unknown top → both cleared;
// unknown/blank sub under a valid top → top kept, sub cleared. Pass the DB
// connection (tdb()/db) so validation uses the operator's edited tree; without
// one it falls back to SEED_TREE. Shared by routes/retail.js (Mini App Backend)
// and routes/products.js (Kitchen App) so they validate identically.
function normalizeCategoryPair(top, sub, db) {
  const tree = getCategoryTree(db);
  const t = String(top == null ? '' : top).trim();
  if (!t) return { top: null, sub: null };
  const topNode = tree.find(x => x.name === t);
  if (!topNode) return { top: null, sub: null };
  const s = String(sub == null ? '' : sub).trim();
  const subNode = s ? (topNode.subs || []).find(x => x.name === s) : null;
  return { top: topNode.name, sub: subNode ? subNode.name : null };
}

module.exports = { SEED_TREE, sanitizeTree, getCategoryTree, normalizeCategoryPair };
