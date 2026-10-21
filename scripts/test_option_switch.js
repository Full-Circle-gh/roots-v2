#!/usr/bin/env node
/**
 * One answer switched off at one shop — §492.
 *
 *   node scripts/test_option_switch.js
 *
 * THE ASK. 越秀 makes the Hummus Platter on the spot, and one of its "Choose 2
 * crunchy sides" is Whole wheat crackers out of a kitchen container. When the
 * container is empty there was no way to say so: §120 can grey an answer only
 * when it is linked to a counted shelf product, and these crackers are not one
 * (the retail bags are a different thing). Ash: "I need a switch for yuexiu
 * location that can turn off the crackers option".
 *
 * Runs against a REAL sqlite database and the REAL express router over HTTP;
 * only the auth choke point is stubbed, as in test_counter_catalogue.js.
 *
 * Held here:
 *   1. The till's Sold out mode can switch one answer of a made-here item off
 *      and back on, and nothing else is written.
 *   2. Off greys that answer — `out` and `off` — in the till's catalogue at that
 *      shop, and NOT at another shop that sells the same platter.
 *   3. A "choose 2" floor is measured against the answers still on; with every
 *      answer of a required question off, the item itself is sold out.
 *   4. A picked answer that is off is refused at submit (`bad_choice` with
 *      `choice_off`), and the same pick is accepted at the other shop.
 *   5. The switch survives a product save, which re-creates every choice id.
 *   6. A stocked listing has no answer switch; a choice of another product is
 *      not this listing's to switch; removing the listing clears its switches.
 *   7. The QR menu and the till's order path ask the same switch; the web shop
 *      and the mini app do not (Ash: the counter's crackers only).
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function stub(rel, value) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
stub('../routes/retail', { requireRetailAdmin: (req, res, next) => next() });
stub('../middleware/auth', { logActivity: () => {} });

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router = require(path.join(ROOT, 'routes', 'retail-shops.js'));
const productOptions = require(path.join(ROOT, 'lib', 'product-options.js'));
const optionSwitch = require(path.join(ROOT, 'lib', 'option-switch.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
const LOC_A  = 9371;   // 越秀's shape: a shop, the platter made here
const LOC_B  = 9372;   // another shop, the same platter made here
const SHOP_A = 9373;
const SHOP_B = 9374;
const P_PLATTER = 96911;  // made here at both shops, asks two questions
const P_JAR     = 96912;  // stocked at A, asks one question
const P_OTHER   = 96913;  // not on any menu; its choice is not A's to switch
const PRODUCTS = [P_PLATTER, P_JAR, P_OTHER];

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  db.prepare('DELETE FROM shop_option_choices_off WHERE shop_id IN (?, ?)').run(SHOP_A, SHOP_B);
  db.prepare(`DELETE FROM retail_product_option_choices WHERE option_id IN
                (SELECT id FROM retail_product_options WHERE product_id IN (${PRODUCTS.join(',')}))`).run();
  db.prepare(`DELETE FROM retail_product_options WHERE product_id IN (${PRODUCTS.join(',')})`).run();
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (?, ?)').run(SHOP_A, SHOP_B);
  db.prepare('DELETE FROM shops WHERE id IN (?, ?) OR location_id IN (?, ?)').run(SHOP_A, SHOP_B, LOC_A, LOC_B);
  db.prepare(`DELETE FROM store_products WHERE id IN (${PRODUCTS.join(',')})`).run();
  db.prepare('DELETE FROM retail_stores WHERE id IN (?, ?)').run(LOC_A, LOC_B);
}
cleanup();

db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_osw_a', 'Switch fixture A', '测试开关A', 1, 98)`).run(LOC_A);
db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
            VALUES (?, '__test_osw_b', 'Switch fixture B', '测试开关B', 1, 99)`).run(LOC_B);
db.prepare(`INSERT INTO shops (id, location_id, public_code, is_active) VALUES (?, ?, '__OSWFXA', 1)`).run(SHOP_A, LOC_A);
db.prepare(`INSERT INTO shops (id, location_id, public_code, is_active) VALUES (?, ?, '__OSWFXB', 1)`).run(SHOP_B, LOC_B);

const insProduct = db.prepare(`
  INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, top_category, is_active, is_published, is_restock_only)
  VALUES (?, ?, ?, ?, ?, 'Fresh & Deli', 1, 0, 0)`);
insProduct.run(P_PLATTER, 'Fixture platter', '测试拼盘', '__OSW-1', 58);
insProduct.run(P_JAR,     'Fixture jar',     '测试罐',   '__OSW-2', 20);
insProduct.run(P_OTHER,   'Fixture other',   '测试其他', '__OSW-3', 10);

const insListing = db.prepare(`
  INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
  VALUES (?, ?, ?, ?, 1, ?)`);
insListing.run(SHOP_A, P_PLATTER, 58, 'made_here', 0);
insListing.run(SHOP_A, P_JAR,     20, 'stocked',   1);
insListing.run(SHOP_B, P_PLATTER, 58, 'made_here', 0);
const listingId = (shop, pid) => db.prepare('SELECT id FROM shop_listings WHERE shop_id = ? AND store_product_id = ?').get(shop, pid).id;

// The platter's questions, written the way the product editor writes them:
// a required "choose 2" of three sides, and an optional extra.
function writePlatterOptions() {
  db.prepare(`DELETE FROM retail_product_option_choices WHERE option_id IN
                (SELECT id FROM retail_product_options WHERE product_id = ?)`).run(P_PLATTER);
  db.prepare('DELETE FROM retail_product_options WHERE product_id = ?').run(P_PLATTER);
  const insOpt = db.prepare(`INSERT INTO retail_product_options
      (product_id, question_en, question_cn, type, is_required, min_choices, max_choices, allow_repeat, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  const insCh = db.prepare(`INSERT INTO retail_product_option_choices
      (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order) VALUES (?, ?, ?, ?, 0, NULL, ?)`);
  const sides = insOpt.run(P_PLATTER, 'Choose 2 crunchy sides', '选两样脆配', 'multi', 1, 2, 2, 0).lastInsertRowid;
  insCh.run(sides, 'Whole wheat crackers', '全麦饼干', 0, 0);
  insCh.run(sides, 'Tortilla corn chips',  '玉米片',   0, 1);
  insCh.run(sides, 'Veggie sticks',        '蔬菜条',   0, 2);
  const extra = insOpt.run(P_PLATTER, 'Add extras?', '加料？', 'multi', 0, 0, 0, 1).lastInsertRowid;
  insCh.run(extra, 'Hot chickpeas & tahini', '热鹰嘴豆芝麻酱', 4, 0);
}
writePlatterOptions();
for (const [pid, q, lab] of [[P_JAR, 'Size?', 'Small'], [P_OTHER, 'Sauce?', 'Whole wheat crackers']]) {
  const o = db.prepare(`INSERT INTO retail_product_options (product_id, question_en, type, is_required, sort_order)
                        VALUES (?, ?, 'single', 0, 0)`).run(pid, q).lastInsertRowid;
  db.prepare(`INSERT INTO retail_product_option_choices (option_id, label_en, price_delta, sort_order)
              VALUES (?, ?, 0, 0)`).run(o, lab);
}
const choiceId = (pid, label) => db.prepare(`
  SELECT c.id FROM retail_product_option_choices c JOIN retail_product_options o ON o.id = c.option_id
   WHERE o.product_id = ? AND c.label_en = ?`).get(pid, label).id;

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  req.user = { id: 3, username: 'mei' };
  const c = req.headers['x-caps'];
  req.caps = c == null ? null : new Set(String(c).split(',').filter(Boolean));
  const sc = req.headers['x-scope'];
  req.scopeStores = sc ? String(sc).split(',').map(Number) : null;
  next();
});
app.use(router);

let server, PORT;
function call(method, url, body, headers) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}
const switchOff = (shop, pid, label, off, headers) =>
  call('PUT', `/api/retail-admin/shops/${shop}/listings/${listingId(shop, pid)}/choices/${choiceId(pid, label)}/off`, { off }, headers);
async function catalogue(loc) {
  const r = await call('GET', `/api/retail-admin/stores/${loc}/counter-catalogue`);
  return (r.json && r.json.data && r.json.data.rows) || [];
}
const platterRow = (rows) => rows.filter(r => r.product_id === P_PLATTER)[0];
const sidesQ = (row) => row.options.filter(q => q.q_en === 'Choose 2 crunchy sides')[0];
const choiceIn = (q, label) => q.choices.filter(c => c.en === label)[0];
const offRows = () => db.prepare('SELECT shop_id, store_product_id, label FROM shop_option_choices_off WHERE shop_id IN (?, ?) ORDER BY shop_id, label').all(SHOP_A, SHOP_B);

// The submit check, as the QR menu and the till call it for a location.
const submit = (loc, picks) => productOptions.resolveAnswers(db,
  [{ product_id: P_PLATTER, qty: 1, choices: picks.map(l => choiceId(P_PLATTER, l)) }],
  { isChoiceSwitchedOff: optionSwitch.switchedOffAt(db, loc) });

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    console.log('\nBefore anything is switched — nothing is off');
    await check('every side is pickable and the floor is 2', async () => {
      const q = sidesQ(platterRow(await catalogue(LOC_A)));
      assert.strictEqual(q.min, 2);
      for (const c of q.choices) { assert.strictEqual(c.out, 0, c.en); assert.strictEqual(c.off, undefined, c.en); }
    });

    console.log('\nSwitching the crackers off at A');
    await check('the till switch answers 200 and writes one row, keyed by label', async () => {
      const r = await switchOff(SHOP_A, P_PLATTER, 'Whole wheat crackers', true);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(offRows(), [{ shop_id: SHOP_A, store_product_id: P_PLATTER, label: 'Whole wheat crackers' }]);
    });
    await check('switching off twice is still one row', async () => {
      assert.strictEqual((await switchOff(SHOP_A, P_PLATTER, 'Whole wheat crackers', true)).status, 200);
      assert.strictEqual(offRows().length, 1);
    });
    await check('A\'s till greys the crackers (out + off) and leaves the other sides alone', async () => {
      const q = sidesQ(platterRow(await catalogue(LOC_A)));
      assert.strictEqual(choiceIn(q, 'Whole wheat crackers').out, 1);
      assert.strictEqual(choiceIn(q, 'Whole wheat crackers').off, 1);
      assert.strictEqual(choiceIn(q, 'Tortilla corn chips').out, 0);
      assert.strictEqual(choiceIn(q, 'Veggie sticks').out, 0);
      assert.strictEqual(q.min, 2, 'two sides are still on, so it still asks for two');
    });
    await check('B, selling the same platter, is untouched', async () => {
      const q = sidesQ(platterRow(await catalogue(LOC_B)));
      assert.strictEqual(choiceIn(q, 'Whole wheat crackers').out, 0);
      assert.strictEqual(choiceIn(q, 'Whole wheat crackers').off, undefined);
    });
    await check('a submit at A picking the crackers is refused as bad_choice / choice_off', async () => {
      const r = submit(LOC_A, ['Whole wheat crackers', 'Veggie sticks']);
      assert.strictEqual(r.error, 'bad_choice');
      assert.strictEqual(r.choice_off, true);
      assert.strictEqual(r.product_id, P_PLATTER);
    });
    await check('the same pick at B is accepted', async () => {
      const r = submit(LOC_B, ['Whole wheat crackers', 'Veggie sticks']);
      assert.ok(!r.error, r.error);
    });
    await check('A without the crackers is accepted', async () => {
      const r = submit(LOC_A, ['Tortilla corn chips', 'Veggie sticks']);
      assert.ok(!r.error, r.error);
    });
    await check('the item itself stays on sale — it is not switched off', async () => {
      const row = platterRow(await catalogue(LOC_A));
      assert.strictEqual(row.switched_off, false);
      assert.strictEqual(row.stock, null);
    });

    console.log('\nThe floor follows what is still on');
    await check('with two sides off, "choose 2" asks for 1 and accepts 1', async () => {
      assert.strictEqual((await switchOff(SHOP_A, P_PLATTER, 'Tortilla corn chips', true)).status, 200);
      const q = sidesQ(platterRow(await catalogue(LOC_A)));
      assert.strictEqual(q.min, 1);
      assert.ok(!submit(LOC_A, ['Veggie sticks']).error);
    });
    await check('with every side off, the required question takes the platter with it', async () => {
      assert.strictEqual((await switchOff(SHOP_A, P_PLATTER, 'Veggie sticks', true)).status, 200);
      const row = platterRow(await catalogue(LOC_A));
      assert.strictEqual(row.stock, 0, 'sold out on the tile');
    });
    await check('switching two back on restores the floor of 2', async () => {
      assert.strictEqual((await switchOff(SHOP_A, P_PLATTER, 'Veggie sticks', false)).status, 200);
      assert.strictEqual((await switchOff(SHOP_A, P_PLATTER, 'Tortilla corn chips', false)).status, 200);
      const row = platterRow(await catalogue(LOC_A));
      assert.strictEqual(row.stock, null);
      assert.strictEqual(sidesQ(row).min, 2);
      assert.deepStrictEqual(offRows().map(r => r.label), ['Whole wheat crackers']);
    });

    console.log('\nA product save re-creates every choice id');
    await check('the crackers are still off after the save', async () => {
      const before = choiceId(P_PLATTER, 'Whole wheat crackers');
      writePlatterOptions();
      assert.notStrictEqual(choiceId(P_PLATTER, 'Whole wheat crackers'), before, 'the id really did change');
      const q = sidesQ(platterRow(await catalogue(LOC_A)));
      assert.strictEqual(choiceIn(q, 'Whole wheat crackers').off, 1);
      assert.strictEqual(submit(LOC_A, ['Whole wheat crackers', 'Veggie sticks']).choice_off, true);
    });

    console.log('\nWhat the switch refuses');
    await check('a stocked listing has no answer switch (409 not_made_here)', async () => {
      const r = await switchOff(SHOP_A, P_JAR, 'Small', true);
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'not_made_here');
    });
    await check('another product\'s choice is not this listing\'s to switch (404)', async () => {
      const r = await call('PUT', `/api/retail-admin/shops/${SHOP_A}/listings/${listingId(SHOP_A, P_PLATTER)}/choices/${choiceId(P_OTHER, 'Whole wheat crackers')}/off`, { off: true });
      assert.strictEqual(r.status, 404);
    });
    await check('a body without a boolean `off` is refused (400)', async () => {
      const r = await call('PUT', `/api/retail-admin/shops/${SHOP_A}/listings/${listingId(SHOP_A, P_PLATTER)}/choices/${choiceId(P_PLATTER, 'Veggie sticks')}/off`, { off: 'yes' });
      assert.strictEqual(r.status, 400);
    });
    await check('a cashier scoped to B cannot switch A (403)', async () => {
      const r = await switchOff(SHOP_A, P_PLATTER, 'Veggie sticks', true, { 'x-scope': String(LOC_B) });
      assert.strictEqual(r.status, 403);
    });
    await check('without till:use or stores:edit it is refused (403)', async () => {
      const r = await switchOff(SHOP_A, P_PLATTER, 'Veggie sticks', true, { 'x-caps': 'orders:view' });
      assert.strictEqual(r.status, 403);
    });
    await check('with till:use alone it is allowed', async () => {
      const r = await switchOff(SHOP_A, P_PLATTER, 'Veggie sticks', false, { 'x-caps': 'till:use' });
      assert.strictEqual(r.status, 200);
    });
    await check('none of the refusals wrote anything', async () => {
      assert.deepStrictEqual(offRows().map(r => r.label), ['Whole wheat crackers']);
    });

    console.log('\nRemoving the listing');
    await check('removing the platter from A\'s menu clears its switches', async () => {
      const r = await call('DELETE', `/api/retail-admin/shops/${SHOP_A}/listings/${listingId(SHOP_A, P_PLATTER)}`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(offRows(), []);
    });

    console.log('\nWho asks the switch, and who does not');
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    await check('the QR menu greys by it and refuses by it, answering a stale pick with its 409', () => {
      const src = read('routes/shop-menu.js');
      assert.match(src, /questionsForProducts\(tdb\(\), pids, \{ isChoiceSoldOut, isChoiceSwitchedOff \}\)/);
      assert.match(src, /isChoiceSwitchedOff: optionSwitch\.switchedOffAt\(tdb\(\), shop\.location_id\)/);
      assert.match(src, /answers\.error && answers\.choice_off/);
    });
    await check('the till\'s order path and the staff New order list ask it for their store', () => {
      const src = read('routes/retail.js');
      assert.match(src, /isChoiceSwitchedOff: optionSwitch\.switchedOffAt\(tdb\(\), storeId\)/);
      assert.match(src, /isChoiceSwitchedOff: optionSwitch\.switchedOffAt\(tdb\(\), optStore\)/);
      assert.strictEqual((src.match(/optionSwitch\./g) || []).length, 2,
        'the web shop and mini app paths must not read the counter\'s switch');
    });
    await check('the till draws a chip per answer in Sold out mode and posts to the route', () => {
      const src = read('public/till.html');
      assert.match(src, /function toggleChoiceOff\(/);
      assert.match(src, /'\/choices\/' \+ cid \+ '\/off'/);
      assert.match(src, /\[data-so-c\]/);
    });
    await check('the switch table is read and written only through lib/option-switch.js', () => {
      const hits = [];
      const walk = d => {
        for (const ent of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
          const rel = path.join(d, ent.name);
          if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(rel); continue; }
          if (!/\.(js|html)$/.test(ent.name)) continue;
          if (rel === path.join('lib', 'option-switch.js')) continue;
          if (/shop_option_choices_off/.test(read(rel))) hits.push(rel);
        }
      };
      for (const d of ['routes', 'lib', 'middleware', 'public', 'miniapp']) walk(d);
      assert.deepStrictEqual(hits, []);
    });
  } finally {
    server.close();
    cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
