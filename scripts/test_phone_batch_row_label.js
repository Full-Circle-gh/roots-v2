#!/usr/bin/env node
/**
 * Reported from the floor with a screenshot: order TC000681 in the phone's
 * Orders list. The ship-by cell read
 *
 *   Tomorrow
 *   made fresh · ship Today
 *
 * and the report was three words long — "this is not clear". Both dates are
 * correct. A fresh-batch order carries two of them: the kitchen MAKES it on
 * promised_ship_date and the customer HAS it on promised_delivery_date, and the
 * cell prints the second over the first. Neither is labelled, so two relative
 * day words sit one line apart reading as a single date disagreeing with
 * itself — the same shape as the drawer's "Tomorrow [today]" pill that
 * test_phone_batch_pill.js beside this file was written for, arriving this time
 * through the wording rather than through the pill.
 *
 * The desktop does not have this problem because its batch cell prints a kicker
 * over the date — DELIVER BY (04-orders.js, `kickerShow: true`) — so its
 * "Sep 14 / made fresh · ship Sep 13" reads as a sequence. The phone's DRAWER
 * tile prints the same kicker (shipByTile's KICK map). The phone's LIST row is
 * a headline and a sub-line right-aligned under a 52% cap with no kicker at
 * all, and so had nowhere to say which day it meant.
 *
 * So the day word carries the verb itself, in the list row only: "Arrives
 * Tomorrow" where there is a delivery estimate, "Ship Today" where there is
 * not. This file asserts that, in both languages, that the drawer tile is NOT
 * double-labelled by the same change, and that no other plan kind moved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const td = require('../public/td-datetime.js');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is = (got, want, m) => yes(got === want, m, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log('\n' + t);

/* Lifted out of the shipped file rather than re-typed — the same approach as
   test_phone_batch_pill.js and test_phone_slot_day_word.js beside it. A copy
   asserts what this file thinks the app does; the lift asserts what it does. */
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

function frozenDate(atIso) {
  const at = new Date(atIso).getTime();
  return class D extends Date {
    constructor(...a) { if (a.length === 0) super(at); else super(...a); }
    static now() { return at; }
  };
}

const MOB_SRC = [
  mob.line('const escAttr='),
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
  mob.block('function _slotFacts(scheduledFor,label)'),
  mob.block('function planLabel(p)'),
  mob.block('function shipByPlan(r)'),
  mob.block('function shipByUrgency(p,actionable)'),
  mob.block('function shipByTile(o)'),
  /* deliveryLine is the row under test. It reaches past the ship-by plan into
     the tracking half of the same cell, so its neighbours come along — lifted,
     not stubbed, so the row asserted is the shipped one. */
  mob.line('const MIRROR_CH='),
  mob.line('const isMirrorCh='),
  mob.line('const M_COURIER_MOVING='),
  mob.block('const DELIV_STATE='),
  mob.block('function deliveryState(r)'),
  mob.block('function courierLine(r)'),
  mob.block('function deliveryLine(r)'),
].join(';\n');

function phone(lang, nowIso) {
  const ctx = {
    LANG: lang === 'cn' ? 'cn' : 'en',
    T: (en, zh) => (lang === 'cn' ? (zh || en) : en),
    tdWhen: td.tdWhen,
    tdFromShopLocal: td.tdFromShopLocal,
    tdTimeWindow: td.tdTimeWindow,
    Date: frozenDate(nowIso), Math, Number, String, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(MOB_SRC + ';\nthis.shipByPlan=shipByPlan; this.shipByUrgency=shipByUrgency;'
    + ' this.planLabel=planLabel; this.shipByTile=shipByTile; this.deliveryLine=deliveryLine;', ctx);
  return ctx;
}
function inZone(tz, fn) {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
}
const row = (order, nowIso, lang) =>
  inZone('Asia/Shanghai', () => phone(lang, nowIso).deliveryLine(order));

/* The reported order, and the clock it was read at: 18:47 Guangzhou on Sep 12,
   a batch the kitchen makes today for a customer who has it tomorrow. */
const TC000681 = {
  fulfillment_type: 'delivery',
  status: 'paid',
  promised_ship_date: '2026-09-12',
  promised_delivery_date: '2026-09-13',
};
const AT_1847 = '2026-09-12T10:47:00.000Z';

section('1 · TC000681 — the row says which day it means');
{
  const r = row(TC000681, AT_1847, 'en');
  is(r.text, 'Arrives Tomorrow', 'the headline names the day AND what happens on it');
  is(r.sub, 'made fresh · ship Today', 'the sub-line still carries the make/ship day');
  is(r.tone, 'amber', 'and keeps the amber the ship date earns it');
  yes(!/^Tomorrow/.test(r.text), 'it is no longer a bare day word beside a second one', r.text);
}
{
  const r = row(TC000681, AT_1847, 'cn');
  is(r.text, '明天送达', 'the same row in Chinese');
  is(r.sub, '现做 · 今天发货', 'and its sub-line');
}

section('2 · a batch with no delivery estimate is labelled too');
{
  /* The headline silently swaps to the SHIP date when there is no arrival
     estimate. Labelling only the two-date case would leave one batch row
     described and the next one bare, which is the same question asked again. */
  const noEta = { ...TC000681, promised_delivery_date: null };
  const r = row(noEta, AT_1847, 'en');
  is(r.text, 'Ship Today', 'the headline names the ship day as a ship day');
  is(r.sub, 'made fresh', 'and the sub-line is unchanged');
  is(row(noEta, AT_1847, 'cn').text, '今天发货', 'the same row in Chinese');
}

section('3 · a late batch still says it is late');
{
  const r = row(TC000681, '2026-09-14T10:47:00.000Z', 'en');
  is(r.text, 'Arrives Yesterday · overdue', 'the overdue tag survives the label');
  is(r.tone, 'brick', 'and the row is red');
  is(row(TC000681, '2026-09-14T10:47:00.000Z', 'cn').text, '昨天送达 · 已逾期', 'the same in Chinese');
}

section('4 · the drawer tile is not double-labelled');
{
  /* The tile prints "DELIVER BY" over the date itself, so the list row's verb
     would read "DELIVER BY / Arrives Tomorrow". The change is the row's alone. */
  const ctx = phone('en', AT_1847);
  const plan = ctx.shipByPlan(TC000681);
  const u = ctx.shipByUrgency(plan, true);
  const html = inZone('Asia/Shanghai', () => ctx.shipByTile({ plan, planUrgency: u }));
  yes(html.includes('>Tomorrow<'), 'the tile headline is still the bare arrival date', html);
  yes(html.includes('Deliver by'), 'because the kicker above it already says which day that is', html);
  yes(!/Arrives/.test(html), 'and the tile does not repeat the verb', html);
}

section('5 · no other plan kind moved');
{
  const asap = row({ fulfillment_type: 'delivery', status: 'paid', placed_at: AT_1847 }, AT_1847, 'en');
  is(asap.text, 'Ship when ready', 'a courier order with no date is untouched');
  is(asap.sub, 'courier', 'including its sub-line');

  const booked = row({
    fulfillment_type: 'delivery', status: 'paid',
    scheduled_for: '2026-09-13 02:00:00',
    delivery_slot_label: 'Sep 13, 10:00 AM – 12:00 PM',
  }, AT_1847, 'en');
  is(booked.text, 'Tomorrow 10:00 AM – 12:00 PM',
    'a customer-booked slot still leads with its own day word — it names itself');

  const pickup = row({ fulfillment_type: 'pickup', status: 'paid' }, AT_1847, 'en');
  is(pickup.text, 'During pickup hours', 'and a pickup is untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
