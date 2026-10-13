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

  feedback: {
    seed: () => ({}),
    requests: () => [
      ['customer', 'POST', '/api/retail/feedback', { message: '' }],
      ['customer', 'POST', '/api/retail/feedback', { message: 'The cart button does nothing', page_context: 'cart', app_version: '1.2.3' }],
      ['customer', 'POST', '/api/retail/feedback', { message: 'Photo attached', photos: ['/api/retail/media/1', 'https://elsewhere.example/x.png'] }],
      ['anon', 'POST', '/api/retail/feedback', { message: 'no token' }],
      ['customer', 'GET', '/api/retail/feedback'],
      ['customer', 'GET', '/api/retail/feedback/1'],
      ['customer', 'GET', '/api/retail/feedback/999'],
      ['admin', 'GET', '/api/retail-admin/feedback/unseen-count?since=2020-01-01'],
      ['admin', 'GET', '/api/retail-admin/feedback'],
      ['admin', 'GET', '/api/retail-admin/feedback?limit=1&offset=1'],
      ['admin', 'GET', '/api/retail-admin/feedback/1'],
      ['admin', 'POST', '/api/retail-admin/feedback/1/reply', { message: 'Thanks, fixed in the next build' }],
      ['admin', 'POST', '/api/retail-admin/feedback/1/reply', { message: '' }],
      ['customer', 'GET', '/api/retail/feedback/1'],
      ['customer', 'POST', '/api/retail/feedback/1/reply', { message: 'Still broken' }],
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
