#!/usr/bin/env node
/**
 * §325 X9c — THE WEB STORE'S CONFIGURATION ON THE PHONE: ITS ADDRESS, ITS
 * DOMAINS, CUSTOMER SIGN-IN, ITS TITLE, MENU AND FOOTER, AND PAYMENTS.
 *
 *   node scripts/test_mobile_web_store.js
 *
 * The desktop's Web store configuration (15-integrations.js igWebConfig,
 * igWebSaveSignin, wcSiteProblems, igWebAddDomain, igWebCheckDns,
 * igWebRemoveDomain).
 *
 * What is asserted: what the page shows from its one read; every write's
 * method, path and body, against the desktop's own; the desktop's own check
 * of the menu and footer run side by side with the phone's; each refusal's
 * words; a re-read after a domain change keeps what is being edited; the key
 * the server asks, and nothing sent without it; a failed read; both
 * languages. No browser — fast shard.
 */
'use strict';

process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const IG = fs.readFileSync(path.join(ROOT, 'public/retail-admin/15-integrations.js'), 'utf8');
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

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  slice(M, 'const PILL = {', 'const KIND2PILL'),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  block(M, 'function x6Words('),
  line(M, 'const x6En='),
  line(M, 'const x6Zh='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X9a — THE CHANNEL HUB', '/* §325 X9c ends */'),
].join('\n');

const MANAGE = ['dashboard:view', 'integrations:view', 'integrations:manage'];
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const CODE = (c) => { const e = new Error(c); e.code = c; return e; };
const CFG = () => ({
  success: true, baseDomain: 'shops.example.cn', cnameTarget: 'shops.example.cn', suggestedSub: null,
  domains: [
    { id: 1, host: 'roots.shops.example.cn', kind: 'subdomain', status: 'active', isPrimary: true },
    { id: 7, host: 'shop.roots.com', kind: 'custom', status: 'pending', isPrimary: false },
    { id: 8, host: 'www.roots.cn', kind: 'custom', status: 'active', isPrimary: false },
  ],
  signin: { available: { phone: true, email: true, google: false, apple: false, wechat: true },
    enabled: { phone: true, email: false, google: false, apple: false, wechat: true } },
  site: { title_en: 'Roots', title_cn: '根', description_en: '', description_cn: '', nav: [{ label_en: 'Menu', label_cn: '菜单', target: 'shop' }],
    footer_en: '', footer_cn: '', links: [] },
  pay: { wechatReady: true, alipayConfigured: false },
});

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], pushes: [], pops: 0, copied: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    toggle: (on, cmd) => `<button class="tog" data-on="${on ? 1 : 0}" onclick="${cmd}"></button>`,
    copyText: (t) => calls.copied.push(t),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    SUBS: {},
    state: { caps: opts.caps === undefined ? MANAGE : opts.caps, ask: null, askErr: null, stack: [{ route: 'chhub' }],
      hub: { cards: [], stores: [], tried: true, err: null, busy: null, note: {}, boxKind: null, elStores: null, elTried: false, elErr: null, shopIds: {} },
      wxm: { cfg: null, tried: false, err: null, mode: null, step: 1, d: {}, open: {}, showPub: false, busy: null, msg: null, finishAnyway: false, done: null },
      wcf: { cfg: null, tried: false, err: null, keep: false, signin: {}, site: null, newHost: '', busy: null, msg: null, dmsg: null, customOpen: false } },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushes.push(r); ctx.state.stack.push({ route: r }); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, raw: true, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => { calls.writes.push({ p, body: body == null ? body : plain(body), method: method || 'POST', res, rej }); }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC).runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const html = () => ctx.SUBS.webcfg.render();
  return { ctx, CMD, calls, text, s: () => ctx.state.wcf, html, t: () => text(html()) };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const READ = '/channel-hub/web/config';
