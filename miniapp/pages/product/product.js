// Product detail page. Wired by:
//   wx.navigateTo({ url: '/pages/product/product?id=' + product.id })
// from anywhere a product is tappable (home blocks, shop grid, etc.).
// Reads /api/retail/products/:id which already returns full details
// including options[].choices[] for any per-product Q&A.

const api      = require('../../utils/api');
const lang     = require('../../utils/lang');
const cart     = require('../../utils/cart');
const track    = require('../../utils/track');
const delivery = require('../../utils/delivery');
const config   = require('../../utils/config');
const freshEta = require('../../utils/fresh-eta');
const cartNotice = require('../../utils/cart-notice');
const pickQueue = require('../../utils/pick-queue');

// ONE PRICE FORMAT FOR THIS PAGE. Three copies of this line already sat in
// three builders here, and a fourth site — the buy button — had its own rule
// that forced two decimals on every price. That was the odd one out: the shop
// list, the size picker and the "was" line all show `¥44`, and only the button
// said `¥44.00`. It also cost the button 75rpx it did not have, which is how
// the band beside it came to be measured against the wrong number twice. A
// price that is a whole number is written as one; anything else keeps its two
// decimals, exactly as before.
const money = n => '¥' + (Number.isInteger(n) ? n : Number(n).toFixed(2));

// WHICH CHARACTER SIGNS THIS PAGE — the mini app's half of lib/brand-signature
// resolveCharacter(). A WeChat bundle cannot require from lib/, so this is a
// real and permanent duplication of the RULE (never of the data — the cast, the
// map and the fallback all arrive on the storefront config, so they cannot
// drift). scripts/test_brand_signature.js lifts this function out of this file
// and runs it against the same cases as the server's copy, which is the only
// thing standing between one rule and two silently different ones. Same pattern,
// and the same reason, as the nutrition lists above it.
//
// The one rule: it can only ever return a character this shop HAS. An override
// is the product's stored choice and is honoured as typed; an auto pick is
// checked against the cast; a shop with no cast gets no character.
function resolveColophonCharacter(sig, override, category) {
  const s = sig || {};
  const chosen = String(override || '').trim();
  if (chosen) return chosen;
  const cast = Array.isArray(s.characters) ? s.characters : [];
  if (!cast.length) return '';
  const cat = String(category || '').toLowerCase();
  const map = Array.isArray(s.auto_map) ? s.auto_map : [];
  let key = '';
  for (let i = 0; i < map.length; i++) {
    const pair = map[i];
    if (!Array.isArray(pair) || pair.length < 2) continue;
    let rx;
    try { rx = new RegExp(pair[0]); } catch (e) { continue; }
    if (rx.test(cat)) { key = String(pair[1]); break; }
  }
  if (!key) key = String(s.fallback_character || '');
  return cast.some((c) => c && c.key === key) ? key : '';
}
const diag     = require('../../utils/diag');
const optionText = require('../../utils/options');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

// Out of stock, and left orderable by the operator (`oos_preorder`). For a
// shopper on the same-day local run that only holds when the kitchen has dated
// the next batch — otherwise the run is served off a shelf with nothing on it.
// §128 adds the second exemption, and it is not a date: 'backorder_all' is the operator opening the run outright, so the row survives with no batch behind it. The checkout parks that order undated, which is what makes the live + button honest.
function _reservable(m, onLocalRun) {
  return !!(m && m.oos_preorder)
    && (!onLocalRun || !!(m && m.local_fresh_date) || !!(m && m.oos_preorder_local));
}

