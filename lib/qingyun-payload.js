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

// ── Coarse, but close ─────────────────────────────────────────────────────
// A coarse grade says the provider matched an AREA rather than a door. That is
// a reason to distrust a point, but on its own it is not a reason to refuse
// one, because how wrong a centroid can be is bounded by how far away it sits.
// A district centroid 5 km from the collecting store is not a same-named
// estate in the next city; there is nowhere wrong for it to be that close. The
// rider carries the full address text and phones on arrival, which is how
// every delivery worked before the precision gate landed on 2026-08-05.
//
// The gate was introduced with the 28.1 km pin of Qingyun order #4 as its
// evidence — and that order is refused by the MAX_DROP_KM check alone, since a
// coarse pin is not `trusted` below. So refusing a coarse point that is close
// to the store never protected against the case it was built for, and it does
// park correct addresses: the map has no house number for 科翔路104号, which
// says nothing about whether the address is right.
//
// Hence: coarse and near the store ships; coarse out near the refusal limit
// still parks. At 24 km a vague answer looks exactly like a wrong match, and
// there is no margin left to absorb the error. Default is half MAX_DROP_KM.
//
// This launders NOTHING. The source keeps its own name with '+coarse_near'
// appended, no precision grade is invented, and `trusted` below still excludes
// it — so ABS_MAX_KM and every other check apply unchanged. It widens exactly
// one decision: park the order, or ship a nearby guess.
const COARSE_OK_KM = positiveEnvKm('QINGYUN_COARSE_OK_KM', MAX_DROP_KM / 2);

// ── When a name-search hit may be taken without asking ────────────────────
// See nameScore() for what the number means and why it has to be computed here
// rather than read off a response. These three are the whole confidence test,
// and each one is doing separate work:
//
// POI_AUTO_SCORE (0.67) — the shared run must be the MAJORITY of the longer
//   name: two thirds, so a hit may differ from what the customer typed by at
//   most a third and still be taken silently. 祈福新村 against 祈福新村倚湖湾
//   scores 0.57 and is therefore asked about, which is correct — it is the
//   estate, not the tower, and the estate is a 20-minute walk across.
//
// POI_AUTO_MARGIN (0.20) — with a 0.67 floor, requiring the runner-up to be a
//   fifth of the scale behind puts it below 0.47: under half-matched, i.e.
//   visibly a different place. Two hits that both look right are the case a
//   person should settle, and the whole point of the ask state.
//
// POI_MIN_SHARED (3) — an ABSOLUTE floor under the ratio, because a ratio on
//   short strings inflates: two 2-character names sharing both characters score
//   1.00 on evidence nobody would accept. Chinese estate names are effectively
//   never shorter than three characters, so three shared characters is the
//   least that can mean anything.
//
// None of the three is a safety boundary. MAX_DROP_KM and ABS_MAX_KM are, and
// they apply to an auto-taken hit exactly as they apply to anything else —
// see `trusted` below, which deliberately does not name the POI sources.
const POI_AUTO_SCORE  = 0.67;
const POI_AUTO_MARGIN = 0.20;
const POI_MIN_SHARED  = 3;

// How many candidates the ask state offers. Three fits the drawer without
// scrolling and is as many as anyone can hold side by side; a fourth is not a
// choice, it is a list.
const POI_CANDIDATES = 3;

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

