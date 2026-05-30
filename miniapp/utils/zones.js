// Served delivery-area options for the address pickers (checkout + addresses).
// Driven by the admin's retail_delivery_zones so customers can only pick areas
// we actually deliver to — with labels in their OWN language. WeChat's native
// mode="region" picker is Chinese-only, so English-mode users couldn't read it;
// this list carries name_en / name_cn instead.
//
// Each option shows a localized `label` but stores the canonical Chinese
// match values (city / district) on the address, so the server-side zone
// matcher + couriers still get the names they expect regardless of UI language.

const api = require('./api');

let _cache = null;
let _at = 0;
const TTL_MS = 5 * 60 * 1000;

async function loadZones(force = false) {
  if (!force && _cache && Date.now() - _at < TTL_MS) return _cache;
  const r = await api.get('/api/retail/delivery-zones');
  const list = Array.isArray(r) ? r : (r && r.data) || [];
  _cache = list;
  _at = Date.now();
  return list;
}

// Build selector options for a given language. gz_district rows are prefixed
// with the city ("Guangzhou · Tianhe") so the flat list still reads clearly;
// city rows stand alone.
function buildAreaOptions(zones, lang) {
  const cn = lang === 'cn';
  return (zones || []).map((z) => {
    const isGz   = z.zone_type === 'gz_district';
    const nameEn = z.name_en || z.name_cn || z.match_district || z.match_city || '';
    const nameCn = z.name_cn || z.name_en || z.match_district || z.match_city || '';
    const label  = isGz
      ? (cn ? `广州 · ${nameCn}` : `Guangzhou · ${nameEn}`)
      : (cn ? nameCn : nameEn);
    return {
      id: z.id,
      label,
      zone_type: z.zone_type,
      // Canonical values written onto the address — Chinese, matcher-ready.
      province: isGz ? '广东省' : '',
      city:     isGz ? '广州市' : (z.match_city || z.name_cn || z.name_en || ''),
      district: isGz ? (z.match_district || z.name_cn || z.name_en || '') : '',
    };
  });
}

// Find the option matching an already-set address (saved address / WeChat
// import) so the trigger can show its localized label. Normalizes the 市/区/县/省
// suffix on both sides, same as the server matcher. Returns null when the
// address isn't in any served zone (caller falls back to the raw text).
function matchOption(options, address) {
  if (!address) return null;
  const norm = (s) => String(s || '').trim().replace(/(市|区|县|省)$/u, '');
  const aCity = norm(address.city);
  const aDist = norm(address.district);
  return (options || []).find((o) => {
    if (o.zone_type === 'gz_district') return aDist && norm(o.district) === aDist;
    return aCity && norm(o.city) === aCity;
  }) || null;
}

// City-only options for the English-mode picker's first step (the city→district
// cascade). Chinese mode uses WeChat's native region picker instead, so this is
// only consumed in EN. Each option carries the canonical Chinese city written
// onto the address + the English label shown on the wheel.
function cityOptions(zones, lang) {
  const cn = lang === 'cn';
  return (zones || [])
    .filter((z) => z.zone_type === 'city')
    .map((z) => {
      const name_cn = z.match_city || z.name_cn || z.name_en || '';
      const name_en = z.name_en || z.name_cn || '';
      return { label: cn ? name_cn : name_en, name_cn, name_en };
    });
}

// Province → city tree for the EN-mode cascade picker. Mirrors WeChat's native
// 省→市→区 region wheel (which is Chinese-only) but with English labels, so an
// English customer drills province → city instead of scrolling one flat A→Z
// list of ~340 cities. Only `city` rows participate (Guangzhou districts are
// reached via city=广州市 + the district step, same as before). Districts are
// loaded lazily per city via loadDistricts().
//
// Returns parallel arrays `provCn` / `provLabel` (sorted by the shown label)
// plus `citiesByProv` keyed on the canonical Chinese province name; each city
// is { label, name_cn, name_en, province_cn, province_en }.
function provinceTree(zones, lang) {
  const cn = lang === 'cn';
  const provCn = [];
  const provLabel = {};   // provinceCn -> shown label
  const citiesByProv = {};
  (zones || []).forEach((z) => {
    if (z.zone_type !== 'city') return;
    const pcn = z.province_cn || z.match_city || '';
    if (!pcn) return;
    const pen = z.province_en || pcn;
    if (!citiesByProv[pcn]) { citiesByProv[pcn] = []; provCn.push(pcn); provLabel[pcn] = cn ? pcn : pen; }
    const name_cn = z.match_city || z.name_cn || z.name_en || '';
    const name_en = z.name_en || z.name_cn || '';
    citiesByProv[pcn].push({
      label: cn ? name_cn : name_en, name_cn, name_en,
      province_cn: pcn, province_en: pen,
    });
  });
  provCn.sort((a, b) => String(provLabel[a]).localeCompare(String(provLabel[b])));
  return { provCn, provLabel: provCn.map((c) => provLabel[c]), citiesByProv };
}

// Districts for one city — bilingual, from /api/retail/districts. Cached per
// city so re-opening the picker (or switching back) doesn't refetch. Returns
// [] for a city with no districts (the picker then shows city-level only).
const _distCache = {};
async function loadDistricts(cityCn) {
  if (!cityCn) return [];
  if (_distCache[cityCn]) return _distCache[cityCn];
  const r = await api.get('/api/retail/districts?city=' + encodeURIComponent(cityCn));
  const list = Array.isArray(r) ? r : (r && r.data) || [];
  _distCache[cityCn] = list;
  return list;
}

module.exports = { loadZones, buildAreaOptions, matchOption, cityOptions, provinceTree, loadDistricts };
