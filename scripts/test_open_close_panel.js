#!/usr/bin/env node
/**
 * test_open_close_panel.js — "are we open?", asked and answered (audit B-03).
 *
 *   node scripts/test_open_close_panel.js
 *
 * THE FINDING. Four endpoints were implemented for opening and closing the shop
 * — the whole business at once, the online store on its own, and one shop at a
 * time — and NOTHING called any of them. No page, no drawer, no phone screen.
 * The merchant closed the shop somewhere else, or not at all from here.
 *
 * So this suite checks two separate things, and both of them are the finding:
 *
 *   §1  the screen exists, is reached, and calls all four endpoints
 *   §2  what that screen is told is TRUE
 *
 * §2 is not padding. Wiring the panel up made an existing wrong answer visible:
 * `master` was computed from every shop's marketplace `is_open`, and a shop with
 * no marketplace has no status row at all, so `is_open` reads false — for a
 * merchant with no marketplace integration, the panel would have announced
 * "Everything is closed" over a shop that was trading normally. An unlinked shop
 * is not a closed shop, and the two now say different things.
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

const OPS  = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '02-settings-ops.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

// ── §1 · the screen exists and is reached ─────────────────────────────────
section('1 · the screen the endpoints never had');

yes(HTML.includes('id="oc-body"') && HTML.includes('id="oc-master-pill"'),
  'the Operations page has somewhere to put it');
yes(/function loadOpenClose\(/.test(OPS), 'and something to fill it');

{
  // The panel is USELESS if nothing loads it — which was the whole finding, and
  // is exactly the mistake that would be easiest to make again.
  const panel = OPS.slice(OPS.indexOf('function loadOpsPanel('), OPS.indexOf('function loadOpsPanel(') + 400);
  yes(/loadOpenClose\(\)/.test(panel), 'opening Settings → Operations loads it');
  // A shop added on this page is a row in the panel above it.
  yes(OPS.split('loadOpenClose()').length - 1 >= 3,
    'and adding a shop refreshes it', 'loadOpenClose() is called in fewer than 3 places');
}

for (const [p, what] of [
  ['/api/retail-admin/store-status\'', 'reads the status'],
  ['/api/retail-admin/store-status/master', 'closes everything'],
  ['/api/retail-admin/store-status/online', 'closes the online store'],
  ['/api/retail-admin/store-status/store/', 'closes one shop'],
]) yes(OPS.includes(p), `something now ${what}`);

for (const g of ['window.ocMaster', 'window.ocSetOnline', 'window.ocSetStore'])
  yes(OPS.includes(g), `${g} is reachable from the markup it is written into`);

yes(/_ocBusy/.test(OPS), 'a write in flight disables the panel',
  'two taps on "close everything" must not race');

// Closing is urgent and reversible in one tap; a confirm dialog between a
// merchant and "stop taking orders" is a dialog in the way. This is a
// DELIBERATE absence, recorded so nobody adds one back as a "safety" fix.
yes(!/askConfirm/.test(OPS.slice(OPS.indexOf('async function _ocWrite('), OPS.indexOf('let _opsStores'))),
  'and neither closing nor opening is confirmed — both are one tap back');

// ── §2 · what the screen is told ──────────────────────────────────────────
let Database;
try { Database = require('better-sqlite3'); }
catch (e) {
  console.log('\n  ! better-sqlite3 is not built here — skipping the API half');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

function stub(rel, value) {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports: value };
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, name_en TEXT, name_cn TEXT,
                              is_active INT DEFAULT 1, sort_order INT DEFAULT 0);
  CREATE TABLE store_business_status (
    store_code TEXT PRIMARY KEY, is_open INTEGER, mt_status INTEGER, sub_status INTEGER,
    status_desc TEXT, detail_desc TEXT, hours_desc TEXT, read_ok INTEGER DEFAULT 0,
    read_at DATETIME, target_open INTEGER, target_by TEXT, target_at DATETIME,
    last_result TEXT, fulfillment_open INTEGER DEFAULT 1, updated_at DATETIME);
  CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT, updated_at DATETIME, updated_by TEXT);
  CREATE TABLE meituan_sync_queue (id INTEGER PRIMARY KEY, retail_store_id INT, product_id INT,
                                   store_code TEXT, new_qty INT, status TEXT);
  CREATE TABLE meituan_sync_log (id INTEGER PRIMARY KEY, store_code TEXT, event_type TEXT,
                                 status TEXT, detail TEXT, error_msg TEXT);
  CREATE TABLE meituan_product_map (product_id INT, retail_store_id INT, store_code TEXT,
                                    sync_enabled INT, meituan_name TEXT);
`);

stub('../lib/tenant-db', { tdb: () => db, rawTenantDb: () => db, ROOTS_TENANT_ID: 1 });
stub('../database', db);
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../lib/meituan-bundles', {});
stub('../lib/bundle-stock', { sellableAt: () => 0 });
stub('../lib/meituan-map-write', {});
stub('../middleware/auth', { logActivity: () => {} });
// lib/store-close is NOT stubbed: closing a shop and clearing its queued pushes
// is one operation, and a test that stubbed it would be testing the stub.

const express = require('express');
const app = express();
app.use((req, res, next) => { req.backendUser = { username: 'mei' }; next(); });
app.use(require(path.join(ROOT, 'routes', 'meituan-admin')));

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
const reset = (rows) => {
  db.exec('DELETE FROM retail_stores; DELETE FROM store_business_status; DELETE FROM storefront_config; DELETE FROM meituan_sync_queue;');
  for (const [i, r] of (rows || []).entries()) {
    db.prepare('INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (?,?,?,?,1,?)')
      .run(i + 1, r.code, r.name || r.code, null, i);
    if (r.status) {
      db.prepare(`INSERT INTO store_business_status (store_code, is_open, read_ok, fulfillment_open)
                  VALUES (?,?,?,?)`).run(r.code, r.status.isOpen ? 1 : 0, r.status.readOk === false ? 0 : 1,
        r.status.fulfilling === false ? 0 : 1);
    }
  }
};
const status = () => call('GET', '/api/retail-admin/store-status').then((r) => r.body);

(async () => {
  section('2 · a shop with no marketplace is not a closed shop');
  {
    // THE REGRESSION THIS PANEL WOULD HAVE MADE VISIBLE. No status row means
    // nobody has ever pushed this shop to a marketplace — it does not mean
    // somebody closed it. Reading is_open off a missing row told a merchant
    // their whole business was shut while it was trading.
    reset([{ code: 'S1', name: 'High Street' }]);
    const st = await status();
    is(st.master, 'open', 'a trading shop with no marketplace reads as open');
    is(st.meituan[0].linked, false, 'and says plainly that it is not linked');
  }
  {
    // A linked shop that really is closed still reads closed — the fix above
    // must not make everything read open. The online store has to go too before
    // the pill says "everything", which is the honest reading of "everything".
    reset([{ code: 'S1', status: { isOpen: false } }]);
    is((await status()).master, 'mixed', 'a closed shop with the online store still open is mixed');
    await call('POST', '/api/retail-admin/store-status/online', { open: false });
    is((await status()).master, 'closed', 'and with both shut, closed');
  }
  {
    reset([{ code: 'S1', status: { isOpen: true } }, { code: 'S2', status: { isOpen: false } }]);
    is((await status()).master, 'mixed', 'one of two closed is mixed, not closed');
  }
  {
    // Fulfilment is the immediate half and is true of every shop, linked or not.
    reset([{ code: 'S1', status: { isOpen: true, fulfilling: false } }]);
    is((await status()).master, 'mixed', 'a shop that has stopped fulfilling is not open');
  }

  section('3 · the online store closes on its own');
  {
    reset([{ code: 'S1', status: { isOpen: true } }]);
    const r = await call('POST', '/api/retail-admin/store-status/online', { open: false });
    is(r.body.success, true, 'the online store can be closed by itself');
    const st = await status();
    is(st.online.online_open, false, 'and it stays closed when the panel reloads');
    is(st.master, 'mixed', 'with the shop still open, that is mixed');
    is(st.meituan[0].isOpen, true, 'closing the online store touched no shop');
  }
  {
    // A closed-message already on file must survive a close that did not mention
    // one — otherwise reopening and reclosing quietly erases what the shop says.
    db.prepare("INSERT OR REPLACE INTO storefront_config (key, value_json) VALUES ('store_status', ?)")
      .run(JSON.stringify({ online_open: true, message_en: 'Back Monday', message_cn: '周一见' }));
    await call('POST', '/api/retail-admin/store-status/online', { open: false });
    is((await status()).online.message_en, 'Back Monday', 'the closed message survives the close');
  }

  section('4 · closing everything means everything');
  {
    reset([{ code: 'S1', status: { isOpen: true } }, { code: 'S2', status: { isOpen: true } }]);
    db.prepare("INSERT INTO meituan_sync_queue (store_code, new_qty, status) VALUES ('S1', 5, 'pending')").run();
    const r = await call('POST', '/api/retail-admin/store-status/master', { open: false });
    is(r.body.target, 'closed', 'the master switch answers what it did');
    is(r.body.meituanQueued, ['S1', 'S2'], 'every shop is queued, not just the first');
    const st = await status();
    is(st.online.online_open, false, 'the online store went with it');
    is(st.meituan.map((m) => m.pending), [true, true], 'and every shop has a change queued');
    is(st.meituan.map((m) => m.fulfillmentOpen), [false, false], 'each one stopped fulfilling at once');
    is(db.prepare('SELECT COUNT(*) n FROM meituan_sync_queue').get().n, 0,
      'the queued pushes for a closed shop are cleared, not left to publish later');
  }

  section('5 · one shop at a time');
  {
    reset([{ code: 'S1', status: { isOpen: true } }, { code: 'S2', status: { isOpen: true } }]);
    const r = await call('POST', '/api/retail-admin/store-status/store/S2', { open: false });
    is(r.body.storeCode, 'S2', 'the shop asked for is the shop changed');
    const st = await status();
    is(st.meituan.map((m) => m.pending), [false, true], 'and only that shop has a change queued');
    is(st.meituan.map((m) => m.fulfillmentOpen), [true, false], 'only that shop stopped fulfilling');
    is(st.master, 'mixed', 'the pill says some of it is closed');
  }
  {
    const r = await call('POST', '/api/retail-admin/store-status/store/NOPE', { open: false });
    is(r.status, 404, 'a shop that does not exist is a 404, not a silent success');
  }

  section('6 · a write that does not say what it wants is refused');
  {
    for (const [name, url] of [['online', '/api/retail-admin/store-status/online'],
                               ['master', '/api/retail-admin/store-status/master'],
                               ['one shop', '/api/retail-admin/store-status/store/S1']]) {
      const r = await call('POST', url, { open: 'false' });   // the STRING 'false'
      is(r.status, 400, `${name}: "false" as a string is refused, not read as closing`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
