#!/usr/bin/env node
/**
 * The Shop menu sub-page (门店商品) occupies real pixels once mounted.
 *
 *   node scripts/test_shop_menu_geometry.js
 *
 * WHY A GEOMETRY TEST AND NOT A STRING TEST. retail-admin.css:946 carries an
 * unscoped `section { display: none; }` — the tab switcher's own rule, which
 * `section.active` lifts for the one live tab. Anything ELSE that renders a
 * <section> inside the admin is eaten by it silently: PR #206 shipped the
 * Eleme settlement panel as `<section class="cmp">`, thirteen string
 * assertions kept passing on markup nobody could see, and the mounted-geometry
 * check in scripts/test_channel_money_panel.js was added so the next such
 * panel fails here rather than in production. This is that check for the
 * shop menu, which is a takeover page with its own display rules on top of
 * the tab switcher's and therefore has two ways to end up zero-height.
 *
 * WHAT IT DOES. The REAL public/retail-admin/28-shops.js is loaded into a
 * headless Chromium page under the REAL stylesheet and the REAL section
 * markup from retail-admin.html, with the shell globals it reaches for
 * (api, cuT, goTab, toast, …) stubbed to answer with fixture data. It opens
 * the page the way the Sales card does — shopMenuOpen(code) — and measures.
 * Three mounts: a shop with listings, a shop with none, a location with no
 * shop. Each must put the header, the details card and the table or empty
 * state on screen with a non-zero box.
 *
 * AND IT PROVES THE ASSERTION IS NOT VACUOUS, the way the original bug was
 * found: the identical rendered fragment is re-wrapped in a bare <section>
 * and required to compute a ZERO box under the same stylesheet. If that
 * re-wrap did not go to zero, the rule this test guards against would not be
 * live and the check would be measuring nothing.
 *
 * Prints "SKIP — no Chromium found" and exits 0 where there is no browser,
 * which scripts/run-suites.js turns into a failure under REQUIRE_BROWSER=1.
 */
