#!/usr/bin/env node
/**
 * §300 P3 — FROM THE KITCHEN ON THE PHONE: the buyer's side of §86.
 *
 *   node scripts/test_mobile_purchasing_kitchen.js
 *
 * A cook asks for materials; the lines wait in Purchasing until a buyer ticks
 * them and makes ONE DRAFT order (desktop: 16-purchasing.js puMrOpen …
 * puMrMake). The phone's code is RUN, sliced out of public/m.html, and every
 * write is asserted on its REQUEST. What it pins:
 *
 *   1. the card on the orders list: only when something is waiting, only for
 *      purchasing:edit with Production on, with the urgent lines called out;
 *   2. the sheet: the lines with the kitchen's two marks (urgent, wanted-by)
 *      both printed, search, tick, select all shown, empty / failed states;
 *   3. Make draft: POST /purchases/from-material-requests with the ticked
 *      lines, the store and the optional supplier, then the draft opens; its
 *      refusals (already ordered, struck off) said in words, the list re-read;
 *   4. the ✕: one line struck off for good, behind the desktop's confirm.
 *
 * No browser — this runs in the fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
  });
}
function slice(from, to) {
  const a = M.indexOf(from);
  assert.notStrictEqual(a, -1, 'not found in m.html: ' + from);
  const b = M.indexOf(to, a + from.length);
  assert.notStrictEqual(b, -1, 'not found after ' + from + ': ' + to);
  return M.slice(a, b);
}
const SRC = [
  slice('const PILL = {', 'function toggle('),
  slice('const CAT_CJK=', 'function catLabels('),
  slice('const rcvPartial=', 'function rcvToReceive(){'),
  slice('function rcvMatched(r){', 'function statusReceiving(){'),
  slice('const poMoney=', '/* ==========================================================================\n   §286 — Suppliers we owe'),
].join('\n');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (v) => JSON.parse(JSON.stringify(v));
function fail(code, extra) { const e = new Error(code); e.code = code; e.body = Object.assign({ success: false, error: code }, extra || {}); return e; }

const LINES = [
  { id: 5, request_id: 1, ingredient_id: 7, name_en: 'Dill, fresh', name_cn: '莳萝', sku: 'M-5', qty: 2, unit: 'kg', notes: '',
    urgent: 1, needed_by: '2026-10-01', mr_number: 'MR-088', date: '2026-09-29', created_by_name: 'Mei' },
  { id: 6, request_id: 1, ingredient_id: 8, name_en: 'Lemons', qty: 5, unit: 'kg', urgent: 0, needed_by: null,
    mr_number: 'MR-088', date: '2026-09-29', created_by_name: 'Mei' },
  { id: 9, request_id: 2, ingredient_id: 9, name_en: 'Tub 200 ml', qty: 500, unit: 'pcs', notes: 'for the weekend', urgent: 0,
    needed_by: null, mr_number: 'MR-090', date: '2026-09-30', created_by_name: 'Jun' },
];
const STORES = [{ id: 1, name_en: 'Tianhe', name_cn: '天河店' }, { id: 2, name_en: 'Yuexiu', name_cn: '越秀店' }];

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], renders: 0, opened: [] };
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:edit'] : opts.caps;
  let lines = plain(opts.lines || LINES);
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    state: Object.assign({
      caps, stores: plain(opts.stores || STORES), stack: [{ route: 'purchasing' }],
      poList: [], posTried: true, poSeg: 'all', poId: null, poDetail: null, poErr: null, poBusy: false,
      poView: 'orders', poQ: '', poMonth: '', poStoreF: '', poFound: null, poFoundErr: null,
      poRefusal: null, poLc: null, poPrint: false, ask: null,
      pw: null, pwc: { stock: {}, stockErr: {}, mats: null, sups: null, cats: null, hist: {}, info: {}, tried: {} }, pwSheet: null,
      pkLines: null, pkErr: null, pkTried: false, pk: null,
    }, opts.state || {}),
    E: (en, zh) => ({ toString() { return ctx.LANG === 'en' ? en : zh; } }),
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    money: (cur, n) => (cur || '¥') + Number(n || 0), money0: (cur, n) => (cur || '¥') + Math.round(Number(n || 0)),
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5) : ''),
    shopToday: () => '2026-09-30', tdWhen: () => 'STAMP', _tdL: () => ({}),
    nothingYet: (t, m) => `<div>${t}</div><div>${m}</div>`,
    searchBox: (inner, id) => `<span>${inner}<button id="${id}"></button></span>`,
    searchClearShow: () => {}, footBar: (inner) => inner, catLabel: (v) => String(v || ''),
    featOn: (k) => !(opts.off || []).includes(k),
    canRoute: () => true,
    mCan: (k) => !Array.isArray(ctx.state.caps) || ctx.state.caps.includes(k),
    push: () => {}, screenSupOwed: () => '', statusSupOwed: () => '', poDeliveries: () => '', loadPoReceipts: () => {},
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    setTimeout: (f) => { f(); return 1; }, clearTimeout: () => {},
    document: { getElementById: () => null, activeElement: null },
    api: async (p) => {
      calls.gets.push(p);
      if (p === '/material-requests/pending-lines') {
        if (opts.linesFail && opts.linesFail()) throw new Error('HTTP 500');
        return plain(lines);
      }
      if (p === '/stores') return plain(STORES);
      return [];
    },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: plain(body), method });
      const r = opts.write ? opts.write(p, body, method) : undefined;
      if (r instanceof Error) throw r;
      if (/decline$/.test(p)) { const id = Number(p.split('/')[3]); lines = lines.filter((l) => l.id !== id); }
      if (r !== undefined) return r;
      return { success: true, data: { id: 50, po_number: 'RPO-0050', line_count: body.line_ids ? body.line_ids.length : 0 } };
    },
    Object, Promise, Math, Date, String, Array, JSON, Error, Number, Set, Map, parseFloat, encodeURIComponent, isFinite,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => { if (n === 'openPO') { calls.opened.push(a[0]); return; } return CMD[n](...a); } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, s: ctx.state };
}
const listed = async (opts) => { const e = mk(opts); e.ctx.screenPurchasing(); await flush(); return e; };
const opened = async (opts) => { const e = await listed(opts); e.CMD.pkOpen(); await flush(); return e; };
const sheet = (e) => text(e.ctx.sheetPK());

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the card on the orders list');
{
  it('shows what is waiting, and that some of it is urgent', async () => {
    const e = await listed();
    assert.ok(e.calls.gets.includes('/material-requests/pending-lines'));
    const t = text(e.ctx.screenPurchasing());
    assert.ok(/From the kitchen\s+Urgent\s+3/.test(t), t);
  });
  it('is there on an empty ledger too — the kitchen can ask before anything was ever ordered', async () => {
    const e = await listed();
    assert.ok(text(e.ctx.screenPurchasing()).includes('From the kitchen'));
  });
  it('nothing waiting: no card', async () => {
    const e = await listed({ lines: [] });
    assert.ok(!text(e.ctx.screenPurchasing()).includes('From the kitchen'));
  });
  it('Production off, or no purchasing:edit: no card, and nothing is read', async () => {
    for (const o of [{ off: ['production'] }, { caps: ['purchasing:view'] }]) {
      const e = await listed(o);
      assert.ok(!e.calls.gets.includes('/material-requests/pending-lines'));
      assert.ok(!text(e.ctx.screenPurchasing()).includes('From the kitchen'));
      e.CMD.pkOpen();
      assert.strictEqual(e.s.pk, null);
    }
  });
  it('a failed read leaves the list standing, with no card', async () => {
    const e = await listed({ linesFail: () => true });
    const t = text(e.ctx.screenPurchasing());
    assert.ok(!t.includes('From the kitchen') && t.includes('No purchase orders yet'));
  });
}

section('2 · the sheet');
{
  it('opening it reads the list again, and says it is loading until it lands', async () => {
    const e = await listed();
    e.CMD.pkOpen();
    assert.ok(sheet(e).includes('Loading…'));
    await flush();
    assert.strictEqual(e.calls.gets.filter((g) => g === '/material-requests/pending-lines').length, 2);
  });
  it('each line: what, how much, who asked and when, and the kitchen\'s two marks', async () => {
    const e = await opened();
    const t = sheet(e);
    for (const w of ['From the kitchen', 'Materials the kitchen has asked for.', 'Dill, fresh · 2 kg', 'MR-088 · Mei · D09-29 · M-5',
      'Urgent', 'by D10-01', 'Tub 200 ml · 500 pcs', 'for the weekend', 'File under store', 'Tianhe',
      'Tick the lines you are buying.', 'Make draft']) assert.ok(t.includes(w), 'missing ' + w);
    assert.ok(e.ctx.sheetPK().includes('placeholder="Optional — set it later"'));
  });
  it('in Chinese: one language, and the day before 订购', async () => {
    const e = await opened({ lang: 'zh' });
    const t = sheet(e);
    assert.ok(t.includes('莳萝') && t.includes('D10-01 订购') && t.includes('加急') && t.includes('公斤'));
    assert.ok(!t.includes('Dill'));
  });
  it('nothing asked for, nothing matching, and a failed read each say so', async () => {
    const none = await opened({ lines: [] });
    assert.ok(sheet(none).includes('The kitchen has not asked for anything.'));
    const e = await opened();
    e.CMD.pkQ('zzz');
    assert.ok(sheet(e).includes('Nothing matches that search.'));
    let n = 0;
    const bad = await listed({ linesFail: () => n++ >= 1 && n < 3 });
    bad.CMD.pkOpen(); await flush();
    assert.ok(sheet(bad).includes('Could not load this.') && sheet(bad).includes('Try again'));
    bad.CMD.pkRetry(); await flush();
    assert.ok(sheet(bad).includes('Dill'));
  });
  it('search reaches the request number and who asked', async () => {
    const e = await opened();
    e.CMD.pkQ('jun');
    const t = sheet(e);
    assert.ok(t.includes('Tub 200 ml') && !t.includes('Lemons'));
  });
  it('tick and untick; Select all shown ticks only what the search shows, and unticks it again', async () => {
    const e = await opened();
    e.CMD.pkTick(6); e.CMD.pkTick(5); e.CMD.pkTick(6);
    assert.deepStrictEqual(plain(e.s.pk.pick), [5]);
    e.CMD.pkQ('mr-088'); e.CMD.pkAll();
    assert.deepStrictEqual(plain(e.s.pk.pick).sort(), [5, 6]);
    e.CMD.pkAll();
    assert.deepStrictEqual(plain(e.s.pk.pick), []);
    e.CMD.pkTick(999);
    assert.deepStrictEqual(plain(e.s.pk.pick), [], 'a line not on the list cannot be ticked');
  });
  it('the button counts the ticks and says a draft is all it makes', async () => {
    const e = await opened();
    assert.ok(/disabled[^>]*onclick="APP.cmd\('pkMake'\)"/.test(e.ctx.sheetPK()));
    e.CMD.pkTick(5); e.CMD.pkTick(9);
    const t = sheet(e);
    assert.ok(t.includes('Draft 2 lines') && t.includes('This makes a DRAFT. Nothing is ordered and nothing reaches the books until you mark it Ordered.'));
    e.CMD.pkTick(9);
    assert.ok(sheet(e).includes('Draft 1 line'));
  });
}

section('3 · Make draft');
{
  it('sends the ticked lines, the store and no supplier, then opens the draft', async () => {
    const e = await opened();
    e.CMD.pkTick(5); e.CMD.pkTick(9); e.CMD.pkField('store', '2');
    e.CMD.pkMake();
    assert.ok(sheet(e).includes('Working…'), 'says what it is doing');
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/from-material-requests', method: 'POST',
      body: { line_ids: [5, 9], store_id: 2, supplier: null } }]);
    assert.deepStrictEqual(e.calls.toasts, ['RPO-0050 drafted from 2 lines']);
    assert.deepStrictEqual(e.calls.opened, [50]);
    assert.strictEqual(e.s.pk, null);
    assert.ok(e.calls.gets.filter((g) => g === '/material-requests/pending-lines').length >= 3, 'the waiting list is read again');
    assert.ok(e.calls.gets.includes('/purchases'), 'and the orders');
  });
  it('a supplier typed is sent, trimmed', async () => {
    const e = await opened();
    e.CMD.pkTick(6); e.CMD.pkField('supplier', '  Metro ');
    e.CMD.pkMake(); await flush();
    assert.deepStrictEqual(e.calls.writes[0].body, { line_ids: [6], store_id: 1, supplier: 'Metro' });
  });
  it('nothing ticked, or no store: nothing is sent', async () => {
    const e = await opened();
    e.CMD.pkMake();
    const n = await opened({ stores: [] });
    n.s.stores = [];
    n.CMD.pkTick(5); n.CMD.pkMake();
    assert.strictEqual(e.calls.writes.length + n.calls.writes.length, 0);
    assert.ok(sheet(n).includes('No stores'));
    assert.ok(sheet(n).includes('Pick a store first.'));
  });
  it('already ordered by somebody else: named, with its order, and the list read again', async () => {
    const e = await opened({ write: () => fail('already_sourced', { lines: [{ id: 5, name_en: 'Dill, fresh', po_number: 'RPO-0049' }] }) });
    e.CMD.pkTick(5); e.CMD.pkMake(); await flush();
    assert.ok(sheet(e).includes('Already ordered: Dill, fresh → RPO-0049'));
    assert.deepStrictEqual(e.calls.toasts, []);
    assert.strictEqual(e.s.pk.busy, null);
    assert.strictEqual(e.calls.gets.filter((g) => g === '/material-requests/pending-lines').length, 3);
  });
  it('struck off by another buyer: the desktop\'s sentence', async () => {
    const e = await opened({ write: () => fail('line_declined') });
    e.CMD.pkTick(6); e.CMD.pkMake(); await flush();
    assert.ok(sheet(e).includes('That line was removed and is no longer being bought.'));
  });
  it('anything else: the house line, ticks kept', async () => {
    const e = await opened({ write: () => fail('boom') });
    e.CMD.pkTick(6); e.CMD.pkMake(); await flush();
    assert.ok(sheet(e).includes('That did not save. Nothing has changed — try again.'));
    assert.deepStrictEqual(plain(e.s.pk.pick), [6]);
  });
}

section('4 · striking a line off');
{
  it('asks the desktop\'s question first, and sends nothing until confirmed', async () => {
    const e = await opened();
    e.CMD.pkDecline(5);
    assert.strictEqual(e.s.ask.title, 'Remove this line?');
    assert.ok(e.s.ask.body.startsWith('The kitchen asked for it and it will not be bought. It leaves this list for good'));
    assert.strictEqual(e.s.ask.confirmLabel, 'Remove'); assert.strictEqual(e.s.ask.danger, true);
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('sends PUT /material-requests/lines/:id/decline, unticks it, and reads the list again', async () => {
    const e = await opened();
    e.CMD.pkTick(5); e.CMD.pkTick(6);
    e.CMD.pkDecline(5); e.s.ask.run(); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/material-requests/lines/5/decline', body: {}, method: 'PUT' }]);
    assert.deepStrictEqual(plain(e.s.pk.pick), [6]);
    assert.deepStrictEqual(e.calls.toasts, ['Removed']);
    assert.ok(!sheet(e).includes('Dill'));
  });
  it('a line already on an order cannot be struck off, and says so', async () => {
    const e = await opened({ write: () => fail('already_sourced') });
    e.CMD.pkDecline(5); e.s.ask.run(); await flush();
    assert.ok(sheet(e).includes('That line is already on a purchase order.'));
  });
  it('without purchasing:edit there is no ✕ and no way round it', async () => {
    const e = await opened();
    e.s.caps = ['purchasing:view'];
    assert.ok(!e.ctx.sheetPK().includes("APP.cmd('pkDecline'"));
    e.CMD.pkDecline(5);
    assert.strictEqual(e.s.ask, null);
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
