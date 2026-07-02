/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 01/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: bootstrap ($/$$, ICONS, toast/api/escape helpers, payment labels), tab switcher, editor-iframe lazy-load, kitchen-categories editor (cat*) */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const ICONS = {
  open:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  close:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  check:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  image:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  empty:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
};

// Channel glyphs for the combined orders view — monochrome line SVGs (never
// emoji), inherit currentColor, sized by the .chan-ico / inline CSS rules. Keys
// match retail_orders.channel ('' / 'wechat' default = mini app).
const CHAN_ICON = {
  all:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  wechat:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
  web:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>',
  meituan:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7"/><path d="M18 17l-3-8h-3"/><path d="M3 9h4l3.5 8"/><path d="M14 6h3v3"/></svg>',
  gzgrocery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M3 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 3 0"/><line x1="9" y1="20" x2="9" y2="14"/><line x1="15" y1="20" x2="15" y2="14"/></svg>',
};
// Resolve a channel string to its glyph (mini-app 'wechat' is the default).
function chanIcon(channel) {
  const c = String(channel || 'wechat').toLowerCase();
  return CHAN_ICON[c] || CHAN_ICON.wechat;
}

function toast(msg, kind = 'ok', ms) {
  const t = $('#toast');
  t.textContent = msg;
  // Normalize aliases so every caller lands on a styled variant (.ok / .err).
  const cls = (kind === 'error' || kind === 'err') ? 'err'
            : (kind === 'success' || kind === 'ok') ? 'ok'
            : kind;
  t.className = 'toast ' + cls;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._h);
  // Errors linger longer so the operator can read what went wrong before it
  // fades; callers can override with an explicit duration.
  const dur = ms != null ? ms : (cls === 'err' ? 6000 : 2600);
  toast._h = setTimeout(() => t.classList.remove('show'), dur);
}
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (r.status === 401) { location.href = '/backend/login'; throw new Error('401'); }
  const j = await r.json().catch(() => ({ success: false, error: 'bad_response', status: r.status }));
  if (!j.success) {
    // Surface a LOGICAL reason, never a bare "failed". Servers send a stable
    // `error` code (e.g. `use_refund_payout`) and often a human `message`. We
    // build "<human message> [<code>]" so an operator reads why it failed AND
    // gets the exact code to quote in support. When the server gave only a code
    // (no message), `err.message` stays equal to that code — so existing
    // `e.code === '…'` / legacy `e.message === '…'` branches keep matching.
    const code = j.error || ('request_failed (' + r.status + ')');
    const err = new Error(j.message ? `${j.message} [${code}]` : code);
    err.code = j.error || ('http_' + r.status);  // raw code for programmatic checks
    err.data = j;            // carry server detail (e.g. sku_taken `conflict`) to callers
    err.status = r.status;
    throw err;
  }
  return j;
}
// Turn a sku_taken error into a human sentence that NAMES the product holding
// the SKU — including when that product is archived/hidden, which is why the
// operator couldn't find it by searching the grid. Falls back gracefully when
// the server didn't attach a `conflict`.
function skuTakenMsg(skuVal, conflict, sizeLabel) {
  const sku = (skuVal || '').toString().trim();
  const skuTxt = sku ? cuT('SKU “', '货号“') + sku + '”' : cuT('That SKU', '该货号');
  const where = sizeLabel ? cuT(' (size “', '(规格“') + sizeLabel + '”)' : '';
  if (conflict) {
    const nm = cuT(conflict.name_en || conflict.name_cn || ('#' + conflict.id),
                   conflict.name_cn || conflict.name_en || ('#' + conflict.id));
    const vlabel = conflict.variant_label ? ' · ' + conflict.variant_label : '';
    const hidden = Number(conflict.is_active) === 0
      ? cuT(' — that product is archived/deleted, so it won’t show in the list. Restore it or change its SKU to free this code.',
            ' — 该商品已归档/删除,因此不会显示在列表中。请恢复它或修改其货号以释放该编号。')
      : (Number(conflict.is_published) === 0
          ? cuT(' (hidden product — use the “Hidden” filter to find it)', '(已隐藏的商品 — 用“隐藏”筛选查看)')
          : '');
    return skuTxt + where + cuT(' is already used by ', ' 已被 ') + '“' + nm + vlabel + '”' + hidden;
  }
  return skuTxt + where + cuT(' is already in use', ' 已被占用');
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function thumbUrl(p) { return p?.image_url || p?.image_data || ''; }
function fmt(n) { return Number(n || 0).toFixed(2); }

// ── Per-user capabilities (RBAC) — client mirror of the server's req.caps ──
// One operator's effective capability set decides what this app draws: hide the
// nav sections and action buttons they can't use. This is the "same app,
// different view" mechanism (e.g. Quick Stock add-vs-recount), driven by what
// the admin granted rather than hardcoded per role.
//
// Phase 0/1 is DARK: every operator who reaches this shell resolves to the FULL
// set (owner/admin/staff), and an older session sends caps:null which we treat
// as "all allowed" — so applyCapGates() hides nothing today. It's the rendering
// half, ready for when narrower presets/overrides start being assigned.
let CAPS = null;                                    // null = unknown ⇒ all allowed
function can(key)     { return CAPS === null ? true : CAPS.has(key); }
function canAny(keys) { return CAPS === null ? true : keys.some(k => CAPS.has(k)); }
function _capAllows(v){ return Array.isArray(v) ? canAny(v) : can(v); }
function setCaps(list){ CAPS = Array.isArray(list) ? new Set(list) : null; try { applyCapGates(); } catch (e) {} }

// Nav section (data-tab / mobile data-go) → the capability that reveals it. An
// array means "any of these". Untracked tabs stay visible. Settings (config) is
// shown if the operator holds any one of its sub-area caps.
const TAB_CAP = {
  dashboard: 'dashboard:view', orders: 'orders:view', invoices: 'invoices:view',
  customers: 'customers:view', products: 'products:view', categories: 'categories:view',
  'mini-app-editor': 'editor:view', vouchers: 'coupons:view', flash: 'flash:view',
  popups: 'popups:view', affiliate: 'affiliate:view', sharing: 'sharing:edit',
  broadcasts: 'broadcasts:view', social: 'social:edit', membership: 'loyalty:view',
  topup: 'topup:edit', leaderboard: 'leaderboard:edit', voting: 'voting:edit',
  snippets: 'content:view', about: 'content:view', legal: 'content:view', faq: 'content:view',
  media: 'media:view', reviews: 'reviews:view', feedback: 'feedback:view',
  delivery: 'delivery:view', meituan: 'meituan:view', guanyi: 'guanyi:view',
  activity: 'activity:view',
  config: ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'],
};
// Hide nav sections + any [data-cap]-tagged control the operator can't use, then
// collapse a dropdown group whose every child tab ended up hidden.
function applyCapGates() {
  document.querySelectorAll('.tabs [data-tab]').forEach(btn => {
    const cap = TAB_CAP[btn.dataset.tab];
    if (cap === undefined) return;
    btn.style.display = _capAllows(cap) ? '' : 'none';
  });
  document.querySelectorAll('#rm-bottomnav [data-go]').forEach(btn => {
    const cap = TAB_CAP[btn.dataset.go];
    if (cap === undefined) return;
    btn.style.display = _capAllows(cap) ? '' : 'none';
  });
  document.querySelectorAll('.tabs-group').forEach(g => {
    const anyVisible = Array.prototype.some.call(g.querySelectorAll('[data-tab]'), t => t.style.display !== 'none');
    const trig = g.querySelector('.tabs-group-trigger');
    if (trig) trig.style.display = anyVisible ? '' : 'none';
  });
  // Generic hook: tag any button/section with data-cap="x" (or "x y" for any-of)
  // and it disappears for operators without it. Used by section files in later phases.
  document.querySelectorAll('[data-cap]').forEach(el => {
    const v = el.dataset.cap.trim();
    el.style.display = _capAllows(v.includes(' ') ? v.split(/\s+/) : v) ? '' : 'none';
  });
}
window.can = can; window.canAny = canAny; window.applyCapGates = applyCapGates; window.setCaps = setCaps;

// ── Payment-brand badge — small colored chip with the WeChat / Alipay
// logo + bilingual label. Used in the order drawer Payment tile and in
// the top-up history rows so admins can scan "what paid with what" at
// a glance instead of reading the raw "wechat" / "alipay" string.
// `size`: 'sm' (default, inline) | 'lg' (drawer hero treatment).
function paymentBrandHTML(method, size) {
  const m = String(method || '').toLowerCase().trim();
  const isWeChat = (m === 'wechat' || m === 'weixin' || m === 'wechatpay' || m === 'wechat_pay' || m === '微信' || m === '微信支付');
  const isAlipay = (m === 'alipay' || m === 'zhifubao' || m === '支付宝');
  const big = size === 'lg';
  const iconSize = big ? 22 : 18;
  if (isWeChat) {
    // Simplified WeChat logo: rounded square in brand green with two
    // chat-bubble glyphs (one slightly behind the other). Keeps the
    // file inline-only — no external image fetch.
    const svg = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1aad19"/>
      <path d="M12.5 9.2c-3.6 0-6.5 2.4-6.5 5.4 0 1.7 1 3.2 2.5 4.2l-.6 1.9 2.3-1.2c.7.2 1.5.4 2.3.4.2 0 .4 0 .6-.1-.1-.4-.2-.9-.2-1.3 0-2.9 2.7-5.2 6-5.2.2 0 .4 0 .6.1-.4-2.4-3-4.2-6-4.2zm-2.4 2.9c.5 0 .9.3.9.8s-.4.8-.9.8-.9-.3-.9-.8.4-.8.9-.8zm5 0c.5 0 .9.3.9.8s-.4.8-.9.8-.9-.3-.9-.8.4-.8.9-.8z" fill="#fff"/>
      <path d="M24.7 17.6c0-2.5-2.5-4.5-5.5-4.5s-5.5 2-5.5 4.5 2.5 4.5 5.5 4.5c.6 0 1.2-.1 1.7-.3l1.8 1-.5-1.6c1.3-.8 2.5-2.1 2.5-3.6zm-7.4-1c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7zm3.9 0c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7z" fill="#fff"/>
    </svg>`;
    return `<span class="pay-brand pay-brand-wechat${big?' lg':''}">${svg}<span class="lbl">WeChat${big?' · 微信':''}</span></span>`;
  }
  if (isAlipay) {
    // Simplified Alipay logo: rounded square in brand blue with a bold
    // "支" character. Recognisable at small sizes; doesn't try to
    // replicate the official wordmark.
    const svg = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1677ff"/>
      <text x="16" y="23" text-anchor="middle" font-size="20" font-weight="900" fill="#fff" font-family="Arial, 'PingFang SC', sans-serif">支</text>
    </svg>`;
    return `<span class="pay-brand pay-brand-alipay${big?' lg':''}">${svg}<span class="lbl">Alipay${big?' · 支付宝':''}</span></span>`;
  }
  // Off-app tender confirmed via "Mark paid" — friendly bilingual label, no
  // gateway badge (the operator didn't use the in-app gateway).
  const offline = { cash: 'Cash · 现金', bank_transfer: 'Bank transfer · 银行转账', wechat_offline: 'WeChat off-app · 微信(线下)', alipay_offline: 'Alipay off-app · 支付宝(线下)', other: 'Other · 其他' }[m];
  if (offline) return `<b>${offline}</b>`;
  // Unknown / dash — keep as plain text so we don't invent a brand the
  // operator didn't actually use.
  return `<b>${escapeHtml(method || '—')}</b>`;
}

// The payment row to surface on an order. An order can carry more than one
// payment row — e.g. a checkout placeholder that stayed 'pending' (the gateway
// callback never landed) plus the settled row written when staff marked it
// paid off-app. Prefer the settled one so a paid order never reads "pending".
function primaryPayment(o) {
  const list = o?.payments || [];
  return list.find(p => p.status === 'success')
      || list.find(p => p.status === 'refunded')
      || list[list.length - 1]
      || null;
}
// Friendly, bilingual label for a raw payment status.
function paymentStatusLabel(s) {
  return { success: 'paid · 已付', pending: 'pending · 待付', created: 'pending · 待付',
           refunded: 'refunded · 已退', failed: 'failed · 失败' }[s] || (s || '—');
}

// ── Tab switcher — supports flat tabs AND dropdown groups ──
// Buttons with data-tab activate a section. Buttons without (the group
// triggers) just toggle their popover open. The parent .tabs-group gets
// .has-active when one of its child tabs is the current active tab, so
// the trigger picks up the same accent underline as a direct tab.
$$('.tabs [data-tab]').forEach(btn => btn.addEventListener('click', () => {
  // Switching tabs dismisses any open side-drawer (order/customer detail,
  // editors) so it doesn't hang over the newly-shown section.
  $$('.side-drawer.open').forEach(d => closeDrawer(d));
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b === btn));
  $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  $$('.tabs-group').forEach(g => g.classList.toggle('has-active', g.contains(btn)));
  // Accordion rail: keep the active tab's group expanded; collapse the others.
  $$('.tabs-group').forEach(g => g.classList.toggle('open', g.contains(btn)));
}));
// Sales overview → jump into a single channel's full admin. The "Configure"
// buttons on #tab-sales call this; it clicks the channel's rail button, which
// activates that tab AND fires its existing init (mtAdminInit / gyAdminInit /
// elAdminInit) via that button's own onclick. Keeps one source of truth for
// tab activation instead of re-implementing it here.
function salesGo(channel) {
  const btn = document.querySelector('.tabs [data-tab="' + channel + '"]');
  if (btn) btn.click();
}
// Activate a tab/section by name from OUTSIDE the rail (e.g. the topbar Inbox
// dropdown, whose Reviews/Feedback items no longer live in .tabs so the rail
// click-handler can't see them). Mirrors that handler's section + group state.
function goTab(tab) {
  $$('.side-drawer.open').forEach(d => closeDrawer(d));
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('main section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  $$('.tabs-group').forEach(g => {
    const has = !!g.querySelector('[data-tab="' + tab + '"]');
    g.classList.toggle('has-active', has);
    g.classList.toggle('open', has);
  });
}
// Topbar Inbox dropdown (Reviews / Feedback).
function toggleInboxMenu(ev) {
  if (ev) ev.stopPropagation();
  const m = document.getElementById('tbInboxMenu');
  const b = document.getElementById('tbInboxBtn');
  if (!m) return;
  const willOpen = m.hasAttribute('hidden');
  m.toggleAttribute('hidden', !willOpen);
  if (b) b.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}
