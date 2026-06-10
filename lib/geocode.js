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

module.exports = { geocodeAddress, haversineKm, configured, provider, lastError, isQuotaError };
