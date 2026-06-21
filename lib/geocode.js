// Tiny geocoding wrapper. Supports two China providers — pick whichever
// you can get a working key for:
//
//   • 高德 / Amap   (AMAP_MAPS_KEY)     ← preferred; generous free quota
//   • 腾讯 / Tencent (TENCENT_MAPS_KEY)  ← fallback
//
// If BOTH keys are set, Amap is tried first and Tencent is used as an
// automatic fallback (e.g. when Amap is over quota). Get a free key at:
//   Amap:    https://console.amap.com  (Web服务 / WebService API)
//   Tencent: https://lbs.qq.com
//
// Used by:
//   • retail.js POST/PUT /addresses → background geocode customer addresses
//   • retail-inventory.js store CRUD → geocode store addresses
//   • lib/inventory.js routeOrder()  → Haversine distance for "closest store"
//
// When NO key is configured the helper returns null and routing silently
// falls back to district-centroid matching (coarse — district center, not
// the real address, so distances can be several km off).
//
// Caching: identical address strings are cached in-memory for 7 days so
// repeat geocodes don't burn quota. Cache resets on PM2 restart; that's
// fine because lat/lng is also written to the DB row.
//
// Error visibility: the last provider error (e.g. quota exhausted) is kept
// in `_lastError` and exposed via lastError() so the admin panel can show
// WHY geocoding is stuck instead of a silent "0/41".

const https = require('https');

const AMAP_KEY    = (process.env.AMAP_MAPS_KEY || '').trim();
const TENCENT_KEY = (process.env.TENCENT_MAPS_KEY || '').trim();

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const cache = new Map();   // normalizedAddr -> { lat, lng, ts }

// Last error seen from any provider, for surfacing in the UI.
// Shape: { code, message, provider, addr, ts } | null
let _lastError = null;
function lastError() { return _lastError; }

function normalize({ province, city, district, address }) {
  const region = [province, city, district].map(s => (s || '').trim()).filter(Boolean);
  // Legacy rows sometimes baked the full "省 市 区" prefix into the freeform
  // street field. Joining it after the structured region then doubled the
  // prefix (e.g. "广东省 广州市 天河区 广东省 广州市 天河区 …"), which providers
  // geocode poorly. Strip any leading region tokens (any order, repeated)
  // off the street before joining so the query is clean for old + new rows.
  let street = (address || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of region) {
      const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
      if (re.test(street)) { street = street.replace(re, ''); changed = true; }
    }
  }
  return [...region, street]
    .map(s => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

// Returns Promise<{lat, lng} | null>. Never throws — geocoding is
// best-effort; callers must accept null and fall back gracefully.
// On failure, sets _lastError so the admin panel can explain why.
async function geocodeAddress(parts) {
  const providers = [];
  if (AMAP_KEY)    providers.push('amap');
  if (TENCENT_KEY) providers.push('tencent');
  if (!providers.length) return null;

  const addr = normalize(parts);
  if (!addr) return null;

  const cached = cache.get(addr);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return { lat: cached.lat, lng: cached.lng, cached: true };
  }

  let firstErr = null;
  for (const p of providers) {
    const out = await (p === 'amap' ? geocodeAmap(addr) : geocodeTencent(addr));
    if (out && out.lat != null) {
      cache.set(addr, { lat: out.lat, lng: out.lng, ts: Date.now() });
      _lastError = null;
      return out;
    }
    // out is { error: {...} } — remember the first provider's error.
    if (out && out.error && !firstErr) firstErr = { ...out.error, provider: p };
  }
  if (firstErr) {
    _lastError = { ...firstErr, addr, ts: Date.now() };
    console.warn('[geocode]', firstErr.provider, firstErr.code, firstErr.message, '·', addr);
  }
  return null;
}

