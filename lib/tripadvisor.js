// TripAdvisor star ratings for the brand website's contact block (decisions
// §503 rules 23–25). Read from the official Content API, never from
// TripAdvisor's pages, which refuse automated reads and whose terms forbid
// them. One platform key, TRIPADVISOR_API_KEY. Each listing is read at most
// once a day and held in memory; a failed read keeps the last good answer.
'use strict';

const API = 'https://api.content.tripadvisor.com/api/v1/location/';
const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;      // after a failure, try again in an hour
const TIMEOUT_MS = 8000;

// locationId -> { at, data, failedAt, inflight }
const cache = new Map();

// The location id in a TripAdvisor link: …-g298555-d34751233-Reviews-…
function locationIdFromUrl(url) {
  const m = String(url || '').match(/^https:\/\/(?:www\.)?tripadvisor\.[a-z.]+\/[^\s]*?-d(\d{3,12})-/i);
  return m ? m[1] : null;
}

function clean(json) {
  const rating = Number(json && json.rating);
  const count = Number(json && json.num_reviews);
  if (!(rating >= 0 && rating <= 5)) return null;
  const img = String((json && json.rating_image_url) || '');
  const web = String((json && json.web_url) || '');
  return {
    rating: Math.round(rating * 10) / 10,
    num_reviews: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    rating_image_url: /^https:\/\/[^\s"'<>]+$/i.test(img) ? img : '',
    web_url: /^https:\/\/(?:www\.)?tripadvisor\.[^\s"'<>]+$/i.test(web) ? web : '',
  };
}

async function fetchDetails(id, { referer } = {}) {
  const key = process.env.TRIPADVISOR_API_KEY;
  if (!key) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { accept: 'application/json' };
    // A key restricted to the website's domain checks the Referer.
    if (referer) headers.referer = referer;
    const r = await fetch(API + encodeURIComponent(id) + '/details?language=en&key=' + encodeURIComponent(key), { headers, signal: ctl.signal });
    if (!r.ok) throw new Error('tripadvisor_http_' + r.status);
    return clean(await r.json());
  } finally {
    clearTimeout(t);
  }
}

// The rating for one listing, or null when there is none to show. Never
// throws: the website shows the link without stars instead.
async function ratingFor(id, opts = {}) {
  if (!/^\d{3,12}$/.test(String(id || ''))) return null;
  const now = Date.now();
  let e = cache.get(id);
  if (!e) { e = { at: 0, data: null, failedAt: 0, inflight: null }; cache.set(id, e); }
  const fresh = e.data && now - e.at < TTL_MS;
  const resting = e.failedAt && now - e.failedAt < RETRY_MS;
  if (fresh || resting) return e.data;
  if (!e.inflight) {
    e.inflight = fetchDetails(id, opts)
      .then(data => { if (data) { e.data = data; e.at = Date.now(); e.failedAt = 0; } else { e.failedAt = Date.now(); } })
      .catch(err => {
        e.failedAt = Date.now();
        console.warn('[tripadvisor] rating read failed for', id, '-', err && err.message);
      })
      .finally(() => { e.inflight = null; });
  }
  await e.inflight;
  return e.data;
}

module.exports = { locationIdFromUrl, ratingFor, _cache: cache };
