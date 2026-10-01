#!/usr/bin/env node
/**
 * §325 X1 — WHAT THE SHOP DID, WHAT IT SENT, WHO IS LOOKING, AND TWO HOME ROWS.
 *
 *   node scripts/test_mobile_settings_records.js
 *
 * Four reads the desktop had and the phone did not:
 *   • Settings → Change history (GET /activity-log, and its CSV);
 *   • Settings → What was sent (GET /notification-log);
 *   • "browsing now" in the foot of Home's customers card (GET /dashboard/presence);
 *   • Home rows for orders parked for a delivery point and parcels to recover,
 *     each opening the order (/dashboard/ops, which Home already reads).
 *
 * The phone code is RUN, sliced out of public/m.html into a sandbox with a fake
 * server whose answers the test releases one at a time, so every request is
 * asserted on its path and query and the stale-answer guards can be exercised.
 * The desktop (public/retail-admin/02-settings-ops.js) is the spec: its action
 * words, channel names and message kinds are sliced out of it and compared.
 * No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const OPS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const { tdWhen } = require('../public/td-datetime.js');

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
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
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

const X1 = slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X1 — WHAT THE SHOP DID', '/* §325 X1 ends */');
const SRC = [
  slice(M, 'const PILL = {', 'function toggle('),
  line(M, 'function E(en, zh)'),
  block(M, 'function nothingYet('),
  block(M, 'function noteBar('),
  block(M, 'function searchBox('),
  line(M, 'function searchClearShow('),
  block(M, 'const _date=v=>'),
  block(M, 'function oldestMins(items)'),
  block(M, 'function oldestOf(items)'),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  X1,
].join('\n');

function mk(opts = {}) {
  const calls = { api: [], renders: 0, pushed: [], timers: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, DB: { products: [] },
    state: {
      caps: opts.caps === undefined ? null : opts.caps,
      ask: null, ops: opts.ops || null, presence: null,
      ordersView: null, liveOrders: null, detailId: null,
      chl: { rows: null, total: 0, people: [], kinds: [], who: '', what: '', from: '', to: '', q: '', err: null, tried: false, more: false, seq: 0, open: null },
      nlg: { rows: null, total: 0, failed: 0, channels: [], kinds: [], channel: '', kind: '', from: '', to: '', q: '', onlyFailed: false, err: null, tried: false, more: false, seq: 0, open: null },
      elm: { cfg: null, st: null, err: null, tried: false, seq: 0, cat: {}, catStore: null, catQ: '' },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (r) => { calls.pushed.push(r); },
    recapNoMoney: () => false, featOn: () => true,
    tdWhen, _tdL: () => ({ lang: ctx.LANG === 'en' ? 'en' : 'cn' }),
    mapDetail: (o) => ({ id: o.order_no, _id: o.id }),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: () => { throw new Error('X1 is read-only — nothing here may write'); },
    location: { href: '' },
    document: { getElementById: (id) => els[id] || null },
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return calls.timers.length; },
    clearTimeout: () => {},
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp,
    encodeURIComponent, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.PILL=PILL;').runInContext(ctx);
  // canRoute is sliced whole below the money set; it is a function
  // declaration, so it landed on the context with everything else.
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text };
}
const tick = () => new Promise((r) => setImmediate(r));
async function answer(h, i, data) { h.calls.api[i].res(data); await tick(); }
async function refuse(h, i, err) { h.calls.api[i].rej(err || new Error('HTTP 500')); await tick(); }
const qsOf = (p) => new URLSearchParams(p.split('?')[1] || '');
const q = (p) => Object.fromEntries(qsOf(p));

