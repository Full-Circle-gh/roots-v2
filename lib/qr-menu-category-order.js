// §288 — THE QR MENU'S OWN CATEGORY ORDER, and which categories it hides.
//
// Ash, 2026-09-29: *"tenant should be able to organize the left menu as he
// pleased regardless the way its organized on the mini app"*, then *"same
// order in every location"* and yes to hiding a category on the QR menu only.
//
// WHAT IS SEPARATE AND WHAT IS NOT. The category TREE stays one thing
// (lib/category-tree.js, storefront_config['category.tree']): the names, the
// subcategories, which product sits where. The mini app, the web shop and the
// QR menu all read it. Only the ORDER the QR menu draws it in, and a list of
// top categories the QR menu leaves out, live here. A second tree was
// rejected: two copies drift, a rename on one side orphans the other.
//
// ONE VALUE FOR THE WHOLE TENANT, so every location's QR menu is the same.
//
// Stored under storefront_config['qrMenu.categoryOrder'], the same KV the
// QR block allow-list uses (lib/qr-menu-block-defaults.js):
//
//   { tops:     null | [topId, …],          null = follow the mini app
//     subs:     { topId: [subId, …] },      absent key = follow the mini app
//     hidden:   [topId, …],                 top categories the QR menu leaves out
//     products: { nodeId: [productId, …] } } the QR menu's product order inside
//                                           one section: nodeId is the section's
//                                           subcategory, or its top category
//                                           for the products with no heading
//
// PRODUCTS, ADDED 2026-09-29. Ash: *"qr menu and mini app might have different
// organization of products but all of the organization should be done in the
// page"* — Products → Categories. The per-shop Sort number on the Shops page is
// gone with it, so this is the ONE QR product order, for every location, like
// the category order above. A product the list does not name follows the named
// ones in the mini app's order (store_products.sort_order), so an unset list
// is the mini app's order exactly.
//
// Ids are the tree's stable node ids, so a rename changes nothing here. An id
// the tree no longer has is skipped. A node the list does not name — a
// category added after the order was set — goes AFTER the named ones, in the
// mini app's order: it shows up at the bottom and the tenant drags it in.

'use strict';

const CONFIG_KEY = 'qrMenu.categoryOrder';

const EMPTY = Object.freeze({ tops: null, subs: Object.freeze({}), hidden: Object.freeze([]), products: Object.freeze({}) });

function idList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const s = String(x == null ? '' : x).trim();
    if (s && s.length <= 64 && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

// Product ids: positive integers, each once, capped where a section is capped.
function productIdList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0 && out.indexOf(n) < 0) out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

// Coerce anything into the stored shape. Malformed parts fall back to
// "follow the mini app" / "hide nothing", never to an empty menu.
function normalise(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const tops = src.tops == null ? null : idList(src.tops);
  const subs = {};
  if (src.subs && typeof src.subs === 'object' && !Array.isArray(src.subs)) {
    for (const k of Object.keys(src.subs)) {
      const key = String(k).trim();
      const list = idList(src.subs[k]);
      if (key && list) subs[key] = list;
    }
  }
  const products = {};
  if (src.products && typeof src.products === 'object' && !Array.isArray(src.products)) {
    for (const k of Object.keys(src.products)) {
      const key = String(k).trim();
      const list = productIdList(src.products[k]);
      if (key && key.length <= 64 && list && list.length) products[key] = list;
    }
  }
  return { tops: tops && tops.length ? tops : null, subs, hidden: idList(src.hidden) || [], products };
}

// TAKES A DATABASE HANDLE, as readShownTypes does: the public menu passes
// tdb(), the admin endpoint passes tdb(), and the seam stays the caller's.
function readOrder(db) {
  let row;
  try {
    row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(CONFIG_KEY);
  } catch (e) { return normalise(EMPTY); }
  if (!row) return normalise(EMPTY);
  try { return normalise(JSON.parse(row.value_json)); } catch (e) { return normalise(EMPTY); }
}

// Named ids first, in the stored order; then everything else, in its own order.
function ordered(nodes, ids) {
  if (!ids || !ids.length) return nodes.slice();
  const pos = new Map(ids.map((id, i) => [id, i]));
  const named = nodes.filter(n => n.id && pos.has(n.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  return named.concat(nodes.filter(n => !(n.id && pos.has(n.id))));
}

// The tree as the QR menu draws it. Returns the reordered tree WITHOUT the
// hidden tops, plus the hidden tops' names — a product carries its category by
// NAME (store_products.top_category), and the menu needs the names to leave
// those products out rather than drop them into OTHER.
function applyToTree(tree, order) {
  const o = normalise(order);
  const hide = new Set(o.hidden);
  const hiddenNames = new Set();
  const out = [];
  for (const t of ordered(Array.isArray(tree) ? tree : [], o.tops)) {
    if (t.id && hide.has(t.id)) { hiddenNames.add(t.name); continue; }
    out.push(Object.assign({}, t, { subs: ordered(t.subs || [], t.id ? o.subs[t.id] : null) }));
  }
  return { tree: out, hiddenNames };
}

// One section's products in the QR menu's order: the ids the stored list names
// first, in its order; the rest after them in the order they came in (the
// mini app's). `idsOf(item)` gives every product id an item stands for — a
// collapsed variant card answers for all its sizes, and ranks by whichever of
// them the list names first.
function orderProducts(items, ids, idsOf) {
  if (!ids || !ids.length) return items.slice();
  const pos = new Map(ids.map((id, i) => [Number(id), i]));
  const rank = (it) => {
    let r = Infinity;
    for (const id of idsOf(it)) { const p = pos.get(Number(id)); if (p !== undefined && p < r) r = p; }
    return r;
  };
  const named = [], rest = [];
  for (const it of items) (rank(it) === Infinity ? rest : named).push(it);
  named.sort((a, b) => rank(a) - rank(b));
  return named.concat(rest);
}

module.exports = { CONFIG_KEY, normalise, readOrder, applyToTree, orderProducts };
