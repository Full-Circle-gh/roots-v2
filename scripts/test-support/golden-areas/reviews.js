// Golden area: reviews. Loaded by scripts/test_retail_golden.js, which runs the
// areas in its own fixed order over one shared database (decisions §472).
'use strict';

const { PNG } = require('../retail-golden');

module.exports = {
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
};
