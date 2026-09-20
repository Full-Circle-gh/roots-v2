// WHAT A CONFINED ROLE MAY CALL.
//
// A role carrying `stock_app_only` (kitchen and store_stock ship with it) is
// confined to ONE app and the handful of endpoints that app uses. The gate
// itself lives in server.js, on every request with a Tacet session; this is the
// list it consults, pulled out so it can be tested without booting the server —
// the list is the whole decision, and it was wrong once already.
//
// THE APP THIS CONFINES TO IS NOW TACET MOBILE (`/m`), NOT `/stock`, and that
// is decisions §48 step 3 as amended on 2026-09-08. §48 worded step 3 as "drop
// `stock_app_only` from both presets and retire the gate", on the assumption
// that capability enforcement would be carrying the weight by the time it ran.
// It is not: `lib/cap-routes.js` `capDenied` returns ALLOW whenever
// `tenants.rbac_enforce` is off, `requiredCapFor` returns null for every GET by
// design, and `rbac_enforce` is 0 on every tenant with `docs/README.md`
// recording that it stays off until shadow mode has run. Retiring this gate
// today would hand a kitchen phone the whole back office and every read in it.
// So the gate SURVIVES and is re-pointed: same confinement, same strength, new
// destination — which is what §48 actually rules ("there is no second app").
// It retires for real at §48 step 4, when enforcement is live.
//
// #262 put the kitchen queue in the app and this list did not know about it, so
// every call the queue made came back `kitchen_add_only` before any route ran.
// The capability layer never got a look. The queue was invisible to the only
// role it was built for, and nothing anywhere said why.
//
// METHOD-SCOPED, because the path cannot carry the distinction. GET
// /api/restock is the kitchen's queue; POST /api/restock raises a transfer.
//
// AND NOW CAPABILITY-SCOPED TOO, because the path cannot carry THAT
// distinction either. The two confined roles do different jobs: `kitchen` holds
// quickstock:add / restock:fulfil / production:log, `store_stock` holds
// quickstock:recount / restock:request / restock:receive. Raising a request is
// the clerk's job and not the cook's, and one allowlist keyed on the URL alone
// must either refuse it to both (which is what it did — see below) or hand it
// to both. §46 settled the principle on the same pair of roles: "the server
// must decide by capability and not by job title", and `req.caps` is resolved
// on every request regardless of `rbac_enforce` (routes/retail.js), so reading
// a capability here needs no tenant to switch enforcement on.
//
// WHAT THAT FIXES, and it was a live defect rather than a tidy-up: `store_stock`
// holds `restock:request` and `restock:receive`, is offered "Ask for stock",
// "Ask the kitchen" and "Receive delivery" on the screens built for it, and
// every one of those calls died HERE before its route ran. The role could see
// three of its own jobs and do none of them.
//
// FAIL CLOSED ON THE CAPABILITY HALF, which is the opposite polarity to the
// rest of this layer and is deliberate: everything else here fails open so a
// resolution hiccup never locks an operator out of the app they use all day,
// and the unconditional entries below still do exactly that — counting a shelf
// survives any hiccup. A confinement, though, is the one thing that must not
// widen when a read fails, so an unresolved cap set refuses the gated entries
// rather than admitting them. The cost is named: during a control-plane hiccup
// a clerk can count but cannot raise a request. That is the safe half.
//
// This is a floor, not the whole gate. routes/restock.js narrows what gets
// through: _kitchenScopedSession confines a fulfil-without-pick operator to
// kitchen requests, so the transfer half of these very URLs still 403s.
'use strict';

// caps: a Set, an array, or null/undefined. Null means "not resolved" and
// refuses every capability-gated entry — see FAIL CLOSED above.
function _has(caps, keys) {
  if (!caps) return false;
  const has = typeof caps.has === 'function' ? (k) => caps.has(k) : (k) => caps.indexOf(k) !== -1;
  return keys.some(has);
}

