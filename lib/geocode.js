// Tiny geocoding wrapper for Tencent Maps (lbs.qq.com).
//
// Goal: hand it an address (province + city + district + street) and get
// back lat/lng. Used by:
//   • retail.js POST/PUT /addresses → background geocode customer addresses
//   • retail-inventory.js store CRUD → geocode store addresses
//   • lib/inventory.js routeOrder()  → Haversine distance for "closest store"
//
// Configuration:
//   Set TENCENT_MAPS_KEY in /root/roots-v2/.env. Get one at lbs.qq.com
//   (free tier: 10K requests/day, plenty for a small business). When the
//   key is missing the helper returns null and routing silently falls
//   back to district-name matching.
//
// Caching:
//   Identical address strings are cached in-memory for 7 days so repeat
//   geocodes (e.g. customer edits an address but doesn't change the
//   street) don't burn quota. The cache resets on every PM2 restart;
//   that's fine because the lat/lng is also written to the DB row.

const https = require('https');

const KEY = process.env.TENCENT_MAPS_KEY || '';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const cache = new Map();   // normalizedAddr -> { lat, lng, ts }

function normalize({ province, city, district, address }) {
  const region = [province, city, district].map(s => (s || '').trim()).filter(Boolean);
  // Legacy rows sometimes baked the full "省 市 区" prefix into the freeform
  // street field. Joining it after the structured region then doubled the
  // prefix (e.g. "广东省 广州市 天河区 广东省 广州市 天河区 …"), which Tencent
  // geocodes poorly. Strip any leading region tokens (any order, repeated)
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
async function geocodeAddress(parts) {
  if (!KEY) return null;
  const addr = normalize(parts);
  if (!addr) return null;

  const cached = cache.get(addr);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return { lat: cached.lat, lng: cached.lng, cached: true };
  }

  const url = `https://apis.map.qq.com/ws/geocoder/v1/?address=${encodeURIComponent(addr)}&key=${KEY}`;
  try {
    const json = await fetchJson(url);
    if (json?.status !== 0) {
      console.warn('[geocode] tencent', json?.status, json?.message, '·', addr);
      return null;
    }
    const loc = json.result?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
    const out = { lat: loc.lat, lng: loc.lng };
    cache.set(addr, { ...out, ts: Date.now() });
    return out;
  } catch (e) {
    console.warn('[geocode] failed:', e.message, '·', addr);
    return null;
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

function configured() { return !!KEY; }

module.exports = { geocodeAddress, haversineKm, configured };