function closeInboxMenu() {
  const m = document.getElementById('tbInboxMenu');
  const b = document.getElementById('tbInboxBtn');
  if (m) m.setAttribute('hidden', '');
  if (b) b.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (ev) => {
  if (!ev.target.closest || !ev.target.closest('#tbInbox')) closeInboxMenu();
});
// Sales overview → fill today's per-channel figures + the folded summary from
// /sales/summary. Called when the Sales tab is opened. Leaves the "—"
// placeholders in place on any error rather than blanking the page. dashMoney
// (part 03) is loaded by the time a tab can be clicked.
async function salesInit() {
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const money = (n) => (typeof dashMoney === 'function' ? dashMoney(n) : '¥' + Number(n || 0));
  const num   = (n) => Number(n || 0).toLocaleString();
  try {
    const j = await api('/api/retail-admin/sales/summary');
    const s = j.summary || {}, c = j.channels || {};
    set('sales-sum-rev', money(s.revenue));
    set('sales-sum-orders', num(s.orders));
    set('sales-sum-aov', money(s.aov));
    const active = document.getElementById('sales-sum-active');
    if (active) active.innerHTML = num(s.active) + ' <span class="sales-of">/ ' + (s.total || 3) + '</span>';
    const fill = (k, ch) => {
      if (!ch) return;
      set('sales-' + k + '-rev', money(ch.revenue));
      set('sales-' + k + '-orders', num(ch.orders));
      set('sales-' + k + '-aov', money(ch.aov));
      set('sales-' + k + '-extra', num(ch.extra));
    };
    fill('wc', c.wechat);
    fill('wb', c.web);
    fill('mt', c.meituan);
    fill('gy', c.gzgrocery);
    fill('el', c.eleme);
  } catch (e) { /* keep placeholders on error */ }
  csLoad();  // unlock + wire the channel-close toggles (channel × location)
}

