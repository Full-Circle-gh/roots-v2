/* Asserts public/td-datetime.js against the format table in
   docs/tacet-desktop-patterns.md §1.18, in both languages.

   Run:  node scripts/td-datetime-check.js

   §7's audit is executable on purpose; this makes §1.18 executable too.
   If a row here and the §1.18 table disagree, ONE of them is wrong and
   the answer is not "adjust the test" — a formatting contract nobody can
   run is how eight formats shipped in the first place. */
const { tdWhen, tdRange, tdTimeWindow } = require('../public/td-datetime.js');

let pass = 0, fail = 0;
function is(got, want, label) {
  if (got === want) { pass++; console.log('  ok   ' + label + '  →  ' + got); }
  else { fail++; console.log('  FAIL ' + label + '\n       got:  ' + JSON.stringify(got) + '\n       want: ' + JSON.stringify(want)); }
}

// Pin "now" so the year rule is deterministic: today is 2026-07-29 (GZ).
const RealDate = Date;
const NOW = new RealDate('2026-07-29T06:49:00Z'); // 14:49 Asia/Shanghai
global.Date = class extends RealDate {
  constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(NOW); }
  static now() { return NOW.getTime(); }
};
global.Date.UTC = RealDate.UTC;

// SQLite shape: UTC, no zone marker. 06:49Z = 14:49 in Asia/Shanghai.
const T = '2026-07-29 06:49:00';
const OLD = '2025-12-14 06:49:00';

console.log('\nEnglish — the §1.18 table');
is(tdWhen(T, 'dateTime', { lang: 'en' }), 'Jul 29, 2:49 PM', 'dateTime · this year');
is(tdWhen(OLD, 'dateTime', { lang: 'en' }), 'Dec 14, 2025, 2:49 PM', 'dateTime · other year');
is(tdWhen(T, 'date', { lang: 'en' }), 'Jul 29', 'date · this year');
is(tdWhen(OLD, 'date', { lang: 'en' }), 'Dec 14, 2025', 'date · other year');
is(tdWhen(T, 'time', { lang: 'en' }), '2:49 PM', 'time');
is(tdWhen(T, 'weekday', { lang: 'en' }), 'Wednesday, July 29', 'weekday · this year');
is(tdWhen(OLD, 'weekday', { lang: 'en' }), 'Sunday, December 14, 2025', 'weekday · other year');
is(tdWhen(T, 'month', { lang: 'en' }), 'July 2026', 'month');
is(tdWhen(T, 'machine', { lang: 'en' }), '2026-07-29', 'machine');
is(tdRange('2026-07-01', '2026-07-29', { lang: 'en' }), 'Jul 1 – 29', 'range · same month');

console.log('\nChinese — the §1.18 table');
is(tdWhen(T, 'dateTime', { lang: 'cn' }), '7月29日 14:49', 'dateTime · this year');
is(tdWhen(OLD, 'dateTime', { lang: 'cn' }), '2025年12月14日 14:49', 'dateTime · other year');
is(tdWhen(T, 'date', { lang: 'cn' }), '7月29日', 'date');
is(tdWhen(T, 'time', { lang: 'cn' }), '14:49', 'time · 24-hour');
is(tdWhen(T, 'weekday', { lang: 'cn' }), '7月29日 周三', 'weekday');
is(tdWhen(T, 'month', { lang: 'cn' }), '2026年7月', 'month');
is(tdWhen(T, 'machine', { lang: 'cn' }), '2026-07-29', 'machine · identical in CN');
is(tdRange('2026-07-01', '2026-07-29', { lang: 'cn' }), '7月1日–29日', 'range · same month');

console.log('\nThe mockup rows — every clock in the screenshot');
[['2026-07-29 06:49:00', 'Jul 29, 2:49 PM'], ['2026-07-29 05:37:00', 'Jul 29, 1:37 PM'],
 ['2026-07-29 04:10:00', 'Jul 29, 12:10 PM'], ['2026-07-29 03:37:00', 'Jul 29, 11:37 AM'],
 ['2026-07-29 01:40:00', 'Jul 29, 9:40 AM'], ['2026-07-29 04:03:00', 'Jul 29, 12:03 PM']]
  .forEach(([iso, want]) => is(tdWhen(iso, 'dateTime', { lang: 'en' }), want, iso));

console.log('\nMidnight + noon — the two the 12-hour clock always gets wrong');
is(tdWhen('2026-07-28 16:00:00', 'time', { lang: 'en' }), '12:00 AM', '00:00 → 12:00 AM');
is(tdWhen('2026-07-29 04:00:00', 'time', { lang: 'en' }), '12:00 PM', '12:00 → 12:00 PM');
is(tdWhen('2026-07-28 16:00:00', 'time', { lang: 'cn' }), '00:00', '00:00 stays 00:00 in CN');
is(tdWhen('2026-07-28 16:00:00', 'dateTime', { lang: 'en' }), 'Jul 29, 12:00 AM', 'midnight rolls the DATE forward in GZ');

