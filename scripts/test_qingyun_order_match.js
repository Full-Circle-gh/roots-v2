#!/usr/bin/env node
'use strict';
// scripts/qingyun-daemon.js — matchRetailOrderId, the link between a Qingyun
// rider and the order they are carrying.
//
// THE BUG THIS EXISTS FOR: the lookup knew meituan_order_import and nothing
// else, so an Eleme order never linked to its delivery. delivery_jobs.retail_order_id
// stayed null, the orders list never attached `courier`, and the row fell back to
// the platform's static ETA — no rider, no countdown, no map — while a Meituan
// order beside it showed all three off the same daemon and the same table.
//
// Eleme is invisible at the channel_name level: Qingyun files those deliveries
// under 淘宝闪购·餐饮, so the tests below deliberately feed that label (and a blank
// one) while linking purely on the platform order number. A fix that keyed on
// channel_name would pass a weaker test and fail in production.
//
// The daemon opens the real DB and starts polling on require, so the function is
// EXTRACTED BY NAME and run against an in-memory SQLite with the real table
// shapes — the same technique scripts/verify-fulfilment-types.js uses on the
// browser bundle. Nothing is stubbed except the daemon's logger.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

const SRC = fs.readFileSync(path.join(__dirname, 'qingyun-daemon.js'), 'utf8');

// Pull the const table and the function out of the daemon, by name. A rename
// breaks this loudly rather than silently testing nothing.
const grab = (re, what) => {
  const m = re.exec(SRC);
  if (!m) throw new Error(`could not extract ${what} from qingyun-daemon.js`);
  return m[0];
};
const KEYS_SRC  = grab(/^const CHANNEL_IMPORT_KEYS = \[[\s\S]*?^\];/m, 'CHANNEL_IMPORT_KEYS');
const MATCH_SRC = grab(/^function matchRetailOrderId\(d\) \{[\s\S]*?^\}/m, 'matchRetailOrderId');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, status TEXT,
    recipient_phone TEXT, channel TEXT);
  CREATE TABLE meituan_order_import (
    meituan_order_no TEXT UNIQUE NOT NULL, retail_order_id INTEGER);
  CREATE TABLE eleme_order_import (
    eleme_order_id TEXT UNIQUE NOT NULL, retail_order_id INTEGER);
`);
const mkOrder = (no, ch, status = 'dispatched', phone = null) =>
  db.prepare('INSERT INTO retail_orders (order_no, status, recipient_phone, channel) VALUES (?,?,?,?)')
    .run(no, status, phone, ch).lastInsertRowid;

const MT_ORDER = mkOrder('MT20260901111111', 'meituan');
const EL_ORDER = mkOrder('EL20260901417897', 'eleme');
const OWN_ORDER = mkOrder('TC000331', 'wechat', 'paid', '13800138000');
db.prepare('INSERT INTO meituan_order_import VALUES (?,?)').run('MT-PLATFORM-9911223344', MT_ORDER);
db.prepare('INSERT INTO eleme_order_import   VALUES (?,?)').run('EL-PLATFORM-8877665544', EL_ORDER);

const logged = [];
const matchRetailOrderId = new Function('db', 'log', `
  ${KEYS_SRC}
  ${MATCH_SRC}
  return matchRetailOrderId;
`)(db, (tag, msg) => logged.push(`${tag}: ${msg}`));

const job = (over) => Object.assign({
  channelOrderId: '', channelName: '', userRemark: '', recipientPhone: '',
}, over);

console.log('\nmatchRetailOrderId — linking a rider to the order they carry');

it('links a Meituan delivery by its platform order number', () => {
  assert.strictEqual(
    matchRetailOrderId(job({ channelOrderId: 'MT-PLATFORM-9911223344', channelName: '美团外卖' })),
    MT_ORDER);
});

// The reported bug, at the label production actually uses.
it('links an Eleme delivery filed by Qingyun as 淘宝闪购·餐饮', () => {
  assert.strictEqual(
    matchRetailOrderId(job({ channelOrderId: 'EL-PLATFORM-8877665544', channelName: '淘宝闪购·餐饮' })),
    EL_ORDER);
});
// channel_name must not be load-bearing: Qingyun has already renamed this
// channel once, and the next rename must not silently unlink every Eleme rider.
it('...and links it under any channel label, including none at all', () => {
  for (const channelName of ['饿了么', '淘宝闪购', '', null]) {
    assert.strictEqual(
      matchRetailOrderId(job({ channelOrderId: 'EL-PLATFORM-8877665544', channelName })),
      EL_ORDER, `channelName=${JSON.stringify(channelName)}`);
  }
});
it('tolerates the aggregator wrapping the id with a prefix or suffix', () => {
  assert.strictEqual(
    matchRetailOrderId(job({ channelOrderId: 'ELE_EL-PLATFORM-8877665544_A', channelName: '淘宝闪购·餐饮' })),
    EL_ORDER);
});
it('an unknown platform number links to nothing, never to a guess', () => {
  assert.strictEqual(
    matchRetailOrderId(job({ channelOrderId: 'ZZ-NOT-A-REAL-ORDER-0001', channelName: '淘宝闪购·餐饮' })),
    null);
});
it('a mirrored order not yet imported links to nothing', () => {
  db.prepare('INSERT INTO eleme_order_import VALUES (?,?)').run('EL-PENDING-0001', null);
  assert.strictEqual(matchRetailOrderId(job({ channelOrderId: 'EL-PENDING-0001' })), null);
});

// The fallbacks below the channel lookup must survive it.
console.log('\n...without costing the first-party order its own fallbacks');

it('a self-pushed order still links by the order_no in its 备注', () => {
  assert.strictEqual(matchRetailOrderId(job({ userRemark: 'TC000331 · 14:30-15:30' })), OWN_ORDER);
});
it('and by recipient phone when the 备注 carries a customer note', () => {
  assert.strictEqual(
    matchRetailOrderId(job({ userRemark: '环保单，顾客不需要附带餐具', recipientPhone: '138 0013 8000' })),
    OWN_ORDER);
});

// A tenant DB predating one mirror table must lose that channel only. Before the
// per-table guard this threw straight past both fallbacks above.
it('a missing mirror table skips that channel, it does not abort the match', () => {
  const db2 = new Database(':memory:');
  db2.exec(`
    CREATE TABLE retail_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, status TEXT,
      recipient_phone TEXT, channel TEXT);
    CREATE TABLE meituan_order_import (
      meituan_order_no TEXT UNIQUE NOT NULL, retail_order_id INTEGER);
  `);   // no eleme_order_import at all
  const own = db2.prepare("INSERT INTO retail_orders (order_no, status) VALUES ('TC000900','paid')")
                 .run().lastInsertRowid;
  const skips = [];
  const m2 = new Function('db', 'log', `
    ${KEYS_SRC}
    ${MATCH_SRC}
    return matchRetailOrderId;
  `)(db2, (tag, msg) => skips.push(msg));
  assert.strictEqual(
    m2(job({ channelOrderId: 'EL-PLATFORM-8877665544', userRemark: 'TC000900 · asap' })),
    own, 'the 备注 fallback must still be reached');
  assert.ok(skips.some((s) => /eleme_order_import/.test(s)), 'the skip should be logged, not silent');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
