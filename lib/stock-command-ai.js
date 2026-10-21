// Saying a stock change (§493) — the model's reading of a sentence the phone
// could not read on its own.
//
// Quick Stock's parser in public/m.html reads most sentences by itself: a sku
// said plainly, a product named in full, a phrase this operator has said
// before. What it cannot do is hear through a recogniser's mistakes — "homeless"
// for hummus, 哈姆斯 for the same word said in Chinese, a name clipped to its
// first syllable in a noisy kitchen. That is a language job, so it goes to the
// model, through lib/model-gateway like every other model call here.
//
// WHAT THE MODEL IS GIVEN. The tenant's catalogue (id, sku, both names) as the
// cached static system text, so the second call in five minutes reads it at a
// fraction of the price; the stores this operator may write to; what a bare
// number means on their screen; and the mishearings already learned for this
// person, so the model knows how their recogniser tends to write. It answers
// through one forced tool, and coerceAnswer() below keeps only what exists:
// an id the catalogue does not hold, a store the operator does not hold, an
// action that is not set/add, a quantity that is not a whole number — all
// dropped. The phone then shows the card and the operator confirms, exactly
// as for a sentence the phone read itself. Nothing is written from here.
'use strict';

const gateway = require('./model-gateway');

function available() { return gateway.isConfigured(); }

const STATIC_PROMPT = [
  'You read ONE sentence a shop worker said (or typed) into a stock-counting app, in',
  'English or Chinese, often garbled by speech recognition. Decide which product in',
  'the catalogue below they mean, which store, whether they are SETTING the count or',
  'ADDING to it, and the quantity.',
  '',
  'Rules:',
  '- Phonetic and partial matches count. A recogniser writes Chinese characters for',
  '  English names and English letters for Chinese ones; it drops syllables; it writes',
  '  a sku like "1-50" as "150", "1 50" or "one fifty".',
  '- "sold out", "out of stock", "none left", 售罄, 缺货, 卖完了, 没了, 没有了 mean',
  '  action "set" and qty 0.',
  '- "add", "made", "plus", 加, 做了, 新增, 入库 mean action "add". "left", "remaining",',
  '  "set", "there are", 剩, 还有, 设为, 库存 mean action "set".',
  '- A bare number with no such word means whatever the request says a bare number',
  '  means on this screen.',
  '- Quantities may be digits, English words or Chinese numerals (两个 = 2, 二十五 = 25).',
  '- A store is named by its English name, Chinese name or code. If none is named,',
  '  leave store_id null.',
  '- If two or more products fit equally, give them all in candidate_ids and leave',
  '  product_id null. Never invent a product or a store that is not listed.',
  '- Use the person\'s known mishearings when given: they say how THEIR recogniser',
  '  writes certain products.',
  'Answer only through the tool.',
].join('\n');

const TOOL = {
  name: 'read_stock_change',
  description: 'The stock change the sentence asks for.',
  input_schema: {
    type: 'object',
    properties: {
      product_id:    { type: ['integer', 'null'], description: 'The one product meant, or null if unsure between several.' },
      candidate_ids: { type: 'array', items: { type: 'integer' }, description: 'Products that fit when product_id is null; at most 3, best first.' },
      store_id:      { type: ['integer', 'null'], description: 'The store named, or null if none was.' },
      action:        { type: ['string', 'null'], enum: ['set', 'add', null] },
      qty:           { type: ['integer', 'null'], description: 'Whole number, 0 or more; null if none was said.' },
      confidence:    { type: 'number', description: '0 to 1.' },
      reason:        { type: 'string', description: 'One short line, for the log.' },
    },
    required: ['product_id', 'candidate_ids', 'store_id', 'action', 'qty', 'confidence'],
  },
};

function catalogueText(products) {
  return 'Catalogue (id | sku | English name | Chinese name):\n' +
    products.map(p => `${p.id} | ${p.sku || ''} | ${p.name_en || ''} | ${p.name_cn || ''}`).join('\n');
}

function dynamicText({ stores, storeId, defaultAction, heard }) {
  const lines = [];
  lines.push('Stores this person may write to (id | code | English | Chinese):');
  for (const s of stores) lines.push(`${s.id} | ${s.code || ''} | ${s.name_en || ''} | ${s.name_cn || ''}`);
  lines.push(`The store on their screen now: ${storeId == null ? 'none' : storeId}.`);
  lines.push(`On this screen a bare number means action "${defaultAction === 'add' ? 'add' : 'set'}".`);
  const h = Object.entries(heard || {}).slice(0, 60);
  if (h.length) {
    lines.push('This person\'s recogniser has written these phrases for these product ids before:');
    for (const [phrase, pid] of h) lines.push(`"${phrase}" -> ${pid}`);
  }
  return lines.join('\n');
}

/* Keep only what exists. Pure, so scripts/test_stock_command_ai.js can run it
   without a model. */
function coerceAnswer(raw, products, stores) {
  const ids = new Set((products || []).map(p => Number(p.id)));
  const sids = new Set((stores || []).map(s => Number(s.id)));
  const a = raw && typeof raw === 'object' ? raw : {};
  const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : null));
  let productId = int(a.product_id);
  if (productId != null && !ids.has(productId)) productId = null;
  let candidates = Array.isArray(a.candidate_ids) ? a.candidate_ids.map(int).filter(v => v != null && ids.has(v) && v !== productId) : [];
  candidates = Array.from(new Set(candidates)).slice(0, 3);
  // One candidate and no product is one product.
  if (productId == null && candidates.length === 1) { productId = candidates[0]; candidates = []; }
  let storeId = int(a.store_id);
  if (storeId != null && !sids.has(storeId)) storeId = null;
  const action = a.action === 'set' || a.action === 'add' ? a.action : null;
  let qty = int(a.qty);
  if (qty != null && qty < 0) qty = null;
  const confidence = typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
  return { product_id: productId, candidates, store_id: storeId, action, qty, confidence,
    reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' };
}

async function understand({ text, products, stores, storeId, defaultAction, heard }) {
  const sentence = String(text || '').trim().slice(0, 300);
  if (!sentence) return coerceAnswer(null, products, stores);
  const result = await gateway.callModel({
    max_tokens: 300,
    system: { static: STATIC_PROMPT + '\n\n' + catalogueText(products), dynamic: dynamicText({ stores, storeId, defaultAction, heard }) },
    tools: [TOOL],
    messages: [{ role: 'user', content: `Sentence: ${sentence}` }],
  });
  const emitted = gateway.extractToolUse(result.content_blocks, 'read_stock_change');
  return coerceAnswer(emitted, products, stores);
}

module.exports = { available, understand, coerceAnswer, STATIC_PROMPT, TOOL, catalogueText, dynamicText };