// ── Sales channel × location close controls ──────────────────────────────────
// The Sales-page channel cards ship with a LOCKED toggle. We unlock + wire the
// close behaviour here WITHOUT editing the HTML (that file is co-edited):
//   • a channel toggle opens a popup with a per-location toggle + "close all"
//   • gzgrocery (tianhe-only) toggles directly, no popup
//   • two injected location-master buttons close every channel of a location
// Backend: /api/retail-admin/channel-status (+ /cell, /channel, /location).
const CS_KEY2CH = { wc: 'mini_app', wb: 'web', mt: 'meituan', gy: 'gzgrocery', el: 'eleme' };
function csName(ch) {
  return ({ mini_app: cuT('Mini app', '小程序'), web: cuT('Web shop', '网页商店'),
            meituan: cuT('Meituan', '美团'), eleme: cuT('Eleme', '饿了么'), gzgrocery: 'gzgrocery' })[ch] || ch;
}
let _csData = null;
function csChannel(key) { return ((_csData && _csData.channels) || []).find(c => c.channel === key); }
// Store name that follows the EN/中文 toggle. Falls back to data-no-i18n when
// only one name exists (or both are identical) so the walker leaves it alone.
function csStoreName(o) {
  const en = o.nameEn || o.name || '';
  const cn = o.nameCn || o.name || '';
  if (!en || !cn || en === cn) return '<span data-no-i18n>' + escapeHtml(en || cn) + '</span>';
  return '<span data-lang-block="en">' + escapeHtml(en) + '</span><span data-lang-block="cn">' + escapeHtml(cn) + '</span>';
}

async function csLoad() {
  try { _csData = await api('/api/retail-admin/channel-status'); csRender(); }
  catch (e) { /* leave the cards untouched on error */ }
}

function csRender() {
  if (!_csData) return;
  document.querySelectorAll('.sales-ch').forEach((card) => {
    const m = card.querySelector('[id^="sales-"][id$="-rev"]');
    const mm = m && m.id.match(/^sales-(\w+)-rev$/);
    const ch = mm && CS_KEY2CH[mm[1]];
    const info = ch && csChannel(ch);
    const btn = card.querySelector('.sales-toggle');
    if (!info || !btn) return;
    btn.disabled = false; btn.removeAttribute('disabled'); btn.classList.remove('is-locked');
    btn.title = cuT('Open / close by location', '按门店开关');
    // Mixed state: open in some locations, closed in others → half-lit toggle.
    const cells = info.cells || [];
    const openCount = cells.filter(c => c.open).length;
    const partial = cells.length > 1 && openCount > 0 && openCount < cells.length;
    btn.classList.toggle('partial', partial);
    btn.classList.toggle('on', !partial && !!info.cardOpen);
    btn.onclick = () => { if (ch === 'gzgrocery') csToggleGz(info); else csPopup(ch); };
  });
  csRenderLocations();
}

function csRenderLocations() {
  const grid = document.querySelector('.sales-grid');
  if (!grid) return;
  let bar = document.getElementById('cs-locations');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'cs-locations';
    bar.className = 'sales-locbar';
    grid.parentNode.insertBefore(bar, grid);
  }
  const locs = (_csData && _csData.locations) || [];
  const storeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';
  bar.innerHTML = '<span class="sales-locbar-lead">' + storeIcon + '<span>' + cuT('Close a whole location', '关闭整个门店') + '</span></span>'
    + '<span class="sales-locbar-pills">'
    + locs.map((l) => '<button class="sales-locpill' + (l.allOpen ? '' : ' closed') + '" onclick="csLocation(\'' + l.storeCode + '\',' + (l.allOpen ? 'false' : 'true') + ')"><span class="nm">' + csStoreName(l) + '</span><span class="act">' + (l.allOpen ? cuT('Close all', '全部关闭') : cuT('Open all', '全部开启')) + '</span></button>').join('')
    + '</span>';
}

function csToggleGz(info) {
  const open = !info.cardOpen;
  if (!window.confirm(open ? cuT('Open gzgrocery?', '开启 gzgrocery?')
                           : cuT('Close gzgrocery? It will stop importing new orders.', '关闭 gzgrocery?将停止导入新订单。'))) return;
  api('/api/retail-admin/channel-status/cell', { method: 'POST', body: { channel: 'gzgrocery', storeCode: 'tianhe', open } })
    .then(() => { if (window.toast) toast(cuT('Saved', '已保存')); return csLoad(); })
    .catch((e) => { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); });
}

