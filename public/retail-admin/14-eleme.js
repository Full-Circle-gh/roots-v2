/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Eleme Sync admin tab — feature switch + OAuth connect + product mapping + status */
/* namespace: el* */

(function () {
  'use strict';

  let _products = [];
  let _stores   = [];
  let _enabled  = false;
  let _initiated = false;
  let _catalogue = {}; // storeCode -> [{name, stock, updated_at}], see elLoadCatalogue

  // ── Entry point ────────────────────────────────────────────────────────────
  window.elAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await elLoadConfig();
    await Promise.all([elLoadStores(), elLoadStatus()]);
    await elLoadProducts();
    elLoadCatalogue();
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
  // Eleme is browser automation (lib/eleme-browser.js), not OAuth — there is no
  // server-side app key to configure, so this note is always the same "link a
  // shop id, then log in once" instruction (see elRenderStores' session status).
  window.elLoadConfig = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/config');
      _enabled = !!r.enabled;
      const cb = document.getElementById('el-enable');
      if (cb) cb.checked = _enabled;
      const txt = document.getElementById('el-enable-txt');
      if (txt) txt.textContent = _enabled ? cuT('On · 开启', 'On · 开启') : cuT('Off · 关闭', 'Off · 关闭');
      const note = document.getElementById('el-conn-note');
      if (note) {
        note.textContent = cuT(
          'Enter each store’s Eleme shop id below, then log it in once via `node scripts/eleme-login.js <code> <shopId>` before turning the channel on.',
          '在下方为每个门店填写饿了么店铺ID,并通过 `node scripts/eleme-login.js <code> <shopId>` 完成一次登录后,再开启渠道。');
        note.style.color = '';
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

  // Eleme is browser automation, not OAuth — a store's real state is two
  // independent facts: is a shop id linked (elSetShop below), and is there an
  // active login session (sessionActive, written by scripts/eleme-login.js).
  function elRenderStores() {
    const box = document.getElementById('el-stores');
    if (!box) return;
    if (!_stores.length) { box.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0">No active stores.</div>'; return; }
    box.innerHTML = _stores.map(s => {
      const shopSet = !!s.shop_id;
      let status, action;
      if (!shopSet) {
        status = `<span class="muted">${cuT('Shop not linked', '未关联店铺')}</span>`;
        action = `<input id="el-shop-${s.id}" class="inp" style="width:140px" placeholder="${cuT('Eleme shop id', '饿了么店铺ID')}">
                  <button class="btn btn-sm btn-primary" onclick="elSetShop(${s.id}, '${s.code}')">${cuT('Save · 保存', '保存')}</button>`;
      } else if (!s.sessionActive) {
        status = `<span style="color:var(--warn,#b8860b)">${cuT('Linked', '已关联')} · ${s.shop_name || s.shop_id} — ${cuT('needs login', '需要登录')}</span>`;
        action = `<code data-no-i18n style="font-size:11.5px">node scripts/eleme-login.js ${s.code} ${s.shop_id}</code>`;
      } else {
        status = `<span style="color:var(--ok,#2e8b57)">${cuT('Connected', '已连接')} · ${s.shop_name || s.shop_id}</span>`;
        action = '';
      }
      return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 0;border-bottom:1px dashed var(--line)">
        <b style="min-width:120px">${s.name}</b>${status}<span style="flex:1 1 auto"></span>${action}</div>`;
    }).join('');
  }

  // ── Eleme catalogue cache (autocomplete source for the name-override field) ──
  // Reads the DB cache scripts/eleme-daemon.js writes (the live catalogue only
  // exists inside the daemon's browser session, a separate process — see
  // routes/eleme-admin.js's /eleme/catalogue). Built after a live mismatch: a
  // hand-typed Eleme name used a straight apostrophe where the real listing
  // had a curly one and silently failed every push — picking from a real,
  // exact string makes that whole class of error impossible.
  window.elLoadCatalogue = async function () {
    for (const s of _stores) {
      try {
        const r = await api('/api/retail-admin/eleme/catalogue?storeCode=' + encodeURIComponent(s.code));
        _catalogue[s.code] = { rows: r.data || [], refreshedAt: r.refreshedAt || null };
      } catch (e) { _catalogue[s.code] = { rows: [], refreshedAt: null }; }
    }
    elRenderCatalogueDatalists();
    elRenderCatalogueCaption();
    elRenderProducts(); // re-render so the name inputs pick up list= now that options exist
  };

  function elRenderCatalogueCaption() {
    const el = document.getElementById('el-catalogue-caption');
    if (!el || !_stores.length) return;
    el.textContent = _stores.map(s => `${s.name}: ${elCatalogueCaption(s.code)}`).join('   ·   ');
  }

  // One <datalist> per store (their Eleme catalogues differ) — datalists have
  // no visible presence, so they live in a hidden container appended once.
  function elRenderCatalogueDatalists() {
    let host = document.getElementById('el-catalogue-datalists');
    if (!host) {
      host = document.createElement('div');
      host.id = 'el-catalogue-datalists';
      host.style.display = 'none';
      document.body.appendChild(host);
    }
    host.innerHTML = _stores.map(s => {
      const rows = (_catalogue[s.code] && _catalogue[s.code].rows) || [];
      const opts = rows.map(r => `<option value="${esc(r.name)}">`).join('');
      return `<datalist id="el-catalogue-dl-${esc(s.code)}">${opts}</datalist>`;
    }).join('');
  }

  // Freshness caption, e.g. "204 listings · updated 12 min ago". Shown once
  // above the mapping table so it's clear when the autocomplete data is stale
  // (the daemon refreshes it every ~30 min).
  function elCatalogueCaption(storeCode) {
    const c = _catalogue[storeCode];
    if (!c || !c.rows.length) return cuT('no catalogue cached yet', '暂无缓存目录');
    const mins = c.refreshedAt ? Math.max(0, Math.round((Date.now() - Date.parse(c.refreshedAt.replace(' ', 'T') + 'Z')) / 60000)) : null;
    const age = mins == null ? '' : (mins < 1 ? cuT(' · just now', ' · 刚刚') : cuT(` · updated ${mins} min ago`, ` · ${mins} 分钟前更新`));
    return `${c.rows.length}${cuT(' listings', ' 个商品')}${age}`;
  }

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
      elRenderPushLog(r.recentStock || []);
      elRenderLog(r.recentSystem || []);
    } catch (e) {}
  };

  // Per-product push results (success/fail) — the backend has always returned
  // this (recentStock on /eleme/status), nothing rendered it. Resolves
  // product_id against the already-loaded _products list for a readable name;
  // falls back to the SKU/raw id when the product list hasn't loaded yet.
  function elRenderPushLog(rows) {
    const box = document.getElementById('el-log-stock');
    if (!box) return;
    if (!rows.length) { box.innerHTML = '<span class="muted">No pushes yet · 暂无推送</span>'; return; }
    box.innerHTML = rows.map(r => {
      const t = (r.created_at || '').slice(5, 16);
      let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (e) {}
      const prod = _products.find(x => x.id === d.product_id);
      const name = prod ? (prod.name_cn || prod.name_en) : (d.sku || ('#' + d.product_id));
      const colour = r.status === 'error' ? 'var(--danger,#c0392b)' : 'inherit';
      const qty = d.qty != null ? ` → ${d.qty}` : '';
      const err = r.status === 'error' ? `: ${esc(r.error_msg || '')}` : '';
      return `<div style="color:${colour}">${t} [${r.store_code || '-'}] ${esc(name)}${qty}${err}</div>`;
    }).join('');
  }

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
        // Eleme has no extCode/货号 to match on yet, so a wrong/missing name
        // here is the single most common reason a push fails — this input is
        // the operator's escape hatch (ELEME_BROWSER_RECON.md). It's an
        // autocomplete against the real Eleme catalogue (list=), not free
        // text — a hand-typed name once used the wrong apostrophe character
        // and silently failed every push; picking from a real listing string
        // makes that whole class of error impossible.
        return `<div style="display:inline-flex;align-items:center;gap:6px;margin-right:14px;margin-bottom:4px">
          <label class="toggle-label" title="${esc(s.name)}">
            <input type="checkbox" ${on ? 'checked' : ''} onchange="elToggleSync(${p.id}, ${s.id}, '${s.code}', this.checked)">
            <span class="muted" style="font-size:12px">${esc(s.name)}</span>
          </label>
          <input type="text" class="inp" style="width:130px;font-size:11px" data-no-i18n
                 list="el-catalogue-dl-${esc(s.code)}"
                 placeholder="${cuT('Eleme listing name', '饿了么商品名')}"
                 value="${esc(m && m.eleme_name || '')}"
                 onchange="elSetElemeName(${p.id}, ${s.id}, '${s.code}', this.value)">
        </div>`;
      }).join('');
      return `<tr style="border-top:1px solid var(--line)">
        <td style="padding:6px 10px">${esc(nm)}${Number(p.is_active) === 0 ? ' <span class="muted">(' + cuT('hidden', '隐藏') + ')</span>' : ''}</td>
        <td style="padding:6px 10px"><code>${esc(p.sku || '—')}</code></td>
        <td style="padding:6px 10px">${cells || '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  window.elToggleSync = async function (productId, storeId, storeCode, on) {
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    try {
      // Pass the existing eleme_name through — the map POST upserts the whole
      // row, so omitting it here would silently null out an override the
      // operator already set (elSetElemeName below has the matching problem
      // in reverse).
      await api('/api/retail-admin/eleme/products/' + productId + '/map', {
        method: 'POST',
        body: on ? { storeId, storeCode, syncEnabled: 1, elemeName: (cur && cur.eleme_name) || null }
                 : { storeId, storeCode, remove: 1 },
      });
      // Reflect locally without a full reload.
      if (p) {
        p.stores = p.stores || {};
        if (on) p.stores[storeCode] = { ...(cur || {}), sync_enabled: 1 };
        else delete p.stores[storeCode];
      }
    } catch (e) { elLoadProducts(); }
  };

  // Save a product's Eleme listing-name override for one store. Deliberately
  // does NOT change sync_enabled — typing a name shouldn't silently turn
  // pushing on for a product the operator hasn't reviewed yet; the checkbox
  // stays the only way to do that.
  window.elSetElemeName = async function (productId, storeId, storeCode, value) {
    const name = value.trim();
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    try {
      await api('/api/retail-admin/eleme/products/' + productId + '/map', {
        method: 'POST',
        body: { storeId, storeCode, elemeName: name || null, syncEnabled: cur ? Number(cur.sync_enabled) : 0 },
      });
      if (p) {
        p.stores = p.stores || {};
        p.stores[storeCode] = { ...(cur || {}), eleme_name: name || null, sync_enabled: cur ? Number(cur.sync_enabled) : 0 };
      }
      if (window.toast) toast(cuT('Saved · 已保存', '已保存'));
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
