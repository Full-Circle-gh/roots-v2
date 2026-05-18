#!/bin/bash
# Verify that the seeded default passwords are NOT still in use on prod.
# Reads the stored bcrypt hashes and runs compareSync against the literals
# in routes/auth.js seedUsers(). Never logs in over HTTP, never hits the
# rate limiter, never leaves a trace in activity_log.
#
# Run from your laptop:
#   ssh root@47.239.89.63 'bash -s' < scripts/check-default-passwords.sh
#
# Expected output:
#   admin       rotated   <- good
#   manager     rotated
#   warehouse   rotated
#   kitchen     rotated
#
# If ANY line says "STILL DEFAULT", change that user's password immediately
# via the admin UI before doing anything else.

set -euo pipefail
cd /root/roots-v2
node -e "
const db = require('better-sqlite3')('data/roots.db', { readonly: true });
const bcrypt = require('bcrypt');
const defaults = {
  admin:     'Admin2026!',
  manager:   'Manager2026!',
  warehouse: 'Warehouse2026!',
  kitchen:   'Kitchen2026!'
};
const rows = db.prepare('SELECT id, username, password, is_active FROM users').all();
let anyDefault = false;
for (const u of rows) {
  const dft = defaults[u.username];
  if (!dft) { console.log('  ' + u.username.padEnd(14) + ' (no default to check)'); continue; }
  const stillDefault = bcrypt.compareSync(dft, u.password);
  if (stillDefault) anyDefault = true;
  console.log('  ' + u.username.padEnd(14) + ' active=' + u.is_active + '  ' +
              (stillDefault ? '*** STILL DEFAULT — CHANGE NOW ***' : 'rotated'));
}
process.exit(anyDefault ? 1 : 0);
"
