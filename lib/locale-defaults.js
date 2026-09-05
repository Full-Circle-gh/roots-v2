// What a merchant's country implies (audit D-08 / H-01).
//
// THE PROBLEM. A new account was given 43 settings and none of them was a
// choice: a free-shipping threshold of 399, a shipping fee of 12, a same-day fee
// of 18, "1 point = ¥1", bilingual English-and-Chinese navigation, and a green.
// Currency, time zone, country, units and tax were not seeded AT ALL — they fell
// back to yuan and Guangzhou time. A bakery in Manchester opened a shop priced
// in ¥, closing its books at 4pm local, with a Chinese tab bar.
//
// WHY ONE QUESTION AND NOT FOUR. Sign-up asks for the country. Currency, time
// zone and working language follow from it well enough to be RIGHT most of the
// time and EDITABLE always — which is a better trade than four dropdowns on the
// first screen a merchant ever sees. Every value here is a default the merchant
// can change on the next screen, not a fact about them.
//
// WHAT THIS IS NOT. Not a geography library and not exhaustive. It covers the
// places Tacet is plausibly sold into next, and anything not listed falls back
// to a neutral default rather than to Guangzhou — which is the actual bug.
// Adding a country is one line.
//
// A COUNTRY WITH MANY ZONES gets its most populous business zone, and the
// merchant fixes it if they are in another. Guessing is better than defaulting
// to somebody else's country, and worse than asking — which is why the sign-up
// page shows the guess rather than applying it silently.

'use strict';

// code → { currency: [code, symbol, decimals, position], tz, lang }
// `lang` is what the SHOP shows: 'en', 'cn', or 'bilingual'.
const BY_COUNTRY = {
  CN: { currency: ['CNY', '¥', 2, 'before'], tz: 'Asia/Shanghai',      lang: 'bilingual' },
  HK: { currency: ['HKD', 'HK$', 2, 'before'], tz: 'Asia/Hong_Kong',   lang: 'bilingual' },
  TW: { currency: ['TWD', 'NT$', 0, 'before'], tz: 'Asia/Taipei',      lang: 'bilingual' },
  SG: { currency: ['SGD', 'S$', 2, 'before'], tz: 'Asia/Singapore',    lang: 'en' },
  MY: { currency: ['MYR', 'RM', 2, 'before'], tz: 'Asia/Kuala_Lumpur', lang: 'en' },
  JP: { currency: ['JPY', '¥', 0, 'before'], tz: 'Asia/Tokyo',         lang: 'en' },
  KR: { currency: ['KRW', '₩', 0, 'before'], tz: 'Asia/Seoul',         lang: 'en' },
  TH: { currency: ['THB', '฿', 2, 'before'], tz: 'Asia/Bangkok',       lang: 'en' },
  VN: { currency: ['VND', '₫', 0, 'after'],  tz: 'Asia/Ho_Chi_Minh',   lang: 'en' },
  ID: { currency: ['IDR', 'Rp', 0, 'before'], tz: 'Asia/Jakarta',      lang: 'en' },
  PH: { currency: ['PHP', '₱', 2, 'before'], tz: 'Asia/Manila',        lang: 'en' },
  IN: { currency: ['INR', '₹', 2, 'before'], tz: 'Asia/Kolkata',       lang: 'en' },
  AE: { currency: ['AED', 'د.إ', 2, 'before'], tz: 'Asia/Dubai',       lang: 'en' },
  GB: { currency: ['GBP', '£', 2, 'before'], tz: 'Europe/London',      lang: 'en' },
  IE: { currency: ['EUR', '€', 2, 'before'], tz: 'Europe/Dublin',      lang: 'en' },
  FR: { currency: ['EUR', '€', 2, 'after'],  tz: 'Europe/Paris',       lang: 'en' },
  DE: { currency: ['EUR', '€', 2, 'after'],  tz: 'Europe/Berlin',      lang: 'en' },
  ES: { currency: ['EUR', '€', 2, 'after'],  tz: 'Europe/Madrid',      lang: 'en' },
  IT: { currency: ['EUR', '€', 2, 'after'],  tz: 'Europe/Rome',        lang: 'en' },
  NL: { currency: ['EUR', '€', 2, 'before'], tz: 'Europe/Amsterdam',   lang: 'en' },
  PT: { currency: ['EUR', '€', 2, 'after'],  tz: 'Europe/Lisbon',      lang: 'en' },
  CH: { currency: ['CHF', 'CHF', 2, 'before'], tz: 'Europe/Zurich',    lang: 'en' },
  SE: { currency: ['SEK', 'kr', 2, 'after'], tz: 'Europe/Stockholm',   lang: 'en' },
  NO: { currency: ['NOK', 'kr', 2, 'after'], tz: 'Europe/Oslo',        lang: 'en' },
  DK: { currency: ['DKK', 'kr', 2, 'after'], tz: 'Europe/Copenhagen',  lang: 'en' },
  PL: { currency: ['PLN', 'zł', 2, 'after'], tz: 'Europe/Warsaw',      lang: 'en' },
  US: { currency: ['USD', '$', 2, 'before'], tz: 'America/New_York',   lang: 'en' },
  CA: { currency: ['CAD', 'C$', 2, 'before'], tz: 'America/Toronto',   lang: 'en' },
  MX: { currency: ['MXN', '$', 2, 'before'], tz: 'America/Mexico_City', lang: 'en' },
  BR: { currency: ['BRL', 'R$', 2, 'before'], tz: 'America/Sao_Paulo', lang: 'en' },
  AU: { currency: ['AUD', 'A$', 2, 'before'], tz: 'Australia/Sydney',  lang: 'en' },
  NZ: { currency: ['NZD', 'NZ$', 2, 'before'], tz: 'Pacific/Auckland', lang: 'en' },
  ZA: { currency: ['ZAR', 'R', 2, 'before'], tz: 'Africa/Johannesburg', lang: 'en' },
};