console.log('\nThe UTC trap — a missing Z shifts every stamp');
is(tdWhen(new Date('2026-07-29T06:49:00Z'), 'dateTime', { lang: 'en' }), 'Jul 29, 2:49 PM', 'Date object');
is(tdWhen('2026-07-29T06:49:00Z', 'dateTime', { lang: 'en' }), 'Jul 29, 2:49 PM', 'explicit Z');
is(tdWhen(1785307740000, 'dateTime', { lang: 'en' }), 'Jul 29, 2:49 PM', 'epoch ms');

console.log('\nDay-only values are calendar days, never converted');
is(tdWhen('2026-07-30', 'date', { lang: 'en' }), 'Jul 30', 'ship-by stays Jul 30');
is(tdWhen('2026/10/6', 'date', { lang: 'en' }), 'Oct 6', 'dirty stored value 2026/10/6');
is(tdWhen('2026-07-30', 'machine', { lang: 'en' }), '2026-07-30', 'day-only → machine');
is(tdWhen('2026-07-30', 'time', { lang: 'en' }), 'Jul 30', 'a day has no clock — falls back to date');

console.log('\nEmpty and junk');
is(tdWhen(null, 'date'), '', 'null');
is(tdWhen('', 'date'), '', 'empty string');
is(tdWhen('not a date', 'date'), '', 'junk');
is(tdWhen(undefined, 'dateTime'), '', 'undefined');

console.log('\nRelative');
is(tdWhen('2026-07-29 06:47:00', 'relative', { lang: 'en' }), '2 min ago', 'en · 2 min');
is(tdWhen('2026-07-29 06:47:00', 'relative', { lang: 'cn' }), '2分钟前', 'cn · 2 min');
is(tdWhen('2026-07-29 06:48:50', 'relative', { lang: 'en' }), 'just now', 'en · just now');
is(tdWhen('2025-11-29 06:49:00', 'relative', { lang: 'en' }), '8 months ago', 'en · 8 months');
is(tdWhen('2026-07-29 05:49:00', 'relative', { lang: 'en' }), '1 hr ago', 'en · singular');

console.log('\nRanges');
is(tdRange('2026-07-01', '2026-08-03', { lang: 'en' }), 'Jul 1 – Aug 3', 'en · same year');
is(tdRange('2025-12-01', '2026-01-03', { lang: 'en' }), 'Dec 1, 2025 – Jan 3, 2026', 'en · crosses year');
is(tdRange('2025-12-01', '2025-12-31', { lang: 'en' }), 'Dec 1 – 31, 2025', 'en · year at the END');
is(tdRange('2026-07-01', '2026-08-03', { lang: 'cn' }), '7月1日–8月3日', 'cn · same year');

console.log('\nDelivery windows — two clocks on one day');
// The real TC000138 case: a customer booked 16:00–18:00 and the EN admin
// rendered the raw 24-hour label back at them.
is(tdTimeWindow('2026-08-02 08:00:00', '2026-08-02 10:00:00', { lang: 'en' }), '4:00 – 6:00 PM', 'en · shared meridiem collapses');
is(tdTimeWindow('2026-08-02 08:00:00', '2026-08-02 10:00:00', { lang: 'cn' }), '16:00–18:00', 'cn · 24-hour');
is(tdTimeWindow('2026-08-02 03:00:00', '2026-08-02 05:00:00', { lang: 'en' }), '11:00 AM – 1:00 PM', 'en · crossing noon keeps both');
// Noon is PM, so a 10:30–12:00 window CROSSES the meridiem and must keep both —
// "10:30 – 12:00 PM" would read as a 90-minute afternoon window.
is(tdTimeWindow('2026-08-02 02:30:00', '2026-08-02 04:00:00', { lang: 'en' }), '10:30 AM – 12:00 PM', 'en · half-hour start, noon end');
is(tdTimeWindow('2026-08-02 08:00:00', null, { lang: 'en' }), '4:00 PM', 'one end only → a single time');
is(tdTimeWindow(null, null, { lang: 'en' }), '', 'no window at all');

console.log('\nThe eight names are a closed set');
try { tdWhen(T, 'shortDate'); is('no throw', 'throw', 'unknown name rejected'); }
catch (e) { is(/not one of the eight/.test(e.message), true, 'unknown name rejected'); }
try { tdWhen(T, 'range'); is('no throw', 'throw', 'range routed to tdRange'); }
catch (e) { is(/tdRange/.test(e.message), true, 'range routed to tdRange'); }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
