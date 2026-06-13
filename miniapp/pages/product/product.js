// Product detail page. Wired by:
//   wx.navigateTo({ url: '/pages/product/product?id=' + product.id })
// from anywhere a product is tappable (home blocks, shop grid, etc.).
// Reads /api/retail/products/:id which already returns full details
// including options[].choices[] for any per-product Q&A.

const api   = require('../../utils/api');
const lang  = require('../../utils/lang');
const cart  = require('../../utils/cart');
const track = require('../../utils/track');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

// Make every <img> in an office-authored rich description safe for WeChat
// <rich-text>. Inside <rich-text> external CSS is ignored, so each image is
// sized purely by its own inline style/attributes: a tall "scroll strip" or
// any image carrying a fixed pixel width (or a width=/height= attribute)
// renders at natural size and the right edge gets clipped off-screen. We strip
// those and force a clean responsive style so the image always fits the column
// and shows in full. Legacy images saved before the editor added a style get
// fixed too.
function normalizeRichImages(html) {
  if (!html || html.indexOf('<img') === -1) return html || '';
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = m ? (m[2] || m[3] || m[4] || '') : '';
    if (!src) return tag;
    return '<img src="' + src + '" style="max-width:100%;height:auto;display:block;margin:8px auto;" />';
  });
}

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function formatReviewDate(iso, L) {
  if (!iso || iso.length < 10) return '';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || !d) return '';
  return L === 'cn' ? `${m}月${d}日` : `${MONTHS_SHORT[m - 1]} ${d}`;
}

// Tag-chip labels + colours live in storefront_config (editable from
// /retail-admin → Reviews). This fallback only runs on a cold launch
// before config has loaded. Tag *ids* are what we persist in the DB.
const DEFAULT_REVIEW_TAGS = [
  { id: 'fresh',     en: 'Super fresh',     cn: '很新鲜', color: 'lime'     },
  { id: 'tasty',     en: 'Tastes great',    cn: '味道好', color: 'papaya'   },
  { id: 'fast-ship', en: 'Fast ship',       cn: '发货快', color: 'sky'      },
  { id: 'packed',    en: 'Great packaging', cn: '包装好', color: 'corn'     },
  { id: 'value',     en: 'Worth it',        cn: '值得',   color: 'pea'      },
  { id: 'eco',       en: 'Eco-friendly',    cn: '环保',   color: 'cucumber' },
  { id: 'will-buy',  en: 'Will reorder',    cn: '会回购', color: 'pink'     },
];

// Social proof — turns the server's resolved { count, window } into a short
// localized line. The server only sends a window it has real data for (see
// socialProofForProduct in routes/retail.js), so we never invent a number.
function socialProofText(sp, L) {
  if (!sp || !sp.count) return '';
  const n = sp.count;
  if (L === 'cn') {
    if (sp.window === 'today') return `今日 ${n} 人购买`;
    if (sp.window === 'week')  return `本周 ${n} 人购买`;
    if (sp.window === 'month') return `近30天 ${n} 人购买`;
    return `${n} 人已购买`;
  }
  const ppl = n === 1 ? 'person' : 'people';
  if (sp.window === 'today') return `${n} ${ppl} bought this today`;
  if (sp.window === 'week')  return `${n} ${ppl} bought this in the past week`;
  if (sp.window === 'month') return `${n} ${ppl} bought this in the past month`;
  return n === 1 ? '1 person has bought this' : `${n} people have bought this`;
}

// "Last ordered X ago" — a freshness/urgency nudge from the most recent sale.
// Only shown when genuinely recent (< 24h) AND the bought-count line isn't
// already signalling recent activity (today/week windows), so the two lines
// stay complementary rather than redundant.
function recencyText(sp, L) {
  if (!sp || !sp.last_order_ms) return '';
  if (sp.window === 'today' || sp.window === 'week') return '';
  const ms = Date.now() - sp.last_order_ms;
  if (ms < 0 || ms > 24 * 3600 * 1000) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1)  return L === 'cn' ? '刚刚有人下单' : 'Just ordered';
  if (min < 60) return L === 'cn' ? `${min} 分钟前有人下单` : `Last ordered ${min} min ago`;
  const hr = Math.floor(min / 60);
  return L === 'cn' ? `${hr} 小时前有人下单` : `Last ordered ${hr}h ago`;
}

// Live "N people viewing now" — only meaningful with at least one OTHER
// person present, so we hide it below 2 (a lone viewer seeing "1 viewing"
// reads as broken). Count comes from the server's in-memory presence map.
function viewingText(n, L) {
  if (!n || n < 2) return '';
  return L === 'cn' ? `${n} 人正在浏览` : `${n} people viewing now`;
}

function reviewTagMap() {
  const cfg = getApp()?.globalData?.config;
  const list = (cfg?.reviews?.tags && cfg.reviews.tags.length)
    ? cfg.reviews.tags
    : DEFAULT_REVIEW_TAGS;
  const out = {};
  for (const t of list) out[t.id] = { en: t.en || '', cn: t.cn || '', color: t.color || 'lime' };
  return out;
}

