/* eslint-disable no-undef */
/* retail-admin app JS — part 28.  Shop menu (门店商品), 2026-09-05.
   All parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (api, toast,
   escapeHtml, cuT, goTab, acMoney, acCurrencySymbol, onLangChange, tdErrorText)
   live in 01-core.js.

   WHAT THIS IS. The admin for a SHOP — the record §41 attaches to a location —
   and its LISTINGS, the join §42 makes between a store_product and a shop that
   carries the price at that shop, the fulfilment mode (stocked · 备货 or made
   here · 现做), a staff on/off switch and a menu position. It is the front of
   routes/retail-shops.js and nothing else. It is NOT the public QR menu, which
   is designed separately; nothing here is customer-facing and nothing reads
   these listings yet — the till is unchanged.

   WHERE IT SITS. A sub-page behind each Sales → Locations card, per the A5
   Board contract (tacet-desktop-patterns.md: the Board is the only door to a
   channel's admin; no rail entry). It takes over the content area the way
   Materials → record does (§1.7a: nothing overlays, the page behind is
   display:none, Back returns to the list): goTab('shop-menu') lights the Sales
   rail row through RAIL_STANDIN, body.shp-viewing pins main, and a throwaway
   history entry catches the browser Back button.

   HEADER (§1.7 / §1.7a). The back link is the eyebrow and reads "Sales". The
   title is the screen name. NO status line — nothing on a menu is work waiting
   on an operator. The one Dusk CTA is Add product; a location with no shop yet
   spends it on Create shop instead, because that is the page's only action
   until one exists.

   THE AVAILABILITY SWITCH IS THE DAILY CONTROL and it is on the row, not in a
   form: it flips optimistically and repaints, then PATCHes, and reverts on
   failure so the switch never lies about the live state — the Products
   catalogue's paToggleShop shape (09-products.js). Every control that writes
   disables while it writes (§1.12).

   THE CODE HAS NO LABEL, ON PURPOSE. No locked or live Chinese source exists
   for "shop code", and composing one is against §30 / the vocabulary lock. The
   value is shown unlabelled, in mono, under the title; Ash supplies the label.

   LANGUAGE. The root carries data-no-i18n and every string is baked by cuT()
   at paint time and repainted on language change (the 18-materials / 20-waste
   pattern), so the " · " walker never sees a half-translated node.

   CHINESE IS COPIED, NEVER COMPOSED. Every 中文 string below is either one Ash
   supplied for this screen on 2026-09-05 (门店商品 as the screen name, 类型 as
   the mode column, 现做 / 备货 as the modes) or a pair already shipping in this
   admin, reused verbatim: 价格, 上架 / 已上架 / 未上架, 排序, 门店, 销售, 产品,
   + 添加商品, 搜索商品以添加…, 移除, 取消, 保存中…, 添加中…, 返回, 加载中…, 重试,
   已停用, 未开通, 还没有商品, 中文名, 英文名(可选), 已保存, 按名称或货号搜索…
   (the menu filter's placeholder, lifted verbatim from 07-content-billing.js
   fsc-psearch and 09-products.js pw-copy-q, where the pair already ships).
   The filter's match count is bare numerals — "8 / 47" — and carries no label
   in either language, so it needed no string at all. FOUR LABELS WERE
   RESTRUCTURED TO FIT A LIVE PAIR rather than minted: the create action is the
   Board's own "Set up · 设置" under its "Not set up · 未开通" state; the shop
   switch carries the state word "On · 已开启" / "Off · 已停用" and no label of
   its own; the picker's no-results line is the catalogue's "No products match
   this filter · 没有匹配此筛选条件的产品"; the load banner is "Load failed ·
   加载失败". The ONE string with no source — the label for the public code —
   is not rendered at all; the value is shown unlabelled (see above). The
   T(en, '') marker therefore has no live user in this file today; it stays
   because the next string added here will need it.

   PREFIX is shp-*. sh- reads as shipping; shop- is a word the base stylesheet
   already uses in class names. */

