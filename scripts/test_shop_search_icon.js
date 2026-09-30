#!/usr/bin/env node
/**
 * §295 — THE SHOP TAB'S SEARCH IS AN ICON UNTIL SOMEONE USES IT.
 *
 *   node scripts/test_shop_search_icon.js
 *
 * Ash, 2026-09-30: "instead of search bar the icon on top seems more
 * efficient". The full-width search row on the mini app's Shop tab became a
 * square button at the left of the layout-button row. What this pins:
 *
 *   1. the button is in the tool row and does NOT sit inside the layout
 *      switcher's wx:if — a locked layout must not take search away with it;
 *   2. the box stays open while anything is typed (a filtered list with the
 *      box folded away reads as a nearly empty shop);
 *   3. × clears and closes, and only re-fetches when there was a search;
 *   4. the button carries a screen-reader label in both languages, copied
 *      from the web shop's live `Search · 搜索`.
 *
 * The page's handlers are RUN, not grepped: a regex proves a line was
 * written, never that the state it sets is the state the WXML reads.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WXML = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxml'), 'utf8');
const WXSS = fs.readFileSync(path.join(ROOT, 'miniapp/pages/shop/shop.wxss'), 'utf8');
const WEB  = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');

let passed = 0, failed = 0;
function section(t) { console.log('\n' + t); }
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// ── The page, loaded and RUN (same shape as test_fresh_today_label.js) ─────
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'getStorageSync') return () => null;
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
      return () => {};
    },
  });
  try {
    const full = path.join(ROOT, relPath);
    delete require.cache[require.resolve(full)];
    require(full);
    return captured;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}
function makeCtx(page, patch) {
  const ctx = {
    ...page,   // the page's own helpers (_isNarrowed, _emptyCopy…), as shipped
    data: { ...JSON.parse(JSON.stringify(page.data)), ...(patch || {}) },
    setData(p) { Object.assign(this.data, p); },
    refreshes: 0,
    refresh() { this.refreshes++; },
  };
  return ctx;
}
// What the WXML shows, in the WXML's own words: the box when
// `searchOpen || query`, the button otherwise.
const boxShown = (d) => !!(d.searchOpen || d.query);

const page = loadMiniPage('miniapp/pages/shop/shop.js');
const lateChecks = [];

section('1 · the markup');
{
  it('the full-width search row is gone — no search bar outside the tool row', () => {
    assert.ok(WXML.includes('class="tool-row'), 'a .tool-row exists');
    const before = WXML.slice(0, WXML.indexOf('class="tool-row'));
    assert.ok(!/class="search-bar/.test(before), 'no search bar above the tool row');
    assert.strictEqual((WXML.match(/class="search-bar/g) || []).length, 1, 'exactly one search box, inside the row');
  });
  it('the search button is NOT inside the layout switcher\'s wx:if', () => {
    const btn = WXML.indexOf('class="search-btn"');
    const sw = WXML.indexOf('class="view-switcher"');
    assert.ok(btn > 0 && sw > 0, 'both exist');
    assert.ok(btn < sw, 'the button comes before the switcher, not within it');
    assert.ok(!/wx:if="\{\{!layoutLocked\}\}"[^>]*class="tool-row/.test(WXML), 'the row itself is never gated on layoutLocked');
  });
  it('the box is shown on searchOpen OR a typed query', () => {
    assert.ok(/wx:if="\{\{searchOpen \|\| query\}\}"\s+class="search-bar"/.test(WXML));
  });
  it('the button has a screen-reader label and a role', () => {
    assert.ok(/class="search-btn"[^>]*aria-role="button"[^>]*aria-label="\{\{searchLabel\}\}"/.test(WXML));
  });
  it('the icon asset exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'miniapp/assets/icons/search.svg')));
  });
  it('the removed classes left no styles behind', () => {
    assert.ok(!/\.search-bar-list|\.view-switcher-list|\.search-icon\b/.test(WXSS));
  });
}

section('2 · the handlers, run');
{
  it('a first visit shows the button, not the box', () => {
    const ctx = makeCtx(page);
    assert.strictEqual(boxShown(ctx.data), false);
  });
  it('tapping the button opens the box with the keyboard up', () => {
    const ctx = makeCtx(page);
    page.openSearch.call(ctx);
    assert.strictEqual(boxShown(ctx.data), true);
    assert.strictEqual(ctx.data.searchFocus, true);
  });
  it('leaving an EMPTY box folds it back to the button', () => {
    const ctx = makeCtx(page);
    page.openSearch.call(ctx);
    page.onSearchBlur.call(ctx);
    assert.strictEqual(boxShown(ctx.data), false);
  });
  it('leaving a box with a search typed KEEPS IT OPEN (the list is filtered)', () => {
    const ctx = makeCtx(page);
    page.openSearch.call(ctx);
    ctx.setData({ query: 'beet' });
    page.onSearchBlur.call(ctx);
    assert.strictEqual(boxShown(ctx.data), true);
    assert.strictEqual(ctx.data.query, 'beet');
    assert.strictEqual(ctx.data.searchFocus, false, 'keyboard goes down');
  });
  it('× clears the search, closes the box and re-fetches once', () => {
    const ctx = makeCtx(page, { query: 'beet', searchOpen: true });
    page.closeSearch.call(ctx);
    assert.strictEqual(ctx.data.query, '');
    assert.strictEqual(boxShown(ctx.data), false);
    assert.strictEqual(ctx.refreshes, 1);
  });
  it('× on an empty box closes it WITHOUT a request', () => {
    const ctx = makeCtx(page, { searchOpen: true });
    page.closeSearch.call(ctx);
    assert.strictEqual(boxShown(ctx.data), false);
    assert.strictEqual(ctx.refreshes, 0);
  });
  it('× cancels a search still waiting on its 300 ms timer', () => {
    const ctx = makeCtx(page, { searchOpen: true, query: 'be' });
    let fired = false;
    ctx._searchT = setTimeout(() => { fired = true; }, 1);
    page.closeSearch.call(ctx);
    assert.strictEqual(ctx._searchT, null, 'the pending timer is dropped');
    // Checked once more after the timer would have run, in the exit tick below.
    lateChecks.push(() => assert.strictEqual(fired, false, 'the stale search never ran'));
  });
}

section('3 · the label, both languages');
{
  it('English: Search · Chinese: 搜索', () => {
    const en = makeCtx(page); page._applyLang.call(en, 'en');
    const cn = makeCtx(page); page._applyLang.call(cn, 'cn');
    assert.strictEqual(en.data.searchLabel, 'Search');
    assert.strictEqual(cn.data.searchLabel, '搜索');
  });
  it('…copied from a live pair: the web shop\'s own search button', () => {
    assert.ok(/cn\?'搜索':'Search'/.test(WEB), 'public/shop.html still carries the pair');
  });
}

setTimeout(() => {
  it('(late) no cancelled timer fired', () => { for (const f of lateChecks) f(); });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 50);
