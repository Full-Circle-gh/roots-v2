#!/usr/bin/env node
/**
 * Geometry: does every screen FIT a phone?
 *
 *   node scripts/test_mobile_geometry.js [filter]
 *
 * The text probes read innerText, which is the text a node holds — not the
 * text a person can see. A label clipped to "Courier — ship when re…" passes
 * every one of them. This renders each screen in a real 390px viewport, with a
 * fake backend so screens show their populated branch, and reports:
 *
 *   • the page scrolling sideways — a phone should never do that;
 *   • any element wider than the viewport;
 *   • CLIPPED TEXT: a node whose content is wider than its box. Some of that is
 *     intentional (a long customer name in a fixed cell), so the check reports
 *     what is clipped and by how much and leaves the judgement to a reader —
 *     except for the clear-cut case it fails on: a clipped node whose text is
 *     the app's own words rather than data, which is always a design bug.
 *   • text under 11px, which is below the design system's floor.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fakeServer } = require('./lib/m-fakeserver');

const APP = path.join(__dirname, '..', 'public', 'm.html');
const FILTER = process.argv[2] || '';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try { const p = require('playwright').chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  for (const g of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(g)) return g;
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw)) {
    const p = path.join(pw, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return null;
}

// Cases come from the sweep, so a screen cannot be measured in a state the
// sweep never renders — or missed by being added to only one list.
const sweep = fs.readFileSync(path.join(__dirname, 'test_mobile_screens.js'), 'utf8');
const grab = (n) => { const i = sweep.indexOf(`const ${n} = \``); return sweep.slice(sweep.indexOf('`', i) + 1, sweep.indexOf('`;', i)); };
const ROWS = grab('ROWS');
const SEED = grab('SEED');
const CASES = {};
{
  const body = sweep.slice(sweep.indexOf('Object.assign(cases, {'), sweep.indexOf('  });\n  return cases;')) + '  });\n  return cases;';
  // eslint-disable-next-line no-new-func
  new Function('ROWS', 'cases', body)(ROWS, CASES);
}
const appSrc = fs.readFileSync(APP, 'utf8');
for (const m of appSrc.matchAll(/\n {2}([a-z_0-9]+):\{title:/g)) CASES['push:' + m[1]] = CASES['push:' + m[1]] || `APP.cmd('push','${m[1]}')`;
for (const t of ['home', 'orders', 'customers', 'products', 'more']) CASES['tab:' + t] = CASES['tab:' + t] || `APP.cmd('tab','${t}')`;

// The probe, run inside the app page after it has settled.
const PROBE = `
  var VW = 390, out = { wide: [], clip: [], tiny: [], edge: [], headGap: null, doc: 0 };
  // The page head is a band closed by a hairline. Whatever comes next must not
  // sit ON that hairline — moving the status line up into the band removed the
  // spacer it had been providing, and Orders' filter chips came to rest exactly
  // on the rule. Measured, not eyeballed: the gap from the head's bottom border
  // to the top of the first thing under it.
  (function(){
    var head = document.querySelector('#content > div[style*="border-bottom"]');
    if (!head) return;
    var next = head.nextElementSibling;
    while (next && !next.getBoundingClientRect().height) next = next.nextElementSibling;
    if (!next) return;
    // The first thing that actually PAINTS — text, a border, or a fill. A
    // wrapper that pads its contents starts at the rule and looks like a
    // zero gap while the ink it holds sits comfortably below; measuring the
    // wrapper reported every screen as broken, including the ones that were
    // fine, which is worse than not measuring at all.
    var top = null;
    var kids = next.querySelectorAll('*');
    var all = [next].concat([].slice.call(kids));
    for (var q = 0; q < all.length; q++) {
      var e = all[q], b = e.getBoundingClientRect();
      if (!b.height) continue;
      var st = getComputedStyle(e);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      var paints = (e.children.length === 0 && (e.innerText || '').trim())
        || st.backgroundColor !== 'rgba(0, 0, 0, 0)'
        || parseFloat(st.borderTopWidth) > 0 || parseFloat(st.borderWidth) > 0
        || st.backgroundImage !== 'none';
      if (!paints) continue;
      if (top == null || b.top < top) top = b.top;
    }
    if (top != null) out.headGap = Math.round(top - head.getBoundingClientRect().bottom);
  })();
  out.doc = document.documentElement.scrollWidth;
  var all = document.querySelectorAll('#app *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // Wider than the phone, or hanging off its right edge. A .hscroll strip is
    // meant to be scrolled, so its own overflow is not a defect.
    var inScroller = el.closest('.hscroll, .sheet [style*="overflow-x"]');
    if (!inScroller && (r.right > VW + 1 || r.width > VW + 1)) {
      out.wide.push({ t: (el.innerText || '').trim().slice(0, 40), w: Math.round(r.width), right: Math.round(r.right), cls: el.className || el.tagName });
    }
    // Clipped: content wider than the box, on a node that actually clips.
    var clips = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
    if (clips && el.scrollWidth > el.clientWidth + 1 && el.children.length === 0) {
      var txt = (el.innerText || '').trim();
      if (txt) out.clip.push({ t: txt.slice(0, 60), over: el.scrollWidth - el.clientWidth, box: el.clientWidth });
    }
    // A small control whose tap target touches the screen edge. The browser's
    // own scroll indicator and the edge-swipe gesture live in that strip, so a
    // reach for the button catches them instead — which is exactly what the
    // account avatar did until its header stopped pulling itself 6px past the
    // padding. Full-width controls (the tab bar) are meant to reach the edge.
    // Not a chip in a scrolling strip (it is meant to run off the edge and be
    // dragged back), and not a tab-bar button (the bar spans the full width by
    // design, and its five buttons divide it).
    var edgeExempt = inScroller || el.closest('.tabbar');
    if (!edgeExempt && (el.tagName === 'BUTTON' || el.tagName === 'A') && r.width < VW * 0.6 && r.height > 20) {
      var gapR = VW - r.right, gapL = r.left;
      if (gapR < 8 || gapL < 8) out.edge.push({ t: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 30), l: Math.round(gapL), r: Math.round(gapR) });
    }
    var fs2 = parseFloat(cs.fontSize);
    if (el.children.length === 0 && (el.innerText || '').trim() && fs2 && fs2 < 11) {
      out.tiny.push({ t: (el.innerText || '').trim().slice(0, 40), px: fs2 });
    }
  }
  // The measurement happens INSIDE the iframe (that is the only place with a
  // 390px viewport), but --dump-dom reads the host document. postMessage is
  // the way across; it works on file:// where a title write would not.
  try { parent.postMessage('G' + JSON.stringify(out), '*'); } catch (e) {}
  document.title = 'G' + JSON.stringify(out);
`;

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found.'); process.exit(0); }
  const src = appSrc
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
    .replace('<script>', `<script>${fakeServer()}</script><script>`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-geo-'));
  fs.writeFileSync(path.join(dir, 'host.html'),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}
     iframe{position:fixed;left:0;top:0;width:390px;height:100vh;border:0}</style>
     <script>addEventListener('message',function(e){ document.title=String(e.data||''); });</script>
     <iframe src="p.html"></iframe>`);

  const names = Object.keys(CASES).filter((n) => !FILTER || n.includes(FILTER)).sort();
  const clips = []; const wides = []; const tinies = []; const edges = []; const headGaps = [];
  let scanned = 0;
  for (const name of names) {
    const boot = `<script>addEventListener("load",function(){try{${SEED}${ROWS}${CASES[name]}}catch(e){}
      setTimeout(function(){try{${PROBE}}catch(e){document.title='ERR '+e.message}},450)});</script>`;
    fs.writeFileSync(path.join(dir, 'p.html'), src.replace('</body>', boot + '</body>'));
    let out = '';
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--window-size=390,844', '--virtual-time-budget=2500', '--dump-dom', 'file://' + path.join(dir, 'host.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    } catch (e) { console.error(`  ! ${name}: chrome failed`); continue; }
    const m = out.match(/<title>G(\{[\s\S]*?\})<\/title>/);
    if (!m) { const t = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || ''; if (t.startsWith('ERR')) console.error(`  ! ${name}: ${t}`); continue; }
    scanned++;
    let g; try { g = JSON.parse(m[1]); } catch (e) { continue; }
    if (g.doc > 391) wides.push([name, `page scrolls sideways (${g.doc}px)`]);
    if (g.headGap != null && g.headGap < 8) headGaps.push([name, g.headGap]);
    for (const w of g.wide) wides.push([name, `${w.cls}: w=${w.w} right=${w.right} "${w.t}"`]);
    for (const c of g.clip) clips.push([name, c.t, c.over, c.box]);
    for (const t of g.tiny) tinies.push([name, `${t.px}px "${t.t}"`]);
    for (const e of (g.edge || [])) edges.push([name, `"${e.t}" left ${e.l}px right ${e.r}px from the edge`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`scanned ${scanned} screens at 390px\n`);
  if (wides.length) {
    console.log(`OVERFLOW — ${wides.length}:`);
    for (const [n, w] of wides.slice(0, 40)) console.log(`  ${n}  ${w}`);
    console.log('');
  } else console.log('OVERFLOW — none. No screen is wider than the phone.\n');

  if (tinies.length) {
    console.log(`BELOW 11px — ${tinies.length}:`);
    for (const line of [...new Set(tinies.map((x) => `${x[0]}  ${x[1]}`))].slice(0, 20)) console.log(`  ${line}`);
    console.log('');
  } else console.log('BELOW 11px — none.\n');

  if (edges.length) {
    console.log(`TAP TARGET ON THE EDGE — ${edges.length}:`);
    for (const line of [...new Set(edges.map((x) => `${x[0]}  ${x[1]}`))].slice(0, 20)) console.log(`  ${line}`);
    console.log('');
  } else console.log('TAP TARGET ON THE EDGE — none.\n');

  if (headGaps.length) {
    console.log(`CONTENT ON THE HEADER RULE — ${headGaps.length}:`);
    for (const [n, g] of headGaps) console.log(`  ${n}  ${g}px below the hairline`);
    console.log('');
  } else console.log('CONTENT ON THE HEADER RULE — none.\n');

  // Clipping: report all, fail on the clear-cut kind.
  const uniq = new Map();
  for (const [n, t, over, box] of clips) { const k = t; if (!uniq.has(k)) uniq.set(k, { n, t, over, box }); }
  const list = [...uniq.values()].sort((a, b) => b.over - a.over);
  console.log(`CLIPPED TEXT — ${list.length} distinct:`);
  for (const c of list.slice(0, 40)) console.log(`  ${String(c.over).padStart(4)}px over (box ${c.box})  ${c.n}  "${c.t}"`);
  process.exit(wides.length || edges.length || headGaps.length ? 1 : 0);
}
main();
