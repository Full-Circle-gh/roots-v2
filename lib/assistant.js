// The voice assistant (§495): one sentence in, a plan out, nothing written.
//
// Tacet's phone app has a microphone in its header. The operator says what
// they want; this module turns the sentence into a PLAN — a few actions in
// plain words, each one a route Tacet already has — and the phone shows it,
// the operator approves, and the PHONE then calls those routes one by one
// under the operator's own login. So:
//
//   • the model never writes anything; it only says what was meant;
//   • every action is one of a FIXED list below, never free-form;
//   • every id the model returns is checked against the tenant's catalogue
//     here, and anything that does not exist is dropped;
//   • permissions stay where they are: a route refuses the phone exactly as
//     it refuses a tap, and the plan shows that refusal on its row.
//
// The catalogue the model reads is the tenant's own: stores, shops with their
// made-here listings and each listing's answers (the §492 switches), and the
// product list for stock. It is the cached static part of the prompt, so the
// second sentence in five minutes costs a fraction of the first.
//
// Pure where it can be: coercePlan, suggest, describe and toCmd take data and
// return data, and scripts/test_assistant_plan.js runs them with no model.
'use strict';

const gateway = require('./model-gateway');
const optionSwitch = require('./option-switch');
const financeWindow = require('./finance-window');
const businessDate = require('./business-date');
// Required where it is used: it pulls the database bootstrap in with it, and
// the plan's pure half is run by a test with no database of that kind.

function available() { return gateway.isConfigured(); }

const ACTION_TYPES = new Set(['answer_switch', 'stock', 'shop_open', 'ask', 'reprint']);
const ASK_WHAT = new Set(['orders_today', 'low_stock', 'stock_of', 'status']);

// ── The catalogue ────────────────────────────────────────────────────────
// Everything the model may point at, by id. Read from the tenant database on
// every plan; it is a handful of small queries.
/* An order number as a recogniser writes it — "TC 001423", "tc-001423",
   "R2026 0516 01234" — back to the way the order carries it. */
function orderNoKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ''); }
function orderNosIn(text) {
  const out = new Set();
  const re = /\b([A-Za-z]{1,3})[\s-]?(\d{4,}(?:[\s-]?\d{2,})*)\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.add(orderNoKey(m[1] + m[2]));
  return Array.from(out);
}

