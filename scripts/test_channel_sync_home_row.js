#!/usr/bin/env node
'use strict';

// The ONE channel row on Home — §104.
//
//   node scripts/test_channel_sync_home_row.js
//
// Home used to carry TWO channel rows, and on the phone they read as one thing
// said twice: "Meituan not syncing · 3" directly above "Channel sync · Meituan
// 2" — same channel, same clock, two chips going to two places. Ash, from the
// phone: "we don't need anymore the individual channel sync notification like
// meituan. we have the new one that all channels combined." They are now one
// row, and this suite is what stops the merge losing the half that had no
// other voice.
//
// THE HALF THAT COULD HAVE GONE SILENT. A channel that has stopped taking our
// stock pushes shows GREEN on every one of its items, by §103's own ruling: a
// push in flight is green whatever its age, and a queue that never sends
// leaves each item's last pushed number matching what the channel still
// displays. So `channel_items_attention` is 0 for a dead channel, and deleting
// the stall row outright would have made 越秀's 1,683 pending pushes (§102's
// addendum — no successful push since 2026-08-22) say nothing at all on Home.
// `stall alone still lights the row` below is that case.
//
// HOW IT TESTS. Not by grepping for phrases: the §104 block is SLICED out of
// public/retail-admin/03-dashboard.js and public/m.html and RUN, against
// stubbed helpers and a payload per case, and the fire object it pushes is
// asserted. Both files are put through the identical cases from one table, so
// the two surfaces cannot drift into disagreeing about what Home says.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DESK = fs.readFileSync(path.join(ROOT, 'public/retail-admin/03-dashboard.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ── Slicing ─────────────────────────────────────────────────────────────────
// From the §104 marker to the line before the block that follows it. Both ends
// are asserted rather than assumed: a slice that silently caught the wrong
// lines would run something and prove nothing.
function slice(src, startMark, endMark, what) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error(`${what}: start marker not found — ${startMark}`);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error(`${what}: end marker not found — ${endMark}`);
  const body = src.slice(a, b).replace(/\s+$/, '');
  if (!/\}$/.test(body)) throw new Error(`${what}: slice does not end on the block's brace`);
  return body;
}

const DESK_BLOCK = slice(DESK, '  // §104 — ONE channel row on Home',
  '  // Severity first, then oldest first', 'desktop');
const PHONE_BLOCK = slice(PHONE, '  /* §104 — ONE channel row',
  '  const rank={brick:0,amber:1};', 'phone');

// ── Stubs ───────────────────────────────────────────────────────────────────
// Every case runs at a fixed "now" on a fixed day, so a clock that should read
// as a bare time and one that should carry a date are decided by the payload
// and not by what day the suite happens to run on.
const NOW = Date.UTC(2026, 8, 12, 1, 47, 0);          // 2026-09-12 01:47 UTC
const TODAY = '2026-09-12';
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// Deliberately distinguishable: a case can tell a bare time from a stamp that
// carries its date, which is the whole point of the sameDay branch.
function fmt(t, kind) {
  const d = new Date(t);
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  if (kind === 'machine') return dayOf(t);
  return kind === 'time' ? hhmm : dayOf(t) + ' ' + hhmm;
}
const ageMins = (stamp) => Math.round((NOW - Date.parse(String(stamp).replace(' ', 'T') + 'Z')) / 60000);

