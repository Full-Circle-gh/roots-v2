'use strict';
// The photo of a same-city delivery at the door (§261).
//
// One per order, in `retail_delivery_photos`. Staff put it there from the order
// drawer (desktop or phone); the rider's own photo from Qingyun is meant to fill
// the same slot later, marked source 'qingyun'. The customer sees it on their
// order page — through their own order route only, never a public media URL,
// because the picture is of somebody's front door.
//
// THE BYTES NEVER TRAVEL WITH THE ORDER. `meta()` says whether there is a photo
// and when it was taken; the picture itself is fetched by its own route when
// somebody asks to look at it — the evidence table's rule, for the same reason.

// JPEG, PNG and WebP only. The phones downscale to JPEG before sending, and all
// three draw in the mini app's <image>; HEIC does not, and a photo the customer
// cannot open is worse than none.
const DATA_URI = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

// About 3MB of picture once base64 has added its third. The route's own body
// limit is 4mb; this is the figure the message names.
const MAX_CHARS = 4 * 1024 * 1024;

// The states in which a same-city parcel can have reached the door. Before
// dispatch there is nothing to photograph, and the drawer offers no slot.
const PHOTO_STATES = ['dispatched', 'delivered'];

function badImage(code) { const e = new Error(code); e.code = code; return e; }

/** What the order carries about its photo: never the bytes. */
function meta(db, orderId) {
  try {
    const r = db.prepare(
      `SELECT source, bytes, uploaded_by_label, created_at
         FROM retail_delivery_photos WHERE order_id = ?`
    ).get(orderId);
    if (!r) return null;
    return { source: r.source, bytes: r.bytes || null,
             by: r.uploaded_by_label || null, at: r.created_at };
  } catch (e) { return null; }   // table missing on an older database
}

/** The picture itself, as a data URI, or null. */
function data(db, orderId) {
  try {
    const r = db.prepare('SELECT data FROM retail_delivery_photos WHERE order_id = ?').get(orderId);
    return r ? r.data : null;
  } catch (e) { return null; }
}

/**
 * Is this order one a delivery photo belongs on? A same-city delivery — it has
 * a 'local' parcel or a Qingyun job — that has left the shop. An order that
 * already carries a photo always keeps its slot, so a photo is never stranded
 * where nobody can see or remove it.
 */
function eligible(db, order) {
  if (!order) return false;
  if (meta(db, order.id)) return true;
  if ((order.fulfillment_type || 'delivery') !== 'delivery') return false;
  if (!PHOTO_STATES.includes(order.status)) return false;
  const local = db.prepare(
    `SELECT 1 FROM retail_shipments WHERE order_id = ? AND mode = 'local' LIMIT 1`
  ).get(order.id);
  if (local) return true;
  try {
    return !!db.prepare('SELECT 1 FROM delivery_jobs WHERE retail_order_id = ? LIMIT 1').get(order.id);
  } catch (e) { return false; }
}

/** Put a photo on the order, replacing any there. Throws with .code on bad input. */
function put(db, orderId, { data: uri, source = 'staff', actor } = {}) {
  const s = String(uri || '');
  if (!DATA_URI.test(s)) throw badImage('bad_image');
  if (s.length > MAX_CHARS) throw badImage('too_large');
  if (!['staff', 'qingyun'].includes(source)) throw badImage('bad_source');
  db.prepare(
    `INSERT INTO retail_delivery_photos (order_id, source, data, bytes, uploaded_by, uploaded_by_label)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(order_id) DO UPDATE SET
       source = excluded.source, data = excluded.data, bytes = excluded.bytes,
       uploaded_by = excluded.uploaded_by, uploaded_by_label = excluded.uploaded_by_label,
       created_at = CURRENT_TIMESTAMP`
  ).run(orderId, source, s, s.length,
        actor && actor.id ? actor.id : null,
        actor && actor.label ? actor.label : null);
  return meta(db, orderId);
}

/** Take the photo off the order. True when there was one. */
function remove(db, orderId) {
  return db.prepare('DELETE FROM retail_delivery_photos WHERE order_id = ?').run(orderId).changes > 0;
}

module.exports = { meta, data, eligible, put, remove, PHOTO_STATES, MAX_CHARS };
