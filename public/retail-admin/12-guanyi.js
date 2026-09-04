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

  // Stored timestamps are UTC (SQLite CURRENT_TIMESTAMP / ISO). Render them in
  // the viewer's local timezone so 02:07Z reads as 10:07 here. Tenant-neutral:
  // no hardcoded +8 offset — the browser supplies the zone.
  function gyLocalTime(t, withSeconds) {
    if (!t) return '';
    let s = String(t).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';   // bare value = stored UTC
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(t).replace('T', ' ').slice(0, withSeconds ? 19 : 16);
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? ':' + p(d.getSeconds()) : ''}`;
    return `${date} ${time}`;
  }

  let _products = [];   // products + map + suggestion (+ our_qty)
  let _storeCode = '';
  let _initiated = false;
  let _productsLoaded = false;   // mapping table is deferred until its tab opens

  // ── Entry ────────────────────────────────────────────────────────────────
  window.gyAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    // Overview is the default panel: health strip + pickups + a billing snapshot.
    await Promise.all([gyLoadStatus(), gyLoadListings(), gyLoadPickups()]);
    gyLoadAnalytics(false);   // fetch summary for the teaser; don't build the table yet
    gyStartPolling();
    // Mapping's 189-row table stays unbuilt until the Mapping tab is opened.
  };

  // ── Sub-nav: Overview · Billing · Mapping (one panel mounted at a time) ───────
  window.gySubTab = function (name) {
    ['overview', 'billing', 'mapping'].forEach(n => {
      document.getElementById('gy-panel-' + n)?.classList.toggle('active', n === name);
      document.getElementById('gy-nav-' + n)?.classList.toggle('active', n === name);
    });
    // Lazy-build the heavy surfaces the first time they're needed.
    if (name === 'mapping' && !_productsLoaded) { _productsLoaded = true; gyLoadProducts(); }
    if (name === 'billing') { if (_gyAna.data) gyRenderAnalytics(_gyAna.data); else gyLoadAnalytics(); }
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
      try { await Promise.all([gyLoadStatus(), gyLoadListings(true), gyLoadPickups(true)]); } catch (_) {}
      finally { _pollBusy = false; }
    }, 12000);
  }

  // Turn one raw sync-log row into a plain, human-readable line.
  // detail is {name, sku, target, was, delta, skipped}; never print raw JSON.
  //
  // We LEAD with what changed — "▲+2 → 28 in stock" — so the number (the whole
  // point) sits near the left edge and never gets lost at the end of a long
  // product name. The direction (▲ added / ▼ removed) comes straight from the
  // recorded delta (or was→target), since Guanyi reconciles by writing a doc for
  // the difference. The product name comes last.
  function gyFmtLogLine(l) {
    let d = {};
    try { d = l.detail ? JSON.parse(l.detail) : {}; } catch { d = {}; }
    const cn = document.documentElement.dataset.uiLang === 'cn';
    const noChange = l.status === 'ok' && d.skipped;
    const glyph = l.status === 'error' ? '✗'
      : l.status === 'skipped' ? '⊘'
      : noChange ? '–' : '✓';
    const time = gyLocalTime(l.created_at, true);

    let change = '';
    if (l.status === 'ok') {
      const tgt = d.target != null ? d.target : '?';
      let delta = d.delta;
      if (delta == null && d.was != null && d.target != null) delta = d.target - d.was;
      if (noChange) {
        change = cn ? `库存 ${tgt}(无变化)` : `${tgt} in stock (no change)`;
      } else if (delta != null && delta !== 0) {
        const arrow = delta > 0 ? '▲' : '▼';
        const sign  = delta > 0 ? `+${delta}` : `${delta}`;   // −1, +2…
        change = cn ? `${arrow}${sign} → 库存 ${tgt}` : `${arrow}${sign} → ${tgt} in stock`;
      } else {
        change = cn ? `库存 ${tgt}` : `${tgt} in stock`;
      }
    }
    const name = d.name || (d.sku ? '' : (cn ? '(无名称)' : '(no name)'));
    const prod = [name, d.sku ? `(${d.sku})` : ''].filter(Boolean).join(' ').trim();
    const reason = l.error_msg ? '  — ' + l.error_msg : '';
    const mid = [change, prod].filter(Boolean).join('  ·  ');
    return `${time}  ${glyph} ${l.store_code}  ${mid}${reason}`.replace(/\s+$/, '');
  }

  // ── Sync health strip (was 4 KPI tiles) ──────────────────────────────────────
  // Calm one-liner when green; the queue count + dot turn Brass on a push error.
  window.gyLoadStatus = async function () {
    try {
      const r = await api('/api/retail-admin/guanyi/status');
      setText('gy-h-mapped', r.mappedCount);
      setText('gy-h-queue', r.queuePending);
      setText('gy-nav-map-amt', r.mappedCount);
      const qErr = (r.queueError || 0) > 0;
      document.getElementById('gy-h-queue-f')?.classList.toggle('warn', qErr);
      document.getElementById('gy-h-dot')?.classList.toggle('warn', qErr);
      setText('gy-h-state', qErr ? `${r.queueError} queue error · 推送出错` : 'Syncing · 同步中');
      // The sync log lives in the Activity tab now; keep the write conditional.
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
      setText('gy-h-list', n);
      const job = r.job;
      // The count already shows in the strip, so the sub is just freshness.
      const sub = job
        ? (r.running ? 'refreshing… · 刷新中' : (job.completed_at ? gyLocalTime(job.completed_at, false) : 'cached · 已缓存'))
        : 'never refreshed · 未刷新';
      setText('gy-h-listsub', sub);
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
      if (btn) { btn.disabled = false; btn.textContent = '⟳ Refresh list · 刷新'; }
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
          delta = d === 0 ? '<span style="color:var(--success)">=</span>'
            : `<span style="color:${d > 0 ? 'var(--warn)' : 'var(--danger)'}">${d > 0 ? '+' : ''}${d}</span>`;
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

  // ── gzgrocery pickups (inferred from Guanyi stock drift) ──────────────────────
  window.gyLoadPickups = async function (silent) {
    const wrap = document.getElementById('gy-pickups');
    if (!wrap) return;
    try {
      const r = await api('/api/retail-admin/guanyi/pickups');
      gyRenderPickups(r);
    } catch (e) { if (!silent) console.warn('[guanyi] pickups', e); }
  };

  function gyRenderPickups(r) {
    const wrap = document.getElementById('gy-pickups');
    if (!wrap) return;
    const mode = r.mode || 'off';
    const flagged = r.flagged || [];
    const recent = r.recent || [];
    const sm = r.summary || {};
    const cn = document.documentElement.dataset.uiLang === 'cn';
    // One language only: Chinese name in the CN view, English name in the EN view.
    const pname = (x) => esc(
      (cn ? (x.name_cn || x.name_en) : (x.name_en || x.name_cn))
      || x.guanyi_name || ('#' + x.product_id)
    );
    const psku = (x) => x.product_sku ? `<span class="muted" style="font-size:11px;margin-left:6px">${esc(x.product_sku)}</span>` : '';
    const when = (t) => gyLocalTime(t, false);

    const modeBadge = mode === 'live'
      ? '<span style="background:rgba(163,180,159,.14);color:var(--success);border:1px solid rgba(163,180,159,.35);border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600">● LIVE</span>'
      : mode === 'shadow'
        ? '<span style="background:var(--bg-elev-1);color:var(--text-3);border:1px solid var(--line);border-radius:10px;padding:1px 8px;font-size:11px" title="Detecting + logging only — not changing stock">◌ shadow</span>'
        : '<span style="background:var(--bg-elev-1);color:var(--text-3);border:1px solid var(--line);border-radius:10px;padding:1px 8px;font-size:11px">off</span>';

    let html = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <strong style="font-size:14px">Gzgrocery pickups · 提货扣减</strong> ${modeBadge}
      <span class="muted" style="font-size:12px;margin-left:auto">${sm.appliedEvents24h || 0} applied · ${sm.appliedUnits24h || 0} units (24h)</span>
    </div>`;

    if (flagged.length) {
      html += `<div style="border:1px solid var(--warn);background:color-mix(in srgb, var(--warn) 12%, transparent);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:13px;font-weight:600;color:var(--warn);margin-bottom:6px">⚠ ${flagged.length} flagged drop(s) need your decision · 待确认</div>`
        + flagged.map(f => {
          const drop = Math.abs(f.drift || 0);
          return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid color-mix(in srgb, var(--warn) 28%, transparent)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;color:var(--text-1);font-weight:500">${pname(f)}${psku(f)}</div>
              <div style="font-size:11px;color:var(--text-3)">Guanyi ${f.baseline_qty}→${f.observed_qty} (drop ${drop}) · your stock now ${f.current_qty} · ${when(f.created_at)}</div>
            </div>
            <button class="btn btn-sm btn-primary" onclick="gyApplyPickup(${f.id})" title="Yes, real sale — lower my stock by ${drop}">Apply −${drop}</button>
            <button class="btn btn-sm" onclick="gyIgnorePickup(${f.id})" title="Glitch — keep my stock, correct Guanyi back up">Ignore</button>
          </div>`;
        }).join('') + `</div>`;
    } else {
      html += `<div class="muted" style="font-size:12px;margin-bottom:8px">No flagged drops · 无待确认</div>`;
    }

    if (recent.length) {
      // Preserve the expanded state across the background poll's re-render —
      // otherwise the section snaps shut every refresh cycle.
      const wasOpen = !!wrap.querySelector('#gy-pickups-recent[open]');
      html += `<details id="gy-pickups-recent"${wasOpen ? ' open' : ''}><summary style="cursor:pointer;font-size:12px;color:var(--text-3);padding:2px 0">Recent auto-applied pickups (${recent.length}) · 最近自动扣减</summary>
        <div style="margin-top:6px;font-size:12px;max-height:160px;overflow-y:auto">`
        + recent.map(x => `<div style="display:flex;gap:8px;padding:2px 0">
            <span style="color:var(--danger);font-weight:600;width:44px">−${x.inferred_pickup}</span>
            <span style="flex:1">${pname(x)}${psku(x)}</span>
            <span class="muted">${when(x.created_at)}</span>
          </div>`).join('')
        + `</div></details>`;
    }
    wrap.innerHTML = html;
  }

  window.gyApplyPickup = async function (id) {
    try {
      await api('/api/retail-admin/guanyi/pickups/' + id + '/apply', { method: 'POST' });
      toast('Applied · stock lowered · 已扣减');
      await Promise.all([gyLoadPickups(true), gyLoadProducts(), gyLoadStatus()]);
    } catch (e) { toast('Apply failed: ' + e.message, 'error'); }
  };
  window.gyIgnorePickup = async function (id) {
    try {
      await api('/api/retail-admin/guanyi/pickups/' + id + '/ignore', { method: 'POST' });
      toast('Ignored · Guanyi will be corrected · 已忽略');
      await gyLoadPickups(true);
    } catch (e) { toast('Ignore failed: ' + e.message, 'error'); }
  };

  // ── gzgrocery analytics & billing ─────────────────────────────────────────────
  // Reads the live /guanyi/analytics endpoint (billable units = applied pickups ×
  // imported gzgrocery pricing) and renders the dashboard + Statement CSV export.
  // period '' = no preset selected (all-time default view); Day/Week/Month set it.
  const _gyAna = { period: '', from: '', to: '', data: null };

  // Local YYYY-MM-DD (not UTC) so "today" matches the viewer's calendar day.
  function gyYmd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // Day/Week/Month are quick period presets: they re-scope the date range so the
  // summary cards reflect the chosen window (and the breakdown buckets by it too).
  function gyPeriodRange(p) {
    const now = new Date();
    const today = gyYmd(now);
    if (p === 'week') {
      const dow = (now.getDay() + 6) % 7;            // Mon=0 … Sun=6
      const mon = new Date(now); mon.setDate(now.getDate() - dow);
      return { from: gyYmd(mon), to: today };
    }
    if (p === 'month') {
      return { from: gyYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    }
    return { from: today, to: today };               // day
  }

  window.gySetAnaPeriod = function (p) {
    _gyAna.period = p;
    const r = gyPeriodRange(p);
    _gyAna.from = r.from; _gyAna.to = r.to;
    gyLoadAnalytics();
  };
  window.gyAnaSetRange = function () {
    _gyAna.from = (document.getElementById('gy-ana-from') || {}).value || '';
    _gyAna.to = (document.getElementById('gy-ana-to') || {}).value || '';
    gyLoadAnalytics();
  };

  // renderPanel=false → fetch just for the Overview teaser (skip building the
  // billing table). Defaults to true so period/date changes still redraw the panel.
  window.gyLoadAnalytics = async function (renderPanel) {
    if (renderPanel === undefined) renderPanel = true;
    const wrap = document.getElementById('gy-analytics');
    const qs = new URLSearchParams({ period: _gyAna.period });
    if (_gyAna.from) qs.set('from', _gyAna.from);
    if (_gyAna.to) qs.set('to', _gyAna.to);
    try {
      const r = await api('/api/retail-admin/guanyi/analytics?' + qs.toString());
      _gyAna.data = r;
      gyRenderTeaser(r);
      if (renderPanel && wrap) gyRenderAnalytics(r);
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="muted">Analytics error: ${esc(e.message)}</div>`;
    }
  };

  // The Overview "Billing snapshot" — headline numbers without the full table.
  function gyRenderTeaser(r) {
    const s = r.summary || {};
    const yuan = (n) => acWrap(Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    setText('gy-t-owed', yuan(s.owed));
    setText('gy-t-units', Number(s.units || 0).toLocaleString());
    setText('gy-t-products', s.products || 0);
    const amt = document.getElementById('gy-nav-bill-amt');
    if (amt) amt.textContent = acWrap(Math.round(s.owed || 0).toLocaleString());
  }

  function gyRenderAnalytics(r) {
    const wrap = document.getElementById('gy-analytics');
    if (!wrap) return;
    const yuan = (n) => acWrap(Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const s = r.summary || {};
    const prods = r.products || [];
    const ts = r.timeSeries || [];
    const per = r.period || 'day';
    const btn = (p, label) => `<button class="btn btn-sm ${per === p ? 'btn-primary' : ''}" onclick="gySetAnaPeriod('${p}')">${label}</button>`;

    const card = (label, val, sub) => `<div style="flex:1;min-width:120px;background:var(--bg-elev-1);border:1px solid var(--line);border-radius:8px;padding:10px 12px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">${label}</div>
      <div style="font-size:20px;font-weight:700;margin-top:2px">${val}</div>${sub ? `<div class="muted" style="font-size:11px">${sub}</div>` : ''}</div>`;

    let html = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <span style="font-size:12px" class="muted">Period</span> ${btn('day', 'Day')} ${btn('week', 'Week')} ${btn('month', 'Month')}
      <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
        <input type="date" id="gy-ana-from" value="${esc(_gyAna.from)}" onchange="gyAnaSetRange()" style="font-size:12px;padding:2px 4px">
        <span class="muted">→</span>
        <input type="date" id="gy-ana-to" value="${esc(_gyAna.to)}" onchange="gyAnaSetRange()" style="font-size:12px;padding:2px 4px">
        <button class="btn btn-sm" onclick="gyExportStatement()" ${prods.length ? '' : 'disabled'} title="Download itemized statement as CSV">⤓ Statement CSV</button>
      </span>
    </div>`;

    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${card('Units ordered', Number(s.units || 0).toLocaleString())}
      ${card('They owe you', yuan(s.owed), 'gzgrocery price')}
      ${card('Retail value', yuan(s.retail))}
      ${card('Avg discount', ((s.avgDiscount || 0) * 100).toFixed(1) + '%')}
      ${card('Products', s.products || 0)}
    </div>`;

    if (r.unpriced && r.unpriced.length) {
      html += `<div style="font-size:12px;color:var(--warn);background:color-mix(in srgb, var(--warn) 12%, transparent);border:1px solid var(--warn);border-radius:6px;padding:6px 10px;margin-bottom:10px">
        ⚠ ${r.unpriced.length} ordered product(s) have no gzgrocery price yet — counted in units but billed at full retail: ${r.unpriced.slice(0, 6).map(u => esc(u.name || ('#' + u.product_id))).join(', ')}${r.unpriced.length > 6 ? '…' : ''}</div>`;
    }

    if (!prods.length) {
      html += `<div class="muted" style="padding:18px;text-align:center">No gzgrocery orders in this range yet · 暂无订货<br><span style="font-size:11px">Pickups appear here automatically as gzgrocery sells.</span></div>`;
      wrap.innerHTML = html; return;
    }

    // simple per-bucket bar list
    if (ts.length) {
      const max = Math.max(...ts.map(t => t.owed)) || 1;
      html += `<details style="margin-bottom:10px"><summary style="cursor:pointer;font-size:12px;color:var(--text-3)">By ${per} (${ts.length})</summary>
        <div style="margin-top:6px">` + ts.map(t => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:1px 0">
          <span style="width:90px" class="muted">${esc(t.bucket)}</span>
          <span style="height:10px;background:var(--accent);border-radius:2px;width:${Math.max(2, (t.owed / max) * 200)}px"></span>
          <span>${yuan(t.owed)}</span><span class="muted">· ${t.units}u</span>
        </div>`).join('') + `</div></details>`;
    }

    html += `<table class="data-table" style="width:100%;font-size:12px"><thead><tr>
      <th style="text-align:left">Product</th><th style="text-align:right">Units</th>
      <th style="text-align:right">Owed</th><th style="text-align:right">Retail</th><th style="text-align:right">Disc</th></tr></thead><tbody>`
      + prods.slice(0, 50).map(p => `<tr>
        <td>${esc(p.name || ('#' + p.product_id))} <span class="muted">${esc(p.sku || '')}</span></td>
        <td style="text-align:right;font-weight:600">${p.units}</td>
        <td style="text-align:right">${yuan(p.owed)}</td>
        <td style="text-align:right" class="muted">${yuan(p.retail)}</td>
        <td style="text-align:right">${p.discount == null ? '<span style="color:var(--text-3)">—</span>' : (p.discount * 100).toFixed(0) + '%'}</td>
      </tr>`).join('') + `</tbody></table>`;
    if (prods.length > 50) html += `<div class="muted" style="font-size:11px;margin-top:4px">Showing top 50 of ${prods.length} — full list in the CSV.</div>`;

    wrap.innerHTML = html;
  }

  window.gyExportStatement = function () {
    const r = _gyAna.data; if (!r || !r.products) return;
    const rangeLabel = `${r.range && r.range.from || 'start'}_to_${r.range && r.range.to || 'now'}`;
    const head = ['SKU', 'Product', 'Units', 'Unit gz price', 'Owed', 'Retail value', 'Discount %'];
    const lines = [head.join(',')];
    for (const p of r.products) {
      const unit = p.units ? (p.owed / p.units) : 0;
      const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      lines.push([cell(p.sku), cell(p.name), p.units, unit.toFixed(2), p.owed.toFixed(2), p.retail.toFixed(2), p.discount == null ? '' : (p.discount * 100).toFixed(0)].join(','));
    }
    const s = r.summary || {};
    lines.push(['', 'TOTAL', s.units || 0, '', (s.owed || 0).toFixed(2), (s.retail || 0).toFixed(2), ((s.avgDiscount || 0) * 100).toFixed(1)].join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gzgrocery-statement_${rangeLabel}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // (Billing is now a sub-nav panel; gySubTab lazy-loads analytics on first open.)

  // ── tiny helpers ──────────────────────────────────────────────────────────────
  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : v); }
})();
