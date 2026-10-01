#!/usr/bin/env node
/**
 * §325 M4 — LEGAL AND FAQ ARE EDITED ON THE PHONE, AS SETTINGS THAT SAVE THEMSELVES.
 *
 *   node scripts/test_mobile_content_legal_faq.js
 *
 * The phone's Legal pages and FAQ were read-only ("written on desktop"). They
 * are now §279 cards on the phone: the desktop's card names and payloads
 * ('legal', 'faq'), PUT /config?history=<card>, Undo to the visit's start,
 * Version history with restore — on the shared engine (public/tacet-autosave.js,
 * required here for real). Sliced out of public/m.html (fast shard). Pins:
 *   1. the card: what it sends (path, method, every key), Undo, history and a
 *      restore, a refusal shown in the foot and never a toast;
 *   2. Legal: both documents, both languages, today stamped; the Edit buttons
 *      drawn for the content keys only; the whole text shown;
 *   3. FAQ: the desktop's defaults, ids made from the question and kept, the
 *      desktop's holds (nothing sent while held), add / edit / move / remove a
 *      question (asking first when it has words), categories (asking first
 *      when used), the read-only view for an account without the keys.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const ENGINE = require(path.join(ROOT, 'public/tacet-autosave.js'));

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
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));

const CARD_SRC = slice(MH, '/* ==========================================================================\n   §325 M4 — CONTENT THAT SAVES ITSELF', '/* ==========================================================================\n   FAQ & help (desktop: 07-content-billing.js)');
const FAQ_SCREEN = slice(MH, 'function screenFaq(){', '/* ==========================================================================\n   Pop-ups');
const LEGAL_SUB = (() => {
  const s = MH.indexOf("  legal:{title:['Legal pages','法律条款']");
  let depth = 0, i = MH.indexOf('{', s);
  for (; i < MH.length; i++) { if (MH[i] === '{') depth++; else if (MH[i] === '}' && --depth === 0) break; }
  return MH.slice(s, i + 1);
})();

const CFG = {
  legal: { privacy: { body_en: 'We keep your phone.', body_cn: '我们保存手机号。', updated_at: '2026-09-01' }, terms: { body_en: 'Be nice.', body_cn: '友善。', updated_at: '2026-09-01' } },
  faq: { categories: [{ id: 'orders', en: 'Orders', cn: '订单', color: 'lime' }, { id: 'wallet', en: 'Wallet', cn: '钱包', color: 'sky' }],
    questions: [{ id: 'q-when', cat: 'orders', q_en: 'When?', q_cn: '何时？', a_en: 'Soon.', a_cn: '很快。' },
      { id: 'q-pay', cat: 'wallet', q_en: 'How to pay?', q_cn: '怎么付？', a_en: 'WeChat.', a_cn: '微信。' }] },
};
function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  let histSheet = null, renders = 0;
  const ctx = {
    LANG: opts.lang || 'en',
    T: (en, zh) => (opts.lang === 'zh' ? zh : en),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    nothingYet: (a, b) => `<empty>${a}|${b}</empty>`,
    fmtDay: (d) => d,
    state: { cfg: opts.cfg === undefined ? JSON.parse(JSON.stringify(CFG)) : opts.cfg, caps: opts.caps === undefined ? null : opts.caps, ask: null, askErr: null, legalOpen: null, faqOpen: null },
    render: () => { renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    askLiveRepaint: () => {},
    liveHistorySheet: (list, sub, restore) => { histSheet = { list, sub, restore }; },
    shopToday: () => '2026-10-01',
    TacetAutosave: ENGINE,
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error('Your role cannot change this.'); e.refused = true; throw e; }
      return { success: true, data: Object.assign({}, CFG, { saved: true }) };
    },
    api: async (p) => { reads.push(p); return opts.history || { success: true, versions: [] }; },
    document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' },
    MCAN_MONEY_ONLY: new Set(),
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout,
  };
  ctx.cfgGet = (p, d) => { let v = ctx.state.cfg; for (const k of String(p).split('.')) { if (v == null) return d; v = v[k]; } return v == null ? d : v; };
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(CARD_SRC + FAQ_SCREEN + '\nthis.SUBLEGAL=({' + LEGAL_SUB + '}).legal;' +
    '\nthis.card=(k)=>CFG_CARD[k]; this.faqD=()=>FAQ_D; this.legalD=()=>LEGAL_D;', ctx);
  return { ctx, CMD, writes, reads, toasts, hist: () => histSheet, renders: () => renders };
}
const live = (ctx) => ctx.state.ask && ctx.state.ask.live;
const type = (ctx, CMDf, id, v) => { live(ctx).set(id, v); live(ctx).auto.touch(); };

section('1 · Legal: a card that saves itself');
{
  it('the screen: both documents, the whole text, an Edit for each, the card\'s foot', () => {
    const { ctx } = mk();
    ctx.state.legalOpen = 0;
    const long = 'x'.repeat(1500);
    ctx.state.cfg.legal.terms.body_en = long;
    const html = ctx.SUBLEGAL.render();
    assert.ok(html.includes(long), 'not clipped');
    assert.ok(!/on desktop|电脑端/.test(html));
    assert.ok(/onclick="APP\.cmd\('legalEdit','terms'\)">Edit<\/button>/.test(html) && /APP\.cmd\('legalEdit','privacy'\)/.test(html));
    assert.ok(/APP\.cmd\('cardHistory','legal'\)">Version history/.test(html));
    assert.ok(/All changes saved/.test(html));
  });
  it('without the content keys: no Edit, no foot, and nothing can be opened', () => {
    const { ctx, CMD } = mk({ caps: ['orders:view'] });
    const html = ctx.SUBLEGAL.render();
    assert.ok(!/legalEdit/.test(html) && !/cardHistory/.test(html));
    CMD.legalEdit('terms');
    assert.strictEqual(ctx.state.ask, null);
  });
  it('an empty shop with the keys gets the two documents to write, not "written on desktop"', () => {
    const { ctx } = mk({ cfg: {} });
    const html = ctx.SUBLEGAL.render();
    assert.ok(!/<empty>/.test(html) && /legalEdit','terms'/.test(html));
  });
  it('editing Terms sends the desktop card whole: four bodies, today on both', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.SUBLEGAL.render();
    CMD.legalEdit('terms');
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'Terms of service');
    assert.deepStrictEqual(plain(a.fields.map((f) => [f.id, f.label, !!f.multiline])), [['en', 'English body', true], ['cn', '中文正文', true]]);
    assert.strictEqual(live(ctx).get('en'), 'Be nice.');
    type(ctx, CMD, 'en', 'Be kind.');
    await live(ctx).auto.flush();
    assert.deepStrictEqual(writes, [{ p: '/config?history=legal', method: 'PUT', body: {
      'legal.privacy.body_en': 'We keep your phone.', 'legal.privacy.body_cn': '我们保存手机号。',
      'legal.terms.body_en': 'Be kind.', 'legal.terms.body_cn': '友善。',
      'legal.privacy.updated_at': '2026-10-01', 'legal.terms.updated_at': '2026-10-01' } }]);
    assert.strictEqual(ctx.state.cfg.saved, true, 'the rest of the app gets the server\'s config');
  });
  it('Undo puts back the visit\'s start and files it as an undo', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.SUBLEGAL.render();
    CMD.legalEdit('privacy');
    type(ctx, CMD, 'cn', '改了');
    await live(ctx).auto.flush();
    CMD.cardUndo('legal');
    await tick();
    assert.strictEqual(writes[1].p, '/config?history=legal&note=undo');
    assert.strictEqual(writes[1].body['legal.privacy.body_cn'], '我们保存手机号。');
    assert.strictEqual(ctx.legalD()['legal.privacy.body_cn'], '我们保存手机号。');
  });
  it('Version history: the card\'s own list; a restore puts the snapshot back as a restore', async () => {
    const versions = [{ id: 2, at: 'x', changed: ['legal.terms.body_en'], snapshot: {} },
      { id: 1, at: 'y', isBaseline: true, changed: [], snapshot: { 'legal.terms.body_en': 'Old terms', 'legal.terms.body_cn': '旧条款', 'legal.privacy.body_en': 'P', 'legal.privacy.body_cn': null } }];
    const { ctx, CMD, writes, reads, hist } = mk({ history: { success: true, versions } });
    ctx.SUBLEGAL.render();
    CMD.cardHistory('legal'); await tick();
    assert.deepStrictEqual(reads, ['/config/history?card=legal']);
    assert.strictEqual(hist().sub(versions[0]), 'Terms of service');
    await hist().restore(versions[1]);
    const w = writes[writes.length - 1];
    assert.strictEqual(w.p, '/config?history=legal&note=restore');
    assert.deepStrictEqual([w.body['legal.terms.body_en'], w.body['legal.terms.body_cn'], w.body['legal.privacy.body_cn']], ['Old terms', '旧条款', '']);
  });
  it('a refusal stays in the foot, says why, and is never a toast', async () => {
    const { ctx, CMD, toasts } = mk({ writeFails: true });
    ctx.SUBLEGAL.render();
    CMD.legalEdit('terms');
    type(ctx, CMD, 'en', 'x');
    await live(ctx).auto.flush();
    assert.strictEqual(ctx.card('legal').auto.state, 'error');
    assert.ok(/Save failed: Your role cannot change this\./.test(ctx.cardFootHtml(ctx.card('legal'))));
    assert.deepStrictEqual(toasts, []);
  });
  it('the whole phone script still parses, and the card helpers are declared once', () => {
    // A merge once brought a second cfgFoot (Settings' own, §325 X5) beside
    // this one: a const after a function of the same name is a SyntaxError
    // that kills the whole app, and every sliced suite still passed.
    const js = (MH.match(/<script>([\s\S]*?)<\/script>/g) || []).map((s) => s.slice(8, -9)).sort((a, b) => b.length - a.length)[0];
    assert.doesNotThrow(() => new vm.Script(js, { filename: 'm.html' }));
    for (const n of ['cardFootHtml', 'cardFoot', 'cardFootRepaint', 'cfgCard', 'cfgCardStart', 'cfgSheet']) {
      assert.strictEqual((js.match(new RegExp('(?:function|const|let) ' + n + '\\b', 'g')) || []).length, 1, n);
    }
    for (const n of ['cardUndo', 'cardHistory', 'askLiveAct']) assert.strictEqual((js.match(new RegExp("reg\\('" + n + "'", 'g')) || []).length, 1, n);
  });
  it('the reload guard and the background flush know these cards', () => {
    assert.ok(/if\(cfgBusy\(\)\) return true;/.test(MH));
    assert.ok(/document\.visibilityState==='hidden'\)\{ Object\.keys\(CFG_CARD\)\.forEach\(k=>\{ const a=CFG_CARD\[k\]\.auto; if\(a\) a\.flush\(\); \}\);/.test(MH));
  });
}

section('2 · FAQ');
{
  it('the questions in order, numbered, each with its category; categories; the foot', () => {
    const { ctx } = mk();
    const html = ctx.screenFaq();
    assert.ok(/APP\.cmd\('faqEditQ',0\)[\s\S]*>01<[\s\S]*When\?[\s\S]*Orders[\s\S]*APP\.cmd\('faqEditQ',1\)/.test(html));
    assert.ok(/APP\.cmd\('faqAddQ'\)">\+ Add question/.test(html) && /APP\.cmd\('faqAddCat'\)">\+ Add category/.test(html));
    assert.ok(/APP\.cmd\('faqEditCat',1\)[\s\S]*Wallet[\s\S]*wallet · sky/.test(html));
    assert.ok(/cardHistory','faq'/.test(html));
  });
  it('an empty shop starts from the desktop\'s six categories', () => {
    const { ctx } = mk({ cfg: { faq: {} } });
    ctx.screenFaq();
    assert.deepStrictEqual(plain(ctx.faqD().cats.map((c) => c.id)), ['orders', 'delivery', 'products', 'wallet', 'membership', 'account']);
  });
  it('without the keys: the old read-only view, no edit command works', () => {
    const { ctx, CMD } = mk({ caps: ['orders:view'] });
    const html = ctx.screenFaq();
    assert.ok(/faqToggle/.test(html) && !/faqEditQ|faqAddQ|cardHistory/.test(html));
    CMD.faqAddQ(); CMD.faqEditQ(0); CMD.faqEditCat(0);
    assert.strictEqual(ctx.state.ask, null);
  });
  it('a question\'s sheet: the desktop\'s fields; edits send both lists whole', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenFaq();
    CMD.faqEditQ(1);
    const a = ctx.state.ask;
    assert.strictEqual(a.title, 'Question 02');
    assert.deepStrictEqual(plain(a.fields.map((f) => f.id)), ['cat', 'q_en', 'q_cn', 'a_en', 'a_cn', 'id']);
    assert.deepStrictEqual(plain(a.fields[0].choices), [['', '— pick category —'], ['orders', 'orders · Orders'], ['wallet', 'wallet · Wallet']]);
    assert.deepStrictEqual(plain(a.live.acts.map((x) => x.key)), ['up', 'rm'], 'the last cannot move down');
    type(ctx, CMD, 'a_en', 'WeChat Pay.');
    await live(ctx).auto.flush();
    assert.strictEqual(writes[0].p, '/config?history=faq');
    assert.deepStrictEqual(Object.keys(writes[0].body), ['faq.categories', 'faq.questions']);
    assert.deepStrictEqual(writes[0].body['faq.questions'][1], { id: 'q-pay', cat: 'wallet', q_en: 'How to pay?', q_cn: '怎么付？', a_en: 'WeChat Pay.', a_cn: '微信。' });
    assert.deepStrictEqual(writes[0].body['faq.categories'][0], { id: 'orders', en: 'Orders', cn: '订单', color: 'lime' });
  });
  it('a new question is held until it has a Q and an A, then gets an id from its text, kept', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenFaq();
    CMD.faqAddQ();
    assert.strictEqual(ctx.state.ask.title, 'Question 03');
    assert.strictEqual(live(ctx).get('cat'), 'orders', 'the first category, as the desktop');
    await live(ctx).auto.flush();
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(ctx.card('faq').auto.state, 'hold');
    assert.strictEqual(ctx.card('faq').auto.message, 'Question "q-q-3" needs a Q in at least one language', 'the desktop\'s own id for an empty question');
    type(ctx, CMD, 'q_en', 'Do you deliver on Sunday?');
    type(ctx, CMD, 'a_cn', '周日也送。');
    await live(ctx).auto.flush();
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].body['faq.questions'][2].id, 'q-do-you-deliver-on-sunday');
    assert.strictEqual(ctx.faqD().qs[2].id, 'q-do-you-deliver-on-sunday', 'kept, so later edits do not mint another');
  });
  it('the id typed is made a slug, as the desktop does', () => {
    const { ctx, CMD } = mk();
    ctx.screenFaq();
    CMD.faqEditQ(0);
    live(ctx).set('id', ' My Question! ');
    assert.strictEqual(ctx.faqD().qs[0].id, 'my-question');
  });
  it('move and remove: remove asks first when the question has words', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenFaq();
    CMD.faqEditQ(1);
    CMD.askLiveAct('up');
    assert.deepStrictEqual(plain(ctx.faqD().qs.map((q) => q.id)), ['q-pay', 'q-when']);
    assert.strictEqual(ctx.state.ask.title, 'Question 01', 'the sheet follows the question');
    CMD.askLiveAct('rm');
    assert.strictEqual(ctx.state.ask.title, 'Remove "How to pay?"?');
    assert.strictEqual(ctx.state.ask.danger, true);
    ctx.state.ask.run();
    assert.deepStrictEqual(plain(ctx.faqD().qs.map((q) => q.id)), ['q-when']);
    await ctx.card('faq').auto.flush();
    assert.deepStrictEqual(plain(writes[writes.length - 1].body['faq.questions'].map((q) => q.id)), ['q-when']);
  });
  it('a category: its fields; a duplicate id is held in the desktop\'s words; removing a used one asks with the count', async () => {
    const { ctx, CMD, writes } = mk();
    ctx.screenFaq();
    CMD.faqEditCat(1);
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => [f.id, f.label])), [['id', 'id'], ['en', 'English label'], ['cn', '中文标签'], ['color', 'Colour']]);
    assert.strictEqual(ctx.state.ask.fields[3].choices.length, 14);
    type(ctx, CMD, 'id', 'Orders');
    await live(ctx).auto.flush();
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(ctx.card('faq').auto.message, 'Duplicate category id "orders"');
    type(ctx, CMD, 'id', 'wallet');
    CMD.askLiveAct('rm');
    assert.strictEqual(ctx.state.ask.title, 'Remove "wallet"? 1 question(s) still reference it and will be left uncategorised.');
    ctx.state.ask.run();
    assert.deepStrictEqual(plain(ctx.faqD().cats.map((c) => c.id)), ['orders']);
  });
  it('in Chinese, the desktop\'s Chinese', () => {
    const { ctx, CMD } = mk({ lang: 'zh' });
    const html = ctx.screenFaq();
    assert.ok(/问题与答案/.test(html) && /添加问题/.test(html) && /添加分类/.test(html));
    CMD.faqEditCat(0);
    assert.deepStrictEqual(plain(ctx.state.ask.fields.map((f) => f.label)), ['id', '英文名称', '中文标签', '颜色']);
  });
  it('the payload and holds are the desktop\'s (07-content-billing.js)', () => {
    const D = fs.readFileSync(path.join(ROOT, 'public/retail-admin/07-content-billing.js'), 'utf8');
    for (const s of ["card: 'faq'", "'faq.categories': FAQ_CATS.map(c => ({ id: c.id, en: c.en, cn: c.cn, color: c.color }))",
      "cuT('Every category needs an id', '每个分类都需要 id')", "cuT('Duplicate category id \"' + c.id + '\"', '分类 id 重复 \"' + c.id + '\"')",
      'id = `q-${base || (i + 1)}`;']) assert.ok(D.includes(s), s);
    const M5 = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
    assert.ok(/card: 'legal', root: '#tab-legal'/.test(M5) && /'legal\.terms\.updated_at':\s+today/.test(M5));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
