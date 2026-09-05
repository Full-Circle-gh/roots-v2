#!/usr/bin/env node
/**
 * Run the test suites, and be honest about what ran.
 *
 *   node scripts/run-suites.js                 every suite
 *   node scripts/run-suites.js --shard fast    the sub-5s ones (no browser)
 *   node scripts/run-suites.js --shard slow    the Chromium render passes
 *   node scripts/run-suites.js --list          print the plan and exit
 *   node scripts/run-suites.js --quarantined   run ONLY the known-red ones
 *
 * WHY THIS EXISTS. 93 npm scripts run 119 distinct test files, and CI ran none
 * of them: .github/workflows/deploy.yml gates on eslint, the bilingual-banner
 * check, and the fulfilment test when fulfilment logic changed. Everything else
 * was on the honour system. A survey of main on 2026-09-04 found six suites red
 * — some for months — and one of them (test_kitchen_queue_reachable) had gone
 * red for a DELIBERATE, correct capability change nobody was told about. A test
 * that fails silently is worse than no test: it costs the same to write and
 * teaches people the red is noise.
 *
 * THE UNIT IS THE FILE, NOT THE NPM SCRIPT, and that is the one non-obvious
 * decision here. `npm run test:mobile` chains 24 files, eight of which also
 * have their own alias — so running every npm script ran those eight twice and
 * spent 470 wasted seconds doing it. Worse, 34 files on disk had no alias at
 * all and could not be run by name by anybody. Resolving both to the set of
 * FILES fixes the duplication and makes the orphans visible in the same move.
 *
 * A SKIPPED BROWSER PASS IS A FAILURE HERE. The render suites print
 * "SKIP — no Chromium found" and exit 0, which is right on a developer's laptop
 * and a lie in CI: the whole point of running them is the render. So under
 * REQUIRE_BROWSER=1 (which the workflow sets) that skip is reported as a
 * failure, and a runner with no Chromium fails loudly instead of going green
 * having checked nothing.
 *
 * QUARANTINE IS A LIST WITH NAMES ON IT, not a silence. The six red suites do
 * not block a merge, because holding every PR hostage to defects it did not
 * cause is how a gate gets switched off in week two. They are RUN, reported
 * under their own heading with the failure text, and counted. The list is meant
 * to shrink; adding to it should feel like a decision, which is why it lives
 * here in the open rather than in a workflow's `continue-on-error`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

/* ── Quarantine ────────────────────────────────────────────────────────────
   Red on main as of 2026-09-04, each with what is actually broken. These run
   and report; they do not block. Delete a line the moment its suite is green —
   that is the only way this list is allowed to move. */
const QUARANTINE = {
  'test_address_pin.js':
    'address: 1 of 126 — a pin case. Red before the suites were wired up.',
  'test_manual_order_fees.js':
    'manual-order-fees: 2 of 14 — delivery-fee wiring.',
  'test_needs_point_client.js':
    'needs-point: 2 of 20 — an async client assertion returning null.',
  'test_meituan_queue_window.js':
    'queue-window: 5 of 15 — "no such table: store_products". Reads like a ' +
    'fixture that never creates the table rather than a defect in the queue.',
  'test_handle_threading_batch1.js':
    'handle-threading: 1 of 13 — "expected 2 generateRetailSku call sites, ' +
    'found 0". A source-grep assertion that outlived the shape it greps for; ' +
    'same class as the store_stock literal-list assertion fixed alongside this. ' +
    '`npm run test:handle-threading` chains batch1 and batch2, so the npm ' +
    'script name does not say which half is red — batch2 is green.',
  'test_tx_conversion_manual_order.js':
    'tx-conversion-manual-order: 8 of 14. Had NO npm alias, so it could not be ' +
    'run by name by anybody — found only by walking scripts/ on disk.',

  /* THESE TWO ARE WHY THE UNIT IS THE FILE. Both are inside `npm run
     test:mobile`, which chains 24 files and reports one exit code — so for as
     long as anybody has looked, the answer was "test:mobile fails" and WHICH of
     the 24 was red took a 9-minute run and a scroll to find out. Running the
     files separately named them in the first pass. */
  /* test_mobile_purchasing.js LEFT THIS LIST on 2026-09-05, and the entry is
     kept here as a paragraph rather than deleted outright, because the shape of
     its defect is the one most likely to happen again.

     It asserted "¥6,080 this month" against five purchase orders whose dates
     were typed in as August 2026 literals, while the screen sums the CURRENT
     month — so on 1 September every seeded order aged out and the case began
     failing on a screen nobody had touched. Its quarantine entry said not to
     delete it on one green run, because it was green on CI and red locally on
     the same calendar day and that divergence was unexplained.

     It is explained now: commit 558eed3 anchored the fixture to the app's own
     Asia/Shanghai today, which is exactly what that entry said the fix had to
     be — date the fixture relative to today, not re-record the figure. The
     suite is green in two independent environments AND the named cause is gone
     from the file. Both halves were required; either alone would have been a
     guess. */
  'test_mobile_trend.js':
    'mobile-trend: 2 of 10 cases — both ends of the line are not dated, and ' +
    'switching range does not re-ask the server for thirty days.',
};

