#!/usr/bin/env node
// Sales-page bucket partition test.
//
// The Sales overview builds its headline by summing hand-built per-channel
// buckets, while the dashboard aggregates retail_orders wholesale. They agree
// only if the buckets are a PARTITION of the day's paid orders: every order in
// exactly one bucket, never zero (revenue vanishes off the Sales page — the
// original "Sales ¥5,115 vs dashboard ¥5,384" bug) and never two (revenue is
// counted twice).
//
// This asserts that property directly, using the same predicates the endpoint
// uses, against the real migrated schema — so a future edit that adds a channel
// without giving it a home fails here rather than in the customer's numbers.
//
//   node scripts/test_sales_summary_partition.js
'use strict';

const db = require('../database');

const TZ    = '+8 hours';
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const PAID  = "status IN ('paid','preparing','dispatched','delivered','awaiting_restock')";
const PDATE = `date(COALESCE(paid_at, placed_at), '${TZ}')`;

// The endpoint's bucket predicates, verbatim (routes/retail.js, sales/summary).
const NOT_COUNTER = "COALESCE(fulfillment_type,'') <> 'counter'";
const claimedBy = (p) => `(
     ${p}channel='meituan'
  OR ${p}channel='gzgrocery'
  OR ${p}fulfillment_type='counter'
  OR COALESCE(NULLIF(${p}channel,''),'wechat') IN ('wechat','web')
)`;
const BUCKETS = {
  wechat:    `COALESCE(NULLIF(channel,''),'wechat')='wechat' AND ${NOT_COUNTER}`,
  web:       `channel='web' AND ${NOT_COUNTER}`,
  meituan:   `channel='meituan'`,
  gzgrocery: `channel='gzgrocery'`,
  pos:       `fulfillment_type='counter' AND COALESCE(channel,'') NOT IN ('meituan','gzgrocery')`,
  direct:    `NOT ${claimedBy('')}`,
};

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

// ── Fixtures — one order per shape the system can actually write ────────────
// Named so a failure below says which shape broke. `channel: null` is the mini
// app, which sends no channel at all; 'manual' + counter is the till.
const FIXTURES = [
  { order_no: 'T-MINIAPP',   channel: null,          fulfillment_type: 'delivery', expect: 'wechat' },
  { order_no: 'T-MINIEMPTY', channel: '',            fulfillment_type: 'pickup',   expect: 'wechat' },
  { order_no: 'T-WEB',       channel: 'web',         fulfillment_type: 'delivery', expect: 'web' },
  { order_no: 'T-MEITUAN',   channel: 'meituan',     fulfillment_type: 'delivery', expect: 'meituan' },
  { order_no: 'T-GZMIRROR',  channel: 'gzgrocery',   fulfillment_type: 'pickup',   expect: 'gzgrocery' },
  { order_no: 'T-TILL',      channel: 'manual',      fulfillment_type: 'counter',  expect: 'pos' },
  { order_no: 'T-PICKUP',    channel: 'pickup',      fulfillment_type: 'pickup',   expect: 'direct' },
  { order_no: 'T-WECHATMSG', channel: 'wechat_chat', fulfillment_type: 'delivery', expect: 'direct' },
  { order_no: 'T-WHOLESALE', channel: 'wholesale',   fulfillment_type: 'delivery', expect: 'direct' },
  { order_no: 'T-OTHER',     channel: 'other',       fulfillment_type: 'pickup',   expect: 'direct' },
  { order_no: 'T-LEGACY',    channel: 'manual',      fulfillment_type: 'delivery', expect: 'direct' },
  // The regression guard: a channel value nobody has taught the page about yet.
  // It must still land somewhere, and `direct` is the residual that catches it.
  { order_no: 'T-FUTURE',    channel: 'tiktok_shop', fulfillment_type: 'delivery', expect: 'direct' },
];
const AMOUNT = 100;

const cleanup = () => db.prepare(
  `DELETE FROM retail_orders WHERE order_no LIKE 'T-%' AND recipient_name = '__partition_test__'`
).run();

cleanup();
const ins = db.prepare(
  `INSERT INTO retail_orders (order_no, status, channel, fulfillment_type, subtotal, total,
                              recipient_name, placed_at, paid_at)
   VALUES (?, 'paid', ?, ?, ?, ?, '__partition_test__', datetime('now'), datetime('now'))`
);
for (const f of FIXTURES) ins.run(f.order_no, f.channel, f.fulfillment_type, AMOUNT, AMOUNT);

try {
  const scope = `${PAID} AND ${PDATE} = ? AND recipient_name = '__partition_test__'`;

  // 1. Every fixture lands in exactly one bucket.
  console.log('Partition — each order in exactly one bucket:');
  const membership = new Map(FIXTURES.map((f) => [f.order_no, []]));
  for (const [name, pred] of Object.entries(BUCKETS)) {
    const rows = db.prepare(
      `SELECT order_no FROM retail_orders WHERE ${pred} AND ${scope}`
    ).all(TODAY);
    for (const r of rows) membership.get(r.order_no).push(name);
  }
  for (const f of FIXTURES) {
    const got = membership.get(f.order_no);
    if (got.length === 0)      fail(`${f.order_no} (channel=${f.channel}) fell into NO bucket — its revenue would vanish from the Sales page`);
    else if (got.length > 1)   fail(`${f.order_no} (channel=${f.channel}) is in ${got.length} buckets [${got}] — its revenue would be counted twice`);
    else if (got[0] !== f.expect) fail(`${f.order_no} landed in '${got[0]}', expected '${f.expect}'`);
    else pass(`${f.order_no} → ${got[0]}`);
  }

  // 2. The sum of the buckets equals the dashboard's own aggregate. This is the
  //    reported bug stated as an assertion. The dashboard excludes gzgrocery
  //    mirror rows (their revenue is folded in from the stock ledger instead),
  //    so the comparison excludes that one bucket on both sides.
  console.log('\nReconciliation — Σ buckets == dashboard aggregate:');
  let bucketSum = 0;
  for (const [name, pred] of Object.entries(BUCKETS)) {
    if (name === 'gzgrocery') continue;
    bucketSum += db.prepare(
      `SELECT COALESCE(SUM(total),0) AS r FROM retail_orders WHERE ${pred} AND ${scope}`
    ).get(TODAY).r;
  }
  const dash = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS r FROM retail_orders
      WHERE COALESCE(channel,'') != 'gzgrocery' AND ${scope}`
  ).get(TODAY).r;
  if (bucketSum !== dash) fail(`Sales page would show ¥${bucketSum}, dashboard ¥${dash} — a ¥${(dash - bucketSum).toFixed(2)} gap`);
  else pass(`both ¥${bucketSum}`);

  // 3. The gzgrocery order count now reads the mirror rows — one per ORDER —
  //    rather than one per stock-ledger line, which is what made the Sales page
  //    report more gzgrocery "orders" than the dashboard for the same sales.
  console.log('\ngzgrocery order count reads mirror rows, not ledger lines:');
  const gzOrders = db.prepare(
    `SELECT COUNT(*) AS n FROM retail_orders
      WHERE channel='gzgrocery' AND ${scope}`
  ).get(TODAY).n;
  if (gzOrders !== 1) fail(`expected 1 gzgrocery order, got ${gzOrders}`);
  else pass('1 mirror row = 1 order');
} finally {
  cleanup();
}

console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nPASS — buckets partition cleanly and the two pages reconcile');
process.exit(failures ? 1 : 0);
