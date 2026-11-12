// Saved translations for the QR menu.
//
// The guest never waits on the model for the first paint. The page reads
// what is already saved. A pair that is not saved yet is filled after the
// page is sent, and again if the guest asks /tr while still on the page.
//
// The kitchen slip does not read this table. Orders keep the English and
// Chinese the catalogue stored.

'use strict';

const i18n = require('./qr-menu-i18n');
const modelGateway = require('./model-gateway');

const SQL = `CREATE TABLE IF NOT EXISTS qr_menu_translations (
  source_key TEXT NOT NULL,
  lang       TEXT NOT NULL,
  translated TEXT NOT NULL,
  PRIMARY KEY (source_key, lang)
)`;

const TOOL = {
  name: 'menu_translations',
  description: 'Translations of menu text into Spanish, Korean, Japanese and Arabic.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            es: { type: 'string' },
            ko: { type: 'string' },
            ja: { type: 'string' },
            ar: { type: 'string' },
          },
          required: ['id', 'es', 'ko', 'ja', 'ar'],
        },
      },
    },
    required: ['items'],
  },
};

const SYSTEM = [
  'You translate restaurant menu text for a guest standing in the shop.',
  'Each item has an id, English, and Chinese. English is the main source. Use the Chinese when the English is ambiguous or empty of meaning.',
  'Write es (Spanish), ko (Korean), ja (Japanese) and ar (Arabic).',
  'Keep every number, weight and price exactly as written.',
  'Do not add an ingredient, an allergen or a claim that is not in the source.',
  'Keep food names that are already widely used (hummus, labneh, za\'atar) recognisable inside the translation.',
  'Do not explain. Call the menu_translations tool once, with one item per id you were given.',
].join(' ');

let cache = null;
let cacheDb = null;
const pending = new Map();
let chain = Promise.resolve();
// A line the model answered by changing a number is not asked again until
// the process restarts. Retrying it on every page view would bill the same
// refusal all day. The guest keeps the English.
const gaveUp = new Set();

function loadAll(db) {
  const map = new Map();
  let rows;
  try {
    rows = db.prepare('SELECT source_key, lang, translated FROM qr_menu_translations').all();
  } catch (e) {
    if (/no such table/i.test(e.message || '')) return map;
    throw e;
  }
  for (const r of rows) {
    let row = map.get(r.source_key);
    if (!row) { row = {}; map.set(r.source_key, row); }
    row[r.lang] = r.translated;
  }
  return map;
}

function mapFor(db) {
  if (!db) return new Map();
  if (cache && cacheDb === db) return cache;
  cache = loadAll(db);
  cacheDb = db;
  return cache;
}

function invalidate() { cache = null; cacheDb = null; }

function lookup(db, key) {
  return mapFor(db).get(key) || null;
}

function miss(key, en, cn) {
  if (!pending.has(key)) pending.set(key, { key, en, cn });
}

function takePending() {
  const out = [...pending.values()];
  pending.clear();
  return out;
}

function clientMap(db) {
  const out = {};
  for (const [key, row] of mapFor(db)) out[key] = row;
  return out;
}

function keepsNumbers(src, out) {
  const nums = String(src).match(/\d+(?:\.\d+)?/g) || [];
  return nums.every((n) => String(out).includes(n));
}

function accept(srcEn, srcCn, text) {
  const t = String(text || '').trim();
  if (!t || t.length > 4000) return '';
  const src = srcEn || srcCn;
  if (!keepsNumbers(src, t)) return '';
  return t;
}

async function callFor(pairs, call) {
  const body = pairs.map((p, i) => (
    `id: ${i}\nEnglish: ${p.en || '(none)'}\nChinese: ${p.cn || '(none)'}`
  )).join('\n\n');
  const out = await call({
    system: SYSTEM,
    tools: [TOOL],
    messages: [{ role: 'user', content: body }],
    max_tokens: 4000,
  });
  const got = modelGateway.extractToolUse(out.content_blocks, 'menu_translations') || {};
  const items = Array.isArray(got.items) ? got.items : [];
  const byId = new Map(items.map((it) => [String(it && it.id), it]));
  return pairs.map((p, i) => {
    const it = byId.get(String(i)) || {};
    const row = {};
    for (const lang of i18n.EXTRA) {
      const t = accept(p.en, p.cn, it[lang]);
      if (t) row[lang] = t;
    }
    return row;
  });
}

async function doFill(db, pairs, call) {
  if (!db || !pairs || !pairs.length) return;
  const have = mapFor(db);
  const need = [];
  for (const p of pairs) {
    const key = p.key || i18n.sourceKey(p.en, p.cn);
    if (gaveUp.has(key)) continue;
    const row = have.get(key);
    if (row && i18n.EXTRA.every((l) => row[l])) continue;
    const en = String(p.en || '').slice(0, 2000);
    const cn = String(p.cn || '').slice(0, 2000);
    if (!en && !cn) continue;
    need.push({ key, en, cn });
  }
  if (!need.length) return;
  if (!call) {
    if (!modelGateway.isConfigured()) return;
    call = (args) => modelGateway.callModel(args);
  }
  const insert = db.prepare(
    'INSERT INTO qr_menu_translations (source_key, lang, translated) VALUES (?, ?, ?) ' +
    'ON CONFLICT(source_key, lang) DO UPDATE SET translated = excluded.translated'
  );
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    let rows;
    try {
      rows = await callFor(chunk, call);
    } catch (e) {
      console.warn('[qr-menu-translate]', e && (e.message || e));
      continue;
    }
    const write = db.transaction(() => {
      chunk.forEach((p, n) => {
        const row = rows[n] || {};
        let saved = 0;
        for (const lang of i18n.EXTRA) {
          if (row[lang]) { insert.run(p.key, lang, row[lang]); saved++; }
        }
        if (!saved) gaveUp.add(p.key);
      });
    });
    write();
  }
  invalidate();
}

function fill(db, pairs, call) {
  const job = chain.then(() => doFill(db, pairs, call));
  chain = job.catch(() => {});
  return job;
}

function schedule(db, pairs) {
  if (!pairs || !pairs.length) return;
  setImmediate(() => { fill(db, pairs).catch(() => {}); });
}

// The pairs a guest's page says it still needs. The key has to match the
// text, so a posted pair cannot store a translation under someone else's line.
function pairsFromBody(body) {
  const list = body && Array.isArray(body.need) ? body.need : [];
  const out = [];
  for (const p of list.slice(0, 400)) {
    const en = String(p && p.en || '').slice(0, 2000);
    const cn = String(p && p.cn || '').slice(0, 2000);
    if (!en && !cn) continue;
    if (p.key !== i18n.sourceKey(en, cn)) continue;
    out.push({ key: p.key, en, cn });
  }
  return out;
}

module.exports = {
  SQL, lookup, miss, takePending, clientMap, fill, schedule, pairsFromBody,
  invalidate, loadAll, mapFor,
};