function csPopup(ch) {
  const info = csChannel(ch);
  if (!info) return;
  let ov = document.getElementById('cs-popup');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cs-popup';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(ov);
    ov.onclick = () => csClosePopup();
  }
  const rows = (info.cells || []).map((c) => {
    const note = (ch === 'meituan' && c.pending) ? ' <span class="muted" style="font-size:11px">' + cuT('applying…', '处理中…') + '</span>' : '';
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)">'
      + '<span style="width:9px;height:9px;border-radius:50%;flex:none;background:' + (c.open ? '#1a9d5a' : 'var(--danger,#d33)') + '"></span>'
      + '<div style="flex:1;min-width:0">' + csStoreName(c) + note + '</div>'
      + '<button class="btn btn-sm' + (c.open ? '' : ' btn-primary') + '" onclick="csCell(\'' + ch + '\',\'' + c.storeCode + '\',' + (c.open ? 'false' : 'true') + ')">' + (c.open ? cuT('Close', '关闭') : cuT('Open', '开启')) + '</button>'
      + '</div>';
  }).join('');
  ov.innerHTML = '<div style="background:var(--bg-pane,#fff);border:1px solid var(--line);border-radius:16px;max-width:400px;width:100%;padding:18px 20px;box-shadow:0 20px 60px rgba(18,22,26,.28)" onclick="event.stopPropagation()">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b style="font-size:15px">' + csName(ch) + ' — ' + cuT('by location', '按门店') + '</b><button class="btn btn-sm" onclick="csClosePopup()">✕</button></div>'
    + (ch === 'eleme' ? '<div class="muted" style="font-size:12px;margin-bottom:8px">' + cuT('Eleme isn’t connected yet — placeholder.', '饿了么尚未接入 — 仅占位。') + '</div>' : '')
    + rows
    + '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">'
    + '<button class="btn btn-sm" onclick="csChannelAll(\'' + ch + '\',false)">' + cuT('Close all', '全部关闭') + '</button>'
    + '<button class="btn btn-sm btn-primary" onclick="csChannelAll(\'' + ch + '\',true)">' + cuT('Open all', '全部开启') + '</button>'
    + '</div></div>';
}
window.csClosePopup = function () { const ov = document.getElementById('cs-popup'); if (ov) ov.remove(); };
window.csCell = async function (ch, storeCode, open) {
  try { await api('/api/retail-admin/channel-status/cell', { method: 'POST', body: { channel: ch, storeCode, open } }); await csLoad(); csPopup(ch); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
window.csChannelAll = async function (ch, open) {
  try { await api('/api/retail-admin/channel-status/channel', { method: 'POST', body: { channel: ch, open } }); await csLoad(); csPopup(ch); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
window.csLocation = async function (storeCode, open) {
  if (!window.confirm(open ? cuT('Open ALL sales channels for this location?', '开启该门店的所有销售渠道?')
                           : cuT('Close ALL sales channels for this location?', '关闭该门店的所有销售渠道?'))) return;
  try { await api('/api/retail-admin/channel-status/location', { method: 'POST', body: { storeCode, open } }); if (window.toast) toast(cuT('Done', '完成')); await csLoad(); }
  catch (e) { if (window.toast) toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
};
// Embedded editor — lazy-load the Mini App Editor iframe the first time the
// Editor tab is opened, so the big editor app doesn't download until needed.
(function () {
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  const frame = document.getElementById('frame-mini-app-editor');
  if (btn && frame) btn.addEventListener('click', () => { if (!frame.getAttribute('src')) frame.src = frame.dataset.src; });
})();
// Switch to the Editor tab in-page (shows the Mini App Editor). Re-clicking the
// already-active tab also returns here from the Product Page Editor.
function openMiniAppEditor() {
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  if (btn) btn.click();
}
// Reveal the Product Page Editor under the single Editor tab: keep the Editor
// tab active, hide the Mini App Editor section, show the product section
// (lazy-loading its iframe on first reveal).
function showProductSection() {
  const frame = document.getElementById('frame-product-editor');
  if (frame && !frame.getAttribute('src')) frame.src = frame.dataset.src;
  document.getElementById('tab-mini-app-editor')?.classList.remove('active');
  document.getElementById('tab-product-editor')?.classList.add('active');
}
// Open the Product Page Editor on a specific product, in-page: point its iframe
// at that product, activate the Editor tab, then reveal the product section.
function openProductEditor(id) {
  const frame = document.getElementById('frame-product-editor');
  if (frame) frame.src = '/product-editor?id=' + encodeURIComponent(id);
  const btn = document.querySelector('.tabs [data-tab="mini-app-editor"]');
  if (btn) btn.click();   // activate Editor tab (hides every other section)
  showProductSection();
}
// The embedded Mini App Editor posts here when its PAGE dropdown's "Products"
// entry is chosen — reveal the Product Page Editor under the same Editor tab
// (lazy-loads its iframe, then lands on its product picker). "mini-app" posts
// back here to return to the storefront-pages view.
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || d.type !== 'fc-open-editor') return;
  if (d.editor === 'product') {
    showProductSection();
  } else if (d.editor === 'mini-app') {
    openMiniAppEditor();
    // Returning from the product editor — pop the Mini App Editor's PAGE menu
    // open so the operator lands right on the page chooser.
    if (d.openPages) {
      const f = document.getElementById('frame-mini-app-editor');
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'fc-open-pages' }, location.origin);
    }
  }
});
// Group trigger toggles its popover; only one group open at a time.
$$('.tabs-group-trigger').forEach(btn => btn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const group = btn.closest('.tabs-group');
  const wasOpen = group.classList.contains('open');
  $$('.tabs-group.open').forEach(g => g.classList.remove('open'));
  if (!wasOpen) group.classList.add('open');
}));
// The vertical rail is an inline accordion — groups stay expanded while you
// work in the content area, so the old click-outside-to-close handler is gone.
// ── Categories editor ────────────────────────────────────────────────────
// Loads the live 2-level tree, lets the operator rename (EN/CN), add, remove
// and reorder tops + subs, then saves the whole tree back. Server migrates
// product rows on rename (matched by stable id). Lazy-loaded on first open.
let catModel = [];        // working copy: [{ id, name, name_cn, subs:[{id,name,name_cn}] }]
let catClean = '[]';      // JSON of the last-saved tree, for dirty tracking
let catLoaded = false;

async function catLoad() {
  try {
    const j = await api('/api/retail-admin/category-tree');
    catModel = Array.isArray(j.data) ? JSON.parse(JSON.stringify(j.data)) : [];
    catClean = JSON.stringify(catModel);
    catLoaded = true;
    catRender();
    catUpdateDirty();
  } catch (e) { toast('Failed to load categories · 加载分类失败', 'err'); }
}

