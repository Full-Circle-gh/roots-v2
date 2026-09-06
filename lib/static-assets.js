// Serving the admin's JavaScript (audit J-03).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// The admin shell is about a megabyte of JavaScript across 23 files, and every
// screen's code is loaded on every visit. That is the finding. It was going out
// UNCOMPRESSED — nginx in front does not gzip, and server.js's own compression
// wraps res.json only, so the API is compressed and the code that calls it is
// not — and with no cache lifetime, so a browser revalidated all 23 files on
// every single load even when nothing had changed.
//
// ── WHAT THIS DOES, AND WHAT IT DOES NOT ──────────────────────────────────
// It compresses, and it lets a versioned file be cached properly. That is a
// ~3.4× cut on the wire and, between deploys, no request at all — without
// moving a line of admin code.
//
// (This said "~5×" until 2026-09-06, when it was measured rather than
// estimated: the 28 admin parts are 3,410 KB raw and 994 KB brotli'd. The
// direction was right and the number was not.)
//
// It does NOT load a section's code on demand, which is the audit's suggested
// direction and remains the right one. The 23 parts share ONE global scope and
// call each other's functions by name; there is no module boundary to load
// across, and a half-done version of it is a screen that opens on a
// ReferenceError. That is a refactor with its own plan, and it is worth doing
// AFTER this, because this is what makes the current shape survivable in the
// meantime.
//
// ── WHY CACHING HARD IS SAFE HERE ─────────────────────────────────────────
// server.js stamps every asset URL with a per-process version (`?v=`) and
// serves the shell HTML no-store, so a deploy mints new URLs and the browser
// fetches them. A stamped URL therefore names a file that CANNOT change, which
// is exactly what `immutable` means. Anything unstamped keeps a short lifetime,
// because there is no version in the URL to invalidate it with.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// One compressed copy per file PER ENCODING per process, keyed on the file's
// identity (mtime + size) so an edit on disk is picked up without a restart in
// development. Level 6 is the default trade: level 9 costs several times the
// CPU for about 1% more, once, on a file this size.
const CACHE = new Map();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let cacheBytes = 0;

const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ── WHY BROTLI QUALITY 6 AND NOT 11 ───────────────────────────────────────
// Measured over the 28 admin parts (3,410 KB raw) on 2026-09-06:
//
//   gzip 6      1092 KB   3.12x     3 ms/file
//   brotli 5    1006 KB   3.39x     3 ms/file
//   brotli 6     994 KB   3.43x     3 ms/file
//   brotli 9     969 KB   3.52x    17 ms/file
//   brotli 11    884 KB   3.86x   147 ms/file
//
// So q6 is 98 KB better than gzip for the same CPU, and q11 is a further 110 KB
// for FIFTY TIMES the CPU.
//
// THE CPU IS WHAT DECIDES IT, AND NOT BECAUSE IT IS SLOW. zlib's *Sync calls
// block the event loop, and this is one process serving every surface. The
// cache means each file is compressed once per deploy — but that once lands on
// whoever loads the admin first after a deploy, and at q11 that is ~4 seconds
// of blocked loop across 28 files, during which every order, every till read
// and every API call from every other operator waits. A 110 KB saving is not
// worth a four-second stall on the whole shop.
//
// q6 costs ~94 ms in total for the same set, which is the same order as the
// gzip it replaces.
const BROTLI_QUALITY = 6;

// The encodings this handler will produce, best first. Order is preference:
// the first one the client accepts is the one it gets.
const ENCODINGS = ['br', 'gzip'];

function compress(raw, enc) {
  return enc === 'br'
    ? zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        // Telling brotli the size up front lets it size its window properly.
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
    : zlib.gzipSync(raw, { level: 6 });
}

