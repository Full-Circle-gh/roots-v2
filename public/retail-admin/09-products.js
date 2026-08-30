/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 09/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: products (pa/pd/va/bu prefixes): overview grid, bulk ops, product editor, variants, bundles, gallery, RTE, designer blocks, preview */
// ════════════════════════════════════════════════════════════════
// PRODUCTS — mini-app product surface (Designer Sections + chrome).
// Block-based body editor lives here so the office controls the
// magazine-spread experience; kitchen master data (price, stock) stays
// in /products. Lazy-loaded on first tab open.
// ════════════════════════════════════════════════════════════════
// COST and MARGIN figures print in the tenant's display currency (01-core.js
// acMoney), not a hardcoded ¥. Deliberately scoped to those two: the catalogue's
// PRICE column and the price/compare-at INPUTS on this screen still carry a
// literal ¥, and moving them is a change to what the operator TYPES rather than
// to what a cost derivation REPORTS.
const paMoney = n => (typeof acMoney === 'function' ? acMoney(Number(n) || 0) : '¥' + fmt(Number(n) || 0));

let PA_LOADED = false;
let PA_PRODUCTS = [];   // server response
let PA_CURRENT = null;  // currently open product (when modal is showing)
// Per-store stock for the overview table. With 2+ stores the Stock column can
// edit ONE store at a time (picked via the switcher); 'all' = read-only sum.
//   PA_STORES — [{id, code, name_en, name_cn}] active stores
//   PA_STORE  — 'all' | storeId(number), the store the Stock column edits
//   PA_STOCK  — productId -> { storeId(number): physical_qty }  (from /inventory/grid)
let PA_STORES = [];
let PA_STORE  = (() => { try { const v = localStorage.getItem('pa-store'); return v && v !== 'all' ? (parseInt(v, 10) || 'all') : 'all'; } catch { return 'all'; } })();
let PA_STOCK  = {};
let PA_STOCK_LOADED = false;
// Tenant-wide default low-stock threshold (units). Hydrated by loadConfig() from
// storefront_config 'inventory.lowStockThreshold'; a product can override it via
// its own low_stock_threshold. Drives the amber dot, the Low-stock KPI tile +
// quick-filter — kept in sync with the backend dashboard/alerts definition.
let PA_LOW_STOCK = 5;
// Effective low-stock threshold: a product's own override wins; failing that,
// the given store's own override (when known); failing that, the tenant-wide
// default. storeId is optional — omit it (or pass 'all') for a combined-stock
// row that isn't scoped to one location.
function paLowThreshold(p, storeId) {
  const t = p && p.low_stock_threshold;
  if (t != null && t !== '' && Number(t) >= 0) return Number(t);
  if (storeId != null && storeId !== 'all') {
    const s = PA_STORES.find(x => x.id === storeId);
    const st = s && s.low_stock_threshold;
    if (st != null && st !== '' && Number(st) >= 0) return Number(st);
  }
  return PA_LOW_STOCK;
}
// Mirror the tenant-wide default in the three places it still shows: the
// Settings input, the Low-stock KPI tile subtitle, and the editor field's
// placeholder (a per-product override already wins over all of these). The
// threshold itself is now set in Settings → Operations → Stores
// (paSaveLowStockDefault); per-store overrides live in each store's own form.
function paSyncLowStockUi() {
  const cfg = document.getElementById('cfg-low-stock');
  if (cfg && document.activeElement !== cfg) cfg.value = PA_LOW_STOCK;
  const sub = document.getElementById('pa-kpi-low-sub');
  if (sub) sub.textContent = '≤ ' + PA_LOW_STOCK + ' left · 剩余 ≤ ' + PA_LOW_STOCK;
  const ls = document.getElementById('pd-low-stock');
  if (ls) ls.placeholder = cuT('Default', '默认') + ' ' + PA_LOW_STOCK;
}
// Persist the tenant-wide default from Settings → Operations → Stores. Per-store
// overrides are saved separately in each store's settings form (osf_low_stock).
async function paSaveLowStockDefault(val) {
  const n = Math.max(0, parseInt(val, 10) || 0);
  const st = document.getElementById('cfg-low-stock-status');
  try {
    PA_LOW_STOCK = n;
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'inventory.lowStockThreshold': n } });
    if (typeof _cfgCache !== 'undefined' && _cfgCache) { _cfgCache.inventory = _cfgCache.inventory || {}; _cfgCache.inventory.lowStockThreshold = n; }
    if (st) { st.textContent = cuT('Saved ✓', '已保存 ✓'); setTimeout(() => { if (st) st.textContent = ''; }, 2000); }
    paSyncLowStockUi();
    try { paRenderKpis(false); paRender(); } catch (_) {}
  } catch (e) {
    if (st) st.textContent = cuT('Save failed', '保存失败');
  }
}
// Product layout: 'grid' (rich cards) | 'list' (the table). Separate from the
// "View" display-tweaks popover; persisted per-browser. 'compact' is retired —
// its button was hidden, so the mode could only be reached by an old stored
// value; anyone still carrying one lands on 'list'.
let PA_VIEW = (() => { try { const v = localStorage.getItem('pa-view'); return (v === 'grid' || v === 'list') ? v : 'list'; } catch { return 'list'; } })();
function paSetView(v) {
  // The editor is a drawer over the list now, so no layout is locked by it.
  PA_VIEW = (v === 'list') ? 'list' : 'grid';
  try { localStorage.setItem('pa-view', PA_VIEW); } catch {}
  PA_PAGE = 1;
  paRender();
}

// Quick status filter driven by the catalogue-health KPI tiles. One of
// 'all' | 'live' | 'restock' | 'oos' | 'low' | 'drafts'. Clicking a tile
// toggles its filter (click again to clear), narrowing the grid to that
// status — independent of the search box and category filter, which still
// stack on top. 'restock' = OOS + low together (what the dashboard's
// "Open restock" button deep-links into).
let PA_STATUS = 'all';
// Highlights payload (two id-backed count buckets), fetched from
// /api/retail-admin/products/highlights. Their member IDs back the
// 'dead' | 'promo' quick filters below, so the jump tile's number and the
// filtered grid share one source.
let PA_HI = null;
const PA_HI_SETS = { dead: new Set(), promo: new Set() };
// Status has two faces — the pulse tiles and the filter row's dropdown — and
// one value. A tile toggles (clicking the active one clears back to 'all');
// the dropdown always sets exactly what was picked, so it passes `false` to
// opt out of the toggle. Whichever moved, both are repainted from PA_STATUS.
function paSetStatus(v, toggle) {
  PA_STATUS = (toggle !== false && PA_STATUS === v) ? 'all' : v;
  PA_PAGE = 1;
  paSyncStatusFilter();
  paRender();
}
function paSyncStatusFilter() {
  const sel = document.getElementById('pa-statusfilter');
  if (!sel) return;
  // A status with no option of its own (nothing today, but the tiles and the
  // dashboard deep-links can both set one) shows as All rather than blank.
  sel.value = [...sel.options].some(o => o.value === PA_STATUS) ? PA_STATUS : 'all';
}
// Stock to judge OOS / Low against, honouring the "Stock for" switcher: when a
// single store is selected (and its per-store map has loaded) use that store's
// own count, otherwise the combined effective_stock (legacy stock_qty as a last
// resort). Keeps the KPI tiles, quick-filter and grid OOS badge all answering
// the same question — "out of stock *where I'm looking*" — so picking Tianhe +
// Out of stock lists items zero in Tianhe even if they're stocked elsewhere.
function _paStockOf(p) {
  // An ASSEMBLED bundle holds no stock of its own — its availability is how many
  // whole sets its components can currently make: min over components of
  // floor(component stock ÷ per-bundle qty). Store-aware, so it follows the
  // "Stock for" pick just like a normal product. (Pre-packed bundles carry their
  // own count and fall through to the normal path below.)
  if (p.is_bundle) return _paBundleStock(p);
  if (PA_STORE !== 'all' && PA_STOCK_LOADED) return _paStoreQty(p.id, PA_STORE);
  return Number(p.effective_stock ?? p.stock_qty ?? 0);
}

// How many whole bundles the components can make right now (0 when any part is
// missing). Reads each component's store-aware stock the same way _paStockOf
// does, so the figure matches what the shop would show. `p.bundle_items` is the
// raw [{id, qty}] recipe the list endpoint ships. `storeId` names the store to
// count in — omit it to follow the "Stock for" switcher (PA_STORE); the
// two-location list passes each column's own store, otherwise both columns
// would print the same switcher-wide figure and a store with nothing on its
// shelves would still read as stocked.
function _paBundleStock(p, storeId) {
  const store = (storeId === undefined) ? PA_STORE : storeId;
  const comps = Array.isArray(p.bundle_items) ? p.bundle_items : [];
  if (!comps.length) return 0;
  let min = Infinity;
  for (const c of comps) {
    const qty = Math.max(1, Number(c.qty) || 1);
    let stock;
    if (store !== 'all' && PA_STOCK_LOADED) {
      stock = _paStoreQty(c.id, store);
    } else {
      const cp = (Array.isArray(PA_PRODUCTS) ? PA_PRODUCTS : []).find(x => x.id === c.id);
      stock = cp ? Number(cp.effective_stock ?? cp.stock_qty ?? 0) : 0;
    }
    min = Math.min(min, Math.floor(stock / qty));
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0;
}

// Does a product match the active status filter? Mirrors paRenderKpis' buckets.
function _paStatusMatch(p) {
  if (PA_STATUS === 'all') return true;
  const pub = p.is_published === 1;
  const s = _paStockOf(p);
  // Supplier-direct items hold no stock of ours — they're never out-of-stock,
  // low, or something to restock, so keep them out of those buckets entirely.
  const supplier = !!p.ship_from_supplier;
  switch (PA_STATUS) {
    case 'live':    return pub;
    case 'drafts':  return !pub;
    case 'oos':     return pub && !supplier && s <= 0;
    case 'low':     return pub && !supplier && s > 0 && s <= paLowThreshold(p);
    case 'restock': return pub && !supplier && s <= paLowThreshold(p);   // OOS + low = everything to buy back
    // Highlights-band buckets — membership comes from the server (id sets), not a
    // per-product rule, so the grid matches the tile count exactly.
    case 'dead':       return PA_HI_SETS.dead.has(p.id);
    case 'promo':      return PA_HI_SETS.promo.has(p.id);
    default:        return true;
  }
}

// ── Catalogue pagination — caps how many cards render at once so the grid
// paints fast even with the full 200+ catalogue. Page size persists; any
// search / filter / view change resets to page 1.
// Two pagination modes:
//   • Overview (editor closed)  → operator-adjustable via the pager's "Per page"
//     selector (50/100/200/All); PA_PAGE_SIZE holds the choice.
//   • Docked (editor open)      → fixed PA_DOCK_PAGE_SIZE rows so the list ends
//     near the editor's bottom edge — no dead gap, no separate scroll. The
//     "Per page" selector is hidden in this mode.
let PA_PAGE_SIZE = 50;
const PA_DOCK_PAGE_SIZE = 18;
let PA_PAGE = 1;
function paSetPageSize(v) {
  PA_PAGE_SIZE = (v === 'all') ? 'all' : parseInt(v, 10);
  PA_PAGE = 1;
  paRender();
}
function paSetPage(n) {
  // Re-render in place — deliberately NO scroll, so paging doesn't jump the
  // viewport (the pager sits below the grid; scrolling the grid into view
  // nudged the page down on every click).
  PA_PAGE = n;
  paRender();
}
// Pager bar: "showing X–Y of Z", page-size selector, prev/next.
function _paPagerHtml(total, pages, start, shown, showSizeSel) {
  const from = total === 0 ? 0 : start + 1;
  const to   = start + shown;
  const btn = (label, page, dis) =>
    `<button class="btn btn-sm" type="button" ${dis ? 'disabled' : ''} onclick="paSetPage(${page})" style="font-family:var(--f-sans)">${label}</button>`;
  // EN/CN are kept as separate, self-contained spans tagged with data-lang-block
  // so the page's i18n CSS shows only the active language (never both glued
  // together). The inline `<b>` tags would otherwise split "Showing …" across
  // several text nodes and defeat the auto " · " splitter, leaking both halves.
  const prev = `<span data-lang-block="en">‹ Prev</span><span data-lang-block="cn">‹ 上一页</span>`;
  const next = `<span data-lang-block="en">Next ›</span><span data-lang-block="cn">下一页 ›</span>`;
  const sizeOpt = (v, lbl) => `<option value="${v}" ${String(PA_PAGE_SIZE) === String(v) ? 'selected' : ''}>${lbl}</option>`;
  // The "Per page" selector is overview-only: when the editor is docked the page
  // size is fixed at 18 (PA_DOCK_PAGE_SIZE), so showing a selector that does
  // nothing would mislead. showSizeSel is false in that mode.
  const sizeSel = showSizeSel ? `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:var(--f-sans)" class="muted">
        <span data-lang-block="en">Per page</span><span data-lang-block="cn">每页</span>
        <select onchange="paSetPageSize(this.value)" style="font-family:var(--f-sans);font-size:12px">
          ${sizeOpt(50, '50')}${sizeOpt(100, '100')}${sizeOpt(200, '200')}${sizeOpt('all', cuT('All', '全部'))}
        </select>
      </label>` : '';
  return `<span class="muted" style="font-size:12px;font-family:var(--f-sans)"><span data-lang-block="en">Showing <b>${from}–${to}</b> of <b>${total}</b></span><span data-lang-block="cn">显示 <b>${from}–${to}</b> / 共 <b>${total}</b></span></span>
    <div style="display:flex;align-items:center;gap:12px">
      ${sizeSel}
      <div style="display:flex;align-items:center;gap:8px">
        ${btn(prev, PA_PAGE - 1, PA_PAGE <= 1)}<span style="font-size:12px;white-space:nowrap">${PA_PAGE} / ${pages}</span>${btn(next, PA_PAGE + 1, PA_PAGE >= pages)}
      </div>
    </div>`;
}
// The Designer Sections block registries (PA_BLOCK_TYPES / PA_IP_CHARACTERS /
// PA_PAGE_PRESETS) and the ~960-line editor engine that read them are GONE.
// They backed #pa-edit-bg, a modal nothing on this page could open — the live
// implementation is public/product-editor.html, which owns its own copy. Two
// engines for one job is how they drift; this was the one nobody could reach.

document.querySelector('[data-tab="products"]').addEventListener('click', () => {
  if (!PA_LOADED) { PA_LOADED = true; paLoad(); }
  prodLoadStock(true);   // fresh stock cards on tab open
});

// ════════════════════════════════════════════════════════════════
// STOCK ACTIVITY — the ledger lives inside Products (moved here
// 2026-07-10; stock belongs with the products it counts). Two
// sub-views: the catalogue and the ledger. The four stock cards
// under the Recap band are doors into the ledger.
// The ledger itself is rendered by 13-activity.js (act* / #act-*);
// this file only owns the switch and the cards.
// ════════════════════════════════════════════════════════════════

// Which view is up is read straight off the DOM (actTabVisible in 13-activity
// .js checks #prod-view-activity's display), so no state variable is kept here.
// The tab always opens on the catalogue.
// Two places live under Products: the catalogue, the stock ledger, and the
// shelf (Categories, folded in 2026-07-10). A view the operator can't reach
// falls back to the catalogue rather than showing an empty pane. Purchasing
// was folded in here too (2026-07-11) but got its own rail tab back
// (2026-07-13, #tab-purchasing / puInit in 16-purchasing.js) — a supplier
// order is its own place, not a fact about the catalogue.
function prodShowView(view) {
  // A sub-view switch is a "show me the catalogue's other face" move, so the
  // expanded product page comes down first — otherwise coming back from the
  // ledger would land on a full page with no toolbar and no way to see the list.
  if (pdIsExpanded()) pdCollapseToPanel();
  const allowed = (v, cap) => v === view && (typeof can !== 'function' || can(cap));
  if (!allowed('activity', 'activity:view') && !allowed('categories', 'categories:view')) view = 'catalog';
  const panes = {
    catalog: 'prod-view-catalog', activity: 'prod-view-activity',
    categories: 'prod-view-categories',
  };
  for (const [v, id] of Object.entries(panes)) {
    const el = document.getElementById(id);
    if (el) el.style.display = v === view ? '' : 'none';
    document.getElementById('stk-view-btn-' + v)?.classList.toggle('on', v === view);
  }
  // actAdminInit loads the ledger and starts its own 15s poll; that poll asks
  // actTabVisible(), which checks this view is the one on screen.
  if (view === 'activity' && typeof actAdminInit === 'function') actAdminInit();
  // The tree is fetched the first time the shelf is opened, never before.
  if (view === 'categories' && typeof catLoad === 'function' && !catLoaded) catLoad();
  // The ⓘ next to the title carries this view's "what is this" copy.
  prodSetHelp(view);
}

// ── Page header — the title follows whichever sub-view is on screen.
// The ⓘ and its per-view "what is this" copy are RETIRED: §1.7 allows the
// header three elements (title · status line · one Dusk CTA) and there is no
// fourth. The status line — real work waiting, painted by paRenderKpis — is a
// better use of the same space than teaching copy behind a tooltip. ──
const PROD_VIEW_META = {
  catalog:    { title: ['Products', '产品'] },
  activity:   { title: ['Stock activity', '库存流水'] },
  categories: { title: ['Categories', '分类'] },
};
// Which sub-view the header is currently describing. prodSetHelp() is the
// only writer; initProdHelp() below re-reads it so a language change repaints
// the view that is actually on screen rather than always the catalogue.
let _prodHelpView = 'catalog';
function prodSetHelp(view) {
  _prodHelpView = PROD_VIEW_META[view] ? view : 'catalog';
  const m = PROD_VIEW_META[_prodHelpView];
  const say = (pair) => (typeof cuT === 'function') ? cuT(pair[0], pair[1]) : pair[0];
  const title = document.getElementById('pa-pagetitle');
  if (title) title.textContent = say(m.title);
  // The status line counts the catalogue's own stock; the other two sub-views
  // are their own pages and have no work count of ours to report.
  const line = document.getElementById('pa-status-line');
  if (line && view !== 'catalog') line.hidden = true;
}
// Paint the default (catalogue) help on load and keep it in the live language.
(function initProdHelp() {
  const boot = () => {
    prodSetHelp(_prodHelpView);
    if (window.onLangChange) onLangChange(() => prodSetHelp(_prodHelpView));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

// ── The four stock cards — moves / out / in / hit zero, today, all channels.
// Same /activity call the ledger makes (limit=1: only summary + digest are
// read, never the rows). Where the Recap band above says what the catalogue
// IS, these say what MOVED. Throttled to 45s; force=true on tab open. Amber
// (the .warn card + the dot on the sub-view tab) shows only while something
// is actually sitting at zero.
let _PROD_STOCK_AT = 0;
let _PROD_STOCK_DATA = null;
let _PROD_STOCK_LANG_HOOKED = false;
async function prodLoadStock(force) {
  if (!document.getElementById('stk-minis')) return;
  if (typeof can === 'function' && !can('activity:view')) return;
  if (!force && Date.now() - _PROD_STOCK_AT < 45000) return;
  _PROD_STOCK_AT = Date.now();
  if (!_PROD_STOCK_LANG_HOOKED && window.onLangChange) { _PROD_STOCK_LANG_HOOKED = true; onLangChange(prodRenderStock); }
  const todayGz = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const j = await api(`/api/retail-admin/activity?from=${todayGz}&to=${todayGz}&limit=1`);
    const sum = j.summary || [];
    // zeroed_total = exact count (digest.zeroed itself is capped at 8 rows);
    // fall back to the list length against an older server mid-deploy.
    const zero = (j.digest && (typeof j.digest.zeroed_total === 'number'
      ? j.digest.zeroed_total : (j.digest.zeroed || []).length)) || 0;
    _PROD_STOCK_DATA = {
      moves: sum.reduce((a, s) => a + (s.events || 0), 0),
      out:   sum.reduce((a, s) => a + (s.units_out || 0), 0),
      inn:   sum.reduce((a, s) => a + (s.units_in || 0), 0),
      zero,
    };
    prodRenderStock();
  } catch (e) { /* silent — the cards are a bonus, the ledger is the source */ }
}
function prodRenderStock() {
  const d = _PROD_STOCK_DATA; if (!d || !document.getElementById('stk-minis')) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stk-mini-moves', d.moves.toLocaleString());
  set('stk-mini-out',   d.out ? '−' + d.out.toLocaleString() : '0');
  set('stk-mini-in',    d.inn ? '+' + d.inn.toLocaleString() : '0');
  set('stk-mini-zero',  d.zero.toLocaleString());
  set('stk-mini-moves-hint', cuT('today so far', '今日累计'));
  set('stk-mini-out-hint',   cuT('sold or synced out', '售出或同步出库'));
  set('stk-mini-in-hint',    cuT('restocks', '补货入库'));
  set('stk-mini-zero-hint',  d.zero ? cuT('see below ›', '见下方 ›') : cuT('nothing waiting', '无需处理'));
  // The hit-zero card still turns amber while something's at zero; the old
  // tab-dot signal was removed (2026-07-15) — the amber card carries it.
  document.getElementById('stk-mini-zero-card')?.classList.toggle('warn', d.zero > 0);
}

// Live push: stock moves constantly (orders, daemons, quick-stock). The
// admin-wide SSE hub nudges us; the 45s throttle keeps it cheap. Only repaint
// while the Products tab is actually on screen.
if (typeof retailLiveSubscribe === 'function') {
  retailLiveSubscribe(() => {
    if (document.hidden) return;
    if (!document.getElementById('tab-products')?.classList.contains('active')) return;
    prodLoadStock();
  });
}

// Typed `stock` nudge — fired by lib/inventory.adjustStock on every ledgered
// move, wherever it came from (Quick Stock on a phone, the editor, an order,
// a restock ship). Repaints the catalogue's per-store counts and the sold-out
// tiles so the desk never shows a shelf that was refilled minutes ago.
let _paStockNudgeAt = 0, _paStockNudgeTimer = null, _paStockStale = false;
function _paStockNudge() {
  // Off-screen nudges are remembered, not dropped: a tab left on Orders all
  // morning would otherwise come back to Products holding page-load counts.
  // The docked editor already refetches the grid on close (paCloseEditor), so
  // leave it alone — a re-render underneath an open editor buys nothing.
  if (document.hidden || _paEditorOpen
      || !document.getElementById('tab-products')?.classList.contains('active')) {
    _paStockStale = true;
    return;
  }
  // Never yank the grid out from under a hand that's mid-recount — the
  // re-render would replace the very input being typed into. Wait it out.
  const busy = document.activeElement?.classList?.contains('pa-stock-input');
  const wait = busy ? 5000 : Math.max(0, 8000 - (Date.now() - _paStockNudgeAt));
  clearTimeout(_paStockNudgeTimer);
  _paStockNudgeTimer = setTimeout(() => {
    if (document.activeElement?.classList?.contains('pa-stock-input')) return _paStockNudge();
    _paStockStale = false;
    _paStockNudgeAt = Date.now();
    paLoadStoreStock();
  }, wait);
}
function _paStockCatchUp() { if (_paStockStale) _paStockNudge(); }
if (typeof retailLiveOn === 'function') {
  retailLiveOn('stock', _paStockNudge);
  document.addEventListener('visibilitychange', _paStockCatchUp);
  document.querySelector('.tabs [data-tab="products"]')
    ?.addEventListener('click', () => setTimeout(_paStockCatchUp, 0));
}

document.getElementById('pa-search').addEventListener('input', _paDebouncedRender);
document.getElementById('pa-filter').addEventListener('change', () => {
  PA_PAGE = 1;
  const sub = document.getElementById('pa-subfilter');
  if (sub) sub.value = 'all';          // picking a new category resets the subcategory
  paFillSubFilter();
  paRender();
});
document.getElementById('pa-subfilter').addEventListener('change', () => { PA_PAGE = 1; paRender(); });
// Keyboard support for the role="button" KPI quick-filter tiles.
document.querySelectorAll('.pa-kpi-click').forEach(tile =>
  tile.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); }
  }));
document.querySelectorAll('#pa-view-seg .pa-view-btn').forEach(btn =>
  btn.addEventListener('click', () => paSetView(btn.dataset.view)));

let _paT = null;
function _paDebouncedRender() { clearTimeout(_paT); _paT = setTimeout(() => { PA_PAGE = 1; paRender(); }, 200); }

async function paLoad() {
  const grid = document.getElementById('pa-grid');
  grid.innerHTML = '<div class="muted" style="grid-column:1/-1;text-align:center;padding:40px">Loading… · 加载中…</div>';
  try {
    const res = await fetch('/api/retail-admin/products');
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'load_failed');
    PA_PRODUCTS = j.data || [];
    paFillCatFilter();                       // category options from the catalogue
    pdLoadCatTree().then(paFillCatFilter);   // re-label bilingually once the tree lands
    paRender();
    paRenderKpis(true);   // animated count-up once on load
    paLoadHighlights();   // fills the Going nowhere / On promotion jump tiles
    paLoadStoreStock();   // per-store stock + store list (drives the switcher)
  } catch (e) {
    grid.innerHTML = `<div class="err" style="grid-column:1/-1;text-align:center;padding:40px">Failed to load products: ${escapeHtml(e.message)}</div>`;
  }
}

// ── Per-store stock ───────────────────────────────────────────────────────
// One fetch of the inventory grid gives us BOTH the active store list (for the
// switcher) and every product's physical_qty per store (so the Stock column can
// show/edit a single store's count). Upstream-catalog tenants don't manage stock
// here, so skip the whole thing for them.
async function paLoadStoreStock() {
  if (CATALOG_MODE === 'upstream') return;
  try {
    const res = await fetch('/api/retail-admin/inventory/grid');
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'load_failed');
    PA_STORES = (j.data && j.data.stores) || [];
    PA_STOCK = {};
    ((j.data && j.data.products) || []).forEach(p => {
      const m = {};
      (p.stocks || []).forEach(s => { m[s.store_id] = Number(s.physical_qty) || 0; });
      PA_STOCK[p.product_id] = m;
      // Carry the fresh counts into effective_stock too. The Stock COLUMNS read
      // PA_STOCK, but the "Out of stock" / "Low" KPI tiles and their row filters
      // read p.effective_stock — which only ever arrived with the /products
      // payload. So a phone recount left the desk's sold-out list still holding
      // a product that had been refilled minutes earlier, until someone opened
      // it (the editor's save path mirrors, see _paStockMirror).
      // Only when a real per-store row exists: with none, the server falls back
      // to legacy stock_qty and a computed 0 here would invent a sold-out.
      const prod = (PA_PRODUCTS || []).find(x => x.id === p.product_id);
      if (prod && (p.stocks || []).some(s => s.stocked)) {
        prod.effective_stock = Object.values(m).reduce((s, v) => s + v, 0);
      }
    });
    PA_STOCK_LOADED = true;
    // A remembered store that no longer exists falls back to "All".
    if (PA_STORE !== 'all' && !PA_STORES.some(s => s.id === PA_STORE)) PA_STORE = 'all';
    // Two-location layout: every store shows its own always-visible column, so
    // the single-store switcher is retired — keep filters on the combined total.
    if (PA_STORES.length >= 2) PA_STORE = 'all';
    paRenderStoreSeg();
    paSyncLowStockUi();   // refresh the KPI subtitle + editor placeholder
    paRender();   // stock cells now know per-store counts
    paRenderKpis(false);   // …and the health strip follows the same counts
  } catch (e) {
    PA_STOCK_LOADED = false;   // leave the column on the read-only combined total
  }
}

// Switcher bar: "STORE  [All · 全部 | Tianhe | Yuexiu]". Only meaningful with 2+
// stores — a single-store tenant just sees the plain total, so hide it.
function paRenderStoreSeg() {
  const bar = document.getElementById('pa-store-seg');
  if (!bar) return;
  // First of the filter row's two dropdowns. It used to be a segmented control
  // that hid itself in every configuration it could reach — below two stores
  // there was nothing to switch, and at two or more the per-store columns made
  // it redundant, so it was unreachable in practice. As a filter it always has
  // a job: it scopes which store the KPI counts and the status quick-filters
  // answer for, whether or not each store also has its own column.
  if (CATALOG_MODE === 'upstream' || PA_STORES.length < 2) { bar.style.display = 'none'; return; }
  const opt = (key, label) =>
    `<option value="${key}"${String(PA_STORE) === String(key) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  bar.innerHTML =
    `<select class="pa-store-sel" title="${cuT('Which store the counts answer for', '统计以哪个门店为准')}" onchange="paSetStore(this.value === 'all' ? 'all' : Number(this.value))">`
    + opt('all', cuT('All stores', '全部门店'))
    + PA_STORES.map(s => opt(s.id, cuT(s.name_en || s.code, s.name_cn || s.name_en || s.code))).join('')
    + '</select>';
  bar.style.display = '';
}

function paSetStore(key) {
  PA_STORE = key;
  try { localStorage.setItem('pa-store', String(key)); } catch {}
  paRenderStoreSeg();
  paRender();
}

// Display name for a store id, in the active language.
function _paStoreName(storeId) {
  const s = PA_STORES.find(x => x.id === storeId);
  return s ? cuT(s.name_en || s.code, s.name_cn || s.name_en || s.code) : '';
}

// Per-store stock for one product (number, default 0).
function _paStoreQty(productId, storeId) {
  const m = PA_STOCK[productId];
  return m ? (Number(m[storeId]) || 0) : 0;
}

// Mirror a just-saved per-store qty into the list's PA_STOCK cache + the
// product's effective_stock, so the overview table's Stock column and the OOS
// badges/KPIs stay honest after an edit made from inside the product editor
// (the inline list edit already does this; the editor save path didn't, which
// left the list showing the stale page-load value — e.g. "Out" after restock).
function _paStockMirror(productId, storeId, qty) {
  const pid = Number(productId), sid = Number(storeId);
  if (!PA_STOCK[pid]) PA_STOCK[pid] = {};
  PA_STOCK[pid][sid] = Math.max(0, Number(qty) || 0);
  const p = (PA_PRODUCTS || []).find(x => x.id === pid);
  if (p) p.effective_stock = Object.values(PA_STOCK[pid]).reduce((s, v) => s + (Number(v) || 0), 0);
}

// Save an edited per-store count. Writes via the inventory PATCH endpoint (which
// records a ledger row), then keeps the local maps + effective_stock in sync so
// the KPI tiles and grid badges stay honest without a full reload.
async function paSaveStoreStock(productId, storeId, raw, el) {
  const qty = Math.max(0, parseInt(raw, 10) || 0);
  el.classList.remove('is-saved', 'is-err');
  el.disabled = true;
  try {
    const res = await fetch(`/api/retail-admin/stores/${storeId}/stock/${productId}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ physical_qty: qty }),
    });
    // The endpoint always answers JSON; a body we can't parse means an HTTP error
    // (500/502/504, or a login-redirect HTML page) reached us. Read the body as
    // text and parse it ourselves so a non-JSON response surfaces the server's
    // real message (e.g. a SQLite/Express error) instead of Safari's opaque
    // "string did not match the expected pattern" JSON-parse error.
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    if (!res.ok || !j || !j.success) {
      const detail = (j && j.error) || (text || '').trim().slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`HTTP ${res.status} · ${detail}`);
    }
    if (!PA_STOCK[productId]) PA_STOCK[productId] = {};
    PA_STOCK[productId][storeId] = qty;
    el.value = qty;
    // Keep the amber/brick edge honest for the value just saved.
    const _lp = (PA_PRODUCTS || []).find(x => x.id === productId);
    el.classList.toggle('is-out', qty <= 0);
    el.classList.toggle('is-low', qty > 0 && qty <= paLowThreshold(_lp || {}, storeId));
    el.classList.add('is-saved');
    setTimeout(() => el.classList.remove('is-saved'), 1200);
    // Refresh this product's combined stock so OOS/low badges + KPIs follow.
    const p = (PA_PRODUCTS || []).find(x => x.id === productId);
    if (p) p.effective_stock = Object.values(PA_STOCK[productId] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    paRenderKpis(false);
  } catch (e) {
    el.classList.add('is-err');
    toast(cuT('Couldn’t save stock — ', '库存保存失败 — ') + e.message, 'err');
  } finally {
    el.disabled = false;
  }
}

// Populate the toolbar category filter from the distinct storefront top
// categories present in the catalogue (falling back to the legacy kitchen
// category string). Bilingual labels come from the canonical category tree
// when it's loaded. Idempotent — preserves the operator's current pick.
function paFillCatFilter() {
  const sel = document.getElementById('pa-filter');
  if (!sel) return;
  const cur = sel.value || 'all';
  const cnOf = {};
  (PA_CAT_TREE || []).forEach(t => { if (t && t.name) cnOf[t.name] = t.name_cn || ''; });
  const cats = [...new Set(PA_PRODUCTS
    .map(p => (p.top_category || p.category || '').trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="all">All categories · 全部分类</option>' +
    cats.map(c => {
      const cn = cnOf[c] ? ' · ' + escapeHtml(cnOf[c]) : '';
      return `<option value="${escapeAttr(c)}">${escapeHtml(c)}${cn}</option>`;
    }).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  paRenderCatChips(cats, cnOf);
  paFillSubFilter();   // keep the dependent subcategory select in sync
}

// Categories as a row of chips, the way the catalogue design shows them — one
// tap, count in view, no dropdown to open. The <select> stays in the DOM as the
// single source of truth (paRender and paFillSubFilter both read it); the chips
// just write to it, so nothing downstream had to learn a second way to ask.
function paRenderCatChips(cats, cnOf) {
  const box = document.getElementById('pa-chips');
  if (!box) return;
  const cur = (document.getElementById('pa-filter') || {}).value || 'all';
  const count = c => _paUnits(c === 'all'
    ? PA_PRODUCTS
    : PA_PRODUCTS.filter(p => (p.top_category || p.category || '').trim() === c)).length;
  const chip = (val, label) =>
    `<button type="button" class="pa-chip${cur === val ? ' is-on' : ''}" onclick="paPickCat('${escapeAttr(val)}')">`
    + `${escapeHtml(label)}<span class="pa-chip-n">${count(val)}</span></button>`;
  box.innerHTML = chip('all', cuT('All', '全部'))
    + cats.map(c => chip(c, cuT(c, cnOf[c] || c))).join('');
}
function paPickCat(val) {
  const sel = document.getElementById('pa-filter');
  if (!sel) return;
  sel.value = val;
  PA_PAGE = 1;
  paFillCatFilter();   // repaints the chips' own on-state too, and the subs
  paRender();
}

// Populate the toolbar SUBcategory filter for the currently-picked top category.
// Hidden when "All categories" is selected (nothing to narrow). Options = the
// canonical tree's subs that actually have products here, plus any stray
// subcategory string present on a product but missing from the tree (catches
// post-rename drift). Lets the operator isolate one subcategory and drag-to-
// reorder within just it — the reorder endpoint is slot-preserving, so shuffling
// only a subcategory's ids never disturbs the rest of the category.
function paFillSubFilter() {
  const top = document.getElementById('pa-filter');
  const sub = document.getElementById('pa-subfilter');
  if (!top || !sub) return;
  const cat = top.value;
  if (!cat || cat === 'all') {
    sub.innerHTML = '<option value="all">All subcategories · 全部子分类</option>';
    sub.value = 'all';
    sub.style.display = 'none';
    return;
  }
  const cur = sub.value || 'all';
  const node = (PA_CAT_TREE || []).find(t => t && t.name === cat);
  const treeSubs = node ? (node.subs || []) : [];
  const cnOf = {};
  treeSubs.forEach(s => { if (s && s.name) cnOf[s.name] = s.name_cn || ''; });
  const treeOrder = treeSubs.map(s => s.name).filter(Boolean);
  // Subcategories actually present on this category's products.
  const present = new Set(PA_PRODUCTS
    .filter(p => (p.top_category || p.category || '').trim() === cat)
    .map(p => (p.subcategory || '').trim())
    .filter(Boolean));
  const extras = [...present].filter(s => !treeOrder.includes(s)).sort((a, b) => a.localeCompare(b));
  const subs = [...treeOrder.filter(s => present.has(s)), ...extras];
  sub.innerHTML = '<option value="all">All subcategories · 全部子分类</option>' +
    subs.map(s => {
      const cn = cnOf[s] ? ' · ' + escapeHtml(cnOf[s]) : '';
      return `<option value="${escapeAttr(s)}">${escapeHtml(s)}${cn}</option>`;
    }).join('');
  sub.value = [...sub.options].some(o => o.value === cur) ? cur : 'all';
  sub.style.display = subs.length ? '' : 'none';
}

// "Has designer sections?" The catalogue list now sends a lightweight
// has_blocks flag instead of the full description_blocks JSON. But a row
// freshly patched in-place (paSaveEdit) carries the real description_blocks
// array from the save response — prefer that when present so the Designed
// badge updates immediately after an edit.
function _paHasBlocks(p) {
  if (!p) return false;
  if (Array.isArray(p.description_blocks)) return p.description_blocks.length > 0;
  return !!p.has_blocks;
}


// Overview table status cell — one badge answering "can a shopper buy this
// right now": Disabled (nothing live) beats Sold out (live but nothing on the
// shelf) beats Active. The Designed/Plain "has page design" marker is
// deliberately omitted here: this list is for scanning stock / price /
// category, and the design state lives in the editor + grid views.
// Supplier-direct and paused items answer the same question from their own
// flags — they hold no stock of ours, so a zero count must never read as sold
// out (the same rule _paStockCell follows for the stock column).
function _paStatusCell(u) {
  const members = u.group ? u.members : [u.p];
  if (!members.some(m => m.is_published === 1)) {
    return `<span class="pa-badge is-disabled"><i></i>${cuT('Disabled', '已下架')}</span>`;
  }
  const soldOut = u.p.ship_from_supplier
    ? !!u.p.supplier_paused
    : ((!u.group && u.p.is_bundle) ? _paBundleStock(u.p) : _paUnitStock(u)) <= 0;
  return soldOut
    ? `<span class="pa-badge is-soldout"><i></i>${cuT('Sold out', '缺货')}</span>`
    : `<span class="pa-badge is-active"><i></i>${cuT('Active', '在售')}</span>`;
}

// Inline "available on the shop" switch — flips is_published (the same flag the
// storefront filters on) straight from the catalogue, no need to open the
// editor. For a variant family the toggle is On when ANY size is live; flipping
// it sets every size at once. Persists via the per-product PATCH endpoint.
function _paShopToggle(u) {
  const members = u.group ? u.members : [u.p];
  const on = members.some(m => m.is_published === 1);
  const mixed = u.group && on && members.some(m => m.is_published !== 1);
  const ids = members.map(m => m.id).join(',');
  const title = on
    ? cuT('On the shop · tap to hide', '已上架 · 点按下架')
    : cuT('Off the shop · tap to show', '未上架 · 点按上架');
  return `<label class="pa-shop-toggle${on ? ' is-on' : ''}${mixed ? ' is-mixed' : ''}" title="${title}" onclick="event.stopPropagation()">`
    + `<input type="checkbox" ${on ? 'checked' : ''} onchange="paToggleShop('${ids}', this.checked)">`
    + `<span class="pa-shop-knob"></span></label>`;
}
// Optimistically flip the cached rows + repaint, then PATCH each id. Revert on
// failure so the switch never lies about the live state.
async function paToggleShop(ids, on) {
  const list = String(ids).split(',').map(Number).filter(Boolean);
  const val = on ? 1 : 0;
  const set = v => list.forEach(id => {
    const i = PA_PRODUCTS.findIndex(x => x.id === id);
    if (i >= 0) PA_PRODUCTS[i].is_published = v;
  });
  set(val); paRender(); paRenderKpis(false);
  try {
    for (const id of list) {
      await api('/api/retail-admin/products/' + id, { method: 'PATCH', body: { is_published: val } });
    }
  } catch (e) {
    set(on ? 0 : 1); paRender(); paRenderKpis(false);
    toast(cuT('Could not update availability — ', '无法更新上架状态 — ') + (e.message || e), 'err');
  }
}

// ── Overview list (full-width "products on the go" table) cell helpers ──
// A unit is either a lone product or a collapsed variant family; prices and
// stock fold across the family's members so the row reflects the whole product.
function _paUnitPrices(u) {
  const ps = (u.group ? u.members : [u.p])
    .map(m => Number(m.sell_price)).filter(v => v > 0);
  return ps.length ? { min: Math.min(...ps), max: Math.max(...ps) } : null;
}
function _paUnitStock(u) {
  // effective_stock = per-store physical sum (falls back to legacy stock_qty),
  // computed server-side. Sum across variant siblings for the family total.
  return (u.group ? u.members : [u.p])
    .reduce((s, m) => s + (Number(m.effective_stock) || 0), 0);
}
// ── Margin ───────────────────────────────────────────────────────────────────
// Gross margin on the SELLING price: (price − cost) / price. That is the retail
// convention and the one that pairs with the price beside it; markup-on-cost
// would read higher for the same pair and is not what this column means.
//
// Returns null whenever the answer is unknown rather than guessing a number.
// A NULL cost means "we have never bought this", which is NOT a cost of 0 — the
// whole reason the column is nullable. Every caller renders null as an em dash.
function _paMargin(price, cost) {
  if (cost == null || cost === '') return null;
  const p = Number(price), c = Number(cost);
  if (!Number.isFinite(p) || p <= 0) return null;   // no price → no margin to state
  if (!Number.isFinite(c) || c < 0) return null;
  return { money: p - c, pct: ((p - c) / p) * 100 };
}
// Is this product's cost owned by a recipe right now? Mirrors the server's
// recipeOwnsProductCost() exactly: a recipe is named AND Production is on. The
// feature state is already on the body as `feat-production`, the same signal
// every other Production-gated screen reads, so there is no second source.
function _pdRecipeOwnsCost(p) {
  return !!(p && p.recipe_id != null && document.body.classList.contains('feat-production'));
}
// Lock or release the Cost field, and say where the figure came from.
//
// READ-ONLY, NOT DISABLED. A disabled input is skipped by the form reader and
// greys its own text out; readOnly keeps the number legible and copyable while
// still refusing edits. The operator can still SEE what it costs — that is the
// point of showing it at all.
//
// Turning Production off releases the field with the last figure still in it:
// nothing is erased, it simply stops tracking the recipe and becomes editable
// again, which is the pre-recipe behaviour intact.
function pdApplyCostSource(p) {
  const inp = document.getElementById('pd-cost');
  const note = document.getElementById('pd-cost-source');
  if (!inp) return;
  // §31's addendum (docs/tacet-consolidation-decisions.md): once a product has
  // a BUILD LIST, that list is its only cost source — so the manual field goes
  // read-only and the save skips unit_cost (see the readOnly check in the save
  // payload below), leaving the figure to the server's own recompute. This is
  // checked FIRST and independently of the recipe: a build list outranks a
  // recipe link, exactly as applyProductCosts() now skips a product that has
  // one (lib/recipe-rollup.js). Two writers on one column is what this
  // prevents, on the screen as well as in the cascade.
  const hasBuild = (typeof blHasLines === 'function') && blHasLines();
  // recipeOwned stays the RECIPE question and nothing else — every line below
  // that names a recipe reads this, not `owned`. Conflating the two would show
  // "Link a recipe" copy, and fetch recipe health, for a product whose cost
  // comes from a build list and may have no recipe at all.
  const recipeOwned = _pdRecipeOwnsCost(p);
  const owned = hasBuild || recipeOwned;
  inp.readOnly = owned;
  inp.classList.toggle('is-derived', owned);
  // Whatever Recipes would be warning about this recipe, said here too. Hung
  // off this function rather than pdOpen because EVERY repaint of the cost
  // source is also a moment the warning can have changed — opening a product,
  // linking, changing the link, unlinking — and one call site cannot go stale.
  pdRecipeHealthPaint(recipeOwned ? (p && p.id) : null);
  if (!note) return;
  // A BUILD LIST OUTRANKS THE RECIPE LINE, and says so plainly. A product can
  // carry both (recipe_id survives for the allergen rollup, §31's addendum),
  // and if this branch were missing, such a product would read "From recipe"
  // beside a figure the recipe did not produce — the screen lying about where
  // its own number came from.
  if (hasBuild) {
    note.style.display = '';
    // CN PENDING — this names the build list, and "Build list" has no sourced
    // Chinese (Ash, 2026-08-27), so neither does this. English on both halves
    // deliberately. Gluing sourced 来自 to sourced 物料 would invent a phrase
    // no Chinese reader has approved, and 物料 alone means MATERIALS — the
    // masterlist, not this product's list of them.
    let h = escapeHtml(cuT('From the build list', 'From the build list'));
    // THE RECIPE LINK SURVIVES A BUILD LIST AND MUST STAY REACHABLE.
    //
    // An earlier pass returned here, which hid the recipe's name, Change and
    // Unlink the moment a product got its first build line. That was wrong on
    // its own terms: §31's addendum retires recipe_id as a COST source and
    // keeps it for the allergen rollup, so the link is still live, still
    // meaningful, and still the operator's to change — and there is no other
    // screen that offers it. Reported by Ash within the hour: "i cant connect
    // it to a recipe?".
    //
    // What changed is only which of the two owns the money. So the line says
    // the build list owns the cost, and then names the recipe as the separate
    // fact it now is.
    if (recipeOwned && p && p.recipe_id != null) {
      const rn = cuT(p.recipe_name_en || p.recipe_name_cn || '', p.recipe_name_cn || p.recipe_name_en || '')
                 || (cuT('Recipe', '配方') + ' #' + p.recipe_id);
      h += ' · ' + escapeHtml(cuT('Recipe', '配方')) + ' '
        + '<a href="#" onclick="event.preventDefault();event.stopPropagation();paOpenRecipe(' + Number(p.recipe_id) + ')">'
        + escapeHtml(rn) + '</a>'
        + ' <button type="button" class="pd-cost-act" onclick="pdRecipeLinkOpen()">'
        + escapeHtml(cuT('Change', '更换')) + '</button>'
        + ' <button type="button" class="pd-cost-act" onclick="pdRecipeUnlink()">'
        + escapeHtml(cuT('Unlink', '取消关联')) + '</button>';
    } else if (_pdCanLinkRecipe() && p && p.id) {
      h += ' <button type="button" class="pd-cost-act" onclick="pdRecipeLinkOpen()">'
        + escapeHtml(cuT('Link a recipe', '关联配方')) + '</button>';
    }
    note.innerHTML = h;
    return;
  }
  // A product that has never been saved has no row to link a recipe to, so the
  // line stays empty until it does. Everything below needs an id.
  const linkable = _pdCanLinkRecipe() && !!(p && p.id);
  if (!recipeOwned && !linkable) { note.innerHTML = ''; note.style.display = 'none'; return; }
  note.style.display = '';
  if (!recipeOwned) {
    // UNLINKED, AND SAYING SO IS THE POINT. Cost sat blank on 45 products whose
    // recipe was fully priced, with nothing on screen to suggest the two could
    // be connected — the one-time backfill (database.js) links only where two
    // of {SKU, name_en, name_cn} match exactly, and the "confirm the rest by
    // hand" path it assumed was never built. This is it.
    note.innerHTML = '<button type="button" class="pd-cost-act" onclick="pdRecipeLinkOpen()">'
      + escapeHtml(cuT('Link a recipe', '关联配方')) + '</button>';
    return;
  }
  const rname = cuT(p.recipe_name_en || p.recipe_name_cn || '', p.recipe_name_cn || p.recipe_name_en || '')
                || (cuT('Recipe', '配方') + ' #' + p.recipe_id);
  // The recipe is named AND reachable — the operator can go read why the number
  // is what it is instead of taking it on trust. Change/Unlink sit beside it
  // because a wrong link is exactly as likely as a missing one, and the field
  // itself is read-only now: without these there is no way back out.
  note.innerHTML = escapeHtml(cuT('From recipe', '来自配方')) + ' '
    + '<a href="#" onclick="event.preventDefault();event.stopPropagation();paOpenRecipe(' + Number(p.recipe_id) + ')">'
    + escapeHtml(rname) + '</a>'
    + ' <button type="button" class="pd-cost-act" onclick="pdRecipeLinkOpen()">'
    + escapeHtml(cuT('Change', '更换')) + '</button>'
    + ' <button type="button" class="pd-cost-act" onclick="pdRecipeUnlink()">'
    + escapeHtml(cuT('Unlink', '取消关联')) + '</button>';
}
// ── Is the recipe behind this cost healthy? ─────────────────────────────────
//
// THE ALARM BELONGS WHERE THE NUMBER IS READ. A recipe with an unpriced
// ingredient line still produces a cost — it just produces one that is too low
// — and Recipes says so on the record and in the list. This is that same
// warning, on the screen where the operator is setting a price against the
// figure. Without it the editor showed ¥3.97 with nothing to suggest the real
// number is higher.
//
// SAME WORDS AS THE RECIPE SCREEN, on purpose: an operator who reads
// "N ingredients missing cost — costs shown are too low" here and then opens
// the recipe must meet the sentence they already read, not a paraphrase of it.
//
// FETCHED, NEVER CARRIED ON THE ROW: the fix happens on the OTHER screen, so a
// flag cached in the products list would still be warning after the ingredient
// was priced. One request, and only for a product whose cost a recipe owns.
const PD_ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
let _pdHealthSeq = 0;
function pdRecipeHealthPaint(id) {
  const host = document.getElementById('pd-cost-alert');
  if (!host) return;
  // Clear first and bump the sequence, so a slow answer about the product that
  // was open a moment ago can never paint over the one that is open now.
  const mySeq = ++_pdHealthSeq;
  host.innerHTML = ''; host.style.display = 'none';
  if (!id) return;
  fetch('/api/retail-admin/products/' + id + '/recipe-health', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(j => {
      if (mySeq !== _pdHealthSeq) return;
      if (!j || !j.success) throw new Error('load_failed');
      const d = j.data;
      if (!d) return;                       // nothing linked, or Production off
      const pills = [];
      // ARCHIVED — the rollup refuses to cost an archived recipe, so the figure
      // in the field has stopped moving. Both halves of this sentence are the
      // recipe screen's own (BLOCK_REASON.recipe_archived, and the material
      // line's frozen note); 食谱 is written 配方 to match every other recipe
      // word in this editor.
      if (!d.recipe_active) {
        pills.push(pdCostPill(cuT('This recipe is archived — frozen at its last computed value.',
                                  '该配方已归档。已冻结为最近一次计算的值。')));
      }
      // MISSING INGREDIENT COSTS — the figure is real but understated. Worded
      // exactly as 19-recipes.js paintSummary() words it.
      const n = Number(d.missing) || 0;
      if (n > 0) {
        pills.push(pdCostPill(cuT(n + ' ingredient' + (n === 1 ? '' : 's') + ' missing cost — costs shown are too low',
                                  n + ' 项原料缺少成本 — 显示成本偏低')));
      }
      // NO COST AT ALL — the cascade writes nothing, so whatever sits in the
      // field is stale or blank. The same sentence the link modal shows at link
      // time, which until now was the only moment it was ever said.
      const cps = Number(d.cost_per_serving);
      if (d.cost_per_serving == null || !Number.isFinite(cps) || cps <= 0) {
        pills.push(pdCostPill(cuT('This recipe has no cost yet — it needs servings, a batch size, and a price on every ingredient.',
                                  '该配方暂无成本 —— 需要填写份数、批量大小，并为每项原料填写价格。')));
      }
      if (!pills.length) return;
      host.innerHTML = pills.join('');
      host.style.display = '';
    })
    .catch(() => {
      if (mySeq !== _pdHealthSeq) return;
      // A check that could not run must say so. Silence here would read as
      // "the recipe is fine", which is the one thing this line exists to stop
      // the screen from implying.
      host.innerHTML = '<div class="pd-cost-warn is-quiet">' + escapeHtml(cuT('Couldn’t load the recipe', '无法加载配方')) + '</div>';
      host.style.display = '';
    });
}
// One warning, as a pill — the shape Recipes uses (retail-admin.css .rcp-warn):
// a tinted pill that says its piece and stops, never a panel that floods the
// field it is explaining.
function pdCostPill(text) {
  return '<div class="pd-cost-warn">' + PD_ICON_WARN + '<span>' + escapeHtml(text) + '</span></div>';
}
// Can a recipe be linked here at all? Recipes only exist as a screen when
// Production is on, so offering the action with it off would point the operator
// at a section that isn't there — and the cascade would write nothing anyway.
function _pdCanLinkRecipe() {
  return document.body.classList.contains('feat-production');
}
// ── Pick the recipe this product's cost comes from ───────────────────────
//
// PREFILLED WITH THE PRODUCT'S OWN SKU, because that is the signal that
// identifies the right recipe in nearly every unlinked case: the backfill's
// group B was "SKU matches, nothing else does" — a typo in the recipe's English
// name or a suffix on its Chinese one. Opening the modal therefore usually
// shows the one right answer already on screen, and the operator's whole job is
// to confirm it. Still a search box, not an auto-link: confirming a match a
// human can see is the entire reason this is a hand-path.
//
// Centered modal via askCustom (public/tacet-dialogs.js) — the same shell
// 19-recipes.js's materialize modal uses, so this is not a second dialog build.
async function pdRecipeLinkOpen() {
  const id = Number(document.getElementById('pd-id').value || 0);
  if (!id) return;
  const p = (PA_PRODUCTS || []).find(x => x.id === id);
  if (!p) return;
  // Flush a pending autosave FIRST. It may still be carrying a hand-typed cost
  // from before the link; letting it land afterwards would overwrite the figure
  // the cascade is about to write. (The server drops unit_cost once a recipe
  // owns it, so this is belt-and-braces — but the ordering is free.)
  if (_pdAutoTimer) {
    clearTimeout(_pdAutoTimer); _pdAutoTimer = null;
    try { await pdAutoSaveNow(); } catch (e) {}
  }

  const st = { results: [], selected: null, timer: null, loading: false };
  const bodyHtml =
    '<h3 class="tdlg-title">' + escapeHtml(cuT('Link a recipe', '关联配方')) + '</h3>'
    + '<p class="tdlg-msg">' + escapeHtml(cuT(
        'The cost of this product is then worked out from the recipe, and updates whenever the recipe does.',
        '关联后，本产品的成本将由该配方计算得出，并随配方更新。')) + '</p>'
    + '<div class="tdlg-field"><label for="pdrl-search">' + escapeHtml(cuT('Search recipes', '搜索配方')) + '</label>'
    + '<input id="pdrl-search" type="text" autocomplete="off" placeholder="'
    + escapeHtml(cuT('Name or SKU…', '名称或货号…')) + '" value="' + escapeHtml(p.sku || '') + '"></div>'
    + '<div id="pdrl-results"></div>'
    + '<div id="pdrl-selected"></div>'
    + '<div class="pdrl-hint" id="pdrl-hint"></div>';
  const footHtml =
    '<button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>' + escapeHtml(cuT('Cancel', '取消')) + '</button>'
    + '<button type="button" class="tdlg-btn tdlg-btn--primary" data-submit disabled>'
    + escapeHtml(cuT('Link', '关联')) + '</button>';
  const { scrim, closer } = askCustom('tdlg-neutral pdrl-modal', bodyHtml, footHtml, '#pdrl-search');
  const close = () => closer(null);
  scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));
  const submitBtn = scrim.querySelector('[data-submit]');
  const searchEl = scrim.querySelector('#pdrl-search');

  // Cost per serving IS the cost of one sellable unit — the same figure
  // lib/recipe-rollup.js's applyProductCosts writes — so this column shows the
  // operator the number they are about to adopt, not a batch total they would
  // have to divide. A recipe that can't produce one is labelled rather than
  // hidden: it is still the right recipe, it just needs finishing first.
  const costLabel = r => (r.costPerServing != null && Number.isFinite(r.costPerServing) && r.costPerServing > 0)
    ? paMoney(r.costPerServing)
    : cuT('no cost yet', '暂无成本');
  function renderResults() {
    const host = scrim.querySelector('#pdrl-results');
    if (st.loading) { host.innerHTML = '<div class="pdrl-empty">' + escapeHtml(cuT('Searching…', '搜索中…')) + '</div>'; return; }
    if (!st.results.length) {
      host.innerHTML = searchEl.value.trim()
        ? '<div class="pdrl-empty">' + escapeHtml(cuT('No recipe matches that.', '没有匹配的配方。')) + '</div>' : '';
      return;
    }
    host.innerHTML = '<div class="pdrl-pick">' + st.results.slice(0, 8).map(r =>
        '<div class="pdrl-pick-item" data-id="' + r.id + '">'
      + '<span>' + escapeHtml(r.name_en || r.name_cn || '')
      + (r.sku ? ' <span class="s">' + escapeHtml(r.sku) + '</span>' : '') + '</span>'
      + '<span class="s">' + escapeHtml(costLabel(r)) + '</span></div>').join('') + '</div>';
    host.querySelectorAll('.pdrl-pick-item').forEach(el => el.addEventListener('click', () => {
      st.selected = st.results.find(r => r.id === Number(el.dataset.id)) || null;
      host.innerHTML = '';
      searchEl.value = st.selected ? (st.selected.name_en || st.selected.name_cn || '') : '';
      renderSelected(); updateSubmitState();
    }));
  }
  function renderSelected() {
    const host = scrim.querySelector('#pdrl-selected');
    if (!st.selected) { host.innerHTML = ''; return; }
    const r = st.selected;
    const usable = r.costPerServing != null && Number.isFinite(r.costPerServing) && r.costPerServing > 0;
    // Soft warning, never blocking — the same shape as the materialize modal's.
    // Linking a recipe that can't yet be costed is a legitimate thing to do; it
    // just must not look like it produced a number.
    const warn = usable ? ''
      : '<div class="pdrl-warn">' + escapeHtml(cuT(
          'This recipe has no cost yet — it needs servings, a batch size, and a price on every ingredient. The link is saved either way, and the cost appears as soon as the recipe can be costed.',
          '该配方暂无成本 —— 需要填写份数、批量大小，并为每项原料填写价格。关联仍会保存，配方可计算成本后即会显示。')) + '</div>';
    host.innerHTML = '<div class="pdrl-selline">' + escapeHtml(cuT('Selected: ', '已选择：'))
      + '<b>' + escapeHtml(r.name_en || r.name_cn || '') + '</b>'
      + (usable ? ' — ' + escapeHtml(cuT('cost', '成本') + ' ' + paMoney(r.costPerServing)) : '')
      + '</div>' + warn;
  }
  function updateSubmitState() {
    const reason = st.selected ? null : cuT('Pick a recipe to link.', '请选择要关联的配方。');
    submitBtn.disabled = !!reason;
    const hint = scrim.querySelector('#pdrl-hint');
    if (hint) hint.textContent = reason || '';
  }
  async function runSearch() {
    const q = searchEl.value.trim();
    if (!q) { st.results = []; st.loading = false; renderResults(); return; }
    st.loading = true; renderResults();
    try {
      const j = await api('/api/retail-admin/recipes?search=' + encodeURIComponent(q));
      // Already linked to THIS product is not a candidate — picking it again
      // would be a no-op the operator can't tell from a failure.
      st.results = (j.data || []).filter(r => r.id !== p.recipe_id);
    } catch (e) { st.results = []; }
    st.loading = false;
    renderResults();
  }
  searchEl.addEventListener('input', () => {
    clearTimeout(st.timer);
    st.selected = null; renderSelected(); updateSubmitState();
    st.timer = setTimeout(runSearch, 220);
  });

  submitBtn.addEventListener('click', async () => {
    if (!st.selected) return;
    submitBtn.disabled = true;
    try {
      const j = await api('/api/retail-admin/products/' + id + '/recipe-link',
        { method: 'PUT', body: { recipe_id: st.selected.id } });
      close();
      pdRecipeLinkApplied(id, j.data);
      // The server's warning names the one thing that stops the number arriving
      // (Production off, or a recipe that can't be costed yet) — carried through
      // verbatim rather than replaced by a generic "done".
      toast(j.warning || cuT('Cost now comes from the recipe', '成本已改为来自配方'),
        'ok', j.warning ? 6000 : undefined);
    } catch (e) {
      submitBtn.disabled = false;
      toast(cuT('Could not link', '关联失败') + ': ' + ((e && e.message) || ''), 'err');
    }
  });

  updateSubmitState();
  // The SKU is already in the box — search on it immediately, so the match this
  // was built for is on screen before the operator types anything.
  runSearch();
}
// Fold a link/unlink response back into the loaded editor and the list cache.
// Same convention pdSaveCore uses after a PATCH: merge the returned columns
// onto the cached row, then repaint from that row — never patch the DOM and the
// cache separately and hope they agree.
function pdRecipeLinkApplied(id, data) {
  if (!data) return;
  const i = (PA_PRODUCTS || []).findIndex(x => x.id === Number(id));
  const row = i >= 0 ? (PA_PRODUCTS[i] = { ...PA_PRODUCTS[i], ...data }) : null;
  // Only repaint the editor if it is still showing this product — the operator
  // may have moved on while the request was in flight.
  if (Number(document.getElementById('pd-id').value || 0) === Number(id)) {
    const inp = document.getElementById('pd-cost');
    if (inp) inp.value = data.unit_cost != null ? data.unit_cost : '';
    pdApplyCostSource(row || data);
    pdRenderMargin();
  }
  try { paRender(); paApplyRowSelection(); } catch (e) {}
}
// Hand the Cost field back to purchase-order receiving and manual entry.
// Confirmed rather than instant: the figure stops tracking the recipe, which is
// not something to discover later from a stale number.
async function pdRecipeUnlink() {
  const id = Number(document.getElementById('pd-id').value || 0);
  if (!id) return;
  const ok = await askConfirm({
    titleEn: 'Stop taking the cost from this recipe?', titleCn: '不再从该配方获取成本？',
    bodyEn: 'The last figure stays on the product and the Cost field becomes editable again. The recipe is not changed.',
    bodyCn: '最近一次计算出的成本会保留在产品上，成本字段将恢复为可编辑。配方本身不会改变。',
    confirmEn: 'Unlink', confirmCn: '取消关联',
  });
  if (!ok) return;
  try {
    const j = await api('/api/retail-admin/products/' + id + '/recipe-link', { method: 'DELETE' });
    pdRecipeLinkApplied(id, j.data);
    toast(cuT('Unlinked', '已取消关联'));
  } catch (e) {
    toast(cuT('Could not unlink', '取消关联失败') + ': ' + ((e && e.message) || ''), 'err');
  }
}
// Open the linked recipe. The recipe record is a full page on the Production
// side (`#tab-recipes-record`, opened by rcpRecordOpen) — this hands off to it
// rather than duplicating any of the recipe UI inside the product editor.
// goTab first, because rcpRecordOpen renders into a section that has to be the
// live one; if either is missing the link simply does nothing rather than
// throwing inside an onclick.
function paOpenRecipe(recipeId) {
  const id = Number(recipeId);
  if (!id) return;
  try {
    if (typeof goTab === 'function') goTab('recipes');
    if (typeof window.rcpRecordOpen === 'function') window.rcpRecordOpen(id);
  } catch (e) { console.error('[products] could not open recipe', id, e); }
}
// The margin line under the editor's Cost field: money difference AND percentage,
// so neither has to be worked out from the other.
function pdRenderMargin() {
  const el = document.getElementById('pd-margin');
  if (!el) return;
  const g = id => { const n = document.getElementById(id); return n ? n.value : ''; };
  const m = _paMargin(g('pd-price'), g('pd-cost').trim());
  if (!m) { el.textContent = cuT('Margin — add a cost to see it', '毛利 — 填写成本后显示'); return; }
  const sign = m.money < 0 ? '−' : '';
  el.textContent = cuT('Margin', '毛利') + ' ' + sign + paMoney(Math.abs(m.money))
                 + ' · ' + m.pct.toFixed(1) + '%'
                 + (m.money < 0 ? ' — ' + cuT('selling below cost', '低于成本销售') : '');
}
function _paPriceCell(u) {
  const pr = _paUnitPrices(u);
  if (!pr) return '<span class="pa-col-price pa-col-muted">—</span>';
  // Single price keeps the cents (¥89.00); a range drops trailing .00 so it
  // reads compact (¥57–89), matching the catalogue mockup.
  const short = n => fmt(n).replace(/\.00$/, '');
  const body = pr.min === pr.max ? `¥${fmt(pr.min)}` : `¥${short(pr.min)}–${short(pr.max)}`;
  return `<span class="pa-col-price">${body}</span>`;
}
// Margin column: PERCENTAGE only. The money difference lives in the editor,
// beside the two numbers it is drawn from; on a list scanned down a screen the
// percentage is the comparable figure and a second ¥ column next to Price would
// read as a second price.
//
// Collapses a variant family exactly as _paPriceCell does — one figure when the
// members agree, a range when they differ — because the members are sizes of one
// product and a family that shows only its first size's margin is a lie.
//
// An unknown cost is an em dash, never 0%. Members with no cost are left out of
// the range rather than dragged to 100%.
function _paMarginCell(u) {
  const ms = (u.group ? u.members : [u.p])
    .map(m => _paMargin(m.sell_price, m.unit_cost))
    .filter(Boolean)
    .map(m => m.pct);
  if (!ms.length) return '<span class="pa-col-margin pa-col-muted">—</span>';
  const lo = Math.min(...ms), hi = Math.max(...ms);
  // One decimal for a single figure; whole numbers across a range, so the cell
  // stays narrow — the same "drop the noise on a range" rule the price cell uses.
  const body = Math.abs(hi - lo) < 0.05
    ? lo.toFixed(1) + '%'
    : Math.round(lo) + '–' + Math.round(hi) + '%';
  return `<span class="pa-col-margin${hi < 0 ? ' pa-col-muted' : ''}">${body}</span>`;
}
// Stock badge: green = healthy, brass = low (≤5), red = out (0). The number is
// the family's effective stock; an unpublished product still shows its count.
// When a single store is picked in the switcher the cell shows THAT store's
// count — an editable input for a lone product, a read-only total for a variant
// family (each size has its own count, set by opening the product).
function _paStockCell(u) {
  // Supplier-direct items hold no stock of ours — they never go "Out". Show an
  // availability badge instead of a count (in every store view), red only when
  // the operator paused selling.
  if (u.p.ship_from_supplier) {
    const paused = !!u.p.supplier_paused;
    const cls = paused ? 'is-out' : '';
    const label = paused ? cuT('Paused', '暂停') : cuT('Available', '有货');
    const title = paused
      ? cuT('Supplier paused — not orderable', '供应商缺货，已暂停销售')
      : cuT('Ships from supplier — always available', '供应商直发，始终有货');
    return `<span class="pa-stock ${cls}" title="${title}"><span class="pa-stock-dot"></span>${label}</span>`;
  }
  // Assembled bundle — stock is computed from its components, never typed. Show
  // the derived count read-only (in every store view) so the operator can't set a
  // meaningless number on a row that has no stock of its own.
  if (!u.group && u.p.is_bundle) {
    const q = _paBundleStock(u.p);
    const c = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p, PA_STORE) ? 'is-low' : '');
    return `<span class="pa-stock pa-stock-locked ${c}" title="${cuT('Made from other products — stock follows the parts', '由其他产品组成 — 库存取决于组成商品')}"><span class="pa-stock-dot"></span>${q <= 0 ? cuT('Out', '缺货') : q}</span>`;
  }
  if (PA_STORE !== 'all' && PA_STOCK_LOADED) {
    if (u.group) {
      const q = u.members.reduce((s, m) => s + _paStoreQty(m.id, PA_STORE), 0);
      const c = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p, PA_STORE) ? 'is-low' : '');
      return `<span class="pa-stock pa-stock-locked ${c}" title="${cuT('Open the product to set each size’s stock', '打开产品以分别设置各规格库存')}"><span class="pa-stock-dot"></span>${q <= 0 ? cuT('Out', '缺货') : q}</span>`;
    }
    const q = _paStoreQty(u.p.id, PA_STORE);
    return `<input class="pa-stock-input" type="number" min="0" inputmode="numeric" value="${q}"`
      + ` aria-label="${cuT('Stock', '库存')}" onclick="event.stopPropagation()"`
      + ` onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"`
      + ` onchange="event.stopPropagation(); paSaveStoreStock(${u.p.id}, ${PA_STORE}, this.value, this)">`;
  }
  const qty = _paUnitStock(u);
  const cls = qty <= 0 ? 'is-out' : (qty <= paLowThreshold(u.p) ? 'is-low' : '');
  const label = qty <= 0 ? cuT('Out', '缺货') : String(qty);
  return `<span class="pa-stock ${cls}"><span class="pa-stock-dot"></span>${label}</span>`;
}
// Stores that get their own always-visible editable stock column in the overview
// list. Only when 2+ stores are live and the grid has loaded — a single-store
// tenant keeps the plain combined Stock column (see _paStockCell).
function _paListStores() {
  return (PA_STOCK_LOADED && PA_STORES.length >= 2) ? PA_STORES : [];
}

// One store's stock cell for the two-location list: an editable box for a lone
// product, a read-only rollup for a variant family / assembled bundle /
// supplier-direct item (those carry no per-store editable count of their own,
// so they show the same badge in every store column). Mirrors _paStockCell's
// per-case logic, scoped to one storeId.
function _paStoreStockCell(u, storeId) {
  if (u.p.ship_from_supplier) {
    const paused = !!u.p.supplier_paused;
    const label = paused ? cuT('Paused', '暂停') : cuT('Available', '有货');
    const title = paused
      ? cuT('Supplier paused — not orderable', '供应商缺货，已暂停销售')
      : cuT('Ships from supplier — always available', '供应商直发，始终有货');
    return `<span class="pa-stock ${paused ? 'is-out' : ''}" title="${title}"><span class="pa-stock-dot"></span>${label}</span>`;
  }
  if (!u.group && u.p.is_bundle) {
    const q = _paBundleStock(u.p, storeId);
    const c = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p, storeId) ? 'is-low' : '');
    return `<span class="pa-stock pa-stock-locked ${c}" title="${cuT('Made from other products — stock follows the parts', '由其他产品组成 — 库存取决于组成商品')}"><span class="pa-stock-dot"></span>${q <= 0 ? cuT('Out', '缺货') : q}</span>`;
  }
  if (u.group) {
    const q = u.members.reduce((s, m) => s + _paStoreQty(m.id, storeId), 0);
    const c = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p, storeId) ? 'is-low' : '');
    return `<span class="pa-stock pa-stock-locked ${c}" title="${cuT('Open the product to set each size’s stock', '打开产品以分别设置各规格库存')}"><span class="pa-stock-dot"></span>${q <= 0 ? cuT('Out', '缺货') : q}</span>`;
  }
  const q = _paStoreQty(u.p.id, storeId);
  const state = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p, storeId) ? 'is-low' : '');
  return `<input class="pa-stock-input ${state}" type="number" min="0" inputmode="numeric" value="${q}"`
    + ` aria-label="${escapeAttr(_paStoreName(storeId) + ' ' + cuT('stock', '库存'))}" onclick="event.stopPropagation()"`
    + ` onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"`
    + ` onchange="event.stopPropagation(); paSaveStoreStock(${u.p.id}, ${storeId}, this.value, this)">`;
}
function _paCatCell(u) {
  const c = (u.p.top_category || u.p.category || '').trim();
  return c ? escapeHtml(c) : '<span class="pa-col-muted">—</span>';
}

// Variant siblings (same variant_group_id) are ONE product in different sizes,
// not separate products — collapse them into a single card so the grid doesn't
// read as duplicates. Returns display units in the original row order; a group
// renders once (at its first surviving member's spot) when 2+ of its members
// pass the active search/filter, otherwise the lone survivor is a normal card.
function _paUnits(rows) {
  const byGid = new Map();
  rows.forEach(p => {
    const gid = p.variant_group_id;
    if (!gid) return;
    if (!byGid.has(gid)) byGid.set(gid, []);
    byGid.get(gid).push(p);
  });
  const units = [], seen = new Set();
  rows.forEach(p => {
    const gid = p.variant_group_id;
    if (!gid) { units.push({ group: false, p }); return; }
    if (seen.has(gid)) return;
    seen.add(gid);
    // Order siblings by the operator's chosen order (variant_sort, set by
    // drag-to-reorder in the editor) so the card's size chips match the shop.
    const members = byGid.get(gid).slice().sort((a, b) =>
      ((a.variant_sort ?? 0) - (b.variant_sort ?? 0)) ||
      String(a.variant_label || '').localeCompare(String(b.variant_label || '')) ||
      (a.id - b.id));
    if (members.length < 2) { units.push({ group: false, p: members[0] }); return; }
    // Open the group owner (id === gid) so the editor's variant rows list all
    // siblings; fall back to the first member if the owner was filtered out.
    const rep = members.find(m => m.id === gid) || members[0];
    units.push({ group: true, p: rep, members });
  });
  return units;
}
// Per-size tag on a collapsed card: the operator's label (Small/Big) if set,
// else the size/weight, else the SKU.
function _paVariantTag(m) {
  return escapeHtml((m.variant_label || '').trim() || m.size || m.sku || '—');
}

// ── Drag-to-reorder (list overview, single category) ───────────────────────
// PA_REORDER_UNITS mirrors the rows on screen as lists of product ids (a variant
// group is one entry holding all its sibling ids). paRowDrop splices that array
// into the new order, flattens it to ids, and reorders the matching slots inside
// PA_PRODUCTS so the re-render shows the move immediately; the server then
// redistributes sort_order across the same ids (POST …/products/reorder).
let PA_REORDER_UNITS = null;
let _paDragFrom = null;

// ── Edge auto-scroll while dragging a row ───────────────────────────────────
// Native HTML5 drag barely auto-scrolls (and not at all when the drag began on
// the tiny grip), so dropping a product at the TOP of a long list meant manual
// scrolling first. We drive our own scroll: a generous 160px band near the top
// / bottom edge ramps speed by how close the cursor is, so "scroll up" engages
// easily the moment you near the top.
let _paScrollRAF = null, _paScrollDir = 0, _paScrollSpeed = 0;
function _paScrollTarget() {
  // Use an inner scroller wrapped around the list if there is one; otherwise the
  // whole page scrolls — fall back to the document scroller.
  let el = document.getElementById('tab-products');
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
function _paAutoScrollTick() {
  if (!_paScrollDir) { _paScrollRAF = null; return; }
  _paScrollTarget().scrollTop += _paScrollDir * _paScrollSpeed;
  _paScrollRAF = requestAnimationFrame(_paAutoScrollTick);
}
function _paDragAutoScroll(clientY) {
  const BAND = 160, MAX = 26;            // big band + brisk max = easy to trigger
  const top = BAND, bot = window.innerHeight - BAND;
  let dir = 0, frac = 0;
  if (clientY < top)      { dir = -1; frac = (top - clientY) / BAND; }
  else if (clientY > bot) { dir =  1; frac = (clientY - bot) / BAND; }
  _paScrollDir = dir;
  _paScrollSpeed = dir ? Math.max(5, Math.min(1, frac) * MAX) : 0;
  if (dir && !_paScrollRAF) _paScrollRAF = requestAnimationFrame(_paAutoScrollTick);
}
function _paStopAutoScroll() {
  _paScrollDir = 0; _paScrollSpeed = 0;
  if (_paScrollRAF) { cancelAnimationFrame(_paScrollRAF); _paScrollRAF = null; }
}
// Document-level so the band still works in the row gaps and off to the side,
// not only when the cursor is directly over a row.
function _paDocDragOver(ev) { if (_paDragFrom !== null) _paDragAutoScroll(ev.clientY); }

function paRowDragStart(ev, idx) {
  _paDragFrom = idx;
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', String(idx)); } catch (e) {}
  document.addEventListener('dragover', _paDocDragOver);
  const row = ev.target.closest('.pa-row');
  // Drag the whole row, not just the tiny grip, as the ghost image.
  if (row) { try { ev.dataTransfer.setDragImage(row, 24, 18); } catch (e) {}
             setTimeout(() => row.classList.add('pa-row-dragging'), 0); }
}
function paRowDragEnd() {
  _paDragFrom = null;
  document.removeEventListener('dragover', _paDocDragOver);
  _paStopAutoScroll();
  document.querySelectorAll('.pa-row-dragging').forEach(el => el.classList.remove('pa-row-dragging'));
  document.querySelectorAll('.pa-row-drop').forEach(el => el.classList.remove('pa-row-drop'));
}
function paRowDragOver(ev, idx) {
  if (_paDragFrom === null) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const row = ev.currentTarget;
  document.querySelectorAll('.pa-row-drop').forEach(el => { if (el !== row) el.classList.remove('pa-row-drop'); });
  if (idx !== _paDragFrom) row.classList.add('pa-row-drop');
}
function paRowDragLeave(ev) { ev.currentTarget.classList.remove('pa-row-drop'); }
function paRowDrop(ev, idx) {
  if (_paDragFrom === null || !Array.isArray(PA_REORDER_UNITS)) return;
  ev.preventDefault();
  const from = _paDragFrom, to = idx;
  paRowDragEnd();
  if (from === to) return;
  const units = PA_REORDER_UNITS;
  const moved = units.splice(from, 1)[0];
  units.splice(to, 0, moved);
  const newIds = units.flat();
  // Reorder ONLY these ids' slots within PA_PRODUCTS — every other product (and
  // category) keeps its place, mirroring the server's slot-preserving write.
  const catIds = new Set(newIds);
  const byId = new Map(PA_PRODUCTS.map(p => [p.id, p]));
  let k = 0;
  PA_PRODUCTS = PA_PRODUCTS.map(p => catIds.has(p.id) ? byId.get(newIds[k++]) : p);
  paRender();
  paPersistOrder(newIds);
}
async function paPersistOrder(ids) {
  if (!Array.isArray(ids) || ids.length < 2) return;
  try {
    await api('/api/retail-admin/products/reorder', { method: 'POST', body: { ids } });
  } catch (e) {
    toast((e && e.message) ? (cuT('Reorder failed: ', '排序失败:') + e.message) : 'Reorder failed · 排序未保存', 'err');
    paLoad();   // resync from the server so the screen can't drift from the DB
  }
}

// Full Circle brand glyphs for the product cards — inline so they inherit
// currentColor from the badge / empty-state. Sparkle marks a DESIGNED card;
// the broken-image glyph is the honest empty state for unphotographed products.
const PA_ICON_SPARKLE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/><circle cx="19" cy="5" r="1.2"/><circle cx="6" cy="18" r="1"/></svg>';
const PA_ICON_BROKEN  = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 17l5-4 4 3 4-5 5 5"/><path d="M3 5l18 14"/></svg>';
// Six-dot drag grip for the reorder column.
const PA_ICON_GRIP    = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.4"/><circle cx="10" cy="4" r="1.4"/><circle cx="6" cy="8" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="6" cy="12" r="1.4"/><circle cx="10" cy="12" r="1.4"/></svg>';

// The per-operator View tweaks (photo crop / status display / empty-photo
// style) are gone with their popover. They had been display:none for most of
// their life, and a stored preference from that era must not keep steering
// the grid from a control nobody can see any more.

// Export the WHOLE catalogue as a spreadsheet — deliberately not the filtered
// view. The button sits next to a search box, so "download" scoped to whatever
// was typed would quietly hand over a partial file; the operator asking for a
// product export wants every product. Filtering happens in Excel afterwards.
function paExportCsv() {
  window.location.href = '/api/retail-admin/products/export.csv';
}

// Catalogue-health KPIs (shared fc-* strip). Computed from the full in-memory
// catalogue, so they're catalogue-wide (independent of the search/filter that
// narrows the grid below). `animate` count-ups only on a fresh load — plain
// writes on every re-render keep the numbers in sync without re-animating on
// each keystroke. Out-of-stock / Low-stock tiles flip to .alert when non-zero.
function paRenderKpis(animate) {
  if (!document.getElementById('pa-kpis')) return;
  const rows = Array.isArray(PA_PRODUCTS) ? PA_PRODUCTS : [];
  const eff = x => _paStockOf(x);   // store-aware: counts follow the "Stock for" pick
  let live = 0, drafts = 0, oos = 0, low = 0;
  for (const p of rows) {
    const pub = p.is_published === 1;
    if (pub) {
      live++;
      // Supplier-direct items hold no stock of ours — never count them as
      // out-of-stock or low (mirrors _paStatusMatch).
      if (!p.ship_from_supplier) {
        const s = eff(p);
        if (s <= 0) oos++;
        else if (s <= paLowThreshold(p)) low++;
      }
    } else {
      drafts++;
    }
  }
  const set = (id, n) => {
    const el = document.getElementById(id); if (!el) return;
    if (animate) dashCountUp(el, n); else el.textContent = fcNum(n);
  };
  set('pa-kpi-live', live);
  // Out of stock and Low stock are tiles again — they are the two numbers an
  // operator acts on, so they get the biggest, most clickable thing on the
  // page rather than a line of text above it. The header goes back to the
  // title alone: §1.7 bans restating what the tiles already say, and a page
  // whose only honest line would do that is finished with just its title.
  set('pa-kpi-active', live);
  set('pa-kpi-total', rows.length);
  set('pa-kpi-oos', oos);
  set('pa-kpi-low', low);
  set('pa-kpi-drafts', drafts);
  // A tile with nothing to report stops shouting: zero sold out is good news,
  // and good news is not red. The colour is earned by a real count, never worn
  // by the tile just for being that tile.
  const tone = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('is-clear', !n);
  };
  tone('pa-kpi-oos-tile', oos);
  tone('pa-kpi-low-tile', low);
  // §1.7 status line — work waiting, never population, and only when a real
  // number is behind it. Nothing waiting = no line at all, which is a finished
  // header rather than a gap; the dash is banned here as everywhere. Each fact
  // is its own filter and lights when it is the live one, so the headline and
  // the tile below it are two doors to the same list.
  {
    const el = document.getElementById('pa-status-line');
    if (el) {
      const bit = (status, n, label) =>
        `<button type="button" class="pa-status-jump${PA_STATUS === status ? ' is-on' : ''}"`
        + ` onclick="paSetStatus('${status}')">${fcNum(n)} ${label}</button>`;
      const bits = [];
      if (oos) bits.push(bit('oos', oos, cuT('sold out', '缺货')));
      if (low) bits.push(bit('low', low, cuT('low on stock', '库存偏低')));
      el.innerHTML = bits.join('<span class="pa-status-sep"> · </span>');
      el.hidden = !bits.length;
    }
  }
  // Light up whichever jump drives the active quick-filter (none when 'all').
  const tiles = { live: 'pa-kpi-live-tile', restock: 'pa-kpi-restock-tile', oos: 'pa-kpi-oos-tile', low: 'pa-kpi-low-tile', drafts: 'pa-kpi-drafts-tile', dead: 'pa-kpi-dead-tile', promo: 'pa-kpi-promo-tile' };
  for (const [status, id] of Object.entries(tiles)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('pa-kpi-on', PA_STATUS === status);
  }
}
// ── Catalogue highlights — folded into the Jump-to row ─────────────────────
// Two more quick filters that used to live in a separate "Highlights" band:
// Going nowhere (no sale in 30 days) and On promotion (active flash sale).
// Their counts + id-sets come once from /api/retail-admin/products/highlights;
// paRenderHighlights() just fills the two pa-jump tiles already in the DOM
// (pa-kpi-dead-tile / pa-kpi-promo-tile) so they read identically to
// Sold out / Low stock / Drafts. Best seller / Rising and Needs attention were
// dropped — Needs attention duplicated the existing Drafts filter.
async function paLoadHighlights() {
  if (!document.getElementById('pa-kpi-dead-tile')) return;
  try {
    const res = await fetch('/api/retail-admin/products/highlights');
    const j = await res.json();
    if (!j || !j.success) throw new Error('load_failed');
    PA_HI = j;
    PA_HI_SETS.dead  = new Set(j.goingNowhere && j.goingNowhere.ids || []);
    PA_HI_SETS.promo = new Set(j.onPromotion  && j.onPromotion.ids  || []);
  } catch { PA_HI = null; }
  paRenderHighlights();
}
function paRenderHighlights() {
  const deadTile = document.getElementById('pa-kpi-dead-tile');
  const promoTile = document.getElementById('pa-kpi-promo-tile');
  if (!deadTile || !promoTile) return;
  if (!PA_HI) { deadTile.hidden = true; promoTile.hidden = true; return; }
  const dead = PA_HI.goingNowhere ? PA_HI.goingNowhere.count : 0;
  const promo = PA_HI.onPromotion ? PA_HI.onPromotion.count : 0;
  deadTile.hidden = !dead;
  promoTile.hidden = !promo;
  const deadN = document.getElementById('pa-kpi-dead'); if (deadN) deadN.textContent = fcNum(dead);
  const promoN = document.getElementById('pa-kpi-promo'); if (promoN) promoN.textContent = fcNum(promo);
}

let PA_FILTERED_IDS = [];
// ── Multi-select bulk edit ──────────────────────────────────────────────────
// PA_SELECT_MODE arms the checkbox column; PA_SELECTED holds the ticked product
// ids (variant families expanded to every member, so a group edits as a block).
// PA_VISIBLE_MEMBER_IDS is the member ids of the units on the current page —
// drives the header "select all" tick. All filled during paRender().
let PA_SELECT_MODE = false;
let PA_SELECTED = new Set();
let PA_VISIBLE_MEMBER_IDS = [];

// Bulk bar — a permanent action bar in the full-width overview (editor closed).
// The per-field triggers (shop on/off, badges, shipping, markets, fresh batches,
// delete) stay greyed until at least one product is ticked, then apply one
// change to the ticked set via the per-product PATCH. Ticking a row's checkbox
// arms PA_SELECT_MODE so row clicks toggle the tick instead of opening the
// editor; "Clear" drops out of that mode again.
function paRenderBulkBar() {
  const bar = document.getElementById('pa-bulkbar');
  if (!bar) return;
  const overview = PA_VIEW === 'list' && !_paEditorOpen;
  const idset = new Set(PA_FILTERED_IDS || []);
  const shown = overview ? (PA_PRODUCTS || []).filter(p => idset.has(p.id)) : [];
  if (!shown.length) { bar.style.display = 'none'; bar.className = ''; bar.innerHTML = ''; PA_SELECT_MODE = false; PA_SELECTED = new Set(); return; }
  // The bar is a MODE, not furniture: it appears when the operator has ticked
  // something and goes when they have not. It used to sit above every list
  // permanently reading "0 selected" beside a row of dead greyed-out menus,
  // which is a toolbar that lies about being usable. Ticking any row arms it.
  if (!PA_SELECT_MODE || !PA_SELECTED.size) {
    bar.style.display = 'none'; bar.className = ''; bar.innerHTML = '';
    return;
  }

  {
    const n = PA_SELECTED.size;
    const visN = PA_VISIBLE_MEMBER_IDS.length;
    const allVis = visN && PA_VISIBLE_MEMBER_IDS.every(id => PA_SELECTED.has(id));
    // One dropdown per field: a trigger + a menu of choices. `dis` greys the
    // triggers out until something is ticked. Items close the menu, then apply.
    const dis = n ? '' : 'disabled';
    const mi = (txt, fn) => `<button type="button" onclick="paBulkMenuClose();${fn}">${txt}</button>`;
    const mh = (t) => `<div class="pa-bm-h">${t}</div>`;
    const sep = `<div class="pa-bm-sep"></div>`;
    const menu = (lbl, items, right) =>
      `<div class="pa-bm"><button type="button" class="pa-bm-trig" ${dis} onclick="paBulkMenu(this)">${lbl}` +
      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg></button>` +
      `<div class="pa-bm-menu${right ? ' right' : ''}">${items}</div></div>`;
    bar.style.cssText = '';
    bar.className = 'pa-bulkbar-sel';
    bar.innerHTML =
      `<span class="pa-bulk-count"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4L6 11 3 8"/></svg>${cuT(n + ' selected', '已选 ' + n + ' 件')}</span>` +
      `<button type="button" class="btn btn-sm" onclick="paSelectAllVisible(${allVis ? 'false' : 'true'})">${allVis ? cuT('Clear page', '清空本页') : cuT('Select all ' + visN, '全选 ' + visN)}</button>` +
      (n ? `<button type="button" class="btn btn-sm" onclick="paSetSelectMode(false)">${cuT('Clear', '清除')}</button>` : '') +
      `<span class="pa-bulk-actions">` +
        menu(cuT('Shop', '上架'),
          mi(cuT('Turn on', '上架'), "paBulkApply({is_published:1}, 'shop-on')") +
          mi(cuT('Turn off', '下架'), "paBulkApply({is_published:0}, 'shop-off')")) +
        menu(cuT('Badge', '标签'),
          mi(cuT('None', '无'),  "paBulkApply({tags:''}, 'badge-none')") +
          mi(cuT('Auto', '自动'), "paBulkApply({tags:'auto'}, 'badge-auto')") + sep +
          mi('NEW',  "paBulkApply({tags:'new'}, 'badge-new')") +
          mi('POP',  "paBulkApply({tags:'pop'}, 'badge-pop')") +
          mi('SALE', "paBulkApply({tags:'sale'}, 'badge-sale')") +
          mi('HOT',  "paBulkApply({tags:'hot'}, 'badge-hot')")) +
        menu(cuT('Shipping', '配送'),
          mi(cuT('Air + Land', '空运+陆运'), "paBulkApply({ship_modes:'air,land'}, 'ship')") +
          mi(cuT('Air only', '仅空运'), "paBulkApply({ship_modes:'air'}, 'ship')") +
          mi(cuT('Land only', '仅陆运'), "paBulkApply({ship_modes:'land'}, 'ship')")) +
        menu(cuT('More', '更多'),
          mh(cuT('Markets', '市集')) +
          mi(cuT('Show in markets', '在市集显示'), "paBulkApply({is_market:1}, 'mkt-on')") +
          mi(cuT('Hide from markets', '从市集隐藏'), "paBulkApply({is_market:0}, 'mkt-off')") + sep +
          mh(cuT('Fresh batch', '现做')) +
          mi(cuT('Mark fresh batch', '标记现做'), "paBulkApply({is_batch_made:1}, 'batch-on')") +
          mi(cuT('Not fresh batch', '取消现做'), "paBulkApply({is_batch_made:0}, 'batch-off')"), true) +
        `<span class="pa-bulk-vr"></span>` +
        `<button type="button" class="pa-bm-trig pa-bulk-del" ${dis} onclick="paBulkDelete()">${cuT('Delete', '删除')}</button>` +
      `</span>`;
  }
}
// One-open-at-a-time dropdowns inside the selection bar. Toggling closes any
// sibling menu first; a document click (bound once) closes them all.
function paBulkMenu(btn) {
  const grp = btn.closest('.pa-bm');
  const wasOpen = grp.classList.contains('open');
  paBulkMenuClose();
  if (!wasOpen) grp.classList.add('open');
}
function paBulkMenuClose() {
  document.querySelectorAll('#pa-bulkbar .pa-bm.open').forEach(g => g.classList.remove('open'));
}
if (!window._paBulkMenuBound) {
  window._paBulkMenuBound = true;
  document.addEventListener('click', (e) => { if (!e.target.closest('#pa-bulkbar .pa-bm')) paBulkMenuClose(); });
}
// Toolbar "Add product" split button — caret drops the two ways to add.
function paAddMenu(btn) {
  const wrap = btn.closest('.pa-addsplit');
  const menu = document.getElementById('pa-add-menu');
  const open = !menu.hidden;
  paAddMenuClose();
  if (!open) { menu.hidden = false; wrap.classList.add('is-open'); }
}
function paAddMenuClose() {
  const menu = document.getElementById('pa-add-menu');
  if (menu) menu.hidden = true;
  const wrap = document.getElementById('pa-addsplit');
  if (wrap) wrap.classList.remove('is-open');
}
if (!window._paAddMenuBound) {
  window._paAddMenuBound = true;
  document.addEventListener('click', (e) => { if (!e.target.closest('#pa-addsplit')) paAddMenuClose(); });
}
// Enter/leave select mode. Leaving drops the tick set. Re-renders the list so
// the checkbox column slides in/out and the bar swaps.
function paSetSelectMode(on) {
  PA_SELECT_MODE = !!on;
  if (!PA_SELECT_MODE) PA_SELECTED = new Set();
  paRender();
}
// Toggle one unit (csv of member ids). All-in → remove all; otherwise add all,
// so a half-selected group flips fully on. The row checkbox is always on
// screen, so ticking one is itself what arms select mode — the bulk bar (always
// present) then enables its actions and lights up that tick.
function paToggleSelect(ids) {
  const list = String(ids).split(',').map(Number).filter(Boolean);
  const allIn = list.length && list.every(id => PA_SELECTED.has(id));
  list.forEach(id => allIn ? PA_SELECTED.delete(id) : PA_SELECTED.add(id));
  // Ticking the last box off drops back out of select mode — otherwise it
  // stays stuck on with nothing selected, and nothing on screen shows it
  // (the bulk bar looks identical either way), silently disarming reorder.
  PA_SELECT_MODE = PA_SELECTED.size > 0;
  paRender();
}
function paSelectAllVisible(on) {
  PA_VISIBLE_MEMBER_IDS.forEach(id => on ? PA_SELECTED.add(id) : PA_SELECTED.delete(id));
  PA_SELECT_MODE = PA_SELECTED.size > 0;
  paRender();
}
// Apply one patch to every ticked product. Confirms, PATCHes each, reports, then
// reloads (keeps select mode + the tick set so a second change can follow).
async function paBulkApply(patch, kind) {
  const ids = [...PA_SELECTED];
  if (!ids.length) return;
  const labels = {
    'shop-on': cuT('Publish to the shop', '上架到店面'),
    'shop-off': cuT('Hide from the shop', '从店面下架'),
    'mkt-on': cuT('Mark as sold at markets', '标记为市集销售'),
    'mkt-off': cuT('Unmark sold at markets', '取消市集销售'),
    'batch-on': cuT('Mark as made fresh in batches', '标记为分批现做'),
    'batch-off': cuT('Unmark made fresh in batches', '取消分批现做'),
    'ship': cuT('Set shipping to ' + (patch.ship_modes === 'air' ? 'Air only' : patch.ship_modes === 'land' ? 'Land only' : 'Air + Land'),
                '设置配送为' + (patch.ship_modes === 'air' ? '仅空运' : patch.ship_modes === 'land' ? '仅陆运' : '空运+陆运')),
    'badge-none': cuT('Clear the shop-card badge', '清除店面标签'),
    'badge-auto': cuT('Set badge to Auto (by sales)', '设置标签为自动(按销量)'),
    'badge-new':  cuT('Set badge to NEW', '设置标签为 NEW · 新品'),
    'badge-pop':  cuT('Set badge to POP', '设置标签为 POP · 热门'),
    'badge-sale': cuT('Set badge to SALE', '设置标签为 SALE · 特价'),
    'badge-hot':  cuT('Set badge to HOT', '设置标签为 HOT · 推荐'),
  };
  const what = labels[kind] || cuT('Update', '更新');
  if (!(await askConfirm({
    title: cuT(what + ' — ' + ids.length + ' product(s)?', what + ' — ' + ids.length + ' 件商品?'),
    confirmLabel: cuT('Apply', '应用'),
  }))) return;
  toast(cuT('Working…', '处理中…'));
  let done = 0, fail = 0;
  for (const id of ids) {
    try {
      const r = await fetch('/api/retail-admin/products/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.success !== false) done++; else fail++;
    } catch (e) { fail++; }
  }
  toast(fail
    ? cuT(done + ' done, ' + fail + ' failed', done + ' 成功,' + fail + ' 失败')
    : cuT('Updated ' + done + ' ✓', '已更新 ' + done + ' 件 ✓'), fail ? 'err' : 'ok');
  await paLoad();
}
// Delete every ticked product. Double-confirms (irreversible — soft-delete that
// frees the SKU, no restore UI), DELETEs each, reports, drops the tick set and
// reloads. Mirrors the per-product delete endpoint.
async function paBulkDelete() {
  const ids = [...PA_SELECTED];
  if (!ids.length) return;
  if (!(await askConfirm({
    title: cuT('Delete ' + ids.length + ' product(s)?', '删除 ' + ids.length + ' 件商品?'),
    body: cuT('This removes them from the catalogue and frees their SKUs. This cannot be undone.',
              '将从商品库移除并释放其 SKU。此操作无法撤销。'),
    confirmLabel: cuT('Delete', '删除'),
    danger: true,
  }))) return;
  toast(cuT('Working…', '处理中…'));
  let done = 0, fail = 0;
  for (const id of ids) {
    try {
      const r = await fetch('/api/retail-admin/products/' + id, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.success !== false) done++; else fail++;
    } catch (e) { fail++; }
  }
  toast(fail
    ? cuT(done + ' deleted, ' + fail + ' failed', done + ' 已删除,' + fail + ' 失败')
    : cuT('Deleted ' + done + ' ✓', '已删除 ' + done + ' 件 ✓'), fail ? 'err' : 'ok');
  PA_SELECTED = new Set();
  await paLoad();
}
let PA_ORDERED_UNIT_IDS = [];
let _PA_RENDER_LANG_HOOKED = false;
function paRender() {
  // Rows/cards resolve product names through cuT() at render time and carry
  // data-no-i18n, so the DOM walker won't repaint them on a language toggle —
  // re-render the whole grid instead. Registered lazily (onLangChange lives in
  // a later part file).
  if (!_PA_RENDER_LANG_HOOKED && window.onLangChange) { _PA_RENDER_LANG_HOOKED = true; onLangChange(paRender); }
  const grid   = document.getElementById('pa-grid');
  const empty  = document.getElementById('pa-empty');
  const count  = document.getElementById('pa-count');
  const q      = (document.getElementById('pa-search').value || '').toLowerCase().trim();
  const filter = document.getElementById('pa-filter').value;

  paRenderKpis(false);   // keep the health strip in sync (no re-animation)
  paRenderHighlights();  // keep the Going nowhere / On promotion tile counts in sync
  paRenderStoreSeg();    // show/hide the per-store switcher for the current view

  let rows = PA_PRODUCTS;
  if (q) {
    rows = rows.filter(p =>
      (p.name_en || '').toLowerCase().includes(q) ||
      (p.name_cn || '').includes(q) ||
      (p.sku || '').toLowerCase().includes(q)
    );
  }
  if (filter && filter !== 'all') {
    rows = rows.filter(p => (p.top_category || p.category || '').trim() === filter);
  }
  const subEl = document.getElementById('pa-subfilter');
  const subFilter = (filter && filter !== 'all' && subEl) ? subEl.value : 'all';
  if (subFilter && subFilter !== 'all') {
    rows = rows.filter(p => (p.subcategory || '').trim() === subFilter);
  }
  if (PA_STATUS !== 'all') {
    rows = rows.filter(_paStatusMatch);
  }
  // Restock view — lowest stock first, so the emptiest shelves (out of stock,
  // then 1 left, 2 left…) sit at the top where the operator works down the list.
  if (PA_STATUS === 'restock') {
    rows = rows.slice().sort((a, b) => _paStockOf(a) - _paStockOf(b));
  }

  // Count display UNITS (variant sizes merged into one), so the toolbar total
  // matches the list pager's "of N" instead of looking like a mismatch.
  const _uShown = _paUnits(rows).length, _uTotal = _paUnits(PA_PRODUCTS).length;
  count.textContent = `${_uShown} of ${_uTotal} · 共 ${_uTotal} 件,显示 ${_uShown} 件`;

  // Drag-to-reorder is offered only when the picture is unambiguous: the list
  // overview (editor closed), one real category picked, and no search/status
  // filter narrowing the set. Under those conditions the rows on screen ARE the
  // category's full storefront sequence, so dragging one maps cleanly onto its
  // sort_order. (Any of those filters could hide siblings → a drag would reorder
  // an incomplete set, so we don't arm it then.)
  const reorderActive = PA_VIEW === 'list' && !_paEditorOpen && !PA_SELECT_MODE
    && filter && filter !== 'all' && !q && PA_STATUS === 'all';

  // Collapse variant siblings into display units, then paginate the units so
  // only one page of cards renders at a time (keeps the grid fast on the full
  // catalogue). Variant groups are kept whole — they count as one unit. While
  // arranging we show the whole category on one page so a row can be dragged
  // anywhere in its order, not just within the current page.
  const units = _paUnits(rows);
  const total = units.length;
  // Ordered ids of the on-screen list — drives the editor's "Save & next".
  PA_ORDERED_UNIT_IDS = units.map(u => (u && u.p ? u.p.id : null)).filter(x => x != null);
  PA_FILTERED_IDS = rows.map(p => p.id);
  empty.style.display = total ? 'none' : 'block';
  // Docked editor → fixed 18-row pages (list ends near the editor's bottom edge,
  // no dead gap / extra scroll). Overview → operator's "Per page" choice.
  const effSize = _paEditorOpen ? PA_DOCK_PAGE_SIZE : PA_PAGE_SIZE;
  const paged = !reorderActive && effSize !== 'all' && total > 0;
  const size  = paged ? effSize : total;
  const pages = paged ? Math.max(1, Math.ceil(total / size)) : 1;
  if (PA_PAGE > pages) PA_PAGE = pages;
  if (PA_PAGE < 1) PA_PAGE = 1;
  const start = paged ? (PA_PAGE - 1) * size : 0;
  const pageUnits = paged ? units.slice(start, start + size) : units;
  // Member ids of the units on this page — drives the bulk "select all" + the
  // checkbox column. A variant family contributes every member id.
  PA_VISIBLE_MEMBER_IDS = pageUnits.flatMap(u => u && u.group ? u.members.map(m => m.id) : [u.p.id]);
  paRenderBulkBar();
  const pager = document.getElementById('pa-pager');
  if (pager) {
    pager.innerHTML = reorderActive
      ? (total ? `<div class="pa-reorder-hint">${PA_ICON_GRIP}${cuT('Drag the grip to set the order products show on the store page', '拖动手柄调整商品在门店页的显示顺序')}</div>` : '')
      : (total ? _paPagerHtml(total, pages, start, pageUnits.length, !_paEditorOpen) : '');
  }

  // Reflect the active layout in the toolbar segmented control. Nothing is
  // disabled any more — the drawer sits over the list, so either layout is
  // legal with a product open.
  document.querySelectorAll('#pa-view-seg .pa-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === PA_VIEW);
  });

  // Nothing to sync here any more: the list always spans the content column,
  // whether the drawer is open, closed or expanded to the full page.

  if (PA_VIEW === 'list') {
    // ── The catalogue table ─────────────────────────────────────────────────
    // One arrangement, always the same columns. Opening a product no longer
    // changes it at all — the editor is a drawer over the top, so the list
    // keeps the full content column and never reflows underneath it, and no
    // column is ever folded away.
    //
    // 🔴 A REAL <table>, not a CSS grid: table-layout:fixed with a classed
    // <col> per column, the shape #orders-table and #cu-table both carry
    // (§1.19). NOTHING HERE STATES A WIDTH — every one of them lives in CSS on
    // the col classes with the measurement table beside it. What it replaced
    // wrote its grid track list inline on every render, and two short-value
    // columns (Category, SKU) held `fr` shares, so every pixel a wide window
    // added went into the gaps between values instead of into the one column
    // that ellipses.
    const listStores = _paListStores();
    // The per-store stock columns are the only ones whose COUNT is a tenant
    // fact rather than a design constant, so CSS sizes them from whatever the
    // stated percentages leave. `data-stores` is how it knows how many there
    // are. Past five the widths stop being measured, so the attribute is
    // clamped there and the last measured set is reused — narrower columns,
    // rather than an unsized table.
    const nStock = listStores.length || 1;
    const tblCls = [
      listStores.length ? 'pa-multistock' : '',
      reorderActive ? 'pa-reorder' : '',
      PA_SELECT_MODE ? 'pa-selecting' : '',
    ].filter(Boolean).join(' ');
    // Snapshot the on-screen unit order as lists of product ids (a variant group
    // moves as one block). paRowDrop reads this to compute the new sequence.
    PA_REORDER_UNITS = reorderActive
      ? pageUnits.map(u => u.group ? u.members.map(m => m.id) : [u.p.id])
      : null;
    // Nothing to show: drop the card chrome too, so #pa-empty owns the screen
    // rather than sitting under an empty bordered box.
    if (!pageUnits.length) { grid.className = ''; grid.innerHTML = ''; return; }
    grid.className = 'pa-listcard';

    const allVisSel = PA_VISIBLE_MEMBER_IDS.length && PA_VISIBLE_MEMBER_IDS.every(id => PA_SELECTED.has(id));
    // 🔴 The grip column is EMITTED, not zeroed. `width: 0%` on a col reads as
    // width-less, and a width-less column joins the equal division of whatever
    // the stated percentages leave — measured: a 0% grip column came out 6%
    // wide and took a third of the stock block with it.
    const cols = '<colgroup>'
      + '<col class="pa-c-sel">' + (reorderActive ? '<col class="pa-c-grip">' : '') + '<col class="pa-c-name">'
      + '<col class="pa-c-cat"><col class="pa-c-sku">'
      + Array.from({ length: nStock }, () => '<col class="pa-c-stock">').join('')
      + '<col class="pa-c-price"><col class="pa-c-margin"><col class="pa-c-status">'
      + '</colgroup>';
    // Single-line labels, no sub-labels — a header that needs a sentence to be
    // understood is the wrong header (§1.13a). The grip's header is blank: a
    // drag handle has no name, and the column only exists while reordering.
    const head = `<thead><tr>
        <th class="pa-c-sel"><span class="pa-selbox"><input type="checkbox" ${allVisSel ? 'checked' : ''} onclick="paSelectAllVisible(this.checked)" title="${cuT('Select all on this page', '全选本页')}"></span></th>
        ${reorderActive ? '<th class="pa-c-grip"></th>' : ''}
        <th class="pa-c-name">${cuT('Product', '产品')}</th>
        <th class="pa-c-cat">${cuT('Category', '分类')}</th>
        <th class="pa-c-sku">SKU</th>
        ${listStores.length
          ? listStores.map(s => `<th class="pa-c-stock">${escapeHtml(_paStoreName(s.id))}</th>`).join('')
          : `<th class="pa-c-stock">${cuT('Stock', '库存')}</th>`}
        <th class="pa-c-price">${cuT('Price', '价格')}</th>
        <th class="pa-c-margin">${cuT('Margin', '毛利')}</th>
        <th class="pa-c-status">${cuT('Status', '状态')}</th>
      </tr></thead>`;

    const rows = pageUnits.map((u, ui) => {
      const p = u.p;
      const img = p.image_data || p.image_url || '';
      // A variant family shows "N sizes" as a tag beside the name, and a plain
      // "—" in the SKU column (each size owns its own SKU).
      const sizesPill = u.group
        ? `<span class="pa-sizes-pill">${u.members.length} ${cuT('sizes', '规格')}</span>`
        : '';
      const sku = u.group ? '—' : escapeHtml(p.sku || '—');
      const gripCell = reorderActive
        ? `<td class="pa-c-grip"><span class="pa-grip" draggable="true" title="${cuT('Drag to reorder', '拖动排序')}" onclick="event.stopPropagation()" ondragstart="paRowDragStart(event, ${ui})" ondragend="paRowDragEnd()">${PA_ICON_GRIP}</span></td>`
        : '';
      const rowDrag = reorderActive
        ? ` ondragover="paRowDragOver(event, ${ui})" ondragleave="paRowDragLeave(event)" ondrop="paRowDrop(event, ${ui})"`
        : '';
      const memberIds = (u.group ? u.members.map(m => m.id) : [p.id]).join(',');
      const selRow = memberIds.split(',').every(id => PA_SELECTED.has(Number(id)));
      // In select mode the whole row toggles the tick (the box is display-only,
      // pointer-events:none in CSS). Outside select mode the row still opens
      // the editor, so the box needs its own click handler + stopPropagation to
      // tick without navigating away.
      const selCell = PA_SELECT_MODE
        ? `<span class="pa-selbox"><input type="checkbox" tabindex="-1" aria-hidden="true" ${selRow ? 'checked' : ''}></span>`
        : `<span class="pa-selbox"><input type="checkbox" ${selRow ? 'checked' : ''} onclick="event.stopPropagation();paToggleSelect('${memberIds}')"></span>`;
      const rowClick = PA_SELECT_MODE ? `paToggleSelect('${memberIds}')` : `paOpenEdit(${p.id})`;
      // data-no-i18n shields the whole identity block: the name is already in
      // one language and the "N sizes" tag is rendered through cuT, so the DOM
      // walker must not have a second go at either.
      return `
        <tr class="pa-row${selRow ? ' is-sel' : ''}" onclick="${rowClick}"${rowDrag}>
          <td class="pa-c-sel">${selCell}</td>${gripCell}
          <td class="pa-c-name">
            <div class="pa-prod" data-no-i18n>
              <div class="pa-row-img">${img ? `<img src="${escapeAttr(img)}" loading="lazy" alt="">` : PA_ICON_BROKEN}</div>
              <div class="pa-row-main"><div class="pa-row-name">${escapeHtml(cuT(p.name_en || p.name_cn || '—', p.name_cn || p.name_en || '—'))}${sizesPill}</div></div>
            </div>
          </td>
          <td class="pa-c-cat">${_paCatCell(u)}</td>
          <td class="pa-c-sku">${sku}</td>
          ${listStores.length
            ? listStores.map(s => `<td class="pa-c-stock">${_paStoreStockCell(u, s.id)}</td>`).join('')
            : `<td class="pa-c-stock">${_paStockCell(u)}</td>`}
          <td class="pa-c-price">${_paPriceCell(u)}</td>
          <td class="pa-c-margin">${_paMarginCell(u)}</td>
          <td class="pa-c-status">${_paStatusCell(u)}</td>
        </tr>`;
    }).join('');

    grid.innerHTML = `<table id="pa-table"${tblCls ? ` class="${tblCls}"` : ''} data-stores="${Math.min(nStock, 5)}">`
      + cols + head + '<tbody>' + rows + '</tbody></table>';
    paApplyRowSelection();
    return;
  }

  // Grid (default) or Compact — same card markup so the "View" popover's
  // crop / status / empty tweaks keep composing on top.
  grid.className = PA_VIEW === 'compact' ? 'pa-grid pa-grid-compact' : 'pa-grid';
  grid.innerHTML = pageUnits.map(u => {
    const p = u.p;
    const img = p.image_data || p.image_url || '';
    // A group reflects the whole family: designed if ANY size has sections,
    // and only Draft when EVERY size is unpublished (so a partly-live family
    // doesn't read as a draft).
    const designed = u.group ? u.members.some(_paHasBlocks) : _paHasBlocks(p);
    const pub      = u.group ? u.members.some(m => m.is_published === 1) : p.is_published === 1;
    const meta = u.group
      ? u.members.map(_paVariantTag).join(' · ')
      : [p.sku, p.size].filter(Boolean).map(escapeHtml).join(' · ');
    const variantPill = u.group
      ? `<span class="pa-pill pa-pill-variants" title="${cuT('Variants of one product · 同一产品的多个规格', 'Variants of one product · 同一产品的多个规格')}">${u.members.length} ${cuT('variants', '规格')}</span>`
      : '';
    // A live (published) size with no stock — flag it so a sold-out size is
    // visible from the grid without opening the product. Use effective_stock
    // (per-store sum, same as the shop) so a product stocked per-store doesn't
    // show a false "OUT" off the stale legacy stock_qty column.
    const effStock = x => _paStockOf(x);   // store-aware, matching the OOS quick-filter
    const oosCount = u.group
      ? u.members.filter(m => m.is_published === 1 && effStock(m) <= 0).length
      : ((p.is_published === 1 && effStock(p) <= 0) ? 1 : 0);
    const oosPill = oosCount
      ? `<span class="pa-pill pa-pill-oos" title="${cuT('A live size is out of stock · 有上架规格缺货', 'A live size is out of stock · 有上架规格缺货')}">${u.group ? oosCount + ' ' + cuT('out', '缺货') : cuT('Out of stock', '缺货')}</span>`
      : '';
    return `
      <div class="pa-card ${designed ? 'is-designed' : 'is-plain'}${pub ? '' : ' is-draft'}" onclick="paOpenEdit(${p.id})">
        <button class="pa-dup" type="button" title="Duplicate · 复制" onclick="event.stopPropagation(); paDuplicate(${p.id})">⧉</button>
        <div class="pa-card-img">
          ${img ? `<img src="${escapeAttr(img)}" loading="lazy" alt="">` : `<div class="pa-card-img-empty">${PA_ICON_BROKEN}</div>`}
          <div class="pa-card-pills">
            ${oosPill}
            ${variantPill}
            ${(p.is_bundle || p.bundle_mode === 'prepacked') ? `<span class="pa-pill pa-pill-bundle" title="Bundle — sold as one set · 套装产品">${cuT('Bundle', '套装')}</span>` : ''}
            ${designed
              ? `<span class="pa-pill pa-pill-designed" title="Designer sections authored · 已配置设计板块">${PA_ICON_SPARKLE}Designed</span>`
              : `<span class="pa-pill pa-pill-plain" title="No designer sections yet · 尚未配置设计板块">Plain</span>`}
            ${pub ? '' : '<span class="pa-pill pa-pill-draft" title="Not published in mini-app · 未在小程序上架">Draft</span>'}
          </div>
        </div>
        <div class="pa-card-body" data-no-i18n>
          <div class="pa-card-name">${escapeHtml(cuT(p.name_en || p.name_cn || '—', p.name_cn || p.name_en || '—'))}</div>
          ${meta ? `<div class="pa-card-meta">${meta}</div>` : ''}
          <div class="pa-card-shop">${_paShopToggle(u)}<span class="pa-card-shop-lbl">${pub ? cuT('On shop', '已上架') : cuT('Off shop', '未上架')}</span></div>
        </div>
      </div>`;
  }).join('');
  paApplyRowSelection();
}

// Open the dedicated full-page product editor in a new browser tab. The
// editor (public/product-editor.html) is a standalone page that loads the
// product by id, gives the office the full viewport to compose the page,
// and PATCHes the same /api/retail-admin/products/:id endpoint on save.
// (Replaces the old in-page modal — kept the function name since the grid
// cards call paOpenEdit(id).)
// Clicking a product card opens the commercial details form (name, price,
// stock, photo, description…). The page-design tool is launched from a button
// inside that form, in its own window.
function paOpenEdit(id) {
  // Upstream-catalog tenants (Roots) don't edit product master data or stock
  // here — clicking a product jumps straight to the mini-app page designer in
  // a new tab, skipping the in-page commercial-details/stock form entirely.
  if (CATALOG_MODE === 'upstream') {
    openProductEditor(id);
    return;
  }
  // Grid/compact = catalogue-scan mode (editor pane hidden). Clicking a card
  // = "I want to edit this" → swap to the list+editor split, preserving the
  // current page so the operator's scroll position survives.
  if (PA_VIEW !== 'list') {
    PA_VIEW = 'list';
    try { localStorage.setItem('pa-view', 'list'); } catch (e) {}
    paRender();
  }
  pdOpen(id);
}

// ── Product details (commercial) editor — the Mini App Backend's own product
// page. Edits the basic store fields + stock via /api/retail-admin/products.
// Standalone: needs no kitchen/main system behind it. ──
// Product photo gallery state. _pdGallery = ordered array of image srcs
// (element [0] = the main photo). _pdGalleryDirty = send `images` on save.
let _pdGallery = [];
let _pdGalleryDirty = false;
// True when the shown photos are inherited from a sibling variant (this variant
// has none of its own). Adding/removing a photo makes them this variant's own.
let _pdGalleryInherited = false;
let _pdDragFrom = null;
// Map a product's free-text tags column to the one badge the dropdown shows.
// Mirrors pickBadge() in the mini-app shop page so the editor reflects exactly
// what customers see (priority: NEW > POP > SALE > HOT).
function pdBadgeOf(tags) {
  const t = String(tags || '').trim().toLowerCase();
  // 'auto' = operator delegated the chip to the system (resolved live on the
  // storefront from sales/recency). Show it back as Auto in the dropdown.
  if (t === 'auto')               return 'auto';
  if (/\bnew\b/.test(t))          return 'new';
  if (/\bpop|popular\b/.test(t))  return 'pop';
  if (/\bsale\b/.test(t))         return 'sale';
  if (/\bhot\b/.test(t))          return 'hot';
  return '';
}
// ── Storefront 2-level category (top → subcategory) ──────────────────
// Canonical tree from lib/category-tree.js, served at /api/retail/category-tree.
// Fetched once and cached; the two selects in the editor's Organization card
// drive products.top_category / products.subcategory (the shop's left rail +
// scroll-pane section headings).
let PA_CAT_TREE = [];
async function pdLoadCatTree() {
  if (PA_CAT_TREE.length) return PA_CAT_TREE;
  try {
    const r = await fetch('/api/retail/category-tree', { credentials: 'same-origin' });
    const j = await r.json();
    if (j && j.success && Array.isArray(j.data)) PA_CAT_TREE = j.data;
  } catch {}
  return PA_CAT_TREE;
}
function pdFillTopCats(selected) {
  const sel = document.getElementById('pd-top-category');
  if (!sel) return;
  sel.innerHTML = '<option value="">— none · 无 —</option>' +
    PA_CAT_TREE.map(t => `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)} · ${escapeHtml(t.name_cn || '')}</option>`).join('');
  sel.value = selected || '';
}
function pdFillSubCats(topName, selected) {
  const sel = document.getElementById('pd-subcategory');
  if (!sel) return;
  const top = PA_CAT_TREE.find(t => t.name === topName);
  const subs = top ? (top.subs || []) : [];
  sel.innerHTML = '<option value="">— none · 无 —</option>' +
    subs.map(s => `<option value="${escapeAttr(s.name)}">${escapeHtml(s.name)} · ${escapeHtml(s.name_cn || '')}</option>`).join('');
  sel.value = selected || '';
  sel.disabled = !subs.length;
}
function pdOnTopCatChange() {
  pdFillSubCats(document.getElementById('pd-top-category').value, '');
}

// Variant × store stock matrix in the product editor. Stock is owned per
// (variant, store): each variant is its own product row, holding independent
// per-store physical_qty in retail_store_stock. This grid shows EVERY variant
// across EVERY store in one place — so you never open another variant just to
// set its stock — and feeds the read-only STOCK column in the variants table
// (VA_STORE_TOTALS) so the two views always agree. Each changed cell writes via
// the per-store PATCH (/stores/:storeId/stock/:productId) → a ledger row lands.
// New (unsaved) products show a hint — stock needs a product id to attach to.
function _vaMatrixLabel(v) {
  const lbl = (v.variant_label || '').trim();
  if (lbl) return lbl;
  return cuT(v.name_en || '—', v.name_cn || v.name_en || '—');
}
function pdLoadStoreStocks(id) {
  const box = document.getElementById('pd-store-stocks');
  if (!box) return;
  box.dataset.productId = (id == null ? '' : String(id));
  PD_STOCK_DATA = null;
  if (id == null) { box.className = 'muted'; box.textContent = cuT('Set stock after saving', '保存后设置库存'); pdSetStockTabCount(null); return; }
  // Assembled bundle: stock is computed from its components, never typed. Show the
  // "Makes N" panel instead of the per-store matrix (mirrors the products list).
  const _bp = (PA_PRODUCTS || []).find(x => x.id === Number(id));
  if (_bp && _bp.is_bundle && Array.isArray(_bp.bundle_items) && _bp.bundle_items.length) { pdRenderBundleStock(box, _bp); return; }
  box.className = '';
  box.textContent = '…';
  // NOTE: use cuT() for language, NOT the raw `_lang` global — `_lang` is scoped
  // inside the i18n module closure and is NOT visible here.
  fetch('/api/retail-admin/products/' + id + '/variant-store-stocks', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(j => {
      const d = j && j.success && j.data;
      if (!d || !Array.isArray(d.stores) || !d.stores.length || !Array.isArray(d.variants) || !d.variants.length) {
        box.className = 'muted'; box.textContent = cuT('No stock info yet', '暂无库存信息'); pdSetStockTabCount(null); return;
      }
      box.className = '';
      PD_STOCK_DATA = d;
      pdRenderStockMatrix(box, d);
      pdSyncVariantTotals(d);
      const qty = d.qty || {}, grandTotal = Object.keys(qty).reduce((sum, vid) =>
        sum + Object.values(qty[vid] || {}).reduce((a, n) => a + (Number(n) || 0), 0), 0);
      pdSetStockTabCount(grandTotal);
    })
    .catch(() => { box.className = 'muted'; box.textContent = cuT('Couldn’t load stock', '无法加载库存'); pdSetStockTabCount(null); });
}
// Assembled bundle stock panel: availability is worked out from the components
// (min over parts of floor(stock ÷ qty)), never typed. Reuses the per-store map
// (PA_STOCK) + catalogue (PA_PRODUCTS) the list already loaded. Dusk = "Tacet
// worked this out for you".
function pdRenderBundleStock(box, p) {
  const comps = Array.isArray(p.bundle_items) ? p.bundle_items : [];
  const stores = PA_STORES || [];
  const compName = cid => { const cp = (PA_PRODUCTS || []).find(x => x.id === cid); return cp ? (cuT(cp.name_en, cp.name_cn) || cp.name_en || ('#' + cid)) : ('#' + cid); };
  const totalOf = cid => {
    if (PA_STOCK_LOADED && stores.length) return stores.reduce((s, st) => s + _paStoreQty(cid, st.id), 0);
    const cp = (PA_PRODUCTS || []).find(x => x.id === cid);
    return cp ? Number(cp.effective_stock ?? cp.stock_qty ?? 0) : 0;
  };
  let makes = Infinity, limId = comps.length ? comps[0].id : null, limLeft = 0;
  for (const c of comps) {
    const qty = Math.max(1, Number(c.qty) || 1), t = totalOf(c.id), m = Math.floor(t / qty);
    if (m < makes) { makes = m; limId = c.id; limLeft = t; }
  }
  makes = Number.isFinite(makes) ? Math.max(0, makes) : 0;
  const perStore = (PA_STOCK_LOADED ? stores : []).map(s => {
    let m = Infinity;
    for (const c of comps) { const qty = Math.max(1, Number(c.qty) || 1); m = Math.min(m, Math.floor(_paStoreQty(c.id, s.id) / qty)); }
    return { name: cuT(s.name_en || s.code, s.name_cn || s.name_en || s.code), makes: Number.isFinite(m) ? Math.max(0, m) : 0 };
  });
  const split = perStore.length
    ? `<div class="pe-bstock-split">${perStore.map(s => `<span>${escapeHtml(s.name)} ${cuT('makes', '可做')} <b>${s.makes}</b></span>`).join('')}</div>`
    : '';
  box.className = '';
  box.innerHTML =
    `<div class="pe-bstock">` +
      `<div class="pe-bstock-cap"><span class="pe-bstock-dot"></span>${cuT('Worked out from the parts', '由组成商品得出')}</div>` +
      `<div class="pe-bstock-big">${cuT('Makes', '可做')} ${makes}</div>` +
      (limId != null ? `<div class="pe-bstock-lim">${cuT('Limited by', '受限于')} <b>${escapeHtml(compName(limId))}</b> — ${limLeft} ${cuT('left', '剩余')}</div>` : '') +
      split +
    `</div>` +
    `<p class="pe-bstock-note">${cuT('No count to keep — it moves as the parts sell.', '无需盘点 — 随组成商品售出而变化。')}</p>`;
  pdSetStockTabCount(makes);
}
// Build the grid: rows = variants, columns = stores, + a live row total. The
// variant currently open above is flagged with ● so it's obvious which row the
// rest of the form edits.
function pdRenderStockMatrix(box, d) {
  const stores = d.stores, variants = d.variants, qty = d.qty || {};
  const multi = variants.length > 1;
  const storeName = s => escapeHtml(cuT(s.name_en || s.code, s.name_cn || s.name_en) || s.code);
  const cell = (v, s) => {
    const q = (qty[v.id] && qty[v.id][s.store_id]) || 0;
    return '<input type="number" min="0" step="1" value="' + q + '" data-orig="' + q + '" ' +
      'data-variant-id="' + v.id + '" data-store-id="' + s.store_id + '" ' +
      'oninput="pdMatrixRecalc(this)" onblur="pdMatrixCellSave(this)">';
  };

  let inner;
  if (!multi) {
    // One size is a handful of numbers, so they are plain labelled fields. A
    // table here dragged in a header band, an empty label column and a Total —
    // and that Total only repeated the "N on hand" headline and its per-store
    // split sitting directly above. Fields share a left edge with Low-stock.
    inner = '<div class="pd-storefields">' + stores.map(s =>
      '<label class="pd-storefield"><span>' + storeName(s) + '</span>' + cell(variants[0], s) + '</label>'
    ).join('') + '</div>';
  } else {
    // Several sizes IS a grid — sizes down, stores across — so it earns the
    // table, the row labels and a per-size total.
    const head = '<tr><th class="vh">' + cuT('Size', '规格') + '</th>' +
      stores.map(s => '<th class="mstore">' + storeName(s) + '</th>').join('') +
      '<th class="mtot">' + cuT('Total', '合计') + '</th></tr>';
    const body = variants.map(v => {
      const cells = stores.map(s => '<td class="mstore">' + cell(v, s) + '</td>').join('');
      const tot = stores.reduce((a, s) => a + ((qty[v.id] && qty[v.id][s.store_id]) || 0), 0);
      const name = escapeHtml(_vaMatrixLabel(v)) +
        (v.self ? ' <span class="va-self" title="' + cuT('The variant open above', '上方打开的规格') + '">●</span>' : '');
      return '<tr data-variant-id="' + v.id + '">' +
        '<th class="vh" title="' + escapeAttr(_vaMatrixLabel(v)) + '">' + name + '</th>' + cells +
        '<td class="mtot" data-tot="' + v.id + '">' + tot + '</td></tr>';
    }).join('');
    inner = '<table class="pd-stock-matrix">' + head + body + '</table>';
  }
  box.innerHTML = inner + '<div class="pd-stock-msg"><span id="pd-store-stocks-msg" class="muted"></span></div>';
  pdRenderOnHand();
}
// The headline above the grid: everything on hand, and how it splits by store.
// The total was nowhere on screen — an operator had to add the column up. Reads
// the matrix's own live values, so it follows a cell edit without a refetch.
function pdRenderOnHand() {
  const wrap = document.getElementById('pd-onhand');
  const nEl  = document.getElementById('pd-onhand-n');
  const sEl  = document.getElementById('pd-onhand-split');
  if (!wrap || !nEl || !sEl) return;
  const d = PD_STOCK_DATA;
  const box = document.getElementById('pd-store-stocks');
  // Gate on the inputs, not on a table: a single-size product renders plain
  // labelled fields with no table at all, and it still has a headline.
  if (!d || !Array.isArray(d.stores) || !box || !box.querySelector('input[data-store-id]')) {
    wrap.hidden = true; sEl.textContent = ''; return;
  }
  // Sum the inputs rather than the loaded payload: a typed-but-not-yet-saved
  // change should move the headline immediately, or it contradicts the grid.
  const val = el => Math.max(0, parseInt(el.value, 10) || 0);
  let total = 0;
  const perStore = d.stores.map(s => {
    const n = [...box.querySelectorAll(`input[data-store-id="${s.store_id}"]`)].reduce((a, el) => a + val(el), 0);
    total += n;
    return _paStoreName(s.store_id) + ' ' + fcNum(n);
  });
  nEl.textContent = fcNum(total);
  wrap.hidden = false;
  // One store needs no breakdown — the headline already said it.
  sEl.textContent = d.stores.length > 1 ? perStore.join(' · ') : '';
}
// Re-label the stock matrix rows live from VA_MEMBERS, so renaming a variant on
// the left is reflected on the right immediately (no exit + re-open). Only the
// labels change here — quantities stay as last loaded/edited. Falls out quietly
// if the matrix isn't built yet or nothing changed (keeps in-progress cell edits).
function pdSyncMatrixLabels() {
  if (!PD_STOCK_DATA || !Array.isArray(PD_STOCK_DATA.variants)) return;
  const box = document.getElementById('pd-store-stocks');
  if (!box || !box.querySelector('table.pd-stock-matrix')) return;
  let changed = false;
  PD_STOCK_DATA.variants.forEach(mv => {
    const src = (VA_MEMBERS || []).find(m => m.id === mv.id);
    if (!src) return;
    const next = src.label || '';
    if ((mv.variant_label || '') !== next) { mv.variant_label = next; changed = true; }
  });
  if (changed) pdRenderStockMatrix(box, PD_STOCK_DATA);
}
// Live-update a row's Total cell as the operator types (no save needed to see it).
function pdMatrixRecalc(inp) {
  const box = document.getElementById('pd-store-stocks'); if (!box) return;
  const vid = inp.dataset.variantId;
  const sum = Array.from(box.querySelectorAll('input[data-variant-id="' + vid + '"]'))
    .reduce((a, i) => a + (Math.max(0, parseInt(i.value, 10) || 0)), 0);
  const cell = box.querySelector('td.mtot[data-tot="' + vid + '"]');
  if (cell) cell.textContent = sum;
  pdRenderOnHand();   // the headline follows the cell being typed into
}
// Push per-variant totals (from matrix data) into VA_STORE_TOTALS + the variants
// table, so the read-only STOCK column there matches this grid exactly.
function pdSyncVariantTotals(d) {
  const qty = d.qty || {}, stores = d.stores || [];
  const totals = {};
  (d.variants || []).forEach(v => {
    totals[v.id] = stores.reduce((a, s) => a + ((qty[v.id] && qty[v.id][s.store_id]) || 0), 0);
  });
  VA_STORE_TOTALS = totals;
  (VA_MEMBERS || []).forEach(m => { if (totals[m.id] != null) m.stock = totals[m.id]; });
  if (document.getElementById('pd-variants') && VA_ID != null) vaRender();
}
// Persist any changed cells. Each changed (variant, store) cell is PATCHed to
// THAT variant's product (data-variant-id), so stock lands on the right row and
// a ledger entry is recorded. Untouched cells are skipped.
// Auto-save a single stock cell on blur (only if it changed) — mirrors the old
// "Save stock" button's per-cell PATCH, so each store's physical_qty lands with
// its ledger row. Blur debounces naturally (one save per cell you leave).
async function pdMatrixCellSave(inp) {
  if (!inp || String(inp.value) === String(inp.dataset.orig)) return;
  const qty = Math.max(0, parseInt(inp.value, 10) || 0);
  const pid = inp.dataset.variantId, sid = inp.dataset.storeId;
  const msg = document.getElementById('pd-store-stocks-msg');
  if (msg) msg.textContent = cuT('Saving…', '保存中…');
  try {
    const r = await fetch('/api/retail-admin/stores/' + sid + '/stock/' + pid, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ physical_qty: qty, reason: 'manual' }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.success !== false) {
      inp.value = qty; inp.dataset.orig = String(qty);
      if (msg) msg.textContent = cuT('Saved', '已保存');
      _paStockMirror(pid, sid, qty);
      pdMatrixSyncTotals();
    } else {
      if (msg) msg.textContent = '';
      toast(cuT('Stock save failed', '库存保存失败'), 'err');
    }
  } catch (e) {
    if (msg) msg.textContent = '';
    toast(cuT('Stock save failed', '库存保存失败'), 'err');
  }
}
// Recompute per-variant stock totals from the live cells + mirror them to the
// variants table so the read-only STOCK column stays in sync.
function pdMatrixSyncTotals() {
  const box = document.getElementById('pd-store-stocks'); if (!box) return;
  const inputs = Array.from(box.querySelectorAll('input[data-store-id]'));
  const totals = {};
  inputs.forEach(i => { const v = i.dataset.variantId; totals[v] = (totals[v] || 0) + Math.max(0, parseInt(i.value, 10) || 0); });
  VA_STORE_TOTALS = totals;
  (VA_MEMBERS || []).forEach(m => { if (totals[m.id] != null) m.stock = totals[m.id]; });
  if (document.getElementById('pd-variants') && VA_ID != null) vaRender();
  pdSetStockTabCount(Object.values(totals).reduce((a, n) => a + n, 0));
}
// Tab glance chips — a live hint of what's inside Stock/Page without opening
// them. Purely cosmetic (the tab label), never read by save/load code.
function pdSetStockTabCount(n) {
  const el = document.getElementById('pd-tab-cnt-stock');
  if (!el) return;
  if (n == null || !Number.isFinite(n)) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = String(n);
  el.style.display = '';
}
function pdSetPageTabChip(on) {
  const el = document.getElementById('pd-tab-chip-page');
  if (!el) return;
  if (!on) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = cuT('Designed', '已设计');
  el.style.display = '';
}
// Supplier-direct items hold no stock of ours, so the "When out of stock" policy
// is meaningless for them — swap it for the "Supplier out — pause selling" switch.
// Called on open and whenever the "Ships directly from supplier" flag is toggled.
function pdSyncSupplierUi() {
  const sup = document.getElementById('pd-ship-from-supplier');
  const on = !!(sup && sup.checked);
  const oos = document.getElementById('pd-oos-block');
  const sb  = document.getElementById('pd-supplier-block');
  if (oos) oos.style.display = on ? 'none' : '';
  if (sb)  sb.style.display  = on ? '' : 'none';
  // The per-location stock counts mean nothing for supplier-direct items (they
  // hold no stock of ours), so hide them and show a note instead.
  const sf = document.getElementById('pd-stock-fields');
  const sn = document.getElementById('pd-stock-supplier-note');
  if (sf) sf.style.display = on ? 'none' : '';
  if (sn) sn.style.display = on ? '' : 'none';
  // Mirror the state onto the two Sourcing radio cards (the real control the
  // operator clicks) — pd-ship-from-supplier stays the single source of truth.
  const choice = document.getElementById('pd-source-choice');
  if (choice) choice.querySelectorAll('.pd-radio-card').forEach(function (c) {
    c.classList.toggle('is-on', (c.getAttribute('data-src') === 'sup') === on);
  });
}
// Sourcing radio cards (Stock pane) — set the underlying checkbox and repaint.
function pdSetSourceMode(shipsFromSupplier) {
  const sup = document.getElementById('pd-ship-from-supplier');
  if (!sup) return;
  sup.checked = !!shipsFromSupplier;
  pdSyncSupplierUi();
}
async function pdOpen(id) {
  // Flush any not-yet-fired debounced autosave from whatever product is
  // currently loaded BEFORE overwriting the form below. Switching products
  // (or closing) used to just clearTimeout() the pending save here, silently
  // dropping the operator's last edit whenever it landed within the 800ms
  // debounce window (e.g. tick a checkbox, immediately click another row).
  if (_pdAutoTimer) {
    clearTimeout(_pdAutoTimer);
    _pdAutoTimer = null;
    try { await pdAutoSaveNow(); } catch (e) {}
  }
  // Always land in the dock. Opening a different product while the full page
  // is up would otherwise leave product B's fields under product A's title,
  // with the list that chose it hidden behind them.
  if (pdIsExpanded()) pdCollapseToPanel();
  const p = id != null ? (PA_PRODUCTS || []).find(x => x.id === id) : null;
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = (v == null ? '' : v); };
  document.getElementById('pd-id').value = p ? p.id : '';
  document.getElementById('pd-title').textContent = p ? (p.name_en || p.name_cn || 'Product · 产品') : 'New product · 新增产品';
  // Header identity strip: product thumbnail, SKU · shop-state subtitle, bundle pill.
  { const th = document.getElementById('pd-head-thumb');
    if (th) { const img = p && (p.image_data || p.image_url); th.style.backgroundImage = img ? 'url("' + img + '")' : ''; }
    // The subtitle is identity only now — the code and how many sizes it comes
    // in. Shop state left it for a tag on the row below, because a switch
    // written as prose reads as a fact about the product rather than a thing
    // you can change.
    const sub = document.getElementById('pd-head-sub');
    if (sub) {
      if (!p) { sub.textContent = cuT('Not saved yet', '尚未保存'); }
      else {
        const bits = [p.sku ? 'SKU ' + p.sku : cuT('No SKU', '无货号')];
        const sizes = (VA_MEMBERS || []).length;
        if (sizes > 1) bits.push(sizes + ' ' + cuT('sizes', '规格'));
        sub.textContent = bits.join(' · ');
      }
    } }
  set('pd-name-en', p && p.name_en); set('pd-name-cn', p && p.name_cn);
  set('pd-price', p ? p.sell_price : ''); set('pd-compare', p && p.compare_at_price);
  // Blank when unknown, never 0 — see pdRenderMargin.
  set('pd-cost', p && p.unit_cost != null ? p.unit_cost : '');
  pdApplyCostSource(p);
  pdRenderMargin();
  // The build list (Step 3). Loads for every product, including a brand-new
  // one (id null → the empty state), because the pane must never paint a
  // previous product's lines while this one's are in flight. Re-applies the
  // cost source once the lines land, since HAVING a build list is itself what
  // makes the manual cost field read-only — a fact only known after the fetch.
  if (typeof blLoad === 'function') {
    Promise.resolve(blLoad(p && p.id)).then(function () {
      pdApplyCostSource(p);
    });
  }
  set('pd-sku', p && p.sku); set('pd-weight', p && p.size);
  set('pd-status', p ? (p.status || 'Active') : 'Active');
  set('pd-low-stock', p && p.low_stock_threshold != null ? p.low_stock_threshold : '');
  { const ls = document.getElementById('pd-low-stock'); if (ls) ls.placeholder = cuT('Default', '默认') + ' ' + PA_LOW_STOCK; }
  pdFreeOfSet(p && p.free_of); set('pd-notes', p && p.notes); pdFactsSet(p && p.product_facts);
  const ck = (el, v) => { const n = document.getElementById(el); if (n) n.checked = !!v; };
  ck('pd-is-market', p && p.is_market === 1); ck('pd-is-batch-made', p && p.is_batch_made === 1); ck('pd-is-restock-only', p && p.is_restock_only === 1);
  ck('pd-ship-from-supplier', p && p.ship_from_supplier === 1);
  ck('pd-supplier-paused', p && p.supplier_paused === 1);
  // Out-of-stock policy. Show the effective value: a blank policy on a legacy
  // batch meal reads as "backorder outside GZ" (and persists explicitly on save).
  { const os = document.getElementById('pd-oos-policy');
    if (os) os.value = (p && p.oos_policy) || (p && p.is_batch_made === 1 ? 'backorder_gz' : 'strict'); }
  pdSyncSupplierUi();
  pdLoadStoreStocks(p ? p.id : null);
  set('pd-badge', p ? pdBadgeOf(p.tags) : '');
  // Description is always the Classic (rich-text) editor now. A legacy plain
  // row is promoted to HTML so old text still shows formatted; on next save it
  // is stored as rich.
  const wasRich = p && p.description_format === 'rich';
  document.getElementById('pd-rte-en').innerHTML = wasRich ? pdRichForEdit(p.description_en) : pdPlainToHtml(p && p.description_en);
  document.getElementById('pd-rte-cn').innerHTML = wasRich ? pdRichForEdit(p.description_cn) : pdPlainToHtml(p && p.description_cn);
  pdApplyDescMode();
  _pdUseBlockDesign = !!(p && p.use_block_design === 1);
  _pdDesignStale = false; pdRenderDesignStale();
  pdRenderBlockDesignToggle();
  const modes = String((p && p.ship_modes) || 'air,land').toLowerCase();
  const localOnly = /(^|,)\s*local\s*(,|$)/.test(modes);
  document.getElementById('pd-ship-local').checked = localOnly;
  document.getElementById('pd-ship-air').checked  = !localOnly && (!p || modes.includes('air'));
  document.getElementById('pd-ship-land').checked = !localOnly && (!p || modes.includes('land'));
  pdShipModeChanged();
  document.getElementById('pd-published').checked = p ? p.is_published === 1 : false;
  pdRenderHeadTags();   // the header's shop tag reads that checkbox, so paint after it
  // Photo gallery — start empty, then (for an existing product) pull the
  // ordered list from the lightweight images endpoint. New products start blank.
  _pdGallery = []; _pdGalleryDirty = false; _pdGalleryInherited = false;
  pdRenderGallery(); pdGalleryWire();
  document.getElementById('pd-img-file').value = '';
  if (p) {
    fetch('/api/retail-admin/products/' + p.id + '/images', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(j => { if (j && j.success && Array.isArray(j.images)) { _pdGallery = j.images.slice(); _pdGalleryInherited = !!j.inherited; pdRenderGallery(); if (_pdOpenBaseline) _pdOpenBaseline.gallery = _pdGallery.slice(); } })
      .catch(() => {});
  }
  pdLoadCatTree().then(() => {
    pdFillTopCats(p && p.top_category);
    pdFillSubCats(p && p.top_category, p && p.subcategory);
  });
  // Duplicate + delete only apply to an existing product.
  document.getElementById('pd-dup-btn').style.display = p ? '' : 'none';
  document.getElementById('pd-delete-btn').style.display = p ? '' : 'none';
  vaLoad(p ? p.id : null);
  buLoad(p ? p.id : null);
  bpLoad(p ? p.id : null);
  optLoad(p ? p.id : null);
  pdLoadSales(p ? p.id : null);
  // Show the docked editor, hide the empty-state placeholder, and mark which
  // row in the list is currently loaded so the operator never loses their place.
  _pdSelectedId = p ? p.id : null;
  pdShowDocked();
  paApplyRowSelection();
  // Autosave: reset the engine for the freshly-loaded product and capture the
  // "as-opened" baseline (updated again once async images arrive) so Revert can
  // roll the whole session back.
  pdWireAutosave();
  _pdAutoTimer = null; _pdSaving = false; _pdPendingResave = false;
  _pdOpenBaseline = pdSnapshot();
  pdSetStatus(p ? 'saved' : 'hint', p ? cuT('All changes saved', '已自动保存') : cuT('Add a name & SKU to start autosaving', '填写名称和货号后自动保存'));
}
// Sales card — units/revenue/rank for the loaded product over a chosen
// window (7d/30d/90d), fed by GET /api/retail-admin/products/:id/sales. The
// command search palette's "N sold · 30d" badge on a product hit answers the
// quick version of "how's this selling"; this card is the full one once
// you're on the product itself, with a rank-among-all-products and a
// zero-filled daily spark line for the window.
let _pdSalesId = null;
let _pdSalesDays = 30;
let _pdSalesSeq = 0;

function pdSetSalesRange(days, btn) {
  _pdSalesDays = days;
  document.querySelectorAll('#pd-sales-chips .pd-chip').forEach(b => b.classList.toggle('pd-chip-active', b === btn));
  pdLoadSales(_pdSalesId);
}

// ── The sales card's context line ────────────────────────────────────────────
// There is no chart. A product that sells a handful of times a month — which
// is most of this catalogue — gave a daily series that was ~83% empty, and
// bucketing it only moved the problem. These two facts are what the shape was
// standing in for: has it sold recently, and does it sell steadily or once in
// a while. Reports is the page built for time series.
// Dates are the window's own days (GZ-local, from the server), so this compares
// them as plain YYYY-MM-DD keys rather than reconstructing a timezone.
function pdSalesWhen(iso) {
  if (!iso) return '';
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const key = d => d.toISOString().slice(0, 10);
  if (iso === key(now)) return cuT('today', '今天');
  if (iso === key(new Date(now.getTime() - 86400000))) return cuT('yesterday', '昨天');
  const days = Math.round((Date.parse(key(now)) - Date.parse(iso)) / 86400000);
  if (days > 1 && days <= 30) return cuT(days + ' days ago', days + ' 天前');
  const d = new Date(iso + 'T00:00:00Z');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return cuT(mon + ' ' + d.getUTCDate(), (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日');
}
function pdSalesContext(d) {
  const n = Number(d.selling_days || 0);
  if (!n) return cuT('No sales in this window', '此区间暂无销量');
  const when = pdSalesWhen(d.last_sale);
  const days = n === 1
    ? cuT('1 selling day', '1 天有销量')
    : cuT(n + ' selling days', n + ' 天有销量');
  return when
    ? cuT('Last sale ' + when, '最近售出 ' + when) + ' · ' + days
    : days;
}
// The range belongs in the card's own title, so the numbers under it are never
// read against the wrong window once the chips scroll out of view.
function pdSalesRangeLabel() {
  if (_pdSalesDays === 'all') return cuT('Sales · all time', '销量 · 全部时间');
  return cuT('Sales · last ' + _pdSalesDays + ' days', '销量 · 最近 ' + _pdSalesDays + ' 天');
}

async function pdLoadSales(id) {
  _pdSalesId = id;
  const card = document.getElementById('pd-sales-card');
  if (!card) return;
  if (id == null) { card.style.display = 'none'; return; }
  card.style.display = '';
  const mySeq = ++_pdSalesSeq;
  const setText = (elId, v) => { const n = document.getElementById(elId); if (n) n.textContent = v; };
  setText('pd-sales-units', '…'); setText('pd-sales-revenue', '…'); setText('pd-sales-rank', '…');
  setText('pd-sales-title', pdSalesRangeLabel());
  setText('pd-sales-context', '');
  let j;
  try {
    const r = await fetch('/api/retail-admin/products/' + id + '/sales?days=' + _pdSalesDays, { credentials: 'same-origin' });
    j = await r.json();
  } catch { j = null; }
  if (mySeq !== _pdSalesSeq) return; // a newer range click superseded this fetch
  if (!j || !j.success) {
    setText('pd-sales-units', '—'); setText('pd-sales-revenue', '—'); setText('pd-sales-rank', '—');
    setText('pd-sales-context', cuT('Couldn’t load sales', '无法加载销量'));
    return;
  }
  const d = j.data;
  setText('pd-sales-units', Number(d.units || 0).toLocaleString());
  setText('pd-sales-revenue', '¥' + Number(d.revenue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('pd-sales-rank', d.rank ? ('#' + d.rank + ' / ' + d.total_products) : cuT('No sales', '暂无销量'));
  setText('pd-sales-context', pdSalesContext(d));
}

// Docked editor visibility — pdShowDocked reveals the editor in the right
// column; pdClose hides it back to the empty-state placeholder.
// Also ensures the right pane is visible — pdOpen can be called from "+ Add
// product" or from duplicate while the operator is in grid/compact scan mode
// (where listonly hides the editor); reveal it so the new product isn't
// invisible behind the catalogue.
function pdShowDocked() {
  const ed = document.getElementById('pd-editor');
  _paEditorOpen = true;
  if (ed) ed.style.display = '';
  pdOpenDrawer();
  // Every open lands on the Basics pane — no matter which pane was showing when
  // the previous product was closed.
  pdTab('basics');
  // First paint of the summary rows. The va*/bu*/bp*/opt* loads that follow are
  // async and each repaints again as it lands, so this only has to be right for
  // the fields already in the form.
  pdRenderSummaries();
  // The list is untouched by the drawer now — it keeps its own page size and
  // its own scroll position, and the row stays lit where the operator left it.
  paRender();
}
// ── The drawer, opened and closed ───────────────────────────────────────────
// Esc closes it (§1.13), but never while a nested overlay owns the key — the
// lightbox, the library picker and the version-history modal all sit on top of
// the drawer and each closes itself first.
function pdOpenDrawer() {
  const bg = document.getElementById('pd-bg');
  const scrim = document.getElementById('pd-scrim');
  if (bg) bg.classList.add('is-open');
  if (scrim) scrim.classList.add('is-open');
  document.addEventListener('keydown', pdDrawerEsc);
}
function pdCloseDrawer() {
  const bg = document.getElementById('pd-bg');
  const scrim = document.getElementById('pd-scrim');
  if (bg) bg.classList.remove('is-open');
  if (scrim) scrim.classList.remove('is-open');
  document.removeEventListener('keydown', pdDrawerEsc);
}
function pdDrawerEsc(e) {
  if (e.key !== 'Escape') return;
  // Anything stacked over the drawer answers Esc before the drawer does.
  if (document.querySelector('#pd-lightbox, body > .pu-editor-bg, .pm-pick-bg')) return;
  const rte = document.getElementById('pd-desc-rich');
  if (rte && rte.classList.contains('pd-rte-fs')) return;   // fullscreen editor first
  pdClose();
}
// Focused-panes tab switch — show one pane (Basics/Stock/Page/Details) at a
// time. Pure show/hide; every field stays in the DOM so saves/loads are
// unaffected by which pane is visible. Called by the tab buttons and on open.
function pdTab(name) {
  const ed = document.getElementById('pd-editor');
  if (!ed) return;
  ed.querySelectorAll('.pd-tab').forEach(function (b) {
    const on = b.getAttribute('data-pane') === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ed.querySelectorAll('.pd-pane').forEach(function (p) {
    p.classList.toggle('is-active', p.getAttribute('data-pane') === name);
  });
  // Switching panes scrolls the body back to the top so the new pane starts at
  // its heading, not wherever the last pane was scrolled to.
  const body = ed.querySelector('.pu-editor-body');
  if (body) body.scrollTop = 0;
}
function pdClose() {
  // Closing from the full page has to bring the editor home first, or its node
  // would be hidden inside a stage that stays on screen with the list behind it.
  if (pdIsExpanded()) pdCollapseToPanel();
  // Deselect — the editor returns to the empty-state placeholder. (Closing the
  // editor doesn't close the page; the list stays put.)
  _pdSelectedId = null;
  _paEditorOpen = false;
  const ed = document.getElementById('pd-editor');
  pdCloseDrawer();
  if (ed) ed.style.display = 'none';
  _pdGallery = []; _pdGalleryDirty = false;
  const ri = document.getElementById('pd-desc-rich'); if (ri) ri.classList.remove('pd-rte-fs');
  document.body.classList.remove('pd-rte-fs-lock');
  // Re-expand the list back into the full-width overview table, then re-pull
  // per-store stock from the server so the Stock column shows the real saved
  // numbers — not the page-load cache. The in-memory mirror (_paStockMirror)
  // keeps the same page in sync after a matrix edit, but it can't cover a
  // second open tab, a variant member saved under a different id, or a cell
  // that never blurred; a fresh /inventory/grid read is authoritative.
  paRender();
  paLoadStoreStock();
}
// Revert to last save: roll the form back to the snapshot captured when this
// product was opened, then autosave that restored state so it's the live version
// again. Undoes a whole editing session's worth of autosaves in one step.
async function pdRevert() {
  if (_pdSelectedId == null) { pdClose(); return; }
  if (!(await askConfirm({
    title: cuT('Revert to the last-saved version?', '还原到上次保存的版本?'),
    body: cuT('This undoes every change since you opened this product.', '这将撤销自打开此产品以来的所有修改。'),
    confirmLabel: cuT('Revert', '还原'),
    danger: true,
  }))) return;
  if (_pdOpenBaseline) {
    pdApplySnapshot(_pdOpenBaseline);
    clearTimeout(_pdAutoTimer); _pdAutoTimer = null;
    pdAutoSaveNow();   // persist the rolled-back state immediately
  } else {
    pdOpen(_pdSelectedId);
  }
}
// ── Version history (the editor's "Version history" button) ─────────────────
// The product editor autosaves; the server checkpoints each distinct saved
// state. This opens a modal listing every saved version of the OPEN product
// (newest first, "Original" tag on the pre-edit baseline) so the operator can
// roll back to any of them. Replaces the old single-step "revert to last save".
// Format a server UTC timestamp ('YYYY-MM-DD HH:MM:SS') as GZ-local "Today
// 14:32" / "Yesterday 09:10" / "Jun 14, 18:05".
function pdFmtVersionTime(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(s);
  const gz = new Date(d.getTime() + 8 * 3600 * 1000);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const key = x => x.toISOString().slice(0, 10);
  const hh = String(gz.getUTCHours()).padStart(2, '0'), mm = String(gz.getUTCMinutes()).padStart(2, '0');
  const t = hh + ':' + mm;
  const k = key(gz);
  if (k === key(now)) return cuT('Today ', '今天 ') + t;
  if (k === key(new Date(now.getTime() - 86400000))) return cuT('Yesterday ', '昨天 ') + t;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][gz.getUTCMonth()];
  return cuT(mon + ' ' + gz.getUTCDate() + ', ' + t, (gz.getUTCMonth() + 1) + '月' + gz.getUTCDate() + '日 ' + t);
}
async function pdOpenVersions() {
  const id = document.getElementById('pd-id').value;
  if (!id) { toast(cuT('Add a name first — versions are saved as you edit.', '请先填写名称 — 编辑时会自动保存版本。')); return; }
  let list;
  try { const j = await api('/api/retail-admin/products/' + id + '/versions'); list = j.versions || []; }
  catch (e) { toast(cuT('Could not load versions: ', '无法加载版本:') + e.message, 'err'); return; }
  const rows = list.length ? list.map((v, i) => {
    const tag = v.is_baseline
      ? `<span style="font-size:10px;font-weight:600;color:var(--text-3);border:1px solid var(--line,#d9d3c6);border-radius:6px;padding:1px 6px;margin-left:8px;">${cuT('Original', '原始版本')}</span>`
      : (i === 0 ? `<span style="font-size:10px;font-weight:600;color:var(--accent,#365329);border:1px solid var(--accent,#365329);border-radius:6px;padding:1px 6px;margin-left:8px;">${cuT('Current', '当前')}</span>` : '');
    const by = v.edited_by ? `<div class="muted" style="font-size:11px;margin-top:2px;">${cuT('by ', '操作人:')}${escapeHtml(v.edited_by)}</div>` : '';
    const disabled = i === 0 ? ' disabled style="opacity:.5;cursor:default;"' : '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 18px;border-top:1px solid var(--line,#eee);">
        <div><div style="font-size:13px;font-weight:500;">${pdFmtVersionTime(v.created_at)}${tag}</div>${by}</div>
        <button class="btn btn-sm" onclick="pdRestoreVersion(${v.id})"${disabled}>${cuT('Restore', '还原')}</button>
      </div>`;
  }).join('') : `<div class="muted" style="padding:20px 18px;">${cuT('No earlier versions yet — they’re saved automatically as you edit.', '暂无历史版本 — 编辑时会自动保存。')}</div>`;
  const bg = document.createElement('div');
  bg.className = 'pu-editor-bg'; bg.style.display = 'flex';
  bg.innerHTML = `
    <div class="pu-editor" style="width:460px;max-width:92vw;">
      <div class="pu-editor-head">
        <div>
          <h3 style="margin:0;font-size:14px;">${cuT('Version history', '历史版本')}</h3>
          <div class="muted" style="font-size:11px;margin-top:2px;">${cuT('Roll this product back to any saved version. Stock counts are never changed.', '将此产品还原到任意已保存的版本。库存数量不会被更改。')}</div>
        </div>
        <button class="btn" onclick="this.closest('.pu-editor-bg').remove()">${cuT('Close', '关闭')}</button>
      </div>
      <div class="pu-editor-body" style="display:block;padding:0 0 8px;max-height:60vh;overflow:auto;">${rows}</div>
    </div>`;
  mountFloatingPuModal(bg);
}
async function pdRestoreVersion(versionId) {
  const id = document.getElementById('pd-id').value; if (!id) return;
  if (!(await askConfirm({
    title: cuT('Restore this version?', '还原此版本?'),
    body: cuT(
      'The product’s current content (name, price, description, photos, category…) is replaced with this version. A new version is kept first, so you can undo. Stock is not changed.',
      '产品当前内容(名称、价格、描述、图片、分类…)将被此版本替换。会先保留一个新版本以便撤销。库存不会更改。'),
    confirmLabel: cuT('Restore', '还原'),
    danger: true,
  }))) return;
  try {
    await api('/api/retail-admin/products/' + id + '/restore-version', { method: 'POST', body: { version_id: versionId } });
    document.querySelectorAll('body > .pu-editor-bg').forEach(x => x.remove());
    await pdOpen(Number(id));   // reload the editor with the restored content
    toast(cuT('Restored to the chosen version.', '已还原到所选版本。'));
  } catch (e) { toast(cuT('Restore failed: ', '还原失败:') + e.message, 'err'); }
}
// ── The drawer header's state row ───────────────────────────────────────────
// Shop state first, and it is a control: tapping it publishes or hides the
// product. #pd-published stays the single source of truth — this paints from
// it and writes back to it, so the Basics switch and this tag can never
// disagree. After it come the states worth knowing before you edit: sold out,
// and bundle. Three is the ceiling (§1.10a); a fourth belongs in a pane.
function pdRenderHeadTags() {
  const box = document.getElementById('pd-head-tags');
  if (!box) return;
  const pub = !!(document.getElementById('pd-published') || {}).checked;
  const p = (PA_PRODUCTS || []).find(x => x.id === _pdSelectedId) || null;
  const tags = [];
  tags.push(
    `<button type="button" class="pd-tag pd-tag-shop${pub ? ' is-live' : ' is-off'}"`
    + ` onclick="pdToggleShopTag()"`
    + ` title="${pub ? cuT('Live in the shop — tap to hide', '已上架 — 点按下架')
                     : cuT('Hidden from shoppers — tap to publish', '未上架 — 点按上架')}"`
    + ` aria-pressed="${pub}">`
    + (pub ? cuT('In shop', '已上架') : cuT('Hidden', '未上架'))
    + '<span class="pd-tag-sw"></span></button>');
  if (p && !p.ship_from_supplier && _paStockOf(p) <= 0) {
    tags.push(`<span class="pd-tag is-warn"><i></i>${cuT('Sold out', '缺货')}</span>`);
  }
  if (p && (p.is_bundle || p.bundle_mode === 'prepacked')) {
    tags.push(`<span class="pd-tag is-fact">${cuT('Bundle', '套装')}</span>`);
  }
  box.innerHTML = tags.join('');
}
// Flip it here and the Basics switch moves with it, because they are the same
// checkbox. Autosave is scheduled by hand: setting .checked in code fires no
// change event, so the editor's own input listener would never hear it.
function pdToggleShopTag() {
  const cb = document.getElementById('pd-published');
  if (!cb) return;
  cb.checked = !cb.checked;
  pdRenderHeadTags();
  pdScheduleAutosave();
}

// ── Two zoom levels on one editor ───────────────────────────────────────────
// Docked, #pd-editor sits in the right column beside the list and shows the
// quick fields plus a summary row for anything with sub-rows. Expanded, the
// SAME node moves into #pd-pagestage and everything opens out on one page.
// Moving the node (rather than rendering a second copy) is what keeps ids,
// typed-but-unsaved values, the RTE's contents and every va*/bu*/bp*/opt*
// renderer working across the switch without a line of sync code.
function pdIsExpanded() {
  const st = document.getElementById('pd-pagestage');
  return !!(st && st.style.display !== 'none');
}
function pdMoveEditor(where) {
  const ed = document.getElementById('pd-editor');
  const home = document.getElementById(where === 'ppage' ? 'pd-pp-mount' : 'pd-bg');
  if (!ed || !home || ed.parentElement === home) return;
  home.appendChild(ed);
}
// The editor's two pieces of live state — "All changes saved" and the shop
// switch — belong beside the title while the full page is open, and back in
// the drawer's own chrome when it closes. Docked they are fine where they
// are: the drawer is one screen tall, so the footer is always in view. On the
// page the footer is three screens down, which is the whole reason this moves:
// a page that writes every keystroke has to say so where you are looking.
// Same trick as the editor itself — move the node, never render a second one.
function pdMoveHeadState(where) {
  const status = document.getElementById('pd-save-status');
  const tags   = document.getElementById('pd-head-tags');
  if (where === 'ppage') {
    // Two slots, not one: the shop switch is a control and sits with the
    // Collapse button on the top row; the save state is a report and sits
    // under it, right-aligned against the same edge.
    const tagSlot = document.getElementById('pd-pp-tags');
    const stateSlot = document.getElementById('pd-pp-state');
    if (!tagSlot || !stateSlot) return;
    if (tags) tagSlot.appendChild(tags);
    if (status) stateSlot.appendChild(status);
    return;
  }
  // Home again. Order matters inside the footer — the status reads first, then
  // the spacer, then the record's actions.
  const foot = document.querySelector('#pd-editor .pu-editor-foot');
  const band = document.querySelector('#pd-editor .pd-head-state');
  if (foot && status) foot.insertBefore(status, foot.firstChild);
  if (band && tags) band.insertBefore(tags, band.firstChild);
}
// ── The page's second column ────────────────────────────────────────────────
// The page is weighted, not uniform. The LEFT column is the short story of a
// product — what it is called, what it costs, what it looks like, where it
// shows, how much there is, what sizes, what the shop page says. The RIGHT one
// holds what you read but cannot change (sales) and what you set once when the
// product is created and then leave alone for a year (how it ships, what it is
// free of, the flags, the internal note) — plus the record's own actions, which
// otherwise sit below every field on the page with Delete at the end of it.
//
// Docked, none of this applies: the drawer shows one pane at a time, so nothing
// is competing and every block stays where it was authored.
//
// The blocks are MOVED, not re-rendered — same rule as the editor itself. Each
// move remembers the parent and the sibling it left, so collapsing puts every
// block back exactly where it came from rather than somewhere that merely looks
// right today.
//
// 🔴 The side column lives INSIDE #pd-editor. Thousands of lines of
// retail-admin.css are scoped `#pd-editor …`, so a block moved outside the
// editor arrives stripped of its card, heading, fields and chips.
const PD_SIDE_BLOCKS = [
  '#pd-sales-card',      // read-only: the one block on the page you cannot change
  '#pd-sec-shipping',
  '#pd-sec-freeof',
  '#pd-sec-flags',
  '#pd-sec-notes',
  '.pd-foot-acts',       // Duplicate · Version history · Delete
];
let _pdSideHomes = null;

function pdMoveSideBlocks(where) {
  if (where === 'ppage') {
    const side = document.getElementById('pd-pp-side');
    // Already out there. Moving again would record the side column as each
    // block's home and strand them there on collapse.
    if (!side || _pdSideHomes) return;
    _pdSideHomes = [];
    for (const sel of PD_SIDE_BLOCKS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      _pdSideHomes.push({ el, parent: el.parentElement, next: el.nextElementSibling });
      side.appendChild(el);
    }
    return;
  }
  if (!_pdSideHomes) return;
  // Back-to-front: each block's remembered `next` sibling is itself a block
  // that moved, so restoring in reverse means the anchor is always home before
  // the thing that points at it.
  for (const h of _pdSideHomes.slice().reverse()) {
    if (!h.parent) continue;
    const anchor = h.next && h.next.parentElement === h.parent ? h.next : null;
    h.parent.insertBefore(h.el, anchor);
  }
  _pdSideHomes = null;
}

// Photos belong to Basics, not beside it. Two cards standing side by side read
// as two separate questions; on the page the photo strip becomes the lower half
// of the Basics card, under a hairline. Same move-and-remember rule.
let _pdPhotosHome = null;

function pdMovePhotos(where) {
  const photos = document.getElementById('pd-sec-photos');
  if (!photos) return;
  if (where === 'ppage') {
    if (_pdPhotosHome) return;
    const basics = document.querySelector('#pd-editor .pd-pane[data-pane="basics"] .pdb-card');
    if (!basics || basics === photos) return;
    _pdPhotosHome = { parent: photos.parentElement, next: photos.nextElementSibling };
    basics.appendChild(photos);
    return;
  }
  if (!_pdPhotosHome || !_pdPhotosHome.parent) { _pdPhotosHome = null; return; }
  const h = _pdPhotosHome;
  const anchor = h.next && h.next.parentElement === h.parent ? h.next : null;
  h.parent.insertBefore(photos, anchor);
  _pdPhotosHome = null;
}

// Expand. `section` optionally scrolls to one part of the page — 'basics',
// 'stock', 'sizes', 'more', 'page' or 'details' — which is what the dock's
// summary rows pass when the operator taps through from a summary.
function pdExpand(section) {
  const ed = document.getElementById('pd-editor');
  const stage = document.getElementById('pd-pagestage');
  if (!ed || !stage || ed.style.display === 'none') return;   // nothing open
  ed.classList.add('pd-fullpage');
  // Leaving the drawer for the page: the drawer chrome and its scrim go first,
  // or a fixed-position shell would follow the editor out and cover the page.
  pdCloseDrawer();
  pdMoveEditor('ppage');
  // The full page REPLACES the catalogue — title, sub-view switch, pulse,
  // chips, toolbar and the list all step aside, and the breadcrumb becomes the
  // way back. One class does it so nothing has to remember an inline display.
  document.getElementById('tab-products')?.classList.add('pd-page-open');
  stage.style.display = '';
  pdMoveHeadState('ppage');
  pdMoveSideBlocks('ppage');
  pdMovePhotos('ppage');
  pdSyncPageHead();
  pdSyncFullscreenBtn(true);
  window.scrollTo({ top: 0, behavior: 'auto' });
  // After the scroll home, so the observer's first report is the true one.
  pdWatchPin(true);
  if (section) {
    // 'sizes' and 'more' were two sections and are now one ("How it's sold"),
    // so both dock summary rows land on the same block. The two names stay
    // because the summaries that pass them are still two separate rows.
    const el = (section === 'more' || section === 'sizes')
               ? document.getElementById('pd-sec-sizes')
             : ed.querySelector(`.pd-pane[data-pane="${section}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}
function pdCollapseToPanel() {
  const ed = document.getElementById('pd-editor');
  const stage = document.getElementById('pd-pagestage');
  if (ed) ed.classList.remove('pd-fullpage');
  // Unpin FIRST. The condensed bar is holding .pd-pp-acts, which is where the
  // shop switch and the save state are parked; hand it back to the header
  // before pdMoveHeadState comes looking for them.
  pdWatchPin(false);
  // Status and shop switch come home BEFORE the stage is hidden — leave them
  // parked in the title row and they ride a `display:none` container back into
  // invisibility while the drawer shows an empty footer.
  pdMoveHeadState('dock');
  // Same reason, and same order — the side column is inside the editor.
  pdMovePhotos('dock');
  pdMoveSideBlocks('dock');
  pdMoveEditor('dock');
  if (stage) stage.style.display = 'none';
  document.getElementById('tab-products')?.classList.remove('pd-page-open');
  // Back to the glance: the drawer comes with it, but only if a product is
  // actually open — collapsing on the way to closing must not re-open it.
  if (_paEditorOpen) pdOpenDrawer();
  pdSyncFullscreenBtn(false);
  // State can have moved while the page was open (a size added, a bundle set
  // up, a description written) — repaint the summaries that stand for it.
  pdRenderSummaries();
  // Land at the top of the catalogue rather than at whatever depth the full
  // page was scrolled to, which would drop the operator into the middle of a
  // list they were not reading.
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function pdSyncFullscreenBtn(on) {
  const btn = document.getElementById('pd-expand-btn');
  if (btn) btn.innerHTML = on ? '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/></svg>Collapse · 收起' : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/></svg>Expand · 展开';
}
// The Expand button now toggles between the two zoom levels.
function pdToggleFullscreen() { pdIsExpanded() ? pdCollapseToPanel() : pdExpand(); }

// ── The condensed header ────────────────────────────────────────────────────
// The full page is three screens tall and writes on every keystroke, so the
// one line that says it saved cannot be the first thing to scroll away (§1.7:
// the page header is never scrolled away). Past the header, #pd-pp-bar takes
// over: which product, whether it is in the shop, whether it saved, the way
// out.
//
// The switch and the save state are the SAME nodes in both places — .pd-pp-acts
// moves into the bar and back, which is this page's one rule about live state
// kept once more: move the node, never render a second one. Two copies of a
// switch is two things to keep in step, and they drift.
//
// The name is the single exception, because a bar that names the record cannot
// borrow the node from a header that is off screen. Both are painted in the
// same pass of pdSyncPageHead, so they cannot disagree.
let _pdPinObs = null;
function pdPinHead(on) {
  const stage = document.getElementById('pd-pagestage');
  const bar   = document.getElementById('pd-pp-bar');
  const acts  = document.getElementById('pd-pp-acts');
  const head  = document.getElementById('pd-pp-head');
  if (!stage || !bar || !acts || !head) return;
  if (!!on === stage.classList.contains('is-pinned')) return;
  stage.classList.toggle('is-pinned', !!on);
  // Ahead of the back button, so the way out stays last in the row and last in
  // the tab order — same order as the resting header, where it is the crumb.
  if (on) bar.insertBefore(acts, bar.querySelector('.pd-pp-bar-back'));
  else head.appendChild(acts);
}
// Watch a 1px sentinel sitting where the bar would pin, rather than listening
// to scroll: the browser reports the crossing once instead of on every frame.
function pdWatchPin(on) {
  if (_pdPinObs) { _pdPinObs.disconnect(); _pdPinObs = null; }
  if (!on) { pdPinHead(false); return; }
  const sent = document.getElementById('pd-pp-sentinel');
  if (!sent || typeof IntersectionObserver !== 'function') return;
  // -56px = the topbar's locked height, which is also where the bar perches,
  // so the sentinel leaves the box at exactly the moment the bar gets there.
  _pdPinObs = new IntersectionObserver(
    (entries) => { for (const e of entries) pdPinHead(!e.isIntersecting); },
    { rootMargin: '-56px 0px 0px 0px', threshold: 0 });
  _pdPinObs.observe(sent);
}
// Breadcrumb + title of the full page, read from the live form so a rename
// typed a second ago is already reflected up top.
function pdSyncPageHead() {
  const nm = (document.getElementById('pd-name-en').value || '').trim();
  const alt = (document.getElementById('pd-name-cn').value || '').trim();
  const shown = nm || alt || cuT('New product', '新产品');
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('pd-pp-name', shown);
  set('pd-pp-name-alt', nm && alt ? alt : '');
  // The condensed bar says the name too. It is the only thing on this page
  // rendered twice, and only because the bar has to name the record while the
  // header that names it is off screen — both are painted here, in one pass,
  // so they cannot disagree.
  set('pd-pp-bar-name', shown);
  const p = (PA_PRODUCTS || []).find(x => x.id === _pdSelectedId);
  // The product's own photo, at both sizes. No image is a quiet raised tile —
  // the same tile the drawer header shows — never a placeholder graphic.
  { const img = p && (p.image_data || p.image_url);
    for (const id of ['pd-pp-thumb', 'pd-pp-bar-thumb']) {
      const th = document.getElementById(id);
      if (th) th.style.backgroundImage = img ? 'url("' + img + '")' : '';
    } }
  const badge = document.getElementById('pd-pp-badge');
  if (badge) badge.innerHTML = p ? _paStatusCell({ p, group: null }) : '';
  // The line under the title: the few facts that identify this record without
  // scrolling to them. Read from the live form, so a SKU typed a second ago is
  // already up here. Anything blank drops out rather than showing an empty slot.
  const sub = document.getElementById('pd-pp-sub');
  if (sub) {
    const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
    const sel = (id) => {
      const el = document.getElementById(id);
      if (!el || !el.selectedOptions || !el.selectedOptions[0]) return '';
      const t = (el.selectedOptions[0].textContent || '').trim();
      return t.startsWith('—') ? '' : t;
    };
    const sku = val('pd-sku');
    const where = [sel('pd-top-category'), sel('pd-subcategory')].filter(Boolean).join(', ');
    const price = val('pd-price');
    const bits = [];
    if (sku) bits.push(cuT('SKU ', '货号 ') + sku);
    if (where) bits.push(where);
    if (price) bits.push('¥' + price);
    sub.textContent = bits.join(' · ');
  }
}

// ── Dock summaries ──────────────────────────────────────────────────────────
// What the docked panes show in place of the sections that only open out on
// the full page. Each is a read of live state, never a second source of truth:
// the sizes row counts VA_MEMBERS, the more-ways row counts BP/BU/OPT, the page
// row reads the RTE the operator is typing into. Re-rendered whenever any of
// those renderers finish (see the tails of vaRender/buRender/bpRender/optRender)
// and on every collapse, so a summary can never describe a stale product.
function _pdSumRow(title, value, section, action) {
  return `<button type="button" class="pd-sumrow" onclick="pdExpand('${section}')">`
    + `<span class="pd-sm-main"><span class="pd-sm-t">${title}</span><span class="pd-sm-v">${value}</span></span>`
    + `<span class="pd-sm-go">${action || cuT('Edit', '编辑')}`
    + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg></span></button>';
}
function _pdJumpBtn(label, section) {
  return `<button type="button" class="pd-jump-btn" onclick="pdExpand('${section}')">`
    + '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
    + label + '</button>';
}
function pdRenderSummaries() {
  if (!document.getElementById('pd-sum-stock')) return;
  const open = _pdSelectedId != null || document.getElementById('pd-editor').style.display !== 'none';
  if (!open) return;
  const p = (PA_PRODUCTS || []).find(x => x.id === _pdSelectedId) || null;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

  // Stock — sourcing, then sizes when this product has real siblings.
  const supplier = !!(document.getElementById('pd-ship-from-supplier') || {}).checked;
  let rows = _pdSumRow(
    cuT('Sourcing', '货源'),
    supplier ? cuT('Ships directly from supplier', '供应商直发') : cuT('We hold the stock', '我们持有库存'),
    'stock');
  const sizes = (VA_MEMBERS || []).length;
  if (sizes > 1) {
    rows += _pdSumRow(
      cuT('Sizes', '规格'),
      sizes + ' ' + cuT('sizes · each with its own price and stock', '个规格 · 各有独立价格与库存'),
      'sizes');
  }
  set('pd-sum-stock', `<div class="pd-sumcard">${rows}</div>`
    + (sizes > 1
      ? `<div class="pd-jumpnote">${cuT('This product is stocked per size. Open the full page to set each size’s price and count.', '此产品按规格分别计库存。打开完整页面可分别设置各规格的价格与数量。')}</div>`
        + _pdJumpBtn(cuT('Expand to edit sizes', '展开编辑规格'), 'sizes')
      : ''));

  // Sell it in more ways — one row, and only once something is set up. An
  // empty signpost is clutter; the full page is where you go to start one.
  const nBundle = (BP || []).length ? 1 : 0;
  const nAddons = ((BU && BU.ids) || []).length;
  const nOpts   = (OPT || []).length;
  if (nBundle || nAddons || nOpts) {
    const parts = [];
    if (nBundle) parts.push(cuT('1 bundle', '1 个套装'));
    if (nAddons) parts.push(nAddons + ' ' + cuT('add-ons', '个搭配'));
    if (nOpts)   parts.push(nOpts + ' ' + cuT('choice groups', '组选项'));
    set('pd-sum-more', `<div class="pd-sumcard">${
      _pdSumRow(cuT('Sell it in more ways', '更多售卖方式'), parts.join(' · '), 'more', cuT('Expand', '展开'))
    }</div>`);
  } else {
    set('pd-sum-more', `<div class="pd-sumcard">${
      _pdSumRow(cuT('Sell it in more ways', '更多售卖方式'),
        cuT('Bundles, add-ons, choices — none yet', '套装、搭配、选项 — 暂未设置'), 'more', cuT('Set up', '设置'))
    }</div>`);
  }

  // Page — is there a designed page, and is the description written.
  const designed = p ? _paHasBlocks(p) : false;
  const rteEn = document.getElementById('pd-rte-en');
  const rteCn = document.getElementById('pd-rte-cn');
  const written = !!((rteEn && rteEn.textContent.trim()) || (rteCn && rteCn.textContent.trim()));
  // The "design is out of date" nudge lives inside the block the dock hides,
  // so carry its warning up into the summary — otherwise editing a name or a
  // description in the dock would silently stale the page with nothing to say so.
  const pageState = _pdDesignStale ? cuT('Designed page — out of date', '已设计页面 — 已过期')
    : designed ? cuT('Designed page', '已设计页面')
    : cuT('Default template', '默认模板');
  set('pd-sum-page', '<div class="pd-sumcard">'
    + _pdSumRow(cuT('Shopper page', '顾客页面'), pageState, 'page',
        _pdDesignStale ? cuT('Rebuild', '重新生成') : null)
    + _pdSumRow(cuT('Description', '描述'),
        written ? cuT('Written', '已填写') : cuT('Not written yet', '尚未填写'), 'page')
    + '</div>'
    + _pdJumpBtn(cuT('Expand to write the page', '展开编辑页面'), 'page'));

  // Details — the three things that live there, each shown as its own answer.
  const ship = ['air', 'land', 'local']
    .filter(k => (document.getElementById('pd-ship-' + k) || {}).checked)
    .map(k => ({ air: cuT('Air', '空运'), land: cuT('Land', '陆运'), local: cuT('Local only', '仅广州') })[k]);
  const flags = [
    [(document.getElementById('pd-is-market') || {}).checked, cuT('Markets', '市集')],
    [(document.getElementById('pd-is-batch-made') || {}).checked, cuT('Made in batches', '分批现做')],
    [(document.getElementById('pd-is-restock-only') || {}).checked, cuT('Restock-only', '仅补货')],
  ].filter(x => x[0]).map(x => x[1]);
  const freeOf = Array.from(document.querySelectorAll('#pd-free-of input[data-freeof-id]'))
    .filter(i => i.checked).map(i => i.dataset.freeofId);
  const dash = cuT('Not set', '未设置');
  set('pd-sum-details', '<div class="pd-sumcard">'
    + _pdSumRow(cuT('Shipping', '配送方式'), ship.length ? ship.join(' · ') : dash, 'details')
    + _pdSumRow(cuT('Flags', '标记'), flags.length ? flags.join(' · ') : cuT('None', '无'), 'details')
    + _pdSumRow(cuT('Free of', '不含'), freeOf.length ? escapeHtml(freeOf.join(' · ')) : cuT('None', '无'), 'details')
    + '</div>'
    + `<div class="pd-jumpnote">${cuT('These change rarely, so they live on the full page and the panel stays quick.', '这些很少改动,因此放在完整页面,面板保持轻快。')}</div>`
    + _pdJumpBtn(cuT('Expand to edit details', '展开编辑详情'), 'details'));
}
// Currently-selected product id (the one loaded in the docked editor). Used to
// paint the row highlight and to power Discard / post-save reload.
let _pdSelectedId = null;
// True whenever the in-page editor is docked open (an existing product OR a
// brand-new unsaved one, where _pdSelectedId is still null). Drives the list's
// overview↔docked layout: editor closed = full-width overview table; editor
// open = narrow compact list beside the form.
let _paEditorOpen = false;
function paApplyRowSelection() {
  const grid = document.getElementById('pa-grid');
  if (!grid) return;
  grid.querySelectorAll('.pa-row.is-selected, .pa-card.is-selected').forEach(el => el.classList.remove('is-selected'));
  if (_pdSelectedId == null) return;
  // Both row and card markups bind `onclick="paOpenEdit(<id>)"` — find the
  // element whose handler references the selected id and flag it.
  const sel = grid.querySelector(`[onclick*="paOpenEdit(${_pdSelectedId})"]`);
  if (sel) sel.classList.add('is-selected');
}

// ── Product variants (managed inside the product editor) ────────────────────
// Group sibling products as variants. Each variant is its own master-data
// product (own stock/price); this only sets variant_group_id + variant_label,
// via /api/retail-admin/products/:id/variants. Same model as the customer
// switcher + the staff grouping.
let VA_ID = null, VA_MEMBERS = [], VA_HAD_GROUP = false, VA_OPEN = false;
// Variant AXIS noun for this group — what the storefront picker heading calls
// the choice (operator types just the noun: "color" / "颜色"). Blank → the
// storefront default "size" / "规格". Saved to every member by vaPersist.
let VA_NOUN_EN = '', VA_NOUN_CN = '';
// Live per-variant stock totals (variantId → sum across stores), filled by the
// variant × store matrix panel. The variants table reads these for its
// read-only STOCK column so both views always agree.
let VA_STORE_TOTALS = {};
// Last-loaded stock-by-location matrix payload, kept so the panel can re-render
// live when variants are renamed/added/removed on the left — without an exit +
// re-open. Cleared when the editor opens a new product.
let PD_STOCK_DATA = null;
function _vaName(p) { return (p.name_en || '—') + (p.name_cn ? ' · ' + p.name_cn : ''); }
// Both halves of the row's own name, kept RAW and separate, because the Name
// column stacks EN over CN the way the Label inputs do. `name` above stays the
// glued one-line form and is used only where one line IS the shape: a title=
// tooltip, and the SKU-clash message. A column cell is not one line, and the job
// of this one — comparing a sibling's name against the rest of its family —
// happens one language at a time.
function _vaNameParts(p) { return { name_en: (p.name_en || '').trim(), name_cn: (p.name_cn || '').trim() }; }
// Picker row label (escaped HTML): the name plus a quiet disambiguator so two
// products that share a name — e.g. the same butter in two sizes — can be told
// apart. Prefer the variant/size, fall back to SKU.
function _vaPickName(p) {
  const tag = ((p.variant_label || '').trim() || (p.size || '').trim() || (p.sku || '').trim());
  return escapeHtml(_vaName(p)) + (tag ? ` <span class="bu-pick-tag">${escapeHtml(tag)}</span>` : '');
}
async function vaLoad(id) {
  const box = document.getElementById('pd-variants'); if (!box) return;
  VA_ID = id; VA_MEMBERS = []; VA_HAD_GROUP = false; VA_STORE_TOTALS = {}; VA_NOUN_EN = ''; VA_NOUN_CN = '';
  if (!id) {
    box.innerHTML = `<div class="pd-var-head">${cuT('Variants', '规格')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then variants open here.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可在此添加规格。')}</div>`;
    return;
  }
  box.innerHTML = `<div class="pd-var-head">${cuT('Variants', '规格')}</div><div class="helper" style="font-size:11px">${cuT('Loading…', '加载中…')}</div>`;
  const p = (PA_PRODUCTS || []).find(x => x.id === id) || { id };
  try {
    const j = await api('/api/retail-admin/products/' + id + '/variants');
    const members = (j.data && j.data.members) || [];
    VA_HAD_GROUP = !!(j.data && j.data.group_id);
    VA_NOUN_EN = (j.data && j.data.noun_en) || '';
    VA_NOUN_CN = (j.data && j.data.noun_cn) || '';
    // Stock shown on the self row = the live per-store total (Tianhe + Yuexiu),
    // not the legacy flat stock_qty (which per-store edits never touch). Falls
    // back to stock_qty only if no per-store sum is known yet.
    const self = { id, label: p.variant_label || '', label_cn: p.variant_label_cn || '', name: _vaName(p), ..._vaNameParts(p), sku: p.sku || '', size: p.size || '', price: p.sell_price, compare: (p.compare_at_price != null ? p.compare_at_price : ''), stock: (p.effective_stock != null ? p.effective_stock : p.stock_qty), published: p.is_published, img: (p.image_data || p.image_url || ''), ownImg: !!(p.image_data || p.image_url), self: true };
    VA_MEMBERS = members.length
      ? members.map(m => ({ id: m.id, label: m.variant_label || '', label_cn: m.variant_label_cn || '', name: _vaName(m), ..._vaNameParts(m), sku: m.sku || '', size: m.size || '', price: m.price, compare: (m.compare != null ? m.compare : ''), stock: m.stock, published: m.is_published, img: (m.image_data || ''), ownImg: !!m.own_image, self: m.id === id }))
      : [self];
    if (!VA_MEMBERS.some(v => v.self)) VA_MEMBERS.unshift(self);
  } catch { VA_MEMBERS = [{ id, label: p.variant_label || '', label_cn: p.variant_label_cn || '', name: _vaName(p), ..._vaNameParts(p), img: (p.image_data || p.image_url || ''), ownImg: !!(p.image_data || p.image_url), self: true }]; }
  // Open by default only when there's something to show (real sibling variants);
  // a single-option product starts collapsed so the editor isn't cluttered.
  VA_OPEN = VA_MEMBERS.length > 1;
  if (VA_ID === id) vaRender();   // ignore if the editor moved on
}
function vaToggle() { VA_OPEN = !VA_OPEN; vaRender(); }
function vaRender() {
  const box = document.getElementById('pd-variants'); if (!box || VA_ID == null) return;
  // Collapsible header (open/close toggle). Summary tells the operator the state
  // without expanding: "Single option" vs "N variants".
  const hasReal = VA_MEMBERS.length > 1;
  const summary = hasReal
    ? cuT(VA_MEMBERS.length + ' variants', VA_MEMBERS.length + ' 个规格')
    : cuT('Single option · tap to add', '单一规格 · 点击添加');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="vaToggle()" aria-expanded="${VA_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${VA_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Variants', '规格')}</span>` +
    `<span class="pd-var-summary">${summary}</span></button>`;
  if (!VA_OPEN) { box.innerHTML = toggle; return; }
  // NAME and LABEL are two columns, not one. The column that used to be headed
  // "Name" held the variant TAG (variant_label / variant_label_cn) — the word
  // the shopper picks, "Big" / "大". The row's own product name was in a title=
  // tooltip and nowhere else, so a sibling whose name disagrees with the rest of
  // its family was invisible on the one screen that lists the family.
  const head = `<div class="va-row va-row-head"><span></span><span>${cuT('Photo', '图片')}</span>` +
    `<span>${cuT('Name', '名称')}</span><span>${cuT('Label', '规格标签')}</span>` +
    `<span>${cuT('SKU', '货号')}</span><span>${cuT('Weight', '规格')}</span>` +
    `<span class="va-num">¥</span><span class="va-num">${cuT('Was', '划线价')}</span><span class="va-num">${cuT('Stock', '库存')}</span>` +
    `<span style="text-align:center">${cuT('Show', '上架')}</span><span></span></div>`;
  const rows = VA_MEMBERS.map((v, i) => {
    const price = (v.price != null && v.price !== '') ? Number(v.price) : '';
    // Was-price (compare-at): optional original price. Shown struck-through to
    // shoppers when it's higher than the live price; blank/0 = no discount.
    const cmp = (v.compare != null && v.compare !== '' && Number(v.compare) > 0) ? Number(v.compare) : '';
    // STOCK column is read-only here — the real number is the per-store total
    // from the Stock-by-location grid (VA_STORE_TOTALS), falling back to the
    // value the variants endpoint computed.
    const totStock = (VA_STORE_TOTALS && VA_STORE_TOTALS[v.id] != null) ? VA_STORE_TOTALS[v.id] : v.stock;
    const stock = (totStock != null && totStock !== '') ? totStock : '';
    const oos = stock !== '' && Number(stock) <= 0;
    const rowOpen = `<div class="va-row${oos ? ' va-oos' : ''}" draggable="false" ondragover="vaDragOver(event, ${i})" ondragleave="vaDragLeave(event)" ondrop="vaDrop(event, ${i})" ondragend="vaDragEnd()">`;
    const grip = `<span class="va-drag" draggable="true" ondragstart="vaDragStart(event, ${i})" title="${cuT('Drag to reorder', '拖动以排序')}">⠿</span>`;
    // Per-variant photo. Each variant is its own product, so it can carry its own
    // picture; with none of its own it inherits a sibling's (shown dimmed + a
    // "shared" hint). The self row's photo is the main gallery above — its thumb
    // just jumps there. Siblings open a file picker (vaPhotoPick).
    const thumbStyle = v.img ? `background-image:url('${String(v.img).replace(/'/g, '%27')}')` : '';
    const shared = !!v.img && !v.ownImg && !v.self;
    const photoCls = 'va-photo' + (v.img ? '' : ' va-photo-empty') + (shared ? ' va-photo-shared' : '');
    const photo = v.self
      ? `<button type="button" class="${photoCls}" style="${thumbStyle}" title="${cuT('Main photo — edit it in the gallery above', '主图 — 在上方图库中编辑')}" onclick="vaPhotoGallery()">${v.img ? '' : '＋'}</button>`
      : `<button type="button" class="${photoCls}" data-vid="${v.id}" style="${thumbStyle}" title="${shared ? cuT('Shared from another variant — click to give this one its own photo', '与其他规格共用 — 点击为本规格设置专属图片') : (v.img ? cuT('Change this variant’s photo', '更换此规格的图片') : cuT('Add a photo for this variant', '为此规格添加图片'))}" onclick="vaPhotoPick(${v.id})">${v.img ? '' : '＋'}</button>`;
    // The row's OWN product name (store_products.name_en / name_cn), read-only,
    // and the way into that row's own editor — one click, the same paOpenEdit()
    // a standalone card uses.
    //
    // STACKED EN OVER CN, one line each, the same shape as the Label inputs
    // beside it — never glued into "EN · CN". A tooltip may glue, because a
    // tooltip is one line by nature; a column cell is not, and the job of this
    // one is COMPARING a sibling's name against the rest of its family, which is
    // read in one language at a time. Two lines scan; a middle dot has to be
    // parsed. The order is fixed and does not follow the language toggle,
    // because both halves are the point.
    const nameLines =
      `<span>${escapeHtml(v.name_en || '—')}</span>` +
      `<span class="va-rowname-cn">${escapeHtml(v.name_cn || '—')}</span>`;
    // NOT EDITABLE HERE, ON PURPOSE. The sibling's own editor is the single
    // writer for a name (paOpenEdit → pdOpen → PATCH), so there is one field per
    // fact rather than two that can disagree, and vaPersistSiblings still
    // carries no name. The self row is the product already open in the form
    // above — it gets the text without the click-through, because that click
    // would re-open the editor the operator is already standing in.
    const rowName = v.self
      ? `<span class="va-rowname va-rowname-self" title="${escapeAttr(v.name)}">${nameLines}</span>`
      : `<button type="button" class="va-rowname" title="${escapeAttr(v.name + '\n' + cuT('Edit this variant', '编辑此规格'))}" onclick="paOpenEdit(${v.id})">${nameLines}</button>`;
    // Variant option LABEL is split EN/CN (never glued) — one input per language,
    // stacked, so "Big 200g" and "大" are stored & shown separately.
    const label = `<div class="va-name">` +
      `<input class="va-label" type="text" value="${escapeAttr(v.label)}" placeholder="${cuT('English · e.g. Big 200g', '英文 · 如 Big 200g')}" oninput="vaLabel(${v.id}, 'en', this.value)">` +
      `<input class="va-label va-label-cn" type="text" value="${escapeAttr(v.label_cn || '')}" placeholder="${cuT('中文 · 如 大 200克', '中文 · 如 大 200克')}" oninput="vaLabel(${v.id}, 'cn', this.value)">` +
      `</div>`;
    // STOCK is read-only on every row — it's a per-store total, edited in the
    // Stock-by-location grid (right). A flat field here would clash with the
    // per-store ledger. The total stays live: editing/saving the grid re-renders.
    const stkCell = `<span class="va-ro va-stk" title="${cuT('Stock is per store — set it in “Stock by location”.', '库存按门店计 — 在「各门店库存」中设置。')}">${stock === '' ? '—' : escapeHtml(String(stock))}</span>`;
    if (v.self) {
      // The opened product. Its quick fields are editable here too, mirrored into
      // the main form inputs above so the normal Save persists them (see
      // vaSelfField).
      return rowOpen + grip + photo + rowName + label +
        `<input class="va-label" type="text" value="${escapeAttr(v.sku || '')}" placeholder="${cuT('SKU', '货号')}" oninput="vaSelfField('sku', this.value)">` +
        `<input class="va-label va-wt" type="text" value="${escapeAttr(v.size || '')}" placeholder="${cuT('e.g. 200 g', '如 200克')}" title="${cuT('Size / weight shown on the size picker', '规格选择器上显示的规格 / 净重')}" oninput="vaSelfField('weight', this.value)">` +
        `<input class="va-num" type="number" min="0" step="0.01" value="${price === '' ? '' : price}" placeholder="0" oninput="vaSelfField('price', this.value)">` +
        `<input class="va-num va-was" type="number" min="0" step="0.01" value="${cmp === '' ? '' : cmp}" placeholder="—" title="${cuT('Was price — shown struck-through to shoppers when higher than the price. Leave blank for no discount.', '划线价 — 高于售价时在顾客端显示删除线。留空则不打折。')}" oninput="vaSelfField('compare', this.value)">` +
        stkCell +
        `<span class="va-show"><input type="checkbox" ${v.published ? 'checked' : ''} title="${cuT('Show this variant in the shop', '在店面显示此规格')}" onchange="vaSelfField('published', this.checked ? 1 : 0)"></span>` +
        // Trailing cell: a lone product has no siblings, so the single row IS the
        // product — show a ✕ that deletes it (otherwise there's no way to remove a
        // size-less product from this table). In a real group the primary keeps the
        // ● badge (deleting the anchor while siblings exist would orphan them — delete
        // the other sizes first, then this becomes a lone row you can ✕).
        (hasReal
          ? `<span class="va-self" title="${cuT('This is the main product. Its name, photos & details are edited in the form above; the quick fields here stay in sync. To remove the whole family, delete the other sizes first.', '这是主产品。名称、图片和详情在上方表单中编辑;此处的快捷字段保持同步。如需删除整个系列,请先删除其他规格。')}">●</span>`
          : `<button type="button" class="va-x" title="${cuT('Delete this product', '删除此产品')}" onclick="vaRemoveSelf()">✕</button>`) +
        `</div>`;
    }
    return rowOpen + grip + photo + rowName + label +
      `<input class="va-label" type="text" value="${escapeAttr(v.sku || '')}" placeholder="${cuT('SKU', '货号')}" oninput="vaField(${v.id}, 'sku', this.value)">` +
      `<input class="va-label va-wt" type="text" value="${escapeAttr(v.size || '')}" placeholder="${cuT('e.g. 200 g', '如 200克')}" title="${cuT('Size / weight shown on the size picker', '规格选择器上显示的规格 / 净重')}" oninput="vaField(${v.id}, 'weight', this.value)">` +
      `<input class="va-num" type="number" min="0" step="0.01" value="${price === '' ? '' : price}" placeholder="0" oninput="vaField(${v.id}, 'price', this.value)">` +
      `<input class="va-num va-was" type="number" min="0" step="0.01" value="${cmp === '' ? '' : cmp}" placeholder="—" title="${cuT('Was price — shown struck-through to shoppers when higher than the price. Leave blank for no discount.', '划线价 — 高于售价时在顾客端显示删除线。留空则不打折。')}" oninput="vaField(${v.id}, 'compare', this.value)">` +
      stkCell +
      `<span class="va-show"><input type="checkbox" ${v.published ? 'checked' : ''} title="${cuT('Show this variant in the shop', '在店面显示此规格')}" onchange="vaField(${v.id}, 'published', this.checked ? 1 : 0)"></span>` +
      `<button type="button" class="va-x" title="${cuT('Delete this variant', '删除此规格')}" onclick="vaRemove(${v.id})">✕</button></div>`;
  }).join('');
  // What is this variant axis? Operator types just the noun ("color", "flavor").
  // The storefront picker heading becomes "Choose a {noun}" / "选择{noun}". Blank
  // → falls back to "size" / "规格". Only shown for a real group (≥2 variants).
  const nounRow = hasReal
    ? `<div class="va-noun">` +
        `<span class="va-noun-lbl">${cuT('What are these variants? · 这些规格是什么?', '这些规格是什么? · What are these variants?')}</span>` +
        `<input class="va-label" type="text" value="${escapeAttr(VA_NOUN_EN)}" maxlength="40" placeholder="${cuT('English · e.g. size, color, flavor', '英文 · 如 size, color')}" title="${cuT('Shoppers see “Choose a {word}”', '顾客看到「Choose a {词}」')}" oninput="vaNoun('en', this.value)">` +
        `<input class="va-label va-label-cn" type="text" value="${escapeAttr(VA_NOUN_CN)}" maxlength="40" placeholder="${cuT('中文 · 如 规格、颜色、口味', '中文 · 如 颜色')}" title="${cuT('顾客看到「选择{词}」', 'Shoppers see “选择{词}”')}" oninput="vaNoun('cn', this.value)">` +
        `<span class="va-noun-hint">${cuT('Picker heading — blank = “size / 规格”.', '选择器标题 — 留空为「size / 规格」。')}</span>` +
      `</div>`
    : '';
  box.innerHTML =
    toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px;margin-top:6px">${cuT('Sell this product in several variants. Each has its own name, SKU, price & stock. Drag ⠿ to set the order shoppers see.', '以多种规格出售本产品。每种规格有独立的名称、货号、价格与库存。拖动 ⠿ 可调整顾客看到的顺序。')}</div>` +
    nounRow +
    `<div class="va-table">${head}${rows}</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="vaAddSize()">${cuT('+ Add variant', '+ 新增规格')}</button>` +
    `</div>`;
  pdRenderSummaries();
}
function vaLabel(id, lang, val) { const v = VA_MEMBERS.find(x => x.id === id); if (v) { if (lang === 'cn') v.label_cn = val; else v.label = val; pdSyncMatrixLabels(); } }
// Variant-axis noun — mutates the model only (no re-render, keeps input focus);
// persisted to every member by vaPersist on the main Save.
function vaNoun(lang, val) { if (lang === 'cn') VA_NOUN_CN = val; else VA_NOUN_EN = val; }
// The opened ("self") product's quick fields mirror straight into the main form
// inputs above, so the normal Save persists them — no separate write, and the
// form stays in sync. Stock is intentionally not here: it's set in the
// per-location panel below.
function vaSelfField(key, val) {
  const v = VA_MEMBERS.find(x => x.self); if (!v) return;
  if (key === 'sku') {
    v.sku = val;
    const f = document.getElementById('pd-sku'); if (f) f.value = val;
  } else if (key === 'price') {
    v.price = (val === '' ? '' : Math.max(0, parseFloat(val) || 0));
    const f = document.getElementById('pd-price'); if (f) f.value = val;
  } else if (key === 'published') {
    v.published = val ? 1 : 0;
    const f = document.getElementById('pd-published'); if (f) f.checked = !!val;
  } else if (key === 'compare') {
    v.compare = (val === '' ? '' : Math.max(0, parseFloat(val) || 0));
    const f = document.getElementById('pd-compare'); if (f) f.value = val;
  } else if (key === 'weight') {
    v.size = val;
    const f = document.getElementById('pd-weight'); if (f) f.value = val;
  }
}
// Inline edit of a sibling size's commercial fields. Mutates the model only
// (no re-render, so the input keeps focus); persisted by the main Save.
function vaField(id, key, val) {
  const v = VA_MEMBERS.find(x => x.id === id); if (!v || v.self) return;
  if (key === 'price')      v.price = (val === '' ? '' : Math.max(0, parseFloat(val) || 0));
  else if (key === 'stock') v.stock = (val === '' ? '' : Math.max(0, parseInt(val, 10) || 0));
  else if (key === 'sku')   v.sku = val;
  else if (key === 'weight') v.size = val;
  else if (key === 'published') v.published = val ? 1 : 0;
  else if (key === 'compare') v.compare = (val === '' ? '' : Math.max(0, parseFloat(val) || 0));
  v._dirty = true;
}
// The self row's photo IS the main product photo — jump up to the gallery
// (above) rather than editing it twice from two places.
function vaPhotoGallery() {
  const g = document.getElementById('pd-gallery');
  if (g) g.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
// Pick + set a sibling variant's own photo. Each variant is its own product, so
// this PATCHes that product's image directly (it persists immediately, like
// add/remove variant — not folded into the main Save). Replaces the variant's
// gallery with the one chosen photo, which is what a per-variant pic wants.
function vaPhotoPick(id) {
  const v = VA_MEMBERS.find(x => x.id === id); if (!v || v.self) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) vaPhotoUpload(id, f); };
  inp.click();
}
async function vaPhotoUpload(id, file) {
  const v = VA_MEMBERS.find(x => x.id === id); if (!v || v.self) return;
  const cell = document.querySelector('#pd-variants .va-photo[data-vid="' + id + '"]');
  if (cell) cell.classList.add('va-photo-busy');
  // Same resize/optimise pipeline as the main gallery (base64 in image_data).
  const dataURL = await pdHandleImageUpload(file, PD_IMG_OPTS);
  if (!dataURL) { if (cell) cell.classList.remove('va-photo-busy'); return; }
  try {
    const j = await api('/api/retail-admin/products/' + id, { method: 'PATCH', body: { images: [dataURL] } });
    v.img = dataURL; v.ownImg = true;
    if (j && j.data && Array.isArray(PA_PRODUCTS)) {
      const i = PA_PRODUCTS.findIndex(x => x.id === id);
      if (i >= 0) PA_PRODUCTS[i] = { ...PA_PRODUCTS[i], ...j.data };
    }
    vaRender();
    toast(cuT('Variant photo updated', '规格图片已更新'));
  } catch (e) {
    if (cell) cell.classList.remove('va-photo-busy');
    toast(cuT('Photo update failed: ', '图片更新失败:') + e.message, 'err');
  }
}
// Drag-to-reorder the sizes. The row order = the front-end display order; it
// rides the main Save (vaPersist sends members in array order → variant_sort).
let VA_DRAG = null;
function vaDragStart(e, i) { VA_DRAG = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {} }
function vaDragOver(e, i) {
  if (VA_DRAG == null || VA_DRAG === i) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  row.classList.toggle('va-drop-before', i < VA_DRAG);
  row.classList.toggle('va-drop-after',  i > VA_DRAG);
}
function vaDragLeave(e) { e.currentTarget.classList.remove('va-drop-before', 'va-drop-after'); }
function vaDrop(e, i) {
  e.preventDefault();
  const from = VA_DRAG; VA_DRAG = null;
  if (from == null || from === i) { vaDragEnd(); return; }
  const [moved] = VA_MEMBERS.splice(from, 1);
  VA_MEMBERS.splice(i, 0, moved);
  vaRender();
}
function vaDragEnd() { VA_DRAG = null; document.querySelectorAll('#pd-variants .va-row').forEach(r => r.classList.remove('va-drop-before', 'va-drop-after')); }
// ✕ deletes the size for good (its product is removed, like the main Delete).
// The opened size ("self") can't be deleted from here.
async function vaRemove(id) {
  const v = VA_MEMBERS.find(x => x.id === id); if (!v || v.self) return;
  const nm = (v.label && v.label.trim()) || v.name || ('#' + id);
  if (!(await askConfirm({
    title: cuT('Delete the variant “', '删除规格“') + nm + cuT('”?', '”?'),
    body: cuT('This removes that product for good.', '将永久删除该产品。'),
    confirmLabel: cuT('Delete', '删除'),
    danger: true,
  }))) return;
  try {
    await api('/api/retail-admin/products/' + id, { method: 'DELETE' });
    VA_MEMBERS = VA_MEMBERS.filter(m => m.id !== id);
    if (Array.isArray(PA_PRODUCTS)) PA_PRODUCTS = PA_PRODUCTS.filter(x => x.id !== id);
    vaRender();
    pdLoadStoreStocks(VA_ID);   // drop the removed variant's row from the stock grid
    toast(cuT('Size deleted', '规格已删除'));
  } catch (e) { toast(cuT('Delete failed: ', '删除失败:') + e.message, 'err'); }
}
// Delete the lone (size-less) product from its own variant row. Only offered
// when this is a single-variant product — the row IS the product, so this is the
// same soft-delete as the editor's "Delete product" button (pdDelete handles the
// confirm, endpoint call, list refresh & editor close). For a real group the
// primary keeps the ● badge instead; remove the other sizes first.
function vaRemoveSelf() {
  if (VA_MEMBERS.length > 1) return;
  pdDelete();
}
// Add a new size: clone the current product (inherits photos/description/etc.,
// blank SKU, 0 stock, hidden) and drop it straight into the list — no leaving
// the editor. Price/stock/label are then set inline and saved with the product.
async function vaAddSize() {
  if (VA_ID == null) { toast(cuT('Save the product first.', '请先保存产品。'), 'err'); return; }
  try {
    const j = await api('/api/retail-admin/products/' + VA_ID + '/duplicate', { method: 'POST', body: { as_variant: true, label: '' } });
    const d = j.data; if (!d) throw new Error('add_failed');
    if (Array.isArray(PA_PRODUCTS)) PA_PRODUCTS.unshift(d);
    VA_MEMBERS.push({ id: d.id, label: d.variant_label || '', label_cn: d.variant_label_cn || '', name: _vaName(d), ..._vaNameParts(d), sku: d.sku || '', size: d.size || '', price: d.sell_price, compare: (d.compare_at_price != null ? d.compare_at_price : ''), stock: d.stock_qty, published: d.is_published, img: (d.image_data || d.image_url || ''), ownImg: !!(d.image_data || d.image_url), self: false });
    VA_OPEN = true;
    vaRender();
    pdLoadStoreStocks(VA_ID);   // pull the new variant's row into the stock grid
    const last = document.querySelector('#pd-variants .va-row:last-child .va-label'); if (last) last.focus();
    toast(cuT('Variant added — set its name, SKU, price & stock, then Save.', '已添加规格 — 设置名称、货号、价格、库存后保存。'));
  } catch (e) { toast(cuT('Could not add variant: ', '无法添加规格:') + e.message, 'err'); }
}
// Persist the current variant grouping + labels and reflect them in the
// in-memory product list. Folded into the product's main Save (pdSave) so a
// single Save covers the whole editor. Throws on failure for the caller.
async function vaPersist() {
  if (VA_ID == null) return null;
  const members = VA_MEMBERS.map(v => ({ id: v.id, label: v.label || '', label_cn: v.label_cn || '' }));
  const j = await api('/api/retail-admin/products/' + VA_ID + '/variants', { method: 'PUT', body: { members, noun_en: VA_NOUN_EN || '', noun_cn: VA_NOUN_CN || '' } });
  const gid = j.group_id, ids = new Set(members.map(m => m.id));
  // The PUT writes variant_sort = array index; mirror that into the in-memory
  // rows so the grid's collapsed card re-sorts its size chips without a reload.
  const order = new Map(members.map((m, i) => [m.id, i]));
  (PA_PRODUCTS || []).forEach(p => {
    if (ids.has(p.id)) { p.variant_group_id = gid; p.variant_label = (members.find(m => m.id === p.id) || {}).label || null; p.variant_sort = order.get(p.id); }
    else if (p.variant_group_id === VA_ID) { p.variant_group_id = null; p.variant_label = null; }
  });
  return gid;
}
// Push inline price / sku / show edits for sibling sizes to their own product
// rows. The opened ("self") size is saved via the main form fields. Stock is
// NOT written here — it's per-store (retail_store_stock), owned by the
// Stock-by-location grid; writing the flat stock_qty would fight that ledger.
// Partial PATCH — only the listed fields change.
//
// oosPolicy: non-null when the self product's "When out of stock" setting
// changed THIS save — in that case every sibling gets it too (even ones with
// no other pending edit), so the whole size family always agrees. null means
// unchanged — skip untouched siblings as before.
async function vaPersistSiblings(oosPolicy) {
  const dirty = VA_MEMBERS.filter(v => !v.self && (v._dirty || oosPolicy != null));
  for (const v of dirty) {
    const body = {};
    if (v.price !== '' && v.price != null) body.sell_price = v.price;
    if (v.sku != null) body.sku = v.sku;
    if (v.size != null) body.weight = v.size;
    if (v.published === 0 || v.published === 1) body.is_published = v.published;
    // Was-price (compare-at): always sent so clearing it sticks. 0/blank → server
    // stores NULL (no strike-through). v.compare is loaded from the row, so a
    // price-only edit re-sends the existing value (a no-op) rather than wiping it.
    body.compare_at_price = (v.compare === '' || v.compare == null) ? 0 : v.compare;
    if (oosPolicy != null) body.oos_policy = oosPolicy;
    if (!Object.keys(body).length) { v._dirty = false; continue; }
    let j;
    try { j = await api('/api/retail-admin/products/' + v.id, { method: 'PATCH', body }); }
    catch (e) {
      if (String(e.message).includes('sku_taken')) {
        const sizeLabel = (v.label && v.label.trim()) || v.name || ('#' + v.id);
        throw new Error(skuTakenMsg(v.sku, e.data && e.data.conflict, sizeLabel));
      }
      throw e;
    }
    if (j && j.data && Array.isArray(PA_PRODUCTS)) {
      const i = PA_PRODUCTS.findIndex(x => x.id === v.id);
      if (i >= 0) PA_PRODUCTS[i] = { ...PA_PRODUCTS[i], ...j.data };
    }
    v._dirty = false;
  }
}
// ── "Buy together" bundle (editor) ──────────────────────────────────────────
// A bundle is a curated set of products shown on THIS product's page with one
// "add all to cart" tap. No bundle SKU — each item keeps its own price/stock.
// Stored on the product as the `bundle` JSON column; saved with the main Save.
let BU_ID = null, BU = { title_en: '', title_cn: '', ids: [], price: '', voucher: '' }, BU_PICKING = false, BU_OPEN = false;
function buLoad(id) {
  const box = document.getElementById('pd-bundle'); if (!box) return;
  BU_ID = id; BU_PICKING = false;
  BU = { title_en: '', title_cn: '', ids: [], price: '', voucher: '' };
  if (!id) {
    box.innerHTML = `<div class="pd-var-head">${cuT('Suggested add-ons', '推荐搭配')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then suggest add-ons here.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可在此推荐搭配商品。')}</div>`;
    return;
  }
  const p = (PA_PRODUCTS || []).find(x => x.id === id);
  const b = p && p.bundle && typeof p.bundle === 'object' ? p.bundle : null;
  if (b) {
    BU = {
      title_en: b.title_en || '', title_cn: b.title_cn || '',
      ids: Array.isArray(b.ids) ? b.ids.slice() : [],
      price: (b.price != null && b.price > 0) ? b.price : '',
      voucher: b.voucher || '',
    };
  }
  // Open by default only when a bundle already exists; an empty product starts
  // collapsed so the editor isn't cluttered (mirrors the Variants section).
  BU_OPEN = BU.ids.length > 0;
  buRender();
}
function buToggle() { BU_OPEN = !BU_OPEN; buRender(); }
function buRender() {
  const box = document.getElementById('pd-bundle'); if (!box || BU_ID == null) return;
  // Collapsible header (open/close toggle). Summary tells the operator the state
  // without expanding: "No bundle · tap to add" vs "N products".
  const summary = BU.ids.length
    ? cuT(BU.ids.length + ' products', BU.ids.length + ' 件商品')
    : cuT('None · tap to add', '暂无 · 点击添加');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="buToggle()" aria-expanded="${BU_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${BU_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Suggested add-ons', '推荐搭配')}</span>` +
    `<span class="pd-var-summary">${summary}</span></button>`;
  if (!BU_OPEN) { box.innerHTML = toggle; return; }
  const nameOf = id => { const p = (PA_PRODUCTS || []).find(x => x.id === id); return p ? _vaName(p) : ('#' + id); };
  const chips = BU.ids.length
    ? BU.ids.map(id => `<span class="bu-chip"><span title="${escapeAttr(nameOf(id))}">${escapeHtml(nameOf(id))}</span><button type="button" class="bu-chip-x" title="${cuT('Remove', '移除')}" onclick="buRemove(${id})">✕</button></span>`).join('')
    : `<span class="helper" style="font-size:11px">${cuT('No products yet — add some below.', '尚未添加商品 — 在下方添加。')}</span>`;
  const picker = BU_PICKING ? `
    <input id="bu-search" class="bu-search" type="text" autocomplete="off" placeholder="${cuT('Search a product to add…', '搜索商品以添加…')}" oninput="buPickerList()">
    <div id="bu-picklist" class="bu-picklist"></div>` : '';
  box.innerHTML = toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px">${cuT("Suggest other products on this product’s page — a one-tap “add these too”. Each item keeps its own price & stock; nothing here is a separate product.", '在本产品页面推荐其他商品 — 一键“一起加购”。每件商品保留各自价格与库存,此处不产生新的商品。')}</div>` +
    `<div class="bu-row2">` +
      `<div class="field"><label class="stacked">${cuT('Title EN', '标题(英文)')}</label><input type="text" value="${escapeAttr(BU.title_en)}" placeholder="Goes well with" oninput="buField('title_en', this.value)"></div>` +
      `<div class="field"><label class="stacked">${cuT('Title CN', '标题(中文)')}</label><input type="text" value="${escapeAttr(BU.title_cn)}" placeholder="推荐搭配" oninput="buField('title_cn', this.value)"></div>` +
    `</div>` +
    `<div class="bu-chips">${chips}</div>` +
    `<div class="bu-row2">` +
      `<div class="field"><label class="stacked">${cuT('Set price ¥ (optional)', '搭配价 ¥(可选)')}</label><input type="number" min="0" step="0.01" value="${BU.price === '' ? '' : BU.price}" placeholder="${cuT('blank = item total', '留空 = 各项合计')}" oninput="buField('price', this.value)"></div>` +
      `<div class="field"><label class="stacked">${cuT('Auto voucher (optional)', '自动优惠券(可选)')}</label><input type="text" value="${escapeAttr(BU.voucher)}" placeholder="${cuT('code', '券码')}" oninput="buField('voucher', this.value)"></div>` +
    `</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="buTogglePicker()">${BU_PICKING ? cuT('Close', '关闭') : cuT('+ Add product', '+ 添加商品')}</button>` +
    `</div>` + picker;
  if (BU_PICKING) { const s = document.getElementById('bu-search'); if (s) s.focus(); buPickerList(); }
  pdRenderSummaries();
}
function buField(key, val) {
  if (key === 'price') BU.price = (val === '' ? '' : Math.max(0, parseFloat(val) || 0));
  else BU[key] = val;
}
function buRemove(id) { BU.ids = BU.ids.filter(x => x !== id); buRender(); pdScheduleAutosave(); }
function buTogglePicker() { BU_PICKING = !BU_PICKING; buRender(); }
function buPickerList() {
  const el = document.getElementById('bu-picklist'); if (!el) return;
  const q = (document.getElementById('bu-search')?.value || '').toLowerCase().trim();
  const have = new Set(BU.ids);   // hide products already in the bundle
  const matches = (PA_PRODUCTS || []).filter(p => !have.has(p.id))
    .filter(p => !q || (p.name_en || '').toLowerCase().includes(q) || (p.name_cn || '').includes(q) || (p.sku || '').toLowerCase().includes(q))
    .slice(0, 40);
  el.innerHTML = matches.length
    ? matches.map(p => `<div class="bu-pick" onclick="buPick(${p.id})">${_vaPickName(p)}</div>`).join('')
    : `<div class="bu-pick muted">${cuT('No matches', '无匹配')}</div>`;
}
function buPick(id) {
  if (!BU.ids.includes(id)) BU.ids.push(id);
  const s = document.getElementById('bu-search'); if (s) s.value = '';
  buRender();
  pdScheduleAutosave();
}
// The bundle object for saving (null clears it). Folded into pdSave's body.
function buBody() {
  if (!BU.ids.length) return null;
  return {
    title_en: (BU.title_en || '').trim(), title_cn: (BU.title_cn || '').trim(),
    ids: BU.ids.slice(), price: BU.price === '' ? 0 : (Number(BU.price) || 0),
    voucher: (BU.voucher || '').trim(),
  };
}

// ── BUNDLE PRODUCT (editor) ─────────────────────────────────────────────────
// THIS product IS a bundle: it sells as one product (one card, one price set in
// the Price field above) but is really a fixed combination of OTHER products.
// At checkout the COMPONENT stock is deducted, and availability = min(component
// stock ÷ qty). Stored in the `bundle_items` column as [{id, qty}]; saved with
// the main Save. Separate from the "buy together" upsell (bu*) below.
let BP_ID = null, BP = [], BP_PICKING = false, BP_OPEN = false, BP_MODE = null;   // BP = [{id, qty}]; BP_MODE = 'assembled' | 'prepacked' | null
function bpLoad(id) {
  const box = document.getElementById('pd-bundle-product'); if (!box) return;
  BP_ID = id; BP_PICKING = false; BP = []; BP_MODE = null;
  if (!id) {
    box.innerHTML = `<div class="pd-var-head">${cuT('Bundle — sold as one', '套装产品(作为一个产品出售)')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then set this up as a bundle.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可将其设置为套装。')}</div>`;
    return;
  }
  const p = (PA_PRODUCTS || []).find(x => x.id === id);
  const items = (p && Array.isArray(p.bundle_items)) ? p.bundle_items : [];
  BP = items.map(c => ({ id: Number(c.id), qty: Math.max(1, parseInt(c.qty, 10) || 1) }))
            .filter(c => Number.isFinite(c.id) && c.id > 0);
  // Back-compat: a saved recipe with no explicit mode is an assembled bundle.
  BP_MODE = (p && (p.bundle_mode === 'assembled' || p.bundle_mode === 'prepacked')) ? p.bundle_mode
          : (BP.length ? 'assembled' : null);
  BP_OPEN = !!BP_MODE || BP.length > 0;
  bpRender();
}
function bpToggle() { BP_OPEN = !BP_OPEN; bpRender(); }
// Pick how the bundle is stocked. Switching to pre-packed keeps any chosen
// components in memory (so a mis-click doesn't lose them) but they won't save.
function bpSetMode(mode) {
  BP_MODE = (mode === 'assembled' || mode === 'prepacked') ? mode : null;
  if (BP_MODE !== 'assembled') BP_PICKING = false;
  bpRender();
  pdScheduleAutosave();
}
// Radios can't be unchecked by clicking them again — clicking an already-selected
// mode clears it back to "no mode chosen" instead of leaving it stuck.
function bpRadioClick(input, mode) {
  bpSetMode(input.dataset.wasOn === '1' ? null : mode);
}
function bpRender() {
  const box = document.getElementById('pd-bundle-product'); if (!box || BP_ID == null) return;
  const summary = BP_MODE === 'assembled'
    ? cuT(BP.length + ' products inside', '内含 ' + BP.length + ' 件商品')
    : BP_MODE === 'prepacked'
      ? cuT('Pre-packed set', '预包装套装')
      : cuT('Not a bundle · tap to set up', '非套装 · 点击设置');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="bpToggle()" aria-expanded="${BP_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${BP_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Bundle — sold as one', '套装产品')}</span>` +
    `<span class="pd-var-summary">${summary}</span></button>`;
  if (!BP_OPEN) { box.innerHTML = toggle; return; }

  // Mode chooser — the whole point of the section. "Sold as one set" the same
  // way, but stock works one of two ways.
  const opt = (mode, on, title, desc) =>
    `<label class="bp-mode${on ? ' is-on' : ''}">` +
      `<input type="radio" name="bp-mode" ${on ? 'checked' : ''} data-was-on="${on ? '1' : '0'}" onclick="bpRadioClick(this,'${mode}')">` +
      `<span class="bp-mode-txt"><span class="bp-mode-title">${title}</span>` +
      `<span class="bp-mode-desc">${desc}</span></span></label>`;
  const modes =
    `<div class="bp-modes">` +
      opt('assembled', BP_MODE === 'assembled',
          cuT('Assembled from other products', '由其他产品组成'),
          cuT('Stock follows the parts — no count to keep. Sells while every item is in stock; each sale deducts the parts.', '库存取决于组成商品 — 无需单独盘点。所有商品有货时可售,每次售出扣减各组成商品。')) +
      opt('prepacked', BP_MODE === 'prepacked',
          cuT('Pre-packed on a shelf', '预先包装成套'),
          cuT('You stock finished sets and count them yourself — set its stock like any product above.', '你自行备货并盘点成套商品 — 像普通产品一样在上方设置库存。')) +
    `</div>`;

  // Component picker — only for the assembled mode.
  let modeBody = '';
  if (BP_MODE === 'assembled') {
    const nameOf = id => { const p = (PA_PRODUCTS || []).find(x => x.id === id); return p ? _vaName(p) : ('#' + id); };
    const chips = BP.length
      ? BP.map(c =>
          `<span class="bp-chip">` +
            `<span class="bp-chip-name" title="${escapeAttr(nameOf(c.id))}">${escapeHtml(nameOf(c.id))}</span>` +
            `<span class="bp-chip-qty" title="${cuT('Quantity in the bundle', '套装内数量')}">×<input type="number" min="1" step="1" value="${c.qty}" onchange="bpQty(${c.id}, this.value)" oninput="bpQty(${c.id}, this.value)"></span>` +
            `<button type="button" class="bp-chip-x" title="${cuT('Remove', '移除')}" onclick="bpRemove(${c.id})">✕</button>` +
          `</span>`).join('')
      : `<span class="helper" style="font-size:11px">${cuT('Add the products this bundle contains.', '添加本套装包含的商品。')}</span>`;
    const picker = BP_PICKING ? `
      <input id="bp-search" class="bu-search" type="text" autocomplete="off" placeholder="${cuT('Search a product to add…', '搜索商品以添加…')}" oninput="bpPickerList()">
      <div id="bp-picklist" class="bu-picklist"></div>` : '';
    modeBody =
      `<div class="bu-chips">${chips}</div>` +
      `<div class="va-actions">` +
        `<button type="button" class="btn btn-sm" onclick="bpTogglePicker()">${BP_PICKING ? cuT('Close', '关闭') : cuT('+ Add product', '+ 添加商品')}</button>` +
      `</div>` + picker;
  }
  box.innerHTML = toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px">${cuT('Customers see ONE product at the price you set above. Choose how you stock it.', '顾客看到的是上方价格的单个产品。请选择其库存管理方式。')}</div>` +
    modes + modeBody;
  if (BP_PICKING) { const s = document.getElementById('bp-search'); if (s) s.focus(); bpPickerList(); }
  pdRenderSummaries();
}
function bpQty(id, val) {
  const c = BP.find(x => x.id === id); if (!c) return;
  c.qty = Math.max(1, parseInt(val, 10) || 1);
}
function bpRemove(id) { BP = BP.filter(x => x.id !== id); bpRender(); pdScheduleAutosave(); }
function bpTogglePicker() { BP_PICKING = !BP_PICKING; bpRender(); }
function bpPickerList() {
  const el = document.getElementById('bp-picklist'); if (!el) return;
  const q = (document.getElementById('bp-search')?.value || '').toLowerCase().trim();
  const have = new Set(BP.map(c => c.id));
  // Exclude self (a bundle can't contain itself) and other bundle products
  // (no nested bundles in v1) and items already added.
  const matches = (PA_PRODUCTS || []).filter(p => p.id !== BP_ID && !have.has(p.id) && !p.is_bundle)
    .filter(p => !q || (p.name_en || '').toLowerCase().includes(q) || (p.name_cn || '').includes(q) || (p.sku || '').toLowerCase().includes(q))
    .slice(0, 40);
  el.innerHTML = matches.length
    ? matches.map(p => `<div class="bu-pick" onclick="bpPick(${p.id})">${_vaPickName(p)}</div>`).join('')
    : `<div class="bu-pick muted">${cuT('No matches', '无匹配')}</div>`;
}
function bpPick(id) {
  if (!BP.some(c => c.id === id)) BP.push({ id, qty: 1 });
  const s = document.getElementById('bp-search'); if (s) s.value = '';
  bpRender();
  pdScheduleAutosave();
}
// Recipe to save — only an ASSEMBLED bundle carries components. Pre-packed and
// non-bundle products save null (clears any stale recipe → own stock is used).
function bpBody() {
  if (BP_MODE !== 'assembled' || !BP.length) return null;
  return BP.map(c => ({ id: c.id, qty: Math.max(1, parseInt(c.qty, 10) || 1) }));
}
// The bundle mode to save ('assembled' | 'prepacked' | null = not a bundle).
function bpModeBody() {
  return (BP_MODE === 'assembled' || BP_MODE === 'prepacked') ? BP_MODE : null;
}
// ── Customer-choice options (dressing, spice level, cutlery…) ─────────────────
// A choice records the customer's pick at checkout and NEVER touches stock — so
// an always-available dressing on a limited salad stays on the salad's stock.
// The mini-app PDP/cart/checkout already read these; here the operator authors
// them. Stored in retail_product_options + _choices, saved via body.options on
// the main Save (replace-all). OPT mirrors the server shape (minus ids).
let OPT_ID = null, OPT = [], OPT_OPEN = false, OPT_PICK = null;   // OPT_PICK = {oi,ci} choosing a stock product
// Drag-to-reorder. OPT_DRAG = { kind:'choice'|'block', oi, ci } for the row being
// dragged. Choices reorder within their own option only; whole option blocks
// reorder against each other. Monochrome grip glyph (no emoji, per UI rule).
let OPT_DRAG = null;
const OPT_GRIP = '<svg class="opt-grip-svg" width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
  '<circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/>' +
  '<circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/>' +
  '<circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>';
function optDragStart(ev, kind, oi, ci) {
  OPT_DRAG = { kind, oi, ci };
  try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', kind); } catch {}
  const row = ev.target.closest(kind === 'block' ? '.opt-block' : '.opt-choice');
  if (row) {
    row.classList.add('opt-dragging');
    if (ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(row, 14, 14);
  }
}
function optDragEnd() {
  document.querySelectorAll('.opt-dragging, .opt-dragover')
    .forEach(n => n.classList.remove('opt-dragging', 'opt-dragover'));
  OPT_DRAG = null;
}
function optDragOver(ev, kind, oi) {
  if (!OPT_DRAG || OPT_DRAG.kind !== kind) return;
  if (kind === 'choice' && OPT_DRAG.oi !== oi) return;   // choices stay inside their option
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const row = ev.target.closest(kind === 'block' ? '.opt-block' : '.opt-choice');
  if (row) row.classList.add('opt-dragover');
}
function optDragLeave(ev) {
  const row = ev.currentTarget;
  if (row && !row.contains(ev.relatedTarget)) row.classList.remove('opt-dragover');
}
function optDrop(ev, kind, oi, ci) {
  if (!OPT_DRAG || OPT_DRAG.kind !== kind) { optDragEnd(); return; }
  ev.preventDefault();
  if (kind === 'block') {
    const from = OPT_DRAG.oi, to = oi;
    optDragEnd();
    if (from === to || from == null) return;
    const [m] = OPT.splice(from, 1);
    OPT.splice(to, 0, m);
    OPT_PICK = null; optRender(); pdScheduleAutosave();
  } else {
    if (OPT_DRAG.oi !== oi) { optDragEnd(); return; }
    const from = OPT_DRAG.ci, to = ci;
    optDragEnd();
    if (from === to) return;
    const arr = OPT[oi].choices;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    OPT_PICK = null; optRender(); pdScheduleAutosave();
  }
}
function optLoad(id) {
  const box = document.getElementById('pd-options'); if (!box) return;
  OPT_ID = id; OPT = []; OPT_OPEN = false; OPT_PICK = null;
  if (!id) {
    box.innerHTML = `<div class="pd-var-head">${cuT('Options (customer chooses)', '选项(顾客选择)')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then add a choice like a dressing here.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可在此添加如酱料等选项。')}</div>`;
    return;
  }
  optRender();   // show the collapsed bar immediately
  // Options aren't in the list cache, so pull them from the full product.
  fetch('/api/retail-admin/products/' + id, { credentials: 'same-origin' })
    .then(r => r.json())
    .then(j => {
      if (OPT_ID !== id) return;   // operator switched products mid-fetch
      const opts = (j && j.success && j.data && Array.isArray(j.data.options)) ? j.data.options : [];
      OPT = opts.map(o => ({
        question_en: o.question_en || '', question_cn: o.question_cn || '',
        type: o.type || 'single', is_required: o.is_required ? 1 : 0,
        choices: (o.choices || []).map(c => ({
          label_en: c.label_en || '', label_cn: c.label_cn || '',
          price_delta: Number(c.price_delta) || 0, is_default: c.is_default ? 1 : 0,
          // Stock-backed add-on link (paid extra drawn from a real product).
          stock_product_id: c.stock_product_id || null,
          addon_name_en: c.addon_name_en || '', addon_name_cn: c.addon_name_cn || '',
          addon_stock: c.addon_stock != null ? c.addon_stock : null,
        })),
      }));
      OPT_OPEN = OPT.length > 0;
      optRender();
    })
    .catch(() => {});
}
function optToggle() { OPT_OPEN = !OPT_OPEN; optRender(); }
function optRender() {
  const box = document.getElementById('pd-options'); if (!box || OPT_ID == null) return;
  const nChoices = OPT.reduce((n, o) => n + (o.type === 'text' ? 0 : o.choices.length), 0);
  const summary = OPT.length
    ? cuT(OPT.length + (OPT.length === 1 ? ' option' : ' options') + (nChoices ? ' · ' + nChoices + ' choices' : ''),
          OPT.length + ' 个选项' + (nChoices ? ' · ' + nChoices + ' 项' : ''))
    : cuT('None · tap to add a choice', '无 · 点击添加选项');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="optToggle()" aria-expanded="${OPT_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${OPT_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Options (customer chooses)', '选项(顾客选择)')}</span>` +
    `<span class="pd-var-summary">${summary}</span></button>`;
  if (!OPT_OPEN) { box.innerHTML = toggle; return; }
  // 'text' is NOT offered — neither storefront can render a free-text answer
  // (the mini-app sheet and the web sheet both loop over choices only), so a
  // text option collects nothing, and a REQUIRED one can never be satisfied,
  // which blocks add-to-cart entirely. It stays in the list, disabled, only
  // when the row is already type=text, so an existing option keeps its true
  // label instead of silently reading as "Pick one" — and can be moved off
  // text, but never back onto it.
  const typeSel = (oi, t) => {
    const opt = (v, lbl, dis) => `<option value="${v}"${t === v ? ' selected' : ''}${dis ? ' disabled' : ''}>${lbl}</option>`;
    return `<select class="opt-type" onchange="optType(${oi}, this.value)" title="${cuT('How the customer answers', '顾客如何选择')}">` +
      opt('single', cuT('Pick one', '单选')) + opt('multi', cuT('Pick any', '多选')) +
      (t === 'text' ? opt('text', cuT('Type an answer (unsupported)', '填写(暂不支持)'), true) : '') + `</select>`;
  };
  const blocks = OPT.map((o, oi) => {
    const choices = o.type === 'text' ? '' : (o.choices.length
      ? o.choices.map((c, ci) => _optChoiceRow(o, oi, c, ci)).join('')
      : `<span class="helper" style="font-size:11px">${cuT('Add at least one choice.', '请至少添加一个选项。')}</span>`);
    return `<div class="opt-block" data-oi="${oi}" ondragover="optDragOver(event,'block',${oi})" ondrop="optDrop(event,'block',${oi})" ondragleave="optDragLeave(event)">` +
      `<div class="opt-qrow">` +
        `<span class="opt-drag opt-drag-block" draggable="true" title="${cuT('Drag to reorder', '拖动排序')}" ondragstart="optDragStart(event,'block',${oi})" ondragend="optDragEnd()">${OPT_GRIP}</span>` +
        `<input type="text" class="opt-q" value="${escapeAttr(o.question_en)}" placeholder="${cuT('Question EN (e.g. Choose your dressing)', '问题(英文,如:选择酱料)')}" oninput="optQ(${oi}, 'question_en', this.value)">` +
        `<input type="text" class="opt-q" value="${escapeAttr(o.question_cn)}" placeholder="${cuT('Question 中文', '问题(中文)')}" oninput="optQ(${oi}, 'question_cn', this.value)">` +
        typeSel(oi, o.type) +
        `<label class="opt-req" title="${cuT('Customer must choose before adding to cart', '加入购物车前必须选择')}"><input type="checkbox"${o.is_required ? ' checked' : ''} onchange="optReq(${oi}, this.checked)"> ${cuT('Required', '必选')}</label>` +
        `<button type="button" class="bp-chip-x" title="${cuT('Remove this option', '移除此选项')}" onclick="optRemoveOption(${oi})">✕</button>` +
      `</div>` +
      (o.type === 'multi' ? `<div class="helper" style="font-size:11px;margin:2px 0 0">${cuT('Pick-any extras. Link each to a product so it draws from that product’s stock and sells out when it runs low.', '多选加项。将每项关联到商品,即可占用该商品库存,售罄时自动隐藏。')}</div>` : '') +
      (o.type === 'text' ? '' : `<div class="opt-choices">${choices}` +
        `<button type="button" class="btn btn-sm opt-addc" onclick="optAddChoice(${oi})">${cuT('+ Add choice', '+ 添加选项')}</button></div>`) +
    `</div>`;
  }).join('');
  box.innerHTML = toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px">${cuT('Let customers choose. A free pick (dressing) never affects stock. A paid extra (pickles, sauce) can be linked to a product so it draws from that product’s stock and sells out when low.', '让顾客自由选择。免费选项(酱料)不影响库存;付费加项(腌菜、酱汁)可关联商品,从而占用其库存并在不足时售罄。')}</div>` +
    `<div class="opt-list">${blocks}</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="optAddOption()">${cuT('+ Add a pick (free)', '+ 添加选择(免费)')}</button>` +
      `<button type="button" class="btn btn-sm" onclick="optAddExtras()">${cuT('+ Add paid extras', '+ 添加付费加项')}</button>` +
    `</div>`;
  if (OPT_PICK) { const s = document.getElementById('opt-search'); if (s) s.focus(); optPickerList(); }
  pdRenderSummaries();
}
// One choice row + (when it's the active link target) the product picker below.
function _optChoiceRow(o, oi, c, ci) {
  const def = o.type === 'single'
    ? `<input type="radio" name="opt-def-${oi}" title="${cuT('Default pick', '默认选项')}"${c.is_default ? ' checked' : ''} onchange="optDefault(${oi}, ${ci})">`
    : `<input type="checkbox" title="${cuT('Pre-selected', '默认勾选')}"${c.is_default ? ' checked' : ''} onchange="optDefaultMulti(${oi}, ${ci}, this.checked)">`;
  // A "Pick one" is a free pick (dressings/spice) — no charge, no stock draw — so
  // the money/stock section is hidden. Paid extras live on "Pick any" (multi).
  const paid = o.type !== 'single';
  // Link control: a chip when linked (name + live stock), else a "+ Stock" button.
  let link = '';
  if (paid && c.stock_product_id) {
    // Prefer the live catalogue row so a variant shows its size + weight; fall
    // back to the snapshotted name only when the product is gone from the list.
    const lp = (PA_PRODUCTS || []).find(x => String(x.id) === String(c.stock_product_id));
    const nm = escapeHtml(lp ? _optStockName(lp) : (c.addon_name_en || c.addon_name_cn || ('#' + c.stock_product_id)));
    const stk = c.addon_stock != null ? ` · ${c.addon_stock} ${cuT('in stock', '库存')}` : '';
    // data-no-i18n: _optStockName packs "name_en · name_cn · variant · weight"
    // using " · " — the same separator the bilingual text walker (10-extras.js)
    // treats as an EN·CN divider. Without this opt-out it strips the chip down to
    // just the English name, hiding the variant/weight that disambiguates siblings.
    link = `<span class="opt-link on" data-no-i18n title="${cuT('Draws from this product’s stock', '占用该商品库存')}">🔗 ${nm}${stk}` +
      `<button type="button" class="opt-unlink" title="${cuT('Unlink', '取消关联')}" onclick="optUnlink(${oi}, ${ci})">✕</button></span>`;
  } else if (paid) {
    link = `<button type="button" class="btn btn-sm opt-link-btn" title="${cuT('Link a product so this extra uses its stock', '关联商品,使此加项占用其库存')}" onclick="optLinkPick(${oi}, ${ci})">${cuT('+ Stock product', '+ 关联库存商品')}</button>`;
  }
  const picking = OPT_PICK && OPT_PICK.oi === oi && OPT_PICK.ci === ci;
  const picker = picking ? `<div class="opt-picker">` +
    `<input id="opt-search" class="bu-search" type="text" autocomplete="off" placeholder="${cuT('Search a product to use for stock…', '搜索作为库存来源的商品…')}" oninput="optPickerList()">` +
    `<div id="opt-picklist" class="bu-picklist" data-no-i18n></div></div>` : '';
  return `<div class="opt-choice" data-oi="${oi}" data-ci="${ci}" ondragover="optDragOver(event,'choice',${oi})" ondrop="optDrop(event,'choice',${oi},${ci})" ondragleave="optDragLeave(event)">` +
    `<span class="opt-drag" draggable="true" title="${cuT('Drag to reorder', '拖动排序')}" ondragstart="optDragStart(event,'choice',${oi},${ci})" ondragend="optDragEnd()">${OPT_GRIP}</span>` +
    def +
    `<input type="text" class="opt-clab" value="${escapeAttr(c.label_en)}" placeholder="${cuT('Choice EN', '选项(英文)')}" oninput="optC(${oi}, ${ci}, 'label_en', this.value)">` +
    `<input type="text" class="opt-clab" value="${escapeAttr(c.label_cn)}" placeholder="${cuT('Choice 中文', '选项(中文)')}" oninput="optC(${oi}, ${ci}, 'label_cn', this.value)">` +
    (paid ? `<span class="opt-cdelta" title="${cuT('Extra charge for this choice (0 = free)', '此选项加价(0 = 免费)')}">+¥<input type="number" step="0.01" value="${c.price_delta || 0}" oninput="optC(${oi}, ${ci}, 'price_delta', this.value)"></span>` : '') +
    link +
    `<button type="button" class="bp-chip-x" title="${cuT('Remove', '移除')}" onclick="optRemoveChoice(${oi}, ${ci})">✕</button>` +
  `</div>` + picker;
}
// Text/number inputs update the model only — re-rendering mid-type would drop
// the caret. Structural changes (add/remove/type/default) re-render.
function optQ(oi, key, val) { if (OPT[oi]) OPT[oi][key] = val; }
function optC(oi, ci, key, val) {
  const c = OPT[oi] && OPT[oi].choices[ci]; if (!c) return;
  c[key] = key === 'price_delta' ? (parseFloat(val) || 0) : val;
}
function optType(oi, val) {
  const o = OPT[oi]; if (!o) return;
  o.type = val;
  // Switching to a free pick ("Pick one") drops any charge/stock link the choices
  // carried as paid extras — the money/stock section no longer applies.
  if (val === 'single') {
    o.choices.forEach(c => {
      c.price_delta = 0; c.stock_product_id = null;
      c.addon_name_en = ''; c.addon_name_cn = ''; c.addon_stock = null;
    });
  }
  optRender();
}
function optReq(oi, on) { if (OPT[oi]) OPT[oi].is_required = on ? 1 : 0; }
function optDefault(oi, ci) {   // single-select: exactly one default
  const o = OPT[oi]; if (!o) return;
  o.choices.forEach((c, i) => { c.is_default = i === ci ? 1 : 0; });
  optRender();
}
function optDefaultMulti(oi, ci, on) { const c = OPT[oi] && OPT[oi].choices[ci]; if (c) c.is_default = on ? 1 : 0; }
function optAddOption() {
  OPT.push({ question_en: '', question_cn: '', type: 'single', is_required: 1, choices: [_optBlankChoice(), _optBlankChoice()] });
  OPT_OPEN = true; optRender();
}
// "Add paid extras" → a pick-any group seeded with one product-linked slot.
function optAddExtras() {
  OPT.push({ question_en: 'Add extras?', question_cn: '加点配料?', type: 'multi', is_required: 0, choices: [_optBlankChoice()] });
  OPT_OPEN = true; optRender();
}
function _optBlankChoice() {
  return { label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null, addon_name_en: '', addon_name_cn: '', addon_stock: null };
}
function optRemoveOption(oi) { OPT.splice(oi, 1); if (OPT_PICK && OPT_PICK.oi === oi) OPT_PICK = null; optRender(); }
function optAddChoice(oi) { if (OPT[oi]) { OPT[oi].choices.push(_optBlankChoice()); optRender(); } }
function optRemoveChoice(oi, ci) { if (OPT[oi]) { OPT[oi].choices.splice(ci, 1); OPT_PICK = null; optRender(); } }
// ── Stock-product link (paid add-on draws from a real product's inventory) ──
// Display name for a stock-source product (picker rows + linked chip). Two
// products can share a family name — whether as variant siblings (one
// variant_group_id) or as separate same-named rows — so always spell out the
// size label and weight (e.g. "Harissa Chilli Paste · 1 Jar · 250g"); otherwise
// they read alike in the picker and the operator can't tell them apart.
function _optStockName(p) {
  if (!p) return '';
  const base = (p.name_en || '—') + (p.name_cn ? ' · ' + p.name_cn : '');
  const lab = p.variant_group_id
    ? (cuT(p.variant_label, p.variant_label_cn) || p.variant_label || p.variant_label_cn || '').toString().trim()
    : '';
  const extra = [lab, (p.size || '').toString().trim()].filter(Boolean).join(' · ');
  return extra ? base + ' · ' + extra : base;
}
function optLinkPick(oi, ci) { OPT_PICK = { oi, ci }; optRender(); }
function optPickerList() {
  const el = document.getElementById('opt-picklist'); if (!el) return;
  const q = (document.getElementById('opt-search')?.value || '').toLowerCase().trim();
  // Any product can be a stock source EXCEPT this product itself (no self-link).
  const matches = (PA_PRODUCTS || []).filter(p => p.id !== OPT_ID)
    .filter(p => !q || (p.name_en || '').toLowerCase().includes(q) || (p.name_cn || '').includes(q) || (p.sku || '').toLowerCase().includes(q))
    .slice(0, 40);
  el.innerHTML = matches.length
    // Append the SKU when present, else a faint #id — so two products that
    // share a name with no weight/SKU set are still never indistinguishable.
    ? matches.map(p => {
        const tail = p.sku ? ' · ' + escapeHtml(p.sku)
          : (((p.size || '').toString().trim()) ? '' : ` · <span class="muted">#${p.id}</span>`);
        return `<div class="bu-pick" onclick="optPick(${p.id})">${escapeHtml(_optStockName(p))}${tail}</div>`;
      }).join('')
    : `<div class="bu-pick muted">${cuT('No matches', '无匹配')}</div>`;
}
function optPick(productId) {
  if (!OPT_PICK) return;
  const c = OPT[OPT_PICK.oi] && OPT[OPT_PICK.oi].choices[OPT_PICK.ci]; if (!c) { OPT_PICK = null; optRender(); return; }
  const p = (PA_PRODUCTS || []).find(x => x.id === productId);
  c.stock_product_id = productId;
  c.addon_name_en = (p && p.name_en) || ''; c.addon_name_cn = (p && p.name_cn) || '';
  c.addon_stock = (p && p.stock != null) ? p.stock : null;
  // Seed the choice label from the product name when still blank, so the
  // operator usually doesn't have to type it twice.
  if (!c.label_en && p) c.label_en = p.name_en || '';
  if (!c.label_cn && p) c.label_cn = p.name_cn || '';
  // Default the add-on charge to the product's own price (operator can override).
  if (!(Number(c.price_delta) > 0) && p && Number(p.sell_price) > 0) c.price_delta = Number(p.sell_price);
  OPT_PICK = null; optRender();
}
function optUnlink(oi, ci) {
  const c = OPT[oi] && OPT[oi].choices[ci]; if (!c) return;
  c.stock_product_id = null; c.addon_name_en = ''; c.addon_name_cn = ''; c.addon_stock = null;
  optRender();
}
// Save payload — always an array ([] clears). Mirrors the server sanitiser so
// the round-trip is stable: drop empty choices, then options with no usable body.
function optBody() {
  return OPT.map(o => {
    const type = ['single', 'multi', 'text'].includes(o.type) ? o.type : 'single';
    const choices = type === 'text' ? [] : (o.choices || [])
      .map(c => ({ label_en: (c.label_en || '').trim(), label_cn: (c.label_cn || '').trim(), price_delta: Number(c.price_delta) || 0, is_default: c.is_default ? 1 : 0, stock_product_id: c.stock_product_id || null }))
      .filter(c => c.label_en || c.label_cn);
    return { question_en: (o.question_en || '').trim(), question_cn: (o.question_cn || '').trim(), type, is_required: o.is_required ? 1 : 0, choices };
  }).filter(o => (o.question_en || o.question_cn) && (o.type === 'text' || o.choices.length));
}
// ── Image optimisation (resize) ─────────────────────────────────────────────
// Gallery photos are base64-stored in store_products.image_data, so a raw
// 4–10MB phone JPEG would bloat the DB and slow the storefront. Mirror the
// kitchen app's pipeline: decode (EXIF-corrected), downscale to 1440px on the
// long edge, re-encode JPEG q0.88. Files already small pass through untouched.
// Returns { dataURL, originalBytes, finalBytes, resized }.
async function pdResizeImage(file, opts = {}) {
  const maxLong          = opts.maxLong          || 1800;
  const quality          = opts.quality          || 0.90;
  const passThroughBelow = opts.passThroughBelow || (600 * 1024);
  const forceJpeg        = opts.format === 'jpeg';   // always emit JPEG, flattening any transparency
  const originalBytes    = file.size;
  const readAsDataURL = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  // Fast path — already small enough (and not a non-JPEG we must convert).
  if (originalBytes <= passThroughBelow && !(forceJpeg && file.type !== 'image/jpeg')) {
    return { dataURL: await readAsDataURL(file), originalBytes, finalBytes: originalBytes, resized: false };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    // Fallback: <img> doesn't apply EXIF, but the photo will at least load.
    const url = URL.createObjectURL(file);
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;
  const maxWidth       = opts.maxWidth || 0;          // cap WIDTH only (long description images)
  const targetMaxBytes = opts.targetMaxBytes || 0;    // shrink until under this (upload-size guard)
  const outType = forceJpeg ? 'image/jpeg' : ((file.type === 'image/png') ? 'image/png' : 'image/jpeg');
  // maxWidth mode caps the width and lets the height run as tall as it needs —
  // a long "详情页" graphic (e.g. 750×8000) would otherwise have its longest edge
  // capped, crushing the width to a sliver. Default mode caps the longest edge
  // (square-ish product photos).
  const fit = (wCap) => {
    const scale = maxWidth
      ? (srcW > wCap ? wCap / srcW : 1)
      : (Math.max(srcW, srcH) > maxLong ? maxLong / Math.max(srcW, srcH) : 1);
    return { w: Math.max(1, Math.round(srcW * scale)), h: Math.max(1, Math.round(srcH * scale)) };
  };
  const encode = (w, h, q) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (outType === 'image/jpeg') {
      // JPEG has no alpha — paint white so transparent PNG areas flatten to white.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise(res => canvas.toBlob(res, outType, outType === 'image/jpeg' ? q : undefined));
  };
  let wCap = maxWidth || maxLong;
  let { w, h } = fit(wCap);
  let q = quality;
  let blob = await encode(w, h, q);
  if (!blob) throw new Error('toBlob failed');
  // Size-target ladder — keeps the upload under the proxy body limit no matter
  // how tall the image is: drop quality first, then (in width mode) the width.
  if (targetMaxBytes && outType === 'image/jpeg') {
    let guard = 0;
    while (blob.size > targetMaxBytes && guard++ < 8) {
      if (q > 0.5) q = Math.max(0.5, q - 0.12);
      else if (maxWidth && wCap > 720) { wCap = Math.round(wCap * 0.85); ({ w, h } = fit(wCap)); }
      else break;
      blob = await encode(w, h, q);
      if (!blob) throw new Error('toBlob failed');
    }
  }
  if (bitmap.close) try { bitmap.close(); } catch {}
  return { dataURL: await readAsDataURL(blob), originalBytes, finalBytes: blob.size, resized: true };
}
function pdFmtBytes(b) {
  if (b == null) return '?';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}
// Wrapper: hard upper bound + a toast when shrinkage happens. Returns the final
// dataURL, or null on failure / over-cap.
async function pdHandleImageUpload(file, opts = {}) {
  const hardCapMB = opts.hardCapMB || 25;
  if (file.size > hardCapMB * 1024 * 1024) {
    toast(`Image too huge (max ${hardCapMB}MB) · 图片过大,上限 ${hardCapMB}MB`, 'err');
    return null;
  }
  try {
    const r = await pdResizeImage(file, opts);
    if (r.resized) toast(`📐 ${cuT('Optimized', '已优化')} ${pdFmtBytes(r.originalBytes)} → ${pdFmtBytes(r.finalBytes)}`, 'ok');
    return r.dataURL;
  } catch (e) {
    console.warn('[pd image upload] failed', e);
    toast(cuT('Failed to process image', '图片处理失败') + ': ' + (e.message || e), 'err');
    return null;
  }
}
// Product-photo preset: 1440px long edge stays crisp at full phone width on 3×
// screens; JPEG q0.88 is artefact-free; forcing JPEG stops heavy PNGs shipping
// as-is. A typical 2–5MB upload lands around 300–600KB.
const PD_IMG_OPTS = { maxLong: 1440, quality: 0.88, format: 'jpeg', passThroughBelow: 200 * 1024 };
// Description (RTE) preset: long "详情页" graphics are very tall, so cap the WIDTH
// (1080px is retina-sharp at full phone width) instead of the longest edge, and
// target ≤900KB so the upload clears the proxy body limit however tall it is.
const PD_DESC_IMG_OPTS = { maxWidth: 1080, quality: 0.85, format: 'jpeg', passThroughBelow: 150 * 1024, targetMaxBytes: 900 * 1024 };

// ── Product photo gallery (editor) ──────────────────────────────────────────
const PD_MAX_PHOTOS = 8;
function pdRenderGallery() {
  const wrap = document.getElementById('pd-gallery');
  if (!wrap) return;
  if (!_pdGallery.length) {
    wrap.innerHTML = '<div class="muted" style="font-size:12px;">No photos yet · 暂无图片</div>';
    return;
  }
  const hint = _pdGalleryInherited
    ? `<div class="muted" style="font-size:11px;margin-bottom:6px;flex-basis:100%">${cuT('Shared from another variant — add a photo here to give this variant its own.', '与其他规格共用图片 — 在此添加图片可为本规格单独设置。')}</div>`
    : '';
  wrap.innerHTML = hint + _pdGallery.map((src, i) => `
    <div class="pd-thumb" draggable="true" data-i="${i}">
      <div class="pd-thumb-img" style="background-image:url('${String(src).replace(/'/g, '%27')}')"></div>
      ${i === 0 ? '<span class="pd-thumb-main">Main · 主图</span>' : ''}
      <button type="button" class="pd-thumb-x" title="Remove · 移除" data-rm="${i}">×</button>
    </div>`).join('');
}
async function pdAddPhotos(e) {
  const files = Array.from((e.target && e.target.files) || []);
  const room = PD_MAX_PHOTOS - _pdGallery.length;
  if (room <= 0) { toast(cuT('Up to 8 photos', '最多 8 张图片'), 'err'); e.target.value = ''; return; }
  const take = files.slice(0, Math.max(0, room));
  e.target.value = '';
  if (!take.length) return;
  // Resize/optimise each photo before it hits image_data (base64-stored). Phone
  // cameras emit 4–10MB JPEGs; raw they'd bloat the DB and slow the storefront.
  let added = false;
  for (const f of take) {
    const dataURL = await pdHandleImageUpload(f, PD_IMG_OPTS);
    if (dataURL) { _pdGallery.push(dataURL); _pdGalleryDirty = true; _pdGalleryInherited = false; added = true; }
  }
  if (added) { pdRenderGallery(); pdScheduleAutosave(); }
}

// ── "From library" picker ────────────────────────────────────────────────────
// Reuse a photo already in the Media library (Content → Media) instead of
// re-uploading from the computer. Picked images are fetched and run through the
// SAME resize path as a local upload, so they land in image_data identically
// (base64, self-contained) — no fragile relative URLs that break in the mini-app.
let _pdLib = { sel: new Set(), rows: [], total: 0, offset: 0, q: '', loading: false };
const PD_LIB_PAGE = 60;
async function pdOpenLibraryPicker() {
  if (PD_MAX_PHOTOS - _pdGallery.length <= 0) {
    toast(cuT('Up to 8 photos', '最多 8 张图片'), 'err'); return;
  }
  _pdLib = { sel: new Set(), rows: [], total: 0, offset: 0, q: '', loading: false };
  let box = document.getElementById('pd-lib-bg');
  if (box) box.remove();
  box = document.createElement('div');
  box.id = 'pd-lib-bg';
  box.className = 'pu-editor-bg';
  box.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9000;';
  box.innerHTML = `
    <div class="pu-editor" style="width:760px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column;">
      <div class="pu-editor-head" style="display:flex;align-items:center;gap:10px;">
        <div style="font-weight:600;">${cuT('Choose from library', '从图库选择')}</div>
        <input id="pd-lib-q" type="search" placeholder="${cuT('Search photos…', '搜索图片…')}"
               style="margin-left:8px;flex:1;max-width:260px;font-size:13px;padding:5px 8px;border:1.5px solid var(--border);border-radius:8px;">
        <button type="button" class="btn btn-sm" id="pd-lib-x" style="margin-left:auto;">${cuT('Close', '关闭')} ×</button>
      </div>
      <div class="pu-editor-body" style="display:block;padding:14px;overflow:auto;flex:1;">
        <div id="pd-lib-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;"></div>
        <div id="pd-lib-empty" class="muted" style="display:none;text-align:center;padding:30px 0;font-size:13px;"></div>
        <div style="text-align:center;margin-top:14px;">
          <button type="button" class="btn btn-sm" id="pd-lib-more" style="display:none;">${cuT('Load more', '加载更多')}</button>
        </div>
      </div>
      <div class="pu-editor-foot" style="display:flex;align-items:center;gap:10px;padding:12px 14px;">
        <span class="muted" id="pd-lib-count" style="font-size:12px;"></span>
        <button type="button" class="btn btn-primary btn-sm" id="pd-lib-add" style="margin-left:auto;" disabled>${cuT('Add selected', '添加所选')}</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', e => { if (e.target === box) close(); });
  box.querySelector('#pd-lib-x').onclick = close;
  box.querySelector('#pd-lib-add').onclick = () => pdLibAddSelected(close);

  const qEl = box.querySelector('#pd-lib-q');
  let qTimer = null;
  qEl.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { _pdLib.q = qEl.value.trim(); _pdLib.offset = 0; _pdLib.rows = []; pdLibFetch(true); }, 220);
  });
  box.querySelector('#pd-lib-more').onclick = () => { _pdLib.offset += PD_LIB_PAGE; pdLibFetch(false); };

  await pdLibFetch(true);
}
async function pdLibFetch(reset) {
  if (_pdLib.loading) return;
  _pdLib.loading = true;
  try {
    const params = new URLSearchParams({ mime: 'image', limit: String(PD_LIB_PAGE), offset: String(_pdLib.offset) });
    if (_pdLib.q) params.set('q', _pdLib.q);
    const r = await api('/api/retail-admin/media/list?' + params.toString());
    const { rows, total } = (r && r.data) || {};
    _pdLib.rows = reset ? (rows || []) : _pdLib.rows.concat(rows || []);
    _pdLib.total = total || 0;
  } catch (e) {
    toast(cuT('Load failed', '加载失败') + ' · ' + (e.message || e), 'err');
  } finally {
    _pdLib.loading = false;
    pdLibRenderGrid();
  }
}
function pdLibRenderGrid() {
  const grid = document.getElementById('pd-lib-grid');
  const empty = document.getElementById('pd-lib-empty');
  if (!grid) return;
  if (!_pdLib.rows.length) {
    grid.innerHTML = '';
    empty.style.display = '';
    empty.textContent = _pdLib.q
      ? cuT('No photos match your search', '没有匹配的图片')
      : cuT('Your media library is empty — upload photos in Content → Media', '图库为空 — 请在「内容 → 媒体」中上传图片');
  } else {
    empty.style.display = 'none';
    grid.innerHTML = _pdLib.rows.map(m => {
      const on = _pdLib.sel.has(m.id);
      return `<div class="pd-lib-card" data-id="${m.id}" title="${escapeAttr(m.filename || '')}"
        style="position:relative;cursor:pointer;border:2px solid ${on ? 'var(--accent,#9a7b3f)' : 'transparent'};border-radius:10px;overflow:hidden;aspect-ratio:1;background:var(--panel-2,#f3efe6);">
        <img loading="lazy" src="/api/retail/media/${m.id}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">
        <span style="position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;display:${on ? 'flex' : 'none'};align-items:center;justify-content:center;background:var(--accent,#9a7b3f);color:#fff;font-size:12px;">✓</span>
      </div>`;
    }).join('');
    grid.querySelectorAll('.pd-lib-card').forEach(card => {
      card.onclick = () => pdLibToggle(parseInt(card.dataset.id, 10));
    });
  }
  const more = document.getElementById('pd-lib-more');
  if (more) more.style.display = (_pdLib.rows.length < _pdLib.total) ? '' : 'none';
  pdLibUpdateFoot();
}
function pdLibToggle(id) {
  if (_pdLib.sel.has(id)) { _pdLib.sel.delete(id); }
  else {
    // Don't let the operator pick more than the gallery has room for.
    const room = PD_MAX_PHOTOS - _pdGallery.length;
    if (_pdLib.sel.size >= room) { toast(cuT('Up to 8 photos', '最多 8 张图片'), 'err'); return; }
    _pdLib.sel.add(id);
  }
  pdLibRenderGrid();
}
function pdLibUpdateFoot() {
  const n = _pdLib.sel.size;
  const countEl = document.getElementById('pd-lib-count');
  const addBtn = document.getElementById('pd-lib-add');
  if (countEl) countEl.textContent = n ? cuT(`${n} selected`, `已选 ${n} 张`) : '';
  if (addBtn) addBtn.disabled = !n;
}
async function pdLibAddSelected(close) {
  const ids = Array.from(_pdLib.sel);
  if (!ids.length) return;
  const addBtn = document.getElementById('pd-lib-add');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = cuT('Adding…', '添加中…'); }
  let added = 0;
  for (const id of ids) {
    if (PD_MAX_PHOTOS - _pdGallery.length <= 0) break;
    try {
      const resp = await fetch('/api/retail/media/' + id, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      const file = new File([blob], 'library-' + id + '.jpg', { type: blob.type || 'image/jpeg' });
      // Same resize preset as a local upload → consistent, self-contained base64.
      const r = await pdResizeImage(file, PD_IMG_OPTS);
      if (r && r.dataURL) {
        _pdGallery.push(r.dataURL); _pdGalleryDirty = true; _pdGalleryInherited = false; added++;
      }
    } catch (e) {
      console.warn('[pd library pick] failed for', id, e);
    }
  }
  if (added) { pdRenderGallery(); pdScheduleAutosave(); toast(cuT(`Added ${added}`, `已添加 ${added} 张`), 'ok'); }
  if (typeof close === 'function') close();
}

function pdRemovePhoto(i) {
  if (i < 0 || i >= _pdGallery.length) return;
  _pdGallery.splice(i, 1); _pdGalleryDirty = true; _pdGalleryInherited = false; pdRenderGallery(); pdScheduleAutosave();
}
// Delegated drag-reorder + remove. Wired once on the container.
function pdGalleryWire() {
  const wrap = document.getElementById('pd-gallery');
  if (!wrap || wrap._wired) return;
  wrap._wired = true;
  wrap.addEventListener('click', e => {
    const x = e.target.closest('.pd-thumb-x');
    if (x) { pdRemovePhoto(parseInt(x.dataset.rm, 10)); return; }
    // Click the photo itself (not the ✕) → open it big in a lightbox.
    const t = e.target.closest('.pd-thumb'); if (!t) return;
    const i = parseInt(t.dataset.i, 10);
    if (Number.isFinite(i) && _pdGallery[i]) pdLightbox(i);
  });
  wrap.addEventListener('dragstart', e => {
    const t = e.target.closest('.pd-thumb'); if (!t) return;
    _pdDragFrom = parseInt(t.dataset.i, 10); t.classList.add('dragging');
  });
  wrap.addEventListener('dragend', e => {
    const t = e.target.closest('.pd-thumb'); if (t) t.classList.remove('dragging');
    wrap.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
  });
  wrap.addEventListener('dragover', e => {
    e.preventDefault();
    const t = e.target.closest('.pd-thumb');
    wrap.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
    if (t) t.classList.add('drop-target');
  });
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    const t = e.target.closest('.pd-thumb');
    if (!t || _pdDragFrom == null) return;
    const to = parseInt(t.dataset.i, 10);
    if (Number.isFinite(to) && to !== _pdDragFrom) {
      const [moved] = _pdGallery.splice(_pdDragFrom, 1);
      _pdGallery.splice(to, 0, moved);
      _pdGalleryDirty = true; _pdGalleryInherited = false; pdRenderGallery(); pdScheduleAutosave();
    }
    _pdDragFrom = null;
  });
}
// Lightbox — show a gallery photo big (full size, contained on screen). Click
// the backdrop, the ✕, or press Esc to close; ‹ › step through the gallery.
function pdLightbox(start) {
  let i = start;
  const old = document.getElementById('pd-lightbox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'pd-lightbox';
  box.innerHTML = `
    <button type="button" class="pd-lb-x" title="${cuT('Close', '关闭')}">×</button>
    <button type="button" class="pd-lb-nav pd-lb-prev" title="${cuT('Previous', '上一张')}">‹</button>
    <img class="pd-lb-img" alt="">
    <button type="button" class="pd-lb-nav pd-lb-next" title="${cuT('Next', '下一张')}">›</button>
    <div class="pd-lb-count"></div>`;
  const img = box.querySelector('.pd-lb-img');
  const count = box.querySelector('.pd-lb-count');
  const show = () => {
    img.src = _pdGallery[i] || '';
    const multi = _pdGallery.length > 1;
    box.querySelector('.pd-lb-prev').style.display = multi ? '' : 'none';
    box.querySelector('.pd-lb-next').style.display = multi ? '' : 'none';
    count.textContent = multi ? `${i + 1} / ${_pdGallery.length}` : '';
  };
  const step = d => { i = (i + d + _pdGallery.length) % _pdGallery.length; show(); };
  // Browser-history integration: opening this full-screen viewer pushes a
  // throwaway history entry, so the operator's instinct to press the browser
  // Back button (the viewer covers the whole app and reads like a new page)
  // CLOSES the lightbox instead of navigating off the admin entirely. Closing
  // any other way (✕ / backdrop / Esc) consumes that entry via history.back().
  let closed = false, closedViaPop = false;
  const close = () => {
    if (closed) return; closed = true;
    box.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    if (!closedViaPop) history.back();  // unwind the entry we pushed
  };
  const onPop = () => { closedViaPop = true; close(); };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  box.addEventListener('click', e => {
    if (e.target.closest('.pd-lb-prev')) step(-1);
    else if (e.target.closest('.pd-lb-next')) step(1);
    else if (e.target === img) return; // click the image itself = no-op
    else close();                       // backdrop or ✕ closes
  });
  document.addEventListener('keydown', onKey);
  history.pushState({ pdLightbox: true }, '');
  window.addEventListener('popstate', onPop);
  document.body.appendChild(box);
  show();
}
// "Product editor" — opens the full page designer in a new tab. Needs a saved
// product (the editor loads it by id), so prompt to save a brand-new one first.
function pdOpenPageDesign() {
  const id = document.getElementById('pd-id').value;
  if (!id) { toast(cuT('Save the product first, then open the Product editor', '请先保存产品,再打开产品页编辑器'), 'err'); return; }
  openProductEditor(id);
}
// "🎨 Design" switch — the per-product `use_block_design` flag. ON makes the
// storefront product page render the Product-editor block design; OFF renders
// the classic EN/CN description above. Mirrors the kitchen app's toggle. Saved
// with a dedicated PATCH (not folded into the autosave body) so an autosave
// never clobbers a value just changed in the Product editor.
let _pdUseBlockDesign = false;
function pdRenderBlockDesignToggle() {
  const btn = document.getElementById('pd-blockdesign-toggle');
  pdSetPageTabChip(_pdUseBlockDesign);
  if (!btn) return;
  btn.classList.toggle('active', _pdUseBlockDesign);
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5v7"/></svg>' + (_pdUseBlockDesign ? 'Design: On · 开' : 'Design: Off · 关');
}
async function pdToggleBlockDesign() {
  const id = document.getElementById('pd-id').value;
  if (!id) { toast(cuT('Save the product first, then turn on the design', '请先保存产品,再开启设计'), 'err'); return; }
  const next = _pdUseBlockDesign ? 0 : 1;
  const btn = document.getElementById('pd-blockdesign-toggle');
  if (btn) btn.style.opacity = '.6';
  try {
    await pdSaveBlockFlag(id, next);
    if (next) {
      // Turning the design ON only matters once blocks exist — the storefront
      // needs both the flag AND a non-empty block stack, else it falls back to
      // the classic description. Build that block description in place (popup),
      // so flipping the switch alone is enough — no navigating away.
      await pdAutoComposeBlocks(id, btn);
    } else {
      toast(cuT('Storefront will use the classic description', '店铺将显示经典描述'), 'ok');
    }
  } catch (e) {
    toast(cuT('Save failed', '保存失败') + ' · ' + (e.message || e), 'err');
  } finally {
    if (btn) btn.style.opacity = '';
  }
}
// PATCH just the use_block_design flag + keep the toggle / list cache in sync.
async function pdSaveBlockFlag(id, val) {
  const r = await fetch('/api/retail-admin/products/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ use_block_design: val }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.error || 'save_failed');
  _pdUseBlockDesign = !!val;
  const i = PA_PRODUCTS.findIndex(x => x.id === Number(id));
  if (i >= 0) PA_PRODUCTS[i].use_block_design = val;
  pdRenderBlockDesignToggle();
}
// Flip the flag back OFF — safety net when a fresh turn-on can't produce blocks,
// so the storefront never strands on an empty designed page (falls to classic).
async function pdDesignOff(id) { try { await pdSaveBlockFlag(id, 0); } catch {} }
// Strip description HTML down to plain text for the AI agent.
function pdStripToText(html) {
  let s = String(html == null ? '' : html);
  if (!s.trim()) return '';
  s = s.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n').replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea'); ta.innerHTML = s;
  return ta.value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n').trim();
}
// Blocking progress overlay for the AI page-build. A single AI call gives no
// real percentage, so the bar creeps toward 90% then snaps to 100% when done.
function pdComposeProgress() {
  document.getElementById('pdComposeOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'pdComposeOv';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(20,24,16,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `
    <div style="background:var(--bg-pane,#fff);border:1px solid var(--line,#e6e0d2);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.3);padding:22px 24px 20px;width:min(92vw,360px);font-family:var(--f-sans,inherit)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <div style="width:22px;height:22px;flex:none;border:3px solid rgba(163,180,159,.22);border-top-color:#A3B49F;border-radius:50%;animation:db-ring-spin .8s linear infinite"></div>
        <div style="font-weight:700;font-size:15px;color:var(--text-1,#1a2314);line-height:1.3">${cuT('Building your product page', '正在生成商品页')}</div>
      </div>
      <div style="height:8px;border-radius:999px;background:var(--bg-elev-1,#e9e9e3);overflow:hidden">
        <div data-bar style="height:100%;width:6%;border-radius:999px;background:linear-gradient(90deg,#A3B49F,var(--brass));transition:width .4s ease"></div>
      </div>
      <div data-msg style="margin-top:12px;font-size:12px;color:var(--text-3,#7d7a72);line-height:1.4;min-height:1.4em">${cuT('Reading your description…', '正在读取描述…')}</div>
    </div>`;
  document.body.appendChild(ov);
  const bar = ov.querySelector('[data-bar]');
  const msg = ov.querySelector('[data-msg]');
  const stages = [
    cuT('Reading your description…', '正在读取描述…'),
    cuT('Writing the sections…', '正在编排板块…'),
    cuT('Laying out the page…', '正在排版…'),
    cuT('Almost done…', '即将完成…'),
  ];
  let pct = 6, si = 0;
  const tick = setInterval(() => {
    pct = Math.min(90, pct + (90 - pct) * 0.12 + 1);
    bar.style.width = pct.toFixed(1) + '%';
    const nx = Math.min(stages.length - 1, Math.floor(pct / 24));
    if (nx !== si) { si = nx; msg.textContent = stages[si]; }
  }, 450);
  return {
    done(ok, text) {
      clearInterval(tick);
      bar.style.width = '100%';
      bar.style.background = ok ? 'linear-gradient(90deg,#A3B49F,#4A6249)' : 'linear-gradient(90deg,#e8556a,#ef9a9a)';
      if (text) msg.textContent = text;
      setTimeout(() => ov.remove(), ok ? 900 : 1400);
    },
  };
}
// Build description_blocks from the editor's EN/CN description when the design is
// switched ON. Fresh products seed automatically; one that already has sections
// gets a confirm to REBUILD (replacing them). Mirrors the kitchen app's
// iedAutoComposeBlocks + product-editor's compose flow (same /api/ai/compose-
// blocks endpoint). Any miss flips the flag back off for a fresh product so the
// storefront never lands on an empty designed page.
// Quietly fill the Product details boxes from the description text when they're
// still empty — called by Design On so the boxes feed the design without a
// separate "Auto-fill" click. Best-effort: AI off / failure / no text just
// proceeds (the design still builds from the description as before).
async function pdFactsAutoFillQuiet(textEn, textCn) {
  try {
    if (typeof pdFactsGet !== 'function') return;
    if (Object.keys(pdFactsGet()).length) return;   // never clobber existing box values
    if (!textEn && !textCn) return;
    const r = await fetch('/api/retail-admin/ai/extract-facts', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text_en: textEn || '', text_cn: textCn || '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.success && j.data && j.data.facts && Object.keys(j.data.facts).length) {
      pdFactsSet({ ...pdFactsGet(), ...j.data.facts });
      pdScheduleAutosave();   // persist the freshly-filled boxes alongside the design
    }
  } catch (e) { /* best-effort — proceed to build without facts */ }
}
async function pdAutoComposeBlocks(id, btn, skipConfirm) {
  const row = PA_PRODUCTS.find(x => x.id === Number(id)) || {};
  // The catalogue LIST endpoint omits the heavy description_blocks JSON and
  // ships only a `has_blocks` flag, so reading row.description_blocks here
  // always saw undefined — an already-designed product was treated as fresh:
  // the rebuild confirm never fired, and a failed pass flipped the flag back
  // OFF, dropping a saved design. Detect via _paHasBlocks (flag-aware), then
  // pull the real array on demand for the rebuild prompt's count.
  let blocks = Array.isArray(row.description_blocks) ? row.description_blocks : null;
  if (!blocks && _paHasBlocks(row)) {
    try {
      const rr = await fetch('/api/retail-admin/products/' + id, { credentials: 'same-origin' });
      const jj = await rr.json().catch(() => ({}));
      if (jj && jj.success && jj.data && Array.isArray(jj.data.description_blocks)) blocks = jj.data.description_blocks;
    } catch (e) { /* fall back to the flag below */ }
  }
  const hasBlocks = (Array.isArray(blocks) && blocks.length > 0) || _paHasBlocks(row);
  const revertFresh = () => hasBlocks ? Promise.resolve() : pdDesignOff(id);
  // Already designed: don't silently keep the old sections — offer a rebuild.
  if (hasBlocks && !skipConfirm) {
    const n = Array.isArray(blocks) ? blocks.length : 0;
    const ok = await askConfirm({
      title: cuT('This product already has ' + (n ? n + ' designed section(s)' : 'a designed page') + '.',
                 '该商品已有' + (n ? n + ' 个板块' : '已设计的页面') + '。'),
      body: cuT('Rebuild it from the current description? This replaces the existing sections.',
                '要根据当前描述重新生成吗?这将替换现有板块。'),
      confirmLabel: cuT('Rebuild', '重新生成'),
      danger: true,
    });
    if (!ok) { toast(cuT('Kept the existing design — open the Product editor to edit it', '已保留现有设计,可在产品页编辑器中编辑'), 'ok'); return; }
  }
  // Read the description straight from the editor (cleaned HTML → plain text).
  const textEn = pdStripToText(pdRteClean(document.getElementById('pd-rte-en').innerHTML));
  const textCn = pdStripToText(pdRteClean(document.getElementById('pd-rte-cn').innerHTML));
  if (!textEn && !textCn) {
    await revertFresh();
    toast(cuT('Add a description first, then turn on the design', '请先填写描述,再开启设计'), 'err');
    return;
  }
  // Only one language needed — the AI drafts the other in the brand voice.
  const translate = !(textEn && textCn);
  const prog = pdComposeProgress();
  // Fold "Auto-fill" into Design On — if the Product details boxes are empty,
  // pull the facts from the description first so the design is built FROM the
  // boxes in a single click. No-ops if the boxes are already filled.
  await pdFactsAutoFillQuiet(textEn, textCn);
  try {
    const r = await fetch('/api/retail-admin/ai/compose-blocks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({
        text_en: textEn, text_cn: textCn, translate,
        product: { id: Number(id), name_en: row.name_en, name_cn: row.name_cn, category: row.top_category || row.category, weight: (document.getElementById('pd-weight') || {}).value || row.size || '', facts: (typeof pdFactsGet === 'function' ? pdFactsGet() : null) },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503) {
      await revertFresh(); prog.done(false, cuT('AI is not configured yet', 'AI 尚未配置'));
      toast(cuT('AI is not configured yet — open the Product editor to design it by hand', 'AI 尚未配置,可在产品页编辑器中手动设计'), 'err');
      return;
    }
    if (!r.ok || !j.success) {
      await revertFresh(); prog.done(false, cuT("Couldn't build", '生成失败'));
      toast(j.error || cuT("Couldn't build the design — open the Product editor to design it by hand", '生成失败,可在产品页编辑器中手动设计'), 'err');
      return;
    }
    const all = (j.blocks || []).filter(b => b && b.type);
    // Nutrition lives in its own column, not in description_blocks — route it out.
    const nutriBlock = all.find(b => b.type === 'nutrition_facts');
    // Keep nutrition_facts IN the design stack (attached, not apart). It's ALSO
    // mirrored to the nutrition column below, so the not-yet-republished mini-app
    // keeps showing its separate panel until the new storefront — which renders
    // the block inline and hides that panel — is published.
    const composed = all
      .map((b, i) => ({ ...b, id: b.id || ('b' + Date.now().toString(36) + i) }));
    if (!composed.length) {
      await revertFresh(); prog.done(false, cuT("Couldn't build", '生成失败'));
      toast(cuT("Couldn't build sections from this description — add more detail and try again", '未能从描述生成板块,补充内容后重试'), 'err');
      return;
    }
    // Persist blocks (+ nutrition) and keep the flag on, in one PATCH.
    const body = { description_blocks: composed, use_block_design: 1 };
    if (nutriBlock) {
      const nutrition = {
        basis_en: nutriBlock.basis_en || '', basis_cn: nutriBlock.basis_cn || '',
        rows: Array.isArray(nutriBlock.rows)
          ? nutriBlock.rows.map(rr => ({ label_en: rr.label_en || '', label_cn: rr.label_cn || '', value: rr.value || '' }))
          : [],
      };
      if (nutrition.basis_en || nutrition.basis_cn || nutrition.rows.length) body.nutrition = nutrition;
    }
    const sr = await fetch('/api/retail-admin/products/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok || !sj.success) {
      await revertFresh(); prog.done(false, cuT("Couldn't save", '保存失败'));
      toast(cuT("Built the design but couldn't save it — try again", '已生成但保存失败,请重试'), 'err');
      return;
    }
    const i2 = PA_PRODUCTS.findIndex(x => x.id === Number(id));
    if (i2 >= 0) PA_PRODUCTS[i2] = { ...PA_PRODUCTS[i2], ...(sj.data || {}), description_blocks: composed, use_block_design: 1 };
    _pdUseBlockDesign = true; pdRenderBlockDesignToggle();
    _pdDesignStale = false; pdRenderDesignStale();
    // Repaint the grid so the just-built design flips the card's Plain → Designed
    // pill immediately, without waiting for the operator to click another product.
    if (typeof paRender === 'function') paRender();
    prog.done(true, cuT('Built ✓', '已生成 ✓'));
    toast(cuT('Built ' + composed.length + ' section' + (composed.length === 1 ? '' : 's') + ' — open the Product editor to review ✓',
              '已生成 ' + composed.length + ' 个板块,可在产品页编辑器中查看 ✓'), 'ok');
    if (translate) {
      toast(!textCn
        ? cuT('Wrote the 中文 for you in the brand voice — review it in the Product editor', '已按品牌语气替你撰写中文,请在产品页编辑器中校对')
        : cuT('Wrote the English for you in the brand voice — review it in the Product editor', '已按品牌语气替你撰写英文,请在产品页编辑器中校对'), 'ok');
    }
  } catch (e) {
    await revertFresh(); prog.done(false, cuT("Couldn't build", '生成失败'));
    toast(cuT("Couldn't build the design — open the Product editor to design it by hand", '生成失败,可在产品页编辑器中手动设计'), 'err');
  }
}
// ── Description editor — the Classic (rich-text) editor is the only inline
// mode; "Product editor" in the mode bar launches the full page designer. ───
function pdApplyDescMode() {
  document.querySelectorAll('.pd-mode-btn[data-mode="classic"]').forEach(b => b.classList.add('active'));
}
function pdDescMode() { pdApplyDescMode(); }
// The single toolbar drives whichever EN/CN box the cursor is in. Native
// controls (the Format <select>, the colour pickers) steal focus and would
// collapse the selection, so we track the live range from `selectionchange`
// and restore it before running a command.
let _pdRteActive = null, _pdRteRange = null;
document.addEventListener('selectionchange', () => {
  const s = document.getSelection();
  if (!s || !s.rangeCount) return;
  let n = s.anchorNode;
  if (n && n.nodeType === 3) n = n.parentElement;
  const ed = n && n.closest && n.closest('.pd-rte');
  if (ed) { _pdRteActive = ed; _pdRteRange = s.getRangeAt(0).cloneRange(); }
});
function pdRteSaveSel() {
  const s = document.getSelection();
  if (s && s.rangeCount) {
    let n = s.anchorNode; if (n && n.nodeType === 3) n = n.parentElement;
    const ed = n && n.closest && n.closest('.pd-rte');
    if (ed) { _pdRteActive = ed; _pdRteRange = s.getRangeAt(0).cloneRange(); }
  }
}
function pdRteRestore() {
  if (!_pdRteActive) _pdRteActive = document.getElementById('pd-rte-en');
  _pdRteActive.focus();
  if (_pdRteRange) { const s = document.getSelection(); s.removeAllRanges(); s.addRange(_pdRteRange); }
}
function pdRte(cmd, val) {
  pdRteRestore();
  // styleWithCSS makes colour/decoration come out as <span style> (which the
  // mini-app <rich-text> renders) instead of legacy <font>/<u> tags it drops.
  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
  try { document.execCommand(cmd, false, (val == null ? null : val)); } catch (e) {}
  pdRteSaveSel();
}
function pdRteBlock(tag) { if (tag) pdRte('formatBlock', tag); }
function pdRteColor(c) { pdRte('foreColor', c); }
function pdRteHilite(c) { try { pdRte('hiliteColor', c); } catch (e) { pdRte('backColor', c); } }
function pdRteClear() { pdRte('removeFormat'); pdRte('formatBlock', 'p'); }
async function pdRteLink() { const url = await askPrompt({ title: 'Link URL · 链接地址', submitLabel: cuT('Insert', '插入') }); if (url) pdRte('createLink', url); }
// Image: upload through the media library (same store the gallery uses), then
// drop an absolute https URL into the HTML. Relative /api/... srcs wouldn't
// resolve inside the mini-app's <rich-text>, so we anchor to the live origin
// (falling back to the canonical domain when edited over http/IP in dev).
function pdRteImage() {
  pdRteSaveSel();
  const inp = document.getElementById('pd-rte-img-file');
  if (inp) { inp.value = ''; inp.click(); }
}
async function pdRteImagePick(e) {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  toast(cuT('Uploading image…', '正在上传图片…'));
  try {
    // Compress client-side first (same path the photo gallery uses) — a raw
    // 4–10MB phone photo blows past the proxy body limit and bounces back as an
    // HTML 413 page, which then fails JSON parse ("Unexpected token '<'").
    // pdHandleImageUpload lands it ~300–600KB; it toasts + returns null on error.
    const dataURL = await pdHandleImageUpload(f, PD_DESC_IMG_OPTS);
    if (!dataURL) return;
    const blob = await (await fetch(dataURL)).blob();
    const name = (f.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
    const fd = new FormData(); fd.append('file', blob, name);
    const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    // A proxy 413/502 returns an HTML page, not JSON — guard so the operator gets
    // a real message instead of a raw JSON-parse error.
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.indexOf('application/json') === -1) {
      throw new Error(r.status === 413 ? cuT('image too large', '图片过大') : ('HTTP ' + r.status));
    }
    const j = await r.json();
    if (!j || !j.success) throw new Error((j && j.error) || 'upload_failed');
    const base = /^https:\/\//.test(location.origin) ? location.origin : 'https://rootskitchenchina.com';
    const url = base + j.data.url;
    pdRteRestore();
    document.execCommand('insertHTML', false, `<img src="${url}" style="max-width:100%;height:auto;" alt="">`);
    pdRteSaveSel();
    toast(cuT('Image added', '图片已插入'), 'ok');
  } catch (err) {
    toast(cuT('Image upload failed', '图片上传失败') + (err && err.message ? ' · ' + err.message : ''), 'err');
  }
}
// Table: ask for rows × cols and drop an inline-styled (class-free, so the
// mini-app <rich-text> keeps the borders) editable grid; first row is <th>.
async function pdRteTable() {
  pdRteSaveSel();
  const spec = await askPrompt({
    title: cuT('Table size — rows × columns (e.g. 3x3)', '表格大小 — 行 × 列(例如 3x3)'),
    value: '3x3',
    submitLabel: cuT('Insert', '插入'),
  });
  if (!spec) return;
  const nums = String(spec).toLowerCase().split(/[^0-9]+/).filter(Boolean).map(n => parseInt(n, 10));
  let rows = Math.min(Math.max(nums[0] || 2, 1), 20);
  let cols = Math.min(Math.max(nums[1] || 2, 1), 8);
  const cell = tag => `<${tag} style="border:1px solid #d8d2c4;padding:6px 8px;min-width:48px;">&nbsp;</${tag}>`;
  let html = '<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:inherit;">';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += cell(r === 0 ? 'th' : 'td');
    html += '</tr>';
  }
  html += '</table><p><br></p>';
  pdRteRestore();
  document.execCommand('insertHTML', false, html);
  pdRteSaveSel();
}
function pdRteFullscreen() {
  const wrap = document.getElementById('pd-desc-rich'); if (!wrap) return;
  const on = wrap.classList.toggle('pd-rte-fs');
  document.body.classList.toggle('pd-rte-fs-lock', on);
}
function pdPlainToHtml(t) { return escapeHtml(String(t || '')).replace(/\n/g, '<br>'); }
// Free-of allergen claims — checkbox group, persisted as a comma-separated
// string. Any stored token not covered by a checkbox (legacy/custom values)
// is preserved in _pdFreeOfExtra so saving never silently drops it.
let _pdFreeOfExtra = [];
function pdFreeOfSet(str) {
  const group = document.getElementById('pd-free-of'); if (!group) return;
  const boxes = [...group.querySelectorAll('input[data-freeof-id]')];
  const known = new Map(boxes.map(b => [b.dataset.freeofId.toLowerCase(), b]));
  const toks = String(str || '').split(',').map(s => s.trim()).filter(Boolean);
  boxes.forEach(b => { b.checked = false; });
  _pdFreeOfExtra = [];
  toks.forEach(t => { const b = known.get(t.toLowerCase()); if (b) b.checked = true; else _pdFreeOfExtra.push(t); });
}
function pdFreeOfGet() {
  const group = document.getElementById('pd-free-of'); if (!group) return '';
  const checked = [...group.querySelectorAll('input[data-freeof-id]:checked')].map(b => b.dataset.freeofId);
  return [...checked, ..._pdFreeOfExtra].join(', ');
}
// A visually-empty rich box (just <br>/&nbsp;) saves as '' rather than junk markup.
// A box counts as "has content" when it has visible text OR embedded media —
// an image-only (or table/divider-only) description has no innerText, so the
// old text-only check silently discarded it on save. Keep the HTML in that case.
function pdRteClean(html) {
  const d = document.createElement('div'); d.innerHTML = html || '';
  const hasText = !!(d.innerText || '').trim();
  const hasMedia = !!d.querySelector('img, table, hr, video, iframe, audio, svg');
  return (hasText || hasMedia) ? (html || '').trim() : '';
}
// Scraped/pasted rich copy (OUT1N TinyMCE, Word) glues words with non-breaking
// spaces, so a long paragraph becomes one unbreakable line that overflows the
// editor instead of wrapping. Swap them for plain spaces on load so the text
// wraps at word boundaries — and saves clean on the next autosave.
function pdRichForEdit(html) { return (html || '').replace(/&nbsp;|\u00a0/g, ' '); }
// ── Autosave engine ────────────────────────────────────────────────────────
// The editor has no manual Save button: edits persist on a short debounce.
// pdCollectBody() reads the form; pdSaveCore() does the network write (shared by
// autosave); pdScheduleAutosave() debounces; the foot shows live status.
let _pdAutoTimer = null;      // debounce handle
let _pdSaving = false;        // a save request is in flight
let _pdPendingResave = false; // an edit landed mid-save → save again when it returns
let _pdOpenBaseline = null;   // form snapshot captured when the product was opened (Revert target)

// Structured product facts (the "Product details" card) ↔ the product_facts
// JSON bag. Keys are <col>_en/_cn so the same bag fits any product type.
const PD_FACT_FIELDS = [['origin','origin'],['ingredients','ingredients'],['storage','storage'],['shelflife','shelf_life'],['serving','serving']];
function pdFactsGet() {
  const g = el => (document.getElementById(el) && document.getElementById(el).value || '').trim();
  const out = {};
  for (const [dom, col] of PD_FACT_FIELDS) {
    const en = g('pd-fact-' + dom + '-en'), cn = g('pd-fact-' + dom + '-cn');
    if (en) out[col + '_en'] = en;
    if (cn) out[col + '_cn'] = cn;
  }
  return out;
}
function pdFactsSet(f) {
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = (v == null ? '' : v); };
  const o = (f && typeof f === 'object') ? f : {};
  for (const [dom, col] of PD_FACT_FIELDS) {
    set('pd-fact-' + dom + '-en', o[col + '_en']);
    set('pd-fact-' + dom + '-cn', o[col + '_cn']);
  }
}
// "Auto-fill from text" — read the description (or a pasted blob) and let the
// AI split it into the Product details boxes. Same engine that already reads
// descriptions; fills empty boxes and refreshes found ones for review.
async function pdFactsAutofill() {
  const btn = document.getElementById('pd-facts-autofill');
  let textEn = pdStripToText(pdRteClean(document.getElementById('pd-rte-en').innerHTML));
  let textCn = pdStripToText(pdRteClean(document.getElementById('pd-rte-cn').innerHTML));
  if (!textEn && !textCn) {
    const pasted = await askReason({
      title: cuT('Paste the product text to pull details from', '粘贴产品文字以提取详情'),
      submitLabel: cuT('Read text', '识别'),
    });
    if (pasted == null || !pasted.trim()) return;
    textEn = pasted.trim();
  }
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  toast(cuT('Reading your text…', '正在识别…'));
  try {
    const r = await fetch('/api/retail-admin/ai/extract-facts', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text_en: textEn, text_cn: textCn }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503) { toast(cuT('AI is not configured yet — fill the boxes by hand', 'AI 尚未配置,请手动填写'), 'err'); return; }
    if (!r.ok || !j.success) {
      toast(j && j.error === 'no_text' ? cuT('Add some product text first', '请先填写产品文字') : cuT("Couldn't read the details — fill by hand", '识别失败,请手动填写'), 'err');
      return;
    }
    const facts = (j.data && j.data.facts) || {};
    if (!Object.keys(facts).length) { toast(cuT('No details found in the text', '未在文字中找到详情'), 'err'); return; }
    pdFactsSet({ ...pdFactsGet(), ...facts });
    pdScheduleAutosave();
    toast(cuT('Filled in the details — review & tweak', '已填充详情,请核对'), 'ok');
  } catch (e) {
    toast(cuT("Couldn't read the details", '识别失败'), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}
// Shipping-mode interplay. "Local only" (Guangzhou same-city) is mutually
// exclusive with Air/Land: ticking it clears + disables them; ticking Air/Land
// clears it. `source` is the box that fired (omitted when syncing on load).
function pdShipModeChanged(source) {
  const air   = document.getElementById('pd-ship-air');
  const land  = document.getElementById('pd-ship-land');
  const local = document.getElementById('pd-ship-local');
  if (!air || !land || !local) return;
  if (source === 'local' && local.checked) { air.checked = false; land.checked = false; }
  if ((source === 'air' || source === 'land') && (air.checked || land.checked)) local.checked = false;
  [air, land].forEach(cb => {
    cb.disabled = local.checked;
    const lbl = cb.closest('label'); if (lbl) lbl.style.opacity = local.checked ? '.4' : '';
  });
  const hint = document.getElementById('pd-ship-local-hint');
  if (hint) hint.style.display = local.checked ? 'block' : 'none';
}
function pdCollectBody() {
  const id = document.getElementById('pd-id').value;
  const g = el => (document.getElementById(el) && document.getElementById(el).value || '').trim();
  const ckd = el => { const n = document.getElementById(el); return n && n.checked ? 1 : 0; };
  // Local only is exclusive: it overrides air/land and stores just 'local'.
  const modes = [];
  if (document.getElementById('pd-ship-local').checked) {
    modes.push('local');
  } else {
    if (document.getElementById('pd-ship-air').checked)  modes.push('air');
    if (document.getElementById('pd-ship-land').checked) modes.push('land');
  }
  // Description: always the cleaned HTML from the Classic (rich) boxes;
  // description_format='rich' tells the mini-app to render it via <rich-text>.
  const body = {
    name_en: g('pd-name-en'), name_cn: g('pd-name-cn'),
    sku: g('pd-sku'), weight: g('pd-weight'),
    top_category: g('pd-top-category'), subcategory: g('pd-subcategory'),
    tags: g('pd-badge'),
    // Only include sell_price when the field actually has a value. An empty
    // field (e.g. the operator cleared it to retype a new price) must NOT
    // autosave sell_price:0 — that would make the live product FREE until the
    // next keystroke saves. Omitting the key leaves the stored price unchanged
    // (the server only writes sell_price when it's present in the body).
    ...(g('pd-price') !== '' ? { sell_price: parseFloat(g('pd-price')) || 0 } : {}),
    compare_at_price: parseFloat(g('pd-compare')) || 0,
    // Sent even when blank: '' clears the cost back to NULL ("we don't know"),
    // which is a thing the operator must be able to do. Unlike sell_price above
    // there is no free-product hazard in clearing it — a null cost just blanks
    // the margin readout. The server refuses to coerce it to 0.
    //
    // OMITTED ENTIRELY when a recipe owns the figure. The server drops it in
    // that case anyway, but not sending it keeps the autosave payload honest
    // about what the operator actually changed.
    ...(document.getElementById('pd-cost') && document.getElementById('pd-cost').readOnly
        ? {} : { unit_cost: g('pd-cost').trim() }),
    low_stock_threshold: g('pd-low-stock').trim(),  // '' = clear override → use store default
    status: g('pd-status') || 'Active',
    free_of: pdFreeOfGet(), notes: g('pd-notes'), product_facts: pdFactsGet(),
    is_market: ckd('pd-is-market'), is_restock_only: ckd('pd-is-restock-only'), is_batch_made: ckd('pd-is-batch-made'),
    // Supplier-direct items are always available (stock ignored); the dropdown
    // is hidden for them, so force the policy rather than read the stale select.
    oos_policy: ckd('pd-ship-from-supplier') ? 'always'
              : (g('pd-oos-policy') === 'backorder_gz' ? 'backorder_gz' : 'strict'),
    ship_from_supplier: ckd('pd-ship-from-supplier'),
    supplier_paused: ckd('pd-supplier-paused'),
    ship_modes: modes.join(',') || 'air,land',
    description_en: pdRteClean(document.getElementById('pd-rte-en').innerHTML),
    description_cn: pdRteClean(document.getElementById('pd-rte-cn').innerHTML),
    description_format: 'rich',
    is_published: document.getElementById('pd-published').checked ? 1 : 0,
  };
  if (_pdGalleryDirty) body.images = _pdGallery;  // gallery drives image_data (first = main)
  if (id && BU_ID === Number(id)) body.bundle = buBody();  // buy-together bundle (null clears)
  if (id && BP_ID === Number(id)) { body.bundle_items = bpBody(); body.bundle_mode = bpModeBody(); }  // THIS-is-a-bundle recipe + stock mode (null clears)
  if (id && OPT_ID === Number(id)) body.options = optBody();  // customer-choice options ([] clears)
  return { id, body };
}

// Core write shared by autosave. reload=false keeps the operator's caret + field
// values exactly where they are (we don't re-open the editor mid-typing); we just
// merge the server's canonical row into PA_PRODUCTS and refresh the list. Returns
// true on success. Throws are surfaced via the returned false + status pill.
async function pdSaveCore() {
  // Reading the form into a payload runs before any network call. It should never
  // fail, but if a browser quirk makes it throw, tag it so the cause is obvious
  // (a bare DOM error like "The string did not match the expected pattern" is
  // otherwise impossible to place).
  let id, body;
  try { ({ id, body } = pdCollectBody()); }
  catch (e) { throw new Error('Couldn’t read the form · 读取表单失败: ' + (e && e.message || e)); }
  // Snapshot the policy this product carried BEFORE this save, so we can tell
  // below whether the operator actually changed it (and only then re-push it
  // to sibling sizes — see the vaPersistSiblings call further down).
  const prevOosPolicy = id ? ((PA_PRODUCTS || []).find(x => x.id === Number(id)) || {}).oos_policy : undefined;
  const url = id ? '/api/retail-admin/products/' + id : '/api/retail-admin/products';
  const r = await fetch(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.success) {
    const msg = j.error === 'sku_taken'     ? skuTakenMsg(body.sku, j.conflict, '')
              : j.error === 'sku_required'   ? 'A SKU is required · 需要填写货号'
              : j.error === 'catalog_locked' ? 'This catalog is managed by the upstream system · 该商品目录由上游系统管理'
              : (j.error || 'save_failed');
    throw new Error(msg);
  }
  // ── The server write SUCCEEDED past this point. ────────────────────────────
  // Everything below is local UI refresh. A failure here (e.g. a browser-
  // specific DOM quirk) must NOT be reported as "Save failed" — the product is
  // already saved on the server, and telling the operator otherwise (with a
  // Revert button) risks them discarding work that actually persisted.
  let uiError = null;
  try {
    if (id) {
      const i = PA_PRODUCTS.findIndex(x => x.id === Number(id));
      if (i >= 0) PA_PRODUCTS[i] = { ...PA_PRODUCTS[i], ...j.data };
    } else if (j.data) {
      // Brand-new product just got its id — promote the editor to edit-mode so the
      // next autosave PATCHes instead of creating a second product.
      PA_PRODUCTS.unshift(j.data);
      document.getElementById('pd-id').value = j.data.id;
      // The server may have minted a DRAFT-… SKU (created name-only). Reflect it
      // into the form so the operator sees the code AND the next autosave PATCHes
      // the real SKU instead of an empty one (which we'd otherwise ignore).
      const skuEl = document.getElementById('pd-sku');
      if (skuEl && !skuEl.value.trim() && j.data.sku) skuEl.value = j.data.sku;
      _pdSelectedId = j.data.id;
      document.getElementById('pd-dup-btn').style.display = '';
      document.getElementById('pd-delete-btn').style.display = '';
      vaLoad(j.data.id); buLoad(j.data.id); bpLoad(j.data.id); optLoad(j.data.id);
    }
  } catch (e) { uiError = e; }

  // Variant rows live in this same editor — fold their labels/grouping into the
  // same write. Only when a real group is loaded (>=2 members) so an ordinary
  // save never clears a group as a side effect. This is a genuine server write,
  // so it stays fatal (a failure here really IS a save failure).
  const sid = id ? Number(id) : (j.data && j.data.id);
  if (sid != null && VA_ID === sid && (VA_MEMBERS.length >= 2 || VA_HAD_GROUP)) {
    await vaPersist();
    // Sizes of one product share one out-of-stock rule — "Sold out everywhere"
    // on the Big bottle has to mean the Small one too, or a shopper sees SOLD
    // OUT on one size and PRE-ORDER on the other for what reads as one product.
    // Only push it when it actually changed this save (not on every autosave
    // tick), so editing an unrelated field doesn't spam every sibling with a
    // no-op PATCH + version-history row.
    const oosChanged = prevOosPolicy !== undefined && prevOosPolicy !== body.oos_policy;
    await vaPersistSiblings(oosChanged ? body.oos_policy : null);
  }

  _pdGalleryDirty = false;  // images are now persisted; don't resend until changed again
  try {
    paRender();               // list names/badges refresh (doesn't touch editor focus)
    paApplyRowSelection();
  } catch (e) { uiError = uiError || e; }

  // Saved fine — but surface the swallowed refresh error to the console so a real
  // UI bug can still be found, without ever lying to the operator about the save.
  if (uiError) console.error('[pdSaveCore] product saved on server; post-save UI refresh failed:', uiError);
  return true;
}

function pdSetStatus(state, msg) {
  const el = document.getElementById('pd-save-status');
  if (!el) return;
  el.className = 'pd-save-status' + (state ? ' is-' + state : '');
  const label = msg || (
    state === 'saving' ? cuT('Saving…', '保存中…')
  : state === 'saved'  ? cuT('All changes saved', '已自动保存')
  : state === 'dirty'  ? cuT('Saving…', '保存中…')
  : state === 'error'  ? cuT('Save failed — retrying on next edit', '保存失败 — 修改后重试')
  : '');
  el.textContent = label;
}

// Debounced trigger — wired to every input/change inside the editor.
function pdScheduleAutosave() {
  pdSetStatus('dirty');
  // Keep the full page's own title in step with the name being typed under it.
  if (pdIsExpanded()) pdSyncPageHead();
  clearTimeout(_pdAutoTimer);
  _pdAutoTimer = setTimeout(pdAutoSaveNow, 800);
}

async function pdAutoSaveNow() {
  _pdAutoTimer = null;  // this fire consumes the pending debounce, scheduled or flushed
  if (_pdSaving) { _pdPendingResave = true; return; }  // coalesce — save again when current returns
  const g = el => (document.getElementById(el) && document.getElementById(el).value || '').trim();
  // Soft validation — never alert during autosave; just hold and hint until the
  // minimums the server requires are present.
  if (!g('pd-name-en') && !g('pd-name-cn')) { pdSetStatus('hint', cuT('Add a name to start autosaving', '填写名称后自动保存')); return; }
  // No SKU gate: a name is enough. The server mints a unique DRAFT-… SKU on
  // create when the field is blank (pdSaveCore writes it back into the form).
  _pdSaving = true; pdSetStatus('saving');
  try {
    await pdSaveCore();
    pdSetStatus('saved');
  } catch (e) {
    pdSetStatus('error', cuT('Save failed: ', '保存失败:') + e.message);
    // The save status sits at the bottom of a long editor — pop a toast too so a
    // failure is seen without scrolling down.
    toast(cuT('Save failed: ', '保存失败:') + e.message, 'err');
  } finally {
    _pdSaving = false;
    if (_pdPendingResave) { _pdPendingResave = false; pdScheduleAutosave(); }
  }
}

// Wire the editor once: any input/change inside it schedules an autosave.
// Programmatic loads (pdOpen sets .value / .innerHTML directly) don't fire these
// events, so loading a product never triggers a spurious save.
// "Design out of date" nudge — once a product has a live designed page, editing
// its content (description / Product details boxes / name / weight) makes that
// snapshot stale until rebuilt. Reset on open + on a successful (re)build.
let _pdDesignStale = false;
function pdRenderDesignStale() {
  const el = document.getElementById('pd-design-stale');
  if (el) el.style.display = _pdDesignStale ? 'flex' : 'none';
}
function pdMarkDesignStale() {
  if (!_pdUseBlockDesign || _pdDesignStale) return;   // only matters when a design exists
  _pdDesignStale = true;
  pdRenderDesignStale();
  pdRenderSummaries();   // the dock's Page row carries the same warning
}
function pdRebuildDesign() {
  const id = document.getElementById('pd-id').value;
  if (!id) return;
  pdAutoComposeBlocks(id, document.getElementById('pd-blockdesign-toggle'), true);
}
function pdWireAutosave() {
  const ed = document.getElementById('pd-editor');
  if (!ed || ed._autosaveWired) return;
  ed._autosaveWired = true;
  const onEdit = e => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.id === 'pd-img-file') return;  // file picker handled via gallery mutations
    if (t.closest('input, select, textarea, [contenteditable], .pd-rte')) pdScheduleAutosave();
    // The header's shop tag and the Basics switch are one value seen twice —
    // whichever the operator moved, the other has to follow in the same tick.
    if (t.id === 'pd-published') pdRenderHeadTags();
    // Margin is read off the price/cost pair, so it has to follow either one.
    if (t.id === 'pd-price' || t.id === 'pd-cost') pdRenderMargin();
    // Editing the description or the Product details boxes makes a built design stale.
    if (t.closest('.pd-rte') || (t.id && t.id.indexOf('pd-fact-') === 0) || t.id === 'pd-name-en' || t.id === 'pd-name-cn' || t.id === 'pd-weight') pdMarkDesignStale();
  };
  ed.addEventListener('input', onEdit);
  ed.addEventListener('change', onEdit);
}

// Snapshot / restore the editable form state. Used to capture the "as-opened"
// baseline so Revert can roll back a whole editing session.
function pdSnapshot() {
  const g = el => { const n = document.getElementById(el); return n ? n.value : ''; };
  const ck = el => { const n = document.getElementById(el); return !!(n && n.checked); };
  return {
    name_en: g('pd-name-en'), name_cn: g('pd-name-cn'), price: g('pd-price'), compare: g('pd-compare'),
    cost: g('pd-cost'),
    sku: g('pd-sku'), weight: g('pd-weight'), status: g('pd-status'), free_of: pdFreeOfGet(),
    notes: g('pd-notes'), badge: g('pd-badge'), facts: pdFactsGet(),
    top: g('pd-top-category'), sub: g('pd-subcategory'),
    is_market: ck('pd-is-market'), is_batch: ck('pd-is-batch-made'), is_restock: ck('pd-is-restock-only'),
    ship_supplier: ck('pd-ship-from-supplier'), supplier_paused: ck('pd-supplier-paused'),
    oos_policy: g('pd-oos-policy'),
    air: ck('pd-ship-air'), land: ck('pd-ship-land'), local: ck('pd-ship-local'), published: ck('pd-published'),
    desc_en: document.getElementById('pd-rte-en').innerHTML, desc_cn: document.getElementById('pd-rte-cn').innerHTML,
    gallery: _pdGallery.slice(),
  };
}
function pdApplySnapshot(s) {
  if (!s) return;
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = v; };
  const ck  = (el, v) => { const n = document.getElementById(el); if (n) n.checked = v; };
  set('pd-name-en', s.name_en); set('pd-name-cn', s.name_cn); set('pd-price', s.price); set('pd-compare', s.compare);
  // Cost is skipped while a recipe owns it: that figure was never part of the
  // form this snapshot came from (the field is read-only and the autosave omits
  // it), so restoring the pre-link number would put a stale value on screen that
  // no save would ever correct.
  { const c = document.getElementById('pd-cost'); if (c && !c.readOnly) set('pd-cost', s.cost); }
  pdRenderMargin();
  set('pd-sku', s.sku); set('pd-weight', s.weight); set('pd-status', s.status); pdFreeOfSet(s.free_of);
  set('pd-notes', s.notes); set('pd-badge', s.badge); pdFactsSet(s.facts);
  ck('pd-is-market', s.is_market); ck('pd-is-batch-made', s.is_batch); ck('pd-is-restock-only', s.is_restock);
  ck('pd-ship-from-supplier', s.ship_supplier); ck('pd-supplier-paused', s.supplier_paused);
  set('pd-oos-policy', s.oos_policy || 'strict');
  pdSyncSupplierUi();
  ck('pd-ship-air', s.air); ck('pd-ship-land', s.land); ck('pd-ship-local', s.local); ck('pd-published', s.published);
  pdShipModeChanged();
  document.getElementById('pd-rte-en').innerHTML = s.desc_en;
  document.getElementById('pd-rte-cn').innerHTML = s.desc_cn;
  // Categories: refill the selects from the loaded tree, then restore the picks.
  pdFillTopCats(s.top); pdFillSubCats(s.top, s.sub);
  _pdGallery = (s.gallery || []).slice(); _pdGalleryDirty = true; pdRenderGallery();
}
// Duplicate a product. asVariant=true also joins the copy to the source's
// variant group and prompts for the new variant label. Opens the copy so the
// operator can set its new price / size / SKU, then publish.
async function pdDoDuplicate(id, asVariant) {
  if (id == null || id === '') return;
  let label = null;
  if (asVariant) {
    label = await askPrompt({
      title: cuT('Variant label for the copy (e.g. 500g)', '副本的规格标签(如 500克)'),
      value: '',
      submitLabel: cuT('Duplicate', '复制'),
    });
    if (label === null) return;   // cancelled
    label = (label || '').trim();
  }
  try {
    const j = await api('/api/retail-admin/products/' + id + '/duplicate', { method: 'POST', body: { as_variant: !!asVariant, label } });
    if (!j.success || !j.data) throw new Error(j.error || 'duplicate_failed');
    PA_PRODUCTS.unshift(j.data);
    paRender();
    pdOpen(j.data.id);   // open the copy for tweaking (blank SKU, new price/size)
    toast(cuT('Duplicated — set the new SKU / price / size, then publish.', '已复制 — 请设置新货号 / 价格 / 规格后再上架。'));
  } catch (e) { toast(cuT('Duplicate failed: ', '复制失败:') + e.message, 'err'); }
}
function pdDuplicate(asVariant) { pdDoDuplicate(document.getElementById('pd-id').value || null, asVariant); }
function paDuplicate(id) { pdDoDuplicate(id, false); }
async function pdDelete() {
  const id = document.getElementById('pd-id').value; if (!id) return;
  if (!(await askConfirm({
    title: 'Delete this product? · 删除此产品?',
    body: 'It will be hidden from the shop. · 将从店面隐藏。',
    confirmLabel: 'Delete · 删除',
    danger: true,
  }))) return;
  try {
    const r = await fetch('/api/retail-admin/products/' + id, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'delete_failed');
    PA_PRODUCTS = PA_PRODUCTS.filter(x => x.id !== Number(id));
    pdClose();
    paRender();
  } catch (e) { toast('Delete failed · 删除失败: ' + e.message, 'err'); }
}


// ════════════════════════════════════════════════════════════════════════════
// GUIDED PRODUCT WIZARD (PC) — "Add a product" made simple for non-tech sellers.
// Additive: sits beside the full editor (pdOpen). Collects a few plain-language
// answers across small steps, then CREATES a real product through the same
// endpoints the editor uses, and opens it for any fine-tuning. Mirrors the
// coupon wizard's shell/motion (vw-*). Full spec + copy: Product-Wizard-v1-Spec.md.
// Copy follows the plain-words rule (one idea per line, concrete examples).
// ════════════════════════════════════════════════════════════════════════════
let _pw = null;
const PW_STEPS = ['what', 'price', 'details', 'extras', 'review'];
const PW_FREE_OF = [['nuts', 'Nuts', '无坚果'], ['soy', 'Soy', '无大豆'], ['gluten', 'Gluten', '无麸质'], ['5 spice', '5 Spice', '无五香']];
const PW_FACTS = [['origin', 'Where it’s from', '产地', 'e.g. Peru'],
                  ['ingredients', 'What’s in it', '配料', 'e.g. 100% cacao'],
                  ['storage', 'How to store it', '储存方式', 'e.g. Cool, dry place'],
                  ['shelf_life', 'Keeps for', '保质期', 'e.g. 12 months'],
                  ['serving', 'How to enjoy it', '食用建议', 'e.g. Add to smoothies, oats or baking']];
const PW_ICONS = {
  pencil: '<path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
};
function pwIcon(name, size) {
  size = size || 24;
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (PW_ICONS[name] || '') + '</svg>';
}
function pwPrimaryLang() { try { if (typeof cuLang === 'function') return cuLang() === 'cn' ? 'cn' : 'en'; } catch (e) {} return 'en'; }

function pwOpen() {
  _pw = {
    step: 'front', source: null,
    name_en: '', name_cn: '', sku: '', top: '', sub: '', photo: '',
    price: '', compare: '', stock: '', weight: '',
    hasSizes: false, sizes: [{ name_en: '', name_cn: '', weight: '', price: '', stock: '' }], localOnly: false,
    facts: {}, freeOf: {}, descEn: '', descCn: '',
    options: [], pick: null,
    designed: true, busy: false,
  };
  const bg = document.getElementById('pw-bg'); if (bg) bg.classList.add('show');
  pwRender();
  // Categories drive the picker on Step 1 — warm the cache, re-render if we're there.
  pdLoadCatTree().then(() => { if (_pw && _pw.step === 'what') pwRender(); });
}
function pwClose() {
  const body = document.getElementById('pw-body');
  if (body) body.classList.remove('vw-leaving', 'vw-entering');
  const bg = document.getElementById('pw-bg'); if (bg) bg.classList.remove('show');
  _pw = null;
}
// Esc closes (parity with the coupon wizard); backdrop click does NOT, so an
// in-progress product is never discarded by a stray click.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !_pw) return;
  const bg = document.getElementById('pw-bg');
  if (bg && bg.classList.contains('show')) pwClose();
});
function pwGoto(step) {
  if (!_pw) return;
  const body = document.getElementById('pw-body');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!body || reduce) { _pw.step = step; pwRender(); if (body) body.scrollTop = 0; return; }
  body.classList.remove('vw-entering');
  body.classList.add('vw-leaving');
  setTimeout(() => {
    if (!_pw) return;
    _pw.step = step; pwRender(); body.scrollTop = 0;
    body.classList.remove('vw-leaving'); void body.offsetWidth; body.classList.add('vw-entering');
  }, 240);
}
function pwDots(active) {
  return '<div class="vw-dots">' + PW_STEPS.map(s => '<span class="vw-dot' + (s === active ? ' on' : '') + '"></span>').join('') + '</div>';
}
function pwFoot(backStep, nextFn, active, nextLabel) {
  return '<button class="btn" onclick="pwGoto(\'' + backStep + '\')">' + cuT('Back', '返回') + '</button>'
    + pwDots(active)
    + '<button class="btn btn-primary" onclick="' + nextFn + '">' + (nextLabel || cuT('Next', '下一步')) + '</button>';
}
function pwRender() {
  if (!_pw) return;
  const title = document.getElementById('pw-title'), body = document.getElementById('pw-body'), foot = document.getElementById('pw-foot');
  if (!title || !body || !foot) return;
  const s = _pw.step;
  foot.style.display = (s === 'front' || s === 'front-paste' || s === 'front-copy') ? 'none' : 'flex';
  if (s === 'front')            { title.textContent = cuT('Add a product', '添加产品');     body.innerHTML = pwFrontHtml(); }
  else if (s === 'front-paste') { title.textContent = cuT('Paste your text', '粘贴文字');     body.innerHTML = pwPasteHtml(); }
  else if (s === 'front-copy')  { title.textContent = cuT('Copy one you sell', '复制已有产品'); body.innerHTML = pwCopyHtml(); pwCopyList(); }
  else if (s === 'what')        { title.textContent = cuT('What is it?', '这是什么?');       body.innerHTML = pwWhatHtml();   foot.innerHTML = pwFoot('front', 'pwNextWhat()', 'what'); }
  else if (s === 'price')       { title.textContent = cuT('Sizes & price', '规格与价格');     body.innerHTML = pwPriceHtml();  foot.innerHTML = pwFoot('what', "pwGoto('details')", 'price'); }
  else if (s === 'details')     { title.textContent = cuT('The details', '详细信息');        body.innerHTML = pwDetailsHtml(); foot.innerHTML = pwFoot('price', "pwGoto('extras')", 'details'); }
  else if (s === 'extras')      { title.textContent = cuT('Customize?', '可定制?');          body.innerHTML = pwExtrasHtml();  foot.innerHTML = pwFoot('details', "pwGoto('review')", 'extras'); }
  else if (s === 'review')      {
    title.textContent = cuT('Take a look', '看看效果'); body.innerHTML = pwReviewHtml();
    foot.innerHTML = '<button class="btn" onclick="pwGoto(\'extras\')">' + cuT('Back', '返回') + '</button>' + pwDots('review')
      + '<span style="display:flex;gap:8px;">'
      + '<button class="btn" onclick="pwFinish(false)">' + cuT('Save as draft', '存为草稿') + '</button>'
      + '<button class="btn btn-primary" onclick="pwFinish(true)">' + cuT('Publish it', '发布') + '</button></span>';
  }
}

// ── Front door ───────────────────────────────────────────────────────────────
function pwFrontHtml() {
  const cards = [
    ['scratch', 'pencil', cuT('Start from scratch', '从头开始'), cuT('A blank product. You fill it in.', '空白产品,自行填写。')],
    ['paste', 'paste', cuT('Paste what you’ve written', '粘贴已有文字'), cuT('Drop in a description — we’ll sort it into the right boxes.', '粘贴描述 — 我们帮你归类到各栏。')],
    ['copy', 'copy', cuT('Copy one you already sell', '复制已有产品'), cuT('Start from a similar product and change what’s different.', '从相似产品开始,只改不同处。')],
  ];
  return '<div class="vw-lab" style="margin-bottom:2px;">' + cuT('How do you want to add it?', '你想怎样添加?') + '</div>'
    + '<div class="vw-help" style="margin:-2px 0 12px;">' + cuT('Pick whatever’s easiest. You can change anything later.', '选最方便的方式,之后都能修改。') + '</div>'
    + '<div class="vw-doors">'
    + cards.map(c => '<button class="vw-door" onclick="pwFront(\'' + c[0] + '\')"><span class="vico">' + pwIcon(c[1], 22) + '</span>'
        + '<span class="vw-door-txt"><span class="dt">' + c[2] + '</span><span class="ds">' + c[3] + '</span></span></button>').join('')
    + '</div>';
}
function pwFront(source) {
  _pw.source = source;
  if (source === 'scratch') return pwGoto('what');
  if (source === 'paste') return pwGoto('front-paste');
  if (source === 'copy') return pwGoto('front-copy');
}
function pwPasteHtml() {
  return '<div class="vw-lab">' + cuT('Paste anything you have', '粘贴你已有的文字') + '</div>'
    + '<div class="vw-help" style="margin:-2px 0 8px;">' + cuT('A description, the back of the package, a spec sheet — we’ll pull the details out next.', '描述、包装背面、规格表都行 — 下一步我们帮你提取详情。') + '</div>'
    + '<textarea id="pw-paste" rows="7" style="width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:9px;resize:vertical;"></textarea>'
    + '<div class="pw-row-end" style="margin-top:14px;">'
    + '<button class="btn" onclick="pwGoto(\'front\')">' + cuT('Back', '返回') + '</button>'
    + '<button class="btn btn-primary" onclick="pwPasteContinue()">' + cuT('Continue', '继续') + '</button></div>';
}
function pwPasteContinue() {
  const t = (document.getElementById('pw-paste') || {}).value || '';
  if (pwPrimaryLang() === 'cn') _pw.descCn = t.trim(); else _pw.descEn = t.trim();
  pwGoto('what');
}
function pwCopyHtml() {
  return '<div class="vw-lab">' + cuT('Which product is it like?', '与哪个产品相似?') + '</div>'
    + '<input id="pw-copy-q" type="text" autocomplete="off" placeholder="' + cuT('Search by name or SKU…', '按名称或货号搜索…') + '" oninput="pwCopyList()" style="width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:9px;margin:6px 0 10px;">'
    + '<div id="pw-copy-list" class="pw-pick-list"></div>'
    + '<div class="pw-row-end" style="margin-top:12px;"><button class="btn" onclick="pwGoto(\'front\')">' + cuT('Back', '返回') + '</button></div>';
}
function pwCopyList() {
  const el = document.getElementById('pw-copy-list'); if (!el) return;
  const q = ((document.getElementById('pw-copy-q') || {}).value || '').toLowerCase().trim();
  const rows = (PA_PRODUCTS || [])
    .filter(p => !q || (p.name_en || '').toLowerCase().includes(q) || (p.name_cn || '').includes(q) || (p.sku || '').toLowerCase().includes(q))
    .slice(0, 30);
  el.innerHTML = rows.length
    ? rows.map(p => '<div class="pw-pick" onclick="pwCopyPick(' + p.id + ')">' + escapeHtml(cuT(p.name_en || p.name_cn || ('#' + p.id), p.name_cn || p.name_en || ('#' + p.id))) + (p.sku ? ' <span class="muted">· ' + escapeHtml(p.sku) + '</span>' : '') + '</div>').join('')
    : '<div class="pw-pick muted">' + cuT('No matches', '无匹配') + '</div>';
}
function pwCopyPick(id) {
  const p = (PA_PRODUCTS || []).find(x => x.id === id); if (!p) return;
  _pw.name_en = p.name_en || ''; _pw.name_cn = p.name_cn || '';
  _pw.top = p.top_category || p.category || ''; _pw.sub = p.subcategory || '';
  _pw.price = (p.sell_price != null ? p.sell_price : '');
  pwGoto('what');
}

// ── Step 1 · What it is ────────────────────────────────────────────────────────
function pwCatOptionsHtml() {
  const tree = PA_CAT_TREE || [];
  if (!tree.length) return '<option value="">' + cuT('— loading… —', '— 加载中… —') + '</option>';
  let html = '<option value="">' + cuT('— pick a category —', '— 选择分类 —') + '</option>';
  tree.forEach(t => {
    const subs = t.subs || [];
    const topVal = t.name + '|||';
    if (!subs.length) { html += '<option value="' + escapeAttr(topVal) + '"' + (_pw.top === t.name && !_pw.sub ? ' selected' : '') + '>' + escapeHtml(cuT(t.name, t.name_cn || t.name)) + '</option>'; return; }
    html += '<optgroup label="' + escapeAttr(cuT(t.name, t.name_cn || t.name)) + '">';
    html += '<option value="' + escapeAttr(topVal) + '"' + (_pw.top === t.name && !_pw.sub ? ' selected' : '') + '>' + escapeHtml(cuT('(whole category)', '(整个分类)')) + '</option>';
    subs.forEach(s => {
      const v = t.name + '|||' + s.name;
      html += '<option value="' + escapeAttr(v) + '"' + (_pw.top === t.name && _pw.sub === s.name ? ' selected' : '') + '>' + escapeHtml(cuT(s.name, s.name_cn || s.name)) + '</option>';
    });
    html += '</optgroup>';
  });
  return html;
}
function pwWhatHtml() {
  const primary = pwPrimaryLang();
  const nameMain = primary === 'cn'
    ? { lab: cuT('Name', '名称'), val: _pw.name_cn, fn: 'pwSet(\'name_cn\', this.value)', ph: '可可碎' }
    : { lab: cuT('Name', '名称'), val: _pw.name_en, fn: 'pwSet(\'name_en\', this.value)', ph: 'Cacao Nibs' };
  const nameAlt = primary === 'cn'
    ? { lab: cuT('English name (optional)', '英文名(可选)'), val: _pw.name_en, fn: 'pwSet(\'name_en\', this.value)', ph: 'Cacao Nibs' }
    : { lab: cuT('中文名 (optional)', '中文名(可选)'), val: _pw.name_cn, fn: 'pwSet(\'name_cn\', this.value)', ph: '可可碎' };
  const prefilled = (_pw.source === 'paste' || _pw.source === 'copy');
  return (prefilled ? '<div class="vw-help" style="margin:-2px 0 4px;">' + cuT('We’ve filled in what we could — just check it’s right.', '已尽量帮你填好 — 核对一下即可。') + '</div>' : '')
    + '<div class="field"><label class="vw-lab">' + nameMain.lab + '</label>'
    + '<input type="text" value="' + escapeAttr(nameMain.val) + '" placeholder="' + nameMain.ph + '" oninput="' + nameMain.fn + '" style="width:100%;box-sizing:border-box;"></div>'
    + '<div class="vw-help" style="margin:-6px 0 4px;">' + cuT('Type one language — you can add the other below.', '填一种语言即可 — 另一种可在下方补充。') + '</div>'
    + '<div class="field"><label class="vw-lab">' + nameAlt.lab + '</label>'
    + '<input type="text" value="' + escapeAttr(nameAlt.val) + '" placeholder="' + nameAlt.ph + '" oninput="' + nameAlt.fn + '" style="width:100%;box-sizing:border-box;"></div>'
    + '<div class="pw-row2">'
    + '<div class="field"><label class="vw-lab">' + cuT('Photo', '图片') + '</label>'
    + '<div style="display:flex;align-items:center;gap:12px;">'
    + '<div class="pw-photo" onclick="pwPhotoPick()" title="' + cuT('Add a photo', '添加图片') + '"' + (_pw.photo ? ' style="background-image:url(' + escapeAttr(_pw.photo) + ');background-size:cover;background-position:center;"' : '') + '>' + (_pw.photo ? '' : '＋') + '</div>'
    + '<span class="vw-help">' + cuT('A clear shot on a plain background looks best.', '干净背景的清晰照片最好。') + '</span></div></div>'
    + '<div class="field"><label class="vw-lab">' + cuT('What kind of product is it?', '属于哪类产品?') + '</label>'
    + '<select onchange="pwSetCat(this.value)" style="width:100%;box-sizing:border-box;">' + pwCatOptionsHtml() + '</select></div>'
    + '</div>'
    + '<div class="field"><label class="vw-lab">' + cuT('Product code', '产品编号') + '</label>'
    + '<input id="pw-sku-input" type="text" value="' + escapeAttr(_pw.sku) + '" placeholder="' + cuT('we’ll make one for you', '系统会自动生成') + '" oninput="pwSet(\'sku\', this.value)" style="width:100%;box-sizing:border-box;"></div>'
    + '<div class="vw-help" style="margin-top:-6px;">' + cuT('Leave it blank and we’ll create one for you, or type your own.', '留空将自动生成,也可填写自己的编号。') + '</div>';
}
function pwSet(key, val) { if (_pw) _pw[key] = val; }
function pwSetCat(v) {
  const parts = String(v || '').split('|||');
  _pw.top = parts[0] || ''; _pw.sub = parts[1] || '';
}
function pwNextWhat() {
  if (!_pw.name_en.trim() && !_pw.name_cn.trim()) { toast(cuT('Add a name first', '请先填写名称'), 'err'); return; }
  pwGoto('price');
}
function pwPhotoPick() { const f = document.getElementById('pw-photo-file'); if (f) { f.value = ''; f.click(); } }
async function pwPhotoPicked(e) {
  const file = e.target.files && e.target.files[0]; if (!file || !_pw) return;
  try {
    const out = await pdResizeImage(file, { maxLong: 1440, quality: 0.88, format: 'jpeg' });
    _pw.photo = out.dataURL; pwRender();
  } catch (err) { toast(cuT('Couldn’t read that image', '无法读取图片'), 'err'); }
}

// ── Step 2 · Sizes & price ─────────────────────────────────────────────────────
function pwPriceHtml() {
  const fork = '<div class="vw-lab">' + cuT('Does it come in more than one option?', '有多个选项吗?') + '</div>'
    + '<div class="vw-help" style="margin:-2px 0 8px;">' + cuT('Different sizes (250g / 500g) or flavors (Original / Spicy).', '不同规格(250 克 / 500 克)或口味(原味 / 香辣)。') + '</div>'
    + '<div class="pw-seg">'
    + '<button class="pw-seg-btn' + (!_pw.hasSizes ? ' on' : '') + '" onclick="pwSetSizes(false)">' + cuT('No, just one', '不,只有一种') + '</button>'
    + '<button class="pw-seg-btn' + (_pw.hasSizes ? ' on' : '') + '" onclick="pwSetSizes(true)">' + cuT('Yes, it has options', '有多个选项') + '</button></div>';
  let core;
  if (!_pw.hasSizes) {
    core = '<div class="pw-row2">'
      + '<div class="field"><label class="vw-lab">' + cuT('Price', '价格') + ' ¥</label><input type="number" min="0" step="0.01" value="' + (_pw.price === '' ? '' : _pw.price) + '" oninput="pwSet(\'price\', this.value)" style="width:100%;box-sizing:border-box;"></div>'
      + '<div class="field"><label class="vw-lab">' + cuT('In stock', '库存') + '</label><input type="number" min="0" step="1" value="' + (_pw.stock === '' ? '' : _pw.stock) + '" oninput="pwSet(\'stock\', this.value)" style="width:100%;box-sizing:border-box;"></div></div>'
      + '<label class="pw-check"><input type="checkbox"' + (_pw.compare !== '' ? ' checked' : '') + ' onchange="pwToggleSale(this.checked)"> ' + cuT('It’s on sale', '正在促销') + '</label>'
      + (_pw.compare !== '' ? '<div class="field" style="max-width:240px;"><label class="vw-lab">' + cuT('Was price', '原价') + ' ¥</label><input type="number" min="0" step="0.01" value="' + _pw.compare + '" oninput="pwSet(\'compare\', this.value)" style="width:100%;box-sizing:border-box;"><div class="vw-help">' + cuT('Shoppers see the old price crossed out.', '顾客会看到原价划线。') + '</div></div>' : '');
  } else {
    core = '<div class="vw-help" style="margin-bottom:8px;">' + cuT('Give each option a name (a size or a flavor). Weight is optional.', '为每个选项起个名字(规格或口味)。重量可选。') + '</div>'
      + '<div class="pw-vars">'
      + _pw.sizes.map((s, i) => '<div class="pw-var">'
        + '<div class="pw-var-head"><span class="pw-var-n">' + cuT('Option', '选项') + ' ' + (i + 1) + '</span>'
        + (_pw.sizes.length > 1 ? '<button type="button" class="pw-x" onclick="pwSizeRemove(' + i + ')" title="' + cuT('Remove', '移除') + '">✕</button>' : '') + '</div>'
        + '<div class="pw-row2">'
        + '<input type="text" placeholder="' + cuT('Name (English) — e.g. Spicy', '名称(英文)— 如 Spicy') + '" value="' + escapeAttr(s.name_en) + '" oninput="pwSizeField(' + i + ', \'name_en\', this.value)">'
        + '<input type="text" placeholder="' + cuT('Name (中文) — e.g. 香辣', '名称(中文)— 如 香辣') + '" value="' + escapeAttr(s.name_cn) + '" oninput="pwSizeField(' + i + ', \'name_cn\', this.value)">'
        + '</div>'
        + '<div class="pw-var-line">'
        + '<input type="text" class="pw-var-wt" placeholder="' + cuT('Weight — e.g. 250g', '重量 — 如 250克') + '" value="' + escapeAttr(s.weight) + '" oninput="pwSizeField(' + i + ', \'weight\', this.value)">'
        + '<span class="pw-size-cur">¥<input type="number" min="0" step="0.01" placeholder="' + cuT('price', '价格') + '" value="' + (s.price === '' ? '' : s.price) + '" oninput="pwSizeField(' + i + ', \'price\', this.value)"></span>'
        + '<input type="number" min="0" step="1" class="pw-var-stk" placeholder="' + cuT('stock', '库存') + '" value="' + (s.stock === '' ? '' : s.stock) + '" oninput="pwSizeField(' + i + ', \'stock\', this.value)">'
        + '</div>'
        + '</div>').join('')
      + '</div>'
      + '<button type="button" class="btn btn-sm" onclick="pwSizeAdd()">' + cuT('+ Add an option', '+ 添加选项') + '</button>';
  }
  const ship = '<div class="field" style="margin-top:14px;"><label class="vw-lab">' + cuT('Where can people get it?', '哪里可以买到?') + '</label>'
    + '<label class="pw-check"><input type="checkbox"' + (_pw.localOnly ? ' checked' : '') + ' onchange="pwSet(\'localOnly\', this.checked)"> ' + cuT('Guangzhou delivery only', '仅限广州配送') + '</label>'
    + '<div class="vw-help">' + cuT('Leave unticked to ship anywhere.', '不勾选则可寄往各地。') + '</div></div>';
  return fork + '<div style="margin-top:14px;">' + core + '</div>' + ship;
}
function pwSetSizes(on) { _pw.hasSizes = !!on; pwRender(); }
function pwToggleSale(on) { _pw.compare = on ? (_pw.compare || '0') : ''; pwRender(); }
function pwSizeField(i, key, val) { if (_pw.sizes[i]) _pw.sizes[i][key] = val; }
function pwSizeAdd() { _pw.sizes.push({ name_en: '', name_cn: '', weight: '', price: '', stock: '' }); pwRender(); }
function pwSizeRemove(i) { _pw.sizes.splice(i, 1); if (!_pw.sizes.length) _pw.sizes.push({ name_en: '', name_cn: '', weight: '', price: '', stock: '' }); pwRender(); }

// ── Step 3 · Details ───────────────────────────────────────────────────────────
function pwDetailsHtml() {
  const primary = pwPrimaryLang();
  // Two separate boxes — one per language — so English and 中文 never end up
  // glued together in one field (the shop shows them apart). Mirrors the
  // product editor's ENGLISH / 中文 description panes. Fill one or both.
  const taStyle = 'width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:9px;resize:vertical;';
  let html = '<div class="vw-lab">' + cuT('Describe it (or paste anything)', '描述一下(或粘贴任意文字)') + '</div>'
    + '<div class="vw-help" style="margin:-2px 0 8px;">' + cuT('Keep the languages apart: English in the left box, 中文 in the right. Fill just one if that’s all you have. Then “Pull the details” fills the boxes below.', '请分开填写:左边英文,右边中文。只有一种也行。然后点「从中提取详情」自动填好下方。') + '</div>'
    + '<div class="pw-row2">'
    + '<div class="field"><label class="vw-lab">English</label>'
    + '<textarea id="pw-desc-en" rows="4" oninput="pwSetDescLang(\'en\', this.value)" style="' + taStyle + '">' + escapeHtml(_pw.descEn) + '</textarea></div>'
    + '<div class="field"><label class="vw-lab">中文</label>'
    + '<textarea id="pw-desc-cn" rows="4" oninput="pwSetDescLang(\'cn\', this.value)" style="' + taStyle + '">' + escapeHtml(_pw.descCn) + '</textarea></div>'
    + '</div>'
    + '<div style="margin:8px 0 14px;"><button type="button" class="btn btn-sm" onclick="pwPullFacts()">' + cuT('Pull the details from this', '从中提取详情') + '</button></div>';
  if (!_pw.hasSizes) {
    html += '<div class="field" style="max-width:240px;"><label class="vw-lab">' + cuT('Net weight', '净含量') + '</label><input type="text" placeholder="e.g. 200g" value="' + escapeAttr(_pw.weight) + '" oninput="pwSet(\'weight\', this.value)" style="width:100%;box-sizing:border-box;"></div>';
  }
  html += PW_FACTS.map(([col, en, cn, ph]) => {
    const k = col + '_' + primary;
    return '<div class="field"><label class="vw-lab">' + cuT(en, cn) + '</label><input type="text" placeholder="' + ph + '" value="' + escapeAttr(_pw.facts[k] || '') + '" oninput="pwSetFact(\'' + k + '\', this.value)" style="width:100%;box-sizing:border-box;"></div>';
  }).join('');
  html += '<div class="field"><label class="vw-lab">' + cuT('Free from anything? (optional)', '不含什么?(可选)') + '</label>'
    + '<div class="pw-chips">' + PW_FREE_OF.map(([id, en, cn]) => '<label class="pw-chip"><input type="checkbox"' + (_pw.freeOf[id] ? ' checked' : '') + ' onchange="pwToggleFreeOf(\'' + id + '\', this.checked)"> ' + cuT(en, cn) + '</label>').join('') + '</div>'
    + '<div class="vw-help">' + cuT('This is your promise to shoppers, so make sure it’s true.', '这是对顾客的承诺,请确保属实。') + '</div></div>';
  return html;
}
function pwSetDescLang(lang, v) { if (lang === 'cn') _pw.descCn = v; else _pw.descEn = v; }
function pwSetFact(k, v) { _pw.facts[k] = v; }
function pwToggleFreeOf(id, on) { _pw.freeOf[id] = !!on; }
async function pwPullFacts() {
  // Send whichever boxes are filled — the endpoint reads both and fills the
  // English + Chinese value for every fact it finds (translating when one side
  // is blank), so a single-language paste still backfills both languages.
  const textEn = (_pw.descEn || '').trim();
  const textCn = (_pw.descCn || '').trim();
  if (!textEn && !textCn) { toast(cuT('Write or paste some text first', '请先填写或粘贴文字'), 'err'); return; }
  toast(cuT('Reading your text…', '正在识别…'));
  try {
    const r = await fetch('/api/retail-admin/ai/extract-facts', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text_en: textEn, text_cn: textCn }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 503) { toast(cuT('AI is not set up yet — fill the boxes by hand', 'AI 尚未配置,请手动填写'), 'err'); return; }
    if (!r.ok || !j.success) { toast(cuT('Couldn’t read the details — fill by hand', '识别失败,请手动填写'), 'err'); return; }
    const facts = (j.data && j.data.facts) || {};
    if (!Object.keys(facts).length) { toast(cuT('No details found in the text', '未找到详情'), 'err'); return; }
    Object.assign(_pw.facts, facts);
    pwRender();
    toast(cuT('Filled in the details — review & tweak', '已填充详情,请核对'), 'ok');
  } catch (e) { toast(cuT('Couldn’t read the details', '识别失败'), 'err'); }
}

// ── Customize? · options + paid extras ─────────────────────────────────────────
function pwExtrasHtml() {
  let html = '<div class="vw-lab">' + cuT('Do customers get to pick anything?', '顾客可以自由选择吗?') + '</div>'
    + '<div class="vw-help" style="margin:-2px 0 8px;">' + cuT('For example: choosing a dressing, or paying a bit more for extra toppings.', '例如:选择酱料,或加点钱添加配料。') + '</div>';
  html += '<div class="pw-opts">' + _pw.options.map((o, oi) => pwOptBlock(o, oi)).join('') + '</div>';
  html += '<div class="pw-row" style="margin-top:10px;gap:8px;">'
    + '<button type="button" class="btn btn-sm" onclick="pwAddFree()">' + cuT('+ A free pick', '+ 免费选择') + '</button>'
    + '<button type="button" class="btn btn-sm" onclick="pwAddPaid()">' + cuT('+ A paid extra', '+ 付费加项') + '</button></div>';
  if (!_pw.options.length) html += '<div class="vw-help" style="margin-top:6px;">' + cuT('Nothing to pick? Just tap Next.', '无需选择?直接点下一步。') + '</div>';
  return html;
}
function pwOptBlock(o, oi) {
  const paid = o.type === 'multi';
  const head = '<div class="pw-opt-head"><span class="pw-opt-tag">' + (paid ? cuT('Paid extra', '付费加项') : cuT('Free pick', '免费选择')) + '</span>'
    + '<button type="button" class="pw-x" onclick="pwOptRemove(' + oi + ')" title="' + cuT('Remove', '移除') + '">✕</button></div>';
  const primary = pwPrimaryLang();
  const qKey = primary === 'cn' ? 'question_cn' : 'question_en';
  const q = '<input type="text" class="pw-opt-q" placeholder="' + (paid ? cuT('What can they add? e.g. Add extras', '可添加什么?如:添加加项') : cuT('What are they picking? e.g. Choose your dressing', '让顾客选什么?如:选择酱料')) + '" value="' + escapeAttr(o[qKey] || '') + '" oninput="pwOptQ(' + oi + ', \'' + qKey + '\', this.value)">';
  const choices = o.choices.map((c, ci) => pwChoiceRow(o, oi, c, ci)).join('');
  const addLbl = paid ? cuT('+ Add an extra', '+ 添加加项') : cuT('+ Add another', '+ 添加选项');
  const req = paid ? '' : '<label class="pw-check"><input type="checkbox"' + (o.is_required ? ' checked' : '') + ' onchange="pwOptReq(' + oi + ', this.checked)"> ' + cuT('They have to pick one before they can buy', '购买前必须选择') + '</label>';
  return '<div class="pw-opt">' + head + q + '<div class="pw-choices">' + choices + '</div><button type="button" class="btn btn-sm pw-addc" onclick="pwAddChoice(' + oi + ')">' + addLbl + '</button>' + req + '</div>';
}
function pwChoiceRow(o, oi, c, ci) {
  const paid = o.type === 'multi';
  const primary = pwPrimaryLang();
  const labKey = primary === 'cn' ? 'label_cn' : 'label_en';
  const def = !paid
    ? '<input type="radio" name="pw-def-' + oi + '" title="' + cuT('Show one as the usual pick', '设为默认选项') + '"' + (c.is_default ? ' checked' : '') + ' onchange="pwOptDefault(' + oi + ', ' + ci + ')">'
    : '<span class="pw-radio-spacer"></span>';
  const lab = '<input type="text" class="pw-clab" placeholder="' + (paid ? cuT('e.g. Extra pickles', '如 加酸黄瓜') : cuT('e.g. Ranch', '如 牧场酱')) + '" value="' + escapeAttr(c[labKey] || '') + '" oninput="pwOptC(' + oi + ', ' + ci + ', \'' + labKey + '\', this.value)">';
  const price = paid ? '<span class="pw-cur">+¥<input type="number" min="0" step="0.01" value="' + (c.price_delta || 0) + '" oninput="pwOptC(' + oi + ', ' + ci + ', \'price_delta\', this.value)"></span>' : '';
  let link = '';
  if (paid) {
    if (c.stock_product_id) {
      link = '<span class="pw-link on">🔗 ' + escapeHtml(c.addon_name || ('#' + c.stock_product_id)) + '<button type="button" class="pw-x" onclick="pwUnlink(' + oi + ', ' + ci + ')" title="' + cuT('Unlink', '取消关联') + '">✕</button></span>';
    } else {
      link = '<button type="button" class="btn btn-sm pw-link-btn" onclick="pwLinkPick(' + oi + ', ' + ci + ')" title="' + cuT('Use a product’s stock', '使用某商品库存') + '">' + cuT('+ Stock', '+ 库存') + '</button>';
    }
  }
  const picking = _pw.pick && _pw.pick.oi === oi && _pw.pick.ci === ci;
  const picker = picking ? '<div class="pw-linkpick"><input id="pw-link-q" type="text" placeholder="' + cuT('Search a product for stock…', '搜索作为库存的商品…') + '" oninput="pwLinkList()"><div id="pw-link-list" class="pw-pick-list"></div></div>' : '';
  return '<div class="pw-choice">' + def + lab + price + link + '<button type="button" class="pw-x" onclick="pwChoiceRemove(' + oi + ', ' + ci + ')" title="' + cuT('Remove', '移除') + '">✕</button></div>' + picker;
}
function pwAddFree() { _pw.options.push({ type: 'single', question_en: '', question_cn: '', is_required: 0, choices: [{ label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null, addon_name: '' }] }); pwRender(); }
function pwAddPaid() { _pw.options.push({ type: 'multi', question_en: '', question_cn: '', is_required: 0, choices: [{ label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null, addon_name: '' }] }); pwRender(); }
function pwOptRemove(oi) { _pw.options.splice(oi, 1); if (_pw.pick && _pw.pick.oi === oi) _pw.pick = null; pwRender(); }
function pwOptQ(oi, key, val) { if (_pw.options[oi]) _pw.options[oi][key] = val; }
function pwOptReq(oi, on) { if (_pw.options[oi]) _pw.options[oi].is_required = on ? 1 : 0; }
function pwOptC(oi, ci, key, val) { const c = _pw.options[oi] && _pw.options[oi].choices[ci]; if (!c) return; c[key] = key === 'price_delta' ? (parseFloat(val) || 0) : val; }
function pwOptDefault(oi, ci) { const o = _pw.options[oi]; if (!o) return; o.choices.forEach((c, i) => { c.is_default = i === ci ? 1 : 0; }); }
function pwAddChoice(oi) { const o = _pw.options[oi]; if (!o) return; o.choices.push({ label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null, addon_name: '' }); pwRender(); }
function pwChoiceRemove(oi, ci) { const o = _pw.options[oi]; if (!o) return; o.choices.splice(ci, 1); if (!o.choices.length) o.choices.push({ label_en: '', label_cn: '', price_delta: 0, is_default: 0, stock_product_id: null, addon_name: '' }); pwRender(); }
function pwLinkPick(oi, ci) { _pw.pick = { oi, ci }; pwRender(); }
function pwUnlink(oi, ci) { const c = _pw.options[oi] && _pw.options[oi].choices[ci]; if (c) { c.stock_product_id = null; c.addon_name = ''; } pwRender(); }
function pwLinkList() {
  const el = document.getElementById('pw-link-list'); if (!el) return;
  const q = ((document.getElementById('pw-link-q') || {}).value || '').toLowerCase().trim();
  const rows = (PA_PRODUCTS || []).filter(p => !p.is_bundle)
    .filter(p => !q || (p.name_en || '').toLowerCase().includes(q) || (p.name_cn || '').includes(q) || (p.sku || '').toLowerCase().includes(q))
    .slice(0, 24);
  el.innerHTML = rows.length
    ? rows.map(p => '<div class="pw-pick" onclick="pwLinkChoose(' + p.id + ')">' + escapeHtml(cuT(p.name_en || p.name_cn || ('#' + p.id), p.name_cn || p.name_en || ('#' + p.id))) + '</div>').join('')
    : '<div class="pw-pick muted">' + cuT('No matches', '无匹配') + '</div>';
}
function pwLinkChoose(id) {
  if (!_pw.pick) return;
  const p = (PA_PRODUCTS || []).find(x => x.id === id);
  const c = _pw.options[_pw.pick.oi] && _pw.options[_pw.pick.oi].choices[_pw.pick.ci];
  if (c) { c.stock_product_id = id; c.addon_name = p ? (cuT(p.name_en || p.name_cn, p.name_cn || p.name_en) || ('#' + id)) : ('#' + id); }
  _pw.pick = null; pwRender();
}

// ── Step 4 · Review ────────────────────────────────────────────────────────────
function pwReviewHtml() {
  const name = cuT(_pw.name_en || _pw.name_cn || '—', _pw.name_cn || _pw.name_en || '—');
  const priceTxt = _pw.hasSizes
    ? _pw.sizes.filter(s => s.name_en || s.name_cn || s.price !== '').map(s => {
      const nm = cuT(s.name_en || s.name_cn || '—', s.name_cn || s.name_en || '—');
      return escapeHtml(nm + (s.weight ? ' (' + s.weight + ')' : '')) + ' ¥' + (s.price || '?');
    }).join(' · ')
    : ('¥' + (_pw.price || '?') + (_pw.compare !== '' ? ' <span class="muted" style="text-decoration:line-through;">¥' + _pw.compare + '</span>' : ''));
  const cat = _pw.sub ? (_pw.top + ' › ' + _pw.sub) : (_pw.top || cuT('No category yet', '尚未分类'));
  const factCount = Object.values(_pw.facts).filter(v => (v || '').trim()).length;
  const freeOf = PW_FREE_OF.filter(([id]) => _pw.freeOf[id]).map(([, en, cn]) => cuT(en, cn));
  const lines = [];
  lines.push(['Name', '名称', escapeHtml(name)]);
  lines.push(['Category', '分类', escapeHtml(cat)]);
  lines.push(['Price', '价格', priceTxt]);
  if (factCount) lines.push(['Details', '详情', factCount + ' ' + cuT('filled in', '项已填')]);
  if (freeOf.length) lines.push(['Free of', '不含', freeOf.join(', ')]);
  _pw.options.forEach(o => {
    const paid = o.type === 'multi';
    const q = (pwPrimaryLang() === 'cn' ? o.question_cn : o.question_en) || (paid ? cuT('Extras', '加项') : cuT('Pick', '选择'));
    const items = o.choices.filter(c => c.label_en || c.label_cn).map(c => (pwPrimaryLang() === 'cn' ? c.label_cn : c.label_en) + (paid && c.price_delta ? ' +¥' + c.price_delta : '')).join(', ');
    lines.push([paid ? 'They can add' : 'They can pick', paid ? '可添加' : '可选择', escapeHtml(q + (items ? ' — ' + items : ''))]);
  });
  const photo = _pw.photo ? '<div class="pw-rev-photo" style="background-image:url(' + escapeAttr(_pw.photo) + ')"></div>' : '<div class="pw-rev-photo pw-rev-photo-empty">🛍</div>';
  const warn = [];
  if (!_pw.photo) warn.push(cuT('No photo yet', '尚无图片'));
  if (!_pw.top) warn.push(cuT('No category yet', '尚未分类'));
  if (!_pw.hasSizes && (_pw.price === '' || _pw.price == null)) warn.push(cuT('No price yet', '尚无价格'));
  return '<div class="pw-review">'
    + photo
    + '<div class="pw-rev-rows">' + lines.map(l => '<div class="pw-rev-row"><span class="pw-rev-k">' + cuT(l[0], l[1]) + '</span><span class="pw-rev-v">' + l[2] + '</span></div>').join('') + '</div>'
    + '</div>'
    + (warn.length ? '<div class="pw-warn">⚠ ' + warn.join(' · ') + '<div class="vw-help" style="margin-top:2px;">' + cuT('No rush — you can finish these later.', '不急 — 之后可补充。') + '</div></div>' : '')
    + '<label class="pw-check" style="margin-top:12px;"><input type="checkbox"' + (_pw.designed ? ' checked' : '') + ' onchange="pwSet(\'designed\', this.checked)"> ' + cuT('Build the nice designed page from my description', '根据描述生成精美页面') + '</label>'
    + '<div class="vw-help" style="margin-top:2px;">' + cuT('Needs a description on the last step. You can always design it later in the editor.', '需要上一步的描述。也可稍后在编辑器中设计。') + '</div>'
    + '<div class="vw-help" style="margin-top:10px;">' + cuT('Nothing goes live until you tap Publish.', '点「发布」前不会上架。') + '</div>';
}

// ── Create ─────────────────────────────────────────────────────────────────────
function pwFreeOfStr() { return PW_FREE_OF.filter(([id]) => _pw.freeOf[id]).map(([id]) => id).join(', '); }
function pwFactsObj() { const o = {}; Object.keys(_pw.facts).forEach(k => { const v = (_pw.facts[k] || '').trim(); if (v) o[k] = v; }); return o; }
function pwOptionsBody() {
  return _pw.options.map(o => {
    const type = o.type === 'multi' ? 'multi' : 'single';
    const choices = o.choices.map(c => ({ label_en: (c.label_en || '').trim(), label_cn: (c.label_cn || '').trim(), price_delta: Number(c.price_delta) || 0, is_default: c.is_default ? 1 : 0, stock_product_id: c.stock_product_id || null }))
      .filter(c => c.label_en || c.label_cn);
    // People fill the choice rows but often leave the question header blank —
    // especially on paid extras. Don't drop a real pick over a missing title;
    // give it a sensible default so it actually saves.
    let qEn = (o.question_en || '').trim();
    let qCn = (o.question_cn || '').trim();
    if (choices.length && !qEn && !qCn) {
      qEn = type === 'multi' ? 'Add extras' : 'Choose one';
      qCn = type === 'multi' ? '添加加项' : '请选择';
    }
    return { question_en: qEn, question_cn: qCn, type, is_required: o.is_required ? 1 : 0, choices };
  }).filter(o => (o.question_en || o.question_cn) && o.choices.length);
}
async function pwPrimaryStore(id) {
  try {
    const r = await fetch('/api/retail-admin/products/' + id + '/variant-store-stocks', { credentials: 'same-origin' });
    const j = await r.json(); const d = j && j.success && j.data;
    if (d && Array.isArray(d.stores) && d.stores.length) return d.stores[0].store_id;
  } catch (e) {}
  return null;
}
async function pwWriteStock(storeId, productId, qty) {
  const q = Math.max(0, parseInt(qty, 10) || 0);
  try {
    await fetch('/api/retail-admin/stores/' + storeId + '/stock/' + productId, {
      method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ physical_qty: q }),
    });
  } catch (e) {}
}
async function pwFinish(publish) {
  if (!_pw || _pw.busy) return;
  if (!_pw.name_en.trim() && !_pw.name_cn.trim()) { toast(cuT('Add a name first', '请先填写名称'), 'err'); pwGoto('what'); return; }
  _pw.busy = true;
  const foot = document.getElementById('pw-foot'); if (foot) foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
  toast(cuT('Creating your product…', '正在创建产品…'));
  // Capture what we need before pwClose() nulls _pw.
  const firstSize = _pw.hasSizes ? _pw.sizes[0] : null;
  const wantDesign = _pw.designed && !!(_pw.descEn.trim() || _pw.descCn.trim());
  const dEn = _pw.descEn, dCn = _pw.descCn;
  const extraSizes = _pw.hasSizes ? _pw.sizes.slice(1).filter(s => s.name_en || s.name_cn || s.weight || s.price !== '') : [];
  const baseStock = _pw.hasSizes ? (firstSize ? firstSize.stock : '') : _pw.stock;
  try {
    const price = _pw.hasSizes ? (firstSize ? firstSize.price : '') : _pw.price;
    const body = {
      name_en: _pw.name_en.trim(), name_cn: _pw.name_cn.trim(),
      top_category: _pw.top, subcategory: _pw.sub,
      weight: _pw.hasSizes ? (firstSize ? (firstSize.weight || '') : '') : (_pw.weight || ''),
      ...(String(price).trim() !== '' ? { sell_price: parseFloat(price) || 0 } : {}),
      compare_at_price: _pw.hasSizes ? 0 : (parseFloat(_pw.compare) || 0),
      free_of: pwFreeOfStr(), product_facts: pwFactsObj(), options: pwOptionsBody(),
      ship_modes: _pw.localOnly ? 'local' : 'air,land',
      description_en: dEn || '', description_cn: dCn || '', description_format: 'rich',
      is_published: publish ? 1 : 0,
    };
    if (_pw.sku && _pw.sku.trim()) body.sku = _pw.sku.trim();
    if (_pw.photo) body.images = [_pw.photo];
    const j = await api('/api/retail-admin/products', { method: 'POST', body });
    const created = j.data; const newId = created && created.id;
    if (!newId) throw new Error('create_failed');
    if (Array.isArray(PA_PRODUCTS)) PA_PRODUCTS.unshift(created);

    // Opening stock → the first store (best-effort; brand-new product starts at 0).
    const storeId = await pwPrimaryStore(newId);
    if (storeId != null && String(baseStock).trim() !== '') await pwWriteStock(storeId, newId, baseStock);

    // Extra sizes → clone as variants, set price/label, group them (best-effort).
    if (extraSizes.length) {
      try {
        const members = [{ id: newId, label: (firstSize && firstSize.name_en) || '', label_cn: (firstSize && firstSize.name_cn) || '' }];
        for (const sz of extraSizes) {
          const dup = await api('/api/retail-admin/products/' + newId + '/duplicate', { method: 'POST', body: { as_variant: true, label: sz.name_en || '' } });
          const vid = dup.data && dup.data.id; if (!vid) continue;
          if (Array.isArray(PA_PRODUCTS)) PA_PRODUCTS.unshift(dup.data);
          // duplicate always lands as a draft (is_published=0) — match the
          // parent so a published product's other options go live too, not just
          // the first one. Otherwise the extra options stay hidden/"unchecked".
          const vbody = { weight: sz.weight || '', compare_at_price: 0, is_published: publish ? 1 : 0 };
          if (String(sz.price).trim() !== '') vbody.sell_price = parseFloat(sz.price) || 0;
          await api('/api/retail-admin/products/' + vid, { method: 'PATCH', body: vbody });
          members.push({ id: vid, label: sz.name_en || '', label_cn: sz.name_cn || '' });
          if (storeId != null && String(sz.stock).trim() !== '') await pwWriteStock(storeId, vid, sz.stock);
        }
        await api('/api/retail-admin/products/' + newId + '/variants', { method: 'PUT', body: { members } });
      } catch (e) { toast(cuT('Product made — check its sizes in the editor', '产品已创建 — 请在编辑器中检查规格'), 'err'); }
    }

    try { await paLoad(); } catch (e) { try { paRender(); } catch (_) {} }
    toast(publish ? cuT('Published! Opening it for any tweaks…', '已发布!正在打开以便微调…') : cuT('Saved as draft! Opening it…', '已存为草稿!正在打开…'), 'ok');
    pwClose();
    try { pdOpen(newId); } catch (e) {}

    // Designed page — compose once the editor DOM holds the description (best-effort).
    if (wantDesign) {
      setTimeout(async () => {
        try {
          const en = document.getElementById('pd-rte-en'), cn = document.getElementById('pd-rte-cn');
          if (en && dEn && !pdRteClean(en.innerHTML)) en.innerHTML = dEn;
          if (cn && dCn && !pdRteClean(cn.innerHTML)) cn.innerHTML = dCn;
          await pdAutoComposeBlocks(newId, null, true);
        } catch (e) {}
      }, 500);
    }
  } catch (e) {
    toast(cuT('Could not create the product: ', '创建失败:') + (e && e.message || e), 'err');
    if (foot) foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
    if (_pw) _pw.busy = false;
  }
}

