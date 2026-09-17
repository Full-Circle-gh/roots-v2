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
 * It is still not the desktop's Reports — no hover columns, no cohort grid, no
 * written read — but it stopped being only a line and four numbers. The screen
 * was reading ONE key of /dashboard's reply, `trend`, and discarding the rest of
 * the object: the deltas against the previous window, the payment mix, the
 * day×hour heat, the status funnel, the cohort tables and the per-store split
 * the old note sent people to a desktop for. All of that is now on the phone,
 * out of the same single request, in four sections that open one at a time.
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

/* ── The rest of the payload ───────────────────────────────────────────────
 * The screen used to read one key of /dashboard's reply, `trend`, and drop the
 * object. These cases hold the line on the four things that came off the floor
 * with it: the delta against the previous window, the fact sections, the
 * per-store split the old note sent people to a desktop for, and — hardest —
 * the money gate reaching into all of it.
 *
 * The payload below is the reply's real shape, keys and all, so a server-side
 * rename breaks a test here rather than a card on somebody's phone.
 */
const FULL = WEEK + `state.trendFull={
  deltas:{revenue:12.5,orders:8,visits:-4.2},
  payments:[{method:'wechat',orders:60,revenue:6000},{method:'cash',orders:30,revenue:3000}],
  heat:[{dow:6,hour:18,orders:22,revenue:2200},{dow:1,hour:9,orders:4,revenue:400}],
  funnel:{delivered:{n:84,revenue:8400},cancelled:{n:3,revenue:300}},
  marketing:{vouchers:[{discount:250,uses:12}]},
  new_vs_returning:{buyers:70,new_buyers:21,returning_buyers:49},
  topCustomers:[{customer_id:5,nickname:'Mei',revenue:980,orders:6}],
  geoCities:[{city:'广州',city_en:'Guangzhou',orders:61,revenue:6100}],
  topProducts:[{product_id:2,name_en:'Falafel Wrap',name_cn:'法拉费卷',units:140,revenue:2800}],
  kpis:{conversion_rate:6.25},
  checkout:{started:40,converted:25,abandoned:15},
  stores:[{store_id:1,name_en:'Tianhe',name_cn:'天河',orders:52,revenue:5200},
          {store_id:2,name_en:'Panyu',name_cn:'番禺',orders:38,revenue:3800}],
  cohortSizes:[], cohorts:[]};`;

/* Fourteen days, worth 100 on a Saturday and 10 on anything else — built off
 * the runner's clock for the same reason the week above is, and long enough
 * that every weekday has had two goes at it. */
const FORTNIGHT = CLOCK + `
  var _v=function(off){ var d=new Date(_n.getFullYear(), _n.getMonth(), _n.getDate()+off); return d.getDay()===6?100:10; };
  var _t=[]; for(var i=13;i>=0;i--){ _t.push({bucket:_day(-i),orders:_v(-i),revenue:_v(-i)*10,visits:_v(-i)*2}); }
  state.trendRange='30'; state.trendKey='30'; state.trend=_t;`;

/* Retention is the one figure on the screen that is NOT the window's — cohorts
 * come back full-history — so its months are built off shopToday(), which is
 * the clock trendRetain1 compares against, and not off the runner's local one. */
const COHORTS = FULL + `
  var _T=shopToday(), _sy=Number(_T.slice(0,4)), _sm=Number(_T.slice(5,7));
  var _ym=function(off){ var t=(_sm-1)+off, y=_sy+Math.floor(t/12), mo=((t%12)+12)%12+1;
    return y+'-'+String(mo).padStart(2,'0'); };
  state.trendFull.cohortSizes=[{cohort_month:_ym(-2),size:100},{cohort_month:_ym(0),size:50}];
  state.trendFull.cohorts=[{cohort_month:_ym(-2),active_month:_ym(-1),active_customers:40}];`;

