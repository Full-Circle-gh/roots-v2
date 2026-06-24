/* Meituan Sync admin tab — product mapping + status dashboard */
/* namespace: mt* */

(function () {
  'use strict';

  let _products  = [];  // full product list with store mappings
  let _stores    = [];  // [{id, name, code}]
  let _storeA    = null; // 天河
  let _storeB    = null; // 越秀
  let _listings  = {};   // { store_code: [real Meituan listing names] }
  let _review    = { ambiguous: [], unmatched: [] };  // post-fetch manual-review queue
  let _bundles   = [];   // meituan-only bundles with components + computed stock
  let _bundleDraft = null; // working copy while the bundle editor modal is open
  let _bundleSuggest = []; // combo candidates surfaced from pasted/fetched titles
  let _initiated = false;

  // ── Entry point ────────────────────────────────────────────────────────────
  window.mtAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await Promise.all([mtLoadStores(), mtLoadStatus()]);
    await mtLoadProducts();
    mtLoadBundles();
    mtLoadOrders();
    mtStartPolling();
  };

  // ── Live refresh ─────────────────────────────────────────────────────────────
  // The daemon pushes stock every 10s and pulls orders every 60s, but the admin
  // view used to be a one-shot snapshot — the sync log looked frozen ("dead").
  // Poll status + incoming orders on an interval while the Meituan tab is the
  // active, visible tab; pause when it's backgrounded or another tab is showing
  // so we don't hammer the API in the background.
  let _pollTimer = null;
  let _pollBusy  = false;
  function mtTabVisible() {
    return !document.hidden
      && !!document.getElementById('tab-meituan')?.classList.contains('active');
  }
  function mtStartPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (_pollBusy || !mtTabVisible()) return;
      _pollBusy = true;
      try { await Promise.all([mtLoadStatus(), mtLoadOrders(true)]); }
      catch (_) { /* transient — next tick retries */ }
      finally { _pollBusy = false; }
    }, 12000);
  }

  // ── Incoming orders (read-only) ──────────────────────────────────────────────
  // A plain ledger of orders mirrored in from Meituan: when, amount, products,
  // and (when Meituan exposes it) recipient. No status, no actions — the store
  // doesn't manage or print these; it just shows that they came in.
  window.mtLoadOrders = async function (silent) {
    const list = document.getElementById('mt-orders-list');
    const cnt  = document.getElementById('mt-orders-count');
    if (!list) return;
    // Background polls pass silent=true so the list doesn't flash "Loading…"
    // on every tick; only show the placeholder on the first/manual load.
    if (!silent || !list.children.length) {
      list.innerHTML = '<div class="muted" style="font-size:13px;padding:10px 0">Loading…</div>';
    }
    try {
      const res = await api('/api/retail-admin/meituan/orders');
      const orders = res.data || [];
      if (cnt) cnt.textContent = orders.length ? `(${orders.length})` : '';
      if (!orders.length) {
        list.innerHTML = '<div class="muted" style="font-size:13px;padding:10px 0">No Meituan orders yet · 暂无美团订单</div>';
        return;
      }
      list.innerHTML = orders.map(mtOrderRow).join('');
    } catch (e) {
      list.innerHTML = `<div class="muted" style="font-size:13px;padding:10px 0">Error: ${esc(e.message)}</div>`;
    }
  };

  function mtOrderRow(o) {
    const store = (_stores.find(s => s.code === o.store_code) || {}).name
      || o.store_name_cn || o.store_name_en || o.store_code || '';
    const items = (o.items || []).map(it =>
      `${esc([it.name_cn, it.name_en].filter(Boolean).join(' '))}${it.qty > 1 ? ` ×${it.qty}` : ''}`
    ).join(', ') || '<span class="muted">—</span>';
    // Name/address are only shown when Meituan exposed them (often masked).
    const who = [o.recipient_name, o.recipient_phone].filter(Boolean).map(esc).join(' · ');
    const addr = o.address_full ? esc(o.address_full) : '';
    const meta = [who, addr].filter(Boolean).join(' — ');
    const amount = o.total != null ? '¥' + Number(o.total).toFixed(2) : '—';

    return `<div style="border-top:1px solid var(--line);padding:10px 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:240px;flex:1">
        <div style="font-weight:600;font-size:13px">${esc(o.order_no || '')}
          <span class="muted" style="font-weight:400;font-size:11px">· ${esc(store)} · ${fmtAgo(o.placed_at) || ''}</span></div>
        <div style="font-size:12px;margin-top:3px">${items}</div>
        ${meta ? `<div class="muted" style="font-size:11px;margin-top:3px">${meta}</div>` : ''}
      </div>
      <div style="font-weight:700;font-size:14px;white-space:nowrap">${amount}</div>
    </div>`;
  }

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
  // Populates the fc-kpis strip (matches the Products catalogue's KPI tiles).
  function mtSetKpi(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  function mtAlertTile(id, on) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('alert', !!on);
  }

  window.mtLoadStatus = async function () {
    const log = document.getElementById('mt-log');
    try {
      const s = await api('/api/retail-admin/meituan/status');

      // Daemon tile (accent) — active/offline
      mtSetKpi('mt-kpi-daemon-val', '● Active');
      mtSetKpi('mt-kpi-daemon-sub', 'auto every 10s · 每 10 秒');
      mtAlertTile('mt-kpi-daemon-tile', false);
      document.getElementById('mt-kpi-daemon-tile')?.classList.add('accent');

      // Mapped
      mtSetKpi('mt-kpi-mapped', s.mappedCount != null ? s.mappedCount : '—');

      // Queue — alert when anything pending or failed
      mtSetKpi('mt-kpi-queue', s.queuePending != null ? s.queuePending : '—');
      mtSetKpi('mt-kpi-queue-sub', s.queueFailed
        ? `${s.queueFailed} failed · ${s.queueFailed} 失败`
        : 'pending push · 待推送');
      mtAlertTile('mt-kpi-queue-tile', s.queuePending > 0 || s.queueFailed > 0);

      // Last order
      const lo = (s.lastOrder && s.lastOrder[0]) || null;
      if (lo) {
        mtSetKpi('mt-kpi-order', fmtAgo(lo.imported_at) || '—');
        mtSetKpi('mt-kpi-order-sub', `${lo.meituan_order_no} · ${lo.store_code}`);
      } else {
        mtSetKpi('mt-kpi-order', '—');
        mtSetKpi('mt-kpi-order-sub', 'no orders yet · 暂无订单');
      }

      if (log) {
        log.textContent = s.recentLogs.length
          ? s.recentLogs.map(l => `[${l.created_at?.slice(11,19)}] ${l.store_code} ${l.event_type} ${l.status}${l.detail ? ' ' + l.detail : ''}${l.error_msg ? ' ERR:' + l.error_msg : ''}`).join('\n')
          : 'No sync events yet.';
      }
    } catch (e) {
      // Daemon unreachable — show on the accent tile, flip it to alert.
      document.getElementById('mt-kpi-daemon-tile')?.classList.remove('accent');
      mtAlertTile('mt-kpi-daemon-tile', true);
      mtSetKpi('mt-kpi-daemon-val', '● Offline');
      mtSetKpi('mt-kpi-daemon-sub', "can't reach status API · 无法连接");
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
      // includeInactive so the bundle-component picker can attach paused
      // variants; the mapping list filters back to active in mtRenderProducts.
      const res = await api('/api/retail-admin/meituan/products?includeInactive=1');
      _products = res.data || [];
      mtRenderProducts();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:24px;text-align:center">Error: ${escape(e.message)}</td></tr>`;
    }
  }

  function mtRenderProducts(filtered) {
    // Mapping list stays active-only (picker loads inactive variants too).
    const list   = (filtered || _products).filter(p => p.is_active);
    const tbody  = document.getElementById('mt-products-body');
    const storeA = _storeA;
    const storeB = _storeB;

    // Toolbar count — N shown, plus how many of the total are mapped.
    const cnt = document.getElementById('mt-count');
    if (cnt) {
      const total  = _products.filter(p => p.is_active).length;
      const mapped = _products.filter(p => p.is_active && Object.values(p.stores || {}).some(m => m.meituan_name)).length;
      cnt.textContent = `${list.length} of ${total} · ${mapped} mapped`;
    }

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:24px;text-align:center">No products found.</td></tr>';
      return;
    }

    // Rows sharing the exact same name look like duplicates. Tag them so they're
    // tellable apart: prefer the variant label, else fall back to the product id.
    const dupNames = {};
    for (const p of list) {
      const k = (p.name_cn || '') + '|' + (p.name_en || '');
      dupNames[k] = (dupNames[k] || 0) + 1;
    }

    tbody.innerHTML = list.map(p => {
      const mapA = storeA ? (p.stores[storeA.code] || {}) : {};
      const mapB = storeB ? (p.stores[storeB.code] || {}) : {};
      const anyMapped = mapA.meituan_name || mapB.meituan_name;
      const syncA = mapA.sync_enabled !== 0;
      const syncB = mapB.sync_enabled !== 0;

      return `<tr data-pid="${p.id}" class="mt-product-row${anyMapped ? '' : ' mt-unmapped'}">
        <td>
          <div style="font-weight:600;line-height:1.3">${esc([p.name_cn, p.name_en].filter(Boolean).join('  '))}${p.variant_label ? ` <span class="muted" style="font-weight:400;font-size:11px">· ${esc(p.variant_label)}</span>` : (dupNames[(p.name_cn || '') + '|' + (p.name_en || '')] > 1 ? ` <span class="muted" style="font-weight:400;font-size:11px">· #${p.id}</span>` : '')}</div>
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

  // ── Auto-fill names ──────────────────────────────────────────────────────────
  // Suggest a Meituan listing name for a product. On a Chinese marketplace the
  // listing is the Chinese name; the variant label is appended (full-width parens)
  // so products that share a name_cn — the size variants — stay distinguishable.
  // The push daemon matches by name_cn substring (lib/meituan-browser.js), so a
  // name_cn-prefixed value still matches.
  function mtSuggestName(p) {
    const base = (p.name_cn || p.name_en || '').trim();
    if (!base) return '';
    const v = (p.variant_label || '').trim();
    return v ? `${base}（${v}）` : base;
  }

  // Fill every EMPTY Meituan-name field (both districts) with the suggested name.
  // Never clobbers a value the operator already entered. Saves straight through
  // the map API, then re-renders.
  window.mtAutofill = async function () {
    const stores = [_storeA, _storeB]
      .filter((s, i, arr) => s && arr.findIndex(x => x && x.id === s.id) === i);
    if (!stores.length) { toast('No stores detected to map.', 'error'); return; }

    const targets = [];
    for (const p of _products) {
      const name = mtSuggestName(p);
      if (!name) continue;
      for (const store of stores) {
        const existing = (p.stores?.[store.code]?.meituan_name || '').trim();
        if (existing) continue;               // keep what the operator typed
        targets.push({ p, store, name });
      }
    }

    if (!targets.length) {
      toast('Nothing to fill — every product already has a Meituan name.');
      return;
    }
    if (!confirm(
      `Auto-fill ${targets.length} empty Meituan name field(s) using each product's Chinese name `
      + `(variant size appended where needed), for both districts?\n\n`
      + `Existing entries are left untouched, and you can edit any field afterwards.`
    )) return;

    const btn = document.getElementById('mt-autofill-btn');
    if (btn) { btn.disabled = true; }
    let done = 0, failed = 0;
    for (const t of targets) {
      try {
        await api(`/api/retail-admin/meituan/products/${t.p.id}/map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: t.store.id, storeCode: t.store.code, meituanName: t.name, syncEnabled: 1 }),
        });
        if (!t.p.stores) t.p.stores = {};
        t.p.stores[t.store.code] = { ...(t.p.stores[t.store.code] || {}), meituan_name: t.name, sync_enabled: 1 };
        done++;
      } catch (e) {
        failed++;
      }
      if (btn) btn.textContent = `Filling… ${done + failed}/${targets.length}`;
    }
    mtRenderProducts();
    mtLoadStatus();
    if (btn) { btn.disabled = false; btn.textContent = '✨ Auto-fill names'; }
    toast(`Filled ${done} field(s)${failed ? `, ${failed} failed` : ''}. Review and tweak as needed.`);
  };

  // ── Fetch real listing names from Meituan ────────────────────────────────────
  // Enqueue a daemon scrape job per store, poll until done, then fill empty
  // fields with the matched real Meituan titles. Unlike Auto-fill (which copies
  // name_cn), this uses the actual listing names read from the Meituan backend.
  function mtUniqueStores() {
    return [_storeA, _storeB].filter((s, i, arr) => s && arr.findIndex(x => x && x.id === s.id) === i);
  }

  window.mtFetchListings = async function () {
    const stores = mtUniqueStores();
    if (!stores.length) { toast('No stores detected.', 'error'); return; }
    if (!confirm(
      `Ask the sync daemon to read the live product names from your Meituan backend(s)?\n\n`
      + `This drives the logged-in browser session and can take ~30–60s per store. `
      + `Then I'll fill empty fields with the matched real names.`
    )) return;

    const btn = document.getElementById('mt-fetch-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
    try {
      const r = await api('/api/retail-admin/meituan/listings/refresh', { method: 'POST' });
      if (!(r.queued || []).length && !(r.alreadyRunning || []).length) {
        toast('No active stores to fetch.');
        return mtResetFetchBtn(btn);
      }

      // Poll until no jobs are running (cap ~3 min).
      const t0 = Date.now();
      let data = null;
      while (Date.now() - t0 < 180000) {
        await new Promise(res => setTimeout(res, 3000));
        data = await api('/api/retail-admin/meituan/listings');
        const total = Object.values(data.listings || {}).reduce((a, b) => a + b.length, 0);
        if (btn) btn.textContent = `Fetching… (${total})`;
        if (!data.running) break;
      }
      _listings = (data && data.listings) || {};

      const errs = ((data && data.jobs) || []).filter(j => j.status === 'error');
      if (errs.length) {
        toast(`Fetch error on ${errs.map(e => e.store_code).join(', ')}: ${errs[0].error || 'unknown'}. Is the daemon logged in?`, 'error');
      }
      const counts = stores.map(s => `${s.name || s.code}: ${(_listings[s.code] || []).length}`).join(' · ');
      toast(`Fetched — ${counts}`);

      await mtFillFromListings(stores);
    } catch (e) {
      toast('Fetch failed: ' + e.message, 'error');
    }
    mtResetFetchBtn(btn);
  };

  function mtResetFetchBtn(btn) {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Fetch from Meituan'; }
  }

  // Match one product to a store's scraped listing names. Confident match → the
  // exact Meituan title; otherwise classified so it can be left for manual review.
  function mtMatchListing(p, storeCode) {
    const list = _listings[storeCode] || [];
    if (!list.length) return { name: '', reason: 'no-listings' };
    const cn = (p.name_cn || '').trim();
    const en = (p.name_en || '').trim().toLowerCase();

    if (cn) {
      const exact = list.find(n => n === cn);
      if (exact) return { name: exact, reason: 'exact' };
      const subs = list.filter(n => n.includes(cn));
      if (subs.length === 1) return { name: subs[0], reason: 'substring' };
      if (subs.length > 1) {
        // Multiple Meituan titles contain this Chinese name — size variants.
        // Only auto-pick if the variant label uniquely disambiguates.
        const v = (p.variant_label || '').trim().toLowerCase();
        if (v) {
          const vm = subs.filter(n => n.toLowerCase().includes(v));
          if (vm.length === 1) return { name: vm[0], reason: 'variant' };
        }
        return { name: '', reason: 'ambiguous', candidates: subs };
      }
    }
    if (en) {
      const subs = list.filter(n => n.toLowerCase().includes(en));
      if (subs.length === 1) return { name: subs[0], reason: 'substring-en' };
    }
    return { name: '', reason: 'unmatched' };
  }

  async function mtFillFromListings(stores) {
    const targets = [];
    _review = { ambiguous: [], unmatched: [] };       // reset for this run

    for (const p of _products) {
      for (const store of stores) {
        const existing = (p.stores?.[store.code]?.meituan_name || '').trim();
        if (existing) continue;                       // keep operator entries
        const m = mtMatchListing(p, store.code);
        const base = { pid: p.id, storeId: store.id, storeCode: store.code,
                       storeName: store.name || store.code, label: mtProductLabel(p),
                       suggestion: mtSuggestName(p) };
        if (m.name) targets.push({ p, store, name: m.name });
        else if (m.reason === 'ambiguous') _review.ambiguous.push({ ...base, candidates: m.candidates });
        else if (m.reason !== 'no-listings') _review.unmatched.push({ ...base });
        // reason 'no-listings' = store wasn't fetched; don't flag those
      }
    }

    const a = _review.ambiguous.length, u = _review.unmatched.length;

    if (!targets.length) {
      mtRenderReview();
      toast(a + u
        ? `No confident matches. ${a} ambiguous, ${u} unmatched — see the review panel below.`
        : 'No empty fields to fill (everything already mapped).');
      return;
    }
    if (!confirm(
      `Fill ${targets.length} field(s) with matched Meituan names?\n\n`
      + `${a} ambiguous (multiple Meituan titles match) and ${u} unmatched `
      + `will be listed in the review panel below for you to resolve.`
    )) { mtRenderReview(); return; }

    let done = 0, failed = 0;
    for (const t of targets) {
      try {
        await api(`/api/retail-admin/meituan/products/${t.p.id}/map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: t.store.id, storeCode: t.store.code, meituanName: t.name, syncEnabled: 1 }),
        });
        if (!t.p.stores) t.p.stores = {};
        t.p.stores[t.store.code] = { ...(t.p.stores[t.store.code] || {}), meituan_name: t.name, sync_enabled: 1 };
        done++;
      } catch (e) {
        failed++;
      }
    }
    mtRenderProducts();
    mtLoadStatus();
    mtRenderReview();
    toast(`Filled ${done} matched name(s)${failed ? `, ${failed} failed` : ''}. `
      + (a + u ? `${a} ambiguous, ${u} unmatched — resolve below.` : 'All matched!'));
  }

  function mtProductLabel(p) {
    const main = [p.name_cn, p.name_en].filter(Boolean).join('  ');
    return p.variant_label ? `${main} · ${p.variant_label}` : main;
  }

  // ── Review panel ─────────────────────────────────────────────────────────────
  // On-screen list of products the Meituan fetch couldn't confidently map.
  // Ambiguous → pick one of the matching Meituan titles. Unmatched → no Meituan
  // listing contained the name (won't sync) — offer the Chinese-name fallback.
  function mtRenderReview() {
    const panel = document.getElementById('mt-review-panel');
    if (!panel) return;
    const { ambiguous, unmatched } = _review;

    if (!ambiguous.length && !unmatched.length) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    const ambHtml = ambiguous.map((it, i) => `
      <div class="mt-rev-item" style="padding:10px 14px;border-top:1px solid var(--line)">
        <div style="font-weight:600;margin-bottom:6px">${esc(it.label)}
          <span class="muted" style="font-weight:400;font-size:11px">· ${esc(it.storeName)}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="muted" style="font-size:12px">Pick the Meituan title:</span>
          ${it.candidates.map((c, j) =>
            `<button class="btn btn-sm" style="font-size:12px" onclick="mtPickListing(${i},${j})">${esc(c)}</button>`
          ).join('')}
        </div>
      </div>`).join('');

    const unmHtml = unmatched.map((it, i) => `
      <div class="mt-rev-item" style="padding:10px 14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div>
          <div style="font-weight:600">${esc(it.label)}
            <span class="muted" style="font-weight:400;font-size:11px">· ${esc(it.storeName)}</span></div>
          <div class="muted" style="font-size:11px">No Meituan listing contains this name — it won't sync until mapped.</div>
        </div>
        ${it.suggestion ? `<button class="btn btn-sm" style="font-size:12px" onclick="mtUseFallback(${i})" title="Fill with the product's Chinese name">Use “${esc(it.suggestion)}”</button>` : ''}
      </div>`).join('');

    panel.style.display = 'block';
    panel.style.maxHeight = '60vh';
    panel.style.overflow = 'auto';
    panel.innerHTML = `
      <div style="position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-elev-1);border-bottom:1px solid var(--line)">
        <b style="font-size:13px">Needs your attention · 需手动确认
          <span class="muted" style="font-weight:400">(${ambiguous.length} ambiguous · ${unmatched.length} unmatched)</span></b>
        <button class="btn btn-sm" onclick="mtDismissReview()" title="Clear this whole list">Dismiss all ✕</button>
      </div>
      ${ambiguous.length ? `<div style="padding:8px 14px 0;font-size:12px;color:var(--text-2)">Multiple Meituan titles matched — choose the right one:</div>${ambHtml}` : ''}
      ${unmatched.length ? `<div style="padding:10px 14px 0;font-size:12px;color:var(--text-2)">Not found on Meituan:</div>${unmHtml}` : ''}
      <div style="position:sticky;bottom:0;display:flex;justify-content:flex-end;padding:10px 14px;background:var(--bg-elev-1);border-top:1px solid var(--line)">
        <button class="btn btn-sm" onclick="mtDismissReview()" title="Clear this whole list">Dismiss all ✕</button>
      </div>
    `;
  }

  async function mtApplyReviewName(pid, storeId, storeCode, name) {
    const product = _products.find(p => p.id == pid);
    try {
      await api(`/api/retail-admin/meituan/products/${pid}/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, storeCode, meituanName: name, syncEnabled: 1 }),
      });
      if (product) {
        if (!product.stores) product.stores = {};
        product.stores[storeCode] = { ...(product.stores[storeCode] || {}), meituan_name: name, sync_enabled: 1 };
      }
      return true;
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
      return false;
    }
  }

  window.mtPickListing = async function (i, j) {
    const it = _review.ambiguous[i];
    if (!it) return;
    const name = it.candidates[j];
    if (await mtApplyReviewName(it.pid, it.storeId, it.storeCode, name)) {
      _review.ambiguous.splice(i, 1);
      mtRenderProducts();
      mtRenderReview();
    }
  };

  window.mtUseFallback = async function (i) {
    const it = _review.unmatched[i];
    if (!it || !it.suggestion) return;
    if (await mtApplyReviewName(it.pid, it.storeId, it.storeCode, it.suggestion)) {
      _review.unmatched.splice(i, 1);
      mtRenderProducts();
      mtRenderReview();
    }
  };

  window.mtDismissReview = function () {
    _review = { ambiguous: [], unmatched: [] };
    mtRenderReview();
  };

  // ── Clear all mappings ───────────────────────────────────────────────────────
  // Wipe every saved Meituan name across all stores (empty name → the map API
  // deletes the row). Use before re-filling from scratch.
  window.mtClearAll = async function () {
    const targets = [];
    for (const p of _products) {
      for (const [code, m] of Object.entries(p.stores || {})) {
        if (!m || !m.meituan_name) continue;
        const store = _stores.find(s => s.code === code);
        if (!store) continue;
        targets.push({ p, store, code });
      }
    }
    if (!targets.length) { toast('Nothing to clear — no names are set.'); return; }
    if (!confirm(
      `Clear ALL ${targets.length} Meituan name mapping(s) across every store?\n\n`
      + `This deletes the mappings (you can re-fill afterwards). Continue?`
    )) return;

    const btn = document.getElementById('mt-clear-btn');
    if (btn) btn.disabled = true;
    let done = 0, failed = 0;
    for (const t of targets) {
      try {
        await api(`/api/retail-admin/meituan/products/${t.p.id}/map`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: t.store.id, storeCode: t.code, meituanName: '', syncEnabled: 0 }),
        });
        if (t.p.stores) delete t.p.stores[t.code];
        done++;
      } catch (e) {
        failed++;
      }
      if (btn) btn.textContent = `Clearing… ${done + failed}/${targets.length}`;
    }
    _review = { ambiguous: [], unmatched: [] };
    mtRenderProducts();
    mtRenderReview();
    mtLoadStatus();
    if (btn) { btn.disabled = false; btn.textContent = '🧹 Clear all names'; }
    toast(`Cleared ${done} mapping(s)${failed ? `, ${failed} failed` : ''}.`);
  };

  // ── Paste listing names (manual, no scrape) ──────────────────────────────────
  // Operator pastes the exact Meituan titles (one per line, copied straight off
  // the Meituan product list), picks a store, and the same matcher fills the
  // empty fields. This is the reliable path when the auto-scrape can't reach the
  // Meituan content iframe.
  window.mtOpenPaste = function () {
    if (document.getElementById('mt-paste-overlay')) return;
    const opts = _stores.map(s =>
      `<option value="${esc(s.code)}" data-id="${s.id}">${esc(s.name || s.code)}</option>`
    ).join('');
    const ov = document.createElement('div');
    ov.id = 'mt-paste-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:var(--bg-pane);color:var(--text-1);width:min(560px,100%);max-height:88vh;overflow:auto;border-radius:10px;border:1px solid var(--line);box-shadow:0 18px 50px rgba(0,0,0,.4)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line)">
          <b style="font-size:15px">Paste Meituan names · 粘贴美团商品名</b>
          <button class="btn btn-sm" onclick="mtClosePaste()">✕</button>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">
            Store · 门店
            <select id="mt-paste-store" class="form-control" style="font-size:13px">${opts}</select>
          </label>
          <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">
            Meituan titles — one per line (copy exactly as shown on Meituan)
            <textarea id="mt-paste-text" class="form-control" rows="12" placeholder="超级莓 SuperBerries Blend
羽衣甘蓝粉 Kale Powder
姜黄粉 Turmeric Powder
…" style="font-size:13px;font-family:inherit;line-height:1.5"></textarea>
          </label>
          <div class="muted" style="font-size:12px">I'll match each title to a product by its Chinese name and fill only empty fields. Anything unsure goes to the review panel.</div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" onclick="mtClosePaste()">Cancel</button>
            <button class="btn btn-sm btn-primary" onclick="mtPasteApply()">Match &amp; fill</button>
          </div>
        </div>
      </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) mtClosePaste(); });
    document.body.appendChild(ov);
  };

  window.mtClosePaste = function () {
    const ov = document.getElementById('mt-paste-overlay');
    if (ov) ov.remove();
  };

  window.mtPasteApply = async function () {
    const sel  = document.getElementById('mt-paste-store');
    const text = document.getElementById('mt-paste-text');
    if (!sel || !text) return;
    const code  = sel.value;
    const store = _stores.find(s => s.code === code);
    if (!store) { toast('Pick a store first.', 'error'); return; }

    const names = text.value.split('\n')
      .map(s => s.replace(/^[\s•\-–·]+/, '').trim())   // strip bullets/leading punctuation
      .filter(Boolean);
    // de-dupe while preserving order
    _listings[code] = Array.from(new Set(names));

    if (!_listings[code].length) { toast('Paste at least one title.', 'error'); return; }
    mtClosePaste();
    toast(`Loaded ${_listings[code].length} title(s) for ${store.name || code}. Matching…`);
    await mtFillFromListings([store]);
  };

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

  // ── Bundles (Meituan-only combos) ────────────────────────────────────────────
  window.mtLoadBundles = async function () {
    try {
      const res = await api('/api/retail-admin/meituan/bundles');
      _bundles = res.data || [];
    } catch (e) { _bundles = []; }
    mtRenderBundles();
  };

  function mtRenderBundles() {
    const wrap = document.getElementById('mt-bundles-list');
    const cnt  = document.getElementById('mt-bundles-count');
    if (cnt) cnt.textContent = _bundles.length ? `(${_bundles.length})` : '';
    if (!wrap) return;
    if (!_bundles.length) {
      wrap.innerHTML = '<div class="muted" style="font-size:13px;padding:6px 0">No bundles yet.</div>';
      return;
    }
    wrap.innerHTML = _bundles.map(b => {
      const comps = (b.components || []).map(c =>
        `${esc([c.name_cn, c.name_en].filter(Boolean).join(' '))}${c.variant_label ? ` (${esc(c.variant_label)})` : ''}${c.qty > 1 ? ` ×${c.qty}` : ''}`
      ).join(', ');
      const storeName = (_stores.find(s => s.code === b.store_code) || {}).name || b.store_code;
      return `<div style="border-top:1px solid var(--line);padding:10px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
        <div style="min-width:240px;flex:1">
          <div style="font-weight:600">${esc(b.meituan_name)} <span class="muted" style="font-weight:400;font-size:11px">· ${esc(storeName)}</span></div>
          <div class="muted" style="font-size:12px;margin-top:2px">${comps || '<span style="color:var(--warn)">no components — add some</span>'}</div>
          <div style="font-size:12px;margin-top:3px">Available now: <b>${b.available}</b>${b.max_qty != null ? ` (cap ${b.max_qty})` : ''}${b.sync_enabled ? '' : ' · <span class="muted">sync off</span>'}${b.last_pushed_at ? ` · last pushed ${b.last_pushed_qty} ${fmtAgo(b.last_pushed_at)}` : ''}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="mtEditBundle(${b.id})">Edit</button>
          <button class="btn btn-sm" onclick="mtDeleteBundle(${b.id})">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  window.mtEditBundle = function (id, prefill) {
    if (document.getElementById('mt-bundle-overlay')) return;
    const existing = id ? _bundles.find(b => b.id == id) : null;
    const stores = mtUniqueStores();
    _bundleDraft = existing
      ? { id: existing.id, storeCode: existing.store_code, meituanName: existing.meituan_name, maxQty: existing.max_qty, components: (existing.components || []).map(c => ({ productId: c.product_id, qty: c.qty })) }
      : { id: null,
          storeCode: (prefill && prefill.storeCode) || (stores[0] || {}).code || '',
          meituanName: (prefill && prefill.meituanName) || '',
          maxQty: '', components: [] };

    const ov = document.createElement('div');
    ov.id = 'mt-bundle-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:var(--bg-pane);color:var(--text-1);width:min(620px,100%);max-height:90vh;overflow:auto;border-radius:10px;border:1px solid var(--line-strong);box-shadow:0 18px 50px rgba(0,0,0,.4)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line)">
          <b style="font-size:15px">${existing ? 'Edit' : 'Add'} bundle</b>
          <button class="btn btn-sm" onclick="mtCloseBundle()">✕</button>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">Store · 门店
            <select id="mt-b-store" class="form-control" style="font-size:13px">${_stores.map(s => `<option value="${esc(s.code)}" ${s.code === _bundleDraft.storeCode ? 'selected' : ''}>${esc(s.name || s.code)}</option>`).join('')}</select>
          </label>
          <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">Meituan bundle title (exact, as on Meituan)
            <input id="mt-b-name" class="form-control" style="font-size:13px" value="${esc(_bundleDraft.meituanName)}" placeholder="e.g. 藜麦沙拉套餐 Quinoa Salad Combo">
          </label>
          <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">Max stock cap (optional)
            <input id="mt-b-cap" type="number" min="0" class="form-control" style="font-size:13px;max-width:140px" value="${_bundleDraft.maxQty == null ? '' : _bundleDraft.maxQty}" placeholder="none">
          </label>
          <div style="font-size:13px;font-weight:600">Components (the products this bundle uses up)</div>
          <div id="mt-b-comps"></div>
          <input id="mt-b-prodsearch" class="form-control" style="font-size:13px" placeholder="🔍 Search products…" oninput="mtBundleFilterProds(this.value)">
          <div style="display:flex;gap:6px;align-items:center">
            <select id="mt-b-prodpick" class="form-control" style="font-size:13px;flex:1">
              <option value="">+ add a component product…</option>
              ${_products.map(p => { const lbl = [p.name_cn, p.name_en].filter(Boolean).join(' ') + (p.variant_label ? ` (${p.variant_label})` : '') + (p.is_active ? '' : ' · 已下架/inactive'); return `<option value="${p.id}" data-label="${esc(lbl.toLowerCase())}">${esc(lbl)}</option>`; }).join('')}
            </select>
            <button class="btn btn-sm" onclick="mtBundleAddComp()">Add</button>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
            <button class="btn btn-sm" onclick="mtCloseBundle()">Cancel</button>
            <button class="btn btn-sm btn-primary" onclick="mtSaveBundle()">Save bundle</button>
          </div>
        </div>
      </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) mtCloseBundle(); });
    document.body.appendChild(ov);
    mtRenderBundleComps();
  };

  function mtRenderBundleComps() {
    const box = document.getElementById('mt-b-comps');
    if (!box) return;
    if (!_bundleDraft.components.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px">No components yet — add at least one.</div>';
      return;
    }
    box.innerHTML = _bundleDraft.components.map((c, i) => {
      const p = _products.find(pp => pp.id == c.productId) || {};
      const label = [p.name_cn, p.name_en].filter(Boolean).join(' ') + (p.variant_label ? ` (${p.variant_label})` : '');
      return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <span style="flex:1;font-size:13px">${esc(label || ('#' + c.productId))}</span>
        <span class="muted" style="font-size:12px">qty</span>
        <input type="number" min="1" value="${c.qty}" class="form-control" style="width:62px;font-size:13px" onchange="mtBundleCompQty(${i}, this.value)">
        <button class="btn btn-sm" onclick="mtBundleRemoveComp(${i})">✕</button>
      </div>`;
    }).join('');
  }

  window.mtBundleFilterProds = function (q) {
    const sel = document.getElementById('mt-b-prodpick');
    if (!sel) return;
    const term = (q || '').trim().toLowerCase();
    let firstMatch = null;
    Array.from(sel.options).forEach(opt => {
      if (!opt.value) { opt.hidden = false; return; } // keep placeholder
      const hit = !term || (opt.getAttribute('data-label') || '').includes(term);
      opt.hidden = !hit;
      if (hit && !firstMatch) firstMatch = opt;
    });
    // if current selection got hidden, jump to first match
    if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden && firstMatch) sel.value = firstMatch.value;
  };

  window.mtBundleAddComp = function () {
    const sel = document.getElementById('mt-b-prodpick');
    const pid = parseInt(sel.value, 10);
    if (!pid) return;
    if (_bundleDraft.components.some(c => c.productId == pid)) { toast('Already added.'); return; }
    _bundleDraft.components.push({ productId: pid, qty: 1 });
    sel.value = '';
    mtRenderBundleComps();
  };
  window.mtBundleCompQty = function (i, v) { if (_bundleDraft.components[i]) _bundleDraft.components[i].qty = Math.max(1, parseInt(v, 10) || 1); };
  window.mtBundleRemoveComp = function (i) { _bundleDraft.components.splice(i, 1); mtRenderBundleComps(); };
  window.mtCloseBundle = function () { const ov = document.getElementById('mt-bundle-overlay'); if (ov) ov.remove(); _bundleDraft = null; };

  window.mtSaveBundle = async function () {
    const code  = document.getElementById('mt-b-store').value;
    const store = _stores.find(s => s.code === code);
    const name  = document.getElementById('mt-b-name').value.trim();
    const cap   = document.getElementById('mt-b-cap').value;
    if (!store) { toast('Pick a store.', 'error'); return; }
    if (!name)  { toast('Enter the Meituan bundle title.', 'error'); return; }
    // Components optional: a 0-component shell can be saved now and filled later
    // (stock won't sync until it has at least one component).
    try {
      await api('/api/retail-admin/meituan/bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: _bundleDraft.id, storeId: store.id, storeCode: code, meituanName: name,
          maxQty: cap === '' ? null : cap, syncEnabled: 1, components: _bundleDraft.components,
        }),
      });
      mtCloseBundle();
      toast('Bundle saved.');
      mtLoadBundles();
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  };

  // Surface combo-looking titles from the loaded Meituan names as quick-create
  // suggestions. Looks for 套餐/Combo or a +/& joiner; skips titles already a
  // bundle. _listings is filled by Paste/Fetch in this session.
  function mtComboCandidates(storeCode) {
    const list = _listings[storeCode] || [];
    const existing = new Set(_bundles.filter(b => b.store_code === storeCode).map(b => b.meituan_name));
    return list.filter(t => !existing.has(t) && (/套餐|combo/i.test(t) || /[+＋&]/.test(t)));
  }

  window.mtSuggestBundles = function () {
    const box = document.getElementById('mt-bundle-suggest');
    if (!box) return;
    _bundleSuggest = [];
    for (const st of mtUniqueStores()) {
      for (const t of mtComboCandidates(st.code)) {
        _bundleSuggest.push({ storeCode: st.code, storeName: st.name || st.code, name: t });
      }
    }
    if (!_bundleSuggest.length) {
      box.innerHTML = `<div class="muted" style="font-size:12px;padding:6px 0">No combo-looking titles found. Use 📋 Paste Meituan names first (this session), then try again.</div>`;
      return;
    }
    box.innerHTML = `<div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:8px 0">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${_bundleSuggest.length} possible bundle(s) — click Create to set components</div>
      ${_bundleSuggest.map((s, i) => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:3px 0">
        <span style="font-size:13px">${esc(s.name)} <span class="muted" style="font-size:11px">· ${esc(s.storeName)}</span></span>
        <button class="btn btn-sm" onclick="mtCreateBundleFrom(${i})">Create</button>
      </div>`).join('')}
    </div>`;
  };

  window.mtCreateBundleFrom = function (i) {
    const s = _bundleSuggest[i];
    if (!s) return;
    mtEditBundle(null, { storeCode: s.storeCode, meituanName: s.name });
  };

  window.mtDeleteBundle = async function (id) {
    if (!confirm('Delete this bundle? This only stops auto-stock — it does not touch the Meituan listing.')) return;
    try {
      await api(`/api/retail-admin/meituan/bundles/${id}`, { method: 'DELETE' });
      toast('Deleted.');
      mtLoadBundles();
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
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
