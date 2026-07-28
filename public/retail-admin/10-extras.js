/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 10/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: affiliate tab (af*), theme + UI scale, i18n engine (cuT/cuToggleLang/onLangChange), help tooltip, leaderboard, polls/voting, About page, live preview drawer, ?tab= deep-link boot */
// ════════════════════════════════════════════════════════════════
// AFFILIATE — settings + referral list. Lazy-loaded on first tab open.
// ════════════════════════════════════════════════════════════════
let AFFILIATE_LOADED = false;
let _afDebounceT = null;
function afDebouncedLoad() {
  clearTimeout(_afDebounceT);
  _afDebounceT = setTimeout(() => afLoadReferrals(), 250);
}

async function afLoadAll() {
  await Promise.all([afLoadSettings(), afLoadReferrals()]);
}

async function afLoadSettings() {
  try {
    const r = await api('/api/retail-admin/affiliate/settings');
    const d = r.data || {};
    // On/off now lives in Settings → Features (features.affiliate); this tab only
    // edits the reward + code prefix.
    $('#af-reward').value         = (Number(d.rewardPerOrder) || 0).toString();
    $('#af-reward-referee').value = (Number(d.rewardReferee) || 0).toString();
    $('#af-lifetime-rate').value  = (Number(d.lifetimeRatePercent) || 0).toString();
    $('#af-lifetime-months').value = (d.lifetimeMonths === 0 ? 0 : (Number(d.lifetimeMonths) || 12)).toString();
    $('#af-prefix').value         = String(d.codePrefix || 'ROOTS-').toUpperCase();
    $('#af-share-image').value    = String(d.shareImage || '');
    afRenderSharePreview();
  } catch (e) {
    toast('Settings load failed · 加载设置失败: ' + e.message, 'err');
  }
}

async function afSaveSettings() {
  const body = {
    rewardPerOrder: Number($('#af-reward').value) || 0,
    rewardReferee:  Number($('#af-reward-referee').value) || 0,
    lifetimeRatePercent: Number($('#af-lifetime-rate').value) || 0,
    lifetimeMonths:      Number($('#af-lifetime-months').value) || 0,
    codePrefix:     String($('#af-prefix').value || '').trim().toUpperCase(),
    shareImage:     String($('#af-share-image').value || '').trim(),
  };
  try {
    await api('/api/retail-admin/affiliate/settings', { method: 'PATCH', body });
    toast('Affiliate settings saved · 分销设置已保存');
    afLoadSettings();
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

// ── Share-card picture: upload / preview / clear ──
// Reuses the Media-library upload endpoint (stores the raster, returns a
// /api/retail/media/:id URL). We keep just that URL in the hidden field; the
// customer endpoint absolutizes it for WeChat. Empty ⇒ bundled default.
function afRenderSharePreview() {
  const url = $('#af-share-image').value;
  const box = $('#af-share-preview');
  if (!box) return;
  if (!url) {
    // No custom picture — show the designed default card (matches the mockup):
    // the tacet wordmark, the invite line, and a sample ¥-off · code chip.
    const off = Number(($('#af-reward-referee') || {}).value) || 0;
    const prefix = String((($('#af-prefix') || {}).value) || 'ROOTS-').toUpperCase();
    const chip = (off > 0 ? '¥' + afMoney(off) + afT(' off · ', ' 优惠 · ') : '') + escapeHtml(prefix) + 'XXXX';
    box.innerHTML = `<div class="afc-card" data-no-i18n>
        <div>
          <div class="cw">tacet</div>
          <div class="cl">${afT('A friend saved you a seat', '好友为你留了位')}</div>
          <div class="cc">${chip}</div>
        </div>
      </div>
      <div class="afc-note" data-no-i18n>${afT('The built-in card. Upload your own to replace it.', '内置卡片。可上传自定义图片替换。')}</div>`;
    return;
  }
  box.innerHTML = `<img src="${escapeAttr(url)}" alt="">
    <div class="afc-srow" data-no-i18n><button class="af2-btn ghost sm" onclick="afClearShareImage()">${afT('Remove picture', '移除图片')}</button></div>`;
}

function afClearShareImage() {
  $('#af-share-image').value = '';
  afRenderSharePreview();
}

async function afUploadShareImage(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Uploading… · 上传中…');
  try {
    const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!j.success) { toast('Upload failed · 上传失败: ' + (j.error || ''), 'err'); return; }
    $('#af-share-image').value = j.data.url;
    afRenderSharePreview();
    toast('Uploaded — remember to Save · 已上传 — 请记得保存');
  } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
}

document.addEventListener('change', e => {
  if (e.target.id === 'af-share-file' && e.target.files?.[0]) {
    afUploadShareImage(e.target.files[0]);
    e.target.value = '';
  }
});

// Click a status chip in the segmented filter → set the hidden field, move the
// active state, reload. afLoadReferrals reads #af-status.value as before.
function afSetStatus(v) {
  const f = $('#af-status');
  if (f) f.value = v;
  document.querySelectorAll('#af-seg button').forEach(b => b.classList.toggle('on', (b.dataset.st || '') === v));
  afLoadReferrals();
}

const afT = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
// Money like the mockup: whole numbers show plain (¥630), only fractions show
// decimals (¥12.50). The shared fmt() always forces .00, which read wrong here.
function afMoney(n) { n = Number(n || 0); return Number.isInteger(n) ? String(n) : n.toFixed(2); }
function afInitials(name, id) {
  const n = (name || '').trim();
  if (!n) return '#' + (id || '');
  const parts = n.split(/\s+/);
  return ((parts[0][0] || '') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')).toUpperCase();
}
// Relative "2 days ago" for the Joined column (matches the mockup); falls back
// to the absolute date if the timestamp won't parse.
function afRelTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  const t = d.getTime();
  if (!isFinite(t)) return cuFmtDate(ts) || '';
  const secs = Math.max(0, (Date.now() - t) / 1000), day = 86400;
  if (secs < 3600)  return afT('just now', '刚刚');
  if (secs < day)   { const h = Math.floor(secs / 3600); return afT(h + 'h ago', h + ' 小时前'); }
  const days = Math.floor(secs / day);
  if (days < 7)     return afT(days + 'd ago', days + ' 天前');
  if (days < 30)    { const w = Math.floor(days / 7);  return afT(w + 'w ago', w + ' 周前'); }
  if (days < 365)   { const mo = Math.floor(days / 30); return afT(mo + 'mo ago', mo + ' 个月前'); }
  return afT(Math.floor(days / 365) + 'y ago', Math.floor(days / 365) + ' 年前');
}

async function afLoadReferrals() {
  const status = $('#af-status').value;
  const q      = $('#af-q').value.trim();
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q)      qs.set('q', q);
  qs.set('pageSize', '100');

  const ledger = $('#af-ledger');
  ledger.innerHTML = `<div class="af2-empty"><div class="sub">${afT('Loading…', '加载中…')}</div></div>`;
  try {
    const r = await api('/api/retail-admin/affiliate/referrals?' + qs.toString());
    const rows = r.data || [];
    const s = r.summary || {};

    const pct = Number(s.total) > 0 ? Math.round((Number(s.converted) / Number(s.total)) * 100) : 0;
    const jThis = Number(s.joined_this_month || 0), jLast = Number(s.joined_last_month || 0);
    const delta = jThis - jLast;
    const vsLast = delta > 0 ? afT('+' + delta + ' vs last month', '较上月 +' + delta)
                 : delta < 0 ? afT(delta + ' vs last month', '较上月 ' + delta)
                 : afT('level with last month', '与上月持平');
    const totalPaid = (Number(s.paid_out) || 0) + (Number(s.lifetime_paid) || 0);
    const paidSub = Number(s.lifetime_paid) > 0
      ? afT('incl. ¥' + afMoney(s.lifetime_paid) + ' lifetime', '含 ¥' + afMoney(s.lifetime_paid) + ' 长期分成')
      : afT('to referrer wallets', '入推荐人钱包');
    const stat = (k, v, d) =>
      `<div class="af2-stat"><div class="af2-sk">${k}</div><div class="af2-sv">${v}</div>${d ? `<div class="af2-sd">${d}</div>` : ''}</div>`;
    $('#af-stats').innerHTML =
      stat(afT('Friends joined', '好友加入'), Number(s.total || 0), vsLast) +
      stat(afT('First orders', '首单转化'),   Number(s.converted || 0), afT(pct + '% converted', pct + '% 转化')) +
      stat(afT('Rewards paid', '已发奖励'),   '¥' + afMoney(totalPaid), paidSub) +
      stat(afT('Still earning', '持续分成'),  Number(s.still_earning || 0), afT('within lifetime window', '在分成周期内'));

    if (!rows.length) {
      const filtering = !!status || !!q;
      ledger.innerHTML = filtering
        ? `<div class="af2-empty"><div class="lead">${afT('None match.', '没有匹配项。')}</div><div class="sub">${afT('Try a different filter or search.', '换个筛选或搜索试试。')}</div></div>`
        : `<div class="af2-empty"><div class="lead">${afT('No referrals yet.', '暂无推荐记录。')}</div><div class="sub">${afT('When a customer shares their code and a friend joins, they show up here.', '当顾客分享邀请码、好友加入后,会出现在这里。')}</div></div>`;
      return;
    }

    const th = `<thead><tr>
      <th>${afT('Referrer → Friend', '推荐人 → 好友')}</th>
      <th class="af2-hide-sm">${afT('Code', '邀请码')}</th>
      <th>${afT('Status', '状态')}</th>
      <th class="af2-r">${afT('Reward', '奖励')}</th>
      <th class="af2-hide-sm">${afT('Joined', '加入')}</th>
      <th></th>
    </tr></thead>`;

    const body = rows.map(r => {
      const referrer = escapeHtml(r.referrer_nickname || ('#' + r.referrer_id));
      const invitee  = escapeHtml(r.invitee_nickname  || ('#' + r.invitee_id));
      // sub line under the names: friend's phone · what happened (code is its own column)
      let note;
      if (r.status === 'ordered')   note = afT('first order', '已首单') + (r.first_paid_order_id ? ' #' + r.first_paid_order_id : '');
      else if (r.status === 'void') note = escapeHtml(r.voided_reason || afT('voided', '已作废'));
      else                          note = afT('new customer', '新顾客');
      const phone = escapeHtml(r.invitee_phone || r.referrer_phone || '');
      const sub = [phone, note].filter(Boolean).join(' · ');

      const amtCls = Number(r.reward_amount) > 0 ? 'af2-amt' : 'af2-amt zero';
      const acts = r.status === 'ordered'
        ? `<button class="af2-btn ghost sm" onclick="afEditReward(${r.id}, ${Number(r.reward_amount) || 0})">${afT('Adjust', '调整')}</button>`
        : `<button class="af2-btn sm" onclick="afEditReward(${r.id}, ${Number(r.reward_amount) || 0})">${afT('Reward', '奖励')}</button>` +
          (r.status === 'joined' ? `<button class="af2-btn ghost sm" onclick="afVoid(${r.id})">${afT('Void', '作废')}</button>` : '') +
          (r.status === 'void'   ? `<button class="af2-btn ghost sm" onclick="afRestore(${r.id})">${afT('Restore', '恢复')}</button>` : '');

      return `<tr>
        <td>
          <div class="af2-flow">
            <span class="af2-av">${escapeHtml(afInitials(r.referrer_nickname, r.referrer_id))}</span>
            <div class="af2-who">
              <div class="af2-nm"><a href="#" onclick="event.preventDefault(); cuOpenDetail(${r.referrer_id})">${referrer}</a><span class="arw">→</span><a href="#" onclick="event.preventDefault(); cuOpen(${r.invitee_id})">${invitee}</a></div>
              <div class="af2-sub">${sub}</div>
            </div>
          </div>
        </td>
        <td class="af2-hide-sm"><span class="af2-code">${escapeHtml(r.code_used || '')}</span></td>
        <td>${afStatusBadge(r)}</td>
        <td class="af2-r"><span class="${amtCls}">¥${afMoney(r.reward_amount || 0)}</span></td>
        <td class="af2-hide-sm"><span class="af2-when">${escapeHtml(afRelTime(r.joined_at))}</span></td>
        <td class="af2-actcell"><span class="af2-acts">${acts}</span></td>
      </tr>`;
    }).join('');

    ledger.innerHTML = `<table class="af2-tbl">${th}<tbody>${body}</tbody></table>`;
  } catch (e) {
    ledger.innerHTML = `<div class="af2-empty"><div class="lead">${afT('Couldn\'t load referrals.', '加载推荐记录失败。')}</div><div class="sub">${escapeHtml(e.message)}</div></div>`;
  }
}