// Runs one surface's block against one payload. `lang` picks which half of
// every pair comes back, so the Chinese line is asserted from the same run the
// English one is.
// `shared` stands in for 29-channel-sync.js's csChannelName export. Left out,
// the sandbox has no such global and the block must fall back to its own map —
// which is the page-without-that-module case, and the case every other test
// here runs in, so the fallback is exercised throughout rather than assumed.
function runDesk(ops, lang, shared) {
  const fires = [];
  const ctx = {
    DASH_OPS: ops,
    fires,
    ...(shared ? { csChannelName: shared } : {}),
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    tdWhen: (t, kind) => fmt(t instanceof Date ? t.getTime() : t, kind),
    dashNow: () => NOW,
    dashAgeMins: ageMins,
    document: { documentElement: { dataset: { uiLang: lang } } },
  };
  vm.runInNewContext(`(function(){${DESK_BLOCK}})()`, ctx);
  return fires;
}
function runPhone(ops, lang) {
  const f = [];
  const ctx = {
    o: ops,
    f,
    T: (en, cn) => (lang === 'cn' ? cn : en),
    _date: (s) => { const t = Date.parse(String(s).replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? new Date(t) : null; },
    shopDayOf: (d) => dayOf(d.getTime()),
    shopToday: () => TODAY,
    tdWhen: (t, kind) => fmt(t instanceof Date ? t.getTime() : t, kind),
    _tdL: () => lang,
    oldestMins: (rows) => ageMins(rows[0].waiting_since),
    canRoute: () => true,
  };
  vm.runInNewContext(`(function(){${PHONE_BLOCK}})()`, ctx);
  return f;
}
// One row's facts, named the same on both surfaces so the cases can be written
// once. `meta` is the phone's word for what the desktop calls `state`.
function rowOf(fire) {
  if (!fire) return null;
  return { label: fire.label, n: fire.n, line: fire.state != null ? fire.state : fire.meta, mins: fire.mins };
}
const SURFACES = [['desktop', runDesk], ['phone', runPhone]];
// Both surfaces, one case. Anything asserted here is asserted of Home, not of
// one screen's copy of it.
function both(name, ops, lang, assert) {
  check(name, () => {
    for (const [who, run] of SURFACES) {
      const fires = run(ops, lang);
      try { assert(fires, rowOf(fires[0])); }
      catch (e) { throw new Error(`${who}: ${e.message}`); }
    }
  });
}

// ── Payload helpers ─────────────────────────────────────────────────────────
const SEP7 = '2026-09-07 17:56:00';   // the stamp in Ash's screenshot
const SEP7_LATER = '2026-09-07 19:30:00';
const TODAY_0900 = '2026-09-12 01:20:00';
const att = (count, by_channel, oldest_at) => ({ count, by_channel, oldest_at });
const stall = (channel, waiting_count, oldest_at, label) =>
  ({ channel, label: label || channel, waiting_count, oldest_at });

// ── The removal ─────────────────────────────────────────────────────────────
section('The per-channel row is gone from both surfaces');

check('neither surface builds a row labelled "<channel> not syncing" any more', () => {
  // The row is gone; the PHRASE survives inside the one row's state line, and
  // on the Channel sync page's own channel strip, which is where it belongs.
  // So this asserts on the row builders, not on the words.
  ok(!/label: cuT\(`\$\{c\.label\} not syncing`/.test(DESK), 'desktop still pushes a per-channel fire');
  ok(!/label:T\(c\.label\+' not syncing'/.test(PHONE), 'phone still pushes a per-channel fire');
});

check('and neither loops the stall list into fires of its own', () => {
  ok(!/for \(const c of \(DASH_OPS\.channel_sync_stale \|\| \[\]\)\)/.test(DESK), 'desktop loop still there');
  ok(!/for\(const c of \(o\.channel_sync_stale\|\|\[\]\)\)/.test(PHONE), 'phone loop still there');
});

check('the server still SENDS both halves — the merge is on the screen only', () => {
  // Deleting channel_sync_stale from /dashboard/ops would take the stall away
  // from the Channel sync page too, which is the one place it is said in full.
  const rt = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  ok(/channel_sync_stale,\s*channel_items_attention/.test(rt), 'ops payload lost a key');
  const items = fs.readFileSync(path.join(ROOT, 'lib/channel-sync-items.js'), 'utf8');
  ok(/channelSyncStale\(db, nowMs\)/.test(items), 'the page card no longer reads the stall');
});

// ── One row, not two ────────────────────────────────────────────────────────
section('One row, not two');

both('the screenshot case is ONE row, not the two it showed',
  { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(fires.length, 1, 'row count');
    eq(row.label, 'Channel sync', 'label');
  });

both('…and it says the channel is not syncing, rather than counting its items twice',
  { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(row.line, 'Meituan not syncing, wrong since 2026-09-07 17:56', 'state line');
    // A channel that is not syncing AT ALL is the larger fact; "Meituan not
    // syncing, Meituan 2" says one channel twice in seven words.
    ok(!/Meituan 2/.test(row.line), 'the stalled channel is also counted as items');
  });

both('the pill counts ITEMS while there are any — the number Ash already reads',
  { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(row.n, 2, 'pill');
    // 2 items + 3 waiting targets = 5, which would mean neither. Same trap the
    // Restock pill above it carries its own comment about.
    ok(row.n !== 5, 'the two counts were summed');
  });

// ── The half that had no other voice ────────────────────────────────────────
section('A dead channel still lights Home');

both('stall alone still lights the row — every item green, the channel dead',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 1683, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(fires.length, 1, 'row count — 越秀 went silent');
    eq(row.line, 'Meituan not syncing, wrong since 2026-09-07 17:56', 'state line');
  });

both('…and its pill is the waiting count, because there is no item count to show',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 1683, SEP7, 'Meituan')] },
  'en', (fires, row) => eq(row.n, 1683, 'pill'));

