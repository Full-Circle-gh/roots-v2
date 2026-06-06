// One component that renders any block type from /api/retail/config.
// The WXML switches on block.type and renders the appropriate sub-template.
// All language / colour / fallback resolution is pre-computed in JS so the
// template stays declarative.

const lang = require('../../utils/lang');
const { BASE } = require('../../utils/api');

// Block types whose root view paints a full-panel background. When framed,
// these must fill the frame edge-to-edge (kill the frame's inner padding) so
// the page color doesn't leak between the border and the colored panel.
const FULL_BG_TYPES = [
  'announcement_bar', 'flash_sale_strip', 'coupon_block', 'points_widget',
  'review_card', 'favorites_block', 'voting_block', 'affiliate_block',
  'store_info', 'greeting', 'kitchen_status', 'recipe_story', 'bundle',
  'wecom_contact', 'countdown_timer', 'leaderboard', 'notification_bar',
];

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

// Zigzag (perforated) clip-path for the compact "Stay in the loop" ticket —
// teeth cut into the top + bottom edges so the page colour shows through.
// Same shape the Mini App Editor (cms.html loopZigzag) computes.
function loopZigzag(teeth = 14, depth = 3.4) {
  const s = 100 / teeth;
  const pts = [];
  for (let i = 0; i <= teeth; i++) pts.push(`${(i * s).toFixed(2)}% ${(i % 2 ? depth : 0).toFixed(2)}%`);
  for (let i = teeth; i >= 0; i--) pts.push(`${(i * s).toFixed(2)}% ${(i % 2 ? 100 - depth : 100).toFixed(2)}%`);
  return `polygon(${pts.join(', ')})`;
}

// Cream cap with a sawtooth BOTTOM edge for the flash-sale design directions
// (classic/editorial/urgency). Flat across the top; teeth point down into the
// coral band. Applied as an inline clip-path on the .fsd-zig cap element.
function fsdZigClip(teeth = 24) {
  const s = 100 / teeth;
  const pts = ['0% 0%', '100% 0%'];
  for (let i = teeth; i >= 0; i--) pts.push(`${(i * s).toFixed(2)}% ${i % 2 ? '42%' : '100%'}`);
  return `polygon(${pts.join(', ')})`;
}

const COLOR_MAP = {
  'lime-leaf':   '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
  'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
  'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
  'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
  'white': '#FFFFFF',
};
// Resolve a brand-colour token (e.g. 'lime-leaf') to a hex. Pass-through
// for raw colour strings (#hex / rgb()). Empty / null returns empty so the
// caller can decide between "no bg" and a sensible default — earlier the
// `|| '#CCD900'` tail silently painted unset bg_color slots LIME, which
// leaked through every block that used `color(b.bg_color || '')` (most
// visibly the category_tabs strip on the home page).
function color(name) {
  if (!name) return '';
  return COLOR_MAP[name] || name;
}

// Zero-pad to 2 digits for the spotlight "NN / NN" review counter.
function pad2(n) { return String(n).padStart(2, '0'); }