async function answer(h, p, v) {
  const c = h.calls.api.find((x) => x.p === p && !x.done);
  assert.ok(c, 'no read of ' + p + ' (have ' + h.calls.api.map((x) => x.p).join(', ') + ')');
  c.done = true; c.res(v); await tick();
}
const reads = (h) => h.calls.api.filter((x) => x.p === READ).length;
const W = (h, i) => { const w = h.calls.writes[i]; assert.ok(w, 'no write #' + i); return w; };
async function open(cfg, opts) {
  const h = mk(opts); h.CMD.wcfOpen(); h.html();
  await answer(h, READ, cfg || CFG());
  return h;
}
/* The desktop's own wcSiteProblems, run on a site of the test's choosing. */
function deskProblems(site) {
  const c = { _webSite: plain(site), cuT: (en) => en, out: null };
  vm.createContext(c);
  new vm.Script(block(IG, 'function wcSiteProblems()') + '\nout = wcSiteProblems();').runInContext(c);
  return { problems: c.out, site: c._webSite };
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · keys');
{
  it('each write is the server\'s key; the read is open, as the hub\'s is', () => {
    for (const [m, p] of [['POST', '/channel-hub/web/signin'], ['POST', '/channel-hub/web/site'], ['POST', '/channel-hub/web/domain'],
      ['POST', '/channel-hub/web/domain/7/check'], ['DELETE', '/channel-hub/web/domain/7']]) {
      assert.strictEqual(cap.requiredCapFor(m, '/api/retail-admin' + p), 'integrations:manage', m + ' ' + p);
    }
    assert.strictEqual(cap.requiredCapFor('GET', '/api/retail-admin' + READ), null);
  });
  it('without integrations:manage: read-only, and nothing is sent', async () => {
    const h = await open(null, { caps: ['dashboard:view', 'integrations:view'] });
    h.CMD.wcfCustom();
    const html = h.html(), t = h.text(html);
    assert.ok(!t.includes('Save changes') && !t.includes('Add domain') && !t.includes('Check DNS') && !t.includes('Add link') && !t.includes('Get help'));
    assert.ok(!html.includes('class="tog"'), 'no switches');
    assert.ok(/readonly/.test(html));
    h.CMD.wcfTog('email'); h.CMD.wcfSave(); h.s().newHost = 'a.com'; h.CMD.wcfAddDomain(); h.CMD.wcfCheck(7); h.CMD.wcfRemove(7); h.CMD.wcfAdd('nav');
    assert.strictEqual(h.calls.writes.length, 0); assert.strictEqual(h.ctx.state.ask, null);
    assert.strictEqual(h.s().signin.email, false); assert.strictEqual(h.s().site.nav.length, 1);
  });
  it('its door: the web store\'s card in the channel hub', () => {
    assert.strictEqual(mk().ctx.hubOpenFor('web'), "APP.cmd('wcfOpen')");
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.hubOpenFor('web'), '');
  });
}

section('2 · what the page shows');
{
  it('the ready marks, the live address with Copy and Open, the sign-in ways, payments', async () => {
    const h = await open();
    const html = h.html(), t = h.text(html);
    for (const w of ['✓ Store online', '✓ Sign-in ready', '✓ Payments ready', 'https://roots.shops.example.cn',
      'This address works immediately and never needs setup.', 'Phone number Six-digit code by SMS ✓ Ready', 'Google One-tap sign-in with a Google account Not available yet',
      'WeChat Pay Uses your WeChat merchant setup — nothing to enter again. ✓ Ready', 'Open WeChat config', 'Alipay', '○ Optional']) assert.ok(t.includes(w), w);
    assert.ok(html.includes('href="https://roots.shops.example.cn"'));
    assert.strictEqual((html.match(/class="tog"/g) || []).length, 3, 'a switch for each way that is available');
    assert.ok(html.includes(`APP.cmd('wxmOpen')`), 'WeChat Pay opens the mini program\'s page (X9b)');
    h.CMD.wcfCopy('https://roots.shops.example.cn'); assert.deepStrictEqual(h.calls.copied, ['https://roots.shops.example.cn']);
  });
  it('no live address: the free one reserved, or none yet', async () => {
    const c = CFG(); c.domains = []; c.suggestedSub = 'roots.shops.example.cn';
    let h = await open(c);
    assert.ok(h.t().includes('https://roots.shops.example.cn Your free address is reserved and will go live shortly.') && h.t().includes('○ Store online'));
    c.suggestedSub = null; h = await open(c);
    assert.ok(h.t().includes('No web address yet — add your own domain below.'));
  });
  it('a failed read', async () => {
    const h = mk(); h.CMD.wcfOpen(); h.html();
    const c = h.calls.api[0]; c.done = true; c.rej(new Error('HTTP 500')); await tick();
    assert.ok(h.t().includes('Could not load this.'));
    h.CMD.wcfRetry(); h.html(); assert.strictEqual(reads(h), 2);
  });
}