// The fallback for a country not listed. NOT China: falling back to the first
// merchant's country is the defect this file exists to fix, and a neutral
// answer a merchant obviously has to change beats a plausible one they do not
// notice is wrong.
const NEUTRAL = { currency: ['USD', '$', 2, 'before'], tz: 'UTC', lang: 'en' };

const LANGS = new Set(['en', 'cn', 'bilingual']);

/** Is this a country we have an opinion about? */
function knownCountry(code) {
  return Object.prototype.hasOwnProperty.call(BY_COUNTRY, String(code || '').trim().toUpperCase());
}

/** Every country code we know, for the sign-up picker. */
function countries() { return Object.keys(BY_COUNTRY).sort(); }

/**
 * Resolve the four answers. Anything the merchant actually chose wins; anything
 * they left blank is filled from the country; a country we do not know falls
 * back to NEUTRAL.
 *
 * Returns { country, currency:{code,symbol,decimals,position}, timezone, language }
 * — `country` is null when nothing usable was given, and null is honest: it
 * means nobody said, and a later screen should ask.
 */
function resolveLocale({ country, currency, timezone, language } = {}) {
  const cc = String(country || '').trim().toUpperCase();
  const base = BY_COUNTRY[cc] || NEUTRAL;

  const cur = (currency && typeof currency === 'object') ? currency : {};
  const [dCode, dSym, dDec, dPos] = base.currency;
  const resolved = {
    country: knownCountry(cc) ? cc : (cc && /^[A-Z]{2}$/.test(cc) ? cc : null),
    currency: {
      code: typeof cur.code === 'string' && cur.code.trim()
        ? cur.code.trim().toUpperCase().slice(0, 3) : dCode,
      symbol: typeof cur.symbol === 'string' && cur.symbol.trim()
        ? cur.symbol.trim().slice(0, 4) : dSym,
      // 0 is a real answer (yen, won) so `Number.isInteger` rather than truthiness.
      decimals: Number.isInteger(cur.decimals) && cur.decimals >= 0 && cur.decimals <= 3
        ? cur.decimals : dDec,
      position: cur.position === 'after' || cur.position === 'before' ? cur.position : dPos,
    },
    timezone: timezone && String(timezone).trim() ? String(timezone).trim() : base.tz,
    language: LANGS.has(language) ? language : base.lang,
  };
  return resolved;
}

/**
 * Are the shipped fee defaults meaningful in this currency?
 *
 * 399 / 12 / 18 are yuan, and "1 point = ¥1" is a yuan sentence. Seeding them
 * for a merchant selling in pounds gives a free-shipping threshold of £399 and
 * a £12 delivery charge — numbers nobody chose, that look deliberate, and that
 * a merchant may not notice until a customer does.
 *
 * So they are seeded ONLY for the currency they were written in. Everyone else
 * starts with the money keys unset and is asked, which is the honest state:
 * nobody has said yet.
 */
function feeDefaultsApply(currencyCode) {
  return String(currencyCode || '').toUpperCase() === 'CNY';
}

module.exports = { BY_COUNTRY, NEUTRAL, countries, knownCountry, resolveLocale, feeDefaultsApply };
