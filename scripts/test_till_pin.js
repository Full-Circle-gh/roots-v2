#!/usr/bin/env node
/**
 * §475 — a manager approves a till discount with their PIN.
 *
 *   node scripts/test_till_pin.js
 *
 * The counter tablet is often signed in all day as a shop-floor account, which
 * §474 does not let give a discount. The cashier picks a manager by name and
 * the manager types their PIN; the discount is recorded under the MANAGER.
 * Everything below runs the real routers (routes/backend-auth.js for setting a
 * PIN, routes/retail.js for the till) over HTTP against a scratch database.
 *
 * WHAT IS HELD HERE
 *
 *  1. Setting a PIN: needs the current password, 4 to 6 digits, and the
 *     discount capability. /me says whether one is set and never sends it.
 *  2. The till's list of managers: holders of till:discount with a PIN, names
 *     only.
 *  3. The check and the sale: a right PIN gives the discount under the
 *     manager's name; a wrong one gives nothing and writes nothing.
 *  4. Five wrong PINs lock that manager's PIN for fifteen minutes.
 *  5. The till, the phone and the desktop account page carry the controls,
 *     and their scripts still parse.
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const F = require('./test-support/tenant-fixture');
const h = F.harness();
const path = require('path');
const ROOT = h.REPO;
const db = h.db;
const bcrypt = require('bcrypt');
const backendAuth = require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const caps = require(path.join(ROOT, 'lib', 'capabilities.js'));
const tillPin = require(path.join(ROOT, 'lib', 'till-pin.js'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* ── fixtures ──────────────────────────────────────────────────────────── */
const STORE = 1;
db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, 'tianhe', 'Tianhe', '天河', 1, 1)`).run(STORE);
const PROD = 7761;
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Granola', '格兰诺拉', 'PN-1', 50, 1, 1)`).run(PROD);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const PW = 'correct-horse-1';
const HASH = bcrypt.hashSync(PW, 4);
const mkUser = db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, display_name, password, role, is_active, scope_all)
                           VALUES (?, ?, ?, ?, ?, ?, 1, 1)`);
const MGR = 7851, MGR2 = 7852, CASHIER = 7853;
mkUser.run(MGR, TENANT, '__pn_mgr', 'Wei', HASH, 'store_manager');
mkUser.run(MGR2, TENANT, '__pn_mgr2', 'Ming', HASH, 'store_manager');
mkUser.run(CASHIER, TENANT, '__pn_staff', 'Lily', HASH, 'staff');
for (const k of ['store_manager', 'staff']) {
  db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE tenant_id = ? AND role_key = ?')
    .run(JSON.stringify(caps.presetCapsFor(k)), TENANT, k);
}
db.prepare('UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1, rbac_enforce = 0 WHERE id = ?').run(TENANT);

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) || null, cookie: {} }; next(); });
  app.use(backendAuth);
  app.use(retail);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, op) => {
    const r = await fetch(base + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, op ? { 'x-op': String(op) } : {}),
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { /* not json */ }
    return { status: r.status, j };
  };
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n;
  const order = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
  const till = (md, op) => call('POST', '/api/retail-admin/orders', {
    fulfillment_type: 'counter', channel: 'shop', shop_entry_method: 'till', status: 'paid',
    store_id: STORE, customer_id: null, recipient_name: 'Guest', payment_method: 'cash',
    items: [{ product_id: PROD, qty: 2, unit_price: 50 }],
    manual_discount: md,
  }, op || CASHIER);

  try {
    /* ── 1. setting a PIN ──────────────────────────────────────────────── */
    section('1 · setting a PIN');
    const setPin = (op, body) => call('PUT', '/api/backend/till-pin', body, op);
    is((await setPin(MGR, { current_password: 'wrong', pin: '1234' })).status, 400, 'the wrong current password is refused');
    is((await setPin(MGR, { current_password: PW, pin: '12a4' })).j.code, 'bad_pin', 'a PIN that is not 4 to 6 digits is refused');
    is((await setPin(MGR, { current_password: PW, pin: '123' })).j.code, 'bad_pin', '…nor three digits');
    is((await setPin(CASHIER, { current_password: PW, pin: '1234' })).status, 403, 'a cashier who cannot give a discount cannot set a PIN');
    const s1 = await setPin(MGR, { current_password: PW, pin: '4821' });
    is([s1.status, s1.j && s1.j.hasTillPin], [200, true], 'a store manager sets one');
    ok(/^\$2[aby]\$/.test(db.prepare('SELECT till_pin FROM tenant_users WHERE id = ?').get(MGR).till_pin || ''),
       'it is stored hashed, never as typed');
    const me = await call('GET', '/api/backend/me', null, MGR);
    is([me.j && me.j.user && me.j.user.hasTillPin, 'till_pin' in ((me.j && me.j.user) || {})], [true, false],
       '/me says one is set, and never sends it');
    const meNone = await call('GET', '/api/backend/me', null, MGR2);
    is(meNone.j && meNone.j.user && meNone.j.user.hasTillPin, false, '…and says so when none is');

    /* ── 2. the managers a till can ask ────────────────────────────────── */
    section('2 · the managers a till can ask');
    // A shop-floor row with a PIN put straight into the database: never offered.
    db.prepare('UPDATE tenant_users SET till_pin = ? WHERE id = ?').run(tillPin.hashPin('1111'), CASHIER);
    const ap = await call('GET', '/api/retail-admin/till-approvers', null, CASHIER);
    is(ap.j && ap.j.data, [{ id: MGR, name: 'Wei' }],
       'Wei (a PIN) is offered; Ming (no PIN) and Lily (a PIN, no capability) are not — names only');

    /* ── 3. the check and the sale ─────────────────────────────────────── */
    section('3 · the check and the sale');
    const c1 = await call('POST', '/api/retail-admin/till-pin/check', { approver_id: MGR, pin: '0000' }, CASHIER);
    is([c1.status, c1.j && c1.j.error], [400, 'bad_till_pin'], 'a wrong PIN is refused — a 400, so the till does not read it as signed out');
    const c2 = await call('POST', '/api/retail-admin/till-pin/check', { approver_id: MGR, pin: '4821' }, CASHIER);
    is([c2.status, c2.j && c2.j.data && c2.j.data.name], [200, 'Wei'], 'the right one answers with the manager\'s name');
    const c3 = await call('POST', '/api/retail-admin/till-pin/check', { approver_id: CASHIER, pin: '1111' }, CASHIER);
    is(c3.j && c3.j.error, 'bad_till_pin', "a shop-floor account's own PIN approves nothing");

    const n0 = count();
    const r1 = await till({ percent: 10, reason: 'damaged', approver_id: MGR, pin: '4821' });
    const o1 = r1.j && r1.j.data ? order(r1.j.data.id) : {};
    is([r1.status, Number(o1.total), Number(o1.manual_discount_amount), o1.manual_discount_by], [200, 90, 10, 'Wei'],
       'the cashier\'s sale with Wei\'s PIN: ¥10 off, recorded under Wei');
    const r2 = await till({ percent: 10, reason: 'damaged', approver_id: MGR, pin: '9999' });
    is([r2.status, r2.j && r2.j.error], [400, 'bad_till_pin'], 'with a wrong PIN the sale is refused');
    const r3 = await till({ percent: 10, reason: 'damaged' });
    is([r3.status, r3.j && r3.j.error], [403, 'forbidden_capability'], 'with no manager named, refused as before');
    is(count(), n0 + 1, '…and neither refusal wrote an order');
    const r4 = await till({ percent: 25, reason: 'damaged', approver_id: MGR, pin: '4821' });
    is(r4.j && r4.j.error, 'manual_discount_over_limit', 'a manager\'s PIN does not lift the 20% limit');

    /* ── 4. guessing ───────────────────────────────────────────────────── */
    section('4 · five wrong PINs lock it');
    tillPin._resetForTests();
    let last = null;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/retail-admin/till-pin/check', { approver_id: MGR, pin: '000' + i }, CASHIER);
    is([last.status, last.j && last.j.error], [429, 'till_pin_locked'], 'the fifth wrong PIN locks it');
    const locked = await call('POST', '/api/retail-admin/till-pin/check', { approver_id: MGR, pin: '4821' }, CASHIER);
    is(locked.j && locked.j.error, 'till_pin_locked', '…and then even the right PIN is refused');
    const rl = await till({ percent: 10, reason: 'damaged', approver_id: MGR, pin: '4821' });
    is([rl.status, rl.j && rl.j.error], [429, 'till_pin_locked'], '…at the sale too');
    const T = { id: TENANT };
    const later = tillPin.checkPin(db, T, MGR, '4821', Date.now() + tillPin.LOCK_MS + 1000);
    ok(later.ok === true, 'fifteen minutes on, the right PIN works again');
    is(tillPin.checkPin(db, T, MGR2, '4821').error, 'bad_till_pin', "one manager's lock or PIN says nothing about another's");
    // A manager signed in themselves still needs no PIN (§474 unchanged).
    const self = await till({ percent: 10, reason: 'damaged' }, MGR);
    is([self.status, self.j && self.j.data && order(self.j.data.id).manual_discount_by], [200, 'Wei'],
       'a manager signed in on the till gives one without a PIN, as before');

    /* ── 5. the screens ────────────────────────────────────────────────── */
    section('5 · the screens');
    const parses = (f) => {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const srcs = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      let good = true, err = '';
      for (const src of srcs) { try { new vm.Script(src); } catch (e) { good = false; err = e.message; } }
      ok(good && srcs.length > 0, f + ' — every inline script still parses', err);
      return html;
    };
    const tillSrc = parses('public/till.html');
    const mSrc = parses('public/m.html');
    const acct = parses('public/backend-account.html');
    ok(/api\('\/api\/retail-admin\/till-approvers'\)/.test(tillSrc) && /if \(!S\.canDisc\) \{\s*api\('\/api\/retail-admin\/till-approvers'\)/.test(tillSrc),
       'the till asks for the managers only when its own operator cannot give one');
    ok(/data-disc-mgr="/.test(tillSrc) && /\[data-disc-mgr\]'\);/.test(tillSrc) && /return pickDiscMgr\(/.test(tillSrc),
       'the till draws the manager names and the tap reaches them');
    ok(/id="disc-pin" type="password"/.test(tillSrc), 'the PIN box is a password box');
    ok(/fetch\('\/api\/retail-admin\/till-pin\/check'/.test(tillSrc), 'Apply checks the PIN before the bill shows the discount');
    ok(/body\.manual_discount\.approver_id = S\.disc\.approver_id; body\.manual_discount\.pin = S\.disc\.pin;/.test(tillSrc),
       'the sale carries the approving manager and PIN');
    ok(/reg\('acctTillPin'/.test(mSrc) && /'\/api\/backend\/till-pin'/.test(mSrc) && /acctCanTillPin\(\)\?/.test(mSrc),
       'the phone account screen sets a PIN, for those who may give a discount');
    ok(/id="tillPinSect" hidden/.test(acct) && /'\/api\/backend\/till-pin'/.test(acct) && /showTillPin\(u\);/.test(acct),
       'the desktop account page does too, hidden from everyone else');
  } catch (e) {
    fail++; console.log('  ✗ the suite threw: ' + (e && e.stack || e));
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
