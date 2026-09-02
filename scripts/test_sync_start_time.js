#!/usr/bin/env node
//
// test_sync_start_time.js — the store's own "Sync starts · 同步开始" time, from
// the daemons' gate down to the field the operator types it into.
//
// WHAT THIS IS FOR
// ----------------
// Meituan (外卖 and 闪购) and Eleme only move stock while their daemon considers
// a store inside its window, and that window used to be the store's OPENING
// hours plus a few minutes' grace. Customers place PRE-ORDERS hours before a
// shop opens, so a 10:00 store whose stock first moved at 09:45 quoted
// yesterday's numbers to every pre-order of the morning. The oversell that
// follows surfaces as a refund, never as an error on any screen — which is why
// the gate, not the alerting, is the thing this file pins down.
//
// The fix is one field on the store's own row (retail_stores.sync_start_time),
// read by every channel daemon through lib/store-hours.syncWindow(), because no
// single clock time fits every tenant: one shop opens at 10:00 and wants 08:00,
// another opens at 07:00 and wants nothing of the sort.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * lib/store-hours.js is the REAL module, loaded against a stub database
//     handle primed into require.cache (so no better-sqlite3 is needed). The
//     rows it parses are rows this file wrote, and the answers are its own.
//   * Each daemon's isStoreOpen IS LIFTED OUT OF THE DAEMON by source and run in
//     a vm against the real store-hours. A daemon that stops calling syncWindow,
//     or re-adds its own front grace on top of it, fails here — a copy of the
//     gate written in this file would not.
//   * coerceSyncStartTime is lifted the same way out of routes/retail-inventory.js.
//   * The two admin tabs' hint functions (mtEffectiveSyncStart /
//     elEffectiveSyncStart) are lifted out of the shipped JS and compared
//     against syncWindow() over a grid, so the time the screen promises is the
//     time the daemon will actually use.
//
// USAGE   node scripts/test_sync_start_time.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const HOME = path.join(__dirname, '..');
let failures = 0;
function ok(msg)   { console.log('   ✓ ' + msg); }
function fail(msg) { failures++; console.log('   ✗ ' + msg); }
function is(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(`${msg} → ${a}`);
  else fail(`${msg} → expected ${e}, got ${a}`);
}

// ── The stub store table ─────────────────────────────────────────────────────
// One fake better-sqlite3 handle, primed into require.cache as ../database so
// the real lib/store-hours.js loads without a driver. It answers exactly the two
// statements store-hours issues (with and without sync_start_time), which is
// also how the fallback read gets exercised further down.
let STORE_ROWS = [];
let allowSyncColumn = true;
const fakeDb = {
  prepare(sql) {
    if (/sync_start_time/.test(sql) && !allowSyncColumn) {
      throw new Error('no such column: sync_start_time');
    }
    const wantsSync = /sync_start_time/.test(sql);
    return {
      all: () => STORE_ROWS.map(r => (wantsSync ? { ...r } : {
        code: r.code, open_time: r.open_time, close_time: r.close_time,
      })),
    };
  },
};
require.cache[require.resolve('../database')] = {
  id: require.resolve('../database'), filename: require.resolve('../database'),
  loaded: true, exports: fakeDb,
};

const SH = require('../lib/store-hours');

// store-hours caches for 10 minutes; the tests below edit the table between
// assertions, so each one re-primes it through a fresh module instance.
function loadHours(rows, { syncColumn = true } = {}) {
  STORE_ROWS = rows;
  allowSyncColumn = syncColumn;
  delete require.cache[require.resolve('../lib/store-hours')];
  return require('../lib/store-hours');
}

// A Date at HH:MM Asia/Shanghai (UTC+8), which is the clock every one of these
// modules reads — never the host's.
function shanghai(hh, mm) {
  return new Date(Date.UTC(2026, 8, 2, hh - 8, mm, 0));
}

