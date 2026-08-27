/* eslint-disable no-undef */
/* retail-admin app JS — part 18.  Materials (物料), 2026-08-24.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, cuT, can, applyCapGates, goTab) live in 01-core.js.

   Materials = what a business buys and holds but does not sell: food,
   packaging, equipment, supplies. Same `ingredients` table the kitchen app
   writes; this is the multi-tenant door onto it (routes/retail-materials.js).

   TWO SCREENS, TWO SECTIONS. The list paints into #mat-root inside
   <section id="tab-materials">. The record is a FULL PAGE in its own sibling
   <section id="tab-materials-record"> — reached through the RAIL_STANDIN
   takeover, the same mechanism New Order uses. That is a decided choice, not
   an oversight: §28 addendum item 3 records it, and it survives Purchasing
   next door using a drawer. Don't "correct" it to match Purchasing.

   Prefix is mat-*, not mt-* — Meituan already owns mt-. */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
  const money = n => '¥' + (typeof fmt === 'function' ? fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2));
  // A missing value reads as a dash, never as zero or an empty cell — the
  // catalogue has real gaps (blank finance category, unrecorded pack contents)
  // and hiding them is how they stay unfixed.
  const dash = v => (v === null || v === undefined || v === '' ? '—' : v);

  const KIND_LABEL = {
    food:      () => T('Food', '食品'),
    packaging: () => T('Packaging', '包装'),
    equipment: () => T('Equipment', '设备'),
    retail:    () => T('Retail', '零售'),
    other:     () => T('Other', '其他'),
  };
  const kindLabel = k => (KIND_LABEL[k] ? KIND_LABEL[k]() : k);

  // §29 step 6 — same reason strings 19-recipes.js's own BLOCK_REASON uses
  // (lib/recipe-rollup.js costOneRecipe's reason codes, one for one), so a
  // made material's "why is my cost frozen" reads identically whichever
  // record it's read from. Kept as its own small copy rather than a shared
  // import — this file has no module system, only sequential <script> globals.
  const SRC_BLOCK_REASON = {
    recipe_archived:     () => T('This recipe is archived.', '该食谱已归档。'),
    no_ingredient_lines: () => T('This recipe has no ingredient lines yet.', '该食谱尚无原料明细。'),
    unpriced_lines:       n => T(`${n} ingredient${n === 1 ? '' : 's'} in this recipe ${n === 1 ? 'is' : 'are'} missing a cost.`,
                                  `该食谱中有 ${n} 项原料缺少成本。`),
    no_batch_size:       () => T('This recipe has no batch size set.', '该食谱未设置批量大小。'),
    no_cost_per_unit:    () => T("This recipe's cost can't be worked out right now.", '该食谱的成本暂无法计算。'),
  };
  function srcBlockReasonText(block) {
    const f = SRC_BLOCK_REASON[block.reason];
    if (!f) return T("This recipe's cost can't be worked out right now.", '该食谱的成本暂无法计算。');
    return block.reason === 'unpriced_lines' ? f(block.unpriced) : f();
  }

  // Unit menus. Sourced from lib/ingredient-cost.js when it has loaded, so the
  // form can never offer a unit the shared cost maths cannot divide by.
  const COST = () => (typeof window !== 'undefined' && window.RootsIngredientCost) || null;
  const RECIPE_UNITS = () => {
    const c = COST();
    return c ? [].concat(c.DIVISIBLE_RECIPE_UNITS, c.PER_PIECE_RECIPE_UNITS) : ['g', 'ml', 'pcs'];
  };
  const BUY_UNITS = () => {
    const c = COST();
    return c ? [].concat(c.MEASURE_BUY_UNITS, c.CONTAINER_BUY_UNITS) : ['kg', 'g', 'L', 'ml', 'pcs', 'box', 'bag', 'bottle'];
  };
  const isContainer = u => {
    const c = COST();
    return c ? c.CONTAINER_BUY_UNITS.indexOf(c.normaliseUnit(u)) >= 0 : false;
  };

  // ── module state ──────────────────────────────────────────────────────────
  let _init = false;
  let _rows = [];
  let _counts = {};
  let _kinds = [];        // categories WHERE kind='item_kind'
  let _cats = [];         // distinct ingredients.category
  let _finCats = [];      // categories WHERE kind='accounting' — the finance-category master list
  let _suppliers = [];
  let _kind = '';         // '' = all
  let _cat = '';
  let _sup = '';
  let _q = '';
  let _archived = false;
  let _searchTimer = null;

  let _rec = null;        // the open record: { row, priceHistory, purchases, derived }
  let _recOpen = false;
  let _dirty = false;

  const listRoot = () => document.getElementById('mat-root');
  const recRoot  = () => document.getElementById('mat-rec-body');

  const I = {
    back:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 18-6-6 6-6"/></svg>',
    search:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>',
    plus:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    crate:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7Z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.matInit = async function () {
    if (_init) { load(); return; }
    _init = true;
    if (typeof onLangChange === 'function') onLangChange(() => { paintList(); if (_recOpen) paintRecord(); });
    // The three pickers are read once — they change on a scale of months, and a
    // failed picker fetch must not stop the list from painting.
    try {
      const [k, c, f, s] = await Promise.all([
        api('/api/retail-admin/materials/meta/kinds').catch(() => ({ data: [] })),
        api('/api/retail-admin/materials/meta/categories').catch(() => ({ data: [] })),
        api('/api/retail-admin/materials/meta/accounting-categories').catch(() => ({ data: [] })),
        api('/api/retail-admin/suppliers').catch(() => ({ data: [] })),
      ]);
      _kinds = k.data || [];
      _cats = c.data || [];
      _finCats = f.data || [];
      _suppliers = s.data || [];
    } catch (e) { /* pickers are optional; the list is not */ }
    load();
  };

  async function load() {
    const r = listRoot();
    if (r && !_rows.length) r.innerHTML = `<div class="mat-loading">${esc(T('Loading…', '加载中…'))}</div>`;
    const qs = new URLSearchParams();
    if (_q) qs.set('search', _q);
    if (_kind) qs.set('kind', _kind);
    if (_cat) qs.set('category', _cat);
    if (_sup) qs.set('supplier', _sup);
    if (_archived) qs.set('archived', '1');
    try {
      const j = await api('/api/retail-admin/materials?' + qs.toString());
      _rows = j.data || [];
      _counts = j.counts || {};
    } catch (e) {
      _rows = [];
      if (r) r.innerHTML = `<div class="mat-emptyline">${esc(T('Could not load materials', '无法加载物料'))} — ${esc(e.message || '')}</div>`;
      return;
    }
    paintList();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIST
  // ═══════════════════════════════════════════════════════════════════════════
  function chrome() {
    return `
      <div class="mat-pagehead">
        <div class="mat-eyebrow">${esc(T('Production', '生产'))}</div>
        <h1 class="mat-title">${esc(T('Materials', '物料'))}</h1>
        <p class="mat-sub">${esc(T('Everything you buy and hold but don’t sell — food, packaging, equipment, supplies. What each one costs per unit is worked out from the pack price.', '你采购并库存但不出售的物品 — 食品、包装、设备、耗材。每单位成本由整包价格自动折算。'))}</p>
      </div>`;
  }

  function kindChips() {
    const all = Object.keys(_counts).reduce((s, k) => s + _counts[k], 0);
    const chips = [['', T('All', '全部'), all]].concat(
      _kinds.map(k => [k, kindLabel(k), _counts[k] || 0])
    );
    return chips.map(([key, label, n]) =>
      `<button class="mat-chip${_kind === key ? ' on' : ''}" onclick="matSetKind('${esc(key)}')">${esc(label)}<b class="mat-num">${n}</b></button>`
    ).join('');
  }

  function filterBar() {
    const catOpts = ['<option value="">' + esc(T('All categories', '全部分类')) + '</option>']
      .concat(_cats.map(c => `<option value="${esc(c)}"${_cat === c ? ' selected' : ''}>${esc(c)}</option>`)).join('');
    const supOpts = ['<option value="">' + esc(T('All suppliers', '全部供应商')) + '</option>']
      .concat(_suppliers.map(s => `<option value="${esc(s.name)}"${_sup === s.name ? ' selected' : ''}>${esc(s.name)}</option>`)).join('');
    return `
      <div class="mat-filters">
        <div class="mat-srch">
          <span class="mat-ic">${I.search}</span>
          <input class="mat-input" type="search" id="mat-q" value="${esc(_q)}" oninput="matSearch(this.value)"
                 placeholder="${esc(T('Search name or SKU', '搜索名称或货号'))}">
        </div>
        <select class="mat-input mat-sel" onchange="matSetCat(this.value)">${catOpts}</select>
        <select class="mat-input mat-sel" onchange="matSetSup(this.value)">${supOpts}</select>
        <label class="mat-check"><input type="checkbox" ${_archived ? 'checked' : ''} onchange="matSetArchived(this.checked)"> ${esc(T('Archived', '已归档'))}</label>
        <span class="mat-spacer"></span>
        <button class="mat-btn primary" data-cap="materials:edit" onclick="matRecordNew()"><span class="mat-ic">${I.plus}</span>${esc(T('New material', '新建物料'))}</button>
      </div>`;
  }

  function paintList() {
    const r = listRoot();
    if (!r) return;
    // Typing in the search box triggers a reload, which repaints this whole
    // node — so the field the operator is typing into is destroyed mid-word.
    // Remember whether it held focus and put the caret back at the end.
    const wasSearching = document.activeElement && document.activeElement.id === 'mat-q';
    r.innerHTML = chrome() + `<div class="mat-chiprow">${kindChips()}</div>` + filterBar() + tableHtml();
    if (wasSearching) {
      const q = document.getElementById('mat-q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    try { applyCapGates(); } catch (_) {}
  }

  function tableHtml() {
    if (!_rows.length) {
      const blank = _q || _kind || _cat || _sup;
      return `
        <div class="mat-card mat-empty">
          <div class="mat-empty-ico">${I.crate}</div>
          <h3>${esc(blank ? T('Nothing matches', '没有匹配项') : T('No materials yet', '暂无物料'))}</h3>
          <p>${esc(blank
            ? T('Try a different search, or clear the filters.', '换个搜索词,或清除筛选条件。')
            : T('A material is anything you buy and keep — flour, cups, a mixer. Add the first one and its cost per unit is worked out for you.', '物料是你采购并留存的任何东西 —— 面粉、杯子、搅拌机。新建第一条,单位成本会自动算好。'))}</p>
        </div>`;
    }
    const rows = _rows.map(m => {
      const cpu = Number(m.cost_per_unit) || 0;
      const cpuTxt = m.free_by_design
        ? esc(T('free', '免费'))
        : (cpu > 0 ? `${money(cpu)}<span class="mat-per">/${esc(m.unit || '')}</span>` : '—');
      return `
        <tr onclick="matRecordOpen(${m.id})">
          <td>
            <div class="mat-name">${esc(m.name_en || '')}</div>
            ${m.name_cn ? `<div class="mat-sub2">${esc(m.name_cn)}</div>` : ''}
          </td>
          <td><span class="mat-tag">${esc(kindLabel(m.item_kind || 'food'))}</span></td>
          <td class="mat-mono">${esc(dash(m.sku))}</td>
          <td>${esc(dash(m.category))}</td>
          <td>${esc(dash(m.supplier))}</td>
          <td class="right mat-num">${m.buy_price > 0 ? money(m.buy_price) : '—'}<span class="mat-per">${m.buy_price > 0 ? '/' + esc(m.buy_unit || '') : ''}</span></td>
          <td class="right mat-num">${cpuTxt}</td>
        </tr>`;
    }).join('');
    return `
      <div class="mat-card">
        <div class="mat-tblwrap">
          <table class="mat-tbl">
            <thead><tr>
              <th>${esc(T('Material', '物料'))}</th>
              <th>${esc(T('Kind', '类别'))}</th>
              <th>${esc(T('SKU', '货号'))}</th>
              <th>${esc(T('Category', '分类'))}</th>
              <th>${esc(T('Supplier', '供应商'))}</th>
              <th class="right">${esc(T('Buy price', '采购价'))}</th>
              <th class="right">${esc(T('Cost per unit', '单位成本'))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  window.matSetKind = function (k) { _kind = k; load(); };
  window.matSetCat  = function (c) { _cat = c; load(); };
  window.matSetSup  = function (s) { _sup = s; load(); };
  window.matSetArchived = function (on) { _archived = !!on; load(); };
  window.matSearch = function (v) {
    _q = v;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(load, 250);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECORD — a full page, not a drawer (§28 addendum item 3)
  // ═══════════════════════════════════════════════════════════════════════════
  // Same takeover shape as Orders → New order: goTab makes #tab-materials-record
  // the one active section, body.mat-viewing pins main below the topbar, and a
  // throwaway history entry catches the browser Back button so it lands on the
  // list rather than outside the module.
  window.matRecordOpen = async function (id) {
    try {
      const j = await api('/api/retail-admin/materials/' + id);
      _rec = {
        row: j.data, priceHistory: j.priceHistory || [], purchases: j.purchases || [], derived: j.derived || {},
        // §29 step 6 — usedByRecipes feeds the archive-warning; sourceRecipe/
        // sourceRecipeBlock make a made material's "cost comes from a recipe,
        // and that recipe may be blocked" state actually visible, not just
        // correct in the row's own source_recipe_id column.
        usedByRecipes: j.usedByRecipes || [], sourceRecipe: j.sourceRecipe || null, sourceRecipeBlock: j.sourceRecipeBlock || null,
      };
    } catch (e) {
      toast(T('Could not open that material', '无法打开该物料') + ': ' + (e.message || ''), 'err');
      return;
    }
    openTakeover();
  };

  window.matRecordNew = function () {
    _rec = {
      row: {
        id: null, name_en: '', name_cn: '', sku: '', category: '',
        unit: 'g', buy_unit: 'kg', buy_pack_size: 1,
        pack_contents_qty: null, pack_contents_unit: null,
        buy_price: 0, cost_per_unit: 0, free_by_design: 0,
        supplier: '', allergens: '', notes: '',
        accounting_category: '', item_kind: _kind || 'food', is_active: 1,
      },
      priceHistory: [], purchases: [], derived: {},
      usedByRecipes: [], sourceRecipe: null, sourceRecipeBlock: null,
    };
    openTakeover();
  };

  function openTakeover() {
    if (_recOpen) { paintRecord(); return; }
    _recOpen = true;
    _dirty = false;
    goTab('materials-record');
    document.body.classList.add('mat-viewing');
    history.pushState({ matRec: true }, '');
    window.addEventListener('popstate', onPop);
    const sc = document.getElementById('mat-rec-scroll');
    if (sc) sc.scrollTop = 0;
    paintRecord();
  }

  function onPop() { teardown(true); goTab('materials'); }

  function teardown(viaPop) {
    if (!_recOpen) return;
    _recOpen = false;
    document.body.classList.remove('mat-viewing');
    window.removeEventListener('popstate', onPop);
    if (!viaPop) history.back();
  }

  window.matRecordBack = async function () {
    if (_dirty && !(await askConfirm({
      titleEn: 'Leave without saving?', titleCn: '未保存就离开?',
      bodyEn: 'Your changes to this material will be lost.', bodyCn: '你对该物料的更改将丢失。',
      confirmEn: 'Leave', confirmCn: '离开', danger: true,
    }))) return;
    teardown(false);
    // goTab clicks the real rail button, whose onclick is matInit() — which
    // reloads the list. Calling load() here too would fetch it twice.
    goTab('materials');
  };

  // A rail click while the record is open navigates away without going through
  // matRecordBack — tear the takeover down first, in the capture phase, so
  // body.mat-viewing is gone before the tab switcher shows the next section
  // (its `main > section { display:none }` would otherwise hide it).
  document.addEventListener('click', (e) => {
    if (!_recOpen) return;
    if (e.target.closest && e.target.closest('.tabs [data-tab]')) teardown(false);
  }, true);

  function field(label, inner, hint) {
    return `<div class="mat-f"><span class="lbl">${esc(label)}</span>${inner}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
  }
  // `extra` is appended to the default handler, never a second oninput attribute
  // — a duplicate attribute is silently dropped by the parser, which is how the
  // cost preview stopped updating the first time this was written.
  function input(key, val, attrs, extra) {
    return `<input class="mat-input" id="mat-f-${key}" value="${esc(val == null ? '' : val)}"`
         + ` oninput="matDirty();${extra || ''}" ${attrs || ''}>`;
  }
  function select(key, val, opts, extra) {
    const o = opts.map(([v, l]) => `<option value="${esc(v)}"${String(val == null ? '' : val) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return `<select class="mat-input" id="mat-f-${key}" onchange="matDirty();${extra || ''}">${o}</select>`;
  }

  window.matDirty = function () { _dirty = true; };

  // Finance-category suggestions render as our own menu, position:fixed and
  // placed under the input by JS (not CSS-anchored via position:relative —
  // .mat-card rounds its corners with clip-path, which clips an absolutely
  // positioned descendant to the card same as overflow:hidden would). A
  // native <input list>/<datalist> popup is drawn by the OS combobox widget,
  // which some embedding webviews (e.g. chat-app browser panes) position at
  // the wrong screen coordinates — it showed up pinned to the far edge of
  // the window instead of under the field.
  function matFinCatReposition() {
    const menu = document.getElementById('mat-fincat-menu');
    const input = document.getElementById('mat-f-accounting_category');
    if (!menu || !input) return;
    const r = input.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.width = r.width + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
  }
  window.matFinCatFilter = function (v) {
    const menu = document.getElementById('mat-fincat-menu');
    if (!menu) return;
    const q = String(v || '').trim().toLowerCase();
    const matches = _finCats.filter(c => !q || c.toLowerCase().includes(q)).slice(0, 30);
    if (!matches.length) { menu.hidden = true; menu.innerHTML = ''; return; }
    menu.innerHTML = matches.map(c =>
      `<div class="mat-fincat-opt" onmousedown="event.preventDefault();matFinCatPick(${JSON.stringify(c)})">${esc(c)}</div>`).join('');
    matFinCatReposition();
    menu.hidden = false;
  };
  window.matFinCatPick = function (v) {
    const el = document.getElementById('mat-f-accounting_category');
    if (el) el.value = v;
    matDirty();
    const menu = document.getElementById('mat-fincat-menu');
    if (menu) menu.hidden = true;
  };
  window.matFinCatBlur = function () {
    // Deferred so a menu option's mousedown (which preventDefault()s the
    // blur-causing focus loss) still has a chance to run its click first.
    setTimeout(() => { const menu = document.getElementById('mat-fincat-menu'); if (menu) menu.hidden = true; }, 150);
  };
  // Fixed-position menu doesn't track the page under it on its own — close
  // it when the page underneath scrolls, so it never drifts away from the
  // field it was anchored to. Scroll events don't bubble, so a capturing
  // document listener is the only way to catch the record page's own
  // scroller — but that also fires while scrolling *inside* the menu's own
  // option list (its target is a descendant, seen during capture), which
  // must not close it.
  document.addEventListener('scroll', (e) => {
    const menu = document.getElementById('mat-fincat-menu');
    if (menu && !menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  }, true);
  window.addEventListener('resize', () => {
    const menu = document.getElementById('mat-fincat-menu');
    if (menu && !menu.hidden) menu.hidden = true;
  });

  function paintRecord() {
    const host = recRoot();
    if (!host || !_rec) return;
    const m = _rec.row;
    const isNew = !m.id;
    const kindOpts = (_kinds.length ? _kinds : ['food', 'packaging', 'equipment', 'retail', 'other'])
      .map(k => [k, kindLabel(k)]);
    const catOpts = [['', T('None', '无')]].concat(_cats.map(c => [c, c]));
    const supOpts = [['', T('None', '无')]].concat(_suppliers.map(s => [s.name, s.name]));

    // The takeover header is static markup (so the section exists before any
    // paint) but its labels are baked here — the section is data-no-i18n, so the
    // walker never touches it and cuT is the only thing that switches language.
    const setTxt = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
    setTxt('mat-rec-title', isNew ? T('New material', '新建物料') : (m.name_en || T('Material', '物料')));
    setTxt('mat-rec-backlbl', T('Materials', '物料'));
    setTxt('mat-rec-save', T('Save', '保存'));
    setTxt('mat-rec-arch', m.is_active ? T('Archive', '归档') : T('Restore', '恢复'));
    const archBtn = document.getElementById('mat-rec-arch');
    if (archBtn) archBtn.hidden = isNew;   // nothing to archive that doesn't exist yet

    host.innerHTML = `
      <div class="mat-recgrid">
        <div class="mat-reccol">

          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Identity', '基本信息'))}</h3>
            <div class="mat-fgrid">
              ${field(T('Kind', '类别'), select('item_kind', m.item_kind || 'food', kindOpts, 'matKindChanged()'))}
              ${field(T('Category', '分类'), select('category', m.category, catOpts))}
              ${field(T('Name (English)', '名称(英文)'), input('name_en', m.name_en, 'maxlength="120"'))}
              ${field(T('Name (中文)', '名称(中文)'), input('name_cn', m.name_cn, 'maxlength="120"'))}
              ${field(T('SKU', '货号'), input('sku', m.sku, 'maxlength="60"'),
                       T('Kept forever, even after archiving — so old orders keep pointing at the right thing.', '归档后仍永久保留 — 以免历史订单指向错误。'))}
              ${field(T('Finance category', '财务分类'),
                       `<div class="mat-fincat-wrap">`
                       + input('accounting_category', m.accounting_category,
                               'maxlength="80" autocomplete="off" onfocus="matFinCatFilter(this.value)" onblur="matFinCatBlur()"',
                               'matFinCatFilter(this.value)')
                       + `<div class="mat-fincat-menu" id="mat-fincat-menu" hidden></div>`
                       + `</div>`)}
            </div>
          </div>

          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Units & cost', '单位与成本'))}</h3>
            <div class="mat-fgrid">
              ${field(T('Recipe unit', '配方单位'),
                       select('unit', m.unit, RECIPE_UNITS().map(u => [u, u]), 'matPreviewCost()'),
                       T('The unit you measure it out in.', '实际使用时的计量单位。'))}
              ${field(T('Buy unit', '采购单位'),
                       select('buy_unit', m.buy_unit, BUY_UNITS().map(u => [u, u]), 'matUnitsChanged()'),
                       T('The unit you buy it by.', '采购时的计量单位。'))}
              ${field(T('Packs per order', '每次采购包数'), input('buy_pack_size', m.buy_pack_size, 'type="number" min="0" step="any"', 'matPreviewCost()'))}
              ${field(T('Buy price', '采购价'), input('buy_price', m.buy_price, 'type="number" min="0" step="any"', 'matPreviewCost()'),
                       T('What one pack costs.', '一包的价格。'))}
            </div>
            <div id="mat-pack-row" class="mat-fgrid" ${isContainer(m.buy_unit) ? '' : 'hidden'}>
              ${field(T('Contents per pack', '每包内容量'), input('pack_contents_qty', m.pack_contents_qty, 'type="number" min="0" step="any"', 'matPreviewCost()'))}
              ${field(T('Contents unit', '内容量单位'),
                       select('pack_contents_unit', m.pack_contents_unit, [['', '—']].concat(['g', 'kg', 'ml', 'L'].map(u => [u, u])), 'matPreviewCost()'),
                       T('A box or bottle has no size of its own — say what’s inside, or the cost can’t be worked out.', '箱/瓶本身没有容量 — 需填写内容量,否则无法折算成本。'))}
            </div>
            <label class="mat-check mat-freebox">
              <input type="checkbox" id="mat-f-free_by_design" ${m.free_by_design ? 'checked' : ''} onchange="matDirty();matPreviewCost()">
              ${esc(T('Free by design (tap water, peel — never costed)', '按设计免费(自来水、果皮等 — 不计成本)'))}
            </label>
            <div class="mat-costline" id="mat-costline">${costPreviewHtml()}</div>
            ${_rec.sourceRecipe ? `
            <div class="mat-srcrecipe${_rec.sourceRecipeBlock && !_rec.sourceRecipeBlock.ok ? ' blocked' : ''}">
              ${esc(T('Made by recipe: ', '产出自食谱:'))}<b>${esc(_rec.sourceRecipe.name_en)}</b>${_rec.sourceRecipe.is_active === 0 ? ' — ' + esc(T('archived', '已归档')) : ''}
              ${_rec.sourceRecipeBlock && !_rec.sourceRecipeBlock.ok
                ? `<div class="mat-srcrecipe-why">${esc(T('Cost frozen at its last computed value.', '成本已冻结为最近一次计算的值。'))} ${esc(srcBlockReasonText(_rec.sourceRecipeBlock))}</div>`
                : ''}
            </div>` : ''}
          </div>

          ${(m.item_kind || 'food') === 'food' ? `
          <div class="mat-card mat-blk" id="mat-allergen-blk">
            <h3 class="mat-blk-h">${esc(T('Allergens', '过敏原'))}</h3>
            ${input('allergens', m.allergens, 'maxlength="240" placeholder="' + esc(T('e.g. nuts, soy', '例如:坚果、大豆')) + '"')}
          </div>` : ''}

          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Notes', '备注'))}</h3>
            <textarea class="mat-input" id="mat-f-notes" rows="3" oninput="matDirty()">${esc(m.notes || '')}</textarea>
          </div>
        </div>

        <div class="mat-recside">
          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Supplier', '供应商'))}</h3>
            ${select('supplier', m.supplier, supOpts)}
          </div>
          ${isNew ? '' : `
          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Cost history', '价格历史'))}</h3>
            ${histHtml()}
          </div>
          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Bought in', '采购记录'))}</h3>
            ${purchHtml()}
          </div>`}
        </div>
      </div>`;
    try { applyCapGates(); } catch (_) {}
  }

  // What the cost WILL be if saved now, worked out by the same shared module the
  // server uses — so the number on screen and the number stored can't disagree.
  // `src` is explicit because this is called twice from two different worlds:
  // once while building the markup (the fields don't exist yet, so it reads the
  // record) and once after an edit (it reads the fields). Reading the DOM in
  // both cases showed every material as "no price entered" on open.
  function costPreviewHtml(src) {
    const c = COST();
    if (!c) return '';
    const draft = src || _rec.row;
    const d = c.deriveCostPerUnit(draft, draft.buy_price);
    if (d.cpu === null) {
      const why = {
        no_price:          T('No price entered yet.', '尚未填写价格。'),
        no_pack_size:      T('Packs per order must be more than zero.', '每次采购包数需大于零。'),
        no_pack_contents:  T('This pack has no recorded contents, so a per-unit cost can’t be worked out.', '未记录本包内容量,无法折算单位成本。'),
        unsupported_recipe_unit: T('That recipe unit can’t be divided into.', '该配方单位无法折算。'),
      }[d.reason] || T('Cost can’t be worked out yet.', '暂时无法折算成本。');
      return `<span class="mat-costwhy">${esc(why)}</span>`;
    }
    if (d.reason === 'free_by_design') return `<b>${esc(T('Free by design', '按设计免费'))}</b>`;
    return `<span>${esc(T('Cost per unit', '单位成本'))}</span> <b>${money(d.cpu)}<span class="mat-per">/${esc(draft.unit || '')}</span></b>`;
  }

  window.matPreviewCost = function () {
    const el = document.getElementById('mat-costline');
    if (el) el.innerHTML = costPreviewHtml(readForm());
  };
  window.matUnitsChanged = function () {
    const row = document.getElementById('mat-pack-row');
    const bu = document.getElementById('mat-f-buy_unit');
    if (row && bu) row.hidden = !isContainer(bu.value);
    matPreviewCost();
  };
  // Allergens are a food question. Changing the kind repaints so the block
  // appears or leaves rather than sitting there empty and meaningless.
  window.matKindChanged = function () {
    if (!_rec) return;
    Object.assign(_rec.row, readForm());
    paintRecord();
  };

  function histHtml() {
    const h = _rec.priceHistory;
    if (!h.length) return `<div class="mat-emptyline">${esc(T('No price changes recorded.', '暂无价格变动记录。'))}</div>`;
    return '<div class="mat-mini">' + h.map(r => `
      <div class="mat-minirow">
        <span class="mat-mono">${money(r.price)}<span class="mat-per">/${esc(r.buy_unit || '')}</span></span>
        <span class="mat-sub2">${esc((r.recorded_at || '').slice(0, 10))}${r.source && r.source !== 'manual' ? ' · ' + esc(r.source) : ''}</span>
      </div>`).join('') + '</div>';
  }

  function purchHtml() {
    const p = _rec.purchases;
    if (!p.length) {
      return `<div class="mat-emptyline">${esc(T('Not on any purchase order yet.', '尚未出现在任何采购单中。'))}</div>`;
    }
    return '<div class="mat-mini">' + p.map(r => `
      <div class="mat-minirow">
        <span class="mat-mono">${esc(r.po_number || '')}</span>
        <span class="mat-sub2">${esc((r.date || '').slice(0, 10))} · ${esc(String(r.qty || 0))} ${esc(r.unit || '')} · ${money(r.total_cost)}</span>
      </div>`).join('') + '</div>';
  }

  // ── save ──────────────────────────────────────────────────────────────────
  // A field that isn't on screen falls back to what the record already holds,
  // never to blank. Allergens are the reason: the block only renders for food,
  // so switching a material to Packaging and saving would otherwise wipe the
  // allergen list of anything switched back later.
  function val(key) {
    const el = document.getElementById('mat-f-' + key);
    if (!el) return _rec && _rec.row ? _rec.row[key] : undefined;
    return el.type === 'checkbox' ? el.checked : el.value;
  }
  function num(key) {
    const v = val(key);
    return v === '' || v === undefined || v === null ? null : Number(v);
  }
  function readForm() {
    return {
      name_en: String(val('name_en') || '').trim(),
      name_cn: String(val('name_cn') || '').trim(),
      sku: String(val('sku') || '').trim(),
      category: val('category') || '',
      unit: val('unit') || 'g',
      buy_unit: val('buy_unit') || 'kg',
      buy_pack_size: num('buy_pack_size'),
      pack_contents_qty: num('pack_contents_qty'),
      pack_contents_unit: val('pack_contents_unit') || null,
      buy_price: num('buy_price') || 0,
      free_by_design: val('free_by_design') ? 1 : 0,
      supplier: val('supplier') || '',
      allergens: val('allergens') || '',
      notes: val('notes') || '',
      accounting_category: val('accounting_category') || '',
      item_kind: val('item_kind') || 'food',
    };
  }

  window.matSave = async function () {
    if (!_rec) return;
    const body = readForm();
    if (!body.name_en) { toast(T('An English name is required', '英文名称必填'), 'err'); return; }
    const id = _rec.row.id;
    try {
      if (id) {
        await api('/api/retail-admin/materials/' + id, { method: 'PUT', body });
      } else {
        const j = await api('/api/retail-admin/materials', { method: 'POST', body });
        _rec.row.id = j.id;
      }
      _dirty = false;
      toast(T('Saved', '已保存'));
      // Re-read rather than trust the local copy: cost_per_unit is derived on
      // the server, and the history panel may have gained a row.
      const fresh = await api('/api/retail-admin/materials/' + _rec.row.id);
      _rec = {
        row: fresh.data, priceHistory: fresh.priceHistory || [], purchases: fresh.purchases || [], derived: fresh.derived || {},
        usedByRecipes: fresh.usedByRecipes || [], sourceRecipe: fresh.sourceRecipe || null, sourceRecipeBlock: fresh.sourceRecipeBlock || null,
      };
      paintRecord();
    } catch (e) {
      const msg = (e.data && e.data.message) || e.message || '';
      toast(T('Save failed', '保存失败') + ': ' + msg, 'err');
    }
  };

  // §29 step 6 — same shape of gap as the Recipes side, different actual
  // consequence: archiving a material does NOT freeze or block any cost
  // computation (lib/recipe-cost.js and lib/recipe-rollup.js never check
  // ingredients.is_active, only recipes.is_active) — a recipe already
  // consuming this material keeps reading its live cost_per_unit exactly as
  // before. What archiving actually does is hide it from this list and from
  // the recipe ingredient picker (GET /api/retail-admin/materials defaults
  // to is_active=1), so an operator loses visibility into a material recipes
  // still depend on, and can't re-add it to a DIFFERENT recipe until it's
  // brought back. Named here rather than assumed, so the warning says the
  // true consequence instead of copying the recipe-side "freezes cost" text.
  function archiveWarningBody(row) {
    const consumers = (_rec && _rec.usedByRecipes) || [];
    const n = consumers.length;
    const namesEn = consumers.slice(0, 4).map(c => c.name_en).join(', ') + (n > 4 ? `, +${n - 4}` : '');
    const namesCn = consumers.slice(0, 4).map(c => c.name_cn || c.name_en).join('、') + (n > 4 ? `等 ${n} 个` : '');
    return {
      bodyEn: `Used by ${n} recipe${n === 1 ? '' : 's'}${namesEn ? ' (' + namesEn + ')' : ''}. Archiving hides "${row.name_en}" from the materials list and the recipe picker — ${n === 1 ? 'that recipe keeps' : 'those recipes keep'} costing with it exactly as before, but you won't be able to add it to a new recipe until you bring it back.`,
      bodyCn: `被 ${n} 个食谱使用${namesCn ? '(' + namesCn + ')' : ''}。归档后"${row.name_en}"会从物料列表和食谱原料选择器中隐藏 —— ${n === 1 ? '该食谱' : '这些食谱'}仍会照常使用其成本,但在你恢复它之前无法将其添加到新食谱中。`,
    };
  }

  window.matArchive = async function () {
    if (!_rec || !_rec.row.id) return;
    const restoring = !_rec.row.is_active;
    const hasConsumers = !restoring && (_rec.usedByRecipes || []).length > 0;
    let ok;
    if (restoring) {
      ok = await askConfirm({
        titleEn: 'Bring this material back?', titleCn: '恢复该物料?',
        confirmEn: 'Restore', confirmCn: '恢复',
      });
    } else if (hasConsumers) {
      const w = archiveWarningBody(_rec.row);
      ok = await askConfirm({
        titleEn: 'Archive this material?', titleCn: '归档该物料?',
        bodyEn: w.bodyEn, bodyCn: w.bodyCn,
        confirmEn: 'Archive anyway', confirmCn: '仍然归档', danger: true,
      });
    } else {
      ok = await askConfirm({
        titleEn: 'Archive this material?', titleCn: '归档该物料?',
        bodyEn: 'It keeps its SKU and stays on old purchase orders. You can bring it back later.',
        bodyCn: '其货号会保留,历史采购单不受影响。之后可以恢复。',
        confirmEn: 'Archive', confirmCn: '归档', danger: true,
      });
    }
    if (!ok) return;
    try {
      await api('/api/retail-admin/materials/' + _rec.row.id + '/archive', { method: 'PUT', body: { restore: restoring } });
      toast(restoring ? T('Restored', '已恢复') : T('Archived', '已归档'));
      _dirty = false;
      teardown(false);
      goTab('materials');
    } catch (e) {
      toast(T('Failed', '操作失败') + ': ' + (e.message || ''), 'err');
    }
  };
})();
