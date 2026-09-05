#!/usr/bin/env node
/**
 * test_new_merchant_locale.js — what a new merchant is given on day one.
 *
 *   node scripts/test_new_merchant_locale.js
 *
 * Audit D-08 (a new merchant is given yuan amounts, two languages and a green),
 * H-01 (the first ten minutes assume the merchant is the first merchant) and
 * H-03 (a new shop may have no web address at all).
 *
 * The defect in one sentence: forty-three settings were seeded and none of them
 * was a choice, while currency, time zone, country, units and tax were not
 * seeded AT ALL and fell back to yuan and Guangzhou time. A bakery in
 * Manchester opened a shop priced in ¥, closing its books at 4pm local, with a
 * Chinese tab bar and a free-shipping threshold of 399 nobody chose.
 *
 * H-02 is deliberately NOT covered: the audit's own suggested direction is
 * "none — this is a sequencing decision, not a defect". The public door being a
 * waiting list is a choice about when to open, not something to fix.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const L = require('../lib/locale-defaults');
const { buildDefaultConfig } = require('../lib/provision-tenant');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const cfgFor = (country, over) =>
  Object.fromEntries(buildDefaultConfig('Acme', L.resolveLocale({ country, ...(over || {}) })));

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe four answers are answers now');

it('a merchant in Britain is priced in pounds, not yuan', () => {
  const c = cfgFor('GB');
  assert.strictEqual(c.currency.code, 'GBP');
  assert.strictEqual(c.currency.symbol, '£');
});

it('…keeps their own time, not Guangzhou\'s', () => {
  assert.strictEqual(cfgFor('GB')['shop.timezone'], 'Europe/London');
  assert.strictEqual(cfgFor('US')['shop.timezone'], 'America/New_York');
});

it('…and does not get a Chinese tab bar', () => {
  assert.strictEqual(cfgFor('GB')['theme.language'], 'en');
  // While a merchant in China still does, because there it is right.
  assert.strictEqual(cfgFor('CN')['theme.language'], 'bilingual');
});

it('a zero-decimal currency is respected — yen has no cents', () => {
  assert.strictEqual(cfgFor('JP').currency.decimals, 0);
  assert.strictEqual(cfgFor('KR').currency.decimals, 0);
  // And 0 must survive: `decimals || 2` would quietly make it 2.
  assert.strictEqual(L.resolveLocale({ country: 'JP', currency: { decimals: 0 } }).currency.decimals, 0);
});

it('a symbol that goes after the number goes after it', () => {
  assert.strictEqual(cfgFor('FR').currency.position, 'after');
  assert.strictEqual(cfgFor('GB').currency.position, 'before');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe yuan numbers do not follow the merchant abroad');

it('a merchant in yuan keeps every default they had — nothing moves for them', () => {
  const c = cfgFor('CN');
  assert.strictEqual(c['fees.freeShippingThreshold'], 399);
  assert.strictEqual(c['fees.standardShipping'], 12);
  assert.strictEqual(c['fees.sameDayDelivery'], 18);
  assert.strictEqual(c['points.redeemRate'], 1);
  assert.strictEqual(c['points.earnSpend'], 100);
});

it('a merchant anywhere else starts with the money UNSET, not converted', () => {
  // £399 free shipping and a £12 delivery fee are numbers nobody chose that
  // look exactly like numbers somebody did. Converting them would be worse
  // still: there is no exchange rate here and the prices are not converted
  // either, so the result would be confidently wrong rather than obviously
  // absent.
  for (const cc of ['GB', 'US', 'JP', 'DE']) {
    const c = cfgFor(cc);
    for (const k of ['fees.freeShippingThreshold', 'fees.standardShipping',
                     'fees.sameDayDelivery', 'points.redeemRate', 'points.earnSpend']) {
      assert.ok(!(k in c), `${cc} should not be given ${k}`);
    }
  }
});

it('everything that is NOT money is still seeded everywhere', () => {
  // The fix must not leave a merchant abroad with a blank shop.
  for (const cc of ['GB', 'CN', 'ZZ']) {
    const c = cfgFor(cc);
    for (const k of ['theme.accent', 'shop.layout', 'tabBar.items', 'brand.me_footer',
                     'delivery.holidayMessage', 'affiliate.enabled']) {
      assert.ok(k in c, `${cc} lost ${k}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nWhat happens when nobody says');

it('an unknown country is NEUTRAL, not China', () => {
  // Falling back to the first merchant's country is the defect itself. A
  // merchant obviously has to change UTC/USD; they may never notice ¥/Shanghai.
  const c = cfgFor('ZZ');
  assert.strictEqual(c.currency.code, 'USD');
  assert.strictEqual(c['shop.timezone'], 'UTC');
  assert.notStrictEqual(c.currency.code, 'CNY');
  assert.notStrictEqual(c['shop.timezone'], 'Asia/Shanghai');
});

it('no answer at all is still not China', () => {
  const r = L.resolveLocale({});
  assert.strictEqual(r.country, null, 'nobody said — and null says so');
  assert.strictEqual(r.currency.code, 'USD');
  assert.strictEqual(r.timezone, 'UTC');
});

it('anything the merchant actually chose beats the country', () => {
  const r = L.resolveLocale({ country: 'GB', currency: { code: 'eur', symbol: '€' }, language: 'cn', timezone: 'Asia/Tokyo' });
  assert.strictEqual(r.currency.code, 'EUR');
  assert.strictEqual(r.language, 'cn');
  assert.strictEqual(r.timezone, 'Asia/Tokyo');
});

it('a nonsense language falls back rather than reaching the shop', () => {
  assert.strictEqual(L.resolveLocale({ country: 'GB', language: 'klingon' }).language, 'en');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe business day follows the answer before there is a store');

it('lib/business-date.js reads shop.timezone when no location has one', () => {
  let Database; try { Database = require('better-sqlite3'); } catch (e) { return; }
  const B = require('../lib/business-date');
  const mk = (stores, tz) => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE retail_stores (id INTEGER PRIMARY KEY,is_active INT,sort_order INT,timezone TEXT)');
    db.exec('CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT)');
    stores.forEach(r => db.prepare('INSERT INTO retail_stores VALUES (?,?,?,?)').run(...r));
    if (tz) db.prepare('INSERT INTO storefront_config VALUES (?,?)').run('shop.timezone', JSON.stringify(tz));
    return db;
  };
  // A brand-new account has no store for days — creating one is a manual
  // onboarding step — and the first orders can arrive before it happens.
  assert.strictEqual(B.shopTimezone(mk([], 'Europe/London')), 'Europe/London');
  assert.strictEqual(B.sqlDayShiftForShop(mk([], 'Europe/London'), new Date('2026-01-15T12:00:00Z')), '+0 minutes');
  // A real location still wins: where the trading happens beats a sign-up form.
  assert.strictEqual(B.shopTimezone(mk([[1, 1, 1, 'Asia/Tokyo']], 'Europe/London')), 'Asia/Tokyo');
  // Neither: the documented +8 fallback, unchanged.
  assert.strictEqual(B.shopTimezone(mk([], null)), null);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nH-03 — a shop with no address says so');

const PROV = fs.readFileSync(path.join(ROOT, 'lib', 'provision-tenant.js'), 'utf8');
const SIGNUP_JS = fs.readFileSync(path.join(ROOT, 'routes', 'backend-signup.js'), 'utf8');
const SIGNUP_HTML = fs.readFileSync(path.join(ROOT, 'public', 'backend-signup.html'), 'utf8');

it('provisioning REPORTS a missing address instead of skipping in silence', () => {
  assert.match(PROV, /storefrontHost/, 'the result must carry the address');
  assert.match(PROV, /HAS NO WEB ADDRESS/, 'and say so loudly when there is none');
  assert.match(PROV, /alertPlatform\(/, 'a base domain nobody configured is the platform’s to fix');
});

it('it is still best-effort — a DNS setting must not undo a created account', () => {
  const at = PROV.indexOf('let storefrontHost = null;');
  assert.ok(at > 0);
  const block = PROV.slice(at, at + 1400);
  assert.match(block, /try \{/, 'the assign stays wrapped');
  assert.match(block, /alerting must never fail a provision/, 'and so does the alert');
});

it('the sign-up page does not imply a shop that does not exist', () => {
  assert.match(SIGNUP_HTML, /no web address yet/);
  assert.match(SIGNUP_JS, /storefront: r\.storefrontHost \|\| null/);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe question is asked, and its consequence is shown');

it('sign-up asks ONE question, not four', () => {
  assert.match(SIGNUP_HTML, /id="country"/);
  // Currency/time zone/language are shown, not asked — four dropdowns on the
  // first screen a merchant sees is how a sign-up gets abandoned.
  for (const id of ['id="currency"', 'id="timezone"', 'id="language"']) {
    assert.ok(!SIGNUP_HTML.includes(id), `${id} should be implied by the country, not asked`);
  }
});

it('and shows what the answer implies, so it can be disagreed with', () => {
  assert.match(SIGNUP_HTML, /paintLocaleHint/);
  assert.match(SIGNUP_HTML, /Currency ' \+ L\.currency/);
});

it('nothing is pre-selected — a default here is the bug being fixed', () => {
  assert.match(SIGNUP_HTML, /Choose… · 请选择…/);
  assert.match(SIGNUP_HTML, /selected disabled/);
});

it('the status endpoint serves the list and what each implies', () => {
  assert.match(SIGNUP_JS, /countries: options/);
  assert.match(SIGNUP_JS, /timezone: L\.timezone/);
});

it('the four answers reach provisioning', () => {
  assert.match(SIGNUP_JS, /country, currency, timezone, language,/);
  assert.match(PROV, /country, currency, timezone, language \}\) \{/);
  assert.match(PROV, /const locale = resolveLocale\(/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
