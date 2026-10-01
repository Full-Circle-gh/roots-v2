#!/usr/bin/env node
/**
 * §325 step S2k — POST /eleme/products/:id/map NEVER LEAVES A NAMELESS MAPPING ON.
 *
 *   node scripts/test_eleme_map_nameless.js
 *
 * Eleme matches a push by name only, and the daemon fills a missing listing
 * name with the product's own Chinese name (docs/eleme-findings.md finding 6).
 * S2j made lib/channel-sync-write.js setSync refuse to switch such a mapping
 * on. The Eleme panel's own write is this route, and it still accepted
 * `syncEnabled: 1` with no name — and with `syncEnabled` not sent it defaulted
 * a new mapping to ON, which is how the switch manufactured nameless mappings
 * (finding 8). Now:
 *   • `syncEnabled` truthy with no name → 409 `no_listing_name`, nothing written;
 *   • `syncEnabled` not sent and no name → stored OFF;
 *   • a mapping WITH a name keeps today's default (ON when not sent).
 *
 * The real route over a scratch database; then the callers, read from source.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
            VALUES (8250, ?, '__s2k_owner', 'x', 'owner', 1)`).run(TENANT);
db.prepare(`INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order) VALUES (1, 'tianhe', 'Tianhe', '天河', 1, 1)`).run();
for (let i = 1; i <= 9; i++) F.seedProduct(db, { id: 8200 + i, name: 'S2k ' + i, sku: 'S2K-' + i, storeOnly: true });
const row = (pid) => db.prepare('SELECT eleme_name AS name, sync_enabled AS sync FROM eleme_product_map WHERE product_id = ? AND retail_store_id = 1').get(pid) || null;

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: 8250 }; next(); });
  app.use(require(path.join(ROOT, 'routes', 'eleme-admin.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const map = async (pid, extra) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/retail-admin/eleme/products/${pid}/map`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: 1, storeCode: 'tianhe', ...extra }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    section('1 · no name');
    let r = await map(8201, {});
    is([r.status, row(8201)], [200, { name: null, sync: 0 }], 'a new mapping with no name and no syncEnabled is stored OFF (was ON)');
    r = await map(8202, { syncEnabled: 1 });
    is([r.status, r.body.error, r.body.stores], [409, 'no_listing_name', ['tianhe']], 'syncEnabled:1 with no name is refused, with S2j\'s code');
    is(row(8202), null, '…and no mapping was created');
    r = await map(8203, { elemeName: '   ', syncEnabled: true });
    is(r.status, 409, 'a name of spaces is no name');
    is(row(8203), null, '…nothing written');
    r = await map(8204, { syncEnabled: 0 });
    is([r.status, row(8204)], [200, { name: null, sync: 0 }], 'a nameless mapping may be stored OFF explicitly');

    section('2 · a mapping with a name keeps today\'s behaviour');
    r = await map(8205, { elemeName: '酸芒果干' });
    is([r.status, row(8205)], [200, { name: '酸芒果干', sync: 1 }], 'a named mapping with no syncEnabled is ON, as before');
    r = await map(8205, { syncEnabled: 0 });
    is(row(8205), { name: '酸芒果干', sync: 0 }, 'switching it off keeps the name');
    r = await map(8205, { syncEnabled: 1 });
    is([r.status, row(8205)], [200, { name: '酸芒果干', sync: 1 }], 'switching it back on works — the stored name counts');

    section('3 · a named, ON mapping cannot be blanked into the dangerous state');
    r = await map(8205, { elemeName: '', syncEnabled: 1 });
    is(r.status, 409, 'clearing the name while sending syncEnabled:1 is refused');
    is(row(8205), { name: '酸芒果干', sync: 1 }, '…and the mapping is exactly as it was');
    r = await map(8205, { elemeName: null });
    is([r.status, row(8205)], [200, { name: null, sync: 0 }], 'clearing the name without syncEnabled turns it OFF with it');
  } finally {
    server.close();
  }

  section('4 · every caller that creates or changes a mapping, read from source');
  {
    const E14 = read('public/retail-admin/14-eleme.js');
    ok(/if \(on && !\(\(cur && cur\.eleme_name\) \|\| ''\)\.trim\(\)\)/.test(E14),
      'desktop switch (elToggleSync): refuses ON with no name before it sends');
    ok(/if \(!typed \|\| !elNameKnown\(storeCode, typed\)\)/.test(E14) && /elemeName: name \|\| null, syncEnabled: cur \? Number\(cur\.sync_enabled\) : 0/.test(E14),
      'desktop name field (elSetElemeName): only a known catalogue name reaches it; the switch is echoed, 0 for a new row');
    ok(/body: \{ storeId, storeCode, remove: true \}/.test(E14), 'desktop Remove deletes the mapping rather than blanking it');
    const routes = read('routes/eleme-admin.js');
    ok(/if \(!name\) return res\.status\(400\)\.json\(\{ success: false, error: 'no listing mapped yet' \}\)/.test(routes),
      'the claim route refuses without a listing name');
    for (const f of ['scripts/eleme-match-products.js', 'scripts/eleme-apply-reviewed-matches.js']) {
      ok(/INSERT INTO eleme_product_map \(retail_store_id, product_id, store_code, eleme_name, sync_enabled, updated_at\)\s*VALUES \(\?, \?, \?, \?, 1,/.test(read(f)),
        `${f}: writes ON only with a matched catalogue name`);
    }
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = d + '/' + e.name;
      if (e.isDirectory()) walk(rel); else if (/\.(html|js)$/.test(e.name)) files.push(rel);
    } };
    walk('public');
    const callers = files.filter((f) => /eleme\/products\/'\s*\+[^;\n]*'\/map'|eleme\/products\/\$\{[^}]+\}\/map/.test(read(f)));
    is(callers, ['public/retail-admin/14-eleme.js'], 'the only screen calling /map is the desktop Eleme panel (the phone has none at this merge)');
    ok(!/INSERT INTO eleme_product_map|UPDATE eleme_product_map SET [^`]*sync_enabled/.test(read('lib/channel-sync-items.js') + read('lib/eleme-sync.js')),
      'no library writes a mapping\'s name or switch behind the route');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
