#!/usr/bin/env node
'use strict';

// Tests for §123 — GZ Grocery wears the channel frame.
//
//   node scripts/test_channel_frame.js
//
// Pure text assertions over the shipped files. No DOM, no browser: what is
// being locked down is that three channel pages are described by ONE set of
// rules rather than three, and that is a property of the source, not of a
// render.
//
// What is locked down:
//
//   1. GZ Grocery has no frame CSS of its own. Every `.gy-` frame class it uses
//      is styled by a rule that ALSO names `.mt-`, so the two cannot drift.
//   2. #tab-guanyi carries no inline <style> block. That block is how the page
//      came to be styled against a different token family from the rest of the
//      admin in the first place.
//   3. #tab-guanyi remaps the base tokens onto the Tacet palette, exactly as
//      #tab-meituan and #tab-eleme do. Without it the page paints warm-grey
//      next to two pages that do not.
//   4. The page's four head parts are the frame's four, in the frame's order.
//   5. The heading is the SHARED TABLE's name for this channel. It read
//      "gzgrocery 同步 · Guanyi Sync" while three other surfaces said
//      "GZ Grocery" — three names for one channel (§103 step 5).
//   6. Nothing on the new head composes Chinese: every pair is asserted to be
//      live somewhere it was lifted from.
//
// §127 added a seventh, about the three PANEL BODIES under that head:
//
//   7. The bodies speak the frame's vocabulary too. §123 stopped at the head,
//      which left a Tacet head over three panels still written in the admin's
//      pre-Tacet one — 10px uppercase mono eyebrows, 700-weight numbers, 6px
//      radii, borrowed toolbars from other pages, and an amber-washed flagged
//      list whose Apply buttons came out amber because the token remap points
//      --brass at Amber and this page, unlike its two siblings, carried no
//      .btn-primary rule to answer it.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(a, b, what) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what || 'value'}: expected ${y}, got ${x}`);
}
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }

const CSS  = read('public/retail-admin.css');
const HTML = read('public/retail-admin.html');
const GY   = read('public/retail-admin/12-guanyi.js');
/* The same file with its comments stripped. The §127 cases below assert
   that a thing is ABSENT and the tombstone comment explaining why names it;
   a test that cannot tell a tombstone from a body gets fought, not fixed —
   the reason SECTION_LIVE exists for the markup, applied to the renderer. */
const GY_LIVE = GY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* The stretch of markup that is the GZ Grocery page — to its OWN closing tag,
   not to the next <section>. A global wizard <style> block sits between the
   two, and slicing to the next section swept it in and failed the "no inline
   style" case against markup this page does not own. */
function guanyiSection() {
  const a = HTML.indexOf('<section id="tab-guanyi">');
  ok(a > -1, '#tab-guanyi is gone from the markup');
  const b = HTML.indexOf('\n  </section>', a);
  ok(b > -1, '#tab-guanyi is never closed');
  return HTML.slice(a, b);
}
const SECTION = guanyiSection();
/* The same markup with comments stripped. Several cases below assert that a
   thing is ABSENT, and the comments explaining why it was removed name it —
   a test that cannot tell a tombstone from a body is a test that gets fought
   rather than fixed. */
const SECTION_LIVE = SECTION.replace(/<!--[\s\S]*?-->/g, '');

// Every one-line rule in the stylesheet, as [selector, body].
const RULES = CSS.split('\n')
  .map(l => l.match(/^\s*([^\n{}]*?)\s*\{([^\n{}]*)\}\s*$/))
  .filter(Boolean)
  .map(m => [m[1].trim(), m[2].trim()]);

// ── 1. one frame, not a third copy of it ─────────────────────────────────────
section('1 · GZ Grocery has no frame CSS of its own');

// The head parts GZ Grocery takes from the frame.
const FRAME = ['pagehead', 'pagehead-t', 'status', 'tiles', 'tile',
               'storelines', 'storeline', 'tabs', 'tab', 'tabs-grow'];

check('every .gy- frame class is styled by a rule that also names .mt-', () => {
  for (const part of FRAME) {
    // Rules that mention this exact .gy- class (not a longer one: .gy-tab must
    // not be satisfied by .gy-tabs).
    const re = new RegExp('\\.gy-' + part.replace('-', '\\-') + '(?![\\w-])');
    const hits = RULES.filter(([sel]) => re.test(sel));
    ok(hits.length, `.gy-${part} is not styled at all`);
    for (const [sel] of hits) {
      ok(/\.mt-/.test(sel),
         `.gy-${part} has a rule of its own, not shared with Meituan: ${sel.slice(0, 90)}`);
    }
  }
});

