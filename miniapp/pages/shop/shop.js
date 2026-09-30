// Shop tab — admin-configurable layout + filter controls.
// Layouts: 'list' | 'list-compact' | 'grid-2col' | 'grid-3col' | 'gallery'
// Filters (each toggleable in /retail-admin → Settings):
//   - Sort dropdown (featured / newest / price ↑ / price ↓ / popular)
//   - In-stock-only pill
//   - Badge filter chips (NEW / POP / SALE / HOT)
//   - Price range min/max
//   - Dietary chips (gluten / nuts / soy / 5-spice)
//
// Category navigation is scroll-driven (food-app style): products are
// rendered grouped by category, scrolling auto-highlights the sidebar/
// chip for the section currently near the top of the viewport. Tapping
// a sidebar entry / chip smooth-scrolls to that section.

const api      = require('../../utils/api');
const lang     = require('../../utils/lang');
const cart     = require('../../utils/cart');
const config   = require('../../utils/config');
const delivery = require('../../utils/delivery');
const freshEta = require('../../utils/fresh-eta');
const { promoCardsToShow } = require('../../utils/promo-cards');

// §296 — tuck the promo row away only when the product list would still
// scroll with it gone. Tucking grows the list's box by the row's height; on a
// short list that clamps the scroll back to 0, which brings the row back,
// which shrinks the box again — a flicker loop. The row is at most 520rpx
// (≈300px on the widest phones), so this much spare scroll is enough.
const PROMO_TUCK_ROOM_PX = 320;

// §296 — where a promo card's link goes from the Shop tab. The same targets
// the editor's link picker offers and Home routes (pages/home/home.js
// routeTarget); pages that are plain navigateTo destinations are listed here.
const PROMO_NAV_PAGES = [
  'membership', 'about', 'coupons', 'wallet', 'voting', 'faq', 'affiliate',
  'topup', 'favorites', 'orders', 'leaderboard', 'notifications',
];

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

// Effective (display) price of a product row: the flash/effective price when
// one is active, otherwise the regular sell price. Shared by the variant
// collapse + size-picker so cards and the picker price siblings identically.
function _effPrice(p) {
  const regular = Number(p.price ?? p.sell_price) || 0;
  const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
  return eff;
}

// Stock verdict for one catalog row, shared by the cards and the quick-add size
// picker so both read a sold-out product the same way the PDP does.
//   out      → no stock (supplier-direct rows are out only when paused).
//   preorder → out, but the operator lets out-of-city shoppers reserve it
//              (oos_preorder from the server). Stays orderable + tappable.
//   soldOut  → hard out: dead SOLD OUT pill, no + button, picker row disabled.
// `onLocalRun` is the shopper's own delivery context (utils/delivery): a
// pre-order is for orders we ship, so for an address the same-day local run
// serves — where the checkout gates stock hard — a reservable row is simply
// sold out. Nothing pre-orderable is ever offered to a shopper on that run,
// so the pill can't promise what the checkout will refuse.
//
// ONE exception, and it exists because the promise became keepable: a FRESH
// meal the server dated (`local_fresh_date` — the day the kitchen makes the
// next batch). For that row the run is no longer a reason to say no, so the
// pill offers it and the checkout accepts it, parking the order on that batch.
// The condition stays "never promise what checkout refuses": the same date
// drives the calendar floor and the checkout gate, so the three agree by
// construction. A row without the field — every grocery row, and every row
// when no schedule is configured — is dead on the run exactly as before.
function _stockState(p, onLocalRun) {
  const stock = p.stock == null ? null : Number(p.stock);
  const out = p.ship_from_supplier ? !!p.supplier_paused : (stock != null && stock <= 0);
  const preorder = out && !p.ship_from_supplier && !!p.oos_preorder
        && (!onLocalRun || !!p.local_fresh_date || !!p.oos_preorder_local);
  /* §80 follow-up — is the batch behind this row TODAY'S? Returned BESIDE
     `preorder` and never folded into it: `preorder` is what keeps the card
     ALIVE (soldOut is its inverse), so turning it off to silence a band would
     kill the row instead of quieting it. What today changes is only whether
     the band says anything — see preText where the rows are built.
     The server decides "today" (§82); a handset clock does not. */
  const today = preorder && !!onLocalRun && !!p.local_fresh_today;
  /* §108 — WHICH WORD this row gets, decided once here so the card band, the
     size sheet and the add toast cannot answer it differently (they did: the
     toast said "pre-order" to a Guangzhou shopper whose card said NEXT BATCH).
       ''         → says nothing: not reservable, or today's batch on the run
       'batch'    → a fresh meal not yet made → NEXT BATCH · 下批现做
       'preorder' → anything else reservable → PRE-ORDER · 可预订; a grocery row
                    names no batch, none being cooked for it. */
  const kind = (!preorder || today) ? '' : (p.is_batch_made ? 'batch' : 'preorder');
  return { out, preorder, today, kind, soldOut: out && !preorder, stock };
}

// How long a catalogue fetch waits before the page gives up and says so.
// Shorter than utils/api's 12s default ON PURPOSE, and only for the two browse
// reads below: a customer staring at grey placeholders has already decided the
// shop is broken long before twelve seconds are up, and the pane she lands on
// now offers her a retry, so giving up early costs her nothing and buys back
// four seconds of it. Checkout and every write keep the longer default — a
// slow payment must not be cut off to make a list feel quick.
const BROWSE_TIMEOUT_MS = 8000;

