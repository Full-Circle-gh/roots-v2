#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seed SYNTHETIC product reviews — staff-written social-proof reviews that
// live in `retail_synthetic_reviews`, fully decoupled from real customers and
// orders. They blend into the public rating count/avg/list on the storefront
// + mini app, but stay clearly tagged as "Seeded" in the Mini App Backend
// (Content → Reviews), where each one can be hidden or hard-removed.
//
// Distribution (per the ask):
//   • 95% of reviews are 5★, 5% are 4★  (never 1–3★)
//   • realistic, varied EN + CN comments, made-up reviewer names
//     (NEVER a real customer name)
//   • spread across a RANDOM subset of published products, 1–6 each
//   • back-dated over the last ~75 days so they don't all share a timestamp
//
// RUN THIS ON THE PROD SERVER (the local data/roots.db is a stale copy with no
// retail_* tables). From the repo root on the server:
//
//   node scripts/seed_synthetic_reviews.js              # seed (default volume)
//   node scripts/seed_synthetic_reviews.js --count 200  # cap total new reviews
//   node scripts/seed_synthetic_reviews.js --dry        # preview, write nothing
//   node scripts/seed_synthetic_reviews.js --clear      # remove ALL seeded reviews
//   node scripts/seed_synthetic_reviews.js --clear --yes # clear without prompt
//
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

// ── tiny arg parser ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY    = hasFlag('--dry');
const CLEAR  = hasFlag('--clear');
const YES    = hasFlag('--yes');
const CAP    = parseInt(argVal('--count', '0'), 10) || 0; // 0 = no cap
const PER_MAX = Math.max(1, parseInt(argVal('--per-max', '6'), 10) || 6);

// ── deterministic-ish RNG helpers (plain Math.random, this is a CLI script) ──
const rnd   = () => Math.random();
const pick  = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ── made-up reviewer names (WeChat-style nicknames; none are real customers) ─
const NAMES = [
  '小敏', '阿May', '陈太', '文文', '美食生活家', '大King', 'Yumi', '一颗柠檬',
  '茉莉', '大白', '雯雯', '老广一枚', '番茄炒蛋', '七七', '阿杰', '慢生活',
  '桃子', '知足常乐', '鹿小姐', '椰子味', '静静', '十一', '黄小姐', '阿凯',
  '小米粒', '林太', '吃货一枚', '清清', '果果妈', '糖糖', '阿菲', '周先生',
  '木子', '不吃香菜', '小确幸', '海盐', '阿宝', '柚子', 'Coco', 'Cathy',
  'Linda', 'Jason', 'Emma', 'Olivia', 'Sophie L.', 'Daniel', 'Grace', 'Vivian',
  'Karen W.', 'Mike', 'Tina', 'Joyce', 'Helen', 'Andrew', 'Sam', 'Fiona',
  'Yuki', 'Megan', 'Chris', 'Ada', 'Nina', 'Leo', 'Bella', 'Ray', 'Iris',
  'Wendy', 'Kelvin', 'Doris', 'Eric', 'Mandy', 'Phoebe', 'Aaron', 'Cherry',
];

