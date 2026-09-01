#!/usr/bin/env node
/**
 * Quick stock — every state rendered headless, plus the Tacet rules that a
 * render cannot see.
 *
 * Why this exists: public/stock.html is one file that paints by rebuilding its
 * own innerHTML, and it is the surface with the fewest human eyes on it — shop
 * staff use it on a phone, in a kitchen, and never file a bug. So the check is
 * "did anything throw, and does each state say its own sentence", across every
 * screen, both languages, both themes and both modes.
 *
 * The static passes guard the design rules that survive a render: the dead
 * palette, uppercase, half-pixel sizes, weights above 500, off-scale sizes and
 * radii, a Dusk fill (this page's Dusk budget is zero — every write here is the
 * operator counting their own shelf), a bilingual pair whose Chinese half is
 * English, a native dialog, and a failure sent out as a toast.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', 'public', 'stock.html');
const src = fs.readFileSync(APP, 'utf8');

const CSS = (src.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
// Comments explain the rules and quote the values they forbid, so every check
// below reads the declarations, not the prose around them.
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
const SRC_CODE = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const RAW_JS = (src.match(/<script>\n\(function[\s\S]*?<\/script>/) || [])[0] || '';
const JS = RAW_JS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const problems = [];
function fail(msg) { problems.push(msg); }

// ── The dead palette. Rebrand hygiene (§1.16): the lime accent and the
// charcoal surfaces are the previous brand, and one survivor re-seeds it.
{
  const dead = ['#ccd900', '#dde858', '#16161a', '#1f1f24', '#efe9da', '#fbf8ee',
    '--accent', '--bg-app', '--bg-pane', '--bg-elev', '--accent-ink', '--line-strong'];
  for (const d of dead) if (SRC_CODE.includes(d)) fail(`dead token "${d}" still in the file`);
}

// ── §1.6: there is no licensed uppercase in Tacet.
if (/text-transform\s*:\s*uppercase/i.test(CSS_CODE)) fail('text-transform: uppercase');

// ── §1.3: no half-pixels, no weight above 500, no Fraunces in product UI.
for (const m of CSS_CODE.matchAll(/(\d*\.\d+)px/g)) fail(`half-pixel size ${m[1]}px`);
for (const m of CSS_CODE.matchAll(/font-weight\s*:\s*([a-z0-9]+)/g)) {
  if (!['400', '500', 'inherit'].includes(m[1])) fail(`font-weight ${m[1]} — Tacet has 400 and 500`);
}
if (/Fraunces/i.test(SRC_CODE)) fail('Fraunces appears in product UI');

// ── §1.3: six type steps, no others.
{
  const scale = new Set(['13px', '15px', '18px', '24px', '30px']);
  for (const m of CSS_CODE.matchAll(/font-size\s*:\s*([\d.]+px)/g)) {
    if (!scale.has(m[1])) fail(`off-scale font-size ${m[1]}`);
  }
}

// ── §1.4: 8px controls, 14px cards, pills full. Nothing else.
{
  const ok = new Set(['0', '8px', '14px', '999px', '50%']);
  for (const m of CSS_CODE.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    for (const v of m[1].trim().split(/\s+/)) if (!ok.has(v)) fail(`off-system radius "${v}"`);
  }
}

// ── §1.8: this page spends no Dusk. Dusk means tacet acted, and nothing on
// this page is tacet acting — the focus ring (exempt, rule 3) and the mark's
// own dot are the only places the colour is allowed to appear.
{
  const fills = [...CSS_CODE.matchAll(/background\s*:\s*var\(--dusk\)/g)].length;
  if (fills) fail(`${fills} Dusk fill(s) — Quick stock's Dusk budget is zero`);
  const duskTint = [...CSS_CODE.matchAll(/background\s*:\s*var\(--dusk-tint\)/g)].length;
  if (duskTint > 1) fail(`${duskTint} Dusk-tint surfaces — only the avatar earns one`);
}

// ── §1.11: both halves of every pair, or half the staff read English.
{
  const cjk = (s) => /[一-鿿]/.test(s);
  for (const m of JS.matchAll(/(^|[^\w$.])t\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
    const en = m[2], zh = m[3];
    if (cjk(zh)) continue;
    if (/[A-Za-z]{3}/.test(zh) && zh === en) fail(`bilingual pair "${en}" has no Chinese`);
    else if (/[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(zh)) fail(`bilingual pair "${en}" has no Chinese`);
  }
}

// ── A native dialog is not a Tacet surface: it is uppercase-buttoned system
// chrome the product cannot style, quiet or translate. Decisions are made in
// the page.
for (const d of ['window.confirm(', 'window.alert(', 'window.prompt(']) {
  if (JS.includes(d)) fail(`${d} — a decision belongs in the page, not in a system dialog`);
}

// ── §1.12: toasts confirm, they never report a failure. A failed write renders
// where the operator is looking and stays until they act on it.
if (/toast\([^)]*,\s*'err'/.test(JS)) fail("toast(msg, 'err') — a failure must not leave in a toast");
if (/function toast\s*\(\s*msg\s*,/.test(JS)) fail('toast() still takes a kind argument');

// ── A1: a Worklist updates itself — no refresh button, no live indicator.
if (/id="refreshBtn"/.test(src)) fail('a refresh button — a Worklist keeps itself current (A1)');

// ── The mark: §8a holds the stroke at 1.6px optically. Scaled from the
// viewBox it resolves to 0.64px and the mark quietly disappears.
if (!/vector-effect:non-scaling-stroke;stroke-width:1\.6/.test(CSS_CODE)) {
  fail('the topbar mark is not held at a 1.6px optical stroke (§8a)');
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL static — ${p}`);
  console.error(`\n${problems.length} design-rule violation${problems.length === 1 ? '' : 's'}.`);
  process.exit(1);
}

// ── Render pass ─────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* playwright not installed here */ }
  const guesses = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const g of guesses) { if (fs.existsSync(g)) return g; }
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CTX = {
  enabled: true, mode: 'recount',
  user: { name: 'Asher', full_access: true },
  stores: [{ id: 1, name_en: 'Tianhe', name_cn: '天河店', code: 'TH' }],
};
const TWO_STORES = { stores: [CTX.stores[0], { id: 2, name_en: 'Panyu', name_cn: '番禺店', code: 'PY' }] };
const ROWS = [
  { product_id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: '1-10', physical_qty: 11, restock_target: 5 },
  { product_id: 8, name_en: 'Turkish Tomato Salad', name_cn: '土耳其番茄沙拉', sku: '1-15', physical_qty: 0, restock_target: 5 },
  { product_id: 9, name_en: 'Arugula-Basil Pesto', name_cn: '芝麻菜青酱', sku: '1-20', physical_qty: 3, restock_target: 6 },
];
const STOCKED = [ROWS[0]];
// A shelf long enough to scroll. Three rows do not fill a phone, so a fold test
// against ROWS scrolls by nothing and passes for the wrong reason.
const MANY = [];
for (let i = 0; i < 9; i++) {
  MANY.push(Object.assign({}, ROWS[i % 3], { product_id: 100 + i, sku: '2-' + (10 + i) }));
}

