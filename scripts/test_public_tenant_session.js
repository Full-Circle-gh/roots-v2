#!/usr/bin/env node
/**
 * On the back-office host, a public read follows the operator's tenant — §276.
 *
 * The editor's preview frames (/shop-preview, /storefront, the desktop stage
 * in /cms and /product-editor) live on the back-office host, which is no
 * storefront, and read /api/retail/* like a shopper. middleware/public-tenant
 * resolved that read by AppID, then by Host, then fell to the default (Roots)
 * — so a second tenant's editor showed Roots' products under its own draft.
 * Now, on a host that is no storefront at all, the operator's session names
 * the tenant.
 *
 * The module is loaded with its database stubbed, so every branch runs on
 * fixtures: which tenants exist, which hosts are storefronts, what the
 * session says. What this holds:
 *   §1 the order of the three signals: AppID, then a storefront host (which
 *      decides on its own), then the session
 *   §2 the session counts only on a non-storefront host, only for an active
 *      non-Roots tenant, only with a signed-in operator
 *   §3 the fail-safe is unchanged: anything unresolved is the default
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'middleware', 'public-tenant.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const section = (t) => console.log('\n' + t);

/* ── fixtures ── */
const TENANTS = {
  1: { id: 1, status: 'active', wx_appid: 'wx-roots' },
  2: { id: 2, status: 'active', wx_appid: 'wx-two' },
  3: { id: 3, status: 'suspended', wx_appid: 'wx-three' },
};
const HOSTS = { 'roots.shop.example': 1, 'two.shop.example': 2 };   // active storefront hosts → tenant

/* ── a database that answers the module's three queries ── */
const fakeDb = {
  prepare(sql) {
    return {
      get(arg) {
        if (/FROM tenants WHERE wx_appid/.test(sql)) return Object.values(TENANTS).find(t => t.wx_appid === arg) || undefined;
        if (/FROM tenants WHERE id/.test(sql)) return TENANTS[arg] || undefined;
        if (/FROM tenant_domains d JOIN tenants t/.test(sql)) {
          const tid = HOSTS[arg]; if (!tid) return undefined;
          return { tenant_id: tid, tenant_status: TENANTS[tid].status };
        }
        throw new Error('unexpected query: ' + sql);
      },
    };
  },
};
const scopes = [];
const fakeRequire = (name) => {
  if (name === '../lib/db-seam') return { seam: (x) => x };
  if (name === '../database') return fakeDb;
  if (name === '../lib/tenant-db') return {
    ROOTS_TENANT_ID: 1,
    getTenantDb: (id) => ({ id }),
    rawTenantDb: (id) => ({ id }),
    tenantAls: { run: (store, fn) => { scopes.push(store.id); return fn(); } },
  };
  return require(name);
};
const m = { exports: {} };
vm.runInNewContext(Module.wrap(SRC), { console })(m.exports, fakeRequire, m, 'public-tenant.js', ROOT);
const { resolvePublicTenant, resolveSessionTenant, publicTenantScope } = m.exports;

const req = ({ host, appid, session } = {}) => ({
  hostname: host,
  get: (h) => (h === 'x-wx-appid' ? (appid || '') : (h === 'host' ? host : '')),
  session,
});
const operator = (tenantId) => ({ backendUserId: 42, tenantId });

// ─────────────────────────────────────────────────────────────────────────
section('1 · the three signals, in order');

is(resolvePublicTenant(req({ host: 'office.example', appid: 'wx-two', session: operator(2) })), 2, 'the mini app\'s AppID wins');
is(resolvePublicTenant(req({ host: 'two.shop.example' })), 2, 'a storefront host names its tenant');
is(resolvePublicTenant(req({ host: 'roots.shop.example' })), null, 'Roots\' own storefront host is the default, as before');
is(resolvePublicTenant(req({ host: 'roots.shop.example', session: operator(2) })), null,
  'on a storefront host the host decides alone — a session there (if one ever were) does not redirect Roots\' shop to another tenant');
is(resolvePublicTenant(req({ host: 'two.shop.example', session: operator(1) })), 2, '…nor pull a tenant\'s shop back to the default');
is(resolvePublicTenant(req({ host: 'office.example', session: operator(2) })), 2,
  'on the back-office host (no storefront) the operator\'s session names the tenant — the editor\'s preview frames');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the session counts only when it should');

is(resolveSessionTenant(req({ session: operator(2) })), 2, 'a signed-in operator of an active tenant');
is(resolveSessionTenant(req({ session: operator(1) })), null, 'Roots\' own operator is the default (Roots is the global db)');
is(resolveSessionTenant(req({ session: operator(3) })), null, 'a suspended tenant enters no scope');
is(resolveSessionTenant(req({ session: operator(99) })), null, 'a tenant that does not exist enters no scope');
is(resolveSessionTenant(req({ session: { tenantId: 2 } })), null, 'a session with a tenant but no signed-in operator is not trusted');
is(resolveSessionTenant(req({ session: { backendUserId: 42 } })), null, 'a session with an operator but no tenant is the default');
is(resolveSessionTenant(req({})), null, 'no session at all is the default');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the fail-safe and the scope');

is(resolvePublicTenant(req({ host: 'office.example' })), null, 'a shopper on a host that is no storefront, with no session, is the default');
is(resolvePublicTenant(req({ host: 'office.example', appid: 'wx-three' })), null, 'a suspended tenant\'s AppID is the default');
{
  scopes.length = 0;
  let nexted = 0;
  publicTenantScope(req({ host: 'office.example', session: operator(2) }), {}, () => { nexted++; });
  is(scopes, [2], 'the middleware enters tenant 2\'s scope for the operator\'s preview read');
  is(nexted, 1, '…and the request goes on');
  scopes.length = 0; nexted = 0;
  publicTenantScope(req({ host: 'office.example' }), {}, () => { nexted++; });
  is(scopes, [], 'and enters no scope at all for the default');
  is(nexted, 1, '…and the request still goes on');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
