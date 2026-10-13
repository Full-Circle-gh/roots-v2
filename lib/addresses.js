// Addresses: the Chinese-address cleaner, the background map lookup for a
// saved address (with its translate-to-Chinese retry), the city → province
// table, and the columns a customer is shown of their own address book.
// Moved out of routes/retail.js unchanged (decisions §477). The order-snapshot
// lookup (geocodeOrderSnapshotAsync) stays there: it requeues the Qingyun
// courier push, which belongs with orders.
'use strict';

const { tdb } = require('./tenant-db');
const geocode = require('./geocode');
const regionI18n = require('./region-i18n');
const addressCn = require('./address-cn');
const addressPin = require('./address-pin');
const phoneCn = require('./phone-cn');
const modelGateway = require('./model-gateway');
// The served-regions dataset provinceForCity builds its table from — the same
// file routes/retail.js loads as CHINA_REGIONS.
const CHINA_REGIONS = require('../reference/china_regions.json');

const ADDRESS_PUBLIC_COLS = `id, recipient_name, phone, province, city, district,
                              province_en, city_en, district_en,
                              address, detail, postal_code, is_default,
                              created_at, updated_at`;

// ─── Chinese address normalization (server-side safety net) ───────────
// The mini-app now forces region selection via the native picker, so this
// helper rarely needs to do anything — but it catches:
//   • province typed without 省 suffix      → "广东"   → "广东省"
//   • city typed without 市 suffix          → "广州"   → "广州市"
//   • province/city accidentally repeated inside the freeform `address`
//     field (e.g. "广东省广州市天河区Apt 4" → strip the prefix)
//   • known city/province pairs reflowed from older WeChat picker payloads
//     that returned bare values, plus a small set of municipalities that
//     don't normally take 省 (北京/上海/天津/重庆 are direct-administered).
const CN_PROVINCES = [
  '北京','上海','天津','重庆',           // direct-administered municipalities (no 省 suffix)
  '广东省','广西壮族自治区','海南省','福建省','浙江省','江苏省','安徽省','江西省',
  '山东省','河南省','湖北省','湖南省','河北省','山西省','内蒙古自治区','辽宁省',
  '吉林省','黑龙江省','四川省','贵州省','云南省','西藏自治区','陕西省','甘肃省',
  '青海省','宁夏回族自治区','新疆维吾尔自治区','台湾省','香港特别行政区','澳门特别行政区',
];
const CN_PROVINCE_STEMS = new Set(CN_PROVINCES.map(p => p.replace(/省$|自治区$|特别行政区$|市$/, '')));

