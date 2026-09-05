#!/usr/bin/env node
/**
 * The phone renders on the STORE's clock — audit C-02.
 *
 * The finding was written as tidiness: "the phone admin still has its own date
 * family". What that family actually did was worse than untidy. Every stamp on
 * public/m.html was drawn with toLocaleTimeString / toLocaleDateString, which
 * format in the DEVICE's timezone, while every stamp on the desktop goes
 * through /assets/td-datetime.js, which formats in the STORE's. The two
 * surfaces therefore disagreed about the same order for anyone not sitting in
 * the shop — the same defect A-04 fixed on the server, pointing the other way.
 * Three "today" computations were hardcoded to UTC+8 on top of that, which is
 * right for exactly one account and wrong for every other one Tacet takes on.
 *
 * The fix is convergence, not a second implementation: m.html loads the same
 * module the desktop does and renders through tdWhen. So this file checks two
 * things, and they are different in kind:
 *
 *   §1–§3  STATIC. That the device clock cannot come back. A file this size
 *          grows a new date every week, and one toLocaleDateString added in
 *          six months' time looks completely ordinary in a diff.
 *   §4–§7  BEHAVIOURAL. The shipped helpers, lifted out of the page and run
 *          against the REAL formatter under two different store zones, which
 *          is the only way to see the bug this fixed: for anything else the
 *          two zones agree and every assertion passes either way.
 *
 * Nothing here changes for the first tenant. Guangzhou is UTC+8, the fallback
 * is Asia/Shanghai, and every string this file asserts on is the string that
 * shipped yesterday.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const RET = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* The app's own script, comments stripped — every static check below reads
   CODE. This file's comments name toLocaleDateString and +8 repeatedly, and a
   check that could not tell a comment from a call would fail on its own
   documentation. */
const APP_JS = (M.match(/\n<script>\n"use strict";([\s\S]*?)\n<\/script>/) || [])[1] || '';
if (!APP_JS) {
  console.error('FAIL — cannot find the app script in public/m.html');
  process.exit(1);
}
const CODE = APP_JS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// ─────────────────────────────────────────────────────────────────────────
section('1 · the page loads the one formatter, and can survive without a network');

yes(/<script src="\/assets\/td-datetime\.js"><\/script>/.test(M),
  'm.html loads /assets/td-datetime.js — the same module the desktop renders with',
  'the phone is back to its own date family');

/* Ordering is not cosmetic: the app script runs top-to-bottom and calls tdWhen
   from render(), so a tag placed after it would define the helper too late. */
yes(M.indexOf('/assets/td-datetime.js') < M.indexOf('\n<script>\n"use strict";'),
  'it loads BEFORE the app script that calls into it');

yes(/const SHELL = \[[^\]]*'\/assets\/td-datetime\.js'/.test(SW),
  "sw.js precaches it with the shell — an installed app opened offline still renders",
  'stale-while-revalidate fetches it on the first ONLINE load, which is one load too late');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the device clock cannot come back');

/* Each of these is a way the browser's own zone gets used to draw a store's
   fact. They are banned outright rather than reviewed case by case, because
   every one of them reads as ordinary code. */
const BANNED = [
  ['toLocaleTimeString', 'formats in the DEVICE zone — use fmtTime / tdWhen'],
  ['toLocaleDateString', 'formats in the DEVICE zone — use fmtDay / fmtDateOnly / tdWhen'],
  ['toDateString', 'compares on the DEVICE calendar — use shopDayOf(a)===shopDayOf(b)'],
];
for (const [needle, why] of BANNED) {
  const n = CODE.split(needle).length - 1;
  is(n, 0, `no ${needle} anywhere in the app script`);
  if (n) console.log(`      ${why}`);
}

/* toLocaleString is NOT banned: it is how every number in this file gets its
   thousands separators, which has nothing to do with a clock. What is banned
   is calling it on a Date. */
