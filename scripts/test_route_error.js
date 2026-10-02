#!/usr/bin/env node
/**
 * The global error handler (lib/route-error.js): a bad request gets a 4xx and
 * does NOT page ops; a real server error still gets a 500 and DOES page.
 *
 *   node scripts/test_route_error.js
 *
 * WHY. On 2026-10-02 a scanner sent malformed JSON to POST /api/mdm/getAppInfo,
 * a path this app has never had. express.json() rejected it before any route,
 * the handler answered 500 and paged "🔴 roots-v2 route error". This runs the
 * real handler on a real express app with the same body parser server.js uses,
 * and replays that request.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { routeErrorHandler, clientErrorStatus } = require('../lib/route-error');

let pages = [];
const app = express();
app.use(express.json({ limit: '1kb' }));
app.post('/api/boom', () => { throw new Error('db exploded'); });
app.post('/api/bad-input', () => { const e = new Error('deeplink_must_start_with_/pages/'); e.statusCode = 400; throw e; });
app.get('/page-boom', () => { throw new Error('render exploded'); });
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(routeErrorHandler({ page: (req, err) => pages.push(err.message) }));

// Keep the run's output readable; the handler logs on every case.
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {}; console.error = () => {};

function send(server, method, path, body, type = 'application/json') {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, method, path, headers: body != null ? { 'content-type': type } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

let failed = 0;
const cases = [];
const it = (name, fn) => cases.push([name, fn]);

it('the 2026-10-02 probe: malformed JSON → 400, no page', async (s) => {
  const r = await send(s, 'POST', '/api/mdm/getAppInfo', "{'a':1}");
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(JSON.parse(r.body), { error: 'bad_request' });
  assert.deepStrictEqual(pages, []);
});

it('body too large → 413, no page', async (s) => {
  const r = await send(s, 'POST', '/api/boom', JSON.stringify({ x: 'a'.repeat(5000) }));
  assert.strictEqual(r.status, 413);
  assert.deepStrictEqual(pages, []);
});

it('app code throwing with statusCode 400 → 400, no page', async (s) => {
  const r = await send(s, 'POST', '/api/bad-input', '{}');
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(pages, []);
});

it('a real error in an API route → 500 server_error, and it PAGES', async (s) => {
  const r = await send(s, 'POST', '/api/boom', '{}');
  assert.strictEqual(r.status, 500);
  assert.deepStrictEqual(JSON.parse(r.body), { error: 'server_error' });
  assert.deepStrictEqual(pages, ['db exploded']);
});

it('a real error on a page route → 500 text, and it PAGES', async (s) => {
  const r = await send(s, 'GET', '/page-boom');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body, 'Server error');
  assert.deepStrictEqual(pages, ['render exploded']);
});

it('the handler keeps four parameters (express needs the arity)', async () => {
  assert.strictEqual(routeErrorHandler({ page() {} }).length, 4);
});

it('clientErrorStatus: only 4xx counts', async () => {
  assert.strictEqual(clientErrorStatus({ status: 400 }), 400);
  assert.strictEqual(clientErrorStatus({ statusCode: 415 }), 415);
  assert.strictEqual(clientErrorStatus({ status: 500 }), 0);
  assert.strictEqual(clientErrorStatus({ status: 503 }), 0);
  assert.strictEqual(clientErrorStatus(new Error('x')), 0);
  assert.strictEqual(clientErrorStatus(null), 0);
  assert.strictEqual(clientErrorStatus('boom'), 0);
});

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  for (const [name, fn] of cases) {
    pages = [];
    try { await fn(server); quiet.warn.call(console, `  ✓ ${name}`); }
    catch (e) { failed++; quiet.error.call(console, `  ✗ ${name}\n    ${e.message}`); }
  }
  server.close();
  console.warn = quiet.warn; console.error = quiet.error;
  console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
