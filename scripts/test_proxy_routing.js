#!/usr/bin/env node
/**
 * Offline self-test for the Meituan proxy ROUTER (lib/proxy-manager + the
 * election rules in scripts/proxy-watchdog). No network: probe results are fed
 * in as a script of HTTP status codes.
 *
 *   node scripts/test_proxy_routing.js
 *
 * The failure this guards against (2026-08-08): 天河 ping-ponged
 * residential↔gz↔direct for hours. Every switch relaunches the browser on a
 * different exit IP, and Meituan answers a moving session by dropping its 门店
 * binding — so the router thrashing IS the outage, one layer down.
 *
 * Two root causes, both covered here:
 *   1. the probe called "HTTP 200 or it's down", so Meituan's own risk-control
 *      403 through a perfectly good tunnel was read as a dead path;
 *   2. hysteresis was one-directional — 2 failures to leave a path, but a SINGLE
 *      success to jump back to it.
 *
 * The election rules are re-implemented here rather than imported, because
 * proxy-watchdog.js is a `for(;;)` daemon with no exported seam. They are kept
 * deliberately line-for-line with tick(); if you change one, change both.
 */
'use strict';

const assert = require('assert');
const pm = require('../lib/proxy-manager');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── The election, mirroring scripts/proxy-watchdog.js tick() ────────────────
const FAIL_THRESHOLD = 2, RECOVER_THRESHOLD = 4, MIN_DWELL_MS = 15 * 60_000;
const FLAP_WINDOW_MS = 60 * 60_000, FLAP_MAX = 4;
const FLAP_FREEZE_MS = 120 * 60_000, FLAP_FREEZE_MAX_MS = 1440 * 60_000, FLAP_CALM_MS = 360 * 60_000;

// cands: [{label,url}] in priority order. steps: [{codes:{label:httpCode}, dtMs}]
function runRouter(cands, steps, opts = {}) {
  const flapMax = opts.flapMax !== undefined ? opts.flapMax : FLAP_MAX;
  const failCount = {}, okCount = {};
  let cur = opts.start !== undefined ? opts.start : undefined;
  let lastSwitchAt = 0, now = 0, switches = 0;
  let switchLog = [], frozen, freezes = 0, strikes = 0;
  const path = [];

  for (const step of steps) {
    now += step.dtMs || 30_000;
    const avail = {};
    for (const c of cands) {
      const ok = pm.codeMeansUsable(step.codes[c.label]);
      failCount[c.label] = ok ? 0 : (failCount[c.label] || 0) + 1;
      okCount[c.label]   = ok ? (okCount[c.label] || 0) + 1 : 0;
      avail[c.label] = c.label === 'direct' ? true : (failCount[c.label] < FAIL_THRESHOLD);
    }
    const curIdx = cands.findIndex(c => c.url === cur);
    let active;
    if (curIdx < 0 || !avail[cands[curIdx].label]) {
      active = cands.find(c => avail[c.label]) || cands[cands.length - 1];
    } else {
      const dwellOk = now - lastSwitchAt >= MIN_DWELL_MS;
      const better = cands.slice(0, curIdx).find(c => avail[c.label] && (okCount[c.label] || 0) >= RECOVER_THRESHOLD);
      active = (better && dwellOk) ? better : cands[curIdx];
    }
    if (frozen && now < frozen.until) {
      const held = cands.find(c => c.url === frozen.url);
      if (held && avail[held.label]) active = held;
      else frozen.url = active.url;   // held path died — re-pin, don't bounce
    } else if (frozen) { frozen = undefined; }
    if (strikes && now - lastSwitchAt >= FLAP_CALM_MS) strikes = 0;

    if (cur !== undefined && cur !== active.url) {
      switches++; lastSwitchAt = now;
      switchLog = switchLog.filter(t => now - t < FLAP_WINDOW_MS);
      switchLog.push(now);
      if (switchLog.length >= flapMax && !frozen) {
        strikes++; freezes++;
        const holdMs = Math.min(FLAP_FREEZE_MS * 2 ** (strikes - 1), FLAP_FREEZE_MAX_MS);
        frozen = { until: now + holdMs, url: active.url };
      }
    }
    cur = active.url;
    path.push(active.label);
  }
  return { switches, path, final: path[path.length - 1], freezes };
}

const CANDS = [
  { label: 'residential', url: 'socks5://10.8.0.2:1080' },
  { label: 'gz',          url: 'http://mtproxy:x@8.163.120.72:8888' },
  { label: 'direct',      url: '' },
];
const START = CANDS[0].url;
// n probe rounds with fixed codes per candidate.
const rounds = (n, codes, dtMs) => Array.from({ length: n }, () => ({ codes, dtMs }));

console.log('\nMeituan proxy routing — offline self-test\n');

// ── 1. What a probe result means ───────────────────────────────────────────
console.log('1. probe classification');
it('200 is a usable path', () => assert.strictEqual(pm.codeMeansUsable(200), true));
it("Meituan's risk-control 403 is a USABLE path, not a dead one", () => {
  // The whole point: the request reached Meituan and came back. Failing over
  // here moves a live session to a new IP and costs it the store binding.
  assert.strictEqual(pm.codeMeansUsable(403), true);
});
it('a redirect or 404 still proves the path relays', () => {
  assert.strictEqual(pm.codeMeansUsable(302), true);
  assert.strictEqual(pm.codeMeansUsable(404), true);
});
it('000 (no reply at all) is down', () => assert.strictEqual(pm.codeMeansUsable(0), false));
it('407 (bad proxy credentials) is down', () => assert.strictEqual(pm.codeMeansUsable(407), false));
it('5xx — the wedged-tinyproxy signature — is down', () => {
  assert.strictEqual(pm.codeMeansUsable(502), false);
  assert.strictEqual(pm.codeMeansUsable(503), false);
});

