// §475 — a manager's till PIN: how a discount is approved at a till signed in
// under somebody else's account.
//
// Decided by Ash, 2026-10-13 ("pin", then "go"), on top of §474's discount.
// The counter tablet is often signed in all day as a shop-floor account, and
// §474 only drew the Discount button for an operator who holds till:discount.
// So the cashier now picks the manager by name and the manager types their own
// PIN. The discount is recorded under the MANAGER's name, not the cashier's.
//
// WHY A NAME AND THEN A PIN, NOT A PIN ALONE. A PIN alone has to be unique
// across the business to say who approved, and refusing a PIN because a
// colleague already uses it tells the person choosing it somebody else's PIN.
// Picking the name first makes every PIN checked against one hash, and the
// record is never ambiguous.
//
// GUESSING IS CAPPED PER MANAGER, not per cashier: five wrong PINs for one
// manager lock that manager's PIN for fifteen minutes, whoever is typing. A
// four-digit PIN is ten thousand guesses; five every fifteen minutes is weeks.
// The count lives in this process. A restart clears it, which costs an
// attacker a restart they cannot cause.

'use strict';

const bcrypt = require('bcrypt');

const PIN_RE = /^\d{4,6}$/;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const fails = new Map();   // `${tenantId}:${userId}` → { n, until }

function validPin(pin) { return PIN_RE.test(String(pin == null ? '' : pin)); }
function hashPin(pin) { return bcrypt.hashSync(String(pin), 10); }

// May this operator give a till discount? Owner always; anyone else by the
// capability, resolved the way requireRetailAdmin resolves it. Closed when the
// caps cannot be resolved — the same rule as manualDiscountDenied.
function canDiscount(db, user, tenant) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  try {
    const r = require('./operator-caps').resolveOperator(db, user, tenant);
    return !!(r && Array.isArray(r.caps) && r.caps.indexOf('till:discount') !== -1);
  } catch (e) { return false; }
}

// The managers a cashier can pick at this business's till: active, holding the
// discount, and with a PIN set. Names only — never the hash.
function approvers(db, tenant) {
  if (!tenant) return [];
  const rows = db.prepare(`SELECT * FROM tenant_users
                            WHERE tenant_id = ? AND is_active = 1 AND till_pin IS NOT NULL AND till_pin != ''
                            ORDER BY COALESCE(NULLIF(display_name, ''), username) COLLATE NOCASE`).all(tenant.id);
  return rows.filter(u => canDiscount(db, u, tenant))
             .map(u => ({ id: u.id, name: u.display_name || u.username }));
}

// Check one manager's PIN. Returns { ok: true, user } or { error, status }.
// A wrong PIN is a 400, not a 403, on purpose: the till reads any 403 as "you
// are signed out" and would tell the cashier to sign in again.
function checkPin(db, tenant, approverId, pin, now) {
  const t = now || Date.now();
  const id = parseInt(approverId, 10);
  if (!tenant || !id) return { error: 'bad_till_pin', status: 400 };
  const key = tenant.id + ':' + id;
  const f = fails.get(key);
  if (f && f.until && f.until > t) return { error: 'till_pin_locked', status: 429 };
  const u = db.prepare('SELECT * FROM tenant_users WHERE id = ? AND tenant_id = ? AND is_active = 1').get(id, tenant.id);
  const good = !!(u && u.till_pin && validPin(pin) && canDiscount(db, u, tenant)
                  && bcrypt.compareSync(String(pin), u.till_pin));
  if (good) { fails.delete(key); return { ok: true, user: u }; }
  const n = (f && !(f.until && f.until <= t) ? f.n : 0) + 1;
  fails.set(key, n >= MAX_FAILS ? { n: 0, until: t + LOCK_MS } : { n, until: 0 });
  return n >= MAX_FAILS ? { error: 'till_pin_locked', status: 429 } : { error: 'bad_till_pin', status: 400 };
}

function _resetForTests() { fails.clear(); }

module.exports = { PIN_RE, MAX_FAILS, LOCK_MS, validPin, hashPin, canDiscount, approvers, checkPin, _resetForTests };
