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
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category,
     description_blocks, nutrition, image_data)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Drinks', ?, ?, ?)`);
  // A REAL IMAGE, because the detail sheet's photo — and the tap that enlarges
  // it — exist only for a product that has one. Without this the sheet renders
  // its empty frame and the enlarge cannot be driven at all.
  const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  // THE OFFICE'S REAL BLOCK ARRAY, not a stand-in. It carries three types the
  // sheet must IGNORE alongside the two it reads, a lead ingredient, a stated
  // percentage, and an allergen card whose CONTAINS and MAY CONTAIN differ —
  // which is the distinction the whole card exists for.
  const BLOCKS = JSON.stringify([
    { type: 'hero_intro', body_en: 'A marketing paragraph nobody at a counter wants.' },
    { type: 'why', claims: [{ claim_en: 'Neutral enough to go sweet or savory.' }] },
    { type: 'ingredients_chips', items: [
      { name_en: 'Coconut milk', name_cn: '椰奶', pct: 92, lead: true },
      { name_en: 'Natural starch', name_cn: '天然淀粉' },
      { name_en: 'Probiotics', name_cn: '益生菌' },
    ] },
    { type: 'allergen_card',
      contains_en: 'Coconut', contains_cn: '椰子',
      may_contain_en: 'Soy, Nuts, Gluten', may_contain_cn: '大豆、坚果、麸质' },
    { type: 'how_to_use', tiles: [{ label_en: 'Spoon it over oats' }] },
  ]);
  const NUTR = JSON.stringify({
    basis_en: 'per 100 g', basis_cn: '每100克',
    rows: [
      { label_en: 'Energy', label_cn: '能量', value: '612 kcal' },
      { label_en: 'Saturated', label_cn: '饱和脂肪', value: '4.2 g' },
      { label_en: 'Fibre', label_cn: '膳食纤维', value: '11 g' },
    ],
  });
  prod.run(P_OK, EN_OK, CN_OK, '__R-71', 33, BLOCKS, NUTR, PIXEL);
  prod.run(P_OUT, EN_OUT, CN_OUT, '__R-72', 18, BLOCKS, NUTR, PIXEL);
  // A SECOND CATEGORY AND ENOUGH ROWS THAT THE PAGE ACTUALLY SCROLLS. With the
  // two products above, a phone viewport holds the whole menu and window.scrollY
  // never leaves 0 — on which a rail that scrolls away and a rail that holds
  // still are indistinguishable, and the sticky checks below would pass on the
  // bug they exist to catch. They are in their own category so the rail has more
  // than one destination to jump to.
  //
  // 'Fresh & Deli' ON PURPOSE, not 'Ready to Eat': its SEED_TREE name_cn is
  // '鲜食 & 熟食' — a category with "&" in the Chinese half, which is what the
  // noOrphanAmp() check below needs on the rail.
  const filler = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Fresh & Deli')`);
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
  // The filler rows carry NO facts at all — they are the products that must not
  // become tappable, and the check below asserts exactly that.
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

    await check('EVERY RAIL TAB IS CENTRED, ALL INCLUDED', async () => {
      // Reported from a phone: ALL sat against the left edge while every
      // category below it was centred. It was the one tab whose label was a
      // bare text node rather than the flex:1 child between the two spacers,
      // so it had nothing to centre. Measured as the gap on each side of the
      // ink, because that is what the eye is comparing.
      const m = await page.evaluate(() => {
        const read = (a) => {
          const box = a.getBoundingClientRect();
          // The visible label, not the <a> — the <a> fills the rail either way.
          const lb = a.querySelector('.lb') || a;
          const vis = Array.from(lb.querySelectorAll('span'))
            .filter(el => getComputedStyle(el).display !== 'none');
          const t = (vis.length ? vis[0] : lb).getBoundingClientRect();
          return { left: t.left - box.left, right: box.right - t.right,
                   text: (vis.length ? vis[0] : lb).textContent.trim() };
        };
        const tabs = Array.from(document.querySelectorAll('.rail a'));
        return tabs.slice(0, 3).map(read);
      });
      assert.ok(m.length >= 2, 'the rail has too few tabs to compare');
      for (const t of m) {
        assert.ok(Math.abs(t.left - t.right) <= 2,
          `"${t.text}" is not centred in the rail: ${t.left} left, ${t.right} right`);
      }
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

    await check('a Chinese rail label does not strand "&" at the end of a line', async () => {
      // Reported from a phone: SEED_TREE's Fresh & Deli node wrapped in the
      // rail with "&" alone on the first line and 熟食 on the second —
      // noOrphanAmp() glues "&" to the word after it with a non-breaking space
      // so a wrap, if the label still needs one, lands BEFORE "&" instead.
      //
      // SCOPED TO THE RAIL, not the whole page: the same category name is
      // also a .kick heading in the wide content pane, where the narrow-rail
      // wrap this fix is for does not happen, and it is deliberately left as
      // plain text there — the unscoped page HTML legitimately contains both
      // forms. page.content() serialises the NBSP back out as the &nbsp;
      // entity (confirmed against this exact page: 鲜食 &amp;&nbsp;熟食), so
      // that is what the glued form is checked against, not a raw \u00a0.
      const html = await page.content();
      const rail = html.slice(html.indexOf('<nav class="rail"'), html.indexOf('</nav>'));
      assert.ok(rail, 'the rail markup is missing');
      assert.ok(rail.includes('鲜食 &amp;&nbsp;熟食'),
        'the rail\'s Chinese label does not carry the non-breaking space after "&"');
      assert.ok(!rail.includes('鲜食 &amp; 熟食'),
        'the rail\'s Chinese label still has a plain breakable space after "&"');
    });

    // ─── The basket, driven ───────────────────────────────────────────────
    // Step 5b part 4. Everything here is a real tap on a real page against the
    // real endpoint: the order that comes out the far end is written to the
    // database by routes/shop-menu.js, not by a stub. A cart tested by reading
    // its markup would prove the buttons EXIST and nothing about what they do.
    // ─── The product sheet, driven ────────────────────────────────────────
    await check('tapping a card opens its ingredients, allergens and nutrition', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click(`.it:not(.out)[data-open]`);
      const m = await page.evaluate(() => {
        const b = document.getElementById('dsheetB');
        return {
          open: !document.getElementById('dsheet').hidden,
          text: b.innerText,
          chips: Array.from(b.querySelectorAll('.ichip')).map(c => ({
            t: c.innerText.trim(), lead: c.className.includes('lead'),
          })),
          rows: Array.from(b.querySelectorAll('.nr')).map(r => r.className.replace('nr', '').trim()),
          price: document.getElementById('dPr').textContent.trim(),
        };
      });
      assert.strictEqual(m.open, true, 'the sheet did not open');
      // THE LEAD INGREDIENT IS THE FILLED ONE. That flag is the only thing the
      // office's chip block carries beyond the names, and it is why a customer
      // reads what the product is mostly made of first.
      assert.strictEqual(m.chips.length, 3, `ingredient chips: ${JSON.stringify(m.chips)}`);
      assert.ok(/Coconut milk/.test(m.chips[0].t), 'the lead ingredient is not first');
      assert.strictEqual(m.chips[0].lead, true, 'the lead ingredient is not marked');
      assert.strictEqual(m.chips[1].lead, false, 'every chip is marked as the lead');
      assert.ok(/92/.test(m.chips[0].t), 'a stated percentage was dropped');
      // The blocks also hold a marketing paragraph, a claim and a usage tile.
      // §44's sheet is for deciding whether you can eat something.
      for (const leak of ['marketing paragraph', 'Neutral enough', 'Spoon it over oats']) {
        assert.ok(!m.text.includes(leak), `the sheet leaked a block it should not draw: ${leak}`);
      }
      assert.deepStrictEqual(m.rows, ['p', 'c', ''], `nutrition rows classified wrong: ${m.rows}`);
      assert.ok(/\d/.test(m.price), `no price on the sheet: ${JSON.stringify(m.price)}`);
    });

    await check('the sheet price and ADD TO BASKET do not touch', async () => {
      // Reported from a phone: .dadd is .place, and .place's own width:100%
      // set the button's flex-basis to the whole row, so it fought #dPr for
      // space inside .tot's flex row and the two ran together with no visible
      // gap between the price and the button beside it.
      const r = await page.evaluate(() => {
        const pr = document.getElementById('dPr').getBoundingClientRect();
        const add = document.getElementById('dAdd').getBoundingClientRect();
        return { prRight: pr.right, addLeft: add.left };
      });
      assert.ok(r.addLeft - r.prRight >= 8,
        `the price and the button are ${(r.addLeft - r.prRight).toFixed(1)}px apart`);
    });

    await check('CONTAINS AND MAY-CONTAIN ARE TWO STATEMENTS, and they do not look alike', async () => {
      // The distinction a person with an allergy actually needs: what is IN the
      // food, against what the line it was made on also handles. An earlier
      // draft derived allergens from free_of — the filter tags — and would have
      // asserted an allergen nobody declared.
      const m = await page.evaluate(() => {
        const card = document.querySelector('#dsheetB .acard');
        if (!card) return null;
        // Scoped to one language, and the check right after this one is what
        // makes that safe. An earlier version of this file scoped here and
        // stopped there, having decided the unscoped read was picking up hidden
        // text — it was not: BOTH languages were visible, because a rule in
        // this sheet outweighed the language switch. Scoping to make a test
        // pass, without asking why the other language was there, is what let
        // that reach a customer's phone.
        const rows = Array.from(card.querySelectorAll('.arow')).map(r => ({
          label: r.querySelector('.alab').innerText.trim(),
          chips: Array.from(r.querySelectorAll('.l-en .achip')).map(c => c.textContent.trim()),
          cn: Array.from(r.querySelectorAll('.l-cn .achip')).map(c => c.textContent.trim()),
          kinds: Array.from(r.querySelectorAll('.l-en .achip')).map(c => c.className.includes('has') ? 'has' : 'may'),
        }));
        const has = card.querySelector('.l-en .achip.has'), may = card.querySelector('.l-en .achip.may');
        return { title: card.querySelector('.atitle').innerText.trim(), rows,
                 hasBg: has && getComputedStyle(has).backgroundColor,
                 mayBg: may && getComputedStyle(may).backgroundColor,
                 mayBorder: may && getComputedStyle(may).borderTopStyle };
      });
      assert.ok(m, 'the allergen card is missing');
      assert.ok(/Allergen/i.test(m.title), `the card is not titled: ${m.title}`);
      assert.strictEqual(m.rows.length, 2, `contains and may-contain are two rows: ${JSON.stringify(m.rows)}`);
      assert.deepStrictEqual(m.rows[0].chips, ['Coconut']);
      assert.deepStrictEqual(m.rows[1].chips, ['Soy', 'Nuts', 'Gluten']);
      assert.deepStrictEqual(m.rows[0].kinds, ['has'], 'the contains row is not marked as contains');
      assert.deepStrictEqual(m.rows[1].kinds, ['may', 'may', 'may'], 'a may-contain chip reads as contains');
      // And the Chinese half is really there, split on its own separators —
      // the office types 大豆、坚果、麸质 with CJK commas, not ASCII ones.
      assert.deepStrictEqual(m.rows[0].cn, ['椰子']);
      assert.deepStrictEqual(m.rows[1].cn, ['大豆', '坚果', '麸质'],
        'the Chinese list was not split on its own separators');
      // They must not merge visually — that is the whole reason the card exists.
      assert.notStrictEqual(m.hasBg, m.mayBg, 'the two allergen kinds look identical');
      assert.strictEqual(m.mayBorder, 'dashed');
    });

    await check('the allergen chips are centred in their column, not left against it', async () => {
      // Reported from a phone: a single "Gluten (oats)" chip floated in the gap
      // between a short label and the middle of the card, aligned to nothing.
      const m = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#dsheetB .arow'));
        return rows.map(r => {
          const col = r.querySelector('.achips').getBoundingClientRect();
          const chips = Array.from(r.querySelectorAll('.achips span'))
            .filter(el => el.getBoundingClientRect().width > 0);
          if (!chips.length) return null;
          const boxes = chips.map(c => c.getBoundingClientRect());
          const left = Math.min(...boxes.map(b => b.left));
          const right = Math.max(...boxes.map(b => b.right));
          const lab = r.querySelector('.alab').getBoundingClientRect();
          return { pad: (left - col.left) - (col.right - right),
                   n: chips.length,
                   // And the label sits level with them rather than riding high.
                   dy: ((lab.top + lab.bottom) / 2) - ((col.top + col.bottom) / 2) };
        }).filter(Boolean);
      });
      assert.ok(m.length >= 2, `the allergen card has too few rows to measure: ${m.length}`);
      for (const r of m) {
        assert.ok(Math.abs(r.pad) <= 2,
          `a row of ${r.n} chip(s) is off centre by ${r.pad}px`);
        assert.ok(Math.abs(r.dy) <= 2,
          `the label rides ${r.dy}px off the chips it belongs to`);
      }
    });

    await check('tapping the photo enlarges it, and asks for a BIGGER render', async () => {
      const src = await page.evaluate(async () => {
        document.querySelector('#dsheetB .dt-ph[data-big]').click();
        await new Promise(r => setTimeout(r, 60));
        return { hidden: document.getElementById('big').hidden,
                 src: document.getElementById('bigImg').getAttribute('src') };
      });
      assert.strictEqual(src.hidden, false, 'the enlarge did not open');
      assert.ok(/\/i\/\d+\?/.test(src.src), `the enlarge points somewhere odd: ${src.src}`);
      const w = /[?&]w=(\d+)/.exec(src.src);
      assert.ok(w && Number(w[1]) > 320,
        `the enlarge re-uses the thumbnail width, so it is not bigger: ${src.src}`);
      // And it closes on the next tap anywhere.
      const shut = await page.evaluate(async () => {
        document.getElementById('big').click();
        await new Promise(r => setTimeout(r, 60));
        return document.getElementById('big').hidden;
      });
      assert.strictEqual(shut, true, 'the enlarge would not close');
    });

    await check('Add from the sheet puts it in the basket, once', async () => {
      const m = await page.evaluate(async () => {
        document.getElementById('dAdd').click();
        // Past the 140ms close animation — the sheet is only [hidden] once its
        // travel has played, so a 60ms read here caught it mid-slide.
        await new Promise(r => setTimeout(r, 260));
        return { n: document.getElementById('cbarN').textContent,
                 sheet: document.getElementById('dsheet').hidden };
      });
      assert.strictEqual(m.n, '1', `Add from the sheet counted ${m.n}`);
      assert.strictEqual(m.sheet, true, 'the sheet stayed open over the basket bar');
      await page.reload({ waitUntil: 'domcontentloaded' });
    });

    await check('a product with nothing to say is NOT tappable', async () => {
      // The filler rows carry no blocks, no nutrition and no allergen card. A
      // sheet for them would be an empty panel, which is worse than a card that
      // does not respond — so the whole apparatus is absent rather than empty.
      const m = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.it'));
        const withDt = cards.filter(c => c.hasAttribute('data-open')).length;
        const withTpl = cards.filter(c => c.querySelector('template[data-dt]')).length;
        return { total: cards.length, withDt, withTpl };
      });
      assert.ok(m.total > m.withDt,
        'every card is tappable, so the factless case is not being excluded');
      assert.strictEqual(m.withDt, m.withTpl, 'a card is tappable but carries no sheet body');
      assert.strictEqual(m.withDt, 2, `only the two real products carry blocks: ${JSON.stringify(m)}`);
    });

    await check('IN ENGLISH, NOTHING CHINESE IS ON SCREEN — anywhere in the sheet', async () => {
      // Reported from a phone: the allergen card showed "Gluten (oats)" and
      // 麸质（燕麦）together. The sheet set display:contents on .l-cn at the
      // same specificity as the language switch and later in the stylesheet,
      // so it won. Measured as VISIBILITY rather than presence — both languages
      // are in the DOM by design, and a check that only counted them passed
      // over the bug for a whole release.
      await page.click('.it:not(.out)[data-open]');
      const m = await page.evaluate(() => {
        const b = document.getElementById('dsheetB');
        const shown = [];
        b.querySelectorAll('.l-cn').forEach(el => {
          if (getComputedStyle(el).display !== 'none') shown.push(el.textContent.trim().slice(0, 24));
        });
        const en = [];
        b.querySelectorAll('.l-en').forEach(el => {
          if (getComputedStyle(el).display !== 'none') en.push(el.textContent.trim().slice(0, 24));
        });
        return { shown, en, cjk: /[一-鿿]/.test(b.innerText) };
      });
      assert.deepStrictEqual(m.shown, [],
        `Chinese is rendered in the English sheet: ${JSON.stringify(m.shown)}`);
      assert.ok(m.en.length > 0, 'the English half is not rendering either — the sheet is empty');
    });

    await check('...and in Chinese, nothing English is', async () => {
      // THE TOGGLE IS SWITCHED BEFORE THE SHEET IS OPENED, and that is a fact
      // about the page rather than a convenience here: the sheet's backdrop
      // covers the header, so EN/中 cannot be reached while a product is open.
      // A customer closes the sheet, switches, and opens it again. Recorded
      // because the first version tapped the toggle through the backdrop and
      // hung waiting for it to become clickable.
      await page.click('#dsheetX');
      await page.click('[data-lang="cn"]');
      await page.click('.it:not(.out)[data-open]');
      const shown = await page.evaluate(() => {
        const out = [];
        document.getElementById('dsheetB').querySelectorAll('.l-en').forEach(el => {
          if (getComputedStyle(el).display !== 'none') out.push(el.textContent.trim().slice(0, 24));
        });
        return out;
      });
      assert.deepStrictEqual(shown, [],
        `English is rendered in the Chinese sheet: ${JSON.stringify(shown)}`);
      // Same fact on the way back: close first, THEN switch. Tapping the
      // toggle with the sheet open hung this suite for thirty seconds.
      await page.click('#dsheetX');
      await page.click('[data-lang="en"]');
    });

    await check('the enlarge closes on its own button, not only on a delegated tap', async () => {
      // Reported from a phone: no way out of the full-screen photo but leaving
      // the menu. It closed on a document-level tap, which passed here and did
      // not work in the WeChat web view. The button is bound directly.
      await page.click('.it:not(.out)[data-open]');
      await page.click('#dsheetB .dt-ph[data-big]');
      const open = await page.evaluate(() => !document.getElementById('big').hidden);
      assert.strictEqual(open, true, 'the enlarge did not open');
      const hasBtn = await page.evaluate(() => {
        const b = document.getElementById('bigX');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { w: r.width, h: r.height, label: b.getAttribute('aria-label') };
      });
      assert.ok(hasBtn, 'the enlarge has no close button at all');
      // A 44px target is the smallest a thumb finds reliably.
      assert.ok(hasBtn.w >= 40 && hasBtn.h >= 40, `the close button is too small: ${JSON.stringify(hasBtn)}`);
      // AND IT SITS ON THE PHOTO'S OWN MARGIN, not jammed into the corner. The
      // overlay pads its photo by 16px; the button's outer edge lines up with
      // that rather than choosing an inset of its own. Reported as "not
      // positioned nice" at 10px, where it hugged the screen edge.
      const inset = await page.evaluate(() => {
        const r = document.getElementById('bigX').getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(document.getElementById('big')).paddingRight);
        return { right: window.innerWidth - r.right, top: r.top, pad };
      });
      assert.strictEqual(inset.right, inset.pad,
        `the × is ${inset.right}px from the edge but the photo is ${inset.pad}px`);
      assert.strictEqual(inset.top, inset.pad,
        `the × is ${inset.top}px from the top but the photo is ${inset.pad}px`);
      // AND THE MARK IS CENTRED IN THE SQUARE. Reported from a phone: the ×
      // sat above the middle of the button. It was a glyph, placed by the
      // font's metrics rather than by its ink; it is now two bars, whose centre
      // is where the arithmetic puts it. Measured on BOTH close buttons,
      // because they share the mark and would drift apart otherwise.
      const marks = await page.evaluate(() => {
        return ['bigX', 'dsheetX'].map(id => {
          const b = document.getElementById(id);
          const box = b.getBoundingClientRect();
          const bars = Array.from(b.querySelectorAll('.xb')).map(el => el.getBoundingClientRect());
          if (bars.length !== 2) return { id, bars: bars.length };
          const cx = (Math.min(...bars.map(r => r.left)) + Math.max(...bars.map(r => r.right))) / 2;
          const cy = (Math.min(...bars.map(r => r.top)) + Math.max(...bars.map(r => r.bottom))) / 2;
          return { id, bars: 2,
                   dx: cx - (box.left + box.right) / 2,
                   dy: cy - (box.top + box.bottom) / 2,
                   // And it really is a cross, not two bars lying on each other.
                   spread: Math.max(...bars.map(r => r.height)) };
        });
      });
      for (const k of marks) {
        assert.strictEqual(k.bars, 2, `${k.id} does not draw its mark as two bars`);
        assert.ok(Math.abs(k.dx) <= 1, `${k.id}'s mark is ${k.dx}px off centre across`);
        assert.ok(Math.abs(k.dy) <= 1, `${k.id}'s mark is ${k.dy}px off centre down`);
        assert.ok(k.spread > 4, `${k.id}'s bars are not crossed: ${k.spread}px tall`);
      }
      await page.click('#bigX');
      const shut = await page.evaluate(() => ({
        big: document.getElementById('big').hidden,
        sheet: document.getElementById('dsheet').hidden,
      }));
      assert.strictEqual(shut.big, true, 'the close button did not close the enlarge');
      // And it returns to the sheet rather than dumping the customer on the menu.
      assert.strictEqual(shut.sheet, false, 'closing the photo also closed the product sheet');
      await page.click('#dsheetX');
    });

    await check('the sheet arrives and leaves with movement, and reduced motion turns both off', async () => {
      // Reported from a phone: the panel appeared with no travel and read as
      // the page having jumped. Both directions are measured, because the
      // closing keyframes shipped once with no script to add the class that
      // drives them — dead CSS that no check would have noticed.
      await page.click('.it:not(.out)[data-open]');
      const anim = await page.evaluate(() => {
        const p = document.querySelector('#dsheet .sheet-p');
        return getComputedStyle(p).animationName;
      });
      assert.notStrictEqual(anim, 'none', 'the sheet has no open animation');
      const out = await page.evaluate(async () => {
        document.getElementById('dsheetX').click();
        // Read INSIDE the 140ms travel: the panel is still on screen, and the
        // class that plays it away is what proves the close is not a snap.
        await new Promise(r => setTimeout(r, 40));
        const sh = document.getElementById('dsheet');
        return { cls: sh.className, hidden: sh.hidden,
                 anim: getComputedStyle(sh.querySelector('.sheet-p')).animationName };
      });
      assert.strictEqual(out.hidden, false, 'the sheet was hidden mid-travel, so nothing was seen');
      assert.ok(/closing/.test(out.cls), `the closing class is never added: ${out.cls}`);
      assert.strictEqual(out.anim, 'shOut', `the sheet snaps shut instead of sliding: ${out.anim}`);
      // THE STYLESHEET'S DURATION AND THE SCRIPT'S TIMER ARE ONE NUMBER. The
      // panel is only [hidden] once the travel has played, so a timer shorter
      // than the keyframes would cut the slide off half way and nobody would
      // see the second half. Measured against the duration the browser reports,
      // so slowing the animation cannot silently outrun the timer.
      await page.evaluate(async () => { await new Promise(r => setTimeout(r, 300)); });
      await page.click('.it:not(.out)[data-open]');
      const paced = await page.evaluate(async () => {
        const sh = document.getElementById('dsheet');
        const t0 = Date.now();
        document.getElementById('dsheetX').click();
        // Read AFTER the click: while the sheet is open the panel is wearing
        // the opening keyframes, and it is the closing pair being paced here.
        const dur = parseFloat(getComputedStyle(sh.querySelector('.sheet-p')).animationDuration) * 1000;
        while (!sh.hidden && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 8));
        return { dur, took: Date.now() - t0, hidden: sh.hidden };
      });
      assert.strictEqual(paced.hidden, true, 'the sheet never finished its close');
      assert.ok(paced.took + 40 >= paced.dur,
        `the panel was hidden after ${paced.took}ms of a ${paced.dur}ms slide, so it was cut off`);
      const gone = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 260));
        const sh = document.getElementById('dsheet');
        return { hidden: sh.hidden, cls: sh.className };
      });
      assert.strictEqual(gone.hidden, true, 'the sheet never finished closing');
      assert.strictEqual(gone.cls, 'sheet', `the closing class was left behind: ${gone.cls}`);
      const reduced = await page.context().newPage();
      await reduced.emulateMedia({ reducedMotion: 'reduce' });
      await reduced.goto(`http://127.0.0.1:${PORT}/s/${CODE}`, { waitUntil: 'domcontentloaded' });
      await reduced.click('.it:not(.out)[data-open]');
      const off = await reduced.evaluate(() => {
        const p = document.querySelector('#dsheet .sheet-p');
        return { anim: getComputedStyle(p).animationName, open: !document.getElementById('dsheet').hidden };
      });
      assert.strictEqual(off.anim, 'none',
        'a customer who asked their phone to stop animating still gets the slide');
      assert.strictEqual(off.open, true, 'reduced motion stopped the sheet opening at all');
      // And they do not wait 140ms for a travel they are not being shown.
      const offShut = await reduced.evaluate(() => {
        document.getElementById('dsheetX').click();
        return document.getElementById('dsheet').hidden;
      });
      assert.strictEqual(offShut, true,
        'reduced motion still holds the panel open for an animation it is not playing');
      await reduced.close();
    });

    await check('adding throws the product at the basket, and clears up after itself', async () => {
      // Asked for: the mini app's feedback. A count changing at the bottom edge
      // of a phone is easy to miss with a thumb over it, so the product itself
      // travels there. Measured rather than eyeballed, because a clone left
      // pinned over the menu is the failure mode nobody would report as an
      // animation bug — they would report the menu as broken.
      await page.evaluate(() => window.scrollTo(0, 0));
      const m = await page.evaluate(async () => {
        // A card WITH a photo: there is nothing to throw for a product nobody
        // has photographed, and fly() correctly declines rather than throwing
        // an empty box across the screen.
        const card = Array.from(document.querySelectorAll('.it:not(.out)'))
          .find(c => c.querySelector('.ph img') && c.querySelector('.add'));
        if (!card) return { flew: false, why: 'no photographed product in the fixture' };
        // On screen first: fly() declines for a card that is scrolled out of
        // view, and that is the right behaviour — a photo sailing in from
        // somewhere the customer was not looking explains nothing.
        card.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 60));
        const btn = card.querySelector('.add');
        const photo = card.querySelector('.ph img').getBoundingClientRect();
        btn.click();
        const f = document.querySelector('.fly');
        if (!f) return { flew: false };
        const start = f.getBoundingClientRect();
        const target = document.getElementById('cbarN').getBoundingClientRect();
        await new Promise(r => setTimeout(r, 60));
        const moving = getComputedStyle(f).transform;
        return { flew: true,
                 // It starts on the card's own photo, at its size.
                 dx: Math.abs(start.left - photo.left), dy: Math.abs(start.top - photo.top),
                 dw: Math.abs(start.width - photo.width),
                 // It is aimed at the basket count, which is BELOW and to the RIGHT.
                 down: target.top > photo.top, moving,
                 img: /url\(/.test(getComputedStyle(f).backgroundImage) };
      });
      assert.strictEqual(m.flew, true,
        `adding drew nothing — the product does not travel${m.why ? ' (' + m.why + ')' : ''}`);
      assert.ok(m.dx <= 1 && m.dy <= 1, `the flight starts off the photo: ${m.dx},${m.dy}`);
      assert.ok(m.dw <= 1, `the flight starts at the wrong size: ${m.dw}px out`);
      assert.strictEqual(m.img, true, 'the thing thrown is not the product photo');
      assert.strictEqual(m.down, true, 'the basket count is not below the card being added');
      assert.notStrictEqual(m.moving, 'none', 'the clone was created but never moved');
      // AND IT IS GONE AFTERWARDS. A photo left pinned over the menu reads as
      // the page having broken, not as an animation that overstayed.
      const left = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 900));
        return document.querySelectorAll('.fly').length;
      });
      assert.strictEqual(left, 0, `${left} flown photo(s) still pinned over the menu`);
      // This check put a product in the basket to watch it fly. Hand the page
      // back empty, or every basket check after it counts one line too many.
      await page.reload({ waitUntil: 'domcontentloaded' });
    });

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

    await check('the card is public/shop.html\'s .sl-* card, measured against it', async () => {
      // Reported from a phone twice — "the + is too big", then "the price is too
      // big", then "use the same colors, fonts size, position, exactly".
      //
      // THE WEBSITE IS THE SOURCE FOR EVERYTHING HERE EXCEPT PRICE SIZE. Both
      // are the same design by the same house, but the website's half is
      // already in CSS pixels for a browser and this is a browser page, so
      // name/plus/gap/gridGap are read out of public/shop.html rather than
      // converted, and the two cannot drift apart silently.
      //
      // PRICE IS THE ONE DELIBERATE EXCEPTION, on Ash's direction: the
      // website's 16px still read as too big next to this page's chunky
      // Lilita-One digit substitute, so .pr now matches the MINI APP's
      // .card .price instead — read out of shop.wxss and converted at this
      // file's own 390/750 phone-width ratio (routes/shop-menu.js's .pr
      // comment carries the same number and the same reasoning).
      const html = require('fs').readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
      const ruleOf = (sel) => {
        const i = html.indexOf(sel + '{');
        return i < 0 ? null : html.slice(i + sel.length + 1, html.indexOf('}', i));
      };
      const num = (rule, prop) => {
        const m = rule && new RegExp(prop + ':\\s*([\\d.]+)px').exec(rule);
        return m ? Number(m[1]) : null;
      };
      const cn    = ruleOf('.sl-card .cn');
      const plus  = ruleOf('.sl-plus');
      const foot  = ruleOf('.sl-cfoot');
      const grid  = ruleOf('.sl-grid');
      assert.ok(cn && plus && foot && grid,
        'the .sl-* card rules have moved in public/shop.html — this check cannot see them');

      const wxss = require('fs').readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxss'), 'utf8');
      const miniRuleOf = (sel) => {
        const m = new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}').exec(wxss);
        return m ? m[1] : null;
      };
      const miniPrice = miniRuleOf('.card .price');
      const miniPriceRpx = (() => {
        const m = miniPrice && /calc\(\s*([\d.]+)rpx/.exec(miniPrice);
        return m ? Number(m[1]) : null;
      })();
      assert.ok(miniPriceRpx > 0,
        'the mini app .card .price rule has moved in shop.wxss — this check cannot see it');

      const want = {
        name:  num(cn, 'font-size'),
        plus:  num(plus, 'width'),
        gap:   num(foot, 'gap'),
        gridGap: num(grid, 'gap'),
      };
      assert.ok(Object.values(want).every(v => v > 0),
        `could not read every value: ${JSON.stringify(want)}`);
      const wantPrice = Math.round(miniPriceRpx * (390 / 750) * 10) / 10;

      const got = await page.evaluate(() => {
        const card = document.querySelector('.it:not(.out)');
        const cs = (el) => getComputedStyle(el);
        return {
          name:  parseFloat(cs(card.querySelector('.t')).fontSize),
          price: parseFloat(cs(card.querySelector('.pr')).fontSize),
          plus:  card.querySelector('.add').getBoundingClientRect().width,
          gap:   parseFloat(cs(card.querySelector('.pf')).columnGap),
          gridGap: parseFloat(cs(document.querySelector('.grid')).rowGap),
          tracking: cs(card.querySelector('.pr')).letterSpacing,
          nameColour:  cs(card.querySelector('.t')).color,
          priceColour: cs(card.querySelector('.pr')).color,
        };
      });
      for (const k of Object.keys(want)) {
        assert.ok(Math.abs(got[k] - want[k]) <= 0.5,
          `${k} is ${got[k]}px against the website's ${want[k]}px`);
      }
      assert.ok(Math.abs(got.price - wantPrice) <= 0.5,
        `price is ${got.price}px against the mini app's ${wantPrice}px`);
      // .sl-pr carries letter-spacing:.04em and .sl-card .cn does not.
      assert.ok(parseFloat(got.tracking) > 0, `the price lost its tracking: ${got.tracking}`);
      // BOTH are color:var(--ink) on the website — .sl-card .cn says so
      // explicitly and .sl-pr says so explicitly. A theme that resolved one and
      // not the other would show up here rather than on a customer's phone.
      assert.strictEqual(got.priceColour, got.nameColour,
        `the price and the name are different colours: ${got.priceColour} vs ${got.nameColour}`);
      assert.ok(/^rgba?\(/.test(got.priceColour) && got.priceColour !== 'rgba(0, 0, 0, 0)',
        `the price has no resolved colour: ${got.priceColour}`);
    });

    await check('the + is two bars and both are actually drawn', async () => {
      // The wxss records why: the brand serif's "+" sits off-centre in the
      // square and flex-centring cannot fix it, because it centres the text
      // line box rather than the ink. Borrowed with its reason — so the bars
      // have to be real, and a pseudo-element that collapsed to nothing would
      // leave a blank chip that still passes every colour and size check.
      const bars = await page.evaluate(() => {
        const b = document.querySelector('.it:not(.out) .add');
        const rd = (which) => {
          const cs = getComputedStyle(b, which);
          return { w: parseFloat(cs.width), h: parseFloat(cs.height), c: cs.content };
        };
        return { before: rd('::before'), after: rd('::after'),
                 fontSize: parseFloat(getComputedStyle(b).fontSize) };
      });
      assert.ok(bars.before.w > 4 && bars.before.h > 0.5,
        `the horizontal bar is not drawn: ${JSON.stringify(bars.before)}`);
      assert.ok(bars.after.h > 4 && bars.after.w > 0.5,
        `the vertical bar is not drawn: ${JSON.stringify(bars.after)}`);
      assert.ok(bars.before.w > bars.before.h, 'the horizontal bar is not horizontal');
      assert.ok(bars.after.h > bars.after.w, 'the vertical bar is not vertical');
      assert.strictEqual(bars.fontSize, 0,
        'a text glyph is still being rendered alongside the bars — it will sit off-centre');
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
      const m = await page.evaluate(async () => {
        // The basket slides away like the product sheet does; read after it.
        await new Promise(r => setTimeout(r, 260));
        return {
          sheet: document.getElementById('sheet').hidden,
          bar: document.getElementById('cbar').hidden,
        };
      });
      assert.strictEqual(m.bar, true, 'an empty basket still shows its bar');
      assert.strictEqual(m.sheet, true, 'an empty basket sheet stayed open over the menu');
    });

    await check('the basket header shows the × and nothing else', async () => {
      // Reported from a phone: a stray "Cancel" box beside the ×. bi() had been
      // dropped into an aria-label, which closed the attribute and spilled its
      // markup into the header. Measured on screen, because the page still
      // parsed and the server-side check alone would not show what a customer
      // actually saw.
      await page.click('.it:not(.out) .add');
      await page.click('#cbarOpen');
      const head = await page.evaluate(() => {
        const h = document.querySelector('.sheet-h');
        const strays = Array.from(h.childNodes)
          .filter(n => n.nodeType === 3 && n.textContent.trim())
          .map(n => n.textContent.trim());
        return { text: h.innerText.replace(/\s+/g, ' ').trim(), strays };
      });
      assert.deepStrictEqual(head.strays, [], `loose text in the sheet header: ${JSON.stringify(head.strays)}`);
      assert.ok(!/Cancel|取消/.test(head.text),
        `the close button's label is being drawn, not just read: ${JSON.stringify(head.text)}`);
    });

    await check('the name field wears the shop\'s focus ring, not the browser\'s', async () => {
      // Reported from a phone as an orange frame. Left alone the WeChat/Android
      // web view paints its own; this asserts the page draws one, so the
      // default can never be what the customer sees.
      const ring = await page.evaluate(() => {
        const el = document.getElementById('cName');
        el.focus();
        const cs = getComputedStyle(el);
        return { style: cs.outlineStyle, width: cs.outlineWidth, colour: cs.outlineColor,
                 border: cs.borderTopColor, focused: document.activeElement === el };
      });
      assert.ok(ring.focused, 'the field did not take focus');
      assert.notStrictEqual(ring.style, 'none', 'the page draws no focus ring, so the browser draws its own');
      assert.ok(parseFloat(ring.width) > 0, `the focus ring has no width: ${ring.width}`);
      // Ours is the tenant's ink — the same token the border uses.
      assert.strictEqual(ring.colour, ring.border,
        `the focus ring is not the field's own ink: ${ring.colour} vs ${ring.border}`);
      // Hand the next check a clean page. These two opened the sheet and left a
      // line in the basket; the basket lives in memory, so a reload empties it.
      // Without this the next check's first tap lands on the open sheet's
      // backdrop and it fails for a reason that has nothing to do with it.
      await page.reload({ waitUntil: 'domcontentloaded' });
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