console.log('\n1. lib/store-hours — the window every channel daemon gates on');
{
  const sh = loadHours([
    { code: 'tianhe', open_time: '10:00', close_time: '20:00', sync_start_time: null },
    { code: 'yuexiu', open_time: '11:00', close_time: '20:15', sync_start_time: '08:00' },
    { code: 'late',   open_time: '10:00', close_time: '20:00', sync_start_time: '14:00' },
    { code: 'early',  open_time: '01:00', close_time: '09:00', sync_start_time: null },
  ]);
  const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  // The default: no time on file → the shared pre-open lead. A 10:00 shop syncs
  // from 08:00, which is the case that started all this.
  is(hm(sh.syncWindow(sh.storeHours('tianhe'), { graceMin: 15 }).open), '08:00',
     'no sync time on file, opens 10:00');
  // An explicit time is honoured exactly — not "two hours before whatever you
  // typed", and not widened again by the caller's grace.
  is(hm(sh.syncWindow(sh.storeHours('yuexiu'), { graceMin: 30 }).open), '08:00',
     'sync time 08:00, opens 11:00');
  // A time LATER than opening is clamped to opening: a mistyped 14:00 must not
  // mute the morning it was meant to protect.
  is(hm(sh.syncWindow(sh.storeHours('late'), { graceMin: 15 }).open), '10:00',
     'sync time 14:00 on a 10:00 shop is clamped to opening');
  // The lead can never push the start past midnight into the previous day.
  is(hm(sh.syncWindow(sh.storeHours('early'), { graceMin: 15 }).open), '00:00',
     'a 01:00 opening clamps at midnight, not -01:00');
  // The caller's own grace is a FLOOR, so no daemon ever gets a narrower window
  // than it had before this field existed.
  is(hm(sh.syncWindow(sh.storeHours('tianhe'), { leadMin: 0, graceMin: 30 }).open), '09:30',
     'lead 0 still leaves the caller its 30-minute grace');
  // No hours on file → null, which every daemon reads as always-on.
  is(sh.syncWindow(null, { graceMin: 15 }), null, 'a store with no hours stays always-on');
  is(sh.DEFAULT_PREOPEN_LEAD_MIN, 120, 'the default lead');
  const lead = v => (sh.envLeadMin(v) === undefined ? 'default' : sh.envLeadMin(v));
  is([lead(''), lead(undefined), lead('x'), lead('-5'), lead('45')],
     ['default', 'default', 'default', 'default', 45],
     'envLeadMin: unset/blank/junk fall back to the default, a number wins');
}

console.log('\n2. lib/store-hours — a database that has not migrated yet');
{
  // The column postdates the table and these daemons run for days, so a handle
  // whose migration has not landed must still yield HOURS. If the read threw all
  // the way out, every store would come back "no hours" = always-on, which is
  // the opposite failure: a merchant backend refreshing at 4am.
  const sh = loadHours(
    [{ code: 'tianhe', open_time: '10:00', close_time: '20:00' }],
    { syncColumn: false });
  const h = sh.storeHours('tianhe');
  is(h && [h.open, h.close, h.syncStart], [600, 1200, null],
     'hours still read, sync start simply absent');
  is(sh.syncWindow(h, { graceMin: 15 }).open, 480, 'and the default lead still applies');
}

console.log('\n3. The daemons\' own gate, lifted out of each daemon');
{
  const sh = loadHours([
    { code: 'tianhe', open_time: '10:00', close_time: '20:00', sync_start_time: null },
    { code: 'yuexiu', open_time: '11:00', close_time: '20:15', sync_start_time: '08:00' },
  ]);

  for (const [file, store, label] of [
    ['scripts/meituan-daemon.js', 'tianhe', '外卖'],
    ['scripts/shangou-daemon.js', 'yuexiu', '闪购'],
    ['scripts/eleme-daemon.js',   'tianhe', '饿了么'],
  ]) {
    const src = fs.readFileSync(path.join(HOME, file), 'utf8');
    const m = /\nfunction isStoreOpen\(storeCode, now = new Date\(\)\) \{[\s\S]*?\n\}/.exec(src);
    if (!m) { fail(`${file}: could not find isStoreOpen to lift`); continue; }
    const ctx = {
      storeHours: sh.storeHours, within: sh.within, syncWindow: sh.syncWindow,
      FORCE_OPEN_UNTIL: 0, OPEN_GRACE_MIN: /eleme/.test(file) ? 30 : 15,
      PREOPEN_LEAD_MIN: undefined,
      LEGACY_STORE_HOURS: {},
      Date, Math,
    };
    vm.createContext(ctx);
    vm.runInContext(m[0] + '\nthis.isStoreOpen = isStoreOpen;', ctx);
    const open = (h, mm) => ctx.isStoreOpen(store, shanghai(h, mm));
    // Both stores' windows open at 08:00 here — 天河 by the default lead off a
    // 10:00 opening, 越秀 by the explicit 08:00 on its row — so one clock covers
    // both the default path and the configured one.
    is(open(8, 30), true,  `${label} ${file}: syncing at 08:30 (window opens 08:00)`);
    is(open(9, 45), true,  `${label}: still syncing at 09:45`);
    is(open(4, 0),  false, `${label}: asleep at 04:00 — an idle backend is not refreshed at 4am`);
    is(open(23, 0), false, `${label}: asleep at 23:00`);
  }
}