function catIsDirty() { return JSON.stringify(catModel) !== catClean; }
// Every top + sub needs an English name before the tree can be saved (mirrors
// the server guard). Autosave waits silently until this holds — no error toast.
function catIsValid() {
  for (const t of catModel) {
    if (!String(t.name || '').trim()) return false;
    for (const s of (t.subs || [])) if (!String(s.name || '').trim()) return false;
  }
  return true;
}
let _catSaveTimer = null;
let _catSaving = false;
// Debounced autosave: fires ~1.2s after the last edit (rename/add/remove/reorder)
// once the tree is dirty AND valid. The short pause lets a half-typed name settle
// before we persist + re-tag products. A save already in flight reschedules.
function catScheduleAutosave() {
  if (_catSaveTimer) clearTimeout(_catSaveTimer);
  _catSaveTimer = setTimeout(() => {
    _catSaveTimer = null;
    if (_catSaving || !catIsDirty() || !catIsValid()) return;
    catSave({ auto: true });
  }, 1200);
}
function catUpdateDirty() {
  const dirty = catIsDirty();
  const el = $('#cat-dirty');
  if (el) {
    if (!dirty) { el.textContent = _catSaving ? '' : '✓ Saved · 已保存'; el.style.color = 'var(--muted)'; }
    else if (!catIsValid()) { el.textContent = '● Add a name to auto-save · 填写名称后自动保存'; el.style.color = '#b45309'; }
    else { el.textContent = '○ Saving… · 自动保存中'; el.style.color = 'var(--muted)'; }
  }
  if (dirty) catScheduleAutosave();
}
// Re-render the tree but keep the caret in whatever name field is focused, so an
// autosave mid-session doesn't yank focus out of the input being typed into.
function catRenderKeepFocus() {
  const a = document.activeElement;
  let rid = null, f = null, start = null, end = null;
  if (a && a.matches && a.matches('#cat-editor input.cat-name')) {
    const row = a.closest('.cat-top, .cat-subrow');
    if (row) { rid = row.id; f = a.dataset.f; start = a.selectionStart; end = a.selectionEnd; }
  }
  catRender();
  if (rid && f) {
    const el = document.querySelector('#' + rid + ' input[data-f="' + f + '"]');
    if (el) { el.focus(); try { el.setSelectionRange(start, end); } catch (e) {} }
  }
}
// Update a field WITHOUT re-rendering (keeps input focus while typing).
function catSet(ti, si, field, val) {
  const node = si < 0 ? catModel[ti] : catModel[ti].subs[si];
  if (!node) return;
  node[field] = val;
  catUpdateDirty();
}
function catAddTop() {
  catModel.push({ id: '', name: '', name_cn: '', subs: [] });
  catRender(); catUpdateDirty();
  // focus the new top's EN input
  const inp = document.querySelector(`#cat-top-${catModel.length - 1} input[data-f="name"]`);
  if (inp) inp.focus();
}
function catRemoveTop(ti) {
  const t = catModel[ti]; if (!t) return;
  const n = (t.subs || []).length;
  const msg = n
    ? `Remove "${t.name || 'this category'}" and its ${n} subcategor${n === 1 ? 'y' : 'ies'}?\n删除该主分类及其 ${n} 个子分类？\n\nProducts keep their tag until re-assigned. · 产品标签保留，直到重新分配。`
    : `Remove "${t.name || 'this category'}"? · 删除该主分类？`;
  if (!confirm(msg)) return;
  catModel.splice(ti, 1); catRender(); catUpdateDirty();
}
function catAddSub(ti) {
  catModel[ti].subs = catModel[ti].subs || [];
  catModel[ti].subs.push({ id: '', name: '', name_cn: '' });
  catRender(); catUpdateDirty();
  const subs = catModel[ti].subs;
  const inp = document.querySelector(`#cat-sub-${ti}-${subs.length - 1} input[data-f="name"]`);
  if (inp) inp.focus();
}
function catRemoveSub(ti, si) {
  catModel[ti].subs.splice(si, 1); catRender(); catUpdateDirty();
}

// Structure summary — computed in-browser from the live catModel (no fetch), so
// it tracks unsaved adds/removes as the operator edits. Empty = top categories
// with zero subs (a structural gap, since the shop hides empty categories).
let _CAT_KPI_LANG_HOOKED = false;
function catRenderKpis() {
  if (!document.getElementById('cat-kpis')) return;
  if (!_CAT_KPI_LANG_HOOKED && window.onLangChange) { _CAT_KPI_LANG_HOOKED = true; onLangChange(catRenderKpis); }
  const tops = Array.isArray(catModel) ? catModel : [];
  let subTotal = 0, empty = 0;
  for (const t of tops) { const n = (t.subs || []).length; subTotal += n; if (!n) empty++; }
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = fcNum(n); };
  set('cat-kpi-top', tops.length);
  set('cat-kpi-sub', subTotal);
  set('cat-kpi-empty', empty);
  const tile = document.getElementById('cat-kpi-empty-tile'); if (tile) tile.classList.toggle('alert', empty > 0);
  const sub = document.getElementById('cat-kpi-empty-sub');
  if (sub) sub.textContent = empty > 0 ? cuT('no subcategories yet', '尚无子分类') : cuT('all populated', '均有子分类');
}

