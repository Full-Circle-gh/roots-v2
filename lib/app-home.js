'use strict';

// WHERE "BACK" GOES FROM A SEPARATE PAGE, and what it is allowed to call it.
//
// /stock and /till are their own documents rather than screens pushed inside
// Tacet Mobile, so each carries its own way out. Both used to answer '/m'
// labelled with the operator's ROLE NAME — "Warehouse", "Manager" — on the
// reasoning that a role-scoped app is titled for the role. That is true for
// exactly one kind of operator: the one whose /m has no tab bar, whose tool
// list IS the home screen and is titled with the role's name (m.html
// homeTitle()).
//
// EVERYBODY ELSE HAS THE FOUR TABS, so '/m' opens the dashboard — a board of
// revenue under a greeting. A back link reading "Warehouse" that lands on "Good
// afternoon" names a screen that does not exist, and it drops the operator two
// screens away from the row they actually came in through: every one of these
// pages is reached from More → Operations.
//
// So the way back goes to the tool list itself and takes that list's own name:
// "More" where there is a bar under it, the role's name where the list is the
// home screen. One destination, one title, and the label is that title.
const TAB_CAPS = ['dashboard:view', 'orders:view', 'customers:view', 'products:view'];

// Accepts either shape the codebase carries caps in: the Set on req.caps or the
// array from lib/operator-caps. Null means "not resolved", and fails OPEN to
// the tab bar — which is what m.html's own mCan() does with the same null, so
// the label matches the screen the operator will actually be looking at.
function hasAny(caps, keys) {
  if (!caps) return true;
  const has = typeof caps.has === 'function' ? (k) => caps.has(k) : (k) => caps.indexOf(k) !== -1;
  return keys.some(has);
}

// rec  : the tenant_roles record (lib/roles recordFor), or null for an unseeded
//        tenant — a stock-app-only role is bounced out of /m by server.js, so it
//        gets no door at all rather than one onto a redirect.
// caps : the operator's effective capabilities (Set or array), or null.
// → { home, homeLabel } exactly as the two endpoints ship them.
function backToTacet(rec, caps) {
  if (rec && rec.stockAppOnly) return { home: null, homeLabel: null };
  const flat = !hasAny(caps, TAB_CAPS);
  const roleName = rec && (rec.nameEn || rec.nameCn)
    ? { en: rec.nameEn || rec.nameCn, cn: rec.nameCn || rec.nameEn }
    : null;
  return {
    // ?to= is m.html's own shortcut parameter, and 'more' is a tab key it
    // already accepts (the long-press shortcuts use the same door).
    home: '/m?to=more',
    homeLabel: flat && roleName ? roleName : { en: 'More', cn: '更多' },
  };
}

module.exports = { backToTacet, TAB_CAPS };
