'use strict';

// A store the operator has switched off must go QUIET — no polling, no stock
// pushes, no login attempts, no ops pages — and must come straight back when it
// is switched on. This checks both halves:
//
//   Part 1  the decision itself (lib/channel-live), against fixtures, offline.
//           The real function, not a mirror, so it cannot pass against drifted
//           logic. Includes the two cases that would be silent disasters: a
//           pending open/close command must never read as closed (that is the
//           deadlock — closed, with no process left running to reopen it), and
//           an unknown store must read as OPEN, never muted by accident.
//
//   Part 2  the gates are actually wired into every daemon. Source-shape
//           assertions, in the manner of scripts/test_meituan_queue_stall.js: a
//           gate dropped in a later edit fails here loudly instead of quietly
//           costing a shop its sync.
//
// Then, if the real database is readable, it prints the live verdict per store,
// so the same command also answers "what is parked right now?" on the box.
//
//   node scripts/verify-channel-park.js

const fs = require('fs');
const path = require('path');
const { buildSnapshot, channelLive, storeLive, closedReason, MEITUAN } = require('../lib/channel-live');

let failures = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}

// ── Part 1: the decision ─────────────────────────────────────────────────────
// The shape of the real thing on 2026-08-24: Yuexiu switched off on every cell
// and 停业 on Meituan, Tianhe trading.
const snap = buildSnapshot(
  [
    { channel: 'eleme',     store_code: 'tianhe', is_open: 1 },
    { channel: 'mini_app',  store_code: 'tianhe', is_open: 1 },
    { channel: 'web',       store_code: 'tianhe', is_open: 1 },
    { channel: 'pos',       store_code: 'tianhe', is_open: 1 },
    { channel: 'gzgrocery', store_code: 'tianhe', is_open: 1 },
    { channel: 'eleme',     store_code: 'yuexiu', is_open: 0 },
    { channel: 'mini_app',  store_code: 'yuexiu', is_open: 0 },
    { channel: 'web',       store_code: 'yuexiu', is_open: 0 },
    { channel: 'pos',       store_code: 'yuexiu', is_open: 0 },
  ],
  [
    { store_code: 'tianhe', is_open: 1, target_open: null, fulfillment_open: 1 },
    { store_code: 'yuexiu', is_open: 0, target_open: null, fulfillment_open: 1 },
  ]
);

check('closed store: Meituan parked',        channelLive(MEITUAN, 'yuexiu', snap), false);
check('closed store: Eleme parked',          channelLive('eleme', 'yuexiu', snap), false);
check('closed store: reason is the channel', closedReason('eleme', 'yuexiu', snap), 'channel_closed');
check('closed store: location reads closed', storeLive('yuexiu', snap), false);
check('trading store: Meituan live',         channelLive(MEITUAN, 'tianhe', snap), true);
check('trading store: Eleme live',           channelLive('eleme', 'tianhe', snap), true);
check('trading store: location live',        storeLive('tianhe', snap), true);
check('trading store: no reason',            closedReason('eleme', 'tianhe', snap), null);

// The deadlock guard. A pending open/close command is applied by the very daemon
// this gate parks — park on it and the shop is shut with nothing left to reopen it.
const pendingOpen = buildSnapshot([], [
  { store_code: 'yuexiu', is_open: 0, target_open: 1, fulfillment_open: 1 },
]);
check('pending REOPEN command keeps Meituan awake', channelLive(MEITUAN, 'yuexiu', pendingOpen), true);
const pendingClose = buildSnapshot([], [
  { store_code: 'yuexiu', is_open: 0, target_open: 0, fulfillment_open: 1 },
]);
check('pending CLOSE command keeps Meituan awake',  channelLive(MEITUAN, 'yuexiu', pendingClose), true);

// The whole shutter beats every cell, on every channel including ones with no row.
const shut = buildSnapshot(
  [{ channel: 'eleme', store_code: 'yuexiu', is_open: 1 }],
  [{ store_code: 'yuexiu', is_open: 1, target_open: null, fulfillment_open: 0 }]
);
check('location closed beats an open cell',      channelLive('eleme', 'yuexiu', shut), false);
check('location closed beats Meituan open',      channelLive(MEITUAN, 'yuexiu', shut), false);
check('location closed: reason says so',         closedReason('eleme', 'yuexiu', shut), 'location_closed');
check('location closed: storeLive false',        storeLive('yuexiu', shut), false);

