#!/usr/bin/env node
/**
 * Which accounts are publishing somebody else's About page — audit D-04.
 *
 * READ-ONLY. It opens each active tenant's database, reads one row, and
 * prints what it found. It writes nothing, and there is no --apply.
 *
 * WHY IT IS NEEDED. The About editor used to arrive pre-filled with the FIRST
 * TENANT's story — the manifesto about plant-based food, EST. 2017, MADE IN
 * 广州, the founder's quote, the in/out list — and it read the form back on
 * Save. So any merchant who opened that tab and pressed Save, for any reason,
 * wrote that story into their own storefront_config as their own content.
 *
 * The editor no longer does this. But a row already written is
 * indistinguishable from a page the merchant wrote themselves: it is real
 * saved content, so the storefront renders it, and no code change can tell the
 * two apart. Only a person looking at the text can. That is what this prints.
 *
 * IT DOES NOT DECIDE ANYTHING, and deliberately so. A shop that has genuinely
 * adopted a sentence is not a defect, and a shop that shares a bland kicker
 * ("WHO WE ARE") with the first tenant is not evidence of anything. So it
 * scores against DISTINCTIVE sentences only, prints the account and the
 * matches, and leaves the judgement to whoever reads it.
 *
 * ACCOUNT #1 IS NEVER A FINDING. That copy is theirs. It is reported so the
 * output is complete, and labelled so nobody acts on it.
 *
 *     cd /root/roots-v2 && node scripts/audit_about_borrowed.js
 */
'use strict';

const path = require('path');

const KEY = 'about.content';

/* Sentences and phrases that belong to one shop and could not have been
   arrived at independently. Bland field labels are deliberately absent: a
   shared "OUR PROMISE" means nothing. */
const FINGERPRINTS = [
  ['manifesto (EN)',   'so mind blowing good it transforms how people eat'],
  ['manifesto (CN)',   '做到令人惊艳的好'],
  ['founder quote',    'the boring option'],
  ['founder quote CN', '植物从来不该是无聊的选择'],
  ['sign-off',         'From soil to soul'],
  ['sign-off CN',      '从土壤到灵魂'],
  ['stat · founded',   '2017'],
  ['stat · city',      '广州'],
  ['in-list',          'Real fermentation'],
  ['out-list',         'Cutting corners'],
];

function scan(blob) {
  const hay = JSON.stringify(blob);
  return FINGERPRINTS.filter(([, needle]) => hay.includes(needle)).map(([what]) => what);
}

function describe(blob) {
  if (!blob || typeof blob !== 'object') return null;
  const written = Object.keys(blob).filter((k) => {
    const v = blob[k];
    if (Array.isArray(v)) return v.length > 0;
    return String(v || '').trim().length > 0;
  });
  return {
    fields: written.length,
    hero: String(blob.hero_image_url || '').trim() ? 'yes' : 'no',
    matches: scan(blob),
  };
}

function readAbout(db) {
  let row;
  try {
    row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(KEY);
  } catch (e) {
    return { error: e.message };
  }
  if (!row || !String(row.value_json || '').trim() || row.value_json === 'null') return { empty: true };
  try {
    return { blob: JSON.parse(row.value_json) };
  } catch (e) {
    return { error: 'stored value is not JSON: ' + e.message };
  }
}

function main() {
  const { getTenantDb, ROOTS_TENANT_ID } = require(path.join(__dirname, '..', 'lib', 'tenant-db'));
  const mainDb = require(path.join(__dirname, '..', 'database'));

  let tenants;
  try {
    tenants = mainDb.prepare("SELECT id, name, brand_name FROM tenants WHERE status = 'active' ORDER BY id").all();
  } catch {
    tenants = null;                       // tenants table not migrated on this box
  }
  if (!tenants || !tenants.length) {
    console.log('No active tenants table on this database — reading the single database instead.');
    tenants = [{ id: ROOTS_TENANT_ID, name: '(single database)', brand_name: '' }];
  }

  console.log(`Reading ${KEY} for ${tenants.length} active account(s). Nothing is written.\n`);

  let flagged = 0;
  for (const t of tenants) {
    const label = `#${t.id} ${t.brand_name || t.name || '(unnamed)'}`;
    let db;
    try { db = Number(t.id) === Number(ROOTS_TENANT_ID) ? mainDb : getTenantDb(t.id); }
    catch (e) { console.log(`${label}\n  could not open the database: ${e.message}\n`); continue; }

    const got = readAbout(db);
    if (got.error) { console.log(`${label}\n  ${got.error}\n`); continue; }
    if (got.empty) { console.log(`${label}\n  no About page written — the storefront hides the section.\n`); continue; }

    const d = describe(got.blob);
    if (!d) { console.log(`${label}\n  stored value is not an object.\n`); continue; }

    const own = Number(t.id) === Number(ROOTS_TENANT_ID);
    console.log(label);
    console.log(`  ${d.fields} field(s) written · hero image: ${d.hero}`);
    if (!d.matches.length) {
      console.log('  nothing that belongs to another account.\n');
    } else if (own) {
      console.log(`  ${d.matches.length} of their OWN sentences — this is the account the copy belongs to, not a finding.`);
      console.log(`  (${d.matches.join(', ')})\n`);
    } else {
      flagged++;
      console.log(`  ⚠ ${d.matches.length} sentence(s) that belong to account #${ROOTS_TENANT_ID}:`);
      console.log(`    ${d.matches.join(', ')}`);
      console.log('    Their customers are reading this. Someone should look at the page and decide.\n');
    }
  }

  if (flagged) {
    console.log(`${flagged} account(s) to look at. The editor no longer pre-fills anything, so`);
    console.log('nothing new can arrive this way — these are rows written before that fix.');
  } else {
    console.log('No account is publishing another account\'s story.');
  }
  return 0;
}

process.exit(main());
