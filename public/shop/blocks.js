/* ShopBlocks — self-contained web (browser) port of the mini-app home block
 * renderer (miniapp/components/block-renderer). Pure string templating: every
 * <view> -> <div>, <text> -> <span>, <image> -> <img>. No external libs.
 *
 * Host contract (see shop.html):
 *   ShopBlocks.setContext({ lang, products, categories, flashSales, config })
 *   ShopBlocks.render(blocks)        -> HTML string for the whole layout array
 *   ShopBlocks.onRerender(fn)        -> called when lazy data / countdowns land
 *   ShopBlocks.onCta(fn)             -> (host delegates clicks on [data-cta-target])
 *   ShopBlocks.startTimers(rootEl)   -> tick countdown digits + refetch flash
 *   ShopBlocks.stopTimers()
 *
 * Clickable elements carry data-cta-target="<target>" (e.g. product:123,
 * category:Dry & Pantry, shop, cart, voting, wallet, about, coupons, …).
 * The host page delegates clicks; this module attaches NO listeners.
 */
(function (global) {
  'use strict';

  // ── Context + lazy caches ──────────────────────────────────────────────
  var ctx = {
    lang: 'en',
    products: [],
    categories: [],
    flashSales: [],
    config: null,
    productsById: {},   // built from products[]
  };
  var rerenderCbs = [];
  var ctaCbs = [];
  var caches = {
    top: {},      // `${channel}|${window}|${limit}` -> products[]
    newA: {},     // `${limit}` -> products[]
    catGrid: {},  // `${category_id||'all'}|${limit}` -> products[]
    topup: null,  // storefront top-up packages (public endpoint)
    lb: {},       // `${metric}|${period}|${topN}|${reveal}` -> leaderboard rows
  };
  var BASE = '';    // same-origin; absUrl prefixes only protocol-relative roots

  // ── Brand colour token map (mirror block-renderer COLOR_MAP) ────────────
  var COLOR_MAP = {
    'lime-leaf': '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
    'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
    'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
    'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
    'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
    'white': '#FFFFFF',
  };
  // CSS-var equivalents (host page defines --forest etc.). Used where a token
  // maps cleanly to a brand var; otherwise we fall through to the hex.
  var VAR_MAP = {
    'forest-kale': 'var(--forest)', 'lime-leaf': 'var(--lime)',
    'berry-punch': 'var(--berry)', 'carrot-blaze': 'var(--carrot)',
    'papaya-glow': 'var(--papaya)', 'oat-milk': 'var(--oat)', 'ink': 'var(--ink)',
    'olive-moss': 'var(--olive)', 'golden-corn': 'var(--corn)',
    'pink-guava': 'var(--pink)', 'skyberry': 'var(--sky)', 'lotus': 'var(--lotus)',
    'citrus-zest': 'var(--citrus)', 'pea-sprout': 'var(--pea)',
  };

  function color(name) {
    if (!name) return '';
    return COLOR_MAP[name] || name;     // pass-through raw #hex / rgb()
  }
  // brandColorVar(token): prefer the host CSS var, else the resolved hex.
  function brandColorVar(token) {
    if (!token) return '';
    return VAR_MAP[token] || COLOR_MAP[token] || token;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Inline-style values (already trusted tokens/numbers) — strip only quotes
  // that would break an attribute. Used for pre-built style strings.
  function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  function absUrl(u) {
    if (!u) return '';
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.charAt(0) === '/') return BASE + u;
    return u;
  }

  function pick(en, cn) {
    var a = (en || '').toString().trim(), b = (cn || '').toString().trim();
    if (ctx.lang === 'cn') return b || a;
    return a || b;
  }
  function CN() { return ctx.lang === 'cn'; }

  function stripRichText(s) {
    return String(s == null ? '' : s)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function btnText(bg) {
    var hex = (color(bg) || '').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (hex.length !== 6) return '#1a1a17';
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140 ? '#1a1a17' : '#FFFFFF';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  // Wrap pre-rendered review cards in a swipeable, autoplaying carousel with
  // indicator dots. Hydrated by initCarousels() after render.
  function rvCarousel(cards, extraClass) {
    var slides = cards.map(function (c) { return '<div class="sb-rv-slide">' + c + '</div>'; }).join('');
    var dots = cards.map(function (_, i) { return '<span class="sb-rv-dot' + (i === 0 ? ' on' : '') + '" data-rv-go="' + i + '"></span>'; }).join('');
    return '<div class="sb-rv-carousel ' + (extraClass || '') + '" data-rv-carousel>' +
      '<div class="sb-rv-track">' + slides + '</div></div>' +
      '<div class="sb-rv-dots">' + dots + '</div>';
  }
  function moneyEff(p) {
    var regular = Number(p.sell_price != null ? p.sell_price : p.price) || 0;
    var eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
    return { regular: regular, eff: eff, isFlash: !!p.is_on_flash && eff < regular };
  }
  function prodImg(p) { return absUrl(p.image_url) || p.image_data || ''; }
  function findProductById(id) {
    return ctx.productsById[id] ||
      (ctx.products || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  // Full-bg blocks fill the frame edge-to-edge (mirror FULL_BG_TYPES).
  var FULL_BG_TYPES = {
    notification_bar: 1, flash_sale_strip: 1, coupon_block: 1, review_card: 1,
    voting_block: 1, greeting: 1, recipe_story: 1, bundle: 1, wecom_contact: 1,
    order_tracker: 1, announcement_bar: 1, points_widget: 1, top_up: 1,
    favorites_block: 1, affiliate_block: 1, store_info: 1, countdown_timer: 1,
    leaderboard: 1,
  };

  // ── Per-type renderers ──────────────────────────────────────────────────
  var renderers = {};

  // hero_banner -------------------------------------------------------------
  renderers.hero_banner = function (b) {
    var heroView = b.view || 'full';
    var imageUrl = absUrl(b.image_url);
    var heroVideo = absUrl(b.video_url);
    var aspectRatio = (b.image_aspect && b.image_url) ? String(b.image_aspect) : '';
    var heroFit = b.image_fit || (b.image_aspect ? 'contain' : 'cover');
    var fillAspect = (650 / (b.height_px || 280)).toFixed(4);
    var heroScrim = b.scrim || 'medium';
    var heroEnter = b.entrance_anim || 'none';
    var heroBtnBg = color(b.btn_color || '');
    var rawCtas = Array.isArray(b.ctas) ? b.ctas
      : (b.cta_label ? [{ label_en: b.cta_label, label_cn: '', target: b.cta_target, style: 'primary' }] : []);
    var ctas = rawCtas.map(function (c) {
      var style = c.style || 'primary';
      var override = style === 'primary' && heroBtnBg;
      return {
        label: pick(c.label_en != null ? c.label_en : c.label, c.label_cn),
        target: c.target || '',
        style: style,
        btnBg: override ? heroBtnBg : '',
        btnFg: override ? btnText(heroBtnBg) : '',
      };
    });
    var objFit = heroFit === 'contain' ? 'contain' : heroFit === 'stretch' ? 'fill' : 'cover';

    function media() {
      if (heroVideo) {
        return '<video class="sb-hero-video" src="' + attr(heroVideo) + '" poster="' + attr(imageUrl) +
          '" autoplay loop muted playsinline style="object-fit:' + objFit + '"></video>';
      }
      if (imageUrl) {
        var img = '<img class="sb-hero-img" src="' + attr(imageUrl) + '" style="object-fit:' + objFit + '" alt="">';
        // Optional wide-screen art: the phone image is authored for a 750rpx
        // canvas and looks soft blown up to a full-bleed desktop banner. When
        // the CMS provides a desktop variant, browsers ≥768px use it instead.
        var desk = absUrl(b.image_desktop_url);
        if (desk) {
          return '<picture><source media="(min-width: 768px)" srcset="' + attr(desk) + '">' + img + '</picture>';
        }
        return img;
      }
      return '<div class="sb-hero-placeholder">No image</div>';
    }
    function ctaStack(cls) {
      if (!ctas.length) return '';
      return '<div class="sb-cta-stack' + (cls ? ' ' + cls : '') + '">' + ctas.map(function (c) {
        var st = c.btnBg ? ('background:' + attr(c.btnBg) + ';color:' + attr(c.btnFg)) : '';
        return ctaWrap(c.target, '<button class="sb-cta-btn sb-cta-' + c.style + '" style="' + st + '">' +
          escapeHtml(c.label) + '</button>');
      }).join('') + '</div>';
    }

    if (heroView === 'split') {
      var headline = pick(b.headline_en, b.headline_cn);
      var subtitle = pick(b.subtitle_en, b.subtitle_cn);
      var panelBg = color(b.panel_bg_color || 'oat-milk');
      var panelFg = color(b.panel_fg_color || 'ink');
      return '<div class="sb-hero sb-hero-split">' +
        '<div class="sb-split-img">' + media() + '</div>' +
        '<div class="sb-split-panel" style="background:' + attr(panelBg) + ';color:' + attr(panelFg) + '">' +
        (headline ? '<div class="sb-headline">' + escapeHtml(headline) + '</div>' : '') +
        (subtitle ? '<div class="sb-subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
        ctaStack('') +
        '</div></div>';
    }
    // full view
    var boxStyle;
    if (heroFit === 'contain') {
      boxStyle = aspectRatio ? ('aspect-ratio:' + aspectRatio + ';height:auto')
        : ('height:calc(' + (b.height_px || 280) * 2 + ' * var(--u))');
    } else {
      boxStyle = 'aspect-ratio:' + fillAspect + ';height:auto';
    }
    var scrim = (heroVideo || imageUrl) && ctas.length && heroScrim !== 'none'
      ? '<div class="sb-hero-scrim"></div>' : '';
    return '<div class="sb-hero sb-hero-full sb-hero-fit-' + objFit + ' sb-scrim-' + heroScrim + ' sb-enter-' + heroEnter +
      '" style="' + boxStyle + '">' + media() + scrim + ctaStack('') + '</div>';
  };

  // greeting ----------------------------------------------------------------
  renderers.greeting = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var c = (ctx.config && ctx.config.customer) || {};
    var nick = (c.nickname || '').trim();
    var firstName = nick ? nick.split(/[ ·,]+/)[0] : '';
    var hr = new Date().getHours();
    var tone = hr < 5 ? 'night' : hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : hr < 22 ? 'evening' : 'night';
    var greetMap = {
      en: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hi night-owl' },
      cn: { morning: '早上好', afternoon: '下午好', evening: '晚上好', night: '夜深了' },
    };
    var overrideEn = b['greet_' + tone + '_en'] || b.greet_en;
    var overrideCn = b['greet_' + tone + '_cn'] || b.greet_cn;
    var greetingText = pick(overrideEn, overrideCn) || greetMap[CN() ? 'cn' : 'en'][tone];
    var todMap = { morning: '🌅', afternoon: '☀️', evening: '🌙', night: '🌟' };
    var todPrefix = (b.show_tod_emoji === 'on') ? (todMap[tone] + ' ') : '';
    var greeting = todPrefix + greetingText;
    var headline = firstName ? (greeting + ', ' + firstName + '.') : (greeting + '.');
    var pts = Number(c.points_balance) || 0;
    var showPts = b.show_points !== false && pts > 0;
    var ptVal = Number(c.point_value_yuan) > 0 ? Number(c.point_value_yuan) : 0.01;
    var ptsValue = (pts * ptVal).toFixed(2);
    var view = b.view || 'card';
    var accent = color(b.accent_color || 'lime-leaf');
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    var ctaTarget = b.cta_target || '';
    var pointsLabel = showPts ? (CN() ? (pts + ' 积分 · 抵 ¥' + ptsValue) : (pts + ' pts · ¥' + ptsValue)) : '';
    var pointsCnyLabel = showPts ? (CN() ? ('积分 · 抵 ¥' + ptsValue) : ('pts · ¥' + ptsValue)) : '';

    var isDesign = view === 'classic' || view === 'wallet' || view === 'coin';
    if (isDesign) {
      var MOODS = {
        forest: { accent: '#CCD900', kicker: '#A7AE5E', badge: '#F2CA6C' },
        dusk: { accent: '#F2CA6C', kicker: '#B79A5E', badge: '#FFAF60' },
        berry: { accent: '#F4B8CB', kicker: '#C892A4', badge: '#E96174' },
      };
      var EN = ({
        refined: { head: 0.9, border: 1.5, radius: 12, coin: 3, halftone: 0.06 },
        balanced: { head: 1.0, border: 2, radius: 16, coin: 4, halftone: 0.12 },
        playful: { head: 1.14, border: 2.5, radius: 20, coin: 7, halftone: 0.20 },
      })[b.energy] || { head: 1.0, border: 2, radius: 16, coin: 4, halftone: 0.12 };
      var mp = MOODS[b.mood] || MOODS.forest;
      var band = color(b.band_color) || '#F2E7DF';
      var ink = color(b.ink_color) || (btnText(band) === '#1a1a17' ? '#1a1a17' : '#F2E7DF');
      var accentC = color(b.accent_color) || mp.accent;
      var kickerC = color(b.kicker_color) || mp.kicker;
      var ptsUnit = CN() ? '积分' : 'pts';
      var ptsUnitCny = showPts ? (ptsUnit + ' · ¥' + ptsValue) : '';
      var walletValue = '¥' + (Number(c.balance) || 0).toFixed(2);
      var corner = b.corner_radius || 'sharp';
      var bandStyle = 'background:' + band + ';color:' + ink + ';--gr-accent:' + accentC +
        ';--gr-kicker:' + kickerC + ';--gr-ink:' + ink + ';--gr-head:' + EN.head +
        ';--gr-border:' + EN.border + 'px;--gr-radius:' + EN.radius + 'px;--gr-halftone:' + EN.halftone + ';';
      var todIcon = (tone === 'evening' || tone === 'night') ? 'moon' : 'sun';

      var inner;
      if (view === 'wallet') {
        inner =
          (kicker ? '<div class="sb-grd-top"><span class="sb-grd-icon sb-grd-icon-' + todIcon + '"></span><span class="sb-grd-kicker">' + escapeHtml(kicker) + '</span></div>' : '') +
          '<div class="sb-grd-head">' + escapeHtml(greeting) + (firstName ? (', ' + escapeHtml(firstName)) : '') + '.</div>' +
          (showPts ?
            '<div class="sb-grd-bar">' +
            '<div class="sb-grd-seg"><div class="sb-grd-seg-lbl">' + (CN() ? '钱包' : 'WALLET') + '</div><div class="sb-grd-seg-val">' + walletValue + '</div></div>' +
            '<div class="sb-grd-bar-div"></div>' +
            '<div class="sb-grd-seg"><div class="sb-grd-seg-lbl">' + ptsUnit + '</div><div class="sb-grd-seg-pts"><span class="sb-grd-seg-num">' + pts + '</span><span class="sb-grd-seg-unit"> ' + escapeHtml(ptsUnitCny) + '</span></div></div>' +
            '<div class="sb-grd-bar-arrow">→</div>' +
            '</div>' : '');
      } else if (view === 'classic') {
        inner = '<div class="sb-grd-row">' +
          '<div class="sb-grd-col">' +
          (kicker ? '<div class="sb-grd-kicker">' + escapeHtml(kicker) + '</div>' : '') +
          '<div class="sb-grd-head">' + escapeHtml(greeting) + (firstName ? ',' : '.') +
          (firstName ? '<span class="sb-grd-name-br"> ' + escapeHtml(firstName) + '.</span>' : '') + '</div>' +
          (ctaLabel ? '<div class="sb-grd-link"><span class="sb-grd-link-lbl">' + escapeHtml(ctaLabel) + '</span><span class="sb-grd-link-ar"> →</span></div>' : '') +
          '</div>' +
          (showPts ? '<div class="sb-grd-pts-card"><div class="sb-grd-pts-num">' + pts + '</div><div class="sb-grd-pts-unit">' + escapeHtml(ptsUnitCny) + '</div></div>' : '') +
          '</div>';
      } else { // coin
        inner = '<div class="sb-grd-row sb-grd-coin-row">' +
          '<div class="sb-grd-halftone"></div>' +
          '<div class="sb-grd-col">' +
          (kicker ? '<div class="sb-grd-top sb-grd-top-accent"><span class="sb-grd-icon sb-grd-icon-' + todIcon + '"></span><span class="sb-grd-kicker">' + escapeHtml(kicker) + '</span></div>' : '') +
          '<div class="sb-grd-head">' + escapeHtml(greeting) + (firstName ? ',' : '.') +
          (firstName ? '<span class="sb-grd-name"> ' + escapeHtml(firstName) + '.</span>' : '') + '</div>' +
          (ctaLabel ? '<div class="sb-grd-pill"><span>' + escapeHtml(ctaLabel) + ' →</span></div>' : '') +
          '</div>' +
          (showPts ? '<div class="sb-grd-coin-wrap"><div class="sb-grd-coin"><span class="sb-grd-coin-num">' + pts + '</span><span class="sb-grd-coin-star">★</span></div><div class="sb-grd-coin-unit">' + escapeHtml(ptsUnitCny) + '</div></div>' : '') +
          '</div>';
      }
      return ctaWrap(ctaTarget, '<div class="sb-greet sb-greet-' + view + ' sb-corner-' + corner + '" style="' + attr(bandStyle) + '">' + inner + '</div>');
    }

    // simple views (card default / banner / inline / split)
    var body;
    if (view === 'inline') {
      body = '<div class="sb-gr-inline-row"><div class="sb-gr-inline-copy">' +
        (kicker ? '<div class="sb-gr-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        '<div class="sb-gr-headline sb-gr-headline-sm">' + escapeHtml(headline) + '</div></div>' +
        (pointsLabel ? '<div class="sb-gr-pts-pill" style="color:' + attr(accent) + ';border-color:' + attr(accent) + '">★ ' + escapeHtml(pointsLabel) + '</div>' : '') + '</div>';
    } else if (view === 'split') {
      var pointsNum = showPts ? String(pts) : '';
      body = '<div class="sb-gr-split-row"><div class="sb-gr-split-left">' +
        (kicker ? '<div class="sb-gr-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        '<div class="sb-gr-headline">' + escapeHtml(headline) + '</div>' +
        (ctaLabel ? '<div class="sb-gr-cta">' + escapeHtml(ctaLabel) + ' →</div>' : '') + '</div>' +
        (pointsNum ? '<div class="sb-gr-split-wallet" style="color:' + attr(accent) + ';border-color:' + attr(accent) + '"><div class="sb-gr-wallet-num">' + pointsNum + '</div><div class="sb-gr-wallet-lbl">' + escapeHtml(pointsCnyLabel) + '</div></div>' : '') + '</div>';
    } else {
      var lg = view === 'banner' ? ' sb-gr-headline-lg' : '';
      body = (kicker ? '<div class="sb-gr-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        '<div class="sb-gr-headline' + lg + '">' + escapeHtml(headline) + '</div>' +
        (pointsLabel ? '<div class="sb-gr-points" style="color:' + attr(accent) + '">★ ' + escapeHtml(pointsLabel) + '</div>' : '') +
        (ctaLabel ? '<div class="sb-gr-cta">' + escapeHtml(ctaLabel) + ' →</div>' : '');
    }
    return ctaWrap(ctaTarget, '<div class="sb-greet sb-greet-' + view + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + body + '</div>');
  };

  // notification_bar --------------------------------------------------------
  renderers.notification_bar = function (b) {
    // Web has no live unread feed; surface config.notifUnread if provided.
    var cfg = ctx.config || {};
    var showOrder = b.show_order_status !== false;
    var cnt = showOrder ? (cfg.notifUnread || 0) : (cfg.notifNoOrderUnread || 0);
    if (!(cnt > 0)) return '';   // collapse when nothing unread (matches app)
    var view = b.view || 'bar';
    var bg = color(b.bg_color || 'ink'), fg = color(b.fg_color || 'white');
    var btnBg = b.btn_color ? color(b.btn_color) : '';
    var btnFg = b.btn_color ? btnText(b.btn_color) : '';
    var hasBroadcast = !!cfg.notifHasBroadcast;
    var text = cnt === 1
      ? (CN() ? '1 条新消息 · 点击查看' : '1 new update · Tap to view')
      : (CN() ? (cnt + ' 条新消息 · 点击查看') : (cnt + ' new updates · Tap to view'));
    var btnStyle = btnBg ? ('background:' + attr(btnBg) + ';color:' + attr(btnFg)) : '';
    return ctaWrap('notifications',
      '<div class="sb-nbar sb-nbar-' + view + '">' +
      '<div class="sb-nbar-row" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      '<span class="sb-nbar-icon">' + (hasBroadcast ? '📣' : '🔔') + '</span>' +
      '<span class="sb-nbar-text">' + escapeHtml(text) + '</span>' +
      '<span class="sb-nbar-btn" style="' + btnStyle + '">→</span>' +
      '</div></div>');
  };

  // spacer ------------------------------------------------------------------
  renderers.spacer = function (b) {
    var h = b.height_px || 24;
    var ds = b.divider_style || 'none';
    var dc = color(b.divider_color || 'olive-moss');
    var divider = ds !== 'none'
      ? '<div class="sb-spacer-divider" style="border-color:' + attr(dc) + ';background:' + (ds === 'line' ? attr(dc) : 'transparent') + '"></div>'
      : '';
    return '<div class="sb-spacer sb-divider-' + ds + '" style="height:calc(' + (h * 2) + ' * var(--u))">' + divider + '</div>';
  };

  // order_tracker -----------------------------------------------------------
  renderers.order_tracker = function (b) {
    var o = (ctx.config && ctx.config.activeOrder) || null;
    if (!o || !o.id) return '';
    var cn = CN();
    var style = ['classic', 'truck', 'banner'].indexOf(b.track_style) !== -1 ? b.track_style : 'classic';
    var E = ({ refined: { h: 0.92, bw: 3, rad: 24 }, balanced: { h: 1, bw: 4, rad: 32 }, bold: { h: 1.12, bw: 5, rad: 40 } })[b.energy] || { h: 1, bw: 4, rad: 32 };
    var corner = b.corner_radius || 'subtle';
    var STATUS = cn
      ? { pending_payment: '待支付', paid: '已支付', preparing: '准备中', dispatched: '配送中' }
      : { pending_payment: 'Awaiting payment', paid: 'Paid', preparing: 'Preparing', dispatched: 'On the way' };
    var HEAD = cn
      ? { pending_payment: '待支付', paid: '已下单', preparing: '打包中', dispatched: '配送中' }
      : { pending_payment: 'Awaiting payment', paid: 'Order placed.', preparing: 'Packing up.', dispatched: 'On the way.' };
    var STEP = { pending_payment: 0, paid: 1, preparing: 2, dispatched: 3 };
    var filled = STEP[o.status] != null ? STEP[o.status] : 0;
    var active = Math.max(0, filled - 1);
    var POS = ['0%', '33.3%', '66.6%', '100%'];
    var pct = POS[active];
    var TRACK = [
      { en: 'Paid', cn: '已支付', candy: b.stage_paid_color ? color(b.stage_paid_color) : '#F2CA6C' },
      { en: 'Prep', cn: '准备中', candy: b.stage_prep_color ? color(b.stage_prep_color) : '#CCD900' },
      { en: 'On way', cn: '配送中', candy: b.stage_onway_color ? color(b.stage_onway_color) : '#F4B8CB' },
      { en: 'Delivered', cn: '已送达', candy: b.stage_done_color ? color(b.stage_done_color) : '#E96174' },
    ];
    var preview = Array.isArray(o.items_preview) ? o.items_preview : [];
    var thumbs = (preview.length ? preview.slice(0, 3) : [{}]).map(function (p) { return absUrl(p.image_url) || ''; });
    var count = o.item_count || preview.length || 0;
    // Twin of block-renderer.js — prefer the server's derived slot (its leading
    // "Today"/"Tomorrow" is re-computed against the Guangzhou calendar on every
    // fetch), then the stored snapshot, then the scheduled date. Keep the two
    // files behaviourally identical.
    var eta = o.delivery_slot_display || o.delivery_slot_label || '';
    if (!eta && o.scheduled_for) eta = String(o.scheduled_for).slice(0, 16).replace('T', ' ');
    var accent = color(b.accent_color || 'forest-kale');
    var cardBg = b.card_bg_color ? color(b.card_bg_color) : '#fff';
    var cardBorder = b.card_border_color === '' ? 'none'
      : ('calc(3 * var(--u)) solid ' + (b.card_border_color ? color(b.card_border_color) : '#1a1a17'));
    var marker = b.marker_color ? color(b.marker_color) : '#F4B8CB';
    var bright = b.bright_color ? color(b.bright_color) : '#CCD900';
    var rail = b.rail_color ? color(b.rail_color) : '#D3D1C7';
    var ctaTextColor = b.cta_text_color ? color(b.cta_text_color) : '';
    var statusLabel = STATUS[o.status] || o.status;
    var title = pick(b.title_en, b.title_cn) || (cn ? '你的订单' : 'Your order');
    var bighead = style === 'banner' ? (eta || HEAD[o.status] || statusLabel) : (HEAD[o.status] || statusLabel);
    var kicker = style === 'banner' ? statusLabel : (cn ? '我的订单' : 'YOUR ORDER');
    var ctaLabel = o.status === 'pending_payment' ? (cn ? '去支付' : 'Pay now') : (cn ? '查看订单' : 'View order');
    var ctaArrow = ctaLabel + ' →';
    var countLabel = count > 0 ? (cn ? (count + ' 件商品') : (count + ' item' + (count === 1 ? '' : 's'))) : '';
    var total = Number(o.total) > 0 ? ('¥' + Number(o.total).toFixed(2)) : '';
    var markerIcon = '●';

    var vars = '--ot-accent:' + accent + ';--ot-card-bg:' + cardBg + ';--ot-card-border:' + cardBorder +
      ';--ot-marker:' + marker + ';--ot-bright:' + bright + ';--ot-rail:' + rail +
      ';--ot-bw:calc(' + E.bw + ' * var(--u));--ot-radius:calc(' + E.rad + ' * var(--u));--ot-h:' + E.h + ';' +
      (ctaTextColor ? ('--ot-cta-text:' + ctaTextColor + ';') : '');

    function thumbsHtml() {
      return '<div class="sb-ot-thumbs">' + thumbs.map(function (t) {
        return '<div class="sb-ot-th">' + (t ? '<img class="sb-ot-th-img" src="' + attr(t) + '" alt="">' : '') + '</div>';
      }).join('') + '</div>';
    }

    var card;
    if (style === 'banner') {
      var segs = TRACK.map(function (s, i) {
        var on = i < filled, done = i < filled - 1, current = i === filled - 1;
        return '<div class="sb-ot-seg' + (on ? ' on' : '') + (done ? ' done' : '') + (current ? ' current' : '') + '">' +
          '<div class="sb-ot-seg-bar"></div>' +
          '<div class="sb-ot-seg-lbl"><span>' + escapeHtml(cn ? s.cn : s.en) + '</span></div></div>';
      }).join('');
      card = '<div class="sb-ot-banner sb-corner-' + corner + '">' +
        '<div class="sb-ot-bn-head">' +
        '<div class="sb-ot-bn-marker"><span class="sb-ot-mk-ic">' + markerIcon + '</span></div>' +
        '<div class="sb-ot-bn-headtext"><div class="sb-ot-bn-kicker">' + escapeHtml(kicker) + '</div><div class="sb-ot-bn-eta">' + escapeHtml(bighead) + '</div></div>' +
        '</div>' +
        '<div class="sb-ot-bn-body">' +
        '<div class="sb-ot-bn-row">' + thumbsHtml() +
        '<div class="sb-ot-info">' + (countLabel ? '<div class="sb-ot-count">' + escapeHtml(countLabel) + '</div>' : '') +
        (o.order_no ? '<div class="sb-ot-eta">' + escapeHtml(o.order_no) + '</div>' : '') + '</div></div>' +
        '<div class="sb-ot-segs">' + segs + '</div>' +
        '<div class="sb-ot-bn-cta">' + escapeHtml(ctaArrow) + '</div>' +
        '</div></div>';
    } else if (style === 'truck') {
      var dots = POS.map(function (left, i) {
        if (i === active) return '';
        return '<div class="sb-ot-rail-dot" style="left:' + left + ';background:' + (i < filled ? bright : rail) + '"></div>';
      }).join('');
      var tkLabels = TRACK.map(function (s, i) {
        var align = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
        return '<div class="sb-ot-tl' + (i < filled ? ' on' : '') + (i === filled - 1 ? ' current' : '') + '" style="text-align:' + align + '"><div class="sb-ot-tl-en">' + escapeHtml(cn ? s.cn : s.en) + '</div></div>';
      }).join('');
      card = '<div class="sb-ot-card sb-ot-truck sb-corner-' + corner + '">' +
        '<div class="sb-ot-tk-top"><div class="sb-ot-tk-headtext">' +
        '<div class="sb-ot-kicker">' + escapeHtml(kicker) + '</div>' +
        '<div class="sb-ot-bighead">' + escapeHtml(bighead) + '</div>' +
        '<div class="sb-ot-tk-sub">' + escapeHtml(countLabel) + (eta ? (' · <span class="sb-b">' + escapeHtml(eta) + '</span>') : '') + '</div>' +
        '</div>' + thumbsHtml() + '</div>' +
        '<div class="sb-ot-rail"><div class="sb-ot-rail-base"></div><div class="sb-ot-rail-fill" style="width:' + pct + '"></div>' + dots +
        '<div class="sb-ot-truck-marker" style="left:' + pct + '"><span class="sb-ot-mk-ic">🚚</span></div></div>' +
        '<div class="sb-ot-tk-labels">' + tkLabels + '</div>' +
        '<div class="sb-ot-tk-cta">' + escapeHtml(ctaArrow) + '</div></div>';
    } else { // classic
      var steps = TRACK.map(function (s, i) {
        var isFilled = i < filled, isCurrent = i === filled - 1;
        return '<div class="sb-ot-node' + (isFilled ? ' filled' : ' upcoming') + (isCurrent ? ' current' : '') + '" style="--ot-candy:' + s.candy + '">' +
          (i > 0 ? '<div class="sb-ot-bar' + (isFilled ? ' on' : '') + '"></div>' : '') +
          '<div class="sb-ot-circle" style="' + (isFilled ? 'background:' + s.candy : '') + '"><span class="sb-ot-dot"></span></div>' +
          '<div class="sb-ot-node-label">' + escapeHtml(cn ? s.cn : s.en) + '</div></div>';
      }).join('');
      card = '<div class="sb-ot-card sb-corner-' + corner + '">' +
        '<div class="sb-ot-head"><div class="sb-ot-title">' + escapeHtml(title) + '</div>' +
        '<div class="sb-ot-status' + (o.status === 'pending_payment' ? ' unpaid' : '') + '">' + escapeHtml(statusLabel) + '</div></div>' +
        '<div class="sb-ot-body">' + thumbsHtml() +
        '<div class="sb-ot-info"><div class="sb-ot-no">' + escapeHtml(o.order_no || '') + '</div>' +
        (countLabel ? '<div class="sb-ot-sub">' + escapeHtml(countLabel) + (total ? (' · ' + total) : '') + '</div>' : '') +
        (eta ? '<div class="sb-ot-sub">' + escapeHtml(eta) + '</div>' : '') + '</div>' +
        '<div class="sb-ot-cta">' + escapeHtml(ctaLabel) + '</div></div>' +
        (o.status !== 'pending_payment' ? '<div class="sb-ot-track">' + steps + '</div>' : '') +
        '</div>';
    }
    var ctaTarget = o.status === 'pending_payment' ? ('order:' + o.id) : ('order:' + o.id);
    return ctaWrap(ctaTarget, '<div class="sb-ot-wrap" style="' + attr(vars) + '">' + card + '</div>');
  };

  // category_tabs -----------------------------------------------------------
  renderers.category_tabs = function (b) {
    var kicker = pick(b.kicker_en != null ? b.kicker_en : b.kicker, b.kicker_cn);
    var title = pick(b.title_en != null ? b.title_en : b.title, b.title_cn);
    var seeAll = CN() ? '查看全部' : 'SEE ALL';
    var seeAllTarget = b.link_target || 'shop';
    var catWord = CN() ? '分类' : 'CATEGORY';
    var catView = b.view || 'tiles';
    var catStyle = ['index', 'bento', 'sticker'].indexOf(b.cat_style) !== -1 ? b.cat_style : 'classic';
    var bentoBadge = b.bento_badge !== 0;
    var catCols = Math.max(3, Math.min(5, b.columns || 4));
    var catBg = color(b.bg_color || '');
    var corner = b.corner_radius || 'sharp';
    var vars = '--cat-text:' + color(b.fg_color || 'ink') + ';--cat-accent:' + color(b.accent_color || 'olive-moss') +
      ';--cat-keyline:' + color(b.keyline_color || 'ink') + ';--cat-shadow:' + color(b.shadow_color || 'ink') +
      ';--cat-surface:' + color(b.tile_surface_color || 'oat-milk');

    var cats = (b.category_ids || []).map(function (id) {
      return (ctx.categories || []).filter(function (c) { return c.id === id; })[0];
    }).filter(Boolean);
    var palette = ['papaya-glow', 'pea-sprout', 'berry-punch', 'golden-corn', 'skyberry', 'lotus'];
    var tileColors = b.tile_colors || {};
    var tileImages = b.tile_images || {};
    var all = ctx.products || [];
    function inCat(p, c) { return p.top_category === c.name; }
    function catCount(c) { return (typeof c.count === 'number') ? c.count : all.filter(function (p) { return inCat(p, c); }).length; }
    function catCover(c) {
      if (tileImages[c.id]) return absUrl(tileImages[c.id]);
      if (c.cover) return absUrl(c.cover);
      var p = all.filter(function (x) { return inCat(x, c) && (absUrl(x.image_url) || x.image_data); })[0];
      return p ? (absUrl(p.image_url) || p.image_data) : '';
    }
    var tiles = cats.map(function (c, i) {
      var splitName = (CN() && c.name_cn) ? c.name_cn : c.name;
      var letter = (splitName.trim()[0] || '').toUpperCase();
      var override = tileColors[c.id];
      var token = override || palette[i % 6];
      var catColor = color(token);
      var catText = override ? btnText(token) : (i % 6 === 1 || i % 6 === 2 ? '#fff' : '#1a1a17');
      return {
        id: c.id, num: '0' + (i + 1), name: splitName, letter: letter,
        count: catCount(c), cover: catCover(c), bg: catColor, fg: catText,
      };
    });

    var head = '<div class="sb-cat-head"><div>' +
      '<div class="sb-kicker">' + escapeHtml(kicker) + '</div>' +
      '<div class="sb-ttl">' + escapeHtml(title) + '</div></div>' +
      ctaWrap(seeAllTarget, '<div class="sb-more">' + escapeHtml(seeAll) + '</div>') + '</div>';

    var body;
    if (!tiles.length) {
      body = '<div class="sb-empty">No categories yet.</div>';
    } else if (catStyle === 'index') {
      body = '<div class="sb-idx-list">' + tiles.map(function (t) {
        return ctaWrap('category:' + t.id, '<div class="sb-idx-row">' +
          '<div class="sb-idx-num">' + t.num + '</div>' +
          '<div class="sb-idx-dot" style="background:' + attr(t.bg) + '"></div>' +
          '<div class="sb-idx-name"><div class="sb-en">' + escapeHtml(t.name) + '</div></div>' +
          '<div class="sb-idx-count" style="background:' + attr(t.bg) + ';color:' + attr(t.fg) + '">' + t.count + '</div>' +
          '<div class="sb-idx-chev">›</div></div>');
      }).join('') + '</div>';
    } else if (catStyle === 'bento') {
      body = '<div class="sb-bento-grid">' + tiles.map(function (t, i) {
        var st = t.cover ? '' : ('background:' + attr(t.bg) + ';color:' + attr(t.fg));
        return ctaWrap('category:' + t.id, '<div class="sb-bento-tile' + (i === 0 ? ' sb-hero' : '') + '" style="' + st + '">' +
          (t.cover ? '<img class="sb-bento-img" src="' + attr(t.cover) + '" alt="">' : '') +
          (bentoBadge ? '<div class="sb-bento-badge" style="background:' + attr(t.bg) + ';color:' + attr(t.fg) + '">' + t.num + ' · ' + t.count + '</div>' : '') +
          '<div class="sb-bento-cap' + (t.cover ? ' on-img' : '') + '"><div class="sb-en">' + escapeHtml(t.name) + '</div></div></div>');
      }).join('') + '</div>';
    } else if (catStyle === 'sticker') {
      body = '<div class="sb-chip-wrap">' + tiles.map(function (t) {
        return ctaWrap('category:' + t.id, '<div class="sb-chip-pill" style="background:' + attr(t.bg) + ';color:' + attr(t.fg) + '">' +
          '<span class="sb-en">' + escapeHtml(t.name) + '</span><span class="sb-chip-count">' + t.count + '</span></div>');
      }).join('') + '</div>';
    } else if (catView === 'icons' || catView === 'scroll') {
      body = '<div class="sb-icons-grid sb-icons-cols-' + catCols + (catView === 'scroll' ? ' sb-scroll-rail' : '') + '">' + tiles.map(function (t) {
        return ctaWrap('category:' + t.id, '<div class="sb-icon-tile">' +
          '<div class="sb-icon-circle" style="background:' + attr(t.bg) + ';color:' + attr(t.fg) + '">' + escapeHtml(t.letter) + '</div>' +
          '<div class="sb-icon-name">' + escapeHtml(t.name) + '</div></div>');
      }).join('') + '</div>';
    } else { // classic tiles
      body = '<div class="sb-cat-grid">' + tiles.map(function (t) {
        return ctaWrap('category:' + t.id, '<div class="sb-tile" style="background:' + attr(t.bg) + ';color:' + attr(t.fg) + '">' +
          '<div class="sb-num">' + t.num + ' · ' + escapeHtml(catWord) + '</div>' +
          '<div class="sb-name">' + escapeHtml(t.name) + '</div></div>');
      }).join('') + '</div>';
    }

    // PC-native body (tablet/desktop): a canonical image bento built from the
    // same tiles, regardless of the phone style chosen. Covers are auto-derived
    // (catCover -> explicit image / category cover / first product photo); falls
    // back to the brand colour when no image exists. Phone body stays untouched;
    // CSS shows .sb-cat-phone <768 and .sb-cat-pc >=768.
    var pcBody = '';
    if (tiles.length) {
      pcBody = '<div class="sb-cat-pc"><div class="sb-pcbento">' + tiles.map(function (t, i) {
        var st = t.cover ? '' : ('background:' + attr(t.bg) + ';color:' + attr(t.fg));
        return ctaWrap('category:' + t.id, '<div class="sb-pcb-tile' + (i === 0 ? ' feat' : '') + (t.cover ? ' has-img' : '') + '" style="' + st + '">' +
          (t.cover ? '<img class="sb-pcb-img" src="' + attr(t.cover) + '" alt="" loading="lazy">' : '') +
          '<div class="sb-pcb-cap"><div class="sb-pcb-ct">' + t.count + ' ' + escapeHtml(catWord) + '</div>' +
          '<div class="sb-pcb-en">' + escapeHtml(t.name) + '</div></div></div>');
      }).join('') + '</div></div>';
    }

    return '<div class="sb-cattabs sb-cattabs-' + catView + ' sb-cat-' + catStyle + ' sb-corner-' + corner +
      '" style="' + (catBg ? 'background:' + attr(catBg) + ';' : '') + attr(vars) + '">' +
      head + '<div class="sb-cat-phone">' + body + '</div>' + pcBody + '</div>';
  };

  // product_grid ------------------------------------------------------------
  renderers.product_grid = function (b) {
    var kicker = pick(b.kicker_en != null ? b.kicker_en : b.kicker, b.kicker_cn);
    var title = pick(b.title_en != null ? b.title_en : b.title, b.title_cn);
    var seeAll = CN() ? '查看全部' : 'SEE ALL';
    var seeAllTarget = b.category_id ? ('category:' + b.category_id) : 'shop';
    var cols = b.columns || 2;
    var gridView = b.view || 'grid';
    var corner = b.corner_radius || 'subtle';
    var density = b.density || 'normal';
    var rankMode = b.rank_badge || 'top_3';
    var gridBg = b.bg_color ? color(b.bg_color) : '';
    var gridSaleColor = b.accent_color ? color(b.accent_color) : '';
    var gridSaleFg = b.accent_color ? btnText(b.accent_color) : '';

    var list = [];
    if (b.source_type === 'manual') {
      list = (b.product_ids || []).map(findProductById).filter(Boolean);
    } else if (b.source_type === 'top_selling') {
      var key = (b.top_channel || 'combined') + '|' + (b.top_window || '7d') + '|' + (b.limit || 6);
      list = Array.isArray(caches.top[key]) ? caches.top[key] : [];
    } else if (b.source_type === 'new_arrivals') {
      var nk = String(b.limit || 6);
      list = Array.isArray(caches.newA[nk]) ? caches.newA[nk] : [];
    } else {
      var cgKey = (b.category_id || 'all') + '|' + (b.limit || 6);
      if (Array.isArray(caches.catGrid[cgKey])) {
        list = caches.catGrid[cgKey];
      } else {
        var cat = (ctx.categories || []).filter(function (c) { return c.id === b.category_id; })[0];
        list = (ctx.products || []).filter(function (p) { return !b.category_id || (cat && p.top_category === cat.name); });
      }
    }
    var isTopSelling = b.source_type === 'top_selling';
    var products = list.slice(0, b.limit || 6).map(function (p, idx) {
      var m = moneyEff(p);
      var tagline = pick(p.tagline_en, p.tagline_cn) || stripRichText(pick(p.description_en, p.description_cn)) || '';
      var rank = isTopSelling ? (idx + 1) : 0;
      if (rankMode === 'never') rank = 0;
      else if (rankMode === 'top_3' && rank > 3) rank = 0;
      var rankClass = !rank ? '' : rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-n';
      var rankLabel = !rank ? '' : ('NO. ' + (rank < 10 ? '0' + rank : rank));
      var units = Number(p.units_sold) || 0;
      var soldCaption = units > 0 ? (CN() ? ('已售 ' + units) : (units + ' SOLD')) : '';
      return {
        id: p.id, image: prodImg(p), name: pick(p.name_en, p.name_cn),
        tagline: tagline.length > 80 ? tagline.slice(0, 80) + '…' : tagline,
        price: m.eff > 0 ? '¥' + m.eff.toFixed(2) : '—',
        priceWas: m.isFlash ? '¥' + m.regular.toFixed(2) : '',
        isFlash: m.isFlash && !rank, rank: rank, rankLabel: rankLabel, rankClass: rankClass,
        soldCaption: soldCaption,
      };
    });

    function badge(it) {
      if (it.rank) return '<div class="sb-rank-badge ' + it.rankClass + '">' + escapeHtml(it.rankLabel) + '</div>';
      if (it.isFlash) return '<div class="sb-grid-flash-badge" style="' + (gridSaleColor ? 'background:' + attr(gridSaleColor) + ';color:' + attr(gridSaleFg) : '') + '">' + (CN() ? '秒杀' : 'FLASH') + '</div>';
      return '';
    }
    function priceRow(it) {
      return '<div class="sb-price-row">' +
        (it.priceWas ? '<span class="sb-price-was">' + escapeHtml(it.priceWas) + '</span>' : '') +
        '<span class="sb-price' + (it.priceWas ? ' is-flash' : '') + '" style="' + (it.priceWas && gridSaleColor ? 'color:' + attr(gridSaleColor) : '') + '">' + escapeHtml(it.price) + '</span></div>';
    }
    function sold(it) {
      return it.soldCaption ? '<div class="sb-sold-caption" style="' + (gridSaleColor ? 'color:' + attr(gridSaleColor) : '') + '">' + escapeHtml(it.soldCaption) + '</div>' : '';
    }

    var head = '<div class="sb-grid-head"><div><div class="sb-kicker">' + escapeHtml(kicker) + '</div>' +
      '<div class="sb-ttl">' + escapeHtml(title) + '</div></div>' +
      ctaWrap(seeAllTarget, '<div class="sb-more">' + escapeHtml(seeAll) + '</div>') + '</div>';

    if (!products.length) return '';   // public site: hide an empty/misconfigured grid (no editor placeholder)
    var inner;
    if (gridView === 'list') {
      inner = '<div class="sb-list-rows">' + products.map(function (it) {
        return ctaWrap('product:' + it.id, '<div class="sb-list-row' + (it.rank ? ' sb-rank-card-' + it.rank : '') + '">' +
          '<div class="sb-img">' + (it.image ? '<img class="sb-img-full" src="' + attr(it.image) + '" alt="">' : '') + badge(it) + '</div>' +
          '<div class="sb-meta"><div class="sb-name">' + escapeHtml(it.name) + '</div>' +
          (it.tagline ? '<div class="sb-tagline">' + escapeHtml(it.tagline) + '</div>' : '') +
          priceRow(it) + sold(it) + '</div></div>');
      }).join('') + '</div>';
    } else if (gridView === 'scroll') {
      inner = '<div class="sb-scroll-rail">' + products.map(function (it) {
        return ctaWrap('product:' + it.id, '<div class="sb-rail-card' + (it.rank ? ' sb-rank-card-' + it.rank : '') + '">' +
          '<div class="sb-img">' + (it.image ? '<img class="sb-img-full" src="' + attr(it.image) + '" alt="">' : '') + badge(it) + '</div>' +
          '<div class="sb-name">' + escapeHtml(it.name) + '</div>' + priceRow(it) + sold(it) + '</div>');
      }).join('') + '</div>';
    } else {
      // desktop hover affordance (cosmetic — the whole card already links to the
      // product, so this navigates there too; not a real add-to-cart yet).
      var qaddLbl = CN() ? '快速查看' : 'Quick view';
      inner = '<div class="sb-grid sb-cols-' + cols + '">' + products.map(function (it) {
        return ctaWrap('product:' + it.id, '<div class="sb-card' + (it.rank ? ' sb-rank-card-' + it.rank : '') + '">' +
          '<div class="sb-img">' + (it.image ? '<img class="sb-img-full" src="' + attr(it.image) + '" alt="">' : '') + badge(it) +
          '<div class="sb-qadd">' + escapeHtml(qaddLbl) + '</div></div>' +
          '<div class="sb-name">' + escapeHtml(it.name) + '</div>' + priceRow(it) + sold(it) + '</div>');
      }).join('') + '</div>';
    }

    var bgStyle = gridBg ? ('background:' + attr(gridBg) + ';padding-top:calc(32 * var(--u));padding-bottom:calc(32 * var(--u))') : '';
    return '<div class="sb-grid-block sb-grid-view-' + gridView + ' sb-corner-' + corner + ' sb-density-' + density +
      '" style="' + bgStyle + '">' + head + inner + '</div>';
  };

  // coupon_block ------------------------------------------------------------
  renderers.coupon_block = function (b) {
    var bg = color(b.bg_color || 'pink-guava'), fg = color(b.fg_color || 'ink');
    var style = ['ticket', 'stamp', 'strip'].indexOf(b.coupon_style) !== -1 ? b.coupon_style : 'ticket';
    var discount = pick(b.discount_label_en, b.discount_label_cn);
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var title = pick(b.title_en, b.title_cn);
    var subtitle = pick(b.subtitle_en, b.subtitle_cn);
    var code = b.code || '';
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    var ctaTarget = b.cta_target || 'coupons';
    var btnBg = color(b.btn_color || '');
    var btnFg = b.btn_color ? btnText(b.btn_color) : '';
    var codeLabel = CN() ? '复制' : 'COPY';

    var discHtml = discount ? '<div class="sb-cp-disc"><div class="sb-cp-big">' + escapeHtml(discount) + '</div></div>' : '';
    var codeHtml = (code && !ctaLabel)
      ? ctaWrap('copy:' + code, '<div class="sb-cp-code"><span class="sb-cp-code-label">CODE</span><span class="sb-cp-code-val">' + escapeHtml(code) + '</span><span class="sb-cp-code-copy">' + escapeHtml(codeLabel) + '</span></div>')
      : '';
    var body = '<div class="sb-cp-body">' +
      (kicker ? '<div class="sb-cp-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      (title ? '<div class="sb-cp-title">' + escapeHtml(title) + '</div>' : '') +
      (subtitle ? '<div class="sb-cp-sub">' + escapeHtml(subtitle) + '</div>' : '') +
      codeHtml + '</div>';
    var cta = ctaLabel
      ? ctaWrap(ctaTarget, '<div class="sb-cp-cta" style="background:' + attr(btnBg) + ';color:' + attr(btnFg) + '">' + escapeHtml(ctaLabel) + '</div>')
      : '';
    return '<div class="sb-coupon-blk sb-cp-st-' + style + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + discHtml + body + cta + '</div>';
  };

  // recipe_story ------------------------------------------------------------
  renderers.recipe_story = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var imageView = b.image_view || 'top';
    var corner = b.corner_radius || 'subtle';
    var linked = b.product_id ? findProductById(b.product_id) : null;
    var linkedCard = null;
    if (linked) {
      var m = moneyEff(linked);
      linkedCard = {
        id: linked.id, image: prodImg(linked), name: pick(linked.name_en, linked.name_cn),
        tagline: pick(linked.tagline_en, linked.tagline_cn) || '',
        price: m.eff > 0 ? '¥' + m.eff.toFixed(2) : '',
      };
    }
    var body = pick(b.body_en, b.body_cn) || '';
    var paragraphs = body.split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var imageUrl = absUrl(b.image_url);
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var headline = pick(b.headline_en, b.headline_cn);
    var byline = pick(b.byline_en, b.byline_cn);
    var readTime = b.read_time_minutes ? (b.read_time_minutes + ' ' + (CN() ? '分钟' : 'min')) : '';
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    var ctaTarget = b.cta_target || (linkedCard ? 'product:' + linkedCard.id : '');
    var btnBg = color(b.btn_color || ''), btnFg = b.btn_color ? btnText(b.btn_color) : '';

    var img = '<div class="sb-rcp-img">' + (imageUrl ? '<img class="sb-img-full" src="' + attr(imageUrl) + '" alt="">' : '<div class="sb-rcp-img-placeholder">No image</div>') + '</div>';
    var meta = (byline || readTime) ? '<div class="sb-rcp-meta">' +
      (byline ? '<span>' + escapeHtml(byline) + '</span>' : '') +
      (byline && readTime ? '<span> · </span>' : '') +
      (readTime ? '<span>' + escapeHtml(readTime) + '</span>' : '') + '</div>' : '';
    var paras = paragraphs.map(function (p) { return '<div class="sb-rcp-para">' + escapeHtml(p) + '</div>'; }).join('');
    var card = linkedCard
      ? ctaWrap('product:' + linkedCard.id, '<div class="sb-rcp-card">' +
        '<div class="sb-rcp-card-img">' + (linkedCard.image ? '<img class="sb-img-full" src="' + attr(linkedCard.image) + '" alt="">' : '') + '</div>' +
        '<div class="sb-rcp-card-meta"><div class="sb-rcp-card-name">' + escapeHtml(linkedCard.name) + '</div>' +
        (linkedCard.tagline ? '<div class="sb-rcp-card-tag">' + escapeHtml(linkedCard.tagline) + '</div>' : '') +
        (linkedCard.price ? '<div class="sb-rcp-card-price">' + escapeHtml(linkedCard.price) + ' →</div>' : '') + '</div></div>')
      : '';
    var cta = ctaLabel
      ? ctaWrap(ctaTarget, '<div class="sb-rcp-cta" style="background:' + attr(btnBg) + ';color:' + attr(btnFg) + '">' + escapeHtml(ctaLabel) + ' →</div>')
      : '';
    var bodyHtml = '<div class="sb-rcp-body">' +
      (kicker ? '<div class="sb-rcp-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      (headline ? '<div class="sb-rcp-headline">' + escapeHtml(headline) + '</div>' : '') +
      meta + paras + card + cta + '</div>';
    return '<div class="sb-recipe-blk sb-recipe-' + imageView + ' sb-corner-' + corner + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + img + bodyHtml + '</div>';
  };

  // bundle ------------------------------------------------------------------
  var BUNDLE_MOODS = {
    grocer: { surface: '#F3ECE0', cardFill: '#FFFCF7', cta: '#365329', save: '#E96174', sticker: '#CCD900', price: '#1a1a17' },
    harvest: { surface: '#F6EAD6', cardFill: '#FFFCF7', cta: '#8A5A2B', save: '#FF6B0C', sticker: '#F2CA6C', price: '#1a1a17' },
    berry: { surface: '#F5E6E6', cardFill: '#FFFCF7', cta: '#B23A52', save: '#E96174', sticker: '#F4B8CB', price: '#1a1a17' },
  };
  var BUNDLE_ENERGY = {
    refined: { headScale: 0.92, bw: 3, rad: 28 },
    balanced: { headScale: 1.0, bw: 4, rad: 40 },
    bold: { headScale: 1.1, bw: 6, rad: 52 },
  };
  function resolveBundleTheme(b) {
    var mood = BUNDLE_MOODS[b.mood] || BUNDLE_MOODS.grocer;
    var energy = BUNDLE_ENERGY[b.energy] || BUNDLE_ENERGY.balanced;
    var riso = (b.finish || 'riso') !== 'clean';
    function p(field, fb) { var h = b[field] ? color(b[field]) : ''; return h || fb; }
    var surface = p('bg_color', mood.surface);
    var text = p('fg_color', '#1a1a17');
    var cta = p('accent_color', mood.cta);
    var cardFill = p('card_color', mood.cardFill);
    var save = p('save_color', mood.save);
    var sticker = p('sticker_color', mood.sticker);
    var price = p('price_color', mood.price);
    var u = ' * var(--u))';
    var elBorder = riso ? ('calc(3' + u + ' solid #1a1a17') : ('calc(3' + u + ' solid rgba(26,26,23,.10)');
    var elShadow = riso ? ('calc(4' + u + ' calc(4' + u + ' 0 #1a1a17') : ('0 calc(10' + u + ' calc(32' + u + ' rgba(26,26,23,.16)');
    var innerCss = riso
      ? ('border:calc(' + energy.bw + u + ' solid #1a1a17;border-radius:calc(' + energy.rad + u + ';background:transparent;')
      : ('border:none;border-radius:calc(' + energy.rad + u + ';background:' + cardFill + ';box-shadow:0 calc(28' + u + ' calc(72' + u + ' rgba(26,26,23,.13);');
    return {
      style: ['classic', 'receipt', 'sticker'].indexOf(b.bundle_style) !== -1 ? b.bundle_style : 'classic',
      riso: riso, headScale: energy.headScale, surface: surface, text: text, cardFill: cardFill, price: price,
      cta: cta, ctaText: btnText(cta), toggleOn: cta, toggleOnText: btnText(cta),
      save: save, saveText: btnText(save), sticker: sticker, stickerText: btnText(sticker),
      elBorder: elBorder, elShadow: elShadow, innerCss: innerCss,
    };
  }
  renderers.bundle = function (b) {
    var BT = resolveBundleTheme(b);
    var HS = BT.headScale;
    var corner = b.corner_radius || 'subtle';
    var kicker = pick(b.kicker_en, b.kicker_cn);

    var rawVariants = (Array.isArray(b.variants) && b.variants.length) ? b.variants : [{
      id: 'v1', label_en: 'Bundle', label_cn: '组合', title_en: b.title_en, title_cn: b.title_cn,
      subtitle_en: b.subtitle_en, subtitle_cn: b.subtitle_cn, bundle_product_id: b.bundle_product_id,
      product_ids: b.product_ids, bundle_price: b.bundle_price, auto_voucher_code: b.auto_voucher_code,
      cta_label_en: b.cta_label_en, cta_label_cn: b.cta_label_cn, recommended: true,
    }];

    function buildVariant(v) {
      var bp = v.bundle_product_id ? findProductById(v.bundle_product_id) : null;
      var sum = 0, cards, bundlePrice, titleFallback;
      if (bp) {
        var comps = Array.isArray(bp.bundle_components) ? bp.bundle_components.slice(0, 6) : [];
        cards = comps.map(function (c) {
          var qty = Number(c.qty) || 1, line = (Number(c.price) || 0) * qty; sum += line;
          return { id: c.id, image: absUrl(c.image_data) || c.image_data || '',
            name: (pick(c.name_en, c.name_cn) || '') + (qty > 1 ? ' ×' + qty : ''),
            price: line > 0 ? '¥' + line.toFixed(2) : '' };
        });
        bundlePrice = Number(bp.effective_price) > 0 ? Number(bp.effective_price) : (Number(bp.sell_price) || 0);
        titleFallback = pick(bp.name_en, bp.name_cn);
      } else {
        var items = (Array.isArray(v.product_ids) ? v.product_ids : []).map(findProductById).filter(Boolean).slice(0, 6);
        cards = items.map(function (p) { var m = moneyEff(p); sum += m.eff;
          return { id: p.id, image: prodImg(p), name: pick(p.name_en, p.name_cn), price: m.eff > 0 ? '¥' + m.eff.toFixed(2) : '' };
        });
        bundlePrice = Number(v.bundle_price) || 0; titleFallback = '';
      }
      var showSavings = bundlePrice > 0 && bundlePrice < sum;
      var savAmt = sum - bundlePrice;
      return {
        id: v.id || '', label: pick(v.label_en, v.label_cn) || (CN() ? '组合' : 'Bundle'),
        recommended: !!v.recommended, title: pick(v.title_en, v.title_cn) || titleFallback,
        subtitle: pick(v.subtitle_en, v.subtitle_cn), cards: cards, cardCount: cards.length,
        sumLabel: sum > 0 ? '¥' + sum.toFixed(2) : '',
        priceLabel: bundlePrice > 0 ? '¥' + bundlePrice.toFixed(2) : (sum > 0 ? '¥' + sum.toFixed(2) : ''),
        showSavings: showSavings,
        savingsLabel: showSavings ? (CN() ? ('省 ¥' + savAmt.toFixed(2)) : ('SAVE ¥' + savAmt.toFixed(2))) : '',
        bundleProductId: bp ? bp.id : null,
        addLabel: pick(v.cta_label_en, v.cta_label_cn) || (bp ? (CN() ? '加入购物车' : 'ADD BUNDLE') : (CN() ? ('加入购物车 (' + cards.length + ' 件)') : ('ADD BUNDLE · ' + cards.length + ' ITEMS'))),
        empty: bp ? false : cards.length === 0,
      };
    }
    var variants = rawVariants.map(buildVariant);
    var recIdx = Math.max(0, variants.map(function (v) { return v.recommended; }).indexOf(true));
    var activeIndex = recIdx >= 0 ? recIdx : 0;
    var active = variants[activeIndex] || variants[0];
    if (!active) return '';
    var titleSize = 'calc(' + Math.round(48 * HS) + ' * var(--u))';
    var priceSize = 'calc(' + Math.round(44 * HS) + ' * var(--u))';

    var pillsHtml = variants.length > 1
      ? '<div class="sb-bun-pills-scroll"><div class="sb-bun-pills">' + variants.map(function (v, i) {
        var on = i === activeIndex;
        var st = on ? ('background:' + attr(BT.toggleOn) + ';color:' + attr(BT.toggleOnText) + ';border-color:' + attr(BT.toggleOn) + ';')
          : ('border-color:' + attr(BT.text) + ';color:' + attr(BT.text) + ';');
        return '<div class="sb-bun-pill' + (on ? ' on' : '') + '" data-bun-idx="' + i + '" style="' + st + '">' +
          (v.recommended ? '<span class="sb-bun-pill-star" style="color:' + attr(BT.save) + '">★ </span>' : '') + escapeHtml(v.label) + '</div>';
      }).join('') + '</div></div>'
      : '';

    var content;
    if (active.empty) {
      return '';   // public site: hide an unconfigured bundle (no editor placeholder)
    } else {
      var cards = '<div class="sb-bun-cards"><div class="sb-bun-card-row">' + active.cards.map(function (it, i) {
        return ctaWrap('product:' + it.id, '<div class="sb-bun-card">' +
          '<div class="sb-bun-card-img"' + (BT.riso ? '' : ' style="border-color:transparent"') + '>' + (it.image ? '<img class="sb-img-full" src="' + attr(it.image) + '" alt="">' : '') + '</div>' +
          '<div class="sb-bun-card-name">' + escapeHtml(it.name) + '</div>' +
          (it.price ? '<div class="sb-bun-card-price">' + escapeHtml(it.price) + '</div>' : '') + '</div>') +
          (i < active.cardCount - 1 ? '<div class="sb-bun-plus">+</div>' : '');
      }).join('') + '</div></div>';
      var foot = '<div class="sb-bun-foot"><div class="sb-bun-price-block">' +
        (active.savingsLabel ? '<div class="sb-bun-was">' + escapeHtml(active.sumLabel) + '</div>' : '') +
        '<div class="sb-bun-price" style="color:' + attr(BT.price) + ';font-size:' + priceSize + '">' + escapeHtml(active.priceLabel) + '</div>' +
        (active.savingsLabel ? '<div class="sb-bun-savings" style="color:' + attr(BT.save) + '">' + escapeHtml(active.savingsLabel) + '</div>' : '') + '</div>' +
        ctaWrap(active.bundleProductId ? ('product:' + active.bundleProductId) : 'cart',
          '<div class="sb-bun-cta" style="background:' + attr(BT.cta) + ';color:' + attr(BT.ctaText) + '">' + escapeHtml(active.addLabel) + '</div>') + '</div>';
      content = (kicker ? '<div class="sb-bun-kicker">' + escapeHtml(kicker) + '</div>' : '') + pillsHtml +
        (active.title ? '<div class="sb-bun-title" style="font-size:' + titleSize + '">' + escapeHtml(active.title) + '</div>' : '') +
        (active.subtitle ? '<div class="sb-bun-sub">' + escapeHtml(active.subtitle) + '</div>' : '') + cards + foot;
    }

    return '<div class="sb-bun-blk sb-bun-style-classic ' + (BT.riso ? 'sb-finish-riso' : 'sb-finish-clean') + ' sb-corner-' + corner +
      '" style="background:' + attr(BT.surface) + ';color:' + attr(BT.text) + '">' +
      '<div class="sb-bun-inner" style="' + attr(BT.innerCss) + '">' + content + '</div></div>';
  };

  // flash_sale_strip --------------------------------------------------------
  function fsClock(endsMs) {
    var ms = endsMs ? Math.max(0, endsMs - Date.now()) : 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return { d: pad(d), h: pad(h), m: pad(m), s: pad(s), ms: ms };
  }
  renderers.flash_sale_strip = function (b) {
    var bg = color(b.bg_color || 'berry-punch'), fg = color(b.fg_color || 'oat-milk');
    var flashAccent = b.accent_color ? color(b.accent_color) : '';
    var view = b.view || 'strip';
    var flashGrid = b.card_layout === 'grid' && view !== 'banner';
    var all = ctx.flashSales || [];
    var activeP = all.filter(function (p) { return p.flash && p.flash.state === 'active'; });
    var max = view === 'banner' ? 0 : Math.max(1, Math.min(8, b.product_limit || 3));
    var products = max > 0 ? activeP.slice(0, max) : [];
    var haveSomething = products.length > 0 || (view === 'banner' && activeP.length > 0);
    if (!haveSomething) {
      if (b.hide_when_empty) return '';
      var emptyText = pick(b.empty_text_en, b.empty_text_cn) || '';
      return '<div class="sb-flash-strip" style="background:' + attr(bg) + ';color:' + attr(fg) + '" data-flash="1">' +
        '<div class="sb-fs-head"><div class="sb-fs-head-l">' +
        '<div class="sb-fs-kicker">' + escapeHtml(pick(b.kicker_en, b.kicker_cn)) + '</div>' +
        '<div class="sb-fs-title">' + escapeHtml(pick(b.title_en, b.title_cn)) + '</div></div></div>' +
        '<div class="sb-fs-empty">' + escapeHtml(emptyText) + '</div></div>';
    }
    var clockSrc = products.length ? products : activeP;
    var ends = clockSrc.map(function (p) { return new Date(p.flash.ends_at).getTime(); })
      .filter(function (t) { return isFinite(t); }).sort(function (a, b2) { return a - b2; })[0];
    var clk = fsClock(ends);
    var cellLabels = CN() ? ['天', '时', '分', '秒'] : ['DAYS', 'HRS', 'MIN', 'SEC'];
    var cells = [{ num: clk.d, lbl: cellLabels[0] }, { num: clk.h, lbl: cellLabels[1] }, { num: clk.m, lbl: cellLabels[2] }, { num: clk.s, lbl: cellLabels[3] }];

    function cardData(p) {
      var fp = Number(p.flash.price) || 0, rp = Number(p.price) || 0;
      var off = rp > 0 && fp < rp ? Math.round(((rp - fp) / rp) * 100) : 0;
      var sold = p.flash.stock_sold || 0, cap = p.flash.stock_limit;
      var pct = (cap != null && cap > 0) ? Math.min(100, Math.round((sold / cap) * 100)) : null;
      return {
        id: p.id, image: prodImg(p), name: pick(p.name_en, p.name_cn),
        priceNow: '¥' + fp.toFixed(2), priceWas: rp > fp ? '¥' + rp.toFixed(2) : '',
        off: off, sold: sold, cap: cap, meterPct: pct,
      };
    }

    // Design directions: classic / editorial / urgency
    if (view === 'classic' || view === 'editorial' || view === 'urgency') {
      var EN = ({ refined: { head: 0.9, border: 1.5, radius: 12 }, balanced: { head: 1, border: 1.5, radius: 16 }, bold: { head: 1.14, border: 2, radius: 18 } })[b.energy] || { head: 1, border: 1.5, radius: 16 };
      var sv = '--fs-head:' + EN.head + ';--fs-border:calc(' + EN.border + ' * var(--u));--fs-radius:calc(' + (EN.radius * 2) + ' * var(--u))';
      function setVar(prop, token) { var c = token ? color(token) : ''; if (c) sv += ';' + prop + ':' + c; }
      setVar('--fs-ink', b.ink_color); setVar('--fs-panel', b.panel_color); setVar('--fs-tile', b.tile_color);
      setVar('--fs-accent', b.accent_color); setVar('--fs-fill', b.fill_color); setVar('--fs-price', b.price_color);
      var pulse = b.urgency === 'frantic';
      var corner = b.corner_radius || 'subtle';
      var maxOff = products.reduce(function (mx, p) { var rp = Number(p.price) || 0, fp = Number(p.flash.price) || 0; return rp > 0 ? Math.max(mx, Math.round(((rp - fp) / rp) * 100)) : mx; }, 0);
      var kicker = pick(b.kicker_en, b.kicker_cn), title = pick(b.title_en, b.title_cn);
      var shop = pick(b.cta_label_en, b.cta_label_cn), ctaTarget = b.cta_target || 'shop';
      var endsLabel = CN() ? '距结束' : 'ENDS IN';
      var liveLbl = CN() ? '限时秒杀 · 进行中' : 'FLASH SALE · LIVE';
      var offMain = CN() ? ('最高省 ' + maxOff + '%') : ('Up to ' + maxOff + '% off');
      var badgeKind = view === 'classic' ? 'corner' : view === 'editorial' ? 'ribbon' : 'stamp';

      function fsdCard(p) {
        var d = cardData(p);
        var sold = d.sold > 0 ? (CN() ? (d.cap != null ? ('已抢 ' + d.sold + ' / ' + d.cap) : ('已抢 ' + d.sold)) : (d.cap != null ? (d.sold + ' OF ' + d.cap + ' SOLD') : (d.sold + ' SOLD'))) : '';
        var badge = d.off > 0 ? '−' + d.off + '%' : '';
        return ctaWrap('product:' + d.id, '<div class="sb-fsd-card">' +
          '<div class="sb-fsd-img">' + (d.image ? '<img class="sb-img-full" src="' + attr(d.image) + '" alt="">' : '') +
          (badge ? '<div class="sb-fsd-badge-' + badgeKind + '">' + escapeHtml(badge) + '</div>' : '') + '</div>' +
          '<div class="sb-fsd-meta"><div class="sb-fsd-name">' + escapeHtml(d.name) + '</div>' +
          '<div class="sb-fsd-prices"><span class="sb-fsd-now">' + escapeHtml(d.priceNow) + '</span>' +
          (d.priceWas ? '<span class="sb-fsd-was">' + escapeHtml(d.priceWas) + '</span>' : '') + '</div>' +
          (d.meterPct !== null ? '<div class="sb-fsd-meter"><div class="sb-fsd-meter-bar" style="width:' + d.meterPct + '%"></div></div>' : '') +
          (sold ? '<div class="sb-fsd-sold">' + escapeHtml(sold) + '</div>' : '') + '</div></div>');
      }
      var cardsWrap = '<div class="sb-fsd-cards' + (flashGrid ? ' is-grid' : '') + '">' + products.map(fsdCard).join('') + '</div>';
      var tiles = cells.map(function (c) { return '<div class="sb-fsd-tile"><div class="sb-fsd-tile-num">' + c.num + '</div><div class="sb-fsd-tile-lbl">' + escapeHtml(c.lbl) + '</div></div>'; });

      var headInner;
      if (view === 'classic') {
        headInner = '<div class="sb-fsd-head">' + (kicker ? '<div class="sb-fsd-kicker">' + escapeHtml(kicker) + '</div>' : '') + (title ? '<div class="sb-fsd-title">' + escapeHtml(title) + '</div>' : '') + '</div>' +
          '<div class="sb-fsd-ends"><div class="sb-fsd-ends-lbl">' + escapeHtml(endsLabel) + '</div>' +
          '<div class="sb-fsd-clock' + (pulse ? ' sb-fs-pulse' : '') + '">' +
          tiles.map(function (t, i) { return t + (i < 3 ? '<span class="sb-fsd-colon">:</span>' : ''); }).join('') + '</div></div>' +
          (shop ? ctaWrap(ctaTarget, '<div class="sb-fsd-cta-wrap"><div class="sb-fsd-cta">' + escapeHtml(shop) + ' →</div></div>') : '');
      } else if (view === 'editorial') {
        headInner = '<div class="sb-fsd-head">' + (kicker ? '<div class="sb-fsd-kicker">' + escapeHtml(kicker) + '</div>' : '') + (title ? '<div class="sb-fsd-title">' + escapeHtml(title) + '</div>' : '') +
          '<div class="sb-fsd-ticker' + (pulse ? ' sb-fs-pulse' : '') + '">' +
          cells.map(function (c, i) { return '<div class="sb-fsd-seg"><div class="sb-fsd-seg-num">' + c.num + '</div><div class="sb-fsd-seg-lbl">' + escapeHtml(c.lbl) + '</div></div>' + (i < 3 ? '<div class="sb-fsd-seg-div"></div>' : ''); }).join('') + '</div>' +
          '<div class="sb-fsd-cta-row">' + (shop ? ctaWrap(ctaTarget, '<div class="sb-fsd-cta">' + escapeHtml(shop) + ' →</div>') : '') +
          '<div class="sb-fsd-off">' + escapeHtml(offMain) + '</div></div></div>';
      } else { // urgency
        headInner = '<div class="sb-fsd-head"><div class="sb-fsd-live"><span class="sb-fsd-live-dot' + (pulse ? ' sb-fs-pulse-dot' : '') + '"></span><span class="sb-fsd-live-lbl">' + escapeHtml(liveLbl) + '</span></div>' +
          (title ? '<div class="sb-fsd-title">' + escapeHtml(title) + '</div>' : '') + '</div>' +
          '<div class="sb-fsd-clock' + (pulse ? ' sb-fs-pulse' : '') + '">' + tiles.join('') + '</div>' +
          (shop ? ctaWrap(ctaTarget, '<div class="sb-fsd-cta-wrap"><div class="sb-fsd-cta">' + escapeHtml(shop) + ' →</div></div>') : '');
      }
      return '<div class="sb-fsd-wrap sb-fsd-' + view + ' sb-corner-' + corner + '" style="background:' + attr(bg) + ';color:' + attr(fg) + ';' + attr(sv) + '" data-flash="1">' +
        '<div class="sb-fsd-zig"></div><div class="sb-fsd-body">' + headInner + cardsWrap + '</div></div>';
    }

    // strip / hero / banner
    var kicker2 = pick(b.kicker_en, b.kicker_cn), title2 = pick(b.title_en, b.title_cn);
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn), ctaTarget2 = b.cta_target || 'shop';
    var endsLabel2 = CN() ? '距结束' : 'ENDS IN';
    function fsCard(p) {
      var d = cardData(p);
      var meter = CN() ? (d.cap != null ? ('已抢 ' + d.sold + ' / ' + d.cap) : ('已抢 ' + d.sold)) : (d.cap != null ? (d.sold + ' of ' + d.cap + ' sold') : (d.sold + ' sold'));
      return ctaWrap('product:' + d.id, '<div class="sb-fs-card">' +
        '<div class="sb-fs-card-img">' + (d.image ? '<img class="sb-img-full" src="' + attr(d.image) + '" alt="">' : '') +
        (d.off > 0 ? '<div class="sb-fs-badge">-' + d.off + '%</div>' : '') + '</div>' +
        '<div class="sb-fs-card-meta"><div class="sb-fs-card-name">' + escapeHtml(d.name) + '</div>' +
        '<div class="sb-fs-card-prices"><span class="sb-fs-price-now" style="' + (flashAccent ? 'color:' + attr(flashAccent) : '') + '">' + escapeHtml(d.priceNow) + '</span>' +
        (d.priceWas ? '<span class="sb-fs-price-was">' + escapeHtml(d.priceWas) + '</span>' : '') + '</div>' +
        (d.meterPct !== null ? '<div class="sb-fs-meter"><div class="sb-fs-meter-bar" style="width:' + d.meterPct + '%;' + (flashAccent ? 'background:' + attr(flashAccent) : '') + '"></div></div>' : '') +
        '<div class="sb-fs-meter-lbl">' + escapeHtml(meter) + '</div></div></div>');
    }
    if (view === 'hero' || view === 'banner') {
      var clockHero = (view === 'hero' || view === 'banner') ? '<div class="sb-fh-ends">' + escapeHtml(endsLabel2) + '</div>' +
        '<div class="sb-fh-clock">' + cells.map(function (c, i) { return '<div class="sb-fh-cell"><div class="sb-fh-num">' + c.num + '</div><div class="sb-fh-lbl">' + escapeHtml(c.lbl) + '</div></div>' + (i < 3 ? '<div class="sb-fh-sep">:</div>' : ''); }).join('') + '</div>' : '';
      return '<div class="sb-flash-hero sb-flash-' + view + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '" data-flash="1">' +
        (kicker2 ? '<div class="sb-fh-kicker">' + escapeHtml(kicker2) + '</div>' : '') +
        (title2 ? '<div class="sb-fh-title">' + escapeHtml(title2) + '</div>' : '') + clockHero +
        (ctaLabel ? ctaWrap(ctaTarget2, '<div class="sb-fh-cta">' + escapeHtml(ctaLabel) + '</div>') : '') +
        (view === 'hero' && products.length ? '<div class="sb-fs-cards sb-fh-cards' + (flashGrid ? ' is-grid' : '') + '">' + products.map(fsCard).join('') + '</div>' : '') + '</div>';
    }
    // strip (default)
    return '<div class="sb-flash-strip" style="background:' + attr(bg) + ';color:' + attr(fg) + '" data-flash="1">' +
      '<div class="sb-fs-head"><div class="sb-fs-head-l">' +
      (kicker2 ? '<div class="sb-fs-kicker">' + escapeHtml(kicker2) + '</div>' : '') +
      (title2 ? '<div class="sb-fs-title">' + escapeHtml(title2) + '</div>' : '') + '</div>' +
      '<div class="sb-fs-clock"><div class="sb-fs-clock-lbl">' + escapeHtml(endsLabel2) + '</div>' +
      '<div class="sb-fs-clock-cells">' +
      '<span class="sb-fs-ct-num">' + clk.d + '</span><span class="sb-fs-ct-sep">:</span>' +
      '<span class="sb-fs-ct-num">' + clk.h + '</span><span class="sb-fs-ct-sep">:</span>' +
      '<span class="sb-fs-ct-num">' + clk.m + '</span><span class="sb-fs-ct-sep">:</span>' +
      '<span class="sb-fs-ct-num">' + clk.s + '</span></div></div></div>' +
      '<div class="sb-fs-cards' + (flashGrid ? ' is-grid' : '') + '">' + products.map(fsCard).join('') + '</div></div>';
  };

  // voting_block ------------------------------------------------------------
  renderers.voting_block = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var accent = color(b.accent_color || 'lime-leaf');
    var statusColor = color(b.status_color || 'berry-punch');
    var view = b.view || ((b.title_en || b.title_cn) ? 'teaser' : 'peek');
    var src = b.data_source || 'auto_pull';
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var title = pick(b.title_en, b.title_cn);
    var subtitle = pick(b.subtitle_en, b.subtitle_cn);
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    var ctaTarget = b.cta_target || 'voting';

    var polls = (ctx.config && Array.isArray(ctx.config.polls)) ? ctx.config.polls : [];
    var livePoll = null;
    if (src === 'auto_pull' && view !== 'teaser') {
      if (b.poll_id) livePoll = polls.filter(function (p) { return p.id === b.poll_id; })[0] || null;
      else {
        var open = polls.filter(function (p) { return p.status === 'open'; });
        var closed = polls.filter(function (p) { return p.status === 'closed'; });
        if (view === 'past_result') livePoll = closed[0] || null;
        else { livePoll = open.filter(function (p) { return p.is_featured; })[0] || open[0] || null; if (!livePoll && b.fallback_to_past) livePoll = closed[0] || null; }
      }
    }
    if (src === 'auto_pull' && view !== 'teaser' && !livePoll && b.hide_when_empty) return '';

    function shell(inner) {
      return '<div class="sb-voting-blk sb-voting-' + view + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + inner + '</div>';
    }

    if (view === 'teaser') {
      return shell(ctaWrap(ctaTarget, '<div class="sb-voting-row"><div class="sb-vb-body">' +
        (kicker ? '<div class="sb-vb-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        (title ? '<div class="sb-vb-title">' + escapeHtml(title) + '</div>' : '') +
        (subtitle ? '<div class="sb-vb-sub">' + escapeHtml(subtitle) + '</div>' : '') + '</div>' +
        (ctaLabel ? '<div class="sb-vb-cta sb-vb-cta-pill" style="color:' + attr(accent) + '">' + escapeHtml(ctaLabel) + ' →</div>' : '') + '</div>'));
    }
    if (src === 'static' && !livePoll) {
      return shell(ctaWrap(ctaTarget, '<div>' +
        (kicker ? '<div class="sb-vb-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        (title ? '<div class="sb-vb-q">' + escapeHtml(title) + '</div>' : '') +
        (subtitle ? '<div class="sb-vb-sub">' + escapeHtml(subtitle) + '</div>' : '') +
        (ctaLabel && view !== 'inline' ? '<div class="sb-vb-cta" style="color:' + attr(accent) + '">' + escapeHtml(ctaLabel) + ' →</div>' : '') + '</div>'));
    }
    if (!livePoll) return shell('<div class="sb-vb-stub">' + (CN() ? '暂无投票' : 'No live poll') + '</div>');

    // resolve poll data
    var options = (livePoll.options || []).slice().sort(function (a, b2) { return (a.sort_order || 0) - (b2.sort_order || 0); });
    var totalVotes = options.reduce(function (s, o) { return s + (o.votes || 0); }, 0);
    var myVote = livePoll.my_vote_option_id || null;
    var renderPast = view === 'past_result' || livePoll.status === 'closed';
    var showResults = !!myVote || renderPast;
    var winner = null, winnerPct = 0;
    if (showResults) {
      winner = options.slice().sort(function (a, b2) { return (b2.votes || 0) - (a.votes || 0); })[0] || null;
      if (winner && totalVotes > 0) winnerPct = Math.round((winner.votes / totalVotes) * 100);
    }
    var daysLeft = '';
    if (livePoll.closes_at) {
      var iso = String(livePoll.closes_at).replace(' ', 'T');
      var t = new Date(iso.charAt(iso.length - 1) === 'Z' ? iso : iso + 'Z').getTime();
      var ms = isFinite(t) ? t - Date.now() : 0;
      if (ms > 0) daysLeft = String(Math.ceil(ms / 86400000));
    }
    var question = pick(livePoll.question_en, livePoll.question_cn);
    var category = pick(livePoll.category_en, livePoll.category_cn);
    var reward = livePoll.reward_points || 5;
    var statusRow = '<div class="sb-vb-status-row"><div class="sb-vb-status-pill" style="color:' + attr(statusColor) + '">●  ' + (CN() ? '投票' : 'OPEN') + (daysLeft ? (' · ' + daysLeft + 'D ' + (CN() ? '剩余' : 'LEFT')) : '') + '</div>' +
      (category ? '<div class="sb-vb-cat">' + escapeHtml(category) + '</div>' : '') + '</div>';

    if (renderPast || view === 'past_result') {
      return shell(ctaWrap(ctaTarget, '<div>' +
        '<div class="sb-vb-status-pill closed">' + (CN() ? '已结束' : 'CLOSED') + '</div>' +
        '<div class="sb-vb-q">' + escapeHtml(question) + '</div>' +
        (winner ? '<div class="sb-vb-winner"><div class="sb-vb-winner-label">' + (CN() ? '获胜者' : 'WINNER') + '</div>' +
          '<div class="sb-vb-winner-name" style="background:' + attr(accent) + '">' + escapeHtml(pick(winner.label_en, winner.label_cn)) + '</div>' +
          '<div class="sb-vb-winner-meta">' + winnerPct + '% · ' + (winner.votes || 0) + ' ' + (CN() ? '票' : 'votes') + '</div></div>' : '') +
        (ctaLabel ? '<div class="sb-vb-cta" style="color:' + attr(accent) + '">' + escapeHtml(ctaLabel) + ' →</div>' : '') + '</div>'));
    }
    if (view === 'peek') {
      return shell(ctaWrap(ctaTarget, '<div>' + statusRow +
        '<div class="sb-vb-q">' + escapeHtml(question) + '</div>' +
        '<div class="sb-vb-meta">' + totalVotes + ' ' + (CN() ? '票' : 'votes') + ' · +' + reward + ' ' + (CN() ? '积分' : 'pts') + '</div>' +
        (ctaLabel ? '<div class="sb-vb-cta" style="color:' + attr(accent) + '">' + escapeHtml(ctaLabel) + ' +' + reward + ' →</div>' : '') + '</div>'));
    }
    // inline
    var opts = options.map(function (o, i) {
      var pct = totalVotes > 0 ? (o.votes / totalVotes) * 100 : 0;
      var isMine = o.id === myVote;
      var isMax = showResults && winner && o.id === winner.id && (o.votes || 0) > 0;
      var letter = String.fromCharCode(65 + i);
      var label = pick(o.label_en, o.label_cn);
      var right = showResults
        ? '<div class="sb-vb-opt-pct"><div class="sb-vb-opt-pct-num">' + pct.toFixed(0) + '%</div><div class="sb-vb-opt-pct-lbl">' + (o.votes || 0) + ' ' + (CN() ? '票' : 'VOTES') + '</div></div>'
        : '<div class="sb-vb-opt-tick"></div>';
      return '<div class="sb-vb-opt' + (showResults ? ' opt-results' : '') + (isMax ? ' opt-winner' : '') + '" data-vote-id="' + escapeHtml(String(o.id)) + '">' +
        (showResults ? '<div class="sb-vb-opt-fill' + (isMine ? ' fill-mine' : '') + '" style="width:' + pct.toFixed(1) + '%"></div>' : '') +
        '<div class="sb-vb-opt-row"><div class="sb-vb-opt-letter">' + letter + '</div><div class="sb-vb-opt-label">' + escapeHtml(label) + '</div>' + right + '</div></div>';
    }).join('');
    var foot = showResults
      ? '<div class="sb-vb-voted" style="background:' + attr(accent) + '"><div class="sb-vb-voted-dot" style="color:' + attr(accent) + '">✓</div><div class="sb-vb-voted-text">' + (CN() ? '已投票 · 谢谢' : 'Vote counted. Thanks!') + '</div></div>'
      : ctaWrap(ctaTarget, '<div class="sb-vb-cta">' + (CN() ? '请选择' : 'PICK ONE TO VOTE') + '</div>');
    return shell(statusRow + '<div class="sb-vb-q">' + escapeHtml(question) + '</div>' +
      '<div class="sb-vb-opts" data-poll-id="' + escapeHtml(String(livePoll.id)) + '"' + (showResults ? ' data-voted="1"' : '') + '>' + opts + '</div>' + foot +
      '<div class="sb-vb-foot">' + totalVotes + ' ' + (CN() ? '票' : 'VOTES SO FAR') + '</div>');
  };

  // review_card -------------------------------------------------------------
  renderers.review_card = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var starColor = b.star_color ? color(b.star_color) : '';
    var view = b.view || 'card';
    var reviews = (Array.isArray(b.reviews) && b.reviews.length) ? b.reviews : null;
    if (!reviews && (b.quote_en || b.quote_cn || b.author_name)) {
      reviews = [{ rating: b.rating || 5, quote_en: b.quote_en || '', quote_cn: b.quote_cn || '',
        author_name: b.author_name || '', author_subline_en: b.author_subline_en || '',
        author_subline_cn: b.author_subline_cn || '', avatar_url: b.avatar_url || '' }];
    }
    reviews = reviews || [];
    if (!reviews.length) return '';
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var R = reviews.map(function (r) {
      var rating = Math.max(1, Math.min(5, parseInt(r.rating, 10) || 5));
      var initial = ((r.author_name || '').trim()[0] || '?').toUpperCase();
      return { quote: pick(r.quote_en, r.quote_cn), authorName: r.author_name || '',
        authorSub: pick(r.author_subline_en, r.author_subline_cn),
        rating: rating, avatar: absUrl(r.avatar_url) || '', avatarInitial: initial };
    });
    // inline --rv-* overrides
    var rv = [];
    var rvCard = color(b.card_color); if (rvCard) rv.push('--rv-card:' + rvCard);
    var rvBord = color(b.border_color); if (rvBord) rv.push('--rv-border:' + rvBord);
    var rvAcc = color(b.accent_color); if (rvAcc) rv.push('--rv-accent:' + rvAcc);
    var rvCirc = color(b.circle_color); if (rvCirc) rv.push('--rv-circle:' + rvCirc);
    if (view === 'spotlight' && b.fg_color) rv.push('--rv-cardfg:' + color(b.fg_color));
    var rvVars = rv.join(';');

    function stars(rating, left) {
      var out = '';
      for (var i = 1; i <= 5; i++) {
        var on = i <= rating;
        out += '<span class="sb-rv-star ' + (on ? 'on' : 'off') + '" style="' + (on && starColor ? 'color:' + attr(starColor) : '') + '">★</span>';
      }
      return '<div class="sb-rv-stars' + (left ? ' sb-rv-stars-left' : '') + '">' + out + '</div>';
    }
    function shell(inner) {
      return '<div class="sb-review-blk sb-review-' + view + '" style="background:' + attr(bg) + ';color:' + attr(fg) + ';' + attr(rvVars) + '">' + inner + '</div>';
    }

    if (view === 'riso') {
      function risoCard(r) {
        return '<div class="sb-rv-card sb-riso-card">' +
          '<div class="sb-riso-badge">' + '★★★★★'.split('').map(function (s) { return '<span class="sb-riso-badge-star">' + s + '</span>'; }).join('') + '</div>' +
          '<div class="sb-riso-stamp">' + (CN() ? '真实评价' : 'VERIFIED') + '</div>' +
          (kicker ? '<div class="sb-riso-kicker">' + escapeHtml(kicker) + '</div>' : '') +
          (r.quote ? '<div class="sb-rv-quote sb-rv-quote-left">' + escapeHtml(r.quote) + '</div>' : '') +
          '<div class="sb-rv-person"><div class="sb-rv-mono sb-rv-mono-sticker">' +
          (r.avatar ? '<img class="sb-rv-mono-img" src="' + attr(r.avatar) + '" alt="">' : '<span class="sb-rv-mono-inner">' + escapeHtml(r.avatarInitial) + '</span>') + '</div>' +
          '<div class="sb-rv-person-text">' + (r.authorName ? '<div class="sb-rv-name">' + escapeHtml(r.authorName) + '</div>' : '') +
          (r.authorSub ? '<div class="sb-rv-role">' + escapeHtml(r.authorSub) + '</div>' : '') + '</div></div></div>';
      }
      // One review → a static card; 2+ → an autoplay carousel that swipes
      // through every review (mirrors the mini-app riso swiper).
      if (R.length < 2) return shell('<div class="sb-riso-stack">' + risoCard(R[0]) + '</div>');
      return shell(rvCarousel(R.map(risoCard), 'sb-riso-carousel'));
    }
    if (view === 'editorial') {
      var r0 = R[0];
      return shell('<div class="sb-rv-card sb-ed-card">' +
        (kicker ? '<div class="sb-ed-kicker"><span class="sb-ed-tick"></span><span class="sb-ed-klabel">' + escapeHtml(kicker) + '</span><span class="sb-ed-tick"></span></div>' : '') +
        stars(r0.rating, false) +
        (r0.quote ? '<div class="sb-rv-quote">' + escapeHtml(r0.quote) + '</div>' : '') +
        '<div class="sb-rv-divider"></div>' +
        '<div class="sb-rv-person"><div class="sb-rv-mono">' + (r0.avatar ? '<img class="sb-rv-mono-img" src="' + attr(r0.avatar) + '" alt="">' : escapeHtml(r0.avatarInitial)) + '</div>' +
        '<div class="sb-rv-person-text">' + (r0.authorName ? '<div class="sb-rv-name">' + escapeHtml(r0.authorName) + '</div>' : '') +
        (r0.authorSub ? '<div class="sb-rv-role">' + escapeHtml(r0.authorSub) + '</div>' : '') + '</div></div></div>');
    }
    if (view === 'spotlight') {
      var a = R[0];
      var rail = R.map(function (r, i) { return '<div class="sb-spot-thumb' + (i === 0 ? ' on' : '') + '">' + escapeHtml(r.avatarInitial) + '</div>'; }).join('');
      return shell('<div class="sb-spot-head"><div class="sb-spot-head-text">' +
        (kicker ? '<div class="sb-spot-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        '<div class="sb-spot-title">' + (CN() ? '街坊都爱' : 'Loved by locals.') + '</div></div></div>' +
        '<div class="sb-spot-stage"><div class="sb-rv-card"><div class="sb-spot-top">' + stars(a.rating, true) +
        '<span class="sb-spot-count">' + pad2(1) + ' / ' + pad2(R.length) + '</span></div>' +
        (a.quote ? '<div class="sb-rv-quote sb-rv-quote-left">' + escapeHtml(a.quote) + '</div>' : '') +
        '<div class="sb-rv-person"><div class="sb-rv-mono">' + (a.avatar ? '<img class="sb-rv-mono-img" src="' + attr(a.avatar) + '" alt="">' : escapeHtml(a.avatarInitial)) + '</div>' +
        '<div class="sb-rv-person-text">' + (a.authorName ? '<div class="sb-rv-name">' + escapeHtml(a.authorName) + '</div>' : '') +
        (a.authorSub ? '<div class="sb-rv-role">' + escapeHtml(a.authorSub) + '</div>' : '') + '</div></div></div></div>' +
        '<div class="sb-spot-rail">' + rail + '</div>');
    }
    // card / carousel (default): one centred item, or swipe through all
    function rvItem(rc) {
      return '<div class="sb-rv-item">' + stars(rc.rating, false) +
        (rc.quote ? '<div class="sb-rv-quote">' + escapeHtml(rc.quote) + '</div>' : '') +
        '<div class="sb-rv-byline"><div class="sb-rv-avatar">' + (rc.avatar ? '<img class="sb-rv-avatar-img" src="' + attr(rc.avatar) + '" alt="">' : '<span class="sb-rv-avatar-fallback">' + escapeHtml(rc.avatarInitial) + '</span>') + '</div>' +
        '<div class="sb-rv-byline-text">' + (rc.authorName ? '<div class="sb-rv-name">' + escapeHtml(rc.authorName) + '</div>' : '') +
        (rc.authorSub ? '<div class="sb-rv-sub">' + escapeHtml(rc.authorSub) + '</div>' : '') + '</div></div></div>';
    }
    var head = kicker ? '<div class="sb-rv-kicker">' + escapeHtml(kicker) + '</div>' : '';
    if (view === 'carousel' && R.length > 1) return shell(head + rvCarousel(R.map(rvItem), ''));
    return shell(head + rvItem(R[0]));
  };

  // wecom_contact -----------------------------------------------------------
  renderers.wecom_contact = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var view = b.view === 'strip' ? 'strip' : 'card';
    var cardStyle = ['warm', 'coupon', 'poster', 'compact'].indexOf(b.card_style) !== -1 ? b.card_style : 'warm';
    var accent = color(b.accent_color || 'forest-kale');
    var btnFg = btnText(b.accent_color || 'forest-kale');
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var title = pick(b.title_en, b.title_cn);
    var subtitle = pick(b.subtitle_en, b.subtitle_cn);
    var hint = pick(b.hint_en, b.hint_cn) || (CN() ? '长按二维码 · 识别添加' : 'Long-press QR · tap "Add"');
    var buttonLabel = pick(b.button_label_en, b.button_label_cn) || (b.qr_image_url ? (CN() ? '添加我们' : 'Add us') : (CN() ? '联系客服' : 'Chat with us'));
    var qrUrl = absUrl(b.qr_image_url);
    var showButton = b.show_chat_button !== false;
    var showQr = b.show_qr !== false;
    var oneLineProps = (CN() ? ['优惠活动', '新品首发', '专属福利', '专人客服'] : ['Promotions', 'New drops', 'Exclusive offers', 'Direct support']).join(' · ');
    var props = [
      { bg: '#FFAF60', label: CN() ? '优惠活动' : 'Promotions' },
      { bg: accent, label: CN() ? '新品首发' : 'New drops' },
      { bg: '#F4B8CB', label: CN() ? '专属福利' : 'Exclusive offers' },
      { bg: '#B2CFED', label: CN() ? '专人客服' : 'Direct support' },
    ];
    var ctaTarget = 'wecom';
    var qrFrame = (showQr && qrUrl) ? '<div class="sb-wc-loop-qr-frame"><img class="sb-wc-loop-qr-img" src="' + attr(qrUrl) + '" alt="QR"></div>' : '';

    if (view === 'strip') {
      return '<div class="sb-wc-blk sb-wc-strip" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
        '<div class="sb-wc-strip-body">' +
        (kicker ? '<div class="sb-wc-kicker">' + escapeHtml(kicker) + '</div>' : '') +
        (title ? '<div class="sb-wc-strip-title">' + escapeHtml(title) + '</div>' : '') +
        (subtitle ? '<div class="sb-wc-strip-sub">' + escapeHtml(subtitle) + '</div>' : '') +
        (showButton ? ctaWrap(ctaTarget, '<button class="sb-wc-cta sb-wc-cta-strip" style="background:' + attr(accent) + ';color:' + attr(btnFg) + '">' + escapeHtml(buttonLabel) + '</button>') : '') +
        '</div>' + (showQr && qrUrl ? '<div class="sb-wc-strip-qr"><img class="sb-wc-qr-sm" src="' + attr(qrUrl) + '" alt="QR"><div class="sb-wc-hint">' + escapeHtml(hint) + '</div></div>' : '') + '</div>';
    }

    // card · compact (the live home uses this)
    if (cardStyle === 'compact') {
      var cta = showButton ? ctaWrap(ctaTarget, '<button class="sb-wc-lm-cta" style="background:' + attr(accent) + ';color:' + attr(btnFg) + '">' + escapeHtml(buttonLabel) + '</button>') : '';
      return '<div class="sb-wc-blk sb-wc-loop sb-wc-loop-compact">' +
        '<div class="sb-wc-lm-card' + (b.show_shadow === false ? ' sb-wc-loop-flat' : '') + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
        '<div class="sb-wc-lm-body"><div class="sb-wc-lm-l">' +
        (kicker ? '<div class="sb-wc-lm-kicker" style="color:' + attr(accent) + '">' + escapeHtml(kicker) + '</div>' : '') +
        (title ? '<div class="sb-wc-lm-title">' + escapeHtml(title) + '</div>' : '') +
        '<div class="sb-wc-lm-sub">' + escapeHtml(subtitle || oneLineProps) + '</div>' + cta + '</div>' +
        (showQr && qrUrl ? '<div class="sb-wc-lm-qr">' + qrFrame + '<span class="sb-wc-lm-hint">' + escapeHtml(hint) + '</span></div>' : '') +
        '</div></div></div>';
    }
    // card · warm / poster / coupon -> render the warm "Stay in the loop" pop
    var chips = '<div class="sb-wc-loop-props">' + props.map(function (p) {
      return '<div class="sb-wc-loop-chip" style="background:' + attr(p.bg) + '"><span class="sb-wc-loop-chip-tx">' + escapeHtml(p.label) + '</span></div>';
    }).join('') + '</div>';
    var ctaW = showButton ? ctaWrap(ctaTarget, '<button class="sb-wc-loop-cta" style="color:' + attr(accent) + '"><span>' + escapeHtml(buttonLabel) + '</span><span class="sb-wc-loop-cta-ar">→</span></button>') : '';
    return '<div class="sb-wc-blk sb-wc-loop">' +
      '<div class="sb-wc-loop-card' + (b.show_shadow === false ? ' sb-wc-loop-flat' : '') + (b.show_border === false ? ' sb-wc-loop-noframe' : '') + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      (kicker ? '<div class="sb-wc-loop-badge" style="background:' + attr(accent) + ';color:' + attr(btnFg) + '">' + escapeHtml(kicker) + '</div>' : '') +
      (title ? '<div class="sb-wc-loop-title">' + escapeHtml(title) + '</div>' : '') +
      (subtitle ? '<div class="sb-wc-loop-sub">' + escapeHtml(subtitle) + '</div>' : '') + chips +
      '<div class="sb-wc-loop-foot"><div class="sb-wc-loop-foot-l">' + ctaW + '</div>' +
      (showQr && qrUrl ? '<div class="sb-wc-loop-qr">' + qrFrame + '<span class="sb-wc-loop-qr-hint">' + escapeHtml(hint) + '</span></div>' : '') +
      '</div></div></div>';
  };

  // ═══ 2026-07 PC-native port — the 10 block types the web engine was missing
  // (announcement_bar, featured_item, countdown_timer, video_banner,
  //  points_widget, top_up, store_info, favorites_block, affiliate_block,
  //  leaderboard). Faithful ports of miniapp/components/block-renderer with
  //  sb- class names; PC layouts live in blocks.css. ═══

  // announcement_bar ---------------------------------------------------------
  renderers.announcement_bar = function (b) {
    var label = pick(b.text_en, b.text_cn);
    if (!label) return '';
    var anim = b.animation || 'static', speed = b.speed || 'normal';
    var bg = color(b.bg_color || 'lime-leaf'), fg = color(b.fg_color || 'ink');
    var link = b.link_target || '';
    var t = '<span class="sb-announce-text">' + escapeHtml(label) + '</span>';
    var inner;
    if (anim === 'marquee_rtl' || anim === 'marquee_ltr') {
      inner = '<div class="sb-anim-clip"><div class="sb-anim-track">' + t + t + '</div></div>';
    } else if (anim === 'scroll_up' || anim === 'scroll_down') {
      inner = '<div class="sb-anim-vclip"><div class="sb-anim-vtrack">' + t + t + '</div></div>';
    } else if (anim === 'typewriter' || anim === 'wave' || anim === 'fade_in_letters') {
      // Array.from handles surrogate pairs (emoji / CJK = one element).
      inner = '<div class="sb-letters">' + Array.from(label).map(function (c, i) {
        return '<span class="sb-ch" style="--i:' + i + '">' + (c === ' ' ? '&nbsp;' : escapeHtml(c)) + '</span>';
      }).join('') + '</div>';
    } else {
      inner = t;
    }
    var html = '<div class="sb-announce sb-anim-' + attr(anim) + ' sb-speed-' + attr(speed) +
      (link ? ' sb-announce-linked' : '') + '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      inner + (link ? '<span class="sb-announce-chev">›</span>' : '') + '</div>';
    return link ? ctaWrap(link, html) : html;
  };

  // featured_item ------------------------------------------------------------
  renderers.featured_item = function (b) {
    var p = findProductById(b.product_id);
    var view = b.view || 'card';
    var bg = b.bg_color ? color(b.bg_color) : 'transparent';
    var cardBg = color(b.card_bg_color || 'ink'), cardFg = color(b.card_fg_color || 'oat-milk');
    var corner = b.corner_radius || 'subtle';
    var enter = b.entrance_anim || 'none';
    var kicker = pick(b.kicker_en != null ? b.kicker_en : b.kicker, b.kicker_cn);
    var inner;
    if (p) {
      var m = moneyEff(p);
      var img = prodImg(p);
      var priceMode = b.price_mode || 'both';
      var showSale = (b.sale_badge || 'auto') === 'auto' && !!p.is_on_flash;
      var priceWas = m.isFlash ? '¥' + m.regular.toFixed(2) : '';
      var price = m.eff > 0 ? '¥' + m.eff.toFixed(2) : '—';
      inner = ctaWrap('product:' + p.id,
        '<div class="sb-ft-card" style="background:' + attr(cardBg) + ';color:' + attr(cardFg) + '">' +
        '<div class="sb-ft-img">' + (img ? '<img class="sb-img-full" src="' + attr(img) + '" alt="" loading="lazy">' : '') +
        (showSale ? '<div class="sb-feat-badge">' + (CN() ? '秒杀' : 'SALE') + '</div>' : '') + '</div>' +
        '<div class="sb-ft-meta">' +
        (kicker ? '<div class="sb-ft-kicker" style="color:' + attr(cardFg) + '">' + escapeHtml(kicker) + '</div>' : '') +
        '<div class="sb-ft-name">' + escapeHtml(pick(p.name_en, p.name_cn)) + '</div>' +
        (priceMode !== 'hide_price'
          ? '<div class="sb-ft-price-row">' +
            (priceMode === 'both' && priceWas ? '<span class="sb-ft-price-was" style="color:' + attr(cardFg) + ';opacity:.55">' + priceWas + '</span>' : '') +
            '<span class="sb-ft-price' + (m.isFlash ? ' sb-ft-flash' : '') + '">' + price + '</span></div>'
          : '') +
        '</div></div>');
    } else {
      inner = '<div class="sb-ft-empty">' + (CN() ? '暂无精选商品' : 'No featured product') + '</div>';
    }
    return '<div class="sb-featured sb-featured-view-' + attr(view) + ' sb-corner-' + attr(corner) +
      (enter !== 'none' ? ' sb-enter-' + attr(enter) : '') + '" style="background:' + attr(bg) + '">' + inner + '</div>';
  };

  // countdown_timer ----------------------------------------------------------
  function cdSplit(ms) {
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return [pad2(d), pad2(h), pad2(m), pad2(s)];
  }
  renderers.countdown_timer = function (b) {
    var bg = color(b.bg_color || 'ink'), fg = color(b.fg_color || 'lime-leaf');
    var kicker = pick(b.kicker_en, b.kicker_cn), title = pick(b.title_en, b.title_cn);
    var ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    var endsMs = b.ends_at ? new Date(b.ends_at).getTime() : 0;
    var ms = endsMs - Date.now();
    var corner = b.corner_radius || 'subtle';
    var urgAnim = b.urgency_anim || 'pulse';
    var urgent = ms > 0 && urgAnim !== 'off' && ms < (urgAnim === 'pulse_hour' ? 3600000 : 600000);
    var head = (kicker ? '<div class="sb-cd-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      (title ? '<div class="sb-cd-title">' + escapeHtml(title) + '</div>' : '');
    var body;
    if (ms <= 0) {
      var ended = pick(b.ended_text_en, b.ended_text_cn) || (CN() ? '本场已结束' : "That's a wrap");
      body = '<div class="sb-cd-ended">' + escapeHtml(ended) + '</div>';
    } else {
      var cells = cdSplit(ms);
      var labels = CN() ? ['天', '时', '分', '秒'] : ['DAYS', 'HRS', 'MIN', 'SEC'];
      body = '<div class="sb-cd-clock">' + cells.map(function (n, i) {
        return '<div class="sb-cd-cell"><div class="sb-cd-num">' + n + '</div><div class="sb-cd-lbl">' + labels[i] + '</div></div>' +
          (i < 3 ? '<div class="sb-cd-sep">:</div>' : '');
      }).join('') + '</div>' +
        (ctaLabel ? ctaWrap(b.cta_target || '', '<div class="sb-cd-cta" style="' +
          (b.btn_color ? 'background:' + attr(color(b.btn_color)) + ';color:' + attr(btnText(b.btn_color)) : '') + '">' +
          escapeHtml(ctaLabel) + '</div>') : '');
    }
    return '<div class="sb-countdown sb-corner-' + attr(corner) + (urgent ? ' sb-urgent' : '') +
      '" data-cd-ends="' + endsMs + '" data-cd-urg="' + attr(urgAnim) +
      '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + head + body + '</div>';
  };

  // video_banner -------------------------------------------------------------
  renderers.video_banner = function (b) {
    var url = absUrl(b.video_url);
    if (!url) return '';
    var poster = absUrl(b.poster_url);
    var h = b.height_px || 420;
    // 'fullscreen' is a device splash on the mini-app; on the web home it
    // becomes a tall in-page band instead of hijacking the viewport.
    var style = b.display === 'fullscreen' ? 'height:70vh' : 'height:calc(' + (h * 2) + ' * var(--u))';
    var html = '<div class="sb-video-blk" style="' + style + '">' +
      '<video class="sb-video-el" src="' + attr(url) + '"' + (poster ? ' poster="' + attr(poster) + '"' : '') +
      ' autoplay loop muted playsinline></video></div>';
    return b.link_target ? ctaWrap(b.link_target, html) : html;
  };

  // points_widget ------------------------------------------------------------
  renderers.points_widget = function (b) {
    var bg = color(b.bg_color || 'forest-kale'), fg = color(b.fg_color || 'lime-leaf');
    var kicker = pick(b.kicker_en, b.kicker_cn), title = pick(b.title_en, b.title_cn);
    var sub = pick(b.subtitle_en, b.subtitle_cn), ctaLabel = pick(b.cta_label_en, b.cta_label_cn);
    return '<div class="sb-points-blk" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      '<div class="sb-pt-star"><div class="sb-pt-star-glyph">★</div></div>' +
      '<div class="sb-pt-body">' +
      (kicker ? '<div class="sb-pt-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      (title ? '<div class="sb-pt-title">' + escapeHtml(title) + '</div>' : '') +
      (sub ? '<div class="sb-pt-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>' +
      (ctaLabel ? ctaWrap(b.cta_target || 'me', '<div class="sb-pt-cta" style="' +
        (b.btn_color ? 'background:' + attr(color(b.btn_color)) + ';color:' + attr(btnText(b.btn_color)) : '') + '">' +
        escapeHtml(ctaLabel) + '</div>') : '') + '</div>';
  };

  // top_up ---------------------------------------------------------------
  // Tiers come from the host (ctx.config.topupPackages, authed) or the public
  // storefront endpoint warmed lazily below — signed-out visitors see them too.
  renderers.top_up = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var layout = b.layout || 'a';
    var accent = b.accent_color ? color(b.accent_color) : '#CCD900';
    var kicker = pick(b.kicker_en, b.kicker_cn), title = pick(b.title_en, b.title_cn);
    var titleHl = pick(b.title_hl_en, b.title_hl_cn);
    var target = b.cta_target || 'topup';
    var pkgs = (ctx.config && Array.isArray(ctx.config.topupPackages) && ctx.config.topupPackages.length)
      ? ctx.config.topupPackages
      : (Array.isArray(caches.topup) ? caches.topup : []);
    var entries = pkgs.map(function (p, idx) { return { p: p, idx: idx }; });
    if (entries.length > 4) entries = [entries[0], entries[1], entries[2], entries[entries.length - 1]];
    var n = entries.length;
    var tiers = entries.map(function (e, i) {
      var amount = Number(e.p.amount || 0), bonus = Number(e.p.bonus_points || 0);
      var pointValue = Number(e.p.point_value_yuan) > 0 ? Number(e.p.point_value_yuan) : 0.01;
      var bonusYuan = bonus * pointValue;
      var best = i === n - 1 && n > 1;
      return {
        numLabel: 'NO.' + String(e.idx + 1).padStart(2, '0'),
        amountDisplay: amount.toLocaleString(),
        valueDisplay: Number((amount + bonusYuan).toFixed(2)).toLocaleString(),
        bonus: bonus,
        pct: amount > 0 ? Math.round((bonusYuan / amount) * 100) : 0,
        best: best,
        kind: best ? 'ink' : (['cream', 'amber'][i % 2]),
      };
    });
    var bestLbl = CN() ? '超值首选' : 'BEST VALUE';
    var ptsLbl = CN() ? '积分' : 'PTS', bonusLbl = CN() ? '加赠' : 'BONUS', valueLbl = CN() ? '价值' : 'VALUE';
    function meta(t) { return t.pct + '% ' + bonusLbl + ' · ≈¥' + t.valueDisplay + ' ' + valueLbl; }
    var head = '<div class="sb-tu-head">' +
      (kicker ? '<div class="sb-tu-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      (title ? '<div class="sb-tu-title">' + escapeHtml(title) +
        (titleHl ? '<span class="sb-tu-hl"> ' + escapeHtml(titleHl) + '</span>' : '') + '</div>' : '') + '</div>';
    var linkout = ctaWrap(target, '<div class="sb-tu-linkout"><span class="sb-tu-sub">' +
      (CN() ? '在钱包中选择套餐' : 'Pick a pack in the wallet') + '</span><div class="sb-tu-cta">' +
      (CN() ? '立即充值' : 'Top up now') + ' →</div></div>');
    var body;
    if (layout === 'b') {
      body = (tiers.length ? '<div class="sb-tu-receipt">' + tiers.map(function (t) {
        return ctaWrap(target, '<div class="sb-tu-band sb-tu-card--' + t.kind + '">' +
          '<div class="sb-tu-notch sb-tu-notch--l"></div><div class="sb-tu-notch sb-tu-notch--r"></div>' +
          '<div class="sb-tu-band-l"><div class="sb-tu-num">' + t.numLabel + '</div><div class="sb-tu-amt">¥' + t.amountDisplay + '</div></div>' +
          '<div class="sb-tu-band-r">' + (t.best ? '<div class="sb-tu-best sb-tu-best--band">' + bestLbl + '</div>' : '') +
          '<div class="sb-tu-pts">+' + t.bonus + ' ' + ptsLbl + '</div>' +
          '<div class="sb-tu-meta">' + meta(t) + '</div></div></div>');
      }).join('') + '</div>' : '') + linkout;
    } else if (layout === 'c') {
      var hero = tiers[n - 1] || null, rest = tiers.slice(0, Math.max(0, n - 1));
      body = (hero ? ctaWrap(target, '<div class="sb-tu-hero">' +
        '<div class="sb-tu-best sb-tu-best--hero">' + bestLbl + '</div>' +
        '<div class="sb-tu-hero-top"><div class="sb-tu-hero-l"><div class="sb-tu-num">' + hero.numLabel + '</div>' +
        '<div class="sb-tu-amt sb-tu-amt--hero">¥' + hero.amountDisplay + '</div></div>' +
        '<div class="sb-tu-hero-r"><div class="sb-tu-pts">+' + hero.bonus + ' ' + ptsLbl + '</div>' +
        '<div class="sb-tu-meta">' + meta(hero) + '</div></div></div>' +
        '<div class="sb-tu-hero-cta">' + (CN() ? '立即充值' : 'Top up now') + ' →</div></div>') : '') +
        (rest.length ? '<div class="sb-tu-strip">' + rest.map(function (t) {
          return ctaWrap(target, '<div class="sb-tu-chipcard sb-tu-card--' + t.kind + '">' +
            '<div class="sb-tu-num">' + t.numLabel + '</div>' +
            '<div class="sb-tu-amt sb-tu-amt--sm">¥' + t.amountDisplay + '</div>' +
            '<div class="sb-tu-pts sb-tu-pts--sm">+' + t.bonus + ' ' + ptsLbl + '</div>' +
            '<div class="sb-tu-meta sb-tu-meta--sm">≈¥' + t.valueDisplay + ' ' + valueLbl + '</div></div>');
        }).join('') + '</div>' : '');
    } else {
      body = (tiers.length ? '<div class="sb-tu-row">' + tiers.map(function (t) {
        return ctaWrap(target, '<div class="sb-tu-card sb-tu-card--' + t.kind + '">' +
          (t.best ? '<div class="sb-tu-best">' + bestLbl + '</div>' : '') +
          '<div class="sb-tu-num">' + t.numLabel + '</div>' +
          '<div class="sb-tu-amt">¥' + t.amountDisplay + '</div>' +
          '<div class="sb-tu-pts">+' + t.bonus + ' ' + ptsLbl + '</div>' +
          '<div class="sb-tu-meta">' + meta(t) + '</div></div>');
      }).join('') + '</div>' : '') + linkout;
    }
    return '<div class="sb-topup-blk sb-topup-blk--' + attr(layout) + '" style="background:' + attr(bg) +
      ';color:' + attr(fg) + ';--tu-accent:' + attr(accent) + ';--tu-bg:' + attr(bg) + '">' + head + body + '</div>';
  };

  // store_info -----------------------------------------------------------
  renderers.store_info = function (b) {
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var btnBg = color(b.btn_color || ''), btnFg = b.btn_color ? btnText(b.btn_color) : '';
    var openCol = color(b.open_color || 'pea-sprout'), closedCol = color(b.closed_color || 'berry-punch');
    var raw = Array.isArray(b.stores) && b.stores.length ? b.stores : null;
    if (!raw && (b.title_en || b.title_cn || b.address_en || b.address_cn || b.phone)) {
      raw = [{
        name_en: b.title_en, name_cn: b.title_cn,
        address_en: b.address_en, address_cn: b.address_cn,
        hours_en: b.hours_en, hours_cn: b.hours_cn,
        phone: b.phone, open_hour: b.open_hour, close_hour: b.close_hour,
        eta_minutes: b.eta_minutes,
        cta_label_en: b.cta_label_en, cta_label_cn: b.cta_label_cn, cta_target: b.cta_target,
      }];
    }
    if (!raw || !raw.length) return '';
    var now = new Date();
    var hr = now.getHours() + now.getMinutes() / 60;
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var cards = raw.map(function (s) {
      var openH = Number(s.open_hour), closeH = Number(s.close_hour);
      var hasHours = isFinite(openH) && isFinite(closeH) && s.open_hour !== null && s.open_hour !== '' && s.open_hour !== undefined;
      var isOpen = hasHours
        ? (closeH > openH ? (hr >= openH && hr < closeH) : (hr >= openH || hr < closeH))
        : null;
      var eta = Number(s.eta_minutes) || 0;
      var name = pick(s.name_en, s.name_cn), addressV = pick(s.address_en, s.address_cn);
      var hours = pick(s.hours_en, s.hours_cn), ctaLabel = pick(s.cta_label_en, s.cta_label_cn);
      var out = '<div class="sb-st-card">';
      if (name) out += '<div class="sb-st-title">' + escapeHtml(name) + '</div>';
      if (isOpen !== null) {
        out += '<div class="sb-st-status"><div class="sb-st-dot" style="background:' + attr(isOpen ? openCol : closedCol) + '"></div>' +
          '<span class="sb-st-status-lbl">' + (isOpen ? (CN() ? '营业中' : 'Open now') : (CN() ? '已打烊' : 'Closed')) + '</span>' +
          (hours ? '<span class="sb-st-hours"> · ' + escapeHtml(hours) + '</span>' : '') + '</div>';
      } else if (hours) {
        out += '<div class="sb-st-row"><span class="sb-st-icon">🕒</span><span class="sb-st-val">' + escapeHtml(hours) + '</span></div>';
      }
      if (eta > 0 && isOpen === true) {
        out += '<div class="sb-st-eta">' + (CN() ? '约 ' + eta + ' 分钟送达' : '~' + eta + ' min delivery') + '</div>';
      }
      if (addressV) out += '<div class="sb-st-row"><span class="sb-st-icon">📍</span><span class="sb-st-val">' + escapeHtml(addressV) + '</span></div>';
      if (s.phone) out += '<a class="sb-st-row" href="tel:' + attr(s.phone) + '"><span class="sb-st-icon">📞</span><span class="sb-st-val sb-st-phone">' + escapeHtml(s.phone) + '</span></a>';
      if (ctaLabel && s.cta_target) {
        out += ctaWrap(s.cta_target, '<div class="sb-st-cta" style="' +
          (btnBg ? 'background:' + attr(btnBg) + ';color:' + attr(btnFg) : '') + '">' + escapeHtml(ctaLabel) + '</div>');
      }
      return out + '</div>';
    }).join('');
    return '<div class="sb-store-blk" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      (kicker ? '<div class="sb-st-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      '<div class="sb-st-cards">' + cards + '</div></div>';
  };

  // favorites_block --------------------------------------------------------
  // Items come from the host (ctx.config.favorites — customer's wishlist).
  renderers.favorites_block = function (b) {
    var favs = (ctx.config && Array.isArray(ctx.config.favorites)) ? ctx.config.favorites : [];
    var hideEmpty = b.hide_when_empty !== false;
    if (!favs.length && hideEmpty) return '';
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var view = b.view || 'scroll';
    var limit = Math.max(1, Math.min(12, b.limit || 6));
    var corner = b.corner_radius || 'subtle';
    var kicker = pick(b.kicker_en, b.kicker_cn) || (CN() ? '你的收藏' : 'YOUR SAVED');
    var title = pick(b.title_en, b.title_cn) || (CN() ? '继续看看' : 'Pick up where you left off.');
    var head = '<div class="sb-fav-head"><div class="sb-fav-head-text">' +
      '<div class="sb-fav-kicker">' + escapeHtml(kicker) + '</div>' +
      '<div class="sb-fav-title">' + escapeHtml(title) + '</div></div>' +
      (favs.length ? ctaWrap('shop', '<div class="sb-fav-see-all">' + (CN() ? '查看全部' : 'SEE ALL') + ' →</div>') : '') + '</div>';
    var body;
    if (!favs.length) {
      body = '<div class="sb-fav-empty"><div class="sb-fav-empty-title">' + (CN() ? '暂无收藏' : 'Nothing saved yet.') + '</div>' +
        '<div class="sb-fav-empty-sub">' + (CN() ? '点心形图标即可收藏。' : 'Tap the heart on a product to save it.') + '</div></div>';
    } else {
      var cards = favs.slice(0, limit).map(function (p) {
        var regular = Number(p.price != null ? p.price : p.sell_price) || 0;
        var eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
        var isFlash = !!p.is_on_flash && eff < regular;
        var soldOut = p.stock != null && Number(p.stock) <= 0;
        var img = prodImg(p);
        return ctaWrap('product:' + p.id,
          '<div class="' + (view === 'grid' ? 'sb-fav-card' : 'sb-fav-rail-card') + (soldOut ? ' sb-fav-out' : '') + '">' +
          '<div class="sb-fav-img">' + (img ? '<img class="sb-img-full" src="' + attr(img) + '" alt="" loading="lazy">' : '') +
          (soldOut ? '<div class="sb-fav-out-tag">' + (CN() ? '已售罄' : 'SOLD OUT') + '</div>' : '') + '</div>' +
          '<div class="sb-fav-name">' + escapeHtml(pick(p.name_en, p.name_cn)) + '</div>' +
          '<div class="sb-fav-price-row">' +
          (isFlash ? '<span class="sb-fav-price-was">¥' + Math.round(regular) + '</span>' : '') +
          '<span class="sb-fav-price' + (isFlash ? ' sb-is-flash' : '') + '">' + (eff > 0 ? '¥' + Math.round(eff) : '—') + '</span>' +
          '</div></div>');
      }).join('');
      body = view === 'grid' ? '<div class="sb-fav-grid">' + cards + '</div>' : '<div class="sb-fav-rail">' + cards + '</div>';
    }
    return '<div class="sb-fav-blk sb-fav-' + attr(view) + ' sb-corner-' + attr(corner) +
      '" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' + head + body + '</div>';
  };

  // affiliate_block --------------------------------------------------------
  // Live data (code / stats) comes from the host via ctx.config.affiliate;
  // signed-out visitors get the sign-in hint variant, same as the mini-app.
  renderers.affiliate_block = function (b) {
    var view = b.view || 'card';
    var bgDefault = view === 'stat' ? 'ink' : view === 'receipt' ? 'oat-milk' : 'lime-leaf';
    var fgDefault = view === 'stat' ? 'lime-leaf' : 'ink';
    var bg = color(b.bg_color || bgDefault), fg = color(b.fg_color || fgDefault);
    var af = (ctx.config && ctx.config.affiliate) || {};
    // "You" (the referrer) and "them" (the invited friend) are tracked as two
    // independent amounts — never assume they're equal.
    var rewardYou = Number(af.reward_per_order) || 30;
    var rewardThem = Number(af.reward_referee) || 0;
    var lifeRate = Number(af.lifetime_rate_percent) || 0;
    var lifeMonths = Number(af.lifetime_months) || 0;
    var stats = af.stats || {};
    var code = af.code || '';
    var en = !CN();
    var earned = Number(stats.earned) || 0, invited = Number(stats.total_invites) || 0;
    var hasActivity = invited > 0 || earned > 0;
    var statsLabel = (b.show_stats !== false && hasActivity)
      ? (en ? '¥' + earned.toFixed(0) + ' earned · ' + invited + ' invited' : '已赚 ¥' + earned.toFixed(0) + ' · 已邀请 ' + invited)
      : '';
    var kicker = pick(b.kicker_en, b.kicker_cn) || (en ? 'REFER A FRIEND' : '推广计划');
    var defaultTitle = rewardThem > 0
      ? (en ? 'Get ¥' + rewardYou + '. Give ¥' + rewardThem + '.' : '你得 ¥' + rewardYou + '，好友得 ¥' + rewardThem + '。')
      : (en ? 'Get ¥' + rewardYou + ' on their first order.' : '好友首单 ¥' + rewardYou + '。');
    var title = pick(b.title_en, b.title_cn) || defaultTitle;
    var subtitle = pick(b.subtitle_en, b.subtitle_cn) || (en ? 'Share your code — when a friend places their first order, you both win.' : '分享邀请码,好友首单后双方各得奖励。');
    // Repeat-order revenue share — only worth a line when the admin has
    // actually turned it on (rate > 0).
    var lifetimeLine = lifeRate > 0
      ? (en
          ? '+ ' + lifeRate + '% of their orders for ' + (lifeMonths > 0 ? lifeMonths + ' months' : 'life')
          : '另享好友日后订单 ' + lifeRate + '%' + (lifeMonths > 0 ? '，持续 ' + lifeMonths + ' 个月' : '，长期有效'))
      : '';
    var accent = color(b.accent_color || 'ink');
    var copyLabel = en ? 'COPY' : '复制', shareLabel = en ? 'SHARE' : '分享';
    var codeLabel = en ? 'YOUR CODE' : '邀请码';
    var enabled = af.enabled !== false;
    var disabledMsg = en ? 'Refer-a-friend is paused.' : '推广计划暂停中。';
    var signinHint = en ? 'Tap to open and get your code →' : '点击获取你的邀请码 →';
    // On the web COPY copies the code and SHARE copies a ready ?ref= link.
    var shareLink = (typeof location !== 'undefined' ? location.origin + location.pathname : '') + '?ref=' + encodeURIComponent(code);
    var copyBtn = function (cls, style) {
      return ctaWrap('copy:' + code, '<div class="' + cls + '"' + (style ? ' style="' + style + '"' : '') + '>' + copyLabel + '</div>');
    };
    var shareBtn = function (cls) {
      return ctaWrap('copy:' + shareLink, '<div class="' + cls + '">' + shareLabel + ' →</div>');
    };
    if (view === 'strip') {
      return '<div class="sb-aff-blk sb-aff-strip" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
        '<div class="sb-aff-strip-left"><div class="sb-aff-strip-kicker">' + escapeHtml(kicker) + '</div>' +
        '<div class="sb-aff-strip-code-row"><span class="sb-aff-strip-code">' + escapeHtml(code || '——') + '</span>' +
        (statsLabel ? '<div class="sb-aff-strip-stats">· ' + escapeHtml(statsLabel) + '</div>' : '') + '</div></div>' +
        (!enabled ? '<div class="sb-aff-strip-disabled">' + disabledMsg + '</div>'
          : code ? copyBtn('sb-aff-strip-copy', 'background:' + attr(accent)) + shareBtn('sb-aff-strip-share')
          : ctaWrap('login', '<div class="sb-aff-strip-cta">' + (pick(b.cta_label_en, b.cta_label_cn) || (en ? 'OPEN' : '查看详情')) + ' →</div>')) +
        '</div>';
    }
    if (view === 'stat') {
      return '<div class="sb-aff-blk sb-aff-stat" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
        '<div class="sb-aff-stat-kicker">' + escapeHtml(kicker) + '</div>' +
        '<div class="sb-aff-stat-num">¥' + earned.toFixed(0) + '</div>' +
        '<div class="sb-aff-stat-sub">' + escapeHtml(hasActivity
          ? (en ? 'from ' + invited + ' friend' + (invited === 1 ? '' : 's') : '来自 ' + invited + ' 位好友')
          : (en ? '¥' + rewardYou + ' on a friend’s first order' : '好友首单 ¥' + rewardYou)) + '</div>' +
        (!enabled ? '<div class="sb-aff-stat-disabled">' + disabledMsg + '</div>'
          : code ? '<div class="sb-aff-stat-code-pill">' + escapeHtml(code) + '</div>' +
            '<div class="sb-aff-stat-actions">' + copyBtn('sb-aff-stat-copy') + shareBtn('sb-aff-stat-share') + '</div>'
          : ctaWrap('login', '<div class="sb-aff-stat-cta">' + (en ? 'INVITE A FRIEND →' : '邀请好友 →') + '</div>')) +
        '</div>';
    }
    if (view === 'receipt') {
      var sep = '<div class="sb-aff-receipt-sep">- - - - - - - - - - - - - - - - - -</div>';
      return '<div class="sb-aff-blk sb-aff-receipt" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
        '<div class="sb-aff-receipt-stub">' + (en ? 'REFER · REWARD' : '推广 · 有礼') + '</div>' +
        '<div class="sb-aff-receipt-kicker">' + escapeHtml(kicker) + '</div>' +
        '<div class="sb-aff-receipt-title">' + escapeHtml(title) + '</div>' + sep +
        (!enabled ? '<div class="sb-aff-receipt-disabled">' + disabledMsg + '</div>'
          : code ? '<div class="sb-aff-receipt-row"><span class="sb-aff-receipt-lbl">' + codeLabel + '</span>' +
            '<span class="sb-aff-receipt-val">' + escapeHtml(code) + '</span></div>' +
            (statsLabel ? '<div class="sb-aff-receipt-row sb-aff-receipt-row-muted"><span class="sb-aff-receipt-lbl">STATS</span><span class="sb-aff-receipt-val">' + escapeHtml(statsLabel) + '</span></div>' : '') +
            (lifetimeLine ? '<div class="sb-aff-receipt-row sb-aff-receipt-row-muted"><span class="sb-aff-receipt-lbl">BONUS</span><span class="sb-aff-receipt-val">' + escapeHtml(lifetimeLine) + '</span></div>' : '') +
            sep + '<div class="sb-aff-receipt-actions">' + copyBtn('sb-aff-receipt-copy', 'background:' + attr(accent)) + shareBtn('sb-aff-receipt-share') + '</div>'
          : ctaWrap('login', '<div class="sb-aff-receipt-signin">' + signinHint + '</div>')) +
        '</div>';
    }
    // card (default)
    return '<div class="sb-aff-blk sb-aff-card" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      '<div class="sb-aff-head"><div class="sb-aff-kicker">' + escapeHtml(kicker) + '</div>' +
      '<div class="sb-aff-title">' + escapeHtml(title) + '</div>' +
      '<div class="sb-aff-sub">' + escapeHtml(subtitle) + '</div>' +
      (lifetimeLine ? '<div class="sb-aff-lifetime">' + escapeHtml(lifetimeLine) + '</div>' : '') + '</div>' +
      (!enabled ? '<div class="sb-aff-disabled">' + disabledMsg + '</div>'
        : code ? '<div class="sb-aff-code-row"><div class="sb-aff-code-pill">' +
          '<span class="sb-aff-code-lbl">' + codeLabel + '</span>' +
          '<span class="sb-aff-code-val">' + escapeHtml(code) + '</span></div>' +
          copyBtn('sb-aff-copy', 'background:' + attr(accent)) + '</div>' +
          '<div class="sb-aff-actions">' + shareBtn('sb-aff-share') +
          (statsLabel ? '<div class="sb-aff-stats">' + escapeHtml(statsLabel) + '</div>' : '') + '</div>'
        : ctaWrap('login', '<div class="sb-aff-signin">' + signinHint + '</div>')) +
      '</div>';
  };

  // leaderboard --------------------------------------------------------------
  // Rows come from the public storefront endpoint (pre-masked server-side),
  // warmed lazily like top-sellers; the host may also thread them via
  // ctx.config.leaderboards keyed metric|period|topN|reveal.
  renderers.leaderboard = function (b) {
    var metric = b.metric || 'lifetime_spend';
    var period = b.period || 'month';
    var topN = Math.max(3, Math.min(10, b.top_n || 5));
    var reveal = b.reveal_mode || 'first_char';
    var key = metric + '|' + period + '|' + topN + '|' + reveal;
    var hostBoards = (ctx.config && ctx.config.leaderboards) || {};
    var entries = Array.isArray(hostBoards[key]) ? hostBoards[key]
      : Array.isArray(caches.lb[key]) ? caches.lb[key] : [];
    var hideUnder = Number(b.hide_when_under) || 0;
    if (!entries.length || (hideUnder && entries.length < hideUnder)) return '';
    var bg = color(b.bg_color || 'oat-milk'), fg = color(b.fg_color || 'ink');
    var accent = color(b.accent_color || 'forest-kale');
    var showValue = b.show_value !== false;
    var medals = ['🥇', '🥈', '🥉'];
    function fmtValue(v) {
      var n = Number(v) || 0;
      if (metric === 'lifetime_spend') return '¥' + Math.round(n).toLocaleString();
      if (metric === 'points_balance') return n.toLocaleString() + (CN() ? ' 分' : ' pts');
      return n.toLocaleString() + (CN() ? ' 单' : ' orders');
    }
    var periodLabel = period === 'week' ? (CN() ? '本周' : 'This week')
      : period === 'month' ? (CN() ? '本月' : 'This month')
      : period === 'year' ? (CN() ? '今年' : 'This year')
      : (CN() ? '累计' : 'All time');
    var kicker = pick(b.kicker_en, b.kicker_cn);
    var title = pick(b.title_en, b.title_cn) || (CN() ? '本月铁粉' : 'Top customers');
    var subhead = pick(b.subhead_en, b.subhead_cn), footer = pick(b.footer_en, b.footer_cn);
    var rows = entries.slice(0, topN).map(function (e, i) {
      var rank = Number(e.rank) || (i + 1);
      return '<div class="sb-lb-row">' +
        (i < 3 ? '<span class="sb-lb-medal">' + medals[i] + '</span>' : '<span class="sb-lb-rank">' + rank + '</span>') +
        '<span class="sb-lb-name">' + escapeHtml(e.name || (CN() ? '会员' : 'Member')) + '</span>' +
        (showValue ? '<span class="sb-lb-value" style="color:' + attr(accent) + '">' + escapeHtml(fmtValue(e.value)) + '</span>' : '') +
        '</div>';
    }).join('');
    return '<div class="sb-lb-blk" style="background:' + attr(bg) + ';color:' + attr(fg) + '">' +
      '<div class="sb-lb-head"><div class="sb-lb-head-main">' +
      (kicker ? '<div class="sb-lb-kicker" style="color:' + attr(accent) + '">' + escapeHtml(kicker) + '</div>' : '') +
      '<div class="sb-lb-ttl">' + escapeHtml(title) + '</div>' +
      (subhead ? '<div class="sb-lb-sub">' + escapeHtml(subhead) + '</div>' : '') + '</div>' +
      '<div class="sb-lb-period">' + periodLabel + '</div></div>' +
      '<div class="sb-lb-list">' + rows + '</div>' +
      (footer ? '<div class="sb-lb-footer">' + escapeHtml(footer) + '</div>' : '') +
      '</div>';
  };

  // ── CTA wrapper ──────────────────────────────────────────────────────────
  // Wrap clickable markup with the data-cta-target attribute the host delegates.
  function ctaWrap(target, html) {
    if (!target) return html;
    // Inject the attribute into the outermost tag of `html`.
    return html.replace(/^(\s*<[a-z0-9]+)/i, '$1 data-cta-target="' + attr(target) + '" role="link" tabindex="0"');
  }

  // ── Frame / fill chrome (mirror .blk-outer) ──────────────────────────────
  function wrapBlock(b, inner) {
    if (!inner) return '';
    var frameOn = !!b.frame_color;
    var frameColor = b.frame_color ? brandColorVar(b.frame_color) : '';
    var fullBleed = b.full_bleed === true;
    var corner = b.corner_radius || 'subtle';
    var fill = !!FULL_BG_TYPES[b.type];
    var cls = 'sb-blk-outer sb-corner-' + corner +
      (frameOn ? ' framed' : '') + (fullBleed ? ' bleed' : '') + (fill ? ' fill' : '');
    var style = frameOn ? ('border-color:' + attr(frameColor)) : '';
    return '<div class="' + cls + '" data-block-type="' + attr(b.type) + '" style="' + style + '">' + inner + '</div>';
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function setContext(c) {
    c = c || {};
    if (c.lang === 'en' || c.lang === 'cn') ctx.lang = c.lang;
    if (Array.isArray(c.products)) ctx.products = c.products;
    if (Array.isArray(c.categories)) ctx.categories = c.categories;
    if (Array.isArray(c.flashSales)) ctx.flashSales = c.flashSales;
    if (c.config !== undefined) ctx.config = c.config;
    // Build a by-id index for handpicked-product resolution.
    var byId = {};
    (ctx.products || []).forEach(function (p) { if (p && p.id != null) byId[p.id] = p; });
    ctx.productsById = byId;
  }

  function render(blocks) {
    if (!Array.isArray(blocks)) return '';
    var html = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || !b.type) continue;
      var fn = renderers[b.type];
      if (!fn) continue;                 // unknown type -> empty string (no crash)
      var inner;
      try { inner = fn(b); } catch (e) { inner = ''; }
      if (inner) html += wrapBlock(b, inner);
    }
    return html;
  }

  function onRerender(fn) { if (typeof fn === 'function') rerenderCbs.push(fn); }
  function onCta(fn) { if (typeof fn === 'function') ctaCbs.push(fn); }
  function fireRerender() { rerenderCbs.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  // ── Lazy data fetches (top sellers, new arrivals, category grids) ────────
  function warmLazyData(blocks) {
    if (!Array.isArray(blocks)) return;
    blocks.forEach(function (b) {
      if (!b || b.type !== 'product_grid') return;
      if (b.source_type === 'top_selling') {
        var ch = b.top_channel || 'combined', win = b.top_window || '7d', lim = b.limit || 6;
        var key = ch + '|' + win + '|' + lim;
        if (caches.top[key]) return;
        caches.top[key] = [];   // mark in-flight
        fetchJson('/api/retail/products/top?channel=' + encodeURIComponent(ch) + '&window=' + encodeURIComponent(win) + '&limit=' + lim)
          .then(function (d) { caches.top[key] = listOf(d); fireRerender(); })
          .catch(function () {});
      } else if (b.source_type === 'new_arrivals') {
        var nl = String(b.limit || 6);
        if (caches.newA[nl]) return;
        caches.newA[nl] = [];
        fetchJson('/api/retail/products?sort=newest&limit=' + nl)
          .then(function (d) { caches.newA[nl] = listOf(d); fireRerender(); })
          .catch(function () {});
      }
    });
    // top_up tiers + leaderboard rows ride PUBLIC storefront endpoints, so the
    // engine warms them itself (host-threaded ctx.config data wins when present).
    blocks.forEach(function (b) {
      if (!b) return;
      if (b.type === 'top_up' && caches.topup === null &&
          !(ctx.config && Array.isArray(ctx.config.topupPackages) && ctx.config.topupPackages.length)) {
        caches.topup = [];   // mark in-flight
        fetchJson('/api/retail/storefront/topup-packages')
          .then(function (d) { caches.topup = listOf(d); fireRerender(); })
          .catch(function () {});
      }
      if (b.type === 'leaderboard') {
        var key = (b.metric || 'lifetime_spend') + '|' + (b.period || 'month') + '|' +
          Math.max(3, Math.min(10, b.top_n || 5)) + '|' + (b.reveal_mode || 'first_char');
        var hostBoards = (ctx.config && ctx.config.leaderboards) || {};
        if (Array.isArray(hostBoards[key]) || caches.lb[key]) return;
        caches.lb[key] = [];   // mark in-flight
        var q = key.split('|');
        fetchJson('/api/retail/storefront/leaderboard?metric=' + encodeURIComponent(q[0]) +
          '&period=' + encodeURIComponent(q[1]) + '&top_n=' + q[2] + '&reveal_mode=' + encodeURIComponent(q[3]))
          .then(function (d) { caches.lb[key] = listOf(d); fireRerender(); })
          .catch(function () {});
      }
    });
  }
  function listOf(d) {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.data)) return d.data;
    if (d && Array.isArray(d.products)) return d.products;
    return [];
  }
  function fetchJson(url) {
    return fetch(BASE + url, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  // ── Timers — countdown digits + periodic flash refetch ───────────────────
  var tickHandle = null, flashHandle = null, lastZeroFired = false;
  var carouselHandles = [];

  function startTimers(rootEl) {
    stopTimers();
    if (!rootEl) return;
    initCarousels(rootEl);
    var blocks = ctx.config && ctx.config.home && ctx.config.home.layout;
    warmLazyData(blocks);
    tickHandle = setInterval(function () { tick(rootEl); }, 1000);
    // Refresh flash sales every 60s so newly-started/ended deals appear.
    flashHandle = setInterval(function () {
      fetchJson('/api/retail/flash-sales').then(function (d) {
        var list = listOf(d);
        if (Array.isArray(list)) { ctx.flashSales = list; fireRerender(); }
      }).catch(function () {});
    }, 60000);
  }

  function tick(rootEl) {
    // countdown_timer blocks: update digits in place every second, toggle the
    // urgency pulse when the threshold is crossed, re-render once at zero so
    // the ended-text state appears.
    var cds = rootEl.querySelectorAll('[data-cd-ends]');
    for (var ci = 0; ci < cds.length; ci++) {
      var node = cds[ci];
      var ends = Number(node.getAttribute('data-cd-ends')) || 0;
      var msLeft = ends - Date.now();
      if (msLeft <= 0) {
        if (!node._cdDone) { node._cdDone = true; fireRerender(); }
        continue;
      }
      setText(node, '.sb-cd-num', cdSplit(msLeft));
      var urg = node.getAttribute('data-cd-urg') || 'pulse';
      if (urg !== 'off') {
        var thr = urg === 'pulse_hour' ? 3600000 : 600000;
        node.classList.toggle('sb-urgent', msLeft < thr);
      }
    }
    // Recompute the soonest flash end across active sales; update digits in
    // place; fire onRerender when a clock crosses zero.
    var all = ctx.flashSales || [];
    var activeP = all.filter(function (p) { return p.flash && p.flash.state === 'active'; });
    if (!activeP.length) return;
    var ends = activeP.map(function (p) { return new Date(p.flash.ends_at).getTime(); })
      .filter(function (t) { return isFinite(t); }).sort(function (a, b) { return a - b; })[0];
    var clk = fsClock(ends);
    if (clk.ms <= 0) {
      if (!lastZeroFired) { lastZeroFired = true; fireRerender(); }
      return;
    }
    lastZeroFired = false;
    // strip-style 4 stacked numbers
    setText(rootEl, '.sb-flash-strip .sb-fs-ct-num', [clk.d, clk.h, clk.m, clk.s]);
    // hero/banner cells + design tiles + editorial segs (each is .num cell, 4 per group)
    updateGroups(rootEl, '.sb-fh-clock .sb-fh-num', [clk.d, clk.h, clk.m, clk.s]);
    updateGroups(rootEl, '.sb-fsd-clock .sb-fsd-tile-num', [clk.d, clk.h, clk.m, clk.s]);
    updateGroups(rootEl, '.sb-fsd-ticker .sb-fsd-seg-num', [clk.d, clk.h, clk.m, clk.s]);
  }
  function setText(root, sel, vals) {
    var nodes = root.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = vals[i % vals.length];
  }
  function updateGroups(root, sel, vals) { setText(root, sel, vals); }

  function stopTimers() {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
    if (flashHandle) { clearInterval(flashHandle); flashHandle = null; }
    for (var i = 0; i < carouselHandles.length; i++) clearInterval(carouselHandles[i]);
    carouselHandles = [];
  }

  // ── Review carousels — autoplay + scroll-synced dots + dot tap nav ────────
  function initCarousels(rootEl) {
    var els = rootEl.querySelectorAll('[data-rv-carousel]');
    for (var i = 0; i < els.length; i++) bindCarousel(els[i]);
  }
  function bindCarousel(car) {
    var track = car.querySelector('.sb-rv-track');
    var dotsWrap = car.parentNode.querySelector('.sb-rv-dots');
    var dots = dotsWrap ? dotsWrap.querySelectorAll('.sb-rv-dot') : [];
    var n = track ? track.children.length : 0;
    if (!track || n < 2) return;
    var cur = 0;
    var pauseUntil = 0;      // user interaction pauses autoplay only until this time
    var progUntil = 0;       // ignore scroll events our own scrollTo triggers
    var now = function () { return Date.now(); };
    // stride = distance between consecutive slides (handles padding + gap)
    function stride() { return (track.children[1].offsetLeft - track.children[0].offsetLeft) || track.clientWidth; }
    function setDots() { for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d === cur); }
    function go(i) {
      cur = (i % n + n) % n;
      progUntil = now() + 800;
      track.scrollTo({ left: cur * stride(), behavior: 'smooth' });
      setDots();
    }
    function onScroll() {
      var idx = Math.round(track.scrollLeft / stride());
      cur = Math.max(0, Math.min(n - 1, idx));
      setDots();
      if (now() > progUntil) pauseUntil = now() + 9000;   // a real user swipe
    }
    track.addEventListener('scroll', function () {
      window.clearTimeout(track._rvT);
      track._rvT = window.setTimeout(onScroll, 90);
    });
    for (var d = 0; d < dots.length; d++) {
      (function (idx) { dots[idx].addEventListener('click', function () { pauseUntil = now() + 9000; go(idx); }); })(d);
    }
    carouselHandles.push(setInterval(function () {
      if (!car.offsetParent || now() < pauseUntil) return;
      go(cur + 1);
    }, 4500));
  }

  global.ShopBlocks = {
    setContext: setContext,
    render: render,
    onRerender: onRerender,
    onCta: onCta,
    startTimers: startTimers,
    stopTimers: stopTimers,
    // exposed for host/debug
    brandColorVar: brandColorVar,
    _ctx: ctx,
  };
})(typeof window !== 'undefined' ? window : this);
