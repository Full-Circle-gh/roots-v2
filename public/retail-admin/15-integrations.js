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
      const r = await api('/api/retail-admin/integrations');
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
      <div class="ig-foot">${action}<span class="ig-spacer"></span>${meta}</div>
    </div>`;
  }

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
      await api('/api/retail-admin/integrations/help', {
        method: 'POST',
        body: { kind: kind || 'general', note: note || '' },
      });
      if (window.toast) toast(cuT('Help request sent — we’ll be in touch.', '求助已发送 — 我们会尽快联系您。'));
    } catch (e) { /* surfaced by api() */ }
  };

  // ── util ────────────────────────────────────────────────────────────────────
  function igMuted(s) { return `<div class="muted" style="font-size:13px;padding:10px 2px">${s}</div>`; }
  function igGlyph(kind) {
    const map = { wechat_miniapp: 'WX', web: 'WB', eleme: 'EL', meituan: 'MT', jd: 'JD', qingyun: 'QY' };
    return esc(map[kind] || kind.slice(0, 2).toUpperCase());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
})();
