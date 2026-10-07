#!/usr/bin/env node
/**
 * §440 — the till knocks when a QR order comes in unpaid.
 *
 *   node scripts/test_till_knock.js
 *
 * No browser. The functions under test are cut out of public/till.html as
 * written and run here against stubs, so what passes is the shipped text, and
 * the suite stays in the fast shard that is actually run.
 *
 *   • THE FIRST READ ONLY REMEMBERS. A till opened onto orders that were
 *     already waiting has nothing arriving and must not ring.
 *   • A NEW ID KNOCKS, ONCE PER READ, however many came in it.
 *   • AN ID SEEN BEFORE NEVER KNOCKS AGAIN, even after it left the list.
 *   • QUIET READS STILL KNOCK. The settle screen is up exactly when the
 *     counter is busiest; the list is left alone, the sound is not.
 *   • A READ FROM THE SHOP THE TILL JUST LEFT IS DROPPED, so it can neither
 *     paint the wrong queue nor make the new shop's backlog ring.
 *   • A SUSPENDED AUDIO CONTEXT PLAYS NOTHING — a late knock on the next tap
 *     would announce an order already on screen.
 *   • THE STRIP SHOWS ONLY WHILE SOUND IS BLOCKED, and only at a counter with
 *     a QR menu.
 *   • THE SCREEN IS KEPT ON ONLY AT A COUNTER WITH A QR MENU, and let go when
 *     the till moves to one without.
 *   • THE KNOCK IS NOT THE DING. Different notes, going the other way.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const problems = [];
let checks = 0;
function ok(name, v) { checks++; if (!v) problems.push(name); }

// Cut one top-level function out of the page by name: from its declaration to
// the first line that closes it at the same two-space indent.
function fn(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('till.html has no function ' + name + '()');
  return m[0];
}

const tick = () => new Promise((r) => setImmediate(r));

// ── Arrivals: noteArrivals + loadPend ─────────────────────────────────────
function pendWorld() {
  const w = {
    S: { storeId: 1, view: 'till', pend: null, pendSeen: null, lines: [] },
    knocks: 0, renders: 0, answer: [],
    api: null,
  };
  w.api = () => Promise.resolve({ success: true, data: w.answer });
  const ctx = {
    S: w.S,
    api: (u) => w.api(u),
    pendUrl: () => '/pend',
    autoPane: () => {},
    render: () => { w.renders++; },
    playKnock: () => { w.knocks++; },
    String,
  };
  vm.createContext(ctx);
  vm.runInContext(fn('noteArrivals') + fn('loadPend'), ctx);
  w.load = (quiet) => { ctx.loadPend(quiet); return tick(); };
  return w;
}
const row = (id) => ({ id, shop_order_code: id, total: 10 });

(async function run() {
  {
    const w = pendWorld();
    w.answer = [row(1), row(2), row(3)];
    await w.load();
    ok('first read: no knock for orders already waiting', w.knocks === 0);
    ok('first read: the list is shown', w.S.pend.length === 3);

    await w.load();
    ok('same list again: no knock', w.knocks === 0);

    w.answer = [row(4), row(1), row(2), row(3)];
    await w.load();
    ok('a new order knocks once', w.knocks === 1);

    w.answer = [row(6), row(5), row(4), row(1), row(2), row(3)];
    await w.load();
    ok('two new in one read: still one knock', w.knocks === 2);

    w.answer = [row(5), row(4)];
    await w.load();
    ok('orders leaving the list: no knock', w.knocks === 2);

    w.answer = [row(6), row(5), row(4)];
    await w.load();
    ok('an order seen before coming back: no knock', w.knocks === 2);

    w.answer = [{ id: 9, shop_order_code: null }];
    await w.load();
    ok('a row with no number is not an arrival', w.knocks === 2);
  }
  {
    const w = pendWorld();
    w.answer = [row(1)];
    await w.load();
    const shown = w.S.pend, renders = w.renders;
    w.answer = [row(2), row(1)];
    await w.load(true);
    ok('quiet read: still knocks', w.knocks === 1);
    ok('quiet read: the list on screen is left alone', w.S.pend === shown && w.renders === renders);
    await w.load();
    ok('back on the till: the same order does not knock twice', w.knocks === 1);
    ok('back on the till: the list catches up', w.S.pend.length === 2);
  }
  {
    // The read is in flight when the cashier switches shop. switchStore()
    // sets storeId and drops pendSeen; the old answer must not land.
    const w = pendWorld();
    let release;
    w.api = () => new Promise((r) => { release = () => r({ success: true, data: [row(1)] }); });
    const pending = w.load();
    w.S.storeId = 2; w.S.pend = null; w.S.pendSeen = null;
    release(); await pending; await tick();
    ok('a late read from the old shop is not painted', w.S.pend === null);
    ok('…and does not seed the new shop', w.S.pendSeen === null);
    w.api = () => Promise.resolve({ success: true, data: [row(7), row(8)] });
    await w.load();
    ok("the new shop's backlog does not ring", w.knocks === 0);
  }
  ok('switchStore() forgets what the old shop had', /S\.pend = null;[^\n]*\n\s*S\.pendSeen = null;/.test(src));

  // ── The poll and the doorbell keep reading behind the settle screen ────
  const poll = fn('startPendPoll');
  ok('the poll no longer stops when the till is not the view', !/S\.view !== 'till'\) return/.test(poll));
  ok('the poll reads quietly when the till is not the view', poll.includes("loadPend(S.view !== 'till')"));
  ok('the poll still stops while the screen is hidden', poll.includes('if (document.hidden) return;'));
  const stream = fn('openPendStream');
  ok('the doorbell reads quietly when the till is not the view', stream.includes("loadPend(S.view !== 'till')"));

  // ── The sound itself ───────────────────────────────────────────────────
  function audioWorld(state) {
    const notes = [];
    const ac = {
      state, currentTime: 0, destination: {},
      createOscillator: () => {
        const o = { type: '', frequency: { value: 0 }, connect() {}, start(t) { notes.push([o.frequency.value, t, o.type]); }, stop() {} };
        return o;
      },
      createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
      resume: () => { ac.state = 'running'; return Promise.resolve(); },
    };
    const ctx = { window: { AudioContext: function () { return ac; } }, renderSound: () => {} };
    vm.createContext(ctx);
    vm.runInContext('var _knockCtx = null;' + fn('knockCtx') + fn('wakeKnock') + fn('playKnock'), ctx);
    return { ctx, ac, notes };
  }
  {
    const a = audioWorld('suspended');
    a.ctx.playKnock();
    ok('a suspended context plays nothing', a.notes.length === 0);
    a.ctx.wakeKnock();
    await tick();
    a.ctx.playKnock();
    ok('after a tap it plays two notes', a.notes.length === 2);
    ok('the knock goes down', a.notes[0][0] > a.notes[1][0]);
    ok('second note after the first', a.notes[1][1] > a.notes[0][1]);
    const ding = [784, 1047];
    ok('the knock shares no note with the paid-order ding', a.notes.every((n) => !ding.includes(n[0])));
    ok('the knock is not the ding\'s sine', a.notes.every((n) => n[2] !== 'sine'));
  }
  {
    const ctx = { window: {}, renderSound: () => {} };
    vm.createContext(ctx);
    vm.runInContext('var _knockCtx = null;' + fn('knockCtx') + fn('playKnock'), ctx);
    let threw = false;
    try { ctx.playKnock(); } catch (e) { threw = true; }
    ok('a browser with no Web Audio does not throw', !threw);
  }

  // ── The strip ──────────────────────────────────────────────────────────
  function stripWorld(shopId, state) {
    const bar = { hidden: true }, msg = { textContent: '' };
    const ctx = {
      S: { shopId },
      _knockCtx: state == null ? null : { state },
      $: (id) => (id === 'snd-bar' ? bar : id === 'snd-msg' ? msg : null),
      T: (k) => k,
    };
    vm.createContext(ctx);
    vm.runInContext(fn('renderSound'), ctx);
    ctx.renderSound();
    return { bar, msg };
  }
  ok('strip up: a QR counter whose sound is blocked', !stripWorld(5, 'suspended').bar.hidden);
  ok('strip says the right thing', stripWorld(5, 'suspended').msg.textContent === 'soundTap');
  ok('strip down: sound is on', stripWorld(5, 'running').bar.hidden);
  ok('strip down: a counter with no QR menu', stripWorld(null, 'suspended').bar.hidden);
  ok('strip down: no Web Audio at all', stripWorld(5, null).bar.hidden);

  const pair = src.match(/soundTap:\s*\['([^']+)', '([^']+)'\]/);
  ok('the strip has both languages', pair && pair[1] && pair[2]);
  const vocab = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
  ok('the composed Chinese is declared in the vocabulary doc', pair && vocab.includes(pair[2]));
  ok('the strip markup is in the page', /id="snd-bar"[^>]*hidden/.test(src) && src.includes('id="snd-msg"'));

  // ── Keeping the screen on ──────────────────────────────────────────────
  function wakeWorld(shopId, hidden, api = true) {
    const w = { asked: 0, released: 0, lock: null };
    const ctx = {
      S: { shopId },
      document: { hidden },
      navigator: api ? { wakeLock: { request: () => {
        w.asked++;
        const lock = { release() { w.released++; }, addEventListener() {} };
        w.lock = lock;
        return Promise.resolve(lock);
      } } } : {},
    };
    vm.createContext(ctx);
    vm.runInContext('var _wake = null, _wakeAsking = false;' + fn('syncAwake'), ctx);
    w.ctx = ctx;
    return w;
  }
  {
    const w = wakeWorld(5, false);
    w.ctx.syncAwake(); w.ctx.syncAwake();
    ok('asks to keep the screen on at a QR counter', w.asked === 1);
    await tick();
    w.ctx.syncAwake();
    ok('does not ask twice while it holds the lock', w.asked === 1);
    w.ctx.S.shopId = null;
    w.ctx.syncAwake();
    ok('lets go when the till moves to a counter with no QR menu', w.released === 1);
  }
  {
    const w = wakeWorld(null, false);
    w.ctx.syncAwake();
    ok('a counter with no QR menu never holds the screen', w.asked === 0);
  }
  {
    const w = wakeWorld(5, true);
    w.ctx.syncAwake();
    ok('a hidden page does not ask', w.asked === 0);
  }
  {
    const w = wakeWorld(5, false, false);
    let threw = false;
    try { w.ctx.syncAwake(); } catch (e) { threw = true; }
    ok('a browser without the API does not throw', !threw);
  }
  ok('render() keeps the strip and the lock current',
    /renderSound\(\);\s*\n\s*syncAwake\(\);/.test(fn('render')));

  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
  console.log(`ok — ${checks} till knock checks.`);
})().catch((e) => { console.error(e); process.exit(1); });
