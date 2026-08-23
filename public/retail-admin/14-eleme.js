/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* Eleme Sync admin tab — feature switch + OAuth connect + product mapping + status */
/* namespace: el* */

(function () {
  'use strict';

  let _products = [];
  let _stores   = [];
  let _enabled  = false;
  let _initiated = false;
  let _lastStores = [];  // last /status.stores, so the status line can repaint
  let _catalogue = {}; // storeCode -> [{name, stock, updated_at}], see elLoadCatalogue

  // ── Entry point ────────────────────────────────────────────────────────────
  window.elAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await elLoadConfig();
    await Promise.all([elLoadStores(), elLoadStatus()]);
    await elLoadProducts();
    elLoadCatalogue();
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

  // ── Sub-views: Products / Activity ─────────────────────────────────────────
  window.elView = function (v) {
    ['products', 'activity'].forEach(k => {
      const view = document.getElementById('el-view-' + k);
      const tab  = document.getElementById('el-tab-' + k);
      if (view) view.hidden = k !== v;
      if (tab) tab.classList.toggle('active', k === v);
    });
  };

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
      if (txt) {
        txt.textContent = _enabled ? cuT('Channel on · 渠道开启', '渠道开启')
                                   : cuT('Channel off · 渠道已关闭', '渠道已关闭');
      }
      // The standing setup instruction went with the connection card: it is
      // one-time help, and a store that needs it now says so on its own card.
    } catch (e) { /* surfaced by api() */ }
  };

  window.elToggleEnabled = async function (on) {
    try {
      await api('/api/retail-admin/eleme/enable', { method: 'POST', body: { enabled: !!on } });
      _enabled = !!on;
      const txt = document.getElementById('el-enable-txt');
      if (txt) {
        txt.textContent = on ? cuT('Channel on · 渠道开启', '渠道开启')
                             : cuT('Channel off · 渠道已关闭', '渠道已关闭');
      }
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
      elRenderStoreCards(_lastStores);
      elRenderProducts(); // store columns depend on _stores
    } catch (e) {}
  };

  // One card per store, from /eleme/status.stores — the same shape the Meituan
  // page uses. A store is blocked when it cannot push at all: no shop id linked
  // (never set up) or no saved login session. A run of failed pushes is NOT
  // blocked: listings get renamed and the 审核 queue rejects writes while the
  // channel itself is fine, and colouring that amber would cry wolf on the one
  // state that actually means a person is needed.
  const EL_BLOCK_TXT = {
    no_shop:     ['No Eleme shop linked yet', '尚未关联饿了么店铺'],
    needs_login: ['Signed out — needs a one-time login', '已退出登录 — 需重新登录一次'],
  };

  function elRenderStoreCards(stores) {
    const box = document.getElementById('el-stores');
    if (!box) return;
    const rows = Array.isArray(stores) ? stores : [];
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = rows.map(st => {
      const bt = EL_BLOCK_TXT[st.blockedBy] || ['Not syncing', '同步已停'];
      const state = st.blocked ? cuT(bt[0], bt[1])
                               : cuT('Signed in · pushing stock', '已登录 · 正在推送');
      const stranded = Number(st.processing || 0);
      const cat = st.catalogueCount
        ? cuT(st.catalogueCount + ' listings read', '已读取 ' + st.catalogueCount + ' 个商品')
        : cuT('no catalogue yet', '暂无目录');
      const facts = [
        { k: cuT('Live', '已上架'),      v: st.live,      warn: false },
        { k: cuT('Unmatched', '未匹配'), v: st.unmatched, warn: st.unmatched > 0 },
        { k: cuT('Waiting', '待推送'),   v: st.pending,   warn: false },
        stranded ? { k: cuT('Stranded', '卡住'), v: stranded, warn: true } : null,
        { k: cuT('Catalogue', '商品目录'), v: cat, warn: !st.catalogueCount },
        { k: cuT('Last push', '最近推送'),
          v: st.lastPushAt ? (fmtAgo(st.lastPushAt) || '—') : cuT('never', '从未'), warn: false },
      ].filter(Boolean);
      const factHtml = facts.map(f =>
        '<div class="sf"><div class="k">' + esc(f.k) + '</div><div class="v' +
        (f.warn ? ' warn' : '') + '">' + esc(String(f.v)) + '</div></div>').join('');
      // The one action that unblocks this store, and nothing else. Linking a
      // shop id is a field; signing in needs a human at a browser on the box,
      // so that one is the command to run, never a button that cannot work.
      let act = '';
      if (st.blockedBy === 'no_shop') {
        act = '<div class="sact">' +
          '<input id="el-shop-' + st.id + '" class="inp" placeholder="' +
            cuT('Eleme shop id', '饿了么店铺ID') + '">' +
          '<button class="btn btn-sm btn-primary" onclick="elSetShop(' + st.id + ", '" + esc(st.code) + "')\">" +
          cuT('Link shop', '关联店铺') + '</button></div>';
      } else if (st.blockedBy === 'needs_login') {
        act = '<div class="sact"><code>node scripts/eleme-login.js ' +
          esc(st.code) + ' ' + esc(st.shopId || '') + '</code></div>';
      }
      return '<div class="el-store' + (st.blocked ? ' blocked' : '') + '">' +
          '<div class="sh"><span class="sdot"></span>' +
            '<span class="sname">' + esc(st.name) + '</span>' +
            '<span class="smode">' + esc(st.shopName || st.shopId || cuT('not linked', '未关联')) + '</span></div>' +
          '<div class="sstate">' + esc(state) + '</div>' +
          '<div class="sfacts">' + factHtml + '</div>' + act +
        '</div>';
    }).join('');
  }

  // §1.7 status line: live state for the section, real numbers, sentence case.
  function elRenderStatusLine(stores) {
    const el = document.getElementById('el-status');
    if (!el) return;
    const rows = Array.isArray(stores) ? stores : [];
    if (!rows.length) { el.textContent = ''; return; }
    // Distinct products, never the sum of the stores — most are live on both.
    const active = _products.filter(p => Number(p.is_active) !== 0);
    const live = active.filter(p => Object.values(p.stores || {}).some(m => Number(m.sync_enabled) === 1)).length;
    const parts = [cuT(live + ' live on Eleme', live + ' 个已上架饿了么')];
    const unmatched = active.length - live;
    if (unmatched > 0) parts.push(cuT(unmatched + ' unmatched', unmatched + ' 个未匹配'));
    let html = parts.map(esc).join(' · ');
    const bad = rows.filter(r => r.blocked);
    if (bad.length) {
      html += ' · <span class="att">' +
        esc(cuT(bad.map(r => r.name).join(', ') + ' needs you',
                bad.map(r => r.name).join('、') + ' 需要处理')) + '</span>';
    }
    el.innerHTML = html;
  }

  function fmtAgo(iso) {
    if (!iso) return '';
    const t = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
    if (!t) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return cuT('just now', '刚刚');
    if (m < 60) return cuT(m + ' min ago', m + ' 分钟前');
    const h = Math.floor(m / 60);
    if (h < 24) return cuT(h + ' h ago', h + ' 小时前');
    return cuT(Math.floor(h / 24) + ' d ago', Math.floor(h / 24) + ' 天前');
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

  // Every size (规格) behind one Eleme listing name, from the cached catalogue.
  // One listing can hold "小" and "大" behind a single name — that is exactly the
  // case the size picker below exists for.
  function elSpecsFor(storeCode, name) {
    const key = String(name || '').trim();
    if (!key) return [];
    const rows = (_catalogue[storeCode] && _catalogue[storeCode].rows) || [];
    const hit = rows.find(r => String(r.name || '').trim() === key);
    return (hit && Array.isArray(hit.specs)) ? hit.specs : [];
  }

  // Short label for one size in the dropdown. Eleme leaves `name` blank on some
  // listings, so fall back to price, then to a plain number; the current stock
  // rides along because it is often the only thing telling two blanks apart.
  function elSpecLabel(sp, i) {
    const base = (sp.name || '').trim()
      || (sp.price != null ? '¥' + sp.price : '')
      || (cuT('Size ', '规格 ') + (i + 1));
    return sp.stock != null ? base + ' · ' + sp.stock : base;
  }

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
      try { await elLoadStatus(); } catch (_) {}
      finally { _pollBusy = false; }
    }, 12000);
  }

  window.elLoadStatus = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/status');
      // The four KPI tiles summed the stores into numbers that could not say
      // WHICH store was unwell. Store cards carry it per store now.
      _lastStores = r.stores || [];
      elRenderStoreCards(_lastStores);
      elRenderStatusLine(_lastStores);
      const upd = document.getElementById('el-upd');
      if (upd) upd.textContent = cuT('Updated just now', '刚刚更新');
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
    if (!rows.length) { box.innerHTML = `<span class="empty">${cuT('Nothing yet', '暂无记录')}</span>`; return; }
    box.innerHTML = rows.map(r => {
      const t = (r.created_at || '').slice(5, 16);
      let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (e) {}
      const prod = _products.find(x => x.id === d.product_id);
      const name = prod ? (prod.name_cn || prod.name_en) : (d.sku || ('#' + d.product_id));
      const qty = d.qty != null ? ` → ${d.qty}` : '';
      const err = r.status === 'error' ? `: ${esc(r.error_msg || '')}` : '';
      return `<div class="${r.status === 'error' ? 'bad' : ''}"><span class="t">${t} [${esc(r.store_code || '-')}]</span> ${esc(name)}${qty}${err}</div>`;
    }).join('');
  }

  function elRenderLog(rows) {
    const box = document.getElementById('el-log-sys');
    if (!box) return;
    if (!rows.length) { box.innerHTML = `<span class="empty">${cuT('Nothing yet', '暂无记录')}</span>`; return; }
    box.innerHTML = rows.map(r => {
      const t = (r.created_at || '').slice(5, 16);
      const msg = r.error_msg || r.event_type;
      return `<div class="${r.status === 'error' ? 'bad' : ''}"><span class="t">${t} [${esc(r.store_code || '-')}]</span> ${esc(r.event_type)}: ${esc(msg)}</div>`;
    }).join('');
  }

  // The incoming-orders list went with its card. Eleme order import is not
  // wired yet (getPendingOrders returns []), so it could only ever render
  // empty; when it lands, Eleme orders belong on the Orders page with every
  // other channel, the same call the Meituan page made.

  // ── Product mapping ──────────────────────────────────────────────────────────
  window.elLoadProducts = async function () {
    try {
      const r = await api('/api/retail-admin/eleme/products');
        _products = r.data || [];
      elRenderProducts();
      elRenderStatusLine(_lastStores);  // counts only exist now
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
      const base = cuT(p.name_en || p.name_cn, p.name_cn || p.name_en);
      // Size variants are separate products sharing a variant_group_id, so two
      // sizes arrive here as two rows with the SAME name — indistinguishable
      // without the label. 11-meituan.js has always printed it; this table
      // didn't, which is why variants read as duplicates.
      const nm = p.variant_label ? base + ' · ' + p.variant_label : base;
      const cells = _stores.map(s => {
        const m = (p.stores || {})[s.code];
        const on = m && Number(m.sync_enabled) === 1;
        const mappedName = (m && m.eleme_name) || '';
        const specs = elSpecsFor(s.code, mappedName);
        const chosen = String((m && m.spec_id) || '');
        // A listing with several sizes and no size chosen can't be pushed
        // accurately — the driver falls back to a rule that writes a made-up
        // number to every size. Flag it rather than let it run silently.
        const guessing = on && specs.length > 1 && !chosen;
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
          <input type="text" class="inp el-nameinp" data-no-i18n
                 list="el-catalogue-dl-${esc(s.code)}"
                 placeholder="${cuT('Eleme listing name', '饿了么商品名')}"
                 value="${esc(mappedName)}"
                 onchange="elSetElemeName(${p.id}, ${s.id}, '${s.code}', this.value)">
          ${specs.length > 1 ? `
          <select data-no-i18n
                  class="inp el-size${guessing ? ' warn' : ''}"
                  title="${cuT('Which size inside this listing', '对应该商品的哪个规格')}"
                  onchange="elSetElemeSpec(${p.id}, ${s.id}, '${s.code}', this.value, this.options[this.selectedIndex].dataset.label || '')">
            <option value="" data-label="">${cuT('Pick size…', '选择规格…')}</option>
            ${specs.map((sp, i) => {
              const lbl = elSpecLabel(sp, i);
              return `<option value="${esc(sp.specGlobalId)}" data-label="${esc(sp.name || lbl)}"${
                String(sp.specGlobalId) === chosen ? ' selected' : ''}>${esc(lbl)}</option>`;
            }).join('')}
          </select>` : ''}
          ${guessing ? `<span title="${cuT('This listing has several sizes and none is picked — the stock pushed to it is a guess.', '该商品有多个规格且未选择 — 推送的库存并不准确。')}"
                 class="el-guess">!</span>` : ''}
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
        body: on ? { storeId, storeCode, syncEnabled: 1, elemeName: (cur && cur.eleme_name) || null,
                     specId: (cur && cur.spec_id) || null, specName: (cur && cur.spec_name) || null }
                 : { storeId, storeCode, remove: 1 },
      });
      // Reflect locally without a full reload.
      if (p) {
        p.stores = p.stores || {};
        if (on) p.stores[storeCode] = { ...(cur || {}), sync_enabled: 1 };
        else delete p.stores[storeCode];
      }
      // repaint: the "no size picked" warning only applies once sync is on
      elRenderProducts();
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
        // A size id belongs to one listing, so pointing at a different listing
        // drops the old pick (the server does the same) — then repaint, because
        // the new listing has its own sizes to offer.
        const kept = (cur && cur.eleme_name) === (name || null);
        p.stores[storeCode] = {
          ...(cur || {}),
          eleme_name: name || null,
          spec_id:   kept ? (cur && cur.spec_id)   || null : null,
          spec_name: kept ? (cur && cur.spec_name) || null : null,
          sync_enabled: cur ? Number(cur.sync_enabled) : 0,
        };
      }
      elRenderProducts();
      if (window.toast) toast(cuT('Saved · 已保存', '已保存'));
    } catch (e) { elLoadProducts(); }
  };

  // Save WHICH size inside the listing this product is. One Eleme listing can
  // hold several sizes behind one name; without this the pusher can't tell them
  // apart and falls back to a rule that writes a made-up number to every size
  // (live at 天河: two Roots sizes on one listing overwrote each other every
  // cycle, one pushing 9999 and the other 0). Like the name field, it does NOT
  // touch sync_enabled — the checkbox stays the only way to turn pushing on.
  window.elSetElemeSpec = async function (productId, storeId, storeCode, specId, specName) {
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    try {
      await api('/api/retail-admin/eleme/products/' + productId + '/map', {
        method: 'POST',
        body: {
          storeId, storeCode,
          elemeName: (cur && cur.eleme_name) || null,
          specId: specId || null,
          specName: specId ? (specName || null) : null,
          syncEnabled: cur ? Number(cur.sync_enabled) : 0,
        },
      });
      if (p) {
        p.stores = p.stores || {};
        p.stores[storeCode] = { ...(cur || {}), spec_id: specId || null, spec_name: specId ? (specName || null) : null };
      }
      elRenderProducts();
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