// §108 — WHICH WORD such a row gets, and the ONE place this page decides it.
// The hero badge, the buy button, the size sheet and the add toast each used to
// answer it separately and had drifted apart in three different ways; they all
// call this now.
//   ''         → say nothing: not reservable, or a batch landing TODAY for a
//                shopper on the run, who waits for nothing worth naming (§80).
//                Silence is the run's alone — an out-of-city shopper on that
//                same morning is still waiting on a parcel.
//   'batch'    → a fresh meal the kitchen has yet to make → NEXT BATCH · 下批现做
//   'preorder' → anything else reservable → PRE-ORDER · 可预订. A grocery row
//                names no batch, none being cooked for it.
// `local_fresh_today` is the SERVER's answer (§82); a handset's clock is not
// entitled to decide whether a date is today.
//
// THE STOCK TEST IS INSIDE, deliberately. `oos_preorder` is a POLICY flag the
// operator sets, true on a batch-made product whether or not any is left, so a
// caller that forgot to check the shelf first would have been handed 'batch'
// for an item sitting in stock — and the add toast, which has no shelf test of
// its own, would have announced a wait on a meal we were about to hand over.
function _preKind(m, onLocalRun) {
  if (!m || m.ship_from_supplier) return '';
  const stock = m.stock == null ? null : Number(m.stock);
  if (!(stock != null && stock <= 0)) return '';
  if (!_reservable(m, onLocalRun)) return '';
  if (onLocalRun && m.local_fresh_today) return '';
  return m.is_batch_made ? 'batch' : 'preorder';
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
    facilityBlocks: [],    // §243 — the allergen card alone, for a food page with no blocks
    size: '',           // weight string e.g. "330ml" — shown big right of name
    keywords: '',       // bilingual short descriptors (e.g. "raw, alive")
    tagline: '',        // bold one-liner slogan
    taglineSegments: [], // [{kind:'plain'|'mark', text}] — pre-parsed for [[ink-mark]]
    colophonImg: '',     // resolved character image path, '' when this shop has no cast
    colophonTagline: '', // the product's own tagline, else this shop's house line
    colophonHouse: '',   // this shop's name on the hairline rule, '' when it has none
    colophonShow: false, // nothing to sign with → the block is not drawn at all
    shipFromSupplier: false, // drop-ship product → show "ships separately" notice
    options: [],
    optionsSingle: [],     // 'single'/'text' groups → first (dressing) sheet
    optionsExtra: [],      // 'multi' groups → second (paid extras) sheet
    selectedChoices: {},   // { [option_id]: choice_id (single) | [choice_id] (multi) }
    choiceSel: {},         // { [choice_id]: true } — flat map for the WXML "on" state
    choiceCap: {},         // { [choice_id]: true } — rows a pick-any ceiling has closed
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
    preLabel: 'PRE-ORDER',
    qty: 1,
    lang: 'en',
    loading: true,
    notFound: false,       // the server ANSWERED: this product is gone
    loadError: false,      // we never got an answer — network / mid-deploy 5xx
    addBtnLabel: 'ADD TO BASKET',
    // The stacked pair, empty until an appender has something to add — the
    // first frame draws the single label above, as it always did.
    addBtnWord: '',
    addBtnQual: '',
    soldOut: false,
    preorder: false,       // 0-stock but out-of-city pre-order allowed
    preKind: '',           // '' | 'batch' | 'preorder' — see _preKind
    stockTag: '',          // 'Only 3 left' / 'Sold out' / 'Pre-order' / ''
    stockTagKind: '',      // 'low' | 'out' | 'pre' | ''
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
    if (!id) {
      // No id in the query at all — a share card or QR that lost its param.
      // Nothing was asked of the server, so nothing can be said about the
      // product; log the raw query so support can see what arrived.
      try { diag.reportError('product: opened with no id', null, { query }); } catch (e) {}
      this.setData({ notFound: true, loading: false });
      return;
    }
    const app = getApp();
    this.setData({ id, lang: app.globalData.lang });
    // Opened from checkout's "Pick" (§433): the cart line this visit replaces.
    // It carries its quantity over, so re-picking two pitas does not quietly
    // become one.
    let replaceKey = null;
    try { replaceKey = query.replace ? decodeURIComponent(query.replace) : null; } catch (e) { replaceKey = query.replace || null; }
    const old = replaceKey ? cart.get().items.find(it => it.key === replaceKey) : null;
    this._replaceKey = old ? replaceKey : null;
    if (old) this.setData({ qty: Math.max(1, Math.min(99, Number(old.qty) || 1)) });
    // Opened by a bulk add (§434, utils/pick-queue): this product needs an
    // answer before it can go in the cart, so the sheet opens by itself, at the
    // quantity the batch asked for. Opened any other way, a batch in flight ends.
    const pickMode = query.pick === '1';
    this._pickMode = pickMode;
    if (pickMode) {
      const q = parseInt(query.qty, 10);
      if (q > 1) this.setData({ qty: Math.min(99, q) });
    } else {
      pickQueue.clear();
    }
    await this.refresh();
    this.refreshFavoriteState();
    if (pickMode && this.data.product) this.addToCart();
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
    if (this.data.notFound || this.data.loadError) return;
    // They may have switched delivery address (the address book is one tap
    // away) — a move into or out of Guangzhou changes whether this product can
    // be pre-ordered, so re-badge before they tap Add.
    delivery.load().then((onLocalRun) => {
      if (!!onLocalRun === !!this._onLocalRun) return;
      this._onLocalRun = !!onLocalRun;
      if (this.data.product) this.recomputeDisplay();
    }).catch((e) => console.warn('[product] delivery sync failed:', e.message));
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
  onUnload() {
    this.stopFlashTick(); this.stopViewingPing(true);
    // Backed out of a bulk add's product without adding (§434): the customer
    // has said no to the rest of the batch too, so it is not reopened later.
    if (this._pickMode && !this._pickAdvancing) pickQueue.clear();
  },

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

  retry() {
    if (this.data.loading) return;
    this.setData({ loadError: false });
    this.refresh();
  },

  async refresh(_retried = false) {
    this.setData({ loading: true });
    try {
      // The delivery verdict rides along with the product fetch: a pre-order is
      // an out-of-city offer, so a same-city shopper must see SOLD OUT rather
      // than a PRE-ORDER badge that the checkout would refuse for today.
      // delivery.load() is cached and never rejects.
      const [p] = await Promise.all([
        api.get('/api/retail/products/' + this.data.id),
        delivery.load().then((onLocalRun) => { this._onLocalRun = !!onLocalRun; }),
      ]);
      this.setData({ product: p, loading: false });
      this.recomputeDisplay();
    } catch (e) {
      console.warn('[product] load failed:', e.message);
      // A dropped request is NOT a verdict about the product. Only a real
      // answer from the server — 404 not_found, or a 4xx like bad_id — means
      // the thing is gone; a timeout, a radio drop, or a 5xx from a server
      // mid-deploy-restart means we never asked. Telling a customer their
      // shop "removed" a product it is still selling is the worse of the two
      // mistakes, and it is the one this page used to make for every failure.
      // Same split, and the same copy, as the home page's two empty states.
      if (api.isTransient(e) && !_retried) {
        // One immediate retry, exactly as utils/config does for the layout —
        // a deploy restart is over in seconds and the customer sees nothing.
        return new Promise((resolve) => {
          setTimeout(() => this.refresh(true).then(resolve, resolve), 600);
        });
      }
      const gone = e && (e.status === 404 || e.status === 400);
      // Leave a trail either way: this page reported nothing until now, which
      // is why a customer's "it says unavailable" could only ever be guessed at.
      try {
        diag.reportError('product: load failed', null,
          { id: this.data.id, why: e && e.message, status: e && e.status, gone });
      } catch (e2) {}
      this.setData({ notFound: gone, loadError: !gone, loading: false });
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
    // §195 — the operator's restock window, read ONCE for the whole pass. The
    // badge and the buy button both append it and §108 requires them to agree;
    // two reads could not disagree today, but they are two things that would
    // have to be changed together tomorrow, which is the same defect early.
    const preWin = config.get('notice.preorder', null);
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
    const priceWas = hasCmp ? money(cmp) : '';
    const saveN = hasCmp ? Math.round((cmp - v) * 100) / 100 : 0;
    const saveLabel = saveN > 0 ? (L === 'cn' ? '省' : 'SAVE ') + money(saveN) : '';
    // §242 — THE BADGE ROW UNDER THE DESCRIPTION IS GONE, ALL OF IT. §236
    // dropped the free-of badges from it and kept one; Ash, on the one left:
    // "its not neccesary can drop that from all products". The allergen card
    // says what the badges said, checked against the card.
    //
    // The four free-of words are not written out anywhere in this file on
    // purpose: scripts/test_product_blocks_read.js greps this source for them,
    // and a comment that named them would pass for the badges coming back.
    // Pre-resolve option labels for the WXML. A choice linked to a stock product
    // (a paid extra) is greyed + unselectable when that product is sold out.
    const options = (p.options || []).map(o => ({
      ...o,
      question: lang.pick(o.question_en, o.question_cn, L),
      // HOW MANY of a pick-any group may be ticked. Read straight off the
      // payload: the server clamps the floor against what is still pickable
      // before serving the page, so these ARE the numbers checkout applies.
      // 0 means no limit, which is every group authored before this existed.
      lim_hint: o.type === 'multi' ? optionText.limHint(o, L) : '',
      // A picture beside each choice: its linked product's photo, served by the
      // server per choice. Once one choice in a group has one, the rest keep an
      // empty frame so the names line up.
      has_img: (o.choices || []).some(c => c.image_url),
      choices: (o.choices || []).map(c => ({
        ...c,
        img: c.image_url ? absUrl(c.image_url) + '&w=160' : '',
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
        // Pre-picked defaults obey the ceiling too: three tick-boxes all marked
        // default on a "choose 2" group would open the sheet already over the
        // cap, with the extra one un-untickable-into-legality by any single tap.
        const pre = o.choices.filter(c => c.is_default && !c.sold_out).map(c => c.id);
        const cap = Number(o.max_choices) || 0;
        selected[o.id] = cap ? pre.slice(0, cap) : pre;
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
    // Variant axis noun ("color"/"颜色") for the size-picker heading — operator-set.
    this._variantNoun = { en: (p.variant_noun_en || '').trim(), cn: (p.variant_noun_cn || '').trim() };
    const hasVariants = this._variants.length > 1;
    // Stock state — null means untracked (treat as in-stock). `preorder` is a
    // 0-stock size/product the operator lets out-of-city shoppers reserve
    // (oos_preorder from the server); it stays orderable instead of dead-blocked.
    // `reservable` folds in the shopper's own address: inside Guangzhou the
    // order rides today's local run, which the checkout gates on real stock —
    // so a sold-out row reads SOLD OUT there, never PRE-ORDER.
    // A dated fresh meal stays reservable on the local run — see _stockState
    // in pages/shop/shop.js for why the run stopped being a reason to refuse.
    const reservable = m => _reservable(m, this._onLocalRun);
    /* §108 — ONE WORD FOR THE SAME WAIT, WHEREVER THE SHOPPER IS.
       §80 split this badge by address: NEXT BATCH · 下批现做 for a Guangzhou
       shopper waiting on a later batch, PRE-ORDER · 可预订 for one we ship to.
       Ash's ruling here is that both are waiting on the same thing — a meal the
       kitchen has yet to make — so both read the SAME word, and it is the one
       the shop grid has always used. What legitimately differs between them is
       the DATE, and the checkout notice is where a date belongs.

       TWO STATES, carried in `preKind` so the badge and the buy button cannot
       drift apart. They already had: an out-of-city shopper whose batch was
       today's got a SILENT badge (the old `madeToday` never checked the run)
       over a button that still read PRE-ORDER.
         'batch'    → a fresh meal not yet made → NEXT BATCH · 下批现做
         'preorder' → anything else reservable  → PRE-ORDER · 可预订, untouched.
                      A grocery row names no batch because none is being cooked
                      for it; its restock has no date to promise.

       SILENCE BELONGS TO THE LOCAL RUN ALONE, and that is the §80 ruling this
       keeps. A shopper on the run whose batch is TODAY'S is waiting for nothing
       worth naming — the kitchen serves it inside the window they are about to
       pick — so that row keeps an ordinary ADD TO BASKET. An out-of-city shopper
       on that same morning is still waiting on a parcel, which is why the run is
       half of this test and `local_fresh_today` alone is not enough.

       The rule itself lives in `_preKind` at the top of this file — one copy,
       because the badge, the button, the size sheet and the add toast all ask
       it and had each answered differently. */
    let soldOut = false, preorder = false, preKind = '', stockTag = '', stockTagKind = '';
    if (p.ship_from_supplier) {
      // Supplier-direct: no stock of ours. Always available unless the operator
      // paused it (supplier is out), which shows a soft "Temporarily unavailable".
      if (p.supplier_paused) {
        soldOut = true;
        stockTag = L === 'cn' ? '暂时缺货' : 'Unavailable';
        stockTagKind = 'out';
      }
    } else if (hasVariants) {
      // Variant product: sold out only when EVERY size is hard-out. A size that's
      // out but pre-orderable keeps the product available. Per-size "Only N left"
      // / "Pre-order" lives in the picker, so the hero badge stays quiet.
      soldOut = this._variants.every(v =>
        v.stock != null && Number(v.stock) <= 0 && !reservable(v));
    } else if (p.stock != null) {
      if (Number(p.stock) <= 0) {
        if (reservable(p)) {
          // Orderable either way. What changes is whether we say anything, and
          // which word — see the two states above. `preorder` stays the
          // ship-vs-run question because the add toast asks that, not this one.
          preorder = !this._onLocalRun;
          preKind = _preKind(p, this._onLocalRun);
          if (preKind === 'batch') {
            // §170 — and WHEN it arrives, so the wait is a date rather than an
            // open question. utils/fresh-eta owns the choice between the make
            // day (local run) and the day after it (couriered).
            stockTag = freshEta.withFreshArrival(
              L === 'cn' ? '下批现做' : 'NEXT BATCH', p, this._onLocalRun, L);
            stockTagKind = 'pre';
          } else if (preKind === 'preorder') {
            /* §195 — THE WINDOW, WHERE THE BATCH ROW GETS ITS DATE. A grocery row
           names no batch, so `withFreshArrival` correctly gives it nothing;
           what it can name is the restock window the operator typed (§194),
           which is the same number the checkout popup prints. Unset → the
           bare word, exactly as before. */
            stockTag = freshEta.withRestockWindow(
              L === 'cn' ? '可预订' : 'PRE-ORDER', preWin, L);
            stockTagKind = 'pre';
          }
        } else {
          soldOut = true;
          stockTag = L === 'cn' ? '已售罄' : 'SOLD OUT';
          stockTagKind = 'out';
        }
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

    // Colophon — character, house line, name. WHOSE COLOPHON THIS IS (§158).
    //
    // All three used to be literals right here: Roots' cast filed by category,
    // a `soilsoul` fallback, and "From Soil to Soul" / "从土壤到灵魂". THIS
    // CODEBASE IS PUBLISHED ONCE PER TENANT, each under its own WeChat AppID
    // (utils/api.js), so those literals were not Roots' page signing itself —
    // they were every tenant's SHOPPER-FACING product page signing itself as
    // Roots. The fallback made it the default rather than an edge case: a shop
    // that had chosen nothing got Roots' mascot drawn on its product.
    //
    // The signature now arrives on the storefront config, resolved per tenant
    // by the same AppID that routes every other call, and the resolver is
    // shared with the server and the product editor (lib/brand-signature) so
    // three surfaces cannot disagree. An override the office typed still wins;
    // an AUTO pick can only ever be a character this shop actually has; and a
    // shop with no cast draws no character at all.
    // READ IT THROUGH config.get, NOT app.globalData. Two reasons, and the
    // second is a regression this would otherwise have shipped:
    //
    //   * recomputeDisplay() has no `app` of its own — the getApp() above it is
    //     in a different method — so app.globalData here was a ReferenceError.
    //   * app.globalData.config is only set once the launch fetch RESOLVES, and
    //     app.js fires it deliberately fire-and-forget (onLaunch step 4) so a
    //     page can paint first. The product fetch racing it would have left the
    //     colophon blank on a cold launch — Roots' signature vanishing at
    //     random. config.get() hydrates from the persisted last-good copy, so
    //     it answers on the first paint of the first launch that has ever
    //     completed one.
    const sig = config.get('colophon', {}) || {};
    const ipKey = resolveColophonCharacter(sig, p.colophon_character, p.category);
    // Empty key → empty src, and the wxml already hides the character on that.
    const colophonImg = ipKey ? '/assets/brand/ip-' + ipKey + '.jpg' : '';
    // Tagline override — pick the language-matching field first; if the
    // chosen language is empty, fall back to the OTHER language so the
    // office can fill only one and have it show in both views. The house line
    // behind it is this shop's own, and is empty for a shop that has none: a
    // motto is not something the platform can invent on a merchant's behalf.
    const colophonTagline = lang.pick(p.colophon_tagline_en, p.colophon_tagline_cn, L)
      || (L === 'cn' ? (sig.tagline_cn || '') : (sig.tagline_en || ''));
    const colophonHouse = String(sig.house || '');
    // Nothing to sign with → the block is not drawn. Three empty elements and
    // two hairlines is not a colophon.
    const colophonShow = !!(colophonImg || colophonTagline || colophonHouse);

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
      const items = this._bundle.items.map(it => {
        const st = it.stock == null ? null : Number(it.stock);
        return {
          id: it.id,
          name: lang.pick(it.name_en, it.name_cn, L) || ('#' + it.id),
          img: absUrl(it.image_data || it.image_url),
          price: Number(it.price) > 0 ? money(Number(it.price)) : '',
          soldOut: it.ship_from_supplier ? !!it.supplier_paused : (st != null && st <= 0),
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
          title: L === 'cn' ? '这款套装包含' : 'This bundle includes',
          items: p.bundle_components.map(c => ({
            id: c.id,
            name: lang.pick(c.name_en, c.name_cn, L) || ('#' + c.id),
            // Server ships component photos as a relative /api/... URL (same as
            // the hero); run it through absUrl so the mini-app <image> resolves
            // it against api.BASE — otherwise the thumbnails render empty.
            img: absUrl(c.image_data || c.image_url),
            qty: Number(c.qty) > 1 ? ('×' + c.qty) : '',
            // Only components that are sold on their own (published + active)
            // get their own PDP — make just those tappable so nobody lands on
            // an empty page for a bundle-only item.
            tappable: c.available !== false,
          })),
        }
      : null;

    // Blocks only "win" when the toggle is on AND blocks were actually authored.
    // An empty/failed designed page falls back to the classic description below.
    const useBlocks = !!(p.use_block_design && Array.isArray(p.description_blocks) && p.description_blocks.length);
    // §243 — the allergen card follows the server's is_food. Food always carries
    // one, with the shared-facility trace line, so a card is added when the
    // office wrote none; anything else carries none. A page with no blocks at
    // all gets the card alone under its plain description (facilityBlocks).
    const writtenCard = (b) => !!(b && b.type === 'allergen_card' &&
      [b.contains_en, b.contains_cn, b.may_contain_en, b.may_contain_cn]
        .some(v => String(v == null ? '' : v).trim()));
    const noCard = (list) => list.filter(b => !(b && b.type === 'allergen_card'));
    const FACILITY_CARD = { type: 'allergen_card', _facility: true };
    let pageBlocks = useBlocks ? p.description_blocks : [];
    if (p.is_food === false) pageBlocks = noCard(pageBlocks);
    else if (p.is_food === true && useBlocks && !pageBlocks.some(writtenCard)) {
      pageBlocks = noCard(pageBlocks).concat([FACILITY_CARD]);
    }
    // §248 — THE MINI APP FOLLOWS THE QR MENU'S ORDER. Ash: "i want the mini
    // app match the qr". Two moves, both the QR menu's own rules (§246, §247):
    //  1. The first allergen card sits straight after the first ingredients
    //     block. With no ingredients block it keeps the office's position, and
    //     a card built from nothing (above) is already last.
    //  2. The nutrition COLUMN, on a product with no nutrition block, is drawn
    //     as a block at the end of the blocks instead of in the old panel after
    //     the reviews. The column has the block's own shape. hasNutritionBlock
    //     below then reads true and the panel stays off, so it never prints twice.
    // The QR menu's eight-type allow-list is NOT applied: this is the full
    // product page, and cutting blocks from it was not asked for.
    const isIng = (b) => !!(b && (b.type === 'ingredients_chips' || b.type === 'ingredients_line'));
    const cardAt = pageBlocks.findIndex(b => b && b.type === 'allergen_card');
    if (cardAt !== -1) {
      const card = pageBlocks[cardAt];
      const rest = pageBlocks.filter((_, i) => i !== cardAt);
      const ingAt = rest.findIndex(isIng);
      if (ingAt !== -1) pageBlocks = rest.slice(0, ingAt + 1).concat([card], rest.slice(ingAt + 1));
    }
    const n = p.nutrition;
    const NUT_BLOCK = (n && typeof n === 'object' &&
      (n.basis_en || n.basis_cn || (Array.isArray(n.rows) && n.rows.length)))
      ? { type: 'nutrition_facts', basis_en: n.basis_en || '', basis_cn: n.basis_cn || '',
          rows: Array.isArray(n.rows) ? n.rows : [] }
      : null;
    if (NUT_BLOCK && useBlocks && !pageBlocks.some(b => b && b.type === 'nutrition_facts')) {
      pageBlocks = pageBlocks.concat([NUT_BLOCK]);
    }
    const facilityBlocks = useBlocks ? []
      : [].concat(p.is_food === true ? [FACILITY_CARD] : [], NUT_BLOCK ? [NUT_BLOCK] : []);

    // §108 — the button says what the badge above it says. It used to read
    // `preorder`, the ship-vs-run question, so a Guangzhou shopper waiting on
    // a later batch was offered a plain ADD TO BASKET under a NEXT BATCH
    // badge. Both now come off `preKind`, so the page cannot contradict
    // itself and the word is the same one every other surface uses.
    // The bare §108 word for this row's kind, before either appender touches
    // it. `addBtnQual` below splits the built label on exactly this, so "what
    // did the appender add" stays one question however many appenders there
    // are and whatever shape their answers take. (§195 wrote this to widen a
    // font step-down to a second appender; the step-down is now a stacked
    // line, and this value is what made that a one-line change too.)
    const addBtnBare = preKind === 'batch'
      ? (L === 'cn' ? '下批现做' : 'NEXT BATCH')
      : preKind === 'preorder'
        ? (L === 'cn' ? '预订' : 'PRE-ORDER')
        : '';

    const addBtnLabel = soldOut
      ? (L === 'cn' ? '已售罄' : 'SOLD OUT')
      : hasVariants
        ? (L === 'cn' ? '选择规格' : 'CHOOSE A SIZE')
        : preKind === 'batch'
          // §170 — the badge's date comes down to the button too, and this is
          // the one surface where it is doing more than informing: this is the
          // tap that commits, so "arrives tomorrow" belongs on it more than
          // anywhere else on the page. §108's rule is unbroken — the WORD is
          // still the badge's word, and both still come off one `preKind`.
          ? freshEta.withFreshArrival(
              L === 'cn' ? '下批现做' : 'NEXT BATCH', p, this._onLocalRun, L)
          : preKind === 'preorder'
            // §195 — the window comes down to the button for the same reason
            // §170's date did: this is the tap that commits, so "back in a few
            // days" belongs on it more than anywhere else on the page.
            ? freshEta.withRestockWindow(L === 'cn' ? '预订' : 'PRE-ORDER', preWin, L)
            : (L === 'cn' ? '加入购物车' : 'ADD TO BASKET');

    // Whatever an appender added to the bare word, or '' when none did — the
    // one string, split, never derived twice. See `addBtnQual` in setData.
    const BAND_SEP = ' · ';
    const addBtnQual = (!soldOut && !hasVariants && addBtnBare
      && addBtnLabel.indexOf(addBtnBare + BAND_SEP) === 0)
      ? addBtnLabel.slice(addBtnBare.length + BAND_SEP.length)
      : '';

    this.setData({
      bundle,
      whatsInside,
      image: img,
      images: gallery,
      heroIndex: 0,
      aspectRatio: p.image_aspect ? String(p.image_aspect) : '',
      name: lang.pick(p.name_en, p.name_cn, L),
      // Single live language: English page shows English only (no CN subtitle);
      // CN page keeps the EN name as a subtitle.
      subtitle: L === 'en' ? '' : lang.pick(p.name_cn, p.name_en, 'en'),
      priceN: v,
      price: v > 0 ? money(v) : '—',
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
      descriptionBlocks: pageBlocks,
      facilityBlocks,
      // §248 — asked of what is DRAWN: a column moved into the blocks counts.
      hasNutritionBlock: pageBlocks.concat(facilityBlocks).some(b => b && b.type === 'nutrition_facts'),
      size: p.size || p.weight || '',
      keywords: lang.pick(p.keywords_en, p.keywords_cn, L),
      tagline: rawTag,
      taglineSegments,
      colophonImg,
      colophonTagline,
      colophonHouse,
      colophonShow,
      // Drop-ship product — show an up-front "ships directly from supplier,
      // may arrive separately" notice before the customer adds it to the cart.
      shipFromSupplier: !!p.ship_from_supplier,
      // The tenant's add-to-cart notice, stated on the page as well as on the
      // card. This is the HERO's own. A variant page has no in-page size
      // switcher — the sizes live in a sheet that adds straight from itself —
      // so the strip is the notice on the product whose page this is, and the
      // card that fires on the add is the picked SIZE's. They can differ, and
      // when they do the card is the one about what is actually in the cart.
      careNoteTitle: lang.pick(p.cart_notice && p.cart_notice.title_en, p.cart_notice && p.cart_notice.title_cn, L),
      careNoteBody:  lang.pick(p.cart_notice && p.cart_notice.body_en,  p.cart_notice && p.cart_notice.body_cn,  L),
      options,
      optionsSingle,
      optionsExtra,
      selectedChoices: selected,
      choiceSel: this._buildChoiceSel(selected),
      choiceCap: this._buildChoiceCap(selected, options),
      hasVariants,
      oosLabel: L === 'cn' ? '售罄' : 'SOLD OUT',
      preLabel: L === 'cn' ? '可预订' : 'PRE-ORDER',
      addBtnLabel,
      // THE APPENDER'S ANSWER GETS ITS OWN LINE ON THIS BUTTON, and that is a
      // width answer, not a style one. Every other surface draws the band as
      // one string, which is what fresh-eta.js exists to guarantee; this
      // button is the only place it has to share a line with a price, and the
      // two do not fit:
      //
      //   the button leaves label and price      404rpx together
      //   `NEXT BATCH · TOMORROW`  at 32rpx      389rpx  (§170)
      //   `PRE-ORDER · 10-14 DAYS` at 26rpx      246rpx  (§195)
      //   a discounted, non-round price (`¥158.50`
      //     struck over `SAVE ¥30.50`) takes     231rpx
      //
      // No readable single size closes that. It was tried twice — 26rpx, then
      // 24 — and clipped the qualifier both times, the second because the
      // label was sized against `¥44` while this button draws its price in
      // full. §195 inherited that sizing, which is why `PRE-ORDER · 10-14
      // DAYS` overflows `¥44.00` by 6rpx on the surface §170 was reported
      // from. Stacked, the label needs only the WIDER of its two pieces —
      // 160rpx at the sizes in product.wxss — which clears the worst price
      // this page can draw and keeps the word near full size.
      //
      // ONE DERIVATION, STILL. The qualifier is not computed a second time; it
      // is taken off the label the appenders already built, split on the
      // separator they share. So it cannot disagree with `addBtnLabel`, it
      // needs no fork of its own, and a third appender works here with no edit
      // — the same property §195 relied on when it widened `addBtnBare`.
      addBtnWord: addBtnQual ? addBtnBare : '',
      addBtnQual,
      soldOut,
      preorder,
      preKind,
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
    if (i >= 0) cur.splice(i, 1);
    else {
      // The row is already dimmed at the ceiling; refuse the tap anyway rather
      // than trust the paint. An over-full line is refused at checkout, so
      // letting it through here would only move the failure somewhere worse.
      const o = (this.data.options || []).find(x => String(x.id) === String(optionId));
      const max = Number(o && o.max_choices) || 0;
      if (max && cur.length >= max) return;
      cur.push(choiceId);
    }
    const selected = { ...this.data.selectedChoices, [optionId]: cur };
    this.setData({
      selectedChoices: selected,
      choiceSel: this._buildChoiceSel(selected),
      choiceCap: this._buildChoiceCap(selected),
      exAddLabel: this._sheetBtnLabel(),
    });
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
    // Prefer the product's own photo; fall back to the office-set Product
    // share card (admin → Share cards) when it has none.
    const fallback = getApp().globalData.config?.sharing?.product;
    return {
      title,
      path: '/pages/product/product?id=' + p.id,
      imageUrl: this.data.image || fallback || undefined,
    };
  },
  // Share to "Moments" (timeline) — same target, slightly different prompt.
  onShareTimeline() {
    const p = this.data.product;
    if (!p) return {};
    const fallback = getApp().globalData.config?.sharing?.product;
    return {
      title: (this.data.lang === 'cn' ? p.name_cn : p.name_en) || p.name_en || 'Roots',
      query: 'id=' + p.id,
      imageUrl: this.data.image || fallback || undefined,
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
    if (this._doAddWithOptions()) this._finishAdd(this.data.preKind);
  },

  // { choice_id: true } for the rows a ceiling has closed — unticked choices in
  // a group already holding its maximum. Ticked rows are never capped: untick is
  // how a customer changes their mind, and a sheet with nothing tappable is dead.
  // `opts` defaults to what is already on the page; the load path passes the
  // freshly built list, which setData has not written back yet.
  _buildChoiceCap(selected, opts) {
    const m = {};
    (opts || this.data.options || []).forEach(o => {
      const max = Number(o.max_choices) || 0;
      if (o.type !== 'multi' || !max) return;
      const sel = selected[o.id];
      const cur = Array.isArray(sel) ? sel : (sel != null ? [sel] : []);
      if (cur.length < max) return;
      (o.choices || []).forEach(c => { if (cur.indexOf(c.id) < 0) m[c.id] = true; });
    });
    return m;
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
      const min = Number(o.min_choices) || 0;
      const n = this._selIds(o).length;
      // A floor of 1 or more IS the requirement; naming the number is what tells
      // a customer sitting on one side that the sheet is asking for two.
      if ((o.is_required && !n) || (min && n < min)) {
        const L = this.data.lang;
        const hint = min > 1 ? optionText.limHint(o, L) : '';
        wx.showToast({
          title: (L === 'cn' ? '请选择 ' + o.question : 'Please choose: ' + o.question)
            + (hint ? (L === 'cn' ? '（' + hint + '）' : ' (' + hint + ')') : ''),
          icon: 'none',
        });
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
        // `question` rides along with the answer so the cart/checkout line can
        // read "Heat up?: Yes" instead of a bare, ambiguous "Yes". Same
        // already-localised string the picker sheet shows (see :403).
        chosen.push({ option_id: o.id, choice_id: c.id, question: o.question, label: c.label, delta: Number(c.price_delta) || 0 });
      });
    });
    this._lastAddKey = cart.add({
      id: p.id,
      name_en: p.name_en,
      name_cn: p.name_cn,
      sku: p.sku,
      size: p.size || p.weight,
      image_url: p.image_url,
      image_data: p.image_data,
      price: this.data.priceN + delta,
      bundle_worth: p.bundle_worth,   // a bundle product: its "separately" worth
      ship_from_supplier: p.ship_from_supplier,
      // The tenant's add-to-cart notice, carried across because this call site
      // builds a literal rather than passing the product row. cart.add() reads
      // it off whatever it is handed.
      cart_notice: p.cart_notice,
    }, this.data.qty, chosen);
    return true;
  },

  // "Add to basket · ¥XX" reflecting every current selection (both sheets).
  _sheetBtnLabel() {
    const L = this.data.lang;
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
    if (this._doAddWithOptions()) { this.setData({ opShow: false }); this._finishAdd(this.data.preKind); }
  },

  // ── Sheet 2: optional paid extras (pickles, sauce…) ──────────────────
  _openExtrasPicker() {
    const L = this.data.lang;
    this.setData({ exShow: true, exTitle: L === 'cn' ? '加点配料?' : 'Add extras?', exAddLabel: this._sheetBtnLabel() });
  },
  closeExtrasPicker() { this.setData({ exShow: false }); },
  confirmExtras() {
    if (this._doAddWithOptions()) { this.setData({ exShow: false }); this._finishAdd(this.data.preKind); }
  },

  // Shared post-add: confirm toast + pop back to where they came from.
  // §108 — the toast says what the button said. It took a BOOLEAN before, and
  // the two callers filled it differently: the buy button passed
  // `!onLocalRun`, the size sheet passed plain reservability, so one Guangzhou
  // shopper adding one meal two ways got two different toasts, and neither
  // matched a button reading NEXT BATCH. It takes the page's own `preKind` now.
  _finishAdd(kind) {
    this._dropReplacedLine();
    const cn = this.data.lang === 'cn';
    const title = kind === 'batch'
      ? (cn ? '已加入购物车，下批现做' : 'Added — next batch')
      : kind === 'preorder'
        ? (cn ? '已预订，加入购物车' : 'Added — pre-order')
        : (cn ? '已加入购物车' : 'Added to cart');
    // An add-to-cart notice is waiting → it takes the screen, and the page does
    // NOT leave until the customer has closed it. Both halves matter. The toast
    // is dropped because it would land on top of the card and cover the words
    // it was raised to deliver, so the card carries the same confirmation as its
    // kicker instead — nothing is lost, it just moves. And the navigate-back
    // stays parked: this page goes back to the shop 500ms after an add, which
    // would take the card down with it before it could be read.
    const card = this.selectComponent('#cart-notice');
    if (card && cartNotice.waiting() && card.showNext(title)) { this._leaveOnNoticeClose = true; return; }
    wx.showToast({
      title,
      icon: kind ? 'none' : 'success',
      duration: kind ? 1500 : 1200,
    });
    this._leaveAfterAdd(500);
  },

  // The re-pick from checkout (§433): the new line takes the old one's place.
  // If the add MERGED into the old key instead, removing it would empty the
  // very line just added to — so that line is set to the quantity picked here,
  // not the old quantity plus it.
  _dropReplacedLine() {
    const k = this._replaceKey;
    if (!k || !this._lastAddKey) return;
    this._replaceKey = null;
    if (this._lastAddKey === k) cart.setQty(k, this.data.qty);
    else cart.remove(k);
  },

  // The page's exit after an add — the shop the customer came from, or the home
  // tab when this page was opened from a share card and has nothing behind it.
  _leaveAfterAdd(delayMs) {
    // A bulk add with more products still to answer (§434): the next one
    // replaces this page, so "back" still lands where the batch began.
    // Only a page the queue opened moves it on — the page that STARTED a "Buy
    // together" stays alive underneath, and an ordinary add there later must
    // not pull the batch's next product.
    const nxt = this._pickMode ? pickQueue.next() : null;
    if (nxt) {
      this._pickAdvancing = true;
      setTimeout(() => wx.redirectTo({ url: pickQueue.url(nxt) }), delayMs);
      return;
    }
    setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), delayMs);
  },

  // The notice card closed (and had nothing queued behind it). Leave ONLY if
  // this page parked its exit on that card. The component also drains notices
  // queued on other screens — a + tapped on the shop grid, a favourite added
  // from the favourites tab — and one of those closing on a product page the
  // customer is simply reading must not walk them out of it.
  onCartNoticeClosed() {
    if (!this._leaveOnNoticeClose) return;
    this._leaveOnNoticeClose = false;
    this._leaveAfterAdd(0);
  },

  // "Buy together" → add every in-stock item to the cart at its own price
  // (each is a real product), optionally stash an auto-apply voucher for
  // checkout. Mirrors the home page's bundle block; no separate bundle SKU.
  onBundleAdd() {
    const b = this._bundle;
    if (!b || !Array.isArray(b.items)) return;
    let added = 0;
    const toPick = [];   // §434 — needs an answer; opened in turn, never added blank
    b.items.forEach(it => {
      const st = it.stock == null ? null : Number(it.stock);
      if (st != null && st <= 0) return;   // skip sold-out items
      if (it.has_options) { toPick.push({ id: it.id, qty: 1 }); return; }
      cart.add({
        id: it.id, name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
        size: it.size, image_url: it.image_url, image_data: it.image_data,
        price: Number(it.price) || 0,
        cart_notice: it.cart_notice,
      }, 1, []);
      added++;
    });
    if ((added || toPick.length) && b.voucher) { try { wx.setStorageSync('pending_voucher_code', b.voucher); } catch (e) {} }
    // Nothing added but something to pick is not "unavailable": the sheet that
    // opens next says what is wanted.
    if (added || !toPick.length) {
      wx.showToast({
        title: added
          ? (this.data.lang === 'cn' ? `${added} 件已加入购物车` : `${added} added to cart`)
          : (this.data.lang === 'cn' ? '商品已售罄' : 'Items unavailable'),
        icon: added ? 'success' : 'none',
        duration: 1400,
      });
    }
    pickQueue.start(toPick);
  },

  // Tap a "what's inside" component → open its own product page. Only fires
  // for components flagged tappable (sold on their own); bundle-only items
  // carry no id-tap binding so this is a no-op for them.
  onInsideTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },

  // ── Variant size picker ───────────────────────────────────────────
  // Bottom sheet listing each sibling size with its own price / stock.
  // Prices mirror the shop grid: server-decorated effective_price wins when
  // a flash sale is active on that specific size.
  _openVariantPicker() {
    const L = this.data.lang;
    // §195 — one read for the whole sheet, not one per size row.
    const preWin = config.get('notice.preorder', null);
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
      const out = m.ship_from_supplier ? !!m.supplier_paused : (stock != null && stock <= 0);
      // Out but pre-orderable (out-of-city) → keep it tappable with a Pre-order
      // badge; only a hard-out size shows the dead SOLD OUT pill. A same-city
      // shopper is never offered the reservation (see recomputeDisplay).
      const orderable = out && !m.ship_from_supplier && !!m.oos_preorder
        && (!this._onLocalRun || !!m.local_fresh_date || !!m.oos_preorder_local);
      /* §108, per SIZE — the same two states the hero badge above resolves, and
         read off the same fields, so one size sheet cannot disagree with the
         page it opened from. A fresh size not yet made says NEXT BATCH whoever
         is reading; a reservable grocery size keeps PRE-ORDER, having no batch
         to name. A size on the local run whose batch is TODAY'S carries no
         badge at all — orderable now, and a picker row shouting anything over a
         lunch the kitchen serves at 11 is the §80 defect. The row keeps its own
         word because one shared `preLabel` cannot say two things at once. */
      const rowKind = _preKind(m, this._onLocalRun);
      const preorder = !!rowKind;
      const preTxt = rowKind === 'batch'
        ? freshEta.withFreshArrival(L === 'cn' ? '下批现做' : 'NEXT BATCH', m, this._onLocalRun, L)
        : rowKind === 'preorder'
          ? freshEta.withRestockWindow(L === 'cn' ? '可预订' : 'PRE-ORDER', preWin, L)
        : '';
      const soldOut = out && !orderable;
      return {
        id: m.id,
        label: lang.pickVariantLabel(m.variant_label, m.variant_label_cn, L) || lang.pick(m.name_en, m.name_cn, L) || ('#' + m.id),
        weight: (m.size || '').toString().trim(),
        price: eff > 0 ? money(eff) : '',
        priceWas: wasN > 0 ? money(wasN) : '',
        save: saveN > 0 ? (L === 'cn' ? '省¥' : 'SAVE ¥') + (Number.isInteger(saveN) ? saveN : saveN.toFixed(2)) : '',
        isFlash,
        soldOut,
        preorder,
        preTxt,
        low: (!out && stock != null && stock <= 5)
          ? (L === 'cn' ? `仅剩 ${stock}` : `Only ${stock} left`)
          : '',
      };
    });
    // Picker heading uses the operator-set variant axis noun; falls back to the
    // legacy "size" / "规格" when unset.
    const noun = this._variantNoun || { en: '', cn: '' };
    this.setData({
      vpShow: true,
      vpName: this.data.name,
      vpTitle: L === 'cn' ? (noun.cn ? `选择${noun.cn}` : '选择规格') : (noun.en ? `Choose a ${noun.en}` : 'Choose a size'),
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
    const out = m.ship_from_supplier ? !!m.supplier_paused : (stock != null && stock <= 0);
    // A pre-orderable out-of-stock size stays orderable for an out-of-city
    // shopper; a same-city one can't reserve it (the checkout blocks same-day
    // Guangzhou on stock), so the row is dead for them.
    const vPreorder = out && !m.ship_from_supplier && _reservable(m, this._onLocalRun);
    if (out && !vPreorder) {
      wx.showToast({ title: this.data.lang === 'cn' ? (m.ship_from_supplier ? '暂时缺货' : '已售罄') : (m.ship_from_supplier ? 'Unavailable' : 'Sold out'), icon: 'none' });
      return;
    }
    this._lastAddKey = cart.add({
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
      ship_from_supplier: m.ship_from_supplier,
      // The SIZE's own notice. The server stamps every sibling, so the 500ml
      // that needs the fridge raises its card and the 330ml that does not stays
      // quiet — reading it off the hero would get that backwards half the time.
      cart_notice: m.cart_notice,
    }, this.data.qty, []);
    this.setData({ vpShow: false });
    // §108 — this size's OWN word, not the page's: a shopper can open the sheet
    // from a hero that is silent and pick a size that is not. `_preKind` tests
    // the shelf itself, so an in-stock size correctly says nothing.
    this._finishAdd(_preKind(m, this._onLocalRun));
  },
});