// ── comment pools. `g` = generic; the rest key off product category guesses. ─
// Kept varied in length + tone (some short, some with an emoji) so the feed
// reads like real people, not a template.
const CN = {
  // Generic pool — kept NEUTRAL (quality / packaging / delivery / value /
  // service) so it's safe for ANY product, food or not. Taste/freshness lines
  // live only in the food-specific pools below.
  g: [
    '包装很用心,物流也快,会回购。',
    '第二次买了,品质一直稳定,赞👍',
    '物流很快,第二天就到了,东西完好。',
    '客服态度很好,有问题回复很快。',
    '一如既往的好,已经推荐给同事了。',
    '包装很严实,一点没压坏,好评。',
    '质量对得起价格,会继续支持。',
    '下单到收货都很顺,体验很好。',
    '分量足,很实在,满意。',
    '挺好的,没有踩雷,放心买。',
    '用着挺好的,会继续回购。',
    '性价比不错,推荐给大家。',
  ],
  // Non-food household / cleaning / homeware — effectiveness + value, no taste.
  household: [
    '很好用,用量省,效果不错。',
    '质量挺好的,比之前用的牌子强。',
    '物流很快,包装也很稳,没有漏。',
    '一直回购的牌子,放心。',
    '性价比高,家里常备,推荐。',
    '用起来很顺手,效果看得见。',
  ],
  produce: [
    '蔬菜很新鲜,叶子很挺,没有黄叶,洗一洗就能下锅。',
    '水果很甜,熟度刚刚好,放两天更好吃。',
    '很新鲜,根部还带着泥土的感觉,放心。',
    '果子个头均匀,卖相和味道都在线。',
    '当天到货还很脆,沙拉直接生吃都没问题。',
    '难得能买到这么新鲜的,比菜市场强。',
  ],
  soup: [
    '汤底很足料,加热一下就是一顿,很方便。',
    '味道很正,不会太咸,老人家也喜欢喝。',
    '料很实在,喝起来很暖,加班回来很治愈。',
    '炖得很到位,味道浓郁,值得回购。',
  ],
  milk: [
    '奶味很浓,不甜不腻,早餐配麦片刚好。',
    '口感很顺滑,孩子每天都要喝一杯。',
    '很新鲜,没有添加的感觉,放心给家里人喝。',
    '比外面买的香,会一直回购。',
  ],
  snack: [
    '很香脆,停不下来,追剧必备😋',
    '不会太甜,配茶刚刚好。',
    '小包装很方便,带去办公室当下午茶。',
    '味道很地道,分享给朋友都说好吃。',
  ],
  meat: [
    '肉质很新鲜,没有腥味,处理得很干净。',
    '冷链做得好,到手还是冰的,放心。',
    '煎出来很嫩,家里人都说好吃。',
    '分切得很规整,份量足,很满意。',
  ],
  bakery: [
    '很松软,第二天回温一下还是很好吃。',
    '不会太甜,用料很扎实,早餐很顶。',
    '香味很足,刚拿到就忍不住吃了一个。',
  ],
  pantry: [
    '品质很好,囤一些很实用,日期也新鲜。',
    '用料很放心,做菜方便了很多。',
    '味道纯正,比之前买的牌子好。',
  ],
};
const EN = {
  // Neutral generic pool — safe for any product (no taste/freshness claims).
  g: [
    'Really well packed and quick delivery — will order again.',
    'Second time buying, quality is consistently great. 👍',
    'Arrived next day, everything in perfect condition.',
    'Smooth ordering, fast delivery, no complaints at all.',
    'Honestly better than I expected. Lovely quality.',
    'Great value for the price, definitely reordering.',
    'Packed really carefully, nothing was damaged.',
    'Quick reply from customer service when I asked. 5 stars.',
    'Generous portion and good quality. Happy customer.',
    'No surprises, just good stuff. Easy to recommend.',
    'Reliable as always — a regular order for us now.',
    'Good price, good service. Can’t fault it.',
  ],
  // Non-food household / cleaning / homeware.
  household: [
    'Works really well and a little goes a long way.',
    'Good quality — better than the brand I used before.',
    'Fast delivery, well packed, nothing leaked.',
    'A regular reorder for us now. Reliable.',
    'Great value, keep it stocked at home. Recommend.',
    'Easy to use and you can see the difference.',
  ],
  produce: [
    'Veg came in crisp and green, no wilting at all.',
    'Fruit was sweet and ripe — perfect for the week.',
    'So fresh, washed it and straight into the pan.',
    'Even sizes and great flavour. Better than the market.',
    'Still crunchy on arrival, ate it raw in a salad.',
  ],
  soup: [
    'Hearty and full of ingredients — a meal on its own.',
    'Well balanced, not too salty, even my parents liked it.',
    'So comforting after a long day. Will reorder.',
  ],
  milk: [
    'Rich and creamy, not too sweet. Great with cereal.',
    'Really smooth — my kid has a glass every morning.',
    'Tastes clean and fresh, happy to give it to the family.',
  ],
  snack: [
    'Crunchy and moreish, perfect for movie night. 😋',
    'Not too sweet, great with a cup of tea.',
    'Handy little packs for the office in the afternoon.',
  ],
  meat: [
    'Very fresh, no off smell, nicely trimmed.',
    'Cold chain held up — arrived properly chilled.',
    'Cooked up tender, everyone enjoyed it.',
  ],
  bakery: [
    'Lovely and soft, still good warmed up the next day.',
    'Not too sweet, proper ingredients, fills you up.',
    'Smelled amazing — couldn’t resist one straight away.',
  ],
  pantry: [
    'Good quality staple, nice to keep a few on hand.',
    'Reliable and fresh-dated. Makes cooking easier.',
    'Pure, clean taste — better than my old brand.',
  ],
};