'use strict';
/* global document, window, getComputedStyle -- referenced only inside
   page.evaluate() callbacks, which run in the browser, not in this process. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// THE SHARED LOOKUP, COPIED RATHER THAN REINVENTED — byte-for-byte from
// scripts/test_stock_home.js, which is the fullest of the copies the render
// suites share (test_mobile_geometry.js's omits '/opt/pw-browsers/chromium'
// from the direct list).
//
// THIS FILE USED TO ASK A NARROWER QUESTION AND CI PAID FOR IT. It probed only
// '/opt/pw-browsers/chromium' and otherwise handed Playwright an empty launch
// options object, so it depended on Playwright having a browser downloaded of
// its own. On the CI runner it has not, and the launch threw — the suite
// printed its SKIP line and REQUIRE_BROWSER=1 turned that into a failure,
// while thirty-three sibling render suites in the same job found Chromium and
// ran. Neither CHROME_BIN nor the /usr/bin/* system paths were consulted, and
// those are what the runner actually provides.
//
// So the SKIP is now reached only when there genuinely is no browser anywhere,
// which is the case a developer's laptop is entitled to, and never because
// this file looked in fewer places than its siblings.
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

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const SHOPS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '28-shops.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── 0. Static audit — the markup never renders a <section> of its own ──────
console.log('\nStatic — the sub-page renders no <section> the unscoped rule could eat');
it('28-shops.js contains no <section tag', () => {
  assert.ok(!/<section\b/i.test(SHOPS_JS), '28-shops.js renders a <section>; retail-admin.css:946 would hide it');
});
const sectionMarkup = (() => {
  const m = HTML.match(/<section id="tab-shop-menu">[\s\S]*?<\/section>/);
  assert.ok(m, 'retail-admin.html has no <section id="tab-shop-menu">');
  return m[0];
})();
it('the section in retail-admin.html is the one tab-level <section>, with no nested one', () => {
  const inner = sectionMarkup.replace(/^<section id="tab-shop-menu">/, '').replace(/<\/section>$/, '');
  assert.ok(!/<section\b/i.test(inner), 'a nested <section> inside #tab-shop-menu');
  assert.ok(/id="shp-root"/.test(inner), 'the paint root #shp-root is missing');
});

// ── Fixtures the stubbed api() answers with ────────────────────────────────
const LOC = { id: 9821, code: 'geom-fixture', name_en: 'Geometry fixture', name_cn: '几何测试店', is_active: 1 };
const LOC_EMPTY = { id: 9822, code: 'geom-empty', name_en: 'Empty fixture', name_cn: '空菜单店', is_active: 1 };
const LOC_NONE = { id: 9823, code: 'geom-none', name_en: 'No shop fixture', name_cn: '未开通店', is_active: 1 };
const SHOP = { id: 51, location_id: LOC.id, public_code: 'K7MZ2QDB', display_name_en: null, display_name_cn: null, is_active: 1,
  location_code: LOC.code, location_name_en: LOC.name_en, location_name_cn: LOC.name_cn };
const SHOP_EMPTY = { ...SHOP, id: 52, location_id: LOC_EMPTY.id, public_code: 'P3NRV8HT', location_code: LOC_EMPTY.code,
  location_name_en: LOC_EMPTY.name_en, location_name_cn: LOC_EMPTY.name_cn };
const LISTINGS = [
  { id: 1, shop_id: 51, store_product_id: 301, price: 32, fulfilment_mode: 'made_here', is_available: 1, sort_position: 0,
    name_en: 'Oat latte', name_cn: '燕麦拿铁', sku: 'D-101', sell_price: 32 },
  { id: 2, shop_id: 51, store_product_id: 302, price: 48.5, fulfilment_mode: 'stocked', is_available: 0, sort_position: 1,
    name_en: 'Granola 500g', name_cn: '格兰诺拉 500g', sku: 'G-500', sell_price: 48.5 },
];
const FIXTURES = {
  '/api/retail-admin/shops': { success: true, data: [
    { location: LOC, shop: { id: 51, public_code: SHOP.public_code, is_active: 1, listing_count: 2, available_count: 1 } },
    { location: LOC_EMPTY, shop: { id: 52, public_code: SHOP_EMPTY.public_code, is_active: 1, listing_count: 0, available_count: 0 } },
    { location: LOC_NONE, shop: null },
  ] },
  '/api/retail-admin/shops/51': { success: true, data: { shop: SHOP, listings: LISTINGS } },
  '/api/retail-admin/shops/52': { success: true, data: { shop: SHOP_EMPTY, listings: [] } },
};

// The shell around the section: the real <main> the tab switcher owns, with
// the stubs 28-shops.js reaches for. goTab is what lights `.active`; here it
// does exactly the class flip 01-core.js does, and nothing else.
function shell(lang) {
  return `<!doctype html><html${lang === 'cn' ? ' lang="zh"' : ''}><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body>
    <main>
      <section id="tab-sales"><div style="height:400px">sales</div></section>
      ${sectionMarkup}
    </main>
    <script>
      window.__FIX = ${JSON.stringify(FIXTURES)};
      window.api = async (p) => { const j = window.__FIX[p.split('?')[0]]; if (!j) throw Object.assign(new Error('no fixture ' + p), { code: 'not_found' }); return j; };
      window.cuT = (en, cn) => (${JSON.stringify(lang)} === 'cn' ? cn : en);
      window.cuLang = () => ${JSON.stringify(lang)};
      window.onLangChange = () => {};
      window.toast = () => {};
      window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.acMoney = n => '¥' + Number(n || 0).toFixed(2);
      window.acCurrencySymbol = () => '¥';
      window.can = () => true;
      window.applyCapGates = () => {};
      window.tdErrorText = (code, msg) => msg || code;
      window.goTab = (tab) => {
        document.querySelectorAll('main > section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
      };
    </script>
    <script>${SHOPS_JS.replace(/<\/script>/gi, '<\\/script>')}</script>
  </body></html>`;
}

(async () => {
  // Resolve the browser BEFORE launching, the way every sibling render suite
  // does. A null here is the only honest skip; a throw from launch() with a
  // real binary in hand is a fault and must not be swallowed as "no Chromium".
  const chrome = findChrome();
  if (!chrome) {
    console.log('\nSKIP — no Chromium found. Set CHROME_BIN to run the render pass.');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
    return;
  }
  let browser;
  const { chromium } = require('playwright');
  browser = await chromium.launch({ executablePath: chrome });

  // Open the page as the Sales card does and wait for the paint that follows
  // the fixture fetches, then measure the named elements.
  async function mount(lang, code, selectors) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message || e)));
    await page.setContent(shell(lang));
    await page.evaluate(c => window.shopMenuOpen(c), code);
    await page.waitForFunction(() => {
      const r = document.getElementById('shp-root');
      return r && r.children.length > 0 && !r.textContent.includes('Loading') && !r.textContent.includes('加载中');
    }, null, { timeout: 5000 });
    const out = await page.evaluate((sels) => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, display: getComputedStyle(el).display }; };
      const res = { body: document.body.className, section: box(document.getElementById('tab-shop-menu')) };
      for (const s of sels) { const el = document.querySelector(s); res[s] = el ? box(el) : null; }
      res.text = document.getElementById('shp-root').textContent;
      // The vacuity proof: the SAME rendered fragment, re-wrapped in a bare
      // <section>, under the same stylesheet. It must compute to nothing.
      const root = document.getElementById('shp-root');
      const wrap = document.createElement('section');
      wrap.innerHTML = root.innerHTML;
      root.parentNode.appendChild(wrap);
      res.rewrapped = box(wrap);
      wrap.remove();
      return res;
    }, selectors);
    await page.close();
    return { ...out, errors };
  }

  try {
    console.log('\nMounted — a shop with listings (EN)');
    const full = await mount('en', LOC.code, ['.shp-head', '.shp-title', '.shp-code code', '.shp-details', '.shp-table', '.shp-table tbody tr', '.shp-sw']);
    it('the page ran without a script error', () => assert.deepStrictEqual(full.errors, []));
    it('body carries shp-viewing and #tab-shop-menu is display:flex with height', () => {
      assert.ok(/\bshp-viewing\b/.test(full.body), full.body);
      assert.strictEqual(full.section.display, 'flex');
      assert.ok(full.section.h > 100, `section height ${full.section.h}`);
    });
    for (const s of ['.shp-head', '.shp-title', '.shp-code code', '.shp-details', '.shp-table', '.shp-table tbody tr', '.shp-sw']) {
      it(`${s} is on screen with a non-zero box`, () => {
        assert.ok(full[s], `${s} not rendered`);
        assert.notStrictEqual(full[s].display, 'none');
        assert.ok(full[s].w > 0 && full[s].h > 0, `${s} box ${JSON.stringify(full[s])}`);
      });
    }
    it('both listings and the code are in the rendered text', () => {
      assert.ok(full.text.includes('Oat latte') && full.text.includes('Granola 500g'), full.text.slice(0, 200));
      assert.ok(full.text.includes(SHOP.public_code));
    });
    it('the identical fragment re-wrapped in a bare <section> computes to zero — the guard is live', () => {
      assert.strictEqual(full.rewrapped.display, 'none');
      assert.strictEqual(full.rewrapped.h, 0);
    });

    console.log('\nMounted — a shop with listings (中文)');
    const cn = await mount('cn', LOC.code, ['.shp-head', '.shp-table']);
    it('the page ran without a script error', () => assert.deepStrictEqual(cn.errors, []));
    it('header and table have height in Chinese too', () => {
      assert.ok(cn['.shp-head'].h > 0 && cn['.shp-table'].h > 0, JSON.stringify([cn['.shp-head'], cn['.shp-table']]));
    });
    it('the Chinese screen name and the mode words are the supplied ones', () => {
      assert.ok(cn.text.includes('门店商品'), 'screen name');
      assert.ok(cn.text.includes('现做') && cn.text.includes('备货'), 'modes');
      assert.ok(cn.text.includes('类型'), 'mode column');
    });

    console.log('\nMounted — a shop with no listings');
    const empty = await mount('en', LOC_EMPTY.code, ['.shp-head', '.shp-details', '.shp-empty']);
    it('the page ran without a script error', () => assert.deepStrictEqual(empty.errors, []));
    it('the empty state is on screen with a non-zero box', () => {
      assert.ok(empty['.shp-empty'], 'no .shp-empty');
      assert.ok(empty['.shp-empty'].h > 0, JSON.stringify(empty['.shp-empty']));
      assert.ok(empty.text.includes('No products yet'));
    });

    console.log('\nMounted — a location with no shop');
    const none = await mount('en', LOC_NONE.code, ['.shp-head', '#shp-create', '.shp-empty']);
    it('the page ran without a script error', () => assert.deepStrictEqual(none.errors, []));
    it('the Set up CTA and the not-set-up state are on screen', () => {
      assert.ok(none['#shp-create'] && none['#shp-create'].h > 0, JSON.stringify(none['#shp-create']));
      assert.ok(none['.shp-empty'] && none['.shp-empty'].h > 0, JSON.stringify(none['.shp-empty']));
      assert.ok(none.text.includes('Not set up'));
    });
    it('no code is shown for a location with no shop', () => {
      assert.ok(!none.text.includes(SHOP.public_code) && !none.text.includes(SHOP_EMPTY.public_code));
    });
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
