#!/usr/bin/env node
/**
 * A delivery WINDOW is not late until it CLOSES — on the phone as on the desktop.
 *
 * Reported from the floor with a screenshot: order TC000608, a 今天 10:00–12:00
 * slot, read "已逾期 / overdue" in brick red at 10:07 — seven minutes INTO the
 * two-hour window the customer picked, and an hour and fifty-three minutes
 * before it closed. The same order on the desktop read "today". One order, two
 * screens, opposite answers.
 *
 * The cause was not a rendering difference. `scheduled_for` stores the window's
 * START; its END exists nowhere but the customer's free-text
 * `delivery_slot_label`. The desktop parses that end out (parseSlotEnd) and
 * anchors urgency on it (slotEndAnchor); m.html's reduced port took the same
 * five plan kinds and the same urgency thresholds but not the anchor, so every
 * windowed order on the phone went red at its own start time.
 *
 * The same anchor carries a second rule with it, and the phone was missing that
 * too: a DAY-ONLY pick is stored at shop midnight (the server's "a day, no
 * hour" sentinel), so anchoring on the raw instant made those orders read
 * overdue from 00:00 on their own delivery day — a full day early, every day.
 *
 * So this file asserts three things, and they are different in kind:
 *
 *   §1–§4  BEHAVIOURAL. The shipped phone helpers, lifted out of m.html and run
 *          against the REAL formatter with the clock frozen at the minute from
 *          the screenshot, plus the boundaries either side of it.
 *   §5     PARITY. The phone's anchor and the DESKTOP's, both lifted, fed the
 *          same orders, asserted equal. That is the defect stated as a test:
 *          the bug was the two disagreeing, so agreement is the fix.
 *   §6     STATIC. That a later edit cannot quietly hand the raw
 *          `scheduled_for` back to urgency. The wrong version is one token
 *          shorter than the right one and looks entirely ordinary in a diff.
 *
 * Nothing here is timezone-lucky: §4 runs the screenshot order again for a New
 * York shop, where every instant falls on a different clock and the answer must
 * not change.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const td = require('../public/td-datetime.js');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* Lifted out of the shipped files rather than re-typed, the same way
   test_phone_dates.js does it. A copy asserts what this file thinks the app
   does; the lift asserts what the app does. */
function slicer(src, name) {
  return {
    block(anchor) {
      const start = src.indexOf(anchor);
      if (start < 0) throw new Error(`not found in ${name}: ${anchor}`);
      const open = src.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
      }
      throw new Error(`unbalanced braces after ${anchor} in ${name}`);
    },
    line(anchor) {
      const start = src.indexOf(anchor);
      if (start < 0) throw new Error(`not found in ${name}: ${anchor}`);
      return src.slice(start, src.indexOf('\n', start));
    },
  };
}
const mob = slicer(M, 'public/m.html');
const desk = slicer(DESK, 'public/retail-admin/04-orders.js');

/* The clock is the whole subject here, so it is frozen rather than mocked
   around: `new Date()` and Date.now() answer the given instant, every other
   Date construction behaves normally. */
function frozenDate(atIso) {
  const at = new Date(atIso).getTime();
  return class D extends Date {
    constructor(...a) { if (a.length === 0) super(at); else super(...a); }
    static now() { return at; }
  };
}

const MOB_SRC = [
  mob.block('const _date=v=>'),
  mob.line('const _tdL='),
  mob.line('const shopToday='),
  mob.block('const shopDayAdd=(iso,n)=>'),
  mob.line('const shopDayOf='),
  mob.block('const shopTodayDate=()=>'),
  mob.line('function fmtTime(v)'),
  mob.block('function fmtDay(v)'),
  mob.block('function fmtDateOnly(v)'),
  mob.line('const _sched='),
  mob.line('const _pad2='),
  mob.block('function _slotEnd(start,label)'),
  mob.block('function _slotEndAnchor(scheduledFor,label)'),
  mob.block('function shipByPlan(r)'),
  mob.block('function shipByUrgency(p,actionable)'),
].join(';\n');

const DESK_SRC = [
  desk.block('function parseSchedFor(s)'),
  desk.block('function gzParts(d)'),
  desk.block('function gzWall(y, mo, da, h, mi)'),
  desk.block('function parseSlotEnd(start, label)'),
  desk.block('function slotEndAnchor(scheduledForIso, label)'),
].join(';\n');

/* One phone sandbox per (language, clock). td-datetime reads window.TD_TZ on
   EVERY call rather than caching it, which is what lets inZone() below put the
   same helpers in two different shops. */
