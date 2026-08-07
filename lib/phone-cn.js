// One rule for "is this a mainland mobile number", shared by everything that
// needs an opinion about a phone.
//
// It lived inside lib/aliyun-sms.js, where it was only ever about whether Aliyun
// would accept a number for an SMS. The same question turned out to matter to
// the same-city courier push: Qingyun refuses a recipient phone it doesn't like
// with `40001 请输入合法的收货人电话`, and until this module existed nothing
// anywhere looked at a phone's shape, so a number that could never take a
// rider's call was discovered five push attempts later instead of at checkout.
// See docs/known-issues.md, RECIPIENT-PHONE-UNVALIDATED.
//
// ⚠️ WHAT THIS IS NOT ALLOWED TO DO
// Qingyun's true accepted format is NOT documented — not by them, not here. The
// `^1\d{10}$` rule below is inferred from which numbers they refused (8- and
// 9-digit foreign-shaped ones) and which they accepted, and an inference is not
// a specification: we do not know whether they would take a landline, an
// +86-prefixed form, or a number from a range that didn't exist when this was
// written. So this rule may WARN a customer and FLAG an order for ops, and it
// may decide not to waste four more push attempts on a rejection that already
// happened — but it must never REJECT a phone number at the point of capture.
// A customer whose number we merely dislike still gets to place their order.

'use strict';

// A letter or a Chinese character means this field holds a NOTE, not just a
// formatted number — '13800138000 (work)', '门卫电话'. Reformatting that would
// throw away the part a human wrote on purpose, so we leave it exactly as typed.
const HAS_WORDS = /[A-Za-z一-鿿]/;

const MAINLAND_MOBILE = /^1\d{10}$/;

// Canonical form, for COMPARING and for testing the rule.
//
// Digits only, except a leading '+' which is kept because it is the difference
// between an international number and a local one. A mainland country code is
// unwrapped ONLY when what remains is actually a mainland mobile — otherwise a
// foreign number that happens to start with 86 would silently lose two digits.
// Returns '' for a value with no digits at all.
function normalize(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const plus = t.startsWith('+');
  const digits = t.replace(/\D/g, '');
  if (!digits) return '';

  // +86 13800138000 / 8613800138000 / 08613800138000 / 008613800138000
  const unwrapped =
      (digits.length === 13 && digits.startsWith('86'))   ? digits.slice(2)
    : (digits.length === 14 && digits.startsWith('086'))  ? digits.slice(3)
    : (digits.length === 15 && digits.startsWith('0086')) ? digits.slice(4)
    : null;
  if (unwrapped != null && MAINLAND_MOBILE.test(unwrapped)) return unwrapped;

  if (MAINLAND_MOBILE.test(digits)) return digits;
  return plus ? '+' + digits : digits;
}

// Does this number look like a phone a Guangzhou rider can call?
//
// The ONLY question this module answers, and the answer is advisory everywhere
// it is asked. See the warning at the top of the file.
function isMainlandMobile(raw) {
  return MAINLAND_MOBILE.test(normalize(raw));
}

// The value to WRITE to the database.
//
// Deliberately more timid than `normalize`. A stored phone is what staff read
// back when they need to ring a customer, so this may tidy the formatting but
// must never destroy information:
//   • a field containing words is left exactly as typed, minus the outer
//     whitespace — it is a note, and the note is the point;
//   • a value that normalizes to nothing keeps its trimmed original, so a
//     number we merely fail to understand survives;
//   • the one sanctioned digit loss is unwrapping a mainland country code,
//     which `normalize` only does when the remainder is a mainland mobile.
// Whitespace-only in, empty string out — which is what makes the presence
// checks at the call sites honest.
function normalizeForStorage(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  if (HAS_WORDS.test(t)) return t;
  return normalize(t) || t;
}

module.exports = { normalize, normalizeForStorage, isMainlandMobile, MAINLAND_MOBILE };