function afStatusBadge(r) {
  const status = (r && typeof r === 'object') ? r.status : r;
  if (status === 'ordered') {
    // "Still earning" uses inline Dusk styling (reusing the shipped .af2-badge
    // base + af2Breathe keyframe) so this doesn't need a retail-admin.html edit.
    return (r && r.lifetime_active)
      ? `<span class="af2-badge" style="background:var(--td-dusk-tint);color:var(--td-dusk);"><span class="bdot" style="animation:af2Breathe 2.4s var(--ease-out) infinite;"></span>${afT('Still earning', '持续分成')}</span>`
      : `<span class="af2-badge done"><span class="bdot"></span>${afT('Rewarded', '已奖励')}</span>`;
  }
  if (status === 'void')    return `<span class="af2-badge void">${afT('Voided', '已作废')}</span>`;
  return `<span class="af2-badge wait"><span class="bdot"></span>${afT('Waiting for first order', '待首单')}</span>`;
}

// Self-contained Tacet status pill (inline styles, no scoped CSS needed) so it
// also renders correctly inside the customer drawer's affiliate block, which
// lives outside #tab-affiliate. Replaces the old neon lime/black pill.
function afStatusPill(status) {
  const base = 'display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;border-radius:999px;padding:2px 11px;white-space:nowrap;';
  const map = {
    ordered: { css: 'background:var(--td-sage-tint);color:var(--td-sage-ink);',  label: afT('Rewarded', '已奖励') },
    joined:  { css: 'background:var(--td-amber-tint);color:var(--td-amber-ink);', label: afT('Waiting', '待首单') },
    void:    { css: 'background:transparent;border:1px solid var(--line);color:var(--text-3);', label: afT('Voided', '已作废') },
  };
  const s = map[status] || map.void;
  return `<span style="${base}${s.css}">${s.label}</span>`;
}

async function afEditReward(id, current) {
  const raw = await askPrompt({ title: 'New reward amount (¥):', value: String(current), submitLabel: 'Update reward' });
  if (raw == null) return;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) { toast('Invalid amount · 金额无效', 'err'); return; }
  try {
    await api('/api/retail-admin/affiliate/referrals/' + id, { method: 'PATCH', body: { reward_amount: n } });
    toast('Reward updated · 奖励已更新');
    afLoadReferrals();
  } catch (e) { toast('Update failed · 更新失败: ' + e.message, 'err'); }
}

async function afVoid(id) {
  const reason = await askPrompt({ title: 'Reason for voiding this referral?', value: 'admin override', submitLabel: 'Void referral', danger: true });
  if (reason == null) return;
  try {
    await api('/api/retail-admin/affiliate/referrals/' + id, { method: 'PATCH', body: { status: 'void', voided_reason: reason } });
    toast('Referral voided · 推荐记录已作废');
    afLoadReferrals();
  } catch (e) { toast('Void failed · 作废失败: ' + e.message, 'err'); }
}

async function afRestore(id) {
  try {
    await api('/api/retail-admin/affiliate/referrals/' + id, { method: 'PATCH', body: { status: 'joined' } });
    toast('Referral restored · 推荐记录已恢复');
    afLoadReferrals();
  } catch (e) { toast('Restore failed · 恢复失败: ' + e.message, 'err'); }
}

document.querySelector('[data-tab="affiliate"]').addEventListener('click', () => {
  if (!AFFILIATE_LOADED) { AFFILIATE_LOADED = true; afLoadAll(); }
});

// The stats + ledger are data-no-i18n (built with cuT), so re-render them when
// the admin toggles language; the share preview carries its own EN/中 too.
if (window.onLangChange) {
  onLangChange(() => {
    if (!AFFILIATE_LOADED) return;
    afLoadReferrals();
    afRenderSharePreview();
  });
}

// ════════════════════════════════════════════════════════════════
// SHARE CARDS — Tacet workspace (option B). A left page list; the
// selected page opens on the right with its title fields, picture and
// ONE big live WeChat-forward preview so the operator sees exactly what
// a friend receives. Storage is unchanged:
//   • Home / Product / Voting → config keys sharing.<key> (picture) and
//     sharing.<key>Title = {en,cn} (Product has no title). The customer
//     /api/retail/config endpoint absolutizes the pictures for WeChat.
//   • Invite → affiliate.shareImage + affiliate.shareTitle, the SAME keys
//     as Marketing → Affiliate, so the two surfaces stay in sync.
// Edits live in-memory (SC_DATA) as you switch pages; Save persists the
// selected page. Media upload reuses /api/retail-admin/media/upload.
// Markup: #tab-sharing + #tacet-sharecards-skin in retail-admin.html.
// ════════════════════════════════════════════════════════════════
const SC_KEYS = ['home', 'product', 'voting', 'invite'];
const SC_CFG = {
  home:    { titled: true,  ep: 'config' },
  product: { titled: false, ep: 'config' },
  voting:  { titled: true,  ep: 'config' },
  invite:  { titled: true,  ep: 'affiliate' },
};
// Per-page display copy — kept per language so the JS renders ONE language
// (the containers are data-no-i18n; the walker never sees them).
const SC_META = {
  home:    { name: { en: 'Home page',    cn: '首页' },   blurb: { en: 'Forwarding the store home, with no referral code.', cn: '转发店铺首页(不含推荐码)。' } },
  product: { name: { en: 'Product page', cn: '商品页' }, blurb: { en: 'Backup picture — used only when a product has no photo of its own.', cn: '备用图 — 仅当商品没有自己的图片时使用。' } },
  voting:  { name: { en: 'Voting page',  cn: '投票页' }, blurb: { en: 'Forwarding the community polls. A live poll titles itself.', cn: '转发社区投票页;有进行中的投票时用其问题作标题。' } },
  invite:  { name: { en: 'Invite card',  cn: '邀请卡片' }, blurb: { en: 'A customer sharing their referral code. In sync with Marketing → Affiliate.', cn: '顾客分享推荐码时显示;与“营销 → 分销”同步。' } },
};
// Muted placeholder shown in the preview when a card has no custom title —
// stands in for the app's built-in default. Tenant-neutral (no brand name).
const SC_EMPTY_TITLE = {
  home:    { en: 'Your store’s default title', cn: '店铺默认标题' },
  product: { en: 'The product’s own name',     cn: '商品自身名称' },
  voting:  { en: 'Vote with us',                    cn: '一起来投票' },
  invite:  { en: 'Invite reward + code (automatic)', cn: '邀请奖励 + 邀请码(自动)' },
};
const SC_ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>';
const SC_ICON_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M12 3v18"/></svg>';
let SHARING_LOADED = false;
let SC_SEL = 'home';
const SC_DATA = {};   // { key: { img: '', title: { en, cn } } }

