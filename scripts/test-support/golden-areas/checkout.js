// Golden area: checkout. Loaded by scripts/test_retail_golden.js, which runs the
// areas in its own fixed order over one shared database (decisions §472).
'use strict';

// The customer's money path: price, quote, place, pay, cancel, refund,
// reschedule, vouchers, top-ups. The app's clock is pinned to Wednesday
// 2040-01-04 10:00 Shanghai (retail-golden.js), so the pickup times and
// delivery slots below are real ones on that day. Payment runs in the code's
// own dev mode: no WeChat Pay or Alipay keys are set, so "create" marks paid.
module.exports = {
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
};
