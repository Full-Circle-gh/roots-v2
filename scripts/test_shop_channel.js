#!/usr/bin/env node
/**
 * The `shop` channel, the shop-entry column, and the ledger channel that used
 * to be a literal.
 *
 *   node scripts/test_shop_channel.js
 *
 * THREE THINGS ARE LOCKED DOWN HERE, and only the third is a behaviour change.
 *
 * 1. `retail_orders.shop_entry_method` EXISTS AND IS NULL BY DEFAULT. It records
 *    which of a shop's two doors an order came through — the till or the QR menu
 *    (§44) — and it is deliberately NOT new values on `source`, which already
 *    answers "was this keyed by staff?". The test asserts the column is there and
 *    that an ordinary order does not acquire a value, because the whole claim of
 *    this change is that it is additive.
 *
 * 2. `shop` IS REGISTERED IN EVERY ENUMERATION THAT WOULD OTHERWISE DROP IT.
 *    Two of them are silent on an unknown value: the orders filter allowlist
 *    falls back to '' (the filter is discarded and the caller gets every order,
 *    reading as "the filter did nothing"), and the channel-counts object skips a
 *    key it does not declare (the chip shows nothing while the orders sit inside
 *    `all`, so the chips stop adding up). Both are asserted against the source,
 *    which is the only place the list exists — there is no runtime accessor to
 *    ask, and a future edit that drops one would otherwise be invisible.
 *
 * 3. THE STOCK LEDGER CARRIES THE ORDER'S REAL CHANNEL, NOT THE LITERAL
 *    'wechat'. This is the defect §44 names: a tender name standing where a
 *    channel belongs. `commitUnreservedOrder` is reached by out-of-Guangzhou
 *    orders, scheduled-ahead orders and every counter sale — precisely the
 *    orders that are NOT the mini app — and it wrote 'wechat' on all of them.
 *    Its mirror `reverseCommittedLedger` did the same, so a refund disagreed
 *    with its own decrement.
 *
 *    NULL still reads 'wechat', and that is not a guess: retail_orders.channel
 *    is DEFAULT 'wechat', so an absent value genuinely is a legacy mini-app
 *    order. That case is asserted too, because it is the one that must NOT move.
 *
 * Runs against a REAL sqlite database (data/roots.db, created by database.js on
 * require and gitignored). Every row it writes is namespaced to ids in the
 * 990000+ range and deleted on the way out, so it is re-runnable and leaves
 * nothing behind.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const inventory = require(path.join(ROOT, 'lib', 'inventory.js'));

const db = tdb();
let pass = 0;
const ok = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, `${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  console.log('  ✓ ' + label);
  pass++;
};

// Ids well outside anything real, so a developer's own database is untouched.
const STORE = 990001;
const PROD  = 990002;
const BASE  = 990100;
const ids   = [];

function cleanup() {
  try {
    db.prepare(`DELETE FROM retail_stock_ledger WHERE ref_table = 'retail_orders' AND ref_id >= ?`).run(BASE);
    for (const id of ids) db.prepare('DELETE FROM retail_orders WHERE id = ?').run(id);
    db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(STORE);
    db.prepare('DELETE FROM store_products WHERE id = ?').run(PROD);
    db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  } catch (e) { /* best effort — the fixture owns only its own ids */ }
}

process.on('exit', cleanup);
cleanup();   // in case a previous crashed run left rows behind

// ── Fixture ─────────────────────────────────────────────────────────────────
db.prepare(`INSERT INTO retail_stores (id, code, name_en, is_active, sort_order)
            VALUES (?, ?, ?, 1, 99)`).run(STORE, 'tst-shop-chan', 'Fixture store');
db.prepare('INSERT INTO store_products (id, name_en, sku) VALUES (?,?,?)')
  .run(PROD, 'Fixture product', 'TST-SHOP-CHAN');
db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)')
  .run(STORE, PROD, 100);

let seq = 0;
function makeOrder(channel) {
  const id = BASE + (++seq);
  ids.push(id);
  // NULL is written EXPLICITLY, not by omitting the column. Omitting it lets the
  // DEFAULT 'wechat' apply, which is a different row entirely — worth recording,
  // because it means a NULL channel can only be a row that predates the default,
  // i.e. genuinely legacy, which is exactly the population the fallback serves.
  db.prepare(`INSERT INTO retail_orders (id, order_no, status, store_id, fulfillment_type, channel)
              VALUES (?, ?, 'paid', ?, 'delivery', ?)`).run(id, 'R-TSC' + id, STORE, channel ?? null);
  return id;
}
const ledgerChannels = (orderId, reasonLike) => db.prepare(
  `SELECT DISTINCT channel FROM retail_stock_ledger
    WHERE ref_table = 'retail_orders' AND ref_id = ? AND reason = ?`
).all(orderId, reasonLike).map(r => r.channel);

// ── 1 · The column ──────────────────────────────────────────────────────────
console.log('\nretail_orders.shop_entry_method — the column, and its absence of a value:');

