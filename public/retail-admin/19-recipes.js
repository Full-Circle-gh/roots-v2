/* eslint-disable no-undef */
/* retail-admin app JS — part 19.  Recipes (食谱), §29, 2026-08-25.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, cuT, can, applyCapGates, goTab, askConfirm) live in
   01-core.js. window.RootsRecipeCost (/lib/recipe-cost.js) must load before
   this file — see the <script> order in retail-admin.html.
   The record header also reads _paMargin (part 09) for the margin on each
   product this recipe makes, and dashOpenProductFromFeed (part 03) to open
   one — both load earlier, and both are reused rather than copied so this
   screen cannot start quoting a different margin from the Products list.

   Recipes generalises the kitchen machinery the same way Materials did —
   same recipes/recipe_ingredients/recipe_steps/recipe_cost_data tables,
   this is the multi-tenant door onto them (routes/retail-recipes.js).

   SCOPE (§29): cost-only. No quantity/stock tracking.

   The record header NAMES the retail products this recipe makes, with each
   one's own price and margin, and links through to the product editor. That
   direction is READ-ONLY: the link is owned and edited on the product side,
   and there is deliberately no affordance to change it from here. Each
   product is priced separately and never blended — one recipe can feed a
   150g bag and a 25g sample at two prices, and one averaged margin across
   them would be true of neither.

   THE RECORD SAVES ITSELF (2026-09-03). There is no "did I press Save?"
   moment on this screen any more: an edit is on the server within a second or
   two, the sticky header says so continuously, and Save survives as the
   deliberate mark that files its own restore point. That is only safe because
   the other half shipped with it — every save, from EITHER door, files the
   state it displaced (lib/recipe-versions.js) and rcpHistory() puts one back.
   Autosave without that history is not a convenience, it is a delete key with
   no confirm. Do not keep one without the other.

   AND THE HEADER IS STICKY, for the same reason the summary is persistent: a
   recipe with thirty ingredient lines is several screens tall, and which
   recipe this is, the way back, and whether the work is recorded are needed at
   the bottom of it as much as at the top. Once the summary card scrolls under
   the bar, the bar grows a miniature of its figures — "never let a recipe look
   free" is a rule about every scroll position, not just the first one.

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

  // The tenant's display currency (01-core.js acMoney), not a hardcoded ¥.
  const money = n => (typeof acMoney === 'function'
    ? acMoney(Number(n) || 0)
    : '¥' + (typeof fmt === 'function' ? fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2)));
  // Cost PER GRAM is often sub-cent (¥0.0114) — the plain money() would round
  // it to ¥0.01 and lose the figure entirely on a screen whose whole point is
  // not looking free. Same reasoning as the recipe Excel export's UNIT_MONEY
  // format (lib/recipe-cost.js / routes/recipes.js export route). TWO PLACES
  // BEYOND the currency's own, so this keeps its 4dp for a 2dp currency and
  // still shows sub-unit detail for a 0dp one (JPY) rather than a bare integer.
  const moneyU = n => (typeof acMoney === 'function'
    ? acMoney(Number(n) || 0, (typeof acCurrency === 'function' ? acCurrency().decimals : 2) + 2)
    : '¥' + (Number(n) || 0).toFixed(4));
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

  // ── Recipe type ───────────────────────────────────────────────────────────
  // What kind of thing a recipe is, for FILING ONLY. "Made" is something the
  // kitchen assembles; "Repacked" is bulk bought in and poured into retail
  // packs. Nothing on this screen or anywhere else behaves differently because
  // of it — cost, the products a recipe makes, the material it backs and every
  // nested-recipe rollup read exactly the same whichever value a recipe
  // carries, and nothing may start gating on it.
  //
  // ── Where the Chinese came from ────────────────────────────────
  // §30 rule 3 and docs/tacet-delivery-vocabulary.md Rule 4 say the same
  // thing: copy from the source, never compose. Both words below are COPIED
  // from language already live in this tenant's own data, which is what that
  // rule protects — the same way 物料 was taken rather than invented:
  //
  //   自制  — from the recipe category "Homemade in the Kitchen 厨房自制"
  //   分装  — from the material 真空袋分装器
  //
  // Recorded here so a later reader can check the source rather than assume
  // these were composed. Confirmed by Ash on 2026-08-26.
  const RECIPE_TYPES = [
    ['made',     () => T('Made', '自制')],
    ['repacked', () => T('Repacked', '分装')],
  ];

  // Coldest to warmest, matching food-safety convention (frozen → chilled →
  // ambient). Confirmed by Ash on 2026-09-03.
  const STORAGE_OPTIONS = [
    ['freezer',   () => T('Freezer', '冷冻')],
    ['fridge',    () => T('Fridge', '冷藏')],
    ['room_temp', () => T('Room temperature', '常温')],
  ];

  // ── module state ──────────────────────────────────────────────────────────
  let _init = false;
  let _rows = [];
  let _cats = [];
  let _cat = '';
  let _q = '';
  let _type = '';          // '' = all | 'made' | 'repacked' — client-side, opens on all
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
      </div>
      ${typeChips()}`;
  }

  // Made / Repacked as a row of chips — the same control the Products list
  // uses for categories (.pa-chip: full-round pill, hairline, Ink fill when
  // active, the count as a neutral token beside it), minted here under the
  // rcp- prefix like every other class on this screen.
  //
  // OPENS ON ALL, always, for every tenant. There is no default and no
  // setting: a tenant whose catalogue is mostly repacks must not open their
  // Recipes list with most of it hidden.
  function typeChips() {
    const count = v => (v ? _rows.filter(r => (r.recipe_type || 'made') === v).length : _rows.length);
    const chip = (val, label) =>
      `<button type="button" class="rcp-chip${_type === val ? ' is-on' : ''}" onclick="rcpSetType('${val}')">`
      + `${esc(label)}<span class="rcp-chip-n">${count(val)}</span></button>`;
    return `<div class="rcp-chips">`
      + chip('', T('All', '全部'))
      + RECIPE_TYPES.map(([v, lbl]) => chip(v, lbl())).join('')
      + `</div>`;
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

  // The rows in view — everything the server returned, narrowed by the type
  // chip. Type is the ONE filter applied client-side (search / category /
  // archived are all server-side query params): the chips carry a count each,
  // and those counts have to be counts of rows the server did not already
  // drop, or they would only ever read 0 for whichever chip is not picked.
  function rowsInView() {
    if (!_type) return _rows;
    return _rows.filter(r => (r.recipe_type || 'made') === _type);
  }

  function tableHtml() {
    const view = rowsInView();
    if (!view.length) {
      const blank = _q || _cat || _type;
      return `
        <div class="rcp-card rcp-empty">
          <div class="rcp-empty-ico">${I.book}</div>
          <h3>${esc(blank ? T('Nothing matches', '没有匹配项') : T('No recipes yet', '暂无食谱'))}</h3>
          <p>${esc(blank
            ? T('Try a different search, or clear the filters.', '换个搜索词,或清除筛选条件。')
            : T('A recipe is what you make and what it costs — ingredients, steps, batch size. Add the first one.', '食谱是你制作的东西及其成本 —— 原料、步骤、批量大小。新建第一份。'))}</p>
        </div>`;
    }
    const rows = view.map(rcp => {
      const pc = primaryCost(rcp);
      const costCell = pc
        ? `<span title="${esc(pc.title)}">${pc.text}</span>`
        : `<span title="${esc(T('No batch size or servings recorded — showing the whole-batch cost instead', '未记录批量大小或份数 — 显示整批成本'))}">${money(rcp.batchCost)}<span class="rcp-per"> ${esc(T('(batch)', '(整批)'))}</span></span>`;
      // ── THE ONE ICON, FOR EITHER WAY THE COST COMES OUT TOO LOW ───────────
      //
      // This row's cost can be understated for two different reasons, and until
      // now the icon could only see one of them. A recipe whose only fault was
      // a unit mismatch — 36 of them on live data — sat in this list with a
      // clean cost column and nothing beside the name, which is the exact
      // silence the record screen's UNIT MISMATCH pill was added to break. The
      // pill only speaks once the recipe is OPEN; this list is what gets
      // scanned.
      //
      // ONE TRIANGLE, NOT TWO. Two icons side by side in a name cell read as a
      // severity rather than as two facts, and both are saying the same thing
      // about the same column — the figure to the right is lower than the truth.
      // Both sentences go in the one tooltip when both hold, ordered as the
      // record card orders its pills.
      //
      // UNIT MISMATCH · 单位不符 is the LOCKED pair
      // (docs/tacet-delivery-vocabulary.md, minted by Ash 2026-08-27), copied
      // rather than retyped, and it carries no count — the locked string has no
      // slot for one and widening it here would be composing a variant of a
      // locked pair. The missing-cost sentence keeps its count and its own
      // sourced Chinese exactly as it was.
      const warnBits = [];
      if (rcp.zeroCostIngredientLines > 0) {
        warnBits.push(T(`${rcp.zeroCostIngredientLines} ingredient(s) missing cost — costs shown are too low`,
                        `${rcp.zeroCostIngredientLines} 项原料缺少成本 — 显示成本偏低`));
      }
      if (rcp.unreconciledUnitLines > 0) {
        warnBits.push(T('UNIT MISMATCH', '单位不符'));
      }
      const warnIcon = warnBits.length
        ? `<span class="rcp-warnic" title="${esc(warnBits.join(' · '))}">${I.warn}</span>`
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
  // Repaints only — the rows are already here, so there is no fetch and no
  // flash of “Loading…” between two states of the same list.
  window.rcpSetType = function (t) { _type = t || ''; paintList(); };
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
      id: null, name_en: '', name_cn: '', sku: '', category: '', recipe_type: 'made',
      batch_size: null, servings: null, serving_size: null,
      shelf_life: '', storage: '', notes: '', is_active: 1,
      ingredients: [], steps: [], costData: null, cost: null,
      backsMaterial: null, materialBlock: null,
    });
    openTakeover();
  };

  // `keepTab` is for a re-read of the SAME record — a save, a restore, a
  // material being linked. Those all repaint, and sending the operator back to
  // Details each time is how a save from the Cost & Pricing tab used to lose
  // his place. Opening a DIFFERENT recipe still starts on Details.
  function setRecord(row, keepTab) {
    _rec = row;
    _lines = (row.ingredients || []).map(l => ({ ...l }));
    _steps = (row.steps || []).map(s => ({ ...s }));
    if (!keepTab) _subtab = 'details';
  }

  function openTakeover() {
    if (_recOpen) { paintRecord(); return; }
    _recOpen = true;
    _dirty = false;
    _autoOff = false;
    _saveErr = null;
    _savedAt = 0;
    cancelAutosave();
    goTab('recipes-record');
    document.body.classList.add('rcp-viewing');
    history.pushState({ rcpRec: true }, '');
    window.addEventListener('popstate', onPop);
    const sc = document.getElementById('rcp-rec-scroll');
    if (sc) sc.scrollTop = 0;
    paintRecord();
    bindRecScroll();
    onRecScroll();
    // "Saved · 4 min ago" has to keep being true while nobody touches the
    // record. Cleared on teardown so a closed record costs no timer.
    clearInterval(_agoTimer);
    _agoTimer = setInterval(paintSaveState, 30000);
  }

  // The browser Back button. It cannot be made to wait for a save, so the save
  // is STARTED (flushSave reads the DOM before its first await) and the
  // takeover comes down over the top of it. The request completes regardless —
  // nothing is unloading, only a section is being hidden.
  function onPop() { if (_dirty) flushSave(); teardown(true); goTab('recipes'); if (_savedAt) load(); }

  function teardown(viaPop) {
    if (!_recOpen) return;
    _recOpen = false;
    cancelAutosave();
    clearInterval(_agoTimer); _agoTimer = null;
    document.body.classList.remove('rcp-viewing');
    window.removeEventListener('popstate', onPop);
    if (!viaPop) history.back();
  }

  window.rcpRecordBack = async function () {
    if (!(await leaveGuard())) return;
    teardown(false);
    goTab('recipes');
    // The list behind this was painted before the edit. A recipe that was
    // created, renamed or recosted in here must not still read the old way on
    // the row the operator lands back on.
    if (_savedAt) load();
  };

  // A rail click tears the takeover down where it stands — it always has, and
  // it cannot be made to await. What it can do is put the work on the wire on
  // the way out, which is the whole difference between this and the confirm
  // dialog it replaces.
  document.addEventListener('click', (e) => {
    if (!_recOpen) return;
    if (e.target.closest && e.target.closest('.tabs [data-tab]')) { if (_dirty) flushSave(); teardown(false); }
  }, true);

  // ═══════════════════════════════════════════════════════════════════════
  //  AUTOSAVE — and the sticky bar's scroll behaviour
  // ═══════════════════════════════════════════════════════════════════════
  //
  // A recipe record is not a form that gets filled in and submitted; it is a
  // document somebody works on across four sub-tabs, often with a scale in the
  // other hand. Asking that person to remember a Save button is asking him to
  // lose an afternoon's costing to a closed tab, and the confirm dialog that
  // used to stand in the way only converted "work lost silently" into "work
  // lost after one more click".
  //
  // WHAT THIS DOES NOT REMOVE. Save is still there and still does something
  // this does not: it is a deliberate mark, and the server files a restore
  // point for it that autosave's own points are allowed to coalesce into
  // (lib/recipe-versions.js). Nothing here writes anything a manual save would
  // not have written — same body, same two requests, same order.
  //
  // AND THE PART THAT MAKES IT SAFE. Every save files the state it displaced,
  // and rcpHistory() puts one back. Autosave without that is not a convenience,
  // it is a delete key with no confirm: a mistyped batch size would be the
  // record within the second, with the old figure gone and nothing to show it
  // ever existed. The two ship together or neither does.
  const AUTOSAVE_IDLE_MS = 1200;   // settle after the last keystroke…
  const AUTOSAVE_MAX_MS  = 8000;   // …but never hold work longer than this
  let _autoTimer = null;
  let _autoDeadline = 0;
  let _saveInFlight = null;   // the Promise of the save currently on the wire
  let _editGen = 0;           // bumped on every edit; decides if a save is stale
  let _saveErr = null;        // last failure, shown in the bar until it clears
  let _savedAt = 0;           // when the record last landed on the server
  let _autoOff = false;       // suspended across archive / restore / teardown
  let _agoTimer = null;
  let _scrollBound = false;

  // The one entry point for "something changed". Everything that used to
  // assign `_dirty = true` calls this instead, so no edit can exist that the
  // autosave timer never heard about.
  function markDirty() {
    _dirty = true;
    _editGen++;
    _saveErr = null;
    scheduleAutosave();
    paintSaveState();
  }
  window.rcpDirty = markDirty;

  function canEdit() { return typeof can !== 'function' || can('recipes:edit'); }

  function autosaveEligible() {
    if (_autoOff || !_recOpen || !_rec) return false;
    if (!canEdit()) return false;
    // A recipe that has never been saved IS created by autosave — but only once
    // it carries the one thing the server requires, because a POST without it
    // is a guaranteed 400 and a red bar on a record whose only sin is that the
    // operator has not finished typing the name yet. Until then edits stay in
    // the browser and the leave-guard still asks before dropping them.
    if (!_rec.id) return !!String(val('name_en') || '').trim();
    return true;
  }

  function scheduleAutosave() {
    if (!autosaveEligible()) return;
    const now = Date.now();
    // The deadline is set by the FIRST edit of a burst and not moved by the
    // ones after it: continuous typing must not be able to postpone the save
    // forever, which a plain debounce does.
    if (!_autoDeadline) _autoDeadline = now + AUTOSAVE_MAX_MS;
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(() => { saveNow('auto'); },
      Math.max(0, Math.min(AUTOSAVE_IDLE_MS, _autoDeadline - now)));
  }

  function cancelAutosave() { clearTimeout(_autoTimer); _autoTimer = null; _autoDeadline = 0; }

  // Reads the DOM and the drafts, writes the recipe, the lines, the steps and
  // the cost inputs — the same two requests rcpSave has always made, in the
  // same order. Returns what happened; it never toasts and never repaints, so
  // both callers can decide those for themselves.
  async function writeRecord(source) {
    const body = readDetails();
    if (!body.name_en) return { ok: false, error: 'name_required' };
    body.ingredients = _lines.map(l => ({
      ingredient_id: l.ingredient_id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
      qty: Number(l.qty) || 0, unit: l.unit || 'g', notes: l.notes || null, substitutes: l.substitutes || null,
    }));
    body.steps = _steps.map(s => ({ name: s.name || null, instructions: s.instructions || null }));
    // Declared, not inferred: the server uses it only to decide how tightly
    // version points coalesce and what the History list calls the row. It
    // changes nothing about what is written to the recipe.
    body.save_source = source;
    const wasNew = !_rec.id;
    let recipeId = _rec.id;
    if (recipeId) {
      await api('/api/retail-admin/recipes/' + recipeId, { method: 'PUT', body });
    } else {
      const j = await api('/api/retail-admin/recipes', { method: 'POST', body });
      recipeId = j.id;
      // Claimed immediately so a second autosave (or a fast double click on
      // Save) updates this recipe instead of creating a second one.
      _rec.id = recipeId;
    }
    const cost = draftCostData();
    cost.save_source = source;
    await api('/api/retail-admin/recipes/' + recipeId + '/cost', { method: 'PUT', body: cost });
    const fresh = await api('/api/retail-admin/recipes/' + recipeId);
    return { ok: true, id: recipeId, created: wasNew, fresh: fresh.data, mismatched: mismatchedLines() };
  }

  /**
   * Save, at most one at a time. `source` is 'auto' or 'manual'.
   *
   * A save in flight is never duplicated: a second caller waits on the first
   * and then, if the record has moved on since, another save is scheduled. The
   * generation counter is what decides that — an edit made WHILE the request
   * was on the wire bumps it, and the record stays dirty even though a save
   * just succeeded, which is exactly right: the server has the older text.
   */
  async function saveNow(source, depth) {
    if (!_rec) return { ok: false, error: 'no_record' };
    if (_saveInFlight) {
      const prev = await _saveInFlight.catch(() => null);
      // The record may have moved on while that request was on the wire.
      // Whoever is waiting here wants the CURRENT state saved, not the one
      // that just went — so save again. `depth` bounds it at one extra round:
      // each round is a real request, and a leave path must not be able to
      // spin here.
      if (_dirty && !_saveInFlight && !depth) return saveNow(source, 1);
      return prev || { ok: !_dirty, error: _dirty ? 'busy' : null };
    }
    if (!canEdit()) return { ok: false, error: 'forbidden_capability' };
    cancelAutosave();
    const gen = _editGen;
    const p = writeRecord(source);
    _saveInFlight = p;
    paintSaveState();
    let out;
    try {
      out = await p;
      if (out.ok) {
        _saveErr = null;
        _savedAt = Date.now();
        // A background save refreshes only what the SERVER knows, never the
        // fields — see mergeServerFacts. A manual save repaints in full, and
        // does it in rcpSave where the operator is watching.
        if (source === 'auto') mergeServerFacts(out.fresh);
        // Only clear the dirty flag if nothing was typed while this was in
        // flight. If something was, the next timer picks it up.
        if (_editGen === gen) _dirty = false; else scheduleAutosave();
      } else if (out.error === 'name_required') {
        // Not a failure to report in red: the operator simply has not named it
        // yet. The leave-guard still protects the work.
        _saveErr = null;
      }
    } catch (e) {
      out = { ok: false, error: e.code || 'save_failed', message: (e.data && e.data.message) || e.message || '' };
      _saveErr = out;
    } finally {
      _saveInFlight = null;
      paintSaveState();
    }
    return out;
  }

  /**
   * Get whatever is on screen onto the server NOW, and answer whether it got
   * there. Used by every path that is about to leave the record.
   *
   * Reads the DOM before its first await, so a caller may tear the takeover
   * down straight after calling it without waiting.
   */
  async function flushSave() {
    cancelAutosave();
    if (!_dirty && !_saveInFlight) return true;
    if (_dirty && autosaveEligible()) { await saveNow('auto'); return !_dirty; }
    if (_saveInFlight) { await _saveInFlight.catch(() => null); return !_dirty; }
    return !_dirty;
  }

  // The one question every leave path asks. It only reaches a dialog when the
  // work genuinely could not be saved — an unnamed new recipe, a server that
  // refused, an operator without recipes:edit — and then it says WHY, because
  // "your changes will be lost" without a reason is not something anyone can
  // act on.
  async function leaveGuard() {
    if (!_dirty && !_saveInFlight) return true;
    if (await flushSave()) return true;
    const why = _saveErr ? (_saveErr.message || _saveErr.error)
      : (!canEdit() ? T('you do not have permission to edit recipes', '你没有编辑食谱的权限')
        : T('this recipe still needs an English name', '该食谱还需要填写英文名称'));
    return askConfirm({
      titleEn: 'Leave without saving?', titleCn: '未保存就离开?',
      bodyEn: `This recipe could not be saved — ${why}. Your changes will be lost.`,
      bodyCn: `该食谱无法保存 —— ${why}。你的更改将丢失。`,
      confirmEn: 'Leave', confirmCn: '离开', danger: true,
    });
  }

  // ── the save-state line in the sticky bar ────────────────────────────────
  // Autosave's entire visible surface. A toast cannot do this job: a save that
  // happens on its own has to be answerable at ANY moment ("is my work in?"),
  // not for the 2.6 seconds after it landed.
  function agoText(ms) {
    const s = Math.round(ms / 1000);
    if (s < 45) return T('just now', '刚刚');
    const m = Math.round(s / 60);
    if (m < 60) return T(`${m} min ago`, `${m} 分钟前`);
    const h = Math.round(m / 60);
    return T(`${h} h ago`, `${h} 小时前`);
  }
  function paintSaveState() {
    const el = document.getElementById('rcp-rec-savestate');
    if (!el) return;
    let txt = '', err = false;
    if (_saveErr) {
      err = true;
      txt = T('Not saved', '未保存') + ' — ' + (_saveErr.message || _saveErr.error || '');
    } else if (_saveInFlight) {
      txt = T('Saving…', '保存中…');
    } else if (_dirty) {
      txt = canEdit() ? T('Unsaved changes', '有未保存的更改') : T('Read only', '只读');
    } else if (_savedAt) {
      txt = T('Saved', '已保存') + ' · ' + agoText(Date.now() - _savedAt);
    }
    el.textContent = txt;
    el.classList.toggle('err', err);
  }

  // ── the sticky bar's two states ──────────────────────────────────────────
  // A hairline once anything has scrolled under it, and the miniature of the
  // summary card once THAT has. The threshold is measured in the scroller's
  // own coordinates, and `sum.offsetTop - head.offsetHeight` is invariant under
  // the miniature appearing (it grows the header and pushes the summary down by
  // the same amount), so showing it can never re-trigger the test that hid it.
  function onRecScroll() {
    const sc = document.getElementById('rcp-rec-scroll');
    const head = document.getElementById('rcp-rechead');
    if (!sc || !head) return;
    head.classList.toggle('stuck', sc.scrollTop > 2);
    const figs = document.getElementById('rcp-rec-stickyfigs');
    const sum = sumRoot();
    if (!figs) return;
    if (!sum || !sum.innerHTML) { figs.hidden = true; return; }
    // VIEWPORT coordinates, not offsetTop: the record's offsetParent is not the
    // scroller (nothing between them is positioned), so an offsetTop compared
    // against scrollTop would be out by the topbar and main's padding — the
    // strip would appear at the wrong point rather than not at all, which is
    // the kind of wrong nobody chases down.
    figs.hidden = sum.getBoundingClientRect().bottom > head.getBoundingClientRect().bottom;
  }
  function bindRecScroll() {
    if (_scrollBound) return;
    const sc = document.getElementById('rcp-rec-scroll');
    if (!sc) return;
    sc.addEventListener('scroll', onRecScroll, { passive: true });
    window.addEventListener('resize', onRecScroll);
    _scrollBound = true;
  }

  // The browser's own last line of defence, for the tab that gets closed
  // mid-request or before an unnamed recipe has a name. Only armed while the
  // record is genuinely unsaved, so it never nags on a clean one.
  window.addEventListener('beforeunload', (e) => {
    if (!_recOpen || (!_dirty && !_saveInFlight)) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // Switching tabs or locking the phone is a leave as far as the work is
  // concerned — get it on the server rather than waiting out the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _recOpen && _dirty) flushSave();
  });


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
    if (key === 'ingredients') { el.innerHTML = ingredientsTab(); paintLineWarns(); }
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

  // Everything in the sticky bar EXCEPT the inputs — extracted from
  // paintRecord() so an autosave can refresh it (a renamed recipe, a material
  // that appeared, the id a create just minted) WITHOUT rebuilding the fields
  // under a typing operator.
  function paintHead() {
    if (!_rec) return;
    const m = _rec;
    const isNew = !m.id;
    const setTxt = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };
    setTxt('rcp-rec-title', isNew ? T('New recipe', '新建食谱') : (m.name_en || T('Recipe', '食谱')));
    setTxt('rcp-rec-backlbl', T('Recipes', '食谱'));
    setTxt('rcp-rec-save', T('Save', '保存'));
    setTxt('rcp-rec-arch', m.is_active === 0 ? T('Restore', '恢复') : T('Archive', '归档'));
    const archBtn = document.getElementById('rcp-rec-arch');
    if (archBtn) archBtn.hidden = isNew;

    // History — hidden until the recipe exists, because a record with no id has
    // no saves behind it and an empty panel explains nothing.
    const histBtn = document.getElementById('rcp-rec-history');
    if (histBtn) { histBtn.hidden = isNew; histBtn.textContent = T('History', '修改记录'); }

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
    paintSaveState();
  }

  // What the SERVER knows that the screen cannot derive: the id a create just
  // minted, the material that auto-materialized, the products this recipe
  // makes, its archive state. Taken from a save's answer WITHOUT touching
  // `_lines`, `_steps` or any mounted input — those hold what the operator is
  // typing right now, and the server's copy of them is by definition older.
  function mergeServerFacts(fresh) {
    if (!_rec || !fresh) return;
    _rec.id = fresh.id;
    _rec.is_active = fresh.is_active;
    _rec.backsMaterial = fresh.backsMaterial;
    _rec.materialBlock = fresh.materialBlock;
    _rec.products = fresh.products;
    // The title reads from _rec.name_en, and a rename is the operator's own
    // text coming back unchanged — safe, and the alternative is a header that
    // still says the old name after the record has been renamed.
    _rec.name_en = fresh.name_en;
    _rec.name_cn = fresh.name_cn;
    paintHead();
    paintSummary();
  }

  function paintRecord() {
    const host = recRoot();
    if (!host || !_rec) return;
    const m = _rec;
    paintHead();

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
    paintBreakdown();
    paintLineWarns();
    // The page just changed height under the sticky bar; re-decide whether the
    // bar is stuck and whether its miniature belongs on screen.
    onRecScroll();
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
          ${field(T('Type', '类型'), select('recipe_type', m.recipe_type || 'made', RECIPE_TYPES.map(([v, lbl]) => [v, lbl()])),
                   T('Made here, or bulk bought in and repacked. Filing only — it changes nothing about cost.',
                     '自制,或整批采购后分装。仅用于归类 —— 不影响成本。'))}
          ${field(T('SKU', '货号'), input('sku', m.sku, 'maxlength="60"'),
                   T('Kept forever, even after archiving.', '归档后仍永久保留。'))}
        </div>
      </div>
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Batch', '批量'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Batch size (g)', '批量大小(克)'), input('batch_size', m.batch_size, 'type="number" min="0" step="any"', 'rcpRecompute()'),
                   T('Total grams the whole batch makes. Needed to work out cost per gram.', '整批的总克数,用于折算每克成本。'))}
          ${field(T('Servings', '份数'), input('servings', m.servings, 'type="number" min="1" step="1"', 'rcpRecompute()'),
                   T('Needed to work out cost per serving.', '用于折算每份成本。'))}
          ${field(T('Serving size (g)', '每份克数'), input('serving_size', m.serving_size, 'type="number" min="0" step="any"'))}
          ${field(T('Shelf life', '保质期'), input('shelf_life', m.shelf_life, 'maxlength="60"'))}
        </div>
      </div>
      <div class="rcp-card rcp-blk">
        <h3 class="rcp-blk-h">${esc(T('Storage & notes', '储存与备注'))}</h3>
        <div class="rcp-fgrid">
          ${field(T('Storage', '储存方式'), select('storage', m.storage, [['', T('None', '无')]].concat(STORAGE_OPTIONS.map(([v, lbl]) => [v, lbl()]))))}
        </div>
        <div class="rcp-f" style="margin-top:16px">
          <span class="lbl">${esc(T('Notes', '备注'))}</span>
          <textarea class="rcp-input" id="rcp-f-notes" rows="3" oninput="rcpDirty()">${esc(m.notes || '')}</textarea>
        </div>
      </div>`;
  }

  // ── Does THIS line's unit disagree with its material's stocking unit? ─────
  //
  // The rule is lib/recipe-cost.js's own (unitsReconcilable), read off the
  // shared module rather than restated here — a second copy of the dimension
  // table is exactly how a per-line mark and the recipe total end up
  // disagreeing about which line was left out. With the module not yet loaded
  // the answer is "no complaint": a screen that cannot check must not accuse.
  //
  // free_by_design outranks the unit question, exactly as buildLines() has it:
  // a line that costs nothing costs nothing in any unit, and it is not excluded
  // from anything, so there is nothing to warn about.
  function lineUnitMismatch(l) {
    if (!l || l.master_free) return false;
    const c = COST();
    if (!c || typeof c.unitsReconcilable !== 'function') return false;
    return !c.unitsReconcilable(l.unit, l.master_unit);
  }
  // Every mismatched line, with the index the operator sees, for the sentence
  // said at save time.
  function mismatchedLines() {
    return _lines
      .map((l, i) => ({ l, i }))
      .filter(x => lineUnitMismatch(x.l));
  }
  // What the mark says, in full, on the line it is attached to. The locked pair
  // (docs/tacet-delivery-vocabulary.md, minted by Ash 2026-08-27) is UNIT
  // MISMATCH · 单位不符 and it is the LABEL; this is the explanation behind it,
  // and it has to name all three of the distinctions that document requires —
  // the cost is UNKNOWN rather than missing, the LINE is at fault rather than
  // the material, and the total is INCOMPLETE rather than wrong.
  //
  // BOTH HALVES, minted by Ash 2026-09-01 and locked in
  // docs/tacet-delivery-vocabulary.md — a tooltip that stayed English in the
  // Chinese UI was telling the half of the room that reads Chinese nothing at
  // all, on the one screen where the fix is made.
  //
  // THE CHINESE AVOIDS 无法换算 DELIBERATELY. That phrasing was considered and
  // REJECTED when the label pair was minted (see the same document): it says
  // IMPOSSIBLE, and a recorded density will one day settle the volume↔mass
  // cases. 不作换算 — the system DOES NOT convert — is what is actually true,
  // and it is the §7 addendum's own position: no conversion without a stated
  // factor. 待换算 was rejected for the mirror reason and is not used either.
  //
  // The three distinctions the locked entry requires are all carried:
  // 不计入 (left out, not missing), 该物料本身的成本没有问题 (the LINE is at
  // fault, not the material), and the closing sentence names the remedy on the
  // line rather than on the material.
  function lineMismatchTitle(l) {
    const en = `This line is counted in ${l.unit || '—'} but the material is stocked in `
             + `${l.master_unit || '—'}. Those measure different kinds of thing and nothing is `
             + `converted, so this ingredient's cost is NOT included in the recipe total. `
             + `The material's own cost is fine — change the line's unit to fix it.`;
    const cn = `本条按 ${l.unit || '—'} 计量,而该物料按 ${l.master_unit || '—'} 库存。`
             + `两者计量的不是同一类量,系统不作换算,因此本条原料不计入配方成本。`
             + `该物料本身的成本没有问题 —— 修改本条的单位即可。`;
    return T(en, cn);
  }

  // ── Ingredients ──────────────────────────────────────────────────────────
  // Drag-to-reorder mirrors the variant table's own pattern (09-products.js
  // vaDragStart/vaDragOver/vaDrop/vaDragEnd) — same grip gesture, same
  // before/after drop indicator, just scoped to _lines instead of VA_MEMBERS.
  // sort_order is derived from array position at save time (retail-recipes.js
  // already writes it that way), so reordering the array is the whole fix.
  let _lineDrag = null;
  // Shared by lineRow() (initial paint) and paintLineCosts() (in-place
  // refresh on every keystroke) so the two can never drift apart.
  function lineCostText(l) {
    const isFree = !!l.master_free;
    const hasCost = l.master_cost > 0 || isFree;
    return hasCost && !isFree ? money((Number(l.qty) || 0) * (l.master_cost || 0)) : (isFree ? esc(T('free', '免费')) : '—');
  }
  function lineRow(l, idx) {
    const isFree = !!l.master_free;
    const hasCost = l.master_cost > 0 || isFree;
    const per = isFree ? T('free', '免费') : (hasCost ? `${moneyU(l.master_cost)}/${esc(l.master_unit || l.unit || '')}` : T('no cost', '无成本'));
    return `
      <div class="rcp-line" draggable="false" ondragover="rcpLineDragOver(event,${idx})" ondragleave="rcpLineDragLeave(event)" ondrop="rcpLineDrop(event,${idx})" ondragend="rcpLineDragEnd()">
        <span class="rcp-line-drag" draggable="true" ondragstart="rcpLineDragStart(event,${idx})" title="${esc(T('Drag to reorder', '拖动排序'))}">⠿</span>
        <div class="rcp-line-name">
          <div class="n">${esc(l.name_en || l.master_name_en || '')}</div>
          <div class="s${hasCost ? '' : ' warn'}">${esc(l.name_cn || '')}${l.name_cn ? ' · ' : ''}${esc(per)}${l.ingredient_id == null ? ' · ' + esc(T('material deleted', '物料已删除')) : ''}</div>
          <!-- The mark, on the line it is about. Painted here rather than only
               once per recipe because the summary pill names the CONDITION and
               this names the ROW — an operator who reads UNIT MISMATCH on the
               card and cannot see which of eleven lines caused it has been told
               a fact he cannot act on. Same amber triangle as everywhere else
               (I.warn), same colour, and it is emptied/refilled in place by
               paintLineWarns() so a unit change does not repaint the tab. -->
          <div class="rcp-line-warn" data-line="${idx}"></div>
        </div>
        <input class="rcp-input rcp-line-qty" type="number" min="0" step="any" value="${esc(l.qty)}"
               oninput="rcpLineField(${idx},'qty',this.value)" placeholder="${esc(T('qty', '数量'))}">
        <select class="rcp-input rcp-line-unit" onchange="rcpLineField(${idx},'unit',this.value)">
          ${RECIPE_UNITS().map(u => `<option value="${esc(u)}"${l.unit === u ? ' selected' : ''}>${esc(u)}</option>`).join('')}
          <!-- A stored unit outside RECIPE_UNITS() (an old/legacy value, e.g.
               "L") matches none of the options above, so the browser marks
               none of them selected and falls back to displaying the FIRST
               option — silently showing "g" for a line that is really still
               "L" and was never touched. Appending the raw value as its own
               selected option makes the select honest instead: it shows what
               is actually stored, so a save that changes nothing cannot look
               like a fix. It disappears on its own once a real unit is picked. -->
          ${l.unit && !RECIPE_UNITS().includes(l.unit) ? `<option value="${esc(l.unit)}" selected>${esc(l.unit)}</option>` : ''}
        </select>
        <input class="rcp-input rcp-line-note" type="text" value="${esc(l.notes || '')}"
               placeholder="${esc(T('Note', '备注'))}" oninput="rcpLineField(${idx},'notes',this.value)">
        <!-- THE FIGURE STAYS, STRUCK THROUGH, when the line is excluded. It
             was being printed as a plain ¥ that the batch total below did not
             contain — the one number on this row that said the cost had been
             counted. Struck rather than blanked: the same idiom
             breakdownHtml() uses for a packaging figure that no longer counts,
             and it keeps what the multiplication WOULD have said visible for
             whoever has to judge whether the unit or the material is wrong.
             The strike is a CLASS on the row, applied by paintLineWarns(), so
             changing the unit re-marks the line without repainting the tab.
             Nothing stored moves. -->
        <span class="rcp-line-cost" data-line="${idx}">${lineCostText(l)}</span>
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
    markDirty();
    // Only the cost figure and the summary need to move — repainting the
    // whole tab on every keystroke would fight the input the operator is
    // typing into (same caret-loss failure Materials' search box guards
    // against). Cost is read straight from the DOM at save/recompute time.
    rcpRecompute();
  };
  window.rcpLineRemove = function (idx) {
    _lines.splice(idx, 1);
    markDirty();
    renderSubbody('ingredients');
    rcpRecompute();
    updateIngredientsBadge();
  };
  window.rcpLineDragStart = function (e, idx) {
    _lineDrag = idx;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
  };
  window.rcpLineDragOver = function (e, idx) {
    if (_lineDrag == null || _lineDrag === idx) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const row = e.currentTarget;
    row.classList.toggle('rcp-drop-before', idx < _lineDrag);
    row.classList.toggle('rcp-drop-after', idx > _lineDrag);
  };
  window.rcpLineDragLeave = function (e) { e.currentTarget.classList.remove('rcp-drop-before', 'rcp-drop-after'); };
  window.rcpLineDrop = function (e, idx) {
    e.preventDefault();
    const from = _lineDrag; _lineDrag = null;
    if (from == null || from === idx) { window.rcpLineDragEnd(); return; }
    const [moved] = _lines.splice(from, 1);
    _lines.splice(idx, 0, moved);
    markDirty();
    renderSubbody('ingredients');
    rcpRecompute();
  };
  window.rcpLineDragEnd = function () {
    _lineDrag = null;
    document.querySelectorAll('#rcp-lines .rcp-line').forEach(r => r.classList.remove('rcp-drop-before', 'rcp-drop-after'));
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
    // The list opens below the box, which on a full page can be the bottom of
    // the scrollport. 'nearest' scrolls the minimum that makes it visible and
    // no-ops once it already is, so it does not jump on every keystroke.
    const list = host.querySelector('.rcp-pick');
    if (list && list.scrollIntoView) list.scrollIntoView({ block: 'nearest' });
  }
  window.rcpPickAdd = function (id) {
    const m = _pickResults.find(x => x.id === id);
    if (!m) return;
    _lines.push({
      ingredient_id: m.id, name_en: m.name_en, name_cn: m.name_cn, sku: m.sku,
      qty: 0, unit: m.unit || 'g', notes: null, substitutes: null,
      master_cost: m.cost_per_unit, master_unit: m.unit, master_free: m.free_by_design, master_name_en: m.name_en,
    });
    markDirty();
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
  window.rcpStepField = function (idx, key, val) { if (_steps[idx]) { _steps[idx][key] = val; markDirty(); } };
  window.rcpStepAdd = function () { _steps.push({ name: '', instructions: '' }); markDirty(); renderSubbody('steps'); };
  window.rcpStepRemove = function (idx) { _steps.splice(idx, 1); markDirty(); renderSubbody('steps'); };
  window.rcpStepMove = function (idx, dir) {
    const to = idx + dir;
    if (to < 0 || to >= _steps.length) return;
    const [s] = _steps.splice(idx, 1);
    _steps.splice(to, 0, s);
    markDirty();
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
      // packaging is NOT sent. The input is gone (Step 4), so v('packaging')
      // would read undefined and write 0 — silently erasing the recorded
      // figure on the first save of any recipe. lib/recipe-cost-data-write.js
      // preserves a stored value when the key is ABSENT, which is exactly the
      // behaviour wanted here, and is why the key is removed rather than
      // passed as null.
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

  // The breakdown has to be painted from the DOM, so it can only be filled
  // AFTER costTab()'s inputs are mounted — never inside costTab() itself,
  // which is still just a string at that point. paintRecord() calls this on
  // open; without it the block stayed blank until the first keystroke.
  function paintBreakdown() {
    const bk = document.getElementById('rcp-breakdown');
    if (bk) bk.innerHTML = breakdownHtml(liveCost());
  }

  // ── The per-line marks, refreshed in place ────────────────────────────────
  //
  // NOT A REPAINT. rcpLineField() runs on every keystroke in the qty and note
  // boxes, and re-rendering the ingredients tab underneath a typing operator is
  // the caret-loss failure that function's own comment exists to avoid. So this
  // only ever writes into the one empty div each row already carries, and
  // toggles one class on the row — the inputs, their values and the focus are
  // never touched.
  //
  // A no-op when the tab is not mounted (the record renders all four bodies at
  // once today, but this must not depend on that).
  function paintLineWarns() {
    const host = document.getElementById('rcp-lines');
    if (!host) return;
    host.querySelectorAll('.rcp-line-warn').forEach((el) => {
      const idx = Number(el.getAttribute('data-line'));
      const l = _lines[idx];
      const row = el.closest('.rcp-line');
      const bad = !!l && lineUnitMismatch(l);
      if (row) row.classList.toggle('is-unit-mismatch', bad);
      const want = bad
        ? `<span class="rcp-line-warnic" title="${esc(lineMismatchTitle(l))}">${I.warn}</span>`
          + `<span class="rcp-line-warntx" title="${esc(lineMismatchTitle(l))}">${esc(T('UNIT MISMATCH', '单位不符'))}</span>`
        : '';
      // Compared before writing so an unchanged row is not re-created on every
      // keystroke — a title attribute being torn down mid-hover closes the
      // tooltip the operator is reading.
      if (el.innerHTML !== want) el.innerHTML = want;
    });
  }

  // Same in-place idiom as paintLineWarns() just above: only the text of the
  // one span each row already carries is touched, so a keystroke in the qty
  // box never repaints the row it lives in.
  function paintLineCosts() {
    const host = document.getElementById('rcp-lines');
    if (!host) return;
    host.querySelectorAll('.rcp-line-cost').forEach((el) => {
      const idx = Number(el.getAttribute('data-line'));
      const l = _lines[idx];
      if (!l) return;
      const want = lineCostText(l);
      if (el.textContent !== want) el.textContent = want;
    });
  }

  window.rcpRecompute = function () {
    markDirty();
    paintSummary();
    paintBreakdown();
    paintLineWarns();
    paintLineCosts();
  };

  function breakdownHtml(c) {
    const row = (lbl, val, cls) => `<div class="rcp-bkrow${cls ? ' ' + cls : ''}"><span>${esc(lbl)}</span><b>${val}</b></div>`;
    return [
      row(T('Ingredient cost', '原料成本'), money(c.ingredientCost)),
      row(T('Labour', '人工'), money(c.labour)),
      // Shown ONLY while a stale figure is still recorded, and struck through,
      // because it no longer counts toward anything. 93 of 105 cost rows had
      // one when packaging moved to the product's build list (§31, Step 4);
      // hiding them outright would make the migration unverifiable from the
      // screen and leave an operator wondering where their number went.
      // Disappears by itself as each recipe is cleared. CN PENDING on the
      // note — it names the build list, which has no sourced Chinese.
      (Number(c.packagingTotal) > 0
        ? row(T('Packaging (batch) — no longer counted', 'Packaging (batch) — no longer counted'),
              '<s>' + money(c.packagingTotal) + '</s>')
        : ''),
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
  // THE ONE DERIVATION, read by BOTH the summary card and the sticky bar's
  // miniature of it. Extracted the day the bar was added, and extracted rather
  // than copied for the reason every comment in this function already gives:
  // two places deriving "which margin is a fact about this recipe" is exactly
  // how one screen ends up printing two different margins for one recipe. The
  // rules it encodes are unchanged — read them below, they were only moved.
  function summaryFacts() {
    const c = liveCost();
    const primary = c.costPerServing != null
      ? { lbl: T('Cost per serving', '每份成本'), v: money(c.costPerServing) }
      : (c.costPerGram != null ? { lbl: T('Cost per gram', '每克成本'), v: moneyU(c.costPerGram) } : null);
    const prods = (_rec && Array.isArray(_rec.products)) ? _rec.products : [];
    const solo = prods.length === 1 ? prods[0] : null;
    const soloOwned = solo ? costStillFromRecipe(solo) : false;
    const soloM = (solo && soloOwned) ? margeOf(solo) : null;
    const recM = (!soloOwned && c.marginPerServing != null && c.sellPrice > 0 && c.costPerServing != null)
      ? { money: c.marginPerServing, pct: ((c.sellPrice - c.costPerServing) / c.sellPrice) * 100 }
      : null;
    const showM = soloM || recM;
    // CN PENDING — names the build list, which has no sourced Chinese.
    const mLbl = soloM ? T('Margin', '毛利')
      : (recM ? T('Margin (recipe)', 'Margin (recipe)') : T('Margin', '毛利'));
    return { c, primary, solo, soloM, showM, mLbl, missing: c.zeroCostIngredientLines > 0 };
  }

  function paintSummary() {
    const host = sumRoot();
    if (!host || !_rec) return;
    const f = summaryFacts();
    const c = f.c;
    const missing = f.missing;
    const primary = f.primary;

    // ONE product means its price and margin are facts about the recipe, so
    // they belong in the metric row beside the costs — cost, price, what's
    // left, one arc, read in one pass. SEVERAL products means no single figure
    // is true of the recipe, so the row stays cost-only and the figures go
    // down into columns instead (productsHtml below). The data has two shapes;
    // so does the card.
    const solo = f.solo;
    // THE PREMISE THIS STRIP WAS BUILT ON CAN NOW BE FALSE. The comment above
    // says one product means its price and margin are facts about the recipe.
    // That held while the recipe wrote store_products.unit_cost. A product
    // with a build list takes its cost from the list instead, so its margin is
    // a fact about the LIST — and printing it beside this recipe's own
    // cost-per-serving made the two read as one arc when they disagreed 37x
    // (Hazelnut-Chocolate Spread: ¥46.05 a serving, margin shown 98.6% off a
    // ¥1.23 build list). Where the product no longer answers to this recipe,
    // the strip shows the RECIPE's own margin — its recipe_cost_data sell
    // price against its own cost per serving, both already computed — and
    // labels it, so nothing on the row is a fact about something else.
    // ...so summaryFacts() above prefers the recipe's OWN margin whenever the
    // product no longer answers to this recipe, and labels it.
    const soloM = f.soloM;
    const showM = f.showM;
    const mLbl = f.mLbl;

    let html = `<div class="rcp-sumrow">
      <div class="rcp-sumfig"><span class="lbl">${esc(T('Batch cost', '整批成本'))}</span><span class="v">${money(c.batchCost)}</span></div>
      ${primary ? `<div class="rcp-sumfig"><span class="lbl">${esc(primary.lbl)}</span><span class="v">${primary.v}</span></div>`
                : `<div class="rcp-sumfig"><span class="lbl">${esc(T('Per-unit cost', '单位成本'))}</span><span class="v dim">${esc(T('No batch size or servings recorded', '未记录批量大小或份数'))}</span></div>`}
      ${solo ? `<i class="rcp-sumdiv"></i>
      <div class="rcp-sumfig"><span class="lbl">${esc(T('Sells for', '售价'))}</span><span class="v">${esc(Number(solo.sell_price) > 0 ? money(solo.sell_price) : '—')}</span></div>
      <div class="rcp-sumfig"><span class="lbl">${esc(mLbl)}</span>
        <span class="rcp-summarg${showM && showM.money < 0 ? ' neg' : ''}">
          <span class="v">${esc(showM ? (showM.money < 0 ? '−' : '') + money(Math.abs(showM.money)) : '—')}</span>
          ${showM ? `<span class="pct">${esc(pctTxt(showM))}</span>` : ''}
        </span></div>` : ''}
    </div>`;

    // The warnings — real number above, honest reason here. Never swap the
    // number out; only ever add these alongside it. Pills, not panels: a whole
    // card flooded with tint competes with everything else on the page.
    const warns = [];
    if (missing) {
      warns.push(`<div class="rcp-warn">${I.warn}<span>${esc(T(
        `${c.zeroCostIngredientLines} ingredient${c.zeroCostIngredientLines === 1 ? '' : 's'} missing cost — costs shown are too low`,
        `${c.zeroCostIngredientLines} 项原料缺少成本 — 显示成本偏低`))}</span></div>`);
    }
    // A line whose unit cannot be reconciled with its material's stocking unit
    // (§7 addendum). Deliberately its own pill and not folded into the one
    // above: those materials are NOT missing a cost, they have a good one that
    // this line's quantity cannot be multiplied by. Same amber pill — the
    // figure is not wrong to exist, it is wrong to trust — and never Brick,
    // because nothing is broken; a number is unknown.
    // The pair is LOCKED in docs/tacet-delivery-vocabulary.md, minted by Ash
    // 2026-08-27 — copied from that table, not retyped. It names the CAUSE and
    // carries no count: the locked string has no slot for one, and widening it
    // here would be composing a variant of a locked pair. It reads on all three
    // classes the counter flags — volume↔mass, mass↔count, and any dimension
    // pair a later table entry adds.
    if (c.unreconciledUnitLines > 0) {
      warns.push(`<div class="rcp-warn">${I.warn}<span>${esc(T(
        'UNIT MISMATCH', '单位不符'))}</span></div>`);
    }
    // Selling below cost is an error, not a warning, and it is worth saying in
    // words as well as in Brick — a minus sign on a figure is easy to skim past.
    if (soloM && soloM.money < 0) {
      warns.push(`<div class="rcp-warn err">${I.warn}<span>${esc(T(
        'Selling below cost', '低于成本销售'))}</span></div>`);
    }
    if (warns.length) html += `<div class="rcp-warns">${warns.join('')}</div>`;

    // Everything past the hairline is what the recipe BECOMES: the products it
    // makes first (the commercial fact), then the material it stocks (internal
    // plumbing, and a caption so it reads that way). No outputs at all means no
    // hairline — there is nothing to divide.
    const outputs = productsHtml() + materialHtml();
    if (outputs) html += `<div class="rcp-hr"></div><div class="rcp-outputs">${outputs}</div>`;

    host.innerHTML = html;
    // The bar's miniature is repainted from the SAME facts in the same breath,
    // so the two can never disagree about what this recipe costs.
    paintStickyFigs(f);
  }

  // ── the sticky bar's miniature of the card above ─────────────────────────
  // Only the figures, one type step down, in the same order: what it costs,
  // then what it earns. The warning comes with them and is not optional — the
  // rule this screen exists to keep ("never let a recipe look free") is a rule
  // about every place a cost is shown, and a scrolled-past warning is a hidden
  // one. Visibility is the scroll handler's business, not this function's.
  function paintStickyFigs(facts) {
    const host = document.getElementById('rcp-rec-stickyfigs');
    if (!host || !_rec) return;
    const f = facts || summaryFacts();
    const c = f.c;
    const fig = (lbl, v, cls) => `<span class="f${cls ? ' ' + cls : ''}">${esc(lbl)} <b>${v}</b></span>`;
    let html = fig(T('Batch cost', '整批成本'), money(c.batchCost));
    if (f.primary) html += fig(f.primary.lbl, f.primary.v);
    if (f.solo) {
      html += fig(T('Sells for', '售价'), esc(Number(f.solo.sell_price) > 0 ? money(f.solo.sell_price) : '—'));
      html += fig(f.mLbl,
        esc(f.showM ? (f.showM.money < 0 ? '−' : '') + money(Math.abs(f.showM.money)) : '—'),
        f.showM && f.showM.money < 0 ? 'neg' : '');
    }
    if (f.missing) {
      html += `<span class="warn">${I.warn}${esc(T(
        `${c.zeroCostIngredientLines} missing cost`, `${c.zeroCostIngredientLines} 项缺少成本`))}</span>`;
    }
    if (c.unreconciledUnitLines > 0) {
      html += `<span class="warn">${I.warn}${esc(T('UNIT MISMATCH', '单位不符'))}</span>`;
    }
    host.innerHTML = html;
  }

  // Margin for one product row, via the SHARED helper (_paMargin, part 09) —
  // the same gross-on-price figure the Products list and the product editor
  // show. Never re-derived here: a second copy of this arithmetic is exactly
  // how a header and an editor end up quoting different margins for one
  // product. null whenever the answer is unknown; every caller renders that as
  // an em dash, never as 0%.
  function margeOf(p) {
    return (typeof _paMargin === 'function') ? _paMargin(p.sell_price, p.unit_cost) : null;
  }
  // Does the product beside this recipe still take its cost FROM this recipe?
  // Since §31's addendum a build list owns a product's cost outright and
  // applyProductCosts() skips such a product, so its unit_cost can be a figure
  // this recipe had no part in. Anything that prints the product's margin as a
  // fact about the recipe has to ask this first.
  function costStillFromRecipe(p) {
    return !(Number(p && p.build_line_count) > 0);
  }
  // One minus sign, the typographic one, on BOTH halves of a negative margin.
  // toFixed() emits an ASCII hyphen, so a below-cost row otherwise reads
  // "−¥2.09  -52.1%" — two different dashes on one figure.
  function pctTxt(m) {
    return (m.money < 0 ? '−' : '') + Math.abs(m.pct).toFixed(1) + '%';
  }

  // Backs material — a read-only status line. Blocked shows the frozen figure
  // PLUS why, so it never reads as simply "the material costs ¥0".
  function materialHtml() {
    if (!_rec || !_rec.backsMaterial) return '';
    const mb = _rec.materialBlock;
    const blocked = mb && !mb.ok;
    const cpu = _rec.backsMaterial.cost_per_unit;
    const unitTxt = _rec.backsMaterial.unit || 'g';
    const costTxt = cpu > 0 ? `${moneyU(cpu)}/${esc(unitTxt)}` : T('not yet costed', '尚未计算成本');
    return `<div class="rcp-matline${blocked ? ' blocked' : ''}">`
      + esc(T('Also stocked as a material: ', '同时作为物料备货:')) + `<b>${esc(_rec.backsMaterial.name_en)}</b> — ${costTxt}`
      + (blocked ? ` — ${esc(T('frozen at its last computed value.', '已冻结为最近一次计算的值。'))} ${esc(blockReasonText(mb.reason, mb.unpriced))}` : '')
      + `</div>`;
  }

  // ── What this recipe makes, and what it earns ────────────────────────────
  // The reverse of the product editor's "From recipe" note (that one names the
  // recipe from the product; this names the products from the recipe). READ
  // ONLY — the link is owned and edited on the product side. Nothing here
  // writes it, and there is deliberately no affordance to.
  //
  // PRICED PER PRODUCT, NEVER BLENDED. One recipe can feed a 150g bag and a
  // 25g sample at two different prices; a single averaged margin across them
  // would be a figure that is true of neither, so each product gets its own
  // row with its own price and its own margin.
  //
  // MAKES NOTHING WE SELL -> RENDERS NOTHING. No empty state, no placeholder:
  // most recipes back a material rather than a retail product, and a permanent
  // "no linked product" line on every one of them is clutter, not information.
  //
  // recipe_cost_data.target_food_cost is deliberately NOT shown. It exists, and
  // an actual-versus-target comparison is a report, not a header stat.
  //
  // ARCHIVED ROWS ARE ALREADY GONE by the time this runs — the server filters
  // them (routes/retail-recipes.js), which is where the filter belongs, so a
  // recipe cannot claim a product the cost rollup would refuse to write to.
  // What this recipe makes. MAKES NOTHING WE SELL -> RENDERS NOTHING: no empty
  // state, no placeholder. Most recipes back a material rather than a retail
  // product, and a permanent "no linked product" row on every one of them is
  // clutter, not information.
  //
  // ARCHIVED ROWS ARE ALREADY GONE by the time this runs — the server filters
  // them (routes/retail-recipes.js), which is where that belongs.
  //
  // data-no-i18n on every row: the runtime bilingual walker (10-extras.js)
  // rewrites text nodes it reads as "EN · CN" pairs, and it runs async on the
  // next mutation, so a render looks right and then silently loses half of
  // itself ~800ms later. Every label here is already resolved by T() and the
  // product names are proper nouns, so there is nothing for the walker to do
  // but damage. Keep the attribute even when a row carries no separator today.
  function productsHtml() {
    const rows = (_rec && Array.isArray(_rec.products)) ? _rec.products : [];
    if (!rows.length) return '';

    // ONE name, never EN and CN glued together — the active language's,
    // falling back to whichever name the product actually carries.
    const nameOf = p => T(p.name_en || p.name_cn || '', p.name_cn || p.name_en || '')
                     || T('Untitled product', '未命名产品');
    const link = p => `<a href="#" class="rcp-prodname" onclick="event.preventDefault();event.stopPropagation();rcpOpenProduct(${Number(p.id)})">${esc(nameOf(p))}</a>`;
    const size = p => p.size ? `<span class="rcp-prodsize">${esc(p.size)}</span>` : '';

    // ── one product: identity only ──────────────────────────────────────
    // Its price and margin are already up in the metric row, where they read
    // as facts about the recipe. Repeating them here would say the same thing
    // twice in two different voices.
    if (rows.length === 1) {
      return `<div class="rcp-prodline" data-no-i18n><span>${esc(T('Makes', '产出'))}</span>`
           + link(rows[0]) + size(rows[0]) + `</div>`;
    }

    // ── several products: columns ───────────────────────────────────────
    // Right-aligned and tabular so the sizes can actually be compared, which
    // is the entire reason they are listed separately rather than blended.
    const head = `<div class="rcp-prodrow rcp-prodhead" data-no-i18n>`
      + `<span class="nm">${esc(T('Makes', '产出'))}</span>`
      + `<span class="sells">${esc(T('Sells', '售价'))}</span>`
      + `<span class="marg">${esc(T('Margin', '毛利'))}</span></div>`;

    const body = rows.map(p => {
      const price = Number(p.sell_price) > 0 ? money(p.sell_price) : '—';
      const m = margeOf(p);
      const cls = m ? (m.money < 0 ? ' neg' : '') : ' non';
      const fig = m
        ? (m.money < 0 ? '−' : '') + money(Math.abs(m.money))
          + ` <span class="pct">${esc(pctTxt(m))}</span>`
        : '—';
      return `<div class="rcp-prodrow" data-no-i18n>`
           + `<span class="nm">${link(p)}${size(p)}</span>`
           + `<span class="sells">${esc(price)}</span>`
           + `<span class="marg${cls}">${fig}</span></div>`;
    }).join('');

    return head + body;
  }

  // Open one of those products in its editor. Mirrors paOpenRecipe() in the
  // other direction and hands off to dashOpenProductFromFeed (03-dashboard.js)
  // rather than keeping a second copy of its wait-for-the-catalogue poll:
  // pdOpen() finds its row in PA_PRODUCTS, which is empty until the Products
  // tab has loaded once, so a bare pdOpen() from here would open a blank
  // "New product" form.
  //
  // The leave guard is the reason this isn't just an inline call. Clicking any
  // rail tab while a record is open tears the takeover down through the
  // capture-phase listener above; that listener starts a save on the way out,
  // but it cannot wait for one, and a link sitting inside the record's own
  // header next to fields the operator has just edited can. So this takes the
  // same route rcpRecordBack does — get the work onto the server, and only ask
  // anything at all if it could not go.
  window.rcpOpenProduct = async function (productId) {
    const id = Number(productId);
    if (!id) return;
    if (!(await leaveGuard())) return;
    _dirty = false;   // saved, or consented once; don't ask a second time
    if (typeof dashOpenProductFromFeed === 'function') { dashOpenProductFromFeed(id); return; }
    // No dashboard part loaded (shouldn't happen — it loads first). Fail by
    // doing nothing visible rather than throwing inside an onclick.
    console.error('[recipes] cannot open product', id, '- product jump unavailable');
  };

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
      recipe_type: val('recipe_type') || 'made',
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
    // Save still exists, and still means something autosave cannot: it is a
    // deliberate mark, and the server files a restore point for it that the
    // background saves around it fold into (lib/recipe-versions.js). It is also
    // the only path that reports in words — autosave's report is the bar.
    if (!String(val('name_en') || '').trim()) {
      toast(T('An English name is required', '英文名称必填'), 'err');
      rcpSubtab('details');
      return;
    }
    const out = await saveNow('manual');
    if (!out || !out.ok) {
      if (out && out.error === 'name_required') return;   // already said, above
      toast(T('Save failed', '保存失败') + ': ' + ((out && out.message) || (out && out.error) || ''), 'err');
      return;
    }
    // ── SAVED, AND HERE IS WHAT THE SAVE DID NOT COST ───────────────────
    //
    // THE SAVE IS NEVER BLOCKED AND THE UNIT IS NEVER CHANGED. A line in ml
    // against a material stocked in g may be exactly what the kitchen does;
    // what is not acceptable is that it was stored, silently left out of the
    // cost (lib/recipe-cost.js, the §7 addendum — no conversion without a
    // stated factor), and the operator told only "Saved". This says the
    // second half out loud at the one moment he is looking.
    //
    // It NAMES the ingredients rather than counting them, because the fix is
    // per line and a count sends him back to hunt for it. Three at most, then
    // "+N more" — the marks on the rows themselves carry the rest, and they
    // are still on screen when this fades.
    //
    // 'err' is the toast's LONG-LIVED variant (6s against 2.6s) and this
    // needs the reading time; it is not a claim that the save failed — the
    // sentence says Saved first, and the record behind it is written.
    //
    // AUTOSAVE DOES NOT SAY ANY OF THIS, and that is deliberate: a sentence
    // this long, fired by a timer while somebody is still typing the line it
    // is about, is an interruption rather than a warning. The marks on the
    // rows and the pill in the summary carry it continuously instead — this
    // is the version for the moment he asked.
    //
    // CN PENDING on the sentence. UNIT MISMATCH · 单位不符 is the locked pair
    // (docs/tacet-delivery-vocabulary.md) and is used as the label; the
    // explanation around it has no sourced Chinese and composing one is
    // forbidden (§30 rule 3), so it is English on both halves.
    const bad = out.mismatched || [];
    if (bad.length) {
      const names = bad.slice(0, 3)
        .map(x => `${x.l.name_en || x.l.master_name_en || '?'} (${x.l.unit || '—'} vs ${x.l.master_unit || '—'})`)
        .join(', ');
      const more = bad.length > 3 ? ` +${bad.length - 3} more` : '';
      const en = `Saved — but ${bad.length} ingredient${bad.length === 1 ? '' : 's'} `
               + `${bad.length === 1 ? 'is' : 'are'} NOT included in this recipe's cost: `
               + `${names}${more}. UNIT MISMATCH — the line's unit and the `
               + `material's stocking unit measure different kinds of thing, so nothing was `
               + `converted. The cost shown is incomplete.`;
      // The count and the names are the same in both halves — they are data,
      // not copy. 已保存 is the toast's own existing pair, reused rather than
      // restated, so the Chinese confirms the save in the same words every
      // other save on this screen uses.
      const cn = `${T('Saved', '已保存')} —— 但有 ${bad.length} 项原料不计入本配方成本:`
               + `${names}${more}。单位不符 —— 该条的单位与物料的库存单位计量的不是同一类量,`
               + `系统不作换算。显示成本不完整。`;
      toast(T(en, cn), 'err');
    } else {
      toast(T('Saved', '已保存'));
    }
    // A manual save is a deliberate stop, so this is the one save that is
    // allowed to repaint the whole record from the server's answer — autosave
    // never does, because rebuilding the inputs under a typing operator is the
    // caret-loss failure renderSubbody() exists to avoid.
    if (out.fresh) { setRecord(out.fresh, true); paintRecord(); }
  };

  // §29 step 6 — names the actual consequence of archiving a recipe that
  // backs a material, the same way the cycle guard names the actual chain
  // rather than a generic refusal. Archiving a recipe blocks its own rollup
  // (lib/recipe-rollup.js costOneRecipe reads recipe.is_active), freezing
  // the material's cost_per_unit at whatever it last was — every OTHER
  // recipe still consuming that material keeps reading that frozen number
  // with no signal anything changed unless this dialog says so up front.
  // A warning, not a block: the operator can still proceed.
  function archiveMaterialWarning(rec) {
    const m = rec.backsMaterial;
    const consumers = (m && m.consumers) || [];
    const n = consumers.length;
    const namesEn = consumers.slice(0, 4).map(c => c.name_en).join(', ') + (n > 4 ? `, +${n - 4}` : '');
    const namesCn = consumers.slice(0, 4).map(c => c.name_cn || c.name_en).join('、') + (n > 4 ? `等 ${n} 个` : '');
    const cost = m.cost_per_unit > 0 ? `${moneyU(m.cost_per_unit)}/${m.unit || 'g'}` : null;
    const usedEn = n > 0 ? `, used by ${n} recipe${n === 1 ? '' : 's'}${namesEn ? ' (' + namesEn + ')' : ''}` : '';
    const usedCn = n > 0 ? `,被 ${n} 个食谱使用${namesCn ? '(' + namesCn + ')' : ''}` : '';
    const whoEn = n === 0 ? 'nothing uses it yet, but anything that does' : (n === 1 ? 'that recipe' : 'those recipes');
    const whoCn = n === 0 ? '目前没有食谱使用它,但之后使用它的食谱' : '这些食谱';
    return {
      bodyEn: `"${rec.name_en}" supplies the material "${m.name_en}"${usedEn}. Archiving freezes its cost${cost ? ` at ${cost}` : ''} — ${whoEn} will keep using that number until you bring it back.`,
      bodyCn: `"${rec.name_en}" 是物料 "${m.name_en}" 的产出来源${usedCn}。归档后其成本将冻结${cost ? `为 ${cost}` : ''} —— ${whoCn}会持续使用该数值,直到你恢复该配方。`,
    };
  }

  window.rcpArchive = async function () {
    if (!_rec || !_rec.id) return;
    // Archiving is not a discard: whatever is on screen is still this recipe's
    // content and is recorded before the state changes, so bringing it back
    // brings back what was actually there.
    await flushSave();
    const restoring = _rec.is_active === 0;
    let ok;
    if (restoring) {
      ok = await askConfirm({
        titleEn: 'Bring this recipe back?', titleCn: '恢复该食谱?',
        confirmEn: 'Restore', confirmCn: '恢复',
      });
    } else if (_rec.backsMaterial) {
      const w = archiveMaterialWarning(_rec);
      ok = await askConfirm({
        titleEn: 'Archive this recipe?', titleCn: '归档该食谱?',
        bodyEn: w.bodyEn, bodyCn: w.bodyCn,
        confirmEn: 'Archive anyway', confirmCn: '仍然归档', danger: true,
      });
    } else {
      ok = await askConfirm({
        titleEn: 'Archive this recipe?', titleCn: '归档该食谱?',
        bodyEn: 'You can bring it back later.', bodyCn: '之后可以恢复。',
        confirmEn: 'Archive', confirmCn: '归档', danger: true,
      });
    }
    if (!ok) return;
    // No background save may fire between here and the teardown — it would
    // write the draft back over a recipe that has just been archived.
    _autoOff = true;
    cancelAutosave();
    try {
      await api('/api/retail-admin/recipes/' + _rec.id + '/archive', { method: 'PUT', body: { restore: restoring } });
      toast(restoring ? T('Restored', '已恢复') : T('Archived', '已归档'));
      _dirty = false;
      teardown(false);
      goTab('recipes');
    } catch (e) {
      _autoOff = false;
      toast(T('Failed', '操作失败') + ': ' + (e.message || ''), 'err');
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  HISTORY — the other half of autosave
  // ═══════════════════════════════════════════════════════════════════════
  //
  // A version is the state a save DISPLACED, so a row reads "this is how the
  // recipe stood UNTIL <time>". That is the sentence the panel puts on screen,
  // because the obvious alternative reading — "this is what was saved at
  // <time>" — is the opposite of what the row holds, and an operator who
  // restores on that misreading gets the change he was trying to undo.
  //
  // The live record is the first row of the same list rather than a separate
  // heading: "now" is just the newest state, and putting it on the same axis is
  // what makes "the one before this" legible. It is the only row that cannot be
  // restored, and the Restore button says so by disabling.
  //
  // Same dialog shell as the materialize modal (askCustom / .tdlg-*), and its
  // own .rcp-hist-* classes are scoped under .rcp-hist-modal for the same
  // reason: the scrim is appended to <body>, outside #tab-recipes-record.
  const HIST_SOURCE = {
    manual:  () => T('saved', '保存'),
    auto:    () => T('autosaved', '自动保存'),
    restore: () => T('restored an older version', '恢复了旧版本'),
  };

  // SQLite writes CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' in UTC. Read
  // without the zone a browser takes it as LOCAL, which puts every row hours
  // out — and a history whose clock is wrong is worse than no history, because
  // it is wrong in a way that looks authoritative.
  function parseTs(v) {
    if (!v) return null;
    const str = String(v).trim();
    const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(str);
    const d = new Date(str.replace(' ', 'T') + (hasZone ? '' : 'Z'));
    return isNaN(d.getTime()) ? null : d;
  }
  function whenText(v) {
    const d = parseTs(v);
    if (!d) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  window.rcpHistory = async function () {
    if (!_rec || !_rec.id) return;
    // Get what is on screen onto the server first, so the "now" row really is
    // now and the newest version really is the one before it. Without this the
    // panel would describe a record two edits behind the one being looked at.
    await flushSave();
    let rows = [];
    try {
      const j = await api('/api/retail-admin/recipes/' + _rec.id + '/versions');
      rows = j.data || [];
    } catch (e) {
      toast(T('Could not load history', '无法加载修改记录') + ': ' + (e.message || ''), 'err');
      return;
    }
    openHistoryModal(rows);
  };

  function openHistoryModal(rows) {
    const st = { sel: 'now', cache: {} };
    const bodyHtml = `
      <h3 class="tdlg-title">${esc(T('History', '修改记录'))}</h3>
      <p class="tdlg-msg">${esc(T(
        'Every save files the state it replaced. Pick one to see what it held, then put it back.',
        '每次保存都会存档被替换的内容。选择一条查看其内容,并可恢复。'))}</p>
      <div class="rcp-hist-list" id="rcp-hist-list"></div>
      <div class="rcp-hist-detail" id="rcp-hist-detail"></div>`;
    const footHtml = `
      <button type="button" class="tdlg-btn tdlg-btn--ghost" data-cancel>${esc(T('Close', '关闭'))}</button>
      <button type="button" class="tdlg-btn tdlg-btn--primary" data-submit disabled>${esc(T('Restore this version', '恢复该版本'))}</button>`;
    // Focus the first row, not the footer: the panel is read before it is
    // acted on, and arrow-key navigation of the list is the point.
    const { scrim, closer } = askCustom('tdlg-neutral rcp-hist-modal', bodyHtml, footHtml, '.rcp-hist-row');
    const close = () => closer(null);
    scrim.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));
    const submitBtn = scrim.querySelector('[data-submit]');
    // Reading history is open to anyone who can open the record; writing an
    // older state back over the live one is an edit, and is gated like one.
    // The server gates it regardless — this is UX, not the enforcement.
    if (!canEdit()) submitBtn.hidden = true;

    const listHost = scrim.querySelector('#rcp-hist-list');
    const detailHost = scrim.querySelector('#rcp-hist-detail');

    function renderList() {
      const nowRow = `
        <button type="button" class="rcp-hist-row now${st.sel === 'now' ? ' on' : ''}" data-v="now">
          <span class="rcp-hist-when">${esc(T('Now — the live recipe', '当前 —— 正在使用的版本'))}</span>
          <span class="rcp-hist-who">${esc(T(`${_lines.length} ingredients · ${_steps.length} steps`,
            `${_lines.length} 项原料 · ${_steps.length} 个步骤`))}</span>
        </button>`;
      const verRows = rows.map(v => `
        <button type="button" class="rcp-hist-row${String(st.sel) === String(v.id) ? ' on' : ''}" data-v="${v.id}">
          <span class="rcp-hist-when">${esc(T('until ', '直到 '))}${esc(whenText(v.created_at))}</span>
          <span class="rcp-hist-who">${esc(v.actor || T('unknown', '未知'))} ${esc((HIST_SOURCE[v.source] || HIST_SOURCE.manual)())}</span>
        </button>`).join('');
      listHost.innerHTML = nowRow + (verRows || `<div class="rcp-hist-empty">${esc(T(
        'No earlier versions yet — this recipe has not been changed since it was created.',
        '暂无更早的版本 —— 该食谱自创建以来未被修改。'))}</div>`);
      listHost.querySelectorAll('.rcp-hist-row').forEach(b => b.addEventListener('click', () => select(b.dataset.v)));
    }

    async function select(v) {
      st.sel = v;
      renderList();
      submitBtn.disabled = v === 'now';
      if (v === 'now') { renderDetail(null); return; }
      if (st.cache[v]) { renderDetail(st.cache[v]); return; }
      detailHost.innerHTML = `<div class="rcp-hist-empty">${esc(T('Loading…', '加载中…'))}</div>`;
      try {
        const j = await api('/api/retail-admin/recipes/' + _rec.id + '/versions/' + v);
        st.cache[v] = j.data;
      } catch (e) {
        detailHost.innerHTML = `<div class="rcp-hist-empty">${esc(T('Could not read that version', '无法读取该版本'))}</div>`;
        submitBtn.disabled = true;
        return;
      }
      if (String(st.sel) === String(v)) renderDetail(st.cache[v]);
    }

    function renderDetail(v) {
      if (!v) {
        detailHost.innerHTML = `<div class="rcp-hist-empty">${esc(T(
          'The recipe as it stands right now. Pick an earlier row to compare.',
          '这是当前的食谱内容。选择上方的历史条目进行对比。'))}</div>`;
        return;
      }
      const snap = v.snapshot || {};
      const r = snap.recipe || {};
      const lines = snap.ingredients || [];
      const cd = snap.costData || {};
      const row = (lbl, val) => `<dt>${esc(lbl)}</dt><dd>${esc(dash(val))}</dd>`;
      // The ingredient lines are the reason anyone opens this panel — a deleted
      // one is the change nothing else on the screen can show was ever there.
      // Named, not counted, for the same reason the unit-mismatch toast names
      // its lines: a count sends the reader back to guess which.
      const shown = lines.slice(0, 8).map(l => `${l.name_en || '?'} ${l.qty}${l.unit || ''}`).join(', ');
      const more = lines.length > 8 ? T(` +${lines.length - 8} more`, ` 等 ${lines.length} 项`) : '';
      detailHost.innerHTML = `
        <p style="margin:0 0 10px">${esc(T(
          `How this recipe stood until ${whenText(v.created_at)}.`,
          `该食谱直到 ${whenText(v.created_at)} 时的内容。`))}</p>
        <dl>
          ${row(T('Name', '名称'), r.name_en)}
          ${row(T('Category', '分类'), r.category)}
          ${row(T('Batch size', '批量大小'), r.batch_size)}
          ${row(T('Servings', '份数'), r.servings)}
          ${row(T('Ingredients', '原料'), lines.length ? shown + more : T('none', '无'))}
          ${row(T('Steps', '步骤'), (snap.steps || []).length)}
          ${row(T('Sell price', '售价'), cd.sell_price != null ? money(cd.sell_price) : null)}
          ${row(T('Labour', '人工'), cd.labour != null ? money(cd.labour) : null)}
        </dl>`;
    }

    submitBtn.addEventListener('click', async () => {
      const vid = st.sel;
      if (!vid || vid === 'now') return;
      const v = st.cache[vid] || {};
      const ok = await askConfirm({
        titleEn: 'Restore this version?', titleCn: '恢复该版本?',
        bodyEn: `The recipe goes back to how it stood until ${whenText(v.created_at)} — its details, `
              + `ingredient lines, steps and cost inputs, all four. What is on the record now is filed `
              + `first, so this can itself be undone.`,
        bodyCn: `该食谱将恢复为直到 ${whenText(v.created_at)} 时的内容 —— 基本信息、原料明细、步骤与成本输入,四者一并恢复。`
              + `当前内容会先被存档,因此本次恢复同样可以撤销。`,
        confirmEn: 'Restore', confirmCn: '恢复',
      });
      if (!ok) return;
      submitBtn.disabled = true;
      // Nothing may autosave the on-screen draft over the top of the state
      // being written — the restore is the authority for the next moment.
      _autoOff = true;
      cancelAutosave();
      try {
        const j = await api('/api/retail-admin/recipes/' + _rec.id + '/versions/' + vid + '/restore', { method: 'POST' });
        close();
        const fresh = await api('/api/retail-admin/recipes/' + _rec.id);
        setRecord(fresh.data, true);
        _dirty = false;
        _saveErr = null;
        _savedAt = Date.now();
        paintRecord();
        // `held` names anything the restore could NOT put back — today only a
        // SKU another recipe has taken since. Said out loud rather than left
        // for someone to notice: a silent partial restore is a lie about what
        // the record now contains.
        const held = (j.held || []);
        toast(held.length
          ? T(`Restored — except ${held.join(', ')}, which another recipe now owns.`,
              `已恢复 —— 但 ${held.join('、')} 现已被其他食谱占用,未一并恢复。`)
          : T('Restored', '已恢复'), held.length ? 'err' : 'ok');
      } catch (e) {
        submitBtn.disabled = false;
        toast(T('Restore failed', '恢复失败') + ': ' + ((e.data && e.data.message) || e.message || ''), 'err');
      } finally {
        _autoOff = false;
      }
    });

    renderList();
    renderDetail(null);
  }

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
    // Both branches end in a full repaint from the server's copy, so anything
    // still only in the browser has to be on the server first.
    await flushSave();
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
      setRecord(fresh.data, true);
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
        setRecord(fresh.data, true);
        paintRecord();
      } catch (e) {
        submitBtn.disabled = false;
        const msg = (e.data && e.data.message) || e.message || '';
        toast(T('Failed', '操作失败') + ': ' + msg, 'err');
      }
    });
  }
})();
