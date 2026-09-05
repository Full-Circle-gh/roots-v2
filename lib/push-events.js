// The events a person can be notified about, and which of them they want
// (audit E-10).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// A member of staff had two switches: a chime in this browser, and push on or
// off for the device in their hand. That is all of it. A warehouse clerk who
// wanted to hear about picks and nothing else had one choice — everything, or
// nothing — and "nothing" is what somebody picks when the phone buzzes all day
// for other people's work. The switch that gets used is the one that turns the
// whole thing off, and then the pick that mattered arrives nowhere.
//
// ── THE SHAPE OF THE ANSWER ───────────────────────────────────────────────
// Four kinds of thing are pushed to an operator today. Each is now a switch,
// and each starts ON — an absent preference is consent, so nobody's phone goes
// quiet because this shipped.
//
// AN EVENT NOT LISTED HERE IS NEVER MUTED. A sender added next year reaches
// people until somebody adds it to this list, which is the safe direction to
// fail in: the alternative is a new alert that is silently off for everybody
// and nobody can find the switch.
//
// ── WHY THERE ARE NO QUIET HOURS ──────────────────────────────────────────
// The audit named quiet hours alongside per-event preferences. They are
// deliberately not here. A shop that trades in the evening would have its
// evening silenced by a setting typed once, an operational alert dropped by a
// clock is indistinguishable from one that failed, and the shop's day already
// has enough places that guess a time zone. Choosing by KIND is the control
// that says what somebody actually means: not "not now", but "not mine".

'use strict';

// key      — stored in push_event_optouts.event, and carried on the payload
//            as `event` by the sender.
// needAny  — the capabilities that make this event reach somebody at all.
//            Empty means everybody on the account. Used ONLY to tell a person
//            which switches are live for them; the real audience is decided at
//            send time by routes/push.js, and this list never widens it.
const EVENTS = [
  {
    key: 'new_order',
    labelEn: 'New orders', labelCn: '新订单',
    descEn: 'A customer has paid, or an order is waiting on stock.',
    descCn: '顾客已付款,或订单正在等待补货。',
    needAny: [],
  },
  {
    key: 'restock',
    labelEn: 'Stock moving between locations', labelCn: '门店调拨',
    descEn: 'Something has been asked for, picked, sent, or counted in.',
    descCn: '有调拨被申请、拣货、发出或点收。',
    needAny: ['restock:pick', 'restock:receive', 'restock:request', 'restock:fulfil'],
  },
  {
    key: 'delivery_reminder',
    labelEn: 'Deliveries due', labelCn: '待发货提醒',
    descEn: 'An order is due out today and has not gone yet.',
    descCn: '有订单今天应发出但尚未发出。',
    needAny: ['orders:edit'],
  },
  {
    key: 'low_stock',
    labelEn: 'Running low', labelCn: '库存不足',
    descEn: 'The once-a-day summary of what is about to run out.',
    descCn: '每日一次的库存告急汇总。',
    needAny: ['products:edit', 'restock:request'],
  },
];

const KEYS = new Set(EVENTS.map((e) => e.key));

/** Is this a key somebody could have switched off? */
function known(key) { return KEYS.has(String(key || '')); }

/**
 * Would this event reach somebody holding `caps` at all?
 *
 * An owner holds everything, so `owner` short-circuits — an account's owner is
 * not described by a capability list in every code path, and a switch shown as
 * "you don't get these" to the person who gets everything would be a lie.
 */
function reaches(ev, caps, owner) {
  if (owner) return true;
  if (!ev.needAny || !ev.needAny.length) return true;
  const held = caps instanceof Set ? caps : new Set(caps || []);
  return ev.needAny.some((c) => held.has(c));
}

/**
 * The pane, ready to render: every event, whether it is on, and whether it
 * reaches this person at all.
 *
 * `off` is the set of keys this person has switched off. Anything not in it is
 * on, including a key that is not a known event — an unknown key is a stale row
 * from a renamed event, and it must not turn a live event off.
 */
function paneFor({ caps, owner, off } = {}) {
  const muted = off instanceof Set ? off : new Set(off || []);
  return EVENTS.map((e) => ({
    key: e.key,
    labelEn: e.labelEn, labelCn: e.labelCn,
    descEn: e.descEn, descCn: e.descCn,
    on: !muted.has(e.key),
    reaches: reaches(e, caps, owner),
  }));
}

module.exports = { EVENTS, known, reaches, paneFor };
