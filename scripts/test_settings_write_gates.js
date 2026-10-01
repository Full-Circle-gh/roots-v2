#!/usr/bin/env node
/**
 * §325 step S2a — THE WRITES NO PERMISSION GATED.
 *
 *   node scripts/test_settings_write_gates.js
 *
 * The parity survey's defect 3: any signed-in operator could change any
 * storefront setting (PUT /config — fees, tax, tiers, points rules, pop-ups,
 * legal), polls, the voting and leaderboard settings, top-up packages, mark a
 * top-up paid (which credits a wallet), change the affiliate settings and
 * referrals, and edit or publish the mini app (/cms/*). And the flash-sale
 * keys gated nothing: a flash sale is written through /products/:id/flash-sale,
 * which answered products:edit.
 *
 * §325.3 is the rule every assertion here serves: each write is gated on the
 * keys that open EVERY desktop and phone screen making it today, as an any-of.
 * So every refusal has its allow beside it, one per screen, and section 5 pins
 * the callers, so a new screen writing one of these routes fails this suite
 * until somebody decides what it needs.
 *
 * THE REAL ROUTER, NOT A COPY OF THE CHOKE POINT. routes/retail.js is mounted
 * whole over a scratch database, the tenant's enforcement switch is turned on,
 * and each operator's capabilities are real tenant_user_caps grants resolved by
 * the real requireRetailAdmin — so the choke point and the PUT /config handler
 * that narrows it per key are the shipped code, not a stand-in beside it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./test-support/tenant-fixture');

const h = F.harness();
const ROOT = h.REPO;
const db = h.db;
require(path.join(ROOT, 'routes', 'backend-auth.js'));   // tenants, tenant_users, tenant #1
const router = require(path.join(ROOT, 'routes', 'retail.js'));
const { requiredCapFor, configKeyCap } = require(path.join(ROOT, 'lib', 'cap-routes'));
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = read('public/m.html');
const CORE = read('public/retail-admin/01-core.js');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };
const is = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log('\n' + t);
const has = (need, k) => need == null || (Array.isArray(need) ? need.includes(k) : need === k);

/* ── operators: one tenant_users row per capability set ─────────────────── */
const TENANT = db.prepare('SELECT id FROM tenants ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);
let nextId = 7300;
const ops = {};
function operator(name, caps, role = 'custom') {
  const id = ++nextId;
  db.prepare(`INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, TENANT, '__s2a_' + name, role);
  for (const k of caps) {
    db.prepare(`INSERT INTO tenant_user_caps (tenant_id, tenant_user_id, capability_key, mode)
                VALUES (?, ?, ?, 'grant')`).run(TENANT, id, k);
  }
  ops[name] = id;
  return id;
}

/* ── the screen keys, read from the screens themselves ─────────────────── */
// The desktop's rail gate (TAB_CAP) and the phone's (ROUTE_CAP), for one key.
function capOf(src, table, key) {
  const start = src.indexOf('const ' + table + '=') !== -1 ? src.indexOf('const ' + table + '=') : src.indexOf('const ' + table + ' =');
  const body = src.slice(start, src.indexOf('\n};', start));
  const re = new RegExp("(?:^|[\\s,{])'?" + key.replace(/[-]/g, '\\-') + "'?\\s*:\\s*('([^']+)'|\\[([^\\]]+)\\])", 'm');
  const m = body.match(re);
  if (!m) return undefined;
  return m[2] != null ? m[2] : m[3].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
const tab = (k) => capOf(CORE, 'TAB_CAP', k);
const route = (k) => capOf(M, 'ROUTE_CAP', k);
const list = (v) => (Array.isArray(v) ? v : [v]);

(async () => {
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { backendUserId: Number(req.get('x-op')) }; next(); });
  app.use(router);
  app.use(require(path.join(ROOT, 'routes', 'retail-inventory.js')));   // /config/gz-excluded-districts
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(who, method, p, body) {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', 'x-op': String(ops[who]) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const cfgRow = (k) => {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
    return r ? r.value_json : null;
  };

  try {
    section('0 · where the decision is made');
    {
      const choke = RETAIL.slice(RETAIL.indexOf('RBAC ENFORCEMENT (Phase 2)'), RETAIL.indexOf('Store scope —'));
      ok(/const ok = Array\.isArray\(need\) \? need\.some\(k => req\.caps\.has\(k\)\) : req\.caps\.has\(need\);/.test(choke),
        'the choke point reads a list as any-of');
      const put = RETAIL.slice(RETAIL.indexOf("router.put('/api/retail-admin/config', requireRetailAdmin"));
      const gate = put.indexOf('capRoutes.configKeyCap(k)');
      const write = put.indexOf('INSERT INTO storefront_config');
      ok(gate > 0 && write > gate, 'PUT /config asks configKeyCap for every key before it writes anything');
      ok(/capRoutes\.capDenied\(req, need\)/.test(put.slice(0, write)), '…through capDenied, the choke point\'s own conditions');
      is(requiredCapFor('PUT', '/api/retail-admin/config'), null, 'the choke point passes PUT /config to its handler, on purpose');
    }

    section('1 · the path rules');
    const R = (m, p) => requiredCapFor(m, '/api/retail-admin' + p);
    is(R('POST', '/polls'), 'voting:edit', 'POST /polls — Voting');
    is(R('PUT', '/polls/7'), 'voting:edit', 'PUT /polls/:id');
    is(R('DELETE', '/polls/7'), 'voting:edit', 'DELETE /polls/:id');
    is(R('PUT', '/voting/config'), 'voting:edit', 'the voting settings');
    is(R('PUT', '/leaderboard/config'), 'leaderboard:edit', 'the leaderboard settings');
    is(R('POST', '/topup-packages'), 'topup:edit', 'a new top-up package');
    is(R('PATCH', '/topup-packages/3'), 'topup:edit', 'editing one');
    is(R('DELETE', '/topup-packages/3'), 'topup:edit', 'deleting one');
    is(R('POST', '/topup-transactions/9/finalize'), 'topup:edit', 'marking a top-up paid (credits a wallet)');
    is(R('PATCH', '/affiliate/settings'), ['affiliate:view', 'affiliate:edit', 'sharing:edit'], 'the affiliate settings: Affiliate or Share cards');
    is(R('PATCH', '/affiliate/referrals/4'), ['affiliate:view', 'affiliate:edit'], 'a referral row: Affiliate');
    is(R('POST', '/affiliate/eligible'), 'affiliate:edit', 'the eligibility rule is unchanged');
    is(R('POST', '/customers/12/affiliate-block'), 'customers:edit', 'affiliate-block is unchanged (pinned elsewhere, deliberately)');
    is(R('PUT', '/config/gz-excluded-districts'), ['delivery:view', 'delivery:edit'], 'the Delivery panel\'s district chips');
    is(R('GET', '/config/history'), null, 'reads stay open');
    is(R('POST', '/cms/publish'), ['content:edit', 'editor:edit'], 'publishing the mini app');
    for (const p of ['/cms/layout/draft', '/cms/onboarding-settings', '/cms/onboarding-settings/bump', '/cms/preview-token', '/cms/revert-draft']) {
      is(requiredCapFor(p === '/cms/layout/draft' || p === '/cms/onboarding-settings' ? 'PUT' : 'POST', '/api/retail-admin' + p),
        ['content:edit', 'editor:edit'], p + ' — the editor');
    }
    const upload = R('POST', '/cms/media');
    for (const k of ['content:edit', 'editor:edit', 'media:upload', 'content:view', 'categories:view', 'popups:view', 'settings:shop', 'delivery:view']) {
      ok(has(upload, k), 'the shared picture upload admits ' + k);
    }
    ok(!has(upload, 'orders:view'), '…and not an orders account');
    is(R('POST', '/cms/media/video'), ['content:edit', 'editor:edit', 'media:upload'], 'the video upload: the editor only calls it');
    is(R('DELETE', '/cms/media/12'), ['content:edit', 'editor:edit', 'media:delete'], 'deleting an editor picture');
    is(R('PUT', '/products/5/flash-sale'), ['flash:edit', 'products:edit'], 'setting a flash sale: its own key, or the key that let it through until now');
    is(R('DELETE', '/products/5/flash-sale'), ['flash:delete', 'products:delete'], 'ending one: likewise');
    is(R('PATCH', '/products/5'), 'products:edit', 'a product edit is unchanged');
    is(R('DELETE', '/products/5'), 'products:delete', 'a product delete is unchanged');
    is(R('PUT', '/products/5/flash-sale/x'), 'products:edit', 'the flash rule is exact');

    section('2 · PUT /config, one family at a time: each screen that writes it gets through');
    const settings = list(tab('config'));
    const phoneSettings = list(route('settings'));
    const rows = [
      // [key, screen keys that write it today, who wrote it]
      ['shop.layout', settings, 'desktop Settings → Shop tab'],
      ['customer_service.mode', settings, 'desktop Settings → Customer service'],
      ['currency', settings, 'desktop Settings, and the setup guide'],
      ['currency', list(route('setup')), 'the setup pair'],
      ['tax.rateMicro', settings, 'desktop Settings → tax'],
      ['system_alerts.enabled', settings, 'desktop Settings → Notifications save'],
      ['notifications.wecom_order_webhook', settings, 'desktop Settings → Notifications save'],
      ['inventory.lowStockThreshold', settings, 'desktop Settings → Operations'],
      ['product_page.sections', settings, 'desktop Settings → Operations'],
      ['features.waste', settings, 'desktop Settings → Operations'],
      ['delivery.holidayMode', ['delivery:view'], 'desktop Delivery panel (data-cap)'],
      ['delivery.holidayMode', list(route('delivery')), 'phone Delivery — Resume delivery'],
      ['delivery.holidayMode', list(route('setup')), 'the setup guide'],
      ['fees.minOrder', ['delivery:view'], 'desktop Delivery → fees'],
      ['pickup.leadMinutes', ['delivery:view', ...list(route('setup'))], 'Delivery → pickup, and the setup guide'],
      ['batch.schedule', ['delivery:view'], 'desktop Delivery → fresh'],
      ['fresh.morningRequestHour', ['delivery:view'], 'desktop Delivery → fresh'],
      ['notice.preorder', ['delivery:view'], 'desktop Delivery → pre-order'],
      ['notifications.categories.order', list(tab('broadcasts')), 'desktop Broadcasts'],
      ['notifications.categories.order', list(route('bcauto')), 'phone Automatic updates'],
      ['popups.list', list(tab('popups')), 'desktop Pop-ups'],
      ['popups.list', list(route('popups')), 'phone Pop-ups switch'],
      ['copy.home.title', list(tab('snippets')), 'desktop Snippets'],
      ['legal.terms.body_en', list(tab('legal')), 'desktop Legal'],
      ['faq.questions', list(tab('faq')), 'desktop FAQ'],
      ['about.content', list(tab('about')), 'desktop About'],
      ['social_proof', list(tab('social')), 'desktop Social proof'],
      ['checkout.upsell', list(tab('social')), 'desktop Social proof → upsell card'],
      ['sharing.home', list(tab('sharing')), 'desktop Share cards'],
      ['points.earnRate', list(tab('membership')), 'desktop Membership'],
      ['roots_club.tiers', list(tab('membership')), 'desktop Membership'],
      ['reviews.reward', list(tab('reviews')), 'desktop Reviews'],
      ['theme.accent', ['content:edit'], 'cms.html / cms-mobile.html (their content:edit gate)'],
      ['tabBar.icons', ['content:edit'], 'cms.html'],
      ['brand.me_footer', ['content:edit'], 'cms.html / cms-mobile.html'],
      ['me_page.rows', ['content:edit'], 'cms.html / cms-mobile.html'],
      ['cart_notices.list', ['products:edit'], 'the product editor, after its product PATCH'],
      ['features.membership', list(tab('membership')), 'desktop Membership switch'],
      ['features.affiliate', list(tab('affiliate')), 'desktop Affiliate program card'],
      ['features.affiliate', list(route('affiliate')), 'phone Affiliate switch'],
      ['features.reviews', list(tab('reviews')), 'desktop Reviews switch'],
      ['features.feedback', list(tab('feedback')), 'desktop Feedback switch'],
      ['features.feedback', list(route('inbox')), 'phone Inbox "Enable"'],
      ['features.socialProof', list(route('social')), 'phone Social proof switch'],
      ['features.faq', list(tab('faq')), 'desktop FAQ switch'],
      // §325 M4 — the phone's content cards (m.html cfgCard), each on its screen's key.
      ['legal.terms.body_en', list(route('legal')), 'phone Legal (card legal)'],
      ['legal.privacy.updated_at', list(route('legal')), 'phone Legal (card legal)'],
      ['faq.questions', list(route('faq')), 'phone FAQ (card faq)'],
      ['faq.categories', list(route('faq')), 'phone FAQ (card faq)'],
      ['about.content', list(route('about')), 'phone About (card about)'],
      ['copy.cart.title', list(route('snippets')), 'phone Mini-app copy (card copy.snippets)'],
      // §325 M8 — the phone's Social proof and Share cards screens, the desktop tabs' cards.
      ['social_proof', list(route('social')), 'phone Social proof (card social_proof)'],
      ['checkout.upsell', list(route('social')), 'phone Social proof → upsell (card checkout.upsell)'],
      ['sharing.home', list(route('sharecards')), 'phone Share cards (card share.home)'],
      ['sharing.homeTitle', list(route('sharecards')), 'phone Share cards (card share.home)'],
      ['sharing.product', list(route('sharecards')), 'phone Share cards (card share.product)'],
      ['sharing.votingTitle', list(route('sharecards')), 'phone Share cards (card share.voting)'],
      // §325 O4 — the phone's Delivery screen writes the Delivery panel's cards.
      ['delivery.holidayMessage', list(route('delivery')), 'phone Delivery — Holiday mode on, and its message'],
      ['delivery.sameDayCutoffMinutes', list(route('delivery')), 'phone Delivery — Same-day cutoff'],
      ['delivery.sameDayCutoffMessage', list(route('delivery')), 'phone Delivery — Same-day cutoff'],
      ['delivery.kitchenAddress', list(route('delivery')), 'phone Delivery — Kitchen address'],
      ['delivery.bulkTracking', list(route('delivery')), 'phone Delivery — Bulk attach tracking'],
      ['delivery.boxLabel', list(route('delivery')), 'phone Delivery — Box label'],
      ['delivery.defaultZone', list(route('delivery')), 'phone Delivery — Everywhere else'],
      ['fees.freeShippingThreshold', list(route('delivery')), 'phone Delivery — Fees & minimum'],
      ['fees.minOrder', list(route('delivery')), 'phone Delivery — Fees & minimum'],
      ['fees.pickupPackingFee', list(route('delivery')), 'phone Delivery — Fees & minimum'],
      ['pickup.window', list(route('delivery')), 'phone Delivery — Store pickup'],
      ['pickup.leadMinutes', list(route('delivery')), 'phone Delivery — Store pickup'],
      ['notice.preorder', list(route('delivery')), 'phone Delivery — Pre-orders'],
      // §325 O9 — Fresh batches (the desktop's saveBatchSchedule body) and the
      // delivery set-up wizard (dlvWizFinish's body), both on the Delivery screen.
      ['batch.schedule', list(route('delivery')), 'phone Delivery — Fresh batches'],
      ['fresh.rescheduleCutoffHour', list(route('delivery')), 'phone Delivery — Fresh batches'],
      ['fresh.morningRequestHour', list(route('delivery')), 'phone Delivery — Fresh batches'],
      ['delivery.enabled', list(route('delivery')), 'phone Delivery — Set up delivery'],
      ['delivery.coverage', list(route('delivery')), 'phone Delivery — Set up delivery'],
      ['delivery.pricingMode', list(route('delivery')), 'phone Delivery — Set up delivery'],
      ['delivery.speed', list(route('delivery')), 'phone Delivery — Set up delivery'],
      ['delivery.sameDayCutoff', list(route('delivery')), 'phone Delivery — Set up delivery'],
    ];
    // §325 X2 / X3 — the phone's Operations screen writes the same three
    // families as the desktop's Settings → Operations, drawn for the phone
    // Settings screen's keys (m.html opsxCan → ROUTE_CAP.settings), and Settings
    // → Features gained the three switches the desktop hosts there.
    rows.push(['inventory.lowStockThreshold', phoneSettings, 'phone Operations — low-stock default (§325 X2)']);
    rows.push(['inventory.lowStockDigest', phoneSettings, 'phone Operations — daily low-stock list (§325 X2)']);
    rows.push(['product_page.sections', phoneSettings, 'phone Operations — product page sections (§325 X3)']);
    // §325 X5 — the phone's Shop tab and Customer service screens (autosave
    // cards, the desktop's SHOP_CARD and CS_CARD bodies), on the same keys.
    rows.push(['shop.layout', phoneSettings, 'phone Settings → Shop tab (§325 X5)']);
    rows.push(['shop.showSort', phoneSettings, 'phone Settings → Shop tab (§325 X5)']);
    rows.push(['customer_service.mode', phoneSettings, 'phone Settings → Customer service (§325 X5)']);
    rows.push(['customer_service.fab_bottom', phoneSettings, 'phone Settings → Customer service (§325 X5)']);
    // §325 X7 — the phone's Push notifications screen saves the desktop
    // Notifications panel's four keys under one Save, as saveConfig does.
    for (const k of ['notifications.order_status_template_id', 'notifications.wecom_order_webhook', 'system_alerts.enabled', 'system_alerts.wecom_webhook']) {
      rows.push([k, list(route('pushcfg')), 'phone Settings → Push notifications (§325 X7)']);
    }
    // §325 X10 — the phone's Payments screen writes the display currency and
    // the desktop tax card's seven keys, drawn for the keys these families ask.
    rows.push(['currency', list(route('paycfg')), 'phone Payments — currency (§325 X10)']);
    for (const k of ['tax.enabled', 'tax.mode', 'tax.rateMicro', 'tax.label', 'tax.number', 'tax.shippingTaxable']) {
      rows.push([k, list(route('paycfg')), 'phone Payments — tax (§325 X10)']);
    }
    for (const f of ['membership', 'affiliate', 'reviews', 'feedback', 'socialProof', 'faq', 'production', 'waste', 'lowStockHints']) {
      rows.push(['features.' + f, phoneSettings, 'phone Settings → Features']);
    }
    for (const [key, screen, who] of rows) {
      const need = configKeyCap(key);
      ok(screen.length && screen.every((k) => has(need, k)), `${key} — ${who} (${screen.join(' | ')})`,
        'need ' + JSON.stringify(need));
    }
    is(configKeyCap('support.hidden'), null, 'support.hidden stays open: the floating Support panel\'s Hide is drawn for everybody');
    // The phone's Operations switch for it (§325 X2) is drawn for its Settings
    // keys, a narrower set than "everybody", so the open gate admits it too.

    section('3 · …and the families do not bleed into each other');
    ok(!has(configKeyCap('tax.rateMicro'), 'popups:view'), 'a pop-up editor cannot set the tax rate');
    ok(!has(configKeyCap('fees.minOrder'), 'popups:view'), '…or the fees');
    ok(!has(configKeyCap('fees.minOrder'), 'settings:push'), 'the fees are the Delivery panel\'s, not Settings → Push\'s');
    ok(!has(configKeyCap('roots_club.tiers'), 'content:view'), 'a content account cannot rewrite the tiers');
    ok(!has(configKeyCap('popups.list'), 'settings:shop'), 'nor a settings account the pop-ups');
    ok(!has(configKeyCap('theme.accent'), 'content:view'), 'the mini-app theme needs the editor\'s key, not content:view');
    ok(!has(configKeyCap('cart_notices.list'), 'products:view'), 'the cart notice needs the product save\'s key');
    const unknown = configKeyCap('zz_never_written.key');
    ok(Array.isArray(unknown) && unknown.includes('settings:shop') && unknown.includes('popups:view') && !unknown.includes('orders:view'),
      'an unlisted key takes the union of every writing screen: it closes only the account that can open none');

    section('4 · over HTTP, through the real router, enforcement on');
    operator('popups', ['popups:view']);
    operator('nothing', []);
    operator('orders', ['orders:view', 'orders:edit']);
    operator('settings', ['settings:shop']);
    operator('delivery', ['delivery:view']);
    operator('broadcast', ['broadcasts:send']);
    operator('voting', ['voting:edit']);
    operator('leader', ['leaderboard:edit']);
    operator('topup', ['topup:edit']);
    operator('affview', ['affiliate:view']);
    operator('sharing', ['sharing:edit']);
    operator('content', ['content:edit']);
    operator('cats', ['categories:view']);
    operator('flash', ['flash:view', 'flash:edit', 'flash:delete']);
    operator('prodedit', ['products:edit', 'products:delete']);
    operator('owner', [], 'owner');

    let r = await call('popups', 'PUT', '/api/retail-admin/config', { 'popups.list': [{ id: 'p1', enabled: true }] });
    is(r.status, 200, 'the pop-ups account writes the pop-ups list');
    const before = cfgRow('popups.list');
    r = await call('popups', 'PUT', '/api/retail-admin/config', { 'tax.enabled': false });
    is(r.status, 403, '…and is refused the tax switch');
    is(r.body && r.body.error, 'forbidden_capability', '…in the choke point\'s shape');
    is(r.body && r.body.key, 'tax.enabled', '…naming the key');
    r = await call('popups', 'PUT', '/api/retail-admin/config', { 'popups.list': [], 'tax.enabled': false });
    is(r.status, 403, 'one refused key refuses the whole body');
    is(cfgRow('popups.list'), before, '…and nothing in it was written');
    r = await call('nothing', 'PUT', '/api/retail-admin/config', { 'support.hidden': true });
    is(r.status, 200, 'an account holding nothing may still hide the Support button');
    r = await call('nothing', 'PUT', '/api/retail-admin/config', { 'popups.list': [] });
    is(r.status, 403, 'an account holding nothing may not touch the pop-ups');
    r = await call('orders', 'PUT', '/api/retail-admin/config', { 'fees.minOrder': 0 });
    is(r.status, 403, 'an orders account may not change the minimum order');
    r = await call('settings', 'PUT', '/api/retail-admin/config', { 'shop.layout': 'grid', currency: { code: 'CNY' } });
    is(r.status, 200, 'a settings:shop account saves the Shop tab and the currency');
    r = await call('settings', 'PUT', '/api/retail-admin/config', { 'features.membership': true });
    is(r.status, 200, 'and flips a feature from the phone\'s Settings');
    r = await call('settings', 'PUT', '/api/retail-admin/config', {
      'inventory.lowStockThreshold': 4, 'inventory.lowStockDigest': { enabled: true, hour: 0 }, 'product_page.sections': { order: ['basics'], hidden: [] },
    });
    is(r.status, 200, 'and saves the phone Operations screen\'s low-stock and product-page settings (§325 X2/X3)');
    r = await call('orders', 'PUT', '/api/retail-admin/config', { 'inventory.lowStockThreshold': 4 });
    is(r.status, 403, '…which an orders account may not');
    r = await call('settings', 'PUT', '/api/retail-admin/config?history=customer_service', { 'customer_service.mode': 'qr', 'customer_service.fab_bottom': 220 });
    is(r.status, 200, 'and the phone\'s Customer service card, filed on its history (§325 X5)');
    r = await call('delivery', 'PUT', '/api/retail-admin/config', { 'delivery.holidayMode': false });
    is(r.status, 200, 'the phone\'s Resume delivery still works for a delivery:view account');
    r = await call('broadcast', 'PUT', '/api/retail-admin/config', { 'notifications.categories.order': true });
    is(r.status, 200, 'the phone\'s Automatic updates still work for broadcasts:send');
    r = await call('broadcast', 'PUT', '/api/retail-admin/config', { 'notifications.wecom_order_webhook': 'x' });
    is(r.status, 403, '…which is not the webhook in Settings → Push');
    r = await call('owner', 'PUT', '/api/retail-admin/config', { 'tax.enabled': false });
    is(r.status, 200, 'the owner, holding nothing, is never refused');

    const refusedNothing = [
      ['POST', '/api/retail-admin/polls', { question_en: 'x' }],
      ['PUT', '/api/retail-admin/polls/1', { status: 'open' }],
      ['DELETE', '/api/retail-admin/polls/1'],
      ['PUT', '/api/retail-admin/voting/config', {}],
      ['PUT', '/api/retail-admin/leaderboard/config', {}],
      ['POST', '/api/retail-admin/topup-packages', {}],
      ['PATCH', '/api/retail-admin/topup-packages/1', {}],
      ['DELETE', '/api/retail-admin/topup-packages/1'],
      ['POST', '/api/retail-admin/topup-transactions/1/finalize'],
      ['PATCH', '/api/retail-admin/affiliate/settings', {}],
      ['PATCH', '/api/retail-admin/affiliate/referrals/1', { status: 'joined' }],
      ['POST', '/api/retail-admin/cms/publish', {}],
      ['PUT', '/api/retail-admin/cms/layout/draft', {}],
      ['POST', '/api/retail-admin/cms/media'],
      ['PUT', '/api/retail-admin/config/gz-excluded-districts', { districts: [] }],
      ['PUT', '/api/retail-admin/products/1/flash-sale', {}],
      ['DELETE', '/api/retail-admin/products/1/flash-sale'],
    ];
    for (const [m, p, b] of refusedNothing) {
      r = await call('orders', m, p, b);
      is(r.status, 403, `an orders account is refused ${m} ${p.replace('/api/retail-admin', '')}`);
    }
    const allowed = [
      ['voting', 'PUT', '/api/retail-admin/polls/999999', { status: 'open' }, 'Voting changes a poll'],
      ['voting', 'PUT', '/api/retail-admin/voting/config', {}, 'Voting saves its settings'],
      ['leader', 'PUT', '/api/retail-admin/leaderboard/config', {}, 'Leaderboard saves its settings'],
      ['topup', 'POST', '/api/retail-admin/topup-transactions/999999/finalize', null, 'Top-up / Wallet marks a top-up paid'],
      ['topup', 'PATCH', '/api/retail-admin/topup-packages/999999', {}, 'Top-up edits a package'],
      ['affview', 'PATCH', '/api/retail-admin/affiliate/settings', {}, 'the Affiliate tab saves its settings'],
      ['sharing', 'PATCH', '/api/retail-admin/affiliate/settings', {}, 'the Share cards tab saves the invite card'],
      ['affview', 'PATCH', '/api/retail-admin/affiliate/referrals/999999', { status: 'joined' }, 'the Affiliate tab moves a referral'],
      ['content', 'PUT', '/api/retail-admin/cms/layout/draft', {}, 'the editor saves a draft'],
      ['cats', 'POST', '/api/retail-admin/cms/media', null, 'the category banner uploads its picture'],
      ['delivery', 'PUT', '/api/retail-admin/config/gz-excluded-districts', { districts: [] }, 'the Delivery panel saves its districts'],
      ['flash', 'PUT', '/api/retail-admin/products/999999/flash-sale', {}, 'a flash-sales account (the marketing preset) sets a sale'],
      ['flash', 'DELETE', '/api/retail-admin/products/999999/flash-sale', null, '…and ends one'],
      ['prodedit', 'PUT', '/api/retail-admin/products/999999/flash-sale', {}, 'a products:edit account keeps setting sales, as before'],
      ['prodedit', 'DELETE', '/api/retail-admin/products/999999/flash-sale', null, '…and products:delete keeps ending them'],
    ];
    for (const [who, m, p, b, what] of allowed) {
      r = await call(who, m, p, b);
      ok(r.status !== 403, what + ' (got ' + r.status + ', not a refusal)', JSON.stringify(r.body));
    }
    db.prepare('UPDATE tenants SET rbac_enforce = 0 WHERE id = ?').run(TENANT);
    r = await call('nothing', 'PUT', '/api/retail-admin/config', { 'popups.list': [] });
    is(r.status, 200, 'with enforcement off, nothing changes for anybody');
    r = await call('nothing', 'POST', '/api/retail-admin/topup-transactions/999999/finalize');
    ok(r.status !== 403, '…on the path rules too');
    db.prepare('UPDATE tenants SET rbac_enforce = 1 WHERE id = ?').run(TENANT);

    section('5 · the callers are the ones surveyed');
    {
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = d + '/' + e.name;
        if (e.isDirectory()) walk(rel); else if (/\.(html|js)$/.test(e.name)) files.push(rel);
      } };
      walk('public');
      const src = Object.fromEntries(files.map((f) => [f, read(f)]));
      const who = (re) => files.filter((f) => re.test(src[f])).sort();
      // Every phone write to /config: a literal path starting '/config' (with or
      // without ?history / ?expect), or the pop-up switch's cfgPath.
      const SITE = /apiWrite\(('\/config[^']*'[^,]*|cfgPath),/g;
      const sites = [];
      for (let mm; (mm = SITE.exec(M));) sites.push(mm.index);
      /* §325 M7 — the voting and leaderboard settings are not /config keys:
         each has a route of its own (gated voting:edit / leaderboard:edit in
         section 1), and the phone writes them there, as the desktop does. */
      ok(!/apiWrite\((?!'\/config|cfgPath|'\/(voting|leaderboard)\/config')[^,]*config/.test(M), 'the phone writes /config through no other path');
      is(who(/retail-admin\/config['"`?]/), [
        'public/cms-mobile.html', 'public/cms.html', 'public/product-editor.html', 'public/retail-admin.html',
        'public/retail-admin/01-core.js', 'public/retail-admin/05-marketing.js', 'public/retail-admin/06-delivery.js',
        'public/retail-admin/07-content-billing.js', 'public/retail-admin/09-products.js', 'public/retail-admin/10-extras.js',
        'public/retail-admin/17-setup-guide.js', 'public/retail-admin/31-product-page.js',
      ], 'PUT /config: the desktop files, the two editors and the product editor');
      /* §325 O4 — the phone's Delivery settings write through ONE helper,
         dlvCfgPut, whose site names no family itself (its keys arrive in the
         body). It is set apart from the four one-family sites, and its keys
         are pinned below instead. */
      const dlvSite = M.indexOf("function dlvCfgPut(");
      const dlvSites = sites.filter((i) => i > dlvSite && i < M.indexOf('\n}\n', dlvSite));
      is(dlvSites.length, 1, 'the Delivery settings helper is one write site');
      const famSites = sites.filter((i) => !dlvSites.includes(i));
      // §325 X2/X3: the phone's Operations screen adds four families —
      // inventory.lowStockThreshold, inventory.lowStockDigest, support.hidden
      // (the open one) and product_page.sections — each its own write site.
      // §325 X5 adds the two autosave cards, each filed on its own history
      // card: 'shop.display' (the shop.* family) and 'customer_service'.
      // §325 X7 adds the Push notifications Save: ONE site, two families
      // (notifications.* and system_alerts.*), as the desktop's saveConfig.
      // §325 X10 adds Payments: the currency and the tax.* keys, each its own
      // write site, as the desktop's renderCurrencyControl and saveTaxSettings.
      const FAMS = ['currency', 'customer_service', 'delivery.holidayMode', 'features.', 'inventory.lowStockDigest', 'inventory.lowStockThreshold',
        'notifications.categories.', 'notifications.order_status_template_id', 'popups.list', 'product_page.sections', 'shop.', 'support.hidden',
        'system_alerts.', 'tax.'];
      const SITE_FAMS = FAMS.filter((f) => f !== 'notifications.order_status_template_id' && f !== 'system_alerts.')
        .concat(['notifications.order_status_template_id|system_alerts.']).sort();
      // A site whose body is written inline names its family in the call itself;
      // only one that builds its body first (Resume delivery, the pop-up switch)
      // is read in the 900 characters before it. Several sites now sit within
      // 900 characters of each other (§325 X2), so the call is asked first.
      const famAt = (i) => {
        const own = FAMS.filter((f) => M.slice(i, i + 200).includes("'" + f));
        return own.length ? own : FAMS.filter((f) => M.slice(Math.max(0, i - 900), i + 200).includes("'" + f));
      };
      // §325 M4 — the phone's content cards (m.html cfgCard: legal, faq, about,
      // copy.snippets) share ONE write site, PUT /config?history=<card>; each
      // card's family is a row in section 2. Every other site is one family.
      const CARD_SITE = M.indexOf("apiWrite('/config?history='+encodeURIComponent(c.card)");
      ok(CARD_SITE !== -1 && sites.includes(CARD_SITE), 'the content cards write through the one cfgCard site');
      const cards = (M.match(/cfgCard\('([a-z._]+)',\{/g) || []).map((x) => x.match(/cfgCard\('([a-z._]+)'/)[1]).sort();
      is(cards, ['about', 'checkout.upsell', 'copy.snippets', 'faq', 'leaderboard', 'legal', 'social_proof', 'voting'],
        'the phone\'s cards: about, copy, faq, legal, social proof and the upsell on /config; leaderboard and voting on their own routes');
      // §325 M8 — the share cards are one card per page, 'share.<key>': three on
      // /config (sharing.<key>), the invite card on PATCH /affiliate/settings.
      ok(M.includes("return cfgCard('share.'+key,pg.aff?{"), 'the share cards are cfgCard(\'share.\'+key)');
      ok(/const SC_PAGES=\[\s*\{key:'home'[\s\S]*?\{key:'product'[\s\S]*?\{key:'voting'[\s\S]*?\{key:'invite'[^}]*aff:true/.test(M), '…for home, product, voting, and the invite card through Affiliate');
      for (const [card, url] of [['voting', '/voting/config'], ['leaderboard', '/leaderboard/config']]) {
        const at = M.indexOf("cfgCard('" + card + "',{");
        const own = M.slice(at, M.indexOf('\n});', at));
        ok(own.includes("put:(b,note)=>apiWrite('" + url + "'+cfgHistQ('" + card + "',note),b,'PUT')"), 'the ' + card + ' card writes its own route, ' + url + ', not /config');
      }
      is(famSites.filter((i) => i !== CARD_SITE).map((i) => famAt(i).join('|')).sort(),
        SITE_FAMS, 'the phone writes fourteen families at thirteen write sites, each asserted in section 2 (support.hidden as the open one)');
      /* §325 O4 — the phone's Delivery settings write through one helper
         (dlvCfgPut), so their keys are read from where they are named: the
         live cards' `keys`, the two switches' `key`, and the three sheets'
         bodies. Every one is in the list asserted in section 2, and every one
         passes for the key that opens the phone's Delivery screen. */
      const dlvBlock = M.slice(M.indexOf('const DLV_LIVE={'), M.indexOf("reg('faqToggle',"));
      const dlvKeys = new Set();
      for (const m of dlvBlock.matchAll(/keys:\[([^\]]*)\]/g)) for (const k of m[1].match(/'([^']+)'/g) || []) dlvKeys.add(k.slice(1, -1));
      for (const m of dlvBlock.matchAll(/\bkey:'([a-zA-Z.]+)'/g)) dlvKeys.add(m[1]);
      // §325 O9 adds the batch.* and fresh.* families (Fresh batches) and a body
      // that is added to after it is built (the wizard's body['…']=…).
      for (const m of dlvBlock.matchAll(/const body=\{('[^]*?)\};/g)) for (const k of m[1].match(/'((?:delivery|fees|pickup|notice|batch|fresh)\.[a-zA-Z]+)'/g) || []) dlvKeys.add(k.slice(1, -1));
      for (const m of dlvBlock.matchAll(/\bbody\['((?:delivery|fees|pickup|notice|batch|fresh)\.[a-zA-Z]+)'\]=/g)) dlvKeys.add(m[1]);
      is([...dlvKeys].sort(), ['batch.schedule', 'delivery.boxLabel', 'delivery.bulkTracking', 'delivery.coverage', 'delivery.defaultZone', 'delivery.enabled',
        'delivery.holidayMessage', 'delivery.holidayMode', 'delivery.kitchenAddress', 'delivery.pricingMode', 'delivery.sameDayCutoff',
        'delivery.sameDayCutoffMessage', 'delivery.sameDayCutoffMinutes', 'delivery.speed', 'fees.freeShippingThreshold', 'fees.minOrder',
        'fees.pickupPackingFee', 'fresh.morningRequestHour', 'fresh.rescheduleCutoffHour', 'notice.preorder', 'pickup.leadMinutes', 'pickup.window'],
        'the phone\'s Delivery settings write these twenty-two keys (§325 O4, O9)');
      for (const k of dlvKeys) ok(list(route('delivery')).every((c) => has(configKeyCap(k), c)), 'phone Delivery may write ' + k);
      is(who(/retail-admin\/polls|apiWrite\('\/polls/), ['public/cms.html', 'public/m.html', 'public/retail-admin/10-extras.js'], 'polls: Voting on both, the editor only reads');
      is(who(/retail-admin\/(voting|leaderboard)\/config|apiWrite\('\/(voting|leaderboard)\/config/), ['public/m.html', 'public/retail-admin/10-extras.js'], 'voting and leaderboard settings: the desktop tabs and the phone\'s two screens (§325 M7)');
      is(who(/retail-admin\/topup-|'\/topup-(packages|transactions)/), ['public/m.html', 'public/retail-admin/07-content-billing.js'], 'top-ups: the desktop tab and the phone\'s Wallet');
      is(who(/affiliate\/(settings|referrals)/), ['public/cms.html', 'public/m.html', 'public/retail-admin/10-extras.js'], 'affiliate settings and referrals: the desktop tabs and the phone write (§325 M8, M9), cms.html reads');
      /* §325 M8 — one phone write to /affiliate/settings: the invite share card,
         sending shareImage and shareTitle only (scBody), on the key the server
         gives that write for exactly this card (sharing:edit, section 1).
         */
      /* §325 M9 — and the phone's Affiliate screen: the offer's Save changes
         (the desktop's afxSave body) and the ledger's Void / Restore, each on
         the affiliate keys the server gives them, which open those screens. */
      is((M.match(/apiWrite\('\/affiliate\/settings/g) || []).length, 2, 'the phone writes the affiliate settings from two places: the invite card and the offer');
      ok(M.includes("apiWrite('/affiliate/settings',Object.assign({},AF.cfg),'PATCH')"), '…the offer, whole, as the desktop sends it');
      for (const r of ['affsettings', 'affiliate']) ok(list(route(r)).every((k) => has(R('PATCH', '/affiliate/settings'), k)), 'phone ' + r + ' may save the offer');
      ok(M.includes("put:(b,note)=>apiWrite('/affiliate/settings'+cfgHistQ('share.invite',note),b,'PATCH')"), '…the invite share card');
      ok(M.includes("if(pg.aff) return {shareImage:img, shareTitle:title};"), '…sending its picture and title and nothing else');
      ok(has(R('PATCH', '/affiliate/settings'), route('sharecards')), '…which the Share cards key may write');
      is((M.match(/apiWrite\('\/affiliate\/referrals\//g) || []).length, 1, 'the phone writes a referral row from one place (Void / Restore)');
      ok(list(route('affiliate')).every((k) => has(R('PATCH', '/affiliate/referrals/4'), k)), '…which the phone Affiliate key may write');
      is(route('affeligible'), 'affiliate:edit', 'phone: who earns the ongoing share opens on the eligibility key');
      is(who(/retail-admin\/cms\//), ['public/cms-mobile.html', 'public/cms.html', 'public/retail-admin/01-core.js',
        'public/retail-admin/05-marketing.js', 'public/retail-admin/10-extras.js'], '/cms/*: the two editors, and the desktop picture uploads');
      is(who(/flash-sale['`/]/), ['public/retail-admin/07-content-billing.js'], 'the flash sale: the desktop Flash sales tab');
    }
    section('6 · the screens open on the keys the gates name');
    is(tab('popups'), 'popups:view', 'desktop Pop-ups');
    is(route('popups'), 'popups:view', 'phone Pop-ups');
    is(tab('voting'), 'voting:edit', 'desktop Voting');
    is(route('voting'), 'voting:edit', 'phone Voting');
    is(tab('leaderboard'), 'leaderboard:edit', 'desktop Leaderboard');
    is(route('leaderboard'), 'leaderboard:edit', 'phone Leaderboard');
    is(route('polledit'), 'voting:edit', 'phone poll editor');
    is(tab('topup'), 'topup:edit', 'desktop Top-up');
    is(route('wallet'), 'topup:edit', 'phone Wallet');
    is(tab('affiliate'), 'affiliate:view', 'desktop Affiliate');
    is(tab('sharing'), 'sharing:edit', 'desktop Share cards');
    is(route('sharecards'), 'sharing:edit', 'phone Share cards');
    is(route('sharecard'), 'sharing:edit', 'phone Share cards → one page');
    is(route('social'), 'social:edit', 'phone Social proof');
    is(tab('flash'), 'flash:view', 'desktop Flash sales');
    ok(/caps && !caps\.includes\('content:edit'\)/.test(read('public/cms.html')), 'cms.html opens on content:edit');
    ok(/caps && !caps\.includes\('content:edit'\)/.test(read('public/cms-mobile.html')), 'cms-mobile.html likewise');
    ok(/data-sub="delivery" data-cap="delivery:view"/.test(read('public/retail-admin.html')), 'the desktop Delivery panel opens on delivery:view');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