const cols = db.prepare('SELECT name, type, dflt_value FROM pragma_table_info(?)').all('retail_orders');
const entry = cols.find(c => c.name === 'shop_entry_method');
ok('the column exists', !!entry, true);
ok('it is TEXT', entry.type, 'TEXT');
ok('it has no default, so a row that says nothing stores NULL', entry.dflt_value, null);

const plain = makeOrder('manual');
ok('an ordinary order does not acquire a value — nothing writes this column yet',
   db.prepare('SELECT shop_entry_method AS m FROM retail_orders WHERE id = ?').get(plain).m, null);

// `source` is untouched and still means what it meant. Asserted here because the
// entire reason shop_entry_method exists is that this column was not widened.
ok('`source` still exists beside it, unwidened',
   cols.some(c => c.name === 'source'), true);

// ── 2 · The enumerations ────────────────────────────────────────────────────
console.log('\n`shop` is registered where an unknown channel would be dropped:');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const retailSrc = read('routes/retail.js');
const mSrc      = read('public/m.html');

// The orders filter allowlist. An unlisted value falls to '' and the filter is
// silently discarded — the caller gets every order and nothing says why.
const allowMatch = retailSrc.match(/const channel = \[([^\]]*)\]\.includes\(String\(query\.channel/);
ok('the orders filter allowlist is where it was expected', !!allowMatch, true);
ok('the orders filter allowlist accepts shop', /'shop'/.test(allowMatch[1]), true);

// The channel-counts object. A key it does not declare is skipped by
// `if (r.ch in out)`, so the chip reads nothing while the orders are in `all`.
const countsMatch = retailSrc.match(/const out = \{ all: 0,([^}]*)\}/);
ok('the channel-counts object is where it was expected', !!countsMatch, true);
ok('the channel-counts object declares shop', /shop: 0/.test(countsMatch[1]), true);

// The manual-order acceptance list. This one REFUSES rather than drops: an
// unlisted channel is a 400, which is what the till would meet on the first
// shop sale.
ok('the manual-order channel allowlist accepts shop',
   /const MANUAL_ORDER_CHANNELS = \[[^\]]*'shop'/.test(retailSrc), true);
// …but shop is NOT an origin: it is not an answer to "how did the customer reach
// us", so it must not join the New order form's picker.
ok('shop is not added to the operator-facing origin picker',
   /const MANUAL_ORDER_ORIGINS\s+= \[[^\]]*'shop'/.test(retailSrc), false);

// The phone. CH_BACK is the one that MISLABELS rather than drops — its read ends
// `|| 'miniapp'`, so an absent key is drawn as "Mini app".
ok('the phone order-channel map knows shop', /const CH_BACK=\{[^}]*shop:'shop'/.test(mSrc), true);
ok('the phone channel filter can request shop', /const CHANNEL_PARAM=\{[^}]*shop:'shop'/.test(mSrc), true);
ok('the phone chip row offers shop', /\{key:'shop',en:'Shop',zh:'门店'/.test(mSrc), true);

// The desktop label and the filter item.
ok('the desktop labels shop rather than printing the raw key',
   /if \(c === 'shop'\)\s+return cuT\('Shop', '门店'\);/.test(read('public/retail-admin/04-orders.js')), true);
ok('the desktop filter menu offers shop',
   /data-channel="shop"/.test(read('public/retail-admin.html')), true);

// ── 3 · The ledger channel ──────────────────────────────────────────────────
console.log('\nthe stock ledger carries the order\'s real channel, not a literal:');

for (const [channel, expected, label] of [
  ['manual', 'manual', 'a counter/staff-keyed order'],
  ['shop',   'shop',   'a shop order'],
  ['web',    'web',    'a web-storefront order'],
]) {
  const id = makeOrder(channel);
  const res = inventory.commitUnreservedOrder(id, [{ product_id: PROD, qty: 1 }], { note: 'R-TSC' + id });
  ok(`${label} commits`, res.committed, 1);
  ok(`${label} ledgers channel '${expected}', not 'wechat'`,
     ledgerChannels(id, 'order_prepare'), [expected]);

  const rev = inventory.reverseCommittedLedger(id, [{ product_id: PROD, qty: 1 }], { note: 'refund' });
  ok(`${label} reverses`, rev.reversed, 1);
  ok(`${label}'s reversal agrees with its own decrement`,
     ledgerChannels(id, 'order_reverse_ledger'), [expected]);
}

// THE CASE THAT MUST NOT MOVE. A legacy row with no channel is a mini-app order,
// because the column's default is 'wechat'. If this ever starts writing NULL the
// change has broken the thing it was careful about.
const legacy = makeOrder(null);
ok('the fixture really did leave the channel NULL',
   db.prepare('SELECT channel AS c FROM retail_orders WHERE id = ?').get(legacy).c, null);
inventory.commitUnreservedOrder(legacy, [{ product_id: PROD, qty: 1 }], { note: 'R-TSC' + legacy });
ok('a NULL-channel legacy order still ledgers wechat — unchanged by this work',
   ledgerChannels(legacy, 'order_prepare'), ['wechat']);

console.log(`\nPASS — ${pass} assertions held\n`);
