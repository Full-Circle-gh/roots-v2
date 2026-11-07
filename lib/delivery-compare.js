// The two delivery numbers on a Guangzhou order, and the gap between them.
// `wePaid` null means a rider has not been sent, or we do not yet know which
// price was charged. This figure is not part of the order total.
'use strict';

function round2(n) {
  return Math.round(n * 100) / 100;
}

function deliveryCompare(customerPaid, wePaid) {
  const customer = round2(Number(customerPaid) || 0);
  if (wePaid == null || wePaid === '') return { customer, we: null, gap: null };
  const we = Number(wePaid);
  if (!Number.isFinite(we)) return { customer, we: null, gap: null };
  return { customer, we: round2(we), gap: round2(we - customer) };
}

module.exports = { deliveryCompare };