const SETTINGS_KEYS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'];

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches them');
{
  it('Change history and What was sent carry exactly the Settings screen\'s keys', () => {
    const { ctx } = mk();
    assert.deepStrictEqual([...ctx.ROUTE_CAP.changes], SETTINGS_KEYS);
    assert.deepStrictEqual([...ctx.ROUTE_CAP.sent], SETTINGS_KEYS);
    assert.deepStrictEqual([...ctx.ROUTE_CAP.settings], SETTINGS_KEYS);
  });
  it('an account holding none of them is refused both; one holding any gets both', () => {
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.canRoute('changes'), false);
    assert.strictEqual(mk({ caps: ['orders:view'] }).ctx.canRoute('sent'), false);
    assert.strictEqual(mk({ caps: ['stores:view'] }).ctx.canRoute('changes'), true);
    assert.strictEqual(mk({ caps: ['settings:push'] }).ctx.canRoute('sent'), true);
  });
  it('the Settings screen draws each row only where the route opens, and the row pushes it', () => {
    const s = block(M, 'function screenSettings(){');
    assert.ok(/canRoute\('changes'\)\?\[\{label:T\('Change history','修改记录'\),cmd:"APP\.cmd\('push','changes'\)"/.test(s));
    assert.ok(/canRoute\('sent'\)\?\[\{label:T\('What was sent','发送记录'\),cmd:"APP\.cmd\('push','sent'\)"/.test(s));
  });
  it('the parked-orders list opens orders, so it needs the Orders key', () => {
    assert.strictEqual(mk().ctx.ROUTE_CAP.needspoint, 'orders:view');
    assert.strictEqual(mk({ caps: ['dashboard:view'] }).ctx.canRoute('needspoint'), false);
  });
  it('every entry re-reads: push() resets both screens', () => {
    const p = block(M, 'function push(route)');
    assert.ok(/route==='changes'\|\|route==='sent'\)\{ const c=route==='sent'\?state\.nlg:state\.chl; c\.tried=false; c\.rows=null;/.test(p));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · Change history — the desktop\'s words');
{
  it('the action words are the desktop\'s, key for key', () => {
    const desk = vm.runInNewContext('(' + slice(OPS, 'const CH_ACTIONS = {', '};').replace('const CH_ACTIONS = ', '') + '})');
    const { ctx } = mk();
    const phone = vm.runInContext('CHL_ACTIONS', ctx);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(phone)), JSON.parse(JSON.stringify(desk)));
  });
  it('actions read as words, by the desktop\'s rule', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.chlAction('update'), 'Edited');
    assert.strictEqual(ctx.chlAction('update_product'), 'Edited product');
    assert.strictEqual(ctx.chlAction('refund_approve'), 'Refunded approve');
    assert.strictEqual(ctx.chlAction('set_price'), 'set price');
    const zh = mk({ lang: 'zh' }).ctx;
    assert.strictEqual(zh.chlAction('update_product'), '修改 product');
  });
  it('details read as field: value pairs, and raw text stays raw', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.chlDetails('{"sell_price":12,"old":null}'), 'sell price: 12 · old: —');
    assert.strictEqual(ctx.chlDetails('not json'), 'not json');
    assert.strictEqual(ctx.chlDetails(''), '');
  });
}