check('the frame rules GZ joined still carry Meituan and Eleme unchanged', () => {
  // Joining must be ADDITIVE. The storeline group was already shared mt+el; if
  // widening it dropped a half, that half's page loses the rule silently — the
  // exact mistake made once on the toggle-label group in §117 part two.
  for (const part of ['storelines', 'storeline']) {
    const hits = RULES.filter(([sel]) => new RegExp('\\.gy-' + part + '(?![\\w-])').test(sel));
    ok(hits.length, `no .gy-${part} rule`);
    for (const [sel] of hits) {
      ok(/\.mt-/.test(sel) && /\.el-/.test(sel),
         `widening .${part} dropped a channel: ${sel.slice(0, 110)}`);
    }
  }
});

check('no .gy- selector was joined somewhere it can never match', () => {
  for (const [sel] of RULES) {
    if (!/\.gy-/.test(sel)) continue;
    for (const part of sel.split(',').map(x => x.trim())) {
      if (!/\.gy-/.test(part)) continue;
      ok(!/#tab-(meituan|eleme)/.test(part), `a .gy- selector is scoped to another channel's tab: ${part}`);
      ok(!/\.(mt|el)-/.test(part), `a .gy- selector is combined with another channel's class: ${part}`);
    }
  }
});

// ── 2. the inline style block is gone ────────────────────────────────────────
section('2 · the page is styled from the stylesheet');

check('#tab-guanyi carries no inline <style> block', () => {
  ok(!/<style/.test(SECTION_LIVE), 'an inline <style> block is back inside #tab-guanyi');
});

check('#tab-guanyi remaps the base tokens onto the Tacet palette', () => {
  const block = CSS.match(/#tab-guanyi \{([\s\S]*?)\}/);
  ok(block, '#tab-guanyi has no token remap block');
  // The same list #tab-meituan carries — a partial remap is how half a page
  // ends up on-palette and half of it does not.
  const mt = CSS.match(/#tab-meituan \{([\s\S]*?)\}/);
  ok(mt, '#tab-meituan has no token remap block to compare against');
  const names = (t) => (t.match(/--[\w-]+:/g) || []).sort();
  eq(names(block[1]), names(mt[1]), 'GZ Grocery remaps a different set of tokens from Meituan');
});

// ── 3. the frame's four parts, in the frame's order ──────────────────────────
section('3 · the head is the frame’s head');

check('pagehead → tiles → store line → tabs, in that order', () => {
  const want = ['class="gy-pagehead"', 'class="gy-tiles"', 'class="gy-storelines"', 'class="gy-tabs"'];
  let at = -1;
  for (const w of want) {
    const i = SECTION.indexOf(w);
    ok(i > -1, `the head is missing ${w}`);
    ok(i > at, `${w} is out of the frame's order`);
    at = i;
  }
});

check('the health strip and the bespoke sub-nav are gone for good', () => {
  for (const dead of ['gy-health', 'gy-pulse', 'gy-facts', 'gy-spacer', 'gy-subnav', 'gy-h-']) {
    ok(!HTML.includes(dead), `${dead} is back in the markup`);
    ok(!GY.includes(dead), `${dead} is back in 12-guanyi.js`);
    ok(!CSS.includes(dead), `${dead} is back in the stylesheet`);
  }
});

check('the sub-tabs are the frame’s tab strip, counts in .n pills', () => {
  for (const id of ['gy-nav-overview', 'gy-nav-billing', 'gy-nav-mapping']) {
    const m = SECTION.match(new RegExp('<button id="' + id + '"[^>]*'));
    ok(m, `${id} is gone`);
    ok(/class="gy-tab/.test(m[0]), `${id} is not on the frame's tab class`);
  }
  ok(/<span class="n" id="gy-nav-map-amt"/.test(SECTION), 'the mapping count is not an .n pill');
  ok(/<span class="n" id="gy-nav-bill-amt"/.test(SECTION), 'the billing count is not an .n pill');
});

check('Billing and Mapping stayed on this page', () => {
  for (const id of ['gy-panel-overview', 'gy-panel-billing', 'gy-panel-mapping']) {
    ok(SECTION.includes('id="' + id + '"'), `${id} left the page — Ash kept Billing and Mapping here`);
  }
});

// ── 4. one name for one channel ──────────────────────────────────────────────
section('4 · the heading is the shared table’s name');

check('the h2 says what CH_NAME says, and says it once', () => {
  const cs = read('public/retail-admin/29-channel-sync.js');
  const m = cs.match(/guanyi:\s*\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/);
  ok(m, 'CH_NAME no longer carries a guanyi entry');
  const [, en, cn] = m;
  eq(en, cn, 'CH_NAME now gives GZ Grocery two different names — the h2 must follow suit');
  const h2 = SECTION.match(/<h2[^>]*>([^<]*)<\/h2>/);
  ok(h2, 'the page has no h2');
  eq(h2[1].trim(), en, 'the heading and the shared table disagree about this channel’s name');
  ok(!/Guanyi Sync|gzgrocery 同步/.test(SECTION_LIVE), 'an older name for this channel is back on the page');
});

// ── 5. the head composes no Chinese ──────────────────────────────────────────
section('5 · every pair on the new head is lifted, not composed');

check('the tile labels and the list line are live pairs from named sources', () => {
  const core = read('public/retail-admin/01-core.js');
  const el   = read('public/retail-admin/14-eleme.js');
  const cs   = read('public/retail-admin/29-channel-sync.js');
  // [what the head says] → [a file that already shipped that pair]
  const lifted = [
    ["cuT('Stock updates waiting', '待推送库存')", el,   'the Eleme tile of the same number'],
    ["cuT('nothing needs you', '无需处理')",       cs,   'the Channel sync status line'],
    ["att:  ['Needs attention', '待处理']",         core, 'CH_STATE_WORD, the one table (§103 step 5)'],
  ];
  for (const [pair, src, where] of lifted) {
    ok(src.includes(pair), `no longer live in ${where}: ${pair}`);
  }
  // And the head actually uses them.
  ok(GY.includes("cuT('Stock updates waiting', '待推送库存')"), 'the waiting tile stopped using the shared pair');
  ok(GY.includes("chStateWord('att')"), 'the attention tile stopped reading the shared table');
  ok(GY.includes("cuT('Needs attention', '待处理')"),
     'the tile’s fallback wording drifted from CH_STATE_WORD’s');
  ok(GY.includes("cuT('nothing needs you', '无需处理')"), 'the calm status line stopped using the shared pair');
});

check('the numbered phrases are the shapes the other channel screens use', () => {
  // `N 个待处理` and `N 发送中…` are the Channel sync strip's own, with the
  // number in the same slot. Same shape, same words, so an operator reading
  // both screens is not learning two vocabularies for one fact.
  const cs = read('public/retail-admin/29-channel-sync.js');
  ok(/\$\{[\w.]+\} 个待处理/.test(cs), 'the Channel sync page no longer carries the 待处理 shape');
  ok(/\$\{[\w.]+\} 发送中…/.test(cs),  'the Channel sync page no longer carries the 发送中 shape');
  ok(/\$\{errors\} 个待处理/.test(GY), 'the GZ status line minted its own 待处理 phrasing');
  ok(/\$\{pending\} 发送中…/.test(GY), 'the GZ status line minted its own 发送中 phrasing');
});

// THE WORD THAT IS DELIBERATELY NOT USED. `mappedCount` counts mappings with
// the switch on; the Channel sync page's `ok` count is items the channel holds
// the right number for. Calling the first one "Synced" would put two different
// numbers behind one word on two screens.
check('the mapped tile is not called Synced', () => {
  ok(GY.includes("cuT('Mapped', '已映射')"), 'the mapped tile lost its own live pair');
  const head = GY.slice(GY.indexOf('function gyRenderHead'), GY.indexOf('window.gyLoadStatus'));
  ok(!/已同步|'Synced'/.test(head), 'the GZ head calls mappedCount "Synced", which is a different number');
});

// ── 6. the repainted button ──────────────────────────────────────────────────
section('6 · the store line owns its own button');

/* The Refresh list button now lives inside the store line, which gyRenderHead()
   repaints on every poll of a running refresh job. Anything that captures the
   node and writes to it later is writing to a detached element — which is what
   this page did for one commit, and which only looked correct because each
   repaint happened to paint the right state anyway. */
check('nothing holds the Refresh button across a repaint', () => {
  ok(!/getElementById\('gy-refresh-btn'\)/.test(GY),
     'something captured the Refresh button again; the render owns its state');
  ok(/_gyRefreshing/.test(GY), 'the refresh-in-flight flag is gone');
  const fn = GY.slice(GY.indexOf('window.gyRefreshListings'), GY.indexOf('Auto-match by SKU'));
  ok(/_gyRefreshing = true;[\s\S]{0,80}gyRenderHead\(\)/.test(fn), 'the click does not repaint into the busy state');
  ok(/finally \{[\s\S]{0,120}_gyRefreshing = false;[\s\S]{0,60}gyRenderHead\(\)/.test(fn),
     'the flag is not cleared and repainted when the job ends');
  ok(!/Refreshing…/.test(GY), 'an English-only busy label is back on the button');
});

// ── 7. §127 · the panel bodies speak the frame's vocabulary ──────────────────
section('7 · the panel bodies are in the frame’s vocabulary');

/* THE ONE THAT WAS VISIBLE FROM THE DOOR. #tab-guanyi remaps --brass onto
   Amber (it must: that is what makes Amber mean "warning" here). The base
   .btn-primary is BUILT on --brass, so without an answering rule every primary
   button on the page comes out amber — including the Apply button that CLEARS
   a flagged drop, which then looked like the warning rather than the way out
   of it. #tab-meituan and #tab-eleme each carry this rule for exactly this
   reason; the three cannot share one because each is scoped to its own tab. */
check('a primary button on this page is Ink, not the remapped Amber', () => {
  for (const tab of ['meituan', 'eleme', 'guanyi']) {
    const re = new RegExp('#tab-' + tab + ' \\.btn-primary \\{([^}]*)\\}');
    const m = CSS.match(re);
    ok(m, `#tab-${tab} remaps --brass onto Amber but has no .btn-primary rule`);
    ok(/background:\s*var\(--td-text\)/.test(m[1]),
       `#tab-${tab}'s primary button is not Ink: ${m[1].trim()}`);
  }
});

/* The retired vocabulary, by name. Each of these was on the page and is the
   reason it read as a different product from Meituan and Eleme. */
check('the pre-Tacet body vocabulary is gone', () => {
  for (const dead of ['gy-eyebrow', 'gy-teaser']) {
    ok(!CSS.includes(dead), `${dead} is back in the stylesheet`);
    ok(!SECTION_LIVE.includes(dead), `${dead} is back in the markup`);
  }
  // Two classes borrowed from OTHER pages: .pa-toolbar is the Products page's
  // toolbar (it brought that page's Dusk focus ring with it) and .helper is the
  // 11px pre-Tacet hint. .data-table was never styled by any rule at all.
  for (const borrowed of ['pa-toolbar', 'pa-count', 'data-table', 'class="helper"']) {
    ok(!SECTION_LIVE.includes(borrowed), `${borrowed} is back inside #tab-guanyi`);
  }
  ok(!GY_LIVE.includes('data-table'), 'data-table is back in 12-guanyi.js');
});

/* The panels are painted by 12-guanyi.js, so "styled from the stylesheet"
   (case 2) only half-holds while the renderers still carry a stylesheet of
   their own in style="" attributes. Sizes and colours are the two that drift;
   a width on a bar or a min-width on a table is geometry and stays. */
check('the panel renderers set no font or colour inline', () => {
  const body = GY_LIVE.slice(GY_LIVE.indexOf('function gyRenderPickups'));
  for (const prop of ['font-size', 'font-weight', 'color:', 'background:', 'border-radius']) {
    const hit = body.split('\n').find(l => l.includes('style="') && l.includes(prop));
    ok(!hit, `an inline ${prop} is back in a panel renderer: ${String(hit).trim().slice(0, 100)}`);
  }
});

/* Amber is an accent, not a field. The flagged card was a color-mix wash with
   an amber border, amber headings and amber buttons on it — under a status
   line that said "nothing needs you". It is a plain card now, with amber on
   the one line that says how many, which is where .mt-status spends it. */
check('the flagged-drop card is a card, not an amber field', () => {
  ok(!/color-mix/.test(GY_LIVE), 'the color-mix amber wash is back on the flagged list');
  const card = CSS.match(/#tab-guanyi \.gy-card \{([^}]*)\}/);
  ok(card, 'there is no .gy-card rule');
  ok(/var\(--td-surface\)/.test(card[1]) && /var\(--td-border\)/.test(card[1]),
     'the card is not a bordered --td-surface like every other card here');
  ok(/border-radius:\s*14px/.test(card[1]), 'the card radius is not the frame’s 14px');
});

/* Every colour the bodies name must be a --td-* token or one of the four the
   remap block defines. A raw hex here is a colour that exists in one theme. */
check('the body rules name tokens, never raw colour', () => {
  const start = CSS.indexOf('#tab-guanyi .btn-primary');
  const end = CSS.indexOf('/* ── §103 · Channel sync');
  ok(start > -1 && end > start, 'the GZ Grocery body block moved or is gone');
  const block = CSS.slice(start, end);
  const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  eq(hexes.filter(h => !/^#tab/.test(h)), [], 'raw colours in the GZ Grocery body block');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