// ── 2. The oscillation ─────────────────────────────────────────────────────
console.log('\n2. a marginal residential link must not oscillate');
it('alternating up/down on residential no longer ping-pongs the path', () => {
  // 2 bad rounds, 1 good, repeat — the shape that produced hours of switching.
  const steps = [];
  for (let i = 0; i < 10; i++) {
    steps.push(...rounds(2, { residential: 0, gz: 200, direct: 200 }));
    steps.push(...rounds(1, { residential: 200, gz: 200, direct: 200 }));
  }
  const r = runRouter(CANDS, steps, { start: START });
  // One forced move off the dying link. The single good probes can't drag it
  // back: failback needs 4 in a row AND 15 min of dwell.
  assert.strictEqual(r.switches, 1, `expected 1 switch, got ${r.switches} (${r.path.join('→')})`);
  assert.strictEqual(r.final, 'gz');
});
it('a sustained recovery DOES fail back, once it has earned it', () => {
  const steps = [
    ...rounds(4, { residential: 0, gz: 200, direct: 200 }),            // drop to gz
    ...rounds(20, { residential: 200, gz: 200, direct: 200 }, 60_000), // 20 min clean
  ];
  const r = runRouter(CANDS, steps, { start: START });
  assert.strictEqual(r.final, 'residential', 'a genuinely healthy link is used again');
  assert.strictEqual(r.switches, 2, 'exactly one move away and one move back');
});
it('a brief recovery does NOT fail back (dwell not served)', () => {
  const steps = [
    ...rounds(4, { residential: 0, gz: 200, direct: 200 }),
    ...rounds(6, { residential: 200, gz: 200, direct: 200 }),  // 4 clean probes, but ~3 min
  ];
  const r = runRouter(CANDS, steps, { start: START });
  assert.strictEqual(r.final, 'gz');
  assert.strictEqual(r.switches, 1);
});

// ── 3. Failover still works ────────────────────────────────────────────────
console.log('\n3. real failures still fail over');
it('residential dying hard moves to gz', () => {
  const r = runRouter(CANDS, rounds(6, { residential: 0, gz: 200, direct: 200 }), { start: START });
  assert.strictEqual(r.final, 'gz');
});
it('both proxies dying falls through to direct', () => {
  const r = runRouter(CANDS, rounds(6, { residential: 0, gz: 503, direct: 200 }), { start: START });
  assert.strictEqual(r.final, 'direct');
});
it('a channel-wide 403 changes nothing — every path is equally "up"', () => {
  // Risk control challenging us is not a routing problem, and rotating IPs in
  // response is how a 403 turns into a lost binding as well.
  const r = runRouter(CANDS, rounds(10, { residential: 403, gz: 403, direct: 403 }), { start: START });
  assert.strictEqual(r.switches, 0);
  assert.strictEqual(r.final, 'residential');
});

// ── 4. The flap damper ─────────────────────────────────────────────────────
console.log('\n4. flap damper');
it('a path that flaps despite hysteresis gets frozen', () => {
  // Long clean stretches (so dwell AND recovery are both satisfied) alternating
  // with hard failures: every switch here is individually legitimate, which is
  // exactly why hysteresis alone cannot stop it. Measured against the same run
  // with the damper disabled.
  // A full trading day of a link that is up 20 min, down 20 min, all day.
  const steps = [];
  for (let i = 0; i < 18; i++) {
    steps.push(...rounds(20, { residential: 0,   gz: 200, direct: 200 }, 60_000));
    steps.push(...rounds(20, { residential: 200, gz: 200, direct: 200 }, 60_000));
  }
  const damped   = runRouter(CANDS, steps, { start: START });
  const undamped = runRouter(CANDS, steps, { start: START, flapMax: Infinity });
  assert.ok(damped.freezes >= 1, 'the damper engaged');
  assert.ok(damped.switches <= undamped.switches / 2,
    `over a day the escalating freeze should at least halve the churn (${damped.switches} vs ${undamped.switches})`);
});
it('the escalation forgives a link that settles down', () => {
  // Flap hard, then behave. After the calm window the strike counter clears, so
  // the next incident starts from a 2h freeze again rather than a punitive one.
  const steps = [];
  for (let i = 0; i < 6; i++) {
    steps.push(...rounds(20, { residential: 0,   gz: 200, direct: 200 }, 60_000));
    steps.push(...rounds(20, { residential: 200, gz: 200, direct: 200 }, 60_000));
  }
  steps.push(...rounds(600, { residential: 200, gz: 200, direct: 200 }, 60_000)); // 10 h calm
  const r = runRouter(CANDS, steps, { start: START });
  assert.strictEqual(r.final, 'residential', 'a link that recovers is used again');
});

// ── 5. Credential redaction ────────────────────────────────────────────────
console.log('\n5. credentials never reach a log line');
it('an authed http proxy URL is redacted', () => {
  const out = pm.redactProxy('http://mtproxy:SuperSecret123@8.163.120.72:8888');
  assert.ok(!/SuperSecret123/.test(out), out);
  assert.ok(/mtproxy/.test(out), 'the username still identifies which proxy it is');
});
it('a credential-free URL is left readable, and empty reads as direct', () => {
  assert.strictEqual(pm.redactProxy('socks5://10.8.0.2:1080'), 'socks5://10.8.0.2:1080');
  assert.strictEqual(pm.redactProxy(''), '(direct)');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