section('3 · Change history — the read, the list, the pages');
{
  const ROWS = [
    { id: 9, username: 'ash', action: 'update_product', entity_type: 'product', entity_id: 12, details: '{"sell_price":12}', created_at: '2026-09-30 02:00:00' },
    { id: 8, username: null, action: 'login', entity_type: null, entity_id: null, details: null, created_at: '2026-09-29 02:00:00' },
  ];
  it('first paint says Loading and asks once, for the first hundred', () => {
    const h = mk();
    const html = h.ctx.SUBS.changes.render();
    assert.ok(/Loading…/.test(h.text(html)));
    assert.strictEqual(h.calls.api.length, 1);
    assert.strictEqual(h.calls.api[0].p, '/activity-log?limit=100&offset=0');
    h.ctx.SUBS.changes.render();
    assert.strictEqual(h.calls.api.length, 1, 'a second paint does not ask again');
  });
  it('the rows: who, what, the record, the details, and how many of how many', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    await answer(h, 0, { success: true, data: ROWS, total: 5, people: ['ash', 'mia'], kinds: ['product'] });
    const t = h.text(h.ctx.SUBS.changes.render());
    assert.ok(t.includes('ash · Edited product'), t);
    assert.ok(t.includes('product #12'));
    assert.ok(t.includes('sell price: 12'));
    assert.ok(t.includes('(unknown) · Signed in'));
    assert.ok(t.includes('Showing 2 of 5'));
    assert.ok(t.includes('Show more'));
    assert.ok(t.includes('Export CSV'));
    const html = h.ctx.SUBS.changes.render();
    assert.ok(/<option value="mia">mia<\/option>/.test(html), 'the people filter is the server\'s list');
    assert.ok(/<option value="">Everyone<\/option>/.test(html) && /<option value="">Everything<\/option>/.test(html));
  });
  it('Show more asks from where the list ends, and appends', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    await answer(h, 0, { success: true, data: ROWS, total: 3, people: [], kinds: [] });
    h.CMD.chlMore();
    assert.strictEqual(h.calls.api[1].p, '/activity-log?limit=100&offset=2');
    await answer(h, 1, { success: true, data: [{ id: 7, username: 'mia', action: 'delete', created_at: '2026-09-28 02:00:00' }], total: 3, people: [], kinds: [] });
    assert.strictEqual(h.ctx.state.chl.rows.length, 3);
    assert.ok(!/Show more/.test(h.text(h.ctx.SUBS.changes.render())), 'all shown — no more button');
  });
  it('the body is patched in place when it is on screen, so a search keeps its keyboard', async () => {
    const h = mk();
    h.els.mChlBody = { innerHTML: '' };
    h.ctx.SUBS.changes.render();
    const before = h.calls.renders;
    await answer(h, 0, { success: true, data: ROWS, total: 2, people: [], kinds: [] });
    assert.strictEqual(h.calls.renders, before, 'no whole-screen render');
    assert.ok(/ash · Edited product/.test(h.text(h.els.mChlBody.innerHTML)));
  });
  it('a stale answer is dropped: the newer filter wins', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    h.CMD.chlWho('mia');
    await answer(h, 1, { success: true, data: [ROWS[0]], total: 1, people: [], kinds: [] });
    await answer(h, 0, { success: true, data: ROWS, total: 2, people: [], kinds: [] });
    assert.strictEqual(h.ctx.state.chl.total, 1);
  });
  it('tapping a row opens its details in full; tapping again closes them', () => {
    const h = mk();
    h.CMD.chlOpen(9); assert.strictEqual(h.ctx.state.chl.open, 9);
    h.CMD.chlOpen(9); assert.strictEqual(h.ctx.state.chl.open, null);
  });
}

section('4 · Change history — every filter is on the request');
{
  it('who and what', () => {
    const h = mk();
    h.CMD.chlWho('ash');
    assert.deepStrictEqual(q(h.calls.api[0].p), { who: 'ash', limit: '100', offset: '0' });
    h.CMD.chlWhat('product');
    assert.deepStrictEqual(q(h.calls.api[1].p), { who: 'ash', entity_type: 'product', limit: '100', offset: '0' });
    assert.strictEqual(h.ctx.state.chl.rows, null, 'the list blanks to Loading under a new filter');
  });
  it('the dates, through a sheet that refuses an inverted window before the server would', () => {
    const h = mk();
    h.CMD.chlWhen();
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'When');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a.fields.map((f) => [f.id, f.type]))), [['from', 'date'], ['to', 'date']]);
    assert.strictEqual(a.validate({ from: '2026-09-10', to: '2026-09-01' }), 'From is after to');
    assert.strictEqual(a.validate({ from: '2026-09-01', to: '' }), null, 'one end alone is allowed, as on the desktop');
    a.run({ from: '2026-09-01', to: '2026-09-10' });
    assert.deepStrictEqual(q(h.calls.api[0].p), { from: '2026-09-01', to: '2026-09-10', limit: '100', offset: '0' });
    assert.ok(/2026-09-01 – 2026-09-10/.test(h.text(h.ctx.chlBody())));
  });
  it('the search waits a quarter second, then asks with q', () => {
    const h = mk();
    h.CMD.chlQ('  refund ');
    assert.strictEqual(h.calls.api.length, 0);
    assert.strictEqual(h.calls.timers.at(-1).ms, 250);
    h.calls.timers.at(-1).f();
    assert.deepStrictEqual(q(h.calls.api[0].p), { q: 'refund', limit: '100', offset: '0' });
  });
  it('Export CSV downloads the desktop\'s file with the same filters', () => {
    const h = mk();
    h.CMD.chlWho('ash'); h.CMD.chlWhat('product');
    h.CMD.chlExport();
    assert.strictEqual(h.ctx.location.href, '/api/retail-admin/activity-log/export.csv?who=ash&entity_type=product');
    const h2 = mk(); h2.CMD.chlExport();
    assert.strictEqual(h2.ctx.location.href, '/api/retail-admin/activity-log/export.csv');
  });
  it('Clear filters drops every one and asks again with none', () => {
    const h = mk();
    h.els.mChlQ = { value: 'x' };
    h.CMD.chlWho('ash'); h.ctx.state.chl.q = 'x'; h.ctx.state.chl.from = '2026-09-01';
    assert.ok(/Clear filters/.test(h.text(h.ctx.chlBody())));
    h.CMD.chlClear();
    assert.strictEqual(h.calls.api.at(-1).p, '/activity-log?limit=100&offset=0');
    assert.strictEqual(h.els.mChlQ.value, '');
    assert.ok(!/Clear filters/.test(h.text(h.ctx.chlBody())));
  });
}

