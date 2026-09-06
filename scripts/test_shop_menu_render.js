#!/usr/bin/env node
/**
 * The QR menu occupies real pixels — in BOTH languages.
 *
 *   node scripts/test_shop_menu_render.js
 *
 * WHY A GEOMETRY TEST AND NOT ONLY A STRING TEST. This page ships both
 * languages in the DOM and hides one with CSS (`.lang-en .l-cn`,
 * `.lang-cn .l-en` in routes/shop-menu.js). That is a `display:none`
 * mechanism, and a `display:none` mechanism is how a page ends up rendering
 * nothing while every string assertion still passes — the exact failure
 * scripts/test_shop_menu_geometry.js was written for on the admin side, one
 * class of bug and two surfaces. A wrong root class, a typo in either
 * selector, or a rule that hid the wrapper rather than the span would leave
 * scripts/test_shop_menu.js entirely green over a blank phone screen.
 *
 * WHAT IT DOES. Serves the REAL page from the REAL router over HTTP against
 * REAL fixture rows, opens it in a headless Chromium at phone width, and
 * measures. In English mode the English name must have a non-zero box and the
 * Chinese one must not be rendered; then it clicks 中 and requires the exact
 * reverse. The header, a group heading, a price and a sold-out badge must all
 * be on screen with a real box in both.
 *
 * AND IT PROVES THE ASSERTION IS NOT VACUOUS. The same page is re-rendered
 * with the root language class removed. Both languages must then be visible at
 * once — which is what the CSS is there to prevent — so a run where the
 * selectors did nothing could not pass by accident.
 *
 * Prints "SKIP — no Chromium found" and exits 0 where there is no browser,
 * which scripts/run-suites.js turns into a failure under REQUIRE_BROWSER=1.
 */
'use strict';
/* global document, window, getComputedStyle -- referenced only inside
   page.evaluate() callbacks, which run in the browser, not in this process. */

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// THE SHARED LOOKUP, COPIED RATHER THAN REINVENTED — byte-for-byte from
// scripts/test_stock_home.js, which is the fullest of the copies the render
// suites share. CLAUDE.md's worked example of 2026-09-05 is exactly this:
// a new browser suite that looked in fewer places than its thirty-three
// siblings skipped on CI and was correctly counted as a failure. CHROME_BIN is
// where the workflow says the runner's browser is, so it is asked first.
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* playwright not installed here */ }
  for (const g of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const router  = require(path.join(ROOT, 'routes', 'shop-menu.js'));
const db = tdb();

const LOC = 9871;
const P_OK = 9971, P_OUT = 9972;
const CODE = 'RENDERAB';
const EN_OK = 'Render fixture latte', CN_OK = '测试渲染拿铁';
const EN_OUT = 'Render fixture bun',  CN_OUT = '测试渲染面包';

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?)').run(P_OK, P_OUT);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

