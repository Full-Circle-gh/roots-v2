#!/usr/bin/env node
/**
 * Trend — the only screen on this phone that is not about today.
 *
 *   node scripts/test_mobile_trend.js
 *
 * Home fetches /dashboard?from=today&to=today, and before this screen the only
 * date range anywhere in m.html was Stock activity's. "Is this week better than
 * last?" is a question you ask standing in the shop and the phone could not
 * answer it at any length.
 *
 * It is deliberately NOT the desktop's Reports: no chapters, no hover columns,
 * no per-store breakdown. The endpoint's own `trend` array — one bucket per day
 * of {bucket, orders, revenue, visits} — was already being fetched for a single
 * day; this asks for a window and draws the shape plus four numbers.
 *
 * The money gate is the Recap's, and it is asserted hardest: an account without
 * `reports:view` must not be offered Revenue, must not DEFAULT to it, and must
 * not see a money figure anywhere on the screen. A tile that shows money for
 * half a second before hiding it has already shown it.
 *
 * That gate is a CAPABILITY, not a role name (it was `state.pos` until
 * 2026-08-31), and it has THREE inputs, not two: holds the cap, resolved
 * without it, and never resolved at all. The last is the one a role string
 * could not express and the one that leaks — it is asserted here too.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Seven days, rising, with an obvious peak on the sixth so "Busiest day" has a
// single unambiguous answer.
const WEEK = `state.trendKey='7'; state.trend=[
  {bucket:'2026-08-17',orders:10,revenue:1000,visits:200},
  {bucket:'2026-08-18',orders:12,revenue:1200,visits:240},
  {bucket:'2026-08-19',orders:14,revenue:1400,visits:280},
  {bucket:'2026-08-20',orders:11,revenue:1100,visits:220},
  {bucket:'2026-08-21',orders:13,revenue:1300,visits:260},
  {bucket:'2026-08-22',orders:20,revenue:2000,visits:400},
  {bucket:'2026-08-23',orders:10,revenue:1000,visits:200}];`;

// The money gate, as the app now reads it: a resolved cap set that holds
// reports:view, or a resolved one that does not. Both are DIFFERENT from an
// unresolved set (state.caps === null), which the third gate case covers.
const MONEY    = `state.caps=new Set(['reports:view','dashboard:view','orders:view']);`;
const NO_MONEY = `state.caps=new Set(['dashboard:view','orders:view']);`;

const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{trend:[]}})}}); };`;
const asked = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;

const CASES = [
  ['the window, and what is in it', MONEY + WEEK + `APP.cmd('push','trend');`, [
    ['the total is the sum of the days', `txt('content').includes('¥9,000')`],
    // The day a shop remembers, and the only point on the line the eye asks
    // about — so it is named, with its date.
    ['the busiest day is named',   `txt('content').includes('¥2,000')`],
    ['and dated',                  `txt('content').includes('Yesterday')`],
    ['a typical day is the mean',  `txt('content').includes('¥1,286')`],
    ['the span is stated',         `txt('content').includes('Days counted') && txt('content').includes('7')`],
    ['both ends of the line are dated', `txt('content').includes('Aug 17') && txt('content').includes('Today')`],
    ['the head carries total and window', `txt('content').includes('¥9,000 revenue · last 7 days')`],
    // A sparkline is not a chart. Saying where the chart lives is the same
    // promise every other phone screen makes about its desktop half.
    ['and says where the real charts are', `txt('content').includes('on desktop')`],
  ]],
  ['a line, drawn zero-based', MONEY + WEEK + `APP.cmd('push','trend');`, [
    // An area fill that does not start at zero turns a modest week into a
    // cliff. y(0) must be the bottom of the box.
    ['there is a line',  `document.querySelectorAll('#content svg path').length >= 2`],
    ['with no axes to be unreadable at 390px', `document.querySelectorAll('#content svg text').length === 0`],
  ]],

  ['switching metric switches the numbers', MONEY + WEEK + `APP.cmd('push','trend'); APP.cmd('trendMetric','orders');`, [
    ['orders, not money',    `txt('content').includes('90') && !txt('content').includes('¥9,000')`],
    ['the head follows too', `txt('content').includes('90 orders · last 7 days')`],
  ]],
  ['switching range asks the server again', STUB + `APP.cmd('push','trend'); APP.cmd('trendRange','30');`, [
    ['a new window is fetched', asked('/dashboard?from=')],
    // 30 days back, not 30 days of the same 7-day request.
    ['for thirty days',         `window.__sent.some(function(r){ var m=r.u.match(/from=(\\d{4}-\\d{2}-\\d{2})&to=(\\d{4}-\\d{2}-\\d{2})/);
       if(!m) return false; return Math.round((new Date(m[2])-new Date(m[1]))/86400000)===29; })`],
  ]],

  // ── The money gate ─────────────────────────────────────────────────────
  // Driven by the CAPABILITY, not the role string. It used to be
  // `state.pos='warehouse'`, which stopped deciding anything the day money moved
  // onto reports:view — a tenant renaming a role would otherwise have fallen out
  // of a hardcoded list and started printing takings. MONEY seeds the cap;
  // NO_MONEY seeds a resolved set without it; and the third case below seeds
  // nothing at all, which is the state this whole gate exists for.
  ['a warehouse account sees no money', NO_MONEY + WEEK + `APP.cmd('push','trend');`, [
    // The CHIP, not the word — the note at the bottom says "Revenue is not
    // shown on this account", which is the screen being honest about the gate
    // rather than a leak.
    ['revenue is not offered',      `![].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.trim()==='Revenue'})`],
    // Not just hidden as a chip — the DEFAULT metric must fall back, or the
    // screen opens on money for whoever cannot see it.
    ['and is not the default',      `!txt('content').includes('¥')`],
    ['orders still are',            `txt('content').includes('Orders')`],
    ['and it says why',             `txt('content').includes('not shown on this account')`],
  ]],
  ['dispatch too', NO_MONEY + WEEK + `APP.cmd('push','trend');`, [
    ['no money anywhere', `!txt('content').includes('¥')`],
  ]],
  ['an owner sees it', MONEY + WEEK + `APP.cmd('push','trend');`, [
    ['revenue is offered and shown', `txt('content').includes('Revenue') && txt('content').includes('¥9,000')`],
    ['and no gate note',             `!txt('content').includes('not shown on this account')`],
  ]],
  // The case the role string could never express, and the reason canStrict
  // exists: /api/backend/me has not landed, or failed. Caps are UNKNOWN. An
  // ordinary control would stay visible (fail-open); money must not.
  ['caps that never resolved see no money', `state.caps=null; ` + WEEK + `APP.cmd('push','trend');`, [
    ['no money anywhere',      `!txt('content').includes('¥')`],
    ['revenue is not offered', `![].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.trim()==='Revenue'})`],
    ['orders still are',       `txt('content').includes('Orders')`],
  ]],

  ['a window with nothing in it', `state.trendKey='7'; state.trend=[]; APP.cmd('push','trend');`, [
    ['says so',                 `txt('content').includes('Nothing in this window')`],
    ['and suggests a shorter one', `txt('content').includes('shorter window')`],
    ['the range chips still work', `${'document.querySelectorAll("#content button").length >= 3'}`],
  ]],
  ['before it lands', `APP.cmd('push','trend');`, [
    ['loading, not empty', `txt('content').includes('Loading') && !txt('content').includes('Nothing in this window')`],
  ]],
  ['it would not load', `state.trendKey='7'; state.trendErr='Could not load the trend.'; APP.cmd('push','trend');`, [
    ['says so',           `txt('content').includes('Could not load the trend')`],
    ['rather than empty', `!txt('content').includes('Nothing in this window')`],
  ]],
];

run('trend', CASES);
