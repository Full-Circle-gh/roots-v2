#!/usr/bin/env node
/**
 * Can this box fetch a rider's delivery photo off Qingyun? One photo, once,
 * WRITING NOTHING (§261 addendum).
 *
 *   node scripts/diagnose_qingyun_rider_photo.js                 the newest delivered order with a photo
 *   node scripts/diagnose_qingyun_rider_photo.js <qingyun order>  that one
 *
 * Run it before QINGYUN_RIDER_PHOTOS=1 goes in .env. It does exactly what the
 * daemon will do for one photo, and says at which step it stopped:
 *   1. read the photo code off delivery_jobs.raw_order   (our database, read-only)
 *   2. ask Qingyun for the link: waybill/image/resolveUrl (the call behind 查看图片)
 *   3. download the picture from this box                  (plain HTTPS)
 *   4. shrink it the way the daemon stores it              (sharp, in memory)
 *
 * It prints the link's HOST and never the link itself: the picture is of a
 * customer's front door, and this output gets pasted into chats.
 *
 * The database is opened read-only (not through database.js, which migrates on
 * load). The Qingyun browser is attached over CDP the way the daemon attaches;
 * two attaches to one Chrome is ordinary, and closing ours detaches only.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const Database = require('better-sqlite3');
const { getQingyunBrowser, closeAllQingyun } = require('../lib/qingyun-browser');
const riderPhotos = require('../lib/rider-photos');

const say = (s) => console.log(s);
const stop = async (step, why) => {
  say(`\n✗ STOPPED AT STEP ${step}: ${why}`);
  try { await closeAllQingyun(); } catch (e) { /* detaching only — nothing to undo */ }
  process.exit(1);
};

// The codes out of a stored order. raw_order is cut at 20,000 characters, so
// it may not parse; the array is then read out of the text directly.
function codesFrom(rawText) {
  try { return riderPhotos.tokensFrom(JSON.parse(rawText)); }
  catch (e) {
    const m = /"unloadPics":\[([^\]]*)\]/.exec(rawText || '');
    return m ? (m[1].match(/"([^"]+)"/g) || []).map(x => x.slice(1, -1)) : [];
  }
}

(async () => {
  const want = process.argv[2] || null;
  const db = new Database(path.join(__dirname, '../data/roots.db'), { readonly: true, fileMustExist: true });
  const rows = db.prepare(
    `SELECT qingyun_order_id, store_code, carrier_name, retail_order_id, raw_order
       FROM delivery_jobs
      WHERE order_status >= 50 AND raw_order LIKE '%"unloadPics":["%'
        AND (@want IS NULL OR qingyun_order_id = @want)
      ORDER BY updated_at DESC LIMIT 5`
  ).all({ want });
  db.close();

  say('Step 1 · the photo code, from our database');
  let job = null, codes = [];
  for (const r of rows) { const c = codesFrom(r.raw_order); if (c.length) { job = r; codes = c; break; } }
  if (!job) await stop(1, want ? `order ${want} is not delivered or carries no delivery photo` : 'no delivered order with a delivery photo');
  say(`  order ${job.qingyun_order_id} · ${job.carrier_name || '?'} · store ${job.store_code} · ours ${job.retail_order_id || '(not linked)'}`);
  say(`  ${codes.length} delivery photo code(s); trying the first`);

  say('\nStep 2 · asking Qingyun for the link');
  let br;
  try { br = await getQingyunBrowser(job.store_code); }
  catch (e) { await stop(2, `could not attach to the Qingyun browser: ${e.message}`); }
  const r = await br.resolvePicUrl(codes[0]);
  say(`  HTTP ${r.status} · code ${r.code}${r.msg ? ' · ' + String(r.msg).slice(0, 120) : ''}`);
  if (r.code === riderPhotos.BLOCKED_CODE) await stop(2, 'Qingyun refused this photo (500002) — the daemon would mark it refused and not ask again');
  if (r.code !== 0 || !r.picUrl) await stop(2, 'no link came back');
  let host = '?';
  try { host = new URL(r.picUrl).host; } catch (e) { host = '(not a URL)'; }
  say(`  link host: ${host}`);

  say('\nStep 3 · downloading the picture from this box');
  let got;
  try { got = await riderPhotos.download(r.picUrl, fetch); }
  catch (e) { await stop(3, e.message); }
  say(`  ${got.type} · ${Math.round(got.buf.length / 1024)} KB`);

  say('\nStep 4 · shrinking it as the daemon would store it');
  let uri;
  try { uri = await riderPhotos.toDataUri(got.buf, got.type); }
  catch (e) { await stop(4, e.message); }
  say(`  stored size would be ${Math.round(uri.length / 1024)} KB`);

  say('\n✓ ALL FOUR STEPS WORKED. Nothing was written. Safe to set QINGYUN_RIDER_PHOTOS=1.');
  try { await closeAllQingyun(); } catch (e) { /* detaching only */ }
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await closeAllQingyun(); } catch (_) { /* detaching only */ } process.exit(1); });
