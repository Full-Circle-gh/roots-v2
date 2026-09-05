#!/usr/bin/env node
/**
 * test_alert_audience.js — whose problem is it? (audit P-01)
 *
 *   node scripts/test_alert_audience.js
 *
 * Sixty-five call sites sent everything the system noticed about a merchant's
 * day to one operations group — the platform's. Thirty-six of them were the
 * MERCHANT's problem: their marketplace account logged out and needed a scan,
 * their listings drifted, their orders stopped arriving. The merchant was never
 * told. For the first account the two groups may be the same people, which is
 * why nobody felt it and why nothing stopped it growing.
 *
 * The transport was settled separately (Q3, option b). What is tested here is
 * the CLASSIFICATION and the one piece of routing logic that is not obvious:
 * alertBoth must not put the same line in the same room twice.
 *
 * No network — `deliver` is replaced in the module, so nothing leaves.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
let pass = 0, fail = 0;
const queue = [];
const it = (name, fn) => queue.push({ name, fn });

// ── Load ops-alert with its network replaced ───────────────────────────────
const ops = require('../lib/ops-alert');
const sent = [];                       // { url, text }
const realDeliver = ops.deliver;
// The module calls `deliver` through its own module object, so replacing the
// export is enough to keep every send in this process.
require.cache[require.resolve('../lib/ops-alert')].exports.deliver =
  async (url, text) => { sent.push({ url, text }); return { ok: true, attempts: 1 }; };

async function runAll() {
  for (const t of queue) {
    sent.length = 0;
    try { await t.fn(); console.log(`  ✓ ${t.name}`); pass++; }
    catch (e) { console.log(`  ✗ ${t.name}\n      ${e.message}`); fail++; }
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe vocabulary exists and means three different things');

it('all three are exported and distinct', async () => {
  for (const k of ['alertPlatform', 'alertMerchant', 'alertBoth']) {
    assert.strictEqual(typeof ops[k], 'function', `${k} is missing`);
  }
  assert.notStrictEqual(ops.alertPlatform, ops.alertMerchant);
  assert.notStrictEqual(ops.alertBoth, ops.alertMerchant);
});

it('alertBoth does not send the same line twice to one destination', async () => {
  // THE CASE THAT MATTERS. A merchant with no chat app of their own has
  // sendTenantAlert fall back to the platform group — and account 1's chat app
  // IS the platform's. Calling both blindly would post the same alert in the
  // same room twice, which is how a group gets muted, which is how the next
  // real alert is missed.
  //
  // Read from the source rather than exercised end to end: the branch depends
  // on a configured webhook and a tenant database, neither of which exists in a
  // test process, and asserting the SHAPE of the guard is honest about that.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ops-alert.js'), 'utf8');
  const body = src.slice(src.indexOf('async function alertBoth'));
  // Comments stripped FIRST: the function's own comment explains why it is not
  // Promise.all, and asserting over the prose would fail on the explanation.
  const head = codeOnly(body.slice(0, body.indexOf('\n}')));
  assert.match(head, /if \(!own \|\| own === webhookStatus\(\)\.url\) return alertPlatform\(/,
    'alertBoth must collapse to ONE message when there is one destination');
  assert.match(head, /await alertMerchant/, 'and otherwise reach the merchant');
  assert.match(head, /await alertPlatform/, 'and the platform');
  // Sequential, because both paths share the dedup window.
  assert.ok(head.indexOf('await alertMerchant') < head.indexOf('await alertPlatform'),
    'the merchant is told first — it is the half that matters');
  assert.doesNotMatch(head, /Promise\.all/, 'racing the dedup window drops one at random');
});

it('a platform alert carries no account id — there is no merchant in it', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ops-alert.js'), 'utf8');
  const m = src.match(/function alertPlatform\([^)]*\)/);
  assert.ok(m, 'alertPlatform not found');
  assert.doesNotMatch(m[0], /tenant/i, 'alertPlatform must not take an account');
});

it('a merchant alert names the account when it lands in the platform group', async () => {
  // Otherwise a platform group reading "storefront not responding" cannot tell
  // which merchant, the moment there is more than one.
  assert.match(ops.forPlatform(7, 'stock sync stopped'), /account 7/);
  assert.match(ops.forPlatform(null, 'x'), /not identified/);
  assert.match(ops.forPlatform(7, 'x', 'their chat app refused it'), /refused/);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe classification, at the call sites');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DAEMONS = ['qingyun', 'meituan', 'shangou', 'guanyi', 'eleme']
  .map(d => `scripts/${d}-daemon.js`);

it('every sync daemon classifies, and none calls a transport directly', async () => {
  for (const f of DAEMONS) {
    const code = codeOnly(read(f));
    assert.doesNotMatch(code, /\bsendOpsAlert\s*\(/, `${f} still raises an unclassified alert`);
    assert.match(code, /alertMerchant\(ACCOUNT,/, `${f} tells the merchant nothing`);
  }
});

it('a marketplace account logging out is the MERCHANT’s to act on', async () => {
  // This is the finding in one line: only their staff can go and scan the code.
  // It went to the platform's group, and the merchant was not told.
  const eleme = read('scripts/eleme-daemon.js');
  const at = eleme.indexOf('needs a manual login');
  assert.ok(at > 0, 'the login alert moved — re-check this assertion');
  assert.match(eleme.slice(Math.max(0, at - 400), at), /alertMerchant\(ACCOUNT,/);
});

it('our proxy fleet and our watchdog are the PLATFORM’s', async () => {
  const mt = read('scripts/meituan-daemon.js');
  // The Chinese half of each alert, because the English half also appears in the
  // console.log beside it and indexOf would find the log line instead — which is
  // how the first version of this assertion failed against correct code.
  for (const needle of ['代理看门狗已恢复', '代理已恢复，同步继续', '代理掉线']) {
    const at = mt.indexOf(needle);
    assert.ok(at > 0, `missing: ${needle}`);
    assert.match(mt.slice(Math.max(0, at - 300), at), /alertPlatform\(/, needle);
  }
});

it('the daemons say plainly that they serve one account', async () => {
  // The addressing is real — these processes open account 1's database, so
  // account 1 is the only account they can be about. Saying so stops the next
  // reader assuming the fleet is already per-account.
  for (const f of DAEMONS) {
    const src = read(f);
    assert.match(src, /ROOTS_TENANT_ID: ACCOUNT/, `${f} must resolve its account in one place`);
    assert.match(src, /one addressee|one account/i, `${f} must state the single-account reality`);
  }
});

it('the drift sweeps use the alerter the daemon binds for them', async () => {
  // They receive it injected. A global would be a ReferenceError at the one
  // moment it is needed — which is what the first attempt at this shipped.
  for (const f of ['lib/channel-drift-sweep.js', 'lib/meituan-drift-sweep.js']) {
    const code = codeOnly(read(f));
    assert.match(code, /notifyMerchant/, `${f} must take the bound alerter`);
    assert.doesNotMatch(code, /\bACCOUNT\b/, `${f} has no account of its own to name`);
    assert.doesNotMatch(code, /\bsendOpsAlert\s*\(/, `${f} still raises an unclassified alert`);
  }
});

it('server.js and the watchdog stay platform-only, and say why', async () => {
  // No account is in scope when the process itself is failing.
  const gate = read('scripts/check-alert-audience.js');
  assert.match(gate, /server\.js/);
  assert.match(gate, /health-watchdog\.js/);
  assert.match(gate, /by definition|not any one merchant/i,
    'the allowance must carry its reason, not just the filename');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe gate');

it('the gate passes, and would fail on an unclassified alert', async () => {
  const { spawnSync } = require('child_process');
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-alert-audience.js')],
    { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /alertMerchant/);
  // Red-proof: a file outside the allow-list that raises a transport directly
  // must be caught. Written, checked, removed.
  const probe = path.join(ROOT, 'lib', '__alert_probe__.js');
  fs.writeFileSync(probe, "const { sendOpsAlert } = require('./ops-alert');\nsendOpsAlert('unclassified');\n");
  try {
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-alert-audience.js')],
      { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1, 'the gate did not go red on an unclassified alert');
    assert.match(bad.stdout, /__alert_probe__/);
  } finally { fs.unlinkSync(probe); }
});

// ─────────────────────────────────────────────────────────────────────────
runAll().then(() => {
  require.cache[require.resolve('../lib/ops-alert')].exports.deliver = realDeliver;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
});
