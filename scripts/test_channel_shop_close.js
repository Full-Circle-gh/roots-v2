#!/usr/bin/env node
/**
 * test_channel_shop_close.js — the till that appeared to close itself.
 *
 *   node scripts/test_channel_shop_close.js
 *
 * THE FINDING. There are two switches over one shop and only one of them was
 * ever visible. `channel_status` holds channel × shop; `fulfillment_open` holds
 * "this shop is not trading at all", and csCellOpen reports EVERY channel at
 * such a shop as closed whatever its own row says.
 *
 * So opening the counter till at a shut shop did this: the write succeeded, the
 * row landed in channel_status, the phone patched its own copy to Open, and the
 * very next read masked it back to Closed. Nothing on any screen named the shop
 * switch, and no screen but the desktop could touch it. The operator's reading —
 * "I open it and it closes automatically" — was the only reading available.
 *
 * Three things are checked, and the loop is the point of all three:
 *
 *   §1  the shop-wide state is REPORTED, not only folded into every cell
 *   §2  an open that cannot land is REFUSED, by name, instead of stored
 *   §3  the phone can work the shop switch, and re-reads instead of guessing
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

// ── §3 · the phone screen (no database needed) ────────────────────────────
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

section('3 · the phone can reach the switch that applies');

yes(/reg\('shopOpen'/.test(M), 'the Sales screen has a shop switch at all');
yes(M.includes("apiWrite('/channel-status/location'"),
  'and it writes the location master, the same endpoint the desktop Sales page uses');
yes(/state\.shopBusy/.test(M), 'a shop write in flight disables the rows',
  'two taps on Close while the first is in flight reopens a shop nobody reopened');

{
  // THE REGRESSION. Patching the local cell is what made a refused write look
  // like a successful one. The handler must re-read.
  const h = M.slice(M.indexOf("reg('chanCell'"), M.indexOf("reg('chanShopShut'"))
    .replace(/\/\/[^\n]*/g, '');   // the prose about the old assignment is not the assignment
  yes(h.includes('loadChannels(true)'), 'opening a channel re-reads the board afterwards');
  yes(!/cell\.open\s*=\s*open/.test(h), 'and never patches the row to agree with the tap',
    'cell.open=open is the assignment that hid the masked write');
  yes(h.includes('shop_closed'), 'a refusal from the server is said in words, not as "try again"');
}

yes(/loadChannels\(force\)/.test(M) && /state\.chanTried&&!force/.test(M),
  'loadChannels can be forced, so a write is followed by a fresh read');
yes(/reg\('reloadChannels'/.test(M) && /state\.chanLoadErr/.test(M),
  'a failed read offers Try again instead of spinning forever',
  'state.chan stayed null with chanTried already true — the screen never recovered');
yes(M.includes("T('Shop closed','门店已关闭')"), 'a row under a shut shop says so rather than a bare Closed');
yes(M.includes("T('change queued','变更排队中')"),
  'and a queued Meituan change is shown, as the desktop has always shown it');
yes(!M.includes("T('Opening and closing a channel is on desktop'"),
  'the footer no longer denies the control directly above it',
  'the sheet opens and closes a channel per shop; the footer said it could not');

// ── §1 and §2 · the server ────────────────────────────────────────────────
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
    store_code TEXT PRIMARY KEY, is_open INTEGER, status_desc TEXT, read_ok INTEGER DEFAULT 0,
    read_at DATETIME, target_open INTEGER, target_by TEXT, target_at DATETIME,
    fulfillment_open INTEGER DEFAULT 1, updated_at DATETIME);
  CREATE TABLE channel_status (channel TEXT NOT NULL, store_code TEXT NOT NULL,
    is_open INTEGER DEFAULT 1, updated_at DATETIME, updated_by TEXT,
    PRIMARY KEY (channel, store_code));
  CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT, updated_at DATETIME, updated_by TEXT);
  CREATE TABLE meituan_sync_queue (id INTEGER PRIMARY KEY, retail_store_id INT, product_id INT,
                                   store_code TEXT, new_qty INT, status TEXT);
  CREATE TABLE meituan_sync_log (id INTEGER PRIMARY KEY, store_code TEXT, event_type TEXT,
                                 status TEXT, detail TEXT, error_msg TEXT);
  CREATE TABLE meituan_product_map (product_id INT, retail_store_id INT, store_code TEXT,
                                    sync_enabled INT, meituan_name TEXT);
