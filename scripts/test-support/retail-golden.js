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
  // A map key in the shell would turn an address save into a lookup with an
  // answer from outside. Tests never load .env, so these are normally unset
  // already; blanking them keeps a developer's own shell from changing what
  // gets recorded. Read at module load, so this has to come first.
  for (const k of ['AMAP_MAPS_KEY', 'TENCENT_MAPS_KEY']) process.env[k] = '';

  // Nothing may leave the machine, by fetch or by node's http/https. Recorded
  // rather than thrown, so the answer the route gives is the one it gives
  // offline, and the suite reports it.
  const outbound = [];
  const isLocal = (host) => /^(127\.0\.0\.1|localhost)$/.test(String(host || '').replace(/:\d+$/, ''));
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (!/^http:\/\/127\.0\.0\.1:/.test(u)) {
      outbound.push(u.replace(/access_token=[^&]+/, 'access_token=…'));
      return Promise.reject(new Error('golden: outbound request blocked'));
    }
    return realFetch(url, opts);
  };
  const { EventEmitter } = require('events');
  const realRequest = {};
  for (const mod of [require('http'), require('https')]) {
    for (const fn of ['request', 'get']) {
      const real = mod[fn];
      realRequest[(mod === require('http') ? 'http.' : 'https.') + fn] = real;
      mod[fn] = function (...args) {
        const o = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(String(args[0])) : (args[0] || {});
        const host = o.hostname || o.host;
        if (isLocal(host)) return real.apply(this, args);
        outbound.push(`${fn} ${host}${o.pathname || o.path || ''}`.replace(/key=[^&]+/, 'key=…'));
        const fake = new EventEmitter();
        Object.assign(fake, { write() {}, end() {}, abort() {}, destroy() {}, setTimeout() { return fake; }, setHeader() {} });
        process.nextTick(() => fake.emit('error', new Error('golden: outbound request blocked')));
        return fake;
      };
    }
  }

  const F = require('./tenant-fixture');
  const h = F.harness();
  const db = h.db;
  require(path.join(REPO, 'routes', 'backend-auth.js'));
  const router = require(path.join(REPO, 'routes', 'retail.js'));
  const express = require('express');

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
    close: () => new Promise((r) => server.close(r)).then(() => {
      global.fetch = realFetch;
      for (const [k, fn] of Object.entries(realRequest)) require(k.split('.')[0])[k.split('.')[1]] = fn;
    }),
  };
}

// Timestamps differ between two honest runs, and so does a referral code,
// which is minted at random (ensureReferralCode). The code is masked by field
// name AND shape, so nothing else that happens to be called "code" is hidden.
const TS = /\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
function normalise(text) {
  let v;
  try { v = JSON.parse(text); } catch { return String(text).replace(TS, '<T>'); }   // CSV, HTML
  return JSON.parse(JSON.stringify(v, (k, x) => {
    if (typeof x !== 'string') return x;
    if ((k === 'code' || k === 'referral_code') && /^[A-Z0-9]+-[A-Z0-9]{6}$/.test(x)) return '<REFERRAL_CODE>';
    return x.replace(TS, '<T>');
  }), (k, x) => (/(_ms|_time)$/.test(k) && typeof x === 'number' ? '<N>' : x));
}

module.exports = { openApp, normalise, REPO };
