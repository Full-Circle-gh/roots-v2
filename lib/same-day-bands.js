// Guangzhou same-day rider price, by kilometres from the shop that sends it.
// Off unless delivery.sameDayBands.enabled is saved on. Callers that get null
// keep today's district fee. A shop move after the customer has paid must not
// call this to raise what they pay.
'use strict';

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseSameDayBands(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled === true;
  const ceiling = src.ceiling == null || src.ceiling === '' ? 0 : Number(src.ceiling);
  const rows = Array.isArray(src.bands) ? src.bands : [];
  const bands = [];
  for (const row of rows) {
    const from = Number(row && row.from);
    const to = Number(row && row.to);
    const fee = Number(row && row.fee);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(fee)) {
      return { error: 'bad_band' };
    }
    if (from < 0 || fee < 0 || !(to > from)) return { error: 'bad_band' };
    bands.push({ from, to, fee: round2(fee) });
  }
  bands.sort((a, b) => a.from - b.from);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].from < bands[i - 1].to) return { error: 'overlapping_bands' };
  }
  if (!Number.isFinite(ceiling) || ceiling < 0) return { error: 'bad_ceiling' };
  return { enabled, ceiling: round2(ceiling), bands };
}

function bandForKm(bands, km) {
  return bands.find(b => km >= b.from && km < b.to) || null;
}

// True when this district's free-over wipes a same-day rider fee. Outer
// districts (day-only or a same-day surcharge) never waive it.
function sameDayFeeWaived(zone, subtotal, globalFree) {
  if (!zone || zone.zone_type !== 'gz_district') return false;
  const optIn = Number(zone.day_only) === 1 || Number(zone.same_day_surcharge) > 0;
  if (optIn) return false;
  if (zone.free_threshold != null) {
    const t = Number(zone.free_threshold);
    return t > 0 && subtotal >= t;
  }
  const g = Number(globalFree);
  return !Number.isFinite(g) || g <= 0 || subtotal >= g;
}

// null → caller keeps today's fee.
// { offered: false } → same-day rider does not reach this far.
// { offered: true, fee, band, extra, free } → charge fee.
// quoteYuan is the dedicated-rider price when it is known BEFORE payment.
// Null means it was not known: charge the band. The gap above the band is
// added only up to ceiling; the rest is covered by the shop.
function priceSameDayRider({ config, km, quoteYuan, waive }) {
  const parsed = parseSameDayBands(config);
  if (parsed.error || !parsed.enabled || !parsed.bands.length) return null;
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return null;
  const band = bandForKm(parsed.bands, km);
  if (!band) return { offered: false, fee: 0 };
  let extra = 0;
  let fee = band.fee;
  const quote = quoteYuan == null ? null : Number(quoteYuan);
  if (quote != null && Number.isFinite(quote) && quote > fee) {
    extra = Math.min(quote - fee, parsed.ceiling);
    fee = fee + extra;
  }
  if (waive) return { offered: true, fee: 0, band: band.fee, extra: 0, free: true };
  return { offered: true, fee: round2(fee), band: band.fee, extra: round2(extra), free: false };
}

// A customer pin, not a district centre. Bands are not priced from a centre.
function addressPinKm(store, address) {
  if (!store || !address) return null;
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  const sLat = Number(store.lat);
  const sLng = Number(store.lng);
  if (![lat, lng, sLat, sLng].every(n => Number.isFinite(n))) return null;
  const R = 6371;
  const dLat = (lat - sLat) * Math.PI / 180;
  const dLng = (lng - sLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(sLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return round2(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// null keeps today's fee. sameDay is the caller's own "this slot is today".
function riderCharge({ config, zone, km, subtotal, globalFree, sameDay }) {
  if (!sameDay || !zone || zone.zone_type !== 'gz_district') return null;
  return priceSameDayRider({
    config,
    km,
    waive: sameDayFeeWaived(zone, subtotal, globalFree),
  });
}

module.exports = {
  parseSameDayBands,
  sameDayFeeWaived,
  priceSameDayRider,
  addressPinKm,
  riderCharge,
};
