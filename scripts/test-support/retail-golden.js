// Golden answers for the routes split out of routes/retail.js (decisions §472).
//
// WHAT IT IS FOR. A move of code out of retail.js must change nothing a caller
// can see. The split guard (scripts/test_retail_split_routes.js) proves no
// request changes hands; this proves the hands give the same answer. It sends
// a fixed list of requests to the real router over a seeded scratch database
// and compares every status and body with the answers recorded in
// scripts/test-support/golden/retail-<area>.json.
//
// HOW AN AREA IS ADDED, and the order matters:
//   1. On main, BEFORE moving anything, add the area's requests to
//      scripts/test_retail_golden.js and record:
//        node scripts/test_retail_golden.js --update <area>
//      Commit the recording on its own, so it is evidence about the old code.
//   2. Move the area. The suite must stay green without re-recording.
//
// WHEN AN ANSWER CHANGES ON PURPOSE (a real behaviour change, not a move),
// re-record that area with --update and commit the new file with the change,
// so the diff of the recording shows a reviewer exactly what callers will see.
//
// Everything here is deterministic: a fresh database per area, fixed seed
// rows, timestamps written as <T>. No request may leave the machine: fetch is
// wrapped, and any call to a host other than the local server fails the suite.
'use strict';

const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// One seeded app per area. Returns { call, seed, close, outbound }.
async function openApp() {
  const F = require('./tenant-fixture');
  const h = F.harness();
  const db = h.db;
  require(path.join(REPO, 'routes', 'backend-auth.js'));
  const router = require(path.join(REPO, 'routes', 'retail.js'));
  const express = require('express');

  // Nothing may leave the machine. Recorded rather than thrown, so the answer
  // the route gives is the one it gives offline, and the suite reports it.
  const outbound = [];
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (!/^http:\/\/127\.0\.0\.1:/.test(u)) {
      outbound.push(u.replace(/access_token=[^&]+/, 'access_token=…'));
      return Promise.reject(new Error('golden: outbound request blocked'));
    }
    return realFetch(url, opts);
  };

  const tenant = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (9001, ?, 'golden_owner', 'x', 'owner', 1)`).run(tenant);

  // Insert a row, filling any NOT NULL column without a default that the
  // caller did not name, so a new column does not break the seed.
  function ins(table, row) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const c of cols) {
      if (!c.notnull || c.dflt_value != null || c.pk || c.name in row) continue;
      row[c.name] = /_at$/.test(c.name) ? '2026-01-01 00:00:00'
        : /(id|count|qty|rating|cents|points)$/.test(c.name) ? 1 : 'x';
    }
    const k = Object.keys(row);
    return db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`)
      .run(...k.map((x) => row[x])).lastInsertRowid;
  }

  const customer = ins('retail_customers', { openid: 'golden_openid', nickname: 'Golden' });
  db.prepare(`INSERT INTO retail_auth_tokens (token, customer_id, expires_at)
              VALUES ('goldentoken', ?, datetime('now', '+1 day'))`).run(customer);

  const app = express();
  app.use((req, _res, next) => {
    req.session = req.get('x-op') ? { backendUserId: Number(req.get('x-op')) } : {};
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const HEADERS = { customer: { Authorization: 'Bearer goldentoken' }, admin: { 'x-op': '9001' }, anon: {} };
  async function call([who, method, p, body]) {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...HEADERS[who] },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { req: `${method} ${p} [${who}]`, status: r.status, body: normalise(await r.text()) };
  }

  return {
    db, ins, customer, call, outbound,
    close: () => new Promise((r) => server.close(r)).then(() => { global.fetch = realFetch; }),
  };
}

// Timestamps are the only thing that differs between two honest runs.
function normalise(text) {
  let v;
  try { v = JSON.parse(text); } catch { return text; }
  return JSON.parse(JSON.stringify(v, (_k, x) => {
    if (typeof x !== 'string') return x;
    return x.replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?Z?/g, '<T>');
  }), (k, x) => (/(_ms|_time)$/.test(k) && typeof x === 'number' ? '<N>' : x));
}

module.exports = { openApp, normalise, REPO };
