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
// §120's picker: a drink that ASKS, and the stock-backed extra one of its
// answers promises. The extra is never listed on the menu — it is a thing on a
// shelf, not a thing on sale here — so it needs no listing row, only stock.
const P_ASK = 9991, A_EXT = 9992;
/* §129's sizes. TWO SIBLINGS IN ONE GROUP, and the group id IS the first one's
   product id — that is what makes it the group OWNER, which is the member the
   collapse picks as the card. The second is listed with a HIGHER price and a
   LOWER variant_sort, so the checks can tell "the operator's order" apart from
   "cheapest first" and from "lowest id first"; three orderings that agree on a
   tidy fixture prove nothing about which one the code actually used. */
const P_V1 = 9995, P_V2 = 9996;
const EN_VAR = 'Render fixture jar';
const EN_ASK = 'Render fixture asker';
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
  db.prepare(
    `DELETE FROM retail_product_option_choices
      WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`
  ).run(P_ASK);
  db.prepare('DELETE FROM retail_product_options WHERE product_id = ?').run(P_ASK);
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?)').run(P_ASK, A_EXT);
  db.prepare('DELETE FROM store_products WHERE id IN (?, ?)').run(P_V1, P_V2);
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
    /* §132 — THE ORDER OF THIS ARRAY IS PART OF THE FIXTURE. The page renders
       blocks in the office's order, so spec_strip first and notes last is what
       the checks below assert against; shuffling these lines changes what they
       mean. */
    { type: 'spec_strip', cells: [
      { k_en: 'Product type', k_cn: '产品类型', v_en: 'Cultured', v_cn: '发酵' },
      { k_en: 'Net weight', k_cn: '净含量', v_en: '250 g', v_cn: '250 克' },
      { k_en: 'Origin', k_cn: '产地', v_en: 'Guangzhou', v_cn: '广州' },
    ] },
    /* THE BODY HAS A BLANK LINE IN IT AND A HIGHLIGHT PHRASE INSIDE IT. Both
       are what the office actually writes and both were being dropped: the
       blank line because .dt-pb had no white-space:pre-line, and the phrase
       because the reader treated `highlight` only as a kicker fallback and
       never marked it inline. The Chinese body deliberately does NOT contain
       its phrase, so the per-language fork is exercised in both directions. */
    { type: 'hero_intro', kicker_en: 'The story', kicker_cn: '故事',
      body_en: 'A marketing paragraph, straightforward and satisfying, nobody at a counter wants.\n\nA second paragraph after a blank line.',
      body_cn: '一段没人想读的文案。\n\n空行之后的第二段。',
      highlight_en: 'straightforward and satisfying',
      highlight_cn: '这句话不在正文里' },
    /* THE EDITOR'S OWN SHAPE, rows[{claim_en,claim_cn}]. The earlier fixture
       said `claims:`, which is neither of the two shapes the office actually
       saves — so it was dropped by the reader and the check that asserted it
       was not drawn passed for a reason that had nothing to do with the rule
       it was testing. The legacy rows_en shape is covered on the jar below. */
    { type: 'why', rows: [
      { claim_en: 'Neutral enough to go sweet or savory.', claim_cn: '甜咸皆宜。' },
      { claim_en: 'Nothing on the label you cannot say.', claim_cn: '配料表没有生僻字。' },
    ] },
    { type: 'big_stat', stat: '92', claim_en: 'percent coconut', claim_cn: '椰子含量',
      sub_en: 'and the rest is culture.', sub_cn: '其余是菌种。' },
    { type: 'ingredients_chips', items: [
      { name_en: 'Coconut milk', name_cn: '椰奶', pct: 92, lead: true },
      { name_en: 'Natural starch', name_cn: '天然淀粉' },
      { name_en: 'Probiotics', name_cn: '益生菌' },
    ] },
    { type: 'allergen_card',
      // COPIED FROM PRODUCTION, brackets and all. The reported defect only
      // appears when a chip's text ENDS in a full-width bracket — that is the
      // character that reserves a whole cell and draws in half of it — so a
      // fixture without one cannot see the bug. "Gluten (oats)" / 麸质（燕麦）
      // is the office's own pair, read off the live menu, not composed here.
      contains_en: 'Gluten (oats)', contains_cn: '麸质（燕麦）',
      may_contain_en: 'Soy, Nuts, Gluten', may_contain_cn: '大豆、坚果、麸质' },
    /* ONE TILE CARRIES A RASHER OF BACON, and that is the point of it. The
       office picks icons from a general-purpose set and this is a plant-based
       brand, so the component keeps a swap table; a reader that copied every
       other line and dropped that one would put meat on the menu of a shop
       that does not sell it. 🥓 must come out as 🌱. */
    { type: 'how_to_use', tiles: [
      { icon: '🥓', label_en: 'Spoon it over oats', label_cn: '拌进燕麦',
        sub_en: 'breakfast', sub_cn: '早餐' },
      { icon: '🥘', label_en: 'Stir through soup', label_cn: '拌入汤里' },
      { label_en: 'Straight from the tub', label_cn: '直接吃' },
    ] },
    /* THE RIGHT-HAND CARD HAS NO FIGURE, only a phrase, which is the case the
       component promotes into the hero slot; and the left-hand caption repeats
       the scale the figure already carries, which it strips. Both behaviours
       are asserted below, because both are silent when they stop working. */
    { type: 'storage_box',
      left:  { icon: '❄️', head_en: 'Fridge', head_cn: '冷藏',
               num_en: '0–4°', num_cn: '0–4°', unit_en: '°C at all times', unit_cn: '℃ 全程' },
      right: { alt: true, head_en: 'Once open', head_cn: '开封后',
               unit_en: 'Cool, dry place', unit_cn: '阴凉干燥处' },
      note_en: 'Best within three days.', note_cn: '三天内食用最佳。' },
    { type: 'pull_quote', text_en: 'We took the junk out.', text_cn: '我们把添加剂拿掉了。',
      who_en: 'The kitchen', who_cn: '厨房' },
    { type: 'recipe_steps', steps: [
      { text_en: 'Warm the pan.', text_cn: '热锅。', time_en: '2 min', time_cn: '2 分钟' },
      { text_en: 'Fold it through.', text_cn: '拌匀。' },
    ] },
    /* ONE PAIRING IS ON THIS MENU AND ONE IS NOT. The tile's photo comes from
       the menu's own image route, which gates on shop_listings — so an unlisted
       pairing would draw a broken frame. The filter is asserted below. */
    { type: 'pairings', items: [
      { id: 9972, name_en: 'Render fixture bun', name_cn: '测试渲染面包' },
      { id: 9992, name_en: 'Render fixture extra', name_cn: '测试加料' },
    ] },
    { type: 'faq', items: [
      { q_en: 'Is it pasteurised?', q_cn: '经过巴氏杀菌吗？',
        a_en: 'No, the cultures are live.', a_cn: '没有，菌种是活的。' },
      { q_en: 'Can I freeze it?', q_cn: '可以冷冻吗？',
        a_en: 'You can, but it splits.', a_cn: '可以，但会分层。' },
    ] },
    { type: 'notes_callout', text_en: 'Natural separation is normal — stir first.',
      text_cn: '天然分层属正常现象，食用前搅拌。' },
  ]);
  /* THE JAR'S OWN BLOCKS — the legacy `why` shape (rows_en as newline-separated
     text, which older saves use) and a nutrition_facts BLOCK, which is a
     different thing from the nutrition COLUMN and must not print twice beside
     it. The jar has no nutrition column, so this is the block path alone. */
  const BLOCKS_JAR = JSON.stringify([
    { type: 'why', rows_en: 'Keeps for months.\nTravels well.', rows_cn: '可存数月。\n便于携带。' },
    { type: 'nutrition_facts', basis_en: 'per 100 g', basis_cn: '每100克', rows: [
      { label_en: 'Energy', label_cn: '能量', value: '598 kcal' },
      { label_en: 'Saturated', label_cn: '饱和脂肪', value: '3.1 g' },
    ] },
    { type: 'image_band', ratio: 'wide', url: '/s/PLACEHOLDER/i/9971?w=1000',
      caption_en: 'Milled the slow way.', caption_cn: '慢工细磨。' },
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
  const askProd = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Drinks')`);
  askProd.run(P_ASK, EN_ASK, '测试提问饮品', '__R-73', 40);
  askProd.run(A_EXT, 'Render fixture extra', '测试加料', '__R-74', 3);
  /* §129 — two sizes of one product, which the menu drew as two cards until
     Ash reported it. Both carry the SAME name, as the real pair did: the size
     lives in variant_label and nowhere else, which is precisely why two
     identical-looking cards appeared. The larger one is deliberately second in
     the operator's order and first by price. */
  const varProd = db.prepare(`INSERT INTO store_products
    (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category,
     variant_group_id, variant_label, variant_label_cn, variant_sort, description_blocks)
    VALUES (?, ?, ?, ?, ?, 1, 1, 'Drinks', ?, ?, ?, ?, ?)`);
  varProd.run(P_V1, EN_VAR, '测试规格罐', '__R-75', 50, P_V1, '250g', '250克', 0, BLOCKS_JAR);
  varProd.run(P_V2, EN_VAR, '测试规格罐', '__R-76', 76, P_V1, '500g', '500克', 1, null);
  db.prepare('INSERT INTO shops (location_id, public_code, is_active) VALUES (?, ?, 1)').run(LOC, CODE);
  const shopId = db.prepare('SELECT id FROM shops WHERE location_id = ?').get(LOC).id;
  const add = db.prepare(`INSERT INTO shop_listings
    (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
    VALUES (?, ?, ?, 'made_here', ?, ?)`);
  add.run(shopId, P_OK, 33, 1, 0);
  add.run(shopId, P_OUT, 18, 0, 1);   // switched off → the sold-out badge
  add.run(shopId, P_ASK, 40, 1, 2);   // §120 — the drink that asks
  FILLER.forEach((id, i) => add.run(shopId, id, 20 + i, 1, 3 + i));
  // The small jar sells; the large one is switched OFF, so the picker has a
  // dead size to grey and the card still has a live one to sell (§120 rule 1A's
  // shape, applied to sizes).
  add.run(shopId, P_V1, 50, 1, 20);
  add.run(shopId, P_V2, 76, 0, 21);

  /* ── §120's questions ───────────────────────────────────────────────────
     Shaped so the picker's four behaviours can each be driven from a browser:

       Sugar level   single, REQUIRED, and NO DEFAULT — so the picker opens
                     with it unanswered and rule 2B has something to refuse.
       Milk          multi, optional. Soy is DEFAULTED, so the pre-tick is
                     visible; Oat is stock-backed and its shelf is EMPTY, so
                     rule 1A has a dead answer to grey out while the drink it
                     belongs to keeps selling. */
  // The extra's shelf row exists and is at ZERO. §47: it would be sold out with
  // no row at all too, but an explicit zero is the case an operator actually
  // creates by selling the last one.
  db.prepare(`INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
              VALUES (?, ?, 0, 0)`).run(LOC, A_EXT);

  const mkOpt = db.prepare(`INSERT INTO retail_product_options
    (product_id, question_en, question_cn, type, is_required, sort_order) VALUES (?,?,?,?,?,?)`);
  const mkCh = db.prepare(`INSERT INTO retail_product_option_choices
    (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
    VALUES (?,?,?,?,?,?,?)`);
  const qSugar = mkOpt.run(P_ASK, 'Sugar level', '糖度', 'single', 1, 0).lastInsertRowid;
  mkCh.run(qSugar, 'Full sugar', '全糖', 0, 0, null, 0);
  mkCh.run(qSugar, 'Half sugar', '半糖', 0, 0, null, 1);
  const qMilk = mkOpt.run(P_ASK, 'Milk', '奶', 'multi', 0, 1).lastInsertRowid;
  mkCh.run(qMilk, 'Soy', '豆奶', 2, 1, null,  0);
  mkCh.run(qMilk, 'Oat', '燕麦', 3, 0, A_EXT, 1);
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

    await check('a Chinese rail label does not strand "&" or split the word after it', async () => {
      // Reported from a phone, twice. First: SEED_TREE's Fresh & Deli node
      // wrapped in the rail with "&" alone on the first line and 熟食 on the
      // second. A first fix glued only "&" to the very next character with a
      // non-breaking space — which passed a markup-only check here, shipped,
      // and was reported AGAIN on the real device: the break had simply moved
      // one character over, now splitting 熟食 itself (熟 / 食) instead of
      // stranding "&" alone. A markup check cannot catch that; only measuring
      // where each character actually lands can.
      //
      // noOrphanAmp() now joins the ENTIRE tail from "&" onward with U+2060
      // WORD JOINER, so the whole "& 熟食" phrase is one atomic run: this
      // check asserts every character from "&" to the end of the label sits
      // on the SAME line — the only thing that actually proves the phrase
      // wraps as a unit rather than splitting somewhere inside it.
      //
      // SWITCHED TO CHINESE FOR THE MEASUREMENT, then back to English: the
      // suite is in English mode here, where .l-cn is display:none and every
      // Range.getClientRects() on it comes back empty — every top would be
      // null, and null === null made the very first version of this check
      // pass on an element it never actually saw.
      await page.click('[data-lang="cn"]');
      const info = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('.rail a[data-cat]'))
          .find(x => x.textContent.includes('鲜食'));
        if (!a) return null;
        const cnSpan = a.querySelector('.l-cn');
        const textNode = cnSpan.firstChild;
        const tops = [];
        for (let i = 0; i < textNode.length; i++) {
          const r = document.createRange();
          r.setStart(textNode, i);
          r.setEnd(textNode, i + 1);
          const rc = r.getClientRects()[0];
          tops.push({ ch: textNode.textContent[i], top: rc ? Math.round(rc.top) : null });
        }
        return tops;
      });
      await page.click('[data-lang="en"]');
      assert.ok(info, 'the Fresh & Deli rail label is not on screen');
      const ampIdx = info.findIndex(c => c.ch === '&');
      assert.ok(ampIdx >= 0, `no "&" found in the rail label: ${JSON.stringify(info)}`);
      const tail = info.slice(ampIdx);
      assert.ok(tail.every(c => c.top !== null), `a tail character was not on screen: ${JSON.stringify(info)}`);
      const tailLine = tail[0].top;
      assert.ok(tail.every(c => c.top === tailLine),
        `"&" and the word after it do not share one line: ${JSON.stringify(info)}`);
    });

    // ─── The basket, driven ───────────────────────────────────────────────
    // Step 5b part 4. Everything here is a real tap on a real page against the
    // real endpoint: the order that comes out the far end is written to the
    // database by routes/shop-menu.js, not by a stub. A cart tested by reading
    // its markup would prove the buttons EXIST and nothing about what they do.
    // ─── The product sheet, driven ────────────────────────────────────────
    /* THE MENU DOES NOT MOVE BEHIND A SHEET, AND DOES NOT JUMP WHEN ONE OPENS.
       Reported by Ash 2026-09-15: "i can scroll the menu itself behind the pop
       up." There was no lock of any kind on this page.

       BOTH HALVES ARE ASSERTED AND THE SECOND CONSTRAINS THE FIX. Locking with
       position:fixed on the body passes the first half and fails this one — it
       takes the document out of flow and drops the scroll offset to zero, which
       on a page with a sticky header is a visible jump the moment a customer
       taps a card. Measured, because which lock was used is exactly what the
       stylesheet cannot tell you.

       THE PUSH IS A REAL WHEEL EVENT, NOT window.scrollTo. overflow:hidden
       removes the USER's scrolling mechanism; per spec the box stays
       programmatically scrollable, so scrollTo() moves the page whether the
       lock is there or not and an assertion built on it fails against a
       working fix. Cost one round here. */
    await check('the menu is FROZEN behind a sheet, and does not jump when it opens', async () => {
      // THE CARD IS CLICKED THROUGH THE DOM, NOT page.click: Playwright scrolls
      // an element into view before clicking it, which moves the page by itself
      // and would make this check measure the harness. Cost one round too.
      await page.evaluate(() => window.scrollTo(0, 400));
      const before = await page.evaluate(() => window.scrollY);
      assert.ok(before > 100, `the fixture page does not scroll, so this check proves nothing: ${before}`);
      try {
        await page.evaluate(() => document.querySelector('.it:not(.out)[data-open]').click());
        const onOpen = await page.evaluate(() => window.scrollY);
        assert.strictEqual(onOpen, before,
          `opening the sheet moved the menu under it: ${before} -> ${onOpen}`);

        await page.mouse.move(195, 300);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(120);
        const afterPush = await page.evaluate(() => window.scrollY);
        assert.strictEqual(afterPush, before,
          `the menu scrolled behind an open sheet: ${before} -> ${afterPush}`);
      } finally {
        // ALWAYS PUT THE PAGE BACK. A sheet left open by a failing assertion
        // covers every card, and the next dozen checks fail on a timeout that
        // says nothing about what they were testing.
        await page.evaluate(() => document.getElementById('dsheetX').click());
        await page.waitForTimeout(260);
      }

      /* CLOSING PUTS NOTHING BACK AND TAKES NOTHING AWAY. §129 gave the page a
         history entry so the phone's Back button closes it, and closing by the
         × pops that entry — which hands the browser an opportunity to "restore"
         the offset it recorded for the menu, namely the top. This caught it
         doing exactly that (400 -> 0) before history.scrollRestoration was set
         to manual. A customer half way down a long menu must come back to where
         they were, not to the start of it. */
      const afterClose = await page.evaluate(() => window.scrollY);
      assert.strictEqual(afterClose, before,
        `closing the page moved the menu: ${before} -> ${afterClose}`);

      // AND THE SCROLL IS GIVEN BACK. A lock that never releases is a menu
      // nobody can browse after their first tap — worse than the bug it fixes.
      await page.mouse.move(195, 300);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(120);
      const released = await page.evaluate(() => window.scrollY);
      assert.ok(released > before,
        `the page never got its scroll back after the sheet closed: ${before} -> ${released}`);
      await page.evaluate(() => window.scrollTo(0, 0));
    });

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
      /* THE PROSE IS DRAWN NOW, AND THIS ASSERTION USED TO SAY THE OPPOSITE.
         §120 read two blocks and recorded that the surface was "deliberately
         NOT the marketing paragraph": a person standing at a counter is
         deciding whether they can eat it, and this loop asserted the paragraph,
         the claim and the usage tile never reached the screen.

         §129 REVERSED THAT, decided by Ash reading his own live menu — "i cant
         see the description ... only the picture ingridents allerges" — and a
         read of the production database settled that the text was PRESENT and
         being dropped rather than missing: all seven listed products carry a
         hero_intro, 250 across the catalogue. The old expectation is kept here
         in words rather than deleted, because the next reader will otherwise
         find a test that seems never to have had an opinion. */
      assert.ok(m.text.includes('marketing paragraph'),
        'the page dropped the office\'s own paragraph, which is what §129 exists to show');
      /* THE STRUCTURED BLOCKS ARE DRAWN NOW (§132), AND THIS LOOP USED TO ASSERT
         THEY WERE NOT. §129 read two block types and said so; Ash then asked for
         the rest — "i want you to build the blocks of the product description
         same as the mini app" — so `why`, the tiles, the storage cards and the
         rest each got their own rendering.

         THE OLD ASSERTION WAS ALSO PASSING FOR THE WRONG REASON, and that is
         worth keeping in the record. It looked for 'Spoon it over oats' in
         innerText while the tile label is text-transform:uppercase — innerText
         returns TRANSFORMED text, so it was matching against a string that
         could never appear whether the block rendered or not. It went green on
         a page that was already drawing the tile. Every check below therefore
         reads classes and structure, or compares case-insensitively. */
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
      assert.deepStrictEqual(m.rows[0].chips, ['Gluten (oats)']);
      assert.deepStrictEqual(m.rows[1].chips, ['Soy', 'Nuts', 'Gluten']);
      assert.deepStrictEqual(m.rows[0].kinds, ['has'], 'the contains row is not marked as contains');
      assert.deepStrictEqual(m.rows[1].kinds, ['may', 'may', 'may'], 'a may-contain chip reads as contains');
      // And the Chinese half is really there, split on its own separators —
      // the office types 大豆、坚果、麸质 with CJK commas, not ASCII ones.
      assert.deepStrictEqual(m.rows[0].cn, ['麸质（燕麦）']);
      assert.deepStrictEqual(m.rows[1].cn, ['大豆', '坚果', '麸质'],
        'the Chinese list was not split on its own separators');
      // They must not merge visually — that is the whole reason the card exists.
      assert.notStrictEqual(m.hasBg, m.mayBg, 'the two allergen kinds look identical');
      assert.strictEqual(m.mayBorder, 'dashed');
    });

    await check('the allergen chips centre on the card, not on what the label left over', async () => {
      // Reported from a phone: a single "Gluten (oats)" chip floated in the gap
      // between a short label and the middle of the card, aligned to nothing.
      const m = await page.evaluate(() => {
        const card = document.querySelector('#dsheetB .acard');
        const cs = getComputedStyle(card);
        const cb = card.getBoundingClientRect();
        // The CARD's own middle, inside its padding — the line the eye takes as
        // centre. Measuring against the chips' own container was the first
        // version of this check and it passed while the chips sat well right of
        // here, because that container was only ever what a 96px label left over.
        const mid = (cb.left + parseFloat(cs.paddingLeft)
                   + cb.right - parseFloat(cs.paddingRight)) / 2;
        return Array.from(card.querySelectorAll('.arow')).map(r => {
          const chips = Array.from(r.querySelectorAll('.achips span'))
            .filter(el => el.getBoundingClientRect().width > 0);
          if (!chips.length) return null;
          const boxes = chips.map(c => c.getBoundingClientRect());
          const left = Math.min(...boxes.map(b => b.left));
          const right = Math.max(...boxes.map(b => b.right));
          const lab = r.querySelector('.alab').getBoundingClientRect();
          return { off: ((left + right) / 2) - mid, n: chips.length,
                   // The label centres on the same line, and sits ABOVE its
                   // chips rather than beside them — which is what stops a long
                   // chip from ever being squeezed by a long label.
                   labOff: ((lab.left + lab.right) / 2) - mid,
                   above: lab.bottom <= left * 0 + boxes[0].top + 1 };
        }).filter(Boolean);
      });
      assert.ok(m.length >= 2, `the allergen card has too few rows to measure: ${m.length}`);
      for (const r of m) {
        assert.ok(Math.abs(r.off) <= 2,
          `a row of ${r.n} chip(s) sits ${r.off}px off the card's middle`);
        assert.ok(Math.abs(r.labOff) <= 2, `its label sits ${r.labOff}px off the middle`);
        assert.strictEqual(r.above, true, 'the label is still beside its chips, not above them');
      }
    });

    await check('A CHIP\'S TEXT SITS IN THE MIDDLE OF ITS PILL — measured in pixels, both languages', async () => {
      // Reported from a phone three times, and it was three different faults:
      // the ROW sitting off the card's middle, then the TEXT sitting left of
      // its pill, then the text sitting high in it. None of them is visible to
      // a box measurement — every box here centres to within a hundredth of a
      // pixel — so this check screenshots the pill and finds the ink.
      //
      // The filled chip: oat ink on an ink-coloured pill is the one pair a
      // threshold can separate, and it is also the only chip that draws its own
      // background, which is what makes an imbalance visible at all.
      //
      // ITS OWN CONTEXT AT 4x, and the deviceScaleFactor goes on the CONTEXT.
      // newPage() silently ignores it, and the first version of this check
      // asked newPage() for 3x, got 1x, and divided by three anyway — it
      // under-reported every offset threefold and would have passed on all
      // three of the reported faults.
      const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
      const S = 4;
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: S });
      try {
        for (const lang of ['en', 'cn']) {
          const hi = await ctx.newPage();
          await hi.goto(`http://127.0.0.1:${PORT}/s/${CODE}`, { waitUntil: 'domcontentloaded' });
          if (lang === 'cn') await hi.click('[data-lang="cn"]');
          await hi.click('.it:not(.out)[data-open]');
          const sel = `#dsheetB .l-${lang} .achip.has`;
          // The pill's rounded ends let the ground behind it show through, so
          // that ground is repainted to a value that is neither the ink nor the
          // oat before anything is counted.
          await hi.evaluate((q) => {
            document.body.style.background = '#808080';
            document.querySelector('#dsheetB .acard').style.background = '#808080';
            document.querySelector(q).scrollIntoView({ block: 'center' });
          }, sel);
          const text = await hi.evaluate((q) => document.querySelector(q).textContent, sel);
          const chip = await hi.$(sel);
          const { data, info } = await sharp(await chip.screenshot()).greyscale().raw()
            .toBuffer({ resolveWithObject: true });
          let l = null, r = null, t = null, b = null;
          for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
            if (data[y * info.width + x] > 200) {
              if (l === null || x < l) l = x;
              if (r === null || x > r) r = x;
              if (t === null) t = y;
              b = y;
            }
          }
          assert.ok(l !== null, `the ${lang} chip has no text drawn in it at all`);
          const dx = (((l + r) / 2) - info.width / 2) / S;
          const dy = (((t + b) / 2) - info.height / 2) / S;

          /* WHAT THE TRIM ASSUMED, MEASURED RATHER THAN ASSUMED.
             `.achip.tr` takes .67em off the right padding to cancel the blank
             half-cell a full-width closing bracket reserves. That is a CONSTANT
             calibrated against one CJK face — and the comment beside it says so:
             "the bracket comes from the phone's own CJK fallback face". Whether
             the constant is right therefore depends on which face draws （）
             here, which is not the same everywhere.

             This failed on CI for six consecutive merges from 2026-09-06 while
             passing on every developer machine, and the report said only how
             far off it was — never WHY, because the two things that decide it
             (the resolved font, and the bracket's real advance) were never
             looked at. Measured here so the next failure names its own cause.

             Reported on the ASSERTION MESSAGE rather than logged, because a
             passing run should stay quiet and a failing one should arrive
             complete. */
          const face = await hi.evaluate((q) => {
            const el = document.querySelector(q);
            const cs = getComputedStyle(el);
            // The bracket's own advance, from the layout rather than a table:
            // one span of just （） against one of a plain ideograph. If the
            // bracket is full-width they are equal; if the face draws it
            // proportionally it is narrower, and the .67em trim over-corrects.
            const probe = (ch) => {
              const s = document.createElement('span');
              s.textContent = ch;
              s.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
              document.body.appendChild(s);
              const w = s.getBoundingClientRect().width;
              s.remove();
              return w;
            };
            const bracket = probe('）'), ideo = probe('麦');
            return {
              family: cs.fontFamily,
              size: cs.fontSize,
              padRight: cs.paddingRight,
              bracket: +bracket.toFixed(3),
              ideograph: +ideo.toFixed(3),
              ratio: +(bracket / ideo).toFixed(3),
            };
          }, sel);
          // A ratio near 1 means the bracket IS full-width and the trim is
          // right for this face. Well under 1 means it is not, and the trim is
          // subtracting a gap that was never there.
          const why = `[font ${face.family} @ ${face.size}, padding-right ${face.padRight}; `
            + `）is ${face.bracket}px vs 麦 ${face.ideograph}px = ${face.ratio}× `
            + `— ${face.ratio > 0.9 ? 'full-width, so the trim is right for this face'
              : 'NOT full-width, so the .67em trim removes a gap this face never reserved'}]`;
          assert.ok(Math.abs(dx) <= 0.75, `"${text}" sits ${dx}px off the middle of its pill, across ${why}`);
          assert.ok(Math.abs(dy) <= 0.75, `"${text}" sits ${dy}px off the middle of its pill, down ${why}`);
          // And nothing has been trimmed so far that the ink touches the edge.
          assert.ok(l / S >= 2 && (info.width - r) / S >= 2,
            `"${text}" is on the pill's edge: ${l / S} / ${(info.width - r) / S}`);
          await hi.close();
        }
      } finally {
        await ctx.close();
      }
      // The Chinese half is the only one with full-width brackets in it, and a
      // bracket is what the trim exists for — so the fixture must still have one
      // or the trim is being asserted against nothing.
      const cnText = await page.evaluate(() =>
        document.querySelector('#dsheetB .l-cn .achip.has').textContent);
      assert.ok(/[）】》」』〕｝]$/.test(cnText),
        `the fixture chip no longer ends in a full-width bracket: ${cnText}`);
    });

    /* THE HERO IS SERVED AT HERO SIZE, AND THE CARD IS STILL SERVED A THUMBNAIL.
       §129 made the photo full-bleed across the top of the product page and left
       the card's 320px thumbnail URL on it — 320 real pixels stretched across a
       390px viewport, which is 1170 device pixels on a 3x phone. Reported by
       Ash: "quality of picture once open to productpage is low resulution".

       ALL THREE HALVES ARE ASSERTED and the last two are what keep the fix
       honest: raising the hero is trivial, raising the CARD with it would make
       every menu heavy, and letting the hero and the enlarge ask for different
       widths would download the same photograph twice. */
    await check('the page hero asks for a HERO render, the card still asks for a thumbnail', async () => {
      const m = await page.evaluate(() => {
        const hero = document.querySelector('#dsheetB .dt-ph img');
        const card = document.querySelector('.it .ph img');
        const wOf = (el) => {
          if (!el) return null;
          const g = /[?&]w=(\d+)/.exec(el.getAttribute('src') || '');
          return g ? Number(g[1]) : null;
        };
        return { hero: wOf(hero), card: wOf(card), heroSrc: hero ? hero.getAttribute('src') : '' };
      });
      assert.ok(m.hero && m.hero >= 900,
        `the page hero is still being served a thumbnail: w=${m.hero}`);
      assert.strictEqual(m.card, 320,
        `the menu grid's own thumbnails changed size with the hero: w=${m.card}`);
      assert.ok(m.hero > m.card, 'the hero is no larger than the card thumbnail');
    });

    await check('the enlarge re-uses the hero\'s exact URL, so it costs nothing', async () => {
      const m = await page.evaluate(async () => {
        const hero = document.querySelector('#dsheetB .dt-ph img').getAttribute('src');
        document.querySelector('#dsheetB .dt-ph[data-big]').click();
        await new Promise(r => setTimeout(r, 60));
        const big = document.getElementById('bigImg').getAttribute('src');
        document.getElementById('big').click();
        await new Promise(r => setTimeout(r, 60));
        return { hero, big };
      });
      /* SAME WIDTH AND SAME VERSION. The image route caches per width and the
         browser caches per URL, so two different widths would be two renders,
         two downloads and two cache entries of one photograph. Compared on the
         query rather than the whole string because the hero is written with a
         root-relative path and the enlarge builds its own from location. */
      const q = (u) => {
        const g = /\/i\/(\d+)\?(.*)$/.exec(u);
        if (!g) return null;
        const p2 = new URLSearchParams(g[2]);
        return `${g[1]}|w=${p2.get('w')}|v=${p2.get('v')}`;
      };
      assert.ok(q(m.hero), `the hero points somewhere odd: ${m.hero}`);
      assert.strictEqual(q(m.big), q(m.hero),
        `the enlarge asks for a different render than the hero already loaded:\n  hero ${m.hero}\n  big  ${m.big}`);
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

    /* ── §132 — EVERY BLOCK THE OFFICE WROTE ──────────────────────────────
       Ash: *"i want you to build the blocks of the product description same as
       the mini app."* §129 drew the paragraph and the note; these are the other
       eleven. Read off the OPEN PAGE rather than the template, because a block
       that parses and does not lay out is the failure that matters — which is
       why the page is opened here rather than assumed to still be open from an
       earlier check. It was assumed once and every assertion below read an
       empty panel and failed saying the blocks had been re-ordered to nothing. */
    await page.evaluate(() => { const x = document.getElementById('dsheetX'); if (x) x.click(); });
    await page.waitForTimeout(260);
    await page.evaluate(() => document.querySelector('.it:not(.out)[data-open]').click());
    await page.waitForTimeout(300);

    await check('§132 the blocks are drawn IN THE OFFICE\'S ORDER, not a fixed one', async () => {
      const order = await page.evaluate(() => {
        const b = document.getElementById('dsheetB');
        const want = { 'pb-spec': 'spec', 'dt-p': 'hero', 'pb-why-r': 'why', 'pb-stat': 'stat',
          'ichips': 'ingredients', 'acard': 'allergens', 'pb-how': 'how', 'pb-store': 'storage',
          'pb-qt': 'quote', 'pb-step': 'recipe', 'pb-pair': 'pairings', 'pb-faq': 'faq',
          'pb-note': 'notes' };
        const seen = [];
        b.querySelectorAll('*').forEach(el => {
          for (const cls of Object.keys(want)) {
            if (el.classList.contains(cls) && seen[seen.length - 1] !== want[cls]) {
              if (!seen.includes(want[cls])) seen.push(want[cls]);
            }
          }
        });
        return seen;
      });
      /* THE FIXTURE'S OWN ORDER. §129 rendered a fixed template — prose, then
         ingredients, then allergens — so the spec strip appearing FIRST and the
         note LAST is the whole of what changed structurally. */
      assert.deepStrictEqual(order,
        ['spec', 'hero', 'why', 'stat', 'ingredients', 'allergens', 'how', 'storage',
         'quote', 'recipe', 'pairings', 'faq', 'notes'],
        `the page re-ordered the office's blocks: ${JSON.stringify(order)}`);
    });

    await check('\u00a7132 the highlight phrase is MARKED INLINE, not turned into a kicker', async () => {
      /* Reported by Ash against the editor's own preview, which draws the lime
         slab: *"it doesnt show the yellw mark on the live version."* The
         component's rule is a FORK, not a fallback \u2014 a phrase found in the body
         is marked inline and draws no kicker; only a phrase that is NOT in the
         body becomes the kicker. The first build kept the fallback and dropped
         the marking, so the slab appeared on no product at all. */
      const m = await page.evaluate(() => {
        const en = document.querySelector('.dt-pb .l-en');
        const cn = document.querySelector('.dt-pb .l-cn');
        const hl = en ? en.querySelector('.pb-hl') : null;
        const cs = hl ? getComputedStyle(hl) : null;
        return {
          hlText: hl ? hl.textContent : null,
          hlBg: cs ? cs.backgroundColor : null,
          hlBox: hl ? (() => { const r = hl.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() : false,
          // The Chinese phrase is NOT in the Chinese body, so that half must
          // carry no slab at all — the fork is resolved per language.
          cnHl: cn ? cn.querySelectorAll('.pb-hl').length : -1,
          kicker: (document.querySelector('.dt-pk .l-en') || {}).textContent || '',
          preLine: (() => { const b = document.querySelector('.dt-pb');
            return b ? getComputedStyle(b).whiteSpace : ''; })(),
          enText: en ? en.textContent : '',
        };
      });
      assert.strictEqual(m.hlText, 'straightforward and satisfying',
        `the phrase was not marked inline: ${JSON.stringify(m.hlText)}`);
      assert.ok(m.hlBox, 'the slab is in the markup but has no box on screen');
      // Drawn on the brand's lime, not left as plain text.
      assert.ok(/^rgba?\(/.test(m.hlBg) && m.hlBg !== 'rgba(0, 0, 0, 0)',
        `the slab has no ground: ${m.hlBg}`);
      assert.strictEqual(m.cnHl, 0,
        'the Chinese half drew a slab for a phrase that is not in its body');
      // The EXPLICIT kicker still wins, and the phrase did not become one.
      assert.strictEqual(m.kicker, 'The story', `kicker: ${JSON.stringify(m.kicker)}`);
      /* AND THE BLANK LINE SURVIVES. The office writes paragraphs with blank
         lines between them; without pre-line every description ran together
         into one block on the live page. */
      assert.strictEqual(m.preLine, 'pre-line',
        `the paragraph breaks the office wrote are being collapsed: ${m.preLine}`);
      assert.ok(/\n\s*\n/.test(m.enText), 'the blank line was stripped before it could render');
    });

    await check('§132 the spec strip, the claims and the big stat carry their content', async () => {
      const m = await page.evaluate(() => ({
        specK: Array.from(document.querySelectorAll('.pb-spec-k .l-en')).map(e => e.textContent),
        specV: Array.from(document.querySelectorAll('.pb-spec-v .l-en')).map(e => e.textContent),
        whyN: Array.from(document.querySelectorAll('.pb-why-n')).map(e => e.textContent.trim()),
        whyFirst: !!document.querySelector('.pb-why-r.first'),
        whyC: Array.from(document.querySelectorAll('.pb-why-c .l-en')).map(e => e.textContent),
        statN: (document.querySelector('.pb-stat-n') || {}).textContent,
        statDots: document.querySelectorAll('.pb-stat-d').length,
        heads: Array.from(document.querySelectorAll('.pb-h-l .l-en')).map(e => e.textContent),
        whyHead: ((document.querySelector('.pb-why-h .l-en') || {}).textContent || '').trim(),
        tags: document.querySelectorAll('.pb-h-r').length,
        whySize:  parseFloat(getComputedStyle(document.querySelector('.pb-why-h')).fontSize),
        headSize: parseFloat(getComputedStyle(document.querySelector('.pb-h-l')).fontSize),
      }));
      assert.deepStrictEqual(m.specK, ['Product type', 'Net weight', 'Origin'], JSON.stringify(m.specK));
      assert.deepStrictEqual(m.specV, ['Cultured', '250 g', 'Guangzhou'], JSON.stringify(m.specV));
      // NUMBERED 01, 02 — zero-padded, as the component numbers them.
      assert.deepStrictEqual(m.whyN, ['01', '02'], `claim numbering: ${JSON.stringify(m.whyN)}`);
      assert.ok(m.whyFirst, 'the first claim row does not carry the heavier rule');
      assert.strictEqual(m.whyC.length, 2, 'a claim was dropped');
      assert.strictEqual(m.statN.trim(), '92', `the stat figure: ${m.statN}`);
      assert.strictEqual(m.statDots, 2, 'the slab lost its anchoring dots');
      /* The headings are the mini app's own words, not invented here — AND each
         one sits at the WEIGHT the component gives it, which is the half this
         check used to leave open. product-blocks.wxml heads .pb-why with a
         22rpx kicker (.pb-why-head-l) and heads every other block, the
         ingredient cloud included, with the 52rpx .pb-section-h3. This page had
         those two exactly swapped — the why block wore the big shared heading
         and the ingredients wore a small .dt-k kicker — so asserting only that
         the words are present passed while the page read nothing like the mini
         app. Both halves are pinned now. */
      assert.strictEqual(m.whyHead, 'Why people choose it',
        `the why block's heading is not the component's kicker: ${m.whyHead}`);
      assert.ok(!m.heads.includes('Why people choose it'),
        `the why block is wearing the big headline again: ${JSON.stringify(m.heads)}`);
      assert.ok(m.heads.includes('Ingredients'), JSON.stringify(m.heads));
      assert.ok(m.heads.includes('How to use'), JSON.stringify(m.heads));
      assert.ok(m.heads.includes('Storage'), JSON.stringify(m.heads));
      assert.ok(m.heads.includes('Questions'), JSON.stringify(m.heads));
      /* AND NO HEADING CARRIES A COUNT. product-blocks.wxss styles
         .pb-section-tag and product-blocks.wxml never renders it, so the
         "3 moments" / "6 steps" line beside three of these headings was on this
         page and on no other surface. */
      assert.strictEqual(m.tags, 0,
        'a heading is carrying a count the mini app does not draw');
      // 22rpx and 52rpx at this page's 390px phone: .52 x 22 = 11.4, x 52 = 27.
      assert.ok(Math.abs(m.whySize - 11.4) < 0.6,
        `the why kicker is ${m.whySize}px, want 11.4 (22rpx x .52)`);
      assert.ok(Math.abs(m.headSize - 27) < 0.6,
        `a block heading is ${m.headSize}px, want 27 (52rpx x .52)`);
    });

    await check('§132 A RASHER OF BACON DOES NOT REACH A PLANT-BASED MENU', async () => {
      /* The office picks icons from a general-purpose set; the component keeps
         a swap table for exactly this, and a reader that copied everything else
         and dropped that one line would put meat on the menu of a shop that
         does not sell it. The fixture tile carries 🥓 on purpose. */
      const icons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.pb-how-i')).map(e => e.textContent.trim()));
      assert.ok(icons.length >= 2, `tiles lost their icons: ${JSON.stringify(icons)}`);
      assert.ok(!icons.includes('🥓'), `a rasher of bacon is on the menu: ${JSON.stringify(icons)}`);
      assert.ok(icons.includes('🌱'), `the swap did not happen: ${JSON.stringify(icons)}`);
    });

    await check('§132 the storage card promotes a lone phrase and drops a repeated scale', async () => {
      const m = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.pb-store-c'));
        return cards.map(c => ({
          alt: c.classList.contains('alt'),
          num: ((c.querySelector('.pb-store-n .l-en') || {}).textContent || '').trim(),
          long: !!(c.querySelector('.pb-store-n') || {}).classList?.contains('long'),
          unit: ((c.querySelector('.pb-store-u .l-en') || {}).textContent || '').trim(),
        }));
      });
      assert.strictEqual(m.length, 2, `two cards expected: ${JSON.stringify(m)}`);
      // LEFT: a real figure, and the caption no longer repeats the degree scale
      // the figure already carries ("°C at all times" -> "at all times").
      assert.strictEqual(m[0].num, '0–4°', JSON.stringify(m[0]));
      assert.strictEqual(m[0].unit, 'at all times',
        `the caption still repeats the scale the figure carries: ${JSON.stringify(m[0])}`);
      assert.ok(!m[0].long, 'a short figure was treated as a phrase');
      // RIGHT: no figure at all, so the phrase is promoted out of the caption
      // into the hero slot and drops to a wrapping size.
      assert.strictEqual(m[1].num, 'Cool, dry place',
        `a lone phrase was left in caption type: ${JSON.stringify(m[1])}`);
      assert.ok(m[1].long, 'the promoted phrase kept the hero numeral size and would clip');
      assert.ok(m[1].alt, 'the inverted card lost its inversion');
    });

    await check('§132 the quote carries its own marks in BOTH languages', async () => {
      /* A CSS ::before would put one pair around the element and both halves
         would share it, so the hidden language's marks would hang beside the
         visible language's text. Each half carries its own. */
      const m = await page.evaluate(() => ({
        en: ((document.querySelector('.pb-qt-p .l-en') || {}).textContent || ''),
        cn: ((document.querySelector('.pb-qt-p .l-cn') || {}).textContent || ''),
        who: ((document.querySelector('.pb-qt-w .l-en') || {}).textContent || ''),
      }));
      assert.ok(/^\u201C.*\u201D$/.test(m.en), `the English quote is unmarked: ${JSON.stringify(m.en)}`);
      assert.ok(/^\u201C.*\u201D$/.test(m.cn), `the Chinese quote is unmarked: ${JSON.stringify(m.cn)}`);
      assert.strictEqual(m.who, 'The kitchen');
    });

    await check('§132 a recipe step is numbered and its timing is a pill', async () => {
      const m = await page.evaluate(() => ({
        n: Array.from(document.querySelectorAll('.pb-step-n')).map(e => e.textContent.trim()),
        first: !!document.querySelector('.pb-step.first'),
        times: Array.from(document.querySelectorAll('.pb-step-time .l-en')).map(e => e.textContent),
      }));
      assert.deepStrictEqual(m.n, ['01', '02'], JSON.stringify(m.n));
      assert.ok(m.first, 'the first step does not carry the heavier rule');
      // Only the step that HAS a time gets a pill — the second one has none.
      assert.deepStrictEqual(m.times, ['2 min'], `timing pills: ${JSON.stringify(m.times)}`);
    });

    await check('§132 a pairing this shop does NOT list is dropped, not drawn broken', async () => {
      /* The tile's photo comes from the menu's own image route and that route
         gates on shop_listings, so an unlisted pairing renders a broken frame
         beside a name. The fixture names one listed product and one that is
         stock-only and appears on no menu. */
      const m = await page.evaluate(() => ({
        names: Array.from(document.querySelectorAll('.pb-pair-n .l-en')).map(e => e.textContent),
        srcs: Array.from(document.querySelectorAll('.pb-pair-t img')).map(e => e.getAttribute('src')),
      }));
      assert.deepStrictEqual(m.names, ['Render fixture bun'],
        `an unlisted pairing reached the page: ${JSON.stringify(m.names)}`);
      assert.strictEqual(m.srcs.length, 1);
      assert.ok(/\/i\/9972\?/.test(m.srcs[0]), `the tile points somewhere odd: ${m.srcs[0]}`);
    });

    await check('§132 the questions open and close with NO script at all', async () => {
      /* details/summary rather than a tap handler: it works with JavaScript
         off, answers a keyboard, and is read correctly aloud. The first one
         opens, as it does in the mini app. */
      const before = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('.pb-faq'));
        return { tags: d.map(x => x.tagName), open: d.map(x => x.open) };
      });
      assert.deepStrictEqual(before.tags, ['DETAILS', 'DETAILS'],
        `the accordion is not a native disclosure: ${JSON.stringify(before.tags)}`);
      assert.deepStrictEqual(before.open, [true, false],
        `the first question should open and the rest should not: ${JSON.stringify(before.open)}`);
      /* AND THE ANSWER REALLY IS HIDDEN UNTIL IT IS OPENED, asked through
         checkVisibility rather than a bounding box. Chrome no longer hides a
         closed disclosure with display:none — it uses content-visibility, so
         the subtree keeps a box and a rect-based check calls a properly closed
         question "still showing its answer". checkVisibility is the API that
         knows the difference; the rect stays as a fallback for a browser that
         has not got it. */
      const shut = await page.evaluate(() => {
        const a = document.querySelectorAll('.pb-faq')[1].querySelector('.pb-faq-a');
        if (typeof a.checkVisibility === 'function') {
          return !a.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
        }
        const r = a.getBoundingClientRect();
        return r.width === 0 && r.height === 0;
      });
      assert.ok(shut, 'a closed question is still showing its answer');
      const after = await page.evaluate(() => {
        const d = document.querySelectorAll('.pb-faq')[1];
        d.querySelector('summary').click();
        const a = d.querySelector('.pb-faq-a').getBoundingClientRect();
        return { open: d.open, shown: a.height > 0 };
      });
      assert.ok(after.open && after.shown, 'tapping a question did not reveal its answer');
    });

    // PUT THE PAGE BACK. The §132 checks above opened it and every check after
    // them reaches for a card, which an open full-screen page covers.
    await page.evaluate(() => document.getElementById('dsheetX').click());
    await page.waitForTimeout(280);

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
      // THREE, not two, since §129: the two original products with blocks, plus
      // the sized jar — which carries blocks of its own AND would have to open
      // regardless, because a collapsed card whose picker could not be reached
      // is a size nobody can buy. The eight filler rows still carry nothing and
      // still do not respond, which is what this check is for.
      assert.strictEqual(m.withDt, 3, `only the products with something to say: ${JSON.stringify(m)}`);
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

    await check('THE COUNT SITS IN THE MIDDLE OF ITS SQUARE — measured in pixels', async () => {
      // Reported from a phone: the number rode high in the black chip. Nothing
      // about the BOX was wrong, which is why no geometric check could see it —
      // the chip inherited the body's 1.45 reading line-height, so an 18.85px
      // line box sat inside a 24px square and the digit sat high in that. On
      // this page the digits come from the substitute face while the line box
      // was sized by the display face's metrics, so the two disagreed by a
      // whole pixel. The only honest measurement is of the ink itself.
      const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
      const el = await page.$('#cbarN');
      const { data, info } = await sharp(await el.screenshot()).greyscale().raw()
        .toBuffer({ resolveWithObject: true });
      let top = null, bot = null, left = null, right = null;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        // Oat ink on an ink-coloured chip: the light pixels ARE the digit.
        if (data[y * info.width + x] > 128) {
          if (top === null) top = y;
          bot = y;
          if (left === null || x < left) left = x;
          if (right === null || x > right) right = x;
        }
      }
      assert.ok(top !== null, 'the count chip has no digit drawn in it at all');
      const dy = ((top + bot) / 2) - info.height / 2;
      const dx = ((left + right) / 2) - info.width / 2;
      assert.ok(Math.abs(dy) <= 0.5,
        `the count sits ${dy}px off the middle of its square, down the page`);
      assert.ok(Math.abs(dx) <= 0.75,
        `the count sits ${dx}px off the middle of its square, across`);
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
      // AND THE PRICE IS STILL ON THE PHONE. Reported: "Apple Pie Overnight
      // Oats" beside a stepper and a price was three things competing for one
      // 362px row, and the price lost — it was clipped by the right edge. The
      // name now has its own line. Measured against the panel that scrolls,
      // because that is what does the clipping.
      const fit = await page.evaluate(() => {
        const b = document.getElementById('sheetB');
        const bb = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const p = b.querySelector('.ln-p').getBoundingClientRect();
        const t = b.querySelector('.ln-t').getBoundingClientRect();
        const q = b.querySelector('.qty').getBoundingClientRect();
        return { spill: p.right - (bb.right - parseFloat(cs.paddingRight)),
                 scroll: b.scrollWidth - b.clientWidth,
                 // Stacked, not side by side: the name's row ends above them.
                 stacked: t.bottom <= q.top + 1 };
      });
      assert.ok(fit.spill <= 1, `the price hangs ${fit.spill}px past the panel's edge`);
      assert.ok(fit.scroll <= 1, `the basket line scrolls sideways by ${fit.scroll}px`);
      assert.strictEqual(fit.stacked, true,
        'the name is still on the same row as the stepper, so a long one squeezes the price');
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
        barL: document.getElementById('cbarL').innerText.replace(/\s+/g, ' ').trim(),
        barN: document.getElementById('cbarN').textContent.trim(),
        title: document.getElementById('sheetT').innerText.replace(/\s+/g, ' ').trim(),
        doneH: document.querySelector('.done-h').innerText.replace(/\s+/g, ' ').trim(),
      }));
      assert.ok(/^\d+$/.test(shown.code), `the number is not a plain number: ${shown.code}`);
      assert.strictEqual(shown.name, 'Mei', 'the name the customer will be called by is not shown');
      // THIS ASSERTION WAS INVERTED ON 2026-09-08 AND IS CORRECTED, NOT
      // RELAXED. It read `bar.hidden === true` — a hidden bar was how this
      // suite proved the basket had been emptied by the order. Since the order
      // placed from this phone is remembered, an empty basket is exactly when
      // the bar is SHOWN, carrying the order instead of the basket, so the old
      // assertion asserted the defect. It went red the day that shipped and
      // nothing said so: this file is in the browser shard, which is not run.
      //
      // The replacement proves more than the original did. A bar that still
      // said YOUR BASKET would mean the basket had survived; a bar naming the
      // order means it was emptied AND the order took its place.
      assert.strictEqual(shown.bar, false, 'the placed order left no way back to itself');
      assert.ok(/Order/.test(shown.barL) && !/BASKET/i.test(shown.barL),
        `the basket survived the order that emptied it: ${shown.barL}`);
      assert.strictEqual(shown.barN, shown.code, 'the bar carries a number that is not the order\'s');
      // AND THE PANEL DOES NOT CALL ITSELF THE BASKET EITHER. The same defect
      // as the bar's, one element up and found later: every other face of this
      // sheet repaints #sheetT and done() did not, so the placed order was
      // drawn under whichever word was last set — always YOUR BASKET, over the
      // order that had just emptied the basket.
      //
      // TWO ASSERTIONS, BECAUSE THE FIRST ALONE PASSES ON A HEADING THAT NEVER
      // GOT PAINTED. Nothing is the answer here on purpose — .done-h names
      // this face — so the check that it is EMPTY is the check that it was
      // deliberately cleared, and the check that .done-h is not is what stops
      // an empty header from being read as a face with no name at all.
      assert.ok(!/BASKET|购物车/i.test(shown.title),
        `the panel called itself the basket over a placed order: ${JSON.stringify(shown.title)}`);
      assert.strictEqual(shown.title, '',
        `the placed order's heading is neither cleared nor its own: ${JSON.stringify(shown.title)}`);
      assert.ok(/Order placed|下单成功/.test(shown.doneH),
        `the face that lost its header does not name itself in its body: ${JSON.stringify(shown.doneH)}`);
      // The half a screenshot cannot show: the order exists.
      const row = db.prepare(
        `SELECT recipient_name, status, channel, source, shop_entry_method,
                fulfillment_type, shop_order_code
           FROM retail_orders WHERE store_id = ? ORDER BY id DESC LIMIT 1`).get(LOC);
      assert.ok(row, 'the page said an order was placed and no order was written');
      assert.strictEqual(row.recipient_name, 'Mei');
      assert.strictEqual(row.status, 'pending_payment');
      assert.strictEqual(row.channel, 'shop');
      // The door is shop_entry_method (§44, amended 2026-09-07). `source` says
      // how the row was CREATED and is NULL for anything that arrived by
      // itself — a QR order, like the mini-app checkout and every mirror. It
      // held 'qr' until that amendment, which is the defect it recorded.
      assert.strictEqual(row.shop_entry_method, 'qr');
      assert.strictEqual(row.source, null,
        'a QR order claimed a `source` — that column says who created the row, not which door');
      assert.strictEqual(row.fulfillment_type, 'counter');
      assert.strictEqual(String(row.shop_order_code), shown.code,
        'the number on the phone is not the number in the database');
    });

    /* WHAT THE CUSTOMER ORDERED, ON THE SCREEN THAT CONFIRMS IT — reported
       2026-09-08 from a phone: "after order was made customer cant see the
       order details at all, nowhere."

       THE SERVER HAD ALREADY SENT THEM. The create response has carried an
       `items` array on every path since the route was written; this sheet took
       the number, the name, the amount and the order number out of it and threw
       the lines away. So the one moment the customer is looking straight at
       their order was also the moment the last copy of what was in it — the
       basket, which is memory only — had just been cleared.

       A BROWSER CHECK BECAUSE THE SHEET IS DRAWN BY SCRIPT. A served-bytes
       suite can prove lineRows was SENT; only a browser that really placed an
       order can prove it ran and put the lines on screen.

       READ-ONLY, AND IT LEAVES THE SHEET OPEN. The check after this one closes
       it deliberately to prove the bar takes over, so nothing here may touch it.

       CHECKED AGAINST THE DATABASE, not against a fixture name written out
       twice. What the screen says has to be what was actually written down, and
       comparing the two is the only assertion that cannot drift when the
       fixtures change. */
    await check('THE DONE SHEET SAYS WHAT WAS ORDERED', async () => {
      const shown = await page.evaluate(() => {
        const box = document.querySelector('.done-it');
        if (!box) return { box: false };
        const rows = [...box.querySelectorAll('.ln')].map(ln => ({
          en:  (ln.querySelector('.ln-t .l-en') || {}).textContent || '',
          cn:  (ln.querySelector('.ln-t .l-cn') || {}).textContent || '',
          qty: (ln.querySelector('.ln-q') || {}).textContent || '',
          amt: (ln.querySelector('.ln-p') || {}).textContent || '',
        }));
        const amt = document.querySelector('.done-amt');
        // Document order: the lines have to lead INTO the figure they add up
        // to, the same way the order page and the basket read. Compared by
        // position among .done's own children rather than with
        // compareDocumentPosition — both are direct children, and the constant
        // that call needs lives on a DOM global the linter does not have here.
        const kids = [...box.parentNode.children];
        return {
          box: true, rows,
          beforeAmount: !!amt && kids.indexOf(box) < kids.indexOf(amt),
          // On screen, not merely in the DOM.
          visible: box.getBoundingClientRect().height > 0,
        };
      });
      assert.ok(shown.box, 'the done sheet listed nothing the order was made of');
      assert.ok(shown.visible, 'the lines are in the document but have no box');
      assert.ok(shown.beforeAmount, 'the total was printed above the lines it totals');

      const order = db.prepare(
        'SELECT id FROM retail_orders WHERE store_id = ? ORDER BY id DESC LIMIT 1').get(LOC);
      const want = db.prepare(
        `SELECT name_en, name_cn, qty, line_total
           FROM retail_order_items WHERE order_id = ? ORDER BY id`).all(order.id);
      assert.ok(want.length, 'the fixture placed an order with no lines to check');
      assert.strictEqual(shown.rows.length, want.length,
        `the sheet drew ${shown.rows.length} lines for an order of ${want.length}`);
      want.forEach((w, i) => {
        const got = shown.rows[i];
        // BOTH LANGUAGES IN EVERY ROW. The toggle has to work on this screen
        // like it works on the menu behind it, and a Chinese phone shown only
        // the English name is back where the report started.
        assert.strictEqual(got.en.trim(), String(w.name_en || ''),
          `line ${i + 1} does not name what was ordered in English`);
        assert.strictEqual(got.cn.trim(), String(w.name_cn || ''),
          `line ${i + 1} does not name what was ordered in Chinese`);
        assert.strictEqual(got.qty.trim(), '×' + w.qty,
          `line ${i + 1} does not say how many: ${JSON.stringify(got.qty)}`);
        // The figure, not the formatting — the symbol is the tenant's.
        assert.ok(got.amt.includes(Number(w.line_total).toFixed(2)),
          `line ${i + 1} does not say what it came to: ${JSON.stringify(got.amt)}`);
      });
    });

    /* ── THE ORDER THIS PHONE HAS ALREADY PLACED ───────────────────────────
       Two reports from the counter, 2026-09-08, and they are the same defect
       seen from both ends: "he has no way to see his order, order number or
       anything its all dissaper", and then "customer cant go back from this
       page. dead end."

       WHY THESE ARE BROWSER CHECKS AND NOT STRING ONES. Every line of this
       behaviour is drawn by script from localStorage — the bar's second state,
       the list, and the receipt that outlives the tab. A served-bytes suite can
       prove the script was SENT and nothing else; the one assertion that
       matters is that a customer who closes the screen, or walks off and scans
       the code again, still finds the number they are waiting to be called by.
       That can only be observed in a browser that has really placed the order. */

    await check('CLOSING THE DONE SHEET DOES NOT LOSE THE ORDER — the bar carries it', async () => {
      const KEY = 'tacet-shop-order:' + CODE;
      await page.click('#sheetX');
      const m = await page.evaluate(async (key) => {
        await new Promise(r => setTimeout(r, 260));
        return {
          hidden: document.getElementById('cbar').hidden,
          n:      document.getElementById('cbarN').textContent.trim(),
          label:  document.getElementById('cbarL').innerText.replace(/\s+/g, ' ').trim(),
          v:      document.getElementById('cbarV').textContent.trim(),
          kept:   JSON.parse(localStorage.getItem(key) || 'null'),
        };
      }, KEY);
      assert.strictEqual(m.hidden, false, 'the order went with the sheet that carried it');
      assert.ok(/^\d+$/.test(m.n), `the bar does not carry the number: ${m.n}`);
      assert.ok(/Order/.test(m.label), `the bar still calls itself the basket: ${m.label}`);
      assert.ok(/\d/.test(m.v), `the bar does not say what the order cost: ${m.v}`);
      assert.ok(Array.isArray(m.kept) && m.kept.length === 1,
        `the receipt is not a list of one: ${JSON.stringify(m.kept)}`);
      assert.strictEqual(String(m.kept[0].n), m.n, 'the bar and the receipt name different orders');
    });

    await check('A SECOND ORDER DOES NOT ERASE THE FIRST', async () => {
      // It did until 2026-09-08: one order was remembered, so a customer who
      // came back for a cake could no longer reach the coffee — or cancel it.
      const KEY = 'tacet-shop-order:' + CODE;
      await page.click('.it:not(.out) .add');
      await page.click('#cbarOpen');
      await page.fill('#cName', 'Yu');
      await page.click('#cPlace');
      await page.waitForSelector('.done-n', { timeout: 8000 });
      const second = await page.evaluate(() => document.querySelector('.done-n').textContent.trim());
      await page.click('#sheetX');
      const m = await page.evaluate(async (key) => {
        await new Promise(r => setTimeout(r, 260));
        return {
          n: document.getElementById('cbarN').textContent.trim(),
          kept: JSON.parse(localStorage.getItem(key) || 'null'),
        };
      }, KEY);
      assert.strictEqual(m.kept.length, 2, `the second order overwrote the first: ${JSON.stringify(m.kept)}`);
      // NEWEST FIRST, and the bar names it: it is the number about to be
      // called, and a bar naming the oldest would name the one already
      // collected.
      assert.strictEqual(String(m.kept[0].n), second, 'the list is not newest first');
      assert.strictEqual(m.n, second, 'the bar names an order that is not the newest');
      assert.notStrictEqual(m.kept[1].u, m.kept[0].u, 'the same order was remembered twice');
    });

    await check('AND SCANNING THE CODE AGAIN FINDS THEM — which is what a reload is', async () => {
      // The whole of the report: "even if he goes out from the screen
      // completly, scan the qr code again, should have his order there."
      const before = await page.evaluate(() => document.getElementById('cbarN').textContent.trim());
      await page.reload({ waitUntil: 'domcontentloaded' });
      const m = await page.evaluate(() => ({
        hidden: document.getElementById('cbar').hidden,
        n: document.getElementById('cbarN').textContent.trim(),
      }));
      assert.strictEqual(m.hidden, false, 'a fresh scan of the code shows no order at all');
      assert.strictEqual(m.n, before, 'a fresh scan names a different order');
    });

    await check('...and the bar then opens the list, one real row per order', async () => {
      await page.click('#cbarOpen');
      const m = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 260));
        return {
          title: document.getElementById('sheetT').innerText.replace(/\s+/g, ' ').trim(),
          foot:  document.getElementById('sheetF').hidden,
          rows: Array.from(document.querySelectorAll('#sheetB .mo')).map((a) => {
            const r = a.getBoundingClientRect();
            return { href: a.getAttribute('href'), w: r.width, h: r.height,
                     text: a.innerText.replace(/\s+/g, ' ').trim() };
          }),
        };
      });
      assert.strictEqual(m.rows.length, 2, `the list does not hold both orders: ${JSON.stringify(m.rows)}`);
      assert.ok(m.rows.every(r => r.w > 0 && r.h > 0),
        `a row with no box on screen: ${JSON.stringify(m.rows)}`);
      assert.ok(m.rows.every(r => /^\/s\/[A-Z0-9]+\/pay\/[a-f0-9]+$/i.test(r.href)),
        `a row does not lead to an order page: ${JSON.stringify(m.rows.map(r => r.href))}`);
      // The panel says which of its faces this is, or it is a basket with no
      // basket in it.
      assert.ok(/My orders/.test(m.title), `the list still calls itself the basket: ${m.title}`);
      assert.strictEqual(m.foot, true, 'the orders list still offers Place order');
    });

    await check('AND THEY SURVIVE A NEW BASKET BEING BUILT ON TOP OF THEM', async () => {
      // The state where they used to disappear: with something in the basket
      // the bar IS the basket, so the foot of the basket is the only place the
      // earlier orders can be reached from. Below every stepper, deliberately —
      // the basket is memory only and a tap that leaves the page loses it.
      await page.click('#sheetX');
      await page.evaluate(() => new Promise(r => setTimeout(r, 260)));
      await page.click('.it:not(.out) .add');
      await page.click('#cbarOpen');
      const m = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 260));
        const bottom = (sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.length ? Math.max(...els.map(e => e.getBoundingClientRect().bottom)) : null;
        };
        const top = (sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.length ? Math.min(...els.map(e => e.getBoundingClientRect().top)) : null;
        };
        return {
          title: document.getElementById('sheetT').innerText.replace(/\s+/g, ' ').trim(),
          foot:  document.getElementById('sheetF').hidden,
          lines: document.querySelectorAll('#sheetB .ln').length,
          rows:  document.querySelectorAll('#sheetB .mo').length,
          head:  (document.querySelector('#sheetB .mo-h') || {}).innerText,
          lastLine: bottom('#sheetB .ln'),
          firstRow: top('#sheetB .mo'),
        };
      });
      assert.strictEqual(m.lines, 1, 'the basket lost its own line');
      assert.strictEqual(m.rows, 2, 'the orders already placed vanished behind a new basket');
      // Case-insensitively: .mo-h is uppercased by CSS, and innerText reports
      // what the customer actually reads rather than what the script wrote.
      assert.ok(/My orders/i.test(String(m.head).replace(/\s+/g, ' ')),
        `the orders under the basket are unlabelled: ${JSON.stringify(m.head)}`);
      assert.ok(/YOUR BASKET/i.test(m.title), `a basket that does not call itself one: ${m.title}`);
      assert.strictEqual(m.foot, false, 'a basket with no way to place it');
      assert.ok(m.firstRow >= m.lastLine,
        `the orders sit among the steppers rather than below them: ${m.lastLine} / ${m.firstRow}`);
      // Hand the next check a clean page, as the checks above this one do.
      await page.reload({ waitUntil: 'domcontentloaded' });
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

    /* ── §120 — THE PICKER, DRIVEN LIKE A CUSTOMER ────────────────────────
       Everything below happens in a real browser on a 390px viewport, because
       the picker is client-side JavaScript in a string literal and the only
       thing that proves such a thing works is running it. The server suite
       (test_shop_menu_options.js) proves the rules; this proves the sheet. */

    // Back to English and a genuinely clean page. The language checks above left
    // the document in 中文, and the order checks before them left real orders in
    // localStorage — which keeps the bar on screen in its "back to your order"
    // state. That matters here: `barHidden` below is how these checks tell
    // "nothing was added to the basket" from "something was", and a bar held
    // open by yesterday's orders would make every one of them vacuous.
    await page.goto(`http://127.0.0.1:${PORT}/s/${CODE}?lang=en`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* private mode */ } });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const pickerState = () => page.evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const rows = Array.from(document.querySelectorAll('.oc')).map(b => ({
        label: (b.querySelector('.oc-l .l-en') || {}).textContent || '',
        side: (b.querySelector('.oc-d .l-en') || b.querySelector('.oc-d') || {}).textContent || '',
        on: b.classList.contains('on'),
        out: b.classList.contains('out'),
        disabled: !!b.disabled,
        // Whether this answer belongs to a question that accepts more than
        // one, and whether the box saying so is actually drawn with ink in it.
        multi: b.classList.contains('multi'),
        box: (() => {
          const x = b.querySelector('.oc-x');
          if (!x) return null;
          const r = x.getBoundingClientRect();
          return { w: r.width, h: r.height, tick: x.textContent.trim() };
        })(),
      }));
      return {
        sheetOpen: vis(document.querySelector('#sheet .sheet-p')),
        questions: Array.from(document.querySelectorAll('.og-q .l-en')).map(e => e.textContent),
        rows,
        addLabel: (document.getElementById('oAdd') || {}).textContent || '',
        pickerFootShown: vis(document.getElementById('sheetO')),
        basketFootShown: vis(document.getElementById('sheetF')),
        err: (() => { const e = document.getElementById('oErr'); return e && !e.hidden ? e.textContent : ''; })(),
        barHidden: !!(document.getElementById('cbar') || {}).hidden,
      };
    });
    const tick = (label) => page.evaluate((t) => {
      const b = Array.from(document.querySelectorAll('.oc'))
        .find(x => ((x.querySelector('.oc-l .l-en') || {}).textContent || '') === t);
      if (!b) throw new Error('no answer row labelled ' + t);
      b.click();
    }, label);

    await check('§120 the + on a product with questions ASKS instead of adding', async () => {
      await page.evaluate((name) => {
        const card = Array.from(document.querySelectorAll('.it'))
          .find(c => (c.querySelector('.t .l-en') || {}).textContent === name);
        card.querySelector('.add').click();
      }, EN_ASK);
      const st = await pickerState();
      assert.ok(st.sheetOpen, 'the picker did not open');
      assert.deepStrictEqual(st.questions, ['Sugar level', 'Milk'], `questions: ${st.questions}`);
      assert.ok(st.barHidden, 'the drink went into the basket before it was answered');
      assert.ok(st.pickerFootShown && !st.basketFootShown,
        'the picker is wearing the basket\'s foot — a name field over a sugar level');
    });

    await check('§120 rule 1A — the sold-out extra is dead and says so; the rest is live', async () => {
      const st = await pickerState();
      const oat = st.rows.find(r => r.label === 'Oat');
      const soy = st.rows.find(r => r.label === 'Soy');
      assert.ok(oat && oat.out && oat.disabled, `the empty shelf did not reach the picker: ${JSON.stringify(oat)}`);
      assert.match(oat.side, /Sold out/, `a dead answer must say why, not show a price: "${oat.side}"`);
      assert.ok(soy && !soy.out, 'the live extra was greyed out with the dead one');
      // THE DRINK ITSELF IS STILL BEING SOLD — that is the whole of rule 1A.
      assert.ok(st.sheetOpen, 'an optional sold-out extra closed the picker');
    });

    /* A CONTROL THAT IS BEHAVING CORRECTLY AND LOOKS IDENTICAL TO ONE THAT IS
       NOT HAS FAILED. Reported by Ash 2026-09-15: both breads ticked on a
       product whose question is typed multi, read as the picker being broken.
       The tick handler was right and the screen was silent about which kind of
       question it was, which is the same thing as being wrong. Measured in
       pixels, because the box existing in the markup and the box being on
       screen are different claims and only the second one is the fix. */
    await check('§120 a PICK-ANY question is told apart from a PICK-ONE, in ink', async () => {
      const st = await pickerState();
      const milk = st.rows.filter(r => r.label === 'Soy' || r.label === 'Oat');
      const sugar = st.rows.filter(r => r.label === 'Full sugar' || r.label === 'Half sugar');
      assert.strictEqual(milk.length, 2, 'the multi question lost its answers');
      assert.strictEqual(sugar.length, 2, 'the single question lost its answers');
      for (const r of milk) {
        assert.ok(r.multi, `a multi answer is not marked as one: ${JSON.stringify(r)}`);
        assert.ok(r.box && r.box.w > 0 && r.box.h > 0,
          `a multi answer has no box on screen: ${JSON.stringify(r)}`);
      }
      // AND THE ASSERTION IS NOT VACUOUS — the single question must NOT have one.
      for (const r of sugar) {
        assert.ok(!r.multi, `a single answer was marked multi: ${JSON.stringify(r)}`);
        assert.strictEqual(r.box, null,
          `a pick-one question drew a tick box, which is a radio dressed as a checkbox: ${JSON.stringify(r)}`);
      }
    });

    await check('§120 the box carries the tick, and only while the answer is on', async () => {
      // Soy is the defaulted multi answer, so it opens ticked and Oat does not.
      const st = await pickerState();
      const soy = st.rows.find(r => r.label === 'Soy');
      const oat = st.rows.find(r => r.label === 'Oat');
      assert.ok(soy.on && soy.box.tick === '\u2713',
        `a ticked answer has an empty box: ${JSON.stringify(soy)}`);
      assert.ok(!oat.on && oat.box.tick === '',
        `an unticked answer is showing a tick: ${JSON.stringify(oat)}`);
    });

    await check('§120 a defaulted answer opens pre-ticked, and a dead one never does', async () => {
      const st = await pickerState();
      assert.ok(st.rows.find(r => r.label === 'Soy').on, 'the default was not pre-ticked');
      assert.ok(!st.rows.find(r => r.label === 'Oat').on, 'a sold-out default was pre-ticked');
      assert.ok(!st.rows.find(r => r.label === 'Full sugar').on,
        'a question with no default opened already answered');
    });

    await check('§120 a dead answer cannot be ticked, by tapping it', async () => {
      await tick('Oat');
      const st = await pickerState();
      assert.ok(!st.rows.find(r => r.label === 'Oat').on, 'a sold-out extra took a tap');
    });

    await check('§120 RULE 2B — Add refuses, and NAMES the question it wants', async () => {
      await page.click('#oAdd');
      const st = await pickerState();
      assert.ok(st.sheetOpen, 'the picker closed on a refusal');
      assert.ok(st.barHidden, 'the drink was added despite the unanswered question');
      // The live pair, question text and all — "Please choose: Sugar level".
      assert.match(st.err, /Please choose: Sugar level/, `the refusal said: "${st.err}"`);
      assert.match(st.err, /请选择 糖度/, 'the 中文 half of the refusal is missing');
    });

    await check('§120 the button carries the running price as answers are ticked', async () => {
      await tick('Full sugar');
      const withSoy = (await pickerState()).addLabel;     // 40 base + 2 soy (defaulted)
      assert.match(withSoy, /42/, `base plus the defaulted extra: "${withSoy}"`);
      assert.match(withSoy, /Add to basket/, 'the button lost its live label');
      await tick('Soy');                                   // untick it
      const plain = (await pickerState()).addLabel;
      assert.match(plain, /40/, `unticking the extra did not take its price off: "${plain}"`);
      await tick('Soy');                                   // back on
    });

    /* ANSWERING PUTS THE CUSTOMER BACK ON THE MENU, AND THIS ASSERTION USED TO
       SAY THE OPPOSITE. §120 flipped the panel to the BASKET face here, on the
       reasoning that it is "the face that shows what has just been added", and
       this check asserted exactly that (`basketFoot && !pickerFoot`).

       Reported by Ash from the live menu, ticking an extra on a salad: "when i
       click add to basket it goes to chekcut instead going back to main menu."
       Nothing else on this menu behaves that way — a plain + adds and leaves
       you browsing, and §129's size picker does the same — so the question path
       was the only one that ended on a form asking for a name and a tender. */
    await check('§120 answering it adds the line and puts the MENU back, not the checkout', async () => {
      await page.click('#oAdd');
      await page.waitForTimeout(260);
      const after = await page.evaluate(() => ({
        sheetHidden: !!document.getElementById('sheet').hidden,
        onMenu: !!document.querySelector('.it'),
        count: (document.getElementById('cbarN') || {}).textContent.trim(),
        barHidden: !!(document.getElementById('cbar') || {}).hidden,
      }));
      assert.ok(after.sheetHidden, 'answering the questions left the panel open on the checkout');
      assert.ok(after.onMenu, 'the menu is not behind it');
      // THE CONFIRMATION IS THE BAR, which is the same answer the plain + gives.
      assert.ok(!after.barHidden, 'nothing on screen says anything was added');
      assert.strictEqual(after.count, '1', `basket count: ${after.count}`);
    });

    await check('§120 ...and the line it added is named with what was chosen', async () => {
      await page.evaluate(() => document.getElementById('cbarOpen').click());
      await page.waitForTimeout(260);
      const st = await page.evaluate(() => ({
        lines: Array.from(document.querySelectorAll('#sheetB .ln')).map(l => ({
          title: (l.querySelector('.ln-t .l-en') || {}).textContent || '',
          opts: Array.from(l.querySelectorAll('.ln-o .l-en')).map(o => o.textContent),
          price: (l.querySelector('.ln-p') || {}).textContent || '',
        })),
        basketFoot: !document.getElementById('sheetF').hidden,
        pickerFoot: !document.getElementById('sheetO').hidden,
      }));
      assert.strictEqual(st.lines.length, 1, `one line expected, got ${st.lines.length}`);
      assert.deepStrictEqual(st.lines[0].opts, ['Sugar level: Full sugar', 'Milk: Soy'],
        `the basket line does not say what was chosen: ${JSON.stringify(st.lines[0].opts)}`);
      assert.match(st.lines[0].price, /42/, `base plus extra: "${st.lines[0].price}"`);
      // And the basket really is wearing its OWN foot, not the picker's.
      assert.ok(st.basketFoot && !st.pickerFoot, 'the basket is wearing the picker\'s foot');
    });

    await check('§120 TWO SUGAR LEVELS OF ONE DRINK ARE TWO LINES', async () => {
      // The basket was opened by the check above; close it to get at the cards.
      await page.evaluate(() => document.getElementById('sheetX').click());
      await page.waitForTimeout(260);
      await page.evaluate((name) => {
        const card = Array.from(document.querySelectorAll('.it'))
          .find(c => (c.querySelector('.t .l-en') || {}).textContent === name);
        card.querySelector('.add').click();
      }, EN_ASK);
      await tick('Half sugar');
      await tick('Soy');                                   // drop the default
      await page.click('#oAdd');
      await page.waitForTimeout(260);
      // The picker now closes onto the menu, so the basket is opened to read it.
      await page.evaluate(() => document.getElementById('cbarOpen').click());
      await page.waitForTimeout(260);
      const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#sheetB .ln'))
        .map(l => Array.from(l.querySelectorAll('.ln-o .l-en')).map(o => o.textContent).join(' / ')));
      assert.strictEqual(lines.length, 2,
        `a second configuration of the same drink was folded into the first: ${JSON.stringify(lines)}`);
      assert.ok(lines.some(l => /Full sugar/.test(l)) && lines.some(l => /Half sugar/.test(l)),
        `both configurations should survive: ${JSON.stringify(lines)}`);
    });

    await check('§120 and the order it places really carries them', async () => {
      await page.fill('#cName', 'Mei');
      await page.click('#cPlace');
      await page.waitForFunction(() => /\d/.test(
        (document.querySelector('.done-n') || document.querySelector('#sheetB') || {}).textContent || ''
      ), null, { timeout: 5000 }).catch(() => {});
      const rows = db.prepare(
        `SELECT oi.options_json FROM retail_order_items oi
           JOIN retail_orders o ON o.id = oi.order_id
          WHERE o.store_id = ? AND oi.product_id = ? ORDER BY oi.id DESC LIMIT 2`
      ).all(LOC, P_ASK);
      assert.strictEqual(rows.length, 2, 'the two configured lines did not reach the database');
      const saved = rows.map(r => JSON.parse(r.options_json || 'null'));
      assert.ok(saved.every(a => Array.isArray(a) && a.length),
        'a configured line was written with no answers on it');
      // THE SHAPE lib/feie.js PRINTS — the question is what makes the ticket
      // read "Sugar level: Half sugar" instead of a bare "Half sugar".
      assert.ok(saved.every(a => a[0].question_en === 'Sugar level'),
        'the question was not snapshotted onto the line');
      const labels = saved.map(a => a.map(x => x.label).join(','));
      assert.ok(labels.some(l => /Full sugar/.test(l)) && labels.some(l => /Half sugar/.test(l)),
        `both configurations should be on the order: ${JSON.stringify(labels)}`);
    });

    /* ── §129 — THE SIZES, AND THE PAGE THEY ARE CHOSEN ON ─────────────────
       Reported by Ash on a screenshot of the live menu, two identical
       photographs both captioned Almond Butter at two different prices: *"those
       are 2 variant on the mini app. under the same page. on the qrcode menu
       its 2 seperate products."* §120 had decided flatly against variants here,
       reasoning that a drink in three sizes would cost three rows of a small
       screen; what shipped was two rows a customer could not tell apart,
       because the size lived in variant_label and the menu never read it. */
    /* BOTH STORES, AND THE LANGUAGE ONE IS sessionStorage. The orders this
       phone has placed live in localStorage; the language choice lives in
       sessionStorage under its own key. Clearing only the first leaves the 中文
       chosen by the language checks above still in force, and every assertion
       below that reads innerText — which respects the CSS language switch —
       then reads the Chinese half and fails saying the heading was 选择规格.
       Cost one round. */
    await page.goto(`http://127.0.0.1:${PORT}/s/${CODE}?lang=en`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try { localStorage.clear(); } catch (e) { /* private mode */ }
      try { sessionStorage.clear(); } catch (e) { /* private mode */ }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const cardsNamed = (name) => page.evaluate((n) => Array.from(document.querySelectorAll('.it'))
      .filter(c => ((c.querySelector('.t .l-en') || {}).textContent || '') === n).length, name);

    await check('§129 two sizes are ONE card, not two', async () => {
      assert.strictEqual(await cardsNamed(EN_VAR), 1,
        'the siblings are still drawn as separate products');
    });

    await check('§129 the card shows the OWNER, and carries every size with it', async () => {
      const m = await page.evaluate((n) => {
        const card = Array.from(document.querySelectorAll('.it'))
          .find(c => ((c.querySelector('.t .l-en') || {}).textContent || '') === n);
        if (!card) return null;
        return {
          price: (card.querySelector('.pr') || {}).textContent.trim(),
          offersSizes: !!card.querySelector('.pf .add[data-sizes]'),
          // The + must NOT be a plain add: tapping it has to ask which size.
          plainAdd: !!card.querySelector('.pf .add[data-add]'),
          hidden: Array.from(card.querySelectorAll('.vadds .add')).map(b => ({
            id: b.getAttribute('data-add'),
            label: b.getAttribute('data-vl-en'),
            out: b.getAttribute('data-out') === '1',
          })),
          // and nothing in that set is reachable by a thumb
          vaddsBox: (() => { const v = card.querySelector('.vadds'); if (!v) return null;
            const r = v.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
        };
      }, EN_VAR);
      assert.ok(m, 'the collapsed card is not on the page at all');
      // THE REPRESENTATIVE IS THE GROUP OWNER, not the cheapest and not the
      // first row: the fixture's owner is also the cheaper one, so the price is
      // checked against the LABEL ORDER below rather than treated as proof.
      assert.ok(m.offersSizes, 'the + on a sized card does not offer the sizes');
      assert.ok(!m.plainAdd, 'the + on a sized card would add one size silently');
      assert.deepStrictEqual(m.hidden.map(h => h.label), ['250g', '500g'],
        `the sizes are not in the operator's variant_sort order: ${JSON.stringify(m.hidden)}`);
      assert.deepStrictEqual(m.hidden.map(h => h.out), [false, true],
        'the switched-off size is not marked sold out');
      assert.ok(m.vaddsBox && m.vaddsBox.w === 0 && m.vaddsBox.h === 0,
        `the sizes' own buttons are on screen: ${JSON.stringify(m.vaddsBox)}`);
    });

    await check('§129 the + asks WHICH SIZE, and adds nothing until one is chosen', async () => {
      await page.evaluate((n) => {
        const card = Array.from(document.querySelectorAll('.it'))
          .find(c => ((c.querySelector('.t .l-en') || {}).textContent || '') === n);
        card.querySelector('.pf .add').click();
      }, EN_VAR);
      const st = await page.evaluate(() => ({
        open: !document.getElementById('sheet').hidden,
        title: document.getElementById('sheetT').innerText.replace(/\s+/g, ' ').trim(),
        rows: Array.from(document.querySelectorAll('.oc[data-vpick]')).map(b => ({
          label: (b.querySelector('.oc-l .l-en') || {}).textContent || '',
          side: (b.querySelector('.oc-d .l-en') || b.querySelector('.oc-d') || {}).textContent || '',
          disabled: !!b.disabled,
        })),
        barHidden: !!(document.getElementById('cbar') || {}).hidden,
      }));
      assert.ok(st.open, 'the size picker did not open');
      assert.match(st.title, /Choose a size/, `the heading was: ${JSON.stringify(st.title)}`);
      assert.deepStrictEqual(st.rows.map(r => r.label), ['250g', '500g'], JSON.stringify(st.rows));
      // RULE 1A's SHAPE, APPLIED TO SIZES: the dead one is drawn and says so,
      // and the live one still sells. Omitting it would leave a customer
      // wondering whether the big jar exists.
      assert.ok(!st.rows[0].disabled, 'the live size cannot be chosen');
      assert.ok(st.rows[1].disabled, 'the switched-off size is still choosable');
      assert.match(st.rows[1].side, /Sold out/, `a dead size shows a price: ${st.rows[1].side}`);
      assert.ok(st.rows[0].side.replace(/[^0-9]/g, '').length > 0, 'a live size shows no price');
      assert.ok(st.barHidden, 'the jar went into the basket before a size was chosen');
    });

    await check('§129 choosing a size adds THAT size, at THAT price', async () => {
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('.oc[data-vpick]'))
          .find(b => !b.disabled).click();
      });
      await page.waitForTimeout(260);
      const st = await page.evaluate(() => ({
        sheetHidden: !!document.getElementById('sheet').hidden,
        count: (document.getElementById('cbarN') || {}).textContent.trim(),
        total: (document.getElementById('cbarV') || {}).textContent.trim(),
      }));
      assert.ok(st.sheetHidden, 'the picker stayed open after a size was chosen');
      assert.strictEqual(st.count, '1', `basket count: ${st.count}`);
      // The 250g is 50 and the 500g is 76. Adding the small one and finding 76
      // would mean the representative's row was added rather than the choice.
      assert.ok(/50/.test(st.total) && !/76/.test(st.total),
        `the basket took the wrong size's price: ${st.total}`);
    });

    await check('§129 the product PAGE opens full-screen and carries the office\'s words', async () => {
      await page.evaluate((n) => {
        const card = Array.from(document.querySelectorAll('.it'))
          .find(c => ((c.querySelector('.t .l-en') || {}).textContent || '') === n);
        card.click();
      }, EN_VAR);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const p = document.querySelector('#dsheet .sheet-p');
        const r = p.getBoundingClientRect();
        const hero = document.querySelector('#dsheetB .dt-ph');
        const hr = hero ? hero.getBoundingClientRect() : null;
        const btn = document.getElementById('dAdd');
        return {
          open: !document.getElementById('dsheet').hidden,
          // A PAGE FILLS THE SCREEN. A bottom sheet does not, and that is the
          // difference Ash asked for — measured, not inferred from a class.
          fillsHeight: r.height >= window.innerHeight - 1,
          top: Math.round(r.top),
          heroFullWidth: hr ? Math.round(hr.width) : 0,
          viewport: window.innerWidth,
          scrimShown: getComputedStyle(document.getElementById('dsheetBg')).display !== 'none',
          label: btn.innerText.replace(/\s+/g, ' ').trim(),
          priceShown: !document.getElementById('dPr').hidden,
          text: document.getElementById('dsheetB').innerText,
        };
      });
      assert.ok(m.open, 'the product page did not open');
      assert.ok(m.fillsHeight, `the page is still a bottom sheet: height vs viewport ${m.top}`);
      assert.strictEqual(m.top, 0, `the page does not start at the top of the screen: ${m.top}`);
      assert.strictEqual(m.heroFullWidth, m.viewport,
        `the hero is not full-bleed: ${m.heroFullWidth} of ${m.viewport}`);
      assert.ok(!m.scrimShown, 'a page is dimming something behind it');
      // THE BUTTON SAYS WHICH OF THE TWO THINGS IT DOES, and a sized product
      // carries no price on it because there are two.
      assert.match(m.label, /CHOOSE A SIZE/, `the buy button said: ${JSON.stringify(m.label)}`);
      assert.ok(!m.priceShown, 'a product with two prices is showing one of them');
      /* §132 — THE JAR CARRIES ITS OWN BLOCKS, deliberately different from the
         latte's: the LEGACY `why` shape (rows_en as newline-separated text,
         which older saves use) and a nutrition_facts BLOCK, which is a separate
         thing from the nutrition COLUMN. Both paths need a product that
         exercises them, and the latte exercises the modern shapes. */
      assert.ok(/Keeps for months/i.test(m.text),
        `the legacy why shape was dropped: ${JSON.stringify(m.text.slice(0, 200))}`);
      assert.ok(/Travels well/i.test(m.text), 'the second legacy claim was dropped');
    });

    await check('§132 a nutrition_facts BLOCK prints, and the column does not print beside it', async () => {
      const m = await page.evaluate(() => ({
        cards: document.querySelectorAll('#dsheetB .nut').length,
        rows: Array.from(document.querySelectorAll('#dsheetB .nr')).map(r => ({
          l: (r.querySelector('.nr-l .l-en') || {}).textContent || '',
          k: r.className.replace('nr', '').trim(),
        })),
        band: document.querySelectorAll('#dsheetB .pb-band img').length,
        ttl:  parseFloat(getComputedStyle(document.querySelector('#dsheetB .nut-ttl')).fontSize),
        rowL: parseFloat(getComputedStyle(document.querySelector('#dsheetB .nr-l')).fontSize),
        rowR: parseFloat(getComputedStyle(document.querySelector('#dsheetB .nr-r')).fontSize),
      }));
      // ONE card. A product carrying both a block and a column would otherwise
      // print its table twice under the same heading.
      assert.strictEqual(m.cards, 1, `nutrition printed ${m.cards} times`);
      assert.deepStrictEqual(m.rows.map(r => r.l), ['Energy', 'Saturated'], JSON.stringify(m.rows));
      // And the block's rows classify the same way the column's do.
      assert.deepStrictEqual(m.rows.map(r => r.k), ['p', 'c'], JSON.stringify(m.rows));
      /* THIS CARD CARRIES THE APP'S --font-scale AND EVERY BLOCK ABOVE IT DOES
         NOT, which is the one thing about it that is easy to lose and was lost.
         miniapp/pages/product/product.wxss writes these sizes as
         calc(Nrpx * var(--font-scale)) — app.wxss sets that scale to 1.15 — so
         the conversion is rpx x 1.15 x .52 here and rpx x .52 everywhere else
         on this page. The first pass applied .52 alone and the whole nutrition
         panel stood 13% smaller than the same panel in the mini app while the
         blocks above it matched. 40rpx -> 23.9px, 27rpx -> 16.1px. */
      assert.ok(Math.abs(m.ttl - 23.9) < 0.6,
        `nutrition title is ${m.ttl}px, want 23.9 (40rpx x 1.15 x .52)`);
      assert.ok(Math.abs(m.rowL - 16.1) < 0.6,
        `nutrition row label is ${m.rowL}px, want 16.1 (27rpx x 1.15 x .52)`);
      assert.ok(Math.abs(m.rowR - 23.9) < 0.6,
        `nutrition row value is ${m.rowR}px, want 23.9 (40rpx x 1.15 x .52)`);
      assert.strictEqual(m.band, 1, 'the image band did not render');
    });

    /* SWITCHING LANGUAGE WITH A SHEET OPEN MUST NOT UNLOCK THE MENU. Found
       while chasing a different failure: the toggle assigned the root's whole
       class attribute (d.className = 'lang-' + l), which wiped every other
       class on it — including the .sh-lock that stops the menu scrolling behind
       an open sheet. A customer who opened their basket and then tapped 中 got
       a page that scrolled underneath it again, silently.

       BOTH HALVES ARE ASSERTED, because a fix that kept the lock by no longer
       switching the language would pass a check that only looked at one. */
    await check('switching language keeps BOTH the language and the scroll lock', async () => {
      await page.evaluate(() => {
        try { sessionStorage.clear(); } catch (e) { /* private mode refuses; the reload below then keeps whatever language was set, and the assertions here read classes rather than text */ }
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.getElementById('cbarOpen').click());
      await page.waitForTimeout(260);
      const locked = await page.evaluate(() =>
        document.documentElement.classList.contains('sh-lock'));
      assert.ok(locked, 'the basket opened without locking the menu behind it');

      await page.evaluate(() => document.querySelector('[data-lang="cn"]').click());
      const after = await page.evaluate(() => ({
        cls: document.documentElement.className,
        locked: document.documentElement.classList.contains('sh-lock'),
        cn: document.documentElement.classList.contains('lang-cn'),
      }));
      assert.ok(after.cn, `the toggle stopped switching language: ${after.cls}`);
      assert.ok(after.locked,
        `switching language unlocked the menu behind the open sheet: ${after.cls}`);

      // Put it back the way the checks after this one expect to find it.
      await page.evaluate(() => document.querySelector('[data-lang="en"]').click());
      await page.evaluate(() => document.getElementById('sheetX').click());
      await page.waitForTimeout(260);
    });

    await check('§129 the phone\'s BACK button closes the page, and keeps the basket', async () => {
      const before = await page.evaluate(() => (document.getElementById('cbarN') || {}).textContent.trim());
      await page.goBack();
      await page.waitForTimeout(320);
      const st = await page.evaluate(() => ({
        pageHidden: !!document.getElementById('dsheet').hidden,
        onMenu: !!document.querySelector('.it'),
        count: (document.getElementById('cbarN') || {}).textContent.trim(),
      }));
      assert.ok(st.pageHidden, 'Back did not close the product page');
      assert.ok(st.onMenu, 'Back left the menu entirely');
      /* THE BASKET SURVIVES, WHICH IS THE WHOLE REASON THIS IS pushState AND NOT
         A NAVIGATION. §44 keeps the basket in memory and nowhere else, so a real
         page load for every product a customer opened would empty it. If this
         assertion ever fails, the page has become a navigation. */
      assert.strictEqual(st.count, before,
        `the basket was emptied by looking at a product: ${before} -> ${st.count}`);
    });

    await check('§132 the office\'s blocks scale with the phone and the chrome does not', async () => {
      /* rpx IS screen-width/750, so the mini app draws its product page about
         6% larger on a 412px Android than on a 390px one. This page was
         converted at a 390px phone and stood still, which is what Ash was
         looking at: "fix the scale". Every length under §132 is now
         calc(N * var(--u)) with --u: 100vw/390.

         THREE THINGS ARE ASSERTED TOGETHER because each one is a way the change
         could be wrong on its own:
           the blocks track the width ratio exactly — the point of it;
           the menu card and the sheet's own title do NOT — .grid is
             public/shop.html's card in CSS pixels and the note over it records
             two rounds of "it is too big" from treating rpx as its truth;
           nothing scrolls sideways — the three full-bleed slabs pull out
             through .sheet-b's fixed 14px padding, so a scaled -14 overhangs
             it at every width above 390 and the page rocks horizontally. That
             one was found by measuring, not by reading. */
      const probe = async (w) => {
        const c2 = await browser.newContext({ viewport: { width: w, height: 844 } });
        const pg = await c2.newPage();
        await pg.goto(`http://127.0.0.1:${PORT}/s/${CODE}?lang=en`, { waitUntil: 'domcontentloaded' });
        await pg.evaluate(() => document.querySelector('.it:not(.out)[data-open]').click());
        await pg.waitForTimeout(320);
        const m = await pg.evaluate(() => {
          const fs = (q) => { const e = document.querySelector(q);
            return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
          const slab = document.querySelector('.pb-stat');
          const doc = document.documentElement;
          return {
            head: fs('.pb-h-l'), kicker: fs('.pb-why-h'), nut: fs('.nut-ttl'),
            card: fs('.t'), sheetTitle: fs('#dsheetB .dt-nm'),
            slabW: slab ? Math.round(slab.getBoundingClientRect().width) : null,
            overflow: doc.scrollWidth - doc.clientWidth,
          };
        });
        await c2.close();
        return m;
      };
      const a = await probe(390), b = await probe(412);
      // The reference phone still renders exactly what it rendered before the
      // scale moved: --u is 1px at 390, so these are the file's own numbers.
      assert.ok(Math.abs(a.head - 27) < 0.2, `390px heading: ${a.head}`);
      assert.ok(Math.abs(a.kicker - 11.4) < 0.2, `390px why kicker: ${a.kicker}`);
      assert.ok(Math.abs(a.nut - 23.9) < 0.2, `390px nutrition title: ${a.nut}`);
      const want = 412 / 390;
      for (const k of ['head', 'kicker', 'nut']) {
        const got = b[k] / a[k];
        assert.ok(Math.abs(got - want) < 0.01,
          `${k} scaled ${got.toFixed(4)} from 390 to 412, want ${want.toFixed(4)}`);
      }
      assert.strictEqual(b.card, a.card,
        `the menu card's name scaled with the viewport (${a.card} -> ${b.card}); .grid is the website's card in CSS pixels and must not`);
      assert.strictEqual(b.sheetTitle, a.sheetTitle,
        `the sheet's own title scaled (${a.sheetTitle} -> ${b.sheetTitle}); it is chrome, not one of the office's blocks`);
      // Full-bleed stays exactly full-bleed, and neither width rocks sideways.
      assert.strictEqual(a.slabW, 390, `the slab is not full-bleed at 390: ${a.slabW}`);
      assert.strictEqual(b.slabW, 412, `the slab is not full-bleed at 412: ${b.slabW}`);
      assert.strictEqual(a.overflow, 0, `the page scrolls sideways at 390 by ${a.overflow}px`);
      assert.strictEqual(b.overflow, 0, `the page scrolls sideways at 412 by ${b.overflow}px`);
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
