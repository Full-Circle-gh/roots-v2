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
  let _elFilter = 'all';  // chip filter: all | att | ok | size
  let _elStore  = '';     // store filter: '' = all stores
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
  // shop id, then log in once" instruction — the notice in elRenderHead()
  // carries it now, per store, only when that store needs it.
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
      elRenderHead();
      elRenderProducts(); // store columns depend on _stores
    } catch (e) {}
  };

  // -- The head: status line, three tiles, at most one notice ----------------
  // Same shape as the Meituan page. A store is blocked when it cannot push at
  // all: no shop id linked, or no saved login session. A run of failed pushes
  // is deliberately not blocked - listings get renamed and the review queue
  // rejects writes while the channel itself is fine.
  const EL_BLOCK_TXT = {
    no_shop:     ['has no Eleme shop linked yet', '\u5c1a\u672a\u5173\u8054\u9976\u4e86\u4e48\u5e97\u94fa'],
    needs_login: ['is signed out', '\u5df2\u9000\u51fa\u767b\u5f55'],
  };

  function elRenderHead() {
    const rows = _lastStores || [];
    const active = _products.filter(p => Number(p.is_active) !== 0);
    const live = active.filter(p => Object.values(p.stores || {}).some(m => m.eleme_name)).length;
    const att = active.filter(elNeedsAttention).length;
    const waiting = rows.reduce((a2, r) => a2 + Number(r.pending || 0) + Number(r.processing || 0), 0);
    const per = (key) => rows.map(r => Number(r[key] || 0) + ' ' + r.name).join(' \u00b7 ');

    const st = document.getElementById('el-status');
    if (st) {
      let html = esc(cuT(live + ' live', live + ' \u4e2a\u5df2\u4e0a\u67b6'));
      if (att) html += ' \u00b7 ' + esc(cuT(att + ' need attention', att + ' \u4e2a\u5f85\u5904\u7406'));
      const bad = rows.filter(r => r.blocked);
      if (bad.length) {
        html += ' \u00b7 <span class="att">' +
          esc(cuT(bad.map(r => r.name).join(', ') + ' needs you',
                  bad.map(r => r.name).join('\u3001') + ' \u9700\u8981\u5904\u7406')) + '</span>';
      } else if (!att) {
        html += ' \u00b7 ' + esc(cuT('all matched', '\u5168\u90e8\u5df2\u5339\u914d'));
      }
      st.innerHTML = html;
    }

    const tiles = document.getElementById('el-tiles');
    if (tiles) {
      const tile = (k, v, sub, warn) =>
        '<div class="el-tile"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (warn ? ' att' : '') + '">' + esc(String(v)) + '</div>' +
        '<div class="s">' + esc(sub) + '</div></div>';
      tiles.innerHTML =
        tile(cuT('Live on Eleme', '\u5df2\u4e0a\u67b6\u9976\u4e86\u4e48'), live, per('live'), false) +
        tile(cuT('Need attention', '\u5f85\u5904\u7406'), att,
             cuT('unmatched, or missing a size', '\u672a\u5339\u914d\uff0c\u6216\u672a\u9009\u89c4\u683c'), att > 0) +
        tile(cuT('Stock updates waiting', '\u5f85\u63a8\u9001\u5e93\u5b58'), waiting, per('pending'), false);
    }

    const notice = document.getElementById('el-notice');
    if (notice) {
      const bad = rows.filter(r => r.blocked)[0];
      if (!bad) { notice.innerHTML = ''; return; }
      const what = EL_BLOCK_TXT[bad.blockedBy] || ['is not syncing', '\u540c\u6b65\u5df2\u505c'];
      const cat = bad.catalogueCount
        ? cuT(bad.catalogueCount + ' listings read', '\u5df2\u8bfb\u53d6 ' + bad.catalogueCount + ' \u4e2a\u5546\u54c1')
        : cuT('no catalogue read yet, so nothing can be matched there',
              '\u5c1a\u672a\u8bfb\u53d6\u5546\u54c1\u76ee\u5f55\uff0c\u65e0\u6cd5\u5339\u914d');
      // The one action that unblocks it. Linking a shop id is a field; signing
      // in needs a human at a browser on the box, so that one is the command.
      const act = bad.blockedBy === 'no_shop'
        ? '<input id="el-shop-' + bad.id + '" class="inp el-nameinp" placeholder="' +
            cuT('Eleme shop id', '\u9976\u4e86\u4e48\u5e97\u94faID') + '">' +
          '<button class="btn btn-sm btn-primary" onclick="elSetShop(' + bad.id + ", '" + esc(bad.code) + "')\">" +
            cuT('Link shop', '\u5173\u8054\u5e97\u94fa') + '</button>'
        : '<code class="el-psku">node scripts/eleme-login.js ' + esc(bad.code) + ' ' + esc(bad.shopId || '') + '</code>';
      notice.innerHTML = '<div class="el-notice"><span class="dot"></span>' +
        '<div class="m"><b>' + esc(bad.name + ' ' + cuT(what[0], what[1])) + '.</b>' +
        '<div class="sub">' + esc(cat) + '</div></div>' + act + '</div>';
    }
  }

  // Needs attention: not mapped anywhere, or mapped to a listing that holds
  // several sizes with none picked — on Eleme a size CAN be targeted, so that
  // second case is a real gap, not a note.
  function elNeedsAttention(p) {
    const maps = Object.values(p.stores || {});
    if (!maps.some(m => m.eleme_name)) return true;
    return maps.some(m => m.eleme_name && Number(m.specCount || 0) > 1 && !m.spec_id);
  }

  // -- Chip + store filters ---------------------------------------------------
  const EL_CHIPS = [
    { id: 'all',  en: 'All',            cn: '\u5168\u90e8' },
    { id: 'att',  en: 'Needs attention', cn: '\u5f85\u5904\u7406' },
    { id: 'ok',   en: 'Synced',          cn: '\u5df2\u540c\u6b65' },
    { id: 'size', en: 'Needs a size',    cn: '\u5f85\u9009\u89c4\u683c' },
  ];

  function elChipMatch(p, id) {
    const maps = Object.values(p.stores || {});
    if (id === 'att')  return elNeedsAttention(p);
    if (id === 'ok')   return maps.some(m => m.eleme_name);
    if (id === 'size') return maps.some(m => m.eleme_name && Number(m.specCount || 0) > 1 && !m.spec_id);
    return true;
  }

  function elStorePass(p) {
    if (!_elStore) return true;
    return !!(p.stores || {})[_elStore] || elNeedsAttention(p);
  }

  function elRenderChips() {
    const box = document.getElementById('el-chips');
    if (!box) return;
    const active = _products.filter(p => Number(p.is_active) !== 0).filter(elStorePass);
    box.innerHTML = EL_CHIPS.map(c => {
      const n = active.filter(p => elChipMatch(p, c.id)).length;
      return '<button class="el-fchip' + (_elFilter === c.id ? ' on' : '') +
        '" onclick="elSetFilter(\'' + c.id + '\')">' + esc(cuT(c.en, c.cn)) +
        ' <span class="c">' + n + '</span></button>';
    }).join('');
  }

  window.elSetFilter = function (f) { _elFilter = f; elRenderChips(); elRenderProducts(); };

  function elRenderStoreFilter() {
    const sel = document.getElementById('el-store-filter');
    if (!sel) return;
    sel.innerHTML = '<option value="">' + esc(cuT('All stores', '\u5168\u90e8\u95e8\u5e97')) + '</option>' +
      _stores.map(s2 => '<option value="' + esc(s2.code) + '"' + (_elStore === s2.code ? ' selected' : '') +
        '>' + esc(s2.name) + '</option>').join('');
  }

  window.elSetStore = function (code) { _elStore = code || ''; elRenderStoreFilter(); elRenderChips(); elRenderProducts(); };

  function fmtAgo(iso) {
    if (!iso) return '';
    const t = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
    if (!t) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return cuT('just now', '\u521a\u521a');
    if (m < 60) return cuT(m + ' min ago', m + ' \u5206\u949f\u524d');
    const h = Math.floor(m / 60);
    if (h < 24) return cuT(h + ' h ago', h + ' \u5c0f\u65f6\u524d');
    return cuT(Math.floor(h / 24) + ' d ago', Math.floor(h / 24) + ' \u5929\u524d');
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
      elRenderHead();
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
      elRenderHead();  // counts only exist now
      elRenderChips();
    } catch (e) {}
  };

  window.elFilterProducts = function () { elRenderProducts(); };

  function elRenderProducts() {
    const tbody = document.getElementById('el-tbody');
    if (!tbody) return;
    const th = document.getElementById('el-th-stores');
    if (th) th.textContent = cuT('Sync per store', '\u5404\u95e8\u5e97\u540c\u6b65');

    // Text match covers the SKU and the mapped listing name too — the two
    // things you actually have in front of you when hunting a row.
    const q = (document.getElementById('el-search')?.value || '').trim().toLowerCase();
    const rows = _products
      .filter(p => Number(p.is_active) !== 0)
      .filter(p => elChipMatch(p, _elFilter))
      .filter(elStorePass)
      .filter(p => !q
        || (p.name_cn || '').toLowerCase().includes(q)
        || (p.name_en || '').toLowerCase().includes(q)
        || (p.sku || '').toLowerCase().includes(q)
        || Object.values(p.stores || {}).some(m => (m.eleme_name || '').toLowerCase().includes(q)));

    const cnt = document.getElementById('el-count');
    if (cnt) cnt.textContent = String(rows.length);
    elRenderHead();
    elRenderChips();

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="el-empty">' + cuT('Nothing here.', '\u6682\u65e0\u5546\u54c1\u3002') + '</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(p => {
      const base = cuT(p.name_en || p.name_cn, p.name_cn || p.name_en);
      const alt  = cuT(p.name_cn || '', p.name_en || '');
      // Size variants are separate products sharing a variant_group_id, so two
      // sizes arrive as two rows with the SAME name — the label is what tells
      // them apart.
      const nameCell = '<div class="el-pcell"><div>' +
        '<div class="el-pname">' + esc(base) +
          (p.variant_label ? ' <span class="vl">\u00b7 ' + esc(p.variant_label) + '</span>' : '') + '</div>' +
        (alt && alt !== base ? '<div class="el-pmeta">' + esc(alt) + '</div>' : '') +
        '</div></div>';

      const stores = _stores
        .filter(st => !_elStore || st.code === _elStore)
        .map(st => {
          const m = (p.stores || {})[st.code];
          const on = !!(m && Number(m.sync_enabled) === 1);
          const mappedName = (m && m.eleme_name) || '';
          const specs = elSpecsFor(st.code, mappedName);
          const chosen = String((m && m.spec_id) || '');
          // A listing with several sizes and none picked cannot be pushed
          // accurately — the driver falls back to a rule that writes a made-up
          // number to every size. That is the one state worth colouring.
          const needsSize = on && specs.length > 1 && !chosen;
          const pill = !mappedName ? '<span class="el-pill att"><span class="d"></span>' + cuT('Add name', '\u5f85\u586b\u540d\u79f0') + '</span>'
            : needsSize ? '<span class="el-pill att"><span class="d"></span>' + cuT('Pick a size', '\u5f85\u9009\u89c4\u683c') + '</span>'
            : on ? '<span class="el-pill ok"><span class="d"></span>' + cuT('Synced', '\u5df2\u540c\u6b65') + '</span>'
            : '<span class="el-pill off"><span class="d"></span>' + cuT('Sync off', '\u5df2\u5173\u95ed') + '</span>';
          const last = (m && m.last_pushed_at)
            ? '<div class="el-pmeta">' + esc(cuT('pushed ', '\u63a8\u9001\u4e8e ') + (fmtAgo(m.last_pushed_at) || '')) + '</div>'
            : '';
          // The name field is an autocomplete against the real catalogue, not
          // free text: a hand-typed name once used a curly apostrophe and
          // silently failed every push.
          return '<div class="el-cellstore">' +
            '<div class="el-cellhd">' + pill +
              '<span class="nm">' + esc(st.name) + '</span>' +
              '<label class="toggle-label" title="' + esc(cuT('Sync on / off', '\u540c\u6b65\u5f00\u5173')) + '">' +
                '<input type="checkbox" ' + (on ? 'checked' : '') +
                ' onchange="elToggleSync(' + p.id + ', ' + st.id + ", '" + esc(st.code) + "', this.checked)\"></label>" +
            '</div>' +
            '<input type="text" class="inp el-nameinp" data-no-i18n' +
              ' list="el-catalogue-dl-' + esc(st.code) + '"' +
              ' placeholder="' + esc(cuT('Eleme listing name', '\u9976\u4e86\u4e48\u5546\u54c1\u540d')) + '"' +
              ' value="' + esc(mappedName) + '"' +
              ' onchange="elSetElemeName(' + p.id + ', ' + st.id + ", '" + esc(st.code) + "', this.value)\">" +
            (specs.length > 1
              ? '<select data-no-i18n class="inp el-size' + (needsSize ? ' warn' : '') + '"' +
                ' title="' + esc(cuT('Which size inside this listing', '\u5bf9\u5e94\u8be5\u5546\u54c1\u7684\u54ea\u4e2a\u89c4\u683c')) + '"' +
                ' onchange="elSetElemeSpec(' + p.id + ', ' + st.id + ", '" + esc(st.code) + "', this.value, this.options[this.selectedIndex].dataset.label || '')\">" +
                '<option value="" data-label="">' + esc(cuT('Pick a size\u2026', '\u9009\u62e9\u89c4\u683c\u2026')) + '</option>' +
                specs.map((sp, i) => {
                  const lbl = elSpecLabel(sp, i);
                  return '<option value="' + esc(sp.specGlobalId) + '" data-label="' + esc(sp.name || lbl) + '"' +
                    (String(sp.specGlobalId) === chosen ? ' selected' : '') + '>' + esc(lbl) + '</option>';
                }).join('') +
                '</select>'
              : '') +
            last +
          '</div>';
        }).join('');

      return '<tr>' +
        '<td>' + nameCell + '</td>' +
        '<td>' + (p.sku ? '<span class="el-psku">' + esc(p.sku) + '</span>' : '') + '</td>' +
        '<td>' + (stores || '<span class="el-pill off">\u2014</span>') + '</td>' +
      '</tr>';
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
