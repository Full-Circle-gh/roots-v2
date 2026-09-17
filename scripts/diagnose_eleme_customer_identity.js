#!/usr/bin/env node
/**
 * Does Eleme hand us anything that identifies a customer across their orders?
 *
 * WHY THIS EXISTS. The phone's Trend screen counts buyers with
 * COUNT(DISTINCT customer_id), and routes/eleme-internal.js never writes that
 * column — its INSERT has no customer field of any kind. So every Eleme buyer is
 * invisible to "People bought", "First-time buyers", "Top spender" and retention,
 * while the same orders' money IS in the revenue above them. Meituan is in the
 * same position on paper and is not in practice: lib/meituan-order-fields.js
 * pulls `wmUserId` — "the only stable customer identity Meituan gives a
 * merchant" — plus a 下单 N 次 count, and both have been stored on every order
 * since 2026-09-15.
 *
 * Nobody has ever looked for Eleme's equivalent. That is the finding this script
 * exists to settle, and it is a LOOK, not a guess: lib/eleme-browser.js reads
 * fields by candidate key, and its key lists have never had a user entry —
 * ADDRESS_KEYS, PHONE_KEYS, NOTE_KEYS, item keys, and no USER_KEYS. Absence from
 * our parser is not absence from their payload.
 *
 * NOTHING IS CAPTURED HERE. The artefact already exists in production:
 * scripts/eleme-daemon.js's logOrderShapes() writes the first payload of each
 * kind — list, detail, void — to eleme_sync_log as event_type='order_shape',
 * passed through lib/eleme-browser.js's shapeDigest(), which keeps the key names
 * and strips every value. Its own comment calls it "the one artefact that turns
 * 'we never captured an order' into a five-minute follow-up". This is that
 * follow-up. No request to Eleme, no new column, no behaviour change.
 *
 * WHAT A NEGATIVE RESULT DOES NOT PROVE. shapeDigest stops at depth 4, keeps the
 * first 40 keys of any object, and the stored digest is truncated at 4000 chars.
 * A user id nested deeper, sitting past the fortieth key, or falling off the end
 * of the cap is invisible here and still real. The script reports each of those
 * limits as it hits them, so "no identity field found" can be read as what it is
 * — no identity field found WITHIN THE CAPTURED SHAPE — rather than as proof
 * that Eleme sends none.
 *
 * FIELD NAMES ONLY. The digests hold no values by construction; the script
 * asserts that before printing anything, and refuses to print a token carrying
 * CJK or a long digit run rather than trusting the producer. The Tier 3 rule in
 * scripts/eleme-daemon.js's header applies here as much as anywhere.
 *
 * Every statement is a SELECT, the database is opened read-only, and the
 * connection is PROVEN read-only before anything else runs.
 *
 * Run: Actions → "Read-only prod query" → script = scripts/diagnose_eleme_customer_identity.js
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

// ── What counts as an identity ───────────────────────────────────────────────
// Generous on the key, because the whole point is to find the field nobody
// guessed — a filter built from our existing candidate lists would miss it for
// exactly the reason the parser does. Split in two so the report can say whether
// Eleme gives us a PERSON or only a DELIVERY, which are different answers:
// a masked address identifies a drop-off, a user id identifies a customer.
const PERSON_KEY = /(user|customer|buyer|member|account|uid|openid|unionid|nick|cust)/i;
const CONTACT_KEY = /(phone|mobile|tel|recipient|consignee|receiver|address|addr|poi)/i;
// A repeat count is the other half of the question: Meituan gives 下单 N 次, and
// a label of that shape would answer "returning?" without any id at all.
const REPEAT_KEY = /(ordercount|ordertimes|buycount|times|repeat|history|label|tag|isnew|newuser|olduser|frequen)/i;
// Keys that merely contain one of those words while naming something else.
const NOT_IDENTITY = /^(userremark|usernote|username?Remark)$/i;

// ── Safety: the digest must carry no values ──────────────────────────────────
const CJK = /[一-鿿㐀-䶿]/;
const LONG_DIGITS = /\d{6,}/;
function safe(token) { return !CJK.test(token) && !LONG_DIGITS.test(token); }

// ── Pull the recorded shapes ─────────────────────────────────────────────────
const rows = db.prepare(`
  SELECT store_code, detail, created_at
    FROM eleme_sync_log
   WHERE event_type = 'order_shape'
   ORDER BY created_at ASC`).all();

if (!rows.length) {
  console.log('No order_shape rows in eleme_sync_log.');
  console.log('');
  console.log('That means logOrderShapes() has not run since the daemon last restarted,');
  console.log('or no Eleme order has been polled since. It records once per process per');
  console.log('store, so a restart plus one live order is all it needs. Nothing to fix —');
  console.log('re-run this after the next order lands.');
  process.exit(0);
}

// detail is JSON: { kind, digest }. Group by kind, newest wins per store.
const shapes = new Map();   // `${store}:${kind}` -> { store, kind, digest, at }
let unparsed = 0;
for (const r of rows) {
  let d;
  try { d = JSON.parse(r.detail); } catch (e) { unparsed++; continue; }
  if (!d || !d.kind || typeof d.digest !== 'string') { unparsed++; continue; }
  shapes.set(`${r.store_code}:${d.kind}`, { store: r.store_code, kind: d.kind, digest: d.digest, at: r.created_at });
}

console.log(`${rows.length} order_shape row(s); ${shapes.size} distinct store×kind shape(s)`
  + (unparsed ? `; ${unparsed} unparseable, skipped` : ''));
console.log('');

// ── Walk a digest for its key names ──────────────────────────────────────────
// The digest is shapeDigest()'s own grammar: {key:type,key:{...},key:[{…}xN]}.
// Key names are read with a token scan rather than a parser, because a truncated
// digest is not valid in that grammar and is exactly the case worth reading.
function keysOf(digest) {
  const out = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(digest)) !== null) out.push(m[1]);
  return out;
}

let personHitsTotal = 0;
let repeatHitsTotal = 0;

for (const s of [...shapes.values()].sort((a, b) => (a.store + a.kind).localeCompare(b.store + b.kind))) {
  const keys = keysOf(s.digest);
  const uniq = [...new Set(keys)];
  const person = uniq.filter(k => PERSON_KEY.test(k) && !NOT_IDENTITY.test(k) && safe(k));
  const contact = uniq.filter(k => CONTACT_KEY.test(k) && !PERSON_KEY.test(k) && safe(k));
  const repeat = uniq.filter(k => REPEAT_KEY.test(k) && safe(k));

  personHitsTotal += person.length;
  repeatHitsTotal += repeat.length;

  console.log(`── ${s.store} · ${s.kind} · recorded ${s.at}`);
  console.log(`   ${uniq.length} distinct key name(s), digest ${s.digest.length} chars`);

  // The three caps, each reported where it bites — see the header.
  if (s.digest.length >= 4000) console.log('   ⚠ digest hit the 4000-char cap: the tail of this payload is NOT in here');
  if (s.digest.includes('{...}')) console.log('   ⚠ contains {...}: shapeDigest stopped at depth 4, deeper keys are NOT in here');

  console.log(`   person-identity keys : ${person.length ? person.join(', ') : '(none)'}`);
  console.log(`   repeat/label keys    : ${repeat.length ? repeat.join(', ') : '(none)'}`);
  console.log(`   contact/delivery keys: ${contact.length ? contact.join(', ') : '(none)'}`);
  console.log('');
}

// ── The answer, said plainly ─────────────────────────────────────────────────
console.log('────────────────────────────────────────────────────────────');
if (personHitsTotal > 0) {
  console.log('An identity-shaped key IS present in Eleme\'s payload.');
  console.log('');
  console.log('Next: confirm it is STABLE across that customer\'s orders before counting');
  console.log('anything with it — a per-order token looks identical to a user id in a');
  console.log('shape digest, and Eleme\'s 隐私号 is exactly such a token. Read the same');
  console.log('key on two orders known to share a buyer.');
} else {
  console.log('No identity-shaped key in the captured shape.');
  console.log('');
  console.log('Read that as the captured shape only — the depth-4, 40-key and 4000-char');
  console.log('caps above are real, and any of them can hide one. If none of the warnings');
  console.log('fired, the payload was captured whole and the finding is solid: Eleme gives');
  console.log('a merchant no customer identity, and no Eleme buyer can ever be counted.');
}
if (repeatHitsTotal > 0) {
  console.log('');
  console.log('A repeat/label key is present. Meituan answers "returning?" with a 下单 N 次');
  console.log('label rather than by joining on an id; if Eleme does the same, new-vs-');
  console.log('returning is answerable there even with no identity at all.');
}
console.log('');
console.log('Either way: revenue, products, store and times are unaffected. This decides');
console.log('the customer figures only.');
