// Sales tax and VAT (audit I-03).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// There was no tax anywhere. No rate, no inclusive/exclusive setting, no tax
// line on an order, none on a report. What existed was a free-typed `extra_tax`
// amount on a supplier order and the Chinese tax-invoice request flow, which is
// a different thing entirely — a fapiao is a document requested after the fact,
// not a charge computed at checkout. A merchant in a place that charges sales
// tax or VAT could not use this product to do it.
//
// ── THE TWO SHAPES, AND WHY BOTH ─────────────────────────────────────────
// They are not a preference; they are what different countries require.
//
//   EXCLUSIVE  the price on the shelf is before tax, and tax is added at the
//              till. A US merchant must do this: the sticker says $10.00 and
//              the customer pays $10.83, because the rate depends on where the
//              buyer is and cannot be printed on the label.
//   INCLUSIVE  the price on the shelf already contains the tax, and the receipt
//              breaks out how much of it was tax. The EU and the UK require
//              this for consumer prices: £12.00 means £12.00 at the door, of
//              which £2.00 is VAT.
//
// Exclusive CHANGES WHAT THE CUSTOMER PAYS. Inclusive changes only what the
// receipt says. That asymmetry decides everything downstream — which is why the
// number this module hands back is split in two: `taxMinor` (how much of this
// order is tax, always) and `addedMinor` (how much the total goes UP, which is
// zero on an inclusive shop).
//
// ── THE RATE IS A PERCENTAGE IN MICRO, NOT A FRACTION ────────────────────
// 8.875% is a real sales-tax rate (New York City), and 0.08875 in
// ten-thousandths is 887.5 — not an integer, which is the one thing an exact
// unit may not be. So the stored number is the PERCENTAGE in micro units:
// 20% is 200000 and 8.875% is 88750, i.e. four decimal places of a percent.
// lib/money's toMicro/fromMicro convert it, because it is the same
// ten-thousandths unit that module already defines for rates.
//
// ── ROUNDING HAPPENS ONCE ────────────────────────────────────────────────
// Every figure here is computed in integer minor units and rounded exactly once,
// half away from zero, through lib/money. Tax is the arithmetic most likely to
// be rounded twice — once per line and again on the total — and a receipt whose
// lines do not add up to its own total is the classic tax bug. This module
// therefore taxes ONE base, not a list of lines: whatever the caller decides is
// taxable, summed first, taxed once.
//
// Nothing here reads a database, a request or a clock.

'use strict';

const money = require('./money');

/** The two shapes above. Anything else is not a mode. */
const MODES = ['exclusive', 'inclusive'];

/**
 * A percentage of 100 in micro. A rate above this is not a tax rate, it is a
 * typo — and a typo that would double a customer's bill, so it is refused at
 * the setting rather than divided by later.
 */
const MAX_RATE_MICRO = money.toMicro(100);

/** The shop's settings, normalised. Anything missing or wrong reads as OFF. */
function settingsFrom(cfg) {
  const t = (cfg && typeof cfg === 'object' && cfg.tax && typeof cfg.tax === 'object') ? cfg.tax : {};
  const rate = Number(t.rateMicro);
  const rateMicro = Number.isInteger(rate) && rate >= 0 && rate <= MAX_RATE_MICRO ? rate : 0;
  const mode = MODES.includes(t.mode) ? t.mode : 'exclusive';
  // OFF is not only the default, it is the floor: a shop that switched tax on
  // and then set the rate to zero is charging no tax, and a zero-rate tax line
  // on every receipt would be noise. Both halves have to be true.
  const enabled = t.enabled === true && rateMicro > 0;
  return {
    enabled,
    mode,
    rateMicro,
    /* The name on the receipt. It is not a translation of one word — a shop in
       Dublin writes VAT, one in Toronto writes GST/HST and one in Shanghai
       writes 增值税 — so it is the merchant's own text in both languages, with
       a neutral pair as the fallback rather than a guess at their jurisdiction. */
    label: {
      en: String((t.label && t.label.en) || '').trim() || 'Tax',
      cn: String((t.label && t.label.cn) || '').trim() || '税费',
    },
    /* Whether delivery is taxed. It varies by jurisdiction and by whether the
       shop or a courier is the seller of the service, so it is a switch and not
       a rule. Packing is always taxed with the goods it boxes: it is part of
       the price of supplying them. */
    shippingTaxable: t.shippingTaxable === true,
    /* Shown on a receipt where the law requires the seller's registration
       number to appear beside the tax. Free text; never validated, because
       every country's format is different and a wrong validator is worse than
       none. */
    number: String(t.number || '').trim().slice(0, 40),
  };
}

/** 20 → 200000. For the settings screen, which speaks percent. */
function microFromPercent(percent) {
  const m = money.toMicro(percent);
  return m == null ? null : m;
}
/** 200000 → 20. */
function percentFromMicro(micro) { return money.fromMicro(micro); }

