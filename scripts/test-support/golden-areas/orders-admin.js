// Golden area: orders-admin. Loaded by scripts/test_retail_golden.js, which runs
// the areas in its own fixed order over one shared database (decisions §472).
'use strict';

const SPACED = { afterMs: 1100 };

// The admin Orders screen's own workflow, over orders placed through the
// customer side so they are real ones. Runs after checkout, so the product,
// store and Shanghai zone that area seeded are here; three fresh orders are
// placed and taken down three paths:
//   (first) an unpaid order the next one cancels, as placing a new order does.
//   A — paid pickup: preparing, undo, preparing, dispatched, undo, dispatched,
//       delivered; note, tracking, ETA, a direct goodwill refund.
//   B — paid pickup: the customer asks for a refund; review, approve, pay out.
//   C — unpaid pickup: marked paid by hand, then cancelled.
// The courier, Meituan, JD and receipt-reading endpoints are not here: they
// talk to outside services and are recorded separately.
module.exports = {
  seed: ({ db }) => {
    const pid = db.prepare("SELECT id FROM store_products WHERE name_en = 'Sourdough'").get().id;
    const store = db.prepare('SELECT id FROM retail_stores ORDER BY id LIMIT 1').get().id;
    const next = (db.prepare('SELECT MAX(id) AS m FROM retail_orders').get().m || 0) + 1;
    return { pid, store, A: next + 1, B: next + 2, C: next + 3, superseded: next };
  },
  requests: ({ pid, store, A, B, C, superseded }) => {
    const pickup = (qty) => ({ items: [{ product_id: pid, qty }], fulfillment_type: 'pickup', pickup_store_id: store,
      pickup_name: 'Golden', pickup_phone: '13800138000', pickup_time: '2040-01-04T06:00:00.000Z', payment_method: 'wechat' });
    const o = (id, tail = '') => `/api/retail-admin/orders/${id}${tail}`;
    return [
      // Three real orders. Each is paid before the next is placed: placing a
      // new order cancels the customer's earlier unpaid one, which the first
      // two requests record on their own.
      //
      // Each placement waits a second ({ afterMs }), as real orders are always
      // apart. The admin list sorts by placed_at, stamped to the second with no
      // tie-breaker, so orders sharing a second would list oldest-first one
      // run and newest-first the next.
      ['customer', 'POST', '/api/retail/orders', pickup(1), SPACED],
      ['customer', 'POST', '/api/retail/orders', pickup(1), SPACED],
      ['admin', 'GET', o(superseded)],
      ['customer', 'POST', '/api/retail/payment/create', { order_id: A }],
      ['customer', 'POST', '/api/retail/orders', pickup(2), SPACED],
      ['customer', 'POST', '/api/retail/payment/create', { order_id: B }],
      ['customer', 'POST', '/api/retail/orders', pickup(3), SPACED],

      // the screen
      ['admin', 'GET', '/api/retail-admin/orders'],
      ['admin', 'GET', '/api/retail-admin/orders?status=paid'],
      ['admin', 'GET', '/api/retail-admin/orders?limit=2&offset=1'],
      ['admin', 'GET', '/api/retail-admin/orders/unseen-count?since=2020-01-01'],
      ['admin', 'GET', '/api/retail-admin/orders/export.csv'],
      ['admin', 'GET', o(A)],
      ['admin', 'GET', o(999999)],
      ['anon', 'GET', '/api/retail-admin/orders'],

      // A through every status, with both undo steps
      ['admin', 'PATCH', o(A, '/status'), { status: 'bogus' }],
      ['admin', 'PATCH', o(A, '/status'), { status: 'delivered' }],
      ['admin', 'PATCH', o(A, '/status'), { status: 'preparing' }],
      ['admin', 'POST', o(A, '/undo-preparing'), {}],
      ['admin', 'PATCH', o(A, '/status'), { status: 'preparing' }],
      ['admin', 'PATCH', o(A, '/status'), { status: 'dispatched' }],
      ['admin', 'POST', o(A, '/undo-dispatch'), {}],
      ['admin', 'PATCH', o(A, '/status'), { status: 'dispatched' }],
      ['admin', 'PATCH', o(A, '/note'), { staff_note: 'Leave at the front desk' }],
      ['admin', 'PUT', o(A, '/tracking'), { carrier: 'SF', tracking_number: 'SF1234567890' }],
      ['admin', 'DELETE', o(A, '/tracking')],
      ['admin', 'PUT', o(A, '/eta'), { eta: '16:00', reason: 'traffic' }],
      ['admin', 'DELETE', o(A, '/eta')],
      ['admin', 'PATCH', o(A, '/status'), { status: 'delivered' }],
      ['admin', 'PATCH', o(A, '/status'), { status: 'paid' }],
      ['admin', 'POST', o(A, '/refund/direct'), { amount: 5, note: 'goodwill' }],
      ['admin', 'POST', o(A, '/refund/direct'), { amount: 9999, note: 'too much' }],
      ['admin', 'GET', o(A, '/refund/events')],
      ['admin', 'GET', o(A)],

      // B: the customer's refund request, reviewed, approved, paid out
      ['customer', 'POST', `/api/retail/orders/${B}/refund-request`, { reason: 'wrong item', amount: 20 }],
      ['admin', 'POST', o(B, '/refund/review'), { amount: 20, note: 'checked the photo' }],
      ['admin', 'POST', o(B, '/refund/approve'), { amount: 20, note: 'approved' }],
      ['admin', 'POST', o(B, '/refund/payout'), { amount: 20, method: 'wechat', reference: 'golden-ref-1' }],
      ['admin', 'POST', o(B, '/refund/payout'), { amount: 20, method: 'wechat', reference: 'golden-ref-2' }],
      ['admin', 'GET', o(B, '/refund/events')],
      ['admin', 'POST', o(B, '/refund/reject'), {}],
      ['admin', 'GET', o(B)],

      // C: unpaid, marked paid by hand, cancelled
      ['admin', 'POST', o(C, '/remove-voucher'), {}],
      ['admin', 'PATCH', o(C, '/status'), { status: 'paid', pay_method: 'cash' }],
      ['admin', 'PATCH', o(C, '/status'), { status: 'cancelled', reason: 'customer asked' }],
      ['admin', 'PATCH', o(C, '/status'), { status: 'cancelled', reason: 'again' }],
      ['admin', 'GET', o(C)],

      // around the edges
      ['admin', 'GET', o(A, '/reroute')],
      ['admin', 'POST', o(A, '/reroute'), { store_code: 'nowhere' }],
      ['admin', 'POST', o(A, '/shipments/split'), { item_ids: [999999] }],
      ['admin', 'PUT', o(A, '/invoice'), {}],
      ['admin', 'POST', o(A, '/print'), {}],

      // a manual order from the counter, and a draft kept, edited and dropped
      ['admin', 'POST', '/api/retail-admin/orders', { fulfillment_type: 'counter', channel: 'manual', store_id: store, payment_method: 'offline',
        items: [{ product_id: pid, qty: 1 }], recipient_name: 'Walk-in', recipient_phone: '13700137000', status: 'paid' }, SPACED],
      ['admin', 'POST', '/api/retail-admin/orders', { items: [] }],
      ['admin', 'POST', '/api/retail-admin/order-drafts', { label: 'Phone order', payload: { items: [{ product_id: pid, qty: 2 }] } }],
      ['admin', 'GET', '/api/retail-admin/order-drafts'],
      ['admin', 'GET', '/api/retail-admin/order-drafts/1'],
      ['admin', 'PATCH', '/api/retail-admin/order-drafts/1', { label: 'Phone order (edited)', payload: { items: [{ product_id: pid, qty: 3 }] } }],
      ['admin', 'DELETE', '/api/retail-admin/order-drafts/1'],
      ['admin', 'GET', '/api/retail-admin/order-drafts/1'],

      // the screen afterwards
      ['admin', 'GET', '/api/retail-admin/orders?status=paid'],
      ['admin', 'GET', '/api/retail-admin/orders/unseen-count?since=2020-01-01'],
    ];
  },
};
