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
// not a long delivery, it is a mis-resolved address. Tunable per deployment via
// QINGYUN_MAX_DROP_KM.
//
// NOTE FOR DEPLOYMENT: this module is loaded by BOTH the daemon
// (scripts/qingyun-daemon.js) and the web app (the ship-from override in
// routes/retail.js). They are separate processes with separate environments —
// set the variable in both, or the same order behaves differently depending on
// which path created it.
//
// A bad value must not silently change the rule in either direction: '0' would
// refuse every geocoded order, and a non-numeric value would make `km > NaN`
// false and disable the check altogether. Both fall back to the default, once,
// loudly.
const DEFAULT_MAX_DROP_KM = 25;
const MAX_DROP_KM = (() => {
  const raw = process.env.QINGYUN_MAX_DROP_KM;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_DROP_KM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[qingyun-payload] QINGYUN_MAX_DROP_KM="${raw}" is not a positive number — using ${DEFAULT_MAX_DROP_KM}km`);
    return DEFAULT_MAX_DROP_KM;
  }
  return n;
})();

// The same validation as MAX_DROP_KM, for the other tunables. A bad value must
// never silently change a safety rule.
function positiveEnvKm(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[qingyun-payload] ${name}="${raw}" is not a positive number — using ${fallback}`);
    return fallback;
  }
  return n;
}

// The OUTER ceiling. MAX_DROP_KM is a suspicion threshold — past it a weakly
// sourced pin is refused and a precise one is merely warned about, because a
// genuine long same-city delivery exists. This is different: past this distance
// there is no such thing as a same-city rider trip, so NOTHING ships, whatever
// the pin claims to be. It exists because 'customer_pin' is asserted by the
// client — the map handlers set it honestly, but the server cannot verify a tap,
// and without a hard stop a single bad coordinate would bypass every check
// above it. Default: twice MAX_DROP_KM.
const ABS_MAX_KM = positiveEnvKm('QINGYUN_ABS_MAX_KM', MAX_DROP_KM * 2);

// How close a fresh re-resolve has to land to an UNVERIFIED stored pin before we
// accept that pin as corroborated. Half a kilometre is well inside "same
// building complex" and well outside "district centroid".
const PIN_AGREE_KM = positiveEnvKm('QINGYUN_PIN_AGREE_KM', 0.5);

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

// A COMPLETE building token: 'A栋', '1栋', '3座', '二幢', '1号楼'. Anchored, so
// the whole shared head has to be one — a bare '1号' (a STREET number) is not.
const BUILDING_TOKEN = /^(?:[A-Za-z0-9一-鿿]{1,4}[栋座幢]|\d{1,4}号楼)$/u;

// A unit word left with nothing in front of it. If stripping would produce
// '楼2单元' or '室301', we removed something load-bearing and must not.
const ORPHAN_UNIT = /^[\s,，、.。;；:：\-–—]*(?:号楼|单元|楼|层|室|栋|座|幢)/u;

// Drop the leading run of `d` that repeats the tail of `s` ('…花园A栋' + 'A栋18层…'
// → '18层…').
//
// The shared run must be a complete BUILDING token, not merely a shared string.
// Matching on raw overlap corrupts a legitimate address: '中山一路1号' + '1号楼2单元'
// shares '1号', and stripping it turns building 1 into a bare '楼2单元' — the
// building number silently deleted off the waybill. Two independent guards:
// the head has to look like a building token, and the remainder must not start
// with an orphaned unit word.
function stripSharedHead(s, d) {
  const max = Math.min(s.length, d.length);
  for (let n = max; n >= 2; n--) {
    const head = d.slice(0, n);
    if (s.slice(-n) !== head) continue;
    if (!BUILDING_TOKEN.test(head)) continue;
    const rest = d.slice(n).replace(/^[\s,，、.。;；:：\-–—]+/u, '').trim();
    if (!rest || ORPHAN_UNIT.test(rest)) continue;
    return rest;
  }
  return d;
}

function hasLatin(s) { return /[A-Za-z]/.test(String(s || '')); }

// A HOLD, not a refusal: the geocoder itself was unreachable (quota, timeout,
// network), so we learned nothing about this address. Refusing here would turn a
// provider outage into a queue of dead orders that nobody can fix, because there
// was never anything wrong with them. The daemon keeps the row pending, does NOT
// spend an attempt, and pages ops if the outage outlasts the alert threshold.
function geoHoldError(message, failure) {
  const e = new Error(`geocoder unavailable — holding: ${message}`);
  e.geoHold = true;
  e.geoFailure = failure || null;
  e._geo = { source: null, precision: null, dropKm: null, translated: false, held: true };
  return e;
}