function catRender() {
  const host = $('#cat-editor'); if (!host) return;
  catRenderKpis();
  if (!catModel.length) {
    host.innerHTML = `<div class="card" style="text-align:center;color:var(--muted);padding:28px;">No categories yet · 暂无分类<br><br><button class="btn btn-sm" type="button" onclick="catAddTop()">＋ Add top category · 新增主分类</button></div>`;
    return;
  }
  host.innerHTML = catModel.map((t, ti) => {
    const subs = (t.subs || []).map((s, si) => `
      <div class="cat-subrow" id="cat-sub-${ti}-${si}" data-fk="s${catFk(s)}"
           ondragover="catDragOver(event,'sub',${ti},${si})" ondrop="catDrop(event,'sub',${ti},${si})" ondragleave="catDragLeave(event)"
           style="display:flex;gap:6px;align-items:center;padding:5px 0;">
        <span class="cat-drag" draggable="true" title="Drag to reorder · 拖动排序"
              ondragstart="catDragStart(event,'sub',${ti},${si})" ondragend="catDragEnd()">⠿</span>
        <input type="text" class="input cat-name" data-f="name" value="${escapeAttr(s.name)}" placeholder="Subcategory (EN)" oninput="catSet(${ti},${si},'name',this.value)">
        <input type="text" class="input cat-name" data-f="name_cn" value="${escapeAttr(s.name_cn)}" placeholder="子分类 (中文)" oninput="catSet(${ti},${si},'name_cn',this.value)">
        <button class="btn btn-sm cat-edit" type="button" title="Edit this subcategory & its products · 编辑子分类及其产品" onclick="catOpenDetail('sub',${ti},${si})">Edit · 编辑</button>
        <button class="btn-icon cat-del" type="button" title="Remove subcategory · 删除子分类" onclick="catRemoveSub(${ti},${si})">✕</button>
      </div>`).join('');
    return `
    <div class="card cat-top" id="cat-top-${ti}" data-fk="t${catFk(t)}"
         ondragover="catDragOver(event,'top',${ti})" ondrop="catDrop(event,'top',${ti})" ondragleave="catDragLeave(event)"
         style="margin-bottom:var(--s4);">
      <div class="cat-top-head" style="display:flex;gap:8px;align-items:center;margin-bottom:var(--s3);">
        <span class="cat-drag cat-drag-top" draggable="true" title="Drag to reorder · 拖动排序"
              ondragstart="catDragStart(event,'top',${ti})" ondragend="catDragEnd()">⠿</span>
        <input type="text" class="input cat-name" data-f="name" value="${escapeAttr(t.name)}" placeholder="Top category (EN)" oninput="catSet(${ti},-1,'name',this.value)">
        <input type="text" class="input cat-name" data-f="name_cn" value="${escapeAttr(t.name_cn)}" placeholder="主分类 (中文)" oninput="catSet(${ti},-1,'name_cn',this.value)">
        <button class="btn btn-sm cat-edit" type="button" title="Edit this category & its products · 编辑分类及其产品" onclick="catOpenDetail('top',${ti})" style="margin-left:auto;">Edit · 编辑</button>
        <button class="btn btn-sm cat-del" type="button" onclick="catRemoveTop(${ti})">Remove · 删除</button>
      </div>
      <div style="padding-left:34px;">
        ${(t.subs || []).length ? `<div class="cat-subs-kicker">${(t.subs).length} subcategor${(t.subs).length === 1 ? 'y' : 'ies'} · 子分类</div>` : ''}
        ${subs || '<div class="muted" style="font-size:12px;padding:4px 0;">No subcategories · 无子分类</div>'}
        <button class="btn btn-sm" type="button" onclick="catAddSub(${ti})" style="margin-top:8px;">＋ Add subcategory · 新增子分类</button>
      </div>
    </div>`;
  }).join('');
}

// ── Drag-and-drop reordering ───────────────────────────────────────────────
// Tops reorder among themselves; subs reorder only WITHIN their parent top
// (no cross-parent move, which keeps the rename-migration model simple — a
// reorder changes neither name nor parent, so it never touches product rows).
//
// Motion: every layout change (fold on dragstart, unfold on dragend, re-sort
// on drop) is FLIP-animated so rows glide instead of snapping — same floating
// feel as the orders manifest re-sort. Keys live in a WeakMap (not on the
// model) so the save payload and dirty-diff never see them.
const _catFk = new WeakMap(); let _catFkSeq = 0;
function catFk(o) { let k = _catFk.get(o); if (!k) { k = ++_catFkSeq; _catFk.set(o, k); } return k; }
// Like flipReorder, but corrects nested rows (subrows inside an animating top
// card) by subtracting the nearest animated ancestor's delta — both levels
// share the same curve, so the composite still lands exactly.
function catFlip(swap) {
  const host = document.getElementById('cat-editor');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!host || reduce) { swap(); return; }
  const first = new Map();
  host.querySelectorAll('[data-fk]').forEach(el => first.set(el.dataset.fk, el.getBoundingClientRect()));
  swap();
  const els = Array.from(host.querySelectorAll('[data-fk]'));
  const delta = new Map();
  els.forEach(el => {
    const a = first.get(el.dataset.fk);
    if (!a) return;
    const b = el.getBoundingClientRect();
    delta.set(el, { dx: a.left - b.left, dy: a.top - b.top });
  });
  els.forEach(el => {
    const d = delta.get(el); if (!d) return;
    let dx = d.dx, dy = d.dy;
    for (let p = el.parentElement; p && p !== host; p = p.parentElement) {
      const pd = delta.get(p);
      if (pd) { dx -= pd.dx; dy -= pd.dy; break; }
    }
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 320ms cubic-bezier(.22,.61,.36,1)';
      el.style.transform = '';
      el.addEventListener('transitionend', () => {
        el.style.transition = '';
        el.style.transform = '';
      }, { once: true });
    });
  });
}
let catDrag = null;   // { kind:'top'|'sub', ti, si }
function catDragStart(ev, kind, ti, si) {
  catDrag = { kind, ti, si };
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', kind); } catch (e) {}
  const row = ev.target.closest('.cat-top, .cat-subrow');
  // Float the whole row as the drag ghost (not just the ⠿ grip).
  if (row && ev.dataTransfer.setDragImage) {
    try {
      const r = row.getBoundingClientRect();
      ev.dataTransfer.setDragImage(row, ev.clientX - r.left, ev.clientY - r.top);
    } catch (e) {}
  }
  // Mark only the row being dragged (dimmed); the rest of the list stays
  // EXACTLY where it is — no fold, no reflow — so the operator keeps their
  // bearings and the live insertion line is the single source of "lands here".
  // Done next tick so changing the row mid-dragstart can't cancel the drag.
  setTimeout(() => { if (catDrag && row) row.classList.add('cat-dragging'); }, 0);
}
function catClearDropCues() {
  $$('.cat-drop-before, .cat-drop-after').forEach(el => el.classList.remove('cat-drop-before', 'cat-drop-after'));
}
function catDragEnd() {
  catDrag = null;
  $$('.cat-dragging').forEach(el => el.classList.remove('cat-dragging'));
  catClearDropCues();
}
function catDragOver(ev, kind, ti, si) {
  if (!catDrag || catDrag.kind !== kind) return;          // only same-kind drops
  if (kind === 'sub' && catDrag.ti !== ti) return;        // subs stay in their top
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const row = ev.currentTarget;
  // Draw the insertion line on the edge facing the move direction — that edge
  // IS where the row will land (matches the splice in catDrop), so you see the
  // exact slot before releasing.
  const from = kind === 'top' ? catDrag.ti : catDrag.si;
  const to   = kind === 'top' ? ti : si;
  catClearDropCues();
  if (to === from) return;            // hovering its own row → no line
  row.classList.add(to < from ? 'cat-drop-before' : 'cat-drop-after');
}
function catDragLeave(ev) { ev.currentTarget.classList.remove('cat-drop-before', 'cat-drop-after'); }
function catDrop(ev, kind, ti, si) {
  if (!catDrag || catDrag.kind !== kind) return;
  ev.preventDefault();
  let moved = null;
  if (kind === 'top') {
    const from = catDrag.ti;
    if (from !== ti) { moved = catModel.splice(from, 1)[0]; catModel.splice(ti, 0, moved); }
  } else {
    if (catDrag.ti !== ti) { catDragEnd(); return; }
    const subs = catModel[ti].subs, from = catDrag.si;
    if (from !== si) { moved = subs.splice(from, 1)[0]; subs.splice(si, 0, moved); }
  }
  // FLIP the re-sort so the rows glide from their old spots to their new ones
  // — the only motion in the whole interaction, and it shows the result.
  catDrag = null;
  catClearDropCues();
  catFlip(() => { catRender(); });   // re-render drops the dragging/drop-cue classes
  if (moved) {
    const el = document.querySelector(`#cat-editor [data-fk="${kind === 'top' ? 't' : 's'}${catFk(moved)}"]`);
    if (el) { el.classList.add('cat-landed'); el.addEventListener('animationend', () => el.classList.remove('cat-landed'), { once: true }); }
  }
  catUpdateDirty();
}