function phone(lang, nowIso) {
  const ctx = {
    LANG: lang || 'en',
    T: (en, zh) => ((lang || 'en') === 'en' ? en : zh),
    tdWhen: td.tdWhen,
    tdFromShopLocal: td.tdFromShopLocal,
    Date: frozenDate(nowIso), Math, Number, String, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(MOB_SRC + ';\nthis.shipByPlan=shipByPlan; this.shipByUrgency=shipByUrgency;'
    + ' this.slotEndAnchor=_slotEndAnchor; this.slotEnd=_slotEnd;', ctx);
  return ctx;
}
function desktop(nowIso) {
  const ctx = { Date: frozenDate(nowIso), Math, Number, String, isNaN };
  vm.createContext(ctx);
  vm.runInContext(DESK_SRC + ';\nthis.slotEndAnchor=slotEndAnchor;', ctx);
  return ctx;
}
function inZone(tz, fn) {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
}
/* The one question every assertion below asks: what does the phone say about
   this order, right now? */
function level(order, nowIso, tz) {
  return inZone(tz || 'Asia/Shanghai', () => {
    const p = phone('en', nowIso);
    const plan = p.shipByPlan(order);
    if (!plan) return null;
    const actionable = order.status === 'paid' || order.status === 'preparing';
    return p.shipByUrgency(plan, actionable).level;
  });
}

/* The order from the screenshot. A Yuexiu delivery in a 10:00–12:00 Guangzhou
   window — scheduled_for is that window's START, stored UTC as the server
   writes it, and the label is the customer's own Chinese text. */
const WINDOWED = {
  status: 'preparing', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-08 02:00:00',          // 10:00 Guangzhou
  delivery_slot_label: '今天 10:00–12:00',
};

// ─────────────────────────────────────────────────────────────────────────
section('1 · the reported minute: 10:07, inside a 10:00–12:00 window');

is(level(WINDOWED, '2026-09-08T02:07:00Z'), 'today',
  'seven minutes into the window the order is due TODAY, not overdue',
  'this is the screenshot: 今天 10:00–12:00 · overdue at 10:07');
is(level(WINDOWED, '2026-09-08T01:30:00Z'), 'today',
  'half an hour BEFORE the window opens it is due today too');
is(level(WINDOWED, '2026-09-08T03:59:00Z'), 'today',
  'a minute before the window closes it is still merely due');

section('… and it does go overdue, at the hour the window actually closes');

is(level(WINDOWED, '2026-09-08T04:01:00Z'), 'overdue',
  'a minute after 12:00 the order IS late — the fix moves the deadline, not the rule');
is(level(WINDOWED, '2026-09-09T02:00:00Z'), 'overdue',
  'and stays late the next day');

/* Urgency is suppressed once the operator can no longer act on it. A shipped
   order's window is in the past by definition and crying overdue on a sent
   parcel is the noise this rule exists to stop. */
is(level({ ...WINDOWED, status: 'dispatched' }, '2026-09-09T02:00:00Z'), 'none',
  'a dispatched order carries no urgency at all, late window or not');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the window END is read wherever the customer\'s label puts it');

const CASES = [
  ['今天 10:00–12:00', 'the reported Chinese label, en-dash'],
  ['Today 10:00-12:00', 'an ASCII hyphen'],
  ['10:00 — 12:00', 'an em-dash with spaces'],
  ['10:00~12:00', 'a tilde, which the mini-app writes'],
  ['10:00 至 12:00', '至, the Chinese word for the range'],
  ['Today 10AM–12PM', 'AM/PM with no colons — the shape the HH:MM regex misses'],
  ['10:30 AM - 12 PM', 'mixed AM/PM, a half hour start and a bare hour end'],
];
for (const [label, why] of CASES) {
  is(level({ ...WINDOWED, delivery_slot_label: label }, '2026-09-08T02:07:00Z'), 'today',
    `${why} — "${label}" anchors on its end`);
}

/* A label with no window in it has no end to find, and must fall back to the
   stored instant rather than invent one. A 14:30 pickup IS late at 15:00. */
const TIMED = {
  status: 'paid', fulfillment_type: 'pickup',
  scheduled_for: '2026-09-08 06:30:00',          // 14:30 Guangzhou
  delivery_slot_label: '今天 14:30',
};
is(level(TIMED, '2026-09-08T06:00:00Z'), 'today', 'a single-time slot is due before its hour');
is(level(TIMED, '2026-09-08T07:00:00Z'), 'overdue', '…and overdue after it — no window, no reprieve');

/* Reading the end must never move a deadline EARLIER than the start we were
   given; a label we have misparsed should cost us nothing. */
is(level({ ...WINDOWED, delivery_slot_label: '今天 10:00–09:00' }, '2026-09-08T02:07:00Z'), 'overdue',
  'a backwards window is not trusted — it falls back to the stored start rather than inventing a deadline');
