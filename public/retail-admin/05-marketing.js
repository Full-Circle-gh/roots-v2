/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 05/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: vouchers/coupons + grants, snippets editor, storefront settings + feature gates + customer service, social proof, shop categories, broadcasts, pop-ups */
// ════════════════════════════════════════════════════════════════
// VOUCHERS / COUPONS — Tacet rebuild (Option A: one door, quiet rows).
// The table is the page: a Running/Off/All segment + search over quiet
// rows; clicking a row opens the side drawer (#vch-drawer) where every
// per-coupon control lives — the three "how customers get it" switches,
// label edit, end date, grants, on/off. Creation has ONE door: the
// guided wizard (vwOpen, further down this file). All strings render
// through cuT and the dynamic mounts carry data-no-i18n, so the page
// language is picked at render time (never glued EN+CN).
// ════════════════════════════════════════════════════════════════
let _vchData = [];        // last fetch of /vouchers
let _vchFilter = 'on';    // 'on' | 'off' | 'all'
let _vchQ = '';           // live search text
let _vchQTimer = null;
let _vchOpenId = null;    // coupon currently shown in the drawer

// "Running" = switched on AND not past its end date. Matches the server's
// own live check (checkout eligibility, revive-on-reuse).
function vchLive(v) {
  return !!v.is_active && !(v.expires_at && new Date(v.expires_at) <= new Date());
}
function vchGives(v) {
  if (v.type === 'free_shipping') return cuT('Free shipping', '免运费');
  if (v.type === 'percent') return cuT((Number(v.value) || 0) + '% off', (Number(v.value) || 0) + '% 折扣');
  return cuT('¥' + fmt(v.value) + ' off', '立减 ¥' + fmt(v.value));
}
function vchLabel(v) {
  return (typeof cuLang === 'function' && cuLang() === 'cn')
    ? (v.title_cn || v.title_en || '')
    : (v.title_en || v.title_cn || '');
}
function vchRules(v) {
  const parts = [];
  if (Number(v.min_subtotal) > 0) parts.push(cuT('Orders over ¥' + fmt(v.min_subtotal), '满 ¥' + fmt(v.min_subtotal)));
  const per = Number(v.per_customer_limit || 0);
  if (per === 1) parts.push(cuT('once each', '每人一次'));
  else if (per > 1) parts.push(cuT(per + ' each', '每人 ' + per + ' 次'));
  else parts.push(cuT('every order', '每人不限次'));
  if (v.max_uses != null) parts.push(cuT(v.max_uses + ' total', '共 ' + v.max_uses + ' 张'));
  return parts.length ? parts.join(cuT(' · ', '、')) : '—';
}
function vchEndsHtml(v) {
  if (!v.expires_at) return '<span class="vch-end">—</span>';
  const d = new Date(v.expires_at);
  const txt = formatDateOnly(v.expires_at);
  if (d <= new Date()) return '<span class="vch-end amber">' + cuT('Ended ', '已结束 ') + txt + '</span>';
  const soon = (d - Date.now()) < 7 * 864e5;   // ending inside a week = quiet amber
  return '<span class="vch-end' + (soon ? ' amber' : '') + '">' + txt + '</span>';
}
function vchPillsHtml(v) {
  const pills = [];
  // Dusk is scarce and means "the system does this for you" — auto-apply
  // is exactly that, so it is the one Dusk pill (breathing dot per canon).
  // Auto-apply follows the coupon's audience, so the pill has to say WHOSE
  // checkout it lands on — "Applied for them" alone read as "the people I chose"
  // on a coupon that was in fact discounting the whole store.
  if (v.auto_apply) {
    pills.push('<span class="vch-pill dusk"><span class="dot"></span>'
      // A signup coupon is grant-gated even when public — it lands only on the
      // new signups who received it, never store-wide. Reading "Applied for
      // everyone" on the welcome coupon is what made a missed grant look like a
      // broken discount.
      + (v.auto_grant_signup ? cuT('Applied for new signups', '新客自动抵扣')
         : v.is_public ? cuT('Applied for everyone', '全场自动抵扣')
         : cuT('Applied for chosen customers', '指定顾客自动抵扣'))
      + '</span>');
  }
  if (v.is_public) pills.push('<span class="vch-pill">' + cuT('In the app', '小程序可领') + '</span>');
  if (v.auto_grant_signup) pills.push('<span class="vch-pill">' + cuT('New signups', '新客自动发') + '</span>');
  // A standing coupon is never spent, so an M/N here would read 0/N forever.
  if (v.grant_count) {
    pills.push('<span class="vch-pill">' + cuT('Given ', '已发 ')
      + (Number(v.per_customer_limit || 0) !== 1 ? v.grant_count : (v.grant_used_count || 0) + '/' + v.grant_count)
      + '</span>');
  }
  return pills.length ? '<div class="vch-pills">' + pills.join('') + '</div>' : '';
}

