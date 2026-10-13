#!/usr/bin/env node
/**
 * test_retail_split_routes.js — routes/retail.js is split by area, and no
 * request changes hands because of it (decisions §470).
 *
 *   node scripts/test_retail_split_routes.js
 *
 * WHAT A MOVE CAN BREAK. Express answers a request with the FIRST registered
 * endpoint that matches it. While everything sat in one file, the order of the
 * file was that order. A part mounted from routes/retail/<area>.js takes its
 * endpoints to wherever it is mounted. Inside one file a move keeps the order,
 * so only a pair of endpoints that sit in DIFFERENT files and could both match
 * one request can change which handler answers. This suite fails on any such
 * pair, so no answer depends on where a part is mounted.
 *
 * WHAT IT HOLDS, against the real router over a scratch database:
 *   1. every file in routes/retail/ is mounted, exactly once, with exactly the
 *      endpoints listed for it below (a move that drops or adds an endpoint
 *      shows up here);
 *   2. a part holds endpoints only, no pathless middleware: one would run on
 *      every request passing its mount, including ones retail.js answers later;
 *   3. no endpoint in one file could answer a request an endpoint in another
 *      file also answers;
 *   4. every path is plain text and :params, the only shapes rule 3 can judge.
 *
 * Adding a part: move the area, mount it where the area started, and add its
 * endpoints to PARTS in the order they are registered.
 */
'use strict';

const path = require('path');
const F = require('./test-support/tenant-fixture');
const { retailPartFiles } = require('./test-support/retail-source');

const h = F.harness();
const ROOT = h.REPO;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const retail = require(path.join(ROOT, 'routes', 'retail.js'));

const PARTS = {
  'routes/retail/polls.js': [
    'GET /api/retail/polls',
    'GET /api/retail/polls/public',
    'GET /api/retail/voting/config',
    'GET /api/retail/polls/:id',
    'POST /api/retail/polls/:id/vote',
    'GET /api/retail-admin/voting/config',
    'PUT /api/retail-admin/voting/config',
    'GET /api/retail-admin/polls',
    'GET /api/retail-admin/polls/:id',
    'POST /api/retail-admin/polls',
    'PUT /api/retail-admin/polls/:id',
    'DELETE /api/retail-admin/polls/:id',
  ],
};

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
};

/* ── the router, flattened in the order express tries it ─────────────────── */
// Each endpoint: { owner, method, path }. owner is 'routes/retail.js' for the
// top router and the index of the nested router for a mounted part, resolved
// to a file name below by its endpoint list.
const endpoints = [];
const nested = [];          // [{ routes: ['GET /x', ...], middleware: n }]
for (const layer of retail.stack) {
  if (layer.route) {
    for (const m of Object.keys(layer.route.methods)) {
      endpoints.push({ owner: 'routes/retail.js', method: m.toUpperCase(), path: layer.route.path });
    }
  } else if (layer.handle && Array.isArray(layer.handle.stack)) {
    const part = { routes: [], middleware: 0, entries: [] };
    for (const l of layer.handle.stack) {
      if (!l.route) { part.middleware++; continue; }
      for (const m of Object.keys(l.route.methods)) {
        const e = { owner: null, method: m.toUpperCase(), path: l.route.path };
        part.routes.push(e.method + ' ' + e.path);
        part.entries.push(e);
        endpoints.push(e);
      }
    }
    nested.push(part);
  }
}

console.log('\n1. every part is mounted once, with exactly its endpoints');
const files = retailPartFiles().map((f) => f.split(path.sep).join('/'));
ok(JSON.stringify(files) === JSON.stringify(Object.keys(PARTS).sort()),
  'routes/retail/ holds exactly the parts this suite lists',
  `on disk: ${JSON.stringify(files)} · listed: ${JSON.stringify(Object.keys(PARTS).sort())}`);
for (const [file, want] of Object.entries(PARTS)) {
  const found = nested.filter((p) => JSON.stringify(p.routes) === JSON.stringify(want));
  ok(found.length === 1, `${file} is mounted once, with its ${want.length} endpoints in order`,
    found.length ? `mounted ${found.length} times` : 'no mounted router carries exactly this list');
  for (const p of found) for (const e of p.entries) e.owner = file;
}
const unknown = nested.filter((p) => p.entries.some((e) => !e.owner));
ok(unknown.length === 0, 'no router is mounted in retail.js that this suite does not know',
  unknown.map((p) => JSON.stringify(p.routes)).join(' · '));

console.log('\n2. a part holds endpoints only');
for (const p of nested) {
  const name = (p.entries[0] && p.entries[0].owner) || 'an unknown part';
  ok(p.middleware === 0, `${name} registers no pathless middleware`, `${p.middleware} middleware layer(s)`);
}

console.log('\n3. no request can be answered from two files');
const PLAIN = /^(\/(:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._-]+))+$/;
const bad = endpoints.filter((e) => typeof e.path !== 'string' || !PLAIN.test(e.path));
ok(bad.length === 0, `all ${endpoints.length} endpoint paths are plain text and :params`,
  bad.slice(0, 5).map((e) => e.method + ' ' + e.path).join(' · '));

// Express matches case-insensitively and ignores a trailing slash by default;
// a HEAD request is answered by a GET endpoint.
const segs = (p) => p.toLowerCase().replace(/\/+$/, '').split('/');
const methodsMeet = (a, b) => a === b || a === '_ALL' || b === '_ALL'
  || (a === 'GET' && b === 'HEAD') || (a === 'HEAD' && b === 'GET');
function pathsMeet(a, b) {
  const x = segs(a), y = segs(b);
  if (x.length !== y.length) return false;
  return x.every((s, i) => s === y[i] || s.startsWith(':') || y[i].startsWith(':'));
}
const clashes = [];
for (let i = 0; i < endpoints.length; i++) {
  for (let j = i + 1; j < endpoints.length; j++) {
    const a = endpoints[i], b = endpoints[j];
    if (a.owner === b.owner) continue;
    if (methodsMeet(a.method, b.method) && pathsMeet(a.path, b.path)) clashes.push([a, b]);
  }
}
ok(clashes.length === 0, 'no endpoint in one file could answer a request an endpoint in another file answers',
  clashes.slice(0, 5).map(([a, b]) => `${a.method} ${a.path} (${a.owner}) and ${b.method} ${b.path} (${b.owner})`).join(' · '));

// The check above must be able to fail. Two pairs it has to catch, and one it
// must let through, so a broken comparison cannot pass by finding nothing.
ok(pathsMeet('/api/retail/polls/:id', '/api/retail/polls/public'), 'self-check: a :param meets a literal in its place');
ok(pathsMeet('/api/x/:a/b', '/api/x/c/:d'), 'self-check: two :params meet across positions');
ok(!pathsMeet('/api/retail/polls/:id', '/api/retail/polls/:id/vote'), 'self-check: different lengths never meet');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
