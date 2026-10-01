#!/usr/bin/env node
/**
 * §325 X8e — GZGROCERY BILLING AND THE STATEMENT, ON THE PHONE.
 *
 *   node scripts/test_mobile_gzgrocery_billing.js
 *
 * The desktop GZ Grocery tab's Billing panel (12-guanyi.js gyLoadAnalytics,
 * gyRenderAnalytics, gyPeriodRange, gyExportStatement).
 *
 * What is asserted: the read is the desktop's query; the presets re-scope the
 * range as the desktop's do; the figures, the unpriced warning, the breakdown
 * and the product list; the Statement CSV is byte for byte the file the
 * desktop's own function builds from the same answer (sliced out of
 * 12-guanyi.js and run); who may open it — the GZ Grocery key and the phone's
 * money rule; empty and failed reads; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const GY = fs.readFileSync(path.join(ROOT, 'public/retail-admin/12-guanyi.js'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
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
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  block(M, 'function chipRow('),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X8e — GZGROCERY', '/* §325 X8e ends */'),
].join('\n');

const DATA = () => ({
  success: true, period: 'day', range: { from: '2026-09-01', to: '2026-09-30' },
  summary: { units: 30, owed: 456.5, retail: 600, avgDiscount: 0.239, products: 2 },
  timeSeries: [{ bucket: '2026-09-01', units: 10, owed: 150, retail: 200 }, { bucket: '2026-09-02', units: 20, owed: 306.5, retail: 400 }],
  products: [{ product_id: 1, sku: 'GVF 1-180', name: '燕麦奶 "Oat"', units: 20, owed: 306.5, retail: 400, discount: 0.25 },
    { product_id: 2, sku: '', name: '黑麦面包 Rye', units: 10, owed: 150, retail: 200, discount: null }],
  unpriced: [{ product_id: 2, name: '黑麦面包 Rye' }],
});

