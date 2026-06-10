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

const api    = require('../../utils/api');
const lang   = require('../../utils/lang');
const cart   = require('../../utils/cart');
const config = require('../../utils/config');

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

const DIETARY_FILTERS = [
  { key: 'gluten', en: 'GLUTEN FREE', cn: '无麸质' },
  { key: 'nuts',   en: 'NUT FREE',    cn: '无坚果' },
  { key: 'soy',    en: 'SOY FREE',    cn: '无大豆' },
  { key: '5spice', en: '5-SPICE FREE', cn: '无五香' },
];

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

const LIST_LAYOUTS = ['list', 'list-compact'];
const VALID_LAYOUTS = ['list', 'list-compact', 'grid-2col', 'grid-3col', 'gallery', 'grid'];

const LAYOUT_OPTIONS = [
  { key: 'list',         icon: '☰',  en: 'List with sidebar',  cn: '列表（侧栏）' },
  { key: 'list-compact', icon: '≡',  en: 'List compact',       cn: '列表（紧凑）' },
  { key: 'grid-2col',    icon: '⊞',  en: 'Grid 2-col',          cn: '网格 2 列' },
  { key: 'grid-3col',    icon: '⊟',  en: 'Grid 3-col',          cn: '网格 3 列' },
  { key: 'gallery',      icon: '▢',  en: 'Gallery',             cn: '画廊' },
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
    _raw: [],
    categories: [],          // [{ id, name, label }] top categories (without ALL)
    activeCategory: '',      // '' = ALL / above all sections
    activeDietary: '',
    activeBadge: '',
    inStockOnly: false,
    priceMin: '',
    priceMax: '',
    query: '',
    sortIndex: 0,
    lang: 'en',
    loading: true,
    totalCount: 0,

    layout: 'list',
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
    searchPlaceholder: 'Search the pantry…',
    listTitle: 'CATEGORIES',
    emptyTitle: 'No products yet.',
    emptySub: 'Publish products in the Roots admin to see them here.',
    sortLabels: SORT_OPTIONS.map(o => o.en),
    sortLabel: SORT_OPTIONS[0].en,
    inStockLabel: 'IN STOCK',
    priceFromLabel: '¥',
    oosLabel: 'SOLD OUT',
    dietaryFilters: DIETARY_FILTERS.map(f => ({ ...f, label: f.en })),
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
    this.refresh();
  },

  onShow() {
    const app = getApp();
    if (app.globalData.lang !== this.data.lang) {
      this._applyLang(app.globalData.lang);
      this.refresh();
    }
    this._syncConfig();
    const tb = this.getTabBar && this.getTabBar();
    if (tb && tb.setSelected) tb.setSelected('pages/shop/shop');
    // Honour a category deep-link handed off from the home page (a tapped
    // category tile). If sections are already loaded we apply it now;
    // otherwise refresh() applies it once they're built.
    this._applyPendingCategory();
  },

  // Pre-select + scroll to the category the customer tapped on Home. The
  // target name is stashed in globalData because switchTab carries no params.
  // No-op when nothing is pending or the section hasn't loaded yet.
  _applyPendingCategory() {
    const app = getApp();
    const name = app.globalData && app.globalData.pendingCategory;
    if (!name) return;
    const section = (this.data.sections || []).find(s => s.name === name);
    if (!section) return;            // sections not built yet — refresh() retries
    app.globalData.pendingCategory = '';
    this.setCategory({ currentTarget: { dataset: { name } } });
  },

  // Page-level scroll: only used when the layout is grid/gallery (the
  // page itself scrolls then). For list layouts, scrolling happens inside
  // the list-main scroll-view and we handle it via bindscroll there.
  onPageScroll(e) {
    if (LIST_LAYOUTS.includes(this.data.layout)) return;
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
      searchPlaceholder: L === 'cn' ? '搜索…'  : 'Search the pantry…',
      listTitle:         L === 'cn' ? '分类' : 'CATEGORIES',
      inStockLabel:      L === 'cn' ? '有货' : 'IN STOCK',
      priceFromLabel:    L === 'cn' ? '价格' : '¥',
      oosLabel:          L === 'cn' ? '售罄' : 'SOLD OUT',
      emptyTitle:        L === 'cn' ? '暂无商品' : 'No products yet.',
      emptySub:          L === 'cn' ? '请在管理后台发布商品' : 'Publish products in the Roots admin to see them here.',
      dietaryFilters: DIETARY_FILTERS.map(f => ({ ...f, label: L === 'cn' ? f.cn : f.en })),
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

    const adminLayout = (s.layout === 'grid' ? 'grid-2col' : s.layout) || 'list';
    const layoutLocked = !!s.lockLayout;
    let layout = adminLayout;
    if (!layoutLocked) {
      try {
        const saved = wx.getStorageSync(LAYOUT_STORAGE_KEY);
        if (saved && VALID_LAYOUTS.includes(saved)) layout = saved;
      } catch {}
    }
    if (!VALID_LAYOUTS.includes(layout)) layout = 'list';
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

    this.setData({
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
    this.setData({ layout: key, isListLayout });
    try { wx.setStorageSync(LAYOUT_STORAGE_KEY, key); } catch {}
    // Re-measure sections after the new layout renders
    setTimeout(() => this._measureSections(), 200);
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
      const params = ['limit=500'];
      if (this.data.query)          params.push('q=' + encodeURIComponent(this.data.query));
      const sortVal = SORT_OPTIONS[this.data.sortIndex]?.value;
      if (sortVal)                  params.push('sort=' + sortVal);
      const qs = '?' + params.join('&');

      const [prods, treeResp] = await Promise.all([
        api.get('/api/retail/products' + qs).catch(() => []),
        api.get('/api/retail/category-tree').catch(() => []),
      ]);

      let raw = (Array.isArray(prods) ? prods : prods?.data || []);

      // Client-side filters
      if (this.data.activeDietary) {
        raw = raw.filter(p => {
          const tags = (p.free_of || '').split(',').map(s => s.trim());
          return tags.includes(this.data.activeDietary);
        });
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

      const L = this.data.lang;
      const tree = (Array.isArray(treeResp) ? treeResp : treeResp?.data || []);

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

      this.setData({
        _raw: raw,
        sections,
        categories,
        totalCount,
        loading: false,
      });
      // Measure section offsets so onScroll can find the active one, then
      // honour any pending category deep-link now that sections + offsets exist.
      setTimeout(() => { this._measureSections(); this._applyPendingCategory(); }, 200);
    } catch (e) {
      console.warn('[shop] refresh failed:', e.message);
      this.setData({ loading: false });
    }
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
        groups,
      });
    });

    if (orphans.length) {
      const rows = this._toRows(orphans, L);
      sections.push({
        id: 'other',
        name: '__other__',
        label: L === 'cn' ? '其他' : 'OTHER',
        groups: [{ id: 'other-g0', label: '', items: rows, countStr: pad(rows.length) }],
      });
    }

    return sections;
  },

  _toRows(products, L) {
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    return products.map(p => {
      const members = p._members || null;
      const regular = Number(p.price ?? p.sell_price) || 0;
      const eff = Number(p.effective_price) > 0 ? Number(p.effective_price) : regular;
      const isFlash = !members && !!p.is_on_flash && eff < regular;

      let price, priceWas = '', pricePrefix = '', outOfStock, soldUnits, subline;
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
        outOfStock = members.every(m => m.stock != null && Number(m.stock) <= 0);
        soldUnits = members.reduce((s, m) => s + (Number(m.units_sold) || 0), 0);
        subline = '';
      } else {
        const stockNum = p.stock == null ? null : Number(p.stock);
        outOfStock = stockNum != null && stockNum <= 0;
        // All-time units sold (server min-gates this to 0 below the badge
        // threshold), shown as a small "X SOLD" popularity caption on the card.
        soldUnits = Number(p.units_sold) || 0;
        price = eff > 0 ? money(eff) : '—';
        priceWas = isFlash && regular > 0 ? money(regular) : '';
        subline = (p.size || '').toString().trim();
      }

      return {
        id: p.id,
        name: lang.pick(p.name_en, p.name_cn, L),
        subline,
        badge: pickBadge(p.tags),
        soldCaption: soldUnits > 0 ? (L === 'cn' ? `已售 ${soldUnits}` : `${soldUnits} SOLD`) : '',
        outOfStock,
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

  _setActive(name) {
    const sec = name ? this.data.sections.find(x => x.name === name) : null;
    this.setData({
      activeCategory: name,
      sidebarScrollId: sec ? 's-' + sec.id : 's-top-anchor',
      activeChipId:    sec ? 'chip-' + sec.id : 'chip-all',
    });
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
  clearSearch() {
    this.setData({ query: '' });
    this.refresh();
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
    this._addRawToCart(raw, id);
  },

  // Add one product row to the cart + run the fly-to-cart animation. originId
  // is the id of the card whose + button anchors the animation (the
  // representative card, even when the chosen size is a different sibling).
  _addRawToCart(raw, originId) {
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
    }, 1, []);

    const imgUrl = absUrl(raw.image_url) || absUrl(raw.image_data) || '';
    wx.createSelectorQuery()
      .in(this)
      .select('#plus-' + originId)
      .boundingClientRect()
      .exec((res) => {
        const rect = res && res[0];
        if (!rect) {
          wx.showToast({ title: this.data.lang === 'cn' ? '已加入' : 'Added', icon: 'success', duration: 800 });
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
    const money = v => '¥' + (Number.isInteger(v) ? v : v.toFixed(2));
    const options = members.map(m => {
      const regular = Number(m.price ?? m.sell_price) || 0;
      const eff = _effPrice(m);
      const isFlash = !!m.is_on_flash && eff < regular;
      const stock = m.stock == null ? null : Number(m.stock);
      const soldOut = stock != null && stock <= 0;
      return {
        id: m.id,
        label: lang.pickLabel(m.variant_label, L) || lang.pick(m.name_en, m.name_cn, L) || ('#' + m.id),
        weight: (m.size || '').toString().trim(),
        price: eff > 0 ? money(eff) : '',
        priceWas: isFlash && regular > 0 ? money(regular) : '',
        isFlash,
        soldOut,
        low: (!soldOut && stock != null && stock <= 5)
          ? (L === 'cn' ? `仅剩 ${stock}` : `Only ${stock} left`)
          : '',
      };
    });
    const rep = (this.data._raw || []).find(p => Number(p.id) === repId);
    this._vpRepId = repId;
    this.setData({
      vpShow: true,
      vpName: rep ? lang.pick(rep.name_en, rep.name_cn, L) : '',
      vpTitle: L === 'cn' ? '选择规格' : 'Choose a size',
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
    const stock = m.stock == null ? null : Number(m.stock);
    if (stock != null && stock <= 0) {
      wx.showToast({ title: this.data.lang === 'cn' ? '已售罄' : 'Sold out', icon: 'none' });
      return;
    }
    this.setData({ vpShow: false });
    // Fly from the representative card's + button (still in the DOM).
    this._addRawToCart(m, this._vpRepId);
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
