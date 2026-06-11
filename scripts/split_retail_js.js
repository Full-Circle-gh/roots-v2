// One-off: split public/retail-admin.js (17.7k lines) into 10 per-feature
// files under public/retail-admin/, loaded sequentially by retail-admin.html.
// Step 2b of the file split (Step 1 = CSS, Step 2a = inline JS -> one file).
//
// Safety model:
//   - Cuts ONLY at the file's own "// ═══" section banners (top-level comment
//     lines), verified against the expected section title — aborts on any
//     mismatch without touching anything.
//   - Sequential classic <script src> files share one global scope and run in
//     exactly the same order as the single file, so semantics are identical
//     EXCEPT function-declaration hoisting across file edges. The only
//     load-time hoisting consumer (the ?tab= deep-link IIFE that synchronously
//     click()s a tab) is relocated to the END of the last part — which also
//     fixes the latent bug that deep-link clicks fired before later sections
//     registered their lazy-load tab listeners.
//   - Every output file is `node --check`ed; on any failure all outputs are
//     removed and the source files are left untouched.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const srcPath = path.join(__dirname, '..', 'public', 'retail-admin.js');
const outDir = path.join(__dirname, '..', 'public', 'retail-admin');
const htmlPath = path.join(__dirname, '..', 'public', 'retail-admin.html');

function abort(msg) { console.error('ABORT: ' + msg); process.exit(1); }

const raw = fs.readFileSync(srcPath, 'utf8');
if (!raw.includes('\r\n')) abort('expected CRLF in retail-admin.js');
const lines = raw.split('\r\n');

// ── Locate the real first code line (skip the eslint/extraction header) ──
const codeStart = lines.findIndex(l => l.startsWith('const $  = s => document.querySelector'));
if (codeStart < 0) abort('bootstrap line (const $ ...) not found');

// ── Section boundaries: [1-based banner line, expected title on next line] ──
// Cut lines are the section banners so each file starts with its own title.
const CUTS = [
  [745,   'OPERATIONS PANEL'],
  [1984,  'DASHBOARD'],
  [3872,  'ORDERS'],
  [6617,  'VOUCHERS'],
  [8240,  'DELIVERY ZONES'],
  [9498,  'MEDIA LIBRARY'],
  [11439, 'CUSTOMERS TAB'],
  [12438, 'PRODUCTS'],
  [16274, 'AFFILIATE'],
];
for (const [ln, title] of CUTS) {
  if (!lines[ln - 1] || !lines[ln - 1].startsWith('// ═')) abort(`line ${ln} is not a section banner`);
  if (!lines[ln] || !lines[ln].includes(title)) abort(`line ${ln + 1} does not mention "${title}"`);
}

const PARTS = [
  ['01-core.js',            'bootstrap ($/$$, ICONS, toast/api/escape helpers, payment labels), tab switcher, editor-iframe lazy-load, kitchen-categories editor (cat*)'],
  ['02-settings-ops.js',    'Operations panel (stores, shipping integrations, printers, geocode), command palette (Ctrl+K), visual preview painters, account menu (acct*)'],
  ['03-dashboard.js',       'Dashboard: KPIs/trend/cohorts (dash*), right-now hero, bento tiles, view popover (dv*)'],
  ['04-orders.js',          'Orders: list/filters/KPIs, pollers + badges + chime, order drawer, shipments/tracking/split, refunds'],
  ['05-marketing.js',       'vouchers/coupons + grants, snippets editor, storefront settings + feature gates + customer service, social proof, shop categories, broadcasts, pop-ups'],
  ['06-delivery.js',        'China regions/districts, delivery zones (dz*), apply-to-zones panel, mobile delivery hub (rmDlv*)'],
  ['07-content-billing.js', 'media library, copy helpers, invoices, wallet top-up + points + tiers, review tags, FAQ/legal, reviews, feedback inbox, flash sales (fs*)'],
  ['08-customers.js',       'customers (cu*): list/KPIs, detail drawer, edit/block/adjust, addresses, per-customer affiliate block'],
  ['09-products.js',        'products (pa/pd/va/bu prefixes): overview grid, bulk ops, product editor, variants, bundles, gallery, RTE, designer blocks, preview'],
  ['10-extras.js',          'affiliate tab (af*), theme + UI scale, i18n engine (cuT/cuToggleLang/onLangChange), help tooltip, leaderboard, polls/voting, About page, live preview drawer, ?tab= deep-link boot'],
];

