// Golden area: customers. Loaded by scripts/test_retail_golden.js, which runs the
// areas in its own fixed order over one shared database (decisions §472).
'use strict';

const { PNG } = require('../retail-golden');

module.exports = {
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
    // Each block is read back before it is undone: the unblock that follows
    // would otherwise leave the same end state whether the block did anything
    // or not, and a block that blocked nothing passed every suite.
    ['admin', 'POST', `/api/retail-admin/customers/${lin}/block`],
    ['admin', 'GET', `/api/retail-admin/customers/${lin}`],
    ['admin', 'POST', `/api/retail-admin/customers/${lin}/unblock`],
    ['admin', 'POST', `/api/retail-admin/customers/${lin}/affiliate-block`],
    ['admin', 'GET', `/api/retail-admin/customers/${lin}`],
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
};
