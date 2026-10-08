#!/usr/bin/env node
//
// test_touch_keyboard_focus.js — THE KEYBOARD THAT CAME BACK BY ITSELF.
//
// Ash, 2026-10-08, a photo of the counter tablet: the shop menu page (Sales →
// a location → Shop menu) with the on-screen keyboard up over the menu search
// box, and nobody had tapped it. Three ways the box got its caret back without
// a tap, and one guard for each:
//
//   1. The blue 搜索 key did nothing. Both search boxes on that page search as
//      you type, so the key had no job left, and the keyboard stayed up. It now
//      lets go of the box (28-shops.js shpSearchKey) — except when Enter is
//      the IME committing a pinyin candidate, which must reach the IME.
//   2. Android's ⌄ key hides the keyboard but leaves the caret in the box, and
//      waking the tablet hands the box its keyboard again. The page now lets
//      go of the search box as it goes out of sight, on touch screens only.
//   3. Closing a dialog hands focus back to what held it before. When that was
//      a text box on a touch screen, the hand-back IS the keyboard popping up.
//      tacet-dialogs.js now skips text fields there, and still hands focus back
//      to buttons, and to everything on a desk.
//
// USAGE   node scripts/test_touch_keyboard_focus.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const coarse = on => q => ({ matches: on && /pointer:\s*coarse/.test(q) });

// ── 28-shops.js ──────────────────────────────────────────────────────────
function bootShops(touch) {
  const listeners = {};
  const doc = {
    activeElement: null, hidden: false,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    body: { classList: { add() {}, remove() {} } },
  };
  const sandbox = {
    document: doc, console, setTimeout, clearTimeout, Promise, Date, Math, JSON,
    Set, Map, Array, Object, String, Number, RegExp, URLSearchParams,
    api: async () => ({ success: true, data: [] }), toast: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    history: { pushState() {}, back() {} },
    escapeHtml: s => String(s == null ? '' : s),
    cuT: en => en, cuLang: () => 'en', acMoney: n => '¥' + n, acCurrencySymbol: () => '¥',
    tdErrorText: (c, m) => m || c, can: () => true, applyCapGates: () => {},
    onLangChange: () => {}, goTab: () => {},
    matchMedia: coarse(touch),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '28-shops.js'), 'utf8'),
                  sandbox, { filename: '28-shops.js' });
  sandbox.shopMenuOpen('ramada');
  const field = id => { const f = { id, blurred: 0, blur() { this.blurred++; if (doc.activeElement === this) doc.activeElement = null; } }; return f; };
  const hide = () => { doc.hidden = true; (listeners.visibilitychange || []).forEach(fn => fn()); doc.hidden = false; };
  return { sandbox, doc, field, hide };
}

// ── tacet-dialogs.js ─────────────────────────────────────────────────────
function bootDialogs(touch) {
  const mk = (tag) => {
    const n = {
      tagName: String(tag || 'div').toUpperCase(), _on: {}, children: [], textContent: '',
      classList: { add() {}, remove() {} }, disabled: false, value: '',
      addEventListener(t, fn) { (this._on[t] || (this._on[t] = [])).push(fn); },
      click() { (this._on.click || []).forEach(fn => fn()); },
      focus() {}, remove() {}, appendChild(c) { this.children.push(c); return c; },
    };
    const btns = { '[data-submit]': mk.btn(), '[data-cancel]': mk.btn() };
    n.querySelector = sel => btns[sel] || null;
    n.querySelectorAll = sel => (btns[sel] ? [btns[sel]] : []);
    n._btns = btns;
    return n;
  };
  mk.btn = () => ({ _on: {}, disabled: false,
    addEventListener(t, fn) { (this._on[t] || (this._on[t] = [])).push(fn); },
    click() { (this._on.click || []).forEach(fn => fn()); }, focus() {} });
  let lastScrim = null;
  const doc = {
    activeElement: null,
    getElementById: () => null,
    createElement(tag) { const n = mk(tag); if (tag === 'div') lastScrim = n; return n; },
    addEventListener() {}, removeEventListener() {},
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  const sandbox = { document: doc, console, setTimeout, clearTimeout, Promise, Set, Map, Array, Object, String,
                    requestAnimationFrame: fn => setTimeout(fn, 0), matchMedia: coarse(touch) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'tacet-dialogs.js'), 'utf8'),
                  sandbox, { filename: 'tacet-dialogs.js' });
  // Open a confirm with `held` focused, press the submit button, and report
  // how many times focus was handed back to `held`.
  async function roundTrip(held) {
    held.focused = 0; held.focus = function () { this.focused++; };
    doc.activeElement = held;
    const p = sandbox.askConfirm({ title: 'Remove?' });
    lastScrim._btns['[data-submit]'].click();
    await p; await sleep(50);
    return held.focused;
  }
  return { roundTrip };
}