// ── 高德 / Amap ── https://lbs.amap.com/api/webservice/guide/api/georegeo
async function geocodeAmap(addr) {
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&output=JSON&key=${AMAP_KEY}`;
  try {
    const json = await fetchJson(url);
    // status "1" = ok. Otherwise info/infocode describe the failure.
    if (json?.status !== '1') {
      return { error: { code: json?.infocode || 'amap_error', message: json?.info || 'amap failed' } };
    }
    const g = Array.isArray(json.geocodes) && json.geocodes[0];
    const loc = g && typeof g.location === 'string' ? g.location.split(',') : null;
    if (!loc || loc.length !== 2) return { error: { code: 'no_result', message: 'no geocode' } };
    const lng = parseFloat(loc[0]), lat = parseFloat(loc[1]);
    if (!isFinite(lat) || !isFinite(lng)) return { error: { code: 'bad_coords', message: 'bad coords' } };
    return { lat, lng };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

// ── 腾讯 / Tencent ── https://lbs.qq.com/service/webService/webServiceGuide/webServiceGcoder
async function geocodeTencent(addr) {
  const url = `https://apis.map.qq.com/ws/geocoder/v1/?address=${encodeURIComponent(addr)}&key=${TENCENT_KEY}`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== 0) {
      return { error: { code: String(json?.status ?? 'tencent_error'), message: json?.message || 'tencent failed' } };
    }
    const loc = json.result?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return { error: { code: 'no_result', message: 'no geocode' } };
    }
    return { lat: loc.lat, lng: loc.lng };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

// ── Reverse geocode (lat/lng → Chinese address) ───────────────────────────
// Used by the mini-app "Choose on map" picker: WeChat's chooseLocation returns
// bare coordinates with an EMPTY address when the customer taps the generic
// "Location" (current-position) entry instead of a named POI. We turn those
// coords back into a 省/市/区 + street string so the served-zone matcher and
// waybill get real address fields. Returns Promise<{ address, province, city,
// district } | null>. Never throws — caller falls back to asking the customer
// to pick a named place.
async function reverseGeocode({ lat, lng } = {}) {
  const providers = [];
  if (AMAP_KEY)    providers.push('amap');
  if (TENCENT_KEY) providers.push('tencent');
  if (!providers.length) return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;

  let firstErr = null;
  for (const p of providers) {
    const out = await (p === 'amap' ? regeoAmap(lat, lng) : regeoTencent(lat, lng));
    if (out && out.address != null) { _lastError = null; return out; }
    if (out && out.error && !firstErr) firstErr = { ...out.error, provider: p };
  }
  if (firstErr) {
    _lastError = { ...firstErr, addr: `${lat},${lng}`, ts: Date.now() };
    console.warn('[reverseGeocode]', firstErr.provider, firstErr.code, firstErr.message, '·', `${lat},${lng}`);
  }
  return null;
}

// ── 高德 / Amap 逆地理编码 ── https://lbs.amap.com/api/webservice/guide/api/georegeo
// regeo wants location as "lng,lat".
async function regeoAmap(lat, lng) {
  const url = `https://restapi.amap.com/v3/geocode/regeo?location=${lng},${lat}&output=JSON&extensions=base&key=${AMAP_KEY}`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== '1') {
      return { error: { code: json?.infocode || 'amap_error', message: json?.info || 'amap failed' } };
    }
    const rg = json.regeocode;
    const c = rg && rg.addressComponent;
    if (!rg) return { error: { code: 'no_result', message: 'no regeocode' } };
    // Amap returns city as [] for direct-controlled municipalities — fall back
    // to province so the zone matcher still gets a 市.
    const flat = v => Array.isArray(v) ? '' : (v || '');
    const province = flat(c && c.province);
    let city = flat(c && c.city) || province;
    const district = flat(c && c.district);
    const address = (rg.formatted_address || '') || [province, city, district].filter(Boolean).join('');
    return { address, province, city, district };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

// ── 腾讯 / Tencent 逆地址解析 ── https://lbs.qq.com/service/webService/webServiceGuide/webServiceGcoderInverse
// gcoder wants location as "lat,lng".
async function regeoTencent(lat, lng) {
  const url = `https://apis.map.qq.com/ws/geocoder/v1/?location=${lat},${lng}&key=${TENCENT_KEY}`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== 0) {
      return { error: { code: String(json?.status ?? 'tencent_error'), message: json?.message || 'tencent failed' } };
    }
    const r = json.result;
    const c = r && r.address_component;
    if (!r) return { error: { code: 'no_result', message: 'no result' } };
    const province = (c && c.province) || '';
    const city = (c && c.city) || province;
    const district = (c && c.district) || '';
    const address = r.address || [province, city, district].filter(Boolean).join('');
    return { address, province, city, district };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

