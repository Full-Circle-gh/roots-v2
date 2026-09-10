// The names behind a `tenant_users` id, resolved in ONE read for however many
// ids — and the ONE place in the codebase that does it.
//
// ── WHY IT IS A FILE AND NOT A HELPER IN A ROUTE ───────────────────────────
// §87 (v4.196) put this lookup in `routes/staff-expenses.js` for two readers
// that both lived there: the approval queue, which names a screenful, and the
// decide route, which names exactly one on its way to the ledger. Its argument
// was that ONE lookup is what stops the name on the approver's screen and the
// name in the books from drifting — "a second lookup shaped slightly
// differently is the whole mechanism by which they would".
//
// §92 gives that lookup a third reader in a different route file, so the
// argument now requires a file. A copy of these six lines in
// `routes/finance-transactions.js` would be exactly the second lookup §87
// refused, and the drift would be silent: two screens naming the same person
// differently is not something a suite notices.
//
// ── IT IS A CROSS-HANDLE READ AND A JOIN IS NOT AVAILABLE ──────────────────
// `tenant_users` is CONTROL-PLANE — `lib/tenant-db.js` lists it among the
// tables that live only in the shared roots.db and are never cloned into a
// tenant file. The tables that carry these ids (`staff_expenses`,
// `expense_entries`, `income_entries`) are tenant. So the id is all a tenant
// row has, and resolving it means reaching the other handle.
//
// THIS IS WHY THE FILE EXISTS RATHER THAN THE ROUTE REQUIRING `../database`
// DIRECTLY. `scripts/test_finance_transactions.js` asserts that
// `routes/finance-transactions.js` never requires `../database`, because
// `routes/finance.js` reads TENANT data off the global handle and is the
// pattern that assertion exists to keep out. That rule is right and this read
// is not the thing it forbids: control-plane data has nowhere else to come
// from. Naming that distinction in a file is honest; requiring `../database`
// in the route and weakening the assertion to allow it would not be.
//
// ── A MISSING NAME IS NOT A FAILURE ────────────────────────────────────────
// The map simply has no entry. A claim without a name still decides, a ledger
// row without one still carries its money, and the callers render nothing
// rather than inventing a placeholder (§1.12 prefers an empty cell to an
// invented one).

'use strict';

/**
 * @param {Array<number>} ids  `tenant_users` ids, in any order, with duplicates
 *                             and nulls tolerated.
 * @returns {Map<number,string>} id → display name, missing where unresolvable.
 */
function userNames(ids) {
  const names = new Map();
  const want = [...new Set((ids || []).filter(Boolean))];
  if (!want.length) return names;
  try {
    // Required lazily: this file is loaded by routes that a test may evaluate
    // without a database behind them, and `../database` opens one at require
    // time. A lookup that cannot run must fail like a missing name, not like a
    // broken import.
    const q = require('../database').prepare(
      `SELECT id, display_name, username FROM tenant_users WHERE id IN (${want.map(() => '?').join(',')})`);
    for (const u of q.all(...want)) names.set(u.id, u.display_name || u.username);
  } catch (e) { /* a name is a nicety; the row it belongs to still stands */ }
  return names;
}

module.exports = { userNames };