async function loadVouchers() {
  try {
    const { data } = await api('/api/retail-admin/vouchers');
    _vchData = data || [];
    vchRender();
    // Keep an open drawer in step with fresh data (e.g. after a grant).
    const dw = document.getElementById('vch-drawer');
    if (_vchOpenId != null && dw && dw.classList.contains('open')) vchDrawerRender();
  } catch (e) {
    const tbody = $('#vouchers-table tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="err" style="padding: 14px;">' + cuT('Failed to load: ', '加载失败:') + escapeHtml(e.message) + '</td></tr>';
  }
}

function vchSetFilter(f) { _vchFilter = f; vchRender(); }
function vchSearchInput(val) {
  clearTimeout(_vchQTimer);
  _vchQTimer = setTimeout(() => { _vchQ = val; vchRender(); }, 150);
}

function vchRender() {
  const tbody = $('#vouchers-table tbody');
  if (!tbody) return;
  const q = _vchQ.trim().toLowerCase();
  const match = v => !q
    || String(v.code || '').toLowerCase().includes(q)
    || String(v.title_en || '').toLowerCase().includes(q)
    || String(v.title_cn || '').toLowerCase().includes(q);
  const on = _vchData.filter(v => vchLive(v) && match(v));
  const off = _vchData.filter(v => !vchLive(v) && match(v));

  // Segment — counts track the search so the numbers never lie.
  const seg = $('#vch-seg');
  if (seg) {
    const btn = (key, lab, n) => '<button type="button" class="vch-segbtn' + (_vchFilter === key ? ' on' : '') + '" onclick="vchSetFilter(\'' + key + '\')">' + lab + ' <span class="n">' + n + '</span></button>';
    seg.innerHTML = btn('on', cuT('Running', '生效中'), on.length)
      + btn('off', cuT('Off', '已停用'), off.length)
      + btn('all', cuT('All', '全部'), on.length + off.length);
  }

  const list = _vchFilter === 'on' ? on : _vchFilter === 'off' ? off : on.concat(off);
  if (!list.length) {
    const msg = _vchData.length
      ? (q ? cuT('Nothing matches.', '没有匹配的优惠券。') : cuT('Nothing here.', '这里没有优惠券。'))
      : cuT('No coupons yet. The button up top walks you through your first one.', '还没有优惠券。点右上角按钮,几步即可创建第一张。');
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">' + ICONS.empty + '</div><p class="muted" style="margin: 6px 0 0;">' + msg + '</p></div></td></tr>';
  } else {
    tbody.innerHTML = list.map(v => {
      const live = vchLive(v);
      const offPill = (!live && _vchFilter === 'all')
        ? '<span class="vch-pill">' + (v.is_active ? cuT('Ended', '已到期') : cuT('Off', '已停用')) + '</span>' : '';
      const label = vchLabel(v);
      const go = live || v.is_active
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>'
        : '<button type="button" class="btn btn-sm" onclick="vchTurn(' + v.id + ', 1)">' + cuT('Turn on', '开启') + '</button>';
      return '<tr class="vch-row' + (live ? '' : ' is-off') + '" data-id="' + v.id + '" onclick="vchRowClick(event, ' + v.id + ')">'
        + '<td><div class="vch-code">' + escapeHtml(v.code) + offPill + '</div>'
        + (label ? '<div class="vch-lbl">' + escapeHtml(label) + '</div>' : '')
        + '</td>'
        + '<td><div class="vch-gives">' + vchGives(v) + '</div>' + vchPillsHtml(v) + '</td>'
        + '<td class="vch-rules">' + vchRules(v) + '</td>'
        + '<td class="numeric vch-used">' + v.used_count + (v.max_uses != null ? ' / ' + v.max_uses : '') + '</td>'
        + '<td>' + vchEndsHtml(v) + '</td>'
        + '<td class="vch-go">' + go + '</td>'
        + '</tr>';
    }).join('');
  }

  // Under the Running view, one quiet line owns up to what's tucked away.
  const note = $('#vch-offnote');
  if (note) {
    note.innerHTML = (_vchFilter === 'on' && off.length)
      ? cuT(off.length + (off.length === 1 ? ' coupon is' : ' coupons are') + ' off — ', off.length + ' 张优惠券已停用 — ')
        + '<button type="button" onclick="vchSetFilter(\'off\')">' + cuT('view', '查看') + '</button>'
      : '';
  }
}

// Row click → drawer. Bail when the click landed on an interactive child
// (the Turn-on button) so it keeps working.
function vchRowClick(e, id) {
  if (e.target.closest('button, a, input, select, label')) return;
  vchOpen(id);
}
function vchOpen(id) {
  _vchOpenId = id;
  vchDrawerRender();
  openDrawer('#vch-drawer');
}
onDrawerClose('#vch-drawer', () => {
  _vchOpenId = null;
  const m = document.getElementById('vch-drawer-mount');
  if (m) m.innerHTML = '';
});

function vchDrawerRender() {
  const mount = document.getElementById('vch-drawer-mount');
  if (!mount) return;
  const v = _vchData.find(x => x.id === _vchOpenId);
  if (!v) { closeDrawer('#vch-drawer'); return; }
  const live = vchLive(v);
  const expired = !!(v.expires_at && new Date(v.expires_at) <= new Date());
  const status = live
    ? '<span class="vch-pill sage"><span class="dot"></span>' + cuT('Running', '生效中') + '</span>'
    : '<span class="vch-pill">' + (v.is_active ? cuT('Ended', '已到期') : cuT('Off', '已停用')) + '</span>';
  const sw = (field, on, title, desc, dusk) =>
    '<div class="vch-swrow">'
    + '<button type="button" class="vch-sw' + (on ? ' on' : '') + (dusk && on ? ' dusk' : '') + '" role="switch" aria-checked="' + !!on + '" onclick="vchToggle(' + v.id + ', \'' + field + '\', ' + (on ? 0 : 1) + ')"></button>'
    + '<div><div class="t">' + title + '</div><div class="d">' + desc + '</div></div>'
    + '</div>';
  const dateVal = v.expires_at ? String(v.expires_at).slice(0, 10) : '';
  // Per-customer ceiling, editable in place. 0 = no limit, which is what makes a
  // standing discount possible; keep whatever odd number the coupon already
  // carries in the list so opening the drawer can't silently change it.
  const perVal = Number(v.per_customer_limit || 0);
  const perLabel = n => n === 0 ? cuT('No limit', '不限')
    : n === 1 ? cuT('Once', '1 次') : cuT(n + ' times', n + ' 次');
  const perOpts = [1, 2, 3, 5, 10];
  if (perVal > 0 && !perOpts.includes(perVal)) perOpts.push(perVal);
  perOpts.sort((a, b) => a - b).push(0);
  // Wrapped so the chevron is drawn by ::after in currentColor — a bare <select>
  // paints its own native arrow on top of the label at this width.
  const perSel = '<span class="vch-perwrap"><select class="vch-per" onchange="vchSetPerLimit(' + v.id + ', this.value)">'
    + perOpts.map(n => '<option value="' + n + '"' + (n === perVal ? ' selected' : '') + '>' + perLabel(n) + '</option>').join('')
    + '</select></span>';
  // "Apply it for them" follows the coupon's audience, so the description has to
  // as well — on a private coupon it reaches only the people it was handed to.
  // A signup coupon is grant-gated even when it's public, so it reaches new
  // signups only — saying "every customer" there would promise a store-wide
  // discount the backend will never give.
  const autoDesc = v.auto_grant_signup
    ? cuT('New signups who received it get it at checkout — no code, no tap.', '收到的新顾客结账时自动抵扣,无需输入或点选。')
    : v.is_public
    ? cuT('Every customer gets it at checkout — no code, no tap.', '每位顾客结账时自动抵扣,无需输入或点选。')
    : cuT('Only the customers you give it to get it at checkout — no code, no tap.', '仅发放到的顾客结账时自动抵扣,无需输入或点选。');
  // A standing coupon is never "spent", so a used-count off the hand-outs would
  // read 0 forever. Say what they actually get instead.
  const standing = perVal !== 1;
  const grantLine = v.grant_count
    ? (standing
        ? cuT('Given to ' + v.grant_count + (v.grant_count === 1 ? ' customer' : ' customers') + ' — they keep it, '
              + (perVal === 0 ? 'with no limit on how many orders' : 'for up to ' + perVal + ' orders') + '.',
              '已发放给 ' + v.grant_count + ' 位顾客 — 可长期使用,'
              + (perVal === 0 ? '不限订单数' : '最多 ' + perVal + ' 单') + '。')
        : cuT('Given to ' + v.grant_count + (v.grant_count === 1 ? ' customer' : ' customers') + ' — '
              + (v.grant_used_count || 0) + ' of those have used it.',
              '已发放给 ' + v.grant_count + ' 位顾客,' + (v.grant_used_count || 0) + ' 张已使用。'))
    : cuT('Hand it to specific customers — it lands in their coupons, no code needed.', '发给指定顾客,直接进入他们的优惠券,无需编码。');
  mount.innerHTML =
    '<div class="vch-dw-head"><span class="vch-dw-code">' + escapeHtml(v.code) + '</span>' + status + '</div>'
    + (expired && v.is_active ? '<div class="vch-note amber">' + cuT('This coupon ended. Set a new end date below to run it again.', '优惠券已到期。在下方设置新的截止日期即可重新生效。') + '</div>' : '')
    + '<div class="vch-facts">'
    + '<div class="vch-fact"><span class="k">' + cuT('Gives', '优惠') + '</span><span class="v">' + vchGives(v) + '</span></div>'
    + '<div class="vch-fact"><span class="k">' + cuT('On orders over', '最低订单金额') + '</span><span class="v">' + (Number(v.min_subtotal) > 0 ? '¥' + fmt(v.min_subtotal) : cuT('Any order', '无门槛')) + '</span></div>'
    + '<div class="vch-fact"><span class="k">' + cuT('Used', '已使用') + '</span><span class="v">' + v.used_count + (v.max_uses != null ? ' / ' + v.max_uses : '') + '</span></div>'
    + '<div class="vch-fact"><span class="k">' + cuT('Per customer', '每人限用') + '</span><span class="v">' + perSel + '</span></div>'
    + '<div class="vch-fact"><span class="k">' + cuT('Ends', '截止') + '</span><span class="v"><input type="date" class="vch-date" value="' + dateVal + '" onchange="vchSetExpiry(' + v.id + ', this.value)"></span></div>'
    + '</div>'
    + '<div class="vch-kicker">' + cuT('How customers get it', '顾客怎么获得') + '</div>'
    + sw('is_public', !!v.is_public,
        cuT('Show in the app', '在小程序展示'),
        cuT('Anyone can find it and tap to save — no code needed.', '顾客可自行领取,无需输入编码。'))
    + sw('auto_grant_signup', !!v.auto_grant_signup,
        cuT('Give to new signups', '发给新注册顾客'),
        cuT('Lands in every new customer’s coupons automatically.', '自动进入每位新顾客的优惠券。'))
    + sw('auto_apply', !!v.auto_apply,
        cuT('Apply it for them', '自动抵扣'), autoDesc, true)
    + '<div class="vch-kicker">' + cuT('What customers see', '顾客看到的文字') + '</div>'
    + (v.is_public && !(v.title_en || v.title_cn) ? '<div class="vch-note amber" style="margin: 0 0 8px;">' + cuT('Public coupons need a label customers can read.', '公开优惠券需要顾客能看懂的标签。') + '</div>' : '')
    + '<div class="vch-labels">'
    + '<input type="text" id="vch-lbl-en" value="' + escapeAttr(v.title_en || '') + '" placeholder="' + escapeAttr(cuT('English — e.g. ¥20 off your first order', '英文标签')) + '">'
    + '<input type="text" id="vch-lbl-cn" value="' + escapeAttr(v.title_cn || '') + '" placeholder="' + escapeAttr(cuT('Chinese — e.g. 首单立减 ¥20', '中文标签,如 首单立减 ¥20')) + '">'
    + '<button type="button" class="btn btn-sm" onclick="vchSaveLabel(' + v.id + ')">' + cuT('Save label', '保存标签') + '</button>'
    + '</div>'
    + '<div class="vch-kicker">' + cuT('Give it out', '发放') + '</div>'
    + '<div class="vch-grants">'
    + '<span class="d">' + grantLine + '</span>'
    + '<button type="button" class="btn btn-sm" onclick=\'openGrantModal(' + v.id + ', ' + JSON.stringify(String(v.code)) + ')\'>' + cuT('Give to a customer', '发放给顾客') + '</button>'
    + '</div>'
    // Who actually holds it. "Given to 2 customers" answers how many but not who,
    // and the names were buried behind a button that reads as "add someone".
    + '<div class="vch-holders" id="vch-holders"></div>'
    + '<div class="vch-dw-foot">'
    + (v.is_active
        ? '<button type="button" class="btn vch-off-btn" onclick="vchTurn(' + v.id + ', 0)">' + cuT('Turn off', '停用') + '</button>'
        : '<button type="button" class="btn btn-primary" onclick="vchTurn(' + v.id + ', 1)">' + cuT('Turn on', '开启') + '</button>')
    + '<span class="d">' + cuT('Turning it off keeps its history.', '停用会保留历史记录,可随时重新开启。') + '</span>'
    + '</div>';
  if (v.grant_count) vchLoadHolders(v.id, v.grant_count);
}

// Fill the drawer's holder list. Only ever a short head of the list — a
// grant-to-all can run to thousands, so anything past HEAD is left to the modal.
const VCH_HOLDER_HEAD = 8;
async function vchLoadHolders(id, count) {
  const mount = document.getElementById('vch-holders');
  if (!mount) return;
  mount.innerHTML = '<div class="vch-holder muted">' + cuT('Loading…', '加载中…') + '</div>';
  try {
    const { data, total } = await api('/api/retail-admin/vouchers/' + id + '/grants?limit=' + VCH_HOLDER_HEAD);
    // The drawer may have been closed or switched coupons mid-flight.
    if (_vchOpenId !== id || !document.getElementById('vch-holders')) return;
    const n = total != null ? total : (count || data.length);
    if (!data.length) { mount.innerHTML = ''; return; }
    const rows = data.map(g =>
      '<div class="vch-holder">'
      + '<button type="button" class="go" onclick="vchGotoCustomer(' + g.customer_id + ')"'
      +   ' title="' + escapeAttr(cuT('Open this customer', '查看该顾客')) + '">'
      +   '<span class="who">' + escapeHtml(g.nickname || cuT('(no name)', '(未填写昵称)')) + '</span>'
      +   '<span class="ph">' + escapeHtml(g.phone || '—') + '</span>'
      + '</button>'
      + '<button type="button" class="lnk" onclick="vchTakeBack(' + g.id + ')">' + cuT('Take it back', '收回') + '</button>'
      + '</div>').join('');
    const more = n > data.length
      ? '<button type="button" class="lnk more" onclick=\'openGrantModal(' + id + ', '
        + JSON.stringify(String((_vchData.find(x => x.id === id) || {}).code || '')) + ')\'>'
        + cuT('See all ' + n, '查看全部 ' + n) + '</button>'
      : '';
    mount.innerHTML = rows + more;
  } catch (e) {
    mount.innerHTML = '<div class="vch-holder err">' + cuT('Couldn’t load who has it: ', '无法加载持有名单:') + escapeHtml(e.message) + '</div>';
  }
}

// Jump from a holder row to that customer's detail. Same shape as
// orderGotoCustomer: close this drawer first rather than switching tabs, so the
// two side-drawers don't stack and the tab-click drawer purge can't eat it.
function vchGotoCustomer(id) {
  if (!id) return;
  closeDrawer('#vch-drawer');
  cuOpenDetail(Number(id));
}

// Take the coupon off one customer, straight from the drawer.
async function vchTakeBack(grantId) {
  if (!(await askConfirm({
    title: cuT('Take this coupon back?', '收回这张优惠券?'),
    body: cuT('They lose it at their next checkout. Orders they already placed keep their discount.',
              '该顾客下次结账将不再享有。已下单的订单不受影响。'),
    confirmLabel: cuT('Take it back', '收回'), danger: true,
  }))) return;
  try {
    await api('/api/retail-admin/voucher-grants/' + grantId, { method: 'DELETE' });
    toast(cuT('Taken back', '已收回'));
    await loadVouchers();
  } catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
}

async function vchPatch(id, body) {
  await api('/api/retail-admin/vouchers/' + id, { method: 'PATCH', body });
  await loadVouchers();
}
async function vchToggle(id, field, value) {
  try { await vchPatch(id, { [field]: !!value }); }
  catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
}
async function vchSetExpiry(id, value) {
  try {
    await vchPatch(id, { expires_at: value || null });
    toast(value ? cuT('End date set', '已更新截止日期') : cuT('No end date — runs until turned off', '已改为无截止日期'));
  } catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
}
async function vchSetPerLimit(id, value) {
  const n = parseInt(value, 10) || 0;
  const v = _vchData.find(x => x.id === id);
  // Moving off "once each" turns every hand-out into a standing one — including
  // hand-outs a customer already spent, which come back to life. That's a real
  // discount handed back to real people, so never let it happen silently.
  const revived = (v && n !== 1) ? Number(v.grant_used_count || 0) : 0;
  if (revived > 0) {
    const ok = await askConfirm({
      title: cuT('Give it back to customers who already used it?', '让已使用过的顾客重新获得?'),
      body: cuT(revived + (revived === 1 ? ' customer has' : ' customers have')
                + ' already used this coupon. They get it back and can use it again.',
                '已有 ' + revived + ' 位顾客使用过这张优惠券。他们会重新获得,并可再次使用。'),
      confirmLabel: cuT('Yes, let them use it again', '确认'),
    });
    // Cancelled — redraw so the select snaps back to what's actually stored.
    if (!ok) { vchDrawerRender(); return; }
  }
  try {
    await vchPatch(id, { per_customer_limit: n });
    toast(n === 0 ? cuT('No limit — each customer can use it on every order', '已改为不限次数')
        : n === 1 ? cuT('Once per customer', '每人限用 1 次')
        : cuT('Up to ' + n + ' orders per customer', '每人最多 ' + n + ' 次'));
  } catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
}
async function vchSaveLabel(id) {
  const en = $('#vch-lbl-en'), cn = $('#vch-lbl-cn');
  try {
    await vchPatch(id, { title_en: (en && en.value.trim()) || null, title_cn: (cn && cn.value.trim()) || null });
    toast(cuT('Label saved', '标签已保存'));
  } catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
}
async function vchTurn(id, on) {
  const v = _vchData.find(x => x.id === id);
  // Turning on a coupon that's past its end date would leave it dead anyway —
  // open it and point at the date instead of pretending the switch worked.
  if (on && v && v.expires_at && new Date(v.expires_at) <= new Date()) {
    if (_vchOpenId !== id) vchOpen(id);
    toast(cuT('It already ended — set a new end date first', '优惠券已到期 — 请先设置新的截止日期'), 'err');
    return;
  }
  try {
    await vchPatch(id, { is_active: !!on });
    toast(on ? cuT('On — customers can use it now', '已开启') : cuT('Turned off', '已停用'));
  } catch (e) { toast(cuT('Failed: ', '失败:') + e.message, 'err'); }
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
      mount.innerHTML = `<div class="err" style="padding: 12px; font-size: 12px;">${cuT('Failed', '失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
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
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
  }
}

async function grantToAll() {
  if (!_grantVoucherId) return;
  if (!(await askConfirm({ title: 'Grant this coupon to every customer? · 向所有顾客发放此优惠券?', body: 'Existing grants are kept. · 已有发放记录会保留。', confirmLabel: 'Grant to all · 全部发放' }))) return;
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
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
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
    // A standing coupon (per customer ≠ once) is never stamped used, so
    // Used/Unused would read "Unused" forever no matter how often they redeem
    // it. Say the coupon is theirs instead, and keep Revoke available.
    // Fall back to one-shot when the coupon isn't in _vchData (a failed
    // loadVouchers swallows its own error) — the stricter label is the safe
    // guess, since it never offers a Revoke the server will refuse.
    const gv = _vchData.find(x => x.id === _grantVoucherId);
    const standing = !!gv && Number(gv.per_customer_limit || 0) !== 1;
    mount.innerHTML = data.map(g => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 12px;">
        <div style="min-width: 0;">
          <span style="font-weight: 600;">${escapeHtml(g.nickname || '(no name)')}</span>
          <span class="muted">#${g.customer_id} · ${escapeHtml(g.phone || '—')}</span>
          ${standing
            ? '<span class="pill pub" style="margin-left: 8px; font-size: 10px;">' + cuT('Has it', '已拥有') + '</span>'
            : g.used_at
              ? '<span class="pill pub" style="margin-left: 8px; font-size: 10px;">' + cuT('Used', '已使用') + '</span>'
              : '<span class="pill draft" style="margin-left: 8px; font-size: 10px;">' + cuT('Unused', '未使用') + '</span>'}
        </div>
        ${!standing && g.used_at
          ? ''
          : `<button class="btn btn-sm" onclick="revokeGrant(${g.id})">${cuT('Revoke', '撤销')}</button>`}
      </div>`).join('');
  } catch (e) {
    mount.innerHTML = `<div class="err" style="padding: 8px 0; font-size: 12px;">${cuT('Failed', '失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

async function revokeGrant(grantId) {
  if (!(await askConfirm({ title: 'Revoke this grant? · 撤销此优惠券?', confirmLabel: 'Revoke · 撤销', danger: true }))) return;
  try {
    await api('/api/retail-admin/voucher-grants/' + grantId, { method: 'DELETE' });
    await loadGrantedList();
    await loadVouchers();
  } catch (e) {
    toast(cuT('Failed', '失败') + ': ' + (e.message === 'already_used_or_missing' ? cuT('Already used or missing', '已使用或不存在') : e.message), 'err');
  }
}

// ════════════════════════════════════════════════════════════════
// GUIDED COUPON WIZARD — a plain-language, draft-first front door to
// coupon creation. Two-pane flow: the question on the left, a live
// customer's-eye ticket + heads-up on the right, on every step.
//   door → deal → small print → turn it on     (ready-made paths)
//   door → deal → who → small print → turn it on   (Start fresh only)
// A ready-made door pre-answers "who gets it" (shown as one editable
// line on the deal step); the who step only appears for Start fresh or
// when the operator taps "Change". "who" maps to is_public /
// auto_grant_signup / auto_apply; the heads-up reads the live coupons
// and explains clashes & overlaps from the very first step; everything
// saves through the existing POST endpoint (is_active:false = draft).
// Copy is bilingual + deliberately simple for non-native-English
// operators. See feature_voucher_wizard (memory).
// ════════════════════════════════════════════════════════════════
let _vw = null;          // the coupon being built (wizard state)
let _vwVouchers = [];     // snapshot of existing coupons, for the heads-up

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

// The steps that make up the flow. Ready-made doors pre-answer "who gets it",
// so that step is hidden unless the operator started fresh OR tapped "Change".
function vwSteps() { return _vw.showWho ? ['deal', 'who', 'rules', 'review'] : ['deal', 'rules', 'review']; }
const VW_TITLES = {
  front:  'Make a coupon · 新建优惠券',
  deal:   'The deal · 优惠内容',
  who:    'Who gets it · 谁可以用',
  rules:  'The small print · 使用规则',
  review: 'Turn it on · 开启优惠券',
};
const VW_GOAL_KICK = {
  welcome: 'Welcome gift · 新人礼',
  sale: 'Store sale · 店铺促销',
  public: 'Anyone can use · 人人可领',
  shipping: 'Free shipping · 免运费',
  fresh: 'Start fresh · 从头开始',
};

async function vwOpen() {
  _vw = {
    goal: null, step: 'front', showWho: false,
    type: 'fixed_amount', value: 20,
    path: 'public', showOnHome: false,
    min: 0, setMin: false, expires: '', endChip: 'none',
    perCust: 1, maxUses: '', setMax: false,
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
// In-step re-renders (vwSetType/vwPickAmt…) call vwRender() directly, so only
// Next/Back/door-pick animate. Respects prefers-reduced-motion.
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

// Preset state from a chosen door, then drop into the first step. A ready-made
// door also answers "who gets it"; only "fresh" surfaces that as its own step.
function vwApplyGoal(goal) {
  _vw.goal = goal;
  if (goal === 'welcome')       Object.assign(_vw, { type: 'fixed_amount', value: 20, path: 'welcome', showOnHome: true });
  else if (goal === 'sale')     Object.assign(_vw, { type: 'percent', value: 10, path: 'auto', showOnHome: false });
  else if (goal === 'public')   Object.assign(_vw, { type: 'fixed_amount', value: 10, path: 'public', showOnHome: false });
  else if (goal === 'shipping') Object.assign(_vw, { type: 'free_shipping', value: 0, path: 'auto', showOnHome: false });
  else                          Object.assign(_vw, { type: 'fixed_amount', value: 0, path: 'public', showOnHome: false }); // fresh
  _vw.showWho = (goal === 'fresh');
  _vw.codeEdited = false; _vw.labelEdited = false;
  _vw.min = 0; _vw.setMin = false; _vw.expires = ''; _vw.endChip = 'none'; _vw.perCust = 1; _vw.maxUses = ''; _vw.setMax = false;
  vwGoto('deal');
}

// ── navigation ──
function vwNext() {
  const steps = vwSteps();
  const next = steps[steps.indexOf(_vw.step) + 1];
  if (!next) return;
  if (_vw.step === 'deal'  && !vwCommitDeal())  return;
  if (_vw.step === 'rules' && !vwCommitRules()) return;
  if (next === 'review') vwPrepReview();
  vwGoto(next);
}
function vwBack() {
  const steps = vwSteps();
  const i = steps.indexOf(_vw.step);
  if (i <= 0) { vwGoto('front'); return; }
  vwGoto(steps[i - 1]);
}

// ── small derived bits ──
function vwBigValue() {
  if (_vw.type === 'free_shipping') return 'FREE';
  if (_vw.type === 'percent') return (Number(_vw.value) || 0) + '%';
  return '¥' + (Number(_vw.value) || 0);
}
function vwBigUnit() { return _vw.type === 'free_shipping' ? 'shipping · 免运' : 'off · 立减'; }
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

// ── the living ticket (right pane) ──
function vwCondPlain() {
  const min = Number(_vw.min) || 0;
  if (_vw.path === 'welcome') return min > 0 ? ('first order over ¥' + min + ' · 首单满 ¥' + min) : 'their first order · 首单';
  return min > 0 ? ('orders ¥' + min + '+ · 满 ¥' + min) : 'any order · 任意订单';
}
function vwTicketWho() {
  const who = _vw.path === 'welcome' ? 'New customers · 新顾客'
            : _vw.path === 'auto'    ? 'Automatic · 自动应用'
            : _vw.path === 'pick'    ? 'Customers you pick · 指定顾客'
            : 'Anyone · 人人可用';
  const per = Number(_vw.perCust) > 1 ? (' · ' + Number(_vw.perCust) + '× each · 每人 ' + Number(_vw.perCust) + ' 次') : ' · once each · 每人一次';
  const end = _vw.expires ? (' · ends ' + _vw.expires + ' · 至 ' + _vw.expires) : ' · no end date · 永久';
  return '<b>' + escapeHtml(who) + '</b>' + escapeHtml(per) + escapeHtml(end);
}
function vwTicketHtml(opts) {
  opts = opts || {};
  // The big number already shows the value; only echo the marketing label when
  // the operator has actually written one (never repeat "5% off" twice).
  const label = (_vw.labelEdited && (_vw.title_en || _vw.title_cn))
    ? '<div class="vw-tk-ttl">' + escapeHtml(_vw.title_en || _vw.title_cn) + '</div>' : '';
  const code = (opts.showCode && _vw.code) ? '<span class="vw-codechip">' + escapeHtml(_vw.code) + '</span>' : '';
  return '<div class="vw-ticket">'
    + '<div class="vw-tk-big">' + vwBigValue() + ' <small>' + vwBigUnit() + '</small></div>'
    + '<div class="vw-tk-cond">' + vwCondPlain() + '</div>'
    + label
    + '<div class="vw-tear"></div>'
    + '<div class="vw-tk-who">' + vwTicketWho() + '</div>'
    + code + '</div>';
}
// Re-render only the right pane (ticket + heads-up) so typing in a left-pane
// field never loses focus.
function vwRefreshTicket() {
  const p = document.querySelector('.vw-ticketpane');
  if (!p) return;
  p.innerHTML = '<div class="vw-tick-cap">What the customer sees · 顾客看到的</div>'
    + vwTicketHtml({ showCode: _vw.step === 'review' }) + vwHeadsUpHtml();
}

// ── render ──
function vwRender() {
  const title = $('#vw-title'), kick = $('#vw-kick'), body = $('#vw-body'), foot = $('#vw-foot');
  const s = _vw.step;
  title.textContent = VW_TITLES[s] || VW_TITLES.front;
  if (kick) kick.textContent = _vw.goal ? ('NEW COUPON · ' + VW_GOAL_KICK[_vw.goal]) : 'NEW COUPON · 新建优惠券';
  foot.style.display = (s === 'front') ? 'none' : 'flex';
  if (s === 'front') { body.innerHTML = vwFrontHtml(); return; }
  if (s === 'deal')        body.innerHTML = vwPanes(vwDealHtml());
  else if (s === 'who')    body.innerHTML = vwPanes(vwWhoHtml());
  else if (s === 'rules')  body.innerHTML = vwPanes(vwRulesHtml());
  else if (s === 'review') body.innerHTML = vwPanes(vwReviewHtml(), { review: true });
  foot.innerHTML = vwFootHtml();
}
function vwPanes(leftHtml, opts) {
  opts = opts || {};
  return '<div class="vw-panes"><div class="vw-left">' + leftHtml + '</div>'
    + '<div class="vw-ticketpane"><div class="vw-tick-cap">What the customer sees · 顾客看到的</div>'
    + vwTicketHtml({ showCode: !!opts.review }) + vwHeadsUpHtml() + '</div></div>';
}
function vwFootHtml() {
  const steps = vwSteps();
  const dots = '<div class="vw-dots">' + steps.map(s => '<span class="vw-dot' + (s === _vw.step ? ' on' : '') + '"></span>').join('') + '</div>';
  const back = '<button class="btn" onclick="vwBack()">Back · 返回</button>';
  if (_vw.step === 'review') {
    return back + dots
      + '<span style="display:flex; gap:8px;">'
      + '<button class="btn" onclick="vwSave(false)">Save as draft · 存为草稿</button>'
      + '<button class="btn vw-cta" onclick="vwSave(true)">Turn it on · 开启</button></span>';
  }
  return back + dots + '<button class="btn" onclick="vwNext()">Next · 下一步</button>';
}

// ── screen 1: the door ──
function vwFrontHtml() {
  const goals = [
    ['welcome', 'gift', 'Welcome gift · 新人礼', 'Lands in every new customer\'s coupons. · 自动进入新顾客账户。', '¥20 off · 立减', 'their first order · 首单'],
    ['sale', 'tag', 'Store sale · 店铺促销', 'Applied for them at checkout — no code. · 结账自动,无需编码。', '10% off · 折扣', 'everything · 全场'],
    ['public', 'ticket', 'A coupon anyone can use · 人人可领', 'Shows in the app; people tap to save. · 顾客自行领取。', '¥10 off · 立减', 'any order · 任意订单'],
    ['shipping', 'truck', 'Free shipping · 免运费', 'Take the delivery fee off. · 减免运费。', '¥0 delivery · 免运', 'every order · 每单'],
  ];
  const cards = goals.map(g => '<button class="vw-door" onclick="vwApplyGoal(\'' + g[0] + '\')">'
    + '<span class="vico">' + vwIcon(g[1], 24) + '</span>'
    + '<span class="vw-door-txt"><span class="dt">' + g[2] + '</span><span class="ds">' + g[3] + '</span></span>'
    + '<span class="vw-preset"><b>' + g[4] + '</b>' + g[5] + '</span></button>').join('');
  const fresh = '<button class="vw-door fresh" onclick="vwApplyGoal(\'fresh\')">'
    + '<span class="vico">' + vwIcon('pencil', 20) + '</span>'
    + '<span class="vw-door-txt"><span class="dt">Start fresh · 从头开始</span><span class="ds">Answer every question yourself. · 全部自己设置。</span></span></button>';
  return '<div class="vw-lab" style="margin-bottom:2px;">What do you want to do? · 你想做什么?</div>'
    + '<div class="vw-doors">' + cards + fresh + '</div>'
    + '<div class="vw-help" style="margin-top:14px;">Every choice is a starting point — change anything on the next screens. · 都是起点,后面都能改。</div>';
}

// ── screen 2: the deal ──
function vwWhoIcon() { return _vw.path === 'welcome' ? 'gift' : _vw.path === 'auto' ? 'bolt' : _vw.path === 'pick' ? 'users' : 'ticket'; }
function vwWhoPlain() {
  if (_vw.path === 'welcome') return '<b>New customers · 新顾客</b> get it automatically when they join. · 加入时自动获得。';
  if (_vw.path === 'auto')    return '<b>Applied for everyone · 自动应用</b> at checkout — no code needed. · 结账自动,无需编码。';
  if (_vw.path === 'pick')    return '<b>Customers you pick · 你指定的顾客</b> — chosen after saving. · 保存后由你挑选。';
  return '<b>Anyone · 人人可用</b> can find it in the app and tap to save. · 在小程序内自行领取。';
}
function vwDealHtml() {
  const types = [
    ['fixed_amount', 'coin', 'Money off · 立减', 'a set ¥ amount · 固定金额'],
    ['percent', 'percent', 'Percent off · 折扣', 'a % of the order · 按比例'],
    ['free_shipping', 'truck', 'Free shipping · 免运费', 'no delivery fee · 不收运费'],
  ];
  const cards = types.map(t => '<div class="vw-type' + (_vw.type === t[0] ? ' on' : '') + '" onclick="vwSetType(\'' + t[0] + '\')">'
    + '<span class="vico">' + vwIcon(t[1], 26) + '</span><div class="tt">' + t[2] + '</div><div class="ts">' + t[3] + '</div></div>').join('');
  let amt = '';
  if (_vw.type !== 'free_shipping') {
    const unit = _vw.type === 'percent' ? '%' : '¥';
    const presets = _vw.type === 'percent' ? [5, 10, 20] : [10, 20, 50];
    const chips = presets.map(p => '<button class="vw-chip' + (Number(_vw.value) === p ? ' on' : '') + '" onclick="vwPickAmt(' + p + ')">' + p + '</button>').join('');
    amt = '<div class="vw-lab" style="margin-top:22px;">How much do they save? · 优惠多少?</div>'
      + '<div class="vw-amount"><span class="vw-amt-box"><span class="unit">' + unit + '</span>'
      + '<input id="vw-value" type="text" inputmode="numeric" value="' + escapeAttr(String(_vw.value || '')) + '" oninput="vwLiveValue(this.value)"></span>'
      + '<span class="vw-chips" id="vw-amt-chips">' + chips + '</span></div>';
  }
  let answered = '';
  if (!_vw.showWho) {
    answered = '<div class="vw-answered"><span class="vico">' + vwIcon(vwWhoIcon(), 18) + '</span>'
      + '<span>' + vwWhoPlain() + '</span>'
      + '<button class="btn btn-ghost vw-chg" onclick="vwChangeWho()">Change · 更改</button></div>';
  }
  return '<div class="vw-lab">What kind of discount? · 哪种优惠?</div>'
    + '<div class="vw-kinds">' + cards + '</div>' + amt + answered;
}
function vwSetType(t) {
  _vw.type = t;
  if (t === 'free_shipping') _vw.value = 0;
  else if (!(Number(_vw.value) > 0)) _vw.value = (t === 'percent' ? 10 : 20);
  vwRender();
}
function vwPickAmt(v) { _vw.value = v; vwRender(); }
function vwLiveValue(v) {
  _vw.value = v;
  vwRefreshTicket();
  document.querySelectorAll('#vw-amt-chips .vw-chip').forEach(c => c.classList.toggle('on', Number(c.textContent) === Number(v)));
}
function vwChangeWho() { _vw.showWho = true; vwGoto('who'); }

// ── who gets it (fresh path, or via "Change") ──
function vwWhoHtml() {
  const paths = [
    ['auto', 'bolt', 'Applied for everyone · 自动应用', 'At checkout the best deal is applied. No code. · 结账自动取最优,无需编码。'],
    ['public', 'ticket', 'Anyone can use it · 人人可用', 'Shows in the app; a shared code also works. · 显示在小程序,分享码也能用。'],
    ['welcome', 'gift', 'A welcome gift · 新人礼', 'Lands in every new customer\'s coupons. · 自动进入新顾客账户。'],
    ['pick', 'users', 'I choose who gets it · 我来指定', 'Pick the customers after saving. · 保存后挑选顾客。'],
  ];
  let html = '<div class="vw-lab">How do customers get it? · 顾客怎么获得?</div>'
    + '<div class="vw-paths">'
    + paths.map(p => '<div class="vw-path' + (_vw.path === p[0] ? ' on' : '') + '" onclick="vwSetPath(\'' + p[0] + '\')">'
        + '<span class="vico">' + vwIcon(p[1], 22) + '</span><span><span class="pt">' + p[2] + '</span><br><span class="ps">' + p[3] + '</span></span>'
        + '<span class="vw-radio"></span></div>').join('')
    + '</div>';
  if (_vw.path === 'welcome') {
    html += '<div class="vw-homerow"><span>Also show it on the home page? · 也在首页展示?</span>'
      + '<span style="display:flex;gap:6px;">'
      + '<button class="btn' + (!_vw.showOnHome ? ' vw-seg-on' : '') + '" onclick="vwSetHome(false)">No · 否</button>'
      + '<button class="btn' + (_vw.showOnHome ? ' vw-seg-on' : '') + '" onclick="vwSetHome(true)">Yes · 是</button></span></div>';
  }
  return html;
}
function vwSetPath(p) { _vw.path = p; vwRender(); }
function vwSetHome(b) { _vw.showOnHome = b; vwRender(); }

// ── screen 3: the small print (plain sentences, good defaults) ──
function vwEndPlain() {
  if (_vw.endChip === 'none') return 'Runs <b>until you turn it off</b>. · 一直有效,直到你停用。';
  if (_vw.endChip === '1w')   return 'Ends in <b>one week</b>. · 一周后结束。';
  if (_vw.endChip === '1m')   return 'Ends in <b>one month</b>. · 一月后结束。';
  return _vw.expires ? ('Ends <b>' + escapeHtml(_vw.expires) + '</b>. · 到期结束。') : 'Pick the last day it works. · 选择截止日期。';
}
function vwRulesHtml() {
  const minRow = _vw.setMin
    ? '<div class="vw-sent"><div class="row"><span class="txt">Works on orders ¥<input id="vw-min" class="vw-inl" type="text" inputmode="numeric" value="' + escapeAttr(String(_vw.min || '')) + '" oninput="vwLiveMin(this.value)"> and up. · 满额可用。</span>'
      + '<button class="btn btn-ghost vw-chg" onclick="vwUnsetMin()">Any order · 任意</button></div></div>'
    : '<div class="vw-sent"><div class="row"><span class="txt">Works on <b>any order size</b>. · 任意订单金额可用。</span>'
      + '<button class="btn btn-ghost vw-chg" onclick="vwSetMinOn()">Set a minimum · 设最低金额</button></div></div>';

  const endChips = [['none', 'No end date · 永久'], ['1w', 'One week · 一周'], ['1m', 'One month · 一月'], ['pick', 'Pick a day · 选日期']];
  const chips = endChips.map(c => '<button class="vw-chip' + (_vw.endChip === c[0] ? ' on' : '') + '" onclick="vwPickEnd(\'' + c[0] + '\')">' + c[1] + '</button>').join('');
  const pick = _vw.endChip === 'pick'
    ? '<input id="vw-expires" class="vw-date" type="date" value="' + escapeAttr(_vw.expires || '') + '" oninput="vwLiveDate(this.value)">' : '';
  const endRow = '<div class="vw-sent"><div class="row"><span class="txt">' + vwEndPlain() + '</span></div>'
    + '<div class="editrow"><span class="vw-chips">' + chips + '</span>' + pick + '</div></div>';

  const pc = Number(_vw.perCust) || 1;
  const pcRow = '<div class="vw-sent"><div class="row"><span class="txt">Each customer can use it <b>' + (pc === 1 ? 'once · 一次' : pc + ' times · ' + pc + ' 次') + '</b>.</span>'
    + '<span class="vw-stepper vw-chg"><button onclick="vwStep(-1)">−</button><span class="n num">' + pc + '</span><button onclick="vwStep(1)">+</button></span></div></div>';

  const maxRow = _vw.setMax
    ? '<div class="vw-sent"><div class="row"><span class="txt">Only <input id="vw-maxuses" class="vw-inl" type="text" inputmode="numeric" value="' + escapeAttr(String(_vw.maxUses || '')) + '" oninput="vwLiveMax(this.value)"> can be used in total. · 总数上限。</span>'
      + '<button class="btn btn-ghost vw-chg" onclick="vwUnsetMax()">No limit · 不限</button></div></div>'
    : '<div class="vw-sent"><div class="row"><span class="txt"><b>No limit</b> on total uses. · 总数不限。</span>'
      + '<button class="btn btn-ghost vw-chg" onclick="vwSetMaxOn()">Set a limit · 设上限</button></div></div>';

  return '<div class="vw-help" style="margin-bottom:6px;">Good defaults are set. Change only what you want. · 已有合适的默认值,只改你想改的。</div>'
    + minRow + endRow + pcRow + maxRow;
}
function vwDateFrom(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function vwPickEnd(k) {
  _vw.endChip = k;
  if (k === 'none') _vw.expires = '';
  else if (k === '1w') _vw.expires = vwDateFrom(7);
  else if (k === '1m') _vw.expires = vwDateFrom(30);
  else _vw.expires = _vw.expires || vwDateFrom(30);
  vwRender();
}
function vwLiveDate(v) { _vw.expires = v; vwRefreshTicket(); }
function vwStep(d) { _vw.perCust = Math.max(1, (Number(_vw.perCust) || 1) + d); vwRender(); }
function vwSetMinOn() { _vw.setMin = true; if (!(Number(_vw.min) > 0)) _vw.min = ''; vwRender(); }
function vwUnsetMin() { _vw.setMin = false; _vw.min = 0; vwRender(); }
function vwLiveMin(v) { _vw.min = Number(v) || 0; vwRefreshTicket(); }
function vwSetMaxOn() { _vw.setMax = true; vwRender(); }
function vwUnsetMax() { _vw.setMax = false; _vw.maxUses = ''; vwRender(); }
function vwLiveMax(v) { _vw.maxUses = v; vwRefreshTicket(); }

// ── commit + validate on the way forward ──
function vwCommitDeal() {
  if (_vw.type !== 'free_shipping') {
    const el = $('#vw-value'); if (el) _vw.value = el.value;
    const v = Number(_vw.value);
    if (!(v > 0)) { toast('Enter how much they save · 请填写优惠金额', 'err'); return false; }
    if (_vw.type === 'percent' && v > 100) { toast('Percent can be at most 100 · 折扣最多 100%', 'err'); return false; }
  }
  return true;
}
function vwCommitRules() {
  if (_vw.setMin) { const el = $('#vw-min'); if (el) _vw.min = Number(el.value) || 0; } else _vw.min = 0;
  if (_vw.setMax) { const el = $('#vw-maxuses'); if (el) _vw.maxUses = el.value; } else _vw.maxUses = '';
  if (_vw.endChip === 'pick') { const el = $('#vw-expires'); if (el) _vw.expires = el.value || ''; }
  if (_vw.expires) {
    const d = new Date(_vw.expires + 'T23:59:59');
    if (d < new Date()) { toast('That end date has passed — pick a later one · 到期日已过,请选更晚的日期', 'err'); return false; }
  }
  return true;
}
function vwPrepReview() {
  if (!_vw.codeEdited || !_vw.code) _vw.code = vwGenCode();
  if (!_vw.labelEdited) { _vw.title_en = vwGenLabelEn(); _vw.title_cn = vwGenLabelCn(); }
}

// ── screen 4: turn it on ──
function vwRecapSentence() {
  const val = vwBigValue() + (_vw.type === 'free_shipping' ? '' : ' off');
  const who = _vw.path === 'welcome' ? 'New customers · 新顾客'
            : _vw.path === 'auto'    ? 'Everyone · 所有人'
            : _vw.path === 'pick'    ? 'Customers you pick · 你指定的顾客'
            : 'Anyone in the app · 小程序内任何人';
  const min = Number(_vw.min) > 0 ? (' on orders ¥' + Number(_vw.min) + '+ · 满 ¥' + Number(_vw.min)) : '';
  const how = _vw.path === 'auto'    ? ' — applied automatically · 自动应用'
            : _vw.path === 'welcome' ? ' — placed in their coupons · 自动进入账户'
            : _vw.path === 'pick'    ? ' — after you pick them · 保存后挑选'
            : ' — they tap to save · 顾客自行领取';
  const per = Number(_vw.perCust) > 1 ? (', up to ' + Number(_vw.perCust) + ' times each · 每人限 ' + Number(_vw.perCust) + ' 次') : ', once each · 每人一次';
  const end = _vw.expires ? (', until ' + _vw.expires + ' · 至 ' + _vw.expires) : ', until you turn it off · 直到你停用';
  return '<b>' + escapeHtml(who) + '</b> get <b>' + escapeHtml(val) + '</b>' + escapeHtml(min) + escapeHtml(how) + escapeHtml(per) + escapeHtml(end) + '.';
}
function vwReviewHtml() {
  const flags = vwFlags();
  let fields = '<div class="vw-field"><label>Coupon code · 优惠码 <span class="sub">— made for you, change it if you like · 已自动生成</span></label>'
    + '<input id="vw-code" class="code" type="text" value="' + escapeAttr(_vw.code) + '" oninput="vwEditCode(this.value)"></div>';
  // A customer-facing label only matters when a customer ever sees the coupon —
  // i.e. not for a silent auto-applied store sale.
  if (_vw.path !== 'auto') {
    fields += '<div class="vw-field"><label>What customers see · 顾客看到 <span class="sub">— shown on the ticket · 显示在券面</span></label>'
      + '<input id="vw-title-en" type="text" value="' + escapeAttr(_vw.title_en || '') + '" oninput="vwEditLabel()" placeholder="English"></div>'
      + '<div class="vw-field"><input id="vw-title-cn" type="text" value="' + escapeAttr(_vw.title_cn || '') + '" oninput="vwEditLabel()" placeholder="中文"></div>';
  }
  return '<div class="vw-recap">' + vwRecapSentence() + '</div>' + fields;
}
function vwEditCode(v) { _vw.code = v.toUpperCase(); _vw.codeEdited = true; vwRefreshTicket(); }
function vwEditLabel() {
  const en = $('#vw-title-en'), cn = $('#vw-title-cn');
  if (en) _vw.title_en = en.value;
  if (cn) _vw.title_cn = cn.value;
  _vw.labelEdited = true;
  vwRefreshTicket();
}

// ── heads-up: read the live coupons and explain, in plain words, how this one
// will behave next to them. Grounded in the real resolution rules (best-one-wins,
// no stacking, signup grants, code revive). Live from the very first step —
// uses the generated code until the operator types their own. ──
function vwDiscAt(v, sub) {
  if (v.type === 'fixed_amount') return Math.min(Number(v.value) || 0, sub);
  if (v.type === 'percent') return sub * (Math.max(0, Math.min(100, Number(v.value) || 0))) / 100;
  return 0; // free shipping value depends on the live fee — not comparable here
}
function vwHeadsUp() {
  const notes = [];
  const code = ((_vw.code || vwGenCode()) || '').toUpperCase();
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
    // Signup coupons used to be left out here because they could never actually
    // auto-apply. They can now (for the new signups holding one), so they compete
    // for "best one wins" like any other automatic deal and belong in this list.
    const others = active.filter(v => v.auto_apply && String(v.code).toUpperCase() !== code);
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
function vwHeadsUpHtml() {
  const notes = vwHeadsUp();
  if (!notes.length) return '';
  return '<div class="vw-headsup" id="vw-headsup">' + notes.map(n =>
    '<div class="vw-note ' + (n.tone || '') + '"><span class="ni">' + (n.icon || '') + '</span><span>' + n.html + '</span></div>').join('') + '</div>';
}

// ── save ──
async function vwSave(activate) {
  const flags = vwFlags();
  const code = (_vw.code || '').trim().toUpperCase();
  if (!code) { toast('Code required · 请填写编码', 'err'); return; }
  if (_vw.path !== 'auto' && !((_vw.title_en || '').trim() || (_vw.title_cn || '').trim())) {
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
    toast(cuT('Failed', '失败') + ': ' + msg, 'err');
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
    $('#snip-status').innerHTML = '<span class="err">' + cuT('Failed', '失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
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
  quickStock:  '#qs-home',
  kitchenAdd:  '#ka-home',
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

// Display-currency presets for the Settings selector. Each carries the symbol,
// decimal places and symbol position saved to config.currency. Charging stays
// RMB (WeChat/Alipay); this only drives how amounts are shown.
const CURRENCY_PRESETS = [
  { code: 'CNY', symbol: '¥',   decimals: 2, position: 'before', label: 'Chinese Yuan · 人民币 (¥)' },
  { code: 'USD', symbol: '$',   decimals: 2, position: 'before', label: 'US Dollar ($)' },
  { code: 'EUR', symbol: '€',   decimals: 2, position: 'before', label: 'Euro (€)' },
  { code: 'GBP', symbol: '£',   decimals: 2, position: 'before', label: 'British Pound (£)' },
  { code: 'JPY', symbol: '¥',   decimals: 0, position: 'before', label: 'Japanese Yen (¥)' },
  { code: 'HKD', symbol: 'HK$', decimals: 2, position: 'before', label: 'Hong Kong Dollar (HK$)' },
  { code: 'SGD', symbol: 'S$',  decimals: 2, position: 'before', label: 'Singapore Dollar (S$)' },
  { code: 'AUD', symbol: 'A$',  decimals: 2, position: 'before', label: 'Australian Dollar (A$)' },
  { code: 'CAD', symbol: 'C$',  decimals: 2, position: 'before', label: 'Canadian Dollar (C$)' },
  { code: 'THB', symbol: '฿',   decimals: 2, position: 'before', label: 'Thai Baht (฿)' },
];
function renderCurrencyControl(c) {
  const sel = document.getElementById('cfg-currency');
  if (!sel) return;
  if (!sel.options.length) {
    sel.innerHTML = CURRENCY_PRESETS.map(p => `<option value="${p.code}">${escapeHtml(p.label)}</option>`).join('');
  }
  sel.value = (c && c.currency && c.currency.code) || 'CNY';
  // Auto-save on change (self-contained; not part of the shared settings save).
  sel.onchange = async () => {
    const p = CURRENCY_PRESETS.find(x => x.code === sel.value) || CURRENCY_PRESETS[0];
    try {
      await api('/api/retail-admin/config', { method: 'PUT', body: { currency: { code: p.code, symbol: p.symbol, decimals: p.decimals, position: p.position } } });
      toast(cuT('Currency saved', '货币已保存'), 'ok');
    } catch (e) { toast(cuT('Save failed', '保存失败') + ': ' + (e.message || ''), 'err'); }
  };
}

async function loadConfig() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    applyFeatureGates(c);
    _cfgCache = c;
    syncFeatureToggles();
    // Bulk attach tracking is an opt-in Orders tool — the toolbar button only
    // shows when the operator enabled it under Settings → Delivery.
    document.body.classList.toggle('ord-bulk-tracking', !!c.delivery?.bulkTracking);
    // Box-label printing (parcel stickers) is likewise opt-in — the drawer's
    // Box-label button + auto-print toggle only show when enabled in Delivery.
    document.body.classList.toggle('ord-box-label', !!c.delivery?.boxLabel);
    // Floating platform-Support launcher — operators can hide it (support.hidden).
    { const sb = $('#cfg-support-btn'); if (sb) {
        const show = !(c.support && c.support.hidden);
        sb.checked = show;
        if (!sb._wired) { sb._wired = true; sb.addEventListener('change', async () => {
          const hidden = !sb.checked;
          try {
            await api('/api/retail-admin/config', { method: 'PUT', body: { 'support.hidden': hidden } });
            if (window.__fcSupportButton) window.__fcSupportButton.setHidden(hidden);
            toast(hidden ? cuT('Support button hidden', '已隐藏客服按钮') : cuT('Support button shown', '已显示客服按钮'), 'ok');
          } catch (e) { sb.checked = !hidden; toast(cuT('Save failed', '保存失败') + ': ' + (e.message || ''), 'err'); }
        }); }
      } }
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
    if ($('#cfg-pickup-lead')) $('#cfg-pickup-lead').value = c.pickup?.leadMinutes ?? 0;
    renderCurrencyControl(c);
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
    $('#cfg-system_alerts-enabled').checked = !!c.system_alerts?.enabled;
    $('#cfg-system_alerts-wecom_webhook').value = c.system_alerts?.wecom_webhook || '';
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
    // Checkout upsell pop-up — storefront_config 'checkout.upsell'. Unset =
    // historical default (ON, all tiers, 4 items), matching the server.
    const up = (c.checkout && c.checkout.upsell) || {};
    if ($('#cfg-upsell-enabled')) $('#cfg-upsell-enabled').checked = up.enabled !== false;
    if ($('#cfg-upsell-bundles')) $('#cfg-upsell-bundles').checked = up.bundles !== false;
    if ($('#cfg-upsell-extras'))  $('#cfg-upsell-extras').checked  = up.extras  !== false;
    if ($('#cfg-upsell-flash'))   $('#cfg-upsell-flash').checked   = up.flash   !== false;
    if ($('#cfg-upsell-max'))     $('#cfg-upsell-max').value       = up.max != null ? up.max : 4;

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

// System Alerts — fire a test message to the typed (or saved) WeCom webhook so the
// operator confirms it lands in the dedicated group before relying on it.
async function _testSystemAlert() {
  const st = $('#system_alerts-test-status');
  const webhook = $('#cfg-system_alerts-wecom_webhook').value.trim();
  if (!webhook) { if (st) st.textContent = '⚠ Paste a webhook first · 请先填入 Webhook'; return; }
  if (st) st.textContent = 'Sending… · 发送中…';
  try {
    const r = await fetch('/api/retail-admin/system-alerts/test', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook }),
    });
    const j = await r.json().catch(() => ({}));
    if (st) st.textContent = j.success
      ? '✅ Sent — check the group · 已发送,请查看该群'
      : '⚠ ' + (j.error === 'domain_not_allowed' ? 'Only qyapi.weixin.qq.com URLs · 仅接受 qyapi 地址'
              : j.error === 'no_webhook' ? 'Paste a webhook first · 请先填入 Webhook'
              : (j.error || 'failed'));
  } catch (e) { if (st) st.textContent = '⚠ ' + e.message; }
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
    'system_alerts.enabled':         $('#cfg-system_alerts-enabled').checked,
    'system_alerts.wecom_webhook':   $('#cfg-system_alerts-wecom_webhook').value.trim(),
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
    // The manual-Alipay 收款码 card shares this Save bar now (it no longer has
    // its own button). Save it too; it throws a friendly message on failure.
    if (typeof saveAlipayManualInline === 'function') await saveAlipayManualInline();
    status.innerHTML = '<span class="ok">Saved ✓</span>';
    toast('Settings saved · 设置已保存');
  } catch (e) {
    status.innerHTML = '<span class="err">' + cuT('Failed', '失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
    toast('Save failed · 保存失败: ' + e.message, 'err');
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
async function saveCheckoutUpsell() {
  const status = $('#upsell-status');
  if (status) { status.textContent = 'Saving… · 保存中…'; status.style.color = ''; }
  const upsell = {
    enabled: $('#cfg-upsell-enabled').checked,
    bundles: $('#cfg-upsell-bundles').checked,
    extras:  $('#cfg-upsell-extras').checked,
    flash:   $('#cfg-upsell-flash').checked,
    max:     Math.max(1, Math.min(6, Number($('#cfg-upsell-max').value) || 4)),
  };
  try {
    await api('/api/retail-admin/config', { method: 'PUT', body: { 'checkout.upsell': upsell } });
    if (status) status.innerHTML = '<span class="ok">Saved ✓ · 已保存</span>';
    toast('Saved · 已保存');
  } catch (e) {
    if (status) { status.textContent = 'Save failed · 保存失败'; status.style.color = 'var(--danger)'; }
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
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
    $('#cats-status').innerHTML = '<span class="err">' + cuT('Load failed', '加载失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
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
    status.innerHTML = '<span class="err">' + cuT('Save failed', '保存失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
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
    status.innerHTML = '<span class="err">' + cuT('Rename failed', '重命名失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
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
    status.innerHTML = '<span class="err">' + cuT('Add failed', '添加失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
  }
}

async function deleteCategory(id, name, usage) {
  if (usage > 0) {
    toast(`"${name}" is used by ${usage} product${usage === 1 ? '' : 's'}. Recategorize or unpublish those products first. · "${name}" 已被 ${usage} 个商品使用。请先将这些商品重新分类或下架。`, 'err');
    return;
  }
  if (!(await askConfirm({ title: `Delete category "${name}"? · 删除分类 "${name}"？`, confirmLabel: 'Delete · 删除', danger: true }))) return;
  const status = $('#cats-status');
  status.innerHTML = 'Deleting…';
  try {
    await api('/api/retail-admin/categories/' + id, { method: 'DELETE' });
    _cats = _cats.filter(c => c.id !== id);
    renderCategories();
    status.innerHTML = '<span class="ok">Deleted ✓</span>';
    setTimeout(() => { status.innerHTML = ''; }, 1500);
  } catch (e) {
    status.innerHTML = '<span class="err">' + cuT('Delete failed', '删除失败') + ': <span data-no-i18n>' + escapeHtml(e.message) + '</span></span>';
  }
}

// ════════════════════════════════════════════════════════════════
// BROADCASTS — operator-composed announcements that fan out to every
// active (non-blocked) customer's notification inbox.
//
// Rebuilt 2026-07-11 as the Tacet "one quiet feed" (Option C): a
// collapsed compose bar that expands in place into a staged form
// (Title/Body → Who / When / Opens), a one-line automatic-updates
// row, and the history grouped by month with scheduled pinned on top.
// The endpoints, payloads, and the input IDs read on send are the
// same as before; the composer just presents them differently.
// ════════════════════════════════════════════════════════════════

// Friendly names for the deep-link presets, used both in the composer
// summary and on each feed row ("Opens Coupons").
const BX_DEEPLINK_LABEL = {
  '/pages/shop/shop':             ['Shop', '商城'],
  '/pages/cart/cart':             ['Cart', '购物车'],
  '/pages/orders/orders':         ['My orders', '我的订单'],
  '/pages/coupons/coupons':       ['Coupons', '优惠券'],
  '/pages/membership/membership': ['Membership', '会员'],
  '/pages/affiliate/affiliate':   ['Refer a friend', '推广'],
  '/pages/voting/voting':         ['Your say', '投票'],
  '/pages/topup/topup':           ['Top up', '充值'],
};
function bxDeeplinkLabel(path) {
  const m = BX_DEEPLINK_LABEL[path];
  return m ? cuT(m[0], m[1]) : path;
}

const BX_MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const BX_MON_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function bxParseDate(str) {
  if (!str) return null;
  // Accept ISO or SQLite "YYYY-MM-DD HH:MM:SS".
  const d = new Date(String(str).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
function bxMonthLabel(d) {
  if (!d) return cuT('Earlier', '更早');
  return cuT(BX_MON_FULL[d.getMonth()] + ' ' + d.getFullYear(), d.getFullYear() + '年' + (d.getMonth() + 1) + '月');
}
function bxFmtDate(str) {
  const d = bxParseDate(str);
  if (!d) return escapeHtml(str || '');
  return cuT(BX_MON_ABBR[d.getMonth()] + ' ' + d.getDate(), (d.getMonth() + 1) + '月' + d.getDate() + '日');
}
function bxFmtDateTime(str) {
  const d = bxParseDate(str);
  if (!d) return escapeHtml(str || '');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return bxFmtDate(str) + ', ' + hh + ':' + mm;
}

// ── compose open / close ──────────────────────────────────────────
function bxOpenCompose() {
  const sec = $('#tab-broadcasts');
  sec.classList.add('bx-open');
  // Open the audience step so the operator sees who it reaches by default.
  $('#bx-step-who').classList.remove('open');
  loadBroadcastAudienceCount();
  const t = $('#bc-title-en');
  if (t) setTimeout(() => t.focus(), 40);
}
function bxCloseCompose() {
  $('#tab-broadcasts').classList.remove('bx-open');
  bcResetComposer();
}
// Expand / collapse one of the Who / When / Opens decision rows. Only
// one open at a time keeps the form short.
function bxStep(key) {
  const row = $('#bx-step-' + key);
  if (!row) return;
  const wasOpen = row.classList.contains('open');
  ['who', 'when', 'opens'].forEach(k => { const r = $('#bx-step-' + k); if (r) r.classList.remove('open'); });
  if (!wasOpen) row.classList.add('open');
}
// Automatic-updates manage panel.
function bxToggleAuto() {
  const box = $('#bx-auto');
  const open = box.classList.toggle('open');
  const btn = $('#bx-auto-btn');
  if (btn) btn.textContent = open ? cuT('Done', '完成') : cuT('Manage', '管理');
}

// ── deep-link ("Opens") ───────────────────────────────────────────
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
  bxOpensChanged();
}
function bxOpensChanged() {
  const sel = $('#bc-deeplink-preset');
  const custom = ($('#bc-deeplink').value || '').trim();
  const sum = $('#bx-opens-sum');
  if (!sum) return;
  let label;
  if (sel.value === '__custom__') {
    label = custom || cuT('Custom page', '自定义页面');
  } else if (sel.value) {
    label = bxDeeplinkLabel(sel.value);
  } else {
    label = cuT('Nothing — just the message', '不跳转,仅消息');
  }
  sum.textContent = label;
}

// ── when ──────────────────────────────────────────────────────────
function bcScheduleMode() {
  const sel = $('#bc-schedule-mode');
  const at  = $('#bc-schedule-at');
  if (sel.value === 'later') {
    at.style.display = '';
    if (!at.value) {
      // Default to 1 hour from now in local time, datetime-local format.
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      at.value = d.toISOString().slice(0, 16);
    }
  } else {
    at.style.display = 'none';
  }
  bxWhenChanged();
}
function bxWhenChanged() {
  const mode = $('#bc-schedule-mode').value;
  const at = $('#bc-schedule-at').value;
  const sum = $('#bx-when-sum');
  if (sum) {
    sum.textContent = (mode === 'later' && at)
      ? bxFmtDateTime(at)
      : (mode === 'later' ? cuT('Pick a time', '选择时间') : cuT('Now', '立即'));
  }
  bxUpdateSendLabel();
  bxUpdateAudChip();
}

// ── composer reset ────────────────────────────────────────────────
function bcResetComposer() {
  ['bc-title-en','bc-title-cn','bc-body-en','bc-body-cn','bc-deeplink','bc-schedule-at'].forEach(k => { const el = $('#' + k); if (el) el.value = ''; });
  $('#bc-deeplink-preset').value = '';
  $('#bc-deeplink').style.display = 'none';
  $('#bc-schedule-mode').value = 'now';
  $('#bc-schedule-at').style.display = 'none';
  $('#bc-send-status').textContent = '';
  if ($('#bc-activity')) $('#bc-activity').value = 'all';
  document.querySelectorAll('.bc-tier:checked, .bc-city:checked').forEach(el => { el.checked = false; });
  ['who', 'when', 'opens'].forEach(k => { const r = $('#bx-step-' + k); if (r) r.classList.remove('open'); });
  bxWhenChanged();
  bxOpensChanged();
  loadBroadcastAudienceCount();
}

// ── audience ──────────────────────────────────────────────────────
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
    active: T('Ordered in last 30 days', '近30天下单'),
    lapsed: T('No order in 60 days', '60天未下单'),
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
  const s = $('#bx-who-sum');
  if (s) s.textContent = bcAudienceLabel(bcAudienceObj());   // instant echo
  clearTimeout(_bcAudTimer);
  _bcAudTimer = setTimeout(loadBroadcastAudienceCount, 250);
}
// Read the live headcount out of the count node (digits only).
function bxAudCount() {
  return ($('#bc-aud-count').textContent || '').replace(/[^0-9]/g, '');
}
function bxUpdateSendLabel() {
  const lbl = $('#bc-send-label');
  if (!lbl) return;
  const mode = $('#bc-schedule-mode').value;
  const n = bxAudCount();
  const ppl = cuT(n + (n === '1' ? ' person' : ' people'), n + ' 位');
  if (!n) {
    lbl.textContent = mode === 'later' ? cuT('Schedule broadcast', '定时发送') : cuT('Send broadcast', '发送广播');
  } else {
    lbl.textContent = mode === 'later'
      ? cuT('Schedule for ' + ppl, '定时发送给 ' + ppl)
      : cuT('Send to ' + ppl, '发送给 ' + ppl);
  }
}
function bxUpdateAudChip() {
  const chip = $('#bx-audchip');
  if (!chip) return;
  const who = bcAudienceLabel(bcAudienceObj());
  const mode = $('#bc-schedule-mode').value;
  const at = $('#bc-schedule-at').value;
  const when = (mode === 'later' && at) ? bxFmtDateTime(at) : (mode === 'later' ? cuT('scheduled', '定时') : cuT('now', '立即'));
  chip.textContent = who + ' · ' + when;
}
async function loadBroadcastAudienceCount() {
  const aud = bcAudienceObj();
  const whoSum = $('#bx-who-sum');
  if (whoSum) whoSum.textContent = bcAudienceLabel(aud);
  try {
    const q = '?aud=' + encodeURIComponent(JSON.stringify(aud));
    const { data } = await api('/api/retail-admin/broadcasts/audience-count' + q);
    $('#bc-aud-count').textContent = (data && data.count != null ? data.count : '0') + cuT(' people', ' 位');
  } catch (e) {
    $('#bc-aud-count').textContent = '?';
  }
  bxUpdateSendLabel();
  bxUpdateAudChip();
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
      wrap.innerHTML = '<span style="font-size:12.5px;color:var(--text-2);">No saved addresses yet. · 暂无已保存地址。</span>';
      return;
    }
    wrap.innerHTML = _bcRegions.map(r => {
      // When an English city name exists, emit an "EN · 中文" text node so the
      // page's i18n layer shows the operator's active language (and live-toggles).
      const label = r.city_en
        ? `${escapeHtml(r.city_en)} · ${escapeHtml(r.city)}`
        : escapeHtml(r.city);
      return `<label class="bx-chip"><input type="checkbox" class="bc-city" value="${escapeHtml(r.city)}" onchange="bcAudienceChanged()"> ${label} <span class="bx-n">${r.n}</span></label>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = '<span style="font-size:12.5px;color:var(--tacet-brick);">Failed to load regions. · 加载地区失败。</span>';
  }
}