function stockAppOnlyAllows(method, path, caps) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');

  // ── The shell, for every confined role ────────────────────────────────────
  /* WHO THIS OPERATOR IS. Tacet Mobile asks first and gates everything else on
     the answer — the role's name titles the home screen, and the capability set
     decides which rows exist at all. Without it the app boots into a session it
     cannot describe, so this is the one read that must land before any other. */
  if (m === 'GET' && p === '/api/backend/me') return true;
  /* The store's name, currency and TIMEZONE. Every date and time this app draws
     is rendered in the store's zone (td-datetime), so a confined operator
     without it reads timestamps eight hours out in Guangzhou — the bug class
     m.html's own `_date` header records. Carries no order, customer or money
     data; it is branding and formatting. */
  if (m === 'GET' && p === '/api/retail-admin/config') return true;
  if (p === '/api/backend/logout') return true;
  /* Their own language preference, and their own push registration. Both are
     per-operator settings reached from the account sheet, both write nothing
     anybody else can see, and a confined role that cannot be notified is a
     kitchen that finds out about a request by walking to the printer. */
  if (m === 'PUT' && p === '/api/backend/language') return true;
  if (p.startsWith('/api/backend/push/')) return true;

  // ── Counting the shelf: the job both roles hold ───────────────────────────
  if (p === '/api/retail-admin/quick-stock/context') return true;
  if (/^\/api\/retail-admin\/stores\/\d+\/stock(\/\d+)?$/.test(p)) return true;
  /* What has already gone on the shelf today (§46). A READ, and its own line
     rather than a loosened stock pattern: the pattern above is anchored so that
     `/stock` and `/stock/:productId` are the only shapes it admits, and
     widening it would admit every future segment under /stock at the same time.
     A screen and its door go in together — the comment above this list is the
     record of what happens when they do not. */
  if (m === 'GET' && /^\/api\/retail-admin\/stores\/\d+\/stock\/added-today$/.test(p)) return true;

  // ── The kitchen queue: read the list, open one, move it along ─────────────
  if (m === 'GET' && (p === '/api/restock' || /^\/api\/restock\/\d+$/.test(p))) return true;
  if (m === 'PUT' && /^\/api\/restock\/\d+\/status$/.test(p)) return true;
  /* Per-item status (the kitchen queue split, decisions §61): start or finish
     one line without the rest. Added with the screen for the same reason as
     the line above it — a door left off this list is a door the kitchen queue
     cannot use, and the queue is the only thing that calls it. */
  if (m === 'PUT' && /^\/api\/restock\/\d+\/item\/\d+\/status$/.test(p)) return true;

  // ── Production: record what was made ──────────────────────────────────────
  /* Added WITH the screen rather than after it — #262 shipped the kitchen queue
     without touching this list and the queue was invisible to the only role it
     was built for, because every call died here before any route ran. A screen
     and its door go in together. */
  if (m === 'POST' && p === '/api/retail-admin/production') return true;
  if (m === 'GET' && p === '/api/retail-admin/production/reasons') return true;

  // ── Capability-gated: the jobs the two confined roles do NOT share ────────
  /* RAISING A REQUEST, either direction — "Ask for stock" and "Ask the
     kitchen". `store_stock` holds restock:request and these screens are built
     for it; `kitchen` does not hold it and must not reach the create route,
     which is exactly the distinction a path-only list could not draw and why
     this URL was refused to both until now. routes/restock.js `tacetOnly` and
     `_inferDirection` still decide what may be raised and to whom. */
  if (m === 'POST' && p === '/api/restock') return _has(caps, ['restock:request']);
  /* WHAT BECAME OF WHAT THEY ASKED FOR (§197). It rides `restock:request`
     rather than a gate of its own because it is the same screen's other half:
     anybody who may raise a stock request may read back the ones they raised,
     and the route scopes itself to `created_by` so there is nothing else it
     could show them. Added WITH the screen rather than after it — #262's
     lesson, restated one line above: a screen and its door go in together, or
     the role it was built for taps a row and every call dies here. */
  if (m === 'GET' && p === '/api/restock/mine') return _has(caps, ['restock:request']);
  /* COUNTING A TRANSFER IN — the store end of a delivery, gated on the
     capability its own save is gated on server-side, the same rule the phone's
     `receivexfer` row follows. */
  if (m === 'PUT' && /^\/api\/restock\/\d+\/receive$/.test(p)) return _has(caps, ['restock:receive']);
  /* "READY FROM THE KITCHEN" — the list and its acknowledgement (§48, §69).
     The audience is the people who RAISE these requests, never the cook who
     made them: telling a fulfil-only operator their own work is waiting is
     telling them about themselves, which is the gate the phone's own row and
     routes/retail.js both apply. Opening the list IS the acknowledgement, so
     the POST that stamps `seen_at` rides with the read it belongs to. */
  if (m === 'GET' && p === '/api/restock/kitchen-ready/lines') return _has(caps, ['restock:request', 'restock:pick']);
  if (m === 'POST' && p === '/api/restock/kitchen-ready/seen') return _has(caps, ['restock:request', 'restock:pick']);

  return false;
}

module.exports = { stockAppOnlyAllows };
