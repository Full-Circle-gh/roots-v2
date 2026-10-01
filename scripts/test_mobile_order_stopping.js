#!/usr/bin/env node
/**
 * §325 X12 — THE SWITCHES THAT STOP ORDERS EVERYWHERE AT ONCE, ON THE PHONE.
 *
 *   node scripts/test_mobile_order_stopping.js
 *
 * §326.2 brought four holds to the phone: the online store and "everything"
 * open/close (02-settings-ops.js ocSetOnline / ocMaster, /store-status/*), a
 * channel closed at every store (01-core.js csChannelToggle,
 * /channel-status/channel), and the Meituan and Eleme channel switches
 * (11-meituan.js mtToggleChannel, 14-eleme.js elToggleEnabled).
 *
 * What is asserted: each write's method, path and every body field; each is
 * behind a confirm that names what stops and what does not, and nothing is sent
 * before it; each control is drawn only for the keys lib/cap-routes.js asks of
 * that write, and NOT while the keys are still loading (fail closed); without
 * the keys the commands send nothing; refusals and failures render where the
 * operator is looking and toasts report only success; loading and failed
 * reads; both languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const cap = require('../lib/cap-routes.js');

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

const X12 = slice(M, '§325 X12 — THE SWITCHES THAT STOP ORDERS', "/* The Sales board's own retry");
const SRC = [
  line(M, 'function E(en, zh)'),
  slice(M, 'const PILL = {', '\n};') + '\n};',
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, 'const CHAN_META={', 'function statusSales(){'),
  block(M, 'function screenSales(){'),
  '/*' + X12,
  // §325 S2m — the Eleme close sentences the X12 confirms share.
  '/*' + slice(M, '§325 S2m — WHAT CLOSING ELEME ACTUALLY DOES', '/* One store on one channel.'),
].join('\n');

const SALES = ['dashboard:view'];
const ALL = ['dashboard:view', 'meituan:sync', 'eleme:sync'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const cell = (code, en, cn, open, extra) => Object.assign({ storeCode: code, nameEn: en, nameCn: cn, open }, extra || {});
const GRID = () => ({
  channels: [
    { channel: 'meituan', integrated: true, cardOpen: true,
      cells: [cell('tianhe', 'Tianhe', '天河店', true), cell('yuexiu', 'Yuexiu', '越秀店', false)] },
    { channel: 'pos', integrated: true, cardOpen: false,
      cells: [cell('tianhe', 'Tianhe', '天河店', false), cell('yuexiu', 'Yuexiu', '越秀店', false)] },
  ],
  locations: [{ storeCode: 'tianhe', nameEn: 'Tianhe', nameCn: '天河店', shopOpen: true },
    { storeCode: 'yuexiu', nameEn: 'Yuexiu', nameCn: '越秀店', shopOpen: false }],
});
const STATUS = (over) => Object.assign({ success: true, master: 'mixed',
  online: { online_open: true, message_en: '', message_cn: '' },
  meituan: [{ storeCode: 'tianhe', name: '天河店', linked: true, isOpen: true, fulfillmentOpen: true }] }, over || {});

function mk(opts = {}) {
  const calls = { reads: [], writes: [], toasts: [], loads: 0, mtStatus: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    state: {
      caps: opts.caps === undefined ? ALL : opts.caps,
      chan: GRID(), chanSheet: null, chanBusy: null, chanErr: null, chanLoadErr: null, shopBusy: null, shopErr: null,
      sales: null, oc: null, ocTried: false, ocLoadErr: null, ocBusy: null, ocErr: null,
      mtCfg: null, mtCfgTried: false, chSwBusy: null, chSwErr: null, elm: { tried: true, cfg: null },
      ask: null,
    },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    loadChannels: () => { calls.loads++; },
    x8MtStatus: () => { calls.mtStatus++; },
    money0: (c, v) => c + Math.round(v), nothingYet: (a, b) => a + ' ' + b,
    apiRaw: (p) => new Promise((res, rej) => { calls.reads.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.X12_OC_KEYS=X12_OC_KEYS; this.X12_SALES_KEYS=X12_SALES_KEYS; this.X12_CH_KEY=X12_CH_KEY;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, st: ctx.state };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const fn = (h, name) => vm.runInContext(name, h.ctx);
const answer = async (h, p, v) => {
  const c = h.calls.reads.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.reads.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
};
const fail = async (h, p, err) => {
  const c = h.calls.reads.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p);
  c.done = true; c.rej(err); await tick();
};
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
const askText = (h) => { const a = h.st.ask; assert.ok(a, 'no confirm'); return { title: String(a.title), body: String(a.body), ok: String(a.confirmLabel), danger: !!a.danger }; };
async function oc(opts, status) {
  const h = mk(opts);
  fn(h, 'ocCard')();
  await answer(h, '/store-status', STATUS(status));
  return h;
}
const sheet = (h, ch) => { h.st.chanSheet = ch; return h.text(fn(h, 'sheetChannel')()); };
const sameSet = (a, b, why) => assert.deepStrictEqual([...a].sort(), [...b].sort(), why);

// ─────────────────────────────────────────────────────────────────────────
section('1 · each control asks the server\'s own keys');
{
  it('the phone\'s key lists are exactly what lib/cap-routes.js asks of each write', () => {
    const h = mk();
    const P = (p) => cap.requiredCapFor('POST', '/api/retail-admin' + p);
    sameSet(plain(h.ctx.X12_OC_KEYS), P('/store-status/online'), 'online store');
    sameSet(plain(h.ctx.X12_OC_KEYS), P('/store-status/master'), 'everything');
    sameSet(plain(h.ctx.X12_SALES_KEYS), P('/channel-status/channel'), 'a channel at every store');
    assert.strictEqual(P('/meituan/enable'), 'meituan:sync');
    assert.strictEqual(P('/eleme/enable'), 'eleme:sync');
    assert.strictEqual(h.ctx.X12_CH_KEY.meituan, 'meituan:sync');
    assert.strictEqual(h.ctx.X12_CH_KEY.eleme, 'eleme:sync');
    assert.ok(!P('/store-status/online').includes('settings:edit'), 'settings:edit is not a key');
  });
  it('while the keys are still loading nothing is drawn, nothing is read, and nothing is sent', async () => {
    const h = mk({ caps: null });
    assert.strictEqual(fn(h, 'ocCard')(), '');
    assert.ok(!sheet(h, 'meituan').includes('Close channel'));
    h.st.mtCfg = { success: true, enabled: true }; h.st.elm.cfg = { success: true, enabled: true };
    assert.strictEqual(fn(h, 'chSwitchCard')('meituan'), '');
    assert.strictEqual(fn(h, 'chSwitchCard')('eleme'), '');
    h.st.oc = STATUS();
    h.CMD.ocOnline(0); h.CMD.ocMaster(0); h.CMD.chanAll('meituan', 0); h.CMD.chSwitch('meituan', 0); h.CMD.chSwitch('eleme', 0);
    await tick();
    assert.strictEqual(h.st.ask, null, 'no confirm opens');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(!h.calls.reads.some((r) => r.p === '/store-status' || r.p === '/meituan/config'), 'no read either');
  });
  it('without the keys: the same — the facts on the board stay, the switches do not', async () => {
    const h = mk({ caps: ['orders:view', 'meituan:view', 'eleme:view'] });
    h.st.mtCfg = { success: true, enabled: true }; h.st.elm.cfg = { success: true, enabled: true };
    assert.strictEqual(fn(h, 'chSwitchCard')('meituan'), '', 'meituan:view is not meituan:sync');
    assert.strictEqual(fn(h, 'chSwitchCard')('eleme'), '', 'eleme:view is not eleme:sync');
    h.CMD.chSwitch('meituan', 0); h.CMD.chSwitch('eleme', 1);
    const n = mk({ caps: ['orders:view'] });
    assert.strictEqual(fn(n, 'ocCard')(), '');
    assert.ok(!sheet(n, 'meituan').includes('Close channel'));
    assert.ok(sheet(n, 'meituan').includes('Tianhe'), 'the rows still read');
    n.st.oc = STATUS(); n.CMD.ocOnline(0); n.CMD.ocMaster(1); n.CMD.chanAll('meituan', 0);
    await tick();
    assert.strictEqual(h.st.ask, null); assert.strictEqual(n.st.ask, null);
    assert.strictEqual(h.calls.writes.length + n.calls.writes.length, 0);
  });
  it('any one key of the any-of opens each — Settings alone opens the open/close card', async () => {
    const h = await oc({ caps: ['settings:shop'] });
    assert.ok(h.text(fn(h, 'ocCard')()).includes('Online store'));
    assert.ok(!sheet(h, 'meituan').includes('Close channel'), 'the whole-channel flip is the Sales keys only');
    const s = mk({ caps: ['eleme:view'] });
    assert.ok(sheet(s, 'meituan').includes('Close channel'));
  });
  it('the cards sit where their desktop switches do', () => {
    assert.ok(block(M, 'function screenSales(){').includes('${ocCard()'));
    assert.ok(block(M, 'function mirrorScreen(which,note)').includes("chSwitchCard('meituan')"));
    assert.ok(block(M, 'function screenEleme(){').includes("${chSwitchCard('eleme')"));
    assert.ok(!block(M, 'function screenSales(){').includes("T('Closing a whole channel everywhere is on desktop'"), 'the footer that denied it is gone');
  });
}

section('2 · the online store and everything — /store-status');
{
  it('loading, then the master state and the online store, in the desktop\'s words', async () => {
    const h = mk();
    assert.ok(h.text(fn(h, 'ocCard')()).includes('Loading…'));
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/store-status').length, 1);
    fn(h, 'ocCard')();
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/store-status').length, 1, 'read once, not per paint');
    await answer(h, '/store-status', STATUS());
    const t = h.text(fn(h, 'ocCard')());
    for (const w of ['Open for business', 'Some channels are closed', 'Close everything', 'Online store', 'Open']) assert.ok(t.includes(w), w);
    h.st.oc = STATUS({ master: 'closed', online: { online_open: false } });
    const c = h.text(fn(h, 'ocCard')());
    assert.ok(c.includes('Everything is closed') && c.includes('Open everything') && c.includes('Closed'));
    h.st.oc = STATUS({ master: 'open' });
    assert.ok(h.text(fn(h, 'ocCard')()).includes('Everything is open'));
  });
  it('a failed read says so with a retry, and draws no switch', async () => {
    const h = mk(); fn(h, 'ocCard')();
    await fail(h, '/store-status', new Error('HTTP 500'));
    const t = h.text(fn(h, 'ocCard')());
    assert.ok(t.includes('Could not read the shop status') && t.includes('Try again'));
    assert.ok(!t.includes('Close everything') && !t.includes('Online store'));
    h.CMD.ocRetry();
    await answer(h, '/store-status', STATUS());
    assert.ok(h.text(fn(h, 'ocCard')()).includes('Online store'));
  });
  it('an answer that is not success is a failed read, not an open shop', async () => {
    const h = mk(); fn(h, 'ocCard')();
    await answer(h, '/store-status', { success: false, error: 'x' });
    assert.ok(h.text(fn(h, 'ocCard')()).includes('Could not read the shop status'));
  });
  it('closing the online store asks first, naming what stops and what does not', async () => {
    const h = await oc();
    h.CMD.ocOnline(0);
    const a = askText(h);
    assert.strictEqual(a.title, 'Close the online store?');
    assert.ok(a.body.includes('The mini app and web store stop taking new orders'));
    assert.ok(a.body.includes('Every other channel and the counter till keep selling'));
    assert.ok(a.body.includes('orders already placed are not affected'));
    assert.ok(a.danger); assert.strictEqual(a.ok, 'Close');
    assert.strictEqual(h.calls.writes.length, 0, 'nothing before the confirm');
  });
  it('confirming POSTs /store-status/online {open:false}, disables the card, then re-reads both boards', async () => {
    const h = await oc();
    h.CMD.ocOnline(0); h.st.ask.run();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/store-status/online'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { open: false });
    const html = fn(h, 'ocCard')();
    assert.ok(h.text(html).includes('Saving…'));
    assert.ok(/<button class="btn2" disabled/.test(html), 'the master is disabled while it runs');
    h.CMD.ocMaster(0); assert.strictEqual(h.calls.writes.length, 1, 'a second tap sends nothing');
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Online store is closed']);
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/store-status').length, 2, 'the status is read again');
    assert.strictEqual(h.calls.loads, 1, 'and the grid');
  });
  it('opening the online store says it opens only where its channel is open', async () => {
    const h = await oc({}, { online: { online_open: false } });
    h.CMD.ocOnline(1);
    const a = askText(h);
    assert.strictEqual(a.title, 'Open the online store?');
    assert.ok(a.body.includes('wherever their own channel is open'));
    assert.ok(!a.danger);
    h.st.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { open: true });
    W(h, 0).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Online store is open']);
  });
  it('close everything names the online store, every shop, the till and Meituan\'s minute', async () => {
    const h = await oc({}, { master: 'open' });
    h.CMD.ocMaster(0);
    const a = askText(h);
    assert.strictEqual(a.title, 'Close everything?');
    for (const w of ['The online store closes', 'every shop stops taking orders on every channel and at the counter till',
      'every Meituan shop closes within about a minute', 'Orders already placed are not affected']) assert.ok(a.body.includes(w), w);
    assert.ok(a.danger); assert.strictEqual(a.ok, 'Close everything');
    h.st.ask.run();
    assert.strictEqual(W(h, 0).p, '/store-status/master'); assert.deepStrictEqual(W(h, 0).body, { open: false });
    W(h, 0).res({ success: true, target: 'closed' }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Closing every channel — marketplaces follow within about a minute']);
  });
  it('open everything says what it does NOT reopen', async () => {
    const h = await oc({}, { master: 'closed' });
    h.CMD.ocMaster(1);
    const a = askText(h);
    assert.strictEqual(a.title, 'Open everything?');
    assert.ok(a.body.includes('Any other channel closed at a shop — on its own or with the shop’s switch — stays closed'));
    h.st.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { open: true });
    W(h, 0).res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Opening every channel']);
  });
  it('a refusal stays on the card, and no toast claims it', async () => {
    const h = await oc();
    h.CMD.ocMaster(0); h.st.ask.run(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(fn(h, 'ocCard')()).includes('You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.strictEqual(h.st.ocBusy, null, 'the card is live again');
  });
  it('a failure says nothing changed', async () => {
    const h = await oc();
    h.CMD.ocOnline(0); h.st.ask.run(); W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(fn(h, 'ocCard')()).includes('That did not save. Nothing has changed — try again.'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a signed-out session neither toasts nor paints an error', async () => {
    const h = await oc();
    h.CMD.ocOnline(0); h.st.ask.run(); W(h, 0).rej(new Error('auth')); await tick();
    assert.strictEqual(h.st.ocErr, null); assert.deepStrictEqual(h.calls.toasts, []);
  });
}

section('3 · a channel at every store — /channel-status/channel');
{
  it('the sheet offers it under the rows, and no longer sends it to the desktop', () => {
    const h = mk({ caps: SALES });
    const t = sheet(h, 'meituan');
    assert.ok(t.includes('Close channel'));
    assert.ok(!t.includes('on desktop'));
    assert.ok(sheet(h, 'pos').includes('Open channel'), 'a channel shut everywhere offers the other way');
  });
  it('closing asks the desktop\'s question and says orders already placed are untouched', async () => {
    const h = mk({ caps: SALES });
    h.CMD.chanAll('meituan', 0);
    const a = askText(h);
    assert.strictEqual(a.title, 'Close this channel at every store?');
    assert.ok(a.body.includes('No new orders arrive on this channel at any store. Orders already placed are not affected.'));
    assert.ok(a.body.includes('Meituan follows within about a minute.'), 'Meituan is queued, and says so');
    assert.strictEqual(a.ok, 'Close channel'); assert.ok(a.danger);
    assert.strictEqual(h.calls.writes.length, 0);
    const p = mk({ caps: SALES }); p.CMD.chanAll('pos', 0);
    assert.ok(!askText(p).body.includes('Meituan'), 'only Meituan carries the minute');
  });
  it('confirming POSTs {channel, open:false} and disables every row while it runs', async () => {
    const h = mk({ caps: SALES });
    h.st.chanSheet = 'meituan';
    h.CMD.chanAll('meituan', 0); h.st.ask.run();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/channel-status/channel'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { channel: 'meituan', open: false });
    const html = fn(h, 'sheetChannel')();
    assert.ok(h.text(html).includes('Saving…'));
    assert.ok(!/<button\s+onclick="APP\.cmd\('chanCell'/.test(html), 'no row is live');
    w.res({ success: true, stores: ['tianhe', 'yuexiu'], skipped: [] }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.strictEqual(h.calls.loads, 1);
  });
  it('opening skips a closed shop and the toast names it, in the desktop\'s words', async () => {
    const h = mk({ caps: SALES });
    h.CMD.chanAll('pos', 1);
    const a = askText(h);
    assert.strictEqual(a.title, 'Open this channel at every store?');
    assert.ok(a.body.includes('A shop that is closed stays closed.'));
    assert.strictEqual(a.ok, 'Open channel');
    h.st.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { channel: 'pos', open: true });
    W(h, 0).res({ success: true, stores: ['tianhe'], skipped: ['yuexiu'] }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved · Yuexiu: Shop closed']);
  });
  it('a refusal stays in the sheet', async () => {
    const h = mk({ caps: SALES });
    h.st.chanSheet = 'meituan';
    h.CMD.chanAll('meituan', 0); h.st.ask.run(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(sheet(h, 'meituan').includes('You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.strictEqual(h.st.chanBusy, null);
  });
  it('an unknown channel sends nothing', async () => {
    const h = mk({ caps: SALES });
    h.CMD.chanAll('nope', 0); await tick();
    assert.strictEqual(h.st.ask, null); assert.strictEqual(h.calls.writes.length, 0);
  });
}

section('4 · the Meituan and Eleme channel switches — /<channel>/enable');
{
  it('Meituan: read /meituan/config, then on with a Turn off', async () => {
    const h = mk();
    assert.strictEqual(fn(h, 'chSwitchCard')('meituan'), '', 'nothing before the switch\'s state is known');
    await answer(h, '/meituan/config', { success: true, enabled: true });
    const t = h.text(fn(h, 'chSwitchCard')('meituan'));
    assert.ok(t.includes('Channel on') && t.includes('Turn off'));
    fn(h, 'chSwitchCard')('meituan');
    assert.strictEqual(h.calls.reads.filter((r) => r.p === '/meituan/config').length, 1);
  });
  it('a switch whose state did not read is not drawn', async () => {
    const h = mk(); fn(h, 'chSwitchCard')('meituan');
    await fail(h, '/meituan/config', new Error('HTTP 500'));
    assert.strictEqual(fn(h, 'chSwitchCard')('meituan'), '');
    h.st.elm.cfg = { success: false };
    assert.strictEqual(fn(h, 'chSwitchCard')('eleme'), '');
  });
  it('turning Meituan off says stock stops but orders and the shops do not', async () => {
    const h = mk(); h.st.mtCfg = { success: true, enabled: true };
    h.CMD.chSwitch('meituan', 0);
    const a = askText(h);
    assert.strictEqual(a.title, 'Turn the Meituan channel off?');
    for (const w of ['Stock stops being pushed to Meituan', 'Changes wait in the queue',
      'Meituan orders keep coming in and your shops stay open on Meituan', 'close Meituan at your stores instead']) assert.ok(a.body.includes(w), w);
    assert.ok(a.danger); assert.strictEqual(a.ok, 'Turn off');
    assert.strictEqual(h.calls.writes.length, 0);
    h.st.ask.run();
    const w = W(h, 0);
    assert.strictEqual(w.p, '/meituan/enable'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { enabled: false });
    assert.ok(h.text(fn(h, 'chSwitchCard')('meituan')).includes('Saving…'));
    w.res({ success: true, enabled: false }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Meituan channel off — nothing will be pushed']);
    const t = h.text(fn(h, 'chSwitchCard')('meituan'));
    assert.ok(t.includes('Channel off') && t.includes('Turn on') && t.includes('nothing will be pushed'));
    assert.strictEqual(h.calls.mtStatus, 1, 'the health card is read again');
  });
  it('turning Eleme off says the order import stops too, and the shops stay open on Eleme', async () => {
    const h = mk(); h.st.elm.cfg = { success: true, configured: true, enabled: true };
    h.CMD.chSwitch('eleme', 0);
    const a = askText(h);
    assert.strictEqual(a.title, 'Turn the Eleme channel off?');
    for (const w of ['no stock is pushed', 'no Eleme orders are brought in — not even ones already placed',
      'the listing catalogue stops refreshing', 'Your shops stay open on Eleme itself']) assert.ok(a.body.includes(w), w);
    h.st.ask.run();
    assert.strictEqual(W(h, 0).p, '/eleme/enable'); assert.deepStrictEqual(W(h, 0).body, { enabled: false });
    W(h, 0).res({ success: true, enabled: false }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Channel off']);
    assert.strictEqual(h.st.elm.cfg.enabled, false); assert.strictEqual(h.st.elm.cfg.configured, true, 'the rest of the read is kept');
    assert.strictEqual(h.st.elm.tried, false, 'the Eleme screen reads again');
    assert.ok(h.text(fn(h, 'chSwitchCard')('eleme')).includes('Orders are not being imported and stock is not being pushed.'));
  });
  it('turning Eleme on sends {enabled:true}', async () => {
    const h = mk(); h.st.elm.cfg = { success: true, enabled: false };
    h.CMD.chSwitch('eleme', 1);
    assert.strictEqual(askText(h).title, 'Turn the Eleme channel on?'); assert.ok(!askText(h).danger);
    h.st.ask.run();
    assert.deepStrictEqual(W(h, 0).body, { enabled: true });
  });
  it('a refusal stays on that channel\'s card only, and the state is read again', async () => {
    const h = mk(); h.st.mtCfg = { success: true, enabled: true }; h.st.mtCfgTried = true;
    h.st.elm.cfg = { success: true, enabled: true };
    h.CMD.chSwitch('meituan', 0); h.st.ask.run(); W(h, 0).rej(REFUSED()); await tick();
    assert.ok(h.text(fn(h, 'chSwitchCard')('meituan')).includes('You don’t have permission for this'));
    assert.ok(!h.text(fn(h, 'chSwitchCard')('eleme')).includes('permission'));
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.ok(h.calls.reads.some((r) => r.p === '/meituan/config'), 'back to what the server says');
  });
  it('an unknown channel name sends nothing', async () => {
    const h = mk(); h.CMD.chSwitch('guanyi', 0); await tick();
    assert.strictEqual(h.st.ask, null); assert.strictEqual(h.calls.writes.length, 0);
  });
}

section('5 · Chinese');
{
  it('every control and confirm reads in Chinese', async () => {
    const h = await oc({ lang: 'zh' });
    const t = h.text(fn(h, 'ocCard')());
    for (const w of ['营业状态', '部分渠道已关闭', '全部关闭', '线上商城', '营业中']) assert.ok(t.includes(w), w);
    h.CMD.ocMaster(0);
    assert.strictEqual(askText(h).title, '全部关闭？');
    assert.ok(askText(h).body.includes('已下单的订单不受影响'));
    h.CMD.ocOnline(0);
    assert.strictEqual(askText(h).title, '关闭线上商城？');
    h.st.chanSheet = 'meituan';
    assert.ok(h.text(fn(h, 'sheetChannel')()).includes('关闭渠道'));
    h.CMD.chanAll('meituan', 0);
    assert.strictEqual(askText(h).title, '关闭所有门店的该渠道？');
    h.st.mtCfg = { success: true, enabled: true };
    assert.ok(h.text(fn(h, 'chSwitchCard')('meituan')).includes('渠道开启'));
    h.CMD.chSwitch('meituan', 0);
    assert.strictEqual(askText(h).title, '停用美团渠道？');
    h.st.elm.cfg = { success: true, enabled: false };
    h.CMD.chSwitch('eleme', 1);
    assert.strictEqual(askText(h).title, '开启饿了么渠道？');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
