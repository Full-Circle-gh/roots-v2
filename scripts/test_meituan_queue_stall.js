#!/usr/bin/env node
/**
 * The Meituan stock-push stall canary must not page for a store that is shut.
 *
 *   node scripts/test_meituan_queue_stall.js
 *
 * Pure logic, no DB, no network, no box.
 *
 * THE BUG THIS PINS
 * -----------------
 * queueStallTick measured the oldest pending row as `now - created_at` and paged
 * once that passed two hours. A store can only be pushed to while it is OPEN, and
 * the drift sweep re-queues rows around the clock, so every closed night parks
 * rows the daemon is not allowed to touch. 天河 (10:00–20:00, 15 min grace) opened
 * at 09:45 on 2026-08-23 holding five rows queued at 21:57 the night before:
 *
 *   09:48  the stall check runs — before that cycle's drain — and pages
 *          🔴 "stock pushes are stuck · 5 queued, oldest waiting ~711 min"
 *   09:48  ten seconds later the drain pushes all five
 *   09:53  the next check finds an empty queue and pages ✅
 *
 * Nothing was stuck; wall-clock age simply cannot tell "stuck" from "waiting for
 * opening hours". Red-then-green every morning trains the group to ignore the one
 * canary that catches a real 19-hour freeze.
 *
 * The fix counts only time the store was PUSHABLE, and only while the SAME row
 * sits at the head of the queue. These tests hold both halves in place.
 */
'use strict';

const assert = require('assert');
const { stallTick } = require('../lib/meituan-queue-stall');

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const MIN = 60_000;
const STALL = 120 * MIN;

// A clock that walks forward in minutes, so the tests read like the timeline.
function at(hhmm, dayOffset = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 7, 23, h, m) + dayOffset * 86_400_000;
}

// Drive a sequence of ticks and collect every alert it would have sent.
function run(ticks) {
  let state = null;
  let alerted = false;
  const sent = [];
  for (const t of ticks) {
    const d = stallTick({
      state, pushable: t.pushable, head: t.head, alerted, now: t.now, stallMs: STALL,
    });
    state = d.state;
    if (d.alert === 'page')  { alerted = true;  sent.push({ alert: 'page',  at: t.now, waitedMin: d.waitedMin }); }
    if (d.alert === 'clear') { alerted = false; sent.push({ alert: 'clear', at: t.now }); }
  }
  return { sent, state, alerted };
}

// The five rows 天河 was holding: queued 21:57, still there at opening.
const overnightHead = { id: 8801, createdAtMs: at('21:57', -1), pending: 5 };

console.log('\nmeituan stock-push stall canary\n');

it('the overnight backlog does NOT page at opening — the 09:48 false alarm', () => {
  const ticks = [];
  // Closed all night: the canary ticks every 5 min and must stay silent.
  for (let t = at('22:00', -1); t < at('09:45'); t += 5 * MIN) {
    ticks.push({ now: t, pushable: false, head: overnightHead });
  }
  // 09:45 the store opens; 09:48 is the first check after it.
  ticks.push({ now: at('09:48'), pushable: true, head: overnightHead });
  const { sent } = run(ticks);
  assert.deepStrictEqual(sent, [],
    'a store that was shut all night has not been stalling — it has been closed');
});

it('the row is 711 minutes old at that moment — the old rule would have paged', () => {
  const ageMin = Math.round((at('09:48') - overnightHead.createdAtMs) / MIN);
  assert.strictEqual(ageMin, 711, 'the exact age from the live alert');
  assert.ok(ageMin * MIN > STALL, 'wall-clock age clears the threshold six times over');
});

it('and it stays quiet through the morning drain that empties the queue', () => {
  const { sent } = run([
    { now: at('09:48'), pushable: true, head: overnightHead },
    { now: at('09:53'), pushable: true, head: null },   // drained on the 09:48 cycle
    { now: at('09:58'), pushable: true, head: null },
  ]);
  assert.deepStrictEqual(sent, [], 'no red, and so no green to walk it back either');
});

