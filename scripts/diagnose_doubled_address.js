#!/usr/bin/env node
/**
 * Diagnose DOUBLED-REGION addresses (read-only).
 *
 * Context: before the municipality de-dup fix (normalizeChinaAddress, commit
 * 04f803b), a Chinese address pasted/typed into the street field could keep its
 * own province/city/district, so the order's `address_full` doubled the region:
 *
 *     北京 北京市 朝阳区 市朝阳区麦子店街道朝阳公园西路17号       (order #198 family)
 *      ^prov ^city ^dist  ^^^^^^^^^^^^^^ region repeated inside the street
 *
 * The fix de-dups on the NEXT save, so existing rows stay dirty until re-saved
 * (or fixed with the admin "Edit ship-to" button). This script finds them.
 *
 * It flags two independent things per row:
 *   • street_embeds_region — the street field STILL begins with one of the
 *     row's own province/city/district values (the root cause). This is what a
 *     re-save would clean.
 *   • full_has_repeat     — the rendered address_full repeats a region token
 *     (what the operator actually SEES doubled). Catches legacy shapes the
 *     de-dup can't fully peel (e.g. a stray leading '市').
 *
 * READ-ONLY. Changes nothing. Run ON THE SERVER against data/roots.db:
 *   node scripts/diagnose_doubled_address.js
 *   node scripts/diagnose_doubled_address.js --verbose      # print every hit
 *   node scripts/diagnose_doubled_address.js --limit 40
 */
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const LIMIT = parseInt(flag('--limit', '60'), 10);

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true });

// ── Mirror of normalizeChinaAddress's de-dup (longest-first, looped) ──────
// We only need the strip step to answer "does the street still embed region?".
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function stripRegionFromStreet(province, city, district, address) {
  if (!address) return '';
  const variants = [province, city, district]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let stripped = String(address).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of variants) {
      const re = new RegExp('^\\s*' + escapeRe(v) + '\\s*', 'i');
      if (re.test(stripped)) { stripped = stripped.replace(re, ''); changed = true; }
    }
  }
  return stripped.trim();
}

// A region token is "repeated" in address_full if any of province/city/district
// appears at least twice in the concatenated string.
function fullHasRepeat(province, city, district, full) {
  // Token equality on the rendered string, NOT substring — otherwise a clean
  // municipality ('北京 北京市 …') false-flags because '北京' is a substring of
  // '北京市'. We also fold the freeform tail into its own bucket: only a region
  // token appearing as its OWN space-delimited token twice counts as doubled.
  const toks = String(full || '').split(/\s+/).filter(Boolean);
  for (const v of [province, city, district].filter(Boolean)) {
    if (toks.filter(t => t === v).length >= 2) return v;
  }
  // Also catch a region glued INSIDE the street tail (no space), e.g.
  // '… 朝阳区 市朝阳区麦子店…' — the district appears a second time mid-token.
  const tail = toks.slice(3).join(' ');
  for (const v of [city, district].filter(Boolean)) {
    if (tail.indexOf(v) !== -1) return v;
  }
  return null;
}

function analyzeAddress(province, city, district, address, detail) {
  const stripped = stripRegionFromStreet(province, city, district, address);
  const street_embeds_region = !!address && stripped !== String(address).trim();
  const full = [province, city, district, address, detail].filter(Boolean).join(' ');
  const repeat = fullHasRepeat(province, city, district, full);
  return { stripped, street_embeds_region, full, repeat, full_has_repeat: !!repeat };
}

// ── 1) Saved address book (retail_customer_addresses) ────────────────────
const savedRows = db.prepare(
  `SELECT id, customer_id, recipient_name, province, city, district, address, detail
     FROM retail_customer_addresses`
).all();

const savedHits = [];
for (const r of savedRows) {
  const a = analyzeAddress(r.province, r.city, r.district, r.address, r.detail);
  if (a.street_embeds_region || a.full_has_repeat) savedHits.push({ r, a });
}

// ── 2) Placed orders (retail_orders) — the snapshot operators see ─────────
// Prefer the structured address_json when present; fall back to splitting
// address_full. Pickup orders carry no shipping region — skip them.
const orderRows = db.prepare(
  `SELECT id, order_no, status, fulfillment_type, recipient_name,
          address_full, address_json
     FROM retail_orders
    WHERE COALESCE(fulfillment_type, 'delivery') <> 'pickup'`
).all();

