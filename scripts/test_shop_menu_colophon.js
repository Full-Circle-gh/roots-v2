#!/usr/bin/env node
/**
 * THE QR MENU SIGNS A PRODUCT PAGE — §179, over §158 and §132.
 *
 *   node scripts/test_shop_menu_colophon.js
 *
 * WHAT THIS HOLDS THAT READING routes/shop-menu.js CANNOT.
 *
 *  1. THE COLOPHON NEVER OPENS A SHEET BY ITSELF, and this is the assertion
 *     the whole change turns on. §120's rule is that a product with nothing to
 *     say does not open at all, because an empty panel is worse than a card
 *     that does not respond. Every product has a colophon — the shop's own
 *     name is enough to draw one — so a colophon built one line too early
 *     makes EVERY card on EVERY menu tappable onto a panel holding a mascot
 *     and nothing else. That is invisible in review and obvious to a customer.
 *     Held here by a product with no blocks, no nutrition and one size, which
 *     must have no sheet, no colophon and no tap target.
 *
 *  2. NOBODY ELSE IS SIGNED AS ROOTS. §158 found Roots' cast, slogan and name
 *     written as literals into two surfaces that ship once per tenant, with an
 *     auto-picker that resolved to Roots' own mascot for a shop that had
 *     chosen nothing — the default, not an edge case. This page is the third
 *     surface, and it asks lib/brand-signature rather than carrying a fourth
 *     copy of that map. Served to a host that belongs to another tenant, the
 *     menu must carry that tenant's name and NONE of Roots' ten characters,
 *     its tagline or its house line.
 *
 *  3. AN OPERATOR'S CHARACTER IS A FILENAME ON A PUBLIC URL. resolveCharacter
 *     honours an override verbatim by design and is right to — blanking a page
 *     somebody deliberately signed is the worse failure — but the mini app
 *     spends that value inside its own package and this page spends it inside
 *     an attribute on a page anyone can scan. A stored value that is not a
 *     character key draws no image, and the rest of the colophon survives it.
 *
 *  4. BOTH LANGUAGES ARE IN THE DOM. This page ships EN and 中 together and
 *     hides one with CSS, so a tagline resolved to a single language — the way
 *     the phone resolves it, because the phone knows which one it is in —
 *     would render blank for half its readers. An override typed into one box
 *     only must reach both.
 *
 * WHERE THIS SUITE DIVERGES FROM PRODUCTION, stated rather than hidden. Check 2
 * mounts the router WITHOUT middleware/public-tenant's publicTenantScope, so
 * the request resolves a non-Roots tenant for its SIGNATURE while its data
 * scope stays on this database's fixtures. In production the same host would
 * also move the catalogue read into that tenant's own db. The split is what
 * makes the property testable at all without standing up a second tenant
 * database, and it exercises the only line that matters here: which tenant row
 * menuSignature() resolves and what signatureFor() then answers.
 */
'use strict';

const assert  = require('assert');
const http    = require('http');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

const mainDb = require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const brandSignature = require(path.join(ROOT, 'lib', 'brand-signature.js'));
// Loaded for real: the menu borrows its photo fallback and its money format.
require(path.join(ROOT, 'routes', 'retail.js'));
// `tenants` and `tenant_domains` are created at require time by the file that
// OWNS them. Required here rather than spelled out again, so this suite cannot
// seed a shape the real schema has moved on from.
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// A block of its own, clear of the 91xx–98xx ranges the sibling suites use.
const LOC = 9871;
const P_AUTO   = 9971;  // no character stored     → the auto pick, by category
const P_PICK   = 9972;  // character stored        → the override wins
const P_BARE   = 9973;  // not food, nothing to say → no sheet, so no colophon
const P_TAGEN  = 9974;  // English tagline only    → must reach both languages
const P_JUNK   = 9975;  // a character that is not → no image, colophon stands
const P_BFOOD  = 9976;  // FOOD, nothing written   → §243: opens for the card
const PRODS = [P_AUTO, P_PICK, P_BARE, P_TAGEN, P_JUNK, P_BFOOD];