both('…and it sorts on the stall\'s own age, so it outranks a newer fire',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 1683, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(row.mins, ageMins(SEP7), 'mins');
    ok(row.mins > 6000, 'a five-day stall must not read as minutes old');
  });

both('nothing wrong anywhere is still no row at all — a shorter Home is the good news',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [] },
  'en', (fires) => eq(fires.length, 0, 'row count'));

both('an absent payload answers rather than throwing',
  {}, 'en', (fires) => eq(fires.length, 0, 'row count'));

// ── Several channels ────────────────────────────────────────────────────────
section('Several channels at once');

both('one down, one drifting: both named, in one line',
  { channel_items_attention: att(4, { eleme: 4 }, TODAY_0900), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(fires.length, 1, 'row count');
    eq(row.line, 'Meituan not syncing, Eleme: 4 need attention, wrong since 2026-09-07 17:56', 'state line');
    eq(row.n, 4, 'pill');
  });

both('the clock is the OLDER of the two facts, not whichever key came first',
  // Items wrong since this morning; the channel dead since last Sunday. The
  // row must say Sunday: that is when a customer could first read a wrong
  // number, and it is also the age the row sorts on.
  { channel_items_attention: att(4, { eleme: 4 }, TODAY_0900), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    ok(/2026-09-07 17:56/.test(row.line), `older stamp missing: ${row.line}`);
    eq(row.mins, ageMins(SEP7), 'mins');
  });

both('…and the other way round: items older than the stall win the clock',
  { channel_items_attention: att(4, { eleme: 4 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7_LATER, 'Meituan')] },
  'en', (fires, row) => eq(row.mins, ageMins(SEP7), 'mins'));

both('all three channels, each with its own worst fact',
  { channel_items_attention: att(9, { meituan: 2, eleme: 4, guanyi: 3 }, SEP7),
    channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'en', (fires, row) => {
    eq(row.line, 'Meituan not syncing, Eleme: 4 need attention, GZ Grocery: 3 need attention, wrong since 2026-09-07 17:56', 'state line');
    eq(row.n, 9, 'pill counts every wrong item, the stalled channel\'s included');
  });

both('a fourth channel the name map has never heard of is still said, not dropped',
  { channel_items_attention: att(2, { douyin: 2 }, SEP7), channel_sync_stale: [] },
  'en', (fires, row) => ok(/douyin: 2 need attention/.test(row.line), `unknown channel dropped: ${row.line}`));

both('…and a fourth channel that is DOWN is named from the label the server sent',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('douyin', 7, SEP7, 'Douyin')] },
  'en', (fires, row) => {
    ok(/Douyin not syncing/.test(row.line), `unknown stalled channel dropped: ${row.line}`);
    eq(row.n, 7, 'pill');
  });

