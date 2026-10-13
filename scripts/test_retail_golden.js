#!/usr/bin/env node
/**
 * test_retail_golden.js — the routes split out of routes/retail.js answer
 * exactly what they answered before the split (decisions §472).
 *
 *   node scripts/test_retail_golden.js                    compare every area
 *   node scripts/test_retail_golden.js --update <area>    re-record one area
 *
 * Each area is a fixed list of requests, sent to the real router over one
 * seeded scratch database, in this file's order. Every status and body is
 * compared with scripts/test-support/golden/retail-<area>.json. The areas share
 * one database because retail.js can be loaded once per process, so --update
 * still runs every area and writes only the one named.
 *
 * Recording rules are in scripts/test-support/retail-golden.js. In short:
 * record an area on main BEFORE it moves; re-record only for a change in
 * behaviour you meant, and commit the recording with that change.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { openApp } = require('./test-support/retail-golden');

const GOLDEN_DIR = path.join(__dirname, 'test-support', 'golden');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Each area: seed(app) → anything its requests need, then requests(seeded).
// A request is [who, METHOD, path, body?], who ∈ customer | admin | anon.
const AREAS = {
  polls: {
    seed: () => ({}),
    requests: () => [
      ['anon', 'GET', '/api/retail/polls'],
      ['admin', 'GET', '/api/retail-admin/voting/config'],
      ['admin', 'POST', '/api/retail-admin/polls', { question_en: 'Next flavour?', status: 'draft', options: [{ label_en: 'Mango' }] }],
      ['admin', 'POST', '/api/retail-admin/polls', { question_en: 'Next flavour?', question_cn: '下一个口味?', status: 'open', reward_points: 7,
        options: [{ label_en: 'Mango', label_cn: '芒果' }, { label_en: 'Lime', label_cn: '青柠' }] }],
      ['admin', 'POST', '/api/retail-admin/polls', {}],
      ['customer', 'GET', '/api/retail/polls'],
      ['anon', 'GET', '/api/retail/polls/public'],
      ['customer', 'GET', '/api/retail/polls/1'],
      ['customer', 'GET', '/api/retail/polls/999'],
      ['customer', 'POST', '/api/retail/polls/1/vote', { option_id: 1 }],
      ['customer', 'POST', '/api/retail/polls/1/vote', { option_id: 2 }],
      ['customer', 'POST', '/api/retail/polls/1/vote', { option_id: 99 }],
      ['customer', 'POST', '/api/retail/polls/1/vote', {}],
      ['anon', 'POST', '/api/retail/polls/1/vote', { option_id: 1 }],
      ['anon', 'GET', '/api/retail/polls/public'],
      ['customer', 'GET', '/api/retail/voting/config'],
      ['admin', 'PUT', '/api/retail-admin/voting/config', { intro_en: 'Vote by Sunday', intro_cn: '周日前投票', show_counts: false }],
      ['customer', 'GET', '/api/retail/voting/config'],
      ['admin', 'PUT', '/api/retail-admin/polls/1', { display_min_total: 50, is_featured: true }],
      ['customer', 'GET', '/api/retail/polls/1'],
      ['admin', 'PUT', '/api/retail-admin/polls/1', { status: 'bogus' }],
      ['admin', 'PUT', '/api/retail-admin/polls/1', { winner_option_id: 99 }],
      ['admin', 'PUT', '/api/retail-admin/polls/1', { status: 'closed', winner_option_id: 1,
        options: [{ id: 1, label_en: 'Mango!' }, { id: 2, label_en: 'Lime' }, { label_en: 'Yuzu' }] }],
      ['admin', 'GET', '/api/retail-admin/polls'],
      ['admin', 'GET', '/api/retail-admin/polls/1'],
      ['admin', 'GET', '/api/retail-admin/polls/999'],
      ['admin', 'DELETE', '/api/retail-admin/polls/999'],
      ['admin', 'DELETE', '/api/retail-admin/polls/1'],
      ['admin', 'GET', '/api/retail-admin/polls'],
      ['anon', 'GET', '/api/retail-admin/polls'],
    ],
  },

  // One thread is seeded with a fixed stamp and never touched; every action
  // goes to the one thread created during the run. The inbox lists sort by
  // latest activity with no tie-breaker, and the database stamps live rows to
  // the second, so two live threads would come out in either order depending
  // on whether a second ticked over between them.
  feedback: {
    seed: ({ ins, customer, SEED_AT }) => {
      ins('retail_feedback', { customer_id: customer, customer_name: 'Golden', message: 'Seeded: the menu is slow',
        page_context: 'menu', last_customer_msg_at: SEED_AT });
      return {};
    },
    requests: () => [
      ['customer', 'POST', '/api/retail/feedback', { message: '' }],
      ['customer', 'POST', '/api/retail/feedback', { message: 'The cart button does nothing', page_context: 'cart', app_version: '1.2.3',
        photos: ['/api/retail/media/1', 'https://elsewhere.example/x.png'] }],
      ['anon', 'POST', '/api/retail/feedback', { message: 'no token' }],
      ['customer', 'GET', '/api/retail/feedback'],
      ['customer', 'GET', '/api/retail/feedback/1'],
      ['customer', 'GET', '/api/retail/feedback/2'],
      ['customer', 'GET', '/api/retail/feedback/999'],
      ['admin', 'GET', '/api/retail-admin/feedback/unseen-count?since=2020-01-01'],
      ['admin', 'GET', '/api/retail-admin/feedback'],
      ['admin', 'GET', '/api/retail-admin/feedback?limit=1&offset=1'],
      ['admin', 'GET', '/api/retail-admin/feedback/2'],
      ['admin', 'POST', '/api/retail-admin/feedback/2/reply', { message: 'Thanks, fixed in the next build' }],
      ['admin', 'POST', '/api/retail-admin/feedback/2/reply', { message: '' }],
      ['customer', 'GET', '/api/retail/feedback/2'],
      // A second after the admin's reply: the inbox compares the two stamps
      // to the second, and a real customer never answers inside the same one.
      ['customer', 'POST', '/api/retail/feedback/2/reply', { message: 'Still broken' }, { afterMs: 1100 }],
      ['customer', 'POST', '/api/retail/feedback/999/reply', { message: 'Hello?' }],
      ['admin', 'GET', '/api/retail-admin/feedback'],
      ['admin', 'POST', '/api/retail-admin/feedback/2/handled'],
      ['admin', 'POST', '/api/retail-admin/feedback/2/unhandle'],
      ['admin', 'POST', '/api/retail-admin/feedback/999/handled'],
      ['admin', 'GET', '/api/retail-admin/feedback/unseen-count?since=2020-01-01'],
      ['anon', 'GET', '/api/retail-admin/feedback'],
    ],
  },

  reviews: {
    seed: ({ ins, customer }) => {
      const pid = ins('store_products', { name_en: 'Golden Bread', is_published: 1, is_active: 1 });
      const o1 = ins('retail_orders', { customer_id: customer, status: 'delivered', order_no: 'GLD1' });
      const o2 = ins('retail_orders', { customer_id: customer, status: 'delivered', order_no: 'GLD2' });
      ins('retail_reviews', { product_id: pid, customer_id: customer, order_id: o1, rating: 4, comment: 'nice', is_visible: 1 });
      ins('retail_reviews', { product_id: pid, customer_id: customer, order_id: o2, rating: 2, comment: '', is_visible: 1 });
      ins('retail_synthetic_reviews', { product_id: pid, rating: 5, comment: 'seeded', reviewer_name: 'S', is_visible: 1 });
      return { pid };
    },
    requests: ({ pid }) => [
      ['customer', 'GET', '/api/retail/reviews/pending'],
      ['anon', 'GET', '/api/retail/reviews/pending'],
      ['anon', 'GET', `/api/retail/products/${pid}/reviews`],
      ['anon', 'GET', `/api/retail/products/${pid}/reviews?page=2&limit=1`],
      ['anon', 'GET', '/api/retail/products/999999/reviews'],
      ['customer', 'POST', '/api/retail/review-photos', { data: PNG }],
      ['anon', 'POST', '/api/retail/review-photos', { data: PNG }],
      ['customer', 'POST', `/api/retail/products/${pid}/reviews`, { rating: 5, comment: 'great', order_id: 1, tags: ['fresh'] }],
      ['customer', 'POST', `/api/retail/products/${pid}/reviews`, {}],
      ['admin', 'GET', '/api/retail-admin/reviews'],
      ['admin', 'GET', '/api/retail-admin/reviews?status=waiting'],
      ['anon', 'GET', '/api/retail-admin/reviews'],
      ['admin', 'GET', '/api/retail-admin/reviews/unseen-count?since=2020-01-01'],
      ['admin', 'PATCH', '/api/retail-admin/reviews/1', { is_visible: false }],
      ['admin', 'POST', '/api/retail-admin/reviews/dismiss-waiting', { expect: 99 }],
      ['admin', 'POST', '/api/retail-admin/reviews/dismiss-waiting', { expect: 1 }],
      ['admin', 'POST', '/api/retail-admin/reviews/1/undismiss'],
      ['admin', 'DELETE', '/api/retail-admin/reviews/1'],
      ['admin', 'DELETE', '/api/retail-admin/reviews/1?source=synthetic'],
      ['admin', 'GET', '/api/retail-admin/reviews/reward'],
      ['admin', 'GET', '/api/retail-admin/reviews/topup'],
      ['admin', 'POST', '/api/retail-admin/reviews/topup/run', {}],
      ['anon', 'GET', `/api/retail/products/${pid}/reviews`],
    ],
  },

  customers: {
    seed: ({ ins, db }) => {
      const lin = ins('retail_customers', { openid: 'golden_lin', nickname: 'Lin', phone: '13800138000', points_balance: 120, balance: 50 });
      ins('retail_orders', { customer_id: lin, status: 'delivered', order_no: 'GLDC1', total: 88 });
      const store = db.prepare('SELECT id FROM retail_stores ORDER BY id LIMIT 1').get();
      return { lin, store: store ? store.id : 1 };
    },
    requests: ({ lin, store }) => [
      ['admin', 'GET', '/api/retail-admin/customers'],
      ['admin', 'GET', '/api/retail-admin/customers?q=Lin'],
      ['admin', 'GET', '/api/retail-admin/customers?q=nobody'],
      ['admin', 'GET', '/api/retail-admin/customers/export.csv'],
      ['admin', 'GET', '/api/retail-admin/customers/by-phone?phone=13800138000'],
      ['admin', 'GET', '/api/retail-admin/customers/by-phone?phone=13900000000'],
      ['admin', 'GET', `/api/retail-admin/customers/${lin}`],
      ['admin', 'GET', '/api/retail-admin/customers/999999'],
      ['admin', 'GET', `/api/retail-admin/customers/${lin}/history`],
      ['admin', 'POST', '/api/retail-admin/customers', { nickname: 'Walk-in', phone: '13700137000' }],
      ['admin', 'POST', '/api/retail-admin/customers', { nickname: 'Dup', phone: '13800138000' }],
      ['admin', 'POST', '/api/retail-admin/customers', {}],
      ['admin', 'PATCH', `/api/retail-admin/customers/${lin}`, { email: 'lin@example.com', phone: '13800138001' }],
      ['admin', 'PATCH', `/api/retail-admin/customers/${lin}`, { email: 'not-an-email' }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/points-adjust`, { delta: 30, reason: 'goodwill' }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/points-adjust`, { delta: -1000, reason: 'too much' }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/points-adjust`, { delta: 0 }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/wallet-adjust`, { delta: 12.5, reason: 'refund' }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/wallet-adjust`, { delta: -500, reason: 'too much' }],
      ['admin', 'GET', `/api/retail-admin/customers/${lin}`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/block`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/unblock`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/affiliate-block`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/affiliate-unblock`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/force-logout`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/reset-test`],
      ['admin', 'GET', `/api/retail-admin/customers/${lin}/addresses`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/addresses`, { recipient_name: 'Lin', phone: '13800138000', province: '广东省', city: '广州市', district: '天河区', address: '体育西路 1 号', is_default: true }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/addresses`, { recipient_name: 'Lin' }],
      ['admin', 'PUT', `/api/retail-admin/customers/${lin}/addresses/1`, { recipient_name: 'Lin W', phone: '13800138000', province: '广东省', city: '广州市', district: '天河区', address: '体育西路 2 号' }],
      ['admin', 'DELETE', `/api/retail-admin/customers/${lin}/addresses/999`],
      ['admin', 'DELETE', `/api/retail-admin/customers/${lin}/addresses/1`],
      ['admin', 'GET', `/api/retail-admin/customers/${lin}/counter-vouchers?store_id=${store}`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/counter-vouchers`, { store_id: store, voucher_id: 999 }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/referral-code`],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/message`, { message: 'Your order is ready' }],
      ['admin', 'POST', `/api/retail-admin/customers/${lin}/message`, { message: '' }],
      ['anon', 'GET', '/api/retail-admin/customers'],
      ['customer', 'GET', '/api/retail/customer'],
      ['anon', 'GET', '/api/retail/customer'],
      ['customer', 'PATCH', '/api/retail/customer', { nickname: 'Golden Two' }],
      ['customer', 'PATCH', '/api/retail/customer', {}],
      ['customer', 'POST', '/api/retail/customer/avatar', { data: PNG }],
      ['customer', 'POST', '/api/retail/customer/avatar', { data: 'not-an-image' }],
      ['customer', 'GET', '/api/retail/customer'],
    ],
  },

  // The customer's money path: price, quote, place, pay, cancel, refund,
  // reschedule, vouchers, top-ups. The app's clock is pinned to Wednesday
  // 2040-01-04 10:00 Shanghai (retail-golden.js), so the pickup times and
  // delivery slots below are real ones on that day. Payment runs in the code's
  // own dev mode: no WeChat Pay or Alipay keys are set, so "create" marks paid.
  checkout: {
    seed: ({ ins, db, customer }) => {
      const pid = ins('store_products', { name_en: 'Sourdough', is_published: 1, is_active: 1, sell_price: 28, retail_price: 28, stock_qty: 50 });
      const scarce = ins('store_products', { name_en: 'Last Croissant', is_published: 1, is_active: 1, sell_price: 12, retail_price: 12, stock_qty: 1 });
      db.prepare("UPDATE retail_stores SET is_active = 1, pickup_enabled = 1, open_time = '00:00', close_time = '23:59'").run();
      const store = db.prepare('SELECT id FROM retail_stores ORDER BY id LIMIT 1').get().id;
      ins('retail_store_stock', { store_id: store, product_id: pid, physical_qty: 50 });
      ins('retail_store_stock', { store_id: store, product_id: scarce, physical_qty: 1 });
      ins('retail_delivery_zones', { zone_type: 'city', name_en: 'Shanghai', match_city: '上海市', base_fee: 8, is_active: 1, slot_start_hour: 0, slot_end_hour: 24 });
      const addr = ins('retail_customer_addresses', { customer_id: customer, recipient_name: 'Golden', phone: '13800138000',
        province: '上海市', city: '上海市', district: '徐汇区', address: '复兴路 12 号', is_default: 1 });
      ins('retail_vouchers', { code: 'SAVE5', type: 'fixed_amount', value: 5, min_subtotal: 20, is_active: 1, is_public: 1,
        title_en: 'Save 5', expires_at: '2041-01-01 00:00:00' });
      ins('retail_topup_packages', { amount: 100, bonus_points: 10, title_en: 'Top up 100', is_active: 1 });
      // Earlier areas seeded orders of their own, so the two this area places
      // take the next ids, whatever those are.
      const next = (db.prepare('SELECT MAX(id) AS m FROM retail_orders').get().m || 0) + 1;
      return { pid, scarce, store, addr, o1: next, o2: next + 1 };
    },
    requests: ({ pid, scarce, store, addr, o1, o2 }) => {
      const pickup = (extra) => ({ items: [{ product_id: pid, qty: 2 }], fulfillment_type: 'pickup', pickup_store_id: store,
        pickup_name: 'Golden', pickup_phone: '13800138000', pickup_time: '2040-01-04T06:00:00.000Z', payment_method: 'wechat', ...extra });
      const delivery = (extra) => ({ items: [{ product_id: pid, qty: 1 }], fulfillment_type: 'delivery', address_id: addr,
        delivery_slot_id: '2040-01-04T14:00', payment_method: 'wechat', ...extra });
      return [
        ['anon', 'GET', '/api/retail/delivery-zones'],
        ['customer', 'POST', '/api/retail/cart/price', { items: [{ product_id: pid, qty: 2 }] }],
        ['customer', 'POST', '/api/retail/checkout/quote', { items: [{ product_id: pid, qty: 2 }], fulfillment_type: 'pickup', pickup_store_id: store }],
        ['customer', 'POST', '/api/retail/checkout/quote', { items: [{ product_id: pid, qty: 2 }], fulfillment_type: 'delivery', address_id: addr }],
        ['customer', 'POST', '/api/retail/checkout/quote', { items: [{ product_id: pid, qty: 2 }], fulfillment_type: 'delivery' }],
        ['customer', 'POST', '/api/retail/checkout/offers', { items: [{ product_id: pid, qty: 2 }] }],
        ['anon', 'GET', '/api/retail/vouchers/public'],
        ['customer', 'GET', '/api/retail/vouchers/auto?subtotal=56'],
        ['customer', 'POST', '/api/retail/vouchers/validate', { code: 'SAVE5', subtotal: 56, couponable_subtotal: 56 }],
        ['customer', 'POST', '/api/retail/vouchers/validate', { code: 'SAVE5', subtotal: 10, couponable_subtotal: 10 }],
        ['customer', 'POST', '/api/retail/vouchers/validate', { code: 'NOPE', subtotal: 56, couponable_subtotal: 56 }],
        // refusals before anything is written
        ['customer', 'POST', '/api/retail/orders', { items: [], fulfillment_type: 'pickup', payment_method: 'wechat' }],
        ['customer', 'POST', '/api/retail/orders', pickup({ payment_method: 'cash' })],
        ['customer', 'POST', '/api/retail/orders', pickup({ pickup_name: '' })],
        ['customer', 'POST', '/api/retail/orders', pickup({ pickup_time: '2040-01-03T00:00:00.000Z' })],
        ['customer', 'POST', '/api/retail/orders', pickup({ pickup_time: '2040-03-01T06:00:00.000Z' })],
        ['customer', 'POST', '/api/retail/orders', delivery({ delivery_slot_id: undefined })],
        ['customer', 'POST', '/api/retail/orders', delivery({ delivery_slot_id: '2040-01-04T03:00' })],
        ['customer', 'POST', '/api/retail/orders', pickup({ items: [{ product_id: scarce, qty: 3 }] })],
        ['anon', 'POST', '/api/retail/orders', pickup()],
        // order 1: pickup with a voucher, paid
        ['customer', 'POST', '/api/retail/orders', pickup({ voucher_code: 'SAVE5', idempotency_key: 'golden-1' })],
        ['customer', 'POST', '/api/retail/orders', pickup({ voucher_code: 'SAVE5', idempotency_key: 'golden-1' })],
        ['customer', 'GET', '/api/retail/orders/stats'],
        ['customer', 'POST', '/api/retail/payment/create', { order_id: o1 }],
        ['customer', 'GET', `/api/retail/payment/status/${o1}`],
        ['customer', 'POST', `/api/retail/orders/${o1}/cancel`, {}],
        ['customer', 'POST', `/api/retail/orders/${o1}/refund-request`, { reason: 'changed my mind', amount: 10 }],
        ['customer', 'POST', `/api/retail/orders/${o1}/refund-withdraw`, {}],
        ['customer', 'POST', `/api/retail/orders/${o1}/invoice-request`, { invoice_type: 'personal', invoice_title: 'Golden', invoice_email: 'golden@example.com' }],
        // The full list is read here, while only one order of this run exists:
        // two orders placed in the run could share a database second and tie.
        ['customer', 'GET', '/api/retail/orders'],
        // order 2: delivery, left unpaid, then moved and cancelled
        ['customer', 'POST', '/api/retail/orders', delivery({ customer_note: 'ring twice' })],
        ['customer', 'GET', `/api/retail/orders/${o2}/reschedule-options`],
        ['customer', 'POST', `/api/retail/orders/${o2}/reschedule`, { delivery_slot_id: '2040-01-05T10:00' }],
        ['customer', 'POST', `/api/retail/orders/${o2}/reschedule`, { delivery_slot_id: 'not-a-slot' }],
        ['customer', 'GET', `/api/retail/orders/${o2}/address-options`],
        ['customer', 'GET', `/api/retail/orders/${o2}/addon/availability`],
        ['customer', 'POST', `/api/retail/orders/${o2}/cancel`, {}],
        ['customer', 'POST', `/api/retail/orders/${o2}/cancel`, {}],
        // the lists after all of it
        ['customer', 'GET', '/api/retail/orders?status=paid'],
        ['customer', 'GET', `/api/retail/orders/${o1}`],
        ['customer', 'GET', `/api/retail/orders/${o2}`],
        ['customer', 'GET', '/api/retail/orders/999'],
        ['customer', 'GET', `/api/retail/orders/${o1}/delivery-track`],
        ['customer', 'GET', '/api/retail/orders/stats'],
        ['anon', 'GET', '/api/retail/orders'],
        // top-ups and points
        ['customer', 'GET', '/api/retail/topup-packages'],
        ['customer', 'POST', '/api/retail/topup/create', { package_id: 1 }],
        ['customer', 'GET', '/api/retail/topup/transactions'],
        ['customer', 'GET', '/api/retail/points/transactions'],
        ['customer', 'POST', '/api/retail/cart/price', { items: [{ product_id: scarce, qty: 1 }] }],
      ];
    },
  },
};

(async () => {
  const args = process.argv.slice(2);
  const update = args[0] === '--update' ? args[1] : null;
  if (args[0] === '--update' && !AREAS[update]) {
    console.error('usage: --update <' + Object.keys(AREAS).join('|') + '>');
    process.exit(2);
  }

  const app = await openApp();
  let pass = 0, fail = 0;
  const ok = (c, m, extra) => {
    if (c) { pass++; console.log('  ✓ ' + m); }
    else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
  };

  for (const [area, spec] of Object.entries(AREAS)) {
    console.log(`\n${area}`);
    const seeded = spec.seed(app);
    const got = [];
    for (const r of spec.requests(seeded)) got.push(await app.call(r));
    const file = path.join(GOLDEN_DIR, `retail-${area}.json`);

    if (update === area) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
      console.log(`  recorded ${got.length} answers → ${path.relative(process.cwd(), file)}`);
      continue;
    }
    if (!fs.existsSync(file)) { ok(false, `${area}: a recording exists`, `run --update ${area} on main first`); continue; }
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(want.length === got.length, `${area}: the same ${want.length} requests as recorded`, `recorded ${want.length}, sent ${got.length}`);
    for (let i = 0; i < Math.min(want.length, got.length); i++) {
      const a = JSON.stringify(want[i]), b = JSON.stringify(got[i]);
      ok(a === b, `${got[i].req} → ${got[i].status}`, a === b ? '' : `recorded ${a.slice(0, 300)}\n      now      ${b.slice(0, 300)}`);
    }
  }

  console.log('\nno request left the machine');
  ok(app.outbound.length === 0, 'every request stayed on the local server', app.outbound.slice(0, 3).join(' · '));

  await app.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
