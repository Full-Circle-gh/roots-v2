// Delivery zones: which zone an address lands in (Guangzhou districts, cities,
// provinces, Hong Kong, the rest-of-China default), whether delivery is offered
// at all, the refusal an unmatched address gets, the store an out-of-city or
// scheduled ship-district parcel leaves from, and a zone's English name and
// province for the admin table. Moved out of routes/retail.js unchanged
// (decisions §477). Pinned by scripts/test_delivery_zones.js.
'use strict';

const inventory = require('./inventory');
const { tdb } = require('./tenant-db');
const { cfgValue } = require('./store-config');
const { loadPrinterPrefs } = require('./printer-prefs');
const CHINA_REGIONS = require('../reference/china_regions.json');

const GZ_CITY_ALIASES = new Set(['广州', '广州市', 'guangzhou', 'gz']);
function normalizeAreaName(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .toLowerCase()
    // strip common Chinese suffixes so '天河' matches '天河区'
    .replace(/(市|区|县|省)$/u, '');
}
function isGuangzhou(city) {
  if (!city) return false;
  const norm = String(city).trim().toLowerCase();
  return GZ_CITY_ALIASES.has(norm) || normalizeAreaName(city) === 'guangzhou' || normalizeAreaName(city) === '广州';
}

// Returns the best-matching zone row for an address. Falls back to null
// if nothing matches — checkout should then refuse with an explanatory
// error rather than guessing.
// National fallback zone: since we deliver to all of mainland China at a flat
// rate, rather than enumerate a row per province we keep ONE default profile in
// config and synthesize a zone-shaped object from it. matchDeliveryZone returns
// this when an address matches no specific zone, so any address is deliverable
// without a row. Returns null when the default is disabled (then unmatched →
// no_zone_match, the old behaviour). Exceptions (Guangdong, HK, GZ same-day,
// Tibet/Xinjiang) stay as their own rows and win by specific match.
function defaultDeliveryZone() {
  const c = cfgValue('delivery.defaultZone', null);
  if (!c || !c.enabled) return null;
  return {
    id: 'default',
    is_default: 1,
    zone_type: 'city',
    name_en: 'Rest of China',
    name_cn: '其他地区',
    match_city: null,
    match_district: null,
    base_fee:              Number(c.base_fee ?? 25),
    free_threshold:        c.free_threshold == null ? null : Number(c.free_threshold),
    // Courier-style weight rule ({ first_kg_fee, extra_kg_fee }) set by the
    // delivery wizard's "By weight" option. Present → computeDeliveryAndPacking
    // prices by cart weight; absent → the flat base_fee is used as before.
    weight:                (c.weight && c.weight.first_kg_fee != null) ? c.weight : null,
    max_fee:               null,
    packing_fee_per_item:  Number(c.packing_fee_per_item ?? 0),
    packing_fee_cap:       c.packing_fee_cap == null ? null : Number(c.packing_fee_cap),
    is_active:             1,
    same_day_allowed:      c.same_day_allowed ? 1 : 0,
    same_day_surcharge:    0,
    min_lead_days:         Number(c.min_lead_days ?? 1),
    max_lead_days:         Number(c.max_lead_days ?? 15),
    slot_start_hour:       Number(c.slot_start_hour ?? 0),
    slot_end_hour:         Number(c.slot_end_hour ?? 0),
    slot_duration_minutes: Number(c.slot_duration_minutes ?? 0),
    day_only:              c.day_only == null ? 1 : (c.day_only ? 1 : 0),
  };
}

// Is home delivery genuinely available to customers? True when the store
// completed the delivery wizard (delivery.enabled), has an enabled national
// default, or has any active delivery zone (the Roots case — predates the
// wizard). A fresh tenant has none → the customer apps show pickup only rather
// than offering a delivery option that fails at checkout. Mirrors the admin's
// dlvIsConfigured() so the two never disagree.
function deliveryIsAvailable() {
  if (cfgValue('delivery.enabled', false) === true) return true;
  const def = cfgValue('delivery.defaultZone', null);
  if (def && def.enabled) return true;
  try {
    const row = tdb().prepare('SELECT 1 FROM retail_delivery_zones WHERE is_active = 1 LIMIT 1').get();
    return !!row;
  } catch { return true; }   // fail-open — never hide delivery on a lookup error
}

