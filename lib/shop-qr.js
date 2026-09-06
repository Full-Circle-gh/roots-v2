// The QR a shop puts on its tables — docs/tacet-consolidation-decisions.md §44.
//
// A QR CODE IS A PICTURE OF ONE URL AND NOTHING ELSE. The whole of this module
// is deciding which URL, because that is the part that can be wrong in a way
// nobody notices until a customer scans a sticker that has been on a table for
// a month.
//
// THE URL IS THE TENANT'S OWN CUSTOMER DOMAIN PLUS /s/<code>. §44 Domain rules
// the page is served "from the existing customer-facing domain under the /s/
// path prefix", so the host is not ours to invent: it is whichever host the
// tenant already serves customers on, which this platform records in
// tenant_domains. A primary active domain wins; otherwise any active one, in
// insertion order, so a tenant that never nominated a primary still works.
//
// AND WHERE THERE IS NO SUCH DOMAIN, THIS REFUSES. It does not fall back to
// the request's host, and it does not fall back to PAY_NOTIFY_ORIGIN, whose
// own default is a literal belonging to the first tenant — that fallback would
// mint one merchant a QR pointing at another merchant's website. §30 rule 4:
// where the correct target cannot be determined the system refuses and
// surfaces the problem, and never substitutes a placeholder. A refusal an
// operator can read and fix is cheap; a printed sticker pointing at the wrong
// company is not recoverable.
//
// TENANT DOMAINS ARE CONTROL PLANE. tenant_domains lives in the main database
// (routes/backend-auth.js creates it) and is keyed by tenant, so it is read
// through the main handle and filtered by the caller's tenant — never through
// tdb(), which would look for the table inside the tenant's own data file.

'use strict';

const db = require('../database');
const { isShopCode } = require('./shop-code');

// The tenant's customer-facing origin, or null when it has none recorded.
// Scheme is https and not configurable: WeChat's in-app browser is where this
// is scanned, and the payment work in step 5b needs a verified https origin.
function publicOriginFor(tenantId) {
  try {
    const row = db.prepare(
      `SELECT host FROM tenant_domains
        WHERE tenant_id = ? AND status = 'active'
        ORDER BY is_primary DESC, id ASC
        LIMIT 1`
    ).get(tenantId);
    if (!row || !row.host) return null;
    const host = String(row.host).trim().toLowerCase();
    return host ? 'https://' + host : null;
  } catch (e) {
    // tenant_domains absent (a very old database) is the same answer as no
    // domain recorded: we cannot say where this tenant serves customers.
    return null;
  }
}

// The address a scan should open, or null when it cannot be determined.
// The code is re-validated here rather than trusted: this builds a string that
// gets printed, so a malformed code must never reach a sticker.
function menuUrlFor(tenantId, shopCode) {
  if (!isShopCode(shopCode)) return null;
  const origin = publicOriginFor(tenantId);
  return origin ? `${origin}/s/${shopCode}` : null;
}

module.exports = { publicOriginFor, menuUrlFor };
