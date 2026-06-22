/* Meituan Sync admin tab — product mapping + status dashboard */
/* namespace: mt* */

(function () {
  'use strict';

  let _products  = [];  // full product list with store mappings
  let _stores    = [];  // [{id, name, code}]
  let _storeA    = null; // 天河
  let _storeB    = null; // 越秀
  let _initiated = false;

  // ── Entry point ────────────────────────────────────────────────────────────
  window.mtAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await Promise.all([mtLoadStores(), mtLoadStatus()]);
    await mtLoadProducts();
  };

  // ── Stores ─────────────────────────────────────────────────────────────────
  async function mtLoadStores() {
    try {
      const res = await api('/api/retail-admin/meituan/stores');
      _stores = res.data || [];
      // Try to guess 天河 / 越秀 by code or name
      _storeA = _stores.find(s => s.code === 'tianhe' || s.name?.includes('天河')) || _stores[0] || null;
      _storeB = _stores.find(s => s.code === 'yuexiu' || s.name?.includes('越秀')) || _stores[1] || null;
      // Update column headers
      if (_storeA) document.getElementById('mt-th-store-0').textContent = (_storeA.name || '天河') + ' · Meituan name';
      if (_storeB) document.getElementById('mt-th-store-1').textContent = (_storeB.name || '越秀') + ' · Meituan name';
    } catch (e) {
      console.warn('[meituan] loadStores error', e);
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  window.mtLoadStatus = async function () {
    const bar = document.getElementById('mt-status-bar');
    const log = document.getElementById('mt-log');
    try {
      const s = await api('/api/retail-admin/meituan/status');
      bar.innerHTML = `
        <span style="color:var(--fg-ok)">● Daemon active</span>
        <span class="sep">·</span>
        <b>${s.mappedCount}</b> products mapped
        <span class="sep">·</span>
        Queue: <b>${s.queuePending}</b> pending
        ${s.queueFailed ? `<span style="color:var(--fg-warn)"> / ${s.queueFailed} failed</span>` : ''}
        ${s.lastOrder.length ? `<span class="sep">·</span>Last order: <b>${s.lastOrder[0].meituan_order_no}</b> (${s.lastOrder[0].store_code}) ${fmtAgo(s.lastOrder[0].imported_at)}` : ''}
      `;
      if (log) {
        log.textContent = s.recentLogs.length
          ? s.recentLogs.map(l => `[${l.created_at?.slice(11,19)}] ${l.store_code} ${l.event_type} ${l.status}${l.detail ? ' ' + l.detail : ''}${l.error_msg ? ' ERR:' + l.error_msg : ''}`).join('\n')
          : 'No sync events yet.';
      }
    } catch (e) {
      bar.innerHTML = `<span style="color:var(--fg-warn)">● Could not reach daemon status API</span>`;
    }
  };

  // ── Push all ───────────────────────────────────────────────────────────────
  window.mtPushAll = async function () {
    const btn = document.querySelector('#tab-meituan .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Queuing…'; }
    try {
      const r = await api('/api/retail-admin/meituan/push-all', { method: 'POST' });
      toast(`Queued ${r.queued} stock push(es) to Meituan`);
      await mtLoadStatus();
    } catch (e) {
      toast('Push failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Push all stock now'; }
    }
  };

  // ── Products ───────────────────────────────────────────────────────────────
  async function mtLoadProducts() {
    const tbody = document.getElementById('mt-products-body');
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:24px;text-align:center">Loading…</td></tr>';
    try {
      const res = await api('/api/retail-admin/meituan/products');
      _products = res.data || [];
      mtRenderProducts();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:24px;text-align:center">Error: ${escape(e.message)}</td></tr>`;
    }
  }

  function mtRenderProducts(filtered) {
    const list   = filtered || _products;
    const tbody  = document.getElementById('mt-products-body');
    const storeA = _storeA;
    const storeB = _storeB;

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:24px;text-align:center">No products found.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(p => {
      const mapA = storeA ? (p.stores[storeA.code] || {}) : {};
      const mapB = storeB ? (p.stores[storeB.code] || {}) : {};
      const anyMapped = mapA.meituan_name || mapB.meituan_name;
      const syncA = mapA.sync_enabled !== 0;
      const syncB = mapB.sync_enabled !== 0;

      return `<tr data-pid="${p.id}" class="mt-product-row${anyMapped ? '' : ' mt-unmapped'}">
        <td>
          <div style="font-weight:600;line-height:1.3">${esc(p.name_cn || '')}</div>
          <div class="muted" style="font-size:11px">${esc(p.name_en || '')}</div>
        </td>
        <td>
          ${storeA ? `<input type="text"
            class="form-control mt-name-input"
            style="font-size:12px"
            placeholder="Meituan 商品名 (天河)"
            value="${esc(mapA.meituan_name || '')}"
            data-pid="${p.id}"
            data-store-id="${storeA.id}"
            data-store-code="${storeA.code}"
            onblur="mtSaveMap(this)"
            onkeydown="if(event.key==='Enter')this.blur()">
          ${mapA.last_pushed_at ? `<div class="muted" style="font-size:10px;margin-top:2px">Last: ${mapA.last_pushed_qty} · ${fmtAgo(mapA.last_pushed_at)}</div>` : ''}` : '<span class="muted">—</span>'}
        </td>
        <td>
          ${storeB ? `<input type="text"
            class="form-control mt-name-input"
            style="font-size:12px"
            placeholder="Meituan 商品名 (越秀)"
            value="${esc(mapB.meituan_name || '')}"
            data-pid="${p.id}"
            data-store-id="${storeB.id}"
            data-store-code="${storeB.code}"
            onblur="mtSaveMap(this)"
            onkeydown="if(event.key==='Enter')this.blur()">
          ${mapB.last_pushed_at ? `<div class="muted" style="font-size:10px;margin-top:2px">Last: ${mapB.last_pushed_qty} · ${fmtAgo(mapB.last_pushed_at)}</div>` : ''}` : '<span class="muted">—</span>'}
        </td>
        <td style="text-align:center">
          ${anyMapped ? `<label class="toggle-label" title="Enable/disable sync">
            <input type="checkbox" ${(syncA || syncB) ? 'checked' : ''} data-pid="${p.id}" onchange="mtToggleSync(this)">
          </label>` : '<span class="muted" style="font-size:11px">—</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  // ── Save mapping ────────────────────────────────────────────────────────────
  window.mtSaveMap = async function (input) {
    const pid       = input.dataset.pid;
    const storeId   = input.dataset.storeId;
    const storeCode = input.dataset.storeCode;
    const name      = input.value.trim();

    // Skip if unchanged (compare with cached value)
    const product  = _products.find(p => p.id == pid);
    const existing = product?.stores?.[storeCode];
    if ((existing?.meituan_name || '') === name) return;

    input.style.opacity = '0.5';
    try {
      await api(`/api/retail-admin/meituan/products/${pid}/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: parseInt(storeId), storeCode, meituanName: name, syncEnabled: 1 }),
      });
      // Update local cache
      if (product) {
        if (!product.stores) product.stores = {};
        if (name) {
          product.stores[storeCode] = { ...(product.stores[storeCode] || {}), meituan_name: name, sync_enabled: 1 };
        } else {
          delete product.stores[storeCode];
        }
      }
      // Re-render the row's sync toggle without a full reload
      const row = input.closest('tr');
      if (row) {
        const anyMapped = Object.values(product?.stores || {}).some(m => m.meituan_name);
        row.classList.toggle('mt-unmapped', !anyMapped);
        const syncTd = row.querySelector('td:last-child');
        if (syncTd) {
          syncTd.innerHTML = anyMapped
            ? `<label class="toggle-label"><input type="checkbox" checked data-pid="${pid}" onchange="mtToggleSync(this)"></label>`
            : '<span class="muted" style="font-size:11px">—</span>';
        }
      }
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
    input.style.opacity = '';
  };

  // ── Toggle sync ─────────────────────────────────────────────────────────────
  window.mtToggleSync = async function (checkbox) {
    const pid     = checkbox.dataset.pid;
    const product = _products.find(p => p.id == pid);
    if (!product) return;
    // Toggle sync_enabled for all stores this product is mapped to
    for (const [code, map] of Object.entries(product.stores || {})) {
      if (!map.meituan_name) continue;
      const store = _stores.find(s => s.code === code);
      if (!store) continue;
      try {
        await api(`/api/retail-admin/meituan/products/${pid}/map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: store.id, storeCode: code, meituanName: map.meituan_name, syncEnabled: checkbox.checked }),
        });
        map.sync_enabled = checkbox.checked ? 1 : 0;
      } catch (e) {
        toast('Toggle failed: ' + e.message, 'error');
      }
    }
  };

  // ── Filter ──────────────────────────────────────────────────────────────────
  window.mtFilterProducts = function () {
    const q        = (document.getElementById('mt-search')?.value || '').toLowerCase();
    const unmapped = document.getElementById('mt-show-unmapped')?.checked;
    const filtered = _products.filter(p => {
      if (unmapped) {
        const anyMapped = Object.values(p.stores || {}).some(m => m.meituan_name);
        if (anyMapped) return false;
      }
      if (!q) return true;
      return (p.name_cn || '').toLowerCase().includes(q) || (p.name_en || '').toLowerCase().includes(q);
    });
    mtRenderProducts(filtered);
  };

  // ── Utils ───────────────────────────────────────────────────────────────────
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escape(s) { return esc(s); }

  function fmtAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000)  return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }
})();