(function () {
  'use strict';

  const esc = (typeof escapeHtml === 'function')
    ? escapeHtml
    : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  // T(en, cn) — and T(en, '') is the AWAITING-TRANSLATION marker (see header).
  const T = (en, cn) => (cn && typeof cuT === 'function' ? cuT(en, cn) : en);
  const lang = () => (typeof cuLang === 'function' ? cuLang() : 'en');
  const money = n => (typeof acMoney === 'function' ? acMoney(Number(n || 0)) : '¥' + Number(n || 0).toFixed(2));
  const sym = () => (typeof acCurrencySymbol === 'function' ? acCurrencySymbol() : '¥');
  const errText = (e, fallback) => (typeof tdErrorText === 'function'
    ? tdErrorText((e && e.code) || fallback, e && e.message)
    : ((e && e.message) || fallback));
  // Read-only for an operator without stores:edit. The row controls are
  // DISABLED rather than tagged data-cap: applyCapGates hides a data-cap
  // element outright, and a table whose price and mode cells vanish reads as
  // broken, not as read-only. Buttons keep data-cap, which hides them — the
  // house convention for an action the operator cannot take.
  const RO = () => (typeof can === 'function' ? !can('stores:edit') : false);

  // ── module state ──────────────────────────────────────────────────────────
  let _open = false;
  let _init = false;
  let _loc = null;        // { id, code, name_en, name_cn, is_active }
  let _shop = null;       // the shops row, or null when the location has none
  let _rows = [];         // listings
  // EVERY location with its shop, as GET /shops answers it — the same fetch
  // load() already makes to resolve a location code, kept instead of
  // discarded. §177's move needs to know which OTHER locations could take
  // this menu, and asking again would be a second call for data this page is
  // already holding.
  let _locs = [];
  let _loading = false;
  let _err = '';
  let _pickerOpen = false;
  let _pickQ = '';
  let _pick = [];
  let _pickLoading = false;
  let _pickTimer = null;
  // Every candidate search takes a ticket. One request goes out per settled
  // keystroke and they do not come back in order — without this a slow answer
  // for "pea" repaints over the answer for "peanut" and the list stops
  // agreeing with the box. Same guard as the till's customer search
  // (public/till.html custSearch) and the Materials list's _loadSeq.
  let _pickSeq = 0;
  // Set when the picker is OPENED and consumed by the next paint. It is the
  // only time anything focuses the search field from code — see paint().
  let _pickFocus = false;
  // THE MENU FILTER. A term the operator types to narrow the table below — a
  // local filter over _rows, not a request: the whole menu is already loaded,
  // and a shop's listings are tens to low hundreds. Nothing is fetched, so
  // there is no debounce and no sequence ticket; the keystroke and the redraw
  // are the same frame. It never touches _rows, only what table() draws from
  // them, so every write below still finds its row by id while a filter is up.
  let _menuQ = '';
  let _busy = new Set();  // listing ids with a write in flight

  const root = () => document.getElementById('shp-root');

  // A bilingual data value that follows the language toggle — the same shape
  // as 01-core.js csStoreName. Data, not vocabulary.
  const nameOf = (en, cn) => {
    en = en || ''; cn = cn || '';
    if (!en && !cn) return '';
    if (!en || !cn || en === cn) return esc(en || cn);
    return lang() === 'cn' ? esc(cn) : esc(en);
  };
  const locName = () => _loc ? nameOf(_loc.name_en || _loc.code, _loc.name_cn || _loc.code) : '';
  // A product's name and, for one size of a variant family, that size — the
  // till's own rule (till.html): each language falls back to the other, since
  // many sizes carry an English label only. The size sits in its own span that
  // never shrinks, so a long name ellipses and the size, the one thing that
  // tells two rows of the same name apart, is never what gets cut.
  const prodName = (p, cls) => {
    const size = (T(p.variant_label || p.variant_label_cn || '',
                    p.variant_label_cn || p.variant_label || '') || '').trim();
    return `<span class="shp-name-line"><span class="${cls}">${nameOf(p.name_en, p.name_cn)}</span>` +
      (size ? `<span class="shp-size">· ${esc(size)}</span>` : '') + `</span>`;
  };

  // WHERE THIS MENU COULD GO — §177. A destination is any OTHER location whose
  // shop carries no listings, including one with no shop at all, which the
  // move creates. The test is the LISTING COUNT and not the presence of a
  // shop: a location set up and never filled is a fine destination, while
  // merging two priced menus asks whose price wins on a product listed at
  // both, and §177 does not answer that.
  //
  // COMPUTED FROM WHAT THE PAGE ALREADY LOADED, and that is also what hides
  // the control: nowhere to go means no button, so the screen never offers an
  // action whose only possible answer is a refusal. The list is as old as the
  // page, so the server re-checks it — this decides what to SHOW, not what is
  // allowed.
  const moveTargets = () => (_loc && _locs.length
    ? _locs.filter(x => x.location && x.location.id !== _loc.id && !(x.shop && x.shop.listing_count > 0))
    : []);

  const I = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 18-6-6 6-6"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  OPEN / CLOSE — the §1.7a takeover
  // ═══════════════════════════════════════════════════════════════════════════
  // Entered from a Sales → Locations card with the location's code (the only
  // handle the channel-status payload carries). The location and its shop are
  // resolved through GET /api/retail-admin/shops, which lists every location
  // with or without a shop, so a location that has none opens on Create shop.
  window.shopMenuOpen = function (storeCode) {
    if (!_init) {
      _init = true;
      if (typeof onLangChange === 'function') onLangChange(() => { if (_open) paint(); });
      // A rail click while the page is open navigates away without going
      // through shopMenuBack — tear down first, in the capture phase, so
      // body.shp-viewing is gone before the tab switcher shows the next section.
      document.addEventListener('click', (e) => {
        if (!_open) return;
        if (e.target.closest && e.target.closest('.tabs [data-tab]')) teardown(false);
      }, true);
    }
    _loc = null; _shop = null; _rows = []; _err = ''; _pickerOpen = false; _pickQ = ''; _pick = [];
    if (!_open) {
      _open = true;
      goTab('shop-menu');
      document.body.classList.add('shp-viewing');
      history.pushState({ shopMenu: true }, '');
      window.addEventListener('popstate', onPop);
    }
    const sc = document.getElementById('shp-scroll');
    if (sc) sc.scrollTop = 0;
    load(storeCode);
  };

  function onPop() { teardown(true); goTab('sales'); }

  function teardown(viaPop) {
    if (!_open) return;
    _open = false;
    document.body.classList.remove('shp-viewing');
    window.removeEventListener('popstate', onPop);
    if (!viaPop) history.back();
  }

  window.shopMenuBack = function () {
    teardown(false);
    // goTab clicks the real Sales rail button, whose own listener reloads the
    // Board — so a shop just created shows on its card without a second fetch.
    goTab('sales');
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA
  // ═══════════════════════════════════════════════════════════════════════════
  async function load(storeCode) {
    _loading = true; _err = ''; paint();
    try {
      const all = await api('/api/retail-admin/shops');
      _locs = all.data || [];
      const hit = _locs.find(x => x.location && x.location.code === storeCode);
      if (!hit) throw Object.assign(new Error(''), { code: 'location_not_found' });
      _loc = hit.location;
      if (hit.shop) {
        const j = await api('/api/retail-admin/shops/' + hit.shop.id);
        _shop = j.data.shop; _rows = j.data.listings || [];
      } else { _shop = null; _rows = []; }
    } catch (e) {
      _err = errText(e, 'load_failed');
    }
    _loading = false; paint();
  }

  async function reload() {
    if (!_shop) return;
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id);
      _shop = j.data.shop; _rows = j.data.listings || [];
    } catch (e) { toast(errText(e, 'load_failed'), 'err'); }
    paint();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAINT
  // ═══════════════════════════════════════════════════════════════════════════
  function paint() {
    const el = root();
    if (!el) return;
    if (_loading && !_loc) { el.innerHTML = head() + `<div class="shp-note">${esc(T('Loading…', '加载中…'))}</div>`; return; }
    if (_err && !_loc) {
      el.innerHTML = head() + `<div class="shp-banner"><div class="shp-banner-t">${esc(T('Load failed', '加载失败'))}</div>`
        + `<div class="shp-banner-b">${esc(_err)}</div>`
        + `<button type="button" class="shp-btn sm" onclick="shopMenuBack()">${esc(T('Back', '返回'))}</button></div>`;
      return;
    }
    el.innerHTML = head() + (_shop ? body() : noShop());
    if (typeof applyCapGates === 'function') applyCapGates();   // the data-cap buttons just painted
    // FOCUS ON OPEN, AND NOWHERE ELSE. This used to run on every paint, and a
    // search fired two of them, so the caret was dragged to the end of the
    // value a fifth of a second after every pause — a term being corrected in
    // the middle threw you to the end of it. Nothing repaints this field
    // during a search now (see picker()), so the one moment it still needs
    // focusing from code is the click that opened the panel.
    if (_pickFocus) {
      _pickFocus = false;
      const q = el.querySelector('#shp-pick-q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    bindPickComposition();
  }

  // THE ONE EVENT THAT CANNOT BE WIRED IN THE MARKUP. Composition events are
  // not in GlobalEventHandlers, so `oncompositionend="…"` as an attribute is
  // not a handler at all — the browser ignores it in silence.
  //
  // WHY IT IS NOT OPTIONAL HERE. Committing a pinyin candidate fires `input`
  // with isComposing STILL TRUE, carrying the finished characters, and only
  // THEN compositionend. shpPickSearch() skips composing events, so without
  // this listener the search would never run for a Chinese term at all — and
  // half this catalogue is named in Chinese. Bound on the element the paint
  // just minted, and only there: a fresh element each time means no listener
  // is ever attached twice.
  function bindPickComposition() {
    const q = document.getElementById('shp-pick-q');
    if (q && typeof q.addEventListener === 'function') {
      q.addEventListener('compositionend', () => { window.shpPickSearch(q.value); });
    }
    // The menu filter needs the same listener for the same reason: half this
    // catalogue is named in Chinese, and the input event that carries the
    // committed characters still has isComposing set, so shpMenuFilter() drops
    // it. Without this, a pinyin term would narrow nothing. Bound on the
    // element this paint just minted, so no listener is ever attached twice.
    const m = document.getElementById('shp-menu-q');
    if (m && typeof m.addEventListener === 'function') {
      m.addEventListener('compositionend', () => { window.shpMenuFilter(m.value); });
    }
  }

  // §1.7a: back link IS the eyebrow · title · at most two exits, one Dusk.
  function head() {
    // THE SECOND EXIT — §1.7a allows two and at most one Dusk, and Add product
    // holds the Dusk (§1.8 rule 1). Move products is therefore Secondary, the
    // bare .shp-btn, which is also what §1.7a says a non-committing exit is.
    // It appears only on a menu that HAS something to move and only when
    // there is somewhere to move it to — see moveTargets().
    const moveBtn = (_shop && _rows.length && moveTargets().length)
      ? `<button type="button" class="shp-btn" id="shp-move" data-cap="stores:edit" onclick="shpMove(this)">${esc(T('Move products', '移动商品'))}</button>`
      : '';
    const cta = !_loc ? ''
      : _shop
        ? moveBtn + `<button type="button" class="shp-btn primary" id="shp-add" data-cap="stores:edit" onclick="shpPickerToggle()">${esc(T('+ Add product', '+ 添加商品'))}</button>`
        : `<button type="button" class="shp-btn primary" id="shp-create" data-cap="stores:edit" onclick="shpCreate(this)">${esc(T('Set up', '设置'))}</button>`;
    const code = _shop
      ? `<div class="shp-code"><code>${esc(_shop.public_code)}</code></div>`   // unlabelled on purpose — see header
      : '';
    // THE QR, AND THE ADDRESS IT ENCODES. Both, deliberately: a QR is opaque to
    // a human, so an operator shown only the picture cannot tell a correct one
    // from a wrong one, and the wrong one gets discovered after it is printed
    // and stuck to a table. The address is shown in full beneath it.
    // 二维码 / QR CODE and 二维码不可用 / QR unavailable are pairs already live
    // in this admin. 下载 is the verb this admin already downloads with —
    // '下载模板', '下载备份' — LIFTED from those rather than found as a bare
    // pair, which is the one string on this screen Ash should look at (§30).
    const qr = _shop && _shop.is_active
      ? `<div class="shp-qr">
           <div class="shp-qr-h">${esc(T('QR code', '二维码'))}</div>
           <img class="shp-qr-img" alt="" src="/api/retail-admin/shops/${_shop.id}/qr.png?v=${encodeURIComponent(_shop.updated_at || '')}"
                onerror="this.style.display='none'">
           <div class="shp-qr-url" id="shp-qr-url"></div>
           <a class="shp-qr-dl" id="shp-qr-dl"
              href="/api/retail-admin/shops/${_shop.id}/qr.png?download=1&scale=20"
              download="shop-${esc(_shop.public_code)}.png">${esc(T('Download', '下载'))}</a>
         </div>`
      : '';
    const state = _shop && !_shop.is_active ? `<span class="shp-pill off">${esc(T('Inactive', '已停用'))}</span>` : '';
  // Ask what a scan will actually open, and say so under the picture. A tenant
  // that has not told the platform where it serves customers gets the reason
  // rather than a broken image and no explanation — the endpoint answers
  // no_public_domain for exactly that case.
  async function _shpLoadQrUrl() {
    const el = () => document.getElementById('shp-qr-url');
    if (!_shop || !_shop.is_active) return;
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/qr');
      const box = el(); if (!box) return;
      const url = j && j.data && j.data.url;
      if (url) { box.textContent = url; box.className = 'shp-qr-url'; }
      else {
        box.textContent = T('QR unavailable', '二维码不可用');
        box.className = 'shp-qr-url off';
        const img = document.querySelector('.shp-qr-img'); if (img) img.style.display = 'none';
        // Nothing was minted, so there is nothing to download. A live-looking
        // link that returns a 409 is worse than no link.
        const dl = document.getElementById('shp-qr-dl'); if (dl) dl.style.display = 'none';
      }
    } catch (e) { /* the header still renders; the address line simply stays empty */ }
  }

    _shpLoadQrUrl();
    return `<div class="shp-head">
      <div class="shp-head-l">
        <button type="button" class="shp-back" onclick="shopMenuBack()">${I.back}<span>${esc(T('Sales', '销售'))}</span></button>
        <h1 class="shp-title">${esc(T('Shop menu', '门店商品'))}${state}</h1>
        <div class="shp-sub">${locName()}</div>
        ${code}${qr}
      </div>
      <div class="shp-head-r">${cta}</div>
    </div>`;
  }

  // §41: a location with no shop record has no menu. Say so, and offer the one
  // action. "Not set up · 未开通" is the Board's own word for this state.
  function noShop() {
    return `<div class="shp-empty">
      <div class="shp-empty-t">${esc(T('Not set up', '未开通'))}</div>
      <p>${locName()}</p>
    </div>`;
  }

  function body() {
    return details() + (_pickerOpen ? picker() : '') + filterBar() + `<div id="shp-table-box">${table()}</div>`;
  }

  // Does this listing answer the term? Name in either language, the size, or
  // the SKU — the things the row actually shows, so a match is always visible in
  // the row it lands on. Case-folded; a Chinese term is unaffected by that and
  // an English one should not care which way the catalogue happens to be typed.
  function hit(r) {
    if (!_menuQ) return true;
    const q = _menuQ.trim().toLowerCase();
    if (!q) return true;
    return [r.name_en, r.name_cn, r.variant_label, r.variant_label_cn, r.sku].map(v => String(v || '')).join(' ')
      .toLowerCase().includes(q);
  }
  const shown = () => _rows.filter(hit);

  // THE FILTER SITS OUTSIDE #shp-table-box, AND THAT IS THE WHOLE DESIGN.
  // Filtering repaints the table, and this file has already paid once for a
  // search field that lived inside what its own keystrokes repainted (see
  // picker(), at length): the <input> is destroyed mid-word, the caret is
  // guessed at, and an IME composition dies before a character is committed.
  // Painted here, the field is never inside anything a filter redraws —
  // renderTable() replaces the table box beneath it and leaves this alone.
  //
  // THE COUNT IS BARE NUMERALS ON PURPOSE. "8 / 47" needs no label and so no
  // Chinese: it reads the same in both languages, and CLAUDE.md's rule is that
  // a numeral often needs no label at all. It is emptied when nothing is
  // filtered, so a full menu shows no count to read.
  //
  // type="search" carries the browser's own clear affordance, which is why
  // there is no Clear button beside it — the catalogue's photo picker
  // (09-products.js pd-lib-q) takes the same route.
  //
  // "Search by name or SKU… · 按名称或货号搜索…" is LIFTED VERBATIM from the
  // pairs already shipping in this admin (07-content-billing.js fsc-psearch,
  // 09-products.js pw-copy-q). Nothing here is composed.
  function filterBar() {
    const off = _rows.length ? '' : ' hidden';
    return `<div class="shp-filter" id="shp-filter"${off}>
      <input class="shp-in" id="shp-menu-q" type="search" autocomplete="off" value="${esc(_menuQ)}"
             placeholder="${esc(T('Search by name or SKU…', '按名称或货号搜索…'))}"
             aria-label="${esc(T('Search by name or SKU…', '按名称或货号搜索…'))}"
             oninput="shpMenuFilter(this.value, event)">
      <span class="shp-filter-n" id="shp-filter-n">${filterCount()}</span>
    </div>`;
  }
  function filterCount() {
    if (!_menuQ.trim() || !_rows.length) return '';
    return esc(shown().length + ' / ' + _rows.length);
  }

  // The shop's own fields: two optional display names and the active switch.
  // Names default to the location's, so both may stay blank.
  function details() {
    const dis = (_busy.has('shop') || RO()) ? ' disabled' : '';
    return `<div class="shp-details">
      <label class="shp-f"><span class="shp-f-l">${esc(T('English name (optional)', '英文名(可选)'))}</span>
        <input class="shp-in" id="shp-name-en" value="${esc(_shop.display_name_en || '')}" placeholder="${esc(_loc.name_en || '')}"
               onchange="shpSaveName('display_name_en', this)"${dis}></label>
      <label class="shp-f"><span class="shp-f-l">${esc(T('Chinese name', '中文名'))}</span>
        <input class="shp-in" id="shp-name-cn" value="${esc(_shop.display_name_cn || '')}" placeholder="${esc(_loc.name_cn || '')}"
               onchange="shpSaveName('display_name_cn', this)"${dis}></label>
      <label class="shp-f shp-f-sw">
        <span class="shp-f-l">${esc(_shop.is_active ? T('On', '已开启') : T('Off', '已停用'))}</span>
        <label class="shp-sw${_shop.is_active ? ' is-on' : ''}">
          <input type="checkbox" ${_shop.is_active ? 'checked' : ''}${dis} onchange="shpToggleActive(this)">
          <span class="shp-knob"></span>
        </label>
      </label>
    </div>`;
  }

  // The Add product picker — an in-flow panel above the table, not a modal:
  // its height grows with what the search returns (§1.13 question 2), up to
  // the ceiling #shp-pick-list carries in retail-admin.css. The ceiling is
  // there because an empty box now returns the whole addable catalogue rather
  // than the first fifty of it, and unbounded growth on several hundred rows
  // pushes the menu table off the screen.
  //
  // THE FIELD IS PAINTED ONCE AND THEN LEFT ALONE. It used to be re-emitted by
  // the page-wide paint() that fetchPick() called twice per search — once to
  // show "Loading…" and once to show the answer — so the <input> the operator
  // was typing into was destroyed and rebuilt, twice, a fifth of a second
  // after every pause. paint() handed focus and the caret back by hand, always
  // to the END of the value, which is why the box blinked, why the caret
  // jumped out of a term being corrected, and why a keystroke that landed on
  // the dying element never reached _pickQ — the search then ran on a term
  // nobody typed. For Chinese it was worse than a blink: a composition cannot
  // be handed back, because the browser drops the candidate window with the
  // element that owned it, so the field died before a character was committed.
  //
  // Only #shp-pick-list is repainted by a search now (renderPickList), and the
  // <input> is never touched — nothing to restore, no caret to guess at, no
  // composition to lose. The same split the Materials list carries
  // (18-materials.js paintList) and the till's customer picker
  // (public/till.html renderCustPicker).
  function picker() {
    return `<div class="shp-picker">
      <div class="shp-pick-row">
        ${/* The event goes to shpPickSearch() beside the value: an IME's
              half-typed pinyin arrives as input events too, and searching on
              it is searching for something the operator has not typed yet. */''}
        <input class="shp-in" id="shp-pick-q" value="${esc(_pickQ)}" placeholder="${esc(T('Search a product to add…', '搜索商品以添加…'))}" oninput="shpPickSearch(this.value, event)">
        <button type="button" class="shp-btn ghost sm" onclick="shpPickerToggle()">${esc(T('Cancel', '取消'))}</button>
      </div>
      <div id="shp-pick-list">${pickList()}</div>
    </div>`;
  }

  // ADD EVERY ONLINE-STORE PRODUCT (Ash, 2026-09-29). How many products the
  // mini app shows that this menu does not list yet — counted from the
  // unfiltered candidate list, the only one that sees all of them, and kept
  // while a search narrows the rows below. Zero hides the button: there is
  // nothing for it to do.
  let _pubMissing = 0;
  function addAllRow() {
    if (!_pubMissing || RO()) return '';
    const n = _pubMissing;
    return `<div class="shp-pick-all">
        <button type="button" class="shp-btn sm" id="shp-add-all" data-cap="stores:edit" onclick="shpAddAllPublished(this)">${esc(T(`+ Add all ${n} Online store products`, `+ 添加全部 ${n} 个线上商城商品`))}</button>
      </div>`;
  }

  // Everything below the search box, in one patchable box.
  //
  // THE LOADING LINE ONLY WHEN THERE IS NOTHING TO KEEP. This panel is a card
  // whose height grows with what the search returns, and the search box lives
  // inside it. Replacing eight rows with a one-line "Loading…" per settled
  // keystroke collapsed the card to a sliver and snapped it open again when
  // the answer landed — the box's own border flying up past it and back, and
  // the listings table below jumping the same distance. That is a flicker on
  // every letter, and it survived the field itself being left alone.
  //
  // Leaving the previous matches up while the next answer is in flight costs a
  // couple of hundred milliseconds of slightly stale rows. A collapsing panel
  // costs the operator their place on every keystroke, which is worse.
  function pickList() {
    if (_pickLoading && !_pick.length) return `<div class="shp-note sm">${esc(T('Loading…', '加载中…'))}</div>`;
    if (!_pick.length) return `<div class="shp-note sm">${esc(_pickQ ? T('No products match this filter', '没有匹配此筛选条件的产品') : T('No products yet', '还没有商品'))}</div>`;
    return addAllRow() + `<ul class="shp-pick-list">` + _pick.map(p => `<li>
        ${prodName(p, 'shp-pick-name')}
        <span class="shp-pick-sku">${esc(p.sku || '')}</span>
        <span class="shp-pick-price">${esc(money(p.sell_price))}</span>
        <button type="button" class="shp-btn sm" data-cap="stores:edit" onclick="shpAdd(${p.id}, this)">${esc(T('+ Add product', '+ 添加商品'))}</button>
      </li>`).join('') + `</ul>`;
  }

  // What a search repaints, and the whole of it. Falls back to the page paint
  // only when the panel is not on screen — which is never during a search, and
  // always on the first one after something outside this module cleared the
  // root.
  function renderPickList() {
    const box = document.getElementById('shp-pick-list');
    if (!box) { paint(); return; }
    // An identical rewrite still destroys and re-mints every row, and drags a
    // document-wide capability pass behind it. Typing narrows a list slowly —
    // the same rows come back often — so comparing first is cheaper than the
    // churn, and it keeps the DOM still when nothing about it changed.
    const html = pickList();
    if (box.innerHTML === html) return;
    box.innerHTML = html;
    if (typeof applyCapGates === 'function') applyCapGates();
  }

  // The listings table repaints on its own too, so adding a product does not
  // take the search field down with it — the operator is mid-flow, adding the
  // next one.
  function renderTable() {
    const box = document.getElementById('shp-table-box');
    if (box) {
      box.innerHTML = table(); if (typeof applyCapGates === 'function') applyCapGates();
      // The filter bar is NOT repainted — the operator may be typing in it.
      // Only its two mutable bits are written: the count, and whether the bar
      // is there at all once the last listing has been removed. Writing the
      // <span> rather than the row is what keeps the <input> and its caret,
      // and any open IME candidate window, alive through a redraw.
      const n = document.getElementById('shp-filter-n');
      if (n) n.textContent = filterCount();
      const bar = document.getElementById('shp-filter');
      if (bar) bar.hidden = !_rows.length;
      return;
    }
    paint();
  }

  /* Table — §1.19: fixed layout, classed cols, percentages summing to 100.
     Measured at the 996px reference against the widest header and value in
     both languages. The Sort column is gone (2026-09-29): the QR menu's
     product order is set by dragging on Products → Categories, in its QR menu
     view, and a number here no longer orders anything. Its 8% went to prod.
       prod  46%  — SLACK COLUMN: product name ellipses, SKU beneath
       price 16%  — a "¥ 1,234.56" input ~120px incl. the symbol
       mode  16%  — select holding "Made here"/"现做" ~110px incl. chevron
       avail 12%  — header "Available"/有货 ~64px; the switch is 40px
       act   10%  — "Remove"/移除 ghost button ~70px incl. padding
                    ────
                    100 */
  function table() {
    if (!_rows.length) {
      return `<div class="shp-empty"><div class="shp-empty-t">${esc(T('No products yet', '还没有商品'))}</div></div>`;
    }
    const list = shown();
    // A filter that matches nothing says so in the catalogue's own words,
    // already live in this file for the picker. It is NOT the "No products
    // yet" line above: the menu has products, this term simply found none of
    // them, and telling the operator the menu is empty would be a lie they
    // would go and act on.
    if (!list.length) {
      return `<div class="shp-empty"><div class="shp-empty-t">${esc(T('No products match this filter', '没有匹配此筛选条件的产品'))}</div></div>`;
    }
    const rows = list.map(r => {
      const busy = _busy.has(r.id);
      const dis = (busy || RO()) ? ' disabled' : '';
      const on = r.is_available === 1;
      // §287 — made here and switched off is SOLD OUT: still on the till and
      // the QR menu, greyed, until someone switches it back. It never resets
      // by itself. The word is the QR menu's own pill for the same state.
      const soldOut = !on && r.fulfilment_mode === 'made_here';
      // The hover names the state, the header's own word or the QR menu's.
      // The old "On the shop · tap to hide" was wrong for every row: off never
      // takes a listing off the QR menu — any kind shows there greyed, sold
      // out (routes/shop-menu.js). Only the till drops a stocked one.
      const title = on ? T('Available', '有货') : T('Sold out', '售罄');
      return `<tr data-id="${r.id}"${busy ? ' class="is-busy"' : ''}>
        <td><div class="shp-prod">${prodName(r, 'shp-ell')}</div>
            <div class="shp-sku">${esc(r.sku || '')}</div></td>
        <td class="num"><span class="shp-money"><span class="shp-sym">${esc(sym())}</span>
              <input type="number" min="0" step="0.01" class="shp-in shp-in-n" value="${esc(Number(r.price).toFixed(2))}"
              onchange="shpSaveField(${r.id}, 'price', this)"${dis}></span></td>
        <td><select class="shp-in shp-sel" onchange="shpSaveField(${r.id}, 'fulfilment_mode', this)"${dis}>
              <option value="stocked"${r.fulfilment_mode === 'stocked' ? ' selected' : ''}>${esc(T('Stocked', '备货'))}</option>
              <option value="made_here"${r.fulfilment_mode === 'made_here' ? ' selected' : ''}>${esc(T('Made here', '现做'))}</option>
            </select></td>
        <td><label class="shp-sw${on ? ' is-on' : ''}" title="${esc(title)}">
              <input type="checkbox" ${on ? 'checked' : ''}${dis} onchange="shpToggleAvail(${r.id}, this.checked)">
              <span class="shp-knob"></span></label>${soldOut ? `<span class="shp-so">${esc(T('Sold out', '售罄'))}</span>` : ''}</td>
        <td class="act"><button type="button" class="shp-btn ghost sm" data-cap="stores:edit" onclick="shpRemove(${r.id}, this)"${dis}>${esc(T('Remove', '移除'))}</button></td>
      </tr>`;
    }).join('');
    return `<div class="shp-tablewrap"><table class="shp-table">
      <colgroup><col class="shp-c-prod"><col class="shp-c-price"><col class="shp-c-mode"><col class="shp-c-avail"><col class="shp-c-act"></colgroup>
      <thead><tr>
        <th>${esc(T('Product', '产品'))}</th>
        <th class="num">${esc(T('Price', '价格'))}</th>
        <th>${esc(T('Kind', '类型'))}</th>
        <th>${esc(T('Available', '有货'))}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WRITES — every control disables while it writes (§1.12)
  // ═══════════════════════════════════════════════════════════════════════════
  window.shpCreate = async function (btn) {
    if (!_loc || _shop) return;
    if (btn) { btn.disabled = true; btn.textContent = T('Saving…', '保存中…'); }
    try {
      const j = await api('/api/retail-admin/shops', { method: 'POST', body: { location_id: _loc.id } });
      _shop = j.data.shop; _rows = j.data.listings || [];
      toast(T('Saved', '已保存'));
      paint();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = T('Set up', '设置'); }
      toast(errText(e, 'save_failed'), 'err');
    }
  };

  window.shpSaveName = async function (field, input) {
    if (!_shop) return;
    const val = input.value;
    _busy.add('shop'); input.disabled = true;
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id, { method: 'PATCH', body: { [field]: val } });
      _shop = j.data.shop;
    } catch (e) { toast(errText(e, 'save_failed'), 'err'); }
    _busy.delete('shop'); paint();
  };

  window.shpToggleActive = async function (input) {
    if (!_shop) return;
    const want = input.checked ? 1 : 0;
    const was = _shop.is_active;
    _shop.is_active = want; _busy.add('shop'); paint();       // optimistic
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id, { method: 'PATCH', body: { is_active: want } });
      _shop = j.data.shop;
    } catch (e) {
      _shop.is_active = was;
      toast(errText(e, 'save_failed'), 'err');
    }
    _busy.delete('shop'); paint();
  };

  // MOVE THIS MENU TO ANOTHER LOCATION — §177 (Ash, 2026-09-18). Two dialogs,
  // in this order: pick where, then confirm what it costs. The second one is
  // the whole reason this is not a one-tap control — a move empties this menu,
  // switches this shop off and kills the QR already printed on the tables
  // here, and none of that is guessable from a button reading Move products.
  //
  // THE SHOP RECORD DOES NOT MOVE and the button does not pretend it does.
  // "Move products" is the honest name: §41 attaches the shop to its location
  // and §44 makes its code a promise a printed QR carries, so the destination
  // gets its own shop and its own code. That is why the confirm names a
  // reprint.
  //
  // IT LANDS ON THE DESTINATION, not back here. The operator's next question
  // is always "is it live over there?", and the destination's own page answers
  // it with no string at all: its switch, its code and its QR, or the Inactive
  // pill standing where the QR would be. Repainting this page instead would
  // leave them reading an empty menu and wondering where the products went.
  //
  // WHICH NAMES ARE ESCAPED AND WHICH ARE NOT is not a detail here. A dialog
  // title and body are inserted as HTML, so a location name going into one is
  // esc()'d; askChoice escapes its own option labels, so those are passed
  // RAW — escaping them twice would print the entities.
  window.shpMove = async function (btn) {
    if (!_shop || !_rows.length || RO()) return;
    if (typeof askChoice !== 'function' || typeof askConfirm !== 'function') return;
    const targets = moveTargets();
    if (!targets.length) return;

    // The name in one language, the plain data value. ' · ' is the separator
    // the page's own language walker splits these dialogs on, so a name
    // carrying one would cut the sentence in the wrong place — collapsed here
    // rather than left to garble a danger dialog.
    const nameFor = (l, cn) => String((cn ? (l.name_cn || l.name_en) : (l.name_en || l.name_cn)) || l.code || '')
      .replace(/ · /g, ' - ');

    const picked = await askChoice({
      titleEn: 'Move products to another location?', titleCn: '移动商品到其他门店？',
      labelEn: 'Location', labelCn: '门店',
      options: targets.map(x => ({ value: String(x.location.id), label: nameFor(x.location, lang() === 'cn') })),
      submitEn: 'Move', submitCn: '移动',
      cancelEn: 'Cancel', cancelCn: '取消',
    });
    if (!picked) return;
    const target = targets.find(x => String(x.location.id) === String(picked));
    if (!target) return;

    const n = _rows.length;
    const toEn = esc(nameFor(target.location, false));
    const toCn = esc(nameFor(target.location, true));
    const agreed = await askConfirm({
      titleEn: `Move ${n} product${n === 1 ? '' : 's'} to ${toEn}?`,
      titleCn: `移动 ${n} 个商品到${toCn}？`,
      bodyEn: `This menu is emptied and this shop switches off, so the QR already printed here stops working. ${toEn} has its own code, so a new QR has to be printed there.`,
      bodyCn: `此门店的商品将被清空,门店将停用,已打印的二维码将失效。${toCn} 有自己的编码,需要重新打印二维码。`,
      confirmEn: 'Move', confirmCn: '移动',
      cancelEn: 'Cancel', cancelCn: '取消',
      danger: true,
    });
    if (!agreed) return;

    if (btn) { btn.disabled = true; btn.textContent = T('Saving…', '保存中…'); }
    try {
      await api('/api/retail-admin/shops/' + _shop.id + '/move', {
        method: 'POST', body: { to_location_id: target.location.id },
      });
      toast(T('Moved', '已移动'), 'ok');
      window.shopMenuOpen(target.location.code);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = T('Move products', '移动商品'); }
      toast(errText(e, 'save_failed'), 'err');
    }
  };

  window.shpPickerToggle = function () {
    _pickerOpen = !_pickerOpen;
    if (_pickerOpen) { _pickQ = ''; _pick = []; _pickLoading = true; _pickFocus = true; paint(); fetchPick(); }
    else paint();
  };
  // THE MENU FILTER — narrows the listings table over what is already loaded.
  // It takes the SAME IME RULE as the picker search below, for the same reason
  // spelled out there: a half-typed pinyin syllable is not a term the operator
  // has typed, and the compositionend listener in bindPickComposition() is what
  // carries the committed characters in.
  //
  // What it does NOT take is the debounce or the sequence ticket. Those exist
  // to tame a REQUEST — one per settled keystroke, answers that come back out
  // of order. Nothing is fetched here, so there is no request to race and no
  // stale answer to guard against; the keystroke and the redraw are the same
  // frame, and a delay would only make the table lag the box.
  window.shpMenuFilter = function (v, ev) {
    if (ev && ev.isComposing) return;
    _menuQ = v;
    renderTable();
  };

  // TYPING IS NOT A SEARCH TERM UNTIL THE IME SAYS IT IS.
  //
  // A Chinese keyboard fires an input event per LETTER while the candidate
  // window is open — "s", "sh", "sha" — none of which the operator typed or
  // would search for, and none of which matches a catalogue stored in
  // characters. This used to take each one as a term: four requests and four
  // repaints for one character. `event.isComposing` is true for exactly those
  // events and false everywhere else, including on a plain English keyboard.
  // The compositionend listener above carries the committed characters and is
  // what actually starts the search.
  window.shpPickSearch = function (v, ev) {
    if (ev && ev.isComposing) return;
    _pickQ = v;
    clearTimeout(_pickTimer);
    _pickTimer = setTimeout(fetchPick, 220);
  };
  async function fetchPick() {
    if (!_shop) return;
    const seq = ++_pickSeq;
    // Repaint to the loading state only when there is nothing on screen for it
    // to replace — see pickList(). With rows up, this render is skipped
    // entirely and they stay put until the answer arrives.
    _pickLoading = true;
    if (!_pick.length) renderPickList();
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/candidates?q=' + encodeURIComponent(_pickQ));
      if (seq !== _pickSeq) return;   // a later keystroke already asked; this answer is stale
      _pick = j.data || [];
      if (!_pickQ) _pubMissing = _pick.filter(p => p.is_published === 1).length;
    } catch (e) {
      if (seq !== _pickSeq) return;
      _pick = []; toast(errText(e, 'load_failed'), 'err');
    }
    _pickLoading = false; renderPickList();
  }

  window.shpAdd = async function (productId, btn) {
    if (!_shop) return;
    if (btn) { btn.disabled = true; btn.textContent = T('Adding…', '添加中…'); }
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings', { method: 'POST', body: { store_product_id: productId } });
      _rows.push(j.data);
      _pick = _pick.filter(p => p.id !== productId);
      // The list and the table, not the page: adding is the middle of a search,
      // and a page paint here would rebuild the field the operator is about to
      // type the next product into.
      renderPickList(); renderTable();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = T('+ Add product', '+ 添加商品'); }
      toast(errText(e, 'save_failed'), 'err');
    }
  };

  // One tap for everything the mini app shows and this menu does not list.
  // Confirmed first, because it can add hundreds of rows, and because what it
  // adds as Stocked shows SOLD OUT on the QR menu until this shop has counted
  // it (§47) — the operator is told that before, not after.
  window.shpAddAllPublished = async function (btn) {
    if (!_shop || !_pubMissing || RO()) return;
    if (typeof askConfirm !== 'function') return;
    const n = _pubMissing;
    const agreed = await askConfirm({
      titleEn: `Add ${n} product${n === 1 ? '' : 's'} to this menu?`,
      titleCn: `添加 ${n} 个商品到此菜单？`,
      bodyEn: 'Every Online store product not on this menu is added at its catalogue price, as Stocked. Anything this shop has never counted shows as sold out on the QR menu. Remove what this shop does not sell.',
      bodyCn: '所有尚未在此菜单上的线上商城商品将按商品价格添加,类型为备货。此门店从未盘点过的商品会在二维码菜单上显示为售罄。请移除此门店不卖的商品。',
      confirmEn: 'Add', confirmCn: '添加',
      cancelEn: 'Cancel', cancelCn: '取消',
    });
    if (!agreed) return;
    if (btn) { btn.disabled = true; btn.textContent = T('Adding…', '添加中…'); }
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings/add-published', { method: 'POST' });
      _rows = j.data.listings || _rows;
      toast(T('Saved', '已保存'), 'ok');
      // Re-ask the candidates: what was added is no longer one, and the count
      // on the button has to come from the server, not from arithmetic here.
      _pubMissing = 0; _pickQ = ''; _pick = [];
      paint(); fetchPick();
    } catch (e) {
      if (btn) btn.disabled = false;
      toast(errText(e, 'save_failed'), 'err');
      renderPickList();
    }
  };

  // Optimistic flip + repaint, then PATCH; revert on failure so the switch
  // never lies about the live state (09-products.js paToggleShop).
  window.shpToggleAvail = async function (id, on) {
    const r = _rows.find(x => x.id === id);
    if (!r || !_shop) return;
    const was = r.is_available;
    r.is_available = on ? 1 : 0; _busy.add(id); renderTable();
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings/' + id, { method: 'PATCH', body: { is_available: on ? 1 : 0 } });
      Object.assign(r, j.data);
    } catch (e) {
      r.is_available = was;
      toast(errText(e, 'save_failed'), 'err');
    }
    _busy.delete(id); renderTable();
  };

  // price · fulfilment_mode — one PATCH per change, the control disabled
  // meanwhile, the row re-read from the server's answer. A refused value
  // (bad_price) repaints the last saved one.
  window.shpSaveField = async function (id, field, input) {
    const r = _rows.find(x => x.id === id);
    if (!r || !_shop) return;
    const val = input.value;
    _busy.add(id); renderTable();
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings/' + id, { method: 'PATCH', body: { [field]: val } });
      Object.assign(r, j.data);
    } catch (e) { toast(errText(e, 'save_failed'), 'err'); }
    _busy.delete(id); renderTable();
  };

  // No confirm: a listing is a join, and adding the product back restores it.
  window.shpRemove = async function (id, btn) {
    if (!_shop) return;
    if (btn) { btn.disabled = true; }
    _busy.add(id);
    try {
      await api('/api/retail-admin/shops/' + _shop.id + '/listings/' + id, { method: 'DELETE' });
      _rows = _rows.filter(x => x.id !== id);
      if (_pickerOpen) fetchPick();
    } catch (e) { toast(errText(e, 'save_failed'), 'err'); }
    _busy.delete(id); renderTable();
  };

  // Keep reload reachable for a future poller; unused today.
  window.shpReload = reload;
})();