// Current admin language (the i18n engine stores it under 'roots-admin-lang').
function scLang() { try { return localStorage.getItem('roots-admin-lang') === 'cn' ? 'cn' : 'en'; } catch (e) { return 'en'; } }
function scT(en, cn) { return scLang() === 'cn' ? cn : en; }
function scEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function scUrl(u) { return String(u || '').replace(/"/g, '%22'); }

// Build the WeChat forward preview (chat bubble + card) for the given key.
function scChatHTML(key) {
  const d = SC_DATA[key] || { img: '', title: {} };
  const lang = scLang();
  const custom = SC_CFG[key].titled ? String((d.title && d.title[lang]) || '').trim() : '';
  const titleText = custom || SC_EMPTY_TITLE[key][lang];
  const isDefault = !custom;
  const imgBlock = d.img
    ? '<div class="sc-wx-img" id="sc-pv-img"></div>'
    : '<div class="sc-wx-img sc-fb"><div class="sc-fb-lines"><i></i><i></i><i></i></div><div class="sc-fb-dot"></div></div>';
  return '<div class="sc-chat"><div class="sc-chatrow">'
    + '<div class="sc-avatar">' + SC_ICON_USER + '</div>'
    + '<div class="sc-wxcard">'
    +   '<div class="sc-wx-t' + (isDefault ? ' empty' : '') + '">' + scEsc(titleText) + '</div>'
    +   imgBlock
    +   '<div class="sc-wx-foot"><span class="sc-wx-lg">' + SC_ICON_MARK + '</span><span>' + scT('Mini Program', '小程序') + '</span></div>'
    + '</div></div></div>';
}

// Repaint only the stage preview (called on each keystroke — no form re-render,
// so the focused input keeps its cursor).
function scPaintPreview() {
  const box = $('#sc-pv'); if (!box) return;
  box.innerHTML = scChatHTML(SC_SEL);
  const d = SC_DATA[SC_SEL];
  if (d && d.img) { const el = $('#sc-pv-img'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
}

// One row in the left page list.
function scListRowHTML(key) {
  const d = SC_DATA[key] || { img: '' };
  const custom = !!d.img;
  const thumb = custom
    ? '<span class="sc-pthumb" data-thumb="' + key + '"></span>'
    : '<span class="sc-pthumb sc-fb"><span class="sc-fb-dot"></span></span>';
  const pill = custom
    ? '<span class="sc-pill custom"><span class="sc-dot"></span>' + scT('Set', '已设置') + '</span>'
    : '<span class="sc-pill deflt"><span class="sc-dot"></span>' + scT('Default', '默认') + '</span>';
  const name = scT(SC_META[key].name.en, SC_META[key].name.cn);
  const status = custom ? scT('Custom picture', '自定义图片') : scT('Page’s own look', '页面自带样式');
  return '<button type="button" class="sc-prow' + (key === SC_SEL ? ' sel' : '') + '" onclick="scSelect(\'' + key + '\')">'
    + thumb
    + '<span class="sc-pmeta"><span class="sc-pn">' + scEsc(name) + '</span><span class="sc-ps">' + status + '</span></span>'
    + '<span class="sc-pright">' + pill + '</span>'
    + '</button>';
}

function scRenderList() {
  const box = $('#sc-list'); if (!box) return;
  box.innerHTML = SC_KEYS.map(scListRowHTML).join('');
  SC_KEYS.forEach(k => {
    const d = SC_DATA[k];
    if (d && d.img) { const el = box.querySelector('[data-thumb="' + k + '"]'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
  });
}

// Render the right-hand editor + preview for the selected page.
function scRenderStage() {
  const box = $('#sc-stage'); if (!box) return;
  const key = SC_SEL;
  const cfg = SC_CFG[key];
  const d = SC_DATA[key] || { img: '', title: { en: '', cn: '' } };
  const en = (d.title && d.title.en) || '';
  const cn = (d.title && d.title.cn) || '';

  let fields;
  if (cfg.titled) {
    fields =
      '<div class="sc-fgroup"><label class="sc-flabel">' + scT('Card title', '卡片标题') + ' <span class="sc-lang">· English</span>'
      +   '<span class="sc-charc" id="sc-c-en">' + en.length + ' / 60</span></label>'
      + '<input type="text" class="sc-input" id="sc-t-en" maxlength="60" value="' + scEsc(en) + '" placeholder="' + scT('e.g. Fresh this week', '例如:本周上新') + '" oninput="scOnTitle(\'en\', this.value)"></div>'
      + '<div class="sc-fgroup"><label class="sc-flabel">卡片标题 <span class="sc-lang">· 中文</span>'
      +   '<span class="sc-charc" id="sc-c-cn">' + cn.length + ' / 60</span></label>'
      + '<input type="text" class="sc-input" id="sc-t-cn" maxlength="60" value="' + scEsc(cn) + '" placeholder="例如:本周上新" oninput="scOnTitle(\'cn\', this.value)"></div>';
  } else {
    fields = '<div class="sc-note">' + scT('Products share their own name and photo. This picture only fills in when a product has none.', '商品使用自己的名称和图片,此图仅在商品没有图片时兜底。') + '</div>';
  }
  const inviteNote = key === 'invite'
    ? '<div class="sc-note">' + scT('Leave the titles empty to keep the automatic one (with the reward and code).', '标题留空则使用自动文案(含奖励金额与邀请码)。') + '</div>'
    : '';
  const drop =
    '<div class="sc-fgroup"><label class="sc-flabel">' + scT('Picture', '图片') + ' <span class="sc-lang">· ' + scT('about 500 × 400', '约 500 × 400') + '</span></label>'
    + '<div class="sc-drop" onclick="document.getElementById(\'sc-file\').click()">'
    +   '<span class="sc-drop-thumb' + (d.img ? '' : ' sc-fb') + '" id="sc-drop-thumb">' + (d.img ? '' : '<span class="sc-fb-dot"></span>') + '</span>'
    +   '<span><span class="sc-drop-t">' + (d.img ? scT('Replace the picture', '更换图片') : scT('Drop a picture, or click to choose', '拖入图片,或点击选择')) + '</span>'
    +     '<span class="sc-drop-s">' + scT('PNG or JPG · shown at 5:4', 'PNG 或 JPG · 按 5:4 显示') + '</span></span>'
    + '</div>'
    + '<input type="file" id="sc-file" accept="image/png,image/jpeg" style="display:none">'
    + '<div class="sc-drophint">' + scT('Leave empty to use the page’s own look.', '留空则使用该页面自带样式。') + '</div></div>';
  const removeBtn = d.img ? '<button class="sc-btn danger" onclick="scClear()">' + scT('Remove picture', '移除图片') + '</button>' : '';

  box.innerHTML =
    '<div class="sc-sgrid">'
    + '<div class="sc-form">'
    +   '<div class="sc-stitle">' + scEsc(scT(SC_META[key].name.en, SC_META[key].name.cn)) + '</div>'
    +   '<div class="sc-ssub">' + scEsc(scT(SC_META[key].blurb.en, SC_META[key].blurb.cn)) + '</div>'
    +   fields + inviteNote + drop
    +   '<div class="sc-savebar"><button class="sc-save" onclick="scSave()">' + scT('Save card', '保存卡片') + '</button>'
    +     removeBtn
    +     '<span class="sc-saved" id="sc-saved"></span></div>'
    + '</div>'
    + '<div class="sc-spreview"><div class="sc-pv-capt">' + scT('Live preview', '实时预览') + '</div>'
    +   '<div id="sc-pv"></div>'
    +   '<div class="sc-pv-note">' + scT('Exactly what lands in the chat — picture, title, and the app row underneath.', '这就是聊天里显示的效果 — 图片、标题,以及下方的小程序信息。') + '</div>'
    + '</div>'
    + '</div>';

  scPaintPreview();
  if (d.img) { const el = $('#sc-drop-thumb'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
}

function scSelect(key) {
  if (!SC_KEYS.includes(key)) return;
  SC_SEL = key;
  scRenderList();
  scRenderStage();
}

// Title typed — update in-memory data, the char counter and the live preview.
// Deliberately does NOT re-render the form (that would drop input focus).
function scOnTitle(lang, val) {
  const d = SC_DATA[SC_SEL]; if (!d) return;
  if (!d.title) d.title = { en: '', cn: '' };
  d.title[lang] = val;
  const c = $('#sc-c-' + lang); if (c) c.textContent = val.length + ' / 60';
  scPaintPreview();
}

async function scUpload(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Uploading… · 上传中…');
  try {
    const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!j.success) { toast('Upload failed · 上传失败: ' + (j.error || ''), 'err'); return; }
    SC_DATA[SC_SEL].img = j.data.url;
    scRenderList(); scRenderStage();
    toast('Uploaded — Save to apply · 已上传 — 保存后生效');
  } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
}

function scClear() {
  if (SC_DATA[SC_SEL]) SC_DATA[SC_SEL].img = '';
  scRenderList(); scRenderStage();
  toast(scT('Picture removed — Save to apply', '已移除图片 — 保存后生效'));
}

function scSeed(key, img, title) {
  SC_DATA[key] = {
    img: String(img || ''),
    title: { en: (title && title.en) || '', cn: (title && title.cn) || '' },
  };
}

async function scLoad() {
  // Seed empty + paint immediately so the workspace shows even if a fetch
  // fails; then hydrate the two sources INDEPENDENTLY.
  SC_KEYS.forEach(k => scSeed(k, '', null));
  scRenderList(); scRenderStage();
  try {
    const cfgR = await api('/api/retail-admin/config');
    const sharing = (cfgR.data && cfgR.data.sharing) || {};
    scSeed('home',    sharing.home,    sharing.homeTitle);
    scSeed('product', sharing.product, null);
    scSeed('voting',  sharing.voting,  sharing.votingTitle);
  } catch (e) { toast('Couldn’t load page cards · 页面卡片加载失败: ' + e.message, 'err'); }
  try {
    const afR = await api('/api/retail-admin/affiliate/settings');
    const af = afR.data || {};
    scSeed('invite', af.shareImage, af.shareTitle);
  } catch (e) { toast('Couldn’t load invite card · 邀请卡片加载失败: ' + e.message, 'err'); }
  scRenderList(); scRenderStage();
}

async function scSave() {
  const key = SC_SEL;
  const d = SC_DATA[key];
  const img = String(d.img || '').trim();
  const titleObj = SC_CFG[key].titled
    ? { en: String(d.title.en || '').trim(), cn: String(d.title.cn || '').trim() }
    : { en: '', cn: '' };
  const saved = $('#sc-saved');
  try {
    if (SC_CFG[key].ep === 'affiliate') {
      await api('/api/retail-admin/affiliate/settings', { method: 'PATCH', body: { shareImage: img, shareTitle: titleObj } });
    } else {
      const body = {}; body['sharing.' + key] = img;
      if (SC_CFG[key].titled) body['sharing.' + key + 'Title'] = titleObj;
      await api('/api/retail-admin/config', { method: 'PUT', body });
    }
    toast('Card saved · 卡片已保存');
    if (saved) saved.textContent = scT('Saved just now', '刚刚已保存');
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

document.addEventListener('change', e => {
  if (e.target.id === 'sc-file' && e.target.files && e.target.files[0]) {
    scUpload(e.target.files[0]);
    e.target.value = '';
  }
});

document.querySelector('[data-tab="sharing"]').addEventListener('click', () => {
  if (!SHARING_LOADED) { SHARING_LOADED = true; scLoad(); }
});

// Re-render on language toggle so names, statuses, labels + preview follow it.
if (window.onLangChange) {
  onLangChange(() => { if (SHARING_LOADED) { scRenderList(); scRenderStage(); } });
}

// ── Theme toggle (light / dark) ──
// The pre-render script in <head> already set data-theme so paint is
// correct. This handler just paints the icon to match and lets the user
// flip it from the topbar; choice is persisted to localStorage so it
// survives reloads.
function cuApplyThemeIcon() {
  const t = document.documentElement.getAttribute('data-theme');
  const showSun  = $('#theme-icon-light');
  const showMoon = $('#theme-icon-dark');
  // Show the icon for the OTHER mode (the one you'd switch to).
  if (showSun)  showSun.style.display  = t === 'dark'  ? '' : 'none';
  if (showMoon) showMoon.style.display = t === 'light' ? '' : 'none';
  const meta = $('#meta-theme-color');
  if (meta) meta.setAttribute('content', t === 'light' ? '#E8E5DC' : '#12161A');
}
function cuSetTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('retail-admin-theme', next); } catch (e) {}
  cuApplyThemeIcon();
  // Push the flip to the embedded Profile iframe (if open + loaded) so it
  // repaints without a reload. The frame only repaints — the parent owns the
  // localStorage write above (no write-back in the frame = no loop).
  if (window.profFramePost) window.profFramePost({ type: 'fc-theme', theme: next });
}
function cuToggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  cuSetTheme(current === 'dark' ? 'light' : 'dark');
}
cuApplyThemeIcon();

// ── i18n / Language toggle ──
// NOTE: the AUTHORITATIVE copy of this engine now runs INLINE in retail-admin.html,
// right before the module <script> tags, so the bilingual "EN · 中文" markup is
// collapsed to one language DURING HTML parse — before first paint, with zero
// network wait. That is what stops the flash-of-both-languages on a cold refresh
// (the old failsafe used to reveal the raw bilingual page after 3s when this
// 10th-of-17 script hadn't downloaded yet). This copy is kept as a self-guarded
// FALLBACK: if the inline engine ever runs, it sets window.__raI18nEngine and this
// block no-ops; if the inline copy is removed/errors, this one still initializes.
(function () {
  if (window.__raI18nEngine) return;
  window.__raI18nEngine = 1;
  // Shared across the whole admin suite (app.html / cms.html / product-editor.html)
  // so the language you pick on one surface follows you into the others.
  const LANG_KEY = 'roots-admin-lang';
  let _lang = 'en';
  const _listeners = [];
  try { const s = localStorage.getItem(LANG_KEY); if (s === 'en' || s === 'cn') _lang = s; } catch {}

  const EN_ONLY_MAP = {
    'Mini App Editor': '小程序编辑器',
    'Dashboard': '主控台',
    'All': '全部',
    'Pending': '待付款',
    'Paid': '已付款',
    'Preparing': '备货中',
    'Rider coming': '骑手来取货',
    'Dispatched': '已发货',
    'Delivered': '已送达',
    'Awaiting restock': '等待补货',
    'Cancelled': '已取消',
    'Refunded': '已退款',
    'Refund queue': '退款队列',
    'Refresh': '刷新',
    'Bulk attach tracking': '批量绑定运单号',
    'Include blocked': '包括已封禁',
    '‹ Prev': '‹ 上一页',
    'Active & scheduled': '进行中 & 已排期',
    'Save flash sale': '保存秒杀',
    'Update flash sale': '更新秒杀',
    'New flash sale': '新建秒杀',
    'No flash sales yet': '暂无秒杀活动',
    'ACTIVE': '进行中',
    'UPCOMING': '即将开始',
    'ENDED': '已结束',
    'JOINED': '已加入',
    'ORDERED': '已下单',
    'VOIDED': '已作废',
    'Loading preview…': '加载预览中…',
    'Live': '开启',
    'Off': '关闭',
    'Bilingual': '双语',
    'English only': '仅英文',
    '中文 only': '仅中文',
    'Loading…': '加载中…',
    'Adding…': '添加中…',
    'Added ✓': '已添加 ✓',
    'Deleting…': '删除中…',
    'Deleted ✓': '已删除 ✓',
    'Saving…': '保存中…',
    'Saved': '已保存',
    'Saved ✓': '已保存 ✓',
    'Sending…': '发送中…',
    'Saving order…': '保存排序中…',
    'Order saved ✓': '排序已保存 ✓',
  };

  // Only treat "X · Y" as a bilingual label when the right side contains
  // Chinese characters. Prevents splitting data strings like
  // "asher · 18613159912" or "subtotal ¥118 · shipping ¥30".
  function hasChinese(s) { return /[一-鿿]/.test(s); }

  // Registry of every text node we translate: { node, en, cn }. We toggle
  // language by rewriting node.nodeValue in place — NO elements are ever
  // created, removed, or restructured, so flex/grid layouts and charts are
  // physically untouched. Disconnected nodes are pruned on toggle.
  const _reg = [];
  // Same idea for tooltips: their text lives in an attribute, not a text node,
  // so it needs its own registry. data-tt (the shared tooltip component in
  // 01-core.js) is the only one left — it is authored "EN · CN" like every
  // other label. The list stays a list so a second attribute is a one-word
  // change. { el, attr, en, cn }.
  const _tipReg = [];
  const TIP_ATTRS = ['data-tt'];
  // Opt-in bilingual placeholders: tag an input/textarea with data-ph-en +
  // data-ph-cn and we swap its `placeholder` on toggle. Opt-in (not auto-split
  // like text) because many placeholders carry a decorative " · " that is NOT a
  // translation divider (e.g. "Mon–Sat · 9am–6pm", "ROOTS CLUB · LEADERBOARD").
  const _phReg = [];
  // Native HTML title="" hover tooltips. Same "EN · CN" model as data-tip,
  // but the text-node/data-tip walkers never see title attributes — so without
  // this, bilingual title labels stay frozen and always show the Chinese half
  // on hover regardless of the active language. { el, en, cn }.
  const _titleReg = [];

  // Never touch text inside these — code, user input, or vector graphics
  // (chart labels). Translating them would corrupt rendering.
  function inSkippedContext(el) {
    for (let n = el; n; n = n.parentElement) {
      if (!n.tagName) break;
      const T = n.tagName.toUpperCase();
      if (T === 'SCRIPT' || T === 'STYLE' || T === 'TEXTAREA' || T === 'INPUT' ||
          T === 'NOSCRIPT' || T === 'SVG' || T === 'CANVAS') return true;
      if (n.namespaceURI === 'http://www.w3.org/2000/svg') return true;
      if (n.dataset && n.dataset.noI18n != null) return true;
    }
    return false;
  }

  function processNode(textNode) {
    if (textNode.__i18nDone) return;
    const parent = textNode.parentElement;
    if (!parent || inSkippedContext(parent)) return;

    const text = textNode.nodeValue || '';
    let en, cn, lead = '', trail = '';
    const idx = text.indexOf(' · ');
    if (idx !== -1) {
      const left = text.slice(0, idx);
      const right = text.slice(idx + 3);
      en = left.trim();
      cn = right.trim();
      if (!en || !cn) return;
      if (!hasChinese(cn) || hasChinese(en)) return;
      // Preserve any surrounding whitespace so inline spacing is unchanged.
      lead  = left.slice(0, left.length - left.trimStart().length);
      trail = right.slice(right.trimEnd().length);
    } else {
      const trimmed = text.trim();
      if (!EN_ONLY_MAP[trimmed]) return;
      en = trimmed;
      cn = EN_ONLY_MAP[trimmed];
      lead  = text.slice(0, text.length - text.trimStart().length);
      trail = text.slice(text.trimEnd().length);
    }

    const enFull = lead + en + trail;
    const cnFull = lead + cn + trail;
    textNode.__i18nDone = true;
    textNode.nodeValue = _lang === 'cn' ? cnFull : enFull;
    _reg.push({ node: textNode, en: enFull, cn: cnFull });
  }

  // Block-pair detection: a help paragraph is often written as two stacked
  // siblings — an all-English <div>/<p> next to an all-Chinese one. We tag the
  // pair (data-lang-block="en"/"cn") and a CSS rule hides the inactive side.
  // Restricting to div/p + same-tag + adjacency keeps this away from data
  // tables, where a CN cell next to an EN cell is NOT a translation pair.
  function isCNBlock(el) {
    const t = el.textContent || '';
    return /[一-鿿]/.test(t) && !/[A-Za-z]/.test(t);
  }
  function isENBlock(el) {
    const t = el.textContent || '';
    return /[A-Za-z]/.test(t) && !/[一-鿿]/.test(t);
  }
  // Block pairs are prose help text. Interactive chrome (the nav tab bar, the
  // topbar) is not a translation pair — but in CN mode its labels are all
  // Chinese, so isCNBlock() would match it and pair it with an EN sibling,
  // stamping data-lang-block on a structural container. The CSS then hides the
  // whole bar in the opposite language. Guard: never tag a container that holds
  // interactive/structural children.
  function isStructuralBlock(el) {
    return !!el.querySelector('button, a, input, select, textarea, svg');
  }
  function tagBlockPair(cnEl) {
    if (cnEl.dataset.langBlock || (cnEl.textContent || '').trim().length < 6) return;
    if (inSkippedContext(cnEl) || isStructuralBlock(cnEl)) return;
    const prev = cnEl.previousElementSibling, next = cnEl.nextElementSibling;
    let enEl = null;
    if (prev && prev.tagName === cnEl.tagName && !prev.dataset.langBlock && isENBlock(prev) && !inSkippedContext(prev) && !isStructuralBlock(prev)) enEl = prev;
    else if (next && next.tagName === cnEl.tagName && !next.dataset.langBlock && isENBlock(next) && !inSkippedContext(next) && !isStructuralBlock(next)) enEl = next;
    if (!enEl) return;
    cnEl.dataset.langBlock = 'cn';
    enEl.dataset.langBlock = 'en';
  }
  function processBlocks(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.tagName === 'DIV' || scope.tagName === 'P') {
      if (isCNBlock(scope)) tagBlockPair(scope);
    }
    scope.querySelectorAll && scope.querySelectorAll('div, p').forEach(el => {
      if (isCNBlock(el)) tagBlockPair(el);
    });
  }

  // Tooltips store their text in an "EN · CN" attribute, which the text-node
  // walker never sees. Split it once, register both halves, and show the
  // active language — the same model used for text nodes.
  function processTipAttr(el, attr) {
    if (el.__i18nTipDone && el.__i18nTipDone[attr]) return;
    const raw = el.getAttribute(attr) || '';
    const idx = raw.indexOf(' · ');
    if (idx === -1) return;
    const en = raw.slice(0, idx).trim();
    const cn = raw.slice(idx + 3).trim();
    if (!en || !cn) return;
    // Unlike text nodes, a tooltip's English half may legitimately contain
    // Chinese (e.g. district names like 天河区 used as examples), so we only
    // require the CN half to be Chinese — the first ' · ' is the divider.
    if (!hasChinese(cn)) return;
    (el.__i18nTipDone = el.__i18nTipDone || {})[attr] = true;
    el.setAttribute(attr, _lang === 'cn' ? cn : en);
    _tipReg.push({ el, attr, en, cn });
  }
  function processTip(el) {
    for (const a of TIP_ATTRS) if (el.hasAttribute(a)) processTipAttr(el, a);
  }
  function processTips(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    const sel = TIP_ATTRS.map(a => '[' + a + ']').join(',');
    if (scope.matches && scope.matches(sel)) processTip(scope);
    scope.querySelectorAll && scope.querySelectorAll(sel).forEach(processTip);
  }

  // Opt-in bilingual placeholders — see _phReg note above.
  function processPh(el) {
    if (el.__i18nPhDone) return;
    const en = el.getAttribute('data-ph-en'), cn = el.getAttribute('data-ph-cn');
    if (en == null || cn == null) return;
    el.__i18nPhDone = true;
    el.setAttribute('placeholder', _lang === 'cn' ? cn : en);
    _phReg.push({ el, en, cn });
  }
  function processPhs(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.hasAttribute && scope.hasAttribute('data-ph-en')) processPh(scope);
    scope.querySelectorAll && scope.querySelectorAll('[data-ph-en]').forEach(processPh);
  }

  // Native title="" tooltips — same split-once model as data-tip. Only treat
  // it as bilingual when the half after the first " · " contains Chinese, so
  // data-bearing titles ("asher · 18613159912", "5 orders · ¥320") and
  // single-language titles are left untouched.
  function processTitle(el) {
    if (el.__i18nTitleDone) return;
    const raw = el.getAttribute('title') || '';
    const idx = raw.indexOf(' · ');
    if (idx === -1) return;
    const en = raw.slice(0, idx).trim();
    const cn = raw.slice(idx + 3).trim();
    if (!en || !cn || !hasChinese(cn)) return;
    el.__i18nTitleDone = true;
    el.setAttribute('title', _lang === 'cn' ? cn : en);
    _titleReg.push({ el, en, cn });
  }
  function processTitles(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.hasAttribute && scope.hasAttribute('title')) processTitle(scope);
    scope.querySelectorAll && scope.querySelectorAll('[title]').forEach(processTitle);
  }

  function processSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) { processNode(root); return; }
    if (root.nodeType !== 1 || inSkippedContext(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.__i18nDone) continue;
      const t = n.nodeValue;
      if (t && (t.indexOf(' · ') !== -1 || EN_ONLY_MAP[t.trim()])) nodes.push(n);
    }
    nodes.forEach(processNode);
    processBlocks(root);
    processTips(root);
    processPhs(root);
    processTitles(root);
  }

  function applyLang(lang) {
    _lang = lang;
    document.documentElement.dataset.uiLang = lang;
    for (let i = _reg.length - 1; i >= 0; i--) {
      const e = _reg[i];
      if (!e.node.isConnected) { _reg.splice(i, 1); continue; }
      e.node.nodeValue = lang === 'cn' ? e.cn : e.en;
    }
    for (let i = _tipReg.length - 1; i >= 0; i--) {
      const e = _tipReg[i];
      if (!e.el.isConnected) { _tipReg.splice(i, 1); continue; }
      e.el.setAttribute(e.attr, lang === 'cn' ? e.cn : e.en);
    }
    for (let i = _phReg.length - 1; i >= 0; i--) {
      const e = _phReg[i];
      if (!e.el.isConnected) { _phReg.splice(i, 1); continue; }
      e.el.setAttribute('placeholder', lang === 'cn' ? e.cn : e.en);
    }
    for (let i = _titleReg.length - 1; i >= 0; i--) {
      const e = _titleReg[i];
      if (!e.el.isConnected) { _titleReg.splice(i, 1); continue; }
      e.el.setAttribute('title', lang === 'cn' ? e.cn : e.en);
    }
    processSubtree(document.body);  // pick up anything not yet registered
    try { localStorage.setItem(LANG_KEY, lang); } catch {}
    updateBtn();
    _listeners.forEach(cb => { try { cb(lang); } catch {} });
  }

  function updateBtn() {
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = _lang === 'cn' ? 'EN' : '中文';
  }

  // Auto-translate content added by JS after load (order drawers, table rows,
  // etc.). Rewriting nodeValue does NOT fire childList mutations, so there is
  // no feedback loop and no need to disconnect.
  const _mo = new MutationObserver(function (mutations) {
    const batch = [];
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 || node.nodeType === 3) batch.push(node);
      }
    }
    if (!batch.length) return;
    // Process synchronously here (the observer callback is a microtask that
    // runs BEFORE the browser paints) rather than on a deferred timer. The
    // old 60ms setTimeout let freshly-inserted "EN · CN" nodes paint raw for
    // a frame, which showed as a flash of Chinese whenever the dashboard
    // re-rendered — e.g. on tab re-focus / window minimize-restore.
    batch.forEach(function (nd) { try { processSubtree(nd); } catch (e) {} });
  });

  window.cuToggleLang  = function () { applyLang(_lang === 'cn' ? 'en' : 'cn'); };
  window.cuT           = function (en, cn) { return _lang === 'cn' ? cn : en; };
  window.cuLang        = function () { return _lang; };
  window.onLangChange  = function (cb) { _listeners.push(cb); };

  function init() {
    document.documentElement.dataset.uiLang = _lang;
    const st = document.createElement('style');
    st.textContent = 'html[data-ui-lang="en"] [data-lang-block="cn"]{display:none!important}'
                   + 'html[data-ui-lang="cn"] [data-lang-block="en"]{display:none!important}';
    document.head.appendChild(st);
    try { processSubtree(document.body); } catch (e) {}
    updateBtn();
    _mo.observe(document.body, { childList: true, subtree: true });
  }

  // Collapse the bilingual chrome as soon as THIS module executes rather than
  // waiting for DOMContentLoaded. This script sits at the end of <body>, so all
  // static markup above it is already parsed and present — we can stamp
  // data-ui-lang, hide the second language, and reveal the page right now.
  // Waiting for DOMContentLoaded meant waiting for the remaining parser-blocking
  // modules (11-17) to download and run; on a slow/cold load that could exceed
  // the 3s anti-FOUC failsafe, which then revealed the page in its raw EN · CN
  // state — the flash of both languages before it settles to one. The
  // MutationObserver started inside init() still catches anything the later
  // modules inject.
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();


