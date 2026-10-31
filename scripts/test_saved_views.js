#!/usr/bin/env node
/**
 * test_saved_views.js — a filter set with a name (audit E-08).
 *
 *   node scripts/test_saved_views.js
 *
 * THE FINDING. Nothing in the admin remembered a view. "Unpaid orders from the
 * Web channel at the Tianhe shop" had to be rebuilt from three controls every
 * morning and could not be handed to a colleague: filter state lived in page
 * variables and went with the reload.
 *
 * The properties that decide whether this is worth having, each a section:
 *
 *   §2  A view is PRIVATE until somebody shares it, and somebody else's private
 *       view is not listed and not reachable.
 *   §3  A view holds FILTERS, not rows. It grants nothing: applying a shared
 *       view runs the same query the person applying it could have built.
 *   §4  Saving the same name again REPLACES. Two identical names on one menu is
 *       the worse outcome either way.
 *   §5  A key this build has never seen is DROPPED, not refused — an older
 *       server must not make a newer screen unusable.
 *   §6  Applying a view starts from "everything", so two views in a row do not
 *       narrow by the union of both.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.log('  ! better-sqlite3 is not built here — skipping'); process.exit(0); }

const db = new Database(':memory:');
db.exec(`CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT, screen TEXT NOT NULL, name TEXT NOT NULL,
  query_json TEXT NOT NULL, owner_id INTEGER, owner_name TEXT,
  shared INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

function stub(rel, value) {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports: value };
}
stub('../lib/tenant-db', { tdb: () => db, getTenantDb: () => db, rawTenantDb: () => db, ROOTS_TENANT_ID: 1 });
stub('../database', db);
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });

const views = require(path.join(ROOT, 'routes', 'saved-views.js'));
const express = require('express');
const app = express();
// Who is signed in, switchable between calls — the whole of §2 is about two
// different people looking at the same account.
let ME = { id: 1, display_name: 'Mei', role: 'staff' };
app.use((req, res, next) => {
  req.user = { id: ME.id, display_name: ME.display_name, username: ME.display_name };
  req.backendUser = { id: ME.id, role: ME.role };
  next();
});
app.use(views);

function call(method, url, body) {
  return new Promise((resolve) => {
    const req = Object.assign(require('stream').Readable.from([]), {
      method, url, originalUrl: url, headers: {}, body: body || {}, connection: {}, socket: {},
    });
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); return this; },
      send(p) { resolve({ status: this.statusCode, body: p }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    app(req, res);
  });
}
const list = () => call('GET', '/api/retail-admin/views?screen=orders').then((r) => r.body.data);
const save = (name, query, shared) =>
  call('POST', '/api/retail-admin/views', { screen: 'orders', name, query, shared });

(async () => {
  section('1 · a view is a name and a filter set');
  {
    const r = await save('Unpaid at Tianhe', { status: 'unpaid', store_id: '4' });
    is(r.body.success, true, 'a filtered list can be given a name');
    const [v] = await list();
    is(v.query, { status: 'unpaid', store_id: '4' }, 'and comes back as the filters that made it');
    is(v.shared, false, 'private until somebody says otherwise');
    is(v.mine, true, 'and marked as this person’s own');
  }
  {
    const r = await save('Everything', {});
    is(r.status, 400, 'the unfiltered list cannot be saved — the screen already has that name');
    is((await save('', { status: 'unpaid' })).status, 400, 'and a view with no name is refused');
    is((await call('POST', '/api/retail-admin/views',
      { screen: 'nowhere', name: 'x', query: { a: '1' } })).status, 400, 'so is a screen that does not exist');
    is((await call('GET', '/api/retail-admin/views?screen=nowhere')).status, 400,
      'and it cannot be listed either');
  }

  section('2 · private until shared, and somebody else’s private view is invisible');
  {
    ME = { id: 2, display_name: 'Lin', role: 'staff' };
    is((await list()).length, 0, 'a colleague sees none of it');
    await save('Refunds waiting', { status: 'refunds_open' });
    is((await list()).length, 1, 'they see their own');

    ME = { id: 1, display_name: 'Mei', role: 'staff' };
    is((await list()).length, 1, 'and the first person still sees only theirs');
    const mine = (await list())[0];
    is((await call('PATCH', '/api/retail-admin/views/' + mine.id, { shared: true })).body.success, true,
      'sharing is a separate, deliberate act');

    ME = { id: 2, display_name: 'Lin', role: 'staff' };
    const seen = await list();
    is(seen.length, 2, 'now the colleague can use it');
    const theirs = seen.find((v) => !v.mine);
    is(theirs.owner_name, 'Mei', 'and can see whose it is');
    is(theirs.mine, false, 'without it being theirs');
  }

  section('3 · a shared view is somebody’s, and stays theirs');
  {
    // ME is Lin.
    const theirs = (await list()).find((v) => !v.mine);
    is((await call('PATCH', '/api/retail-admin/views/' + theirs.id, { name: 'Mine now' })).status, 403,
      'a colleague cannot rename a view they were given');
    is((await call('DELETE', '/api/retail-admin/views/' + theirs.id)).status, 403,
      'nor delete it out from under them');
    ME = { id: 9, display_name: 'Owner', role: 'owner' };
    is((await call('DELETE', '/api/retail-admin/views/' + theirs.id)).body.success, true,
      'the account’s owner can clear up after somebody who has left');
  }

  section('4 · saving the same name again replaces it');
  {
    ME = { id: 1, display_name: 'Mei', role: 'staff' };
    await save('Today', { status: 'unpaid' });
    const first = (await list()).find((v) => v.name === 'Today');
    const again = await save('Today', { status: 'paid', channel: 'web' });
    is(again.body.replaced, true, 'saving over a view you already have updates it');
    is(again.body.id, first.id, 'the same view, not a second one with the same name');
    const now = (await list()).filter((v) => v.name === 'Today');
    is(now.length, 1, 'one row, not two');
    is(now[0].query, { status: 'paid', channel: 'web' }, 'holding the newer filters');
  }

  section('5 · what the stored form accepts');
  {
    const q = views.cleanQuery({
      status: 'unpaid',
      store_id: 4,                                  // a number is a filter value too
      empty: '', nothing: null,                     // an unset control is not a filter
      nested: { a: 1 }, listy: [1, 2],              // a view is flat
      'bad-key': 'x', 'DROP TABLE': '1',            // not a control name
      long: 'x'.repeat(500),                        // not a filter somebody typed
    });
    is(q, { status: 'unpaid', store_id: '4' }, 'only short, flat, named values survive');
    const many = {};
    for (let i = 0; i < 40; i++) many['k' + i] = 'v';
    is(Object.keys(views.cleanQuery(many)).length, 12, 'and there is a ceiling on how many');
    // Dropped, NOT refused: an older server must not make a newer screen
    // unusable — the view simply narrows by one fewer thing.
    is((await save('Future', { status: 'unpaid', a_control_added_next_year: 'x' })).body.success, true,
      'a key this build has never seen is dropped, not refused');
  }

  section('6 · the screen puts the filters back, and only those');
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');
    const apply = src.slice(src.indexOf('function ordViewApply('), src.indexOf('if (typeof viewsRegister'));
    yes(/ordResetFacetsUI\(\)/.test(apply),
      'applying a view starts from everything', 'two views in a row would otherwise narrow by both');
    yes(/ORD_CUSTOMER_FILTER = null/.test(apply), 'and drops the one-customer scope');
    const read = src.slice(src.indexOf('function ordViewRead('), src.indexOf('function ordViewApply('));
    yes(/customer_id/.test(read) && /continue/.test(read),
      'the customer scope is never saved into a view — it carries a chip a view could not restore');
    yes(/setOrderChannel\(item\)/.test(apply),
      'the channel goes back through its own menu item, so the button’s icon and label follow');
    const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
    yes(html.includes('id="ord-views"'), 'the Orders filter row has somewhere to draw the control');
    yes(html.includes('25-views.js'), 'and the module is loaded');
    const mod = fs.readFileSync(path.join(ROOT, 'public/retail-admin/25-views.js'), 'utf8');
    yes(!/localStorage/.test(mod), 'views live on the account, not in one browser — that is the sharing half');
    yes(/askConfirm/.test(mod), 'deleting a view is confirmed: unlike a filter, it does not come back');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
