#!/usr/bin/env node
/**
 * §325 X2 — WHAT THE DESKTOP'S SETTINGS → OPERATIONS TURNS ON AND OFF, ON THE PHONE.
 *
 *   node scripts/test_mobile_settings_operations.js
 *
 * The phone gains the desktop Operations panel's writes it did not have:
 *   • the three feature switches the desktop hosts there (Production, Waste,
 *     Running low here), in Settings → Features beside the other six;
 *   • the low-stock default and the daily low-stock list (switch and hour);
 *   • the Support button's show/hide;
 *   • "Geocode all stores & addresses now", behind the desktop's confirm;
 *   • Recently deleted, with Put it back.
 *
 * The phone code is RUN, sliced out of public/m.html into a sandbox with a fake
 * server; every write is asserted on its method, path and every body field.
 * The desktop modules are the spec and their strings are sliced and compared.
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
const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

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

const SRC = [
  line(M, 'function E(en, zh)'),
  block(M, 'function toggle('),
  line(M, 'const cfgGet='),
  slice(M, 'const FEATURE_CATALOG=[', '/* Entitled, or not on the list.'),
  line(M, 'function featOn(key)'),
  block(M, 'function toggleFeature(key)'),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X2 — WHAT THE DESKTOP', '/* §325 X2 ends */'),
].join('\n');

const SETTINGS = ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config'];

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], renders: 0, geoLoads: 0 };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    DB: { coupons: [] },
    state: {
      caps: opts.caps === undefined ? SETTINGS.concat(opts.extra || []) : opts.caps,
      cfg: opts.cfg === undefined ? {} : opts.cfg, ask: null, featBusy: null, featErr: null,
      zones: null, sw: {}, geoTried: true,
      opsx: { busy: null, err: null, geoBusy: false, geoErr: null, bin: null, binDays: 60, binTried: false, binErr: null, binBusy: null, binRowErr: {} },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn2: null,
    loadGeo: () => { calls.geoLoads++; },
    mapVoucher: (r) => ({ code: r.code, on: !!r.is_active }),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: JSON.parse(JSON.stringify(body)), method: method || 'POST', res, rej });
    }),
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.FEATURE_CATALOG=FEATURE_CATALOG;this.ROUTE_CAP=ROUTE_CAP;').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, x: ctx.state.opsx };
}
const tick = () => new Promise((r) => setImmediate(r));
async function ok(h, i, data) { h.calls.writes[i].res(data || { success: true }); await tick(); }
async function no(h, i, code, msg) { const e = new Error(msg || code || 'HTTP 500'); e.code = code; h.calls.writes[i].rej(e); await tick(); }
const w = (h, i) => ({ p: h.calls.writes[i].p, method: h.calls.writes[i].method, body: h.calls.writes[i].body });