function matchDeliveryZone(address) {
  if (!address) return null;
  const wantDistrict = normalizeAreaName(address.district);
  const wantCity     = normalizeAreaName(address.city);
  const wantProvince = normalizeAreaName(address.province);
  // Free-text fallback: WeChat-imported addresses often dump the entire
  // string (province + city + district + street) into the `address`
  // field and leave the structured city/district slots blank. Also scan
  // the concatenated blob so "广州市 ... 天河区 ..." still matches the
  // Tianhe row even when address.district is empty. Province is included so
  // a province-named zone (match_city = '江苏省') still resolves when the
  // WeChat region picker fills structured 省/市/区 but not the street text.
  const blob = [address.province, address.address, address.detail, address.city, address.district]
                 .filter(Boolean).join(' ');
  // Strip the suffix-stripped form of a configured name (天河区 → 天河) so
  // both forms substring-match.
  const stripSuffix = (s) => String(s || '').replace(/(市|区|县|省)$/u, '');

  // Hong Kong: one flat rate for the whole SAR. HK is dropped from the EN
  // picker, so the only way to pick it is WeChat's native CN region picker,
  // which always stamps province = 香港特别行政区 — meaning the SAR name is
  // always present in the blob. A blob hit is therefore reliable and can't
  // false-match a mainland address (none contain 香港). Return the single 香港
  // zone regardless of which HK district the picker dropped in, so we needn't
  // keep a row per district.
  if (/香港/.test(blob) || /hong\s*kong/i.test(blob)) {
    const hk = tdb().prepare(
      `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city' AND is_active = 1 AND match_city = '香港'`
    ).get();
    if (hk) return hk;
    // No HK row configured → fall through (default/no-match handles it).
  }

  const inGuangzhou = isGuangzhou(address.city) || /广州/.test(blob) || /guangzhou/i.test(blob);

  // Guangzhou district-level matching applies ONLY when this store actually
  // configures GZ districts (the Roots case). A tenant with no gz_district
  // zones — e.g. a store elsewhere in China that just picked "anywhere in the
  // country" — must treat Guangzhou as an ordinary city and fall through to the
  // city / province / national-default matching below; otherwise every
  // Guangzhou address would be refused. When districts ARE configured, keep the
  // exact prior behaviour: match a district or refuse (return null).
  if (inGuangzhou) {
    const rows = tdb().prepare(
      `SELECT * FROM retail_delivery_zones WHERE zone_type = 'gz_district' AND is_active = 1`
    ).all();
    if (rows.length) {
      for (const r of rows) {
        if (wantDistrict && normalizeAreaName(r.match_district) === wantDistrict) return r;
        const full = r.match_district || '';
        if (full && blob.includes(full)) return r;
        const stripped = stripSuffix(full);
        if (stripped && stripped.length >= 2 && blob.includes(stripped)) return r;
      }
      return null;
    }
    // else: no GZ districts configured → fall through to generic matching.
  }
  const rows = tdb().prepare(
    `SELECT * FROM retail_delivery_zones WHERE zone_type = 'city' AND is_active = 1`
  ).all();
  // 1) Exact city match wins — most specific (e.g. a 太原市 zone beats a
  //    broader 山西省 zone for a Taiyuan address).
  for (const r of rows) {
    if (wantCity && normalizeAreaName(r.match_city) === wantCity) return r;
  }
  // 2) Province-level zone: the address's 省 equals a province-named row.
  for (const r of rows) {
    if (wantProvince && normalizeAreaName(r.match_city) === wantProvince) return r;
  }
  // 3) Free-text fallback for WeChat-imported / blank-structured addresses.
  for (const r of rows) {
    const full = r.match_city || '';
    if (full && blob.includes(full)) return r;
    const stripped = stripSuffix(full);
    if (stripped && stripped.length >= 2 && blob.includes(stripped)) return r;
  }
  // 4) National default (rest of China) — covers any mainland address with no
  //    specific zone, so coverage no longer depends on a row per province.
  return defaultDeliveryZone();
}

