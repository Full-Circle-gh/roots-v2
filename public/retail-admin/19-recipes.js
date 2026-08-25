/* eslint-disable no-undef */
/* retail-admin app JS — part 19.  Recipes (食谱), §29, 2026-08-25.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, cuT, can, applyCapGates, goTab, askConfirm) live in
   01-core.js. window.RootsRecipeCost (/lib/recipe-cost.js) must load before
   this file — see the <script> order in retail-admin.html.

   Recipes generalises the kitchen machinery the same way Materials did —
   same recipes/recipe_ingredients/recipe_steps/recipe_cost_data tables,
   this is the multi-tenant door onto them (routes/retail-recipes.js).

   SCOPE (§29): cost-only. No quantity/stock tracking, no connection to
   Products or the storefront in this phase. No "make available as material"
   action yet (that is a later, separate change) — a recipe that does not
   already back a material simply shows no link affordance.

   TWO SCREENS, TWO SECTIONS, same shape as Materials: the list paints into
   #rcp-root inside <section id="tab-recipes">; the record is a FULL PAGE in
   its own sibling <section id="tab-recipes-record">, reached through the
   RAIL_STANDIN takeover. Recipes carries more structure than a material —
   ingredient lines, steps, a cost breakdown — so the record is further
   split into sub-tabs (Details / Ingredients / Steps / Cost & Pricing). All
   four sub-tab bodies are painted into the DOM at once and only their
   visibility toggles: switching tabs must never lose an unsaved edit made
   on another tab, and the live cost preview needs Details' batch_size /
   servings and Cost & Pricing's labour / packaging inputs to co-exist.

   THE ONE THING THIS SCREEN MUST NEVER DO: let a recipe look free. A recipe
   with unpriced lines shows its real (undercounted) computed number plus an
   explicit warning — never a hidden figure, never a bare ¥0.00 — mirroring
   the kitchen app's own posture (public/app.html "N ingredient(s) missing
   cost — costs shown are too low"). A recipe that backs a material and is
   currently blocked (lib/recipe-rollup.js) shows BOTH halves: its own
   warning, and the material's cost is frozen at its last computed value,
   with a caption explaining why it stopped updating.

   Prefix is rcp-*, its own section like every other part here (mat-/mt-/
   pu-/pu2-) — never reuse mat-* classes, they are scoped to #tab-materials*
   and would carry no styling here. */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
  const money = n => '¥' + (typeof fmt === 'function' ? fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2));
  // Cost PER GRAM is often sub-cent (¥0.0114) — the plain 2dp money() would
  // round it to ¥0.01 and lose the figure entirely on a screen whose whole
  // point is not looking free. Same reasoning as the recipe Excel export's
  // UNIT_MONEY format (lib/recipe-cost.js / routes/recipes.js export route).
  const moneyU = n => '¥' + (Number(n) || 0).toFixed(4);
  const dash = v => (v === null || v === undefined || v === '' ? '—' : v);

  const COST = () => (typeof window !== 'undefined' && window.RootsRecipeCost) || null;
  const ICOST = () => (typeof window !== 'undefined' && window.RootsIngredientCost) || null;
  const RECIPE_UNITS = () => {
    const c = ICOST();
    return c ? [].concat(c.DIVISIBLE_RECIPE_UNITS, c.PER_PIECE_RECIPE_UNITS) : ['g', 'ml', 'pcs'];
  };

  // Why a recipe that backs a material has its cost frozen — mirrors the
  // reasons lib/recipe-rollup.js's costOneRecipe() returns, one for one, so
  // this can never say something the server-side rollup would disagree with.
  const BLOCK_REASON = {
    recipe_archived:     () => T('This recipe is archived.', '该食谱已归档。'),
    no_ingredient_lines: () => T('This recipe has no ingredient lines yet.', '该食谱尚无原料明细。'),
    unpriced_lines:       n => T(`${n} ingredient${n === 1 ? '' : 's'} in this recipe ${n === 1 ? 'is' : 'are'} missing a cost.`,
                                  `该食谱中有 ${n} 项原料缺少成本。`),
    no_batch_size:       () => T('This recipe has no batch size set.', '该食谱未设置批量大小。'),
    no_cost_per_unit:    () => T("This recipe's cost can't be worked out right now.", '该食谱的成本暂无法计算。'),
  };
  const blockReasonText = (reason, unpriced) => {
    const f = BLOCK_REASON[reason];
    if (!f) return T("This recipe's cost can't be worked out right now.", '该食谱的成本暂无法计算。');
    return reason === 'unpriced_lines' ? f(unpriced) : f();
  };

  // ── module state ──────────────────────────────────────────────────────────
  let _init = false;
  let _rows = [];
  let _cats = [];
  let _cat = '';
  let _q = '';
  let _archived = false;
  let _searchTimer = null;

  let _rec = null;        // the open record: server row + cost + backsMaterial + materialBlock
  let _lines = [];         // editable draft ingredient lines
  let _steps = [];         // editable draft steps
  let _recOpen = false;
  let _dirty = false;
  let _subtab = 'details'; // details | ingredients | steps | cost
  let _pickTimer = null;
  let _pickResults = [];

  const listRoot = () => document.getElementById('rcp-root');
  const recRoot  = () => document.getElementById('rcp-rec-body');
  const sumRoot  = () => document.getElementById('rcp-rec-summary');

  const I = {
    back:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 18-6-6 6-6"/></svg>',
    search:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>',
    plus:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    book:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V4.5A2.5 2.5 0 0 1 6.5 2H20v18"/><path d="M6.5 22H20v-4H6.5A2.5 2.5 0 0 0 4 20.5v0A2.5 2.5 0 0 0 6.5 22Z"/></svg>',
    warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    x:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    up:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.rcpInit = async function () {
    if (_init) { load(); return; }
    _init = true;
    if (typeof onLangChange === 'function') onLangChange(() => { paintList(); if (_recOpen) paintRecord(); });
    try {
      const c = await api('/api/retail-admin/recipes/meta/categories').catch(() => ({ data: [] }));
      _cats = c.data || [];
    } catch (e) { /* categories are optional; the list is not */ }
    load();
  };

  async function load() {
    const r = listRoot();
    if (r && !_rows.length) r.innerHTML = `<div class="rcp-loading">${esc(T('Loading…', '加载中…'))}</div>`;
    const qs = new URLSearchParams();
    if (_q) qs.set('search', _q);
    if (_cat) qs.set('category', _cat);
    if (_archived) qs.set('archived', '1');
    try {
      const j = await api('/api/retail-admin/recipes?' + qs.toString());
      _rows = j.data || [];
    } catch (e) {
      _rows = [];
      if (r) r.innerHTML = `<div class="rcp-emptyline">${esc(T('Could not load recipes', '无法加载食谱'))} — ${esc(e.message || '')}</div>`;
      return;
    }
    paintList();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIST
  // ═══════════════════════════════════════════════════════════════════════════
  function chrome() {
    return `
      <div class="rcp-pagehead">
        <div class="rcp-eyebrow">${esc(T('Production', '生产'))}</div>
        <h1 class="rcp-title">${esc(T('Recipes', '食谱'))}</h1>
        <p class="rcp-sub">${esc(T('What you make and what it costs — ingredient lines, steps, batch cost. Cost-only: recipes here don’t track quantity or stock, and aren’t connected to Products yet.', '你制作的东西及其成本 —— 原料明细、步骤、批量成本。仅计成本:食谱不追踪数量或库存,也尚未与产品关联。'))}</p>
      </div>`;
  }

  function filterBar() {
    const catOpts = ['<option value="">' + esc(T('All categories', '全部分类')) + '</option>']
      .concat(_cats.map(c => `<option value="${esc(c)}"${_cat === c ? ' selected' : ''}>${esc(c)}</option>`)).join('');
    return `
      <div class="rcp-filters">
        <div class="rcp-srch">
          <span class="rcp-ic">${I.search}</span>
          <input class="rcp-input" type="search" id="rcp-q" value="${esc(_q)}" oninput="rcpSearch(this.value)"
                 placeholder="${esc(T('Search name or SKU', '搜索名称或货号'))}">
        </div>
        <select class="rcp-input rcp-sel" onchange="rcpSetCat(this.value)">${catOpts}</select>
        <label class="rcp-check"><input type="checkbox" ${_archived ? 'checked' : ''} onchange="rcpSetArchived(this.checked)"> ${esc(T('Archived', '已归档'))}</label>
        <span class="rcp-spacer"></span>
        <button class="rcp-btn primary" data-cap="recipes:edit" onclick="rcpRecordNew()"><span class="rcp-ic">${I.plus}</span>${esc(T('New recipe', '新建食谱'))}</button>
      </div>`;
  }

  function paintList() {
    const r = listRoot();
    if (!r) return;
    const wasSearching = document.activeElement && document.activeElement.id === 'rcp-q';
    r.innerHTML = chrome() + filterBar() + tableHtml();
    if (wasSearching) {
      const q = document.getElementById('rcp-q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    try { applyCapGates(); } catch (_) {}
  }

  // Primary cost figure with the other on hover (title=), per plan: cost per
  // serving when servings is recorded (the number an operator actually
  // prices against), else cost per gram, else — when NEITHER can be worked
  // out, which is common (batch_size/servings are both often unset) — the
  // raw batch cost, so a recipe with real priced ingredients never reads as
  // a blank dash next to ones that are genuinely empty.
  function primaryCost(row) {
    if (row.costPerServing != null) {
      const hover = row.costPerGram != null ? `${T('Cost per gram', '每克成本')}: ${moneyU(row.costPerGram)}` : '';
      return { text: `${money(row.costPerServing)}<span class="rcp-per">/${esc(T('serving', '份'))}</span>`, title: hover };
    }
    if (row.costPerGram != null) {
      const hover = T('No servings recorded', '未记录份数');
      return { text: `${moneyU(row.costPerGram)}<span class="rcp-per">/g</span>`, title: hover };
    }
    return null;
  }

  function tableHtml() {
    if (!_rows.length) {
      const blank = _q || _cat;
      return `
        <div class="rcp-card rcp-empty">
          <div class="rcp-empty-ico">${I.book}</div>
          <h3>${esc(blank ? T('Nothing matches', '没有匹配项') : T('No recipes yet', '暂无食谱'))}</h3>
          <p>${esc(blank
            ? T('Try a different search, or clear the filters.', '换个搜索词,或清除筛选条件。')
            : T('A recipe is what you make and what it costs — ingredients, steps, batch size. Add the first one.', '食谱是你制作的东西及其成本 —— 原料、步骤、批量大小。新建第一份。'))}</p>
        </div>`;
    }
    const rows = _rows.map(rcp => {
      const pc = primaryCost(rcp);
      const costCell = pc
        ? `<span title="${esc(pc.title)}">${pc.text}</span>`
        : `<span title="${esc(T('No batch size or servings recorded — showing the whole-batch cost instead', '未记录批量大小或份数 — 显示整批成本'))}">${money(rcp.batchCost)}<span class="rcp-per"> ${esc(T('(batch)', '(整批)'))}</span></span>`;
      const warnIcon = rcp.zeroCostIngredientLines > 0
        ? `<span class="rcp-warnic" title="${esc(T(`${rcp.zeroCostIngredientLines} ingredient(s) missing cost — costs shown are too low`, `${rcp.zeroCostIngredientLines} 项原料缺少成本 — 显示成本偏低`))}">${I.warn}</span>`
        : '';
      const matBadge = rcp.backsMaterial
        ? `<span class="rcp-badge${rcp.materialBlock && !rcp.materialBlock.ok ? ' blocked' : ''}" title="${esc(rcp.materialBlock && !rcp.materialBlock.ok ? blockReasonText(rcp.materialBlock.reason, rcp.materialBlock.unpriced) : T('Backs material', '产出为物料'))}">${esc(T('Material', '物料'))}</span>`
        : '';
      return `
        <tr onclick="rcpRecordOpen(${rcp.id})">
          <td>
            <div class="rcp-name">${esc(rcp.name_en || '')} ${warnIcon}</div>
            ${rcp.name_cn ? `<div class="rcp-sub2">${esc(rcp.name_cn)}</div>` : ''}
          </td>
          <td>${esc(dash(rcp.category))}</td>
          <td class="right rcp-num">${rcp.batch_size ? esc(rcp.batch_size) + 'g' : '—'}</td>
          <td class="right rcp-num">${dash(rcp.servings)}</td>
          <td class="right rcp-num">${costCell}</td>
          <td>${matBadge}</td>
        </tr>`;
    }).join('');
    return `
      <div class="rcp-card">
        <div class="rcp-tblwrap">
          <table class="rcp-tbl">
            <thead><tr>
              <th>${esc(T('Recipe', '食谱'))}</th>
              <th>${esc(T('Category', '分类'))}</th>
              <th class="right">${esc(T('Batch size', '批量大小'))}</th>
              <th class="right">${esc(T('Servings', '份数'))}</th>
              <th class="right">${esc(T('Cost', '成本'))}</th>
              <th>${esc(T('Backs', '产出'))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }
  window.rcpSetCat = function (c) { _cat = c; load(); };
  window.rcpSetArchived = function (on) { _archived = !!on; load(); };
  window.rcpSearch = function (v) {
    _q = v;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(load, 250);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECORD — a full page, same takeover shape as Materials
  // ═══════════════════════════════════════════════════════════════════════════
  window.rcpRecordOpen = async function (id) {
    try {
      const j = await api('/api/retail-admin/recipes/' + id);
      setRecord(j.data);
    } catch (e) {
      toast(T('Could not open that recipe', '无法打开该食谱') + ': ' + (e.message || ''), 'err');
      return;
    }
    openTakeover();
  };

  window.rcpRecordNew = function () {
    setRecord({
      id: null, name_en: '', name_cn: '', sku: '', category: '',
      batch_size: null, servings: null, serving_size: null,
      shelf_life: '', storage: '', notes: '', is_active: 1,
      ingredients: [], steps: [], costData: null, cost: null,
      backsMaterial: null, materialBlock: null,
    });
    openTakeover();
  };

  function setRecord(row) {
    _rec = row;
    _lines = (row.ingredients || []).map(l => ({ ...l }));
    _steps = (row.steps || []).map(s => ({ ...s }));
    _subtab = 'details';
  }

  function openTakeover() {
    if (_recOpen) { paintRecord(); return; }
    _recOpen = true;
    _dirty = false;
    goTab('recipes-record');
    document.body.classList.add('rcp-viewing');
    history.pushState({ rcpRec: true }, '');
    window.addEventListener('popstate', onPop);
    const sc = document.getElementById('rcp-rec-scroll');
    if (sc) sc.scrollTop = 0;
    paintRecord();
  }

  function onPop() { teardown(true); goTab('recipes'); }

  function teardown(viaPop) {
    if (!_recOpen) return;
    _recOpen = false;
    document.body.classList.remove('rcp-viewing');
    window.removeEventListener('popstate', onPop);
    if (!viaPop) history.back();
  }

  window.rcpRecordBack = async function () {
    if (_dirty && !(await askConfirm({
      titleEn: 'Leave without saving?', titleCn: '未保存就离开?',
      bodyEn: 'Your changes to this recipe will be lost.', bodyCn: '你对该食谱的更改将丢失。',
      confirmEn: 'Leave', confirmCn: '离开', danger: true,
    }))) return;
    teardown(false);
    goTab('recipes');
  };

  document.addEventListener('click', (e) => {
    if (!_recOpen) return;
    if (e.target.closest && e.target.closest('.tabs [data-tab]')) teardown(false);
  }, true);

  window.rcpDirty = function () { _dirty = true; };

  // ── sub-tabs ──────────────────────────────────────────────────────────────
  const SUBTABS = [
    ['details',     () => T('Details', '基本信息')],
    ['ingredients', () => T('Ingredients', '原料')],
    ['steps',       () => T('Steps', '步骤')],
    ['cost',        () => T('Cost & Pricing', '成本与定价')],
  ];
  window.rcpSubtab = function (t) {
    _subtab = t;
    document.querySelectorAll('.rcp-subtab').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    document.querySelectorAll('.rcp-subbody').forEach(b => { b.hidden = b.dataset.t !== t; });
  };

  // Re-render ONE sub-tab body in place, never the whole record. paintRecord()
  // rebuilds detailsTab()/costTab() from `_rec`, which is only ever the last
  // SERVER-loaded row — calling it after an Ingredients/Steps edit would
  // silently discard whatever the operator had typed into Details or Cost &
  // Pricing's still-mounted, still-live inputs. Only 'ingredients' and 'steps'
  // ever call this; 'details'/'cost' only ever repaint via the full
  // paintRecord() on open or after a save, both points where _rec is fresh.
  function renderSubbody(key) {
    const el = document.querySelector('.rcp-subbody[data-t="' + key + '"]');
    if (!el) return;
    if (key === 'ingredients') el.innerHTML = ingredientsTab();
    else if (key === 'steps') el.innerHTML = stepsTab();
  }
  // The Ingredients tab's missing-cost count, shown as a badge on its own tab
  // button so it's visible even while looking at a different sub-tab.
  function updateIngredientsBadge() {
    const btn = document.querySelector('.rcp-subtab[data-t="ingredients"]');
    if (!btn) return;
    const n = liveCost().zeroCostIngredientLines;
    let badge = btn.querySelector('.rcp-badge');
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'rcp-badge blocked'; btn.appendChild(badge); }
      badge.textContent = n;
    } else if (badge) { badge.remove(); }
  }

  function field(label, inner, hint, span2) {
    return `<div class="rcp-f${span2 ? ' span2' : ''}"><span class="lbl">${esc(label)}</span>${inner}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
  }
  function input(key, val, attrs, extra) {
    return `<input class="rcp-input" id="rcp-f-${key}" value="${esc(val == null ? '' : val)}"`
         + ` oninput="rcpDirty();${extra || ''}" ${attrs || ''}>`;
  }
  function select(key, val, opts, extra) {
    const o = opts.map(([v, l]) => `<option value="${esc(v)}"${String(val == null ? '' : val) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    return `<select class="rcp-input" id="rcp-f-${key}" onchange="rcpDirty();${extra || ''}">${o}</select>`;
  }

  function paintRecord() {
    const host = recRoot();
    if (!host || !_rec) return;
    const m = _rec;
    const isNew = !m.id;

    const setTxt = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
    setTxt('rcp-rec-title', isNew ? T('New recipe', '新建食谱') : (m.name_en || T('Recipe', '食谱')));
    setTxt('rcp-rec-backlbl', T('Recipes', '食谱'));
    setTxt('rcp-rec-save', T('Save', '保存'));
    setTxt('rcp-rec-arch', m.is_active === 0 ? T('Restore', '恢复') : T('Archive', '归档'));
    const archBtn = document.getElementById('rcp-rec-arch');
    if (archBtn) archBtn.hidden = isNew;

    // §29 step 5 — state-dependent: "Make available as material" when
    // unlinked, "Linked to material: X" (click to unlink) when linked.
    // Hidden for a not-yet-saved recipe — nothing to link until it has an id.
    const mzBtn = document.getElementById('rcp-rec-materialize');
    if (mzBtn) {
      mzBtn.hidden = isNew;
      mzBtn.textContent = m.backsMaterial
        ? T('Linked to material: ', '已关联物料:') + m.backsMaterial.name_en
        : T('Make available as material', '设为可用物料');
    }

    const subnav = document.getElementById('rcp-subtabs');
    if (subnav) {
      const missing = liveCost().zeroCostIngredientLines;
      subnav.innerHTML = SUBTABS.map(([key, lbl]) => {
        const badge = key === 'ingredients' && missing > 0 ? `<span class="rcp-badge blocked">${missing}</span>` : '';
        return `<button type="button" class="rcp-subtab${_subtab === key ? ' on' : ''}" data-t="${key}" onclick="rcpSubtab('${key}')">${esc(lbl())}${badge}</button>`;
      }).join('');
    }

    host.innerHTML = `
      <div class="rcp-subbody" data-t="details" ${_subtab === 'details' ? '' : 'hidden'}>${detailsTab(m)}</div>
      <div class="rcp-subbody" data-t="ingredients" ${_subtab === 'ingredients' ? '' : 'hidden'}>${ingredientsTab()}</div>
      <div class="rcp-subbody" data-t="steps" ${_subtab === 'steps' ? '' : 'hidden'}>${stepsTab()}</div>
      <div class="rcp-subbody" data-t="cost" ${_subtab === 'cost' ? '' : 'hidden'}>${costTab(m)}</div>
    `;
    try { applyCapGates(); } catch (_) {}
    paintSummary();
  }

  // ── Details ──────────────────────────────────────────────────────────────
  function detailsTab(m) {
    const catOpts = [['', T('None', '无')]].concat(_cats.map(c => [c, c]));
    return `
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Identity', '基本信息'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Name (English)', '名称(英文)'), input('name_en', m.name_en, 'maxlength="120"'))}
          ${field(T('Name (中文)', '名称(中文)'), input('name_cn', m.name_cn, 'maxlength="120"'))}
          ${field(T('Category', '分类'), select('category', m.category, catOpts))}
          ${field(T('SKU', '货号'), input('sku', m.sku, 'maxlength="60"'),
                   T('Kept forever, even after archiving.', '归档后仍永久保留。'))}
        </div>
      </div>
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Batch', '批量'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Batch size (g)', '批量大小(克)'), input('batch_size', m.batch_size, 'type="number" min="0" step="any"', 'rcpRecompute()'),
                   T('Total grams the whole batch makes. Needed to work out cost per gram.', '整批的总克数,用于折算每克成本。'))}
          ${field(T('Servings', '份数'), input('servings', m.servings, 'type="number" min="0" step="1"', 'rcpRecompute()'),
                   T('Needed to work out cost per serving.', '用于折算每份成本。'))}
          ${field(T('Serving size (g)', '每份克数'), input('serving_size', m.serving_size, 'type="number" min="0" step="any"'))}
          ${field(T('Shelf life', '保质期'), input('shelf_life', m.shelf_life, 'maxlength="60"'))}
        </div>
      </div>
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Storage & notes', '储存与备注'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Storage', '储存方式'), input('storage', m.storage, 'maxlength="120"'))}
        </div>
        <div class="rcp-f" style="margin-top:16px">
          <span class="lbl">${esc(T('Notes', '备注'))}</span>
          <textarea class="rcp-input" id="rcp-f-notes" rows="3" oninput="rcpDirty()">${esc(m.notes || '')}</textarea>
        </div>
      </div>`;
  }

  // ── Ingredients ──────────────────────────────────────────────────────────
  function lineRow(l, idx) {
    const isFree = !!l.master_free;
    const hasCost = l.master_cost > 0 || isFree;
    const per = isFree ? T('free', '免费') : (hasCost ? `${moneyU(l.master_cost)}/${esc(l.master_unit || l.unit || '')}` : T('no cost', '无成本'));
    return `
      <div class="rcp-line">
        <div class="rcp-line-name">
          <div class="n">${esc(l.name_en || l.master_name_en || '')}</div>
          <div class="s${hasCost ? '' : ' warn'}">${esc(l.name_cn || '')}${l.name_cn ? ' · ' : ''}${esc(per)}${l.ingredient_id == null ? ' · ' + esc(T('material deleted', '物料已删除')) : ''}</div>
        </div>
        <input class="rcp-input rcp-line-qty" type="number" min="0" step="any" value="${esc(l.qty)}"
               oninput="rcpLineField(${idx},'qty',this.value)" placeholder="${esc(T('qty', '数量'))}">
        <select class="rcp-input rcp-line-unit" onchange="rcpLineField(${idx},'unit',this.value)">
          ${RECIPE_UNITS().map(u => `<option value="${esc(u)}"${l.unit === u ? ' selected' : ''}>${esc(u)}</option>`).join('')}
        </select>
        <span class="rcp-line-cost">${hasCost && !isFree ? money((Number(l.qty) || 0) * (l.master_cost || 0)) : (isFree ? esc(T('free', '免费')) : '—')}</span>
        <button type="button" class="rcp-line-rm" title="${esc(T('Remove', '移除'))}" onclick="rcpLineRemove(${idx})">${I.x}</button>
      </div>`;
  }

  function ingredientsTab() {
    const lines = _lines.map(lineRow).join('') || `<div class="rcp-emptyline">${esc(T('No ingredients yet.', '暂无原料。'))}</div>`;
    return `
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Ingredient lines', '原料明细'))}</h3>
        <div class="rcp-lines" id="rcp-lines">${lines}</div>
        <div class="rcp-pickwrap">
          <input class="rcp-input" id="rcp-pick-q" placeholder="${esc(T('Search materials to add…', '搜索要添加的物料…'))}"
                 oninput="rcpPickSearch(this.value)" autocomplete="off">
          <div id="rcp-pick-results"></div>
        </div>
      </div>`;
  }

  window.rcpLineField = function (idx, key, val) {
    if (!_lines[idx]) return;
    _lines[idx][key] = key === 'qty' ? (val === '' ? 0 : Number(val)) : val;
    _dirty = true;
    // Only the cost figure and the summary need to move — repainting the
    // whole tab on every keystroke would fight the input the operator is
    // typing into (same caret-loss failure Materials' search box guards
    // against). Cost is read straight from the DOM at save/recompute time.
    rcpRecompute();
  };
  window.rcpLineRemove = function (idx) {
    _lines.splice(idx, 1);
    _dirty = true;
    renderSubbody('ingredients');
    rcpRecompute();
    updateIngredientsBadge();
  };

  // The picker — GET /api/retail-admin/materials?for_recipe=1, the filter
  // shipped in step 3. Packaging-kind materials never appear here: packaging
  // cost is a separate field on the Cost & Pricing tab (recipe_cost_data.
  // packaging, sourced from packaging_types) and allowing a packaging-kind
  // ingredient line here too would cost the same jar twice with nothing to
  // reconcile the two figures. This screen does not explain that absence —
  // there is nowhere honest to say it without implying a jar belongs here.
  window.rcpPickSearch = function (v) {
    clearTimeout(_pickTimer);
    const q = (v || '').trim();
    if (!q) { _pickResults = []; renderPick(); return; }
    _pickTimer = setTimeout(async () => {
      try {
        const j = await api('/api/retail-admin/materials?for_recipe=1&search=' + encodeURIComponent(q));
        _pickResults = (j.data || []).filter(m => !_lines.some(l => l.ingredient_id === m.id));
      } catch (e) { _pickResults = []; }
      renderPick();
    }, 220);
  };
  function renderPick() {
    const host = document.getElementById('rcp-pick-results');
    if (!host) return;
    if (!_pickResults.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="rcp-pick">` + _pickResults.slice(0, 8).map(m => `
      <div class="rcp-pick-item" onclick="rcpPickAdd(${m.id})">
        <span>${esc(m.name_en || '')}${m.name_cn ? ' · ' + esc(m.name_cn) : ''}</span>
        <span class="s">${m.cost_per_unit > 0 ? moneyU(m.cost_per_unit) + '/' + esc(m.unit || '') : esc(T('no cost', '无成本'))}</span>
      </div>`).join('') + `</div>`;
  }
  window.rcpPickAdd = function (id) {
    const m = _pickResults.find(x => x.id === id);
    if (!m) return;
    _lines.push({
      ingredient_id: m.id, name_en: m.name_en, name_cn: m.name_cn, sku: m.sku,
      qty: 0, unit: m.unit || 'g', notes: null, substitutes: null,
      master_cost: m.cost_per_unit, master_unit: m.unit, master_free: m.free_by_design, master_name_en: m.name_en,
    });
    _dirty = true;
    _pickResults = [];
    renderSubbody('ingredients');
    rcpRecompute();
    updateIngredientsBadge();
  };
  document.addEventListener('click', (e) => {
    if (!_recOpen) return;
    if (e.target.closest && e.target.closest('.rcp-pickwrap')) return;
    if (_pickResults.length) { _pickResults = []; renderPick(); }
  });

  // ── Steps ────────────────────────────────────────────────────────────────
  function stepRow(s, idx) {
    return `
      <div class="rcp-step">
        <div class="rcp-step-n">${idx + 1}</div>
        <div class="rcp-step-body">
          <input class="rcp-input" value="${esc(s.name || '')}" placeholder="${esc(T('Step name (optional)', '步骤名称(可选)'))}"
                 oninput="rcpStepField(${idx},'name',this.value)">
          <textarea class="rcp-input" rows="2" placeholder="${esc(T('Instructions', '操作说明'))}"
                    oninput="rcpStepField(${idx},'instructions',this.value)">${esc(s.instructions || '')}</textarea>
        </div>
        <div class="rcp-step-acts">
          <button type="button" title="${esc(T('Move up', '上移'))}" ${idx === 0 ? 'disabled' : ''} onclick="rcpStepMove(${idx},-1)">${I.up}</button>
          <button type="button" title="${esc(T('Move down', '下移'))}" ${idx === _steps.length - 1 ? 'disabled' : ''} onclick="rcpStepMove(${idx},1)">${I.down}</button>
          <button type="button" class="rm" title="${esc(T('Remove', '移除'))}" onclick="rcpStepRemove(${idx})">${I.x}</button>
        </div>
      </div>`;
  }
  function stepsTab() {
    const rows = _steps.map(stepRow).join('') || `<div class="rcp-emptyline">${esc(T('No steps yet.', '暂无步骤。'))}</div>`;
    return `
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Steps', '步骤'))}</h3>
        <div id="rcp-steps">${rows}</div>
        <div style="margin-top:14px">
          <button type="button" class="rcp-btn sm" onclick="rcpStepAdd()"><span class="rcp-ic">${I.plus}</span>${esc(T('Add step', '添加步骤'))}</button>
        </div>
      </div>`;
  }
  window.rcpStepField = function (idx, key, val) { if (_steps[idx]) { _steps[idx][key] = val; _dirty = true; } };
  window.rcpStepAdd = function () { _steps.push({ name: '', instructions: '' }); _dirty = true; renderSubbody('steps'); };
  window.rcpStepRemove = function (idx) { _steps.splice(idx, 1); _dirty = true; renderSubbody('steps'); };
  window.rcpStepMove = function (idx, dir) {
    const to = idx + dir;
    if (to < 0 || to >= _steps.length) return;
    const [s] = _steps.splice(idx, 1);
    _steps.splice(to, 0, s);
    _dirty = true;
    renderSubbody('steps');
  };

  // ── Cost & Pricing ───────────────────────────────────────────────────────
  function costTab(m) {
    const cd = m.costData || {};
    return `
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Inputs', '成本输入'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Labour', '人工'), input('labour', cd.labour, 'type="number" min="0" step="any"', 'rcpRecompute()'))}
          ${field(T('Packaging (per serving)', '包装(每份)'), input('packaging', cd.packaging, 'type="number" min="0" step="any"', 'rcpRecompute()'),
                   T('A per-serving packaging figure — set up under Packaging types in the kitchen app.', '每份包装成本 —— 在后厨应用的“包装类型”中设置。'))}
          ${field(T('Overhead %', '管理费用 %'), input('overhead_pct', cd.overhead_pct, 'type="number" min="0" step="any"', 'rcpRecompute()'))}
          ${field(T('Sell price', '售价'), input('sell_price', cd.sell_price, 'type="number" min="0" step="any"', 'rcpRecompute()'))}
          ${field(T('Target food cost %', '目标食品成本 %'), input('target_food_cost', cd.target_food_cost == null ? 30 : cd.target_food_cost, 'type="number" min="0" step="any"', 'rcpRecompute()'))}
        </div>
        <div class="rcp-breakdown" id="rcp-breakdown"></div>
      </div>`;
  }

  // The one shared derivation (lib/recipe-cost.js), loaded over HTTP exactly
  // like Materials loads lib/ingredient-cost.js — so this screen's numbers
  // and the server's stored numbers can never disagree. Reads Details'
  // batch_size/servings and Cost & Pricing's inputs straight off the DOM,
  // which is why all four sub-tab bodies stay mounted at once rather than
  // being re-rendered per tab switch.
  function draftDetails() {
    const v = k => { const el = document.getElementById('rcp-f-' + k); return el ? el.value : (_rec ? _rec[k] : null); };
    return { batch_size: v('batch_size') || null, servings: v('servings') || null };
  }
  function draftCostData() {
    const v = k => { const el = document.getElementById('rcp-f-' + k); return el ? el.value : null; };
    return {
      labour: parseFloat(v('labour')) || 0,
      packaging: parseFloat(v('packaging')) || 0,
      overhead_pct: parseFloat(v('overhead_pct')) || 0,
      sell_price: parseFloat(v('sell_price')) || 0,
      target_food_cost: parseFloat(v('target_food_cost')) || 30,
    };
  }
  function liveCost() {
    const c = COST();
    if (!c) return _rec && _rec.cost ? _rec.cost : { zeroCostIngredientLines: 0, lines: [] };
    return c.computeRecipeCost({ recipe: draftDetails(), ingredients: _lines, costData: draftCostData() });
  }

  window.rcpRecompute = function () {
    _dirty = true;
    paintSummary();
    const bk = document.getElementById('rcp-breakdown');
    if (bk) bk.innerHTML = breakdownHtml(liveCost());
  };

  function breakdownHtml(c) {
    const row = (lbl, val, cls) => `<div class="rcp-bkrow${cls ? ' ' + cls : ''}"><span>${esc(lbl)}</span><b>${val}</b></div>`;
    return [
      row(T('Ingredient cost', '原料成本'), money(c.ingredientCost)),
      row(T('Labour', '人工'), money(c.labour)),
      row(T('Packaging (batch)', '包装(整批)'), money(c.packagingTotal)),
      row(T('Overhead', '管理费用'), money(c.overheadAmount)),
      row(T('Batch cost', '整批成本'), money(c.batchCost), 'total'),
      row(T('Cost per serving', '每份成本'), c.costPerServing != null ? money(c.costPerServing) : '— ' + T('(no servings)', '(未记录份数)')),
      row(T('Cost per gram', '每克成本'), c.costPerGram != null ? moneyU(c.costPerGram) : '— ' + T('(no batch size)', '(未记录批量)')),
      c.sellPrice > 0 ? row(T('Margin per serving', '每份毛利'), c.marginPerServing != null ? money(c.marginPerServing) : '—') : '',
      c.sellPrice > 0 ? row(T('Food cost %', '食品成本率'), c.foodCostPct != null ? c.foodCostPct.toFixed(1) + '%' : '—') : '',
      row(T('Suggested sell price', '建议售价'), c.suggestedSellPrice != null ? money(c.suggestedSellPrice) : '—'),
    ].join('');
  }

  // ── the persistent summary — must read correctly no matter which sub-tab
  //    is open, and must never let a partly-priced recipe look free. ───────
  function paintSummary() {
    const host = sumRoot();
    if (!host || !_rec) return;
    const c = liveCost();
    const missing = c.zeroCostIngredientLines > 0;
    const primary = c.costPerServing != null
      ? { lbl: T('Cost per serving', '每份成本'), v: money(c.costPerServing) }
      : (c.costPerGram != null ? { lbl: T('Cost per gram', '每克成本'), v: moneyU(c.costPerGram) } : null);

    let html = `<div class="rcp-sumrow">
      <div class="rcp-sumfig"><span class="lbl">${esc(T('Batch cost', '整批成本'))}</span><span class="v">${money(c.batchCost)}</span></div>
      ${primary ? `<div class="rcp-sumfig"><span class="lbl">${esc(primary.lbl)}</span><span class="v">${primary.v}</span></div>`
                : `<div class="rcp-sumfig"><span class="lbl">${esc(T('Per-unit cost', '单位成本'))}</span><span class="v dim">${esc(T('No batch size or servings recorded', '未记录批量大小或份数'))}</span></div>`}
    </div>`;

    // The warning — real number above, honest reason here. Never swap the
    // number out; only ever add this alongside it.
    if (missing) {
      html += `<div class="rcp-warn">${I.warn}<span>${esc(T(
        `${c.zeroCostIngredientLines} ingredient${c.zeroCostIngredientLines === 1 ? '' : 's'} missing cost — costs shown are too low`,
        `${c.zeroCostIngredientLines} 项原料缺少成本 — 显示成本偏低`))}</span></div>`;
    }

    // Backs material — no link/materialize affordance (that ships later);
    // this is a read-only status line. Blocked shows the frozen figure PLUS
    // why, so it never reads as simply "the material costs ¥0".
    if (_rec.backsMaterial) {
      const mb = _rec.materialBlock;
      const blocked = mb && !mb.ok;
      const cpu = _rec.backsMaterial.cost_per_unit;
      const unitTxt = _rec.backsMaterial.unit || 'g';
      const costTxt = cpu > 0 ? `${moneyU(cpu)}/${esc(unitTxt)}` : T('not yet costed', '尚未计算成本');
      html += `<div class="rcp-matline${blocked ? ' blocked' : ''}">`
        + esc(T('Backs material: ', '产出为物料:')) + `<b>${esc(_rec.backsMaterial.name_en)}</b> — ${costTxt}`
        + (blocked ? ` — ${esc(T('frozen at its last computed value.', '已冻结为最近一次计算的值。'))} ${esc(blockReasonText(mb.reason, mb.unpriced))}` : '')
        + `</div>`;
    }

    host.innerHTML = html;
  }

  // ── save ──────────────────────────────────────────────────────────────────
  function val(key) {
    const el = document.getElementById('rcp-f-' + key);
    return el ? el.value : (_rec ? _rec[key] : undefined);
  }
  function readDetails() {
    return {
      name_en: String(val('name_en') || '').trim(),
      name_cn: String(val('name_cn') || '').trim(),
      sku: String(val('sku') || '').trim(),
      category: val('category') || '',
      batch_size: val('batch_size') === '' ? null : Number(val('batch_size')),
      servings: val('servings') === '' ? null : Number(val('servings')),
      serving_size: val('serving_size') === '' ? null : Number(val('serving_size')),
      shelf_life: val('shelf_life') || '',
      storage: val('storage') || '',
      notes: val('notes') || '',
    };
  }

  window.rcpSave = async function () {
    if (!_rec) return;
    const body = readDetails();
    if (!body.name_en) { toast(T('An English name is required', '英文名称必填'), 'err'); rcpSubtab('details'); return; }
    body.ingredients = _lines.map(l => ({
      ingredient_id: l.ingredient_id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
      qty: Number(l.qty) || 0, unit: l.unit || 'g', notes: l.notes || null, substitutes: l.substitutes || null,
    }));
    body.steps = _steps.map(s => ({ name: s.name || null, instructions: s.instructions || null }));
    const id = _rec.id;
    try {
      let recipeId = id;
      if (id) {
        await api('/api/retail-admin/recipes/' + id, { method: 'PUT', body });
      } else {
        const j = await api('/api/retail-admin/recipes', { method: 'POST', body });
        recipeId = j.id;
      }
      // Cost & Pricing — sent whenever the tab has been touched or a fresh
      // save is happening; harmless to send unconditionally (an all-default
      // upsert on an untouched recipe just stores the defaults it already had).
      await api('/api/retail-admin/recipes/' + recipeId + '/cost', { method: 'PUT', body: draftCostData() });
      _dirty = false;
      toast(T('Saved', '已保存'));
      const fresh = await api('/api/retail-admin/recipes/' + recipeId);
      setRecord(fresh.data);
      paintRecord();
    } catch (e) {
      const msg = (e.data && e.data.message) || e.message || '';
      toast(T('Save failed', '保存失败') + ': ' + msg, 'err');
    }
  };

  window.rcpArchive = async function () {
    if (!_rec || !_rec.id) return;
    const restoring = _rec.is_active === 0;
    const ok = restoring
      ? await askConfirm({
          titleEn: 'Bring this recipe back?', titleCn: '恢复该食谱?',
          confirmEn: 'Restore', confirmCn: '恢复',
        })
      : await askConfirm({
          titleEn: 'Archive this recipe?', titleCn: '归档该食谱?',
          bodyEn: 'You can bring it back later.', bodyCn: '之后可以恢复。',
          confirmEn: 'Archive', confirmCn: '归档', danger: true,
        });
    if (!ok) return;
    try {
      await api('/api/retail-admin/recipes/' + _rec.id + '/archive', { method: 'PUT', body: { restore: restoring } });
      toast(restoring ? T('Restored', '已恢复') : T('Archived', '已归档'));
      _dirty = false;
      teardown(false);
      goTab('recipes');
    } catch (e) {
      toast(T('Failed', '操作失败') + ': ' + (e.message || ''), 'err');
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  §29 STEP 5 — "Make available as material"
  // ═══════════════════════════════════════════════════════════════════════
  // POST/DELETE /api/retail-admin/recipes/:id/materialize (routes/retail-
  // recipes.js, backed by lib/recipe-materialize.js) is the ONLY client-
  // reachable path that writes ingredients.source_recipe_id — the Materials
  // save path refuses that field on purpose. This is a centered modal (built
  // once, appended to <body>, torn down on close), not a second page — the
  // same visual system tacet-dialogs.js's askConfirm/askPrompt use
  // (.tdlg-scrim/.tdlg-modal, already loaded and styled globally), extended
  // here with the search-and-pick / mode-tab bits this action needs that
  // those simple text dialogs don't have. Its own .rcp-mz-* classes are
  // scoped under .rcp-mz-modal, not under #tab-recipes-record — the modal
  // lives outside that section in the DOM (appended to body), so a rule
  // scoped by that id would silently apply to nothing.
  const MZ_KIND_LABEL = {
    food:      () => T('Food', '食品'),
    packaging: () => T('Packaging', '包装'),
    equipment: () => T('Equipment', '设备'),
    retail:    () => T('Retail', '零售'),
    other:     () => T('Other', '其他'),
  };

  window.rcpMaterializeClick = async function () {
    if (!_rec || !_rec.id) return;
    if (_rec.backsMaterial) { unlinkFlow(); return; }
    openMaterializeModal();
  };

  async function unlinkFlow() {
    const name = _rec.backsMaterial.name_en;
    const ok = await askConfirm({
      titleEn: 'Unlink this material?', titleCn: '取消关联该物料?',
      bodyEn: `"${name}" stops being backed by this recipe. It is not deleted, and any other recipe already using it keeps using it — its cost just stops updating from here.`,
      bodyCn: `"${name}" 将不再由本食谱产出。该物料不会被删除,其他正在使用它的食谱不受影响 —— 只是它的成本将不再随本食谱更新。`,
      confirmEn: 'Unlink', confirmCn: '取消关联', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/retail-admin/recipes/' + _rec.id + '/materialize', { method: 'DELETE' });
      toast(T('Unlinked', '已取消关联'));
      const fresh = await api('/api/retail-admin/recipes/' + _rec.id);
      setRecord(fresh.data);
      paintRecord();
    } catch (e) {
      toast(T('Failed', '操作失败') + ': ' + (e.message || ''), 'err');
    }
  }

  function openMaterializeModal() {
    const mz = { mode: 'new', selected: null, results: [], searchTimer: null };
    const kindOpts = ['food', 'packaging', 'equipment', 'retail', 'other']
      .map(k => `<option value="${k}"${k === 'food' ? ' selected' : ''}>${esc(MZ_KIND_LABEL[k]())}</option>`).join('');

    const bodyHtml = `
      <h3 class="tdlg-title">${esc(T('Make available as material', '设为可用物料'))}</h3>
      <p class="tdlg-msg">${esc(T('Lets another recipe use what this one makes as an ingredient.', '让其他食谱可以将本食谱的产出作为原料使用。'))}</p>
      <div class="rcp-mz-tabs">
        <button type="button" class="rcp-mz-tab on" data-t="new">${esc(T('Create new', '新建'))}</button>
        <button type="button" class="rcp-mz-tab" data-t="link">${esc(T('Link existing', '关联现有'))}</button>
      </div>
      <div class="rcp-mz-pane" data-t="new">
        <div class="tdlg-field"><label for="rcp-mz-name_en">${esc(T('Name (English)', '名称(英文)'))}</label>
          <input id="rcp-mz-name_en" type="text" value="${esc(_rec.name_en || '')}"></div>
        <div class="tdlg-field"><label for="rcp-mz-name_cn">${esc(T('Name (中文)', '名称(中文)'))}</label>
          <input id="rcp-mz-name_cn" type="text" value="${esc(_rec.name_cn || '')}"></div>
        <div class="tdlg-field"><label>${esc(T('Recipe unit', '配方单位'))}</label>
          <input type="text" value="g" disabled></div>
        <div class="tdlg-field"><label for="rcp-mz-sku">${esc(T('SKU (optional)', '货号(可选)'))}</label>
          <input id="rcp-mz-sku" type="text"></div>
        <div class="tdlg-field"><label for="rcp-mz-kind">${esc(T('Kind', '类别'))}</label>
          <select id="rcp-mz-kind">${kindOpts}</select></div>
      </div>
      <div class="rcp-mz-pane" data-t="link" hidden>
        <div class="tdlg-field"><label for="rcp-mz-search">${esc(T('Search materials', '搜索物料'))}</label>
          <input id="rcp-mz-search" type="text" placeholder="${esc(T('Name or SKU…', '名称或货号…'))}" autocomplete="off"></div>
        <div id="rcp-mz-results"></div>
        <div id="rcp-mz-selected"></div>
      </div>
      <div class="rcp-mz-hint" id="rcp-mz-hint"></div>`;
    const footHtml = `
      <button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>${esc(T('Cancel', '取消'))}</button>
      <button type="button" class="tdlg-btn tdlg-btn--primary" data-submit disabled>${esc(T('Make available', '设为可用'))}</button>`;
    // Shared shell (public/tacet-dialogs.js askCustom) — same mechanism
    // askConfirm/askPrompt/askReason use underneath, not a parallel build.
    // Handles injectStyle() (so .tdlg-scrim/.tdlg-modal are actually styled
    // and centered the first time ANY dialog opens in a page session, not
    // only after some other askConfirm has run once), the backdrop, Escape,
    // outside-click, entrance/exit animation, and focus-restore-on-close.
    const { scrim, closer } = askCustom('tdlg-neutral rcp-mz-modal', bodyHtml, footHtml, '#rcp-mz-name_en');
    const close = () => closer(null);
    scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));

    const submitBtn = scrim.querySelector('[data-submit]');
    // Evaluated on open AND on every relevant change — not only in response to
    // typing/picking. The 'new' tab's name field starts PREFILLED from the
    // recipe (bodyHtml above, value="${_rec.name_en}"), so a version of this
    // that only ran from an input/change LISTENER never fired for the common
    // case of
    // "open the modal, everything already looks right, click Make available"
    // — the button stayed disabled forever with nothing to explain why, since
    // it was never actually re-evaluated after the markup's hardcoded
    // `disabled` attribute rendered. Names the actual missing field rather
    // than leaving a dead button with no explanation, per the same rule the
    // server-side guards follow (§29 step 5).
    function updateSubmitState() {
      let reason = null;
      if (mz.mode === 'new') {
        if (!scrim.querySelector('#rcp-mz-name_en').value.trim()) reason = T('An English name is required.', '英文名称为必填项。');
      } else if (!mz.selected) {
        reason = T('Pick a material to link.', '请选择一个要关联的物料。');
      }
      submitBtn.disabled = !!reason;
      const hint = scrim.querySelector('#rcp-mz-hint');
      if (hint) hint.textContent = reason || '';
    }
    updateSubmitState();

    // ── mode tabs ──
    scrim.querySelectorAll('.rcp-mz-tab').forEach(b => b.addEventListener('click', () => {
      mz.mode = b.dataset.t;
      scrim.querySelectorAll('.rcp-mz-tab').forEach(x => x.classList.toggle('on', x === b));
      scrim.querySelectorAll('.rcp-mz-pane').forEach(x => { x.hidden = x.dataset.t !== mz.mode; });
      updateSubmitState();
    }));
    scrim.querySelector('#rcp-mz-name_en').addEventListener('input', updateSubmitState);

    // ── search-and-pick (mode='link') ──
    // GET /api/retail-admin/materials?for_recipe=1 — the filter shipped in
    // step 3 (excludes packaging/equipment/retail, always includes made
    // materials). Filtered again here, client-side, to exactly what this
    // action may legally link: unit='g' and not already linked elsewhere —
    // the two required guards, applied BEFORE the operator can even pick an
    // invalid candidate, not just after. The server re-checks both
    // regardless (never trust the client); this is UX, not the enforcement.
    function renderResults() {
      const host = scrim.querySelector('#rcp-mz-results');
      if (!mz.results.length) { host.innerHTML = ''; return; }
      host.innerHTML = `<div class="rcp-mz-pick">` + mz.results.slice(0, 8).map(m => `
        <div class="rcp-mz-pick-item" data-id="${m.id}">
          <span>${esc(m.name_en || '')}${m.name_cn ? ' · ' + esc(m.name_cn) : ''}</span>
          <span class="s">${m.cost_per_unit > 0 ? moneyU(m.cost_per_unit) + '/g' : esc(T('no cost', '无成本'))}</span>
        </div>`).join('') + `</div>`;
      host.querySelectorAll('.rcp-mz-pick-item').forEach(el => el.addEventListener('click', () => {
        mz.selected = mz.results.find(m => m.id === Number(el.dataset.id)) || null;
        renderSelected();
        host.innerHTML = '';
        scrim.querySelector('#rcp-mz-search').value = mz.selected ? mz.selected.name_en : '';
        updateSubmitState();
      }));
    }
    function renderSelected() {
      const host = scrim.querySelector('#rcp-mz-selected');
      if (!mz.selected) { host.innerHTML = ''; return; }
      const m = mz.selected;
      // Soft warning — informational, never blocking. buy_price is already in
      // the search payload, so this needs no extra request; the server also
      // checks purchase-history-beyond-buy_price at write time and surfaces
      // that in its own response, toasted after a successful link.
      const warn = m.buy_price > 0
        ? `<div class="rcp-mz-warn">${esc(T('This material has a buy price — linking will switch its cost to come from this recipe instead.', '该物料已有采购价 —— 关联后其成本将改为来自本食谱。'))}</div>`
        : '';
      host.innerHTML = `<div class="rcp-mz-selline">${esc(T('Selected: ', '已选择:'))}<b>${esc(m.name_en)}</b></div>${warn}`;
    }
    scrim.querySelector('#rcp-mz-search').addEventListener('input', (e) => {
      clearTimeout(mz.searchTimer);
      mz.selected = null;
      renderSelected();
      updateSubmitState();
      const q = e.target.value.trim();
      if (!q) { mz.results = []; renderResults(); return; }
      mz.searchTimer = setTimeout(async () => {
        try {
          const j = await api('/api/retail-admin/materials?for_recipe=1&search=' + encodeURIComponent(q));
          mz.results = (j.data || []).filter(m => (m.unit || 'g') === 'g' && m.source_recipe_id == null);
        } catch (err) { mz.results = []; }
        renderResults();
      }, 220);
    });

    // ── submit ──
    submitBtn.addEventListener('click', async () => {
      const body = mz.mode === 'link'
        ? { mode: 'link', material_id: mz.selected.id }
        : {
            mode: 'new',
            name_en: scrim.querySelector('#rcp-mz-name_en').value.trim(),
            name_cn: scrim.querySelector('#rcp-mz-name_cn').value.trim(),
            sku: scrim.querySelector('#rcp-mz-sku').value.trim(),
            item_kind: scrim.querySelector('#rcp-mz-kind').value,
          };
      submitBtn.disabled = true;
      try {
        const j = await api('/api/retail-admin/recipes/' + _rec.id + '/materialize', { method: 'POST', body });
        close();
        // The rollup already ran server-side (lib/recipe-materialize.js calls
        // fireRecompute, never writes a cost directly) — re-fetch so the
        // record shows the real computed (or correctly blocked) cost on
        // first paint rather than the blank pre-link state.
        toast(j.warning || T('Now available as a material', '已设为可用物料'), 'ok', j.warning ? 5000 : undefined);
        const fresh = await api('/api/retail-admin/recipes/' + _rec.id);
        setRecord(fresh.data);
        paintRecord();
      } catch (e) {
        submitBtn.disabled = false;
        const msg = (e.data && e.data.message) || e.message || '';
        toast(T('Failed', '操作失败') + ': ' + msg, 'err');
      }
    });
  }
})();
