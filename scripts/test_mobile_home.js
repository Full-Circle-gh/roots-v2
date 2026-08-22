#!/usr/bin/env node
/**
 * Home — the first screen the app opens on, asserted against 03-dashboard.js.
 *
 *   node scripts/test_mobile_home.js
 *
 * Two things were wrong with it, and neither was a broken control.
 *
 *   • The "Today" tile fell back to ¥12,840 · 37 orders · ¥347 · 1,204
 *     visitors — four numbers typed into a mockup, under a heading that says
 *     Today, on the first screen the app opens. Any slow or failed
 *     /dashboard call put invented money in front of an operator, and
 *     "Revenue ¥12,840" is not a figure anyone reads twice.
 *   • Quick actions offered "Add product", "Create coupon", "Send broadcast".
 *     The phone can do none of the three; each opened a read-only list. They
 *     were not wired to noop, which is why they outlived that sweep, but they
 *     promise the same thing and break it the same way.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const KPIS = `state.liveKpis=[
  ['Revenue (all channels)','¥3,180','+12% vs a typical day'],
  ['Orders (storefront)','19','+3 vs a typical day'],
  ['Avg. order','¥167.37',''],
  ['New customers','4','−1 vs a typical day']];`;

const CASES = [
  ['before the dashboard answers', `APP.cmd('tab','home');`, [
    // The mock's four figures, gone. Each is asserted by its own value because
    // any one of them appearing means the fallback is back.
    ['no invented revenue',   `!txt('content').includes('12,840')`],
    ['no invented order count', `!/\\b37\\b/.test(txt('content'))`],
    ['no invented average',   `!txt('content').includes('¥347')`],
    ['no invented visitors',  `!txt('content').includes('1,204')`],
    ['the tile is still there, with its labels', `txt('content').includes('Revenue (all channels)') && txt('content').includes('New customers')`],
    ['saying it has no figure yet',              `txt('content').includes('—')`],
  ]],
  ['once it answers', `APP.cmd('tab','home'); ${KPIS} render();`, [
    ['the real revenue',   `txt('content').includes('¥3,180')`],
    ['the real orders',    `txt('content').includes('19')`],
    ['the real average',   `txt('content').includes('¥167.37')`],
    ['and the comparison', `txt('content').includes('vs a typical day')`],
  ]],
  ['quick actions are things the phone can actually do', `APP.cmd('tab','home');`, [
    // Each of these opens a screen that performs the action named.
    ['answer the inbox',       `txt('content').includes('Answer the inbox')`],
    ['tick a delivery in',     `txt('content').includes('Tick a delivery in')`],
    ['fix a price or a count', `txt('content').includes('Fix a price or a count')`],
    ['no "Add product"',       `!txt('content').includes('Add product')`],
    ['no "Create coupon"',     `!txt('content').includes('Create coupon')`],
    ['no "Send broadcast"',    `!txt('content').includes('Send broadcast')`],
  ]],
  ['the needs-you queue is the ops snapshot', `state.ops={
      unhandled:{count:3,items:[{placed_at:'2026-08-22 07:00:00'}]},
      refunds:{count:1,items:[]}, out_of_stock:{count:2}, low_stock:{count:5}};
    state.liveAttn={reviews:2}; APP.cmd('tab','home');`, [
    ['orders to start',       `txt('content').includes('Orders to start')`],
    ['refunds waiting',       `txt('content').includes('Refunds waiting')`],
    ['restock, counting what is OUT', `txt('content').includes('Restock needed') && txt('content').includes('out of stock, 5 running low')`],
    ['reviews, which the ops snapshot does not carry', `txt('content').includes('Reviews to reply')`],
  ]],
  ['a quiet shop shows no queue at all', `state.ops={unhandled:{count:0,items:[]}};
    state.liveAttn={}; APP.cmd('tab','home');`, [
    ['no "Needs you" heading', `!txt('content').includes('Needs you')`],
  ]],
];

// opsFires evaluates every argument before add() looks at its condition, so
// reading o.<key>.items inline threw on any payload missing a key — and a
// render that throws leaves the PREVIOUS screen on the glass, so Home would
// just look stale rather than broken. The server sends every key today; this
// case is here so that stays true by test rather than by luck.
CASES.push(['a partial ops payload does not take the screen down', `state.ops={unhandled:{count:2}};
  APP.cmd('tab','home');`, [
  ['the queue renders',        `txt('content').includes('Orders to start')`],
  ['and the rest of Home too', `txt('content').includes('Today')`],
]]);

run('home', CASES);