// 4★ comments read slightly more measured (a small caveat), so the rare 4s
// don't sound identical to the 5s.
const CN4 = [
  '整体不错,就是希望包装再环保一点,会再回购。',
  '东西挺好的,物流稍微慢了一点,味道没话说。',
  '质量可以,价格稍微偏高,但胜在新鲜。',
  '挺满意的,下次希望分量能再多一点点。',
];
const EN4 = [
  'Good overall — would love slightly greener packaging. Still reordering.',
  'Nice quality, delivery was a touch slow, but taste was spot on.',
  'Happy with it, a little pricey but the freshness makes up for it.',
  'Pretty good, would love a slightly bigger portion next time.',
];
// Neutral 4★ caveats for non-food items (no taste/freshness).
const CN4_HOUSE = [
  '挺好用的,就是物流稍微慢了点,会再回购。',
  '质量不错,价格略高,但效果可以。',
  '整体满意,希望包装能再环保一点。',
];
const EN4_HOUSE = [
  'Works well — delivery was a touch slow, but happy overall.',
  'Good quality, a little pricey, but it does the job.',
  'Pretty good, would love slightly greener packaging.',
];

const TAGS_BY_CAT = {
  produce: ['fresh', 'value', 'will-buy', 'fast-ship'],
  soup:    ['tasty', 'will-buy', 'packed'],
  milk:    ['fresh', 'tasty', 'will-buy'],
  snack:   ['tasty', 'value', 'packed'],
  meat:    ['fresh', 'packed', 'will-buy'],
  bakery:  ['tasty', 'fresh', 'packed'],
  pantry:  ['value', 'will-buy', 'fast-ship'],
  household: ['value', 'will-buy', 'fast-ship', 'packed', 'eco'], // no taste/fresh
  g:       ['fast-ship', 'packed', 'value', 'will-buy', 'eco'],   // neutral, any product
};

// Guess a loose category from the product name so comments/tags feel on-topic.
function categoryOf(p) {
  const s = ((p.name_en || '') + ' ' + (p.name_cn || '') + ' ' +
             (p.category || '') + ' ' + (p.subcategory || '')).toLowerCase();
  const has = (...words) => words.some(w => s.includes(w));
  // Non-food first — cleaning / homeware / personal-care must NOT get
  // taste/freshness copy. (Checked before produce + pantry so e.g. "Fruit &
  // Vegetable Wash" and "Tinted Lip Oil" don't read as food.)
  if (has('wash', 'cleaner', 'cleaning', 'stain', 'remover', 'detergent', 'soap',
          'sponge', 'laundry', 'wipe', 'scrub', 'disinfect', 'sanitiz', 'dish ',
          '清洁', '洗洁', '洗衣', '去渍', '消毒', '清洗', '抹布', '海绵',
          // personal care / cosmetics (a lip oil isn't "tasty" or "fresh")
          'lip', 'balm', 'lotion', 'shampoo', 'conditioner', 'serum', 'deodorant',
          'toothpaste', 'toothbrush', 'sunscreen', 'moistur', 'cosmetic', 'makeup',
          'tinted', 'perfume', 'fragrance', 'skincare', 'shower gel',
          '唇', '护肤', '洗发', '护发', '面霜', '精华', '牙膏', '牙刷', '沐浴',
          '身体乳', '香水', '化妆', '防晒')) return 'household';
  if (has('soup', '汤', 'curry', '咖喱', 'congee', '粥', 'broth', 'stew', '炖')) return 'soup';
  if (has('milk', '奶', 'yogurt', '酸奶', 'cream', 'cheese', '芝士', 'butter', '黄油', 'drink', '饮')) return 'milk';
  if (has('meat', '肉', 'beef', '牛', 'pork', '猪', 'chicken', '鸡', 'fish', '鱼', 'seafood', '海鲜', 'prawn', '虾', 'lamb', '羊')) return 'meat';
  if (has('bread', '面包', 'cake', '蛋糕', 'pastry', 'bun', '包', 'bakery', 'croissant', 'cookie', '饼干', 'muffin')) return 'bakery';
  if (has('snack', '零食', 'chip', 'crisp', 'nut', '果仁', 'cracker', '脆', 'bar ', 'granola')) return 'snack';
  if (has('vegetable', '菜', 'fruit', '果', 'salad', '沙拉', 'organic', '有机', 'tomato', '番茄', 'apple', '苹果', 'leaf', 'green', 'berry', '莓', 'banana', '香蕉', 'lemon', '柠檬')) return 'produce';
  if (has('rice', '米', 'oil', '油', 'sauce', '酱', 'flour', '面粉', 'pasta', '意面', 'noodle', '面', 'honey', '蜂蜜', 'tea', '茶', 'coffee', '咖啡', 'spice', '调料', 'pantry', 'dry', '干货')) return 'pantry';
  return 'g';
}

