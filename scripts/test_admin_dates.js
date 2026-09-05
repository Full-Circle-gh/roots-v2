#!/usr/bin/env node
/**
 * The desktop admin renders on the store's clock — audit C-02, A-05's client half.
 *
 * C-02 is titled "Four date formats across the admin, and one shared formatter
 * most screens ignore". The formatter is public/td-datetime.js and the screens
 * did ignore it, in two separate ways that this file keeps closed:
 *
 *   THE ZONE. Eighteen call sites across nine parts computed "today" as
 *   `new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)` —
 *   Guangzhou, written out longhand. A-05 taught the SERVER to count a
 *   business day on the account's own clock; the client kept asking it about
 *   Guangzhou's. On any account outside UTC+8 the dashboard's range presets,
 *   Finance's presets, the KPI rows on Orders / Customers / Products, the
 *   late-delivery pill on Purchasing and the default date on a new ledger row
 *   were all a day out — and Finance is the screen where a day out is money in
 *   the wrong month.
 *
 *   THE FORMAT. Around a dozen more rendered with toLocaleDateString /
 *   toLocaleTimeString, which format in the BROWSER's zone and, worse, in
 *   whatever locale the call site happened to name: 'en-GB' on the dashboard's
 *   purchase-order cards ("29 Jul") beside 'en-US' on its own range label
 *   ("Jul 29"), and no locale at all on the printed count sheet, where the
 *   operator's OPERATING SYSTEM decided whether a document read 29/07/2026 or
 *   7/29/2026.
 *
 * §1–§3 are STATIC, because that is what a defect of this shape needs. Neither
 * mistake looks wrong in a diff — `+ 8 * 3600 * 1000` reads as care about
 * timezones rather than the absence of it — and under a single store zone
 * every screen renders identically either way, so no render test can see it.
 * §4 then drives the real tdToday under three zones, which is the only place
 * the difference actually shows.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARTS_DIR = path.join(ROOT, 'public', 'retail-admin');
const PARTS = fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith('.js')).sort();

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* Comments stripped before every static check. This file's own subject matter
   is these very strings, and half the fixes left a note behind saying what the
   line used to be — a check that cannot tell a call from the comment above it
   fails on its own documentation. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const CODE = {};
for (const f of PARTS) CODE[f] = strip(fs.readFileSync(path.join(PARTS_DIR, f), 'utf8'));

function hits(re) {
  const out = [];
  for (const f of PARTS) {
    const m = CODE[f].match(re);
    if (m) out.push(`${f} ×${m.length}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
section("1 · nothing in the admin knows where Guangzhou is");

/* The literal itself, in the two spacings the codebase used. It is banned
   OUTRIGHT rather than reviewed per site: a fixed offset is never the right
   way to ask what day it is somewhere, and the one place that legitimately
   needs a zone reads it from the account. */
{
  const found = hits(/8\s*\*\s*3600\s*\*\s*1000/g);
  is(found.length, 0, 'no part computes a date by adding eight hours to now');
  if (found.length) console.log('      ' + found.join(', ') + ' — use tdToday()');
}
{
  /* The HELPER names, not every mention of the place. `gzgrocery` is a sales
     channel that is genuinely called that, and banning the letters would make
     this check cry wolf on a channel name for the rest of the product's life. */
  const found = hits(/\btodayGz\b|\bGZ_ISO\b|\bGZ_TODAY\b|\bactGzToday\b|\bgzToday\b/g);
  is(found.length, 0, 'and no date helper is still NAMED for one city');
  if (found.length) console.log('      ' + found.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · one formatter, not four');

const BANNED = [
  ['toLocaleDateString', 'the browser zone and a per-call-site locale — use tdWhen(v, \'date\')'],
  ['toLocaleTimeString', 'the browser zone and a per-call-site locale — use tdWhen(v, \'time\')'],
  ['toDateString', 'groups on the BROWSER\'s calendar — compare tdWhen(a, \'machine\') instead'],
];
for (const [needle, why] of BANNED) {
  const found = hits(new RegExp('\\.' + needle + '\\s*\\(', 'g'));
  is(found.length, 0, `no ${needle} in any admin part`);
  if (found.length) console.log('      ' + found.join(', ') + '\n      ' + why);
}

/* toLocaleString is NOT banned — it is how every number on these screens gets
   its thousands separators. What is banned is reaching for it with a date. */
{
  const found = hits(/\b(?:dt|ts|[a-z]*[Dd]ate)\.toLocaleString\s*\(|new Date\([^)]*\)\.toLocaleString\s*\(/g);
  is(found.length, 0, 'toLocaleString is used on numbers only, never on a Date');
  if (found.length) console.log('      ' + found.join(', ') + " — the printed documents' footers were the last two");
}

/* NOT a blanket ban on locale strings. `Number.toLocaleString('en-US')` is how
   every figure on these screens gets its thousands separators, and grouping is
   not a date convention — I-01 settled the money formats separately. The three
   bans above are the whole vector: once no Date reaches a toLocale* call, a
   locale string can only be describing a number. */
{
  const found = hits(/'(?:en-GB|zh-Hans)'/g);
  is(found.length, 0, "no part reaches for a locale nothing here formats in — 'en-GB' was the dashboard's fourth format");
  if (found.length) console.log('      ' + found.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · the module is there to be used');

const SHELL = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
/* The SCRIPT tags. Both files also have a <link rel="preload"> hundreds of
   lines earlier, and preload order says nothing about execution order. */
const iTd = SHELL.indexOf('<script src="/assets/td-datetime.js">');
const iCore = SHELL.indexOf('<script src="/assets/retail-admin/01-core.js">');
yes(iTd > 0, 'retail-admin.html loads /assets/td-datetime.js');
yes(iTd > 0 && iCore > 0 && iTd < iCore, '…before the parts that call into it');

/* The zone has to arrive, or every one of the calls above quietly renders on
   td-datetime's fallback and the whole pass is decorative. */
const MARKETING = fs.readFileSync(path.join(PARTS_DIR, '05-marketing.js'), 'utf8');
yes(/window\.TD_TZ = c\.timezone/.test(MARKETING),
  'loadConfig assigns window.TD_TZ from the account config');

/* The eight names are a closed set, and tdToday is an export beside tdRange
   rather than a ninth one. Pinned so a future "just add a name" is a
   conversation and not a commit. */
const TD = require('../public/td-datetime.js');
is(TD.NAMES.length, 8, 'the name set is still eight long');
is(typeof TD.tdToday, 'function', 'tdToday is exported');
yes(TD.NAMES.indexOf('today') === -1, 'and is NOT a ninth name');

// ─────────────────────────────────────────────────────────────────────────
section("4 · tdToday, under three shops' clocks");

/* The whole point, and the reason §1 is a ban rather than a review. 20:30 UTC
   is already tomorrow in Shanghai and still today in New York. An admin that
   asks the server for the wrong one of those is asking about the wrong day's
   money — and under any single zone the old code and the new code agree
   exactly, which is how this survived being read many times. */
const RealDate = Date;
const AT = new RealDate('2026-07-29T20:30:00Z');
global.Date = class extends RealDate {
  constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AT); }
  static now() { return AT.getTime(); }
};
global.Date.UTC = RealDate.UTC;
const inZone = (tz, fn) => {
  const before = global.TD_TZ;
  global.TD_TZ = tz;
  try { return fn(); } finally { global.TD_TZ = before; }
};

is(inZone('Asia/Shanghai', () => TD.tdToday()), '2026-07-30', 'a Shanghai shop is on the 30th');
is(inZone('America/New_York', () => TD.tdToday()), '2026-07-29', 'a New York shop is still on the 29th');
is(inZone('Pacific/Auckland', () => TD.tdToday()), '2026-07-30', 'Auckland is on the 30th');
is(inZone('UTC', () => TD.tdToday()), '2026-07-29', 'and UTC is on the 29th');

/* The four range presets, which is where most of the eighteen sites were. */
for (const [tz, today, d7, d30, d90] of [
  ['Asia/Shanghai', '2026-07-30', '2026-07-24', '2026-07-01', '2026-05-02'],
  ['America/New_York', '2026-07-29', '2026-07-23', '2026-06-30', '2026-05-01'],
]) {
  is(inZone(tz, () => TD.tdToday()), today, `${tz}: today`);
  is(inZone(tz, () => TD.tdToday(-6)), d7, `${tz}: the 7-day anchor`);
  is(inZone(tz, () => TD.tdToday(-29)), d30, `${tz}: the 30-day anchor`);
  is(inZone(tz, () => TD.tdToday(-89)), d90, `${tz}: the 90-day anchor`);
}

/* Calendar arithmetic, not milliseconds. New York's summer-time change is
   2026-11-01; stepping back across it off an INSTANT lands an hour out, which
   moves the answer a whole day whenever now is within that hour of midnight. */
is(inZone('America/New_York', () => TD.tdToday(-1)), '2026-07-28', 'yesterday');
is(inZone('America/New_York', () => TD.tdToday(1)), '2026-07-30', 'tomorrow');
is(inZone('America/New_York', () => TD.tdToday(-210)), '2025-12-31', 'and across a year end');

global.Date = RealDate;

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
