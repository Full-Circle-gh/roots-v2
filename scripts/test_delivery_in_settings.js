#!/usr/bin/env node
/**
 * test_delivery_in_settings.js — Delivery is a Settings panel (§79)
 *
 *   node scripts/test_delivery_in_settings.js
 *
 * THE CHANGE THIS GUARDS. Delivery was a top-level rail row at order:6 with its
 * own `<section id="tab-delivery">`. Ash moved it into Settings on 2026-09-09,
 * so ~1,090 lines of markup relocated into `.settings-body` as
 * `<div class="sub-panel" id="sub-delivery">`.
 *
 * A MOVE OF THAT SIZE FAILS IN WAYS THAT DO NOT LOOK LIKE FAILURES, which is
 * what every assertion below is aimed at:
 *
 *   1. A `<section>` instead of a `<div>`. goTab() clears `.active` off every
 *      `main section` on each tab switch, so leaving the tag alone would leave
 *      a panel that any rail click switches dark — visible only to somebody who
 *      opened Delivery and then clicked something else and came back.
 *   2. THE GATE LEFT BEHIND. TAB_CAP is keyed by data-tab; the row that carried
 *      `delivery:view` is gone, so the capability has to be re-expressed as
 *      data-cap on the nav button or the page ships ungated — the failure the
 *      rail's own gate-audit (§67) was opened by, in the other direction.
 *   3. THE DOOR THAT REFUSES. Gating the panel is worth nothing if a role
 *      holding delivery:view cannot open Settings at all, so `delivery:view`
 *      has to join TAB_CAP.config's any-of list.
 *   4. CALLERS ON A TAB THAT NO LONGER EXISTS. goTab('delivery') fails the
 *      `document.querySelector('.tabs [data-tab="delivery"]')` lookup, finds no
 *      row, falls through to the manual path, and lights a section id that is
 *      not there — silently, with no error and no visible effect.
 *   5. CSS SCOPED TO THE OLD ID. Eight rules were `#tab-delivery …`, including
 *      the one that hides #dz-kpis off the zones view and the `[hidden]`
 *      !important that makes dlvGo()'s view switching work at all.
 *   6. A SEARCH THAT LANDS ON NOTHING. Both searches can now hand back a card
 *      inside a `.dlv-view` that dlvGo() keeps [hidden]; without a reveal step
 *      they scroll to an invisible element and flash nothing.
 *
 * READ OFF THE SHIPPED FILES, not a fixture — the point is that the four files
 * still agree with each other after somebody edits one of them.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const DLV  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');
const OPS  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');

let pass = 0, fail = 0;
const yes = (cond, m, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};
const section = (t) => console.log('\n' + t);

/* Markup with HTML comments removed. Several assertions below are of the form
   "this string does not appear", and this file's own comments name the very
   things they forbid — so a comment saying where Delivery went would fail the
   test that says Delivery's rail row is gone. */
const MARKUP = HTML.replace(/<!--[\s\S]*?-->/g, '');

section('1 · the page left the rail and arrived in Settings');
{
  yes(!/<button[^>]*data-tab="delivery"/.test(MARKUP),
    'no rail row claims data-tab="delivery" any more');
  yes(!/id="tab-delivery"/.test(MARKUP),
    'and the old section id is gone with it');

  const panel = MARKUP.match(/<(\w+)([^>]*)id="sub-delivery"([^>]*)>/);
  yes(!!panel, 'the panel exists as #sub-delivery');
  if (panel) {
    yes(panel[1] === 'div',
      'it is a <div>, not a <section> — goTab() clears .active off every main section',
      'found <' + panel[1] + '>');
    yes(/class="sub-panel/.test(panel[2] + panel[3]),
      'and carries .sub-panel, so the settings switcher can show and hide it');
    yes(/data-dlv="hub"/.test(panel[2] + panel[3]),
      'and still carries data-dlv, which the CSS reads to place #dz-kpis');
  }

  // Nesting, read by position: the panel has to open after .settings-body does
  // and close before #tab-config's own </section>.
  const body  = MARKUP.indexOf('<div class="settings-body">');
  const at    = MARKUP.indexOf('id="sub-delivery"');
  const cfg   = MARKUP.indexOf('<section id="tab-config">');
  const after = MARKUP.indexOf('<section id="tab-', cfg + 10);
  yes(cfg >= 0 && body > cfg && at > body && at < after,
    'and it sits inside #tab-config .settings-body, with the other panels');
}

