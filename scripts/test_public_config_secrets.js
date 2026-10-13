#!/usr/bin/env node
/**
 * §436 — THE PUBLIC CONFIG NEVER CARRIES A STAFF GROUP-BOT URL.
 *
 *   node scripts/test_public_config_secrets.js
 *
 * GET /api/retail/config is public: the mini app and the web shop read it with
 * no sign-in. It served `notifications.wecom_order_webhook` and
 * `system_alerts.wecom_webhook` to anyone who asked, and a WeCom group-bot URL
 * carries its secret in `key=` — whoever holds it can post a fake "new order"
 * card into the staff group.
 *
 * What is asserted:
 *   1. the public response holds no qyapi.weixin.qq.com URL and none of the
 *      seeded keys, in URL or bare-key form, with a CMS preview token or without;
 *   2. what customers need from the same namespaces is still there;
 *   3. the admin GET /api/retail-admin/config still answers with the saved
 *      URLs, which is what both settings screens (desktop 05-marketing.js,
 *      phone m.html) load them from;
 *   4. every storefront_config key with "webhook" in its name that the code
 *      names is private or listed in lib/public-config-omit.js, so a new bot
 *      fails here on the day it is written;
 *   5. the committed gallery fixture (a capture of the public config) holds no
 *      group-bot URL.
 *
 * The real router over a scratch database. No browser — fast shard.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router = require(path.join(ROOT, 'routes', 'retail.js'));
const { PUBLIC_CONFIG_OMIT } = require(path.join(ROOT, 'lib', 'public-config-omit'));
const { ok, eq, section, done } = F.counters();

const ORDER_KEY = '11111111-aaaa-4bbb-8ccc-000000000001';
const ALERT_KEY = '22222222-aaaa-4bbb-8ccc-000000000002';
const GZG_KEY   = '33333333-aaaa-4bbb-8ccc-000000000003';   // stored BARE, the form the gzgrocery reader accepts
const hook = (k) => `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${k}`;

const put = db.prepare(`INSERT INTO storefront_config (key, value_json) VALUES (?, ?)
                        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
const seed = {
  'notifications.wecom_order_webhook': hook(ORDER_KEY),
  'notifications.order_status_template_id': 'TPL-public-by-design',
  'notifications.categories': { order: true },
  'system_alerts.enabled': true,
  'system_alerts.wecom_webhook': hook(ALERT_KEY),
  'gzgrocery_orders.enabled': true,
  'gzgrocery_orders.wecom_webhook': GZG_KEY,
};
for (const [k, v] of Object.entries(seed)) put.run(k, JSON.stringify(v));

const admin = { id: 1, username: '__s435' };
function get(routePath, query = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods.get);
  if (!layer) throw new Error('no GET ' + routePath);
  let body = null, status = 200;
  const res = {
    json: (b) => { body = b; return res; }, status: (c) => { status = c; return res; },
    set: () => res, setHeader: () => res, type: () => res, send: (b) => { body = b; return res; },
  };
  const req = { params: {}, body: {}, query, user: admin, backendUser: admin, ip: '::1',
                get: () => '', headers: {}, protocol: 'https', hostname: 'shop.example.test' };
  const hs = layer.route.stack.map(s => s.handle);
  hs[hs.length - 1](req, res, () => {});
  return { status, body };
}

const SECRETS = [ORDER_KEY, ALERT_KEY, GZG_KEY];
function leaks(text) {
  const out = [];
  if (/qyapi\.weixin\.qq\.com/i.test(text)) out.push('a qyapi.weixin.qq.com URL');
  for (const s of SECRETS) if (text.includes(s)) out.push('key ' + s.slice(0, 8));
  return out;
}

/* ── 1 + 2. the public response ────────────────────────────────────────── */
section('1. GET /api/retail/config — no group-bot URL, no key');
const pub = get('/api/retail/config');
eq(pub.status, 200, 'the public config answers');
const pubText = JSON.stringify(pub.body);
eq(leaks(pubText).join(', '), '', 'nothing secret in the public response');
const d = (pub.body && pub.body.data) || {};
for (const k of PUBLIC_CONFIG_OMIT) {
  const [ns, leaf] = [k.slice(0, k.lastIndexOf('.')), k.slice(k.lastIndexOf('.') + 1)];
  const parent = ns.split('.').reduce((o, s) => (o && o[s]), d);
  ok(!parent || !(leaf in parent), `${k} is absent, not merely blank`);
}

section('   …and with a CMS preview token in the query, which takes another branch');
const prev = get('/api/retail/config', { preview_token: 'not-a-valid-token' });
eq(leaks(JSON.stringify(prev.body)).join(', '), '', 'nothing secret in the preview-shaped response');

section('2. what the customer side reads from the same namespaces is kept');
eq(d.notifications && d.notifications.order_status_template_id, 'TPL-public-by-design',
  'the order-status template id (the mini app subscribes with it) still ships');
eq(d.notifications && d.notifications.categories && d.notifications.categories.order, true,
  'notification categories still ship');