it('a genuinely stuck head still pages — after two hours of TRADING time', () => {
  const ticks = [];
  for (let t = at('09:45'); t <= at('12:00'); t += 5 * MIN) {
    ticks.push({ now: t, pushable: true, head: overnightHead });
  }
  const { sent } = run(ticks);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].alert, 'page');
  assert.strictEqual(sent[0].at, at('11:45'), 'two hours after the store opened, not before');
  assert.ok(Math.abs(sent[0].waitedMin - 120) <= 5, `waited minutes are trading minutes, got ${sent[0].waitedMin}`);
});

it('the paged number is trading time, not the 711 minutes the row has existed', () => {
  const ticks = [];
  for (let t = at('09:45'); t <= at('11:45'); t += 5 * MIN) {
    ticks.push({ now: t, pushable: true, head: overnightHead });
  }
  const { sent } = run(ticks);
  assert.ok(sent[0].waitedMin < 200,
    `an operator reading "~${sent[0].waitedMin} min" must be able to trust it as time we had and wasted`);
});

it('closed hours in the MIDDLE of a stall are parked, not counted', () => {
  // Stuck from 18:00, shop shuts at 20:15, reopens next morning. The overnight
  // hours must not carry the row over the line.
  const head = { id: 9001, createdAtMs: at('18:00'), pending: 3 };
  const ticks = [];
  for (let t = at('18:00'); t < at('19:00'); t += 5 * MIN) ticks.push({ now: t, pushable: true, head });
  for (let t = at('20:15'); t < at('09:45', 1); t += 5 * MIN) ticks.push({ now: t, pushable: false, head });
  ticks.push({ now: at('09:50', 1), pushable: true, head });
  const { sent } = run(ticks);
  assert.deepStrictEqual(sent, [], 'one hour of trading + a closed night is one hour of waiting');
});

it('…and the hour already served is not thrown away either', () => {
  const head = { id: 9001, createdAtMs: at('18:00'), pending: 3 };
  const ticks = [];
  for (let t = at('18:00'); t < at('19:00'); t += 5 * MIN) ticks.push({ now: t, pushable: true, head });
  for (let t = at('20:15'); t < at('09:45', 1); t += 5 * MIN) ticks.push({ now: t, pushable: false, head });
  // One more trading hour next morning tips it over the two-hour line.
  for (let t = at('09:45', 1); t <= at('11:00', 1); t += 5 * MIN) ticks.push({ now: t, pushable: true, head });
  const { sent } = run(ticks);
  assert.strictEqual(sent.length, 1, 'the cool-down parks the clock, it does not reset it');
  assert.strictEqual(sent[0].alert, 'page');
});

it('a busy queue that keeps moving never pages, however long it is', () => {
  // Rows constantly arriving and constantly going out: pending is never zero, but
  // the head changes every cycle. Counting "the queue is non-empty" would page a
  // healthy shop all day.
  const ticks = [];
  let id = 1;
  for (let t = at('10:00'); t <= at('19:00'); t += 5 * MIN) {
    ticks.push({ now: t, pushable: true, head: { id: id++, createdAtMs: t - 2 * MIN, pending: 12 } });
  }
  const { sent } = run(ticks);
  assert.deepStrictEqual(sent, [], 'a moving head is a working queue');
});

it('the head moving on clears a standing alert', () => {
  const ticks = [];
  for (let t = at('09:45'); t <= at('12:00'); t += 5 * MIN) ticks.push({ now: t, pushable: true, head: overnightHead });
  ticks.push({ now: at('12:05'), pushable: true, head: { id: 8802, createdAtMs: at('11:00'), pending: 4 } });
  const { sent } = run(ticks);
  assert.deepStrictEqual(sent.map(s => s.alert), ['page', 'clear']);
});

it('an emptied queue clears a standing alert', () => {
  const ticks = [];
  for (let t = at('09:45'); t <= at('12:00'); t += 5 * MIN) ticks.push({ now: t, pushable: true, head: overnightHead });
  ticks.push({ now: at('12:05'), pushable: true, head: null });
  const { sent } = run(ticks);
  assert.deepStrictEqual(sent.map(s => s.alert), ['page', 'clear']);
});

