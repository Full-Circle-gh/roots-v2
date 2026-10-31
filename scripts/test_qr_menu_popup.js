#!/usr/bin/env node
/**
 * §509 — the QR menu can show its own pop-up when it opens.
 *
 *   node scripts/test_qr_menu_popup.js
 *
 * The mini app's pop-ups stay the mini app's. "All pages" does not put one
 * on the table menu. A pop-up reaches the menu only when QR menu is picked,
 * so the menu can say something the mini app does not.
 *
 * The filter is pure. The page assertion is the real menu route: a pop-up
 * aimed at the mini app is absent, and one aimed at the menu is in the HTML,
 * hidden, with both languages and the product its button adds.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const pop = require(path.join(ROOT, 'lib/qr-menu-popup'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const NOW = Date.parse('2026-10-31T04:00:00Z');
function pu(over) {
  return Object.assign({
    id: 'pu_qr', enabled: true, name: 'secret-admin-name', pages: ['qr-menu'],
    trigger: 'on_load', delay_seconds: 0, frequency: 'once',
    start_at: '', end_at: '', image_url: '', dismissible: true,
    title_en: 'Table welcome', title_cn: '店里欢迎',
    body_en: 'Try the latte', body_cn: '试试拿铁',
    cta_label_en: 'Add', cta_label_cn: '添加', cta_target: 'product:9711',
    updated_at: 42,
  }, over);
}

console.log('\nWhich pop-up the menu may show');
check('a mini-app pop-up, including All pages, is not the menu\'s', () => {
  const out = pop.forMenu([
    pu({ id: 'mini', pages: ['all'], title_en: 'Mini only' }),
    pu({ id: 'home', pages: ['home'], title_en: 'Home only' }),
    pu({ id: 'shop', pages: ['shop', 'cart'], title_en: 'Shop only' }),
  ], NOW);
  assert.deepStrictEqual(out, []);
});
check('QR menu is picked on its own, and All pages plus QR menu is the same pop-up on purpose', () => {
  const out = pop.forMenu([
    pu({ id: 'mini', pages: ['all'], title_en: 'Mini only' }),
    pu({ id: 'menu', pages: ['qr-menu'], title_en: 'Table welcome' }),
    pu({ id: 'both', pages: ['all', 'qr-menu'], title_en: 'Shared on purpose' }),
  ], NOW);
  assert.deepStrictEqual(out.map(p => p.id), ['menu', 'both']);
});
check('off, not started, and already ended stay off the menu', () => {
  const out = pop.forMenu([
    pu({ id: 'off', enabled: false }),
    pu({ id: 'soon', start_at: '2026-11-01' }),
    pu({ id: 'done', end_at: '2026-10-30' }),
    pu({ id: 'today', start_at: '2026-10-31', end_at: '2026-10-31' }),
    pu({ id: 'noid', id: '' }),
  ], NOW);
  assert.deepStrictEqual(out.map(p => p.id), ['today']);
});
check('the office\'s internal name stays off the page, and a script address is not a picture', () => {
  const [p] = pop.forMenu([pu({ image_url: 'javascript:alert(1)', name: 'secret-admin-name' })], NOW);
  assert.strictEqual(p.image_url, '');
  assert.ok(!('name' in p));
  const [ok] = pop.forMenu([pu({ image_url: '/api/retail/media/9' })], NOW);
  assert.strictEqual(ok.image_url, '/api/retail/media/9');
});
check('seen once stays seen; a new version, a new day, and a new session each show again', () => {
  const today = pop.todayUtc(NOW);
  assert.strictEqual(pop.showable('once', { day: today }, null, today), false);
  assert.strictEqual(pop.showable('once', null, null, today), true);
  assert.strictEqual(pop.showable('daily', { day: '2026-10-30' }, null, today), true);
  assert.strictEqual(pop.showable('daily', { day: today }, null, today), false);
  assert.strictEqual(pop.showable('session', { day: today }, null, today), true);
  assert.strictEqual(pop.showable('session', null, { day: today }, today), false);
  assert.strictEqual(pop.showable('every_visit', { day: today }, { day: today }, today), true);
});

console.log('\nThe editors offer QR menu, and All pages does not swallow it');
const desktop = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const phone = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const mini = fs.readFileSync(path.join(ROOT, 'miniapp/components/popup-manager/popup-manager.js'), 'utf8');
check('the computer and the phone both name the page with the live pair', () => {
  assert.ok(desktop.includes("['qr-menu',      'QR menu · 二维码菜单']"));
  assert.ok(phone.includes("'qr-menu':['QR menu','二维码菜单']"));
  assert.ok(desktop.includes("k === 'qr-menu' && qrOn"));
  assert.ok(phone.includes("PUE.d.pages=on?(qr?['qr-menu']:[]):(qr?['all','qr-menu']:['all'])"));
});
check('the mini app still does not treat the menu as one of its pages', () => {
  assert.ok(!mini.includes('qr-menu'));
});

// ── The real menu page ────────────────────────────────────────────────────
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib/tenant-db.js'));
const router = require(path.join(ROOT, 'routes/shop-menu.js'));
const db = tdb();

const LOC = 9611;
const CODE = 'QRPU7K2M';
const PID = 9711;

function cleanupShop() {
  db.prepare('DELETE FROM shop_listings WHERE shop_id IN (SELECT id FROM shops WHERE location_id = ?)').run(LOC);
  db.prepare('DELETE FROM shops WHERE location_id = ?').run(LOC);
  db.prepare('DELETE FROM retail_store_stock WHERE store_id = ?').run(LOC);
  db.prepare('DELETE FROM store_products WHERE id = ?').run(PID);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(LOC);
}

const prevPopup = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'popups.list'").get();
function restorePopups() {
  if (prevPopup) {
    db.prepare("UPDATE storefront_config SET value_json = ? WHERE key = 'popups.list'").run(prevPopup.value_json);
  } else {
    db.prepare("DELETE FROM storefront_config WHERE key = 'popups.list'").run();
  }
}
function setPopups(list) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json) VALUES ('popups.list', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify(list));
}

cleanupShop();
db.prepare(
  `INSERT INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (?,?,?,?,1,97)`
).run(LOC, '__test_qrpop', 'Popup fixture', '测试弹窗店');
db.prepare(
  `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_active, is_published, top_category)
   VALUES (?,?,?,?,?,1,1,?)`
).run(PID, 'Fixture latte', '测试拿铁', '__QP-1', 20, 'Drinks');
const shopId = db.prepare(
  'INSERT INTO shops (location_id, public_code, is_active) VALUES (?,?,1)'
).run(LOC, CODE).lastInsertRowid;
db.prepare(
  `INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)
   VALUES (?,?,?,?,1,0)`
).run(shopId, PID, 20, 'made_here');

setPopups([
  pu({ id: 'mini', pages: ['all'], title_en: 'Mini only', title_cn: '仅小程序', cta_label_en: '', cta_label_cn: '', cta_target: '' }),
  pu({ id: 'menu', pages: ['qr-menu'], title_en: 'Table welcome', title_cn: '店里欢迎', cta_target: 'product:' + PID }),
  pu({ id: 'off', pages: ['qr-menu'], enabled: false, title_en: 'Switched off' }),
]);

const app = express();
app.use(router);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/s/${CODE}`);
    const body = await res.text();
    check('the menu carries the pop-up aimed at it, hidden, in both languages', () => {
      assert.strictEqual(res.status, 200);
      assert.ok(body.includes('data-qr-pop="1"'), 'no pop-up panel');
      assert.ok(body.includes('hidden'), 'the panel is not hidden until the script shows it');
      assert.ok(body.includes('Table welcome') && body.includes('店里欢迎'));
      assert.ok(body.includes('Try the latte') && body.includes('试试拿铁'));
      assert.ok(body.includes('>Add<') || body.includes('Add</span>'), 'the add button is missing');
      assert.ok(body.includes('添加'));
      assert.ok(body.includes('data-cta="product:' + PID + '"'));
      assert.ok(body.includes('data-add="' + PID + '"'), 'the product the button adds is not on the menu');
      assert.ok(body.includes('popup_seen:'));
    });
    check('the mini app\'s own pop-up, and one that is off, are not on the menu', () => {
      assert.ok(!body.includes('Mini only') && !body.includes('仅小程序'));
      assert.ok(!body.includes('Switched off'));
      assert.ok(!body.includes('secret-admin-name'));
    });
    check('the stylesheet still has no angle bracket', () => {
      const sheet = (body.match(/<style>([\s\S]*)<\/style>/) || [])[1] || '';
      assert.ok(sheet.length > 0);
      assert.ok(!/[<>]/.test(sheet));
    });
  } finally {
    server.close();
    restorePopups();
    cleanupShop();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { restorePopups(); cleanupShop(); } catch (_) {}
  process.exit(1);
});
