/* Asserts that the collection reschedule PICKER and the reschedule VALIDATOR
   agree on the pickup window — in EVERY case, including the ones where the
   order has no resolvable store.

   Run:  node scripts/test_pickup_window.js   (in the fast gate since §82's
   pickup fix; it was scripts/pickup-window-check.js, which nothing ran)

   What this protects. GET /orders/:id/reschedule-options tells the client
   which hours to offer; POST /orders/:id/reschedule decides which hours to
   accept. If those two ever disagree the customer is shown a time and then
   refused it, with nothing on screen explaining why. They agreed only by
   coincidence until the POST started reading the order's own store hours,
   at which point the GET's global window became wrong the moment anyone set
   per-store hours.

   Both now read one decision — pickupWindowFor(pickupStoreHoursForOrder(o)) —
   so the guard here is not "did someone copy the predicate correctly" but
   "does the window the picker publishes still bound exactly what the
   validator accepts". The predicate is subtle enough to be worth pinning:
   it requires BOTH ends together, so a store carrying an opening time and no
   closing time falls back WHOLE to the global window. A reading that checked
   only `open` would advertise 11:00–20:00 while the validator enforced
   10:00–20:00, and nothing else in the suite would notice.

   How it runs. routes/retail.js cannot be require()d from a check script —
   it opens the database on load, and better-sqlite3's native binding is not
   constructible on every dev machine. The three functions are therefore
   lifted out of the file BY NAME and evaluated against stubs, so what runs
   below is the shipped source text rather than a paraphrase of it. If a
   function is renamed this script fails loudly instead of silently testing
   nothing.

   THE HOST'S CLOCK NEVER DECIDES (§82). Until §82's pickup fix, a store with
   no timezone — and an order with no store at all — was judged on the host's
   local clock, so this file passed on a UTC+8 machine and failed eight checks
   on a UTC one: "open 10:00" meant 18:00 in Guangzhou. The zone is now the
   store's, else the tenant's (deliveryTz), else the system default, and the
   cases below pass on any host clock. Section 3 says so directly: it runs the
   same probes under a tenant zone that is not Guangzhou's, and refuses any host
   clock read in the functions it lifts. */
'use strict';

// retailSource(): routes/retail.js and the lib/ files its helpers moved to
// (decisions §477) — hhmmToMinutes is in lib/delivery-calendar.js.
const SRC = require('./test-support/retail-source').retailSource();

let pass = 0, fail = 0;
function is(got, want, label) {
  if (got === want) { pass++; console.log('  ok   ' + label + '  →  ' + JSON.stringify(got)); }
  else { fail++; console.log('  FAIL ' + label + '\n       got:  ' + JSON.stringify(got) + '\n       want: ' + JSON.stringify(want)); }
}

/* Lift a top-level `function NAME(...) {...}` out of the source by brace
   matching. Throws rather than returning empty: a rename must break this
   script, not quietly empty it. */
function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(');
  if (start < 0) throw new Error('routes/retail.js no longer defines ' + name + '()');
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error('unbalanced braces reading ' + name + '()');
}

const LIFTED = ['pickupStoreHoursForOrder', 'pickupWindowFor', 'hhmmToMinutes',
  'localPartsInTz', 'resolvePickupTime'];

/* Stubs. STORE_ROW stands in for the retail_stores row and is swapped per
   case; cfgValue answers only the two keys these functions read. */
let STORE_ROW = null;
let TENANT_TZ = null;          // what deliveryTz() answers: the tenant's zone, or null
const CFG_DEFAULT = { 'pickup.window': { open: '10:00', close: '20:00' }, 'pickup.leadMinutes': 0 };
let CFG = { ...CFG_DEFAULT };
const stubs = {
  tdb: () => ({ prepare: () => ({ get: () => STORE_ROW }) }),
  cfgValue: (key, dflt) => (key in CFG ? CFG[key] : dflt),
  deliveryTz: () => TENANT_TZ,
  businessDate: require('../lib/business-date'),
};
/* new Function rather than require: the point is to run the SHIPPED text,
   and requiring the module would boot the database. */
const build = new Function(...Object.keys(stubs),
  LIFTED.map(lift).join('\n') + '\nreturn { ' + LIFTED.join(', ') + ' };');
const R = build(...Object.values(stubs));

/* A real instant for a Guangzhou wall-clock time on 2026-08-12. `now` sits
   before every window so only the hours check can reject. */
const gzAt = (h, m) => new Date(Date.UTC(2026, 7, 12, 0, 0, 0) + (h - 8) * 3600000 + m * 60000);
const NOW = gzAt(0, 0);

