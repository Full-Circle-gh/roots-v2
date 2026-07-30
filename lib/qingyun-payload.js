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
// Kept dependency-free (no db, no config lookups) — the caller passes the geocoder
// and the goods picture, so this module is safe to require from the web app.

'use strict';

const norm = (s) => String(s == null ? '' : s).trim();

// A number Qingyun's order/create will accept as the 收货人电话: eleven digits
// starting 1, once the punctuation people actually type is stripped and a
// 86/086/+86 country prefix is dropped. Returns '' for anything else.
//
// Deliberately mobile-only. A landline with an area code ('020-8888 8888') MIGHT
// pass their validator — we have never had one accepted to prove it, and guessing
// wrong costs a failed create and a 3am page. Treating it as unusable costs a phone
// relay through the shop instead (see below), so the safe way round is the strict
// test. Widen it here if a landline is ever confirmed to go through.
//
// The country-code spellings are peeled off longest-prefix-first, so '0086 138…'
// doesn't stop at the '00' and leave thirteen digits behind.
function cnMobile(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let d = s.replace(/\D/g, '');
  // An explicit country code that ISN'T China's settles the question on its own. A US
  // '+1 415 555 0123' collapses to eleven digits starting 1, which the mainland test
  // below cannot tell apart from a 14x number — so trust the prefix the customer
  // typed over the digits, and let the store-number fallback carry those orders.
  const idd = s.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (idd && !d.startsWith('86')) return '';
  if (d.length === 14 && d.startsWith('086')) d = d.slice(3);   // 086 138…
  if (d.length === 13 && d.startsWith('86'))  d = d.slice(2);   // +86 / 86 138…
  if (d.length === 12 && d.startsWith('0'))   d = d.slice(1);   // trunk 0 before a mobile
  return /^1\d{10}$/.test(d) ? d : '';
}

