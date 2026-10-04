#!/usr/bin/env node
/**
 * §426 — a voucher limited to one location is an in-person discount there.
 *
 *   node scripts/test_location_vouchers.js
 *
 * The Ramada staff 10%: one private, standing voucher limited to the Yuexiu
 * counter, held by one employee. Everything below runs the REAL routers —
 * routes/retail.js for the till and the admin, routes/shop-menu.js for the QR
 * menu — over HTTP, against a scratch database (test-support/tenant-fixture),
 * so every total asserted here is one the server actually charged.
 *
 * WHAT IS HELD HERE
 *
 *  1. The place rule, all of it: a located voucher applies at its own counter
 *     and to a pickup there, and NOT to a delivery — including a delivery sent
 *     from that same store — nor to another store. A voucher with no location
 *     is exactly what it was: online, and still not at the counter.
 *  2. The till takes it off with no tap, before tax, records it on the order,
 *     and counts its use. Not for a guest, not at another store, not under a
 *     typed grand total.
 *  3. The QR menu's phone lookup answers with the discount ONLY — no code, no
 *     name, no id — and a number holding nothing answers exactly like a number
 *     nobody has.
 *  4. A QR order with a typed phone is discounted, linked to the holder and
 *     marked for the cashier to check; one without is untouched.
 *  5. Remove discount restates the total and the pending payment, unlinks the
 *     account, hands the use back, and does it once.
 *  6. A customer cancelling their own QR order hands the voucher's use back.
 *  7. The page carries the phone box and its script still parses.
 */
'use strict';

const vm = require('vm');
const F = require('./test-support/tenant-fixture');
const h = F.harness();
const path = require('path');
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));
const shopMenu = require(path.join(ROOT, 'routes', 'shop-menu.js'));

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* ── fixtures ──────────────────────────────────────────────────────────── */
const TIANHE = 1, YUEXIU = 2;
for (const [id, en, cn] of [[TIANHE, 'Tianhe', '天河'], [YUEXIU, 'Yuexiu', '越秀']]) {
  db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
              VALUES (?,?,?,?,1,?)`).run(id, en.toLowerCase(), en, cn, id);
}
const PROD = 7701;
db.prepare(`INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published)
            VALUES (?, 'Oat latte', '燕麦拿铁', 'LV-1', 50, 1, 1)`).run(PROD);
const SHOP_CODE = 'RAMADA22';
db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(YUEXIU, SHOP_CODE);
const SHOP_ID = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(YUEXIU).id;
db.prepare(`INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
            VALUES (?, ?, 50, 'made_here', 1, 0)`).run(SHOP_ID, PROD);

const STAFF = 601, OTHER = 602;
db.prepare(`INSERT INTO retail_customers (id, openid, nickname, phone) VALUES
            (?, 'o-601', 'Ramada employee', '13800138001'),
            (?, 'o-602', 'Somebody else', '13900139002')`).run(STAFF, OTHER);

const mkVoucher = db.prepare(`INSERT INTO retail_vouchers
  (code, type, value, min_subtotal, per_customer_limit, is_active, is_public, auto_apply, title_en, title_cn, store_id)
  VALUES (?, ?, ?, 0, 0, 1, 0, 1, ?, ?, ?)`);
const RAMADA = mkVoucher.run('RAMADA10', 'percent', 10, 'Ramada staff 10%', '华美达员工九折', YUEXIU).lastInsertRowid;
const ONLINE = mkVoucher.run('ONLINE5', 'fixed_amount', 5, 'Online ¥5', '线上立减5', null).lastInsertRowid;
const grant = db.prepare('INSERT INTO retail_customer_vouchers (customer_id, voucher_id) VALUES (?, ?)');
grant.run(STAFF, RAMADA);
grant.run(STAFF, ONLINE);
const usedCount = () => db.prepare('SELECT used_count FROM retail_vouchers WHERE id = ?').get(RAMADA).used_count;

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const OWNER = 7801;
db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active, scope_all)
            VALUES (?, ?, '__lv_owner', 'x', 'owner', 1, 1)`).run(OWNER, TENANT);