/* The render passes. Chromium, tens of seconds to minutes each — kept in their
   own shard so a typo in a route file does not cost twenty minutes to find.
   The list below is a floor, not the answer: isSlow() also READS each suite for
   a browser, because a hand-kept list of browser suites is a list that goes
   wrong silently. It already had: test_mobile_order_from_record.js has no npm
   alias, was found only by walking disk, drives Chromium, and sat in the fast
   shard — where REQUIRE_BROWSER is 0, so it would have skipped its render pass
   and reported a tick, which is the exact failure this runner exists to stop. */
const SLOW = new Set([
  'test_mobile_screens.js', 'test_mobile_geometry.js', 'test_mobile_receiving.js',
  'test_mobile_waste.js', 'test_mobile_scroll.js', 'test_mobile_rider.js',
  'test_mobile_pwa.js', 'test_mobile_i18n_names.js', 'test_mobile_nav.js',
  'test_mobile_addstock.js', 'test_mobile_home.js', 'test_mobile_orders.js',
  'test_mobile_products.js', 'test_mobile_purchasing.js', 'test_mobile_inbox.js',
  'test_mobile_activity.js', 'test_mobile_categories.js', 'test_mobile_club.js',
  'test_mobile_voting.js', 'test_mobile_settings.js', 'test_mobile_sales.js',
  'test_mobile_team.js', 'test_mobile_trend.js', 'test_mobile_dots.js',
  'test_mobile_customer_record.js', 'test_stock_home.js', 'test_stock_screens.js',
  'test_stock_receiving.js', 'test_stock_picking.js', 'test_finance_presentation.js',
  'test_till_back.js', 'test_restock_direction_default.js',
]);

/* Not suites: tools that sit in scripts/ under a test-shaped name and take an
   argument, so running them bare proves nothing. Listed rather than
   pattern-matched, so adding one is a deliberate act and a genuinely new suite
   is never skipped by accident. */
const NOT_A_SUITE = new Set([
  // This file. `npm run test:fast` names scripts/run-suites.js, so discovery
  // finds the runner in its own plan and it would run itself, recursively,
  // forever. Caught by the count going 151 → 152 the moment those aliases landed.
  'run-suites.js',
  // Syntax-checks one HTML file's inline <script> blocks; deploy-apply.sh runs
  // it per file. Bare, it prints its usage and exits 2.
  'check-html-js.js',
  // §29's zero-delta gate, pointed at a database by path — a rehearsal copy,
  // then production. Its own header says a fixture passing is not evidence
  // about production, which is exactly why it does not belong in a fixture run.
  'verify_made_material_links.js',

  /* THE OPS CHECKS. These read a LIVE database — `--db <path>`, a copy or
     production — and answer questions about the data in it: do the money and
     points ledgers explain the balances they are supposed to, is the sync log
     fresh. There is no fixture that makes them meaningful, and running them
     against an empty checkout asks nothing.

     THEY ARE RIGHT TO REFUSE, and that is why they are here rather than in
     QUARANTINE. check_sync_freshness says it plainly — "REFUSED — freshness is
     unmeasurable, which is NOT the same as fresh" — and exits non-zero rather
     than reporting health it cannot see. Quarantining that would file a correct
     refusal as a defect.

     THEY PASSED IN THE LOCAL SURVEY BY LUCK. database.js creates data/roots.db
     on require, so a developer's checkout has one and CI does not: the first
     real CI run failed all three. That is the same class of green-over-nothing
     as a render suite skipping for want of a browser, caught the same way —
     by running it somewhere that did not already have what it needed. */
  'check_ledger_invariants.js',
  'check_points_invariants.js',
  'check_sync_freshness.js',
]);

/* Does this suite need a browser? Asked of the source rather than of a list, so
   a render suite written next year lands in the right shard on the day it is
   written, and is held to REQUIRE_BROWSER without anybody remembering to say
   so. The two markers are the ones every render suite in this repo carries: the
   Chromium skip line it prints, and the findChrome() helper they share. */