// ── IP → coarse location ──────────────────────────────────────────────────
// Approximates a visitor's position from their IP, for the storefront map
// picker's "locate me" button when precise GPS is unavailable (mini-app: the
// WeChat getLocation interface isn't granted for the AppID; web: the SDK
// geolocation plugin failed/was denied). City-level only — good enough to drop
// the map on the right city so the customer drags a few blocks instead of
// across the country. Returns Promise<{ lat, lng, province, city, district }
// | null>; never throws. Pass the CLIENT ip (the server's own IP would resolve
// to the datacenter).
//
//   • Amap:    https://lbs.amap.com/api/webservice/guide/api/ipconfig (IPv4 only;
//              returns a city bounding `rectangle` → we take its centre)
//   • Tencent: https://lbs.qq.com/service/webService/webServiceGuide/webServiceIp
//              (returns a point directly; handles IPv6)
async function ipLocate(ip) {
  const providers = [];
  if (AMAP_KEY)    providers.push('amap');
  if (TENCENT_KEY) providers.push('tencent');
  if (!providers.length) return null;
  const clean = (ip || '').toString().trim();
  // IPv6 / loopback / private → Amap can't resolve; let Tencent try, else bail.
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(clean);

  let firstErr = null;
  for (const p of providers) {
    if (p === 'amap' && !isIpv4) continue;     // Amap IP API is IPv4-only
    const out = await (p === 'amap' ? ipAmap(clean) : ipTencent(clean));
    if (out && out.lat != null) { _lastError = null; return out; }
    if (out && out.error && !firstErr) firstErr = { ...out.error, provider: p };
  }
  if (firstErr) {
    _lastError = { ...firstErr, addr: clean, ts: Date.now() };
    console.warn('[ipLocate]', firstErr.provider, firstErr.code, firstErr.message, '·', clean);
  }
  return null;
}