/* ── 1. the place rule, as a table ─────────────────────────────────────── */
section('1 · where a voucher applies');
{
  const located = { store_id: YUEXIU }, anywhere = { store_id: null };
  const counterY = { storeId: YUEXIU, inPerson: true, counter: true };
  const pickupY = { storeId: YUEXIU, inPerson: true };
  const pickupT = { storeId: TIANHE, inPerson: true };
  is(retail.voucherPlaceOk(located, counterY), true, 'a located voucher applies at its own counter');
  is(retail.voucherPlaceOk(located, pickupY), true, '…and to a pickup there');
  is(retail.voucherPlaceOk(located, pickupT), false, '…but not to a pickup at another store');
  is(retail.voucherPlaceOk(located, null), false, '…and never to a delivery, whichever store sends it');
  is(retail.voucherPlaceOk(anywhere, null), true, 'a voucher with no location still applies online');
  is(retail.voucherPlaceOk(anywhere, pickupY), true, '…including a pickup, as before');
  is(retail.voucherPlaceOk(anywhere, counterY), false, '…and still not at the counter — that was not decided');

  // The online checkout's own picker, held to the same rule.
  const pick = (place) => { const b = retail.bestAutoVoucher(STAFF, 100, 0, 100, place); return b && b.voucher.code; };
  is(pick(null), 'ONLINE5', 'a delivery gets the online voucher even though the located one is worth more');
  is(pick({ storeId: YUEXIU, inPerson: true }), 'RAMADA10', 'a pickup at Yuexiu gets the Ramada 10%, best one wins');
  is(pick({ storeId: TIANHE, inPerson: true }), 'ONLINE5', 'a pickup at Tianhe does not');
  is(pick(undefined), 'ONLINE5', 'a caller that describes no place (an older mini-app build) is never given it');
}

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) || null }; next(); });
  app.use(retail);
  app.use(shopMenu);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, op) => {
    const r = await fetch(base + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, op ? { 'x-op': String(op) } : {}),
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, j };
  };
  const order = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);

  try {
    /* ── 2. the till ───────────────────────────────────────────────────── */
    section('2 · the till');
    const till = (extra) => call('POST', '/api/retail-admin/orders', Object.assign({
      fulfillment_type: 'counter', channel: 'shop', shop_entry_method: 'till', status: 'paid',
      store_id: YUEXIU, customer_id: STAFF, recipient_name: 'Ramada employee', payment_method: 'cash',
      items: [{ product_id: PROD, qty: 2, unit_price: 50 }],
    }, extra), OWNER);

    const before = usedCount();
    const r1 = await till({});
    is(r1.status, 200, 'a till sale to the employee at Yuexiu is accepted');
    const o1 = r1.j && r1.j.data ? order(r1.j.data.id) : {};
    is(Number(o1.total), 90, 'the 10% comes off with no tap: ¥100 of goods, ¥90 charged');
    is([o1.voucher_code, Number(o1.voucher_amount)], ['RAMADA10', 10], 'the order records which voucher and how much');
    is(Number(o1.voucher_typed_phone), 0, 'an attached customer is not a typed phone');
    is(usedCount(), before + 1, 'the voucher\'s use is counted');
    is(Number(r1.j.data.voucher_amount), 10, 'the reply says what came off, so the till prints the server\'s figure');

    const r2 = await till({ store_id: TIANHE });
    is([r2.status, Number(r2.j && r2.j.data && r2.j.data.total)], [200, 100], 'at Tianhe the same employee pays full price');
    const r3 = await till({ customer_id: null, recipient_name: 'Guest' });
    is(Number(r3.j && r3.j.data && r3.j.data.total), 100, 'a guest walk-in pays full price');
    const r4 = await till({ total_override: 95 });
    is(Number(r4.j && r4.j.data && r4.j.data.total), 95, 'a typed grand total is the figure, and no voucher is applied on top');
    is(order(r4.j.data.id).voucher_code, null, '…and none is recorded');

    // The online voucher the employee also holds never reaches the counter.
    db.prepare('UPDATE retail_vouchers SET is_active = 0 WHERE id = ?').run(RAMADA);
    const r5 = await till({});
    is(Number(r5.j && r5.j.data && r5.j.data.total), 100, 'with the Ramada voucher off, the online ¥5 does not stand in at the till');
    db.prepare('UPDATE retail_vouchers SET is_active = 1 WHERE id = ?').run(RAMADA);

    const cv = await call('GET', `/api/retail-admin/customers/${STAFF}/counter-vouchers?store_id=${YUEXIU}`, null, OWNER);
    is((cv.j.data || []).map(v => v.title_en), ['Ramada staff 10%'], 'the till is told the employee holds the Ramada voucher here');
    const cvT = await call('GET', `/api/retail-admin/customers/${STAFF}/counter-vouchers?store_id=${TIANHE}`, null, OWNER);
    is(cvT.j.data, [], '…and nothing at Tianhe');

    /* ── 3. the QR menu's phone lookup ─────────────────────────────────── */
    section('3 · the QR menu asks what a phone is worth');
    const ask = (phone) => call('POST', `/s/${SHOP_CODE}/discount`, { phone });
    const a1 = await ask('+86 138 0013 8001');
    is((a1.j.data || []).length, 1, 'the employee\'s number, typed with +86 and spaces, finds the voucher');
    is(Object.keys((a1.j.data || [])[0] || {}).sort(),
       ['id', 'min_subtotal', 'title_cn', 'title_en', 'type', 'value'],
       'the answer is the discount only — no code, no name, no customer');
    const a2 = await ask('13900139002');
    const a3 = await ask('13700137003');
    is([a2.j, a3.j], [{ success: true, data: [] }, { success: true, data: [] }],
       'a customer holding nothing and a number nobody has get the same answer');

    /* ── 4. a QR order with a typed phone ──────────────────────────────── */
    section('4 · a QR order with a typed phone');
    const qr = (extra) => call('POST', `/s/${SHOP_CODE}/order`, Object.assign({
      name: 'Li', items: [{ store_product_id: PROD, qty: 2 }],
    }, extra));
    const u0 = usedCount();
    const q1 = await qr({ phone: '138 0013 8001', pay_method: 'wechat' });
    is(q1.status, 201, 'the order is placed');
    is(Number(q1.j.data.total), 90, 'the customer is charged ¥90, the figure the page showed');
    is(q1.j.data.pay_url, undefined, 'and it is paid at the counter — no in-page payment page');
    // The WeChat rail is not configured in this fixture, so the line above
    // would pass without the rule. The rule itself is read off the source: an
    // order carrying a typed-phone voucher is never handed the in-page rail.
    ok(/const payInPage = wantsWechat && !cv;/.test(require('fs').readFileSync(path.join(ROOT, 'routes', 'shop-menu.js'), 'utf8'))
       && /\.\.\.\(payInPage \? \{ pay_url:/.test(require('fs').readFileSync(path.join(ROOT, 'routes', 'shop-menu.js'), 'utf8')),
       'the in-page rail is refused for a typed-phone discount, whatever the customer picked');
    const qo = db.prepare('SELECT * FROM retail_orders WHERE order_no = ?').get(q1.j.data.order_no);
    is([qo.customer_id, qo.voucher_code, Number(qo.voucher_typed_phone)], [STAFF, 'RAMADA10', 1],
       'it is linked to the holder and marked for the cashier to check');
    is(Number(db.prepare("SELECT amount FROM retail_payments WHERE order_id = ? AND status = 'pending'").get(qo.id).amount), 90,
       'the pending payment is the discounted total');
    is(usedCount(), u0 + 1, 'the use is counted');

    const q2 = await qr({});
    const qo2 = db.prepare('SELECT * FROM retail_orders WHERE order_no = ?').get(q2.j.data.order_no);
    is([Number(q2.j.data.total), qo2.customer_id, qo2.voucher_code], [100, null, null],
       'without a phone the QR order is exactly what it always was');

    /* ── 5. Remove discount ────────────────────────────────────────────── */
    section('5 · the cashier takes it off');
    const u1 = usedCount();
    const rm = await call('POST', `/api/retail-admin/orders/${qo.id}/remove-voucher`, {}, OWNER);
    is([rm.status, Number(rm.j.data.total)], [200, 100], 'the total goes back to ¥100');
    const qa = order(qo.id);
    is([qa.customer_id, qa.voucher_code, Number(qa.voucher_amount), Number(qa.voucher_typed_phone)], [null, null, 0, 0],
       'the order is unlinked from the account and carries no voucher');
    is(Number(db.prepare("SELECT amount FROM retail_payments WHERE order_id = ? AND status = 'pending'").get(qo.id).amount), 100,
       'the pending payment is restated, so the pay page asks for ¥100');
    is(usedCount(), u1 - 1, 'the voucher\'s use is handed back');
    const rm2 = await call('POST', `/api/retail-admin/orders/${qo.id}/remove-voucher`, {}, OWNER);
    is([rm2.status, usedCount()], [409, u1 - 1], 'a second tap finds nothing to remove and hands nothing back twice');
    const rmPaid = await call('POST', `/api/retail-admin/orders/${r1.j.data.id}/remove-voucher`, {}, OWNER);
    is(rmPaid.status, 409, 'a paid order is not touched — that is a refund');
    // An online order pending payment may already sit in a WeChat prepay at its
    // discounted amount; restating it here would make the two disagree.
    db.prepare(`INSERT INTO retail_orders (id, order_no, customer_id, status, channel, fulfillment_type,
                  subtotal, total, voucher_code, voucher_amount, store_id)
                VALUES (7901, 'LV7901', ?, 'pending_payment', 'wechat', 'pickup', 100, 90, 'RAMADA10', 10, ?)`).run(STAFF, YUEXIU);
    const rmOnline = await call('POST', '/api/retail-admin/orders/7901/remove-voucher', {}, OWNER);
    is([rmOnline.status, Number(order(7901).total)], [409, 90], 'an online order is not this control\'s to restate');

    /* ── 6. the customer cancels their own ─────────────────────────────── */
    section('6 · a customer cancelling hands the use back');
    const q3 = await qr({ phone: '13800138001' });
    const u2 = usedCount();
    const tok = db.prepare('SELECT pay_token FROM retail_orders WHERE order_no = ?').get(q3.j.data.order_no).pay_token;
    const cx = await fetch(`${base}/s/${SHOP_CODE}/order/${tok}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual',
    });
    is(cx.status, 303, 'the cancel goes through');
    is(usedCount(), u2 - 1, 'and the voucher\'s use comes back');

    /* ── 7. the page ───────────────────────────────────────────────────── */
    section('7 · the page');
    const page = await fetch(`${base}/s/${SHOP_CODE}`).then(r => r.text());
    ok(/id="cPhone"[^>]*type="tel"/.test(page), 'the checkout carries the optional phone box');
    ok(page.includes('电话(选填)'), 'labelled with the declared pair');
    const scripts = [...page.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    let parsed = true, why = '';
    for (const src of scripts) { try { new vm.Script(src); } catch (e) { parsed = false; why = e.message; } }
    ok(parsed && scripts.length > 0, 'every inline script on the page still parses', why);

    // The till and the phone back office carry the other two screens. Their
    // inline scripts are parsed the same way, so a slip in either fails here
    // rather than as a blank counter.
    for (const f of ['public/till.html', 'public/m.html']) {
      const html = require('fs').readFileSync(path.join(ROOT, f), 'utf8');
      const srcs = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      let good = true, err = '';
      for (const src of srcs) { try { new vm.Script(src); } catch (e) { good = false; err = e.message; } }
      ok(good && srcs.length > 0, f + ' — every inline script still parses', err);
    }
    const tillSrc = require('fs').readFileSync(path.join(ROOT, 'public', 'till.html'), 'utf8');
    ok(/data-rm-voucher="1"/.test(tillSrc) && /\[data-rm-voucher\]/.test(tillSrc) && /return removeVoucher\(\)/.test(tillSrc),
       'the till draws Remove discount and the click reaches it');
    ok(/sub - \(cv \? cv\.off : 0\)/.test(tillSrc), 'the till quotes the walk-in total after the voucher, before tax');
  } catch (e) {
    fail++; console.log('  ✗ the suite threw: ' + (e && e.stack || e));
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
