#!/usr/bin/env node
/**
 * §325 M3 — THE ONBOARDING PAGE'S SETTINGS IN THE PHONE PAGE EDITOR.
 *
 *   node scripts/test_mobile_editor_onboarding.js
 *
 * On the Onboarding page the desktop editor shows who sees the page, its
 * version, Re-show to all and the Get Started button's words
 * (cms.html renderOnboardingSettings). The phone editor had none of them.
 * Sliced out of public/cms-mobile.html into a sandbox (fast shard). Pins:
 *   1. the strip shows on the Onboarding page only, with the mode and version;
 *   2. loading, failed (with Try again) and loaded states of the sheet;
 *   3. each write: method, path, body — mode, the button's two words, and
 *      Re-show to all only after its confirm, in the desktop's words;
 *   4. a refusal stays in the sheet; the toast only confirms.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');
const CD = fs.readFileSync(path.join(ROOT, 'public/cms.html'), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
const slice = (src, a, b) => {
  const s = src.indexOf(a), e = src.indexOf(b, s + 1);
  if (s < 0 || e < 0) throw new Error('slice not found: ' + a);
  return src.slice(s, e);
};
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
const SRC = slice(CM, '/* ── §325 M3 · ONBOARDING SETTINGS', '/* ── §299 · PROMO CARDS, ON THE PHONE');

function el() {
  return {
    html: '', hidden: false, controls: {},
    set innerHTML(v) { this.html = v; this.controls = {}; },
    get innerHTML() { return this.html; },
    querySelector(sel) {
      const m = sel.match(/\[data-a=([a-z]+)\]/); const k = m && m[1];
      if (!k || !new RegExp('data-a="' + k + '"').test(this.html)) return null;
      if (!this.controls[k]) {
        const v = (this.html.match(new RegExp('data-a="' + k + '"[^>]*value="([^"]*)"')) || [])[1];
        this.controls[k] = { onclick: null, onchange: null, value: v == null ? '' : v };
      }
      return this.controls[k];
    },
  };
}
const DATA = { show_to: 'new', version: 3, next_label: { en: 'GET STARTED', cn: '开始' } };
function mk(opts = {}) {
  const calls = [], toasts = [], els = { '#onb-strip': el(), '#onb-body': el() };
  let sheet = null;
  const ctx = {
    M: { lang: opts.lang || 'en', page: opts.page || 'onboarding', sheet: null },
    cuT: (en, cn) => (opts.lang === 'cn' ? cn : en),
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    $: (s) => els[s] || null,
    toast: (m) => toasts.push(m),
    openSheet: (id) => { sheet = id; ctx.M.sheet = id; },
    location: {},
    fetch: async (u, o) => {
      calls.push({ u, method: (o && o.method) || 'GET', body: o && o.body ? JSON.parse(o.body) : undefined, headers: o && o.headers, credentials: o && o.credentials });
      const r = opts.answer ? opts.answer(u, o, calls.length) : { status: 200, ok: true, j: { success: true, data: DATA } };
      return { status: r.status, ok: r.ok, json: async () => r.j };
    },
    Object, String, Array, JSON, Promise, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nthis.ONB = ONB;', ctx);
  return { ctx, calls, toasts, els, sheet: () => sheet };
}

section('1 · the strip');
{
  it('on the Onboarding page: loads once, then shows the mode and version', async () => {
    const t = mk();
    t.ctx.onbStrip();
    assert.strictEqual(t.els['#onb-strip'].hidden, false);
    assert.ok(/Loading…/.test(t.els['#onb-strip'].html));
    await tick();
    assert.deepStrictEqual(plain(t.calls.map((c) => [c.method, c.u, c.credentials])), [['GET', '/api/retail-admin/cms/onboarding-settings', 'same-origin']]);
    assert.ok(/<b>Onboarding<\/b> · show to <span>New users only<\/span> <span class="v">v3<\/span>/.test(t.els['#onb-strip'].html));
    t.ctx.onbStrip();
    assert.strictEqual(t.calls.length, 1, 'not asked again');
  });
  it('any other page: hidden, nothing asked', () => {
    const t = mk({ page: 'home' });
    t.ctx.onbStrip();
    assert.strictEqual(t.els['#onb-strip'].hidden, true);
    assert.strictEqual(t.calls.length, 0);
  });
  it('the strip follows the page, from every state the editor sends', () => {
    assert.ok(/updatePageName\(\);\s*onbStrip\(\);/.test(CM));
    assert.ok(/<button class="onb-strip" id="onb-strip" hidden onclick="openOnb\(\)"><\/button>/.test(CM));
  });
}

section('2 · the sheet');
{
  it('loading, then the desktop\'s controls with the saved values', async () => {
    const t = mk();
    t.ctx.openOnb();
    assert.strictEqual(t.sheet(), 'onb');
    assert.ok(/Loading…/.test(t.els['#onb-body'].html));
    await tick();
    const h = t.els['#onb-body'].html;
    assert.ok(/<option value="new" selected>New users only<\/option><option value="version">Everyone until I re-show<\/option><option value="always">Everyone, every launch<\/option><option value="off">Off<\/option>/.test(h));
    assert.ok(/data-a="bump">Re-show to all<\/button>/.test(h) && /v3/.test(h));
    assert.ok(/data-a="en" placeholder="GET STARTED" value="GET STARTED"/.test(h) && /data-a="cn" placeholder="开始" value="开始"/.test(h));
  });
  it('a failed load says so, with Try again', async () => {
    const t = mk({ answer: (u, o, n) => (n === 1 ? { status: 500, ok: false, j: { success: false, error: 'db' } } : { status: 200, ok: true, j: { success: true, data: DATA } }) });
    t.ctx.openOnb(); await tick();
    assert.ok(/<div class="pc-err">Could not load<\/div><button class="pc-btn" data-a="retry">Try again<\/button>/.test(t.els['#onb-body'].html));
    assert.ok(/<span>Could not load<\/span>/.test(t.els['#onb-strip'].html), 'the strip says so too');
    t.els['#onb-body'].querySelector('[data-a=retry]').onclick(); await tick();
    assert.ok(/data-a="mode"/.test(t.els['#onb-body'].html));
  });
  it('in Chinese, the desktop\'s Chinese', async () => {
    const t = mk({ lang: 'cn' });
    t.ctx.openOnb(); await tick();
    assert.ok(/仅新用户/.test(t.els['#onb-body'].html) && /向所有人重新显示/.test(t.els['#onb-body'].html) && /按钮文字/.test(t.els['#onb-body'].html));
  });
}

section('3 · the writes');
{
  it('who sees it: PUT { show_to }, and the answer is shown', async () => {
    const t = mk({ answer: (u, o) => ({ status: 200, ok: true, j: { success: true, data: o && o.method === 'PUT' ? Object.assign({}, DATA, { show_to: 'always' }) : DATA } }) });
    t.ctx.openOnb(); await tick();
    t.els['#onb-body'].querySelector('[data-a=mode]').onchange({ target: { value: 'always' } });
    assert.ok(/data-a="mode" disabled/.test(t.els['#onb-body'].html), 'disabled while it saves');
    await tick();
    assert.deepStrictEqual(plain(t.calls[1]), { u: '/api/retail-admin/cms/onboarding-settings', method: 'PUT', body: { show_to: 'always' }, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    assert.deepStrictEqual(t.toasts, ['Updated']);
    assert.ok(/value="always" selected/.test(t.els['#onb-body'].html));
    assert.ok(/Everyone, every launch/.test(t.els['#onb-strip'].html));
  });
  it('the button\'s words: both sides together, trimmed, when a box is left', async () => {
    const t = mk();
    t.ctx.openOnb(); await tick();
    const b = t.els['#onb-body'];
    const en = b.querySelector('[data-a=en]'), cn = b.querySelector('[data-a=cn]');
    en.value = ' LET’S GO '; cn.value = '开始吧';
    en.onchange();
    await tick();
    assert.deepStrictEqual(plain(t.calls[1].body), { next_label: { en: 'LET’S GO', cn: '开始吧' } });
    assert.strictEqual(t.calls[1].method, 'PUT');
  });
  it('Re-show to all asks first; Cancel sends nothing; yes POSTs /bump', async () => {
    const t = mk({ answer: (u) => (/\/bump$/.test(u) ? { status: 200, ok: true, j: { success: true, data: { show_to: 'new', version: 4 } } } : { status: 200, ok: true, j: { success: true, data: DATA } }) });
    t.ctx.openOnb(); await tick();
    let b = t.els['#onb-body'];
    b.querySelector('[data-a=bump]').onclick();
    assert.ok(/Re-show onboarding to ALL returning users on their next launch\?/.test(b.html));
    assert.ok(/New users see it anyway\. Has no effect when mode is &quot;Off&quot;\./.test(b.html));
    b.querySelector('[data-a=no]').onclick();
    assert.ok(!/onb-confirm/.test(b.html));
    assert.strictEqual(t.calls.length, 1);
    b.querySelector('[data-a=bump]').onclick();
    b.querySelector('[data-a=yes]').onclick();
    assert.ok(/data-a="yes" disabled>Saving…/.test(b.html));
    await tick();
    assert.deepStrictEqual([t.calls[1].method, t.calls[1].u], ['POST', '/api/retail-admin/cms/onboarding-settings/bump']);
    assert.strictEqual(t.calls[1].body, undefined, 'no body, as the desktop sends');
    assert.deepStrictEqual(t.toasts, ['Will re-show — now at v4']);
    assert.ok(/v4/.test(t.els['#onb-strip'].html));
  });
  it('a refusal stays in the sheet and no toast says it worked', async () => {
    const t = mk({ answer: (u, o) => (o && o.method === 'PUT' ? { status: 403, ok: false, j: { success: false, error: 'forbidden' } } : { status: 200, ok: true, j: { success: true, data: DATA } }) });
    t.ctx.openOnb(); await tick();
    t.els['#onb-body'].querySelector('[data-a=mode]').onchange({ target: { value: 'off' } });
    await tick();
    assert.ok(/<div class="pc-err">Could not save: forbidden<\/div>/.test(t.els['#onb-body'].html));
    assert.deepStrictEqual(t.toasts, []);
    assert.ok(/value="new" selected/.test(t.els['#onb-body'].html), 'the saved mode, not the refused one');
  });
  it('the same endpoints, bodies and words as the desktop', () => {
    const fn = slice(CD, 'async function renderOnboardingSettings(el) {', 'async function loadPage() {');
    assert.ok(/method: 'PUT', body: \{ show_to: v \}/.test(fn));
    assert.ok(/'\/api\/retail-admin\/cms\/onboarding-settings\/bump', \{ method: 'POST' \}/.test(fn));
    assert.ok(/body: \{ \[field\]: parseLabelValue\(raw\) \}/.test(fn) && /saveLabel\('next_label', inp\.value\)/.test(fn));
    for (const [en, cn] of [['New users only', '仅新用户'], ['Everyone until I re-show', '所有用户(到下次重置)'], ['Everyone, every launch', '每个用户每次启动'], ['Off', '关闭'], ['Re-show to all', '向所有人重新显示'], ['show to', '显示给'], ['Onboarding', '引导页'], ['Button label', '按钮文字']]) {
      assert.ok(fn.includes(`B('${en}',`) && fn.includes(`'${cn}')`), en);
    }
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
