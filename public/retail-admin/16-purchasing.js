/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 16.  Rebuilt 2026-07-11 (Tacet "quiet ledger").
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, cuT, applyCapGates, prodShowView…) live in 01-core.js.

   Purchasing — the store's buying department — now lives INSIDE Products as a
   sub-view (#prod-view-purchasing, beside Categories). The whole surface is
   painted here into #pu2-root; screens swap inside that one node:
     orders   — the quiet ledger (Option A from the locked mockup)
     wizard   — new / edit order, three small steps
     receive  — one PO: tick in what arrived → stock + Finance
     suppliers— the supplier ledger
     supplier — one supplier: form + paperwork + their orders
     import   — bring suppliers in from a spreadsheet (CSV)

   Design rules (tacet-tokens): colour is status, never decoration; the ONLY
   Dusk on any screen is the two automations (cost posts to Finance by itself,
   counts go into stock by itself). Status words are written for humans —
   Requested→Draft, Ordered→Ordered, Delivered→Received — while the wire values
   the server speaks are unchanged.

   Endpoints: /api/retail-admin/suppliers* + /api/retail-admin/purchases*
   (routes/retail-purchasing.js) + /api/retail-admin/stores* (retail-inventory). */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
  const money = n => '¥' + fmt(Number(n) || 0);
  // "Today" in the store's clock (GZ = UTC+8) so a delivery due today never
  // reads as late just because the browser is on UTC.
  const todayGz = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // ── module state ──────────────────────────────────────────────────────────
  let _init = false;
  let _langHooked = false;
  let _stores = [];          // active retail_stores
  let _suppliers = [];       // supplier rows (active; +disabled when asked)
  let _showDisabled = false;
  let _pos = [];             // PO header rows
  const _prodCache = {};     // storeId → stock rows (picker + suggestions)
  let _hist = {};            // store_product_id → last-paid, for the open PO
  const _supCache = {};      // store_product_id → { suppliers[], last } price list
  let _pickP = null;         // product the supplier popover is open for
  let _pickInfo = null;      // its loaded price list
  let _screen = 'orders';    // orders | wizard | receive | suppliers | supplier | import
  let _seg = 'open';         // orders segment: open | received | all
  let _supSeg = 'active';    // suppliers segment: active | disabled
  let _edit = null;          // draft PO in the wizard
  let _wstep = 1;            // wizard step 1..3
  let _po = null;            // PO open on the receive screen
  let _sup = null;           // supplier open on the form
  let _imp = null;           // parsed CSV preview { rows, headers }

  const root = () => document.getElementById('pu2-root');

  // ── icons (monochrome line SVG — never emoji) ─────────────────────────────
  const I = {
    plus:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    back:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
    check:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
    up:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
    down:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    box:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>',
    send:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    star:   '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2.9 6.3 6.8.6-5.1 4.5 1.5 6.7L12 17l-6 3.6 1.5-6.7-5.1-4.5 6.8-.6z"/></svg>',
  };

  // ── status → plain word + pill tone ───────────────────────────────────────
  function statusWord(status) {
    return ({
      Requested: T('Draft', '草稿'),
      Ordered:   T('Ordered', '已下单'),
      Delivered: T('Received', '已收货'),
      Cancelled: T('Cancelled', '已取消'),
    })[status] || status;
  }
  function isLate(p) {
    return p.status === 'Ordered' && p.delivery_date && p.delivery_date < todayGz();
  }
  function statusPill(p) {
    if (isLate(p)) return `<span class="pu2-pill amber"><span class="dot"></span>${esc(T('Late', '已逾期'))}</span>`;
    if (p.status === 'Delivered') return `<span class="pu2-pill sage"><span class="dot"></span>${esc(statusWord(p.status))}</span>`;
    if (p.status === 'Ordered')   return `<span class="pu2-pill grey"><span class="dot"></span>${esc(statusWord(p.status))}</span>`;
    return `<span class="pu2-pill grey">${esc(statusWord(p.status))}</span>`;
  }
  const storeLabel = p => esc([p.store_name_en, p.store_name_cn].filter(Boolean).join(' · ') || '—');
  const nameLabel = it => esc([it.name_en, it.name_cn].filter(Boolean).join(' · ') || '—');

  // ── entry (idempotent — prodShowView calls this every time the tab opens) ──
  window.puInit = async function () {
    if (!root()) return;
    if (!_langHooked && window.onLangChange) { _langHooked = true; onLangChange(() => paint()); }
    if (_init) { refresh(); return; }
    _init = true;
    root().innerHTML = `<div class="pu2-loading">${esc(T('Loading…', '加载中…'))}</div>`;
    await Promise.all([loadStores(), loadSuppliers(), loadPOs()]);
    _screen = 'orders';
    paint();
  };
  async function refresh() {
    try { await Promise.all([loadSuppliers(), loadPOs()]); } catch (_) {}
    if (_screen === 'orders' || _screen === 'suppliers') paint();
  }

  async function loadStores() {
    try {
      const r = await api('/api/retail-admin/stores');
      _stores = (r.data || []).filter(s => s.is_active);
    } catch (e) { _stores = []; }
  }
  async function loadSuppliers() {
    try {
      const r = await api('/api/retail-admin/suppliers' + (_showDisabled ? '?all=1' : ''));
      _suppliers = r.data || [];
    } catch (e) { _suppliers = []; }
  }
  async function loadPOs() {
    try {
      const r = await api('/api/retail-admin/purchases');
      _pos = r.data || [];
    } catch (e) { _pos = []; }
  }
  async function products(storeId) {
    if (!_prodCache[storeId]) {
      const r = await api('/api/retail-admin/stores/' + storeId + '/stock');
      _prodCache[storeId] = r.data || [];
    }
    return _prodCache[storeId];
  }
  // The per-product supplier price list (who sells it, what we paid last time).
  // Cached per product; a product never bought before returns { suppliers: [] }.
  async function loadProductSuppliers(spid) {
    if (_supCache[spid]) return _supCache[spid];
    try {
      const r = await api('/api/retail-admin/products/' + spid + '/suppliers');
      _supCache[spid] = r.data || { suppliers: [] };
    } catch (_) { _supCache[spid] = { suppliers: [] }; }
    return _supCache[spid];
  }

  // ── paint dispatch ────────────────────────────────────────────────────────
  function paint() {
    if (!root()) return;
    if (_screen === 'orders')     paintOrders();
    else if (_screen === 'wizard')    paintWizard();
    else if (_screen === 'receive')   paintReceive();
    else if (_screen === 'suppliers') paintSuppliers();
    else if (_screen === 'supplier')  paintSupplier();
    else if (_screen === 'import')    paintImport();
    try { applyCapGates(); } catch (_) {}
  }

  function backBtn(label, fn) {
    return `<button class="pu2-btn ghost sm" onclick="${fn}"><span class="pu2-ic">${I.back}</span>${esc(label)}</button>`;
  }

  // ── Tacet page-head + sub-nav (replaces the dead Full Circle .pa-pagetitle) ──
  // Rendered at the top of every ledger screen so Purchasing carries its own
  // Tacet identity. Tabs grow as screens ship (Bills / Reorder land next).
  const PU_TABS = [
    ['orders',    () => T('Orders', '采购单')],
    ['suppliers', () => T('Suppliers', '供应商')],
  ];
  function puChrome(active) {
    const meta = {
      orders:    [T('Orders', '采购单'),   T('Order goods from your suppliers. When a delivery arrives, tick it in — stock and expenses update by themselves.', '向供应商采购商品。到货时勾选收货 —— 库存和支出会自动更新。')],
      suppliers: [T('Suppliers', '供应商'), T('Who you buy from — contacts, payment terms and their paperwork, all in one place.', '你的供货来源 —— 联系人、付款条件和资质文件,集中在一处。')],
    };
    const [title, sub] = meta[active] || meta.orders;
    const tabs = PU_TABS.map(([key, label]) =>
      `<button class="pu2-tab${active === key ? ' on' : ''}" onclick="puTab('${key}')">${esc(label())}</button>`).join('');
    return `
      <div class="pu2-pagehead">
        <div class="pu2-eyebrow">${esc(T('Purchasing', '采购'))}</div>
        <h1 class="pu2-title">${esc(title)}</h1>
        <p class="pu2-sub">${esc(sub)}</p>
      </div>
      <nav class="pu2-subnav">${tabs}</nav>`;
  }
  window.puTab = function (tab) {
    if (tab === 'suppliers') { _screen = 'suppliers'; _supSeg = 'active'; _showDisabled = false; }
    else { _screen = 'orders'; }
    paint();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  ORDERS — the quiet ledger
  // ═══════════════════════════════════════════════════════════════════════════
  function segRows() {
    return _pos.filter(p => {
      if (_seg === 'open')     return p.status === 'Requested' || p.status === 'Ordered';
      if (_seg === 'received') return p.status === 'Delivered';
      return true;
    });
  }
  function paintOrders() {
    const openN = _pos.filter(p => p.status === 'Requested' || p.status === 'Ordered').length;
    const rcvN  = _pos.filter(p => p.status === 'Delivered').length;
    const lateN = _pos.filter(isLate).length;
    const m = todayGz().slice(0, 7);
    const monthSpend = _pos
      .filter(p => (p.date || '').slice(0, 7) === m && (p.status === 'Ordered' || p.status === 'Delivered'))
      .reduce((s, p) => s + (Number(p.total_cost) || 0), 0);
    const supN = _suppliers.filter(s => s.is_active).length;

    root().innerHTML = `
      ${puChrome('orders')}
      <div class="pu2-statline">
        <button class="pu2-stat link${_seg === 'open' ? ' on' : ''}" onclick="puSeg('open')"><b class="pu2-num">${openN}</b>${esc(T('open', '进行中'))}</button>
        <button class="pu2-stat link warn" onclick="puSeg('open')" ${lateN ? '' : 'style="display:none"'}><b class="pu2-num">${lateN}</b>${esc(T('late', '逾期'))}</button>
        <span class="pu2-stat"><b class="pu2-num">${money(monthSpend)}</b>${esc(T('spent this month', '本月采购'))}</span>
        <button class="pu2-stat link" onclick="puScreenSuppliers()"><b class="pu2-num">${supN}</b>${esc(T('suppliers', '供应商'))}</button>
      </div>

      <div class="pu2-toolbar">
        <span class="pu2-segbar" id="pu2-seg">
          <span class="pu2-seg${_seg === 'open' ? ' on' : ''}" onclick="puSeg('open')">${esc(T('Open', '进行中'))} <span class="n pu2-num">${openN}</span></span>
          <span class="pu2-seg${_seg === 'received' ? ' on' : ''}" onclick="puSeg('received')">${esc(T('Received', '已收货'))} <span class="n pu2-num">${rcvN}</span></span>
          <span class="pu2-seg${_seg === 'all' ? ' on' : ''}" onclick="puSeg('all')">${esc(T('All', '全部'))} <span class="n pu2-num">${_pos.length}</span></span>
        </span>
        <span class="pu2-search">
          <span class="pu2-ic">${I.search}</span>
          <input id="pu2-q" type="text" placeholder="${esc(T('Find an order, supplier or product', '搜索采购单、供应商或商品'))}" oninput="puFilter()" autocomplete="off">
        </span>
        <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puNewOrder()"><span class="pu2-ic">${I.plus}</span>${esc(T('New order', '新建采购单'))}</button>
      </div>

      <div class="pu2-card">
        <table class="pu2-tbl">
          <thead><tr>
            <th>${esc(T('Order', '单号'))}</th>
            <th>${esc(T('Supplier', '供应商'))}</th>
            <th>${esc(T('Store', '门店'))}</th>
            <th class="right">${esc(T('Items', '商品'))}</th>
            <th class="right">${esc(T('Total', '金额'))}</th>
            <th>${esc(T('Arrives', '到货'))}</th>
            <th>${esc(T('Status', '状态'))}</th>
          </tr></thead>
          <tbody id="pu2-rows"></tbody>
        </table>
      </div>`;
    renderOrderRows();
  }

  function renderOrderRows() {
    const body = document.getElementById('pu2-rows');
    if (!body) return;
    const q = (document.getElementById('pu2-q')?.value || '').toLowerCase().trim();
    let rows = segRows();
    if (q) rows = rows.filter(p => `${p.po_number} ${p.supplier || ''}`.toLowerCase().includes(q));

    if (!rows.length) {
      // Empty ledger with no orders at all → the teaching empty state. A filtered
      // empty (search / segment) → a plain one-liner, no lesson needed.
      body.innerHTML = `<tr><td colspan="7">${_pos.length ? emptyLine() : emptyState()}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(p => {
      const arrives = isLate(p)
        ? `<span class="pu2-num" style="color:var(--td-amber-ink)">${esc(p.delivery_date)} — ${esc(T('late', '逾期'))}</span>`
        : `<span class="pu2-num">${esc(p.delivery_date || '—')}</span>`;
      const rcv = p.received_lines ? ` <span class="sub" style="display:inline">· ${p.received_lines} ${esc(T('in', '入库'))}</span>` : '';
      return `<tr onclick="puOpenPO(${p.id})">
        <td><div class="pu2-mono">${esc(p.po_number)}</div><div class="sub pu2-num">${esc(p.date || '')}</div></td>
        <td>${esc(p.supplier || T('No supplier', '未指定供应商'))}</td>
        <td>${storeLabel(p)}</td>
        <td class="right pu2-num">${p.line_count || 0}${rcv}</td>
        <td class="right pu2-num">${money(p.total_cost)}</td>
        <td>${arrives}</td>
        <td>${statusPill(p)}</td>
      </tr>`;
    }).join('');
  }
  function emptyLine() {
    return `<div class="pu2-emptyline">${esc(T('Nothing here — try another filter.', '这里没有内容——换个筛选试试。'))}</div>`;
  }
  function emptyState() {
    return `<div class="pu2-empty">
      <div class="pu2-empty-ico">${I.box}</div>
      <h3>${esc(T('No orders yet', '还没有采购单'))}</h3>
      <p>${esc(T('An order is a list of what you’re buying from one supplier for one store. Tacet does the bookkeeping for you.', '一张采购单就是你向某个供应商、为某家门店采购的清单。记账的事交给 Tacet。'))}</p>
      <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puNewOrder()">${esc(T('Start your first order', '创建第一张采购单'))}</button>
      <div class="pu2-empty-steps">
        <div class="pu2-empty-step"><div class="ico">${I.plus}</div><b>${esc(T('1 · Build it', '1 · 建单'))}</b>${esc(T('Pick a supplier and add products — running-low items are suggested for you.', '选择供应商并添加商品——库存偏低的会自动推荐。'))}</div>
        <div class="pu2-empty-step"><div class="ico">${I.send}</div><b>${esc(T('2 · Place it', '2 · 下单'))}</b>${esc(T('Mark it ordered. The cost posts to Finance on its own.', '标记已下单,采购金额会自动记入财务。'))}</div>
        <div class="pu2-empty-step"><div class="ico">${I.check}</div><b>${esc(T('3 · Tick it in', '3 · 收货'))}</b>${esc(T('When the boxes arrive, confirm the counts — stock updates everywhere.', '到货时确认数量——库存自动同步到各处。'))}</div>
      </div>
    </div>`;
  }

  window.puSeg = function (seg) {
    _seg = seg;
    document.querySelectorAll('#pu2-seg .pu2-seg').forEach((el, i) => {
      el.classList.toggle('on', ['open', 'received', 'all'][i] === seg);
    });
    document.querySelectorAll('.pu2-statline .pu2-stat.link').forEach(el => el.classList.remove('on'));
    renderOrderRows();
  };
  window.puFilter = renderOrderRows;
  window.puScreenSuppliers = function () { _screen = 'suppliers'; paint(); };

  // ═══════════════════════════════════════════════════════════════════════════
  //  NEW / EDIT ORDER — the three-step wizard
  // ═══════════════════════════════════════════════════════════════════════════
  window.puNewOrder = function () {
    _edit = {
      id: null, po_number: null, date: todayGz(), delivery_date: '',
      supplier: '', store_id: _stores[0]?.id || null, notes: '', items: [],
    };
    _wstep = 1; _screen = 'wizard'; paint();
  };

  window.puOpenPO = async function (id) {
    try {
      const r = await api('/api/retail-admin/purchases/' + id);
      const po = r.data;
      if (po.status === 'Requested') {
        // A draft is still being built → reopen it in the wizard.
        _edit = {
          id: po.id, po_number: po.po_number, date: po.date,
          delivery_date: po.delivery_date || '', supplier: po.supplier || '',
          store_id: po.store_id, notes: po.notes || '',
          items: (po.items || []).map(i => ({
            store_product_id: i.store_product_id, name_en: i.name_en, name_cn: i.name_cn,
            sku: i.sku, qty: i.qty, unit: i.unit, cost_per_unit: i.cost_per_unit,
            expense_category: i.expense_category || '', purchase_channel: i.purchase_channel || '',
            supplier_name: i.supplier_name || '', current_stock: i.current_stock,
          })),
        };
        _wstep = 2; _screen = 'wizard'; paint();
      } else {
        // Placed / received / cancelled → the receive & manage screen.
        _po = po; _hist = {}; _screen = 'receive'; paint();
        api('/api/retail-admin/purchases/' + id + '/history')
          .then(h => { _hist = h.data || {}; if (_screen === 'receive' && _po && _po.id === id) paint(); })
          .catch(() => {});
      }
    } catch (e) { toast(e.message, 'err'); }
  };

  function paintWizard() {
    const e = _edit;
    const step = _wstep;
    const dot = n => (n < step
      ? `<span class="st done"><span class="n">${I.check}</span>${wStepName(n)}</span>`
      : `<span class="st${n === step ? ' on' : ''}"><span class="n">${n}</span>${wStepName(n)}</span>`);
    root().innerHTML = `
      <div class="pu2-wizhead">
        ${backBtn(T('Orders', '采购单'), 'puBackOrders()')}
        <h1>${e.id ? esc(e.po_number) : esc(T('New order', '新建采购单'))}</h1>
        <div class="pu2-wsteps">
          ${dot(1)}<span class="dash"></span>${dot(2)}<span class="dash"></span>${dot(3)}
        </div>
      </div>
      <div id="pu2-wizbody"></div>`;
    if (step === 1) wizStep1();
    else if (step === 2) wizStep2();
    else wizStep3();
  }
  function wStepName(n) {
    return esc([T('From & to', '来源与门店'), T('What to buy', '采购内容'), T('Review & place', '确认下单')][n - 1]);
  }

  function supplierOptions(selected) {
    return `<option value="">${esc(T('No supplier — mixed / one-off', '不指定 —— 混合/一次性'))}</option>` + _suppliers
      .filter(s => s.is_active || s.name === selected)
      .map(s => `<option value="${esc(s.name)}"${s.name === selected ? ' selected' : ''}>${esc(s.name)}${s.name_cn ? ' · ' + esc(s.name_cn) : ''}</option>`)
      .join('');
  }
  function storeOptions(selected) {
    return _stores.map(s => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${esc(s.name_en || s.code)}${s.name_cn ? ' · ' + esc(s.name_cn) : ''}</option>`).join('');
  }

  function wizStep1() {
    const e = _edit;
    document.getElementById('pu2-wizbody').innerHTML = `
      <div class="pu2-card pu2-wizcard">
        <div class="pu2-fgrid">
          <label class="pu2-f">
            <span class="lbl">${esc(T('Supplier', '供应商'))}</span>
            <select class="pu2-input" id="pu2-w-supplier">${supplierOptions(e.supplier)}</select>
            <span class="hint">${esc(T('Optional — leave empty for a mixed or one-off buy.', '可选 —— 混合或一次性采购可留空。'))}</span>
          </label>
          <label class="pu2-f">
            <span class="lbl">${esc(T('Deliver to', '收货门店'))}</span>
            <select class="pu2-input" id="pu2-w-store">${storeOptions(e.store_id)}</select>
          </label>
          <label class="pu2-f">
            <span class="lbl">${esc(T('Expected arrival', '预计到货'))}</span>
            <input class="pu2-input" type="date" id="pu2-w-delivery" value="${esc(e.delivery_date || '')}">
            <span class="hint">${esc(T('We’ll flag the order if this date passes.', '超过该日期后,订单会被标记逾期。'))}</span>
          </label>
          <label class="pu2-f">
            <span class="lbl">${esc(T('Note', '备注'))}</span>
            <input class="pu2-input" type="text" id="pu2-w-notes" value="${esc(e.notes || '')}" placeholder="${esc(T('Anything the receiver should know', '收货人需要知道的信息'))}">
          </label>
        </div>
        <div class="pu2-wizfoot">
          <button class="pu2-btn ghost" onclick="puBackOrders()">${esc(T('Cancel', '取消'))}</button>
          <span class="spacer"></span>
          <button class="pu2-btn primary" onclick="puWizNext(2)">${esc(T('Next — what to buy', '下一步 —— 采购内容'))}</button>
        </div>
      </div>`;
  }

  // read step-1 fields off the DOM into state (called on every step change)
  function grabStep1() {
    const g = id => document.getElementById(id);
    if (g('pu2-w-supplier')) _edit.supplier = g('pu2-w-supplier').value || '';
    if (g('pu2-w-store'))    _edit.store_id = parseInt(g('pu2-w-store').value, 10) || _edit.store_id;
    if (g('pu2-w-delivery')) _edit.delivery_date = g('pu2-w-delivery').value || '';
    if (g('pu2-w-notes'))    _edit.notes = g('pu2-w-notes').value || '';
  }

  window.puWizNext = function (n) {
    if (_wstep === 1) grabStep1();
    _wstep = n; paintWizard();
  };
  window.puWizStep = function (n) { _wstep = n; paintWizard(); };
  window.puBackOrders = function () { _edit = null; _screen = 'orders'; paint(); };

  function wizStep2() {
    const e = _edit;
    const st = _stores.find(s => s.id === e.store_id);
    const storeName = st ? (st.name_en || st.code) : '';
    document.getElementById('pu2-wizbody').innerHTML = `
      <div class="pu2-card pu2-wizcard pu2-recap">
        <span>${esc(T('Supplier', '供应商'))}: <b>${esc(e.supplier || T('none', '不指定'))}</b></span>
        <span>${esc(T('Deliver to', '收货'))}: <b>${esc(storeName)}</b></span>
        <span>${esc(T('Expected', '预计'))}: <b class="pu2-num">${esc(e.delivery_date || '—')}</b></span>
        <button class="pu2-link" onclick="puWizStep(1)">${esc(T('Change', '修改'))}</button>
      </div>

      <div class="pu2-card pu2-wizcard">
        <div class="pu2-f" style="max-width:520px;position:relative">
          <span class="lbl">${esc(T('Add products', '添加商品'))}</span>
          <span class="pu2-search full">
            <span class="pu2-ic">${I.search}</span>
            <input id="pu2-picker" type="text" placeholder="${esc(T('Search by name or SKU', '按名称或货号搜索'))}" oninput="puPickerInput()" autocomplete="off">
          </span>
          <div id="pu2-picker-list" class="pu2-picker-list" style="display:none"></div>
        </div>

        <div id="pu2-suppop" class="pu2-suppop" style="display:none"></div>

        <div id="pu2-suggest"></div>

        <table class="pu2-tbl pu2-lines" style="margin-top:18px">
          <thead><tr>
            <th>${esc(T('Product', '商品'))}</th>
            <th class="right">${esc(T('On shelf', '现库存'))}</th>
            <th>${esc(T('Quantity', '数量'))}</th>
            <th class="right">${esc(T('Cost each', '单价'))}</th>
            <th class="right">${esc(T('Line total', '小计'))}</th>
            <th></th>
          </tr></thead>
          <tbody id="pu2-linebody"></tbody>
        </table>

        <div class="pu2-wizfoot">
          <button class="pu2-btn ghost" onclick="puWizStep(1)">${esc(T('Back', '上一步'))}</button>
          <span class="spacer"></span>
          <button class="pu2-btn" onclick="puSaveDraft()">${esc(T('Save as draft', '存为草稿'))}</button>
          <button class="pu2-btn primary" onclick="puWizNext(3)">${esc(T('Review order', '确认订单'))}</button>
        </div>
      </div>`;
    renderLines();
    renderSuggestions();
  }

  async function renderSuggestions() {
    const host = document.getElementById('pu2-suggest');
    if (!host) return;
    let list = [];
    try { list = await products(_edit.store_id); } catch (_) { return; }
    const have = new Set(_edit.items.map(it => it.store_product_id));
    const low = list
      .filter(p => !have.has(p.product_id))
      .map(p => ({ p, gap: (p.safety_buffer > 0 ? p.safety_buffer : 5) - p.physical_qty }))
      .filter(x => x.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 4);
    if (!low.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="pu2-kicker">${esc(T('Running low here', '此门店库存偏低'))}</div>
      ${low.map(({ p }) => `
        <div class="pu2-sugrow">
          <span>${nameLabel(p)}</span>
          <span class="low pu2-num">${p.physical_qty} ${esc(T('left', '剩余'))}${p.safety_buffer > 0 ? ` · ${esc(T('buffer', '安全库存'))} ${p.safety_buffer}` : ''}</span>
          <button class="pu2-btn sm" onclick="puPick(${p.product_id})">${esc(T('Add', '添加'))}</button>
        </div>`).join('')}`;
  }

  function renderLines() {
    const body = document.getElementById('pu2-linebody');
    if (!body) return;
    if (!_edit.items.length) {
      body.innerHTML = `<tr class="pu2-noline"><td colspan="6">${esc(T('No products yet — search or pick a suggestion above.', '还没有商品——在上方搜索或选择推荐。'))}</td></tr>`;
      return;
    }
    body.innerHTML = _edit.items.map((it, i) => {
      const lineTotal = (parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0);
      const supLabel = it.supplier_name ? esc(it.supplier_name) : esc(T('Choose supplier', '选择供应商'));
      return `<tr>
        <td>${nameLabel(it)}${it.sku ? `<div class="sub pu2-mono">${esc(it.sku)}</div>` : ''}
          <div class="pu2-supline"><span class="pu2-supchip" onclick="puPick(${it.store_product_id})">${supLabel} <span class="swap">▾</span></span></div></td>
        <td class="right pu2-num" style="color:var(--td-text2)">${it.current_stock != null ? it.current_stock : '—'}</td>
        <td>
          <span class="pu2-qty">
            <button type="button" class="pm" onclick="puQty(${i},-1)">−</button>
            <input type="number" min="0" step="1" class="pu2-num" value="${esc(it.qty ?? 1)}" onchange="puLine(${i},'qty',this.value)">
            <button type="button" class="pm" onclick="puQty(${i},1)">+</button>
          </span>
        </td>
        <td class="right">
          <span class="pu2-costwrap">¥<input type="number" min="0" step="0.01" class="pu2-cost pu2-num" value="${esc(it.cost_per_unit ?? 0)}" onchange="puLine(${i},'cost_per_unit',this.value)"></span>
          ${lastPaid(it)}
        </td>
        <td class="right pu2-num">${money(lineTotal)}</td>
        <td class="right"><button class="pu2-btn ghost sm" title="${esc(T('Remove', '移除'))}" onclick="puRemoveLine(${i})">✕</button></td>
      </tr>`;
    }).join('');
    const total = _edit.items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0), 0);
    const units = _edit.items.reduce((s, it) => s + (parseFloat(it.qty) || 0), 0);
    body.insertAdjacentHTML('beforeend', `
      <tr class="pu2-totrow">
        <td colspan="4">${_edit.items.length} ${esc(T('products', '商品'))} · ${units} ${esc(T('units', '件'))}</td>
        <td class="right pu2-num">${money(total)}</td><td></td>
      </tr>`);
  }
  function lastPaid(it) {
    const h = _hist[it.store_product_id];
    if (!h || !h.previous) return '';
    const last = parseFloat(h.previous.cost_per_unit);
    const cur = parseFloat(it.cost_per_unit) || 0;
    if (cur > last + 1e-9) {
      return `<div class="pu2-lasthint pu2-num pricewarn">▲ ${esc(T('was', '上次'))} ${money(last)}</div>`;
    }
    return `<div class="pu2-lasthint pu2-num">${esc(T('last paid', '上次'))} ${money(last)}</div>`;
  }

  window.puLine = function (i, field, val) {
    if (!_edit || !_edit.items[i]) return;
    _edit.items[i][field] = val;
    renderLines();
  };
  window.puQty = function (i, delta) {
    if (!_edit || !_edit.items[i]) return;
    _edit.items[i].qty = Math.max(0, (parseFloat(_edit.items[i].qty) || 0) + delta);
    renderLines();
  };
  window.puRemoveLine = function (i) {
    if (!_edit) return;
    _edit.items.splice(i, 1);
    renderLines(); renderSuggestions();
  };

  let _pickT = null;
  window.puPickerInput = function () {
    clearTimeout(_pickT);
    _pickT = setTimeout(async () => {
      const q = (document.getElementById('pu2-picker')?.value || '').toLowerCase().trim();
      const list = document.getElementById('pu2-picker-list');
      if (!list) return;
      if (!q) { list.style.display = 'none'; return; }
      let prods = [];
      try { prods = await products(_edit.store_id); } catch (e) { toast(e.message, 'err'); return; }
      const hits = prods.filter(p => `${p.name_en || ''} ${p.name_cn || ''} ${p.sku || ''}`.toLowerCase().includes(q)).slice(0, 30);
      list.innerHTML = hits.length
        ? hits.map(p => `<div class="pu2-pick" onclick="puPick(${p.product_id})">${nameLabel(p)}<span class="sub pu2-mono">${esc(p.sku || '')} · ${esc(T('stock', '库存'))} ${p.physical_qty}</span></div>`).join('')
        : `<div class="pu2-pick muted">${esc(T('No match', '无匹配'))}</div>`;
      list.style.display = '';
    }, 150);
  };
  // Picking a product (from search or a suggestion, or tapping a line's supplier
  // chip) opens the supplier popover: who sells it and what we paid last time.
  // With no history it just drops a blank line — no invented vendors.
  window.puPick = async function (productId) {
    const prods = await products(_edit.store_id);
    const p = prods.find(x => x.product_id === productId);
    if (!p) return;
    const pk = document.getElementById('pu2-picker');
    if (pk) pk.value = '';
    const pl = document.getElementById('pu2-picker-list');
    if (pl) pl.style.display = 'none';
    const info = await loadProductSuppliers(productId);
    if (info.last) _hist[productId] = { previous: { cost_per_unit: info.last.cost } };
    _pickP = p; _pickInfo = info;
    if (info.suppliers && info.suppliers.length) renderSupPop();
    else addOrSetLine(p, _edit.supplier || '', null);   // nothing on file → blank line
  };

  // Add the line if new, or just retarget its supplier + price if it's already
  // on the order. Never bumps quantity — that's the steppers' job.
  function addOrSetLine(p, supplierName, cost) {
    let it = _edit.items.find(x => x.store_product_id === p.product_id);
    if (!it) {
      it = {
        store_product_id: p.product_id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku,
        qty: 1, unit: 'pcs', cost_per_unit: 0, expense_category: '门店进货 Retail stock',
        purchase_channel: '', current_stock: p.physical_qty, supplier_name: '',
      };
      _edit.items.push(it);
    }
    it.supplier_name = supplierName || '';
    if (cost != null && cost !== '') it.cost_per_unit = cost;
    puCloseSupPop();
    renderLines(); renderSuggestions();
  }

  function renderSupPop() {
    const host = document.getElementById('pu2-suppop');
    if (!host || !_pickP || !_pickInfo) return;
    const s = _pickInfo.suppliers || [];
    const minCost = s.length ? Math.min(...s.map(x => Number(x.last_cost) || Infinity)) : null;
    host.innerHTML = `
      <div class="pu2-pop">
        <div class="pop-head">
          <b>${nameLabel(_pickP)}</b>
          <span class="sub pu2-mono">${esc(_pickP.sku || '')}${_pickP.sku ? ' · ' : ''}${esc(T('stock', '库存'))} ${_pickP.physical_qty}</span>
          <button class="pu2-link" onclick="puCloseSupPop()">${esc(T('Close', '关闭'))}</button>
        </div>
        ${s.map((x, idx) => {
          const preferred = idx === 0;
          const cheapest = minCost != null && Number(x.last_cost) === minCost && s.length > 1;
          return `<div class="pu2-suprow${preferred ? ' best' : ''}">
            <div class="sname">${esc(x.supplier || T('Unrecorded', '未记录'))}${preferred ? ` <span class="pu2-tagstar">${I.star}${esc(T('Preferred', '常用'))}</span>` : ''}</div>
            <div><div class="lab">${esc(T('Last paid', '上次'))}</div><div class="val pu2-num${cheapest ? ' cheap' : ''}">${money(x.last_cost)}${cheapest ? ' · ' + esc(T('cheapest', '最低')) : ''}</div></div>
            <div><div class="lab">${esc(T('Average', '均价'))}</div><div class="val pu2-num">${x.avg_cost != null ? money(x.avg_cost) : '—'}</div></div>
            <div><div class="lab">${esc(T('Bought', '采购'))}</div><div class="val pu2-num">${x.order_count}× · ${esc(x.last_date || '—')}</div></div>
            <div><button class="pu2-btn sm${preferred ? ' primary' : ''}" onclick="puChooseSupplier(${idx})">${esc(T('Use', '选用'))} ${money(x.last_cost)}</button></div>
          </div>`;
        }).join('')}
        <div class="pu2-suprow manual">
          <div class="sname">${esc(T('Someone else / type it myself', '其他 / 手动填写'))}</div>
          <div class="lab" style="grid-column:2 / 5">${esc(T('Adds the line — set the supplier and price by hand.', '先添加,再手动填写供应商与价格。'))}</div>
          <div><button class="pu2-btn sm" onclick="puChooseSupplier(-1)">${esc(T('Add', '添加'))}</button></div>
        </div>
      </div>`;
    host.style.display = '';
  }

  window.puChooseSupplier = function (idx) {
    if (!_pickP || !_pickInfo) return;
    if (idx < 0) { addOrSetLine(_pickP, _edit.supplier || '', null); return; }
    const x = (_pickInfo.suppliers || [])[idx];
    if (!x) return;
    _hist[_pickP.product_id] = { previous: { cost_per_unit: x.last_cost } };
    addOrSetLine(_pickP, x.supplier || '', x.last_cost);
  };
  window.puCloseSupPop = function () {
    _pickP = null; _pickInfo = null;
    const host = document.getElementById('pu2-suppop');
    if (host) { host.style.display = 'none'; host.innerHTML = ''; }
  };

  function wizStep3() {
    const e = _edit;
    const st = _stores.find(s => s.id === e.store_id);
    const storeName = st ? (st.name_en || st.code) : '';
    const total = e.items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0), 0);
    const units = e.items.reduce((s, it) => s + (parseFloat(it.qty) || 0), 0);
    const empty = !e.items.length;
    document.getElementById('pu2-wizbody').innerHTML = `
      <div class="pu2-card pu2-wizcard">
        <div class="pu2-reviewline">
          ${e.items.length} ${esc(T('products', '商品'))} · ${units} ${esc(T('units', '件'))} · <b class="pu2-num">${money(total)}</b>
          — ${esc(T('from', '来自'))} <b>${esc(e.supplier || T('no supplier', '不指定供应商'))}</b>,
          ${esc(T('to', '送至'))} <b>${esc(storeName)}</b>,
          ${esc(T('expected', '预计'))} <b class="pu2-num">${esc(e.delivery_date || '—')}</b>.
        </div>
        ${empty ? `<p class="pu2-warnline">${esc(T('Add at least one product before placing the order.', '下单前请至少添加一件商品。'))}</p>` : `
        <div class="pu2-autonote">
          <span class="dot"></span>
          <span>${esc(T('When you place the order,', '下单后,'))} <b>${money(total)} ${esc(T('posts to Finance → Expenses by itself.', '会自动记入财务 → 支出。'))}</b> ${esc(T('Nothing touches stock until the goods arrive and you tick them in.', '在到货并勾选收货之前,库存不会有任何变动。'))}</span>
        </div>`}
        <div class="pu2-wizfoot">
          <button class="pu2-btn ghost" onclick="puWizStep(2)">${esc(T('Back', '上一步'))}</button>
          <span class="spacer"></span>
          <button class="pu2-btn" onclick="puSaveDraft()">${esc(T('Save as draft', '存为草稿'))}</button>
          <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puPlace()" ${empty ? 'disabled' : ''}>${esc(T('Place order', '确认下单'))}</button>
        </div>
      </div>`;
  }

  function wizBody() {
    return {
      date: _edit.date || todayGz(),
      delivery_date: _edit.delivery_date || null,
      supplier: _edit.supplier || null,
      store_id: _edit.store_id,
      notes: _edit.notes || null,
      items: _edit.items.map(it => ({
        store_product_id: it.store_product_id, name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
        qty: parseFloat(it.qty) || 0, unit: it.unit || 'pcs',
        cost_per_unit: parseFloat(it.cost_per_unit) || 0,
        expense_category: it.expense_category || null, purchase_channel: it.purchase_channel || null,
        supplier_name: it.supplier_name || null,
      })),
    };
  }
  async function saveWiz(markOrdered) {
    if (_wstep === 1) grabStep1();
    const body = wizBody();
    if (!body.items.length) { toast(T('Add at least one product', '请先添加商品'), 'err'); return null; }
    let id = _edit.id;
    if (id) await api('/api/retail-admin/purchases/' + id, { method: 'PUT', body });
    else { const r = await api('/api/retail-admin/purchases', { method: 'POST', body }); id = r.id; }
    if (markOrdered) await api('/api/retail-admin/purchases/' + id + '/status', { method: 'PUT', body: { status: 'Ordered' } });
    return id;
  }
  window.puSaveDraft = async function () {
    try {
      const id = await saveWiz(false);
      if (id == null) return;
      toast(T('Saved as draft ✓', '已存为草稿 ✓'), 'ok');
      await loadPOs(); puBackOrders();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puPlace = async function () {
    try {
      const id = await saveWiz(true);
      if (id == null) return;
      toast(T('Order placed ✓', '已下单 ✓'), 'ok');
      await loadPOs(); puOpenPO(id);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECEIVE — one PO
  // ═══════════════════════════════════════════════════════════════════════════
  function paintReceive() {
    const p = _po;
    if (!p) { _screen = 'orders'; paint(); return; }
    const canReceive = p.status === 'Ordered' || p.status === 'Delivered';
    const expTotal = (p.expenses || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    root().innerHTML = `
      <div class="pu2-wizhead">
        ${backBtn(T('Orders', '采购单'), 'puBackOrders()')}
        <h1 class="pu2-mono" style="font-size:21px">${esc(p.po_number)}</h1>
        ${statusPill(p)}
      </div>
      <div class="pu2-rcvsub pu2-num">${esc(p.supplier || T('No supplier', '未指定供应商'))} → ${storeLabel(p)} · ${esc(T('placed', '下单'))} ${esc(p.date || '')}${p.delivery_date ? ` · ${esc(T('expected', '预计'))} ${esc(p.delivery_date)}` : ''} · ${money(p.total_cost || (p.items || []).reduce((s, i) => s + (i.qty || 0) * (i.cost_per_unit || 0), 0))}</div>
      ${p.notes ? `<p class="pu2-notes">${esc(p.notes)}</p>` : ''}

      <div class="pu2-card">
        <table class="pu2-tbl pu2-lines">
          <thead><tr>
            <th>${esc(T('Product', '商品'))}</th>
            <th class="right">${esc(T('Ordered', '订购'))}</th>
            <th>${esc(T('Arrived', '实收'))}</th>
            <th>${esc(T('Damaged', '破损'))}</th>
            <th>${esc(T('Tracking no.', '运单号'))}</th>
            <th>${esc(T('Invoice', '发票'))}</th>
            <th class="right">${esc(T('In stock', '已入库'))}</th>
          </tr></thead>
          <tbody>
            ${(p.items || []).map(it => receiveRow(it, canReceive)).join('')}
          </tbody>
        </table>
      </div>

      ${canReceive ? `<div class="pu2-autonote">
        <span class="dot"></span>
        <span><b>${esc(T('Confirmed counts go into', '确认的数量会自动计入'))} ${storeLabel(p)} ${esc(T('stock by themselves', '门店库存'))}</b> ${esc(T('and sync out to every sales channel. Damaged units are kept out of stock.', ',并同步到各销售渠道。破损数量不计入库存。'))}</span>
      </div>` : ''}

      <div class="pu2-actions">
        ${canReceive ? `<button class="pu2-btn primary" data-cap="purchasing:receive" onclick="puReceiveSave()">${esc(T('Confirm delivery', '确认收货'))}</button>` : ''}
        ${p.status === 'Ordered' ? `<button class="pu2-btn" data-cap="purchasing:receive" onclick="puAllArrived()">${esc(T('All arrived as ordered', '全部按订单到货'))}</button>` : ''}
        ${p.status === 'Ordered' ? `<button class="pu2-btn ghost" data-cap="purchasing:edit" onclick="puSetStatus('Requested')">${esc(T('Back to draft', '退回草稿'))}</button>` : ''}
        ${p.status === 'Delivered' ? `<button class="pu2-btn" data-cap="purchasing:edit" onclick="puReorder(${p.id})">${esc(T('Order again', '再次采购'))}</button>` : ''}
        <span class="spacer"></span>
        ${p.status !== 'Cancelled' && p.status !== 'Delivered' ? `<button class="pu2-btn danger" data-cap="purchasing:edit" onclick="puSetStatus('Cancelled')">${esc(T('Cancel order', '取消采购单'))}</button>` : ''}
      </div>

      <div class="pu2-fin">
        <b>${esc(T('Finance', '财务'))}</b>
        ${(p.expenses || []).length
          ? `<div class="pu2-num">${p.expenses.map(x => `${esc(x.category || '')} — ${money(x.amount)}`).join('<br>')}<div class="sub">${esc(T('Posted to Expenses', '已记入支出'))} · ${money(expTotal)}</div></div>`
          : `<div class="sub">${esc(T('Posts to Expenses when the order is placed.', '下单后自动记入支出。'))}</div>`}
      </div>`;
  }
  function receiveRow(it, canReceive) {
    const applied = (it.stock_applied_qty || 0) > 0 ? `✓ ${it.stock_applied_qty}` : '—';
    const dis = canReceive ? '' : 'disabled';
    const priceNote = it.cost_per_unit != null
      ? `${money(it.cost_per_unit)} ${esc(T('each', '每件'))}` : '';
    return `<tr data-line="${it.id}">
      <td>${nameLabel(it)}${priceNote ? `<div class="sub pu2-num">${priceNote}</div>` : ''}</td>
      <td class="right pu2-num">${it.qty} ${esc(it.unit || '')}</td>
      <td><span class="pu2-qty"><input type="number" min="0" step="1" class="pu2-rq pu2-num" placeholder="${it.qty}" value="${it.qty_received != null ? it.qty_received : ''}" ${dis}></span></td>
      <td><span class="pu2-qty"><input type="number" min="0" step="1" class="pu2-rd pu2-num" value="${it.damaged_qty || ''}" ${dis}></span></td>
      <td><input type="text" class="pu2-input pu2-rt" value="${esc(it.tracking_number || '')}" style="width:130px" ${dis}></td>
      <td><select class="pu2-input pu2-ri" ${dis}>
        <option value="not_received"${it.invoice_status === 'not_received' ? ' selected' : ''}>${esc(T('Awaiting', '待收'))}</option>
        <option value="received"${it.invoice_status === 'received' ? ' selected' : ''}>${esc(T('Received', '已收'))}</option>
        <option value="no_invoice"${it.invoice_status === 'no_invoice' ? ' selected' : ''}>${esc(T('None', '无发票'))}</option>
      </select></td>
      <td class="right pu2-num">${applied}${it.current_stock != null ? `<div class="sub">${esc(T('shelf', '现货'))} ${it.current_stock}</div>` : ''}</td>
    </tr>`;
  }

  window.puReceiveSave = async function () {
    if (!_po) return;
    const receipts = [];
    document.querySelectorAll('#pu2-root tr[data-line]').forEach(tr => {
      receipts.push({
        line_id: parseInt(tr.dataset.line, 10),
        qty_received: tr.querySelector('.pu2-rq').value === '' ? null : tr.querySelector('.pu2-rq').value,
        damaged_qty: tr.querySelector('.pu2-rd').value || 0,
        tracking_number: tr.querySelector('.pu2-rt').value,
        invoice_status: tr.querySelector('.pu2-ri').value,
      });
    });
    try {
      const r = await api('/api/retail-admin/purchases/' + _po.id + '/receive', { method: 'PUT', body: { receipts } });
      const bits = [];
      if (r.stock_lines_adjusted) bits.push(T(`stock updated ×${r.stock_lines_adjusted}`, `库存已更新 ×${r.stock_lines_adjusted}`));
      if (r.missing_lines) bits.push(T(`${r.missing_lines} short`, `${r.missing_lines} 短缺`));
      if (r.damaged_lines) bits.push(T(`${r.damaged_lines} damaged`, `${r.damaged_lines} 破损`));
      toast(T('Received ✓', '已收货 ✓') + (bits.length ? ' — ' + bits.join(' · ') : ''), 'ok', 4000);
      puOpenPO(_po.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puAllArrived = function () { puSetStatus('Delivered'); };
  window.puSetStatus = async function (status) {
    if (!_po) return;
    if (status === 'Cancelled' && !confirm(T('Cancel this order?', '确定取消该采购单？'))) return;
    try {
      await api('/api/retail-admin/purchases/' + _po.id + '/status', { method: 'PUT', body: { status } });
      toast(T('Saved ✓', '已保存 ✓'), 'ok');
      await loadPOs(); puOpenPO(_po.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puReorder = async function (id) {
    try {
      const r = await api('/api/retail-admin/purchases/' + id);
      const po = r.data;
      _edit = {
        id: null, po_number: null, date: todayGz(), delivery_date: '',
        supplier: po.supplier || '', store_id: po.store_id || _stores[0]?.id || null, notes: '',
        items: (po.items || []).map(i => ({
          store_product_id: i.store_product_id, name_en: i.name_en, name_cn: i.name_cn, sku: i.sku,
          qty: i.qty, unit: i.unit || 'pcs', cost_per_unit: i.cost_per_unit,
          expense_category: i.expense_category || '', purchase_channel: i.purchase_channel || '',
          current_stock: i.current_stock,
        })),
      };
      _wstep = 2; _screen = 'wizard'; paint();
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  SUPPLIERS — the ledger
  // ═══════════════════════════════════════════════════════════════════════════
  function paintSuppliers() {
    const activeN = _suppliers.filter(s => s.is_active).length;
    const disabledN = _suppliers.filter(s => !s.is_active).length;
    root().innerHTML = `
      ${puChrome('suppliers')}
      <div class="pu2-head">
        <span class="spacer"></span>
        <button class="pu2-btn" data-cap="purchasing:edit" onclick="puImportOpen()"><span class="pu2-ic">${I.up}</span>${esc(T('Import CSV', '导入 CSV'))}</button>
        <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puNewSupplier()"><span class="pu2-ic">${I.plus}</span>${esc(T('New supplier', '新建供应商'))}</button>
      </div>

      <div class="pu2-toolbar">
        <span class="pu2-segbar" id="pu2-supseg">
          <span class="pu2-seg${_supSeg === 'active' ? ' on' : ''}" onclick="puSupSeg('active')">${esc(T('Active', '启用'))} <span class="n pu2-num">${activeN}</span></span>
          <span class="pu2-seg${_supSeg === 'disabled' ? ' on' : ''}" onclick="puSupSeg('disabled')">${esc(T('Disabled', '停用'))} <span class="n pu2-num">${_showDisabled ? disabledN : '·'}</span></span>
        </span>
        <span class="pu2-search">
          <span class="pu2-ic">${I.search}</span>
          <input id="pu2-supq" type="text" placeholder="${esc(T('Find a supplier or contact', '搜索供应商或联系人'))}" oninput="puSupFilter()" autocomplete="off">
        </span>
      </div>

      <div class="pu2-card">
        <table class="pu2-tbl">
          <thead><tr>
            <th>${esc(T('Supplier', '供应商'))}</th>
            <th>${esc(T('Contact', '联系人'))}</th>
            <th>${esc(T('You pay', '付款'))}</th>
            <th class="right">${esc(T('Orders', '采购单'))}</th>
            <th>${esc(T('Rating', '评分'))}</th>
          </tr></thead>
          <tbody id="pu2-suprows"></tbody>
        </table>
      </div>`;
    renderSupplierRows();
  }
  function rateDots(n) {
    n = Math.min(5, Math.max(0, parseInt(n, 10) || 0));
    let out = '<span class="pu2-rate">';
    for (let i = 0; i < 5; i++) out += `<i class="${i < n ? '' : 'off'}"></i>`;
    return out + '</span>';
  }
  function renderSupplierRows() {
    const body = document.getElementById('pu2-suprows');
    if (!body) return;
    const q = (document.getElementById('pu2-supq')?.value || '').toLowerCase().trim();
    let rows = _suppliers.filter(s => _supSeg === 'disabled' ? !s.is_active : s.is_active);
    if (q) rows = rows.filter(s => `${s.name} ${s.name_cn || ''} ${s.contact_name || ''}`.toLowerCase().includes(q));
    if (!rows.length) {
      // A brand-new workspace (no active suppliers at all, no search) gets the
      // teaching empty state — start clean, build your own list.
      const trulyEmpty = _supSeg === 'active' && !q && !_suppliers.some(s => s.is_active);
      if (trulyEmpty) {
        body.innerHTML = `<tr><td colspan="5"><div class="pu2-empty">
          <div class="pu2-empty-ico">${I.box}</div>
          <h3>${esc(T('No suppliers yet', '还没有供应商'))}</h3>
          <p>${esc(T('Add the businesses you buy from. Once they’re here, every order and bill can lean on them — and each product remembers who sells it and for how much.', '添加你的供货商。加入后,采购单和账单都能用上它们 —— 每件商品也会记住由谁供货、价格多少。'))}</p>
          <div class="pu2-actions" style="justify-content:center">
            <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puNewSupplier()"><span class="pu2-ic">${I.plus}</span>${esc(T('Add your first supplier', '添加第一个供应商'))}</button>
            <button class="pu2-btn" data-cap="purchasing:edit" onclick="puImportOpen()"><span class="pu2-ic">${I.up}</span>${esc(T('Import from a spreadsheet', '从表格导入'))}</button>
          </div>
        </div></td></tr>`;
        return;
      }
      body.innerHTML = `<tr><td colspan="5"><div class="pu2-emptyline">${esc(_supSeg === 'disabled' && !_showDisabled ? T('Turn on the Disabled tab to load these.', '点击停用标签加载。') : T('No suppliers here.', '暂无供应商。'))}</div></td></tr>`;
      return;
    }
    body.innerHTML = rows.map(s => {
      const pay = [s.payment_terms, s.payment_method].filter(Boolean);
      const files = s.doc_count ? `${s.doc_count} ${esc(T('files on record', '份资质文件'))}` : '';
      const sub = [s.products_supplied ? esc(s.products_supplied) : '', files].filter(Boolean).join(' · ');
      return `<tr onclick="puOpenSupplier(${s.id})">
        <td><b>${esc(s.name)}</b>${s.name_cn ? ` · ${esc(s.name_cn)}` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</td>
        <td>${esc(s.contact_name || '—')}${s.contact_phone ? `<div class="sub pu2-num">${esc(s.contact_phone)}</div>` : ''}</td>
        <td>${pay.length ? esc(pay[0]) : '—'}${pay[1] ? `<div class="sub">${esc(pay[1])}</div>` : ''}</td>
        <td class="right pu2-num">${s.po_count || 0}${s.last_po_date ? `<div class="sub">${esc(s.last_po_date)}</div>` : ''}</td>
        <td>${rateDots(s.rating)}</td>
      </tr>`;
    }).join('');
  }
  window.puSupSeg = async function (seg) {
    _supSeg = seg;
    if (seg === 'disabled' && !_showDisabled) { _showDisabled = true; await loadSuppliers(); }
    paint();
  };
  window.puSupFilter = renderSupplierRows;

  // ═══════════════════════════════════════════════════════════════════════════
  //  ONE SUPPLIER — form + paperwork + their orders
  // ═══════════════════════════════════════════════════════════════════════════
  window.puNewSupplier = function () { _sup = { id: null, is_active: true }; _screen = 'supplier'; paint(); };
  window.puOpenSupplier = async function (id) {
    try {
      const r = await api('/api/retail-admin/suppliers/' + id);
      _sup = r.data; _screen = 'supplier'; paint();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puBackSuppliers = async function () { _sup = null; _screen = 'suppliers'; await loadSuppliers(); paint(); };

  const CH_OPTS = ['', 'taobao', 'alibaba', 'wechat', 'phone', 'website', 'other'];
  function paintSupplier() {
    const s = _sup;
    root().innerHTML = `
      <div class="pu2-wizhead">
        ${backBtn(T('Suppliers', '供应商'), 'puBackSuppliers()')}
        <h1>${s.id ? esc(s.name) : esc(T('New supplier', '新建供应商'))}</h1>
        ${s.id && !s.is_active ? `<span class="pu2-pill grey">${esc(T('Disabled', '已停用'))}</span>` : ''}
      </div>

      <div class="pu2-card pu2-formcard">
        <div class="pu2-fgroup">
          <div class="pu2-kicker">${esc(T('Who they are', '基本信息'))}</div>
          <div class="pu2-fgrid">
            <label class="pu2-f"><span class="lbl">${esc(T('Name', '名称'))}</span><input class="pu2-input" id="pu2-s-name" value="${esc(s.name || '')}"><span class="hint">${esc(T('The only thing we need to save.', '唯一必填项。'))}</span></label>
            <label class="pu2-f"><span class="lbl">${esc(T('中文名', '中文名'))}</span><input class="pu2-input" id="pu2-s-namecn" value="${esc(s.name_cn || '')}"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('What they supply', '供应商品'))}</span><input class="pu2-input" id="pu2-s-supplies" value="${esc(s.products_supplied || '')}" placeholder="${esc(T('e.g. tofu, soy milk, miso', '如:豆腐、豆浆、味噌'))}"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Contact person', '联系人'))}</span><input class="pu2-input" id="pu2-s-contact" value="${esc(s.contact_name || '')}"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Phone', '电话'))}</span><input class="pu2-input" id="pu2-s-phone" value="${esc(s.contact_phone || '')}"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('WeChat', '微信'))}</span><input class="pu2-input" id="pu2-s-wechat" value="${esc(s.contact_wechat || '')}"></label>
          </div>
        </div>

        <div class="pu2-fgroup">
          <div class="pu2-kicker">${esc(T('How you pay them', '付款方式'))}</div>
          <div class="pu2-fgrid">
            <label class="pu2-f"><span class="lbl">${esc(T('When', '付款时点'))}</span><input class="pu2-input" id="pu2-s-terms" list="pu2-terms" value="${esc(s.payment_terms || '')}"><span class="hint">${esc(T('Prepay · On delivery · Net 15 · Net 30', '预付 · 货到付款 · 月结15 · 月结30'))}</span></label>
            <label class="pu2-f"><span class="lbl">${esc(T('How', '付款渠道'))}</span><input class="pu2-input" id="pu2-s-method" list="pu2-methods" value="${esc(s.payment_method || '')}"><span class="hint">${esc(T('WeChat · Alipay · Bank transfer · Cash', '微信 · 支付宝 · 银行转账 · 现金'))}</span></label>
          </div>
        </div>

        <div class="pu2-fgroup">
          <div class="pu2-kicker">${esc(T('Where you order', '采购渠道'))}</div>
          <div class="pu2-fgrid">
            <label class="pu2-f"><span class="lbl">${esc(T('Ordering channel', '渠道'))}</span>
              <select class="pu2-input" id="pu2-s-chtype">${CH_OPTS.map(v => `<option value="${v}"${(s.channel_type || '') === v ? ' selected' : ''}>${v || T('—', '—')}</option>`).join('')}</select></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Link', '链接'))}</span><input class="pu2-input" id="pu2-s-chlink" value="${esc(s.channel_link || '')}" placeholder="${esc(T('Shop or catalogue URL', '店铺或目录链接'))}"></label>
            ${s.id ? `<label class="pu2-f"><span class="lbl">${esc(T('Rating', '评分'))}</span>
              <select class="pu2-input" id="pu2-s-rating">${[0, 1, 2, 3, 4, 5].map(v => `<option value="${v}"${(s.rating || 0) === v ? ' selected' : ''}>${v ? '★'.repeat(v) : T('Not rated yet', '暂未评分')}</option>`).join('')}</select>
              <span class="hint">${esc(T('Rate them after you’ve worked together.', '合作之后再评分。'))}</span></label>` : ''}
            <label class="pu2-f" style="grid-column:1 / -1"><span class="lbl">${esc(T('Notes', '备注'))}</span><textarea class="pu2-input" id="pu2-s-notes" rows="2" placeholder="${esc(T('Minimum order, delivery days, price quirks…', '起订量、送货日、价格说明……'))}">${esc(s.notes || '')}</textarea></label>
          </div>
        </div>

        <datalist id="pu2-terms"><option value="Prepay 预付"></option><option value="COD 货到付款"></option><option value="Net 15"></option><option value="Net 30"></option></datalist>
        <datalist id="pu2-methods"><option value="WeChat 微信"></option><option value="Alipay 支付宝"></option><option value="Bank 银行转账"></option><option value="Cash 现金"></option></datalist>

        <div class="pu2-wizfoot">
          ${s.id ? `<button class="pu2-btn ${s.is_active ? 'danger' : ''}" data-cap="purchasing:edit" onclick="puSupToggle()">${s.is_active ? esc(T('Disable', '停用')) : esc(T('Enable', '启用'))}</button>` : `<button class="pu2-btn ghost" onclick="puBackSuppliers()">${esc(T('Cancel', '取消'))}</button>`}
          <span class="spacer"></span>
          <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puSupSave()">${esc(T('Save supplier', '保存'))}</button>
        </div>
      </div>

      ${s.id ? supplierExtras(s) : ''}`;
  }
  function supplierExtras(s) {
    return `
      <div class="pu2-card pu2-block">
        <b>${esc(T('Paperwork', '资质文件'))}</b>
        <div class="pu2-docs">
          ${(s.documents || []).length ? s.documents.map(d => `
            <div class="pu2-docrow">
              <span class="sub" style="min-width:74px">${esc(d.kind)}</span>
              <span style="flex:1">${esc(d.label || d.filename || 'file')}</span>
              <button class="pu2-btn sm" onclick="puViewDoc(${d.id})">${esc(T('View', '查看'))}</button>
              <button class="pu2-btn ghost sm" data-cap="purchasing:edit" onclick="puDeleteDoc(${d.id})">✕</button>
            </div>`).join('') : `<div class="sub">${esc(T('None yet — licence, permits, payment QR. Drag a file in.', '暂无 —— 营业执照、许可证、收款码。拖入文件即可。'))}</div>`}
        </div>
        <div class="pu2-docadd" data-cap="purchasing:edit">
          <select class="pu2-input" id="pu2-doc-kind">
            <option value="license">${esc(T('License', '营业执照'))}</option>
            <option value="permit">${esc(T('Permit', '许可证'))}</option>
            <option value="payment_qr">${esc(T('Payment QR', '收款码'))}</option>
            <option value="other">${esc(T('Other', '其他'))}</option>
          </select>
          <input class="pu2-input" type="text" id="pu2-doc-label" placeholder="${esc(T('Label', '说明'))}" style="width:150px">
          <input type="file" id="pu2-doc-file" accept="image/*,application/pdf">
          <button class="pu2-btn sm" onclick="puUploadDoc()">${esc(T('Upload', '上传'))}</button>
        </div>
      </div>

      <div class="pu2-card pu2-block">
        <b>${esc(T('Orders with them', '与其采购单'))}</b>
        <div class="pu2-recentpos">
          ${(s.recent_pos || []).length ? s.recent_pos.map(p => `
            <div class="pu2-recentpo" onclick="puOpenPO(${p.id})">
              <b class="pu2-mono">${esc(p.po_number)}</b><span class="sub pu2-num">${esc(p.date || '')}</span>
              <span style="flex:1;text-align:right" class="pu2-num">${money(p.total)}</span>${statusPill(p)}
            </div>`).join('') : `<div class="sub">${esc(T('None yet.', '暂无。'))}</div>`}
        </div>
      </div>`;
  }
  function supBody() {
    const v = id => (document.getElementById(id)?.value || '').trim();
    return {
      name: v('pu2-s-name'),
      name_cn: v('pu2-s-namecn') || null,
      products_supplied: v('pu2-s-supplies') || null,
      contact_name: v('pu2-s-contact') || null,
      contact_phone: v('pu2-s-phone') || null,
      contact_wechat: v('pu2-s-wechat') || null,
      payment_terms: v('pu2-s-terms') || null,
      payment_method: v('pu2-s-method') || null,
      channel_type: document.getElementById('pu2-s-chtype')?.value || null,
      channel_link: v('pu2-s-chlink') || null,
      rating: document.getElementById('pu2-s-rating') ? parseInt(document.getElementById('pu2-s-rating').value, 10) || 0 : (_sup.rating || 0),
      notes: v('pu2-s-notes') || null,
    };
  }
  window.puSupSave = async function () {
    const body = supBody();
    if (!body.name) { toast(T('Name is required', '名称必填'), 'err'); return; }
    try {
      if (_sup.id) await api('/api/retail-admin/suppliers/' + _sup.id, { method: 'PUT', body });
      else { const r = await api('/api/retail-admin/suppliers', { method: 'POST', body }); _sup.id = r.id; }
      toast(T('Saved ✓', '已保存 ✓'), 'ok');
      await loadSuppliers();
      puOpenSupplier(_sup.id);
    } catch (e) {
      toast(e.code === 'name_taken' ? T('Name already exists', '名称已存在') : e.message, 'err');
    }
  };
  window.puSupToggle = async function () {
    if (!_sup?.id) return;
    try {
      await api('/api/retail-admin/suppliers/' + _sup.id, { method: 'PUT', body: { is_active: !_sup.is_active } });
      toast(T('Saved ✓', '已保存 ✓'), 'ok');
      await loadSuppliers();
      puOpenSupplier(_sup.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puUploadDoc = function () {
    const file = document.getElementById('pu2-doc-file')?.files[0];
    if (!file) { toast(T('Choose a file first', '请先选择文件'), 'err'); return; }
    if (file.size > 10 * 1024 * 1024) { toast(T('Max 10MB', '最大10MB'), 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api('/api/retail-admin/suppliers/' + _sup.id + '/documents', {
          method: 'POST',
          body: {
            kind: document.getElementById('pu2-doc-kind').value,
            label: document.getElementById('pu2-doc-label').value.trim() || null,
            filename: file.name, mime_type: file.type, size_bytes: file.size, data: reader.result,
          },
        });
        toast(T('Uploaded ✓', '已上传 ✓'), 'ok');
        puOpenSupplier(_sup.id);
      } catch (e) { toast(e.message, 'err'); }
    };
    reader.readAsDataURL(file);
  };
  window.puViewDoc = async function (docId) {
    try {
      const r = await api('/api/retail-admin/suppliers/' + _sup.id + '/documents/' + docId);
      const d = r.data;
      if ((d.mime_type || '').startsWith('image/') || /^data:image/.test(d.data)) {
        const box = document.getElementById('rv-lightbox');
        const img = document.getElementById('rv-lightbox-img');
        if (box && img) { img.src = d.data; box.style.display = 'flex'; return; }
      }
      const [head, b64] = d.data.split(',');
      const mime = d.mime_type || (head.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      window.open(URL.createObjectURL(new Blob([arr], { type: mime })), '_blank');
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puDeleteDoc = async function (docId) {
    if (!confirm(T('Delete this document?', '确定删除该文件？'))) return;
    try {
      await api('/api/retail-admin/suppliers/' + _sup.id + '/documents/' + docId, { method: 'DELETE' });
      toast(T('Deleted ✓', '已删除 ✓'), 'ok');
      puOpenSupplier(_sup.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  IMPORT SUPPLIERS FROM CSV
  // ═══════════════════════════════════════════════════════════════════════════
  // Column header → supplier field. Aliases keep it forgiving for hand-made files.
  const CSV_MAP = {
    name: 'name', 'name_cn': 'name_cn', 'chinese name': 'name_cn', '中文名': 'name_cn',
    contact: 'contact_name', 'contact person': 'contact_name', 'contact_name': 'contact_name',
    phone: 'contact_phone', tel: 'contact_phone', wechat: 'contact_wechat', weixin: 'contact_wechat',
    'pay_when': 'payment_terms', terms: 'payment_terms', 'payment terms': 'payment_terms',
    'pay_how': 'payment_method', method: 'payment_method', 'payment method': 'payment_method',
    channel: 'channel_type', link: 'channel_link', url: 'channel_link',
    supplies: 'products_supplied', products: 'products_supplied', notes: 'notes',
  };
  window.puImportOpen = function () { _imp = null; _screen = 'import'; paint(); };
  window.puBackToSuppliers = async function () { _imp = null; _screen = 'suppliers'; await loadSuppliers(); paint(); };

  function paintImport() {
    root().innerHTML = `
      <div class="pu2-wizhead">
        ${backBtn(T('Suppliers', '供应商'), 'puBackToSuppliers()')}
        <h1>${esc(T('Import suppliers', '导入供应商'))}</h1>
      </div>
      <div class="pu2-card" style="padding:6px 28px">
        <div class="pu2-impsteps">
          <div class="pu2-impstep">
            <span class="n">1</span>
            <div>
              <h3>${esc(T('Download the template', '下载模板'))}</h3>
              <p>${esc(T('A small spreadsheet with the right column names already in the first row. Open it in Excel, WPS or Numbers — it includes two example suppliers you can overwrite.', '一个已经在第一行写好列名的小表格。用 Excel、WPS 或 Numbers 打开 —— 里面有两个示例供应商,直接覆盖即可。'))}</p>
              <button class="pu2-btn" onclick="puDownloadTemplate()"><span class="pu2-ic">${I.down}</span>${esc(T('Download template (.csv)', '下载模板 (.csv)'))}</button>
              <div class="pu2-csvpeek"><b>name</b>, name_cn, contact, phone, wechat, pay_when, pay_how, channel, link, supplies, notes<br>Guangzhou Bean Works, , Mr. Liang, 13800000000, liang_beans, On delivery, WeChat, taobao, , tofu; soy milk, delivers Tue/Fri</div>
            </div>
          </div>
          <div class="pu2-impstep">
            <span class="n">2</span>
            <div>
              <h3>${esc(T('Fill it in — one supplier per row', '填写 —— 每行一个供应商'))}</h3>
              <ul class="pu2-implist">
                <li>${esc(T('Only the name column must be filled. Leave anything else empty.', '只有 name 列必填,其余可留空。'))}</li>
                <li>${esc(T('Keep the first row (the column names) exactly as it is.', '保持第一行(列名)不变。'))}</li>
                <li>${esc(T('Already have the supplier? Use the same name — we update it instead of making a double.', '已有该供应商?用相同名称 —— 我们会更新而不是新建重复项。'))}</li>
                <li>${esc(T('When done: File → Save As → CSV. Excel may warn about the format — choose Keep.', '完成后:文件 → 另存为 → CSV。Excel 可能提示格式 —— 选择“保留”。'))}</li>
              </ul>
            </div>
          </div>
          <div class="pu2-impstep">
            <span class="n">3</span>
            <div style="flex:1;min-width:0">
              <h3>${esc(T('Upload and check', '上传并核对'))}</h3>
              <p>${esc(T('Choose your file. We show what will happen to every row — nothing is saved until you press Import.', '选择文件。我们会显示每一行将发生什么 —— 在你点击导入前不会保存任何内容。'))}</p>
              <label class="pu2-drop">
                <span class="pu2-ic big">${I.up}</span>
                <b>${esc(T('Click to choose your CSV', '点击选择 CSV 文件'))}</b>
                <span>${esc(T('Up to 1,000 rows · .csv only', '最多 1000 行 · 仅限 .csv'))}</span>
                <input type="file" accept=".csv,text/csv" style="display:none" onchange="puCsvFile(this)">
              </label>
            </div>
          </div>
        </div>
      </div>
      <div id="pu2-imp-preview"></div>`;
    if (_imp) renderImportPreview();
  }

  // Minimal RFC-ish CSV parser: handles quoted fields, commas + newlines inside
  // quotes, and doubled "" escapes. Good enough for hand-made supplier sheets.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  window.puCsvFile = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const grid = parseCSV(String(reader.result));
        if (grid.length < 2) { toast(T('That file has no supplier rows.', '文件中没有供应商数据行。'), 'err'); return; }
        const headers = grid[0].map(h => String(h).trim().toLowerCase());
        const byName = new Map(_suppliers.map(s => [s.name.trim().toLowerCase(), s]));
        const rows = grid.slice(0, 1001).slice(1).map((cells, idx) => {
          const rec = {};
          headers.forEach((h, ci) => { const f = CSV_MAP[h]; if (f) rec[f] = String(cells[ci] ?? '').trim() || null; });
          const name = (rec.name || '').trim();
          const existing = name ? byName.get(name.toLowerCase()) : null;
          return {
            line: idx + 2, rec, name,
            action: !name ? 'skip' : (existing ? 'update' : 'new'),
            existingId: existing ? existing.id : null,
          };
        });
        _imp = { headers, rows, filename: file.name };
        renderImportPreview();
      } catch (e) { toast(e.message, 'err'); }
    };
    reader.readAsText(file);
  };

  function renderImportPreview() {
    const host = document.getElementById('pu2-imp-preview');
    if (!host || !_imp) return;
    const rows = _imp.rows;
    const news = rows.filter(r => r.action === 'new').length;
    const upds = rows.filter(r => r.action === 'update').length;
    const skips = rows.filter(r => r.action === 'skip').length;
    const willImport = news + upds;
    const badge = (cls, n, label) => n ? `<span class="pu2-pill ${cls}"><span class="dot"></span>${n} ${esc(label)}</span>` : '';
    host.innerHTML = `
      <div class="pu2-kicker">${esc(T('Check before importing', '导入前核对'))}</div>
      <div class="pu2-card" style="padding:22px 28px">
        <div><b>${esc(_imp.filename)}</b> — ${rows.length} ${esc(T('rows read.', '行已读取。'))}</div>
        <div class="pu2-prevsum">
          ${badge('sage', news, T('new', '新增'))}
          ${badge('amber', upds, T('will update existing', '更新已有'))}
          ${badge('brick', skips, T('skipped — no name', '跳过 —— 无名称'))}
        </div>
        <table class="pu2-tbl">
          <thead><tr><th>${esc(T('Row', '行'))}</th><th>${esc(T('Supplier', '供应商'))}</th><th>${esc(T('Contact', '联系人'))}</th><th>${esc(T('You pay', '付款'))}</th><th>${esc(T('What happens', '结果'))}</th></tr></thead>
          <tbody>
            ${rows.map(r => {
              const cls = r.action === 'new' ? 'prev-ok' : r.action === 'update' ? 'prev-upd' : 'prev-skip';
              const pay = [r.rec.payment_terms, r.rec.payment_method].filter(Boolean).join(' · ');
              const what = r.action === 'new'
                ? `<span class="pu2-pill sage">${esc(T('New', '新增'))}</span>`
                : r.action === 'update'
                  ? `<span class="pu2-pill amber">${esc(T('Updates existing', '更新已有'))}</span>`
                  : `<span class="pu2-pill brick">${esc(T('Skipped — name is empty', '跳过 —— 名称为空'))}</span>`;
              return `<tr class="${cls}">
                <td class="pu2-num">${r.line}</td>
                <td>${esc(r.name || '—')}${r.rec.name_cn ? ` · ${esc(r.rec.name_cn)}` : ''}</td>
                <td>${esc(r.rec.contact_name || '—')}${r.rec.contact_phone ? ` · <span class="pu2-num">${esc(r.rec.contact_phone)}</span>` : ''}</td>
                <td>${pay ? esc(pay) : '—'}</td>
                <td>${what}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="pu2-wizfoot">
          <button class="pu2-btn ghost" onclick="puImportOpen()">${esc(T('Choose a different file', '换一个文件'))}</button>
          <span class="spacer"></span>
          <button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puImportRun()" ${willImport ? '' : 'disabled'}>${esc(T('Import', '导入'))} ${willImport} ${esc(T('suppliers', '个供应商'))}</button>
        </div>
      </div>`;
    try { applyCapGates(); } catch (_) {}
  }

  window.puDownloadTemplate = function () {
    const header = 'name,name_cn,contact,phone,wechat,pay_when,pay_how,channel,link,supplies,notes';
    const ex1 = 'Guangzhou Bean Works,,Mr. Liang,13800000000,liang_beans,On delivery,WeChat,taobao,,tofu; soy milk,delivers Tue/Fri';
    const ex2 = 'Fresh Fields Produce,,Ms. Chen,13900000000,,Net 15,Bank transfer,phone,,vegetables; herbs,';
    const csv = '﻿' + [header, ex1, ex2].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'suppliers-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
  };

  window.puImportRun = async function () {
    if (!_imp) return;
    const jobs = _imp.rows.filter(r => r.action !== 'skip');
    if (!jobs.length) return;
    let ok = 0, fail = 0;
    for (const r of jobs) {
      const body = { ...r.rec, name: r.name };
      try {
        if (r.action === 'update' && r.existingId) await api('/api/retail-admin/suppliers/' + r.existingId, { method: 'PUT', body });
        else await api('/api/retail-admin/suppliers', { method: 'POST', body });
        ok++;
      } catch (e) { fail++; }
    }
    toast(T(`Imported ${ok} suppliers`, `已导入 ${ok} 个供应商`) + (fail ? T(` · ${fail} failed`, ` · ${fail} 个失败`) : '') + ' ✓', fail ? 'err' : 'ok', 4000);
    await loadSuppliers();
    _imp = null; _screen = 'suppliers'; paint();
  };

  // Close the wizard product-picker on an outside click.
  document.addEventListener('click', (e) => {
    const list = document.getElementById('pu2-picker-list');
    if (list && list.style.display !== 'none' && !e.target.closest('#pu2-picker') && !e.target.closest('#pu2-picker-list')) {
      list.style.display = 'none';
    }
  });
})();
