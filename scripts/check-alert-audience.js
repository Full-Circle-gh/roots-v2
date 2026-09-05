#!/usr/bin/env node
// GATE — every alert must say whose problem it is (audit P-01).
//
// WHY THIS EXISTS
// ---------------
// Sixty-five call sites sent everything the system noticed about a merchant's
// day to one operations group: the platform's. Thirty-six of them were the
// MERCHANT's problem — their marketplace account logged out, their listings
// drifted, their orders stopped arriving — and the merchant was never told.
//
// For the first account those two groups may be the same people, which is
// exactly why nobody felt it, and exactly why nothing stopped it growing.
//
// THE RULE. Outside lib/ops-alert.js itself, an alert is raised through one of
// three named functions, and the name is the classification:
//
//   alertPlatform(text)             ours to fix; no merchant can act on it
//   alertMerchant(tenantId, text)   their trading day; their staff act
//   alertBoth(tenantId, text)       genuinely both, used sparingly
//
// `sendOpsAlert` and `sendTenantAlert` are the transports underneath. Calling
// them directly is not forbidden — three sites legitimately do, and they are
// listed below with the reason — but a NEW one has to be argued for here rather
// than added in silence, which is the whole difference between a decision and a
// habit.
//
// Exit 0 = every alert declares an audience. Exit 1 = one does not.
// Read-only. Touches no database. Run: node scripts/check-alert-audience.js

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DIRS = ['routes', 'lib', 'middleware', 'scripts'];
const EXTRA = ['server.js'];

// Sites that may call a transport directly, each with the reason it is not a
// classification failure. A file added here needs a sentence, not a name.
const ALLOWED = new Map([
  [path.join('lib', 'ops-alert.js'),
    'defines all of them; the transports are its own internals'],
  ['server.js',
    'process-level crash handlers — there is no account in scope when the '
    + 'process itself is failing, and an uncaught exception is the platform\'s '
    + 'by definition'],
  [path.join('scripts', 'health-watchdog.js'),
    'watches whether the app is serving at all; a box that is down or '
    + 'overloaded is not any one merchant\'s problem'],
  [path.join('routes', 'retail.js'),
    'two deliberate platform sites, both commented: a server-log pointer, and '
    + 'a merchant\'s setup REQUEST addressed to the platform'],
  [path.join('lib', 'alert-latch.js'),
    'names the pattern in a comment; raises nothing'],
  [path.join('scripts', 'check-alert-audience.js'),
    'this gate quotes the names it is checking for'],
  [path.join('scripts', 'test_recipient_phone.js'),
    'asserts that a send is detached, and is deliberately sender-agnostic'],
  [path.join('scripts', 'test_alert_audience.js'),
    'the suite for this rule'],
]);

function jsFiles(dir) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...jsFiles(rel)); continue; }
    if (e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

// Comments are prose about alerting, not alerting. Stripped string-aware would
// be better; stripped line-wise is enough here, because a call is never inside
// a string in these files and a `//` inside one would only ever hide a line.
const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

const files = [...DIRS.flatMap(jsFiles), ...EXTRA.filter(f => fs.existsSync(path.join(REPO, f)))];

let classified = 0;
const byKind = { alertPlatform: 0, alertMerchant: 0, alertBoth: 0 };
const violations = [];

for (const rel of files) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  if (!/alert/i.test(src)) continue;
  const code = codeOnly(src);

  for (const k of Object.keys(byKind)) {
    const n = (code.match(new RegExp('\\b' + k + '\\s*\\(', 'g')) || []).length;
    byKind[k] += n; classified += n;
  }

  if (ALLOWED.has(rel)) continue;
  // A CALL, not a mention: `sendOpsAlert(` with an open paren. A bare reference
  // — passing it, or testing it for truthiness — is not raising an alert.
  for (const t of ['sendOpsAlert', 'sendTenantAlert']) {
    const re = new RegExp('\\b' + t + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(code))) {
      violations.push({ file: rel, line: code.slice(0, m.index).split('\n').length, transport: t });
    }
  }
}

console.log('GATE — every alert says whose problem it is\n');
console.log(`  scanned ${files.length} file(s)`);
console.log(`  ${classified} classified alert(s):`);
console.log(`     ${String(byKind.alertMerchant).padStart(4)}  alertMerchant  — the merchant's trading day`);
console.log(`     ${String(byKind.alertPlatform).padStart(4)}  alertPlatform  — ours to fix`);
console.log(`     ${String(byKind.alertBoth).padStart(4)}  alertBoth      — genuinely both`);
console.log(`\n  ${ALLOWED.size} file(s) may call a transport directly, each with a stated reason.`);

if (violations.length) {
  console.log(`\n  VIOLATIONS — ${violations.length}:`);
  for (const v of violations) {
    console.log(`   FAIL  ${v.file}:${v.line}  calls ${v.transport}() directly`);
    console.log('           say who should act: alertMerchant(tenantId, …), alertPlatform(…) or alertBoth(tenantId, …)');
  }
}

console.log('\n' + '═'.repeat(72));
if (violations.length) {
  console.log(`RESULT: FAIL — ${violations.length} alert(s) do not say whose problem they are.`);
  process.exit(1);
}
console.log(`RESULT: PASS — all ${classified} alert(s) declare an audience.`);
process.exit(0);
