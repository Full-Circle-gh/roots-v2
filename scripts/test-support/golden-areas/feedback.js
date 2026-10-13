// Golden area: feedback. Loaded by scripts/test_retail_golden.js, which runs the
// areas in its own fixed order over one shared database (decisions §472).
'use strict';

// One thread is seeded with a fixed stamp and never touched; every action
// goes to the one thread created during the run. The inbox lists sort by
// latest activity with no tie-breaker, and the database stamps live rows to
// the second, so two live threads would come out in either order depending
// on whether a second ticked over between them.
module.exports = {
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
};
