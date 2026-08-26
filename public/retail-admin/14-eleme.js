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
  // storeCode -> Set of the exact listing names that store supplied. Built once
  // with the catalogue rather than scanned per row: every product asks whether
  // its stored name is one of these on every repaint.
  let _catNames  = {};

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
    // One classifier for the tiles, the chips and the dots, so no two of them
    // can report different numbers about the same rows.
    const grp = { att: 0, ok: 0, nomap: 0 };
    for (const p of active) grp[elGroup(p)]++;
    const live = grp.ok;
    const att  = grp.att;
    const waiting = rows.reduce((a2, r) => a2 + Number(r.pending || 0) + Number(r.processing || 0), 0);
    // Per store, from that same classifier rather than the server's own count.
    // The server counts mappings with the switch on, which includes the ones
    // resolving to nothing \u2014 that is how a tile reading 191 could sit directly
    // above a sub-line reading 194.
    const perSynced = _stores.filter(s => elStoreConnected(s.code)).map(s =>
      active.filter(p => elStoreState((p.stores || {})[s.code] || null, s.code).k === 'ok').length +
      ' ' + elStoreName(s)).join(' \u00b7 ');
    // Same breakdown the total and the per-store rows use \u2014 pending + processing \u2014
    // so the tile's sub-line never reads lower than a store's own row underneath it.
    const perWaiting = rows.map(r => (Number(r.pending || 0) + Number(r.processing || 0)) + ' ' + elStoreName(r)).join(' \u00b7 ');

    const st = document.getElementById('el-status');
    if (st) {
      // One word per number, and the same word the chip and the tile use. This
      // line said "live" while the chip said "Synced" and the tile said "Live on
      // Eleme" for one figure; three names for one number is how a screen stops
      // being read.
      let html = esc(cuT(live + ' synced', live + ' \u4e2a\u5df2\u540c\u6b65'));
      if (att) html += ' \u00b7 ' + esc(cuT(att + ' need attention', att + ' \u4e2a\u5f85\u5904\u7406'));
      if (grp.nomap) html += ' \u00b7 ' + esc(cuT(grp.nomap + ' not on Eleme', grp.nomap + ' \u4e2a\u672a\u4e0a\u67b6'));
      const bad = rows.filter(r => r.blocked);
      if (bad.length) {
        const nm = bad.map(elStoreName);
        html += ' \u00b7 <span class="att">' +
          esc(cuT(nm.join(', ') + ' needs you', nm.join('\u3001') + ' \u9700\u8981\u5904\u7406')) + '</span>';
      } else if (!att) {
        // Not "all matched" \u2014 47 of them are not matched and never will be.
        html += ' \u00b7 ' + esc(cuT('nothing needs you', '\u65e0\u9700\u5904\u7406'));
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
        tile(cuT('Synced', '已同步'), live, perSynced, false) +
        tile(cuT('Need attention', '待处理'), att,
             cuT('mapped, but not reaching its listing', '已匹配，但对不上商品'), att > 0) +
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

  // ── Which group a product is in ────────────────────────────────────────────
  // The axis is CAN THIS MAPPING REACH THE RIGHT LISTING — not whether the sync
  // switch is on. Three groups, every active product in exactly one, so the
  // chips add up to the list and nothing is hidden or deleted.
  //
  // What this replaced counted a product with NO mapping at all as work: 47 of
  // them — foundation shades, gift sets, things never sold on Eleme — sat in a
  // "needs attention" count that nothing could ever clear, which is §30 rule 5
  // written out as a defect. Worse, the one mapping that was genuinely broken
  // was not in that count at all: it had a name, so it passed both tests, and it
  // showed a green Synced dot for two days while every push it made resolved to
  // nothing. See docs/eleme-findings.md finding 5.
  //
  // The switch deliberately does NOT decide a group. The drain's SELECT carries
  // no sync_enabled clause (scripts/eleme-daemon.js), so the flag is read when a
  // job is QUEUED and never when it is SENT — a row already waiting goes out
  // after the switch is turned off. "Off" is a fact to report beside a mapping,
  // never a reason to stop counting it.
  //
  // A store with no Eleme shop linked holds no group at all: nothing can be
  // matched there, its own store line above already says so, and an alarm nobody
  // can clear is the one that gets ignored.
  function elGroup(p) {
    const states = elStatesFor(p);
    if (states.some(s => s.k === 'att')) return 'att';
    if (states.some(s => s.has)) return 'ok';
    return 'nomap';
  }

  // Every state this product holds on the stores currently shown, connected ones
  // only. The group, the ordering and the row's note all read this, so a dot and
  // the chip counting it can never disagree. It is also what makes the store
  // filter mean something exact: pick a store and the page classifies by that
  // store alone.
  function elStatesFor(p) {
    return elShownStores()
      .filter(st => elStoreConnected(st.code))
      .map(st => elStoreState((p.stores || {})[st.code] || null, st.code));
  }

  // -- Chip filter ------------------------------------------------------------
  // "Needs an option" is folded into Needs attention: it was a strict subset of
  // it, it has read 0 since options could be claimed at all, and the row now
  // prints WHICH problem it has \u2014 which a chip never could.
  //
  // The store filter needs no pass of its own any more. elStatesFor already
  // classifies against the stores on screen, so picking a store re-groups the
  // whole page by that store instead of leaving a second opinion beside it.
  const EL_CHIPS = [
    { id: 'all',   en: 'All',             cn: '\u5168\u90e8' },
    { id: 'att',   en: 'Needs attention', cn: '\u5f85\u5904\u7406' },
    { id: 'ok',    en: 'Synced',          cn: '\u5df2\u540c\u6b65' },
    { id: 'nomap', en: 'Not on Eleme',    cn: '\u672a\u4e0a\u67b6\u9976\u4e86\u4e48' },
  ];

  function elChipMatch(p, id) {
    return id === 'all' ? true : elGroup(p) === id;
  }

  function elRenderChips() {
    const box = document.getElementById('el-chips');
    if (!box) return;
    const active = _products.filter(p => Number(p.is_active) !== 0);
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
        _catNames[s.code]  = new Set((r.data || []).map(x => String(x.name || '').trim()));
      } catch (e) {
        // Empty, not absent: an empty set means "not checkable" to elNameKnown,
        // so a failed catalogue read can never turn every mapping amber.
        _catalogue[s.code] = { rows: [], refreshedAt: null };
        _catNames[s.code]  = new Set();
      }
    }
    elRenderCatalogueDatalists();
    elRenderProducts(); // re-render so the name input picks up list= now that options exist
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

  // Is this listing name one the store actually has? Only the catalogue can
  // answer it, and the catalogue arrives AFTER the products do — so a store with
  // nothing cached returns null, meaning "not checkable", never an accusation.
  // An alarm that cannot be substantiated teaches people to ignore the ones that
  // can, which is the whole reason this page was re-counted.
  function elNameKnown(storeCode, name) {
    const set = _catNames[storeCode];
    if (!set || !set.size) return null;
    return set.has(String(name || '').trim());
  }

  // Ordered by what can go wrong, worst first, and the sync switch is read LAST
  // — it changes what a mapping is doing, never whether it is right.
  function elStoreState(map, storeCode) {
    const has  = !!map;
    const on   = has && Number(map.sync_enabled) === 1;
    const name = (has && map.eleme_name) || '';
    const base = { has, on };

    if (storeCode && !elStoreConnected(storeCode)) {
      return { ...base, k: 'none', t: cuT('Store not connected', '门店未关联') };
    }

    // No mapping row is not a job. The product is not sold here, and it cannot
    // even be queued — the enqueue path needs a row to find one. This read "Add
    // name" for as long as the page existed, and 47 of them buried the ten that
    // were real.
    if (!has) return { ...base, k: 'none', t: cuT('Not on Eleme', '未上架饶了么') };

    // A mapping with no name still pushes. The drain falls back to the product's
    // own Chinese name as the target (scripts/eleme-daemon.js), so this is a live
    // wrong-target risk and not an unfinished form — product 80 sent 25 that way
    // with this exact shape and the switch off.
    if (!name) {
      return { ...base, k: 'att', t: cuT('No listing name', '缺商品名'),
        why: cuT('This mapping has no Eleme listing name. A push falls back to the product’s own name, so it can land on the wrong listing or on none.',
                 '该匹配没有饶了么商品名。推送会退回使用商品自身名称，可能对上错误商品或对不上。') };
    }

    // Nothing validates a stored name at rest, so this is the check that was
    // missing: the name is compared against what the store actually supplied.
    if (elNameKnown(storeCode, name) === false) {
      return { ...base, k: 'att', t: cuT('Listing not found', '找不到该商品'),
        why: cuT('No listing on this store carries this exact name, so every push resolves to nothing. Pick the name from the list rather than typing it.',
                 '该门店没有完全同名的商品，每次推送都会落空。请从列表中选择商品名，不要手动输入。') };
    }

    // A listing with several options and none claimed cannot be pushed
    // accurately — the driver falls back to a rule that writes a made-up number
    // to every one of them.
    if (Number(map.specCount || 0) > 1 && !elClaims(map).length) {
      return { ...base, k: 'att', t: cuT('No option picked', '未选规格'),
        why: cuT('This listing holds several options and this product claims none, so a push would write a made-up number to every one of them.',
                 '该商品有多个规格而本商品未认领任何一个，推送会向每个规格写入编造的数量。') };
    }

    // Right target, switch off. A settled state — and the only one where "off"
    // is the whole story.
    if (!on) return { ...base, k: 'off', t: cuT('Ready, sync off', '已就绪 · 同步关闭') };
    return { ...base, k: 'ok', t: cuT('Synced', '已同步') };
  }

  // Work first, and inside the work the mappings that are pushing right now: a
  // broken mapping with the switch ON is the one telling a customer a wrong
  // number this minute. Product 195 sat behind a green Synced dot for two days
  // while its listing read 10000 against a shelf holding 3; this is the rank
  // that brings that row out at the top instead of eleventh.
  function elRank(p) {
    const att = elStatesFor(p).filter(s => s.k === 'att');
    if (!att.length) return 2;
    return att.some(s => s.on) ? 0 : 1;
  }

  // The rows the filters leave standing. The panel and the list both need this
  // set — the panel to know whether its product is still on screen, the list to
  // draw it — so it is worked out once.
  function elVisibleList() {
    // Text match covers the SKU and the mapped listing name too — the two
    // things you actually have in front of you when hunting a row.
    const q = (document.getElementById('el-search')?.value || '').trim().toLowerCase();
    return _products
      .filter(p => Number(p.is_active) !== 0)
      .filter(p => elChipMatch(p, _elFilter))
      .filter(p => !q
        || (p.name_cn || '').toLowerCase().includes(q)
        || (p.name_en || '').toLowerCase().includes(q)
        || (p.sku || '').toLowerCase().includes(q)
        || Object.values(p.stores || {}).some(m => (m.eleme_name || '').toLowerCase().includes(q)))
      // Stable, so everything at the same rank keeps the list's own order. The
      // array is already a copy — sorting it never touches _products.
      .sort((a, b) => elRank(a) - elRank(b));
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

      // One cell per store, in the order the header names them: the state as a
      // dot, and beside it the sync switch as a read-only twin of the one in the
      // panel. The switch was the single most useful fact about a row and it
      // took a click to see — 53 products were opened one at a time just to read
      // it. Read-only on purpose: flipping sync ON from a list arms the next
      // stock change to push, and one stray click on a broken mapping is exactly
      // how a wrong number reaches a customer. The panel keeps the only switch
      // you can actually throw.
      //
      // Both carry the store and the state as the row's accessible name, so the
      // list is readable without the colour and without the shape.
      const say = [];
      const notes = [];
      const dots = shown.map(st => {
        const s2 = elStoreState((p.stores || {})[st.code] || null, st.code);
        const sw = s2.has ? (s2.on ? cuT('sync on', '同步开启') : cuT('sync off', '同步关闭')) : '';
        say.push(elStoreName(st) + ' ' + s2.t + (sw ? ' · ' + sw : ''));
        if (s2.k === 'att') notes.push({ st, s2 });
        // No mapping, no switch: there is nothing there to be on or off, and a
        // greyed control would invite a click that does nothing. Same for a
        // store with no Eleme shop linked — the switch there is a fact about
        // nothing, and that store's own line above already says why.
        const pip = s2.has && s2.k !== 'none'
          ? '<span class="el-pip' + (s2.on ? ' on' : '') + '" title="' + esc(sw) + '"></span>'
          : '';
        return '<span class="el-dcell"><span class="el-sw">' +
          '<span class="el-dot ' + s2.k + '" title="' + esc(elStoreName(st) + ' · ' + s2.t) + '"></span>' +
          pip + '</span></span>';
      }).join('');

      // What is wrong, on the row it is wrong about, in the words the panel
      // uses. A count that says 10 above rows that say nothing sends someone
      // into all ten of them.
      const why = notes.length
        ? '<span class="el-why">' +
            esc((shown.filter(st => elStoreConnected(st.code)).length > 1
                  ? elStoreName(notes[0].st) + ' · ' : '') + notes[0].s2.t) +
            (notes.length > 1 ? esc(' +' + (notes.length - 1)) : '') + '</span>'
        : '';

      return '<button type="button" class="el-lrow' + (p.id === _elSel ? ' sel' : '') + '"' +
        ' data-pid="' + p.id + '" onclick="elSelect(' + p.id + ')"' +
        ' aria-label="' + esc(base + (p.sku ? ' ' + p.sku : '') + ' · ' + say.join(' · ')) + '">' +
        // The SKU is a sibling of the name, not inside it: it is what an
        // operator searches by, and inside the name it would be the first thing
        // the ellipsis ate.
        '<span class="el-pcell">' + thumb +
        '<span class="el-pname">' + esc(base) +
          (p.variant_label ? ' <span class="vl">· ' + esc(p.variant_label) + '</span>' : '') + '</span>' +
        (p.sku ? '<span class="el-psku">' + esc(p.sku) + '</span>' : '') + why + '</span>' +
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
    // `map` is null when this product holds no mapping row on this store at all
    // — which is a different thing from a row with the name left blank, and the
    // state below is the only place that tells them apart. Everything after it
    // reads `m`, the same always-an-object it always read.
    const map    = (p.stores || {})[st.code] || null;
    const m      = map || {};
    const s2     = elStoreState(map, st.code);
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

    // The name field is an autocomplete against the real catalogue, not free
    // text: a hand-typed name once used a curly apostrophe and silently failed
    // every push. Labelled, so no placeholder — the placeholder used to BE the
    // label on the table, and keeping both says the same words twice.
    let body =
      '<div class="el-pbh"><span class="nm">' + esc(elStoreName(st)) + '</span>' + toggle + '</div>' +
      '<div class="el-pstate"><span class="el-dot ' + s2.k + '"></span>' + esc(s2.t) + '</div>' +
      // Why, in a sentence, on the one product in front of you. On-demand help:
      // it appears only on a mapping that has the problem, never as a standing
      // paragraph over the whole page.
      (s2.why ? '<div class="el-sub el-whysub">' + esc(s2.why) + '</div>' : '') +
      '<div class="el-plbl">' + esc(cuT('Eleme listing name', '饿了么商品名')) + '</div>' +
      '<input type="text" class="el-name-input" data-no-i18n' +
        ' list="el-catalogue-dl-' + esc(st.code) + '"' +
        ' value="' + esc(name) + '"' +
        ' onchange="elSetElemeName(' + p.id + ', ' + st.id + ", '" + esc(st.code) + "', this.value)\">";

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
