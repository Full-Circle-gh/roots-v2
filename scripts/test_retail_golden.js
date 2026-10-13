#!/usr/bin/env node
/**
 * test_retail_golden.js — the routes split out of routes/retail.js answer
 * exactly what they answered before the split (decisions §472).
 *
 *   node scripts/test_retail_golden.js                    compare every area
 *   node scripts/test_retail_golden.js --update <area>    re-record one area
 *
 * Each area is a fixed list of requests, sent to the real router over one
 * seeded scratch database, in this file's order. Every status and body is
 * compared with scripts/test-support/golden/retail-<area>.json. The areas share
 * one database because retail.js can be loaded once per process, so --update
 * still runs every area and writes only the one named.
 *
 * Recording rules are in scripts/test-support/retail-golden.js. In short:
 * record an area on main BEFORE it moves; re-record only for a change in
 * behaviour you meant, and commit the recording with that change.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { openApp } = require('./test-support/retail-golden');

const GOLDEN_DIR = path.join(__dirname, 'test-support', 'golden');

// Each area (scripts/test-support/golden-areas/<area>.js) exports seed(app) →
// anything its requests need, and requests(seeded) → the list to send. A request
// is [who, METHOD, path, body?, { afterMs }?], who ∈ customer | admin | anon.
// The areas, in the order they run. They share one database, so the order is
// part of every recording: add a new area at the END, never in the middle.
const ORDER = ['polls', 'feedback', 'reviews', 'customers', 'checkout'];
const AREAS = Object.fromEntries(ORDER.map((a) => [a, require('./test-support/golden-areas/' + a)]));

(async () => {
  const args = process.argv.slice(2);
  const update = args[0] === '--update' ? args[1] : null;
  if (args[0] === '--update' && !AREAS[update]) {
    console.error('usage: --update <' + Object.keys(AREAS).join('|') + '>');
    process.exit(2);
  }

  const app = await openApp();
  let pass = 0, fail = 0;
  const ok = (c, m, extra) => {
    if (c) { pass++; console.log('  ✓ ' + m); }
    else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
  };

  for (const [area, spec] of Object.entries(AREAS)) {
    console.log(`\n${area}`);
    const seeded = spec.seed(app);
    const got = [];
    for (const r of spec.requests(seeded)) got.push(await app.call(r));
    const file = path.join(GOLDEN_DIR, `retail-${area}.json`);

    if (update === area) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
      console.log(`  recorded ${got.length} answers → ${path.relative(process.cwd(), file)}`);
      continue;
    }
    if (!fs.existsSync(file)) { ok(false, `${area}: a recording exists`, `run --update ${area} on main first`); continue; }
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(want.length === got.length, `${area}: the same ${want.length} requests as recorded`, `recorded ${want.length}, sent ${got.length}`);
    for (let i = 0; i < Math.min(want.length, got.length); i++) {
      const a = JSON.stringify(want[i]), b = JSON.stringify(got[i]);
      ok(a === b, `${got[i].req} → ${got[i].status}`, a === b ? '' : `recorded ${a.slice(0, 300)}\n      now      ${b.slice(0, 300)}`);
    }
  }

  console.log('\nno request left the machine');
  ok(app.outbound.length === 0, 'every request stayed on the local server', app.outbound.slice(0, 3).join(' · '));

  await app.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
