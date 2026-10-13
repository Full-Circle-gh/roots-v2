#!/usr/bin/env node
/**
 * §474 — a manager's hand discount at the counter till.
 *
 *   node scripts/test_till_manual_discount.js
 *
 * Decided by Ash: "go, managers only, max 20%, reason required". Everything
 * below runs the REAL router (routes/retail.js) over HTTP against a scratch
 * database (test-support/tenant-fixture), so every total asserted is one the
 * server actually charged.
 *
 * WHAT IS HELD HERE
 *
 *  1. The arithmetic (lib/till-discount.js): 20% is the ceiling whichever way
 *     it is asked for, a reason is required, 'other' needs a note.
 *  2. The capability: registered, money-marked, on the manager presets and NOT
 *     on the shop floor's; the backfill reaches manager rows only, once.
 *  3. The till sale: the discount comes off after the voucher and is recorded
 *     with its reason and who gave it; over 20%, no reason, a cashier without
 *     the capability, the admin's New order and a typed total are all refused
 *     — the capability even on a tenant that has not switched rbac_enforce on.
 *  4. The report counts it, by who and why.
 *  5. The till draws the control, posts it, and its script still parses.
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const F = require('./test-support/tenant-fixture');
const h = F.harness();
const path = require('path');
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const td = require(path.join(ROOT, 'lib', 'till-discount.js'));
const caps = require(path.join(ROOT, 'lib', 'capabilities.js'));
const roles = require(path.join(ROOT, 'lib', 'roles.js'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* ── 1. the arithmetic ─────────────────────────────────────────────────── */
section('1 · lib/till-discount.js');
{
  const r = (input, base) => td.resolveManualDiscount(input, base);
  is(r({ percent: 10, reason: 'damaged' }, 43).amount, 4.3, '10% of ¥43 is ¥4.30');
  is(r({ percent: 20, reason: 'damaged' }, 43).amount, 8.6, '20% is allowed');
  is(r({ percent: 21, reason: 'damaged' }, 43).error, 'manual_discount_over_limit', '21% is refused');
  is(r({ amount: 8.6, reason: 'complaint' }, 43).amount, 8.6, 'a typed ¥8.60 on ¥43 is exactly 20%, allowed');
  is(r({ amount: 8.61, reason: 'complaint' }, 43).error, 'manual_discount_over_limit', '¥8.61 is over 20%, refused');
  is(r({ amount: 40, reason: 'complaint' }, 43).error, 'manual_discount_over_limit', 'typing ¥40 off cannot walk past the limit');
  is(r({ percent: 10 }, 43).error, 'manual_discount_reason_required', 'no reason, refused');
  is(r({ percent: 10, reason: 'because' }, 43).error, 'manual_discount_reason_required', 'a reason not on the list, refused');
  is(r({ percent: 10, reason: 'other' }, 43).error, 'manual_discount_reason_required', "'other' with no note, refused");
  is(r({ percent: 10, reason: 'other', note: '  regular  ' }, 43).note, 'regular', "'other' with a note is fine, trimmed");
  is(r({ percent: 10, amount: 2, reason: 'damaged' }, 43).error, 'bad_manual_discount', 'both a percent and an amount, refused');
  is(r({ reason: 'damaged' }, 43).error, 'bad_manual_discount', 'neither, refused');
  is(r({ percent: 10, reason: 'damaged' }, 0).error, 'bad_manual_discount', 'nothing to take it off, refused');
  is(r({ percent: -5, reason: 'damaged' }, 43).error, 'bad_manual_discount', 'a negative percent, refused');
}