// The page is the whole app: it self-authenticates and reads two endpoints.
// The stub answers both, and can fail either one — half the states on this
// screen only exist when the network says no.
function stub(o) {
  return '<script>\n' +
    'window.__e=[];\n' +
    'addEventListener("error",function(e){window.__e.push(e.message)},true);\n' +
    'addEventListener("unhandledrejection",function(e){window.__e.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});\n' +
    'var CTX=' + JSON.stringify(o.ctx) + ',STOCK=' + JSON.stringify(o.rows) + ',FAIL=' + JSON.stringify(o.fail || {}) + ';\n' +
    'window.fetch=function(url){url=String(url);var body;\n' +
    '  if(url.indexOf("/quick-stock/context")>-1) body=FAIL.context?{success:false,error:"context down"}:{success:true,data:CTX};\n' +
    '  else if(/\\/stock\\/\\d+$/.test(url)) body=FAIL.write?{success:false,error:"write down"}:{success:true,data:{}};\n' +
    '  else if(/\\/stock$/.test(url)) body=FAIL.stock?{success:false,error:"stock down"}:{success:true,data:STOCK};\n' +
    '  else body={success:true,data:{}};\n' +
    '  return Promise.resolve({status:200,json:function(){return Promise.resolve(body)}});};\n' +
    '</scr' + 'ipt>';
}