section('5 · Change history — empty and failed');
{
  it('nothing yet, and nothing filtered: the desktop\'s sentence', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    await answer(h, 0, { success: true, data: [], total: 0, people: [], kinds: [] });
    const t = h.text(h.ctx.SUBS.changes.render());
    assert.ok(t.includes('Nothing has been changed yet.') && t.includes('Every edit your team makes will appear here.'));
    assert.ok(!t.includes('Nothing matches'));
  });
  it('filtered to nothing is a different fact, with a way back', async () => {
    const h = mk();
    h.CMD.chlWho('mia');
    await answer(h, 0, { success: true, data: [], total: 0, people: [], kinds: [] });
    const html = h.ctx.chlBody();
    assert.ok(/Nothing matches those filters\./.test(h.text(html)));
    assert.ok(/APP\.cmd\('chlClear'\)">Clear them/.test(html));
  });
  it('a failed read says so, stays, and offers Try again — which asks again', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    await refuse(h, 0);
    let t = h.text(h.ctx.chlBody());
    assert.ok(t.includes('Could not load the change history.') && t.includes('Try again'));
    h.CMD.chlRetry();
    assert.strictEqual(h.calls.api.length, 2);
    const net = mk(); net.ctx.SUBS.changes.render();
    await refuse(net, 0, new TypeError('Failed to fetch'));
    t = net.text(net.ctx.chlBody());
    assert.ok(t.includes('Check your connection and try again.'));
  });
  it('a refusal in the body (success:false) is a failure, not an empty list', async () => {
    const h = mk();
    h.ctx.SUBS.changes.render();
    await answer(h, 0, { success: false, error: 'activity_log_failed' });
    assert.ok(/Could not load the change history\./.test(h.text(h.ctx.chlBody())));
    assert.ok(!/Nothing has been changed/.test(h.text(h.ctx.chlBody())));
  });
  it('in Chinese', async () => {
    const h = mk({ lang: 'zh' });
    h.ctx.SUBS.changes.render();
    await answer(h, 0, { success: true, data: [], total: 0, people: [], kinds: [] });
    const t = h.text(h.ctx.SUBS.changes.render());
    assert.ok(t.includes('暂无修改记录。') && t.includes('全部人员') && t.includes('导出') && t.includes('时间'));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('6 · What was sent');
{
  const deskMap = (name) => vm.runInNewContext('(' + slice(OPS, `const ${name} = {`, '};').replace(`const ${name} = `, '') + '})');
  it('how it went and what it was about are the desktop\'s words', () => {
    const { ctx } = mk();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(vm.runInContext('NLG_CHANNELS', ctx))), JSON.parse(JSON.stringify(deskMap('NL_CHANNELS'))));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(vm.runInContext('NLG_KINDS', ctx))), JSON.parse(JSON.stringify(deskMap('NL_KINDS'))));
    assert.strictEqual(ctx.nlgKind('refund_issued'), 'Refund issued', 'an unknown kind reads as words');
  });
  const ROWS = [
    { id: 3, channel: 'push', kind: 'new_order', subject: 'TC000218', recipient: null, ok: true, detail: { sent: 3, total: 5, muted: 1, pruned: 1 }, created_at: '2026-09-30 02:00:00' },
    { id: 2, channel: 'sms', kind: 'signin_code', subject: null, recipient: '+86 138', ok: false, error: 'quota_exceeded', created_at: '2026-09-30 01:00:00' },
    { id: 1, channel: 'email', kind: 'order_paid', subject: null, recipient: 'a@b.c', ok: true, detail: null, created_at: '2026-09-30 00:00:00' },
  ];
  it('asks the desktop\'s endpoint once, then draws what landed and what did not', async () => {
    const h = mk();
    assert.ok(/Loading…/.test(h.text(h.ctx.SUBS.sent.render())));
    assert.strictEqual(h.calls.api[0].p, '/notification-log?limit=100&offset=0');
    await answer(h, 0, { success: true, data: ROWS, total: 3, failed: 1, channels: ['email', 'push', 'sms'], kinds: ['new_order'] });
    const t = h.text(h.ctx.SUBS.sent.render());
    assert.ok(t.includes('A new order') && t.includes('TC000218'));
    assert.ok(t.includes('Phone alert · your team'), 'no recipient reads as the team');
    assert.ok(t.includes('3 of 5 reached · 1 muted · 1 device gone'));
    assert.ok(t.includes('Sign-in code') && t.includes('Text message · +86 138') && t.includes('Did not arrive') && t.includes('Quota exceeded'));
    assert.ok(t.includes('A customer paid') && t.includes('Sent'));
    assert.ok(t.includes('Did not arrive (1)'), 'the failed-only chip carries its count');
    assert.ok(t.includes('Showing 3 of 3'));
  });
  it('the failed-only chip, the two selects and the dates are all on the request', () => {
    const h = mk();
    h.CMD.nlgFailed();
    assert.deepStrictEqual(q(h.calls.api[0].p), { failed: '1', limit: '100', offset: '0' });
    h.CMD.nlgChannel('sms');
    h.CMD.nlgKind('signin_code');
    h.CMD.nlgWhen(); h.ctx.state.ask.run({ from: '2026-09-01', to: '' });
    assert.deepStrictEqual(q(h.calls.api.at(-1).p), { channel: 'sms', kind: 'signin_code', from: '2026-09-01', failed: '1', limit: '100', offset: '0' });
    h.CMD.nlgQ('138'); h.calls.timers.at(-1).f();
    assert.strictEqual(q(h.calls.api.at(-1).p).q, '138');
    h.CMD.nlgClear();
    assert.strictEqual(h.calls.api.at(-1).p, '/notification-log?limit=100&offset=0');
    assert.strictEqual(h.ctx.state.nlg.onlyFailed, false);
  });
  it('no failures and not filtered to them: the chip is not drawn', async () => {
    const h = mk();
    h.ctx.SUBS.sent.render();
    await answer(h, 0, { success: true, data: [ROWS[2]], total: 1, failed: 0, channels: [], kinds: [] });
    assert.ok(!/Did not arrive/.test(h.text(h.ctx.nlgBody())));
  });
  it('empty, filtered-empty and failed are three different screens', async () => {
    const e = mk(); e.ctx.SUBS.sent.render();
    await answer(e, 0, { success: true, data: [], total: 0, failed: 0, channels: [], kinds: [] });
    assert.ok(/Nothing has been sent yet\./.test(e.text(e.ctx.nlgBody())));
    const f = mk(); f.CMD.nlgChannel('sms');
    await answer(f, 0, { success: true, data: [], total: 0, failed: 0, channels: [], kinds: [] });
    assert.ok(/Nothing matches those filters\./.test(f.text(f.ctx.nlgBody())));
    const x = mk(); x.ctx.SUBS.sent.render(); await refuse(x, 0);
    assert.ok(/Could not load the send record\./.test(x.text(x.ctx.nlgBody())));
  });
  it('in Chinese', async () => {
    const h = mk({ lang: 'zh' });
    h.ctx.SUBS.sent.render();
    await answer(h, 0, { success: true, data: ROWS, total: 3, failed: 1, channels: [], kinds: [] });
    const t = h.text(h.ctx.SUBS.sent.render());
    assert.ok(t.includes('手机推送 · 团队') && t.includes('5 台中 3 台已送达') && t.includes('未送达(1)') && t.includes('全部方式'));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('7 · browsing now');
{
  it('reads the desktop\'s endpoint, and only for somebody who can open Home', async () => {
    const h = mk();
    h.ctx.loadPresence();
    assert.strictEqual(h.calls.api[0].p, '/dashboard/presence');
    await answer(h, 0, { viewing: 3, products_with_viewers: 2 });
    assert.strictEqual(h.ctx.state.presence.viewing, 3);
    const d = mk({ caps: ['orders:view'] });
    await d.ctx.loadPresence();
    assert.strictEqual(d.calls.api.length, 0);
  });
  it('the count and the desktop\'s label; at zero the label is the whole sentence', () => {
    const h = mk();
    assert.strictEqual(h.ctx.presenceLine(), '', 'nothing read yet, nothing drawn');
    h.ctx.state.presence = { viewing: 3 };
    assert.strictEqual(h.text(h.ctx.presenceLine()), '3 browsing now');
    h.ctx.state.presence = { viewing: 0 };
    assert.strictEqual(h.text(h.ctx.presenceLine()), 'no one browsing right now');
    const z = mk({ lang: 'zh' }); z.ctx.state.presence = { viewing: 2 };
    assert.strictEqual(z.text(z.ctx.presenceLine()), '2 人正在浏览');
  });
  it('a failed poll keeps the last count', async () => {
    const h = mk();
    h.ctx.state.presence = { viewing: 4 };
    h.ctx.loadPresence(); await refuse(h, 0);
    assert.strictEqual(h.ctx.state.presence.viewing, 4);
  });
  it('it rides the customers card, and Home\'s first read and its 60s tick', () => {
    assert.ok(/\$\{presenceLine\(\)\}<\/div>`;/.test(block(M, 'function vitalsBlock(){')));
    assert.ok(/mSettled\(loadPresence\(\)\)/.test(block(M, 'function mLiveTick(){')));
    assert.ok(/loadOps\(\);\n  loadPresence\(\)\.then\(\(\)=>render\(\)\);/.test(M));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('8 · Home: parked for a delivery point, parcels to recover');
{
  const NP = (n, items) => ({ needs_point: { count: n, items } });
  const it1 = { id: 41, order_no: 'TC000041', buyer: 'Mia', store_en: 'Tianhe', store_cn: '天河', parked_since: '2026-09-30 00:00:00', promised_day: null };
  it('opsFires hands its payload to recoverFires', () => {
    assert.ok(/recoverFires\(o\)\.forEach\(x=>f\.push\(x\)\);/.test(block(M, 'function opsFires(){')));
  });
  it('one parked order: a brick row that opens THAT order', () => {
    const h = mk();
    const [f] = h.ctx.recoverFires(NP(1, [it1]));
    assert.strictEqual(f.sev, 'brick');
    assert.strictEqual(f.label, 'Orders waiting for a delivery point');
    assert.strictEqual(f.n, 1);
    assert.strictEqual(f.meta, 'TC000041');
    assert.strictEqual(f.go, "APP.cmd('openOpsOrder','needs_point',41)");
    assert.ok(typeof f.mins === 'number', 'it sorts on how long it has been parked');
  });
  it('several: the order numbers, the rest counted off the total, and the list', () => {
    const h = mk();
    const items = [it1, { ...it1, id: 42, order_no: 'TC000042' }, { ...it1, id: 43, order_no: 'TC000043' }];
    const [f] = h.ctx.recoverFires(NP(5, items));
    assert.strictEqual(f.meta, 'TC000041, TC000042 +3 more');
    assert.strictEqual(f.go, "APP.cmd('push','needspoint')");
  });
  it('parcels to recover: amber; one opens its order, more open the Orders filter the desktop uses', () => {
    const h = mk();
    const one = h.ctx.recoverFires({ parcel_recovery: { count: 1, items: [{ shipment_id: 7, order_id: 77, order_no: 'TC000077', waiting_since: '2026-09-29 00:00:00' }] } })[0];
    assert.strictEqual(one.sev, 'amber'); assert.strictEqual(one.label, 'Parcels to recover');
    assert.strictEqual(one.go, "APP.cmd('openOpsOrder','parcel_recovery',77)");
    const many = h.ctx.recoverFires({ parcel_recovery: { count: 2, items: [{ order_id: 77, order_no: 'TC000077' }, { order_id: 78, order_no: 'TC000078' }] } })[0];
    assert.strictEqual(many.go, "APP.cmd('ordersGo','recover')");
    assert.ok(/recover:'recover_parcel'/.test(slice(M, 'const STATUS_PARAM={', '};')), 'the filter is the server\'s pseudo-status');
    assert.ok(/state\.statusF==='recover'\?`<div[^`]*APP\.cmd\('statusF','all'\)[^`]*Parcels to recover/.test(M), 'the narrowed list names itself and can be cleared');
  });
  it('nothing at zero, and nothing for somebody who cannot open Orders', () => {
    assert.deepStrictEqual([...mk().ctx.recoverFires({ needs_point: { count: 0, items: [] }, parcel_recovery: { count: 0 } })], []);
    assert.deepStrictEqual([...mk().ctx.recoverFires({})], []);
    assert.deepStrictEqual([...mk({ caps: ['dashboard:view'] }).ctx.recoverFires(NP(2, [it1]))], []);
  });
  it('opening one reads the order by its id and shows it under its number', async () => {
    const h = mk({ ops: NP(1, [it1]) });
    h.CMD.openOpsOrder('needs_point', 41);
    assert.strictEqual(h.ctx.state.detailId, 'TC000041');
    assert.strictEqual(h.ctx.state.detailFetch, true);
    assert.strictEqual(h.calls.api[0].p, '/orders/41');
    await answer(h, 0, { id: 41, order_no: 'TC000041' });
    assert.strictEqual(h.ctx.state.detailFetch, false);
    assert.strictEqual(h.ctx.state.liveDetail._id, 41);
  });
  it('a failed open says so on the sheet', async () => {
    const h = mk({ ops: { parcel_recovery: { count: 1, items: [{ order_id: 77, order_no: 'TC000077' }] } } });
    h.CMD.openOpsOrder('parcel_recovery', 77);
    assert.strictEqual(h.calls.api[0].p, '/orders/77');
    await refuse(h, 0);
    assert.ok(/could not be opened/.test(h.ctx.state.orderErr));
  });
  it('an id that is not in the snapshot opens nothing', () => {
    const h = mk({ ops: NP(1, [it1]) });
    h.CMD.openOpsOrder('needs_point', 99);
    assert.strictEqual(h.calls.api.length, 0);
  });
  it('the parked list: number, who and where, and when it runs out of road', () => {
    const h = mk({ ops: NP(4, [
      { ...it1, parked_since: new Date(Date.now() - 2 * 3600e3).toISOString() },
      { id: 42, order_no: 'TC000042', buyer: null, store_code: null, promised_day: '2026-10-02', date_posture: 'tomorrow' },
    ]) });
    const html = h.ctx.SUBS.needspoint.render();
    const t = h.text(html);
    assert.ok(t.includes('TC000041') && t.includes('Mia · Tianhe') && t.includes('parked 2h'), t);
    assert.ok(t.includes('No name on the order · Store not recorded'));
    assert.ok(/Tomorrow · /.test(t));
    assert.ok(t.includes('and 2 more waiting for a delivery point'));
    assert.ok(t.includes('The point is placed on the desktop map.'));
    assert.ok(/APP\.cmd\('openOpsOrder','needs_point',42\)/.test(html));
  });
  it('before the snapshot arrives the list says Loading', () => {
    assert.ok(/Loading…/.test(mk().ctx.SUBS.needspoint.render()));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
