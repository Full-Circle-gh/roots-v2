/**
 * The operator a route suite signs in as — on ANY database, fresh or not.
 *
 * Five suites faked a session for `backendUserId: 1` and never made that row.
 * On a database that had already been used, #1 existed (routes/backend-auth.js
 * seeds an owner the first time it is loaded), so they passed; on a brand-new
 * checkout nothing had loaded that module yet, requireRetailAdmin found no
 * operator, and every route answered 401. The same suite was green on a second
 * run and red on the first, which reads as a flake and is not one.
 *
 * This is the pattern scripts/test_till_photos.js already follows, in one
 * place: load backend-auth (which creates tenant #1 on a fresh database), add
 * the suite's OWN operator under an id nothing else uses, and take it away in
 * cleanup, so the suite never depends on whatever row #1 happens to be.
 *
 *   const op = testOperator(99861, '__op_family_publish');
 *   op.add();      // before the server takes requests
 *   op.remove();   // in cleanup
 *   req.session = { backendUserId: op.id }
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function testOperator(id, username) {
  const rawDb = require(path.join(ROOT, 'database.js'));
  // Creates tenants / tenant_users and seeds tenant #1 at require time.
  require(path.join(ROOT, 'routes', 'backend-auth.js'));
  const remove = () => {
    try { rawDb.prepare('DELETE FROM tenant_users WHERE id = ?').run(id); } catch (e) { /* no table yet */ }
  };
  const add = () => {
    remove();   // a row left by a crashed run is replaced, never trusted
    const tenant = rawDb.prepare('SELECT id FROM tenants ORDER BY id ASC LIMIT 1').get();
    rawDb.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
                   VALUES (?, ?, ?, 'x', 'owner', 1)`).run(id, tenant.id, username);
  };
  return { id, add, remove };
}

module.exports = { testOperator };