console.log('\n4. routes/retail-inventory.js — what the API stores');
{
  const src = fs.readFileSync(path.join(HOME, 'routes/retail-inventory.js'), 'utf8');
  const m = /\nfunction coerceSyncStartTime\(raw\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) fail('could not find coerceSyncStartTime to lift');
  else {
    const ctx = { parseHm: SH.parseHm, String, Math, Number };
    vm.createContext(ctx);
    vm.runInContext(m[0] + '\nthis.coerce = coerceSyncStartTime;', ctx);
    const c = ctx.coerce;
    is(c('08:00'), '08:00', 'a plain time');
    is(c('8:00'),  '08:00', 'a short hour is zero-padded, so the daemon reads back what was typed');
    is(c(''),      null,    'blank clears it → back to the default lead');
    is(c(null),    null,    'absent clears it');
    is(c('25:00'), null,    'an impossible hour is refused rather than stored');
    is(c('soon'),  null,    'junk is refused');
  }
}

console.log('\n5. The admin tabs — the time the screen promises');
{
  const sh = loadHours([]);
  const grid = [
    { openTime: '10:00', syncStartTime: null,    expect: '08:00' },
    { openTime: '11:00', syncStartTime: '08:00', expect: '08:00' },
    { openTime: '10:00', syncStartTime: '14:00', expect: '10:00' },
    { openTime: '01:00', syncStartTime: null,    expect: '00:00' },
    { openTime: null,    syncStartTime: null,    expect: null    },
  ];
  for (const [file, prefix] of [
    ['public/retail-admin/11-meituan.js', 'mt'],
    ['public/retail-admin/14-eleme.js',   'el'],
  ]) {
    const src = fs.readFileSync(path.join(HOME, file), 'utf8');
    // The tab's own lead constant is lifted too, so raising it there without
    // raising it in lib/store-hours.js fails this file rather than quietly
    // printing a start time the daemon will not honour.
    const leadLine = new RegExp('\\n  const ' + prefix.toUpperCase() + '_SYNC_LEAD_MIN = \\d+;').exec(src);
    if (!leadLine) { fail(`${file}: could not lift the lead constant`); continue; }
    const parts = [`function ${prefix}Hm`, `function ${prefix}ParseHm`, `function ${prefix}EffectiveSyncStart`]
      .map(sig => {
        const i = src.indexOf('\n  ' + sig);
        if (i < 0) return null;
        const end = src.indexOf('\n  }', i);
        return end < 0 ? null : src.slice(i, end + 4);
      });
    if (parts.some(p => !p)) { fail(`${file}: could not lift the hint functions`); continue; }
    const ctx = { String, Math, Number };
    vm.createContext(ctx);
    vm.runInContext(leadLine[0] + parts.join('\n') + `\nthis.eff = ${prefix}EffectiveSyncStart;`, ctx);
    is(Number(/= (\d+);/.exec(leadLine[0])[1]), SH.DEFAULT_PREOPEN_LEAD_MIN,
       `${file}: the tab's lead matches lib/store-hours`);
    for (const g of grid) {
      is(ctx.eff({ openTime: g.openTime, syncStartTime: g.syncStartTime }), g.expect,
         `${file}: opens ${g.openTime || '—'}, sync ${g.syncStartTime || 'blank'}`);
      // …and the same case through the module the daemon itself uses, so the
      // screen and the daemon can never drift apart.
      if (g.openTime) {
        const hours = {
          open: SH.parseHm(g.openTime), close: SH.parseHm('20:00'),
          syncStart: SH.parseHm(g.syncStartTime),
        };
        const win = sh.syncWindow(hours, { graceMin: 15 });
        const asHm = String(Math.floor(win.open / 60)).padStart(2, '0') + ':' +
                     String(win.open % 60).padStart(2, '0');
        is(asHm, g.expect, `   …and lib/store-hours agrees`);
      }
    }
  }
}

console.log('\n6. The column exists to be written to');
{
  const src = fs.readFileSync(path.join(HOME, 'database.js'), 'utf8');
  is(/addColumn\('retail_stores', 'sync_start_time', 'TEXT'\);/.test(src), true,
     'database.js migrates retail_stores.sync_start_time');
  const inv = fs.readFileSync(path.join(HOME, 'routes/retail-inventory.js'), 'utf8');
  is(/'sync_start_time'/.test(inv.split('const allowed =')[1] || ''), true,
     'the store PATCH accepts the field');
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed\n` : '\n✓ all assertions held\n');
process.exit(failures ? 1 : 0);
