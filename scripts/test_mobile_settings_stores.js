#!/usr/bin/env node
/**
 * §325 X6 — STORES, THEIR STOCK STAFF, AND THE TEAM'S DEVICES, ON THE PHONE.
 *
 *   node scripts/test_mobile_settings_stores.js
 *
 * The desktop's store editor (02-settings-ops.js _opsStoreForm): an existing
 * store saves itself (§279) on the same engine (public/tacet-autosave.js,
 * loaded here for real), PATCH /stores/:id?history=store.<id>; a new one keeps
 * Save, POST /stores; the manual pin is its own PATCH. A store's stock staff
 * (_opsStoreStaff) — listed, added, removed, password reset. Team devices
 * (§326.5) — listed, filtered, signed out.
 *
 * What is asserted: every write's method, path and body, field for field (the
 * store body against the desktop's _opsStoreBody, key for key and in order);
 * the desktop's checks before each write; refusals and failures rendered in
 * place; empty, loading and failed-load states; who is refused; both
 * languages. No browser — fast shard.
 */
'use strict';

// Fails unless the run reaches its own end: a test awaiting a write the fake
// server never answers would otherwise drain the event loop and exit 0.
process.exitCode = 1;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const OPS = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const TacetAutosave = require('../public/tacet-autosave.js');

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
  line(M, 'const cfgSendErr='),
  block(M, 'function toggle('),
  block(M, 'function chipRow('),
  block(M, 'function opsStoreRow('),
  block(M, 'function acctAgo('),
  block(M, 'function tmRow('),
  block(M, 'function tmList('),
  block(M, 'function tmCaption('),
  block(M, 'function x1Err('),
  line(M, 'const x1Loading='),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X6 — STORES', '/* §325 X6 ends */'),
].join('\n');

const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
const STORE = {
  id: 7, code: 'tianhe', name_en: 'Roots — Tianhe', name_cn: 'Roots · 天河店', city: '广州', district: '天河区',
  address: '体育西路1号', phone: '020-1234', sort_order: 2, pickup_enabled: 1, open_time: '09:00', close_time: '21:00',
  sync_start_time: null, low_stock_threshold: null, lat: 23.1, lng: 113.3, is_active: 1,
};

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], renders: 0, asks: [], pops: 0, timers: [] };
  const CMD = {};
  const els = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, TacetAutosave,
    state: {
      caps: opts.caps === undefined ? ['stores:edit', 'team:manage'] : opts.caps,
      stores: opts.stores === undefined ? [Object.assign({}, STORE)] : opts.stores,
      stack: [{ route: 'operations' }], ask: null, askErr: null,
      sto: { id: null, rec: null, d: null, err: null, busy: false, pinLat: '', pinLng: '', pinBusy: false, pinErr: null,
        listTried: false, listErr: null,
        staffFor: null, staffRec: null, staff: null, staffTried: false, staffErr: null, staffBusy: null, staffActErr: null,
        add: { name: '', user: '', pw: '' }, addErr: null },
      tmd: { list: null, tried: false, err: null, kind: 'all', busy: null, actErr: null },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: (r) => { if (ctx.canRoute(r)) ctx.state.stack.push({ route: r }); },
    pop: () => { calls.pops++; ctx.state.stack.pop(); },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true,
    tdWhen: (d) => 'D' + new Date(d).toISOString().slice(0, 10), _tdL: () => ({}),
    liveHistorySheet: (list, sub, restore) => { calls.asks.push({ list, sub, restore }); },
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: body == null ? body : plain(body), keys: body ? Object.keys(body) : [], method: method || 'POST', res, rej });
    }),
    document: { getElementById: (id) => els[id] || null },
    location: { href: '' },
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return 0; }, clearTimeout,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN, parseInt, parseFloat,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  // The engine keeps its own (real) pause timer; the screen's later re-read is caught above.
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.canRoute=canRoute;this.eng=()=>stoAuto;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, els, text, s: ctx.state.sto, t: ctx.state.tmd };
}
const tick = () => new Promise((r) => setImmediate(r));
const fn = (h, name) => vm.runInContext(name, h.ctx);

