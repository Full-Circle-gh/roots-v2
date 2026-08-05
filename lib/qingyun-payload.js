// Turn a roots order into the field bag lib/qingyun-browser createOrder() posts to
// 青云聚信 order/create (a 同城配送 order that lands 待配送 — no courier called).
//
// Lives here, not in the daemon, because TWO callers build the same payload and must
// build it identically:
//   • scripts/qingyun-daemon.js — the auto-push queue drain (the normal path);
//   • routes/retail.js — the ship-from override, which re-creates the order under a
//     DIFFERENT store's Qingyun account when staff want the rider to collect
//     somewhere else.
// A drift between the two would mean the same order reaches the courier with a
// different address or 备注 depending on which path created it, and the 备注 is the
// key the tracking match reads back.
//
// Kept dependency-free (no db, no config lookups) — the caller passes the geocoder,
// the translator and the goods picture, so this module is safe to require from the
// web app.

'use strict';

const norm = (s) => String(s == null ? '' : s).trim();

// Refuse a drop-off pin further than this from the collecting store. Qingyun
// orders are 同城配送 (same-city, one rider, one trip): a pin tens of km out is
// not a long delivery, it is a mis-resolved address. Tunable per deployment.
const MAX_DROP_KM = Number(process.env.QINGYUN_MAX_DROP_KM || 25);

// Qingyun's shop record reports lat/lng in the same GCJ-02 ×1e6 ints the create
// call takes, but older accounts return plain degrees. Both are unambiguous —
// no real Chinese coordinate exceeds ±1000 in degrees.
function toDegrees(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(n) > 1000 ? n / 1e6 : n;
}

function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Join the street line and the floor/unit/room detail WITHOUT repeating the part
// they share. The two fields overlap constantly — a customer types the building
// into the street box ('品秀星越花园A栋') and again at the head of the detail
// ('A栋18层1801室'), because that is how a Chinese address reads. Naive
// concatenation printed it twice on the waybill ('…花园A栋 A栋18层1801室') and,
// worse, fed the doubled text to the geocoder, which is exactly the kind of
// malformed string that makes it give up and return a district centroid.
function joinStreetDetail(street, detail) {
  const s = norm(street), d = norm(detail);
  if (!s) return d;
  if (!d) return s;
  if (s.includes(d)) return s;          // detail already spelled out in the street
  if (d.includes(s)) return d;          // detail is the fuller of the two
  const rest = stripSharedHead(s, d);
  return rest ? `${s} ${rest}` : s;
}

// Drop the leading run of `d` that repeats the tail of `s` ('…花园A栋' + 'A栋18层…'
// → '18层…'). Two characters minimum, so a single coincidentally-shared char
// ('号' / '室') never eats a real part of the detail.
function stripSharedHead(s, d) {
  const max = Math.min(s.length, d.length);
  for (let n = max; n >= 2; n--) {
    if (s.slice(-n) === d.slice(0, n)) {
      return d.slice(n).replace(/^[\s,，、.。;；:：\-–—]+/u, '').trim();
    }
  }
  return d;
}

function hasLatin(s) { return /[A-Za-z]/.test(String(s || '')); }

