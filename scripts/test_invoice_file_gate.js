#!/usr/bin/env node
/**
 * §300 step F4b — THE FAPIAO FILE UPLOAD NEEDS `invoices:manage`.
 *
 *   node scripts/test_invoice_file_gate.js
 *
 * POST /api/retail-admin/invoice-file stores the PDF or photo of an issued 发票.
 * It matched no rule in lib/cap-routes.js (`invoice-file` is not `invoices`),
 * so it was an unmapped write and fell through fail-open. It is gated now on
 * `invoices:manage`, "Issue / upload invoices".
 *
 * Both sides are asserted — who is let through and who is refused — through
 * the choke point exactly as routes/retail.js applies it (checked against that
 * file's source), and nothing else about the neighbouring routes moves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

/* The choke point, line for line — asserted against its source below. */
function allowed({ method, path: p, role = 'staff', caps = [], enforce = true }) {
  const set = caps == null ? null : new Set(caps);
  if (!(enforce && role !== 'owner' && set)) return true;
  const need = requiredCapFor(method, p);
  if (!need) return true;
  return Array.isArray(need) ? need.some((k) => set.has(k)) : set.has(need);
}
const UP = { method: 'POST', path: '/api/retail-admin/invoice-file' };

section('0 · the stand-in is the real choke point');
{
  const choke = RETAIL.slice(RETAIL.indexOf('RBAC ENFORCEMENT (Phase 2)'), RETAIL.indexOf('Store scope —'));
  ok(/tenant\.rbac_enforce && u\.role !== 'owner' && req\.caps/.test(choke), 'enforce-on + not-owner + caps-resolved');
  ok(/const ok = Array\.isArray\(need\) \? need\.some\(k => req\.caps\.has\(k\)\) : req\.caps\.has\(need\);/.test(choke), 'any-of for a list');
  ok(/router\.post\('\/api\/retail-admin\/invoice-file', requireRetailAdmin/.test(RETAIL), 'the route sits behind requireRetailAdmin');
}

section('1 · the rule');
is(requiredCapFor('POST', '/api/retail-admin/invoice-file'), 'invoices:manage', 'the upload is invoices:manage');
is(requiredCapFor('GET', '/api/retail-admin/invoice-file'), null, 'reads stay open, as every read does');
is(requiredCapFor('POST', '/api/retail-admin/invoice-file/x'), null, 'exact path: nothing longer rides on it');
is(requiredCapFor('PUT', '/api/retail-admin/orders/5/invoice'), 'orders:edit', 'Mark issued is unchanged');
is(requiredCapFor('PUT', '/api/retail-admin/invoices/5'), 'invoices:manage', 'the /invoices rule is unchanged');
is(requiredCapFor('POST', '/api/retail-admin/purchasing/invoices'), 'purchasing:invoices', 'supplier invoices are unchanged');

section('2 · who gets through');
ok(allowed({ ...UP, caps: ['invoices:manage'] }), 'invoices:manage alone uploads');
ok(allowed({ ...UP, caps: ['invoices:manage', 'orders:edit'] }), 'the phone\'s pair uploads');
ok(allowed({ ...UP, role: 'owner', caps: [] }), 'the owner, holding nothing, uploads');
ok(allowed({ ...UP, caps: [], enforce: false }), 'a shop with enforcement off sees no change');
ok(allowed({ ...UP, caps: null }), 'unresolved caps fail open, as everywhere else');

section('3 · who is refused');
ok(!allowed({ ...UP, caps: ['orders:edit', 'orders:view'] }), 'orders:edit alone (the staff and dispatch presets) is refused');
ok(!allowed({ ...UP, caps: ['invoices:view', 'invoices:export'] }), 'reading invoices is not uploading one');
ok(!allowed({ ...UP, caps: [] }), 'nothing held, nothing uploaded');

section('4 · every caller is one that already expects the key');
{
  const files = ['public/m.html', ...fs.readdirSync(path.join(ROOT, 'public/retail-admin')).map((f) => 'public/retail-admin/' + f)];
  const callers = files.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('/invoice-file'));
  is(callers.sort(), ['public/m.html', 'public/retail-admin/07-content-billing.js'], 'two callers: the phone sheet and the desktop drawer');
  const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
  ok(/const invCanIssue=\(\)=>mCan\('invoices:manage'\)&&mCan\('orders:edit'\);/.test(M), 'the phone draws its button only for invoices:manage');
  ok(/reg\('invFile'[\s\S]{0,400}!invCanIssue\(\)\) return;/.test(M), 'and its command refuses without it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