section('3 · your own domain');
{
  it('each domain, live or waiting with the CNAME record to add', async () => {
    const h = await open();
    assert.ok(!h.t().includes('shop.roots.com'), 'folded until opened, as the desktop\'s');
    h.CMD.wcfCustom();
    const t = h.t();
    assert.ok(t.includes('shop.roots.com ○ Waiting for DNS Add a CNAME record for this name pointing to shops.example.cn, then check DNS.'));
    assert.ok(t.includes('Type Name Value CNAME shop shops.example.cn'));
    assert.ok(t.includes('www.roots.cn ✓ Live Live and secured.'));
    assert.ok(!t.includes('roots.shops.example.cn ✓ Live'), 'the platform address is not one of yours to remove');
  });
  it('Add domain sends {host}, trimmed and lower-cased, then reads the page again keeping what is being edited', async () => {
    const h = await open(); h.CMD.wcfCustom();
    h.CMD.wcfAddDomain(); assert.strictEqual(h.calls.writes.length, 0, 'nothing typed, nothing sent');
    h.CMD.wcfTog('email'); h.CMD.wcfIn('title_en', 'Roots Kitchen');
    h.CMD.wcfHost('  Shop.New.COM '); h.CMD.wcfAddDomain();
    const w = W(h, 0); assert.strictEqual(w.p, '/channel-hub/web/domain'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { host: 'shop.new.com' });
    assert.ok(block(IG, 'window.igWebAddDomain = async function').includes("body: { host }"));
    w.res({ success: true, id: 9, host: 'shop.new.com' }); await tick(); h.html();
    assert.strictEqual(reads(h), 2);
    const c = CFG(); c.domains.push({ id: 9, host: 'shop.new.com', kind: 'custom', status: 'pending', isPrimary: false });
    await answer(h, READ, c);
    assert.ok(h.t().includes('shop.new.com ○ Waiting for DNS'));
    assert.strictEqual(h.s().signin.email, true, 'the switch not yet saved is kept');
    assert.strictEqual(h.s().site.title_en, 'Roots Kitchen', 'and the words');
    assert.strictEqual(h.s().newHost, '');
  });
  it('each refusal of a domain in the desktop\'s words', async () => {
    for (const [e, words] of [[CODE('bad_domain'), 'Enter a valid domain (e.g. shop.example.com).'], [CODE('reserved'), 'That is a platform address — it is managed for you.'],
      [CODE('taken'), 'That domain is already registered.'], [CODE('already_yours'), 'You have already added that domain.'],
      [new Error('HTTP 500'), 'Could not add that domain.'], [REFUSED(), 'You don’t have permission for this']]) {
      const h = await open(); h.CMD.wcfCustom(); h.CMD.wcfHost('x.com'); h.CMD.wcfAddDomain();
      W(h, 0).rej(e); await tick();
      assert.ok(h.t().includes(words), words);
    }
  });
  it('Check DNS: pointing, not yet, failed', async () => {
    for (const [r, words] of [[{ success: true, pointing: true }, '✓ DNS is pointing here. We’ll issue HTTPS and turn it on'],
      [{ success: true, pointing: false }, 'Not pointing here yet. DNS can take a while to update — try again shortly.']]) {
      const h = await open(); h.CMD.wcfCustom();
      h.CMD.wcfCheck(99); assert.strictEqual(h.calls.writes.length, 0, 'not one of the page\'s domains');
      h.CMD.wcfCheck(7);
      assert.ok(h.t().includes('Checking DNS…'));
      const w = W(h, 0); assert.strictEqual(w.p, '/channel-hub/web/domain/7/check'); assert.strictEqual(w.method, 'POST'); assert.strictEqual(w.body, undefined);
      w.res(r); await tick();
      assert.ok(h.t().includes(words), words);
    }
    const h = await open(); h.CMD.wcfCustom(); h.CMD.wcfCheck(7); W(h, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.t().includes('Check failed'));
  });
  it('Remove asks first, then DELETEs; the platform address cannot be removed', async () => {
    const h = await open(); h.CMD.wcfCustom();
    h.CMD.wcfRemove(1); assert.strictEqual(h.ctx.state.ask, null);
    h.CMD.wcfRemove(7);
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'Remove shop.roots.com?'); assert.strictEqual(a.body, 'Customers using it will no longer reach your store.');
    assert.strictEqual(a.confirmLabel, 'Remove domain'); assert.strictEqual(a.danger, true);
    assert.strictEqual(h.calls.writes.length, 0, 'nothing until confirmed');
    a.run();
    const w = W(h, 0); assert.strictEqual(w.p, '/channel-hub/web/domain/7'); assert.strictEqual(w.method, 'DELETE');
    w.res({ success: true }); await tick(); h.html(); assert.strictEqual(reads(h), 2);
    const f = await open(); f.CMD.wcfCustom(); f.CMD.wcfRemove(8); f.ctx.state.ask.run(); W(f, 0).rej(new Error('HTTP 500')); await tick();
    assert.ok(f.t().includes('Could not remove'), 'said in place and kept');
  });
}