function normalizeChinaAddress(a) {
  const out = { ...a };
  const trim = s => (typeof s === 'string' ? s.trim() : s);
  out.province = trim(out.province) || null;
  out.city     = trim(out.city)     || null;
  out.district = trim(out.district) || null;
  out.address  = trim(out.address)  || '';
  out.detail   = trim(out.detail)   || null;
  // The phone used to be the one field this function passed through untouched,
  // which is how a whitespace-only number satisfied every presence check below
  // and reached the courier as an empty string. Tidy it (safely — see
  // lib/phone-cn.normalizeForStorage, which hands back the original rather than
  // mangle anything it doesn't understand) and let '' mean absent.
  // Only when the key is actually present: these objects feed PARTIAL updates,
  // where an absent phone means "leave it alone", not "blank it".
  if ('phone' in out) out.phone = phoneCn.normalizeForStorage(out.phone);

  // Backfill the province from the city when the picker didn't supply one.
  // Plain 'city' served-zones store only the city; this gives every served
  // city its 省 automatically, the same way Guangzhou districts carry 广东省.
  // Runs before the suffix block below so municipalities normalize too
  // (e.g. derived '北京市' → '北京').
  if (!out.province && out.city) {
    const prov = provinceForCity(out.city);
    if (prov) out.province = prov;
  }

  // EN-mode picker quirk: province-typed delivery zones (match_city = '江苏省')
  // are listed in the EN city wheel, so the customer's pick lands in the CITY
  // slot with province blank. Lift it into province so the address saves (the
  // POST requires a province) and the zone matcher's province pass resolves.
  // Only fires when the city literally ends in 省/自治区 — municipalities
  // ('北京'/'上海') have no such suffix and are handled by the backfill above.
  if (!out.province && out.city && /(省|自治区)$/u.test(out.city)) {
    const cityStem = out.city.replace(/省$|自治区$|特别行政区$/u, '');
    const provMatch = CN_PROVINCES.find(
      p => p === out.city || p.replace(/省$|自治区$|特别行政区$|市$/u, '') === cityStem
    );
    if (provMatch) out.province = provMatch;
  }

  // Add 省 suffix to bare province names (except direct-administered cities).
  if (out.province) {
    const stem = out.province.replace(/省$|自治区$|特别行政区$|市$/, '');
    const direct = ['北京','上海','天津','重庆'];
    if (direct.includes(stem)) out.province = stem;
    else if (CN_PROVINCE_STEMS.has(stem) && !/省$|自治区$|特别行政区$/.test(out.province)) {
      const match = CN_PROVINCES.find(p => p.replace(/省$|自治区$|特别行政区$/, '') === stem);
      if (match) out.province = match;
    }
  }
  // Add 市 suffix to city if missing. Only skip when the value already ends
  // with a real administrative suffix — 市 / 自治州 / 地区 / 盟. Cities like
  // 广州 / 福州 / 苏州 end in 州 but aren't really "州" administratively, so
  // they still need 市 appended.
  if (out.city && !/(市|自治州|地区|盟|省|自治区)$/.test(out.city)) {
    out.city = out.city + '市';
  }
  // Add 区/县 awareness — keep district as typed (too many shapes to enumerate),
  // just trim trailing punctuation.
  if (out.district) out.district = out.district.replace(/[,，。.\s]+$/, '');

  // Strip a leading "province city district" prefix from the freeform
  // address field when it duplicates the structured fields. People paste
  // full addresses into the street field (and the mini-app's type-to-derive
  // lifts the region into its own slots but leaves the blob in the street),
  // so without this the order's address_full doubles the region.
  //
  // Two subtleties the naive single-pass version got wrong:
  //   • LONGEST-FIRST. For municipalities the province normalizes to the bare
  //     stem ('北京') while the street carries the full form ('北京市…'). If we
  //     strip '北京' first it leaves a dangling '市' the later passes can't
  //     match, and the whole region survives ('…市朝阳区麦子店街道…'). Trying the
  //     longest value ('北京市') first avoids the orphan.
  //   • LOOPED. A street like '广东省广州市天河区珠江西路' needs each region token
  //     peeled in turn; one pass in fixed order can't, because stripping the
  //     province shifts what's now at the head.
  // We only ever match the FULL structured values (never their stems), so a
  // real street like '天河路100号' under district '天河区' is left untouched.
  if (out.address) {
    const variants = [out.province, out.city, out.district]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    let stripped = out.address.trim();
    let changed = true;
    while (changed) {
      changed = false;
      for (const v of variants) {
        const re = new RegExp('^\\s*' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
        if (re.test(stripped)) { stripped = stripped.replace(re, ''); changed = true; }
      }
    }
    out.address = stripped.trim();
  }

  return out;
}

// Background geocode helper — never throws, writes lat/lng + geocoded_at
// when the Tencent Maps call resolves. Skipped silently if the key isn't
// configured (TENCENT_MAPS_KEY in .env).
//
// English/pinyin street text (customers who type their address in English) is
// the problem case, and it fails in TWO ways, not one:
//   • hard fail — Amap's mainland geocoder rejects the string outright, the
//     address never gets coordinates, and routeOrder() falls back to coarse
//     district-name matching;
//   • soft fail — WORSE, and the one that reaches a customer: it matches only
//     the administrative part and returns the district's centroid. That answer
//     is indistinguishable from a real one (ok status, plausible lat/lng) but
//     can sit tens of km from the door, and it is what a courier is then sent to.
// So translation is not a last resort for the hard-fail case: ANY Latin street
// text gets translated to Chinese (same model + tool the admin flow uses) and
// re-geocoded, and we keep whichever attempt produced the more precise pin.
// Saving the corrected text is what makes the follow-up worthwhile — without it
// we'd re-fail identically on every future save of the same bad text.
const GEO_RANK = { coarse: 0, street: 1, rooftop: 2 };
function geocodeAddressAsync(addressId, a) {
  if (!geocode.configured()) return;
  setImmediate(async () => {
    try {
      const first = await geocode.geocodeAddress({
        province: a.province, city: a.city, district: a.district,
        address: [a.address, a.detail].filter(Boolean).join(' '),
      });
      // Never overwrite a pin the customer tapped. Callers are supposed to skip
      // this helper for such rows, but the guard lives here too: this is a
      // background write, and a single caller that forgets would silently
      // downgrade a known-good door to a text match with nothing in the response
      // to show for it. The `geo_source <> 'customer_pin'` predicate makes that
      // impossible from any caller.
      const savePin = (c, id) => {
        const prov = addressPin.geocodedPinFields(c);
        return tdb().prepare(addressPin.GEOCODED_PIN_SQL).run(c.lat, c.lng, prov.source, prov.precision, id);
      };

      // Same test the push path runs (lib/qingyun-payload) — the JOINED text, so
      // a Chinese street with an English "Room 302" is caught here too instead of
      // only being noticed later at waybill time.
      const worthTranslating = addressHasLatin([a.address, a.detail].filter(Boolean).join(' '))
        && modelGateway.isConfigured();
      // A precise Chinese-text hit is the end of the story.
      if (first && !worthTranslating) { savePin(first, addressId); return; }
      if (first && (GEO_RANK[first.precision] ?? 0) >= GEO_RANK.rooftop && first.cityMatch !== false) {
        savePin(first, addressId); return;
      }
      if (!worthTranslating) { if (first) savePin(first, addressId); return; }

      const merged = await autoTranslateAddressCn(a);
      if (!merged) { if (first) savePin(first, addressId); return; }
      const retry = await geocode.geocodeAddress({
        province: merged.province, city: merged.city, district: merged.district, address: merged.address,
      });
      // Adopting the translation REWRITES the customer's address, so it has to be
      // strictly better on every axis, not merely not-worse:
      //   • strictly higher precision (a tie means the rewrite bought us nothing,
      //     and a wrong street that happens to match at the same grade would
      //     otherwise replace a correct one);
      //   • landed in the region the address claims — the same cross-check the
      //     original result gets three lines above;
      //   • actually Chinese. A half-converted street ("珠江West路") resolves no
      //     better than what we started with and reads worse on the waybill.
      if (!addressCn.shouldAdoptTranslation({ first, retry, mergedAddress: merged.address })) {
        if (first) savePin(first, addressId);
        return;
      }
      const adopted = tdb().prepare(
        `UPDATE retail_customer_addresses
            SET province = ?, city = ?, district = ?, address = ?,
                province_en = ?, city_en = ?, district_en = ?,
                lat = ?, lng = ?, geo_source = ?, geo_precision = ?, geocoded_at = CURRENT_TIMESTAMP
          WHERE id = ? AND (geo_source IS NULL OR geo_source <> 'customer_pin' OR lat IS NULL)`
      ).run(
        merged.province || null, merged.city || null, merged.district || null, merged.address || '',
        merged.province_en || null, merged.city_en || null, merged.district_en || null,
        retry.lat, retry.lng, `geocode:${retry.provider || 'maps'}`, retry.precision || null,
        addressId
      );
      if (adopted.changes) {
        console.log('[geocodeAddressAsync] auto-translated + resolved address', addressId,
          `(${retry.precision || 'unknown'} via ${retry.provider || 'maps'})`);
      }
    } catch (e) { console.warn('[geocodeAddressAsync]', e.message); }
  });
}

// Shared by geocodeAddressAsync's auto-heal path and (identically, hand-
// triggered) the admin "Make address Chinese" order tool below. ai_not_configured
// / translate failures return null — callers just skip the retry, same as any
// other soft geocode miss.
async function autoTranslateAddressCn(a) {
  const ai = await addressCn.translateToChinese(a);
  if (!ai) return null;
  // Canonicalize through the same pipeline the customer address book uses:
  // normalize suffixes + de-dupe prefix, then resolve the bilingual region.
  let merged = normalizeChinaAddress({
    province: ai.province || a.province || '',
    city:     ai.city     || a.city     || '',
    district: ai.district || a.district || '',
    address:  ai.street   || a.address  || '',
    detail:   a.detail || '',
  });
  merged = { ...merged, ...regionI18n.resolveRegion(merged) };
  return merged;
}

// The forced tool + the Latin-letter heuristic both live in lib/address-cn now,
// so the Qingyun push can run the identical conversion at waybill time.
const addressHasLatin = addressCn.hasLatin;

// City → canonical Chinese province, built once from the same dataset. The
// served-zone picker stores only a city for plain 'city' zones, so couriers +
// address records lose the 省. This lets normalizeChinaAddress() backfill the
// province for ANY served city automatically — the same way Guangzhou
// districts already carry 广东省 — without an admin field. Keyed on the city
// name minus its 市/自治州/地区/盟 suffix so '北京市' and '北京' both match.
let _cityProvinceMap = null;
function provinceForCity(city) {
  if (!city) return null;
  if (!_cityProvinceMap) {
    _cityProvinceMap = new Map();
    for (const c of (CHINA_REGIONS.cities || [])) {
      const key = String(c.name_cn || '').replace(/(市|自治州|地区|盟)$/u, '');
      if (key && c.province_cn) _cityProvinceMap.set(key, c.province_cn);
    }
  }
  const key = String(city).replace(/(市|自治州|地区|盟)$/u, '');
  return _cityProvinceMap.get(key) || null;
}

module.exports = {
  ADDRESS_PUBLIC_COLS, CN_PROVINCES, CN_PROVINCE_STEMS, normalizeChinaAddress,
  GEO_RANK, geocodeAddressAsync, autoTranslateAddressCn, addressHasLatin, provinceForCity,
};
