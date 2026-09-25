'use strict';
// The rider's own delivery photos, read off Qingyun (§261 addendum).
//
// Two halves, deliberately apart:
//   record()   — pure database. The daemon calls it for every completed order it
//                reads anyway, and it only notes the codes. It asks Qingyun for
//                nothing, so it runs whether or not the fetch is switched on.
//   fetchDue() — the part that talks to Qingyun: turn a code into a link
//                (`waybill/image/resolveUrl`, the merchant page's own call behind
//                查看图片), download the picture, shrink it, store it. Only when
//                QINGYUN_RIDER_PHOTOS=1, and at most a couple per cycle.
//
// THE PICTURE IS COPIED IN, NEVER LINKED. The link Qingyun hands back is theirs
// to expire or block, and a customer's order page must not go blank on the day
// it does. It is also a photo of somebody's front door, so it is served only as
// lib/delivery-photo.js serves the staff photo: through the customer's own order.

// How long after it is first seen a code is still worth asking about. A photo
// nobody could fetch in a week is not coming, and a week bounds the backlog the
// first switch-on works through.
const FRESH_DAYS = 7;
// Attempts before a code is given up on. Spaced by `backoffMinutes`, so six is
// roughly two hours of trying — a Qingyun hiccup, not a policy.
const MAX_ATTEMPTS = 6;
// A picture bigger than this is refused before it is decoded. A rider photo is
// a few hundred KB; this only stops a wrong link filling memory.
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
// Qingyun's answer when it will not hand the picture over (the merchant page
// shows a placeholder for exactly this code).
const BLOCKED_CODE = 500002;

function backoffMinutes(attempts) {
  return Math.min(120, 2 ** Math.max(0, attempts)); // 2, 4, 8, 16, 32, 64 → cap 2h
}

/**
 * Every delivery-photo code on one Qingyun order, in the rider's order, once
 * each. They sit in `unloadPics` arrays — on the order itself or on a waybill
 * inside it (an order re-sent to a second carrier carries one per attempt) — so
 * the whole object is walked rather than one path trusted. `ladingPics` (the
 * pickup photo) is NOT read: it shows the shop's counter, not the customer's
 * parcel.
 */
function tokensFrom(raw) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'unloadPics' && Array.isArray(x)) {
        for (const t of x) {
          const s = typeof t === 'string' ? t.trim() : '';
          if (s && s.length <= 2048 && !seen.has(s)) { seen.add(s); out.push(s); }
        }
      } else if (x && typeof x === 'object') {
        walk(x, depth + 1);
      }
    }
  };
  walk(raw, 0);
  return out;
}

/**
 * ONE ROW PER PHOTO, KEYED BY ITS PLACE ON THE ORDER, NOT BY ITS CODE.
 *
 * Qingyun re-encrypts every photo on every read: the same photo comes back
 * under a new code each time the daemon lists the 完成 tab. Keyed on the code,
 * the first day live noted each photo 96 times in under an hour and would have
 * fetched and shown the same picture over and over. A photo is "the order's
 * first photo" or "its second", so (order_id, position) is the key and the
 * FIRST code seen is kept — an old code still resolves (the box's diagnostic
 * fetched one noted hours earlier).
 *
 * Called from database.js on every boot. The first time, it folds the
 * duplicates already written, keeping per photo the row that got furthest
 * (fetched, refused, removed or given up) over a waiting one, else the oldest,
 * and only then adds the unique index, which would refuse to build over them.
 * After that it is one lookup and returns.
 */
function ensureSlotIndex(db) {
  const has = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_retail_rider_photos_slot'").get();
  if (has) return 0;
  // One transaction, because the server and every daemon load database.js at
  // boot: a second process either waits for this one or finds the index made.
  let folded = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    folded = db.prepare(
      `DELETE FROM retail_rider_photos WHERE id NOT IN (
         SELECT COALESCE(MIN(CASE WHEN status != 'pending' THEN id END), MIN(id))
           FROM retail_rider_photos GROUP BY order_id, position)`
    ).run().changes;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_retail_rider_photos_slot
               ON retail_rider_photos(order_id, position)`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* nothing open to roll back */ }
    throw e;
  }
  return folded;
}

/**
 * Note the codes for one order. Idempotent: a photo already known — by its
 * place on the order, whatever code it arrives under today — is left alone.
 */
function record(db, orderId, qingyunOrderId, tokens) {
  if (!orderId || !Array.isArray(tokens) || !tokens.length) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO retail_rider_photos (order_id, qingyun_order_id, position, token)
     VALUES (?,?,?,?)`);
  let added = 0;
  tokens.forEach((t, i) => { added += ins.run(orderId, qingyunOrderId || null, i, t).changes; });
  return added;
}

