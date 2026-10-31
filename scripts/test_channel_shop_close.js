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
 * Checked, and the loop is the point of all of them:
 *
 *   §1  the shop-wide state is REPORTED, not only folded into every cell
 *   §2  opening one channel at a shut shop opens the shop with ONLY that
 *       channel (§253 — this used to be refused with 409 shop_closed, §181)
 *   §3  the phone can work the shop switch, and re-reads instead of guessing
 *   §5  closing a location remembers its live channels and reopening brings
 *       exactly those back; the everywhere switch never reopens a shut shop
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
  const h = M.slice(M.indexOf("reg('chanCell'"), M.indexOf("reg('shopOpen'"))
    .replace(/\/\/[^\n]*/g, '');   // the prose about the old assignment is not the assignment
  yes(h.includes('loadChannels(true)'), 'opening a channel re-reads the board afterwards');
  yes(!/cell\.open\s*=\s*open/.test(h), 'and never patches the row to agree with the tap',
    'cell.open=open is the assignment that hid the masked write');
}

// §253 on the phone. A row under a shut shop used to open an explainer that
// pointed at the shop switch, because the server refused the write. The server
// now opens the shop with only that channel, so the row sends the same write
// as any other row.
yes(!M.includes("reg('chanShopShut'") && !M.includes("'chanShopShut'"),
  'a row under a shut shop no longer routes to the "open the shop first" explainer');
yes(M.includes("onclick=\"APP.cmd('chanCell','${escAttr(key)}'"),
  'every row, shut shop or not, sends the one channel write');
{
  const s = M.slice(M.indexOf("reg('shopOpen'"), M.indexOf("reg('reloadChannels'"));
  yes(s.includes('loc.reopenChannels'), 'the shop switch reads what a reopen will bring back');
  yes(s.includes("T('Open '+backNames+' at '+store+'?', '在 '+store+' 开启 '+backNames+'？')"),
    'and names those channels in the confirm, in the words used for opening one channel');
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
try { Database = require('@libsql/client'); }
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
    fulfillment_open INTEGER DEFAULT 1, reopen_channels TEXT, updated_at DATETIME);
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

  section('2 · one channel at a shut shop opens the shop with only that channel (§253)');
  {
    // §181 refused this with 409 shop_closed, because the write landed under
    // fulfillment_open = 0 and the next read masked it back to Closed. §253
    // lifts the mask in the same write, so the read agrees with the tap.
    const r = await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: true });
    is(r.status, 200, 'opening the till at a shut shop is accepted');
    is(r.body.shopOpened, true, 'and says it opened the shop');
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, true, 'the counter till reads open');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, true, 'the shop reads open');
    is(['web', 'mini_app', 'eleme'].map((ch) => cellOf(g, ch, 'yuexiu').open), [false, false, false],
      'and every other channel at that shop stays shut',
      'a cell stored before the close must not come back with it');
    is(db.prepare("SELECT target_open AS t FROM store_business_status WHERE store_code='yuexiu'").get().t, 0,
      'Meituan is commanded shut, not left as it was');
    is(cellOf(g, 'web', 'tianhe').open, true, 'the other shop is untouched');
  }
  {
    // A per-channel close at an OPEN shop is still just that: the cell, not the
    // shop. The rule must not have widened into "everything is a shop switch".
    await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: false });
    const g = await grid();
    is(cellOf(g, 'pos', 'yuexiu').open, false, 'closing the till closes the till');
    is(cellOf(g, 'pos', 'yuexiu').shopOpen, true, 'and leaves the shop trading');
  }
  {
    const r = await call('POST', '/api/retail-admin/channel-status/cell',
      { channel: 'pos', storeCode: 'yuexiu', open: true });
    is(r.status, 200, 'it reopens at a trading shop');
    is(r.body.shopOpened, false, 'as a plain cell write, not a shop reopen');
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


  section('5 · closing remembers, reopening restores, the everywhere switch leaves a shut shop shut (§253)');
  {
    // Yuexiu trading on WeChat only.
    for (const ch of ['web', 'pos', 'eleme', 'meituan']) {
      await call('POST', '/api/retail-admin/channel-status/cell', { channel: ch, storeCode: 'yuexiu', open: false });
    }
    await call('POST', '/api/retail-admin/channel-status/cell', { channel: 'mini_app', storeCode: 'yuexiu', open: true });
    const r = await call('POST', '/api/retail-admin/channel-status/location', { storeCode: 'yuexiu', open: false });
    is(r.status, 200, 'the location master closes the shop');
    const row = db.prepare("SELECT fulfillment_open AS f, reopen_channels AS m FROM store_business_status WHERE store_code='yuexiu'").get();
    is(row.f, 0, 'the shop-wide flag is off');
    is(JSON.parse(row.m), ['mini_app'], 'and the one live channel is remembered');
    is((await grid()).locations.find((l) => l.storeCode === 'yuexiu').reopenChannels, ['mini_app'],
      'the grid reports what a reopen will bring back');
  }
  {
    await call('POST', '/api/retail-admin/channel-status/location', { storeCode: 'yuexiu', open: false });
    is(JSON.parse(db.prepare("SELECT reopen_channels AS m FROM store_business_status WHERE store_code='yuexiu'").get().m),
      ['mini_app'], 'a second close keeps the memory instead of overwriting it with nothing');
  }
  {
    // The everywhere switch, with Yuexiu shut.
    const r = await call('POST', '/api/retail-admin/channel-status/channel', { channel: 'web', open: true });
    is(r.body.skipped, ['yuexiu'], 'opening a channel everywhere skips the shut shop, by name');
    is(r.body.stores, ['tianhe'], 'and opens it where the shop trades');
    const g = await grid();
    is(cellOf(g, 'web', 'yuexiu').shopOpen, false, 'the shut shop stays shut');
    is(cellOf(g, 'web', 'tianhe').open, true, 'the trading shop has the channel');
  }
  {
    const r = await call('POST', '/api/retail-admin/channel-status/location', { storeCode: 'yuexiu', open: true });
    is(r.body.opened, ['mini_app'], 'the master reopens exactly what was live');
    const g = await grid();
    is(cellOf(g, 'mini_app', 'yuexiu').open, true, 'WeChat is back');
    is(['web', 'pos', 'eleme'].map((ch) => cellOf(g, ch, 'yuexiu').open), [false, false, false],
      'and nothing that was shut on purpose came back with it');
    is(db.prepare("SELECT reopen_channels AS m FROM store_business_status WHERE store_code='yuexiu'").get().m, null,
      'the memory is spent once used');
  }
  {
    // A shop closed some other way has nothing remembered: every channel opens.
    shutShop('yuexiu');
    const r = await call('POST', '/api/retail-admin/channel-status/location', { storeCode: 'yuexiu', open: true });
    is(r.body.opened, ['mini_app', 'web', 'meituan', 'eleme', 'pos'], 'with nothing remembered, every channel opens');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