async function catSave(opts) {
  const auto = !!(opts && opts.auto);
  // Client-side guards mirror the server: no blank names, no dups. On a manual
  // save we tell the operator why; autosave just waits silently (it only fires
  // when valid anyway) so a half-finished name never throws an error toast.
  for (const t of catModel) {
    if (!String(t.name || '').trim()) { if (!auto) toast('Every top category needs an English name · 主分类需填英文名', 'err'); return; }
    for (const s of (t.subs || [])) {
      if (!String(s.name || '').trim()) { if (!auto) toast('Every subcategory needs an English name · 子分类需填英文名', 'err'); return; }
    }
  }
  if (_catSaving) return;
  _catSaving = true;
  if (_catSaveTimer) { clearTimeout(_catSaveTimer); _catSaveTimer = null; }
  const btn = $('#cat-save-btn'); if (btn && !auto) { btn.disabled = true; btn.textContent = 'Saving… · 保存中'; }
  const ind = $('#cat-dirty'); if (ind) { ind.textContent = '○ Saving… · 保存中'; ind.style.color = 'var(--muted)'; }
  try {
    const j = await api('/api/retail-admin/category-tree', { method: 'PUT', body: { tree: catModel } });
    catModel = Array.isArray(j.data) ? JSON.parse(JSON.stringify(j.data)) : catModel;
    catClean = JSON.stringify(catModel);
    // Keep the operator's caret put when an autosave repaints mid-typing.
    if (auto) catRenderKeepFocus(); else catRender();
    // Invalidate the product-editor's cached tree so its Shop-section /
    // Subcategory dropdowns pick up the renamed/added/removed nodes.
    if (typeof PA_CAT_TREE !== 'undefined') PA_CAT_TREE = [];
    const moved = j.migrated || 0;
    // Manual save always confirms; autosave only speaks up when it re-tagged
    // products (a real side effect worth surfacing), staying quiet otherwise.
    if (!auto) toast(moved ? `Saved · ${moved} product${moved === 1 ? '' : 's'} re-tagged · 已保存，迁移 ${moved} 个产品` : 'Saved · 已保存', 'ok');
    else if (moved) toast(`Auto-saved · ${moved} product${moved === 1 ? '' : 's'} re-tagged · 已自动保存，迁移 ${moved} 个产品`, 'ok');
  } catch (e) {
    toast((e && e.message) ? ('Save failed: ' + e.message) : 'Save failed · 保存失败', 'err');
  } finally {
    _catSaving = false;
    if (btn && !auto) { btn.disabled = false; btn.textContent = 'Save changes · 保存'; }
    catUpdateDirty();   // refresh the indicator; reschedules if edits arrived mid-save
  }
}

// ── Per-category detail drawer ─────────────────────────────────────────────
// Opened from the "Edit" button on any top/sub row. Lets the operator rename
// (EN/CN, same bound model as the inline editor — persisted by Save changes)
// AND see / quick-recategorize the products tagged to this category. Product
// moves go straight to PATCH /products/:id; structure (names/order) still saves
// through the whole-tree catSave(). Product queries + move targets read the
// LAST-SAVED tree (catClean) because products are tagged with saved names — an
// unsaved rename wouldn't match until you Save.
let catDetail = null;        // { kind:'top'|'sub', ti, si }
let _catMoveTargets = [];    // flattened [{top,sub}] for the move <select>; value = index

function catCleanTree() { try { return JSON.parse(catClean); } catch { return []; } }

// Resolve the saved (top, sub) names for the node being edited, matched by
// stable id. Returns null for a brand-new/unsaved node (no products yet).
function catSavedNames(kind, ti, si) {
  const node = (kind === 'sub') ? (catModel[ti] && catModel[ti].subs[si]) : catModel[ti];
  if (!node || !node.id) return null;
  const tree = catCleanTree();
  if (kind === 'top') { const t = tree.find(x => x.id === node.id); return t ? { top: t.name } : null; }
  for (const t of tree) { const s = (t.subs || []).find(x => x.id === node.id); if (s) return { top: t.name, sub: s.name }; }
  return null;
}

function catOpenDetail(kind, ti, si) {
  catDetail = { kind, ti, si: si == null ? -1 : si };
  document.getElementById('cat-detail-scrim').classList.add('open');
  const aside = document.getElementById('cat-detail');
  aside.classList.add('open'); aside.setAttribute('aria-hidden', 'false');
  catRenderDetail();
  catLoadDetailProducts();
}
function catCloseDetail() {
  catDetail = null;
  document.getElementById('cat-detail-scrim').classList.remove('open');
  const aside = document.getElementById('cat-detail');
  aside.classList.remove('open'); aside.setAttribute('aria-hidden', 'true');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && catDetail) catCloseDetail(); });

