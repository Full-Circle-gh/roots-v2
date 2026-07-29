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

// order  — a retail_orders row (order_no, recipient_name/phone, address_json,
//          scheduled_for, delivery_slot_label)
// shop   — { shopId, cityId } from browser.getShop() for the SENDING store; this is
//          what decides where the rider collects
// br     — the Qingyun browser (used only for its POI-search geocode fallback)
// deps   — { geocode: lib/geocode, goodsPicUrl, onWarn }
// Throws (→ the caller retries) when the order lacks the essentials.
async function buildCreatePayload(order, shop, br, deps = {}) {
  const { geocode, goodsPicUrl, onWarn } = deps;
  let addr = {}; try { addr = JSON.parse(order.address_json || '{}') || {}; } catch { addr = {}; }
  const name  = norm(order.recipient_name || addr.name || addr.contact);
  const phone = norm(order.recipient_phone || addr.phone || addr.mobile);
  // Recipient address: the street/building line plus the floor/unit/room detail
  // ('901房') folded in. Qingyun keeps only recipientAddress reliably — the separate
  // recipientDoorInfo field is not surfaced to the courier — so a room number that
  // lives only in addr.detail would otherwise silently drop and need manual re-entry.
  const streetText = norm(addr.address) || norm([addr.city, addr.district, addr.address].filter(Boolean).join(''));
  const detailText = norm(addr.detail);
  const text = norm([streetText || detailText, (detailText && detailText !== streetText) ? detailText : ''].filter(Boolean).join(' '));
  if (!name || !phone || !text) throw new Error('missing recipient name/phone/address');

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
  const remark = (norm(order.order_no) + (slot ? ` · ${slot}` : '')).slice(0, 200);
  const doorInfo = norm(addr.detail && addr.detail !== text ? addr.detail : '');

  return {
    shopId: shop.shopId,
    recipientName: name, recipientPhone: phone, recipientAddress: text, doorInfo,
    recipientLng: lng, recipientLat: lat, cityId,
    goods: [{ name: `Roots ${norm(order.order_no)}`, price: 0, count: 1 }],
    goodsPicUrl: norm(goodsPicUrl),
    remark, expectFrom: target, expectTo: target,
  };
}

module.exports = { buildCreatePayload };