// ── Leaderboard ──
// Build/edit lives entirely here in the admin; the mini app renders
// read-only off the saved config. Lazy-load on first tab open.
let LB_LOADED = false;
let LB_PREVIEW_DATA = null;
const LB_FIELDS = [
  'enabled','title_en','title_cn','kicker_en','kicker_cn','subhead_en','subhead_cn',
  'metric','period','top_n','reveal_mode',
  'reward_top1_en','reward_top1_cn','reward_top3_en','reward_top3_cn','reward_top10_en','reward_top10_cn',
];
const LB_FIELD_TO_ID = {
  enabled: 'lb-enabled',
  title_en: 'lb-title-en', title_cn: 'lb-title-cn',
  kicker_en: 'lb-kicker-en', kicker_cn: 'lb-kicker-cn',
  subhead_en: 'lb-subhead-en', subhead_cn: 'lb-subhead-cn',
  metric: 'lb-metric', period: 'lb-period',
  top_n: 'lb-top-n', reveal_mode: 'lb-reveal',
  reward_top1_en: 'lb-r1-en', reward_top1_cn: 'lb-r1-cn',
  reward_top3_en: 'lb-r3-en', reward_top3_cn: 'lb-r3-cn',
  reward_top10_en: 'lb-r10-en', reward_top10_cn: 'lb-r10-cn',
};