/* ── 3. the admin read is untouched ────────────────────────────────────── */
section('3. GET /api/retail-admin/config — the settings screens still load the URLs');
const adm = get('/api/retail-admin/config');
const a = (adm.body && adm.body.data) || {};
eq(a.notifications && a.notifications.wecom_order_webhook, hook(ORDER_KEY), 'new-order webhook is in the admin read');
eq(a.system_alerts && a.system_alerts.wecom_webhook, hook(ALERT_KEY), 'system-alert webhook is in the admin read');
eq(a.gzgrocery_orders && a.gzgrocery_orders.wecom_webhook, GZG_KEY, 'gzgrocery webhook is in the admin read');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MKT = read('public/retail-admin/05-marketing.js');
const M = read('public/m.html');
// The desktop panel is filled inside 05-marketing.js's loadConfig(); take that
// function's body and check which endpoint it reads.
const lcAt = MKT.indexOf('async function loadConfig()');
const lcEnd = MKT.indexOf('\nasync function ', lcAt + 1);
const lcBody = lcAt < 0 ? '' : MKT.slice(lcAt, lcEnd < 0 ? undefined : lcEnd);
ok(lcBody.includes("api('/api/retail-admin/config')") && lcBody.includes('c.notifications?.wecom_order_webhook')
   && !lcBody.includes("'/api/retail/config'"),
  'desktop Notifications panel loads from the ADMIN config');
ok(/const API='\/api\/retail-admin'/.test(M), "phone api() is rooted at /api/retail-admin, so its api('/config') is the admin read");
ok(/api\('\/config'\)\.then\(c=>\{[\s\S]{0,400}wecom_order_webhook/.test(M), 'phone Push notifications panel loads through api(\'/config\')');

/* ── 4. every webhook key the code names is covered ─────────────────────── */
section('4. every storefront_config key naming a webhook is private or omitted');
// routes/retail.js and what moved out of it: PRIVATE_CONFIG_PREFIXES now sits in
// lib/store-config.js (decisions §477).
const RETAIL = require('./test-support/retail-source').retailSource();
const prefMatch = RETAIL.match(/const PRIVATE_CONFIG_PREFIXES = \[([^\]]*)\]/);
const PRIVATE = prefMatch ? [...prefMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
ok(PRIVATE.length > 0, 'PRIVATE_CONFIG_PREFIXES read from the retail source');
// m.html form-draft field names, not storefront_config keys.
const NOT_CONFIG_KEYS = new Set(['cfg.webhook', 'cfg.alerts_webhook']);
const files = [];
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test-support') walk(r); }
    else if (/\.(js|html)$/.test(e.name) && !/^test_/.test(e.name)) files.push(r);
  }
};
['routes', 'lib', 'scripts', 'public/retail-admin'].forEach(walk);
files.push('server.js', 'public/m.html', 'public/cms.html');
const found = new Map();
for (const f of files) {
  let src; try { src = read(f); } catch { continue; }
  for (const m of src.matchAll(/['"`]([a-z_]+(?:\.[A-Za-z0-9_]+)+)['"`]/g)) {
    if (/webhook/i.test(m[1]) && !NOT_CONFIG_KEYS.has(m[1])) found.set(m[1], f);
  }
}
ok(found.size >= 3, `found the webhook keys the code names (${found.size})`);
for (const [k, f] of found) {
  const covered = PRIVATE.some(p => k.startsWith(p)) || PUBLIC_CONFIG_OMIT.includes(k);
  ok(covered, `${k} (${f}) is private or in lib/public-config-omit.js`);
}

/* ── 5. the committed capture ──────────────────────────────────────────── */
section('5. public/shop/_gallery.fixtures.js holds no group-bot URL');
ok(!/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook/i.test(read('public/shop/_gallery.fixtures.js')),
  'the gallery fixture is clean');

/* ── 6. every private family stays out of the public config ─────────────── */
// PRIVATE_CONFIG_PREFIXES is the list loadConfig() skips. Until this section
// only `kitchen.` was proven by a request (test_kitchen_prep_preview.js);
// dropping `integrations.`, `printer.` or `reviews.topup` from the list
// failed nothing. One real key per family, seeded with a value that cannot
// appear by accident, then the public response is searched for it.
section('6. GET /api/retail/config — no integration, printer, review-seeding or kitchen setting');
const PRIVATE_SEED = {
  'integrations.alipayManual': { app_secret: 'S6-INTEGRATIONS-SECRET' },
  'printer.kitchen_sn': 'S6-PRINTER-SN',
  'reviews.topup': { enabled: true, note: 'S6-REVIEWS-TOPUP' },
  'reviews.topup_state': { last_run: 'S6-REVIEWS-TOPUP-STATE' },
  'kitchen.prep_webhook': 'S6-KITCHEN-HOOK',
};
for (const [k, v] of Object.entries(PRIVATE_SEED)) put.run(k, JSON.stringify(v));
put.run('reviews.reward', JSON.stringify({ amount: 6 }));   // the public half of reviews.*
for (const [label, q] of [['plain', {}], ['with a preview token', { preview_token: 'not-a-valid-token' }]]) {
  const body = get('/api/retail/config', q).body;
  const text = JSON.stringify(body);
  const pd = (body && body.data) || {};
  for (const k of Object.keys(PRIVATE_SEED)) {
    const marker = JSON.stringify(PRIVATE_SEED[k]).match(/S6-[A-Z-]+/)[0];
    ok(!text.includes(marker), `${k} is not served (${label})`);
  }
  ok(!pd.integrations && !pd.printer && !pd.kitchen, `no integrations / printer / kitchen object at all (${label})`);
  ok(!(pd.reviews && ('topup' in pd.reviews || 'topup_state' in pd.reviews)),
    `reviews.topup and reviews.topup_state are absent (${label})`);
  eq(pd.reviews && pd.reviews.reward && pd.reviews.reward.amount, 6,
    `reviews.reward, an offer to the customer, still ships (${label})`);
}

done();