function commentFor(cat, lang, rating) {
  if (rating === 4) {
    if (cat === 'household') return lang === 'cn' ? pick(CN4_HOUSE) : pick(EN4_HOUSE);
    return lang === 'cn' ? pick(CN4) : pick(EN4);
  }
  const bank = lang === 'cn' ? CN : EN;
  // ~60% category-specific (if available), else generic — keeps variety.
  const useCat = bank[cat] && chance(0.6) ? cat : 'g';
  return pick(bank[useCat]);
}

function tagsFor(cat) {
  if (!chance(0.5)) return null;            // ~half the reviews carry tags
  const pool = TAGS_BY_CAT[cat] || TAGS_BY_CAT.g;
  const n = chance(0.35) ? 2 : 1;
  return JSON.stringify(shuffle(pool).slice(0, n));
}

// Back-date over the last ~75 days, weighted toward more recent. Returns a
// SQLite-friendly 'YYYY-MM-DD HH:MM:SS' UTC string (matches CURRENT_TIMESTAMP).
function backdatedAt() {
  const span = 75 * 24 * 60 * 60 * 1000;
  const skew = Math.pow(rnd(), 1.7);        // bias toward 0 = recent
  const ms = Date.now() - Math.floor(skew * span);
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ─────────────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Bail loudly if this is the stale local copy with no retail schema.
const tableMissing = (name) => !db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
).get(name);
if (tableMissing('store_products')) {
  console.error('✗ store_products not found — this looks like a stale local DB. Run this ON the prod server.');
  process.exit(1);
}

