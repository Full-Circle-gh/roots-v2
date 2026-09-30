#!/usr/bin/env node
/**
 * §300 step F5b — THE AI READ AND ASK ON REPORTS ARE GATED ON THE SERVER.
 *
 *   node scripts/test_reports_ai_gate.js
 *
 * POST /api/retail-admin/reports/read and /reports/ask are billed model calls
 * that read the period's figures back. They matched no rule in
 * lib/cap-routes.js, so they fell through fail-open. F5b gated them on either
 * `reports:view` or `dashboard:view`; §324 (Ash: a Trend-only account does not
 * get the AI read) narrowed it to `reports:view` alone — the desktop Reports
 * tab's key and the key the phone already drew the read for.
 *
 * Both sides are asserted — who is let through and who is refused — through
 * the choke point exactly as routes/retail.js applies it (checked against that
 * file's source), and every place that opens those screens is checked for the
 * key it uses, so the any-of cannot drift away from them unnoticed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const M = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* The choke point, line for line — asserted against its source below. */
function allowed({ path: p, role = 'staff', caps = [], enforce = true }) {
  const set = caps == null ? null : new Set(caps);
  if (!(enforce && role !== 'owner' && set)) return true;
  const need = requiredCapFor('POST', p);
  if (!need) return true;
  return Array.isArray(need) ? need.some((k) => set.has(k)) : set.has(need);
}
const READ = '/api/retail-admin/reports/read';
const ASK = '/api/retail-admin/reports/ask';

section('0 · the stand-in is the real choke point, and the screens use the keys the rule names');
{
  const choke = RETAIL.slice(RETAIL.indexOf('RBAC ENFORCEMENT (Phase 2)'), RETAIL.indexOf('Store scope —'));
  ok(/tenant\.rbac_enforce && u\.role !== 'owner' && req\.caps/.test(choke), 'enforce-on + not-owner + caps-resolved');
  ok(/const ok = Array\.isArray\(need\) \? need\.some\(k => req\.caps\.has\(k\)\) : req\.caps\.has\(need\);/.test(choke), 'a list is any-of');
  ok(/router\.post\('\/api\/retail-admin\/reports\/read', requireRetailAdmin/.test(RETAIL)
    && /router\.post\('\/api\/retail-admin\/reports\/ask', requireRetailAdmin/.test(RETAIL), 'both routes sit behind requireRetailAdmin');
  ok(/reports: 'reports:view'/.test(CORE), 'the desktop Reports tab opens on reports:view');
  ok(/trend:'dashboard:view'/.test(M), 'the phone Trend screen opens on dashboard:view');
  ok(/const trendAiOn=\(\)=>mCan\('reports:view'\)/.test(M), 'the phone draws the read only for reports:view');
}

section('1 · the rule');
is(requiredCapFor('POST', READ), 'reports:view', 'the read: reports:view only (§324)');
is(requiredCapFor('POST', ASK), 'reports:view', 'Ask: reports:view only (§324)');
is(requiredCapFor('POST', '/api/retail-admin/reports/read/x'), null, 'exact paths: nothing longer rides on it');
is(requiredCapFor('GET', '/api/retail-admin/dashboard'), null, 'the reads behind both screens stay open, as every read does');

section('2 · who gets through');
for (const p of [READ, ASK]) {
  const w = p.endsWith('read') ? 'the read' : 'Ask';
  ok(allowed({ path: p, caps: ['reports:view'] }), `${w}: a desktop Reports reader`);
  ok(allowed({ path: p, role: 'owner', caps: [] }), `${w}: the owner, holding nothing`);
  ok(allowed({ path: p, caps: [], enforce: false }), `${w}: a shop with enforcement off`);
  ok(allowed({ path: p, caps: null }), `${w}: unresolved caps fail open, as everywhere else`);
}

section('3 · who is refused');
for (const p of [READ, ASK]) {
  const w = p.endsWith('read') ? 'the read' : 'Ask';
  ok(!allowed({ path: p, caps: ['orders:view', 'orders:edit'] }), `${w}: an orders-only account`);
  ok(!allowed({ path: p, caps: ['quickstock:add', 'restock:pick'] }), `${w}: a warehouse account`);
  ok(!allowed({ path: p, caps: [] }), `${w}: nothing held`);
  ok(!allowed({ path: p, caps: ['dashboard:view'] }), `${w}: a Trend-only account (§324)`);
}

section('4 · the callers');
{
  const files = ['public/m.html', ...fs.readdirSync(path.join(ROOT, 'public/retail-admin')).map((f) => 'public/retail-admin/' + f)];
  const callers = files.filter((f) => /\/reports\/(read|ask)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  is(callers.sort(), ['public/m.html', 'public/retail-admin/03-dashboard.js'], 'two callers: the phone Trend and the desktop Reports');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