// ── What a map can find, and what only a rider can ────────────────────────
// A Chinese residential address is two different kinds of string glued
// together, and they want two different lookups:
//
//   祈福新村倚湖湾 · 5座1106
//   ^^^^^^^^^^^^^   ^^^^^^^^
//   a NAMED PLACE   the LAST MILE
//
// The named part is a 小区 / building complex / road — something a map indexes
// and can return a coordinate for. The last mile is the 座/栋/单元/室/房/楼 tail,
// which no map indexes: it is what the rider reads off the waybill once they
// are standing at the gate.
//
// Sending the whole string to a GEOCODER is what parks these orders. Geocoding
// matches street + house-number data; it has no 小区 index at all, and the tail
// actively poisons the match — an unmatchable suffix is exactly what makes a
// provider give up and hand back a district centroid. Sending the whole string
// to a NAME SEARCH is no better: nothing is called 祈福新村倚湖湾5座1106.
//
// So the tail comes off before the lookup, and ONLY before the lookup. This
// function is read by the resolver and by nothing else; `recipientAddress` on
// the wire is still joinStreetDetail's output, unchanged, tail and all. The
// rider needs 5座1106 more than anyone.
//
// ── On '号', which is deliberately NOT a cut point ──────────────────────────
// The unit vocabulary here is the same one BUILDING_TOKEN and ORPHAN_UNIT
// already use, with one exception: a bare '号' stays in the findable part.
// '号' is overwhelmingly a STREET number ('中山一路1号'), and cutting there
// deletes the number off the very address the geocoder fallback needs — the
// identical corruption stripSharedHead exists to prevent, committed one layer
// up. Only '号楼' is a building, and only '号楼' cuts.
//
// Ordered longest-first so that at a given start position '5号楼' wins over
// '5楼'; .search() then takes the leftmost position where any alternative
// matches. Chinese numerals are included because '一栋' and '二单元' are written
// as often as '1栋'.
const UNIT_NUM = '[A-Za-z0-9一二三四五六七八九十两]';
const LAST_MILE_TOKEN = new RegExp(
  `${UNIT_NUM}{1,5}号楼`          // 5号楼
  + `|${UNIT_NUM}{1,5}[栋座幢]`   // A栋 · 5座 · 三幢
  + `|${UNIT_NUM}{1,5}单元`       // 2单元
  + `|${UNIT_NUM}{1,6}[室房]`     // 1106室 · 2805房
  + `|${UNIT_NUM}{1,4}[层]`       // 18层
  + `|${UNIT_NUM}{1,4}楼(?![盘])`, // 18楼, but never 楼盘
  'u');

// A findable part that is only a ROAD, with or without a house number.
//
// Anchored at the END, which is the whole of its accuracy: '科翔路104号岭南山畔'
// is a road AND an estate, and the estate is the findable half — filing that as
// a road would send the one case this build exists for back to the geocoder
// that cannot resolve it.
//
// The optional direction character is not decoration. Guangzhou roads are
// routinely named 黄埔大道西 / 中山三路东, and without it those read as 'named'
// and go to a name search that returns the road centroid anyway — the exact
// substitution the road branch exists to avoid.
const ROAD_TAIL = /(?:大道|公路|马路|路|街|巷|道|里)[东西南北中]?(?:[0-9一二三四五六七八九十]{1,5}号?)?$/u;

// Split a joined street+detail line into the half a map can find and the half
// it cannot. Returns { findable, lastMile, shape }.
//
// `shape` says which lookup the findable half belongs to, and it is the whole
// reason the split is worth doing:
//   'named'  — a 小区 / complex / building name. POI NAME SEARCH finds this and
//              geocoding never will.
//   'road'   — a road, optionally with a number. GEOCODING is the right tool
//              here and already works; a name search would return the road
//              centroid or, worse, a shop that happens to sit on it.
//   'region' — nothing but province/city/district, or empty. Neither lookup has
//              anything to work with.
function splitFindable(text, region = {}) {
  const t = norm(text);
  if (!t) return { findable: '', lastMile: '', shape: 'region' };

  const at = t.search(LAST_MILE_TOKEN);
  const findable = (at > 0 ? t.slice(0, at) : at === 0 ? '' : t)
    .replace(/[\s,，、.。;；:：\-–—]+$/u, '').trim();
  const lastMile = at >= 0 ? t.slice(at).trim() : '';

  // Region-only, by content rather than by length: a findable half that is
  // nothing but the tokens we already send as scoping hints tells a name search
  // nothing it did not already have.
  const regionTokens = [region.province, region.city, region.district]
    .map(norm).filter(Boolean);
  const stripped = regionTokens.reduce((s, tok) => s.split(tok).join(''), findable).trim();

  const shape = !stripped ? 'region'
    : ROAD_TAIL.test(findable) ? 'road'
    : 'named';
  return { findable, lastMile, shape };
}

