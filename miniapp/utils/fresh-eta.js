// WHEN A `NEXT BATCH` ROW REACHES THE SHOPPER — §170, IN ONE PLACE.
//
// §108 put one word on a fresh row for every shopper and left the DATE out of
// it, in the checkout notice, on the ground that a pill "cannot" carry one.
// §170 overturns that half: a customer decides whether to tap on the CARD, and
// `NEXT BATCH` alone reads as an indefinite wait to the out-of-city shopper it
// is drawn for. Reported by Ash from a Shenzhen address on a batch morning.
//
// ONE FUNCTION, AND THAT IS THE WHOLE REASON THIS FILE EXISTS. Seven browse
// surfaces draw that band — the shop grid, the shop size sheet, the PDP badge,
// the PDP button, the PDP size rows, the favourites tile, and the web card —
// and §108 exists BECAUSE two of them disagreed and Ash caught it in a
// screenshot pair. A second derivation of this answer is the same bug waiting
// to happen, so callers join a base word to what this returns and never work
// the dates out themselves. `public/shop.html` carries the only other copy: it
// is a standalone single-file storefront that can `require` nothing, and its
// copy names this one.
//
// NO CLOCK IS READ HERE, and no date arithmetic is done on a handset (§82).
// The server hands down `local_fresh_in_days` — whole days from the TENANT'S
// today to the make day — and the two dates themselves. Adding one to an
// integer for a shipped order is not a clock question; asking a phone in
// another zone whether a date is "tomorrow" is, which is why it isn't asked.
'use strict';

// Lifted whole from miniapp/pages/checkout/checkout.wxml:400, where the
// slot-day chip has drawn this pair since the day picker shipped. Nothing is
// composed — see docs/tacet-delivery-vocabulary.md v1.123.
const DAY_WORDS = {
  0: { en: 'TODAY',    cn: '今天' },
  1: { en: 'TOMORROW', cn: '明天' },
};

// The band is uppercase throughout, so the month is too. English locks
// nothing; the Chinese form below is the lift that matters.
const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                   'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// When the row arrives, in the fewest words that need no second reading.
//
// TODAY and TOMORROW beat a date because nobody has to work them out. PAST
// two days a relative count ("IN 3 DAYS") hands the shopper back the
// arithmetic the band exists to save them, so the date itself is printed —
// `9月20日` lifted from checkout.js:1911, the shape every day-only pick in
// checkout already uses.
//
// Returns '' for any row that names no batch (every grocery row, and every
// row when no schedule is configured). An empty string is a REAL answer here:
// callers append nothing and the band keeps §108's bare word. Do not let it
// fall back to a date — there isn't one.
function freshArrivalLabel(p, onLocalRun, lang) {
  if (!p) return '';
  const days = p.local_fresh_in_days;
  if (days == null) return '';
  // The run is served the day the batch is made; a shipped order the day after.
  // One integer, no dates touched.
  const n = Number(days) + (onLocalRun ? 0 : 1);
  if (!Number.isFinite(n)) return '';
  const cn = lang === 'cn';
  // A make day already past is the server's business, not a label's: say today
  // rather than print a date that has gone by.
  if (n <= 0) return cn ? DAY_WORDS[0].cn : DAY_WORDS[0].en;
  if (n === 1) return cn ? DAY_WORDS[1].cn : DAY_WORDS[1].en;
  // Split the string the server sent. Never `new Date(ymd)` — that reads the
  // handset's zone back into an answer the server already settled.
  const ymd = String(onLocalRun ? p.local_fresh_date : p.fresh_ship_date || '');
  const parts = ymd.split('-');
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  return cn ? `${m}月${d}日` : `${MONTHS_EN[m - 1]} ${d}`;
}

// The band as it is drawn: the §108 word, then the arrival when there is one.
// Callers pass their own base so `NEXT BATCH`, `PRE-ORDER` and the PDP's
// button text keep their own vocabularies — this only ever appends.
//
// The ` · ` is the separator the band already uses (`供应商直发 · 单独送达`).
function withFreshArrival(base, p, onLocalRun, lang) {
  if (!base) return base || '';
  const eta = freshArrivalLabel(p, onLocalRun, lang);
  return eta ? `${base} · ${eta}` : base;
}

module.exports = { freshArrivalLabel, withFreshArrival };