// Placeholder ("seed") board — a temporary fake leaderboard to prime a new
// store before real activity exists. Held here as an array of {name, value,
// tier_key}; saved alongside the rest of the config and blended server-side.
let LB_SEED_ENTRIES = [];
// Realistic-looking nicknames, split into Western and Chinese pools so the
// generator can hold a fixed ratio (default 70% Western / 30% Chinese).
// Default reveal masks these to the first character, so the exact text mainly
// matters in "full" reveal mode.
const LB_SEED_NAMES_WEST = [
  'Emma', 'Oliver', 'Sophie', 'Liam', 'Chloe', 'Lucas', 'Grace', 'Ethan',
  'Ava', 'Noah', 'Isla', 'Max', 'Ruby', 'Leo', 'Hazel', 'Theo', 'Nina',
  'Ivy', 'Felix', 'Daisy', 'Owen', 'Lily', 'Jasper', 'Elena', 'Marcus',
  'Clara', 'Hugo', 'Stella', 'Adrian', 'Naomi', 'Victor', 'Freya',
];
const LB_SEED_NAMES_CN = [
  '小确幸', '清晨慢跑', '一颗西兰花', '半糖主义', '林深时见鹿', '番茄炒蛋',
  '海盐柠檬', '江南细雨', '木棉花', '一勺蜂蜜', '南山以南', '慢慢来呀',
  '小满', '晚风温柔', '橙子味的猫', '麦田守望者',
];
const LB_SEED_WEST_RATIO = 0.7;   // 70% Western, 30% Chinese
// Tier badges aren't shown on the leaderboard page, but keep them plausible
// for any surface that does read tier_key (top earners trend higher).
function lbSeedTier(frac) {
  if (frac < 0.10) return 'tree';
  if (frac < 0.35) return 'root';
  if (frac < 0.70) return 'sprout';
  return 'seed';
}
function lbShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function lbUpdateSeedSummary() {
  const el = $('#lb-seed-summary');
  if (!el) return;
  if (!LB_SEED_ENTRIES.length) { el.textContent = cuT('No placeholder members yet.', '尚未生成占位会员。'); return; }
  const top = LB_SEED_ENTRIES[0], bottom = LB_SEED_ENTRIES[LB_SEED_ENTRIES.length - 1];
  el.textContent = cuT(
    LB_SEED_ENTRIES.length + ' members · ¥' + top.value + ' → ¥' + bottom.value,
    LB_SEED_ENTRIES.length + ' 位会员 · ¥' + top.value + ' → ¥' + bottom.value
  );
}
// Build a believable descending spend distribution from the top value down,
// with light jitter, then force it strictly decreasing.
function lbGenerateSeed() {
  const max = Math.max(50, parseInt($('#lb-seed-max') && $('#lb-seed-max').value, 10) || 3000);
  const count = Math.max(3, Math.min(50, parseInt($('#lb-seed-count') && $('#lb-seed-count').value, 10) || 18));
  // Hold the Western/Chinese ratio, then shuffle so the two aren't grouped by
  // rank. Fall back to "Member N" only if a pool runs out at very high counts.
  const westN = Math.round(count * LB_SEED_WEST_RATIO);
  const names = lbShuffle(
    lbShuffle(LB_SEED_NAMES_WEST).slice(0, westN)
      .concat(lbShuffle(LB_SEED_NAMES_CN).slice(0, count - westN))
  );
  const entries = [];
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) : 0;           // 0 (top) .. 1 (bottom)
    let v = max * Math.pow(1 - frac, 1.35);                 // steeper near the top
    v = v * (1 + (Math.random() - 0.5) * 0.08);             // ±4% jitter
    v = Math.max(max * 0.04, v);
    entries.push({ name: names[i] || ('Member ' + (i + 1)), value: Math.round(v / 5) * 5, tier_key: lbSeedTier(frac) });
  }
  entries[0].value = max;                                    // exact requested top
  for (let i = 1; i < entries.length; i++) {                // enforce strict descent
    if (entries[i].value >= entries[i - 1].value) entries[i].value = Math.max(20, entries[i - 1].value - 5);
  }
  LB_SEED_ENTRIES = entries;
  const box = $('#lb-seed-enabled');
  if (box) box.checked = true;                              // generating implies "use it"
  lbUpdateSeedSummary();
  lbRenderPreview();
  toast(cuT('Placeholder members generated', '已生成占位会员'));
}

async function lbLoad() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', { credentials: 'same-origin' });
    const body = await r.json();
    if (!body.success) throw new Error(body.error || 'load_failed');
    lbApplyConfigToForm(body.data);
  } catch (e) {
    console.warn('[lb] config load failed', e);
    toast('Failed to load leaderboard config · 加载排行榜配置失败: ' + e.message);
  }
  await lbLoadPreview();
  lbRenderPreview();
}
function lbApplyConfigToForm(cfg) {
  for (const f of LB_FIELDS) {
    const id = LB_FIELD_TO_ID[f];
    const el = document.getElementById(id);
    if (!el) continue;
    if (f === 'enabled') el.checked = !!cfg[f];
    else el.value = cfg[f] != null ? cfg[f] : '';
  }
  const seedBox = $('#lb-seed-enabled');
  if (seedBox) seedBox.checked = !!cfg.seed_enabled;
  LB_SEED_ENTRIES = Array.isArray(cfg.seed_entries) ? cfg.seed_entries : [];
  const hideEl = $('#lb-hide-names');
  if (hideEl) hideEl.value = Array.isArray(cfg.hide_names) ? cfg.hide_names.join(', ') : '';
  lbUpdateSeedSummary();
  lbUpdateEnabledPill();
}
function lbReadForm() {
  const out = {};
  for (const f of LB_FIELDS) {
    const id = LB_FIELD_TO_ID[f];
    const el = document.getElementById(id);
    if (!el) continue;
    if (f === 'enabled') out[f] = !!el.checked;
    else if (f === 'top_n') out[f] = parseInt(el.value, 10) || 20;
    else out[f] = el.value;
  }
  const seedBox = $('#lb-seed-enabled');
  out.seed_enabled = !!(seedBox && seedBox.checked);
  out.seed_entries = LB_SEED_ENTRIES;
  const hideEl = $('#lb-hide-names');
  out.hide_names = hideEl ? hideEl.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [];
  return out;
}
function lbUpdateEnabledPill() {
  const on = $('#lb-enabled') && $('#lb-enabled').checked;
  const pill = $('#lb-current-pill');
  if (!pill) return;
  pill.classList.toggle('on', on);
  pill.classList.toggle('off', !on);
  pill.textContent = cuT(on ? 'Live' : 'Off', on ? '开启' : '关闭');
  // Mirror the state onto the nav row's OFF pill — but only once the real
  // config has loaded, so the default-unchecked checkbox doesn't flag it off.
  if (LB_LOADED) document.body.classList.toggle('lb-off', !on);
}
// Seed the nav OFF pill at startup. The full leaderboard config (form + preview)
// lazy-loads on first tab open; this is just the lightweight enabled flag so the
// nav reflects reality before the operator ever visits the tab.
async function lbInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', { credentials: 'same-origin' });
    const b = await r.json();
    if (b && b.success && b.data) document.body.classList.toggle('lb-off', !b.data.enabled);
  } catch (e) { /* leave nav as-is if the probe fails */ }
}
async function lbLoadPreview() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/preview', { credentials: 'same-origin' });
    const body = await r.json();
    if (!body.success) throw new Error(body.error || 'preview_failed');
    LB_PREVIEW_DATA = body.data;
  } catch (e) {
    console.warn('[lb] preview load failed', e);
    LB_PREVIEW_DATA = null;
  }
}
function lbFormatValue(value, metric) {
  if (metric === 'lifetime_spend') return '¥' + Number(value || 0).toFixed(0);
  if (metric === 'points_balance') return Number(value || 0).toLocaleString() + ' pts';
  if (metric === 'orders_count')   return Number(value || 0).toLocaleString() + ' orders';
  return String(value || 0);
}
function lbMetricLabel(metric) {
  if (metric === 'points_balance') return 'By points balance';
  if (metric === 'orders_count')   return 'By paid orders';
  return 'By lifetime spend';
}
function lbPeriodLabel(period) {
  if (period === 'year')  return 'Last 12 months';
  if (period === 'month') return 'Last 30 days';
  if (period === 'week')  return 'Last 7 days';
  return 'All time';
}
function lbMaskNickname(name, mode) {
  const s = String(name || '').trim();
  if (!s) return mode === 'masked' ? '会员' : 'Member';
  if (mode === 'full') return s;
  if (mode === 'first_char') {
    const chars = Array.from(s);
    if (chars.length <= 1) return chars[0] + '*';
    return chars[0] + '*'.repeat(Math.min(3, chars.length - 1));
  }
  return '**';
}
function lbEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function lbRenderPreview() {
  const f = lbReadForm();
  $('#lb-pv-kicker').textContent   = f.kicker_en || 'ROOTS CLUB · LEADERBOARD';
  $('#lb-pv-title').textContent    = f.title_en  || 'Top growers';
  $('#lb-pv-subhead').textContent  = f.subhead_en || '';
  $('#lb-pv-meta').textContent     = lbMetricLabel(f.metric) + ' · ' + lbPeriodLabel(f.period);
  const note = $('#lb-period-note');
  if (note) note.textContent = (f.metric === 'points_balance')
    ? cuT('Note: points-balance metric is point-in-time. Period selector is ignored for this metric.', '说明:积分余额为实时快照指标,该指标会忽略周期选择。')
    : '';
  let rawEntries = ((LB_PREVIEW_DATA && LB_PREVIEW_DATA.raw_entries) || []).slice();
  // Drop hidden real members client-side so the preview reacts to unsaved
  // edits to the hide field (matched case-insensitively).
  const hideSet = new Set((f.hide_names || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
  if (hideSet.size) rawEntries = rawEntries.filter(e => !hideSet.has(String(e.nickname || '').trim().toLowerCase()));
  // Blend placeholder members into the preview client-side so the operator
  // sees them immediately (the server only includes them after a save).
  const seedBox = $('#lb-seed-enabled');
  if (seedBox && seedBox.checked && LB_SEED_ENTRIES.length) {
    rawEntries = rawEntries
      .map(e => ({ nickname: e.nickname, value: Number(e.value) || 0 }))
      .concat(LB_SEED_ENTRIES.map(s => ({ nickname: s.name, value: Number(s.value) || 0 })))
      .sort((a, b) => b.value - a.value)
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }
  const topN = Math.max(1, Math.min(100, parseInt(f.top_n, 10) || 20));
  const sliced = rawEntries.slice(0, topN);
  const list = $('#lb-pv-list');
  if (!sliced.length) {
    list.innerHTML = '<div class="lb-pv-empty">No qualifying members yet. Save the config and customers with activity will appear here.</div>';
  } else {
    list.innerHTML = sliced.map(e => {
      const rankClass = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
      const name = lbMaskNickname(e.nickname, f.reveal_mode);
      return '<div class="lb-pv-row">' +
             '<div class="lb-pv-rank ' + rankClass + '">#' + e.rank + '</div>' +
             '<div>' + lbEscapeHtml(name) + '</div>' +
             '<div class="lb-pv-val">' + lbFormatValue(e.value, f.metric) + '</div>' +
             '</div>';
    }).join('');
  }
  const rewards = $('#lb-pv-rewards');
  const parts = [];
  if (f.reward_top1_en)  parts.push({ tag: 'Top 1',  text: f.reward_top1_en });
  if (f.reward_top3_en)  parts.push({ tag: 'Top 3',  text: f.reward_top3_en });
  if (f.reward_top10_en) parts.push({ tag: 'Top 10', text: f.reward_top10_en });
  rewards.innerHTML = parts.map(p =>
    '<div class="lb-reward"><span class="lb-r-tag">' + lbEscapeHtml(p.tag) + '</span> · ' + lbEscapeHtml(p.text) + '</div>'
  ).join('');
  lbUpdateEnabledPill();
}
function updateLeaderboardPreview() { lbRenderPreview(); }

// The Visibility switch is the master on/off — flipping it must persist
// immediately (the rest of the form still saves via the Save button). Without
// this, a flip was preview-only and reverted to the stored value on refresh.
async function lbToggleEnabled() {
  lbRenderPreview();          // reflect the new state in the pill + preview now
  await saveLeaderboardConfig();
}

async function saveLeaderboardConfig() {
  const body = lbReadForm();
  const status = $('#lb-save-status');
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error || 'save_failed');
    lbApplyConfigToForm(data.data);
    if (status) status.textContent = cuT('Saved', '已保存') + ' · ' + new Date().toLocaleTimeString();
    toast('Leaderboard saved · 排行榜已保存');
    await lbLoadPreview();
    lbRenderPreview();
  } catch (e) {
    console.warn('[lb] save failed', e);
    if (status) status.textContent = 'Save failed · 保存失败: ' + e.message;
    toast('Save failed · 保存失败: ' + e.message);
  }
}

document.querySelector('[data-tab="leaderboard"]').addEventListener('click', () => {
  if (!LB_LOADED) { LB_LOADED = true; lbLoad(); }
});

// ════════════════════════════════════════════════════════════════
// VOTING — community polls. Admin builds, opens, closes, and picks
// winners. Lazy-loaded on first tab open.
// ════════════════════════════════════════════════════════════════
let POLLS_LOADED = false;
let _pollsCache = [];                // last server snapshot
let _pollDraft  = null;              // { id?, ...form state } while editing