both('two channels down at once — both named, both waiting counts in the pill',
  { channel_items_attention: att(0, {}, null),
    channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan'), stall('eleme', 5, SEP7_LATER, 'Eleme')] },
  'en', (fires, row) => {
    eq(row.line, 'Meituan not syncing, Eleme not syncing, wrong since 2026-09-07 17:56', 'state line');
    eq(row.n, 8, 'pill');
  });

// ── The clock ───────────────────────────────────────────────────────────────
section('The clock');

both('a fact from today reads as a bare time',
  { channel_items_attention: att(2, { meituan: 2 }, TODAY_0900), channel_sync_stale: [] },
  'en', (fires, row) => eq(row.line, 'Meituan: 2 need attention, wrong since 01:20', 'state line'));

both('…and one from another day carries its date, or the row argues with its own order',
  { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [] },
  'en', (fires, row) => eq(row.line, 'Meituan: 2 need attention, wrong since 2026-09-07 17:56', 'state line'));

both('a stall with no readable stamp still lights the row, silent about when',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 3, null, 'Meituan')] },
  'en', (fires, row) => {
    eq(fires.length, 1, 'row count');
    eq(row.line, 'Meituan not syncing', 'state line');
    eq(row.mins, null, 'no age to sort on');
  });

both('the row never appends a duration on top of the clock it already says',
  { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [] },
  'en', (fires) => ok(fires[0].noAutoAge === true || fires[0].age === false,
    'the age suffix is not suppressed — the line would read "…17:56, oldest 5d"'));

// ── §106 · a stopped channel ────────────────────────────────────────────────
// GZ Grocery was signed out for a day and Home said nothing: its queue had not
// yet counted as stalled and no item was provably wrong. The block is said from
// the first failed read, and it is the worst thing this row can say.
section('§106 · a stopped channel lights the row on its own');

const blocked = (key, by, at, label) => ({ key, label: label || key, tab: key, blocked: { by, at, store: 'tianhe' } });

both('a signed-out channel alone lights the row, brick, and names the cause',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [],
    channel_blocked: [blocked('guanyi', 'needs_login', SEP7, 'GZ Grocery')] },
  'en', (fires, row) => {
    eq(fires.length, 1, 'row count');
    eq(fires[0].sev, 'brick', 'severity');
    ok(/GZ Grocery is signed out/.test(row.line), `state line: ${row.line}`);
    eq(row.n, 1, 'the pill counts stopped channels when nothing else has a count');
  });

both('the block outranks the stall on the same channel, and is said once',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('eleme', 10, SEP7, 'Eleme')],
    channel_blocked: [blocked('eleme', 'auth_required', SEP7_LATER, 'Eleme')] },
  'en', (fires, row) => {
    ok(/Eleme is signed out/.test(row.line), `state line: ${row.line}`);
    ok(!/Eleme not syncing/.test(row.line), `said twice: ${row.line}`);
  });

both('a signed-out channel carries its own count, so the line adds up to the pill',
  { channel_items_attention: att(25, { meituan: 2, eleme: 23 }, SEP7), channel_sync_stale: [],
    channel_blocked: [blocked('eleme', 'auth_required', SEP7_LATER, 'Eleme')] },
  'en', (fires, row) => {
    eq(row.n, 25, 'pill');
    ok(/Meituan: 2 need attention/.test(row.line), `Meituan count unlabelled: ${row.line}`);
    ok(/Eleme is signed out \(23 need attention\)/.test(row.line), `Eleme count missing: ${row.line}`);
  });

both('a captcha is named, in Chinese too',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [],
    channel_blocked: [blocked('meituan', 'verify_required', SEP7, 'Meituan')] },
  'cn', (fires, row) => ok(/美团 需要人工验证/.test(row.line), `state line: ${row.line}`));

both('signed out reads in Chinese with the locked pair',
  { channel_items_attention: att(0, {}, null), channel_sync_stale: [],
    channel_blocked: [blocked('meituan', 'needs_login', SEP7, 'Meituan')] },
  'cn', (fires, row) => ok(/美团 已退出登录/.test(row.line), `state line: ${row.line}`));

// ── Chinese ─────────────────────────────────────────────────────────────────
section('Chinese');

