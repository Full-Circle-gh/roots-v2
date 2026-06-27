/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Guanyi (gzgrocery) Sync admin tab — product mapping + status. */
/* namespace: gy* — mirrors 11-meituan.js but for the Guanyi C-ERP channel. */

(function () {
  'use strict';

  // esc() is defined per-tab in this codebase (not global); the shared helper is
  // escapeHtml() from 01-core.js. Alias it so our markup escaping works.
  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  let _products = [];   // products + map + suggestion (+ our_qty)
  let _storeCode = '';
  let _initiated = false;

  // ── Entry ────────────────────────────────────────────────────────────────
  window.gyAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await Promise.all([gyLoadStatus(), gyLoadListings()]);
    await gyLoadProducts();
    gyStartPolling();
  };

  // ── Live refresh while the tab is visible ──────────────────────────────────
  let _pollTimer = null, _pollBusy = false;
  function gyTabVisible() {
    return !document.hidden && !!document.getElementById('tab-guanyi')?.classList.contains('active');
  }
  function gyStartPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (_pollBusy || !gyTabVisible()) return;
      _pollBusy = true;
      try { await Promise.all([gyLoadStatus(), gyLoadListings(true)]); } catch (_) {}
      finally { _pollBusy = false; }
    }, 12000);
  }

  // Turn one raw sync-log row into a plain, human-readable line.
  // detail is {name, sku, target, was, delta, skipped}; never print raw JSON.
  function gyFmtLogLine(l) {
    let d = {};
    try { d = l.detail ? JSON.parse(l.detail) : {}; } catch { d = {}; }
    const noChange = l.status === 'ok' && d.skipped;
    const glyph = l.status === 'error' ? '✗'
      : l.status === 'skipped' ? '⊘'
      : noChange ? '–' : '✓';
    const name = d.name || (d.sku ? '' : '(no name · 无名称)');
    const sku = d.sku ? ' · ' + d.sku : '';
    const who = (name + sku).trim();
    let change = '';
    if (l.status === 'ok') {
      change = noChange
        ? 'no change · 无变化 (' + (d.target != null ? d.target : '?') + ')'
        : (d.was != null ? d.was + ' → ' : '') + (d.target != null ? d.target : '?')
          + (d.delta != null ? ' (' + (d.delta > 0 ? '+' : '') + d.delta + ')' : '');
    }
    const time = (l.created_at || '').replace('T', ' ').slice(0, 19);
    const reason = l.error_msg ? '  — ' + l.error_msg : '';
    return `${time}  ${glyph} ${l.store_code}  ${who}  ${change}${reason}`.replace(/\s+$/, '');
  }

  // ── Status KPIs ─────────────────────────────────────────────────────────────
  window.gyLoadStatus = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/status');
      setText('gy-kpi-mapped', r.mappedCount);
      setText('gy-kpi-queue', r.queuePending);
      const qTile = document.getElementById('gy-kpi-queue-tile');
      if (qTile) qTile.classList.toggle('alert', (r.queueError || 0) > 0);
      setText('gy-kpi-queue-sub', (r.queueError ? `${r.queueError} error · 出错` : 'pending · 待推送'));
      const log = document.getElementById('gy-log');
      if (log) {
        log.textContent = (r.recentLogs || []).map(gyFmtLogLine).join('\n')
          || 'No activity yet · 暂无记录';
      }
    } catch (e) { console.warn('[guanyi] status', e); }
  };

  // ── Listings cache + refresh job ─────────────────────────────────────────────
  window.gyLoadListings = async function (silent) {
    try {
      const r = await api('/api/retail-admin/guanyi/listings');
      const n = (r.listings || []).length;
      setText('gy-kpi-listings', n);
      const job = r.job;
      const sub = job
        ? (r.running ? 'refreshing… · 刷新中' : `${n} cached · ${job.completed_at ? (job.completed_at.replace('T', ' ').slice(0, 16)) : ''}`)
        : 'never refreshed · 未刷新';
      setText('gy-kpi-listings-sub', sub);
      const btn = document.getElementById('gy-refresh-btn');
      if (btn) btn.disabled = !!r.running;
      return r;
    } catch (e) { if (!silent) console.warn('[guanyi] listings', e); }
  };

  // Refresh the Guanyi product list via the daemon, polling until the job lands.
  window.gyRefreshListings = async function () {
    const btn = document.getElementById('gy-refresh-btn');
    try {
      if (btn) { btn.disabled = true; btn.textContent = '⟳ Refreshing…'; }
      await api('/api/retail-admin/guanyi/listings/refresh', { method: 'POST' });
      // Poll the job up to ~60s.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const r = await gyLoadListings(true);
        if (r && !r.running) break;
      }
      await gyLoadProducts();
      toast('Guanyi product list refreshed · 已刷新');
    } catch (e) {
      toast('Refresh failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⟳ Refresh Guanyi list'; }
    }
  };

  // ── Auto-match by SKU embedded in the Guanyi name ─────────────────────────────
  window.gyAutoMatch = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/auto-match', { method: 'POST' });
      if (r.note) { toast(r.note); return; }
      let msg = `Matched ${r.matched} product(s)`;
      if (r.ambiguous && r.ambiguous.length) msg += ` · ${r.ambiguous.length} ambiguous`;
      if (r.unmatched) msg += ` · ${r.unmatched} unmatched`;
      toast(msg);
      await Promise.all([gyLoadProducts(), gyLoadStatus()]);
    } catch (e) { toast('Auto-match failed: ' + e.message, 'error'); }
  };

  // ── Products + mapping table ──────────────────────────────────────────────────
  window.gyLoadProducts = async function () {
    const body = document.getElementById('gy-products-body');
    if (body && !_products.length) body.innerHTML = '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">Loading…</td></tr>';
    try {
      const r = await api('/api/retail-admin/guanyi/products');
      _products = r.data || [];
      _storeCode = r.storeCode || '';
      gyRenderProducts();
    } catch (e) {
      if (body) body.innerHTML = `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">Error: ${esc(e.message)}</td></tr>`;
    }
  };

  function gyRenderProducts() {
    const body = document.getElementById('gy-products-body');
    if (!body) return;
    const term = (document.getElementById('gy-search')?.value || '').trim().toLowerCase();
    const unmappedOnly = !!document.getElementById('gy-show-unmapped')?.checked;

    const rows = _products.filter(p => {
      if (unmappedOnly && p.map) return false;
      if (!term) return true;
      return [p.name_cn, p.name_en, p.product_sku, p.map && p.map.guanyi_name]
        .filter(Boolean).join(' ').toLowerCase().includes(term);
    });

    setText('gy-count', `${rows.length} / ${_products.length}`);
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No products</td></tr>'; return; }

    body.innerHTML = rows.map(p => {
      const name = esc([p.name_cn, p.name_en].filter(Boolean).join(' '))
        + (p.variant_label ? ` <span class="muted">(${esc(p.variant_label)})</span>` : '');
      const sku = esc(p.product_sku || '—');
      const ourQty = Number(p.our_qty || 0);

      // Guanyi side: prefer the saved mapping, else the auto-match suggestion.
      const m = p.map, sg = p.suggestion;
      let gyCell, gyQty, sync, delta = '';
      if (m) {
        const gqty = sg ? Number(sg.current_qty) : null;
        gyCell = `<div style="font-size:12px">${esc(m.guanyi_name || '—')}</div>
          <div class="muted" style="font-size:11px">${esc(m.guanyi_code || '')}
            <button class="btn btn-sm" style="padding:0 6px;margin-left:6px" onclick="gyUnbind(${p.id})" title="Unbind">✕</button></div>`;
        gyQty = gqty == null ? '<span class="muted">?</span>' : String(gqty);
        if (gqty != null) {
          const d = ourQty - gqty;
          delta = d === 0 ? '<span style="color:var(--ok,#2a8)">=</span>'
            : `<span style="color:${d > 0 ? '#c80' : '#c00'}">${d > 0 ? '+' : ''}${d}</span>`;
        }
        sync = `<label class="toggle-label" title="Enable/disable sync"><input type="checkbox" ${m.sync_enabled ? 'checked' : ''} onchange="gyToggleSync(${p.id}, this.checked)"></label>`;
      } else if (sg) {
        gyCell = `<div style="font-size:12px">${esc(sg.guanyi_name)}</div>
          <button class="btn btn-sm" style="padding:1px 8px;margin-top:3px" onclick="gyBind(${p.id}, '${esc(String(sg.sku_id))}')">Bind →</button>`;
        gyQty = sg.current_qty == null ? '<span class="muted">?</span>' : String(sg.current_qty);
        sync = '<span class="muted" style="font-size:11px">—</span>';
      } else {
        gyCell = '<span class="muted" style="font-size:12px">no match</span>';
        gyQty = '<span class="muted">—</span>';
        sync = '<span class="muted" style="font-size:11px">—</span>';
      }

      return `<tr>
        <td>${name}<div class="muted" style="font-size:11px">SKU ${sku}</div></td>
        <td style="text-align:center;font-weight:600">${ourQty}</td>
        <td>${gyCell}</td>
        <td style="text-align:center">${gyQty} ${delta}</td>
        <td style="text-align:center">${sync}</td>
      </tr>`;
    }).join('');
  }

  window.gyFilterProducts = gyRenderProducts;

  // ── Mapping actions ───────────────────────────────────────────────────────────
  async function gyMap(productId, payload, okMsg) {
    const r = await api('/api/retail-admin/guanyi/products/' + productId + '/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (okMsg) toast(okMsg);
    return r;
  }

  window.gyBind = async function (productId, skuId) {
    try { await gyMap(productId, { skuId, syncEnabled: true }, 'Bound · 已绑定'); await Promise.all([gyLoadProducts(), gyLoadStatus()]); }
    catch (e) { toast('Bind failed: ' + e.message, 'error'); }
  };
  window.gyUnbind = async function (productId) {
    try { await gyMap(productId, { skuId: '' }, 'Unbound · 已解绑'); await Promise.all([gyLoadProducts(), gyLoadStatus()]); }
    catch (e) { toast('Unbind failed: ' + e.message, 'error'); }
  };
  window.gyToggleSync = async function (productId, checked) {
    try { await gyMap(productId, { syncEnabled: !!checked }); }
    catch (e) { toast('Update failed: ' + e.message, 'error'); }
  };

  window.gyPushAll = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/push-all', { method: 'POST' });
      toast(`Queued ${r.queued} reconcile(s) to Guanyi`);
      await gyLoadStatus();
    } catch (e) { toast('Push failed: ' + e.message, 'error'); }
  };

  // ── tiny helpers ──────────────────────────────────────────────────────────────
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v); }
})();