function mk(opts = {}) {
  const calls = { api: [], pushes: [], clicks: [], blobs: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {},
    state: { caps: opts.caps === undefined ? ['guanyi:view'] : opts.caps, pos: opts.pos || 'owner',
      gzb: { period: '', from: '', to: '', data: null, tried: false, err: null, err2: null, seq: 0 } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); },
    recapNoMoney: () => ['warehouse', 'dispatch', 'cs'].includes(ctx.state.pos), featOn: () => true,
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    Blob: class { constructor(parts, o) { this.text = parts.join(''); this.type = o.type; calls.blobs.push(this); } },
    URL: { createObjectURL: (b) => 'blob:' + calls.blobs.indexOf(b) },
    document: { createElement: () => ({ click() { calls.clicks.push({ href: this.href, download: this.download }); }, remove() {} }),
      body: { appendChild: () => {} }, getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, s: () => ctx.state.gzb, screen: () => ctx.SUBS.gzbilling.render() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
async function opened(opts, data) {
  const h = mk(opts);
  h.CMD.gzbOpen(); h.screen();
  const c = h.calls.api[h.calls.api.length - 1];
  c.res(data === undefined ? DATA() : data); await tick();
  return h;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · who may open it');
{
  it('the GZ Grocery key, as on the desktop — and never a board that does not see money', () => {
    assert.strictEqual(mk().ctx.canRoute('gzbilling'), true);
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.canRoute('gzbilling'), false);
    assert.strictEqual(mk({ pos: 'warehouse' }).ctx.canRoute('gzbilling'), false);
    const n = mk({ caps: ['orders:view'] }); n.CMD.gzbOpen(); n.CMD.gzbExport();
    assert.deepStrictEqual(n.calls.pushes, []); assert.deepStrictEqual(n.calls.clicks, []);
  });
  it('its door is on the gzgrocery screen\'s card', () => {
    assert.ok(M.includes("${canRoute('gzbilling')?`<button class=\"btn2\" style=\"width:100%\" onclick=\"APP.cmd('gzbOpen')\">${T('Billing','对账')}</button>`:''}"));
  });
}

section('2 · the read');
{
  it('opens on the server\'s own default — no period, no dates — as the desktop does', async () => {
    const h = mk(); h.CMD.gzbOpen(); h.screen();
    assert.strictEqual(h.calls.api[0].p, '/guanyi/analytics?period=');
    assert.ok(/new URLSearchParams\(\{ period: _gyAna\.period \}\)/.test(GY));
  });
  it('a preset re-scopes the range the desktop\'s way, and asks again', () => {
    const h = mk();
    const desk = vm.runInNewContext(block(GY, 'function gyYmd(d)') + block(GY, 'function gyPeriodRange(p)') + '; ({ r: gyPeriodRange })', { Date, String });
    for (const p of ['day', 'week', 'month']) assert.deepStrictEqual(plain(h.ctx.gzbRange(p)), plain(desk.r(p)), p);
    const fixed = new Date(2026, 9, 1); // a Thursday
    assert.deepStrictEqual(plain(h.ctx.gzbRange('week', fixed)), { from: '2026-09-28', to: '2026-10-01' });
    assert.deepStrictEqual(plain(h.ctx.gzbRange('month', fixed)), { from: '2026-10-01', to: '2026-10-01' });
    h.CMD.gzbPeriod('week'); h.screen();
    const r = h.ctx.gzbRange('week');
    assert.strictEqual(h.calls.api[0].p, '/guanyi/analytics?period=week&from=' + r.from + '&to=' + r.to);
    h.CMD.gzbPeriod('decade'); assert.strictEqual(h.s().period, 'week');
  });
  it('a typed date asks again with it; a malformed one is ignored', () => {
    const h = mk(); h.CMD.gzbDate('from', '2026-09-01'); h.CMD.gzbDate('to', 'soon'); h.screen();
    assert.strictEqual(h.calls.api[0].p, '/guanyi/analytics?period=&from=2026-09-01');
  });
}

section('3 · what it shows');
{
  it('the five figures, the unpriced warning, the breakdown and the products', async () => {
    const h = await opened();
    const t = h.text(h.screen());
    for (const w of ['Units ordered 30', 'They owe you ¥456.50', 'gzgrocery price', 'Retail value ¥600.00', 'Avg discount 23.9%', 'Products 2',
      '1 ordered product(s) have no gzgrocery price yet — counted in units but billed at full retail: 黑麦面包 Rye',
      'By day (2)', '2026-09-02', '¥306.50 · 20u', '燕麦奶 "Oat"', 'GVF 1-180', '20 units · retail ¥400.00 · 25%', '10 units · retail ¥200.00 · —', 'Statement CSV']) {
      assert.ok(t.includes(w), w);
    }
  });
  it('more than 50 products says the CSV holds the rest', async () => {
    const d = DATA(); d.products = Array.from({ length: 53 }, (_, i) => ({ product_id: i, name: 'P' + i, units: 1, owed: 1, retail: 1, discount: 0 }));
    const h = await opened({}, d);
    assert.ok(h.text(h.screen()).includes('Showing top 50 of 53 — full list in the CSV.'));
  });
  it('nothing in range: the desktop\'s words, and no CSV to take', async () => {
    const h = await opened({}, { success: true, summary: {}, timeSeries: [], products: [], unpriced: [] });
    const t = h.text(h.screen());
    assert.ok(t.includes('No gzgrocery orders in this range yet') && t.includes('Pickups appear here automatically as gzgrocery sells.'));
    assert.ok(!t.includes('Statement CSV'));
    h.CMD.gzbExport(); assert.deepStrictEqual(h.calls.clicks, []);
  });
  it('a failed read says so and offers Try again', async () => {
    const h = mk(); h.CMD.gzbOpen(); h.screen();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    const t = h.text(h.screen());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
    h.CMD.gzbRetry(); h.screen(); assert.strictEqual(h.calls.api.length, 2);
  });
}

section('4 · the statement');
{
  it('is the file the desktop builds from the same answer, byte for byte, under the same name', async () => {
    const h = await opened();
    h.CMD.gzbExport();
    assert.strictEqual(h.calls.clicks.length, 1);
    assert.strictEqual(h.calls.clicks[0].download, 'gzgrocery-statement_2026-09-01_to_2026-09-30.csv');
    const mine = h.calls.blobs[0];
    assert.strictEqual(mine.type, 'text/csv;charset=utf-8');
    // The desktop's own function, run on the same data.
    const desk = { blobs: [], clicks: [] };
    const dctx = {
      _gyAna: { data: DATA() },
      Blob: class { constructor(parts, o) { this.text = parts.join(''); this.type = o.type; desk.blobs.push(this); } },
      URL: { createObjectURL: () => 'blob:x' },
      document: { createElement: () => ({ click() { desk.clicks.push(this.download); }, remove() {} }), body: { appendChild: () => {} } },
      String, Number, window: {},
    };
    vm.createContext(dctx);
    vm.runInContext(slice(GY, 'window.gyExportStatement = function', '\n  // (Billing is now').replace('window.gyExportStatement', 'this.exp'), dctx);
    dctx.exp();
    assert.strictEqual(mine.text, desk.blobs[0].text);
    assert.strictEqual(h.calls.clicks[0].download, desk.clicks[0]);
    assert.ok(mine.text.startsWith('﻿SKU,Product,Units,Unit gz price,Owed,Retail value,Discount %'));
    assert.ok(mine.text.includes('"燕麦奶 ""Oat"""'), 'quotes doubled');
    assert.ok(mine.text.endsWith(',TOTAL,30,,456.50,600.00,23.9'));
  });
}

section('5 · in Chinese');
{
  it('reads in Chinese', async () => {
    const h = await opened({ lang: 'zh' });
    const t = h.text(h.screen());
    for (const w of ['订货件数', '欠款', '零售价值', '平均折扣', '商品数', '按日 (2)', '对账单 CSV', '个已订货商品尚无 gzgrocery 价格', '共 20 件']) assert.ok(t.includes(w), w);
    assert.strictEqual(h.ctx.SUBS.gzbilling.title[1], '对账');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
