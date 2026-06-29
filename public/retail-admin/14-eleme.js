/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Eleme Sync admin tab — feature switch + OAuth connect + product mapping + status */
/* namespace: el* */

(function () {
  'use strict';

  let _products = [];
  let _stores   = [];
  let _enabled  = false;
  let _configured = false;
  let _initiated = false;

  // ── Entry point ────────────────────────────────────────────────────────────
  window.elAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await elLoadConfig();
    await Promise.all([elLoadStores(), elLoadStatus()]);
    await elLoadProducts();
    elLoadOrders();
    elStartPolling();
    elFlashConnected();
    // The mapping table renders in ONE language under data-no-i18n, so repaint it
    // ourselves on EN/CN flips (the translator never touches data-no-i18n nodes).
    if (window.onLangChange) onLangChange(function () { elRenderProducts(); });
  };

  // After the OAuth round-trip Eleme redirects to /retail-admin?eleme=connected.
  function elFlashConnected() {
    try {
      const p = new URLSearchParams(location.search);
      if (p.get('eleme') === 'connected') {
        const msg = p.get('shop') === 'unset'
          ? cuT('Connected — now set this store’s Eleme shop below.', '已连接 — 请在下方设置该门店的饿了么店铺。')
          : cuT('Eleme store connected.', '饿了么门店已连接。');
        if (window.toast) toast(msg);
        history.replaceState(null, '', '/retail-admin');
        elLoadStores();
      }
    } catch (_) {}
  }

  // ── Config / feature switch ─────────────────────────────────────────────────
  window.elLoadConfig = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/config');
      _enabled = !!r.enabled;
      _configured = !!r.configured;
      const cb = document.getElementById('el-enable');
      if (cb) cb.checked = _enabled;
      const txt = document.getElementById('el-enable-txt');
      if (txt) txt.textContent = _enabled ? cuT('On · 开启', 'On · 开启') : cuT('Off · 关闭', 'Off · 关闭');
      const note = document.getElementById('el-conn-note');
      if (note) {
        if (!_configured) {
          note.textContent = cuT(
            'Server not configured yet — set ELEME_APP_KEY / ELEME_APP_SECRET / ELEME_REDIRECT_URI in .env, then restart.',
            '服务器尚未配置 — 在 .env 中设置 ELEME_APP_KEY / ELEME_APP_SECRET / ELEME_REDIRECT_URI 后重启。');
          note.style.color = 'var(--danger, #c0392b)';
        } else {
          note.textContent = cuT('Connect each store to its Eleme shop, then turn the channel on.',
                                  '将每个门店连接到对应的饿了么店铺,然后开启渠道。');
          note.style.color = '';
        }
      }
    } catch (e) { /* surfaced by api() */ }
  };

  window.elToggleEnabled = async function (on) {
    try {
      await api('/api/retail-admin/eleme/enable', { method: 'POST', body: { enabled: !!on } });
      _enabled = !!on;
      const txt = document.getElementById('el-enable-txt');
      if (txt) txt.textContent = on ? cuT('On · 开启', 'On · 开启') : cuT('Off · 关闭', 'Off · 关闭');
    } catch (e) {
      const cb = document.getElementById('el-enable');
      if (cb) cb.checked = !on; // revert on failure
    }
  };

  // ── Stores + connection ──────────────────────────────────────────────────────
  window.elLoadStores = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/stores');
      _stores = r.data || [];
      elRenderStores();
      elRenderProducts(); // store columns depend on _stores
    } catch (e) {}
  };

  function elRenderStores() {
    const box = document.getElementById('el-stores');
    if (!box) return;
    if (!_stores.length) { box.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0">No active stores.</div>'; return; }
    box.innerHTML = _stores.map(s => {
      const connected = Number(s.connected) === 1;
      const shopSet = !!s.shop_id;
      let status, action;
      if (!connected) {
        status = `<span class="muted">${cuT('Not connected', '未连接')}</span>`;
        action = `<button class="btn btn-sm btn-primary" ${_configured ? '' : 'disabled'} onclick="elConnect(${s.id}, '${s.code}')">${cuT('Connect Eleme · 连接', '连接饿了么')}</button>`;
      } else if (!shopSet) {
        status = `<span style="color:var(--warn,#b8860b)">${cuT('Connected — shop not set', '已连接 — 未设置店铺')}</span>`;
        action = `<input id="el-shop-${s.id}" class="inp" style="width:140px" placeholder="${cuT('Eleme shop id', '饿了么店铺ID')}">
                  <button class="btn btn-sm" onclick="elSetShop(${s.id}, '${s.code}')">${cuT('Save · 保存', '保存')}</button>
                  <button class="btn btn-sm" onclick="elConnect(${s.id}, '${s.code}')">${cuT('Reconnect · 重连', '重连')}</button>`;
      } else {
        status = `<span style="color:var(--ok,#2e8b57)">${cuT('Connected', '已连接')} · ${s.shop_name || s.shop_id}</span>`;
        action = `<button class="btn btn-sm" onclick="elConnect(${s.id}, '${s.code}')">${cuT('Reconnect · 重连', '重连')}</button>`;
      }
      return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 0;border-bottom:1px dashed var(--line)">
        <b style="min-width:120px">${s.name}</b>${status}<span style="flex:1 1 auto"></span>${action}</div>`;
    }).join('');
  }

  window.elConnect = async function (storeId, storeCode) {
    try {
      const r = await api(`/api/retail-admin/eleme/oauth/start?storeId=${storeId}&storeCode=${encodeURIComponent(storeCode)}`);
      if (r.url) window.open(r.url, '_blank', 'noopener');
    } catch (e) {}
  };

  window.elSetShop = async function (storeId, storeCode) {
    const inp = document.getElementById('el-shop-' + storeId);
    const shopId = inp ? inp.value.trim() : '';
    if (!shopId) return;
    try {
      await api('/api/retail-admin/eleme/shop', { method: 'POST', body: { storeId, storeCode, shopId } });
      elLoadStores();
    } catch (e) {}
  };

  // ── Status ───────────────────────────────────────────────────────────────────
  let _pollTimer = null, _pollBusy = false;
  function elTabVisible() {
    return !document.hidden && !!document.getElementById('tab-eleme')?.classList.contains('active');
  }
  function elStartPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (_pollBusy || !elTabVisible()) return;
      _pollBusy = true;
      try { await Promise.all([elLoadStatus(), elLoadOrders(true)]); } catch (_) {}
      finally { _pollBusy = false; }
    }, 12000);
  }

  window.elLoadStatus = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/status');
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('el-kpi-daemon', _enabled ? cuT('On · 运行中', 'On · 运行中') : cuT('Off · 已关闭', 'Off · 已关闭'));
      set('el-kpi-mapped', r.mappedCount || 0);
      set('el-kpi-queue', r.queuePending || 0);
      const qTile = document.getElementById('el-kpi-queue-tile');
      if (qTile) qTile.classList.toggle('alert', (r.queueError || 0) > 0);
      const last = (r.lastOrder || [])[0];
      set('el-kpi-order', last ? '✓' : '—');
      const sub = document.getElementById('el-kpi-order-sub');
      if (sub) sub.textContent = last ? `${last.store_code} · ${(last.imported_at || '').slice(5, 16)}` : cuT('no orders yet · 暂无订单', '暂无订单');
      elRenderLog(r.recentSystem || []);
    } catch (e) {}
  };

  function elRenderLog(rows) {
    const box = document.getElementById('el-log-sys');
    if (!box) return;
    if (!rows.length) { box.innerHTML = '<span class="muted">No events yet · 暂无事件</span>'; return; }
    box.innerHTML = rows.map(r => {
      const t = (r.created_at || '').slice(5, 16);
      const colour = r.status === 'error' ? 'var(--danger,#c0392b)' : r.status === 'warn' ? 'var(--warn,#b8860b)' : 'inherit';
      const msg = r.error_msg || r.event_type;
      return `<div style="color:${colour}">${t} [${r.store_code || '-'}] ${r.event_type}: ${esc(msg)}</div>`;
    }).join('');
  }

  // ── Incoming orders ──────────────────────────────────────────────────────────
  window.elLoadOrders = async function (silent) {
    const list = document.getElementById('el-orders-list');
    const cnt  = document.getElementById('el-orders-count');
    if (!list) return;
    if (!silent || !list.children.length) list.innerHTML = '<div class="muted" style="font-size:13px;padding:10px 0">Loading…</div>';
    try {
      const r = await api('/api/retail-admin/eleme/orders?limit=30');
      const orders = r.data || [];
      if (cnt) cnt.textContent = orders.length ? `(${orders.length})` : '';
      if (!orders.length) { list.innerHTML = '<div class="muted" style="font-size:13px;padding:10px 0">No Eleme orders yet · 暂无饿了么订单</div>'; return; }
      list.innerHTML = orders.map(o => {
        const items = (o.items || []).map(i => `${cuT(i.name_en || i.name_cn, i.name_cn || i.name_en)}×${i.qty}`).join(', ');
        const when = (o.placed_at || '').slice(5, 16);
        return `<div style="padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px">
          <b>¥${(o.total || 0).toFixed ? o.total.toFixed(2) : o.total}</b>
          <span class="muted"> · ${o.store_code || ''} · ${when}</span><br>
          <span class="muted">${esc(items)}</span></div>`;
      }).join('');
    } catch (e) { list.innerHTML = `<div class="muted" style="font-size:13px;padding:10px 0">${esc(e.message)}</div>`; }
  };

  // ── Product mapping ──────────────────────────────────────────────────────────
  window.elLoadProducts = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/products');
      _products = r.data || [];
      elRenderProducts();
    } catch (e) {}
  };

  window.elFilterProducts = function () { elRenderProducts(); };

  function elRenderProducts() {
    const tbody = document.getElementById('el-tbody');
    if (!tbody) return;
    const th = document.getElementById('el-th-stores');
    if (th) th.textContent = cuT('Sync per store · 各门店同步', '各门店同步');
    const q = (document.getElementById('el-search')?.value || '').trim().toLowerCase();
    const rows = _products.filter(p => {
      if (!q) return true;
      return (p.name_cn || '').toLowerCase().includes(q)
          || (p.name_en || '').toLowerCase().includes(q)
          || (p.sku || '').toLowerCase().includes(q);
    });
    const cnt = document.getElementById('el-count');
    if (cnt) cnt.textContent = `${rows.length}`;
    tbody.innerHTML = rows.map(p => {
      const nm = cuT(p.name_en || p.name_cn, p.name_cn || p.name_en);
      const cells = _stores.map(s => {
        const m = (p.stores || {})[s.code];
        const on = m && Number(m.sync_enabled) === 1;
        return `<label class="toggle-label" style="margin-right:14px" title="${esc(s.name)}">
          <input type="checkbox" ${on ? 'checked' : ''} onchange="elToggleSync(${p.id}, ${s.id}, '${s.code}', this.checked)">
          <span class="muted" style="font-size:12px">${esc(s.name)}</span></label>`;
      }).join('');
      return `<tr style="border-top:1px solid var(--line)">
        <td style="padding:6px 10px">${esc(nm)}${Number(p.is_active) === 0 ? ' <span class="muted">(' + cuT('hidden', '隐藏') + ')</span>' : ''}</td>
        <td style="padding:6px 10px"><code>${esc(p.sku || '—')}</code></td>
        <td style="padding:6px 10px">${cells || '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  window.elToggleSync = async function (productId, storeId, storeCode, on) {
    try {
      await api('/api/retail-admin/eleme/products/' + productId + '/map', {
        method: 'POST',
        body: on ? { storeId, storeCode, syncEnabled: 1 } : { storeId, storeCode, remove: 1 },
      });
      // Reflect locally without a full reload.
      const p = _products.find(x => x.id === productId);
      if (p) {
        p.stores = p.stores || {};
        if (on) p.stores[storeCode] = { sync_enabled: 1 };
        else delete p.stores[storeCode];
      }
    } catch (e) { elLoadProducts(); }
  };

  window.elPushAll = async function () {
    const btn = document.getElementById('el-pushall-btn');
    if (btn) { btn.disabled = true; btn.textContent = cuT('Queuing… · 排队中…', '排队中…'); }
    try {
      const r = await api('/api/retail-admin/eleme/push-all', { method: 'POST' });
      if (window.toast) toast(cuT(`Queued ${r.queued} product(s)`, `已排队 ${r.queued} 个商品`));
      elLoadStatus();
    } catch (e) {} finally {
      if (btn) { btn.disabled = false; btn.textContent = cuT('Push all stock · 推送全部库存', '推送全部库存'); }
    }
  };

  // ── util ──────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