function seed() {
  cleanup();
  db.prepare(`INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
              VALUES (?, '__test_menu_render', 'Render fixture shop', '测试渲染门店', 1, 96)`).run(LOC);
  const prod = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Drinks')`);
  prod.run(P_OK, EN_OK, CN_OK, '__R-71', 33);
  prod.run(P_OUT, EN_OUT, CN_OUT, '__R-72', 18);
  db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, ?, 'made_here', ?, ?)`);
  add.run(shopId, P_OK, 33, 1, 0);
  add.run(shopId, P_OUT, 18, 0, 1);   // switched off → the sold-out badge
}

// Box of the first element whose text is exactly `text`, or null when the
// element is not rendered at all. Measured, not inferred from the stylesheet.
// Passed as a real function, NOT as a source string: page.evaluate silently
// DROPS the argument when the first parameter is a string, so a string form
// measures `undefined`, finds nothing, and every negative assertion in this
// file passes over a page it never looked at. Cost one debugging round.
function boxOf(text) {
  const els = Array.from(document.querySelectorAll('span, h2, div'));
  const el = els.find(e => e.textContent.trim() === text && e.children.length === 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { w: r.width, h: r.height, display: cs.display, visibility: cs.visibility };
}

(async () => {
  const exe = findChrome();
  if (!exe) { console.log('SKIP — no Chromium found'); process.exit(0); }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { console.log('SKIP — no Chromium found (playwright missing)'); process.exit(0); }

  seed();
  const app = express();
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const PORT = server.address().port;
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/s/${CODE}`, { waitUntil: 'domcontentloaded' });

    const onScreen = (b) => !!b && b.w > 0 && b.h > 0;

    await check('English mode puts the English name on screen with a real box', async () => {
      const b = await page.evaluate(boxOf, EN_OK);
      assert.ok(onScreen(b), `English name has no box: ${JSON.stringify(b)}`);
    });
    await check('English mode does not render the Chinese name', async () => {
      const b = await page.evaluate(boxOf, CN_OK);
      assert.ok(!onScreen(b), `both languages are visible at once: ${JSON.stringify(b)}`);
    });
    await check('the shop name, the group heading, the price and the badge all have boxes', async () => {
      for (const t of ['Render fixture shop', 'Drinks', 'Sold out']) {
        const b = await page.evaluate(boxOf, t);
        assert.ok(onScreen(b), `"${t}" is not on screen: ${JSON.stringify(b)}`);
      }
      const price = await page.evaluate(() => {
        const el = document.querySelector('.pr');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, text: el.textContent.trim() };
      });
      assert.ok(price && price.w > 0 && price.h > 0, `no price box: ${JSON.stringify(price)}`);
      assert.ok(/33/.test(price.text), `the price does not read as money: ${JSON.stringify(price)}`);
    });
    await check('nothing overflows the phone horizontally', async () => {
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth, win: window.innerWidth,
      }));
      assert.ok(over.doc <= over.win + 1, `the page scrolls sideways on a phone: ${JSON.stringify(over)}`);
    });

    await check('tapping 中 swaps the visible language, both ways, with real boxes', async () => {
      await page.click('[data-lang="cn"]');
      const cn = await page.evaluate(boxOf, CN_OK);
      const en = await page.evaluate(boxOf, EN_OK);
      assert.ok(onScreen(cn), `Chinese name has no box after the toggle: ${JSON.stringify(cn)}`);
      assert.ok(!onScreen(en), `English is still visible after switching to Chinese: ${JSON.stringify(en)}`);
      const badge = await page.evaluate(boxOf, '售罄');
      assert.ok(onScreen(badge), 'the sold-out badge did not follow the language');
      await page.click('[data-lang="en"]');
      const back = await page.evaluate(boxOf, EN_OK);
      assert.ok(onScreen(back), 'switching back to English left nothing on screen');
    });

    await check('the choice survives a reload and detection does not overrule it', async () => {
      await page.click('[data-lang="cn"]');
      await page.reload({ waitUntil: 'domcontentloaded' });
      const cn = await page.evaluate(boxOf, CN_OK);
      const en = await page.evaluate(boxOf, EN_OK);
      assert.ok(onScreen(cn) && !onScreen(en),
        'a reload re-ran detection over the reader\'s own choice — §26\'s narrowing forbids that');
    });

    await check('AND THE ASSERTION IS NOT VACUOUS — without the root class both languages show', async () => {
      const p2 = await ctx.newPage();
      await p2.goto(`http://127.0.0.1:${PORT}/s/${CODE}`, { waitUntil: 'domcontentloaded' });
      await p2.evaluate(() => { document.documentElement.className = ''; });
      const en = await p2.evaluate(boxOf, EN_OK);
      const cn = await p2.evaluate(boxOf, CN_OK);
      assert.ok(onScreen(en) && onScreen(cn),
        'stripping the language class changed nothing, so the CSS switch this suite ' +
        'measures is not actually live and every check above proves nothing');
      await p2.close();
    });

    await check('a shop with no listings still puts its empty state on screen', async () => {
      const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
      db.prepare('DELETE FROM shop_listings WHERE shop_id = ?').run(shopId);
      const p3 = await ctx.newPage();
      await p3.goto(`http://127.0.0.1:${PORT}/s/${CODE}`, { waitUntil: 'domcontentloaded' });
      const b = await p3.evaluate(boxOf, 'No products yet.');
      assert.ok(onScreen(b), `the launch state renders nothing visible: ${JSON.stringify(b)}`);
      await p3.close();
    });

  } finally {
    await browser.close();
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})();