// Pick a readable label colour (ink vs white) for a given button fill, by
// luminance. Mirrors btnTextHex() in cms.html so the live render and the
// editor preview always agree on the auto-contrast label.
function btnText(bg) {
  let hex = (color(bg) || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return '#1a1a17';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const bl = parseInt(hex.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * bl) > 140 ? '#1a1a17' : '#FFFFFF';
}

// ─── Bundle "feel" system ────────────────────────────────────────────────
// Mirror of resolveBundleTheme() in cms.html so the editor preview and the
// live render agree on colours. mood = colour story, finish = riso (ink
// border + hard offset shadow) vs clean (soft shadow), energy = head scale +
// border weight + radius. Per-element colour overrides win over the mood.
const BUNDLE_MOODS = {
  grocer:  { surface: '#F3ECE0', cardFill: '#FFFCF7', cta: '#365329', save: '#E96174', sticker: '#CCD900', price: '#1a1a17' },
  harvest: { surface: '#F6EAD6', cardFill: '#FFFCF7', cta: '#8A5A2B', save: '#FF6B0C', sticker: '#F2CA6C', price: '#1a1a17' },
  berry:   { surface: '#F5E6E6', cardFill: '#FFFCF7', cta: '#B23A52', save: '#E96174', sticker: '#F4B8CB', price: '#1a1a17' },
};
const BUNDLE_ENERGY = {
  refined:  { headScale: 0.92, bw: 3, rad: 28 },
  balanced: { headScale: 1.0,  bw: 4, rad: 40 },
  bold:     { headScale: 1.1,  bw: 6, rad: 52 },
};
function resolveBundleTheme(b) {
  const mood = BUNDLE_MOODS[b.mood] || BUNDLE_MOODS.grocer;
  const energy = BUNDLE_ENERGY[b.energy] || BUNDLE_ENERGY.balanced;
  const riso = (b.finish || 'riso') !== 'clean';
  const pick = (field, fallback) => {
    const h = b[field] ? color(b[field]) : '';
    return h || fallback;
  };
  const surface  = pick('bg_color', mood.surface);
  const text     = pick('fg_color', '#1a1a17');
  const cta      = pick('accent_color', mood.cta);
  const cardFill = pick('card_color', mood.cardFill);
  const save     = pick('save_color', mood.save);
  const sticker  = pick('sticker_color', mood.sticker);
  const price    = pick('price_color', mood.price);
  const elBorder = riso ? '3rpx solid #1a1a17' : '3rpx solid rgba(26,26,23,.10)';
  const elShadow = riso ? '4rpx 4rpx 0 #1a1a17' : '0 10rpx 32rpx rgba(26,26,23,.16)';
  const innerCss = riso
    ? `border:${energy.bw}rpx solid #1a1a17;border-radius:${energy.rad}rpx;background:transparent;`
    : `border:none;border-radius:${energy.rad}rpx;background:${cardFill};box-shadow:0 28rpx 72rpx rgba(26,26,23,.13);`;
  return {
    style: ['classic', 'receipt', 'sticker'].includes(b.bundle_style) ? b.bundle_style : 'classic',
    riso, headScale: energy.headScale,
    surface, text, cardFill, price,
    cta,      ctaText:     btnText(cta),
    toggleOn: cta, toggleOnText: btnText(cta),
    save,     saveText:    btnText(save),
    sticker,  stickerText: btnText(sticker),
    elBorder, elShadow, innerCss,
  };
}

Component({
  properties: {
    block:      { type: Object,  value: {} },
    lang:       { type: String,  value: 'en' },
    categories: { type: Array,   value: [] },
    products:   { type: Array,   value: [] },
    flashSales: { type: Array,   value: [] },
    // Top-selling products keyed by `${channel}|${window}|${limit}`. The
    // host page fetches whatever keys are referenced by product_grid
    // blocks with source_type='top_selling' and passes them in here.
    topProducts: { type: Object, value: {} },
    affiliate:  { type: Object,  value: null },   // { code, stats, enabled }
    polls:      { type: Array,   value: [] },     // live polls for voting_block
    customer:   { type: Object,  value: null },   // { nickname, points_balance, ... } for greeting + kitchen blocks
    kitchen:    { type: Object,  value: null },   // { address, hours_en, hours_cn, open_hour, close_hour, eta_minutes }
    favorites:  { type: Array,   value: [] },     // customer's saved products for favorites_block
    // Unread notification count — surfaced as a small badge on the greeting
    // block so customers see "you have N new" without leaving Home. The
    // value comes from /api/retail/notifications/unread-count; the host
    // page (home.js) fetches it and threads it through.
    notifUnread: { type: Number, value: 0 },
    // Title of the most-recent unread notification — when notifUnread === 1
    // we surface it directly in the strip ("📣 NEW BREAD COLLECTION · Tap")
    // instead of the generic "1 new update". Falls back to generic when
    // the title is empty.
    notifLatestEn: { type: String, value: '' },
    notifLatestCn: { type: String, value: '' },
    // Any unread row is a broadcast → strip icon flips to 📣. Otherwise 🔔.
    notifHasBroadcast: { type: Boolean, value: false },
    // Newest unread row arrived in the last 6 hours → pulse the icon to
    // draw the eye without being annoying. home.js computes this from the
    // server-returned latest_created_at.
    notifIsFresh: { type: Boolean, value: false },
    // Order/shipping-excluded mirror of the four props above. A
    // notification_bar block set to "announcements only" reads these so it
    // surfaces broadcasts/invoice/refund updates but hides order-progress
    // (paid/shipped/delivered) rows.
    notifNoOrderUnread:   { type: Number,  value: 0 },
    notifNoOrderLatestEn: { type: String,  value: '' },
    notifNoOrderLatestCn: { type: String,  value: '' },
    notifNoOrderFresh:    { type: Boolean, value: false },
    // Operator-configurable strip background colour (theme.notif_color in
    // storefront_config). Empty string = let the WXSS default win.
    notifColor: { type: String, value: '' },
    // Pre-fetched leaderboard rows keyed by `${metric}|${period}|${top_n}|${reveal_mode}`.
    // The host page (home.js) walks the layout for leaderboard blocks, fetches
    // /api/retail/storefront/leaderboard once per distinct tuple, and threads
    // the results in here — same lazy pattern as topProducts.
    leaderboards: { type: Object, value: {} },
    // Newest products keyed by limit (e.g. '6'). Host page fetches
    // /api/retail/products?sort=newest&limit=N for any product_grid block
    // with source_type='new_arrivals' — same lazy pattern as topProducts.
    newArrivals: { type: Object, value: {} },
    // Customer's latest in-flight order (paid/preparing/dispatched or unpaid),
    // or null. Feeds the order_tracker block; host page fetches it when the
    // layout contains one and the customer is authed.
    activeOrder: { type: Object, value: null },
    // How many of the customer's orders are still in flight. When >1 the
    // order_tracker surfaces a "N orders in progress →" link to the full list.
    activeOrderCount: { type: Number, value: 0 },
  },

  data: {
    type: '',
    style: '',
    label: '',
    bg: '',
    fg: '',
    anim: 'static',
    speed: 'normal',
    chars: [],
    // hero
    imageUrl: '',
    heroVideo: '',
    aspectRatio: '',
    placeholderH: 280,
    ctas: [],
    // category_tabs
    kicker: '',
    title: '',
    seeAll: 'SEE ALL',
    catWord: 'CATEGORY',
    tiles: [],
    // featured
    featuredProduct: null,
    featuredKicker: '',
    price: '',
    // grid
    gridProducts: [],
    cols: 2,
    // spacer
    height: 24,
    // countdown
    countdown: null,
    // flash sale strip
    flashStrip: null,
    flashDesign: null,
    flashHidden: false,
    // coupon / points / review / store
    coupon: null,
    points: null,
    review: null,
    store: null,
    // affiliate
    affiliateCard: null,
    // wecom (企业微信) contact block
    wecom: null,
    // favorites — customer's saved products for the home block
    favoritesCard: null,
    favoritesHidden: false,
    // leaderboard — Roots Club ranking strip for the home page
    leaderboardCard: null,
    leaderboardHidden: false,
    leaderboardAccent: '',
    // video_banner — autoplaying muted loop clip
    videoUrl: '',
    videoPoster: '',
    videoHeight: 420,
    videoLink: '',
    videoFullscreen: false,
    // order_tracker — customer's latest in-flight order, or null to hide
    orderTracker: null,
  },

  observers: {
    'block, lang, categories, products, flashSales, topProducts, affiliate, polls, customer, kitchen, favorites, leaderboards, newArrivals, activeOrder, activeOrderCount, notifUnread, notifNoOrderUnread, notifIsFresh, notifNoOrderFresh, notifHasBroadcast': function () {
      this.recompute();
    },
  },

  lifetimes: {
    attached() {
      this.recompute();
      // Countdown + flash-strip blocks tick every second. Other types
      // ignore the timer to save work.
      this._tick = setInterval(() => {
        const b = this.properties.block;
        if (b && (b.type === 'countdown_timer' || b.type === 'flash_sale_strip')) {
          this.recompute();
        }
      }, 1000);
    },
    detached() {
      if (this._tick) { clearInterval(this._tick); this._tick = null; }
    },
  },

  methods: {
    recompute() {
      const b = this.data.block || this.properties.block;
      if (!b || !b.type) return;
      const L = this.properties.lang || 'en';
      const out = { type: b.type };

      // Universal per-block chrome: optional brand-colored outline frame
      // and optional edge-to-edge full-bleed width. Both off by default so
      // existing blocks render unchanged.
      out.frameOn = !!b.frame_color;
      out.frameColor = b.frame_color ? color(b.frame_color) : '';
      out.fullBleed = b.full_bleed === true;
      // Corner radius — rounds the frame; card-style blocks also read
      // corner_radius for their own card corners (see *Corner vars below).
      out.blockCorner = b.corner_radius || 'subtle';
      // Blocks that paint their own full-panel background should fill the
      // frame edge-to-edge (the frame's vertical padding would otherwise
      // leak the page color between the border and the colored panel).
      out.blockFill = FULL_BG_TYPES.indexOf(b.type) !== -1;

      switch (b.type) {
        case 'announcement_bar': {
          out.label = lang.pick(b.text_en, b.text_cn, L);
          out.bg = color(b.bg_color || 'lime-leaf');
          out.fg = color(b.fg_color || 'ink');
          out.announceLink = b.link_target || '';
          out.anim = b.animation || 'static';
          out.speed = b.speed || 'normal';
          // Per-letter animations need each char as its own text node so
          // we can stagger animation-delay via --i. `Array.from` handles
          // surrogate pairs (single-char emoji / CJK = 1 element).
          if (out.anim === 'typewriter' || out.anim === 'wave' || out.anim === 'fade_in_letters') {
            out.chars = Array.from(out.label || '');
          } else {
            out.chars = [];
          }
          break;
        }
        case 'hero_banner': {
          out.heroView = b.view || 'full';
          out.imageUrl = absUrl(b.image_url);
          out.heroVideo = absUrl(b.video_url);
          if (b.image_aspect && b.image_url) out.aspectRatio = String(b.image_aspect);
          out.placeholderH = b.height_px || 280;
          // Image fit: how the picture fills the banner box.
          //   cover   — fill the banner, crop overflow (banner uses height_px)
          //   contain — show the whole image (banner matches the image ratio)
          //   stretch — stretch to fill exactly (may distort)
          // Legacy blocks (image_aspect set, no image_fit) default to
          // 'contain' so they look exactly as before; otherwise 'cover'.
          out.heroFit = b.image_fit || (b.image_aspect ? 'contain' : 'cover');
          out.heroImgMode = out.heroFit === 'contain' ? 'aspectFit'
            : out.heroFit === 'stretch' ? 'scaleToFill' : 'aspectFill';
          // Fill/stretch use a fixed-proportion box (the image is cropped into
          // it). The CMS editor sizes that box as (height_px * 0.6)px tall on
          // its 390px-wide phone; we express the SAME proportion as an
          // aspect-ratio (390 / (height_px*0.6) = 650/height_px) so the live
          // banner matches the editor preview exactly on any screen width.
          // (A plain rpx height diverged: 520px read as a short landscape band
          // in the editor but a tall portrait band on the phone.)
          out.fillAspect = (650 / (b.height_px || 280)).toFixed(4);
          const ctas = Array.isArray(b.ctas) ? b.ctas : (b.cta_label ? [{ label_en: b.cta_label, label_cn: '', target: b.cta_target, style: 'primary' }] : []);
          const heroBtnBg = color(b.btn_color || '');
          out.ctas = ctas.map(c => {
            const style = c.style || 'primary';
            // Button colour overrides the solid (primary) fill only; the
            // secondary outline + bare link styles keep their WXSS look.
            const override = style === 'primary' && heroBtnBg;
            return {
              label:  lang.pick(c.label_en ?? c.label, c.label_cn, L),
              target: c.target || '',
              style,
              btnBg: override ? heroBtnBg : '',
              btnFg: override ? btnText(heroBtnBg) : '',
            };
          });
          // Split-view extras — full view ignores these.
          out.heroHeadline = lang.pick(b.headline_en, b.headline_cn, L);
          out.heroSubtitle = lang.pick(b.subtitle_en, b.subtitle_cn, L);
          out.heroPanelBg = color(b.panel_bg_color || 'oat-milk');
          out.heroPanelFg = color(b.panel_fg_color || 'ink');
          // 2026-05-20 enhancements: scrim strength on the 'full' view
          // + entrance animation.
          out.heroScrim  = b.scrim || 'medium';
          out.heroEnter  = b.entrance_anim || 'none';
          break;
        }
        case 'category_tabs': {
          out.kicker  = lang.pick(b.kicker_en ?? b.kicker, b.kicker_cn, L);
          out.title   = lang.pick(b.title_en ?? b.title, b.title_cn, L);
          out.seeAll  = L === 'cn' ? '查看全部' : 'SEE ALL';
          out.seeAllTarget = b.link_target || 'shop';
          out.catWord = L === 'cn' ? '分类' : 'CATEGORY';
          out.catView = b.view || 'tiles';
          // Visual direction. 'classic' uses the `view` Layout (tiles/icons/
          // scroll). index/bento/sticker are the three "Shop the garden"
          // design directions, each a self-contained layout that ignores view.
          out.catStyle = ['index', 'bento', 'sticker'].includes(b.cat_style) ? b.cat_style : 'classic';
          // Bento number badge ("NN · count") on each tile; on unless turned off.
          out.bentoBadge = b.bento_badge !== 0;
          out.catCols = Math.max(3, Math.min(5, b.columns || 4));
          out.catBg   = color(b.bg_color || '');
          // Standard cross-block options.
          out.catCorner = b.corner_radius || 'sharp';
          out.catEnter  = b.entrance_anim || 'none';
          // Per-element colour overrides — empty falls back to the style default.
          out.catText    = color(b.fg_color || 'ink');
          out.catAccent  = color(b.accent_color || 'olive-moss');
          out.catKeyline = color(b.keyline_color || 'ink');
          out.catShadow  = color(b.shadow_color || 'ink');
          out.catSurface = color(b.tile_surface_color || 'oat-milk');
          out.catSurfaceText = btnText(b.tile_surface_color || 'oat-milk');
          const cats = (b.category_ids || [])
            .map(id => this.properties.categories.find(c => c.id === id))
            .filter(Boolean);
          const palette = ['papaya-glow','pea-sprout','berry-punch','golden-corn','skyberry','lotus'];
          // Per-category colour overrides keyed by category id; unset → auto
          // palette by position. Drives the dot+pill (index), badge/fallback
          // (bento) or the whole chip fill (sticker).
          const tileColors = b.tile_colors || {};
          // Categories carry no count or image, so derive both from the loaded
          // products (count = products in the category; cover = first product
          // with an image). Mirrors the CMS preview.
          const allProducts = this.properties.products || [];
          // Match on the storefront `top_category` (the field the category tree
          // is built from); fall back to the legacy free-form `category` for
          // products not yet re-saved under the two-level scheme.
          const inCat = (p, c) => (p.top_category || p.category) === c.name;
          const catCount = (c) => allProducts.filter(p => inCat(p, c)).length;
          // Per-category image override (bento) keyed by category id; unset →
          // first product in the category that has a photo. Mirrors CMS preview.
          const tileImages = b.tile_images || {};
          const catCover = (c) => {
            if (tileImages[c.id]) return absUrl(tileImages[c.id]);
            const p = allProducts.find(x => inCat(x, c) && (absUrl(x.image_url) || x.image_data));
            return p ? (absUrl(p.image_url) || p.image_data) : '';
          };
          out.tiles = cats.map((c, i) => {
            // Category tops carry EN `name` + separate `name_cn`. Pick the one
            // for the active language — each language shows only its own name.
            const splitName = (L === 'cn' && c.name_cn) ? c.name_cn : c.name;
            const letter = (splitName.trim()[0] || '').toUpperCase();
            const override = tileColors[c.id];
            const token = override || palette[i % 6];
            const catColor = color(token);
            // Overrides auto-contrast by luminance; the auto palette keeps its
            // hand-tuned text colour (white on pea-sprout/berry-punch).
            const catText = override ? btnText(token) : (i % 6 === 1 || i % 6 === 2 ? '#fff' : '#1a1a17');
            const cover = catCover(c);
            return {
              id: c.id,
              num: '0' + (i + 1),
              name: splitName,
              letter,
              color: token,
              count: catCount(c),
              cover,
              // index dot / sticker chip / classic tile + bento badge fill.
              bg: catColor, fg: catText,
              // sticker / index count badge re-uses the same category colour.
              tagBg: catColor, tagFg: catText,
            };
          });
          break;
        }
        case 'featured_item': {
          const p = this.properties.products.find(x => x.id === b.product_id);
          if (p) {
            const regular = Number(p.sell_price ?? p.price) || 0;
            const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
            out.featuredProduct = {
              id: p.id,
              image: absUrl(p.image_url) || p.image_data || '',
              name:  lang.pick(p.name_en, p.name_cn, L),
              isFlash: !!p.is_on_flash && eff < regular,
              priceWas: !!p.is_on_flash && eff < regular ? '¥' + regular.toFixed(2) : '',
            };
            out.price = eff > 0 ? '¥' + eff.toFixed(2) : '—';
          }
          out.featuredKicker = lang.pick(b.kicker_en ?? b.kicker, b.kicker_cn, L);
          // Layout + colours from CMS. `view` ∈ card | banner | split.
          // `bg_color` is the outer block surface (null → transparent so the
          // page bg shows through); `card_bg_color` / `card_fg_color` paint
          // the inner card. Legacy blocks without these fields keep the old
          // hardcoded look (ink card + oat-milk text).
          out.featuredView    = b.view || 'card';
          out.featuredBg      = b.bg_color ? color(b.bg_color) : 'transparent';
          out.featuredCardBg  = color(b.card_bg_color || 'ink');
          out.featuredCardFg  = color(b.card_fg_color || 'oat-milk');
          // 2026-05-20 enhancements: corner radius preset + sale badge +
          // price emphasis mode + entrance animation. Mirrors the CMS form.
          out.featuredCorner    = b.corner_radius || 'subtle';
          out.featuredEnter     = b.entrance_anim || 'none';
          out.featuredPriceMode = b.price_mode || 'both';
          const saleMode = b.sale_badge || 'auto';
          out.featuredShowSale  = saleMode === 'auto' && !!(p && p.is_on_flash);
          out.featuredSaleLabel = L === 'cn' ? '秒杀' : 'SALE';
          break;
        }
        case 'product_grid': {
          out.kicker = lang.pick(b.kicker_en ?? b.kicker, b.kicker_cn, L);
          out.title  = lang.pick(b.title_en ?? b.title, b.title_cn, L);
          out.seeAll = L === 'cn' ? '查看全部' : 'SEE ALL';
          // Category-scoped grids deep-link to that category; everything else
          // (top sellers, new arrivals, manual) opens the Shop tab.
          out.seeAllTarget = b.category_id ? ('category:' + b.category_id) : 'shop';
          out.cols   = b.columns || 2;
          out.gridView = b.view || 'grid';
          // 2026-05-20 enhancements: card corner radius + grid density +
          // rank badge gating (only relevant for top_selling source).
          out.gridCorner  = b.corner_radius || 'subtle';
          out.gridDensity = b.density       || 'normal';
          out.gridRankMode = b.rank_badge || 'top_3';
          // Optional surface panel + sale/accent colour. Both blank by
          // default so unset grids render byte-identically (transparent
          // panel, brand-red flash price/badge, olive sold caption). When
          // an accent is picked it tints the flash price, paints the flash
          // badge (auto-contrast label), and tints the sold caption.
          out.gridBg = b.bg_color ? color(b.bg_color) : '';
          out.gridSaleColor = b.accent_color ? color(b.accent_color) : '';
          out.gridSaleFg = b.accent_color ? btnText(b.accent_color) : '';
          let list = [];
          if (b.source_type === 'manual') {
            list = (b.product_ids || []).map(id => this.properties.products.find(p => p.id === id)).filter(Boolean);
          } else if (b.source_type === 'top_selling') {
            // Host page pre-fetches top sellers per (channel|window|limit)
            // key; we just look up the result here. Empty array until data
            // arrives — host triggers a re-render once cache is warm.
            const key = `${b.top_channel || 'combined'}|${b.top_window || '7d'}|${b.limit || 6}`;
            const top = this.properties.topProducts || {};
            list = Array.isArray(top[key]) ? top[key] : [];
          } else if (b.source_type === 'new_arrivals') {
            // Host page pre-fetches the newest products per limit (server sorts
            // by created_at DESC). Same lazy lookup as top_selling.
            const na = this.properties.newArrivals || {};
            const key = String(b.limit || 6);
            list = Array.isArray(na[key]) ? na[key] : [];
          } else {
            const cat = this.properties.categories.find(c => c.id === b.category_id);
            list = this.properties.products.filter(p => !b.category_id || p.category === cat?.name);
          }
          const isTopSelling = b.source_type === 'top_selling';
          // Rank badge gating — `gridRankMode` picks which positions show
          // their "NO. xx" / 🏆 ribbon. 'top_3' is the default ribbon-only-
          // for-medalists behaviour; 'always' shows ranks 4+ too; 'never'
          // suppresses the whole ribbon. Non-top_selling source ignores this.
          const rankMode = out.gridRankMode;
          out.gridProducts = list.slice(0, b.limit || 6).map((p, idx) => {
            const regular = Number(p.sell_price ?? p.price) || 0;
            const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
            const isFlash = !!p.is_on_flash && eff < regular;
            const tagline = lang.pick(p.tagline_en, p.tagline_cn, L) || lang.pick(p.description_en, p.description_cn, L) || '';
            // Rank position (1..N). The renderer downstream decides whether
            // to show it based on rankMode + idx.
            let rank = isTopSelling ? (idx + 1) : 0;
            if (rankMode === 'never') rank = 0;
            else if (rankMode === 'top_3' && rank > 3) rank = 0;
            const rankClass = !rank ? '' :
              rank === 1 ? 'rank-1' :
              rank === 2 ? 'rank-2' :
              rank === 3 ? 'rank-3' : 'rank-n';
            const rankLabel = !rank ? '' :
              `NO. ${rank < 10 ? '0' + rank : rank}`;
            // Show "X SOLD" on any card with a count: top-selling blocks get
            // their windowed units from the top endpoint; ordinary cards get
            // all-time units from the catalogue list (already min-gated server
            // side, so a non-zero value here is always worth showing).
            const units = Number(p.units_sold) || 0;
            const soldCaption = units > 0
              ? (L === 'cn' ? `已售 ${units}` : `${units} SOLD`)
              : '';
            return {
              id: p.id,
              image: absUrl(p.image_url) || p.image_data || '',
              name:  lang.pick(p.name_en, p.name_cn, L),
              tagline: tagline.length > 80 ? tagline.slice(0, 80) + '…' : tagline,
              price: eff > 0 ? '¥' + eff.toFixed(2) : '—',
              priceWas: isFlash ? '¥' + regular.toFixed(2) : '',
              isFlash: isFlash && !rank,
              rank,
              rankLabel,
              rankClass,
              unitsSold: units,
              soldCaption,
            };
          });
          break;
        }
        case 'order_tracker': {
          const o = this.properties.activeOrder;
          // No in-flight order → block renders nothing (wx:if guards it).
          out.orderTracker = null;
          out.orderTrackerCorner = b.corner_radius || 'subtle';
          if (o && o.id) {
            const cn = L === 'cn';
            // track_style picks the layout (must mirror cms.html's editor):
            //   classic — ringed icon stepper; truck — status headline + a
            //   truck riding a rail; banner — accent header band + segments.
            const style = ['classic', 'truck', 'banner'].includes(b.track_style) ? b.track_style : 'classic';
            // Energy → heading scale (--ot-h), banner frame weight (--ot-bw)
            // and radius (--ot-radius). px values from the editor ×2 for rpx.
            const E = ({ refined: { h: 0.92, bw: 3, rad: 24 }, balanced: { h: 1, bw: 4, rad: 32 }, bold: { h: 1.12, bw: 5, rad: 40 } })[b.energy] || { h: 1, bw: 4, rad: 32 };
            const STATUS = cn
              ? { pending_payment: '待支付', paid: '已支付', preparing: '准备中', dispatched: '配送中' }
              : { pending_payment: 'Awaiting payment', paid: 'Paid', preparing: 'Preparing', dispatched: 'On the way' };
            // Status headline (truck bighead / banner eta line).
            const HEAD = cn
              ? { pending_payment: '待支付', paid: '已下单', preparing: '打包中', dispatched: '配送中' }
              : { pending_payment: 'Awaiting payment', paid: 'Order placed.', preparing: 'Packing up.', dispatched: 'On the way.' };
            // Steps filled per status: unpaid 0 → paid 1 → preparing 2 → on-the-way 3.
            const STEP = { pending_payment: 0, paid: 1, preparing: 2, dispatched: 3 };
            const filled = STEP[o.status] ?? 0;
            // active = current milestone index (0..3); pct = rail fill.
            const active = Math.max(0, filled - 1);
            const POS = ['0%', '33.3%', '66.6%', '100%'];
            const pct = POS[active];
            // Each node carries its own candy colour + outline glyph, reusing
            // the "My orders" bucket vocabulary (coin/box/truck/house). Colour
            // encodes PROGRESS, not category: only done/current nodes get the
            // candy fill — `filled` (i < step) drives that AND the green
            // connector bar leading into the node; `current` adds the pulse.
            // stage_*_color overrides the candy default per stage (classic).
            const TRACK = [
              { labelEn: 'Paid',      labelCn: '已支付', candy: b.stage_paid_color  ? color(b.stage_paid_color)  : '#F2CA6C', icon: '/assets/icons/tracker/paid.svg' },
              { labelEn: 'Prep',      labelCn: '准备中', candy: b.stage_prep_color  ? color(b.stage_prep_color)  : '#CCD900', icon: '/assets/icons/tracker/prep.svg' },
              { labelEn: 'On way',    labelCn: '配送中', candy: b.stage_onway_color ? color(b.stage_onway_color) : '#F4B8CB', icon: '/assets/icons/tracker/onway.svg' },
              { labelEn: 'Delivered', labelCn: '已送达', candy: b.stage_done_color  ? color(b.stage_done_color)  : '#E96174', icon: '/assets/icons/tracker/delivered.svg' },
            ];
            const preview = Array.isArray(o.items_preview) ? o.items_preview : [];
            const thumbs = (preview.length ? preview.slice(0, 3) : [{}])
              .map(p => absUrl(p.image_url) || p.image_url || '');
            const count = o.item_count || preview.length || 0;
            // ETA line — prefer the human delivery slot, else the scheduled date.
            let eta = o.delivery_slot_label || '';
            if (!eta && o.scheduled_for) eta = String(o.scheduled_for).slice(0, 16).replace('T', ' ');
            // Colour controls — '' falls back to the design default. These ride
            // on the wrapper as CSS vars so every layout inherits them.
            const accent  = color(b.accent_color || 'forest-kale');
            const cardBg  = b.card_bg_color ? color(b.card_bg_color) : '#fff';
            const cardBorder = b.card_border_color === ''
              ? 'none'
              : `3rpx solid ${b.card_border_color ? color(b.card_border_color) : '#1a1a17'}`;
            const marker  = b.marker_color ? color(b.marker_color) : '#F4B8CB';
            const bright  = b.bright_color ? color(b.bright_color) : '#CCD900';
            const rail    = b.rail_color   ? color(b.rail_color)   : '#D3D1C7';
            const ctaText = b.cta_text_color ? color(b.cta_text_color) : '';
            const statusLabel = STATUS[o.status] || o.status;
            // Refund tag — the order is still in the active tracker (a full
            // refund flips status→'refunded' and drops out entirely), so any
            // refund_status seen here belongs to a PARTIAL or in-progress
            // refund. Surface it so a refunded order never masquerades as a
            // plain Paid order. rejected/withdrawn → no tag (order proceeds).
            const REFUND_TAG = cn
              ? { pending: '退款申请中', reviewing: '退款审核中', approved: '退款处理中', paying: '退款处理中', paid: '已部分退款' }
              : { pending: 'Refund requested', reviewing: 'Refund in review', approved: 'Refund processing', paying: 'Refund processing', paid: 'Partially refunded' };
            const refundTag = REFUND_TAG[o.refund_status] || '';
            const ctaLabel = o.status === 'pending_payment'
              ? (cn ? '去支付' : 'Pay now')
              : (cn ? '查看订单' : 'View order');
            // When the customer has more than one order in flight, the card
            // tracks only the newest — surface a link to the full list so the
            // others aren't hidden. '' → the wxml omits the link entirely.
            const moreCount = Math.max(0, (this.properties.activeOrderCount || 0) - 1);
            const moreLabel = moreCount > 0
              ? (cn ? `还有 ${moreCount} 个订单进行中 →` : `${moreCount} more order${moreCount === 1 ? '' : 's'} in progress →`)
              : '';
            out.orderTracker = {
              id: o.id,
              style,
              title: lang.pick(b.title_en, b.title_cn, L) || (cn ? '你的订单' : 'Your order'),
              orderNo: o.order_no || '',
              statusLabel,
              isUnpaid: o.status === 'pending_payment',
              // Classic stepper nodes.
              steps: TRACK.map((s, i) => ({
                label:   cn ? s.labelCn : s.labelEn,
                icon:    s.icon,
                candy:   s.candy,
                filled:  i < filled,         // done OR current → candy fill
                current: i === filled - 1,   // adds the pulsing ring
              })),
              // Truck rail dots (skip the one the truck sits on).
              dots: POS.map((left, i) => ({ left, show: i !== active, color: i < filled ? bright : rail })),
              // Truck milestone labels. Lit-ness keys off `filled` (not `active`)
              // so an unpaid order (filled 0) lights nothing — `active` is
              // clamped to 0 and can't distinguish unpaid from Paid.
              tkLabels: TRACK.map((s, i) => ({
                label:   cn ? s.labelCn : s.labelEn,
                on:      i < filled,
                current: i === filled - 1,
                align:   i === 0 ? 'left' : i === 3 ? 'right' : 'center',
              })),
              // Banner progress segments. Same as above: key lit-ness off
              // `filled` so an unpaid order shows zero filled segments instead
              // of falsely lighting "Paid" (active clamps -1 → 0).
              segs: TRACK.map((s, i) => ({
                label:   cn ? s.labelCn : s.labelEn,
                icon:    s.icon,
                done:    i < filled - 1,
                current: i === filled - 1,
                on:      i < filled,
              })),
              pct,
              markerIcon: TRACK[active].icon,
              // Truck headline copy.
              kicker:  style === 'banner' ? statusLabel : (cn ? '我的订单' : 'YOUR ORDER'),
              bighead: style === 'banner' ? (eta || HEAD[o.status] || statusLabel) : (HEAD[o.status] || statusLabel),
              thumbs,
              countLabel: count > 0 ? (cn ? `${count} 件商品` : `${count} item${count === 1 ? '' : 's'}`) : '',
              refundTag,
              eta,
              total: Number(o.total) > 0 ? '¥' + Number(o.total).toFixed(2) : '',
              ctaLabel,
              ctaArrow: ctaLabel + ' →',
              moreLabel,
              // CSS vars shared across all three layouts (mirror cms.html).
              vars: `--ot-accent:${accent};--ot-card-bg:${cardBg};--ot-card-border:${cardBorder};`
                + `--ot-marker:${marker};--ot-bright:${bright};--ot-rail:${rail};`
                + `--ot-bw:${E.bw}rpx;--ot-radius:${E.rad}rpx;--ot-h:${E.h};`
                + (ctaText ? `--ot-cta-text:${ctaText};` : ''),
            };
          }
          // No live order → the inner card is skipped, so suppress the block's
          // own FRAME/fill chrome too; otherwise an empty bordered frame is
          // left behind above the next block.
          if (!out.orderTracker) {
            out.frameOn = false;
            out.blockFill = false;
          }
          break;
        }
        case 'notification_bar': {
          // Standalone unread-notifications bar. Text/icon/count come from the
          // shared notif-* props (fed to every block by the home page); the
          // operator controls only the look here. Default surface is ink/black.
          out.nbarView = b.view || 'bar';
          out.nbarBg = color(b.bg_color || 'ink');
          out.nbarFg = color(b.fg_color || 'white');
          // Action chip (the arrow). Blank → falls back to the text colour so
          // it always reads; label auto-contrasts against its own fill.
          out.nbarBtnBg = b.btn_color ? color(b.btn_color) : '';
          out.nbarBtnFg = b.btn_color ? btnText(b.btn_color) : '';
          // Scope toggle: when show_order_status is false the block runs on the
          // order/shipping-excluded counts so it only surfaces broadcasts,
          // invoice, and refund updates ("announcements only"). Default = on.
          const showOrder = b.show_order_status !== false;
          const cnt   = showOrder ? this.properties.notifUnread     : this.properties.notifNoOrderUnread;
          const ttlEn = showOrder ? this.properties.notifLatestEn   : this.properties.notifNoOrderLatestEn;
          const ttlCn = showOrder ? this.properties.notifLatestCn   : this.properties.notifNoOrderLatestCn;
          const fresh = showOrder ? this.properties.notifIsFresh    : this.properties.notifNoOrderFresh;
          // has_broadcast is a subset of the non-order scope, so it stays valid
          // whichever scope is active.
          out.nbarCount = cnt || 0;
          out.nbarFresh = !!fresh;
          out.nbarHasBroadcast = !!this.properties.notifHasBroadcast;
          const cn = L === 'cn';
          let nbText = '';
          if (cnt > 0) {
            if (cnt === 1) {
              const t = cn ? (ttlCn || ttlEn) : (ttlEn || ttlCn);
              if (t) nbText = t + (cn ? ' · 点击查看' : ' · Tap to view');
            }
            if (!nbText) {
              nbText = cn
                ? cnt + ' 条新消息 · 点击查看'
                : cnt + (cnt === 1 ? ' new update · Tap to view' : ' new updates · Tap to view');
            }
          }
          out.nbarText = nbText;
          // Nothing in-scope unread → inner row is wx:if'd out, so kill the
          // block's own FRAME/fill chrome too (same empty-frame fix as
          // order_tracker).
          if (!(cnt > 0)) {
            out.frameOn = false;
            out.blockFill = false;
          }
          break;
        }
        case 'spacer': {
          out.height = b.height_px || 24;
          // 2026-05-20 — optional decorative divider centred in the spacer.
          // 'none' is the legacy blank gap; line/dashes/dots draw a coloured
          // rule. dividerColor is resolved via the brand-color picker.
          out.dividerStyle = b.divider_style || 'none';
          out.dividerColor = color(b.divider_color || 'olive-moss');
          break;
        }
        case 'flash_sale_strip': {
          out.bg = color(b.bg_color || 'berry-punch');
          out.fg = color(b.fg_color || 'oat-milk');
          // Sale accent for the per-card sale price + sold-meter bar. Blank
          // by default so unset strips keep the brand-red (#E96174) WXSS look.
          out.flashAccent = b.accent_color ? color(b.accent_color) : '';
          const view = b.view || 'strip';
          out.flashView = view;
          out.flashDesign = null;
          const all = this.properties.flashSales || [];
          const active = all.filter(p => p.flash && p.flash.state === 'active');
          const max = view === 'banner' ? 0 : Math.max(1, Math.min(8, b.product_limit || 3));
          const products = max > 0 ? active.slice(0, max) : [];
          const haveSomething = products.length > 0 || (view === 'banner' && active.length > 0);
          if (!haveSomething) {
            if (b.hide_when_empty) {
              out.flashHidden = true;
              out.flashStrip = null;
              break;
            }
            out.flashHidden = false;
            out.flashStrip = {
              kicker: lang.pick(b.kicker_en, b.kicker_cn, L),
              title:  lang.pick(b.title_en, b.title_cn, L),
              cards: [],
              cells: [],
              isEmpty: true,
              emptyText: lang.pick(b.empty_text_en, b.empty_text_cn, L) || '',
              countdown: null,
              ctaLabel: '',
              ctaTarget: '',
            };
            break;
          }
          out.flashHidden = false;
          const clockSource = products.length ? products : active;
          const ends = clockSource
            .map(p => new Date(p.flash.ends_at).getTime())
            .filter(Number.isFinite)
            .sort((a, b) => a - b)[0];
          const ms = ends ? Math.max(0, ends - Date.now()) : 0;
          let s = Math.floor(ms / 1000);
          const d = Math.floor(s / 86400); s -= d * 86400;
          const h = Math.floor(s / 3600);  s -= h * 3600;
          const m = Math.floor(s / 60);    s -= m * 60;
          const cellLabels = L === 'cn' ? ['天','时','分','秒'] : ['DAYS','HRS','MIN','SEC'];
          const pad = n => (n < 10 ? '0' + n : '' + n);
          out.flashStrip = {
            kicker: lang.pick(b.kicker_en, b.kicker_cn, L),
            title:  lang.pick(b.title_en, b.title_cn, L),
            endsLabel: L === 'cn' ? '距结束' : 'ENDS IN',
            countdown: { d: pad(d), h: pad(h), m: pad(m), s: pad(s) },
            cells: [
              { num: pad(d), lbl: cellLabels[0] },
              { num: pad(h), lbl: cellLabels[1] },
              { num: pad(m), lbl: cellLabels[2] },
              { num: pad(s), lbl: cellLabels[3] },
            ],
            ctaLabel: lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || 'shop',
            isEmpty: false,
            cards: products.map(p => {
              const fp = Number(p.flash.price) || 0;
              const rp = Number(p.price) || 0;
              const off = rp > 0 && fp < rp ? Math.round(((rp - fp) / rp) * 100) : 0;
              const sold = p.flash.stock_sold || 0;
              const cap = p.flash.stock_limit;
              const pct = (cap != null && cap > 0) ? Math.min(100, Math.round((sold / cap) * 100)) : null;
              const meter = L === 'cn'
                ? (cap != null ? `已抢 ${sold} / ${cap}` : `已抢 ${sold}`)
                : (cap != null ? `${sold} of ${cap} sold` : `${sold} sold`);
              return {
                id: p.id,
                image: absUrl(p.image_url) || p.image_data || '',
                name: lang.pick(p.name_en, p.name_cn, L),
                priceNow: '¥' + fp.toFixed(2),
                priceWas: rp > fp ? '¥' + rp.toFixed(2) : '',
                badge: off > 0 ? '-' + off + '%' : '',
                meterPct: pct,
                meterLabel: meter,
              };
            }),
          };
          // Design directions (classic/editorial/urgency): same active-sale
          // data, plus recolourable --fs-* vars, energy type-scale and the
          // bilingual kicker/off-line the full sections show.
          if (view === 'classic' || view === 'editorial' || view === 'urgency') {
            const EN = ({ refined: { head: 0.9, border: 1.5, radius: 12 },
                         balanced: { head: 1, border: 1.5, radius: 16 },
                         bold: { head: 1.14, border: 2, radius: 18 } })[b.energy] || { head: 1, border: 1.5, radius: 16 };
            let sv = `--fs-head:${EN.head};--fs-border:${EN.border}px;--fs-radius:${EN.radius * 2}rpx`;
            const setVar = (prop, token) => { const c = token ? color(token) : ''; if (c) sv += `;${prop}:${c}`; };
            setVar('--fs-ink', b.ink_color);
            setVar('--fs-panel', b.panel_color);
            setVar('--fs-tile', b.tile_color);
            setVar('--fs-accent', b.accent_color);
            setVar('--fs-fill', b.fill_color);
            setVar('--fs-price', b.price_color);
            const maxOff = products.reduce((mx, p) => {
              const rp = Number(p.price) || 0, fp = Number(p.flash.price) || 0;
              return rp > 0 ? Math.max(mx, Math.round(((rp - fp) / rp) * 100)) : mx;
            }, 0);
            out.flashDesign = {
              view,
              styleVars: sv,
              corner: b.corner_radius || 'subtle',
              pulse: b.urgency === 'frantic',
              zigClip: fsdZigClip(),
              kicker: lang.pick(b.kicker_en, b.kicker_cn, L),
              title: lang.pick(b.title_en, b.title_cn, L),
              shop: lang.pick(b.cta_label_en, b.cta_label_cn, L),
              endsLabel: L === 'cn' ? '距结束' : 'ENDS IN',
              tiles: [
                { num: pad(d), lbl: cellLabels[0] },
                { num: pad(h), lbl: cellLabels[1] },
                { num: pad(m), lbl: cellLabels[2] },
                { num: pad(s), lbl: cellLabels[3] },
              ],
              liveLbl: L === 'cn' ? '限时秒杀 · 进行中' : 'FLASH SALE · LIVE',
              subLine: '',
              offMain: L === 'cn' ? `最高省 ${maxOff}%` : `Up to ${maxOff}% off`,
              offSub: L === 'cn' ? '限时秒杀' : '',
              cards: products.map(p => {
                const fp = Number(p.flash.price) || 0;
                const rp = Number(p.price) || 0;
                const off = rp > 0 && fp < rp ? Math.round(((rp - fp) / rp) * 100) : 0;
                const sold = p.flash.stock_sold || 0;
                const cap = p.flash.stock_limit;
                const pctc = (cap != null && cap > 0) ? Math.min(100, Math.round((sold / cap) * 100)) : null;
                const soldLbl = L === 'cn'
                  ? (cap != null ? `已抢 ${sold} / ${cap}` : `已抢 ${sold}`)
                  : (cap != null ? `${sold} OF ${cap} SOLD` : `${sold} SOLD`);
                return {
                  id: p.id,
                  image: absUrl(p.image_url) || p.image_data || '',
                  name: lang.pick(p.name_en, p.name_cn, L),
                  sub: '',
                  priceNow: '¥' + fp.toFixed(2),
                  priceWas: rp > fp ? '¥' + rp.toFixed(2) : '',
                  badge: off > 0 ? '−' + off + '%' : '',
                  meterPct: pctc,
                  soldLbl,
                };
              }),
            };
          }
          break;
        }
        case 'coupon_block': {
          out.bg = color(b.bg_color || 'pink-guava');
          out.fg = color(b.fg_color || 'ink');
          out.coupon = {
            kicker:   lang.pick(b.kicker_en,   b.kicker_cn,   L),
            title:    lang.pick(b.title_en,    b.title_cn,    L),
            subtitle: lang.pick(b.subtitle_en, b.subtitle_cn, L),
            discount: lang.pick(b.discount_label_en, b.discount_label_cn, L),
            code:     b.code || '',
            codeLabel: L === 'cn' ? '复制' : 'COPY',
            ctaLabel: lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || 'coupons',
            btnBg: color(b.btn_color || ''),
            btnFg: b.btn_color ? btnText(b.btn_color) : '',
          };
          break;
        }
        case 'points_widget': {
          out.bg = color(b.bg_color || 'forest-kale');
          out.fg = color(b.fg_color || 'lime-leaf');
          out.points = {
            kicker:   lang.pick(b.kicker_en, b.kicker_cn, L),
            title:    lang.pick(b.title_en,  b.title_cn,  L),
            subtitle: lang.pick(b.subtitle_en, b.subtitle_cn, L),
            ctaLabel: lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || 'me',
            btnBg: color(b.btn_color || ''),
            btnFg: b.btn_color ? btnText(b.btn_color) : '',
          };
          break;
        }
        case 'review_card': {
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          // Star colour for filled stars. Blank → WXSS gold (#F2CA6C) default.
          out.starColor = b.star_color ? color(b.star_color) : '';
          out.reviewView = b.view || 'card';
          // Migrate legacy single-review blocks transparently.
          let reviews = Array.isArray(b.reviews) && b.reviews.length ? b.reviews : null;
          if (!reviews && (b.quote_en || b.quote_cn || b.author_name)) {
            reviews = [{
              rating: b.rating || 5,
              quote_en: b.quote_en || '', quote_cn: b.quote_cn || '',
              author_name: b.author_name || '',
              author_subline_en: b.author_subline_en || '', author_subline_cn: b.author_subline_cn || '',
              avatar_url: b.avatar_url || '',
            }];
          }
          reviews = reviews || [];
          out.reviewKicker = lang.pick(b.kicker_en, b.kicker_cn, L);
          out.reviews = reviews.map((r, idx) => {
            const rating = Math.max(1, Math.min(5, parseInt(r.rating, 10) || 5));
            const initial = (r.author_name || '').trim()[0] || '?';
            return {
              key: idx,
              quote: lang.pick(r.quote_en, r.quote_cn, L),
              authorName: r.author_name || '',
              authorSub: lang.pick(r.author_subline_en, r.author_subline_cn, L),
              stars: [1,2,3,4,5].map(i => ({ on: i <= rating })),
              avatar: absUrl(r.avatar_url) || '',
              avatarInitial: initial.toUpperCase(),
            };
          });
          // Inset-card layouts (editorial / riso / spotlight): the fill, border,
          // accent and avatar-circle colours ride on inline --rv-* custom props,
          // set only when the author overrides them (brand defaults live in WXSS).
          const rv = [];
          const rvCard = color(b.card_color);   if (rvCard)   rv.push('--rv-card:' + rvCard);
          const rvBord = color(b.border_color); if (rvBord)   rv.push('--rv-border:' + rvBord);
          const rvAcc  = color(b.accent_color); if (rvAcc)    rv.push('--rv-accent:' + rvAcc);
          const rvCirc = color(b.circle_color); if (rvCirc)   rv.push('--rv-circle:' + rvCirc);
          if (out.reviewView === 'spotlight' && b.fg_color) rv.push('--rv-cardfg:' + color(b.fg_color));
          out.rvVars = rv.join(';');
          // Spotlight is an interactive single-card carousel — track the active
          // index + its "NN / NN" counter; reset to the first on each rebuild.
          out.spotActive = 0;
          out.spotTitle = L === 'cn' ? '街坊都爱' : 'Loved by locals.';
          out.spotCount = pad2(1) + ' / ' + pad2(out.reviews.length);
          break;
        }
        case 'store_info': {
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          out.storeBtnBg = color(b.btn_color || '');
          out.storeBtnFg = b.btn_color ? btnText(b.btn_color) : '';
          const openCol   = color(b.open_color   || 'pea-sprout');
          const closedCol = color(b.closed_color || 'berry-punch');
          // Normalize stores: new format has b.stores[]; legacy had top-level
          // title/address/hours/phone fields — fold those into a singleton so
          // the WXML loop is uniform.
          let raw = Array.isArray(b.stores) && b.stores.length ? b.stores : null;
          if (!raw && (b.title_en || b.title_cn || b.address_en || b.address_cn || b.phone)) {
            raw = [{
              name_en: b.title_en, name_cn: b.title_cn,
              address_en: b.address_en, address_cn: b.address_cn,
              hours_en: b.hours_en, hours_cn: b.hours_cn,
              phone: b.phone,
              open_hour: b.open_hour, close_hour: b.close_hour,
              eta_minutes: b.eta_minutes,
              cta_label_en: b.cta_label_en, cta_label_cn: b.cta_label_cn,
              cta_target: b.cta_target,
            }];
          }
          const hr = new Date().getHours() + (new Date().getMinutes() / 60);
          out.storeKicker = lang.pick(b.kicker_en, b.kicker_cn, L);
          out.stores = (raw || []).map((s, i) => {
            const openH  = Number(s.open_hour);
            const closeH = Number(s.close_hour);
            const hasHours = Number.isFinite(openH) && Number.isFinite(closeH);
            const isOpen = hasHours
              ? (closeH > openH ? (hr >= openH && hr < closeH) : (hr >= openH || hr < closeH))
              : null;
            const eta = Number(s.eta_minutes) || 0;
            return {
              key: 's' + i,
              name:    lang.pick(s.name_en,    s.name_cn,    L),
              address: lang.pick(s.address_en, s.address_cn, L),
              hours:   lang.pick(s.hours_en,   s.hours_cn,   L),
              phone:   s.phone || '',
              hasStatus: hasHours,
              isOpen: !!isOpen,
              statusLabel: isOpen === null ? '' :
                isOpen ? (L === 'cn' ? '营业中' : 'Open now')
                       : (L === 'cn' ? '已打烊' : 'Closed'),
              statusColor: isOpen ? openCol : closedCol,
              etaLabel: (eta > 0 && isOpen === true)
                ? (L === 'cn' ? `约 ${eta} 分钟送达` : `~${eta} min delivery`)
                : '',
              ctaLabel:  lang.pick(s.cta_label_en, s.cta_label_cn, L),
              ctaTarget: s.cta_target || '',
            };
          });
          break;
        }
        case 'favorites_block': {
          // "Your saved" rail on the home page. Pulls from the customer's
          // actual favorites (passed in via the favorites property). When
          // the rail would be empty (no auth, or zero saved items), we
          // hide the block — set hide_when_empty=false on the block to
          // show an empty-state nudge instead.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const view = b.view || 'scroll';            // 'scroll' | 'grid'
          const limit = Math.max(1, Math.min(12, b.limit || 6));
          const favs = Array.isArray(this.properties.favorites) ? this.properties.favorites : [];
          const hideEmpty = b.hide_when_empty !== false;
          if (!favs.length && hideEmpty) {
            out.favoritesHidden = true;
            out.favoritesCard = null;
            break;
          }
          out.favoritesHidden = false;
          out.favoritesCard = {
            kicker: lang.pick(b.kicker_en, b.kicker_cn, L)
                    || (L === 'cn' ? '你的收藏' : 'YOUR SAVED'),
            title: lang.pick(b.title_en, b.title_cn, L)
                    || (L === 'cn' ? '继续看看' : 'Pick up where you left off.'),
            seeAllLabel: L === 'cn' ? '查看全部' : 'SEE ALL',
            emptyTitle: L === 'cn' ? '暂无收藏' : 'Nothing saved yet.',
            emptySub: L === 'cn' ? '点心形图标即可收藏。' : 'Tap the heart on a product to save it.',
            view,
            items: favs.slice(0, limit).map(p => {
              const regular = Number(p.price ?? p.sell_price) || 0;
              const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
              const isFlash = !!p.is_on_flash && eff < regular;
              const soldOut = p.stock != null && Number(p.stock) <= 0;
              return {
                id: p.id,
                image: absUrl(p.image_url) || p.image_data || '',
                name: lang.pick(p.name_en, p.name_cn, L),
                price: eff > 0 ? '¥' + Math.round(eff) : '—',
                priceWas: isFlash ? '¥' + Math.round(regular) : '',
                isFlash,
                soldOut,
              };
            }),
            isEmpty: favs.length === 0,
          };
          // 2026-05-20 — corner radius preset on the favourite cards.
          out.favoritesCorner = b.corner_radius || 'subtle';
          break;
        }
        case 'voting_block': {
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const accent = color(b.accent_color || 'lime-leaf');
          // "● OPEN" live-status indicator colour. Editable; defaults to berry
          // so existing blocks keep their look. (CLOSED stays muted olive.)
          const statusColor = color(b.status_color || 'berry-punch');
          // Inline-view idle "PICK ONE TO VOTE" button colours. Editable;
          // empty → fall back to the CSS defaults (faint grey fill + olive text)
          // so existing blocks are unchanged. Once an option is tapped the
          // button switches to the accent-coloured "CAST VOTE" state.
          const promptBg   = b.prompt_bg_color   ? color(b.prompt_bg_color)   : '';
          const promptText = b.prompt_text_color ? color(b.prompt_text_color) : '';
          const view = b.view || (b.title_en || b.title_cn ? 'teaser' : 'peek');
          const src  = b.data_source || 'auto_pull';

          // Resolve poll for auto-pull views.
          let livePoll = null;
          if (src === 'auto_pull' && view !== 'teaser') {
            const polls = Array.isArray(this.properties.polls) ? this.properties.polls : [];
            if (b.poll_id) {
              livePoll = polls.find(p => p.id === b.poll_id) || null;
            } else {
              const open = polls.filter(p => p.status === 'open');
              const closed = polls.filter(p => p.status === 'closed');
              if (view === 'past_result') {
                livePoll = closed[0] || null;
              } else {
                livePoll = open.find(p => p.is_featured) || open[0] || null;
                if (!livePoll && b.fallback_to_past) livePoll = closed[0] || null;
              }
            }
          }

          // Hide block when auto-pull can't find anything to show.
          if (src === 'auto_pull' && view !== 'teaser' && !livePoll && b.hide_when_empty) {
            out.voting = null;
            out.votingHidden = true;
            break;
          }

          // Days-left chip from closes_at (only meaningful for open polls).
          let daysLeft = '';
          if (livePoll?.closes_at) {
            const iso = String(livePoll.closes_at).replace(' ', 'T');
            const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
            const ms = Number.isFinite(t) ? t - Date.now() : 0;
            if (ms > 0) daysLeft = String(Math.ceil(ms / 86400000));
          }

          // Past-result view always wins if explicitly requested OR the
          // resolved poll has already closed.
          const renderPast = view === 'past_result' || livePoll?.status === 'closed';

          // Build options + my-vote info for inline view.
          let options = [];
          let totalVotes = 0;
          let myVoteOptionId = null;
          let showResults = false;
          let winner = null;
          let winnerPct = 0;
          if (livePoll) {
            options = (livePoll.options || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
            totalVotes = options.reduce((s, o) => s + (o.votes || 0), 0);
            myVoteOptionId = livePoll.my_vote_option_id || null;
            showResults = !!myVoteOptionId || renderPast;
            if (renderPast || showResults) {
              winner = options.slice().sort((a, b) => (b.votes || 0) - (a.votes || 0))[0] || null;
              if (winner && totalVotes > 0) winnerPct = Math.round((winner.votes / totalVotes) * 100);
            }
          }

          out.votingHidden = false;
          out.voting = {
            view,
            dataSource: src,
            accent,
            statusColor,
            promptBg,
            promptText,
            ctaLabel:  lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || 'voting',
            // Static / teaser copy (used by teaser + static fallback)
            kicker:    lang.pick(b.kicker_en,    b.kicker_cn,    L),
            title:     lang.pick(b.title_en,     b.title_cn,     L),
            subtitle:  lang.pick(b.subtitle_en,  b.subtitle_cn,  L),
            // Live poll data (auto-pull)
            livePoll: livePoll ? {
              id:        livePoll.id,
              question:  lang.pick(livePoll.question_en, livePoll.question_cn, L),
              category:  lang.pick(livePoll.category_en, livePoll.category_cn, L),
              daysLeft,
              rewardPoints: livePoll.reward_points || 5,
              totalVotes,
              status:    livePoll.status,
              myVoteOptionId,
              showResults,
              isClosed:  renderPast,
              options:   options.map((o, i) => {
                const pct = totalVotes > 0 ? (o.votes / totalVotes) * 100 : 0;
                return {
                  id:       o.id,
                  letter:   String.fromCharCode(65 + i),
                  label:    lang.pick(o.label_en, o.label_cn, L),
                  votes:    o.votes || 0,
                  pct,
                  pctStr:   pct.toFixed(0),
                  pctWidth: pct.toFixed(1) + '%',
                  isMine:   o.id === myVoteOptionId,
                  isMax:    showResults && winner && o.id === winner.id && (o.votes || 0) > 0,
                };
              }),
              winner: winner ? {
                label: lang.pick(winner.label_en, winner.label_cn, L),
                votes: winner.votes || 0,
                pct:   winnerPct,
              } : null,
            } : null,
            // Per-block scratch state — preserved across recomputes for the
            // inline view so the user's local pick survives prop changes.
            chosenOptionId: (this.data.voting && this.data.voting.chosenOptionId) || null,
            voteJustCast:   (this.data.voting && this.data.voting.voteJustCast)   || false,
          };
          break;
        }
        case 'affiliate_block': {
          // Live customer-side affiliate data injected by home.js:
          //   affiliate = { enabled, code, stats: { earned, total_invites, converted } }
          // View variants (b.view): 'card' (default, full lime card),
          // 'strip' (one-line horizontal), 'stat' (big earned-¥ hero),
          // 'receipt' (dashed receipt-paper aesthetic).
          const view = b.view || 'card';
          // Per-view colour defaults so a fresh block looks intentional.
          const bgDefault = view === 'stat'    ? 'ink'
                          : view === 'receipt' ? 'oat-milk'
                          : 'lime-leaf';
          const fgDefault = view === 'stat'    ? 'lime-leaf' : 'ink';
          out.bg = color(b.bg_color || bgDefault);
          out.fg = color(b.fg_color || fgDefault);
          const af = this.properties.affiliate || {};
          const reward = Number(af.reward_per_order) || 30;
          const stats  = af.stats || {};
          const code   = af.code || '';
          const en = L === 'en';
          const earnedNum = Number(stats.earned) || 0;
          const invitedNum = Number(stats.total_invites) || 0;
          const hasActivity = invitedNum > 0 || earnedNum > 0;
          const showStats = b.show_stats !== false && hasActivity;
          let statsLabel = '';
          if (showStats) {
            statsLabel = en
              ? `¥${earnedNum.toFixed(0)} earned · ${invitedNum} invited`
              : `已赚 ¥${earnedNum.toFixed(0)} · 已邀请 ${invitedNum}`;
          }
          out.affiliateCard = {
            view,
            kicker:     lang.pick(b.kicker_en, b.kicker_cn, L) || (en ? 'REFER A FRIEND' : '推广计划'),
            title:      lang.pick(b.title_en,  b.title_cn,  L) || (en ? `Get ¥${reward}. Give ¥${reward}.` : `各得 ¥${reward}。`),
            subtitle:   lang.pick(b.subtitle_en, b.subtitle_cn, L) || (en ? 'Share your code — when a friend orders, you both win.' : '分享邀请码,好友下单后双方各得奖励。'),
            code,
            codePlaceholder: en ? '——' : '——',
            codeLabel:  en ? 'YOUR CODE' : '邀请码',
            copyLabel:  en ? 'COPY' : '复制',
            shareLabel: en ? 'SHARE' : '分享',
            ctaLabel:   lang.pick(b.cta_label_en, b.cta_label_cn, L) || (en ? 'OPEN' : '查看详情'),
            ctaTarget:  b.cta_target || 'affiliate',
            accent:     color(b.accent_color || 'ink'),
            statsLabel,
            // Stat-view specific: separate "headline number" + "supporting line"
            statHeadline: en ? `¥${earnedNum.toFixed(0)}` : `¥${earnedNum.toFixed(0)}`,
            statSubline:  hasActivity
              ? (en ? `from ${invitedNum} friend${invitedNum === 1 ? '' : 's'}` : `来自 ${invitedNum} 位好友`)
              : (en ? `¥${reward} per friend who orders` : `每位下单的好友 ¥${reward}`),
            statCta:    en ? 'INVITE A FRIEND →' : '邀请好友 →',
            // Receipt-view specific decorations
            receiptStub: en ? 'ROOTS · REFER' : 'ROOTS · 推广',
            receiptDate: '—',  // placeholder; could populate w/ today if we wanted
            enabled:    af.enabled !== false,
            disabledMsg: en ? 'Refer-a-friend is paused.' : '推广计划暂停中。',
            signinHint: en ? 'Tap to open and get your code →' : '点击获取你的邀请码 →',
          };
          break;
        }
        case 'greeting': {
          // Personalized "Good morning, {name} · {points} pts" header.
          // Time-of-day derived from local clock; falls back to a generic
          // tone if the customer hasn't signed in yet.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const c = this.properties.customer || {};
          const nick = (c.nickname || '').trim();
          const firstName = nick ? nick.split(/[ ·,]+/)[0] : '';
          const hr = new Date().getHours();
          const tone =
            hr < 5  ? 'night' :
            hr < 12 ? 'morning' :
            hr < 17 ? 'afternoon' :
            hr < 22 ? 'evening' : 'night';
          const greetMap = {
            en: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hi night-owl' },
            cn: { morning: '早上好',         afternoon: '下午好',         evening: '晚上好',       night: '夜深了' },
          };
          // Custom override wins if the admin set one for this tone.
          const overrideEn = b['greet_' + tone + '_en'] || b.greet_en;
          const overrideCn = b['greet_' + tone + '_cn'] || b.greet_cn;
          const greetingText = lang.pick(overrideEn, overrideCn, L) || greetMap[L === 'cn' ? 'cn' : 'en'][tone];
          // Optional time-of-day emoji prefix (opt-in via show_tod_emoji='on').
          const todMap = { morning: '🌅', afternoon: '☀️', evening: '🌙', night: '🌟' };
          const todPrefix = (b.show_tod_emoji === 'on') ? (todMap[tone] + ' ') : '';
          const greeting = todPrefix + greetingText;
          // Headline: "Good morning, Asher." — leave name off when missing.
          const headline = firstName
            ? `${greeting}, ${firstName}.`
            : `${greeting}.`;
          const pts = Number(c.points_balance) || 0;
          const showPts = b.show_points !== false && pts > 0;
          const ptsValue = (pts / 100).toFixed(2);
          const view = b.view || 'card';
          const isDesign = view === 'classic' || view === 'wallet' || view === 'coin';
          out.greeting = {
            view,
            kicker:   lang.pick(b.kicker_en, b.kicker_cn, L),
            headline,
            pointsLabel: showPts
              ? (L === 'cn' ? `${pts} 积分 · 抵 ¥${ptsValue}` : `${pts} pts · 抵¥${ptsValue}`)
              : '',
            pointsNum:   showPts ? String(pts) : '',
            pointsCnyLabel: showPts
              ? (L === 'cn' ? `积分 · 抵 ¥${ptsValue}` : `pts · ¥${ptsValue}`)
              : '',
            ctaLabel: lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || '',
            accent: color(b.accent_color || 'lime-leaf'),
          };
          if (isDesign) {
            // Welcome-back design directions: mood colour story + energy
            // scale, all per-element-overridable. Mirrors cms.html preview.
            const MOODS = {
              forest: { band: '#34421C', accent: '#CCD900', kicker: '#A7AE5E', badge: '#F2CA6C' },
              dusk:   { band: '#39301A', accent: '#F2CA6C', kicker: '#B79A5E', badge: '#FFAF60' },
              berry:  { band: '#3A2330', accent: '#F4B8CB', kicker: '#C892A4', badge: '#E96174' },
            };
            const EN = ({
              refined:  { head: 0.9,  border: 1.5, radius: 12, coin: 3, halftone: 0.06 },
              balanced: { head: 1.0,  border: 2,   radius: 16, coin: 4, halftone: 0.12 },
              playful:  { head: 1.14, border: 2.5, radius: 20, coin: 7, halftone: 0.20 },
            })[b.energy] || { head: 1.0, border: 2, radius: 16, coin: 4, halftone: 0.12 };
            const mp = MOODS[b.mood] || MOODS.forest;
            const g = out.greeting;
            g.firstName = firstName;
            g.greetWord = greeting;            // greeting without the name suffix
            // No secondary cross-language greeting line — each language stays
            // single-language (no EN+CN mix).
            g.cnLine    = '';
            const ink   = color(b.ink_color) || '#1a1a17';
            g.band     = color(b.band_color)   || mp.band;
            g.accentC  = color(b.accent_color) || mp.accent;
            g.kickerC  = color(b.kicker_color) || mp.kicker;
            g.badgeC   = color(b.badge_color)  || mp.badge;
            g.inkC     = ink;
            g.head     = EN.head;
            g.border   = EN.border;
            g.radius   = EN.radius;
            g.coinShadow = `0 ${EN.coin}px 0 ${ink}`;
            g.halftone = EN.halftone;
            const walletV = (Number(c.balance) || 0).toFixed(2);
            g.walletLabel = (L === 'cn' ? '钱包' : 'WALLET');
            g.walletValue = '¥' + walletV;
            g.ptsUnit  = (L === 'cn' ? '积分' : 'pts');
            g.ptsCny   = showPts ? ('¥' + ptsValue) : '';
            g.ptsUnitCny = showPts ? (g.ptsUnit + ' · ¥' + ptsValue) : '';
            g.corner   = b.corner_radius || 'sharp';
            g.enter    = b.entrance_anim || 'none';
            // Pre-built inline style: band background + ink text + the --gr-*
            // custom properties the design CSS reads. Keeps the WXML clean.
            g.bandStyle = `background:${g.band};color:${ink};`
              + `--gr-accent:${g.accentC};--gr-kicker:${g.kickerC};--gr-badge:${g.badgeC};--gr-ink:${ink};`
              + `--gr-head:${g.head};--gr-border:${g.border}px;--gr-radius:${g.radius}px;`
              + `--gr-coin:${g.coinShadow};--gr-halftone:${g.halftone};`;
          }
          break;
        }
        case 'kitchen_status': {
          // Live "kitchen open · ETA" card. Admin types hours + ETA; we
          // compute open/closed against the local clock. No server fetch.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const openH  = Number(b.open_hour);
          const closeH = Number(b.close_hour);
          const hr  = new Date().getHours() + (new Date().getMinutes() / 60);
          const isOpen = Number.isFinite(openH) && Number.isFinite(closeH)
            ? (closeH > openH ? (hr >= openH && hr < closeH) : (hr >= openH || hr < closeH))
            : true;
          const eta = Number(b.eta_minutes) || 0;
          const hoursLabel = lang.pick(b.hours_en, b.hours_cn, L);
          out.kitchenCard = {
            kicker: lang.pick(b.kicker_en, b.kicker_cn, L),
            title:  lang.pick(b.title_en, b.title_cn, L) || (L === 'cn' ? '厨房' : 'Kitchen'),
            isOpen,
            statusLabel: isOpen
              ? (L === 'cn' ? '营业中' : 'Open now')
              : (L === 'cn' ? '已打烊' : 'Closed'),
            statusColor: isOpen ? color(b.open_color || 'pea-sprout') : color(b.closed_color || 'berry-punch'),
            hoursLabel,
            etaLabel: (eta > 0 && isOpen)
              ? (L === 'cn' ? `约 ${eta} 分钟送达` : `~${eta} min delivery`)
              : '',
            address: lang.pick(b.address_en, b.address_cn, L)
              || (this.properties.kitchen?.address || ''),
            ctaLabel: lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || 'shop',
          };
          break;
        }
        case 'recipe_story': {
          // Editorial long-form: image + serif headline + paragraphs + linked product.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const linked = b.product_id ? this.properties.products.find(p => p.id === b.product_id) : null;
          let linkedCard = null;
          if (linked) {
            const regular = Number(linked.sell_price ?? linked.price) || 0;
            const eff = Number(linked.effective_price) > 0 ? Number(linked.effective_price) : regular;
            linkedCard = {
              id: linked.id,
              image: absUrl(linked.image_url) || linked.image_data || '',
              name:  lang.pick(linked.name_en, linked.name_cn, L),
              tagline: lang.pick(linked.tagline_en, linked.tagline_cn, L) || '',
              price: eff > 0 ? '¥' + eff.toFixed(2) : '',
            };
          }
          const bodyText = lang.pick(b.body_en, b.body_cn, L) || '';
          // Split body on double-newlines so the template can render real paragraphs.
          const paragraphs = bodyText.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
          out.recipe = {
            imageUrl: absUrl(b.image_url),
            imageView: b.image_view || 'top',  // 'top' | 'side'
            kicker:   lang.pick(b.kicker_en, b.kicker_cn, L),
            headline: lang.pick(b.headline_en, b.headline_cn, L),
            byline:   lang.pick(b.byline_en, b.byline_cn, L),
            readTime: b.read_time_minutes ? `${b.read_time_minutes} ${L === 'cn' ? '分钟' : 'min'}` : '',
            paragraphs,
            linkedProduct: linkedCard,
            ctaLabel:  lang.pick(b.cta_label_en, b.cta_label_cn, L),
            ctaTarget: b.cta_target || (linkedCard ? 'product:' + linkedCard.id : ''),
            btnBg: color(b.btn_color || ''),
            btnFg: b.btn_color ? btnText(b.btn_color) : '',
          };
          // 2026-05-20 — corner radius preset on the recipe card.
          out.recipeCorner = b.corner_radius || 'subtle';
          break;
        }
        case 'bundle': {
          // "Buy these together" quick-add. Each block holds N variants
          // (Starter / Family / Power / …) — the customer taps a pill at
          // the top to swap which one is shown. The recommended variant
          // (or the first if none is marked) loads first and shows a ★.
          // Items go into the cart at their normal prices; voucher and
          // bundle_price are per-variant so promos can vary.
          // Resolve the feel (mood / finish / energy + colour overrides).
          const BT = resolveBundleTheme(b);
          const HS = BT.headScale;
          out.bg = BT.surface;
          out.fg = BT.text;
          out.accent = BT.cta;
          out.bundleBtnFg = BT.ctaText;
          // 2026-05-20 — corner radius preset + entrance animation.
          out.bundleCorner = b.corner_radius || 'subtle';
          out.bundleEnter  = b.entrance_anim || 'none';

          // Back-compat: blocks saved before the variants[] refactor
          // have flat fields — wrap them in a single-variant array.
          const rawVariants = (Array.isArray(b.variants) && b.variants.length) ? b.variants : [{
            id: 'v1',
            label_en: 'Bundle', label_cn: '组合',
            title_en: b.title_en, title_cn: b.title_cn,
            subtitle_en: b.subtitle_en, subtitle_cn: b.subtitle_cn,
            product_ids: b.product_ids,
            bundle_price: b.bundle_price,
            auto_voucher_code: b.auto_voucher_code,
            cta_label_en: b.cta_label_en, cta_label_cn: b.cta_label_cn,
            recommended: true,
          }];

          const buildVariant = v => {
            const ids = Array.isArray(v.product_ids) ? v.product_ids : [];
            const items = ids
              .map(id => this.properties.products.find(p => p.id === id))
              .filter(Boolean)
              .slice(0, 6);
            let sum = 0;
            const cards = items.map(p => {
              const regular = Number(p.sell_price ?? p.price) || 0;
              const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
              sum += eff;
              return {
                id: p.id,
                image: absUrl(p.image_url) || p.image_data || '',
                name:  lang.pick(p.name_en, p.name_cn, L),
                cn:    '',
                price: eff > 0 ? '¥' + eff.toFixed(2) : '',
              };
            });
            const bundlePrice = Number(v.bundle_price) || 0;
            const showSavings = bundlePrice > 0 && bundlePrice < sum;
            const savAmt = sum - bundlePrice;
            // Receipt itemised rows — first row gets a solid rule, rest dashed.
            const rows = cards.map((c, i) => ({
              ...c,
              borderTop: i === 0 ? '3rpx solid #1a1a17' : '2rpx dashed rgba(0,0,0,.22)',
            }));
            // Sticker overlapping tubs — show up to 3, alternate vertical offset
            // and (riso only) a small rotation. Positions are absolute in rpx.
            const tubs = cards.slice(0, 3).map((c, i) => ({
              ...c,
              style: `left:${i * 144}rpx;top:${i % 2 === 0 ? 0 : 20}rpx;`
                + `border:${BT.elBorder};box-shadow:${BT.elShadow};`
                + `transform:${BT.riso ? `rotate(${i % 2 === 0 ? -3 : 3}deg)` : 'none'};`,
            }));
            const moreCount = cards.length - tubs.length;
            return {
              id: v.id || '',
              label: lang.pick(v.label_en, v.label_cn, L) || (L === 'cn' ? '组合' : 'Bundle'),
              recommended: !!v.recommended,
              title:    lang.pick(v.title_en, v.title_cn, L),
              subtitle: lang.pick(v.subtitle_en, v.subtitle_cn, L),
              cards,
              cardCount: cards.length,
              rows,
              tubs,
              moreText: moreCount > 0 ? (L === 'cn' ? `+ ${moreCount} 件` : `+ ${moreCount} MORE`) : '',
              sumLabel:   sum > 0 ? '¥' + sum.toFixed(2) : '',
              priceLabel: bundlePrice > 0 ? '¥' + bundlePrice.toFixed(2) : (sum > 0 ? '¥' + sum.toFixed(2) : ''),
              showSavings,
              savingsLabel: showSavings
                ? (L === 'cn' ? `省 ¥${savAmt.toFixed(2)}` : `SAVE ¥${savAmt.toFixed(2)}`)
                : '',
              stampAmt: showSavings ? '¥' + Math.round(savAmt) : '',
              voucherCode: (v.auto_voucher_code || '').toUpperCase(),
              addLabel:  lang.pick(v.cta_label_en, v.cta_label_cn, L)
                || (L === 'cn' ? `加入购物车 (${cards.length} 件)` : `ADD BUNDLE · ${cards.length} ITEMS`),
              empty: cards.length === 0,
            };
          };

          const variants = rawVariants.map(buildVariant);
          const recIdx = Math.max(0, variants.findIndex(v => v.recommended));
          const activeIndex = recIdx >= 0 ? recIdx : 0;

          out.bundle = {
            kicker: lang.pick(b.kicker_en, b.kicker_cn, L),
            variants,
            showPills: variants.length > 1,
            activeIndex,
            active: variants[activeIndex] || variants[0],
            emptyText: L === 'cn' ? '请在管理后台选择商品' : 'Pick products in the admin',
            // Resolved feel — colours + flags shared by every variant (the
            // pill swap only re-points `active`, so theme lives here).
            style:       BT.style,
            riso:        BT.riso,
            innerCss:    BT.innerCss,
            text:        BT.text,
            price:       BT.price,
            cta:         BT.cta,
            ctaText:     BT.ctaText,
            toggleOn:    BT.toggleOn,
            toggleOnText: BT.toggleOnText,
            save:        BT.save,
            saveText:    BT.saveText,
            sticker:     BT.sticker,
            stickerText: BT.stickerText,
            elBorder:    BT.elBorder,
            elShadow:    BT.elShadow,
            // Head-scale-derived font sizes (rpx) per style.
            titleSize:   Math.round(48 * HS) + 'rpx',
            priceSize:   Math.round(44 * HS) + 'rpx',
            tallyPriceSize: Math.round(52 * HS) + 'rpx',
            stickerPriceSize: Math.round(56 * HS) + 'rpx',
            // Static labels.
            stickerLabel:     L === 'cn' ? '搭配省' : 'BUNDLE & SAVE',
            tapText:          L === 'cn' ? '一键直达购物车' : 'Tap once — straight to cart',
            itemsTotalLabel:  L === 'cn' ? '单买' : 'Items total',
            bundlePriceLabel: L === 'cn' ? '套装价' : 'Bundle price',
          };
          break;
        }
        case 'wecom_contact': {
          // "Add us on 企业微信" block — two follow-paths, both optional:
          //  · <button open-type="contact"> → opens mini-app's bound CSR
          //    chat. Bind a WeCom CSR in 小程序管理后台 → 设置 → 客服 →
          //    添加客服 → 选择企业微信客服 first, otherwise this falls
          //    back to whatever WeChat OA CSR is configured.
          //  · 联系我 QR → long-press → 识别二维码 → enters the
          //    add-WeCom-contact flow → becomes a 客户 in the company's
          //    WeCom CRM. Generated in 企微后台 → 客户联系 → 联系我.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          const view = b.view === 'strip' ? 'strip' : 'card';
          // Card art direction (card view only): warm | coupon | poster |
          // compact. Mirrors the four styles in the Mini App Editor.
          const cardStyle = ['warm', 'coupon', 'poster', 'compact'].includes(b.card_style) ? b.card_style : 'warm';
          const wcAccent = color(b.accent_color || 'forest-kale');
          const wcBtnFg = btnText(b.accent_color || 'forest-kale');
          out.wecom = {
            view,
            cardStyle,
            // Precomputed CTA/stub style strings (template-friendly):
            // coupon stub = accent fill; its inner button flips to fg-on-accent.
            // poster/compact CTA = accent fill with auto-contrast text.
            stubStyle:      `background:${wcAccent};color:${wcBtnFg}`,
            couponCtaStyle: `background:${out.fg};color:${wcAccent}`,
            fillCtaStyle:   `background:${wcAccent};color:${wcBtnFg}`,
            kicker:   lang.pick(b.kicker_en, b.kicker_cn, L),
            title:    lang.pick(b.title_en, b.title_cn, L),
            subtitle: lang.pick(b.subtitle_en, b.subtitle_cn, L),
            hint:     lang.pick(b.hint_en, b.hint_cn, L)
              || (L === 'cn' ? '长按二维码 · 识别添加' : 'Long-press QR · tap "Add"'),
            // Default label tracks behaviour: when a QR is configured the
            // button opens the add-friend flow, so "Add us" reads truer
            // than the legacy "Chat with us" CSR-chat label.
            buttonLabel: lang.pick(b.button_label_en, b.button_label_cn, L)
              || (b.qr_image_url
                    ? (L === 'cn' ? '添加我们' : 'Add us')
                    : (L === 'cn' ? '联系客服' : 'Chat with us')),
            qrUrl: absUrl(b.qr_image_url),
            // WeCom 微信客服 chat link — when set, the button calls
            // wx.openCustomerServiceChat() and lands the customer in the
            // company's WeCom CSR session (bypassing whatever 公众号客服
            // would have been used by the legacy open-type="contact"
            // fallback). Generate the URL in 企业微信管理后台 → 微信客服
            // → 创建客服账号. Optional corpId comes from 企业微信 →
            // 我的企业 → 企业信息.
            kfUrl:  b.wecom_kf_url  || '',
            corpId: b.wecom_corp_id || '',
            agentName: b.agent_name || '',
            showButton: b.show_chat_button !== false,
            showQr:     b.show_qr !== false,
            accent: color(b.accent_color || 'forest-kale'),
            btnFg: btnText(b.accent_color || 'forest-kale'),
            // ── "Stay in the loop" warm-pop redesign (card view) ──
            // Four fixed value-prop chips (active language only, to match the
            // app's global EN/中 toggle). Icons are drawn in WXSS by .lc-ico-*.
            // The 2nd chip tracks the block accent; the rest are brand pastels.
            props: [
              { k: 'promo',   icon: '/assets/icons/loop/promo.svg',   bg: '#FFAF60', label: L === 'cn' ? '优惠活动' : 'Promotions' },
              { k: 'drops',   icon: '/assets/icons/loop/drops.svg',   bg: color(b.accent_color || 'forest-kale'), label: L === 'cn' ? '新品首发' : 'New drops' },
              { k: 'offers',  icon: '/assets/icons/loop/offers.svg',  bg: '#F4B8CB', label: L === 'cn' ? '专属福利' : 'Exclusive offers' },
              { k: 'support', icon: '/assets/icons/loop/support.svg', bg: '#B2CFED', label: L === 'cn' ? '专人客服' : 'Direct support' },
            ],
            // Mascot perches over the card's top edge. Optional per block.
            showMascot: b.show_mascot !== false,
            mascot: '/assets/brand/mascot-flex-ink.png',
            // Hard offset drop-shadow behind the card. Optional per block.
            showShadow: b.show_shadow !== false,
            // Outer border framing the card. Optional per block.
            showBorder: b.show_border !== false,
            // Dotted "paper" texture over the bg colour. Optional per block.
            showTexture: b.show_texture !== false,
            // Social proof — opt-in and real-number-only: hidden unless the
            // operator types an actual member count (e.g. "1,500+").
            proofCount: (b.proof_count || '').trim(),
            showProof: b.show_proof !== false && !!(b.proof_count || '').trim(),
            proofPre:  L === 'cn' ? '已有 ' : 'Joined by ',
            proofPost: L === 'cn' ? ' 位会员' : ' members',
            // Compact style: one-line value props + zigzag (perforated) edge.
            oneLineProps: (L === 'cn'
              ? ['优惠活动', '新品首发', '专属福利', '专人客服']
              : ['Promotions', 'New drops', 'Exclusive offers', 'Direct support']).join(' · '),
            zigClip: cardStyle === 'compact' ? loopZigzag() : '',
          };
          break;
        }
        case 'countdown_timer': {
          out.bg = color(b.bg_color || 'ink');
          out.fg = color(b.fg_color || 'lime-leaf');
          const kicker = lang.pick(b.kicker_en, b.kicker_cn, L);
          const title  = lang.pick(b.title_en, b.title_cn, L);
          const ctaLabel = lang.pick(b.cta_label_en, b.cta_label_cn, L);
          const ms = b.ends_at ? (new Date(b.ends_at).getTime() - Date.now()) : 0;
          if (ms <= 0) {
            const ended = lang.pick(b.ended_text_en, b.ended_text_cn, L)
              || (L === 'cn' ? '本场已结束' : "That's a wrap");
            out.countdown = { kicker, title, ended, ctaLabel: '', ctaTarget: '', cells: [], ended: ended, isEnded: true };
          } else {
            let s = Math.floor(ms / 1000);
            const d = Math.floor(s / 86400); s -= d * 86400;
            const h = Math.floor(s / 3600);  s -= h * 3600;
            const m = Math.floor(s / 60);    s -= m * 60;
            const labels = L === 'cn' ? ['天','时','分','秒'] : ['DAYS','HRS','MIN','SEC'];
            const pad = n => (n < 10 ? '0' + n : '' + n);
            out.countdown = {
              kicker, title,
              ctaLabel, ctaTarget: b.cta_target || '',
              btnBg: color(b.btn_color || ''),
              btnFg: b.btn_color ? btnText(b.btn_color) : '',
              cells: [
                { num: pad(d), lbl: labels[0] },
                { num: pad(h), lbl: labels[1] },
                { num: pad(m), lbl: labels[2] },
                { num: pad(s), lbl: labels[3] },
              ],
              isEnded: false,
              ended: '',
            };
          }
          // 2026-05-20 — corner radius preset + urgency animation flag.
          // 'urgent' fires when remaining time crosses the configured
          // threshold (off / pulse=<10min / pulse_hour=<1h).
          out.countdownCorner = b.corner_radius || 'subtle';
          const urgAnim = b.urgency_anim || 'pulse';
          let urgent = false;
          if (ms > 0 && urgAnim !== 'off') {
            const threshold = urgAnim === 'pulse_hour' ? 60 * 60 * 1000 : 10 * 60 * 1000;
            urgent = ms < threshold;
          }
          out.countdownUrgent = urgent;
          break;
        }
        case 'leaderboard': {
          // Roots Club ranking strip. Rows are pre-fetched + pre-masked by the
          // host page (home.js) via /api/retail/storefront/leaderboard, keyed
          // by metric|period|top_n|reveal_mode — we just format + lay out here.
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
          out.leaderboardAccent = color(b.accent_color || 'forest-kale');
          const metric = b.metric || 'lifetime_spend';
          const period = b.period || 'month';
          const topN   = Math.max(3, Math.min(10, b.top_n || 5));
          const reveal = b.reveal_mode || 'first_char';
          const key = `${metric}|${period}|${topN}|${reveal}`;
          const board = this.properties.leaderboards || {};
          const entries = Array.isArray(board[key]) ? board[key] : [];
          // Hide while data hasn't arrived (entries empty during load), when the
          // board is genuinely empty, or when there are fewer qualifiers than
          // the operator's hide_when_under floor — keeps Home from showing a
          // sad 1-row board in the early days.
          const hideUnder = Number(b.hide_when_under) || 0;
          if (!entries.length || (hideUnder && entries.length < hideUnder)) {
            out.leaderboardCard = null;
            out.leaderboardHidden = true;
            break;
          }
          const showValue = b.show_value !== false;
          const medals = ['🥇', '🥈', '🥉'];
          const fmtValue = (v) => {
            const n = Number(v) || 0;
            if (metric === 'lifetime_spend') return '¥' + Math.round(n).toLocaleString();
            if (metric === 'points_balance') return n.toLocaleString() + (L === 'cn' ? ' 分' : ' pts');
            return n.toLocaleString() + (L === 'cn' ? ' 单' : ' orders');
          };
          const periodLabel =
            period === 'week'  ? (L === 'cn' ? '本周' : 'This week') :
            period === 'month' ? (L === 'cn' ? '本月' : 'This month') :
            period === 'year'  ? (L === 'cn' ? '今年' : 'This year') :
                                 (L === 'cn' ? '累计' : 'All time');
          const rows = entries.slice(0, topN).map((e, i) => {
            const rank = Number(e.rank) || (i + 1);
            return {
              rank,
              medal: i < 3 ? medals[i] : '',
              rankText: i < 3 ? '' : String(rank),
              name: e.name || (L === 'cn' ? '会员' : 'Member'),
              value: showValue ? fmtValue(e.value) : '',
            };
          });
          out.leaderboardHidden = false;
          out.leaderboardCard = {
            kicker:  lang.pick(b.kicker_en, b.kicker_cn, L),
            title:   lang.pick(b.title_en, b.title_cn, L) || (L === 'cn' ? '本月铁粉' : 'Top customers'),
            subhead: lang.pick(b.subhead_en, b.subhead_cn, L),
            footer:  lang.pick(b.footer_en, b.footer_cn, L),
            periodLabel,
            rows,
            ctaLabel: L === 'cn' ? '查看完整排行' : 'View full leaderboard',
          };
          break;
        }
        case 'video_banner': {
          // Autoplaying muted loop. The clip + optional poster come straight
          // from the CMS; playback flags are fixed (no controls) so it just
          // starts when it scrolls into view.
          out.videoUrl    = absUrl(b.video_url);
          out.videoPoster = absUrl(b.poster_url);
          out.videoHeight = b.height_px || 420;
          out.videoLink   = b.link_target || '';
          // 'fullscreen' covers the whole device (onboarding splash); 'banner'
          // is the fixed-height in-page band.
          out.videoFullscreen = b.display === 'fullscreen';
          break;
        }
      }
      this.setData(out, () => {
        // <swiper> can't auto-size, so a fixed height clips long reviews
        // (the byline gets cut off). Measure the tallest review and grow the
        // swiper to fit. Runs only for the carousel view with >1 review.
        if (out.type === 'review_card' && out.reviewView === 'carousel'
            && out.reviews && out.reviews.length > 1) {
          this.measureReviewSwiper();
        }
      });
    },

    // Size the review carousel's <swiper> to its tallest slide so no byline
    // gets clipped. Falls back silently if the query returns nothing.
    measureReviewSwiper() {
      this.createSelectorQuery()
        .selectAll('.rv-item')
        .boundingClientRect((rects) => {
          if (!rects || !rects.length) return;
          let maxPx = 0;
          rects.forEach((r) => { if (r && r.height > maxPx) maxPx = r.height; });
          if (maxPx <= 0) return;
          let winW = 375;
          try {
            const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
            if (info && info.windowWidth) winW = info.windowWidth;
          } catch (e) { /* keep default */ }
          // px → rpx, plus headroom for the indicator dots; floor at 360rpx.
          const rpx = (maxPx * 750) / winW + 56;
          const h = Math.max(360, Math.ceil(rpx));
          if (h !== this.data.reviewSwiperH) this.setData({ reviewSwiperH: h });
        })
        .exec();
    },

    onCtaTap(e) {
      const idx = e.currentTarget.dataset.idx;
      const cta = this.data.ctas[idx];
      this.triggerEvent('cta', { target: cta.target });
    },
    // Spotlight review layout: step the active card by ±1 (wraps) and pick a
    // card directly from the thumbnail rail. Each updates the "NN / NN" counter.
    spotStep(e) {
      const n = (this.data.reviews || []).length;
      if (!n) return;
      const step = parseInt(e.currentTarget.dataset.step, 10) || 0;
      const i = ((this.data.spotActive + step) % n + n) % n;
      this.setData({ spotActive: i, spotCount: pad2(i + 1) + ' / ' + pad2(n) });
    },
    spotPick(e) {
      const n = (this.data.reviews || []).length;
      const i = parseInt(e.currentTarget.dataset.idx, 10);
      if (!n || Number.isNaN(i)) return;
      this.setData({ spotActive: i, spotCount: pad2(i + 1) + ' / ' + pad2(n) });
    },
    onCountdownCtaTap() {
      const target = this.data.countdown?.ctaTarget;
      if (target) this.triggerEvent('cta', { target });
    },
    onFlashCardTap(e) {
      const id = e.currentTarget.dataset.id;
      if (id) this.triggerEvent('product', { id });
    },
    onFlashCtaTap() {
      const target = this.data.flashStrip?.ctaTarget || 'shop';
      this.triggerEvent('cta', { target });
    },
    onAnnounceTap() {
      const target = this.data.announceLink;
      if (target) this.triggerEvent('cta', { target });
    },
    onCouponCtaTap() {
      const target = this.data.coupon?.ctaTarget || 'coupons';
      this.triggerEvent('cta', { target });
    },
    onCouponCodeTap() {
      const code = this.data.coupon?.code;
      if (!code) return;
      wx.setClipboardData({ data: code, success: () => {
        wx.showToast({ title: this.properties.lang === 'cn' ? '已复制' : 'Copied', icon: 'success' });
      }});
    },
    onPointsCtaTap() {
      const target = this.data.points?.ctaTarget || 'me';
      this.triggerEvent('cta', { target });
    },
    onStoreCtaTap(e) {
      // Multi-store: read target from the tapped card's dataset.
      // Legacy single-store: fall back to this.data.store.
      const target = (e && e.currentTarget && e.currentTarget.dataset.target)
        || this.data.store?.ctaTarget;
      if (target) this.triggerEvent('cta', { target });
    },
    onVotingTap() {
      const target = this.data.voting?.ctaTarget || 'voting';
      this.triggerEvent('cta', { target });
    },
    // Inline view: tap an option to pre-select (no API call yet).
    onVotingPick(e) {
      const v = this.data.voting;
      if (!v || !v.livePoll || v.livePoll.isClosed || v.livePoll.showResults) return;
      const optionId = Number(e.currentTarget.dataset.id);
      if (!optionId) return;
      // Re-decorate options so the chosen one renders highlighted.
      const next = { ...v, chosenOptionId: optionId };
      next.livePoll = { ...v.livePoll, options: v.livePoll.options.map(o => ({ ...o, isChosen: o.id === optionId })) };
      this.setData({ voting: next });
    },
    // Inline view: cast the picked vote. Emits 'vote' so the parent page
    // can POST to /api/retail/polls/:id/vote and then refresh state.polls.
    onVotingCast() {
      const v = this.data.voting;
      if (!v || !v.livePoll || v.livePoll.isClosed || v.livePoll.showResults) return;
      const optionId = v.chosenOptionId;
      if (!optionId) return;
      this.setData({ voting: { ...v, voteJustCast: true } });
      this.triggerEvent('vote', { pollId: v.livePoll.id, optionId });
    },
    onAffiliateTap() {
      const target = this.data.affiliateCard?.ctaTarget || 'affiliate';
      this.triggerEvent('cta', { target });
    },
    onAffiliateCopyTap() {
      const code = this.data.affiliateCard?.code;
      if (!code) {
        // No code yet → fall through to the page so they can sign in / mint one
        this.triggerEvent('cta', { target: this.data.affiliateCard?.ctaTarget || 'affiliate' });
        return;
      }
      wx.setClipboardData({ data: code, success: () => {
        wx.showToast({ title: this.properties.lang === 'cn' ? '已复制' : 'Code copied', icon: 'success' });
      }});
    },
    onStorePhoneTap(e) {
      const raw = (e && e.currentTarget && e.currentTarget.dataset.phone)
        || this.data.store?.phone || '';
      const phone = String(raw).replace(/[^0-9+\-]/g, '');
      if (phone) wx.makePhoneCall({ phoneNumber: phone }).catch(() => {});
    },
    onCategoryTap(e) {
      this.triggerEvent('category', { id: e.currentTarget.dataset.id });
    },
    onProductTap(e) {
      this.triggerEvent('product', { id: e.currentTarget.dataset.id });
    },
    // "SEE ALL" header link on product_grid / category_tabs — routes via the
    // shared cta handler (category:<id> when category-scoped, else the shop tab).
    onSeeAllTap(e) {
      this.triggerEvent('cta', { target: e.currentTarget.dataset.target || 'shop' });
    },
    onOrderTrackerTap() {
      const ot = this.data.orderTracker;
      if (ot && ot.id) this.triggerEvent('order', { id: ot.id });
    },
    // "N more orders in progress →" link — route to the full orders list.
    onOrderTrackerMore() {
      this.triggerEvent('cta', { target: 'orders' });
    },
    onFavoritesTap() {
      // "See all" link on the favorites block — route to /pages/favorites.
      this.triggerEvent('cta', { target: 'favorites' });
    },
    onLeaderboardTap() {
      // Tapping the leaderboard strip opens the full Roots Club ranking page.
      this.triggerEvent('cta', { target: 'leaderboard' });
    },
    onVideoTap() {
      const target = this.data.videoLink;
      if (target) this.triggerEvent('cta', { target });
    },
    onGreetingCtaTap() {
      const target = this.data.greeting?.ctaTarget;
      if (target) this.triggerEvent('cta', { target });
    },
    // Tap on the inline notif badge inside the greeting block — routes to
    // the Notifications page. catchtap on the badge stops the outer
    // greeting CTA tap from firing.
    onNotifTap() {
      this.triggerEvent('cta', { target: 'notifications' });
    },
    onKitchenCtaTap() {
      const target = this.data.kitchenCard?.ctaTarget;
      if (target) this.triggerEvent('cta', { target });
    },
    onRecipeCtaTap() {
      const target = this.data.recipe?.ctaTarget;
      if (target) this.triggerEvent('cta', { target });
    },
    onBundleAddTap() {
      const b = this.data.bundle;
      const v = b && b.active;
      if (!v || !v.cards || !v.cards.length) return;
      // Emits up to home.js, which holds the product list and cart util.
      this.triggerEvent('bundle', {
        productIds: v.cards.map(c => c.id),
        voucherCode: v.voucherCode || '',
        variantId:   v.id || '',
      });
    },
    // Tap on a variant pill — swap which variant is shown without
    // rebuilding the parent's data (cheap local setData).
    onBundleVariantTap(e) {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const b = this.data.bundle;
      if (!b || !b.variants || Number.isNaN(idx) || !b.variants[idx]) return;
      this.setData({
        'bundle.activeIndex': idx,
        'bundle.active':      b.variants[idx],
      });
    },
    onWecomQrTap() {
      const url = this.data.wecom?.qrUrl;
      if (!url) return;
      // Open in preview so a long-press exposes WeChat's native
      // "识别图中二维码" sheet — that's the actual add-contact path.
      wx.previewImage({ urls: [url], current: url });
    },
    // Tapping the "Add Us" button opens the QR full-screen. Same flow as
    // the inline QR's bindtap — both surfaces lead to the same long-press →
    // 识别二维码 → 添加朋友 sheet. WeChat does not allow a mini-program
    // button to add a WeChat friend directly (anti-spam); previewing the
    // QR is the only sanctioned route. This handler is wired in when the
    // block has a configured qrUrl; without one, the button falls back to
    // open-type="contact" for the legacy CSR-chat flow.
    onWecomCtaTap() {
      // [diag] If this fires, the block has NO kfUrl in the loaded config —
      // i.e. the CMS draft wasn't published, so the trial build never got
      // the 微信客服 link and went straight to the QR. Remove after debugging.
      console.log('[wecom-diag] CTA → QR path (no kfUrl in config)', this.data.wecom);
      this.onWecomQrTap();
    },
    // WeCom 微信客服 chat. Used when the block has a kfUrl configured but
    // no QR. Opens directly into the company's WeCom CSR thread — distinct
    // from the legacy <button open-type="contact"> path which routes to
    // whatever 客服 is bound in 小程序管理后台 (often the OA's CSR rather
    // than the company's WeCom).
    onWecomChatTap() {
      const w = this.data.wecom || {};
      const url = w.kfUrl;
      // [diag] Shows whether the link/corpId actually reached the build.
      // Remove after debugging.
      console.log('[wecom-diag] Chat path. kfUrl=', url, 'corpId=', w.corpId,
        'hasAPI=', typeof wx.openCustomerServiceChat === 'function');
      if (!url) return this.wecomFallbackToQr();
      // Some older WeChat clients don't expose openCustomerServiceChat —
      // go straight to the QR picture so the customer can still add us.
      if (typeof wx.openCustomerServiceChat !== 'function') {
        return this.wecomFallbackToQr();
      }
      const opts = {
        extInfo: { url },
        showMessageCard: false,
        fail: (err) => {
          // WeCom 微信客服 couldn't open — fall back to the add-us QR if one
          // is set, otherwise just tell the customer chat is unavailable.
          console.warn('openCustomerServiceChat failed', err);
          this.wecomFallbackToQr(true);
        },
      };
      // corpId is required by wx.openCustomerServiceChat for 企业微信
      // external contacts but may be omitted for unified 微信客服 links.
      // Only pass it when set so the API can pick the right routing.
      if (w.corpId) opts.corpId = w.corpId;
      wx.openCustomerServiceChat(opts);
    },
    // Fallback for the WeCom CTA: preview the 联系我 QR so a long-press →
    // 识别二维码 still lets the customer add the WeCom contact. When no QR
    // is configured, surface a toast instead of failing silently.
    wecomFallbackToQr(fromChatFail) {
      const url = this.data.wecom?.qrUrl;
      if (url) {
        wx.previewImage({ urls: [url], current: url });
        return;
      }
      if (fromChatFail) {
        wx.showToast({
          title: this.properties.lang === 'cn' ? '客服暂不可用' : 'Chat unavailable',
          icon: 'none',
        });
      }
    },
    onWecomContactError(e) {
      // <button open-type="contact"> emits this when no CSR is bound.
      // Surface a clear hint instead of failing silently.
      console.warn('wecom_contact: open-type="contact" failed', e.detail);
    },
  },
});
