#!/usr/bin/env node
/**
 * The customer's STANDING note reaches every order, and never the customer (§171).
 *
 *   node scripts/test_customer_standing_note.js
 *
 * §171 added no storage. `retail_customers.note` and `.tags` already existed;
 * what it added is a READ, on the join `GET /api/retail-admin/orders/:id`
 * already made for the nickname and phone. Three things can break that quietly,
 * and each is a case below:
 *
 *   1. The alias is dropped from the query — the drawer silently stops showing
 *      a note nobody notices is missing, because an absent note renders as
 *      nothing by design.
 *   2. Someone widens `loadOrderForCustomer`'s hand-written column list and
 *      takes this note with it. That one is not a blank drawer, it is the shop's
 *      private note about a person arriving on that person's phone.
 *   3. The server renames the field and the two clients keep reading the old
 *      key — §169's lesson: assert the payload's REAL key names, so a rename
 *      breaks a test rather than a card.
 *
 * The query is not retyped here. It is CUT OUT OF THE SOURCE and run, so this
 * suite cannot pass against a query the app no longer has.
 *
 * No browser, no server boot: a temp SQLite file and the four tables the
 * statement names. Fast shard.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(what, cond) {
  if (cond) { console.log('  ✓ ' + what); }
  else { console.log('  ✗ ' + what); failed++; }
}

/* ── The statement, taken from the app rather than restated ──────────────── */
const retailSrc = read('routes/retail.js');
const START = 'SELECT o.*, c.nickname, c.avatar_url, c.phone AS customer_phone,';
const from  = retailSrc.indexOf(START);
if (from < 0) {
  console.error('FATAL: the admin order-detail SELECT no longer starts the way this suite finds it.');
  console.error('If the query moved, point this suite at it — do not delete the check.');
  process.exit(1);
}
const SQL = retailSrc.slice(from, retailSrc.indexOf('`', from));

console.log('\nThe query the drawer actually runs');
check('selects the standing note under its own alias',
      /c\.note\s+AS\s+customer_standing_note/.test(SQL));
check('selects the tags under theirs',
      /c\.tags\s+AS\s+customer_standing_tags/.test(SQL));
check('still selects the order row whole (o.*), so nothing else was traded for it',
      /SELECT\s+o\.\*/.test(SQL));

/* ── Run it, against the four tables it names ────────────────────────────── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-standing-note-'));
const db  = new Database(path.join(dir, 't.db'));
db.exec(`
  CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, customer_id INTEGER,
                              store_id INTEGER, delivery_zone_id INTEGER);
  CREATE TABLE retail_customers (id INTEGER PRIMARY KEY, nickname TEXT,
                                 avatar_url TEXT, phone TEXT, note TEXT, tags TEXT);
  CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT,
                              name_en TEXT, name_cn TEXT);
  CREATE TABLE retail_delivery_zones (id INTEGER PRIMARY KEY, zone_type TEXT,
                                      day_only INTEGER, same_day_surcharge REAL);
`);
const NOTE = 'Allergic to peanuts — never add the peanut dressing.';
db.prepare("INSERT INTO retail_customers (id, nickname, phone, note, tags) VALUES (784,'RGario','17749725020',?,'allergy,wholesale')").run(NOTE);
db.prepare('INSERT INTO retail_orders (id, customer_id) VALUES (750, 784)').run();
/* The walk-in: no customer linked at all, which is most channel orders. */
db.prepare('INSERT INTO retail_orders (id, customer_id) VALUES (751, NULL)').run();
/* The same person, ordering again. The note is not copied onto either order —
   this row is what proves it: nothing was written to retail_orders and the
   second order reads the note anyway. */
db.prepare('INSERT INTO retail_orders (id, customer_id) VALUES (798, 784)').run();

const stmt = db.prepare(SQL);
const first  = stmt.get(750);
const walkIn = stmt.get(751);
const later  = stmt.get(798);

console.log('\nWhat one order gets back');
check('the standing note arrives on the order',      first.customer_standing_note === NOTE);
check('the tags arrive as stored, uninterpreted',    first.customer_standing_tags === 'allergy,wholesale');
check('the per-order note is NOT what was read',     !('customer_note' in first) || first.customer_note !== NOTE);

console.log('\nEvery order the same person places');
check('a later order reads the same note, with nothing copied onto it',
      later.customer_standing_note === NOTE);
const copied = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('retail_orders') WHERE name LIKE '%standing%'").get().n;
check('and retail_orders grew no column of its own to hold it', copied === 0);

console.log('\nAn order with nobody attached');
check('the note is null, not a crash',  walkIn.customer_standing_note === null);
check('and so are the tags',            walkIn.customer_standing_tags === null);

/* ── The wall: the customer's own read must not carry it ─────────────────── */
console.log('\nWhat the CUSTOMER is allowed to see');
const cFrom = retailSrc.indexOf('function loadOrderForCustomer');
const cSql  = retailSrc.slice(cFrom, retailSrc.indexOf('`', retailSrc.indexOf('`', cFrom) + 1));
check('loadOrderForCustomer was found where the wall is guarded', cFrom > 0);
check('it names its columns by hand (no o.*), which is what makes the wall hold',
      !/SELECT\s+o\.\*/.test(cSql) && !/SELECT\s+\*/.test(cSql));
check('it does not select the standing note',  !/standing/.test(cSql));
check('nor reach the customer table for `note`', !/\bc\.note\b/.test(cSql));

/* ── The key names both clients read (§169) ──────────────────────────────── */
console.log('\nThe two drawers read the payload’s real key names');
const deskSrc  = read('public/retail-admin/04-orders.js');
const phoneSrc = read('public/m.html');
check('the desktop drawer reads customer_standing_note', deskSrc.includes('customer_standing_note'));
check('the desktop drawer reads customer_standing_tags', deskSrc.includes('customer_standing_tags'));
check('the phone reads both too',
      phoneSrc.includes('customer_standing_note') && phoneSrc.includes('customer_standing_tags'));
check('the desktop Edit button navigates rather than opening a field (§171)',
      /custStandingNoteRow[\s\S]{0,1600}orderGotoCustomer/.test(deskSrc)
      && !/custStandingNoteRow[\s\S]{0,1600}<textarea/.test(deskSrc));

/* ── The lifted pair, locked where it was lifted from ────────────────────── */
console.log('\nOne Chinese string, on the field it is typed into and the ones it is read on');
const ZH = '关于该顾客的备注';
check('it is live on the customer drawer’s note field', read('public/retail-admin/08-customers.js').includes(ZH));
check('the order drawer uses that same string',              deskSrc.includes(ZH));
check('and so does the phone',                               phoneSrc.includes(ZH));

db.close();
fs.rmSync(dir, { recursive: true, force: true });

if (failed) { console.log(`\n✗ ${failed} check(s) failed\n`); process.exit(1); }
console.log('\nAll checks passed\n');
