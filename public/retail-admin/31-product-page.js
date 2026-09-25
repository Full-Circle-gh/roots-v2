/* eslint-disable no-undef */
/* retail-admin app JS — part 31.  The full product page (§206, 2026-09-21).
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. This file loads LAST. It defines
   pdIsExpanded / pdExpand / pdCollapseToPanel / pdToggleFullscreen /
   pdSyncPageHead, which 09-products.js calls, and it reads the editor's own
   state (_pdSelectedId, _paEditorOpen, PA_PRODUCTS, PD_FACT_FIELDS, the
   _pdDesign* flags) and the Settings cache (_cfgCache, 05-marketing.js).

   WHAT THIS PAGE IS (Ash, 2026-09-21, from three mockups: "build a from
   scratch, dont patch on the old design"). The old expanded page was the
   dock's five panes switched on at once and stacked, with the tab strip
   hidden — five screens glued end to end. This is a page: a crumb, a header,
   a rail of sections on the left, ONE section at a time in the middle, and a
   right column that never moves. The rail is painted from the tenant's own
   order and hiding (Settings › Operations › Product page), and the page
   remembers the section an operator had open.

   WHAT IS CARRIED, NOT COPIED. Every field on the page is the dock's own
   node. Opening the page carries the blocks named in PPG_SECTIONS out of
   #pd-editor into the page's mounts; collapsing carries each one home to the
   exact parent and sibling it left. One node per field, so ids, typed-but-
   unsaved values, the rich-text editor's contents and every va-, bu-, bp-, opt- and
   bl- renderer keep working without a line of sync code — the discipline the
   editor has kept through every regrouping (§144's warning about a second
   copy that drifts). Carried OUT of #pd-editor on purpose: the thousands of
   `#pd-editor …` rules in retail-admin.css stop reaching the blocks, and the
   `.ppg` block dresses them fresh from the design system's own values.

   THE ORDER OF CARRYING IS LOAD-BEARING. A block's remembered `next` sibling
   is either a node that never moves or a node carried AFTER it, so restoring
   in reverse always finds the anchor home first. Keep PPG_SECTIONS' carry
   lists and PPG_SIDE in dock DOM order; the right column's visual order is
   CSS `order`, never the carry order.

   THE ONE PIECE OF MARKUP THE PAGE OWNS is the Shopper page summary (#ppg-
   page-card). The classic description and the Product details boxes stay
   this form's fields — Edit unfolds them under the summary — so a product
   with no designed page keeps its only editor (82 of 342 products carry no
   blocks, §144).

   ── LANGUAGE ────────────────────────────────────────────────────────────
   Static pairs live in the markup and are split by the language pass.
   Everything painted here goes through cuT(). Every composed Chinese string
   is declared in docs/tacet-delivery-vocabulary.md v1.145 with the live
   candidates it was built from; the section names are copied from the dock's
   own tab strip and headings.
*/

// ── The sections, in the house's default order ──────────────────────────────
// `carry`: the dock nodes the section shows, by id, IN DOCK ORDER (see the
// header). `locked`: cannot be hidden — a product needs a name. `what`: the
// one-line description the Settings card shows under the section's name.
const PPG_SECTIONS = [
  { key: 'basics', en: 'Basics', cn: '基础', carry: ['#pd-sec-basics'], locked: true,
    what_en: 'Name, second-language name, SKU, photos', what_cn: '名称、名称(第二语言)、货号、图片' },
  { key: 'where', en: 'Where it shows', cn: '分类与陈列', carry: ['#pd-sec-where'],
    what_en: 'Shop section, subcategory, badge, size or weight', what_cn: '商店分区、子分类、标签、规格' },
  { key: 'cost', en: 'Cost & Pricing', cn: '成本与定价', carry: ['#pd-sec-cost'],
    what_en: 'What one unit is made of, cost, price, margin', what_cn: '成本、价格、毛利' },
  { key: 'stock', en: 'Stock', cn: '库存', carry: ['#pd-sec-stock', '#pd-sec-sourcing'],
    what_en: 'On hand per store, low-stock alert, out-of-stock rule, sourcing', what_cn: '各门店库存、低库存提醒、缺货时的处理方式、货源' },
  { key: 'sold', en: 'How it’s sold', cn: '售卖方式', carry: ['#pd-sec-sizes'],
    what_en: 'Sizes, bundles, add-ons, options', what_cn: '规格、套装、推荐搭配、选项' },
  { key: 'page', en: 'Shopper page', cn: '顾客页面', carry: [],
    what_en: 'Description, product details, designed page', what_cn: '描述、产品详情、已设计页面' },
];
// The right column, in dock DOM order. Its visual order is CSS. The three
// chip groups go into one card (#ppg-details) as rows; the rest stand alone.
const PPG_SIDE = ['#pd-sales-card', '#pd-foot-acts'];
const PPG_DETAILS = ['#pd-sec-shipping', '#pd-sec-flags', '#pd-sec-freeof', '#pd-sec-notes'];
// The writing cards, carried only when Edit unfolds them.
const PPG_WRITE = ['#pd-sec-facts', '#pd-sec-desc'];
// Where the dock's summary rows point (pdExpand('sizes') / ('more')) now land.
const PPG_ALIASES = { sizes: 'sold', more: 'sold', details: null };
const PPG_LAST_KEY = 'ppg-section';