/* ── 2. the capability ─────────────────────────────────────────────────── */
section('2 · who may give one');
{
  const c = caps.CAPABILITIES.find(x => x.key === 'till:discount');
  ok(!!c && c.money === 'moves' && c.section === 'till', 'till:discount is registered, in the till section, marked as moving money');
  const preset = (role) => caps.presetCapsFor ? caps.presetCapsFor(role) : null;
  const has = (role) => { const p = preset(role); return p === '*' || (Array.isArray(p) && p.indexOf('till:discount') !== -1); };
  is([has('manager'), has('store_manager'), has('staff')], [true, true, false],
     'the manager presets carry it; the shop floor does not');

  // The backfill. Booting backend-auth above already ran it once; take its
  // ledger row away and strip the key so it can be watched doing its work.
  const TEN = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
  const put = db.prepare(`INSERT OR REPLACE INTO tenant_roles (tenant_id, role_key, name_en, name_cn, caps_json)
                          VALUES (?, ?, ?, ?, ?)`);
  for (const k of ['manager', 'store_manager', 'staff']) {
    const row = db.prepare('SELECT id FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(TEN, k);
    if (row) db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE id = ?').run(JSON.stringify(['till:use', 'orders:edit']), row.id);
    else put.run(TEN, k, k, k, JSON.stringify(['till:use', 'orders:edit']));
  }
  db.prepare("DELETE FROM _migrations WHERE name = 'grant_till_discount_to_managers_v1'").run();
  roles.migrateTillDiscountCap();
  const capsOf = (k) => JSON.parse(db.prepare('SELECT caps_json FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(TEN, k).caps_json);
  is(['manager', 'store_manager', 'staff'].map(k => capsOf(k).indexOf('till:discount') !== -1), [true, true, false],
     'the backfill gives it to manager and store manager rows, not to staff');
  // Once only: a manager role an owner later narrows stays narrow.
  const mgr = db.prepare('SELECT id FROM tenant_roles WHERE tenant_id = ? AND role_key = ?').get(TEN, 'manager').id;
  db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE id = ?').run(JSON.stringify(['till:use', 'orders:edit']), mgr);
  is(roles.migrateTillDiscountCap(), 0, 'a second run grants nothing');
  is(capsOf('manager').indexOf('till:discount'), -1, '…so an owner who unticks it keeps that decision');
}

/* ── fixtures ──────────────────────────────────────────────────────────── */
const YUEXIU = 2, TIANHE = 1;
for (const [id, en, cn] of [[TIANHE, 'Tianhe', '天河'], [YUEXIU, 'Yuexiu', '越秀']]) {
  db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
              VALUES (?,?,?,?,1,?)`).run(id, en.toLowerCase(), en, cn, id);
}
const PROD = 7741;
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Granola', '格兰诺拉', 'MD-1', 50, 1, 1)`).run(PROD);
const STAFF_CUST = 641;
db.prepare(`INSERT INTO retail_customers (id, openid, nickname, phone) VALUES (?, 'o-641', 'Ramada employee', '13800138041')`).run(STAFF_CUST);
const RAMADA = db.prepare(`INSERT INTO retail_vouchers
  (code, type, value, min_subtotal, per_customer_limit, is_active, is_public, auto_apply, title_en, title_cn, store_id)
  VALUES ('RAMADA10X', 'percent', 10, 0, 0, 1, 0, 1, 'Ramada Staff', '华美达员工', ?)`).run(YUEXIU).lastInsertRowid;
db.prepare('INSERT INTO retail_customer_vouchers (customer_id, voucher_id) VALUES (?, ?)').run(STAFF_CUST, RAMADA);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const mkUser = db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, display_name, password, role, is_active, scope_all)
                           VALUES (?, ?, ?, ?, 'x', ?, 1, 1)`);
const OWNER = 7841, CASHIER = 7842, STORE_MGR = 7843;
mkUser.run(OWNER, TENANT, '__md_owner', 'Ash', 'owner');
mkUser.run(CASHIER, TENANT, '__md_staff', 'Lily', 'staff');
mkUser.run(STORE_MGR, TENANT, '__md_sm', 'Wei', 'store_manager');
// The store manager row as the preset ships it, so the test reads the real grant.
db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE tenant_id = ? AND role_key = ?')
  .run(JSON.stringify(caps.presetCapsFor('store_manager')), TENANT, 'store_manager');
db.prepare('UPDATE tenant_roles SET caps_json = ? WHERE tenant_id = ? AND role_key = ?')
  .run(JSON.stringify(caps.presetCapsFor('staff')), TENANT, 'staff');
db.prepare('UPDATE tenants SET roles_version = COALESCE(roles_version, 0) + 1, rbac_enforce = 0 WHERE id = ?').run(TENANT);

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) || null }; next(); });
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
  const order = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
  const till = (extra, op) => call('POST', '/api/retail-admin/orders', Object.assign({
    fulfillment_type: 'counter', channel: 'shop', shop_entry_method: 'till', status: 'paid',
    store_id: TIANHE, customer_id: null, recipient_name: 'Guest', payment_method: 'cash',
    items: [{ product_id: PROD, qty: 2, unit_price: 50 }],
  }, extra), op || OWNER);

  try {
    /* ── 3. the till sale ──────────────────────────────────────────────── */
    section('3 · the till sale');
    const r1 = await till({ manual_discount: { percent: 10, reason: 'damaged' } });
    is(r1.status, 200, 'a 10% discount on a guest sale is accepted');
    const o1 = r1.j && r1.j.data ? order(r1.j.data.id) : {};
    is(Number(o1.total), 90, '¥100 of goods, ¥10 off, ¥90 charged');
    is([Number(o1.manual_discount_amount), o1.manual_discount_reason, o1.manual_discount_by],
       [10, 'damaged', 'Ash'], 'the order records how much, why, and who gave it — by name');
    is(Number(r1.j.data.manual_discount_amount), 10, 'the reply says what came off');

    const r2 = await till({ store_id: YUEXIU, customer_id: STAFF_CUST, recipient_name: 'Ramada employee',
                            manual_discount: { percent: 20, reason: 'complaint' } });
    const o2 = r2.j && r2.j.data ? order(r2.j.data.id) : {};
    is([Number(o2.voucher_amount), Number(o2.manual_discount_amount), Number(o2.total)], [10, 18, 72],
       'after the Ramada 10%: ¥100 → ¥90, then 20% of ¥90 = ¥18, ¥72 charged');

    const r3 = await till({ manual_discount: { amount: 20, reason: 'friends_family' } });
    is([r3.status, Number(r3.j && r3.j.data && r3.j.data.total)], [200, 80], 'a typed ¥20 off ¥100 (exactly 20%) is fine');
    const r3n = await till({ manual_discount: { percent: 5, reason: 'other', note: 'Regular, bag split' } });
    is(order(r3n.j.data.id).manual_discount_note, 'Regular, bag split', "an 'other' reason keeps the cashier's note");

    const r4 = await till({ manual_discount: { percent: 25, reason: 'damaged' } });
    is([r4.status, r4.j && r4.j.error, r4.j && r4.j.max_pct], [400, 'manual_discount_over_limit', 20], '25% is refused, and the limit is named');
    const r5 = await till({ manual_discount: { amount: 21, reason: 'damaged' } });
    is([r5.status, r5.j && r5.j.error], [400, 'manual_discount_over_limit'], '¥21 off ¥100 is refused');
    const r6 = await till({ manual_discount: { percent: 10 } });
    is([r6.status, r6.j && r6.j.error], [400, 'manual_discount_reason_required'], 'no reason, refused');

    const nBefore = db.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n;
    const r7 = await till({ manual_discount: { percent: 10, reason: 'damaged' } }, CASHIER);
    is([r7.status, r7.j && r7.j.error, r7.j && r7.j.need], [403, 'forbidden_capability', 'till:discount'],
       'a shop-floor cashier is refused — and this tenant has NOT switched rbac_enforce on');
    is(db.prepare('SELECT COUNT(*) AS n FROM retail_orders').get().n, nBefore, '…and nothing was written');
    const r7b = await till({}, CASHIER);
    is(r7b.status, 200, 'the same cashier still rings the sale without one');
    const r8 = await till({ manual_discount: { percent: 10, reason: 'damaged' } }, STORE_MGR);
    is([r8.status, r8.j && r8.j.data && order(r8.j.data.id).manual_discount_by], [200, 'Wei'], 'a store manager may');

    const r9 = await till({ shop_entry_method: undefined, channel: 'manual', manual_discount: { percent: 10, reason: 'damaged' } });
    is([r9.status, r9.j && r9.j.error], [400, 'manual_discount_till_only'], "the admin's New order is not the till");
    const r10 = await till({ total_override: 95, manual_discount: { percent: 10, reason: 'damaged' } });
    is([r10.status, r10.j && r10.j.error], [400, 'manual_discount_till_only'], 'never beside a typed grand total');

    const r11 = await till({});
    const o11 = order(r11.j.data.id);
    is([Number(o11.manual_discount_amount), o11.manual_discount_reason, Number(o11.total)], [0, null, 100],
       'a sale without one is exactly what it was');

    /* ── 4. the report ─────────────────────────────────────────────────── */
    section('4 · the report');
    const d = await call('GET', '/api/retail-admin/dashboard', null, OWNER);
    const md = (d.j && d.j.data && d.j.data.marketing && d.j.data.marketing.manualDiscounts)
            || (d.j && d.j.marketing && d.j.marketing.manualDiscounts) || null;
    ok(Array.isArray(md), 'the dashboard carries the till discounts', JSON.stringify(d.j && Object.keys(d.j.data || d.j)).slice(0, 200));
    const ash = (md || []).filter(x => x.by_name === 'Ash');
    const sum = ash.reduce((a, x) => a + Number(x.discount), 0);
    is(Math.round(sum * 100) / 100, 53, "Ash's discounts add up: ¥10 + ¥18 + ¥20 + ¥5");
    ok((md || []).some(x => x.by_name === 'Wei' && x.reason === 'damaged' && Number(x.uses) === 1),
       "…and Wei's is counted under Wei, by reason");
    const comp = (d.j && d.j.data && d.j.data.composition) || (d.j && d.j.composition) || {};
    is(Math.round(Number(comp.manual_discount_total) * 100) / 100, 63, 'the revenue composition counts them too');

    /* ── 5. the till page ──────────────────────────────────────────────── */
    section('5 · the till page');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
    const srcs = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    let good = true, err = '';
    for (const src of srcs) { try { new vm.Script(src); } catch (e) { good = false; err = e.message; } }
    ok(good && srcs.length > 0, 'public/till.html — every inline script still parses', err);
    ok(/id="disc"[^>]*data-disc="ask"/.test(html) && /\[data-disc\],\[data-disc-pct\],\[data-disc-why\]/.test(html)
       && /return openDiscAsk\(\);/.test(html), 'the till draws Discount and the click reaches it');
    ok(/S\.canDisc = !!\(\(me && me\.user && me\.user\.role === 'owner'\)\s*\|\| \(caps && caps\.indexOf\('till:discount'\) !== -1\)\)/.test(html),
       'the button is drawn only for an owner or a holder of till:discount — closed when caps are unread');
    ok(/body\.manual_discount = \{ percent: S\.disc\.percent, amount: S\.disc\.amount,/.test(html),
       'the sale posts the discount for the server to work out');
    ok(/var DISC_MAX_PCT = 20;/.test(html) && td.MAX_PCT === 20, 'the till and the server carry the same 20%');
    ok(/sub - \(cv \? cv\.off : 0\) - discOff\(sub\)/.test(html), 'the till quotes the total after the voucher and the discount, before tax');
    // The receipt prints it.
    ok(/manual_discount_amount\) > 0\) L\.push\(row\('Discount'/.test(fs.readFileSync(path.join(ROOT, 'lib', 'feie.js'), 'utf8')),
       'the printed receipt carries a Discount line');
  } catch (e) {
    fail++; console.log('  ✗ the suite threw: ' + (e && e.stack || e));
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
