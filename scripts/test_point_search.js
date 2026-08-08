#!/usr/bin/env node
/**
 * Address search in the STAFF delivery-point picker.
 * See docs/tacet-delivery-point-confirmation-spec.md §5.4.
 *
 *   node scripts/test_point_search.js
 *
 * No network, no keys, no DB. routes/retail.js cannot be required here (it
 * opens a real database at load), and 04-orders.js is a browser script rather
 * than a module — so both are read as source and their real functions are run
 * in a vm with stubs, exactly the technique scripts/test_address_clients.js
 * uses for shop.html. Each test says which mode it is in.
 *
 * What it locks down — one thing above all others:
 *
 *   SEARCHING MOVES THE MAP. It cannot place a point, cannot enable the
 *   confirm button, and cannot post one. The only path to a staff_pin is still
 *   a tap on the map, because a searched result that could be confirmed
 *   directly would stamp staff_pin onto a geocoder's centroid — the exact
 *   laundering §5 leaves the map pinless to prevent.
 *
 * The guard is structural, not behavioural: the search path holds a handle
 * (qpMap) that exposes setCenter/setZoom and nothing else. Several tests below
 * assert the SHAPE of that handle rather than a symptom of it, so a future edit
 * that adds a pin setter fails here rather than at a customer's door.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function itAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
// These files are checked out with CRLF on Windows. Every pattern below is
// written against \n, so normalise once here rather than sprinkling \r? through
// a dozen regexes — where forgetting one would make the test pass by not
// matching anything, which is the worst failure mode a guard can have.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const RETAIL = read('routes/retail.js');
const ORDERS = read('public/retail-admin/04-orders.js');
const CSS = read('public/retail-admin.css');
const GEOCODE = read('lib/geocode.js');

// Lift a function out of a source file by walking braces from its opening {.
// Keeps an `async` prefix, which the shop.html version in test_address_clients
// did not need and this one does.
function grab(src, name, label) {
  const at = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(at > -1, `${name} not found in ${label}`);
  // Walk the PARAMETER list to its closing paren first. A destructured
  // parameter — `function poiTencent({ lat, lng, kw })` — opens a brace before
  // the body does, and taking the first `{` after the name counted that one
  // instead: the walk then "closed" at `})` and returned the signature alone,
  // which parses as an unterminated function.
  let i = src.indexOf('(', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  const open = src.indexOf('{', i);
  depth = 0;
  for (i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}
// The express route registration line, as one string, for the gate checks.
function routeLine(src, method, urlPath) {
  const m = src.match(new RegExp(`router\\.${method}\\('${urlPath.replace(/\//g, '\\/')}'[^\\n]*`));
  return m ? m[0] : null;
}

(async () => {

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nthe admin endpoint — who may call it (source, call-site guard)');

it('the staff route is gated by requireRetailAdmin', () => {
  const line = routeLine(RETAIL, 'post', '/api/retail-admin/poi-search');
  assert.ok(line, 'the admin poi-search route is not registered');
  assert.match(line, /requireRetailAdmin/, 'must be gated by the admin middleware');
});

it('the staff route does NOT use requireRetailAuth', () => {
  // requireRetailAuth reads a customer Bearer token off the Authorization
  // header. An operator's session carries none, so this gate would 401 every
  // member of staff — the whole reason a second route exists.
  const line = routeLine(RETAIL, 'post', '/api/retail-admin/poi-search');
  assert.doesNotMatch(line, /requireRetailAuth/);
});

it('the gate is the FIRST middleware, before the body parser', () => {
  // express.json() ahead of the gate would parse an unauthenticated body.
  const line = routeLine(RETAIL, 'post', '/api/retail-admin/poi-search');
  assert.match(line, /'\/api\/retail-admin\/poi-search',\s*requireRetailAdmin,\s*express\.json\(\)/);
});

it('requireRetailAdmin is a real function in this file, not a typo', () => {
  // A misspelled middleware name is `undefined` at registration and express
  // throws at boot — but only for a route someone actually loads. Assert it.
  assert.match(RETAIL, /function requireRetailAdmin\s*\(req, res, next\)/);
});

it('the customer route is untouched and still customer-gated', () => {
  // Adding a staff route must not have widened the one the storefront uses.
  const line = routeLine(RETAIL, 'post', '/api/retail/poi-search');
  assert.ok(line, 'the customer poi-search route is gone');
  assert.match(line, /requireRetailAuth/);
  assert.doesNotMatch(line, /requireRetailAdmin/);
});

it('exactly one admin poi-search route exists', () => {
  const n = (RETAIL.match(/router\.post\('\/api\/retail-admin\/poi-search'/g) || []).length;
  assert.strictEqual(n, 1, 'a second registration would shadow the first silently');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nthe admin endpoint — the gate, run (vm, stubbed deps)');

// requireRetailAdmin, lifted and run against stubs. This is the shipped
// middleware, not a re-implementation of it.
function runGate({ session, headers, backendUser, tenant }) {
  const out = { nexted: false, status: null, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
  };
  const sandbox = {
    console,
    db: { prepare: (sql) => ({ get: () => (/tenant_users/.test(sql) ? backendUser : tenant) }) },
    // The kitchen fallback: no kitchen session in any of these cases, so it
    // answers the way the real requireAuth does — 401, and never calls on.
    requireAuth: (req, r) => { r.status(401).json({ error: 'unauthorized' }); },
    _retailKitchenPermission: () => { throw new Error('must not be reached'); },
    getTenantDb: () => ({}),
    rawTenantDb: () => ({}),
    tenantAls: { run: (_db, fn) => fn() },
    ROOTS_TENANT_ID: 1,
    require: () => { throw new Error('no libs in the sandbox'); },   // caught by the code
  };
  vm.createContext(sandbox);
  vm.runInContext(grab(RETAIL, 'requireRetailAdmin', 'routes/retail.js'), sandbox);
  sandbox.__req = { session: session || {}, headers: headers || {}, method: 'POST', path: '/api/retail-admin/poi-search', ip: '1.1.1.1' };
  sandbox.__res = res;
  sandbox.__next = () => { out.nexted = true; };
  vm.runInContext('requireRetailAdmin(__req, __res, __next)', sandbox);
  return out;
}

it('no session at all is rejected', () => {
  const r = runGate({});
  assert.strictEqual(r.nexted, false, 'an anonymous caller must never reach the handler');
  assert.strictEqual(r.status, 401);
});

it('a CUSTOMER bearer token is rejected — it is not staff credentials', () => {
  // The token the storefront sends is valid for /api/retail/poi-search and
  // means nothing here. This is the asymmetry that makes the second route
  // necessary, so it is asserted in both directions.
  const r = runGate({ headers: { authorization: 'Bearer abc123customer' } });
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 401);
});

it('an active backend operator is accepted', () => {
  const r = runGate({
    session: { backendUserId: 7 },
    backendUser: { id: 7, username: 'ops', role: 'staff', tenant_id: 3, is_active: 1 },
    tenant: { id: 3, status: 'active' },
  });
  assert.strictEqual(r.nexted, true, 'staff must reach the handler');
  assert.strictEqual(r.status, null, 'and must not be answered by the gate');
});

it('an operator on a suspended tenant is rejected', () => {
  const r = runGate({
    session: { backendUserId: 7 },
    backendUser: { id: 7, username: 'ops', role: 'staff', tenant_id: 3, is_active: 1 },
    tenant: { id: 3, status: 'suspended' },
  });
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nthe admin endpoint — the handler, run (vm, stubbed geocode)');

// The handler is the arrow function passed as the third argument. Lift it by
// walking from the `async (req, res) =>` that follows the registration.
const ADMIN_HANDLER = (() => {
  const at = RETAIL.indexOf("router.post('/api/retail-admin/poi-search'");
  assert.ok(at > -1);
  const arrow = RETAIL.indexOf('async (req, res) => {', at);
  const open = RETAIL.indexOf('{', arrow + 'async (req, res) =>'.length);
  let depth = 0, i = open;
  for (; i < RETAIL.length; i++) {
    if (RETAIL[i] === '{') depth++;
    else if (RETAIL[i] === '}') { depth--; if (depth === 0) break; }
  }
  return 'async function __handler(req, res) ' + RETAIL.slice(open, i + 1);
})();

async function callHandler(body, { configured = true, searchPoi } = {}) {
  const out = { status: 200, body: null, called: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
  };
  const sandbox = {
    console: { warn() {} },
    geocode: {
      configured: () => configured,
      searchPoi: searchPoi || (async (args) => { out.called = args; return [{ name: 'A', lat: 23.1, lng: 113.3 }]; }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(ADMIN_HANDLER, sandbox);
  sandbox.__req = { body };
  sandbox.__res = res;
  await vm.runInContext('__handler(__req, __res)', sandbox);
  return out;
}

await itAsync('a keyword search returns the same shape the customer route returns', async () => {
  const r = await callHandler({ keyword: '品秀星越花园' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.success, true);
  assert.deepStrictEqual(r.body.data, [{ name: 'A', lat: 23.1, lng: 113.3 }]);
});

await itAsync('the city and the guess coordinates are forwarded as bias', async () => {
  const r = await callHandler({ keyword: '天河路', city: '广州市', lat: 23.1339, lng: 113.3603 });
  assert.strictEqual(r.called.city, '广州市');
  assert.strictEqual(r.called.lat, 23.1339);
  assert.strictEqual(r.called.lng, 113.3603);
  assert.strictEqual(r.called.keyword, '天河路');
});

await itAsync('an order with no recorded guess still searches, just wider', async () => {
  // The bias is a hint. A parked order whose guess was never recorded must not
  // lose the search along with it.
  const r = await callHandler({ keyword: '天河路', city: '广州市' });
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.called.lat, undefined, 'no bias, rather than a wrong one');
});

await itAsync('a null or zero coordinate is ABSENT, not a point off West Africa', async () => {
  // Number(null) is 0, and 0 is finite. Taken at face value it biases every
  // result towards 0°N 0°E and ranks the right answer last — a bug that looks
  // like a bad search rather than like a bad bias, which is why it is asserted
  // rather than left to the reader of the coercion.
  for (const body of [
    { keyword: '天河路', lat: null, lng: null },
    { keyword: '天河路', lat: 0, lng: 0 },
    { keyword: '天河路', lat: 23.13, lng: 0 },
    { keyword: '天河路', lat: 'nonsense', lng: 'nonsense' },
  ]) {
    const r = await callHandler(body);
    assert.strictEqual(r.body.success, true, 'and it still searches');
    assert.strictEqual(r.called.lat, undefined, JSON.stringify(body));
    assert.strictEqual(r.called.lng, undefined, JSON.stringify(body));
  }
});

it('a partial bias is refused as a pair — one coordinate is not a place', () => {
  const line = RETAIL.slice(RETAIL.indexOf("router.post('/api/retail-admin/poi-search'"));
  assert.match(line.slice(0, 2000),
    /Number\.isFinite\(rawLat\) && Number\.isFinite\(rawLng\) && rawLat !== 0 && rawLng !== 0/);
});

await itAsync('an empty keyword is refused — this route is text search only', async () => {
  // The customer route also serves a keyword-less "places around here" list.
  // Staff have no such surface, and leaving the branch reachable would widen
  // this endpoint past the one thing it exists for.
  for (const body of [{}, { keyword: '' }, { keyword: '   ' }, { lat: 23.1, lng: 113.3 }]) {
    const r = await callHandler(body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.error, 'bad_input');
  }
});

await itAsync('a non-string keyword cannot reach the provider', async () => {
  const r = await callHandler({ keyword: { toString: () => 'x' } });
  assert.strictEqual(r.status, 400);
});

await itAsync('keyword and city are clamped', async () => {
  const r = await callHandler({ keyword: 'x'.repeat(200), city: 'y'.repeat(200) });
  assert.strictEqual(r.called.keyword.length, 60);
  assert.strictEqual(r.called.city.length, 40);
});

await itAsync('no maps key says so, and does not pretend the search found nothing', async () => {
  const r = await callHandler({ keyword: '天河路' }, { configured: false });
  assert.strictEqual(r.body.success, false);
  assert.strictEqual(r.body.error, 'maps_key_missing');
});

await itAsync('a provider failure is reported, never thrown at the operator', async () => {
  const r = await callHandler({ keyword: '天河路' }, { searchPoi: async () => { throw new Error('boom'); } });
  assert.strictEqual(r.body.success, false);
  assert.strictEqual(r.body.error, 'lookup_failed');
});

await itAsync('a null result is no_result, not an empty success', async () => {
  const r = await callHandler({ keyword: '天河路' }, { searchPoi: async () => null });
  assert.strictEqual(r.body.error, 'no_result');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nthe picker handle — the invariant, as a SHAPE (source)');

// Every qpMap registration in the file, as parsed key sets.
const HANDLES = (() => {
  const out = [];
  const re = /qpMap\[orderId\]\s*=\s*\{([\s\S]*?)\n\s*\};/g;
  let m;
  while ((m = re.exec(ORDERS))) {
    out.push(m[1].split('\n').map(l => (l.match(/^\s*(\w+)\s*:/) || [])[1]).filter(Boolean));
  }
  return out;
})();

it('both providers register a handle', () => {
  assert.strictEqual(HANDLES.length, 2, 'Amap and Tencent — a provider with no handle has no search');
});

it('the handle exposes ONLY setCenter and setZoom', () => {
  // This is the invariant. A pin setter here would let a search result place a
  // point, which stamps staff_pin onto a geocoder centroid — the laundering the
  // pinless map exists to prevent, performed by a person instead of by code.
  for (const keys of HANDLES) {
    assert.deepStrictEqual(keys.slice().sort(), ['setCenter', 'setZoom'],
      `handle exposes ${JSON.stringify(keys)} — a search must not be able to do anything else`);
  }
});

it('no handle key names a marker, a pin or a placement', () => {
  // Belt and braces: catches a rename that keeps the count at two.
  for (const keys of HANDLES) {
    for (const k of keys) {
      assert.doesNotMatch(k, /pin|marker|place|position|confirm/i, `${k} must not be reachable from search`);
    }
  }
});

it('exactly one site in the file writes qpPlaced — the tap handler', () => {
  // The single door to a confirmable point. An exact count, not a cap: a cap
  // with slack lets a second writer be added for free, which is the regression.
  const sites = ORDERS.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /qpPlaced\[[^\]]+\]\s*=/.test(l));
  assert.strictEqual(sites.length, 1, `qpPlaced writers changed — review each: ${JSON.stringify(sites)}`);
  assert.match(sites[0][1], /qpPlaced\[orderId\] = \{ lat, lng \}/);
});

it('the one writer is inside onPlace, which only the map click and drag call', () => {
  const draw = grab(ORDERS, 'qpDrawMap', '04-orders.js');
  assert.match(draw, /const onPlace = \(lat, lng\) => \{[\s\S]*qpPlaced\[orderId\]/, 'onPlace owns the write');
  // Its callers, all inside qpDrawMap: the Amap click, the Amap dragend and the
  // Tencent click. Nothing outside this function can call it — it is a const in
  // the closure — so three is the complete set of ways a point gets recorded.
  const calls = (draw.match(/onPlace\(/g) || []).length;
  assert.strictEqual(calls, 3, 'amap click, amap dragend, tencent click — and no fourth');
  assert.strictEqual((ORDERS.match(/onPlace/g) || []).length, (draw.match(/onPlace/g) || []).length,
    'onPlace must not be referenced anywhere outside qpDrawMap');
});

it('qpFindPick touches neither the point nor the button', () => {
  const pick = grab(ORDERS, 'qpFindPick', '04-orders.js');
  assert.doesNotMatch(pick, /qpPlaced\s*\[[^\]]*\]\s*=/, 'must not record a point');
  assert.doesNotMatch(pick, /qp-go-/, 'must not reach the confirm button');
  assert.doesNotMatch(pick, /disabled/, 'must not enable anything');
  assert.doesNotMatch(pick, /Marker|Circle|new AMap|new TMap/, 'must not draw on the map itself');
});

it('qpFindNow only reads results — it never records one', () => {
  const now = grab(ORDERS, 'qpFindNow', '04-orders.js');
  assert.doesNotMatch(now, /qpPlaced/);
  assert.doesNotMatch(now, /qp-go-/);
});

it('the confirm POST still sends bare coordinates, and the server still names the source', () => {
  // Provenance is unchanged by this build: the client cannot claim a source,
  // and staff_pin is stamped server-side whether the map was searched or hunted.
  const confirm = grab(ORDERS, 'qpConfirmPoint', '04-orders.js');
  assert.match(confirm, /JSON\.stringify\(\{ lat: p\.lat, lng: p\.lng \}\)/, 'no source field may be sent');
  assert.doesNotMatch(confirm, /staff_pin|pin_source|geo_source/);
  assert.match(RETAIL, /geo_source: 'staff_pin', geo_precision: null/, 'the server still decides');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nthe picker — search then tap, run (vm, stubbed DOM + SDK)');

// A sandbox holding the REAL qp* functions: the registry declarations, the map
// builder (against a stub AMap), and the three search handlers.
function pickerSandbox({ searchResults = [{ name: '品秀星越花园A栋', address: '广东省广州市天河区珠江西路15号', lat: 23.11, lng: 113.32 }] } = {}) {
  const els = {};
  const el = (id) => (els[id] || (els[id] = {
    id, textContent: '', innerHTML: '', value: '', hidden: false,
    disabled: false, className: '', dataset: {},
  }));
  const centred = [];
  const zoomed = [];
  let clickHandler = null;

  const sandbox = {
    console,
    document: { getElementById: (id) => els[id] || null },
    setTimeout, clearTimeout,
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    cuT: (en) => en,                                   // one live language, English
    api: async () => ({ success: true, data: searchResults }),
    AMap: {
      Map: function () {
        this.setCenter = (c) => centred.push(c);
        this.setZoom = (z) => zoomed.push(z);
        this.on = (ev, fn) => { if (ev === 'click') clickHandler = fn; };
      },
      Circle: function () {},
      Marker: function () { this.on = () => {}; this.setPosition = () => {}; },
    },
    __els: el, __centred: centred, __zoomed: zoomed,
    __click: (lat, lng) => clickHandler({ lnglat: { getLat: () => lat, getLng: () => lng } }),
  };
  vm.createContext(sandbox);
  // The module-level registries, verbatim from the file.
  const decls = ['qpPlaced', 'qpMap', 'qpBias', 'qpFound', 'qpFindTimer', 'qpFindQuery']
    .map((n) => {
      const m = ORDERS.match(new RegExp(`^const ${n} = \\{\\};$`, 'm'));
      assert.ok(m, `${n} declaration not found — the registry was renamed`);
      return m[0];
    }).join('\n');
  // The circle radius qpDrawMap draws the area with, taken from the file rather
  // than guessed, so this harness cannot drift from what ships.
  const area = ORDERS.match(/^const QP_AREA_M = \d+;$/m);
  assert.ok(area, 'QP_AREA_M not found');
  vm.runInContext([
    decls,
    area[0],
    grab(ORDERS, 'qpDrawMap', '04-orders.js'),
    grab(ORDERS, 'qpFindType', '04-orders.js'),
    grab(ORDERS, 'qpFindNow', '04-orders.js'),
    grab(ORDERS, 'qpFindPick', '04-orders.js'),
  ].join('\n\n'), sandbox);
  return sandbox;
}

// The three elements the surface owns for order 988, in their opening state.
function bootPicker(sandbox) {
  const mapEl = sandbox.__els('qp-map-988');
  const btn = sandbox.__els('qp-go-988'); btn.disabled = true; btn.textContent = 'Place the point';
  sandbox.__els('qp-state-988').textContent = 'No point placed yet';
  sandbox.__els('qp-hint-988').textContent = 'Tap the map where the door is.';
  sandbox.__els('qp-find-988').value = '';
  sandbox.__els('qp-find-out-988').hidden = true;
  vm.runInContext('qpBias[988] = { city: "广州市", lat: 23.1339, lng: 113.3603 }', sandbox);
  vm.runInContext('qpDrawMap("amap", __els("qp-map-988"), 988, { lat: 23.1339, lng: 113.3603 })', sandbox);
  return { mapEl, btn };
}

await itAsync('picking a search result recentres and zooms the map', async () => {
  const s = pickerSandbox();
  bootPicker(s);
  s.__els('qp-find-988').value = '品秀星越';
  await vm.runInContext('qpFindNow(988)', s);
  vm.runInContext('qpFindPick(988, 0)', s);
  assert.strictEqual(JSON.stringify(s.__centred), JSON.stringify([[113.32, 23.11]]),
    'one recentre, on the result, and Amap takes [lng, lat]');
  assert.strictEqual(JSON.stringify(s.__zoomed), JSON.stringify([17]),
    'close enough to pick a building out, and no second zoom');
});

await itAsync('…and leaves NO point behind (the invariant, at runtime)', async () => {
  const s = pickerSandbox();
  const { btn } = bootPicker(s);
  s.__els('qp-find-988').value = '品秀星越';
  await vm.runInContext('qpFindNow(988)', s);
  vm.runInContext('qpFindPick(988, 0)', s);
  assert.strictEqual(vm.runInContext('Object.keys(qpPlaced).length', s), 0,
    'a search result must never become a confirmable point');
  assert.strictEqual(btn.disabled, true, 'the confirm button stays disabled');
  assert.strictEqual(btn.textContent, 'Place the point', 'and keeps asking for one');
  assert.strictEqual(s.__els('qp-state-988').textContent, 'No point placed yet',
    'because there is still no point');
});

await itAsync('the hint moves the operator on to the tap', async () => {
  const s = pickerSandbox();
  bootPicker(s);
  s.__els('qp-find-988').value = '品秀星越';
  await vm.runInContext('qpFindNow(988)', s);
  vm.runInContext('qpFindPick(988, 0)', s);
  assert.match(s.__els('qp-hint-988').textContent, /Tap where the door is/);
  assert.strictEqual(s.__els('qp-find-out-988').hidden, true, 'and the list closes');
});

await itAsync('a tap AFTER a search places the point exactly as a tap without one does', async () => {
  const s = pickerSandbox();
  const { btn } = bootPicker(s);
  s.__els('qp-find-988').value = '品秀星越';
  await vm.runInContext('qpFindNow(988)', s);
  vm.runInContext('qpFindPick(988, 0)', s);
  // The operator now taps the door — a few metres off the POI the search found.
  vm.runInContext('__click(23.1104, 113.3208)', s);
  // Read the fields out INSIDE the vm: an object built in the sandbox realm is
  // not deepStrictEqual to one built here, whatever it holds.
  assert.strictEqual(vm.runInContext('JSON.stringify(qpPlaced[988])', s),
    JSON.stringify({ lat: 23.1104, lng: 113.3208 }),
    'the TAP is what records the point — not the search result');
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Confirm and dispatch');
  assert.strictEqual(s.__els('qp-state-988').textContent, 'Point placed');
});

await itAsync('the point recorded is the tap, never the search result', async () => {
  const s = pickerSandbox();
  bootPicker(s);
  s.__els('qp-find-988').value = '品秀星越';
  await vm.runInContext('qpFindNow(988)', s);
  vm.runInContext('qpFindPick(988, 0)', s);
  vm.runInContext('__click(23.2000, 113.4000)', s);
  const p = vm.runInContext('qpPlaced[988]', s);
  assert.notStrictEqual(p.lat, 23.11, 'the POI coordinate must not leak into the placed point');
  assert.strictEqual(p.lat, 23.2);
});

await itAsync('the search is biased by the order city and the parked guess', async () => {
  let sent = null;
  const s = pickerSandbox();
  s.api = async (_p, opts) => { sent = opts; return { success: true, data: [] }; };
  bootPicker(s);
  s.__els('qp-find-988').value = '天河路';
  await vm.runInContext('qpFindNow(988)', s);
  assert.strictEqual(sent.method, 'POST');
  assert.strictEqual(JSON.stringify(sent.body),
    JSON.stringify({ keyword: '天河路', city: '广州市', lat: 23.1339, lng: 113.3603 }));
});

await itAsync('an order with no guess sends no coordinates at all', async () => {
  // The client half of the 0,0 guard: a null must never leave the browser.
  let sent = null;
  const s = pickerSandbox();
  s.api = async (_p, opts) => { sent = opts; return { success: true, data: [] }; };
  bootPicker(s);
  vm.runInContext('qpBias[988] = { city: "广州市", lat: null, lng: null }', s);
  s.__els('qp-find-988').value = '天河路';
  await vm.runInContext('qpFindNow(988)', s);
  assert.strictEqual(JSON.stringify(sent.body), JSON.stringify({ keyword: '天河路', city: '广州市' }),
    'lat/lng omitted entirely — a null would arrive as 0');
});

await itAsync('an empty box closes the list and asks nothing', async () => {
  let calls = 0;
  const s = pickerSandbox();
  s.api = async () => { calls++; return { success: true, data: [] }; };
  bootPicker(s);
  s.__els('qp-find-988').value = '   ';
  await vm.runInContext('qpFindNow(988)', s);
  assert.strictEqual(calls, 0, 'no request for a blank query');
  assert.strictEqual(s.__els('qp-find-out-988').hidden, true);
});

await itAsync('no match is said in words, quoting what was typed', async () => {
  const s = pickerSandbox({ searchResults: [] });
  bootPicker(s);
  s.__els('qp-find-988').value = '不存在的地方';
  await vm.runInContext('qpFindNow(988)', s);
  assert.match(s.__els('qp-find-out-988').innerHTML, /No place matches/);
  assert.strictEqual(s.__els('qp-find-out-988').hidden, false);
});

await itAsync('a result with no coordinates is dropped, not offered', async () => {
  // Picking it would call setCenter(null, null) and move the map nowhere,
  // which reads as a broken click rather than as a bad result.
  const s = pickerSandbox({ searchResults: [{ name: 'X', lat: null, lng: null }] });
  bootPicker(s);
  s.__els('qp-find-988').value = 'X';
  await vm.runInContext('qpFindNow(988)', s);
  assert.strictEqual(vm.runInContext('qpFound[988].length', s), 0);
  assert.match(s.__els('qp-find-out-988').innerHTML, /No place matches/);
});

await itAsync('a missing map key is explained, and still points at the map', async () => {
  const s = pickerSandbox();
  s.api = async () => { const e = new Error('maps_key_missing'); e.code = 'maps_key_missing'; throw e; };
  bootPicker(s);
  s.__els('qp-find-988').value = '天河路';
  await vm.runInContext('qpFindNow(988)', s);
  const html = s.__els('qp-find-out-988').innerHTML;
  assert.match(html, /none is configured/i, 'names the cause, rather than reporting no results');
  assert.match(html, /Place the point on the map instead/i, 'never a dead end');
});

await itAsync('a stale answer cannot paint over a newer keystroke', async () => {
  const s = pickerSandbox();
  let resolveSlow;
  const slow = new Promise((r) => { resolveSlow = r; });
  let n = 0;
  s.api = async () => {
    n++;
    if (n === 1) { await slow; return { success: true, data: [{ name: 'STALE', lat: 1, lng: 1 }] }; }
    return { success: true, data: [{ name: 'FRESH', lat: 23.1, lng: 113.3 }] };
  };
  bootPicker(s);
  s.__els('qp-find-988').value = '天';
  const first = vm.runInContext('qpFindNow(988)', s);
  s.__els('qp-find-988').value = '天河路';
  await vm.runInContext('qpFindNow(988)', s);
  resolveSlow();
  await first;
  assert.match(s.__els('qp-find-out-988').innerHTML, /FRESH/);
  assert.doesNotMatch(s.__els('qp-find-out-988').innerHTML, /STALE/);
});

await itAsync('a result name is escaped before it is written into the list', async () => {
  const s = pickerSandbox({ searchResults: [{ name: '<img src=x onerror=alert(1)>', address: 'a', lat: 23.1, lng: 113.3 }] });
  bootPicker(s);
  s.__els('qp-find-988').value = 'x';
  await vm.runInContext('qpFindNow(988)', s);
  assert.doesNotMatch(s.__els('qp-find-out-988').innerHTML, /<img/);
  assert.match(s.__els('qp-find-out-988').innerHTML, /&lt;img/);
});

it('typing is debounced, not fired per keystroke', () => {
  const type = grab(ORDERS, 'qpFindType', '04-orders.js');
  assert.match(type, /clearTimeout\(qpFindTimer\[orderId\]\)/);
  assert.match(type, /setTimeout\(\(\) => qpFindNow\(orderId\), 350\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nscope — the drawer, and nowhere else');

it('every new CSS rule is scoped to #order-drawer', () => {
  const rules = CSS.split('\n').filter(l => /\.qp-find/.test(l) && /\{\s*$|\{.*\}/.test(l));
  assert.ok(rules.length >= 8, `expected the search rules, found ${rules.length}`);
  for (const r of rules) {
    assert.match(r.trim(), /^#order-drawer /, `unscoped rule would leak product-wide: ${r.trim()}`);
  }
});

it('search markup is emitted from two places only, both inside the surface', () => {
  // A drawer-only control leaks by being templated somewhere else, so count the
  // emission sites rather than trusting the class prefix. There are exactly
  // two: the surface renders the box, and qpFindNow writes the results list
  // INTO that box's own element. Anything else is a second mount.
  const markup = /(?:id|class)="qp-find/g;
  const surface = grab(ORDERS, 'renderQyPointSurface', '04-orders.js');
  const findNow = grab(ORDERS, 'qpFindNow', '04-orders.js');
  const inFile = (ORDERS.match(markup) || []).length;
  const inSurface = (surface.match(markup) || []).length;
  const inFindNow = (findNow.match(markup) || []).length;
  assert.strictEqual(inSurface, 6, 'wrapper, input and results list, each with a class and an id');
  assert.strictEqual(inFindNow, 1, 'only the note line — the results themselves are plain buttons');
  assert.strictEqual(inFile, inSurface + inFindNow, 'no third site emits this markup');
  assert.match(findNow, /getElementById\('qp-find-out-' \+ orderId\)/,
    'and it writes into the surface\'s own element, never document.body');
});

it('nothing search-related exists on a customer-facing surface', () => {
  // The storefront and the mini-app have their own pickers with their own
  // search. This one is staff-only and must not appear on either.
  for (const rel of ['public/shop.html', 'miniapp/pages/map-picker/map-picker.js',
                     'miniapp/pages/addresses/addresses.js', 'miniapp/pages/checkout/checkout.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /qp-find|qpFindPick|retail-admin\/poi-search/, rel);
  }
});

it('the expired-order surface gets no search box — it cannot use one', () => {
  // A passed delivery date is a different problem; that branch returns before
  // the map exists, so a search box there would move nothing.
  const surface = grab(ORDERS, 'renderQyPointSurface', '04-orders.js');
  const expired = surface.slice(surface.indexOf('if (expired)'), surface.indexOf('return `\n    <div class="qp"'));
  assert.doesNotMatch(expired, /qp-find/);
});

it('no map means no search box', () => {
  const init = grab(ORDERS, 'qpInitMap', '04-orders.js');
  assert.strictEqual((init.match(/qpHideFind\(orderId\)/g) || []).length, 2,
    'both the no-key and the load-failed branches must hide it');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nSDK loading is untouched (R5)');

it('the provider switch and the SDK URLs are unchanged', () => {
  assert.match(RETAIL, /if \(amapJs\) \{\n\s*return res\.json\(\{ success: true, data: \{ provider: 'amap'/,
    '/api/retail/maps-config must still choose the provider the same way');
  const loader = grab(ORDERS, 'qpLoadSdk', '04-orders.js');
  assert.match(loader, /webapi\.amap\.com\/maps\?v=2\.0/);
  assert.match(loader, /map\.qq\.com\/api\/gljs/);
  assert.doesNotMatch(loader, /plugin=/, 'search goes through the server — no JS-API service plugin is loaded');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nqpLoadSdk never injects an SDK the page already has (vm)');

// Run the real loader against a stub window/document. Returns what it resolved
// to and every script element it tried to append.
async function loadSdk({ provider, already }) {
  const appended = [];
  const sandbox = {
    console,
    document: { head: { appendChild: (s) => { appended.push(s); s.onload && s.onload(); } },
                createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }) },
    window: {},
  };
  if (already) sandbox.window[provider === 'amap' ? 'AMap' : 'TMap'] = {};
  vm.createContext(sandbox);
  vm.runInContext('let _qpSdkP = null;\n' + grab(ORDERS, 'qpLoadSdk', '04-orders.js'), sandbox);
  sandbox.__cfg = { provider, key: 'K', security: 'S' };
  const p = vm.runInContext('qpLoadSdk(__cfg)', sandbox);
  // The injecting path resolves through the SDK's callback; fire it as the real
  // SDK would once the script has run.
  if (!already) vm.runInContext('window.__qpMapReady && window.__qpMapReady()', sandbox);
  return { resolved: await p, appended, sandbox };
}

for (const provider of ['amap', 'tencent']) {
  const host = provider === 'amap' ? 'webapi.amap.com' : 'map.qq.com';

  await itAsync(`${provider}: with the SDK already on the page, nothing is injected`, async () => {
    // The regression: opening an in-transit order (which loads the SDK through
    // _adminLoadAmapOnce) and then a parked one used to append a second copy.
    const r = await loadSdk({ provider, already: true });
    assert.strictEqual(r.appended.length, 0, 'a second SDK script must not be appended');
    assert.strictEqual(r.resolved, provider, 'and it still resolves, so the map still draws');
  });

  await itAsync(`${provider}: with no SDK on the page, it loads from ${host}`, async () => {
    const r = await loadSdk({ provider, already: false });
    assert.strictEqual(r.appended.length, 1, 'the first load must still happen');
    assert.match(r.appended[0].src, new RegExp(host.replace('.', '\\.')));
    assert.strictEqual(r.resolved, provider);
  });
}

await itAsync('the guard is per provider — an Amap global does not satisfy Tencent', async () => {
  // The two globals are different objects and the loaders can only agree on the
  // one /api/retail/maps-config named. A guard that tested either would skip a
  // load the page genuinely needs, and the map would never draw.
  const sandbox = { console, window: { AMap: {} },
    document: { head: { appendChild() {} }, createElement: () => ({}) } };
  vm.createContext(sandbox);
  vm.runInContext('let _qpSdkP = null;\n' + grab(ORDERS, 'qpLoadSdk', '04-orders.js'), sandbox);
  assert.strictEqual(vm.runInContext('(function(){ const c = { provider: "tencent", key: "K" };'
    + ' const g = c.provider === "amap" ? window.AMap : window.TMap; return !!g; })()', sandbox), false,
    'window.AMap must not count as the Tencent SDK');
});

it('the guard reads the global, not the memo — the memo alone never proved a load', () => {
  const loader = grab(ORDERS, 'qpLoadSdk', '04-orders.js');
  assert.match(loader, /cfg\.provider === 'amap' \? window\.AMap : window\.TMap/);
  assert.match(loader, /if \(_qpSdkP\) return _qpSdkP;/, 'the existing memo stays as the first check');
});

it('the search needs no browser maps key of its own', () => {
  // The whole point of routing search through the server: it uses the
  // WebService key lib/geocode already holds, so no provider-console change and
  // no second key to whitelist.
  const now = grab(ORDERS, 'qpFindNow', '04-orders.js');
  assert.doesNotMatch(now, /AMap|TMap|maps-config/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Two hazards the staff route was built around, latched shut on the paths that
// merely happen not to hit them today.
console.log('\nthe customer route carries the same zero guard (vm)');

const CUSTOMER_HANDLER = (() => {
  const at = RETAIL.indexOf("router.post('/api/retail/poi-search'");
  assert.ok(at > -1, 'the customer poi-search route is gone');
  const arrow = RETAIL.indexOf('async (req, res) => {', at);
  const open = RETAIL.indexOf('{', arrow + 'async (req, res) =>'.length);
  let depth = 0, i = open;
  for (; i < RETAIL.length; i++) {
    if (RETAIL[i] === '{') depth++;
    else if (RETAIL[i] === '}') { depth--; if (depth === 0) break; }
  }
  return 'async function __customer(req, res) ' + RETAIL.slice(open, i + 1);
})();

async function callCustomer(body) {
  const out = { status: 200, body: null, called: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  const sandbox = {
    console: { warn() {} },
    geocode: { configured: () => true, searchPoi: async (a) => { out.called = a; return [{ name: 'A', lat: 23.1, lng: 113.3 }]; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(CUSTOMER_HANDLER, sandbox);
  sandbox.__req = { body }; sandbox.__res = res;
  await vm.runInContext('__customer(__req, __res)', sandbox);
  return out;
}

await itAsync('a null/zero centre is dropped rather than searched around', async () => {
  for (const body of [{ keyword: '天河路', lat: null, lng: null },
                      { keyword: '天河路', lat: 0, lng: 0 },
                      { keyword: '天河路', lat: 23.13, lng: 0 }]) {
    const r = await callCustomer(body);
    assert.strictEqual(r.body.success, true, 'the keyword still searches');
    assert.strictEqual(r.called.lat, undefined, JSON.stringify(body));
    assert.strictEqual(r.called.lng, undefined, JSON.stringify(body));
  }
});

await itAsync('a keyword-less request at 0,0 is bad input, not a search of the Atlantic', async () => {
  // The nearby branch is the dangerous one: no keyword means "the places
  // NEAREST this point", so a bogus centre returns confident, useless results.
  const r = await callCustomer({ lat: 0, lng: 0 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'bad_input');
});

await itAsync('the storefront and mini-app calls are unaffected', async () => {
  // The three shapes the live clients actually send.
  const keywordOnly = await callCustomer({ keyword: '品秀星越花园', city: '广州市' });
  assert.strictEqual(keywordOnly.body.success, true);
  const nearby = await callCustomer({ lat: 23.1291, lng: 113.2644 });
  assert.strictEqual(nearby.called.lat, 23.1291, 'the keyword-less nearby list still works');
  const both = await callCustomer({ keyword: '天河路', city: '广州市', lat: 23.1291, lng: 113.2644 });
  assert.strictEqual(both.called.lng, 113.2644);
});

await itAsync('a small but real coordinate still biases', async () => {
  const r = await callCustomer({ keyword: 'x', lat: 0.0001, lng: 0.0001 });
  assert.strictEqual(r.called.lat, 0.0001, 'only the exact value 0 is refused');
});

console.log('\npoiTencent never sends a malformed boundary (vm)');

// The real function, against a stubbed fetchJson that captures the URL.
async function tencentUrl(args) {
  let seen = null;
  const sandbox = {
    console,
    TENCENT_KEY: 'TKEY',
    encodeURIComponent,
    isFinite,
    Array,
    fetchJson: async (u) => { seen = u; return { status: 0, data: [] }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(grab(GEOCODE, 'poiTencent', 'lib/geocode.js'), sandbox);
  sandbox.__a = args;
  await vm.runInContext('poiTencent(__a)', sandbox);
  return seen;
}

await itAsync('keyword + city → a region boundary, unchanged', async () => {
  const u = await tencentUrl({ kw: '天河路', city: '广州市' });
  assert.match(u, /boundary=region\(/);
  assert.doesNotMatch(u, /undefined/);
});

await itAsync('no keyword + a centre → a nearby boundary, unchanged', async () => {
  const u = await tencentUrl({ lat: 23.1291, lng: 113.2644, radius: 1500 });
  assert.match(u, /boundary=nearby\(23\.1291,113\.2644,1500\)/);
});

await itAsync('keyword + a centre but no city → still nearby, unchanged', async () => {
  const u = await tencentUrl({ kw: '天河路', lat: 23.1291, lng: 113.2644 });
  assert.match(u, /boundary=nearby\(23\.1291,113\.2644,1500\)/);
});

await itAsync('THE BUG: keyword, no city, no centre → no boundary, never undefined', async () => {
  const u = await tencentUrl({ kw: '天河路' });
  assert.doesNotMatch(u, /undefined/, 'nearby(undefined,undefined,1500) must not be sent');
  assert.doesNotMatch(u, /boundary=/, 'omit the parameter rather than send a malformed one');
  assert.match(u, /keyword=/, 'and the keyword still goes');
});

await itAsync('a partial centre counts as no centre', async () => {
  const u = await tencentUrl({ kw: '天河路', lat: 23.1291 });
  assert.doesNotMatch(u, /undefined/);
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

})();