// §244 — the chips read the way the allergen card reads (§241): one MADE
// WITHOUT label, then bare names. "NUT FREE" promised zero nuts in a shared
// facility whose every product may carry traces. The keys are unchanged; the
// flag each one selects is the free_of token it names, "5 spice" with its
// space — the old '5spice' key matched no stored value, so that chip always
// came back empty. Only food is selected: non-food rows carry bulk flags.
const DIETARY_LABEL = { en: 'MADE WITHOUT', cn: '配方不含' };
const DIETARY_FILTERS = [
  { key: 'nuts',   flag: 'nuts',    en: 'NUTS',    cn: '坚果' },
  { key: 'soy',    flag: 'soy',     en: 'SOY',     cn: '大豆' },
  { key: 'gluten', flag: 'gluten',  en: 'GLUTEN',  cn: '麸质' },
  { key: '5spice', flag: '5 spice', en: '5-SPICE', cn: '五香' },
];
function madeWithout(p, key) {
  const f = DIETARY_FILTERS.find(x => x.key === key);
  if (!f) return true;
  if (p.is_food === false) return false;
  return String(p.free_of || '').split(/[,、，]/)
    .map(s => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .map(s => (s === '5spice' ? '5 spice' : s))
    .includes(f.flag);
}

const BADGE_FILTERS = [
  { key: 'NEW',  en: 'NEW',  cn: '新品' },
  { key: 'POP',  en: 'POP',  cn: '热门' },
  { key: 'SALE', en: 'SALE', cn: '特价' },
  { key: 'HOT',  en: 'HOT',  cn: '推荐' },
];

const SORT_OPTIONS = [
  { value: '',           en: 'FEATURED',   cn: '推荐' },
  { value: 'newest',     en: 'NEWEST',     cn: '最新' },
  { value: 'price_asc',  en: 'PRICE ↑',    cn: '价格 ↑' },
  { value: 'price_desc', en: 'PRICE ↓',    cn: '价格 ↓' },
  { value: 'popular',    en: 'POPULAR',    cn: '热门' },
];

function pickBadge(tags) {
  const t = String(tags || '').toLowerCase();
  if (/\bnew\b/.test(t))         return 'NEW';
  if (/\bpop|popular\b/.test(t)) return 'POP';
  if (/\bsale\b/.test(t))        return 'SALE';
  if (/\bhot\b/.test(t))         return 'HOT';
  return '';
}

// All four sit on the same sidebar body (rail + internal scroll) — grid-2col
// and grid-3col just swap the row list for a card grid inside it — so they
// all count as "list" layouts for scroll/measure/nav purposes. Only gallery
// keeps the older top-chips + page-scroll shell.
const LIST_LAYOUTS = ['list', 'list-compact', 'grid-2col', 'grid-3col'];
const VALID_LAYOUTS = ['list', 'list-compact', 'grid-2col', 'grid-3col', 'gallery', 'grid'];

// ⊞ grid-2col · ☰ list · ≡ list-compact · ⊟ grid-3col. Grid-2col is the
// default view here, so it leads the row — the first chip is the lit one
// on a first visit. (The website's SL_VIEWS in public/shop.html keeps its
// own order/default — 'list' first — so this no longer mirrors it 1:1.)
const LAYOUT_OPTIONS = [
  { key: 'grid-2col',    icon: '⊞',  en: 'Grid 2-col',          cn: '网格 2 列' },
  { key: 'list',         icon: '☰',  en: 'List with sidebar',  cn: '列表（侧栏）' },
  { key: 'list-compact', icon: '≡',  en: 'List compact',       cn: '列表（紧凑）' },
  { key: 'grid-3col',    icon: '⊟',  en: 'Grid 3-col',          cn: '网格 3 列' },
];

const LAYOUT_STORAGE_KEY = 'shop_layout_pref';

// How tall the sticky top bar is in pixels — used as the offset both
// when measuring "the next section reached the top" during scrolling AND
// when programmatically scrolling to a section so its header lands just
// below the sticky bar instead of behind it.
const STICKY_OFFSET_PX = 220;
const LIST_STICKY_OFFSET_PX = 24;

Page({
  data: {
    // sections = the 7 TOP categories (left-rail + scroll-sync anchors).
    // Each holds a `groups` array of subcategories rendered as visual
    // section headings in the right pane (subs are NOT separately tappable).
    // [{ id, name, label, groups: [{ id, label, items, countStr }] }]
    sections: [],
    visibleSections: [],     // what the right pane renders: all sections, or
                             // just the one drilled-into category
    _raw: [],
    categories: [],          // [{ id, name, label }] top categories (without ALL)
    activeCategory: '',      // '' = ALL / above all sections

    // Drill-in sidebar state (list layout). Tapping a top category with ≥2
    // subs flips the rail from top categories to that category's subs and
    // focuses the right pane on it; the back bar returns to all categories.
    // paneAnim arms the rail/chip/pane fold animations for the length of one
    // drill. It is FALSE on first render on purpose — see _pulsePaneAnim.
    paneAnim: false,
    drillTop: '',            // '' = top level; else name of the drilled top
    drillLabel: '',          // its display label (header under the back bar)
    subTabs: [],             // [{ id, label }] subcategory groups of the drill
    activeSub: '',           // active subgroup id ('' = ALL-of-category)
    backLabel: 'ALL CATEGORIES',

    activeDietary: '',
    activeBadge: '',
    inStockOnly: false,
    priceMin: '',
    priceMax: '',
    query: '',
    // §295 — search is a button until it is used. searchOpen is the box
    // shown by a tap; the WXML also keeps it open whenever `query` is set.
    searchOpen: false,
    searchFocus: false,
    // §296 — the promo_cards blocks of the editor's Shop landing page that
    // have something to show today, and whether the row is tucked away.
    promoBlocks: [],
    promoTucked: false,
    sortIndex: 0,
    lang: 'en',
    loading: true,
    totalCount: 0,

    layout: 'grid-2col',
    isListLayout: true,
    layoutLocked: false,
    layoutOptions: LAYOUT_OPTIONS.map(o => ({ ...o, label: o.en })),

    showSort: false,
    showDietary: true,
    showStockFilter: false,
    showBadgeFilter: false,
    showPriceFilter: false,
    showAnyFilter: true,
    hideOutOfStock: false,

    // Programmatic scroll: setting these triggers a scroll on the
    // matching scroll-view. We blank them after firing so the same
    // target can be picked again.
    scrollIntoListId: '',     // for the list-main scroll-view
    sidebarScrollId: '',      // auto-scroll the side panel to keep active visible
    activeChipId: '',         // auto-scroll the top chip row to keep active visible

    // Labels
    seeAll: 'ALL',
    searchLabel: 'Search',
    searchPlaceholder: 'Search the pantry…',
    listTitle: 'CATEGORIES',
    emptyTitle: 'No products yet.',
    emptySub: 'Publish products in the Roots admin to see them here.',
    // Label for the empty pane's retry button. Non-empty ONLY while that pane
    // is reporting a failed request, so the button can never appear under the
    // operator copy, where there is nothing to retry.
    emptyRetry: '',
    // True when the last refresh could not reach the catalogue at all — see
    // _emptyCopy for why the empty pane has to tell the two cases apart.
    loadError: false,
    sortLabels: SORT_OPTIONS.map(o => o.en),
    sortLabel: SORT_OPTIONS[0].en,
    inStockLabel: 'IN STOCK',
    priceFromLabel: '¥',
    oosLabel: 'SOLD OUT',
    preLabel: 'PRE-ORDER',
    dietaryFilters: DIETARY_FILTERS.map(f => ({ ...f, label: f.en })),
    dietaryLabel: DIETARY_LABEL.en,
    badgeFilters:   BADGE_FILTERS.map(b   => ({ ...b, label: b.en })),

    flyShow: false,
    flyImg: '',
    flyStartX: 0, flyStartY: 0, flyDx: 0, flyDy: 0,

    // Variant size-picker bottom sheet. Opened when tapping + on a card that
    // collapses ≥2 sibling products (same variant_group_id). Choosing an
    // option adds that specific sibling to the cart.
    vpShow: false,
    vpName: '',
    vpTitle: 'Choose a size',
    vpOptions: [],
  },

  onLoad() {
    const app = getApp();
    this._applyLang(app.globalData.lang);
    this._syncConfig();
    this._syncDelivery();
    this.refresh();
  },

  onShow() {
    const app = getApp();
    if (app.globalData.lang !== this.data.lang) {
      this._applyLang(app.globalData.lang);
      this.refresh();
    }
    this._syncConfig();
    // The shopper may have switched to (or away from) a Guangzhou address on
    // the address book since we last rendered — re-ask before they browse.
    this._syncDelivery();
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/shop/shop');
    // Honour a category deep-link handed off from the home page (a tapped
    // category tile). If sections are already loaded we apply it now;
    // otherwise refresh() applies it once they're built.
    this._applyPendingCategory();
  },

  // Is the shopper delivering inside Guangzhou? Drives whether a sold-out
  // reservable row may show PRE-ORDER (see _stockState). The answer arrives one
  // cached request after the first paint, so when it flips we re-render the
  // rows we already hold — no second catalog fetch.
  _syncDelivery() {
    delivery.load().then((onLocalRun) => {
      if (!!onLocalRun === !!this._onLocalRun) return;
      this._onLocalRun = !!onLocalRun;
      const raw = this.data._raw;
      if (raw && raw.length) this._renderRows(raw);
    }).catch((e) => console.warn('[shop] delivery sync failed:', e.message));
  },

  // Drill straight into the category the customer tapped on Home — the tile
  // lands them in that category's subcategory menu (the drilled rail), not
  // just scrolled to its section. The target name is stashed in globalData
  // because switchTab carries no params. No-op when nothing is pending or the
  // section hasn't loaded yet (refresh() retries once it builds them). A rare
  // single-group category isn't drillable, so it just scrolls to itself.
  _applyPendingCategory() {
    const app = getApp();
    const name = app.globalData && app.globalData.pendingCategory;
    if (!name) return;
    const section = (this.data.sections || []).find(s => s.name === name);
    if (!section) return;            // sections not built yet — refresh() retries
    app.globalData.pendingCategory = '';
    if (section.drillable) this.drillInto(name);
    else this.setCategory({ currentTarget: { dataset: { name } } });
  },

  // Page-level scroll: only used when the layout is grid/gallery (the
  // page itself scrolls then). For list layouts, scrolling happens inside
  // the list-main scroll-view and we handle it via bindscroll there.
  onPageScroll(e) {
    if (LIST_LAYOUTS.includes(this.data.layout)) return;
    // Drilled (grid/gallery) → track the active subcategory via the chips.
    if (this.data.drillTop) { this._updateActiveSubByScrollTop(e.scrollTop, STICKY_OFFSET_PX); return; }
    this._updateActiveByScrollTop(e.scrollTop, STICKY_OFFSET_PX);
  },

  _applyLang(L) {
    const sortLabels = SORT_OPTIONS.map(o => L === 'cn' ? o.cn : o.en);
    this.setData({
      lang: L,
      sortLabels,
      sortLabel: sortLabels[this.data.sortIndex] || sortLabels[0],
      layoutOptions: LAYOUT_OPTIONS.map(o => ({ ...o, label: L === 'cn' ? o.cn : o.en })),
      seeAll:            L === 'cn' ? '全部' : 'ALL',
      backLabel:         L === 'cn' ? '全部分类' : 'ALL CATEGORIES',
      // §295 — the search button's screen-reader label; copied whole from
      // the web shop's search button (public/shop.html).
      searchLabel:       L === 'cn' ? '搜索' : 'Search',
      searchPlaceholder: L === 'cn' ? '搜索…'  : 'Search the pantry…',
      listTitle:         L === 'cn' ? '分类' : 'CATEGORIES',
      inStockLabel:      L === 'cn' ? '有货' : 'IN STOCK',
      priceFromLabel:    L === 'cn' ? '价格' : '¥',
      oosLabel:          L === 'cn' ? '售罄' : 'SOLD OUT',
      preLabel:          L === 'cn' ? '可预订' : 'PRE-ORDER',
      ...this._emptyCopy(L, this.data.loadError, this._isNarrowed()),
      dietaryFilters: DIETARY_FILTERS.map(f => ({ ...f, label: L === 'cn' ? f.cn : f.en })),
      dietaryLabel: L === 'cn' ? DIETARY_LABEL.cn : DIETARY_LABEL.en,
      badgeFilters:   BADGE_FILTERS.map(b   => ({ ...b, label: L === 'cn' ? b.cn : b.en })),
    });
  },

  async _syncConfig() {
    const app = getApp();
    let cfg = app.globalData.config;
    if (!cfg) {
      try { cfg = await config.load(); app.globalData.config = cfg; } catch {}
    }
    const s = (cfg && cfg.shop) || {};

    const adminLayout = (s.layout === 'grid' ? 'grid-2col' : s.layout) || 'grid-2col';
    const layoutLocked = !!s.lockLayout;
    let layout = adminLayout;
    if (!layoutLocked) {
      try {
        const saved = wx.getStorageSync(LAYOUT_STORAGE_KEY);
        if (saved && VALID_LAYOUTS.includes(saved)) layout = saved;
      } catch {}
    }
    if (!VALID_LAYOUTS.includes(layout)) layout = 'grid-2col';
    if (layout === 'grid') layout = 'grid-2col';
    const isListLayout = LIST_LAYOUTS.includes(layout);

    let sortIndex = 0;
    if (s.defaultSort) {
      const i = SORT_OPTIONS.findIndex(o => o.value === s.defaultSort);
      if (i >= 0) sortIndex = i;
    }

    const showSort         = !!s.showSort;
    const showDietary      = s.showDietary !== false;
    const showStockFilter  = !!s.showStockFilter;
    const showBadgeFilter  = !!s.showBadgeFilter;
    const showPriceFilter  = !!s.showPriceFilter;
    const showAnyFilter    = showSort || showDietary || showStockFilter || showBadgeFilter || showPriceFilter;

    // §296 — only the promo_cards blocks of the Shop landing page come to the
    // tab; the page's other blocks still open only from a link to it. A block
    // with nothing to show today is dropped here, so no empty row is drawn.
    const promoBlocks = config.forMiniApp(cfg && cfg.categories && cfg.categories.layout)
      .filter(b => b.type === 'promo_cards' && promoCardsToShow(b.cards).length > 0);

    this.setData({
      promoBlocks,
      layout, isListLayout, layoutLocked,
      showSort, showDietary, showStockFilter, showBadgeFilter, showPriceFilter, showAnyFilter,
      hideOutOfStock: !!s.hideOutOfStock,
      sortIndex,
      sortLabel: this.data.sortLabels[sortIndex] || this.data.sortLabels[0],
    });
  },

  setLayout(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || !VALID_LAYOUTS.includes(key)) return;
    if (key === this.data.layout) return;
    const isListLayout = LIST_LAYOUTS.includes(key);
    // Drill works in every layout (sidebar rail ⇄ chip row), so it carries
    // across a layout switch — just re-measure for the new view. The promo
    // row comes back: gallery never tucks it, and a rail layout starts at top.
    this.setData({ layout: key, isListLayout, promoTucked: false });
    try { wx.setStorageSync(LAYOUT_STORAGE_KEY, key); } catch {}
    setTimeout(() => {
      if (this.data.drillTop) this._measureGroups(); else this._measureSections();
    }, 200);
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      // No category filter at the API — we group client-side. Pull the full
      // catalog (cap raised server-side to 500) so every top/sub renders.
      // slim=1 → card-only columns + downscaled thumbnail image URLs (the grid
      // never renders descriptions/taglines or full-res photos). Big win on slow
      // connections: ~350 KB → ~115 KB JSON and ~76 KB → ~kB per card image.
      const params = ['limit=500', 'slim=1'];
      if (this.data.query)          params.push('q=' + encodeURIComponent(this.data.query));
      const sortVal = SORT_OPTIONS[this.data.sortIndex]?.value;
      if (sortVal)                  params.push('sort=' + sortVal);
      const qs = '?' + params.join('&');

      // A dropped request is not an empty catalogue, and the empty pane has to
      // be able to say which of the two happened.
      //
      // BOTH reads count, which is not obvious and was nearly got wrong here.
      // The tree looks like a grouping aid the page could do without — but
      // _buildSections walks the TREE and indexes products into it, so a
      // product whose top_category matches no top is dropped, and only a
      // product with no top_category at all survives in "Other". Lose the tree
      // and a catalogue that arrived intact renders as nothing: the same blank
      // pane, by a different route. From the customer's seat the two are one
      // event, so they get one verdict.
      //
      // Deliberately NOT retried here, unlike the product page and the config
      // fetch. This pull is the whole catalogue — 500 rows — and the customer
      // who needs this branch is by definition the one on the worst connection;
      // a second automatic attempt doubles her wait on grey. She gets the retry
      // as a button instead: same recovery, her timing, and it tells her
      // something is happening.
      let loadError = false;
      const dropped = () => { loadError = true; return []; };
      const [prods, treeResp] = await Promise.all([
        api.get('/api/retail/products' + qs, { timeout: BROWSE_TIMEOUT_MS }).catch(dropped),
        api.get('/api/retail/category-tree', { timeout: BROWSE_TIMEOUT_MS }).catch(dropped),
      ]);

      let raw = (Array.isArray(prods) ? prods : prods?.data || []);

      // Client-side filters
      if (this.data.activeDietary) {
        raw = raw.filter(p => madeWithout(p, this.data.activeDietary));
      }
      if (this.data.activeBadge) {
        raw = raw.filter(p => pickBadge(p.tags) === this.data.activeBadge);
      }
      const pmin = Number(this.data.priceMin) || 0;
      const pmax = Number(this.data.priceMax) || 0;
      if (pmin > 0 || pmax > 0) {
        raw = raw.filter(p => {
          const v = Number(p.price ?? p.sell_price) || 0;
          if (pmin > 0 && v < pmin) return false;
          if (pmax > 0 && v > pmax) return false;
          return true;
        });
      }
      const inStockOnly = this.data.inStockOnly || this.data.hideOutOfStock;
      if (inStockOnly) {
        raw = raw.filter(p => p.stock == null || Number(p.stock) > 0);
      }

      this._tree = (Array.isArray(treeResp) ? treeResp : treeResp?.data || []);
      this._renderRows(raw, loadError);
    } catch (e) {
      console.warn('[shop] refresh failed:', e.message);
      // Nothing rendered, so the pane about to show is the empty one. Say the
      // request failed rather than let it read as a bare catalogue.
      this.setData({
        loading: false,
        loadError: true,
        ...this._emptyCopy(this.data.lang, true, this._isNarrowed()),
      });
    }
  },

  // The empty pane says two different things and the difference is the whole
  // point of this function. A catalogue with nothing in it is an operator's job
  // — "publish products in the Roots admin" — while a request that never landed
  // is the customer's network. Showing the operator sentence for a dropped
  // request tells a customer the shop is empty when it is full, and instructs
  // her to go and publish products in an admin she cannot open. That is what a
  // customer on a weak cross-border connection used to be shown here; it reads
  // as "they have nothing to sell", and she closes the app instead of retrying.
  //
  // Every string is copied character-for-character from a live pair: the two
  // catalogue lines are this page's own, and the three network lines are the
  // home page's (home.wxml). Nothing is composed, so
  // docs/tacet-delivery-vocabulary.md has nothing to declare.
  _emptyCopy(L, loadError, narrowed) {
    if (loadError) {
      return {
        emptyTitle: L === 'cn' ? '网络连接失败' : 'No connection',
        emptySub:   L === 'cn' ? '请检查网络后重试。' : 'Check your network and try again.',
        emptyRetry: L === 'cn' ? '重试' : 'TRY AGAIN',
      };
    }
    // Narrowed to nothing. The catalogue is fine and the request was fine — she
    // typed or tapped her way to a set with no members, so neither of the other
    // two sentences is true. Telling her to publish products is the same lie
    // the network case was, just reached by a search box.
    //
    // No subtitle and no button, deliberately: the copy below is lifted whole
    // from pages/faq/faq.wxml, which already shows it to customers under the
    // same .empty-title, and there is no live pair for "clear the filters" to
    // copy. The control that got her here — the chip, the search box — is still
    // on screen above the pane, so the way out is visible without minting one.
    if (narrowed) {
      return {
        emptyTitle: L === 'cn' ? '没有匹配。' : 'No matches.',
        emptySub:   '',
        emptyRetry: '',
      };
    }
    return {
      emptyTitle: L === 'cn' ? '暂无商品' : 'No products yet.',
      emptySub:   L === 'cn' ? '请在管理后台发布商品' : 'Publish products in the Roots admin to see them here.',
      emptyRetry: '',
    };
  },

  // Is anything narrowing the catalogue right now? Kept beside the filters it
  // reads so a new filter that forgets this line shows the wrong empty pane —
  // the failure mode this whole function exists to prevent. The drill state is
  // NOT here on purpose: it narrows visibleSections, never `sections`, so it
  // can't produce the empty pane.
  _isNarrowed() {
    const d = this.data;
    return !!(d.query || d.activeDietary || d.activeBadge
              || Number(d.priceMin) > 0 || Number(d.priceMax) > 0
              || d.inStockOnly || d.hideOutOfStock);
  },

  // Empty-pane retry button. Mirrors the home page's: a customer tapping it
  // means now, so it goes straight back out rather than trusting any cache.
  retry() {
    if (this.data.loading) return;
    this.refresh();
  },

  // Turn the last-fetched rows into the rendered sections. Split out of
  // refresh() so a late-arriving delivery verdict (_syncDelivery) can re-render
  // the same rows — the PRE-ORDER pills depend on it — without a second fetch.
  // loadError defaults to the standing verdict so the re-render _syncDelivery
  // fires (which passes rows it already holds, never a fresh fetch) cannot
  // silently clear it.
  _renderRows(raw, loadError = this.data.loadError) {
    const L = this.data.lang;
    const tree = this._tree || [];

    // Collapse variant siblings (same variant_group_id) into one
    // representative card. Standalone products pass through untouched.
    // _memberMap lets addToCart find a card's siblings for the size picker.
    const display = this._collapseVariants(raw);
    this._memberMap = {};
    for (const p of display) if (p._members) this._memberMap[p.id] = p._members;

    const sections = this._buildSections(display, tree, L);
    const categories = sections.map(s => ({ id: s.id, name: s.name, label: s.label }));
    const totalCount = sections.reduce(
      (sum, s) => sum + s.groups.reduce((n, g) => n + g.items.length, 0), 0);

    // Preserve an active drill across a refresh (e.g. a dietary filter
    // applied while drilled in). Drop it if that category no longer has
    // any products after the new filter.
    let { drillTop, drillLabel, subTabs } = this.data;
    let visibleSections = sections;
    if (drillTop) {
      const sec = sections.find(s => s.name === drillTop);
      if (sec) {
        visibleSections = [sec];
        subTabs = sec.groups.map(g => ({ id: g.id, label: g.label }));
        drillLabel = sec.label;
      } else {
        drillTop = ''; drillLabel = ''; subTabs = [];
      }
    }

    this.setData({
      _raw: raw,
      sections,
      visibleSections,
      categories,
      totalCount,
      drillTop, drillLabel, subTabs,
      loadError,
      ...this._emptyCopy(L, loadError, this._isNarrowed()),
      loading: false,
    });
    // Measure offsets for the active mode (sub anchors when drilled, top
    // sections otherwise) so onScroll can find the active one, then honour
    // any pending category deep-link now that sections + offsets exist.
    setTimeout(() => {
      if (this.data.drillTop) this._measureGroups(); else this._measureSections();
      this._applyPendingCategory();
    }, 200);
  },

  // Build top-category sections from the category tree. Each section is a
  // top category (left-rail entry + scroll anchor) holding a `groups` array
  // of subcategories — each group renders a visual heading + its product
  // rows. Tops/subs with no products are dropped; products missing a
  // top_category fall into a trailing "Other" section so nothing vanishes.
  _buildSections(rawProducts, tree, L) {
    const pad = n => (n < 10 ? '0' + n : String(n));

    // index products: top → sub → [products]
    const byTop = new Map();
    const orphans = [];
    for (const p of rawProducts) {
      const top = p.top_category;
      if (!top) { orphans.push(p); continue; }
      if (!byTop.has(top)) byTop.set(top, new Map());
      const subMap = byTop.get(top);
      const key = p.subcategory || '__nosub__';
      if (!subMap.has(key)) subMap.set(key, []);
      subMap.get(key).push(p);
    }

    const sections = [];
    (tree || []).forEach((top, ti) => {
      const subMap = byTop.get(top.name);
      if (!subMap) return;
      const groups = [];
      let gi = 0;
      // ordered subs from the tree first…
      for (const sub of (top.subs || [])) {
        const items = subMap.get(sub.name);
        if (!items || !items.length) continue;
        const rows = this._toRows(items, L);
        groups.push({
          id: `top${ti}-g${gi++}`,
          label: ((L === 'cn' ? sub.name_cn : sub.name) || sub.name).toUpperCase(),
          items: rows,
          countStr: pad(rows.length),
        });
        subMap.delete(sub.name);
      }
      // …then any leftover subs not declared in the tree (incl. blank sub)
      for (const [key, items] of subMap) {
        if (!items.length) continue;
        const rows = this._toRows(items, L);
        groups.push({
          id: `top${ti}-g${gi++}`,
          label: key === '__nosub__' ? (L === 'cn' ? '更多' : 'MORE') : key.toUpperCase(),
          items: rows,
          countStr: pad(rows.length),
        });
      }
      if (!groups.length) return;
      sections.push({
        id: `top${ti}`,
        name: top.name,
        label: ((L === 'cn' ? top.name_cn : top.name) || top.name).toUpperCase(),
        // Only categories with ≥2 subcategories are worth drilling into — a
        // single-group top just scrolls (the chevron is its tell).
        drillable: groups.length >= 2,
        groups,
      });
    });

    if (orphans.length) {
      const rows = this._toRows(orphans, L);
      sections.push({
        id: 'other',
        name: '__other__',
        label: L === 'cn' ? '其他' : 'OTHER',
        drillable: false,
        groups: [{ id: 'other-g0', label: '', items: rows, countStr: pad(rows.length) }],
      });
    }

    return sections;
  },

  _toRows(products, L) {
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    const onLocalRun = !!this._onLocalRun;
    // §195 — read ONCE per pass, not per row. It is the same object for every
    // row on the page (a shop-wide setting, not a product one), and a row that
    // read it separately could only ever differ from its neighbours by being
    // wrong. Also keeps the config module out of the row loop entirely.
    const preWin = config.get('notice.preorder', null);
    return products.map(p => {
      const members = p._members || null;
      const regular = Number(p.price ?? p.sell_price) || 0;
      const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
      const isFlash = !members && !!p.is_on_flash && eff < regular;

      let price, priceWas = '', pricePrefix = '', outOfStock, preorder, preToday, soldUnits, subline;
      if (members) {
        // Collapsed variant card. `price` is just the lowest amount (e.g.
        // "¥89") so it stays in League Gothic at the cards' big price size;
        // the "from"/"起" qualifier rides above as a smaller caption
        // (.row-price-prefix etc.) so the number column doesn't blow out
        // and wrap into the title — every layout looks like "from / ¥89"
        // stacked, not "from ¥89" mashed on one line. Sold-out only when
        // ALL sizes are out; sold count sums across the group; per-size
        // weight subline is dropped (sizes differ, picker shows them).
        const prices = members.map(_effPrice).filter(v => v > 0);
        const minP = prices.length ? Math.min(...prices) : 0;
        const allSame = prices.length > 0 && prices.every(v => v === minP);
        price = minP > 0 ? money(minP) : '—';
        pricePrefix = (minP > 0 && !allSame) ? (L === 'cn' ? '起' : 'from') : '';
        // Supplier-direct members carry no stock of ours — out only if paused.
        // A size that's out but pre-orderable keeps the card orderable: the
        // group only goes dead when EVERY size is hard-out, and the card shows
        // PRE-ORDER when the only remaining sizes are reservable ones.
        const states = members.map(m => _stockState(m, onLocalRun));
        outOfStock = states.every(s => s.soldOut);
        preorder = !outOfStock && states.every(s => s.out) && states.some(s => s.preorder);
        // Silent only when EVERY size still orderable is made today. One size
        // waiting on a later batch is a promise the card still has to name.
        preToday = preorder && states.filter(s => s.preorder).every(s => s.today);
        soldUnits = members.reduce((s, m) => s + (Number(m.units_sold) || 0), 0);
        subline = '';
      } else {
        const st = _stockState(p, onLocalRun);
        outOfStock = st.soldOut;
        preorder = st.preorder;
        preToday = st.today;
        // All-time units sold (server min-gates this to 0 below the badge
        // threshold), shown as a small "X SOLD" popularity caption on the card.
        soldUnits = Number(p.units_sold) || 0;
        price = eff > 0 ? money(eff) : '—';
        // Was-price: flash strikethrough, or a compare-at "was" when set higher
        // than the live price (the card's SALE badge already flags the deal).
        const cmp = Number(p.compare_at_price) || 0;
        const wasN = isFlash ? regular : (cmp > eff && eff > 0 ? cmp : 0);
        priceWas = wasN > 0 ? money(wasN) : '';
        subline = (p.size || '').toString().trim();
      }

      return {
        id: p.id,
        name: lang.pick(p.name_en, p.name_cn, L),
        subline,
        badge: pickBadge(p.tags),
        soldCaption: soldUnits > 0 ? (L === 'cn' ? `已售 ${soldUnits}` : `${soldUnits} SOLD`) : '',
        outOfStock,
        preorder,
        // Band text for a reservable (out-but-orderable) row. A meal we cook
        // in runs says NEXT BATCH; anything else says PRE-ORDER, the one word
        // every browse surface now uses for this state.
        //
        // §195 RETIRED `SHIPS SOON · 现订现发` FROM THE BAND, which this card
        // and the web card were the last two surfaces still drawing. The PDP,
        // its button, its size rows and favourites had said PRE-ORDER all
        // along, so a shopper tapping this card watched the word change under
        // them. The promise-vs-mechanism argument that chose SHIPS SOON is not
        // overturned so much as outvoted: it also fought the window below,
        // since "SHIPS SOON · 2-4 DAYS" says soon and then says how long.
        // …and NOTHING at all when that batch is today's: the row is orderable
        // now, the kitchen serves it inside the customer's own window, and a
        // band promising a future batch would be describing a wait that is not
        // happening (§80).
        // §170 appends WHEN it arrives — the make day for a shopper the local
        // run serves, the day after for a couriered order. The server settled
        // both dates; utils/fresh-eta picks between them and does the wording.
        // …and §195 gives the grocery row the other appender: it still names
        // no batch and still gets nothing from withFreshArrival, but it can
        // name the operator's restock window. Unset → the bare word, as before.
        preText: preToday ? ''
          : p.is_batch_made
            ? freshEta.withFreshArrival(L === 'cn' ? '下批现做' : 'NEXT BATCH', p, onLocalRun, L)
            : freshEta.withRestockWindow(L === 'cn' ? '可预订' : 'PRE-ORDER', preWin, L),
        // image_data may now be a streamed-image URL (/api/retail/products/:id/
        // image) since the list omits inline base64 — absUrl() resolves it
        // against the API host. data: URIs and absolute URLs pass through.
        image: absUrl(p.image_url) || absUrl(p.image_data) || '',
        price,
        priceWas,
        pricePrefix,
        isFlash,
        hasVariants: !!members,
        variantHint: members
          ? (L === 'cn' ? `${members.length} 规格` : `${members.length} sizes`)
          : '',
      };
    });
  },

  // Group products by variant_group_id and collapse each group (≥2 members)
  // into a single representative card. The representative is the group owner
  // (id === variant_group_id) when present, otherwise the first member.
  // Members are stashed on `_members` in the operator's chosen order
  // (variant_sort, set by drag-to-reorder in the backend) for the picker.
  // Standalone products — and groups that survive filtering with only one
  // member — pass through unchanged, preserving the server's sort order.
  _collapseVariants(raw) {
    const groups = new Map();
    for (const p of raw) {
      if (!p.variant_group_id) continue;
      if (!groups.has(p.variant_group_id)) groups.set(p.variant_group_id, []);
      groups.get(p.variant_group_id).push(p);
    }
    const emitted = new Set();
    const out = [];
    for (const p of raw) {
      const gid = p.variant_group_id;
      const members = gid ? groups.get(gid) : null;
      if (!members || members.length < 2) { out.push(p); continue; }
      if (emitted.has(gid)) continue;
      emitted.add(gid);
      const sorted = members.slice().sort((a, b) =>
        ((a.variant_sort ?? 0) - (b.variant_sort ?? 0)) ||
        String(a.variant_label || '').localeCompare(String(b.variant_label || '')) ||
        (a.id - b.id));
      const rep = sorted.find(m => m.id === gid) || sorted[0];
      out.push({ ...rep, _members: sorted });
    }
    return out;
  },

  // Measure each section header's absolute top offset (relative to the
  // top of the scroll container) so onScroll can pick the active one
  // without re-querying for every scroll event.
  _measureSections() {
    if (!this.data.sections.length) { this._sectionOffsets = []; return; }
    const isList = LIST_LAYOUTS.includes(this.data.layout);
    const q = wx.createSelectorQuery().in(this);
    this.data.sections.forEach(s => q.select('#' + s.id).boundingClientRect());
    if (isList) {
      q.select('.list-main').scrollOffset();
      q.select('.list-main').boundingClientRect();
    } else {
      q.selectViewport().scrollOffset();
    }
    q.exec((res) => {
      if (!res) return;
      const rects = res.slice(0, this.data.sections.length);
      const tail = res.slice(this.data.sections.length);
      let currentScroll = 0;
      let containerTop = 0;
      if (isList) {
        currentScroll = tail[0]?.scrollTop || 0;
        containerTop  = tail[1]?.top       || 0;
        // Reading line for active-category detection lives ~1/3 down the
        // list viewport (see onListScroll) so the highlight tracks the
        // section dominating the upper view, not just the literal top pixel.
        this._listViewportH = tail[1]?.height || 0;
      } else {
        currentScroll = tail[0]?.scrollTop || 0;
      }
      this._sectionOffsets = this.data.sections.map((s, i) => {
        const r = rects[i];
        if (!r) return { id: s.id, name: s.name, top: 0 };
        // Section top relative to the scroll container's content origin:
        //   absolute_top_in_content = (rect.top - container.top) + container.scrollTop
        const top = (r.top - containerTop) + currentScroll;
        return { id: s.id, name: s.name, top };
      });
    });
  },

  // Drilled mode: measure each subcategory group's offset inside the single
  // rendered section so scrolling highlights the matching sub-rail entry
  // (mirrors _measureSections, one level deeper).
  _measureGroups() {
    if (!this.data.drillTop) { this._groupOffsets = []; return; }
    const sec = this.data.sections.find(s => s.name === this.data.drillTop);
    if (!sec || !sec.groups.length) { this._groupOffsets = []; return; }
    const isList = LIST_LAYOUTS.includes(this.data.layout);
    const q = wx.createSelectorQuery().in(this);
    sec.groups.forEach(g => q.select('#g-' + g.id).boundingClientRect());
    if (isList) {
      q.select('.list-main').scrollOffset();
      q.select('.list-main').boundingClientRect();
    } else {
      q.selectViewport().scrollOffset();
    }
    q.exec((res) => {
      if (!res) return;
      const n = sec.groups.length;
      const rects = res.slice(0, n);
      const tail = res.slice(n);
      const currentScroll = tail[0]?.scrollTop || 0;
      const containerTop  = isList ? (tail[1]?.top || 0) : 0;
      if (isList) this._listViewportH = tail[1]?.height || 0;
      this._groupOffsets = sec.groups.map((g, i) => {
        const r = rects[i];
        if (!r) return { id: g.id, top: 0 };
        return { id: g.id, top: (r.top - containerTop) + currentScroll };
      });
    });
  },

  // Pick the active section given a scroll position. Threshold is the
  // y-coordinate inside the scroll container that we consider "the top
  // edge" — i.e. the height of the sticky bar.
  _updateActiveByScrollTop(scrollTop, threshold) {
    if (this._suppressScrollUntil && Date.now() < this._suppressScrollUntil) return;
    if (!this._sectionOffsets || !this._sectionOffsets.length) return;
    const cutoff = scrollTop + threshold;
    // If we're above the first section, no category is active
    if (cutoff < this._sectionOffsets[0].top) {
      if (this.data.activeCategory !== '') this._setActive('');
      return;
    }
    let activeName = this._sectionOffsets[0].name;
    for (const s of this._sectionOffsets) {
      if (s.top <= cutoff) activeName = s.name;
      else break;
    }
    if (activeName !== this.data.activeCategory) this._setActive(activeName);
  },

  // Bound to the list-main scroll-view's bindscroll. Throttled implicitly
  // since setData inside _updateActive only fires on category transitions.
  onListScroll(e) {
    const st = e.detail.scrollTop;
    if (this.data.promoBlocks.length) this._tuckPromos(st, e.detail.scrollHeight);
    // Drilled in → track the active subcategory instead of the top category.
    if (this.data.drillTop) {
      const h = this._listViewportH || 0;
      const threshold = h > 0 ? Math.round(h * 0.3) : LIST_STICKY_OFFSET_PX;
      this._updateActiveSubByScrollTop(st, threshold);
      return;
    }
    // At the very top, keep "ALL" active (the sidebar's default tab).
    if (st <= 2) {
      if (this.data.activeCategory !== '') this._setActive('');
      return;
    }
    // Otherwise use a reading line ~1/3 down the list viewport so the
    // highlighted category matches the section filling the upper view —
    // short sections (1–2 products) no longer leave the highlight a
    // category behind what's on screen. Falls back to the fixed offset
    // until the viewport height has been measured.
    const h = this._listViewportH || 0;
    const threshold = h > 0 ? Math.round(h * 0.3) : LIST_STICKY_OFFSET_PX;
    this._updateActiveByScrollTop(st, threshold);
  },

  // §296 — the promo row tucks away once the rail layout's list is scrolled
  // past a few pixels, and comes back at the very top. The two thresholds
  // differ on purpose (24 to tuck, 2 to return) so a finger resting near the
  // top does not flap it. Only called from onListScroll, so gallery (page
  // scroll, row scrolls off by itself) never tucks.
  _tuckPromos(scrollTop, scrollHeight) {
    const tucked = !!this.data.promoTucked;
    let next = tucked;
    if (!tucked && scrollTop > 24) {
      const view = this._listViewportH || 0;
      const room = (scrollHeight && view) ? scrollHeight - view : Infinity;
      if (room > PROMO_TUCK_ROOM_PX) next = true;
    } else if (tucked && scrollTop <= 2) {
      next = false;
    }
    if (next === tucked) return;
    this.setData({ promoTucked: next });
    // The list's box changed height once the 0.25s transition ends; the
    // offsets inside it did not, but the viewport height the reading line
    // uses did.
    if (this._promoMeasureT) clearTimeout(this._promoMeasureT);
    this._promoMeasureT = setTimeout(() => {
      this._promoMeasureT = null;
      if (this.data.drillTop) this._measureGroups(); else this._measureSections();
    }, 300);
  },

  // §296 — a promo card was tapped (bubbled up by block-renderer).
  onPromoCta(e) {
    this._routePromoTarget((e && e.detail && e.detail.target) || '');
  },
  // The link picker's targets, from the Shop tab. A category link stays on
  // this tab and opens that category the way a Home tile does; `shop` goes
  // back to the top of the list.
  _routePromoTarget(t) {
    if (!t) return;
    if (t === 'shop') return this.setCategory({ currentTarget: { dataset: { name: '' } } });
    if (t.startsWith('category:')) {
      const id = t.slice('category:'.length);
      const node = (this._tree || []).find(n => String(n.id) === id);
      if (!node) return;
      getApp().globalData.pendingCategory = node.name;
      return this._applyPendingCategory();
    }
    if (t.startsWith('product:')) return wx.navigateTo({ url: '/pages/product/product?id=' + t.split(':')[1] });
    if (t === 'home' || t === 'cart' || t === 'me') return wx.switchTab({ url: '/pages/' + t + '/' + t });
    if (t === 'promotions' || t === 'categories') return wx.navigateTo({ url: '/pages/layout/layout?page=' + t });
    if (PROMO_NAV_PAGES.includes(t)) return wx.navigateTo({ url: '/pages/' + t + '/' + t });
  },

  _setActive(name) {
    const sec = name ? this.data.sections.find(x => x.name === name) : null;
    this.setData({
      activeCategory: name,
      sidebarScrollId: sec ? 's-' + sec.id : 's-top-anchor',
      activeChipId:    sec ? 'chip-' + sec.id : 'chip-all',
    });
  },

  // Drilled counterpart of _updateActiveByScrollTop: highlights the
  // subcategory whose heading currently dominates the upper viewport and
  // keeps the (possibly tall) sub-rail scrolled so it stays in view.
  // Highlights the active subcategory for the current scroll position and
  // keeps the active entry in view in BOTH navigators (list sub-rail via
  // sidebarScrollId, grid/gallery chips via activeChipId) — only the
  // mounted one actually scrolls; the other target is harmlessly absent.
  _updateActiveSubByScrollTop(scrollTop, threshold) {
    if (this._suppressScrollUntil && Date.now() < this._suppressScrollUntil) return;
    if (!this._groupOffsets || !this._groupOffsets.length) return;
    const cutoff = scrollTop + threshold;
    if (scrollTop <= 2 || cutoff < this._groupOffsets[0].top) {
      if (this.data.activeSub !== '') {
        this.setData({ activeSub: '', sidebarScrollId: 'sub-top', activeChipId: 'chip-back' });
      }
      return;
    }
    let activeId = this._groupOffsets[0].id;
    for (const g of this._groupOffsets) {
      if (g.top <= cutoff) activeId = g.id;
      else break;
    }
    if (activeId !== this.data.activeSub) {
      this.setData({
        activeSub: activeId,
        sidebarScrollId: 'sub-' + activeId,
        activeChipId: 'chip-' + activeId,
      });
    }
  },

  // ── Drill-in sidebar ──────────────────────────────────────────
  // Tap on a top-category tab. Categories with ≥2 subs flip the rail to
  // their subcategories; a rare single-group top just scrolls to itself.
  onTopTab(e) {
    const name = e.currentTarget.dataset.name || '';
    const sec = this.data.sections.find(s => s.name === name);
    if (sec && sec.drillable) this.drillInto(name);
    else this.setCategory(e);
  },

  // Arm the fold/fade animations for exactly one drill, then take them away.
  //
  // chipIn, railFold and shopPaneFade were all written for the drill swap — they
  // make moving between a category and its subs read as one continuous fold.
  // All three use fill-mode `both`, which holds the from-frame (opacity 0)
  // BEFORE the animation starts. That is correct for a transition and wrong for
  // a first paint: an animation that never starts leaves the element with its
  // full layout box painting nothing — a blank page with no error anywhere.
  //
  // That is what shipped. The selectors were unconditional, so every first
  // render ran a transition animation it never needed, and on a real handset
  // (where the animation did not start) it left the whole catalogue invisible
  // while every box measured correctly.
  //
  // Gating on this flag means first paint runs no animation at all and cannot
  // fail that way. A drill still animates; if one ever fails to start there,
  // the flag clears and the rows snap visible rather than staying lost.
  _pulsePaneAnim() {
    if (this._paneAnimT) clearTimeout(this._paneAnimT);
    // Longest stagger (0.49s) + duration (0.3s) = 0.79s. Held to 1s so a slow
    // device can't get the class pulled out from under a still-running fold and
    // snap the rows to their end state. Overshooting is free — a highlight
    // change doesn't re-mount the rows, so the animation never replays.
    this._paneAnimT = setTimeout(() => {
      this._paneAnimT = null;
      this.setData({ paneAnim: false });
    }, 1000);
  },

  // Flip the rail from top categories → this category's subcategories and
  // focus the right pane on it. The right pane filters to just this section
  // so the sub-rail maps 1:1 to what's on screen (no cross-category scroll).
  drillInto(name) {
    const section = this.data.sections.find(s => s.name === name);
    if (!section) return;
    const isList = LIST_LAYOUTS.includes(this.data.layout);
    const subTabs = section.groups.map(g => ({ id: g.id, label: g.label }));
    this._suppressScrollUntil = Date.now() + 600;
    // paneAnim rides in the SAME setData as the new content so the class and
    // the nodes it animates mount in one render pass — arming it separately
    // would land after the rows already exist and never play.
    this.setData({
      paneAnim: true,
      drillTop: name,
      drillLabel: section.label,
      subTabs,
      activeSub: '',
      activeCategory: name,
      visibleSections: [section],
      sidebarScrollId: 'sub-top',   // list rail → top (back bar)
      activeChipId: 'chip-back',    // grid chips → start (back chip)
    });
    this._pulsePaneAnim();
    // Once the filtered view has rendered: jump it to the top + measure the
    // sub anchors so scroll-sync works.
    setTimeout(() => {
      if (isList) {
        this.setData({ scrollIntoListId: 'top-anchor' });
        setTimeout(() => this.setData({ scrollIntoListId: '' }), 400);
      } else {
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });
      }
      this._measureGroups();
    }, 120);
    // Re-measure once more after images have had time to load so the
    // grid/gallery group offsets settle (heights shift as photos arrive).
    setTimeout(() => this._measureGroups(), 600);
  },

  // The back bar: zoom back out to all categories and land on the one we
  // were just in, so "back" feels like stepping up a level, not a reset.
  drillBack() {
    const prev = this.data.drillTop;
    const isList = LIST_LAYOUTS.includes(this.data.layout);
    this._suppressScrollUntil = Date.now() + 700;
    this.setData({
      paneAnim: true,
      drillTop: '', drillLabel: '', subTabs: [], activeSub: '',
      visibleSections: this.data.sections,
      activeCategory: prev,
    });
    this._pulsePaneAnim();
    setTimeout(() => {
      this._measureSections();
      const sec = this.data.sections.find(s => s.name === prev);
      if (!sec) return;
      if (isList) {
        this.setData({ scrollIntoListId: sec.id, sidebarScrollId: 's-' + sec.id });
        setTimeout(() => this.setData({ scrollIntoListId: '' }), 400);
      } else {
        // Grid/gallery: highlight the chip + page-scroll back to that section.
        // Measure it live (the full list just re-rendered) to avoid a stale
        // offset from before the drill.
        this.setData({ activeChipId: 'chip-' + sec.id });
        wx.createSelectorQuery().in(this)
          .select('#' + sec.id).boundingClientRect()
          .selectViewport().scrollOffset()
          .exec((res) => {
            const r = res && res[0], so = res && res[1];
            if (r && so) {
              const top = (r.top + so.scrollTop) - STICKY_OFFSET_PX + 30;
              wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 300 });
            }
          });
      }
    }, 120);
  },

  // Tap a subcategory in the drilled rail → scroll the right pane to its
  // heading ('' = the ALL-of-category top).
  setSub(e) {
    const gid = e.currentTarget.dataset.sub || '';
    const isList = LIST_LAYOUTS.includes(this.data.layout);
    this._suppressScrollUntil = Date.now() + 500;
    this.setData({
      activeSub: gid,
      sidebarScrollId: gid ? 'sub-' + gid : 'sub-top',
      activeChipId: gid ? 'chip-' + gid : 'chip-back',
    });
    if (isList) {
      this.setData({ scrollIntoListId: gid ? 'g-' + gid : 'top-anchor' });
      setTimeout(() => this.setData({ scrollIntoListId: '' }), 400);
    } else if (!gid) {
      wx.pageScrollTo({ scrollTop: 0, duration: 300 });
    } else {
      // Grid/gallery: measure the group live (image heights drift) and
      // page-scroll its heading just under the sticky bar.
      wx.createSelectorQuery().in(this)
        .select('#g-' + gid).boundingClientRect()
        .selectViewport().scrollOffset()
        .exec((res) => {
          const r = res && res[0], so = res && res[1];
          if (r && so) {
            const top = (r.top + so.scrollTop) - STICKY_OFFSET_PX + 30;
            wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 300 });
          }
        });
    }
  },

  // ── Filter / sort handlers ────────────────────────────────────
  setCategory(e) {
    const name = e.currentTarget.dataset.name || '';
    this._setActive(name);

    if (!name) {
      // ALL → scroll to the very top
      if (LIST_LAYOUTS.includes(this.data.layout)) {
        this.setData({ scrollIntoListId: 'top-anchor' });
        setTimeout(() => this.setData({ scrollIntoListId: '' }), 400);
      } else {
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });
      }
      return;
    }
    const section = this.data.sections.find(s => s.name === name);
    if (!section) return;
    // Pause scroll-triggered active-category updates briefly so the
    // smooth scroll doesn't flicker through every section on the way.
    this._suppressScrollUntil = Date.now() + 500;
    if (LIST_LAYOUTS.includes(this.data.layout)) {
      this.setData({ scrollIntoListId: section.id });
      setTimeout(() => this.setData({ scrollIntoListId: '' }), 400);
    } else {
      const offset = (this._sectionOffsets || []).find(o => o.id === section.id);
      const target = offset ? Math.max(0, offset.top - STICKY_OFFSET_PX + 30) : 0;
      wx.pageScrollTo({ scrollTop: target, duration: 300 });
    }
  },

  setDietary(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ activeDietary: key === this.data.activeDietary ? '' : key });
    this.refresh();
  },
  setBadge(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ activeBadge: key === this.data.activeBadge ? '' : key });
    this.refresh();
  },
  toggleInStock() {
    this.setData({ inStockOnly: !this.data.inStockOnly });
    this.refresh();
  },
  onSortChange(e) {
    const i = Number(e.detail.value) || 0;
    this.setData({
      sortIndex: i,
      sortLabel: this.data.sortLabels[i] || this.data.sortLabels[0],
    });
    this.refresh();
  },
  onPriceMinBlur(e) {
    const v = (e.detail.value || '').replace(/[^0-9.]/g, '');
    if (v === this.data.priceMin) return;
    this.setData({ priceMin: v });
    this.refresh();
  },
  onPriceMaxBlur(e) {
    const v = (e.detail.value || '').replace(/[^0-9.]/g, '');
    if (v === this.data.priceMax) return;
    this.setData({ priceMax: v });
    this.refresh();
  },
  clearPriceRange() {
    this.setData({ priceMin: '', priceMax: '' });
    this.refresh();
  },

  onSearchInput(e) {
    const q = e.detail.value || '';
    this.setData({ query: q });
    if (this._searchT) clearTimeout(this._searchT);
    this._searchT = setTimeout(() => this.refresh(), 300);
  },
  // §295 — the search button opens the box with the keyboard up.
  openSearch() {
    this.setData({ searchOpen: true, searchFocus: true });
  },
  // Leaving the box with nothing typed folds it back to the button. With a
  // search typed it stays open: the list is filtered and the box is what says so.
  onSearchBlur() {
    if (this.data.query) this.setData({ searchFocus: false });
    else this.setData({ searchOpen: false, searchFocus: false });
  },
  // × clears the search and closes the box. Only re-fetches when there was a
  // search to clear, so closing an empty box costs no request.
  closeSearch() {
    if (this._searchT) { clearTimeout(this._searchT); this._searchT = null; }
    const had = !!this.data.query;
    this.setData({ query: '', searchOpen: false, searchFocus: false });
    if (had) this.refresh();
  },

  openProduct(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/product/product?id=' + id });
  },

  addToCart(e) {
    const id = Number(e.currentTarget.dataset.id);
    // Variant card → open the size picker instead of adding directly.
    const members = this._memberMap && this._memberMap[id];
    if (members && members.length > 1) {
      this._openVariantPicker(id, members);
      return;
    }
    const raw = (this.data._raw || []).find(p => Number(p.id) === id);
    if (!raw) return;
    // Has customer choices (e.g. a dressing) → can't quick-add; open the product
    // page so the pick gets made (the PDP enforces required options).
    if (raw.has_options) {
      wx.navigateTo({ url: '/pages/product/product?id=' + id });
      return;
    }
    // Same-city shoppers never see the + on a sold-out reservable row (the card
    // renders the dead SOLD OUT pill instead), but a stale page can still fire
    // this — re-check rather than trusting the tap.
    const { kind, soldOut } = _stockState(raw, !!this._onLocalRun);
    if (soldOut) {
      wx.showToast({ title: this.data.lang === 'cn' ? '已售罄' : 'Sold out', icon: 'none' });
      return;
    }
    this._addRawToCart(raw, id, kind);
  },

  // Add one product row to the cart + run the fly-to-cart animation. originId
  // is the id of the card whose + button anchors the animation (the
  // representative card, even when the chosen size is a different sibling).
  // kind: `_stockState`'s own verdict ('' | 'batch' | 'preorder'), so a
  // quick-add never silently looks like a normal in-stock add AND never uses a
  // different word from the band the customer just tapped (§108). '' covers
  // both an ordinary in-stock add and a batch made TODAY on the run, which is
  // reservable but is not a reservation (§80).
  _addRawToCart(raw, originId, kind) {
    cart.add({
      id: raw.id,
      name_en: raw.name_en,
      name_cn: raw.name_cn,
      sku: raw.sku,
      size: raw.size || raw.weight,
      image_url: raw.image_url,
      image_data: raw.image_data,
      price: Number(raw.price ?? raw.sell_price) || 0,
      // Carry the flash fields through so cart.add() prices the line at the
      // active flash rate (was dropped here → checkout showed regular price).
      effective_price: raw.effective_price,
      is_on_flash: raw.is_on_flash,
      bundle_worth: raw.bundle_worth,   // a bundle card: its "separately" worth
      // The tenant's add-to-cart notice. Carried across because this call site
      // builds a literal — a grid + is an add like any other, and the customer
      // who never opens the product page is exactly the one who has not read
      // the notice anywhere else.
      cart_notice: raw.cart_notice,
    }, 1, []);

    // §108 — the toast says what the card said. It used to say "pre-order" for
    // every reservable row, so a Guangzhou shopper whose band read NEXT BATCH
    // was told something else the moment they tapped it.
    if (kind) {
      wx.showToast({
        title: kind === 'batch'
          ? (this.data.lang === 'cn' ? '已加入购物车，下批现做' : 'Added — next batch')
          : (this.data.lang === 'cn' ? '已预订，加入购物车' : 'Added — pre-order'),
        icon: 'none',
        duration: 1500,
      });
    }

    const imgUrl = absUrl(raw.image_url) || absUrl(raw.image_data) || '';
    wx.createSelectorQuery()
      .in(this)
      .select('#plus-' + originId)
      .boundingClientRect()
      .exec((res) => {
        const rect = res && res[0];
        if (!rect) {
          if (!kind) wx.showToast({ title: this.data.lang === 'cn' ? '已加入' : 'Added', icon: 'success', duration: 800 });
          return;
        }
        const startX = rect.left + (rect.width / 2) - 20;
        const startY = rect.top  + (rect.height / 2) - 20;
        this._launchFly(startX, startY, imgUrl);
      });
  },

  // ── Variant size picker ───────────────────────────────────────────
  // Bottom sheet listing each sibling size with its own price / stock.
  _openVariantPicker(repId, members) {
    const L = this.data.lang;
    const onLocalRun = !!this._onLocalRun;
    // §195 — hoisted out of the row loop below for the same reason _toRows
    // hoists it: one shop-wide setting, read once, so no size row can differ
    // from the size row above it.
    const preWin = config.get('notice.preorder', null);
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    const options = members.map(m => {
      const regular = Number(m.price ?? m.sell_price) || 0;
      const eff = _effPrice(m);
      const isFlash = !!m.is_on_flash && eff < regular;
      // Compare-at "was" price: struck-through when higher than the live price
      // and there's no flash sale (flash takes priority and uses `regular`).
      const cmp = Number(m.compare_at_price) || 0;
      const wasN = isFlash ? regular : (cmp > eff && eff > 0 ? cmp : 0);
      const saveN = wasN > eff && eff > 0 ? Math.round((wasN - eff) * 100) / 100 : 0;
      // Out but pre-orderable → keep the row tappable with a word of its own;
      // only a hard-out size shows the dead SOLD OUT pill. Mirrors the PDP's
      // own size picker. For a same-city address a sold-out size is hard-out
      // unless the kitchen has dated the next batch for it.
      const { out, preorder, kind, soldOut, stock } = _stockState(m, onLocalRun);
      /* §108, per SIZE — this sheet drew the page-level `preLabel` flat, so
         every reservable size read PRE-ORDER whatever the shopper's address
         was. One string cannot answer three questions:
           made today, on the run → orderable, and SILENT
           a fresh size not yet made → NEXT BATCH · 下批现做, for EVERY shopper
                                       (§108: the wait is the same fact wherever
                                       they are; only the date differs, and the
                                       date lives in the checkout notice)
           anything else reservable  → PRE-ORDER · 可预订, unchanged — a grocery
                                       size names no batch, none being cooked
         `preorder` STAYS TRUE in all three — it is what keeps the row out of
         SOLD OUT (see _stockState), so silencing the band by turning it off
         would mark the size sold out on the morning it is most available. The
         band in shop.wxml is gated on this TEXT instead, and an empty string
         is a real answer there, not a missing one. Do not restore an
         "|| preLabel" fallback: it reads '' as absent and prints a word the
         silent case exists to withhold. */
      const preText = kind === 'batch'
        ? freshEta.withFreshArrival(L === 'cn' ? '下批现做' : 'NEXT BATCH', m, onLocalRun, L)
        : kind === 'preorder'
          ? freshEta.withRestockWindow(L === 'cn' ? '可预订' : 'PRE-ORDER', preWin, L)
        : '';
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
        preText,
        low: (!out && stock != null && stock <= 5)
          ? (L === 'cn' ? `仅剩 ${stock}` : `Only ${stock} left`)
          : '',
      };
    });
    const rep = (this.data._raw || []).find(p => Number(p.id) === repId);
    this._vpRepId = repId;
    // Picker heading uses the operator-set variant axis noun ("color"→"Choose a
    // color" / "选择颜色"); falls back to the legacy "size" / "规格" when unset.
    const nounEn = (rep && rep.variant_noun_en || '').trim();
    const nounCn = (rep && rep.variant_noun_cn || '').trim();
    this.setData({
      vpShow: true,
      vpName: rep ? lang.pick(rep.name_en, rep.name_cn, L) : '',
      vpTitle: L === 'cn' ? (nounCn ? `选择${nounCn}` : '选择规格') : (nounEn ? `Choose a ${nounEn}` : 'Choose a size'),
      vpOptions: options,
    });
  },

  closeVariantPicker() { this.setData({ vpShow: false }); },
  vpStop() { /* catchtap on the sheet body so taps don't close it */ },

  vpChoose(e) {
    const id = Number(e.currentTarget.dataset.id);
    const members = (this._memberMap && this._memberMap[this._vpRepId]) || [];
    const m = members.find(x => Number(x.id) === id);
    if (!m) return;
    // A pre-orderable out-of-stock size stays orderable for an out-of-city
    // shopper; a same-city one gets the dead row (_stockState folds that in).
    const { kind, soldOut } = _stockState(m, !!this._onLocalRun);
    if (soldOut) {
      wx.showToast({ title: this.data.lang === 'cn' ? (m.ship_from_supplier ? '暂时缺货' : '已售罄') : (m.ship_from_supplier ? 'Unavailable' : 'Sold out'), icon: 'none' });
      return;
    }
    this.setData({ vpShow: false });
    // Fly from the representative card's + button (still in the DOM).
    this._addRawToCart(m, this._vpRepId, kind);
  },

  _launchFly(startX, startY, imgUrl) {
    let W = 375, H = 667;
    try {
      const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      W = sys.windowWidth  || W;
      H = sys.windowHeight || H;
    } catch {}

    const cartX = W * (5 / 8);
    const cartY = H - 30;
    const dx = cartX - startX;
    const dy = cartY - startY;

    this.setData({
      flyShow: true, flyImg: imgUrl,
      flyStartX: startX, flyStartY: startY,
      flyDx: 0, flyDy: 0,
    });
    setTimeout(() => {
      this.setData({ flyDx: dx, flyDy: dy });
      setTimeout(() => wx.vibrateShort && wx.vibrateShort({ type: 'light' }), 600);
      setTimeout(() => this.setData({ flyShow: false }), 720);
    }, 50);
  },
});
