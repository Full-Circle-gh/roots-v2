// §450 — THE INTERNATIONAL-CARD SURCHARGE.
//
// A counter sale settled on a foreign card costs the shop the acquirer's
// cross-border fee, and Ash decided (2026-10-10) that the customer carries it:
// picking "International card" as the tender adds a percentage to what the card is
// charged — 5% since 2026-10-27 (§501, Ash: "change international card to 5%
// commission, not 4%"). Everything that decides that figure lives here, so the till's
// preview, the create route, the Mark-paid route and the receipt cannot each
// carry their own copy of the arithmetic.
//
// THE RULE, as decided:
//   • CARD_SURCHARGE_PCT of what the CARD takes — the cash figure after points and wallet have
//     settled their share. Credit is not a card payment and is not surcharged.
//   • Rounded to the fen, half up, on whole fen so 0.1-style float drift
//     cannot move it.
//   • Not taxed. It is a pass-through of the card fee, priced after tax.
//   • A CONSTANT, not an operator setting, for the reason §130 gives for
//     ALIPAY_SHORT_OK_CNY: a box on the settings screen is a box somebody
//     eventually types 40 into. Changing the rate is a one-line change here.
//
// The tender value 'intl_card' is an OFF-APP tender like the other five: the
// cashier keys the amount into a separate terminal, and a refund is paid back
// by hand, never through the WeChat gateway.

const INTL_CARD = 'intl_card';
// §501 — 5 from 2026-10-27; it was 4. An order keeps the fee it was charged
// (card_surcharge_fee), so the change reaches new sales only.
const CARD_SURCHARGE_PCT = 5;

// The surcharge on `amount` (¥) for `method`. 0 for every other tender and for
// a bill with nothing left for the card to take.
function cardSurcharge(method, amount) {
  if (method !== INTL_CARD) return 0;
  const fen = Math.round((Number(amount) || 0) * 100);
  if (!(fen > 0)) return 0;
  return Math.round(fen * CARD_SURCHARGE_PCT / 100) / 100;
}

module.exports = { INTL_CARD, CARD_SURCHARGE_PCT, cardSurcharge };
