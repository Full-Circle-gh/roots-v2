// One component that renders any block type from /api/retail/config.
// The WXML switches on block.type and renders the appropriate sub-template.
// All language / colour / fallback resolution is pre-computed in JS so the
// template stays declarative.

const lang = require('../../utils/lang');
const { BASE } = require('../../utils/api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

const COLOR_MAP = {
  'lime-leaf':   '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
  'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
  'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
  'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
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
    // stickers
    stickers: [],
    // dots
    dots: [],
    dotActiveColor: '#1a1a17',
    // countdown
    countdown: null,
    // flash sale strip
    flashStrip: null,
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
  },

  observers: {
    'block, lang, categories, products, flashSales, topProducts, affiliate, polls, customer, kitchen, favorites': function () {
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
          if (b.image_aspect && b.image_url) out.aspectRatio = String(b.image_aspect);
          out.placeholderH = b.height_px || 280;
          const ctas = Array.isArray(b.ctas) ? b.ctas : (b.cta_label ? [{ label_en: b.cta_label, label_cn: '', target: b.cta_target, style: 'primary' }] : []);
          out.ctas = ctas.map(c => ({
            label:  lang.pick(c.label_en ?? c.label, c.label_cn, L),
            target: c.target || '',
            style:  c.style || 'primary',
          }));
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
          out.catWord = L === 'cn' ? '分类' : 'CATEGORY';
          out.catView = b.view || 'tiles';
          out.catCols = Math.max(3, Math.min(5, b.columns || 4));
          out.catBg   = color(b.bg_color || '');
          const cats = (b.category_ids || [])
            .map(id => this.properties.categories.find(c => c.id === id))
            .filter(Boolean);
          const palette = ['papaya-glow','pea-sprout','berry-punch','golden-corn','skyberry','lotus'];
          out.tiles = cats.map((c, i) => {
            const splitName = lang.splitMixed(c.name, L);
            const letter = (splitName.trim()[0] || '').toUpperCase();
            const bg = color(palette[i % 6]);
            const fg = i % 6 === 1 || i % 6 === 2 ? '#fff' : '#1a1a17';
            return {
              id: c.id,
              num: '0' + (i + 1),
              name: splitName,
              letter,
              color: palette[i % 6],
              bg, fg,
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
          out.cols   = b.columns || 2;
          out.gridView = b.view || 'grid';
          // 2026-05-20 enhancements: card corner radius + grid density +
          // rank badge gating (only relevant for top_selling source).
          out.gridCorner  = b.corner_radius || 'subtle';
          out.gridDensity = b.density       || 'normal';
          out.gridRankMode = b.rank_badge || 'top_3';
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
              rank === 1 ? `🏆 NO. 01` :
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
        case 'spacer': {
          out.height = b.height_px || 24;
          // 2026-05-20 — optional decorative divider centred in the spacer.
          // 'none' is the legacy blank gap; line/dashes/dots draw a coloured
          // rule. dividerColor is resolved via the brand-color picker.
          out.dividerStyle = b.divider_style || 'none';
          out.dividerColor = color(b.divider_color || 'olive-moss');
          break;
        }
        case 'sticker_collage': {
          out.stickers = (b.stickers || []).map(s => ({
            label:  lang.pick(s.label_en, s.label_cn, L),
            bg:     color(s.color || 'citrus-zest'),
            rotate: s.rotate || 0,
          }));
          break;
        }
        case 'progress_dots': {
          const count  = Math.max(1, Math.min(10, b.count || 3));
          const active = Math.max(0, Math.min(count - 1, b.active_index ?? 0));
          out.dotActiveColor = color(b.color || 'ink');
          out.dots = [];
          for (let i = 0; i < count; i++) {
            out.dots.push({ active: i === active });
          }
          break;
        }
        case 'flash_sale_strip': {
          out.bg = color(b.bg_color || 'berry-punch');
          out.fg = color(b.fg_color || 'oat-milk');
          const view = b.view || 'strip';
          out.flashView = view;
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
          };
          break;
        }
        case 'review_card': {
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
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
          break;
        }
        case 'store_info': {
          out.bg = color(b.bg_color || 'oat-milk');
          out.fg = color(b.fg_color || 'ink');
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
          out.greeting = {
            view: b.view || 'card',
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
          out.bg = color(b.bg_color || 'corn');
          out.fg = color(b.fg_color || 'ink');
          out.accent = color(b.accent_color || 'ink');
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
                price: eff > 0 ? '¥' + eff.toFixed(2) : '',
              };
            });
            const bundlePrice = Number(v.bundle_price) || 0;
            const showSavings = bundlePrice > 0 && bundlePrice < sum;
            return {
              id: v.id || '',
              label: lang.pick(v.label_en, v.label_cn, L) || (L === 'cn' ? '组合' : 'Bundle'),
              recommended: !!v.recommended,
              title:    lang.pick(v.title_en, v.title_cn, L),
              subtitle: lang.pick(v.subtitle_en, v.subtitle_cn, L),
              cards,
              cardCount: cards.length,
              sumLabel:   sum > 0 ? '¥' + sum.toFixed(2) : '',
              priceLabel: bundlePrice > 0 ? '¥' + bundlePrice.toFixed(2) : (sum > 0 ? '¥' + sum.toFixed(2) : ''),
              savingsLabel: showSavings
                ? (L === 'cn' ? `省 ¥${(sum - bundlePrice).toFixed(2)}` : `SAVE ¥${(sum - bundlePrice).toFixed(2)}`)
                : '',
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
          out.wecom = {
            view,
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
      }
      this.setData(out);
    },

    onCtaTap(e) {
      const idx = e.currentTarget.dataset.idx;
      const cta = this.data.ctas[idx];
      this.triggerEvent('cta', { target: cta.target });
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
    onFavoritesTap() {
      // "See all" link on the favorites block — route to /pages/favorites.
      this.triggerEvent('cta', { target: 'favorites' });
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
      if (!url) return;
      const opts = {
        extInfo: { url },
        showMessageCard: false,
        fail: (err) => {
          console.warn('openCustomerServiceChat failed', err);
          wx.showToast({
            title: this.properties.lang === 'cn' ? '客服暂不可用' : 'Chat unavailable',
            icon: 'none',
          });
        },
      };
      // corpId is required by wx.openCustomerServiceChat for 企业微信
      // external contacts but may be omitted for unified 微信客服 links.
      // Only pass it when set so the API can pick the right routing.
      if (w.corpId) opts.corpId = w.corpId;
      wx.openCustomerServiceChat(opts);
    },
    onWecomContactError(e) {
      // <button open-type="contact"> emits this when no CSR is bound.
      // Surface a clear hint instead of failing silently.
      console.warn('wecom_contact: open-type="contact" failed', e.detail);
    },
  },
});
