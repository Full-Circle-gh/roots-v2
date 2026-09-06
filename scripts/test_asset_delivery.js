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
 * Sections 1-4 drive the handler directly with request objects: what is being
 * checked there is the RULE — which files it touches, which it leaves alone, and
 * what headers each one carries. Section 5 then mounts it in express behind the
 * static server it sits in front of and fetches over TCP, because a
 * Content-Length that disagrees with the body does not fail a fake response
 * object — it hangs a real client.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { assetHandler, negotiate } = require('../lib/static-assets');

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
  is(r.headers['content-encoding'], 'br',
    'and compressed as BROTLI — a browser offering both gets the better one');
  const raw = fs.statSync(path.join(ROOT, 'public/retail-admin/04-orders.js')).size;
  yes(r.body.length < raw / 3,
    `and it is at least three times smaller (${Math.round(raw / 1024)}KB → ${Math.round(r.body.length / 1024)}KB)`);
  is(r.headers['content-length'], r.body.length, 'the length header describes what was actually sent');
  yes(zlib.brotliDecompressSync(r.body).length === raw, 'and it decompresses back to the file, byte for byte');
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
    'a client that can take no encoding is sent the file as it is, not a broken one');
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

// ── §4b · which encoding, and the cache behind it ─────────────────────────
section('4b · content negotiation, and the two caches that must not cross');

/* THE HEADER IS READ, NOT PATTERN-MATCHED. `q=0` is a refusal — `br;q=0` means
   "do not send me brotli" — and a handler that greps for the token ignores it
   and sends brotli to a client that just said it cannot read it. */
for (const [hdr, want, why] of [
  ['gzip, deflate, br', 'br', 'a modern browser offers both and gets the better one'],
  ['gzip, deflate', 'gzip', 'an older one that cannot take brotli still gets gzip'],
  ['br', 'br', 'brotli alone'],
  ['', 'identity', 'a client that offers nothing is sent the file as it is'],
  [undefined, 'identity', 'and so is one that sends no header at all'],
  ['br;q=0, gzip', 'gzip', 'br;q=0 is a REFUSAL of brotli, not a mild preference for it'],
  ['br;q=0, gzip;q=0', 'identity', '…and refusing both leaves identity'],
  ['gzip;q=0.5, br;q=1.0', 'br', 'explicit q values are accepted, not choked on'],
  ['BR, GZIP', 'br', 'the header is case-insensitive, as the RFC says'],
  ['brotli-x', 'identity', "`br` must not match inside a longer token"],
]) {
  is(negotiate(hdr), want, `${JSON.stringify(hdr)} → ${want} — ${why}`);
}

/* THE CACHE IS KEYED ON THE ENCODING TOO. With one key per file, the gzip and
   brotli copies overwrite each other, and the next client is handed the other
   one's bytes under its own Content-Encoding — a corrupt page, not a slow one.
   Fetched in both orders because a bug like this only shows on the second. */
{
  const file = '/retail-admin/23-sku.js';
  const raw = fs.readFileSync(path.join(ROOT, 'public/retail-admin/23-sku.js'));
  for (const order of [['gzip', 'br'], ['br', 'gzip']]) {
    for (const enc of order) {
      const r = get(file, { headers: { 'accept-encoding': enc }, query: { v: 'k' } });
      is(r.headers['content-encoding'], enc, `${enc} after ${order[0]} is still ${enc}`);
      // CAUGHT, NOT THROWN. Handed the wrong encoding's bytes, the decoder
      // raises Z_DATA_ERROR and takes the process with it — no tally, no
      // remaining checks, and nothing for the runner to lift into CI but a
      // stack. The failure this exists to catch must READ as a failure.
      let back = null; let why = '';
      try {
        back = enc === 'br' ? zlib.brotliDecompressSync(r.body) : zlib.gunzipSync(r.body);
      } catch (e) { why = `${enc} body would not decode as ${enc}: ${e.code || e.message}`; }
      yes(back && back.equals(raw),
        `…and decodes to the real file, not the other encoding's bytes`,
        why || 'decoded, but to something that is not the file');
    }
  }
}

// ── §5 · over a real socket ───────────────────────────────────────────────
// The sections above drive the handler directly, which checks the rule. This
// one runs it inside express, behind the same static server it sits in front
// of, and fetches over TCP — because a Content-Length that disagrees with the
// body does not fail a fake response object, it hangs a real client.
section('5 · mounted, and fetched');
{
  const express = require('express');
  const app = express();
  app.use('/assets', assetHandler({ root: path.join(ROOT, 'public') }));
  app.use('/assets', express.static(path.join(ROOT, 'public')));
  const srv = app.listen(0);
  const base = () => 'http://127.0.0.1:' + srv.address().port;

  (async () => {
    const raw = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
    // NODE'S OWN fetch ADVERTISES `gzip, deflate` AND NOT `br`, so the default
    // request here exercises the gzip path — which is worth having, because it
    // is also what every non-browser client in this repo looks like. The brotli
    // path is asked for explicitly below rather than assumed from the client.
    let r = await fetch(base() + '/assets/retail-admin/01-core.js?v=abc');
    is(r.status, 200, 'a stamped file is served');
    is(r.headers.get('content-encoding'), 'gzip',
      "a client advertising only gzip gets gzip — Node's fetch is one");
    is(await r.text(), raw, 'and what arrives is the file, exactly — the round trip is lossless');

    r = await fetch(base() + '/assets/retail-admin/01-core.js?v=abc',
      { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    is(r.headers.get('content-encoding'), 'br', 'a browser-shaped client gets brotli');
    is(await r.text(), raw,
      '…and decodes to the same file — undici decompresses br, so a wrong body would be caught here');
    is(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'cached for a year');

    const et = r.headers.get('etag');
    r = await fetch(base() + '/assets/retail-admin/01-core.js?v=abc', { headers: { 'If-None-Match': et } });
    is(r.status, 304, 'and the second visit is a 304 over the wire, not just in a fake');

    r = await fetch(base() + '/assets/retail-admin.css');
    is(r.status, 200, 'the stylesheet is served');
    is(r.headers.get('cache-control'), 'public, max-age=300', 'on the short lifetime, being unstamped');

    r = await fetch(base() + '/assets/does-not-exist.js');
    is(r.status, 404, 'a missing file reaches the static server behind and 404s there');

    r = await fetch(base() + '/assets/retail-admin/01-core.js', { method: 'HEAD' });
    is(r.status, 200, 'HEAD answers');
    yes(Number(r.headers.get('content-length')) > 0, 'with a length, and no body');

    srv.close();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })();
}
