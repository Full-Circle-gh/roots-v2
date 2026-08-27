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
  // A material's buy unit is stored as an English abbreviation ('kg', 'bag',
  // 'pcs') — fine on screen next to English labels, but on the printed PO the
  // rest of the sheet renders in whichever language T() picks, and a raw
  // 'kg' next to Chinese headers reads as one language leaking into another
  // (§1.7's rule this print sheet otherwise follows). Same vocabulary as
  // PO_UNIT_CN in app.html, the kitchen twin of this print.
  const PO_UNIT_CN = {
    kg: '公斤', g: '克', L: '升', ml: '毫升', lb: '磅', oz: '盎司',
    bottle: '瓶', bag: '包', box: '盒', can: '罐', jar: '罐',
    case: '箱', pack: '包', tub: '桶', pcs: '件',
  };
  const unitLabel = u => (u ? T(u, PO_UNIT_CN[u] || u) : '');
  // A supplier is stored as ONE free-text name, and most of the live ones glue
  // both languages into it — "Dry Fruit 果干". Split the stored string at its
  // language boundary (first 中文 character to last, the rest is the English
  // half) so a screen never shows both at once. A name written in only one
  // language has no boundary and survives whole in both.
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
  // nameCn, when the suppliers master holds one, always wins over the split.
  function supName(name, nameCn) {
    const half = supSplit(name);
    return T(half.en, (nameCn && String(nameCn).trim()) || half.cn);
  }
  // Finance-category text (expense_entries.category, same vocabulary as
  // ingredients.accounting_category / po_line_items.expense_category — see
  // lib/category-text.js) is stored as ONE combined bilingual string with no
  // separate EN/CN column. Split it the same way a supplier name splits, so
  // the receiving screen's Finance panel never shows both languages at once.
  function catLabel(cat) {
    if (!cat) return '';
    const half = supSplit(cat);
    return T(half.en, half.cn);
  }
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
  let _matCache = null;      // materials list (not store-scoped — one cache)
  let _hist = {};            // store_product_id → last-paid, for the open PO
  const _supCache = {};      // store_product_id → { suppliers[], last } price list
  let _pickP = null;         // product the supplier popover is open for
  let _pickInfo = null;      // its loaded price list
  let _invOut = null;        // supplier groups + KPI totals + aging, from the server
  let _invList = [];         // the recorded-invoice ledger
  let _invDraft = null;      // the add/edit invoice modal's working state
  let _invMonth = '';        // 'YYYY-MM' or '' for all
  let _invSearch = '';       // supplier / item / SKU / PO number
  let _invSearchTimer = null;
  let _invFocusQ = false;    // keep the caret in the search box across a repaint
  // Which of the screen's two lists is showing. They used to be stacked, and
  // with 78 supplier groups live the recorded-invoice ledger sat some 3600px
  // down the page — the operator scrolled the whole chase list every time they
  // wanted to edit an invoice they had just entered. §1.7's test says a switch
  // between two different KINDS of thing is a sub-view, so this is a segmented
  // control, in the same toolbar slot the Orders screen already uses for one.
  let _invView = 'suppliers';  // suppliers | recorded
  const _invExpanded = new Set();  // supplier groups whose lines are open
  let _reorder = [];         // low-stock groups, by preferred supplier + store
  let _ph = null;            // loaded price-history for one product
  let _phBack = 'orders';    // screen to return to from price history
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
    print:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>',
    chevRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chevDown:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
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
  // po.supplier is one string — set when every line came from the same place,
  // left blank for a consolidated order that mixes several. Blank used to
  // just print "No supplier", which reads as unspecified rather than mixed.
  // Falls back to distinct per-line supplier_name values: none of those either
  // → genuinely unspecified; one → that's the order's supplier in practice;
  // more than one → say so instead of hiding it, name-on-hover via title.
  function supplierLabel(p) {
    if (p.supplier) return esc(p.supplier);
    const names = Array.isArray(p.items)
      ? Array.from(new Set(p.items.map(i => (i.supplier_name || '').trim()).filter(Boolean)))
      : (p.line_suppliers ? p.line_suppliers.split(',') : []).map(s => s.trim()).filter(Boolean);
    if (!names.length) return esc(T('No supplier', '未指定供应商'));
    if (names.length === 1) return esc(names[0]);
    return `<span title="${esc(names.join(', '))}">${names.length} ${esc(T('suppliers', '家供应商'))}</span>`;
  }
  const nameLabel = it => esc([it.name_en, it.name_cn].filter(Boolean).join(' · ') || '—');
  // A material line next to a product line on the same PO — one small grey
  // tag is the only thing that says which is which (colour stays status-only
  // everywhere else on this screen, so this is text on the neutral pill, not
  // a new colour).
  const matBadge = it => it.ingredient_id ? `<span class="pu2-pill grey pu2-mattag">${esc(T('Material', '物料'))}</span>` : '';

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
  // Materials — not store-scoped stock, so one cache serves every store.
  // Gated by the 'production' tenant feature (body.feat-production, same
  // class that hides the Materials/Recipes tabs — renamed from 'materials'
  // when Recipes joined the same switch, §28) — a tenant with it off never
  // sees a material in this picker, even though the API itself has no
  // feature check (matches the Materials screen's own precedent: server
  // enforces the door, the tenant-level on/off switch is UI-only, per §28
  // addendum item 1).
  function materialsFeatureOn() {
    return document.body.classList.contains('feat-production');
  }
  async function materials() {
    if (!materialsFeatureOn()) return [];
    if (!_matCache) {
      const r = await api('/api/retail-admin/materials');
      _matCache = (r.data || []).filter(m => m.is_active);
    }
    return _matCache;
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
    else if (_screen === 'invoices')  paintInvoices();
    else if (_screen === 'reorder')   paintReorder();
    else if (_screen === 'pricehist') paintPriceHistory();
    try { applyCapGates(); } catch (_) {}
  }

  // (Topbar Purchasing sub-view mirror removed 2026-07-25 — the bar is closed
  // (§1.1d). The in-content .pu2-subnav is the sole sub-view switch again.)

  function backBtn(label, fn) {
    return `<button class="pu2-btn ghost sm" onclick="${fn}"><span class="pu2-ic">${I.back}</span>${esc(label)}</button>`;
  }

  // ── Tacet page-head + sub-nav (replaces the dead Full Circle .pa-pagetitle) ──
  // Rendered at the top of every ledger screen so Purchasing carries its own
  // Tacet identity.
  const PU_TABS = [
    ['orders',    () => T('Orders', '采购单')],
    ['suppliers', () => T('Suppliers', '供应商')],
    ['invoices',  () => T('Invoices', '发票')],
    ['reorder',   () => T('Reorder', '补货')],
  ];
  function puChrome(active) {
    const meta = {
      orders:    [T('Orders', '采购单'),   T('Order goods from your suppliers. When a delivery arrives, tick it in — stock and expenses update by themselves.', '向供应商采购商品。到货时勾选收货 —— 库存和支出会自动更新。')],
      suppliers: [T('Suppliers', '供应商'), T('Who you buy from — contacts, payment terms and their paperwork, all in one place.', '你的供货来源 —— 联系人、付款条件和资质文件,集中在一处。')],
      invoices:  [T('Invoices', '发票'),   T('Which suppliers still owe you a 发票, and for how much. Record one and match it to the lines it covers.', '哪些供应商还未开票、金额多少。登记发票并与对应采购明细匹配。')],
      reorder:   [T('Reorder', '补货'),      T('Products running low across your stores, grouped by who you’d order them from.', '各门店库存偏低的商品,按常用供应商归类。')],
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
    else if (tab === 'invoices') { _screen = 'invoices'; }
    else if (tab === 'reorder') { _screen = 'reorder'; }
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
    if (q) rows = rows.filter(p => `${p.po_number} ${p.supplier || ''} ${p.line_suppliers || ''}`.toLowerCase().includes(q));

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
        <td>${supplierLabel(p)}</td>
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
            // The line's own row id travels with it so a save UPDATES that row
            // instead of replacing it. Without it the server has to re-insert,
            // and invoice_lines.line_id (ON DELETE CASCADE) loses this line's
            // supplier-invoice allocation. Rows added in the wizard have none,
            // which is exactly how the server tells new from existing.
            id: i.id,
            store_product_id: i.store_product_id, ingredient_id: i.ingredient_id,
            name_en: i.name_en, name_cn: i.name_cn,
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
      .map(s => `<option value="${esc(s.name)}"${s.name === selected ? ' selected' : ''}>${esc(supName(s.name, s.name_cn))}</option>`)
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
          <span class="lbl">${esc(materialsFeatureOn() ? T('Add products & materials', '添加商品或物料') : T('Add products', '添加商品'))}</span>
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
          ${_edit.id ? `<button class="pu2-btn danger" data-cap="purchasing:edit" onclick="puDeleteDraft()">${esc(T('Delete draft', '删除草稿'))}</button>` : ''}
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
      const emptyMsg = materialsFeatureOn()
        ? T('Nothing yet — search or pick a suggestion above.', '还没有内容——在上方搜索或选择推荐。')
        : T('No products yet — search or pick a suggestion above.', '还没有商品——在上方搜索或选择推荐。');
      body.innerHTML = `<tr class="pu2-noline"><td colspan="6">${esc(emptyMsg)}</td></tr>`;
      return;
    }
    body.innerHTML = _edit.items.map((it, i) => {
      const lineTotal = (parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0);
      const supLabel = it.supplier_name ? esc(it.supplier_name) : esc(T('Choose supplier', '选择供应商'));
      // A material has no per-supplier price list to pop open (that popover is
      // built from retail PO history keyed on store_product_id — see
      // routes/retail-purchasing.js /products/:spid/suppliers), so its
      // supplier reads as plain text instead of a clickable chip.
      const supBlock = it.ingredient_id
        ? `<div class="pu2-supline"><span class="sub">${supLabel}</span></div>`
        : `<div class="pu2-supline"><span class="pu2-supchip" onclick="puPick(${it.store_product_id})">${supLabel} <span class="swap">▾</span></span></div>`;
      return `<tr>
        <td>${matBadge(it)}${nameLabel(it)}${it.sku ? `<div class="sub pu2-mono">${esc(it.sku)}</div>` : ''}
          ${supBlock}</td>
        <td class="right pu2-num" style="color:var(--td-text2)">${it.current_stock != null ? it.current_stock : '—'}</td>
        <td>
          <span class="pu2-qty">
            <button type="button" class="pm" onclick="puQty(${i},-1)">−</button>
            <input type="number" min="0" step="1" class="pu2-num" value="${esc(it.qty ?? 1)}" onchange="puLine(${i},'qty',this.value)">
            <button type="button" class="pm" onclick="puQty(${i},1)">+</button>
          </span>
        </td>
        <td class="right">
          <span class="pu2-costwrap">¥<input type="number" min="0" step="0.01" class="pu2-cost pu2-num" value="${esc(it.cost_per_unit ?? 0)}" onchange="puLine(${i},'cost_per_unit',this.value)"><span class="pu2-costunit">/${esc(unitLabel(it.unit || 'pcs'))}</span></span>
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
      let prods = [], mats = [];
      try {
        [prods, mats] = await Promise.all([products(_edit.store_id), materials()]);
      } catch (e) { toast(e.message, 'err'); return; }
      const prodHits = prods.filter(p => `${p.name_en || ''} ${p.name_cn || ''} ${p.sku || ''}`.toLowerCase().includes(q)).slice(0, 30);
      const matHits = mats.filter(m => `${m.name_en || ''} ${m.name_cn || ''} ${m.sku || ''}`.toLowerCase().includes(q)).slice(0, 30);
      const rows = [
        ...prodHits.map(p => `<div class="pu2-pick" onclick="puPick(${p.product_id})">${nameLabel(p)}<span class="sub pu2-mono">${esc(p.sku || '')} · ${esc(T('stock', '库存'))} ${p.physical_qty}</span></div>`),
        ...matHits.map(m => `<div class="pu2-pick" onclick="puPickMaterial(${m.id})">${matBadge({ ingredient_id: m.id })}${nameLabel(m)}<span class="sub pu2-mono">${esc(m.sku || '')}</span></div>`),
      ];
      list.innerHTML = rows.length ? rows.join('') : `<div class="pu2-pick muted">${esc(T('No match', '无匹配'))}</div>`;
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

  // Picking a material — no per-supplier price list to compare (materials
  // don't carry retail PO history the way store_products do), so it drops
  // straight onto the line, defaulting the supplier + unit + price from the
  // material's own master record. Unit MUST default to buy_unit, not 'pcs' —
  // firePriceAlertsForPO (routes/purchases.js) refuses to write back a price
  // whose line unit doesn't match ingredients.buy_unit.
  window.puPickMaterial = async function (ingredientId) {
    const mats = await materials();
    const m = mats.find(x => x.id === ingredientId);
    if (!m) return;
    const pk = document.getElementById('pu2-picker');
    if (pk) pk.value = '';
    const pl = document.getElementById('pu2-picker-list');
    if (pl) pl.style.display = 'none';
    addOrSetMaterialLine(m);
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

  function addOrSetMaterialLine(m) {
    let it = _edit.items.find(x => x.ingredient_id === m.id);
    if (!it) {
      it = {
        ingredient_id: m.id, name_en: m.name_en, name_cn: m.name_cn, sku: m.sku,
        qty: 1, unit: m.buy_unit || 'pcs', cost_per_unit: m.buy_price || 0,
        expense_category: m.accounting_category || '', purchase_channel: '',
        current_stock: null, supplier_name: m.supplier || '',
      };
      _edit.items.push(it);
    }
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
          <span style="margin-left:auto;display:inline-flex;gap:14px">
            <button class="pu2-link" style="margin:0" onclick="puPriceHistory(${_pickP.product_id})">${esc(T('Price history', '价格历史'))}</button>
            <button class="pu2-link" style="margin:0" onclick="puCloseSupPop()">${esc(T('Close', '关闭'))}</button>
          </span>
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
          ${_edit.id ? `<button class="pu2-btn danger" data-cap="purchasing:edit" onclick="puDeleteDraft()">${esc(T('Delete draft', '删除草稿'))}</button>` : ''}
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
        id: it.id || null,
        store_product_id: it.store_product_id, ingredient_id: it.ingredient_id,
        name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
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
  window.puDeleteDraft = async function () {
    if (!_edit.id) return;
    if (!(await askConfirm({
      title: T('Delete this draft order?', '删除此草稿采购单？'),
      body: T('It was never placed, so nothing to unwind — this just removes it.', '该订单从未下单，删除不会影响任何账目。'),
      confirmLabel: T('Delete draft', '删除草稿'),
      danger: true,
    }))) return;
    try {
      await api('/api/retail-admin/purchases/' + _edit.id, { method: 'DELETE' });
      toast(T('Draft deleted ✓', '草稿已删除 ✓'), 'ok');
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
  // The order's journey — Draft → Sent → Part received → Received. Derived from
  // the wire status + how much has actually been ticked in.
  function lifeStepper(p) {
    const items = p.items || [];
    const anyRcv = items.some(i => i.qty_received != null);
    const allRcv = items.length > 0 && items.every(i => i.qty_received != null);
    let step;
    if (p.status === 'Delivered') step = 3;
    else if (p.status === 'Ordered') step = (anyRcv && !allRcv) ? 2 : 1;
    else if (p.status === 'Requested') step = 0;
    else return `<div class="pu2-life"><span class="s now"><span class="d"></span>${esc(T('Cancelled', '已取消'))}</span></div>`;
    const steps = [T('Draft', '草稿'), T('Sent', '已下单'), T('Part received', '部分收货'), T('Received', '已收货')];
    return `<div class="pu2-life">${steps.map((s, i) => {
      const cls = i < step ? 'done' : i === step ? 'now' : '';
      return `<span class="s ${cls}"><span class="d"></span>${esc(s)}</span>${i < steps.length - 1 ? '<span class="conn"></span>' : ''}`;
    }).join('')}</div>`;
  }

  // Landed cost — freight/tax/handling on top of goods. Saving posts the extras
  // to Finance as one "Freight & fees" line; it does NOT reach any unit cost.
  //
  // There was a "≈ X per unit across N units" line under the total. It is gone,
  // and nothing replaces it here. It summed the raw `qty` column across every
  // line, so a PO of 5 kg + 3 pcs + 2 L reported 10 units, and it divided by
  // ORDERED quantity — never qty_received, never less damaged — so a short
  // delivery spread the whole freight bill over units that never arrived.
  // Whether freight should reach unit cost at all is an open design question
  // and is not answered by putting an unsound number back.
  function landedPanel(p) {
    const items = p.items || [];
    const goods = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.cost_per_unit) || 0), 0);
    const f = Number(p.extra_freight) || 0, t = Number(p.extra_tax) || 0, h = Number(p.extra_handling) || 0;
    const landed = goods + f + t + h;
    const inp = (id, val) => `<span class="pu2-costwrap">¥<input type="number" min="0" step="0.01" class="pu2-cost pu2-num" id="${id}" value="${val || ''}" placeholder="0" oninput="puLandedRecalc()"></span>`;
    return `<div class="pu2-card pu2-block pu2-landed">
      <b>${esc(T('True landed cost', '到手成本'))}</b>
      <div class="pu2-lc-grid">
        <div class="lc-row"><span class="g">${esc(T('Goods', '货款'))}</span><span class="pu2-num">${money(goods)}</span></div>
        <div class="lc-row"><span class="g">${esc(T('Freight', '运费'))}</span>${inp('pu2-lc-freight', f)}</div>
        <div class="lc-row"><span class="g">${esc(T('Tax', '税费'))}</span>${inp('pu2-lc-tax', t)}</div>
        <div class="lc-row"><span class="g">${esc(T('Handling', '杂费'))}</span>${inp('pu2-lc-handling', h)}</div>
        <div class="lc-row tot"><span>${esc(T('Landed total', '到手合计'))}</span><span class="pu2-num" id="pu2-lc-total">${money(landed)}</span></div>
      </div>
      <div style="margin-top:12px"><button class="pu2-btn sm" data-cap="purchasing:edit" onclick="puSaveLanded()">${esc(T('Save — posts freight & fees to Finance', '保存 —— 运杂费记入财务'))}</button></div>
    </div>`;
  }
  window.puLandedRecalc = function () {
    if (!_po) return;
    const items = _po.items || [];
    const goods = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.cost_per_unit) || 0), 0);
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    const landed = goods + g('pu2-lc-freight') + g('pu2-lc-tax') + g('pu2-lc-handling');
    const tot = document.getElementById('pu2-lc-total'); if (tot) tot.textContent = money(landed);
  };
  window.puSaveLanded = async function () {
    if (!_po) return;
    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    try {
      await api('/api/retail-admin/purchases/' + _po.id + '/landed', { method: 'PUT', body: { freight: g('pu2-lc-freight'), tax: g('pu2-lc-tax'), handling: g('pu2-lc-handling') } });
      toast(T('Landed cost saved ✓', '到手成本已保存 ✓'), 'ok');
      puOpenPO(_po.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  function paintReceive() {
    const p = _po;
    if (!p) { _screen = 'orders'; paint(); return; }
    const canReceive = p.status === 'Ordered' || p.status === 'Delivered';
    const shortN = (p.items || []).filter(i => i.qty_received != null && Number(i.qty_received) < Number(i.qty)).length;
    const expTotal = (p.expenses || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    root().innerHTML = `
      <div class="pu2-wizhead">
        ${backBtn(T('Orders', '采购单'), 'puBackOrders()')}
        <h1 class="pu2-mono" style="font-size:21px">${esc(p.po_number)}</h1>
        ${statusPill(p)}
        <span class="spacer"></span>
        <button class="pu2-btn" onclick="puPrintPO()"><span class="pu2-ic">${I.print}</span>${esc(T('Print / send', '打印 / 发送'))}</button>
      </div>
      <div class="pu2-rcvsub pu2-num">${supplierLabel(p)} → ${storeLabel(p)} · ${esc(T('placed', '下单'))} ${esc(p.date || '')}${p.delivery_date ? ` · ${esc(T('expected', '预计'))} ${esc(p.delivery_date)}` : ''} · ${money(p.total_cost || (p.items || []).reduce((s, i) => s + (i.qty || 0) * (i.cost_per_unit || 0), 0))}</div>
      ${lifeStepper(p)}
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
            ${(p.items || []).map(it => receiveRow(it, canReceive, !!p.no_invoice_expected)).join('')}
          </tbody>
        </table>
      </div>

      ${canReceive ? receiveNote(p) : ''}

      <div class="pu2-actions">
        ${canReceive ? `<button class="pu2-btn primary" data-cap="purchasing:receive" onclick="puReceiveSave()">${esc(T('Confirm delivery', '确认收货'))}</button>` : ''}
        ${p.status === 'Ordered' ? `<button class="pu2-btn" data-cap="purchasing:receive" onclick="puAllArrived()">${esc(T('All arrived as ordered', '全部按订单到货'))}</button>` : ''}
        ${p.status === 'Ordered' ? `<button class="pu2-btn ghost" data-cap="purchasing:edit" onclick="puSetStatus('Requested')">${esc(T('Back to draft', '退回草稿'))}</button>` : ''}
        ${p.status === 'Delivered' ? `<button class="pu2-btn" data-cap="purchasing:edit" onclick="puReorder(${p.id})">${esc(T('Order again', '再次采购'))}</button>` : ''}
        ${p.status === 'Delivered' ? `<button class="pu2-btn ghost" data-cap="purchasing:edit" onclick="puUndoReceive()">${esc(T('Undo receiving', '撤销收货'))}</button>` : ''}
        ${shortN ? `<button class="pu2-btn" data-cap="purchasing:edit" onclick="puBackorder()">${esc(T(`Back-order ${shortN} short`, `${shortN} 项缺货补单`))}</button>` : ''}
        <span class="spacer"></span>
        ${p.status !== 'Cancelled' && p.status !== 'Delivered' ? `<button class="pu2-btn danger" data-cap="purchasing:edit" onclick="puSetStatus('Cancelled')">${esc(T('Cancel order', '取消采购单'))}</button>` : ''}
      </div>

      ${p.status !== 'Cancelled' ? landedPanel(p) : ''}

      <div class="pu2-fin">
        <b>${esc(T('Finance', '财务'))}</b>
        ${(p.expenses || []).length
          ? `<div class="pu2-num">${p.expenses.map(x => `${esc(catLabel(x.category))} — ${money(x.amount)}`).join('<br>')}<div class="sub">${esc(T('Posted to Expenses', '已记入支出'))} · ${money(expTotal)}</div></div>`
          : `<div class="sub">${esc(T('Posts to Expenses when the order is placed.', '下单后自动记入支出。'))}</div>`}
      </div>`;
  }
  // The invoice picker and the Invoices screen's no-invoice mark are ONE fact,
  // not two. "None" here writes po_line_items.no_invoice_expected — the column
  // lineStatus() actually reads (routes/retail-purchasing.js) — so a line the
  // buyer marks here stops reading "Awaiting" over there. The row therefore
  // renders from that mark first and falls back to the older stored
  // invoice_status only for the awaiting/received distinction it still carries.
  //
  // When the whole PO carries the mark there is nothing per-line left to
  // decide, so the cell is static: no select means puReceiveSave sends no
  // invoice_status for the line, which is what keeps a later PO-level unmark
  // from leaving every line stuck on "None".
  function invoiceCell(it, poNoInvoice, dis) {
    if (poNoInvoice) return `<span class="sub">${esc(T('None', '无发票'))}</span>`;
    const sel = it.no_invoice_expected ? 'no_invoice' : (it.invoice_status || 'not_received');
    const opt = (v, en, cn) => `<option value="${v}"${sel === v ? ' selected' : ''}>${esc(T(en, cn))}</option>`;
    return `<select class="pu2-input pu2-ri" data-saved="${sel}" onchange="puSaveLineInvoice(this, ${it.id})" ${dis}>
        ${opt('not_received', 'Awaiting', '待收')}
        ${opt('received', 'Received', '已收')}
        ${opt('no_invoice', 'None', '无发票')}
      </select>`;
  }
  // The note above the Confirm buttons. It used to be one fixed sentence that
  // promised, of every PO alike, that confirmed counts go into stock AND sync to
  // every sales channel. Neither half is reliably true: a PO can be all material
  // lines, which move no stock at all, and a product can be listed on no channel
  // — in which case the sync it promises has nothing to push.
  //
  // So it now reads back what this PO actually says. Each clause is rendered only
  // when the lines earn it, and the destination is the PO's own Deliver-to, which
  // storeLabel() has always read from the record rather than any fixed name.
  //
  // Material lines are simply not spoken for: no stock claim, no channel claim,
  // no sentence of their own. Their badge in the name column already says what
  // they are, and the honest thing to say about them here is nothing.
  //
  // Every string is an existing pair from this file, reused verbatim; the
  // channel clause is the second half of the old sentence, split at its own
  // punctuation. Nothing here was composed. (`every sales channel` still
  // over-claims once it renders — tightening it to "the channels these products
  // are listed on" needs a new locked CN pair, so it is left as it stands.)
  function receiveNote(p) {
    const items = p.items || [];
    const movesStock = items.some(i => !i.ingredient_id && i.store_product_id);
    const onChannel  = items.some(i => i.channel_listed);
    // Nothing to promise — an all-material PO, or one whose lines carry no
    // product at all. Say nothing rather than something untrue.
    if (!movesStock) return '';
    const stockClause = `<b>${esc(T('Confirmed counts go into', '确认的数量会自动计入'))} ${storeLabel(p)} ${esc(T('stock by themselves', '门店库存'))}</b>`;
    const channelClause = onChannel
      ? ' ' + esc(T('and sync out to every sales channel.', ',并同步到各销售渠道。'))
      : '';
    const damagedClause = ' ' + esc(T('Damaged units are kept out of stock.', '破损数量不计入库存。'));
    return `<div class="pu2-autonote">
        <span class="dot"></span>
        <span>${stockClause}${channelClause}${damagedClause}</span>
      </div>`;
  }

  function receiveRow(it, canReceive, poNoInvoice) {
    const applied = (it.stock_applied_qty || 0) > 0 ? `✓ ${it.stock_applied_qty}` : '—';
    const dis = canReceive ? '' : 'disabled';
    const priceNote = it.cost_per_unit != null
      ? `${money(it.cost_per_unit)} ${esc(T('each', '每件'))}` : '';
    // A consolidated order mixes suppliers per line (§ supplierLabel above) —
    // worth repeating here since the header supplier is blank on exactly
    // those orders and this is where the receiving decision actually happens.
    const lineSupplier = (it.supplier_name || '').trim();
    // THE ARRIVED BOX IS ON EVERY LINE, MATERIAL INCLUDED, AND MUST STAY THERE.
    // It looks like dead input on a material row, because applyReceivedToStock()
    // skips any line carrying an ingredient_id before it reaches a stock call.
    // It is not: postRetailPOExpenses() sums COALESCE(qty_received, qty) across
    // every line with no kind branch, so this box is the ONLY way to record a
    // short material delivery. Remove it and a 15-of-20 delivery posts to
    // Expenses at 20. Tried and reverted 2026-08-27 — the banner above it was
    // the defect, not the input.
    return `<tr data-line="${it.id}">
      <td>${matBadge(it)}${nameLabel(it)}${lineSupplier ? `<div class="sub">${esc(lineSupplier)}</div>` : ''}${priceNote ? `<div class="sub pu2-num">${priceNote}</div>` : ''}</td>
      <td class="right pu2-num">${it.qty} ${esc(it.unit || '')}</td>
      <td><span class="pu2-qty"><input type="number" min="0" step="1" class="pu2-rq pu2-num" placeholder="${it.qty}" value="${it.qty_received != null ? it.qty_received : ''}" ${dis}></span></td>
      <td><span class="pu2-qty"><input type="number" min="0" step="1" class="pu2-rd pu2-num" value="${it.damaged_qty || ''}" ${dis}></span></td>
      <td><input type="text" class="pu2-input pu2-rt" value="${esc(it.tracking_number || '')}" style="width:130px" ${dis}></td>
      <td>${invoiceCell(it, poNoInvoice, dis)}</td>
      <td class="right pu2-num">${applied}${it.current_stock != null ? `<div class="sub">${esc(T('shelf', '现货'))} ${it.current_stock}</div>` : ''}</td>
    </tr>`;
  }

  // Print / send — opens a clean, self-contained PO document in a new window
  // (its own styles; no admin tokens) and triggers the browser print dialog,
  // which doubles as "save to PDF" to email the supplier.
  window.puPrintPO = function () {
    const p = _po;
    if (!p) return;
    const items = p.items || [];
    const total = p.total_cost || items.reduce((s, i) => s + (i.qty || 0) * (i.cost_per_unit || 0), 0);
    const e2 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = items.map(i => {
      const nm = [i.name_en, i.name_cn].filter(Boolean).join(' · ');
      const line = (i.qty || 0) * (i.cost_per_unit || 0);
      return `<tr><td>${e2(nm)}${i.sku ? ` <span class="sku">${e2(i.sku)}</span>` : ''}</td><td class="r">${i.qty} ${e2(unitLabel(i.unit))}</td><td class="r">${money(i.cost_per_unit || 0)}</td><td class="r">${money(line)}</td></tr>`;
    }).join('');
    const w = window.open('', '_blank', 'width=820,height=1040');
    if (!w) { toast(T('Allow pop-ups, then Print again', '请允许弹窗后再打印'), 'err'); return; }
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${e2(p.po_number)}</title>
      <style>
        *{box-sizing:border-box} body{font-family:'Inter',-apple-system,Arial,sans-serif;color:#111A2B;margin:44px;font-size:13px;line-height:1.5}
        .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111A2B;padding-bottom:14px;margin-bottom:20px}
        .wm{font-family:Georgia,serif;font-size:22px;letter-spacing:.18em;font-weight:300}
        h1{font-size:18px;font-weight:600;margin:0}
        .meta{color:#58606E;font-size:12px;margin-top:4px}
        table{width:100%;border-collapse:collapse;margin-top:8px}
        th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#58606E;border-bottom:1px solid #E4E0D5;padding:8px 6px}
        td{padding:9px 6px;border-bottom:1px solid #EEEDE7}
        .r{text-align:right}.sku{color:#9AA3B2;font-size:11px}
        tfoot td{font-weight:600;border-top:2px solid #111A2B;border-bottom:none}
        .note{margin-top:22px;color:#58606E;font-size:12px}
        @media print{body{margin:0}}
      </style></head><body>
      <div class="top">
        <div><div class="wm">tacet</div><div class="meta">${e2(T('Purchase order', '采购单'))}</div></div>
        <div style="text-align:right"><h1>${e2(p.po_number)}</h1><div class="meta">${e2(T('Date', '日期'))}: ${e2(p.date || '')}${p.delivery_date ? ` · ${e2(T('Expected', '预计'))}: ${e2(p.delivery_date)}` : ''}</div></div>
      </div>
      <div style="display:flex;gap:60px;margin-bottom:18px">
        <div><div class="meta">${e2(T('Supplier', '供应商'))}</div><div>${e2(p.supplier || '—')}</div></div>
        <div><div class="meta">${e2(T('Deliver to', '收货'))}</div><div>${storeLabel(p)}</div></div>
      </div>
      <table>
        <thead><tr><th>${e2(T('Product', '商品'))}</th><th class="r">${e2(T('Qty', '数量'))}</th><th class="r">${e2(T('Cost each', '单价'))}</th><th class="r">${e2(T('Line', '小计'))}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3" class="r">${e2(T('Total', '合计'))}</td><td class="r">${money(total)}</td></tr></tfoot>
      </table>
      ${p.notes ? `<div class="note">${e2(p.notes)}</div>` : ''}
      </body></html>`;
    w.document.write(doc);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (_) {} }, 350);
  };

  window.puReceiveSave = async function () {
    if (!_po) return;
    const receipts = [];
    document.querySelectorAll('#pu2-root tr[data-line]').forEach(tr => {
      const ri = tr.querySelector('.pu2-ri');
      // Every row renders an Arrived box today, so this guard never fires. It
      // is here because if one ever doesn't, the field must be OMITTED rather
      // than sent as null: the route writes only the columns the payload names,
      // so an absent field preserves the stored qty_received while a null
      // blanks it — and a blanked qty_received re-posts that line to Expenses
      // at the full ordered quantity (postRetailPOExpenses coalesces to qty).
      // Same shape as the `ri` guard above, which does fire.
      const rq = tr.querySelector('.pu2-rq');
      receipts.push({
        line_id: parseInt(tr.dataset.line, 10),
        ...(rq ? { qty_received: rq.value === '' ? null : rq.value } : {}),
        damaged_qty: tr.querySelector('.pu2-rd').value || 0,
        tracking_number: tr.querySelector('.pu2-rt').value,
        // Absent on a PO-level no-invoice line — leave the field off entirely
        // there rather than sending a value the row never offered.
        ...(ri ? { invoice_status: ri.value } : {}),
      });
    });
    try {
      const r = await api('/api/retail-admin/purchases/' + _po.id + '/receive', { method: 'PUT', body: { receipts } });
      const bits = [];
      if (r.stock_lines_adjusted) bits.push(T(`stock updated ×${r.stock_lines_adjusted}`, `库存已更新 ×${r.stock_lines_adjusted}`));
      if (r.missing_lines) bits.push(T(`${r.missing_lines} short`, `${r.missing_lines} 短缺`));
      if (r.damaged_lines) bits.push(T(`${r.damaged_lines} damaged`, `${r.damaged_lines} 破损`));
      toast(T('Received ✓', '已收货 ✓') + (bits.length ? ' — ' + bits.join(' · ') : ''), 'ok', 4000);
      // A receipt that carried arrived counts now moves the order to Delivered
      // server-side, so the LIST behind this screen is stale too — its segment
      // counts and status pills read the old status until reloaded. Reload it
      // the same way puSetStatus does, for the same reason.
      if (r.status && r.status !== _po.status) await loadPOs();
      puOpenPO(_po.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  // The invoice picker saves the moment it changes. It used to ride along on
  // Confirm delivery, so recording "this supplier issues no 发票" meant booking
  // stock and flipping the order to received — for goods still in transit. The
  // two facts are unrelated, so this one stands on its own route.
  window.puSaveLineInvoice = async function (sel, lineId) {
    if (!_po) return;
    const v = sel.value;
    const was = sel.dataset.saved || '';
    sel.disabled = true;
    try {
      await api(`/api/retail-admin/purchasing/po/${_po.id}/line/${lineId}/invoice-status`,
                { method: 'PUT', body: { invoice_status: v } });
      // Keep the in-memory PO in step so a re-render (or Confirm delivery) does
      // not paint the old value back over what was just saved.
      const it = (_po.items || []).find(i => Number(i.id) === Number(lineId));
      if (it) { it.invoice_status = v; it.no_invoice_expected = v === 'no_invoice' ? 1 : 0; }
      sel.dataset.saved = v;
      toast(T('Invoice status saved ✓', '发票状态已保存 ✓'), 'ok');
    } catch (e) {
      if (was) sel.value = was;
      toast(e.message, 'err');
    } finally { sel.disabled = false; }
  };
  window.puAllArrived = function () { puSetStatus('Delivered'); };
  window.puBackorder = async function () {
    if (!_po) return;
    try {
      const r = await api('/api/retail-admin/purchases/' + _po.id + '/backorder', { method: 'POST' });
      toast(T('Back-order created ✓', '已生成缺货补单 ✓'), 'ok');
      await loadPOs();
      puOpenPO(r.id);
    } catch (e) {
      toast(e.code === 'nothing_outstanding' ? T('No short items to back-order', '没有缺货项目') : e.message, 'err');
    }
  };
  // A reversal the server refused because the goods are no longer on the shelf.
  // The headline is `undoBlocked`, the locked pair in
  // docs/tacet-delivery-vocabulary.md ("Receipt reversal refused — purchasing",
  // LOCKED 2026-08-27). Both of its halves are load-bearing — refused, AND
  // nothing was written — and neither may be trimmed here for space.
  //
  // ONE renderer for all three entry points (Undo receiving, Back to draft,
  // Cancel order). They report the same fact and the document says they must
  // not diverge, so they share this function rather than each writing their own.
  //
  // Per-product lines reuse the `${n} short · ${n} 短缺` pair already live in
  // this file's receive toast; it is deliberately not re-minted.
  // askCustom is the blessed path for a body that is more than one message —
  // building .tdlg-scrim markup by hand skips injectStyle() and paints
  // unstyled divs (see public/tacet-dialogs.js).
  function puShowUndoBlocked(blocking) {
    const rows = (blocking || []).map(b => {
      // nameLabel already escapes, and returns '—' when a line carries no name
      // at all — show the product id in that case rather than a bare dash.
      const nm = (b.name_en || b.name_cn)
        ? nameLabel({ name_en: b.name_en, name_cn: b.name_cn })
        : esc('#' + b.product_id);
      return `<div class="lc-row"><span class="g">${nm}</span><span class="pu2-num">${esc(T(`${b.short} short`, `${b.short} 短缺`))}</span></div>`;
    }).join('');
    const body = `
      <h3 class="tdlg-title">${esc(T('Cannot undo this delivery', '无法撤销此次收货'))}</h3>
      <p class="tdlg-msg">${esc(T('Some of these goods have already left stock, so this delivery cannot be undone — nothing was changed.',
                                  '部分货品已出库，此次收货无法撤销 — 未作任何更改。'))}</p>
      ${rows ? `<div class="pu2-lc-grid" style="margin-top:12px">${rows}</div>` : ''}`;
    const foot = `<button class="tdlg-btn tdlg-btn--primary" data-close>${esc(T('Close', '关闭'))}</button>`;
    const { scrim, closer, ready } = askCustom('tdlg-danger', body, foot, '[data-close]');
    scrim.querySelector('[data-close]').addEventListener('click', () => closer(null));
    return ready;
  }
  // Every reversal entry point funnels its failure through here so the refusal
  // is never reduced to a toast on one screen and a modal on another.
  async function puReversalError(e) {
    if (e && e.code === 'undo_blocked') { await puShowUndoBlocked(e.data && e.data.blocking); return; }
    toast(e.message, 'err');
  }
  window.puSetStatus = async function (status) {
    if (!_po) return;
    if (status === 'Cancelled' && !(await askConfirm({
      title: T('Cancel this order?', '确定取消该采购单？'),
      confirmLabel: T('Cancel order', '取消采购单'),
      danger: true,
    }))) return;
    try {
      await api('/api/retail-admin/purchases/' + _po.id + '/status', { method: 'PUT', body: { status } });
      toast(T('Saved ✓', '已保存 ✓'), 'ok');
      await loadPOs(); puOpenPO(_po.id);
    } catch (e) { await puReversalError(e); }
  };
  window.puUndoReceive = async function () {
    if (!_po) return;
    if (!(await askConfirm({
      title: T('Undo receiving?', '撤销收货？'),
      body: T('Pulls back any stock this delivery added and returns the order to Sent.', '撤回该次收货已入库的数量，订单退回"已下单"状态。'),
      confirmLabel: T('Undo receiving', '撤销收货'),
      danger: true,
    }))) return;
    try {
      await api('/api/retail-admin/purchases/' + _po.id + '/undo-receive', { method: 'PUT' });
      toast(T('Undone ✓', '已撤销 ✓'), 'ok');
      await loadPOs(); puOpenPO(_po.id);
    } catch (e) { await puReversalError(e); }
  };
  window.puReorder = async function (id) {
    try {
      const r = await api('/api/retail-admin/purchases/' + id);
      const po = r.data;
      _edit = {
        id: null, po_number: null, date: todayGz(), delivery_date: '',
        supplier: po.supplier || '', store_id: po.store_id || _stores[0]?.id || null, notes: '',
        items: (po.items || []).map(i => ({
          store_product_id: i.store_product_id, ingredient_id: i.ingredient_id,
          name_en: i.name_en, name_cn: i.name_cn, sku: i.sku,
          qty: i.qty, unit: i.unit || 'pcs', cost_per_unit: i.cost_per_unit,
          expense_category: i.expense_category || '', purchase_channel: i.purchase_channel || '',
          current_stock: i.current_stock,
        })),
      };
      _wstep = 2; _screen = 'wizard'; paint();
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  INVOICES 发票 — chasing what suppliers still owe us on paper
  // ═══════════════════════════════════════════════════════════════════════════
  // ORGANISED AROUND THE CHASE, not around accounts payable. Roots' job here
  // is "who still hasn't sent us a 发票, and for how much" — so the screen is
  // grouped by supplier, expandable to the lines, with AWAITING as the
  // headline. The due-date / paid / aging fields are kept and still shown,
  // because another tenant may genuinely be tracking payables, but they sit in
  // a secondary strip rather than organising the page.
  //
  // Every figure comes from the server computed per line at read time
  // (routes/retail-purchasing.js lineStatus) — nothing here stores or caches a
  // state, and po_line_items.invoice_status is never read.
  //
  // TENANT-SCOPED, NOT SCOPE-SCOPED. The rows this screen shows sit on
  // kitchen-scope POs, which is the whole point: that is where Roots' unpaid
  // paperwork lives. Invoices created here are stamped scope='retail' so the
  // kitchen screen can no longer delete them — which it did, once, to a real
  // row (see the note in routes/finance.js).
  const INV_META = {
    fully_invoiced:      () => ({ label: T('Fully invoiced', '已开票'),  cls: 'sage'  }),
    partially_invoiced:  () => ({ label: T('Partial', '部分开票'),        cls: 'amber' }),
    awaiting:            () => ({ label: T('Awaiting', '待开票'),         cls: 'brick' }),
    no_invoice_expected: () => ({ label: T('No invoice', '不开发票'),      cls: 'grey'  }),
  };

  async function loadInvOutstanding() {
    const qs = new URLSearchParams();
    if (_invMonth)  qs.set('month', _invMonth);
    if (_invSearch) qs.set('q', _invSearch);
    try { const r = await api('/api/retail-admin/purchasing/invoices/outstanding?' + qs); _invOut = r.data || null; }
    catch (_) { _invOut = null; }
  }
  async function loadInvList() {
    const qs = new URLSearchParams();
    if (_invMonth)  qs.set('month', _invMonth);
    if (_invSearch) qs.set('q', _invSearch);
    try { const r = await api('/api/retail-admin/purchasing/invoices?' + qs); _invList = r.data || []; }
    catch (_) { _invList = []; }
  }
  const invGroup = sup => (_invOut && _invOut.groups.find(g => g.supplier === sup)) || null;
  const invLinesFor = sup => (invGroup(sup) || {}).lines || [];

  function paintInvoices() {
    root().innerHTML = `${puChrome('invoices')}<div id="pu2-inv-body"><div class="pu2-loading">${esc(T('Loading…', '加载中…'))}</div></div>`;
    try { applyCapGates(); } catch (_) {}
    (async () => {
      await Promise.all([loadInvOutstanding(), loadInvList()]);
      if (_screen === 'invoices') renderInvBody();
    })();
  }

  async function invReload() {
    await Promise.all([loadInvOutstanding(), loadInvList()]);
    if (_screen === 'invoices') renderInvBody();
  }

  // Months offered are the ones actually present in what came back, so the
  // picker can never offer an empty month.
  function invMonthOptions() {
    const seen = new Set();
    (_invOut ? _invOut.groups : []).forEach(g => g.lines.forEach(l => { if (l.date) seen.add(l.date.slice(0, 7)); }));
    (_invList || []).forEach(i => { if (i.date) seen.add(i.date.slice(0, 7)); });
    if (_invMonth) seen.add(_invMonth);
    return [...seen].sort().reverse();
  }

  function renderInvBody() {
    const host = document.getElementById('pu2-inv-body');
    if (!host) return;
    const tot = (_invOut && _invOut.totals) || { total: 0, fully_invoiced: 0, partially_invoiced: 0, awaiting: 0, no_invoice_expected: 0, line_count: 0 };
    const aging = (_invOut && _invOut.aging) || { notDue: 0, dueSoon: 0, overdue: 0, overdueCount: 0 };
    const groups = (_invOut && _invOut.groups) || [];
    const filtered = !!(_invMonth || _invSearch);

    if (!groups.length && !(_invList || []).length && !filtered) {
      host.innerHTML = `<div class="pu2-card"><div class="pu2-empty">
        <div class="pu2-empty-ico">${I.box}</div>
        <h3>${esc(T('No invoices yet', '暂无发票'))}</h3>
        <p>${esc(T('When a supplier sends a 发票, record it here and match it to the lines it covers. Until then, anything you’ve ordered shows as awaiting one.', '供应商开票后,在此登记并与对应采购明细匹配。在此之前,已下单内容会显示为待开票。'))}</p>
        <button class="pu2-btn primary" data-cap="purchasing:invoices" onclick="puInvNew()"><span class="pu2-ic">${I.plus}</span>${esc(T('Add invoice', '添加发票'))}</button>
      </div></div>`;
      try { applyCapGates(); } catch (_) {}
      return;
    }

    const monthOpts = ['<option value="">' + esc(T('All months', '全部月份')) + '</option>']
      .concat(invMonthOptions().map(m => `<option value="${esc(m)}"${_invMonth === m ? ' selected' : ''}>${esc(m)}</option>`)).join('');
    const kpi = (key, val, foot) => {
      const m = INV_META[key]();
      return `<div class="pu2-card pu2-metric pu2-invkpi ${m.cls}"><div class="lab">${esc(m.label)}</div><div class="big pu2-num">${money(val)}</div><div class="foot">${esc(foot || '')}</div></div>`;
    };

    host.innerHTML = `
      <div class="pu2-invfilters">
        <span class="pu2-segbar">
          <span class="pu2-seg${_invView === 'suppliers' ? ' on' : ''}" onclick="puInvView('suppliers')">${esc(T('By supplier', '按供应商'))} <span class="n pu2-num">${groups.length}</span></span>
          <span class="pu2-seg${_invView === 'recorded' ? ' on' : ''}" onclick="puInvView('recorded')">${esc(T('Recorded', '已登记'))} <span class="n pu2-num">${(_invList || []).length}</span></span>
        </span>
        <select class="pu2-input pu2-invsel" onchange="puInvMonth(this.value)">${monthOpts}</select>
        <input class="pu2-input pu2-invq" type="search" id="pu2-invq" value="${esc(_invSearch)}"
               placeholder="${esc(T('Supplier, item or SKU', '供应商、产品或货号'))}" oninput="puInvSearch(this.value)">
        ${filtered ? `<button class="pu2-btn ghost sm" onclick="puInvClear()">${esc(T('Clear', '清除'))}</button>` : ''}
        <span class="spacer"></span>
        <button class="pu2-btn primary" data-cap="purchasing:invoices" onclick="puInvNew()"><span class="pu2-ic">${I.plus}</span>${esc(T('Add invoice', '添加发票'))}</button>
      </div>

      <div class="pu2-metricrow pu2-invrow">
        <div class="pu2-card pu2-metric"><div class="lab">${esc(T('Total purchases', '采购总额'))}</div><div class="big pu2-num">${money(tot.total)}</div><div class="foot">${tot.line_count} ${esc(T('lines', '条明细'))}</div></div>
        ${kpi('fully_invoiced', tot.fully_invoiced)}
        ${kpi('partially_invoiced', tot.partially_invoiced)}
        ${kpi('awaiting', tot.awaiting, T('chase these', '需跟进'))}
        ${kpi('no_invoice_expected', tot.no_invoice_expected)}
      </div>

      ${(aging.overdue || aging.dueSoon || aging.notDue) ? `
      <div class="pu2-agingstrip">
        <span class="pu2-mut">${esc(T('Of what you’ve recorded', '已登记发票中'))}:</span>
        ${aging.overdue ? `<span class="pu2-pill brick"><span class="dot"></span>${esc(T('Overdue', '逾期'))} ${money(aging.overdue)} · ${aging.overdueCount}</span>` : ''}
        ${aging.dueSoon ? `<span class="pu2-pill amber"><span class="dot"></span>${esc(T('Due soon', '即将到期'))} ${money(aging.dueSoon)}</span>` : ''}
        ${aging.notDue ? `<span class="pu2-pill grey">${esc(T('Not due', '未到期'))} ${money(aging.notDue)}</span>` : ''}
      </div>` : ''}

      <div class="pu2-invsection">${_invView === 'recorded'
        ? '<div class="pu2-card" id="pu2-invledger"></div>'
        : '<div class="pu2-card" id="pu2-invgroups"></div>'}</div>`;

    // Both renderers already no-op when their host isn't on the page, so the
    // inactive one costs nothing and neither has to know which view is showing.
    renderInvGroups();
    renderInvLedger();
    const q = document.getElementById('pu2-invq');
    if (q && _invFocusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    try { applyCapGates(); } catch (_) {}
  }

  // The Reach chip — the supplier's own channel, so a 发票 can be chased from
  // the row. taobao / alibaba / website open the link, phone dials, WeChat
  // opens the QR when one is on file. Not invoice data; supplier data.
  function invReachChip(reach) {
    if (!reach || !reach.type) return `<span class="pu2-mut">—</span>`;
    const meta = {
      taobao:  T('Taobao', '淘宝'), alibaba: T('Alibaba', '阿里巴巴'),
      website: T('Website', '网站'), phone: T('Phone', '电话'),
      wechat:  T('WeChat', '微信'),  other: T('Channel', '渠道'),
    }[reach.type] || reach.type;
    if (reach.type === 'wechat' || (!reach.link && reach.has_qr)) {
      return reach.has_qr
        ? `<button type="button" class="pu2-reach" onclick="event.stopPropagation();puInvReachQR(${reach.supplier_id})">${esc(meta)} →</button>`
        : `<span class="pu2-reach flat">${esc(meta)}</span>`;
    }
    if (reach.link) {
      let href = String(reach.link).trim();
      if (reach.type === 'phone') href = 'tel:' + href.replace(/[^\d+]/g, '');
      else if (!/^[a-z][a-z0-9+.\-]*:/i.test(href)) href = 'https://' + href.replace(/^\/+/, '');
      return `<a class="pu2-reach" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${esc(reach.link)}">${esc(meta)} →</a>`;
    }
    return `<span class="pu2-reach flat">${esc(meta)}</span>`;
  }

  window.puInvReachQR = async function (supplierId) {
    try {
      const r = await api('/api/retail-admin/suppliers/' + supplierId + '/channel-qr');
      billHost().innerHTML = `
        <div class="pu2-scrim" onclick="puInvCloseModal()"></div>
        <div class="pu2-modal pu2-qrmodal">
          <div class="pu2-modal-head"><div><h2>${esc(r.data.name)}</h2><div class="sub">${esc(T('Scan to reach them', '扫码联系'))}</div></div>
            <button class="pu2-btn ghost sm" style="margin-left:auto" onclick="puInvCloseModal()">✕</button></div>
          <div class="pu2-modal-body" style="text-align:center"><img src="${esc(r.data.qr)}" alt="" style="max-width:280px;width:100%;border-radius:10px"></div>
        </div>`;
    } catch (e) { toast(T('No QR on file', '暂无二维码'), 'err'); }
  };

  function renderInvGroups() {
    const el = document.getElementById('pu2-invgroups');
    if (!el) return;
    const groups = (_invOut && _invOut.groups) || [];
    if (!groups.length) {
      el.innerHTML = `<div class="pu2-emptyline">${esc(_invMonth || _invSearch ? T('Nothing matches those filters.', '没有匹配的内容。') : T('Nothing awaiting an invoice.', '没有待开票内容。'))}</div>`;
      return;
    }
    const cell = (v, key) => v > 0.005
      ? `<td class="right pu2-num ${INV_META[key]().cls}-t">${money(v)}</td>`
      : `<td class="right pu2-mut">—</td>`;
    el.innerHTML = `<table class="pu2-tbl pu2-invtbl"><thead><tr>
        <th class="arrowcol"></th>
        <th>${esc(T('Supplier', '供应商'))}</th>
        <th>${esc(T('Reach', '联系'))}</th>
        <th class="right">${esc(T('Total', '合计'))}</th>
        <th class="right">${esc(T('Fully invoiced', '已开票'))}</th>
        <th class="right">${esc(T('Partial', '部分开票'))}</th>
        <th class="right">${esc(T('Awaiting', '待开票'))}</th>
        <th class="right">${esc(T('No invoice', '不开发票'))}</th>
        <th></th>
      </tr></thead><tbody>
      ${groups.map((g, i) => {
        // A search result opens every group — the operator asked to see inside.
        const open = !!_invSearch || _invExpanded.has(g.supplier);
        const chase = (g.awaiting || 0) + (g.partially_invoiced || 0);
        const key = esc(g.supplier).replace(/'/g, "\\'");
        return `
          <tr class="grow" onclick="puInvToggleGroup('${key}')">
            <td class="arrowcol">${open ? I.chevDown : I.chevRight}</td>
            <td><b>${esc(supName(g.supplier, g.supplier_cn))}</b><div class="sub">${g.line_count} ${esc(T('lines', '条明细'))} · ${g.po_numbers.length} ${esc(T('orders', '张采购单'))}</div></td>
            <td onclick="event.stopPropagation()">${invReachChip(g.reach)}</td>
            <td class="right pu2-num"><b>${money(g.total)}</b></td>
            ${cell(g.fully_invoiced, 'fully_invoiced')}
            ${cell(g.partially_invoiced, 'partially_invoiced')}
            ${cell(g.awaiting, 'awaiting')}
            ${cell(g.no_invoice_expected, 'no_invoice_expected')}
            <td class="right" onclick="event.stopPropagation()">
              ${g.supplier === '未指定 Unspecified'
                ? `<span class="pu2-mut sm">${esc(T('Set a supplier on these lines first', '请先为这些明细设置供应商'))}</span>`
                : (chase > 0.005
                    ? `<button class="pu2-btn sm" data-cap="purchasing:invoices" onclick="puInvNew(${i})">${esc(T('Add invoice', '添加发票'))}</button>`
                    : `<span class="pu2-mut sm">${esc(T('All invoiced', '已全部开票'))}</span>`)}
            </td>
          </tr>
          <tr class="drill" ${open ? '' : 'hidden'}><td colspan="9">${invLinesHtml(g)}</td></tr>`;
      }).join('')}
      </tbody></table>`;
    try { applyCapGates(); } catch (_) {}
  }

  // The lines inside one supplier, grouped by the buying order they sit on so
  // the PO-level "no invoice" mark has somewhere honest to live.
  function invLinesHtml(g) {
    const byPo = new Map();
    for (const l of g.lines) {
      if (!byPo.has(l.po_number)) byPo.set(l.po_number, { po_id: l.po_id, po_number: l.po_number, date: l.date, po_no_invoice: l.po_no_invoice, lines: [] });
      byPo.get(l.po_number).lines.push(l);
    }
    return `<div class="pu2-invlines">${[...byPo.values()].map(po => `
      <div class="pogrp">
        <span class="pu2-mono">${esc(po.po_number)}</span>
        <span class="pu2-mut">${esc(po.date || '')}</span>
        <span class="spacer"></span>
        ${po.po_no_invoice
          ? `<span class="pu2-pill grey">${esc(T('No invoice', '不开发票'))}</span>
             <button class="pu2-btn ghost sm" data-cap="purchasing:invoices" onclick="puInvNoInvoicePO(${po.po_id}, false)">${esc(T('Restore', '恢复'))}</button>`
          : `<button class="pu2-btn ghost sm" data-cap="purchasing:invoices" title="${esc(T('This whole order will never have an invoice — cash or market', '整单不会开发票 —— 现金或市场采购'))}" onclick="puInvNoInvoicePO(${po.po_id}, true)">${esc(T('No invoice for this order', '整单不开发票'))}</button>`}
      </div>
      ${po.lines.map(l => {
        const m = INV_META[l.status]();
        return `<div class="lrow">
          <div class="nm">${nameLabel(l)}${l.sku ? `<div class="sub pu2-mono">${esc(l.sku)}</div>` : ''}</div>
          <span class="pu2-num">${money(l.amount)}</span>
          <span class="pu2-num pu2-mut">${l.covered > 0.005 ? esc(T('invoiced', '已开票')) + ' ' + money(l.covered) : ''}</span>
          <span class="pu2-pill ${m.cls}">${esc(m.label)}</span>
          <span class="act">${l.po_no_invoice ? ''
            : l.line_no_invoice
              ? `<button class="pu2-btn ghost sm" data-cap="purchasing:invoices" onclick="puInvNoInvoiceLine(${l.po_id},${l.line_id},false)">${esc(T('Restore', '恢复'))}</button>`
              : `<button class="pu2-btn ghost sm" data-cap="purchasing:invoices" title="${esc(T('This line will never have an invoice', '该明细不会开发票'))}" onclick="puInvNoInvoiceLine(${l.po_id},${l.line_id},true)">${esc(T('No invoice', '不开发票'))}</button>`}</span>
        </div>`;
      }).join('')}`).join('')}</div>`;
  }

  function renderInvLedger() {
    const el = document.getElementById('pu2-invledger');
    if (!el) return;
    if (!(_invList || []).length) {
      el.innerHTML = `<div class="pu2-emptyline">${esc(_invMonth || _invSearch ? T('No invoices match those filters.', '没有匹配的发票。') : T('No invoices recorded yet.', '还没有登记发票。'))}</div>`;
      return;
    }
    el.innerHTML = `<table class="pu2-tbl"><tbody>${_invList.map(inv => {
      const due = inv.paid ? `<span class="pu2-pill sage">${esc(T('Paid', '已付'))}</span>`
        : inv.overdue ? `<span class="pu2-pill brick"><span class="dot"></span>${esc(T('Overdue', '逾期'))}</span>`
        : inv.due_date ? `<span class="pu2-pill amber"><span class="dot"></span>${esc(T('Due', '应付'))} ${esc(inv.due_date)}</span>`
        : `<span class="pu2-pill grey">${esc(T('No due date', '无到期'))}</span>`;
      const pos = (inv.pos || []).map(p => p.po_number).join(', ');
      // An invoice whose allocations don't add up to its own header says so.
      // Live invoice 25 is short by exactly half; the screen reports that
      // rather than quietly reconciling it.
      const gap = Math.abs(inv.unallocated) > 0.005
        ? `<span class="pu2-pill amber" title="${esc(T('The lines ticked on this invoice don’t add up to its total', '该发票已勾选明细金额与发票总额不符'))}"><span class="dot"></span>${money(Math.abs(inv.unallocated))} ${esc(inv.unallocated > 0 ? T('unallocated', '未分配') : T('over', '超出'))}</span>`
        : '';
      return `<tr>
        <td><b>${esc(supName(inv.supplier, inv.supplier_cn))}</b>${inv.invoice_number ? `<div class="sub pu2-mono">${esc(inv.invoice_number)}</div>` : ''}
            <div class="sub pu2-num">${esc(inv.date)}${pos ? ' · ' + esc(pos) : ''}</div></td>
        <td class="right pu2-num">${money(inv.amount)}${gap ? '<div class="sub">' + gap + '</div>' : ''}</td>
        <td>${due}</td>
        <td class="right" style="white-space:nowrap">
          <button class="pu2-btn ghost sm" data-cap="purchasing:invoices" onclick="puInvEdit(${inv.id})">${esc(T('Edit', '编辑'))}</button>
          ${inv.paid
            ? `<button class="pu2-btn ghost sm" data-cap="purchasing:invoices" onclick="puInvPaid(${inv.id},false)">${esc(T('Undo', '撤销'))}</button>`
            : `<button class="pu2-btn sm" data-cap="purchasing:invoices" onclick="puInvPaid(${inv.id},true)">${esc(T('Mark paid', '标记已付'))}</button>`}
          <button class="pu2-btn ghost sm danger" data-cap="purchasing:invoices" title="${esc(T('Delete', '删除'))}" onclick="puInvDelete(${inv.id})">✕</button>
        </td>
      </tr>`;
    }).join('')}</tbody></table>`;
    try { applyCapGates(); } catch (_) {}
  }

  // ── filters ────────────────────────────────────────────────────────────────
  window.puInvMonth = async function (m) { _invMonth = m || ''; _invFocusQ = false; await invReload(); };
  window.puInvSearch = function (v) {
    _invSearch = v; _invFocusQ = true;
    clearTimeout(_invSearchTimer);
    _invSearchTimer = setTimeout(invReload, 250);
  };
  window.puInvView = function (v) {
    if (_invView === v) return;
    _invView = v;
    renderInvBody();
  };
  window.puInvClear = async function () { _invMonth = ''; _invSearch = ''; _invFocusQ = false; await invReload(); };
  window.puInvToggleGroup = function (sup) {
    if (_invExpanded.has(sup)) _invExpanded.delete(sup); else _invExpanded.add(sup);
    renderInvGroups();
  };

  // ── the no-invoice mark, both levels ──────────────────────────────────────
  window.puInvNoInvoicePO = async function (poId, flag) {
    try {
      await api(`/api/retail-admin/purchasing/po/${poId}/no-invoice`, { method: 'PUT', body: { no_invoice_expected: !!flag } });
      await invReload();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puInvNoInvoiceLine = async function (poId, lineId, flag) {
    try {
      await api(`/api/retail-admin/purchasing/po/${poId}/line/${lineId}/no-invoice`, { method: 'PUT', body: { no_invoice_expected: !!flag } });
      await invReload();
    } catch (e) { toast(e.message, 'err'); }
  };

  // ── the invoice modal — the same form for a new one and an edit ───────────
  function billHost() {
    // Mounted as a sibling of #pu2-root inside the pane; CSS is keyed on
    // #pu2-modal-host so it survives paint() rewrites of #pu2-root and never
    // gets clipped by a transformed ancestor.
    let h = document.getElementById('pu2-modal-host');
    if (!h) {
      h = document.createElement('div');
      h.id = 'pu2-modal-host';
      (document.getElementById('prod-view-purchasing') || document.body).appendChild(h);
    }
    return h;
  }
  window.puInvCloseModal = function () {
    _invDraft = null;
    const h = document.getElementById('pu2-modal-host');
    if (h) h.innerHTML = '';
  };
  window.puInvNew = function (groupIdx) {
    const groups = (_invOut && _invOut.groups) || [];
    const sup = (typeof groupIdx === 'number' && groups[groupIdx]) ? groups[groupIdx].supplier : '';
    _invDraft = { id: null, supplier: sup && sup !== '未指定 Unspecified' ? sup : '', invoice_number: '', date: todayGz(), due_date: '', amount: '', notes: '', alloc: {} };
    renderInvModal();
  };
  // Editing loads the invoice's OWN allocations into the draft, so the lines it
  // already covers arrive ticked. The server's headroom check ignores this
  // invoice's own rows, which is what lets an unchanged invoice be re-saved.
  window.puInvEdit = async function (id) {
    try {
      const r = await api('/api/retail-admin/purchasing/invoices/' + id);
      const inv = r.data;
      const alloc = {};
      (inv.lines || []).forEach(l => { alloc[l.line_id] = Number((l.allocated_amount || 0).toFixed(2)); });
      _invDraft = {
        id: inv.id, supplier: inv.supplier, invoice_number: inv.invoice_number || '',
        date: inv.date, due_date: inv.due_date || '', amount: inv.amount, notes: inv.notes || '',
        alloc, ownLines: inv.lines || [],
      };
      renderInvModal();
    } catch (e) { toast(e.message, 'err'); }
  };
  // The stored name stays the option's VALUE — it is the key every filter and
  // every save round-trips on. Only the label follows the current language.
  function invSupplierList() {
    const cn = new Map();
    ((_invOut && _invOut.groups) || []).forEach(g => { if (g.supplier_cn) cn.set(g.supplier, g.supplier_cn); });
    _suppliers.forEach(s => { if (s.name_cn) cn.set(s.name, s.name_cn); });
    const names = new Set();
    ((_invOut && _invOut.groups) || []).forEach(g => { if (g.supplier && g.supplier !== '未指定 Unspecified') names.add(g.supplier); });
    _suppliers.filter(s => s.is_active).forEach(s => names.add(s.name));
    if (_invDraft && _invDraft.supplier) names.add(_invDraft.supplier);
    return [...names].sort((a, b) => a.localeCompare(b)).map(n => ({ name: n, label: supName(n, cn.get(n)) }));
  }
  function invAllocated() {
    const d = _invDraft; if (!d) return 0;
    return Object.values(d.alloc).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  }
  // The lines the modal can allocate against: everything still open for this
  // supplier, PLUS the lines this invoice already covers (which are no longer
  // "open" precisely because this invoice covers them, and would otherwise
  // vanish from the form the moment you opened it to edit).
  function invModalLines() {
    const d = _invDraft; if (!d) return [];
    const open = invLinesFor(d.supplier).filter(l => l.status !== 'no_invoice_expected');
    const seen = new Set(open.map(l => l.line_id));
    const own = (d.ownLines || []).filter(l => !seen.has(l.line_id)).map(l => ({
      line_id: l.line_id, name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
      po_number: l.po_number, date: l.po_date,
      amount: Math.round(((l.qty || 0) * (l.cost_per_unit || 0)) * 100) / 100,
      outstanding: 0,
    }));
    return [...open, ...own];
  }
  function renderInvModal() {
    const d = _invDraft; if (!d) return;
    const lines = invModalLines();
    const byPo = new Map();
    lines.forEach(l => { if (!byPo.has(l.po_number)) byPo.set(l.po_number, []); byPo.get(l.po_number).push(l); });
    const supOpts = ['<option value="">' + esc(T('Choose a supplier', '选择供应商')) + '</option>']
      .concat(invSupplierList().map(o => `<option value="${esc(o.name)}"${o.name === d.supplier ? ' selected' : ''}>${esc(o.label)}</option>`)).join('');
    const allocRows = lines.length
      ? [...byPo.entries()].map(([po, ls]) => `
          <div class="pu2-pogrp">${esc(po)}</div>
          ${ls.map(l => {
            const on = d.alloc[l.line_id] != null;
            const own = (d.ownLines || []).some(x => x.line_id === l.line_id);
            const headroom = (l.outstanding || 0) + (own ? (parseFloat(d.alloc[l.line_id]) || 0) : 0);
            return `<div class="pu2-allocrow">
              <span class="pu2-chk${on ? ' on' : ''}" onclick="puInvToggle(${l.line_id})">${on ? I.check : ''}</span>
              <div>${nameLabel(l)}${l.sku ? `<div class="sub pu2-mono">${esc(l.sku)}</div>` : ''}</div>
              <div class="pu2-num pu2-mut">${money(headroom)} ${esc(T('open', '待开'))}</div>
              <input type="number" min="0" step="0.01" class="pu2-input pu2-num pu2-allocin" data-line="${l.line_id}" value="${on ? esc(d.alloc[l.line_id]) : ''}" placeholder="0" oninput="puInvAlloc(${l.line_id}, this.value)">
            </div>`;
          }).join('')}`).join('')
      : `<div class="pu2-emptyline">${esc(d.supplier ? T('No open lines for this supplier — you can still record the invoice.', '该供应商暂无待开票明细 —— 仍可登记发票。') : T('Pick a supplier to see what’s open.', '选择供应商以查看待开票明细。'))}</div>`;
    billHost().innerHTML = `
      <div class="pu2-scrim" onclick="puInvCloseModal()"></div>
      <div class="pu2-modal">
        <div class="pu2-modal-head">
          <div><h2>${esc(d.id ? T('Edit invoice', '编辑发票') : T('Add invoice', '添加发票'))}</h2>
               <div class="sub">${esc(T('Match a supplier’s invoice to the lines it covers.', '将供应商发票匹配到对应采购明细。'))}</div></div>
          <button class="pu2-btn ghost sm" style="margin-left:auto" onclick="puInvCloseModal()">✕</button>
        </div>
        <div class="pu2-modal-body">
          <div class="pu2-fgrid three">
            <label class="pu2-f"><span class="lbl">${esc(T('Supplier', '供应商'))}</span><select class="pu2-input" onchange="puInvField('supplier', this.value)">${supOpts}</select></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Invoice no.', '发票号'))}</span><input class="pu2-input" value="${esc(d.invoice_number)}" placeholder="${esc(T('Optional', '可选'))}" onchange="puInvField('invoice_number', this.value)"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Amount ¥', '金额 ¥'))}</span><input class="pu2-input pu2-num" type="number" min="0" step="0.01" value="${esc(d.amount)}" oninput="puInvField('amount', this.value)"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Invoice date', '开票日期'))}</span><input class="pu2-input" type="date" value="${esc(d.date)}" onchange="puInvField('date', this.value)"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Due date', '到期日'))}</span><input class="pu2-input" type="date" value="${esc(d.due_date)}" onchange="puInvField('due_date', this.value)"></label>
            <label class="pu2-f"><span class="lbl">${esc(T('Note', '备注'))}</span><input class="pu2-input" value="${esc(d.notes)}" placeholder="${esc(T('Optional', '可选'))}" onchange="puInvField('notes', this.value)"></label>
          </div>
          <div class="pu2-alloc-head">
            <span class="pu2-kicker" style="margin:0">${esc(T('What it covers', '涵盖内容'))}</span>
            <button class="pu2-btn sm" style="margin-left:auto" onclick="puInvAutoMatch()">${esc(T('Match to amount', '按金额匹配'))}</button>
          </div>
          <div class="pu2-alloclist">${allocRows}</div>
        </div>
        <div class="pu2-modal-foot">
          <span id="pu2-allocbadge">${invBadgeHtml()}</span>
          <span class="spacer"></span>
          <button class="pu2-btn ghost" onclick="puInvCloseModal()">${esc(T('Cancel', '取消'))}</button>
          <button class="pu2-btn primary" onclick="puInvSave()">${esc(d.id ? T('Save changes', '保存更改') : T('Save invoice', '保存发票'))}</button>
        </div>
      </div>`;
  }
  function invBadgeHtml() {
    const allocated = invAllocated();
    const amt = parseFloat((_invDraft || {}).amount) || 0;
    const diff = amt - allocated;
    if (Math.abs(diff) < 0.01) return `<span class="pu2-pill sage"><span class="dot"></span>${esc(T('Allocated', '已分配'))} ${money(allocated)}</span> <span class="pu2-mut">${esc(T('nothing left over', '正好'))}</span>`;
    if (diff > 0) return `<span class="pu2-pill grey">${esc(T('Allocated', '已分配'))} ${money(allocated)}</span> <span class="pu2-mut">${money(diff)} ${esc(T('unallocated', '未分配'))}</span>`;
    return `<span class="pu2-pill amber"><span class="dot"></span>${esc(T('Allocated', '已分配'))} ${money(allocated)}</span> <span class="pu2-mut">${money(-diff)} ${esc(T('over the invoice', '超出发票'))}</span>`;
  }
  // Live badge refresh WITHOUT re-rendering the modal — so typing in the amount
  // or an allocation field never loses focus mid-keystroke.
  function updateInvBadge() {
    const b = document.getElementById('pu2-allocbadge');
    if (b && _invDraft) b.innerHTML = invBadgeHtml();
  }
  window.puInvField = function (field, val) {
    if (!_invDraft) return;
    _invDraft[field] = val;
    if (field === 'supplier') { _invDraft.alloc = {}; renderInvModal(); }   // structural → re-render
    else updateInvBadge();
  };
  window.puInvToggle = function (lineId) {
    if (!_invDraft) return;
    if (_invDraft.alloc[lineId] != null) delete _invDraft.alloc[lineId];
    else {
      const l = invModalLines().find(x => x.line_id === lineId);
      _invDraft.alloc[lineId] = l ? Number((l.outstanding || 0).toFixed(2)) : 0;
    }
    renderInvModal();
  };
  window.puInvAlloc = function (lineId, val) {
    if (!_invDraft) return;
    if (val === '' || val == null) delete _invDraft.alloc[lineId];
    else _invDraft.alloc[lineId] = val;
    updateInvBadge();
  };
  window.puInvAutoMatch = function () {
    if (!_invDraft) return;
    let target = parseFloat(_invDraft.amount) || 0;
    _invDraft.alloc = {};
    if (target > 0) {
      for (const l of invModalLines()) {
        if (target <= 0.01) break;
        const take = Math.min(target, l.outstanding || 0);
        if (take > 0.01) { _invDraft.alloc[l.line_id] = Number(take.toFixed(2)); target -= take; }
      }
    }
    renderInvModal();
  };
  window.puInvSave = async function () {
    const d = _invDraft; if (!d) return;
    if (!d.supplier) { toast(T('Choose a supplier', '请选择供应商'), 'err'); return; }
    if (!(parseFloat(d.amount) > 0)) { toast(T('Enter the invoice amount', '请输入发票金额'), 'err'); return; }
    const links = Object.entries(d.alloc)
      .map(([line_id, allocated_amount]) => ({ line_id: parseInt(line_id, 10), allocated_amount: parseFloat(allocated_amount) || 0 }))
      .filter(l => l.allocated_amount > 0);
    const body = {
      supplier: d.supplier, invoice_number: d.invoice_number || null, amount: parseFloat(d.amount),
      date: d.date, due_date: d.due_date || null, notes: d.notes || null, links,
    };
    try {
      if (d.id) await api('/api/retail-admin/purchasing/invoices/' + d.id, { method: 'PUT', body });
      else      await api('/api/retail-admin/purchasing/invoices', { method: 'POST', body });
      toast(d.id ? T('Saved ✓', '已保存 ✓') : T('Invoice recorded ✓', '发票已登记 ✓'), 'ok');
      puInvCloseModal();
      await invReload();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puInvPaid = async function (id, paid) {
    try {
      await api('/api/retail-admin/purchasing/invoices/' + id + '/paid', { method: 'PUT', body: { paid } });
      await invReload();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puInvDelete = async function (id) {
    if (!(await askConfirm({
      title: T('Delete this invoice?', '确定删除该发票?'),
      body: T('The lines it covers go back to awaiting an invoice.', '其涵盖的采购明细将恢复为待开票。'),
      confirmLabel: T('Delete invoice', '删除发票'),
      danger: true,
    }))) return;
    try {
      await api('/api/retail-admin/purchasing/invoices/' + id, { method: 'DELETE' });
      toast(T('Deleted', '已删除'), 'ok');
      await invReload();
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  REORDER — what's running low, grouped by who you'd buy it from
  // ═══════════════════════════════════════════════════════════════════════════
  async function loadReorder() { try { const r = await api('/api/retail-admin/reorder'); _reorder = r.data || []; } catch (_) { _reorder = []; } }

  function paintReorder() {
    root().innerHTML = `${puChrome('reorder')}<div id="pu2-reorder-body"><div class="pu2-loading">${esc(T('Loading…', '加载中…'))}</div></div>`;
    try { applyCapGates(); } catch (_) {}
    (async () => { await loadReorder(); if (_screen === 'reorder') renderReorderBody(); })();
  }
  function renderReorderBody() {
    const host = document.getElementById('pu2-reorder-body');
    if (!host) return;
    if (!_reorder.length) {
      host.innerHTML = `<div class="pu2-card"><div class="pu2-empty">
        <div class="pu2-empty-ico">${I.check}</div>
        <h3>${esc(T('Nothing’s running low', '库存都很充足'))}</h3>
        <p>${esc(T('Every product is above its buffer across your stores. Nothing to reorder right now.', '各门店商品均高于安全库存,暂时无需补货。'))}</p>
      </div></div>`;
      return;
    }
    host.innerHTML = `<div class="pu2-reo">${_reorder.map((g, i) => {
      const units = g.items.reduce((s, x) => s + (x.suggest || 0), 0);
      return `<div class="pu2-card pu2-reocard">
        <div class="top">
          <span class="sup">${esc(g.supplier || T('No preferred supplier yet', '暂无常用供应商'))}</span>
          <span class="pu2-pill amber" style="margin-left:auto"><span class="dot"></span>${g.items.length} ${esc(T('low', '偏低'))}</span>
        </div>
        <div class="sub">${esc(g.store_name)}</div>
        <div class="lines2">
          ${g.items.slice(0, 6).map(it => `<div class="l2"><span>${nameLabel(it)}</span><span class="cover pu2-num">${it.physical_qty} ${esc(T('left', '剩'))} · ${esc(T('buffer', '安全'))} ${it.buffer}</span></div>`).join('')}
          ${g.items.length > 6 ? `<div class="l2 pu2-mut">+${g.items.length - 6} ${esc(T('more', '更多'))}</div>` : ''}
        </div>
        <div class="foot">
          <span class="amt pu2-num">${units} ${esc(T('units suggested', '件建议'))}</span>
          <button class="pu2-btn sm" data-cap="purchasing:edit" onclick="puReorderDraft(${i})">${esc(T('Open draft order', '生成草稿单'))}</button>
        </div>
      </div>`;
    }).join('')}</div>`;
    try { applyCapGates(); } catch (_) {}
  }
  window.puReorderDraft = function (idx) {
    const g = _reorder[idx];
    if (!g) return;
    _edit = {
      id: null, po_number: null, date: todayGz(), delivery_date: '',
      supplier: g.supplier || '', store_id: g.store_id, notes: '',
      items: g.items.map(it => ({
        store_product_id: it.product_id, name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
        qty: it.suggest, unit: 'pcs', cost_per_unit: 0, expense_category: '门店进货 Retail stock',
        purchase_channel: '', supplier_name: g.supplier || '', current_stock: it.physical_qty,
      })),
    };
    _wstep = 2; _screen = 'wizard'; paint();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRICE HISTORY — one product, every supplier, cost over time
  // ═══════════════════════════════════════════════════════════════════════════
  window.puPriceHistory = async function (spid) {
    try {
      _phBack = (_screen === 'pricehist') ? _phBack : _screen;
      const r = await api('/api/retail-admin/products/' + spid + '/suppliers');
      _ph = r.data; _screen = 'pricehist'; paint();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.puPriceBack = function () { _screen = _phBack || 'orders'; _ph = null; paint(); };

  // Build a 220×46 sparkline path from a chronological [{cost}] series.
  function sparkPath(series) {
    const pts = (series || []).filter(s => s.cost != null).map(s => Number(s.cost));
    if (pts.length < 2) return null;
    const W = 220, H = 46, pad = 5;
    const min = Math.min(...pts), max = Math.max(...pts), range = (max - min) || 1;
    const n = pts.length;
    const coords = pts.map((v, i) => [(i / (n - 1)) * W, H - pad - ((v - min) / range) * (H - 2 * pad)]);
    const line = 'M' + coords.map(c => c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' L');
    const last = coords[coords.length - 1];
    return { line, area: line + ` L${W},${H} L0,${H} Z`, dotX: last[0].toFixed(1), dotY: last[1].toFixed(1) };
  }

  function paintPriceHistory() {
    const d = _ph;
    if (!d) { _screen = 'orders'; paint(); return; }
    const pr = d.product || {}, st = d.stats || {}, last = d.last || {}, sups = d.suppliers || [];
    const sp = sparkPath(d.series || []);
    const cheapest = sups.length ? sups.reduce((a, b) => (Number(b.min_cost) < Number(a.min_cost) ? b : a)) : null;
    const priciest = sups.length ? sups.reduce((a, b) => (Number(b.max_cost) > Number(a.max_cost) ? b : a)) : null;
    const tile = (lab, val, foot) => `<div class="pu2-card pu2-metric"><div class="lab">${esc(lab)}</div><div class="big pu2-num">${val}</div><div class="foot">${esc(foot || '')}</div></div>`;
    const hasHist = d.series && d.series.length;
    root().innerHTML = `
      <div class="pu2-wizhead">
        <button class="pu2-btn ghost sm" onclick="puPriceBack()"><span class="pu2-ic">${I.back}</span>${esc(T('Back', '返回'))}</button>
        <h1>${nameLabel(pr)}</h1>
        ${pr.sku ? `<span class="pu2-pill grey pu2-mono">${esc(pr.sku)}</span>` : ''}
      </div>
      ${!hasHist ? `<div class="pu2-card"><div class="pu2-empty"><div class="pu2-empty-ico">${I.box}</div>
        <h3>${esc(T('No purchase history yet', '暂无采购记录'))}</h3>
        <p>${esc(T('Once you buy this product on an order, its price history shows here.', '在采购单中购买该商品后,这里会显示价格历史。'))}</p></div></div>` : `
      <div class="pu2-metricrow" style="margin:0 0 16px">
        ${tile(T('Last paid', '上次'), money(last.cost || st.avg_cost || 0), last.supplier ? esc(last.supplier) + (last.date ? ' · ' + esc(last.date) : '') : '')}
        ${tile(T('Average', '均价'), money(st.avg_cost || 0), st.order_count ? st.order_count + ' ' + T('orders', '次') : '')}
        ${tile(T('Range', '区间'), money(st.min_cost || 0) + '–' + fmt(st.max_cost || 0), [cheapest && cheapest.supplier ? T('low', '低') + ' ' + cheapest.supplier : '', priciest && priciest.supplier ? T('high', '高') + ' ' + priciest.supplier : ''].filter(Boolean).join(' · '))}
        ${tile(T('Bought', '采购'), (st.total_qty || 0), st.first_date ? T('since', '自') + ' ' + esc(st.first_date) : '')}
      </div>
      <div class="pu2-card" style="padding:20px 22px; margin-bottom:16px">
        <div class="pu2-kicker" style="margin:0 0 10px">${esc(T('What it has cost you', '历史成本'))}</div>
        ${sp ? `<svg class="pu2-spark" viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${sp.area}"/><path class="line" d="${sp.line}"/><circle class="dot" cx="${sp.dotX}" cy="${sp.dotY}" r="2.6"/></svg>
        <div class="pu2-num" style="font-size:12px;color:var(--td-text2);display:flex;justify-content:space-between;max-width:220px;margin-top:6px"><span>${esc(st.first_date || '')}</span><span>${esc(T('now', '现在'))} ${money(last.cost || 0)}</span></div>` : `<div class="sub">${esc(T('Need at least two purchases to chart a trend.', '至少两次采购才能绘制趋势。'))}</div>`}
      </div>`}
      <div class="pu2-kicker">${esc(T('Who sells it', '供应来源'))} — ${sups.length} ${esc(T('suppliers', '家'))}</div>
      <div class="pu2-card">
        <table class="pu2-tbl">
          <thead><tr><th>${esc(T('Supplier', '供应商'))}</th><th class="right">${esc(T('Last paid', '上次'))}</th><th class="right">${esc(T('Average', '均价'))}</th><th class="right">${esc(T('Times', '次数'))}</th></tr></thead>
          <tbody>${sups.length ? sups.map((s, i) => `<tr>
            <td><b>${esc(s.supplier || T('Unrecorded', '未记录'))}</b>${i === 0 ? ` <span class="pu2-tagstar">${I.star}${esc(T('Preferred', '常用'))}</span>` : ''}</td>
            <td class="right pu2-num">${money(s.last_cost || 0)}</td>
            <td class="right pu2-num">${s.avg_cost != null ? money(s.avg_cost) : '—'}</td>
            <td class="right pu2-num">${s.order_count}</td></tr>`).join('') : `<tr><td colspan="4"><div class="pu2-emptyline">${esc(T('No supplier history yet.', '暂无供应商记录。'))}</div></td></tr>`}</tbody>
        </table>
      </div>`;
    try { applyCapGates(); } catch (_) {}
  }

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
          <p>${esc(T('Add the businesses you buy from. Once they’re here, every order and invoice can lean on them — and each product remembers who sells it and for how much.', '添加你的供货商。加入后,采购单和发票都能用上它们 —— 每件商品也会记住由谁供货、价格多少。'))}</p>
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
        <td><b>${esc(supName(s.name, s.name_cn))}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</td>
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
        <h1>${s.id ? esc(supName(s.name, s.name_cn)) : esc(T('New supplier', '新建供应商'))}</h1>
        ${s.id && !s.is_active ? `<span class="pu2-pill grey">${esc(T('Disabled', '已停用'))}</span>` : ''}
        ${s.id ? `<span class="spacer"></span><button class="pu2-btn primary" data-cap="purchasing:edit" onclick="puNewOrderFor(${s.id})">${esc(T('New order', '新建采购单'))}</button>` : ''}
      </div>

      ${s.id && s.scorecard ? supplierScorecard(s) : ''}

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
  function supplierScorecard(s) {
    const sc = s.scorecard || {};
    const tile = (lab, val, foot) => `<div class="pu2-card pu2-metric"><div class="lab">${esc(lab)}</div><div class="big pu2-num">${val}</div><div class="foot">${esc(foot || '')}</div></div>`;
    return `<div class="pu2-metricrow" style="margin:0 0 16px">
      ${tile(T('Orders', '采购单'), sc.order_count || 0, sc.last_date ? T('last', '最近') + ' ' + sc.last_date : T('none yet', '暂无'))}
      ${tile(T('Spend, all time', '累计采购'), money(sc.spend || 0), '')}
      ${tile(T('Owed now', '当前应付'), money(sc.owed || 0), (sc.owed_count || 0) + ' ' + T('invoices', '张发票'))}
      ${tile(T('Products', '商品'), sc.product_count || 0, T('bought before', '曾采购'))}
    </div>`;
  }
  function supplierPriceList(s) {
    const pl = s.price_list || [];
    if (!pl.length) return '';
    return `<div class="pu2-card pu2-block" style="max-width:none">
      <b>${esc(T('Price list — what you’ve bought from them', '价格清单 —— 曾向其采购'))}</b>
      <table class="pu2-tbl" style="margin-top:8px">
        <thead><tr><th>${esc(T('Product', '商品'))}</th><th class="right">${esc(T('Last paid', '上次'))}</th><th class="right">${esc(T('Average', '均价'))}</th><th class="right">${esc(T('Times', '次数'))}</th></tr></thead>
        <tbody>${pl.map(p => `<tr onclick="puPriceHistory(${p.store_product_id})">
          <td>${nameLabel(p)}${p.sku ? `<div class="sub pu2-mono">${esc(p.sku)}</div>` : ''}</td>
          <td class="right pu2-num">${money(p.last_cost || 0)}</td>
          <td class="right pu2-num">${p.avg_cost != null ? money(p.avg_cost) : '—'}</td>
          <td class="right pu2-num">${p.times}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }
  window.puNewOrderFor = function (supId) {
    const name = (_sup && _sup.id === supId) ? _sup.name : (_suppliers.find(x => x.id === supId)?.name || '');
    puNewOrder();
    if (name) { _edit.supplier = name; _wstep = 1; paint(); }
  };
  function supplierExtras(s) {
    return `
      ${supplierPriceList(s)}
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
    if (!(await askConfirm({
      title: T('Delete this document?', '确定删除该文件？'),
      confirmLabel: T('Delete document', '删除文件'),
      danger: true,
    }))) return;
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
