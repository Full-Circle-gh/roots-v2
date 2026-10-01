#!/usr/bin/env node
/**
 * §325 step S2c — A WHOLE-STRUCTURE SAVE FROM A STALE COPY IS REFUSED.
 *
 *   node scripts/test_whole_save_versions.js
 *
 * The parity survey's defect 11. Two saves replace a whole structure from the
 * copy a screen loaded:
 *   • PUT /category-tree — the phone's category banner saves the WHOLE tree,
 *     so a phone that loaded it before a desktop rename puts the old name
 *     back, and reverting a rename re-tags the products a second time;
 *   • PUT /config {popups.list} — the phone's pop-up switch sends every
 *     pop-up, so one added or edited on the desktop meanwhile disappears.
 *
 * Each now has an optimistic version: the screen sends what it loaded, and a
 * save from a copy that has moved is refused with 409 and what is there now.
 * A caller that sends no version is not checked — the desktop is unchanged.
 *
 * Part A runs the real routes/retail.js over a scratch database. Part B runs
 * the phone's own code, sliced out of public/m.html, against the server's
 * answers, and asserts every request it sends.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router = require(path.join(ROOT, 'routes', 'retail.js'));
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);
const HEX16 = /^[0-9a-f]{16}$/;

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
            VALUES (7501, ?, '__s2c_owner', 'x', 'owner', 1)`).run(TENANT);
const P = (id, name, top) => db.prepare(
  'INSERT INTO store_products (id, name_en, sku, top_category, is_active) VALUES (?,?,?,?,1)').run(id, name, 'S2C-' + id, top);

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: 7501 }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, p, body) => {
    const r = await fetch(base + '/api/retail-admin' + p, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const topOf = (id) => db.prepare('SELECT top_category AS t FROM store_products WHERE id = ?').get(id).t;
  const storedPopups = () => { const r = db.prepare("SELECT value_json FROM storefront_config WHERE key='popups.list'").get(); return r ? JSON.parse(r.value_json) : null; };

  try {
    section('A1 · the category tree');
    let r = await call('PUT', '/category-tree', { tree: [
      { id: 'ready', name: 'Ready to Eat', subs: [] }, { id: 'fresh', name: 'Fresh & Deli', subs: [] }] });
    is(r.status, 200, 'a save without a version works, as the desktop\'s always has');
    ok(HEX16.test(r.body.version), 'and answers with the new version');
    P(9101, 'Hummus', 'Ready to Eat');
    let g = await call('GET', '/category-tree');
    const phoneLoaded = g.body.version;
    ok(Array.isArray(g.body.data) && HEX16.test(phoneLoaded), 'GET hands out the tree and its version, beside data');
    is(phoneLoaded, r.body.version, 'the version a save returns is the one a read returns');

    // The desktop renames a category while the phone has the tree open.
    r = await call('PUT', '/category-tree', { tree: [
      { id: 'ready', name: 'Ready Meals', subs: [] }, { id: 'fresh', name: 'Fresh & Deli', subs: [] }] });
    is(r.status, 200, 'the desktop renames Ready to Eat → Ready Meals (no version: not checked)');
    is(topOf(9101), 'Ready Meals', 'and the rename re-tags its product');
    ok(r.body.version !== phoneLoaded, 'the version moved');

    // The phone saves a banner on its stale copy.
    const stale = [{ id: 'ready', name: 'Ready to Eat', subs: [], banner: { image_url: '/x.jpg' } }, { id: 'fresh', name: 'Fresh & Deli', subs: [] }];
    r = await call('PUT', '/category-tree', { tree: stale, version: phoneLoaded });
    is(r.status, 409, 'the phone\'s save from the stale copy is refused');
    is(r.body.error, 'stale_tree', '…as stale_tree');
    is(r.body.data.map((t) => t.name), ['Ready Meals', 'Fresh & Deli'], '…with the tree as it is now');
    g = await call('GET', '/category-tree');
    is(r.body.version, g.body.version, '…and its current version');
    is(g.body.data[0].name, 'Ready Meals', 'the desktop\'s rename stands');
    is(topOf(9101), 'Ready Meals', 'and the product was not re-tagged back');
    ok(!g.body.data[0].banner, 'nothing from the refused body was written');

    // Reloaded, the phone saves again with the current version.
    const fresh = g.body.data.map((t) => ({ ...t })); fresh[0].banner = { image_url: '/x.jpg' };
    r = await call('PUT', '/category-tree', { tree: fresh, version: g.body.version });
    is(r.status, 200, 'with the current version, the same change saves');
    g = await call('GET', '/category-tree');
    is(g.body.data[0].banner && g.body.data[0].banner.image_url, '/x.jpg', 'the banner is on the renamed category');
    is(g.body.data[0].name, 'Ready Meals', 'and the rename survived');
    r = await call('PUT', '/category-tree', { tree: fresh, version: 12 });
    is(r.status, 200, 'a version that is not a string is no version (not checked)');

    section('A2 · the pop-ups list');
    const list0 = [{ id: 'p1', name: 'Autumn', enabled: true }];
    r = await call('PUT', '/config', { 'popups.list': list0 });
    is(r.status, 200, 'a save without expect works, as the desktop\'s always has');
    const v0 = r.body.data._versions && r.body.data._versions['popups.list'];
    ok(HEX16.test(v0), 'and the answer carries the list\'s version in _versions');
    g = await call('GET', '/config');
    is(g.body.data._versions['popups.list'], v0, 'GET /config hands out the same version');

    // The desktop adds a pop-up while the phone has the list open.
    const list1 = [...list0, { id: 'p2', name: 'Winter', enabled: false }];
    r = await call('PUT', '/config', { 'popups.list': list1 });
    is(r.status, 200, 'the desktop adds a pop-up');

    // The phone switches p1 off on its stale copy (which lacks p2).
    const phoneOut = [{ id: 'p1', name: 'Autumn', enabled: false }];
    r = await call('PUT', '/config?expect=' + encodeURIComponent('popups.list:' + v0), { 'popups.list': phoneOut, 'shop.layout': 'grid' });
    is(r.status, 409, 'the phone\'s switch on the stale list is refused');
    is([r.body.error, r.body.key], ['stale_config', 'popups.list'], '…as stale_config, naming the key');
    is(r.body.value, list1, '…with the list as it is now');
    ok(HEX16.test(r.body.version) && r.body.version !== v0, '…and its current version');
    is(storedPopups(), list1, 'the desktop\'s new pop-up is still there');
    ok(!db.prepare("SELECT 1 FROM storefront_config WHERE key='shop.layout'").get(), 'nothing else in the refused body was written either');

    const retry = list1.map((p) => (p.id === 'p1' ? { ...p, enabled: false } : p));
    r = await call('PUT', '/config?expect=' + encodeURIComponent('popups.list:' + r.body.version), { 'popups.list': retry });
    is(r.status, 200, 'with the version the refusal handed back, the switch saves');
    is(storedPopups(), retry, 'p1 off, p2 kept');
    r = await call('PUT', '/config?expect=popups.list:nothex', { 'popups.list': retry });
    is(r.status, 400, 'a malformed expect is refused, not ignored');
    is(r.body.error, 'bad_expect', '…as bad_expect');
    r = await call('PUT', '/config?expect=' + encodeURIComponent('popups.list:' + '0'.repeat(16)), { 'popups.list': [] });
    is(r.status, 409, 'a version the server never handed out is refused');
    const emptyV = require('crypto').createHash('sha1').update('').digest('hex').slice(0, 16);
    r = await call('PUT', '/config?expect=' + encodeURIComponent('zz_never.written:' + emptyV), { 'popups.list': retry });
    is(r.status, 200, 'a key never written has the empty value\'s version, so a first save can expect it');
  } finally {
    server.close();
  }

  section('B1 · the phone loads the tree\'s version and sends it back');
  {
    const a = M.indexOf('function loadCategories(){');
    const b = M.indexOf('const catCount=');
    ok(a > 0 && b > a, 'loadCategories is where it was');
    const ctx = {
      state: { catsTried: false }, render: () => {}, E: (en) => en,
      apiRaw: async (p) => (p === '/category-tree' ? { success: true, data: [{ id: 'ready', name: 'R' }], version: 'aaaaaaaaaaaaaaaa' } : { counts: {} }),
      Promise, Array, String,
    };
    vm.createContext(ctx); vm.runInContext(M.slice(a, b), ctx);
    ctx.loadCategories();
    await new Promise((r2) => setImmediate(r2));
    is(ctx.state.cats, [{ id: 'ready', name: 'R' }], 'the tree is read from data');
    is(ctx.state.catsVersion, 'aaaaaaaaaaaaaaaa', 'and its version is kept');
    ok(/catsVersion:null,/.test(M), 'catsVersion is declared in state');
  }

  section('B2 · the phone\'s pop-up switch');
  {
    const a = M.indexOf("reg('togglePopup', id=>{");
    const b = M.indexOf("reg('affSeg'");
    ok(a > 0 && b > a, 'togglePopup is where it was');
    const staleA = M.indexOf('const staleSaveText=');
    const staleSrc = M.slice(staleA, M.indexOf(';', M.indexOf("'该记录", staleA)) + 1);
    function run(answer) {
      const sent = [], toasts = [];
      const CMD = {};
      const ctx = {
        state: { cfg: { popups: { list: [{ id: 'p1', enabled: true }] }, _versions: { 'popups.list': 'bbbbbbbbbbbbbbbb' } }, puBusy: null, puErr: null },
        T: (en) => en, E: (en) => ({ toString: () => en }), render: () => {}, showToast: (m) => toasts.push(m),
        reg: (n, f) => { CMD[n] = f; },
        cfgGet: (k, d) => k.split('.').reduce((o, x) => (o && o[x] !== undefined ? o[x] : undefined), ctx.state.cfg) ?? d,
        apiWrite: async (p, body, method) => { sent.push({ p, body: JSON.parse(JSON.stringify(body)), method }); return answer(); },
        encodeURIComponent, Object, Array, String, Date, JSON, Promise,
      };
      vm.createContext(ctx); vm.runInContext(staleSrc + '\n' + M.slice(a, b), ctx);
      return { ctx, CMD, sent, toasts };
    }
    const okRun = run(() => ({ success: true, data: { _versions: { 'popups.list': 'cccccccccccccccc' } } }));
    okRun.CMD.togglePopup('p1');
    await new Promise((r2) => setImmediate(r2));
    is(okRun.sent.length, 1, 'one request');
    is(okRun.sent[0].p, '/config?expect=popups.list%3Abbbbbbbbbbbbbbbb', 'PUT /config, expecting the version the list was loaded at');
    is(okRun.sent[0].method, 'PUT', '…as a PUT');
    is(Object.keys(okRun.sent[0].body), ['popups.list'], '…carrying the list and nothing else');
    is(okRun.sent[0].body['popups.list'][0].enabled, false, '…with the pop-up switched off');
    ok(typeof okRun.sent[0].body['popups.list'][0].updated_at === 'number', '…and its updated_at stamped');
    is(okRun.ctx.state.cfg._versions['popups.list'], 'cccccccccccccccc', 'the new version is kept for the next switch');
    is(okRun.toasts, ['Pop-up is off'], 'a toast confirms');

    const current = [{ id: 'p1', enabled: true }, { id: 'p2', enabled: true }];
    const staleRun = run(() => { const e = new Error('stale_config'); e.code = 'stale_config'; e.body = { success: false, error: 'stale_config', key: 'popups.list', version: 'dddddddddddddddd', value: current }; throw e; });
    staleRun.CMD.togglePopup('p1');
    await new Promise((r2) => setImmediate(r2));
    is(staleRun.ctx.state.cfg.popups.list, current, 'refused as stale: the list shown is the one the server has now');
    is(staleRun.ctx.state.cfg._versions['popups.list'], 'dddddddddddddddd', '…at its current version, so the next switch can save');
    is(String(staleRun.ctx.state.puErr), 'Somebody else changed this while you had it open. It has been reloaded — try again.', '…and it says so in words, where the operator is looking');
    is(staleRun.toasts, [], 'no toast claims it saved');
    is(staleRun.ctx.state.puBusy, null, 'the switch is free again');

    const otherRun = run(() => { const e = new Error('update_failed'); e.code = 'update_failed'; throw e; });
    otherRun.CMD.togglePopup('p1');
    await new Promise((r2) => setImmediate(r2));
    is(String(otherRun.ctx.state.puErr), 'That did not save. Nothing has changed — try again.', 'any other failure keeps its own words');

    const noVer = run(() => ({ success: true, data: {} }));
    delete noVer.ctx.state.cfg._versions;
    noVer.CMD.togglePopup('p1');
    await new Promise((r2) => setImmediate(r2));
    is(noVer.sent[0].p, '/config', 'with no version loaded, it saves unchecked, as before');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