// ── automatic-notification switches ───────────────────────────────
// Read/write notifications.categories on the shared storefront config.
// Missing entry = enabled (the server defaults the same way), so an
// untouched store keeps today's behaviour.
async function loadNotifCategories() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    const cats = (c.notifications && c.notifications.categories) || {};
    document.querySelectorAll('[data-notif-cat]').forEach(el => {
      el.checked = cats[el.dataset.notifCat] !== false;   // default on
    });
  } catch (e) { /* leave switches as-is */ }
  bxRenderAutoSummary();
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
  bxRenderAutoSummary();
}
// One-line summary of which automatic categories are on. Reads the live
// checkbox state so it stays right after every toggle.
function bxRenderAutoSummary() {
  const sum = $('#bx-auto-sum');
  if (!sum) return;
  const NAME = { order: ['Order & shipping', '订单与物流'], invoice: ['Invoices', '发票'], refund: ['Refunds', '退款'] };
  const on = [], off = [];
  document.querySelectorAll('[data-notif-cat]').forEach(el => {
    const n = NAME[el.dataset.notifCat];
    if (!n) return;
    (el.checked ? on : off).push(cuT(n[0], n[1]));
  });
  const parts = [];
  parts.push('<b>' + cuT('Automatic updates', '自动通知') + '</b>');
  if (on.length)  parts.push(cuT('on: ', '开启: ') + on.join(', '));
  if (off.length) parts.push(cuT('off: ', '关闭: ') + off.join(', '));
  sum.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

// ── the feed ──────────────────────────────────────────────────────
let _bcData = [];
async function loadBroadcasts() {
  const wrap = $('#bc-list');
  if (!wrap) return;
  wrap.innerHTML = '<div style="font-size:13px;color:var(--text-2);">Loading… · 加载中…</div>';
  try {
    const { data } = await api('/api/retail-admin/broadcasts');
    _bcData = data || [];
    if (!_bcData.length) {
      wrap.innerHTML =
        '<div class="bx-empty">' +
          '<div class="t">Nothing sent yet. · 暂无发送记录。</div>' +
          '<div class="s">When you have something to say, write it above and it lands here. · 有话要说时,在上方撰写,记录会出现在这里。</div>' +
        '</div>';
      return;
    }
    const scheduled = _bcData.filter(b => (b.status || 'sent') === 'scheduled')
      .sort((a, b) => String(a.scheduled_for || '').localeCompare(String(b.scheduled_for || '')));
    const rest = _bcData.filter(b => (b.status || 'sent') !== 'scheduled');

    let html = '';
    if (scheduled.length) {
      html += '<div class="bx-month">' + cuT('Scheduled', '已排期') + '</div>';
      html += '<div class="bx-feed bx-card">' + scheduled.map(bxFeedRow).join('') + '</div>';
    }
    // Group the rest by month of send (newest-first order preserved by API).
    const order = [], byKey = {};
    rest.forEach(b => {
      const d = bxParseDate(b.sent_at || b.scheduled_for || b.created_at);
      const key = d ? (d.getFullYear() + '-' + d.getMonth()) : 'earlier';
      if (!byKey[key]) { byKey[key] = { label: bxMonthLabel(d), items: [] }; order.push(key); }
      byKey[key].items.push(b);
    });
    order.forEach(key => {
      html += '<div class="bx-month">' + escapeHtml(byKey[key].label) + '</div>';
      html += '<div class="bx-feed bx-card">' + byKey[key].items.map(bxFeedRow).join('') + '</div>';
    });
    wrap.innerHTML = html;
  } catch (e) {
    wrap.innerHTML = `<div style="font-size:13px;color:var(--tacet-brick);">${cuT('Failed', '失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}
function bxFeedRow(b) {
  const status = b.status || 'sent';
  const titleBits = [];
  if (b.title_en) titleBits.push(escapeHtml(b.title_en));
  if (b.title_cn) titleBits.push(escapeHtml(b.title_cn));
  const title = titleBits.join(' · ') || '<span style="color:var(--text-3);">(no title) · (无标题)</span>';
  const bodyBits = [];
  if (b.body_en) bodyBits.push(escapeHtml(b.body_en));
  if (b.body_cn) bodyBits.push(escapeHtml(b.body_cn));
  const body = bodyBits.join(' · ');

  const PILL = {
    sent:      cuT('Sent', '已发送'),
    scheduled: cuT('Scheduled', '已排期'),
    draft:     cuT('Draft', '草稿'),
    recalled:  cuT('Recalled', '已撤回'),
    cancelled: cuT('Cancelled', '已取消'),
  };
  let pillText = PILL[status] || status;
  if (status === 'scheduled' && b.scheduled_for) pillText = cuT('Scheduled', '排期') + ' · ' + bxFmtDateTime(b.scheduled_for);
  const pill = `<span class="bx-pill ${status}"><span class="pd"></span>${escapeHtml(pillText)}</span>`;

  const meta = [];
  if (status !== 'scheduled' && b.sent_at) meta.push(bxFmtDate(b.sent_at));
  if (b.recipient_count) meta.push(cuT(b.recipient_count + (b.recipient_count === 1 ? ' person' : ' people'), b.recipient_count + ' 位'));
  if (b.audience && String(b.audience).charAt(0) === '{') {
    try {
      const aud = JSON.parse(b.audience);
      if (aud.activity !== 'all' || (aud.tiers && aud.tiers.length) || (aud.cities && aud.cities.length)) {
        meta.push(escapeHtml(bcAudienceLabel(aud)));
      }
    } catch (_) {}
  }
  const metaHtml = meta.map((m, i) => (i ? '<span class="bx-dot">·</span>' : '') + '<span>' + m + '</span>').join('');
  const opensHtml = b.deeplink
    ? '<span class="bx-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>' + cuT('Opens ', '打开 ') + escapeHtml(bxDeeplinkLabel(b.deeplink)) + '</span>'
    : '';

  // Actions by status: scheduled → Cancel; everything else → Send again
  // (repopulates the composer), plus Recall while a sent broadcast is live.
  let actions = '';
  if (status === 'scheduled') {
    actions = `<button class="bx-btn danger sm" onclick="recallBroadcast(${b.id}, 'scheduled')">${cuT('Cancel', '取消')}</button>`;
  } else {
    actions = `<button class="bx-btn ghost sm" onclick="bxSendAgain(${b.id})">${cuT('Send again', '再次发送')}</button>`;
    if (status === 'sent') actions += `<button class="bx-btn danger sm" onclick="recallBroadcast(${b.id}, 'sent')">${cuT('Recall', '撤回')}</button>`;
  }

  return `
    <div class="bx-item" data-id="${b.id}">
      <div class="main">
        <div class="bx-tline"><span class="ttl" data-no-i18n>${title}</span>${pill}</div>
        ${body ? `<div class="bdy" data-no-i18n>${body}</div>` : ''}
        <div class="bx-meta">${metaHtml}${opensHtml}</div>
      </div>
      <div class="bx-rowact">${actions}</div>
    </div>`;
}
// Reuse a past broadcast's copy + audience as the starting point for a new one.
function bxApplyAudience(aud) {
  if ($('#bc-activity')) $('#bc-activity').value = aud.activity || 'all';
  document.querySelectorAll('.bc-tier').forEach(el => { el.checked = !!(aud.tiers && aud.tiers.indexOf(el.value) !== -1); });
  document.querySelectorAll('.bc-city').forEach(el => { el.checked = !!(aud.cities && aud.cities.indexOf(el.value) !== -1); });
}
function bxSendAgain(id) {
  const b = _bcData.find(x => String(x.id) === String(id));
  if (!b) return;
  bxOpenCompose();
  $('#bc-title-en').value = b.title_en || '';
  $('#bc-title-cn').value = b.title_cn || '';
  $('#bc-body-en').value = b.body_en || '';
  $('#bc-body-cn').value = b.body_cn || '';
  // Deep-link → preset if known, else custom.
  const dl = b.deeplink || '';
  const sel = $('#bc-deeplink-preset');
  if (!dl) { sel.value = ''; $('#bc-deeplink').style.display = 'none'; $('#bc-deeplink').value = ''; }
  else if (BX_DEEPLINK_LABEL[dl]) { sel.value = dl; $('#bc-deeplink').style.display = 'none'; $('#bc-deeplink').value = dl; }
  else { sel.value = '__custom__'; $('#bc-deeplink').style.display = ''; $('#bc-deeplink').value = dl; }
  // Audience.
  let aud = { activity: 'all', tiers: [], cities: [] };
  if (b.audience && String(b.audience).charAt(0) === '{') { try { aud = JSON.parse(b.audience); } catch (_) {} }
  bxApplyAudience(aud);
  // Always start "send now" — re-sends shouldn't inherit an old schedule time.
  $('#bc-schedule-mode').value = 'now';
  $('#bc-schedule-at').style.display = 'none';
  $('#bc-schedule-at').value = '';
  bxWhenChanged();
  bxOpensChanged();
  loadBroadcastAudienceCount();
  $('#tab-broadcasts').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── send / recall ─────────────────────────────────────────────────
async function sendBroadcast() {
  const title_en = $('#bc-title-en').value.trim();
  const title_cn = $('#bc-title-cn').value.trim();
  const body_en  = $('#bc-body-en').value.trim();
  const body_cn  = $('#bc-body-cn').value.trim();
  const deeplink = $('#bc-deeplink').value.trim();
  const mode     = $('#bc-schedule-mode').value;
  const scheduledRaw = mode === 'later' ? $('#bc-schedule-at').value : '';
  const status = $('#bc-send-status');

  if (!title_en && !title_cn) {
    status.innerHTML = '<span class="err">Add at least one title. · 请至少填写一个标题。</span>';
    return;
  }
  if (deeplink && !deeplink.startsWith('/pages/')) {
    status.innerHTML = '<span class="err">The custom page must start with /pages/ · 自定义页面需以 /pages/ 开头</span>';
    bxStep('opens');
    return;
  }
  if (mode === 'later' && !scheduledRaw) {
    status.innerHTML = '<span class="err">Pick a time to send. · 请选择发送时间。</span>';
    bxStep('when');
    return;
  }
  const audCount = bxAudCount();
  const verb = mode === 'later' ? 'Schedule' : 'Send';
  if (!(await askConfirm({ title: `${verb} this broadcast to ${audCount || 'all active'} customer${audCount === '1' ? '' : 's'}? · 向 ${audCount || '所有活跃'} 位客户${verb === 'Schedule' ? '排期' : '发送'}此群发消息？`, confirmLabel: `${verb} · ${verb === 'Schedule' ? '排期' : '发送'}` }))) return;

  const payload = { title_en, title_cn, body_en, body_cn, deeplink, audience: bcAudienceObj() };
  if (scheduledRaw) {
    // datetime-local has no timezone; treat as local time and convert.
    payload.scheduled_for = new Date(scheduledRaw).toISOString();
  }
  const btn = $('#bc-send-btn');
  btn.disabled = true;
  status.textContent = cuT('Sending…', '发送中…');
  try {
    const { data } = await api('/api/retail-admin/broadcasts', { method: 'POST', body: payload });
    if (data.status === 'sent') {
      toast(cuT('Sent to ' + data.recipient_count + (data.recipient_count === 1 ? ' person' : ' people'), '已发送给 ' + data.recipient_count + ' 位顾客'));
    } else if (data.status === 'scheduled') {
      toast(cuT('Scheduled', '已排期'));
    }
    bxCloseCompose();
    loadBroadcasts();
  } catch (e) {
    status.innerHTML = `<span class="err">${cuT('Failed', '失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></span>`;
  } finally {
    btn.disabled = false;
  }
}
async function recallBroadcast(id, currentStatus) {
  const verb = currentStatus === 'scheduled'
    ? 'Cancel this scheduled broadcast · 取消此已排期的群发消息'
    : 'Recall this broadcast (remove from every customer\'s inbox) · 撤回此群发消息（从每位客户的收件箱中移除）';
  if (!(await askConfirm({ title: verb + '?', confirmLabel: currentStatus === 'scheduled' ? 'Cancel · 取消' : 'Recall · 撤回', danger: true }))) return;
  try {
    await api('/api/retail-admin/broadcasts/' + id + '/recall', { method: 'POST' });
    loadBroadcasts();
  } catch (e) {
    toast(cuT('Failed', '失败') + ': ' + e.message, 'err');
  }
}
// Lazy-load when the operator first opens the tab.
document.querySelector('[data-tab="broadcasts"]').addEventListener('click', () => {
  loadNotifCategories();
  loadBroadcasts();
  loadBroadcastRegions();
  loadBroadcastAudienceCount();
});
// Keep the computed (non-static) labels in sync when the operator flips EN/CN.
// Static "EN · 中文" nodes re-translate themselves via the i18n text-node layer;
// these are JS-built and need a manual refresh.
if (window.onLangChange) onLangChange(() => {
  const whoSum = document.getElementById('bx-who-sum');
  if (whoSum) whoSum.textContent = bcAudienceLabel(bcAudienceObj());
  bxWhenChanged();
  bxOpensChanged();
  bxUpdateAudChip();
  bxRenderAutoSummary();
  const autoBtn = document.getElementById('bx-auto-btn');
  if (autoBtn) autoBtn.textContent = document.getElementById('bx-auto').classList.contains('open') ? cuT('Done', '完成') : cuT('Manage', '管理');
  if (_bcData.length && document.getElementById('bc-list')) loadBroadcasts();
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

// "Show once" means once per VERSION, not once per pop-up forever. The mini-app
// remembers a pop-up as seen under `popup_seen:<id>:<updated_at>`, so bumping
// this stamp hands the pop-up a fresh identity and everyone gets to see it
// again — which is what a merchant means when they edit one and expect the
// change to land. Leave it alone and an untouched 'once' pop-up still shows
// exactly once. Every write path that changes what a customer would see has to
// call this, or the edit ships to a phone that will never display it.
function puStamp(p) {
  p.updated_at = Date.now();
  return p;
}

async function loadPopups() {
  try {
    const { data: c } = await api('/api/retail-admin/config');
    const list = Array.isArray(c.popups?.list) ? c.popups.list : [];
    _popups = list;
    renderPopups();
  } catch (e) {
    $('#popups-list').innerHTML = `<div class="err">${cuT('Load failed', '加载失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

// Active-language pick with a safe fallback (cuT may not be defined yet).
const puT = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
let _puFilter = 'all';

// Status resolved to one class + one label, so the pill reads at a glance.
function puStatus(p) {
  const today = new Date().toISOString().slice(0, 10);
  if (!p.enabled)                        return { cls: 'off',   dot: false, label: puT('Off', '已停用') };
  if (p.start_at && today < p.start_at)  return { cls: 'sched', dot: true,  label: puT('Starts ', '待开始 ') + p.start_at };
  if (p.end_at   && today > p.end_at)    return { cls: 'ended', dot: true,  label: puT('Ended ', '已结束 ') + p.end_at };
  return { cls: 'live', dot: true, label: puT('Live', '进行中') };
}

// The pop-up drawn on a phone, exactly as the customer meets it. English copy
// preferred (mirrors the drawer's live preview); data-no-i18n so the language
// walker never rewrites the customer-facing text.
function puMiniPreview(p) {
  const title = escapeHtml((p.title_en || p.title_cn || puT('Pop-up title', '弹窗标题')).slice(0, 80));
  const body  = escapeHtml((p.body_en  || p.body_cn  || '').slice(0, 140));
  const cta   = escapeHtml((p.cta_label_en || p.cta_label_cn || '').slice(0, 30));
  const img   = p.image_url ? String(p.image_url).replace(/'/g, '%27') : '';
  const x = p.dismissible !== false
    ? '<div class="pg-pop-x"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></div>' : '';
  return `<div class="pg-pv" data-no-i18n>
    <div class="pg-pv-lines"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="pg-pv-scrim"></div>
    <div class="pg-pop">
      ${x}
      ${img ? `<div class="pg-pop-img" style="background-image:url('${img}')"></div>` : ''}
      <div class="pg-pop-body">
        <div class="pg-pop-t">${title}</div>
        ${body ? `<div class="pg-pop-b">${body}</div>` : ''}
        ${cta ? `<div class="pg-pop-cta">${cta}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// One plain line under each card: where it shows · how often · what it opens.
function puSentence(p) {
  const pageLabel = k => ((PAGE_KEYS.find(([kk]) => kk === k) || [])[1]) || k;
  let where;
  if (!p.pages || !p.pages.length)      where = puT('No page picked', '未选择页面');
  else if (p.pages.includes('all'))     where = 'All pages · 全部页面';
  else                                  where = p.pages.map(pageLabel).join(' · ');
  const freq = ({
    once: 'shows once · 仅一次', daily: 'daily · 每天一次',
    session: 'once a session · 每次会话', every_visit: 'every visit · 每次访问',
  })[p.frequency] || p.frequency || '';
  const t = (p.cta_target || '').trim();
  const opens = (t && (p.cta_label_en || p.cta_label_cn)) ? ` · → ${escapeHtml(ctaTargetLabel(t))}` : '';
  return `<b>${escapeHtml(where)}</b> · ${escapeHtml(freq)}${opens}`;
}

function popupMatchesFilter(p) {
  if (_puFilter === 'all') return true;
  const cls = puStatus(p).cls;
  if (_puFilter === 'off') return cls === 'off' || cls === 'ended';
  return cls === _puFilter;
}

function setPopupFilter(f) {
  _puFilter = f;
  document.querySelectorAll('#pu-ftabs button').forEach(b => b.classList.toggle('act', b.dataset.filter === f));
  renderPopups();
}

function renderPopups() {
  const mount = $('#popups-list');
  const countEl = $('#pu-count');
  if (countEl) countEl.textContent = _popups.length + ' ' + puT(_popups.length === 1 ? 'pop-up' : 'pop-ups', '个弹窗');
  document.querySelectorAll('#pu-ftabs button').forEach(b => b.classList.toggle('act', b.dataset.filter === _puFilter));

  const newTile = `<button class="pg-newtile" onclick="openPopupEditor()">
    <span class="plus"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span>
    <span>New pop-up · 新建弹窗</span>
  </button>`;

  if (!_popups.length) {
    mount.innerHTML = `<div class="pg-empty" style="grid-column: 1 / -1;">
      <span class="em-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/></svg></span>
      <h3>The app is quiet · 暂无弹窗</h3>
      <p>Add one when you have something worth interrupting for — a promo, a review nudge, a holiday notice. · 有值得打扰顾客的事时再新建一个——活动、邀请评价或歇业通知。</p>
      <button class="pg-btn primary" style="margin-top: 20px;" onclick="openPopupEditor()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        New pop-up · 新建弹窗
      </button>
    </div>`;
    return;
  }

  const visible = _popups.filter(popupMatchesFilter);
  const cards = visible.map((p) => {
    const st = puStatus(p);
    const id = escapeAttr(p.id);
    const name = escapeHtml(p.name || puT('Untitled pop-up', '未命名弹窗'));
    return `<div class="pg-card ${st.cls === 'off' || st.cls === 'ended' ? 'is-off' : ''}">
      <div class="pvwrap">${puMiniPreview(p)}</div>
      <div class="pg-foot">
        <div class="pg-name">${name}</div>
        <div class="pg-sent">${puSentence(p)}</div>
        <div class="pg-row">
          <span class="pg-pill ${st.cls}">${st.dot ? '<span class="pdot"></span>' : ''}${escapeHtml(st.label)}</span>
          <label class="pg-tgl" title="${puT('Turn on / off', '启用 / 停用')}">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePopup('${id}', this.checked)">
            <span class="tr"></span>
          </label>
          <span class="pg-act">
            <button class="pg-iconbtn" title="${puT('Edit', '编辑')}" onclick="openPopupEditor('${id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
            <button class="pg-iconbtn" title="${puT('Duplicate', '复制')}" onclick="duplicatePopup('${id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          </span>
        </div>
      </div>
    </div>`;
  }).join('');

  const emptyFilter = !visible.length
    ? `<div class="pg-empty" style="grid-column: 1 / -1;"><p>${puT('Nothing in this filter yet.', '此筛选下暂无内容。')}</p></div>`
    : '';

  mount.innerHTML = cards + emptyFilter + newTile;
}

async function togglePopup(id, enabled) {
  const p = _popups.find(x => x.id === id);
  if (!p) return;
  p.enabled = !!enabled;
  // Switching a pop-up back on is how a merchant re-runs one, so it counts as
  // a new version and the people who already dismissed it see it again.
  puStamp(p);
  try {
    await savePopupsArray();
    renderPopups();
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); renderPopups(); }
}

// Spin off a seasonal variant — a fresh id, "(copy)" on the name, left off so
// nothing goes live by accident. Opens the editor straight away.
async function duplicatePopup(id) {
  const src = _popups.find(x => x.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  puStamp(copy);
  copy.enabled = false;
  copy.name = (src.name || puT('Untitled', '未命名')) + puT(' (copy)', '(副本)');
  _popups.unshift(copy);
  try {
    await savePopupsArray();
    renderPopups();
    openPopupEditor(copy.id);
    toast(puT('Duplicated · edit the copy', '已复制 · 编辑副本'));
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

// Collapsible decision rows in the editor.
function togglePopupStep(headEl) {
  const step = headEl.closest('.pg-step');
  if (step) step.classList.toggle('open');
}

// Keep each collapsed row's one-line summary honest as fields change.
function refreshPopupStepSummaries() {
  const set = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };
  // Where
  const pages = (typeof selectedPopupPages === 'function') ? selectedPopupPages() : [];
  let where;
  if (!pages.length)               where = puT('No page picked', '未选择页面');
  else if (pages.includes('all'))  where = puT('All pages', '全部页面');
  else                             where = pages.map(k => ((PAGE_KEYS.find(([kk]) => kk === k) || [])[1] || k)).join(' · ');
  set('#pu-sum-where', where);
  // When
  const trig  = $('#pu-trigger').value;
  const delay = Number($('#pu-delay').value) || 0;
  const trigLabel = trig === 'after_seconds' ? puT('After ' + delay + 's', delay + '秒后') : puT('On open', '打开即弹');
  const freqLabel = ({
    once: puT('once per person', '每人一次'), daily: puT('once a day', '每天一次'),
    session: puT('once a session', '每次会话'), every_visit: puT('every visit', '每次访问'),
  })[$('#pu-frequency').value] || '';
  set('#pu-sum-when', trigLabel + ' · ' + freqLabel);
  // Runs
  const s = $('#pu-start_at').value, e = $('#pu-end_at').value;
  let runs;
  if (!s && !e)   runs = puT('Always, until turned off', '一直,直到停用');
  else if (s && e) runs = s + ' → ' + e;
  else if (s)     runs = puT('From ', '从 ') + s;
  else            runs = puT('Until ', '至 ') + e;
  set('#pu-sum-runs', runs);
  // Options
  const on = $('#pu-enabled').checked, dis = $('#pu-dismissible').checked;
  set('#pu-sum-options', (on ? puT('Live', '进行中') : puT('Off', '已停用')) + ' · ' + (dis ? puT('closable', '可关闭') : puT('not closable', '不可关闭')));
}

function blankPopup() {
  return puStamp({
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
  });
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
  // Reset the staged rows: only "Where" opens; the rest collapse to summaries.
  document.querySelectorAll('#pu-editor-bg .pg-step').forEach(s => s.classList.toggle('open', s.dataset.step === 'where'));
  refreshPopupStepSummaries();
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
      refreshPopupStepSummaries();
    });
  });
}
function selectedPopupPages() {
  return Array.from($('#pu-pages').querySelectorAll('.pu-page-chip.on')).map(el => el.dataset.page);
}

// Pop-up picture preset — same pipeline as the product editor so a raw 4–10MB
// phone photo doesn't ship whole. The pop-up card is a phone-width panel, so
// 1200px on the long edge is retina-sharp; JPEG q0.88 lands a typical upload
// around 200–400KB. Falls back to the raw file if the resizer isn't loaded.
const PU_IMG_OPTS = { maxLong: 1200, quality: 0.88, format: 'jpeg', passThroughBelow: 200 * 1024 };
async function uploadPopupImage(file) {
  if (!file) return;
  if (typeof pdHandleImageUpload === 'function') {
    const dataURL = await pdHandleImageUpload(file, PU_IMG_OPTS);
    if (!dataURL) return;           // it already toasted the reason
    const shrunk = await fetch(dataURL).then(r => r.blob());
    const base = (file.name || 'popup').replace(/\.[^.]+$/, '');
    file = new File([shrunk], base + '.jpg', { type: shrunk.type || 'image/jpeg' });
  }
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
  const title = $('#pu-title_en').value.trim() || $('#pu-title_cn').value.trim();
  const body  = $('#pu-body_en').value.trim()  || $('#pu-body_cn').value.trim()  || '';
  const cta   = $('#pu-cta_label_en').value.trim() || $('#pu-cta_label_cn').value.trim() || '';
  const img   = $('#pu-image_url').value;
  const dismissible = $('#pu-dismissible').checked;
  // A picture with no words is a whole pop-up, and that's what the customer
  // sees — so don't invent a headline under it. The placeholder only stands
  // in while the pop-up has nothing at all, to keep the frame from reading
  // as broken on a fresh one.
  const shownTitle = title || ((!body && !cta && !img) ? 'Pop-up title' : '');
  const tEl = $('#pu-preview-title');
  tEl.textContent = shownTitle;
  tEl.style.display = shownTitle ? '' : 'none';
  const bEl = $('#pu-preview-body');
  bEl.textContent = body;
  bEl.style.display = body ? '' : 'none';
  const cEl = $('#pu-preview-cta');
  cEl.textContent = cta;
  cEl.style.display = cta ? '' : 'none';
  // A real <img>, not a background: the slot has to take the picture's own
  // shape so nothing is cropped. CSS caps the height; the browser scales the
  // whole image down from there.
  const iEl = $('#pu-preview-img');
  if (img) { iEl.src = img; iEl.style.display = ''; }
  else     { iEl.removeAttribute('src'); iEl.style.display = 'none'; }
  // Picture with nothing to say — let the card be the picture, the way the
  // customer's pop-up renders it.
  $('#pu-preview-modal').classList.toggle('pu-no-text', !!img && !shownTitle && !body && !cta);
  $('#pu-preview-close').style.display = dismissible ? '' : 'none';
}

document.addEventListener('input',  e => { if (e.target.id?.startsWith('pu-')) { updatePopupPreview(); refreshPopupStepSummaries(); } });
document.addEventListener('change', e => {
  if (e.target.id === 'pu-trigger') $('#pu-delay-wrap').style.display = e.target.value === 'after_seconds' ? '' : 'none';
  if (e.target.id?.startsWith('pu-')) { updatePopupPreview(); refreshPopupStepSummaries(); }
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
  puStamp(next);
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
  if (!(await askConfirm({ title: 'Delete this pop-up? · 删除此弹窗?', confirmLabel: 'Delete · 删除', danger: true }))) return;
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

