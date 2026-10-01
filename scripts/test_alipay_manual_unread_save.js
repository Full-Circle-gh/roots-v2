#!/usr/bin/env node
/**
 * §325 D1 — A MANUAL-ALIPAY CARD THAT DID NOT LOAD IS NEVER SAVED.
 *
 *   node scripts/test_alipay_manual_unread_save.js
 *
 * Settings → Operations' manual-Alipay card (public/retail-admin/02-settings-ops.js)
 * is saved by the shared "Save settings" bar (05-marketing.js saveConfig →
 * saveAlipayManualInline), and PUT /alipay-manual replaces the whole record
 * from what it is sent. When the read failed, loadAlipayManual returned
 * quietly and left the card blank, so the next Save switched manual Alipay off
 * and wiped its account and OCR settings.
 *
 * Asserted: a failed read (HTTP error, refusal, a non-success answer, a network
 * throw) says so on the card with a retry, and Save then sends no
 * /alipay-manual write; a Save pressed while the read is still in flight sends
 * none either; a good read, and a retry that succeeds, save as before with the
 * fields read; the other Save-bar cards still save. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OPS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const MKT = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}

const CODE = [
  slice(OPS, '// ── Manual-Alipay (静态收款码) fallback card', '// Backward-compat shim'),
  block(MKT, 'async function saveConfig() {'),
].join('\n');

const IDS = ['alipay-manual-enabled', 'alipay-manual-account', 'alipay-manual-preview', 'alipay-manual-ocr', 'alipay-manual-autoflip',
  'alipay-manual-payee', 'alipay-manual-window', 'alipay-manual-proof-age', 'alipay-manual-key', 'alipay-manual-status', 'alipay-manual-chip',
  'alipay-ocr-fields', 'cfg-status', 'cfg-notifications-order_status_template_id', 'cfg-notifications-wecom_order_webhook',
  'cfg-system_alerts-enabled', 'cfg-system_alerts-wecom_webhook'];
const GOOD = { success: true, data: { enabled: true, account: '收款 Roots', qr: 'data:image/png;base64,AA', ocrEnabled: true, autoFlip: true,
  payeeMatch: 'Roots', timeWindowMin: 30, proofAgeMin: 20, hasKey: true, keyMasked: 'sk-…9', serverKeyAvailable: false } };

function mk(reads) {
  const calls = { fetches: [], puts: [], apiPuts: [], toasts: [] };
  const els = {};
  for (const id of IDS) {
    let v = '';
    els[id] = { id, checked: false, textContent: '', innerHTML: '', style: {}, placeholder: '', disabled: false,
      removeAttribute() {}, querySelectorAll: () => [] };
    // As the DOM does: an input's value is always a string.
    Object.defineProperty(els[id], 'value', { get: () => v, set: (x) => { v = String(x == null ? '' : x); } });
  }
  let pendingRead = null;
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    cuT: (en) => en, escapeHtml: (s) => String(s).replace(/</g, '&lt;'),
    toast: (m) => calls.toasts.push(String(m)), console: { warn: (...a) => { calls.warns = (calls.warns || []).concat(a.map(String)); } },
    $: (sel) => els[sel.replace(/^#/, '')],
    api: async (p, o) => { calls.apiPuts.push({ p, body: o && o.body }); return { success: true }; },
    fetch: (url, opts) => {
      calls.fetches.push({ url, method: (opts && opts.method) || 'GET' });
      if (opts && opts.method === 'PUT') {
        calls.puts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      const r = reads.shift();
      if (r === 'hold') return new Promise((res) => { pendingRead = res; });
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve({ ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body });
    },
    Object, Promise, JSON, String, Number, Error, parseInt, Math,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, els, calls, release: (body) => pendingRead({ ok: true, status: 200, json: async () => body }) };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

section('1 · a failed read never becomes a save');
for (const [name, read] of [['an HTTP 500', { status: 500, body: { success: false } }], ['a refusal (403)', { status: 403, body: { error: 'forbidden_capability' } }],
  ['a non-success answer', { body: { success: false, error: 'x' } }], ['an answer with no data', { body: { success: true } }], ['a network failure', new Error('offline')]]) {
  it(name + ': the card says it could not load, with a retry, and Save sends no /alipay-manual write', async () => {
    const h = mk([read]);
    await h.ctx.loadAlipayManual(); await tick();
    const st = h.els['alipay-manual-status'].innerHTML;
    assert.ok(st.includes('Could not load this card, so Save leaves it unchanged.'), st);
    assert.ok(st.includes('onclick="loadAlipayManual()"') && st.includes('Try again'));
    await h.ctx.saveConfig(); await tick();
    assert.strictEqual(h.calls.puts.length, 0, 'no PUT /alipay-manual');
    assert.strictEqual(h.calls.apiPuts.length, 1, 'the other cards on the bar still save');
    assert.strictEqual(h.calls.apiPuts[0].p, '/api/retail-admin/config');
    assert.deepStrictEqual(h.calls.toasts, ['Settings saved · 设置已保存']);
  });
}
it('a Save pressed while the read is still in flight sends nothing either', async () => {
  const h = mk(['hold']);
  const p = h.ctx.loadAlipayManual();
  await h.ctx.saveAlipayManualInline();
  assert.strictEqual(h.calls.puts.length, 0);
  h.release(GOOD); await p; await tick();
  await h.ctx.saveAlipayManualInline();
  assert.strictEqual(h.calls.puts.length, 1, 'once read, it saves');
});

section('2 · a good read saves exactly as before');
it('the fields read are the fields sent, and the QR is kept server-side (not re-sent)', async () => {
  const h = mk([{ body: GOOD }]);
  await h.ctx.loadAlipayManual(); await tick();
  assert.strictEqual(h.els['alipay-manual-status'].textContent, '');
  assert.ok(h.els['alipay-manual-chip'].innerHTML.includes('LIVE'));
  await h.ctx.saveConfig(); await tick();
  assert.strictEqual(h.calls.puts.length, 1);
  assert.deepStrictEqual(h.calls.puts[0], { enabled: true, account: '收款 Roots', ocrEnabled: true, autoFlip: true, payeeMatch: 'Roots', timeWindowMin: 30, proofAgeMin: 20 });
  const put = h.calls.fetches.find((f) => f.method === 'PUT');
  assert.strictEqual(put.url, '/api/retail-admin/alipay-manual');
});
it('a retry that succeeds clears the warning and saving works again', async () => {
  const h = mk([{ status: 500, body: {} }, { body: GOOD }]);
  await h.ctx.loadAlipayManual(); await tick();
  await h.ctx.saveAlipayManualInline(); assert.strictEqual(h.calls.puts.length, 0);
  await h.ctx.loadAlipayManual(); await tick();
  assert.ok(!h.els['alipay-manual-status'].innerHTML.includes('Could not load'));
  await h.ctx.saveAlipayManualInline(); assert.strictEqual(h.calls.puts.length, 1);
});
it('a read that fails after a good one shuts the save again', async () => {
  const h = mk([{ body: GOOD }, new Error('offline')]);
  await h.ctx.loadAlipayManual(); await tick();
  await h.ctx.loadAlipayManual(); await tick();
  await h.ctx.saveAlipayManualInline();
  assert.strictEqual(h.calls.puts.length, 0);
});

section('3 · the words');
it('the retry is the live pair; the warning is declared Chinese', () => {
  assert.ok(OPS.includes("cuT('Could not load this card, so Save leaves it unchanged.', '此卡片加载失败,保存时不会改动它。')"));
  assert.ok(OPS.includes("cuT('Try again', '重试')"));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
