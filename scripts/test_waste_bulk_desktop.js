#!/usr/bin/env node
/**
 * §423 — THE DESKTOP'S WASTE LIST: build a list of losses in the Record dialog
 * and record them in one go.
 *
 *   node scripts/test_waste_bulk_desktop.js
 *
 * Drives the REAL public/retail-admin/20-waste.js and the REAL dialog shell
 * (public/tacet-dialogs.js) in Chromium, with only the network and a few
 * globals stubbed — the nearest thing to the live screen without a server.
 * Logic is pinned for the phone in test_mobile_waste_list.js and for the server
 * in test_waste_bulk.js; this file is the third client of the same endpoint.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's. A missing
 * browser SKIPS and exits 0 on a laptop; under REQUIRE_BROWSER=1 it fails.
 */
'use strict';
/* The page-side callbacks passed to page.evaluate() run in the browser, so they use its globals. */
/* global window, document, getComputedStyle */

const fs = require('fs');
const path = require('path');
const { findChrome } = require('./lib/m-probe');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const exe = findChrome();
if (!exe) {
  console.log('SKIP — no Chromium found');
  process.exit(process.env.REQUIRE_BROWSER === '1' ? 1 : 0);
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n── ' + t); }

const REASONS = [
  { code: 'spoiled', en: 'Spoiled', cn: '变质' }, { code: 'expired', en: 'Expired', cn: '过期' },
  { code: 'damaged', en: 'Damaged', cn: '损坏' }, { code: 'other', en: 'Other', cn: '其他' },
];
const PRODUCTS = [
  { id: 9, name_en: 'Oat milk 1L', name_cn: '燕麦奶', sku: '10188', on_hand: 18 },
  { id: 11, name_en: 'Sourdough loaf', name_cn: '酸种面包', sku: 'A11', on_hand: 6 },
];

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.setContent('<!doctype html><html><body><div id="tab-waste"><div id="wst-root"></div></div></body></html>');
  await page.evaluate((fx) => {
    window.__calls = [];
    window.__toasts = [];
    window.__bulk = null;          // what the next bulk POST does: { ok, data } | { err }
    window.cuT = (en) => en;
    window.CAPS = new Set(['waste:view', 'waste:record', 'waste:costs']);
    window.toast = (m) => window.__toasts.push(String(m));
    window.api = async (p, opts) => {
      const method = ((opts && opts.method) || 'GET').toUpperCase();
      window.__calls.push({ p, method, body: opts && opts.body ? JSON.parse(JSON.stringify(opts.body)) : null });
      if (p.startsWith('/api/retail-admin/stores')) return { success: true, data: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店' }] };
      if (p.startsWith('/api/retail-admin/waste/reasons')) return { success: true, data: fx.REASONS };
      if (p.startsWith('/api/retail-admin/waste/products')) return { success: true, data: fx.PRODUCTS };
      if (p.startsWith('/api/retail-admin/waste/preview')) return { success: true, data: { cost_total_cents: 400, is_uncosted: 0 } };
      if (p === '/api/retail-admin/waste/bulk') {
        const b = window.__bulk;
        if (b && b.err) { const e = new Error(b.err.code); e.code = b.err.code; e.data = b.err; throw e; }
        return { success: true, data: (b && b.data) || [] };
      }
      if (p === '/api/retail-admin/waste' && method === 'POST') return { success: true, data: { cost_total_cents: 400, is_uncosted: 0 } };
      if (p.startsWith('/api/retail-admin/waste')) return { success: true, data: [], totals: null };
      return { success: true, data: [] };
    };
  }, { REASONS, PRODUCTS });
  // The real stylesheet, so the bounded-list rule is the one that ships.
  await page.addStyleTag({ content: read('public/retail-admin.css') });
  await page.addScriptTag({ content: read('public/tacet-dialogs.js') });
  await page.addScriptTag({ content: read('public/retail-admin/20-waste.js') });
  await page.evaluate(() => window.wasteInit());
  await page.waitForSelector('#wst-new');

  const modal = () => page.$('.wst-modal');
  // The dialog shell hands focus to the product field a moment after it opens.
  // Wait for that, or a quick script types into whichever field it reached first
  // and the shell then takes focus away mid-edit — a race in the test, not the app.
  const open = async () => {
    await page.click('#wst-new');
    await page.waitForSelector('#wst-r-prod');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'wst-r-prod');
  };
  // Choose a product from the picker, as a person would: focus, then take a row.
  // Typing, not just focusing: the field hides its list 160ms after a blur, and
  // a refocus inside that window would have its fresh list hidden again. The
  // debounced search a keystroke starts lands after that timer, every time.
  const pickProduct = async (id) => {
    await page.fill('#wst-r-prod', 'o');
    await page.waitForSelector(`[data-pid="${id}"]`);
    await page.dispatchEvent(`[data-pid="${id}"]`, 'mousedown');
  };
  const submitText = () => page.$eval('[data-submit]', (b) => b.textContent.trim());
  const submitOff = () => page.$eval('[data-submit]', (b) => b.disabled);
  const hint = () => page.$eval('#wst-r-hint', (h) => h.textContent.trim());
  const rows = () => page.$$eval('.wst-li', (r) => r.length);

  section('1 · opening');
  await open();
  check('the reason starts at Expired', await page.$eval('#wst-r-reason', (s) => s.value), 'expired');
  check('no Add to list before a product is chosen', await page.$eval('[data-add]', (b) => b.hidden), true);
  check('no list yet', await page.$eval('#wst-r-list', (l) => l.hidden), true);
  check('Record is dead, as ever', await submitOff(), true);

  section('2 · adding to the list');
  await pickProduct(9);
  await page.fill('#wst-r-qty', '4');
  check('Add to list is offered and live', await page.$eval('[data-add]', (b) => !b.hidden && !b.disabled), true);
  await page.click('[data-add]');
  check('the line is on the list', await rows(), 1);
  check('the list is shown', await page.$eval('#wst-r-list', (l) => l.hidden), false);
  check('the product half starts over', await page.$eval('#wst-r-prod', (i) => i.value), '');
  check('the quantity is back to one', await page.$eval('#wst-r-qty', (i) => i.value), '1');
  check('the reason is kept for the next line', await page.$eval('#wst-r-reason', (s) => s.value), 'expired');
  check('Record now records the list', [await submitText(), await submitOff()], ['Record 1 item', false]);
  check('the store cannot change under a list', await page.$eval('#wst-r-loc', (s) => s.disabled), true);
  check('the line shows its reason and quantity',
    await page.$eval('.wst-li', (r) => [r.querySelector('.wst-li-r').value, r.querySelector('.wst-li-q').value]), ['expired', '4']);

  await pickProduct(11);
  await page.fill('#wst-r-qty', '2');
  await page.selectOption('#wst-r-reason', 'damaged');
  await page.click('[data-add]');
  check('a second line, with its own reason', [await rows(), await page.$$eval('.wst-li-r', (s) => s.map((x) => x.value))], [2, ['expired', 'damaged']]);
  check('the foot counts them', await submitText(), 'Record 2 items');

  section('3 · the list refuses, and says which product');
  await page.selectOption('.wst-li[data-i="0"] .wst-li-r', 'other');
  check('"other" with no note is blocked, naming the product', [await submitOff(), await hint()], [true, 'Tell us what happened for Oat milk 1L.']);
  check('a note field appears on that line only', await page.$$eval('.wst-li-note', (n) => n.length), 1);
  await page.fill('.wst-li-note', 'dropped on the floor');
  check('with a note it is live again', [await submitOff(), await hint()], [false, '']);
  await page.fill('.wst-li[data-i="1"] .wst-li-q', '9');
  check('more than the shelf holds is blocked, naming the product', [await submitOff(), await hint()], [true, 'Only 6 of Sourdough loaf in stock.']);
  await page.fill('.wst-li[data-i="1"] .wst-li-q', '2');
  await pickProduct(9);
  check('a product chosen but not added blocks Record, and says to add it',
    [await submitOff(), await hint()], [true, 'Add the chosen product to the list first.']);
  await page.fill('#wst-r-prod', '');
  await page.dispatchEvent('#wst-r-prod', 'input');

  section('4 · the server refuses a line: the list stays whole');
  await page.evaluate(() => { window.__bulk = { err: { code: 'insufficient_stock', line: 1, on_hand: 1, requested: 2 } }; window.__calls.length = 0; });
  check('Record is live', await submitOff(), false);
  await page.click('[data-submit]');
  await page.waitForFunction(() => /Nothing has changed/.test(document.querySelector('#wst-r-hint').textContent));
  check('it names the line and the figures',
    await hint(), 'Line 2: only 1 in stock, 2 asked. Nothing has changed.');
  check('that line is marked', await page.$$eval('.wst-li', (r) => r.map((x) => x.classList.contains('bad'))), [false, true]);
  check('the list is kept whole, in the dialog', [await rows(), !!(await modal())], [2, true]);
  check('and the button is usable again', await submitOff(), false);
  check('no toast for a failure', await page.evaluate(() => window.__toasts.length), 0);

  section('5 · success: one request, then the toast');
  await page.evaluate(() => {
    window.__bulk = { data: [{ id: 1, cost_total_cents: 1600, is_uncosted: 0 }, { id: 2, cost_total_cents: 3400, is_uncosted: 0 }] };
    window.__calls.length = 0;
  });
  await page.click('[data-submit]');
  await page.waitForFunction(() => window.__toasts.length > 0);
  const bulkCalls = await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST'));
  check('exactly one write', bulkCalls.length, 1);
  check('to /waste/bulk', bulkCalls[0].p, '/api/retail-admin/waste/bulk');
  check('with every line, its own reason and note', bulkCalls[0].body, { location_id: 1, items: [
    { store_product_id: 9, qty: 4, reason_code: 'other', note: 'dropped on the floor' },
    { store_product_id: 11, qty: 2, reason_code: 'damaged', note: null },
  ] });
  check('the toast says how many, with the total', await page.evaluate(() => window.__toasts[0]), 'Recorded 2 items · ¥50.00');
  await page.waitForFunction(() => !document.querySelector('.wst-modal'), null, { timeout: 3000 });
  check('the dialog closed', !!(await modal()), false);

  section('6 · without waste:costs the toast carries no money');
  await page.evaluate(() => {
    window.CAPS = new Set(['waste:view', 'waste:record']);
    window.__toasts.length = 0;
    window.__bulk = { data: [{ id: 3 }] };
  });
  await open();
  await pickProduct(9);
  await page.click('[data-add]');
  await page.click('[data-submit]');
  await page.waitForFunction(() => window.__toasts.length > 0);
  check('count only', await page.evaluate(() => window.__toasts[0]), 'Recorded 1 item');
  await page.waitForFunction(() => !document.querySelector('.wst-modal'), null, { timeout: 3000 });
  await page.evaluate(() => { window.CAPS = new Set(['waste:view', 'waste:record', 'waste:costs']); });

  section('7 · the single entry is untouched when the list is empty');
  await open();
  check('Record says Record waste', await submitText(), 'Record waste');
  await pickProduct(9);
  await page.fill('#wst-r-qty', '3');
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.waitForFunction(() => !document.querySelector('[data-submit]').disabled);
  await page.click('[data-submit]');
  await page.waitForFunction(() => window.__calls.some((c) => c.method === 'POST'));
  const single = await page.evaluate(() => window.__calls.filter((c) => c.method === 'POST'));
  check('one POST, to the single endpoint', [single.length, single[0].p], [1, '/api/retail-admin/waste']);
  check('with the old body', single[0].body, { location_id: 1, subject_type: 'product', store_product_id: 9, qty: 3, reason_code: 'expired', note: null });
  await page.waitForFunction(() => !document.querySelector('.wst-modal'), null, { timeout: 3000 });

  section('8 · removing the last line returns to the single entry');
  await open();
  await pickProduct(9);
  await page.click('[data-add]');
  check('a line', await rows(), 1);
  await page.click('.wst-li [data-rm]');
  check('gone', await rows(), 0);
  check('the list hides again', await page.$eval('#wst-r-list', (l) => l.hidden), true);
  check('the store can change again', await page.$eval('#wst-r-loc', (s) => s.disabled), false);
  check('Record is Record waste again', await submitText(), 'Record waste');

  section('9 · the dialog stays bounded');
  for (let i = 0; i < 12; i++) { await pickProduct(i % 2 ? 11 : 9); await page.click('[data-add]'); }
  const box = await page.$eval('#wst-r-list', (l) => ({ h: l.getBoundingClientRect().height, sh: l.scrollHeight, oy: getComputedStyle(l).overflowY }));
  check('twelve more lines do not grow the dialog: the box stops at 240px and scrolls',
    [box.oy, box.h <= 241, box.sh > box.h], ['auto', true, true]);

  check('no script errors on the page', pageErrors, []);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
