#!/usr/bin/env node
/**
 * test_asset_delivery.js — what the admin costs on the wire (audit J-03).
 *
 *   node scripts/test_asset_delivery.js
 *
 * THE FINDING. The admin shell is about a megabyte of JavaScript across 23
 * files and every screen's code is loaded on every visit. Two things made that
 * cost more than it had to:
 *
 *   - it went out UNCOMPRESSED. nginx in front does not gzip, and server.js's
 *     own compression wraps res.json only — so the API was compressed and the
 *     code that calls it was not.
 *   - it had no cache lifetime, so a browser revalidated all 23 files on every
 *     load even when nothing had changed.
 *
 * WHAT IS NOT FIXED, and is checked here so it stays visible: the code is still
 * all loaded on every visit. Loading a section on demand is the audit's
 * suggested direction and remains right; the 23 parts share one global scope
 * and call each other by name, so there is no boundary to load across yet.
 *
 * The handler is driven directly with request objects rather than over a
 * socket: what is being checked is the headers and the bytes, and a real server
 * would add a port and a race without adding a fact.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { assetHandler } = require('../lib/static-assets');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const handler = assetHandler({ root: path.join(ROOT, 'public') });

// A request and a response, as much as this handler touches.
function get(p, { gzip = true, headers = {}, method = 'GET', query = {} } = {}) {
  const out = { headers: {}, status: 200, body: null, nexted: false };
  const req = {
    method, path: p, query,
    headers: { ...(gzip ? { 'accept-encoding': 'gzip, deflate, br' } : {}), ...headers },
  };
  const res = {
    set statusCode(v) { out.status = v; }, get statusCode() { return out.status; },
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    getHeader: (k) => out.headers[k.toLowerCase()],
    removeHeader: (k) => { delete out.headers[k.toLowerCase()]; },
    end: (b) => { out.body = b == null ? Buffer.alloc(0) : b; },
  };
  handler(req, res, () => { out.nexted = true; });
  return out;
}

// ── §1 · the size on the wire ─────────────────────────────────────────────
section('1 · the admin is compressed on the way out');
{
  const r = get('/retail-admin/04-orders.js', { query: { v: 'abc' } });
  yes(!r.nexted, 'the biggest file is served by this handler');
  is(r.headers['content-encoding'], 'gzip', 'and compressed');
  const raw = fs.statSync(path.join(ROOT, 'public/retail-admin/04-orders.js')).size;
  yes(r.body.length < raw / 3,
    `and it is at least three times smaller (${Math.round(raw / 1024)}KB → ${Math.round(r.body.length / 1024)}KB)`);
  is(r.headers['content-length'], r.body.length, 'the length header describes what was actually sent');
  yes(zlib.gunzipSync(r.body).length === raw, 'and it uncompresses back to the file, byte for byte');
}
{
  // The whole admin, measured. This is the number the finding is about.
  const dir = path.join(ROOT, 'public/retail-admin');
  let raw = 0, gz = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    raw += fs.statSync(path.join(dir, f)).size;
    gz += get('/retail-admin/' + f, { query: { v: 'x' } }).body.length;
  }
  yes(gz < raw / 3,
    `the whole shell drops from ${Math.round(raw / 1024)}KB to ${Math.round(gz / 1024)}KB on the wire`);
}
{
  const r = get('/retail-admin/04-orders.js', { gzip: false });
  is(r.headers['content-encoding'], undefined,
    'a client that cannot take gzip is sent the file as it is, not a broken one');
  yes(r.body.length > 0, 'and gets the whole of it');
  is(r.headers['vary'], 'Accept-Encoding', 'with Vary set, so a cache never serves one to the other');
}

// ── §2 · the second visit ─────────────────────────────────────────────────
section('2 · a file that cannot change is not fetched twice');
{
  const stamped = get('/retail-admin/01-core.js', { query: { v: 'k3f9' } });
  is(stamped.headers['cache-control'], 'public, max-age=31536000, immutable',
    'a version-stamped URL names a file that cannot change, and is cached as one');
  const plain = get('/retail-admin/01-core.js');
  is(plain.headers['cache-control'], 'public, max-age=300',
    'an unstamped one is not — there would be nothing to invalidate it with');
}
{
  const first = get('/retail-admin/01-core.js', { query: { v: 'k3f9' } });
  const etag = first.headers.etag;
  yes(/^W\//.test(etag), 'the tag is weak: the gzipped and plain bodies are one resource, not one string');
  const again = get('/retail-admin/01-core.js', { query: { v: 'k3f9' }, headers: { 'if-none-match': etag } });
  is(again.status, 304, 'and an unchanged file comes back as "not changed"');
  is(again.body.length, 0, 'with no body at all');
}

// ── §3 · what it refuses to touch ─────────────────────────────────────────
section('3 · everything else is left to the static server');
{
  is(get('/retail-admin.css').nexted, false, 'stylesheets go through it too');
  yes(get('/logo.png').nexted, 'an image does not — an already-compressed file must never be re-gzipped');
  yes(get('/retail-admin/does-not-exist.js').nexted, 'a file that is not there falls through to a normal 404');
  yes(get('/../server.js').nexted, 'and a path that climbs out of the folder is refused');
  yes(get('/retail-admin/../../server.js').nexted, 'however it is written');
  yes(get('/retail-admin/01-core.js', { method: 'POST' }).nexted, 'a POST is not this handler’s business');
}
{
  const head = get('/retail-admin/01-core.js', { method: 'HEAD', query: { v: 'x' } });
  yes(head.body.length === 0 && head.headers['content-length'] > 0,
    'a HEAD gets the headers and no body');
}

// ── §4 · what has NOT been fixed ──────────────────────────────────────────
section('4 · the part of the finding that is still open');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  const tags = (html.match(/<script src="\/assets\/retail-admin\/\d\d-[^"]+"><\/script>/g) || []).length;
  yes(tags >= 20, `every part is still loaded up front (${tags} of them)`);
  const lib = fs.readFileSync(path.join(ROOT, 'lib/static-assets.js'), 'utf8');
  yes(/does NOT load a section's code on demand/.test(lib),
    'which is written down as the open half, not left to be discovered');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