Page({
  data: {
    id: null,
    product: null,
    image: '',
    aspectRatio: '',
    name: '',
    subtitle: '',
    price: '',
    priceN: 0,
    isFlash: false,
    flashWas: '',
    priceWas: '',
    saveLabel: '',
    images: [],
    heroIndex: 0,
    descHtml: '',
    flashOff: '',
    flashEnds: '',
    flashCountdown: null,  // { d, h, m, s } padded strings; null when not on flash or ended
    flashEnded: false,
    description: '',
    descriptionParts: [], // [{ kind: 'heading'|'para', text }] (legacy renderer)
    descriptionBlocks: [], // designer-block array — when non-empty, replaces descriptionParts
    size: '',           // weight string e.g. "330ml" — shown big right of name
    keywords: '',       // bilingual short descriptors (e.g. "raw, alive")
    tagline: '',        // bold one-liner slogan
    taglineSegments: [], // [{kind:'plain'|'mark', text}] — pre-parsed for [[ink-mark]]
    colophonImg: '',     // resolved IP-character image path
    colophonTagline: '', // resolved tagline text ("From Soil to Soul" or override)
    badges: [],
    options: [],
    optionsSingle: [],     // 'single'/'text' groups → first (dressing) sheet
    optionsExtra: [],      // 'multi' groups → second (paid extras) sheet
    selectedChoices: {},   // { [option_id]: choice_id (single) | [choice_id] (multi) }
    choiceSel: {},         // { [choice_id]: true } — flat map for the WXML "on" state
    bundle: null,          // "buy together" set (resolved item cards) or null
    whatsInside: null,     // bundle PRODUCT component list ("what's inside") or null
    hasVariants: false,    // ≥2 purchasable siblings → "Add" opens the size picker
    // Variant size-picker bottom sheet (same UX as the shop grid's +). Opened
    // from "Add to basket" when the product has ≥2 siblings; choosing a size
    // adds that specific sibling (its own price / stock) to the cart.
    vpShow: false,
    vpName: '',
    vpTitle: 'Choose a size',
    vpOptions: [],
    // Options picker bottom sheet (dressing, spice level…). Opened from "Add to
    // basket" when the product has customer choices, so the pick is unmissable.
    opShow: false,
    opTitle: 'Choose your options',
    opAddLabel: 'Add to basket',
    // Second sheet: optional paid extras (pickles, sauce…), shown after the
    // dressing sheet. Multi-select; sold-out extras are greyed out.
    exShow: false,
    exTitle: 'Add extras?',
    exAddLabel: 'Add to basket',
    oosLabel: 'SOLD OUT',
    qty: 1,
    lang: 'en',
    loading: true,
    notFound: false,
    addBtnLabel: 'ADD TO BASKET',
    soldOut: false,
    stockTag: '',          // 'Only 3 left' / 'Sold out' / ''
    stockTagKind: '',      // 'low' | 'out' | ''
    reviewAvg: 0,          // avg rating
    reviewAvgDisplay: '',  // '4.7' or ''
    reviewCount: 0,        // count
    reviewStars: ['off', 'off', 'off', 'off', 'off'],
    reviewsRecent: [],
    nutritionBasis: '',    // resolved label e.g. "Per 100ml" / "每100毫升"
    nutritionRows: [],     // [{label, value}]
    hasNutritionBlock: false,  // design renders nutrition inline → hide the panel
    socialProof: '',       // "N people bought this today" — '' hides the line
    recency: '',           // "Last ordered X ago" — '' hides the line
    viewingCount: 0,       // live concurrent viewers (from presence heartbeat)
    viewingText: '',       // "N people viewing now" — '' hides the line (count < 2)
    isFavorited: false,    // heart pip state — driven by /api/retail/favorites/ids
    favoritePending: false, // de-dupe rapid taps on the pip
  },

  async onLoad(query) {
    const id = parseInt(query.id, 10);
    if (!id) { this.setData({ notFound: true, loading: false }); return; }
    const app = getApp();
    this.setData({ id, lang: app.globalData.lang });
    await this.refresh();
    this.refreshFavoriteState();
  },

  onShow() {
    const app = getApp();
    if (app.globalData.lang !== this.data.lang) {
      this.setData({ lang: app.globalData.lang });
      this.recomputeDisplay();
    }
    // On a not-found page there's no product to tick / ping for — skip the
    // background timers so we don't keep hammering /viewing for a dead id
    // (which felt like the app was stuck on a frozen page).
    if (this.data.notFound) return;
    this.startFlashTick();
    this.startViewingPing();
    // User may have removed this product from favorites on another tab;
    // re-check on every show so the heart pip stays accurate.
    this.refreshFavoriteState();
  },

  async refreshFavoriteState() {
    const app = getApp();
    if (!app.globalData.token || !this.data.id) return;
    try {
      const ids = await api.get('/api/retail/favorites/ids');
      const list = Array.isArray(ids) ? ids : (ids?.data || []);
      this.setData({ isFavorited: list.includes(this.data.id) });
    } catch {}
  },

  async onFavoriteToggle() {
    if (this.data.favoritePending || !this.data.id) return;
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
      if (!app.globalData.token) return;
    }
    const next = !this.data.isFavorited;
    this.setData({ isFavorited: next, favoritePending: true });
    try {
      if (next) await api.post('/api/retail/favorites/' + this.data.id);
      else      await api.del('/api/retail/favorites/' + this.data.id);
    } catch (e) {
      // Roll back the optimistic toggle on failure.
      this.setData({ isFavorited: !next });
      console.warn('[product] favorite toggle failed:', e.message);
    } finally {
      this.setData({ favoritePending: false });
    }
  },

  onHide()   { this.stopFlashTick(); this.stopViewingPing(true); },
  onUnload() { this.stopFlashTick(); this.stopViewingPing(true); },

  // ─── "N viewing now" presence heartbeat ────────────────────────────
  // Ping while the page is open so the server keeps us in its live-viewer
  // set; on leave, send one { leaving:true } ping so our slot frees fast
  // instead of waiting for the server's TTL to expire.
  startViewingPing() {
    this.stopViewingPing();
    this.pingViewing(false);
    this._viewTimer = setInterval(() => this.pingViewing(false), 25000);
  },
  stopViewingPing(leaving) {
    if (this._viewTimer) { clearInterval(this._viewTimer); this._viewTimer = null; }
    if (leaving) this.pingViewing(true);
  },
  async pingViewing(leaving) {
    if (!this.data.id) return;
    try {
      const res = await api.post('/api/retail/products/' + this.data.id + '/viewing', {
        viewer_id: track.getSession(),
        leaving: !!leaving,
      });
      if (leaving) return;  // page is going away — don't touch UI
      const count = Number(res && res.count) || 0;
      this.setData({ viewingCount: count, viewingText: viewingText(count, this.data.lang) });
    } catch (e) {
      // Presence is nice-to-have — never surface a failure to the user.
    }
  },

  startFlashTick() {
    this.stopFlashTick();
    this._flashTick = setInterval(() => this.recomputeFlashCountdown(), 1000);
    this.recomputeFlashCountdown();
  },
  stopFlashTick() {
    if (this._flashTick) { clearInterval(this._flashTick); this._flashTick = null; }
  },

  recomputeFlashCountdown() {
    if (!this.data.isFlash || !this.data.flashEnds) {
      if (this.data.flashCountdown || this.data.flashEnded) {
        this.setData({ flashCountdown: null, flashEnded: false });
      }
      return;
    }
    const ms = new Date(this.data.flashEnds).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) {
      if (!this.data.flashEnded) this.setData({ flashCountdown: null, flashEnded: true });
      return;
    }
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600);  s -= h * 3600;
    const m = Math.floor(s / 60);    s -= m * 60;
    const pad = n => (n < 10 ? '0' + n : '' + n);
    this.setData({
      flashCountdown: { d: pad(d), h: pad(h), m: pad(m), s: pad(s), showDays: d > 0 },
      flashEnded: false,
    });
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const p = await api.get('/api/retail/products/' + this.data.id);
      this.setData({ product: p, loading: false });
      this.recomputeDisplay();
    } catch (e) {
      console.warn('[product] load failed:', e.message);
      this.setData({ notFound: true, loading: false });
    }
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  recomputeDisplay() {
    const p = this.data.product;
    const L = this.data.lang;
    if (!p) return;
    const img = absUrl(p.image_url) || p.image_data || '';
    // Photo gallery — normalise each entry (data-URIs pass through; relative
    // URLs get absolutised). Drives the hero swiper when there's >1 photo.
    const gallery = (Array.isArray(p.images) ? p.images : [])
      .filter(Boolean)
      .map(s => (typeof s === 'string' && s.indexOf('data:') === 0) ? s : (absUrl(s) || s));
    // Use the server-resolved effective_price so what we charge matches
    // what we display (flash sale auto-applies when active).
    const regular = Number(p.price ?? p.sell_price) || 0;
    const v = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
    const isFlash = !!p.is_on_flash && v < regular;
    const flashWas = isFlash ? '¥' + regular.toFixed(2) : '';
    const flashOff = isFlash && regular > 0 ? '-' + Math.round(((regular - v) / regular) * 100) + '%' : '';
    const flashEnds = isFlash && p.flash?.ends_at ? p.flash.ends_at : '';
    // Compare-at "was" price for a single (non-variant) product — shown
    // struck-through in the add button with a SAVE badge. Flash takes priority.
    const cmp = Number(p.compare_at_price) || 0;
    const hasCmp = !isFlash && cmp > v && v > 0;
    const priceWas = hasCmp ? '¥' + cmp.toFixed(2) : '';
    const saveN = hasCmp ? Math.round((cmp - v) * 100) / 100 : 0;
    const saveLabel = saveN > 0 ? (L === 'cn' ? '省¥' : 'SAVE ¥') + (Number.isInteger(saveN) ? saveN : saveN.toFixed(2)) : '';
    // free_of (comma list like "gluten,nuts") → allergen-free badges. The whole
    // shop is 100% plant-based, so EVERY product also carries the PLANT-BASED
    // badge by default (regardless of `free_of`). EGG FREE is intentionally
    // hidden — it's redundant in an all-plant catalogue.
    // Lowercase on the way in so matching is case-insensitive — the store
    // editor / legacy data can carry "Egg", "Animal Products", etc.
    const freeOf = (p.free_of || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const badgeMap = {
      gluten: { en: 'GLUTEN FREE', cn: '无麸质' },
      nuts:   { en: 'NUT FREE',    cn: '无坚果' },
      soy:    { en: 'SOY FREE',    cn: '无大豆' },
      dairy:  { en: 'DAIRY FREE',  cn: '无乳制品' },
      '5spice': { en: '5-SPICE FREE', cn: '无五香' },
    };
    const hiddenFreeOf = new Set(['egg', 'animal products']);
    const plantBased = lang.pick('PLANT-BASED', '纯植物', L);
    const freeBadges = freeOf
      .filter(k => !hiddenFreeOf.has(k))
      .map(k => {
        // The store editor stores the 5-spice token as "5 spice" (with a space)
        // while the badge key is "5spice"; collapse spaces for the lookup so it
        // doesn't fall through to a raw, untranslated "5 SPICE" badge.
        const bk = k.replace(/\s+/g, '');
        return badgeMap[bk] ? lang.pick(badgeMap[bk].en, badgeMap[bk].cn, L) : k.toUpperCase();
      });
    const badges = [plantBased, ...freeBadges];
    // Pre-resolve option labels for the WXML. A choice linked to a stock product
    // (a paid extra) is greyed + unselectable when that product is sold out.
    const options = (p.options || []).map(o => ({
      ...o,
      question: lang.pick(o.question_en, o.question_cn, L),
      choices: (o.choices || []).map(c => ({
        ...c,
        label: lang.pick(c.label_en, c.label_cn, L),
        delta_text: Number(c.price_delta) ? (Number(c.price_delta) > 0 ? '+¥' + Number(c.price_delta).toFixed(2) : '−¥' + Math.abs(Number(c.price_delta)).toFixed(2)) : '',
        sold_out: !!c.stock_product_id && c.addon_available === false,
      })),
    }));
    // Split: 'single'/'text' = the dressing-style first sheet; 'multi' = the
    // paid extras shown in a SECOND sheet after the dressing.
    const optionsSingle = options.filter(o => o.type !== 'multi');
    const optionsExtra  = options.filter(o => o.type === 'multi');
    // Pre-pick defaults: a scalar choice_id for single/text, an array for multi
    // (only defaults that are in stock).
    const selected = { ...this.data.selectedChoices };
    options.forEach(o => {
      if (o.type === 'multi') {
        if (Array.isArray(selected[o.id])) return;
        selected[o.id] = o.choices.filter(c => c.is_default && !c.sold_out).map(c => c.id);
      } else {
        if (selected[o.id] != null) return;
        const def = o.choices.find(c => c.is_default);
        if (def) selected[o.id] = def.id;
        else if (o.is_required && o.choices.length === 1) selected[o.id] = o.choices[0].id;
      }
    });
    // Variant siblings (decorated server-side with effective price + stock).
    // Kept raw on the instance for the size picker; ≥2 members → "Add" opens
    // the picker instead of adding the viewed product directly.
    this._variants = Array.isArray(p.variants) ? p.variants : [];
    const hasVariants = this._variants.length > 1;
    // Stock state — null means untracked (treat as in-stock).
    let soldOut = false, stockTag = '', stockTagKind = '';
    if (hasVariants) {
      // Variant product: sold out only when EVERY size is out. Per-size
      // "Only N left" lives in the picker, so the hero badge stays quiet.
      soldOut = this._variants.every(v => v.stock != null && Number(v.stock) <= 0);
    } else if (p.stock != null) {
      if (Number(p.stock) <= 0) {
        soldOut = true;
        stockTag = L === 'cn' ? '已售罄' : 'SOLD OUT';
        stockTagKind = 'out';
      } else if (Number(p.stock) <= 5) {
        stockTag = L === 'cn' ? '仅剩 ' + p.stock + ' 件' : 'Only ' + p.stock + ' left';
        stockTagKind = 'low';
      }
    }

    // Nutrition panel — server returns either null or
    //   { basis_en, basis_cn, rows: [{label_en,label_cn,value}] }
    // v1 design wants parent/child classification so Energy / Total fat /
    // Carbohydrate render bold (with forest value colour) and their child
    // rows (Saturated / Unsaturated / Sugars) render indented with em-dash.
    // Classification is by label match — case-insensitive, EN/CN aware.
    let nutritionBasis = '', nutritionRows = [];
    if (p.nutrition && typeof p.nutrition === 'object') {
      nutritionBasis = lang.pick(p.nutrition.basis_en, p.nutrition.basis_cn, L);
      const PARENT = ['energy', 'total fat', 'fat', 'carbohydrate', 'carbohydrates', '能量', '脂肪', '总脂肪', '碳水化合物'];
      const CHILD  = ['saturated', 'saturated fat', 'unsaturated', 'unsaturated fat', 'sugars', '饱和脂肪', '不饱和脂肪', '糖'];
      const classify = (label) => {
        const k = String(label || '').trim().toLowerCase();
        if (PARENT.includes(k)) return 'parent';
        if (CHILD.includes(k))  return 'child';
        return 'normal';
      };
      nutritionRows = (p.nutrition.rows || [])
        .map(r => {
          const labelEn = (r.label_en || '').trim();
          const labelCn = (r.label_cn || '').trim();
          // Classify off whichever label the office filled — usually EN.
          const kind = classify(labelEn || labelCn);
          return {
            label: lang.pick(r.label_en, r.label_cn, L),
            value: r.value || '',
            kind,
          };
        })
        .filter(r => r.label || r.value);
    }

    // Review summary — fill 5 star slots based on rounded avg
    const avg = Number(p.review_avg) || 0;
    const rounded = Math.round(avg);
    const reviewStars = [1, 2, 3, 4, 5].map(i => i <= rounded ? 'on' : 'off');
    const reviewsRecent = (p.reviews_recent || []).map(r => ({
      ...r,
      stars: [1, 2, 3, 4, 5].map(i => i <= r.rating ? 'on' : 'off'),
      created_short: formatReviewDate(r.created_at, L),
      tags_view: (() => {
        const tagMap = reviewTagMap();
        return (r.tags || []).map(id => {
          const t = tagMap[id];
          // Unknown id (admin removed it after the review was written):
          // show the slug so the chip is still visible, no silent loss.
          const label = t ? (L === 'cn' ? (t.cn || t.en) : (t.en || t.cn)) : id;
          const color = t ? t.color : 'lime';
          return { id, label, color };
        }).filter(t => t.label);
      })(),
      photo_urls: (r.photos || []).map(u => absUrl(u)),
    }));

    // Tagline — parse [[mark]] syntax so the office can pull-out one word
    // with a lime ink-mark slab (v1 design rule). Without markers, the whole
    // string renders as a single plain segment.
    const rawTag = lang.pick(p.tagline_en, p.tagline_cn, L) || '';
    const taglineSegments = [];
    if (rawTag) {
      let i = 0;
      while (i < rawTag.length) {
        const a = rawTag.indexOf('[[', i);
        if (a < 0) { taglineSegments.push({ kind: 'plain', text: rawTag.slice(i) }); break; }
        if (a > i) taglineSegments.push({ kind: 'plain', text: rawTag.slice(i, a) });
        const b = rawTag.indexOf(']]', a);
        if (b < 0) { taglineSegments.push({ kind: 'plain', text: rawTag.slice(a) }); break; }
        taglineSegments.push({ kind: 'mark', text: rawTag.slice(a + 2, b) });
        i = b + 2;
      }
    }

    // Colophon — IP character + tagline. Office can override either field
    // in /retail-admin → Products; blank fields fall back to:
    //   character → mapped from product category (soilsoul default)
    //   tagline   → "From Soil to Soul" / "从土壤到灵魂"
    const COLOPHON_MAP = [
      [/(sauce|dip|condiment|paste|chutney)/, 'soilsoul'],
      [/(spread|butter|jam)/,                  'skater'],
      [/(drink|kombucha|juice|beverage|tea)/,  'kombucha-gang'],
      [/(protein|powder|supplement|flour)/,    'flex'],
      [/(root|tuber|carrot|radish|beet)/,      'radishes'],
      [/(fungi|mushroom)/,                     'mushroom'],
      [/(legume|bean|pea|lentil|chickpea)/,    'peas'],
      [/(onion|allium|garlic|leek)/,           'onion'],
      [/(broccoli|cabbage|leafy|green)/,       'broccoli'],
    ];
    const overrideChar = (p.colophon_character || '').trim();
    let ipKey = overrideChar;
    if (!ipKey) {
      const cat = (p.category || '').toLowerCase();
      ipKey = (COLOPHON_MAP.find(([rx]) => rx.test(cat)) || [, 'soilsoul'])[1];
    }
    const colophonImg = '/assets/brand/ip-' + ipKey + '.jpg';
    // Tagline override — pick the language-matching field first; if the
    // chosen language is empty, fall back to the OTHER language so the
    // office can fill only one and have it show in both views.
    const colophonTagline = lang.pick(p.colophon_tagline_en, p.colophon_tagline_cn, L)
      || (L === 'cn' ? '从土壤到灵魂' : 'From Soil to Soul');

    // Description: split into segments so lines starting with "## " become
    // styled section headings (the office inserts them via the picker in the
    // product edit form). Consecutive non-heading lines coalesce into one
    // paragraph so the existing `white-space: pre-line` rendering still
    // honours single newlines for line breaks inside a section.
    const rawDesc = lang.pick(p.description_en, p.description_cn, L) || '';
    // Formatted description — when the office authored rich HTML, render it via
    // <rich-text>; otherwise fall back to the plain ## parsed parts below.
    const isRichDesc = p.description_format === 'rich' && !!rawDesc;
    const descHtml = isRichDesc ? normalizeRichImages(rawDesc) : '';
    const descParts = [];
    let buf = [];
    const flush = () => {
      const t = buf.join('\n').trim();
      if (t) descParts.push({ kind: 'para', text: t });
      buf = [];
    };
    rawDesc.split('\n').forEach(line => {
      const m = line.match(/^\s*##\s+(.+?)\s*$/);
      if (m) { flush(); descParts.push({ kind: 'heading', text: m[1] }); }
      else { buf.push(line); }
    });
    flush();

    // "Buy together" bundle — server resolves it to item cards (each a real
    // product with its own price/stock). Raw kept on the instance for add-all;
    // a display copy goes to the WXML.
    this._bundle = (p.bundle && Array.isArray(p.bundle.items) && p.bundle.items.length) ? p.bundle : null;
    let bundle = null;
    if (this._bundle) {
      const money = n => '¥' + (Number.isInteger(n) ? n : Number(n).toFixed(2));
      const items = this._bundle.items.map(it => {
        const st = it.stock == null ? null : Number(it.stock);
        return {
          id: it.id,
          name: lang.pick(it.name_en, it.name_cn, L) || ('#' + it.id),
          img: it.image_data || it.image_url || '',
          price: Number(it.price) > 0 ? money(Number(it.price)) : '',
          soldOut: st != null && st <= 0,
        };
      });
      const sum = this._bundle.items.reduce((a, it) => a + (Number(it.price) || 0), 0);
      const bp = Number(this._bundle.price) || 0;
      const showSavings = bp > 0 && bp < sum;
      bundle = {
        title: lang.pick(this._bundle.title_en, this._bundle.title_cn, L) || (L === 'cn' ? '一起买' : 'Buy together'),
        items,
        priceLabel: bp > 0 ? money(bp) : (sum > 0 ? money(sum) : ''),
        wasLabel: showSavings ? money(sum) : '',
        savings: showSavings ? (L === 'cn' ? `省 ${money(sum - bp)}` : `SAVE ${money(sum - bp)}`) : '',
        cta: L === 'cn' ? `全部加入购物车 · ${items.length} 件` : `ADD ALL · ${items.length} ITEMS`,
        allOut: items.every(i => i.soldOut),
      };
    }

    // Bundle PRODUCT ("what's inside") — when THIS product is itself a bundle,
    // the server ships its component cards. We show them read-only so the
    // customer sees what they get; they still buy the single product with the
    // normal Add-to-cart (one price, one line). Distinct from "buy together".
    const whatsInside = (p.is_bundle && Array.isArray(p.bundle_components) && p.bundle_components.length)
      ? {
          title: L === 'cn' ? '套装内含' : "What's inside",
          items: p.bundle_components.map(c => ({
            id: c.id,
            name: lang.pick(c.name_en, c.name_cn, L) || ('#' + c.id),
            img: c.image_data || c.image_url || '',
            qty: Number(c.qty) > 1 ? ('×' + c.qty) : '',
          })),
        }
      : null;

    // Blocks only "win" when the toggle is on AND blocks were actually authored.
    // An empty/failed designed page falls back to the classic description below.
    const useBlocks = !!(p.use_block_design && Array.isArray(p.description_blocks) && p.description_blocks.length);

    this.setData({
      bundle,
      whatsInside,
      image: img,
      images: gallery,
      heroIndex: 0,
      aspectRatio: p.image_aspect ? String(p.image_aspect) : '',
      name: lang.pick(p.name_en, p.name_cn, L),
      subtitle: lang.pick(p.name_cn, p.name_en, L === 'en' ? 'cn' : 'en'),
      priceN: v,
      price: v > 0 ? '¥' + v.toFixed(2) : '—',
      isFlash,
      flashWas,
      flashOff,
      flashEnds,
      priceWas,
      saveLabel,
      description: rawDesc,
      // `use_block_design` is the office's per-product toggle in the kitchen
      // Description card. When true AND blocks were actually authored → render
      // ONLY blocks; when false (default) OR the flag is on but no blocks
      // exist → fall back to the classic path (rich-text or ## parsed). The
      // fallback matters: a freshly-toggled product whose auto-build failed or
      // is still empty would otherwise show a blank description area. The flag
      // exists because blocks would otherwise silently win as soon as any were
      // authored, with no way to preview the classic copy without deleting them.
      descHtml: useBlocks ? '' : descHtml,
      descriptionParts: useBlocks ? [] : (isRichDesc ? [] : descParts),
      descriptionBlocks: useBlocks ? p.description_blocks : [],
      hasNutritionBlock: useBlocks && p.description_blocks.some(b => b && b.type === 'nutrition_facts'),
      size: p.size || p.weight || '',
      keywords: lang.pick(p.keywords_en, p.keywords_cn, L),
      tagline: rawTag,
      taglineSegments,
      colophonImg,
      colophonTagline,
      badges,
      options,
      optionsSingle,
      optionsExtra,
      selectedChoices: selected,
      choiceSel: this._buildChoiceSel(selected),
      hasVariants,
      oosLabel: L === 'cn' ? '售罄' : 'SOLD OUT',
      addBtnLabel: soldOut
        ? (L === 'cn' ? '已售罄' : 'SOLD OUT')
        : hasVariants
          ? (L === 'cn' ? '选择规格' : 'CHOOSE A SIZE')
          : (L === 'cn' ? '加入购物车' : 'ADD TO BASKET'),
      soldOut,
      stockTag,
      stockTagKind,
      reviewAvg: avg,
      reviewAvgDisplay: avg > 0 ? avg.toFixed(1) : '',
      reviewCount: Number(p.review_count) || 0,
      reviewStars,
      reviewsRecent,
      nutritionBasis,
      nutritionRows,
      socialProof: socialProofText(p.social_proof, L),
      recency: recencyText(p.social_proof, L),
      viewingText: viewingText(this.data.viewingCount, L),
    });
    this.recomputeFlashCountdown();
  },

  // Single-select pick (dressing sheet): one choice per option group.
  pickChoice(e) {
    const optionId = e.currentTarget.dataset.optionId;
    const choiceId = e.currentTarget.dataset.choiceId;
    const selected = { ...this.data.selectedChoices, [optionId]: choiceId };
    this.setData({ selectedChoices: selected, choiceSel: this._buildChoiceSel(selected) });
    // setData updates this.data synchronously, so the total reads the new pick.
    if (this.data.opShow) this.setData({ opAddLabel: this._sheetBtnLabel() });
  },
  // Multi-select toggle (extras sheet): a sold-out extra can't be picked.
  toggleExtra(e) {
    if (e.currentTarget.dataset.soldOut) return;
    const optionId = e.currentTarget.dataset.optionId;
    const choiceId = e.currentTarget.dataset.choiceId;
    const cur = Array.isArray(this.data.selectedChoices[optionId]) ? this.data.selectedChoices[optionId].slice() : [];
    const i = cur.indexOf(choiceId);
    if (i >= 0) cur.splice(i, 1); else cur.push(choiceId);
    const selected = { ...this.data.selectedChoices, [optionId]: cur };
    this.setData({ selectedChoices: selected, choiceSel: this._buildChoiceSel(selected), exAddLabel: this._sheetBtnLabel() });
  },
  // Flatten selectedChoices ({opt: id | [id]}) → { [choice_id]: true } so the
  // WXML can mark a row selected without array lookups.
  _buildChoiceSel(selected) {
    const m = {};
    Object.keys(selected || {}).forEach(k => {
      const v = selected[k];
      (Array.isArray(v) ? v : (v != null ? [v] : [])).forEach(id => { m[id] = true; });
    });
    return m;
  },

  decQty() { this.setData({ qty: Math.max(1, this.data.qty - 1) }); },
  incQty() { this.setData({ qty: Math.min(99, this.data.qty + 1) }); },

  // Hero gallery: keep the thumbnail strip in sync as the user swipes, and
  // let a thumbnail tap drive the hero swiper to that photo.
  onHeroSwiperChange(e) {
    const i = e.detail.current;
    if (i !== this.data.heroIndex) this.setData({ heroIndex: i });
  },
  pickHeroImage(e) {
    const i = Number(e.currentTarget.dataset.idx);
    if (Number.isFinite(i) && i !== this.data.heroIndex) this.setData({ heroIndex: i });
  },

  // Self-correct a cropped hero: when the product carries no stored
  // `image_aspect`, the hero box falls back to a fixed 880rpx height and
  // `aspectFill` crops the photo (clipping baked-in title text, etc.). Here we
  // read the image's natural width/height from the load event and adopt its
  // real aspect ratio, so the box fits the whole image instead of cropping.
  // Only fires when aspectRatio is still empty, so a server-provided value
  // always wins and this never thrashes across multi-photo galleries.
  onHeroLoad(e) {
    if (this.data.aspectRatio) return;
    const { width, height } = e.detail || {};
    if (!width || !height) return;
    this.setData({ aspectRatio: (width / height).toFixed(4) });
  },

  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }); },

  previewReviewPhoto(e) {
    const urls = e.currentTarget.dataset.urls || [];
    const idx  = e.currentTarget.dataset.idx || 0;
    if (!urls.length) return;
    wx.previewImage({ urls, current: urls[idx] });
  },

  // Share via WeChat (...).
  onShareAppMessage() {
    const p = this.data.product;
    if (!p) return { title: 'Roots', path: '/pages/home/home' };
    const title = (this.data.lang === 'cn' ? p.name_cn : p.name_en) || p.name_en || 'Roots';
    return {
      title,
      path: '/pages/product/product?id=' + p.id,
      imageUrl: this.data.image || undefined,
    };
  },
  // Share to "Moments" (timeline) — same target, slightly different prompt.
  onShareTimeline() {
    const p = this.data.product;
    if (!p) return {};
    return {
      title: (this.data.lang === 'cn' ? p.name_cn : p.name_en) || p.name_en || 'Roots',
      query: 'id=' + p.id,
      imageUrl: this.data.image || undefined,
    };
  },

  addToCart() {
    const p = this.data.product;
    if (!p) return;
    // Variant product → pick the size in a bottom-sheet (each sibling has its
    // own price / stock). Same gesture as the shop grid's + button.
    if (this.data.hasVariants) { this._openVariantPicker(); return; }
    if (this.data.soldOut) {
      wx.showToast({ title: this.data.lang === 'cn' ? '已售罄' : 'Sold out', icon: 'none' });
      return;
    }
    // Flow: dressing sheet (required picks) → extras sheet (optional paid
    // add-ons) → add. Skip straight to whichever applies; add directly if none.
    if (this.data.optionsSingle.length) { this._openOptionPicker(); return; }
    if (this.data.optionsExtra.length)  { this._openExtrasPicker(); return; }
    if (this._doAddWithOptions()) this._finishAdd();
  },

  // Chosen choice-ids for an option group (scalar→[id], array as-is).
  _selIds(o) {
    const sel = this.data.selectedChoices[o.id];
    return Array.isArray(sel) ? sel : (sel != null ? [sel] : []);
  },

  // Validate required options, price in the chosen deltas (skipping any sold-out
  // extra), and add to the cart. Returns true when added (false = a required
  // choice is unmade, with a prompt toast already shown).
  _doAddWithOptions() {
    const p = this.data.product;
    if (!p) return false;
    for (const o of this.data.options) {
      if (o.is_required && !this._selIds(o).length) {
        wx.showToast({ title: this.data.lang === 'cn' ? '请选择 ' + o.question : 'Please choose: ' + o.question, icon: 'none' });
        return false;
      }
    }
    let delta = 0;
    const chosen = [];
    this.data.options.forEach(o => {
      this._selIds(o).forEach(cid => {
        const c = o.choices.find(x => x.id === cid);
        if (!c || c.sold_out) return;   // never bill/add a sold-out extra
        delta += Number(c.price_delta) || 0;
        chosen.push({ option_id: o.id, choice_id: c.id, label: c.label, delta: Number(c.price_delta) || 0 });
      });
    });
    cart.add({
      id: p.id,
      name_en: p.name_en,
      name_cn: p.name_cn,
      sku: p.sku,
      size: p.size || p.weight,
      image_url: p.image_url,
      image_data: p.image_data,
      price: this.data.priceN + delta,
    }, this.data.qty, chosen);
    return true;
  },

  // "Add to basket · ¥XX" reflecting every current selection (both sheets).
  _sheetBtnLabel() {
    const L = this.data.lang;
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    let delta = 0;
    this.data.options.forEach(o => this._selIds(o).forEach(cid => {
      const c = o.choices.find(x => x.id === cid);
      if (c && !c.sold_out) delta += Number(c.price_delta) || 0;
    }));
    return (L === 'cn' ? '加入购物车 · ' : 'Add to basket · ') + money((Number(this.data.priceN) || 0) + delta);
  },

  // ── Sheet 1: dressing / required picks ───────────────────────────────
  _openOptionPicker() {
    const L = this.data.lang;
    this.setData({ opShow: true, opTitle: L === 'cn' ? '选择选项' : 'Choose your options', opAddLabel: this._sheetBtnLabel() });
  },
  closeOptionPicker() { this.setData({ opShow: false }); },
  // Confirm the dressing → require any 'required' single picks, then either move
  // on to the optional extras sheet or add straight to the cart.
  confirmOptions() {
    for (const o of this.data.optionsSingle) {
      if (o.is_required && !this._selIds(o).length) {
        wx.showToast({ title: this.data.lang === 'cn' ? '请选择 ' + o.question : 'Please choose: ' + o.question, icon: 'none' });
        return;
      }
    }
    if (this.data.optionsExtra.length) { this.setData({ opShow: false }); this._openExtrasPicker(); return; }
    if (this._doAddWithOptions()) { this.setData({ opShow: false }); this._finishAdd(); }
  },

  // ── Sheet 2: optional paid extras (pickles, sauce…) ──────────────────
  _openExtrasPicker() {
    const L = this.data.lang;
    this.setData({ exShow: true, exTitle: L === 'cn' ? '加点配料?' : 'Add extras?', exAddLabel: this._sheetBtnLabel() });
  },
  closeExtrasPicker() { this.setData({ exShow: false }); },
  confirmExtras() {
    if (this._doAddWithOptions()) { this.setData({ exShow: false }); this._finishAdd(); }
  },

  // Shared post-add: confirm toast + pop back to where they came from.
  _finishAdd() {
    wx.showToast({
      title: this.data.lang === 'cn' ? '已加入购物车' : 'Added to cart',
      icon: 'success',
      duration: 1200,
    });
    setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), 500);
  },

  // "Buy together" → add every in-stock item to the cart at its own price
  // (each is a real product), optionally stash an auto-apply voucher for
  // checkout. Mirrors the home page's bundle block; no separate bundle SKU.
  onBundleAdd() {
    const b = this._bundle;
    if (!b || !Array.isArray(b.items)) return;
    let added = 0;
    b.items.forEach(it => {
      const st = it.stock == null ? null : Number(it.stock);
      if (st != null && st <= 0) return;   // skip sold-out items
      cart.add({
        id: it.id, name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
        size: it.size, image_url: it.image_url, image_data: it.image_data,
        price: Number(it.price) || 0,
      }, 1, []);
      added++;
    });
    if (added && b.voucher) { try { wx.setStorageSync('pending_voucher_code', b.voucher); } catch (e) {} }
    wx.showToast({
      title: added
        ? (this.data.lang === 'cn' ? `${added} 件已加入购物车` : `${added} added to cart`)
        : (this.data.lang === 'cn' ? '商品已售罄' : 'Items unavailable'),
      icon: added ? 'success' : 'none',
      duration: 1400,
    });
  },

  // ── Variant size picker ───────────────────────────────────────────
  // Bottom sheet listing each sibling size with its own price / stock.
  // Prices mirror the shop grid: server-decorated effective_price wins when
  // a flash sale is active on that specific size.
  _openVariantPicker() {
    const L = this.data.lang;
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    const options = this._variants.map(m => {
      const regular = Number(m.price ?? m.sell_price) || 0;
      const eff = Number(m.effective_price) > 0 ? Number(m.effective_price) : regular;
      const isFlash = !!m.is_on_flash && eff < regular;
      // Compare-at "was" price: shown struck-through when it beats the live price
      // and there's no flash sale (a flash takes priority and uses `regular`).
      const cmp = Number(m.compare_at_price) || 0;
      const wasN = isFlash ? regular : (cmp > eff && eff > 0 ? cmp : 0);
      const saveN = wasN > eff && eff > 0 ? Math.round((wasN - eff) * 100) / 100 : 0;
      const stock = m.stock == null ? null : Number(m.stock);
      const soldOut = stock != null && stock <= 0;
      return {
        id: m.id,
        label: lang.pickLabel(m.variant_label, L) || lang.pick(m.name_en, m.name_cn, L) || ('#' + m.id),
        weight: (m.size || '').toString().trim(),
        price: eff > 0 ? money(eff) : '',
        priceWas: wasN > 0 ? money(wasN) : '',
        save: saveN > 0 ? (L === 'cn' ? '省¥' : 'SAVE ¥') + (Number.isInteger(saveN) ? saveN : saveN.toFixed(2)) : '',
        isFlash,
        soldOut,
        low: (!soldOut && stock != null && stock <= 5)
          ? (L === 'cn' ? `仅剩 ${stock}` : `Only ${stock} left`)
          : '',
      };
    });
    this.setData({
      vpShow: true,
      vpName: this.data.name,
      vpTitle: L === 'cn' ? '选择规格' : 'Choose a size',
      vpOptions: options,
    });
  },

  closeVariantPicker() { this.setData({ vpShow: false }); },
  vpStop() { /* catchtap on the sheet body so taps don't dismiss it */ },

  vpChoose(e) {
    const id = Number(e.currentTarget.dataset.id);
    const m = (this._variants || []).find(x => Number(x.id) === id);
    if (!m) return;
    const stock = m.stock == null ? null : Number(m.stock);
    if (stock != null && stock <= 0) {
      wx.showToast({ title: this.data.lang === 'cn' ? '已售罄' : 'Sold out', icon: 'none' });
      return;
    }
    cart.add({
      id: m.id,
      name_en: m.name_en,
      name_cn: m.name_cn,
      sku: m.sku,
      size: m.size || m.variant_label,
      image_url: m.image_url,
      image_data: m.image_data,
      price: Number(m.price ?? m.sell_price) || 0,
      effective_price: m.effective_price,
      is_on_flash: m.is_on_flash,
    }, this.data.qty, []);
    this.setData({ vpShow: false });
    this._finishAdd();
  },
});
