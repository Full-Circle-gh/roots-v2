#!/usr/bin/env node
/**
 * §325 X11 — THE SETUP GUIDE'S ACTIONS ON THE PHONE, AND "OPEN THE DOORS".
 *
 *   node scripts/test_mobile_setup_actions.js
 *
 * The desktop guide (public/retail-admin/17-setup-guide.js) routes each step
 * into the surface that does it; the phone's guide only reported. Each step the
 * phone can now do leads there (stores, the first product, delivery or pickup,
 * opening, the brand), and "Open the doors" carries the desktop's blocker list
 * and confirm before POST /setup {storeOpened:true}.
 *
 * Asserted: every write's method, path and body; the confirm and the blocker
 * list are the desktop's words; the writes take the server's real key
 * (lib/cap-routes.js setupFlagCap) and are not drawn while keys are loading;
 * each step's button appears only for the key its destination needs;
 * refusals render on the screen, toasts only for success; the foot note names
 * what is still desktop-only. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/17-setup-guide.js'), 'utf8');
const cap = require('../lib/cap-routes.js');

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
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, 'const SETUP_LABEL={', 'function screenSetup(){'),
  block(M, 'function screenSetup(){'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const STATUS = (over) => Object.assign({
  percent: 60, requiredDone: 3, requiredTotal: 5, allDone: false,
  steps: [{ key: 'store', done: true, count: 1 }, { key: 'products', done: true, count: 4 }, { key: 'payment', done: false, method: null },
    { key: 'fulfillment', done: false, delivery: false, pickup: false }, { key: 'open', done: false }],
  optional: [{ key: 'wechat', done: false }, { key: 'brand', done: false }],
}, over || {});
const ALLBUTOPEN = () => STATUS({ steps: [{ key: 'store', done: true }, { key: 'products', done: true }, { key: 'payment', done: true, method: 'alipay' },
  { key: 'fulfillment', done: true, pickup: true }, { key: 'open', done: false }], requiredDone: 4, percent: 80 });

function mk(opts = {}) {
  const calls = { writes: [], toasts: [], cmds: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    noteBar: (t) => `<div class="note">${t}</div>`,
    peCanCreate: () => opts.create !== false,
    dlvCanWrite: () => opts.dlvWrite !== false, dlvUnconfigured: () => opts.unconfigured !== false,
    state: { caps: opts.caps === undefined ? ['settings:shop', 'stores:edit'] : opts.caps, setup: opts.setup || STATUS(), suBusy: null, suErr: null, ask: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.APP = { cmd: (n, ...a) => { calls.cmds.push(n); if (CMD[n]) CMD[n](...a); } };
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP; this.SU_KEYS=SU_KEYS;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, st: ctx.state, screen: () => ctx.screenSetup() };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const ask = (h) => { const a = h.st.ask; assert.ok(a, 'no confirm'); return a; };

section('1 · the server\'s key, and nothing before the keys are known');
it('the two writes take setupFlagCap — the same pair that opens this screen', () => {
  const h = mk();
  assert.deepStrictEqual(plain(h.ctx.SU_KEYS), cap.setupFlagCap('storeOpened'));
  assert.deepStrictEqual(plain(h.ctx.SU_KEYS), cap.setupFlagCap('pickupConfirmed'));
  assert.deepStrictEqual(plain(h.ctx.ROUTE_CAP.setup), cap.setupFlagCap('storeOpened'));
  assert.ok(/capRoutes\.setupFlagCap\(k\)/.test(fs.readFileSync(path.join(ROOT, 'routes/retail-setup.js'), 'utf8')), 'and the handler asks it');
});
it('while the keys are loading: no Open the doors, no pickup choice, and the commands send nothing', async () => {
  const h = mk({ caps: null, dlvWrite: false, setup: ALLBUTOPEN() });
  const html = h.screen();
  assert.ok(!html.includes("APP.cmd('suOpen')") && !html.includes("APP.cmd('suFulfil')"));
  h.CMD.suOpen(); h.CMD.suFulfil(); await tick();
  assert.strictEqual(h.st.ask, null); assert.strictEqual(h.calls.writes.length, 0);
});
it('without the keys, the same', async () => {
  const h = mk({ caps: ['orders:view'], dlvWrite: false, create: false });
  const html = h.screen();
  assert.ok(!/APP\.cmd\('(suOpen|suFulfil|peNew)'/.test(html) && !html.includes("APP.cmd('push','operations')"));
  h.CMD.suOpen(); h.CMD.suFulfil(); await tick();
  assert.strictEqual(h.calls.writes.length, 0);
});

section('2 · each step leads where the desktop\'s does');
it('the next step says Set up, the others Open — the desktop\'s labels', () => {
  const h = mk({ setup: STATUS({ steps: [{ key: 'store', done: false }, { key: 'products', done: false }, { key: 'payment', done: false },
    { key: 'fulfillment', done: false }, { key: 'open', done: false }] }) });
  const html = h.screen();
  assert.ok(html.includes(`onclick="APP.cmd('push','operations')">Set up</button>`), 'store → Operations, as next');
  assert.ok(html.includes(`onclick="APP.cmd('peNew')">Open</button>`), 'products → the product editor\'s Add');
  assert.ok(html.includes(`onclick="APP.cmd('suFulfil')">Open</button>`));
  assert.ok(html.includes(`onclick="APP.cmd('suOpen')">Open</button>`));
  assert.ok(html.includes(`onclick="APP.cmd('push','brand')">Open</button>`), 'the optional brand step → Brand');
  for (const w of ["cuT('Set up', '去设置')", "cuT('Open', '打开')"]) assert.ok(DESK.includes(w), w);
});
it('a step is offered only to whoever can do it there', () => {
  const s = STATUS({ steps: [{ key: 'store', done: false }, { key: 'products', done: false }, { key: 'payment', done: false }, { key: 'fulfillment', done: true }, { key: 'open', done: true }] });
  const h = mk({ caps: ['settings:shop'], create: false, setup: s });
  const html = h.screen();
  assert.ok(!html.includes("'operations'"), 'store needs stores:edit (the store screen\'s key)');
  assert.ok(!html.includes("'peNew'"), 'products needs the editor\'s create');
  assert.ok(html.includes("APP.cmd('push','brand')"), 'brand is settings:shop');
});
it('payment and WeChat sign-in stay desktop work, and the foot note says only that', () => {
  const h = mk();
  const html = h.screen();
  const t = h.text(html);
  assert.ok(t.includes('Payment methods and WeChat sign-in are set up on desktop.'));
  assert.ok(!t.includes('Each step is a wizard on desktop'), 'the stale note is gone');
  const rows = html.split('<div style="display:flex;align-items:center;gap:12px;padding:13px 14px">');   // one chunk per step row
  const pay = rows.find((r) => r.includes('Add a payment method'));
  assert.ok(pay && !pay.includes('<button'), 'no button on payment');
  const we = rows.find((r) => r.includes('Connect WeChat sign-in'));
  assert.ok(we && !we.includes('<button'), 'no button on WeChat sign-in');
  const z = mk({ lang: 'zh' });
  assert.ok(z.text(z.screen()).includes('收款方式与微信登录在电脑端设置。'));
});

section('3 · how customers get their order — the desktop\'s chooser');
it('offers delivery (the wizard) and pickup only, in the desktop\'s words', () => {
  const h = mk();
  h.CMD.suFulfil();
  const a = ask(h);
  assert.strictEqual(String(a.title), 'How customers get their order');
  assert.strictEqual(String(a.body), 'Pickup at your store is already on. You can add delivery now, or keep pickup only for now.');
  assert.deepStrictEqual(plain(a.options.map((o) => [o.key, String(o.label)])), [['delivery', 'Set up delivery'], ['pickup', 'Pickup only for now']]);
  for (const w of ["cuT('How customers get their order', '顾客如何拿到货')", "cuT('Set up delivery', '开通配送')", "cuT('Pickup only for now', '暂时只做自取')",
    "cuT('Pickup at your store is already on. You can add delivery now, or keep pickup only for now.', '到店自取已开启。你可以现在开通配送，或暂时只做自取。')"]) assert.ok(DESK.includes(w), w);
});
it('delivery opens the wizard', () => {
  const h = mk();
  h.CMD.suFulfil(); ask(h).run('delivery');
  assert.ok(h.calls.cmds.includes('dwizOpen')); assert.strictEqual(h.calls.writes.length, 0);
});
it('pickup only POSTs /setup {pickupConfirmed:true}, takes the answer, and toasts the desktop\'s words', async () => {
  const h = mk();
  h.CMD.suFulfil(); ask(h).run('pickup');
  const w = h.calls.writes[0];
  assert.strictEqual(w.p, '/setup'); assert.strictEqual(w.method, 'POST'); assert.deepStrictEqual(w.body, { pickupConfirmed: true });
  assert.ok(h.text(h.screen()).includes('Saving…'));
  w.res({ success: true, data: STATUS({ percent: 80 }) }); await tick();
  assert.strictEqual(h.st.setup.percent, 80);
  assert.deepStrictEqual(h.calls.toasts, ['Pickup confirmed']);
  assert.ok(DESK.includes("cuT('Pickup confirmed', '已确认自取')"));
});
it('without the Delivery panel\'s key, or with delivery set up, only pickup is offered', () => {
  for (const o of [{ dlvWrite: false }, { unconfigured: false }]) {
    const h = mk(o); h.CMD.suFulfil();
    assert.deepStrictEqual(plain(ask(h).options.map((x) => x.key)), ['pickup']);
  }
});

section('4 · open the doors');
it('steps left: the desktop\'s "Almost there", naming them, and nothing is sent', () => {
  const h = mk();
  h.CMD.suOpen();
  const a = ask(h);
  assert.strictEqual(String(a.title), 'Almost there');
  assert.ok(String(a.body).includes('Finish these first so customers get a working store:'));
  assert.ok(String(a.body).includes('Add a payment method, Set up delivery or pickup'));
  assert.deepStrictEqual(plain(a.options.map((o) => String(o.label))), ['OK']);
  assert.strictEqual(a.run, undefined, 'OK only closes');
  assert.strictEqual(h.calls.writes.length, 0);
  for (const w of ["cuT('Almost there', '就差一点')", "cuT('Finish these first so customers get a working store:', '先完成这些，顾客才能看到一个可用的店：')", "cuT('OK', '好的')"]) assert.ok(DESK.includes(w), w);
});
it('nothing left: the desktop\'s question, then POST /setup {storeOpened:true}', async () => {
  const h = mk({ setup: ALLBUTOPEN() });
  h.CMD.suOpen();
  const a = ask(h);
  assert.strictEqual(String(a.title), 'Open your store now?');
  assert.strictEqual(String(a.body), 'Your web store goes live and can take orders. You can keep editing anything afterwards.');
  assert.strictEqual(String(a.confirmLabel), 'Open the doors'); assert.strictEqual(String(a.cancelLabel), 'Not yet');
  for (const w of ["cuT('Open your store now?', '现在开店？')", "cuT('Your web store goes live and can take orders. You can keep editing anything afterwards.', '你的网页商店将上线并可接单。之后仍可继续编辑任何内容。')",
    "cuT('Not yet', '还没')", "cuT('Open the doors', '正式开店')", "cuT('Your store is open', '店铺已开业')"]) assert.ok(DESK.includes(w), w);
  assert.strictEqual(h.calls.writes.length, 0, 'nothing before the confirm');
  a.run();
  const w = h.calls.writes[0];
  assert.strictEqual(w.p, '/setup'); assert.strictEqual(w.method, 'POST'); assert.deepStrictEqual(w.body, { storeOpened: true });
  h.CMD.suOpen(); assert.strictEqual(h.calls.writes.length, 1, 'a second tap sends nothing');
  w.res({ success: true, data: STATUS({ allDone: true, percent: 100, requiredDone: 5 }) }); await tick();
  assert.deepStrictEqual(h.calls.toasts, ['Your store is open']);
  assert.ok(h.text(h.screen()).includes('Your store is open'), 'the guide reads as done');
});
it('a refusal stays on the screen; a failure says nothing changed; no toast either way', async () => {
  const h = mk({ setup: ALLBUTOPEN() });
  h.CMD.suOpen(); ask(h).run(); h.calls.writes[0].rej(REFUSED()); await tick();
  assert.ok(h.text(h.screen()).includes('You don’t have permission for this'));
  assert.strictEqual(h.st.suBusy, null);
  const g = mk({ setup: ALLBUTOPEN() });
  g.CMD.suOpen(); ask(g).run(); g.calls.writes[0].rej(new Error('HTTP 500')); await tick();
  assert.ok(g.text(g.screen()).includes('That did not save. Nothing has changed — try again.'));
  assert.deepStrictEqual(h.calls.toasts.concat(g.calls.toasts), []);
});
it('in Chinese', () => {
  const h = mk({ lang: 'zh', setup: ALLBUTOPEN() });
  h.CMD.suOpen();
  assert.strictEqual(String(ask(h).title), '现在开店？');
  assert.strictEqual(String(ask(h).confirmLabel), '正式开店');
  const b = mk({ lang: 'zh' }); b.CMD.suOpen();
  assert.ok(String(ask(b).body).includes('添加收款方式、设置配送或自提'));
});

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
