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
    ];
    for (const f of ['membership', 'affiliate', 'reviews', 'feedback', 'socialProof', 'faq']) {
      rows.push(['features.' + f, phoneSettings, 'phone Settings → Features']);
    }
    for (const [key, screen, who] of rows) {
      const need = configKeyCap(key);
      ok(screen.length && screen.every((k) => has(need, k)), `${key} — ${who} (${screen.join(' | ')})`,
        'need ' + JSON.stringify(need));
    }
    is(configKeyCap('support.hidden'), null, 'support.hidden stays open: the floating Support panel\'s Hide is drawn for everybody');

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
      is(who(/retail-admin\/config['"`?]/), [
        'public/cms-mobile.html', 'public/cms.html', 'public/product-editor.html', 'public/retail-admin.html',
        'public/retail-admin/01-core.js', 'public/retail-admin/05-marketing.js', 'public/retail-admin/06-delivery.js',
        'public/retail-admin/07-content-billing.js', 'public/retail-admin/09-products.js', 'public/retail-admin/10-extras.js',
        'public/retail-admin/17-setup-guide.js', 'public/retail-admin/31-product-page.js',
      ], 'PUT /config: the desktop files, the two editors and the product editor');
      // Inline bodies (apiWrite('/config',{...})) plus the history-filed form
      // (§333: Resume delivery builds `body` and writes /config?history=…).
      const inlineFam = (M.match(/apiWrite\('\/config',\{([^}]*)\}/g) || []).map((s) => s.replace(/apiWrite\('\/config',\{\[?'?/, '').split(/['\]]/)[0]);
      const historyFam = (M.match(/const body=\{'([a-zA-Z.]+)'[^}]*\};[\s\S]{0,300}?apiWrite\('\/config\?history=/g) || []).map((s) => s.match(/const body=\{'([a-zA-Z.]+)'/)[1]);
      is([...inlineFam, ...historyFam].sort(),
        ['delivery.holidayMode', 'features.', 'notifications.categories.', 'popups.list'], 'the phone writes four families, each asserted in section 2');
      is(who(/retail-admin\/polls|apiWrite\('\/polls/), ['public/cms.html', 'public/m.html', 'public/retail-admin/10-extras.js'], 'polls: Voting on both, the editor only reads');
      is(who(/retail-admin\/(voting|leaderboard)\/config/), ['public/retail-admin/10-extras.js'], 'voting and leaderboard settings: the desktop tabs');
      is(who(/retail-admin\/topup-|'\/topup-(packages|transactions)/), ['public/m.html', 'public/retail-admin/07-content-billing.js'], 'top-ups: the desktop tab and the phone\'s Wallet');
      is(who(/affiliate\/(settings|referrals)/), ['public/cms.html', 'public/m.html', 'public/retail-admin/10-extras.js'], 'affiliate settings and referrals: the desktop tabs write, the others read');
      ok(!/apiWrite\('\/affiliate\/(settings|referrals)/.test(M), '…the phone only reads them');
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
    is(tab('topup'), 'topup:edit', 'desktop Top-up');
    is(route('wallet'), 'topup:edit', 'phone Wallet');
    is(tab('affiliate'), 'affiliate:view', 'desktop Affiliate');
    is(tab('sharing'), 'sharing:edit', 'desktop Share cards');
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
