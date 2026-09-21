#!/usr/bin/env node
/**
 * diagnose_qingyun_push.js — why can't a store call a same-city rider?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_qingyun_push.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * The order drawer has exactly one thing to say when no copy exists on the
 * courier platform and nothing has errored: "Queued for push…". The price list
 * has exactly one thing to say when it cannot find a copy: "Not in Qingyun yet.
 * Turn on auto-send, or this isn't a same-city order." Both sentences are true
 * of at least five different situations:
 *
 *   • delivery.qingyunAutoPush is OFF, so the drain returns at its first line
 *     and nothing has ever looked at the row;
 *   • auto-push is ON but the order was paid BEFORE qingyunAutoPushSince, so
 *     the reconcile sweep will not adopt it;
 *   • the daemon process is not running, or its Chrome is logged out, so the
 *     row sits 'pending' untouched;
 *   • the row is 'ready' — checked and deliberately held for a booked slot —
 *     and the materialise-on-open call is failing silently against a store
 *     whose browser is unreachable;
 *   • the order was never eligible (isQingyunSameCityToday) and so has no row
 *     at all, which the drawer renders as nothing.
 *
 * Nothing on the screen separates them, so this prints the facts that do: the
 * toggle, the per-store login heartbeat, the queue by status, the last thing
 * the daemon logged, and the row behind each recent delivery order by name.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = process.env.ROOTS_APP || '/root/roots-v2';
const ORDER_NOS = (process.env.QY_DIAG_ORDERS || 'TC000812')
  .split(',').map(s => s.trim()).filter(Boolean);

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

function candidates() {
  const list = [path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

const ago = (t) => {
  if (!t) return 'never';
  const s = String(t);
  const ms = Date.now() - (Date.parse(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z')) || 0);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

let examined = 0;
for (const file of candidates()) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (_) { continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { console.error(`FATAL: ${file} accepted a write — reading nothing`); try { db.close(); } catch (_) {} continue; }

  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return []; } };
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (e) { return null; } };
  const has = (t) => !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t);
  if (!has('qingyun_push_queue')) { try { db.close(); } catch (_) {} continue; }
  examined++;

  console.log(`\n${file}`);
  console.log('='.repeat(72));

  // ── 1. The toggle the drain reads at its very first line ────────────────
  console.log('\n1. AUTO-PUSH TOGGLE (delivery.qingyunAutoPush)');
  const cfg = (k) => {
    const r = one('SELECT value_json FROM storefront_config WHERE key = ?', k);
    if (!r) return { present: false, value: undefined };
    try { return { present: true, value: JSON.parse(r.value_json) }; }
    catch (_) { return { present: true, value: r.value_json, unparsed: true }; }
  };
  const autoPush = cfg('delivery.qingyunAutoPush');
  const since    = cfg('delivery.qingyunAutoPushSince');
  console.log(`   qingyunAutoPush      = ${autoPush.present ? JSON.stringify(autoPush.value) : '(not set → false)'}`);
  console.log(`   qingyunAutoPushSince = ${since.present ? JSON.stringify(since.value) : '(not set)'}`);
  if (autoPush.value !== true) {
    console.log('   ⚠ The drain returns at its first line. Nothing is being pushed at all,');
    console.log('     for any store, and no row will ever leave "pending".');
  } else if (!since.present || !since.value) {
    console.log('   ⚠ ON, but with no "since" stamp — the reconcile sweep is skipped, so an');
    console.log('     order paid by cash / COD / Mark-paid never gets a queue row.');
  }

  // ── 2. Is the daemon alive, and is each store's Chrome logged in? ───────
  console.log('\n2. DAEMON HEARTBEAT (qingyun_status — upserted on every poll, ~25s)');
  const st = all('SELECT store_code, logged_in, last_ok, updated_at FROM qingyun_status ORDER BY store_code');
  if (!st.length) console.log('   (no rows — the daemon has never polled on this database)');
  for (const r of st) {
    console.log(`   ${String(r.store_code).padEnd(10)} logged_in=${r.logged_in}  last_ok ${ago(r.last_ok)}  polled ${ago(r.updated_at)}`);
  }
  const freshest = st.map(r => r.updated_at).filter(Boolean).sort().pop();
  if (!freshest) console.log('   ⚠ no poll ever recorded');
  else {
    const mins = Math.floor((Date.now() - (Date.parse(String(freshest).replace(' ', 'T') + 'Z') || 0)) / 60000);
    if (mins > 3) console.log(`   ⚠ newest poll is ${mins} min old — the daemon looks STOPPED (it polls every ~25s).`);
    else console.log('   ✓ the daemon is polling.');
  }

  // ── 3. The queue, by status and store ───────────────────────────────────
  console.log('\n3. QUEUE BY STATUS');
  for (const r of all(`SELECT store_code, status, COUNT(*) n, MIN(created_at) oldest, MAX(updated_at) newest
                         FROM qingyun_push_queue GROUP BY store_code, status ORDER BY store_code, n DESC`)) {
    console.log(`   ${String(r.store_code).padEnd(10)} ${String(r.status).padEnd(16)} ${String(r.n).padStart(5)}   oldest ${ago(r.oldest)}, touched ${ago(r.newest)}`);
  }
  const stuck = all(`SELECT store_code, COUNT(*) n, MIN(created_at) oldest FROM qingyun_push_queue
                      WHERE status='pending' AND qingyun_order_id IS NULL GROUP BY store_code`);
  for (const r of stuck) console.log(`   → ${r.store_code}: ${r.n} waiting on the drain, oldest ${ago(r.oldest)}`);
  const proc = all(`SELECT id, store_code, retail_order_id, updated_at FROM qingyun_push_queue
                     WHERE status='processing' ORDER BY updated_at LIMIT 10`);
  if (proc.length) {
    console.log(`   ⚠ ${proc.length} row(s) stranded on 'processing' — invisible to the drain AND to`);
    console.log("     the materialise-on-open path, which only claims 'ready':");
    for (const r of proc) console.log(`       queue#${r.id} order#${r.retail_order_id} ${r.store_code}, since ${ago(r.updated_at)}`);
  }

  // ── 4. The named orders ─────────────────────────────────────────────────
  console.log('\n4. THE ORDERS ASKED ABOUT');
  for (const no of ORDER_NOS) {
    const o = one(`SELECT o.id, o.order_no, o.status, o.channel, o.fulfillment_type, o.paid_at,
                          o.scheduled_for, o.delivery_slot_kind, o.delivery_slot_label,
                          o.recipient_phone, o.address_json, rs.code store_code
                     FROM retail_orders o LEFT JOIN retail_stores rs ON rs.id = o.store_id
                    WHERE o.order_no = ?`, no);
    if (!o) { console.log(`   ${no}: not found`); continue; }
    console.log(`\n   ${o.order_no}  #${o.id}  store=${o.store_code}  status=${o.status}  channel=${o.channel}`);
    console.log(`     fulfillment=${o.fulfillment_type}  paid_at=${o.paid_at || '(null)'} (${ago(o.paid_at)})`);
    console.log(`     slot_kind=${o.delivery_slot_kind || '(null)'}  scheduled_for=${o.scheduled_for || '(null)'}  label=${o.delivery_slot_label || '(null)'}`);
    console.log(`     recipient_phone=${o.recipient_phone ? String(o.recipient_phone).replace(/\d(?=\d{4})/g, '*') : '(null)'}`);
    let addr = {};
    try { addr = JSON.parse(o.address_json || '{}') || {}; } catch (_) {}
    const addrKeys = Object.keys(addr);
    console.log(`     address keys: ${addrKeys.join(', ') || '(none)'}`);
    console.log(`     address city/district: ${addr.city || '(none)'} / ${addr.district || '(none)'}  lat=${addr.lat != null ? 'set' : 'null'} lng=${addr.lng != null ? 'set' : 'null'}`);
    if (since.present && since.value && o.paid_at && String(o.paid_at) <= String(since.value)) {
      console.log(`     ⚠ paid BEFORE qingyunAutoPushSince (${since.value}) — the reconcile sweep will never adopt it.`);
    }
    const q = one('SELECT * FROM qingyun_push_queue WHERE retail_order_id = ?', o.id);
    if (!q) {
      console.log('     QUEUE ROW: none. Never enqueued — the eligibility gate');
      console.log('       (isQingyunSameCityToday) rejected it, or it was paid before the');
      console.log('       toggle went on, or the toggle was off at payment.');
    } else {
      console.log(`     QUEUE ROW #${q.id}: status=${q.status}  store=${q.store_code}  attempts=${q.attempts}`);
      console.log(`       qingyun_order_id=${q.qingyun_order_id || '(none)'}  created ${ago(q.created_at)}  touched ${ago(q.updated_at)}`);
      console.log(`       last_error=${q.last_error || '(none)'}`);
      console.log(`       geo_held_at=${q.geo_held_at || '(none)'}  needs_point_at=${q.needs_point_at || '(none)'}`);
      console.log(`       guessed=${q.guessed_lat != null ? `${q.guessed_lat},${q.guessed_lng} (${q.guessed_precision || '?'})` : '(none)'}`);
      console.log(`       candidates_json=${q.candidates_json ? String(q.candidates_json).slice(0, 200) : '(none)'}`);
      if (q.status === 'ready') {
        console.log('       → READY: checked, held back on purpose until staff call the delivery.');
        console.log('         Opening the price list is meant to create the copy. If the list says');
        console.log('         "Not in Qingyun yet", that create FAILED — look at last_error above and');
        console.log('         at the store\'s logged_in flag in section 2.');
      }
      if (q.status === 'pending') {
        console.log('       → PENDING: nobody has drained it. Section 1 (toggle) and section 2');
        console.log('         (heartbeat) say which of the two reasons it is.');
      }
    }
    const jobs = all('SELECT id, qingyun_order_id, store_code, order_status, delivery_status, updated_at FROM delivery_jobs WHERE retail_order_id = ? ORDER BY updated_at DESC LIMIT 3', o.id);
    for (const j of jobs) console.log(`     delivery_job#${j.id} qy=${j.qingyun_order_id} ${j.store_code} order_status=${j.order_status} delivery_status=${j.delivery_status} ${ago(j.updated_at)}`);
  }

  // ── 5. What the daemon last said ────────────────────────────────────────
  console.log('\n5. LAST 25 qingyun_sync_log ENTRIES');
  for (const r of all(`SELECT store_code, event_type, status, detail, error_msg, created_at
                         FROM qingyun_sync_log ORDER BY id DESC LIMIT 25`)) {
    console.log(`   ${String(r.created_at).padEnd(20)} ${String(r.store_code).padEnd(8)} ${String(r.event_type).padEnd(12)} ${String(r.status).padEnd(7)} ${String(r.error_msg || r.detail || '').slice(0, 130)}`);
  }
  const lastPush = one("SELECT created_at FROM qingyun_sync_log WHERE event_type='push' AND status='ok' ORDER BY id DESC LIMIT 1");
  console.log(`\n   Last successful push logged: ${lastPush ? `${lastPush.created_at} (${ago(lastPush.created_at)})` : 'never'}`);

  // ── 6. Today's delivery orders and whether each has a row ───────────────
  console.log("\n6. TODAY'S FIRST-PARTY DELIVERY ORDERS — does each have a queue row?");
  for (const r of all(`SELECT o.order_no, o.status, o.channel, o.paid_at, o.scheduled_for, rs.code store_code,
                              q.status qstatus, q.qingyun_order_id
                         FROM retail_orders o
                         LEFT JOIN retail_stores rs ON rs.id = o.store_id
                         LEFT JOIN qingyun_push_queue q ON q.retail_order_id = o.id
                        WHERE o.fulfillment_type='delivery' AND o.paid_at IS NOT NULL
                          AND o.paid_at >= datetime('now','-2 days')
                        ORDER BY o.paid_at DESC LIMIT 30`)) {
    console.log(`   ${String(r.order_no).padEnd(10)} ${String(r.store_code || '?').padEnd(9)} ${String(r.channel || '?').padEnd(10)} ${String(r.status).padEnd(11)} sched=${String(r.scheduled_for || '-').padEnd(12)} queue=${r.qstatus || 'NONE'}${r.qingyun_order_id ? ` qy=${r.qingyun_order_id}` : ''}`);
  }

  try { db.close(); } catch (_) {}
}

if (!examined) { console.error('no database with a qingyun_push_queue table was readable'); process.exit(3); }
