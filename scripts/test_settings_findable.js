#!/usr/bin/env node
/**
 * test_settings_findable.js — finding a setting, and knowing who sees it
 * (audit G-03).
 *
 *   node scripts/test_settings_findable.js
 *
 * THE FINDING. Settings holds more controls than any other screen — seven
 * panels, twenty-seven cards, nine dropdowns — and no search of its own. The
 * command palette can jump to a single card, and that was the mitigation, but
 * it only works for somebody who knows the NAME of the thing they want. On the
 * screen a merchant is least confident in, the name is exactly what they do not
 * have. And some settings change what customers see the moment they are saved
 * while nothing on screen distinguished those from the rest.
 *
 * The search is driven in a sandbox against a hand-built Settings screen, so
 * the matching rule can be checked rather than described.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const OPS  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');

// ── the two functions, lifted and driven ──────────────────────────────────
// _cfgCards() and cfgSearch() are the whole of the behaviour; the rest of
// 02-settings-ops.js is 4,000 lines of unrelated panel code, so the two are
// lifted out and given a Settings screen made of plain objects.
function loadSearch(screen) {
  const src = OPS.slice(OPS.indexOf('function _cfgCards('), OPS.indexOf('window.cfgSearch = cfgSearch;'));
  const sandbox = { console, cuT: (en) => en, escapeHtml: (s) => String(s == null ? '' : s) };
  sandbox.document = screen.document;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__cards = _cfgCards; this.__search = cfgSearch;', sandbox, { filename: 'cfg.js' });
  return sandbox;
}

// A Settings screen: panels, the nav buttons that open them, and cards.
function screenOf(panels) {
  const results = { value: '', innerHTML: '', hidden: true };
  const searchBox = { value: '' };
  const nav = {};
  const all = [];
  for (const p of panels) {
    nav['#settings-nav button[data-sub="' + p.sub + '"]'] = {
      textContent: p.name, hidden: !!p.hidden, offsetParent: p.hidden ? null : {},
    };
    const cards = p.cards.map((c) => ({
      _sees: c.sees,
      getAttribute: (k) => (k === 'data-sees' ? (c.sees ? 'customer' : null) : null),
      querySelector: (sel) => (sel === 'h3' ? { textContent: c.title } : null),
      textContent: c.title + ' ' + (c.body || ''),
      title: c.title,
    }));
    all.push(...cards);
    p._el = {
      id: 'sub-' + p.sub,
      querySelectorAll: (sel) => (sel === '.group-card, .card' ? cards : []),
    };
  }
  const document = {
    getElementById: (id) => (id === 'cfg-search' ? searchBox : id === 'cfg-search-results' ? results : null),
    querySelector: (sel) => nav[sel] || null,
    querySelectorAll: (sel) => (sel === '#tab-config .sub-panel' ? panels.map((p) => p._el) : []),
  };
  return { document, searchBox, results, all };
}

const PANELS = [
  { sub: 'shop', name: 'Shop tab · 商城页', cards: [
    { title: 'Layout · 布局', body: 'How the shop page is arranged', sees: true },
    { title: 'Currency · 货币', body: 'The money customers are quoted in', sees: true },
  ] },
  { sub: 'ops', name: 'Operations · 运营', cards: [
    { title: 'Receipt printing — Feie cloud printer · 飞鹅云打印出单', body: 'Print each order in the shop' },
    { title: 'Stores · 门店', body: 'Your locations, opening hours and delivery zones' },
  ] },
  { sub: 'sku', name: 'SKU codes · 编码规则', hidden: true, cards: [
    { title: 'Numbering · 编码', body: 'How material codes are built' },
  ] },
];

section('1 · the search finds a card by what it says, not just its name');
{
  const s = loadSearch(screenOf(PANELS));
  const cards = s.__cards();
  is(cards.length, 4, 'a panel the operator’s role cannot open is not a place to send them');
  const find = (q) => {
    s.document.getElementById('cfg-search').value = q;
    s.__search();
    return s.document.getElementById('cfg-search-results').innerHTML;
  };
  yes(find('layout').includes('Layout'), 'a card title matches');
  yes(find('delivery zones').includes('Stores'),
    'and so does the explanation under it — "delivery zones" is not any card’s name');
  yes(find('printer receipt').includes('Receipt printing'),
    'EVERY WORD has to match, in any order — a substring search would not find this one');
  yes(find('money quoted').includes('Currency'), 'words from two different sentences still match');
  yes(!find('layout printer').includes('Layout'),
    'and a word that matches nothing on the card rules it out');
}

section('2 · what a result tells you');
{
  const s = loadSearch(screenOf(PANELS));
  s.document.getElementById('cfg-search').value = 'currency';
  s.__search();
  const html = s.document.getElementById('cfg-search-results').innerHTML;
  yes(html.includes('Shop tab'), 'a result says which panel the setting lives in');
  yes(html.includes('Customers see this'), 'and whether customers see it');
  yes(/cfgSearchGo\(0\)/.test(html), 'and clicking it goes there');
}
{
  const s = loadSearch(screenOf(PANELS));
  s.document.getElementById('cfg-search').value = 'zzz';
  s.__search();
  yes(s.document.getElementById('cfg-search-results').innerHTML.includes('Nothing here matches'),
    'nothing found says so, rather than showing an empty list');
  s.document.getElementById('cfg-search').value = '';
  s.__search();
  is(s.document.getElementById('cfg-search-results').hidden, true,
    'and an empty box puts the panel list back');
}

section('3 · the marks are on the cards customers actually see');
{
  // Counted from the markup, not asserted one by one: the claim is that the
  // attribute is there and on a plausible number of cards, and the list itself
  // is a judgement recorded in the HTML where it can be read and argued with.
  const marks = (HTML.match(/data-sees="customer"/g) || []).length;
  yes(marks >= 10, `enough cards are marked (${marks})`);
  const cfg = HTML.slice(HTML.indexOf('<section id="tab-config">'),
    HTML.indexOf('<section id="tab-', HTML.indexOf('<section id="tab-config">') + 10));
  const cards = (cfg.match(/<div[^>]*class="group-card"/g) || []).length
    + (cfg.match(/<div[^>]*class="group-card"[^>]*id=/g) || []).length;
  yes(marks < cards, 'and not all of them — a badge on everything says nothing');
  for (const t of ['Layout', 'Currency', 'What customers receive', 'Support button']) {
    // The HEADING, not the first mention: several cards are introduced by an
    // HTML comment above them that names the same thing.
    const at = cfg.indexOf('<h3>' + t + ' ·');
    const before = cfg.lastIndexOf('<div class="group-card"', at);
    yes(cfg.slice(before, at).includes('data-sees="customer"') || cfg.slice(before, at).includes('data-sees'),
      `${t} is marked as something customers see`);
  }
  for (const t of ['System Alerts', 'WeCom credentials', 'Who changed what']) {
    // The HEADING, not the first mention: several cards are introduced by an
    // HTML comment above them that names the same thing.
    const at = cfg.indexOf('<h3>' + t + ' ·');
    const before = cfg.lastIndexOf('<div class="group-card"', at);
    yes(!cfg.slice(before, at).includes('data-sees'), `${t} is not — it is how the shop is run`);
  }
}

section('4 · the badge follows the language, and the box is reachable');
{
  yes(/function cfgMarkAudience/.test(OPS), 'the badge is rendered from JavaScript');
  yes(/onLangChange\(cfgMarkAudience\)/.test(OPS),
    'so it is never left in the language somebody switched away from');
  yes(/AN UNMARKED CARD IS NOT A CLAIM/.test(OPS),
    'and what the absence of a badge means is written down, because it means less than it looks like');
  yes(HTML.includes('data-kbd-search'),
    'the / shortcut finds this box too — it is not an id ending in -q');
  yes(/\.cfg-sees/.test(CSS) && /\.cfg-hit\b/.test(CSS), 'both are styled');
  yes(!/danger|--warn/.test(CSS.slice(CSS.indexOf('.cfg-sees'), CSS.indexOf('.cfg-sees') + 400)),
    'the badge is quiet — a setting customers can see is normal, not a hazard');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