const hhmm = (s) => String(s).split(':').map(Number);
function verdict(order, when) {
  const r = R.resolvePickupTime(when.toISOString(), NOW, R.pickupStoreHoursForOrder(order));
  if (r.error === 'pickup_time_outside_hours') return 'REJECT';
  return r.error ? 'ERR:' + r.error : 'ACCEPT';
}

/* Seven cases. The two unresolvable ones and the NULL-timezone one are the
   reason this file exists — they are where a careless fix diverges. */
const CASES = [
  { name: 'store_id NULL — staff-made order, no store picked',
    order: { store_id: null }, row: null, expect: '10:00' },
  { name: 'store_id set but the store row is gone',
    order: { store_id: 9 }, row: null, expect: '10:00' },
  { name: 'store carrying BOTH hours',
    order: { store_id: 1 }, row: { open_time: '11:00', close_time: '19:00', timezone: 'Asia/Shanghai' }, expect: '11:00' },
  { name: 'store carrying an OPEN time only — falls back whole',
    order: { store_id: 2 }, row: { open_time: '11:00', close_time: null, timezone: 'Asia/Shanghai' }, expect: '10:00' },
  { name: 'store carrying a CLOSE time only — falls back whole',
    order: { store_id: 3 }, row: { open_time: null, close_time: '19:00', timezone: 'Asia/Shanghai' }, expect: '10:00' },
  { name: 'store carrying NEITHER — production today',
    order: { store_id: 4 }, row: { open_time: null, close_time: null, timezone: null }, expect: '10:00' },
  { name: 'store carrying hours but a NULL timezone',
    order: { store_id: 5 }, row: { open_time: '11:00', close_time: '19:00', timezone: null }, expect: '11:00' },
];

console.log('\nThe picker publishes what the validator enforces');
for (const c of CASES) {
  STORE_ROW = c.row;
  /* Exactly the expression at the reschedule-options route. */
  const win = R.pickupWindowFor(R.pickupStoreHoursForOrder(c.order));
  console.log('\n' + c.name + '\n  advertised: ' + win.open + '–' + win.close);

  is(win.open, c.expect, 'advertises the expected window');

  const [oh, om] = hhmm(win.open), [ch, cm] = hhmm(win.close);
  is(verdict(c.order, gzAt(oh, om)), 'ACCEPT', 'the advertised OPEN is accepted');
  is(verdict(c.order, gzAt(ch, cm)), 'ACCEPT', 'the advertised CLOSE is accepted');
  is(verdict(c.order, gzAt(oh, om - 1)), 'REJECT', 'one minute before it is refused');
  is(verdict(c.order, gzAt(ch, cm + 1)), 'REJECT', 'one minute after it is refused');
}

/* The zone that decides, when the store does not name one. */
console.log('\nThe zone is the store\'s, else the tenant\'s, else the system default');
const noTzStore = { store_id: 6 };
const noTzRow = { open_time: '10:00', close_time: '20:00', timezone: null };
const atZone = (tz, ymd, h, m) => require('../lib/business-date').dateInZone(tz, ymd, h, m);
const verdictAt = (order, when) => verdict(order, when);
STORE_ROW = noTzRow;
TENANT_TZ = 'Europe/London';
is(verdictAt(noTzStore, atZone('Europe/London', '2026-08-12', 10, 0)), 'ACCEPT', 'tenant in London: 10:00 London is open');
is(verdictAt(noTzStore, atZone('Europe/London', '2026-08-12', 9, 59)), 'REJECT', 'tenant in London: 09:59 London is not');
is(verdictAt(noTzStore, atZone('Europe/London', '2026-08-12', 20, 1)), 'REJECT', 'tenant in London: 20:01 London is not');
is(verdictAt(noTzStore, gzAt(10, 0)), 'REJECT', 'tenant in London: 10:00 Guangzhou (03:00 London) is not');
STORE_ROW = { ...noTzRow, timezone: 'Asia/Shanghai' };
is(verdictAt(noTzStore, gzAt(10, 0)), 'ACCEPT', 'a store naming its own zone wins over the tenant\'s');
STORE_ROW = { ...noTzRow, timezone: 'Mars/Olympus_Mons' };
TENANT_TZ = null;
is(verdictAt(noTzStore, gzAt(10, 0)), 'ACCEPT', 'a zone the runtime cannot read falls back to the system default, not the host');
is(verdictAt(noTzStore, gzAt(9, 59)), 'REJECT', '…and is enforced there');
STORE_ROW = noTzRow;
is(R.resolvePickupTime(gzAt(10, 0).toISOString(), NOW, R.pickupStoreHoursForOrder(noTzStore)).label,
  'Pickup Today 10:00', 'the label reads the same clock: today, at 10:00');
is(R.resolvePickupTime(gzAt(34, 0).toISOString(), NOW, R.pickupStoreHoursForOrder(noTzStore)).label,
  'Pickup Thu 13/8 10:00', '…and tomorrow by its day and date');

