/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 05/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: vouchers/coupons + grants, snippets editor, storefront settings + feature gates + customer service, social proof, shop categories, broadcasts, pop-ups */
// ════════════════════════════════════════════════════════════════
// VOUCHERS / COUPONS
// ════════════════════════════════════════════════════════════════
async function loadVouchers() {
  const tbody = $('#vouchers-table tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="muted">Loading…</td></tr>';
  try {
    const { data } = await api('/api/retail-admin/vouchers');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="icon">' + ICONS.empty + '</div><h3>No coupons yet · 暂无优惠券</h3><p class="muted">Create one above to start running promos. · 在上方创建一张以开启活动。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = data.map(v => {
      const labelBits = [];
      if (v.title_en) labelBits.push(escapeHtml(v.title_en));
      if (v.title_cn) labelBits.push(escapeHtml(v.title_cn));
      const label = labelBits.length
        ? labelBits.join(' · ')
        : '<span class="muted">—</span>';
      const publicBadge = v.is_public
        ? '<span class="pill pub" style="font-size: 10px;">PUBLIC · 公开</span>'
        : '';
      const autoBadge = v.auto_grant_signup
        ? '<span class="pill info" style="font-size: 10px;" title="Auto-granted to every new signup · 每位新注册自动发放">AUTO · 自动</span>'
        : '';
      const autoApplyBadge = v.auto_apply
        ? '<span class="pill pub" style="font-size: 10px;" title="Applied automatically at checkout (best one wins) · 结账时自动抵扣(取最优)">AUTO-APPLY · 自动抵扣</span>'
        : '';
      const grantBadge = v.grant_count
        ? `<span class="pill info" style="font-size: 10px;">GRANTED · 已发放 ${v.grant_used_count || 0}/${v.grant_count}</span>`
        : '';
      return `
      <tr data-id="${v.id}">
        <td><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px;"><span style="font-family: var(--f-mono); font-weight: 700">${escapeHtml(v.code)}</span>${publicBadge}${autoBadge}${autoApplyBadge}${grantBadge}</div></td>
        <td style="font-size: 12px;">${label}</td>
        <td class="muted">${v.type === 'fixed_amount' ? '¥ off · 立减' : v.type === 'percent' ? '% off · 折扣' : 'Free ship · 免运费'}</td>
        <td class="numeric">${v.type === 'percent' ? v.value + '%' : (v.type === 'free_shipping' ? '—' : '¥' + fmt(v.value))}</td>
        <td class="numeric muted">${v.min_subtotal ? '¥' + fmt(v.min_subtotal) : '—'}</td>
        <td class="numeric">${v.used_count}${v.max_uses != null ? ' / ' + v.max_uses : ''}</td>
        <td class="muted">${formatDateOnly(v.expires_at)}</td>
        <td><span class="pill ${v.is_active ? 'pub' : 'draft'}"><span class="dot"></span>${v.is_active ? 'Active · 生效中' : 'Inactive · 已停用'}</span></td>
        <td style="white-space: nowrap;">
          <button class="btn btn-sm" onclick='openGrantModal(${v.id}, ${JSON.stringify(v.code)})'>Grant · 发放</button>
          <button class="btn btn-sm" onclick="togglePublic(${v.id}, ${v.is_public ? 0 : 1})">${v.is_public ? 'Make private · 设为私有' : 'Make public · 设为公开'}</button>
          <button class="btn btn-sm" onclick="toggleAutoGrant(${v.id}, ${v.auto_grant_signup ? 0 : 1})" title="Auto-grant to every new signup · 为每位新注册自动发放">${v.auto_grant_signup ? 'Stop auto-grant · 停止自动发放' : 'Auto-grant · 自动发放'}</button>
          <button class="btn btn-sm" onclick="toggleAutoApply(${v.id}, ${v.auto_apply ? 0 : 1})" title="Apply automatically at checkout — best coupon wins, no code needed · 结账时自动抵扣 — 取最优券,无需编码">${v.auto_apply ? 'Stop auto-apply · 停止自动抵扣' : 'Auto-apply · 自动抵扣'}</button>
          <button class="btn btn-sm" onclick="toggleVoucher(${v.id}, ${v.is_active ? 0 : 1})">${v.is_active ? 'Disable · 停用' : 'Enable · 启用'}</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="err">Failed · 失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function createVoucher() {
  const body = {
    code: $('#v-code').value.trim().toUpperCase(),
    type: $('#v-type').value,
    value: Number($('#v-value').value) || 0,
    min_subtotal: Number($('#v-min').value) || 0,
    max_uses: $('#v-max').value ? Number($('#v-max').value) : null,
    per_customer_limit: Number($('#v-percust').value) || 0,
    expires_at: $('#v-expires').value.trim() || null,
    is_public: $('#v-public').checked,
    auto_grant_signup: $('#v-auto-grant').checked,
    auto_apply: $('#v-auto-apply').checked,
    title_en: $('#v-title-en').value.trim() || null,
    title_cn: $('#v-title-cn').value.trim() || null,
  };
  if (!body.code) { toast('Code required · 请填写编码', 'err'); return; }
  if (body.is_public && !body.title_en && !body.title_cn) {
    toast('Public coupons need a label (EN or 中) · 公开优惠券需要填写标签', 'err'); return;
  }
  try {
    // Reusing the code of an expired/disabled coupon revives that row
    // (reused:true) rather than erroring — surface that so the operator knows
    // the old coupon was repurposed, not duplicated.
    const r = await api('/api/retail-admin/vouchers', { method: 'POST', body });
    toast(r.reused ? ('Reused code · 已复用编码 ' + body.code) : ('Created · 已创建 ' + body.code));
    ['v-code', 'v-value', 'v-min', 'v-max', 'v-expires', 'v-title-en', 'v-title-cn']
      .forEach(id => $('#' + id).value = '');
    $('#v-percust').value = '1';
    $('#v-public').checked = false;
    $('#v-auto-grant').checked = false;
    $('#v-auto-apply').checked = false;
    await loadVouchers();
  } catch (e) {
    const msg = e.message === 'code_active'
      ? 'A live coupon already uses this code — disable it first · 已有生效中的优惠券使用此编码,请先停用'
      : e.message === 'code_exists' ? 'Code already exists · 编码已存在'
      : e.message;
    toast('Failed · 失败: ' + msg, 'err');
  }
}

async function toggleVoucher(id, value) {
  try {
    await api('/api/retail-admin/vouchers/' + id, { method: 'PATCH', body: { is_active: !!value } });
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

async function togglePublic(id, value) {
  try {
    await api('/api/retail-admin/vouchers/' + id, { method: 'PATCH', body: { is_public: !!value } });
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}
async function toggleAutoGrant(id, value) {
  try {
    await api('/api/retail-admin/vouchers/' + id, { method: 'PATCH', body: { auto_grant_signup: !!value } });
    toast(value ? 'Auto-grant enabled · 已开启自动发放' : 'Auto-grant disabled · 已关闭自动发放');
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}
async function toggleAutoApply(id, value) {
  try {
    await api('/api/retail-admin/vouchers/' + id, { method: 'PATCH', body: { auto_apply: !!value } });
    toast(value ? 'Auto-apply enabled · 已开启自动抵扣' : 'Auto-apply disabled · 已关闭自动抵扣');
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

// ─── Grant-voucher modal ────────────────────────────────────────────────
let _grantVoucherId = null;
let _grantSearchTimer = null;

function openGrantModal(voucherId, code) {
  _grantVoucherId = voucherId;
  $('#grant-modal-title').textContent = 'Grant coupon · 发放优惠券 ' + code;
  $('#grant-modal-sub').textContent = 'Recipients see this in their wallet & checkout, no code needed. · 收件人会在钱包和结账时看到,无需编码。';
  $('#grant-search').value = '';
  $('#grant-note').value   = '';
  $('#grant-modal-bg').classList.add('show');
  searchGrantCustomers();
  loadGrantedList();
}
function closeGrantModal() {
  $('#grant-modal-bg').classList.remove('show');
  _grantVoucherId = null;
}

function searchGrantCustomers() {
  clearTimeout(_grantSearchTimer);
  _grantSearchTimer = setTimeout(async () => {
    const q = $('#grant-search').value.trim();
    const mount = $('#grant-results');
    mount.innerHTML = '<div class="muted" style="padding: 12px; font-size: 12px;">Searching… · 搜索中…</div>';
    try {
      const { data } = await api('/api/retail-admin/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if (!data.length) {
        mount.innerHTML = '<div class="muted" style="padding: 12px; font-size: 12px;">No customers match. · 无匹配顾客。</div>';
        return;
      }
      mount.innerHTML = data.map(c => `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line);">
          <div style="min-width: 0;">
            <div style="font-weight: 600; font-size: 13px;">${escapeHtml(c.nickname || '(no name)')}
              <span class="muted" style="font-weight: normal; margin-left: 6px;">#${c.id}</span>
            </div>
            <div class="muted" style="font-size: 11px;">${escapeHtml(c.phone || '—')} · ${escapeHtml((c.openid || '').slice(0, 16))}…</div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="grantToCustomer(${c.id})">Grant · 发放</button>
        </div>`).join('');
    } catch (e) {
      mount.innerHTML = `<div class="err" style="padding: 12px; font-size: 12px;">Failed · 失败: ${escapeHtml(e.message)}</div>`;
    }
  }, 200);
}

async function grantToCustomer(customerId) {
  if (!_grantVoucherId) return;
  const note = $('#grant-note').value.trim() || null;
  try {
    const r = await api('/api/retail-admin/vouchers/' + _grantVoucherId + '/grant', {
      method: 'POST',
      body: { customer_ids: [customerId], note },
    });
    if (r.granted) toast('Granted to customer · 已发放给顾客 #' + customerId);
    else           toast('Customer already had this coupon · 顾客已拥有此优惠券', 'err');
    await loadGrantedList();
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

async function grantToAll() {
  if (!_grantVoucherId) return;
  if (!confirm('Grant this coupon to every customer? Existing grants are kept. · 向所有顾客发放此优惠券?已有发放记录会保留。')) return;
  const note = $('#grant-note').value.trim() || null;
  try {
    const r = await api('/api/retail-admin/vouchers/' + _grantVoucherId + '/grant', {
      method: 'POST',
      body: { to_all: true, note },
    });
    toast('Granted to · 已发放给 ' + r.granted + ' customer' + (r.granted === 1 ? '' : 's') + ' / 位顾客'
        + (r.skipped ? ' (' + r.skipped + ' already had it · 已有,跳过)' : ''));
    await loadGrantedList();
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + e.message, 'err');
  }
}

async function loadGrantedList() {
  if (!_grantVoucherId) return;
  const mount = $('#grant-existing');
  mount.innerHTML = '<div class="muted" style="padding: 8px 0; font-size: 12px;">Loading… · 加载中…</div>';
  try {
    const { data } = await api('/api/retail-admin/vouchers/' + _grantVoucherId + '/grants');
    if (!data.length) {
      mount.innerHTML = '<div class="muted" style="padding: 8px 0; font-size: 12px;">No grants yet. · 暂无发放记录。</div>';
      return;
    }
    mount.innerHTML = data.map(g => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 12px;">
        <div style="min-width: 0;">
          <span style="font-weight: 600;">${escapeHtml(g.nickname || '(no name)')}</span>
          <span class="muted">#${g.customer_id} · ${escapeHtml(g.phone || '—')}</span>
          ${g.used_at
            ? '<span class="pill pub" style="margin-left: 8px; font-size: 10px;">Used · 已使用</span>'
            : '<span class="pill draft" style="margin-left: 8px; font-size: 10px;">Unused · 未使用</span>'}
        </div>
        ${g.used_at
          ? ''
          : `<button class="btn btn-sm" onclick="revokeGrant(${g.id})">Revoke · 撤销</button>`}
      </div>`).join('');
  } catch (e) {
    mount.innerHTML = `<div class="err" style="padding: 8px 0; font-size: 12px;">Failed · 失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function revokeGrant(grantId) {
  if (!confirm('Revoke this grant? · 撤销此优惠券?')) return;
  try {
    await api('/api/retail-admin/voucher-grants/' + grantId, { method: 'DELETE' });
    await loadGrantedList();
    await loadVouchers();
  } catch (e) {
    toast('Failed · 失败: ' + (e.message === 'already_used_or_missing' ? 'Already used or missing · 已使用或不存在' : e.message), 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// GUIDED COUPON WIZARD — a plain-language, draft-first front door to
// coupon creation. ADDITIVE: the advanced form above stays untouched.
// One plain "who gets it" choice maps to is_public / auto_grant_signup /
// auto_apply; a smart heads-up reads the live coupons and explains
// clashes & overlaps; everything saves through the existing POST endpoint
// (is_active:false = draft). Copy is bilingual + deliberately simple for
// non-native-English operators. See feature_voucher_wizard (memory).
// ════════════════════════════════════════════════════════════════
let _vw = null;          // the coupon being built (wizard state)
let _vwVouchers = [];     // snapshot of existing coupons, for the heads-up
const VW_STEPS = ['deal', 'who', 'rules', 'review'];  // (front door is separate)

// Inline line-icons (Tabler-style, stroke = currentColor) so the wizard matches
// the backend's monochrome icon language instead of coloured emoji.
const VW_ICONS = {
  gift: '<path d="M3 8m0 1a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1z"/><path d="M12 8l0 13"/><path d="M19 12v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0 -5a4.8 8 0 0 1 4.5 5a4.8 8 0 0 1 4.5 -5a2.5 2.5 0 0 1 0 5"/>',
  tag: '<path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/>',
  ticket: '<path d="M15 5l0 2"/><path d="M15 11l0 2"/><path d="M15 17l0 2"/><path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-3a2 2 0 0 0 0 -4v-3a2 2 0 0 1 2 -2"/>',
  truck: '<path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M5 17h-2v-11a1 1 0 0 1 1 -1h9v12m-4 0h6m4 0h2v-6h-8m0 -5h5l3 5"/>',
  pencil: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  coin: '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M15 8l-3 5l-3 -5"/><path d="M9 11h6"/><path d="M9 14h6"/><path d="M12 13v3"/>',
  percent: '<path d="M17 17m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M7 7m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M6 18l12 -12"/>',
  bolt: '<path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/>',
  users: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  alert: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  scale: '<path d="M7 20l10 0"/><path d="M6 6l6 -1l6 1"/><path d="M12 3l0 17"/><path d="M9 12l-3 -6l-3 6a3 3 0 0 0 6 0"/><path d="M21 12l-3 -6l-3 6a3 3 0 0 0 6 0"/>',
  trophy: '<path d="M8 21l8 0"/><path d="M12 17l0 4"/><path d="M7 4l10 0"/><path d="M17 4v8a5 5 0 0 1 -10 0v-8"/><path d="M5 9a2 2 0 0 1 -2 -2v-2h4"/><path d="M19 9a2 2 0 0 0 2 -2v-2h-4"/>',
  eye: '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>',
};
function vwIcon(name, size) {
  size = size || 22;
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" '
    + 'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (VW_ICONS[name] || '') + '</svg>';
}

async function vwOpen() {
  _vw = {
    goal: null, step: 'front',
    type: 'fixed_amount', value: 20,
    path: 'public', showOnHome: false,
    min: 0, expires: '', perCust: 1, maxUses: '',
    code: '', title_en: '', title_cn: '',
    codeEdited: false, labelEdited: false,
  };
  $('#vw-bg').classList.add('show');
  vwRender();
  try { const r = await api('/api/retail-admin/vouchers'); _vwVouchers = r.data || []; }
  catch { _vwVouchers = []; }
}
function vwClose() {
  // Clear the transient fade classes too: vw-leaving is opacity:0, and if the
  // operator closes mid-fade the next open would otherwise inherit it and show
  // a blank modal until they click Next/Back.
  const body = $('#vw-body');
  if (body) body.classList.remove('vw-leaving', 'vw-entering');
  $('#vw-bg').classList.remove('show');
  _vw = null;
}
// Esc closes the wizard — parity with the platform's other modals/drawers.
// Backdrop click intentionally does NOT close (would discard in-progress work);
// only Esc and the Close button dismiss it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !_vw) return;
  const bg = document.getElementById('vw-bg');
  if (bg && bg.classList.contains('show')) vwClose();
});
// Step navigation fades the current step out, swaps content while invisible,
// then fades + rises the next step in — matching the platform's calm zen motion.
// In-step re-renders (vwSetType/vwSetPath…) call vwRender() directly, so only
// Next/Back/goal-pick animate. Respects prefers-reduced-motion.
function vwGoto(step) {
  if (!_vw) return;
  const body = $('#vw-body');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!body || reduce) { _vw.step = step; vwRender(); if (body) body.scrollTop = 0; return; }
  body.classList.remove('vw-entering');
  body.classList.add('vw-leaving');
  setTimeout(() => {
    if (!_vw) return;   // closed mid-fade — don't deref null (vwClose cleared the classes)
    _vw.step = step;
    vwRender();
    body.scrollTop = 0;
    body.classList.remove('vw-leaving');
    void body.offsetWidth;            // restart the keyframe
    body.classList.add('vw-entering');
  }, 240);
}

// Preset state from a chosen goal, then drop into the first step.
function vwApplyGoal(goal) {
  _vw.goal = goal;
  if (goal === 'welcome')       Object.assign(_vw, { type: 'fixed_amount', value: 20, path: 'welcome', showOnHome: true });
  else if (goal === 'sale')     Object.assign(_vw, { type: 'percent', value: 10, path: 'auto', showOnHome: false });
  else if (goal === 'public')   Object.assign(_vw, { type: 'fixed_amount', value: 10, path: 'public', showOnHome: false });
  else if (goal === 'shipping') Object.assign(_vw, { type: 'free_shipping', value: 0, path: 'auto', showOnHome: false });
  else                          Object.assign(_vw, { type: 'fixed_amount', value: 0, path: 'public', showOnHome: false }); // fresh
  _vw.codeEdited = false; _vw.labelEdited = false;
  vwGoto('deal');
}

// ── small derived bits ──
function vwBigValue() {
  if (_vw.type === 'free_shipping') return 'FREE';
  if (_vw.type === 'percent') return (Number(_vw.value) || 0) + '%';
  return '¥' + (Number(_vw.value) || 0);
}
function vwBigUnit() { return _vw.type === 'free_shipping' ? 'shipping' : 'off'; }
function vwGenCode() {
  const v = Number(_vw.value) || 0;
  if (_vw.type === 'free_shipping') return 'FREESHIP';
  if (_vw.path === 'welcome') return 'WELCOME' + (v || '');
  if (_vw.path === 'auto') return (_vw.type === 'percent' ? 'SAVE' : 'SALE') + (v || '');
  return (_vw.type === 'percent' ? 'PERCENT' : 'OFF') + (v || '');
}
function vwGenLabelEn() {
  if (_vw.type === 'free_shipping') return 'Free shipping';
  const amt = _vw.type === 'percent' ? (Number(_vw.value) || 0) + '% off' : '¥' + (Number(_vw.value) || 0) + ' off';
  return _vw.path === 'welcome' ? amt + ' your first order' : amt;
}
function vwGenLabelCn() {
  if (_vw.type === 'free_shipping') return '免运费';
  const amt = _vw.type === 'percent' ? (Number(_vw.value) || 0) + '% 折扣' : '立减 ¥' + (Number(_vw.value) || 0);
  return _vw.path === 'welcome' ? '首单' + amt : amt;
}
function vwFlags() {
  const p = _vw.path;
  return {
    is_public: p === 'public' || (p === 'welcome' && _vw.showOnHome),
    auto_grant_signup: p === 'welcome',
    auto_apply: p === 'auto',
  };
}

function vwTicketHtml() {
  const minTxt = Number(_vw.min) > 0 ? ('orders ¥' + Number(_vw.min) + '+ · 满 ¥' + Number(_vw.min)) : 'any order · 无门槛';
  const who = _vw.path === 'welcome' ? 'new customers · 新顾客'
            : _vw.path === 'auto'   ? 'automatic, no code · 自动,无需编码'
            : _vw.path === 'public' ? 'anyone can use · 人人可用'
            : 'customers you pick · 你指定的顾客';
  const exp = _vw.expires ? ('Ends ' + _vw.expires) : 'No end date · 永久';
  // The big number already shows the value, so only show the marketing label
  // when it ADDS something (a welcome phrase, or a label the operator edited) —
  // never echo "5% off" twice. Computed live so it tracks the value as you type.
  const ttl = _vw.labelEdited ? (_vw.title_en || '') : vwGenLabelEn();
  const echo = _vw.type === 'percent' ? ((Number(_vw.value) || 0) + '% off')
             : _vw.type === 'fixed_amount' ? ('¥' + (Number(_vw.value) || 0) + ' off')
             : 'free shipping';
  const showTtl = ttl && ttl.trim().toLowerCase() !== echo.toLowerCase();
  return '<div class="vw-ticket" id="vw-ticket"><div class="vw-tk-big" id="vw-tk-big">' + vwBigValue() + ' <span>' + vwBigUnit() + '</span></div>'
    + '<div class="vw-tk-sub">' + minTxt + '</div>'
    + (showTtl ? '<div class="vw-tk-ttl">' + escapeHtml(ttl) + '</div>' : '')
    + '<div class="vw-tk-exp">' + who + ' · ' + escapeHtml(exp) + '</div></div>';
}

function vwDots(active) {
  return '<div class="vw-dots">' + VW_STEPS.map(s => '<span class="vw-dot' + (s === active ? ' on' : '') + '"></span>').join('') + '</div>';
}
function vwFoot(backStep, nextFn, active) {
  return '<button class="btn" onclick="vwGoto(\'' + backStep + '\')">Back · 返回</button>'
    + vwDots(active)
    + '<button class="btn btn-primary" onclick="' + nextFn + '">Next · 下一步</button>';
}

function vwRender() {
  const title = $('#vw-title'), body = $('#vw-body'), foot = $('#vw-foot');
  const s = _vw.step;
  foot.style.display = (s === 'front') ? 'none' : 'flex';
  if (s === 'front') {
    title.textContent = 'Make a coupon · 新建优惠券';
    body.innerHTML = vwFrontHtml();
  } else if (s === 'deal') {
    title.textContent = 'The deal · 优惠内容';
    body.innerHTML = vwDealHtml();
    foot.innerHTML = vwFoot('front', 'vwNextDeal()', 'deal');
  } else if (s === 'who') {
    title.textContent = 'Who gets it · 谁可以用';
    body.innerHTML = vwWhoHtml();
    foot.innerHTML = vwFoot('deal', 'vwNextWho()', 'who');
  } else if (s === 'rules') {
    title.textContent = 'Rules & dates · 规则与日期';
    body.innerHTML = vwRulesHtml();
    foot.innerHTML = vwFoot('who', 'vwNextRules()', 'rules');
  } else if (s === 'review') {
    title.textContent = 'Review · 确认';
    body.innerHTML = vwReviewHtml();
    foot.innerHTML = '<button class="btn" onclick="vwGoto(\'rules\')">Back · 返回</button>' + vwDots('review')
      + '<span style="display:flex;gap:8px;">'
      + '<button class="btn" onclick="vwSave(true)">Save &amp; turn on · 保存并开启</button>'
      + '<button class="btn btn-primary" onclick="vwSave(false)">Save as draft · 存为草稿</button></span>';
  }
}

function vwFrontHtml() {
  const goals = [
    ['welcome', 'gift', 'Welcome gift · 新人礼', 'A thank-you for new customers · 给新顾客的感谢'],
    ['sale', 'tag', 'Store sale · 店铺促销', 'An automatic discount, no code needed · 自动折扣,无需编码'],
    ['public', 'ticket', 'A coupon anyone can use · 人人可领', 'People find it and tap to save · 顾客自己领取'],
    ['shipping', 'truck', 'Free shipping · 免运费', 'Take the delivery fee off · 减免运费'],
    ['fresh', 'pencil', 'Start fresh · 从头开始', 'Set it up myself · 自己设置'],
  ];
  return '<div class="vw-lab" style="margin-bottom:2px;">What do you want to do? · 你想做什么?</div>'
    + '<div class="vw-goals">'
    + goals.map(g => '<button class="vw-goal" onclick="vwApplyGoal(\'' + g[0] + '\')"><span class="vico">' + vwIcon(g[1], 26) + '</span>'
        + '<span><span class="gt">' + g[2] + '</span><br><span class="gs">' + g[3] + '</span></span></button>').join('')
    + '</div>';
}

function vwDealHtml() {
  const types = [
    ['fixed_amount', 'coin', 'Money off · 立减', 'a set ¥ amount · 固定金额'],
    ['percent', 'percent', 'Percent off · 折扣', 'a % of the order · 按比例'],
    ['free_shipping', 'truck', 'Free shipping · 免运费', 'no delivery fee · 不收运费'],
  ];
  const cards = types.map(t => '<div class="vw-type' + (_vw.type === t[0] ? ' on' : '') + '" onclick="vwSetType(\'' + t[0] + '\')">'
    + '<span class="vico">' + vwIcon(t[1], 28) + '</span><div class="tt">' + t[2] + '</div><div class="ts">' + t[3] + '</div></div>').join('');
  const valBox = _vw.type === 'free_shipping' ? ''
    : '<div class="field" style="margin:0;max-width:260px;"><label class="vw-lab">How much do they save? · 优惠多少? (' + (_vw.type === 'percent' ? '%' : '¥') + ')</label>'
      + '<input type="number" id="vw-value" value="' + (_vw.value || '') + '" oninput="vwLiveValue(this.value)" style="width:100%;"></div>';
  return vwTicketHtml()
    + '<div class="field" style="margin:0;"><label class="vw-lab">What kind of discount? · 哪种优惠?</label>'
    + '<div style="display:flex;gap:12px;">' + cards + '</div></div>'
    + valBox
    + '<div class="vw-help">The box shows ¥ or % so it is never mixed up. · 输入框会显示 ¥ 或 %,不会弄错。</div>';
}
function vwSetType(t) { _vw.type = t; if (t === 'free_shipping') _vw.value = 0; vwRender(); }
function vwLiveValue(v) {
  _vw.value = v;
  const t = document.getElementById('vw-ticket');
  if (t) t.outerHTML = vwTicketHtml();   // re-render the whole preview so every line tracks (not just the big number)
}
function vwNextDeal() {
  if (_vw.type !== 'free_shipping') {
    const v = Number(_vw.value);
    if (!(v > 0)) { toast('Enter how much they save · 请填写优惠金额', 'err'); return; }
    if (_vw.type === 'percent' && v > 100) { toast('Percent can be at most 100 · 折扣最多 100%', 'err'); return; }
  }
  vwGoto('who');
}

function vwWhoHtml() {
  const paths = [
    ['auto', 'bolt', 'Automatic — no code needed · 自动 — 无需编码', 'Everyone gets it at checkout. The best deal wins. · 所有人结账时都享,自动取最优'],
    ['public', 'ticket', 'Anyone can use it · 人人可用', 'Shows in the app; a shared code also works. · 显示在小程序,分享的码也能用'],
    ['welcome', 'gift', 'A welcome gift for new customers · 新人礼', 'Goes into new customers’ coupons; they tap it at checkout. · 自动进入新顾客的优惠券,结账时使用'],
    ['pick', 'users', 'I choose who gets it · 我来指定', 'You pick the customers after saving. · 保存后你来挑选顾客'],
  ];
  let html = vwTicketHtml()
    + '<div class="field" style="margin:0;"><label class="vw-lab">How do customers get it? · 顾客怎么获得?</label>'
    + '<div style="display:flex;flex-direction:column;gap:10px;">'
    + paths.map(p => '<div class="vw-path' + (_vw.path === p[0] ? ' on' : '') + '" onclick="vwSetPath(\'' + p[0] + '\')">'
        + '<span class="vico">' + vwIcon(p[1], 22) + '</span><span><span class="pt">' + p[2] + '</span><br><span class="ps">' + p[3] + '</span></span>'
        + '<span class="vw-radio"></span></div>').join('')
    + '</div></div>';
  if (_vw.path === 'welcome') {
    html += '<div style="padding:11px 13px;background:var(--bg-elev-1);border-radius:8px;display:flex;justify-content:space-between;align-items:center;gap:12px;">'
      + '<span style="font-size:12.5px;">Also show it on the home page? · 也在首页展示?</span>'
      + '<span style="display:flex;gap:6px;">'
      + '<button class="btn' + (!_vw.showOnHome ? ' btn-primary' : '') + '" onclick="vwSetHome(false)">No · 否</button>'
      + '<button class="btn' + (_vw.showOnHome ? ' btn-primary' : '') + '" onclick="vwSetHome(true)">Yes · 是</button></span></div>';
  }
  return html;
}
function vwSetPath(p) { _vw.path = p; vwRender(); }
function vwSetHome(b) { _vw.showOnHome = b; vwRender(); }
function vwNextWho() { vwGoto('rules'); }

function vwRulesHtml() {
  const f = (lab, id, val, ph, type) => '<div class="field" style="margin:0;flex:1;min-width:200px;"><label class="vw-lab">' + lab
    + '</label><input type="' + (type || 'number') + '" id="' + id + '" value="' + escapeAttr(String(val)) + '" placeholder="' + (ph || '') + '" oninput="vwLiveRules()" onchange="vwLiveRules()" style="width:100%;"></div>';
  return vwTicketHtml()
    + '<div class="vw-help">These already have good defaults. Change only what you want. · 这些已有合适的默认值,只改你想改的。</div>'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
      + f('Smallest order to use it (¥) · 最低订单金额', 'vw-min', (_vw.min || ''), '0 = any order · 0 = 任意订单')
      + f('Last day it works · 截止日期', 'vw-expires', (_vw.expires || ''), 'empty = never', 'date')
    + '</div>'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
      + f('How many times can one person use it? · 每人可用几次?', 'vw-percust', (_vw.perCust != null ? _vw.perCust : 1), '1')
      + f('How many coupons in total? · 总共多少张?', 'vw-maxuses', (_vw.maxUses || ''), 'empty = no limit · 留空 = 不限')
    + '</div>';
}
// Live-reflect the rules fields (min spend, end date, limits) into the preview
// ticket as the operator types — same as the deal value.
function vwLiveRules() {
  _vw.min = Number($('#vw-min').value) || 0;
  _vw.expires = $('#vw-expires').value || '';
  // Clamp to a minimum of 1: an explicit 0 here used to be stored and read by
  // the backend as "no per-person cap" (unlimited) — the exact opposite of what
  // an operator answering "how many times can one person use it?" with 0 means.
  _vw.perCust = $('#vw-percust').value !== '' ? Math.max(1, parseInt($('#vw-percust').value, 10) || 1) : 1;
  _vw.maxUses = $('#vw-maxuses').value || '';
  const t = document.getElementById('vw-ticket');
  if (t) t.outerHTML = vwTicketHtml();
}
function vwNextRules() {
  _vw.min = Number($('#vw-min').value) || 0;
  _vw.expires = $('#vw-expires').value || '';
  // Clamp to a minimum of 1: an explicit 0 here used to be stored and read by
  // the backend as "no per-person cap" (unlimited) — the exact opposite of what
  // an operator answering "how many times can one person use it?" with 0 means.
  _vw.perCust = $('#vw-percust').value !== '' ? Math.max(1, parseInt($('#vw-percust').value, 10) || 1) : 1;
  _vw.maxUses = $('#vw-maxuses').value || '';
  if (_vw.expires) {
    const d = new Date(_vw.expires + 'T23:59:59');
    if (d < new Date()) { toast('That end date has passed — pick a later one · 到期日已过,请选更晚的日期', 'err'); return; }
  }
  if (!_vw.codeEdited || !_vw.code) _vw.code = vwGenCode();
  if (!_vw.labelEdited) { _vw.title_en = vwGenLabelEn(); _vw.title_cn = vwGenLabelCn(); }
  vwGoto('review');
}

function vwDiscAt(v, sub) {
  if (v.type === 'fixed_amount') return Math.min(Number(v.value) || 0, sub);
  if (v.type === 'percent') return sub * (Math.max(0, Math.min(100, Number(v.value) || 0))) / 100;
  return 0; // free shipping value depends on the live fee — not comparable here
}
// Read the live coupons and explain, in plain words, how this one will behave
// next to them. Grounded in the real resolution rules (best-one-wins, no
// stacking, signup grants, code revive).
function vwHeadsUp() {
  const notes = [];
  const code = (_vw.code || '').toUpperCase();
  const flags = vwFlags();
  const active = _vwVouchers.filter(v => v.is_active);
  const clash = _vwVouchers.find(v => String(v.code).toUpperCase() === code);
  if (clash) {
    const expired = clash.expires_at && new Date(clash.expires_at) < new Date();
    if (clash.is_active && !expired) {
      notes.push({ tone: 'red', icon: vwIcon('alert', 18), html: 'A live coupon already uses <b>' + escapeHtml(code) + '</b>. Pick another code, or turn the old one off first. · 已有生效中的优惠券使用 <b>' + escapeHtml(code) + '</b>,请换一个编码或先停用旧的。' });
    } else {
      notes.push({ tone: 'brass', icon: vwIcon('refresh', 18), html: 'You used <b>' + escapeHtml(code) + '</b> before and it is off now. Saving reuses it and starts its count from zero. · 你以前用过 <b>' + escapeHtml(code) + '</b>(现已停用),保存会复用它并把使用次数清零。' });
    }
  }
  if (flags.auto_apply) {
    const others = active.filter(v => v.auto_apply && !v.auto_grant_signup && String(v.code).toUpperCase() !== code);
    if (others.length) {
      const list = others.map(v => '<b>' + escapeHtml(v.code) + '</b>').join(', ');
      notes.push({ tone: '', icon: vwIcon('scale', 18), html: 'You already have automatic deal(s): ' + list + '. Customers get the single best one — these do not add together. · 你已有自动优惠:' + list + '。顾客只享最优的一张,不叠加。' });
      if (_vw.type !== 'free_shipping') {
        const ref = 200, mine = vwDiscAt(_vw, ref);
        const bigger = others.filter(v => v.type !== 'free_shipping' && vwDiscAt(v, ref) >= mine);
        if (bigger.length) {
          notes.push({ tone: 'brass', icon: vwIcon('trophy', 18), html: 'On a typical ¥200 order, <b>' + escapeHtml(bigger[0].code) + '</b> gives more — your new deal may rarely be used. · 以 ¥200 订单为例,<b>' + escapeHtml(bigger[0].code) + '</b> 更划算,你的新优惠可能很少被用到。' });
        } else {
          notes.push({ tone: 'brass', icon: vwIcon('trophy', 18), html: 'On a typical ¥200 order, your new deal gives the most — it will usually win. · 以 ¥200 订单为例,你的新优惠最划算,通常会胜出。' });
        }
      }
    }
  }
  if (flags.auto_grant_signup) {
    const others = active.filter(v => v.auto_grant_signup && String(v.code).toUpperCase() !== code);
    if (others.length) {
      const list = others.map(v => '<b>' + escapeHtml(v.code) + '</b>').join(', ');
      notes.push({ tone: '', icon: vwIcon('gift', 18), html: 'New customers will also get ' + list + '. They can use one per order. · 新顾客还会获得 ' + list + ',每单只能用一张。' });
    }
  }
  if (_vw.path === 'pick') {
    notes.push({ tone: '', icon: vwIcon('users', 18), html: 'After saving, pick the customers to give it to — it lands in their coupons, no code needed. · 保存后挑选顾客,优惠券直接进入他们的账户,无需编码。' });
  } else if (flags.is_public) {
    notes.push({ tone: '', icon: vwIcon('eye', 18), html: 'Anyone can find this in the app, and a shared code also works. · 任何人都能在小程序看到,分享的编码也能用。' });
  }
  return notes;
}

// The heads-up notes depend on _vw.code, which is editable on the Review step —
// so render them through this helper and re-run it when the code changes (see
// vwEditCode), otherwise the "live" clash detection would stay frozen on the
// code that was generated when Review first rendered.
function vwHeadsUpHtml() {
  const notes = vwHeadsUp();
  return notes.length
    ? '<div style="display:flex;flex-direction:column;gap:9px;">' + notes.map(n =>
        '<div class="vw-note ' + (n.tone || '') + '"><span class="ni">' + (n.icon || '•') + '</span><span>' + n.html + '</span></div>').join('') + '</div>'
    : '<div class="muted" style="font-size:12px;">No clashes with your live coupons. · 与现有优惠券无冲突。</div>';
}
function vwReviewHtml() {
  const flags = vwFlags();
  const notesHtml = '<div id="vw-headsup">' + vwHeadsUpHtml() + '</div>';
  const labelFields = flags.is_public
    ? '<div class="field" style="margin:0;flex:1;min-width:200px;"><label class="vw-lab">What customers see (English) · 顾客看到的文字(英文)</label><input type="text" id="vw-title-en" value="' + escapeAttr(_vw.title_en || '') + '" oninput="vwEditLabel()" style="width:100%;"></div>'
      + '<div class="field" style="margin:0;flex:1;min-width:200px;"><label class="vw-lab">What customers see (Chinese) · 顾客看到的文字(中文)</label><input type="text" id="vw-title-cn" value="' + escapeAttr(_vw.title_cn || '') + '" oninput="vwEditLabel()" style="width:100%;"></div>'
    : '';
  return vwTicketHtml()
    + '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
      + '<div class="field" style="margin:0;flex:1;min-width:200px;"><label class="vw-lab">Coupon code · 优惠码</label><input type="text" id="vw-code" value="' + escapeAttr(_vw.code) + '" oninput="vwEditCode(this.value)" style="width:100%;font-family:var(--f-mono);text-transform:uppercase;"></div>'
      + labelFields
    + '</div>'
    + '<div class="vw-lab" style="margin-bottom:0;">Heads up · 提示</div>'
    + notesHtml;
}
function vwEditCode(v) {
  _vw.code = v.toUpperCase(); _vw.codeEdited = true;
  // Re-run the live clash/auto-apply detection against the newly typed code.
  const h = document.getElementById('vw-headsup');
  if (h) h.innerHTML = vwHeadsUpHtml();
}
function vwEditLabel() {
  const en = $('#vw-title-en'), cn = $('#vw-title-cn');
  if (en) _vw.title_en = en.value;
  if (cn) _vw.title_cn = cn.value;
  _vw.labelEdited = true;
}

async function vwSave(activate) {
  const flags = vwFlags();
  const code = (_vw.code || '').trim().toUpperCase();
  if (!code) { toast('Code required · 请填写编码', 'err'); return; }
  if (flags.is_public && !((_vw.title_en || '').trim() || (_vw.title_cn || '').trim())) {
    toast('Add a label customers see (EN or 中) · 请填写顾客看到的标签', 'err'); return;
  }
  const clash = _vwVouchers.find(v => String(v.code).toUpperCase() === code);
  if (clash && clash.is_active && !(clash.expires_at && new Date(clash.expires_at) < new Date())) {
    toast('A live coupon already uses ' + code + ' — change the code · 已有生效中的优惠券使用此编码', 'err'); return;
  }
  const wasPick = _vw.path === 'pick';
  const body = {
    code, type: _vw.type,
    value: _vw.type === 'free_shipping' ? 0 : (Number(_vw.value) || 0),
    min_subtotal: Number(_vw.min) || 0,
    max_uses: (_vw.maxUses !== '' && _vw.maxUses != null) ? Number(_vw.maxUses) : null,
    per_customer_limit: _vw.perCust != null ? Number(_vw.perCust) : 1,
    expires_at: _vw.expires || null,
    is_public: flags.is_public, auto_grant_signup: flags.auto_grant_signup, auto_apply: flags.auto_apply,
    title_en: (_vw.title_en || '').trim() || null, title_cn: (_vw.title_cn || '').trim() || null,
    is_active: !!activate,   // draft-first: stays off unless they chose "turn on"
  };
  try {
    const r = await api('/api/retail-admin/vouchers', { method: 'POST', body });
    const vid = r.data && r.data.id;
    toast(r.reused ? ('Reused code · 已复用 ' + code)
      : activate ? ('Created & live · 已创建并开启 ' + code)
      : ('Saved as draft · 已存为草稿 ' + code));
    vwClose();
    await loadVouchers();
    if (wasPick && vid) openGrantModal(vid, code);   // hand off to the existing grant flow
  } catch (e) {
    const msg = e.message === 'code_active' ? 'A live coupon already uses this code · 已有生效中的优惠券使用此编码'
      : e.message === 'code_exists' ? 'Code already exists · 编码已存在' : e.message;
    toast('Failed · 失败: ' + msg, 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// SNIPPETS — mini-app copy editor
// ════════════════════════════════════════════════════════════════
// Office staff edit short text labels shown on the fixed mini-app screens
// (cart, checkout, profile, order tracking). Each snippet is stored in
// storefront_config under a `copy.<group>.<key>` row as { en, cn }.
// Mini app reads them via /api/retail/config — picks language from the
// customer's WeChat preference.
const SNIPPETS = [
  {
    group: 'Cart · 购物车', items: [
      { key: 'copy.cart.kicker',       label: 'Kicker · 小标签', help: 'Small caps label above the cart title. · 购物车标题上方的小写标签。', en: 'YOUR BASKET', cn: '购物车' },
      { key: 'copy.cart.title',        label: 'Headline · 大标题', help: 'Big serif title on the cart screen. · 购物车页面的大号衬线标题。', en: 'Almost yours.', cn: '即将拥有。' },
      { key: 'copy.cart.empty',        label: 'Empty cart message · 空购物车提示', help: 'Shown when the customer has no items in their cart. · 当顾客购物车内没有商品时显示。', en: 'Your basket is empty — shop the garden →', cn: '购物车空空如也 — 去逛逛 →' },
      { key: 'copy.cart.checkout_btn', label: 'Checkout button · 结账按钮', help: 'Full-width button at the bottom of the cart. · 购物车底部的通栏按钮。', en: 'CHECK OUT', cn: '结账' },
    ],
  },
  {
    group: 'Checkout · 结账', items: [
      { key: 'copy.checkout.kicker',          label: 'Kicker · 小标签', help: 'Small caps label above the checkout title. · 结账标题上方的小写标签。', en: 'CHECKOUT · 结账', cn: '结账' },
      { key: 'copy.checkout.title',           label: 'Headline · 大标题', help: 'Big serif title on the checkout screen. · 结账页面的大号衬线标题。', en: 'Where & how.', cn: '送到何处？' },
      { key: 'copy.checkout.place_order_btn', label: 'Place order button · 提交订单按钮', help: 'Final order-placement button. · 最终下单按钮。', en: 'PLACE ORDER →', cn: '提交订单 →' },
    ],
  },
  {
    group: 'Product detail · 产品详情', items: [
      { key: 'copy.product.add_btn',  label: 'Add to basket button · 加入购物车按钮', help: 'Sticky bottom button on the product page. · 商品页面底部的吸附按钮。', en: 'ADD TO BASKET', cn: '加入购物车' },
      { key: 'copy.product.sold_out', label: 'Sold-out badge · 售罄标签', help: 'Shown over the photo when stock is exhausted. · 库存售罄时显示在图片上方。', en: 'SOLD OUT', cn: '已售罄' },
    ],
  },
  {
    group: 'Profile · 我的', items: [
      { key: 'copy.profile.greeting', label: 'Greeting template · 问候语模板', help: 'Big serif greeting at top of profile. Use {name} for the customer\'s nickname. · 个人页顶部的大号衬线问候语。用 {name} 代表顾客昵称。', en: 'Hey, {name}.', cn: '你好，{name}。' },
      { key: 'copy.profile.kicker',   label: 'Kicker template · 小标签模板', help: 'Small caps line above the greeting. Use {since} for join year, {level} for tier number. · 问候语上方的小写行。用 {since} 代表加入年份,{level} 代表等级编号。', en: 'MEMBER SINCE {since} · LVL {level}', cn: '加入年份 {since} · 等级 {level}' },
    ],
  },
  {
    group: 'Order tracking · 订单跟踪', items: [
      { key: 'copy.order.in_transit_title', label: 'In-transit headline · 配送中标题', help: 'Big title when order is dispatched. · 订单已发货时的大标题。', en: 'On its way.', cn: '配送中。' },
      { key: 'copy.order.delivered_title',  label: 'Delivered headline · 已送达标题', help: 'Big title when order is delivered. · 订单已送达时的大标题。', en: 'Delivered.', cn: '已送达。' },
      { key: 'copy.order.help_link',        label: 'Help link · 帮助链接', help: 'Small "Need help" link in the tracking footer. · 物流跟踪页脚的小号「需要帮助」链接。', en: 'NEED HELP', cn: '需要帮助' },
    ],
  },
  {
    group: 'Onboarding · 欢迎', items: [
      { key: 'copy.onboarding.skip_btn', label: 'Skip button · 跳过按钮', help: 'Onboarding skip button. · 引导页的跳过按钮。', en: 'SKIP', cn: '跳过' },
      { key: 'copy.onboarding.next_btn', label: 'Next button · 下一步按钮', help: 'Onboarding next/continue button. · 引导页的下一步/继续按钮。', en: 'NEXT →', cn: '下一步 →' },
      { key: 'copy.onboarding.done_btn', label: 'Done button (last slide) · 完成按钮(最后一页)', help: 'Final onboarding button to enter the app. · 进入应用的最后一个引导按钮。', en: 'GET STARTED', cn: '开始使用' },
    ],
  },
];

function snippetsRender() {
  const mount = $('#snippets-mount');
  mount.innerHTML = SNIPPETS.map(g => `
    <div class="snip-group">
      <h3>${escapeHtml(g.group)}</h3>
      ${g.items.map(s => `
        <div class="snip-row">
          <div class="label">${escapeHtml(s.label)}</div>
          <div class="help">${escapeHtml(s.help)}</div>
          <div class="key">${escapeHtml(s.key)}</div>
          <div class="pair" style="margin-top: 8px">
            <div class="lang-wrap"><span class="lang-tag">EN</span><input type="text" data-key="${escapeAttr(s.key)}" data-lang="en" value="${escapeAttr(s._en ?? s.en)}"></div>
            <div class="lang-wrap"><span class="lang-tag">中</span><input type="text" data-key="${escapeAttr(s.key)}" data-lang="cn" value="${escapeAttr(s._cn ?? s.cn)}"></div>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

async function loadSnippets() {
  $('#snip-status').textContent = '';
  try {
    const { data: cfg } = await api('/api/retail-admin/config');
    // Merge DB values into the SNIPPETS catalog (use defaults if missing)
    for (const g of SNIPPETS) {
      for (const s of g.items) {
        const v = getDottedPath(cfg, s.key);
        s._en = (v && typeof v === 'object' && 'en' in v) ? v.en : s.en;
        s._cn = (v && typeof v === 'object' && 'cn' in v) ? v.cn : s.cn;
      }
    }
    snippetsRender();
  } catch (e) {
    toast('Snippets load failed · 加载文案失败: ' + e.message, 'err');
  }
}

function getDottedPath(obj, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

async function saveSnippets() {
  const inputs = document.querySelectorAll('#snippets-mount input[data-key]');
  const byKey = {};
  inputs.forEach(inp => {
    const k = inp.dataset.key, lang = inp.dataset.lang;
    if (!byKey[k]) byKey[k] = {};
    byKey[k][lang] = inp.value;
  });
  $('#snip-status').textContent = 'Saving…';
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: byKey });
    $('#snip-status').innerHTML = '<span class="ok">Saved ✓</span>';
    toast('Mini-app copy saved · 小程序文案已保存');
    // Refresh in-memory defaults so a subsequent "Reset to saved" works
    for (const g of SNIPPETS) {
      for (const s of g.items) {
        if (byKey[s.key]) { s._en = byKey[s.key].en; s._cn = byKey[s.key].cn; }
      }
    }
  } catch (e) {
    $('#snip-status').innerHTML = '<span class="err">Failed · 失败: ' + escapeHtml(e.message) + '</span>';
  }
}

// ════════════════════════════════════════════════════════════════
// STOREFRONT SETTINGS
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// CUSTOMER SERVICE — mode-aware field visibility + QR upload
// ════════════════════════════════════════════════════════════════
function applyCsModeUI() {
  const m = $('#cfg-cs-mode')?.value || 'off';
  const wecom = document.getElementById('cs-wecom-fields');
  const qr    = document.getElementById('cs-qr-fields');
  if (wecom) wecom.style.display = (m === 'wecom') ? '' : 'none';
  if (qr)    qr.style.display    = (m === 'qr')    ? '' : 'none';
}
document.addEventListener('change', e => {
  if (e.target.id === 'cfg-cs-mode') applyCsModeUI();
  if (e.target.id === 'cfg-cs-fab_icon') applyCsFabIconUI();
});
// Show the custom-emoji input only when icon = custom
function applyCsFabIconUI() {
  const v = $('#cfg-cs-fab_icon')?.value || 'dots';
  const wrap = document.getElementById('cs-fab-emoji-wrap');
  if (wrap) wrap.style.display = (v === 'custom') ? '' : 'none';
}
// Colour preset swatches set the colour input
document.addEventListener('click', e => {
  const sw = e.target.closest('.cs-swatch');
  if (sw && sw.dataset.color) {
    const inp = $('#cfg-cs-fab_color');
    if (inp) inp.value = sw.dataset.color;
  }
});
function renderCsQrPreview() {
  const url = $('#cfg-cs-qr_image_url')?.value || '';
  const mount = $('#cfg-cs-qr-preview');
  if (!mount) return;
  if (!url) { mount.innerHTML = '<div class="muted" style="font-size: 12px;">No QR uploaded yet. · 尚未上传二维码。</div>'; return; }
  mount.innerHTML = `<img src="${escapeAttr(url)}" alt="QR" style="max-width: 160px; max-height: 160px; border-radius: 8px; border: 1px solid var(--line);">
    <div style="margin-top: 6px;"><button class="btn btn-sm" onclick="clearCsQr()">Remove · 移除</button></div>`;
}
async function uploadCsQr(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Uploading QR… · 上传二维码中…');
  try {
    const r = await fetch('/api/retail-admin/cms/media', { method: 'POST', credentials: 'same-origin', body: fd });
    if (r.status === 401) { location.href = '/backend/login'; return; }
    const j = await r.json();
    if (!j.success) { toast('Upload failed · 上传失败: ' + (j.error || ''), 'err'); return; }
    $('#cfg-cs-qr_image_url').value = j.data.url;
    renderCsQrPreview();
    toast('QR uploaded — remember to Save · 二维码已上传 — 记得点保存');
  } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
}
function clearCsQr() { $('#cfg-cs-qr_image_url').value = ''; renderCsQrPreview(); }
document.addEventListener('change', e => {
  if (e.target.id === 'cfg-cs-qr-file' && e.target.files?.[0]) uploadCsQr(e.target.files[0]);
});

// ── Per-tenant features ──
// effective = entitled (platform ceiling) AND operator-enabled (preference).
// Preference lives in storefront_config under features.<key>; unset falls back
// to the catalog default so nothing vanishes on a fresh tenant.
function featureEnabled(cfg, f) {
  const entitled = ENTITLEMENTS[f.key] !== false;
  const pref = cfg?.features?.[f.key];
  const on = pref === undefined ? f.def : !!pref;
  return entitled && on;
}
// Add/remove the feat-<key> body class so the CSS gates show/hide every tagged
// nav button, content tab and settings sub-panel at once.
function applyFeatureGates(cfg) {
  for (const f of FEATURE_CATALOG) {
    document.body.classList.toggle('feat-' + f.key, featureEnabled(cfg, f));
  }
}
// ── Phase 1: each feature owns its on/off switch on its own page (Option B). ──
// Where each toggleable feature's switch + "off" card mount.
const FEATURE_HOMES = {
  membership:  '#tab-membership',
  affiliate:   '#tab-affiliate',
  reviews:     '#tab-reviews',
  feedback:    '#tab-feedback',
  socialProof: '#tab-social',
  faq:         '#tab-faq',
};
let _cfgCache = {};
// Inject an on/off bar + an "off / enable" card at the top of each feature's home
// section. Built from FEATURE_CATALOG so the bilingual copy lives in one place.
// Idempotent (guarded) so a re-run never duplicates.
function mountFeatureControls() {
  for (const f of FEATURE_CATALOG) {
    if (ENTITLEMENTS[f.key] === false) continue;   // not entitled → no controls
    const host = document.querySelector(FEATURE_HOMES[f.key]);
    if (!host || host.querySelector(':scope > .feat-bar')) continue;
    const bar = document.createElement('div');
    bar.className = 'feat-bar';
    bar.innerHTML =
      '<div><div class="feat-bar-t">' + f.en + ' · ' + f.cn + '</div>' +
      '<div class="feat-bar-d">' + f.desc + '</div></div>' +
      '<label class="fc-switch"><input type="checkbox" data-feat-toggle="' + f.key + '">' +
      '<span class="fc-switch-track"></span>' +
      '<span class="feat-bar-state" data-feat-state="' + f.key + '"></span></label>';
    const off = document.createElement('div');
    off.className = 'feat-off';
    off.innerHTML =
      '<h3>' + f.en + ' is off · ' + f.cn + '已关闭</h3>' +
      '<p>Customers don\'t see this while it\'s off. Turn it on to set it up. · 关闭期间顾客看不到此功能,开启后即可配置。</p>' +
      '<button class="btn btn-primary" data-feat-enable="' + f.key + '">Turn on · 开启</button>';
    host.insertBefore(off, host.firstChild);
    host.insertBefore(bar, host.firstChild);
    bar.querySelector('input').addEventListener('change', e => setFeatureEnabled(f.key, e.target.checked));
    off.querySelector('button').addEventListener('click', () => setFeatureEnabled(f.key, true));
  }
  syncFeatureToggles();
}
// Reflect the live on/off state (body.feat-<key>) onto every feature switch + label.
function syncFeatureToggles() {
  for (const f of FEATURE_CATALOG) {
    const on = document.body.classList.contains('feat-' + f.key);
    document.querySelectorAll('[data-feat-toggle="' + f.key + '"]').forEach(i => { i.checked = on; });
    document.querySelectorAll('[data-feat-state="' + f.key + '"]').forEach(s => {
      s.textContent = on ? 'On · 开' : 'Off · 关';
    });
  }
}
// Persist a feature's on/off (features.<key>), re-apply the gates live, keep every
// switch in sync. Customer-facing visibility is server-driven by the same flag, so
// this only changes what the operator sees here.
async function setFeatureEnabled(key, on) {
  try {
    const { data: c } = await api('/api/retail-admin/config', { method: 'PUT', body: { ['features.' + key]: !!on } });
    _cfgCache = c;
    applyFeatureGates(c);
    syncFeatureToggles();
    toast(on ? 'Turned on · 已开启' : 'Turned off · 已关闭');
  } catch (e) {
    applyFeatureGates(_cfgCache);   // revert the optimistic switch flip
    syncFeatureToggles();
    toast('Save failed · 保存失败: ' + (e.message || ''), 'err');
  }
}

async function loadConfig() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    applyFeatureGates(c);
    _cfgCache = c;
    syncFeatureToggles();
    // Store-wide low-stock threshold (drives the amber dot + Low-stock tile).
    { const lt = parseInt(c.inventory?.lowStockThreshold, 10); const nv = Number.isFinite(lt) && lt >= 0 ? lt : 5;
      const changed = nv !== PA_LOW_STOCK; PA_LOW_STOCK = nv; paSyncLowStockUi();
      // If the catalogue already painted with the default, re-flag it now.
      if (changed && Array.isArray(PA_PRODUCTS) && PA_PRODUCTS.length) { try { paRenderKpis(false); paRender(); } catch {} } }
    // Brand & theme (accent / notification colour / language / mascots) moved to
    // the Mini App Editor (/cms) 2026-06-09 — saved there directly to config.
    $('#cfg-fees-freeShippingThreshold').value = c.fees?.freeShippingThreshold ?? 399;
    $('#cfg-fees-standardShipping').value      = c.fees?.standardShipping ?? 12;
    $('#cfg-fees-sameDayDelivery').value       = c.fees?.sameDayDelivery ?? 18;
    $('#cfg-fees-minOrder').value              = c.fees?.minOrder ?? 0;
    $('#cfg-fees-pickupPackingFee').value      = c.fees?.pickupPackingFee ?? 0;
    $('#cfg-pickup-open').value                = c.pickup?.window?.open  || '10:00';
    $('#cfg-pickup-close').value               = c.pickup?.window?.close || '20:00';
    // Shop layout & filters
    const shopLayout = c.shop?.layout === 'grid' ? 'grid-2col' : (c.shop?.layout || 'list');
    $('#cfg-shop-layout').value             = shopLayout;
    $('#cfg-shop-defaultSort').value        = c.shop?.defaultSort || '';
    $('#cfg-shop-showSort').checked         = !!c.shop?.showSort;
    $('#cfg-shop-showDietary').checked      = c.shop?.showDietary !== false; // default ON
    $('#cfg-shop-showStockFilter').checked  = !!c.shop?.showStockFilter;
    $('#cfg-shop-showBadgeFilter').checked  = !!c.shop?.showBadgeFilter;
    $('#cfg-shop-showPriceFilter').checked  = !!c.shop?.showPriceFilter;
    $('#cfg-shop-hideOutOfStock').checked   = !!c.shop?.hideOutOfStock;
    $('#cfg-shop-lockLayout').checked       = !!c.shop?.lockLayout;
    $('#cfg-notifications-order_status_template_id').value = c.notifications?.order_status_template_id || '';
    $('#cfg-notifications-wecom_order_webhook').value = c.notifications?.wecom_order_webhook || '';
    loadWecomApp();
    loadAliyunSms();
    // Customer service
    const cs = c.customer_service || {};
    $('#cfg-cs-mode').value      = cs.mode || 'off';
    $('#cfg-cs-corp_id').value   = cs.corp_id || '';
    $('#cfg-cs-url').value       = cs.url || '';
    $('#cfg-cs-qr_image_url').value = cs.qr_image_url || '';
    $('#cfg-cs-label_en').value  = cs.label_en || '';
    $('#cfg-cs-label_cn').value  = cs.label_cn || '';
    $('#cfg-cs-hours_en').value  = cs.hours_en || '';
    $('#cfg-cs-hours_cn').value  = cs.hours_cn || '';
    $('#cfg-cs-phone').value     = cs.phone || '';
    $('#cfg-cs-show_me').checked       = cs.show_me !== false;       // default ON
    $('#cfg-cs-show_home').checked     = !!cs.show_home;
    $('#cfg-cs-show_product').checked  = cs.show_product !== false;  // default ON
    $('#cfg-cs-show_checkout').checked = cs.show_checkout !== false; // default ON
    $('#cfg-cs-show_order').checked    = cs.show_order !== false;    // default ON
    // Floating-bubble appearance
    $('#cfg-cs-fab_size').value       = cs.fab_size  || 'md';
    $('#cfg-cs-fab_shape').value      = cs.fab_shape || 'circle';
    $('#cfg-cs-fab_color').value      = cs.fab_color || '#365329';
    $('#cfg-cs-fab_icon').value       = cs.fab_icon  || 'dots';
    $('#cfg-cs-fab_icon_emoji').value = cs.fab_icon_emoji || '';
    $('#cfg-cs-fab_side').value       = cs.fab_side  || 'right';
    $('#cfg-cs-fab_bottom').value     = (cs.fab_bottom != null ? cs.fab_bottom : 220);
    renderCsQrPreview();
    applyCsModeUI();
    applyCsFabIconUI();
    $('#cfg-legal-privacy-en').value = c.legal?.privacy?.body_en || '';
    $('#cfg-legal-privacy-cn').value = c.legal?.privacy?.body_cn || '';
    $('#cfg-legal-terms-en').value   = c.legal?.terms?.body_en   || '';
    $('#cfg-legal-terms-cn').value   = c.legal?.terms?.body_cn   || '';
    // Mini-app footer + Me-page menu moved to the Mini App Editor (/cms) 2026-06-09.
    // Social-proof widgets — five sub-objects under social_proof. Defaults
    // mirror the server-side fallbacks in routes/retail.js getSocialConfig().
    const sp = c.social_proof || {};
    const sp_bc = sp.bought_count  || {};
    const sp_rb = sp.recent_buyers || {};
    const sp_vn = sp.viewing_now   || {};
    const sp_lo = sp.last_ordered  || {};
    const sp_sb = sp.sold_badge    || {};
    // Boost ranges — back-compat: old configs stored a single `boost` /
    // `fallback_minutes`; if the new min/max isn't present, hydrate both
    // sides of the range from that legacy value so the form round-trips
    // cleanly without surprising the operator.
    const bcBoostLegacy = Number(sp_bc.boost) || 0;
    const vnBoostLegacy = Number(sp_vn.boost) || 0;
    const sbBoostLegacy = Number(sp_sb.boost) || 0;
    const loFallbackLegacy = Number(sp_lo.fallback_minutes) || 0;
    $('#cfg-social-bc-enabled').checked   = sp_bc.enabled !== false;
    $('#cfg-social-bc-min_today').value   = sp_bc.min_today ?? 2;
    $('#cfg-social-bc-min_week').value    = sp_bc.min_week  ?? 2;
    $('#cfg-social-bc-min_month').value   = sp_bc.min_month ?? 1;
    $('#cfg-social-bc-min_all').value     = sp_bc.min_all   ?? 2;
    $('#cfg-social-bc-boost_min').value   = sp_bc.boost_min ?? bcBoostLegacy;
    $('#cfg-social-bc-boost_max').value   = sp_bc.boost_max ?? bcBoostLegacy;
    $('#cfg-social-rb-enabled').checked    = sp_rb.enabled !== false;
    $('#cfg-social-rb-window_days').value  = sp_rb.window_days ?? 7;
    $('#cfg-social-rb-visible_secs').value = sp_rb.visible_secs ?? 4.5;
    $('#cfg-social-rb-gap_secs').value     = sp_rb.gap_secs ?? 5;
    _manualBuyers = Array.isArray(sp_rb.manual) ? sp_rb.manual.map(m => ({
      name:         String(m && m.name || ''),
      product_en:   String(m && m.product_en || ''),
      product_cn:   String(m && m.product_cn || ''),
      minutes_ago:  Number(m && m.minutes_ago) || 0,
    })) : [];
    renderManualBuyers();
    $('#cfg-social-vn-enabled').checked   = sp_vn.enabled !== false;
    $('#cfg-social-vn-show_in_app').checked = sp_vn.show_in_app !== false;
    $('#cfg-social-vn-ttl_sec').value     = sp_vn.ttl_sec ?? 45;
    $('#cfg-social-vn-boost_min').value   = sp_vn.boost_min ?? vnBoostLegacy;
    $('#cfg-social-vn-boost_max').value   = sp_vn.boost_max ?? vnBoostLegacy;
    $('#cfg-social-lo-enabled').checked   = sp_lo.enabled !== false;
    $('#cfg-social-lo-max_hours').value   = sp_lo.max_hours ?? 24;
    $('#cfg-social-lo-fallback_min_minutes').value = sp_lo.fallback_min_minutes ?? loFallbackLegacy;
    $('#cfg-social-lo-fallback_max_minutes').value = sp_lo.fallback_max_minutes ?? loFallbackLegacy;
    $('#cfg-social-sb-enabled').checked   = sp_sb.enabled !== false;
    $('#cfg-social-sb-min_units').value   = sp_sb.min_units ?? 3;
    $('#cfg-social-sb-boost_min').value   = sp_sb.boost_min ?? sbBoostLegacy;
    $('#cfg-social-sb-boost_max').value   = sp_sb.boost_max ?? sbBoostLegacy;
    applyVisualPreviews();
    syncAllPickers();
    applyShopFiltersPreview();
    applySortPreview();
    applyFeePreviews();
  } catch (e) {
    toast('Config load failed · 加载配置失败: ' + e.message, 'err');
  }
}

// Load the WeCom self-built-app credentials (corp_id/agent_id shown, secret
// masked) + the LIVE/NOT-CONFIGURED chip. Reads the shared integrations
// endpoint so the secret stays encrypted server-side.
async function loadWecomApp() {
  try {
    const { data } = await api('/api/retail-admin/integrations');
    const w = data?.wecom_app || {};
    const corp = $('#wecom-app-corp_id'), agent = $('#wecom-app-agent_id'), sec = $('#wecom-app-secret');
    if (corp)  corp.value = w.corp_id || '';
    if (agent) agent.value = w.agent_id || '';
    if (sec)   sec.placeholder = w.secret_masked
      ? (w.secret_masked + ' · leave blank to keep · 留空保持不变')
      : 'paste app Secret · 粘贴应用 Secret';
    const chip = $('#wecom-app-chip');
    if (chip) chip.innerHTML = w.enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ NOT CONFIGURED · 未配置</span>';
  } catch (e) { console.warn('[wecom app] load failed', e.message); }
}

// Save the three app fields. Secret is sent only when the operator typed a new
// one (blank = keep current). Empty corp_id/agent_id clear (turn off).
async function saveWecomApp() {
  const status = $('#wecom-test-status');
  status.textContent = 'Saving… · 保存中…';
  const corp  = $('#wecom-app-corp_id').value.trim();
  const agent = $('#wecom-app-agent_id').value.trim();
  const secret = $('#wecom-app-secret').value;   // not trimmed — secrets can be exact
  try {
    await api('/api/retail-admin/integrations', { method: 'PUT', body: {
      wecom_app: { corp_id: corp || null, agent_id: agent || null, secret: secret ? secret : undefined },
    } });
    $('#wecom-app-secret').value = '';   // never keep the plaintext in the field
    status.textContent = '✅ Saved · 已保存';
    loadWecomApp();
  } catch (e) {
    status.textContent = '⚠ ' + (e.message || 'save failed');
  }
}

// Send a test alert. Server prefers the saved app; if no app is configured it
// falls back to the webhook URL currently in the box (so it can be tested
// before the main Save).
async function testWecomWebhook() {
  const status = $('#wecom-test-status');
  const url = $('#cfg-notifications-wecom_order_webhook').value.trim();
  status.textContent = 'Sending… · 发送中…';
  try {
    await api('/api/retail-admin/wecom/test', { method: 'POST', body: { webhook: url } });
    status.textContent = '✅ Sent — check your WeCom · 已发送,请查看企业微信';
  } catch (e) {
    status.textContent = '⚠ ' + (e.message === 'no_valid_webhook'
      ? 'Set up the app above, or paste a qyapi.weixin.qq.com URL · 请先配置上方 App 或填入正确地址'
      : (e.message || 'failed'));
  }
}

// ── Aliyun SMS (delivered notice for out-of-Guangzhou orders) ──────────────
async function loadAliyunSms() {
  try {
    const { data } = await api('/api/retail-admin/integrations');
    const a = data?.aliyun_sms || {};
    const id   = $('#aliyun_sms-ak_id');
    const sec  = $('#aliyun_sms-ak_secret');
    const sign = $('#aliyun_sms-sign_name');
    const tpl  = $('#aliyun_sms-template_delivered');
    const tplOtp = $('#aliyun_sms-template_otp');
    if (id)   id.value = a.ak_id || '';
    if (sign) sign.value = a.sign_name || '';
    if (tpl)  tpl.value = a.template_delivered || '';
    if (tplOtp) tplOtp.value = a.template_otp || '';
    if (sec)  sec.placeholder = a.ak_secret_masked
      ? (a.ak_secret_masked + ' · leave blank to keep · 留空保持不变')
      : 'paste AccessKey Secret · 粘贴 AccessKey Secret';
    const chip = $('#aliyun_sms-chip');
    if (chip) chip.innerHTML = a.enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✓ LIVE · 已启用</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700">✗ NOT CONFIGURED · 未配置</span>';
  } catch (e) { console.warn('[aliyun sms] load failed', e.message); }
}

// Save the four fields. Secret is sent only when newly typed (blank = keep).
// Empty id/sign/template clear (turn off). Server treats '' as clear, undefined
// as keep.
async function saveAliyunSms_() {
  const id   = $('#aliyun_sms-ak_id').value.trim();
  const sec  = $('#aliyun_sms-ak_secret').value;   // exact — secrets not trimmed
  const sign = $('#aliyun_sms-sign_name').value.trim();
  const tpl  = $('#aliyun_sms-template_delivered').value.trim();
  const tplOtp = ($('#aliyun_sms-template_otp')||{}).value;
  await api('/api/retail-admin/integrations', { method: 'PUT', body: {
    aliyun_sms: {
      ak_id:              id || null,
      ak_secret:          sec ? sec : undefined,
      sign_name:          sign || null,
      template_delivered: tpl || null,
      template_otp:       (tplOtp != null ? tplOtp.trim() : '') || null,
    },
  } });
  $('#aliyun_sms-ak_secret').value = '';   // never keep plaintext in the field
}

async function _saveAliyunSms() {
  const status = $('#aliyun_sms-test-status');
  status.textContent = 'Saving… · 保存中…';
  try { await saveAliyunSms_(); status.textContent = '✅ Saved · 已保存'; loadAliyunSms(); }
  catch (e) { status.textContent = '⚠ ' + (e.message || 'save failed'); }
}

// Save first, then send a REAL delivered SMS to the typed number so the operator
// confirms sign + template + key are all approved and wired end-to-end.
async function _testAliyunSms() {
  const status = $('#aliyun_sms-test-status');
  const phone = $('#aliyun_sms-testphone').value.trim();
  if (!/^1\d{10}$/.test(phone.replace(/\D/g, '').replace(/^86/, ''))) {
    status.textContent = '⚠ Enter an 11-digit mainland mobile · 请输入 11 位手机号'; return;
  }
  status.textContent = 'Sending… · 发送中…';
  try {
    await saveAliyunSms_();
    // Test endpoints return {ok:…}, not {success:…}, so call fetch directly
    // (the same pattern the kd100/JD test buttons use).
    const r = await fetch('/api/retail-admin/integrations/aliyun_sms/test', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) {
      status.textContent = '✅ Sent — check that phone · 已发送,请查看该手机';
    } else {
      const m = j.error === 'not_configured' ? 'Fill in all four fields first · 请先填写四项'
              : j.error === 'bad_phone'      ? 'Bad phone number · 手机号无效'
              : (j.error || 'failed');
      status.textContent = '⚠ ' + m;
    }
    loadAliyunSms();
  } catch (e) { status.textContent = '⚠ ' + (e.message || 'failed'); }
}

async function saveConfig() {
  const status = $('#cfg-status');
  status.textContent = 'Saving…';
  const body = {
    // Brand & theme (accent / notification colour / language / mascots) moved to
    // the Mini App Editor (/cms) 2026-06-09 — it writes those keys to config itself.
    // Fees — shipping, free-shipping threshold, pickup packing/hours, and the
    // minimum-order gate — all live in the Delivery tab now (saveDeliveryFees).
    'shop.layout':                 $('#cfg-shop-layout').value,
    'shop.defaultSort':            $('#cfg-shop-defaultSort').value,
    'shop.showSort':               $('#cfg-shop-showSort').checked,
    'shop.showDietary':            $('#cfg-shop-showDietary').checked,
    'shop.showStockFilter':        $('#cfg-shop-showStockFilter').checked,
    'shop.showBadgeFilter':        $('#cfg-shop-showBadgeFilter').checked,
    'shop.showPriceFilter':        $('#cfg-shop-showPriceFilter').checked,
    'shop.hideOutOfStock':         $('#cfg-shop-hideOutOfStock').checked,
    'shop.lockLayout':             $('#cfg-shop-lockLayout').checked,
    'notifications.order_status_template_id': $('#cfg-notifications-order_status_template_id').value.trim(),
    'notifications.wecom_order_webhook': $('#cfg-notifications-wecom_order_webhook').value.trim(),
    'customer_service.mode':         $('#cfg-cs-mode').value,
    'customer_service.corp_id':      $('#cfg-cs-corp_id').value.trim(),
    'customer_service.url':          $('#cfg-cs-url').value.trim(),
    'customer_service.qr_image_url': $('#cfg-cs-qr_image_url').value,
    'customer_service.label_en':     $('#cfg-cs-label_en').value.trim(),
    'customer_service.label_cn':     $('#cfg-cs-label_cn').value.trim(),
    'customer_service.hours_en':     $('#cfg-cs-hours_en').value.trim(),
    'customer_service.hours_cn':     $('#cfg-cs-hours_cn').value.trim(),
    'customer_service.phone':        $('#cfg-cs-phone').value.trim(),
    'customer_service.show_me':       $('#cfg-cs-show_me').checked,
    'customer_service.show_home':     $('#cfg-cs-show_home').checked,
    'customer_service.show_product':  $('#cfg-cs-show_product').checked,
    'customer_service.show_checkout': $('#cfg-cs-show_checkout').checked,
    'customer_service.show_order':    $('#cfg-cs-show_order').checked,
    'customer_service.fab_size':       $('#cfg-cs-fab_size').value,
    'customer_service.fab_shape':      $('#cfg-cs-fab_shape').value,
    'customer_service.fab_color':      $('#cfg-cs-fab_color').value,
    'customer_service.fab_icon':       $('#cfg-cs-fab_icon').value,
    'customer_service.fab_icon_emoji': $('#cfg-cs-fab_icon_emoji').value.trim(),
    'customer_service.fab_side':       $('#cfg-cs-fab_side').value,
    'customer_service.fab_bottom':     parseInt($('#cfg-cs-fab_bottom').value, 10) || 220,
    // Legal pages moved to the Content group (Content → Legal pages) and save on
    // their own button via saveLegal() — no longer ride along here (2026-06-08).
    // Mini-app footer + Me-page menu moved to the Mini App Editor (/cms) 2026-06-09.
    // Social proof moved to the Marketing group 2026-06-09 — it saves on its own
    // button via saveSocialProof() (partial PUT) and no longer rides along here.
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body });
    status.innerHTML = '<span class="ok">Saved ✓</span>';
    toast('Settings saved · 设置已保存');
  } catch (e) {
    status.innerHTML = '<span class="err">Failed · 失败: ' + e.message + '</span>';
  }
}

// ── Social proof — own partial save (moved to the Marketing group 2026-06-09). ──
// Reads the same cfg-social-* fields and writes a single nested social_proof blob,
// matching the shape getSocialConfig() in routes/retail.js expects.
function buildSocialProof() {
  // Helper: clamp + auto-swap so a max < min input doesn't ship garbage.
  // Operators who type a single number into "min" and leave "max" at 0 would
  // otherwise save a degenerate range; swap fixes that silently.
  const range = (minId, maxId, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
    let mn = Math.max(lo, Math.min(hi, Number($('#' + minId).value) || 0));
    let mx = Math.max(lo, Math.min(hi, Number($('#' + maxId).value) || 0));
    if (mx < mn) [mn, mx] = [mx, mn];
    return { min: mn, max: mx };
  };
  const bcR = range('cfg-social-bc-boost_min', 'cfg-social-bc-boost_max');
  const vnR = range('cfg-social-vn-boost_min', 'cfg-social-vn-boost_max');
  const sbR = range('cfg-social-sb-boost_min', 'cfg-social-sb-boost_max');
  const loR = range('cfg-social-lo-fallback_min_minutes', 'cfg-social-lo-fallback_max_minutes', 0, 1440);
  return {
    bought_count: {
      enabled:   $('#cfg-social-bc-enabled').checked,
      min_today: Math.max(1, Number($('#cfg-social-bc-min_today').value) || 2),
      min_week:  Math.max(1, Number($('#cfg-social-bc-min_week').value)  || 2),
      min_month: Math.max(1, Number($('#cfg-social-bc-min_month').value) || 1),
      min_all:   Math.max(1, Number($('#cfg-social-bc-min_all').value)   || 2),
      boost_min: bcR.min,
      boost_max: bcR.max,
    },
    recent_buyers: {
      enabled:      $('#cfg-social-rb-enabled').checked,
      window_days:  Math.max(1, Math.min(60, Number($('#cfg-social-rb-window_days').value) || 7)),
      visible_secs: Math.max(0.5, Math.min(60, Number($('#cfg-social-rb-visible_secs').value) || 4.5)),
      gap_secs:     Math.max(0.5, Math.min(60, Number($('#cfg-social-rb-gap_secs').value) || 5)),
      // Drop empty rows so we don't ship blanks to the mini-app feed.
      manual: _manualBuyers
        .map(m => ({
          name:        String(m.name || '').trim().slice(0, 40),
          product_en:  String(m.product_en || '').trim().slice(0, 80),
          product_cn:  String(m.product_cn || '').trim().slice(0, 80),
          minutes_ago: Math.max(0, Math.min(60 * 24 * 60, Number(m.minutes_ago) || 0)),
        }))
        .filter(m => m.name && (m.product_en || m.product_cn)),
    },
    viewing_now: {
      enabled:     $('#cfg-social-vn-enabled').checked,
      show_in_app: $('#cfg-social-vn-show_in_app').checked,
      ttl_sec:   Math.max(5, Math.min(600, Number($('#cfg-social-vn-ttl_sec').value) || 45)),
      boost_min: vnR.min,
      boost_max: vnR.max,
    },
    last_ordered: {
      enabled:              $('#cfg-social-lo-enabled').checked,
      max_hours:            Math.max(1, Math.min(720, Number($('#cfg-social-lo-max_hours').value) || 24)),
      fallback_min_minutes: loR.min,
      fallback_max_minutes: loR.max,
    },
    sold_badge: {
      enabled:   $('#cfg-social-sb-enabled').checked,
      min_units: Math.max(1, Number($('#cfg-social-sb-min_units').value) || 3),
      boost_min: sbR.min,
      boost_max: sbR.max,
    },
  };
}
async function saveSocialProof() {
  const status = $('#social-status');
  if (status) { status.textContent = 'Saving… · 保存中…'; status.style.color = ''; }
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'social_proof': buildSocialProof() } });
    if (status) status.innerHTML = '<span class="ok">Saved ✓ · 已保存</span>';
    toast('Saved · 已保存');
  } catch (e) {
    if (status) { status.textContent = 'Save failed · 保存失败'; status.style.color = 'var(--danger)'; }
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

// Mini-app footer + Me-page menu (brand.me_footer / me_page.rows) moved to the
// Mini App Editor (/cms) 2026-06-09 — load/save + the wordmark upload buffer and
// the row-reorder list now live there. Kept here only as a pointer.

// ════════════════════════════════════════════════════════════════
// SOCIAL PROOF — manual fake-buyers list (recent-buyers ticker card)
// ════════════════════════════════════════════════════════════════
// Operator-authored rows that get merged into the real /api/retail/social/
// recent-buyers feed. Held in memory between load + save, rendered as a
// simple repeating row UI. Names should be pre-masked by the operator
// (e.g. "李**") — the server doesn't run them through maskBuyerName.
let _manualBuyers = [];

function renderManualBuyers() {
  const mount = document.getElementById('cfg-social-rb-manual-list');
  if (!mount) return;
  if (!_manualBuyers.length) {
    mount.innerHTML = '<div class="muted" style="font-size: 12px; padding: 6px 0;">No fake entries yet. · 暂无虚拟条目。</div>';
    return;
  }
  mount.innerHTML = _manualBuyers.map((m, i) => `
    <div class="row" style="gap: 6px; flex-wrap: wrap; align-items: center;
         padding: 8px; background: var(--bg-elev-1); border: 1px solid var(--line); border-radius: 6px;">
      <input type="text" data-mb-i="${i}" data-mb-f="name"
             value="${escapeAttr(m.name || '')}"
             data-ph-en="Masked name, e.g. W**" data-ph-cn="已脱敏姓名,如 李**"
             style="flex: 1 1 110px; min-width: 90px; font-size: 12px;">
      <input type="text" data-mb-i="${i}" data-mb-f="product_en"
             value="${escapeAttr(m.product_en || '')}"
             placeholder="Product EN" data-ph-en="Product (English)" data-ph-cn="产品名(英文)"
             style="flex: 2 1 160px; min-width: 120px; font-size: 12px;">
      <input type="text" data-mb-i="${i}" data-mb-f="product_cn"
             value="${escapeAttr(m.product_cn || '')}"
             placeholder="产品名(中文)" data-ph-en="Product (Chinese)" data-ph-cn="产品名(中文)"
             style="flex: 2 1 160px; min-width: 120px; font-size: 12px;">
      <div class="row" style="gap: 4px; align-items: center;">
        <input type="number" data-mb-i="${i}" data-mb-f="minutes_ago" min="0" max="86400"
               value="${Number(m.minutes_ago) || 0}"
               style="width: 80px; font-size: 12px;">
        <span class="muted" style="font-size: 11px;">min ago · 分钟前</span>
      </div>
      <button type="button" class="cat-del" title="Remove · 删除"
              onclick="removeManualBuyer(${i})">×</button>
    </div>
  `).join('');
}

function addManualBuyer() {
  _manualBuyers.push({ name: '', product_en: '', product_cn: '', minutes_ago: 5 });
  renderManualBuyers();
}

function removeManualBuyer(i) {
  _manualBuyers.splice(i, 1);
  renderManualBuyers();
}

// Inline edits flow back into the state array via delegated change/input.
// Using `input` (not just `change`) so the value is captured even if the
// operator hits Save before blurring a field.
document.addEventListener('input', e => {
  const t = e.target;
  if (!t || !t.dataset || t.dataset.mbI == null) return;
  const i = Number(t.dataset.mbI);
  const f = t.dataset.mbF;
  if (!Number.isFinite(i) || !_manualBuyers[i] || !f) return;
  _manualBuyers[i][f] = (f === 'minutes_ago') ? (Number(t.value) || 0) : t.value;
});


// Mini-app footer wordmark upload/clear handlers moved to the Mini App Editor (/cms) 2026-06-09.

// ════════════════════════════════════════════════════════════════
// SHOP CATEGORIES — list, drag-and-drop reorder, rename, add, delete
// ════════════════════════════════════════════════════════════════
let _cats = [];

async function loadCategories() {
  try {
    const { data } = await api('/api/retail-admin/categories');
    _cats = data || [];
    renderCategories();
  } catch (e) {
    $('#cats-status').innerHTML = '<span class="err">Load failed · 加载失败: ' + escapeHtml(e.message) + '</span>';
  }
}

function renderCategories() {
  const ul = $('#cats-list');
  ul.innerHTML = '';
  _cats.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'cat-item';
    li.draggable = true;
    li.dataset.id = c.id;
    li.dataset.index = i;
    li.innerHTML = `
      <span class="cat-handle" title="Drag to reorder · 拖动排序">☰</span>
      <input class="cat-name" type="text" value="${escapeAttr(c.name)}" data-original="${escapeAttr(c.name)}">
      <span class="cat-usage">${c.usage_count} product${c.usage_count === 1 ? '' : 's'} · ${c.usage_count} 个商品</span>
      <button class="cat-del" title="Delete (only allowed if no products use it) · 删除(仅当无商品使用时)">×</button>
    `;
    const nameInput = li.querySelector('.cat-name');
    nameInput.addEventListener('blur', () => renameCategory(c.id, nameInput));
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') nameInput.blur();
      if (ev.key === 'Escape') { nameInput.value = nameInput.dataset.original; nameInput.blur(); }
    });
    li.querySelector('.cat-del').addEventListener('click', () => deleteCategory(c.id, c.name, c.usage_count));
    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover',  onDragOver);
    li.addEventListener('dragleave', onDragLeave);
    li.addEventListener('drop',      onDrop);
    li.addEventListener('dragend',   onDragEnd);
    ul.appendChild(li);
  });
}

let _dragSrcId = null;
function onDragStart(e) {
  _dragSrcId = Number(e.currentTarget.dataset.id);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Required for Firefox
  try { e.dataTransfer.setData('text/plain', String(_dragSrcId)); } catch {}
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop-target');
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}
function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-target');
  const targetId = Number(e.currentTarget.dataset.id);
  if (!_dragSrcId || targetId === _dragSrcId) return;
  const srcIdx = _cats.findIndex(c => c.id === _dragSrcId);
  const dstIdx = _cats.findIndex(c => c.id === targetId);
  if (srcIdx < 0 || dstIdx < 0) return;
  const [moved] = _cats.splice(srcIdx, 1);
  _cats.splice(dstIdx, 0, moved);
  renderCategories();
  saveCategoryOrder();
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.cat-item.drop-target').forEach(el => el.classList.remove('drop-target'));
  _dragSrcId = null;
}

async function saveCategoryOrder() {
  const status = $('#cats-status');
  status.innerHTML = 'Saving order…';
  try {
    await api('/api/retail-admin/categories/reorder', {
      method: 'POST',
      body: { ids: _cats.map(c => c.id) },
    });
    status.innerHTML = '<span class="ok">Order saved ✓</span>';
    setTimeout(() => { status.innerHTML = ''; }, 1500);
  } catch (e) {
    status.innerHTML = '<span class="err">Save failed · 保存失败: ' + escapeHtml(e.message) + '</span>';
    // Reload to recover from a partial state
    loadCategories();
  }
}

async function renameCategory(id, input) {
  const newName = (input.value || '').trim();
  const oldName = input.dataset.original;
  if (!newName || newName === oldName) { input.value = oldName; return; }
  const status = $('#cats-status');
  status.innerHTML = 'Renaming…';
  try {
    await api('/api/retail-admin/categories/' + id, { method: 'PATCH', body: { name: newName } });
    input.dataset.original = newName;
    const c = _cats.find(x => x.id === id);
    if (c) c.name = newName;
    status.innerHTML = '<span class="ok">Renamed ✓</span>';
    setTimeout(() => { status.innerHTML = ''; }, 1500);
  } catch (e) {
    input.value = oldName;
    status.innerHTML = '<span class="err">Rename failed · 重命名失败: ' + escapeHtml(e.message) + '</span>';
  }
}

async function addCategory() {
  const input = $('#cats-new-name');
  const name = (input.value || '').trim();
  if (!name) { input.focus(); return; }
  const status = $('#cats-status');
  status.innerHTML = 'Adding…';
  try {
    const { data } = await api('/api/retail-admin/categories', { method: 'POST', body: { name } });
    _cats.push(data);
    input.value = '';
    renderCategories();
    status.innerHTML = '<span class="ok">Added ✓</span>';
    setTimeout(() => { status.innerHTML = ''; }, 1500);
  } catch (e) {
    status.innerHTML = '<span class="err">Add failed · 添加失败: ' + escapeHtml(e.message) + '</span>';
  }
}

async function deleteCategory(id, name, usage) {
  if (usage > 0) {
    alert(`"${name}" is used by ${usage} product${usage === 1 ? '' : 's'}. Recategorize or unpublish those products first. · "${name}" 已被 ${usage} 个商品使用。请先将这些商品重新分类或下架。`);
    return;
  }
  if (!confirm(`Delete category "${name}"? · 删除分类 "${name}"？`)) return;
  const status = $('#cats-status');
  status.innerHTML = 'Deleting…';
  try {
    await api('/api/retail-admin/categories/' + id, { method: 'DELETE' });
    _cats = _cats.filter(c => c.id !== id);
    renderCategories();
    status.innerHTML = '<span class="ok">Deleted ✓</span>';
    setTimeout(() => { status.innerHTML = ''; }, 1500);
  } catch (e) {
    status.innerHTML = '<span class="err">Delete failed · 删除失败: ' + escapeHtml(e.message) + '</span>';
  }
}

// ════════════════════════════════════════════════════════════════
// BROADCASTS — operator-composed announcements that fan out to every
// active (non-blocked) customer's notification inbox.
// ════════════════════════════════════════════════════════════════
function bcDeeplinkPreset() {
  const sel = $('#bc-deeplink-preset');
  const input = $('#bc-deeplink');
  if (sel.value === '__custom__') {
    input.style.display = '';
    input.value = '';
    input.focus();
  } else {
    input.style.display = 'none';
    input.value = sel.value || '';
  }
}
function bcScheduleMode() {
  const sel = $('#bc-schedule-mode');
  const at  = $('#bc-schedule-at');
  const lbl = $('#bc-send-label');
  if (sel.value === 'later') {
    at.style.display = '';
    if (!at.value) {
      // Default to 1 hour from now in local time, datetime-local format.
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      at.value = d.toISOString().slice(0, 16);
    }
    lbl.textContent = 'Schedule broadcast';
  } else {
    at.style.display = 'none';
    lbl.textContent = 'Send broadcast';
  }
}
function bcResetComposer() {
  ['bc-title-en','bc-title-cn','bc-body-en','bc-body-cn','bc-deeplink','bc-schedule-at'].forEach(k => { const el = $('#' + k); if (el) el.value = ''; });
  $('#bc-deeplink-preset').value = '';
  $('#bc-deeplink').style.display = 'none';
  $('#bc-schedule-mode').value = 'now';
  $('#bc-schedule-at').style.display = 'none';
  $('#bc-send-label').textContent = 'Send broadcast';
  $('#bc-send-status').textContent = '';
  if ($('#bc-activity')) $('#bc-activity').value = 'all';
  document.querySelectorAll('.bc-tier:checked, .bc-city:checked').forEach(el => { el.checked = false; });
  loadBroadcastAudienceCount();
}
function bcAudienceObj() {
  const activity = ($('#bc-activity') || {}).value || 'all';
  const tiers  = Array.from(document.querySelectorAll('.bc-tier:checked')).map(el => el.value);
  const cities = Array.from(document.querySelectorAll('.bc-city:checked')).map(el => el.value);
  return { activity, tiers, cities };
}
function bcAudienceLabel(aud) {
  const T = (en, cn) => (window.cuT ? cuT(en, cn) : en);
  const ACT = {
    all:    T('All active customers', '所有活跃客户'),
    buyers: T('Has ordered', '曾下单'),
    never:  T('Never ordered', '从未下单'),
    active: T('Active (last 30d)', '近30天活跃'),
    lapsed: T('Lapsed (60d)', '60天未下单'),
  };
  const TIER = {
    seed: T('Seed', '种子'), sprout: T('Sprout', '萌芽'),
    root: T('Root', '扎根'), tree: T('Tree', '成树'),
  };
  const bits = [ACT[aud.activity] || ACT.all];
  if (aud.tiers && aud.tiers.length) bits.push(aud.tiers.map(t => TIER[t] || t).join(', '));
  if (aud.cities && aud.cities.length) {
    if (aud.cities.length <= 2) {
      bits.push(aud.cities.map(c => T(bcCityEn(c) || c, c)).join(', '));
    } else {
      bits.push(T(aud.cities.length + ' regions', aud.cities.length + ' 个地区'));
    }
  }
  return bits.join(' · ');
}
let _bcAudTimer = null;
function bcAudienceChanged() {
  clearTimeout(_bcAudTimer);
  _bcAudTimer = setTimeout(loadBroadcastAudienceCount, 250);
}
async function loadBroadcastAudienceCount() {
  const aud = bcAudienceObj();
  $('#bc-aud-summary').textContent = bcAudienceLabel(aud);
  try {
    const q = '?aud=' + encodeURIComponent(JSON.stringify(aud));
    const { data } = await api('/api/retail-admin/broadcasts/audience-count' + q);
    $('#bc-aud-count').textContent = (data && data.count != null ? data.count : '0') + T(' customers', ' 位顾客');
  } catch (e) {
    $('#bc-aud-count').textContent = '?';
  }
}
let _bcRegions = [];
function bcCityEn(cityCn) {
  const r = _bcRegions.find(x => x.city === cityCn);
  return (r && r.city_en) || null;
}
async function loadBroadcastRegions() {
  const wrap = $('#bc-regions');
  if (!wrap) return;
  try {
    const { data } = await api('/api/retail-admin/broadcasts/regions');
    _bcRegions = data || [];
    if (!_bcRegions.length) {
      wrap.innerHTML = '<span class="muted" style="font-size:12px;">No saved addresses yet. · 暂无已保存地址。</span>';
      return;
    }
    wrap.innerHTML = _bcRegions.map(r => {
      // When an English city name exists, emit an "EN · 中文" text node so the
      // page's i18n layer shows the operator's active language (and live-toggles).
      const label = r.city_en
        ? `${escapeHtml(r.city_en)} · ${escapeHtml(r.city)}`
        : escapeHtml(r.city);
      return `<label class="bc-chip"><input type="checkbox" class="bc-city" value="${escapeHtml(r.city)}" onchange="bcAudienceChanged()"> ${label} <span class="muted">${r.n}</span></label>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = '<span class="err" style="font-size:12px;">Failed to load regions. · 加载地区失败。</span>';
  }
}
// Automatic-notification category switches. Read/write notifications.categories
// on the shared storefront config. Missing entry = enabled (the server defaults
// the same way), so an untouched store keeps today's behaviour.
async function loadNotifCategories() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    const cats = (c.notifications && c.notifications.categories) || {};
    document.querySelectorAll('[data-notif-cat]').forEach(el => {
      el.checked = cats[el.dataset.notifCat] !== false;   // default on
    });
  } catch (e) { /* leave switches as-is */ }
}
async function saveNotifCategory(el) {
  const cat = el.dataset.notifCat;
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { ['notifications.categories.' + cat]: !!el.checked } });
    toast('Saved · 已保存');
  } catch (e) {
    el.checked = !el.checked;   // revert the visual on failure
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}
async function loadBroadcasts() {
  const wrap = $('#bc-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="muted" style="font-size: 12px;">Loading…</div>';
  try {
    const { data } = await api('/api/retail-admin/broadcasts');
    if (!data.length) {
      wrap.innerHTML = '<div class="muted" style="font-size: 12px;">No broadcasts yet. · 暂无群发消息。</div>';
      return;
    }
    wrap.innerHTML = data.map(b => {
      const titleBits = [];
      if (b.title_en) titleBits.push(escapeHtml(b.title_en));
      if (b.title_cn) titleBits.push(escapeHtml(b.title_cn));
      const title = titleBits.join(' · ') || '<span class="muted">(no title) · (无标题)</span>';
      const bodyBits = [];
      if (b.body_en) bodyBits.push(escapeHtml(b.body_en));
      if (b.body_cn) bodyBits.push(escapeHtml(b.body_cn));
      const body = bodyBits.join(' · ');
      const status = b.status || 'sent';
      const BC_STATUS_LABEL = { sent: 'SENT · 已发送', scheduled: 'SCHEDULED · 已排期', draft: 'DRAFT · 草稿', recalled: 'RECALLED · 已撤回', cancelled: 'CANCELLED · 已取消' };
      const pill = `<span class="bc-pill ${status}">${BC_STATUS_LABEL[status] || status.toUpperCase()}</span>`;
      const meta = [];
      if (status === 'scheduled' && b.scheduled_for) meta.push('Scheduled for · 排期于 ' + escapeHtml(b.scheduled_for));
      if (b.sent_at) meta.push('Sent · 已发送 ' + escapeHtml(b.sent_at));
      if (b.recipient_count) meta.push(b.recipient_count + ' recipient' + (b.recipient_count === 1 ? '' : 's') + ' · ' + b.recipient_count + ' 位收件人');
      if (b.audience && b.audience.charAt(0) === '{') {
        try {
          const aud = JSON.parse(b.audience);
          if (aud.activity !== 'all' || (aud.tiers && aud.tiers.length) || (aud.cities && aud.cities.length)) {
            meta.push('To · 发送对象: ' + escapeHtml(bcAudienceLabel(aud)));
          }
        } catch (_) {}
      }
      if (b.deeplink) meta.push('→ <code>' + escapeHtml(b.deeplink) + '</code>');
      const canRecall = status === 'sent' || status === 'scheduled';
      const recallLabel = status === 'scheduled' ? 'Cancel · 取消' : 'Recall · 撤回';
      const recallBtn = canRecall
        ? `<button class="btn btn-sm" onclick="recallBroadcast(${b.id}, '${status}')">${recallLabel}</button>`
        : '';
      return `
        <div class="bc-item" data-id="${b.id}">
          <div class="bc-item-head">
            <div class="bc-item-title" data-no-i18n>${title}</div>
            ${pill}
            <div style="margin-left: auto;">${recallBtn}</div>
          </div>
          ${body ? `<div class="bc-item-body" data-no-i18n>${body}</div>` : ''}
          <div class="bc-item-meta">${meta.join('<span class="sep">·</span>')}</div>
        </div>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = `<div class="err" style="font-size: 12px;">Failed · 失败: ${escapeHtml(e.message)}</div>`;
  }
}
async function sendBroadcast() {
  const title_en = $('#bc-title-en').value.trim();
  const title_cn = $('#bc-title-cn').value.trim();
  const body_en  = $('#bc-body-en').value.trim();
  const body_cn  = $('#bc-body-cn').value.trim();
  const deeplink = $('#bc-deeplink').value.trim();
  const mode     = $('#bc-schedule-mode').value;
  const scheduledRaw = mode === 'later' ? $('#bc-schedule-at').value : '';

  if (!title_en && !title_cn) {
    $('#bc-send-status').innerHTML = '<span class="err">Add at least one title. · 请至少填写一个标题。</span>';
    return;
  }
  if (deeplink && !deeplink.startsWith('/pages/')) {
    $('#bc-send-status').innerHTML = '<span class="err">Deep-link must start with /pages/ · 深链需以 /pages/ 开头</span>';
    return;
  }
  const audCount = ($('#bc-aud-count').textContent || '').replace(/[^0-9]/g, '');
  const verb = mode === 'later' ? 'Schedule' : 'Send';
  if (!confirm(`${verb} this broadcast to ${audCount || 'all active'} customer${audCount === '1' ? '' : 's'}? · 向 ${audCount || '所有活跃'} 位客户${verb === 'Schedule' ? '排期' : '发送'}此群发消息？`)) return;

  const payload = { title_en, title_cn, body_en, body_cn, deeplink, audience: bcAudienceObj() };
  if (scheduledRaw) {
    // datetime-local has no timezone; treat as local time and convert.
    payload.scheduled_for = new Date(scheduledRaw).toISOString();
  }
  const btn = $('#bc-send-btn');
  const status = $('#bc-send-status');
  btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const { data } = await api('/api/retail-admin/broadcasts', { method: 'POST', body: payload });
    if (data.status === 'sent') {
      status.innerHTML = `<span style="color: #2e7d32;">Sent to ${data.recipient_count} customer${data.recipient_count === 1 ? '' : 's'}. · 已发送给 ${data.recipient_count} 位客户。</span>`;
    } else if (data.status === 'scheduled') {
      status.innerHTML = '<span style="color: #1a56a8;">Scheduled. · 已排期。</span>';
    }
    bcResetComposer();
    loadBroadcasts();
  } catch (e) {
    status.innerHTML = `<span class="err">Failed · 失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}
async function recallBroadcast(id, currentStatus) {
  const verb = currentStatus === 'scheduled'
    ? 'Cancel this scheduled broadcast · 取消此已排期的群发消息'
    : 'Recall this broadcast (remove from every customer\'s inbox) · 撤回此群发消息（从每位客户的收件箱中移除）';
  if (!confirm(verb + '?')) return;
  try {
    await api('/api/retail-admin/broadcasts/' + id + '/recall', { method: 'POST' });
    loadBroadcasts();
  } catch (e) {
    alert('Failed · 失败: ' + e.message);
  }
}
// Lazy-load when the operator first opens the tab.
document.querySelector('[data-tab="broadcasts"]').addEventListener('click', () => {
  loadNotifCategories();
  loadBroadcasts();
  loadBroadcastRegions();
  loadBroadcastAudienceCount();
});
// Keep the audience summary in sync when the operator flips EN/CN. The region
// chips re-translate themselves via the i18n text-node layer; this covers the
// computed summary line, which isn't a static "EN · 中文" node.
if (window.onLangChange) onLangChange(() => {
  const s = document.getElementById('bc-aud-summary');
  if (s) s.textContent = bcAudienceLabel(bcAudienceObj());
});

// ════════════════════════════════════════════════════════════════
// POP-UPS — list + editor + save back to storefront_config
// ════════════════════════════════════════════════════════════════
let _popups = [];
const PAGE_KEYS = [
  ['all',          'All pages · 全部页面'],
  ['home',         'Home · 首页'],
  ['shop',         'Shop · 商店'],
  ['cart',         'Cart · 购物车'],
  ['me',           'Me · 我的'],
  ['product',      'Product detail · 商品详情'],
  ['checkout',     'Checkout · 结账'],
  ['order-success','Order success · 下单成功'],
  ['orders',       'My orders · 我的订单'],
  ['membership',   'Membership · 会员'],
  ['addresses',    'Addresses · 地址'],
];

function uid() {
  return 'pu_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

async function loadPopups() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    const list = Array.isArray(c.popups?.list) ? c.popups.list : [];
    _popups = list;
    renderPopups();
  } catch (e) {
    $('#popups-list').innerHTML = `<div class="err">Load failed · 加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function popupWindowStatus(p) {
  const today = new Date().toISOString().slice(0, 10);
  if (p.start_at && today < p.start_at) return { kind: 'sched', label: 'Scheduled · 待开始 ' + p.start_at };
  if (p.end_at   && today > p.end_at)   return { kind: 'off',   label: 'Ended · 已结束 ' + p.end_at };
  if (p.enabled) return { kind: 'on',  label: 'Live · 进行中' };
  return { kind: 'off', label: 'Disabled · 已停用' };
}

function renderPopups() {
  const mount = $('#popups-list');
  if (!_popups.length) {
    mount.innerHTML = `<div class="empty-state">
      <div class="icon">${ICONS.empty}</div>
      <h3>No pop-ups yet · 暂无弹窗</h3>
      <p class="muted">Create one to announce a promo, request a review, or warn about a holiday. · 创建一个弹窗用于活动公告、邀请评价或假期提醒。</p>
    </div>`;
    return;
  }
  mount.innerHTML = _popups.map((p) => {
    const st = popupWindowStatus(p);
    const pages = (p.pages && p.pages.length) ? p.pages.map(k => PAGE_KEYS.find(([kk]) => kk === k)?.[1] || k).join(' · ') : '(no pages selected) · (未选择页面)';
    const freq = ({ once: 'Once ever · 仅一次', daily: 'Once/day · 每天一次', session: 'Once/session · 每次会话一次', every_visit: 'Every visit · 每次访问' })[p.frequency] || p.frequency || 'once';
    const trig = p.trigger === 'after_seconds' ? `After ${p.delay_seconds || 3}s · ${p.delay_seconds || 3}秒后` : 'On open · 打开时';
    return `
      <div class="pu-card">
        <label class="pu-toggle" title="Enable / disable · 启用 / 停用">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePopup('${escapeAttr(p.id)}', this.checked)">
        </label>
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="pu-name">${escapeHtml(p.name || '(untitled) · (未命名)')}</div>
            <span class="pu-status-pill ${st.kind}">${escapeHtml(st.label)}</span>
          </div>
          <div class="pu-meta">
            ${escapeHtml(pages)} · ${escapeHtml(trig)} · ${escapeHtml(freq)}
            ${p.title_en ? ' · "<i>' + escapeHtml((p.title_en || '').slice(0, 60)) + '</i>"' : ''}
          </div>
        </div>
        <div class="pu-actions">
          <button class="btn btn-sm" onclick="openPopupEditor('${escapeAttr(p.id)}')">${ICONS.open}Edit · 编辑</button>
        </div>
      </div>`;
  }).join('');
}

async function togglePopup(id, enabled) {
  const p = _popups.find(x => x.id === id);
  if (!p) return;
  p.enabled = !!enabled;
  await savePopupsArray();
  renderPopups();
}

function blankPopup() {
  return {
    id: uid(),
    enabled: true,
    name: '',
    pages: ['home'],
    trigger: 'on_load',
    delay_seconds: 3,
    frequency: 'once',
    start_at: '',
    end_at: '',
    image_url: '',
    title_en: '', title_cn: '',
    body_en: '',  body_cn: '',
    cta_label_en: '', cta_label_cn: '', cta_target: '',
    dismissible: true,
  };
}

function openPopupEditor(id) {
  const p = id ? _popups.find(x => x.id === id) : blankPopup();
  if (!p) return;
  $('#pu-editor-title').textContent = id ? 'Edit pop-up · 编辑弹窗' : 'New pop-up · 新建弹窗';
  $('#pu-delete-btn').style.display = id ? '' : 'none';
  $('#pu-id').value         = p.id;
  $('#pu-name').value       = p.name || '';
  $('#pu-enabled').checked  = !!p.enabled;
  $('#pu-dismissible').checked = p.dismissible !== false;
  $('#pu-trigger').value    = p.trigger || 'on_load';
  $('#pu-delay').value      = p.delay_seconds ?? 3;
  $('#pu-frequency').value  = p.frequency || 'once';
  $('#pu-start_at').value   = (p.start_at || '').slice(0, 10);
  $('#pu-end_at').value     = (p.end_at || '').slice(0, 10);
  $('#pu-image_url').value  = p.image_url || '';
  $('#pu-title_en').value   = p.title_en || '';
  $('#pu-title_cn').value   = p.title_cn || '';
  $('#pu-body_en').value    = p.body_en || '';
  $('#pu-body_cn').value    = p.body_cn || '';
  $('#pu-cta_label_en').value = p.cta_label_en || '';
  $('#pu-cta_label_cn').value = p.cta_label_cn || '';
  $('#pu-cta_target').value = p.cta_target || '';
  hydrateCtaTargetPicker(p.cta_target || '');
  renderPopupPageChips(p.pages || []);
  renderPopupImagePreview();
  updatePopupPreview();
  $('#pu-delay-wrap').style.display = $('#pu-trigger').value === 'after_seconds' ? '' : 'none';
  openDrawer('#pu-editor-bg');
}
function closePopupEditor() { closeDrawer('#pu-editor-bg'); }

// ─── CTA destination picker ───────────────────────────────────────
const SIMPLE_TARGETS = new Set(['shop','cart','home','me','membership','promotions','about','categories']);
let _ctaProducts = null;  // cached list, loaded on demand

function ctaTargetLabel(t) {
  if (!t) return '';
  const SIMPLE_TARGET_LABEL = { shop: 'Shop · 商店', cart: 'Cart · 购物车', home: 'Home · 首页', me: 'Me · 我的', membership: 'Membership · 会员', promotions: 'Promotions · 促销', about: 'About · 关于', categories: 'Categories · 分类' };
  if (SIMPLE_TARGETS.has(t)) return SIMPLE_TARGET_LABEL[t] || (t[0].toUpperCase() + t.slice(1));
  if (t.startsWith('product:')) {
    const id = t.split(':')[1];
    const p = (_ctaProducts || []).find(x => String(x.id) === id);
    return p ? `Product · 商品 ${p.name_en || p.name_cn || ('#' + id)}` : 'Product · 商品 #' + id;
  }
  if (t.startsWith('category:')) {
    const key = t.split(':')[1];
    const c = _cats.find(x => String(x.id) === key) || _cats.find(x => x.name === key);
    return c ? `Category · 分类 ${c.name}` : 'Category · 分类 ' + key;
  }
  return t;
}

function updateCtaTargetPreview() {
  const t = $('#pu-cta_target').value;
  $('#pu-cta_target_preview').textContent = t ? `→ ${ctaTargetLabel(t)}` : 'No destination — pop-up just dismisses. · 无跳转 — 弹窗仅关闭。';
}

async function ensureCtaProducts() {
  if (_ctaProducts) return _ctaProducts;
  try {
    const j = await api('/api/retail-admin/products');
    _ctaProducts = j.data || [];
  } catch { _ctaProducts = []; }
  return _ctaProducts;
}

function renderCtaCategorySelect(selectedKey) {
  const sel = $('#pu-cta_target_category');
  if (!_cats.length) {
    sel.innerHTML = '<option value="">(no categories yet) · (暂无分类)</option>';
    return;
  }
  sel.innerHTML = '<option value="">— pick a category · 选择分类 —</option>' +
    _cats.map(c => `<option value="${escapeAttr(c.id)}" ${String(c.id) === String(selectedKey) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

async function renderCtaProductSelect(selectedId, query) {
  await ensureCtaProducts();
  const sel = $('#pu-cta_target_product');
  const q = (query || '').trim().toLowerCase();
  let list = _ctaProducts;
  if (q) list = list.filter(p =>
    (p.name_en || '').toLowerCase().includes(q) ||
    (p.name_cn || '').toLowerCase().includes(q) ||
    (p.sku || '').toLowerCase().includes(q)
  );
  list = list.slice(0, 200);
  if (!list.length) {
    sel.innerHTML = '<option value="">(no matches) · (无匹配)</option>';
    return;
  }
  sel.innerHTML = list.map(p => {
    const name = [p.name_en, p.name_cn].filter(Boolean).join(' · ') || ('#' + p.id);
    const sku = p.sku ? ` [${p.sku}]` : '';
    const pub = p.is_published ? '' : ' (draft) · (草稿)';
    return `<option value="${p.id}" ${String(p.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(name + sku + pub)}</option>`;
  }).join('');
}

function hydrateCtaTargetPicker(target) {
  const kind = $('#pu-cta_target_kind');
  const t = (target || '').trim();
  if (!t) { kind.value = ''; }
  else if (SIMPLE_TARGETS.has(t)) { kind.value = t; }
  else if (t.startsWith('product:')) { kind.value = 'product'; }
  else if (t.startsWith('category:')) { kind.value = 'category'; }
  else { kind.value = ''; }
  applyCtaTargetKindUI();
  if (kind.value === 'product') {
    const id = t.split(':')[1] || '';
    renderCtaProductSelect(id, '').then(updateCtaTargetPreview);
  } else if (kind.value === 'category') {
    const key = t.split(':')[1] || '';
    renderCtaCategorySelect(key);
    updateCtaTargetPreview();
  } else {
    updateCtaTargetPreview();
  }
}

function applyCtaTargetKindUI() {
  const kind = $('#pu-cta_target_kind').value;
  $('#pu-cta_product_wrap').style.display  = kind === 'product'  ? '' : 'none';
  $('#pu-cta_category_wrap').style.display = kind === 'category' ? '' : 'none';
}

document.addEventListener('change', e => {
  const id = e.target.id;
  if (id === 'pu-cta_target_kind') {
    applyCtaTargetKindUI();
    const kind = e.target.value;
    if (SIMPLE_TARGETS.has(kind)) {
      $('#pu-cta_target').value = kind;
    } else if (kind === 'product') {
      renderCtaProductSelect('', '');
      $('#pu-cta_target').value = '';  // until they pick
    } else if (kind === 'category') {
      renderCtaCategorySelect('');
      $('#pu-cta_target').value = '';
    } else {
      $('#pu-cta_target').value = '';
    }
    updateCtaTargetPreview();
    updatePopupPreview();
  }
  if (id === 'pu-cta_target_product') {
    const v = e.target.value;
    $('#pu-cta_target').value = v ? 'product:' + v : '';
    updateCtaTargetPreview();
    updatePopupPreview();
  }
  if (id === 'pu-cta_target_category') {
    const v = e.target.value;
    $('#pu-cta_target').value = v ? 'category:' + v : '';
    updateCtaTargetPreview();
    updatePopupPreview();
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'pu-cta_product_search') {
    renderCtaProductSelect($('#pu-cta_target_product').value, e.target.value);
  }
});

function renderPopupPageChips(selected) {
  const wrap = $('#pu-pages');
  wrap.innerHTML = PAGE_KEYS.map(([k, label]) => {
    const on = selected.includes(k);
    return `<span class="pu-page-chip ${on ? 'on' : ''}" data-page="${k}">${label}</span>`;
  }).join('');
  wrap.querySelectorAll('.pu-page-chip').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.page;
      if (key === 'all') {
        const willEnable = !el.classList.contains('on');
        wrap.querySelectorAll('.pu-page-chip').forEach(x => x.classList.toggle('on', x.dataset.page === 'all' && willEnable));
      } else {
        el.classList.toggle('on');
        wrap.querySelector('.pu-page-chip[data-page="all"]').classList.remove('on');
      }
    });
  });
}
function selectedPopupPages() {
  return Array.from($('#pu-pages').querySelectorAll('.pu-page-chip.on')).map(el => el.dataset.page);
}

async function uploadPopupImage(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Uploading… · 上传中…');
  try {
    const r = await fetch('/api/retail-admin/cms/media', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!j.success) { toast('Upload failed · 上传失败: ' + (j.error || ''), 'err'); return; }
    $('#pu-image_url').value = j.data.url;
    renderPopupImagePreview();
    updatePopupPreview();
    toast('Uploaded · 已上传');
  } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
}
function renderPopupImagePreview() {
  const url = $('#pu-image_url').value;
  const m = $('#pu-image-preview');
  if (!url) { m.innerHTML = '<div class="muted" style="font-size: 11px;">No image yet — text-only pop-up. · 暂无图片 — 纯文字弹窗。</div>'; return; }
  m.innerHTML = `<img src="${escapeAttr(url)}" alt="" style="max-width: 240px; max-height: 160px; border-radius: 6px; border: 1px solid var(--line);">
    <div style="margin-top: 6px;"><button class="btn btn-sm" onclick="clearPopupImage()">Remove image · 移除图片</button></div>`;
}
function clearPopupImage() {
  $('#pu-image_url').value = ''; renderPopupImagePreview(); updatePopupPreview();
}

function updatePopupPreview() {
  const title = $('#pu-title_en').value.trim() || $('#pu-title_cn').value.trim() || 'Pop-up title';
  const body  = $('#pu-body_en').value.trim()  || $('#pu-body_cn').value.trim()  || '';
  const cta   = $('#pu-cta_label_en').value.trim() || $('#pu-cta_label_cn').value.trim() || '';
  const img   = $('#pu-image_url').value;
  const dismissible = $('#pu-dismissible').checked;
  $('#pu-preview-title').textContent = title;
  $('#pu-preview-body').textContent  = body;
  const cEl = $('#pu-preview-cta');
  cEl.textContent = cta;
  cEl.style.display = cta ? '' : 'none';
  const iEl = $('#pu-preview-img');
  if (img) { iEl.style.backgroundImage = `url(${JSON.stringify(img)})`; iEl.style.display = ''; }
  else     { iEl.style.display = 'none'; }
  $('#pu-preview-close').style.display = dismissible ? '' : 'none';
}

document.addEventListener('input',  e => { if (e.target.id?.startsWith('pu-')) updatePopupPreview(); });
document.addEventListener('change', e => {
  if (e.target.id === 'pu-trigger') $('#pu-delay-wrap').style.display = e.target.value === 'after_seconds' ? '' : 'none';
  if (e.target.id?.startsWith('pu-')) updatePopupPreview();
  if (e.target.id === 'pu-image-file' && e.target.files?.[0]) uploadPopupImage(e.target.files[0]);
});

async function savePopup() {
  const id = $('#pu-id').value;
  const existingIdx = _popups.findIndex(x => x.id === id);
  const pages = selectedPopupPages();
  if (!pages.length) { toast('Pick at least one page · 至少选择一个页面', 'err'); return; }
  const next = {
    id,
    enabled:    $('#pu-enabled').checked,
    name:       $('#pu-name').value.trim(),
    pages,
    trigger:    $('#pu-trigger').value,
    delay_seconds: Number($('#pu-delay').value) || 0,
    frequency:  $('#pu-frequency').value,
    start_at:   $('#pu-start_at').value.trim(),
    end_at:     $('#pu-end_at').value.trim(),
    image_url:  $('#pu-image_url').value,
    title_en:   $('#pu-title_en').value,
    title_cn:   $('#pu-title_cn').value,
    body_en:    $('#pu-body_en').value,
    body_cn:    $('#pu-body_cn').value,
    cta_label_en: $('#pu-cta_label_en').value,
    cta_label_cn: $('#pu-cta_label_cn').value,
    cta_target: $('#pu-cta_target').value.trim(),
    dismissible: $('#pu-dismissible').checked,
  };
  if (existingIdx === -1) _popups.unshift(next);
  else _popups[existingIdx] = next;
  try {
    await savePopupsArray();
    closePopupEditor();
    renderPopups();
    toast('Pop-up saved · 弹窗已保存');
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

async function deletePopup() {
  const id = $('#pu-id').value;
  if (!confirm('Delete this pop-up? · 删除此弹窗?')) return;
  _popups = _popups.filter(p => p.id !== id);
  try {
    await savePopupsArray();
    closePopupEditor();
    renderPopups();
    toast('Pop-up deleted · 弹窗已删除');
  } catch (e) { toast('Delete failed · 删除失败: ' + e.message, 'err'); }
}

async function savePopupsArray() {
  await api('/api/retail-admin/config', { method: 'PUT', body: { 'popups.list': _popups } });
}