(async () => {
  console.log('\n══ The on-screen keyboard does not come back by itself');

  console.log('\n1. the search key lets go of the box');
  {
    const { sandbox, field } = bootShops(true);
    const f = field('shp-menu-q');
    let prevented = 0;
    sandbox.shpSearchKey({ key: 'Enter', target: f, preventDefault() { prevented++; } });
    ok(f.blurred === 1, 'Enter (the 搜索 key) blurs the menu search box');
    ok(prevented === 1, 'and does nothing else');
    const g = field('shp-pick-q');
    sandbox.shpSearchKey({ key: 'Enter', target: g, preventDefault() {} });
    ok(g.blurred === 1, 'the Add product search box behaves the same');
    const h = field('shp-menu-q');
    sandbox.shpSearchKey({ key: 'Enter', isComposing: true, target: h, preventDefault() {} });
    sandbox.shpSearchKey({ key: 'Enter', keyCode: 229, target: h, preventDefault() {} });
    ok(h.blurred === 0, 'an Enter that commits a pinyin candidate is left to the IME');
    sandbox.shpSearchKey({ key: 'a', target: h, preventDefault() {} });
    ok(h.blurred === 0, 'any other key is ignored');
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '28-shops.js'), 'utf8');
    ok((src.match(/enterkeyhint="search" onkeydown="shpSearchKey\(event\)"/g) || []).length === 2,
      'both search fields are wired to it');
  }

  console.log('\n2. going out of sight lets go of the search box, on a touch screen');
  {
    const { doc, field, hide } = bootShops(true);
    const f = field('shp-menu-q'); doc.activeElement = f; hide();
    ok(f.blurred === 1, 'screen off / app switch: the menu search box lets go');
    const g = field('shp-pick-q'); doc.activeElement = g; hide();
    ok(g.blurred === 1, 'and so does the Add product search box');
    const n = field('shp-name-en'); doc.activeElement = n; hide();
    ok(n.blurred === 0, 'a name field mid-edit is not touched');
  }
  {
    const { doc, field, hide } = bootShops(false);
    const f = field('shp-menu-q'); doc.activeElement = f; hide();
    ok(f.blurred === 0, 'on a desk the caret stays where it was');
  }

  console.log('\n3. closing a dialog does not put the caret back in a text box on a touch screen');
  {
    const { roundTrip } = bootDialogs(true);
    ok(await roundTrip({ tagName: 'INPUT', type: 'search' }) === 0, 'search box: focus not handed back');
    ok(await roundTrip({ tagName: 'INPUT', type: 'text' }) === 0, 'text box: focus not handed back');
    ok(await roundTrip({ tagName: 'TEXTAREA' }) === 0, 'textarea: focus not handed back');
    ok(await roundTrip({ tagName: 'BUTTON' }) === 1, 'a button still gets its focus back');
    ok(await roundTrip({ tagName: 'INPUT', type: 'checkbox' }) === 1, 'so does a checkbox');
  }
  {
    const { roundTrip } = bootDialogs(false);
    ok(await roundTrip({ tagName: 'INPUT', type: 'search' }) === 1, 'on a desk a text box still gets its focus back');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
