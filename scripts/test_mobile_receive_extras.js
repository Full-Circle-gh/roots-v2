#!/usr/bin/env node
/**
 * §300 P4 — THE RECEIVE SCREEN'S EXTRAS ON THE PHONE: tracking number, the
 * line's 发票 status, and RETURNS (docs/purchase-returns.md, whose "no return
 * UI on the phone" §300 overturns by name).
 *
 *   node scripts/test_mobile_receive_extras.js
 *
 * The desktop's receive table (16-purchasing.js receiveRow) is the spec. The
 * phone's code is RUN, sliced out of public/m.html, and every write is asserted
 * on its REQUEST. What it pins:
 *
 *   1. none of the three rides the counting pause, and none sends
 *      qty_received — a tracking number or a return can never book or clear a
 *      delivery by accident;
 *   2. the 发票 mark saves on its own route, only for purchasing:invoices, and
 *      reads "None · whole order" when the order carries the mark;
 *   3. a return is offered only on a line the server holds as arrived, is
 *      drawn from what was ACCEPTED, is the line's running total, needs a
 *      reason from the five codes, and a refusal is said on its line in the
 *      locked words, with the goods named;
 *   4. the desktop's receive note, with its "come back off both" clause, once
 *      the order has a return.
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
  slice('function recvErrText(e){', '/* ── The screen records itself'),
  slice('const rcvBooked=', "reg('recvRetry'"),
  slice('const RCV_FLAGS=', 'function rcvLine(it){'),
].join('\n');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (v) => JSON.parse(JSON.stringify(v));
function fail(code, extra) { const e = new Error(code); e.code = code; e.body = Object.assign({ success: false, error: code }, extra || {}); return e; }

const PO = () => ({
  id: 7, po_number: 'RPO-0007', status: 'Delivered', store_name_en: 'Tianhe', store_name_cn: '天河店', no_invoice_expected: 0,
  items: [
    { id: 1, name_en: 'Tahini', name_cn: '芝麻酱', qty: 10, unit: 'kg', qty_received: 10, damaged_qty: 1, store_product_id: 3,
      tracking_number: 'SF1', invoice_status: 'not_received', no_invoice_expected: 0, returned_qty: 0 },
    { id: 2, name_en: 'Chickpeas', qty: 25, unit: 'kg', qty_received: null, store_product_id: 4, invoice_status: 'received' },
    { id: 3, name_en: 'Flour', qty: 2, unit: 'bag', qty_received: 2, ingredient_id: 9, returned_qty: 2, return_reason: 'quality',
      returned_at: '2026-09-29 10:00:00', no_invoice_expected: 1 },
  ],
});
const VALS = () => ({
  1: { on: true, recv: 10, dmg: 1, reason: null, was: { recv: 10, dmg: 1, reason: null } },
  2: { on: false, recv: 25, dmg: 0, reason: null, was: { recv: null, dmg: 0, reason: null } },
  3: { on: true, recv: 2, dmg: 0, reason: null, was: { recv: 2, dmg: 0, reason: null } },
});

function mk(opts = {}) {
  const calls = { gets: [], writes: [], toasts: [], renders: 0 };
  const CMD = {};
  const caps = opts.caps === undefined ? ['purchasing:view', 'purchasing:receive', 'purchasing:invoices'] : opts.caps;
  const fresh = opts.fresh || null;
  const ctx = {
    LANG: opts.lang || 'en',
    state: { caps, recvPo: opts.po || PO(), recvVals: VALS(), recvXBusy: null, recvXErr: null, ask: null, askErr: null,
      rcvTried: true, rcvToTried: true },
    escAttr: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    fmtDateOnly: (v) => (v ? 'D' + String(v).slice(5, 10) : ''),
    mCan: (k) => Array.isArray(ctx.state.caps) ? ctx.state.caps.includes(k) : !['purchasing:invoices'].includes(k),
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    api: async (p) => { calls.gets.push(p); return plain(fresh || ctx.state.recvPo); },
    apiWrite: async (p, body, method) => {
      calls.writes.push({ p, body: plain(body), method });
      const r = opts.write ? opts.write(p, body) : undefined;
      if (r instanceof Error) throw r;
      return { success: true };
    },
    Object, Promise, Math, String, Array, JSON, Error, Number, Set, Map, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : zh);
  ctx.APP = { cmd: (n, ...a) => CMD[n](...a) };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, CMD, calls, s: ctx.state };
}
const line = (e, i) => e.s.recvPo.items[i];
const extras = (e, i) => e.ctx.rcvExtras(line(e, i));

// ═══════════════════════════════════════════════════════════════════════════
section('1 · what each line carries');
{
  it('tracking number, 发票 status and Return on a line the server holds as arrived', () => {
    const e = mk();
    const h = extras(e, 0), t = text(h);
    assert.ok(t.includes('Tracking no.') && h.includes('value="SF1"'));
    assert.ok(t.includes('Invoice') && /<option value="not_received" selected>Awaiting/.test(h));
    assert.ok(h.includes("APP.cmd('recvReturn','1')") && t.includes('Return'));
  });
  it('a line nothing has arrived on offers no Return — nothing can go back that has not come in', () => {
    const e = mk();
    assert.ok(!extras(e, 1).includes("recvReturn"));
    assert.ok(extras(e, 1).includes("recvTrack"), 'but its tracking number can be written');
  });
  it('what went back is said, with its reason and its day', () => {
    const e = mk();
    assert.ok(text(extras(e, 2)).includes('2 bag sent back · Quality · D09-29'));
  });
  it('a line whose whole accepted quantity went back offers no further Return', () => {
    const e = mk();
    e.s.recvVals[3].was.recv = 2; line(e, 2).returned_qty = 2;
    // accepted = 2 − 0 = 2 > 0, so the box still opens to correct the total
    assert.ok(extras(e, 2).includes('recvReturn'));
    e.s.recvVals[3].was.dmg = 2;
    assert.ok(!extras(e, 2).includes('recvReturn'), 'all damaged: nothing was accepted');
  });
  it('in Chinese: the desktop\'s words, one language', () => {
    const e = mk({ lang: 'zh' });
    const t = text(extras(e, 2) + extras(e, 0));
    assert.ok(t.includes('运单号') && t.includes('发票') && t.includes('退回 2 bag · 质量问题') && t.includes('退货') && t.includes('待收'));
  });
}

section('2 · the 发票 mark');
{
  it('the whole order marked: "None · whole order", no picker', () => {
    const po = PO(); po.no_invoice_expected = 1;
    const e = mk({ po });
    const h = extras(e, 0);
    assert.ok(text(h).includes('None · whole order') && !h.includes('<select'));
    e.CMD.recvInv('1', 'received');
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('a line marked none reads None', () => {
    const e = mk();
    assert.ok(/<option value="no_invoice" selected>None/.test(extras(e, 2)));
  });
  it('a change sends PUT /purchasing/po/:id/line/:lineId/invoice-status, alone', async () => {
    const e = mk({ fresh: (() => { const p = PO(); p.items[0].invoice_status = 'received'; return p; })() });
    e.CMD.recvInv('1', 'received');
    assert.ok(text(extras(e, 0)).includes('Saving…'));
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchasing/po/7/line/1/invoice-status', body: { invoice_status: 'received' }, method: 'PUT' }]);
    assert.deepStrictEqual(e.calls.toasts, ['Invoice status saved']);
    assert.strictEqual(line(e, 0).invoice_status, 'received', 'the screen reads back what the server holds');
  });
  it('the same value again sends nothing; an unknown value sends nothing', () => {
    const e = mk();
    e.CMD.recvInv('1', 'not_received'); e.CMD.recvInv('1', 'bogus');
    assert.strictEqual(e.calls.writes.length, 0);
  });
  it('without purchasing:invoices — or before capabilities are known — the status reads, and cannot be set', () => {
    for (const caps of [['purchasing:receive'], null]) {
      const e = mk({ caps });
      const h = extras(e, 0);
      assert.ok(!h.includes('<select') && text(h).includes('Awaiting'));
      e.CMD.recvInv('1', 'received');
      assert.strictEqual(e.calls.writes.length, 0);
    }
  });
}

section('3 · the tracking number');
{
  it('saves on its own: PUT /purchases/:id/receive naming the line and the number, and nothing else', async () => {
    const e = mk();
    e.CMD.recvTrack('2', '  SF1402889311 ');
    await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/7/receive', method: 'PUT',
      body: { receipts: [{ line_id: 2, tracking_number: 'SF1402889311' }] } }]);
    assert.ok(!('qty_received' in e.calls.writes[0].body.receipts[0]) && !('receipt_id' in e.calls.writes[0].body));
    assert.deepStrictEqual(e.calls.toasts, ['Tracking saved']);
    assert.ok(e.calls.gets.includes('/purchases/7'));
  });
  it('an unchanged number sends nothing; clearing one sends the empty string', async () => {
    const e = mk();
    e.CMD.recvTrack('1', 'SF1');
    assert.strictEqual(e.calls.writes.length, 0);
    e.CMD.recvTrack('1', ''); await flush();
    assert.deepStrictEqual(e.calls.writes[0].body.receipts[0], { line_id: 1, tracking_number: '' });
  });
  it('a failed save says so on its line, in words, and a toast never reports it', async () => {
    const e = mk({ write: () => fail('boom') });
    e.CMD.recvTrack('2', 'X'); await flush();
    assert.ok(text(extras(e, 1)).includes('That did not save.'));
    assert.ok(!text(extras(e, 0)).includes('That did not save.'), 'only on the line it belongs to');
    assert.deepStrictEqual(e.calls.toasts, []);
  });
}

section('4 · a return');
{
  it('asks how many and why, prefilled with what already went back', () => {
    const e = mk();
    e.CMD.recvReturn('3');
    const a = e.s.ask;
    assert.strictEqual(a.title, 'Return · Flour');
    assert.strictEqual(a.fields[0].value, '2'); assert.strictEqual(a.fields[1].value, 'quality');
    assert.deepStrictEqual(plain(a.fields[1].choices.map((c) => c[0])), ['', 'wrong_item', 'quality', 'expired', 'over_delivery', 'not_needed']);
    assert.strictEqual(a.fields[1].choices[0][1], 'Why?');
    assert.strictEqual(e.calls.writes.length, 0, 'nothing sent by opening it');
  });
  it('not on a line the server does not hold as arrived', () => {
    const e = mk();
    e.CMD.recvReturn('2');
    assert.strictEqual(e.s.ask, null);
  });
  it('refused before the round trip: more than accepted, no reason, not a number', () => {
    const e = mk();
    e.CMD.recvReturn('1');
    const v = e.s.ask.validate;
    assert.strictEqual(v({ qty: '10', reason: 'quality' }), 'That is more than the line accepted. A return can only send back what was taken in.',
      '10 arrived, 1 damaged: 9 accepted');
    assert.strictEqual(v({ qty: '2', reason: '' }), 'Pick a reason for the return');
    assert.strictEqual(v({ qty: 'lots', reason: 'quality' }), 'That returned quantity is not a number.');
    assert.strictEqual(v({ qty: '9', reason: 'expired' }), null);
    assert.strictEqual(v({ qty: '', reason: '' }), null, 'empty is zero: no return');
  });
  it('sends the line\'s running total and its reason — never qty_received', async () => {
    const e = mk();
    e.CMD.recvReturn('1');
    e.s.ask.run({ qty: '3', reason: 'quality' }); await flush();
    assert.deepStrictEqual(e.calls.writes, [{ p: '/purchases/7/receive', method: 'PUT',
      body: { receipts: [{ line_id: 1, returned_qty: 3, return_reason: 'quality' }] } }]);
    assert.deepStrictEqual(e.calls.toasts, ['Saved']);
    assert.strictEqual(e.s.rcvTried, false, 'the Received journal is read again — it gains a return row');
  });
  it('taking a return back to zero sends zero and no reason', async () => {
    const e = mk();
    e.CMD.recvReturn('3');
    e.s.ask.run({ qty: '0', reason: 'quality' }); await flush();
    assert.deepStrictEqual(e.calls.writes[0].body.receipts[0], { line_id: 3, returned_qty: 0, return_reason: null });
  });
  it('a return the shelf cannot cover: the locked words, the goods named, on its line, and it stays', async () => {
    const e = mk({ write: () => fail('return_blocked', { blocking: [{ product_id: 3, name_en: 'Tahini', short: 3 }] }) });
    e.CMD.recvReturn('1');
    e.s.ask.run({ qty: '5', reason: 'quality' }); await flush();
    const t = text(extras(e, 0));
    assert.ok(t.includes('Cannot record this return'));
    assert.ok(t.includes('Some of these goods are no longer in stock, so they cannot be sent back — nothing was changed.'));
    assert.ok(t.includes('Tahini') && t.includes('3 short'));
    assert.deepStrictEqual(e.calls.toasts, []);
    assert.strictEqual(e.s.recvXBusy, null);
  });
  it('the server\'s other refusals are the desktop\'s sentences', async () => {
    const e = mk({ write: () => fail('return_before_receipt') });
    e.CMD.recvReturn('1'); e.s.ask.run({ qty: '1', reason: 'expired' }); await flush();
    assert.ok(text(extras(e, 0)).includes('Nothing has arrived on that line yet, so nothing can go back. Record the delivery first.'));
  });
  it('one extra write at a time', async () => {
    const e = mk();
    e.CMD.recvTrack('2', 'A'); e.CMD.recvTrack('1', 'B'); e.CMD.recvReturn('1');
    assert.strictEqual(e.calls.writes.length, 1);
    assert.strictEqual(e.s.ask, null);
  });
}

section('5 · the note that says where a return went');
{
  it('once the order has a return: the desktop\'s receive note, ending "come back off both"', () => {
    const e = mk();
    const t = text(e.ctx.rcvReturnNote(e.s.recvPo));
    assert.ok(t.includes('Confirmed counts go into Tianhe stock by themselves Damaged units are kept out of stock. Returned units come back off both.'), t);
  });
  it('a channel the products are listed on is named too', () => {
    const po = PO(); po.items[0].channel_listed = true;
    const e = mk({ po });
    assert.ok(text(e.ctx.rcvReturnNote(po)).includes('and sync out to every sales channel.'));
  });
  it('no return, or an all-material order (no stock to promise): no note', () => {
    const none = PO(); none.items.forEach((i) => { i.returned_qty = 0; });
    assert.strictEqual(mk({ po: none }).ctx.rcvReturnNote(none), '');
    const mat = PO(); mat.items = [mat.items[2]];
    assert.strictEqual(mk({ po: mat }).ctx.rcvReturnNote(mat), '');
  });
}

section('6 · the design record points forward');
{
  it('docs/purchase-returns.md #5 keeps its text and says §300 overturned it', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/purchase-returns.md'), 'utf8');
    assert.ok(doc.includes('**No return UI on the phone.**'), 'the old text stays');
    assert.ok(/OVERTURNED 2026-09-30 by §300/.test(doc));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
