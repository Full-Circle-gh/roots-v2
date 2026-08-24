// One-time (re-runnable) bulk product-name matcher for Eleme.
//
// Eleme has no extCode/货号 to match on yet (ELEME_BROWSER_RECON.md), so every
// product resolves by NAME — and a wrong auto-match would push OUR stock
// number onto a DIFFERENT live Eleme listing, which is worse than not pushing
// at all. This stays conservative: it only auto-applies matches it's highly
// confident about (word-order-invariant CJK + Latin containment, tuned
// against the one real mismatch already found live — "Oatly 咖啡大师" vs
// Eleme's actual "咖啡大师 Oatly Barista"), and reports everything else for a
// human to resolve. Many "no match" rows are simply not sold on Eleme at all,
// not errors — 249 products vs a 204-listing catalogue guarantees some gap.
//
// Usage:
//   node scripts/eleme-match-products.js <storeCode> <shopId>            # dry run — report only
//   node scripts/eleme-match-products.js <storeCode> <shopId> --apply    # write eleme_name,
//                                                                        # enable sync, queue a push

'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); } catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { ElemeBrowser } = require('../lib/eleme-browser');
const elemeSync = require('../lib/eleme-sync');

function normCjk(s)   { return (String(s || '').match(/[一-鿿]+/g) || []).join(''); }
function normLatin(s) { return (String(s || '').match(/[A-Za-z]+/g) || []).join('').toLowerCase(); }

// Word-order-invariant: matches "Oatly 咖啡大师" against Eleme's real listing
// "咖啡大师 Oatly Barista" (CJK core identical, just reordered; Latin core is a
// substring either way). Score is a confidence heuristic, not a probability.
function scoreMatch(ours, elemeName) {
  if (!ours || !elemeName) return 0;
  if (String(ours).trim() === String(elemeName).trim()) return 100;
  const oursCjk = normCjk(ours), eCjk = normCjk(elemeName);
  const oursLat = normLatin(ours), eLat = normLatin(elemeName);
  if (oursCjk && eCjk && oursCjk.length >= 2 && (eCjk.includes(oursCjk) || oursCjk.includes(eCjk))) {
    // Guard against a short/generic CJK core matching as a small fragment
    // buried in a much longer, unrelated name — confirmed live: "腰果" (raw
    // cashews) wrongly contained in "纯腰果发酵奶酪" (cashew SOUR CREAM), "杏仁"
    // (almonds) in "杏仁酱" (almond BUTTER), "藜麦" (quinoa) in a quinoa SALAD
    // dish. A generic ingredient name is a substring of every dish that uses
    // it — containment alone isn't enough. Require the two CJK cores to be
    // CLOSE in length (not just one containing the other) before trusting it;
    // this also naturally rejects flavour/size variants that would otherwise
    // all collide onto one generic listing (three almond-butter flavours all
    // wanting the same plain "Almond butter" item).
    const shorter = Math.min(oursCjk.length, eCjk.length);
    const longer  = Math.max(oursCjk.length, eCjk.length);
    if (shorter / longer < 0.85) return 0;
    if (oursLat && eLat && (eLat.includes(oursLat) || oursLat.includes(eLat))) return 95;
    return 80;
  }
  if (oursLat && eLat && oursLat.length >= 4 && (eLat.includes(oursLat) || oursLat.includes(eLat))) return 60;
  return 0;
}

const CONFIDENT = 80; // auto-apply threshold — see scoreMatch

async function main() {
  const storeCode = process.argv[2];
  const shopId    = process.argv[3];
  const apply     = process.argv.includes('--apply');
  if (!storeCode || !shopId) {
    console.error('usage: node scripts/eleme-match-products.js <storeCode> <shopId> [--apply]');
    process.exit(1);
  }

  const store = db.prepare('SELECT id FROM retail_stores WHERE code = ?').get(storeCode);
  if (!store) { console.error(`[match] no store with code ${storeCode}`); process.exit(1); }

  const products = db.prepare(`
    SELECT id, name_cn, name_en, sku FROM store_products WHERE is_active = 1 ORDER BY id
  `).all();
  console.log(`[match] ${products.length} active product(s) to check against the live Eleme catalogue…`);

  const browser = new ElemeBrowser(storeCode, shopId);
  let elemeNames;
  try {
    await browser.init();
    elemeNames = await browser.listFoods();
  } finally {
    await browser.close();
  }
  if (!elemeNames || !elemeNames.length) {
    console.error('[match] could not load the Eleme catalogue (login/verify issue?) — aborting');
    process.exit(1);
  }
  console.log(`[match] ${elemeNames.length} listing(s) on Eleme`);

  const confident = [], review = [], noMatch = [];
  for (const p of products) {
    let best = null, bestScore = 0;
    for (const en of elemeNames) {
      const s = Math.max(scoreMatch(p.name_cn, en), scoreMatch(p.name_en, en));
      if (s > bestScore) { bestScore = s; best = en; }
    }
    if (bestScore >= CONFIDENT) confident.push({ p, match: best, score: bestScore });
    else if (bestScore > 0) review.push({ p, match: best, score: bestScore });
    else noMatch.push(p);
  }

  // Two (or more) of OUR products confidently wanting the SAME Eleme listing
  // means at most one of them is actually right — applying both would have
  // the second push silently overwrite the first's stock number on that
  // listing. Demote the whole group to review rather than guess which one
  // (if either) is correct.
  const byTarget = new Map();
  for (const c of confident) (byTarget.get(c.match) || byTarget.set(c.match, []).get(c.match)).push(c);
  const collided = new Set();
  for (const [target, group] of byTarget) if (group.length > 1) collided.add(target);
  const deduped = [];
  for (const c of confident) {
    if (collided.has(c.match)) review.push({ ...c, collision: true });
    else deduped.push(c);
  }
  confident.length = 0;
  confident.push(...deduped);

  console.log(`\n[match] CONFIDENT (${confident.length}):`);
  for (const c of confident) console.log(`  [${c.score}] "${c.p.name_cn || c.p.name_en}" → "${c.match}"`);

  console.log(`\n[match] NEEDS REVIEW (${review.length}) — ambiguous, NOT auto-applied:`);
  for (const r of review) {
    const tag = r.collision ? ' [COLLISION — another product also confidently wants this listing]' : '';
    console.log(`  [${r.score}] "${r.p.name_cn || r.p.name_en}" → best guess "${r.match}"${tag}`);
  }

  console.log(`\n[match] NO MATCH (${noMatch.length}) — likely not sold on Eleme, or the name is very different:`);
  for (const n of noMatch) console.log(`  "${n.name_cn || n.name_en}"`);

  if (!apply) {
    console.log(`\n[match] dry run — nothing written. Re-run with --apply to write the ${confident.length} confident match(es) and queue their first push.`);
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO eleme_product_map (retail_store_id, product_id, store_code, eleme_name, sync_enabled, updated_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(retail_store_id, product_id, spec_key) DO UPDATE SET
      eleme_name = excluded.eleme_name, sync_enabled = 1, updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const c of confident) upsert.run(store.id, c.p.id, storeCode, c.match);
  });
  tx();
  console.log(`\n[match] applied ${confident.length} mapping(s).`);

  const queued = elemeSync.enqueueAll(db);
  console.log(`[match] queued ${queued} product(s) for their first push (eleme-sync will pick them up within ~10s).`);
}

main().catch(e => { console.error('[match] fatal:', e); process.exit(1); });
