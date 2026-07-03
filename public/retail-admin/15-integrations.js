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
    if (kind === 'web') { if (window.toast) toast(cuT('Web store is always on — nothing to configure.', '网页商店常开 — 无需配置。')); return; }
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

  // ── Login-relay wizard (Meituan / Qingyun) ──────────────────────────────────
  // Session-based channels have no API: the worker drives the portal login and,
  // when it SMS-challenges, the merchant types the code here and we relay it.
  // Steps: store box → credentials → verify login (SMS) → done.
  let _relay = { kind: null, step: 'box', store: null, poll: null };
  window.igRelayWizard = function (kind) {
    igRelayStop();
    _relay = { kind, step: 'box', store: null, poll: null };
    igRelayRender();
  };
  window.igRelayClose = function () { igRelayStop(); const b = document.getElementById('ig-locwiz'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } };
  function igRelayStop() { if (_relay.poll) { clearInterval(_relay.poll); _relay.poll = null; } }

  function igRelayRender() {
    const box = document.getElementById('ig-locwiz'); if (!box) return;
    box.style.display = '';
    const c = _cards.find(x => x.kind === _relay.kind) || {};
    const label = cuT(c.labelEn || _relay.kind, c.labelCn || _relay.kind);
    const rail = ['box', 'creds', 'sms', 'done'];
    const railLabels = { box: cuT('Store box · 门店盒子', '门店盒子'), creds: cuT('Credentials · 商家账号', '商家账号'), sms: cuT('Verify login · 登录验证', '登录验证'), done: cuT('Done · 完成', '完成') };
    const cur = rail.indexOf(_relay.step);
    const railHtml = rail.map((k, i) => `<span style="font-size:12px;color:${i === cur ? 'var(--text-1)' : 'var(--text-3)'};font-weight:${i === cur ? 600 : 400}">${i < cur ? '✓ ' : (i + 1) + '. '}${railLabels[k]}</span>`).join('<span style="color:var(--text-4)"> › </span>');
    let body = '';
    if (_relay.step === 'box') {
      body = `<p class="muted" style="font-size:13px;max-width:56ch">${cuT(
        `${label} will see logins from your own store’s internet — the safest setup. Plug in the store box we shipped; until it’s online we use a Guangzhou backup line (degraded).`,
        `${label}将看到来自您门店自有网络的登录,这是最安全的方式。请接入我们寄送的门店盒子;盒子上线前使用广州备用线路(降级)。`)}</p>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-primary" onclick="igRelayStep('creds')">${cuT('Continue · 继续', '继续')}</button>
          <button class="btn" onclick="igRelayClose()">${cuT('Cancel · 取消', '取消')}</button>
        </div>`;
    } else if (_relay.step === 'creds') {
      const opts = _stores.map(s => `<option value="${esc(s.code)}">${esc(cuT(s.name || s.code, s.name || s.code))}</option>`).join('');
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

  // ── Mini App onboarding checklist (interactive) ─────────────────────────────
  // The same A-to-Z the platform tracks, surfaced tenant-facing: phases + steps,
  // who owns each ("You" / "Full Circle" / "WeChat"), live credential checks, and
  // a Mark-done toggle on the steps the tenant owns. Steps we / WeChat drive are
  // read-only with a "waiting" hint (the honest whose-move-is-it view).
  window.igMiniappWizard = async function () {
    const box = document.getElementById('ig-locwiz'); if (!box) return;
    box.style.display = ''; box.innerHTML = igMuted(cuT('Loading checklist… · 加载清单…', '加载清单…'));
    let d;
    try { d = await api('/api/retail-admin/channel-hub/miniapp/checklist'); }
    catch (e) { box.innerHTML = igMuted(cuT('Failed to load · 加载失败', '加载失败')); return; }
    const creds = d.creds || {};
    const ownerLabel = o => o === 'tenant' ? cuT('You · 您', '您') : cuT('Full Circle · 平台', '平台');
    const stDot = st => (st === 'done' || st === 'verified') ? 'var(--accent,#6B8E6F)' : (st === 'provided' ? 'var(--brass,#B08D4A)' : 'var(--text-4,#56544f)');
    const credLine = (ok, en, cn) => `<span style="color:${ok ? 'var(--accent,#6B8E6F)' : 'var(--text-3)'};font-size:12px">${ok ? '✓' : '○'} ${cuT(en, cn)}</span>`;
    let phasesHtml = '';
    for (const p of d.phases) {
      phasesHtml += `<div style="margin-top:14px"><div class="ig-eyebrow" style="font-family:var(--f-mono,monospace);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-2);margin-bottom:6px">${esc(cuT(p.en, p.cn))}</div>`;
      for (const s of p.steps) {
        const done = s.status === 'done' || s.status === 'verified';
        const isTenant = s.owner === 'tenant';
        const waiting = !done && !isTenant;
        phasesHtml += `<div style="display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--line)">
          <span style="width:8px;height:8px;border-radius:50%;flex:none;background:${stDot(s.status)}"></span>
          <div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text-1)">${esc(cuT(s.en, s.cn))}</div>
            <div style="font-size:11px;color:var(--text-3)">${ownerLabel(s.owner)}${waiting ? ' · ' + cuT('in progress', '处理中') : ''}${s.note ? ' · ' + esc(s.note) : ''}</div></div>
          ${isTenant ? `<button class="btn btn-sm ${done ? '' : 'btn-primary'}" onclick="igMiniStep('${escJs(s.key)}','${done ? 'pending' : 'done'}')">${done ? cuT('Undo · 撤销', '撤销') : cuT('Mark done · 标记完成', '标记完成')}</button>` : `<span style="font-size:11px;color:var(--text-4)">${done ? '✓' : cuT('waiting · 等待', '等待')}</span>`}
        </div>`;
      }
      phasesHtml += `</div>`;
    }
    box.innerHTML = `<div class="ig-wiz">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong>${cuT('Mini App setup · 小程序设置', '小程序设置')}</strong>
        <button class="btn btn-sm" onclick="igLocClose()">✕</button>
      </div>
      <div style="font-size:12.5px;color:var(--text-2);margin-bottom:10px">${cuT('Progress', '进度')}: <b>${d.progress.done}/${d.progress.total}</b></div>
      <div style="background:var(--bg-elev-1);border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;gap:16px;flex-wrap:wrap">
        ${credLine(creds.wxAppIdSet, 'AppID set', 'AppID 已填')}
        ${credLine(creds.wechatLoginReady, 'Login ready (AppID+secret)', '登录就绪')}
        ${credLine(creds.payReady, 'WeChat Pay ready', '微信支付就绪')}
      </div>
      ${phasesHtml}
      <div class="helpbar" style="margin-top:16px"><button class="helplink" style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12.5px" onclick="igHelp('wechat_miniapp')">? ${cuT('Get help · 获取帮助', '获取帮助')}</button><span class="ig-spacer" style="flex:1"></span><button class="btn btn-primary" onclick="igLocClose()">${cuT('Done · 完成', '完成')}</button></div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  window.igMiniStep = async function (stepKey, status) {
    try { await api('/api/retail-admin/channel-hub/miniapp/step', { method: 'PATCH', body: { stepKey, status } }); igMiniappWizard(); igLoad(); }
    catch (e) { /* surfaced by api() */ }
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
