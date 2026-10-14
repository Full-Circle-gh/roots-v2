#!/usr/bin/env node
// NO SWITCH FOR A THING THIS SHOP CANNOT HAVE — and the server path left alone.
//
// WHAT HAPPENED. §99 shipped a reminder that chases an unissued 发票. Asked why
// auto-issue was off, Ash answered: **the fapiao provider issues none for us and
// offers no open API.** So the switch on the phone was not a setting anybody
// could act on. It read "off", it invited somebody to turn it on, and turning it
// on did nothing at all — `maybeAutoIssueInvoice` returns on its first line
// unless Nuonuo credentials are also present, which for this shop they never
// will be.
//
// That is the same defect the §99 snooze was designed around, arriving from the
// other direction: a control that reads as set and does nothing. It was worse
// here, because the operator had no way to find out — the server already
// computes `credsReady` on GET /fapiao-settings and NEITHER surface read it.
//
// THE DECISION (§99 addendum 2) IS UI-ONLY, AND THIS SUITE PINS BOTH HALVES.
// The switch is gone from the phone. The server-side integration STAYS, dormant:
// Nuonuo credentials are per-tenant (lib/tenant-creds.js — Roots reads env,
// every other tenant stores its own), so the capability belongs to the platform
// and not to this shop's provider. Deleting it would take it from every tenant
// to solve one tenant's problem, and rebuild it for the first tenant who has an
// API.
//
// So this suite fails in BOTH directions, on purpose:
//   • if the switch comes back, or the note bar starts claiming a state again
//   • if a later session "finishes the job" and rips the integration out
//
// USAGE   node scripts/test_fapiao_no_auto_issue.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const M_SRC  = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
// routes/retail.js and everything moved out of it (decisions §477): the
// auto-issue path is in lib/fapiao.js, its endpoints still in routes/retail.js.
const R_SRC  = require('./test-support/retail-source').retailSource();
const C_SRC  = fs.readFileSync(path.join(ROOT, 'lib', 'tenant-creds.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

console.log('\ntest_fapiao_no_auto_issue\n');

// ── 1. The phone offers no switch ───────────────────────────────────────────
console.log('The phone');

ok(!/toggleFapiao/.test(M_SRC),
   'no toggleFapiao handler — the write path from the phone is gone, not just hidden');
ok(!/fapiao-settings/.test(M_SRC),
   'AND THE PHONE NEVER CALLS /fapiao-settings AT ALL. A hidden control whose fetch '
   + 'survives is one render away from coming back');
ok(!/Fapiao auto-issue/.test(M_SRC) && !/发票自动开具/.test(M_SRC),
   'the settings row is gone in both languages');
ok(!/state\.fapiao\b/.test(M_SRC) && !/fapiaoTried|fapiaoBusy|fapiaoLoading/.test(M_SRC),
   'and so is every piece of state it used — no orphan slots left to puzzle over');

// ── 2. The note bar says the true half and stops ────────────────────────────
console.log('\nThe note bar');
ok(!/自动开票已关闭|自动开票已开启|Auto-issue is (on|off)/.test(M_SRC),
   'it no longer reports a state nobody can change');
/* §325 — "Issue fapiao on desktop" stopped being true when §314 put issuing on
   the phone's order sheet. The line is gone, and each request row opens its
   order's sheet instead, which is the half an operator can act on. */
ok(!/T\('Issue fapiao on desktop'/.test(M_SRC) && !/'请在电脑端开具'/.test(M_SRC),
   'the line that sent issuing to the desktop is gone in both languages');
ok(/APP\.cmd\('openInvoiceOrder',\$\{\(DB\.invoices\|\|\[\]\)\.indexOf\(v\)\}\)/.test(M_SRC),
   'and each request row opens its order, where the fapiao is issued');

// ── 3. The server path is untouched and still dormant ───────────────────────
console.log('\nThe server, deliberately left alone');

ok(fs.existsSync(path.join(ROOT, 'lib', 'nuonuo.js')),
   'lib/nuonuo.js still exists — the decision was UI-only');
ok(/function maybeAutoIssueInvoice/.test(R_SRC),
   'and the auto-issue path is still there');
ok(/if \(!settings\.autoIssue \|\| !_nuonuo\.nuonuoEnabled\(creds\)\) return;/.test(R_SRC),
   'STILL GUARDED BY BOTH LOCKS. With no switch on the phone the stored flag cannot '
   + 'be raised from a screen, and the credential check is what kept it harmless all '
   + 'along — neither guard may be relaxed to make up for the missing control');
ok(/router\.(get|put)\('\/api\/retail-admin\/fapiao-settings'/.test(R_SRC),
   'the endpoints stay: the desktop and any future tenant still reach them');

// ── 4. Why it was not deleted ───────────────────────────────────────────────
console.log('\nWhy it stays');
ok(/NUONUO_APP_KEY:\s*'nuonuo\.app_key'/.test(C_SRC),
   'the credential keys are still registered per-tenant');
ok(/function getTenantCreds/.test(C_SRC) && /isRoots\(tenantId\)/.test(C_SRC),
   'AND THE CREDS ARE PER-TENANT — Roots reads env, every other tenant stores its own. '
   + 'This shop\'s provider having no API is a fact about ONE tenant; the capability '
   + 'belongs to the platform, and deleting it would take it from all of them');

console.log(`\n${fail ? '✗ ' + fail + ' failed' : '✓ ' + pass + ' passed, 0 failed'}`);
process.exit(fail ? 1 : 0);