function compressed(abs, st, enc) {
  // KEYED ON THE ENCODING TOO. With one key per file, a client asking for gzip
  // and one asking for br would take turns overwriting each other's entry —
  // and because the freshness check is mtime + size, which are the SAME file
  // either way, the stale check passes and the second client is handed the
  // first one's bytes under its own Content-Encoding. That is not a slow page,
  // it is a corrupt one.
  //
  // The encoding goes FIRST so the key cannot be ambiguous: `enc` comes from
  // ENCODINGS, which holds no spaces, so `br /a/b` and `gzip /a/b` cannot
  // collide however odd the path is.
  const key = enc + ' ' + abs;
  const hit = CACHE.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.buf;
  const buf = compress(fs.readFileSync(abs), enc);
  // A ceiling rather than an unbounded map: this is a cache, and a cache that
  // can grow without limit is a memory leak with a good reputation.
  if (cacheBytes + buf.length > MAX_CACHE_BYTES) { CACHE.clear(); cacheBytes = 0; }
  if (hit) cacheBytes -= hit.buf.length;
  CACHE.set(key, { mtimeMs: st.mtimeMs, size: st.size, buf });
  cacheBytes += buf.length;
  return buf;
}

/**
 * The best encoding this handler can produce that the client actually accepts.
 *
 * `identity` (no compression) when it accepts none of them. A `q=0` is a
 * REFUSAL, not a low preference — `br;q=0` means "do not send me brotli" — and
 * honouring it is the difference between a header being read and being
 * pattern-matched.
 */
function negotiate(header) {
  const h = String(header || '').toLowerCase();
  for (const enc of ENCODINGS) {
    // (?![a-z0-9-]) so `br` does not match inside a longer token. There is no
    // real encoding called `brotli`, but a token this short matching a prefix
    // is the kind of thing that is only ever found the hard way.
    const m = new RegExp('(?:^|,)\\s*' + enc + '(?![a-z0-9-])\\s*(?:;\\s*q=([0-9.]+))?').exec(h);
    if (m && Number(m[1] === undefined ? 1 : m[1]) > 0) return enc;
  }
  return 'identity';
}

/**
 * Middleware for /assets/**.js and /assets/**.css.
 *
 * Anything else — an image, a font, a file that is not there — falls through to
 * the static server behind it, untouched. Already-compressed formats must never
 * be re-gzipped, and this deliberately never sees them.
 */
function assetHandler(opts) {
  const root = path.resolve(opts.root);
  return function serveAsset(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path || ''); } catch (e) { return next(); }
    const ext = path.extname(rel).toLowerCase();
    if (!TYPES[ext]) return next();

    // Resolve, then check the result is still inside the root. `path.join`
    // normalises `..` away, and checking AFTER resolution is the only version
    // of this check that cannot be walked out of.
    const abs = path.resolve(path.join(root, rel));
    if (abs !== root && !abs.startsWith(root + path.sep)) return next();

    let st;
    try { st = fs.statSync(abs); } catch (e) { return next(); }
    if (!st.isFile()) return next();

    // A stamped URL names a file that cannot change — that is what the stamp is
    // for — so it is cached for a year and never revalidated. Without one there
    // is nothing to invalidate a long cache with, so it stays short.
    const versioned = !!(req.query && req.query.v);
    res.setHeader('Cache-Control', versioned
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300');
    res.setHeader('Content-Type', TYPES[ext]);
    res.setHeader('Vary', 'Accept-Encoding');

    // A weak ETag on identity + size. Weak because the compressed and
    // uncompressed bodies of the same file are the same RESOURCE, and a strong
    // tag would be claiming they are byte-identical, which they are not.
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(/\s*,\s*/).some((t) => t === etag || t === etag.replace(/^W\//, ''))) {
      res.statusCode = 304;
      return res.end();
    }

    const enc = negotiate(req.headers['accept-encoding']);
    let body;
    if (enc !== 'identity') {
      try {
        body = compressed(abs, st, enc);
        res.setHeader('Content-Encoding', enc);
      } catch (e) {
        // Compression failing is not a reason to fail the request; the browser
        // is perfectly able to read the file as it is.
        body = null;
      }
    }
    if (!body) {
      try { body = fs.readFileSync(abs); } catch (e) { return next(); }
      res.removeHeader('Content-Encoding');
    }
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

module.exports = { assetHandler, TYPES, negotiate, ENCODINGS, BROTLI_QUALITY };
