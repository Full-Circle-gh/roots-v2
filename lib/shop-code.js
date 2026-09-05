'use strict';

// The opaque public code a shop carries — docs/tacet-consolidation-decisions.md
// §44 Routing (2026-09-05).
//
// A QR code carries this and nothing else, and the menu page will be served at
// /s/:shopCode. The code is therefore the whole of what stands between one
// shop's menu and prices and anyone editing an address bar — in a multi-tenant
// deployment, between one tenant's and another's. So it is NON-SEQUENTIAL, NOT
// A SHOP ID, NOT DERIVABLE FROM ONE, and never reuses retail_stores.code, which
// is a human-typed slug like 'tianhe'.
//
// SAME SHAPE AS THE AFFILIATE REFERRAL CODE (routes/retail.js
// newReferralCodeBody): a confusable-free uppercase alphabet — no 0/O, no 1/I —
// drawn from crypto.randomBytes, and re-rolled by the caller on a UNIQUE
// collision. The alphabet has 32 symbols, so `byte % 32` is unbiased: 256 is a
// multiple of 32 and every symbol is equally likely.
//
// EIGHT CHARACTERS, NOT SIX (Ash, 2026-09-05). The referral code is six because
// a person types it. This one is only ever scanned, and it will eventually be
// public across tenants, so it takes the extra length: 32^8 ≈ 1.1 × 10^12
// against the referral code's 32^6 ≈ 1.07 × 10^9.

const crypto = require('crypto');

const SHOP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SHOP_CODE_LEN = 8;

// One fresh candidate. Uniqueness is the database's job (shops.public_code is
// UNIQUE) and the retry is the caller's — see routes/retail-shops.js.
function newShopCode(len = SHOP_CODE_LEN) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += SHOP_CODE_ALPHABET[bytes[i] % SHOP_CODE_ALPHABET.length];
  return s;
}

// True for a string this module could have minted. The public route that will
// one day resolve /s/:shopCode should refuse anything else before it touches
// the database, so a malformed path never becomes a query.
const SHOP_CODE_RE = new RegExp('^[' + SHOP_CODE_ALPHABET + ']{' + SHOP_CODE_LEN + '}$');
function isShopCode(s) { return typeof s === 'string' && SHOP_CODE_RE.test(s); }

module.exports = { newShopCode, isShopCode, SHOP_CODE_ALPHABET, SHOP_CODE_LEN };