/** Round half away from zero, on a value already in minor units. */
function _round(x) {
  const nudged = x >= 0 ? x + Math.abs(x) * Number.EPSILON : x - Math.abs(x) * Number.EPSILON;
  return nudged >= 0 ? Math.floor(nudged + 0.5) : Math.ceil(nudged - 0.5);
}

/**
 * The tax on one order, in integer minor units.
 *
 *   taxOn({ subtotalMinor, shippingMinor, packingMinor, discountMinor }, settings)
 *
 * Returns:
 *   enabled      was tax in force at all
 *   mode         'exclusive' | 'inclusive'
 *   rateMicro    the rate that was applied, snapshotted by the caller
 *   taxableMinor the base it was applied to
 *   taxMinor     how much of this order is tax
 *   addedMinor   how much the customer pays ON TOP — taxMinor when exclusive,
 *                zero when inclusive
 *
 * THE DISCOUNT COMES OFF THE BASE. A voucher reduces what was actually charged,
 * and tax is charged on what was actually charged — taxing the pre-discount
 * price would collect tax on money nobody paid. The base is floored at zero: a
 * discount larger than the goods (a full-value voucher against a delivery fee,
 * say) taxes nothing rather than refunding tax.
 */
function taxOn(parts, settings) {
  const s = settings && settings.enabled != null ? settings : settingsFrom(settings);
  const p = parts || {};
  const int = (v) => (Number.isInteger(v) ? v : 0);
  const subtotal = int(p.subtotalMinor);
  const shipping = int(p.shippingMinor);
  const packing  = int(p.packingMinor);
  const discount = int(p.discountMinor);
  const out = {
    enabled: !!s.enabled, mode: s.mode, rateMicro: s.rateMicro,
    taxableMinor: 0, taxMinor: 0, addedMinor: 0,
  };
  if (!s.enabled) return out;
  const base = Math.max(0, subtotal + (s.shippingTaxable ? shipping : 0) + packing - discount);
  out.taxableMinor = base;
  if (!base) return out;
  if (s.mode === 'inclusive') {
    // The base already contains the tax, so the tax is the part of it that is
    // tax: base × r / (1 + r), which in these units is base × rate / (100% +
    // rate). One division, one rounding.
    out.taxMinor = _round((base * s.rateMicro) / (MAX_RATE_MICRO + s.rateMicro));
    out.addedMinor = 0;
  } else {
    out.taxMinor = _round((base * s.rateMicro) / MAX_RATE_MICRO);
    out.addedMinor = out.taxMinor;
  }
  return out;
}

/**
 * The tax inside a partial refund, in minor units.
 *
 * A refund of half an order returns half its tax, whichever shape the shop
 * uses — the money went out of the door with tax in it, and it is coming back
 * with tax in it. Proportional to the GROSS the tax was charged on, not to the
 * subtotal: a refund that includes the delivery fee returns more tax than one
 * that does not, on a shop that taxes delivery.
 *
 * Clamped at the tax the order actually carries, so a rounding artefact at 99.9%
 * refunded can never return more tax than was collected. A refund of the whole
 * gross returns exactly the stored figure, by construction rather than by
 * arithmetic — the one case that must not be a division.
 */
function taxInRefund({ taxMinor, grossMinor, refundMinor }) {
  const tax = Number.isInteger(taxMinor) ? taxMinor : 0;
  const gross = Number.isInteger(grossMinor) ? grossMinor : 0;
  const refund = Number.isInteger(refundMinor) ? refundMinor : 0;
  if (!tax || !gross || refund <= 0) return 0;
  if (refund >= gross) return tax;
  return Math.min(tax, _round((tax * refund) / gross));
}

/**
 * What a shop's own settings do to a round number, for the settings screen.
 * A rate is abstract and this is not: it says, in the merchant's own currency,
 * what a 100 order becomes. Every tax setting anybody has ever got wrong was
 * got wrong by somebody who could not see this.
 */
function preview(settings, majorAmount) {
  const s = settings && settings.enabled != null ? settings : settingsFrom(settings);
  const baseMinor = money.toMinor(majorAmount) || 0;
  const t = taxOn({ subtotalMinor: baseMinor }, s);
  return {
    enabled: t.enabled,
    mode: t.mode,
    shelf: money.fromMinor(baseMinor),
    tax: money.fromMinor(t.taxMinor),
    // What the customer hands over. Exclusive adds; inclusive was always this.
    pays: money.fromMinor(baseMinor + t.addedMinor),
    // What the shop keeps. The mirror of the line above, and the one merchants
    // are most often surprised by on an inclusive shop.
    net: money.fromMinor(baseMinor + t.addedMinor - t.taxMinor),
  };
}

module.exports = {
  MODES, MAX_RATE_MICRO,
  settingsFrom, microFromPercent, percentFromMicro,
  taxOn, taxInRefund, preview,
};
