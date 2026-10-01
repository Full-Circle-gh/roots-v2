#!/usr/bin/env node
/**
 * §325 step S2e — TWO MORE WRITES THAT MATCHED NO RULE.
 *
 *   node scripts/test_restore_geocode_gates.js
 *
 *   • POST /deleted/:id/restore puts a deleted record back. It now takes the
 *     key that edits that KIND of record (the key the phone draws "Put it
 *     back" on): the choke point lets the union through, and routes/recycle.js
 *     narrows it to the stored copy's kind before anything is written.
 *   • POST /inventory/geocode-backfill spends the maps quota on every store and
 *     address. Its one button is in desktop Settings → Operations, so it takes
 *     the Settings tab's keys.
 *
 * The real routers over a scratch database, enforcement on, each operator's
 * keys real tenant_user_caps grants resolved by the real requireRetailAdmin.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
require(path.join(ROOT, 'routes', 'retail.js'));
const recycle = require(path.join(ROOT, 'lib', 'recycle'));
const { requiredCapFor, restoreKindCap } = require(path.join(ROOT, 'lib', 'cap-routes'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);
let nextId = 7600;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2e_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
}
operator('delivery', ['delivery:view', 'delivery:edit']);
operator('finance', ['finance:view', 'finance:record']);
operator('coupons', ['coupons:view', 'coupons:delete']);
operator('buyer', ['purchasing:view', 'purchasing:edit']);
operator('orders', ['orders:view', 'orders:edit']);
operator('settings', ['settings:shop']);
operator('ops', ['stores:view']);
operator('owner', [], 'owner');

// A real delivery zone, deleted the way routes/retail.js deletes one.
function deletedZone(name) {
  const id = db.prepare("INSERT INTO retail_delivery_zones (name_en, name_cn, zone_type) VALUES (?, ?, 'city')").run(name, name).lastInsertRowid;
  const kept = recycle.capture(db, 'delivery_zone', Number(id), 'test');
  db.prepare('DELETE FROM retail_delivery_zones WHERE id = ?').run(id);
  return { zoneId: Number(id), deletedId: kept };
}
// A copy of another kind, written directly: only the gate is under test there.
function copyOf(kind) {
  return Number(db.prepare(`INSERT INTO deleted_records (kind, record_id, label, payload_json)
                            VALUES (?, ?, 'x', '{}')`).run(kind, 900000 + (++nextId)).lastInsertRowid);
}
const restoredAt = (id) => db.prepare('SELECT restored_at FROM deleted_records WHERE id = ?').get(id).restored_at;

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(require(path.join(ROOT, 'routes', 'recycle.js')));
  app.use(require(path.join(ROOT, 'routes', 'retail-inventory.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (who, p) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-op': String(ops[who]) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const restore = (who, id) => call(who, `/api/retail-admin/deleted/${id}/restore`);

  try {
    section('1 · the rules');
    is(requiredCapFor('POST', '/api/retail-admin/deleted/5/restore'),
      ['delivery:edit', 'finance:record', 'coupons:edit', 'coupons:delete', 'purchasing:edit'],
      'the choke point lets any kind\'s key through; the handler decides the rest');
    is(restoreKindCap('delivery_zone'), ['delivery:edit'], 'a delivery zone: delivery:edit');
    is(restoreKindCap('finance_in'), ['finance:record'], 'money in: finance:record');
    is(restoreKindCap('finance_out'), ['finance:record'], 'money out: finance:record');
    is(restoreKindCap('voucher'), ['coupons:edit', 'coupons:delete'], 'a coupon: coupons:edit or coupons:delete');
    is(restoreKindCap('purchase_order'), ['purchasing:edit'], 'a draft purchase order: purchasing:edit');
    is(Object.keys(recycle.KINDS).sort(), ['delivery_zone', 'finance_in', 'finance_out', 'purchase_order', 'voucher'],
      'every kind lib/recycle.js keeps has its own key here — a new kind fails this until it is given one');
    is(requiredCapFor('GET', '/api/retail-admin/deleted'), null, 'the list is a read and stays open');
    is(requiredCapFor('POST', '/api/retail-admin/deleted/5/restore/x'), null, 'the rule is exact');
    is(requiredCapFor('POST', '/api/retail-admin/inventory/geocode-backfill'),
      ['settings:shop', 'settings:push', 'settings:payments', 'stores:view', 'shipping:config', 'delivery:view'],
      'the geocode backfill takes the Settings tab\'s keys');

    section('2 · putting a record back takes the key for its kind');
    {
      const z = deletedZone('Tianhe north');
      let r = await restore('finance', z.deletedId);
      is(r.status, 403, 'a finance account cannot put a delivery zone back');
      is(r.body && r.body.need, ['delivery:edit'], '…and is told the key it needs');
      is(restoredAt(z.deletedId), null, '…and nothing was put back');
      r = await restore('orders', z.deletedId);
      is(r.status, 403, 'an orders account is refused at the choke point');
      r = await restore('delivery', z.deletedId);
      is(r.status, 200, 'a delivery:edit account puts the zone back');
      ok(!!db.prepare('SELECT 1 FROM retail_delivery_zones WHERE id = ?').get(z.zoneId), '…and the zone is back under its own id');
    }
    for (const [kind, allowed, refused] of [
      ['finance_in', 'finance', 'delivery'], ['finance_out', 'finance', 'buyer'],
      ['voucher', 'coupons', 'finance'], ['purchase_order', 'buyer', 'coupons'],
    ]) {
      const id = copyOf(kind);
      const no = await restore(refused, id);
      is(no.status, 403, `${kind}: the ${refused} account is refused`);
      is(restoredAt(id), null, '…and nothing was written');
      const yes = await restore(allowed, id);
      ok(yes.status !== 403, `${kind}: the ${allowed} account gets past the gate (got ${yes.status})`, JSON.stringify(yes.body));
    }
    {
      const z = deletedZone('Owner zone');
      is((await restore('owner', z.deletedId)).status, 200, 'the owner, holding nothing, is never refused');
      is((await restore('delivery', 99999999)).status, 404, 'a copy that does not exist is still a 404');
    }

    section('3 · the geocode backfill');
    let r = await call('orders', '/api/retail-admin/inventory/geocode-backfill');
    is(r.status, 403, 'an orders account cannot spend the maps quota');
    r = await call('settings', '/api/retail-admin/inventory/geocode-backfill');
    ok(r.status !== 403, `a settings:shop account gets past the gate (got ${r.status})`);
    r = await call('ops', '/api/retail-admin/inventory/geocode-backfill');
    ok(r.status !== 403, `so does stores:view, which opens Settings too (got ${r.status})`);

    section('4 · the callers');
    const S = read('public/retail-admin/02-settings-ops.js');
    ok(/fetch\('\/api\/retail-admin\/inventory\/geocode-backfill'/.test(S), 'the desktop Operations button calls the backfill');
    const html = read('public/retail-admin.html');
    const btn = html.indexOf('onclick="_geocodeBackfill()"');
    const panel = html.lastIndexOf('class="sub-panel', btn);
    ok(btn > 0 && /id="sub-ops"/.test(html.slice(panel, panel + 60)), '…and it sits in Settings → Operations');
    /* §325 X2 brought the button to the phone's Operations screen, behind the
       desktop's quota confirm and drawn for the phone Settings screen's keys
       (opsxCan → ROUTE_CAP.settings). It is the only phone caller, and every
       key that draws it passes the gate above. */
    const M = read('public/m.html');
    is((M.match(/apiWrite\('\/inventory\/geocode-backfill'/g) || []).length, 1, 'the phone calls it from one place');
    const run = M.slice(M.indexOf('function opsxGeoRun()'), M.indexOf('function opsxGeoRun()') + 400);
    ok(run.includes("apiWrite('/inventory/geocode-backfill',{},'POST')"), '…the Operations screen\'s locate-everything run');
    ok(/const opsxCan=\(\)=>canRoute\('settings'\);/.test(M), '…drawn for the phone Settings screen\'s keys');
    const phoneSettings = (M.match(/\n  settings:\[([^\]]+)\]/) || [])[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    const need = requiredCapFor('POST', '/api/retail-admin/inventory/geocode-backfill');
    ok(phoneSettings.length && phoneSettings.every((k) => need.includes(k)), '…every one of which the gate admits', JSON.stringify({ phoneSettings, need }));
    ok(/data-cap="settings:edit" onclick="recycleRestore/.test(S), 'the desktop draws Put it back for settings:edit…');
    ok(!/'settings:edit'/.test(read('lib/capabilities.js')), '…a key that does not exist, so no desktop operator uses it today');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
