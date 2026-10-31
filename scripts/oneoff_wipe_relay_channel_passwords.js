#!/usr/bin/env node
/**
 * Delete the channel passwords the Integrations login wizard stored and nothing
 * ever read (§257).
 *
 *   node scripts/oneoff_wipe_relay_channel_passwords.js          # counts, writes nothing
 *   node scripts/oneoff_wipe_relay_channel_passwords.js --apply  # deletes
 *
 * ── WHAT THEY ARE ──────────────────────────────────────────────────────────
 * The Integrations wizard's "log in" step (routes/integrations-admin.js,
 * POST /channel-hub/:kind/session/start) saved a merchant's Meituan / Qingyun
 * account name and password per store, encrypted, under the keys
 * `meituan.<store>.user|pass` and `qingyun.<store>.user|pass` in tenant_secrets
 * (lib/tenant-creds.js's DYNAMIC_CRED_RE). The login it then asked for could
 * never run — no login-relay driver was ever registered, so every attempt
 * ended `no_worker_attached` — and a search of the tree finds no reader of
 * those keys outside lib/tenant-creds.js itself. A stored password nothing
 * uses is only risk. Ash, 2026-09-24: *"do everything as you recommend"*.
 *
 * ONLY THOSE KEYS. The tenant-level QINGYUN_USER / QINGYUN_PASS and every other
 * credential are untouched: the pattern below is the per-store family's own
 * regex, anchored, and the plan prints every key it will delete (never a value)
 * before --apply does anything.
 *
 * IDEMPOTENT: a second run finds nothing and says so. No backup is taken here;
 * .github/workflows/oneoff.yml takes a verified one first on the apply path.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WRITE = process.argv.includes('--apply');
const PER_STORE = /^(meituan|qingyun)\.[a-z0-9][a-z0-9_-]*\.(user|pass)$/;

const dbPath = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found at', dbPath); process.exit(1); }
const db = new Database(dbPath);

console.log(`\n${WRITE ? 'APPLYING' : 'DRY RUN'} — ${dbPath}\n`);

let rows;
try {
  rows = db.prepare('SELECT tenant_id, key FROM tenant_secrets ORDER BY tenant_id, key').all();
} catch (e) {
  console.log(`no tenant_secrets table (${e.message}) — nothing to do`);
  process.exit(0);
}
const doomed = rows.filter((r) => PER_STORE.test(r.key));
if (!doomed.length) {
  console.log('No per-store channel passwords are stored. Nothing to do.');
  process.exit(0);
}
for (const r of doomed) console.log(`  tenant ${r.tenant_id}  ${r.key}`);
console.log(`\n${doomed.length} key(s) across ${new Set(doomed.map((r) => r.tenant_id)).size} tenant(s).`);

if (!WRITE) {
  console.log('\nDry run — nothing deleted. Re-run with --apply to delete exactly these keys.');
  process.exit(0);
}

const del = db.prepare('DELETE FROM tenant_secrets WHERE tenant_id = ? AND key = ?');
const n = db.transaction(() => doomed.reduce((acc, r) => acc + del.run(r.tenant_id, r.key).changes, 0))();
const left = db.prepare('SELECT tenant_id, key FROM tenant_secrets').all().filter((r) => PER_STORE.test(r.key)).length;
console.log(`\nDeleted ${n} key(s). Per-store channel passwords left: ${left}.`);
process.exit(left ? 1 : 0);
