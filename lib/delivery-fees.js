// The delivery and packing fee for a cart in a zone (flat, free-over, Guangzhou
// MAX, courier weight pricing, packing per item with a cap), and what the cart's
// "spend more for free delivery" bar may promise. Moved out of routes/retail.js
// unchanged (decisions §477). Pinned by scripts/test_delivery_fees.js.
'use strict';

const db = require('../database');
const { cfgValue } = require('./store-config');

// Given the matched zone + cart state, compute delivery + packing fee.
// deliveryMode is the customer's requested option:
//   • 'standard' — base_fee (free if subtotal hits threshold)
//   • 'max'      — flat max_fee (Guangzhou only). free_threshold does NOT apply.
// Packing fee applies to any zone that configures one (per-item × qty, capped).
// Courier-style weight fee: a price for the first kilogram, then a price for
// each additional STARTED kilogram (首重/续重). Falls back to `fallback` (the
// zone's flat base_fee) when the cart weight can't be computed — no product has
// a parseable weight — so a weight-priced store never blocks checkout or
// silently charges ¥0 for a heavy parcel.
function weightDeliveryFee(rule, grams, fallback) {
  const first = Number(rule && rule.first_kg_fee);
  const extra = Number(rule && rule.extra_kg_fee) || 0;
  if (!Number.isFinite(first)) return Number(fallback) || 0;
  if (!(grams > 0)) return first;                       // no weight info → first-kg (== base_fee)
  const extraKg = Math.max(0, Math.ceil((grams - 1000) / 1000));
  return Math.round((first + extra * extraKg) * 100) / 100;
}

function computeDeliveryAndPacking(zone, subtotal, deliveryMode, totalQty, cartGrams) {
  if (!zone) {
    return { error: 'no_zone_match', deliveryFee: 0, packingFee: 0, freeShipping: false };
  }
  // Free-shipping threshold: a zone's own "Free-over" wins; when blank it falls
  // back to the global fees.freeShippingThreshold (the Settings → Checkout & fees
  // input). Per-zone explicit values keep their existing semantics (0 = none);
  // the global fallback honors the documented "0 = always free shipping".
  let freeEligible;
  if (zone.free_threshold != null) {
    const freeThreshold = Number(zone.free_threshold);
    freeEligible = freeThreshold > 0 && subtotal >= freeThreshold;
  } else {
    const globalFree = Number(cfgValue('fees.freeShippingThreshold', db.FREE_SHIPPING_THRESHOLD_DEFAULT));
    freeEligible = globalFree <= 0 || subtotal >= globalFree;
  }

  // Resolve a weight rule from either the config default zone (zone.weight
  // object) or a database zone row (weight_first_kg_fee / weight_extra_kg_fee
  // columns — the per-area rate table). Absent → flat pricing.
  const weightRule = (zone.weight && zone.weight.first_kg_fee != null)
    ? zone.weight
    : (zone.weight_first_kg_fee != null
        ? { first_kg_fee: zone.weight_first_kg_fee, extra_kg_fee: zone.weight_extra_kg_fee }
        : null);

  let deliveryFee = 0;
  if (zone.zone_type === 'gz_district' && deliveryMode === 'max') {
    if (zone.max_fee == null) return { error: 'max_not_offered', deliveryFee: 0, packingFee: 0, freeShipping: false };
    deliveryFee = Number(zone.max_fee);
  } else if (weightRule && Number(weightRule.first_kg_fee) >= 0) {
    // Weight-priced zone (wizard's national default, or a per-area rate on a
    // zone row). The zone's own Free-over still waives it; the global free
    // fallback does NOT apply to weight pricing — a courier rate is meant to be
    // charged, so it stays predictable.
    const zoneFreeWaives = zone.free_threshold != null
      && Number(zone.free_threshold) > 0
      && subtotal >= Number(zone.free_threshold);
    deliveryFee = zoneFreeWaives ? 0 : weightDeliveryFee(weightRule, cartGrams, zone.base_fee);
  } else {
    deliveryFee = freeEligible ? 0 : Number(zone.base_fee || 0);
  }

  let packingFee = 0;
  if (zone.packing_fee_per_item > 0 && totalQty > 0) {
    packingFee = Number(zone.packing_fee_per_item) * totalQty;
    if (zone.packing_fee_cap != null && packingFee > Number(zone.packing_fee_cap)) {
      packingFee = Number(zone.packing_fee_cap);
    }
  }

  const isGzMax = zone.zone_type === 'gz_district' && deliveryMode === 'max';
  return {
    deliveryFee: Math.round(deliveryFee * 100) / 100,
    packingFee:  Math.round(packingFee  * 100) / 100,
    // Free-shipping badge reflects the actual outcome: a ¥0 delivery line (via
    // threshold, free mode, or a zone-waived weight fee) reads as free, except
    // the GZ any-distance MAX flat which is never "free".
    freeShipping: deliveryFee === 0 && !isGzMax,
  };
}

// What the cart's free-shipping bar may promise for a zone — derived by ASKING
// the engine above, not by re-reading `free_threshold`. The column alone is a
// lie in two configurations the engine handles differently: a weight-priced
// zone ignores it when blank (the global fallback deliberately doesn't reach
// courier rates), and GZ MAX charges its flat fee whatever the subtotal. A bar
// that reads the column shows an unreachable target in both.
//
// So: work out the candidate target the same way the customer would hit it,
// then price a cart sitting exactly ON that target and see whether delivery
// actually comes out at ¥0. Whatever the engine says, the bar says.
//   { threshold, reachable }
//     reachable false → this zone has no free-shipping state to advertise.
//     threshold 0 + reachable true → free at any subtotal (global "0 = always
//     free"); a per-zone 0 keeps its "no free option" meaning and prices as
//     unreachable, which is exactly what the engine does with it.
// qty/grams are 0 because both waiver branches key off subtotal alone — the
// bar can answer without knowing the cart, which is what lets a GET serve it.
function freeShippingTargetFor(zone, deliveryMode = 'standard') {
  if (!zone) return { threshold: null, reachable: false };
  const target = zone.free_threshold != null
    ? Number(zone.free_threshold)
    : Number(cfgValue('fees.freeShippingThreshold', db.FREE_SHIPPING_THRESHOLD_DEFAULT));
  if (!Number.isFinite(target)) return { threshold: null, reachable: false };
  const probe = computeDeliveryAndPacking(zone, Math.max(0, target), deliveryMode, 0, 0);
  return {
    threshold: target,
    reachable: !probe.error && Number(probe.deliveryFee) === 0,
  };
}

module.exports = { weightDeliveryFee, computeDeliveryAndPacking, freeShippingTargetFor };