function catalogue(db, opts) {
  opts = opts || {};
  const stores = db.prepare(
    'SELECT id, code, name_en, name_cn FROM retail_stores WHERE COALESCE(is_active, 1) = 1 ORDER BY sort_order, id'
  ).all();
  const shops = db.prepare(
    `SELECT s.id, s.location_id, COALESCE(s.display_name_en, r.name_en) AS name_en,
            COALESCE(s.display_name_cn, r.name_cn) AS name_cn
       FROM shops s JOIN retail_stores r ON r.id = s.location_id
      WHERE COALESCE(s.is_active, 1) = 1 ORDER BY s.id`
  ).all();
  const listings = db.prepare(
    `SELECT sl.id, sl.shop_id, sl.store_product_id, sl.fulfilment_mode, sl.is_available,
            p.name_en, p.name_cn, p.sku, p.variant_label, p.variant_label_cn
       FROM shop_listings sl JOIN store_products p ON p.id = sl.store_product_id
      WHERE sl.fulfilment_mode = 'made_here' AND COALESCE(p.is_active, 1) = 1
      ORDER BY sl.shop_id, sl.sort_position, sl.id`
  ).all();
  const pids = Array.from(new Set(listings.map(l => l.store_product_id)));
  const choices = pids.length ? db.prepare(
    `SELECT c.id, o.product_id, c.label_en, c.label_cn
       FROM retail_product_option_choices c JOIN retail_product_options o ON o.id = c.option_id
      WHERE o.product_id IN (${pids.map(() => '?').join(',')})
      ORDER BY o.sort_order, o.id, c.id`
  ).all(...pids) : [];
  const off = optionSwitch.allSwitchedOff(db);   // the switch table is read only through lib/option-switch.js
  // Answers per product: one entry per label, the first choice id that carries
  // it (the §492 route takes a choice id and keys on the label).
  const answersByProduct = new Map();
  for (const c of choices) {
    const label = optionSwitch.labelOf(c);
    if (!label) continue;
    if (!answersByProduct.has(c.product_id)) answersByProduct.set(c.product_id, new Map());
    const m = answersByProduct.get(c.product_id);
    if (!m.has(label)) m.set(label, { choice_id: c.id, label, label_cn: String(c.label_cn || '').trim() });
  }
  for (const l of listings) {
    const m = answersByProduct.get(l.store_product_id);
    l.answers = m ? Array.from(m.values()).map(a => ({ ...a, off: off.has(`${l.shop_id}|${l.store_product_id}|${a.label}`) })) : [];
  }
  const products = db.prepare(
    'SELECT id, sku, name_en, name_cn FROM store_products WHERE COALESCE(is_active, 1) = 1 ORDER BY id'
  ).all();
  let status = [];
  try {
    status = db.prepare('SELECT store_code, fulfillment_open FROM store_business_status').all();
  } catch (e) { status = []; }
  let online = true;
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'store_status'").get();
    const v = row ? JSON.parse(row.value_json) : {};
    online = !(v.online_open === false || v.online_open === 0);
  } catch (e) { online = true; }
  /* THE ORDERS A SLIP CAN BE PRINTED FOR AGAIN (rule 12): the last two days'
     most recent, which is what "the last order at Yuexiu" means, plus any
     order the sentence names by number, looked up directly so an older one
     said aloud is still found. No customer details travel: number, store,
     status and time are what the model needs to pick one. */
  let orders = [];
  try {
    orders = db.prepare(`SELECT id, order_no, store_id, status, placed_at FROM retail_orders
       WHERE placed_at >= datetime('now', '-2 days') ORDER BY placed_at DESC, id DESC LIMIT 25`).all();
    const have = new Set(orders.map(o => orderNoKey(o.order_no)));
    for (const key of orderNosIn(opts.text)) {
      if (have.has(key)) continue;
      const row = db.prepare(`SELECT id, order_no, store_id, status, placed_at FROM retail_orders
         WHERE UPPER(REPLACE(REPLACE(order_no, '-', ''), ' ', '')) = ? LIMIT 1`).get(key);
      if (row) { orders.push(row); have.add(key); }
    }
  } catch (e) { orders = []; }
  return { stores, shops, listings, products, status, online, orders };
}

// ── What the model reads ─────────────────────────────────────────────────
const STATIC_PROMPT = [
  'You are the voice assistant inside Tacet, a shop back office. A shop worker said',
  '(or typed) ONE request, in English or Chinese, often garbled by speech recognition.',
  'Turn it into a PLAN of actions from the fixed list below, using only ids from the',
  'catalogue. You never do anything yourself: a person reads the plan and approves it.',
  '',
  'Actions:',
  '- answer_switch: switch one ANSWER of a made-here menu item off (sold out) or back on',
  '  at ONE shop. Fields: shop_id, listing_id, label (the answer exactly as listed), off.',
  '  "sold out", "disable", "no more", 售罄, 没了, 关掉 mean off=true; "back", "available",',
  '  "enable", 恢复, 有了 mean off=false.',
  '- stock: set or add the shelf count of a PRODUCT at a STORE. Fields: store_id,',
  '  product_id, mode ("set" or "add"), qty. "sold out" means set 0. "made"/"add"/加/做了',
  '  mean add. "left"/"remaining"/剩/还有 mean set.',
  '- shop_open: open or close. Fields: scope ("store" one shop, "all" the whole business,',
  '  "online" the online store only), store_id when scope is "store", open (true/false),',
  '  message (optional, for customers, only for "online").',
  '- reprint: print the slip for an order again, on the printer the order belongs to.',
  '  Fields: order_id, from the recent orders list. "the last order at X" is the newest',
  '  listed for that store. An order number not in the list: ask, do not guess.',
  '- ask: a QUESTION answered from the records, needing no approval. Fields: what, one of',
  '  "orders_today" (how many orders today), "low_stock" (what is running low), "stock_of"',
  '  (how many of a product are on the shelf; needs product_id), "status" (which shops are',
  '  open or closed); store_id optional on all four (omit for every store).',
  '',
  'Rules:',
  '- Phonetic and partial matches count: recognisers write Chinese characters for',
  '  English names and clip syllables. "1-50" may arrive as "150" or "one fifty".',
  '- Use the person\'s known names when given ("Ramada" means a certain store).',
  '- A shop and the store at the same location share a name: for answer_switch use the',
  '  shop_id, for stock and shop_open use the store_id.',
  '- If the sentence names something you cannot find, or two things fit equally, do NOT',
  '  guess: return a question with the candidate ids, and no actions. Put any name you',
  '  could not resolve in unknown_names, exactly as said.',
  '- One request may hold several actions. Keep them in the order said.',
  '- "say" is one or two short plain sentences, in the language of the request, stating',
  '  what you understood. No ids in it; use names.',
  'Answer only through the tool.',
].join('\n');