// Unknown reads as OPEN, everywhere. A new store, a channel with no cell yet, a
// status row never read back — none of them may be silently muted.
const empty = buildSnapshot([], []);
check('unknown store: channel live',             channelLive('eleme', 'brandnew', empty), true);
check('unknown store: Meituan live',             channelLive(MEITUAN, 'brandnew', empty), true);
check('unknown store: location live',            storeLive('brandnew', empty), true);
const neverRead = buildSnapshot([], [
  { store_code: 'fresh', is_open: null, target_open: null, fulfillment_open: null },
]);
check('never-read Meituan status: live',         channelLive(MEITUAN, 'fresh', neverRead), true);
const oneOff = buildSnapshot(
  [{ channel: 'eleme', store_code: 'mixed', is_open: 0 },
    { channel: 'web',  store_code: 'mixed', is_open: 1 }],
  []
);
check('one channel off: only that one parks',    channelLive('eleme', 'mixed', oneOff), false);
check('one channel off: the other stays live',   channelLive('web', 'mixed', oneOff), true);
check('one channel off: location still trading', storeLive('mixed', oneOff), true);

// ── Part 2: the gates are wired in ───────────────────────────────────────────
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MEITUAN_D = read('scripts/meituan-daemon.js');
const SHANGOU_D = read('scripts/shangou-daemon.js');
const ELEME_D   = read('scripts/eleme-daemon.js');
const QINGYUN_D = read('scripts/qingyun-daemon.js');

for (const [name, src] of [['meituan', MEITUAN_D], ['shangou', SHANGOU_D], ['eleme', ELEME_D]]) {
  check(`${name}-daemon reads the shared gate`, /require\('\.\.\/lib\/channel-live'\)/.test(src), true);
  check(`${name}-daemon parks on it`,           /function isParked\(/.test(src), true);
  check(`${name}-daemon logs the transition`,   /channel_parked/.test(src), true);
}
check('qingyun-daemon follows the LOCATION, not a channel', /storeLive/.test(QINGYUN_D), true);
check('qingyun-daemon parks on it',                         /function isParked\(/.test(QINGYUN_D), true);

// Order polling — the browser call that would otherwise run round the clock.
check('meituan: order poll skips parked',
  /\.filter\(s => !isParked\(s\.storeCode\)\)/.test(MEITUAN_D), true);
check('shangou: order poll skips parked',
  /isStoreOpen\(storeCode\) && !isParked\(storeCode\) && !inVerifyCooldown\(storeCode\)\) await pollOrders/.test(SHANGOU_D), true);
// Eleme has no stale-order sweep, so its poll must stay on while an order is in
// flight — the ONE place the park is deliberately conditional.
check('eleme: order poll honours in-flight orders',
  /!isParked\(cfg\.store_code\) \|\| hasInFlightOrders\(cfg\.store_code\)/.test(ELEME_D), true);

// Stock pushes — rows must be LEFT PENDING, never dropped, so a reopen resyncs.
check('meituan: push skips parked', /\.filter\(code => !isParked\(code\)\)/.test(MEITUAN_D), true);
check('shangou: push skips parked', /isStoreOpen\(code\) && !isParked\(code\)/.test(SHANGOU_D), true);
check('eleme: push skips parked',   /\.filter\(c => !isParked\(c\)\)/.test(ELEME_D), true);

// The reopen path must survive the park in both Meituan daemons.
for (const [name, src] of [['meituan', MEITUAN_D], ['shangou', SHANGOU_D]]) {
  check(`${name}: a pending command still applies while parked`,
    /if \(!cmd && isParked\(storeCode\)\) return;/.test(src), true);
}

// Canaries must excuse a parked store, or the park just changes which alert fires.
check('meituan: heartbeat excuses parked',
  /excused = !isStoreOpen\(storeCode\) \|\| isParked\(storeCode\)/.test(MEITUAN_D), true);
check('qingyun: alerts excuse parked',
  /if \(isParked\(storeCode\)\) return false;/.test(QINGYUN_D), true);

// ── Report ───────────────────────────────────────────────────────────────────
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`
    + (r.ok ? '' : `\n        expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`));
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);

// ── Live verdict (only where the real database is readable) ──────────────────
try {
  const db = require('../database');
  const stores = db.prepare('SELECT code FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id').all();
  const live = buildSnapshot(
    db.prepare('SELECT channel, store_code, is_open FROM channel_status').all(),
    db.prepare('SELECT store_code, is_open, target_open, fulfillment_open FROM store_business_status').all()
  );
  console.log('\nLive right now:');
  for (const s of stores) {
    const cells = [MEITUAN, 'eleme', 'mini_app', 'web', 'pos', 'gzgrocery']
      .map((ch) => `${ch}=${channelLive(ch, s.code, live) ? 'live' : 'PARKED'}`);
    console.log(`  ${s.code.padEnd(10)} location ${storeLive(s.code, live) ? 'trading' : 'CLOSED'}   ${cells.join('  ')}`);
  }
} catch (e) {
  console.log(`\n(live verdict skipped — database not readable here: ${e.message.split('\n')[0]})`);
}

process.exit(failures ? 1 : 0);
