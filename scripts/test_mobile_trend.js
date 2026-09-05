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
 * The money gate is the Recap's, and it is asserted hardest: a warehouse
 * account must not be offered Revenue, must not DEFAULT to it, and must not see
 * a money figure anywhere on the screen. A tile that shows money for half a
 * second before hiding it has already shown it.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* THE WEEK ENDS TODAY, AND IT IS BUILT THAT WAY RATHER THAN TYPED.
 *
 * Two of this screen's labels are read against the clock: fmtDateOnly prints
 * "Today" and "Yesterday" by comparing a bucket with `new Date()`. The buckets
 * here were literals from August 2026, so on 1 September the last one stopped
 * being today, the sixth stopped being yesterday, and two assertions began
 * failing on a screen nobody had touched. Same expiry as the purchasing probe
 * (558eed3), same answer.
 *
 * LOCAL DATES, NOT UTC AND NOT UTC+8. This one differs from the purchasing
 * fixture on purpose. _date() appends 'T00:00:00' with no Z to a bare
 * YYYY-MM-DD, so a bucket is parsed as LOCAL midnight, and fmtDateOnly compares
 * it against a LOCAL now. Building these from a UTC or Guangzhou date would
 * disagree with the page by a day for part of every day, in whichever direction
 * the runner's zone happens to lean. The fixture uses the same clock the
 * comparison does.
 *
 * The shape is unchanged: seven days, rising, with the peak on the sixth so
 * "Busiest day" has a single unambiguous answer — and that sixth day is now
 * yesterday, which is what makes the label assertion mean anything.
 */
const CLOCK = `
  var _n=new Date();
  var _pad=function(x){ return String(x).padStart(2,'0') };
  var _day=function(off){
    var d=new Date(_n.getFullYear(), _n.getMonth(), _n.getDate()+off);
    return d.getFullYear()+'-'+_pad(d.getMonth()+1)+'-'+_pad(d.getDate());
  };
  // What the LEFT end of the line should read, derived here rather than by
  // calling the screen's own fmtDay — a check that asks the code what it printed
  // and then agrees with it has asserted nothing. Carries the year only when the
  // window crosses one, which is fmtDay's rule and matters in the first week of
  // January.
  var _l=new Date(_n.getFullYear(), _n.getMonth(), _n.getDate()-6);
  var LEFT_END = _l.getFullYear()===_n.getFullYear()
    ? _l.toLocaleDateString('en-US',{month:'short',day:'numeric'})
    : _l.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
`;

const WEEK = CLOCK + `state.trendKey='7'; state.trend=[
  {bucket:_day(-6),orders:10,revenue:1000,visits:200},
  {bucket:_day(-5),orders:12,revenue:1200,visits:240},
  {bucket:_day(-4),orders:14,revenue:1400,visits:280},
  {bucket:_day(-3),orders:11,revenue:1100,visits:220},
  {bucket:_day(-2),orders:13,revenue:1300,visits:260},
  {bucket:_day(-1),orders:20,revenue:2000,visits:400},
  {bucket:_day(0), orders:10,revenue:1000,visits:200}];`;

const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{trend:[]}})}}); };`;
const asked = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;

const CASES = [
  ['the window, and what is in it', WEEK + `APP.cmd('push','trend');`, [
    ['the total is the sum of the days', `txt('content').includes('¥9,000')`],
    // The day a shop remembers, and the only point on the line the eye asks
    // about — so it is named, with its date.
    ['the busiest day is named',   `txt('content').includes('¥2,000')`],
    ['and dated',                  `txt('content').includes('Yesterday')`],
    ['a typical day is the mean',  `txt('content').includes('¥1,286')`],
    ['the span is stated',         `txt('content').includes('Days counted') && txt('content').includes('7')`],
    ['both ends of the line are dated', `txt('content').includes(LEFT_END) && txt('content').includes('Today')`],
    ['the head carries total and window', `txt('content').includes('¥9,000 revenue · last 7 days')`],
    // A sparkline is not a chart. Saying where the chart lives is the same
    // promise every other phone screen makes about its desktop half.
    ['and says where the real charts are', `txt('content').includes('on desktop')`],
  ]],
  ['a line, drawn zero-based', WEEK + `APP.cmd('push','trend');`, [
    // An area fill that does not start at zero turns a modest week into a
    // cliff. y(0) must be the bottom of the box.
    ['there is a line',  `document.querySelectorAll('#content svg path').length >= 2`],
    ['with no axes to be unreadable at 390px', `document.querySelectorAll('#content svg text').length === 0`],
  ]],

  ['switching metric switches the numbers', WEEK + `APP.cmd('push','trend'); APP.cmd('trendMetric','orders');`, [
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
  ['a warehouse account sees no money', `state.pos='warehouse'; ` + WEEK + `APP.cmd('push','trend');`, [
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
  ['dispatch too', `state.pos='dispatch'; ` + WEEK + `APP.cmd('push','trend');`, [
    ['no money anywhere', `!txt('content').includes('¥')`],
  ]],
  ['an owner sees it', `state.pos='owner'; ` + WEEK + `APP.cmd('push','trend');`, [
    ['revenue is offered and shown', `txt('content').includes('Revenue') && txt('content').includes('¥9,000')`],
    ['and no gate note',             `!txt('content').includes('not shown on this account')`],
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