// Ensure the synthetic table exists (mirrors database.js, so the script is
// safe to run even before the server with the new schema has restarted).
db.exec(`CREATE TABLE IF NOT EXISTS retail_synthetic_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  reviewer_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  lang TEXT,
  tags_json TEXT,
  is_visible INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_synth_reviews_product ON retail_synthetic_reviews(product_id, is_visible, created_at)'); } catch {}

if (CLEAR) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews').get().n;
  if (!n) { console.log('Nothing to clear — 0 seeded reviews.'); process.exit(0); }
  if (!YES && !DRY) {
    console.log(`About to DELETE all ${n} seeded reviews. Re-run with --yes to confirm (or --dry to preview).`);
    process.exit(0);
  }
  if (DRY) { console.log(`[dry] would delete ${n} seeded reviews.`); process.exit(0); }
  db.prepare('DELETE FROM retail_synthetic_reviews').run();
  console.log(`✓ Removed ${n} seeded reviews.`);
  process.exit(0);
}

// Eligible products: published + active so we only seed the live catalogue.
// (Columns guarded — fall back gracefully if a flag column is absent.)
const cols = db.prepare("PRAGMA table_info('store_products')").all().map(c => c.name);
const pubCol = cols.includes('is_published') ? 'is_published' : null;
const actCol = cols.includes('is_active') ? 'is_active' : null;
const catCol = cols.includes('category') ? 'category' : null;
const subCol = cols.includes('subcategory') ? 'subcategory' : null;
const filt = [pubCol ? `${pubCol} = 1` : null, actCol ? `${actCol} = 1` : null].filter(Boolean);
const sql = `SELECT id, name_en, name_cn${catCol ? ', ' + catCol + ' AS category' : ''}${subCol ? ', ' + subCol + ' AS subcategory' : ''}
             FROM store_products ${filt.length ? 'WHERE ' + filt.join(' AND ') : ''}`;
const products = db.prepare(sql).all();
if (!products.length) { console.error('✗ No eligible products found.'); process.exit(1); }

// Pick a RANDOM ~60% of products to receive reviews; each gets 1..PER_MAX,
// weighted toward the low end so the feed looks organic.
const chosen = shuffle(products).filter(() => chance(0.6));
const insert = db.prepare(
  `INSERT INTO retail_synthetic_reviews (product_id, reviewer_name, rating, comment, lang, tags_json, created_at)
   VALUES (@product_id, @reviewer_name, @rating, @comment, @lang, @tags_json, @created_at)`
);

let made = 0;
const sample = [];
// Build every review row first (pure generation, no DB writes), so --dry can
// preview the exact same rows that a real run would insert.
const rows = [];
for (const p of chosen) {
  if (CAP && made >= CAP) break;
  const cat = categoryOf(p);
  // weighted count: mostly 1–3, occasionally up to PER_MAX
  const roll = rnd();
  const count = roll < 0.45 ? 1 : roll < 0.75 ? 2 : roll < 0.9 ? 3 : (3 + Math.floor(rnd() * (PER_MAX - 2)));
  const usedNames = new Set();
  for (let i = 0; i < count; i++) {
    if (CAP && made >= CAP) break;
    let name = pick(NAMES);
    let guard = 0;
    while (usedNames.has(name) && guard++ < 10) name = pick(NAMES);
    usedNames.add(name);
    const rating = chance(0.95) ? 5 : 4;
    const lang = chance(0.62) ? 'cn' : 'en';
    rows.push({
      product_id: p.id,
      reviewer_name: name,
      rating,
      comment: commentFor(cat, lang, rating),
      lang,
      tags_json: tagsFor(cat),
      created_at: backdatedAt(),
      product: p.name_en || p.name_cn,
    });
    made++;
  }
}
for (const r of rows) if (sample.length < 12) sample.push(r);
if (!DRY) {
  const run = db.transaction((items) => {
    for (const r of items) {
      // strip the display-only `product` key — better-sqlite3 rejects keys
      // that don't match a named parameter.
      insert.run({
        product_id: r.product_id, reviewer_name: r.reviewer_name, rating: r.rating,
        comment: r.comment, lang: r.lang, tags_json: r.tags_json, created_at: r.created_at,
      });
    }
  });
  run(rows);
}

const total = DRY ? null : db.prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews').get().n;
console.log('');
console.log(`${DRY ? '[dry] ' : '✓ '}${DRY ? 'would seed' : 'seeded'} ${made} reviews across ${chosen.length} products (of ${products.length} eligible).`);
console.log(`   ratings: ~95% 5★ / ~5% 4★   ·   languages: ~62% 中文 / 38% EN`);
if (!DRY) console.log(`   retail_synthetic_reviews now holds ${total} rows.`);
console.log('');
console.log('Sample:');
for (const s of sample) {
  console.log(`   ${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)} [${s.lang}] ${s.product ? '(' + String(s.product).slice(0, 22) + ') ' : ''}${s.comment}`);
}
console.log('');
console.log('Manage them in the Mini App Backend → Content → Reviews (each seeded row has a Remove button),');
console.log('or clear everything with:  node scripts/seed_synthetic_reviews.js --clear --yes');