function isSlow(file) {
  if (SLOW.has(file)) return true;
  try {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    return /SKIP[^\n']*Chromium/.test(src) || /function findChrome\s*\(/.test(src);
  } catch (e) { return false; }
}

/* Every file any test:/verify: npm script runs, plus every test-shaped file on
   disk. The union is the point: the npm scripts are how a person runs one, and
   the disk is the truth about what exists. */
function discover() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const aliased = new Map();                       // file -> the npm script naming it
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (!/^(test|verify):/.test(name)) continue;
    for (const m of String(cmd).matchAll(/scripts\/([A-Za-z0-9_.-]+\.js)/g)) {
      if (!aliased.has(m[1])) aliased.set(m[1], name);
    }
  }
  const onDisk = fs.readdirSync(SCRIPTS)
    .filter((f) => /^(test|check|verify)[-_].*\.js$/.test(f));

  // Excluded from the UNION, not from one half of it. Filtering only the
  // on-disk side let anything reachable through an npm script back in — which
  // is how the runner ended up in its own plan.
  const all = new Set([...aliased.keys(), ...onDisk].filter((f) => !NOT_A_SUITE.has(f)));
  return [...all].sort().map((file) => ({
    file,
    alias: aliased.get(file) || null,        // null = no npm script names it
    slow: isSlow(file),
    quarantined: Object.prototype.hasOwnProperty.call(QUARANTINE, file),
  }));
}

function run(entry) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, entry.file)], {
    cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000,
    env: { ...process.env, TZ: process.env.TZ || 'Asia/Shanghai' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const seconds = Math.round((Date.now() - started) / 1000);

  // A render suite that could not find a browser has checked nothing. On a
  // laptop that is fine and it says so; in CI it is the failure mode this
  // runner exists to prevent.
  const skippedForBrowser = /SKIP\s+—\s+no Chromium/i.test(out);
  if (skippedForBrowser && process.env.REQUIRE_BROWSER === '1') {
    return { ...entry, ok: false, seconds, out, why: 'no Chromium, and REQUIRE_BROWSER=1' };
  }
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { ...entry, ok: false, seconds, out, why: 'timed out after 15 minutes' };
  }
  return {
    ...entry, ok: r.status === 0, seconds, out,
    why: r.status === 0 ? '' : `exit ${r.status}`,
    skipped: skippedForBrowser,
  };
}

// The last few lines of a failure, which is where these suites put their tally.
function tail(out, n = 14) {
  return String(out).trimEnd().split('\n').slice(-n).map((l) => '      ' + l).join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  // indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] —
  // so a bare `--list` used to be read as the shard name and refused.
  const at = argv.indexOf('--shard');
  const shard = at >= 0 ? (argv[at + 1] || '').trim() : '';
  const onlyQuarantined = argv.includes('--quarantined');

  let plan = discover();
  if (shard === 'fast') plan = plan.filter((e) => !e.slow);
  else if (shard === 'slow') plan = plan.filter((e) => e.slow);
  else if (shard) { console.error(`unknown shard "${shard}" — use fast or slow`); process.exit(2); }
  plan = onlyQuarantined ? plan.filter((e) => e.quarantined) : plan;

  if (argv.includes('--list')) {
    for (const e of plan) {
      console.log([e.file, e.slow ? 'slow' : 'fast', e.quarantined ? 'quarantined' : '',
        e.alias ? '' : 'no npm alias'].filter(Boolean).join('\t'));
    }
    console.log(`\n${plan.length} suite(s).`);
    return;
  }

  console.log(`Running ${plan.length} suite(s)${shard ? ` · ${shard} shard` : ''}` +
    `${process.env.REQUIRE_BROWSER === '1' ? ' · a missing Chromium is a failure' : ''}\n`);

  const results = [];
  for (const e of plan) {
    const r = run(e);
    results.push(r);
    const mark = r.ok ? '✓' : (r.quarantined ? '▲' : '✗');
    console.log(`  ${mark} ${r.file}${r.seconds >= 5 ? `  (${r.seconds}s)` : ''}` +
      `${r.ok ? '' : '  — ' + r.why}${r.quarantined && !r.ok ? '  [quarantined]' : ''}`);
  }

  const broke = results.filter((r) => !r.ok && !r.quarantined);
  const known = results.filter((r) => !r.ok && r.quarantined);
  const fixed = results.filter((r) => r.ok && r.quarantined);

  if (broke.length) {
    console.log(`\n── Failures ──────────────────────────────────────────────`);
    for (const r of broke) console.log(`\n  ${r.file} — ${r.why}\n${tail(r.out)}`);
  }
  if (known.length) {
    console.log(`\n── Quarantined, still red ────────────────────────────────`);
    for (const r of known) console.log(`  ${r.file} — ${QUARANTINE[r.file]}`);
  }
  // A quarantined suite that passes is the best news this runner can carry, and
  // it must not slip by in a wall of ticks: the list is only useful if it shrinks.
  if (fixed.length) {
    console.log(`\n── Quarantined, now GREEN — delete these from QUARANTINE ──`);
    for (const r of fixed) console.log(`  ${r.file}`);
  }

  const total = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`\n${results.length - broke.length - known.length} passed, ` +
    `${broke.length} failed, ${known.length} quarantined · ${total}s`);

  if (fixed.length) process.exitCode = 0;
  if (broke.length) process.exit(1);
}

main();