// A refusal that still carries what we know about the pin, so the push log can
// print the same [pin source/grade, km] provenance on a refusal as on a success
// — the refusal is precisely when someone needs to know which of the three
// sources was in play and how far off it landed.
function geoError(message, geo) {
  const e = new Error(message);
  e._geo = {
    source: (geo && geo.source) || null,
    precision: (geo && geo.precision) || null,
    dropKm: (geo && geo.dropKm != null) ? Math.round(geo.dropKm * 10) / 10 : null,
    translated: !!(geo && geo.translated),
    refused: true,
  };
  return e;
}

// What the operator reads on a parked order. It is stored verbatim as the
// queue row's last_error and rendered raw in the admin drawer, so it has to
// stand on its own — bilingual like every other server-written staff string
// (the ops alerts, the sync log), because the drawer prints this one as-is
// rather than through the UI's own translator.
//
// Says what happened and what to do, in that order, and nothing else. No
// coordinates, no precision grade, no provider name: an operator cannot act on
// 'geocode:amap/coarse' and should not have to read it. The engineer's version
// — grade, verdict reason, distances — goes to the push log, which is where
// someone debugging a bad pin is already looking.
//
// Deliberately "precisely enough" rather than "to a coarse area": this same
// message covers a text that resolved to a district centroid, one the provider
// could not find at all, and one it placed in the WRONG CITY. Only the first is
// a coarse area, and a message that describes the wrong failure is how the
// previous one went stale.
const NEEDS_POINT_MESSAGE =
  '无法将该地址定位到足够精确的位置，需要人工确认配送点 · '
  + "We couldn't place this address precisely enough to send a rider — someone needs to confirm the delivery point";

