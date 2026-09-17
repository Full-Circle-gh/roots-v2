#!/usr/bin/env node
/**
 * Which of lib/eleme-browser.js's candidate key lists match Eleme's real payload,
 * and which have never matched anything?
 *
 * WHY. Every list in that file was written blind — the recon (ELEME_BROWSER_RECON.md)
 * got the RPC method names and nothing else, so each is a spread of plausible
 * spellings read through an EXACT lookup: pick() does `obj[n]`, no case-folding
 * and no substring. A list that guessed wrong does not degrade, it returns
 * undefined forever, and the field lands null on every order with nothing
 * anywhere saying so.
 *
 * That is not hypothetical. On 2026-09-17 the recorded shape digest was read for
 * the first time and the consignee block came out as consigneeAddress,
 * consigneePhones and consigneeSecretPhones — while ADDRESS_KEYS held five
 * spellings, none of them the real one, and PHONE_KEYS held `consigneePhone`,
 * singular, against a payload that sends the plural. Both parsed null on every
 * Eleme order since the daemon shipped. The suite agreed with the bug because
 * its fixtures were written from the same guesses.
 *
 * Two lists are now known-correct. Twenty-three are still guesses, and this
 * prints which of them the live payload has ever agreed with.
 *
 * NOTHING IS CAPTURED HERE. It reads the digests scripts/eleme-daemon.js already
 * writes to eleme_sync_log (event_type='order_shape'), produced by shapeDigest(),
 * which keeps key names and strips every value. No request to Eleme, no new
 * column, no behaviour change.
 *
 * IT READS THE REAL LISTS. lib/eleme-browser.js exports CANDIDATE_KEYS for this
 * script rather than the script holding a copy: a copy drifts within a release
 * and then reports confidently on a list the parser no longer uses, which is a
 * worse failure than no audit.
 *
 * WHAT A MISS DOES AND DOES NOT MEAN. shapeDigest stops at depth 4, keeps 40 keys
 * per object, and the stored digest is capped at 4000 chars. A key past any of
 * those is invisible here and still real, so a list reported as matching nothing
 * is a STRONG LEAD, not a verdict — the caps that were hit are printed above the
 * table so a miss can be weighed against them. A list that matches is settled.
 *
 * FIELD NAMES ONLY. The digests carry no values by construction; this refuses to
 * print a token carrying CJK or a long digit run rather than trusting that.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_candidate_keys.js
 */
'use strict';

const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH + '\n');

// The parser's own lists. ROOTS_HOME is where ro-query.yml stages lib/ on the
// box; falling back to a relative require keeps the script runnable from a
// checkout.
let CANDIDATE_KEYS;
try {
  ({ CANDIDATE_KEYS } = require((process.env.ROOTS_HOME || '..') + '/lib/eleme-browser'));
} catch (e) {
  ({ CANDIDATE_KEYS } = require('../lib/eleme-browser'));
}
if (!CANDIDATE_KEYS) {
  console.error('FATAL: lib/eleme-browser.js exports no CANDIDATE_KEYS. Nothing to audit.');
  process.exit(2);
}

const CJK = /[一-鿿㐀-䶿]/;
const LONG_DIGITS = /\d{6,}/;
const safe = t => !CJK.test(t) && !LONG_DIGITS.test(t);

const rows = db.prepare(`
  SELECT store_code, detail, created_at
    FROM eleme_sync_log
   WHERE event_type = 'order_shape'
   ORDER BY created_at ASC`).all();

if (!rows.length) {
  console.log('No order_shape rows in eleme_sync_log — nothing to audit against.');
  console.log('logOrderShapes() records once per process per store; a daemon restart');
  console.log('plus one live Eleme order is all it needs.');
  process.exit(0);
}

// Union every recorded shape: a key seen in ANY payload is a key the parser can
// meet, and the lists are read against all three kinds.
const real = new Set();
const caps = { truncated: [], depth: [] };
let kinds = 0;
for (const r of rows) {
  let d;
  try { d = JSON.parse(r.detail); } catch (e) { continue; }
  if (!d || typeof d.digest !== 'string') continue;
  kinds++;
  if (d.digest.length >= 4000) caps.truncated.push(`${r.store_code}:${d.kind}`);
  if (d.digest.includes('{...}')) caps.depth.push(`${r.store_code}:${d.kind}`);
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(d.digest)) !== null) if (safe(m[1])) real.add(m[1]);
}

console.log(`${rows.length} order_shape row(s), ${kinds} digest(s), ${real.size} distinct real key name(s)`);
if (caps.truncated.length) console.log(`⚠ hit the 4000-char cap: ${[...new Set(caps.truncated)].join(', ')} — their tails are NOT in this union`);
if (caps.depth.length) console.log(`⚠ stopped at depth 4: ${[...new Set(caps.depth)].join(', ')} — deeper keys are NOT in this union`);
console.log('');

const names = Object.keys(CANDIDATE_KEYS).sort();
const width = Math.max(...names.map(n => n.length));
const misses = [];

console.log('list'.padEnd(width) + '  matched / total   keys the payload actually has');
console.log('─'.repeat(width) + '  ───────────────   ' + '─'.repeat(40));
for (const name of names) {
  const list = CANDIDATE_KEYS[name];
  const hit = list.filter(k => real.has(k));
  if (!hit.length) misses.push(name);
  console.log(
    name.padEnd(width)
    + '  ' + String(hit.length).padStart(7) + ' / ' + String(list.length).padEnd(5)
    + '   ' + (hit.length ? hit.join(', ') : '— nothing —'));
}

console.log('');
console.log('────────────────────────────────────────────────────────────');
if (!misses.length) {
  console.log('Every candidate list matches at least one real key. Nothing to chase.');
} else {
  console.log(`${misses.length} list(s) match NOTHING in the captured shape:`);
  console.log('  ' + misses.join(', '));
  console.log('');
  console.log('Each is reading a field that is either absent from Eleme\'s payload or');
  console.log('spelled differently — and if it is spelled differently, that field has');
  console.log('been null on every order since the daemon shipped, exactly as');
  console.log('ADDRESS_KEYS and PHONE_KEYS were until 2026-09-17.');
  if (caps.truncated.length || caps.depth.length) {
    console.log('');
    console.log('Weigh those against the caps above before acting: a key past the');
    console.log('4000-char cut or below depth 4 is missing from this union, not from');
    console.log('the payload.');
  }
}
console.log('');
console.log('To fix one: find the real name in the digest, put it at the FRONT of the');
console.log('list, keep the guesses behind it as fallbacks, and add a fixture using');
console.log('the real name to scripts/test_eleme_order_parse.js — section H2 is the');
console.log('worked example. A fixture written from the list it tests proves only');
console.log('that both sides share a guess.');
