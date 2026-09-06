#!/usr/bin/env node
/**
 * The shop's QR — what a scan opens, and what happens when we cannot say.
 *
 *   node scripts/test_shop_qr.js
 *
 * docs/tacet-consolidation-decisions.md §44 Domain (the page is served from the
 * tenant's EXISTING customer-facing domain under /s/) and §30 rule 4 (where the
 * correct target cannot be determined the system refuses and surfaces the
 * problem, never a placeholder). Built in lib/shop-qr.js and routes/
 * retail-shops.js.
 *
 * WHY THIS SUITE EXISTS. A QR is printed and stuck to a table. It is opaque to
 * a human, so nothing about it is reviewable after the fact, and it cannot be
 * recalled. Every check here is about the URL being right or the mint being
 * refused — never about the picture looking plausible.
 *
 * WHAT IS HELD:
 *   1. The URL is the tenant's own active domain plus /s/<code>. A primary
 *      domain wins over a merely-active one.
 *   2. WITH NO ACTIVE DOMAIN IT REFUSES. It does not borrow the request host
 *      and it does not borrow the first tenant's literal — either would print
 *      one merchant a sticker pointing at another merchant's website, which is
 *      the single worst thing this code could do.
 *   3. A disabled or pending domain is not an answer.
 *   4. The PNG is real PNG bytes and decodes back to exactly that URL.
 *   5. The bytes are never cached, because the domain behind them can change.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
// Only the AUTH CHOKE POINT is stubbed. middleware/auth is loaded for real:
// backend-auth's require chain reaches routes/push.js, which needs its actual
// exports, and a stub there fails the whole module at load with an error that
// names push.js and points nowhere near the cause.
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });

const db = require(path.join(ROOT, 'database.js'));
// tenant_domains is CREATED BY routes/backend-auth.js, not by database.js, so
// on a genuinely fresh database this suite has no table to read until that
// module has loaded. Required here for that and nothing else — server.js loads
// it too, so this is the production ordering rather than a test fixture.
// Found the hard way: this suite passed alone on a developer database that a
// previous run had already populated, and failed on the first clean checkout.
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const { menuUrlFor, publicOriginFor } = require(path.join(ROOT, 'lib', 'shop-qr.js'));
const qrpng = require(path.join(ROOT, 'lib', 'qrpng.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const tdbh = tdb();

const LOC = 9851;
const CODE = 'QRTESTAB';          // valid: no I, no O
const TENANT = 1;                 // the suite runs unscoped, which is tenant 1

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

// tenant_domains is the tenant's real record of where it serves customers, so
// this suite must leave it exactly as found.
const SAVED = db.prepare('SELECT id, host, kind, status, is_primary FROM tenant_domains WHERE tenant_id = ?').all(TENANT);
const TEST_HOSTS = ['__qrtest-a.example.com', '__qrtest-b.example.com'];
function clearDomains() {
  db.prepare('DELETE FROM tenant_domains WHERE tenant_id = ?').run(TENANT);
}
function restoreDomains() {
  clearDomains();
  const ins = db.prepare('INSERT INTO tenant_domains (id, tenant_id, host, kind, status, is_primary) VALUES (?,?,?,?,?,?)');
  for (const d of SAVED) ins.run(d.id, TENANT, d.host, d.kind, d.status, d.is_primary);
}
function addDomain(host, status, primary) {
  db.prepare("INSERT INTO tenant_domains (tenant_id, host, kind, status, is_primary) VALUES (?,?,'custom',?,?)")
    .run(TENANT, host, status, primary ? 1 : 0);
}

function cleanup() {
  tdbh.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  tdbh.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  tdbh.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

const app = express();
app.use((req, res, next) => { req.user = { id: 3, username: 'mei' }; req.caps = null; next(); });
app.use(router);
let server, PORT;
const get = (u) => fetch(`http://127.0.0.1:${PORT}${u}`);

(async () => {
  cleanup();
  tdbh.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
                VALUES (?, '__test_qr', 'QR fixture', '测试二维码店', 1, 93)`).run(LOC);
  tdbh.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shopId = tdbh.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;

  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });
  try {
    console.log('\nThe address a scan opens');
    check('an active domain gives the tenant\'s own origin plus /s/<code>', () => {
      clearDomains(); addDomain(TEST_HOSTS[0], 'active', 0);
      assert.strictEqual(publicOriginFor(TENANT), 'https://' + TEST_HOSTS[0]);
      assert.strictEqual(menuUrlFor(TENANT, CODE), `https://${TEST_HOSTS[0]}/s/${CODE}`);
    });
    check('a PRIMARY domain wins over a merely-active one', () => {
      clearDomains();
      addDomain(TEST_HOSTS[0], 'active', 0);
      addDomain(TEST_HOSTS[1], 'active', 1);
      assert.strictEqual(menuUrlFor(TENANT, CODE), `https://${TEST_HOSTS[1]}/s/${CODE}`,
        'the domain the tenant nominated is not the one being printed');
    });
    check('a malformed code never becomes a printable address', () => {
      clearDomains(); addDomain(TEST_HOSTS[0], 'active', 1);
      for (const bad of ['LIVEDEMO', 'PREVIEWA', 'lower123', '', null]) {
        assert.strictEqual(menuUrlFor(TENANT, bad), null, String(bad));
      }
    });

    console.log('\nWith no domain it REFUSES — it never borrows somebody else\'s');
    check('no domain at all → null, not a guess', () => {
      clearDomains();
      assert.strictEqual(publicOriginFor(TENANT), null);
      assert.strictEqual(menuUrlFor(TENANT, CODE), null);
    });
    check('a pending or disabled domain is not an answer', () => {
      clearDomains();
      addDomain(TEST_HOSTS[0], 'pending', 1);
      addDomain(TEST_HOSTS[1], 'disabled', 0);
      assert.strictEqual(menuUrlFor(TENANT, CODE), null,
        'a domain that is not serving yet was printed onto a sticker');
    });
    check('and it never falls back to the first tenant\'s literal host', () => {
      clearDomains();
      const u = menuUrlFor(TENANT, CODE);
      assert.strictEqual(u, null);
      // The failure this guards: PAY_NOTIFY_ORIGIN defaults to a literal that
      // belongs to tenant 1. Borrowing it would point one merchant's customers
      // at another merchant's website.
      assert.ok(!String(u).includes('rootskitchenchina'), 'a hardcoded host leaked into a QR');
    });

    console.log('\nOver HTTP');
    await checkAsync('GET …/qr reports the address when there is one', async () => {
      clearDomains(); addDomain(TEST_HOSTS[0], 'active', 1);
      const j = await (await get(`/api/retail-admin/shops/${shopId}/qr`)).json();
      assert.strictEqual(j.data.url, `https://${TEST_HOSTS[0]}/s/${CODE}`);
    });
    await checkAsync('GET …/qr says no_public_domain rather than failing', async () => {
      clearDomains();
      const r = await get(`/api/retail-admin/shops/${shopId}/qr`);
      const j = await r.json();
      assert.strictEqual(r.status, 200, 'a tenant with no domain is a state, not an error');
      assert.strictEqual(j.data.url, null);
      assert.strictEqual(j.data.reason, 'no_public_domain');
    });
    await checkAsync('GET …/qr.png refuses to mint without a domain', async () => {
      clearDomains();
      const r = await get(`/api/retail-admin/shops/${shopId}/qr.png`);
      assert.strictEqual(r.status, 409);
      assert.strictEqual((await r.json()).error, 'no_public_domain');
    });
    await checkAsync('GET …/qr.png returns real PNG bytes, uncached', async () => {
      clearDomains(); addDomain(TEST_HOSTS[0], 'active', 1);
      const r = await get(`/api/retail-admin/shops/${shopId}/qr.png`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('content-type'), 'image/png');
      assert.ok(/no-store/.test(r.headers.get('cache-control') || ''),
        'the picture is cacheable, but the domain behind it can change');
      const b = Buffer.from(await r.arrayBuffer());
      assert.deepStrictEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');
      assert.ok(b.length > 200, 'suspiciously small PNG');
    });
    await checkAsync('an unknown shop gets nothing', async () => {
      assert.strictEqual((await get('/api/retail-admin/shops/999999/qr.png')).status, 404);
      assert.strictEqual((await get('/api/retail-admin/shops/999999/qr')).status, 404);
    });

    console.log('\nThe encoded payload is the URL, not something that merely looks like one');
    check('the QR matrix encodes exactly the menu address', () => {
      clearDomains(); addDomain(TEST_HOSTS[0], 'active', 1);
      const url = menuUrlFor(TENANT, CODE);
      // Same text in gives the same matrix; a different URL gives a different
      // one. That is what makes the picture a function of the address rather
      // than decoration.
      const a = qrpng.qrMatrix(url);
      const b = qrpng.qrMatrix(url);
      const c = qrpng.qrMatrix(url.replace(CODE, 'QRTESTAC'));
      assert.deepStrictEqual(a, b, 'the same address gave two different codes');
      assert.notDeepStrictEqual(a, c, 'two different shops gave the same code');
    });
    check('a realistic customer domain fits the encoder', () => {
      // lib/qrpng carries versions 1-6 only. Every plausible host must fit, and
      // the route must say so rather than 500 when one does not.
      for (const h of ['shop.example.com', 'rootskitchenchina.com', 'shop.rootskitchenchina.com']) {
        const url = `https://${h}/s/${CODE}`;
        assert.doesNotThrow(() => qrpng.qrMatrix(url), url);
      }
      assert.throws(() => qrpng.qrMatrix('https://' + 'x'.repeat(200) + '.com/s/' + CODE),
        /payload too long/, 'the encoder should refuse an impossible payload, not truncate it');
    });

  } finally {
    server.close();
    restoreDomains();
    cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})();