both('the whole line is Chinese, channel names included',
  { channel_items_attention: att(4, { eleme: 4 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  'cn', (fires, row) => {
    eq(row.label, '渠道同步', 'label');
    ok(/美团 未同步/.test(row.line), `Meituan not localised: ${row.line}`);
    ok(/饿了么 4 个待处理/.test(row.line), `Eleme not localised: ${row.line}`);
    ok(/自 2026-09-07 17:56 起不符/.test(row.line), `clock not localised: ${row.line}`);
    ok(!/Meituan|Eleme/.test(row.line), `English leaked into the Chinese line: ${row.line}`);
  });

check('no new Chinese string was minted for this row — every pair is live', () => {
  // CLAUDE.md: a composed string must be declared in the vocabulary in the same
  // commit. Nothing here is composed — `未同步` came off the row being removed
  // and off 29-channel-sync.js, `渠道同步` and `起不符` off §103's own row — so
  // there is nothing to declare, and this is what keeps that true.
  // Every one of these is live: `未同步` off the row being removed and off
  // 29-channel-sync.js; `渠道同步`, `查看商品` and the `自 … 起不符` pair off
  // §103's own row; the two channel names off its CH map; and the phone's
  // "Review this on desktop" toast off the fallback it already shipped.
  // §106's stopped channel adds two lifts, neither composed: `已退出登录` is the
  // vocabulary's locked "… is signed out" pair, and `需要人工验证` is the tail of
  // the Meituan daemon's own captcha alert, verbatim. §252 puts the desktop
  // row's button on `重新登录` when a sign-out is the worst thing on it — the
  // vocabulary's declared Sign in again pair. The phone row has no button.
  // A count now says what it counts (Ash: "Meituan 2" did not say 2 what):
  // `N 个待处理` is the Channel sync strip's own live pair, copied.
  const LIVE = {
    desktop: ['未同步', '渠道同步', '查看商品', '美团', '饿了么', '自', '起不符', '已退出登录', '需要人工验证', '重新登录', '个待处理'],
    phone: ['未同步', '渠道同步', '美团', '饿了么', '自', '起不符', '请在电脑端查看', '已退出登录', '需要人工验证', '个待处理'],
  };
  for (const [who, src] of [['desktop', DESK_BLOCK], ['phone', PHONE_BLOCK]]) {
    // Comments come out first: both blocks name 越秀 in prose, and a check that
    // reads prose is one that goes red on the next sentence somebody writes.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The exact set, not a "contains" — a pinned set goes red when a string is
    // ADDED, which is the thing that needs declaring. `自` and `起不符` are two
    // fragments of one live pair, split by the clock interpolated between them.
    const found = [...new Set([...code.matchAll(/[一-鿿]+/g)].map((m) => m[0]))].sort();
    eq(found, LIVE[who].slice().sort(),
      `${who}: the row's Chinese changed — declare any new string in docs/tacet-delivery-vocabulary.md`);
  }
});

// ── The channel's name ──────────────────────────────────────────────────────
section('The channel\'s name comes from the one place that owns it');

check('desktop: the row asks csChannelName rather than answering for itself', () => {
  // §103's bilingual fix took the Products page off its own copy of the names
  // because two copies are how two screens drift. This row must not reinstate
  // one: its own map is the page-without-that-module fallback, nothing more.
  const ops = { channel_items_attention: att(4, { eleme: 4 }, SEP7),
    channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] };
  const shared = (k) => ({ meituan: 'MEITUAN!', eleme: 'ELEME!' })[k] || k;
  const line = rowOf(runDesk(ops, 'en', shared)[0]).line;
  ok(/MEITUAN! not syncing/.test(line), `the stalled channel kept a local name: ${line}`);
  ok(/ELEME!: 4 need attention/.test(line), `the drifting channel kept a local name: ${line}`);
});

check('…and falls back to its own pair when that module has not loaded', () => {
  const ops = { channel_items_attention: att(4, { eleme: 4 }, SEP7),
    channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] };
  eq(rowOf(runDesk(ops, 'en')[0]).line, 'Meituan not syncing, Eleme: 4 need attention, wrong since 2026-09-07 17:56');
  ok(/美团 未同步/.test(rowOf(runDesk(ops, 'cn')[0]).line), 'the fallback is bilingual too');
});

check('…guarded by typeof, the same way 12-guanyi.js guards its own call', () => {
  // A bare reference to an undefined global throws; §103's bilingual fix settled
  // that pattern and this must not invent a second one. The second witness WAS
  // 09-products.js, whose `_paChName` went with the Channels card in §126; the
  // GZ Grocery tab names the same channel the same guarded way, so it is the
  // witness now. Any live caller of csChannelName would do — what this pins is
  // that the shape is shared, not which file happens to share it.
  ok(/typeof csChannelName === 'function'/.test(DESK_BLOCK), 'unguarded reference');
  const guanyi = fs.readFileSync(path.join(ROOT, 'public/retail-admin/12-guanyi.js'), 'utf8');
  ok(/typeof csChannelName === 'function'/.test(guanyi), 'the pattern being matched has moved');
});

// ── The chip ────────────────────────────────────────────────────────────────
section('Where the chip lands');

check('desktop: with items wrong it opens Needs attention; with only a stall, All items', () => {
  // "Needs attention" is empty when the only fact is a stall — every item is
  // green — so a chip landing there would answer the row with a blank table.
  // All items puts the channel strip, which says the stall in full, on screen.
  eq(runDesk({ channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [] }, 'en')[0].go,
    "csOpen('att')", 'items chip');
  eq(runDesk({ channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] }, 'en')[0].go,
    "csOpen('all')", 'stall-only chip');
});

