#!/usr/bin/env node
/**
 * The Booked tile on the phone, saying the right thing in the right language.
 *
 * Reported from the floor with a screenshot: order TC000692, opened in the
 * phone's order-detail drawer at 20:59 with the app in ENGLISH. The tile read:
 *
 *   BOOKED
 *   明天 10:00–12:00   [today]
 *
 * Two defects in one line, and they have separate causes.
 *
 * THE CHINESE. `delivery_slot_label` is the CUSTOMER's own frozen text —
 * computeDeliverySlots mints label_en OR label_cn at checkout, never both, and
 * only the one is stored. m.html's reduced port of shipByPlan handed that
 * string to the screen raw ("the stored label is used as-is", its own comment
 * said), so a customer who ordered in Chinese put Chinese on an English drawer
 * and vice versa. The desktop stopped doing this by rebuilding the line out of
 * the order's own data (slotWindowText, 04-orders.js §1.18); the phone now
 * carries the same two facts — `scheduled_for` IS the window start, and
 * _slotEnd already parses the end out of the label — as `plan.slot`, and words
 * them at render time in planLabel.
 *
 * THE PILL. `hrs < 24 → 'today'` is a DURATION bucket wearing a calendar word.
 * At 20:59 a 10:00–12:00 window the next morning closes fifteen hours out, and
 * fifteen is less than twenty-four, so the tile called tomorrow today. Nothing
 * about the label was wrong there: 明天 and today were measuring different
 * things and only ever agreed by accident. Overdue is still the instant's
 * question; today and tomorrow are the calendar's.
 *
 * The two fixes meet: the day WORD in the label and the day word in the pill
 * are now derived from the same `scheduled_for` on the same shop clock, so they
 * cannot contradict each other again.
 *
 *   §1  the reported order, at the reported minute, in both languages
 *   §2  the day word is derived, not echoed — a stale snapshot is overridden
 *   §3  the pill counts calendar days, at the boundaries either side
 *   §4  what must NOT be derived: the midnight sentinel, and unparseable rows
 *   §5  the orders-list row, which shows the same plan in half a card
 *   §6  a shop that is not in Guangzhou
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

/* Lifted out of the shipped file rather than re-typed — the same approach as
   test_phone_ship_by_window.js beside it. A copy asserts what this file thinks
   the app does; the lift asserts what the app does. */
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
  /* deliveryLine is the list row. It reaches past the ship-by plan into the
     tracking half of the same cell, so its neighbours come along — lifted, not
     stubbed, so the row under test is the shipped one. */
  mob.line('const MIRROR_CH='),
  mob.line('const isMirrorCh='),
  mob.line('const M_COURIER_MOVING='),
  mob.block('const DELIV_STATE='),
  mob.block('function deliveryState(r)'),
  mob.block('function courierLine(r)'),
  mob.block('function deliveryLine(r)'),
].join(';\n');