// ── Scoring a name search hit ─────────────────────────────────────────────
// NEITHER provider returns a relevance score. Amap's place/text (extensions=
// base) returns name/address/location/pname/cityname/adname and a `distance`
// only when a centre was passed; Qingyun's dap/lbs/keyWordSearch returns the
// same POI shape proxied (name, address, location, citycode). The one relevance
// signal either of them gives is the ORDER of the list.
//
// So the score is computed here, from the only evidence that arrives: the name
// strings themselves. It is the longest common substring as a fraction of the
// longer of the two — symmetric, no tuning constants inside it, and it degrades
// the way a human reading the two names would:
//
//   祈福新村倚湖湾 vs 祈福新村倚湖湾   → 7/7  = 1.00   the place
//   祈福新村倚湖湾 vs 祈福新村         → 4/7  = 0.57   the estate it sits in
//   祈福新村倚湖湾 vs 番禺区祈福医院    → 2/7  = 0.29   shares 祈福, nothing else
//   祈福新村倚湖湾 vs 广州南站         → 0/7  = 0.00   unrelated
//
// A substring rather than a token overlap because Chinese has no word
// boundaries to tokenise on, and single shared characters (新 园 花 城 华) are
// noise at the frequency they occur in estate names.
function lcsLength(a, b) {
  if (!a || !b) return 0;
  // Rolling two rows — these strings are tens of characters, but the function
  // runs per candidate per order and there is no reason to allocate a matrix.
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      row[j] = prev[j - 1] + 1;
      if (row[j] > best) best = row[j];
    }
    prev = row;
  }
  return best;
}

function nameScore(findable, name) {
  const a = norm(findable), b = norm(name);
  if (!a || !b) return { score: 0, shared: 0 };
  const shared = lcsLength(a, b);
  return { score: shared / Math.max(a.length, b.length), shared };
}

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

// What the operator reads on an order parked with candidates. Same contract as
// NEEDS_POINT_MESSAGE: stored verbatim as last_error, rendered raw in the
// drawer, bilingual because nothing translates it on the way out.
//
// It says the opposite thing from NEEDS_POINT_MESSAGE and must not be confused
// with it. There, nothing was found and the operator supplies the answer. Here
// the answer is on the screen more than once, and the operator picks. Naming
// the count is the difference between "do some work" and "answer a question".
const PICK_PLACE_MESSAGE =
  '该地址匹配到多个地点，需要人工选择配送点 · '
  + 'This address matches more than one place — someone needs to pick the right one';

