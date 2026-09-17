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
 * writes to eleme_sync_log — 'order_shape' and, since the deep capture shipped,
 * 'order_shape_deep' — both produced by shapeDigest(), which keeps key names and
 * strips every value. No request to Eleme, no new column, no behaviour change.
 *
 * IT READS THE REAL LISTS. lib/eleme-browser.js exports CANDIDATE_KEYS for this
 * script rather than the script holding a copy: a copy drifts within a release
 * and then reports confidently on a list the parser no longer uses, which is a
 * worse failure than no audit.
 *
 * WHAT A MISS DOES AND DOES NOT MEAN. The deep digest reaches twelve levels and
 * 300 keys per object; the shallow one stops at four and forty. A key past
 * whichever was recorded is invisible here and still real, so the table prints
 * which shapes are deep and which caps were hit, and a miss is weighed against
 * them rather than read as a verdict. A list that MATCHES is settled either way.
 *
 * AND A MISS IS NOT A FAULT WHEN A PATH COVERS IT. Eight lists have a companion
 * *_PATHS constant that is what actually reads the field — INCOME_KEYS misses,
 * settlementInfo.expectedIncomeInfo.total hits, and the income is correct. The
 * first run of this audit called fourteen lists faulty without knowing that.
 * CANDIDATE_PATHS travels with the key lists now and the verdict column says
 * which is which.
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
let CANDIDATE_KEYS, CANDIDATE_PATHS;
try {
  ({ CANDIDATE_KEYS, CANDIDATE_PATHS } = require((process.env.ROOTS_HOME || '..') + '/lib/eleme-browser'));
} catch (e) {
  ({ CANDIDATE_KEYS, CANDIDATE_PATHS } = require('../lib/eleme-browser'));
}
if (!CANDIDATE_KEYS) {
  console.error('FATAL: lib/eleme-browser.js exports no CANDIDATE_KEYS. Nothing to audit.');
  process.exit(2);
}
CANDIDATE_PATHS = CANDIDATE_PATHS || {};

const CJK = /[一-鿿㐀-䶿]/;
const LONG_DIGITS = /\d{6,}/;
const safe = t => !CJK.test(t) && !LONG_DIGITS.test(t);

/* THE DEEP DIGEST WHERE THERE IS ONE. The shallow artefact stops at depth 4 and
   4000 chars, and the first run of this audit could not tell a list that guessed
   wrong from one whose field simply sat past the cut — the item-row keys are four
   levels down inside items[] and were invisible for that reason alone. The deep
   capture is the same payload recorded wider in the same pass. Both are read, the
   deep one preferred per store×kind, so this keeps working on a tenant whose
   daemon has not restarted since the deep capture shipped. */
const rows = db.prepare(`
  SELECT store_code, event_type, detail, created_at
    FROM eleme_sync_log
   WHERE event_type IN ('order_shape', 'order_shape_deep')
   ORDER BY created_at ASC`).all();

if (!rows.length) {
  console.log('No order_shape rows in eleme_sync_log — nothing to audit against.');
  console.log('logOrderShapes() records once per process per store; a daemon restart');
  console.log('plus one live Eleme order is all it needs.');
  process.exit(0);
}

/* One digest per store×kind, the deep one winning over the shallow, then unioned:
   a key seen in ANY payload is a key the parser can meet, and the lists are read
   against all three kinds. */
const best = new Map();
for (const r of rows) {
  let d;
  try { d = JSON.parse(r.detail); } catch (e) { continue; }
  if (!d || typeof d.digest !== 'string') continue;
  const key = `${r.store_code}:${d.kind}`;
  const deep = r.event_type === 'order_shape_deep';
  const prev = best.get(key);
  if (!prev || (deep && !prev.deep)) best.set(key, { key, deep, digest: d.digest });
}

const real = new Set();
const caps = { truncated: [], depth: [] };
let deepCount = 0;
for (const b of best.values()) {
  if (b.deep) deepCount++;
  // The shallow cap is 4000; the deep one is 200000. Either tells us the tail
  // is missing, and only a digest at its own ceiling is truncated.
  if (b.digest.length >= (b.deep ? 200000 : 4000)) caps.truncated.push(b.key);
  if (b.digest.includes('{...}')) caps.depth.push(b.key);
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(b.digest)) !== null) if (safe(m[1])) real.add(m[1]);
}
const kinds = best.size;

console.log(`${rows.length} shape row(s) → ${kinds} store×kind, ${deepCount} of them DEEP, ${real.size} distinct real key name(s)`);
if (deepCount < kinds) {
  console.log(`⚠ ${kinds - deepCount} shape(s) are the shallow capture only — their daemon has not restarted since`);
  console.log('  the deep capture shipped. A miss on those is weaker evidence than a miss on a deep one.');
}
if (caps.truncated.length) console.log(`⚠ hit the 4000-char cap: ${[...new Set(caps.truncated)].join(', ')} — their tails are NOT in this union`);
if (caps.depth.length) console.log(`⚠ stopped at depth 4: ${[...new Set(caps.depth)].join(', ')} — deeper keys are NOT in this union`);
console.log('');

const names = Object.keys(CANDIDATE_KEYS).sort();
const width = Math.max(...names.map(n => n.length));
const misses = [];
const coveredByPath = [];

console.log('list'.padEnd(width) + '  matched / total  verdict      keys the payload actually has');
console.log('─'.repeat(width) + '  ───────────────  ───────────  ' + '─'.repeat(40));
for (const name of names) {
  const list = CANDIDATE_KEYS[name];
  const hit = list.filter(k => real.has(k));
  /* A LIST WHOSE FIELD IS READ BY A PATH IS NOT A FAULT WHEN ITS KEYS MISS.
     INCOME_KEYS matches nothing and settlementInfo.expectedIncomeInfo.total
     hits, and the income is read correctly — reporting that as a bug sends
     somebody after a field that was never broken. The first run of this audit
     called fourteen lists faulty; several were this. */
  const paths = CANDIDATE_PATHS[name] || [];
  const verdict = hit.length ? 'ok'
    : paths.length ? 'path covers'
    : 'NOTHING';
  if (!hit.length && paths.length) coveredByPath.push(name);
  if (!hit.length && !paths.length) misses.push(name);
  console.log(
    name.padEnd(width)
    + '  ' + String(hit.length).padStart(7) + ' / ' + String(list.length).padEnd(4)
    + '  ' + verdict.padEnd(11)
    + '  ' + (hit.length ? hit.join(', ') : (paths.length ? paths.join(', ') : '— nothing —')));
}

console.log('');
console.log('────────────────────────────────────────────────────────────');
if (coveredByPath.length) {
  console.log(`${coveredByPath.length} list(s) miss on keys but are read by a path — not faults:`);
  console.log('  ' + coveredByPath.join(', '));
  console.log('');
}
if (!misses.length) {
  console.log('Every candidate list either matches a real key or is read by a path.');
  console.log('Nothing to chase.');
} else {
  console.log(`${misses.length} list(s) match NOTHING and have no path behind them:`);
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
