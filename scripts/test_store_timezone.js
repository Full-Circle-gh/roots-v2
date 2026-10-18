#!/usr/bin/env node
/**
 * test_store_timezone.js — a store's time zone can be seen, set and trusted
 * (decisions §82).
 *
 *   node scripts/test_store_timezone.js
 *
 * WHAT IT GUARDS. A store's zone is what its dates, cutoffs and pickup window
 * are judged in. On 2026-10-17 both Roots stores had none, and there was no
 * screen to set one: Settings → Stores had no box for it, the store list did
 * not return it (so every screen showed it blank whatever was saved), and the
 * setup wizard read "Time zone: China" while saving blank unless "Change" was
 * pressed. It was set from a browser console. This suite pins all three fixes,
 * and that the server refuses a zone it cannot read rather than store it to be
 * quietly read as Guangzhou's.
 *
 * HOW. The real routes/retail-inventory.js over a scratch database, signed in
 * as an owner. The two screen helpers are lifted from the shipped files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);

const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
const OWNER = 7801;
db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
            VALUES (?, ?, '__tz_owner', 'x', 'owner', 1)`).run(OWNER, TENANT);
const STORE = Number(db.prepare(`INSERT INTO retail_stores (code, name_en, name_cn, address, city, district, lat, lng, is_active, pickup_enabled)
                                 VALUES ('tz-test', 'Tianhe', '天河', 'Somewhere 1', '广州', '天河区', 23.1, 113.3, 1, 1)`).run().lastInsertRowid);
const zoneOf = (id) => db.prepare('SELECT timezone FROM retail_stores WHERE id = ?').get(id).timezone;
const nameOf = (id) => db.prepare('SELECT name_en FROM retail_stores WHERE id = ?').get(id).name_en;

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: OWNER }; next(); });
  app.use(require(path.join(ROOT, 'routes', 'retail-inventory.js')));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const patch = (body) => send('PATCH', '/api/retail-admin/stores/' + STORE, body);

  try {
    section('1 · the list shows the zone (it did not, so every screen read blank)');
    {
      db.prepare('UPDATE retail_stores SET timezone = ? WHERE id = ?').run('Asia/Shanghai', STORE);
      const r = await send('GET', '/api/retail-admin/stores');
      const row = (r.body.data || []).find((s) => s.id === STORE);
      is(row && row.timezone, 'Asia/Shanghai', 'GET /stores carries each store\'s timezone');
    }

    section('2 · setting it');
    {
      let r = await patch({ timezone: 'Europe/London' });
      is([r.status, zoneOf(STORE)], [200, 'Europe/London'], 'a real zone is saved');
      r = await patch({ timezone: '  Asia/Shanghai  ' });
      is(zoneOf(STORE), 'Asia/Shanghai', 'saved trimmed');
      r = await patch({ name_en: 'Tianhe 2' });
      is(zoneOf(STORE), 'Asia/Shanghai', 'a save that does not mention the zone leaves it alone');
      r = await patch({ timezone: '' });
      is([r.status, zoneOf(STORE)], [200, null], 'blank clears it — "Not set" is a real answer');
    }

    section('3 · a zone the server cannot read is REFUSED, not stored to be read as Guangzhou\'s');
    {
      await patch({ timezone: 'Asia/Shanghai', name_en: 'Tianhe' });
      let r = await patch({ timezone: 'Asia/Shangai', name_en: 'Changed' });
      is([r.status, r.body && r.body.error], [400, 'invalid_timezone'], 'a misspelling is refused, by name');
      is([zoneOf(STORE), nameOf(STORE)], ['Asia/Shanghai', 'Tianhe'], 'and NOTHING in that save is written — not half a form');
      r = await patch({ timezone: 'Asia/Guangzhou' });
      is(r.status, 400, '"Asia/Guangzhou" is not a zone either, however reasonable it looks');
      r = await send('POST', '/api/retail-admin/stores', { code: 'tz-bad', name_en: 'Bad', timezone: 'Mars/Olympus' });
      is([r.status, r.body && r.body.error], [400, 'invalid_timezone'], 'a new store with an unreadable zone is refused');
      is(db.prepare("SELECT COUNT(*) AS n FROM retail_stores WHERE code = 'tz-bad'").get().n, 0, '…and not created');
      r = await send('POST', '/api/retail-admin/stores', { code: 'tz-good', name_en: 'Good', timezone: 'Asia/Shanghai' });
      is(r.status, 200, 'a new store with a real zone is created');
      is(db.prepare("SELECT timezone FROM retail_stores WHERE code = 'tz-good'").get().timezone, 'Asia/Shanghai', '…carrying it');
    }

    section('4 · the zone is in the store\'s edit history');
    {
      const src = read('routes/retail-inventory.js');
      const snap = src.slice(src.indexOf('function storeSnapshot'), src.indexOf('function storeHistoryTid'));
      ok(/timezone: s\.timezone \|\| ''/.test(snap), 'storeSnapshot records the zone, so a change to it can be seen and undone');
    }

    section('5 · Settings → Stores has a Time zone box');
    {
      const src = read('public/retail-admin/02-settings-ops.js');
      const i = src.indexOf('function _opsTzSelect');
      const fnSrc = src.slice(i, src.indexOf('\n}\n', i) + 2);
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const SU = [['Asia/Shanghai', 'China · 中国 (UTC+8)'], ['Europe/London', 'UK · 英国 (UTC+0/1)']];
      const tzSelect = new Function('SU_TZ', 'escapeAttr', 'escapeHtml', fnSrc + '\nreturn _opsTzSelect;')(SU, esc, esc);
      const selected = (html) => (/<option value="([^"]*)" selected>/.exec(html) || [])[1];
      is(selected(tzSelect(null)), '', 'a store with no zone shows "Not set" — not the first zone in the list');
      ok(/Not set · 未设置/.test(tzSelect(null)), '…in both languages, the live pair');
      is(selected(tzSelect('Europe/London')), 'Europe/London', 'a saved zone shows as itself');
      const odd = tzSelect('Pacific/Auckland');
      is(selected(odd), 'Pacific/Auckland', 'a saved zone outside the list is kept as its own choice, never shown as another');
      ok(/id="osf_tz"/.test(tzSelect(null)), 'the box is osf_tz');
      ok(/timezone: v\('osf_tz'\) \|\| null/.test(src), 'the form sends it, blank as null');
      ok(/set\('osf_tz', b\.timezone\)/.test(src), 'undo and history put it back');
      ok(/Time zone · 时区<\/label>\$\{_opsTzSelect\(s\?\.timezone\)\}/.test(src), 'and it is drawn in the store form');
    }

    section('6 · the setup wizard saves the zone it shows');
    {
      const src = read('public/retail-admin/17-setup-guide.js');
      const i = src.indexOf('function suStoreWizData');
      const fnSrc = src.slice(i, src.indexOf('\n}\n', i) + 2);
      const wiz = (TD_TZ) => new Function('window', fnSrc + '\nreturn suStoreWizData;')({ TD_TZ });
      is(wiz(undefined)({ name_en: 'Tianhe' }).timezone, 'Asia/Shanghai',
        'a store with no zone, where the line reads "China", saves China — it saved blank');
      is(wiz('Europe/London')({ name_en: 'Soho' }).timezone, 'Europe/London', 'an account set up in London saves London');
      is(wiz('Europe/London')({ name_en: 'Soho', timezone: 'Asia/Tokyo' }).timezone, 'Asia/Tokyo', 'a store\'s own zone wins');
      is(wiz(undefined)(null).timezone, 'Asia/Shanghai', 'a brand-new store too');
    }

    section('7 · the phone\'s store editor has the same box');
    {
      const m = read('public/m.html');
      const g = read('public/retail-admin/17-setup-guide.js');
      const listOf = (src, name) => {
        const i = src.indexOf('const ' + name + ' = [') >= 0 ? src.indexOf('const ' + name + ' = [') : src.indexOf('const ' + name + '=[');
        const body = src.slice(src.indexOf('[', i), src.indexOf('];', i) + 1);
        return JSON.parse(body.replace(/'/g, '"').replace(/,\s*\]$/, ']'));
      };
      is(listOf(m, 'STO_TZ'), listOf(g, 'SU_TZ'), 'the phone offers exactly the wizard\'s zones, in its order');
      ok(/timezone:t\('timezone'\)\|\|null,/.test(m), 'the phone sends it, blank as null');
      ok(/STO_FIELDS=\[[^\]]*'close_time','timezone'/.test(m), 'and seeds, undoes and restores it like every other field');
      ok(/timezone:\['Time zone','时区'\]/.test(m), 'its history names the change in both languages');
      ok(/\$\{stoInput\('close_time'[^\n]*\n\s*stoTzSelect\(\)\+/.test(m), 'drawn under the opening hours');
    }
  } finally {
    server.close();
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