// ALSO not a failure, and a different unfinished step from needsPointError.
//
// The name search found real places, but not one obvious enough to send a rider
// to without asking (see POI_AUTO_SCORE). The candidates are the whole value of
// this state: they are what turns a map-tapping job into a three-way question,
// and they are why this is not simply parked as needs_point with a nicer
// message. The caller persists them with the row; the drawer lists them.
//
// `point` still rides along for the same reason it does on needsPointError —
// so a surface that falls back to the map has somewhere to open — but the
// candidates are what the operator is meant to answer with.
function pickPlaceError(message, geo, candidates, point) {
  const e = geoError(message, geo);
  e.pickPlace = true;
  e.candidates = (Array.isArray(candidates) ? candidates : []).slice(0, POI_CANDIDATES);
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
  //   2) POI NAME SEARCH on the findable half of the address (splitFindable),
  //      Qingyun's own index first, Amap's place/text second — but only when the
  //      top hit is obvious enough to take without asking (POI_AUTO_SCORE);
  //   3) the app's Amap/Tencent geocoder over the Chinese 省/市/区 + street — but
  //      ONLY when the provider says it matched a building or a road (see
  //      isDeliverablePin); a district-centroid answer is thrown away;
  //   4) give up → park for a person: with candidates if the name search found
  //      any (pick one), otherwise with a map (place one). Never a wrong guess.
  // Whatever wins is then distance-checked against the collecting store.
  //
  // ── Why the name search moved in front of the geocoder ────────────────────
  // Geocoding matches street and house-number data. It has NO 小区 index, so
  // 祈福新村倚湖湾 — a named, indexed place that a name search returns instantly
  // — could never be resolved by it at all, and the 5座1106 tail made the match
  // worse rather than better. Every such order landed on a district centroid,
  // failed the trust check and parked, which is the condition §1 of the spec
  // describes as one the system manufactures.
  //
  // ── Why the geocoder did NOT move to the back ─────────────────────────────
  // It is still first for a ROAD. splitFindable tags those, and a road-shaped
  // address skips the name-search auto-take entirely: geocoding grades
  // '中山一路1号' street-level and ships it today, whereas a name search on
  // '中山一路' returns the road centroid or a shop that happens to front it.
  // Each half of the chain keeps the addresses its index actually covers.
  //
  // ── Why an unconvincing name hit does not park on its own ─────────────────
  // Step 2 falling short is not a verdict on the address, and it must not cost
  // an order that step 3 would have resolved cleanly. So an ambiguous name
  // search REMEMBERS its candidates and falls through; only when the geocoder
  // has also failed do the candidates become the thing the operator answers.
  // That ordering is what keeps this change strictly additive — no address that
  // dispatches today starts asking a question tomorrow.
  const shopPt = { lat: toDegrees(shop && shop.lat), lng: toDegrees(shop && shop.lng) };
  let lng = null, lat = null, cityId = shop.cityId;
  let source = null, precision = null, dropKm = null;
  // What the name search actually matched, when it is what resolved the order.
  // Kept for the push log and the sync log: 'poi_auto' says a scorer decided,
  // and the only way to audit that decision afterwards is to know WHICH place
  // it picked, how well the name matched and what it beat. A wrong auto-take
  // surfaces as a delivery to the wrong 小区 days later, by which time the
  // search results are long gone — so they are recorded at the moment of use.
  let poiMatch = null;

  // Is this coarse candidate close enough to the store to ship unconfirmed
  // (see COARSE_OK_KM)? Returns the distance when it is, null when it is not.
  //
  // No store coordinates → null, always. The whole argument for accepting a
  // coarse point is that its error is BOUNDED BY a measured distance, so
  // without the measurement there is no argument left and the order parks.
  // Falling back to "ship it anyway" here would turn one missing store record
  // into every coarse address dispatching blind, which is the failure this
  // module exists to prevent.
  // Two conditions, and BOTH are load-bearing.
  //
  // 1. There is an address line at all. The whole case for shipping a vague
  //    point is that the rider finishes the job from the text — reads the
  //    building, phones the customer. An address of '广东省广州市' and a city
  //    centroid gives them nothing to finish it WITH, and being close to the
  //    store does not conjure a door. Tested against `addr.address`, the line
  //    the customer actually typed, NOT the derived `street` above: that one
  //    falls back to joining the region when the line is empty, so a
  //    region-only address arrives here holding '广州市' and would pass.
  // 2. It is close to the store, measured. No store coordinates → null,
  //    always: the argument for accepting a coarse point is that its error is
  //    BOUNDED BY a measured distance, so with no measurement there is no
  //    argument and the order parks. Shipping anyway would turn one missing
  //    store record into every coarse address dispatching blind.
  const hasAddressLine = !!norm(addr.address);
  const coarseIsClose = (pt) => {
    if (!hasAddressLine) return null;
    if (shopPt.lat == null || shopPt.lng == null) return null;
    if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)) return null;
    const km = haversineKm(shopPt, pt);
    return (km != null && km <= COARSE_OK_KM) ? km : null;
  };

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

  // ── The name search, memoised the same way ────────────────────────────────
  // Split once, look up once. Both the stored-pin park and the no-pin path want
  // the same answer, and asking twice would double the call for nothing.
  //
  // Returns { hit, candidates, findable, shape }:
  //   hit        — the top candidate IF it clears the confidence test, else null
  //   candidates — the ranked top POI_CANDIDATES, scored, for the ask state
  //
  // Qingyun's index is primary because it is the SAME index Qingyun stores the
  // order against: a place its own search returns is a place its own dispatch
  // can price and route. Amap's place/text is the secondary, for when the
  // browser is unavailable (the web app can reach a maps key without reaching a
  // logged-in Chrome) — the geocoder module is already required here, so this
  // costs nothing structurally.
  const { findable, lastMile, shape } = splitFindable(text, region);
  let _poi = null;
  const resolvePoi = async () => {
    if (_poi) return _poi;
    _poi = { hit: null, candidates: [], findable, shape };

    // Nothing to search on. A region-only address gives a name index exactly
    // the tokens it was already scoped by, and a Latin one gives both indexes
    // a string neither carries (the translator runs above; if it could not
    // answer, a name search is not going to do better).
    if (shape === 'region' || !findable || hasLatin(findable)) return _poi;

    let raw = [];
    try {
      if (br && typeof br.searchPlaces === 'function') {
        raw = (await br.searchPlaces(findable, shop.cityId, 20)) || [];
      } else if (br && typeof br.geocode === 'function') {
        // An older browser object with only the single-hit call. One candidate
        // is still enough to auto-take; it just can never carry a margin, so
        // the single-result branch of the test is what admits it.
        const one = await br.geocode(findable, shop.cityId);
        raw = one ? [one] : [];
      }
    } catch (e) {
      warn(`qingyun place search failed for ${norm(order.order_no)}: ${e.message}`);
      raw = [];
    }

    // Secondary: Amap's own place/text, through the same module the geocoder
    // uses. Degrees here rather than ×1e6 ints — normalised below.
    if (!raw.length && geocode && geocode.configured() && typeof geocode.searchPoi === 'function') {
      try {
        const list = await geocode.searchPoi({ keyword: findable, city: region.city || region.district });
        raw = (list || []).map(p => ({
          lng: Math.round(Number(p.lng) * 1e6), lat: Math.round(Number(p.lat) * 1e6),
          cityId: shop.cityId, name: p.name, address: p.address,
          city: p.city, district: p.district, provider: 'amap',
        })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      } catch (e) {
        warn(`amap place search failed for ${norm(order.order_no)}: ${e.message}`);
      }
    }
    if (!raw.length) return _poi;

    // Score against the findable half only. Scoring against the full text would
    // punish every hit for not containing 5座1106, which no place is called.
    const scored = raw.map((p, rank) => {
      const { score, shared } = nameScore(findable, p.name);
      const pt = { lat: p.lat / 1e6, lng: p.lng / 1e6 };
      return {
        lat: p.lat, lng: p.lng, name: norm(p.name), address: norm(p.address),
        provider: p.provider || 'qingyun', rank, score: Math.round(score * 100) / 100, shared,
        // Distance from the COLLECTING store, so the pick list can say how far
        // the rider goes and an operator can spot the wrong-side-of-town hit
        // without opening a map. Null when the store has no coordinates.
        dropKm: (() => { const km = haversineKm(shopPt, pt); return km == null ? null : Math.round(km * 10) / 10; })(),
      };
    });

    // NOT re-sorted by score. The providers rank by their own relevance, which
    // knows things this scorer cannot (how many people search a place, whether
    // it is a residential compound or a shop inside one), and a local string
    // ratio is a tie-breaker, not a better opinion. The list arrives ranked and
    // leaves ranked; the score only decides whether to ASK.
    _poi.candidates = scored.slice(0, POI_CANDIDATES);

    // ── The confidence test ────────────────────────────────────────────────
    // A road goes to the geocoder, which indexes roads and house numbers; see
    // the chain comment above. Candidates are still kept, so a road whose
    // geocode also fails can still be answered from this list rather than by
    // tapping a map.
    if (shape === 'road') return _poi;

    const top = scored[0], second = scored[1];
    const clear = !second || (top.score - second.score) >= POI_AUTO_MARGIN;
    if (top.score >= POI_AUTO_SCORE && top.shared >= POI_MIN_SHARED && clear) {
      _poi.hit = top;
    }
    return _poi;
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
  //
  // 'poi_picked' and 'poi_auto' join the list as RESOLVED sources — a payload
  // can be built from either without re-deriving anything, which is the whole
  // reason they are recorded on the order at all. They are emphatically not
  // promoted any further than that: neither appears in the `trusted` predicate
  // further down, so both stay subject to MAX_DROP_KM and ABS_MAX_KM. That
  // distinction is the net under an auto-take. A name search returning the
  // right-sounding 小区 in the wrong district is the characteristic way this
  // step fails, and it fails by DISTANCE — which is exactly what the check
  // downstream measures. Adding these two to `trusted` would remove the only
  // guard that catches it.
  //
  // 'poi_picked' outranks 'poi_auto' in nothing here; both are equally
  // resolved. A person choosing from three candidates is better evidence than
  // a scorer choosing from three candidates, but neither placed a point on a
  // building the way 'staff_pin' does, so neither earns 'staff_pin''s exemption
  // from the distance rule.
  const storedSource = norm(addr.geo_source);
  const storedPrecision = norm(addr.geo_precision);
  const pinIsTrusted = storedSource === 'customer_pin'
    || storedSource === 'staff_pin'
    || storedSource === 'poi_picked'
    || storedSource === 'poi_auto'
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
      // Unless the pin we are holding is CLOSE (see COARSE_OK_KM). Measured
      // against the store, not against the failed resolve: the resolve is the
      // thing that just came back useless, so it cannot also be the yardstick.
      const nearKm = coarseIsClose({ lat: dLat, lng: dLng });
      if (nearKm != null) {
        lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
        source = `${storedSource || 'order_pin'}+coarse_near`;
        precision = storedPrecision || null;
        warn(`${norm(order.order_no)}: address will not resolve precisely, but the stored pin is `
          + `${nearKm.toFixed(1)}km from ${norm(shop.name) || 'the store'} `
          + `(within ${COARSE_OK_KM}km) — shipping it unconfirmed`);
      } else {
        // Before handing this to a person, ask the NAME index. The stored pin
        // has no provenance and the geocoder could not place the text — but
        // neither of those is a question the name search was asked, and it is
        // the one index that carries 小区 names. A confident hit here resolves
        // an order that would otherwise have parked, which is the whole change.
        const poi = await resolvePoi();
        if (poi.hit) {
          lng = poi.hit.lng; lat = poi.hit.lat;
          source = 'poi_auto'; precision = null; poiMatch = poi.hit;
          warn(`${norm(order.order_no)}: stored pin has no provenance and the address will not `
            + `resolve, but "${findable}" matches "${poi.hit.name}" by name `
            + `(score ${poi.hit.score}) — taking the named place over the unprovenanced pin`);
        } else if (poi.candidates.length) {
          warn(`${norm(order.order_no)}: stored pin has no provenance and "${findable}" matches `
            + `${poi.candidates.length} places, none clearly enough to take — asking`);
          throw pickPlaceError(PICK_PLACE_MESSAGE,
            { source: storedSource || 'order_pin', precision: storedPrecision, translated },
            poi.candidates,
            // The stored coordinate, not the top candidate: on this path the
            // order has been carrying a point all along, and if the operator
            // falls back to the map that is still the one it should open on.
            { lat: dLat, lng: dLng, precision: storedPrecision || null });
        } else {
          warn(`${norm(order.order_no)}: stored pin has no recorded provenance and the address `
            + `only resolves to ${(c && c.precision) || 'nothing'} (${verdict.reason}) — needs a confirmed point`);
          throw needsPointError(NEEDS_POINT_MESSAGE,
            { source: storedSource || 'order_pin', precision: storedPrecision, translated },
            { lat: dLat, lng: dLng, precision: storedPrecision || null });
        }
      }
    }
  } else {
    let g = null;

    // ── Step 2: the name search, FIRST ────────────────────────────────────
    // On the findable half only, and only when it clears the confidence test.
    // This is the step that resolves a 小区 — the case geocoding structurally
    // cannot serve, because it has no index of them.
    const poi = await resolvePoi();
    if (poi.hit) {
      g = { lng: poi.hit.lng, lat: poi.hit.lat, cityId: shop.cityId };
      source = 'poi_auto';
      poiMatch = poi.hit;
      // No precision grade, for the same reason 'staff_pin' carries none:
      // nobody measured one. A name search says WHICH PLACE, not how exactly it
      // pinned the door, and inventing 'rooftop' here to look confident is the
      // laundering the distance check exists to catch. `trusted` below names
      // sources rather than reading grades precisely so this can stay honest.
      precision = null;
      warn(`${norm(order.order_no)}: matched "${poi.hit.name}" by name `
        + `(score ${poi.hit.score}, ${poi.hit.shared} chars shared with "${findable}"`
        + `${poi.hit.dropKm == null ? '' : `, ${poi.hit.dropKm}km out`}) — taking it`);
    }

    // ── Step 3: the geocoder, demoted to fallback ─────────────────────────
    // Unchanged in every respect except when it runs. Trust it only if the
    // provider matched a building or a road AND landed in the region we asked
    // for. Everything else is a centroid wearing a real answer's clothes — the
    // 20-30 km "wrong address" the courier app shows.
    const c = g ? null : await resolveText();
    const verdict = g ? { ok: false, reason: 'not_needed' }
      : c ? geocode.isDeliverablePin(c) : { ok: false, reason: 'no_result' };
    if (!g && verdict.ok) {
      g = { lng: Math.round(Number(c.lng) * 1e6), lat: Math.round(Number(c.lat) * 1e6), cityId: shop.cityId };
      source = `geocode:${c.provider || 'maps'}`;
      precision = c.precision;
    } else if (!g && c) {
      warn(`rejected ${c.provider || 'maps'} pin for ${norm(order.order_no)} (${verdict.reason}, matched "${(c.matched && c.matched.formatted) || ''}")`);
    }
    if (!g && c && /^precision_/.test(String(verdict.reason || ''))) {
      // Coarse, but close (see COARSE_OK_KM). The provider DID answer here — it
      // answered with an area — so if that area sits near the store, ship it.
      //
      // Gated on a PRECISION verdict specifically. The other way to fail
      // isDeliverablePin is 'city_mismatch', which is not a vague answer but a
      // confident answer somewhere else, and a boundary case could land one
      // inside COARSE_OK_KM. Distance cannot tell those apart, so only the
      // failure whose error distance is genuinely bounded is admitted.
      const pt = { lat: Number(c.lat), lng: Number(c.lng) };
      const nearKm = coarseIsClose(pt);
      if (nearKm != null) {
        g = { lng: Math.round(pt.lng * 1e6), lat: Math.round(pt.lat * 1e6), cityId: shop.cityId };
        source = `geocode:${c.provider || 'maps'}+coarse_near`;
        precision = c.precision || null;
        warn(`${norm(order.order_no)}: address only resolves to ${c.precision || 'an area'}, but that area is `
          + `${nearKm.toFixed(1)}km from ${norm(shop.name) || 'the store'} `
          + `(within ${COARSE_OK_KM}km) — shipping it unconfirmed`);
      }
    }
    // ── Step 4: park for a person, with the candidates if there are any ────
    // BEFORE the geocoder-outage hold, deliberately. A hold means "we learned
    // nothing, so decide later"; that is exactly untrue here. The name search
    // is a different provider and it ANSWERED — with real places, ranked, near
    // enough to list. Holding on the geocoder while holding three usable
    // candidates would sit on an answer until a quota reset, and the operator
    // would never be shown the thing that could have dispatched the order.
    if (!g && poi.candidates.length) {
      warn(`${norm(order.order_no)}: "${findable}" matches ${poi.candidates.length} places, `
        + `none clearly enough to take (top "${poi.candidates[0].name}" at ${poi.candidates[0].score}) — asking`);
      throw pickPlaceError(PICK_PLACE_MESSAGE,
        { source: 'poi_candidates', precision: null, translated },
        poi.candidates,
        // The map fallback opens on the top candidate rather than on an empty
        // country. It is not a point anyone confirmed and is never recorded as
        // one — it is only where the map starts.
        poi.candidates[0] ? { lat: poi.candidates[0].lat / 1e6, lng: poi.candidates[0].lng / 1e6, precision: null } : null);
    }
    if (!g && _freshFailure) {
      // Same distinction with no stored pin: an outage is not evidence that the
      // address is bad, and the name search didn't rescue it either.
      throw geoHoldError(`could not resolve the address for ${norm(order.order_no)}`
        + ` (${_freshFailure.code || 'error'}${_freshFailure.quota ? ', quota' : ''})`, _freshFailure);
    }
    // Nothing found by either index, and both answered. UNCHANGED: this stays a
    // refusal rather than becoming a park. A park is for a question a person can
    // answer, and there is nothing here to show them — no candidates to pick
    // from and no resolved area to open a map on. Turning this into a park would
    // hand staff a blank map and call it a task.
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
  //
  // ── 'poi_auto' and 'poi_picked' are DELIBERATELY ABSENT ────────────────────
  // Both are resolved enough to build a payload from (see pinIsTrusted above)
  // and neither is trusted enough to skip this check, and that gap is the point.
  // A name search's characteristic failure is the right-sounding name in the
  // wrong place — 品秀星越花园 exists in more than one city, and half the estates
  // in the Pearl River Delta share three characters with another. That failure
  // is invisible to the scorer, which only ever saw two strings, and obvious to
  // this line, which measures kilometres. Distance is the only evidence that
  // discriminates it, so distance is the check that must not be waived.
  //
  // 'poi_picked' is not promoted either, even though a person chose it. They
  // chose from a list this module produced, reading names; they did not put a
  // point on a building the way 'staff_pin' does. Same evidence, better filter
  // — not different evidence. If a picked place really is more than 25km out,
  // the refusal is correct and the map surface is still there.
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
    // `unconfirmed` marks a dispatch that went out on a coarse point nobody
    // placed (COARSE_OK_KM). Derived from the source rather than tracked in a
    // parallel flag, so the two can never disagree.
    _geo: {
      source, precision, dropKm: dropKm == null ? null : Math.round(dropKm * 10) / 10, translated,
      unconfirmed: /\+coarse_near$/.test(String(source || '')),
      // What the name search matched, when it is what resolved this order.
      // Null on every other path, so its presence IS the statement that a
      // scorer chose — and `query` records the half of the address it chose
      // from, which is the input a bad split would show up in.
      poi: poiMatch ? {
        query: findable, name: poiMatch.name, address: poiMatch.address,
        score: poiMatch.score, shared: poiMatch.shared, provider: poiMatch.provider,
      } : null,
    },
  };
}

module.exports = {
  buildCreatePayload, joinStreetDetail, MAX_DROP_KM, ABS_MAX_KM, PIN_AGREE_KM,
  COARSE_OK_KM, NEEDS_POINT_MESSAGE,
  // The name-search half, exported so the split and the score can be tested on
  // their own — they are pure string functions and every interesting case is a
  // string, so they should not need a browser and a courier account to assert.
  splitFindable, nameScore, PICK_PLACE_MESSAGE,
  POI_AUTO_SCORE, POI_AUTO_MARGIN, POI_MIN_SHARED, POI_CANDIDATES,
};