/**
 * The codes waiting to be fetched, oldest first, at most `limit`. With a
 * `storeCode`, only that store's: a code is resolved through the Qingyun login
 * that delivered it, never another store's browser.
 */
function due(db, limit = 2, storeCode = null) {
  return db.prepare(
    `SELECT p.id, p.order_id, p.qingyun_order_id, p.token, p.attempts
       FROM retail_rider_photos p
      WHERE p.status = 'pending'
        AND (p.next_try_at IS NULL OR p.next_try_at <= CURRENT_TIMESTAMP)
        AND p.created_at >= datetime('now', @fresh)
        AND (@store IS NULL OR EXISTS (
              SELECT 1 FROM delivery_jobs j
               WHERE j.qingyun_order_id = p.qingyun_order_id AND j.store_code = @store))
      ORDER BY p.id LIMIT @limit`
  ).all({ fresh: `-${FRESH_DAYS} days`, store: storeCode, limit });
}

function markOk(db, id, uri) {
  db.prepare(
    `UPDATE retail_rider_photos
        SET status = 'ok', data = ?, bytes = ?, last_error = NULL,
            fetched_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`
  ).run(uri, uri.length, id);
}

function markFailed(db, row, err, { final = false } = {}) {
  const attempts = (row.attempts || 0) + 1;
  const status = final === 'blocked' ? 'blocked'
               : (final || attempts >= MAX_ATTEMPTS) ? 'failed' : 'pending';
  db.prepare(
    `UPDATE retail_rider_photos
        SET status = ?, attempts = ?, last_error = ?,
            next_try_at = datetime('now', ?)
      WHERE id = ? AND status = 'pending'`
  ).run(status, attempts, String(err || '').slice(0, 300),
        `+${backoffMinutes(attempts)} minutes`, row.id);
  return status;
}

// Shrink to what a phone screen needs, the size both staff screens already send
// (1280px, JPEG). `rotate()` honours the camera's orientation tag, which a rider
// photo taken sideways always carries. Without sharp (a checkout where the
// native build never ran) a small JPEG/PNG/WebP is kept as it came.
async function toDataUri(buf, contentType) {
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { sharp = null; /* not built here — fall back below */ }
  if (sharp) {
    const out = await sharp(buf).rotate()
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 }).toBuffer();
    return 'data:image/jpeg;base64,' + out.toString('base64');
  }
  const m = /^image\/(jpeg|jpg|png|webp)\b/i.exec(contentType || '');
  if (!m || buf.length > 3 * 1024 * 1024) throw new Error('cannot shrink without sharp');
  return `data:image/${m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()};base64,` + buf.toString('base64');
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`download is ${type || 'not an image'}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`download too large (${len})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`download too large (${buf.length})`);
  return { buf, type };
}

/**
 * Fetch up to `limit` waiting photos. `br` is the store's QingyunBrowser (it
 * signs the resolve call inside the logged-in page). Returns a tally for the
 * log. Never throws: one bad photo must not end the daemon's cycle.
 */
async function fetchDue(db, br, { limit = 2, storeCode = null, fetchImpl = fetch, log = () => {} } = {}) {
  const tally = { ok: 0, retry: 0, blocked: 0, failed: 0 };
  for (const row of due(db, limit, storeCode)) {
    try {
      const r = await br.resolvePicUrl(row.token);
      if (r.code === BLOCKED_CODE) { tally[markFailed(db, row, 'qingyun refused (500002)', { final: 'blocked' })]++; continue; }
      if (r.code !== 0 || !r.picUrl) {
        const st = markFailed(db, row, `resolve code ${r.code}${r.msg ? ' ' + r.msg : ''}`);
        tally[st === 'pending' ? 'retry' : st]++;
        continue;
      }
      const { buf, type } = await download(r.picUrl, fetchImpl);
      markOk(db, row.id, await toDataUri(buf, type));
      tally.ok++;
    } catch (e) {
      const st = markFailed(db, row, e && e.message);
      tally[st === 'pending' ? 'retry' : st]++;
      log(`rider photo ${row.id} (order ${row.order_id}): ${e && e.message}`);
    }
  }
  return tally;
}

module.exports = {
  ensureSlotIndex, tokensFrom, record, due, fetchDue, markOk, markFailed, toDataUri, download,
  backoffMinutes, FRESH_DAYS, MAX_ATTEMPTS, BLOCKED_CODE,
};
