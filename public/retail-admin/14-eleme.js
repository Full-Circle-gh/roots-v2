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
  let _optionOwners = {};  // store code -> option id -> the product holding it
  let _elStore  = '';     // store filter: '' = all stores
  let _elSel    = null;   // product id the panel is showing
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
        txt.textContent = _enabled ? cuT('Channel on', '渠道开启')
                                   : cuT('Channel off', '渠道已关闭');
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
        txt.textContent = on ? cuT('Channel on', '渠道开启')
                             : cuT('Channel off', '渠道已关闭');
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

  // Both names come from the server; pick by the live language rather than
  // always taking name_cn — which is why the English UI read 越秀区.
  function elStoreName(st) {
    const cn = document.documentElement.dataset.uiLang === 'cn';
    const en = (st && (st.nameEn || st.name)) || '';
    return (cn ? (st && st.name) || en : en) || (st && st.code) || '';
  }

  function elRenderHead() {
    const rows = _lastStores || [];
    const active = _products.filter(p => Number(p.is_active) !== 0);
    const live = active.filter(p => Object.values(p.stores || {}).some(m => m.eleme_name)).length;
    const att = active.filter(elNeedsAttention).length;
    const waiting = rows.reduce((a2, r) => a2 + Number(r.pending || 0) + Number(r.processing || 0), 0);
    const per = (key) => rows.map(r => Number(r[key] || 0) + ' ' + elStoreName(r)).join(' \u00b7 ');
    // Same breakdown the total and the per-store rows use \u2014 pending + processing \u2014
    // so the tile's sub-line never reads lower than a store's own row underneath it.
    const perWaiting = rows.map(r => (Number(r.pending || 0) + Number(r.processing || 0)) + ' ' + elStoreName(r)).join(' \u00b7 ');

    const st = document.getElementById('el-status');
    if (st) {
      let html = esc(cuT(live + ' live', live + ' \u4e2a\u5df2\u4e0a\u67b6'));
      if (att) html += ' \u00b7 ' + esc(cuT(att + ' need attention', att + ' \u4e2a\u5f85\u5904\u7406'));
      const bad = rows.filter(r => r.blocked);
      if (bad.length) {
        const nm = bad.map(elStoreName);
        html += ' \u00b7 <span class="att">' +
          esc(cuT(nm.join(', ') + ' needs you', nm.join('\u3001') + ' \u9700\u8981\u5904\u7406')) + '</span>';
      } else if (!att) {
        html += ' \u00b7 ' + esc(cuT('all matched', '\u5168\u90e8\u5df2\u5339\u914d'));
      }
      st.innerHTML = html;
    }

    const tiles = document.getElementById('el-tiles');
    if (tiles) {
      const tile = (k, v, sub, warn, extra) =>
        '<div class="el-tile"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (warn ? ' att' : '') + '">' + esc(String(v)) + '</div>' +
        '<div class="s">' + esc(sub) + '</div>' + (extra || '') + '</div>';
      // Push all stock sits on the tile whose number it changes — beside the
      // tabs it had nothing to relate to, since tabs switch views.
      const pushBtn = '<div class="act"><button class="btn btn-sm" id="el-pushall-btn" onclick="elPushAll()"' +
        ' title="' + esc(cuT('Queue a fresh stock push for every mapped product',
                             '为所有已匹配商品排队推送库存')) + '">' +
        esc(cuT('Push all stock', '推送全部库存')) + '</button></div>';
      tiles.innerHTML =
        tile(cuT('Live on Eleme', '已上架饿了么'), live, per('live'), false) +
        tile(cuT('Need attention', '待处理'), att,
             cuT('unmatched, or missing a size', '未匹配，或未选规格'), att > 0) +
        tile(cuT('Stock updates waiting', '待推送库存'), waiting, perWaiting, false, pushBtn);
    }

    // One line per store: state, catalogue freshness, and the one action that
    // unblocks it. Replaces the single notice — a notice could only ever show
    // the FIRST unwell store, and it said nothing at all about a healthy one.
    const lines = document.getElementById('el-storelines');
    if (lines) {
      lines.innerHTML = rows.map(st => {
        const what = EL_BLOCK_TXT[st.blockedBy] || ['is not syncing', '同步已停'];
        // The name and size pickers read the cached catalogue, so how fresh it
        // is belongs on the store it belongs to.
        const cat = st.catalogueCount
          ? cuT(st.catalogueCount + ' listings read', '已读取 ' + st.catalogueCount + ' 个商品') +
            (st.catalogueAt ? ' · ' + fmtAgo(st.catalogueAt) : '')
          : cuT('no catalogue read yet, so nothing can be matched here',
                '尚未读取商品目录，无法匹配');
        let state, cls;
        if (st.blocked) {
          state = cuT(what[0], what[1]) + ' · ' + cat;
          cls = ' att';
        } else {
          const n = Number(st.pending || 0) + Number(st.processing || 0);
          state = (n ? cuT(n + ' stock updates waiting', n + ' 条库存待推送')
                     : cuT('Up to date', '已是最新')) + ' · ' + cat;
          cls = '';
        }
        // The one action that unblocks it. Linking a shop id is a field; signing
        // in needs a human at a browser on the box, so that one is the command.
        const act = !st.blocked ? ''
          : st.blockedBy === 'no_shop'
            ? '<input id="el-shop-' + st.id + '" class="shopinp" placeholder="' +
                esc(cuT('Eleme shop id', '饿了么店铺ID')) + '">' +
              '<button class="btn btn-sm btn-primary" onclick="elSetShop(' + st.id + ", '" + esc(st.code) + "')\">" +
                esc(cuT('Link shop', '关联店铺')) + '</button>'
            : '<code class="el-cmd">node scripts/eleme-login.js ' + esc(st.code) + ' ' + esc(st.shopId || '') + '</code>';
        return '<div class="el-storeline' + cls + '">' +
            '<span class="dot"></span><span class="nm">' + esc(elStoreName(st)) + '</span>' +
            '<span class="st">' + esc(state) + '</span>' + act +
          '</div>';
      }).join('');
    }
  }

  // Needs attention: not mapped anywhere, or mapped to a listing that holds
  // several options with none claimed — on Eleme an option CAN be targeted, so
  // that second case is a real gap, not a note.
  function elNeedsAttention(p) {
    const maps = Object.values(p.stores || {});
    if (!maps.some(m => m.eleme_name)) return true;
    // A name no listing carries is attention too, or the amber dot the list
    // draws for it would not be counted by the chip that claims to count
    // amber dots.
    if (Object.keys(p.stores || {}).some(code => elNameBad(p.stores[code], code))) return true;
    return maps.some(m => m.eleme_name && Number(m.specCount || 0) > 1 && !elClaims(m).length);
  }

  // -- Chip + store filters ---------------------------------------------------
  const EL_CHIPS = [
    { id: 'all',  en: 'All',            cn: '\u5168\u90e8' },
    { id: 'att',  en: 'Needs attention', cn: '\u5f85\u5904\u7406' },
    { id: 'ok',   en: 'Synced',          cn: '\u5df2\u540c\u6b65' },
    { id: 'size', en: 'Needs an option', cn: '\u5f85\u9009\u89c4\u683c' },
    // The mappings holding a name Eleme has never heard of, in one click.
    // Only the ones we can prove: a store whose catalogue has not been read
    // contributes nothing to this count.
    { id: 'bad',  en: 'Name not in catalogue', cn: 'Name not in catalogue' },
  ];

  function elChipMatch(p, id) {
    const maps = Object.values(p.stores || {});
    if (id === 'att')  return elNeedsAttention(p);
    if (id === 'ok')   return maps.some(m => m.eleme_name);
    if (id === 'size') return maps.some(m => m.eleme_name && Number(m.specCount || 0) > 1 && !elClaims(m).length);
    if (id === 'bad')  return Object.keys(p.stores || {}).some(code => elNameBad(p.stores[code], code));
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
        '>' + esc(elStoreName(s2)) + '</option>').join('');
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
    elRenderProducts(); // re-render so the name input picks up list= now that options exist
  };

  // ── Strings still awaiting a Chinese source ─────────────────────────
  // §30 rule 3 and docs/tacet-delivery-vocabulary.md Rule 4 say the same thing:
  // copy from the source, never compose. That holds for our own Chinese too.
  // None of the four below exists as a pair anywhere in this repo or in the
  // locked vocabulary, so they run English-only on both sides until they are
  // sourced. They are tabled as a request in that document, under "Channel
  // mapping - awaiting a Chinese source"; filling the CN column there is four
  // edits here, and Meituan's MT_PENDING_CN carries the same keys:
  //
  //   EL_PENDING_CN.notInCat   'Name not in catalogue'
  //   EL_PENDING_CN.notChecked 'Name not checked'
  //   EL_PENDING_CN.pickIt     'This name matches no listing on this store. Pick one from the list.'
  //   EL_PENDING_CN.reverted   'Not in the catalogue — not saved.'
  //
  // Every other string on this change reuses a pair that already exists:
  // 'No matches' / '无匹配', 'Remove' / '移除', and the catalogue-not-read
  // sentence already on this screen.
  const EL_PENDING_CN = {
    notInCat:   'Name not in catalogue',
    notChecked: 'Name not checked',
    pickIt:     'This name matches no listing on this store. Pick one from the list.',
    reverted:   'Not in the catalogue — not saved.',
  };

  // ── The catalogue as the only source of a listing name ────────────────
  // The field used to be free text with a datalist beside it, which suggests
  // and constrains nothing: a single character typed into product 80 saved,
  // and the push path then matched it loosely onto a different product's
  // listing. A name is now accepted only when it is one of these strings.
  //
  // Exact, not fuzzy, and deliberately NOT a check on how the value arrived:
  // no browser reports a datalist pick reliably, and a pasted name that is
  // right is right. What matters is that the string came from Eleme.
  function elCatalogueRows(storeCode) {
    return (_catalogue[storeCode] && _catalogue[storeCode].rows) || [];
  }

  // Whether the catalogue has been read at all. Nothing about a stored name
  // can be said before this is true — see elStoreState.
  function elCatalogueRead(storeCode) {
    return elCatalogueRows(storeCode).length > 0;
  }

  // Exact match against a real listing name. Trimmed on both sides because
  // that is what elSpecsFor already keys on; byte-exact otherwise, which is
  // the point — one capital letter was enough to fail every push for two days.
  function elNameKnown(storeCode, name) {
    const key = String(name || '').trim();
    if (!key) return false;
    return elCatalogueRows(storeCode).some(r => String(r.name || '').trim() === key);
  }

  // A stored name we can positively say is wrong: the catalogue has been read,
  // and this is not in it. An unread catalogue is not evidence of anything.
  function elNameBad(map, storeCode) {
    return !!(map && map.eleme_name && elCatalogueRead(storeCode) &&
              !elNameKnown(storeCode, map.eleme_name));
  }

  // How many listings the dropdown is showing for what has been typed.
  // Case-insensitive substring, because that is what the browser's own
  // datalist does — a different rule here would count one thing while the
  // list in front of the operator showed another.
  function elMatchCount(storeCode, typed) {
    const q = String(typed || '').trim().toLowerCase();
    if (!q) return -1;                       // nothing typed: nothing to say
    return elCatalogueRows(storeCode)
      .filter(r => String(r.name || '').toLowerCase().includes(q)).length;
  }

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
      elRenderPushLog(r.recentStock || []);
      elRenderLog(r.recentSystem || []);
    } catch (e) {}
  };

  // Per-product push results (success/fail) — the backend has always returned
  // this (recentStock on /eleme/status), nothing rendered it. Resolves
  // product_id against the already-loaded _products list for a readable name;
  // falls back to the SKU/raw id when the product list hasn't loaded yet.
  // Same fix as Meituan's mtLocalTime: created_at is a bare UTC string out of
  // SQLite, and slicing it straight showed UTC as if it were local time.
  function elLocalTime(utcStr) {
    if (!utcStr) return '';
    const d = new Date(String(utcStr).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return String(utcStr).slice(5, 16);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    return get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  }

  function elRenderPushLog(rows) {
    const box = document.getElementById('el-log-stock');
    if (!box) return;
    if (!rows.length) { box.innerHTML = `<span class="empty">${cuT('Nothing yet', '暂无记录')}</span>`; return; }
    box.innerHTML = rows.map(r => {
      const t = elLocalTime(r.created_at);
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
      const t = elLocalTime(r.created_at);
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
        // Which product holds each option, so a row can say whose it is instead
        // of letting two products quietly push at one stock box.
        _optionOwners = r.optionOwners || {};
      elRenderProducts();
      elRenderHead();  // counts only exist now
      elRenderChips();
    } catch (e) {}
  };

  window.elFilterProducts = function () { elRenderProducts(); };

  // The visible stores, honouring the store filter.
  function elShownStores() {
    return _stores.filter(st => !_elStore || st.code === _elStore);
  }

  // One dot column per visible store, named after the store. Built from the
  // store list so N stores work, and repainted on a language flip like
  // everything else the JS writes.
  function elRenderListHead() {
    const box = document.getElementById('el-lh-stores');
    if (!box) return;
    box.innerHTML = elShownStores().map(st => '<span>' + esc(elStoreName(st)) + '</span>').join('');
  }

  // ── One product, one store: the state, in one word ──────────────────────────
  // The list draws it as a dot and nothing else; the panel draws the same state
  // with its word beside it. Both read this, so a dot and its explanation can
  // never disagree.
  //
  // Every store on Eleme is matched by hand — there are no article numbers — so
  // a missing name is always WORK here. On the Meituan page one store links
  // itself by 货号 and "not linked" there is a fact rather than a job; this page
  // has no such case, which is why every state below is amber or better.
  // A store with no Eleme shop linked yet cannot hold a mapping at all. Without
  // this its column reads "Add name" on EVERY product — 198 amber dots for one
  // missing shop id, which is the noise this page was rebuilt to stop. The
  // store's own line already says what it needs; the products stay quiet.
  // Signed-out is deliberately NOT this case: that store has a shop, its
  // mappings are real, and a missing name there is still work.
  function elStoreConnected(code) {
    const st = _stores.find(x => x.code === code);
    return !!(st && st.shop_id && String(st.shop_id).trim());
  }

  function elStoreState(map, storeCode) {
    if (storeCode && !elStoreConnected(storeCode)) {
      return { k: 'none', t: cuT('Store not connected', '门店未关联') };
    }
    if (!map || !map.eleme_name) return { k: 'att', t: cuT('Add name', '待填名称') };

    // Both name checks sit BEFORE the switch, on purpose. A name that matches
    // no listing is wrong whether or not pushing is on, and four of the five
    // known-bad mappings found on 2026-08-25 are switched off - reading those
    // as 'Sync off' describes the switch and hides the defect. Product 195 is
    // the same fault the other way round: name set, switch on, one size, so
    // this function called it 'Synced' while every push since 23 August
    // resolved to nothing.
    if (!elCatalogueRead(storeCode)) {
      // The check cannot run, so it says so, and never that all is well.
      // Neutral rather than amber: an unread catalogue is one fact about the
      // STORE, already stated on the store's own line, and amber here would
      // repeat it as a warning dot on every product - the noise this page was
      // rebuilt to stop. Quiet in the list, explicit in the panel.
      return { k: 'none', t: cuT(EL_PENDING_CN.notChecked, EL_PENDING_CN.notChecked) };
    }
    if (!elNameKnown(storeCode, map.eleme_name)) {
      return { k: 'att', t: cuT(EL_PENDING_CN.notInCat, EL_PENDING_CN.notInCat) };
    }
    if (Number(map.sync_enabled) !== 1) return { k: 'off', t: cuT('Sync off', '已关闭') };
    // A listing with several sizes and none picked cannot be pushed accurately
    // — the driver falls back to a rule that writes a made-up number to every
    // size. That is the one state worth colouring.
    if (Number(map.specCount || 0) > 1 && !elClaims(map).length) {
      return { k: 'att', t: cuT('Pick an option', '待选规格') };
    }
    return { k: 'ok', t: cuT('Synced', '已同步') };
  }

  // The rows the filters leave standing, in list order. The panel and the list
  // both need this set — the panel to know whether its product is still on
  // screen, the list to draw it — so it is worked out once.
  function elVisibleList() {
    // Text match covers the SKU and the mapped listing name too — the two
    // things you actually have in front of you when hunting a row.
    const q = (document.getElementById('el-search')?.value || '').trim().toLowerCase();
    return _products
      .filter(p => Number(p.is_active) !== 0)
      .filter(p => elChipMatch(p, _elFilter))
      .filter(elStorePass)
      .filter(p => !q
        || (p.name_cn || '').toLowerCase().includes(q)
        || (p.name_en || '').toLowerCase().includes(q)
        || (p.sku || '').toLowerCase().includes(q)
        || Object.values(p.stores || {}).some(m => (m.eleme_name || '').toLowerCase().includes(q)));
  }

  function elRenderProducts() {
    const body = document.getElementById('el-list-body');
    if (!body) return;
    const rows = elVisibleList();

    const cnt = document.getElementById('el-count');
    if (cnt) cnt.textContent = String(_products.filter(p => Number(p.is_active) !== 0).length || '');
    elRenderHead();
    elRenderChips();
    elRenderListHead();

    // The panel always holds a product while there is one to hold: an operator
    // who filters down to "Needs a size" should land on the first thing that
    // needs them, not on an empty panel with one more click to make.
    if (!rows.some(p => p.id === _elSel)) _elSel = rows.length ? rows[0].id : null;

    if (!rows.length) {
      body.innerHTML = '<div class="el-empty">' + cuT('Nothing here.', '暂无商品。') + '</div>';
      elRenderPanel();
      return;
    }

    const shown = elShownStores();
    body.innerHTML = rows.map(p => {
      const base = cuT(p.name_en || p.name_cn, p.name_cn || p.name_en);
      const thumb = p.image
        ? '<img class="el-thumb" loading="lazy" src="' + esc(p.image) + '" alt="">'
        : '<span class="el-thumb-ph"></span>';

      // One dot per store, in the order the header names them. A dot carries
      // its store and its state as the row's accessible name, so the list is
      // readable without the colour.
      const say = [];
      const dots = shown.map(st => {
        const s2 = elStoreState((p.stores || {})[st.code], st.code);
        say.push(elStoreName(st) + ' ' + s2.t);
        return '<span class="el-dcell"><span class="el-dot ' + s2.k + '" title="' +
          esc(elStoreName(st) + ' · ' + s2.t) + '"></span></span>';
      }).join('');

      return '<button type="button" class="el-lrow' + (p.id === _elSel ? ' sel' : '') + '"' +
        ' data-pid="' + p.id + '" onclick="elSelect(' + p.id + ')"' +
        ' aria-label="' + esc(base + (p.sku ? ' ' + p.sku : '') + ' · ' + say.join(' · ')) + '">' +
        // The SKU is a sibling of the name, not inside it: it is what an
        // operator searches by, and inside the name it would be the first thing
        // the ellipsis ate.
        '<span class="el-pcell">' + thumb +
        '<span class="el-pname">' + esc(base) +
          (p.variant_label ? ' <span class="vl">· ' + esc(p.variant_label) + '</span>' : '') + '</span>' +
        (p.sku ? '<span class="el-psku">' + esc(p.sku) + '</span>' : '') + '</span>' +
        '<span class="el-dots">' + dots + '</span></button>';
    }).join('');

    elRenderPanel();
  }

  // Picking a row moves the panel, nothing else. `focusName` is the click path:
  // landing on a product with no listing name yet puts the cursor in the first
  // empty field, so filling names is click-type-click-type with no reach for
  // the mouse in between. A repaint (a save, a poll, a language flip) never
  // steals focus, because it does not come through here.
  window.elSelect = function (pid, focusName) {
    _elSel = Number(pid);
    document.querySelectorAll('#el-list-body .el-lrow').forEach(el => {
      el.classList.toggle('sel', Number(el.dataset.pid) === _elSel);
    });
    elRenderPanel();
    if (focusName !== false) {
      const empty = document.querySelector('#el-panel .el-name-input[value=""]');
      if (empty) empty.focus();
    }
  };

  // ── The panel — every field, once ───────────────────────────────────────────
  // Everything that used to be repeated on every row lives here for the one
  // product in front of you: the listing name, the size picker, the sync
  // switch, the push footnote — and the sentence about how Eleme matching
  // works, which used to be a standing disclosure above the whole table and now
  // appears only on a product that has not been matched yet.
  function elRenderPanel() {
    const panel = document.getElementById('el-panel');
    if (!panel) return;
    const p = _products.find(x => x.id === _elSel);
    // No product means no ROWS — the list auto-selects whenever it has any — so
    // the panel goes away rather than sitting there as an empty card telling
    // you to pick something the list has already said it does not have.
    if (!p) { panel.hidden = true; panel.innerHTML = ''; return; }
    panel.hidden = false;

    const base = cuT(p.name_en || p.name_cn, p.name_cn || p.name_en);
    const alt  = cuT(p.name_cn || '', p.name_en || '');
    const thumb = p.image
      ? '<img class="el-thumb" loading="lazy" src="' + esc(p.image) + '" alt="">'
      : '<span class="el-thumb-ph"></span>';

    panel.innerHTML =
      '<div class="el-ptop">' + thumb + '<div class="el-pttl">' +
        '<div class="el-pname">' + esc(base) +
          (p.variant_label ? ' <span class="vl">· ' + esc(p.variant_label) + '</span>' : '') + '</div>' +
        (alt && alt !== base ? '<div class="el-pmeta">' + esc(alt) + '</div>' : '') +
        (p.sku ? '<div class="el-pmeta num">' + esc(p.sku) + '</div>' : '') +
      '</div></div>' +
      elShownStores().map(st => elPanelStore(p, st)).join('');
  }

  // One store's block. Every store on Eleme is matched by hand, so every block
  // is editable — there is no read-only twin the way the Meituan page has one.
  function elPanelStore(p, st) {
    const m      = (p.stores || {})[st.code] || {};
    const s2     = elStoreState(m, st.code);
    const on     = Number(m.sync_enabled) === 1;
    const name   = m.eleme_name || '';
    const specs  = elSpecsFor(st.code, name);
    const claims = elClaims(m);
    const cached = ((_catalogue[st.code] || {}).rows || []).length;

    if (!elStoreConnected(st.code)) {
      return '<div class="el-pblock">' +
        '<div class="el-pbh"><span class="nm">' + esc(elStoreName(st)) + '</span></div>' +
        '<div class="el-pstate"><span class="el-dot ' + s2.k + '"></span>' + esc(s2.t) + '</div>' +
        '<div class="el-sub">' + esc(cuT('Nothing can be matched here until this store has an Eleme shop linked — the store line above the tabs takes the shop id.',
                                         '关联饿了么店铺后才能在此匹配 — 请在上方门店行填写店铺ID。')) + '</div>' +
        '</div>';
    }

    const toggle = '<label class="toggle-label" title="' + esc(cuT('Sync on / off', '同步开关')) + '">' +
      '<input type="checkbox" ' + (on ? 'checked' : '') +
      ' onchange="elToggleSync(' + p.id + ', ' + st.id + ", '" + esc(st.code) + "', this.checked)\"></label>";

    // The name field is a picker over the real catalogue, and only a value
    // from it is ever stored. It USED to be plain free text with a datalist
    // beside it - a datalist suggests and constrains nothing - and the comment
    // that stood here claimed otherwise. A single character typed into product
    // 80 saved, and the push path then matched it loosely onto a different
    // product's listing. elNameCommit below is what makes the claim true.
    //
    // Labelled, so no placeholder - the placeholder used to BE the label on the
    // table, and keeping both says the same words twice. The Remove action is
    // beside the label rather than under the field: it appears only when there
    // is a name to remove, and emptying the field by hand cannot do its job
    // (an empty field is not a catalogue value, so it reverts like any other).
    const nameArgs = 'this, ' + p.id + ', ' + st.id + ", '" + esc(st.code) + "'";
    let body =
      '<div class="el-pbh"><span class="nm">' + esc(elStoreName(st)) + '</span>' + toggle + '</div>' +
      '<div class="el-pstate"><span class="el-dot ' + s2.k + '"></span>' + esc(s2.t) + '</div>' +
      '<div class="el-plbl el-plbl-row">' +
        '<span>' + esc(cuT('Eleme listing name', '饿了么商品名')) + '</span>' +
        (name
          ? '<button type="button" class="el-plink" onclick="elRemoveName(' + p.id + ', ' + st.id +
            ", '" + esc(st.code) + "')\">" + esc(cuT('Remove', '移除')) + '</button>'
          : '') +
      '</div>' +
      '<input type="text" class="el-name-input" data-no-i18n' +
        ' list="el-catalogue-dl-' + esc(st.code) + '"' +
        ' value="' + esc(name) + '"' +
        ' oninput="elNameTyped(' + nameArgs + ')"' +
        ' onchange="elNameCommit(' + nameArgs + ')"' +
        ' onblur="elNameCommit(' + nameArgs + ')"' +
        ' onkeydown="elNameKey(event)">' +
      // Filled by elNameTyped as the operator types. Empty on paint: a count
      // of what matches is only worth saying once there is something to match
      // against, and the zero case is the only one it says out loud.
      '<div class="el-sub el-hint" id="el-hint-' + st.id + '"></div>';

    // One-time help, on the products that need it rather than standing above
    // the whole page: Eleme listings carry no article number, so the name IS
    // the match and it has to be the exact one.
    if (!name) {
      body += '<div class="el-sub">' + esc(cached
        ? cuT('Eleme listings have no article number, so the name is the match — pick one of the ' +
              cached + ' read from this store.',
              '饿了么商品没有货号,只能按商品名精确匹配 — 请从该门店已读取的 ' + cached + ' 个商品中选择。')
        : cuT('No catalogue has been read from this store yet, so there is nothing to pick from.',
              '尚未读取该门店的商品目录,暂无可选项。')) + '</div>';
    } else if (!cached) {
      // A name is stored and there is nothing to check it against. Say that,
      // and say nothing at all about whether it is right - the same sentence
      // the store line already uses for the same fact, so the two agree.
      body += '<div class="el-sub">' + esc(cuT(
        'no catalogue read yet, so nothing can be matched here',
        '尚未读取商品目录，无法匹配')) + '</div>';
    } else if (!elNameKnown(st.code, name)) {
      // The one case the screen could not say before: a stored name that no
      // listing on this store carries. It read as 'Synced' on product 195
      // for two days. Nothing is corrected or cleared here - the picker is
      // right above, and which listing this product is remains a person's
      // call.
      body += '<div class="el-sub el-bad">' +
        esc(cuT(EL_PENDING_CN.pickIt, EL_PENDING_CN.pickIt)) + '</div>';
    }

    // Which options of the listing this product is, and how many units each one
    // sells. A listing can hold several: sometimes different products behind one
    // name (the hand soap's scents, one option each), sometimes the SAME product
    // in packs (1瓶 / 3瓶 / 6瓶 of one bottle, all three this product's). Every
    // option has its own stock box on Eleme, so an unclaimed one keeps whatever
    // number the merchant first typed and sells without limit.
    if (specs.length > 1) {
      const owners = _optionOwners[st.code] || {};
      body +=
        '<div class="el-plbl">' +
          esc(cuT('Which options is this product?', '这是该商品的哪些规格？')) + '</div>' +
        '<div class="el-opts">' + specs.map((sp, i) => {
          const id    = String(sp.specGlobalId);
          const mine  = claims.find(c => String(c.spec_key) === id);
          const owner = owners[id];
          const other = owner && Number(owner.product_id) !== Number(p.id) ? owner : null;
          const args  = p.id + ', ' + st.id + ", '" + esc(st.code) + "', '" + esc(id) + "', '" +
                        esc(sp.name || elSpecLabel(sp, i)) + "'";
          return '<label class="el-opt' + (mine ? ' on' : '') + (other ? ' taken' : '') + '">' +
            '<input type="checkbox" ' + (mine ? 'checked' : '') + (other ? ' disabled' : '') +
              ' onchange="elClaimOption(' + args + ', this.checked)">' +
            '<span class="el-opt-nm" data-no-i18n>' + esc(elSpecLabel(sp, i)) + '</span>' +
            (other
              ? '<span class="el-opt-by">' + esc(cuT('claimed by another product', '已被其他商品占用')) + '</span>'
              : '<span class="el-opt-u">' +
                  '<input type="number" min="1" step="1" class="el-units"' +
                    (mine ? '' : ' disabled') +
                    ' value="' + (mine ? Number(mine.units_per_pack) || 1 : 1) + '"' +
                    ' onchange="elSetUnits(' + args + ', this.value)">' +
                  esc(cuT('units', '份')) +
                '</span>') +
            '</label>';
        }).join('') + '</div>';

      // One-time help, on the products that need it: the unit count is the whole
      // point of the list and there is nothing on screen that explains it.
      if (!claims.length) {
        body += '<div class="el-sub">' +
          esc(cuT('Tick every option this product is sold as. "Units" is how many of it one sale takes ' +
                  '— a 3-bottle option is 3.',
                  '勾选该商品在售的所有规格。「份」是每卖出一份消耗的数量 — 三瓶装填 3。')) + '</div>';
      }
    } else if (name && Number(m.specCount || 0) > 1 && !cached) {
      // The state says "Pick a size" off the server's count, but the sizes
      // themselves come from the cached catalogue — say that rather than show
      // an empty picker.
      body += '<div class="el-sub">' +
        esc(cuT('This listing holds several sizes, but no catalogue has been read from this store yet, ' +
                'so there is no size to pick.',
                '该商品有多个规格,但尚未读取该门店的商品目录,暂无可选规格。')) + '</div>';
    }

    // What each claimed option last took. With one claim this is the old single
    // line; with several, one line each — a shared "last pushed" would be the
    // first box's number standing in for all of them.
    const pushed = claims.filter(c => c.last_pushed_at);
    if (pushed.length > 1) {
      body += pushed.map(c => '<div class="el-pfact" data-no-i18n>' +
        esc((c.spec_name || '') + ' · ' + (c.last_pushed_qty != null ? c.last_pushed_qty + ' · ' : '') +
            (fmtAgo(c.last_pushed_at) || '')) + '</div>').join('');
    } else if (m.last_pushed_at) {
      body += '<div class="el-pfact">' +
        esc(cuT('Last', '上次') + ' ' + (m.last_pushed_qty != null ? m.last_pushed_qty + ' · ' : '') +
            (fmtAgo(m.last_pushed_at) || '')) + '</div>';
    }

    return '<div class="el-pblock">' + body + '</div>';
  }

  window.elToggleSync = async function (productId, storeId, storeCode, on) {
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    try {
      // Pass the existing eleme_name through — the map POST upserts the whole
      // row, so omitting it here would silently null out an override the
      // operator already set (elSetElemeName below has the matching problem
      // in reverse).
      //
      // Off now KEEPS the row and clears sync_enabled; it used to DELETE it,
      // throwing away the listing name and the chosen size with it. The daemon
      // pushes on sync_enabled = 1, so both spellings stop the pushing — only
      // one of them also discards what the operator typed. In the panel the
      // switch sits right beside that name, which is exactly where losing it
      // would be hardest to explain.
      await api('/api/retail-admin/eleme/products/' + productId + '/map', {
        method: 'POST',
        // No option fields: they live on the claims now, and /map writes the
        // switch across every one of them.
        body: { storeId, storeCode, syncEnabled: on ? 1 : 0,
                elemeName: (cur && cur.eleme_name) || null },
      });
      // Reflect locally without a full reload.
      if (p) {
        p.stores = p.stores || {};
        p.stores[storeCode] = { ...(cur || {}), sync_enabled: on ? 1 : 0 };
      }
      // repaint: the "no size picked" warning only applies once sync is on
      elRenderProducts();
    } catch (e) { elLoadProducts(); }
  };

  // -- The gate: only a catalogue value ever reaches the field ----------------
  // What the field must revert TO, read back from the loaded products rather
  // than stashed on the element: a repaint between paint and blur cannot then
  // make the two disagree.
  function elStoredName(productId, storeCode) {
    const p = _products.find(x => x.id === Number(productId));
    const m = p && (p.stores || {})[storeCode];
    return (m && m.eleme_name) || '';
  }

  window.elNameKey = function (e) { if (e && e.key === 'Enter') e.target.blur(); };

  // Typing filters the browser's own dropdown and does nothing else - it never
  // sets the stored value. The one thing it writes is the line under the field,
  // and only when the filter has come up empty: typing four matches and typing
  // zero matches used to look identical, and zero is the answer that matters.
  // It is the true answer for a product that is not on Eleme at all.
  //
  // A count when there ARE matches is left unsaid; they are on screen already.
  window.elNameTyped = function (input, productId, storeId, storeCode) {
    const hint = document.getElementById('el-hint-' + storeId);
    if (!hint) return;
    const n = elMatchCount(storeCode, input.value);
    // -1 is an empty field: nothing typed, so nothing to report either way.
    hint.textContent = n === 0 ? cuT('No matches', '\u65e0\u5339\u914d') : '';
    hint.classList.toggle('el-bad', n === 0);
  };

  // The gate. Every save goes through here, and a value that is not in the
  // catalogue is not stored - it is put back to what the field held.
  //
  // Reverting rather than emptying is the point. Emptying trades a wrong-name
  // fault for a missing-name fault: the product quietly stops syncing and
  // nothing anywhere says so, which is the harder of the two to notice. The
  // good value stays; only the typing is discarded.
  //
  // Runs on change AND on blur, because neither alone covers every way a field
  // is left. `busy` is what stops the pair double-saving: change fires first,
  // blur follows before the await settles, and finds the flag set.
  window.elNameCommit = async function (input, productId, storeId, storeCode) {
    if (input.dataset.busy) return;
    const typed  = input.value.trim();
    const stored = elStoredName(productId, storeCode);
    if (typed === stored) { elNameTyped(input, productId, storeId, storeCode); return; }

    // An empty field is not a catalogue value either, so it reverts like any
    // other non-match. Unmapping is the Remove action beside the label, which
    // asks first - a stray backspace should not be able to stop a product
    // syncing.
    if (!typed || !elNameKnown(storeCode, typed)) {
      input.value = stored;
      const hint = document.getElementById('el-hint-' + storeId);
      if (hint) {
        hint.textContent = cuT(EL_PENDING_CN.reverted, EL_PENDING_CN.reverted);
        hint.classList.add('el-bad');
      }
      return;
    }

    input.dataset.busy = '1';
    try { await elSetElemeName(productId, storeId, storeCode, typed); }
    finally { delete input.dataset.busy; }
  };

  // Unmapping, on purpose and out loud. The confirm exists because removing a
  // name stops this product pushing to Eleme, which is exactly the silent
  // failure the revert above refuses to cause by accident.
  window.elRemoveName = async function (productId, storeId, storeCode) {
    const stored = elStoredName(productId, storeCode);
    if (!stored) return;
    const label = cuT('Remove', '\u79fb\u9664');
    if (!(await askConfirm({ title: label, body: stored, confirmLabel: label, danger: true }))) return;
    await elSetElemeName(productId, storeId, storeCode, '');
  };

  // Save a product's Eleme listing-name override for one store.
  //
  // Reached only through elNameCommit and elRemoveName above, never from the
  // field directly: by the time a name arrives here it is either one of the
  // catalogue's own strings or empty. Note it already leaves sync_enabled
  // exactly where it was - a new mapping starts off, and correcting a name
  // has never been able to start pushing. Meituan's mtSaveMap sent 1 and now
  // matches this.
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
        // An option belongs to one listing, so pointing at a different listing
        // drops every claim (the server does the same) — then repaint, because
        // the new listing has its own options to offer.
        const kept = (cur && cur.eleme_name) === (name || null);
        p.stores[storeCode] = {
          ...(cur || {}),
          eleme_name: name || null,
          claims:    kept ? elClaims(cur) : [],
          spec_id:   kept ? (cur && cur.spec_id)   || null : null,
          spec_name: kept ? (cur && cur.spec_name) || null : null,
          sync_enabled: cur ? Number(cur.sync_enabled) : 0,
        };
        if (!kept) {
          const owners = _optionOwners[storeCode] || {};
          for (const k of Object.keys(owners)) {
            if (Number(owners[k].product_id) === Number(productId)) delete owners[k];
          }
        }
      }
      elRenderProducts();
      if (window.toast) toast(cuT('Saved', '已保存'));
    } catch (e) { elLoadProducts(); }
  };

  // A product's claims on this store, oldest first. The API sends them on the
  // map entry; older payloads (a page left open across a deploy) have none, so
  // fall back to the single pick they did carry.
  function elClaims(m) {
    if (!m) return [];
    if (Array.isArray(m.claims)) return m.claims.filter(c => c && c.spec_key);
    return m.spec_id ? [{ spec_key: String(m.spec_id), spec_id: m.spec_id, spec_name: m.spec_name, units_per_pack: 1 }] : [];
  }

  // Claim one option of the listing for this product, or release it.
  //
  // One Eleme listing can hold several options behind one name and each has its
  // own stock box. Until this existed a product could point at ONE of them, so a
  // multipack's other boxes kept the number the merchant first typed (9999 at
  // 天河) and sold without limit, while two products sharing a listing overwrote
  // each other every cycle. Like the name field it does NOT touch sync_enabled —
  // the switch stays the only way to turn pushing on.
  window.elClaimOption = async function (productId, storeId, storeCode, specId, specName, on) {
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    const claims = elClaims(cur);
    const units = on ? (Number(elUnitsInput(specId)) || 1) : 1;
    try {
      const r = await api('/api/retail-admin/eleme/products/' + productId + '/claim', {
        method: 'POST',
        body: { storeId, storeCode, elemeName: (cur && cur.eleme_name) || null,
                specId, specName, units, on: !!on },
      });
      if (p && cur) {
        const next = claims.filter(c => String(c.spec_key) !== String(specId));
        if (on) next.push({ spec_key: String(specId), spec_id: specId, spec_name: specName,
                            units_per_pack: (r && r.units) || units });
        p.stores[storeCode] = { ...cur, claims: next };
        const owners = _optionOwners[storeCode] = _optionOwners[storeCode] || {};
        if (on) owners[String(specId)] = { product_id: productId, eleme_name: cur.eleme_name };
        else delete owners[String(specId)];
      }
      elRenderProducts();
      if (window.toast) toast(cuT('Saved', '已保存'));
    } catch (e) {
      // A 409 means another product already holds it. The page thought otherwise,
      // so reload rather than leave a tick that isn't real.
      if (window.toast) toast(cuT('That option belongs to another product.', '该规格已被其他商品占用。'), 'error');
      elLoadProducts();
    }
  };

  // How many units of this product one sale of the option takes. Typed, not read
  // off the option name: the catalogue writes the same thing three ways (X3, *2,
  // 3-260X2), and a number guessed wrong here silently multiplies every future
  // deduction.
  window.elSetUnits = async function (productId, storeId, storeCode, specId, specName, value) {
    const units = Math.max(1, parseInt(value, 10) || 1);
    const p = _products.find(x => x.id === productId);
    const cur = p && (p.stores || {})[storeCode];
    try {
      await api('/api/retail-admin/eleme/products/' + productId + '/claim', {
        method: 'POST',
        body: { storeId, storeCode, elemeName: (cur && cur.eleme_name) || null,
                specId, specName, units, on: true },
      });
      if (p && cur) {
        p.stores[storeCode] = { ...cur, claims: elClaims(cur).map(c =>
          String(c.spec_key) === String(specId) ? { ...c, units_per_pack: units } : c) };
      }
      elRenderProducts();
      if (window.toast) toast(cuT('Saved', '已保存'));
    } catch (e) { elLoadProducts(); }
  };

  // The units box sits beside the checkbox, so ticking one reads the number the
  // operator already typed rather than resetting it to 1.
  function elUnitsInput(specId) {
    const el = document.querySelector('#el-panel .el-opt input[onchange*="' + specId + '"].el-units');
    return el ? el.value : 1;
  }

  window.elPushAll = async function () {
    const btn = document.getElementById('el-pushall-btn');
    if (btn) { btn.disabled = true; btn.textContent = cuT('Queuing…', '排队中…'); }
    try {
      const r = await api('/api/retail-admin/eleme/push-all', { method: 'POST' });
      if (window.toast) toast(cuT(`Queued ${r.queued} product(s)`, `已排队 ${r.queued} 个商品`));
      elLoadStatus();
    } catch (e) {} finally {
      if (btn) { btn.disabled = false; btn.textContent = cuT('Push all stock', '推送全部库存'); }
    }
  };

  // ── util ──────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
