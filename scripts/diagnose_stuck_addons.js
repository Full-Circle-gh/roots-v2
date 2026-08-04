#!/usr/bin/env node
/**
 * Read-only triage of retail_order_addons rows stuck in status='pending'.
 *
 * A pending add-on is one that was staged and priced, handed to the gateway, and
 * never settled by a callback. finalizeOrderAddon() is still willing to settle
 * any of them, so the question for each is: was it actually paid and is the
 * customer owed items, or was it abandoned at the payment sheet?
 *
 * Every statement is a SELECT. The connection is opened read-only and PROVEN so
 * by attempting a CREATE TABLE and aborting if the write is accepted.
 */
'use strict';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');
const db = new Database(process.env.ROOTS_DB || '/root/roots-v2/data/roots.db', { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; console.log('read-only PROVEN — ' + e.message); }
if (!proven) { console.error('FATAL: write accepted'); process.exit(2); }

const all = db.prepare(`SELECT * FROM retail_order_addons ORDER BY id`).all();
const byStatus = {};
for (const a of all) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
console.log(`\n══ retail_order_addons: ${all.length} rows — ${JSON.stringify(byStatus)} ══`);

const payByOtn = db.prepare(`SELECT id, order_id, amount, status, transaction_id, completed_at
                               FROM retail_payments WHERE out_trade_no = ?`);
const itemsFor  = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(line_total),0) sum_line
                                FROM retail_order_items WHERE addon_id = ?`);
const orderOf   = db.prepare(`SELECT id, order_no, status, placed_at, paid_at, subtotal, total, payment_method
                                FROM retail_orders WHERE id = ?`);
const sibs      = db.prepare(`SELECT id, status, amount, created_at, paid_at FROM retail_order_addons
                               WHERE order_id = ? ORDER BY id`);

console.log('\n══ every PENDING add-on ══');
for (const a of all.filter(x => x.status !== 'success')) {
  let items = []; try { items = JSON.parse(a.items_json || '[]'); } catch (e) { items = []; }
  const pay = a.out_trade_no ? payByOtn.get(a.out_trade_no) : null;
  const inj = itemsFor.get(a.id);
  const o = orderOf.get(a.order_id) || {};
  const family = sibs.all(a.order_id);
  const sameItems = family.filter(f => f.id !== a.id && f.status === 'success').map(f => {
    const r = all.find(x => x.id === f.id);
    let it = []; try { it = JSON.parse(r.items_json || '[]'); } catch (e) { it = []; }
    return { id: f.id, amount: f.amount, sig: it.map(x => `${x.product_id}x${x.qty}`).sort().join(',') };
  });
  const mySig = items.map(x => `${x.product_id}x${x.qty}`).sort().join(',');
  const dup = sameItems.filter(s => s.sig === mySig);

  console.log(`\n  ── addon ${a.id}  order ${a.order_id} (${o.order_no || '?'})  status=${a.status}  amount=${a.amount}`);
  console.log(`     staged ${a.created_at}   out_trade_no=${a.out_trade_no || 'null'}`);
  console.log(`     transaction_id=${a.transaction_id || 'null'}   raw_callback_json=${a.raw_callback_json ? 'PRESENT' : 'null'}   paid_at=${a.paid_at || 'null'}`);
  console.log(`     retail_payments row for that out_trade_no: ${pay ? JSON.stringify(pay) : 'none'}`);
  console.log(`     retail_order_items carrying addon_id=${a.id}: n=${inj.n} sum_line=${inj.sum_line}`);
  console.log(`     items staged: ${items.map(i => `${i.name_en || i.product_id} x${i.qty} @${i.unit_price}`).join(' | ') || '(none)'}`);
  console.log(`     parent order: status=${o.status} placed=${o.placed_at} paid=${o.paid_at} total=${o.total} method=${o.payment_method}`);
  console.log(`     add-ons on this order: ${family.map(f => `${f.id}:${f.status}:${f.amount}`).join('  ')}`);
  console.log(`     a SETTLED sibling with the identical basket: ${dup.length ? dup.map(d => `addon ${d.id} (¥${d.amount})`).join(', ') : 'NONE'}`);
  const verdict = pay ? 'PAID BUT NOT SETTLED — customer is owed items'
    : (a.transaction_id || a.raw_callback_json) ? 'gateway responded but never settled — investigate'
    : dup.length ? 'abandoned retry — an identical basket settled under another add-on'
    : 'abandoned at the payment sheet — no gateway record, no settled twin';
  console.log(`     READING: ${verdict}`);
}

console.log('\n══ the reverse check: settled add-ons that did not land ══');
for (const a of all.filter(x => x.status === 'success')) {
  const inj = itemsFor.get(a.id);
  const pay = a.out_trade_no ? payByOtn.get(a.out_trade_no) : null;
  let items = []; try { items = JSON.parse(a.items_json || '[]'); } catch (e) { items = []; }
  const flag = [];
  if (inj.n !== items.length) flag.push(`items injected ${inj.n} != staged ${items.length}`);
  if (!pay) flag.push('no retail_payments row');
  if (flag.length) console.log(`   addon ${a.id} order ${a.order_id}: ${flag.join('; ')}`);
}
console.log('   (nothing listed above means every settled add-on injected its lines and recorded its payment)');

console.log('\n══ exposure: a pending row is still settleable ══');
const oldest = all.filter(x => x.status !== 'success').map(x => x.created_at).sort()[0];
console.log(`   finalizeOrderAddon() settles any row with status='pending'; the oldest is ${oldest}.`);
console.log(`   pending rows: ${all.filter(x => x.status !== 'success').length}, total staged value ¥${all.filter(x => x.status !== 'success').reduce((s, x) => s + (Number(x.amount) || 0), 0)}`);

console.log('\nRESULT=TRIAGE_COMPLETE');
db.close();