section('4 · Save changes');
{
  it('sends the five sign-in switches, then the site\'s eight fields', async () => {
    const h = await open();
    h.CMD.wcfTog('google'); assert.strictEqual(h.s().signin.google, false, 'not available: cannot be switched on');
    h.CMD.wcfTog('email'); h.CMD.wcfTog('wechat');
    h.CMD.wcfIn('description_en', 'Fresh bread'); h.CMD.wcfIn('footer_cn', '营业时间');
    h.CMD.wcfSave();
    assert.ok(h.t().includes('Saving…'));
    const a = W(h, 0); assert.strictEqual(a.p, '/channel-hub/web/signin'); assert.strictEqual(a.method, 'POST');
    assert.deepStrictEqual(a.body, { phone: true, email: true, google: false, apple: false, wechat: false });
    assert.strictEqual(h.calls.writes.length, 1, 'one at a time, as the desktop awaits each');
    a.res({ success: true }); await tick();
    const b = W(h, 1); assert.strictEqual(b.p, '/channel-hub/web/site');
    assert.deepStrictEqual(b.body, { title_en: 'Roots', title_cn: '根', description_en: 'Fresh bread', description_cn: '', nav: [{ label_en: 'Menu', label_cn: '菜单', target: 'shop' }], footer_en: '', footer_cn: '营业时间', links: [] });
    const empty = block(IG, 'const WC_SITE_EMPTY = () => (');
    assert.deepStrictEqual(Object.keys(b.body), [...empty.matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]), 'the desktop\'s fields, in its order');
    b.res({ success: true, site: b.body }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    h.html(); assert.strictEqual(reads(h), 2, 'read again: the ready marks follow');
  });
  it('a failure names the part, and the other part is still sent', async () => {
    let h = await open(); h.CMD.wcfSave();
    W(h, 0).rej(new Error('HTTP 500')); await tick(); W(h, 1).res({ success: true }); await tick();
    assert.ok(h.t().includes('Save failed: sign-in')); assert.deepStrictEqual(h.calls.toasts, []);
    h = await open(); h.CMD.wcfSave();
    W(h, 0).rej(new Error('HTTP 500')); await tick(); W(h, 1).rej(new Error('HTTP 500')); await tick();
    assert.ok(h.t().includes('Save failed: sign-in, title, menu and footer'));
    h = await open(); h.CMD.wcfSave();
    W(h, 0).res({ success: true }); await tick(); W(h, 1).rej(REFUSED()); await tick();
    assert.ok(h.t().includes('You don’t have permission for this'));
  });
}

section('5 · the title, menu and footer');
{
  it('menu links: Home, Shop or a web address; up to six; removed', async () => {
    const h = await open();
    h.CMD.wcfAdd('nav');
    assert.deepStrictEqual(plain(h.s().site.nav[1]), { label_en: '', label_cn: '', target: 'home' });
    h.CMD.wcfPick(1, 'url'); assert.strictEqual(h.s().site.nav[1].target, '');
    assert.ok(h.html().includes(`APP.cmd('wcfIn','nav.1.target',this.value)`));
    h.CMD.wcfPick(1, 'shop'); assert.strictEqual(h.s().site.nav[1].target, 'shop');
    for (let i = 0; i < 6; i++) h.CMD.wcfAdd('nav');
    assert.strictEqual(h.s().site.nav.length, 6);
    h.CMD.wcfDrop('nav', 0); assert.strictEqual(h.s().site.nav[0].target, 'shop');
    assert.strictEqual(h.s().site.nav.length, 5);
  });
  it('before saving: the desktop\'s own check, side by side — https:// added, a dropped row named, nothing sent', async () => {
    const site = { title_en: '', title_cn: '', description_en: '', description_cn: '', footer_en: '', footer_cn: '',
      nav: [{ label_en: 'Blog', label_cn: '', target: 'blog.roots.com/x' }, { label_en: '', label_cn: '', target: 'home' }, { label_en: 'Bad', label_cn: '', target: 'not a url' }],
      links: [{ label_en: 'ICP', label_cn: '', url: 'beian.miit.gov.cn' }, { label_en: 'X', label_cn: '', url: '' }] };
    const desk = deskProblems(site);
    const h = await open();
    h.s().site = h.ctx.wcfSiteOf(site);
    const mine = plain(h.ctx.wcfProblems().map(String));
    assert.deepStrictEqual(mine, plain(desk.problems));
    assert.deepStrictEqual(plain(h.s().site), plain(desk.site));
    assert.strictEqual(h.s().site.nav[0].target, 'https://blog.roots.com/x');
    h.CMD.wcfSave();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.t().includes('Menu link 2 has no text (+2)'));
  });
}

section('6 · in Chinese');
{
  it('reads in Chinese', async () => {
    const h = await open(null, { lang: 'zh' });
    h.CMD.wcfCustom();
    const t = h.t();
    for (const w of ['商店在线', '登录可用', '收款可用', '商店网址', '使用自有域名', '等待解析', '检测解析', '添加域名', '顾客登录', '手机号', '就绪', '暂不可用',
      '标题、菜单与页脚', '网站标题', '菜单', '页脚链接', '收款', '打开小程序配置', '支付宝', '保存更改', '获取帮助']) assert.ok(t.includes(w), w);
    assert.strictEqual(h.ctx.SUBS.webcfg.title[1], '网页商店配置');
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