const POLL_PALETTE = [
  '#F2CA6C', '#F4B8CB', '#F4F087', '#E96174',
  '#B2CFED', '#7BBD3B', '#A8D185', '#FFAF60',
];

function pollLetter(i) { return String.fromCharCode(65 + i); }

function pollStatusPill(status) {
  return `<span class="vot-stat ${status}">${status}</span>`;
}

// Mirror "any poll currently open" onto the Voting nav row as an OPEN pill,
// the same way body.lb-off drives Leaderboard's OFF pill.
function votUpdateNavState() {
  const anyOpen = (_pollsCache || []).some(p => p.status === 'open');
  document.body.classList.toggle('vot-open', anyOpen);
}
// Seed the nav OPEN pill at startup so it reflects reality before the operator
// ever opens the Voting tab (the full list lazy-loads on first tab open).
async function votInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/polls', { credentials: 'same-origin' });
    const b = await r.json();
    const polls = (b && (b.data || b)) || [];
    document.body.classList.toggle('vot-open', Array.isArray(polls) && polls.some(p => p.status === 'open'));
  } catch (e) { /* leave nav as-is if the probe fails */ }
}

async function loadPolls() {
  try {
    const r = await api('/api/retail-admin/polls');
    _pollsCache = r.data || [];
    votUpdateNavState();
    renderPollList();
  } catch (e) {
    $('#vot-list').innerHTML = `<div class="muted" style="color: #c64242;">Failed to load · 加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderPollList() {
  const mount = $('#vot-list');
  if (!_pollsCache.length) {
    mount.innerHTML = '<div class="muted" style="font-size: 12px;">No polls yet. Click <b>+ New poll</b> to create one.</div>';
    return;
  }
  mount.innerHTML = _pollsCache.map(p => {
    const top = (p.options || [])
      .slice()
      .sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
    const meta = [
      `${(p.options || []).length} ${cuT('opts', '选项')}`,
      `${p.total_votes || 0} ${cuT('votes', '票')}`,
      p.reward_points ? `+${p.reward_points} ${cuT('pts', '积分')}` : null,
      p.closes_at ? `${cuT('closes', '截止')} ${String(p.closes_at).slice(0, 16).replace('T', ' ')}` : null,
      top && (p.status !== 'open' || p.total_votes > 0) ? `${cuT('top:', '领先:')} ${escapeHtml(top.label_en)}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="vot-row" data-id="${p.id}">
        <div style="min-width: 0; flex: 1;">
          <div class="vot-q">${escapeHtml(p.question_en || '(untitled)')}</div>
          <div class="vot-meta">${escapeHtml(meta)}</div>
        </div>
        ${p.is_featured ? '<span class="vot-featured">Featured · 精选</span>' : ''}
        ${pollStatusPill(p.status)}
        <div class="vot-actions">
          <button class="btn" onclick="editPoll(${p.id})">Edit · 编辑</button>
          ${p.status === 'draft' ? `<button class="btn btn-primary" onclick="quickPollStatus(${p.id}, 'open')">Open · 开启</button>` : ''}
          ${p.status === 'open'  ? `<button class="btn" onclick="quickPollStatus(${p.id}, 'closed')">Close · 关闭</button>` : ''}
          ${p.status === 'closed'? `<button class="btn" onclick="quickPollStatus(${p.id}, 'open')">Reopen · 重新开启</button>` : ''}
          <button class="btn danger" onclick="deletePoll(${p.id})">Delete · 删除</button>
        </div>
      </div>
    `;
  }).join('');
}

function newPoll() {
  _pollDraft = {
    id: null,
    question_en: '', question_cn: '',
    explainer_en: '', explainer_cn: '',
    category_en: '', category_cn: '',
    status: 'draft',
    closes_at: '',
    reward_points: 5,
    is_featured: 0,
    sort_order: 0,
    winner_option_id: null,
    options: [
      { label_en: '', label_cn: '', color_hex: POLL_PALETTE[0], votes: 0 },
      { label_en: '', label_cn: '', color_hex: POLL_PALETTE[1], votes: 0 },
    ],
  };
  renderPollForm();
}

function editPoll(id) {
  const p = _pollsCache.find(x => x.id === id);
  if (!p) return;
  _pollDraft = JSON.parse(JSON.stringify(p));
  _pollDraft.closes_at = _pollDraft.closes_at ? String(_pollDraft.closes_at).slice(0, 16).replace(' ', 'T') : '';
  if (!Array.isArray(_pollDraft.options)) _pollDraft.options = [];
  renderPollForm();
}

function renderPollForm() {
  const d = _pollDraft;
  if (!d) { $('#vot-form-mount').innerHTML = ''; return; }
  const isEdit = !!d.id;
  const hasVotes = (d.options || []).some(o => (o.votes || 0) > 0);
  const realTotal = (d.options || []).reduce((s, o) => s + (o.votes || 0), 0);
  const optsHtml = (d.options || []).map((o, i) => `
    <div class="vot-opt" data-idx="${i}">
      <div class="vot-opt-letter">${pollLetter(i)}</div>
      <input type="text" placeholder="Label · EN" value="${escapeAttr(o.label_en || '')}" oninput="pollOptEdit(${i}, 'label_en', this.value)"/>
      <input type="text" placeholder="标签 · 中文" value="${escapeAttr(o.label_cn || '')}" oninput="pollOptEdit(${i}, 'label_cn', this.value)"/>
      <div class="vot-opt-color">
        <input type="color" value="${escapeAttr(o.color_hex || '#CCD900')}" oninput="pollOptEdit(${i}, 'color_hex', this.value)" title="Card color"/>
        <input type="text" value="${escapeAttr(o.color_hex || '')}" placeholder="#hex" oninput="pollOptEdit(${i}, 'color_hex', this.value)" style="width: 70px; font-size: 11px;"/>
      </div>
      <div class="vot-opt-votes">${(o.votes || 0)} votes</div>
      <button class="btn vot-opt-rm" onclick="pollOptRemove(${i})" title="Remove option"${(o.votes || 0) > 0 ? ' disabled style="opacity:.4;cursor:not-allowed"' : ''}>×</button>
    </div>
  `).join('');

  const winnerOpts = (d.options || []).map((o, i) =>
    `<option value="${o.id || ''}" ${String(d.winner_option_id || '') === String(o.id || '') ? 'selected' : ''}>${pollLetter(i)} · ${escapeHtml(o.label_en || '(unnamed)')}</option>`
  ).join('');

  $('#vot-form-mount').innerHTML = `
    <div class="vot-form">
      <h3>${isEdit ? cuT('Edit poll', '编辑投票') + ' #' + d.id : cuT('New poll', '新建投票')}</h3>
      <div class="muted" style="font-size: 11px;">Question + options are required (min 2 options). Customers see polls with status <code>open</code> or <code>closed</code>; <code>draft</code> stays hidden. · 问题与选项为必填(至少 2 个选项)。顾客只能看到状态为 <code>open</code> 或 <code>closed</code> 的投票;<code>draft</code> 始终隐藏。</div>

      <div class="vot-row-2">
        <div class="field">
          <label>Question · EN <span style="color:#c64242">*</span></label>
          <input type="text" id="vot-q-en" value="${escapeAttr(d.question_en || '')}" placeholder="Which kombucha flavor next?"/>
        </div>
        <div class="field">
          <label>问题 · 中文</label>
          <input type="text" id="vot-q-cn" value="${escapeAttr(d.question_cn || '')}" placeholder="下款康普茶应该是哪个口味?"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Category kicker · EN · 分类引题 · 英文</label>
          <input type="text" id="vot-cat-en" value="${escapeAttr(d.category_en || '')}" placeholder="NEW FLAVOR"/>
        </div>
        <div class="field">
          <label>类别 · 中文</label>
          <input type="text" id="vot-cat-cn" value="${escapeAttr(d.category_cn || '')}" placeholder="新口味"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Explainer · EN <span class="muted" style="font-weight: normal; letter-spacing: 0;">(italic line under the question) · (问题下方的斜体说明行)</span></label>
          <textarea id="vot-exp-en" placeholder="You spoke, we listened — Mango sold out. Pick what we develop next.">${escapeHtml(d.explainer_en || '')}</textarea>
        </div>
        <div class="field">
          <label>说明 · 中文</label>
          <textarea id="vot-exp-cn">${escapeHtml(d.explainer_cn || '')}</textarea>
        </div>
      </div>

      <div class="field">
        <label>Options · 选项 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(drag is server-side via sort_order; reorder by editing — first row becomes A) · (排序由服务端的 sort_order 决定;通过编辑来调整顺序——第一行即为 A)</span></label>
        <div class="vot-opts">${optsHtml}</div>
        <div style="margin-top: 6px;">
          <button class="btn" onclick="pollOptAdd()" ${d.options.length >= 8 ? 'disabled' : ''}>+ Add option · 添加选项</button>
          <span class="muted" style="font-size: 11px; margin-left: 8px;">${d.options.length}/8 options</span>
          ${hasVotes ? '<span class="muted" style="font-size: 11px; margin-left: 8px;">· options with votes can\'t be removed individually — use the "Hard reset" toggle below to wipe all votes · 含有投票的选项不能单独删除——请用下方“硬重置”开关清空所有投票</span>' : ''}
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Status · 状态</label>
          <select id="vot-status">
            <option value="draft"  ${d.status === 'draft'  ? 'selected' : ''}>Draft (hidden) · 草稿(隐藏)</option>
            <option value="open"   ${d.status === 'open'   ? 'selected' : ''}>Open · accepting votes · 进行中 · 接受投票</option>
            <option value="closed" ${d.status === 'closed' ? 'selected' : ''}>Closed · show result · 已结束 · 显示结果</option>
          </select>
        </div>
        <div class="field">
          <label>Reward points · 投票积分奖励</label>
          <input type="number" id="vot-reward" value="${d.reward_points != null ? d.reward_points : 5}" min="0" max="100"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Closes at <span class="muted" style="font-weight: normal; letter-spacing: 0;">(cosmetic — shown as "N days left")</span></label>
          <input type="datetime-local" id="vot-closes" value="${escapeAttr(d.closes_at || '')}"/>
        </div>
        <div class="field">
          <label>Featured? · 精选? <span class="muted" style="font-weight: normal; letter-spacing: 0;">(promotes this poll to the big top card) · (将此投票提升为顶部大卡片)</span></label>
          <select id="vot-featured">
            <option value="0" ${!d.is_featured ? 'selected' : ''}>No · 否</option>
            <option value="1" ${d.is_featured  ? 'selected' : ''}>Featured · 精选</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Show vote count as · 对外显示票数 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(0 = show the real count) · (0 = 显示真实票数)</span></label>
        <input type="number" id="vot-display-min" min="0" max="100000"
               value="${d.display_min_total != null ? d.display_min_total : 0}"
               oninput="pollBoostPreview()"/>
        <div class="muted" id="vot-display-preview" style="font-size: 11px; margin-top: 4px;"></div>
        <div class="muted" style="font-size: 11px;">Customers see at least this many votes — every option is scaled up by the same factor, so the percentages and the winner stay identical. The real count (<b>${realTotal}</b>) is unchanged here in the office and in your data. · 顾客至少看到这么多票;所有选项按同一比例放大,百分比与领先项不变。真实票数(<b>${realTotal}</b>)在后台与数据中保持不变。</div>
      </div>

      ${isEdit ? `
      <div class="vot-row-2">
        <div class="field">
          <label>Winner option · 获胜选项 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(only used when Closed) · (仅在已结束时生效)</span></label>
          <select id="vot-winner">
            <option value="">— (auto: highest vote count) · —(自动:票数最高)</option>
            ${winnerOpts}
          </select>
        </div>
        <div class="field">
          <label>Sort order · 排序 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(lower appears first within status) · (数值越小在同状态内越靠前)</span></label>
          <input type="number" id="vot-sort" value="${d.sort_order || 0}"/>
        </div>
      </div>

      ${hasVotes ? `
      <div class="field">
        <label class="danger" style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="vot-replace-opts"/> Hard reset options · 硬重置选项 (clears all ${d.total_votes || 0} votes · 将清空全部 ${d.total_votes || 0} 票)
        </label>
        <div class="muted" style="font-size: 11px;">Use this only when reworking the question entirely. Otherwise just edit labels in place — vote counts are preserved. · 仅在彻底改写问题时使用;否则直接就地编辑文本即可,投票数会保留。</div>
      </div>
      ` : ''}
      ` : `
      <div class="field">
        <label>Sort order · 排序</label>
        <input type="number" id="vot-sort" value="${d.sort_order || 0}"/>
      </div>
      `}

      <div class="vot-form-actions">
        <button class="btn btn-primary" onclick="savePoll()">${isEdit ? cuT('Save changes', '保存更改') : cuT('Create poll', '创建投票')}</button>
        <button class="btn" onclick="cancelPollEdit()">Cancel · 取消</button>
        <div style="flex: 1"></div>
        ${isEdit ? `<button class="btn danger" onclick="deletePoll(${d.id})">Delete · 删除</button>` : ''}
      </div>
    </div>
  `;
  pollBoostPreview();   // seed the "real → shown" hint for the loaded value
}

function pollOptEdit(i, field, value) {
  if (!_pollDraft) return;
  if (!_pollDraft.options[i]) return;
  _pollDraft.options[i][field] = value;
  // Don't re-render on every keystroke — only on structural changes.
}

// Live "real → shown" preview under the display-vote-count input. Mirrors the
// server's applyPollDisplayBoost exactly: scale every option by the same factor
// when the floor is above real turnout; never shrink; no ratio to inflate at 0.
function pollBoostPreview() {
  const out = $('#vot-display-preview');
  if (!out || !_pollDraft) return;
  const opts = _pollDraft.options || [];
  const realTotal = opts.reduce((s, o) => s + (o.votes || 0), 0);
  const floor = Math.max(0, parseInt($('#vot-display-min')?.value, 10) || 0);
  if (!floor || realTotal <= 0 || floor <= realTotal) {
    out.innerHTML = realTotal > 0
      ? cuT(`Showing the real ${realTotal} votes.`, `按真实票数 ${realTotal} 显示。`)
      : cuT('No votes yet — nothing to scale until the first real vote.', '暂无投票 — 在首次真实投票前不会放大。');
    return;
  }
  const factor = floor / realTotal;
  let shown = 0;
  const parts = opts.map(o => {
    const v = Math.round((o.votes || 0) * factor);
    shown += v;
    return `${escapeHtml(o.label_en || '?')} ${o.votes || 0}→<b>${v}</b>`;
  });
  out.innerHTML = cuT(
    `Customers will see ~<b>${shown}</b> votes (×${factor.toFixed(1)}): `,
    `顾客将看到约 <b>${shown}</b> 票(×${factor.toFixed(1)}):`
  ) + parts.join(' · ');
}

function pollOptAdd() {
  if (!_pollDraft) return;
  if (_pollDraft.options.length >= 8) return;
  const i = _pollDraft.options.length;
  _pollDraft.options.push({
    label_en: '', label_cn: '',
    color_hex: POLL_PALETTE[i % POLL_PALETTE.length],
    votes: 0,
  });
  renderPollForm();
}

function pollOptRemove(i) {
  if (!_pollDraft) return;
  if ((_pollDraft.options[i]?.votes || 0) > 0) return;
  _pollDraft.options.splice(i, 1);
  renderPollForm();
}

function _collectPollFormState() {
  const d = _pollDraft;
  if (!d) return null;
  const out = {
    question_en:  $('#vot-q-en').value.trim(),
    question_cn:  $('#vot-q-cn').value.trim(),
    category_en:  $('#vot-cat-en').value.trim(),
    category_cn:  $('#vot-cat-cn').value.trim(),
    explainer_en: $('#vot-exp-en').value.trim(),
    explainer_cn: $('#vot-exp-cn').value.trim(),
    status:       $('#vot-status').value,
    reward_points: Math.max(0, parseInt($('#vot-reward').value, 10) || 0),
    is_featured:  $('#vot-featured').value === '1' ? 1 : 0,
    closes_at:    $('#vot-closes').value || null,
    sort_order:   parseInt($('#vot-sort').value, 10) || 0,
    display_min_total: Math.max(0, parseInt($('#vot-display-min')?.value, 10) || 0),
    options:      d.options.map((o, i) => ({
      id:         o.id || null,
      label_en:   String(o.label_en || '').trim(),
      label_cn:   String(o.label_cn || '').trim(),
      color_hex:  String(o.color_hex || '').trim(),
      image_url:  String(o.image_url || '').trim(),
      sort_order: i,
    })),
  };
  if (d.id) {
    const winSel = $('#vot-winner');
    if (winSel) out.winner_option_id = winSel.value ? parseInt(winSel.value, 10) : null;
    const replace = $('#vot-replace-opts');
    if (replace) out.replace_options = !!replace.checked;
  }
  return out;
}

async function savePoll() {
  if (!_pollDraft) return;
  const body = _collectPollFormState();
  if (!body.question_en) { toast('Question (EN) is required · 英文问题必填', 'err'); return; }
  const realOpts = body.options.filter(o => o.label_en);
  if (realOpts.length < 2) { toast('At least 2 options required · 至少需要 2 个选项', 'err'); return; }
  body.options = realOpts;

  try {
    if (_pollDraft.id) {
      await api('/api/retail-admin/polls/' + _pollDraft.id, { method: 'PUT', body });
      toast('Poll saved · 投票已保存');
    } else {
      await api('/api/retail-admin/polls', { method: 'POST', body });
      toast('Poll created · 投票已创建');
    }
    _pollDraft = null;
    $('#vot-form-mount').innerHTML = '';
    await loadPolls();
  } catch (e) {
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

function cancelPollEdit() {
  _pollDraft = null;
  $('#vot-form-mount').innerHTML = '';
}

async function quickPollStatus(id, status) {
  if (status === 'open' && !(await askConfirm({ title: 'Publish this poll? Customers will see it immediately and start earning points for voting. · 发布此投票?顾客会立即看到并通过投票获得积分。', confirmLabel: 'Publish poll' }))) return;
  if (status === 'closed' && !(await askConfirm({ title: 'Close this poll? Voting will be locked. · 关闭此投票?投票将被锁定。', confirmLabel: 'Close poll' }))) return;
  try {
    await api('/api/retail-admin/polls/' + id, { method: 'PUT', body: { status } });
    toast('Poll → · 投票状态 → ' + status);
    await loadPolls();
  } catch (e) { toast('Failed · 失败: ' + e.message, 'err'); }
}

async function deletePoll(id) {
  if (!(await askConfirm({ title: 'Delete this poll? All vote records are removed too. · 删除此投票?所有投票记录也将一并删除。', confirmLabel: 'Delete poll', danger: true }))) return;
  try {
    await api('/api/retail-admin/polls/' + id, { method: 'DELETE' });
    if (_pollDraft && _pollDraft.id === id) {
      _pollDraft = null;
      $('#vot-form-mount').innerHTML = '';
    }
    toast('Poll deleted · 投票已删除');
    await loadPolls();
  } catch (e) { toast('Delete failed · 删除失败: ' + e.message, 'err'); }
}

// Intro tagline editor — the line shown under the "Your say" headline.
// Stored under storefront_config.voting.config; read live by the mini app.
async function loadVotingConfig() {
  try {
    const r = await api('/api/retail-admin/voting/config');
    const c = r.data || {};
    const en = $('#vot-intro-en'), cn = $('#vot-intro-cn'), sc = $('#vot-show-counts');
    if (en) en.value = c.intro_en || '';
    if (cn) cn.value = c.intro_cn || '';
    if (sc) sc.checked = c.show_counts !== false;
  } catch (e) { /* leave placeholders if the load fails */ }
}

async function saveVotingConfig(btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/api/retail-admin/voting/config', {
      method: 'PUT',
      body: {
        intro_en: $('#vot-intro-en').value.trim(),
        intro_cn: $('#vot-intro-cn').value.trim(),
        show_counts: !!($('#vot-show-counts') && $('#vot-show-counts').checked),
      },
    });
    toast('Saved · 已保存');
  } catch (e) {
    toast('Save failed · 保存失败: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.querySelector('[data-tab="voting"]').addEventListener('click', () => {
  if (!POLLS_LOADED) { POLLS_LOADED = true; loadPolls(); loadVotingConfig(); }
});

// ─── About page editor ─────────────────────────────────────────────────
// Stored as one JSON blob under storefront_config.about.content. The
// mini app reads it from /api/retail/config and renders pages/about/about.
let ABOUT_LOADED = false;
let ABOUT_STATE = null;

const ABOUT_DEFAULTS = {
  kicker_en: 'WHO WE ARE',
  kicker_cn: '我们是谁',
  manifesto_en: 'We exist to make **plant-based food** so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
  manifesto_cn: '我们存在的意义,是把**植物食物**做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
  stats: [
    { value_en: '2017', value_cn: '2017', label_en: 'EST.',     label_cn: '成立' },
    { value_en: '广州', value_cn: '广州', label_en: 'MADE IN',  label_cn: '产地' },
    { value_en: '50+',  value_cn: '50+',  label_en: 'PRODUCTS', label_cn: '产品' },
    { value_en: '100%', value_cn: '100%', label_en: 'PLANT',    label_cn: '植物' },
  ],
  founder_kicker_en: 'MEET THE FOUNDER',
  founder_kicker_cn: '创始人',
  founder_name_en: 'Founder Name',
  founder_name_cn: '创始人姓名',
  founder_title_en: 'FOUNDER & CEO',
  founder_title_cn: '创始人兼首席执行官',
  founder_quote_en: 'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
  founder_quote_cn: '我创立 Roots,是想证明植物从来不该是无聊的选择。',
  founder_photo_url: '',
  promise_kicker_en: 'OUR PROMISE',
  promise_kicker_cn: '我们的承诺',
  in_items: [
    { en: '100% plant-based',     cn: '100% 植物' },
    { en: 'Made from scratch',    cn: '原料自制' },
    { en: 'Real fermentation',    cn: '真发酵' },
    { en: 'Whole ingredients',    cn: '完整食材' },
    { en: 'Small batch',          cn: '小批量' },
    { en: 'Seasonal',             cn: '应季' },
    { en: 'Local-first · 广州',   cn: '本地优先' },
    { en: 'Recyclable packaging', cn: '可回收包装' },
  ],
  out_items: [
    { en: 'Preservatives',     cn: '防腐剂' },
    { en: 'Refined sugar',     cn: '精制糖' },
    { en: 'Artificial color',  cn: '人造色素' },
    { en: 'Artificial flavor', cn: '人造香精' },
    { en: 'Additives',         cn: '添加剂' },
    { en: 'GMO',               cn: '转基因' },
    { en: 'Animal products',   cn: '动物产品' },
    { en: 'Cutting corners',   cn: '走捷径' },
  ],
  outro_en: 'From soil to soul.',
  outro_cn: '从土壤到灵魂',
  cta_en: 'SHOP NOW',
  cta_cn: '立即购买',
};

async function loadAbout() {
  try {
    const { data } = await api('/api/retail/config');
    const stored = data?.about?.content;
    ABOUT_STATE = stored && typeof stored === 'object'
      ? { ...ABOUT_DEFAULTS, ...stored }
      : { ...ABOUT_DEFAULTS };
    // Make sure arrays exist
    if (!Array.isArray(ABOUT_STATE.stats))     ABOUT_STATE.stats     = ABOUT_DEFAULTS.stats.slice();
    if (!Array.isArray(ABOUT_STATE.in_items))  ABOUT_STATE.in_items  = ABOUT_DEFAULTS.in_items.slice();
    if (!Array.isArray(ABOUT_STATE.out_items)) ABOUT_STATE.out_items = ABOUT_DEFAULTS.out_items.slice();
    paintAbout();
  } catch (e) {
    console.warn('about load failed', e);
    ABOUT_STATE = { ...ABOUT_DEFAULTS };
    paintAbout();
  }
}

function paintAbout() {
  const a = ABOUT_STATE;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  set('about-kicker-en', a.kicker_en);
  set('about-kicker-cn', a.kicker_cn);
  set('about-manifesto-en', a.manifesto_en);
  set('about-manifesto-cn', a.manifesto_cn);
  set('about-founder-kicker-en', a.founder_kicker_en);
  set('about-founder-kicker-cn', a.founder_kicker_cn);
  set('about-founder-name-en', a.founder_name_en);
  set('about-founder-name-cn', a.founder_name_cn);
  set('about-founder-title-en', a.founder_title_en);
  set('about-founder-title-cn', a.founder_title_cn);
  set('about-founder-quote-en', a.founder_quote_en);
  set('about-founder-quote-cn', a.founder_quote_cn);
  set('about-promise-kicker-en', a.promise_kicker_en);
  set('about-promise-kicker-cn', a.promise_kicker_cn);
  set('about-outro-en', a.outro_en);
  set('about-outro-cn', a.outro_cn);
  set('about-cta-en', a.cta_en);
  set('about-cta-cn', a.cta_cn);
  paintAboutPhoto();
  paintAboutStats();
  paintAboutBullets();
}

function paintAboutPhoto() {
  const wrap = document.getElementById('about-founder-photo-preview');
  const url = ABOUT_STATE.founder_photo_url || '';
  if (url) {
    wrap.innerHTML = `<img src="${escapeAttr(url)}" alt="Founder">`;
  } else {
    wrap.innerHTML = '<div class="ab-photo-empty">No photo — placeholder tile will show. · 暂无照片 — 将显示占位图块。</div>';
  }
}

function paintAboutStats() {
  const tbody = document.getElementById('about-stats-tbody');
  tbody.innerHTML = ABOUT_STATE.stats.map((s, i) => `
    <tr>
      <td style="width:30px;color:var(--text-3,#888);font-size:12px;">${i + 1}</td>
      <td><input type="text" value="${escapeAttr(s.value_en || '')}" oninput="ABOUT_STATE.stats[${i}].value_en=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.value_cn || '')}" oninput="ABOUT_STATE.stats[${i}].value_cn=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.label_en || '')}" oninput="ABOUT_STATE.stats[${i}].label_en=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.label_cn || '')}" oninput="ABOUT_STATE.stats[${i}].label_cn=this.value"></td>
    </tr>
  `).join('');
}

function paintAboutBullets() {
  for (const which of ['in', 'out']) {
    const tbody = document.getElementById(`about-${which}-tbody`);
    const arr = ABOUT_STATE[`${which}_items`];
    tbody.innerHTML = arr.map((it, i) => `
      <tr>
        <td style="width:24px;color:var(--text-3,#888);font-size:11px;">${i + 1}</td>
        <td><input type="text" value="${escapeAttr(it.en || '')}" oninput="ABOUT_STATE.${which}_items[${i}].en=this.value"></td>
        <td><input type="text" value="${escapeAttr(it.cn || '')}" oninput="ABOUT_STATE.${which}_items[${i}].cn=this.value"></td>
        <td style="width:32px;"><button class="btn btn-sm" onclick="aboutRemoveBullet('${which}', ${i})">×</button></td>
      </tr>
    `).join('');
  }
}

function aboutAddBullet(which) {
  ABOUT_STATE[`${which}_items`].push({ en: '', cn: '' });
  paintAboutBullets();
}
function aboutRemoveBullet(which, i) {
  ABOUT_STATE[`${which}_items`].splice(i, 1);
  paintAboutBullets();
}

function collectAbout() {
  const get = id => document.getElementById(id)?.value || '';
  return {
    kicker_en: get('about-kicker-en'),
    kicker_cn: get('about-kicker-cn'),
    manifesto_en: get('about-manifesto-en'),
    manifesto_cn: get('about-manifesto-cn'),
    stats: ABOUT_STATE.stats.map(s => ({
      value_en: s.value_en || '', value_cn: s.value_cn || '',
      label_en: s.label_en || '', label_cn: s.label_cn || '',
    })),
    founder_kicker_en: get('about-founder-kicker-en'),
    founder_kicker_cn: get('about-founder-kicker-cn'),
    founder_name_en: get('about-founder-name-en'),
    founder_name_cn: get('about-founder-name-cn'),
    founder_title_en: get('about-founder-title-en'),
    founder_title_cn: get('about-founder-title-cn'),
    founder_quote_en: get('about-founder-quote-en'),
    founder_quote_cn: get('about-founder-quote-cn'),
    founder_photo_url: ABOUT_STATE.founder_photo_url || '',
    promise_kicker_en: get('about-promise-kicker-en'),
    promise_kicker_cn: get('about-promise-kicker-cn'),
    in_items:  ABOUT_STATE.in_items.map(it  => ({ en: it.en || '', cn: it.cn || '' })),
    out_items: ABOUT_STATE.out_items.map(it => ({ en: it.en || '', cn: it.cn || '' })),
    outro_en: get('about-outro-en'),
    outro_cn: get('about-outro-cn'),
    cta_en: get('about-cta-en'),
    cta_cn: get('about-cta-cn'),
  };
}

async function saveAbout() {
  const status = document.getElementById('about-save-status');
  status.textContent = 'Saving…';
  try {
    const next = collectAbout();
    ABOUT_STATE = { ...ABOUT_STATE, ...next };
    await api('/api/retail-admin/config', {
      method: 'PUT',
      body: { 'about.content': next },
    });
    status.textContent = 'Saved · ' + new Date().toLocaleTimeString();
    toast('About page saved · 已保存');
  } catch (e) {
    status.textContent = 'Save failed · 保存失败: ' + e.message;
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

// Photo upload — uses the CMS media endpoint (multipart, field 'file').
document.getElementById('about-founder-photo-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('Image too large (max 4MB) · 图片过大(上限 4MB)', 'err'); return; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/retail-admin/cms/media', {
      method: 'POST', body: fd, credentials: 'same-origin',
    });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'upload_failed');
    ABOUT_STATE.founder_photo_url = j.data.url || ('/api/retail/media/' + j.data.id);
    paintAboutPhoto();
    toast('Photo uploaded — remember to Save · 图片已上传 — 记得点保存');
  } catch (err) {
    toast('Upload failed · 上传失败: ' + err.message, 'err');
  }
  e.target.value = '';
});

document.getElementById('about-founder-photo-clear').addEventListener('click', () => {
  ABOUT_STATE.founder_photo_url = '';
  paintAboutPhoto();
});

document.querySelector('[data-tab="about"]').addEventListener('click', () => {
  if (!ABOUT_LOADED) { ABOUT_LOADED = true; loadAbout(); }
});

let MEDIA_LOADED = false;
document.querySelector('[data-tab="media"]').addEventListener('click', () => {
  if (!MEDIA_LOADED) { MEDIA_LOADED = true; loadMedia(); }
});

// ─── Live Preview drawer ────────────────────────────────────────────────
// Embeds /storefront in a phone-shaped iframe inside a side drawer so
// the user can sanity-check CMS / catalog changes without leaving the
// Backend. Iframe is mounted lazily on first open; subsequent opens
// reuse it. "Refresh" reloads the iframe (handy after publishing CMS
// edits). "Open in new tab" lets the user pop it out if they prefer.
function openLivePreview() {
  const drawer = document.getElementById('live-preview-drawer');
  const mount  = document.getElementById('live-preview-mount');
  if (!drawer || !mount) return;
  if (!mount.querySelector('iframe')) {
    const ifr = document.createElement('iframe');
    ifr.id = 'live-preview-iframe';
    ifr.src = '/storefront?preview=1';
    ifr.title = 'Live storefront preview';
    ifr.setAttribute('loading', 'lazy');
    mount.appendChild(ifr);
  }
  openDrawer('#live-preview-drawer');
}
function reloadLivePreview() {
  const ifr = document.getElementById('live-preview-iframe');
  if (ifr) ifr.src = ifr.src;  // reassign forces reload
}
function popOutLivePreview() {
  window.open('/storefront?preview=1', '_blank', 'noopener');
  closeDrawer('#live-preview-drawer');
}

// Re-apply language to JS-controlled elements when user toggles language.
window.onLangChange(function () {
  // Re-render dashboard tiles so product names switch language immediately.
  if (typeof bentoRenderAll === 'function') { try { bentoRenderAll(); } catch (e) {} }
  // Re-render the products list so its cuT() labels (overview table header,
  // variant "sizes" meta) follow the toggle without needing a search/filter.
  if (typeof paRender === 'function') { try { paRender(); } catch (e) {} }
  // Leaderboard enabled pill
  if (typeof lbUpdateEnabledPill === 'function') lbUpdateEnabledPill();
  // Flash sale form labels — re-set based on whether an edit is in progress
  const saveLabel = $('#fs-save-label');
  if (saveLabel) {
    const editId = $('#fs-edit-product-id');
    if (editId && editId.value) {
      saveLabel.textContent = cuT('Update flash sale', '更新秒杀');
    } else {
      const formTitle = $('#fs-form-title');
      if (formTitle) formTitle.textContent = cuT('New flash sale', '新建秒杀');
      saveLabel.textContent = cuT('Save flash sale', '保存秒杀');
    }
  }
});



// ?tab= deep-link boot — relocated here from part 01 so the synchronous
// .click() runs AFTER every part has registered its lazy-load tab listener
// (in the old single file it fired before them and deep-linked tabs never
// lazy-loaded; it also kept a cross-file hoisting dependency alive).
// Deep-link: /retail-admin?tab=orders opens that tab directly. Used by the
// new-order push notification so clicking it lands the operator on Orders.
(function () {
  try {
    const want = new URLSearchParams(location.search).get('tab');
    if (!want || !/^[a-z_]+$/.test(want)) return;
    const b = document.querySelector('.tabs [data-tab="' + want + '"]');
    if (b) b.click();
  } catch (e) {}
})();

// ════════════════════════════════════════════════════════════════
// versionWatch — pick up a new build without asking
// The backend shell is served no-store and registers no service worker, so a
// plain reload always pulls fresh JS — but operators keep this tab open for
// hours and otherwise never know a new build shipped. We poll /api/version (a
// token that changes on every deploy / restart) and, once it differs from what
// the page booted with, reload silently — but ONLY at a moment where a reload
// cannot cost the operator anything.
//
// That guard is the whole point. An earlier watcher hard-reloaded on refocus
// and produced "the admin refreshes by itself": an operator halfway through an
// order edit lost the edit and never learned why. So we wait for a safe moment
// — the tab is out of sight, or it has sat untouched for a while — and in
// either case no drawer is open, no field has been typed into, nothing is
// mid-save. If the operator never steps away, we never reload. Sitting on an
// old build is cheap; losing an edit is not.
// ════════════════════════════════════════════════════════════════
(function versionWatch() {
  const IDLE_MS = 10 * 60 * 1000;   // untouched this long = safe to reload in place
  const POLL_MS =  2 * 60 * 1000;

  let bootVersion = null;   // token the page loaded with
  let pending     = false;  // a newer build exists; waiting for a safe moment
  let lastTouch   = Date.now();

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));

  async function fetchVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json());
      return r && r.success ? r.version : null;
    } catch { return null; }
  }

  // Anything on screen the operator could be part-way through.
  function overlayOpen() {
    return !!document.querySelector(
      '.side-drawer.open, .drawer.open, [id$="-drawer"].open, [id$="-scrim"].open, ' +
      '.modal.open, .modal.show, dialog[open]'
    );
  }

  // A field typed into but not saved. defaultValue / defaultChecked hold what the
  // markup (or the last render) put there, so a difference means a human changed it.
  function unsavedEdits() {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.disabled || el.readOnly || el.type === 'search' || el.type === 'hidden') continue;
      if (el.tagName === 'SELECT') {
        if ([...el.options].some(o => o.selected !== o.defaultSelected)) return true;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return true;
      } else if (el.value !== el.defaultValue) return true;
    }
    return false;
  }

  function inFlight() {
    return !!document.querySelector('button.busy, .btn.busy, [aria-busy="true"]');
  }

  function safeToReload() {
    const away = document.visibilityState === 'hidden';
    const idle = Date.now() - lastTouch > IDLE_MS;
    if (!away && !idle) return false;
    return !overlayOpen() && !unsavedEdits() && !inFlight();
  }

  function maybeReload() {
    if (pending && safeToReload()) location.reload();
  }

  async function check() {
    const v = await fetchVersion();
    if (!v) return;
    if (bootVersion === null) { bootVersion = v; return; }   // first read = baseline
    if (v !== bootVersion) pending = true;
    maybeReload();
  }

  check();                                // establish baseline on load
  setInterval(check, POLL_MS);
  setInterval(maybeReload, 30 * 1000);    // idle can arrive between polls
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') maybeReload();   // reload behind their back, never under their hands
    else { lastTouch = Date.now(); check(); }
  });
})();

// ════════════════════════════════════════════════════════════════
// QUICK STOCK — the mobile inventory add-on's admin page just hosts the
// on/off switch (injected) plus a "open / copy link" helper. The app itself
// lives at /stock (served on the same origin, self-authenticating).
// ════════════════════════════════════════════════════════════════
function qsStockLink() { return location.origin + '/stock'; }
function qsCopyStockLink() {
  const link = qsStockLink();
  const done = () => toast(cuT('Link copied · 链接已复制', '链接已复制'));
  const fail = () => toast('Copy failed · 复制失败', 'err');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done, fail);
  } else {
    fail();
  }
}
// Populate the shown link once the DOM is ready (the code elements are static).
// Quick Stock and Add Stock share the same /stock link — the view is chosen by
// the staffer's role, so both cards show the same URL.
(function () {
  function fill() {
    const link = qsStockLink();
    ['qs-link', 'ka-link'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = link; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