function catRenderDetail() {
  if (!catDetail) return;
  const { kind, ti, si } = catDetail;
  const node = kind === 'sub' ? (catModel[ti] && catModel[ti].subs[si]) : catModel[ti];
  if (!node) { catCloseDetail(); return; }
  const isSub = kind === 'sub';
  document.getElementById('cat-detail-kicker').textContent = isSub
    ? `Subcategory of ${catModel[ti].name || '—'} · 子分类`
    : 'Top category · 主分类';
  document.getElementById('cat-detail-title').textContent = node.name || (isSub ? 'New subcategory' : 'New category');
  const saved = catSavedNames(kind, ti, si);
  const fi = isSub ? si : -1;
  const body = document.getElementById('cat-detail-body');
  body.innerHTML = `
    <div class="cd-field">
      <label>${isSub ? 'Subcategory name (English) · 子分类名(英文)' : 'Category name (English) · 分类名(英文)'}</label>
      <input type="text" class="input" value="${escapeAttr(node.name)}"
             oninput="catSet(${ti},${fi},'name',this.value); catDetailTitleSync()">
    </div>
    <div class="cd-field">
      <label>${isSub ? 'Subcategory name (中文)' : 'Category name (中文)'}</label>
      <input type="text" class="input" value="${escapeAttr(node.name_cn)}"
             oninput="catSet(${ti},${fi},'name_cn',this.value)">
    </div>
    ${catIsDirty() ? `<div class="cd-empty" style="color:var(--muted);">Name changes save automatically &amp; re-tag products. · 名称更改将自动保存并重新标记产品。</div>` : ''}
    <div style="display:flex;gap:8px;margin-bottom:var(--s4);">
      <button class="btn btn-sm" type="button" onclick="catSaveFromDetail()">Save now · 立即保存</button>
      ${isSub ? '' : `<button class="btn btn-sm" type="button" onclick="catAddSub(${ti}); catRenderDetail()">＋ Add subcategory · 新增子分类</button>`}
    </div>

    ${!isSub ? `<div class="cd-sec-title">Subcategories <span class="cd-count" id="cd-subcounts"></span></div>
      <div id="cd-subchips">${(node.subs || []).map(s => `<span class="cd-subchip">${escapeHtml(s.name)}<span class="n" data-sub="${escapeAttr(s.name)}">·</span></span>`).join('') || '<span class="cd-empty">No subcategories yet · 暂无子分类</span>'}</div>` : ''}

    <div class="cd-sec-title">Products in this ${isSub ? 'subcategory' : 'category'} <span class="cd-count" id="cd-prod-count">…</span></div>
    ${saved ? '' : '<div class="cd-empty">Save this category first to see and assign products. · 请先保存分类。</div>'}
    <div id="cd-prod-list">${saved ? '<div class="cd-empty">Loading… · 加载中</div>' : ''}</div>
  `;
}
function catDetailTitleSync() {
  if (!catDetail) return;
  const { kind, ti, si } = catDetail;
  const node = kind === 'sub' ? catModel[ti].subs[si] : catModel[ti];
  document.getElementById('cat-detail-title').textContent = node.name || '—';
}
async function catSaveFromDetail() {
  await catSave();
  if (catDetail) { catRenderDetail(); catLoadDetailProducts(); }
}

// Flatten the SAVED tree into move targets (products validate against the
// live/saved tree server-side, so unsaved edits aren't offered as targets).
function catBuildMoveTargets() {
  _catMoveTargets = [];
  for (const t of catCleanTree()) {
    _catMoveTargets.push({ top: t.name, sub: '' });
    for (const s of (t.subs || [])) _catMoveTargets.push({ top: t.name, sub: s.name });
  }
}
function catMoveOptions(curTop, curSub) {
  return _catMoveTargets.map((tg, i) => {
    const sel = (tg.top === (curTop || '') && (tg.sub || '') === (curSub || '')) ? ' selected' : '';
    const lbl = tg.sub ? `${tg.top} › ${tg.sub}` : `${tg.top} · (no sub)`;
    return `<option value="${i}"${sel}>${escapeHtml(lbl)}</option>`;
  }).join('');
}

async function catLoadDetailProducts() {
  if (!catDetail) return;
  const { kind, ti, si } = catDetail;
  const saved = catSavedNames(kind, ti, si);
  const list = document.getElementById('cd-prod-list');
  const countEl = document.getElementById('cd-prod-count');
  if (!saved) { if (countEl) countEl.textContent = '0'; return; }
  catBuildMoveTargets();
  const qs = new URLSearchParams({ top: saved.top });
  if (kind === 'sub') qs.set('sub', saved.sub || '');
  try {
    const { data } = await api('/api/retail-admin/category-products?' + qs.toString());
    const rows = data || [];
    if (countEl) countEl.textContent = String(rows.length);
    // Top view: per-sub counts on the chips.
    if (kind === 'top') {
      const counts = {};
      rows.forEach(p => { const k = (p.subcategory || '').trim() || 'none'; counts[k] = (counts[k] || 0) + 1; });
      document.querySelectorAll('#cd-subchips .n[data-sub]').forEach(el => {
        el.textContent = String(counts[el.getAttribute('data-sub')] || 0);
      });
      const sc = document.getElementById('cd-subcounts');
      if (sc) sc.textContent = (counts['none'] ? `${counts['none']} unfiled · 未归类` : '');
    }
    if (!list) return;
    if (!rows.length) { list.innerHTML = '<div class="cd-empty">No products tagged here yet. · 此分类暂无产品。</div>'; return; }
    list.innerHTML = rows.map(p => {
      const name = escapeHtml(p.name_en || p.name_cn || ('#' + p.id));
      const thumb = p.image_data
        ? `<img class="cd-prod-thumb" src="${escapeAttr(p.image_data)}" alt="" loading="lazy">`
        : '<div class="cd-prod-thumb placeholder">▢</div>';
      return `<div class="cd-prod">
        ${thumb}
        <div class="cd-prod-name">${name}${p.sku ? ` <span class="sku">${escapeHtml(p.sku)}</span>` : ''}${p.is_published ? '' : '<span class="cd-prod-unpub">Hidden · 隐藏</span>'}</div>
        <select title="Move to another category · 移动到其他分类" onchange="catMoveProduct(${p.id}, this)">
          ${catMoveOptions(p.top_category, p.subcategory)}
        </select>
      </div>`;
    }).join('');
  } catch (e) {
    if (list) list.innerHTML = '<div class="cd-empty" style="color:var(--danger);">Failed to load products · 加载产品失败</div>';
  }
}

async function catMoveProduct(id, sel) {
  const tg = _catMoveTargets[Number(sel.value)];
  if (!tg) return;
  sel.disabled = true;
  try {
    await api('/api/retail-admin/products/' + id, { method: 'PATCH', body: { top_category: tg.top, subcategory: tg.sub || null } });
    toast('Moved · 已移动', 'ok');
    catLoadDetailProducts();   // product may have left this category — refresh
  } catch (e) {
    toast('Move failed · 移动失败', 'err');
    sel.disabled = false;
  }
}

// Lazy-load the tree the first time the Categories tab is opened.
(function () {
  const btn = document.querySelector('.tabs [data-tab="categories"]');
  if (btn) btn.addEventListener('click', () => { if (!catLoaded) catLoad(); });
})();
// Warn before leaving with unsaved category edits.
window.addEventListener('beforeunload', (e) => {
  if (catLoaded && catIsDirty()) { e.preventDefault(); e.returnValue = ''; }
});


// ── Settings sub-nav switcher ──
$$('#settings-nav button').forEach(btn => btn.addEventListener('click', () => {
  $$('#settings-nav button').forEach(b => b.classList.toggle('active', b === btn));
  const sub = btn.dataset.sub;
  $$('.sub-panel').forEach(p => p.classList.toggle('active', p.id === 'sub-' + sub));
  // The shared "Save settings" bar drives saveConfig() (Shop/Push/CS only). The
  // Operations panel has its own per-card saves, so hide the shared bar there.
  const _saveBar = document.querySelector('.settings-body > .save-bar');
  if (_saveBar) _saveBar.style.display = (sub === 'ops') ? 'none' : '';
  // Lazy-load the Operations panel's live data each time it is opened.
  if (sub === 'ops') loadOpsPanel();
  // Scroll the settings body to top within the page
  window.scrollTo({ top: document.querySelector('.tabs').offsetTop - 8, behavior: 'smooth' });
}));