const T_OTHER = 9979;                       // a tenant that is not Roots
const T_HOST  = 'colophon-fixture.example';

const CHIPS = JSON.stringify([{ type: 'ingredients_chips',
  items: [{ name_en: 'Espresso', name_cn: '浓缩咖啡' }] }]);

let CODE = '';
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODS.map(() => '?').join(',')})`).run(...PRODS);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
  try { mainDb.prepare('DELETE FROM tenant_domains WHERE tenant_id = ?').run(T_OTHER); } catch (e) { /* table not created yet */ }
  try { mainDb.prepare('DELETE FROM tenants WHERE id = ?').run(T_OTHER); } catch (e) { /* ditto */ }
}

function seed() {
  cleanup();
  db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
              VALUES (?, '__test_colophon', 'Colophon fixture', '测试签名店', 1, 97)`).run(LOC);

  const prod = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, category,
     description_blocks, colophon_character, colophon_tagline_en, colophon_tagline_cn)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`);
  // 'drink' is what ROOTS_AUTO_MAP files under kombucha-gang. The map is Roots'
  // own and is asserted through the module below, never re-spelled here.
  prod.run(P_AUTO,  'Colo Auto',  '签名自动', '__colo_auto',  10, 'drink',  CHIPS, null,      null, null);
  prod.run(P_PICK,  'Colo Pick',  '签名指定', '__colo_pick',  11, 'drink',  CHIPS, 'skater',  null, null);
  // §243 — a FOOD product always has something to say now (the allergen
  // card's shared-facility trace line), so §120's "nothing to say, no sheet"
  // is tested on a product that is not food, and the bare food product below
  // is tested for the opposite.
  prod.run(P_BARE,  'Colo Bare',  '签名空白', '__colo_bare',  12, 'Home & Body', null, null, null, null);
  prod.run(P_TAGEN, 'Colo TagEn', '签名标语', '__colo_tagen', 13, 'drink',  CHIPS, null,      'Only in English', null);
  prod.run(P_JUNK,  'Colo Junk',  '签名乱码', '__colo_junk',  14, 'drink',  CHIPS, '../../brand/secret', null, null);
  prod.run(P_BFOOD, 'Colo BareFood', '签名空食', '__colo_bfood', 15, 'drink', null,  null,      null, null);

  // A fixed code in lib/shop-code.js's own alphabet, the way the sibling
  // suites spell theirs — isShopCode() refuses the path before it can become
  // a query, so a code that merely looks plausible is a 404 and not a fixture.
  CODE = 'CLPHNSG2';
  assert.ok(require(path.join(ROOT, 'lib', 'shop-code.js')).isShopCode(CODE),
    'the fixture shop code is not a shop code');
  db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shop = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC);

  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, ?, 'made_here', 1, ?)`);
  PRODS.forEach((p, i) => add.run(shop.id, p, 20 + i, i));

  // The other tenant. Its ROW is the whole fixture: signatureFor() reads name
  // and brand_name and nothing else, and a shop with no cast has no cast to
  // seed.
  mainDb.prepare(`INSERT INTO tenants (id, name, brand_name, status)
                  VALUES (?, 'Colophon Fixture Co', 'Fixture Teahouse', 'active')`).run(T_OTHER);
  mainDb.prepare(`INSERT INTO tenant_domains (tenant_id, host, kind, status)
                  VALUES (?, ?, 'subdomain', 'active')`).run(T_OTHER, T_HOST);
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(router);
let server, PORT;

/* RAW http.request, NOT fetch, AND THAT IS THE WHOLE REASON THIS HELPER EXISTS.
   Node's fetch is undici, and undici silently DROPS a Host header a caller
   sets — it is forbidden by the fetch spec. The tenant check below resolves a
   shop by its host, so under fetch it was quietly asking for 127.0.0.1 and
   getting Roots, and the check failed for a reason that had nothing to do with
   the page. Anything that needs a header the browser owns has to be sent by a
   client that will send it. */