// The desktop's store body, key for key, read out of _opsStoreBody.
const DESK_BODY_KEYS = [...block(OPS, 'function _opsStoreBody()').split('return {')[1].matchAll(/([a-z_]+):/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches them');
{
  it('each route carries the key the server asks of its writes', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.ROUTE_CAP.storeone, 'stores:edit');
    assert.deepStrictEqual(plain(ctx.ROUTE_CAP.storestaff), ['stores:edit', 'team:manage']);
    assert.strictEqual(ctx.ROUTE_CAP.teamdevices, 'team:manage');
  });
  it('Operations draws Edit and Add store for stores:edit, Stock staff for either key, and nothing for neither', () => {
    const full = mk(); const ops = full.text(fn(full, 'stoSection')());
    assert.ok(ops.includes('Edit') && ops.includes('Stock staff') && ops.includes('+ Add store'));
    const team = mk({ caps: ['team:manage'] }); const t2 = team.text(fn(team, 'stoSection')());
    assert.ok(t2.includes('Stock staff') && !/\bEdit\b/.test(t2) && !t2.includes('Add store'));
    const none = mk({ caps: ['orders:view'] }); const t3 = none.text(fn(none, 'stoSection')());
    assert.ok(t3.includes('Roots — Tianhe'), 'the list itself is still there');
    assert.ok(!t3.includes('Stock staff') && !/\bEdit\b/.test(t3) && !t3.includes('Add store'));
  });
  it('without the key nothing opens and nothing is sent', async () => {
    const h = mk({ caps: ['orders:view'] });
    h.CMD.stoOpen(7); h.CMD.stoNew(); h.CMD.stfOpen(7);
    assert.strictEqual(h.ctx.state.stack.length, 1);
    assert.strictEqual(h.ctx.eng(), null);
    h.s.id = null; h.s.d = fn(h, 'stoSeed')(null); h.s.d.code = 'x'; h.CMD.stoSave();
    h.s.id = 7; h.s.pinLat = '1'; h.s.pinLng = '2'; h.CMD.stoPin();
    h.s.staffFor = 7; h.s.add = { name: 'A', user: 'a.b', pw: '0123456789' }; h.CMD.stfAdd();
    h.t.list = [{ id: 's1' }]; h.CMD.tmdOut('s1');
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('Team devices has its door on the People list, only where it opens', () => {
    const h = mk(); assert.ok(h.text(fn(h, 'tmdDoor')()).includes('Team devices'));
    const n = mk({ caps: ['team:view'] }); assert.strictEqual(fn(n, 'tmdDoor')(), '');
    assert.ok(block(M, 'function teamPeoplePane(){').includes('${tmdDoor()}'));
  });
}

section('2 · the store list on Operations');
{
  it('is re-read on every entry into Operations', () => {
    const h = mk({ stores: null });
    fn(h, 'stoSection')();
    assert.strictEqual(h.calls.api[0].p, '/stores');
    fn(h, 'stoSection')();
    assert.strictEqual(h.calls.api.length, 1, 'once per visit');
    assert.ok(/route==='operations'\)\{ state\.sto\.listTried=false; state\.sto\.listErr=null; \}/.test(block(M, 'function push(route)')));
    assert.ok(block(M, 'function screenOperations(){').includes('${stoSection()}'));
  });
  it('a failed read says so in place and offers Try again', async () => {
    const h = mk({ stores: null });
    fn(h, 'stoSection')(); h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    const t = h.text(fn(h, 'stoSection')());
    assert.ok(t.includes('Could not load this.') && t.includes('Try again'));
    h.CMD.stoRetry(); fn(h, 'stoSection')();
    assert.strictEqual(h.calls.api.length, 2);
  });
  it('no stores: the desktop\'s line and Add store, for somebody who can add one; nothing otherwise', async () => {
    const h = mk({ stores: null });
    fn(h, 'stoSection')(); h.calls.api[0].res([{ id: 1, is_active: 0 }]); await tick();
    const t = h.text(fn(h, 'stoSection')());
    assert.ok(t.includes('No stores yet. Add one below.') && t.includes('+ Add store'));
    const n = mk({ stores: [], caps: ['team:manage'] });
    n.s.listTried = true;
    assert.strictEqual(fn(n, 'stoSection')(), '');
  });
  it('the line under the list no longer sends store details to the desktop', () => {
    assert.ok(!M.includes("'Payment keys are set on desktop.'"), 'X7 took printers out, and X10 payment keys');
    assert.ok(!M.includes("'Store details, printers and payment keys are set on desktop.'"));
  });
}

section('3 · editing a store saves itself');
{
  const open = () => { const h = mk(); h.CMD.stoOpen(7); return h; };
  it('the body is the desktop\'s _opsStoreBody, key for key and in its order', () => {
    const h = open();
    assert.ok(DESK_BODY_KEYS.length === 12, 'read the desktop body: ' + DESK_BODY_KEYS.join(','));
    assert.deepStrictEqual(plain(Object.keys(fn(h, 'stoBody')())), DESK_BODY_KEYS);
  });
  it('opens on the store\'s own values and sends nothing for opening it', async () => {
    const h = open();
    assert.strictEqual(h.ctx.state.stack[1].route, 'storeone');
    assert.deepStrictEqual(plain(fn(h, 'stoBody')()), {
      name_en: 'Roots — Tianhe', name_cn: 'Roots · 天河店', city: '广州', district: '天河区', address: '体育西路1号', phone: '020-1234',
      sort_order: 2, pickup_enabled: true, open_time: '09:00', close_time: '21:00', sync_start_time: null, low_stock_threshold: null });
    h.ctx.eng().flush(); await tick();
    assert.strictEqual(h.calls.writes.length, 0);
    const t = h.text(h.ctx.SUBS.storeone.render());
    for (const w of ['Code', 'tianhe', 'Name (English)', 'Name (中文)', 'Street address', 'Opens', 'Closes', 'Channel sync starts',
      'Sort priority', 'Low-stock alert at', 'Offer store pickup', 'GPS coordinates', 'GPS located', 'Stock staff', 'All changes saved', 'Version history']) {
      assert.ok(t.includes(w), w);
    }
    assert.strictEqual(h.ctx.SUBS.storeone.titleOf(), 'Roots — Tianhe');
  });
  it('an edit sends the whole body to the store, filed on its history card', async () => {
    const h = open();
    const before = h.calls.renders;
    h.CMD.stoText('name_en', '  Roots — Tianhe Park ');
    h.CMD.stoText('low_stock_threshold', '5');
    h.CMD.stoText('sync_start_time', '07:30');
    assert.strictEqual(h.calls.renders, before, 'typing repaints nothing');
    h.ctx.eng().flush(); await tick();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/stores/7?history=store.7'); assert.strictEqual(w.method, 'PATCH');
    assert.deepStrictEqual(w.keys, DESK_BODY_KEYS);
    assert.deepStrictEqual(w.body, {
      name_en: 'Roots — Tianhe Park', name_cn: 'Roots · 天河店', city: '广州', district: '天河区', address: '体育西路1号', phone: '020-1234',
      sort_order: 2, pickup_enabled: true, open_time: '09:00', close_time: '21:00', sync_start_time: '07:30', low_stock_threshold: 5 });
    w.res({ success: true, data: Object.assign({}, STORE, { name_en: 'Roots — Tianhe Park' }) }); await tick();
    assert.strictEqual(h.ctx.state.stores[0].name_en, 'Roots — Tianhe Park', 'the list follows the saved record');
    assert.ok(h.calls.timers.some((x) => x.ms === 2500), 'looks again for the located line');
  });
  it('blank clears: times to null, the low-stock line to null, the sort to 0; pickup is a switch', async () => {
    const h = open();
    h.CMD.stoText('open_time', ''); h.CMD.stoText('low_stock_threshold', ''); h.CMD.stoText('sort_order', '');
    h.CMD.stoPickup();
    h.ctx.eng().flush(); await tick();
    const b = h.calls.writes[0].body;
    assert.strictEqual(b.open_time, null); assert.strictEqual(b.low_stock_threshold, null);
    assert.strictEqual(b.sort_order, 0); assert.strictEqual(b.pickup_enabled, false);
  });
  it('city, district and address are sent when left, not on every key — they re-locate the store', () => {
    const h = open();
    const html = h.ctx.SUBS.storeone.render();
    for (const k of ['city', 'district', 'address']) assert.ok(html.includes(`onchange="APP.cmd('stoText','${k}',this.value)"`), k);
    assert.ok(html.includes(`oninput="APP.cmd('stoText','name_en',this.value)"`));
  });
  it('the code is fixed once a store exists', async () => {
    const h = open();
    h.CMD.stoText('code', 'other');
    assert.strictEqual(h.s.d.code, 'tianhe');
    assert.ok(!h.ctx.SUBS.storeone.render().includes(`'stoText','code'`));
  });
  it('a refusal stays at the foot in the server\'s words; a toast never reports it', async () => {
    const h = open();
    h.CMD.stoText('phone', '020-9999'); const p = h.ctx.eng().flush();
    h.calls.writes[0].rej(REFUSED()); await p;
    assert.ok(h.text(fn(h, 'stoFootHtml')()).includes('Save failed: You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('Undo sends the visit\'s first body back, filed as an undo', async () => {
    const h = open();
    h.CMD.stoText('phone', '020-9999'); h.ctx.eng().flush(); await tick();
    h.calls.writes[0].res({ success: true, data: STORE }); await tick();
    assert.ok(fn(h, 'stoFootHtml')().includes(`APP.cmd('stoUndo')`));
    h.CMD.stoUndo(); await tick();
    assert.strictEqual(h.calls.writes[1].p, '/stores/7?history=store.7&note=undo');
    assert.strictEqual(h.calls.writes[1].body.phone, '020-1234');
    assert.strictEqual(h.s.d.phone, '020-1234', 'the screen goes back too');
  });
  it('Version history reads the store\'s history and restores a version, filed as a restore', async () => {
    const h = open();
    h.CMD.stoHistory(); await tick();
    assert.strictEqual(h.calls.api[0].p, '/stores/7/history');
    h.calls.api[0].res({ success: true, versions: [{ id: 2, changed: ['phone', 'pickup_enabled'] },
      { id: 1, snapshot: Object.assign({}, STORE, { phone: '020-0000', pickup_enabled: false }) }] }); await tick();
    const sheet = h.calls.asks[0];
    assert.strictEqual(sheet.sub(sheet.list[0]), 'Phone · Offer store pickup');
    const done = sheet.restore(sheet.list[1]);
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/stores/7?history=store.7&note=restore');
    assert.strictEqual(w.body.phone, '020-0000'); assert.strictEqual(w.body.pickup_enabled, false);
    w.res({ success: true, data: STORE }); await done;
  });
  it('leaving the screen sends what is still waiting', () => {
    assert.ok(/if\(top==='storeone'\) stoFlush\(\);/.test(block(M, 'function pop()')));
    assert.ok(/if\(t&&t\.route==='storeone'\) stoFlush\(\);/.test(block(M, 'function layers()')));
  });
}

section('4 · the manual pin');
{
  const open = () => { const h = mk(); h.CMD.stoOpen(7); return h; };
  it('out-of-range or half-typed coordinates are refused in place, with nothing sent', () => {
    const h = open();
    h.CMD.stoPinIn('lat', '91'); h.CMD.stoPinIn('lng', '113'); h.CMD.stoPin();
    assert.strictEqual(String(h.s.pinErr), 'Invalid coordinates');
    h.CMD.stoPinIn('lat', '23'); h.CMD.stoPinIn('lng', ''); h.CMD.stoPin();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('Invalid coordinates'));
  });
  it('sends {lat,lng} alone to the store, without the history card, and says Saved', async () => {
    const h = open();
    h.CMD.stoPinIn('lat', '23.1519'); h.CMD.stoPinIn('lng', '113.4061'); h.CMD.stoPin();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/stores/7'); assert.strictEqual(w.method, 'PATCH');
    assert.deepStrictEqual(w.body, { lat: 23.1519, lng: 113.4061 });
    assert.ok(h.ctx.SUBS.storeone.render().includes('disabled'), 'the button waits');
    w.res({ success: true, data: Object.assign({}, STORE, { lat: 23.1519, lng: 113.4061 }) }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('23.151900, 113.406100'));
  });
  it('a refusal stays under the pin', async () => {
    const h = open();
    h.CMD.stoPinIn('lat', '23'); h.CMD.stoPinIn('lng', '113'); h.CMD.stoPin();
    h.calls.writes[0].rej(REFUSED()); await tick();
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('You don’t have permission for this'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('a store with no coordinates says how to get them', () => {
    const h = mk({ stores: [Object.assign({}, STORE, { lat: null, lng: null })] }); h.CMD.stoOpen(7);
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('no GPS — set a street address'));
  });
}

section('5 · adding a store');
{
  const fresh = (o) => { const h = mk(o); h.CMD.stoNew(); return h; };
  it('opens empty, with a code to fill, Save, and no engine', async () => {
    const h = fresh();
    assert.strictEqual(h.ctx.eng(), null);
    assert.strictEqual(h.ctx.SUBS.storeone.titleOf(), 'New store');
    const html = h.ctx.SUBS.storeone.render();
    assert.ok(html.includes(`'stoText','code'`) && h.text(html).includes('Save') && !h.text(html).includes('Version history'));
  });
  it('the code is required, and bad coordinates are refused, both in place', () => {
    const h = fresh();
    h.CMD.stoSave();
    assert.strictEqual(String(h.s.err), 'Code required');
    h.CMD.stoText('code', 'pudong'); h.CMD.stoPinIn('lat', 'abc'); h.CMD.stoPinIn('lng', '113'); h.CMD.stoSave();
    assert.strictEqual(String(h.s.err), 'Invalid coordinates');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('Invalid coordinates'));
  });
  it('POSTs the desktop body with the code; coordinates only when both are typed', async () => {
    const h = fresh();
    h.CMD.stoText('code', ' pudong '); h.CMD.stoText('name_en', 'Roots — Pudong'); h.CMD.stoText('city', '上海');
    h.CMD.stoPinIn('lat', '31.2'); h.CMD.stoSave();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/stores'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { name_en: 'Roots — Pudong', name_cn: '', city: '上海', district: '', address: '', phone: '',
      sort_order: 0, pickup_enabled: false, open_time: null, close_time: null, sync_start_time: null, low_stock_threshold: null, code: 'pudong' });
    assert.ok(!('lat' in w.body), 'never lat:null — that stops the address locating it');
    w.res({ success: true, data: { id: 9, code: 'pudong', is_active: 1 } }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.strictEqual(h.calls.pops, 1, 'back to Operations');
    assert.strictEqual(h.calls.api[0].p, '/stores', 'the list is read again');
  });
  it('with both coordinates they ride along', () => {
    const h = fresh();
    h.CMD.stoText('code', 'pudong'); h.CMD.stoPinIn('lat', '31.2304'); h.CMD.stoPinIn('lng', '121.4737'); h.CMD.stoSave();
    const b = h.calls.writes[0].body;
    assert.strictEqual(b.lat, 31.2304); assert.strictEqual(b.lng, 121.4737); assert.strictEqual(b.code, 'pudong');
  });
  it('a taken code, a refusal and a failure each stay on the screen', async () => {
    const h = fresh();
    h.CMD.stoText('code', 'tianhe'); h.CMD.stoSave();
    const e = new Error('code_taken'); e.code = 'code_taken'; h.calls.writes[0].rej(e); await tick();
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('That code is already used by another store.'));
    h.CMD.stoSave(); h.calls.writes[1].rej(REFUSED()); await tick();
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('You don’t have permission for this'));
    h.CMD.stoSave(); h.calls.writes[2].rej(new Error('HTTP 500')); await tick();
    assert.ok(h.text(h.ctx.SUBS.storeone.render()).includes('Failed: HTTP 500'));
    assert.deepStrictEqual(h.calls.toasts, []);
    assert.strictEqual(h.calls.pops, 0);
  });
}

section('6 · a store\'s stock staff');
{
  const STAFF = [{ id: 31, username: 'tianhe.stock', displayName: '张三', isActive: true },
    { id: 32, username: 'old.stock', displayName: 'Old', isActive: false }];
  async function opened(o, list) {
    const h = mk(o); h.CMD.stfOpen(7);
    h.ctx.SUBS.storestaff.render();
    assert.strictEqual(h.calls.api[0].p, '/api/backend/stores/7/staff');
    h.calls.api[0].res({ success: true, staff: list === undefined ? STAFF : list }); await tick();
    return h;
  }
  it('opens from the store, sending the store\'s pending edit first, and re-reads on every entry', async () => {
    const h = mk(); h.CMD.stoOpen(7); h.CMD.stoText('phone', '1'); h.CMD.stfOpen(7); await tick();
    assert.strictEqual(h.calls.writes[0].p, '/stores/7?history=store.7');
    assert.strictEqual(h.ctx.state.stack[2].route, 'storestaff');
    assert.ok(/route==='storestaff'\)\{ const s=state\.sto; s\.staffTried=false; s\.staff=null;/.test(block(M, 'function push(route)')));
  });
  it('lists the active ones only, with the desktop\'s line about what they can reach', async () => {
    const h = await opened();
    const t = h.text(h.ctx.SUBS.storestaff.render());
    assert.ok(t.includes('张三') && t.includes('tianhe.stock') && !t.includes('old.stock'));
    assert.ok(t.includes('These people can only open the Quick Stock app, and only for Roots — Tianhe — never another store.'));
    assert.ok(t.includes('Reset password') && t.includes('Remove') && t.includes('+ Add stock staff'));
    assert.strictEqual(h.ctx.SUBS.storestaff.titleOf(), 'Roots — Tianhe');
  });
  it('empty: the desktop\'s line', async () => {
    const h = await opened({}, []);
    assert.ok(h.text(h.ctx.SUBS.storestaff.render()).includes('No stock staff yet for this store.'));
  });
  it('a failed read says so, in the server\'s words, and offers Try again', async () => {
    const h = mk(); h.CMD.stfOpen(7); h.ctx.SUBS.storestaff.render();
    h.calls.api[0].rej(new Error('Bad store · 门店无效')); await tick();
    const t = h.text(h.ctx.SUBS.storestaff.render());
    assert.ok(t.includes('Failed to load staff: Bad store') && t.includes('Try again'));
    h.CMD.stfRetry(); h.ctx.SUBS.storestaff.render();
    assert.strictEqual(h.calls.api.length, 2);
  });
  it('adding checks the login and the password\'s length first, in place, as the desktop does', async () => {
    const h = await opened();
    h.CMD.stfIn('name', '李四'); h.CMD.stfAdd();
    assert.strictEqual(String(h.s.addErr), 'Login required');
    h.CMD.stfIn('user', 'li.si'); h.CMD.stfIn('pw', '123456789'); h.CMD.stfAdd();
    assert.strictEqual(String(h.s.addErr), 'Password must be at least 10 characters');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.ok(h.text(h.ctx.SUBS.storestaff.render()).includes('Password must be at least 10 characters'));
  });
  it('adding POSTs {display_name, username, password}, then reads the list again', async () => {
    const h = await opened();
    h.CMD.stfIn('name', ' 李四 '); h.CMD.stfIn('user', ' li.si '); h.CMD.stfIn('pw', ' 0123456789 '); h.CMD.stfAdd();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/api/backend/stores/7/staff'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { display_name: '李四', username: 'li.si', password: '0123456789' });
    assert.ok(h.ctx.SUBS.storestaff.render().includes('disabled'));
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Added']);
    assert.deepStrictEqual(plain(h.s.add), { name: '', user: '', pw: '' });
    assert.strictEqual(h.calls.api[1].p, '/api/backend/stores/7/staff');
  });
  it('a taken login stays under the form in the server\'s words', async () => {
    const h = await opened();
    h.CMD.stfIn('user', 'li.si'); h.CMD.stfIn('pw', '0123456789'); h.CMD.stfAdd();
    h.calls.writes[0].rej(new Error('That username is already taken · 该用户名已被占用')); await tick();
    assert.ok(h.text(h.ctx.SUBS.storestaff.render()).includes('Failed: That username is already taken'));
    h.ctx.LANG = 'zh';
    assert.ok(h.text(h.ctx.SUBS.storestaff.render()).includes('操作失败: 该用户名已被占用'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
  it('removing asks the desktop\'s question, then DELETEs the member', async () => {
    const h = await opened();
    h.CMD.stfRemove(31);
    assert.strictEqual(h.ctx.state.ask.title, 'Remove this stock staff member? They will lose access immediately.');
    assert.strictEqual(h.ctx.state.ask.danger, true);
    assert.strictEqual(h.calls.writes.length, 0, 'nothing before the confirm');
    h.ctx.state.ask.run();
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/api/backend/stores/7/staff/31'); assert.strictEqual(w.method, 'DELETE'); assert.strictEqual(w.body, null);
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Removed']);
    assert.strictEqual(h.calls.api[1].p, '/api/backend/stores/7/staff');
  });
  it('a refused remove stays on the screen', async () => {
    const h = await opened();
    h.CMD.stfRemove(31); h.ctx.state.ask.run();
    h.calls.writes[0].rej(REFUSED()); await tick();
    assert.ok(h.text(h.ctx.SUBS.storestaff.render()).includes('You don’t have permission for this'));
  });
  it('a new password is asked for, checked for length, and POSTed as {new_password}', async () => {
    const h = await opened();
    h.CMD.stfReset(31);
    const a = h.ctx.state.ask;
    assert.strictEqual(a.title, 'New password (at least 10 characters)');
    assert.strictEqual(a.validate({ pw: 'short' }), 'Password must be at least 10 characters');
    assert.strictEqual(a.validate({ pw: '0123456789' }), null);
    a.run({ pw: '0123456789' });
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/api/backend/stores/7/staff/31/password'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { new_password: '0123456789' });
    w.res({ success: true }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Password reset']);
  });
  it('nobody outside the list shown — unknown, or already removed — is offered a write', async () => {
    const h = await opened();
    h.CMD.stfRemove(99); h.CMD.stfReset(32); h.CMD.stfRemove(32);
    assert.strictEqual(h.ctx.state.ask, null);
    assert.strictEqual(h.calls.writes.length, 0);
  });
}

section('7 · team devices (§326.5)');
{
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const DEV = [
    { id: 'a', current: true, label: 'Chrome on Mac', kind: 'desktop', ip: '1.2.3.4', location: 'Guangzhou', lastSeen: ago(1000), createdAt: ago(1000), ownerName: 'Ash', isYou: true },
    { id: 'b', current: false, label: 'iPhone', kind: 'phone', ip: '5.6.7.8', location: null, lastSeen: ago(3 * 3600e3), createdAt: '2026-01-02 08:00:00', ownerName: 'Mei', isYou: false },
  ];
  async function opened(o, list) {
    const h = mk(o);
    h.ctx.SUBS.teamdevices.render();
    assert.strictEqual(h.calls.api[0].p, '/api/backend/sessions/team');
    h.calls.api[0].res({ sessions: list === undefined ? DEV.map((d) => Object.assign({}, d)) : list }); await tick();
    return h;
  }
  it('lists every device with whose it is, and re-reads on every entry', async () => {
    const h = await opened();
    const t = h.text(h.ctx.SUBS.teamdevices.render());
    assert.ok(t.includes('Every device your team is signed in on. Sign out anything that looks wrong.'));
    assert.ok(t.includes('Ash (You) · Chrome on Mac') && t.includes('This device') && t.includes('Active now'));
    assert.ok(t.includes('Mei · iPhone') && t.includes('3 hours ago') && t.includes('Phone') && t.includes('5.6.7.8'));
    assert.ok(t.includes('since D2026-01-02'), 'an old sign-in says since when');
    assert.ok(t.includes('Sign out of this device') && t.includes('2 devices signed in'));
    assert.ok(/route==='teamdevices'\)\{ const t=state\.tmd; t\.tried=false; t\.list=null;/.test(block(M, 'function push(route)')));
  });
  it('the filter is the desktop\'s three: All, Desktop, Mobile (phones and tablets)', async () => {
    const h = await opened();
    h.CMD.tmdKind('mobile');
    let t = h.text(h.ctx.SUBS.teamdevices.render());
    assert.ok(t.includes('iPhone') && !t.includes('Chrome on Mac') && t.includes('1 device signed in'));
    h.CMD.tmdKind('desktop'); t = h.text(h.ctx.SUBS.teamdevices.render());
    assert.ok(!t.includes('iPhone') && t.includes('Chrome on Mac'));
    h.CMD.tmdKind('nonsense'); assert.strictEqual(h.t.kind, 'desktop');
  });
  it('two empty states: nobody signed in, and nothing matching the filter', async () => {
    const h = await opened({}, []);
    assert.ok(h.text(h.ctx.SUBS.teamdevices.render()).includes('No devices signed in.'));
    const f = await opened({}, [DEV[0]]); f.CMD.tmdKind('mobile');
    assert.ok(f.text(f.ctx.SUBS.teamdevices.render()).includes('No devices match this filter.'));
  });
  it('a failed read says the desktop\'s line; a refusal says why', async () => {
    const h = mk(); h.ctx.SUBS.teamdevices.render();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    let t = h.text(h.ctx.SUBS.teamdevices.render());
    assert.ok(t.includes('Couldn’t load devices.') && t.includes('Try again'));
    h.CMD.tmdRetry(); h.ctx.SUBS.teamdevices.render();
    h.calls.api[1].rej(REFUSED()); await tick();
    t = h.text(h.ctx.SUBS.teamdevices.render());
    assert.ok(t.includes('You don’t have permission for this'));
  });
  it('signing out a teammate\'s device POSTs {sid} and drops the row', async () => {
    const h = await opened();
    h.CMD.tmdOut('b');
    assert.strictEqual(h.ctx.state.ask, null, 'no confirm for another device, as on desktop');
    const w = h.calls.writes[0];
    assert.strictEqual(w.p, '/api/backend/sessions/revoke'); assert.strictEqual(w.method, 'POST');
    assert.deepStrictEqual(w.body, { sid: 'b' });
    assert.ok(h.text(h.ctx.SUBS.teamdevices.render()).includes('Signing out…'));
    w.res({ success: true, wasCurrent: false }); await tick();
    assert.ok(!h.text(h.ctx.SUBS.teamdevices.render()).includes('iPhone'));
    assert.strictEqual(h.ctx.location.href, '');
  });
  it('signing out this device asks first, then goes to the sign-in page', async () => {
    const h = await opened();
    h.CMD.tmdOut('a');
    assert.strictEqual(h.calls.writes.length, 0);
    assert.strictEqual(h.ctx.state.ask.title, 'Sign out of this device?');
    assert.strictEqual(h.ctx.state.ask.body, 'You’ll be returned to the login page.');
    assert.strictEqual(h.ctx.state.ask.confirmLabel, 'Sign out');
    h.ctx.state.ask.run();
    assert.deepStrictEqual(h.calls.writes[0].body, { sid: 'a' });
    h.calls.writes[0].res({ success: true, wasCurrent: true }); await tick();
    assert.strictEqual(h.ctx.location.href, '/backend/login');
  });
  it('a failure stays on the screen in the server\'s words, in the reader\'s language', async () => {
    const h = await opened();
    h.CMD.tmdOut('b'); h.calls.writes[0].rej(new Error('Session not found · 未找到会话')); await tick();
    assert.ok(h.text(h.ctx.SUBS.teamdevices.render()).includes('Session not found'));
    h.ctx.LANG = 'zh';
    assert.ok(h.text(h.ctx.SUBS.teamdevices.render()).includes('未找到会话'));
    assert.deepStrictEqual(h.calls.toasts, []);
  });
}

section('8 · in Chinese');
{
  it('the store, the staff and the devices read in Chinese', async () => {
    const h = mk({ lang: 'zh' }); h.CMD.stoOpen(7);
    const t = h.text(h.ctx.SUBS.storeone.render());
    for (const w of ['短标识', '名称(英文)', '详细地址', '开门', '关门', '渠道同步开始', '排序', '低库存提醒', '到店自提', '经纬度', '已定位', '库存员', '历史版本']) assert.ok(t.includes(w), w);
    const n = mk({ lang: 'zh' }); n.CMD.stoNew();
    assert.strictEqual(n.ctx.SUBS.storeone.titleOf(), '新建门店');
    n.CMD.stoSave(); assert.strictEqual(String(n.s.err), '请填写编号');
    const ops = n.text(fn(n, 'stoSection')());
    assert.ok(ops.includes('门店') && ops.includes('编辑') && ops.includes('添加门店'));
    const d = mk({ lang: 'zh' }); d.ctx.SUBS.teamdevices.render(); d.calls.api[0].res({ sessions: [] }); await tick();
    const dt = d.text(d.ctx.SUBS.teamdevices.render());
    assert.ok(dt.includes('团队所有已登录的设备。如发现异常，请将其登出。') && dt.includes('没有已登录的设备。') && dt.includes('移动'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
