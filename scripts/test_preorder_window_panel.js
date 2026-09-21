// §211 — the card says whether the pre-order window is open, and why not
// (npm run test:preorder-window-panel).
//
// Ash, after §210 pointed him at the allowance: "ok add" — the missing thing
// being that nothing on screen said whether the window was open right now or
// what number a platform was being shown.
//
// THE FAILURE THIS GUARDS IS A PANEL THAT LOOKS FINE AND SAYS NOTHING TRUE.
// Three ways it could happen, and each is a case here:
//
//   1  A reason the server can return and the card has no line for. The panel
//      would print a raw token like `not_a_batch_day` at an operator. So every
//      `shut('…')` reason in lib/batch-cadence.js must appear in the card's own
//      switch — read out of both files rather than listed here, because a list
//      here would be the fourth copy and would rot first.
//   2  A string on the panel in one language. The admin renders one language at
//      a time; a label with no Chinese half is invisible to half the people who
//      use it.
//   3  A panel with nowhere to mount, or a renderer nobody calls. Both ship
//      green and draw nothing.
//
// Source-level on purpose. The endpoint lives in a 36,000-line router whose
// dependency tree is the whole product; what is actually at risk here is the
// AGREEMENT between three files, and that is exactly what source can prove.
//
// Run: node scripts/test_preorder_window_panel.js

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const cadence  = read('lib/batch-cadence.js');
const delivery = read('public/retail-admin/06-delivery.js');
const shell    = read('public/retail-admin.html');
const retail   = read('routes/retail.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

// ── 1. Every reason the server can give has a line on the card ────────────────
console.log('\n1 · every window reason is spoken for');
{
  const reasons = [...new Set(
    [...cadence.matchAll(/shut\('([a-z_]+)'\)/g)].map((m) => m[1])
  )];
  check('lib/batch-cadence.js still reports reasons', reasons.length >= 6,
    `found ${reasons.length}: ${reasons.join(', ')}`);

  const panel = delivery.slice(delivery.indexOf('function preorderNowReason'),
                               delivery.indexOf('async function renderPreorderNow'));
  for (const r of reasons) {
    check(`"${r}" has a line`, panel.includes(`case '${r}':`),
      'the panel would print the raw token at an operator');
  }
  // The open state is not a shut reason and must not be read as one.
  check('the panel has a default arm', /default:/.test(panel),
    'a reason added server-side would fall through to nothing');
}

// ── 2. Everything the panel says, it says twice ───────────────────────────────
console.log('\n2 · every string on the panel is bilingual');
{
  const block = delivery.slice(delivery.indexOf('const PREORDER_NOW_CHANNELS'),
                               delivery.indexOf('async function saveBatchSchedule'));
  const HAN = /[一-鿿]/;

  // cuT(en, cn) — the second argument must carry Chinese.
  const calls = [...block.matchAll(/cuT\(([^;]*?)\)\s*[,;)\n]/g)].map((m) => m[1]);
  check('the panel resolves its pairs with cuT', calls.length >= 10, `found ${calls.length}`);
  let unpaired = 0;
  for (const c of calls) {
    if (!HAN.test(c)) { unpaired++; console.log(`        no Chinese half: cuT(${c})`); }
  }
  check('no cuT call is English-only', unpaired === 0, `${unpaired} call(s) without a Chinese half`);

  // The three channel names are static pairs, the shape the Channels row above
  // uses. Each must carry both halves and the ' · ' the walker splits on.
  for (const name of ['美团', '饿了么', '管易']) {
    check(`channel label carries ${name}`, block.includes(name), 'channel row would read English-only');
  }
  check('channel labels are · pairs', /Meituan · 美团[\s\S]*Eleme · 饿了么[\s\S]*gzgrocery · 管易/.test(block),
    'the walker splits on " · " and needs both halves in one node');
}

// ── 3. The panel has somewhere to land, and somebody calls it ─────────────────
console.log('\n3 · it is mounted, filled and refreshed');
{
  check('the card carries the mount point', shell.includes('id="batch-preorder-now"'),
    'renderPreorderNow() would find nothing and return');
  check('its label is a bilingual pair', /Right now · 当前状态/.test(shell),
    'the row heading would read in one language');
  check('the card load fills it',
    /batch-skip[\s\S]{0,400}renderPreorderNow\(\)/.test(delivery),
    'the panel would stay "—" until a save');
  check('a save refreshes it',
    /Saved · 已保存[\s\S]{0,300}renderPreorderNow\(\)/.test(delivery),
    'an operator would not see the effect of what they just typed');
  check('it reads the server, not its own guess',
    delivery.includes("api('/api/retail-admin/preorder-window')"),
    'a second copy of the window arithmetic is how the two come to disagree');
}

// ── 4. The endpoint answers for every channel a window can name ───────────────
console.log('\n4 · the endpoint is the server\'s own answer');
{
  const route = retail.slice(retail.indexOf("router.get('/api/retail-admin/preorder-window'"),
                             retail.indexOf("// Body: { 'fees.freeShippingThreshold'"));
  check('the route exists', route.length > 200, 'no endpoint for the panel to read');
  check('it walks batch-cadence\'s own channel list',
    route.includes('batchCadence.PREORDER_CHANNELS'),
    'a hard-coded list here would miss a channel added there');
  check('it asks batch-cadence for the window',
    route.includes('batchCadence.preorderWindow'),
    'a second implementation of §85 is the bug this whole file guards against');
  check('it carries the batch-made count',
    /is_batch_made/.test(route),
    'the one condition not on the card would go unsaid');
  check('it degrades instead of breaking the settings page',
    /catch \(e\)[\s\S]{0,160}data: null/.test(route),
    'a failed read must not take the card down');
}

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS — every check green'}`);
process.exit(failures ? 1 : 0);