// The one answer an unmatched address gets, in ONE shape, from every path that
// can create or price an order (§83). Zone coverage is a data obligation on the
// tenant; an address matching no zone is a configuration error, not a delivery
// option, and no path guesses a fee for it.
//
// IT NAMES THE PLACE. A bare `no_zone_match` told an operator that something was
// wrong and nothing about what to do — they had to open the order, read the
// address and work out which of province / city / district the matcher had
// failed on. `unmatched` is the string to search for in Settings → Delivery,
// assembled here rather than left to each reader to reassemble.
//
// The three parts travel separately as well as joined, because a Guangzhou
// address fails on the DISTRICT (matchDeliveryZone refuses inside the Guangzhou
// branch once any gz_district row exists) while an out-of-city one fails on the
// CITY — and the fix is a different row in each case.
function noZoneMatchPayload(address) {
  const a = address || {};
  const parts = [a.province, a.city, a.district].filter(Boolean);
  return {
    success: false,
    error: 'no_zone_match',
    province: a.province || null,
    city:     a.city     || null,
    district: a.district || null,
    unmatched: parts.join(' ') || null,
  };
}

// ─── Out-of-city fulfilment pin (shared) ───────────────────────────────────
// Orders shipping OUTSIDE Guangzhou all leave the single out-of-city warehouse
// (printer.out_of_city_store_id), whatever the proximity router says — see the
// long note at the POST /orders call site. That rule used to live only inside
// the order-create handler, so the checkout QUOTE happily named the nearest
// location while creation shipped from the warehouse, and anything asking "which
// store fulfils this?" before the order existed got the wrong answer.
//
// Extracted verbatim so the quote, the order create and the reschedule picker
// resolve ONE store. It answers only "does the pin apply, and to what?" — the
// caller keeps whatever routeOrder picked when this returns null, which is what
// makes in-city and pickup carts byte-identical to the pre-extraction path:
//   • pickup, or an address that isn't out-of-city / a scheduled ship-district
//   • no out_of_city_store_id configured
//   • the pin resolves to the store the caller already has (baseStoreId) — the
//     original code skipped the whole block in that case, leaving routeOrder's
//     own `reason` on the order, so returning null here preserves that reason
//   • the pinned store is closed for THIS channel (keep the open store the
//     router picked, so the parcel still ships from somewhere)
//
// `slotKind` is needed because a Guangzhou ship-district (花都/番禺/南沙/从化/增城)
// is pinned only when the customer did NOT buy the same-day extra — the same
// `scheduledShipDistrict` expression the order path computes.
function fulfillingStoreFor({ address, channel = 'wechat', isPickup = false, slotKind = null, baseStoreId = null }) {
  if (isPickup) return null;
  const inGz = inventory.isGuangzhouAddress(address);
  const scheduledShipDistrict =
        inGz &&
        inventory.isOptInSameDayDistrict(address) &&
        slotKind !== 'today';
  if (inGz && !scheduledShipDistrict) return null;
  const oocId = loadPrinterPrefs().out_of_city_store_id;
  if (oocId == null) return null;
  if (baseStoreId != null && oocId === baseStoreId) return null;
  const oocClosed = inventory.channelClosedStores(inventory.orderChannelKey(channel));
  const oocStore = inventory.listStores({ activeOnly: true })
    .find((s) => s.id === oocId && !oocClosed.has(s.code));
  if (!oocStore) return null;
  return {
    store: oocStore,
    reason: scheduledShipDistrict ? 'scheduled_ship_district' : 'out_of_city',
  };
}