section('2 · every panel still has a nav button, Delivery included');
{
  const panels = [...MARKUP.matchAll(/class="sub-panel[^"]*" id="sub-([a-z-]+)"/g)].map((m) => m[1]);
  const navs   = [...MARKUP.matchAll(/<button data-sub="([a-z-]+)"/g)].map((m) => m[1]);
  yes(panels.includes('delivery'), 'Delivery is one of the panels');
  yes(navs.includes('delivery'), 'and one of the nav buttons');
  const unpaired = panels.filter((p) => !navs.includes(p)).concat(navs.filter((n) => !panels.includes(n)));
  yes(unpaired.length === 0,
    'and no panel is left without a button, or a button without a panel',
    'unpaired: ' + unpaired.join(', '));

  // Where it sits is a judgement, and it is recorded here so a reshuffle is a
  // decision rather than a drift: with the three panels that are about what the
  // customer meets, above the ones about how the shop is run.
  const iCs  = MARKUP.indexOf('<button data-sub="cs"');
  const iDlv = MARKUP.indexOf('<button data-sub="delivery"');
  const iOps = MARKUP.indexOf('<button data-sub="ops"');
  yes(iCs < iDlv && iDlv < iOps,
    'and it sits between Customer service and Operations');
}

section('3 · the capability came with the page');
{
  const btn = MARKUP.match(/<button data-sub="delivery"([^>]*)>/);
  yes(!!btn && /data-cap="delivery:view"/.test(btn[1]),
    'the nav button carries data-cap="delivery:view" — TAB_CAP cannot gate it any more',
    btn ? btn[1].trim() : 'button not found');

  const tabCap = CORE.slice(CORE.indexOf('const TAB_CAP = {'), CORE.indexOf('function canTab'));
  yes(!/\bdelivery:\s*'delivery:view'/.test(tabCap),
    'and TAB_CAP no longer claims a delivery tab, because there is not one');
  yes(/config:\s*\[[^\]]*'delivery:view'/s.test(tabCap),
    "and delivery:view joins TAB_CAP.config's any-of list, or the door refuses the role the panel is for");
}

section('4 · nothing still asks for a tab that does not exist');
{
  const CALLERS = [
    ['01-core.js', CORE], ['02-settings-ops.js', OPS], ['06-delivery.js', DLV],
    ['15-integrations.js', fs.readFileSync(path.join(ROOT, 'public/retail-admin/15-integrations.js'), 'utf8')],
    ['17-setup-guide.js', fs.readFileSync(path.join(ROOT, 'public/retail-admin/17-setup-guide.js'), 'utf8')],
  ];
  for (const [name, src] of CALLERS) {
    // Strip line and block comments: this move is described in several of them.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    yes(!/goTab\(\s*['"]delivery['"]\s*\)/.test(code) && !/salesGo\(\s*['"]delivery['"]\s*\)/.test(code),
      `${name} routes to Delivery without naming a tab`);
  }
  yes(/function dlvOpen\(\)/.test(DLV) && /window\.dlvOpen = dlvOpen/.test(DLV),
    'dlvOpen() is what they call instead, and it is exported');
  yes(/goTab\('config'\)/.test(DLV) && /button\[data-sub="delivery"\]/.test(DLV),
    'and it opens Settings and then the panel — the two-step the setup guide already used');
  yes(!/goTab\(\s*&#39;delivery&#39;|goTab\('delivery'\)/.test(MARKUP),
    'and no inline onclick in the markup names it either');
}

section('5 · the CSS followed the id');
{
  yes(!/#tab-delivery/.test(CSS),
    'no rule is still scoped to #tab-delivery');
  yes(/#sub-delivery \.dlv-view\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(CSS),
    'the [hidden] override survived the rename — without it dlvGo() switches nothing',
    'an author display rule beats the UA default for [hidden]; this is the same trap #tab-finance carries');
  yes(/#sub-delivery:not\(\[data-dlv="zones"\]\) > #dz-kpis/.test(CSS),
    'and so did the rule that shows the zone KPIs on the zones view alone');
  yes(/getElementById\('sub-delivery'\)/.test(DLV),
    "and dlvGo() reads the panel by its new id, or every sub-view button does nothing");
}

section('6 · a search that finds a delivery card can actually show it');
{
  yes(/function _dlvReveal\(/.test(DLV) && /window\._dlvReveal = _dlvReveal/.test(DLV),
    '_dlvReveal() exists and is exported');
  yes(/closest\('#sub-delivery \.dlv-view'\)/.test(DLV),
    'it answers only for cards inside the delivery panel — every other panel shows all its cards at once');

  const cfgGo = OPS.slice(OPS.indexOf('function cfgSearchGo('), OPS.indexOf('window.cfgSearch = cfgSearch;'));
  yes(/_dlvReveal\(h\.card\)/.test(cfgGo),
    "Settings' own card search reveals the sub-view before it scrolls");
  const paletteGo = OPS.slice(OPS.indexOf('function go(it) {'), OPS.indexOf('function go(it) {') + 3000);
  yes(/_dlvReveal\(it\.anchor\)/.test(paletteGo),
    'and so does the command palette');

  // The panel is indexed by the settings walk now rather than the rail walk;
  // the alias that made "shipping" and "配送" find it has to still be there.
  yes(/'delivery':\s*'[^']*配送/.test(OPS),
    'and the search aliases for the page survived the move');
}

section('7 · there is no shared Save bar for Delivery to be kept off');
{
  // §493 (2026-10-21): the shared "Save settings" bar is gone from Settings
  // altogether. Every Delivery sub-view saves itself or carries its own Save
  // (the carrier forms, the fees), so the old assertion — that Delivery was on
  // the switcher's no-shared-Save list — has nothing left to guard. What is
  // guarded now is that the bar does not come back.
  const sw = CORE.slice(CORE.indexOf("// ── Settings sub-nav switcher ──"), CORE.indexOf('// ── Live push (SSE)'));
  yes(!/_saveBar/.test(sw) && !/saveConfig/.test(sw),
    'the switcher no longer shows or hides a shared Save bar');
  const cfg = MARKUP.slice(MARKUP.indexOf('<section id="tab-config">'), MARKUP.indexOf('</section>', MARKUP.indexOf('<section id="tab-config">')));
  yes(!/class="save-bar"/.test(cfg) && !/saveConfig\(\)/.test(cfg),
    'and the Settings markup has no shared Save bar to show');
  yes(/if \(sub === 'delivery'[^)]*\)[^\n]*dlvGo\('hub'\)/.test(sw),
    'opening the panel still lands on the hub, so its status lines are repainted',
    'not on whichever sub-view the last visit left behind — what the rail button did before the move');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