async function ipAmap(ip) {
  const url = `https://restapi.amap.com/v3/ip?key=${AMAP_KEY}` + (ip ? `&ip=${encodeURIComponent(ip)}` : '');
  try {
    const json = await fetchJson(url);
    if (json?.status !== '1') {
      return { error: { code: json?.infocode || 'amap_error', message: json?.info || 'amap failed' } };
    }
    // Local/unknown IP → province/city come back as [] (empty arrays).
    const flat = v => Array.isArray(v) ? '' : (v || '');
    const rect = typeof json.rectangle === 'string' ? json.rectangle : '';
    const pts = rect.split(';').map(s => s.split(',').map(Number)).filter(a => a.length === 2 && a.every(isFinite));
    if (pts.length !== 2) return { error: { code: 'no_result', message: 'no rectangle' } };
    const lng = (pts[0][0] + pts[1][0]) / 2;     // rectangle is "lng,lat;lng,lat"
    const lat = (pts[0][1] + pts[1][1]) / 2;
    if (!isFinite(lat) || !isFinite(lng)) return { error: { code: 'bad_coords', message: 'bad coords' } };
    const province = flat(json.province);
    const city = flat(json.city) || province;
    return { lat, lng, province, city, district: '' };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

async function ipTencent(ip) {
  const url = `https://apis.map.qq.com/ws/location/v1/ip?key=${TENCENT_KEY}` + (ip ? `&ip=${encodeURIComponent(ip)}` : '');
  try {
    const json = await fetchJson(url);
    if (json?.status !== 0) {
      return { error: { code: String(json?.status ?? 'tencent_error'), message: json?.message || 'tencent failed' } };
    }
    const r = json.result;
    const loc = r && r.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return { error: { code: 'no_result', message: 'no location' } };
    }
    const ad = (r.ad_info) || {};
    const province = ad.province || '';
    const city = ad.city || province;
    return { lat: loc.lat, lng: loc.lng, province, city, district: ad.district || '' };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

// ── POI search (nearby + keyword) ─────────────────────────────────────────
// Powers the in-app map picker's "search + nearby list" (mirrors WeChat's
// chooseLocation UI). With no keyword → places around the map centre, sorted by
// distance; with a keyword → a text search biased to the centre / city. Returns
// Promise<Array<{name,address,province,city,district,lat,lng,distance}>|null>.
// Never throws.
async function searchPoi({ lat, lng, keyword, city, radius } = {}) {
  const providers = [];
  if (AMAP_KEY)    providers.push('amap');
  if (TENCENT_KEY) providers.push('tencent');
  if (!providers.length) return null;
  const kw = (keyword || '').trim();
  if (!kw && (!isFinite(lat) || !isFinite(lng))) return null;

  let firstErr = null;
  for (const p of providers) {
    const out = await (p === 'amap'
      ? poiAmap({ lat, lng, kw, city, radius })
      : poiTencent({ lat, lng, kw, city, radius }));
    if (out && Array.isArray(out.list)) { _lastError = null; return out.list; }
    if (out && out.error && !firstErr) firstErr = { ...out.error, provider: p };
  }
  if (firstErr) {
    _lastError = { ...firstErr, ts: Date.now() };
    console.warn('[searchPoi]', firstErr.provider, firstErr.code, firstErr.message);
  }
  return null;
}

// Amap returns [] (empty array) for absent string fields — flatten those to ''.
function _flat(v) { return Array.isArray(v) ? '' : (v || ''); }

async function poiAmap({ lat, lng, kw, city, radius }) {
  const url = kw
    ? `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(kw)}&offset=25&page=1&extensions=base`
        + (city ? `&city=${encodeURIComponent(city)}` : '')
        + ((isFinite(lat) && isFinite(lng)) ? `&location=${lng},${lat}` : '')
    : `https://restapi.amap.com/v3/place/around?key=${AMAP_KEY}&location=${lng},${lat}&radius=${radius || 1500}&sortrule=distance&offset=25&page=1&extensions=base`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== '1') {
      return { error: { code: json?.infocode || 'amap_error', message: json?.info || 'amap failed' } };
    }
    const pois = Array.isArray(json.pois) ? json.pois : [];
    const list = pois.map((o) => {
      const loc = typeof o.location === 'string' ? o.location.split(',') : [];
      const plng = parseFloat(loc[0]), plat = parseFloat(loc[1]);
      const region = [_flat(o.pname), _flat(o.cityname), _flat(o.adname)].filter(Boolean).join('');
      const street = _flat(o.address);
      return {
        name: _flat(o.name),
        address: region + street,
        province: _flat(o.pname),
        city: _flat(o.cityname),
        district: _flat(o.adname),
        lat: isFinite(plat) ? plat : null,
        lng: isFinite(plng) ? plng : null,
        distance: (o.distance != null && !Array.isArray(o.distance) && isFinite(Number(o.distance)))
          ? Math.round(Number(o.distance)) : null,
      };
    }).filter((x) => x.name && x.lat != null && x.lng != null);
    return { list };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

async function poiTencent({ lat, lng, kw, city, radius }) {
  // Tencent's place search needs a keyword; for the no-keyword "nearby" case we
  // pass a broad category so the call still returns surrounding places.
  const boundary = kw && city
    ? `region(${encodeURIComponent(city)},0)`
    : `nearby(${lat},${lng},${radius || 1500})`;
  const keyword = kw || '楼宇;住宅区;商务大厦;小区';
  const url = `https://apis.map.qq.com/ws/place/v1/search?key=${TENCENT_KEY}`
    + `&keyword=${encodeURIComponent(keyword)}&boundary=${boundary}`
    + `&orderby=_distance&page_size=20&page_index=1`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== 0) {
      return { error: { code: String(json?.status ?? 'tencent_error'), message: json?.message || 'tencent failed' } };
    }
    const arr = Array.isArray(json.data) ? json.data : [];
    const list = arr.map((o) => ({
      name: o.title || '',
      address: o.address || '',
      province: (o.ad_info && o.ad_info.province) || '',
      city: (o.ad_info && o.ad_info.city) || '',
      district: (o.ad_info && o.ad_info.district) || '',
      lat: o.location ? o.location.lat : null,
      lng: o.location ? o.location.lng : null,
      distance: (o._distance != null && isFinite(o._distance)) ? Math.round(o._distance) : null,
    })).filter((x) => x.name && x.lat != null && x.lng != null);
    return { list };
  } catch (e) {
    return { error: { code: 'network', message: e.message } };
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad_json: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

// Haversine distance in km between two {lat, lng} points. Cheap (5 µs).
function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function configured() { return !!(AMAP_KEY || TENCENT_KEY); }
function provider() { return AMAP_KEY ? 'amap' : (TENCENT_KEY ? 'tencent' : null); }

// True when the last error looks like a daily-quota cap (so the backfill
// can stop early instead of burning calls on every address).
function isQuotaError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return code === '121'                       // Tencent: 此key每日调用量已达到上限
      || /OVER_LIMIT|QPS|超出|上限|配额/.test(code + ' ' + msg)  // Amap infocodes / messages
      || /DAILY_QUERY_OVER_LIMIT/i.test(code);
}

module.exports = { geocodeAddress, reverseGeocode, ipLocate, searchPoi, haversineKm, configured, provider, lastError, isQuotaError };