// order  — a retail_orders row (order_no, recipient_name/phone, address_json,
//          scheduled_for, delivery_slot_label)
// shop   — { shopId, cityId } from browser.getShop() for the SENDING store; this is
//          what decides where the rider collects
// br     — the Qingyun browser (used only for its POI-search geocode fallback)
// deps   — { geocode: lib/geocode, goodsPicUrl, storePhone, onWarn }
//          storePhone is the COLLECTING store's contact number (retail_stores.phone)
//          — the stand-in consignee number when Qingyun won't take the customer's.
// Throws (→ the caller retries) when the order lacks the essentials.
async function buildCreatePayload(order, shop, br, deps = {}) {
  const { geocode, goodsPicUrl, onWarn } = deps;
  let addr = {}; try { addr = JSON.parse(order.address_json || '{}') || {}; } catch { addr = {}; }
  const name     = norm(order.recipient_name || addr.name || addr.contact);
  const rawPhone = norm(order.recipient_phone || addr.phone || addr.mobile);
  // Recipient address: the street/building line plus the floor/unit/room detail
  // ('901房') folded in. Qingyun keeps only recipientAddress reliably — the separate
  // recipientDoorInfo field is not surfaced to the courier — so a room number that
  // lives only in addr.detail would otherwise silently drop and need manual re-entry.
  const streetText = norm(addr.address) || norm([addr.city, addr.district, addr.address].filter(Boolean).join(''));
  const detailText = norm(addr.detail);
  const text = norm([streetText || detailText, (detailText && detailText !== streetText) ? detailText : ''].filter(Boolean).join(' '));
  if (!name || !rawPhone || !text) throw new Error('missing recipient name/phone/address');

  // ── Consignee phone ────────────────────────────────────────────────────────
  // Qingyun validates this field ITSELF and answers `code 40001, 请输入合法的收货人
  // 电话` to anything that isn't a mainland mobile. That fails the whole create —
  // five attempts, then the queue row dies 'error' and someone gets paged to push
  // the order by hand. Two different things were landing there:
  //   • formatting we could have fixed ourselves — '+86 138 0000 1234',
  //     '138-0000-1234'. Nothing on this path normalised it, so it reached Qingyun
  //     exactly as the customer typed it;
  //   • numbers Qingyun will never take — a Hong Kong or overseas mobile, a
  //     landline. Customers here genuinely have those, and rejecting them at
  //     checkout would turn a delivery problem into a lost sale.
  // So: clean it first, and if what's left still isn't a mainland mobile, send the
  // COLLECTING STORE's number instead so the delivery actually reaches the courier.
  // The rider then rings the shop and the shop relays — worse than reaching the
  // customer directly, far better than the order silently never being created. The
  // customer's real number rides along in the 备注 (below), and the caller alerts so
  // whoever is on shift knows a call is coming.
  const phone = cnMobile(rawPhone);
  const storePhone = cnMobile(deps.storePhone);
  const usePhone = phone || storePhone;
  // The stand-in has to clear the same bar, so a store whose own contact number is a
  // landline can't rescue this order either — and then failing loudly beats creating
  // a delivery nobody can be reached on. Name the fix in the message: this text is
  // what an ops person reads in WeCom at closing time, and "no usable number" alone
  // sends them back to the customer rather than to the store's own settings.
  if (!usePhone) throw new Error(`recipient phone "${rawPhone}" is not a mainland mobile, and the collecting store has no mainland mobile set as its contact number (Locations → phone) to send in its place`);
  const phoneSubstituted = !phone;

  // Resolve the drop-off pin (Qingyun wants GCJ-02 ×1e6; the app's geocoders + the
  // mini-app map picker are all GCJ-02, so datums match). Chain, most-reliable first:
  //   1) the order's own coords (customer picked a pin) — best, language-agnostic;
  //   2) the app's Tencent/AMap geocoder over the Chinese 省/市/区 + street — resolves
  //      even an English-typed street, since the region anchors it;
  //   3) Qingyun's own POI search (weak on English) as a last automatic try;
  //   4) give up → the caller retries then ops-alerts (never guesses a wrong spot).
  let lng = null, lat = null, cityId = shop.cityId;
  const dLng = Number(addr.lng), dLat = Number(addr.lat);
  if (Number.isFinite(dLng) && Number.isFinite(dLat) && dLng !== 0 && dLat !== 0) {
    lng = Math.round(dLng * 1e6); lat = Math.round(dLat * 1e6);
  } else {
    let g = null;
    try {
      if (geocode && geocode.configured()) {
        const c = await geocode.geocodeAddress({
          province: norm(addr.province), city: norm(addr.city), district: norm(addr.district),
          address: [norm(addr.address), norm(addr.detail)].filter(Boolean).join(' ') || text,
        });
        if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
          g = { lng: Math.round(Number(c.lng) * 1e6), lat: Math.round(Number(c.lat) * 1e6), cityId: shop.cityId };
        }
      }
    } catch (e) { if (onWarn) onWarn(`maps geocode failed for ${norm(order.order_no)}: ${e.message}`); }
    if (!g) g = await br.geocode(text, shop.cityId);   // Qingyun POI search fallback
    if (!g) throw new Error('geocode failed for address (no pin, unresolved text)');
    lng = g.lng; lat = g.lat; cityId = g.cityId || shop.cityId;
  }

  // Delivery time: a chosen slot → its epoch; else ASAP (~1h out). 待配送 only, so
  // this is informational until staff dispatch.
  const slotEpoch = order.scheduled_for ? Math.floor(Date.parse(order.scheduled_for) / 1000) : 0;
  const target = (slotEpoch && slotEpoch > Math.floor(Date.now() / 1000)) ? slotEpoch : Math.floor(Date.now() / 1000) + 3600;

  const slot = norm(order.delivery_slot_label);
  // The 备注 is the tracking match's key: matchRetailOrderId reads the FIRST token,
  // up to the first '·', as the order_no — so anything appended after one is safe.
  // When we had to substitute the store's number, the customer's own goes here: it
  // is then the only place on the Qingyun side where the rider or the shop can find
  // the person they're actually delivering to.
  const remark = (
    norm(order.order_no)
    + (slot ? ` · ${slot}` : '')
    + (phoneSubstituted ? ` · 客户电话 ${rawPhone}` : '')
  ).slice(0, 200);
  const doorInfo = norm(addr.detail && addr.detail !== text ? addr.detail : '');

  return {
    shopId: shop.shopId,
    recipientName: name, recipientPhone: usePhone, recipientAddress: text, doorInfo,
    recipientLng: lng, recipientLat: lat, cityId,
    goods: [{ name: `Roots ${norm(order.order_no)}`, price: 0, count: 1 }],
    goodsPicUrl: norm(goodsPicUrl),
    remark, expectFrom: target, expectTo: target,
    // Not posted — createOrder() only reads the named fields above. These are for
    // the caller: it has to tell staff the rider will ring the shop rather than the
    // customer, which nobody would otherwise discover until the rider is at the door.
    phoneSubstituted, phoneOriginal: phoneSubstituted ? rawPhone : null,
  };
}

module.exports = { buildCreatePayload, cnMobile };