// ── The tenant's layout ─────────────────────────────────────────────────────
// storefront_config['product_page.sections'] = { order: [keys], hidden: [keys] }.
// Pure, and forgiving on purpose: an unknown key is dropped, a missing one is
// appended in default order, a locked one can never be hidden, a duplicate is
// kept once. A stored layout from a version with different sections still
// resolves to a page with every section on it.
function ppgResolveLayout(raw) {
  const known = PPG_SECTIONS.map(s => s.key);
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const order = [];
  for (const k of (Array.isArray(cfg.order) ? cfg.order : [])) {
    if (known.includes(k) && !order.includes(k)) order.push(k);
  }
  for (const k of known) if (!order.includes(k)) order.push(k);
  const hidden = [];
  for (const k of (Array.isArray(cfg.hidden) ? cfg.hidden : [])) {
    const s = PPG_SECTIONS.find(x => x.key === k);
    if (s && !s.locked && !hidden.includes(k)) hidden.push(k);
  }
  return { order, hidden };
}
function ppgStoredLayout(cfg) {
  const c = cfg || (typeof _cfgCache !== 'undefined' ? _cfgCache : null);
  return c && c.product_page && c.product_page.sections;
}
function ppgLayout() { return ppgResolveLayout(ppgStoredLayout()); }
function ppgVisibleKeys() { const l = ppgLayout(); return l.order.filter(k => !l.hidden.includes(k)); }
function ppgSection(key) { return PPG_SECTIONS.find(s => s.key === key) || null; }

// ── Carrying nodes out and home ─────────────────────────────────────────────
let _ppgHomes = [];
let _ppgOpen = false;
let _ppgCurrent = null;
let _ppgListScroll = 0;

function ppgCarry(sel, into) {
  const el = document.querySelector(sel);
  if (!el || !into) return null;
  _ppgHomes.push({ el, parent: el.parentElement, next: el.nextElementSibling });
  into.appendChild(el);
  return el;
}
// Back-to-front: each block's remembered `next` is either static or a block
// carried after it, so restoring in reverse means the anchor is home first.
function ppgCarryHome() {
  for (const h of _ppgHomes.slice().reverse()) {
    if (!h.parent) continue;
    const anchor = h.next && h.next.parentElement === h.parent ? h.next : null;
    h.parent.insertBefore(h.el, anchor);
  }
  _ppgHomes = [];
}
function ppgMount(key) { return document.querySelector('#ppg .ppg-mount[data-mount="' + key + '"]'); }
function ppgCarryAll() {
  const keys = ppgVisibleKeys();
  for (const s of PPG_SECTIONS) {
    if (!keys.includes(s.key)) continue;
    const m = ppgMount(s.key);
    if (!m) continue;
    for (const sel of s.carry) ppgCarry(sel, m);
  }
  // Photos belong to Basics, not beside it: the lower half of the card, under
  // a hairline. Carried after Where it shows so the restore order holds.
  const basics = document.getElementById('pd-sec-basics');
  if (basics && basics.closest('#ppg')) ppgCarry('#pd-sec-photos', basics);
  // Sales first, then the three chip groups (consecutive in the dock, so the
  // restore order holds), then notes and the record's actions.
  const side = ppgMount('side');
  const details = document.getElementById('ppg-details');
  ppgCarry(PPG_SIDE[0], side);
  for (const sel of PPG_DETAILS) ppgCarry(sel, details);
  for (const sel of PPG_SIDE.slice(1)) ppgCarry(sel, side);
  // The notes card's "(staff only — never shown to shoppers)" aside is hidden
  // on the page; the box says it instead, in the words its aria-label already
  // carries, until something is typed.
  const notes = document.getElementById('pd-notes');
  if (notes && !notes.placeholder) notes.placeholder = cuT('Never shown to shoppers', '顾客不可见');
  // The shop switch and the save state: one node each, parked in the header.
  ppgCarry('#pd-head-tags', document.getElementById('ppg-tags'));
  ppgCarry('#pd-save-status', document.getElementById('ppg-state'));
}