yes(!/\b\w*[Dd]ate\w*\.toLocaleString\(|\bnew Date\([^)]*\)\.toLocaleString\(/.test(CODE),
  'toLocaleString is used on numbers only, never on a Date');

/* The three hardcoded +8s. "The store is in Guangzhou" was true of the only
   account there was, and stopped being a safe assumption the moment Tacet
   took a second one. */
is((CODE.match(/8\s*\*\s*3600\s*\*\s*1000/g) || []).length, 0,
  'no hardcoded +8 hour offset — the store zone comes from the account');
is((CODE.match(/\bGZ_ISO\b|\bGZ_TODAY\b/g) || []).length, 0,
  'the two GZ_ helpers are gone, name and all');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the zone reaches the page');

yes(/if\(cfg\.timezone\) window\.TD_TZ = cfg\.timezone;/.test(M),
  'loadLive assigns window.TD_TZ from the config it already fetches');

/* A settings read that nothing writes is the failure mode this pins: TD_TZ set
   from a key the endpoint does not return leaves every stamp on the fallback
   and looks, from the page, exactly like a working feature. */
yes(/res\.json\(\{ success: true, data: \{ \.\.\.loadConfig\(\), timezone \} \}\)/.test(RET),
  'GET /api/retail-admin/config really returns `timezone` — the key is not invented here');

/* Deliberately left on the handset's clock, and the only one. A greeting is a
   fact about the person holding the phone, not about the shop. */
yes(/function greetKey\(\)\{ const h=new Date\(\)\.getHours\(\)/.test(M),
  'the greeting alone still reads the handset — it addresses the operator, not the store');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the shipped helpers, run for real');

/* Lifted out of the page rather than re-typed. A copy asserts what this file
   thinks the app does; the lift asserts what the app does. */
function sliceBlock(anchor) {
  const start = M.indexOf(anchor);
  if (start < 0) throw new Error(`not found in the shipped file: ${anchor}`);
  const open = M.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < M.length; i++) {
    if (M[i] === '{') depth++;
    else if (M[i] === '}' && --depth === 0) return M.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}
function sliceLine(anchor) {
  const start = M.indexOf(anchor);
  if (start < 0) throw new Error(`not found in the shipped file: ${anchor}`);
  return M.slice(start, M.indexOf('\n', start));
}

const td = require('../public/td-datetime.js');
const SRC = [
  sliceBlock('const _date=v=>'),
  sliceLine('const _tdL='),
  sliceLine('const shopToday='),
  sliceBlock('const shopDayAdd=(iso,n)=>'),
  sliceLine('const shopDayOf='),
  sliceBlock('const shopTodayDate=()=>'),
  sliceLine('function fmtTime(v)'),
  sliceBlock('function fmtDay(v)'),
  sliceBlock('function fmtDateOnly(v)'),
].join(';\n');

/* One sandbox, and the store zone switched underneath it. td-datetime reads
   window.TD_TZ on EVERY call rather than caching it — which is what makes a
   page that learns its zone after boot render correctly on the next paint, and
   what lets this file put the same helpers in two shops. */
function phone(lang) {
  const ctx = {
    LANG: lang || 'en',
    T: (en, zh) => ((lang || 'en') === 'en' ? en : zh),
    tdWhen: td.tdWhen,
    Date, Math, Number, String, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + ';\nthis.fmtTime=fmtTime; this.fmtDay=fmtDay;'
    + ' this.fmtDateOnly=fmtDateOnly; this.shopToday=shopToday;'
    + ' this.shopDayAdd=shopDayAdd; this.shopDayOf=shopDayOf;'
    + ' this.shopTodayDate=shopTodayDate;', ctx);
  return ctx;
}
function inZone(tz, fn) {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
}

const EN = phone('en');
const CN = phone('cn');

/* 2026-01-15 21:30 UTC. In Guangzhou that is half past five the NEXT morning;
   in New York it is half past four the same afternoon. One instant, two
   calendar days, which is the whole of the bug. */
const NIGHT = '2026-01-15 21:30:00';

is(inZone('Asia/Shanghai', () => EN.shopDayOf(NIGHT)), '2026-01-16',
  'a 21:30 UTC order falls on the 16th for a Guangzhou shop');
is(inZone('America/New_York', () => EN.shopDayOf(NIGHT)), '2026-01-15',
  '…and on the 15th for a New York one — the same row, two shops, two days');
is(inZone('Asia/Shanghai', () => EN.fmtDay(NIGHT)), 'Jan 16',
  'the Guangzhou shop reads Jan 16');
is(inZone('America/New_York', () => EN.fmtDay(NIGHT)), 'Jan 15',
  'the New York shop reads Jan 15');
is(inZone('Asia/Shanghai', () => EN.fmtTime(NIGHT)), '5:30 AM',
  'and the times differ too, on the shop clock rather than the handset');
is(inZone('America/New_York', () => EN.fmtTime(NIGHT)), '4:30 PM',
  'New York reads the same instant as half past four in the afternoon');

is(inZone('Asia/Shanghai', () => CN.fmtTime(NIGHT)), '05:30',
  'Chinese keeps the 24-hour clock — the convention, not a translation of ours');
is(inZone('Asia/Shanghai', () => CN.fmtDay(NIGHT)), '1月16日',
  'and the Chinese date shape, in the store zone');

/* The language is passed EXPLICITLY from LANG. td-datetime falls back to
   cuLang(), which is the desktop's switch and does not exist on the phone —
   so a phone that did not pass it would render English to a Chinese operator
   and nothing would say so. */
yes(EN.fmtDay(NIGHT) !== CN.fmtDay(NIGHT),
  'the phone passes its own language through, rather than leaning on the desktop switch');

// ─────────────────────────────────────────────────────────────────────────
section('5 · a calendar day is not an instant');

/* A promised ship date has no clock in it. Converting one through a zone can
   move it to the day before — a ship-by of Jan 16 reading as Jan 15, and
   somebody shipping a day early. td-datetime reads day-only values literally
   and this is the check that it keeps doing so through the phone's helpers. */
for (const tz of ['Asia/Shanghai', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
  is(inZone(tz, () => EN.shopDayOf('2026-01-16')), '2026-01-16',
    `a bare date stays the day it says, in ${tz}`);
}
is(inZone('America/New_York', () => EN.fmtDay('2026-01-16')), 'Jan 16',
  'and renders as that day, not the one before it');

// ─────────────────────────────────────────────────────────────────────────
section('6 · today, yesterday, tomorrow — on the shop\'s calendar');

/* shopToday is what every "today" on this app is now counted from: the
   dashboard's date range, the late-purchase-order pill, the month a finance
   screen opens on. */
const today = inZone('Asia/Shanghai', () => EN.shopToday());
yes(/^\d{4}-\d{2}-\d{2}$/.test(today), 'shopToday is a machine date — never localised, never parsed back');

is(inZone('Asia/Shanghai', () => EN.fmtDateOnly(today)), 'Today', 'the shop\'s today reads Today');
is(inZone('Asia/Shanghai', () => CN.fmtDateOnly(today)), '今天', '…and 今天');
is(inZone('Asia/Shanghai', () => EN.fmtDateOnly(EN.shopDayAdd(today, -1))), 'Yesterday', 'the day before reads Yesterday');
is(inZone('Asia/Shanghai', () => EN.fmtDateOnly(EN.shopDayAdd(today, 1))), 'Tomorrow', 'the day after reads Tomorrow');
yes(!['Today', 'Tomorrow', 'Yesterday'].includes(
  inZone('Asia/Shanghai', () => EN.fmtDateOnly(EN.shopDayAdd(today, 2)))),
'two days out is a date, not a word');

/* Calendar arithmetic, not 86400000ms. In a zone that keeps summer time a day
   is 23 hours twice a year, and "yesterday" must not drift on those two days.
   New York's spring change is 2026-03-08. */
is(EN.shopDayAdd('2026-03-08', -1), '2026-03-07', 'the day before a DST change is the day before');
is(EN.shopDayAdd('2026-03-08', 1), '2026-03-09', 'and the day after is the day after');
is(EN.shopDayAdd('2026-01-01', -1), '2025-12-31', 'a year boundary is crossed correctly');
is(EN.shopDayAdd('2026-02-28', 1), '2026-03-01', 'so is the end of a short February');
is(EN.shopDayAdd('2024-02-28', 1), '2024-02-29', 'and a leap day is a day');
is(EN.shopDayAdd('', -1), '', 'a value with no date in it yields nothing rather than NaN-NaN-NaN');

/* The one caller that still needs a Date rather than a string: shipByUrgency
   subtracts it from a local-midnight Date to count days to a deadline. */
const md = inZone('Asia/Shanghai', () => EN.shopTodayDate());
is(md.getHours(), 0, 'shopTodayDate is local midnight, which is what its one caller subtracts');
is(`${md.getFullYear()}-${String(md.getMonth() + 1).padStart(2, '0')}-${String(md.getDate()).padStart(2, '0')}`,
  today, '…of the shop\'s today, not the handset\'s');

// ─────────────────────────────────────────────────────────────────────────
section('7 · nothing renders empty when a value is missing');

/* Every one of these used to return '' through an explicit `if(!d) return ''`.
   tdWhen returns '' for an unparseable value too, and this is the check that
   the ladders above did not turn one into 'Today' or a thrown error — which on
   this app means a screen that paints nothing at all. */
for (const empty of [null, undefined, '', 0, 'not a date']) {
  const label = JSON.stringify(empty);
  is(EN.fmtTime(empty), '', `fmtTime(${label}) is empty`);
  is(EN.fmtDay(empty), '', `fmtDay(${label}) is empty`);
  is(EN.fmtDateOnly(empty), '', `fmtDateOnly(${label}) is empty`);
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