function catalogueText(cat) {
  const L = [];
  L.push('Stores (store_id | code | English | Chinese):');
  for (const s of cat.stores) L.push(`${s.id} | ${s.code || ''} | ${s.name_en || ''} | ${s.name_cn || ''}`);
  L.push('');
  L.push('Shops, each at one store (shop_id | store_id | English | Chinese), then their made-here');
  L.push('items (listing_id | item | sku | answers, with [off] on an answer already switched off):');
  for (const sh of cat.shops) {
    L.push(`shop ${sh.id} | store ${sh.location_id} | ${sh.name_en || ''} | ${sh.name_cn || ''}`);
    for (const l of cat.listings.filter(x => x.shop_id === sh.id)) {
      const ans = l.answers.map(a => a.label + (a.label_cn && a.label_cn !== a.label ? ' / ' + a.label_cn : '') + (a.off ? ' [off]' : '')).join('; ');
      const name = [l.name_en, l.variant_label].filter(Boolean).join(' ') + (l.name_cn ? ' / ' + [l.name_cn, l.variant_label_cn].filter(Boolean).join(' ') : '');
      L.push(`  listing ${l.id} | ${name} | ${l.sku || ''} | ${ans || '(no answers)'}`);
    }
  }
  L.push('');
  L.push('Products for stock (product_id | sku | English | Chinese):');
  for (const p of cat.products) L.push(`${p.id} | ${p.sku || ''} | ${p.name_en || ''} | ${p.name_cn || ''}`);
  return L.join('\n');
}

function dynamicText({ cat, names, answers, lang }) {
  const L = [];
  const orders = cat.orders || [];
  if (orders.length) {
    L.push('Recent orders, newest first (order_id | number | store_id | status | placed):');
    for (const o of orders) L.push(`${o.id} | ${o.order_no} | ${o.store_id == null ? '' : o.store_id} | ${o.status} | ${o.placed_at}`);
  }
  const closed = new Set((cat.status || []).filter(r => r.fulfillment_open === 0).map(r => r.store_code));
  L.push('Now: ' + cat.stores.map(s => `${s.name_en || s.code} is ${closed.has(s.code) ? 'closed' : 'open'}`).join(', ')
    + `; the online store is ${cat.online ? 'open' : 'closed'}.`);
  L.push(`The request was spoken in ${lang === 'zh' ? 'Chinese' : 'English'} mode; answer "say" in the request's own language.`);
  const n = (names || []).slice(0, 60);
  if (n.length) {
    L.push('Names this person uses that the catalogue does not:');
    for (const x of n) L.push(`"${x.heard}" means ${x.kind} ${x.target_id}`);
  }
  if (answers && Object.keys(answers).length) {
    L.push('The person has answered an earlier question; use these: ' +
      Object.entries(answers).map(([k, v]) => `${k} = ${v}`).join(', ') + '.');
  }
  return L.join('\n');
}

