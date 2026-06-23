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
function paLowThreshold(p) {
  const t = p && p.low_stock_threshold;
  return (t == null || t === '' || !(Number(t) >= 0)) ? PA_LOW_STOCK : Number(t);
}
// Push the current global default into the products-page UI: the toolbar input,
// the Low-stock KPI subtitle, and the editor field's placeholder.
function paSyncLowStockUi() {
  const inp = document.getElementById('pa-low-threshold');
  if (inp && document.activeElement !== inp) inp.value = PA_LOW_STOCK;
  const sub = document.getElementById('pa-kpi-low-sub');
  if (sub) sub.textContent = '≤ ' + PA_LOW_STOCK + ' left · 剩余 ≤ ' + PA_LOW_STOCK;
  const ls = document.getElementById('pd-low-stock');
  if (ls) ls.placeholder = cuT('Default', '默认') + ' ' + PA_LOW_STOCK;
}
// Persist the store-wide default low-stock threshold and re-flag the catalogue.
async function paSaveLowThreshold(val) {
  const n = Math.max(0, parseInt(val, 10) || 0);
  PA_LOW_STOCK = n;
  paSyncLowStockUi();
  const st = document.getElementById('pa-low-threshold-status');
  if (st) st.textContent = cuT('Saving…', '保存中…');
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'inventory.lowStockThreshold': n } });
    if (_cfgCache) { _cfgCache.inventory = _cfgCache.inventory || {}; _cfgCache.inventory.lowStockThreshold = n; }
    if (st) st.textContent = cuT('Saved ✓', '已保存 ✓');
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
  } catch (e) {
    if (st) st.textContent = cuT('Save failed', '保存失败');
  }
  paRenderKpis(false);
  paRender();
}
// Product layout: 'grid' (rich cards) | 'compact' (denser) | 'list' (one row
// each). Separate from the "View" display-tweaks popover; persisted per-browser.
let PA_VIEW = (() => { try { const v = localStorage.getItem('pa-view'); return (v === 'grid' || v === 'compact' || v === 'list') ? v : 'list'; } catch { return 'list'; } })();
function paSetView(v) {
  // Docked editor locks the list to the split layout — ignore grid/compact taps.
  if (_paEditorOpen && v !== 'list') return;
  PA_VIEW = (v === 'compact' || v === 'list') ? v : 'grid';
  try { localStorage.setItem('pa-view', PA_VIEW); } catch {}
  PA_PAGE = 1;
  paRender();
}

// Quick status filter driven by the catalogue-health KPI tiles. One of
// 'all' | 'live' | 'oos' | 'low' | 'drafts'. Clicking a tile toggles its
// filter (click again to clear), narrowing the grid to that status —
// independent of the search box and category filter, which still stack on top.
let PA_STATUS = 'all';
function paSetStatus(v) {
  PA_STATUS = (PA_STATUS === v) ? 'all' : v;   // click the active tile to clear
  PA_PAGE = 1;
  paRender();
}
// Stock to judge OOS / Low against, honouring the "Stock for" switcher: when a
// single store is selected (and its per-store map has loaded) use that store's
// own count, otherwise the combined effective_stock (legacy stock_qty as a last
// resort). Keeps the KPI tiles, quick-filter and grid OOS badge all answering
// the same question — "out of stock *where I'm looking*" — so picking Tianhe +
// Out of stock lists items zero in Tianhe even if they're stocked elsewhere.
function _paStockOf(p) {
  if (PA_STORE !== 'all' && PA_STOCK_LOADED) return _paStoreQty(p.id, PA_STORE);
  return Number(p.effective_stock ?? p.stock_qty ?? 0);
}

// Does a product match the active status filter? Mirrors paRenderKpis' buckets.
function _paStatusMatch(p) {
  if (PA_STATUS === 'all') return true;
  const pub = p.is_published === 1;
  const s = _paStockOf(p);
  switch (PA_STATUS) {
    case 'live':   return pub;
    case 'drafts': return !pub;
    case 'oos':    return pub && s <= 0;
    case 'low':    return pub && s > 0 && s <= paLowThreshold(p);
    default:       return true;
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

// Block schema. Adding a new block type requires:
//   1) An entry here (label + factory for empty data)
//   2) Editor HTML branch in paRenderSelectedEditor()
//   3) Empty-check in paBlocksCollect()
//   4) Renderer in miniapp/components/product-blocks/*
// Block-type registry — full Roots PDP v1 system. Visual rendering lives
// in miniapp/components/product-blocks/* — keep this list in lock-step.
const PA_BLOCK_TYPES = [
  {
    type: 'spec_strip', glyph: '📋',
    label_en: '📋 Spec Strip — three meta facts',
    label_cn: '📋 规格条 — 三项基础信息',
    name_en: 'Spec Strip', name_cn: '规格条',
    make: () => ({ cells: [
      { k_en: 'Type',   k_cn: '类型', v_en: '', v_cn: '' },
      { k_en: 'Net Wt', k_cn: '净重', v_en: '', v_cn: '' },
      { k_en: 'Origin', k_cn: '产地', v_en: '', v_cn: '' },
    ] }),
  },
  {
    type: 'hero_intro', glyph: '📖',
    label_en: '📖 Hero Intro — editorial paragraph + pull-out phrase',
    label_cn: '📖 开篇引言 — 大段编辑文字 + 点睛短句',
    name_en: 'Hero Intro', name_cn: '开篇引言',
    make: () => ({ kicker_en: '', kicker_cn: '', body_en: '', body_cn: '', highlight_en: '', highlight_cn: '' }),
  },
  {
    type: 'why', glyph: '✓',
    label_en: '✓ Why People Choose It — 3-5 numbered claims',
    label_cn: '✓ 为什么选它 — 3-5 条编号短句',
    name_en: 'Why People Choose It', name_cn: '为什么选它',
    make: () => ({ rows: [ { claim_en: '', claim_cn: '' }, { claim_en: '', claim_cn: '' }, { claim_en: '', claim_cn: '' } ] }),
  },
  {
    type: 'ingredients_chips', glyph: '🌿',
    label_en: '🌿 Ingredients · Chip Cloud — pills with optional % + hero',
    label_cn: '🌿 配料 · 云标签 — 圆角标签,可选百分比/主料',
    name_en: 'Ingredients · Chips', name_cn: '配料 · 云标签',
    make: () => ({ items: [ { name_en: '', name_cn: '', pct: '', lead: false } ] }),
  },
  {
    type: 'ingredients_line', glyph: '🌱',
    label_en: '🌱 Ingredients · Editorial Line — typographic run',
    label_cn: '🌱 配料 · 编辑式排版 — 大字一行体',
    name_en: 'Ingredients · Line', name_cn: '配料 · 编辑式',
    make: () => ({ items: [ { name_en: '', name_cn: '', pct: '', lead: false } ] }),
  },
  {
    type: 'allergen_card', glyph: '⚠️',
    label_en: '⚠️ Allergen Card — Contains / May contain',
    label_cn: '⚠️ 过敏原卡 — 含有 / 可能含有微量',
    name_en: 'Allergen Card', name_cn: '过敏原卡',
    make: () => ({ contains_en: '', contains_cn: '', may_contain_en: '', may_contain_cn: '' }),
  },
  {
    type: 'how_to_use', glyph: '🍽',
    label_en: '🍽 How To Use Grid — 6 or 8 usage moments',
    label_cn: '🍽 用法宫格 — 6 或 8 种用法',
    name_en: 'How To Use', name_cn: '用法宫格',
    make: () => ({ tiles: Array.from({ length: 6 }, () => (
      { icon: '', label_en: '', label_cn: '', sub_en: '', sub_cn: '' }
    )) }),
  },
  {
    type: 'storage_box', glyph: '❄',
    label_en: '❄ Storage Box — two paired condition cards + note',
    label_cn: '❄ 储存条件 — 双卡片 + 备注',
    name_en: 'Storage Box', name_cn: '储存条件',
    make: () => ({
      left:  { icon: '🌡', head_en: 'Unopened',      head_cn: '未开封', num_en: 'Cool & dry',  num_cn: '阴凉干燥', unit_en: 'Store away from heat and moisture',                    unit_cn: '远离高温和潮湿',           alt: false },
      right: { icon: '❄', head_en: 'After opening', head_cn: '开封后', num_en: 'Refrigerate', num_cn: '冷藏',     unit_en: 'Stir well, seal tightly, refrigerate for best texture', unit_cn: '搅拌均匀，密封冷藏以保持最佳口感', alt: true  },
      note_en: 'Natural oil separation may occur — this is normal. Stir before each use.',
      note_cn: '天然油脂分离属正常现象,每次使用前请搅拌。',
    }),
  },
  {
    type: 'notes_callout', glyph: '✱',
    label_en: '✱ Notes Callout — italic fine-print band',
    label_cn: '✱ 备注说明 — 斜体小字提示',
    name_en: 'Notes Callout', name_cn: '备注说明',
    make: () => ({ text_en: '', text_cn: '' }),
  },
  {
    type: 'big_stat', glyph: '✨',
    label_en: '✨ Big Stat — one huge number on a brand slab',
    label_cn: '✨ 大数字 — 醒目数字 + 短宣言',
    name_en: 'Big Stat', name_cn: '大数字',
    // bg: lime / carrot / pink / corn / sky / lotus / papaya
    make: () => ({ stat: '', what_en: '', what_cn: '', claim_en: '', claim_cn: '', bg: 'lime' }),
  },
  {
    type: 'pull_quote', glyph: '❝',
    label_en: '❝ Pull Quote — editorial sourcing note',
    label_cn: '❝ 引文 — 编辑式产地/来源短语',
    name_en: 'Pull Quote', name_cn: '引文',
    make: () => ({ text_en: '', text_cn: '', who_en: '', who_cn: '' }),
  },
];

// ─── IP characters — Roots-brand line-art mascots used in the colophon.
// The mini-app auto-picks a character by product category if none is
// set; the office can override per product in the modal. Keep in sync
// with the files in miniapp/assets/brand/ + public/brand/.
const PA_IP_CHARACTERS = [
  { key: 'soilsoul',       label: 'Soil & Soul' },
  { key: 'skater',         label: 'Skater'      },
  { key: 'kombucha-gang',  label: 'Kombucha'    },
  { key: 'flex',           label: 'Flex'        },
  { key: 'radishes',       label: 'Radishes'    },
  { key: 'mushroom',       label: 'Mushroom'    },
  { key: 'peas',           label: 'Peas'        },
  { key: 'onion',          label: 'Onion'       },
  { key: 'broccoli',       label: 'Broccoli'    },
  { key: 'hula',           label: 'Hula'        },
];

// ─── Page presets — preset block recipes that mirror the two reference
// products from the v1 design (Green Chili Dip · Hazel Chocolate Spread).
// One click pre-fills a coherent block stack so the office doesn't have
// to assemble the same scaffolding for every new product. After applying,
// every block is still individually editable.
//
// Adding a new preset = one entry below. `blocks` is an array of
// `{ type, ...data }` — same shape stored in description_blocks.
// Each preset = a STRUCTURE recipe (block types, order, row counts) with
// every content field empty. Office fills the words per product. Default
// cell labels (Type / Net Wt / Origin) and storage icons (❄ / 📅 / 🌡)
// remain because they're part of the visual contract — easy to change
// per product if needed but useful starting prompts.
const PA_PAGE_PRESETS = [
  {
    id: 'editorial_light',
    label_en: 'Editorial Light — Green Chili Dip layout',
    label_cn: '清淡编辑风 — 青辣椒酱版式',
    desc_en: 'Spec · story · why × 3 · chip-cloud ingredients · 6-tile how-to · storage · allergen · notes',
    desc_cn: '规格 · 故事 · 3 条理由 · 配料云标签 · 6 用法 · 储存 · 过敏原 · 备注',
    blocks: [
      { type: 'spec_strip', cells: [
        { k_en: 'Type',   k_cn: '类型', v_en: '', v_cn: '' },
        { k_en: 'Net Wt', k_cn: '净重', v_en: '', v_cn: '' },
        { k_en: 'Origin', k_cn: '产地', v_en: '', v_cn: '' },
      ] },
      { type: 'hero_intro', kicker_en: '', kicker_cn: '', body_en: '', body_cn: '', highlight_en: '', highlight_cn: '' },
      { type: 'why', rows: [
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
      ] },
      { type: 'ingredients_chips', items: [
        { name_en: '', name_cn: '', pct: '', lead: true  },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
      ] },
      { type: 'how_to_use', tiles: Array.from({ length: 6 }, () => (
        { icon: '', label_en: '', label_cn: '', sub_en: '', sub_cn: '' }
      )) },
      { type: 'storage_box',
        left:  { icon: '🌡', head_en: 'Unopened',      head_cn: '未开封', num_en: 'Cool & dry',  num_cn: '阴凉干燥', unit_en: 'Store away from heat and moisture',                    unit_cn: '远离高温和潮湿',           alt: false },
        right: { icon: '❄', head_en: 'After opening', head_cn: '开封后', num_en: 'Refrigerate', num_cn: '冷藏',     unit_en: 'Stir well, seal tightly, refrigerate for best texture', unit_cn: '搅拌均匀，密封冷藏以保持最佳口感', alt: true  },
        note_en: 'Natural oil separation may occur — this is normal. Stir before each use.',
        note_cn: '天然油脂分离属正常现象,每次使用前请搅拌。' },
      { type: 'allergen_card', contains_en: '', contains_cn: '', may_contain_en: '', may_contain_cn: '' },
      { type: 'notes_callout', text_en: '', text_cn: '' },
    ],
  },
  {
    id: 'editorial_bold',
    label_en: 'Editorial Bold — Hazel Chocolate Spread layout',
    label_cn: '醒目编辑风 — 榛子巧克力酱版式',
    desc_en: 'Spec · story · big stat · why × 5 · editorial-line ingredients · pull quote · 8-tile how-to · storage · allergen · notes',
    desc_cn: '规格 · 故事 · 大数字 · 5 条理由 · 配料编辑式 · 引文 · 8 用法 · 储存 · 过敏原 · 备注',
    blocks: [
      { type: 'spec_strip', cells: [
        { k_en: 'Type',   k_cn: '类型', v_en: '', v_cn: '' },
        { k_en: 'Net Wt', k_cn: '净重', v_en: '', v_cn: '' },
        { k_en: 'Origin', k_cn: '产地', v_en: '', v_cn: '' },
      ] },
      { type: 'hero_intro', kicker_en: '', kicker_cn: '', body_en: '', body_cn: '', highlight_en: '', highlight_cn: '' },
      { type: 'big_stat', stat: '', what_en: '', what_cn: '', claim_en: '', claim_cn: '', bg: 'lime' },
      { type: 'why', rows: [
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
        { claim_en: '', claim_cn: '' },
      ] },
      { type: 'ingredients_line', items: [
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
        { name_en: '', name_cn: '', pct: '', lead: false },
      ] },
      { type: 'pull_quote', text_en: '', text_cn: '', who_en: '', who_cn: '' },
      { type: 'how_to_use', tiles: Array.from({ length: 8 }, () => (
        { icon: '', label_en: '', label_cn: '', sub_en: '', sub_cn: '' }
      )) },
      { type: 'storage_box',
        left:  { icon: '🌡', head_en: 'Unopened',      head_cn: '未开封', num_en: 'Cool & dry',  num_cn: '阴凉干燥', unit_en: 'Store away from heat and moisture',                    unit_cn: '远离高温和潮湿',           alt: false },
        right: { icon: '❄', head_en: 'After opening', head_cn: '开封后', num_en: 'Refrigerate', num_cn: '冷藏',     unit_en: 'Stir well, seal tightly, refrigerate for best texture', unit_cn: '搅拌均匀，密封冷藏以保持最佳口感', alt: true  },
        note_en: 'Natural oil separation may occur — this is normal. Stir before each use.', note_cn: '天然油脂分离属正常现象,每次使用前请搅拌。' },
      { type: 'allergen_card', contains_en: '', contains_cn: '', may_contain_en: '', may_contain_cn: '' },
      { type: 'notes_callout', text_en: '', text_cn: '' },
    ],
  },
];

document.querySelector('[data-tab="products"]').addEventListener('click', () => {
  if (!PA_LOADED) { PA_LOADED = true; paLoad(); }
});

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
    });
    PA_STOCK_LOADED = true;
    // A remembered store that no longer exists falls back to "All".
    if (PA_STORE !== 'all' && !PA_STORES.some(s => s.id === PA_STORE)) PA_STORE = 'all';
    paRenderStoreSeg();
    paRender();   // stock cells now know per-store counts
  } catch (e) {
    PA_STOCK_LOADED = false;   // leave the column on the read-only combined total
  }
}

