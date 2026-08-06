// What happens to an address's stored coordinates when it is saved.
//
// Extracted from routes/retail.js because the rule is subtle, load-bearing, and
// was wrong twice: the pin is the only part of an address that is an OBSERVATION
// rather than a description, and every bug here either throws a good observation
// away or invents one that was never made.
//
// The two failure modes, both real:
//   • laundering — the address form round-trips the saved coordinates on every
//     edit (so changing a phone number doesn't drop the pin). Treating "the body
//     has lat/lng" as "the customer just tapped here" relabelled a geocoded,
//     possibly district-centroid pin as customer_pin/rooftop, which then sailed
//     past the courier-side checks that exist to catch exactly that pin.
//   • staleness — keeping coordinates after the street text changed ships the
//     rider to the place the correction was moving away from.
//
// So: a pin is only 'customer_pin' when the client says pin_source='map', which
// the map handlers set at the moment of the tap and nothing else ever sets.

'use strict';

// Mainland China plus a margin. A coordinate outside it is a client bug or a
// spoof, and either way must not become a delivery target.
const CN_BOUNDS = { latMin: 3, latMax: 54, lngMin: 73, lngMax: 136 };

// Read a pin off a request body. Returns { lat, lng, fresh } or null.
function readClientPin(body) {
  const lat = Number(body && body.lat), lng = Number(body && body.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) return null;
  if (lat < CN_BOUNDS.latMin || lat > CN_BOUNDS.latMax) return null;
  if (lng < CN_BOUNDS.lngMin || lng > CN_BOUNDS.lngMax) return null;
  return { lat, lng, fresh: String((body && body.pin_source) || '') === 'map' };
}

// Two coordinates are "the same pin" when they round to the same ~1m point.
// Distinguishes a round-tripped pin (keep its provenance) from a client that
// moved one without saying where it got it.
function samePin(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-5
      && Math.abs(Number(a.lng) - Number(b.lng)) < 1e-5;
}

const TEXT_FIELDS = ['province', 'city', 'district', 'address', 'detail'];

// Did this (partial) update actually change the address text? Absent fields
// mean "not being edited", not "cleared" — a PUT that only carries a phone
// number must not look like a street edit and wipe the coordinates.
function addressTextChanged(incoming, existing) {
  return TEXT_FIELDS.some((k) => {
    const v = incoming ? incoming[k] : null;
    if (v == null) return false;
    const was = existing && existing[k] != null ? existing[k] : '';
    return String(v).trim() !== String(was).trim();
  });
}

// The whole decision, in one place.
//   { action: 'set',   source, precision } — write these coordinates
//   { action: 'clear' }                    — drop coordinates AND provenance
//   { action: 'keep' }                     — leave the row's pin exactly as-is
// `regeocode` says whether the text should be resolved in the background after
// the write: never for a genuine map pick (nothing can improve on it), always
// otherwise.
function decidePinAction({ pin, existing, incoming } = {}) {
  const textChanged = addressTextChanged(incoming, existing);
  if (pin && pin.fresh) {
    return { action: 'set', source: 'customer_pin', precision: 'rooftop', regeocode: false, textChanged };
  }
  if (pin && samePin(pin, existing)) {
    // Unchanged coordinates: a round-trip. Keep them and whatever provenance
    // they already carry — unless the text moved out from under them.
    return textChanged
      ? { action: 'clear', regeocode: true, textChanged }
      : { action: 'keep', regeocode: (existing && existing.geo_source) !== 'customer_pin', textChanged };
  }
  if (pin) {
    // Coordinates we have not seen before, with no claim about where they came
    // from. Worth keeping for routing, worth nothing as evidence.
    return { action: 'set', source: 'client_unverified', precision: null, regeocode: true, textChanged };
  }
  return textChanged
    ? { action: 'clear', regeocode: true, textChanged }
    : { action: 'keep', regeocode: false, textChanged };
}

// Does a row's pin survive a TEXT-only rewrite (the "Make address Chinese" tool,
// or staff fixing a typo)? Only a tapped pin does: it records a location, not a
// description of one, so rewording the label doesn't invalidate it. Everything
// else was derived from the text being replaced.
function keepsPinThroughTextEdit(row) {
  return !!(row && row.geo_source === 'customer_pin' && row.lat != null && row.lng != null);
}

// ── Writing a geocoded pin ────────────────────────────────────────────────
// Every place that stores coordinates derived from a geocoder uses these two,
// so provenance can't be forgotten in one of them. It was: the admin
// geocode-backfill wrote lat/lng with no source at all, minting exactly the
// unattributed rows the courier push then has to re-resolve and corroborate.
//
// The WHERE clause carries the customer_pin guard too. A backfill only selects
// rows with no coordinates, so it can't hit one today — but the guard costs
// nothing and means no future caller can downgrade a tapped pin to a text match.
function geocodedPinFields(c) {
  return {
    source: `geocode:${(c && c.provider) || 'maps'}`,
    precision: (c && c.precision) || null,
  };
}

const GEOCODED_PIN_SQL = `
  UPDATE retail_customer_addresses
     SET lat = ?, lng = ?, geo_source = ?, geo_precision = ?, geocoded_at = CURRENT_TIMESTAMP
   WHERE id = ? AND (geo_source IS NULL OR geo_source <> 'customer_pin' OR lat IS NULL)`;

module.exports = {
  readClientPin, samePin, addressTextChanged, decidePinAction, keepsPinThroughTextEdit,
  geocodedPinFields, GEOCODED_PIN_SQL, CN_BOUNDS,
};