const DESK_SRC = [
  desk.block('function parseSchedFor(s)'),
  desk.block('function gzParts(d)'),
  desk.block('function gzWall(y, mo, da, h, mi)'),
  desk.block('function parseSlotEnd(start, label)'),
  desk.block('function slotEndAnchor(scheduledForIso, label)'),
  desk.block('function shipByUrgency(p, actionable)'),
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
function desktop(nowIso) {
  const ctx = { Date: frozenDate(nowIso), Math, Number, String, isNaN };
  vm.createContext(ctx);
  vm.runInContext(DESK_SRC + ';\nthis.shipByUrgency=shipByUrgency; this.slotEndAnchor=slotEndAnchor;', ctx);
  return ctx;
}
function inZone(tz, fn) {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
}
/* What the tile actually says: the headline as rendered, and the pill beside
   it. Asked of the shipped renderer, not of the plan, because the drawer's
   echo rule can drop a pill and that is part of the answer. */
function tile(order, nowIso, lang, tz) {
  return inZone(tz || 'Asia/Shanghai', () => {
    const p = phone(lang, nowIso);
    const plan = p.shipByPlan(order);
    const u = p.shipByUrgency(plan, order.status === 'paid' || order.status === 'preparing');
    const html = p.shipByTile({ plan, planUrgency: u });
    const pill = /class="pill"[^>]*>([^<]*)</.exec(html);
    return { label: p.planLabel(plan), level: u.level, pill: pill ? pill[1] : null, html };
  });
}

/* THE REPORTED ORDER. Booked for 10:00–12:00 the morning after it was read.
   The customer checked out in Chinese, so the stored label is Chinese, and the
   day word in it was minted the day they picked — see lib/slot-label.js. */
const TC000692 = {
  status: 'paid', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-14 02:00:00',            // 10:00 Guangzhou, Sep 14
  delivery_slot_label: '明天 10:00–12:00',
};
const AT_2059 = '2026-09-13T12:59:00Z';            // 20:59 Guangzhou, Sep 13

// ─────────────────────────────────────────────────────────────────────────
section('1 · the reported tile, at the reported minute');

{
  const en = tile(TC000692, AT_2059, 'en');
  is(en.label, 'Tomorrow 10:00 AM – 12:00 PM',
    'an English operator reads the window in English, on a 12-hour clock');
  yes(!/[一-鿿]/.test(en.label),
    'and there is no Chinese left in it at all', en.label);
  is(en.level, 'tomorrow', 'the order is due TOMORROW — fifteen hours out is not today');
  is(en.pill, 'tomorrow', 'so the pill says tomorrow, and no longer contradicts the line beside it');
}
{
  /* The same row, the same instant, the other language. §1.18: Chinese takes
     the 24-hour clock, which is also what the stored label happened to hold —
     so a Chinese operator sees no change, which is the point. */
  const cn = tile(TC000692, AT_2059, 'cn');
  is(cn.label, '明天 10:00–12:00', 'a Chinese operator reads the same window in Chinese');
  is(cn.pill, '明天', 'with the day word in Chinese too');
}
{
  /* An order taken in ENGLISH, read on a CHINESE phone — the same defect
     pointing the other way, which is the half a fix aimed only at the
     screenshot would have left shipping. */
  const enStored = { ...TC000692, delivery_slot_label: 'Tomorrow 10AM–12PM' };
  is(tile(enStored, AT_2059, 'cn').label, '明天 10:00–12:00',
    'an English-stored label reads as Chinese on a Chinese phone');
  is(tile(enStored, AT_2059, 'en').label, 'Tomorrow 10:00 AM – 12:00 PM',
    '…and the English rendering does not depend on which language it was stored in');
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · the day word is DERIVED, so a stale snapshot cannot survive it');

/* The whole reason the stored word cannot be trusted: computeDeliverySlots
   mints it from the clock at the moment the customer was PICKING and checkout
   freezes the string, so an order picked yesterday FOR TODAY still says 明天.
   Same row, read a day later. */
is(tile(TC000692, '2026-09-14T01:00:00Z', 'en').label, 'Today 10:00 AM – 12:00 PM',
  'on the delivery day itself the frozen "明天" is overridden, not echoed');
is(tile(TC000692, '2026-09-14T01:00:00Z', 'cn').label, '今天 10:00–12:00',
  '…in Chinese as well — the stored word loses to scheduled_for in both languages');
is(tile(TC000692, '2026-09-16T01:00:00Z', 'en').label, 'Sep 14, 10:00 AM–12:00 PM',
  'and once no relative word is honest, the date is named instead — with §1.18\'s own separator');
is(tile(TC000692, '2026-09-16T01:00:00Z', 'cn').label, '9月14日 10:00–12:00',
  '…whose separator differs by language, so it is asked for rather than assembled');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the pill counts calendar days, at the boundaries either side');

const at = (iso) => tile(TC000692, iso, 'en');
is(at('2026-09-13T15:59:00Z').level, 'tomorrow',
  'a minute before midnight it is still tomorrow');       // 23:59 Sep 13 GZ
is(at('2026-09-13T16:01:00Z').level, 'today',
  'a minute after midnight it becomes today — the calendar turns, not a countdown');
// 13:00 Sep 12 GZ — two calendar days before the slot, and 47 hours before the
// window closes. The old `hrs < 48` ladder called this tomorrow.
is(at('2026-09-12T05:00:00Z').level, 'later',
  'two days out is neither today nor tomorrow, however few hours short of 48 it is');
is(at('2026-09-14T04:01:00Z').level, 'overdue',
  'a minute after the window CLOSES it is late — the instant still decides that');
is(at('2026-09-14T03:59:00Z').level, 'today',
  '…and a minute before, it is merely due');

/* The desktop ran the same ladder and said the same wrong word, so it is fixed
   with the phone and checked against it here. Its level names are shared; only
   its colour scheme differs. */
{
  const d = desktop(AT_2059);
  const plan = {
    urgencyDate: d.slotEndAnchor(TC000692.scheduled_for, TC000692.delivery_slot_label),
    urgencyBasis: 'arrival', kind: 'scheduled',
  };
  is(d.shipByUrgency(plan, true).level, 'tomorrow',
    'the DESKTOP reads the same order the same way — the two screens agree');
  /* Under six hours is still red, because that is a claim about time remaining
     and not about a day. The tile badges it "⚠ in 3h" and names no day at all. */
  const soon = desktop('2026-09-14T01:00:00Z');       // 09:00 GZ, window shuts at 12:00
  const u = soon.shipByUrgency({
    urgencyDate: soon.slotEndAnchor(TC000692.scheduled_for, TC000692.delivery_slot_label),
    urgencyBasis: 'arrival', kind: 'scheduled',
  }, true);
  is(u.level, 'today', 'a window closing in three hours is today');
  yes(u.hrs != null && u.hrs < 6, 'and the hours survive for the red alert that rides on them', String(u.hrs));
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · what must NOT be derived');

/* The midnight sentinel with a clock in the label. scheduled_for is the
   server's "a day, no hour" value, so the ONLY record of the hour is the
   customer's words — deriving would silently drop it, and a wrong-but-English
   line is worse than a right-but-Chinese one. The same carve-out slotWindowText
   makes on the desktop. */
const MIDNIGHT_WITH_CLOCK = {
  status: 'paid', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-13 16:00:00',            // 2026-09-14 00:00 Guangzhou
  delivery_slot_label: '明天 10:00–12:00',
};
is(tile(MIDNIGHT_WITH_CLOCK, AT_2059, 'en').label, '明天 10:00–12:00',
  'a day-only row whose label carries the only clock keeps its stored words');

/* The midnight sentinel with NO clock: the DATE is the whole fact, so it is
   said freshly and says only the day. */
const DAY_ONLY = { ...MIDNIGHT_WITH_CLOCK, delivery_slot_label: '明天' };
is(tile(DAY_ONLY, AT_2059, 'en').label, 'Tomorrow',
  'a day-only row with no clock reads as the day alone, in the viewer\'s language');
yes(tile(DAY_ONLY, AT_2059, 'en').pill === null,
  'and its pill is dropped rather than printed twice — "Tomorrow · tomorrow" is the echo rule');

/* Nothing to derive from. Every one of these must yield the stored label back
   rather than an empty tile or a throw. */
for (const [row, why] of [
  [{ ...TC000692, scheduled_for: null }, 'no scheduled_for at all'],
  [{ ...TC000692, scheduled_for: 'not a date' }, 'an unparseable scheduled_for'],
]) {
  const got = inZone('Asia/Shanghai', () => {
    const p = phone('en', AT_2059);
    const plan = p.shipByPlan(row);
    return plan ? p.planLabel(plan) : null;
  });
  yes(typeof got === 'string' && got.length > 0,
    `${why}: the tile still says something rather than going blank (${JSON.stringify(got)})`);
}

/* The kinds that carry no window keep the labels they always had — this change
   reaches the two slot kinds and nothing else. */
is(inZone('Asia/Shanghai', () => {
  const p = phone('en', AT_2059);
  return p.planLabel(p.shipByPlan({ status: 'paid', fulfillment_type: 'delivery', ship_by_mode: 'asap' }));
}), 'Ship when ready', 'an ASAP order is untouched');
is(inZone('Asia/Shanghai', () => {
  const p = phone('en', AT_2059);
  return p.planLabel(p.shipByPlan({
    status: 'paid', fulfillment_type: 'delivery', promised_ship_date: '2026-09-14',
  }));
}), 'Tomorrow', 'a fresh-batch order is untouched');

// ─────────────────────────────────────────────────────────────────────────
section('5 · the ORDERS LIST row, which shows the same plan in half a card');

/* The row renders the same label, so it inherited the same Chinese and the same
   wrong word. It also has no room: the cell is capped at 52% of the row and does
   not wrap, so now that the label leads with the day word the tag beside it
   cannot repeat it. */
function row(order, nowIso, lang, tz) {
  return inZone(tz || 'Asia/Shanghai', () => phone(lang, nowIso).deliveryLine(order));
}
{
  const r = row(TC000692, AT_2059, 'en');
  is(r.text, 'Tomorrow 10:00 AM – 12:00 PM',
    'the row reads in English, and says the day word exactly once');
  is(r.tone, 'amber', 'and keeps the amber that made it worth reading — the colour is not the tag');
  is(row(TC000692, AT_2059, 'cn').text, '明天 10:00–12:00', 'the same row in Chinese');
}
{
  /* A row whose label cannot lead with a relative word still gets the tag —
     dropping it everywhere would lose the fact rather than de-duplicate it. */
  const far = row({ ...TC000692, scheduled_for: '2026-09-16 02:00:00' }, AT_2059, 'en');
  yes(!/·/.test(far.text), 'a slot three days out carries no relative tag at all', far.text);
  const late = row(TC000692, '2026-09-14T05:00:00Z', 'en');
  yes(/· overdue$/.test(late.text), 'and overdue is never dropped — it is not a day word', late.text);
}

// ─────────────────────────────────────────────────────────────────────────
section('6 · a shop that is not in Guangzhou');

/* Every instant above lands on a different clock in New York, and the phone
   reads the ACCOUNT's zone rather than a hardcoded +8. A 10:00–12:00 slot for a
   New York shop is stored at 14:00 UTC; 20:59 the evening before is 00:59 UTC. */
const NY = {
  status: 'paid', fulfillment_type: 'delivery',
  scheduled_for: '2026-09-14 14:00:00',            // 10:00 America/New_York (EDT)
  delivery_slot_label: 'Tomorrow 10:00–12:00',
};
const ny = tile(NY, '2026-09-14T00:59:00Z', 'en', 'America/New_York');   // 20:59 Sep 13 NY
is(ny.label, 'Tomorrow 10:00 AM – 12:00 PM', 'a New York shop reads its own window');
is(ny.level, 'tomorrow', 'and its own tomorrow');
is(tile(NY, '2026-09-14T00:59:00Z', 'en', 'Asia/Shanghai').level, 'today',
  '…while a Guangzhou shop, already past midnight, correctly reads the same row as today');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
