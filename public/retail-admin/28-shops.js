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
   已停用, 未开通, 还没有商品, 中文名, 英文名(可选), 已保存. FOUR LABELS WERE
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
  let _loading = false;
  let _err = '';
  let _pickerOpen = false;
  let _pickQ = '';
  let _pick = [];
  let _pickLoading = false;
  let _pickTimer = null;
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
      const hit = (all.data || []).find(x => x.location && x.location.code === storeCode);
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
    const q = el.querySelector('#shp-pick-q');
    if (q && _pickerOpen) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  // §1.7a: back link IS the eyebrow · title · at most two exits, one Dusk.
  function head() {
    const cta = !_loc ? ''
      : _shop
        ? `<button type="button" class="shp-btn primary" id="shp-add" data-cap="stores:edit" onclick="shpPickerToggle()">${esc(T('+ Add product', '+ 添加商品'))}</button>`
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
    return details() + (_pickerOpen ? picker() : '') + table();
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
  // its height grows with what the search returns (§1.13 question 2).
  function picker() {
    let list;
    if (_pickLoading) list = `<div class="shp-note sm">${esc(T('Loading…', '加载中…'))}</div>`;
    else if (!_pick.length) list = `<div class="shp-note sm">${esc(_pickQ ? T('No products match this filter', '没有匹配此筛选条件的产品') : T('No products yet', '还没有商品'))}</div>`;
    else list = `<ul class="shp-pick-list">` + _pick.map(p => `<li>
        <span class="shp-pick-name">${nameOf(p.name_en, p.name_cn)}</span>
        <span class="shp-pick-sku">${esc(p.sku || '')}</span>
        <span class="shp-pick-price">${esc(money(p.sell_price))}</span>
        <button type="button" class="shp-btn sm" data-cap="stores:edit" onclick="shpAdd(${p.id}, this)">${esc(T('+ Add product', '+ 添加商品'))}</button>
      </li>`).join('') + `</ul>`;
    return `<div class="shp-picker">
      <div class="shp-pick-row">
        <input class="shp-in" id="shp-pick-q" value="${esc(_pickQ)}" placeholder="${esc(T('Search a product to add…', '搜索商品以添加…'))}" oninput="shpPickSearch(this.value)">
        <button type="button" class="shp-btn ghost sm" onclick="shpPickerToggle()">${esc(T('Cancel', '取消'))}</button>
      </div>
      ${list}
    </div>`;
  }

  /* Table — §1.19: fixed layout, classed cols, percentages summing to 100.
     Measured at the 996px reference against the widest header and value in
     both languages:
       pos    8%  — header Sort/排序 ~34px; a 2-digit number input ~56px
       prod  38%  — SLACK COLUMN: product name ellipses, SKU beneath
       price 16%  — a "¥ 1,234.56" input ~120px incl. the symbol
       mode  16%  — select holding "Made here"/"现做" ~110px incl. chevron
       avail 12%  — header "In shop"/上架 ~54px; the switch is 40px
       act   10%  — "Remove"/移除 ghost button ~70px incl. padding
                    ────
                    100 */
  function table() {
    if (!_rows.length) {
      return `<div class="shp-empty"><div class="shp-empty-t">${esc(T('No products yet', '还没有商品'))}</div></div>`;
    }
    const rows = _rows.map(r => {
      const busy = _busy.has(r.id);
      const dis = (busy || RO()) ? ' disabled' : '';
      const on = r.is_available === 1;
      const title = on ? T('On the shop · tap to hide', '已上架 · 点按下架') : T('Off the shop · tap to show', '未上架 · 点按上架');
      return `<tr data-id="${r.id}"${busy ? ' class="is-busy"' : ''}>
        <td class="num"><input type="number" min="0" step="1" class="shp-in shp-in-n" value="${esc(r.sort_position)}"
              onchange="shpSaveField(${r.id}, 'sort_position', this)"${dis}></td>
        <td><div class="shp-ell shp-prod">${nameOf(r.name_en, r.name_cn)}</div>
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
              <span class="shp-knob"></span></label></td>
        <td class="act"><button type="button" class="shp-btn ghost sm" data-cap="stores:edit" onclick="shpRemove(${r.id}, this)"${dis}>${esc(T('Remove', '移除'))}</button></td>
      </tr>`;
    }).join('');
    return `<div class="shp-tablewrap"><table class="shp-table">
      <colgroup><col class="shp-c-pos"><col class="shp-c-prod"><col class="shp-c-price"><col class="shp-c-mode"><col class="shp-c-avail"><col class="shp-c-act"></colgroup>
      <thead><tr>
        <th class="num">${esc(T('Sort', '排序'))}</th>
        <th>${esc(T('Product', '产品'))}</th>
        <th class="num">${esc(T('Price', '价格'))}</th>
        <th>${esc(T('Kind', '类型'))}</th>
        <th>${esc(T('In shop', '上架'))}</th>
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

  window.shpPickerToggle = function () {
    _pickerOpen = !_pickerOpen;
    if (_pickerOpen) { _pickQ = ''; fetchPick(); } else paint();
  };
  window.shpPickSearch = function (v) {
    _pickQ = v;
    clearTimeout(_pickTimer);
    _pickTimer = setTimeout(fetchPick, 220);
  };
  async function fetchPick() {
    if (!_shop) return;
    _pickLoading = true; paint();
    const q = _pickQ;
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/candidates?q=' + encodeURIComponent(q));
      if (q !== _pickQ) return;     // a newer search is already in flight
      _pick = j.data || [];
    } catch (e) { _pick = []; toast(errText(e, 'load_failed'), 'err'); }
    _pickLoading = false; paint();
  }

  window.shpAdd = async function (productId, btn) {
    if (!_shop) return;
    if (btn) { btn.disabled = true; btn.textContent = T('Adding…', '添加中…'); }
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings', { method: 'POST', body: { store_product_id: productId } });
      _rows.push(j.data);
      _pick = _pick.filter(p => p.id !== productId);
      paint();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = T('+ Add product', '+ 添加商品'); }
      toast(errText(e, 'save_failed'), 'err');
    }
  };

  // Optimistic flip + repaint, then PATCH; revert on failure so the switch
  // never lies about the live state (09-products.js paToggleShop).
  window.shpToggleAvail = async function (id, on) {
    const r = _rows.find(x => x.id === id);
    if (!r || !_shop) return;
    const was = r.is_available;
    r.is_available = on ? 1 : 0; _busy.add(id); paint();
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings/' + id, { method: 'PATCH', body: { is_available: on ? 1 : 0 } });
      Object.assign(r, j.data);
    } catch (e) {
      r.is_available = was;
      toast(errText(e, 'save_failed'), 'err');
    }
    _busy.delete(id); paint();
  };

  // price · fulfilment_mode · sort_position — one PATCH per change, the control
  // disabled meanwhile, the row re-read from the server's answer. A refused
  // value (bad_price, bad_sort_position) repaints the last saved one.
  window.shpSaveField = async function (id, field, input) {
    const r = _rows.find(x => x.id === id);
    if (!r || !_shop) return;
    const val = input.value;
    _busy.add(id); paint();
    try {
      const j = await api('/api/retail-admin/shops/' + _shop.id + '/listings/' + id, { method: 'PATCH', body: { [field]: val } });
      Object.assign(r, j.data);
      if (field === 'sort_position') _rows.sort((a, b) => (a.sort_position - b.sort_position) || (a.id - b.id));
    } catch (e) { toast(errText(e, 'save_failed'), 'err'); }
    _busy.delete(id); paint();
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
    _busy.delete(id); paint();
  };

  // Keep reload reachable for a future poller; unused today.
  window.shpReload = reload;
})();