CASES.push(
  ['the window before this one', FULL + `APP.cmd('push','trend');`, [
    // "Is this week better than last" was answerable only by switching the
    // range chip, remembering a figure and switching back. The server had
    // computed it all along.
    ['the change is stated', `txt('content').includes('+12.5%')`],
    ['against a named window', `txt('content').includes('vs prior 7 days')`],
  ]],
  ['a fall reads as a fall', FULL + `APP.cmd('push','trend'); APP.cmd('trendMetric','visits');`, [
    ['signed, not coloured only', `txt('content').includes('−4.2%')`],
  ]],
  ['no previous window, no claim', WEEK + `state.trendFull={deltas:{revenue:null}}; APP.cmd('push','trend');`, [
    // null is the server saying the window before this one was empty. Silence,
    // not a divide-by-zero dressed as growth.
    ['nothing is said', `!txt('content').includes('vs prior')`],
  ]],

  ['the fact sections', FULL + `APP.cmd('push','trend');`, [
    ['all four are offered', `['Sales','Customers','Products & traffic','Stores'].every(function(s){return txt('content').includes(s)})`],
    // A section that says only its name gives a thumb no reason to spend a tap.
    ['each carries its first fact closed', `txt('content').includes('WeChat Pay share of revenue · 67%')`],
    ['and the rest stay shut',             `!txt('content').includes('Given away in vouchers')`],
  ]],
  ['opening one', FULL + `APP.cmd('push','trend'); APP.cmd('trendSection','sales');`, [
    ['the rows arrive',   `txt('content').includes('Given away in vouchers')`],
    ['the hour is named', `txt('content').includes('Saturday 18:00')`],
    ['the funnel too',    `txt('content').includes('84 · ¥8,400')`],
    ['and the others are still shut', `!txt('content').includes('Top spender')`],
    // The summary line is the CLOSED card's. Open, the same fact would be
    // printed twice — once as the summary and again as the first row under it.
    ['the summary line is not repeated under itself',
     `txt('content').split('WeChat Pay share of revenue').length === 2`],
  ]],
  ['the per-store breakdown is on the phone now', FULL + `APP.cmd('push','trend'); APP.cmd('trendSection','stores');`, [
    ['the stores are named',    `txt('content').includes('Tianhe') && txt('content').includes('Panyu')`],
    ['with what each one took', `txt('content').includes('52 · ¥5,200')`],
    // The note used to promise this screen could not do it. It no longer says so.
    ['and the note stops sending you to a desktop for it', `!txt('content').includes('per-store')`],
  ]],
  ['customers and products', FULL + `APP.cmd('push','trend'); APP.cmd('trendSection','customers'); APP.cmd('trendSection','products');`, [
    ['buyers are counted',   `txt('content').includes('People bought')`],
    ['new ones as a share',  `txt('content').includes('30%')`],
    ['the city is English on an English phone', `txt('content').includes('Guangzhou · 61 orders')`],
    ['the seller is named',  `txt('content').includes('Falafel Wrap')`],
    // kpis.conversion_rate is the mini app's own, never all-channel orders
    // over sessions — the server fixed that at source and this reads it whole.
    ['conversion is the server\'s',  `txt('content').includes('6.3%')`],
  ]],
  ['retention is full history, not the window', COHORTS + `APP.cmd('push','trend'); APP.cmd('trendSection','customers');`, [
    // 40 of a 100-strong cohort still buying a month on; the cohort too young
    // to have a month behind it is not counted in either half of the fraction.
    ['the weighted curve is read at one month', `txt('content').includes('Still buying a month later') && txt('content').includes('40%')`],
  ]],

  // ── The money gate, now that there is more to gate ─────────────────────
  ['a warehouse account sees no money in the sections either',
   `state.pos='warehouse'; ` + FULL + `APP.cmd('push','trend'); APP.cmd('trendSection','sales'); APP.cmd('trendSection','stores');`, [
    ['not anywhere on the screen',       `!txt('content').includes('¥')`],
    // Dropped, not zeroed and not blurred: a row about revenue is a revenue
    // row even when it prints a percentage.
    ['the payment mix is gone',          `!txt('content').includes('share of revenue')`],
    ['the voucher giveaway with it',     `!txt('content').includes('Given away in vouchers')`],
    ['and the top spender',              `!txt('content').includes('Top spender')`],
    ['what is not about money survives', `txt('content').includes('Busiest hour')`],
    ['stores are counted, not priced',   `txt('content').includes('52 orders')`],
  ]],
  ['a section with nothing left in it is not drawn',
   `state.pos='warehouse'; ` + WEEK + `state.trendFull={payments:[{method:'wechat',orders:60,revenue:6000}]}; APP.cmd('push','trend');`, [
    // Every row this section could have held was money. An empty card headed
    // "Sales" is worse than no card.
    ['no empty card', `!txt('content').includes('Sales')`],
  ]],

  // ── The two ends of the line, and the pattern behind them ──────────────
  ['both ends of the week are named', WEEK + `APP.cmd('push','trend');`, [
    ['the busiest',  `txt('content').includes('Busiest day')`],
    ['the quietest', `txt('content').includes('Quietest day')`],
  ]],
  ['one Saturday is not a pattern', WEEK + `APP.cmd('push','trend');`, [
    // Seven days gives every weekday exactly one go. "Best day of the week"
    // would then be the busiest day already named above, wearing a label that
    // claims more than it knows.
    ['so the weekday is not claimed', `!txt('content').includes('Best day of the week')`],
  ]],
  ['two of each is', FORTNIGHT + `APP.cmd('push','trend'); APP.cmd('trendMetric','orders');`, [
    ['the weekday is named', `txt('content').includes('Best day of the week')`],
    ['and it is the right one', `txt('content').includes('Saturday')`],
  ]],
);

run('trend', CASES);
