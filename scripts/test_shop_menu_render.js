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
// Filler rows, in a second category, so the rendered page is taller than a
// phone. See seed() for why a page that does not scroll cannot test a rail.
const FILLER = [9973, 9974, 9975, 9976, 9977, 9978, 9979, 9980];
const CODE = 'RENDERAB';
const EN_OK = 'Render fixture latte', CN_OK = '测试渲染拿铁';
const EN_OUT = 'Render fixture bun',  CN_OUT = '测试渲染面包';

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

function cleanup() {
  // ORDERS FIRST. This suite now PLACES REAL ORDERS through the page — that is
  // the point of the basket checks — and those rows hold foreign keys into the
  // fixture products and store. Without this the teardown throws
  // SQLITE_CONSTRAINT_FOREIGNKEY and the crash buries whatever actually failed.
  const oids = db.prepare('SELECT id FROM retail_orders WHERE store_id = ?').all(LOC).map(r => r.id);
  if (oids.length) {
    const q = oids.map(() => '?').join(',');
    db.prepare(`DELETE FROM retail_stock_reservations WHERE order_id IN (${q})`).run(...oids);
    db.prepare(`DELETE FROM retail_order_items WHERE order_id IN (${q})`).run(...oids);
    db.prepare(`DELETE FROM retail_payments WHERE order_id IN (${q})`).run(...oids);
    db.prepare(`DELETE FROM retail_orders WHERE id IN (${q})`).run(...oids);
  }
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?)').run(P_OK, P_OUT);
  db.prepare(`DELETE FROM store_products WHERE id IN (${FILLER.map(() => '?').join(',')})`).run(...FILLER);
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
  // A SECOND CATEGORY AND ENOUGH ROWS THAT THE PAGE ACTUALLY SCROLLS. With the
  // two products above, a phone viewport holds the whole menu and window.scrollY
  // never leaves 0 — on which a rail that scrolls away and a rail that holds
  // still are indistinguishable, and the sticky checks below would pass on the
  // bug they exist to catch. They are in their own category so the rail has more
  // than one destination to jump to.
  const filler = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Ready to Eat')`);
  // DELIBERATELY UNEVEN NAMES. The alignment check below needs two cards side
  // by side whose names differ in height — one line against two — which is the
  // ordinary case on a real menu ("Almond Butter" beside "Maple Cinnamon Almond
  // Butter") and the one that made the price row read as broken. With names of
  // equal length the check passes on the bug.
  const FILLER_NAMES = [
    'Short one',
    'A deliberately much longer product name that wraps to two lines',
    'Short two',
    'Another very long product name here that also wraps onto two lines',
    'Short three', 'Short four', 'Short five', 'Short six',
  ];
  FILLER.forEach((id, i) => filler.run(id, FILLER_NAMES[i], `测试填充${i + 1}`, `__R-8${i}`, 20 + i));
  db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, ?, 'made_here', ?, ?)`);
  add.run(shopId, P_OK, 33, 1, 0);
  add.run(shopId, P_OUT, 18, 0, 1);   // switched off → the sold-out badge
  FILLER.forEach((id, i) => add.run(shopId, id, 20 + i, 1, 2 + i));
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
      // THE PRICE OF A NAMED PRODUCT, not whichever price happens to be first.
      // The fixture gained filler rows in a second category to make the page
      // scroll, and category order comes from the tenant's tree rather than from
      // this file — so `.pr` first-match silently became a filler's ¥20 and this
      // check failed on a page that was entirely correct.
      const price = await page.evaluate((name) => {
        const el = Array.from(document.querySelectorAll('*'))
          .find(e => e.children.length === 0 && e.textContent.trim() === name);
        if (!el) return null;
        // .it is the product card. The name sits in a .l-en span inside .t, so a
        // generic closest() stops at .t and never sees the price beside it.
        const card = el.closest('.it');
        const pr = card && card.querySelector('.pr');
        if (!pr) return null;
        const r = pr.getBoundingClientRect();
        return { w: r.width, h: r.height, text: pr.textContent.trim() };
      }, EN_OK);
      assert.ok(price && price.w > 0 && price.h > 0, `no price box: ${JSON.stringify(price)}`);
      assert.ok(/33/.test(price.text), `the price does not read as money: ${JSON.stringify(price)}`);
    });
    await check('nothing overflows the phone horizontally', async () => {
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth, win: window.innerWidth,
      }));
      assert.ok(over.doc <= over.win + 1, `the page scrolls sideways on a phone: ${JSON.stringify(over)}`);
    });

    // ─── The rail holds still ─────────────────────────────────────────────
    // Reported from a phone, 2026-09-06: "when i start scrolling product the
    // menu on the left is being scrolled". It was sticky and it WAS sticking —
    // at top:0, which is where the header already sits, so it pinned its first
    // category behind the bar and pushed its last one off the bottom. Nothing
    // short of measuring it while the page moves catches that: the CSS reads
    // correct, and both elements are honestly "stuck".
    await check('the rail stays put while the products scroll', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await page.evaluate(() => {
        const r = document.querySelector('.rail').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, y: window.scrollY };
      });
      await page.evaluate(() => window.scrollTo(0, 600));
      // One frame for the scroll to settle before the box is read.
      await page.evaluate(() => new Promise(r => window.requestAnimationFrame(
        () => window.requestAnimationFrame(r))));
      const after = await page.evaluate(() => {
        const r = document.querySelector('.rail').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, y: window.scrollY };
      });
      assert.ok(after.y > before.y + 300,
        `the page barely scrolled, so this proves nothing about a sticky rail: ${JSON.stringify(after)}`);
      assert.ok(Math.abs(after.top - before.top) <= 1,
        `the rail moved with the page: top ${before.top} → ${after.top}`);
    });

    await check('and it sits BELOW the header, not behind it', async () => {
      // The half that was actually broken. Sticky at the wrong offset is still
      // sticky, so the check above would have passed on the bug.
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.bar').getBoundingClientRect();
        const rail = document.querySelector('.rail').getBoundingClientRect();
        const first = document.querySelector('.rail a').getBoundingClientRect();
        return { barBottom: bar.bottom, railTop: rail.top, railBottom: rail.bottom,
                 firstTop: first.top, vh: window.innerHeight };
      });
      assert.ok(m.railTop >= m.barBottom - 1,
        `the rail starts above the bar's bottom edge, so its top is hidden: ${JSON.stringify(m)}`);
      assert.ok(m.firstTop >= m.barBottom - 1,
        `the FIRST category is behind the header — the reported symptom: ${JSON.stringify(m)}`);
      assert.ok(m.railBottom <= m.vh + 1,
        `the rail runs off the bottom of the screen, so its last category cannot be reached: ${JSON.stringify(m)}`);
    });

    await check('tapping a category lands its heading below the header, not under it', async () => {
      const heading = await page.evaluate(async () => {
        // NOT the first anchor: that is ALL, whose href is #top — a bare anchor
        // at the very top of the document, which correctly lands at 0 and would
        // fail this check while nothing is wrong. A real category is the subject.
        const a = document.querySelector('.rail a[data-cat]:not([href="#top"])');
        if (!a) return null;
        a.click();
        await new Promise(r => setTimeout(r, 400));
        const sec = document.getElementById(a.getAttribute('href').slice(1));
        if (!sec) return null;
        return {
          secTop: sec.getBoundingClientRect().top,
          barBottom: document.querySelector('.bar').getBoundingClientRect().bottom,
        };
      });
      assert.ok(heading, 'no rail category to tap');
      assert.ok(heading.secTop >= heading.barBottom - 1,
        `the section the customer asked for landed behind the header: ${JSON.stringify(heading)}`);
      await page.evaluate(() => window.scrollTo(0, 0));
    });

    // ─── The basket, driven ───────────────────────────────────────────────
    // Step 5b part 4. Everything here is a real tap on a real page against the
    // real endpoint: the order that comes out the far end is written to the
    // database by routes/shop-menu.js, not by a stub. A cart tested by reading
    // its markup would prove the buttons EXIST and nothing about what they do.
    await check('adding shows the bar, and the bar counts and totals', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const before = await page.evaluate(() => document.getElementById('cbar').hidden);
      assert.strictEqual(before, true, 'the basket bar is showing before anything is in it');
      await page.click('.it:not(.out) .add');
      const one = await page.evaluate(() => ({
        hidden: document.getElementById('cbar').hidden,
        n: document.getElementById('cbarN').textContent,
        v: document.getElementById('cbarV').textContent,
      }));
      assert.strictEqual(one.hidden, false, 'the bar did not appear');
      assert.strictEqual(one.n, '1');
      assert.ok(/\d/.test(one.v), `the bar shows no money: ${JSON.stringify(one)}`);
      await page.click('.it:not(.out) .add');
      const two = await page.evaluate(() => document.getElementById('cbarN').textContent);
      assert.strictEqual(two, '2', 'a second tap did not count');
    });

    await check('the add button sits BESIDE THE PRICE, not over the photo', async () => {
      // Reported from a phone, 2026-09-06, with the mini app beside it: the
      // button was on the photo's corner, covering the product it was offering
      // to add and sitting where this shop's own customers do not look for it.
      // Geometry rather than a class name — the whole complaint was about where
      // it is on the screen, and a class can be right while the box is wrong.
      const m = await page.evaluate(() => {
        const card = document.querySelector('.it:not(.out)');
        const b = card.querySelector('.add').getBoundingClientRect();
        const ph = card.querySelector('.ph').getBoundingClientRect();
        const pr = card.querySelector('.pr').getBoundingClientRect();
        return { bTop: b.top, bLeft: b.left, bRight: b.right,
                 phBottom: ph.bottom, phRight: ph.right,
                 prTop: pr.top, prBottom: pr.bottom, prRight: pr.right };
      });
      assert.ok(m.bTop >= m.phBottom - 1,
        `the add button is still over the photo: ${JSON.stringify(m)}`);
      // On the price's row, and to the right of it.
      assert.ok(m.bTop < m.prBottom && m.bRight > m.prRight,
        `the add button is not on the price row, right of the price: ${JSON.stringify(m)}`);
    });

    await check('the add button is the mini app\'s colours, not the page background', async () => {
      // An ink square with a lime glyph. Read off the computed style so a token
      // that stopped resolving shows up here rather than as an invisible button
      // on a customer's phone.
      const c = await page.evaluate(() => {
        const b = document.querySelector('.it:not(.out) .add');
        const cs = getComputedStyle(b);
        return { bg: cs.backgroundColor, fg: cs.color };
      });
      assert.ok(/^rgba?\(/.test(c.bg) && c.bg !== 'rgba(0, 0, 0, 0)',
        `the add button has no ground: ${JSON.stringify(c)}`);
      assert.notStrictEqual(c.bg, c.fg, 'the glyph is the same colour as its ground — an invisible +');
    });

    await check('two products side by side line their prices up', async () => {
      // Reported from a phone, 2026-09-06: "not align when there are 2 products
      // one next to each other". The names are rarely the same height, and with
      // the price row flowing straight after the name the two prices sat at
      // different levels. Measured across a real grid row rather than asserted
      // from the CSS — the fixture above supplies one short name and one that
      // wraps, which is the case that breaks it.
      const rows = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.grid .it'));
        const out = [];
        for (let i = 0; i + 1 < cards.length; i += 2) {
          const a = cards[i], b = cards[i + 1];
          // Same grid row only: cards that wrapped to the next row are not
          // expected to align with each other.
          if (Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) > 1) continue;
          const pa = a.querySelector('.pr').getBoundingClientRect();
          const pb = b.querySelector('.pr').getBoundingClientRect();
          // The TEXT's height, not the box's. The fix makes .t stretch to fill
          // the card, so both boxes are equal by construction and measuring
          // them would report every pair as even — the guard below would then
          // fire on a page that is entirely correct, which it did once.
          const na = a.querySelector('.t .l-en').getBoundingClientRect();
          const nb = b.querySelector('.t .l-en').getBoundingClientRect();
          out.push({ dPrice: Math.abs(pa.top - pb.top), dName: Math.abs(na.height - nb.height) });
        }
        return out;
      });
      assert.ok(rows.length, 'no side-by-side pair to measure');
      // The check is only meaningful over a pair whose names DIFFER in height.
      const uneven = rows.filter(r => r.dName > 4);
      assert.ok(uneven.length,
        'no pair has names of differing height, so this check proves nothing — the fixture regressed');
      for (const r of uneven) {
        assert.ok(r.dPrice <= 1,
          `two prices in one row are ${r.dPrice.toFixed(1)}px apart under names ${r.dName.toFixed(1)}px apart`);
      }
    });

    await check('the last row of products is not hidden under the bar', async () => {
      // The bar is fixed over the page. Without the floor it adds, the final
      // card sits underneath it and cannot be tapped — the same class of fault
      // as the rail, one element down.
      const m = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const cards = document.querySelectorAll('.it');
        const last = cards[cards.length - 1].getBoundingClientRect();
        const bar = document.getElementById('cbar').getBoundingClientRect();
        return { lastBottom: last.bottom, barTop: bar.top };
      });
      assert.ok(m.lastBottom <= m.barTop + 1,
        `the last product is underneath the basket bar: ${JSON.stringify(m)}`);
      await page.evaluate(() => window.scrollTo(0, 0));
    });

    await check('a sold-out product has no way to be added', async () => {
      const n = await page.evaluate(() => document.querySelectorAll('.it.out .add').length);
      assert.strictEqual(n, 0, 'a sold-out card carries an add button');
    });

    await check('the sheet lists the lines, and − and + really change them', async () => {
      await page.click('#cbarOpen');
      const open = await page.evaluate(() => document.getElementById('sheet').hidden);
      assert.strictEqual(open, false, 'the sheet did not open');
      const lines = await page.evaluate(() => document.querySelectorAll('#sheetB .ln').length);
      assert.strictEqual(lines, 1, 'two of one product should be ONE line, not two');
      await page.click('#sheetB .qty button[data-d]');
      const after = await page.evaluate(() => ({
        qty: document.querySelector('#sheetB .qty span').textContent,
        n: document.getElementById('cbarN').textContent,
      }));
      assert.strictEqual(after.qty, '1', 'minus did not decrement the line');
      assert.strictEqual(after.n, '1', 'the bar did not follow the sheet');
    });

    await check('taking the last one out empties the basket and closes the sheet', async () => {
      await page.click('#sheetB .qty button[data-d]');
      const m = await page.evaluate(() => ({
        sheet: document.getElementById('sheet').hidden,
        bar: document.getElementById('cbar').hidden,
      }));
      assert.strictEqual(m.bar, true, 'an empty basket still shows its bar');
      assert.strictEqual(m.sheet, true, 'an empty basket sheet stayed open over the menu');
    });

    await check('a nameless order is refused BEFORE it reaches the counter', async () => {
      await page.click('.it:not(.out) .add');
      await page.click('#cbarOpen');
      await page.click('#cPlace');
      const err = await page.evaluate(() => ({
        hidden: document.getElementById('cErr').hidden,
        placed: !!document.querySelector('.done'),
      }));
      assert.strictEqual(err.hidden, false, 'no name and no complaint');
      assert.strictEqual(err.placed, false, 'a nameless order went through');
    });

    await check('PLACING IT REALLY PLACES IT — a number comes back and a row is written', async () => {
      await page.fill('#cName', 'Mei');
      await page.click('#cPlace');
      await page.waitForSelector('.done-n', { timeout: 8000 });
      const shown = await page.evaluate(() => ({
        code: document.querySelector('.done-n').textContent.trim(),
        name: document.querySelector('.done-nm').textContent.trim(),
        bar: document.getElementById('cbar').hidden,
      }));
      assert.ok(/^\d+$/.test(shown.code), `the number is not a plain number: ${shown.code}`);
      assert.strictEqual(shown.name, 'Mei', 'the name the customer will be called by is not shown');
      assert.strictEqual(shown.bar, true, 'the basket survived the order that emptied it');
      // The half a screenshot cannot show: the order exists.
      const row = db.prepare(
        `SELECT recipient_name, status, channel, source, fulfillment_type, shop_order_code
           FROM retail_orders WHERE store_id = ? ORDER BY id DESC LIMIT 1`).get(LOC);
      assert.ok(row, 'the page said an order was placed and no order was written');
      assert.strictEqual(row.recipient_name, 'Mei');
      assert.strictEqual(row.status, 'pending_payment');
      assert.strictEqual(row.source, 'qr');
      assert.strictEqual(row.fulfillment_type, 'counter');
      assert.strictEqual(String(row.shop_order_code), shown.code,
        'the number on the phone is not the number in the database');
    });

    await check('both languages are in the basket, so the toggle still works on it', async () => {
      // The server-rendered half puts both languages in the DOM and lets CSS
      // choose (§26's narrowing). A cart that rendered only the current language
      // would silently break that for everything added after load — and it is
      // drawn by script, so nothing else would catch it.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.click('.it:not(.out) .add');
      await page.click('#cbarOpen');
      const m = await page.evaluate(() => {
        const ln = document.querySelector('#sheetB .ln .ln-t');
        return { en: ln.querySelectorAll('.l-en').length, cn: ln.querySelectorAll('.l-cn').length };
      });
      assert.ok(m.en === 1 && m.cn === 1,
        `a basket line carries one language only: ${JSON.stringify(m)}`);
      await page.click('#sheetX');
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
