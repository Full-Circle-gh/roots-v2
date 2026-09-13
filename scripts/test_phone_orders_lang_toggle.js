#!/usr/bin/env node
/**
 * THE LANGUAGE TOGGLE HAD TO REACH THE ORDERS LIST, AND FOR THREE CELLS IT DID
 * NOT.
 *
 * `mapOrderRow` runs once, when the list is fetched, and its result is kept in
 * state.ordersView / state.liveOrders. `toggleLang` flips LANG and calls
 * render() — it never refetches, and so never re-maps. Any field mapOrderRow
 * finished into WORDS therefore kept the language the list was fetched in until
 * something else refetched it. An operator switching to 中文 got a Chinese app
 * with an English ship-by column down the right edge of every row, and the
 * reverse going back.
 *
 * Three fields were worded at map time:
 *
 *   deliv      deliveryLine(r)                the whole ship-by cell, all five
 *                                             plan kinds, plus the courier and
 *                                             waybill lines in the same cell
 *   placed     fmtDay(r.placed_at)            "Yesterday" / "昨天", and the
 *                                             date form under it
 *   routeNote  routingNote(r.routing_reason)  "rerouted · out of stock" etc.
 *
 * Everything else in that object was already safe, and safe in one of the two
 * ways this file states as its rule: a PAIR the row spreads through T() at
 * paint (`ship`, `status`, `fulfil`, `cust`, `pay`, `payStatus`), or RAW facts
 * worded at paint (`placedFull`, ITEM_TUPLE, shipByPlan's window, earlyShipFacts
 * — each commented with this same reason). The three above were the exceptions.
 *
 * This file asserts the fix the way the bug would actually be seen: map the row
 * ONCE in English, then render it in Chinese WITHOUT re-mapping, and read the
 * cell. A mapped-at-fetch string cannot pass that.
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

/* The shipped functions, lifted rather than re-typed — the approach the suites
   beside this one take. LANG is a live binding in the context, which is the
   whole point: the test flips it between the map and the render, exactly as
   toggleLang does. */
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
  mob.line('const MIRROR_CH='),
  mob.line('const isMirrorCh='),
  mob.line('const M_COURIER_MOVING='),
  mob.block('const DELIV_STATE='),
  mob.block('const DELIV_TONE='),
  mob.block('function deliveryState(r)'),
  mob.block('function courierLine(r)'),
  mob.block('function deliveryLine(r)'),
  mob.block('function delivCell(o)'),
  mob.block('function routingNotePair(reason)'),
].join(';\n');

function ctxFor(nowIso) {
  const ctx = {
    LANG: 'en',
    tdWhen: td.tdWhen,
    tdFromShopLocal: td.tdFromShopLocal,
    tdTimeWindow: td.tdTimeWindow,
    Date: frozenDate(nowIso), Math, Number, String, isNaN,
  };
  // T reads LANG off the context every call, exactly as the shipped one does.
  ctx.T = function (en, zh) { return ctx.LANG === 'en' ? en : (zh || en); };
  vm.createContext(ctx);
  vm.runInContext(MOB_SRC + ';\nthis.delivCell=delivCell; this.fmtDay=fmtDay;'
    + ' this.routingNotePair=routingNotePair; this.deliveryLine=deliveryLine;', ctx);
  return ctx;
}
function inZone(tz, fn) {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
}
const textOf = (html) => {
  const m = /text-align:right">([^<]*)</.exec(html) || /white-space:nowrap">([^<]*)</.exec(html);
  return m ? m[1] : null;
};
const subOf = (html) => {
  const m = /margin-top:1px">([^<]*)</.exec(html);
  return m ? m[1] : null;
};

const AT = '2026-09-12T10:47:00.000Z'; // 18:47 Guangzhou, Sep 12

/* The move that used to lose the language: map while the app is in English,
   then paint while it is in Chinese, with nothing re-fetched in between. */
function mapThenToggle(row, nowIso) {
  return inZone('Asia/Shanghai', () => {
    const ctx = ctxFor(nowIso);
    ctx.LANG = 'en';
    const mapped = { _row: row, placedAt: row.placed_at || null,
      routeNote: ctx.routingNotePair(row.routing_reason) };
    const en = { cell: ctx.delivCell(mapped), placed: ctx.fmtDay(mapped.placedAt),
      route: mapped.routeNote ? ctx.T(...mapped.routeNote) : '' };
    ctx.LANG = 'cn';                       // toggleLang does exactly this, then render()
    const cn = { cell: ctx.delivCell(mapped), placed: ctx.fmtDay(mapped.placedAt),
      route: mapped.routeNote ? ctx.T(...mapped.routeNote) : '' };
    return { en, cn };
  });
}