// NOT a failure: a step nobody has done yet. The address only resolves to a
// coarse area and the order's own coordinates have no provenance, so we do not
// know the door to within kilometres — but neither did anyone do anything
// wrong. That coordinate was almost certainly written by one of our own text
// geocodes, and re-asking the same provider the same question gets the same
// answer, so retrying is pointless by construction. The caller parks the row in
// needs_point with the guessed point attached, spends no attempt, and waits for
// a person to confirm the spot on a map (lib/qingyun-queue NEEDS_POINT_SQL).
//
// `point` is what we WOULD have sent — kept so the confirm map opens on the
// best guess we have rather than on an empty country. It still carries the
// refusal's _geo provenance, so the push log prints the same [pin …] tag it
// always did and a parked row is as traceable as a refused one was.
function needsPointError(message, geo, point) {
  const e = geoError(message, geo);
  e.needsPoint = true;
  const lat = Number(point && point.lat), lng = Number(point && point.lng);
  e.point = (Number.isFinite(lat) && Number.isFinite(lng))
    ? { lat, lng, precision: (point && point.precision) || null }
    : null;
  return e;
}

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
//
// Three flavours of throw, and the caller must tell them apart:
//   err.geoHold    — the geocoder was unreachable. Hold, spend no attempt.
//   err.needsPoint — the address only resolves to a coarse area and the order's
//                    coordinates have no provenance. Park in needs_point with
//                    err.point as the opening guess, spend no attempt, wait for
//                    a person. Not an error.
//   neither        — a genuine refusal. Retry, then page.
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
  if (!name || !phone || !text) throw geoError('missing recipient name/phone/address', {});

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

  // One re-usable resolve of the address text, memoised — the unverified-pin
  // corroboration below and the no-pin path want the same answer.
  // Also reports WHY it came back empty. A provider that answered "nothing here"
  // is evidence about the address; a provider that never answered is not, and the
  // two must not lead to the same outcome.
  let _fresh; let _freshFailure = null; let _freshDone = false;
  const resolveText = async () => {
    if (_freshDone) return _fresh;
    _freshDone = true; _fresh = null;
    try {
      if (geocode && geocode.configured()) {
        if (typeof geocode.geocodeAddressResult === 'function') {
          const out = await geocode.geocodeAddressResult({
            province: region.province, city: region.city, district: region.district,
            address: joinStreetDetail(street, detail) || text,
          });
          _fresh = out && out.result;
          _freshFailure = (out && out.failure) || null;
        } else {
          _fresh = await geocode.geocodeAddress({
            province: region.province, city: region.city, district: region.district,
            address: joinStreetDetail(street, detail) || text,
          });
        }
      }
    } catch (e) {
      // A throwing geocoder is a failure, not an answer — same treatment.
      _freshFailure = { code: 'exception', message: e.message };
      warn(`maps geocode failed for ${norm(order.order_no)}: ${e.message}`);
    }
    return _fresh;
  };

  const dLng = Number(addr.lng), dLat = Number(addr.lat);
  const hasStoredPin = Number.isFinite(dLng) && Number.isFinite(dLat) && dLng !== 0 && dLat !== 0;

  // A stored pin is only trusted when we know where it came from. Rows written
  // before provenance was recorded — and rows the old geocode-backfill filled —
  // routinely hold a DISTRICT CENTROID, and treating "there are coordinates" as
  // "the customer pointed here" is exactly the bug this module exists to stop.
  // Trusted: a map-picked pin, or a geocode the provider graded rooftop/street
  // with the region cross-check passed (which is what geocodeAddressAsync
  // records). Everything else is unverified and has to earn it below.
  // 'staff_pin' is the third trusted source: an operator opened the order, read
  // the address against a map, and put the point on the building. It is the only
  // source on this list a human placed deliberately, and it carries NO precision
  // grade — nobody measured one, and inventing 'rooftop' to make it look
  // confident is the same laundering this block exists to stop. The grade's
  // absence is why the distance check below has to name the source instead.
  const storedSource = norm(addr.geo_source);
  const storedPrecision = norm(addr.geo_precision);
  const pinIsTrusted = storedSource === 'customer_pin'
    || storedSource === 'staff_pin'
    || (/^geocode:/.test(storedSource) && (storedPrecision === 'rooftop' || storedPrecision === 'street'));

  if (hasStoredPin && pinIsTrusted) {
    lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
    source = storedSource; precision = storedPrecision || null;
  } else if (hasStoredPin) {
    // Unverified pin: corroborate it against a fresh resolve of the text. Agree
    // within PIN_AGREE_KM → the stored pin is real, ship it (and keep it, since
    // it may be more exact than the text match). Drift, or a fresh resolve too
    // coarse to judge by, → we have no evidence the pin is the door, so it falls
    // through to the same refusal rules as a missing pin.
    const c = await resolveText();
    const verdict = c ? geocode.isDeliverablePin(c) : { ok: false, reason: 'no_result' };
    const driftKm = (c && c.lat != null)
      ? haversineKm({ lat: dLat, lng: dLng }, { lat: Number(c.lat), lng: Number(c.lng) })
      : null;
    if (verdict.ok && driftKm != null && driftKm <= PIN_AGREE_KM) {
      lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
      source = `${storedSource || 'order_pin'}+verified`;
      precision = c.precision;
      warn(`${norm(order.order_no)}: unverified stored pin corroborated within ${driftKm.toFixed(2)}km — shipping it`);
    } else if (verdict.ok) {
      // The text resolves precisely somewhere ELSE. The text is what a human can
      // check; the pin's origin is unknown. Take the verified resolve.
      lng = Math.round(Number(c.lng) * 1e6); lat = Math.round(Number(c.lat) * 1e6);
      source = `geocode:${c.provider || 'maps'}`;
      precision = c.precision;
      warn(`${norm(order.order_no)}: stored pin disagrees with the address by `
        + `${driftKm == null ? '?' : driftKm.toFixed(1)}km — using the resolved address instead`);
    } else if (_freshFailure) {
      // The geocoder never answered. We know nothing new about this pin — not
      // that it is good, not that it is bad — so we hold rather than decide.
      throw geoHoldError(`could not corroborate the stored pin for ${norm(order.order_no)}`
        + ` (${_freshFailure.code || 'error'}${_freshFailure.quota ? ', quota' : ''})`, _freshFailure);
    } else if (!geocode || !geocode.configured()) {
      // No maps key at all: nothing can corroborate anything. Refusing every
      // order on an unkeyed deployment would be worse than shipping the pin we
      // have, so keep it — and say plainly that it is unverified.
      lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
      source = `${storedSource || 'order_pin'}+unverifiable`;
      precision = storedPrecision || null;
      warn(`${norm(order.order_no)}: no geocoder configured — shipping an UNVERIFIED stored pin`);
    } else {
      // Nothing here knows the door. Hand it to a person instead of refusing:
      // the stored coordinate goes with it as the opening guess, because it is
      // the point this order has been carrying and the one the map should drop.
      // Its grade is whatever provenance the row recorded — null when the
      // coordinate arrived from a client with no claim about where it came
      // from, which is honest: we genuinely do not know how exact it is.
      warn(`${norm(order.order_no)}: stored pin has no recorded provenance and the address `
        + `only resolves to ${(c && c.precision) || 'nothing'} (${verdict.reason}) — needs a confirmed point`);
      throw needsPointError(NEEDS_POINT_MESSAGE,
        { source: storedSource || 'order_pin', precision: storedPrecision, translated },
        { lat: dLat, lng: dLng, precision: storedPrecision || null });
    }
  } else {
    let g = null;
    const c = await resolveText();
    // Trust it only if the provider matched a building or a road AND landed in
    // the region we asked for. Everything else is a centroid wearing a real
    // answer's clothes — the 20-30 km "wrong address" the courier app shows.
    const verdict = c ? geocode.isDeliverablePin(c) : { ok: false, reason: 'no_result' };
    if (verdict.ok) {
      g = { lng: Math.round(Number(c.lng) * 1e6), lat: Math.round(Number(c.lat) * 1e6), cityId: shop.cityId };
      source = `geocode:${c.provider || 'maps'}`;
      precision = c.precision;
    } else if (c) {
      warn(`rejected ${c.provider || 'maps'} pin for ${norm(order.order_no)} (${verdict.reason}, matched "${(c.matched && c.matched.formatted) || ''}")`);
    }
    if (!g && !hasLatin(text)) {
      // Qingyun's POI search is city-bounded and returns real POIs, but it takes
      // the top hit blindly — only worth trying on Chinese text, and it still has
      // to clear the distance check below.
      g = await br.geocode(text, shop.cityId);
      if (g) { source = 'qingyun_poi'; precision = 'poi'; }
    }
    if (!g && _freshFailure) {
      // Same distinction with no stored pin: an outage is not evidence that the
      // address is bad, and the POI fallback (which is city-bounded and blind)
      // didn't rescue it either.
      throw geoHoldError(`could not resolve the address for ${norm(order.order_no)}`
        + ` (${_freshFailure.code || 'error'}${_freshFailure.quota ? ', quota' : ''})`, _freshFailure);
    }
    if (!g) throw geoError('geocode failed for address (no pin, no precise match)',
      { source: null, precision: (c && c.precision) || null, translated });
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
  // Trusted here means "we know this is the door": the customer tapped it, an
  // operator placed it on a map, or a provider matched it down to a building. A
  // street-level or corroborated-only pin is good enough to deliver to but not
  // good enough to override a distance that says the address was mis-resolved.
  //
  // 'staff_pin' is named explicitly rather than riding on a precision grade,
  // because it has none and must not be given one. Without this line a
  // confirmed point more than MAX_DROP_KM out would be refused straight after a
  // human had looked at the map and said that is the door — a long same-city
  // delivery, killed by the absence of a number nobody ever measured.
  const trusted = source === 'customer_pin' || source === 'staff_pin' || precision === 'rooftop';
  if (shopPt.lat != null && shopPt.lng != null) {
    dropKm = haversineKm(shopPt, dropPt);
    // The hard stop first: past ABS_MAX_KM nothing ships, whatever the pin says
    // it is. 'customer_pin' is a claim the client makes and the server cannot
    // check, so without this a single bad coordinate walks straight through
    // every gate above by asserting it was tapped.
    if (dropKm != null && dropKm > ABS_MAX_KM) {
      throw geoError(
        `drop-off is ${dropKm.toFixed(1)}km from ${norm(shop.name) || 'the store'} — beyond the `
        + `${ABS_MAX_KM}km same-city ceiling, refusing regardless of pin source (${source || 'unknown'})`,
        { source, precision, dropKm, translated });
    }
    if (dropKm != null && dropKm > MAX_DROP_KM) {
      const msg = `drop-off is ${dropKm.toFixed(1)}km from ${norm(shop.name) || 'the store'}`
        + ` (limit ${MAX_DROP_KM}km, pin from ${source || 'unknown'}) — address "${text}"`;
      if (trusted) warn(`${norm(order.order_no)}: ${msg} — sending anyway (precise pin)`);
      else throw geoError(msg, { source, precision, dropKm, translated });
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

module.exports = {
  buildCreatePayload, joinStreetDetail, MAX_DROP_KM, ABS_MAX_KM, PIN_AGREE_KM,
  NEEDS_POINT_MESSAGE,
};
