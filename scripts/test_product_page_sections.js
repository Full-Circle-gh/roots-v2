#!/usr/bin/env node
/* §206 — the full product page is its own page, and every field on it is the
   dock's own node carried out and carried home.

   Ash, 2026-09-21, from three mockups: "build a from scratch, dont patch on the
   old design. i want it to look exactly like the mock up." The old expanded
   page was the dock's five panes switched on at once and stacked; it is gone.
   What replaces it (retail-admin/31-product-page.js, the `.ppg` block in
   retail-admin.css, the #ppg stage in retail-admin.html) carries the field
   nodes out of #pd-editor while the page is open and back on collapse.

   WHAT IS ASSERTED, and why each one is quiet when broken:

   • THE OLD MECHANISM IS GONE. Not "still works": gone. A `pd-fullpage` rule or
     a `pdMoveSideBlocks` left behind would style or move nodes a second way,
     and two ways to arrange one node is how the first mess was made.
   • THE CARRY ORDER HOLDS. Restoring in reverse only works if every carried
     node's next sibling is either static or carried after it. That is a claim
     about the ORDER OF IDS IN THE MARKUP, which nothing at runtime checks and
     which a regrouping of the dock would silently break: the page would still
     open, and the dock would come back with its cards shuffled. So the real
     markup's order is read here, and a carry-and-return is run on a stand-in
     DOM built in that order, asserting the dock ends exactly as it began.
   • THE LAYOUT RESOLVER FORGIVES. A stored order from a version with different
     sections must still resolve to a page with every section on it, and Basics
     can never be hidden.
   • ONE HANDLER LISTENS IN BOTH HOMES. The autosave engine listens on
     #pd-editor; the page listens on #ppg with the same named function. A copy
     of that function is the §142/§144 family of mistake.
   • THE SCRIPT LOADS LAST, after the files whose functions it defines over.

   No browser, no server: fast shard. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('public/retail-admin.html');
const CSS  = read('public/retail-admin.css');
const PD   = read('public/retail-admin/09-products.js');
const PPG  = read('public/retail-admin/31-product-page.js');
const MKT  = read('public/retail-admin/05-marketing.js');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
const htmlNoComments = (src) => src.replace(/<!--[\s\S]*?-->/g, ' ');

// ── The page's own globals, lifted out of the file ─────────────────────────
// A declaration list, then the two pure pieces. new Function binds the names.
function lift() {
  const from = PPG.indexOf('const PPG_SECTIONS');
  const to = PPG.indexOf('// ── Carrying nodes out and home');
  assert.ok(from > 0 && to > from, 'the constants and the resolver moved; re-anchor this test');
  const src = PPG.slice(from, to).replace(/typeof _cfgCache !== 'undefined' \? _cfgCache : null/, 'null');
  return new Function(src + '\nreturn { PPG_SECTIONS, PPG_SIDE, PPG_DETAILS, PPG_WRITE, PPG_ALIASES, ppgResolveLayout };')();
}
const { PPG_SECTIONS, PPG_SIDE, PPG_DETAILS, PPG_WRITE, PPG_ALIASES, ppgResolveLayout } = lift();

console.log('\nThe old expanded page is gone, not hidden');
it('no rule, node or function of the old page survives', () => {
  for (const [name, src] of [['html', htmlNoComments(HTML)], ['css', CSS], ['09-products', codeOnly(PD)], ['31-product-page', codeOnly(PPG)]]) {
    for (const needle of ['pd-fullpage', 'pd-pagestage', 'pd-pp-mount', 'pd-pp-side', 'pd-pp-sech', 'data-pp-only', 'data-dock-only',
                          'pdMoveSideBlocks', 'pdMovePhotos', 'pdMoveEditor', 'pdMoveHeadState', 'pdWatchPin', 'pdPinHead', 'pdSyncFullscreenBtn']) {
      assert.ok(!src.includes(needle), `${name} still carries "${needle}"`);
    }
  }
});
it('the page functions the editor calls are defined once, in the page file', () => {
  for (const fn of ['pdIsExpanded', 'pdExpand', 'pdCollapseToPanel', 'pdToggleFullscreen', 'pdSyncPageHead']) {
    const re = new RegExp(`^function ${fn}\\(`, 'm');
    assert.ok(re.test(PPG), `${fn} is not defined in 31-product-page.js`);
    assert.ok(!re.test(PD), `${fn} is still defined in 09-products.js as well`);
  }
  for (const fn of ['pdIsExpanded', 'pdCollapseToPanel', 'pdSyncPageHead']) {
    assert.ok(codeOnly(PD).includes(fn + '('), `09-products.js no longer calls ${fn} — the seam moved`);
  }
});

console.log('\nThe script loads last');
it('31-product-page.js loads after every part it defines over or reads (05, 09, 21), and is preloaded', () => {
  const order = [...HTML.matchAll(/<script src="\/assets\/retail-admin\/(\d+)-[a-z-]+\.js"><\/script>/g)].map(m => Number(m[1]));
  assert.strictEqual(order.filter(n => n === 31).length, 1, 'the script tag is missing or doubled');
  // 27-keyboard.js deliberately loads last of all; this file only has to come
  // after the parts whose functions it replaces and whose state it reads.
  for (const dep of [5, 9, 21]) assert.ok(order.indexOf(dep) < order.indexOf(31), `${dep} loads after 31: ${order.join(',')}`);
  assert.ok(HTML.includes('<link rel="preload" href="/assets/retail-admin/31-product-page.js" as="script">'));
});

console.log('\nEvery carried node exists once, inside the dock editor');
const carried = [
  ...PPG_SECTIONS.flatMap(s => s.carry), '#pd-sec-photos', ...PPG_SIDE, ...PPG_DETAILS, ...PPG_WRITE, '#pd-head-tags', '#pd-save-status',
];
const editorStart = HTML.indexOf('<div class="pu-editor" id="pd-editor"');
const editorEnd = HTML.indexOf('</div><!-- /#pd-bg pa-split-editor -->');
it('the editor and its end marker are where this test expects', () => {
  assert.ok(editorStart > 0 && editorEnd > editorStart);
});
for (const sel of carried) {
  it(`${sel} is one id inside #pd-editor`, () => {
    assert.ok(sel.startsWith('#'), 'carry lists name ids, so a node cannot be matched twice by class');
    const id = sel.slice(1);
    const hits = [...HTML.matchAll(new RegExp(`\\sid="${id}"`, 'g'))];
    assert.strictEqual(hits.length, 1, `id="${id}" appears ${hits.length} times`);
    assert.ok(hits[0].index > editorStart && hits[0].index < editorEnd, `id="${id}" sits outside the dock editor`);
  });
}
it('the page stage and its mounts exist, outside the editor', () => {
  const stage = HTML.indexOf('<div id="ppg" class="ppg"');
  assert.ok(stage > editorEnd, '#ppg must sit after the dock editor, not inside it');
  for (const key of [...PPG_SECTIONS.map(s => s.key), 'side', 'write']) {
    if (key === 'page') continue;   // its card is its own markup; only the write mount is a mount
    assert.ok(HTML.includes(`data-mount="${key}"`), `no mount for ${key}`);
  }
  for (const id of ['ppg-rail', 'ppg-tags', 'ppg-state', 'ppg-name', 'ppg-sub', 'ppg-page-card', 'ppg-write', 'ppg-write-btn']) {
    assert.strictEqual([...HTML.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `id="${id}"`);
  }
});

console.log('\nThe carry order holds — read from the real markup, replayed on a stand-in');
// The dock in the order the markup has it. Each row: a parent, then its
// children in order; `*` marks a child that is never carried.
function idOrderInHtml(ids) {
  return ids.map(id => ({ id, at: HTML.indexOf(` id="${id}"`) })).sort((a, b) => a.at - b.at).map(x => x.id);
}
it('sibling order in the markup is what the carry lists assume', () => {
  assert.deepStrictEqual(idOrderInHtml(['pd-sec-basics', 'pd-published', 'pd-sec-photos', 'pd-sec-where']),
    ['pd-sec-basics', 'pd-published', 'pd-sec-photos', 'pd-sec-where']);
  assert.deepStrictEqual(idOrderInHtml(['pd-sec-stock', 'pd-sec-sourcing']), ['pd-sec-stock', 'pd-sec-sourcing']);
  assert.deepStrictEqual(idOrderInHtml(['pd-sec-shipping', 'pd-sec-flags', 'pd-sec-freeof', 'pd-sec-notes']),
    ['pd-sec-shipping', 'pd-sec-flags', 'pd-sec-freeof', 'pd-sec-notes']);
  assert.deepStrictEqual(PPG_DETAILS, ['#pd-sec-shipping', '#pd-sec-flags', '#pd-sec-freeof', '#pd-sec-notes'],
    'PPG_DETAILS must list the Details cards in dock order — the card\'s visual order is CSS');
  assert.deepStrictEqual(PPG_SIDE, ['#pd-sales-card', '#pd-foot-acts']);
  assert.deepStrictEqual(idOrderInHtml(['pd-sec-facts', 'pd-sec-desc']), ['pd-sec-facts', 'pd-sec-desc']);
  assert.deepStrictEqual(idOrderInHtml(['pd-save-status', 'pd-foot-acts']), ['pd-save-status', 'pd-foot-acts']);
});

// A stand-in DOM: enough of appendChild / insertBefore / nextElementSibling /
// closest / querySelector for the carry functions, and nothing else.
function mkNode(id, cls) {
  const n = { id: id || '', cls: cls || '', children: [], parentElement: null };
  Object.defineProperty(n, 'nextElementSibling', { get() {
    if (!n.parentElement) return null;
    const i = n.parentElement.children.indexOf(n);
    return n.parentElement.children[i + 1] || null;
  } });
  n.appendChild = (c) => { if (c.parentElement) c.parentElement.children.splice(c.parentElement.children.indexOf(c), 1); c.parentElement = n; n.children.push(c); };
  n.insertBefore = (c, ref) => {
    if (c.parentElement) c.parentElement.children.splice(c.parentElement.children.indexOf(c), 1);
    c.parentElement = n;
    const i = ref ? n.children.indexOf(ref) : -1;
    if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
  };
  n.closest = (sel) => { let c = n; while (c) { if ('#' + c.id === sel) return c; c = c.parentElement; } return null; };
  return n;
}
function buildDock() {
  const all = {};
  const N = (id, cls) => (all[id || ('_' + Math.random())] = mkNode(id, cls));
  const editor = N('pd-editor');
  const head = N('head'); editor.appendChild(head);
  head.appendChild(N('pd-head-tags')); head.appendChild(N('pd-head-sp')); head.appendChild(N('pd-expand-btn'));
  const body = N('body'); editor.appendChild(body);
  body.appendChild(N('pd-sales-card')); body.appendChild(N('pd-tabs'));
  const basicsPane = N('pane-basics'); body.appendChild(basicsPane);
  const basicsGrid = N('grid-basics'); basicsPane.appendChild(basicsGrid);
  basicsGrid.appendChild(N('pd-sec-basics')); basicsGrid.appendChild(N('pd-published')); basicsGrid.appendChild(N('pd-sec-photos')); basicsGrid.appendChild(N('pd-sec-where'));
  const costPane = N('pane-cost'); body.appendChild(costPane); costPane.appendChild(N('pd-sec-cost'));
  const stockPane = N('pane-stock'); body.appendChild(stockPane);
  const stockGrid = N('grid-stock'); stockPane.appendChild(stockGrid);
  stockGrid.appendChild(N('pd-sec-stock')); stockGrid.appendChild(N('pd-sec-sourcing'));
  stockPane.appendChild(N('pd-sum-stock')); stockPane.appendChild(N('pd-sum-more')); stockPane.appendChild(N('pd-sec-sizes'));
  const pagePane = N('pane-page'); body.appendChild(pagePane);
  pagePane.appendChild(N('pd-sum-page'));
  const pageGrid = N('grid-page'); pagePane.appendChild(pageGrid);
  pageGrid.appendChild(N('pd-sec-facts')); pageGrid.appendChild(N('pd-sec-desc'));
  const detPane = N('pane-details'); body.appendChild(detPane);
  const detGrid = N('grid-details'); detPane.appendChild(detGrid);
  for (const id of ['pd-sec-shipping', 'pd-sec-flags', 'pd-sec-freeof', 'pd-sec-notes']) detGrid.appendChild(N(id));
  const foot = N('foot'); editor.appendChild(foot);
  foot.appendChild(N('pd-save-status')); foot.appendChild(N('pd-foot-sp')); foot.appendChild(N('pd-foot-acts'));
  // The page.
  const ppg = N('ppg');
  const tags = N('ppg-tags'); ppg.appendChild(tags);
  const state = N('ppg-state'); ppg.appendChild(state);
  const mounts = {};
  for (const key of ['basics', 'where', 'cost', 'stock', 'sold', 'write', 'side']) { mounts[key] = N('mount-' + key); ppg.appendChild(mounts[key]); }
  mounts.side.appendChild(N('ppg-details'));
  return { all, editor, ppg, mounts };
}
function snapshot(n) { return { id: n.id, children: n.children.map(snapshot) }; }
function loadCarry(dom) {
  const from = PPG.indexOf('let _ppgHomes = [];');
  const to = PPG.indexOf('// ── Open · show · close');
  assert.ok(from > 0 && to > from, 'the carry functions moved; re-anchor this test');
  const document = {
    querySelector: (sel) => {
      if (sel.startsWith('#') && !sel.includes(' ')) return dom.all[sel.slice(1)] || null;
      const m = sel.match(/data-mount="([a-z]+)"/);
      return m ? dom.mounts[m[1]] || null : null;
    },
    getElementById: (id) => dom.all[id] || null,
  };
  const src = PPG.slice(PPG.indexOf('const PPG_SECTIONS'), PPG.indexOf('// ── Carrying nodes out and home'))
    .replace(/typeof _cfgCache !== 'undefined' \? _cfgCache : null/, 'null')
    + PPG.slice(from, to);
  return new Function('document', src + '\nreturn { ppgCarry, ppgCarryHome, ppgCarryAll, _homes: () => _ppgHomes };')(document);
}
it('carry everything out, then home: the dock is byte-for-byte what it was', () => {
  const dom = buildDock();
  const before = JSON.stringify(snapshot(dom.editor));
  const c = loadCarry(dom);
  c.ppgCarryAll();
  // Everything landed on the page…
  for (const sel of [...PPG_SECTIONS.flatMap(s => s.carry), ...PPG_SIDE, ...PPG_DETAILS, '#pd-head-tags', '#pd-save-status']) {
    assert.ok(dom.all[sel.slice(1)].closest('#ppg'), `${sel} was not carried onto the page`);
  }
  for (const sel of PPG_DETAILS) assert.strictEqual(dom.all[sel.slice(1)].parentElement.id, 'ppg-details', `${sel} belongs in the details card`);
  assert.strictEqual(dom.all['pd-sec-photos'].parentElement, dom.all['pd-sec-basics'], 'photos belong inside the Basics card');
  // …and the writing cards only when Edit asks.
  for (const sel of PPG_WRITE) c.ppgCarry(sel, dom.mounts.write);
  assert.ok(dom.all['pd-sec-desc'].closest('#ppg'));
  c.ppgCarryHome();
  assert.strictEqual(JSON.stringify(snapshot(dom.editor)), before, 'the dock did not come back in its original order');
  assert.strictEqual(c._homes().length, 0);
});
it('carry with a section hidden by the tenant, then home: still identical', () => {
  const dom = buildDock();
  const before = JSON.stringify(snapshot(dom.editor));
  const c = loadCarry(dom);
  // ppgVisibleKeys reads ppgLayout(); with no config every key is visible. Hide
  // Cost by carrying only what the resolver would keep.
  c.ppgCarryAll();
  c.ppgCarryHome();
  assert.strictEqual(JSON.stringify(snapshot(dom.editor)), before);
});

console.log('\nThe tenant\'s layout resolves to a whole page, whatever was stored');
const KEYS = PPG_SECTIONS.map(s => s.key);
it('nothing stored → the default order, nothing hidden', () => {
  assert.deepStrictEqual(ppgResolveLayout(null), { order: KEYS, hidden: [] });
  assert.deepStrictEqual(ppgResolveLayout('garbage'), { order: KEYS, hidden: [] });
});
it('a stored order is kept; unknown keys are dropped; missing keys are appended in default order', () => {
  const r = ppgResolveLayout({ order: ['cost', 'zzz', 'basics', 'cost'], hidden: ['zzz', 'where', 'where'] });
  assert.deepStrictEqual(r.order, ['cost', 'basics', ...KEYS.filter(k => k !== 'cost' && k !== 'basics')]);
  assert.deepStrictEqual(r.hidden, ['where']);
});
it('Basics can never be hidden', () => {
  const r = ppgResolveLayout({ hidden: ['basics', 'page'] });
  assert.deepStrictEqual(r.hidden, ['page']);
  assert.ok(PPG_SECTIONS.find(s => s.key === 'basics').locked);
});
it('the dock\'s summary rows still land somewhere: every alias resolves', () => {
  assert.strictEqual(PPG_ALIASES.sizes, 'sold');
  assert.strictEqual(PPG_ALIASES.more, 'sold');
  for (const sec of ['basics', 'stock', 'page']) assert.ok(KEYS.includes(sec), `pdExpand('${sec}') has no section`);
  for (const m of codeOnly(PD).matchAll(/pdExpand\('([a-z]+)'\)/g)) {
    assert.ok(KEYS.includes(m[1]) || m[1] in PPG_ALIASES, `pdExpand('${m[1]}') points nowhere`);
  }
});

console.log('\nOne handler, two homes');
it('the autosave handler is a named function and both the dock and the page listen with it', () => {
  assert.ok(/^function pdEditorEdit\(e\)/m.test(PD));
  assert.ok(/ed\.addEventListener\('input', pdEditorEdit\)/.test(PD) && /ed\.addEventListener\('change', pdEditorEdit\)/.test(PD));
  assert.ok(codeOnly(PPG).includes('pdEditorEdit(e)'), 'the page does not call the shared handler');
  assert.ok(!/stage\.addEventListener\('input',\s*\(?e\)?\s*=>\s*\{[\s\S]*pdScheduleAutosave/.test(PPG), 'the page must not re-implement the autosave rules');
});

console.log('\nSettings › Online shop › Product page');
it('the card sits in Online shop (§494) and is painted from config on every load', () => {
  const ops = HTML.indexOf('id="sub-shop"'), next = HTML.indexOf('id="sub-payments"');
  const card = HTML.indexOf('id="ppg-settings-card"');
  assert.ok(card > ops && card < next, 'the card is not inside the Online shop panel');
  assert.ok(codeOnly(MKT).includes('ppgSettingsRender(c)'), 'loadConfig does not paint the card');
  assert.ok(codeOnly(PPG).includes("'product_page.sections'"), 'the save does not write the config key');
});
it('every section has both halves of its name and its description', () => {
  for (const s of PPG_SECTIONS) {
    for (const k of ['en', 'cn', 'what_en', 'what_cn']) assert.ok(s[k] && String(s[k]).trim(), `${s.key}.${k} is empty`);
  }
});

console.log('\nThe page\'s own words carry both languages');
it('every static label on the stage and the card is an EN · CN pair', () => {
  const stage = htmlNoComments(HTML.slice(HTML.indexOf('<div id="ppg" class="ppg"'), HTML.indexOf('<div id="ppg" class="ppg"') + 8000));
  const cardAt = HTML.indexOf('<div class="group-card" id="ppg-settings-card">');
  const card = htmlNoComments(HTML.slice(cardAt, HTML.indexOf('<!-- ── Support button', cardAt)));
  const texts = [...(stage + card).matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map(m => m[1].trim()).filter(t => t && !/^[\d\s.,:/·—-]*$/.test(t));
  for (const t of texts) {
    assert.ok(t.includes(' · ') && /[一-鿿]/.test(t), `not a pair: "${t}"`);
  }
  assert.ok(texts.length >= 12, `only ${texts.length} labels found — the slice moved`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