for (const junk of [null, undefined, '', 'ASAP', '今天', 'Today 25:00–99:99']) {
  const got = level({ ...WINDOWED, delivery_slot_label: junk }, '2026-09-08T02:07:00Z');
  yes(got === 'overdue' || got === 'today',
    `a label of ${JSON.stringify(junk)} yields a level rather than a throw (${got})`);
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · a day-only pick is not late at one minute past midnight');

/* The server's "a day, no hour" sentinel: scheduled_for at shop midnight, and a
   label carrying no clock. Anchored on the raw instant this reads overdue from
   00:00 on its OWN delivery day — which is what the phone did. */
const DAY_ONLY = {
  status: 'paid', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-07 16:00:00',          // 2026-09-08 00:00 Guangzhou
  delivery_slot_label: '今天',
};
is(level(DAY_ONLY, '2026-09-07T16:01:00Z'), 'today',
  'a minute past midnight on the delivery day the order is due today');
is(level(DAY_ONLY, '2026-09-08T09:00:00Z'), 'today',
  'and all through that day it is still merely due');
is(level(DAY_ONLY, '2026-09-06T16:01:00Z'), 'tomorrow',
  'the day before, it reads tomorrow');
is(level(DAY_ONLY, '2026-09-08T16:01:00Z'), 'overdue',
  'the day AFTER, it is genuinely late — a whole calendar day, not an hour');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the same order, a shop that is not in Guangzhou');

/* Every instant above falls on a different clock in New York, and the answer
   must not change: the window is the window wherever the shop keeps its books.
   A 10:00–12:00 slot for a New York shop is stored at 14:00 UTC. */
const NY = {
  status: 'preparing', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-08 14:00:00',          // 10:00 America/New_York (EDT)
  delivery_slot_label: 'Today 10:00–12:00',
};
is(level(NY, '2026-09-08T14:07:00Z', 'America/New_York'), 'today',
  'seven minutes in, a New York shop reads today as well');
is(level(NY, '2026-09-08T16:01:00Z', 'America/New_York'), 'overdue',
  'and overdue a minute after ITS noon, not Guangzhou\'s');

/* The phone learns its zone from the account (TD_TZ); the desktop pins +8 by
   hand. That divergence is deliberate and documented at the port — this is the
   check that the phone really is reading the account and not a constant. At
   15:00 UTC this order is an hour from closing for the New York shop that took
   it, and an hour past a deadline for a Guangzhou one, where a 10:00–12:00
   window on the GZ calendar day of that instant ends before the instant itself
   and is correctly discarded as backwards. One row, one moment, two shops. */
is(level(NY, '2026-09-08T15:00:00Z', 'America/New_York'), 'today',
  'an hour before its New York noon the order is still due');
is(level(NY, '2026-09-08T15:00:00Z', 'Asia/Shanghai'), 'overdue',
  '…and the shop\'s own zone is what decides — the same row, the same moment, a different answer');

// ─────────────────────────────────────────────────────────────────────────
section('5 · the phone and the desktop now agree, which is the defect stated as a test');

const PARITY = [
  [WINDOWED, 'the screenshot order'],
  [{ ...WINDOWED, delivery_slot_label: 'Today 10AM–12PM' }, 'an AM/PM window'],
  [TIMED, 'a single-time pickup'],
  [DAY_ONLY, 'a day-only pick at the midnight sentinel'],
  [{ ...WINDOWED, delivery_slot_label: '' }, 'an order with no label at all'],
  [{ ...WINDOWED, scheduled_for: '2026-12-24 02:00:00' }, 'a slot months out'],
];
const NOW = '2026-09-08T02:07:00Z';
for (const [o, why] of PARITY) {
  const phoneAnchor = inZone('Asia/Shanghai', () => phone('en', NOW).slotEndAnchor(o.scheduled_for, o.delivery_slot_label));
  const deskAnchor = desktop(NOW).slotEndAnchor(o.scheduled_for, o.delivery_slot_label);
  is(String(phoneAnchor), String(deskAnchor),
    `${why}: both screens anchor urgency on the same moment`);
}

/* The urgency LEVEL is what an operator actually reads, and the two files reach
   it by different ladders. Checked end to end for the reported order rather
   than trusting that equal anchors imply equal words. */
is(level(WINDOWED, NOW), 'today',
  'end to end, the phone reads the screenshot order the way the desktop always did');

// ─────────────────────────────────────────────────────────────────────────
section('6 · the raw start cannot come back');

/* The broken version is one token shorter than the correct one and reads
   perfectly naturally in a diff — `when:r.scheduled_for` is exactly what you
   would write if you had never seen this bug. Both call sites are pinned. */
const PLAN_SRC = mob.block('function shipByPlan(r)');
yes(/when:r\.scheduled_for\?_slotEndAnchor\(r\.scheduled_for,r\.delivery_slot_label\):null/.test(PLAN_SRC),
  'the pickup plan anchors on the window end',
  'a pickup slot handed its raw start to urgency reads overdue from the moment the counter opens');
yes(/when:_slotEndAnchor\(r\.scheduled_for,r\.delivery_slot_label\)/.test(PLAN_SRC),
  'the scheduled plan anchors on the window end');
yes(!/when:\s*r\.scheduled_for\s*[,|}]/.test(PLAN_SRC),
  'and NO plan passes the bare scheduled_for through as its urgency anchor',
  'that is the whole of the reported bug, in one property');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
