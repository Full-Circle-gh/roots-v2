// Can a Guangzhou rider call this number?
//
// The mini-app's copy of the rule in lib/phone-cn.js. It has to be a copy — the
// mini-app is its own bundle and cannot require anything from the server tree —
// so keep the two in step: same normalization, same test.
//
// This is a HINT, and only a hint. Nothing here blocks a checkout, refuses a
// number, or decides anything: it chooses whether to show the customer a notice
// suggesting a number a rider can ring. The authoritative handling lives on the
// server (the ops flag at enqueue) and in the courier daemon (which stops
// retrying a phone Qingyun has already refused). If this disagrees with them,
// the customer sees a notice they didn't need, or misses one they'd have
// ignored — nothing more.
//
// Deliberately NOT used to validate the address form. Qingyun's true accepted
// format is unverified, so a number this rejects may still be perfectly usable,
// and a customer must always be able to save and order with it.

const MAINLAND_MOBILE = /^1\d{10}$/;

// Digits only, unwrapping a mainland country code only when what's left is
// actually a mainland mobile (so a foreign number starting 86 keeps its digits).
function normalize(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const digits = t.replace(/\D/g, '');
  if (!digits) return '';
  const unwrapped =
      (digits.length === 13 && digits.indexOf('86') === 0)   ? digits.slice(2)
    : (digits.length === 14 && digits.indexOf('086') === 0)  ? digits.slice(3)
    : (digits.length === 15 && digits.indexOf('0086') === 0) ? digits.slice(4)
    : null;
  if (unwrapped != null && MAINLAND_MOBILE.test(unwrapped)) return unwrapped;
  return digits;
}

function isMainlandMobile(raw) {
  return MAINLAND_MOBILE.test(normalize(raw));
}

module.exports = { normalize, isMainlandMobile };