console.log('\nNo host clock read in the lifted code');
{
  const HOST = /\.(getHours|getMinutes|getDay|getDate|getMonth|getFullYear|toDateString)\(\)/;
  for (const name of ['localPartsInTz', 'resolvePickupTime', 'pickupWindowFor']) {
    const body = lift(name).replace(/^\s*\/\/.*$/gm, '');
    const hit = HOST.exec(body);
    is(hit ? hit[0] : null, null, name + ' reads no host-local date part');
  }
}

console.log('\nThe other limits on a pickup time');
{
  STORE_ROW = null; TENANT_TZ = null;
  const now = gzAt(11, 0);
  const at = (ms) => R.resolvePickupTime(new Date(now.getTime() + ms).toISOString(), now, null).error || 'ok';
  is(at(0), 'ok', 'right now is not in the past');
  is(at(-60000), 'ok', 'a minute ago still counts (clock skew between phone and server)');
  is(at(-60001), 'pickup_time_past', 'more than a minute ago is in the past');
  is(at(30 * 86400000), 'ok', 'thirty days ahead is allowed');
  is(at(30 * 86400000 + 1), 'pickup_time_too_far', 'past thirty days is too far');
  is(R.resolvePickupTime('', now, null).error, 'pickup_time_required', 'no time given is refused');
  is(R.resolvePickupTime('soon', now, null).error, 'invalid_pickup_time', 'a time that is not a time is refused');

  CFG['pickup.leadMinutes'] = 30;
  is(at(29 * 60000), 'pickup_too_soon', 'with 30 minutes to pack: 29 minutes from now is too soon');
  is(at(30 * 60000), 'ok', '…and 30 minutes from now is fine');
  CFG['pickup.leadMinutes'] = '15';
  is(at(14 * 60000), 'pickup_too_soon', 'the packing time may be saved as text');
  for (const v of [-5, 'abc', null]) {
    CFG['pickup.leadMinutes'] = v;
    is(at(0), 'ok', 'a packing time of ' + JSON.stringify(v) + ' means none');
  }
  CFG = { ...CFG_DEFAULT };

  // A shop-wide window that is backwards, empty or unreadable applies no hours check
  // at all, rather than refusing every pickup.
  for (const w of [{ open: '20:00', close: '10:00' }, { open: '10:00', close: '10:00' }, { open: 'ten', close: '20:00' }]) {
    CFG['pickup.window'] = w;
    is(R.resolvePickupTime(gzAt(23, 0).toISOString(), NOW, null).error || 'ok', 'ok',
      'window ' + JSON.stringify(w) + ' checks no hours');
  }
  CFG = { ...CFG_DEFAULT };
  is(R.pickupStoreHoursForOrder(null), null, 'no order at all has no store hours');
}

console.log('\nA runtime with no timezone data still never reads the host');
{
  // Build the same code against an Intl that cannot read ANY zone. The last
  // fallback is the system default's fixed UTC+8, read off UTC fields.
  const NoZones = { DateTimeFormat: function () { throw new RangeError('no timezone data'); } };
  const R2 = new Function(...Object.keys(stubs), 'Intl',
    LIFTED.map(lift).join('\n') + '\nreturn { ' + LIFTED.join(', ') + ' };')(...Object.values(stubs), NoZones);
  STORE_ROW = null; TENANT_TZ = 'Europe/London';
  const v = (when) => { const r = R2.resolvePickupTime(when.toISOString(), NOW, null); return r.error || 'ACCEPT'; };
  is(v(gzAt(10, 0)), 'ACCEPT', 'Guangzhou 10:00 is open');
  is(v(gzAt(9, 59)), 'pickup_time_outside_hours', 'Guangzhou 09:59 is not');
  is(v(gzAt(20, 0)), 'ACCEPT', 'Guangzhou 20:00 is open');
  is(v(gzAt(20, 1)), 'pickup_time_outside_hours', 'Guangzhou 20:01 is not');
  is(R2.resolvePickupTime(gzAt(34, 0).toISOString(), NOW, null).label, 'Pickup Thu 13/8 10:00',
    'and its day and date are Guangzhou\'s');
  TENANT_TZ = null;
}

/* The predicate itself, stated once so a future edit to pickupWindowFor has
   something to fail against beyond the edge probes above. */
console.log('\nBoth ends are required together');
is(R.pickupWindowFor({ open: '11:00', close: '19:00' }).open, '11:00', 'both ends → the store wins');
is(R.pickupWindowFor({ open: '11:00', close: null }).open, '10:00', 'open only → global');
is(R.pickupWindowFor({ open: null, close: '19:00' }).open, '10:00', 'close only → global');
is(R.pickupWindowFor(null).open, '10:00', 'no store at all → global');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