section('1 · the ship-by cell follows the toggle — a fresh batch');
{
  const { en, cn } = mapThenToggle({
    fulfillment_type: 'delivery', status: 'paid',
    promised_ship_date: '2026-09-12', promised_delivery_date: '2026-09-13',
  }, AT);
  is(textOf(en.cell), 'Arrives Tomorrow', 'mapped and painted in English');
  is(subOf(en.cell), 'made fresh · ship Today', 'and its sub-line');
  is(textOf(cn.cell), '明天送达', 'painted again in Chinese from the SAME mapped row');
  is(subOf(cn.cell), '现做 · 今天发货', 'and its sub-line follows too');
}

section('2 · it follows for the other plan kinds, not just the batch');
{
  const asap = mapThenToggle({ fulfillment_type: 'delivery', status: 'paid', placed_at: AT }, AT);
  is(textOf(asap.en.cell), 'Ship when ready', 'a courier order in English');
  is(textOf(asap.cn.cell), '备好即发', 'and in Chinese after the toggle');

  const booked = mapThenToggle({
    fulfillment_type: 'delivery', status: 'paid',
    scheduled_for: '2026-09-13 02:00:00',
    delivery_slot_label: 'Sep 13, 10:00 AM – 12:00 PM',
  }, AT);
  is(textOf(booked.en.cell), 'Tomorrow 10:00 AM – 12:00 PM', 'a booked slot in English');
  is(textOf(booked.cn.cell), '明天 10:00–12:00', 'and in Chinese after the toggle');

  const pickup = mapThenToggle({ fulfillment_type: 'pickup', status: 'paid' }, AT);
  is(textOf(pickup.en.cell), 'During pickup hours', 'a pickup in English');
  is(textOf(pickup.cn.cell), '营业时间内自取', 'and in Chinese after the toggle');
}

section('3 · the tracking half of the same cell follows too');
{
  /* deliveryLine reaches past the ship-by plan into live courier and waybill
     text on a moving order. That half was frozen by the same map. */
  const { en, cn } = mapThenToggle({
    fulfillment_type: 'delivery', status: 'dispatched',
    tracking_number: 'JDVC37829030835', tracking_carrier: 'jd',
    tracking_status: 'in_transit',
  }, AT);
  yes(/In transit/i.test(en.cell), 'a waybill reads in English', textOf(en.cell));
  yes(/运输中/.test(cn.cell), 'and in Chinese after the toggle', textOf(cn.cell));
}
{
  const { en, cn } = mapThenToggle({
    fulfillment_type: 'delivery', status: 'dispatched', is_local: true,
  }, AT);
  is(textOf(en.cell), 'no arrival time set', 'a local order with no ETA, in English');
  is(textOf(cn.cell), '未设送达时间', 'and in Chinese after the toggle');
}

section('4 · the placed stamp and the routing note follow');
{
  const y = mapThenToggle({ fulfillment_type: 'counter', status: 'paid',
    placed_at: '2026-09-11T10:47:00.000Z' }, AT);
  is(y.en.placed, 'Yesterday', 'a stamp from yesterday, in English');
  is(y.cn.placed, '昨天', 'and in Chinese after the toggle');

  const older = mapThenToggle({ fulfillment_type: 'counter', status: 'paid',
    placed_at: '2026-09-04T10:47:00.000Z' }, AT);
  is(older.en.placed, 'Sep 4', 'an older stamp takes the date form, in English');
  is(older.cn.placed, '9月4日', 'and the Chinese date form after the toggle');

  const r = mapThenToggle({ fulfillment_type: 'delivery', status: 'paid',
    routing_reason: 'fallback_no_stock', placed_at: AT }, AT);
  is(r.en.route, 'rerouted · out of stock', 'the routing note, in English');
  is(r.cn.route, '改派 · 缺货', 'and in Chinese after the toggle');
}

section('5 · a row with no plan still renders nothing, not "undefined"');
{
  const { en, cn } = mapThenToggle({ fulfillment_type: 'counter', status: 'paid' }, AT);
  is(en.cell, '', 'a counter order has no ship-by cell at all');
  is(cn.cell, '', 'in either language');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