// Many delivery-zone rows were bulk-inserted (provinces, HK, cities) with a
// null name_en, so the admin table showed only the Chinese name. Derive the
// English label from the same reference catalogue used everywhere else, keyed
// on match_district (GZ/HK districts) then match_city (city or 省). Built once.
const HK_DISTRICTS_EN = {
  '香港': 'Hong Kong',
  '中西区': 'Central and Western', '东区': 'Eastern', '九龙城区': 'Kowloon City',
  '观塘区': 'Kwun Tong', '南区': 'Southern', '深水埗区': 'Sham Shui Po',
  '黄大仙区': 'Wong Tai Sin', '湾仔区': 'Wan Chai', '油尖旺区': 'Yau Tsim Mong',
  '离岛区': 'Islands', '葵青区': 'Kwai Tsing', '北区': 'North', '西贡区': 'Sai Kung',
  '沙田区': 'Sha Tin', '屯门区': 'Tuen Mun', '大埔区': 'Tai Po', '荃湾区': 'Tsuen Wan',
  '元朗区': 'Yuen Long',
};
let _zoneEnMap = null;
function zoneEnglishName(z) {
  if (z.name_en && String(z.name_en).trim()) return z.name_en;
  if (!_zoneEnMap) {
    _zoneEnMap = new Map();
    for (const c of (CHINA_REGIONS.cities || [])) {
      if (c.name_cn && c.name_en) _zoneEnMap.set(c.name_cn, c.name_en);
      if (c.province_cn && c.province_en) _zoneEnMap.set(c.province_cn, c.province_en);
    }
    for (const d of (CHINA_REGIONS.guangzhou_districts || [])) {
      if (d.name_cn && d.name_en) _zoneEnMap.set(d.name_cn, d.name_en);
    }
    for (const [cn, en] of Object.entries(HK_DISTRICTS_EN)) _zoneEnMap.set(cn, en);
  }
  return _zoneEnMap.get(z.match_district) || _zoneEnMap.get(z.match_city) || null;
}

// Province a zone belongs to, so the admin table can group rows under a
// province heading instead of one flat mixed-granularity list. GZ districts →
// Guangdong; a city → its parent province (catalogue lookup); a province-named
// 'city' row (江苏省) → itself; HK → its SAR. Built once.
let _zoneProvMap = null;
const HK_CN = '香港特别行政区';
function zoneProvince(z) {
  if (!_zoneProvMap) {
    _zoneProvMap = new Map();
    for (const c of (CHINA_REGIONS.cities || [])) {
      if (c.name_cn && c.province_cn) {
        _zoneProvMap.set(c.name_cn, { cn: c.province_cn, en: c.province_en || c.province_cn });
      }
      if (c.province_cn) {
        _zoneProvMap.set(c.province_cn, { cn: c.province_cn, en: c.province_en || c.province_cn });
      }
    }
  }
  // Guangzhou same-day districts are operationally distinct from the flat-rate
  // 广东省 province row (different model — time-slots, not a flat fee), so they
  // get their own "Guangzhou" group rather than being lumped under Guangdong.
  if (z.zone_type === 'gz_district') return { cn: '广州市', en: 'Guangzhou' };
  if (z.match_district && HK_DISTRICTS_EN[z.match_district]) return { cn: HK_CN, en: 'Hong Kong' };
  if (z.match_city && HK_DISTRICTS_EN[z.match_city]) return { cn: HK_CN, en: 'Hong Kong' };
  return _zoneProvMap.get(z.match_city) || _zoneProvMap.get(z.match_district) || { cn: '其他', en: 'Other' };
}

module.exports = {
  isGuangzhou, defaultDeliveryZone, deliveryIsAvailable, matchDeliveryZone, noZoneMatchPayload,
  fulfillingStoreFor, zoneEnglishName, zoneProvince,
};