// Switcher bar: "STORE  [All · 全部 | Tianhe | Yuexiu]". Only meaningful with 2+
// stores — a single-store tenant just sees the plain total, so hide it.
function paRenderStoreSeg() {
  const bar = document.getElementById('pa-store-seg');
  if (!bar) return;
  // Only the overview table (list view, editor closed) has an editable Stock
  // column — hide the switcher everywhere else so it can't imply it does nothing.
  const overview = PA_VIEW === 'list' && !_paEditorOpen;
  if (CATALOG_MODE === 'upstream' || PA_STORES.length < 2 || !overview) { bar.style.display = 'none'; return; }
  const btn = (key, label) =>
    `<button type="button" class="pa-store-btn${PA_STORE === key ? ' active' : ''}" onclick="paSetStore(${key === 'all' ? "'all'" : key})">${label}</button>`;
  const btns = [btn('all', cuT('All', '全部'))]
    .concat(PA_STORES.map(s => btn(s.id, escapeHtml(cuT(s.name_en || s.code, s.name_cn || s.name_en || s.code)))))
    .join('');
  const hint = PA_STORE === 'all'
    ? cuT('Combined stock across all stores — pick a store to edit its counts.',
          '所有门店库存合计 — 选择某门店即可编辑该店库存。')
    : cuT('Editing this store’s stock. Variant families show the store total — open them to set each size.',
          '正在编辑该门店库存。多规格产品显示门店合计 — 打开后可分别设置各规格。');
  bar.innerHTML =
    `<span class="pa-store-lbl">${cuT('Stock for', '库存门店')}</span>` +
    `<span class="pa-store-btns">${btns}</span>` +
    `<span class="pa-store-hint">${hint}</span>`;
  bar.style.display = 'flex';
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
  paFillSubFilter();   // keep the dependent subcategory select in sync
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

// Status pills (Designed/Plain + Draft) — used by the List view rows.
function _paPills(p) {
  const designed = _paHasBlocks(p);
  const pub = p.is_published === 1;
  return `${designed
      ? `<span class="pa-pill pa-pill-designed" title="Designer sections authored · 已配置设计板块">${PA_ICON_SPARKLE}Designed</span>`
      : `<span class="pa-pill pa-pill-plain" title="No designer sections yet · 尚未配置设计板块">Plain</span>`}
    ${pub ? '' : '<span class="pa-pill pa-pill-draft" title="Not published in mini-app · 未在小程序上架">Draft</span>'}`;
}

// Overview table status cell — just the Draft pill. The Designed/Plain "has page
// design" marker is deliberately omitted here: this list is for scanning stock /
// price / category, and the design state lives in the editor + grid views.
function _paDraftPill(p) {
  return p.is_published === 1
    ? ''
    : '<span class="pa-pill pa-pill-draft" title="Not published in mini-app · 未在小程序上架">Draft</span>';
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
    alert(cuT('Could not update availability — ', '无法更新上架状态 — ') + (e.message || e));
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
function _paPriceCell(u) {
  const pr = _paUnitPrices(u);
  if (!pr) return '<span class="pa-col-price pa-col-muted">—</span>';
  const body = pr.min === pr.max ? `¥${fmt(pr.min)}` : `¥${fmt(pr.min)}–${fmt(pr.max)}`;
  return `<span class="pa-col-price">${body}</span>`;
}
// Stock badge: green = healthy, brass = low (≤5), red = out (0). The number is
// the family's effective stock; an unpublished product still shows its count.
// When a single store is picked in the switcher the cell shows THAT store's
// count — an editable input for a lone product, a read-only total for a variant
// family (each size has its own count, set by opening the product).
function _paStockCell(u) {
  if (PA_STORE !== 'all' && PA_STOCK_LOADED) {
    if (u.group) {
      const q = u.members.reduce((s, m) => s + _paStoreQty(m.id, PA_STORE), 0);
      const c = q <= 0 ? 'is-out' : (q <= paLowThreshold(u.p) ? 'is-low' : '');
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

// ── Products View tweaks (per-operator) — photo crop / status display / empty.
const PROD_VIEW_DEFAULTS = { crop: 'square', status: 'badge', empty: 'icon' };
function pvLoad() {
  try { return { ...PROD_VIEW_DEFAULTS, ...(JSON.parse(localStorage.getItem('retail-admin-prod-view') || '{}')) }; }
  catch (e) { return { ...PROD_VIEW_DEFAULTS }; }
}
let PROD_VIEW = pvLoad();
function pvApply() {
  const sec = document.getElementById('tab-products'); if (!sec) return;
  sec.classList.remove('pv-crop-portrait', 'pv-crop-full', 'pv-status-border', 'pv-status-minimal', 'pv-empty-hatched', 'pv-empty-plain');
  if (PROD_VIEW.crop === 'portrait')  sec.classList.add('pv-crop-portrait');
  if (PROD_VIEW.crop === 'full')      sec.classList.add('pv-crop-full');
  if (PROD_VIEW.status === 'border')  sec.classList.add('pv-status-border');
  if (PROD_VIEW.status === 'minimal') sec.classList.add('pv-status-minimal');
  if (PROD_VIEW.empty === 'hatched')  sec.classList.add('pv-empty-hatched');
  if (PROD_VIEW.empty === 'plain')    sec.classList.add('pv-empty-plain');
  pvSyncPanel();
}
function pvSet(key, val) {
  PROD_VIEW[key] = val;
  try { localStorage.setItem('retail-admin-prod-view', JSON.stringify(PROD_VIEW)); } catch (e) {}
  pvApply();
}
function pvSyncPanel() {
  const pop = document.getElementById('pv-pop'); if (!pop) return;
  pop.querySelectorAll('.ovp-seg').forEach(seg => {
    const key = seg.getAttribute('data-pv');
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-v') === PROD_VIEW[key]));
  });
}
function pvToggle() { const pop = document.getElementById('pv-pop'); if (!pop) return; if (pop.hidden) { pop.hidden = false; pvSyncPanel(); setTimeout(() => document.addEventListener('mousedown', pvOutside), 0); } else pvClose(); }
function pvClose() { const pop = document.getElementById('pv-pop'); if (pop) pop.hidden = true; document.removeEventListener('mousedown', pvOutside); }
function pvOutside(e) { if (!(e.target.closest && e.target.closest('.ovp-wrap'))) pvClose(); }

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
      const s = eff(p);
      if (s <= 0) oos++;
      else if (s <= paLowThreshold(p)) low++;
    } else {
      drafts++;
    }
  }
  const set = (id, n) => {
    const el = document.getElementById(id); if (!el) return;
    if (animate) dashCountUp(el, n); else el.textContent = fcNum(n);
  };
  set('pa-kpi-live', live);
  set('pa-kpi-oos', oos);
  set('pa-kpi-low', low);
  set('pa-kpi-drafts', drafts);
  const oosTile = document.getElementById('pa-kpi-oos-tile'); if (oosTile) oosTile.classList.toggle('alert', oos > 0);
  const lowTile = document.getElementById('pa-kpi-low-tile'); if (lowTile) lowTile.classList.toggle('alert', low > 0);
  // Light up whichever tile drives the active quick-filter (none when 'all').
  const tiles = { live: 'pa-kpi-live-tile', oos: 'pa-kpi-oos-tile', low: 'pa-kpi-low-tile', drafts: 'pa-kpi-drafts-tile' };
  for (const [status, id] of Object.entries(tiles)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('pa-kpi-on', PA_STATUS === status);
  }
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

// Bulk bar — two modes, both shown only in the full-width overview (editor
// closed). Default: bulk publish/hide of everything matching the current filter
// (search + category + status) plus a "Select" button. Select mode: tick
// specific products, then apply one change (shop on/off, markets, fresh batches,
// shipping) to just the ticked set. All reuse the per-product PATCH.
function paRenderBulkBar() {
  const bar = document.getElementById('pa-bulkbar');
  if (!bar) return;
  const overview = PA_VIEW === 'list' && !_paEditorOpen;
  const idset = new Set(PA_FILTERED_IDS || []);
  const shown = overview ? (PA_PRODUCTS || []).filter(p => idset.has(p.id)) : [];
  if (!shown.length) { bar.style.display = 'none'; bar.innerHTML = ''; PA_SELECT_MODE = false; PA_SELECTED = new Set(); return; }
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 var(--s3);padding:8px 12px;border:1px solid var(--line-soft);border-radius:10px;background:var(--bg-app);font-family:var(--f-sans);font-size:12px;';

  if (PA_SELECT_MODE) {
    const n = PA_SELECTED.size;
    const visN = PA_VISIBLE_MEMBER_IDS.length;
    const allVis = visN && PA_VISIBLE_MEMBER_IDS.every(id => PA_SELECTED.has(id));
    const grp = (lbl, btns) => `<span class="pa-bulk-grp"><span class="pa-bulk-lbl">${lbl}</span>${btns}</span>`;
    const b = (txt, fn) => `<button type="button" class="btn btn-sm" ${n ? '' : 'disabled'} onclick="${fn}">${txt}</button>`;
    bar.innerHTML =
      `<span class="muted">${cuT(n + ' selected', '已选 ' + n + ' 件')}</span>` +
      `<button type="button" class="btn btn-sm" onclick="paSelectAllVisible(${allVis ? 'false' : 'true'})">${allVis ? cuT('Clear page', '清空本页') : cuT('Select all ' + visN, '全选 ' + visN)}</button>` +
      (n ? `<button type="button" class="btn btn-sm" onclick="paClearSelection()">${cuT('Clear', '清除')}</button>` : '') +
      `<span style="margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">` +
        grp(cuT('Shop', '上架'), b(cuT('On', '上架'), "paBulkApply({is_published:1}, 'shop-on')") + b(cuT('Off', '下架'), "paBulkApply({is_published:0}, 'shop-off')")) +
        `<span class="pa-bulk-sep"></span>` +
        grp(cuT('Markets', '市集'), b(cuT('Yes', '是'), "paBulkApply({is_market:1}, 'mkt-on')") + b(cuT('No', '否'), "paBulkApply({is_market:0}, 'mkt-off')")) +
        `<span class="pa-bulk-sep"></span>` +
        grp(cuT('Fresh batch', '现做'), b(cuT('Yes', '是'), "paBulkApply({is_batch_made:1}, 'batch-on')") + b(cuT('No', '否'), "paBulkApply({is_batch_made:0}, 'batch-off')")) +
        `<span class="pa-bulk-sep"></span>` +
        grp(cuT('Shipping', '配送'), b(cuT('Air + Land', '空运+陆运'), "paBulkApply({ship_modes:'air,land'}, 'ship')") + b(cuT('Air only', '仅空运'), "paBulkApply({ship_modes:'air'}, 'ship')") + b(cuT('Land only', '仅陆运'), "paBulkApply({ship_modes:'land'}, 'ship')")) +
        `<span class="pa-bulk-sep"></span>` +
        grp(cuT('Badge', '标签'),
          b(cuT('None', '无'),  "paBulkApply({tags:''}, 'badge-none')") +
          b(cuT('Auto', '自动'), "paBulkApply({tags:'auto'}, 'badge-auto')") +
          b('NEW',  "paBulkApply({tags:'new'}, 'badge-new')") +
          b('POP',  "paBulkApply({tags:'pop'}, 'badge-pop')") +
          b('SALE', "paBulkApply({tags:'sale'}, 'badge-sale')") +
          b('HOT',  "paBulkApply({tags:'hot'}, 'badge-hot')")) +
        `<span class="pa-bulk-sep"></span>` +
        `<button type="button" class="btn btn-sm" ${n ? '' : 'disabled'} onclick="paBulkDelete()" style="color:var(--danger,#c0392b);">${cuT('Delete', '删除')}</button>` +
        `<span class="pa-bulk-sep"></span>` +
        `<button type="button" class="btn btn-sm" onclick="paSetSelectMode(false)">${cuT('Done', '完成')}</button>` +
      `</span>`;
    return;
  }

  bar.innerHTML =
    `<span class="muted">${cuT(shown.length + ' shown', '显示 ' + shown.length + ' 件')}</span>` +
    `<span style="margin-left:auto;display:flex;gap:8px;">` +
      `<button type="button" class="btn btn-sm" onclick="paSetSelectMode(true)">${cuT('Bulk', '批量')}</button>` +
    `</span>`;
}
// Enter/leave select mode. Leaving drops the tick set. Re-renders the list so
// the checkbox column slides in/out and the bar swaps.
function paSetSelectMode(on) {
  PA_SELECT_MODE = !!on;
  if (!PA_SELECT_MODE) PA_SELECTED = new Set();
  paRender();
}
function paClearSelection() { PA_SELECTED = new Set(); paRender(); }
// Toggle one unit (csv of member ids). All-in → remove all; otherwise add all,
// so a half-selected group flips fully on.
function paToggleSelect(ids) {
  const list = String(ids).split(',').map(Number).filter(Boolean);
  const allIn = list.length && list.every(id => PA_SELECTED.has(id));
  list.forEach(id => allIn ? PA_SELECTED.delete(id) : PA_SELECTED.add(id));
  paRender();
}
function paSelectAllVisible(on) {
  PA_VISIBLE_MEMBER_IDS.forEach(id => on ? PA_SELECTED.add(id) : PA_SELECTED.delete(id));
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
  if (!confirm(cuT(what + ' — ' + ids.length + ' product(s)?', what + ' — ' + ids.length + ' 件商品?'))) return;
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
  if (!confirm(cuT('Delete ' + ids.length + ' product(s)? This removes them from the catalogue and frees their SKUs. This cannot be undone.',
                   '删除 ' + ids.length + ' 件商品?将从商品库移除并释放其 SKU。此操作无法撤销。'))) return;
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
async function paBulkSetPublished(want) {
  const idset = new Set(PA_FILTERED_IDS || []);
  const targets = (PA_PRODUCTS || []).filter(p => idset.has(p.id) && (p.is_published === 1 ? 1 : 0) !== want).map(p => p.id);
  if (!targets.length) return;
  const ask = want
    ? cuT('Publish ' + targets.length + ' product(s)? They will go live in the shop.', '确定上架 ' + targets.length + ' 件商品?它们将在店面显示。')
    : cuT('Hide ' + targets.length + ' product(s)? They will be removed from the shop.', '确定下架 ' + targets.length + ' 件商品?它们将从店面移除。');
  if (!confirm(ask)) return;
  toast(cuT('Working…', '处理中…'));
  let done = 0, fail = 0;
  for (const id of targets) {
    try {
      const r = await fetch('/api/retail-admin/products/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_published: want }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.success !== false) done++; else fail++;
    } catch (e) { fail++; }
  }
  toast(fail
    ? cuT(done + ' done, ' + fail + ' failed', done + ' 成功,' + fail + ' 失败')
    : cuT((want ? 'Published ' : 'Hidden ') + done + ' ✓', '已处理 ' + done + ' 件 ✓'), fail ? 'err' : 'ok');
  await paLoad();
}
let PA_ORDERED_UNIT_IDS = [];
function paRender() {
  const grid   = document.getElementById('pa-grid');
  const empty  = document.getElementById('pa-empty');
  const count  = document.getElementById('pa-count');
  const q      = (document.getElementById('pa-search').value || '').toLowerCase().trim();
  const filter = document.getElementById('pa-filter').value;

  paRenderKpis(false);   // keep the health strip in sync (no re-animation)
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

  // Reflect the active layout in the toolbar segmented control. While the editor
  // is docked the list is locked to the split layout, so the grid/compact buttons
  // are disabled (only re-enabled once the editor closes).
  document.querySelectorAll('#pa-view-seg .pa-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === PA_VIEW);
    const lockable = b.dataset.view !== 'list';
    b.disabled = _paEditorOpen && lockable;
  });

  // Sync the split-view container with the chosen layout: list = split (editor
  // docked on the right), grid/compact = list-only (catalogue scan, full width).
  // Expand-mode (.pa-split-editonly) is independent — only toggled from the
  // editor's ⤢ button — and wins over listonly when both apply.
  const _paSplit = document.getElementById('pa-split');
  if (_paSplit && !_paSplit.classList.contains('pa-split-editonly')) {
    // Full width whenever the editor is closed — grid/compact scan AND the new
    // list-view "overview" table both span the page. Opening a product (or "+
    // Add product" from any view) docks the editor and splits the row.
    _paSplit.classList.toggle('pa-split-listonly', !_paEditorOpen);
  }

  if (PA_VIEW === 'list') {
    // Overview = full-width landing table (nothing open) with rich columns for
    // scanning the catalogue; Docked = narrow list beside the editor, kept to a
    // compact name + pills row so it fits the 380px pane.
    const overview = !_paEditorOpen;
    grid.className = (overview ? 'pa-list pa-list-rich' : 'pa-list') + (reorderActive ? ' pa-reorder' : '') + ((overview && PA_SELECT_MODE) ? ' pa-selecting' : '');
    // Snapshot the on-screen unit order as lists of product ids (a variant group
    // moves as one block). paRowDrop reads this to compute the new sequence.
    PA_REORDER_UNITS = reorderActive
      ? pageUnits.map(u => u.group ? u.members.map(m => m.id) : [u.p.id])
      : null;
    const grip = reorderActive ? '<span></span>' : '';
    const allVisSel = PA_VISIBLE_MEMBER_IDS.length && PA_VISIBLE_MEMBER_IDS.every(id => PA_SELECTED.has(id));
    const selHead = PA_SELECT_MODE ? `<span class="pa-selbox"><input type="checkbox" ${allVisSel ? 'checked' : ''} onclick="paSelectAllVisible(this.checked)" title="${cuT('Select all on this page', '全选本页')}"></span>` : '';
    const head = (overview && pageUnits.length) ? `
      <div class="pa-rowhead"${PA_SELECT_MODE ? '' : ' aria-hidden="true"'}>
        ${selHead}${grip}<span></span>
        <span>${cuT('Product', '产品')}</span>
        <span>${cuT('Category', '分类')}</span>
        <span>SKU</span>
        <span>${(PA_STORE !== 'all' && PA_STOCK_LOADED) ? escapeHtml(cuT('Stock · ', '库存 · ') + _paStoreName(PA_STORE)) : cuT('Stock', '库存')}</span>
        <span class="pa-col-price">${cuT('Price', '价格')}</span>
        <span class="pa-col-shop">${cuT('Shop', '上架')}</span>
      </div>` : '';
    grid.innerHTML = head + pageUnits.map((u, ui) => {
      const p = u.p;
      const img  = p.image_data || p.image_url || '';
      if (overview) {
        const sku = u.group
          ? `${u.members.length} ${cuT('sizes', '规格')}`
          : escapeHtml(p.sku || '—');
        const gripCell = reorderActive
          ? `<span class="pa-grip" draggable="true" title="${cuT('Drag to reorder', '拖动排序')}" onclick="event.stopPropagation()" ondragstart="paRowDragStart(event, ${ui})" ondragend="paRowDragEnd()">${PA_ICON_GRIP}</span>`
          : '';
        const rowDrag = reorderActive
          ? ` ondragover="paRowDragOver(event, ${ui})" ondragleave="paRowDragLeave(event)" ondrop="paRowDrop(event, ${ui})"`
          : '';
        const memberIds = (u.group ? u.members.map(m => m.id) : [p.id]).join(',');
        const selRow = PA_SELECT_MODE && memberIds.split(',').every(id => PA_SELECTED.has(Number(id)));
        const selCell = PA_SELECT_MODE
          ? `<span class="pa-selbox"><input type="checkbox" tabindex="-1" aria-hidden="true" ${selRow ? 'checked' : ''}></span>`
          : '';
        const rowClick = PA_SELECT_MODE ? `paToggleSelect('${memberIds}')` : `paOpenEdit(${p.id})`;
        return `
        <div class="pa-row${selRow ? ' is-sel' : ''}" onclick="${rowClick}"${rowDrag}>
          ${selCell}${gripCell}
          <div class="pa-row-img">${img ? `<img src="${escapeAttr(img)}" loading="lazy" alt="">` : PA_ICON_BROKEN}</div>
          <div class="pa-row-main" data-no-i18n>
            <div class="pa-row-name">${escapeHtml(p.name_en || '—')}</div>
            ${p.name_cn ? `<div class="pa-row-sub">${escapeHtml(p.name_cn)}</div>` : ''}
          </div>
          <div class="pa-col-cat">${_paCatCell(u)}</div>
          <div class="pa-col-sku">${sku}</div>
          <div class="pa-col-stock">${_paStockCell(u)}</div>
          ${_paPriceCell(u)}
          <div class="pa-row-pills">${_paShopToggle(u)}</div>
        </div>`;
      }
      const meta = u.group
        ? `${u.members.length} ${cuT('sizes', '规格')}`
        : (p.sku ? escapeHtml(p.sku) : '');
      const sub  = [
        p.name_cn ? escapeHtml(p.name_cn) : '',
        meta ? `<span class="pa-row-meta">${meta}</span>` : '',
      ].filter(Boolean).join(' · ');
      return `
        <div class="pa-row" onclick="paOpenEdit(${p.id})">
          <div class="pa-row-img">${img ? `<img src="${escapeAttr(img)}" loading="lazy" alt="">` : PA_ICON_BROKEN}</div>
          <div class="pa-row-main" data-no-i18n>
            <div class="pa-row-name">${escapeHtml(p.name_en || '—')}</div>
            ${sub ? `<div class="pa-row-sub">${sub}</div>` : ''}
          </div>
          <div class="pa-row-pills">${_paPills(p)}</div>
          <button class="pa-dup-row" type="button" title="Duplicate · 复制" onclick="event.stopPropagation(); paDuplicate(${p.id})">⧉</button>
        </div>`;
    }).join('');
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
            ${p.is_bundle ? `<span class="pa-pill pa-pill-bundle" title="Bundle — sold as one, made of other products · 套装产品">${cuT('Bundle', '套装')}</span>` : ''}
            ${designed
              ? `<span class="pa-pill pa-pill-designed" title="Designer sections authored · 已配置设计板块">${PA_ICON_SPARKLE}Designed</span>`
              : `<span class="pa-pill pa-pill-plain" title="No designer sections yet · 尚未配置设计板块">Plain</span>`}
            ${pub ? '' : '<span class="pa-pill pa-pill-draft" title="Not published in mini-app · 未在小程序上架">Draft</span>'}
          </div>
        </div>
        <div class="pa-card-body" data-no-i18n>
          <div class="pa-card-name">${escapeHtml(p.name_en || '—')}</div>
          ${p.name_cn ? `<div class="pa-card-sub">${escapeHtml(p.name_cn)}</div>` : ''}
          ${meta ? `<div class="pa-card-meta">${meta}</div>` : ''}
          <div class="pa-card-shop">${_paShopToggle(u)}<span class="pa-card-shop-lbl">${pub ? cuT('On shop', '已上架') : cuT('Off shop', '未上架')}</span></div>
        </div>
      </div>`;
  }).join('');
  pvApply();   // re-assert per-operator View tweaks after each grid render
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
  if (id == null) { box.className = 'muted'; box.textContent = cuT('Set stock after saving', '保存后设置库存'); return; }
  box.className = '';
  box.textContent = '…';
  // NOTE: use cuT() for language, NOT the raw `_lang` global — `_lang` is scoped
  // inside the i18n module closure and is NOT visible here.
  fetch('/api/retail-admin/products/' + id + '/variant-store-stocks', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(j => {
      const d = j && j.success && j.data;
      if (!d || !Array.isArray(d.stores) || !d.stores.length || !Array.isArray(d.variants) || !d.variants.length) {
        box.className = 'muted'; box.textContent = cuT('No stock info yet', '暂无库存信息'); return;
      }
      box.className = '';
      PD_STOCK_DATA = d;
      pdRenderStockMatrix(box, d);
      pdSyncVariantTotals(d);
    })
    .catch(() => { box.className = 'muted'; box.textContent = cuT('Couldn’t load stock', '无法加载库存'); });
}
// Build the grid: rows = variants, columns = stores, + a live row total. The
// variant currently open above is flagged with ● so it's obvious which row the
// rest of the form edits.
function pdRenderStockMatrix(box, d) {
  const stores = d.stores, variants = d.variants, qty = d.qty || {};
  const multi = variants.length > 1;
  const head = '<tr><th class="vh">' + (multi ? cuT('Variant', '规格') : '') + '</th>' +
    stores.map(s => '<th>' + escapeHtml(cuT(s.name_en || s.code, s.name_cn || s.name_en) || s.code) + '</th>').join('') +
    '<th class="mtot">' + cuT('Total', '合计') + '</th></tr>';
  const body = variants.map(v => {
    const cells = stores.map(s => {
      const q = (qty[v.id] && qty[v.id][s.store_id]) || 0;
      return '<td><input type="number" min="0" step="1" value="' + q + '" data-orig="' + q + '" ' +
        'data-variant-id="' + v.id + '" data-store-id="' + s.store_id + '" oninput="pdMatrixRecalc(this)" onblur="pdMatrixCellSave(this)"></td>';
    }).join('');
    const tot = stores.reduce((a, s) => a + ((qty[v.id] && qty[v.id][s.store_id]) || 0), 0);
    // With a single variant the product name is redundant (it's the one being
    // edited, shown at the top) — leave the row label blank. With several, show
    // each variant's label + a ● on the one currently open above.
    const name = !multi ? '' : (escapeHtml(_vaMatrixLabel(v)) +
      (v.self ? ' <span class="va-self" title="' + cuT('The variant open above', '上方打开的规格') + '">●</span>' : ''));
    return '<tr data-variant-id="' + v.id + '"><th class="vh"' + (multi ? ' title="' + escapeAttr(_vaMatrixLabel(v)) + '"' : '') + '>' + name + '</th>' + cells +
      '<td class="mtot" data-tot="' + v.id + '">' + tot + '</td></tr>';
  }).join('');
  box.innerHTML =
    '<table class="pd-stock-matrix">' + head + body + '</table>' +
    '<div style="margin-top:8px;"><span id="pd-store-stocks-msg" class="muted" style="font-size:12px;"></span></div>';
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
}
async function pdSaveStoreStocks() {
  const box = document.getElementById('pd-store-stocks');
  if (!box) return;
  const msg = document.getElementById('pd-store-stocks-msg');
  const inputs = Array.from(box.querySelectorAll('input[data-store-id]'));
  const changed = inputs.filter(i => String(i.value) !== String(i.dataset.orig));
  if (!changed.length) { if (msg) msg.textContent = 'No changes · 无改动'; return; }
  const btn = document.getElementById('pd-store-stocks-save');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = cuT('Saving…', '保存中…');
  let fail = 0;
  for (const inp of changed) {
    const qty = Math.max(0, parseInt(inp.value, 10) || 0);
    const pid = inp.dataset.variantId;
    try {
      const r = await fetch('/api/retail-admin/stores/' + inp.dataset.storeId + '/stock/' + pid, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ physical_qty: qty, reason: 'manual' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.success !== false) { inp.value = qty; inp.dataset.orig = String(qty); _paStockMirror(pid, inp.dataset.storeId, qty); }
      else { fail++; }
    } catch (e) { fail++; }
  }
  if (btn) btn.disabled = false;
  if (fail) { toast('Some stock updates failed · 部分库存更新失败', 'err'); if (msg) msg.textContent = ''; }
  else { toast('Stock updated · 库存已更新'); if (msg) msg.textContent = 'Saved · 已保存'; }
  // Recompute per-variant totals from the live cells and mirror to the table.
  const totals = {};
  inputs.forEach(i => { const v = i.dataset.variantId; totals[v] = (totals[v] || 0) + Math.max(0, parseInt(i.value, 10) || 0); });
  VA_STORE_TOTALS = totals;
  (VA_MEMBERS || []).forEach(m => { if (totals[m.id] != null) m.stock = totals[m.id]; });
  if (document.getElementById('pd-variants') && VA_ID != null) vaRender();
}
// "Save & next" — flush the current product's autosave, then open the next one
// in the on-screen list order (flipping pages if needed). Built for clearing a
// big draft backlog without round-tripping through the list each time.
async function pdSaveNext() {
  const ids = PA_ORDERED_UNIT_IDS || [];
  const idx = _pdSelectedId == null ? -1 : ids.indexOf(_pdSelectedId);
  if (idx < 0) { toast(cuT('Open a product first', '请先打开一个产品'), 'err'); return; }
  if (idx >= ids.length - 1) { toast(cuT('That was the last product', '已是最后一个产品'), 'ok'); return; }
  const nextId = ids[idx + 1];
  const btn = document.getElementById('pd-savenext-btn');
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  try { await pdAutoSaveNow(); } catch (e) {}
  if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  // Editor is open here, so pages are the fixed docked size (18), not the
  // overview "Per page" choice — keep the page math in lock-step with paRender.
  PA_PAGE = Math.floor((idx + 1) / PA_DOCK_PAGE_SIZE) + 1;
  pdOpen(nextId);
}
function pdOpen(id) {
  const p = id != null ? (PA_PRODUCTS || []).find(x => x.id === id) : null;
  const set = (el, v) => { const n = document.getElementById(el); if (n) n.value = (v == null ? '' : v); };
  document.getElementById('pd-id').value = p ? p.id : '';
  document.getElementById('pd-title').textContent = p ? (p.name_en || p.name_cn || 'Product · 产品') : 'New product · 新增产品';
  set('pd-name-en', p && p.name_en); set('pd-name-cn', p && p.name_cn);
  set('pd-price', p ? p.sell_price : ''); set('pd-compare', p && p.compare_at_price);
  set('pd-sku', p && p.sku); set('pd-weight', p && p.size);
  set('pd-status', p ? (p.status || 'Active') : 'Active');
  set('pd-low-stock', p && p.low_stock_threshold != null ? p.low_stock_threshold : '');
  { const ls = document.getElementById('pd-low-stock'); if (ls) ls.placeholder = cuT('Default', '默认') + ' ' + PA_LOW_STOCK; }
  pdFreeOfSet(p && p.free_of); set('pd-notes', p && p.notes); pdFactsSet(p && p.product_facts);
  const ck = (el, v) => { const n = document.getElementById(el); if (n) n.checked = !!v; };
  ck('pd-is-market', p && p.is_market === 1); ck('pd-is-batch-made', p && p.is_batch_made === 1); ck('pd-is-restock-only', p && p.is_restock_only === 1);
  ck('pd-ship-from-supplier', p && p.ship_from_supplier === 1);
  // Out-of-stock policy. Show the effective value: a blank policy on a legacy
  // batch meal reads as "backorder outside GZ" (and persists explicitly on save).
  { const os = document.getElementById('pd-oos-policy');
    if (os) os.value = (p && p.oos_policy) || (p && p.is_batch_made === 1 ? 'backorder_gz' : 'strict'); }
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
  // Show the docked editor, hide the empty-state placeholder, and mark which
  // row in the list is currently loaded so the operator never loses their place.
  _pdSelectedId = p ? p.id : null;
  pdShowDocked();
  paApplyRowSelection();
  // Autosave: reset the engine for the freshly-loaded product and capture the
  // "as-opened" baseline (updated again once async images arrive) so Revert can
  // roll the whole session back.
  pdWireAutosave();
  clearTimeout(_pdAutoTimer); _pdSaving = false; _pdPendingResave = false;
  _pdOpenBaseline = pdSnapshot();
  pdSetStatus(p ? 'saved' : 'hint', p ? cuT('All changes saved', '已自动保存') : cuT('Add a name & SKU to start autosaving', '填写名称和货号后自动保存'));
}
// Docked editor visibility — pdShowDocked reveals the editor in the right
// column; pdClose hides it back to the empty-state placeholder.
// Also ensures the right pane is visible — pdOpen can be called from "+ Add
// product" or from duplicate while the operator is in grid/compact scan mode
// (where listonly hides the editor); reveal it so the new product isn't
// invisible behind the catalogue.
function pdShowDocked() {
  const empty = document.getElementById('pd-empty');
  const ed    = document.getElementById('pd-editor');
  const split = document.getElementById('pa-split');
  _paEditorOpen = true;
  if (split) split.classList.remove('pa-split-listonly');
  if (empty) empty.style.display = 'none';
  if (ed)    ed.style.display = '';
  // The docked list pages by 18 while the overview pages by 50/100/200/All, so
  // the product just clicked from a long overview page may fall on a different
  // 18-row page. Jump to the page that holds it (using the full ordered unit
  // list from the prior render) so its row stays visible beside the editor.
  if (_pdSelectedId != null) {
    const idx = PA_ORDERED_UNIT_IDS.indexOf(_pdSelectedId);
    if (idx >= 0) PA_PAGE = Math.floor(idx / PA_DOCK_PAGE_SIZE) + 1;
  }
  // Repaint the list into its compact docked form (it shares the row with the
  // now-visible editor) before measuring the editor's position for the scroll.
  paRender();
  // With the whole page scrolling (no internal editor scroll), picking a
  // product low in a long list would render the editor above the fold. Bring
  // its top just under the sticky header (98px) — but only if it's meaningfully
  // out of view, so clicking through items near the top doesn't jump around.
  if (ed) {
    const targetY = Math.max(0, window.scrollY + ed.getBoundingClientRect().top - 110);
    if (Math.abs(targetY - window.scrollY) > 40) window.scrollTo({ top: targetY, behavior: 'smooth' });
  }
}
function pdClose() {
  // Deselect — the editor returns to the empty-state placeholder. (Closing the
  // editor doesn't close the page; the list stays put.)
  _pdSelectedId = null;
  _paEditorOpen = false;
  const empty = document.getElementById('pd-empty');
  const ed    = document.getElementById('pd-editor');
  if (ed)    ed.style.display = 'none';
  if (empty) empty.style.display = '';
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
function pdRevert() {
  if (_pdSelectedId == null) { pdClose(); return; }
  if (!confirm(cuT('Revert to the last-saved version? This undoes every change since you opened this product.',
                   '还原到上次保存的版本?这将撤销自打开此产品以来的所有修改。'))) return;
  if (_pdOpenBaseline) {
    pdApplySnapshot(_pdOpenBaseline);
    clearTimeout(_pdAutoTimer);
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
  if (!confirm(cuT(
    'Restore this version?\n\nThe product’s current content (name, price, description, photos, category…) is replaced with this version. A new version is kept first, so you can undo. Stock is not changed.',
    '还原此版本?\n\n产品当前内容(名称、价格、描述、图片、分类…)将被此版本替换。会先保留一个新版本以便撤销。库存不会更改。'
  ))) return;
  try {
    await api('/api/retail-admin/products/' + id + '/restore-version', { method: 'POST', body: { version_id: versionId } });
    document.querySelectorAll('body > .pu-editor-bg').forEach(x => x.remove());
    await pdOpen(Number(id));   // reload the editor with the restored content
    toast(cuT('Restored to the chosen version.', '已还原到所选版本。'));
  } catch (e) { toast(cuT('Restore failed: ', '还原失败:') + e.message, 'err'); }
}
// Expand mode: hide the left list so the editor fills the page width.
function pdSyncFullscreenBtn(on) {
  const btn = document.getElementById('pd-expand-btn');
  if (btn) btn.innerHTML = on ? '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3"/></svg>Shrink · 还原' : '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/></svg>Expand · 全屏';
}
function pdToggleFullscreen() {
  const split = document.getElementById('pa-split');
  if (!split) return;
  const on = split.classList.toggle('pa-split-editonly');
  pdSyncFullscreenBtn(on);
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
// Live per-variant stock totals (variantId → sum across stores), filled by the
// variant × store matrix panel. The variants table reads these for its
// read-only STOCK column so both views always agree.
let VA_STORE_TOTALS = {};
// Last-loaded stock-by-location matrix payload, kept so the panel can re-render
// live when variants are renamed/added/removed on the left — without an exit +
// re-open. Cleared when the editor opens a new product.
let PD_STOCK_DATA = null;
function _vaName(p) { return (p.name_en || '—') + (p.name_cn ? ' · ' + p.name_cn : ''); }
// Picker row label (escaped HTML): the name plus a quiet disambiguator so two
// products that share a name — e.g. the same butter in two sizes — can be told
// apart. Prefer the variant/size, fall back to SKU.
function _vaPickName(p) {
  const tag = ((p.variant_label || '').trim() || (p.size || '').trim() || (p.sku || '').trim());
  return escapeHtml(_vaName(p)) + (tag ? ` <span class="bu-pick-tag">${escapeHtml(tag)}</span>` : '');
}
async function vaLoad(id) {
  const box = document.getElementById('pd-variants'); if (!box) return;
  VA_ID = id; VA_MEMBERS = []; VA_HAD_GROUP = false; VA_STORE_TOTALS = {};
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
    // Stock shown on the self row = the live per-store total (Tianhe + Yuexiu),
    // not the legacy flat stock_qty (which per-store edits never touch). Falls
    // back to stock_qty only if no per-store sum is known yet.
    const self = { id, label: p.variant_label || '', label_cn: p.variant_label_cn || '', name: _vaName(p), sku: p.sku || '', size: p.size || '', price: p.sell_price, compare: (p.compare_at_price != null ? p.compare_at_price : ''), stock: (p.effective_stock != null ? p.effective_stock : p.stock_qty), published: p.is_published, img: (p.image_data || p.image_url || ''), ownImg: !!(p.image_data || p.image_url), self: true };
    VA_MEMBERS = members.length
      ? members.map(m => ({ id: m.id, label: m.variant_label || '', label_cn: m.variant_label_cn || '', name: _vaName(m), sku: m.sku || '', size: m.size || '', price: m.price, compare: (m.compare != null ? m.compare : ''), stock: m.stock, published: m.is_published, img: (m.image_data || ''), ownImg: !!m.own_image, self: m.id === id }))
      : [self];
    if (!VA_MEMBERS.some(v => v.self)) VA_MEMBERS.unshift(self);
  } catch { VA_MEMBERS = [{ id, label: p.variant_label || '', label_cn: p.variant_label_cn || '', name: _vaName(p), img: (p.image_data || p.image_url || ''), ownImg: !!(p.image_data || p.image_url), self: true }]; }
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
  const head = `<div class="va-row va-row-head"><span></span><span>${cuT('Photo', '图片')}</span><span>${cuT('Name', '名称')}</span>` +
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
    // Variant option name is split EN/CN (never glued) — one input per language,
    // stacked, so "Big 200g" and "大" are stored & shown separately.
    const label = `<div class="va-name" title="${escapeAttr(v.name)}">` +
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
      return rowOpen + grip + photo + label +
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
    return rowOpen + grip + photo + label +
      `<input class="va-label" type="text" value="${escapeAttr(v.sku || '')}" placeholder="${cuT('SKU', '货号')}" oninput="vaField(${v.id}, 'sku', this.value)">` +
      `<input class="va-label va-wt" type="text" value="${escapeAttr(v.size || '')}" placeholder="${cuT('e.g. 200 g', '如 200克')}" title="${cuT('Size / weight shown on the size picker', '规格选择器上显示的规格 / 净重')}" oninput="vaField(${v.id}, 'weight', this.value)">` +
      `<input class="va-num" type="number" min="0" step="0.01" value="${price === '' ? '' : price}" placeholder="0" oninput="vaField(${v.id}, 'price', this.value)">` +
      `<input class="va-num va-was" type="number" min="0" step="0.01" value="${cmp === '' ? '' : cmp}" placeholder="—" title="${cuT('Was price — shown struck-through to shoppers when higher than the price. Leave blank for no discount.', '划线价 — 高于售价时在顾客端显示删除线。留空则不打折。')}" oninput="vaField(${v.id}, 'compare', this.value)">` +
      stkCell +
      `<span class="va-show"><input type="checkbox" ${v.published ? 'checked' : ''} title="${cuT('Show this variant in the shop', '在店面显示此规格')}" onchange="vaField(${v.id}, 'published', this.checked ? 1 : 0)"></span>` +
      `<button type="button" class="va-x" title="${cuT('Delete this variant', '删除此规格')}" onclick="vaRemove(${v.id})">✕</button></div>`;
  }).join('');
  box.innerHTML =
    toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px;margin-top:6px">${cuT('Sell this product in several variants. Each has its own name, SKU, price & stock. Drag ⠿ to set the order shoppers see.', '以多种规格出售本产品。每种规格有独立的名称、货号、价格与库存。拖动 ⠿ 可调整顾客看到的顺序。')}</div>` +
    `<div class="va-table">${head}${rows}</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="vaAddSize()">${cuT('+ Add variant', '+ 新增规格')}</button>` +
    `</div>`;
}
function vaLabel(id, lang, val) { const v = VA_MEMBERS.find(x => x.id === id); if (v) { if (lang === 'cn') v.label_cn = val; else v.label = val; pdSyncMatrixLabels(); } }
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
// Stock edits also re-tint the row (out-of-stock = red) live, without a full
// re-render that would drop input focus.
function vaStockInput(id, el) {
  vaField(id, 'stock', el.value);
  const row = el.closest('.va-row');
  if (row) row.classList.toggle('va-oos', el.value !== '' && Number(el.value) <= 0);
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
  if (!confirm(cuT('Delete the variant “', '删除规格“') + nm + cuT('”? This removes that product for good.', '”?将永久删除该产品。'))) return;
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
    VA_MEMBERS.push({ id: d.id, label: d.variant_label || '', label_cn: d.variant_label_cn || '', name: _vaName(d), sku: d.sku || '', size: d.size || '', price: d.sell_price, compare: (d.compare_at_price != null ? d.compare_at_price : ''), stock: d.stock_qty, published: d.is_published, img: (d.image_data || d.image_url || ''), ownImg: !!(d.image_data || d.image_url), self: false });
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
  const j = await api('/api/retail-admin/products/' + VA_ID + '/variants', { method: 'PUT', body: { members } });
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
async function vaPersistSiblings() {
  const dirty = VA_MEMBERS.filter(v => !v.self && v._dirty);
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
    box.innerHTML = `<div class="pd-var-head">${cuT('Buy together', '一起买')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then build a buy-together set here.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可创建“一起买”套餐。')}</div>`;
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
    : cuT('No bundle · tap to add', '无套装 · 点击添加');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="buToggle()" aria-expanded="${BU_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${BU_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Buy together', '一起买')}</span>` +
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
    `<div class="helper" style="font-size:11px;margin-bottom:2px">${cuT("Group this product with others as a “buy together” set on its page. Each item keeps its own price & stock — no separate inventory.", '在本产品页面将其与其他商品组成“一起买”套装。每件商品保留各自价格与库存,无需单独管理库存。')}</div>` +
    `<div class="bu-row2">` +
      `<div class="field"><label class="stacked">${cuT('Title EN', '标题(英文)')}</label><input type="text" value="${escapeAttr(BU.title_en)}" placeholder="Buy together" oninput="buField('title_en', this.value)"></div>` +
      `<div class="field"><label class="stacked">${cuT('Title CN', '标题(中文)')}</label><input type="text" value="${escapeAttr(BU.title_cn)}" placeholder="一起买" oninput="buField('title_cn', this.value)"></div>` +
    `</div>` +
    `<div class="bu-chips">${chips}</div>` +
    `<div class="bu-row2">` +
      `<div class="field"><label class="stacked">${cuT('Bundle price ¥ (optional)', '套装价 ¥(可选)')}</label><input type="number" min="0" step="0.01" value="${BU.price === '' ? '' : BU.price}" placeholder="${cuT('blank = item total', '留空 = 各项合计')}" oninput="buField('price', this.value)"></div>` +
      `<div class="field"><label class="stacked">${cuT('Auto voucher (optional)', '自动优惠券(可选)')}</label><input type="text" value="${escapeAttr(BU.voucher)}" placeholder="${cuT('code', '券码')}" oninput="buField('voucher', this.value)"></div>` +
    `</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="buTogglePicker()">${BU_PICKING ? cuT('Close', '关闭') : cuT('+ Add product', '+ 添加商品')}</button>` +
    `</div>` + picker;
  if (BU_PICKING) { const s = document.getElementById('bu-search'); if (s) s.focus(); buPickerList(); }
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
let BP_ID = null, BP = [], BP_PICKING = false, BP_OPEN = false;   // BP = [{id, qty}]
function bpLoad(id) {
  const box = document.getElementById('pd-bundle-product'); if (!box) return;
  BP_ID = id; BP_PICKING = false; BP = [];
  if (!id) {
    box.innerHTML = `<div class="pd-var-head">${cuT('Bundle (sold as one)', '套装产品(作为一个产品出售)')}</div>` +
      `<div class="helper" style="font-size:11px">${cuT('Add a name & SKU above — it saves automatically, then choose what goes inside.', '请先在上方填写名称和货号 — 系统会自动保存,随后即可选择套装内含的商品。')}</div>`;
    return;
  }
  const p = (PA_PRODUCTS || []).find(x => x.id === id);
  const items = (p && Array.isArray(p.bundle_items)) ? p.bundle_items : [];
  BP = items.map(c => ({ id: Number(c.id), qty: Math.max(1, parseInt(c.qty, 10) || 1) }))
            .filter(c => Number.isFinite(c.id) && c.id > 0);
  BP_OPEN = BP.length > 0;
  bpRender();
}
function bpToggle() { BP_OPEN = !BP_OPEN; bpRender(); }
function bpRender() {
  const box = document.getElementById('pd-bundle-product'); if (!box || BP_ID == null) return;
  const summary = BP.length
    ? cuT(BP.length + ' products inside', '内含 ' + BP.length + ' 件商品')
    : cuT('Not a bundle · tap to make one', '非套装 · 点击设为套装');
  const toggle = `<button type="button" class="pd-var-toggle" onclick="bpToggle()" aria-expanded="${BP_OPEN ? 'true' : 'false'}">` +
    `<span class="pd-var-caret">${BP_OPEN ? '▾' : '▸'}</span>` +
    `<span class="pd-var-head" style="margin:0">${cuT('Bundle (sold as one)', '套装产品')}</span>` +
    `<span class="pd-var-summary">${summary}</span></button>`;
  if (!BP_OPEN) { box.innerHTML = toggle; return; }
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
  box.innerHTML = toggle +
    `<div class="helper" style="font-size:11px;margin-bottom:2px">${cuT('Customers see ONE product at the price you set above. Behind the scenes it’s these products combined — their stock is what gets deducted, and the bundle sells while every item is in stock.', '顾客看到的是上方价格的单个产品。其实它由下列商品组合而成 — 扣减的是这些商品的库存,且仅当每件商品都有货时套装才可售。')}</div>` +
    `<div class="bu-chips">${chips}</div>` +
    `<div class="va-actions">` +
      `<button type="button" class="btn btn-sm" onclick="bpTogglePicker()">${BP_PICKING ? cuT('Close', '关闭') : cuT('+ Add product', '+ 添加商品')}</button>` +
    `</div>` + picker;
  if (BP_PICKING) { const s = document.getElementById('bp-search'); if (s) s.focus(); bpPickerList(); }
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
// Recipe to save (null clears → turns it back into a normal product).
function bpBody() {
  if (!BP.length) return null;
  return BP.map(c => ({ id: c.id, qty: Math.max(1, parseInt(c.qty, 10) || 1) }));
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
  const typeSel = (oi, t) => {
    const opt = (v, lbl) => `<option value="${v}"${t === v ? ' selected' : ''}>${lbl}</option>`;
    return `<select class="opt-type" onchange="optType(${oi}, this.value)" title="${cuT('How the customer answers', '顾客如何选择')}">` +
      opt('single', cuT('Pick one', '单选')) + opt('multi', cuT('Pick any', '多选')) + opt('text', cuT('Type an answer', '填写')) + `</select>`;
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
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxLong ? (maxLong / longest) : 1;
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const outType = forceJpeg ? 'image/jpeg' : ((file.type === 'image/png') ? 'image/png' : 'image/jpeg');
  if (outType === 'image/jpeg') {
    // JPEG has no alpha — paint white so transparent PNG areas flatten to white.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) try { bitmap.close(); } catch {}
  const outQ = outType === 'image/jpeg' ? quality : undefined;
  const blob = await new Promise(res => canvas.toBlob(res, outType, outQ));
  if (!blob) throw new Error('toBlob failed');
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
        <div style="width:22px;height:22px;flex:none;border:3px solid rgba(107,142,111,.22);border-top-color:#6B8E6F;border-radius:50%;animation:db-ring-spin .8s linear infinite"></div>
        <div style="font-weight:700;font-size:15px;color:var(--text-1,#1a2314);line-height:1.3">${cuT('Building your product page', '正在生成商品页')}</div>
      </div>
      <div style="height:8px;border-radius:999px;background:var(--bg-elev-1,#e9e9e3);overflow:hidden">
        <div data-bar style="height:100%;width:6%;border-radius:999px;background:linear-gradient(90deg,#6B8E6F,var(--brass,#B08D4A));transition:width .4s ease"></div>
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
      bar.style.background = ok ? 'linear-gradient(90deg,#6B8E6F,#7BA07F)' : 'linear-gradient(90deg,#e8556a,#ef9a9a)';
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
    const ok = confirm(cuT(
      'This product already has ' + (n ? n + ' designed section(s)' : 'a designed page') + '.\n\nRebuild it from the current description? This replaces the existing sections.',
      '该商品已有' + (n ? n + ' 个板块' : '已设计的页面') + '。\n\n要根据当前描述重新生成吗?这将替换现有板块。'));
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
function pdRteLink() { const url = prompt('Link URL · 链接地址:'); if (url) pdRte('createLink', url); }
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
  const fd = new FormData(); fd.append('file', f);
  toast(cuT('Uploading image…', '正在上传图片…'));
  try {
    const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
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
function pdRteTable() {
  pdRteSaveSel();
  const spec = prompt(cuT('Table size — rows × columns (e.g. 3x3)', '表格大小 — 行 × 列(例如 3x3)'), '3x3');
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
function pdRteClean(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.innerText || '').trim() ? (html || '').trim() : ''; }
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
// Product details is collapsed by default; click the header to expand/fold.
function pdFactsToggle() {
  const sec = document.getElementById('pd-facts');
  if (sec) sec.classList.toggle('pd-facts-collapsed');
}
// "Auto-fill from text" — read the description (or a pasted blob) and let the
// AI split it into the Product details boxes. Same engine that already reads
// descriptions; fills empty boxes and refreshes found ones for review.
async function pdFactsAutofill() {
  const btn = document.getElementById('pd-facts-autofill');
  let textEn = pdStripToText(pdRteClean(document.getElementById('pd-rte-en').innerHTML));
  let textCn = pdStripToText(pdRteClean(document.getElementById('pd-rte-cn').innerHTML));
  if (!textEn && !textCn) {
    const pasted = prompt(cuT('Paste the product text to pull details from:', '粘贴产品文字以提取详情:'));
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
    low_stock_threshold: g('pd-low-stock').trim(),  // '' = clear override → use store default
    status: g('pd-status') || 'Active',
    free_of: pdFreeOfGet(), notes: g('pd-notes'), product_facts: pdFactsGet(),
    is_market: ckd('pd-is-market'), is_restock_only: ckd('pd-is-restock-only'), is_batch_made: ckd('pd-is-batch-made'),
    oos_policy: (g('pd-oos-policy') === 'backorder_gz' ? 'backorder_gz' : 'strict'),
    ship_from_supplier: ckd('pd-ship-from-supplier'),
    ship_modes: modes.join(',') || 'air,land',
    description_en: pdRteClean(document.getElementById('pd-rte-en').innerHTML),
    description_cn: pdRteClean(document.getElementById('pd-rte-cn').innerHTML),
    description_format: 'rich',
    is_published: document.getElementById('pd-published').checked ? 1 : 0,
  };
  if (_pdGalleryDirty) body.images = _pdGallery;  // gallery drives image_data (first = main)
  if (id && BU_ID === Number(id)) body.bundle = buBody();  // buy-together bundle (null clears)
  if (id && BP_ID === Number(id)) body.bundle_items = bpBody();  // THIS-is-a-bundle recipe (null clears)
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
    await vaPersist(); await vaPersistSiblings();
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
  clearTimeout(_pdAutoTimer);
  _pdAutoTimer = setTimeout(pdAutoSaveNow, 800);
}

async function pdAutoSaveNow() {
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
    sku: g('pd-sku'), weight: g('pd-weight'), status: g('pd-status'), free_of: pdFreeOfGet(),
    notes: g('pd-notes'), badge: g('pd-badge'), facts: pdFactsGet(),
    top: g('pd-top-category'), sub: g('pd-subcategory'),
    is_market: ck('pd-is-market'), is_batch: ck('pd-is-batch-made'), is_restock: ck('pd-is-restock-only'),
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
  set('pd-sku', s.sku); set('pd-weight', s.weight); set('pd-status', s.status); pdFreeOfSet(s.free_of);
  set('pd-notes', s.notes); set('pd-badge', s.badge); pdFactsSet(s.facts);
  ck('pd-is-market', s.is_market); ck('pd-is-batch-made', s.is_batch); ck('pd-is-restock-only', s.is_restock);
  set('pd-oos-policy', s.oos_policy || 'strict');
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
    label = prompt(cuT('Variant label for the copy (e.g. 500g):', '副本的规格标签(如 500克):'), '');
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
  if (!confirm('Delete this product? · 删除此产品?\nIt will be hidden from the shop. · 将从店面隐藏。')) return;
  try {
    const r = await fetch('/api/retail-admin/products/' + id, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'delete_failed');
    PA_PRODUCTS = PA_PRODUCTS.filter(x => x.id !== Number(id));
    pdClose();
    paRender();
  } catch (e) { alert('Delete failed · 删除失败: ' + e.message); }
}

// Paint the IP character tiles. The hidden input #pa-edit-colophon-character
// holds the office's pick (empty string = auto by category). Clicking a
// tile sets it; clicking again on the same tile (or the "Auto" button)
// clears the override.
function paRenderColophonGrid() {
  const grid = document.getElementById('pa-colophon-grid'); if (!grid) return;
  const current = (document.getElementById('pa-edit-colophon-character').value || '').trim();
  grid.innerHTML = PA_IP_CHARACTERS.map(c => `
    <div class="pa-colophon-tile ${current === c.key ? 'active' : ''}" onclick="paPickColophonChar('${c.key}')" title="${escapeAttr(c.label)}">
      <img src="/assets/brand/ip-${c.key}.jpg" alt="${escapeAttr(c.label)}" loading="lazy">
      <span class="pa-colophon-tile-label">${escapeHtml(c.label)}</span>
    </div>
  `).join('');
}
function paPickColophonChar(key) {
  const input = document.getElementById('pa-edit-colophon-character');
  // Click same tile again → un-pick (back to auto)
  input.value = input.value === key ? '' : key;
  paRenderColophonGrid();
  paRenderPreview();
}
function paClearColophonChar() {
  document.getElementById('pa-edit-colophon-character').value = '';
  paRenderColophonGrid();
  paRenderPreview();
}

// Paint the preset cards into the modal. Renders once per modal-open;
// the cards don't depend on the current product so this is idempotent.
function paRenderPresets() {
  const row = document.getElementById('pa-presets-row'); if (!row) return;
  if (row.children.length) return; // already painted
  row.innerHTML = PA_PAGE_PRESETS.map(p => `
    <button type="button" class="pa-preset-card" onclick="paApplyPreset('${p.id}')">
      <span class="pa-preset-card-label">${escapeHtml(p.label_en)}<br>${escapeHtml(p.label_cn)}</span>
      <span class="pa-preset-card-desc">${escapeHtml(p.desc_en)}<br>${escapeHtml(p.desc_cn)}</span>
    </button>
  `).join('');
}

// Apply a preset's blocks to the current product. If there are existing
// blocks, confirm before overwriting so the office doesn't lose work.
// New ids are generated so the existing tab/selection state cleanly
// rebuilds against the fresh stack.
function paApplyPreset(id) {
  const preset = PA_PAGE_PRESETS.find(p => p.id === id); if (!preset) return;
  const existing = (window._paBlocks || []).length;
  if (existing > 0) {
    const ok = confirm(
      'Apply this preset? · 套用此版型?\n\n' +
      'It will REPLACE the ' + existing + ' block(s) currently on this product. ' +
      '\n将替换当前产品上的 ' + existing + ' 个板块,无法撤销。'
    );
    if (!ok) return;
  }
  // Deep-clone the preset blocks (so editing one product doesn't mutate
  // the preset definition for subsequent products) and assign fresh ids.
  window._paBlocks = preset.blocks.map(b => ({
    ...JSON.parse(JSON.stringify(b)),
    id: paBlocksGenId(),
  }));
  PA_SELECTED_BLOCK_ID = window._paBlocks[0]?.id || null;
  paRenderAll();
}
function paCloseEdit() {
  document.getElementById('pa-edit-bg').classList.remove('show');
  PA_CURRENT = null;
  PA_SELECTED_BLOCK_ID = null;
}

// Track which block is currently being edited (only one form on screen).
let PA_SELECTED_BLOCK_ID = null;
// Single entry-point that repaints both halves of the editor — used after
// any structural change (add / delete / reorder / select).
function paRenderAll() {
  paRenderTabs();
  paRenderSelectedEditor();
  paRenderPreview();
}
// Live-preview repaint only — called on every keystroke in the form fields
// so the right pane tracks edits without flicker.
function paLivePreview() {
  paBlocksSyncFromDOM();
  paRenderPreview();
  // The tab label may show a body excerpt; refresh those too without
  // re-rendering the form (which would steal focus).
  paRefreshTabLabels();
}

async function paSaveEdit() {
  if (!PA_CURRENT) return;
  const body = {
    keywords_en:           document.getElementById('pa-edit-keywords-en').value.trim() || null,
    keywords_cn:           document.getElementById('pa-edit-keywords-cn').value.trim() || null,
    tagline_en:            document.getElementById('pa-edit-tagline-en').value.trim()  || null,
    tagline_cn:            document.getElementById('pa-edit-tagline-cn').value.trim()  || null,
    colophon_character:    document.getElementById('pa-edit-colophon-character').value.trim() || null,
    colophon_tagline_en:   document.getElementById('pa-edit-colophon-tagline-en').value.trim() || null,
    colophon_tagline_cn:   document.getElementById('pa-edit-colophon-tagline-cn').value.trim() || null,
    description_blocks:    paBlocksCollect(),
  };
  try {
    const r = await fetch('/api/retail-admin/products/' + PA_CURRENT.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'save_failed');
    // Patch the cached row in PA_PRODUCTS so the grid card updates without
    // a full refetch (faster + preserves scroll/filter state).
    const idx = PA_PRODUCTS.findIndex(x => x.id === PA_CURRENT.id);
    if (idx >= 0) PA_PRODUCTS[idx] = { ...PA_PRODUCTS[idx], ...j.data };
    paCloseEdit();
    paRender();
  } catch (e) {
    alert('Save failed · 保存失败: ' + e.message);
  }
}

// ── Block editor (lives only inside the products modal) ─────────────────
function paBlocksGenId() { return 'b' + Math.random().toString(36).slice(2, 9); }

function paBlocksPopulatePicker() {
  const pick = document.getElementById('pa-blocks-picker');
  if (pick && pick.options.length <= 1) {
    PA_BLOCK_TYPES.forEach(t => {
      const o = document.createElement('option');
      o.value = t.type;
      o.textContent = t.label_en + ' · ' + t.label_cn;
      pick.appendChild(o);
    });
  }
}

function paBlocksAdd(type) {
  if (!type) return;
  const def = PA_BLOCK_TYPES.find(t => t.type === type); if (!def) return;
  paBlocksSyncFromDOM();
  if (!window._paBlocks) window._paBlocks = [];
  const nb = { id: paBlocksGenId(), type, ...def.make() };
  window._paBlocks.push(nb);
  PA_SELECTED_BLOCK_ID = nb.id;
  paRenderAll();
  // Scroll the new block row into view in the palette panel
  setTimeout(() => {
    const row = document.querySelector(`.pa-block-row[data-blockid="${nb.id}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 30);
}
function paBlocksRemove(id) {
  if (!confirm('Delete this section? · 删除此板块?')) return;
  paBlocksSyncFromDOM();
  const arr = window._paBlocks || [];
  const i = arr.findIndex(b => b.id === id);
  if (i < 0) return;
  arr.splice(i, 1);
  // Move selection to the sibling closest to where the deleted block sat.
  if (PA_SELECTED_BLOCK_ID === id) {
    PA_SELECTED_BLOCK_ID = arr[Math.min(i, arr.length - 1)]?.id || null;
  }
  paRenderAll();
}
function paBlocksMove(id, dir) {
  paBlocksSyncFromDOM();
  const arr = window._paBlocks || [];
  const i = arr.findIndex(b => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  paRenderAll();
}
function paBlocksSelect(id) {
  paBlocksSyncFromDOM();
  PA_SELECTED_BLOCK_ID = id;
  paRenderAll();
}
// Pull values from the currently-mounted block editor back into the
// in-memory model. Only ONE block's form is in the DOM at a time
// (split-pane editor shows the selected block only), so we look up that
// block by its data-blockid and copy its data-bkey inputs across. This
// runs before any structural change (add/delete/reorder/save) and on
// every keystroke (via paLivePreview) so the model stays current.
// Pull values from the currently-mounted block editor back into the
// in-memory model. Handles four input shapes via attribute hints:
//   [data-bkey]                  → b[key] = value
//   [data-cellidx][data-bkey]    → b.cells[idx][key] = value     (spec_strip)
//   [data-rowidx][data-bkey]     → b.rows[idx][key] / b.items[idx][key] / b.tiles[idx][key]
//   [data-sub][data-bkey]        → b[sub][key] = value           (storage_box.left/right)
// Checkboxes use .checked instead of .value. Number inputs are kept as
// strings here — type coercion happens at save / preview render time.
function paBlocksSyncFromDOM() {
  const mount = document.getElementById('pa-block-editor-mount'); if (!mount) return;
  const card = mount.querySelector('[data-blockid]'); if (!card) return;
  const id = card.getAttribute('data-blockid');
  const b = (window._paBlocks || []).find(x => x.id === id); if (!b) return;
  card.querySelectorAll('[data-bkey]').forEach(el => {
    const k    = el.getAttribute('data-bkey');
    const val  = el.type === 'checkbox' ? !!el.checked : el.value;
    const cIdx = el.getAttribute('data-cellidx');
    const rIdx = el.getAttribute('data-rowidx');
    const sub  = el.getAttribute('data-sub');
    if (cIdx != null) {
      if (!Array.isArray(b.cells)) b.cells = [];
      b.cells[+cIdx] = { ...(b.cells[+cIdx] || {}), [k]: val };
    } else if (rIdx != null) {
      // why → rows, ingredients → items, how_to_use → tiles
      const arrKey = b.type === 'why' ? 'rows'
                   : (b.type === 'ingredients_chips' || b.type === 'ingredients_line') ? 'items'
                   : b.type === 'how_to_use' ? 'tiles'
                   : null;
      if (arrKey) {
        if (!Array.isArray(b[arrKey])) b[arrKey] = [];
        b[arrKey][+rIdx] = { ...(b[arrKey][+rIdx] || {}), [k]: val };
      }
    } else if (sub) {
      b[sub] = { ...(b[sub] || {}), [k]: val };
    } else {
      b[k] = val;
    }
  });
}

// ── Tabs strip — one tab per block, click to select for editing ─────
// Glyphs + names are derived from the PA_BLOCK_TYPES registry so adding
// a new type only requires one entry above; tab strip, editor header,
// and sub-labels all pick it up automatically.
const PA_TYPE_GLYPH = Object.fromEntries(PA_BLOCK_TYPES.map(t => [t.type, t.glyph]));
const PA_TYPE_NAME  = Object.fromEntries(PA_BLOCK_TYPES.map(t => [t.type, { en: t.name_en, cn: t.name_cn }]));
// Legacy alias — older saves used `stat_callout` for the Big Stat block.
PA_TYPE_GLYPH.stat_callout = PA_TYPE_GLYPH.stat_callout || '✨';
PA_TYPE_NAME.stat_callout  = PA_TYPE_NAME.stat_callout  || { en: 'Big Stat', cn: '大数字' };

function _paBlockSubLabel(b) {
  // Sub-label = the first 40 chars of the block's headline content, so
  // the tab strip reads like a TOC. Each branch picks the most
  // representative field for that block type.
  const trim = s => (s || '').toString().trim();
  const head = s => trim(s).slice(0, 40) + (trim(s).length > 40 ? '…' : '');

  if (b.type === 'hero_intro') {
    return head(b.body_en || b.body_cn || b.highlight_en || b.highlight_cn || b.kicker_en || b.kicker_cn);
  }
  if (b.type === 'stat_callout' || b.type === 'big_stat') {
    return [trim(b.stat), trim(b.what_en || b.what_cn || b.claim_en || b.claim_cn)].filter(Boolean).join(' · ');
  }
  if (b.type === 'allergen_card') {
    return head(b.contains_en || b.contains_cn);
  }
  if (b.type === 'spec_strip') {
    const cells = Array.isArray(b.cells) ? b.cells : [];
    return cells.map(c => trim(c.v_en || c.v_cn)).filter(Boolean).slice(0, 3).join(' · ').slice(0, 40);
  }
  if (b.type === 'why') {
    const r = (b.rows || [])[0] || {};
    return head(r.claim_en || r.claim_cn);
  }
  if (b.type === 'ingredients_chips' || b.type === 'ingredients_line') {
    const items = b.items || [];
    return items.map(it => trim(it.name_en || it.name_cn)).filter(Boolean).slice(0, 4).join(', ').slice(0, 40);
  }
  if (b.type === 'how_to_use') {
    const tiles = b.tiles || [];
    return tiles.map(t => trim(t.label_en || t.label_cn)).filter(Boolean).slice(0, 4).join(' · ').slice(0, 40);
  }
  if (b.type === 'storage_box') {
    return [b.left?.head_en || b.left?.head_cn, b.right?.head_en || b.right?.head_cn].filter(Boolean).join(' · ');
  }
  if (b.type === 'notes_callout') {
    return head(b.text_en || b.text_cn);
  }
  if (b.type === 'pull_quote') {
    return head(b.text_en || b.text_cn);
  }
  return '';
}
function paRenderTabs() {
  const list = document.getElementById('pa-blocks-list'); if (!list) return;
  const blocks = window._paBlocks || [];
  if (!blocks.length) {
    list.innerHTML = '<div class="helper" style="padding:14px 6px;text-align:center;font-size:11px;line-height:1.5">No sections yet.<br>Use the dropdown above<br>to add your first. · 暂无板块。</div>';
    return;
  }
  list.innerHTML = blocks.map((b, i) => {
    const glyph  = PA_TYPE_GLYPH[b.type] || '🧩';
    const tName  = (PA_TYPE_NAME[b.type] || { en: b.type, cn: '' });
    const sub    = _paBlockSubLabel(b);
    const active = b.id === PA_SELECTED_BLOCK_ID ? ' active' : '';
    return `<div class="pa-block-row${active}" data-blockid="${b.id}" onclick="paBlocksSelect('${b.id}')" title="${escapeAttr(tName.en + (tName.cn ? ' · ' + tName.cn : ''))}">
      <div class="pbr-icon">${glyph}</div>
      <div class="pbr-info">
        <div class="pbr-name">${escapeHtml(tName.en)}</div>
        ${sub ? `<div class="pbr-sub">${escapeHtml(sub)}</div>` : ''}
      </div>
      <div class="pbr-num">${i + 1}</div>
    </div>`;
  }).join('');
}
// Update tab sub-labels in place (called on keystroke so the form doesn't
// re-render and steal focus). Cheap full innerHTML refresh — tabs are tiny.
function paRefreshTabLabels() {
  const blocks = window._paBlocks || [];
  blocks.forEach(b => {
    const row = document.querySelector(`.pa-block-row[data-blockid="${b.id}"]`);
    if (!row) return;
    const subEl = row.querySelector('.pbr-sub');
    const sub = _paBlockSubLabel(b);
    if (sub) {
      if (subEl) subEl.textContent = sub;
      else {
        const div = document.createElement('div');
        div.className = 'pbr-sub';
        div.textContent = sub;
        const info = row.querySelector('.pbr-info');
        if (info) info.appendChild(div);
      }
    } else if (subEl) subEl.remove();
  });
}

// ── Selected-block editor — one form pane for the currently-selected block ─
// ── Selected-block editor — one form pane per block type ──────────────
// Per-type form helpers are dispatched from paRenderSelectedEditor based
// on the selected block's `type`. Array-shaped blocks (why / ingredients /
// how_to_use) use the small `paArrAdd/Remove` helpers below to mutate the
// model and re-render. Single-shape blocks just bind data-bkey inputs.

function _paBlockEditorBody(b) {
  // Convenience pre-syncs:
  const v = (k) => escapeAttr(b[k] || '');
  const t = (k) => escapeHtml(b[k] || '');

  // -------- spec_strip --------
  if (b.type === 'spec_strip') {
    const cells = Array.isArray(b.cells) && b.cells.length
      ? b.cells
      : [{ k_en:'Type',k_cn:'类型',v_en:'',v_cn:'' },
         { k_en:'Net Wt',k_cn:'净重',v_en:'',v_cn:'' },
         { k_en:'Origin',k_cn:'产地',v_en:'',v_cn:'' }];
    return `
      <div class="helper" style="margin:-4px 0 10px">Meta facts shown as a quiet strip under the product header. Labels are caps; values are serif. Designed for 3 cells but you can add/remove as needed. · 产品头部下方的安静一行,小标签 + 衬线值。默认 3 格,可按需增删。</div>
      ${cells.map((c, i) => `
        <div class="pa-edit-section" style="padding:9px 11px;background:var(--bg-pane);margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
            <span class="pa-edit-section-title">Cell · 第 ${i + 1} 格</span>
            <button type="button" class="btn danger" style="padding:3px 9px;font-size:11px" onclick="paArrRemove('${b.id}','cells',${i})" ${cells.length <= 1 ? 'disabled' : ''}>Remove · 删除</button>
          </div>
          <div class="pa-edit-grid-2">
            <div class="field"><label class="stacked">Label EN · 标签(英文)</label><input data-cellidx="${i}" data-bkey="k_en" type="text" value="${escapeAttr(c.k_en || '')}" placeholder="Type"></div>
            <div class="field"><label class="stacked">Label 中文</label><input data-cellidx="${i}" data-bkey="k_cn" type="text" value="${escapeAttr(c.k_cn || '')}" placeholder="类型"></div>
            <div class="field"><label class="stacked">Value EN · 值(英文)</label><input data-cellidx="${i}" data-bkey="v_en" type="text" value="${escapeAttr(c.v_en || '')}" placeholder="Refrigerated dip"></div>
            <div class="field"><label class="stacked">Value 中文</label><input data-cellidx="${i}" data-bkey="v_cn" type="text" value="${escapeAttr(c.v_cn || '')}" placeholder="冷藏蘸酱"></div>
          </div>
        </div>`).join('')}
      <button type="button" class="btn" style="margin-top:6px" onclick="paArrAdd('${b.id}','cells',{k_en:'',k_cn:'',v_en:'',v_cn:''})">+ Add cell · 添加一格</button>`;
  }

  // -------- hero_intro --------
  if (b.type === 'hero_intro') {
    return `
      <div class="pa-edit-grid-2">
        <div class="field"><label class="stacked">Kicker EN · 引题(英文)</label>
          <input data-bkey="kicker_en" type="text" value="${v('kicker_en')}" placeholder="The story">
          <div class="helper">Optional caps prefix above the paragraph (e.g. "The story", "Mature · clean · no shortcuts"). · 段落上方的小标题(大写,可选)。</div>
        </div>
        <div class="field"><label class="stacked">Kicker 中文</label>
          <input data-bkey="kicker_cn" type="text" value="${v('kicker_cn')}" placeholder="故事">
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Body EN · 正文</label>
          <textarea data-bkey="body_en" rows="5">${t('body_en')}</textarea>
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Body 中文</label>
          <textarea data-bkey="body_cn" rows="5">${t('body_cn')}</textarea>
        </div>
        <div class="field"><label class="stacked">Highlight EN · 重点(英文)</label>
          <input data-bkey="highlight_en" type="text" value="${v('highlight_en')}" placeholder="just enough heat to wake things up">
          <div class="helper">If this phrase appears in the body, it renders inline on a lime slab. If not, falls back to the kicker slot above. · 若该短语出现在正文中,会以青柠色块呈现;否则回退到上方引题位置。</div>
        </div>
        <div class="field"><label class="stacked">Highlight 中文</label>
          <input data-bkey="highlight_cn" type="text" value="${v('highlight_cn')}" placeholder="刚好够把舌头叫醒">
        </div>
      </div>`;
  }

  // -------- why --------
  if (b.type === 'why') {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    return `
      <div class="helper" style="margin:-4px 0 14px">3–5 single-sentence benefits. Numbered ledger on the mini-app. · 3-5 条单句卖点,小程序中编号呈现。</div>
      ${rows.map((r, i) => `
        <div class="pa-edit-section" style="padding:12px 14px;background:var(--bg-pane);margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="pa-edit-section-title">${String(i + 1).padStart(2, '0')}</span>
            <button type="button" class="btn danger" style="padding:3px 9px;font-size:11px" onclick="paArrRemove('${b.id}','rows',${i})" ${rows.length <= 1 ? 'disabled' : ''}>Remove · 删除</button>
          </div>
          <div class="pa-edit-grid-2">
            <div class="field"><label class="stacked">Claim EN · 说明(英文)</label><input data-rowidx="${i}" data-bkey="claim_en" type="text" value="${escapeAttr(r.claim_en || '')}" placeholder="Fresh herb flavor with controlled heat."></div>
            <div class="field"><label class="stacked">Claim 中文</label><input data-rowidx="${i}" data-bkey="claim_cn" type="text" value="${escapeAttr(r.claim_cn || '')}" placeholder="鲜草本风味,可控辣度。"></div>
          </div>
        </div>`).join('')}
      <button type="button" class="btn" style="margin-top:6px" onclick="paArrAdd('${b.id}','rows',{claim_en:'',claim_cn:''})" ${rows.length >= 5 ? 'disabled' : ''}>+ Add claim · 添加</button>`;
  }

  // -------- ingredients_chips / ingredients_line --------
  if (b.type === 'ingredients_chips' || b.type === 'ingredients_line') {
    const items = Array.isArray(b.items) ? b.items : [];
    const isChips = b.type === 'ingredients_chips';
    return `
      <div class="helper" style="margin:-4px 0 14px">
        ${isChips
          ? 'Pill cloud. Mark one item as the <b>hero</b> chip and add a <b>%</b> for any item ≥ 10%. · 圆角标签,可标记一个主料,加百分比。'
          : 'Editorial single-line run with lime-dot separators. Best for clean lists ≤ 10 items. · 编辑式一行体,适合简洁列表。'}
      </div>
      ${items.map((it, i) => `
        <div class="pa-edit-section" style="padding:12px 14px;background:var(--bg-pane);margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="pa-edit-section-title">${String(i + 1).padStart(2, '0')}</span>
            <button type="button" class="btn danger" style="padding:3px 9px;font-size:11px" onclick="paArrRemove('${b.id}','items',${i})" ${items.length <= 1 ? 'disabled' : ''}>Remove · 删除</button>
          </div>
          <div class="pa-edit-grid-2">
            <div class="field"><label class="stacked">Name EN · 名称(英文)</label><input data-rowidx="${i}" data-bkey="name_en" type="text" value="${escapeAttr(it.name_en || '')}" placeholder="Fresh cilantro"></div>
            <div class="field"><label class="stacked">Name 中文</label><input data-rowidx="${i}" data-bkey="name_cn" type="text" value="${escapeAttr(it.name_cn || '')}" placeholder="鲜香菜"></div>
            <div class="field"><label class="stacked">% (optional)</label><input data-rowidx="${i}" data-bkey="pct" type="number" min="0" max="100" value="${escapeAttr(it.pct == null ? '' : it.pct)}" placeholder="38"></div>
            <div class="field"><label class="stacked">Hero · 主料</label>
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-1);cursor:pointer">
                <input data-rowidx="${i}" data-bkey="lead" type="checkbox" ${it.lead ? 'checked' : ''}>
                <span>Inverted hero chip · 反色主料标签</span>
              </label>
            </div>
          </div>
        </div>`).join('')}
      <button type="button" class="btn" style="margin-top:6px" onclick="paArrAdd('${b.id}','items',{name_en:'',name_cn:'',pct:'',lead:false})">+ Add ingredient · 添加配料</button>`;
  }

  // -------- allergen_card --------
  if (b.type === 'allergen_card') {
    return `
      <div class="pa-edit-grid-2">
        <div class="field"><label class="stacked">Contains EN · 包含(英文)</label>
          <input data-bkey="contains_en" type="text" value="${v('contains_en')}" placeholder="Tree nuts, Hazelnuts">
          <div class="helper">Comma-separated · berry strong chips. Leave blank for "None declared". · 逗号分隔,显示为深莓色标签。留空显示"无声明"。</div>
        </div>
        <div class="field"><label class="stacked">Contains 中文 · 含有</label>
          <input data-bkey="contains_cn" type="text" value="${v('contains_cn')}" placeholder="树坚果,榛子">
        </div>
        <div class="field"><label class="stacked">May Contain EN · 可能含有(英文)</label>
          <input data-bkey="may_contain_en" type="text" value="${v('may_contain_en')}" placeholder="Other tree nuts, soy">
          <div class="helper">Comma-separated · corn soft chips. · 逗号分隔,显示为玉米色软标签。</div>
        </div>
        <div class="field"><label class="stacked">May Contain 中文 · 可能含有</label>
          <input data-bkey="may_contain_cn" type="text" value="${v('may_contain_cn')}" placeholder="其他树坚果、大豆">
        </div>
      </div>`;
  }

  // -------- how_to_use --------
  if (b.type === 'how_to_use') {
    const tiles = Array.isArray(b.tiles) ? b.tiles : [];
    return `
      <div class="helper" style="margin:-4px 0 14px">6 tiles (3-col grid) or 8 tiles (4-col grid) — never 5 or 7. Each tile: emoji + caps label + optional italic sub-line. · 6 块 (3 列) 或 8 块 (4 列),emoji + 标签 + 可选副标题。</div>
      ${tiles.map((tl, i) => `
        <div class="pa-edit-section" style="padding:12px 14px;background:var(--bg-pane);margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="pa-edit-section-title">${String(i + 1).padStart(2, '0')}</span>
            <button type="button" class="btn danger" style="padding:3px 9px;font-size:11px" onclick="paArrRemove('${b.id}','tiles',${i})" ${tiles.length <= 1 ? 'disabled' : ''}>Remove · 删除</button>
          </div>
          <div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:10px">
            <div class="field"><label class="stacked">Icon · 图标</label><input data-rowidx="${i}" data-bkey="icon" type="text" value="${escapeAttr(tl.icon || '')}" placeholder="🥖" style="text-align:center;font-size:18px"></div>
            <div class="field"><label class="stacked">Label EN · 标签(英文)</label><input data-rowidx="${i}" data-bkey="label_en" type="text" value="${escapeAttr(tl.label_en || '')}" placeholder="Toast"></div>
            <div class="field"><label class="stacked">Label 中文</label><input data-rowidx="${i}" data-bkey="label_cn" type="text" value="${escapeAttr(tl.label_cn || '')}" placeholder="吐司"></div>
            <div></div>
            <div class="field"><label class="stacked">Sub EN (optional) · 副标(英文,可选)</label><input data-rowidx="${i}" data-bkey="sub_en" type="text" value="${escapeAttr(tl.sub_en || '')}" placeholder="over eggs"></div>
            <div class="field"><label class="stacked">Sub 中文 (optional)</label><input data-rowidx="${i}" data-bkey="sub_cn" type="text" value="${escapeAttr(tl.sub_cn || '')}" placeholder="盖在鸡蛋上"></div>
          </div>
        </div>`).join('')}
      <button type="button" class="btn" style="margin-top:6px" onclick="paArrAdd('${b.id}','tiles',{icon:'',label_en:'',label_cn:'',sub_en:'',sub_cn:''})" ${tiles.length >= 8 ? 'disabled' : ''}>+ Add tile · 添加用法</button>`;
  }

  // -------- storage_box --------
  if (b.type === 'storage_box') {
    const L = b.left  || {};
    const R = b.right || {};
    const card = (which, c) => `
      <div class="pa-edit-section" style="padding:12px 14px;background:var(--bg-pane);margin-bottom:10px">
        <div class="pa-edit-section-title" style="margin-bottom:8px">${which === 'left' ? 'Left card · 左卡' : 'Right card · 右卡'}</div>
        <div style="display:grid;grid-template-columns:60px 1fr 1fr;gap:10px">
          <div class="field"><label class="stacked">Icon · 图标</label><input data-sub="${which}" data-bkey="icon" type="text" value="${escapeAttr(c.icon || '')}" placeholder="❄" style="text-align:center;font-size:18px"></div>
          <div class="field"><label class="stacked">Head EN · 标题(英文)</label><input data-sub="${which}" data-bkey="head_en" type="text" value="${escapeAttr(c.head_en || '')}" placeholder="Refrigerated"></div>
          <div class="field"><label class="stacked">Head 中文</label><input data-sub="${which}" data-bkey="head_cn" type="text" value="${escapeAttr(c.head_cn || '')}" placeholder="冷藏"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
          <div class="field"><label class="stacked">Big word EN · 大字(英文)</label><input data-sub="${which}" data-bkey="num_en" type="text" value="${escapeAttr(c.num_en || c.num || '')}" placeholder="Cool & dry"></div>
          <div class="field"><label class="stacked">Big word CN · 大字(中文)</label><input data-sub="${which}" data-bkey="num_cn" type="text" value="${escapeAttr(c.num_cn || '')}" placeholder="阴凉干燥"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
          <div class="field"><label class="stacked">Unit EN · 单位(英文)</label><input data-sub="${which}" data-bkey="unit_en" type="text" value="${escapeAttr(c.unit_en || '')}" placeholder="Store away from heat"></div>
          <div class="field"><label class="stacked">Unit 中文</label><input data-sub="${which}" data-bkey="unit_cn" type="text" value="${escapeAttr(c.unit_cn || '')}" placeholder="远离高温和潮湿"></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-1);margin-top:10px;cursor:pointer">
          <input data-sub="${which}" data-bkey="alt" type="checkbox" ${c.alt ? 'checked' : ''}>
          <span>Inverted (ink fill, oat text) · 反色卡片</span>
        </label>
      </div>`;
    return `
      <div class="helper" style="margin:-4px 0 14px">Two paired condition cards. Keep one inverted so they read as a set. · 双卡片成对,其中一张反色形成对比。</div>
      ${card('left',  L)}
      ${card('right', R)}
      <div class="pa-edit-grid-2" style="margin-top:8px">
        <div class="field"><label class="stacked">After-opening note EN · 开封后备注(英文)</label><input data-bkey="note_en" type="text" value="${v('note_en')}" placeholder="After opening · refrigerate"></div>
        <div class="field"><label class="stacked">After-opening note 中文</label><input data-bkey="note_cn" type="text" value="${v('note_cn')}" placeholder="开封后冷藏"></div>
      </div>`;
  }

  // -------- notes_callout --------
  if (b.type === 'notes_callout') {
    return `
      <div class="helper" style="margin:-4px 0 14px">Fine-print band — "shake before use", warnings, sourcing notes. Max ~3 lines. · 小字注释,如「使用前摇匀」等。</div>
      <div class="pa-edit-grid-2">
        <div class="field" style="grid-column:span 2"><label class="stacked">Text EN · 文字(英文)</label>
          <textarea data-bkey="text_en" rows="3">${t('text_en')}</textarea>
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Text 中文</label>
          <textarea data-bkey="text_cn" rows="3">${t('text_cn')}</textarea>
        </div>
      </div>`;
  }

  // -------- big_stat --------
  if (b.type === 'big_stat' || b.type === 'stat_callout') {
    const bgOpts = ['lime','carrot','pink','corn','sky','lotus','papaya','cucumber'];
    return `
      <div class="pa-edit-grid-2">
        <div class="field" style="grid-column:span 2"><label class="stacked">Stat · 数字</label>
          <input data-bkey="stat" type="text" value="${v('stat')}" placeholder="81%" style="font-size:22px;font-weight:700;text-align:center">
          <div class="helper">e.g. <code>81%</code>, <code>500g</code>, <code>0g</code> · 例如</div>
        </div>
        <div class="field"><label class="stacked">What EN · 内容(英文)</label>
          <input data-bkey="what_en" type="text" value="${v('what_en')}" placeholder="HAZELNUTS">
          <div class="helper">Caps label under the stat. · 数字下方的大写小标题。</div>
        </div>
        <div class="field"><label class="stacked">What 中文</label>
          <input data-bkey="what_cn" type="text" value="${v('what_cn')}" placeholder="榛子">
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Claim EN (optional) · 说明(英文,可选)</label>
          <input data-bkey="claim_en" type="text" value="${v('claim_en')}" placeholder="Nuts first, not sugar.">
          <div class="helper">Italic one-liner under the what-label. · 内容标签下方的斜体一行说明。</div>
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Claim 中文 (optional)</label>
          <input data-bkey="claim_cn" type="text" value="${v('claim_cn')}" placeholder="坚果当先,不靠糖分。">
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Slab colour · 色块颜色</label>
          <select data-bkey="bg">
            ${bgOpts.map(c => `<option value="${c}" ${b.bg === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }

  // -------- pull_quote --------
  if (b.type === 'pull_quote') {
    return `
      <div class="helper" style="margin:-4px 0 14px">Editorial sourcing/producer quote on warm tan background. First-person voice from the kitchen. · 编辑式引文,温色背景,第一人称。</div>
      <div class="pa-edit-grid-2">
        <div class="field" style="grid-column:span 2"><label class="stacked">Quote EN · 引文(英文)</label>
          <textarea data-bkey="text_en" rows="3" placeholder='"Our hazelnuts are slow-roasted in small batches…"'>${t('text_en')}</textarea>
        </div>
        <div class="field" style="grid-column:span 2"><label class="stacked">Quote 中文</label>
          <textarea data-bkey="text_cn" rows="3" placeholder='"我们的榛子在小批量中慢烘…"'>${t('text_cn')}</textarea>
        </div>
        <div class="field"><label class="stacked">Attribution EN · 引用来源(英文)</label>
          <input data-bkey="who_en" type="text" value="${v('who_en')}" placeholder="Our kitchen · Guangzhou">
        </div>
        <div class="field"><label class="stacked">Attribution 中文</label>
          <input data-bkey="who_cn" type="text" value="${v('who_cn')}" placeholder="我们的厨房 · 广州">
        </div>
      </div>`;
  }

  return `<div class="helper" style="padding:8px 0">Unknown block type · 未知板块类型: <code>${escapeHtml(b.type || '')}</code></div>`;
}

function paRenderSelectedEditor() {
  const mount = document.getElementById('pa-block-editor-mount'); if (!mount) return;
  const blocks = window._paBlocks || [];
  if (!blocks.length) {
    mount.innerHTML = '<div class="pa-blocks-empty">No sections yet. Use the <strong>+ Add section</strong> dropdown on the left to compose a designed page.<br>暂无板块。在左侧下拉选择类型开始排版。</div>';
    return;
  }
  let b = blocks.find(x => x.id === PA_SELECTED_BLOCK_ID);
  if (!b) { b = blocks[0]; PA_SELECTED_BLOCK_ID = b.id; }

  const tName = PA_TYPE_NAME[b.type] || { en: b.type, cn: '' };
  const glyph = PA_TYPE_GLYPH[b.type] || '🧩';
  const body  = _paBlockEditorBody(b);

  mount.innerHTML = `
    <div class="pa-inspector-head" data-blockid="${b.id}">
      <div class="pa-inspector-head-left">
        <div class="pa-inspector-icon">${glyph}</div>
        <span class="pa-inspector-title">${escapeHtml(tName.en)}</span>
        ${tName.cn ? `<span class="pa-inspector-sub">· ${escapeHtml(tName.cn)}</span>` : ''}
      </div>
      <div class="pa-inspector-actions">
        <button type="button" class="btn" title="Move up · 上移" onclick="paBlocksMove('${b.id}', -1)">↑</button>
        <button type="button" class="btn" title="Move down · 下移" onclick="paBlocksMove('${b.id}', 1)">↓</button>
        <button type="button" class="btn danger" title="Delete block · 删除板块" onclick="paBlocksRemove('${b.id}')">✕</button>
      </div>
    </div>
    <div class="pa-inspector-body">
      ${body}
    </div>`;

  // Wire keystroke → live preview
  mount.querySelectorAll('[data-bkey]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, paLivePreview);
  });
}

// Array-mutating helpers used by the Why / Ingredients / How-to-use editor
// forms. They sync the DOM first (so in-flight edits to OTHER rows aren't
// lost), mutate the selected block's array, then re-render the editor.
function paArrAdd(blockId, key, factory) {
  paBlocksSyncFromDOM();
  const b = (window._paBlocks || []).find(x => x.id === blockId); if (!b) return;
  if (!Array.isArray(b[key])) b[key] = [];
  b[key].push(typeof factory === 'function' ? factory() : { ...factory });
  paRenderAll();
}
function paArrRemove(blockId, key, idx) {
  paBlocksSyncFromDOM();
  const b = (window._paBlocks || []).find(x => x.id === blockId); if (!b) return;
  if (!Array.isArray(b[key])) return;
  if (b[key].length <= 1) return; // keep at least one row
  b[key].splice(idx, 1);
  paRenderAll();
}

function paBlocksCollect() {
  paBlocksSyncFromDOM();
  // Drop blocks where every meaningful field is empty so we don't save
  // ghost rows the office added but never filled. Filtering is per-type
  // so the test for "empty" matches the type's shape.
  const out = (window._paBlocks || []).filter(b => {
    if (b.type === 'hero_intro')     return !!(b.body_en || b.body_cn || b.highlight_en || b.highlight_cn || b.kicker_en || b.kicker_cn);
    if (b.type === 'stat_callout' || b.type === 'big_stat')
                                     return !!(b.stat || b.what_en || b.what_cn || b.claim_en || b.claim_cn);
    if (b.type === 'allergen_card')  return !!(b.contains_en || b.contains_cn || b.may_contain_en || b.may_contain_cn);
    if (b.type === 'spec_strip')     return (b.cells || []).some(c => c.v_en || c.v_cn || c.k_en || c.k_cn);
    if (b.type === 'why')            return (b.rows  || []).some(r => r.claim_en || r.claim_cn);
    if (b.type === 'ingredients_chips' || b.type === 'ingredients_line')
                                     return (b.items || []).some(it => it.name_en || it.name_cn);
    if (b.type === 'how_to_use')     return (b.tiles || []).some(t => t.label_en || t.label_cn || t.icon);
    if (b.type === 'storage_box')    {
      const hasCard = c => c && (c.head_en || c.head_cn || c.num_en || c.num_cn || c.num || c.unit_en || c.unit_cn);
      return hasCard(b.left) || hasCard(b.right) || b.note_en || b.note_cn;
    }
    if (b.type === 'notes_callout')  return !!(b.text_en || b.text_cn);
    if (b.type === 'pull_quote')     return !!(b.text_en || b.text_cn || b.who_en || b.who_cn);
    return true;
  });
  return out.length ? out : null;
}

// ── Live phone-frame preview ─────────────────────────────────────────────
// Mirrors what miniapp/components/product-blocks/* will render — kept in
// lock-step so the office sees the real visual while editing.
function _paInlineHl(body, phrase) {
  if (!phrase || !body) return { html: escapeHtml(body || ''), loose: '' };
  const idx = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx < 0) return { html: escapeHtml(body), loose: phrase };
  return {
    html: escapeHtml(body.slice(0, idx))
        + '<span class="pa-prev-hero-hl">' + escapeHtml(body.slice(idx, idx + phrase.length)) + '</span>'
        + escapeHtml(body.slice(idx + phrase.length)),
    loose: '',
  };
}
function _paSplitChips(s) {
  return String(s || '').split(/[,、，]/g).map(x => x.trim()).filter(Boolean);
}
// Render one block as preview HTML. We render EN side by default (the
// office can re-open the preview in CN once a language toggle is added).
// Each branch here mirrors the matching WXML in product-blocks/ so the
// office sees roughly what they'll get on the phone.
function _paPreviewBlockHtml(b) {
  const esc = escapeHtml;
  const pickT = (en, cn) => ((en || '').trim() || (cn || '').trim());

  if (b.type === 'spec_strip') {
    const cells = (b.cells || []).map(c => ({
      k: pickT(c.k_en, c.k_cn),
      v: pickT(c.v_en, c.v_cn),
    })).filter(c => c.k || c.v);
    if (!cells.length) return '';
    return `<div class="pa-prev-block pa-prev-spec">
      ${cells.map(c => `<div class="pa-prev-spec-cell">
        ${c.k ? `<div class="pa-prev-spec-k">${esc(c.k)}</div>` : ''}
        ${c.v ? `<div class="pa-prev-spec-v">${esc(c.v)}</div>` : ''}
      </div>`).join('')}
    </div>`;
  }

  if (b.type === 'hero_intro') {
    const body    = pickT(b.body_en, b.body_cn);
    const phrase  = pickT(b.highlight_en, b.highlight_cn);
    const kicker  = pickT(b.kicker_en, b.kicker_cn);
    if (!body && !phrase && !kicker) return '';
    const m = _paInlineHl(body, phrase);
    const lead = kicker || m.loose;
    return `<div class="pa-prev-block pa-prev-hero">
      ${lead ? `<div class="pa-prev-hero-lead">${esc(lead)}</div>` : ''}
      ${body ? `<div class="pa-prev-hero-body">${m.html}</div>` : ''}
    </div>`;
  }

  if (b.type === 'why') {
    const rows = (b.rows || []).map(r => pickT(r.claim_en, r.claim_cn)).filter(Boolean);
    if (!rows.length) return '';
    return `<div class="pa-prev-block pa-prev-why">
      <div class="pa-prev-why-head">
        <span class="pa-prev-why-l">Why people choose it</span>
        <span class="pa-prev-why-r">${String(rows.length).padStart(2, '0')}</span>
      </div>
      ${rows.map((c, i) => `<div class="pa-prev-why-row ${i === 0 ? 'first' : ''}">
        <span class="pa-prev-why-n">${String(i + 1).padStart(2, '0')}</span>
        <span class="pa-prev-why-claim">${esc(c)}</span>
      </div>`).join('')}
    </div>`;
  }

  if (b.type === 'ingredients_chips') {
    const items = (b.items || []).map(it => ({
      name: pickT(it.name_en, it.name_cn),
      pct:  it.pct != null && it.pct !== '' ? Number(it.pct) : null,
      lead: !!it.lead,
    })).filter(it => it.name);
    if (!items.length) return '';
    return `<div class="pa-prev-block pa-prev-ing">
      <div class="pa-prev-section-head">
        <span class="pa-prev-section-h3">Ingredients</span>
        <span class="pa-prev-section-tag">${items.length} items · chips</span>
      </div>
      <div class="pa-prev-ing-chips">
        ${items.map(it => `<span class="pa-prev-chip ${it.lead ? 'lead' : ''}">
          ${esc(it.name)}
          ${it.pct != null && !isNaN(it.pct) && it.pct >= 10 ? `<span class="pa-prev-chip-pct">${it.pct}%</span>` : ''}
        </span>`).join('')}
      </div>
    </div>`;
  }

  if (b.type === 'ingredients_line') {
    const items = (b.items || []).map(it => ({
      name: pickT(it.name_en, it.name_cn),
      pct:  it.pct != null && it.pct !== '' ? Number(it.pct) : null,
    })).filter(it => it.name);
    if (!items.length) return '';
    const run = items.map((it, i) => {
      const sep = i > 0 ? '<span class="pa-prev-ing-line-sep"></span>' : '';
      const pct = it.pct != null && !isNaN(it.pct) ? `<span class="pa-prev-ing-line-pct"> ${it.pct}%</span>` : '';
      return `${sep}${esc(it.name)}${pct}`;
    }).join(' ');
    return `<div class="pa-prev-block pa-prev-ing">
      <div class="pa-prev-section-head">
        <span class="pa-prev-section-h3">Ingredients</span>
        <span class="pa-prev-section-tag">editorial run</span>
      </div>
      <div class="pa-prev-ing-line">${run}</div>
    </div>`;
  }

  if (b.type === 'allergen_card') {
    const contains   = _paSplitChips(b.contains_en || b.contains_cn);
    const mayContain = _paSplitChips(b.may_contain_en || b.may_contain_cn);
    const chips = (arr, cls) => arr.map(c => `<span class="pa-prev-allergen-chip ${cls}">${esc(c)}</span>`).join('');
    return `<div class="pa-prev-block pa-prev-allergen">
      <div class="pa-prev-allergen-top">
        <span class="pa-prev-allergen-ttl"><span class="pa-prev-allergen-warn">!</span> Allergens</span>
        <span class="pa-prev-allergen-meta">GB-7718</span>
      </div>
      <div class="pa-prev-allergen-row">
        <span class="pa-prev-allergen-lbl">Contains</span>
        <span class="pa-prev-allergen-chips">${contains.length ? chips(contains, 'strong') : '<span class="pa-prev-allergen-empty">None declared</span>'}</span>
      </div>
      ${mayContain.length ? `<div class="pa-prev-allergen-row">
        <span class="pa-prev-allergen-lbl">May contain<br>traces of</span>
        <span class="pa-prev-allergen-chips">${chips(mayContain, 'soft')}</span>
      </div>` : ''}
    </div>`;
  }

  if (b.type === 'how_to_use') {
    const tiles = (b.tiles || []).map(t => ({
      icon: t.icon || '',
      lbl:  pickT(t.label_en, t.label_cn),
      sub:  pickT(t.sub_en, t.sub_cn),
    })).filter(t => t.lbl || t.icon);
    if (!tiles.length) return '';
    const cols = tiles.length >= 8 ? 4 : 3;
    return `<div class="pa-prev-block pa-prev-how">
      <div class="pa-prev-section-head">
        <span class="pa-prev-section-h3">How to use</span>
        <span class="pa-prev-section-tag">${tiles.length} moments</span>
      </div>
      <div class="pa-prev-how-grid" style="grid-template-columns:repeat(${cols},1fr)">
        ${tiles.map(t => `<div class="pa-prev-how-tile">
          ${t.icon ? `<span class="pa-prev-how-ic">${esc(t.icon)}</span>` : ''}
          ${t.lbl  ? `<span class="pa-prev-how-lbl">${esc(t.lbl)}</span>` : ''}
          ${t.sub  ? `<span class="pa-prev-how-sub">${esc(t.sub)}</span>` : ''}
        </div>`).join('')}
      </div>
    </div>`;
  }

  if (b.type === 'storage_box') {
    const cardHtml = (c) => {
      if (!c) return '';
      const head = pickT(c.head_en, c.head_cn);
      const unit = pickT(c.unit_en, c.unit_cn);
      const num  = (pickT(c.num_en, c.num_cn) || c.num || '').toString();
      if (!head && !num && !unit) return '';
      return `<div class="pa-prev-storage-card ${c.alt ? 'alt' : ''}">
        ${c.icon ? `<span class="pa-prev-storage-ic">${esc(c.icon)}</span>` : ''}
        ${head ? `<div class="pa-prev-storage-head">${esc(head)}</div>` : ''}
        ${num ? `<div class="pa-prev-storage-num">${esc(num)}</div>` : ''}
        ${unit ? `<div class="pa-prev-storage-unit">${esc(unit)}</div>` : ''}
      </div>`;
    };
    const L = cardHtml(b.left);
    const R = cardHtml(b.right);
    const note = pickT(b.note_en, b.note_cn);
    if (!L && !R && !note) return '';
    return `<div class="pa-prev-block pa-prev-storage">
      <div class="pa-prev-section-head">
        <span class="pa-prev-section-h3">Storage</span>
        <span class="pa-prev-section-tag">keep it right</span>
      </div>
      <div class="pa-prev-storage-pair">${L}${R}</div>
      ${note ? `<div class="pa-prev-storage-note">${esc(note)}</div>` : ''}
    </div>`;
  }

  if (b.type === 'notes_callout') {
    const text = pickT(b.text_en, b.text_cn);
    if (!text) return '';
    return `<div class="pa-prev-block pa-prev-notes"><div class="pa-prev-notes-p">${esc(text)}</div></div>`;
  }

  if (b.type === 'big_stat' || b.type === 'stat_callout') {
    const stat  = (b.stat || '').toString().trim();
    const what  = pickT(b.what_en || b.claim_en, b.what_cn || b.claim_cn);
    const claim = pickT(b.sub_en || b.claim_en, b.sub_cn || b.claim_cn);
    if (!stat && !what && !claim) return '';
    // Slab background — direct hex map keeps the preview self-contained
    // (the mini-app side reads var(--lime) etc. inside the component scope).
    const BG = {
      lime: '#CCD900', carrot: '#FF6B0C', pink: '#F4B8CB',
      corn: '#F2CA6C', sky: '#B2CFED', lotus: '#EEB8E4',
      papaya: '#FFAF60', cucumber: '#A8D185',
    };
    const bg = BG[b.bg] || BG.lime;
    return `<div class="pa-prev-block pa-prev-stat" style="background:${bg}">
      ${stat ? `<div class="pa-prev-stat-num">${esc(stat)}</div>` : ''}
      ${what ? `<div class="pa-prev-stat-claim">${esc(what)}</div>` : ''}
      ${claim ? `<div class="pa-prev-stat-sub">${esc(claim)}</div>` : ''}
    </div>`;
  }

  if (b.type === 'pull_quote') {
    const text = pickT(b.text_en, b.text_cn);
    const who  = pickT(b.who_en,  b.who_cn);
    if (!text && !who) return '';
    return `<div class="pa-prev-block pa-prev-pullquote">
      ${text ? `<div class="pa-prev-pullquote-p">"${esc(text)}"</div>` : ''}
      ${who  ? `<div class="pa-prev-pullquote-who">${esc(who)}</div>` : ''}
    </div>`;
  }

  return '';
}
// Mirror of the mini-app's category → IP-character mapping in product.js.
// Keep this synced so the retail-admin preview shows the same default
// character the customer will actually see on the phone.
const PA_COLOPHON_AUTO_MAP = [
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
function _paResolveColophonChar(override, category) {
  if (override) return override;
  const cat = (category || '').toLowerCase();
  const hit = PA_COLOPHON_AUTO_MAP.find(([rx]) => rx.test(cat));
  return hit ? hit[1] : 'soilsoul';
}

function paRenderPreview() {
  const screen = document.getElementById('pa-preview-screen'); if (!screen || !PA_CURRENT) return;
  const p = PA_CURRENT;
  // Read latest values directly from inputs (no full DOM sync — these
  // are simple text inputs that we read by id every paint).
  const kwEN = document.getElementById('pa-edit-keywords-en').value || '';
  const kwCN = document.getElementById('pa-edit-keywords-cn').value || '';
  const tgEN = document.getElementById('pa-edit-tagline-en').value  || '';
  const tgCN = document.getElementById('pa-edit-tagline-cn').value  || '';
  const keywords = kwEN || kwCN;
  const tagline  = tgEN || tgCN;
  const otherLang = p.name_cn || '';

  // Colophon state
  const colChar    = (document.getElementById('pa-edit-colophon-character').value || '').trim();
  const colTagEN   = (document.getElementById('pa-edit-colophon-tagline-en').value || '').trim();
  const colTagCN   = (document.getElementById('pa-edit-colophon-tagline-cn').value || '').trim();
  const colResChar = _paResolveColophonChar(colChar, p.category);
  const colResTag  = colTagEN || colTagCN || 'From Soil to Soul';
  const colIsAuto  = !colChar;

  const img = p.image_data || p.image_url || '';
  const heroStyle = img ? `background-image:url('${escapeAttr(img)}'); background-color:transparent;` : '';
  const blocksHtml = (window._paBlocks || []).map(_paPreviewBlockHtml).filter(Boolean).join('');

  screen.innerHTML = `
    <div class="pa-prev-hero" style="${heroStyle}">${img ? '' : '🛍'}</div>
    <div class="pa-prev-body">
      <div class="pa-prev-name">${escapeHtml(p.name_en || '—')}</div>
      ${(otherLang || keywords) ? `<div class="pa-prev-subtitle">
        ${otherLang ? escapeHtml(otherLang) : ''}${otherLang && keywords ? ' · ' : ''}${keywords ? escapeHtml(keywords) : ''}
      </div>` : ''}
      ${tagline ? `<div class="pa-prev-tagline">${escapeHtml(tagline)}</div>` : ''}
      ${blocksHtml || (!keywords && !tagline ? '<div class="pa-prev-empty">No designer sections yet. Add one to compose the page.</div>' : '')}
      <div class="pa-prev-colophon">
        <img class="pa-prev-colophon-img" src="/assets/brand/ip-${colResChar}.jpg" alt="">
        <div class="pa-prev-colophon-tagline">${escapeHtml(colResTag)}</div>
        <div class="pa-prev-colophon-meta">
          <span class="pa-prev-colophon-rule"></span>
          <span>Roots · ESTD 2017</span>
          <span class="pa-prev-colophon-rule"></span>
        </div>
        ${colIsAuto ? '<div class="pa-prev-colophon-auto">auto · 自动</div>' : ''}
      </div>
    </div>`;
}

// Wire chrome inputs once on first script eval; they live in static markup,
// so a single hook is enough for the lifetime of the page.
[
  'pa-edit-keywords-en', 'pa-edit-keywords-cn',
  'pa-edit-tagline-en',  'pa-edit-tagline-cn',
  'pa-edit-colophon-tagline-en', 'pa-edit-colophon-tagline-cn',
].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', paRenderPreview);
});

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
    + '<div class="vw-help" style="margin:-2px 0 6px;">' + cuT('Pick whatever’s easiest. You can change anything later.', '选最方便的方式,之后都能修改。') + '</div>'
    + '<div class="vw-goals">'
    + cards.map(c => '<button class="vw-goal" onclick="pwFront(\'' + c[0] + '\')"><span class="vico">' + pwIcon(c[1], 26) + '</span>'
        + '<span><span class="gt">' + c[2] + '</span><br><span class="gs">' + c[3] + '</span></span></button>').join('')
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

