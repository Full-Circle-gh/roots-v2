//
// Seeded-review GENERATOR — the copy pools, the product→category matcher and
// the row builder, with no database of its own. Two callers share it:
//
//   • scripts/seed_synthetic_reviews.js — the manual CLI seed/clear run.
//   • lib/review-topup.js — the nightly job that keeps thin products topped up.
//
// It lives here so both paths pick from ONE set of pools and ONE matcher.
// ⚠️ categoryOf() is ORDER-SENSITIVE: every bug this generator has shipped was
// a bucket placed in the wrong slot, not a missing keyword. A new bucket goes
// AFTER anything whose compound names it would otherwise swallow (see the
// spread guard ahead of milk, and the drinks branch between milk and pantry).
//
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
  // Non-dairy drinks — juice, kombucha, tea, coffee. Refreshment + sweetness
  // level only; never 奶味 / 配麦片, which belong to the milk pool.
  drinks: [
    '很清爽,不会太甜,冰过之后更好喝。',
    '味道很正,喝起来很干净,不齁。',
    '酸甜刚刚好,下午来一瓶很解腻。',
    '冰镇后特别解渴,已经回购好几次了。',
    '气泡很自然,不像市面上那些糖水。',
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
  // Non-dairy drinks — juice, kombucha, tea, coffee. See the CN note above:
  // no creamy / cereal / "glass every morning" lines here.
  drinks: [
    'Really refreshing and not sugary at all.',
    'Lovely bright taste — best straight from the fridge.',
    'Nice balance, tart without being sharp. Reordered.',
    'My afternoon pick-me-up now. Not too sweet.',
    'Naturally fizzy, none of that syrupy aftertaste.',
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
  drinks:  ['fresh', 'tasty', 'will-buy', 'fast-ship'],
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
  // Spreads and condiments — nut/seed butters, jams, dips, dressings, sauces.
  // None of them are dairy, and all of them are caught by a dairy keyword if
  // this guard is not AHEAD of milk:
  //   • 'butter'        → "All Natural Peanut Butter"
  //   • 'cheese'        → "Nacho Cheese Dip"
  //   • '酸奶'          → "Tzatziki" (莳萝柠檬酸奶酱)
  // all of which then read as "rich and creamy, great with cereal". A dip is
  // not something you pour on cereal. Real dairy — 黄油, "Grass-fed Butter",
  // plain yogurt — matches none of these and still falls through to milk.
  //
  // The CN terms are deliberately COMPOUNDS (蘸酱 / 沙拉酱 / …) rather than a
  // bare 酱: 酱 alone would also swallow braised dishes like 酱牛肉 and pull
  // them out of the meat bucket.
  if (has('peanut butter', 'nut butter', 'almond butter', 'cashew butter', 'seed butter',
          'tahini', 'jam', 'spread', 'dip', 'salsa', 'hummus', 'pesto', 'guacamole',
          'tzatziki', 'dressing', 'mayo', 'relish', 'chutney', 'sauce',
          '花生酱', '果酱', '芝麻酱', '坚果酱', '蘸酱', '沙拉酱', '蛋黄酱',
          '酸奶酱', '奶酪酱', '番茄酱', '辣椒酱', '酱油')) return 'pantry';
  if (has('milk', '奶', 'yogurt', '酸奶', 'cream', 'cheese', '芝士', 'butter', '黄油')) return 'milk';
  // Beverages that are NOT dairy. Checked after milk (so "Coconut Milk" still
  // reads as milk) but before pantry (which claims 'tea' / 'coffee' / '茶').
  if (has('kombucha', '康普茶', 'juice', '果汁', '汁', 'tea', '茶', 'coffee', '咖啡', 'soda',
          'sparkling', 'cider', 'lemonade', 'smoothie', 'drink', '饮', '气泡')) return 'drinks';
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

// Back-date over the last `spanDays` (default ~75), weighted toward more
// recent. Returns a SQLite-friendly 'YYYY-MM-DD HH:MM:SS' UTC string (matches
// CURRENT_TIMESTAMP).
//
// `notBefore` is a floor — pass a product's created_at and the review can't be
// dated before the product existed. The nightly top-up needs this: a brand-new
// product would otherwise get reviews written weeks before it was listed, which
// is the one detail that makes a seeded feed obviously fake.
function backdatedAt(spanDays, notBefore) {
  const days = Number(spanDays) > 0 ? Number(spanDays) : 75;
  const now = Date.now();
  const skew = Math.pow(rnd(), 1.7);        // bias toward 0 = recent
  let ms = now - Math.floor(skew * days * 24 * 60 * 60 * 1000);
  if (notBefore) {
    const floor = new Date(String(notBefore).replace(' ', 'T') + 'Z').getTime();
    // Re-roll uniformly inside [floor, now] rather than clamping TO the floor,
    // which would stack every review on the product's creation timestamp.
    if (Number.isFinite(floor) && floor < now && ms < floor) {
      ms = floor + Math.floor(rnd() * (now - floor));
    }
  }
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// Build one review row for a product. Encodes the house distribution in a
// single place: 95% 5★ / 5% 4★, ~62% 中文, category-matched comment + tags.
// `avoidNames` keeps one product's reviews from repeating a reviewer.
function makeReview(p, opts = {}) {
  const cat = categoryOf(p);
  const rating = chance(0.95) ? 5 : 4;
  const lang = chance(0.62) ? 'cn' : 'en';
  const avoid = opts.avoidNames instanceof Set ? opts.avoidNames : new Set();
  let name = pick(NAMES), guard = 0;
  while (avoid.has(name) && guard++ < 20) name = pick(NAMES);
  return {
    product_id: p.id,
    reviewer_name: name,
    rating,
    comment: commentFor(cat, lang, rating),
    lang,
    tags_json: tagsFor(cat),
    created_at: backdatedAt(opts.spanDays, opts.notBefore),
  };
}

module.exports = {
  rnd, pick, chance, shuffle,
  NAMES, CN, EN, CN4, EN4, CN4_HOUSE, EN4_HOUSE, TAGS_BY_CAT,
  categoryOf, commentFor, tagsFor, backdatedAt, makeReview,
};