check('phone: both cases open the channelsync screen, which has one view', () => {
  for (const ops of [
    { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [] },
    { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
  ]) ok(/APP\.cmd\('push','channelsync'\)/.test(runPhone(ops, 'en')[0].go), 'chip does not open the screen');
});

check('phone: a role that cannot open that screen still SEES the row', () => {
  // No gate on seeing it, deliberately: every role that sees Home should see
  // when a channel stops syncing. Only the destination is gated.
  const f = [];
  const ctx = {
    o: { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
    f,
    T: (en) => en,
    _date: (s) => new Date(Date.parse(String(s).replace(' ', 'T') + 'Z')),
    shopDayOf: (d) => dayOf(d.getTime()),
    shopToday: () => TODAY,
    tdWhen: (t, kind) => fmt(t instanceof Date ? t.getTime() : t, kind),
    _tdL: () => 'en',
    oldestMins: (rows) => ageMins(rows[0].waiting_since),
    canRoute: () => false,
  };
  vm.runInNewContext(`(function(){${PHONE_BLOCK}})()`, ctx);
  eq(f.length, 1, 'row count');
  ok(/showToast/.test(f[0].go), 'a role without the screen gets no honest answer');
});

// ── Both surfaces say the same thing ────────────────────────────────────────
section('The two surfaces agree');

check('every case above produced an identical row on desktop and phone', () => {
  // Asserted again as a whole, because the two blocks are separate code and the
  // cheapest way for them to drift is for one to be edited and not the other.
  const cases = [
    { channel_items_attention: att(2, { meituan: 2 }, SEP7), channel_sync_stale: [stall('meituan', 3, SEP7, 'Meituan')] },
    { channel_items_attention: att(0, {}, null), channel_sync_stale: [stall('meituan', 1683, SEP7, 'Meituan')] },
    { channel_items_attention: att(9, { meituan: 2, eleme: 4, guanyi: 3 }, TODAY_0900), channel_sync_stale: [stall('eleme', 5, SEP7, 'Eleme')] },
    { channel_items_attention: att(0, {}, null), channel_sync_stale: [] },
  ];
  for (const lang of ['en', 'cn']) {
    for (const ops of cases) {
      eq(runDesk(ops, lang).map(rowOf), runPhone(ops, lang).map(rowOf),
        `${lang}: surfaces disagree on ${JSON.stringify(ops)}`);
    }
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