// order  — a retail_orders row (order_no, recipient_name/phone, address_json,
//          scheduled_for, delivery_slot_label)
// shop   — { shopId, cityId, lat?, lng? } from browser.getShop() for the SENDING
//          store; this is what decides where the rider collects
// br     — the Qingyun browser (used only for its POI-search geocode fallback)
// deps   — { geocode: lib/geocode, goodsPicUrl, onWarn, translateCn? }
//          translateCn(parts) → { province, city, district, street } | null
//          (lib/address-cn.translateToChinese). Optional: without it an
//          English-only address is still pushed, just untranslated.
// Throws (→ the caller retries, then ops-alerts) when the order lacks the
// essentials OR when no pin can be trusted. Refusing is deliberate: a wrong pin
// costs a wasted rider and a late order, and it is invisible until the customer
// complains, whereas a refusal pages someone who can fix the address in seconds.
async function buildCreatePayload(order, shop, br, deps = {}) {
  const { geocode, goodsPicUrl, onWarn, translateCn } = deps;
  const warn = (m) => { if (onWarn) onWarn(m); };
  let addr = {}; try { addr = JSON.parse(order.address_json || '{}') || {}; } catch { addr = {}; }
  const name  = norm(order.recipient_name || addr.name || addr.contact);
  const phone = norm(order.recipient_phone || addr.phone || addr.mobile);
  // Recipient address: the street/building line plus the floor/unit/room detail
  // ('901房') folded in. Qingyun keeps only recipientAddress reliably — the separate
  // recipientDoorInfo field is not surfaced to the courier — so a room number that
  // lives only in addr.detail would otherwise silently drop and need manual re-entry.
  let region   = { province: norm(addr.province), city: norm(addr.city), district: norm(addr.district) };
  let street   = norm(addr.address) || norm([region.city, region.district, addr.address].filter(Boolean).join(''));
  let detail   = norm(addr.detail);
  let text     = joinStreetDetail(street, detail);
  if (!name || !phone || !text) throw new Error('missing recipient name/phone/address');

  // ── English → Chinese, before anything reads the text ──────────────────
  // The rider gets Chinese on the waybill, and the geocode below runs against
  // Chinese too (Latin street text is what pushes the mainland geocoders into
  // returning a district centroid). Only rewrites when the model actually
  // answers; a miss keeps the original, so this can never blank an address.
  let translated = false;
  if (hasLatin(text) && typeof translateCn === 'function') {
    try {
      const cn = await translateCn({
        province: region.province, city: region.city, district: region.district,
        address: street, detail,
        full: [region.province, region.city, region.district, street, detail].filter(Boolean).join(' '),
      });
      if (cn && cn.street && !hasLatin(cn.street)) {
        region = {
          province: cn.province || region.province,
          city:     cn.city     || region.city,
          district: cn.district || region.district,
        };
        street = cn.street;
        detail = hasLatin(detail) ? '' : detail;   // the Chinese street already folds it in
        text = joinStreetDetail(street, detail);
        translated = true;
        warn(`translated address to Chinese for ${norm(order.order_no)}: ${text}`);
      } else {
        warn(`address still English for ${norm(order.order_no)} — translation unavailable`);
      }
    } catch (e) { warn(`address translation failed for ${norm(order.order_no)}: ${e.message}`); }
  }

  // Resolve the drop-off pin (Qingyun wants GCJ-02 ×1e6; the app's geocoders + the
  // mini-app map picker are all GCJ-02, so datums match). Chain, most-reliable first:
  //   1) the order's own coords (customer picked a pin, snapshotted at checkout) —
  //      best, language-agnostic, and the only source that is not a guess;
  //   2) the app's Amap/Tencent geocoder over the Chinese 省/市/区 + street — but
  //      ONLY when the provider says it matched a building or a road (see
  //      isDeliverablePin); a district-centroid answer is thrown away;
  //   3) Qingyun's own POI search (weak on English) as a last automatic try;
  //   4) give up → the caller retries then ops-alerts (never guesses a wrong spot).
  // Whatever wins is then distance-checked against the collecting store.
  const shopPt = { lat: toDegrees(shop && shop.lat), lng: toDegrees(shop && shop.lng) };
  let lng = null, lat = null, cityId = shop.cityId;
  let source = null, precision = null, dropKm = null;

  const dLng = Number(addr.lng), dLat = Number(addr.lat);
  if (Number.isFinite(dLng) && Number.isFinite(dLat) && dLng !== 0 && dLat !== 0) {
    lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
    source = norm(addr.geo_source) || 'order_pin';
    precision = norm(addr.geo_precision) || null;
  } else {
    let g = null;
    try {
      if (geocode && geocode.configured()) {
        const c = await geocode.geocodeAddress({
          province: region.province, city: region.city, district: region.district,
          address: joinStreetDetail(street, detail) || text,
        });
        // Trust it only if the provider matched a building or a road AND landed in
        // the city we asked for. Everything else is a centroid wearing a real
        // answer's clothes — the 20-30 km "wrong address" the courier app shows.
        const verdict = c ? geocode.isDeliverablePin(c) : { ok: false, reason: 'no_result' };
        if (verdict.ok) {
          g = { lng: Math.round(Number(c.lng) * 1e6), lat: Math.round(Number(c.lat) * 1e6), cityId: shop.cityId };
          source = `geocode:${c.provider || 'maps'}`;
          precision = c.precision;
        } else if (c) {
          warn(`rejected ${c.provider || 'maps'} pin for ${norm(order.order_no)} (${verdict.reason}, matched "${(c.matched && c.matched.formatted) || ''}")`);
        }
      }
    } catch (e) { warn(`maps geocode failed for ${norm(order.order_no)}: ${e.message}`); }
    if (!g && !hasLatin(text)) {
      // Qingyun's POI search is city-bounded and returns real POIs, but it takes
      // the top hit blindly — only worth trying on Chinese text, and it still has
      // to clear the distance check below.
      g = await br.geocode(text, shop.cityId);
      if (g) { source = 'qingyun_poi'; precision = 'poi'; }
    }
    if (!g) throw new Error('geocode failed for address (no pin, no precise match)');
    lng = g.lng; lat = g.lat; cityId = g.cityId || shop.cityId;
  }

  // ── Final sanity check: is this pin even in delivery range? ─────────────
  // Cheap, provider-independent, and the only check that catches what the ones
  // above cannot see — a stale pin, a same-name estate in the next city, a POI
  // hit on the wrong branch of a chain. Distance alone doesn't prove a pin
  // wrong, though: a genuine long same-city delivery exists. So it only refuses
  // when the pin is ALSO weakly sourced. A pin the customer tapped, or one a
  // provider matched down to the building, is trusted and merely warned about —
  // a far-but-precise address is a long delivery, a far-but-vague one is a
  // mis-resolved address and costs a wasted rider.
  const dropPt = { lat: lat / 1e6, lng: lng / 1e6 };
  const trusted = source === 'order_pin' || source === 'customer_pin' || precision === 'rooftop';
  if (shopPt.lat != null && shopPt.lng != null) {
    dropKm = haversineKm(shopPt, dropPt);
    if (dropKm != null && dropKm > MAX_DROP_KM) {
      const msg = `drop-off is ${dropKm.toFixed(1)}km from ${norm(shop.name) || 'the store'}`
        + ` (limit ${MAX_DROP_KM}km, pin from ${source || 'unknown'}) — address "${text}"`;
      if (trusted) warn(`${norm(order.order_no)}: ${msg} — sending anyway (precise pin)`);
      else throw new Error(msg);
    }
  }

  // Delivery time: a chosen slot → its epoch; else ASAP (~1h out). 待配送 only, so
  // this is informational until staff dispatch.
  const slotEpoch = order.scheduled_for ? Math.floor(Date.parse(order.scheduled_for) / 1000) : 0;
  const target = (slotEpoch && slotEpoch > Math.floor(Date.now() / 1000)) ? slotEpoch : Math.floor(Date.now() / 1000) + 3600;

  const slot = norm(order.delivery_slot_label);
  const remark = (norm(order.order_no) + (slot ? ` · ${slot}` : '')).slice(0, 200);
  const doorInfo = norm(detail && detail !== text ? detail : '');

  return {
    shopId: shop.shopId,
    recipientName: name, recipientPhone: phone, recipientAddress: text, doorInfo,
    recipientLng: lng, recipientLat: lat, cityId,
    goods: [{ name: `Roots ${norm(order.order_no)}`, price: 0, count: 1 }],
    goodsPicUrl: norm(goodsPicUrl),
    remark, expectFrom: target, expectTo: target,
    // Provenance for the push log — how this pin was obtained, how exact the
    // provider said it was, and how far the rider will travel. Ignored by
    // createOrder(); it only reads the named fields above.
    _geo: { source, precision, dropKm: dropKm == null ? null : Math.round(dropKm * 10) / 10, translated },
  };
}

module.exports = { buildCreatePayload, joinStreetDetail, MAX_DROP_KM };
