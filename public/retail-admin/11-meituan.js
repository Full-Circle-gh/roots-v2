/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Meituan Sync admin tab — product mapping + status dashboard */
/* namespace: mt* */

(function () {
  'use strict';

  let _products  = [];  // full product list with store mappings
  let _stores    = [];  // [{id, name, code}]
  let _storeA    = null; // 天河
  let _storeB    = null; // 越秀
  let _listings  = {};   // { store_code: [real Meituan listing names] }
  let _listingSkus = {}; // { store_code: { 货号: listing_name } } — from the scrape only
  let _review    = { ambiguous: [], unmatched: [] };  // post-fetch manual-review queue
  let _bundles   = [];   // meituan-only bundles with components + computed stock
  let _bundleDraft = null; // working copy while the bundle editor modal is open
  let _bundleSuggest = []; // combo candidates surfaced from pasted/fetched titles
  let _initiated = false;
  let _mtFilter  = 'all';  // toolbar segmented filter: 'all' | 'att' (needs attention)

  // ── Entry point ────────────────────────────────────────────────────────────
  window.mtAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    // If the first load dies (flaky network, expired session), release the
    // guard so the next click on the tab retries instead of showing the static
    // "Loading…" shell until a full page reload.
    try {
      await Promise.all([mtLoadStores(), mtLoadStatus(), mtLoadBusinessStatus()]);
      await mtLoadProducts();
    } catch (e) {
      _initiated = false;
      throw e;
    }
    mtLoadBundles();
    mtStartPolling();
    // The product table and bundles list are rendered in ONE language (cuT)
    // under data-no-i18n containers, so the auto-translator never touches
    // them — repaint ourselves when the operator flips EN/CN.
    // Static chrome (headers, buttons) is handled by the "EN · CN" splitter.
    if (window.onLangChange) onLangChange(function () {
      mtFilterProducts();
      mtRenderBundles();
    });
  };

  // ── Live refresh ─────────────────────────────────────────────────────────────
  // The daemon pushes stock every 10s, but the admin view used to be a one-shot
  // snapshot — the sync log looked frozen ("dead"). Poll status on an interval
  // while the Meituan tab is the active, visible tab; pause when it's
  // backgrounded or another tab is showing so we don't hammer the API.
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
      try { await Promise.all([mtLoadStatus(), mtLoadBusinessStatus()]); }
      catch (_) { /* transient — next tick retries */ }
      finally { _pollBusy = false; }
    }, 12000);
  }

  // Store-status controls MOVED to the Sales page channel cards (channel × location
  // matrix — see csLoad/csPopup in 01-core.js). The per-store panel that used to
  // live here is retired; mtLoadBusinessStatus is kept as a no-op that clears the
  // (now unused) #mt-business-status slot, because mtAdminInit + the 12s poll still
  // call it.
  window.mtLoadBusinessStatus = function () {
    const box = document.getElementById('mt-business-status');
    if (box && box.innerHTML) box.innerHTML = '';
  };

  // Orders ledger removed — Meituan orders show on the main Orders page like
  // every other channel; keeping a second read-only copy here was duplicate
  // noise. The "Last order" KPI (from /status) stays as the health signal.

  // ── Sub-views: Products / Bundles ────────────────────────────────────────────
  window.mtView = function (v) {
    ['products', 'bundles'].forEach(k => {
      const view = document.getElementById('mt-view-' + k);
      const tab  = document.getElementById('mt-tab-' + k);
      if (view) view.hidden = k !== v;
      if (tab) tab.classList.toggle('active', k === v);
    });
  };

  // ── Stores ─────────────────────────────────────────────────────────────────
  async function mtLoadStores() {
    try {
      const res = await api('/api/retail-admin/meituan/stores');
      _stores = res.data || [];
      // Try to guess 天河 / 越秀 by code or name
      _storeA = _stores.find(s => s.code === 'tianhe' || s.name?.includes('天河')) || _stores[0] || null;
      _storeB = _stores.find(s => s.code === 'yuexiu' || s.name?.includes('越秀')) || _stores[1] || null;
      // Column headers are static bilingual markup ("Tianhe delivery · 天河外卖")
      // localized by the EN/CN splitter — no JS header-setting needed.
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

  // English store labels keyed by code — the store record only carries a Chinese
  // `name` (天河店 / 越秀店), so in the English log we derive a Latin name instead
  // of falling through to the Chinese one.
  const MT_STORE_EN = { tianhe: 'Tianhe', yuexiu: 'Yuexiu' };
  function mtStoreName(code, cn) {
    if (cn === false && MT_STORE_EN[code]) return MT_STORE_EN[code];
    return (_stores.find(s => s.code === code) || {}).name || code;
  }

  window.mtLoadStatus = async function () {
    const cn = document.documentElement.dataset.uiLang === 'cn';
    try {
      const s = await api('/api/retail-admin/meituan/status');

      // Sync cell — green dot + Active; flips to alert when unreachable
      mtSetKpi('mt-kpi-daemon-val', cuT('Active', '运行中'));
      mtSetKpi('mt-kpi-daemon-sub', cuT('· every 10 s', '· 每 10 秒'));
      mtAlertTile('mt-kpi-daemon-tile', false);
      document.getElementById('mt-dot')?.classList.remove('off');

      // "Live on Meituan" tile — the value (live count) and sub (N not matched)
      // are both owned by mtRenderProducts, which counts distinct products the
      // same way the banner does. mappedCount (sync-toggle rows, both stores
      // summed) is deliberately NOT shown as the headline — it double-counts and
      // conflates "sync on" with "actually live".

      // Stock updates — plain state words, not queue mechanics: "All sent ✓" is
      // the healthy resting state; "N sending…" is a queue mid-drain (normal,
      // clears in seconds); "N failed" is the only state that needs a human.
      const pending = Number(s.queuePending || 0), qfailed = Number(s.queueFailed || 0);
      // A queue mid-drain clears in seconds, so anything still waiting after
      // STUCK_MIN is not sending, it is stuck — and saying "sending…" for it is
      // how 107 rows sat unpushed for 19 hours with the tile looking normal.
      const STUCK_MIN = 30;
      const oldestMin = Number(s.queueOldestMin || 0);
      const stuck = pending > 0 && oldestMin >= STUCK_MIN;
      const stuckFor = oldestMin >= 120
        ? cuT(`${Math.round(oldestMin / 60)} h`, `${Math.round(oldestMin / 60)} 小时`)
        : cuT(`${oldestMin} min`, `${oldestMin} 分钟`);
      if (stuck) {
        mtSetKpi('mt-kpi-queue', pending);
        mtSetKpi('mt-kpi-queue-sub', cuT(`stuck ${stuckFor} — stock on Meituan is stale`, `卡住 ${stuckFor} — 美团库存已过期`));
      } else if (qfailed > 0) {
        mtSetKpi('mt-kpi-queue', qfailed);
        mtSetKpi('mt-kpi-queue-sub', cuT('failed', '推送失败')
          + (pending > 0 ? cuT(` · ${pending} sending…`, ` · ${pending} 发送中…`) : ''));
      } else if (pending > 0) {
        mtSetKpi('mt-kpi-queue', pending);
        mtSetKpi('mt-kpi-queue-sub', cuT('sending…', '发送中…'));
      } else {
        mtSetKpi('mt-kpi-queue', cuT('All sent', '已全部发送'));
        mtSetKpi('mt-kpi-queue-sub', '✓');
      }
      mtAlertTile('mt-kpi-queue-tile', stuck || qfailed > 0 || pending > 0);

      // Last order — short tail of the order no; the full no lives in Orders
      const lo = (s.lastOrder && s.lastOrder[0]) || null;
      if (lo) {
        mtSetKpi('mt-kpi-order', fmtAgo(lo.imported_at) || '—');
        mtSetKpi('mt-kpi-order-sub', `· ${mtStoreName(lo.store_code, cn)}`);
      } else {
        mtSetKpi('mt-kpi-order', '—');
        mtSetKpi('mt-kpi-order-sub', cuT('no orders yet', '暂无订单'));
      }

      mtSetKpi('mt-upd', cuT('Updated just now', '刚刚更新'));
    } catch (e) {
      // Daemon unreachable — red dot + brass alert on the sync cell.
      mtAlertTile('mt-kpi-daemon-tile', true);
      document.getElementById('mt-dot')?.classList.add('off');
      mtSetKpi('mt-kpi-daemon-val', cuT('Offline', '离线'));
      mtSetKpi('mt-kpi-daemon-sub', cuT("can't reach the sync service", '无法连接同步服务'));
    }
  };

  // ── Sync now (push all) ──────────────────────────────────────────────────────
  // force=true is the "push while closed" path: it forwards a force flag so a
  // daemon that gates pushes to opening hours runs them anyway. It has no UI
  // anymore (ops can run mtPushAll(true) from the console in an emergency).
  // The label is restored to the bilingual literal so the EN/CN splitter
  // re-localizes it.
  const MT_PUSH_IDLE = 'Sync now · 立即同步';
  window.mtPushAll = async function (force) {
    const btn = document.getElementById('mt-pushall-btn');
    if (btn) { btn.disabled = true; btn.textContent = cuT('Queuing…', '排队中…'); }
    try {
      const r = await api('/api/retail-admin/meituan/push-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      toast(cuT(`Queued ${r.queued} stock push(es) to Meituan`, `已排队 ${r.queued} 个库存推送`));
      await mtLoadStatus();
    } catch (e) {
      toast(cuT('Push failed: ', '推送失败:') + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = MT_PUSH_IDLE; }
    }
  };

  // ── Toolbar: segmented filter ────────────────────────────────────────────────
  window.mtSetFilter = function (f) {
    _mtFilter = f === 'att' ? 'att' : 'all';
    const all = document.getElementById('mt-seg-all');
    const att = document.getElementById('mt-seg-att');
    if (all) all.classList.toggle('active', _mtFilter === 'all');
    if (att) att.classList.toggle('active', _mtFilter === 'att');
    mtFilterProducts();
  };

  // ── Products ───────────────────────────────────────────────────────────────
  async function mtLoadProducts() {
    const tbody = document.getElementById('mt-products-body');
    tbody.innerHTML = '<tr><td colspan="3" class="muted" style="padding:24px;text-align:center">Loading…</td></tr>';
    try {
      // includeInactive so the bundle-component picker can attach paused
      // variants; the mapping list filters back to active in mtRenderProducts.
      const res = await api('/api/retail-admin/meituan/products?includeInactive=1');
      _products = res.data || [];
      mtFilterProducts();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted" style="padding:24px;text-align:center">Error: ${escape(e.message)}</td></tr>`;
    }
  }

  // One status pill (Tea = live, Brass = needs action, neutral = not on store).
  function mtPill(kind, label) {
    return `<span class="pill ${kind}"><span class="dot"></span>${esc(label)}</span>`;
  }
  // "Last 18 · 1d ago" footnote for a store mapping (safe inside data-no-i18n).
  function mtLast(map) {
    return (map && map.last_pushed_at)
      ? cuT('Last', '上次') + ' ' + map.last_pushed_qty + ' · ' + fmtAgo(map.last_pushed_at)
      : '';
  }
  // A product needs attention when it's active but live on NEITHER store.
  function mtNeedsAttention(p) {
    const a = _storeA && p.stores && p.stores[_storeA.code] && p.stores[_storeA.code].meituan_name;
    const b = _storeB && p.stores && p.stores[_storeB.code] && p.stores[_storeB.code].meituan_name;
    return !a && !b;
  }

  function mtRenderProducts(filtered) {
    // Mapping list stays active-only (picker loads inactive variants too).
    const list   = (filtered || _products).filter(p => p.is_active);
    const tbody  = document.getElementById('mt-products-body');
    const storeA = _storeA;
    const storeB = _storeB;

    // Toolbar count — N shown of the active total, plus how many are live.
    const total = _products.filter(p => p.is_active).length;
    const live  = _products.filter(p => p.is_active && Object.values(p.stores || {}).some(m => m.meituan_name)).length;
    const att   = _products.filter(p => p.is_active && mtNeedsAttention(p)).length;
    const cnt = document.getElementById('mt-count');
    if (cnt) cnt.textContent = cuT(`${list.length} of ${total} shown · ${live} live`, `显示 ${list.length} / ${total} · ${live} 已上架`);
    const tabn = document.getElementById('mt-tabn-products');
    if (tabn) tabn.textContent = total || '';
    // "Live on Meituan" KPI: headline = products actually live (matched on a
    // store), sub = how many are still stuck. Reconciles with the banner (att)
    // and with total: live + att = active products.
    mtSetKpi('mt-kpi-mapped', live);
    const msub = document.getElementById('mt-kpi-mapped-sub');
    if (msub) msub.textContent = att
      ? cuT(`${att} not matched`, `${att} 个未匹配`)
      : cuT('all matched', '全部已匹配');

    // Attention banner — the only home of the Match-names flow; hidden the
    // moment every active product is live somewhere.
    const attn  = document.getElementById('mt-attn');
    const attxt = document.getElementById('mt-attn-txt');
    if (attn) attn.hidden = !att;
    if (attxt && att) {
      attxt.innerHTML = cuT(
        `<b>${att} product${att > 1 ? "s aren't" : " isn't"} matched on Meituan yet.</b> Their stock stays frozen on Meituan until they're matched.`,
        `<b>${att} 个商品尚未匹配美团。</b>匹配前它们在美团上的库存不会更新。`);
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted" style="padding:24px;text-align:center">${cuT('No products found.', '未找到商品。')}</td></tr>`;
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

      // Product name — show the active language first, the other as a subline so
      // staff can still cross-reference the Meituan listing.
      const nm1 = cuT(p.name_en || p.name_cn || '', p.name_cn || p.name_en || '');
      const nm2 = cuT(p.name_cn || '', p.name_en || '');
      const tag = p.variant_label
        ? ` <span class="muted" style="font-weight:400;font-size:11px">· ${esc(p.variant_label)}</span>`
        : (dupNames[(p.name_cn || '') + '|' + (p.name_en || '')] > 1
            ? ` <span class="muted" style="font-weight:400;font-size:11px">· #${p.id}</span>` : '');
      // Identity cell: photo + names + SKU chip, so a product is recognisable at
      // a glance and the SKU that drives the Yuexiu auto-match is visible. The
      // image is a lazy thumbnail URL (never a blob — see the list-image footgun).
      const thumb = p.image
        ? `<img class="mt-thumb" loading="lazy" src="${esc(p.image)}" alt="">`
        : `<span class="mt-thumb mt-thumb-ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg></span>`;
      const skuChip = p.sku ? `<span class="mt-psku">${esc(p.sku)}</span>` : '';
      const nameCell = `<div class="mt-pcell">${thumb}<div class="mt-pmeta">
        <div style="font-weight:600;line-height:1.3">${esc(nm1)}${tag}</div>`
        + (nm2 && nm2 !== nm1 ? `<div class="muted" style="font-size:11px;margin-top:1px">${esc(nm2)}</div>` : '')
        + skuChip + `</div></div>`;

      // Tianhe (delivery) — matches by name, so this column stays editable.
      let colA;
      if (!storeA) {
        colA = '<span class="muted">—</span>';
      } else {
        const hasName = !!mapA.meituan_name;
        const syncOn  = hasName && mapA.sync_enabled !== 0;
        const pillA = !hasName ? mtPill('mt-warn', cuT('Add name', '待填名称'))
          : (syncOn ? mtPill('mt-ok', cuT('Synced', '已同步'))
                    : mtPill('mt-off', cuT('Sync off', '已关闭')));
        const lastA = mtLast(mapA);
        const toggleA = hasName
          ? `<label class="toggle-label" title="${cuT('Tianhe delivery sync on / off', '天河外卖同步开关')}"><input type="checkbox" ${syncOn ? 'checked' : ''} data-pid="${p.id}" onchange="mtToggleSync(this)"></label>`
          : '';
        colA = `<div>${pillA}</div>
          <input type="text" class="form-control mt-name-input" style="font-size:12px;margin-top:5px"
            placeholder="${esc(cuT('Meituan delivery name', '美团外卖商品名'))}"
            value="${esc(mapA.meituan_name || '')}"
            data-pid="${p.id}" data-store-id="${storeA.id}" data-store-code="${storeA.code}"
            onblur="mtSaveMap(this)" onkeydown="if(event.key==='Enter')this.blur()">
          ${(lastA || toggleA) ? `<div class="mt-cell-foot">${lastA ? `<span class="muted" style="font-size:11px">${esc(lastA)}</span>` : ''}${toggleA}</div>` : ''}`;
      }

      // Yuexiu (instant) — read-only. The shangou daemon maps it by 货号; we only
      // report whether it's live, the matched listing, and when it last pushed.
      let colB;
      if (!storeB) {
        colB = '<span class="muted">—</span>';
      } else if (mapB.meituan_name) {
        const on = mapB.sync_enabled !== 0;
        const pillB = on ? mtPill('mt-ok', cuT('Synced · auto', '已同步 · 自动'))
                         : mtPill('mt-off', cuT('Sync off', '已关闭'));
        const lastB = mtLast(mapB);
        colB = `<div>${pillB}</div>
          <div class="muted mt-sub">${esc(mapB.meituan_name)}</div>
          ${lastB ? `<div class="muted mt-sub">${esc(lastB)}</div>` : ''}`;
      } else {
        colB = `<div>${mtPill('mt-off', cuT('Not on Meituan', '未上架'))}</div>
          <div class="muted mt-sub">${cuT('No 货号 match — list it on Meituan with this SKU and it links up on its own', '无货号匹配 — 请在美团用此货号上架,系统会自动关联')}</div>`;
      }

      return `<tr data-pid="${p.id}" class="mt-product-row${anyMapped ? '' : ' mt-unmapped'}">
        <td>${nameCell}</td>
        <td>${colA}</td>
        <td>${colB}</td>
      </tr>`;
    }).join('');
  }

  // ── Suggested listing name ───────────────────────────────────────────────────
  // On a Chinese marketplace the listing is the Chinese name; the variant label
  // is appended (full-width parens) so products that share a name_cn — the size
  // variants — stay distinguishable. The push daemon matches by name_cn
  // substring (lib/meituan-browser.js), so a name_cn-prefixed value still
  // matches. Used as the per-product fallback chip in the Match-names dialog.
  function mtSuggestName(p) {
    const base = (p.name_cn || p.name_en || '').trim();
    if (!base) return '';
    const v = (p.variant_label || '').trim();
    return v ? `${base}（${v}）` : base;
  }

  function mtUniqueStores() {
    return [_storeA, _storeB].filter((s, i, arr) => s && arr.findIndex(x => x && x.id === s.id) === i);
  }

  // ── Match names — ONE guided flow ────────────────────────────────────────────
  // Replaces the old Fetch / Auto-fill / Paste buttons. The dialog reads the
  // live Tianhe listing titles via the sync daemon, auto-fills every confident
  // match, then shows only what needs a human: ambiguous titles as tappable
  // chips, unmatched products with a suggested-name fallback. Paste stays as
  // the escape hatch when the scrape can't reach Meituan.
  let _match = { stage: 'intro', applied: 0, failed: 0, running: false };

  window.mtOpenMatch = function () {
    if (document.getElementById('mt-match-overlay')) return;
    _match = { stage: 'intro', applied: 0, failed: 0, running: false };
    const ov = document.createElement('div');
    ov.id = 'mt-match-overlay';
    ov.className = 'mt-ovl';
    ov.innerHTML = '<div class="mt-dlg" role="dialog" data-no-i18n><div id="mt-match-body"></div></div>';
    ov.addEventListener('click', e => { if (e.target === ov && !_match.running) mtMatchClose(); });
    document.body.appendChild(ov);
    mtMatchRender();
  };

  window.mtMatchClose = function () {
    const ov = document.getElementById('mt-match-overlay');
    if (ov) ov.remove();
  };

  function mtMatchHead() {
    return `<div class="mt-dlg-hd"><b>${cuT('Match names with Meituan', '与美团匹配商品名')}</b>
      <button class="btn btn-sm" onclick="mtMatchClose()" aria-label="Close">✕</button></div>`;
  }

  function mtMatchRender() {
    const body = document.getElementById('mt-match-body');
    if (!body) return;

    if (_match.stage === 'intro') {
      body.innerHTML = mtMatchHead() + `
        <div class="mt-dlg-bd">
          <p>${cuT(
            "I'll read your product names from the Meituan Tianhe store and match them to your products here. Takes about a minute — nothing changes on Meituan.",
            '我会从美团天河店读取商品名称,并与这里的商品自动匹配。大约一分钟,不会改动美团上的任何内容。')}</p>
          <button class="btn btn-sm btn-primary" onclick="mtMatchStart()">${cuT('Start matching', '开始匹配')}</button>
        </div>
        <div class="mt-dlg-ft">
          <span style="flex:1"></span>
          <button class="mt-tinylink" onclick="mtMatchClose();mtOpenPaste()">${cuT("Can't connect? Paste the names yourself", '无法连接?自己粘贴名称')}</button>
        </div>`;
      return;
    }

    if (_match.stage === 'working') {
      body.innerHTML = mtMatchHead() + `
        <div class="mt-dlg-bd">
          <p id="mt-match-prog">${cuT('Reading your Meituan listings…', '正在读取美团商品…')}</p>
        </div>`;
      return;
    }

    // Results — matched count up top; only the leftovers ask for anything.
    const amb = _review.ambiguous, unm = _review.unmatched;
    let html = mtMatchHead() + '<div class="mt-dlg-bd">';
    html += `<div class="mt-okline">✓ ${cuT(
      `${_match.applied} matched automatically`, `已自动匹配 ${_match.applied} 个`)}</div>`;
    if (_match.failed) {
      html += `<p class="muted">${cuT(`${_match.failed} failed to save — try again in a minute.`, `${_match.failed} 个保存失败,请稍后重试。`)}</p>`;
    }
    if (amb.length) {
      html += `<div class="mt-pickhd">${cuT(
        `${amb.length} need your pick — tap the right Meituan listing:`,
        `${amb.length} 个需要你选择 —— 点正确的美团名称:`)}</div>`;
      html += amb.map((it, i) => `<div class="mt-pick">
        <div class="pn">${esc(it.label)}</div>
        <div class="chips">${it.candidates.map((c, j) =>
          `<button class="mt-chip" onclick="mtMatchPick(${i},${j})">${esc(c)}</button>`).join('')}</div>
      </div>`).join('');
    }
    if (unm.length) {
      html += `<div class="mt-pickhd">${cuT(
        `${unm.length} not found on Meituan — stock won't sync until they're listed there:`,
        `${unm.length} 个在美团上未找到 —— 上架前库存不会同步:`)}</div>`;
      html += unm.map((it, i) => `<div class="mt-pick">
        <div class="pn">${esc(it.label)}</div>
        ${it.suggestion ? `<div class="chips"><button class="mt-chip" onclick="mtMatchFallback(${i})">${cuT('Use', '使用')} “${esc(it.suggestion)}”</button></div>` : ''}
      </div>`).join('');
      if (unm.filter(u => u.suggestion).length > 1) {
        html += `<button class="btn btn-sm" style="margin-top:6px" onclick="mtMatchFallbackAll()">${cuT('Use suggested names for all', '全部使用建议名称')}</button>`;
      }
    }
    if (!amb.length && !unm.length) {
      html += `<p class="muted">${cuT('Everything is matched.', '全部匹配完成。')}</p>`;
    }
    html += `</div><div class="mt-dlg-ft">
      <button class="mt-tinylink" onclick="mtMatchStartOver()">${cuT('Start over — clear all matched names', '重新开始 —— 清除所有已匹配名称')}</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-primary" onclick="mtMatchClose()">${cuT('Done', '完成')}</button>
    </div>`;
    body.innerHTML = html;
  }

  window.mtMatchStart = async function () {
    if (_match.running) return;
    const stores = mtOutletStores();   // 天河 外卖 only; 越秀 is auto by 货号
    if (!stores.length) { toast(cuT('No stores detected.', '未检测到门店。'), 'error'); return; }
    _match.running = true; _match.stage = 'working'; mtMatchRender();
    try {
      const r = await api('/api/retail-admin/meituan/listings/refresh', { method: 'POST' });
      if ((r.queued || []).length || (r.alreadyRunning || []).length) {
        // Poll until no scrape jobs are running (cap ~3 min).
        const t0 = Date.now();
        let data = null;
        while (Date.now() - t0 < 180000) {
          await new Promise(res => setTimeout(res, 3000));
          data = await api('/api/retail-admin/meituan/listings');
          const total = Object.values(data.listings || {}).reduce((a, b) => a + b.length, 0);
          const p = document.getElementById('mt-match-prog');
          if (p) p.textContent = cuT(`Reading your Meituan listings… ${total} found`, `正在读取美团商品… 已读取 ${total} 个`);
          if (!data.running) break;
        }
        _listings = (data && data.listings) || {};
        _listingSkus = (data && data.skus) || {};
        const errs = ((data && data.jobs) || []).filter(j => j.status === 'error');
        if (errs.length && !Object.values(_listings).some(l => l.length)) {
          throw new Error(errs[0].error || cuT('could not read the listings — is the sync service logged in?', '无法读取商品 —— 同步服务是否已登录?'));
        }
      }
      await mtMatchApply(stores);
    } catch (e) {
      _match.running = false; _match.stage = 'intro'; mtMatchRender();
      toast(cuT('Match failed: ', '匹配失败:') + e.message, 'error');
    }
  };

  // Match one product to a store's scraped listing names. Confident match → the
  // exact Meituan title; otherwise classified so it can be left for manual review.
  function mtMatchListing(p, storeCode) {
    const list = _listings[storeCode] || [];
    if (!list.length) return { name: '', reason: 'no-listings' };
    // 货号 first — exact and typo-proof. When the operator filled the SKU on the
    // Meituan listing, that beats any name similarity; names are the fallback.
    const psku = (p.sku || '').trim();
    const bySku = psku && (_listingSkus[storeCode] || {})[psku];
    if (bySku) return { name: bySku, reason: 'sku' };
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

  // Match + auto-apply. Called from mtMatchStart (after the scrape) and from
  // mtPasteApply (with pasted titles already in _listings). Confident matches
  // save straight away — the dialog itself is the confirmation; the leftovers
  // render as picks in the results stage.
  async function mtMatchApply(stores) {
    _match.running = true;
    if (_match.stage !== 'working') { _match.stage = 'working'; mtMatchRender(); }

    const targets = [];
    _review = { ambiguous: [], unmatched: [] };       // reset for this run
    for (const p of _products) {
      if (!p.is_active) continue;                     // paused products don't nag
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
      const p = document.getElementById('mt-match-prog');
      if (p) p.textContent = cuT(`Matching… ${done + failed}/${targets.length}`, `匹配中… ${done + failed}/${targets.length}`);
    }

    _match.applied = done; _match.failed = failed;
    _match.running = false; _match.stage = 'done';
    mtFilterProducts();
    mtLoadStatus();
    mtMatchRender();
  }

  function mtProductLabel(p) {
    const main = [p.name_cn, p.name_en].filter(Boolean).join('  ');
    return p.variant_label ? `${main} · ${p.variant_label}` : main;
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

  window.mtMatchPick = async function (i, j) {
    const it = _review.ambiguous[i];
    if (!it) return;
    if (await mtApplyReviewName(it.pid, it.storeId, it.storeCode, it.candidates[j])) {
      _review.ambiguous.splice(i, 1);
      _match.applied++;
      mtFilterProducts();
      mtMatchRender();
    }
  };

  window.mtMatchFallback = async function (i) {
    const it = _review.unmatched[i];
    if (!it || !it.suggestion) return;
    if (await mtApplyReviewName(it.pid, it.storeId, it.storeCode, it.suggestion)) {
      _review.unmatched.splice(i, 1);
      _match.applied++;
      mtFilterProducts();
      mtMatchRender();
    }
  };

  window.mtMatchFallbackAll = async function () {
    const items = _review.unmatched.filter(it => it.suggestion);
    for (const it of items) {
      if (await mtApplyReviewName(it.pid, it.storeId, it.storeCode, it.suggestion)) {
        const idx = _review.unmatched.indexOf(it);
        if (idx >= 0) _review.unmatched.splice(idx, 1);
        _match.applied++;
      }
    }
    mtFilterProducts();
    mtMatchRender();
  };

  // "Start over" — wipe the Tianhe mappings (existing confirm inside
  // mtClearAll), then land back on the dialog's intro stage.
  window.mtMatchStartOver = async function () {
    await mtClearAll();
    _match = { stage: 'intro', applied: 0, failed: 0, running: false };
    _review = { ambiguous: [], unmatched: [] };
    mtMatchRender();
  };

  // ── Clear all mappings ───────────────────────────────────────────────────────
  // Wipe every saved Meituan name across all stores (empty name → the map API
  // deletes the row). Use before re-filling from scratch.
  window.mtClearAll = async function () {
    // 天河 外卖 mappings only. 越秀 闪购 is auto-mapped by 货号 — clearing it here
    // would silently break 闪购 stock sync, so we never touch it.
    const outletCodes = new Set(mtOutletStores().map(s => s.code));
    const targets = [];
    for (const p of _products) {
      for (const [code, m] of Object.entries(p.stores || {})) {
        if (!m || !m.meituan_name) continue;
        if (!outletCodes.has(code)) continue;   // skip 越秀 闪购
        const store = _stores.find(s => s.code === code);
        if (!store) continue;
        targets.push({ p, store, code });
      }
    }
    if (!targets.length) { toast('Nothing to clear — no 天河 外卖 names are set.'); return; }
    if (!(await askConfirm({
      title: `Clear ALL ${targets.length} 天河 外卖 Meituan name mapping(s)?`,
      body: '越秀 闪购 (auto by 货号) is left untouched. This deletes the 天河 mappings (you can re-fill afterwards).',
      confirmLabel: 'Clear mappings',
      danger: true,
    }))) return;

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
    }
    _review = { ambiguous: [], unmatched: [] };
    mtFilterProducts();
    mtLoadStatus();
    toast(cuT(`Cleared ${done} mapping(s)${failed ? `, ${failed} failed` : ''}.`,
              `已清除 ${done} 个映射${failed ? `,${failed} 个失败` : ''}。`));
  };

  // ── Paste listing names (manual, no scrape) ──────────────────────────────────
  // Operator pastes the exact Meituan titles (one per line, copied straight off
  // the Meituan product list), picks a store, and the same matcher fills the
  // empty fields. This is the reliable path when the auto-scrape can't reach the
  // Meituan content iframe.
  window.mtOpenPaste = function () {
    if (document.getElementById('mt-paste-overlay')) return;
    // Paste targets 天河 外卖 only — 越秀 闪购 maps itself by 货号.
    const opts = mtOutletStores().map(s =>
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

    if (!_listings[code].length) { toast(cuT('Paste at least one title.', '请至少粘贴一个名称。'), 'error'); return; }
    mtClosePaste();
    // Feed the pasted titles through the same match flow the dialog uses.
    if (!document.getElementById('mt-match-overlay')) mtOpenMatch();
    await mtMatchApply([store]);
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
      // Update local cache, then repaint so the Tianhe status pill (Synced /
      // Add name) and the sync toggle reflect the new mapping.
      if (product) {
        if (!product.stores) product.stores = {};
        if (name) {
          product.stores[storeCode] = { ...(product.stores[storeCode] || {}), meituan_name: name, sync_enabled: 1 };
        } else {
          delete product.stores[storeCode];
        }
      }
      mtFilterProducts();
    } catch (e) {
      toast(cuT('Save failed: ', '保存失败:') + e.message, 'error');
    }
    input.style.opacity = '';
  };

  // ── Toggle sync ─────────────────────────────────────────────────────────────
  window.mtToggleSync = async function (checkbox) {
    const pid     = checkbox.dataset.pid;
    const product = _products.find(p => p.id == pid);
    if (!product || !_storeA) return;
    // This toggle governs only 天河 外卖. 越秀 闪购 is auto-managed by 货号 and
    // never touched from here.
    const map = product.stores?.[_storeA.code];
    if (!map || !map.meituan_name) return;
    try {
      await api(`/api/retail-admin/meituan/products/${pid}/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: _storeA.id, storeCode: _storeA.code, meituanName: map.meituan_name, syncEnabled: checkbox.checked }),
      });
      map.sync_enabled = checkbox.checked ? 1 : 0;
      mtFilterProducts();   // refresh the Tianhe status pill (Synced / Sync off)
    } catch (e) {
      toast(cuT('Toggle failed: ', '切换失败:') + e.message, 'error');
    }
  };

  // The editable 外卖 channel is 天河 (storeA). 越秀 is on 美团闪购 and maps
  // itself by 货号 (shangou daemon) — so manual fill/clear/paste tools operate
  // on 天河 only and never overwrite the 闪购 auto-mapping.
  function mtOutletStores() {
    return _storeA ? [_storeA] : [];
  }

  // ── Filter ──────────────────────────────────────────────────────────────────
  window.mtFilterProducts = function () {
    const q = (document.getElementById('mt-search')?.value || '').toLowerCase();
    const filtered = _products.filter(p => {
      if (_mtFilter === 'att' && !mtNeedsAttention(p)) return false;
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
    const tabn = document.getElementById('mt-tabn-bundles');
    if (tabn) tabn.textContent = _bundles.length || '';
    if (!wrap) return;
    if (!_bundles.length) {
      wrap.innerHTML = `<div class="muted" style="font-size:13px;padding:12px 14px">${cuT('No bundles yet.', '暂无套餐。')}</div>`;
      return;
    }
    wrap.innerHTML = _bundles.map((b, bi) => {
      const comps = (b.components || []).map(c =>
        `${esc([c.name_cn, c.name_en].filter(Boolean).join(' '))}${c.variant_label ? ` (${esc(c.variant_label)})` : ''}${c.qty > 1 ? ` ×${c.qty}` : ''}`
      ).join(', ');
      const storeName = (_stores.find(s => s.code === b.store_code) || {}).name || b.store_code;
      return `<div style="${bi ? 'border-top:1px solid var(--line-soft);' : ''}padding:12px 14px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
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
      box.innerHTML = `<div class="muted" style="font-size:12px;padding:6px 0">${cuT(
        'No combo-looking titles found. Run Match names first (this session), then try again.',
        '未发现疑似套餐的名称。请先运行「匹配名称」(本次会话内),再试一次。')}</div>`;
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
    if (!(await askConfirm({ title: 'Delete this bundle?', body: 'This only stops auto-stock — it does not touch the Meituan listing.', confirmLabel: 'Delete bundle', danger: true }))) return;
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
    // SQLite hands us naive UTC ("YYYY-MM-DD HH:MM:SS", no zone). A bare
    // new Date() parses that as LOCAL time, so in China (UTC+8) a brand-new
    // order read "8h ago". Normalise naive strings to UTC before diffing;
    // leave already-zoned ISO values (T…Z or ±hh:mm offset) untouched.
    const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
    const norm = hasZone ? iso : String(iso).replace(' ', 'T') + 'Z';
    const t = new Date(norm).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    if (diff < 60000)  return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }
})();