const TOOL = {
  name: 'plan_actions',
  description: 'The plan the request asks for, or a question when it cannot be read.',
  input_schema: {
    type: 'object',
    properties: {
      say: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['answer_switch', 'stock', 'shop_open', 'ask', 'reprint'] },
            order_id: { type: ['integer', 'null'] },
            what: { type: ['string', 'null'], enum: ['orders_today', 'low_stock', 'stock_of', 'status', null] },
            shop_id: { type: ['integer', 'null'] },
            listing_id: { type: ['integer', 'null'] },
            label: { type: ['string', 'null'] },
            off: { type: ['boolean', 'null'] },
            store_id: { type: ['integer', 'null'] },
            product_id: { type: ['integer', 'null'] },
            mode: { type: ['string', 'null'], enum: ['set', 'add', null] },
            qty: { type: ['integer', 'null'] },
            scope: { type: ['string', 'null'], enum: ['store', 'all', 'online', null] },
            open: { type: ['boolean', 'null'] },
            message: { type: ['string', 'null'] },
          },
          required: ['type'],
        },
      },
      question: {
        type: ['object', 'null'],
        properties: {
          kind: { type: 'string', enum: ['store', 'shop', 'product', 'listing', 'answer', 'free'] },
          text: { type: 'string' },
          option_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['kind', 'text'],
      },
      unknown_names: { type: 'array', items: { type: 'string' } },
    },
    required: ['say', 'actions', 'question', 'unknown_names'],
  },
};

// ── Keeping only what exists ─────────────────────────────────────────────
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : null));

function coercePlan(raw, cat) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const storeIds = new Set(cat.stores.map(s => s.id));
  const shopIds = new Set(cat.shops.map(s => s.id));
  const productIds = new Set(cat.products.map(p => p.id));
  const listingById = new Map(cat.listings.map(l => [l.id, l]));
  const actions = [];
  let dropped = 0;
  for (const x of Array.isArray(a.actions) ? a.actions : []) {
    if (!x || !ACTION_TYPES.has(x.type)) { dropped++; continue; }
    if (x.type === 'answer_switch') {
      const shopId = int(x.shop_id), listingId = int(x.listing_id);
      const l = listingId != null ? listingById.get(listingId) : null;
      const label = typeof x.label === 'string' ? x.label.trim() : '';
      const answer = l && label ? l.answers.find(z => z.label === label || (z.label_cn && z.label_cn === label) || z.label.toLowerCase() === label.toLowerCase()) : null;
      if (!shopIds.has(shopId) || !l || l.shop_id !== shopId || !answer || typeof x.off !== 'boolean') { dropped++; continue; }
      actions.push({ type: 'answer_switch', shop_id: shopId, listing_id: listingId, label: answer.label, off: x.off });
    } else if (x.type === 'stock') {
      const storeId = int(x.store_id), productId = int(x.product_id), qty = int(x.qty);
      const mode = x.mode === 'add' ? 'add' : 'set';
      if (!storeIds.has(storeId) || !productIds.has(productId) || qty == null || qty < 0 || (mode === 'add' && qty === 0)) { dropped++; continue; }
      actions.push({ type: 'stock', store_id: storeId, product_id: productId, mode, qty });
    } else if (x.type === 'shop_open') {
      const scope = x.scope === 'all' || x.scope === 'online' ? x.scope : 'store';
      const storeId = int(x.store_id);
      if (typeof x.open !== 'boolean') { dropped++; continue; }
      if (scope === 'store' && !storeIds.has(storeId)) { dropped++; continue; }
      const message = scope === 'online' && typeof x.message === 'string' ? x.message.trim().slice(0, 300) : null;
      actions.push({ type: 'shop_open', scope, store_id: scope === 'store' ? storeId : null, open: x.open, message });
    } else if (x.type === 'reprint') {
      const orderId = int(x.order_id);
      if (orderId == null || !(cat.orders || []).some(o => o.id === orderId)) { dropped++; continue; }
      actions.push({ type: 'reprint', order_id: orderId });
    } else if (x.type === 'ask') {
      const storeId = int(x.store_id), productId = int(x.product_id);
      if (!ASK_WHAT.has(x.what)) { dropped++; continue; }
      if (storeId != null && !storeIds.has(storeId)) { dropped++; continue; }
      if (x.what === 'stock_of' && !productIds.has(productId)) { dropped++; continue; }
      actions.push({ type: 'ask', what: x.what, store_id: storeId, product_id: x.what === 'stock_of' ? productId : null });
    }
  }
  let question = null;
  if (a.question && typeof a.question === 'object' && typeof a.question.text === 'string' && a.question.text.trim()) {
    const kind = ['store', 'shop', 'product', 'listing', 'answer', 'free'].includes(a.question.kind) ? a.question.kind : 'free';
    const pool = kind === 'store' ? storeIds : kind === 'shop' ? shopIds : kind === 'product' ? productIds : kind === 'listing' ? new Set(listingById.keys()) : null;
    const ids = Array.isArray(a.question.option_ids) ? a.question.option_ids.map(int).filter(v => v != null && (!pool || pool.has(v))) : [];
    question = { kind, text: a.question.text.trim().slice(0, 300), option_ids: Array.from(new Set(ids)).slice(0, 6) };
  }
  const unknown = Array.isArray(a.unknown_names) ? a.unknown_names.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 60)).slice(0, 5) : [];
  return { say: typeof a.say === 'string' ? a.say.trim().slice(0, 400) : '', actions, question, unknown_names: unknown, dropped };
}

