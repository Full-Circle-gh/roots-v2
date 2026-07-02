/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 16.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   fmt, escapeHtml, applyCapGates, goTab…) live in 01-core.js.
   Contents: Purchasing tab (pu*) — the online store's buying department.
   Suppliers master (shared with the kitchen app's supplier records) +
   retail purchase orders: create → order → receive. Received quantities
   post into store stock (and fan out to channel sync) server-side; costs
   auto-post to Finance → Expenses. Endpoints: /api/retail-admin/suppliers*
   + /api/retail-admin/purchases* (routes/retail-purchasing.js). */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  const money = n => '¥' + fmt(n);
  const today = () => new Date().toISOString().slice(0, 10);

  let _initiated = false;
  let _stores = [];        // retail_stores rows
  let _suppliers = [];     // suppliers list rows
  let _pos = [];           // PO header rows
  const _prodCache = {};   // storeId → product list (picker source)
  let _po = null;          // open PO detail (manage view)
  let _hist = {};          // store_product_id → {previous, stats} for open PO
  let _edit = null;        // PO being created/edited
  let _sup = null;         // supplier being created/edited

  // ── Entry ────────────────────────────────────────────────────────────────
  window.puInit = async function () {
    if (_initiated) { puRefresh(); return; }
    _initiated = true;
    await Promise.all([puLoadStores(), puLoadSuppliers(), puLoadPOs()]);
  };
  async function puRefresh() {
    try { await Promise.all([puLoadSuppliers(), puLoadPOs()]); } catch (_) {}
  }

  async function puLoadStores() {
    try {
      const r = await api('/api/retail-admin/stores');
      _stores = (r.data || []).filter(s => s.is_active);
      const sel = document.getElementById('pu-filter-store');
      if (sel && _stores.length > 1) {
        sel.hidden = false;
        sel.innerHTML = '<option value="">All stores · 全部门店</option>' +
          _stores.map(s => `<option value="${s.id}">${esc(s.name_en || s.code)} · ${esc(s.name_cn || '')}</option>`).join('');
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  async function puProducts(storeId) {
    if (!_prodCache[storeId]) {
      const r = await api('/api/retail-admin/stores/' + storeId + '/stock');
      _prodCache[storeId] = r.data || [];
    }
    return _prodCache[storeId];
  }

  // ── Sub-view switch ──────────────────────────────────────────────────────
  window.puShowView = function (v) {
    document.getElementById('pu-view-pos').style.display = v === 'pos' ? '' : 'none';
    document.getElementById('pu-view-suppliers').style.display = v === 'suppliers' ? '' : 'none';
    document.getElementById('pu-nav-pos').classList.toggle('btn-primary', v === 'pos');
    document.getElementById('pu-nav-suppliers').classList.toggle('btn-primary', v === 'suppliers');
  };

  // ═══ Purchase orders ══════════════════════════════════════════════════════

  async function puLoadPOs() {
    try {
      const r = await api('/api/retail-admin/purchases');
      _pos = r.data || [];
      puRenderKPIs();
      puFilterPOs();
    } catch (e) { toast(e.message, 'err'); }
  }

  function puRenderKPIs() {
    const open = _pos.filter(p => p.status === 'Requested' || p.status === 'Ordered').length;
    const awaiting = _pos.filter(p => p.status === 'Ordered').length;
    const m = today().slice(0, 7);
    const monthTotal = _pos
      .filter(p => (p.date || '').slice(0, 7) === m && (p.status === 'Ordered' || p.status === 'Delivered'))
      .reduce((s, p) => s + (Number(p.total_cost) || 0), 0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pu-kpi-open', open);
    set('pu-kpi-awaiting', awaiting);
    set('pu-kpi-month', money(monthTotal));
    set('pu-kpi-suppliers', _suppliers.filter(s => s.is_active).length);
  }

  const STATUS_CHIP = {
    Requested: ['Requested · 待下单', 'background:#f0efe9;color:#555'],
    Ordered:   ['Ordered · 已下单',   'background:#e8f0fe;color:#1a56b0'],
    Delivered: ['Delivered · 已到货', 'background:#e6f4ea;color:#1e7d3c'],
    Cancelled: ['Cancelled · 已取消', 'background:#fdeaea;color:#b03030'],
  };
  function chip(status) {
    const [label, style] = STATUS_CHIP[status] || [status, ''];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;white-space:nowrap;${style}">${esc(label)}</span>`;
  }

  window.puFilterPOs = function () {
    const q = (document.getElementById('pu-search').value || '').toLowerCase().trim();
    const st = document.getElementById('pu-filter-status').value;
    const storeSel = document.getElementById('pu-filter-store');
    const storeId = storeSel && !storeSel.hidden ? parseInt(storeSel.value, 10) || null : null;
    const rows = _pos.filter(p => {
      if (st && p.status !== st) return false;
      if (storeId && p.store_id !== storeId) return false;
      if (q && !(`${p.po_number} ${p.supplier || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const body = document.getElementById('pu-pos-body');
    const count = document.getElementById('pu-count');
    if (count) count.textContent = rows.length + ' / ' + _pos.length;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No purchase orders · 暂无采购单</td></tr>';
      return;
    }
    body.innerHTML = rows.map(p => `
      <tr style="cursor:pointer" onclick="puOpenPO(${p.id})">
        <td><b>${esc(p.po_number)}</b></td>
        <td>${esc(p.date || '')}</td>
        <td>${esc(p.supplier || '—')}</td>
        <td>${esc(p.store_name_en || '')}${p.store_name_cn ? ' · ' + esc(p.store_name_cn) : ''}</td>
        <td style="text-align:right">${p.line_count || 0}${p.received_lines ? ` <span class="muted">(${p.received_lines}✓)</span>` : ''}</td>
        <td style="text-align:right">${money(p.total_cost)}</td>
        <td>${chip(p.status)}</td>
      </tr>`).join('');
  };

  function showPOPage(show) {
    document.getElementById('pu-pos-list').style.display = show ? 'none' : '';
    document.getElementById('pu-kpis').style.display = show ? 'none' : '';
    document.getElementById('pu-po-page').style.display = show ? '' : 'none';
  }
  window.puBackToList = function () {
    _po = null; _edit = null;
    showPOPage(false);
    puLoadPOs();
  };

  // ── New / edit (Requested) ───────────────────────────────────────────────
  window.puNewPO = function () {
    _po = null;
    _edit = {
      id: null, po_number: null, date: today(), delivery_date: '',
      supplier: '', store_id: _stores[0]?.id || null, notes: '', items: [],
    };
    renderEditPage();
    showPOPage(true);
  };

  window.puOpenPO = async function (id) {
    try {
      const r = await api('/api/retail-admin/purchases/' + id);
      _po = r.data;
      _hist = {};
      if (_po.status === 'Requested') {
        _edit = {
          id: _po.id, po_number: _po.po_number, date: _po.date,
          delivery_date: _po.delivery_date || '', supplier: _po.supplier || '',
          store_id: _po.store_id, notes: _po.notes || '',
          items: _po.items.map(i => ({
            store_product_id: i.store_product_id, name_en: i.name_en, name_cn: i.name_cn,
            sku: i.sku, qty: i.qty, unit: i.unit, cost_per_unit: i.cost_per_unit,
            expense_category: i.expense_category || '', purchase_channel: i.purchase_channel || '',
            current_stock: i.current_stock,
          })),
        };
        renderEditPage();
      } else {
        _edit = null;
        renderManagePage();
        api('/api/retail-admin/purchases/' + id + '/history')
          .then(h => { _hist = h.data || {}; renderManagePage(); })
          .catch(() => {});
      }
      showPOPage(true);
    } catch (e) { toast(e.message, 'err'); }
  };

  function supplierOptions(selected) {
    return '<option value="">No supplier · 不指定</option>' + _suppliers
      .filter(s => s.is_active || s.name === selected)
      .map(s => `<option value="${esc(s.name)}"${s.name === selected ? ' selected' : ''}>${esc(s.name)}${s.name_cn ? ' · ' + esc(s.name_cn) : ''}</option>`)
      .join('');
  }

  function renderEditPage() {
    const e = _edit;
    const el = document.getElementById('pu-po-page');
    el.innerHTML = `
      <div class="row" style="gap:8px;align-items:center;margin-bottom:var(--s3);flex-wrap:wrap">
        <button class="btn btn-sm" onclick="puBackToList()">← Back · 返回</button>
        <h3 style="margin:0">${e.id ? esc(e.po_number) : 'New purchase order · 新建采购单'}</h3>
        ${e.id ? chip('Requested') : ''}
      </div>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-bottom:var(--s3)">
        <label style="font-size:13px">Date · 日期<br><input type="date" id="pu-e-date" value="${esc(e.date)}"></label>
        <label style="font-size:13px">Expected · 预计到货<br><input type="date" id="pu-e-delivery" value="${esc(e.delivery_date || '')}"></label>
        <label style="font-size:13px">Supplier · 供应商<br><select id="pu-e-supplier">${supplierOptions(e.supplier)}</select></label>
        <label style="font-size:13px">Deliver to store · 收货门店<br>
          <select id="pu-e-store" onchange="puEditStoreChanged()">
            ${_stores.map(s => `<option value="${s.id}"${s.id === e.store_id ? ' selected' : ''}>${esc(s.name_en || s.code)} · ${esc(s.name_cn || '')}</option>`).join('')}
          </select></label>
      </div>
      <label style="font-size:13px;display:block;margin-bottom:var(--s3)">Notes · 备注<br>
        <input type="text" id="pu-e-notes" value="${esc(e.notes || '')}" style="width:min(560px,100%)"></label>

      <div style="position:relative;max-width:560px;margin-bottom:var(--s2)">
        <input type="text" id="pu-picker" placeholder="Add product — search name / SKU · 添加商品——搜索名称/货号"
               style="width:100%" oninput="puPickerInput()" autocomplete="off">
        <div id="pu-picker-list" style="display:none;position:absolute;z-index:30;left:0;right:0;top:100%;max-height:280px;overflow:auto;background:var(--panel,#fff);border:1px solid var(--border,#ddd);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
      </div>

      <div style="overflow-x:auto">
        <table class="data-table" style="min-width:820px;font-size:13px">
          <thead><tr>
            <th>Product · 商品</th><th style="text-align:right">In stock · 现库存</th>
            <th style="width:90px">Qty · 数量</th><th style="width:80px">Unit · 单位</th>
            <th style="width:110px">Cost/unit · 单价</th><th style="width:150px">Category · 支出分类</th>
            <th style="width:120px">Channel · 采购渠道</th><th style="text-align:right">Total · 小计</th><th></th>
          </tr></thead>
          <tbody id="pu-e-lines"></tbody>
          <tfoot><tr>
            <td colspan="7" style="text-align:right"><b>Total · 合计</b></td>
            <td style="text-align:right"><b id="pu-e-total"></b></td><td></td>
          </tr></tfoot>
        </table>
      </div>
      <datalist id="pu-cat-list">
        <option value="门店进货 Retail stock"></option>
        <option value="包装 Packaging"></option>
        <option value="运费 Shipping"></option>
        <option value="其他 Other"></option>
      </datalist>

      <div class="row" style="gap:8px;margin-top:var(--s4);flex-wrap:wrap">
        <button class="btn btn-primary" data-cap="purchasing:edit" onclick="puSavePO(false)">Save · 保存</button>
        <button class="btn" data-cap="purchasing:edit" onclick="puSavePO(true)">Save &amp; mark ordered · 保存并标记已下单</button>
        ${e.id ? '<button class="btn" data-cap="purchasing:edit" style="color:#b03030" onclick="puSetStatus(\'Cancelled\')">Cancel PO · 取消采购单</button>' : ''}
      </div>`;
    renderEditLines();
    try { applyCapGates(); } catch (_) {}
  }

  function renderEditLines() {
    const body = document.getElementById('pu-e-lines');
    if (!body) return;
    if (!_edit.items.length) {
      body.innerHTML = '<tr><td colspan="9" class="muted" style="padding:18px;text-align:center">No lines yet — search a product above · 尚无商品——在上方搜索添加</td></tr>';
    } else {
      body.innerHTML = _edit.items.map((it, i) => `
        <tr>
          <td>${esc(it.name_en || '')}${it.name_cn ? ' · ' + esc(it.name_cn) : ''}<div class="muted" style="font-size:11px">${esc(it.sku || '')}</div></td>
          <td style="text-align:right" class="muted">${it.current_stock != null ? it.current_stock : '—'}</td>
          <td><input type="number" min="0" step="1" value="${esc(it.qty ?? 1)}" style="width:70px" onchange="puLineChanged(${i},'qty',this.value)"></td>
          <td><input type="text" value="${esc(it.unit || 'pcs')}" style="width:60px" onchange="puLineChanged(${i},'unit',this.value)"></td>
          <td><input type="number" min="0" step="0.01" value="${esc(it.cost_per_unit ?? 0)}" style="width:90px" onchange="puLineChanged(${i},'cost_per_unit',this.value)"></td>
          <td><input type="text" list="pu-cat-list" value="${esc(it.expense_category || '')}" style="width:140px" onchange="puLineChanged(${i},'expense_category',this.value)"></td>
          <td><input type="text" value="${esc(it.purchase_channel || '')}" style="width:110px" onchange="puLineChanged(${i},'purchase_channel',this.value)"></td>
          <td style="text-align:right">${money((parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0))}</td>
          <td><button class="btn btn-sm" title="Remove · 移除" onclick="puRemoveLine(${i})">✕</button></td>
        </tr>`).join('');
    }
    const total = _edit.items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.cost_per_unit) || 0), 0);
    const t = document.getElementById('pu-e-total');
    if (t) t.textContent = money(total);
  }

  window.puLineChanged = function (i, field, value) {
    if (!_edit || !_edit.items[i]) return;
    _edit.items[i][field] = value;
    renderEditLines();
  };
  window.puRemoveLine = function (i) {
    if (!_edit) return;
    _edit.items.splice(i, 1);
    renderEditLines();
  };
  window.puEditStoreChanged = function () {
    if (!_edit) return;
    _edit.store_id = parseInt(document.getElementById('pu-e-store').value, 10);
    // Shelf-qty context on existing lines belongs to the old store — refresh it.
    puProducts(_edit.store_id).then(list => {
      const byId = new Map(list.map(p => [p.product_id, p]));
      for (const it of _edit.items) {
        const p = it.store_product_id ? byId.get(it.store_product_id) : null;
        it.current_stock = p ? p.physical_qty : null;
      }
      renderEditLines();
    }).catch(() => {});
  };

  let _pickerTimer = null;
  window.puPickerInput = function () {
    clearTimeout(_pickerTimer);
    _pickerTimer = setTimeout(async () => {
      const q = (document.getElementById('pu-picker').value || '').toLowerCase().trim();
      const list = document.getElementById('pu-picker-list');
      if (!q) { list.style.display = 'none'; return; }
      let prods = [];
      try { prods = await puProducts(_edit.store_id); } catch (e) { toast(e.message, 'err'); return; }
      const hits = prods.filter(p =>
        `${p.name_en || ''} ${p.name_cn || ''} ${p.sku || ''}`.toLowerCase().includes(q)).slice(0, 30);
      if (!hits.length) {
        list.innerHTML = '<div class="muted" style="padding:10px 12px">No match · 无匹配</div>';
      } else {
        list.innerHTML = hits.map(p => `
          <div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border,#eee)"
               onclick="puPickProduct(${p.product_id})">
            ${esc(p.name_en || '')}${p.name_cn ? ' · ' + esc(p.name_cn) : ''}
            <span class="muted" style="font-size:11px;margin-left:6px">${esc(p.sku || '')} · stock ${p.physical_qty}</span>
          </div>`).join('');
      }
      list.style.display = '';
    }, 150);
  };
  window.puPickProduct = async function (productId) {
    const prods = await puProducts(_edit.store_id);
    const p = prods.find(x => x.product_id === productId);
    if (!p) return;
    const existing = _edit.items.find(it => it.store_product_id === productId);
    if (existing) { existing.qty = (parseFloat(existing.qty) || 0) + 1; }
    else {
      _edit.items.push({
        store_product_id: p.product_id, name_en: p.name_en, name_cn: p.name_cn, sku: p.sku,
        qty: 1, unit: 'pcs', cost_per_unit: 0, expense_category: '门店进货 Retail stock',
        purchase_channel: '', current_stock: p.physical_qty,
      });
    }
    document.getElementById('pu-picker').value = '';
    document.getElementById('pu-picker-list').style.display = 'none';
    renderEditLines();
  };

  window.puSavePO = async function (markOrdered) {
    if (!_edit) return;
    const body = {
      date: document.getElementById('pu-e-date').value || today(),
      delivery_date: document.getElementById('pu-e-delivery').value || null,
      supplier: document.getElementById('pu-e-supplier').value || null,
      store_id: parseInt(document.getElementById('pu-e-store').value, 10),
      notes: document.getElementById('pu-e-notes').value || null,
      items: _edit.items.map(it => ({
        store_product_id: it.store_product_id, name_en: it.name_en, name_cn: it.name_cn, sku: it.sku,
        qty: parseFloat(it.qty) || 0, unit: it.unit || 'pcs',
        cost_per_unit: parseFloat(it.cost_per_unit) || 0,
        expense_category: it.expense_category || null, purchase_channel: it.purchase_channel || null,
      })),
    };
    if (!body.items.length) { toast('Add at least one product · 请先添加商品', 'err'); return; }
    try {
      let id = _edit.id;
      if (id) await api('/api/retail-admin/purchases/' + id, { method: 'PUT', body });
      else {
        const r = await api('/api/retail-admin/purchases', { method: 'POST', body });
        id = r.id;
      }
      if (markOrdered) {
        await api('/api/retail-admin/purchases/' + id + '/status', { method: 'PUT', body: { status: 'Ordered' } });
      }
      toast('Saved ✓', 'ok');
      puOpenPO(id);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ── Manage (Ordered / Delivered / Cancelled) ─────────────────────────────
  function histHint(spId) {
    const h = _hist[spId];
    if (!h || !h.previous) return '';
    return `<div class="muted" style="font-size:11px">Last · 上次 ${money(h.previous.cost_per_unit)} (${esc(h.previous.po_number)})</div>`;
  }

  function renderManagePage() {
    const p = _po;
    if (!p) return;
    const el = document.getElementById('pu-po-page');
    const canReceive = p.status === 'Ordered' || p.status === 'Delivered';
    const expTotal = (p.expenses || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    el.innerHTML = `
      <div class="row" style="gap:8px;align-items:center;margin-bottom:var(--s3);flex-wrap:wrap">
        <button class="btn btn-sm" onclick="puBackToList()">← Back · 返回</button>
        <h3 style="margin:0">${esc(p.po_number)}</h3>
        ${chip(p.status)}
        <span class="muted" style="font-size:13px">${esc(p.date || '')} · ${esc(p.supplier || 'no supplier · 未指定供应商')} · ${esc(p.store_name_en || '')}${p.store_name_cn ? ' · ' + esc(p.store_name_cn) : ''}</span>
      </div>
      ${p.notes ? `<p class="helper" style="margin-top:0">${esc(p.notes)}</p>` : ''}

      <div style="overflow-x:auto">
        <table class="data-table" style="min-width:900px;font-size:13px">
          <thead><tr>
            <th>Product · 商品</th><th style="text-align:right">Ordered · 订购</th>
            <th style="text-align:right">Cost/unit · 单价</th>
            <th style="width:100px">Received · 实收</th><th style="width:90px">Damaged · 破损</th>
            <th style="width:150px">Tracking · 运单号</th>
            <th style="width:130px">Invoice · 发票</th>
            <th style="text-align:right">In stock · 已入库</th>
          </tr></thead>
          <tbody>
            ${p.items.map(it => `
              <tr data-line="${it.id}">
                <td>${esc(it.name_en || '')}${it.name_cn ? ' · ' + esc(it.name_cn) : ''}
                    <div class="muted" style="font-size:11px">${esc(it.sku || '')}</div></td>
                <td style="text-align:right">${it.qty} ${esc(it.unit || '')}<div class="muted" style="font-size:11px">${money((it.qty || 0) * (it.cost_per_unit || 0))}</div></td>
                <td style="text-align:right">${money(it.cost_per_unit)}${histHint(it.store_product_id)}</td>
                <td><input type="number" min="0" step="1" class="pu-r-qty" placeholder="${it.qty}"
                     value="${it.qty_received != null ? it.qty_received : ''}" style="width:80px" ${canReceive ? '' : 'disabled'}></td>
                <td><input type="number" min="0" step="1" class="pu-r-dmg"
                     value="${it.damaged_qty || ''}" style="width:70px" ${canReceive ? '' : 'disabled'}></td>
                <td><input type="text" class="pu-r-track" value="${esc(it.tracking_number || '')}" style="width:140px" ${canReceive ? '' : 'disabled'}></td>
                <td><select class="pu-r-inv" ${canReceive ? '' : 'disabled'}>
                    <option value="not_received"${it.invoice_status === 'not_received' ? ' selected' : ''}>awaiting · 待收</option>
                    <option value="received"${it.invoice_status === 'received' ? ' selected' : ''}>received · 已收</option>
                    <option value="no_invoice"${it.invoice_status === 'no_invoice' ? ' selected' : ''}>none · 无发票</option>
                  </select></td>
                <td style="text-align:right">${(it.stock_applied_qty || 0) > 0 ? '✓ ' + it.stock_applied_qty : '—'}
                    ${it.current_stock != null ? `<div class="muted" style="font-size:11px">shelf · 现货 ${it.current_stock}</div>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="row" style="gap:8px;margin-top:var(--s4);flex-wrap:wrap">
        ${canReceive ? '<button class="btn btn-primary" data-cap="purchasing:receive" onclick="puSaveReceive()">Save receive → stock · 保存收货并入库</button>' : ''}
        ${p.status === 'Ordered' ? '<button class="btn" data-cap="purchasing:receive" onclick="puSetStatus(\'Delivered\')">All arrived · 全部到货</button>' : ''}
        ${p.status === 'Ordered' ? '<button class="btn" data-cap="purchasing:edit" onclick="puSetStatus(\'Requested\')">Back to requested · 退回待下单</button>' : ''}
        ${p.status !== 'Cancelled' && p.status !== 'Delivered' ? '<button class="btn" data-cap="purchasing:edit" style="color:#b03030" onclick="puSetStatus(\'Cancelled\')">Cancel PO · 取消采购单</button>' : ''}
      </div>

      <div style="margin-top:var(--s4);border:1px solid var(--border,#e0ddd5);border-radius:8px;padding:10px 12px;max-width:560px">
        <b style="font-size:13px">Finance · 财务</b>
        ${(p.expenses || []).length
          ? `<div style="font-size:13px;margin-top:6px">${p.expenses.map(x => `${esc(x.category || '')} — ${money(x.amount)}`).join('<br>')}
             <div class="muted" style="margin-top:4px">Posted to Expenses · 已记入支出 · ${money(expTotal)}</div></div>`
          : '<div class="muted" style="font-size:13px;margin-top:6px">Posts when the PO is marked ordered · 标记已下单后自动记入支出</div>'}
      </div>`;
    try { applyCapGates(); } catch (_) {}
  }

  window.puSetStatus = async function (status) {
    const id = _po ? _po.id : (_edit && _edit.id);
    if (!id) return;
    if (status === 'Cancelled' && !confirm('Cancel this purchase order? · 确定取消该采购单？')) return;
    try {
      await api('/api/retail-admin/purchases/' + id + '/status', { method: 'PUT', body: { status } });
      toast('Saved ✓', 'ok');
      puOpenPO(id);
    } catch (e) { toast(e.message, 'err'); }
  };

  window.puSaveReceive = async function () {
    if (!_po) return;
    const receipts = [];
    document.querySelectorAll('#pu-po-page tr[data-line]').forEach(tr => {
      receipts.push({
        line_id: parseInt(tr.dataset.line, 10),
        qty_received: tr.querySelector('.pu-r-qty').value === '' ? null : tr.querySelector('.pu-r-qty').value,
        damaged_qty: tr.querySelector('.pu-r-dmg').value || 0,
        tracking_number: tr.querySelector('.pu-r-track').value,
        invoice_status: tr.querySelector('.pu-r-inv').value,
      });
    });
    try {
      const r = await api('/api/retail-admin/purchases/' + _po.id + '/receive', { method: 'PUT', body: { receipts } });
      const bits = [];
      if (r.stock_lines_adjusted) bits.push(`stock updated ×${r.stock_lines_adjusted} · 库存已更新`);
      if (r.missing_lines) bits.push(`${r.missing_lines} short · 短缺`);
      if (r.damaged_lines) bits.push(`${r.damaged_lines} damaged · 破损`);
      toast('Received ✓ ' + (bits.length ? '— ' + bits.join(' · ') : ''), 'ok', 4000);
      puOpenPO(_po.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ═══ Suppliers ═════════════════════════════════════════════════════════════

  window.puLoadSuppliers = async function (rerender) {
    try {
      const all = document.getElementById('pu-sup-inactive')?.checked ? '?all=1' : '';
      const r = await api('/api/retail-admin/suppliers' + all);
      _suppliers = r.data || [];
      puRenderSuppliers();
      if (rerender !== true) puRenderKPIs();
    } catch (e) { toast(e.message, 'err'); }
  };

  window.puRenderSuppliers = function () {
    const q = (document.getElementById('pu-sup-search')?.value || '').toLowerCase().trim();
    const rows = _suppliers.filter(s =>
      !q || `${s.name} ${s.name_cn || ''} ${s.contact_name || ''}`.toLowerCase().includes(q));
    const body = document.getElementById('pu-sup-body');
    const count = document.getElementById('pu-sup-count');
    if (count) count.textContent = rows.length + ' / ' + _suppliers.length;
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">No suppliers · 暂无供应商</td></tr>';
      return;
    }
    body.innerHTML = rows.map(s => `
      <tr style="cursor:pointer${s.is_active ? '' : ';opacity:.55'}" onclick="puOpenSupplier(${s.id})">
        <td><b>${esc(s.name)}</b>${s.name_cn ? ' · ' + esc(s.name_cn) : ''}
            ${s.is_active ? '' : ' <span class="muted" style="font-size:11px">(disabled · 已停用)</span>'}
            ${s.doc_count ? `<span class="muted" style="font-size:11px;margin-left:6px">${s.doc_count} file${s.doc_count === 1 ? '' : 's'} · ${s.doc_count}份文件</span>` : ''}</td>
        <td>${esc(s.contact_name || '—')}${s.contact_phone ? `<div class="muted" style="font-size:11px">${esc(s.contact_phone)}</div>` : ''}</td>
        <td>${esc(s.payment_terms || '—')}${s.payment_method ? `<div class="muted" style="font-size:11px">${esc(s.payment_method)}</div>` : ''}</td>
        <td>${esc(s.channel_type || '—')}</td>
        <td style="text-align:right">${s.po_count || 0}${s.last_po_date ? `<div class="muted" style="font-size:11px">${esc(s.last_po_date)}</div>` : ''}</td>
        <td>${'★'.repeat(s.rating || 0)}${'☆'.repeat(5 - (s.rating || 0))}</td>
      </tr>`).join('');
  };

  function showSupPage(show) {
    document.getElementById('pu-sup-list').style.display = show ? 'none' : '';
    document.getElementById('pu-sup-page').style.display = show ? '' : 'none';
  }
  window.puSupBack = function () { _sup = null; showSupPage(false); puLoadSuppliers(); };

  window.puNewSupplier = function () { _sup = { id: null }; renderSupplierPage(); showSupPage(true); };
  window.puOpenSupplier = async function (id) {
    try {
      const r = await api('/api/retail-admin/suppliers/' + id);
      _sup = r.data;
      renderSupplierPage();
      showSupPage(true);
    } catch (e) { toast(e.message, 'err'); }
  };

  function field(label, id, value, extra) {
    return `<label style="font-size:13px">${label}<br><input type="text" id="${id}" value="${esc(value || '')}" ${extra || ''}></label>`;
  }

  function renderSupplierPage() {
    const s = _sup;
    const el = document.getElementById('pu-sup-page');
    el.innerHTML = `
      <div class="row" style="gap:8px;align-items:center;margin-bottom:var(--s3);flex-wrap:wrap">
        <button class="btn btn-sm" onclick="puSupBack()">← Back · 返回</button>
        <h3 style="margin:0">${s.id ? esc(s.name) : 'New supplier · 新建供应商'}</h3>
      </div>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-bottom:var(--s3)">
        ${field('Name · 名称', 'pu-s-name', s.name)}
        ${field('中文名', 'pu-s-name-cn', s.name_cn)}
        ${field('Contact · 联系人', 'pu-s-contact', s.contact_name)}
        ${field('Phone · 电话', 'pu-s-phone', s.contact_phone)}
        ${field('WeChat · 微信', 'pu-s-wechat', s.contact_wechat)}
      </div>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-bottom:var(--s3)">
        ${field('Payment terms · 付款条件', 'pu-s-terms', s.payment_terms, 'list="pu-terms-list"')}
        ${field('Payment method · 付款方式', 'pu-s-method', s.payment_method, 'list="pu-method-list"')}
        <label style="font-size:13px">Channel · 渠道<br>
          <select id="pu-s-chtype">
            ${['', 'taobao', 'alibaba', 'wechat', 'phone', 'website', 'other'].map(v =>
              `<option value="${v}"${(s.channel_type || '') === v ? ' selected' : ''}>${v || '—'}</option>`).join('')}
          </select></label>
        ${field('Channel link · 渠道链接', 'pu-s-chlink', s.channel_link, 'style="width:260px"')}
        <label style="font-size:13px">Rating · 评分<br>
          <select id="pu-s-rating">${[0, 1, 2, 3, 4, 5].map(v =>
            `<option value="${v}"${(s.rating || 0) === v ? ' selected' : ''}>${'★'.repeat(v) || '—'}</option>`).join('')}</select></label>
      </div>
      <datalist id="pu-terms-list"><option value="Prepay 预付"></option><option value="COD 货到付款"></option><option value="Net 15"></option><option value="Net 30"></option></datalist>
      <datalist id="pu-method-list"><option value="WeChat 微信"></option><option value="Alipay 支付宝"></option><option value="Bank 银行转账"></option><option value="Cash 现金"></option></datalist>
      <div class="row" style="gap:12px;flex-wrap:wrap;margin-bottom:var(--s3)">
        <label style="font-size:13px">Products supplied · 供应商品<br>
          <textarea id="pu-s-products" rows="2" style="width:min(420px,90vw)">${esc(s.products_supplied || '')}</textarea></label>
        <label style="font-size:13px">Price notes · 价格备注<br>
          <textarea id="pu-s-prices" rows="2" style="width:min(420px,90vw)">${esc(s.price_info || '')}</textarea></label>
        <label style="font-size:13px">Notes · 备注<br>
          <textarea id="pu-s-notes" rows="2" style="width:min(420px,90vw)">${esc(s.notes || '')}</textarea></label>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:var(--s4)">
        <button class="btn btn-primary" data-cap="purchasing:edit" onclick="puSaveSupplier()">Save · 保存</button>
        ${s.id ? `<button class="btn" data-cap="purchasing:edit" style="color:${s.is_active ? '#b03030' : '#1e7d3c'}" onclick="puToggleSupplierActive()">${s.is_active ? 'Disable · 停用' : 'Enable · 启用'}</button>` : ''}
      </div>

      ${s.id ? `
      <div style="border:1px solid var(--border,#e0ddd5);border-radius:8px;padding:10px 12px;max-width:640px;margin-bottom:var(--s4)">
        <b style="font-size:13px">Documents · 资质文件</b>
        <div id="pu-s-docs" style="margin-top:6px;font-size:13px">
          ${(s.documents || []).length ? s.documents.map(d => `
            <div class="row" style="gap:8px;align-items:center;padding:4px 0">
              <span class="muted" style="font-size:11px;min-width:74px">${esc(d.kind)}</span>
              <span style="flex:1">${esc(d.label || d.filename || 'file')}</span>
              <button class="btn btn-sm" onclick="puViewDoc(${d.id})">View · 查看</button>
              <button class="btn btn-sm" data-cap="purchasing:edit" onclick="puDeleteDoc(${d.id})">✕</button>
            </div>`).join('') : '<div class="muted">None yet · 暂无</div>'}
        </div>
        <div class="row" style="gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap" data-cap="purchasing:edit">
          <select id="pu-doc-kind">
            <option value="license">License · 营业执照</option>
            <option value="permit">Permit · 许可证</option>
            <option value="payment_qr">Payment QR · 收款码</option>
            <option value="other">Other · 其他</option>
          </select>
          <input type="text" id="pu-doc-label" placeholder="Label · 说明" style="width:150px">
          <input type="file" id="pu-doc-file" accept="image/*,application/pdf" style="max-width:220px">
          <button class="btn btn-sm" onclick="puUploadDoc()">Upload · 上传</button>
        </div>
      </div>

      <div style="border:1px solid var(--border,#e0ddd5);border-radius:8px;padding:10px 12px;max-width:640px">
        <b style="font-size:13px">Recent POs · 最近采购单</b>
        <div style="margin-top:6px;font-size:13px">
          ${(s.recent_pos || []).length ? s.recent_pos.map(p => `
            <div class="row" style="gap:8px;align-items:center;padding:3px 0;cursor:pointer"
                 onclick="puShowView('pos');puOpenPO(${p.id})">
              <b>${esc(p.po_number)}</b><span class="muted">${esc(p.date || '')}</span>
              <span style="flex:1;text-align:right">${money(p.total)}</span>${chip(p.status)}
            </div>`).join('') : '<div class="muted">None yet · 暂无</div>'}
        </div>
      </div>` : ''}`;
    try { applyCapGates(); } catch (_) {}
  }

  function supFormBody() {
    return {
      name: document.getElementById('pu-s-name').value.trim(),
      name_cn: document.getElementById('pu-s-name-cn').value.trim() || null,
      contact_name: document.getElementById('pu-s-contact').value.trim() || null,
      contact_phone: document.getElementById('pu-s-phone').value.trim() || null,
      contact_wechat: document.getElementById('pu-s-wechat').value.trim() || null,
      payment_terms: document.getElementById('pu-s-terms').value.trim() || null,
      payment_method: document.getElementById('pu-s-method').value.trim() || null,
      channel_type: document.getElementById('pu-s-chtype').value || null,
      channel_link: document.getElementById('pu-s-chlink').value.trim() || null,
      rating: parseInt(document.getElementById('pu-s-rating').value, 10) || 0,
      products_supplied: document.getElementById('pu-s-products').value.trim() || null,
      price_info: document.getElementById('pu-s-prices').value.trim() || null,
      notes: document.getElementById('pu-s-notes').value.trim() || null,
    };
  }

  window.puSaveSupplier = async function () {
    const body = supFormBody();
    if (!body.name) { toast('Name is required · 名称必填', 'err'); return; }
    try {
      if (_sup.id) await api('/api/retail-admin/suppliers/' + _sup.id, { method: 'PUT', body });
      else {
        const r = await api('/api/retail-admin/suppliers', { method: 'POST', body });
        _sup.id = r.id;
      }
      toast('Saved ✓', 'ok');
      puOpenSupplier(_sup.id);
    } catch (e) {
      toast(e.code === 'name_taken' ? 'Name already exists · 名称已存在' : e.message, 'err');
    }
  };

  window.puToggleSupplierActive = async function () {
    if (!_sup?.id) return;
    try {
      await api('/api/retail-admin/suppliers/' + _sup.id, { method: 'PUT', body: { is_active: !_sup.is_active } });
      toast('Saved ✓', 'ok');
      puOpenSupplier(_sup.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  window.puUploadDoc = function () {
    const file = document.getElementById('pu-doc-file').files[0];
    if (!file) { toast('Choose a file first · 请先选择文件', 'err'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('Max 10MB · 最大10MB', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api('/api/retail-admin/suppliers/' + _sup.id + '/documents', {
          method: 'POST',
          body: {
            kind: document.getElementById('pu-doc-kind').value,
            label: document.getElementById('pu-doc-label').value.trim() || null,
            filename: file.name, mime_type: file.type, size_bytes: file.size,
            data: reader.result,
          },
        });
        toast('Uploaded ✓', 'ok');
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
      // PDFs / other files: hand the browser a blob URL in a new tab.
      const [head, b64] = d.data.split(',');
      const mime = d.mime_type || (head.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      window.open(URL.createObjectURL(new Blob([arr], { type: mime })), '_blank');
    } catch (e) { toast(e.message, 'err'); }
  };

  window.puDeleteDoc = async function (docId) {
    if (!confirm('Delete this document? · 确定删除该文件？')) return;
    try {
      await api('/api/retail-admin/suppliers/' + _sup.id + '/documents/' + docId, { method: 'DELETE' });
      toast('Deleted ✓', 'ok');
      puOpenSupplier(_sup.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  // Close the product-picker dropdown on outside click.
  document.addEventListener('click', (e) => {
    const list = document.getElementById('pu-picker-list');
    if (list && list.style.display !== 'none' && !e.target.closest('#pu-picker') && !e.target.closest('#pu-picker-list')) {
      list.style.display = 'none';
    }
  });
})();
