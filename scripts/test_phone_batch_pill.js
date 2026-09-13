#!/usr/bin/env node
/**
 * Reported from the floor with a screenshot: order TC000673, a fresh-batch
 * order, opened in the phone's order-detail drawer. The tile read:
 *
 *   DELIVER BY
 *   Tomorrow  [today]
 *   made fresh · ship Today
 *
 * "Tomorrow" next to a "today" pill reads as a straight contradiction, not
 * information. It is not a typo — both numbers are correct. A fresh-batch
 * plan's headline leads with the ARRIVAL date (Tomorrow) but the pill's word
 * is the SHIP date's urgency (today), because urgency is anchored on
 * `promised_ship_date` while the label is `promised_delivery_date`. The two
 * dates are legitimately a day apart; showing both, unlabelled, beside each
 * other reads as one date disagreeing with itself.
 *
 * The desktop already knew this: shipByPlan's own comment says a batch's
 * "today/tomorrow" word "would misread against the headline" and its list
 * cell (04-orders.js) and the phone's own list row (m.html's shipRowCell,
 * beneath shipByTile in this file) both suppress that word for kind==='batch'
 * — keeping it only for a genuine overdue. shipByTile, the drawer's version
 * of the same tile, had no such guard: its only suppression was an "echo"
 * check for when the label and the pill happen to be the SAME word, which a
 * batch's mismatched label/urgency pair never is. So the drawer showed
 * exactly the case the list row was already built to hide.
 *
 * This file asserts the drawer tile now agrees with the list row: a batch's
 * non-overdue pill is dropped (the ship day is already spelled out in the
 * sub-line), while a genuinely overdue batch still says so.
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
const section = (t) => console.log('\n' + t);

/* Lifted out of the shipped file rather than re-typed — same approach as
   test_phone_ship_by_window.js. */
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
].join(';\n');

function phone(nowIso) {
  const ctx = {
    LANG: 'en',
    T: (en) => en,
    tdWhen: td.tdWhen,
    tdFromShopLocal: td.tdFromShopLocal,
    tdTimeWindow: td.tdTimeWindow,
    Date: frozenDate(nowIso), Math, Number, String, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(MOB_SRC
    + ';\nthis.shipByPlan=shipByPlan; this.shipByUrgency=shipByUrgency; this.shipByTile=shipByTile;',
    ctx);
  return ctx;
}

section('1 · order TC000673 — ships today, arrives tomorrow');
{
  // Frozen at 14:31 Guangzhou time, same as the screenshot's clock.
  const ctx = phone('2026-09-12T06:31:00.000Z'); // 14:31 UTC+8
  const order = {
    fulfillment_type: 'delivery',
    status: 'paid',
    promised_ship_date: '2026-09-12',
    promised_delivery_date: '2026-09-13',
  };
  const plan = ctx.shipByPlan(order);
  yes(plan.kind === 'batch', 'the order resolves to a batch plan', plan && plan.kind);
  yes(plan.label === 'Tomorrow', 'the headline leads with the arrival date', plan.label);
  yes(plan.sub === 'made fresh · ship Today', 'the sub-line names the ship date', plan.sub);

  const u = ctx.shipByUrgency(plan, true);
  yes(u.level === 'today', 'urgency is anchored on the ship date, which is today', u.level);

  const html = ctx.shipByTile({ plan, planUrgency: u });
  yes(html.includes('>Tomorrow<'), 'the tile still shows the arrival-date headline', html);
  yes(!/class="pill"[^>]*>today</.test(html),
    'the tile does NOT also show a contradicting "today" pill beside it', html);
  // The colour the pill would have carried is not lost — it rides the headline
  // instead, the same trade the pre-existing "echo" case already makes.
  yes(/color:var\(--amber-ink\)/.test(html), 'the headline still carries the urgency colour', html);
}

section('2 · a genuinely late batch still says so');
{
  // Ship date has already passed — the make-fresh batch is overdue.
  const ctx = phone('2026-09-14T06:31:00.000Z'); // two days after the ship date
  const order = {
    fulfillment_type: 'delivery',
    status: 'paid',
    promised_ship_date: '2026-09-12',
    promised_delivery_date: '2026-09-13',
  };
  const plan = ctx.shipByPlan(order);
  const u = ctx.shipByUrgency(plan, true);
  yes(u.level === 'overdue', 'urgency reads overdue once the ship date has passed', u.level);
  const html = ctx.shipByTile({ plan, planUrgency: u });
  yes(/class="pill"[^>]*>overdue</.test(html), 'the tile keeps the overdue pill', html);
}

section('3 · a scheduled (non-batch) order is unaffected');
{
  // Booked orders never hit the batch-specific branch — the pre-existing
  // "same word" echo rule still governs them exactly as before.
  const ctx = phone('2026-09-12T06:31:00.000Z');
  const order = {
    fulfillment_type: 'delivery',
    status: 'paid',
    scheduled_for: '2026-09-13T04:00:00.000Z',
    delivery_slot_label: 'Sep 13, 12:00 PM',
  };
  const plan = ctx.shipByPlan(order);
  yes(plan.kind === 'scheduled', 'a customer-booked order is not a batch', plan.kind);
  const u = ctx.shipByUrgency(plan, true);
  /* THIS ROW USED TO EXPECT 'today', AND THAT EXPECTATION WAS THE BUG. The
     clock here is 14:31 on Sep 12 and the slot is noon on Sep 13 — twenty hours
     out, which the old hours-from-now ladder bucketed as today because 20 < 24.
     It is tomorrow, and TC000692 was reported from the floor for saying
     otherwise. The section's own subject is unchanged: a scheduled order still
     gets a relative-day pill where a batch does not. */
  yes(u.level === 'tomorrow', 'a slot on the next calendar day reads tomorrow, not today', u.level);
  const html = ctx.shipByTile({ plan, planUrgency: u });
  yes(/class="pill"[^>]*>tomorrow</.test(html),
    'a scheduled order still shows its relative-day pill when the label differs', html);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