// ── The consequences the person may not have thought of ─────────────────
// For an answer switched at one shop: the same answer on the shop's other
// made-here items, where it is not already in the asked-for state.
function suggest(cat, actions) {
  const out = [];
  const seen = new Set(actions.filter(a => a.type === 'answer_switch').map(a => `${a.shop_id}|${a.listing_id}|${a.label}`));
  for (const a of actions) {
    if (a.type !== 'answer_switch') continue;
    for (const l of cat.listings) {
      if (l.shop_id !== a.shop_id || l.id === a.listing_id) continue;
      const ans = l.answers.find(z => z.label === a.label);
      if (!ans || ans.off === a.off) continue;
      const key = `${a.shop_id}|${l.id}|${a.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: 'answer_switch', shop_id: a.shop_id, listing_id: l.id, label: a.label, off: a.off, suggested: true });
    }
  }
  return out;
}

// ── Questions, answered from the records (rule 11) ───────────────────────
// A question needs no approval, so it is answered HERE, at plan time, and the
// phone shows the words. Each one reads the same way the screen for it reads:
// today's orders by the order-date rule lib/finance-window.js owns, on the
// shop's own clock; low stock by lib/low-stock-digest.js's rule; the shelf by
// retail_store_stock. And each one asks the operator's own capabilities first:
// an operator who cannot open Orders is not told how many there were by
// asking out loud.
const ASK_CAPS = {
  orders_today: ['orders:view', 'dashboard:view'],
  low_stock: ['products:view', 'quickstock:recount', 'activity:view', 'stores:view'],
  stock_of: ['products:view', 'quickstock:recount', 'activity:view', 'stores:view'],
  status: [],
};
function mayAsk(caps, what) {
  const need = ASK_CAPS[what] || [];
  if (!need.length) return true;
  if (!(caps instanceof Set)) return true;   // RBAC dark: the route it mirrors would answer too
  return need.some(k => caps.has(k));
}
function joinNames(list, lang) { return list.join(lang === 'zh' ? '、' : ', '); }
function answerOne(db, ask, cat, caps) {
  const store = ask.store_id != null ? cat.stores.find(s => s.id === ask.store_id) : null;
  const sEn = nameOf(store, 'en'), sZh = nameOf(store, 'zh');
  if (!mayAsk(caps, ask.what)) {
    return { ...ask, refused: true, text_en: 'You don’t have permission for this', text_cn: '你没有此操作的权限' };
  }
  if (ask.what === 'orders_today') {
    const today = businessDate.businessDate(businessDate.shopTimezone(db));
    const odate = financeWindow.odateFor(businessDate.sqlDayShiftForShop(db));
    const n = db.prepare(`SELECT COUNT(*) AS n FROM retail_orders WHERE ${financeWindow.paidWhere()} AND ${odate} = @today` +
      (store ? ' AND store_id = @store' : '')).get({ today, store: store ? store.id : null }).n;
    const en = n === 0 ? `No orders yet today${store ? ' at ' + sEn : ''}`
      : `${n} ${n === 1 ? 'order' : 'orders'} today ${store ? 'at ' + sEn : 'across all stores'}`;
    const zh = n === 0 ? `${store ? sZh : ''}今天还没有订单` : (store ? `${sZh}今天 ${n} 单` : `今天共 ${n} 单`);
    return { ...ask, text_en: en, text_cn: zh, n };
  }
  if (ask.what === 'low_stock') {
    let items, count;
    if (store) {
      const lowDefault = parseInt((db.prepare("SELECT value_json FROM storefront_config WHERE key = 'inventory.lowStockThreshold'").get() || {}).value_json, 10);
      const dflt = Number.isFinite(lowDefault) && lowDefault >= 0 ? lowDefault : 5;
      const rows = db.prepare(`
        SELECT p.id, p.name_en, p.name_cn, rss.physical_qty AS qty
          FROM retail_store_stock rss JOIN store_products p ON p.id = rss.product_id
         WHERE rss.store_id = @store AND rss.physical_qty > 0
           AND rss.physical_qty <= COALESCE(p.low_stock_threshold, @dflt)
           AND COALESCE(p.is_active, 1) = 1 AND COALESCE(p.is_published, 0) = 1
         ORDER BY rss.physical_qty ASC, p.name_en ASC`).all({ store: store.id, dflt });
      count = rows.length; items = rows.slice(0, 5);
    } else {
      const low = require('./low-stock-digest').lowStockNow(db);
      count = low.count; items = low.items.slice(0, 5);
    }
    if (!count) return { ...ask, text_en: `Nothing is running low${store ? ' at ' + sEn : ''}.`, text_cn: `${store ? sZh : ''}没有库存偏低的商品。`, n: 0 };
    const more = count - items.length;
    const en = `Running low${store ? ' at ' + sEn : ''}: ` + joinNames(items.map(i => `${nameOf(i, 'en')} (${i.qty})`), 'en') + (more > 0 ? `, and ${more} more` : '');
    const zh = `${store ? sZh : ''}库存偏低：` + joinNames(items.map(i => `${nameOf(i, 'zh')}（${i.qty}）`), 'zh') + (more > 0 ? `，另有 ${more} 项` : '');
    return { ...ask, text_en: en, text_cn: zh, n: count };
  }
  if (ask.what === 'stock_of') {
    const product = cat.products.find(p => p.id === ask.product_id);
    const stores = store ? [store] : cat.stores;
    const qty = s => { const r = db.prepare('SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?').get(s.id, ask.product_id); return r ? (r.physical_qty | 0) : 0; };
    if (store) return { ...ask, text_en: `${nameOf(product, 'en')} at ${sEn}: ${qty(store)}`, text_cn: `${sZh}的${nameOf(product, 'zh')}：${qty(store)}` };
    return { ...ask,
      text_en: `${nameOf(product, 'en')}: ` + joinNames(stores.map(s => `${nameOf(s, 'en')} ${qty(s)}`), 'en'),
      text_cn: `${nameOf(product, 'zh')}：` + joinNames(stores.map(s => `${nameOf(s, 'zh')} ${qty(s)}`), 'zh') };
  }
  if (ask.what === 'status') {
    const closed = new Set((cat.status || []).filter(r => r.fulfillment_open === 0).map(r => r.store_code));
    const stores = store ? [store] : cat.stores;
    const en = stores.map(s => `${nameOf(s, 'en')} is ${closed.has(s.code) ? 'closed' : 'open'}`);
    const zh = stores.map(s => `${nameOf(s, 'zh')}${closed.has(s.code) ? '已关闭' : '营业中'}`);
    if (!store) { en.push(`the online store is ${cat.online ? 'open' : 'closed'}`); zh.push(`网店${cat.online ? '营业中' : '已关闭'}`); }
    return { ...ask, text_en: en.join('; '), text_cn: zh.join('；') };
  }
  return null;
}
function answerAll(db, asks, cat, caps) {
  const out = [];
  for (const a of asks) { try { const r = answerOne(db, a, cat, caps); if (r) out.push(r); } catch (e) { /* one unanswerable question is not a failed plan */ } }
  return out;
}

// ── Words and routes ─────────────────────────────────────────────────────
function nameOf(row, lang) {
  if (!row) return '';
  return lang === 'zh' ? (row.name_cn || row.name_en || '') : (row.name_en || row.name_cn || '');
}
function listingName(l, lang) {
  if (!l) return '';
  return lang === 'zh' ? [l.name_cn || l.name_en, l.variant_label_cn || l.variant_label].filter(Boolean).join(' ')
                       : [l.name_en || l.name_cn, l.variant_label].filter(Boolean).join(' ');
}
/* One line per action, in both languages. The Chinese is composed and
   declared in docs/tacet-delivery-vocabulary.md (§495). */
function describe(action, cat) {
  const store = cat.stores.find(s => s.id === action.store_id);
  const shop = cat.shops.find(s => s.id === action.shop_id);
  const listing = cat.listings.find(l => l.id === action.listing_id);
  const product = cat.products.find(p => p.id === action.product_id);
  if (action.type === 'answer_switch') {
    const ans = listing ? listing.answers.find(z => z.label === action.label) : null;
    const en = `${action.off ? 'Switch off' : 'Switch back on'} ${action.label} on ${listingName(listing, 'en')} at ${nameOf(shop, 'en')}`;
    const zh = `在${nameOf(shop, 'zh')}${action.off ? '关闭' : '恢复'}${listingName(listing, 'zh')}的${(ans && ans.label_cn) || action.label}`;
    return { en, zh };
  }
  if (action.type === 'stock') {
    if (action.mode === 'add') {
      return { en: `Add ${action.qty} ${nameOf(product, 'en')} at ${nameOf(store, 'en')}`, zh: `在${nameOf(store, 'zh')}为${nameOf(product, 'zh')}加 ${action.qty} 件` };
    }
    if (action.qty === 0) {
      return { en: `Mark ${nameOf(product, 'en')} sold out at ${nameOf(store, 'en')}`, zh: `将${nameOf(store, 'zh')}的${nameOf(product, 'zh')}设为售罄` };
    }
    return { en: `Set ${nameOf(product, 'en')} to ${action.qty} at ${nameOf(store, 'en')}`, zh: `将${nameOf(store, 'zh')}的${nameOf(product, 'zh')}设为 ${action.qty}` };
  }
  if (action.type === 'reprint') {
    const o = (cat.orders || []).find(x => x.id === action.order_id);
    const no = o ? o.order_no : String(action.order_id);
    const st = o && o.store_id != null ? cat.stores.find(s => s.id === o.store_id) : null;
    return { en: `Reprint the slip for order ${no}${st ? ' at ' + nameOf(st, 'en') : ''}`, zh: `重新打印${st ? nameOf(st, 'zh') : ''}订单 ${no} 的小票` };
  }
  if (action.type === 'shop_open') {
    if (action.scope === 'all') return action.open ? { en: 'Open everything', zh: '全部开启' } : { en: 'Close everything', zh: '全部关闭' };
    if (action.scope === 'online') return action.open ? { en: 'Open the online store', zh: '开启网店' } : { en: 'Close the online store', zh: '关闭网店' };
    return action.open ? { en: `Open ${nameOf(store, 'en')}`, zh: `开启${nameOf(store, 'zh')}` }
                       : { en: `Close ${nameOf(store, 'en')}`, zh: `关闭${nameOf(store, 'zh')}` };
  }
  return { en: '', zh: '' };
}

/* The route the phone calls for an action: the one that already does it. */
function toCmd(action, cat) {
  if (action.type === 'answer_switch') {
    const listing = cat.listings.find(l => l.id === action.listing_id);
    const ans = listing ? listing.answers.find(z => z.label === action.label) : null;
    if (!ans) return null;
    return { method: 'PUT', path: `/api/retail-admin/shops/${action.shop_id}/listings/${action.listing_id}/choices/${ans.choice_id}/off`, body: { off: action.off } };
  }
  if (action.type === 'stock') {
    const body = action.mode === 'add'
      ? { delta: action.qty, reason: 'kitchen_add', note: 'assistant' }
      : { physical_qty: action.qty, reason: 'adjust', note: 'assistant' };
    return { method: 'PATCH', path: `/api/retail-admin/stores/${action.store_id}/stock/${action.product_id}`, body };
  }
  if (action.type === 'reprint') {
    return { method: 'POST', path: `/api/retail-admin/orders/${action.order_id}/print`, body: {} };
  }
  if (action.type === 'shop_open') {
    if (action.scope === 'all') return { method: 'POST', path: '/api/retail-admin/store-status/master', body: { open: action.open } };
    if (action.scope === 'online') {
      const body = { open: action.open };
      if (action.message) body.message_en = action.message;
      return { method: 'POST', path: '/api/retail-admin/store-status/online', body };
    }
    const store = cat.stores.find(s => s.id === action.store_id);
    if (!store) return null;
    return { method: 'POST', path: `/api/retail-admin/store-status/store/${encodeURIComponent(store.code)}`, body: { open: action.open } };
  }
  return null;
}

/* A question's options as names the phone can show. */
function questionOptions(question, cat, lang) {
  if (!question) return [];
  const pool = question.kind === 'store' ? cat.stores : question.kind === 'shop' ? cat.shops
             : question.kind === 'product' ? cat.products : question.kind === 'listing' ? cat.listings : [];
  return question.option_ids.map(id => {
    const row = pool.find(r => r.id === id);
    if (!row) return null;
    const label = question.kind === 'listing' ? listingName(row, lang) : nameOf(row, lang);
    return { id, label: label || String(id), sku: row.sku || null };
  }).filter(Boolean);
}

/* The whole plan the phone shows: words, rows, routes. */
function buildPlan(coerced, cat, lang, answered) {
  const doing = coerced.actions.filter(a => a.type !== 'ask');
  const suggestions = suggest(cat, doing);
  const rows = [...doing.map(a => ({ ...a, suggested: false })), ...suggestions].map((a, i) => {
    const d = describe(a, cat);
    return { key: 'a' + i, type: a.type, suggested: !!a.suggested, label_en: d.en, label_cn: d.zh, cmd: toCmd(a, cat), action: a };
  }).filter(r => r.cmd);
  const question = coerced.question ? { kind: coerced.question.kind, text: coerced.question.text, options: questionOptions(coerced.question, cat, lang) } : null;
  return { say: coerced.say, actions: rows, answers: answered || [], question, unknown_names: coerced.unknown_names, dropped: coerced.dropped };
}

async function plan({ text, lang, cat, names, answers, db, caps }) {
  const sentence = String(text || '').trim().slice(0, 400);
  const result = await gateway.callModel({
    max_tokens: 700,
    system: { static: STATIC_PROMPT + '\n\n' + catalogueText(cat), dynamic: dynamicText({ cat, names, answers, lang }) },
    tools: [TOOL],
    messages: [{ role: 'user', content: `Request: ${sentence}` }],
  });
  const emitted = gateway.extractToolUse(result.content_blocks, 'plan_actions');
  const coerced = coercePlan(emitted, cat);
  const answered = db ? answerAll(db, coerced.actions.filter(a => a.type === 'ask'), cat, caps) : [];
  return buildPlan(coerced, cat, lang, answered);
}

module.exports = { available, catalogue, catalogueText, dynamicText, STATIC_PROMPT, TOOL,
  coercePlan, suggest, describe, toCmd, questionOptions, buildPlan, plan, answerOne, answerAll, mayAsk, ASK_CAPS,
  orderNoKey, orderNosIn };