`);
db.prepare('INSERT INTO retail_stores (id, code, name_en, name_cn, sort_order) VALUES (1,?,?,?,0)')
  .run('tianhe', 'Tianhe', '天河');
db.prepare('INSERT INTO retail_stores (id, code, name_en, name_cn, sort_order) VALUES (2,?,?,?,1)')
  .run('yuexiu', 'Yuexiu', '越秀');

stub('../lib/tenant-db', { tdb: () => db, rawTenantDb: () => db, ROOTS_TENANT_ID: 1 });
stub('../database', db);
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../lib/meituan-bundles', {});
stub('../lib/bundle-stock', { sellableAt: () => 0 });
stub('../lib/channel-publish', { publishableAt: () => 0 });
stub('../lib/meituan-map-write', {});
stub('../middleware/auth', { logActivity: () => {} });

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
const grid = () => call('GET', '/api/retail-admin/channel-status').then((r) => r.body);
const cellOf = (g, ch, code) => g.channels.find((c) => c.channel === ch).cells.find((c) => c.storeCode === code);
// One mapped product at Yuexiu, so a reopen has something to queue. Nothing in
// §1/§2 depends on it; §4 does.
db.prepare('INSERT INTO meituan_product_map (product_id, retail_store_id, store_code, sync_enabled, meituan_name) VALUES (7,2,?,1,?)')
  .run('yuexiu', '越秀测试品');

const shutShop = (code) => db.prepare(
  `INSERT INTO store_business_status (store_code, fulfillment_open) VALUES (?, 0)
   ON CONFLICT(store_code) DO UPDATE SET fulfillment_open = 0`).run(code);

(async () => {
  section('1 · the shop-wide state is reported, not only folded in');
  {
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, true, 'a shop nobody has touched trades on the counter till');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, true, 'and reports its shop as open');
  }
  {
    shutShop('yuexiu');
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, false, 'a shut shop closes the counter till');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, false,
      'and the cell says WHY — without this the phone cannot tell the two closures apart');
    is(cellOf(g, 'web', 'yuexiu').shopOpen, false, 'every channel at that shop carries the same reason');
    is(cellOf(g, 'pos', 'tianhe').shopOpen, true, 'the other shop is untouched');
    is(g.locations.find((l) => l.storeCode === 'yuexiu').shopOpen, false, 'the locations list carries it too');
  }

  section('2 · an open that cannot land is refused, not stored');
  {
    // THE LOOP, end to end. Before this, the POST returned 200, the row went
    // into channel_status, and the next GET reported it closed anyway.
    const r = await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: true });
    is(r.status, 409, 'opening the till at a shut shop is refused');
    is(r.body.error, 'shop_closed', 'by name, so the screen can say which switch is in the way');
    const stored = db.prepare("SELECT is_open FROM channel_status WHERE channel='pos' AND store_code='yuexiu'").get();
    yes(!stored, 'and nothing is written that the next read would hide',
      'a stored row the grid masks is exactly the state that reads as a till closing itself');
  }
  {
    // Closing must still work at a shut shop — refusing it would strand an
    // operator who wants the cell off for when the shop comes back.
    const r = await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: false });
    is(r.status, 200, 'closing a channel at a shut shop is still allowed');
  }
  {
    // The switch that DOES apply, and the loop closing honestly this time.
    const r = await call('POST', '/api/retail-admin/channel-status/location',
      { storeCode: 'yuexiu', open: true });
    is(r.status, 200, 'the location master opens the shop');
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, true, 'and the counter till comes back open');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, true, 'with the shop reported open');
    is(db.prepare("SELECT fulfillment_open AS f FROM store_business_status WHERE store_code='yuexiu'").get().f, 1,
      'because the shop-wide flag is what it wrote');
  }
  {
    // A per-channel close at an OPEN shop is still just that: the cell, not the
    // shop. The guard must not have widened into "everything is a shop switch".
    await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: false });
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, false, 'closing the till closes the till');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, true, 'and leaves the shop trading');
    is(cellOf(g, 'web', 'yuexiu').open, true, 'and the other channels at that shop alone');
  }
  {
    const r = await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: true });
    is(r.status, 200, 'and it reopens without complaint once the shop is trading');
    is(cellOf(await grid(), 'pos', 'yuexiu').open, true, 'the read agreeing with the write, which is the whole finding');
  }

  section('4 · reopening a Meituan shop actually queues the refill');
  {
    // FOUND BY THIS SUITE'S OWN LOG LINE. refillQueueForCell's SELECT carried
    // three `//` comment lines INSIDE the SQL template literal. SQLite comments
    // are `--`, so prepare() threw every time and setChannelOpen's best-effort
    // catch logged "queue step failed" and moved on. Every Meituan reopen ever
    // made queued nothing; the function had never run to completion once.
    db.prepare("DELETE FROM meituan_sync_queue").run();
    shutShop('yuexiu');
    await call('POST', '/api/retail-admin/channel-status/location', { storeCode: 'yuexiu', open: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM meituan_sync_queue WHERE store_code='yuexiu'").get().n;
    is(n, 1, 'the mapped product is queued for push',
      'a silent 0 here is the swallowed prepare() throw, not an empty catalogue');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
