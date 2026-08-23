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
  let _lastStores = [];  // last /status.stores, so the status line can repaint
  let _mtFilter  = 'all';  // chip filter: all | att | ok | ms
  let _mtStore   = '';     // store filter: '' = all stores

  // ── Entry point ────────────────────────────────────────────────────────────
  window.mtAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    // If the first load dies (flaky network, expired session), release the
    // guard so the next click on the tab retries instead of showing the static
    // "Loading…" shell until a full page reload.
    try {
      await Promise.all([mtLoadStores(), mtLoadConfig(), mtLoadStatus()]);
      await mtLoadProducts();
    } catch (e) {
      _initiated = false;
      throw e;
    }
    mtLoadBundles();
    mtLoadListingsCache(); // read-only — whatever a past Match-names run cached, for the name-input autocomplete
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
      try { await mtLoadStatus(); }
      catch (_) { /* transient — next tick retries */ }
      finally { _pollBusy = false; }
    }, 12000);
  }

  // Store open/close (营业/休息) lives on the Sales page channel cards (see
  // csLoad/csPopup in 01-core.js). The per-store panel that used to sit here was
  // retired, and the mtLoadBusinessStatus no-op that outlived it was deleted in
  // the 2026-08-23 rebuild. The read itself is still live server-side
  // (/meituan/business-status) and still has no UI of its own.


  // Orders ledger removed — Meituan orders show on the main Orders page like
  // every other channel; keeping a second read-only copy here was duplicate
  // noise. The "Last order" KPI (from /status) stays as the health signal.

  // -- Channel switch (no UI on this page) -------------------------------------
  // The on/off control moved to Sales: it is channel setup, not daily work.
  // These stay because the flag is real — both daemons honour it — and the
  // Sales card will drive them once it grows a switch.
  // Meituan had no off switch: stopping the channel meant killing the daemon.
  // Both daemons (外卖 and 闪购, which share one queue) now check the same flag.
  // It defaults ON — an absent key must never read as "off" and take a live
  // channel down the first time this ships.
  window.mtLoadConfig = async function () {
    try {
      const r = await api('/api/retail-admin/meituan/config');
      mtPaintChannel(r.enabled !== false);
    } catch (e) { /* surfaced by api() */ }
  };

  function mtPaintChannel(on) {
    const cb = document.getElementById('mt-enable');
    if (cb) cb.checked = !!on;
    const txt = document.getElementById('mt-enable-txt');
    if (txt) {
      txt.textContent = on
        ? cuT('Channel on · 渠道开启', '渠道开启')
        : cuT('Channel off · 渠道已关闭', '渠道已关闭');
    }
  }

  window.mtToggleChannel = async function (on) {
    try {
      await api('/api/retail-admin/meituan/enable', { method: 'POST', body: { enabled: !!on } });
      mtPaintChannel(!!on);
      if (window.toast) {
        toast(on
          ? cuT('Meituan channel on', '美团渠道已开启')
          : cuT('Meituan channel off — nothing will be pushed', '美团渠道已关闭 — 将不再推送'));
      }
      mtLoadStatus();
    } catch (e) { mtLoadConfig(); }  // revert to whatever the server still says
  };

  // ── Sub-views: Products / Bundles ────────────────────────────────────────────
  window.mtView = function (v) {
    ['products', 'bundles', 'activity'].forEach(k => {
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
    mtRenderStoreFilter();
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  // Populates the fc-kpis strip (matches the Products catalogue's KPI tiles).
  function mtSetKpi(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  // mtAlertTile went with the strip: a tile that flips amber cannot say WHICH
  // store is unwell, which was the whole problem. The cards carry it now.

  // English store labels keyed by code — the store record only carries a Chinese
  // `name` (天河店 / 越秀店), so in the English log we derive a Latin name instead
  // of falling through to the Chinese one.
  const MT_STORE_EN = { tianhe: 'Tianhe', yuexiu: 'Yuexiu' };
  function mtStoreName(code, cn) {
    if (cn === false && MT_STORE_EN[code]) return MT_STORE_EN[code];
    return (_stores.find(s => s.code === code) || {}).name || code;
  }

  window.mtLoadStatus = async function () {
    try {
      const s = await api('/api/retail-admin/meituan/status');
      mtPaintChannel(s.enabled !== false);
      _lastStores = s.stores || [];
      mtRenderHead();
      mtRenderLog('mt-log-stock', s.recentStock, true);
      mtRenderLog('mt-log-sys', s.recentSystem, false);
      mtSetKpi('mt-upd', cuT('Updated just now', '刚刚更新'));
    } catch (e) {
      // Cannot reach the admin API. Say so where the notice goes, rather than
      // leaving the last numbers on screen looking current.
      const n = document.getElementById('mt-notice');
      if (n) {
        n.innerHTML = '<div class="mt-notice"><span class="dot"></span><div class="m"><b>' +
          cuT('Cannot reach the sync service', '无法连接同步服务') + '</b><div class="sub">' +
          cuT('The numbers above are from the last successful check.', '上方数据为上次成功检查的结果。') +
          '</div></div></div>';
      }
      mtSetKpi('mt-upd', cuT('Offline', '离线'));
    }
  };

  // ── The head: status line, three tiles, and at most one notice ─────────────
  // Orders' opening, applied here. The tiles headline the numbers an operator
  // acts on; the per-store split rides underneath so no figure is ever a total
  // you have to unpick. The notice exists ONLY while a store needs a person —
  // when both are healthy the page opens straight on the work.
  const MT_BLOCK_TXT = {
    needs_login:     ['is signed out', '已退出登录'],
    verify_required: ['needs a verification scan', '需要扫码验证'],
    queue_stalled:   ['has a stalled stock queue', '库存推送停滞'],
    poll_paused:     ['has order polling paused', '订单轮询已暂停'],
    proxy_stale:     ['has no network route', '网络线路不可用'],
  };

  function mtRenderHead() {
    const rows   = _lastStores || [];
    const active = _products.filter(p => p.is_active);
    const live   = active.filter(p => Object.values(p.stores || {}).some(m => m.meituan_name)).length;
    const att    = active.filter(p => mtNeedsAttention(p)).length;
    const waiting = rows.reduce((a, r) => a + Number(r.pending || 0) + Number(r.processing || 0), 0);
    const cn = document.documentElement.dataset.uiLang === 'cn';
    const per = (key) => rows.map(r => Number(r[key] || 0) + ' ' + (mtStoreName(r.code, cn) || r.name)).join(' · ');

    // Status line (§1.7): live state, sentence case, tabular, " · " between facts.
    const st = document.getElementById('mt-status');
    if (st) {
      let html = esc(cuT(live + ' live', live + ' 个已上架'));
      if (att) html += ' · ' + esc(cuT(att + ' unmatched', att + ' 个未匹配'));
      const bad = rows.filter(r => r.blocked);
      if (bad.length) {
        const names = bad.map(r => mtStoreName(r.code, cn) || r.name).join(', ');
        html += ' · <span class="att">' + esc(cuT(names + ' needs you', names + ' 需要处理')) + '</span>';
      } else if (!att) {
        html += ' · ' + esc(cuT('all matched', '全部已匹配'));
      }
      st.innerHTML = html;
    }

    const tiles = document.getElementById('mt-tiles');
    if (tiles) {
      tiles.innerHTML =
        tile(cuT('Live on Meituan', '已上架美团'), live, per('live'), false) +
        tile(cuT('Not matched', '未匹配'), att,
             cuT('stock stays frozen until matched', '匹配前库存不会更新'), att > 0) +
        tile(cuT('Stock updates waiting', '待推送库存'), waiting, per('pending'), false);
    }

    const notice = document.getElementById('mt-notice');
    if (notice) {
      const bad = rows.filter(r => r.blocked)[0];
      if (!bad) { notice.innerHTML = ''; }
      else {
        const who  = mtStoreName(bad.code, cn) || bad.name;
        const what = MT_BLOCK_TXT[bad.blockedBy] || ['is not syncing', '同步已停'];
        const bits = [];
        if (bad.blockedAt)   bits.push(cuT('since ' + fmtAgo(bad.blockedAt), fmtAgo(bad.blockedAt)));
        if (bad.lastOrderAt) bits.push(cuT('last order ' + fmtAgo(bad.lastOrderAt), '最近订单 ' + fmtAgo(bad.lastOrderAt)));
        notice.innerHTML = '<div class="mt-notice"><span class="dot"></span>' +
          '<div class="m"><b>' + esc(who + ' ' + cuT(what[0], what[1])) + '.</b>' +
          (bits.length ? '<div class="sub">' + esc(bits.join(' · ')) +
            ' · ' + esc(cuT('No stock is going out and no orders are coming in.',
                            '库存不再推送,订单也不会导入。')) + '</div>' : '') +
          '</div>' + mtFixAction(bad.code) + '</div>';
      }
    }

    function tile(k, v, sub, warn) {
      return '<div class="mt-tile"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (warn ? ' att' : '') + '">' + esc(String(v)) + '</div>' +
        '<div class="s">' + esc(sub) + '</div></div>';
    }
  }

  // Signing a store back in needs a human at a browser on the box, so this is
  // the guided wizard when it is loaded and the command to run when it is not.
  // Never a button that cannot do what it says.
  function mtFixAction(code) {
    if (typeof window.igRelayWizard === 'function') {
      return '<button class="btn btn-primary" onclick="igRelayWizard(\'meituan\', ' +
        '{step:\'creds\', store:\'' + esc(code) + '\'})">' + cuT('Sign in again', '重新登录') + '</button>';
    }
    const isInstant = _storeB && code === _storeB.code;
    return '<code class="mt-psku">' + esc(isInstant ? 'node scripts/shangou-export-session.js'
                                                    : 'node scripts/meituan-login.js ' + code) + '</code>';
  }

  function mtRenderLog(id, rows, isStock) {
    const box = document.getElementById(id);
    if (!box) return;
    if (!rows || !rows.length) {
      box.innerHTML = '<div class="empty">' + cuT('Nothing yet', '暂无记录') + '</div>';
      return;
    }
    box.innerHTML = rows.map(r => {
      const t = String(r.created_at || '').slice(5, 16);
      let d = {};
      try { d = JSON.parse(r.detail || '{}'); } catch (e) { d = {}; }
      const cls = r.status === 'error' ? 'bad' : r.status === 'warn' ? 'warnrow' : '';
      let body;
      if (isStock) {
        const prod = _products.find(x => x.id === d.product_id);
        const name = prod ? (prod.name_cn || prod.name_en)
                          : (d.sku || (d.bundle ? cuT('bundle', '套餐') : '#' + d.product_id));
        body = esc(name) + (d.qty != null ? ' → ' + d.qty : '');
      } else {
        body = esc(r.event_type) + ': ' + esc(r.error_msg || r.status || '');
      }
      return '<div class="' + cls + '"><span class="t">' + esc(t) + ' [' +
        esc(r.store_code || '-') + ']</span> ' + body + '</div>';
    }).join('');
  }

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
  // ── Chip filters + store filter (Orders' filter row) ───────────────────────
  // Replaces the two-button segmented control. "Multi-size" is the new one and
  // the reason the specs are captured: 15 of 265 listings at 天河 hold more
  // than one 规格, and those are exactly the ones whose stock can go wrong.
  const MT_CHIPS = [
    { id: 'all', en: 'All',             cn: '全部' },
    { id: 'att', en: 'Needs attention', cn: '待处理' },
    { id: 'ok',  en: 'Synced',          cn: '已同步' },
    { id: 'ms',  en: 'Multi-size',      cn: '多规格' },
  ];

  function mtChipMatch(p, id) {
    const maps = Object.values(p.stores || {});
    if (id === 'att') return mtNeedsAttention(p);
    if (id === 'ok')  return maps.some(m => m.meituan_name);
    if (id === 'ms')  return maps.some(m => Number(m.specCount || 0) > 1);
    return true;
  }

  function mtRenderChips() {
    const box = document.getElementById('mt-chips');
    if (!box) return;
    const active = _products.filter(p => p.is_active).filter(mtStorePass);
    box.innerHTML = MT_CHIPS.map(c => {
      const n = active.filter(p => mtChipMatch(p, c.id)).length;
      return '<button class="mt-fchip' + (_mtFilter === c.id ? ' on' : '') +
        '" onclick="mtSetFilter(\'' + c.id + '\')">' + esc(cuT(c.en, c.cn)) +
        ' <span class="c">' + n + '</span></button>';
    }).join('');
  }

  window.mtSetFilter = function (f) {
    _mtFilter = f;
    mtRenderChips();
    mtFilterProducts();
  };

  // Store filter. Picking one store hides the other's column, so the table is
  // about the store you are working on rather than both at once.
  function mtRenderStoreFilter() {
    const sel = document.getElementById('mt-store-filter');
    if (!sel) return;
    const cn = document.documentElement.dataset.uiLang === 'cn';
    sel.innerHTML = '<option value="">' + esc(cuT('All stores', '全部门店')) + '</option>' +
      mtUniqueStores().map(s =>
        '<option value="' + esc(s.code) + '"' + (_mtStore === s.code ? ' selected' : '') + '>' +
        esc(mtStoreName(s.code, cn) || s.name) + '</option>').join('');
  }

  window.mtSetStore = function (code) {
    _mtStore = code || '';
    const th0 = document.getElementById('mt-th-store-0');
    const th1 = document.getElementById('mt-th-store-1');
    if (th0) th0.hidden = !!(_mtStore && _storeA && _mtStore !== _storeA.code);
    if (th1) th1.hidden = !!(_mtStore && _storeB && _mtStore !== _storeB.code);
    mtRenderChips();
    mtFilterProducts();
  };

  // Chip counts must be filtered the same way the rows are, or the chips claim
  // 248 while the table shows 40. Mirrors the store filter in mtRenderProducts.
  function mtStorePass(p) {
    if (!_mtStore) return true;
    return !!(p.stores || {})[_mtStore] || mtNeedsAttention(p);
  }

  function mtRenderListingDatalists() {
    let host = document.getElementById('mt-listings-datalists');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mt-listings-datalists';
      host.style.display = 'none';
      document.body.appendChild(host);
    }
    host.innerHTML = Object.keys(_listings).map(code => {
      const opts = (_listings[code] || []).map(n => `<option value="${esc(n)}">`).join('');
      return `<datalist id="mt-listings-dl-${esc(code)}">${opts}</datalist>`;
    }).join('');
  }

  // ── Products ───────────────────────────────────────────────────────────────
  async function mtLoadProducts() {
    const tbody = document.getElementById('mt-products-body');
    tbody.innerHTML = '<tr><td colspan="3" class="mt-empty">' + cuT('Loading…', '\u52a0\u8f7d\u4e2d\u2026') + '</td></tr>';
    try {
      // includeInactive so the bundle-component picker can attach paused
      // variants; the mapping list filters back to active in mtRenderProducts.
      const res = await api('/api/retail-admin/meituan/products?includeInactive=1');
      _products = res.data || [];
      mtFilterProducts();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" class="mt-empty">${escape(e.message)}</td></tr>`;
    }
  }

  // One status pill (Tea = live, Brass = needs action, neutral = not on store).
  function mtPill(kind, label) {
    return '<span class="mt-pill ' + kind + '"><span class="d"></span>' + esc(label) + '</span>';
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
    // Active only; the bundle picker loads inactive variants separately.
    const base = (filtered || _products).filter(p => p.is_active);
    // Chip + store filters. A store filter narrows the rows to ones that store
    // actually has something to say about, and hides the other column.
    const list = base.filter(p => mtChipMatch(p, _mtFilter)).filter(p => {
      if (!_mtStore) return true;
      return !!(p.stores || {})[_mtStore] || mtNeedsAttention(p);
    });
    const tbody = document.getElementById('mt-products-body');
    if (!tbody) return;
    const storeA = _storeA, storeB = _storeB;
    const showA = !(_mtStore && storeA && _mtStore !== storeA.code);
    const showB = !(_mtStore && storeB && _mtStore !== storeB.code);
    const cols  = 1 + (showA ? 1 : 0) + (showB ? 1 : 0);

    const total = _products.filter(p => p.is_active).length;
    const tabn = document.getElementById('mt-tabn-products');
    if (tabn) tabn.textContent = total || '';
    mtRenderHead();      // the tiles read the product list, so repaint them here
    mtRenderChips();

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="' + cols + '" class="mt-empty">' +
        cuT('Nothing here.', '暂无商品。') + '</td></tr>';
      return;
    }

    // Rows sharing an identical name read as duplicates; tag them apart with the
    // variant label, or the id when there is no label.
    const dup = {};
    for (const p of list) {
      const k = (p.name_cn || '') + '|' + (p.name_en || '');
      dup[k] = (dup[k] || 0) + 1;
    }

    tbody.innerHTML = list.map(p => {
      const mapA = storeA ? (p.stores[storeA.code] || {}) : {};
      const mapB = storeB ? (p.stores[storeB.code] || {}) : {};
      const anyMapped = mapA.meituan_name || mapB.meituan_name;

      const nm1 = cuT(p.name_en || p.name_cn || '', p.name_cn || p.name_en || '');
      const nm2 = cuT(p.name_cn || '', p.name_en || '');
      const tag = p.variant_label ? ' <span class="vl">· ' + esc(p.variant_label) + '</span>'
        : (dup[(p.name_cn || '') + '|' + (p.name_en || '')] > 1 ? ' <span class="vl">· #' + p.id + '</span>' : '');
      const thumb = p.image
        ? '<img class="mt-thumb" loading="lazy" src="' + esc(p.image) + '" alt="">'
        : '<span class="mt-thumb-ph"></span>';
      const nameCell = '<div class="mt-pcell">' + thumb + '<div>' +
        '<div class="mt-pname">' + esc(nm1) + tag + '</div>' +
        (nm2 && nm2 !== nm1 ? '<div class="mt-pmeta">' + esc(nm2) + '</div>' : '') +
        (p.sku ? '<span class="mt-psku">' + esc(p.sku) + '</span>' : '') +
        '</div></div>';

      // Tianhe matches by listing name, so this column is editable.
      let colA = '';
      if (showA) {
        if (!storeA) colA = '<td><span class="mt-pill off">—</span></td>';
        else {
          const hasName = !!mapA.meituan_name;
          const syncOn  = hasName && mapA.sync_enabled !== 0;
          const pill = !hasName ? mtPill('att', cuT('Add name', '待填名称'))
            : (syncOn ? mtPill('ok', cuT('Synced', '已同步')) : mtPill('off', cuT('Sync off', '已关闭')));
          const last = mtLast(mapA);
          const toggle = hasName
            ? '<label class="toggle-label" title="' + cuT('Sync on / off', '同步开关') +
              '"><input type="checkbox" ' + (syncOn ? 'checked' : '') +
              ' data-pid="' + p.id + '" onchange="mtToggleSync(this)"></label>'
            : '';
          // A listing that holds several sizes cannot be pushed accurately
          // until one is chosen — the driver would guess otherwise.
          const multi = Number(mapA.specCount || 0) > 1;
          colA = '<td>' + pill +
            '<input type="text" class="mt-name-input" list="mt-listings-dl-' + esc(storeA.code) + '"' +
            ' placeholder="' + esc(cuT('Meituan delivery name', '美团外卖商品名')) + '"' +
            ' value="' + esc(mapA.meituan_name || '') + '"' +
            ' data-pid="' + p.id + '" data-store-id="' + storeA.id + '" data-store-code="' + esc(storeA.code) + '"' +
            ' onblur="mtSaveMap(this)" onkeydown="if(event.key===\'Enter\')this.blur()">' +
            (multi ? '<div class="mt-sub">' +
              esc(cuT('This listing holds several sizes.', '该商品含多个规格。')) + '</div>' : '') +
            ((last || toggle) ? '<div class="mt-cell-foot">' +
              (last ? '<span class="mt-pmeta">' + esc(last) + '</span>' : '') + toggle + '</div>' : '') +
            '</td>';
        }
      }

      // Yuexiu is read-only: the 闪购 daemon links it by 货号.
      let colB = '';
      if (showB) {
        if (!storeB) colB = '<td><span class="mt-pill off">—</span></td>';
        else if (mapB.meituan_name) {
          const on = mapB.sync_enabled !== 0;
          const last = mtLast(mapB);
          colB = '<td>' + (on ? mtPill('ok', cuT('Linked by SKU', '按货号关联'))
                              : mtPill('off', cuT('Sync off', '已关闭'))) +
            '<div class="mt-sub">' + esc(mapB.meituan_name) + '</div>' +
            (last ? '<div class="mt-pmeta">' + esc(last) + '</div>' : '') + '</td>';
        } else {
          // Not "list it on Meituan": the product is often already listed there
          // and merely missing its 货号, which is why the auto-map cannot see it.
          const sk = (p.sku || '').trim();
          colB = '<td>' + mtPill('off', cuT('Not linked', '未关联')) +
            '<div class="mt-sub">' + (sk
              ? esc(cuT('No listing carries SKU ', '暂无商品使用货号 ')) + '<b>' + esc(sk) + '</b>' +
                esc(cuT(' yet — add it on 闪购 and this links itself', ' — 在闪购填写后会自动关联'))
              : esc(cuT('This product has no SKU, so it cannot be matched here',
                        '该商品没有货号,无法在此匹配'))) + '</div></td>';
        }
      }

      return '<tr data-pid="' + p.id + '" class="mt-product-row' + (anyMapped ? '' : ' mt-unmapped') + '">' +
        '<td>' + nameCell + '</td>' + colA + colB + '</tr>';
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
          <span class="mt-tabs-grow"></span>
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
        html += `<div class="mt-right"><button class="btn btn-sm" onclick="mtMatchFallbackAll()">${cuT('Use suggested names for all', '全部使用建议名称')}</button></div>`;
      }
    }
    if (!amb.length && !unm.length) {
      html += `<p class="muted">${cuT('Everything is matched.', '全部匹配完成。')}</p>`;
    }
    html += `</div><div class="mt-dlg-ft">
      <button class="mt-tinylink" onclick="mtMatchStartOver()">${cuT('Start over — clear all matched names', '重新开始 —— 清除所有已匹配名称')}</button>
      <span class="mt-tabs-grow"></span>
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
        mtRenderListingDatalists();
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
    ov.className = 'mt-ovl';
    ov.innerHTML = `
      <div class="mt-dlg" role="dialog">
        <div class="mt-dlg-hd">${cuT('Paste Meituan names', '\u7c98\u8d34\u7f8e\u56e2\u5546\u54c1\u540d')}
          <span class="mt-tabs-grow"></span>
          <button class="btn btn-sm" onclick="mtClosePaste()" aria-label="Close">\u2715</button></div>
        <div class="mt-dlg-bd"><div class="mt-form">
          <label class="mt-field">${cuT('Store', '\u95e8\u5e97')}
            <select id="mt-paste-store">${opts}</select>
          </label>
          <label class="mt-field">${cuT('Meituan titles — one per line, copied exactly as they appear on Meituan',
                                        '\u7f8e\u56e2\u5546\u54c1\u540d \u2014 \u6bcf\u884c\u4e00\u4e2a\uff0c\u4e0e\u7f8e\u56e2\u4e0a\u5b8c\u5168\u4e00\u81f4')}
            <textarea id="mt-paste-text" rows="12" placeholder="\u8d85\u7ea7\u8393 SuperBerries Blend&#10;\u7fbd\u8863\u7518\u84dd\u7c89 Kale Powder&#10;\u59dc\u9ec4\u7c89 Turmeric Powder"></textarea>
          </label>
          <div class="mt-hint">${cuT('Each title is matched to a product by its Chinese name, and only empty fields are filled. Anything unsure goes to the review panel.',
                                     '\u6bcf\u4e2a\u540d\u79f0\u6309\u4e2d\u6587\u540d\u5339\u914d\u5546\u54c1\uff0c\u4ec5\u586b\u5199\u7a7a\u5b57\u6bb5\u3002\u4e0d\u786e\u5b9a\u7684\u8fdb\u5165\u5f85\u786e\u8ba4\u5217\u8868\u3002')}</div>
        </div></div>
        <div class="mt-dlg-ft"><span class="mt-tabs-grow"></span>
          <button class="btn btn-sm" onclick="mtClosePaste()">${cuT('Cancel', '\u53d6\u6d88')}</button>
          <button class="btn btn-sm btn-primary" onclick="mtPasteApply()">${cuT('Match and fill', '\u5339\u914d\u5e76\u586b\u5199')}</button>
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
    mtRenderListingDatalists();

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
    const q = (document.getElementById('mt-search')?.value || '').trim().toLowerCase();
    // Chip + store filters live in mtRenderProducts; this is only the text
    // match, and it now covers the SKU and the mapped Meituan listing name —
    // the two things you actually have in front of you when hunting a row.
    const filtered = !q ? _products : _products.filter(p =>
      (p.name_cn || '').toLowerCase().includes(q) ||
      (p.name_en || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      Object.values(p.stores || {}).some(m => (m.meituan_name || '').toLowerCase().includes(q)));
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
      wrap.innerHTML = '<div class="mt-empty">' + cuT('No bundles yet.', '暂无套餐。') + '</div>';
      return;
    }
    wrap.innerHTML = _bundles.map(b => {
      const comps = (b.components || []).map(c =>
        esc([c.name_cn, c.name_en].filter(Boolean).join(' ')) +
        (c.variant_label ? ' (' + esc(c.variant_label) + ')' : '') +
        (c.qty > 1 ? ' ×' + c.qty : '')).join(', ');
      const storeName = (_stores.find(s2 => s2.code === b.store_code) || {}).name || b.store_code;
      const facts = [cuT('Available now ', '当前可做 ') + b.available];
      if (b.max_qty != null) facts.push(cuT('cap ' + b.max_qty, '上限 ' + b.max_qty));
      if (!b.sync_enabled) facts.push(cuT('sync off', '同步已关'));
      if (b.last_pushed_at) facts.push(cuT('pushed ' + b.last_pushed_qty + ' ' + fmtAgo(b.last_pushed_at),
                                           '推送 ' + b.last_pushed_qty + ' ' + fmtAgo(b.last_pushed_at)));
      return '<div class="mt-brow"><div class="bg">' +
          '<div class="bn">' + esc(b.meituan_name) + '</div>' +
          '<div class="bs">' + esc(storeName) + ' · ' +
            (comps || esc(cuT('no components yet', '尚未添加组成商品'))) + '</div>' +
          '<div class="bs">' + esc(facts.join(' · ')) + '</div>' +
        '</div>' +
        '<button class="btn btn-sm" onclick="mtEditBundle(' + b.id + ')">' + cuT('Edit', '编辑') + '</button>' +
        '<button class="btn btn-sm" onclick="mtDeleteBundle(' + b.id + ')">' + cuT('Delete', '删除') + '</button>' +
      '</div>';
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
      <div class="mt-dlg" role="dialog">
        <div class="mt-dlg-hd">${existing ? cuT('Edit bundle', '\u7f16\u8f91\u5957\u9910') : cuT('Add bundle', '\u65b0\u589e\u5957\u9910')}
          <span class="mt-tabs-grow"></span>
          <button class="btn btn-sm" onclick="mtCloseBundle()" aria-label="Close">\u2715</button></div>
        <div class="mt-dlg-bd"><div class="mt-form">
          <label class="mt-field">${cuT('Store', '\u95e8\u5e97')}
            <select id="mt-b-store">${_stores.map(s2 => `<option value="${esc(s2.code)}" ${s2.code === _bundleDraft.storeCode ? 'selected' : ''}>${esc(s2.name || s2.code)}</option>`).join('')}</select>
          </label>
          <label class="mt-field">${cuT('Meituan bundle title — exactly as it appears on Meituan',
                                        '\u7f8e\u56e2\u5957\u9910\u540d \u2014 \u4e0e\u7f8e\u56e2\u4e0a\u5b8c\u5168\u4e00\u81f4')}
            <input id="mt-b-name" value="${esc(_bundleDraft.meituanName)}" placeholder="\u85dc\u9ea6\u6c99\u62c9\u5957\u9910 Quinoa Salad Combo">
          </label>
          <label class="mt-field">${cuT('Maximum stock cap (optional)', '\u5e93\u5b58\u4e0a\u9650\uff08\u53ef\u9009\uff09')}
            <input id="mt-b-cap" type="number" min="0" class="mt-inp narrow" value="${_bundleDraft.maxQty == null ? '' : _bundleDraft.maxQty}" placeholder="${cuT('none', '\u65e0')}">
          </label>
          <div class="mt-sechd">${cuT('Components — the products this bundle uses up', '\u7ec4\u6210\u5546\u54c1 \u2014 \u8be5\u5957\u9910\u6d88\u8017\u7684\u5546\u54c1')}</div>
          <div id="mt-b-comps"></div>
          <input id="mt-b-prodsearch" class="mt-inp" placeholder="${cuT('Search products…', '\u641c\u7d22\u5546\u54c1\u2026')}" oninput="mtBundleFilterProds(this.value)">
          <div class="mt-inline">
            <select id="mt-b-prodpick" class="mt-inp">
              ${_products.map(p2 => { const lbl = [p2.name_cn, p2.name_en].filter(Boolean).join(' ') + (p2.variant_label ? ` (${p2.variant_label})` : '') + (p2.is_active ? '' : cuT(' · inactive', ' \u00b7 \u5df2\u4e0b\u67b6')); return `<option value="${p2.id}" data-label="${esc(lbl.toLowerCase())}">${esc(lbl)}</option>`; }).join('')}
            </select>
            <button class="btn btn-sm" onclick="mtBundleAddComp()">${cuT('Add', '\u6dfb\u52a0')}</button>
          </div>
        </div></div>
        <div class="mt-dlg-ft"><span class="mt-tabs-grow"></span>
          <button class="btn btn-sm" onclick="mtCloseBundle()">${cuT('Cancel', '\u53d6\u6d88')}</button>
          <button class="btn btn-sm btn-primary" onclick="mtSaveBundle()">${cuT('Save', '\u4fdd\u5b58')}</button>
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
      box.innerHTML = '<div class="mt-hint">' + cuT('No components yet — add at least one.', '\u5c1a\u672a\u6dfb\u52a0\u7ec4\u6210\u5546\u54c1\uff0c\u81f3\u5c11\u6dfb\u52a0\u4e00\u4e2a\u3002') + '</div>';
      return;
    }
    box.innerHTML = _bundleDraft.components.map((c, i) => {
      const p = _products.find(pp => pp.id == c.productId) || {};
      const label = [p.name_cn, p.name_en].filter(Boolean).join(' ') + (p.variant_label ? ` (${p.variant_label})` : '');
      return `<div class="mt-comprow">
        <span class="cn">${esc(label || ('#' + c.productId))}</span>
        <span class="mt-hint">${cuT('qty', '\u6570\u91cf')}</span>
        <input type="number" min="1" value="${c.qty}" class="cq" onchange="mtBundleCompQty(${i}, this.value)">
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
      box.innerHTML = `<div class="mt-hint">${cuT(
        'No combo-looking titles found. Run Match names first (this session), then try again.',
        '未发现疑似套餐的名称。请先运行「匹配名称」(本次会话内),再试一次。')}</div>`;
      return;
    }
    box.innerHTML = `<div class="mt-suggest">
      <div class="sh">${cuT(_bundleSuggest.length + ' possible bundle(s) — Create sets the components',
                            _bundleSuggest.length + ' \u4e2a\u53ef\u80fd\u7684\u5957\u9910 \u2014 \u521b\u5efa\u540e\u518d\u8bbe\u7f6e\u7ec4\u6210\u5546\u54c1')}</div>
      ${_bundleSuggest.map((sg, i) => `<div class="mt-srow">
        <span class="sn">${esc(sg.name)} <span class="st">\u00b7 ${esc(sg.storeName)}</span></span>
        <button class="btn btn-sm" onclick="mtCreateBundleFrom(${i})">${cuT('Create', '\u521b\u5efa')}</button>
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
