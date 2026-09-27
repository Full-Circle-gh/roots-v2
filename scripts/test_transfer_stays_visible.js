#!/usr/bin/env node
/**
 * A STOCK REQUEST STAYS VISIBLE UNTIL SOMEBODY ANSWERS IT (§198).
 *
 *   node scripts/test_transfer_stays_visible.js
 *
 * THE TWO SILENT KILLERS behind "there is no printing in tianhe for it, i dont
 * see it on my mobile". Paper and the asker's own list are the other halves of
 * §198; these two are why a request that WAS routed correctly still reached
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

  section('Part C · Home says WHO is waiting and SINCE WHEN (§215)');

  /* THE DOT WAS NEVER THE WHOLE ANSWER. Ash, off the live Home: "if shop has
     asked for stock it should show here" — the "Needs you" list, which is the
     screen the day starts on, and where every other queue in the app already
     says itself. A row there is a sentence, not a mark, so the same count now
     carries the two facts a sentence needs. */
  let d = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(d.count, 1, 'the count is exactly what it was — the dot reads this and must not move');
  eq(d.shop_count, 1, 'and beside it, how many SHOPS are waiting');
  eq((d.shops || []).map(x => x.name_en).join(','), 'Yuexiu',
     'named, and it is the shop that ASKED — the supplier is the person reading the row');
  eq((d.shops || [])[0].name_cn, '越秀', 'both halves of the name, so the row follows the language switch');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.oldest_at || ''),
     'and one UTC stamp in the form the phone parses as UTC');

  store(3, 'haizhu', 'Haizhu', '海珠');
  const fromHaizhu = yesterdays({ to: 3 });
  d = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(d.count, 2, 'a second shop raises the count');
  eq(d.shop_count, 2, 'and the shop tally with it');

  // TWO DENOMINATORS, AND THE ROW COUNTS OFF THE RIGHT ONE. Two requests from
  // ONE shop are two units of work and one name; a "+1 more" built off the
  // pill would name a shop that does not exist.
  const alsoHaizhu = yesterdays({ to: 3 });
  d = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(d.count, 3, 'a shop asking twice is two requests');
  eq(d.shop_count, 2, 'and still one name');
  h.db.prepare('DELETE FROM restock_orders WHERE id IN (?,?)').run(fromHaizhu, alsoHaizhu);

  /* THE MIXED STAMP, WHICH IS WHY datetime() IS IN THE QUERY. `sent_at` is
     written by POST /api/restock as a full ISO instant ('…T09:00:00.000Z');
     `created_at` is SQLite's own CURRENT_TIMESTAMP ('… 09:00:00'). MIN() over
     two string SHAPES compares the shapes — 'T' sorts after ' ' — so the row
     would read "oldest 1d" over a shop that had waited three. */
  const isoRow = yesterdays({ to: 3 });
  h.db.prepare("UPDATE restock_orders SET sent_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 3 * 86400000).toISOString(), isoRow);
  d = (await call('GET', '/api/restock/pick-count')).body.data;
  const ageDays = (Date.now() - new Date(d.oldest_at.replace(' ', 'T') + 'Z').getTime()) / 86400000;
  ok(ageDays > 2.5, 'the oldest wait is the genuinely oldest one, whichever shape its stamp was written in');
  eq((d.shops || [])[0].name_en, 'Haizhu',
     'and the shops are oldest-first, so the head of the line is whoever has waited longest');
  h.db.prepare('DELETE FROM restock_orders WHERE id = ?').run(isoRow);

  // A dot over an empty screen teaches people to stop believing it; so does a
  // row. Nothing waiting, nothing said — including no stale names.
  await call('PUT', `/api/restock/${transfer}/archive`, { archived: true });
  d = (await call('GET', '/api/restock/pick-count')).body.data;
  eq(d.count, 0, 'nothing waiting');
  eq(d.shop_count, 0, 'no tally');
  eq((d.shops || []).length, 0, 'and no names left over');
  await call('PUT', `/api/restock/${transfer}/archive`, { archived: false });

  ok(/label:T\('Shops asking for stock','门店补货申请'\)/.test(m), 'Home carries the row');
  // NOT the desktop's live `Stock requests · 补货申请`: this app already has
  // `Your stock requests · 我的补货申请` for the asker's own list, and the two
  // rows are mirror images. The name has to say who is asking.
  ok(m.indexOf("'Your stock requests','我的补货申请'") > -1,
     'the row it must not be confused with is still there, under its own name');
  ok(/const pikN=waitingToPick\(\);/.test(m),
     'gated on the same key the Pick screen is — a fire never promises work behind a door you cannot open');
  ok(/go:"APP\.cmd\('push','pick'\)"/.test(m), 'and it opens the screen it is about');
  // The row must survive the dashboard snapshot being slow or broken: it does
  // not come from /dashboard/ops at all.
  ok(/const o=state\.ops\|\|\{\};/.test(m),
     'and it is not gated on an unrelated dashboard call having answered');

  server.close();
  done();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