// Build [startIdx, endIdx) line ranges (0-based) for the 10 parts.
const starts = [codeStart, ...CUTS.map(([ln]) => ln - 1)];
const ranges = starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : lines.length]);

// ── Pull the ?tab= deep-link block out of part 1 (moved to end of part 10) ──
const part1 = lines.slice(ranges[0][0], ranges[0][1]);
const dlStart = part1.findIndex(l => l.startsWith('// Deep-link:'));
if (dlStart < 0) abort('deep-link comment not found in part 1');
let dlEnd = dlStart;
while (dlEnd < part1.length && part1[dlEnd].trim() !== '})();') dlEnd++;
if (dlEnd - dlStart > 12) abort('deep-link block looks too long — layout changed?');
const deepLink = part1.splice(dlStart, dlEnd - dlStart + 1);

if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) abort('public/retail-admin/ already has files');
fs.mkdirSync(outDir, { recursive: true });

const written = [];
function fail(msg) { written.forEach(f => { try { fs.unlinkSync(f); } catch {} }); abort(msg); }

PARTS.forEach(([name, desc], i) => {
  const body = i === 0 ? part1 : lines.slice(ranges[i][0], ranges[i][1]);
  const header = [
    '/* eslint-disable no-undef, no-func-assign, no-self-assign */',
    `/* retail-admin app JS — part ${String(i + 1).padStart(2, '0')}/10.`,
    '   All 10 parts share ONE global scope and are loaded sequentially by',
    '   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,',
    '   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline',
    '   script blocks still in the HTML, hence the eslint no-undef opt-out.',
    `   Contents: ${desc} */`,
  ];
  const extra = (i === PARTS.length - 1)
    ? ['', '// ?tab= deep-link boot — relocated here from part 01 so the synchronous',
       '// .click() runs AFTER every part has registered its lazy-load tab listener',
       '// (in the old single file it fired before them and deep-linked tabs never',
       '// lazy-loaded; it also kept a cross-file hoisting dependency alive).',
       ...deepLink]
    : [];
  const out = path.join(outDir, name);
  fs.writeFileSync(out, header.concat(body, extra).join('\r\n') + '\r\n', 'utf8');
  written.push(out);
  const chk = cp.spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
  if (chk.status !== 0) fail(`node --check failed for ${name}:\n${chk.stderr}`);
  console.log(`  ${name}: ${header.length + body.length + extra.length} lines — syntax OK`);
});

// ── Rewire retail-admin.html ──
const html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('\r\n')) fail('expected CRLF in retail-admin.html');
const hLines = html.split('\r\n');

const tagIdx = hLines.findIndex(l => l.trim() === '<script src="/assets/retail-admin.js"></' + 'script>');
if (tagIdx < 0) fail('single retail-admin.js script tag not found in HTML');
hLines.splice(tagIdx, 1,
  '<!-- App JS — one global scope split across 10 files; ORDER MATTERS (see each file header). -->',
  ...PARTS.map(([n]) => `<script src="/assets/retail-admin/${n}"></` + 'script>'));

const preIdx = hLines.findIndex(l => l.trim() === '<link rel="preload" href="/assets/retail-admin.js" as="script">');
if (preIdx < 0) fail('retail-admin.js preload link not found in HTML head');
hLines.splice(preIdx, 1, ...PARTS.map(([n]) => `<link rel="preload" href="/assets/retail-admin/${n}" as="script">`));

// Refresh the head comment that documents the split (non-fatal if reworded).
const cIdx = hLines.findIndex(l => l.includes('main app JS lives in /assets/retail-admin.js'));
if (cIdx >= 0) {
  hLines[cIdx] = hLines[cIdx].replace('/assets/retail-admin.js (loaded mid-body, same spot', '/assets/retail-admin/*.js (10 files, loaded mid-body, same spot');
} else {
  console.warn('  (head comment not updated — wording not found; cosmetic only)');
}

fs.writeFileSync(htmlPath, hLines.join('\r\n'), 'utf8');
fs.unlinkSync(srcPath);

console.log(`Done. 10 files in public/retail-admin/; retail-admin.js deleted; HTML rewired (${hLines.length} lines).`);
console.log('Next: git add -A public/ scripts/split_retail_js.js && commit (deploy skips the deletion; stale retail-admin.js stays on the server unreferenced — harmless).');