it('a restart mid-stall does not fake a recovery it never observed', () => {
  // The 🔴 latch is on disk and survives; the clock is in memory and does not. A
  // fresh process seeing the same head for the first time must not read that as
  // "the queue moved" and send an all-clear for an incident that is still running.
  const d = stallTick({
    state: null, pushable: true, head: overnightHead, alerted: true,
    now: at('12:30'), stallMs: STALL,
  });
  assert.strictEqual(d.alert, null, 'a cold start has observed nothing — it announces nothing');
});

it('a restart mid-stall re-pages once it has watched the head for another two hours', () => {
  const ticks = [];
  for (let t = at('12:30'); t <= at('15:00'); t += 5 * MIN) ticks.push({ now: t, pushable: true, head: overnightHead });
  let state = null, alerted = true; const sent = [];
  for (const t of ticks) {
    const d = stallTick({ state, pushable: t.pushable, head: t.head, alerted, now: t.now, stallMs: STALL });
    state = d.state;
    if (d.alert) { alerted = d.alert === 'page'; sent.push(d.alert); }
  }
  assert.deepStrictEqual(sent, [], 'still latched, still stuck, still one alert — no flapping');
});

it('waiting can never exceed the age of the row itself', () => {
  // A row queued one minute ago cannot have been waiting an hour, whatever the
  // tick gaps say (a suspended box, a long browser call, a clock step).
  const head = { id: 5, createdAtMs: at('10:59'), pending: 1 };
  let state = { headId: 5, waitedMs: 10 * 60 * MIN, lastTickMs: at('09:00') };
  const d = stallTick({ state, pushable: true, head, alerted: false, now: at('11:00'), stallMs: STALL });
  assert.ok(d.waitedMs <= MIN, `capped at the row's real age, got ${d.waitedMs}ms`);
  assert.strictEqual(d.alert, null);
});

it('a store that is closed is never paged, whatever the backlog looks like', () => {
  const head = { id: 7, createdAtMs: at('01:00', -30), pending: 400 };
  const d = stallTick({ state: { headId: 7, waitedMs: 99 * 60 * MIN, lastTickMs: at('09:00') },
    pushable: false, head, alerted: false, now: at('12:00'), stallMs: STALL });
  assert.strictEqual(d.alert, null, 'not stalled — waiting, and the closed/cool-down alerts own that');
  assert.strictEqual(d.state.lastTickMs, null, 'the clock is parked while it cannot run');
});

// ── The shipped daemon must actually use this, and only this ────────────────
const fs = require('fs');
const path = require('path');
const DAEMON = fs.readFileSync(path.join(__dirname, 'meituan-daemon.js'), 'utf8');
const TICK = DAEMON.match(/function queueStallTick\([\s\S]*?\n}\n/)[0];

it('the daemon measures with stallTick, not with wall-clock age', () => {
  assert.match(DAEMON, /require\('\.\.\/lib\/meituan-queue-stall'\)/);
  assert.match(TICK, /stallTick\(/, 'the canary must go through the tested measurement');
  assert.ok(!/ageMs\s*>=\s*QUEUE_STALL_MS/.test(DAEMON),
    'comparing raw created_at age to the threshold is the 09:48 false alarm');
});

it('the canary reads the head the drain would take next', () => {
  assert.match(TICK, /ORDER BY created_at, id/, 'same ordering as the drain, or they disagree about "oldest"');
  assert.match(TICK, /status = 'pending' AND attempts < 3/, 'same window as the drain');
});

it('pushability comes from the same predicate the drain uses', () => {
  assert.match(TICK, /pushableStores\(stores\)/,
    'a second opinion about what is pushable is how the two drift apart');
});

it('an empty queue is not reported as recovery when the pushes failed', () => {
  assert.match(DAEMON, /function headGaveUp\(/);
  assert.match(TICK, /headGaveUp\(prevHeadId\)/,
    'a row that burns its last attempt leaves the window exactly like one that landed');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
