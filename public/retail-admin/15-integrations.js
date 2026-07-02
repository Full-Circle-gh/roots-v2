/* eslint-disable no-undef */
/* Channels & Delivery hub — the card grid for sales channels + logistics plugins. */
/* namespace: ig* */

(function () {
  'use strict';

  let _cards = [];
  let _stores = [];
  let _initiated = false;

  // Status → { label EN·CN, dot colour, pill class }. Kept honest: a card is only
  // "connected" when its integration row says so.
  const STATUS = {
    connected:      { en: 'Connected',   cn: '已连接',   dot: 'var(--accent,#6B8E6F)', cls: 'ok' },
    configured:     { en: 'Ready to set up', cn: '待设置', dot: 'var(--brass,#B08D4A)', cls: 'warn' },
    in_setup:       { en: 'In setup',    cn: '设置中',   dot: 'var(--brass,#B08D4A)', cls: 'warn' },
    connecting:     { en: 'Connecting…', cn: '连接中…',  dot: 'var(--brass,#B08D4A)', cls: 'warn' },
    error:          { en: 'Needs attention', cn: '需处理', dot: 'var(--danger,#e8556a)', cls: 'err' },
    paused:         { en: 'Paused',      cn: '已暂停',   dot: 'var(--text-3,#7d7a72)', cls: 'muted' },
    not_configured: { en: 'Not set up',  cn: '未配置',   dot: 'var(--text-4,#56544f)', cls: 'muted' },
  };

  // ── Entry point ────────────────────────────────────────────────────────────
  window.igAdminInit = async function () {
    if (_initiated) return;
    _initiated = true;
    await igLoad();
    // The cards render in one language under data-no-i18n, so repaint on EN/CN flips.
    if (window.onLangChange) onLangChange(function () { igRender(); });
  };

  window.igLoad = async function () {
    const box = document.getElementById('ig-cards');
    if (box && !box.children.length) box.innerHTML = igMuted(cuT('Loading…', '加载中…'));
    try {
      const r = await api('/api/retail-admin/channel-hub');
      _cards = r.data || [];
      _stores = r.stores || [];
      igRender();
    } catch (e) {
      if (box) box.innerHTML = igMuted(esc(e.message));
    }
  };

  function igRender() {
    const box = document.getElementById('ig-cards');
    if (!box) return;
    if (!_cards.length) { box.innerHTML = igMuted(cuT('No channels available.', '暂无可用渠道。')); return; }
    box.innerHTML = _cards.map(igCard).join('');
  }

  function igCard(c) {
    const st = STATUS[c.status] || STATUS.not_configured;
    const label = cuT(c.labelEn, c.labelCn);
    const blurb = cuT(c.blurbEn, c.blurbCn);
    const glyph = igGlyph(c.kind);

    // Health line: prefer a real health payload, else the blurb.
    let health = blurb;
    if (c.health && (c.health.last_error || c.health.detail)) {
      health = `<span class="ig-err">${esc(c.health.last_error || c.health.detail)}</span>`;
    }

    // Per-store pills for channel/logistics cards.
    let stores = '';
    if ((c.category === 'channel' || c.category === 'logistics') && _stores.length) {
      stores = `<div class="ig-stores">` + _stores.map(s =>
        `<span class="ig-pill-store"><i class="ig-dot" style="background:${st.dot}"></i>${esc(cuT(s.name || s.code, s.name || s.code))}</span>`
      ).join('') + `</div>`;
    }

    // Open to-dos (e.g. "link the new location") — brass, dismissable.
    let todos = '';
    const todoList = (c.config && Array.isArray(c.config.todos)) ? c.config.todos : [];
    if (todoList.length) {
      todos = todoList.map(t => `<div class="ig-todo">
        <span>⚑ ${cuT(`New location ${esc(t.store_name || t.store_code)} — link it here`,
                      `新门店 ${esc(t.store_name || t.store_code)} — 请在此关联`)}</span>
        <button class="ig-x" title="Dismiss · 忽略" onclick="igDismissTodo('${escJs(c.kind)}','${escJs(t.id)}')">✕</button>
      </div>`).join('');
    }

    // Primary action by state.
    let action, meta = '';
    if (c.status === 'connected') {
      action = `<button class="btn btn-sm" onclick="igManage('${c.kind}')">${cuT('Manage · 管理', '管理')}</button>`;
    } else if (c.status === 'error') {
      action = `<button class="btn btn-sm btn-primary" onclick="igManage('${c.kind}')">${cuT('Fix · 修复', '修复')}</button>`;
    } else if (c.category === 'first_party') {
      action = `<button class="btn btn-sm" onclick="igManage('${c.kind}')">${cuT('Manage · 管理', '管理')}</button>`;
    } else {
      action = `<button class="btn btn-sm btn-primary" onclick="igSetup('${c.kind}')">${cuT('Set up · 开始设置', '开始设置')}</button>`;
      if (c.estimateEn) meta = `<span class="ig-meta">${esc(cuT(c.estimateEn, c.estimateCn))}</span>`;
    }

    return `<div class="ig-card">
      <div class="ig-head">
        <span class="ig-glyph">${glyph}</span>
        <span class="ig-name">${esc(label)}</span>
        <span class="ig-status ig-${st.cls}"><i class="ig-dot" style="background:${st.dot}"></i>${cuT(st.en, st.cn)}</span>
      </div>
      <div class="ig-health">${health}</div>
      ${stores}
      ${todos}
      <div class="ig-foot">${action}<span class="ig-spacer"></span>${meta}</div>
    </div>`;
  }

  window.igDismissTodo = async function (kind, todoId) {
    try {
      await api(`/api/retail-admin/channel-hub/${encodeURIComponent(kind)}/todos/dismiss`, {
        method: 'POST', body: { todoId },
      });
      igLoad();
    } catch (e) { /* surfaced by api() */ }
  };

  // ── Actions ─────────────────────────────────────────────────────────────────
  // Phase 1: the per-plugin wizards arrive in later phases. For now Set up /
  // Manage opens the help-aware placeholder so the flow (and Get help) is real.
  window.igSetup = function (kind) { igOpenPlaceholder(kind, 'setup'); };
  window.igManage = function (kind) { igOpenPlaceholder(kind, 'manage'); };

  function igOpenPlaceholder(kind, mode) {
    const c = _cards.find(x => x.kind === kind);
    const label = c ? cuT(c.labelEn, c.labelCn) : kind;
    const msg = mode === 'manage'
      ? cuT(`${label}: management screen is coming soon.`, `${label}:管理界面即将上线。`)
      : cuT(`${label}: guided setup is coming soon. Need it now? Tap “Get help”.`,
            `${label}:引导式设置即将上线。需要现在接入?点击“获取帮助”。`);
    if (window.toast) toast(msg);
  }

  // "Get help" — logs a contextual request and pages platform ops.
  window.igHelp = async function (kind) {
    const c = kind ? _cards.find(x => x.kind === kind) : null;
    const label = c ? cuT(c.labelEn, c.labelCn) : cuT('setup', '设置');
    const note = window.prompt(cuT(
      `Tell us what you're stuck on with ${label} (optional):`,
      `请告诉我们您在${label}遇到的问题(可选):`), '');
    if (note === null) return; // cancelled
    try {
      await api('/api/retail-admin/channel-hub/help', {
        method: 'POST',
        body: { kind: kind || 'general', note: note || '' },
      });
      if (window.toast) toast(cuT('Help request sent — we’ll be in touch.', '求助已发送 — 我们会尽快联系您。'));
    } catch (e) { /* surfaced by api() */ }
  };

  // ── Add-location wizard ─────────────────────────────────────────────────────
  // Step 1: the store form (code, names, address with district picker, hours,
  // pickup). Step 2 (after save): "wire into your channels" — which connected
  // integrations got a link-this-store to-do, plus quota/zone pointers.
  window.igAddLocation = function () {
    const box = document.getElementById('ig-locwiz');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = `<div class="ig-wiz">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <strong>${cuT('Add location · 新增门店', '新增门店')}</strong>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div class="ig-wiz-grid">
        <div><label class="field-label">Code · 短标识 <span style="color:var(--text-3);font-weight:400">— e.g. haizhu</span></label>
          <input type="text" id="igl_code" placeholder="haizhu" style="font-family:monospace"></div>
        <div><label class="field-label">Phone · 电话</label><input type="text" id="igl_phone" placeholder="020-XXXXXXXX"></div>
        <div><label class="field-label">Name (EN)</label><input type="text" id="igl_name_en" placeholder="Roots — Haizhu"></div>
        <div><label class="field-label">名称 (CN)</label><input type="text" id="igl_name_cn" placeholder="Roots · 海珠店"></div>
        <div><label class="field-label">City · 城市</label>
          <input type="text" id="igl_city" value="广州" onchange="igLocDistricts()"></div>
        <div><label class="field-label">District · 区</label>
          <select id="igl_district"></select></div>
        <div class="wide"><label class="field-label">${cuT('Street address · 详细地址', '详细地址')} <span style="color:var(--text-3);font-weight:400">${cuT('— GPS auto-locates from this on save · 保存时按地址自动定位', '— 保存时按地址自动定位')}</span></label>
          <input type="text" id="igl_address" placeholder="海珠区江南西路 88 号"></div>
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label class="field-label">Opens · 开门</label><input type="time" id="igl_open"></div>
          <div style="flex:1"><label class="field-label">Closes · 关门</label><input type="time" id="igl_close"></div>
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:6px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="igl_pickup" style="width:16px;height:16px">${cuT('Offer store pickup · 到店自提', '到店自提')}
          </label>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
        <button class="btn btn-primary" id="igl_save" onclick="igLocSave()">${cuT('Save location · 保存门店', '保存门店')}</button>
        <button class="btn" onclick="igLocClose()">${cuT('Cancel · 取消', '取消')}</button>
        <span class="ig-spacer" style="flex:1"></span>
        <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('general')">? ${cuT('Get help · 获取帮助', '获取帮助')}</button>
      </div>
    </div>`;
    igLocDistricts();
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.igLocClose = function () {
    const box = document.getElementById('ig-locwiz');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  };

  // Populate the district <select> from the shared china-districts endpoint.
  // Unknown city → free-entry fallback (a blank select with a hint option).
  window.igLocDistricts = async function () {
    const sel = document.getElementById('igl_district');
    const city = (document.getElementById('igl_city')?.value || '').trim();
    if (!sel) return;
    let list = [];
    try {
      const r = await api(`/api/retail/districts?city=${encodeURIComponent(city)}`);
      list = r.data || [];
    } catch (_) { list = []; }
    if (!list.length) {
      sel.innerHTML = `<option value="">${cuT('— enter city first · 请先填写城市 —', '— 请先填写城市 —')}</option>`;
      return;
    }
    sel.innerHTML = list.map(d =>
      `<option value="${esc(d.name_cn)}">${esc(cuT(`${d.name_cn} ${d.name_en || ''}`.trim(), d.name_cn))}</option>`).join('');
  };

  window.igLocSave = async function () {
    const v = id => (document.getElementById(id)?.value || '').trim();
    const code = v('igl_code');
    if (!code) { if (window.toast) toast(cuT('Code required · 请填写短标识', '请填写短标识'), 'error'); return; }
    const body = {
      code,
      name_en: v('igl_name_en'), name_cn: v('igl_name_cn'),
      city: v('igl_city'), district: v('igl_district'),
      address: v('igl_address'), phone: v('igl_phone'),
      pickup_enabled: !!document.getElementById('igl_pickup')?.checked,
      open_time: v('igl_open') || null, close_time: v('igl_close') || null,
    };
    const btn = document.getElementById('igl_save');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/retail-admin/stores', { method: 'POST', body });
      igLocDone(r.data, r.channelTodos || []);
    } catch (e) {
      if (btn) btn.disabled = false;
      if (e.code === 'code_taken' && window.toast) toast(cuT('That code is taken · 该标识已被使用', '该标识已被使用'), 'error');
    }
  };

  // Step 2: what to wire up next. Honest per-channel state: connected channels
  // got a to-do on their card; everything else is a pointer, not magic.
  function igLocDone(store, channelTodos) {
    const box = document.getElementById('ig-locwiz');
    if (!box) return;
    const name = esc(store.name_en || store.name_cn || store.code);
    const rows = [];
    rows.push(`<div class="ig-linkrow"><div class="grow"><b>${cuT('Mini App · 小程序', '小程序')}</b><br>
      <span class="muted" style="font-size:12px">${cuT('Appears in the store picker automatically · 自动加入门店选择', '自动加入门店选择')}</span></div>
      <span style="color:var(--accent,#6B8E6F);font-size:12px;font-weight:600">✓ ${cuT('Ready · 自动就绪', '自动就绪')}</span></div>`);
    for (const t of channelTodos) {
      rows.push(`<div class="ig-linkrow"><div class="grow"><b>${esc(cuT(t.labelEn, t.labelCn))}</b><br>
        <span class="muted" style="font-size:12px">${cuT('A “link this store” to-do was added to its card below · 已在下方卡片添加“关联门店”待办', '已在下方卡片添加“关联门店”待办')}</span></div>
        <span style="color:var(--brass,#B08D4A);font-size:12px;font-weight:600">⚑ ${cuT('To-do · 待办', '待办')}</span></div>`);
    }
    rows.push(`<div class="ig-linkrow"><div class="grow"><b>${cuT('Stock & quotas · 库存与配额', '库存与配额')}</b><br>
      <span class="muted" style="font-size:12px">${cuT('New stores start un-counted; set stock when ready · 新门店初始未盘点,可随时录入库存', '新门店初始未盘点,可随时录入库存')}</span></div>
      <button class="btn btn-sm" onclick="goTab('products')">${cuT('Open products · 打开产品', '打开产品')}</button></div>`);
    rows.push(`<div class="ig-linkrow"><div class="grow"><b>${cuT('Delivery zones · 配送区域', '配送区域')}</b><br>
      <span class="muted" style="font-size:12px">${cuT('Zones are city-wide and already cover the new store · 配送区域按城市划分,已覆盖新门店', '配送区域按城市划分,已覆盖新门店')}</span></div>
      <button class="btn btn-sm" onclick="goTab('delivery')">${cuT('Review zones · 查看区域', '查看区域')}</button></div>`);
    box.innerHTML = `<div class="ig-wiz">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong>✓ ${cuT(`${name} saved — wire it into your channels`, `${name} 已保存 — 接入渠道`)}</strong>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:8px">
        ${cuT('GPS locates from the address in the background. · GPS 将按地址在后台自动定位。', 'GPS 将按地址在后台自动定位。')}</div>
      ${rows.join('')}
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-primary" onclick="igLocClose()">${cuT('Done · 完成', '完成')}</button>
      </div>
    </div>`;
    igLoad(); // refresh cards so the new to-dos show
  }

  // ── util ────────────────────────────────────────────────────────────────────
  function igMuted(s) { return `<div class="muted" style="font-size:13px;padding:10px 2px">${s}</div>`; }
  function escJs(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function igGlyph(kind) {
    const map = { wechat_miniapp: 'WX', web: 'WB', eleme: 'EL', meituan: 'MT', jd: 'JD', qingyun: 'QY' };
    return esc(map[kind] || kind.slice(0, 2).toUpperCase());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
})();
