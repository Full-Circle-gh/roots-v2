/* Asserts that the collection reschedule PICKER and the reschedule VALIDATOR
   agree on the pickup window — in EVERY case, including the ones where the
   order has no resolvable store.

   Run:  node scripts/pickup-window-check.js

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

   WHAT THIS DOES NOT PROVE. It does not establish host-independence. The
   last case — a store carrying hours but a NULL timezone — still reads the
   host system clock inside resolvePickupTime's localPartsInTz fallback, so
   on a host that is not UTC+8 the same wall-clock minutes map to a different
   instant. The two ends still AGREE there, which is what this file is for;
   making that case host-independent belongs to the timezone cleanup, not
   here. */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'routes', 'retail.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

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
const stubs = {
  tdb: () => ({ prepare: () => ({ get: () => STORE_ROW }) }),
  cfgValue: (key, dflt) => {
    if (key === 'pickup.window') return { open: '10:00', close: '20:00' };
    if (key === 'pickup.leadMinutes') return 0;
    return dflt;
  },
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

/* The predicate itself, stated once so a future edit to pickupWindowFor has
   something to fail against beyond the edge probes above. */
console.log('\nBoth ends are required together');
is(R.pickupWindowFor({ open: '11:00', close: '19:00' }).open, '11:00', 'both ends → the store wins');
is(R.pickupWindowFor({ open: '11:00', close: null }).open, '10:00', 'open only → global');
is(R.pickupWindowFor({ open: null, close: '19:00' }).open, '10:00', 'close only → global');
is(R.pickupWindowFor(null).open, '10:00', 'no store at all → global');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
