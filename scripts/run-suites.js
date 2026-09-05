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
 * QUARANTINE IS A LIST WITH NAMES ON IT, not a silence — and it is now EMPTY.
 * It opened with eight suites red on main and closed one week later with every
 * one of them green; none was deleted or skipped to get there. A quarantined
 * suite still RAN, was reported under its own heading with its failure text, and
 * was counted, which is what made the list shrinkable rather than a drawer.
 * Adding to it should feel like a decision, which is why it lives here in the
 * open rather than in a workflow's `continue-on-error`. See the block above the
 * (empty) list for what the eight turned out to be — six rot, two live defects.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

/* ── Quarantine ────────────────────────────────────────────────────────────
   EMPTY, AND THAT IS THE POINT OF IT.

   It opened on 2026-09-04 with eight suites red on main, some for months, and
   is now closed. Nothing was silenced to get here — every entry left by going
   green, which is the only exit this list ever had.

   What the eight actually were, because the shape repeats and the next person
   should recognise it: SIX were rot in the test, not defects in the product.
   Assertions pinned to a literal list, a tuple or an English string that a
   correct change moved (store_stock's caps, the requeue statement's states, a
   fail card that gained i18n); fixtures that grew thinner than the code they
   drive (a missing store_products, a request predating two validations); and
   scaffolding that had quietly stopped covering what it claimed — a hand-rolled
   JS lexer that swallowed two thirds of routes/retail.js and reported "0 call
   sites" about code that was entirely correct, while the assertion beside it
   passed by luck.

   TWO WERE REAL, and both had been shipping. The trend window over-fetched by a
   day at UTC+8 — every figure on that screen computed over the wrong range, in
   the only timezone the shop runs in. And a product row filed itself as one
   recipe batch, so three products reported as three batches.

   That ratio is the argument for the list rather than against it: six pieces of
   rot were the price of finding two live defects, and neither would have been
   found by reading the code, because the code looked right. They were found by
   running the suites somewhere that did not already agree with them.

   ADD TO IT ONLY AS A DECISION. An entry needs a name and a sentence saying
   what is broken; a suite whose failure you cannot describe is a suite you have
   not read. And delete a line the moment it goes green — the runner calls out
   any entry that passes, by name, for exactly that purpose. */
const QUARANTINE = {};

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
  // A fourth of the same kind (audit A-06): the money migration's oracle. It
  // measures a live database before and after a conversion and requires the two
  // to agree, so bare — with no --db and nothing to compare against — it is
  // asking nothing. Its red-proof, test_money_invariants.js, IS a suite and runs
  // in the plan: that is where the queries are proven able to go red.
  'check_money_invariants.js',
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
