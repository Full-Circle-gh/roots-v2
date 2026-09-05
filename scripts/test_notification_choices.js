#!/usr/bin/env node
/**
 * test_notification_choices.js — which alerts, not just whether (audit E-10).
 *
 *   node scripts/test_notification_choices.js
 *
 * THE FINDING. A member of staff had two switches: a chime in this browser, and
 * push on or off for the device in their hand. That is all of it. A warehouse
 * clerk who wanted picks and nothing else had one choice — everything, or
 * nothing — and "nothing" is what somebody picks when the phone buzzes all day
 * for other people's work. Then the pick that mattered arrives nowhere.
 *
 * The three properties that make the fix worth having, and each is a section:
 *
 *   §2  AN ABSENT PREFERENCE IS CONSENT. Nobody's phone goes quiet because this
 *       shipped, and nothing needed backfilling.
 *   §3  THE FILTER IS AT THE CHOKE POINT. One place every push funnels through,
 *       so a sender written next year cannot forget it.
 *   §4  AN UNKNOWN EVENT IS NEVER MUTED. A key nobody has published a switch
 *       for reaches everybody, which is the safe direction to fail in: the
 *       alternative is an alert silently off for the whole account with no
 *       switch anywhere to explain it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const { ok, eq, section, done } = F.counters();
const ROOT = path.join(__dirname, '..');
const E = require('../lib/push-events');

// ── §1 · the catalogue ────────────────────────────────────────────────────
section('1 · the events a person can choose between');

ok(E.EVENTS.length >= 4, 'every operator push has a switch');
ok(E.EVENTS.every((e) => e.key && e.labelEn && e.labelCn && e.descEn && e.descCn),
  'each one is named and explained, in both languages');
ok(E.EVENTS.every((e) => Array.isArray(e.needAny)), 'and says who it can reach');
eq(new Set(E.EVENTS.map((e) => e.key)).size, E.EVENTS.length, 'the keys are unique');

ok(E.known('new_order') && !E.known('made_up'), 'known() knows only what is listed');

{
  const clerk = ['restock:pick'];
  const pane = E.paneFor({ caps: clerk, off: [] });
  const byKey = Object.fromEntries(pane.map((p) => [p.key, p]));
  ok(byKey.new_order.reaches, 'a new order reaches everybody — no capability gates it');
  ok(byKey.restock.reaches, 'a picker is reached by stock movements');
  ok(!byKey.delivery_reminder.reaches, 'and not by a delivery reminder they cannot act on');
  ok(E.paneFor({ caps: [], owner: true }).every((p) => p.reaches),
    'the owner is reached by all of it');
  ok(E.paneFor({ caps: [] }).every((p) => p.on), 'and everything starts ON');
}

{
  const pane = E.paneFor({ owner: true, off: ['low_stock', 'an_event_that_was_renamed'] });
  const byKey = Object.fromEntries(pane.map((p) => [p.key, p]));
  ok(!byKey.low_stock.on, 'a switched-off event reads as off');
  ok(byKey.new_order.on, 'and turns nothing else off');
  eq(pane.filter((p) => !p.on).length, 1, 'a stale key from a renamed event silences nothing');
}

// ── the API half ──────────────────────────────────────────────────────────
const h = F.harness();
// A real VAPID pair, generated here: routes/push.js disables itself without one,
// and a disabled sender returns before it can filter anybody — which would make
// every assertion below pass over a function that never ran.
const webPush = require('web-push');
const keys = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;

// The delivery record writes into the ACCOUNT's database, which this fixture
// has no business creating. The row is P-03's, tested there; here it is noise.
const logged = [];
h.stub('lib/notify-log.js', {
  logNotification: (row) => logged.push(row),
  logNotificationOn: (_db, tenantId, row) => logged.push({ tenantId, ...row }),
});
h.stub('lib/tenant-db.js', { tdb: () => h.db, getTenantDb: () => h.db, rawTenantDb: () => h.db, ROOTS_TENANT_ID: 1 });

const push = require(path.join(ROOT, 'routes', 'push.js'));

// tenant_operator_push_subs is created by routes/backend-auth.js, which this
// suite does not boot. Same shape.
h.db.exec(`CREATE TABLE IF NOT EXISTS tenant_operator_push_subs (
  endpoint TEXT PRIMARY KEY, tenant_user_id INTEGER NOT NULL, tenant_id INTEGER,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
const TENANT = 1;
const PEOPLE = [101, 102, 103];
for (const id of PEOPLE) {
  h.db.prepare(`INSERT OR REPLACE INTO tenant_operator_push_subs (endpoint, tenant_user_id, tenant_id, p256dh, auth)
                VALUES (?,?,?,?,?)`).run('https://127.0.0.1:1/ep-' + id, id, TENANT, 'p', 'a');
}
const clearPrefs = () => h.db.exec('DELETE FROM push_event_optouts; DELETE FROM push_optouts;');
// `muted` is the count the filter removed BEFORE anything was sent, which is the
// only part of a fan-out that is deterministic without a real push service.
const fanout = (event) => push.sendPushToTenantOperators(TENANT, {
  title: 't', body: 'b', url: '/', tag: 'x', ...(event === undefined ? {} : { event }),
});

(async () => {
  section('2 · an absent preference is consent');
  clearPrefs();
  {
    const r = await fanout('new_order');
    eq(r.total, 3, 'everybody with a device is in the fan-out');
    eq(r.muted, 0, 'and nobody is filtered out before this feature is used');
  }

  section('3 · one switch, one event, one person');
  {
    eq(push.setEventMuted('operator', 102, 'new_order', false).ok, true, 'a person can switch one event off');
    ok(push.mutedEvents('operator', 102).has('new_order'), 'and it is remembered');
    const r = await fanout('new_order');
    eq(r.muted, 1, 'that person stops getting THAT alert');
    eq(r.total, 3, 'the other two are untouched');
    const other = await fanout('restock');
    eq(other.muted, 0, 'and still gets every other one');
    push.setEventMuted('operator', 102, 'new_order', true);
    eq((await fanout('new_order')).muted, 0, 'switching it back on brings it back');
  }

  section('4 · what the filter refuses to do');
  clearPrefs();
  {
    eq(push.setEventMuted('operator', 101, 'not_an_event', false).error, 'unknown_event',
      'an event nobody has published a switch for cannot be stored');
    // Belt and braces: even with a row in the table, an unknown key is ignored.
    h.db.prepare("INSERT INTO push_event_optouts (scope, subject_id, event) VALUES ('operator', 101, 'brand_new_alert')").run();
    eq((await fanout('brand_new_alert')).muted, 0,
      'an alert added later reaches everybody until somebody gives it a switch');
    eq((await fanout(undefined)).muted, 0, 'a payload that names no event is filtered by nothing');
  }

  section('5 · the whole-thing switch still wins');
  clearPrefs();
  {
    h.db.prepare("INSERT INTO push_optouts (scope, subject_id) VALUES ('operator', 103)").run();
    eq((await fanout('new_order')).muted, 1, 'somebody who wants no push gets none');
    // …and the two switches do not double-count the same person.
    push.setEventMuted('operator', 103, 'new_order', false);
    eq((await fanout('new_order')).muted, 1, 'off twice is still one person');
  }

  section('6 · the record says which alert it was');
  clearPrefs();
  {
    logged.length = 0;
    await fanout('low_stock');
    const row = logged[logged.length - 1];
    ok(row && row.detail && row.detail.event === 'low_stock',
      'a "nobody heard this" row says WHICH alert nobody heard');
    eq(row.tenantId, TENANT, 'and files it under the account it belongs to, not the first one');
  }

  section('7 · every sender says which switch it answers to');
  {
    // A sender that forgets the key is not broken — it is unswitchable, which is
    // worse: the pane offers a control that does nothing.
    const sources = {
      'routes/retail.js': 'new_order',
      'routes/restock.js': 'restock',
      'lib/delivery-reminders.js': 'delivery_reminder',
      'lib/low-stock-digest.js': 'low_stock',
    };
    for (const [rel, key] of Object.entries(sources)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      ok(src.includes(`event: '${key}'`), `${rel} tags its push as ${key}`);
      ok(E.known(key), `…and ${key} is a switch somebody can actually see`);
    }
    // Both new-order sites, not just the first: the admin "Mark paid" path
    // bypasses markOrderPaid entirely and had to be tagged separately.
    const retail = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
    eq(retail.split("event: 'new_order'").length - 1, 2, 'both new-order senders are tagged');
  }

  section('8 · the pane is served and can be changed');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'routes/backend-auth.js'), 'utf8');
    ok(/push\/pref[\s\S]{0,400}events: _eventPane/.test(auth), 'the preference read carries the switches');
    ok(auth.includes("router.post('/api/backend/push/events'"), 'and there is a door to change one');
    ok(/Unknown notification/.test(auth), 'which refuses a key it does not know');
    const html = fs.readFileSync(path.join(ROOT, 'public/backend-account.html'), 'utf8');
    ok(html.includes('data-ntf-event'), 'the Notifications pane renders the switches');
    ok(html.includes('/api/backend/push/events'), 'and saves them');
    ok(/paintNtfEvents\(j\.events/.test(html),
      'repainting from the SERVER, so a switch never shows a preference that did not save');
  }

  done();
})();
