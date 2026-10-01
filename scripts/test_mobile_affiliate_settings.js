#!/usr/bin/env node
/**
 * §325 M9 — THE AFFILIATE PROGRAM IS RUN FROM THE PHONE.
 *
 *   node scripts/test_mobile_affiliate_settings.js
 *
 * The phone's Affiliate screen read the ledger and said "Reward amounts, the
 * lifetime share, and voiding a referral are on desktop." It now carries the
 * desktop's (10-extras.js): the offer as a draft with Save changes / Discard
 * (afxSave, PATCH /affiliate/settings with the whole settings body), arming
 * the repeat-order share asking first, who earns it (POST /affiliate/eligible,
 * each pick at once), and the ledger's filters, search, pages, Void and
 * Restore (PATCH /affiliate/referrals/:id), each asking first. Sliced out of
 * public/m.html and run in a sandbox (fast shard). Pins the requests, the
 * confirms, the empty / failed / refused cases, and that nothing writes
 * without the affiliate keys — or while the keys are still unknown.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MH = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

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
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));

const AFF_SRC = slice(MH, '/* ==========================================================================\n   Affiliate (desktop: 10-extras.js)', '/* ==========================================================================\n   Editor — what the shop\'s pages');

const SETTINGS = { rewardPerOrder: 20, rewardReferee: 10, lifetimeRatePercent: 0, lifetimeMonths: 12, lifetimeMode: 'everyone', codePrefix: 'roots-', shareImage: '', rewardCap: 99 };
const ROWS = () => [
  { id: 1, referrer_id: 1, invitee_id: 2, referrer_nickname: 'Chen', invitee_nickname: 'Ling', code_used: 'CHEN24', status: 'ordered', reward_amount: 20, first_paid_order_id: 412, lifetime_active: 0 },
  { id: 2, referrer_id: 1, invitee_id: 3, referrer_nickname: 'Chen', invitee_nickname: 'Wu', code_used: 'CHEN24', status: 'joined', reward_amount: 20 },
  { id: 3, referrer_id: 4, invitee_id: 5, referrer_nickname: 'Sarah', invitee_nickname: 'Mo', status: 'void', voided_reason: 'duplicate account', reward_amount: 20 },
  { id: 4, referrer_id: 6, invitee_id: 7, referrer_nickname: 'Ann', invitee_nickname: 'Bo', status: 'joined', blocked: 1, reward_amount: 20 },
];
const SUMMARY = { total: 4, joined: 2, converted: 1, voided: 1, still_earning: 0, paid_out: 20, lifetime_paid: 0 };

function mk(opts = {}) {
  const writes = [], reads = [], toasts = [], CMD = {};
  const T = (en, zh) => (opts.lang === 'zh' ? zh : en);
  const ctx = {
    LANG: opts.lang || 'en', T, CUR: '¥', API: '/api/retail-admin',
    E: (en, zh) => ({ toString() { return T(en, zh); } }),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    ic: () => '<i></i>',
    PILL: { success: ['g', 'G'], muted: ['m', 'M'], warning: ['w', 'W'] },
    money: (c, n) => { const v = Number(n || 0); return c + (v % 1 ? v.toFixed(2) : String(v)); },
    money0: (c, n) => c + Math.round(Number(n || 0)),
    featOn: () => true, flagGate: () => '<gate>',
    chipRow: (items, cur, cmd) => items.map((c) => `<chip key="${c.key}" on="${c.key === cur}" cmd="${cmd}">${T(c.en, c.zh)}${c.count != null ? '(' + c.count + ')' : ''}</chip>`).join(''),
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    toggle: (on, cmd) => `<toggle on="${on}" cmd="${cmd}"></toggle>`,
    fmtDay: (d) => String(d).slice(0, 10),
    MEDIA_ERR: {}, apiRefusal: async () => ({ message: 'refused' }), catBannerShrink: async (f) => f,
    location: { href: '' }, FormData: class { append() {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: { url: '/api/retail/media/5' } }) }),
    state: { caps: opts.caps === undefined ? ['affiliate:view', 'affiliate:edit', 'media:upload', 'customers:view'] : opts.caps,
      affiliate: null, affiliateTried: false, affRows: null, affSeg: '', affErr: null, featBusy: null, featErr: null, ask: null, askErr: null,
      stack: [{ route: 'affiliate' }] },
    render: () => {},
    forgetScroll: () => {},
    CMD,
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => toasts.push(m),
    URLSearchParams,
    apiRaw: async (p) => { reads.push(p); if (opts.ledgerFails) throw new Error('net');
      const rows = opts.rows ? opts.rows(p) : ROWS(); return { success: true, data: rows, summary: Object.assign({}, SUMMARY, opts.summary || {}), total: opts.total != null ? opts.total : rows.length }; },
    api: async (p) => {
      reads.push(p);
      if (p === '/affiliate/settings') { if (opts.setFails) { const e = new Error('timeout'); e.code = 'timeout'; throw e; } return Object.assign({}, SETTINGS, opts.settings || {}); }
      if (p === '/affiliate/eligible') return { count: 2, rows: [{ id: 8, nickname: 'Kai', phone: '139', referral_code: 'KAI1' }, { id: 9, nickname: '', phone: '' }], truncated: false };
      if (p.startsWith('/affiliate/eligible/search')) return [{ id: 11, nickname: 'Lee', phone: '137' }];
      return {};
    },
    apiWrite: async (p, body, method) => {
      writes.push({ p, body: JSON.parse(JSON.stringify(body)), method });
      if (opts.writeFails) { const e = new Error(opts.writeFails); e.code = opts.writeFails; throw e; }
      if (p === '/affiliate/eligible') return { success: true, data: { count: 1 } };
      return { success: true, data: Object.assign({}, body, { codePrefix: body.codePrefix }) };
    },
    document: { getElementById: () => null, createElement: () => ({ click() {} }) },
    Object, Array, String, Number, JSON, Promise, Set, Math, Error, encodeURIComponent, setTimeout, clearTimeout, parseInt, parseFloat,
  };
  CMD.push = (r) => ctx.state.stack.push({ route: r });
  ctx.mCan = (v) => { if (v === undefined) return true; const has = (k) => (ctx.state.caps ? ctx.state.caps.indexOf(k) !== -1 : true); return Array.isArray(v) ? v.some(has) : has(v); };
  vm.createContext(ctx);
  vm.runInContext(AFF_SRC + '\nthis.AF=AF; this.screenAffiliate=screenAffiliate; this.screenAffSettings=screenAffSettings; this.screenAffEligible=screenAffEligible;' +
    ' this.affMayLeave=affMayLeave; this.affPicUpload=affPicUpload; this.affDirty=affDirty;', ctx);
  return { ctx, CMD, writes, reads, toasts };
}
const loaded = async (o) => { const m = mk(o); m.ctx.screenAffiliate(); await tick(); return m; };
const yes = (ctx, vals) => { const a = ctx.state.ask; assert.ok(a && a.run, 'a confirm is open'); ctx.state.ask = null; a.run(vals); };
const top = (ctx) => ctx.state.stack[ctx.state.stack.length - 1].route;

section('1 · the screen and the ledger');
{
  it('the figures, the offer as one line with Change the offer, the desktop\'s filters with counts, search; no "on desktop"', async () => {
    const { ctx, reads } = await loaded();
    const html = ctx.screenAffiliate();
    assert.ok(html.includes('Give ¥10, get ¥20.') && /APP\.cmd\('affOffer'\)">Change the offer/.test(html));
    for (const c of ['All(4)', 'Waiting(2)', 'Rewarded(1)', 'Voided(1)']) assert.ok(html.includes(c), c);
    assert.ok(!html.includes('Still earning(') , 'no Still earning filter while the share is off');
    assert.ok(html.includes('placeholder="Name, phone or code"'));
    assert.ok(!/on desktop|电脑端/.test(html));
    assert.ok(reads.includes('/affiliate/referrals?page=1&pageSize=20'));
  });
  it('a row shows what it EARNED: the rewarded one its reward, the waiting and voided ones ¥0', async () => {
    const { ctx } = await loaded();
    const html = ctx.screenAffiliate();
    const amounts = (html.match(/font-weight:500;color:var\(--text-[a-z]+\)">¥\d+</g) || []).map((x) => x.match(/¥\d+/)[0]);
    assert.deepStrictEqual(amounts, ['¥20', '¥0', '¥0', '¥0']);
    assert.ok(html.includes('Can’t be rewarded') && html.includes('This friend had already bought from you before the code was used'));
  });
  it('the actions follow the status: Void on a waiting row, Close it on a blocked one, Restore on a voided one, nothing on a rewarded one', async () => {
    const { ctx } = await loaded();
    const html = ctx.screenAffiliate();
    assert.ok(/affVoidAsk',2\)">Void</.test(html) && /affVoidAsk',4\)">Close it</.test(html) && /affRestoreAsk',3\)">Restore</.test(html));
    assert.ok(!/affVoidAsk',1\)|affRestoreAsk',1\)/.test(html));
  });
  it('search, filter and pages go into the read; an emptied page steps back', async () => {
    const { ctx, CMD, reads } = await loaded({ total: 45 });
    CMD.affQ('Chen'); await wait(300); await tick();
    assert.ok(reads.includes('/affiliate/referrals?page=1&pageSize=20&q=Chen'));
    CMD.affPage(1); await tick();
    assert.ok(reads.includes('/affiliate/referrals?page=2&pageSize=20&q=Chen'));
    assert.ok(ctx.screenAffiliate().includes('Showing 21–24 of 45'));
    const b = await loaded({ total: 20, rows: (p) => (/page=2/.test(p) ? [] : ROWS()) });
    b.ctx.AF.page = 2; b.ctx.state.affiliateTried = false; b.ctx.screenAffiliate(); await tick();
    assert.strictEqual(b.ctx.AF.page, 1);
  });
  it('the empty, nothing-matches and failed ledgers say which', async () => {
    const e = await loaded({ rows: () => [], total: 0 });
    assert.ok(e.ctx.screenAffiliate().includes('No referrals yet.'));
    e.ctx.state.affSeg = 'void';
    assert.ok(e.ctx.screenAffiliate().includes('Nothing matches.'));
    const f = await loaded({ ledgerFails: true });
    assert.ok(f.ctx.screenAffiliate().includes('Could not load referrals.'));
  });
}

section('2 · Void and Restore ask first');
{
  it('Void: the desktop\'s words and a reason, then PATCH {status:"void", voided_reason}; none given is "admin"', async () => {
    const { ctx, CMD, writes, reads } = await loaded();
    CMD.affVoidAsk(2);
    const a = ctx.state.ask;
    assert.strictEqual(a.body, 'Void this referral? The referrer won’t be rewarded when this friend places their first order.');
    assert.deepStrictEqual(plain(a.fields.map((f) => [f.id, f.label])), [['reason', 'Why (kept on the record)']]);
    assert.strictEqual(writes.length, 0);
    yes(ctx, { reason: ' duplicate ' }); await tick();
    assert.deepStrictEqual(writes, [{ p: '/affiliate/referrals/2', method: 'PATCH', body: { status: 'void', voided_reason: 'duplicate' } }]);
    assert.strictEqual(reads.filter((p) => p.startsWith('/affiliate/referrals')).length, 2, 'the ledger is read again');
    CMD.affVoidAsk(4);
    assert.ok(ctx.state.ask.body.startsWith('Close this referral? It can’t be rewarded either way'));
    yes(ctx, { reason: '' }); await tick();
    assert.deepStrictEqual(writes[1].body, { status: 'void', voided_reason: 'admin' });
  });
  it('Restore: asks, then PATCH {status:"joined"}', async () => {
    const { ctx, CMD, writes } = await loaded();
    CMD.affRestoreAsk(3);
    assert.strictEqual(ctx.state.ask.body, 'Restore this referral? It goes back to waiting for a first order.');
    yes(ctx); await tick();
    assert.deepStrictEqual(writes, [{ p: '/affiliate/referrals/3', method: 'PATCH', body: { status: 'joined' } }]);
  });
  it('a refusal by the server is said, in the desktop\'s sentence, above the ledger', async () => {
    const { ctx, CMD } = await loaded({ writeFails: 'already_paid' });
    CMD.affVoidAsk(2); yes(ctx, { reason: 'x' }); await tick();
    assert.ok(ctx.screenAffiliate().includes('This one has already been rewarded, so it can’t be changed here.'));
    assert.strictEqual(ctx.AF.rowBusy, null);
  });
}

section('3 · the offer: a draft, then Save changes');
{
  it('Change the offer opens the settings: both rewards, the share switch, the prefix, the picture; nothing to save yet', async () => {
    const { ctx, CMD } = await loaded();
    CMD.affOffer();
    assert.strictEqual(top(ctx), 'affsettings');
    const html = ctx.screenAffSettings();
    for (const w of ['When a friend places their first paid order:', 'the friend gets', 'the referrer gets', 'in store credit', 'Keep rewarding repeat orders',
      'Invite codes', 'Every customer’s code starts with', 'Share picture', 'No picture yet', 'Add a picture']) assert.ok(html.includes(w), w);
    assert.ok(/aria-label="Reward for the friend"/.test(html) && /value="ROOTS-"/.test(html), 'the prefix is shown upper-case');
    assert.ok(!html.includes('Save changes'), 'no save bar until something changes');
    assert.strictEqual(ctx.affMayLeave(), true);
  });
  it('a change: the save bar says what changed, and that new amounts only apply from now; Save sends the whole settings body', async () => {
    const { ctx, CMD, writes } = await loaded();
    CMD.affOffer();
    CMD.affSetField('rewardReferee', '¥15');
    CMD.affSetField('codePrefix', 'shop-');
    let html = ctx.screenAffSettings();
    assert.ok(html.includes('You’ve changed the offer and invite codes.'));
    assert.ok(html.includes('New amounts apply to referrals rewarded from now on — nothing already earned changes.'));
    CMD.affSave(); await tick();
    assert.deepStrictEqual(writes, [{ p: '/affiliate/settings', method: 'PATCH', body: {
      rewardPerOrder: 20, rewardReferee: 15, lifetimeRatePercent: 0, lifetimeMonths: 12, lifetimeMode: 'everyone', codePrefix: 'SHOP-', shareImage: '' } }]);
    html = ctx.screenAffSettings();
    assert.ok(html.includes('Saved.') && !ctx.affDirty());
    assert.ok(ctx.screenAffiliate().includes('Give ¥15, get ¥20.'));
  });
  it('a refused save keeps the draft and says why, in the desktop\'s sentence; Discard puts the saved offer back', async () => {
    const { ctx, CMD } = await loaded({ writeFails: 'bad_reward' });
    CMD.affOffer();
    CMD.affSetField('rewardPerOrder', '99999');
    CMD.affSave(); await tick();
    assert.ok(ctx.screenAffSettings().includes('A reward has to be between ¥0 and ¥10000.'));
    assert.ok(ctx.affDirty());
    CMD.affDiscard();
    assert.ok(!ctx.affDirty() && ctx.AF.cfg.rewardPerOrder === 20);
  });
  it('turning the repeat-order share on asks first, then starts at 5%; turning it off is immediate', async () => {
    const { ctx, CMD } = await loaded();
    CMD.affOffer();
    CMD.affLife();
    assert.strictEqual(ctx.state.ask.body, 'This pays referrers a share of every future order their friends place.');
    assert.strictEqual(ctx.AF.cfg.lifetimeRatePercent, 0, 'nothing changes before the answer');
    yes(ctx);
    assert.strictEqual(ctx.AF.cfg.lifetimeRatePercent, 5);
    let html = ctx.screenAffSettings();
    assert.ok(html.includes('Who earns it') && html.includes('Any customer who refers a friend earns the ongoing share.'));
    CMD.affSetField('lifetimeMonths', '0');
    html = ctx.screenAffSettings();
    assert.ok(html.includes('Set to 0 months, the share has no end date'));
    CMD.affLife();
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(ctx.AF.cfg.lifetimeRatePercent, 0);
  });
  it('Back with unsaved changes asks in the desktop\'s words, and leaving drops the draft', async () => {
    const { ctx, CMD } = await loaded();
    CMD.affOffer();
    CMD.affSetField('rewardReferee', '30');
    assert.strictEqual(ctx.affMayLeave(), false);
    assert.deepStrictEqual([ctx.state.ask.title, ctx.state.ask.confirmLabel], ['Leave without saving? The changes on this page are lost.', 'Leave']);
    yes(ctx);
    assert.strictEqual(top(ctx), 'affiliate');
    assert.ok(!ctx.affDirty());
    assert.ok(MH.includes("if(top==='affsettings'&&!affMayLeave()) return;") && MH.includes("if(t&&t.route==='affsettings'&&!affMayLeave()) return;"));
    assert.ok(MH.includes("if(affDirty()&&(state.stack||[]).some(f=>f&&f.route==='affsettings')) return true;"), 'the reload guard knows it');
  });
  it('the share picture: uploaded, then sent with the rest', async () => {
    const { ctx, CMD, writes } = await loaded();
    CMD.affOffer();
    await ctx.affPicUpload({});
    assert.strictEqual(ctx.AF.cfg.shareImage, '/api/retail/media/5');
    assert.ok(ctx.screenAffSettings().includes('You’ve changed the share picture.'));
    CMD.affSave(); await tick();
    assert.strictEqual(writes[0].body.shareImage, '/api/retail/media/5');
  });
  it('settings that did not load: the desktop\'s words and Try again; nothing to save', async () => {
    const { ctx, CMD, reads } = await loaded({ setFails: true });
    assert.ok(ctx.screenAffiliate().includes('Couldn’t load these settings.') && !ctx.screenAffiliate().includes('affOffer'));
    ctx.state.stack.push({ route: 'affsettings' });
    const html = ctx.screenAffSettings();
    assert.ok(html.includes('The server didn’t answer in time. Try again.') && /affSetRetry/.test(html));
    CMD.affSetField('rewardReferee', '1'); CMD.affSave();
    CMD.affSetRetry(); await tick();
    assert.strictEqual(reads.filter((p) => p === '/affiliate/settings').length, 2);
  });
}

section('4 · who earns the ongoing share');
{
  it('Selected customers: the count, and the list — each pick written at once', async () => {
    const { ctx, CMD, writes } = await loaded({ settings: { lifetimeRatePercent: 5, lifetimeMode: 'selected' } });
    assert.strictEqual(ctx.AF.elig.count, 2);
    assert.ok(ctx.screenAffiliate().includes('— the ongoing share for chosen customers only.'));
    assert.ok(ctx.screenAffiliate().includes('Still earning('), 'the filter exists while the share is on');
    CMD.affOffer();
    assert.ok(ctx.screenAffSettings().includes('2 customers chosen') && /affEligOpen/.test(ctx.screenAffSettings()));
    CMD.affEligOpen(); await tick();
    assert.strictEqual(top(ctx), 'affeligible');
    let html = ctx.screenAffEligible();
    assert.ok(html.includes('Kai') && html.includes('139 · KAI1') && html.includes('No name') && /affEligSet',8,0\)">Remove/.test(html));
    CMD.affEligSet(8, 0); await tick();
    assert.deepStrictEqual(writes, [{ p: '/affiliate/eligible', method: 'POST', body: { customerId: 8, eligible: false } }]);
    assert.strictEqual(ctx.AF.elig.count, 1);
    assert.ok(!ctx.screenAffEligible().includes('Kai'), 'the row leaves the list');
    CMD.affEligQ('Le'); await wait(300); await tick();
    html = ctx.screenAffEligible();
    assert.ok(html.includes('Lee') && /affEligSet',11,1\)">Add/.test(html));
    CMD.affEligSet(11, 1); await tick();
    assert.deepStrictEqual(writes[1].body, { customerId: 11, eligible: true });
    assert.ok(ctx.screenAffEligible().includes('Nobody found. Try a different name, phone or code.'));
  });
  it('Everyone ↔ Selected is part of the draft, and goes with Save changes', async () => {
    const { ctx, CMD, writes } = await loaded({ settings: { lifetimeRatePercent: 5 } });
    CMD.affOffer();
    CMD.affMode('selected');
    assert.ok(ctx.screenAffSettings().includes('You’ve changed who earns the repeat-order share.'));
    CMD.affSave(); await tick();
    assert.strictEqual(writes[0].body.lifetimeMode, 'selected');
  });
}

section('5 · the keys');
{
  it('without the affiliate keys: no Change the offer, no row actions; the commands write nothing', async () => {
    const { ctx, CMD, writes } = await loaded({ caps: ['dashboard:view'] });
    const html = ctx.screenAffiliate();
    assert.ok(!/affOffer|affVoidAsk|affRestoreAsk/.test(html));
    CMD.affOffer(); CMD.affVoidAsk(2); CMD.affRestoreAsk(3); CMD.affSetField('rewardReferee', '1'); CMD.affSave(); CMD.affLife(); CMD.affEligOpen(); CMD.affEligSet(8, 0);
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(ctx.state.stack.length, 1);
    assert.strictEqual(writes.length, 0);
  });
  it('while the keys are still unknown it fails CLOSED: these decide what a customer is paid', async () => {
    const { ctx, CMD, writes } = await loaded({ caps: null });
    assert.ok(!/affOffer|affVoidAsk/.test(ctx.screenAffiliate()));
    CMD.affVoidAsk(2);
    assert.strictEqual(ctx.state.ask, null);
    assert.strictEqual(writes.length, 0);
  });
  it('affiliate:view alone runs the offer and the ledger, but not the picked list (affiliate:edit)', async () => {
    const { ctx, CMD } = await loaded({ caps: ['affiliate:view'], settings: { lifetimeRatePercent: 5, lifetimeMode: 'selected' } });
    CMD.affOffer();
    assert.ok(!/affEligOpen/.test(ctx.screenAffSettings()));
    CMD.affEligOpen();
    assert.strictEqual(top(ctx), 'affsettings');
    assert.ok(/affsettings:\['affiliate:view','affiliate:edit'\], affeligible:'affiliate:edit'/.test(MH));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
