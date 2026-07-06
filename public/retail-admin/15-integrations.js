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

  // Where the wizards (setup / add-location / help) render. The channels UI now
  // lives ON the Sales page (#sales-setup-host); the legacy #ig-locwiz is a
  // fallback so the functions keep working if that host isn't present.
  function igHostEl() { return document.getElementById('sales-setup-host') || document.getElementById('ig-locwiz'); }

  // The current status of a plugin from the last igLoad() (used by the Sales
  // page to decide Set up vs Configure). Returns 'not_configured' if unknown.
  window.igStatusFor = function (kind) {
    const c = _cards.find(x => x.kind === kind);
    return c ? c.status : 'not_configured';
  };
  // Ensure the hub data (_cards/_stores) is loaded before a wizard that needs it
  // (the Sales page calls this on init). Safe to call repeatedly.
  window.igEnsureLoaded = async function () { if (!_cards.length) { try { await igLoad(); } catch (_) {} } return _cards; };

  // Launch the right setup flow for a plugin from a Sales-page "Set up" button.
  // Use salesGo() (clicks the nav button) rather than goTab() for tabs that need
  // their init to run — goTab only switches the section, leaving the page blank.
  window.igLaunchSetup = function (kind) {
    if (kind === 'meituan' || kind === 'qingyun') { igRelayWizard(kind); return; }
    if (kind === 'wechat_miniapp') { igMiniappConfig(); return; }
    if (kind === 'web') { igWebConfig(); return; }
    if (kind === 'eleme') { igElemeWizard(); return; }                                       // guided connect → shops → products → verify
    if (kind === 'jd') {                                                                    // JD keys + Save & test — Delivery tab's JD page
      if (typeof salesGo === 'function') salesGo('delivery');
      if (typeof dlvGo === 'function') dlvGo('jd');
      return;
    }
    igOpenPlaceholder(kind, 'setup');
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
  // Each card is a front door: Set up / Manage deep-links into the plugin's own
  // admin where one already exists (Eleme, Meituan, JD lives in Settings).
  // Plugins whose dedicated flow lands in a later phase (Qingyun) keep the
  // help-aware placeholder so the flow — and Get help — is always real.
  const TAB_FOR = { eleme: 'eleme', jd: 'config' };
  const RELAY_KINDS = { meituan: 1, qingyun: 1 };
  function igGo(kind) {
    const tab = TAB_FOR[kind];
    if (tab && typeof goTab === 'function') { goTab(tab); return true; }
    return false;
  }
  window.igSetup = function (kind) {
    if (kind === 'wechat_miniapp') { igMiniappWizard(); return; }
    if (RELAY_KINDS[kind]) { igRelayWizard(kind); return; }
    if (!igGo(kind)) igOpenPlaceholder(kind, 'setup');
  };
  window.igManage = function (kind) {
    if (kind === 'web') { igWebConfig(); return; }
    if (kind === 'wechat_miniapp') { igMiniappWizard(); return; }
    // Meituan management (product mapping etc.) has its own tab; Qingyun re-opens
    // the relay wizard to re-verify a session.
    if (kind === 'meituan' && typeof goTab === 'function') { goTab('meituan'); return; }
    if (RELAY_KINDS[kind]) { igRelayWizard(kind); return; }
    if (!igGo(kind)) igOpenPlaceholder(kind, 'manage');
  };

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
    const box = igHostEl();
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
          <input type="text" id="igl_city" value="广州市" onchange="igLocDistricts()"></div>
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
    const box = igHostEl();
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
    const box = igHostEl();
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

  // ── Login-relay wizard (Meituan / Qingyun) ──────────────────────────────────
  // Session-based channels have no API: the worker drives the portal login and,
  // when it SMS-challenges, the merchant types the code here and we relay it.
  // Steps: store box → credentials → verify login (SMS) → done.
  let _relay = { kind: null, step: 'box', store: null, poll: null };
  // opts: { step: 'creds', store: 'yuexiu' } — re-login jumps straight to the
  // login step with the store preselected (the box is already installed).
  window.igRelayWizard = function (kind, opts) {
    igRelayStop();
    _relay = { kind, step: (opts && opts.step) || 'box', store: (opts && opts.store) || null, poll: null };
    igRelayRender();
  };
  window.igRelayClose = function () { igRelayStop(); const b = igHostEl(); if (b) { b.style.display = 'none'; b.innerHTML = ''; } };
  function igRelayStop() { if (_relay.poll) { clearInterval(_relay.poll); _relay.poll = null; } }

  function igRelayRender() {
    const box = igHostEl(); if (!box) return;
    box.style.display = '';
    const c = _cards.find(x => x.kind === _relay.kind) || {};
    const label = cuT(c.labelEn || _relay.kind, c.labelCn || _relay.kind);
    const rail = ['box', 'creds', 'sms', 'done'];
    const railLabels = { box: cuT('Get the box', '获取盒子'), creds: cuT('Your login', '商家账号'), sms: cuT('Text code', '短信验证'), done: cuT('Done', '完成') };
    const cur = rail.indexOf(_relay.step);
    const railHtml = rail.map((k, i) => `<span style="font-size:12px;color:${i === cur ? 'var(--text-1)' : 'var(--text-3)'};font-weight:${i === cur ? 600 : 400}">${i < cur ? '✓ ' : (i + 1) + '. '}${railLabels[k]}</span>`).join('<span style="color:var(--text-4)"> › </span>');
    let body = '';
    if (_relay.step === 'box') {
      // Step 1 is a real physical box we ship. The request is remembered on the
      // integration row (config.box) so this screen stays truthful across visits.
      const boxSt = (c.config && c.config.box) || null;
      if (boxSt && (boxSt.status === 'requested' || boxSt.status === 'shipped' || boxSt.status === 'delivered')) {
        const st = boxSt.status;
        const when = String((st === 'delivered' ? boxSt.delivered_at : st === 'shipped' ? boxSt.shipped_at : boxSt.requested_at) || '').slice(0, 10);
        const head = st === 'delivered' ? cuT('Box delivered', '盒子已送达')
          : st === 'shipped' ? cuT('Box shipped — on its way', '盒子已寄出 — 在路上')
          : cuT('Box requested', '已申请盒子');
        const copy = st === 'delivered'
          ? cuT('Your box has arrived. Plug it into your shop’s internet, then continue below.',
                '盒子已送达。请接入门店网络,然后点击继续。')
          : st === 'shipped'
            ? cuT('Your box is on the way. When it arrives, plug it into your shop’s internet and continue below.',
                  '盒子已在路上。到货后请接入门店网络,然后点击继续。')
            : cuT('We got your request. Our team will contact you to arrange delivery and any cost. Once the box arrives, plug it into your shop’s internet and continue below.',
                  '我们已收到申请。团队会联系您安排寄送及费用。盒子到货后,请接入门店网络,然后点击继续。');
        const tracking = boxSt.tracking
          ? `<div style="font-size:12.5px;margin-top:8px;color:var(--text-2)">${cuT('Tracking', '快递')}: <span style="font-family:var(--f-mono,monospace)">${esc(boxSt.tracking)}</span></div>`
          : '';
        body = `<div style="font-size:14px;color:var(--accent,#6B8E6F);font-weight:600">✓ ${head}${when ? ` <span style="color:var(--text-3);font-weight:400">${esc(when)}</span>` : ''}</div>
          <p class="muted" style="font-size:13px;max-width:56ch;margin-top:6px">${copy}</p>
          ${tracking}
          <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
            <button class="btn btn-primary" onclick="igRelayStep('creds')">${cuT('Box is plugged in — continue', '盒子已接入 — 继续')}</button>
            <button class="btn" onclick="igRelayClose()">${cuT('Close', '关闭')}</button>
            <span class="ig-spacer" style="flex:1"></span>
            <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('${escJs(_relay.kind)}')">? ${cuT('Get help', '获取帮助')}</button>
          </div>`;
      } else {
        body = `<p class="muted" style="font-size:13px;max-width:56ch">${cuT(
          `${label} setup starts with a small box we ship to you. Plug it into your shop’s internet — it makes your ${label} logins come from your own shop, which keeps your account safe. We set this up together and help at every step.`,
          `${label}设置的第一步是我们寄给您的小盒子。将它接入门店网络后,${label}的登录都来自您自己的门店,账号更安全。我们会全程协助您完成设置。`)}</p>
        <p class="muted" style="font-size:12px;max-width:56ch;margin-top:6px;color:var(--text-3)">${cuT(
          'After you request it, our team contacts you to arrange delivery and any cost.',
          '提交申请后,团队会联系您安排寄送及费用。')}</p>
        <div style="display:flex;gap:10px;margin-top:16px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="rl_boxreq" onclick="igRelayBoxRequest()">${cuT('Request the box', '申请盒子')}</button>
          <button class="btn" onclick="igRelayStep('creds')">${cuT('I already have it — continue', '已有盒子 — 继续')}</button>
          <button class="btn" onclick="igRelayClose()">${cuT('Cancel', '取消')}</button>
          <span class="ig-spacer" style="flex:1"></span>
          <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('${escJs(_relay.kind)}')">? ${cuT('Get help', '获取帮助')}</button>
        </div>`;
      }
    } else if (_relay.step === 'creds') {
      const opts = _stores.map(s => `<option value="${esc(s.code)}"${s.code === _relay.store ? ' selected' : ''}>${esc(cuT(s.name || s.code, s.name || s.code))}</option>`).join('');
      body = `<p class="muted" style="font-size:13px">${cuT(`Enter your ${label} merchant login for a store. We log in on your behalf through your store box.`, `请输入某门店的${label}商家账号。我们将通过您的门店盒子代为登录。`)}</p>
        <div style="display:grid;gap:10px;max-width:420px;margin-top:12px">
          <div><label class="field-label">${cuT('Store · 门店', '门店')}</label><select id="rl_store">${opts}</select></div>
          <div><label class="field-label">${cuT('Username · 账号', '账号')}</label><input type="text" id="rl_user" autocomplete="off"></div>
          <div><label class="field-label">${cuT('Password · 密码', '密码')}</label><input type="password" id="rl_pass" autocomplete="new-password"></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
          <button class="btn btn-primary" id="rl_start" onclick="igRelayStart()">${cuT('Log in · 登录', '登录')}</button>
          <button class="btn" onclick="igRelayClose()">${cuT('Cancel · 取消', '取消')}</button>
          <span class="ig-spacer" style="flex:1"></span>
          <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('${escJs(_relay.kind)}')">? ${cuT('Get help · 获取帮助', '获取帮助')}</button>
        </div>`;
    } else if (_relay.step === 'sms') {
      const s = _relay.session || {};
      body = `<p class="muted" style="font-size:13px">${cuT(`${label} sent a code to`, `${label}已发送验证码至`)} <b>${esc(s.phoneHint || '—')}</b>. ${cuT('Enter it below.', '请在下方输入。')}</p>
        <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
          <input type="text" id="rl_code" inputmode="numeric" maxlength="8" placeholder="000000" style="width:140px;font-family:var(--f-mono,monospace);font-size:18px;letter-spacing:.2em;text-align:center">
          <button class="btn btn-primary" id="rl_sms" onclick="igRelaySms()">${cuT('Verify · 验证', '验证')}</button>
        </div>
        <div id="rl_status" style="font-size:12.5px;color:var(--text-2);margin-top:12px">${cuT('Logging in through your store box…', '正在通过门店盒子登录…')}</div>
        ${s.lastError ? `<div style="color:var(--danger);font-size:12.5px;margin-top:6px">${esc(s.lastError)}</div>` : ''}
        <div style="background:var(--bg-elev-1);border:1px solid var(--line);border-left:3px solid var(--brass);border-radius:6px;padding:12px 14px;margin-top:16px;display:flex;gap:12px;align-items:center">
          <div style="font-size:12.5px;color:var(--text-2);max-width:48ch">${cuT(`Having trouble? We can connect ${label} for you.`, `遇到困难?我们可以为您代为接入${label}。`)}</div>
          <button class="btn" style="margin-left:auto;flex:none" onclick="igHelp('${escJs(_relay.kind)}')">${cuT('Ask us · 请代办', '请代办')}</button>
        </div>`;
    } else if (_relay.step === 'done') {
      // Meituan has a mapping tab (门店/products); Qingyun is rider-tracking only.
      const nextEn = _relay.kind === 'meituan'
        ? 'This store is now logged in. Next: map your Meituan 门店 and products from the Meituan tab.'
        : 'This store is now logged in. Rider tracking will start syncing automatically.';
      const nextCn = _relay.kind === 'meituan'
        ? '该门店已登录。接下来在美团页面关联门店与商品。'
        : '该门店已登录。骑手追踪将自动开始同步。';
      const openBtn = _relay.kind === 'meituan'
        ? `<button class="btn btn-primary" onclick="igRelayClose();goTab('meituan')">${cuT('Open Meituan · 打开美团', '打开美团')}</button>`
        : '';
      body = `<div style="font-size:14px;color:var(--accent,#6B8E6F);font-weight:600">✓ ${cuT('Connected · 已连接', '已连接')}</div>
        <p class="muted" style="font-size:13px;margin-top:6px">${cuT(nextEn, nextCn)}</p>
        <div style="display:flex;gap:10px;margin-top:14px">
          ${openBtn}
          <button class="btn ${openBtn ? '' : 'btn-primary'}" onclick="igRelayClose()">${cuT('Done · 完成', '完成')}</button>
        </div>`;
    }
    box.innerHTML = `<div class="ig-wiz">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>${cuT('Set up', '设置')} ${esc(label)}</strong>
        <button class="btn btn-sm" onclick="igRelayClose()">✕</button>
      </div>
      <div style="margin-bottom:14px">${railHtml}</div>
      ${body}
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  window.igRelayStep = function (step) { _relay.step = step; igRelayRender(); };

  // Request the physical store box: remember it + page ops, then repaint step 1
  // in its "requested" state (igLoad refreshes _cards so the state sticks).
  window.igRelayBoxRequest = async function () {
    const btn = document.getElementById('rl_boxreq'); if (btn) btn.disabled = true;
    try {
      await api(`/api/retail-admin/channel-hub/${encodeURIComponent(_relay.kind)}/box-request`, { method: 'POST', body: {} });
      await igLoad();
      igRelayRender();
      if (window.toast) toast(cuT('Box requested — we’ll contact you', '已申请 — 我们会联系您'));
    } catch (e) {
      if (btn) btn.disabled = false;
      if (window.toast) toast(cuT('Request failed — try again', '申请失败,请重试'), 'error');
    }
  };

  window.igRelayStart = async function () {
    const store = (document.getElementById('rl_store') || {}).value;
    const username = (document.getElementById('rl_user') || {}).value;
    const password = (document.getElementById('rl_pass') || {}).value;
    if (!store || !username || !password) { if (window.toast) toast(cuT('Fill in all fields · 请填写所有字段', '请填写所有字段'), 'error'); return; }
    const btn = document.getElementById('rl_start'); if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/retail-admin/channel-hub/${encodeURIComponent(_relay.kind)}/session/start`, { method: 'POST', body: { storeCode: store, username, password } });
      _relay.store = store; _relay.session = r.session;
      igRelayAfter(r.session);
    } catch (e) { if (btn) btn.disabled = false; }
  };

  window.igRelaySms = async function () {
    const code = (document.getElementById('rl_code') || {}).value;
    if (!code) return;
    const btn = document.getElementById('rl_sms'); if (btn) btn.disabled = true;
    try {
      const r = await api(`/api/retail-admin/channel-hub/${encodeURIComponent(_relay.kind)}/session/sms`, { method: 'POST', body: { storeCode: _relay.store, code } });
      _relay.session = r.session;
      igRelayAfter(r.session);
    } catch (e) { if (btn) btn.disabled = false; const el = document.getElementById('rl_status'); if (el) el.textContent = cuT('Verification failed — try again.', '验证失败,请重试。'); }
  };

  // Advance the wizard from a session snapshot.
  function igRelayAfter(s) {
    if (!s) return;
    if (s.status === 'awaiting_sms' || s.status === 'captcha') { _relay.step = 'sms'; igRelayRender(); }
    else if (s.status === 'ok') { _relay.step = 'done'; igRelayStop(); igRelayRender(); igLoad(); }
    else if (s.status === 'failed') { _relay.step = 'sms'; igRelayRender(); }
    else { _relay.step = 'sms'; igRelayRender(); }
  }

  // ── Meituan "Configure" — one clean front door (sibling of Mini App / Web) ──
  // A new store (not connected) gets the box-first setup wizard. A connected
  // store gets a tidy summary + a button into the full Meituan management tab,
  // so Configure is consistent with the other channels instead of dumping the
  // operator straight into the raw management screen.
  // "3 min ago" for the daemon-written UTC timestamps ("YYYY-MM-DD HH:MM:SS").
  function igAgo(ts) {
    if (!ts) return cuT('never', '从未');
    const t = Date.parse(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
    if (!t) return '—';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return cuT('just now', '刚刚');
    if (m < 60) return cuT(`${m} min ago`, `${m}分钟前`);
    const h = Math.floor(m / 60);
    if (h < 24) return cuT(`${h} h ago`, `${h}小时前`);
    const d = Math.floor(h / 24);
    return cuT(`${d} d ago`, `${d}天前`);
  }

  // One store's connection row on the Meituan page: signed-in state, which
  // account (masked), and the live proof it's working. "Sign in again" only
  // appears when the session actually needs it.
  function igMtStoreRow(s) {
    const name = esc(cuT(s.name, s.nameCn || s.name));
    let chip;
    if (s.signedIn === true) {
      chip = `<span class="mc-chip on">${MC_SVG.check}<span>${cuT('Signed in', '已登录')}</span></span>`;
    } else if (s.signedIn === false) {
      chip = `<span class="mc-chip" style="color:var(--danger,#e8556a)">${MC_SVG.circle}<span>${cuT('Needs sign-in', '需重新登录')}</span></span>`;
    } else {
      chip = `<span class="mc-chip">${MC_SVG.circle}<span>${cuT('No activity yet', '暂无活动')}</span></span>`;
    }
    const relogin = s.signedIn === false
      ? `<button class="btn btn-sm btn-primary" onclick="igRelayWizard('meituan',{step:'creds',store:'${escJs(s.code)}'})">${cuT('Sign in again', '重新登录')}</button>`
      : '';
    const facts = [];
    if (s.account) facts.push(`${cuT('Account', '账号')} <span style="font-family:var(--f-mono,monospace)">${esc(s.account)}</span>`);
    // "Live" = matched + pushing stock (same meaning as the Meituan tab's "N
    // live"). Unmatched rows are frozen, so call them out separately, never as
    // "syncing".
    const liveN = Number(s.liveProducts || 0);
    const unmatched = Number(s.notMatched || 0);
    facts.push(`${liveN} ${cuT('products live', '个商品已上架')}`);
    if (unmatched) facts.push(`<span style="color:var(--brass,#B08D4A)">${unmatched} ${cuT('not matched', '个未匹配')}</span>`);
    if (s.open === true) facts.push(cuT('Store open on Meituan', '门店美团营业中'));
    else if (s.open === false) facts.push(cuT('Store closed on Meituan', '门店美团已置休'));
    const live = [
      `${cuT('Last stock push', '最近库存推送')} ${igAgo(s.lastStockPush)}`,
      `${cuT('last order', '最近订单')} ${igAgo(s.lastOrder)}`,
      `${cuT('orders today', '今日订单')} ${Number(s.ordersToday || 0)}`,
    ].join(' · ');
    return `<div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-top:8px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="font-size:13.5px">${name}</b>
        <span style="flex:1"></span>
        ${chip}${relogin}
      </div>
      <div style="font-size:12.5px;color:var(--text-2);margin-top:6px">${facts.join(' · ')}</div>
      <div style="font-size:12.5px;color:var(--text-3);margin-top:3px">${live}</div>
    </div>`;
  }

  window.igMeituanConfig = async function () {
    await igEnsureLoaded();
    const status = igStatusFor('meituan');
    const connected = status === 'connected' || status === 'paused';
    if (!connected) { igRelayWizard('meituan'); return; }   // new store → box-first setup

    const box = igHostEl(); if (!box) return;
    box.style.display = '';
    box.innerHTML = igMuted(cuT('Loading…', '加载中…'));
    // Per-store connection detail (signed-in, last sync, last order). Falls back
    // to the plain store list if the endpoint isn't reachable.
    let detail = [];
    try { const r = await api('/api/retail-admin/channel-hub/meituan/stores'); detail = r.data || []; } catch (_) {}
    if (!detail.length) detail = (_stores || []).map(s => ({ code: s.code, name: s.name || s.code, nameCn: s.name || s.code, signedIn: null, liveProducts: 0, notMatched: 0, ordersToday: 0 }));
    const bag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
    const paused = status === 'paused';
    const storeRows = detail.map(igMtStoreRow).join('');

    box.innerHTML = `<div class="ig-wiz">
      <div class="mc-head">
        <div>
          <strong style="font-size:16px">${cuT('Meituan', '美团')}</strong>
          <div class="mc-subtitle">${cuT('Waimai + Shangou — stock sync and order import.', '外卖 + 闪购 — 库存同步与订单导入。')}</div>
        </div>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div class="mc-chips">
        <span class="mc-chip${paused ? '' : ' on'}">${paused ? MC_SVG.circle : MC_SVG.check}<span>${paused ? cuT('Paused', '已暂停') : cuT('Connected', '已连接')}</span></span>
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${bag}</span><b>${cuT('Your stores', '您的门店')}</b></div>
        <div class="mc-purpose">${cuT('Meituan keeps stock in sync and imports new orders for these stores.', '美团为这些门店同步库存并导入新订单。')}</div>
        ${storeRows || `<div class="mc-note">${cuT('No stores linked yet.', '尚未关联门店。')}</div>`}
      </div>

      <div class="mc-foot">
        <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px;padding:0" onclick="igHelp('meituan')">? ${cuT('Get help', '获取帮助')}</button>
        <span class="ig-spacer"></span>
        <button class="btn" onclick="igRelayWizard('meituan')">${cuT('Connect another store', '连接其他门店')}</button>
        <button class="btn btn-primary" onclick="igLocClose();goTab('meituan')">${cuT('Manage products & orders', '管理商品与订单')}</button>
      </div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // ── Eleme guided setup wizard ───────────────────────────────────────────────
  // Authorize (OAuth per store) → Link shops → Map products → Verify & enable.
  // Reuses the existing Eleme endpoints (/api/retail-admin/eleme/*). When the
  // platform Eleme app isn't configured on the server yet, step 1 shows the
  // honest assisted state instead of a raw .env error.
  window.igElemeWizard = async function () {
    const box = igHostEl(); if (!box) return;
    box.style.display = ''; box.innerHTML = igMuted(cuT('Loading Eleme setup… · 加载饿了么设置…', '加载饿了么设置…'));
    let cfg = { configured: false, enabled: false }, stores = [];
    try { cfg = await api('/api/retail-admin/eleme/config'); } catch (_) {}
    try { const r = await api('/api/retail-admin/eleme/stores'); stores = r.stores || r.data || []; } catch (_) {}
    igElemeRender(cfg, stores);
  };

  function igElemeRender(cfg, stores) {
    const box = igHostEl(); if (!box) return;
    const connectedCount = stores.filter(s => Number(s.connected) === 1).length;
    const shopCount = stores.filter(s => !!s.shop_id).length;
    // Which step is live.
    let step = 'authorize';
    if (cfg.configured && connectedCount > 0 && shopCount < connectedCount) step = 'shops';
    else if (cfg.configured && connectedCount > 0 && shopCount === stores.length && stores.length) step = 'verify';
    const rail = ['authorize', 'shops', 'products', 'verify'];
    const railLabels = {
      authorize: cuT('Authorize · 授权', '授权'), shops: cuT('Link shops · 关联门店', '关联门店'),
      products: cuT('Map products · 商品映射', '商品映射'), verify: cuT('Verify & enable · 验证并开启', '验证并开启'),
    };
    const cur = rail.indexOf(step);
    const railHtml = rail.map((k, i) => `<span style="font-size:12px;color:${i === cur ? 'var(--text-1)' : 'var(--text-3)'};font-weight:${i === cur ? 600 : 400}">${i < cur ? '✓ ' : (i + 1) + '. '}${railLabels[k]}</span>`).join('<span style="color:var(--text-4)"> › </span>');

    let body;
    if (!cfg.configured) {
      // Platform Eleme app not set up on the server — assisted state, not a dev error.
      body = `<div style="background:var(--bg-elev-1);border:1px solid var(--line);border-left:3px solid var(--brass);border-radius:6px;padding:14px 16px">
        <div style="font-weight:600;font-size:13.5px;margin-bottom:4px">${cuT('Eleme isn’t switched on for your account yet', '饿了么尚未为您的账号开通')}</div>
        <div style="font-size:12.5px;color:var(--text-2);max-width:60ch">${cuT(
          'Eleme connects through our official Eleme open-platform app. It needs a one-time platform setup (Eleme app keys) before you can authorize your shops — this is on us, not something you configure. Tap below and we’ll get it enabled.',
          '饿了么通过我们的官方开放平台应用接入,需要先完成一次性平台配置(饿了么应用密钥)才能授权您的店铺 — 这由我们完成。点击下方,我们将为您开通。')}</div>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button class="btn btn-sm btn-primary" onclick="igHelp('eleme')">${cuT('Request Eleme setup · 申请开通饿了么', '申请开通饿了么')}</button>
          <button class="btn btn-sm" onclick="igLocClose()">${cuT('Close · 关闭', '关闭')}</button>
        </div>
      </div>`;
    } else if (step === 'authorize' || step === 'shops') {
      const rows = stores.map(s => {
        const connected = Number(s.connected) === 1;
        const shopSet = !!s.shop_id;
        let right;
        if (!connected) right = `<button class="btn btn-sm btn-primary" onclick="igElemeConnect(${s.id}, '${escJs(s.code)}')">${cuT('Connect · 连接', '连接')}</button>`;
        else if (!shopSet) right = `<span style="display:flex;gap:6px;align-items:center"><input id="igel-shop-${s.id}" placeholder="${cuT('Eleme shop id', '店铺ID')}" style="width:130px"><button class="btn btn-sm btn-primary" onclick="igElemeShop(${s.id},'${escJs(s.code)}')">${cuT('Save', '保存')}</button></span>`;
        else right = `<span style="color:var(--accent,#6B8E6F);font-size:12.5px">✓ ${esc(s.shop_name || s.shop_id)}</span>`;
        return `<div class="ig-linkrow"><div class="grow"><b>${esc(s.name || s.code)}</b></div>${right}</div>`;
      }).join('');
      body = `<p class="muted" style="font-size:13px">${cuT('Authorize each store to its Eleme shop. You’ll be sent to Eleme to approve, then back here.', '为每个门店授权对应的饿了么店铺。将跳转至饿了么授权后返回。')}</p>
        <div style="margin-top:8px">${rows || igMuted(cuT('No stores yet.', '暂无门店。'))}</div>
        <div style="display:flex;gap:10px;margin-top:14px"><button class="btn" onclick="igLocClose()">${cuT('Close · 关闭', '关闭')}</button></div>`;
    } else if (step === 'verify') {
      body = `<p class="muted" style="font-size:13px">${cuT('All stores connected. Map products by SKU on the Eleme page, then switch the channel on.', '所有门店已连接。请在饿了么页面按货号映射商品,然后开启渠道。')}</p>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-primary" onclick="igElemeEnable()">${cuT('Enable channel · 开启渠道', '开启渠道')}</button>
          <button class="btn" onclick="igLocClose();salesGo('eleme')">${cuT('Map products · 商品映射', '商品映射')}</button>
        </div>`;
    }
    box.innerHTML = `<div class="ig-wiz">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>${cuT('Set up Eleme · 设置饿了么', '设置饿了么')}</strong>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div style="margin-bottom:14px">${railHtml}</div>
      ${body}
      <div class="helpbar" style="margin-top:14px"><button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('eleme')">? ${cuT('Get help · 获取帮助', '获取帮助')}</button></div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  window.igElemeConnect = async function (storeId, storeCode) {
    try {
      const r = await api(`/api/retail-admin/eleme/oauth/start?storeId=${storeId}&storeCode=${encodeURIComponent(storeCode)}`);
      if (r && r.url) window.location.href = r.url;
    } catch (e) { /* surfaced by api() */ }
  };
  window.igElemeShop = async function (storeId, storeCode) {
    const inp = document.getElementById('igel-shop-' + storeId);
    const shopId = inp ? inp.value.trim() : '';
    if (!shopId) return;
    try { await api('/api/retail-admin/eleme/shop', { method: 'POST', body: { storeId, storeCode, shopId } }); igElemeWizard(); igLoad(); }
    catch (e) { /* surfaced by api() */ }
  };
  window.igElemeEnable = async function () {
    try { await api('/api/retail-admin/eleme/enable', { method: 'POST', body: { enabled: true } }); if (window.toast) toast(cuT('Eleme enabled · 已开启', '已开启')); igLocClose(); igLoad(); }
    catch (e) { /* surfaced by api() */ }
  };

  // ── Mini App configuration — the credentials, one clean page ────────────────
  // WeChat Mini Program (AppID + AppSecret) and WeChat Pay. Non-secret values
  // (AppID, merchant id, serial) pre-fill; secrets show as "set" and stay masked
  // — you paste a new value only to replace one. For the env-managed account
  // (Roots) everything shows already filled from the server config, so it reads
  // as done. (The China business-registration checklist deliberately does NOT
  // live here — this page is only about entering credentials.)
  // Monochrome line icons for the config page (mockup: reference/miniapp-config-mockup.html).
  const MC_SVG = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.3 2.3 4.7-4.9"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/><path d="M6.5 14.5h4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11.5v4.5"/><path d="M12 8h.01"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  // Info dot: the "where do I find this?" explanations live in a hover tooltip
  // now (data-tip), not as always-on grey text under every field. Keyboard-
  // reachable (tabindex) so the hint is available without a mouse.
  function mcInfo(en, cn) {
    const t = esc(cuT(en, cn));
    return `<span class="mc-info" tabindex="0" role="note" aria-label="${t}" data-tip="${t}">${MC_SVG.info}</span>`;
  }
  function mcSaveBtnHtml() { return `${MC_SVG.shield}<span>${cuT('Save & verify', '保存并验证')}</span>`; }

  // Router: a brand-new account gets the step-by-step setup wizard; an account
  // that finished setup (or the env-managed Roots) gets the one-page summary.
  // "Finished" = login pair set AND payments set-or-skipped ("Skip for now"
  // remembers in localStorage so the wizard doesn't nag on every open).
  const MW_SKIP_KEY = 'fc_miniapp_pay_skip';
  let _mwCfg = null;   // last-loaded credential picture, shared by the wizard steps
  function mwPaySkipped() { try { return localStorage.getItem(MW_SKIP_KEY) === '1'; } catch (_) { return false; } }
  function mwResumeStep() {
    const st = (_mwCfg && _mwCfg.status) || {};
    if (!st.wechatLoginReady) return 1;
    if (!(_mwCfg && _mwCfg.pay && _mwCfg.pay.mchId)) return 2;
    return 3;
  }
  window.igMiniappConfig = async function () {
    const box = igHostEl(); if (!box) return;
    box.style.display = ''; box.innerHTML = igMuted(cuT('Loading Mini App config…', '加载小程序配置…'));
    let cfg;
    try { cfg = await api('/api/retail-admin/channel-hub/miniapp/wechat-config'); }
    catch (e) { box.innerHTML = igMuted(cuT('Failed to load', '加载失败')); return; }
    _mwCfg = cfg;
    const st = cfg.status || {};
    if (cfg.source === 'env' || (st.wechatLoginReady && (st.payReady || mwPaySkipped()))) return igMiniappConfigFull(cfg);
    igMiniappSetup(mwResumeStep());
  };
  // Re-enter the wizard from the summary page ("Setup guide" button).
  window.igMiniappSetupStart = function () {
    try { localStorage.removeItem(MW_SKIP_KEY); } catch (_) {}
    igMiniappSetup(mwResumeStep());
  };

  window.igMiniappConfigFull = async function (preloaded) {
    const box = igHostEl(); if (!box) return;
    let cfg = preloaded;
    if (!cfg) {
      box.style.display = ''; box.innerHTML = igMuted(cuT('Loading Mini App config…', '加载小程序配置…'));
      try { cfg = await api('/api/retail-admin/channel-hub/miniapp/wechat-config'); }
      catch (e) { box.innerHTML = igMuted(cuT('Failed to load', '加载失败')); return; }
      _mwCfg = cfg;
    }
    const st = cfg.status || {};
    const pay = cfg.pay || {};
    const env = cfg.source === 'env';   // env-managed account (Roots): read-only view

    const chip = (ok, en, cn) => `<span class="mc-chip${ok ? ' on' : ''}">${ok ? MC_SVG.check : MC_SVG.circle}<span>${cuT(en, cn)}</span></span>`;
    // tip: [en, cn] pair → an info dot after the label (hover reveals it).
    const txt = (id, label, val, tip) => `<div class="mc-f"><label class="field-label">${label}${tip ? mcInfo(tip[0], tip[1]) : ''}</label>
      <input type="text" id="${id}" value="${esc(val || '')}" spellcheck="false" autocapitalize="off" style="font-family:var(--f-mono,monospace)"${env ? ' readonly' : ''}></div>`;
    // Secret field: saved secrets show a locked "Saved" row; Replace reveals an
    // empty input (blank on save = keep the stored value, matching the API).
    const sec = (id, label, isSet, o) => {
      o = o || {};
      const cls = 'mc-f' + (o.wide ? ' wide' : '');
      const optTag = o.optional ? `<span class="mc-opt">${cuT('Optional', '选填')}</span>` : '';
      const tip = o.tip ? mcInfo(o.tip[0], o.tip[1]) : '';
      const field = o.pem
        ? `<textarea id="${id}" rows="3" placeholder="${o.ph || ''}" spellcheck="false" style="width:100%;font-family:var(--f-mono,monospace);font-size:11.5px"></textarea>`
        : `<input type="password" id="${id}" autocomplete="new-password" placeholder="${o.ph || ''}">`;
      if (!isSet) return `<div class="${cls}"><label class="field-label">${label}${optTag}${tip}</label>${field}</div>`;
      return `<div class="${cls}" id="${id}_f"><label class="field-label">${label}${optTag}${tip}</label>
        <div class="mc-saved">${MC_SVG.lock}<span class="tx"><span class="dots">••••••••</span><span>${cuT('Saved', '已保存')}</span></span>
          ${env ? '' : `<button type="button" class="btn btn-sm" onclick="igMcReplace('${id}_f')">${cuT('Replace', '更换')}</button>`}</div>
        <div class="mc-edit">${field}<div class="mc-keep-row"><button type="button" class="mc-keep" onclick="igMcKeep('${id}_f')">${cuT('Keep saved value', '保留已保存的值')}</button></div></div>
        </div>`;
    };

    box.innerHTML = `<div class="ig-wiz mc-wiz">
      <div class="mc-head">
        <strong class="mc-title">${cuT('Mini App configuration', '小程序配置')}</strong>
        <div style="display:flex;gap:8px;align-items:center">
          ${env ? '' : `<button class="btn btn-sm" onclick="igMiniappSetupStart()">${cuT('Setup guide', '设置向导')}</button>`}
          <button class="btn btn-sm btn-icon" onclick="igLocClose()" aria-label="${cuT('Close', '关闭')}">${MC_SVG.x}</button>
        </div>
      </div>
      <div class="mc-chips">
        ${chip(st.wxAppIdSet, 'Mini program linked', '小程序已绑定')}
        ${chip(st.wechatLoginReady, 'Customer login ready', '顾客登录可用')}
        ${chip(st.payReady, 'WeChat Pay ready', '微信支付可用')}
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.phone}</span><b>${cuT('WeChat Mini Program', '微信小程序')}</b>${mcInfo('Runs the storefront and signs customers in.', '用于店面展示和顾客登录。')}</div>
        <div class="ig-wiz-grid">
          ${txt('mc_appid', 'AppID', cfg.appId, ['WeChat MP console → Development → Development settings.', '微信公众平台 → 开发 → 开发设置。'])}
          ${sec('mc_secret', 'AppSecret', cfg.appSecretSet, { ph: cuT('Paste the AppSecret', '粘贴 AppSecret'), tip: ['Leave as is unless WeChat issued a new secret.', '除非微信重置了密钥，否则保持原样。'] })}
        </div>
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.card}</span><b>${cuT('WeChat Pay', '微信支付')}</b>${mcInfo('Takes payment inside the mini app.', '在小程序内向顾客收款。')}</div>
        <div class="ig-wiz-grid">
          ${txt('mc_mchid', cuT('Merchant ID', '商户号'), pay.mchId, ['WeChat Pay merchant platform → Account center.', '微信支付商户平台 → 账户中心。'])}
          ${txt('mc_serial', cuT('Certificate serial', '证书序列号'), pay.serialNo, ['Shown next to the API certificate in API security.', '在 API 安全页的 API 证书旁显示。'])}
          ${sec('mc_v3', cuT('API v3 key', 'APIv3 密钥'), pay.apiV3KeySet, { ph: cuT('Paste the API v3 key', '粘贴 APIv3 密钥'), tip: ['A 32-character key you set yourself in WeChat Pay → API security.', '在 微信支付 → API 安全 里由你自己设定的 32 位密钥。'] })}
          <div></div>
          ${sec('mc_pkey', cuT('Merchant private key', '商户私钥'), pay.privateKeySet,
            { pem: true, wide: true, ph: cuT('Paste the full PEM, including the BEGIN and END lines', '粘贴完整 PEM，包含 BEGIN 与 END 行'),
              tip: ['Open apiclient_key.pem (from the certificate tool) and paste all of it, BEGIN and END lines included.', '打开证书工具生成的 apiclient_key.pem，全部内容(含 BEGIN 与 END 行)粘贴进来。'] })}
          ${sec('mc_pubkey', cuT('WeChat platform public key', '微信平台公钥'), pay.platformPubKeySet,
            { pem: true, wide: true, optional: true, ph: cuT('Paste PEM contents', '粘贴 PEM 内容'),
              tip: ['Only needed if your merchant account uses platform public keys instead of platform certificates.', '仅当商户账号使用平台公钥(而非平台证书)时需要。'] })}
        </div>
      </div>

      <div class="mc-foot">
        <button class="helplink" onclick="igHelp('wechat_miniapp')">${MC_SVG.info}<span>${cuT('Get help', '获取帮助')}</span></button>
        ${env ? `<span class="mc-note">${cuT('Filled from the server config for this account.', '本账号由服务器配置填充。')}</span>` : ''}
        <span class="ig-spacer"></span>
        <span id="mc_result" style="font-size:12.5px"></span>
        <button class="btn" onclick="igLocClose()">${cuT('Close', '关闭')}</button>
        <button class="btn btn-primary" id="mc_save" onclick="igSaveMiniappCreds()">${mcSaveBtnHtml()}</button>
      </div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  // Back-compat alias (older callers used igMiniappWizard).
  window.igMiniappWizard = function () { return igMiniappConfig(); };

  window.igMcReplace = function (fid) {
    const f = document.getElementById(fid); if (!f) return;
    f.classList.add('open');
    const inp = f.querySelector('.mc-edit input, .mc-edit textarea');
    if (inp) inp.focus();
  };
  window.igMcKeep = function (fid) {
    const f = document.getElementById(fid); if (!f) return;
    f.classList.remove('open');
    const inp = f.querySelector('.mc-edit input, .mc-edit textarea');
    if (inp) inp.value = '';   // typed-then-cancelled must not be submitted
  };

  window.igSaveMiniappCreds = async function () {
    const v = id => { const el = document.getElementById(id); return el && el.value ? el.value.trim() : ''; };
    const body = {
      appId: v('mc_appid'), appSecret: v('mc_secret'),
      mchId: v('mc_mchid'), apiV3Key: v('mc_v3'), serialNo: v('mc_serial'),
      privateKey: v('mc_pkey'), platformPubKey: v('mc_pubkey'),
    };
    const out = document.getElementById('mc_result'), btn = document.getElementById('mc_save');
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = `<span class="mc-spin"></span><span>${cuT('Verifying…', '验证中…')}</span>`;
    }
    if (out) { out.textContent = ''; }
    try {
      const r = await api('/api/retail-admin/channel-hub/miniapp/wechat-creds', { method: 'POST', body });
      if (r.verified) {
        if (btn) { btn.classList.add('mc-ok'); btn.innerHTML = `${MC_SVG.tick}<span>${cuT('Verified', '已验证')}</span>`; }
        if (out) { out.style.color = 'var(--accent,#6B8E6F)'; out.textContent = cuT('Saved — WeChat accepted the credentials.', '已保存 — 微信验证通过。'); }
      } else {
        if (btn) { btn.disabled = false; btn.innerHTML = mcSaveBtnHtml(); }
        if (out) { out.style.color = 'var(--brass,#B08D4A)'; out.textContent = cuT('Saved, but WeChat rejected the login pair: ', '已保存，但微信校验未通过：') + (r.error || ''); }
      }
      igLoad();
      setTimeout(igMiniappConfigFull, 1600);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = mcSaveBtnHtml(); }
      if (out) { out.style.color = 'var(--danger)'; out.textContent = (e && e.code === 'appid_taken') ? cuT('That AppID is already in use.', '该 AppID 已被占用。') : (e && e.code === 'bad_appid' ? cuT('AppID must look like wx + 16 chars.', 'AppID 格式应为 wx + 16 位。') : cuT('Save failed', '保存失败')); }
    }
  };

  // ── Mini App setup wizard — the first-run flow ──────────────────────────────
  // New accounts see this instead of the credentials form: three short steps
  // (link the mini program → merchant account → payment keys), each with a
  // "where do I find this" walkthrough, a direct link to the right WeChat
  // console, and a live check against WeChat before moving on. When it's done
  // (or payments are skipped) the account sees the normal one-page summary.
  const MW_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>';
  const MW_STEPS = () => [
    { n: 1, en: 'Link mini program', cn: '绑定小程序', ico: MC_SVG.phone },
    { n: 2, en: 'Merchant account', cn: '商户号', ico: MC_SVG.card },
    { n: 3, en: 'Payment keys', cn: '支付密钥', ico: MC_SVG.shield },
  ];
  function mwNextHtml(step) {
    if (step === 1) return `${MC_SVG.shield}<span>${cuT('Verify & continue', '验证并继续')}</span>`;
    if (step === 2) return `<span>${cuT('Continue', '继续')}</span>`;
    return `${MC_SVG.shield}<span>${cuT('Verify & finish', '验证并完成')}</span>`;
  }
  function mwOpenBtn(url, en, cn) {
    return `<button type="button" class="btn btn-sm mw-open" onclick="window.open('${url}','_blank')">${MW_OPEN}<span>${cuT(en, cn)}</span></button>`;
  }
  function mwSay(t, bad) {
    const out = document.getElementById('mw_msg');
    if (out) { out.style.color = bad ? 'var(--danger)' : 'var(--accent,#6B8E6F)'; out.textContent = t; }
  }
  function mwBusy(on, step) {
    const btn = document.getElementById('mw_next'); if (!btn) return false;
    if (on) {
      if (btn.disabled) return false;
      btn.disabled = true;
      btn.innerHTML = `<span class="mc-spin"></span><span>${cuT('Checking with WeChat…', '正在向微信验证…')}</span>`;
    } else { btn.disabled = false; btn.innerHTML = mwNextHtml(step); }
    return true;
  }
  const mwV = id => { const el = document.getElementById(id); return el && el.value ? el.value.trim() : ''; };

  window.igMiniappSetup = function (step) {
    const box = igHostEl(); if (!box) return;
    const cfg = _mwCfg || {};
    const rail = MW_STEPS().map(s => `<span class="mw-step${s.n < step ? ' done' : s.n === step ? ' now' : ''}">
      <span class="n">${s.n < step ? MC_SVG.tick : s.n}</span><span>${cuT(s.en, s.cn)}</span></span>`).join('');

    let body = '';
    if (step === 1) {
      body = `
      <div class="mc-sec" style="border-top:none;padding-top:6px">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.phone}</span><b>${cuT('Link your mini program', '绑定你的小程序')}</b></div>
        <div class="mc-purpose">${cuT('The mini program is your storefront inside WeChat. Two values connect it: AppID and AppSecret.', '小程序是你在微信里的店面。绑定需要两项：AppID 和 AppSecret。')}</div>
        <div class="mw-help">
          <div class="mw-help-head"><span>${cuT('Where do I find these?', '在哪里找到它们？')}</span><span class="ig-spacer"></span>
            ${mwOpenBtn('https://mp.weixin.qq.com', 'Open the mini program console', '打开小程序后台')}</div>
          <ol>
            <li>${cuT('Sign in with the WeChat account that owns your mini program.', '用拥有该小程序的微信账号登录。')}</li>
            <li>${cuT('In the left menu open “开发管理”, then the “开发设置” tab (Development management → Development settings).', '在左侧菜单打开「开发管理」，再选「开发设置」。')}</li>
            <li>${cuT('AppID is the first item on that page — copy it here.', 'AppID 是页面上的第一项 — 复制到这里。')}</li>
            <li>${cuT('For AppSecret press “生成” (Generate). WeChat shows it only once — copy it right away. Lost an old one? Press “重置” (Reset) to get a new one.', 'AppSecret 点「生成」。微信只显示一次 — 立即复制。旧的丢了就点「重置」换新的。')}</li>
          </ol>
        </div>
        <div class="ig-wiz-grid">
          <div class="mc-f"><label class="field-label">AppID</label>
            <input type="text" id="mw_appid" value="${esc(cfg.appId || '')}" placeholder="wx0000000000000000" spellcheck="false" autocapitalize="off" style="font-family:var(--f-mono,monospace)"></div>
          <div class="mc-f"><label class="field-label">AppSecret</label>
            <input type="password" id="mw_secret" autocomplete="new-password" placeholder="${cfg.appSecretSet ? cuT('Saved — leave blank to keep it', '已保存 — 留空即保留') : cuT('Paste the AppSecret', '粘贴 AppSecret')}"></div>
        </div>
        <div class="mw-skip"><span>${cuT('Don’t have these on hand? Set this up later — the rest of your backend keeps working, and the Mini app card will remind you what’s left.', '手头没有这些资料？可以稍后再设置 — 后台其他功能照常使用，小程序卡片会提醒你还差什么。')}</span>
          <button type="button" class="btn btn-sm" onclick="igMwLater()">${cuT('Do it later', '稍后再做')}</button></div>
      </div>`;
    } else if (step === 2) {
      body = `
      <div class="mc-sec" style="border-top:none;padding-top:6px">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.card}</span><b>${cuT('Your WeChat Pay merchant account', '你的微信支付商户号')}</b></div>
        <div class="mc-purpose">${cuT('This is what lets the mini app take payment. You only need one number here.', '有了它，小程序才能收款。这一步只需要一个号码。')}</div>
        <div class="mw-help">
          <div class="mw-help-head"><span>${cuT('Where do I find it?', '在哪里找？')}</span><span class="ig-spacer"></span>
            ${mwOpenBtn('https://pay.weixin.qq.com', 'Open the merchant console', '打开商户平台')}</div>
          <ol>
            <li>${cuT('Sign in to the WeChat Pay merchant console.', '登录微信支付商户平台。')}</li>
            <li>${cuT('Open “账户中心” (Account center).', '打开「账户中心」。')}</li>
            <li>${cuT('Your merchant ID (商户号) is the number shown at the top — usually 10 digits.', '商户号显示在页面顶部 — 通常是 10 位数字。')}</li>
          </ol>
        </div>
        <div class="ig-wiz-grid">
          <div class="mc-f"><label class="field-label">${cuT('Merchant ID', '商户号')}</label>
            <input type="text" id="mw_mchid" value="${esc((cfg.pay && cfg.pay.mchId) || '')}" placeholder="1230000109" spellcheck="false" inputmode="numeric" style="font-family:var(--f-mono,monospace)"></div>
        </div>
        <div class="mw-skip"><span>${cuT('No WeChat Pay merchant account yet? Skip this — your storefront still works, and you can add payments here any time.', '还没有微信支付商户号？可以先跳过 — 店面照常运行，之后随时回来补上。')}</span>
          <button type="button" class="btn btn-sm" onclick="igMwSkipPay()">${cuT('Do it later', '稍后再做')}</button></div>
      </div>`;
    } else {
      body = `
      <div class="mc-sec" style="border-top:none;padding-top:6px">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.shield}</span><b>${cuT('Payment keys', '支付密钥')}</b></div>
        <div class="mc-purpose">${cuT('Three items, all from one page of the merchant console. When you press Verify we make a real test call to WeChat Pay.', '三项内容都在商户平台的同一个页面。点「验证」后我们会向微信支付发起一次真实测试请求。')}</div>
        <div class="mw-help">
          <div class="mw-help-head"><span>${cuT('Where do I find these?', '在哪里找到它们？')}</span><span class="ig-spacer"></span>
            ${mwOpenBtn('https://pay.weixin.qq.com', 'Open the merchant console', '打开商户平台')}</div>
          <ol>
            <li>${cuT('In the merchant console open “账户中心” → “API安全” (Account center → API security).', '在商户平台打开「账户中心」→「API安全」。')}</li>
            <li>${cuT('Certificate serial: shown next to your API certificate (API证书). Never made one? Press “申请证书” and follow the little tool it gives you.', '证书序列号：显示在 API 证书旁边。还没申请过就点「申请证书」，按工具提示操作。')}</li>
            <li>${cuT('API v3 key: a 32-character key you set yourself under “设置APIv3密钥”. If you never set one, set it there now and paste the same value here.', 'APIv3 密钥：在「设置APIv3密钥」里由你自己设定的 32 位密钥。没设过就现在设一个，并把相同的值粘贴到这里。')}</li>
            <li>${cuT('Merchant private key: the certificate tool saved a folder with a file called apiclient_key.pem. Open it with any text editor and paste everything.', '商户私钥：申请证书时工具保存的文件夹里有 apiclient_key.pem。用任意文本编辑器打开，全部复制粘贴到这里。')}</li>
          </ol>
        </div>
        <div class="ig-wiz-grid">
          <div class="mc-f"><label class="field-label">${cuT('Certificate serial', '证书序列号')}</label>
            <input type="text" id="mw_serial" value="${esc((cfg.pay && cfg.pay.serialNo) || '')}" spellcheck="false" autocapitalize="off" style="font-family:var(--f-mono,monospace)"></div>
          <div class="mc-f"><label class="field-label">${cuT('API v3 key', 'APIv3 密钥')}</label>
            <input type="password" id="mw_v3" autocomplete="new-password" placeholder="${(cfg.pay && cfg.pay.apiV3KeySet) ? cuT('Saved — leave blank to keep it', '已保存 — 留空即保留') : cuT('The 32-character key', '32 位密钥')}"></div>
          <div class="mc-f wide"><label class="field-label">${cuT('Merchant private key', '商户私钥')}<span class="mc-file">apiclient_key.pem</span></label>
            <textarea id="mw_pkey" rows="3" placeholder="${(cfg.pay && cfg.pay.privateKeySet) ? cuT('Saved — leave blank to keep it', '已保存 — 留空即保留') : cuT('Paste the full PEM, including the BEGIN and END lines', '粘贴完整 PEM，包含 BEGIN 与 END 行')}" spellcheck="false" style="width:100%;font-family:var(--f-mono,monospace);font-size:11.5px"></textarea></div>
        </div>
        <div class="mw-escape" style="text-align:left;margin-top:8px">
          <button type="button" onclick="igMwTogglePub()">${cuT('My account uses platform public keys (rare)', '我的商户号使用平台公钥（少见）')}</button>
        </div>
        <div class="ig-wiz-grid" id="mw_pub_wrap" style="display:none;margin-top:8px">
          <div class="mc-f wide"><label class="field-label">${cuT('WeChat platform public key', '微信平台公钥')}<span class="mc-opt">${cuT('Optional', '选填')}</span></label>
            <textarea id="mw_pubkey" rows="3" placeholder="${cuT('Paste PEM contents', '粘贴 PEM 内容')}" spellcheck="false" style="width:100%;font-family:var(--f-mono,monospace);font-size:11.5px"></textarea></div>
        </div>
        <div class="mw-skip"><span>${cuT('Keys not ready? Skip this — everything you entered stays saved, and the finish page shows a shortcut back here.', '密钥还没准备好？可以先跳过 — 已填内容都会保存，完成页有快捷入口回到这里。')}</span>
          <button type="button" class="btn btn-sm" onclick="igMwSkipPay()">${cuT('Do it later', '稍后再做')}</button></div>
      </div>`;
    }

    box.style.display = '';
    box.innerHTML = `<div class="ig-wiz">
      <div class="mc-head">
        <div>
          <strong style="font-size:16px">${cuT('Set up your Mini App', '设置你的小程序')}</strong>
          <div class="mc-subtitle">${cuT('Three short steps. Skip any of them and come back later.', '三个小步骤。任何一步都可以先跳过，之后再回来。')}</div>
        </div>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div class="mw-steps">${rail}</div>
      ${body}
      <div class="mc-foot">
        <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px;padding:0" onclick="igHelp('wechat_miniapp')">? ${cuT('Get help', '获取帮助')}</button>
        <span class="ig-spacer"></span>
        <span id="mw_msg" style="font-size:12.5px;max-width:420px"></span>
        <button type="button" class="btn" id="mw_finish_anyway" style="display:none" onclick="igMwFinish(false, true)">${cuT('Finish anyway', '仍然完成')}</button>
        <button type="button" class="mw-later" onclick="${step === 1 ? 'igMwLater()' : 'igMwSkipPay()'}">${cuT('Skip this step', '跳过这一步')}</button>
        ${step > 1 ? `<button class="btn" onclick="igMiniappSetup(${step - 1})">${cuT('Back', '上一步')}</button>` : ''}
        <button class="btn btn-primary" id="mw_next" onclick="${step === 1 ? 'igMwVerifyLogin()' : step === 2 ? 'igMwSaveMch()' : 'igMwVerifyPay()'}">${mwNextHtml(step)}</button>
      </div>
      <div class="mw-escape"><button type="button" onclick="igMiniappConfigFull()">${cuT('Prefer a plain form? Open the full configuration page', '想直接填表？打开完整配置页')}</button></div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.igMwTogglePub = function () {
    const w = document.getElementById('mw_pub_wrap');
    if (w) w.style.display = w.style.display === 'none' ? '' : 'none';
  };

  // Step 1: save AppID + AppSecret, then WeChat itself confirms the pair.
  window.igMwVerifyLogin = async function () {
    const appId = mwV('mw_appid'), secret = mwV('mw_secret');
    if (!/^wx[0-9a-zA-Z]{16}$/.test(appId)) return mwSay(cuT('AppID should be “wx” followed by 16 letters or numbers.', 'AppID 应为 wx 加 16 位字母数字。'), true);
    if (!secret && !(_mwCfg && _mwCfg.appSecretSet)) return mwSay(cuT('Paste the AppSecret too.', '请同时粘贴 AppSecret。'), true);
    if (!mwBusy(true, 1)) return;
    try {
      const r = await api('/api/retail-admin/channel-hub/miniapp/wechat-creds', { method: 'POST', body: { appId, appSecret: secret } });
      if (r.verified) {
        _mwCfg = _mwCfg || {};
        _mwCfg.appId = appId;
        if (secret) _mwCfg.appSecretSet = true;
        if (r.creds) _mwCfg.status = r.creds;
        igMiniappSetup(2);
        return;
      }
      mwSay(cuT('WeChat did not accept this pair — check both values and try again. WeChat said: ', '微信未通过校验 — 请核对两项后重试。微信返回：') + (r.error || ''), true);
    } catch (e) {
      mwSay(e && e.code === 'appid_taken' ? cuT('That AppID is already used by another account here.', '该 AppID 已被其他账户使用。')
        : cuT('Could not save — try again.', '保存失败 — 请重试。'), true);
    }
    mwBusy(false, 1);
  };

  // Step 2: merchant id only — a number, no live check possible on its own.
  window.igMwSaveMch = async function () {
    const mchId = mwV('mw_mchid');
    if (!/^\d{8,12}$/.test(mchId)) return mwSay(cuT('The merchant ID is a number, usually 10 digits.', '商户号是数字，通常 10 位。'), true);
    if (!mwBusy(true, 2)) return;
    try {
      await api('/api/retail-admin/channel-hub/miniapp/wechat-creds', { method: 'POST', body: { mchId } });
      _mwCfg = _mwCfg || {}; _mwCfg.pay = _mwCfg.pay || {}; _mwCfg.pay.mchId = mchId;
      igMiniappSetup(3);
      return;
    } catch (e) { mwSay(cuT('Could not save — try again.', '保存失败 — 请重试。'), true); }
    mwBusy(false, 2);
  };

  window.igMwSkipPay = function () {
    try { localStorage.setItem(MW_SKIP_KEY, '1'); } catch (_) {}
    igMwFinish(true, false);
  };

  // Step 1 "Do it later": nothing works without the AppID pair, so deferring
  // step 1 just closes the wizard — the channel card keeps saying "Set up".
  window.igMwLater = function () { igLocClose(); };

  // Step 3: save the keys, then a real signed test call to WeChat Pay.
  window.igMwVerifyPay = async function () {
    const p = (_mwCfg && _mwCfg.pay) || {};
    const body = { serialNo: mwV('mw_serial'), apiV3Key: mwV('mw_v3'), privateKey: mwV('mw_pkey'), platformPubKey: mwV('mw_pubkey') };
    if (!body.serialNo && !p.serialNo) return mwSay(cuT('Fill in the certificate serial.', '请填写证书序列号。'), true);
    if (!body.apiV3Key && !p.apiV3KeySet) return mwSay(cuT('Fill in the API v3 key.', '请填写 APIv3 密钥。'), true);
    if (body.apiV3Key && body.apiV3Key.length !== 32) return mwSay(cuT('The API v3 key is exactly 32 characters — this one isn’t.', 'APIv3 密钥应为 32 位 — 当前长度不对。'), true);
    if (!body.privateKey && !p.privateKeySet) return mwSay(cuT('Paste the private key file’s contents.', '请粘贴私钥文件内容。'), true);
    if (body.privateKey && body.privateKey.indexOf('PRIVATE KEY') === -1) return mwSay(cuT('That doesn’t look like the key file — paste all of apiclient_key.pem, including the BEGIN and END lines.', '内容不像私钥文件 — 请粘贴完整的 apiclient_key.pem，包含 BEGIN 与 END 行。'), true);
    if (!mwBusy(true, 3)) return;
    try {
      const r = await api('/api/retail-admin/channel-hub/miniapp/wechat-pay-verify', { method: 'POST', body });
      if (r.verified && r.v3KeyOk !== false) {
        try { localStorage.removeItem(MW_SKIP_KEY); } catch (_) {}
        igMwFinish(false, false);
        return;
      }
      const fa = document.getElementById('mw_finish_anyway'); if (fa) fa.style.display = '';
      if (r.verified && r.v3KeyOk === false) {
        mwSay(cuT('Almost: WeChat accepted the merchant ID, serial and private key, but the API v3 key is wrong — check the 32-character key and try again.', '差一点：商户号、序列号和私钥都通过了，但 APIv3 密钥不对 — 请核对那串 32 位密钥后重试。'), true);
      } else if (r.error === 'bad_private_key') {
        mwSay(cuT('The private key doesn’t look right — paste the whole apiclient_key.pem, including the BEGIN and END lines.', '私钥内容不对 — 请粘贴完整的 apiclient_key.pem，包含 BEGIN 与 END 行。'), true);
      } else if (r.error === 'missing_fields') {
        mwSay(cuT('Fill in the serial, the v3 key and the private key first.', '请先填写序列号、APIv3 密钥和私钥。'), true);
      } else {
        mwSay(cuT('WeChat Pay did not accept the keys. WeChat said: ', '微信支付未通过校验。微信返回：') + (r.error || ''), true);
      }
    } catch (e) { mwSay(cuT('Could not save — try again.', '保存失败 — 请重试。'), true); }
    mwBusy(false, 3);
  };

  // Finish screen. paySkipped = chose "Skip for now"; unverified = keys saved
  // but WeChat Pay's test call didn't pass (finish anyway).
  window.igMwFinish = function (paySkipped, unverified) {
    const box = igHostEl(); if (!box) return;
    const mchSet = !!(_mwCfg && _mwCfg.pay && _mwCfg.pay.mchId);
    const payChip = paySkipped
      ? `<span class="mc-chip later">${MC_SVG.clock}<span>${cuT('WeChat Pay — later', '微信支付 — 稍后')}</span></span>`
      : unverified
        ? `<span class="mc-chip later">${MC_SVG.clock}<span>${cuT('WeChat Pay saved — not verified yet', '微信支付已保存 — 尚未验证')}</span></span>`
        : `<span class="mc-chip on">${MC_SVG.check}<span>${cuT('WeChat Pay ready', '微信支付可用')}</span></span>`;
    const note = paySkipped
      ? cuT('Nothing is lost — everything you entered is saved, and the steps you skipped are waiting below.', '不会丢失任何内容 — 已填的都保存了，跳过的步骤列在下面。')
      : unverified
        ? cuT('Your keys are saved. Fix the failing one below and verify again whenever you’re ready.', '密钥已保存。可在下面修正后随时重新验证。')
        : cuT('Everything checked out with WeChat. Your storefront can sign customers in and take payment.', '所有项目均通过微信验证。店面已可登录顾客并收款。');
    // What's still waiting, each with a shortcut straight back to its step.
    const todoRow = (en, cn, step) => `<div class="t">${MC_SVG.clock}<span>${cuT(en, cn)}</span>
      <button type="button" class="btn btn-sm b" onclick="igMiniappSetup(${step})">${cuT('Finish now', '现在完成')}</button></div>`;
    let todos = '';
    if (paySkipped) {
      if (!mchSet) todos += todoRow('Add your WeChat Pay merchant ID', '补上微信支付商户号', 2);
      todos += todoRow('Add the payment keys so the store can take money', '补上支付密钥，店面才能收款', mchSet ? 3 : 2);
    } else if (unverified) {
      todos += todoRow('Fix the payment keys and verify again', '修正支付密钥并重新验证', 3);
    }
    const pending = paySkipped || unverified;
    box.style.display = '';
    box.innerHTML = `<div class="ig-wiz">
      <div class="mw-done">
        <div class="big${pending ? ' later' : ''}">${pending ? MC_SVG.clock : MC_SVG.tick}</div>
        <strong style="font-size:16px">${pending ? cuT('Saved — a couple of things left for later', '已保存 — 还有几项留到之后') : cuT('Your mini app is connected', '你的小程序已接入')}</strong>
        <div class="mc-subtitle" style="margin-top:6px">${note}</div>
        <div class="mc-chips" style="justify-content:center;margin-top:14px">
          <span class="mc-chip on">${MC_SVG.check}<span>${cuT('Mini program linked', '小程序已绑定')}</span></span>
          <span class="mc-chip on">${MC_SVG.check}<span>${cuT('Customer login ready', '顾客登录可用')}</span></span>
          ${paySkipped && !mchSet ? `<span class="mc-chip later">${MC_SVG.clock}<span>${cuT('Merchant account — later', '商户号 — 稍后')}</span></span>` : ''}
          ${payChip}
        </div>
        ${todos ? `<div class="mw-todo">${todos}</div>
        <div class="mc-subtitle" style="margin-top:10px">${cuT('Until payments are set up, customers can browse and sign in but not pay.', '在设置好收款前，顾客可以浏览和登录，但不能付款。')}</div>` : ''}
        <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
          <button class="btn" onclick="igLocClose()">${cuT('Close', '关闭')}</button>
          <button class="btn btn-primary" onclick="igMiniappConfigFull()">${cuT('View configuration', '查看配置')}</button>
        </div>
      </div>
    </div>`;
    igLoad();
  };

  // ── Web store configuration — sibling of the Mini App page ──────────────────
  // Shop address (free subdomain + optional custom domain with a DNS stepper),
  // which sign-in methods the shop shows (platform-provided creds → toggles, not
  // key entry), and payment readiness (WeChat Pay reuses the Mini App merchant
  // setup; Alipay is the manual QR). Design source: reference/webshop-config-mockup.html
  const WC_SVG = {
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5c2.7 2.8 4.2 6 4.2 9.5S14.7 18.7 12 21.5C9.3 18.7 7.8 15.5 7.8 12S9.3 5.3 12 2.5z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>',
    google: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 13c0-2 1.5-3 1.6-3.1C16.8 8.6 15.5 8.5 15 8.5c-1.2-.1-2.3.7-2.9.7-.6 0-1.5-.7-2.5-.7C7.5 8.6 6 9.9 6 12.5c0 1 .4 2.6 1.2 3.9.6.9 1.2 1.8 2 1.8.8 0 1.1-.5 2.1-.5s1.3.5 2.1.5c.9 0 1.4-.9 2-1.8.3-.5.5-1 .6-1.2-1.4-.5-2-1.6-2-2.9z"/><path d="M13.5 6.5c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-.9z"/></svg>',
    wechat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4C5 4 2 6.7 2 10c0 1.9 1 3.5 2.6 4.6L4 17l2.6-1.3c.8.2 1.5.3 2.4.3h.6"/><path d="M22 15c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.7 0 1.4-.1 2-.3L20 21l-.5-1.8C21 18.3 22 16.8 22 15z"/></svg>',
    alipay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M6 14c3.5 1.6 8 1.6 11-1M9.5 8.5h5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  };
  const SIGNIN_META = {
    phone:  { ico: MC_SVG.phone, en: 'Phone number', cn: '手机号', dEn: 'Six-digit code by SMS', dCn: '短信验证码' },
    email:  { ico: WC_SVG.mail,  en: 'Email', cn: '邮箱', dEn: 'Six-digit code by email', dCn: '邮件验证码' },
    google: { ico: WC_SVG.google, en: 'Google', cn: '谷歌', dEn: 'One-tap sign-in with a Google account', dCn: '谷歌账号一键登录' },
    apple:  { ico: WC_SVG.apple, en: 'Apple', cn: '苹果', dEn: 'Sign in with an Apple ID', dCn: '使用 Apple ID 登录' },
    wechat: { ico: WC_SVG.wechat, en: 'WeChat', cn: '微信', dEn: 'Sign in by scanning with WeChat', dCn: '微信扫码登录' },
  };
  const SIGNIN_ORDER = ['phone', 'email', 'google', 'apple', 'wechat'];
  let _webCfg = null;

  window.igWebConfig = async function () {
    const box = igHostEl(); if (!box) return;
    box.style.display = ''; box.innerHTML = igMuted(cuT('Loading Web store config…', '加载网页商店配置…'));
    let cfg;
    try { cfg = await api('/api/retail-admin/channel-hub/web/config'); }
    catch (e) { box.innerHTML = igMuted(cuT('Failed to load', '加载失败')); return; }
    _webCfg = cfg;

    const domains = cfg.domains || [];
    const activeD = domains.filter(d => d.status === 'active');
    const primary = activeD.find(d => d.isPrimary) || activeD[0] || null;
    const custom = domains.filter(d => d.kind !== 'subdomain');
    const av = (cfg.signin && cfg.signin.available) || {};
    const en = (cfg.signin && cfg.signin.enabled) || {};
    const anySignin = SIGNIN_ORDER.some(m => en[m]);
    const payReady = !!(cfg.pay && (cfg.pay.wechatReady || cfg.pay.alipayConfigured));

    const chip = (ok, enT, cnT) => `<span class="mc-chip${ok ? ' on' : ''}">${ok ? MC_SVG.check : MC_SVG.circle}<span>${cuT(enT, cnT)}</span></span>`;

    // Shop address block.
    let addrHtml;
    if (primary) {
      const parts = primary.host.split('.');
      const head = parts.shift();
      addrHtml = `<div class="wc-addr">
        <span class="live" title="Live"></span>
        <span class="url"><span class="pre">https://</span>${esc(head)}<span class="pre">.${esc(parts.join('.'))}</span></span>
        <button class="btn btn-sm" onclick="igWebCopy('${escJs('https://' + primary.host)}')">${WC_SVG.copy}<span style="margin-left:5px">${cuT('Copy', '复制')}</span></button>
        <button class="btn btn-sm" onclick="window.open('${escJs('https://' + primary.host)}','_blank')">${WC_SVG.open}<span style="margin-left:5px">${cuT('Open', '打开')}</span></button>
      </div>
      <div class="wc-note">${cuT('This address works immediately and never needs setup.', '该网址即刻可用,无需任何设置。')}</div>`;
    } else if (cfg.suggestedSub) {
      addrHtml = `<div class="wc-addr">
        <span class="live off" title="Reserved"></span>
        <span class="url"><span class="pre">https://</span>${esc(cfg.suggestedSub)}</span>
      </div>
      <div class="wc-note">${cuT('Your free address is reserved and will go live shortly.', '免费网址已预留,即将上线。')}</div>`;
    } else {
      addrHtml = `<div class="wc-note">${cuT('No web address yet — add your own domain below.', '尚无网页地址 — 请在下方接入自有域名。')}</div>`;
    }

    // Existing custom domains + the add/stepper flow.
    const target = cfg.cnameTarget || cfg.baseDomain || '';
    const domRows = custom.map(d => {
      const isLive = d.status === 'active';
      return `<div class="wc-dstep ${isLive ? 'done' : 'now'}" id="wcd_${d.id}">
        <span class="num">${isLive ? '✓' : '!'}</span>
        <div class="db"><div class="dt">${esc(d.host)}</div>
          <div class="dd">${isLive ? cuT('Live and secured.', '已上线并启用 HTTPS。')
            : cuT('Add a CNAME record for this name pointing to ', '为该域名添加 CNAME 记录,指向 ') + esc(target) + cuT(', then check DNS.', ',然后检测解析。')}</div>
          ${isLive ? '' : `<div class="wc-dns"><table>
            <tr><th>${cuT('Type', '类型')}</th><th>${cuT('Name', '主机记录')}</th><th>${cuT('Value', '记录值')}</th></tr>
            <tr><td>CNAME</td><td>${esc(d.host.split('.')[0])}</td><td>${esc(target)}</td></tr></table></div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-sm btn-primary" onclick="igWebCheckDns('${d.id}')">${cuT('Check DNS', '检测解析')}</button>
            <button class="btn btn-sm" onclick="igWebRemoveDomain('${d.id}','${escJs(d.host)}')">${cuT('Remove', '移除')}</button>
          </div>`}
        </div>
        <span class="stat">${isLive ? cuT('Live', '已上线') : cuT('Waiting for DNS', '等待解析')}</span>
      </div>`;
    }).join('');

    const customHtml = `<div class="wc-custom" id="wc_custom">
      <div class="wc-custom-head" onclick="document.getElementById('wc_custom').classList.toggle('open')">
        ${WC_SVG.link}
        <span class="ct"><b>${cuT('Use your own domain', '使用自有域名')}</b><span class="cs">${cuT('e.g. shop.yourbrand.com — optional', '例如 shop.yourbrand.com — 选填')}</span></span>
        ${WC_SVG.chev.replace('<svg ', '<svg class="chev" ')}
      </div>
      <div class="wc-custom-body">
        ${domRows}
        <div class="wc-di">
          <input type="text" id="wc_newdomain" placeholder="shop.yourbrand.com" spellcheck="false" autocapitalize="off">
          <button class="btn btn-primary" onclick="igWebAddDomain()">${cuT('Add domain', '添加域名')}</button>
        </div>
        <div id="wc_domain_msg" style="font-size:12px;margin-top:8px"></div>
      </div>
    </div>`;

    // Sign-in method rows.
    const methodRows = SIGNIN_ORDER.map(m => {
      const meta = SIGNIN_META[m];
      const avail = !!av[m];
      const on = !!en[m];
      const stat = avail
        ? `<span class="wc-mstat ok">✓ ${cuT('Ready', '就绪')}</span>`
        : `<span class="wc-mstat byo">${cuT('Not available yet', '暂不可用')}</span>`;
      return `<div class="wc-method">
        <span class="wc-mico">${meta.ico}</span>
        <div class="wc-mmain"><div class="mn">${cuT(meta.en, meta.cn)}</div><div class="md">${cuT(meta.dEn, meta.dCn)}</div></div>
        ${stat}
        <button class="wc-tog${on ? ' on' : ''}" data-method="${m}"${avail ? '' : ' disabled'} onclick="this.classList.toggle('on')"><span class="knob"></span></button>
      </div>`;
    }).join('');

    // Payments rows.
    const wcReady = !!(cfg.pay && cfg.pay.wechatReady);
    const aliOn = !!(cfg.pay && cfg.pay.alipayConfigured);
    const payHtml = `
      <div class="wc-pay">
        <span class="wc-mico">${WC_SVG.wechat}</span>
        <div class="wc-mmain"><div class="mn">${cuT('WeChat Pay', '微信支付')}</div><div class="md">${cuT('Uses your Mini App merchant setup — nothing to enter again.', '沿用小程序的商户配置,无需重复填写。')}</div></div>
        <span class="wc-mstat ${wcReady ? 'ok' : 'byo'}" style="margin-right:6px">${wcReady ? '✓ ' + cuT('Ready', '就绪') : cuT('Not set up', '未配置')}</span>
        <button class="btn btn-sm" onclick="igMiniappConfig()">${cuT('Open Mini App config', '打开小程序配置')}</button>
      </div>
      <div class="wc-pay">
        <span class="wc-mico">${WC_SVG.alipay}</span>
        <div class="wc-mmain"><div class="mn">${cuT('Alipay', '支付宝')}</div><div class="md">${cuT('Show your Alipay collection QR at checkout; staff confirm the transfer.', '结账时展示收款码,由店员核实到账。')}</div></div>
        <span class="wc-mstat ${aliOn ? 'ok' : 'byo'}" style="margin-right:6px">${aliOn ? '✓ ' + cuT('On', '已开启') : cuT('Optional', '选填')}</span>
        <button class="btn btn-sm" onclick="salesGo('config')">${cuT('Set up', '设置')}</button>
      </div>`;

    box.innerHTML = `<div class="ig-wiz">
      <div class="mc-head">
        <div>
          <strong style="font-size:16px">${cuT('Web store configuration', '网页商店配置')}</strong>
          <div class="mc-subtitle">${cuT('Your browser storefront — the address customers visit, how they sign in, and how they pay.', '浏览器版商店 — 顾客访问的网址、登录与付款方式。')}</div>
        </div>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div class="mc-chips">
        ${chip(!!primary, 'Store online', '商店在线')}
        ${chip(anySignin, 'Sign-in ready', '登录可用')}
        ${chip(payReady, 'Payments ready', '收款可用')}
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${WC_SVG.globe}</span><b>${cuT('Shop address', '商店网址')}</b></div>
        <div class="mc-purpose">${cuT('Where customers reach your store. A free address is included — add your own domain any time.', '顾客访问商店的网址。已含免费网址,可随时接入自有域名。')}</div>
        ${addrHtml}
        ${customHtml}
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${WC_SVG.user}</span><b>${cuT('Customer sign-in', '顾客登录')}</b></div>
        <div class="mc-purpose">${cuT('How shoppers sign in on the web. Turn on the ones you want — nothing to set up.', '顾客在网页端的登录方式。按需开启即可,无需配置。')}</div>
        ${methodRows}
      </div>

      <div class="mc-sec">
        <div class="mc-sec-head"><span class="mc-ico">${MC_SVG.card}</span><b>${cuT('Payments', '收款')}</b></div>
        <div class="mc-purpose">${cuT('How customers pay on the web. WeChat Pay uses the merchant setup from your Mini App.', '顾客在网页端的付款方式。微信支付沿用小程序的商户配置。')}</div>
        ${payHtml}
      </div>

      <div class="mc-foot">
        <button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px;padding:0" onclick="igHelp('web')">? ${cuT('Get help', '获取帮助')}</button>
        <span class="ig-spacer"></span>
        <span id="wc_result" style="font-size:12.5px"></span>
        <button class="btn" onclick="igLocClose()">${cuT('Close', '关闭')}</button>
        <button class="btn btn-primary" id="wc_save" onclick="igWebSaveSignin()">${cuT('Save changes', '保存更改')}</button>
      </div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.igWebCopy = function (url) {
    try { navigator.clipboard.writeText(url); if (window.toast) toast(cuT('Copied', '已复制')); }
    catch (_) { if (window.toast) toast(url); }
  };

  window.igWebSaveSignin = async function () {
    const body = {};
    document.querySelectorAll('.wc-tog[data-method]').forEach(t => { body[t.getAttribute('data-method')] = t.classList.contains('on'); });
    const btn = document.getElementById('wc_save'), out = document.getElementById('wc_result');
    if (btn) btn.disabled = true;
    if (out) { out.style.color = 'var(--text-3)'; out.textContent = cuT('Saving…', '保存中…'); }
    try {
      await api('/api/retail-admin/channel-hub/web/signin', { method: 'POST', body });
      if (out) { out.style.color = 'var(--accent,#6B8E6F)'; out.textContent = '✓ ' + cuT('Saved', '已保存'); }
    } catch (e) {
      if (out) { out.style.color = 'var(--danger)'; out.textContent = cuT('Save failed', '保存失败'); }
    } finally { if (btn) btn.disabled = false; }
  };

  window.igWebAddDomain = async function () {
    const inp = document.getElementById('wc_newdomain'), msg = document.getElementById('wc_domain_msg');
    const host = inp ? inp.value.trim().toLowerCase() : '';
    if (!host) return;
    if (msg) { msg.style.color = 'var(--text-3)'; msg.textContent = cuT('Adding…', '添加中…'); }
    try {
      await api('/api/retail-admin/channel-hub/web/domain', { method: 'POST', body: { host } });
      igWebConfig();
      setTimeout(() => { const c = document.getElementById('wc_custom'); if (c) c.classList.add('open'); }, 60);
    } catch (e) {
      const map = { bad_domain: cuT('Enter a valid domain (e.g. shop.example.com).', '请输入有效域名。'),
        reserved: cuT('That is a platform address — it is managed for you.', '这是平台地址,由系统托管。'),
        taken: cuT('That domain is already registered.', '该域名已被登记。'),
        already_yours: cuT('You have already added that domain.', '您已添加该域名。') };
      if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = map[e && e.code] || cuT('Could not add that domain.', '无法添加该域名。'); }
    }
  };

  window.igWebCheckDns = async function (domainId) {
    const out = document.getElementById('wc_domain_msg');
    if (out) { out.style.color = 'var(--text-3)'; out.textContent = cuT('Checking DNS…', '检测解析中…'); }
    try {
      const r = await api(`/api/retail-admin/channel-hub/web/domain/${domainId}/check`, { method: 'POST' });
      if (out) {
        if (r.pointing) { out.style.color = 'var(--accent,#6B8E6F)'; out.textContent = '✓ ' + cuT('DNS is pointing here. We’ll issue HTTPS and turn it on — usually within a few minutes.', 'DNS 已指向本平台。我们会签发 HTTPS 并开启,通常几分钟内完成。'); }
        else { out.style.color = 'var(--brass,#B08D4A)'; out.textContent = cuT('Not pointing here yet. DNS can take a while to update — try again shortly.', '尚未指向本平台。DNS 生效可能需要一些时间,请稍后重试。'); }
      }
    } catch (e) {
      if (out) { out.style.color = 'var(--danger)'; out.textContent = cuT('Check failed', '检测失败'); }
    }
  };

  window.igWebRemoveDomain = async function (domainId, host) {
    if (!window.confirm(cuT('Remove ' + host + '? Customers using it will no longer reach your store.', '移除 ' + host + '?使用该域名的顾客将无法访问您的商店。'))) return;
    try { await api(`/api/retail-admin/channel-hub/web/domain/${domainId}`, { method: 'DELETE' }); igWebConfig(); }
    catch (e) { if (window.toast) toast(cuT('Could not remove', '无法移除')); }
  };

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