// ── Open · show · close ─────────────────────────────────────────────────────
function pdIsExpanded() { return _ppgOpen; }

// `section` is what the dock's summary rows pass ('basics', 'stock', 'sizes',
// 'more', 'page', 'details'); without one the page opens on the section the
// operator had last, or the first the tenant shows.
function pdExpand(section) {
  const ed = document.getElementById('pd-editor');
  const stage = document.getElementById('ppg');
  if (!ed || !stage || ed.style.display === 'none') return;   // nothing open
  if (!_ppgOpen) {
    _ppgOpen = true;
    // The drawer chrome and its scrim go first, or a fixed-position shell
    // would stay on screen over the page.
    pdCloseDrawer();
    ppgCarryAll();
    document.getElementById('tab-products')?.classList.add('pd-page-open');
    stage.style.display = '';
    // Esc goes back to the list, as it did from the drawer (pdDrawerEsc still
    // lets any overlay stacked on top answer first).
    document.addEventListener('keydown', pdDrawerEsc);
    ppgWire();
    ppgRenderRail();
    pdSyncPageHead();
    ppgRenderPageCard();
    ppgWatchStock(true);
    // Remember where the list was, so going back lands on the row just opened.
    _ppgListScroll = window.scrollY;
    window.scrollTo({ top: 0, behavior: 'auto' });
    ppgFitSide();
    window.addEventListener('resize', ppgFitSide);
  }
  ppgShow(ppgPick(section));
}
// The right column is capped at the bottom of the window from where it
// starts on the unscrolled page, so the page never has to scroll for it; on
// a short screen the column scrolls inside itself. CSS cannot know where the
// column starts, so this measures it.
function ppgFitSide() {
  const side = document.getElementById('ppg-side');
  if (!side || !_ppgOpen) return;
  const top = side.getBoundingClientRect().top + window.scrollY;
  const cap = Math.max(240, window.innerHeight - top - 16);
  side.style.setProperty('--ppg-side-cap', cap + 'px');
}
function ppgPick(section) {
  const keys = ppgVisibleKeys();
  const want = Object.prototype.hasOwnProperty.call(PPG_ALIASES, section) ? PPG_ALIASES[section] : section;
  if (want && keys.includes(want)) return want;
  let last = null;
  try { last = localStorage.getItem(PPG_LAST_KEY); } catch (e) { last = null; }
  if (last && keys.includes(last)) return last;
  return keys[0];
}
function ppgShow(key, fromRail) {
  if (!key) return;
  _ppgCurrent = key;
  document.querySelectorAll('#ppg .ppg-sec').forEach(s => { s.hidden = s.getAttribute('data-sec') !== key; });
  document.querySelectorAll('#ppg-rail button[data-sec]').forEach(b => {
    const on = b.getAttribute('data-sec') === key;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  try { localStorage.setItem(PPG_LAST_KEY, key); } catch (e) { /* private window: the page simply opens on the first section next time */ }
  if (fromRail) {
    const head = document.querySelector('#ppg .ppg-body');
    if (head && head.getBoundingClientRect().top < 56) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
function pdCollapseToPanel() {
  if (!_ppgOpen) return;
  _ppgOpen = false;
  _ppgCurrent = null;
  ppgWatchStock(false);
  window.removeEventListener('resize', ppgFitSide);
  document.removeEventListener('keydown', pdDrawerEsc);
  ppgCarryHome();
  ppgWriteReset();
  const stage = document.getElementById('ppg');
  if (stage) stage.style.display = 'none';
  document.getElementById('tab-products')?.classList.remove('pd-page-open');
  // The drawer does NOT come back: it is retired as a view (2026-09-25), so
  // this only brings the nodes home. Callers either close the product
  // (pdClose) or open the next one straight onto the page (pdOpen).
  // State can have moved while the page was open (a size added, a bundle set
  // up, a description written) — repaint the summaries that stand for it.
  pdRenderSummaries();
  window.scrollTo({ top: _ppgListScroll, behavior: 'auto' });
}
// The dock's Expand button. The drawer that showed it is never opened now;
// kept so the seam 09-products.js and the tests name stays whole.
function pdToggleFullscreen() { if (_ppgOpen) pdCollapseToPanel(); else pdExpand(); }

// ── The header: read from the live form, so a rename typed a second ago is
//    already up top ─────────────────────────────────────────────────────────
function pdSyncPageHead() {
  if (!_ppgOpen) return;
  const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const nm = val('pd-name-en'), alt = val('pd-name-cn');
  set('ppg-name', nm || alt || cuT('New product', '新产品'));
  set('ppg-name-alt', nm && alt ? alt : '');
  const p = (PA_PRODUCTS || []).find(x => x.id === _pdSelectedId);
  const img = p && (p.image_data || p.image_url);
  const th = document.getElementById('ppg-thumb');
  if (th) th.style.backgroundImage = img ? 'url("' + img + '")' : '';
  const sel = (id) => {
    const el = document.getElementById(id);
    if (!el || !el.selectedOptions || !el.selectedOptions[0]) return '';
    const t = (el.selectedOptions[0].textContent || '').trim();
    return t.startsWith('—') ? '' : t;
  };
  const bits = [];
  const sku = val('pd-sku');
  if (sku) bits.push(cuT('SKU ', '货号 ') + sku);
  const where = [sel('pd-top-category'), sel('pd-subcategory')].filter(Boolean).join(', ');
  if (where) bits.push(where);
  const price = val('pd-price');
  if (price) bits.push(acWrap(price));
  set('ppg-sub', bits.join(' · '));
}

// ── The rail ────────────────────────────────────────────────────────────────
function ppgRenderRail() {
  const rail = document.getElementById('ppg-rail');
  if (!rail) return;
  rail.innerHTML = ppgVisibleKeys().map(k => {
    const s = ppgSection(k);
    const on = k === _ppgCurrent;
    return '<button type="button" data-sec="' + k + '"' + (on ? ' class="is-on" aria-current="true"' : '')
      + ' onclick="ppgShow(\'' + k + '\', true)">' + escapeHtml(cuT(s.en, s.cn))
      + (k === 'stock' ? '<span class="ppg-rail-k" id="ppg-rail-stock"></span>' : '')
      + '</button>';
  }).join('')
  + '<div class="ppg-rail-hint">' + escapeHtml(cuT('Sales, shipping, flags and notes stay on the right.', '销量、配送方式、标记和备注固定显示在右侧。')) + '</div>';
  ppgRailStock();
}
// "19 on hand" under Stock, read from the headline the Stock card already
// paints, so the two can never disagree.
function ppgRailStock() {
  const k = document.getElementById('ppg-rail-stock');
  if (!k) return;
  const wrap = document.getElementById('pd-onhand');
  const n = document.getElementById('pd-onhand-n');
  const txt = n ? (n.textContent || '').trim() : '';
  k.textContent = (wrap && !wrap.hidden && txt && txt !== '—') ? txt + ' ' + cuT('on hand', '在库') : '';
}
// The headline lands after an async stock fetch, so watch it rather than
// asking the Stock card to know about the rail.
let _ppgStockObs = null;
function ppgWatchStock(on) {
  if (_ppgStockObs) { _ppgStockObs.disconnect(); _ppgStockObs = null; }
  if (!on || typeof MutationObserver !== 'function') return;
  const wrap = document.getElementById('pd-onhand');
  if (!wrap) return;
  _ppgStockObs = new MutationObserver(ppgRailStock);
  _ppgStockObs.observe(wrap, { subtree: true, childList: true, characterData: true, attributes: true });
}

// ── The Shopper page summary ────────────────────────────────────────────────
function ppgRenderPageCard() {
  if (!_ppgOpen) return;
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const text = (id) => ((document.getElementById(id) || {}).textContent || '').trim();
  const written = !!(text('pd-rte-en') || text('pd-rte-cn'));
  set('ppg-page-desc', written ? cuT('Written', '已填写') : cuT('Not written yet', '尚未填写'));
  const facts = typeof pdFactsGet === 'function' ? pdFactsGet() : {};
  const fields = typeof PD_FACT_FIELDS !== 'undefined' ? PD_FACT_FIELDS : [];
  const n = fields.filter(([, col]) => facts[col + '_en'] || facts[col + '_cn']).length;
  set('ppg-page-facts', cuT(n + ' of ' + fields.length + ' filled', '已填写 ' + n + '/' + fields.length));
  const stale = (typeof _pdDesignStale !== 'undefined' && _pdDesignStale) || (typeof _pdDesignFromId !== 'undefined' && !!_pdDesignFromId);
  const designed = typeof _pdDesignExists !== 'undefined' && _pdDesignExists;
  set('ppg-page-design', stale ? cuT('Designed page — out of date', '已设计页面 — 已过期')
    : designed ? cuT('Designed page', '已设计页面')
    : cuT('Default template', '默认模板'));
}
// Edit unfolds the classic description and the Product details boxes under
// the summary. Carried on first use only; they go home with everything else.
function ppgWriteToggle() {
  const mount = document.getElementById('ppg-write');
  const btn = document.getElementById('ppg-write-btn');
  if (!mount) return;
  const open = mount.hidden;
  if (open && !mount.children.length) for (const sel of PPG_WRITE) ppgCarry(sel, mount);
  mount.hidden = !open;
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? cuT('Close', '关闭') : cuT('Edit', '编辑');
  }
  if (open) {
    const first = mount.querySelector('input, textarea');
    if (first) first.focus({ preventScroll: true });
  }
}
function ppgWriteReset() {
  const mount = document.getElementById('ppg-write');
  const btn = document.getElementById('ppg-write-btn');
  if (mount) mount.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = cuT('Edit', '编辑'); }
}

// ── Listening ───────────────────────────────────────────────────────────────
// The autosave engine listens on #pd-editor. The carried nodes are outside it
// while the page is open, so the page listens too — with the SAME handler.
let _ppgWired = false;
function ppgWire() {
  if (_ppgWired) return;
  _ppgWired = true;
  const stage = document.getElementById('ppg');
  if (!stage) return;
  const onEdit = (e) => {
    if (typeof pdEditorEdit === 'function') pdEditorEdit(e);
    ppgRenderPageCard();
    ppgRailStock();
  };
  stage.addEventListener('input', onEdit);
  stage.addEventListener('change', onEdit);
}

// ── Settings › Operations › Product page ────────────────────────────────────
// Painted from the stored value on every config load (05-marketing.js
// loadConfig → ppgSettingsRender) and after each of its own saves.
function ppgSettingsRender(cfg) {
  const host = document.getElementById('ppg-setrows');
  if (!host) return;
  const lay = ppgResolveLayout(ppgStoredLayout(cfg));
  const grip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg>';
  host.innerHTML = lay.order.map((k, i) => {
    const s = ppgSection(k);
    const off = lay.hidden.includes(k);
    const sw = s.locked
      ? '<span class="ppg-setlock">' + escapeHtml(cuT('Always shown', '始终显示')) + '</span>'
      : '<button type="button" class="ppg-sw' + (off ? '' : ' is-on') + '" role="switch" aria-checked="' + (off ? 'false' : 'true')
        + '" aria-label="' + escapeAttr(cuT('Show this section', '显示此分区')) + '" onclick="ppgSettingsToggle(\'' + k + '\')"><i></i></button>';
    return '<div class="ppg-setrow' + (off ? ' is-off' : '') + '" data-sec="' + k + '" draggable="true">'
      + '<span class="ppg-grip" title="' + escapeAttr(cuT('Drag to reorder', '拖动以排序')) + '">' + grip + '</span>'
      + '<div class="ppg-setwhat"><div class="n">' + escapeHtml(cuT(s.en, s.cn)) + '</div><div class="d">' + escapeHtml(cuT(s.what_en, s.what_cn)) + '</div></div>'
      + '<span class="ppg-setmove">'
      + '<button type="button" onclick="ppgSettingsMove(\'' + k + '\', -1)" aria-label="' + escapeAttr(cuT('Move up', '上移')) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
      + '<button type="button" onclick="ppgSettingsMove(\'' + k + '\', 1)" aria-label="' + escapeAttr(cuT('Move down', '下移')) + '"' + (i === lay.order.length - 1 ? ' disabled' : '') + '>↓</button>'
      + '</span>'
      + sw + '</div>';
  }).join('');
  ppgSettingsWireDrag(host);
}
function ppgSettingsCurrent() {
  const rows = [...document.querySelectorAll('#ppg-setrows .ppg-setrow')];
  return {
    order: rows.map(r => r.getAttribute('data-sec')),
    hidden: rows.filter(r => r.classList.contains('is-off')).map(r => r.getAttribute('data-sec')),
  };
}
function ppgSettingsToggle(key) {
  const row = document.querySelector('#ppg-setrows .ppg-setrow[data-sec="' + key + '"]');
  const s = ppgSection(key);
  if (!row || !s || s.locked) return;
  row.classList.toggle('is-off');
  ppgSettingsSave();
}
function ppgSettingsMove(key, dir) {
  const row = document.querySelector('#ppg-setrows .ppg-setrow[data-sec="' + key + '"]');
  if (!row) return;
  const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sib) return;
  if (dir < 0) row.parentElement.insertBefore(row, sib);
  else row.parentElement.insertBefore(sib, row);
  ppgSettingsSave();
  const again = document.querySelector('#ppg-setrows .ppg-setrow[data-sec="' + key + '"] .ppg-setmove button' + (dir < 0 ? ':first-child' : ':last-child'));
  if (again && !again.disabled) again.focus();
}
function ppgSettingsReset() {
  ppgSettingsRender({ product_page: { sections: null } });
  ppgSettingsSave();
}
let _ppgDragRow = null;
function ppgSettingsWireDrag(host) {
  if (host._ppgDragWired) return;
  host._ppgDragWired = true;
  host.addEventListener('dragstart', (e) => {
    _ppgDragRow = e.target.closest('.ppg-setrow');
    if (_ppgDragRow) { _ppgDragRow.classList.add('is-dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _ppgDragRow.getAttribute('data-sec')); } catch (err) { /* dataTransfer can refuse setData on some engines; the drag still works without it */ } }
  });
  host.addEventListener('dragover', (e) => {
    if (!_ppgDragRow) return;
    e.preventDefault();
    const over = e.target.closest('.ppg-setrow');
    if (!over || over === _ppgDragRow) return;
    const r = over.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    host.insertBefore(_ppgDragRow, after ? over.nextSibling : over);
  });
  host.addEventListener('dragend', () => {
    if (!_ppgDragRow) return;
    _ppgDragRow.classList.remove('is-dragging');
    _ppgDragRow = null;
    ppgSettingsSave();
  });
}
let _ppgSaveSeq = 0;
async function ppgSettingsSave() {
  const val = ppgSettingsCurrent();
  const st = document.getElementById('ppg-set-status');
  const seq = ++_ppgSaveSeq;
  if (st) st.textContent = cuT('Saving…', '保存中…');
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'product_page.sections': val } });
    if (seq !== _ppgSaveSeq) return;   // a later change is already on its way
    if (typeof _cfgCache !== 'undefined' && _cfgCache) {
      _cfgCache.product_page = Object.assign({}, _cfgCache.product_page || {}, { sections: val });
    }
    ppgSettingsRender();
    if (st) st.textContent = cuT('Saved', '已保存');
    // A page already open follows the new order at once.
    if (_ppgOpen) {
      ppgWatchStock(false);
      ppgCarryHome();
      ppgWriteReset();
      ppgCarryAll();
      ppgRenderRail();
      ppgWatchStock(true);
      ppgShow(ppgPick(_ppgCurrent));
    }
  } catch (e) {
    if (st) st.textContent = cuT('Save failed: ', '保存失败: ') + (e && e.message ? e.message : '');
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && typeof window.onLangChange === 'function') {
  window.onLangChange(() => {
    ppgSettingsRender();
    if (_ppgOpen) { ppgRenderRail(); ppgRenderPageCard(); pdSyncPageHead(); ppgWriteReset(); }
  });
}