const CASES = {
  'list': { rows: ROWS, expect: ['Quick stock', 'Sold out', 'Running low', 'Hummus Asli'],
    absent: ['In stock'] },                       // a well-stocked row wears no pill (§1.10)
  'list-cn': { rows: ROWS, pre: "localStorage.setItem('roots-admin-lang','cn');", expect: ['快速库存', '售罄', '库存偏低'] },
  'list-dark': { rows: ROWS, pre: "localStorage.setItem('roots_theme','dark');", expect: ['Hummus Asli'],
    theme: 'dark' },
  'single-store-hides-picker': { rows: ROWS, expect: ['Quick stock'], absent: ['Tianhe'] },
  'two-stores-shows-picker': { rows: ROWS, ctxPatch: TWO_STORES, expect: ['Tianhe'] },
  'add-mode': { rows: ROWS, ctxPatch: { mode: 'add' }, expect: ['Add stock', '+0'], absent: ['Sold out'] },
  'empty': { rows: [], expect: ['Nothing to count here yet.'] },
  'no-results': { rows: ROWS, expect: ['No products match', 'Clear search'],
    js: "var q=document.getElementById('q');q.value='zzz';q.dispatchEvent(new Event('input'));" },
  'filter-out-none': { rows: STOCKED, expect: ['No products are sold out.', 'Show all'],
    js: "document.querySelector('.chip[data-filter=\"out\"]').click();" },
  'load-error': { rows: ROWS, fail: { stock: true }, expect: ['The shelf didn’t load.', 'Try again'] },
  'context-error': { rows: ROWS, fail: { context: true }, expect: ['That didn’t load'] },
  'off': { rows: ROWS, ctxPatch: { enabled: false }, expect: ['Quick stock is off'] },
  'nostore': { rows: ROWS, ctxPatch: { stores: [] }, expect: ['No store assigned'] },
  'keypad': { rows: ROWS, expect: ['Set count', 'Save', 'Hummus Asli'], opens: 'kpSheet',
    js: "document.querySelector('.row .qty').click();" },
  'store-sheet': { rows: ROWS, ctxPatch: TWO_STORES, expect: ['Choose store', 'Panyu'], opens: 'storeSheet',
    js: "document.getElementById('storeBtn').click();" },
  'account-sheet': { rows: ROWS, expect: ['Signed in as Asher', 'Language', 'Appearance', 'Sign out'],
    absent: ['Cancel'],                            // the confirm is asked for, not standing open
    opens: 'acctSheet', js: "document.getElementById('acctBtn').click();" },
  // THE WAY BACK out of a single-purpose app, and it lives in the HEAD — the
  // place every pushed screen on a phone keeps it. An operator whose whole job
  // is this screen has no home to return to and is given no control at all; the
  // server decides which they are (`home`), because only it knows whether the
  // role is locked to this app and would be redirected straight back.
  'no-way-back-for-a-locked-role': { rows: ROWS, expect: ['Quick stock'],
    absent: ['Back', 'Kitchen'], headStack: 'none' },
  'back-to-the-home-it-came-from': { rows: ROWS,
    ctxPatch: { home: '/m', home_label: { en: 'Kitchen', cn: '后厨' } },
    expect: ['Kitchen', 'Quick stock'],            // named for where it goes, not "Back"
    headStack: 'stacked' },                        // and ABOVE the title, as every pushed screen has it
  'back-in-chinese': { rows: ROWS,
    ctxPatch: { home: '/m', home_label: { en: 'Kitchen', cn: '后厨' } },
    pre: "localStorage.setItem('roots-admin-lang','cn');",
    expect: ['后厨'], absent: ['Kitchen'] },
  // A home whose name did not travel still gets a way back, with the honest
  // generic rather than a guess at what the screen is called.
  'back-with-no-name-for-its-destination': { rows: ROWS, ctxPatch: { home: '/m' },
    expect: ['Back', 'Quick stock'] },
  'sign-out-confirm': { rows: ROWS, expect: ['Sign out', 'Cancel'], opens: 'acctSheet',
    js: "document.getElementById('acctBtn').click();document.getElementById('signOutBtn').click();" },
  'write-in-flight': { rows: ROWS, expect: ['Saving'],
    js: "document.querySelector('.row .plus').click();" },
  'write-error': { rows: ROWS, fail: { write: true }, wait: 1600, expect: ['Didn’t save', 'Retry'],
    js: "document.querySelector('.row .plus').click();" },
  // The head folds once the list is moving: the account button rides into the
  // pinned band, the page height never changes, and nothing lands on the edge.
  // The scroll WAITS FOR A ROW rather than for a delay: while the page is still
  // a skeleton it is too short to scroll, so a timed scroll clamps to nothing
  // and the case passes for the wrong reason — which it did, intermittently,
  // before this loop replaced the setTimeout.
  'folded': { rows: MANY, compact: true, acct: 'visible', wait: 900,
    expect: ['Hummus Asli'],
    // The scroll event is DELIVERED BY HAND, and that is not cheating: a browser
    // fires scroll (and rAF, and IntersectionObserver) during its rendering
    // step, and headless Chrome under a virtual clock produces no frames after
    // load — so a real scroll here moves the page and notifies nobody. The
    // position is real; only the notification is ours. What is under test is
    // what the handler does at scrollY=400, which is the part that can break.
    js: "var t=setInterval(function(){if(!document.querySelector('.row'))return;"
      + "window.scrollTo(0,400);window.dispatchEvent(new Event('scroll'));"
      + "if(document.body.classList.contains('compact')){clearInterval(t);window.__ready=1;}},40);" },
  'not-folded-at-rest': { rows: ROWS, expect: ['Quick stock', 'Tianhe'], compact: false,
    acct: 'hidden', ctxPatch: TWO_STORES },
  'add-error': { rows: ROWS, ctxPatch: { mode: 'add' }, fail: { write: true }, wait: 1800,
    expect: ['Didn’t add', 'Retry'], js: "document.querySelector('.row .plus').click();" },
};

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP — no Chromium found. Set CHROME_BIN to run the render pass.');
    process.exit(0);
  }
  // No network in a test runner: the font stylesheet would hold the page open
  // until it times out.
  const base = src.replace(/<link rel="stylesheet" media="print"[\s\S]*?>\n/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-screens-'));
  const failures = [];

  for (const [name, c] of Object.entries(CASES)) {
    const ctx = Object.assign({}, CTX, c.ctxPatch || {});
    const wait = c.wait || 400;
    // Assertions read what the STAFFER sees — innerText, not the DOM dump: the
    // dump carries every comment and every sheet parked off-screen, so a
    // substring check against it passes on prose and on states nobody opened.
    // The stamp waits for the case to say it is ready (window.__ready) and only
    // falls back to the raw delay if it never does. A case that scrolls and then
    // waits a fixed 900ms is a race: under a virtual clock the fold callback can
    // land on either side of it, which is exactly how this suite went
    // intermittently red before the flag existed.
    const probe = '<script>addEventListener("load",function(){setTimeout(function(){' +
      'try{' + (c.js || '') + '}catch(e){window.__e.push("case: "+e.message)}' +
      'var t0=Date.now();var iv=setInterval(function(){' +
      '  if(!window.__ready && Date.now()-t0 < ' + wait + ') return;' +
      '  clearInterval(iv);stamp();},40);' +
      // THE HEAD'S SHAPE, measured rather than described. The back link went in
      // as a third item of the title ROW, which put "Kitchen" and "Add stock"
      // side by side — a header this screen shares with nothing else in the
      // product, on the one screen an operator arrives at from another app.
      // Text assertions cannot see that: both words are present either way.
      // "stacked" = the back link ends above where the title begins.
      'function headStack(){var b=document.getElementById("backHome"),h=document.querySelector("#pageHead h1");' +
      '  if(!b||!h||b.hidden) return "none";' +
      '  var rb=b.getBoundingClientRect(), rh=h.getBoundingClientRect();' +
      '  if(!rb.height||!rh.height) return "none";' +
      '  return rb.bottom<=rh.top+1 ? "stacked" : "inline";}' +
      'function stamp(){var n=document.querySelectorAll("#app *").length;' +
      'document.body.setAttribute("data-headstack",headStack());' +
      'var seen=(document.getElementById("app").innerText||"").replace(/\\s+/g," ");' +
      'var sheets=[].slice.call(document.querySelectorAll(".sheet.show"));' +
      'seen+=" "+sheets.map(function(s){return s.innerText.replace(/\\s+/g," ")}).join(" ");' +
      'document.body.setAttribute("data-seen",seen);' +
      'document.body.setAttribute("data-open",sheets.map(function(s){return s.id}).join(","));' +
      // The screen-edge rule, measured rather than eyeballed: no control may
      // render within 8px of the top of the phone. This is what the pinned
      // search band broke — it had no top padding, so the moment it pinned the
      // input sat flush on the edge with cards sliding under it.
      'var ctrls=[].slice.call(document.querySelectorAll("#band input,#band button,.row button"));' +
      'var tops=ctrls.map(function(e){var r=e.getBoundingClientRect();' +
      '  return (r.height>0&&r.bottom>0)?Math.round(r.top):9999});' +
      'document.body.setAttribute("data-mintop",String(Math.min.apply(null,tops.concat([9999]))));' +
      'document.body.setAttribute("data-compact",document.body.classList.contains("compact")?"1":"0");' +
      'document.body.setAttribute("data-acct",getComputedStyle(document.getElementById("acctPinned")).visibility);' +
      'document.title=window.__e.length?("ERR "+window.__e.join(" | ")):("OK "+n);}},80)});</scr' + 'ipt>';
    // The preference script goes in the HEAD, ahead of the page's own theme and
    // language boot — set after it, a preference is one the page has already read.
    const pre = c.pre ? '<script>' + c.pre + '</scr' + 'ipt>' : '';
    const html = base
      .replace('<head>', '<head>' + pre)
      .replace('<body>', '<body>' + stub({ ctx: ctx, rows: c.rows, fail: c.fail }))
      .replace('</body>', probe + '</body>');
    const file = path.join(dir, name.replace(/[^a-z0-9]/gi, '_') + '.html');
    fs.writeFileSync(file, html);
    let out = '';
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=402,874', '--virtual-time-budget=6000', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000 });
    } catch (e) { failures.push([name, 'chrome failed: ' + e.message]); continue; }
    if (process.env.DEBUG_CASE && name === process.env.DEBUG_CASE) {
      console.log('DEBUG', name, (out.match(/data-mintop="[^"]*"/) || ['-'])[0], (out.match(/data-compact="[^"]*"/) || ['-'])[0], (out.match(/data-open="[^"]*"/) || ['-'])[0]);
    }
    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (!title.startsWith('OK')) { failures.push([name, title]); continue; }
    const nodes = Number((title.match(/^OK (\d+)/) || [])[1] || 0);
    if (nodes < 12) { failures.push([name, `painted only ${nodes} nodes`]); continue; }
    const seen = (out.match(/data-seen="([^"]*)"/) || [])[1] || '';
    const open = (out.match(/data-open="([^"]*)"/) || [])[1] || '';
    const minTop = Number((out.match(/data-mintop="(-?\d+)"/) || [])[1]);
    const compact = (out.match(/data-compact="([01])"/) || [])[1];
    const headStack = (out.match(/data-headstack="([a-z]+)"/) || [])[1];
    if (c.headStack && headStack !== c.headStack) {
      failures.push([name, `the back link is “${headStack}” with the title, expected “${c.headStack}”`]);
    }
    if (Number.isFinite(minTop) && minTop < 8) {
      failures.push([name, `a control renders ${minTop}px from the top of the screen — nothing sits on the edge`]);
    }
    if (c.compact !== undefined && compact !== (c.compact ? '1' : '0')) {
      failures.push([name, `head is ${compact === '1' ? 'folded' : 'open'}, expected the opposite`]);
    }
    // Folded, the pinned band is the whole chrome — so the way out has to be in
    // it. At rest its slot is reserved but empty, or the search field would
    // change width as the operator scrolls.
    const acct = (out.match(/data-acct="([a-z]+)"/) || [])[1];
    if (c.acct && acct !== c.acct) {
      failures.push([name, `the pinned account button is ${acct}, expected ${c.acct}`]);
    }
    for (const want of c.expect || []) {
      if (!seen.includes(want)) failures.push([name, `never says “${want}”`]);
    }
    for (const no of c.absent || []) {
      if (seen.includes(no)) failures.push([name, `says “${no}” and should not`]);
    }
    if (c.opens && open !== c.opens) failures.push([name, `opened “${open || 'nothing'}”, expected “${c.opens}”`]);
    if (c.theme && !out.includes(`data-theme="${c.theme}"`)) failures.push([name, `did not render in the ${c.theme} theme`]);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    for (const [name, why] of failures) console.error(`FAIL ${name} — ${why}`);
    console.error(`\n${failures.length} of ${Object.keys(CASES).length} screens failed.`);
    process.exit(1);
  }
  console.log(`ok — ${Object.keys(CASES).length} screens rendered, no uncaught errors; design rules hold.`);
}

main();
