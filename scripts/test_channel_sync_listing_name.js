#!/usr/bin/env node
/**
 * §325 step S2j — AN ELEME MAPPING WITH NO LISTING NAME IS NEVER SWITCHED ON.
 *
 *   node scripts/test_channel_sync_listing_name.js
 *
 * docs/eleme-findings.md finding 6: Eleme matches a push by name only, and the
 * daemon fills a missing listing name with the product's own Chinese name — so
 * a nameless mapping switched on writes stock to whichever listing that name
 * matches, or to none. The Eleme panel refused it on screen only; the Channel
 * sync page (and the phone's switch) went through lib/channel-sync-write.js
 * setSync, which switched it on. setSync now refuses with `no_listing_name`
 * and names the stores; both screens turn that code into the Eleme panel's own
 * sentence.
 *
 * Four layers: the function on an in-memory table, the real route over a
 * scratch database, the desktop's code→sentence table, and the phone's own
 * error function sliced out of m.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('@libsql/client');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const W = require(path.join(ROOT, 'lib', 'channel-sync-write'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const EN = 'Sync cannot be switched on until this mapping names an Eleme listing.';
const ZH = '未选择饿了么商品名前无法开启同步。';

function memDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE eleme_product_map (id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER, product_id INTEGER,
      store_code TEXT NOT NULL, eleme_name TEXT, sync_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE meituan_product_map (id INTEGER PRIMARY KEY AUTOINCREMENT, retail_store_id INTEGER, product_id INTEGER,
      store_code TEXT NOT NULL, meituan_name TEXT, sync_enabled INTEGER NOT NULL DEFAULT 0);`);
  return db;
}
const sw = (db, t) => db.prepare(`SELECT store_code AS s, sync_enabled AS on1 FROM ${t} ORDER BY store_code`).all().map((r) => r.s + ':' + r.on1).join(' ');

(async () => {
  section('1 · setSync');
  {
    const db = memDb();
    const ins = db.prepare('INSERT INTO eleme_product_map (retail_store_id, product_id, store_code, eleme_name, sync_enabled) VALUES (?,?,?,?,0)');
    ins.run(1, 80, 'tianhe', null);          // finding 6's product: no name
    ins.run(2, 80, 'yuexiu', '酸芒果干');
    let r = W.setSync(db, 'eleme', 80, true);
    is(r, { ok: false, code: 'no_listing_name', stores: ['tianhe'] }, 'switching on every store is refused, naming the nameless one');
    is(sw(db, 'eleme_product_map'), 'tianhe:0 yuexiu:0', '…and nothing was switched — not even the named store (all or nothing)');
    r = W.setSync(db, 'eleme', 80, true, 'yuexiu');
    is([r.ok, r.rows], [true, 1], 'the store whose mapping names a listing can be switched on on its own');
    r = W.setSync(db, 'eleme', 80, true, 'tianhe');
    is(r.code, 'no_listing_name', 'the nameless store, asked for alone, is still refused');
    db.prepare("UPDATE eleme_product_map SET sync_enabled = 1 WHERE store_code = 'tianhe'").run();
    r = W.setSync(db, 'eleme', 80, false);
    is([r.ok, sw(db, 'eleme_product_map')], [true, 'tianhe:0 yuexiu:0'], 'switching OFF is always allowed, nameless or not');
    db.prepare("UPDATE eleme_product_map SET eleme_name = '   ' WHERE store_code = 'tianhe'").run();
    is(W.setSync(db, 'eleme', 80, true).code, 'no_listing_name', 'a name of only spaces is no name');
    db.prepare("UPDATE eleme_product_map SET eleme_name = '芒果干' WHERE store_code = 'tianhe'").run();
    is(W.setSync(db, 'eleme', 80, true), { ok: true, rows: 2, on: true }, 'once both name a listing, both switch on');
    is(W.setSync(db, 'eleme', 999, true).code, 'not_mapped', 'a product with no mapping is still not_mapped');
    db.prepare("INSERT INTO meituan_product_map (retail_store_id, product_id, store_code, meituan_name) VALUES (1, 80, 'tianhe', NULL)").run();
    is(W.setSync(db, 'meituan', 80, true).ok, true, 'Meituan is unchanged by this rule');
  }

  section('2 · the route answers 409 with the code and the stores');
  {
    const db = h.db;
    require(path.join(ROOT, 'routes', 'backend-auth.js'));
    const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
                VALUES (8150, ?, '__s2j_owner', 'x', 'owner', 1)`).run(TENANT);
    db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (1, 'tianhe', 'Tianhe', '天河', 1, 1)`).run();
    F.seedProduct(db, { id: 80, name: 'Dried Sour Mango', sku: '4-200', storeOnly: true });
    db.prepare(`INSERT INTO eleme_product_map (product_id, retail_store_id, store_code, eleme_name, sync_enabled)
                VALUES (80, 1, 'tianhe', NULL, 0)`).run();
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => { req.session = { backendUserId: 8150 }; next(); });
    app.use(require(path.join(ROOT, 'routes', 'channel-sync.js')));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/retail-admin/channel-sync/eleme/products/80/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }),
      });
      const body = await res.json();
      is([res.status, body.error, body.stores], [409, 'no_listing_name', ['tianhe']], 'POST …/eleme/products/80/sync {on:true} → 409 no_listing_name, tianhe');
      is(db.prepare('SELECT sync_enabled FROM eleme_product_map WHERE product_id = 80').get().sync_enabled, 0, '…and the mapping stays off');
    } finally { server.close(); }
  }

  section('3 · both screens say it in the Eleme panel\'s own words');
  {
    const E14 = read('public/retail-admin/14-eleme.js');
    ok(E14.includes(EN) && E14.includes(ZH), 'the sentence is the Eleme panel\'s live pair, copied whole');
    const CORE = read('public/retail-admin/01-core.js');
    const td = CORE.slice(CORE.indexOf('const TD_ERR'), CORE.indexOf('\n};', CORE.indexOf('const TD_ERR')));
    ok(td.includes(`no_listing_name:        ['${EN}', '${ZH}']`), 'desktop: TD_ERR turns no_listing_name into it');
    ok(/new Error\(tdErrorText\(code, j\.message\)\)/.test(CORE), '…and api() throws that sentence for a refused write');
    ok(/catch \(e\) \{\s*_note = \{ key, text: e\.message \};/.test(read('public/retail-admin/29-channel-sync.js')),
      '…which the Channel sync page shows on the row (its write() note)');
    const M = read('public/m.html');
    const a = M.indexOf('function csErrText(e){');
    const b = M.indexOf('\n}', a) + 2;
    const box = { T: (en, zh) => en + '|' + zh };
    vm.createContext(box);
    vm.runInContext(M.slice(a, b), box);
    is(box.csErrText({ code: 'no_listing_name' }), EN + '|' + ZH, 'phone: csErrText turns no_listing_name into it');
    is(box.csErrText({ code: 'not_mapped' }).split('|')[0], 'Somebody else changed this while you had it open — reload and try again.',
      '…and its other codes are unchanged');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
