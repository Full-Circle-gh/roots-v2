/* eslint-disable no-undef */
// The voice assistant on the computer (§495 rule 13) — the same microphone
// Tacet Mobile carries in its header, in the back office's top bar next to
// Search. One server, one plan, one approval: this file is the phone's sheet
// said in the desktop's own markup, and it calls the same two routes
// (/assistant/plan, /assistant/outcome) and runs the same rows through the
// same existing routes, under the operator's own login.
//
// WHAT IS NOT HERE. No reading of the sentence (the server's), no action of
// its own (every row is a route that already exists), no second copy of the
// three locks (the plan route holds them; the button only hides itself when
// the module is off or the role lacks `assistant:use`, which is what the phone
// does too).
//
// Bilingual text rides as data-lang-block spans, never glued, so the account's
// language switch shows one side (retail-admin.html's walker). Strings are the
// phone's, copied whole — docs/tacet-delivery-vocabulary.md §495.
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const bi = (en, cn) => '<span data-lang-block="en">' + esc(en) + '</span><span data-lang-block="cn">' + esc(cn) + '</span>';
  const lang = () => (document.documentElement.dataset.uiLang === 'cn' ? 'cn' : 'en');
  const T = (en, cn) => (lang() === 'cn' ? cn : en);
  const VOICE_LANG_KEY = 'roots_qs_voice_lang';   // the phone's key, so one device keeps one choice

  const S = { open: false, text: '', via: 'typed', lang: 'en', listening: false, rec: null, err: null,
    busy: false, plan: null, logId: null, stage: 'say', ticks: {}, results: {}, running: null, answers: {}, learn: null };

  // ── The microphone button ─────────────────────────────────────────────
  // Shown only when the tenant holds the module and has it on (body.feat-assistant,
  // from applyFeatureGates) AND the role carries assistant:use (can()).
  function sync() {
    const b = $('#asst-mic');
    if (!b) return;
    const on = document.body.classList.contains('feat-assistant') && (typeof can === 'function' ? can('assistant:use') : false);
    b.hidden = !on;
  }

  // ── The recogniser ────────────────────────────────────────────────────
  function SR() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
  function langDefault() {
    let v = null; try { v = localStorage.getItem(VOICE_LANG_KEY); } catch (e) { /* no storage in a private window: the app's language stands */ }
    return v === 'en' || v === 'zh' ? v : (lang() === 'cn' ? 'zh' : 'en');
  }
  const unavailable = () => T('Voice isn’t available in this browser. Type it instead.', '此浏览器不支持语音，请输入。');
  const misheard = () => T('Could not make that out — try again, or type it.', '无法识别，请重试或输入。');
  function listen() {
    if (S.rec) { try { S.rec.stop(); } catch (e) { /* stopping a recogniser already stopped is nothing */ } return; }
    const R = SR();
    if (!R) { S.err = unavailable(); repaint(); return; }
    const r = new R();
    r.lang = S.lang === 'en' ? 'en-US' : 'zh-CN';
    r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    S.rec = r; S.listening = true; S.err = null;
    r.onresult = (e) => {
      let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      S.text = t; S.via = 'voice'; const el = $('#asst-field'); if (el) el.value = t;
    };
    r.onerror = (e) => {
      const k = e && e.error;
      S.err = k === 'not-allowed' || k === 'service-not-allowed' ? unavailable() : k === 'aborted' ? null : misheard();
    };
    r.onend = () => { S.rec = null; S.listening = false; repaint(); if (S.text.trim() && !S.err) plan(); };
    try { r.start(); } catch (e) { S.rec = null; S.listening = false; S.err = misheard(); }
    repaint();
  }
  function abortRec() { if (S.rec) { const r = S.rec; S.rec = null; S.listening = false; r.onend = null; try { r.abort(); } catch (e) { /* aborting a recogniser already gone is nothing */ } } }

  // ── Open, close ───────────────────────────────────────────────────────
  function open() {
    if (S.open) return;
    Object.assign(S, { open: true, text: '', via: 'typed', lang: langDefault(), listening: false, rec: null, err: null,
      busy: false, plan: null, logId: null, stage: 'say', ticks: {}, results: {}, running: null, answers: {}, learn: null });
    render();
    $('#asst-overlay').hidden = false;
    if (SR()) listen(); else { const el = $('#asst-field'); if (el) el.focus(); }
  }
  function close() {
    if (!S.open) return;
    abortRec();
    if (S.logId && S.stage === 'plan' && S.plan && (S.plan.question || (S.plan.actions || []).length)) {
      api('/api/retail-admin/assistant/outcome', { method: 'POST', body: { id: S.logId, outcome: 'cancelled', approved: [], results: [] } }).catch(() => {});
    }
    S.open = false;
    $('#asst-overlay').hidden = true;
  }

  // ── The plan ──────────────────────────────────────────────────────────
  function errText(e) {
    if (!e) return T('Failed', '失败');
    if (e.code === 'not_configured') return T('The assistant needs the model key on the server.', '语音助手需要在服务器上配置模型密钥。');
    if (e.code === 'module_not_held') return T('The voice assistant is not part of this account’s plan.', '当前套餐不包含语音助手。');
    if (e.code === 'assistant_off') return T('The voice assistant is switched off for this account.', '本账户已关闭语音助手。');
    if (e.code === 'model_failed') return T('That did not go through. Nothing has changed — try again.', '没有成功。数据没有变化 — 请重试。');
    return e.message || T('Failed', '失败');
  }
  function plan() {
    if (S.busy) return;
    const text = S.text.trim(); if (!text) return;
    S.busy = true; S.err = null; S.plan = null; S.stage = 'say'; render();
    const body = { text, via: S.via, lang: S.lang, answers: S.answers, log_id: S.logId };
    if (S.learn && S.learn.length) body.learn = S.learn;
    S.learn = null;
    api('/api/retail-admin/assistant/plan', { method: 'POST', body }).then((j) => {
      if (!S.open) return;
      const p = (j && j.data) || j;
      S.busy = false; S.logId = p.id || S.logId; S.plan = p; S.stage = 'plan';
      S.ticks = {}; (p.actions || []).forEach((r) => { S.ticks[r.key] = true; });
      render();
    }).catch((e) => {
      if (!S.open) return;
      S.busy = false; S.err = errText(e); render();
    });
  }
  function back() {
    if (S.logId && S.plan && !S.plan.question && (S.plan.actions || []).length) {
      api('/api/retail-admin/assistant/outcome', { method: 'POST', body: { id: S.logId, outcome: 'declined', approved: [], results: [] } }).catch(() => {});
    }
    S.plan = null; S.err = null; S.stage = 'say'; S.answers = {}; S.learn = null; S.logId = null; render();
    const el = $('#asst-field'); if (el) el.focus();
  }
  function answer(id) {
    if (!S.plan || !S.plan.question) return;
    const q = S.plan.question, n = Number(id);
    if (!(q.options || []).some((o) => o.id === n)) return;
    if (['store', 'shop', 'product', 'listing'].includes(q.kind)) {
      S.answers[q.kind + '_id'] = n;
      const un = S.plan.unknown_names || [];
      if (un.length === 1) S.learn = [{ kind: q.kind, heard: un[0], id: n }];
    }
    plan();
  }
  function tick(key) { if (S.stage !== 'plan') return; S.ticks[key] = !S.ticks[key]; render(); }
  async function run() {
    if (S.stage !== 'plan' || !S.plan) return;
    const rows = (S.plan.actions || []).filter((r) => S.ticks[r.key]);
    if (!rows.length) return;
    S.stage = 'run'; S.results = {}; render();
    for (const r of rows) {
      S.running = r.key; render();
      try {
        const j = await api(r.cmd.path, { method: r.cmd.method, body: r.cmd.body });
        if (j && j.ok === false) S.results[r.key] = { ok: false, error: String(j.error || j.message || T('Failed', '失败')) };
        else S.results[r.key] = { ok: true };
      } catch (e) {
        if (String(e && e.message) === '401') return;
        S.results[r.key] = { ok: false, error: errText(e) };
      }
    }
    S.running = null; S.stage = 'done'; render();
    api('/api/retail-admin/assistant/outcome', { method: 'POST', body: { id: S.logId, outcome: 'approved', approved: rows.map((r) => r.key),
      results: rows.map((r) => ({ key: r.key, ok: !!(S.results[r.key] && S.results[r.key].ok), error: (S.results[r.key] && S.results[r.key].error) || null })) } }).catch(() => {});
  }
  function setLang(l) {
    if ((l !== 'en' && l !== 'zh') || S.lang === l) return;
    S.lang = l; try { localStorage.setItem(VOICE_LANG_KEY, l); } catch (e) { /* no storage in a private window: the choice lasts this page */ }
    const was = !!S.rec; abortRec(); render();
    if (was) listen();
  }

  // ── Painting ──────────────────────────────────────────────────────────
  function repaint() {
    const mic = $('#asst-mic-btn');
    if (mic) { mic.classList.toggle('on', !!S.listening); mic.setAttribute('aria-pressed', S.listening ? 'true' : 'false'); }
    const st = $('#asst-stat');
    if (st) { st.textContent = S.listening ? T('Listening…', '正在听…') : (S.err ? String(S.err) : ''); st.classList.toggle('err', !!(S.err && !S.listening)); }
  }
  const MIC_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const label = (r) => esc(lang() === 'cn' ? (r.label_cn || r.label_en) : r.label_en);
  function render() {
    const box = $('#asst-body'); if (!box) return;
    const hasSR = !!SR();
    const head = '<div class="asst-head"><div class="asst-title">' + bi('Voice assistant', '语音助手') + '</div>' +
      (S.stage === 'say' && hasSR ? '<div class="asst-chips">' +
        ['en', 'zh'].map((l) => '<button type="button" class="asst-chip' + (S.lang === l ? ' on' : '') + '" data-asst-lang="' + l + '">' + (l === 'en' ? 'English' : '中文') + '</button>').join('') + '</div>' : '') +
      '<button type="button" class="asst-x" data-asst="close" aria-label="' + esc(T('Close', '关闭')) + '">×</button></div>';
    let body = '';
    if (S.stage === 'say' && S.busy) {
      body = '<div class="asst-said">“' + esc(S.text) + '”</div><div class="asst-muted">' + bi('Working…', '处理中…') + '</div>';
    } else if (S.stage === 'say') {
      body = '<div class="asst-muted">' + bi('Say what you need. For example: “whole wheat bread on the toast is sold out”, or “close the shop”.', '说出你的需求。例如：“吐司的全麦面包售罄了”，或“关店”。') + '</div>' +
        '<div class="gsearch-inputrow asst-inputrow"><input id="asst-field" type="text" autocomplete="off" spellcheck="false" value="' + esc(S.text) + '" aria-label="' + esc(T('Say what you need', '说出你的需求')) + '">' +
        (hasSR ? '<button type="button" id="asst-mic-btn" class="asst-micbtn' + (S.listening ? ' on' : '') + '" data-asst="mic" aria-pressed="' + (S.listening ? 'true' : 'false') + '" aria-label="' + esc(T('Voice', '语音')) + '">' + MIC_SVG + '</button>' : '') + '</div>' +
        '<div id="asst-stat" class="asst-stat' + (S.err ? ' err' : '') + '">' + (S.listening ? esc(T('Listening…', '正在听…')) : esc(S.err || (hasSR ? '' : unavailable()))) + '</div>' +
        '<div class="asst-foot"><button type="button" class="btn btn-primary" data-asst="plan">' + bi('Next', '下一步') + '</button></div>';
    } else if (S.stage === 'plan' && S.plan && S.plan.question) {
      const q = S.plan.question;
      body = '<div class="asst-said">“' + esc(S.text) + '”</div>' + (S.plan.say ? '<div class="asst-say">' + esc(S.plan.say) + '</div>' : '') +
        '<div class="asst-q">' + esc(q.text) + '</div><div class="gsearch-results asst-rows">' +
        (q.options || []).map((o) => '<button type="button" class="gsearch-item asst-opt" data-asst-answer="' + o.id + '"><span class="asst-lbl">' + esc(o.label) + '</span>' + (o.sku ? '<span class="asst-sku">' + esc(o.sku) + '</span>' : '') + '</button>').join('') +
        '</div><div class="asst-foot"><button type="button" class="btn" data-asst="back">' + bi('Something else', '都不是') + '</button></div>';
    } else if (S.stage === 'plan' && S.plan) {
      const rows = S.plan.actions || [], answers = S.plan.answers || [];
      const asked = rows.filter((r) => !r.suggested), sugg = rows.filter((r) => r.suggested);
      const row = (r) => '<button type="button" class="gsearch-item asst-row" data-asst-tick="' + r.key + '" aria-pressed="' + (S.ticks[r.key] ? 'true' : 'false') + '">' +
        '<span class="asst-tick' + (S.ticks[r.key] ? ' on' : '') + '">' + (S.ticks[r.key] ? CHECK_SVG : '') + '</span><span class="asst-lbl">' + label(r) + '</span></button>';
      const n = rows.filter((r) => S.ticks[r.key]).length;
      body = '<div class="asst-said">“' + esc(S.text) + '”</div>' + (S.plan.say ? '<div class="asst-say">' + esc(S.plan.say) + '</div>' : '') +
        (answers.length ? '<div class="asst-answers">' + answers.map((x) => '<div class="asst-ans' + (x.refused ? ' err' : '') + '">' + esc(lang() === 'cn' ? (x.text_cn || x.text_en) : x.text_en) + '</div>').join('') + '</div>' : '') +
        (rows.length || answers.length ? '' : '<div class="asst-stat err">' + bi('Nothing I can do with that. Try other words.', '这个我做不了，请换种说法。') + '</div>') +
        '<div class="gsearch-results asst-rows">' + asked.map(row).join('') + '</div>' +
        (sugg.length ? '<div class="asst-eyebrow">' + bi('Also suggested', '建议同时') + '</div><div class="gsearch-results asst-rows">' + sugg.map(row).join('') + '</div>' : '') +
        '<div class="asst-foot"><button type="button" class="btn" data-asst="back">' + bi('Back', '返回') + '</button>' +
        (rows.length ? '<button type="button" class="btn btn-primary" data-asst="run"' + (n ? '' : ' disabled') + '>' + bi('Approve', '批准') + (n ? ' · ' + n : '') + '</button>'
          : (answers.length ? '<button type="button" class="btn btn-primary" data-asst="close">' + bi('Close', '关闭') + '</button>' : '')) + '</div>';
    } else if (S.stage === 'run' || S.stage === 'done') {
      const rows = (S.plan.actions || []).filter((r) => S.ticks[r.key]);
      const line = (r) => { const x = S.results[r.key];
        const mark = x ? (x.ok ? '<span class="asst-ok">✓</span>' : '<span class="asst-bad">✗</span>') : (S.running === r.key ? '<span class="asst-muted">…</span>' : '');
        return '<div class="asst-line"><span class="asst-mark">' + mark + '</span><span class="asst-lbl">' + label(r) + (x && !x.ok ? '<span class="asst-why">' + esc(x.error || '') + '</span>' : '') + '</span></div>'; };
      const done = Object.values(S.results).filter((x) => x.ok).length, bad = Object.values(S.results).filter((x) => !x.ok).length;
      body = '<div class="asst-muted">' + (S.stage === 'done' ? bi('Done', '完成') : bi('Working…', '处理中…')) + '</div><div class="asst-lines">' + rows.map(line).join('') + '</div>' +
        (S.stage === 'done' ? '<div class="asst-muted">' + bi(done + ' done', '已完成 ' + done + ' 项') + (bad ? ' · <span class="asst-bad">' + bi(bad + ' failed', bad + ' 项失败') + '</span>' : '') + '</div>' +
          '<div class="asst-foot"><button type="button" class="btn btn-primary" data-asst="close">' + bi('Close', '关闭') + '</button></div>' : '');
    }
    box.innerHTML = head + body;
    const f = $('#asst-field');
    if (f) { f.addEventListener('input', () => { S.text = f.value; S.via = 'typed'; });
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); plan(); } }); }
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  function mount() {
    if ($('#asst-overlay')) return;
    const ov = document.createElement('div');
    ov.className = 'gsearch-overlay asst-overlay'; ov.id = 'asst-overlay'; ov.hidden = true;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', T('Voice assistant', '语音助手'));
    ov.innerHTML = '<div class="gsearch-box asst-box"><div id="asst-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) { close(); return; }
      const b = e.target.closest('[data-asst],[data-asst-lang],[data-asst-tick],[data-asst-answer]');
      if (!b) return;
      if (b.dataset.asst === 'close') close();
      else if (b.dataset.asst === 'mic') listen();
      else if (b.dataset.asst === 'plan') plan();
      else if (b.dataset.asst === 'back') back();
      else if (b.dataset.asst === 'run') run();
      else if (b.dataset.asstLang) setLang(b.dataset.asstLang);
      else if (b.dataset.asstTick) tick(b.dataset.asstTick);
      else if (b.dataset.asstAnswer) answer(b.dataset.asstAnswer);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) close(); });
    const mic = $('#asst-mic');
    if (mic) mic.addEventListener('click', open);
    // The button follows the module switch (body class) and the role (caps).
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.asstOpen = open;
  window.asstClose = close;
  // Called by the /me loader (02-settings-ops.js) once the caps have landed,
  // the way applyFeatureGates is called once the config has: the button
  // cannot know on its own when either arrives.
  window.asstSync = sync;
})();
