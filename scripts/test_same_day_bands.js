#!/usr/bin/env node
// Guangzhou same-day rider bands. Off means the caller keeps today's fee.
//   node scripts/test_same_day_bands.js
'use strict';

const assert = require('assert');
const { parseSameDayBands, sameDayFeeWaived, priceSameDayRider } = require('../lib/same-day-bands');

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
};

const bands = {
  enabled: true,
  ceiling: 10,
  bands: [
    { from: 0, to: 4, fee: 15 },
    { from: 4, to: 8, fee: 25 },
    { from: 8, to: 12, fee: 35 },
  ],
};
const inner = { zone_type: 'gz_district', day_only: 0, same_day_surcharge: 0, free_threshold: 199 };
const outer = { zone_type: 'gz_district', day_only: 0, same_day_surcharge: 20, free_threshold: 199 };

console.log('\nparse');
it('off and empty is valid and does not price', () => {
  const p = parseSameDayBands(null);
  assert.strictEqual(p.error, undefined);
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(priceSameDayRider({ config: p, km: 2, waive: false }), null);
});
it('a band that ends before it starts is refused', () => {
  assert.strictEqual(parseSameDayBands({ enabled: true, ceiling: 0, bands: [{ from: 4, to: 4, fee: 15 }] }).error, 'bad_band');
});
it('overlapping rows are refused', () => {
  assert.strictEqual(parseSameDayBands({
    enabled: true, ceiling: 0,
    bands: [{ from: 0, to: 5, fee: 15 }, { from: 4, to: 8, fee: 25 }],
  }).error, 'overlapping_bands');
});

console.log('\nprice');
it('2.4 km is the first band', () => {
  const r = priceSameDayRider({ config: bands, km: 2.4, waive: false });
  assert.strictEqual(r.offered, true);
  assert.strictEqual(r.fee, 15);
});
it('7.1 km is the second band', () => {
  const r = priceSameDayRider({ config: bands, km: 7.1, waive: false });
  assert.strictEqual(r.fee, 25);
});
it('12 km and beyond is not offered', () => {
  assert.strictEqual(priceSameDayRider({ config: bands, km: 12, waive: false }).offered, false);
});
it('no pin means keep today\'s fee', () => {
  assert.strictEqual(priceSameDayRider({ config: bands, km: null, waive: false }), null);
});
it('a quote above the band adds the gap up to the ceiling', () => {
  const r = priceSameDayRider({ config: bands, km: 7.1, quoteYuan: 41, waive: false });
  assert.strictEqual(r.band, 25);
  assert.strictEqual(r.extra, 10);
  assert.strictEqual(r.fee, 35);
});
it('a missing quote charges the band', () => {
  const r = priceSameDayRider({ config: bands, km: 2.4, quoteYuan: null, waive: false });
  assert.strictEqual(r.fee, 15);
});
it('switched off, even with rows, keeps today\'s fee', () => {
  assert.strictEqual(priceSameDayRider({ config: { ...bands, enabled: false }, km: 2, waive: false }), null);
});

console.log('\nfree over 199');
it('the six districts waive the whole fee at 199, including a quote gap', () => {
  assert.strictEqual(sameDayFeeWaived(inner, 199, 199), true);
  const r = priceSameDayRider({ config: bands, km: 2.4, quoteYuan: 40, waive: true });
  assert.strictEqual(r.fee, 0);
  assert.strictEqual(r.free, true);
});
it('an outer district does not waive the same-day rider fee', () => {
  assert.strictEqual(sameDayFeeWaived(outer, 500, 199), false);
  const r = priceSameDayRider({ config: bands, km: 7.1, waive: false });
  assert.strictEqual(r.fee, 25);
});
it('under 199 the inner district still pays the band', () => {
  assert.strictEqual(sameDayFeeWaived(inner, 80, 199), false);
});

console.log(fail ? `\n${fail} failed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
