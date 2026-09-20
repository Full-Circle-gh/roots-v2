#!/usr/bin/env node
/**
 * A STOCK REQUEST STAYS VISIBLE UNTIL SOMEBODY ANSWERS IT (§197).
 *
 *   node scripts/test_transfer_stays_visible.js
 *
 * THE TWO SILENT KILLERS behind "there is no printing in tianhe for it, i dont
 * see it on my mobile". Paper and the asker's own list are the other halves of
 * §197; these two are why a request that WAS routed correctly still reached
 * nobody.
 *
 *   PART A  THE SWEEP. Every `tab=active` fetch archived any open non-kitchen
 *           request raised before today. Ash raised his in the evening; by the
 *           time anyone at Tianhe opened the app it had `archived_at` stamped
 *           and was off every active list, with nobody having touched it. The
 *           sweep's own comment says what it was built for — a single-day
 *           store→warehouse Fulfill tab — and it is simply wrong about a
 *           request one shop raises against another.
 *   PART B  THE MARK. Thirty rows in More and no way to know one of them has
 *           work behind it. A push is one moment on one phone; after it, the
 *           only way to find out was to already know.
 *
 * WHAT MUST NOT CHANGE IS AS IMPORTANT AS WHAT DOES, and Part A holds both: the
 * sweep still exists, and still clears the shapes it was written for. Switching
 * it off wholesale would be trading one silent surprise for another.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const h = F.harness();
F.captureNotifications(h);
F.stubAuth(h, { id: 7, username: 'jing', role: 'staff', display_name: 'Jing' },
  { restock: 1, warehouse_inbox: 1 }, 'tacet');

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { backendUserId: 7 }; next(); });
app.use(require(path.join(h.REPO, 'routes/restock.js')));
const server = app.listen(0);
const base = () => 'http://127.0.0.1:' + server.address().port;

const TIANHE = 1, YUEXIU = 2;
const store = (id, code, en, cn) => h.db.prepare(
  `INSERT OR REPLACE INTO retail_stores (id, code, name_en, name_cn, is_active, sort_order)
   VALUES (?,?,?,?,1,?)`).run(id, code, en, cn, id);
store(TIANHE, 'tianhe', 'Tianhe', '天河');
store(YUEXIU, 'yuexiu', 'Yuexiu', '越秀');
h.db.prepare(`INSERT INTO users (id, username, password, role, retail_store_id, is_active)
              VALUES (7,'jing','x','warehouse',?,1)`).run(YUEXIU);
F.seedProduct(h.db, { id: 900, name: 'Hummus', sku: 'P-900' });

async function call(method, p, body) {
  const r = await fetch(base() + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// A row written straight to the table so its creation day can be YESTERDAY —
// the one condition the sweep keys on, and the one an HTTP-created request
// cannot have.
let n = 0;
function yesterdays({ from = TIANHE, to = YUEXIU, status = 'sent', toRole = 'warehouse' } = {}) {
  const rs = 'RS-OLD-' + (++n);
  h.db.prepare(`INSERT INTO restock_orders
      (rs_number, date, status, created_by, from_role, to_role, from_store_id, to_store_id,
       created_at, sent_at)
    VALUES (?, date('now','-1 day'), ?, 7, 'store', ?, ?, ?, datetime('now','-1 day'), datetime('now','-1 day'))`)
    .run(rs, status, toRole, from, to);
  const id = h.db.prepare('SELECT id FROM restock_orders WHERE rs_number = ?').get(rs).id;
  h.db.prepare(`INSERT INTO restock_items (restock_id, product_name, qty_requested, unit)
                VALUES (?, 'Hummus', 5, 'kg')`).run(id);
  return id;
}
const archived = (id) =>
  !!h.db.prepare('SELECT archived_at FROM restock_orders WHERE id = ?').get(id).archived_at;

(async () => {
  section('Part A · the overnight sweep no longer eats an open transfer');

  const transfer = yesterdays();
  await call('GET', '/api/restock?tab=active');
  eq(archived(transfer), false,
     'a request one shop raised against another, still open, survives the night');

  // And it is actually LISTED, which is the thing the report was about — an
  // unarchived row nobody draws is the same silence by another route.
  const rows = (await call('GET', '/api/restock?tab=active')).body.data;
  ok(rows.some(r => r.id === transfer), 'and it is still on the active list the Pick screen reads');

  // The sweep still exists and still does its job. This is the half that must
  // not change: switching it off wholesale trades one silent surprise for
  // another, and the shapes below are the ones it was written for.
  const legacy = yesterdays({ from: null, to: null });
  await call('GET', '/api/restock?tab=active');
  eq(archived(legacy), true,
     'a legacy row with NO location pair is still swept — it can reach no Pick screen, so rescuing it would put it on a list nothing draws');

  const oneEnd = yesterdays({ to: null });
  await call('GET', '/api/restock?tab=active');
  eq(archived(oneEnd), true, 'and so is a half-named one, for the same reason');

  // Closed work is untouched either way: the sweep never took it, because it
  // only ever looked at requests that were still open.
  const doneRow = yesterdays({ status: 'delivered' });
  await call('GET', '/api/restock?tab=active');
  eq(archived(doneRow), false, 'a delivered request was never the sweep’s business');

  // The valve that makes the exclusion safe: a person can still clear it.
  await call('PUT', `/api/restock/${transfer}/archive`, { archived: true });
  eq(archived(transfer), true,
     'and an abandoned request is archived BY A PERSON — what was removed is a clock deciding it had stopped mattering');
  await call('PUT', `/api/restock/${transfer}/archive`, { archived: false });

  section('Part B · the Pick row can say it has work behind it');

  let c = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(c.count, 1, 'the open transfer is counted');

  // The clause has to be the Pick screen's own, or the dot stays lit over an
  // empty screen and people learn to stop believing it.
  const dispatched = yesterdays();
  h.db.prepare("UPDATE restock_orders SET goods_state='in_transit' WHERE id=?").run(dispatched);
  c = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(c.count, 1, 'a run already dispatched is not waiting to be picked');

  const kitchen = yesterdays({ toRole: 'kitchen', from: null, to: null });
  c = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(c.count, 1, 'nor is a kitchen request — that is a different screen with a different answer');
  h.db.prepare('DELETE FROM restock_orders WHERE id = ?').run(kitchen);

  const second = yesterdays();
  c = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(c.count, 2, 'a second request raises it');

  await call('PUT', `/api/restock/${second}/archive`, { archived: true });
  c = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(c.count, 1, 'and archiving one lowers it — the count is what is actually waiting');

  section('Part B2 · a dot never promises work behind a door you cannot open');

  const { stockAppOnlyAllows } = require(path.join(h.REPO, 'lib/stock-app-only.js'));
  ok(stockAppOnlyAllows('GET', '/api/restock/pick-count', ['restock:pick']),
     'the count answers to the capability the SCREEN it points at is gated on');
  ok(!stockAppOnlyAllows('GET', '/api/restock/pick-count', ['restock:request']),
     'and not to the asker’s key — the two rows answer to different people');

  const m = fs.readFileSync(path.join(h.REPO, 'public/m.html'), 'utf8');
  ok(/key==='pick'\s*\?\s*waitingToPick\(\)>0/.test(m), 'the Pick row carries the dot');
  ok(/function waitingToPick\(\)\{ return canRoute\('pick'\)/.test(m),
     'gated on the row it points at, as readyFromKitchen is');
  ok(/waitingToPick\(\)>0/.test(m.slice(m.indexOf('function tabDot'), m.indexOf('function tabDot') + 400)),
     'and the More folder lights too, or it hides its own news');
  ok(!/pickWaiting[^\n]*background:var\(--brick/.test(m),
     'no red anywhere near it — a colleague asking is not an alarm');
  ok(/pollPickWaiting\(\);/.test(m.slice(m.indexOf("k.step='sent'"), m.indexOf("k.step='sent'") + 500)),
     're-read the moment a run is dispatched, so the dot never sits lit over "Nothing to pick"');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
