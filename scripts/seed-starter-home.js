#!/usr/bin/env node
// Backfill: give every EXISTING tenant DB the brand-neutral starter home
// layout — but only where no home layout exists yet (INSERT OR IGNORE, plus
// an explicit empty-array check: a saved-then-emptied layout counts as "none").
// The main/Roots DB is never touched. Safe to re-run.
//
// Usage (on the box):  node scripts/seed-starter-home.js [--dry]
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildStarterHomeLayout } = require('../lib/provision-tenant');

const DRY = process.argv.includes('--dry');
const dir = path.join(__dirname, '..', 'data', 'tenants');
if (!fs.existsSync(dir)) { console.log('no tenants dir — nothing to do'); process.exit(0); }

const files = fs.readdirSync(dir).filter(f => /^\d+\.db$/.test(f));
for (const f of files) {
  const db = new Database(path.join(dir, f));
  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE name='storefront_config'").get();
    if (!hasTable) { console.log(f + ': no storefront_config table — skipped'); continue; }
    const read = (k) => {
      const r = db.prepare('SELECT value_json FROM storefront_config WHERE key=?').get(k);
      if (!r) return null;
      try { return JSON.parse(r.value_json); } catch { return null; }
    };
    const live = read('home.layout');
    if (Array.isArray(live) && live.length) { console.log(f + ': has a home layout (' + live.length + ' blocks) — untouched'); continue; }
    const starterJson = JSON.stringify(buildStarterHomeLayout());
    if (DRY) { console.log(f + ': WOULD seed starter home layout'); continue; }
    const up = db.prepare(
      'INSERT INTO storefront_config (key, value_json) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP'
    );
    const draft = read('cms.draft.home_layout');
    const tx = db.transaction(() => {
      up.run('home.layout', starterJson);
      // Respect an in-progress draft: only align the draft when it's empty too.
      if (!(Array.isArray(draft) && draft.length)) up.run('cms.draft.home_layout', starterJson);
    });
    tx();
    console.log(f + ': seeded starter home layout' + ((Array.isArray(draft) && draft.length) ? ' (draft kept)' : ' (live + draft)'));
  } finally {
    db.close();
  }
}