const orderHits = [];
for (const r of orderRows) {
  let j = {};
  try { j = JSON.parse(r.address_json || '{}'); } catch {}
  if (j.pickup) continue;
  const province = j.province || null, city = j.city || null,
        district = j.district || null, address = j.address || null,
        detail = j.detail || null;
  // With structured parts: run the real analysis. Without them (legacy rows
  // that only have address_full): just scan the rendered string for a repeat
  // of any whitespace-split token of length >= 2 that ends in 市/区/县/省.
  let hit = null;
  if (address || province || city || district) {
    const a = analyzeAddress(province, city, district, address, detail);
    if (a.street_embeds_region || a.full_has_repeat) hit = { kind: 'json', a };
  } else if (r.address_full) {
    const toks = String(r.address_full).trim().split(/\s+/);
    const seen = new Map();
    for (const t of toks) {
      if (/[省市区县]$/.test(t) && t.length >= 2) seen.set(t, (seen.get(t) || 0) + 1);
    }
    const dup = [...seen.entries()].find(([, n]) => n >= 2);
    if (dup) hit = { kind: 'fullonly', a: { full: r.address_full, repeat: dup[0] } };
  }
  if (hit) orderHits.push({ r, ...hit });
}

// ── Report ───────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(' DOUBLED-REGION ADDRESS DIAGNOSTIC  (read-only)');
console.log('══════════════════════════════════════════════════════════════');

console.log(`\nSaved addresses scanned: ${savedRows.length}`);
console.log(`  flagged: ${savedHits.length}` +
  `  (street still embeds region: ${savedHits.filter(h => h.a.street_embeds_region).length},` +
  ` full repeats a token: ${savedHits.filter(h => h.a.full_has_repeat).length})`);

console.log(`\nDelivery orders scanned: ${orderRows.length}`);
console.log(`  flagged: ${orderHits.length}` +
  `  (from address_json: ${orderHits.filter(h => h.kind === 'json').length},` +
  ` legacy full-only: ${orderHits.filter(h => h.kind === 'fullonly').length})`);

if (VERBOSE || savedHits.length) {
  console.log('\n── Saved addresses (top ' + Math.min(LIMIT, savedHits.length) + ') ──');
  for (const { r, a } of savedHits.slice(0, LIMIT)) {
    const tags = [
      a.street_embeds_region ? 'STREET-EMBEDS' : '',
      a.full_has_repeat ? `FULL-REPEAT(${a.repeat})` : '',
    ].filter(Boolean).join(' ');
    console.log(`  addr #${r.id} cust #${r.customer_id} ${r.recipient_name || ''}  [${tags}]`);
    console.log(`     full now : ${a.full}`);
    if (a.street_embeds_region) {
      console.log(`     street   : ${r.address}`);
      console.log(`     → cleans : ${[r.province, r.city, r.district, a.stripped, r.detail].filter(Boolean).join(' ')}`);
    }
  }
}

if (VERBOSE || orderHits.length) {
  console.log('\n── Orders (top ' + Math.min(LIMIT, orderHits.length) + ') ──');
  for (const { r, kind, a } of orderHits.slice(0, LIMIT)) {
    const tag = kind === 'json'
      ? [a.street_embeds_region ? 'STREET-EMBEDS' : '', a.full_has_repeat ? `FULL-REPEAT(${a.repeat})` : ''].filter(Boolean).join(' ')
      : `LEGACY FULL-REPEAT(${a.repeat})`;
    console.log(`  order #${r.id} ${r.order_no || ''} [${r.status}] ${r.recipient_name || ''}  [${tag}]`);
    console.log(`     full : ${a.full}`);
    if (kind === 'json' && a.street_embeds_region) {
      console.log(`     → re-save would clean the street to: ${a.stripped}`);
    }
  }
}

console.log('\nNote: saved-address rows self-heal on the customer/operator\'s next');
console.log('save. Order snapshots do NOT — fix those with the admin "Edit ship-to"');
console.log('button, or a dedicated backfill (not this script).\n');