function get(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: `/s/${CODE}`, method: 'GET',
      headers: headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The sheet body for one product, which is what the page ships inside that
// product's own <template data-dt>. Asking the whole page instead would let
// one product's colophon answer for another's.
function sheetFor(html, nameEn) {
  const at = html.indexOf(nameEn);
  assert.ok(at > -1, `product "${nameEn}" is not on the page at all`);
  const card = html.lastIndexOf('<div class="it', at);
  assert.ok(card > -1, `no row wrapper before "${nameEn}"`);
  const next = html.indexOf('<div class="it', at);
  const row = html.slice(card, next === -1 ? html.length : next);
  const open = row.indexOf('<template data-dt=');
  if (open === -1) return null;              // this card does not open at all
  const from = row.indexOf('>', open) + 1;
  return row.slice(from, row.indexOf('</template>', from));
}

(async () => {
  seed();
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; r(); }); });

  console.log('\n§179 · the colophon reaches the menu a customer scans\n');

  const roots = brandSignature.signatureFor(null);
  const page = (await get()).body;

  await checkAsync('the page renders and every fixture product is on it', async () => {
    const r = await get();
    assert.strictEqual(r.status, 200);
    for (const n of ['Colo Auto', 'Colo Pick', 'Colo Bare', 'Colo TagEn', 'Colo Junk']) {
      assert.ok(r.body.includes(n), `"${n}" is missing from the menu`);
    }
  });

  check('an unset character is auto-picked, by the shared map and not a local one', () => {
    const want = brandSignature.resolveCharacter(roots, '', 'drink');
    assert.ok(want, 'the module itself picked nothing for a drink — fixture is wrong');
    const sheet = sheetFor(page, 'Colo Auto');
    assert.ok(sheet, 'Colo Auto has no sheet, so nothing could be signed');
    assert.ok(sheet.includes(`/assets/brand/ip-${want}.jpg`),
      `expected the auto pick ip-${want}.jpg in the sheet`);
  });

  check('a character the office picked wins over the auto pick', () => {
    const auto = brandSignature.resolveCharacter(roots, '', 'drink');
    const sheet = sheetFor(page, 'Colo Pick');
    assert.ok(sheet.includes('/assets/brand/ip-skater.jpg'), 'the stored character is not drawn');
    assert.ok(!sheet.includes(`ip-${auto}.jpg`), 'the auto pick overrode the office');
  });

  check('the house line is drawn on a hairline rule', () => {
    const sheet = sheetFor(page, 'Colo Auto');
    assert.ok(roots.house, 'Roots has no house line — brand-signature changed');
    assert.ok(sheet.includes(roots.house), 'the house line is missing');
    assert.ok(/pb-colo-r"><\/span><span>/.test(sheet), 'the rule before the name is missing');
  });

  check('the shop tagline is drawn in BOTH languages', () => {
    const sheet = sheetFor(page, 'Colo Auto');
    assert.ok(sheet.includes(roots.tagline_en), 'the English tagline is missing');
    assert.ok(sheet.includes(roots.tagline_cn), 'the Chinese tagline is missing');
  });

  check('a tagline typed into one box only reaches both languages', () => {
    const sheet = sheetFor(page, 'Colo TagEn');
    const colo = sheet.slice(sheet.indexOf('pb-colo-t'));
    assert.ok(/l-en">Only in English/.test(colo) || colo.includes('Only in English'),
      'the override is missing from the English view');
    // Two occurrences: the page emits l-en and l-cn, and the empty half falls
    // back to the other so the 中 view is not blank.
    const hits = colo.split('Only in English').length - 1;
    assert.ok(hits >= 2, `the override reaches only ${hits} of the two languages`);
    assert.ok(!colo.includes(roots.tagline_en),
      "the shop's house tagline overrode the product's own");
  });

  check('a stored character that is not a character key draws no image', () => {
    const sheet = sheetFor(page, 'Colo Junk');
    const colo = sheet.slice(sheet.indexOf('<div class="pb-colo"'));
    assert.ok(colo, 'Colo Junk has no colophon at all');
    assert.ok(!colo.includes('<img'), 'a junk character key still produced an image tag');
    assert.ok(!colo.includes('secret'), 'the stored value reached the page');
    // The rest of the colophon is unharmed: a bad character is not a bad page.
    assert.ok(colo.includes(roots.house), 'the house line went with it');
  });

  check('§243 — a FOOD product with nothing written opens, onto the allergen card', () => {
    const sheet = sheetFor(page, 'Colo BareFood');
    assert.ok(sheet, 'a food product with no blocks still has no sheet, so no trace line');
    assert.ok(sheet.includes('(shared facility)'), 'the sheet opened without the trace line');
    assert.ok(!sheet.includes('None declared'), 'a card nobody wrote claims what the food contains');
  });

  check('a product with nothing to say STILL does not open — §120 survives', () => {
    assert.strictEqual(sheetFor(page, 'Colo Bare'), null,
      'the colophon gave a card with nothing to say a sheet of its own');
    const at = page.indexOf('Colo Bare');
    const card = page.lastIndexOf('<div class="it', at);
    const next = page.indexOf('<div class="it', at);
    const row = page.slice(card, next === -1 ? page.length : next);
    assert.ok(!row.includes('has-dt'), 'the card is marked as having a sheet');
    assert.ok(!row.includes('data-open='), 'the card is a tap target with nothing behind it');
    assert.ok(!row.includes('pb-colo'), 'a colophon was drawn outside any sheet');
  });

  await checkAsync("another tenant's menu carries its own name and none of Roots'", async () => {
    const r = await get({ Host: T_HOST });
    assert.strictEqual(r.status, 200);
    const sheet = sheetFor(r.body, 'Colo Auto');
    assert.ok(sheet, 'the sheet vanished under the other tenant');
    assert.ok(sheet.includes('Fixture Teahouse'), "the tenant's own name is not on its colophon");
    assert.ok(!sheet.includes(roots.house), "Roots' house line is on somebody else's menu");
    assert.ok(!sheet.includes(roots.tagline_en), "Roots' slogan is on somebody else's menu");
    assert.ok(!sheet.includes(roots.tagline_cn), "Roots' 中文 slogan is on somebody else's menu");
    for (const c of roots.characters) {
      assert.ok(!sheet.includes(`ip-${c.key}.jpg`),
        `Roots' ${c.key} is drawn on another tenant's product`);
    }
  });

  await checkAsync('...and an OVERRIDE cannot smuggle Roots\' cast onto it either', async () => {
    // Colo Pick stores 'skater' — a Roots key. resolveCharacter honours an
    // override as-is, so this is the one route by which another tenant could
    // still end up drawing Roots' mascot, and it is only closed because the
    // cast check runs inside the module. If that ever loosens, this goes red.
    const r = await get({ Host: T_HOST });
    const sheet = sheetFor(r.body, 'Colo Pick');
    const keeps = brandSignature.resolveCharacter(
      brandSignature.signatureFor({ id: T_OTHER, name: 'Colophon Fixture Co' }), 'skater', 'drink');
    if (!keeps) assert.ok(!sheet.includes('ip-skater.jpg'),
      'the module drops the override for a castless shop, but the page drew it anyway');
    else assert.ok(sheet.includes('ip-skater.jpg'),
      'the module keeps the override, but the page dropped it');
  });

  check('THE ASSERTIONS ARE NOT VACUOUS — the page really does carry a colophon', () => {
    const hits = page.split('class="pb-colo"').length - 1;
    // Five of the six products open a sheet; the bare non-food one must not.
    assert.strictEqual(hits, 5, `expected 5 colophons on this menu, found ${hits}`);
    assert.ok(page.includes('.pb-colo{'), 'the stylesheet never shipped the rule');
  });

  check('the stylesheet still carries no angle bracket, comments included', () => {
    const at = page.indexOf('<style>');
    const css = page.slice(at + 7, page.indexOf('</style>', at));
    assert.ok(!/[<>]/.test(css), 'an angle bracket reached the stylesheet');
  });

  server.close();
  cleanup();
  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { try { server && server.close(); cleanup(); } catch (x) { /* teardown after a throw */ } console.error(e); process.exit(1); });
