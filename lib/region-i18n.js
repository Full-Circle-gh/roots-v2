// Bilingual (Chinese <-> English) resolver for China province / city / district
// names, so a saved delivery address can be displayed in whichever language the
// customer's mini-app is currently set to — instead of being frozen in the
// language it happened to be entered in.
//
// Backed by the same datasets the delivery-zone admin already uses:
//   • reference/china_regions.json — all ~333 prefecture cities + provinces (bilingual)
//   • lib/china_districts.json     — districts per city, keyed by city name_cn (bilingual)
//
// resolveRegion() takes whatever is stored (canonical Chinese, OR a literal
// English form like "Beijing City" / "Tianhe District") and returns canonical
// Chinese values PLUS their English counterparts. Anything we can't match
// passes through unchanged (its English stays null) so foreign / freeform
// entries still render as the customer typed them.

const regions = require('../reference/china_regions.json');
const districtsByCity = require('./china_districts.json');

// Strip the trailing administrative suffix off a Chinese name so '广州市' and
// '广州' compare equal.
function normCn(s) {
  return String(s || '').trim()
    .replace(/(特别行政区|自治区|自治州|自治县|新区|街道|地区|盟|省|市|区|县)$/u, '');
}
// Lowercase an English name and drop a trailing administrative word
// ("Beijing City" → "beijing", "Tianhe District" → "tianhe") + punctuation.
function normEn(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[.,]/g, '').replace(/\s+/g, ' ')
    .replace(/\s+(city|district|province|prefecture|county|shi|qu|xian)$/u, '')
    .trim();
}

// ── City + province indexes (from china_regions.json) ──────────────────────
const cityByCn = new Map();   // normCn(name_cn) -> entry
const cityByEn = new Map();   // normEn(name_en) -> entry
const provByCn = new Map();   // normCn(province_cn) -> { cn, en }
const provByEn = new Map();   // normEn(province_en) -> { cn, en }

for (const c of regions.cities || []) {
  const entry = {
    name_cn: c.name_cn, name_en: c.name_en,
    province_cn: c.province_cn, province_en: c.province_en,
  };
  if (c.name_cn) cityByCn.set(normCn(c.name_cn), entry);
  if (c.name_en) cityByEn.set(normEn(c.name_en), entry);
  if (c.province_cn) {
    const p = { cn: c.province_cn, en: c.province_en || c.province_cn };
    provByCn.set(normCn(c.province_cn), p);
    if (c.province_en) provByEn.set(normEn(c.province_en), p);
  }
}

// ── District indexes (from china_districts.json) ───────────────────────────
// Scoped per city so a district lookup can disambiguate the many repeated
// names (every big city has a 朝阳/新华/etc.). A loose global map backs the
// rare case where the city didn't resolve.
const distByCity = new Map();      // normCn(cityCn) -> { byCn:Map, byEn:Map }
const distGlobalCn = new Map();    // normCn(district) -> entry (last wins; fallback only)
const distGlobalEn = new Map();    // normEn(district) -> entry (last wins; fallback only)

for (const [cityCn, arr] of Object.entries(districtsByCity)) {
  const byCn = new Map(), byEn = new Map();
  for (const d of arr || []) {
    byCn.set(normCn(d.name_cn), d);
    byEn.set(normEn(d.name_en), d);
    distGlobalCn.set(normCn(d.name_cn), d);
    distGlobalEn.set(normEn(d.name_en), d);
  }
  distByCity.set(normCn(cityCn), { byCn, byEn });
}

function lookupCity(raw) {
  if (!raw) return null;
  return cityByCn.get(normCn(raw)) || cityByEn.get(normEn(raw)) || null;
}

function lookupDistrict(cityCn, raw) {
  if (!raw) return null;
  const scoped = cityCn && distByCity.get(normCn(cityCn));
  if (scoped) {
    const hit = scoped.byCn.get(normCn(raw)) || scoped.byEn.get(normEn(raw));
    if (hit) return hit;
  }
  return distGlobalCn.get(normCn(raw)) || distGlobalEn.get(normEn(raw)) || null;
}

// Resolve a stored address region into canonical Chinese + English. Input may
// carry province / city / district in either language. Output always keeps the
// (best-effort canonical) Chinese in province/city/district and fills the
// *_en companions when we recognise the place; unknown places pass through with
// a null English side.
function resolveRegion(a) {
  const out = {
    province: a.province || null, province_en: a.province_en || null,
    city: a.city || null, city_en: a.city_en || null,
    district: a.district || null, district_en: a.district_en || null,
  };

  const city = lookupCity(a.city);
  if (city) {
    out.city = city.name_cn;
    out.city_en = city.name_en;
    if (!out.province) out.province = city.province_cn;
  }

  if (out.province) {
    const p = provByCn.get(normCn(out.province)) || provByEn.get(normEn(out.province));
    if (p) { out.province = p.cn; out.province_en = p.en; }
  }

  const district = lookupDistrict(out.city || a.city, a.district);
  if (district) {
    out.district = district.name_cn;
    out.district_en = district.name_en;
  }

  return out;
}

module.exports = { resolveRegion, normCn, normEn };