// ─────────────────────────────────────────────────────────────────────────
section('1 · the three feature switches');
{
  // The desktop's descOff, split at its " · ".
  const deskOff = (key) => {
    const s = slice(OPS, `{ key: '${key}'`, '},');
    const m = s.match(/descOff:\s+'((?:[^'\\]|\\.)*)'/);
    assert.ok(m, 'no descOff for ' + key);
    const t = m[1].replace(/\\'/g, "'");
    const i = t.indexOf(' · ');
    return [t.slice(0, i), t.slice(i + 3)];
  };
  for (const [key, en, zh] of [['production', 'Production', '生产'], ['waste', 'Waste', '损耗'], ['lowStockHints', 'Running low here', '此门店库存偏低']]) {
    it(`${key}: the desktop's name and its own off-state sentence`, () => {
      const f = mk().ctx.FEATURE_CATALOG.find((x) => x.key === key);
      assert.ok(f, key + ' is not on the phone');
      assert.strictEqual(f.en, en); assert.strictEqual(f.zh, zh);
      const [offEn, offZh] = deskOff(key);
      assert.strictEqual(f.offEn, offEn); assert.strictEqual(f.offZh, offZh);
    });
  }
  it('the six that were there are still there, and now nine in all', () => {
    const keys = mk().ctx.FEATURE_CATALOG.map((f) => f.key);
    assert.deepStrictEqual([...keys], ['membership', 'affiliate', 'reviews', 'feedback', 'socialProof', 'faq', 'production', 'waste', 'lowStockHints']);
  });
  it('turning one off is the desktop\'s write: PUT /config, features.<key>', async () => {
    const h = mk();
    h.ctx.toggleFeature('waste');
    assert.deepStrictEqual(w(h, 0), { p: '/config', method: 'PUT', body: { 'features.waste': false } });
    await ok(h, 0);
    assert.strictEqual(h.ctx.state.cfg.features.waste, false);
    h.ctx.toggleFeature('lowStockHints');
    assert.deepStrictEqual(w(h, 1).body, { 'features.lowStockHints': false });
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · the low-stock default');
{
  it('shows the stored number, or the desktop\'s default of 5', () => {
    assert.ok(/value="7"/.test(mk({ cfg: { inventory: { lowStockThreshold: 7 } } }).ctx.opsxLowCard()));
    assert.ok(/value="5"/.test(mk().ctx.opsxLowCard()));
    assert.ok(/value="5"/.test(mk({ cfg: { inventory: { lowStockThreshold: 'x' } } }).ctx.opsxLowCard()));
  });
  it('a change saves the whole number, floored at zero', async () => {
    const h = mk();
    h.CMD.lowStockSet('12');
    assert.deepStrictEqual(w(h, 0), { p: '/config', method: 'PUT', body: { 'inventory.lowStockThreshold': 12 } });
    assert.ok(/Saving…/.test(h.text(h.ctx.opsxLowCard())), 'the control says what it is doing');
    h.CMD.lowStockSet('13');
    assert.strictEqual(h.calls.writes.length, 1, 'one save at a time');
    await ok(h, 0);
    assert.strictEqual(h.ctx.state.cfg.inventory.lowStockThreshold, 12);
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    h.CMD.lowStockSet('-4'); assert.strictEqual(w(h, 1).body['inventory.lowStockThreshold'], 0);
  });
  it('a refusal stays on the card and the number does not move', async () => {
    const h = mk({ cfg: { inventory: { lowStockThreshold: 7 } } });
    h.CMD.lowStockSet('9');
    await no(h, 0);
    const t = h.text(h.ctx.opsxLowCard());
    assert.ok(t.includes('That did not save. The setting is unchanged.'));
    assert.strictEqual(h.ctx.state.cfg.inventory.lowStockThreshold, 7);
    assert.deepStrictEqual(h.calls.toasts, [], 'a toast never reports failure');
  });
  it('a permission refusal says the server\'s reason, not "did not save" (§331)', async () => {
    const h = mk();
    h.CMD.lowStockSet('4');
    const e = new Error('refused'); e.refused = true; e.words = ['You do not have permission for this.', '你没有此操作的权限。'];
    h.calls.writes[0].rej(e); await tick();
    assert.ok(h.text(h.ctx.opsxLowCard()).includes('You do not have permission for this.'));
    const g = mk(); g.CMD.geoBackfill(); g.ctx.state.ask.run();
    g.calls.writes[0].rej(e); await tick();
    assert.ok(g.text(g.ctx.opsxGeoAction()).includes('You do not have permission for this.'));
  });
}

section('3 · the daily low-stock list');
{
  it('on at 09:00 until the account says otherwise', () => {
    const h = mk();
    const html = h.ctx.opsxLowCard();
    assert.ok(/<option value="9" selected>09:00<\/option>/.test(html));
    assert.ok(h.text(html).includes('Send me a daily list of what is running low'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.ctx.opsxDigest())), { enabled: true, hour: 9 });
  });
  it('the switch writes the pair, with the hour it already had', async () => {
    const h = mk({ cfg: { inventory: { lowStockDigest: { enabled: true, hour: 7 } } } });
    h.CMD.lowDigestToggle();
    assert.deepStrictEqual(w(h, 0), { p: '/config', method: 'PUT', body: { 'inventory.lowStockDigest': { enabled: false, hour: 7 } } });
    await ok(h, 0);
    assert.deepStrictEqual(h.calls.toasts, ['Turned off']);
    assert.strictEqual(h.ctx.state.cfg.inventory.lowStockDigest.enabled, false);
  });
  it('the hour writes the pair with the switch as it is; midnight is an hour', () => {
    const h = mk({ cfg: { inventory: { lowStockDigest: { enabled: false, hour: 7 } } } });
    h.CMD.lowDigestHour('0');
    assert.deepStrictEqual(w(h, 0).body, { 'inventory.lowStockDigest': { enabled: false, hour: 0 } });
    const g = mk(); g.CMD.lowDigestHour('24'); g.CMD.lowDigestHour('x');
    assert.strictEqual(g.calls.writes.length, 0, 'no hour outside the day is sent');
  });
  it('the desktop\'s sentence about who gets it, in both languages', () => {
    const desk = HTML.slice(HTML.indexOf('One message a day, naming'), HTML.indexOf('</div>', HTML.indexOf('One message a day, naming'))).trim();
    const [en, zh] = desk.split(' · ');
    assert.ok(mk().text(mk().ctx.opsxLowCard()).includes(en.trim()));
    assert.ok(mk({ lang: 'zh' }).text(mk({ lang: 'zh' }).ctx.opsxLowCard()).includes(zh.trim()));
  });
}

section('4 · the Support button');
{
  it('shown unless hidden; the switch writes support.hidden', async () => {
    const h = mk();
    assert.ok(h.text(h.ctx.opsxSupportCard()).includes('Show the Support button'));
    h.CMD.supportToggle();
    assert.deepStrictEqual(w(h, 0), { p: '/config', method: 'PUT', body: { 'support.hidden': true } });
    await ok(h, 0);
    assert.strictEqual(h.ctx.state.cfg.support.hidden, true);
    h.CMD.supportToggle();
    assert.deepStrictEqual(w(h, 1).body, { 'support.hidden': false });
  });
}

section('5 · who gets the controls');
{
  it('exactly the Settings screen\'s keys', () => {
    assert.deepStrictEqual([...mk().ctx.ROUTE_CAP.settings], SETTINGS);
  });
  it('an account holding none of them gets no card and no write', () => {
    const h = mk({ caps: ['orders:view', 'delivery:edit'] });
    assert.strictEqual(h.ctx.opsxLowCard(), '');
    assert.strictEqual(h.ctx.opsxSupportCard(), '');
    assert.strictEqual(h.ctx.opsxGeoAction(), '');
    assert.strictEqual(h.ctx.opsxBinCard(), '');
    h.CMD.lowStockSet('3'); h.CMD.supportToggle(); h.CMD.lowDigestToggle(); h.CMD.geoBackfill();
    assert.strictEqual(h.calls.writes.length, 0);
    assert.strictEqual(h.ctx.state.ask, null);
    assert.strictEqual(h.calls.api.length, 0, 'not even the list is read');
  });
  it('the Operations screen draws all four, and re-reads the list on every entry', () => {
    const ops = block(M, 'function screenOperations(){');
    for (const f of ['opsxGeoAction()', 'opsxLowCard()', 'opsxSupportCard()', 'opsxBinCard()']) assert.ok(ops.includes(f), f);
    assert.ok(/route==='operations'\)\{ const x=state\.opsx; x\.binTried=false;/.test(block(M, 'function push(route)')));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('6 · locating every store and address');
{
  it('asks first, with the desktop\'s question, and sends nothing until confirmed', () => {
    const h = mk();
    h.CMD.geoBackfill();
    assert.strictEqual(h.ctx.state.ask.title, 'Geocode all stores + customer addresses now? Uses your maps quota.');
    assert.strictEqual(h.ctx.state.ask.confirmLabel, 'Geocode now');
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('confirmed: the desktop\'s POST, the button says it is working, and the counts are re-read', async () => {
    const h = mk();
    h.CMD.geoBackfill(); h.ctx.state.ask.run();
    assert.deepStrictEqual(w(h, 0), { p: '/inventory/geocode-backfill', method: 'POST', body: {} });
    assert.ok(/Geocoding…/.test(h.text(h.ctx.opsxGeoAction())));
    assert.ok(/disabled/.test(h.ctx.opsxGeoAction()));
    await ok(h, 0, { success: true, data: { stores_geocoded: 2, stores_total: 3, addresses_geocoded: 40, addresses_total: 41 } });
    assert.deepStrictEqual(h.calls.toasts, ['Geocoded 2/3 stores · 40/41 addresses']);
    assert.strictEqual(h.calls.geoLoads, 1);
    assert.strictEqual(h.ctx.state.geoTried, false, 're-armed so the counts are read again');
  });
  it('two answers that arrive as success and are not: said where the button is, and kept', async () => {
    const q = mk(); q.CMD.geoBackfill(); q.ctx.state.ask.run();
    await ok(q, 0, { success: true, data: { aborted_on_quota: true, stores_geocoded: 0, stores_total: 1, addresses_geocoded: 0, addresses_total: 9 } });
    assert.ok(q.text(q.ctx.opsxGeoAction()).includes('Daily map quota exhausted — geocoding stopped.'));
    assert.deepStrictEqual(q.calls.toasts, []);
    const a = mk(); a.CMD.geoBackfill(); a.ctx.state.ask.run();
    await ok(a, 0, { success: true, data: { stores_geocoded: 0, stores_total: 0, addresses_geocoded: 0, addresses_total: 4, last_error: { code: 'INVALID_USER_KEY', message: 'key not valid' } } });
    assert.ok(a.text(a.ctx.opsxGeoAction()).includes('Could not geocode addresses: key not valid'));
  });
  it('no key, and any other refusal', async () => {
    const k = mk(); k.CMD.geoBackfill(); k.ctx.state.ask.run();
    await no(k, 0, 'tencent_maps_key_missing');
    assert.ok(k.text(k.ctx.opsxGeoAction()).includes('Set AMAP_MAPS_KEY or TENCENT_MAPS_KEY in /root/roots-v2/.env first'));
    const o = mk({ lang: 'zh' }); o.CMD.geoBackfill(); o.ctx.state.ask.run();
    await no(o, 0, null, 'HTTP 500');
    assert.ok(o.text(o.ctx.opsxGeoAction()).includes('操作失败: HTTP 500'));
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('7 · recently deleted');
{
  const BIN = [
    { id: 7, kind: 'delivery_zone', record_id: 3, label: '天河区', kindEn: 'Delivery zone', kindCn: '配送区', deleted_at: '2026-09-29 10:00:00', deleted_by: 'mia' },
    { id: 8, kind: 'finance_out', record_id: 44, label: '2026-09-28 · Rent', kindEn: 'Money out', kindCn: '支出', deleted_at: '2026-09-28 10:00:00', deleted_by: null },
    { id: 9, kind: 'voucher', record_id: 5, label: 'WELCOME10', kindEn: 'Coupon', kindCn: '优惠券', deleted_at: '2026-09-27 10:00:00', deleted_by: 'ash' },
  ];
  async function loaded(opts) {
    const h = mk(opts);
    h.ctx.opsxBinCard();
    assert.strictEqual(h.calls.api[0].p, '/deleted');
    h.calls.api[0].res({ success: true, data: BIN, days: 60 }); await tick();
    return h;
  }
  it('reads once, says Loading, then lists what was removed, by whom and when', async () => {
    const h = mk();
    assert.ok(/Loading…/.test(h.text(h.ctx.opsxBinCard())));
    h.ctx.opsxBinCard();
    assert.strictEqual(h.calls.api.length, 1);
    h.calls.api[0].res({ success: true, data: BIN, days: 60 }); await tick();
    const t = h.text(h.ctx.opsxBinCard());
    assert.ok(t.includes('天河区 Delivery zone · 2026-09-29 10:00:00 · mia'), t);
    assert.ok(t.includes('2026-09-28 · Rent Money out'));
    assert.ok(t.includes('Coupons, delivery zones, ledger rows and draft purchase orders removed in the last 60 days can be put back.'));
  });
  it('nothing deleted, and a failed read, each say so', async () => {
    const e = mk(); e.ctx.opsxBinCard();
    e.calls.api[0].res({ success: true, data: [], days: 60 }); await tick();
    assert.ok(e.text(e.ctx.opsxBinCard()).includes('Nothing has been deleted in the last 60 days.'));
    const f = mk(); f.ctx.opsxBinCard();
    f.calls.api[0].rej(new Error('HTTP 500')); await tick();
    assert.ok(f.text(f.ctx.opsxBinCard()).includes('Could not read what was deleted'));
    f.CMD.binRetry();
    assert.strictEqual(f.calls.api.length, 2);
  });
  it('Put it back is drawn for whoever may make the deletion it undoes', async () => {
    const zoneOnly = await loaded({ extra: ['delivery:edit'] });
    const html = zoneOnly.ctx.opsxBinCard();
    assert.ok(/APP\.cmd\('binRestore',7\)/.test(html));
    assert.ok(!/APP\.cmd\('binRestore',8\)/.test(html), 'a ledger row needs finance:record');
    assert.ok(!/APP\.cmd\('binRestore',9\)/.test(html), 'a coupon needs a coupon key');
    const all = await loaded({ extra: ['delivery:edit', 'finance:record', 'coupons:delete'] });
    const html2 = all.ctx.opsxBinCard();
    for (const id of [7, 8, 9]) assert.ok(new RegExp(`APP\\.cmd\\('binRestore',${id}\\)`).test(html2), 'row ' + id);
  });
  it('unknown permissions: the money row fails closed, the others stay open', async () => {
    const h = await loaded({ caps: null });
    const html = h.ctx.opsxBinCard();
    assert.ok(/binRestore',7/.test(html) && /binRestore',9/.test(html));
    assert.ok(!/binRestore',8/.test(html));
  });
  it('putting one back is the desktop\'s POST, unconfirmed, and the lists re-read', async () => {
    const h = await loaded({ extra: ['delivery:edit'] });
    h.CMD.binRestore(7);
    assert.strictEqual(h.ctx.state.ask, null, 'the reversible direction is not confirmed');
    assert.deepStrictEqual(w(h, 0), { p: '/deleted/7/restore', method: 'POST', body: {} });
    assert.ok(/Saving…/.test(h.text(h.ctx.opsxBinCard())));
    await ok(h, 0, { success: true, kind: 'delivery_zone', record_id: 3 });
    assert.deepStrictEqual(h.calls.toasts, ['Put back']);
    assert.deepStrictEqual(h.calls.api.slice(1).map((c) => c.p).sort(), ['/deleted', '/delivery-zones']);
  });
  it('a row this account may not put back sends nothing even if asked', async () => {
    const h = await loaded({ extra: ['delivery:edit'] });
    h.CMD.binRestore(8);
    assert.strictEqual(h.calls.writes.length, 0);
  });
  it('the two refusals an operator can act on get their own sentence, on the row', async () => {
    const t = await loaded({ extra: ['delivery:edit'] });
    t.CMD.binRestore(7); await no(t, 0, 'taken');
    t.calls.api.at(-1).res({ success: true, data: BIN, days: 60 }); await tick();
    assert.ok(t.text(t.ctx.opsxBinCard()).includes('Something else now uses that record’s place. It cannot be put back.'));
    assert.deepStrictEqual(t.calls.toasts, []);
    const g = await loaded({ extra: ['coupons:edit'] });
    g.CMD.binRestore(9); await no(g, 0, 'gone');
    assert.ok(g.text(g.ctx.opsxBinCard()).includes('The record itself is no longer here'));
    const o = await loaded({ extra: ['coupons:edit'], lang: 'zh' });
    o.CMD.binRestore(9); await no(o, 0, 'already_restored', 'already_restored');
    assert.ok(o.text(o.ctx.opsxBinCard()).includes('恢复失败: already_restored'));
  });
  it('a coupon put back refreshes the coupon list', async () => {
    const h = await loaded({ extra: ['coupons:edit'] });
    h.CMD.binRestore(9); await ok(h, 0);
    assert.ok(h.calls.api.some((c) => c.p === '/vouchers'));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
