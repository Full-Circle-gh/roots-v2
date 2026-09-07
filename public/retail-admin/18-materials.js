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
  // The tenant's display currency (01-core.js acMoney), not a hardcoded ¥ —
  // material costs are money and read in whatever currency the tenant set.
  const money = n => (typeof acMoney === 'function'
    ? acMoney(Number(n) || 0)
    : '¥' + (typeof fmt === 'function' ? fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2)));
  // A missing value reads as a dash, never as zero or an empty cell — the
  // catalogue has real gaps (blank finance category, unrecorded pack contents)
  // and hiding them is how they stay unfixed.
  const dash = v => (v === null || v === undefined || v === '' ? '—' : v);

  // ── Who may read what a material costs (Ash, 2026-09-03) ────────────────
  //
  // `materials:view` opens the masterlist; `materials:costs` reads the two
  // money columns on it. FAILS CLOSED, unlike can(), which answers true on a
  // null cap set so a resolution hiccup never locks an operator out of their
  // own app — money inverts that trade. The server does not SEND a price to a
  // caller without the capability (routes/retail-materials.js), so this
  // decides layout and the payload decides what is knowable; where they
  // disagree the payload wins, which is why the readers below all handle an
  // absent figure rather than trusting this to have hidden it.
  const showMoney = () => (typeof CAPS !== 'undefined' && CAPS !== null)
    ? CAPS.has('materials:costs')
    : false;

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
  // 'bought' | 'made' | '' (both). Defaults to bought — see sourceTabs().
  let _source = 'bought';
  let _srcCounts = { bought: 0, made: 0 };
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
  // The list shell — heading, filter bar, search box — is painted once and then
  // left alone; see paintList(). False means it is not on screen (first load, a
  // language change, a load that errored out over it).
  let _shell = false;
  // Every load takes a ticket. A search fires one request per settled keystroke
  // and they do not come back in order — without this, a slow answer for "sa"
  // repaints over the answer for "salt" and the table shows rows that do not
  // match what is in the box.
  let _loadSeq = 0;

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
    chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.matInit = async function () {
    if (_init) { load(); return; }
    _init = true;
    // A language change is the one thing that DOES have to rebuild the shell —
    // every label in it is bilingual. Nobody is mid-word in the search box when
    // they reach for the language switch.
    if (typeof onLangChange === 'function') onLangChange(() => { _shell = false; paintList(); if (_recOpen) paintRecord(); });
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
    const seq = ++_loadSeq;
    // ONLY BEFORE THERE IS A SHELL. This line replaces the whole list root, the
    // search box with it, and the condition used to be `!_rows.length` — so once
    // a search matched nothing, every following keystroke tore down the field
    // being typed into and painted "Loading…" over it. That is most of what the
    // box felt like: it went dead the moment you were mid-word on a term with no
    // matches yet, which for a Chinese name is every pinyin letter of it.
    if (r && !_shell) r.innerHTML = `<div class="mat-loading">${esc(T('Loading…', '加载中…'))}</div>`;
    const qs = new URLSearchParams();
    if (_q) qs.set('search', _q);
    if (_kind) qs.set('kind', _kind);
    if (_cat) qs.set('category', _cat);
    if (_sup) qs.set('supplier', _sup);
    if (_archived) qs.set('archived', '1');
    if (_source) qs.set('source', _source);
    try {
      const j = await api('/api/retail-admin/materials?' + qs.toString());
      if (seq !== _loadSeq) return;   // a later keystroke already asked; this answer is stale
      _rows = j.data || [];
      _counts = j.counts || {};
      _srcCounts = j.sourceCounts || { bought: 0, made: 0 };
      // The list now carries a row ceiling (audit J-01). Say so when it bites;
      // clear the notice when it does not, which is every load on every tenant
      // today. `r` is the list root this screen already holds.
      if (typeof tdShowTruncation === 'function') tdShowTruncation(r, j, 'materials', '条物料');
    } catch (e) {
      if (seq !== _loadSeq) return;
      _rows = [];
      const line = `<div class="mat-emptyline">${esc(T('Could not load materials', '无法加载物料'))} — ${esc(e.message || '')}</div>`;
      // Into the table area when there is one, so a failed keystroke-load does
      // not take the search box down with it — the operator is still typing.
      const body = document.getElementById('mat-list');
      if (body) { body.innerHTML = line; }
      else { if (r) r.innerHTML = line; _shell = false; }
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
        ${/* The second sentence explains a column that is not on the page for
              an operator without materials:costs. Telling somebody how a
              number they cannot see is worked out is worse than saying
              nothing — it describes the page they were not given. The first
              sentence, which says what a material IS, holds for everyone. */''}
        <p class="mat-sub">${esc(showMoney()
          ? T('Everything you buy and hold but don’t sell — food, packaging, equipment, supplies. What each one costs per unit is worked out from the pack price.', '你采购并库存但不出售的物品 — 食品、包装、设备、耗材。每单位成本由整包价格自动折算。')
          : T('Everything you buy and hold but don’t sell — food, packaging, equipment, supplies.', '你采购并库存但不出售的物品 — 食品、包装、设备、耗材。'))}</p>
      </div>`;
  }

  // THE TWO JOBS THIS SCREEN DOES, TOLD APART. Every recipe save files its
  // output here as a material, because a product's build list can only point at
  // a material — that is how a cooked thing reaches a cost, and it is not
  // optional. The side effect was that 122 kitchen outputs sat in the same list
  // as the 630 things Roots actually buys, so the list stopped being about
  // either. Worse, a bought material and the recipe that repacks it read as the
  // same row twice (Ash, on Nour Dates) with nothing on screen saying which was
  // which.
  //
  // DEFAULTS TO BOUGHT, because that is the job the screen's own subtitle
  // describes — "everything you buy and hold" — and the one with re-ordering,
  // suppliers and pack prices behind it. Made rows are never hidden, only
  // filed: the tab carries its own live count, so "Made 122" is on screen
  // whichever tab is open, and tableHtml()'s empty state points across when a
  // search finds nothing here but something there.
  //
  // The PICKERS ARE NOT FILTERED BY THIS (see routes/retail-materials.js) —
  // the build list and recipe lines keep seeing every row, so no tab on this
  // screen can make a material impossible to cost with.
  function sourceTabs() {
    const tabs = [
      ['bought', T('Bought', '采购'), _srcCounts.bought],
      ['made', T('Made', '自制'), _srcCounts.made],
      ['', T('All', '全部'), _srcCounts.bought + _srcCounts.made],
    ];
    return tabs.map(([key, label, n]) =>
      `<button class="mat-srctab${_source === key ? ' on' : ''}" onclick="matSetSource('${esc(key)}')">${esc(label)}<b class="mat-num">${n}</b></button>`
    ).join('');
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
          ${/* The event goes to matSearch() as well as the value: an IME's
                half-typed pinyin arrives as input events too, and searching on
                it is searching for something the operator has not typed yet.
                The other half of that — compositionend — is bound in code, not
                here; see bindComposition(). */''}
          <input class="mat-input" type="search" id="mat-q" value="${esc(_q)}"
                 oninput="matSearch(this.value, event)"
                 autocomplete="off"
                 placeholder="${esc(T('Search name or SKU', '搜索名称或货号'))}">
        </div>
        <select class="mat-input mat-sel" id="mat-cat" onchange="matSetCat(this.value)">${catOpts}</select>
        <select class="mat-input mat-sel" id="mat-sup" onchange="matSetSup(this.value)">${supOpts}</select>
        <label class="mat-check"><input type="checkbox" id="mat-arch" ${_archived ? 'checked' : ''} onchange="matSetArchived(this.checked)"> ${esc(T('Archived', '已归档'))}</label>
        <span class="mat-spacer"></span>
        <button class="mat-btn primary" data-cap="materials:edit" onclick="matRecordNew()"><span class="mat-ic">${I.plus}</span>${esc(T('New material', '新建物料'))}</button>
      </div>`;
  }

  // THE SEARCH BOX IS NEVER REBUILT WHILE SOMEBODY IS TYPING INTO IT.
  //
  // This used to write the whole list root on every load, which destroyed the
  // field mid-word and then put focus and the caret back by hand. That hand-back
  // cost more than it looked: the caret always landed at the END, so correcting
  // a typo in the middle of a term threw you to the end of it a quarter-second
  // later; and an IME composition cannot be restored at all — the browser drops
  // the candidate window with the element that owned it, which is why the box
  // stuttered before a single Chinese character had been committed.
  //
  // So the shell — heading, source tabs, chip row, filter bar, table frame — is
  // painted ONCE. A load afterwards repaints only what a search actually
  // changes: the two count rows and the table. The <input> is never touched, so
  // there is nothing to restore, no caret to guess at, and no composition to
  // lose. `_shell` says whether it is up; the #mat-q check is what notices if
  // something outside this module cleared the root.
  function paintList() {
    const r = listRoot();
    if (!r) return;
    if (!_shell || !r.querySelector || !r.querySelector('#mat-q')) {
      r.innerHTML = chrome()
        + `<div class="mat-srcrow" id="mat-srcrow">${sourceTabs()}</div>`
        + `<div class="mat-chiprow" id="mat-chiprow">${kindChips()}</div>`
        + filterBar()
        + `<div id="mat-list">${tableHtml()}</div>`;
      _shell = true;
      bindComposition();
    } else {
      const srcrow = document.getElementById('mat-srcrow');
      const chiprow = document.getElementById('mat-chiprow');
      const body = document.getElementById('mat-list');
      if (srcrow) srcrow.innerHTML = sourceTabs();
      if (chiprow) chiprow.innerHTML = kindChips();
      syncFilters();
      if (body) body.innerHTML = tableHtml();
    }
    try { applyCapGates(); } catch (_) {}
  }

  // THE ONE EVENT THAT CANNOT BE WIRED IN THE MARKUP, and it is the one that
  // matters most here.
  //
  // Composition events are not in GlobalEventHandlers, so `oncompositionend="…"`
  // as an HTML attribute is not a handler at all — the browser ignores it in
  // silence, exactly as it would ignore `onbanana`. It has to be addEventListener
  // or nothing.
  //
  // WHY IT IS NOT OPTIONAL. Measured in Chromium, committing a pinyin candidate
  // fires `input` with isComposing STILL TRUE, carrying the finished characters,
  // and only THEN compositionend. So matSearch()'s isComposing guard skips the
  // one input event that had the real term in it — without this listener the
  // search would never run for a Chinese term at all, and the box would look
  // broken in the other direction.
  //
  // Bound on the element the shell paint just minted, and only there: a fresh
  // element each time means no listener is ever attached twice. No event is
  // passed on, because by definition there is no composition left to guard
  // against — whatever the browser sets isComposing to on this event.
  function bindComposition() {
    const q = document.getElementById('mat-q');
    if (q && typeof q.addEventListener === 'function') {
      q.addEventListener('compositionend', () => { window.matSearch(q.value); });
    }
  }

  // The filter bar outlives its own repaint now, so a filter changed in code
  // rather than by hand — matClearFilters() is the only one — has to be written
  // back onto its control. #mat-q is deliberately NOT among them: it is the one
  // control the operator may be mid-word in, and matClearFilters clears it
  // itself, at the moment it is asked to.
  function syncFilters() {
    const cat = document.getElementById('mat-cat');
    const sup = document.getElementById('mat-sup');
    const arch = document.getElementById('mat-arch');
    if (cat && cat.value !== _cat) cat.value = _cat;
    if (sup && sup.value !== _sup) sup.value = _sup;
    if (arch) arch.checked = _archived;
  }

  function tableHtml() {
    if (!_rows.length) {
      const blank = _q || _kind || _cat || _sup;
      // sourceCounts is taken with the search applied and the source tab NOT
      // (routes/retail-materials.js), so this is the real number of matches
      // sitting one tab over — the difference between "there is no such
      // material" and "it is filed under the other job", which is the whole
      // reason the tabs exist. Only offered when it is not zero.
      const elsewhere = _source === 'bought' ? _srcCounts.made
        : _source === 'made' ? _srcCounts.bought : 0;
      const otherTab = _source === 'bought' ? 'made' : 'bought';
      const otherLabel = otherTab === 'made' ? T('Made', '自制') : T('Bought', '采购');
      return `
        <div class="mat-card mat-empty">
          <div class="mat-empty-ico">${I.crate}</div>
          <h3>${esc(blank ? T('Nothing matches', '没有匹配项') : T('No materials yet', '暂无物料'))}</h3>
          <p>${esc(blank
            ? T('Try a different search, or clear the filters.', '换个搜索词,或清除筛选条件。')
            : T('A material is anything you buy and keep — flour, cups, a mixer. Add the first one and its cost per unit is worked out for you.', '物料是你采购并留存的任何东西 —— 面粉、杯子、搅拌机。新建第一条,单位成本会自动算好。'))}</p>
          ${elsewhere ? `<p class="mat-emptyline"><button class="mat-linkbtn" onclick="matSetSource('${otherTab}')">${esc(
            T(`${elsewhere} in ${otherLabel} →`, `${otherLabel}中有 ${elsewhere} 条 →`))}</button></p>` : ''}
          <!-- The button (audit C-03). This screen explained a material better
               than any other empty state in the product and then offered no way
               to make one — the operator read the sentence and had to go and
               find the toolbar. Suppliers has offered its own button all along;
               this is the same shape.
               On the "nothing matches" branch the useful action is the opposite
               one: put the whole list back. -->
          <div style="margin-top:14px">${blank
            ? `<button class="mat-btn" type="button" onclick="matClearFilters()">${esc(T('Clear the filters', '清除筛选'))}</button>`
            : `<button class="mat-btn primary" type="button" data-cap="materials:edit" onclick="matRecordNew()"><span class="mat-ic">${I.plus}</span>${esc(T('Add your first material', '新建第一条物料'))}</button>`}</div>
        </div>`;
    }
    // Both money columns are REMOVED for an operator without materials:costs —
    // header and cells — rather than dashed out. A dash means "we have no
    // price for this", which is a real and different state the catalogue uses;
    // reusing it for "you may not see the price" would make the two
    // indistinguishable on the screen where somebody is meant to fix the first.
    // The table is auto-layout, so dropping two columns needs no width work.
    const withCost = showMoney();
    const rows = _rows.map(m => {
      const cpu = Number(m.cost_per_unit) || 0;
      const cpuTxt = m.free_by_design
        ? esc(T('free', '免费'))
        : (cpu > 0 ? `${money(cpu)}<span class="mat-per">/${esc(m.unit || '')}</span>` : '—');
      return `
        <tr onclick="matRecordOpen(${m.id})">
          <td>
            <div class="mat-name">${esc(m.name_en || '')}${m.source_recipe_id != null
              ? `<span class="mat-made" title="${esc(T('Created by a recipe, not bought', '由配方生成,非采购'))}">${esc(T('Made', '自制'))}</span>` : ''}</div>
            ${m.name_cn ? `<div class="mat-sub2">${esc(m.name_cn)}</div>` : ''}
          </td>
          <td><span class="mat-tag">${esc(kindLabel(m.item_kind || 'food'))}</span></td>
          <td class="mat-mono">${esc(dash(m.sku))}</td>
          <td>${esc(dash(m.category))}</td>
          <td>${esc(dash(m.supplier))}</td>
          ${withCost ? `<td class="right mat-num">${m.buy_price > 0 ? money(m.buy_price) : '—'}<span class="mat-per">${m.buy_price > 0 ? '/' + esc(m.buy_unit || '') : ''}</span></td>
          <td class="right mat-num">${cpuTxt}</td>` : ''}
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
              ${withCost ? `<th class="right">${esc(T('Buy price', '采购价'))}</th>
              <th class="right">${esc(T('Cost per unit', '单位成本'))}</th>` : ''}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  window.matSetSource = function (v) { _source = v; load(); };
  window.matSetKind = function (k) { _kind = k; load(); };
  window.matSetCat  = function (c) { _cat = c; load(); };
  window.matSetSup  = function (s) { _sup = s; load(); };
  window.matSetArchived = function (on) { _archived = !!on; load(); };
  // Put the whole list back, in one action (audit C-03 / B-06). The "nothing
  // matches" empty state offers it, because an operator who has filtered down
  // to nothing should not have to remember which four controls they touched.
  // `_archived` and `_source` are NOT reset, and that is the rule: both are
  // places you chose to be — the archive, and the Bought / Made tabs — not
  // filters that narrowed the place you were. Clearing should widen the list
  // you are looking at, never move you to a different one.
  window.matClearFilters = function () {
    _q = ''; _kind = ''; _cat = ''; _sup = '';
    const q = document.getElementById('mat-q'); if (q) q.value = '';
    load();
  };
  // TYPING IS NOT A SEARCH TERM UNTIL THE IME SAYS IT IS.
  //
  // A Chinese keyboard fires an `input` event for every letter of the pinyin
  // while the candidate window is still open — "s", "sh", "sha", "shai" — none
  // of which the operator typed or would search for, and none of which the
  // catalogue matches, since every name is stored in characters. The old handler
  // took each one as a term: four requests and four repaints for one character,
  // each landing while the composition was still open.
  //
  // `event.isComposing` is true for exactly those events and false everywhere
  // else, so plain English typing is unchanged. `compositionend` carries the
  // committed characters and is what actually starts the search; browsers that
  // also fire a trailing `input` just reset the same timer.
  window.matSearch = function (v, ev) {
    if (ev && ev.isComposing) return;
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
    matComboClose();   // the combo menu hangs off <body>, not off the record
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  COMBO FIELDS — Finance category, and Supplier
  // ═══════════════════════════════════════════════════════════════════════════
  // One search-and-pick control, two fields. Both are free text with a long
  // list behind them (the live tenant carries ~80 suppliers and ~30 finance
  // categories), and both were unusable as the thing they started as: a
  // native <select>/<datalist> you cannot type at, whose popup is drawn by
  // the OS combobox widget — which some embedding webviews (chat-app browser
  // panes) position at the wrong screen coordinates entirely, pinning it to
  // the far edge of the window instead of under the field. Same conclusion,
  // and the same implementation, as puSuggest* in 16-purchasing.js: draw the
  // list ourselves, filter it as you type, scroll it, and keep the keyboard
  // the native popup gave us free.
  //
  // The menu is position:fixed, placed under the input by JS, and —
  // critically — a direct child of <body>, never nested inside .mat-card.
  // Two separate ancestor effects needed escaping, not one:
  //  1. .mat-card rounds its corners with clip-path, which clips an
  //     absolutely-positioned descendant to the card same as overflow:hidden
  //     would (position:fixed alone escapes this — it repositions the box
  //     relative to the viewport instead of the card).
  //  2. clip-path ALSO makes .mat-card a stacking-context root. A
  //     position:fixed descendant still escapes ancestor CLIPPING, but not
  //     ancestor PAINT ORDER — it stays painted as part of that stacking
  //     context, so the very next sibling card (Units & cost), being a later
  //     stacking context in DOM order, painted right on top of it, covering
  //     the dropdown wherever the two happened to overlap on screen. Only
  //     hoisting the element out to <body> — outside any stacking-context
  //     ancestor — puts it back at the top of the paint order.
  //
  // A row's VALUE is what lands in the field, and it is not always what the
  // row shows. Both fields store one bilingual string apiece; the supplier
  // menu shows its two halves apart so a Chinese reader isn't hunting through
  // English, while data keeps the whole name — see supplierComboRows.

  // A supplier is stored as ONE free-text name, and most of the live ones glue
  // both languages into it — "Dry Fruit 果干". Split the stored string at its
  // language boundary (first 中文 character to last; the rest is the English
  // half) so the menu never shows both at once. A name written in only one
  // language has no boundary and survives whole in both. This is supSplit()
  // from 16-purchasing.js, kept as its own small copy for the same reason
  // SRC_BLOCK_REASON above is: this file has no module system, only
  // sequential <script> globals.
  const CJK_CHAR = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  function supSplit(name) {
    const raw = String(name == null ? '' : name).trim();
    let first = -1, last = -1;
    for (let i = 0; i < raw.length; i++) {
      if (CJK_CHAR.test(raw[i])) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return { en: raw, cn: raw };
    const trim = t => t.replace(/^[\s·\-–—/,|]+|[\s·\-–—/,|]+$/g, '').trim();
    const cn = trim(raw.slice(first, last + 1));
    const en = trim((raw.slice(0, first) + ' ' + raw.slice(last + 1)).replace(/\s{2,}/g, ' '));
    return { en: en || raw, cn: cn || raw };
  }

  // The supplier book as menu rows. `v` is the WHOLE stored name, never a
  // half: that string is what Purchasing groups orders, invoices and
  // price history by (it joins on the name, not on an id), so filing this
  // material under half of one would file it under a supplier that owns
  // nothing. The halves are display only — lead in the reading language,
  // trail muted beside it. suppliers.name_cn, when the master holds one,
  // wins over the split.
  function supplierComboRows() {
    return _suppliers.filter(s => s.is_active !== 0).map(s => {
      const half = supSplit(s.name);
      const cn = String(s.name_cn || '').trim() || half.cn;
      return { v: s.name, lead: T(half.en, cn), trail: T(cn, half.en) };
    });
  }

  const COMBO = {
    // Finance categories are stored whole and read whole — two strings that
    // differ by one character are two categories in every Finance report
    // (lib/category-text.js documents the live case) — so the row shows the
    // whole string rather than a half.
    accounting_category: {
      rows: () => _finCats.map(c => ({ v: c, lead: c })),
      limit: 30,
    },
    supplier: {
      rows: supplierComboRows,
      // "None" leads the list because clearing a supplier has to stay one
      // click, the way it was when this field was a <select> whose first
      // option was None.
      lead: () => [{ v: '', lead: T('None', '无'), cls: 'none' }],
      // …and when what you typed names nobody in the book, the way out is
      // offered where you are looking, not only on the button below.
      tail: (q, isExact) => (q && !isExact
        ? [{ v: q, lead: T(`Add “${q}” as a new supplier`, `添加“${q}”为新供应商`), act: 'new', cls: 'act' }]
        : []),
    },
  };

  let _comboFor = null;   // field key whose menu is open ('supplier', …)
  let _comboRows = [];    // what that menu is showing, in order
  let _comboIdx = -1;     // keyboard-highlighted row, -1 = none

  function comboMenuEl() {
    let menu = document.getElementById('mat-combo-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'mat-combo-menu';
      menu.id = 'mat-combo-menu';
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;
      // Picking is wired here, once, by delegation — NOT as an inline
      // onmousedown per option. Both vocabularies are free text and many
      // entries carry quotes/brackets ("Ingredients(Kitchen+Retail Use)
      // 原材料（厨房及零售通用）"), and an inline handler has to survive being
      // embedded in an HTML attribute AND parsed as JS. It didn't: the
      // quoted argument's own `"` closed the attribute early, leaving every
      // option with a syntactically broken handler, so clicks did nothing at
      // all. The row carries only its index; the value is read from
      // _comboRows, out of reach of both parsers.
      menu.addEventListener('mousedown', (e) => {
        const opt = e.target.closest && e.target.closest('.mat-combo-opt');
        if (!opt) return;
        // Keep focus on the input: the deferred hide in matComboBlur would
        // otherwise race the pick.
        e.preventDefault();
        comboPick(Number(opt.dataset.i));
      });
      document.body.appendChild(menu);
    }
    return menu;
  }
  function comboPlace(input) {
    const menu = comboMenuEl();
    const r = input.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.width = r.width + 'px';
    // Under the field by default; over it when the field sits low enough that
    // the list would run off the bottom of the window.
    const below = window.innerHeight - r.bottom;
    if (below < menu.offsetHeight + 12 && r.top > below) {
      menu.style.top = Math.max(8, r.top - menu.offsetHeight - 4) + 'px';
    } else {
      menu.style.top = (r.bottom + 4) + 'px';
    }
  }
  function comboRowsFor(key) {
    const cfg = COMBO[key];
    const input = document.getElementById('mat-f-' + key);
    if (!cfg || !input) return [];
    const typed = String(input.value || '').trim();
    const q = typed.toLowerCase();
    const all = cfg.rows() || [];
    const hay = r => [r.v, r.lead, r.trail].filter(Boolean).join(' ').toLowerCase();
    // A value that already IS an option keeps the whole list open instead of
    // narrowing to itself — that is what lets a field you have already filled
    // be reopened and changed (same rule as puSuggest in 16-purchasing.js).
    const isExact = all.some(r => String(r.v).toLowerCase() === q);
    let matched = (!q || isExact) ? all : all.filter(r => hay(r).includes(q));
    if (cfg.limit) matched = matched.slice(0, cfg.limit);
    return [].concat(
      cfg.lead ? cfg.lead() : [],
      matched,
      cfg.tail ? cfg.tail(typed, isExact) : [],
    );
  }
  function comboPaint() {
    comboMenuEl().innerHTML = _comboRows.map((r, i) => `
      <div class="mat-combo-opt${r.cls ? ' ' + r.cls : ''}${i === _comboIdx ? ' on' : ''}"
           role="option" aria-selected="${i === _comboIdx}" data-i="${i}">
        <span class="lead">${esc(r.lead)}</span>${r.trail && r.trail !== r.lead ? `<span class="trail">${esc(r.trail)}</span>` : ''}
      </div>`).join('');
  }
  function comboPick(i) {
    const key = _comboFor;
    const row = _comboRows[i];
    if (!key || !row) return;
    // The create row doesn't fill the field — it opens the dialog that makes
    // the supplier real first, and that fills the field on success.
    if (row.act === 'new') { const typed = row.v; matComboClose(); matSupNew(typed); return; }
    const input = document.getElementById('mat-f-' + key);
    if (input) { input.value = row.v; input.focus(); }
    matDirty();
    matComboClose();
    if (key === 'supplier') matSupNote();
  }
  window.matComboOpen = function (key) {
    const input = document.getElementById('mat-f-' + key);
    if (!input || !COMBO[key]) return;
    if (_comboFor !== key) _comboIdx = -1;
    _comboRows = comboRowsFor(key);
    if (!_comboRows.length) { matComboClose(); return; }
    _comboFor = key;
    if (_comboIdx >= _comboRows.length) _comboIdx = -1;
    comboPaint();
    const menu = comboMenuEl();
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    comboPlace(input);
  };
  window.matComboClose = function () {
    const menu = document.getElementById('mat-combo-menu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; }
    const input = _comboFor && document.getElementById('mat-f-' + _comboFor);
    if (input) input.setAttribute('aria-expanded', 'false');
    _comboFor = null; _comboRows = []; _comboIdx = -1;
  };
  window.matComboBlur = function (key) {
    // Deferred: an option's mousedown preventDefault()s the focus loss, but a
    // click landing anywhere else still needs its turn before we tear down.
    // Only close if the menu is still THIS field's — tabbing from one combo
    // to the other fires the first field's blur after the second has already
    // opened its list, and closing then would shut a menu just asked for.
    setTimeout(() => { if (_comboFor === key) matComboClose(); }, 150);
  };
  // The chevron sits inside the field, so a plain click would re-focus the
  // input and toggle nothing. Handle it on mousedown, before focus moves.
  window.matComboToggle = function (e, key) {
    e.preventDefault(); e.stopPropagation();
    if (_comboFor === key) { matComboClose(); return; }
    const input = document.getElementById('mat-f-' + key);
    if (input) input.focus();
    matComboOpen(key);
  };
  // Arrow keys / Enter / Escape — the keyboard the native popup gave us free.
  window.matComboKey = function (e, key) {
    const menu = document.getElementById('mat-combo-menu');
    const open = !!menu && !menu.hidden && _comboFor === key;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { _comboIdx = -1; matComboOpen(key); }
      const n = _comboRows.length;
      if (!n) return;
      _comboIdx = e.key === 'ArrowDown' ? (_comboIdx + 1) % n : (_comboIdx <= 0 ? n - 1 : _comboIdx - 1);
      comboPaint();
      const on = comboMenuEl().children[_comboIdx];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!open) return;
    if (e.key === 'Enter') {
      // Enter with nothing highlighted means "I typed what I meant" — leave
      // the free text alone and just get the menu out of the way.
      if (_comboIdx >= 0 && _comboRows[_comboIdx]) { e.preventDefault(); comboPick(_comboIdx); }
      else matComboClose();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); matComboClose(); }
  };
  // Fixed-position menu doesn't track the page under it on its own — close
  // it when the page underneath scrolls, so it never drifts away from the
  // field it was anchored to. Scroll events don't bubble, so a capturing
  // document listener is the only way to catch the record page's own
  // scroller — but that also fires while scrolling *inside* the menu's own
  // option list (its target is a descendant, seen during capture), which
  // must not close it.
  document.addEventListener('scroll', (e) => {
    const menu = document.getElementById('mat-combo-menu');
    if (menu && !menu.hidden && !menu.contains(e.target)) matComboClose();
  }, true);
  window.addEventListener('resize', () => { if (_comboFor) matComboClose(); });

  // ── the supplier field's own two extras ───────────────────────────────────
  // A supplier here is free text, and every supplier screen joins on that
  // exact string. A name that is nobody in the book therefore buys nothing —
  // no orders group under it, no price history collects against it. Say that
  // under the field rather than let a typo look filed.
  function supNoteHtml(v) {
    const name = String(v == null ? '' : v).trim();
    if (!name) return '';
    const known = _suppliers.some(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase());
    if (known) return '';
    return `<span class="warn">${esc(T('Not in your supplier book yet — purchasing won’t group orders under this name until it is added.',
                                        '尚未加入供应商名录 —— 添加后采购才会按该名称归集。'))}</span>`;
  }
  // Global because the field's own oninput calls it — an inline handler is
  // parsed in global scope and cannot see anything inside this IIFE.
  window.matSupNote = function () {
    const el = document.getElementById('mat-supnote');
    if (el) el.innerHTML = supNoteHtml((document.getElementById('mat-f-supplier') || {}).value);
  };
  function matSupSet(name) {
    const el = document.getElementById('mat-f-supplier');
    if (el) el.value = name;
    matDirty();
    matSupNote();
  }
  // Adding a supplier from here writes to the shared supplier book
  // immediately — it is the same master Purchasing → Suppliers keeps, not a
  // draft that waits for this material's Save. Only the name is asked for:
  // the rest of a supplier record (contact, terms, channel) belongs on that
  // screen, and a half-filled record made in passing is worse than a named
  // one to fill in later.
  window.matSupNew = async function (prefill) {
    const field = document.getElementById('mat-f-supplier');
    const typed = String(prefill != null ? prefill : ((field && field.value) || '')).trim();
    if (typeof askPrompt !== 'function') return;
    const answer = await askPrompt({
      titleEn: 'New supplier', titleCn: '新建供应商',
      subEn: 'Added to Purchasing → Suppliers straight away, and set on this material.',
      subCn: '立即加入「采购 → 供应商」,并设为该物料的供应商。',
      labelEn: 'Name', labelCn: '名称',
      phEn: 'e.g. Dry Fruit 果干', phCn: '例如:Dry Fruit 果干',
      value: typed,
      submitEn: 'Add supplier', submitCn: '添加',
      cancelEn: 'Cancel', cancelCn: '取消',
    });
    const name = String(answer == null ? '' : answer).trim();
    if (!name) return;
    const already = _suppliers.find(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase());
    if (already) { matSupSet(already.name); toast(T('Already in your supplier book — set on this material.', '该供应商已在名录中 —— 已设为本物料供应商。')); return; }
    try {
      const j = await api('/api/retail-admin/suppliers', { method: 'POST', body: { name } });
      _suppliers.push({ id: j.id, name, is_active: 1 });
      _suppliers.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      matSupSet(name);
      toast(T('Supplier added', '已添加供应商'));
    } catch (e) {
      // name_taken means the book already holds it — as an ARCHIVED supplier,
      // which is why it wasn't in the list we loaded. Setting the name is
      // still right: that is the name every supplier screen groups by.
      if (e.code === 'name_taken') {
        matSupSet(name);
        toast(T('That supplier already exists (archived) — set on this material.', '该供应商已存在(已归档)—— 已设为本物料供应商。'));
        return;
      }
      toast(T('Could not add supplier', '添加供应商失败') + ': ' + (e.message || ''), 'err');
    }
  };

  function paintRecord() {
    const host = recRoot();
    if (!host || !_rec) return;
    const m = _rec.row;
    const isNew = !m.id;
    const kindOpts = (_kinds.length ? _kinds : ['food', 'packaging', 'equipment', 'retail', 'other'])
      .map(k => [k, kindLabel(k)]);
    const catOpts = [['', T('None', '无')]].concat(_cats.map(c => [c, c]));

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
              ${field(T('Category', '分类'), select('category', m.category, catOpts, 'matSkuPreview()'))}
              ${/* onblur, not oninput: a {NAME:3} pattern makes the suggested code
                    depend on this field, and a request per keystroke would be
                    both wasteful and jumpy. */''}
              ${field(T('Name (English)', '名称(英文)'), input('name_en', m.name_en, 'maxlength="120" onblur="matSkuPreview()"'))}
              ${field(T('Name (中文)', '名称(中文)'), input('name_cn', m.name_cn, 'maxlength="120"'))}
              ${/* The SKU carries a live line of its own (#mat-sku-note) under
                    the standing hint: on a NEW material with the field empty it
                    shows the code the tenant's rules would issue, and on a typed
                    one it flags a code that does not match that category's
                    scheme. Both are ADVISORY — see matSkuPreview(). */''}
              ${field(T('SKU', '货号'), input('sku', m.sku, 'maxlength="60"', 'matSkuTyped()')
                       + '<span class="mat-skunote" id="mat-sku-note"></span>',
                       T('Kept forever, even after archiving — so old orders keep pointing at the right thing.', '归档后仍永久保留 — 以免历史订单指向错误。'))}
              ${field(T('Finance category', '财务分类'),
                       `<div class="mat-combo-wrap">`
                       + input('accounting_category', m.accounting_category,
                               'maxlength="80" autocomplete="off" role="combobox" aria-expanded="false"'
                               + ' aria-autocomplete="list" aria-controls="mat-combo-menu"'
                               + ' onfocus="matComboOpen(\'accounting_category\')"'
                               + ' onkeydown="matComboKey(event,\'accounting_category\')"'
                               + ' onblur="matComboBlur(\'accounting_category\')"',
                               'matComboOpen(\'accounting_category\')')
                       + `<button type="button" class="mat-combo-caret" tabindex="-1" aria-hidden="true"`
                       + ` onmousedown="matComboToggle(event,'accounting_category')">${I.chevDown}</button>`
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
              ${/* The one field an editor without materials:costs does not get.
                    Everything around it stays: units, pack size and contents
                    are what somebody holding the sack is best placed to
                    correct, and they are measurements rather than money. The
                    server carries the stored price through on save, so editing
                    a name here cannot wipe it. */''}
              ${showMoney() ? field(T('Buy price', '采购价'), input('buy_price', m.buy_price, 'type="number" min="0" step="any"', 'matPreviewCost()'),
                       T('What one pack costs.', '一包的价格。')) : ''}
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
            <div class="mat-combo-wrap">
              <input class="mat-input" id="mat-f-supplier" value="${esc(m.supplier == null ? '' : m.supplier)}"
                maxlength="160" autocomplete="off" role="combobox" aria-expanded="false"
                aria-autocomplete="list" aria-controls="mat-combo-menu"
                placeholder="${esc(T('Type to search your suppliers', '输入以搜索供应商'))}"
                oninput="matDirty();matSupNote();matComboOpen('supplier')"
                onfocus="matComboOpen('supplier')"
                onkeydown="matComboKey(event,'supplier')"
                onblur="matComboBlur('supplier')">
              <button type="button" class="mat-combo-caret" tabindex="-1" aria-hidden="true"
                onmousedown="matComboToggle(event,'supplier')">${I.chevDown}</button>
            </div>
            <div class="mat-supnote" id="mat-supnote">${supNoteHtml(m.supplier)}</div>
            <div class="mat-supacts">
              <button class="mat-btn sm" data-cap="purchasing:edit" onclick="matSupNew()"><span class="mat-ic">${I.plus}</span>${esc(T('New supplier', '新建供应商'))}</button>
            </div>
          </div>
          ${/* Cost history is nothing but prices, so the whole block goes for
                an operator without materials:costs — rather than rendering
                "No price changes recorded", which would be a lie about a
                material that has changed price twenty times. Bought in stays:
                which POs a material arrived on, when and how many is
                purchasing history, and only its money is withheld. */''}
          ${isNew ? '' : `
          ${showMoney() ? `<div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Cost history', '价格历史'))}</h3>
            ${histHtml()}
          </div>` : ''}
          <div class="mat-card mat-blk">
            <h3 class="mat-blk-h">${esc(T('Bought in', '采购记录'))}</h3>
            ${purchHtml()}
          </div>`}
        </div>
      </div>`;
    try { applyCapGates(); } catch (_) {}
    // The suggested code, once the fields it reads exist. Fire-and-forget: it
    // paints a hint and nothing on this screen waits for it.
    try { matSkuPreview(); } catch (_) {}
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
    // Without materials:costs the FIGURE goes and the DIAGNOSIS stays. "This
    // pack has no recorded contents" is the sentence that gets a material
    // costed at all, and it is about pack maths, not money — withholding it
    // would leave the person best placed to fix the gap unable to see it.
    // (The server also strips `cpu`, so there is nothing to print either way.)
    if (!showMoney()) {
      if (d.cpu !== null) return '';
      // fall through to the reason lines below
    }
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  THE AUTOMATIC SKU (Ash, 2026-09-04)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Settings → SKU codes holds the tenant's numbering rules; the server issues
  // the code when the material is saved with the field blank. What happens HERE
  // is only ever advisory, and deliberately so:
  //
  //   • On a NEW material with an empty SKU, the code the rules would issue is
  //     shown as the field's placeholder and spelled out underneath. It is a
  //     PEEK — nothing is claimed, so opening the form, changing the category
  //     four times and closing it burns no codes and leaves no gaps.
  //   • On a TYPED SKU, a code that does not fit that category's pattern is
  //     flagged and saved anyway. A supplier's own article number is a real
  //     reason to override, and refusing it would make the scheme the enemy of
  //     the catalogue.
  //   • On an EXISTING material, nothing is suggested at all. Renumbering what
  //     is already coded is what would break historical orders and reports.
  //
  // The preview the operator sees is not a promise: a concurrent save can take
  // the number in between, so the create response carries the code actually
  // issued and matSave() paints that.
  let _skuRule = null;      // the last /sku/material/next answer
  let _skuSeq = 0;          // request sequencer — a slow answer must not overwrite a fast later one

  function skuNoteEl() { return document.getElementById('mat-sku-note'); }
  function skuFieldEl() { return document.getElementById('mat-f-sku'); }

  window.matSkuPreview = async function () {
    const note = skuNoteEl();
    const field = skuFieldEl();
    if (!note || !field || !_rec) return;
    // An existing material keeps the code it has. Nothing to suggest, and the
    // mismatch flag below still applies if the operator edits it.
    if (_rec.row.id) { _skuRule = null; matSkuTyped(); return; }
    if (String(field.value || '').trim()) { matSkuTyped(); return; }

    const mine = ++_skuSeq;
    try {
      const q = new URLSearchParams({
        category: val('item_kind') || 'food',
        subcategory: val('category') || '',
        name: val('name_en') || '',
      });
      const j = await api('/api/retail-admin/sku/material/next?' + q.toString());
      if (mine !== _skuSeq) return;                       // a newer request has since answered
      _skuRule = j && j.ok ? j : null;
      if (!_skuRule) {
        field.placeholder = '';
        note.className = 'mat-skunote';
        note.textContent = j && j.reason === 'disabled'
          ? T('Automatic SKUs are off — type one, or leave it blank.', '自动编码已关闭 —— 可手动填写或留空。')
          : '';
        return;
      }
      field.placeholder = _skuRule.sku;
      note.className = 'mat-skunote is-auto';
      note.textContent = T(
        `Will be saved as ${_skuRule.sku} — type your own to override.`,
        `将自动生成为 ${_skuRule.sku} —— 如需自定义请直接输入。`);
    } catch (_) {
      // A preview that cannot be fetched is silence, never an error banner: the
      // save works either way, and the server issues the code regardless.
      if (mine === _skuSeq) { _skuRule = null; note.textContent = ''; }
    }
  };

  // Typed into the SKU field. Blank → back to showing the suggestion; filled →
  // check it against the pattern for this category and say so if it does not
  // fit. The regex comes from the server (lib/sku-format.js matchRegexSource),
  // so the check and the generator can never disagree about what a token means.
  window.matSkuTyped = function () {
    const note = skuNoteEl();
    const field = skuFieldEl();
    if (!note || !field) return;
    const typed = String(field.value || '').trim();
    if (!typed) { note.textContent = ''; note.className = 'mat-skunote'; matSkuPreview(); return; }
    if (!_skuRule || !_skuRule.match_re) { note.textContent = ''; note.className = 'mat-skunote'; return; }
    let fits = true;
    try { fits = new RegExp(_skuRule.match_re).test(typed.toUpperCase()); } catch (_) { return; }
    note.className = 'mat-skunote' + (fits ? ' is-auto' : ' is-warn');
    // The message names an EXAMPLE, never the pattern behind it — `{SUB}{SEQ:4}`
    // means nothing to the person holding the sack, and this line exists to be
    // understood at a glance rather than decoded.
    note.textContent = fits
      ? T('Matches this category\'s codes.', '符合此分类的编码规则。')
      : T(`Saved as typed. Codes in this category normally look like ${_skuRule.sku}.`,
          `将按输入内容保存。此分类的编码通常形如 ${_skuRule.sku}。`);
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
        ${/* The PO, the day and how many stay; what it cost does not. Losing
              the whole line would take away the useful half — "this arrived on
              RPO-0042 on the 14th, 20kg" is the answer somebody checking a
              delivery actually wants. */''}
        <span class="mat-sub2">${esc((r.date || '').slice(0, 10))} · ${esc(String(r.qty || 0))} ${esc(r.unit || '')}${showMoney() && r.total_cost != null ? ' · ' + money(r.total_cost) : ''}</span>
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
        // The server issues the code, not the preview: a concurrent save can
        // take the number the form was showing, so what came back is what this
        // material is actually called.
        if (j.sku) _rec.row.sku = j.sku;
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
