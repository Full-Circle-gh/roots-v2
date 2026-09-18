#!/usr/bin/env node
/**
 * Multi-vendor cloud printing — the registry, the Shangpeng adapter, and the
 * back-compat guarantee that makes §171 safe to deploy.
 *
 *   node scripts/test_printer_vendors.js
 *
 * WHAT IS ACTUALLY AT RISK HERE, and why each section exists.
 *
 * 1. BACK-COMPAT. Every `printer.by_store` row saved before §171 carries no
 *    `vendor` field, and every one of those printers is a Feie. If `resolve()`
 *    ever stops defaulting to Feie — or a typo'd vendor id is stored verbatim
 *    rather than resolved — a live counter stops printing paid orders and
 *    nothing says why. This is the section that would catch it.
 *
 * 2. THE GLOBAL GATE. `anyEnabled` replaced `feieEnabled` as the "printing is
 *    switched on" test. Regressing it to Feie-only would tell a Shangpeng-only
 *    tenant that printing is unconfigured while their printer sits there
 *    working — a silent, total outage for that tenant, and the exact failure
 *    §171 exists to prevent.
 *
 * 3. CREDENTIAL ISOLATION. A tenant's Feie creds must never be sent to
 *    Shangpeng's endpoint or the reverse. Each adapter reads its own key off
 *    the integrations bag and nothing else.
 *
 * 4. THE SIGNATURE. Shangpeng's is sorted-params MD5 with the secret appended,
 *    which is easy to get subtly wrong (sort order, the trailing `&appsecret=`,
 *    including `sign` in its own input) and fails as a flat auth rejection with
 *    nothing in the message pointing at the cause. Pinned against a worked
 *    example computed by hand here.
 *
 * 5. MARKUP TRANSLATION. Slips are rendered ONCE in house markup and each
 *    adapter translates on the way out. The property that matters is not which
 *    tags a vendor uses — that table is expected to need correcting from a test
 *    print (§171) — but that translation NEVER LOSES WORDS. Styling may
 *    degrade; content may not.
 *
 * 6. NO SECOND RENDERER. The whole objection §171 answers is templates
 *    existing twice. If a future change adds a renderer to an adapter, this
 *    suite fails.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const printers = require('../lib/printers');
const spyun = require('../lib/printers/spyun');
const feieAdapter = require('../lib/printers/feie');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

const FEIE_CREDS  = { user: 'roots@example.com', ukey: 'feie-userkey' };
const SPYUN_CREDS = { appid: 'sp-appid', appsecret: 'sp-appsecret' };

// ── 1 · back-compat ──────────────────────────────────────────────────────
section('1 · a row saved before §171 is a Feie, by construction');

it('an absent vendor resolves to Feie', () => {
  assert.strictEqual(printers.resolve(undefined).id, 'feie');
  assert.strictEqual(printers.resolve(null).id, 'feie');
  assert.strictEqual(printers.resolve('').id, 'feie');
});

it('DEFAULT_VENDOR is feie and is what resolve() falls back to', () => {
  assert.strictEqual(printers.DEFAULT_VENDOR, 'feie');
  assert.strictEqual(printers.resolve(printers.DEFAULT_VENDOR).id, 'feie');
});

it('an UNKNOWN vendor resolves to Feie rather than throwing or returning null', () => {
  // A typo in a saved row must not take a counter offline. Printing on the
  // wrong-but-configured brand fails loudly at the vendor; returning undefined
  // here would throw inside a fire-and-forget print and lose the slip silently.
  assert.strictEqual(printers.resolve('feieyun').id, 'feie');
  assert.strictEqual(printers.resolve('SHANGPENG').id, 'feie');
  assert.strictEqual(printers.resolve(42).id, 'feie');
});

it('isVendorId is exact — it does NOT launder a typo into a yes', () => {
  assert.ok(printers.isVendorId('feie'));
  assert.ok(printers.isVendorId('spyun'));
  assert.ok(!printers.isVendorId('feieyun'));
  assert.ok(!printers.isVendorId(''));
  assert.ok(!printers.isVendorId(undefined));
});

it('a known vendor id resolves to ITSELF, not to the default', () => {
  assert.strictEqual(printers.resolve('spyun').id, 'spyun');
});

// ── 2 · the global gate ──────────────────────────────────────────────────
section('2 · "printing is on" is ANY vendor, not Feie');

it('no creds at all → off', () => {
  assert.strictEqual(printers.anyEnabled({}), false);
  assert.strictEqual(printers.anyEnabled(undefined), false);
  assert.strictEqual(printers.anyEnabled({ feie: {}, spyun: {} }), false);
});

it('Feie alone → on', () => {
  assert.strictEqual(printers.anyEnabled({ feie: FEIE_CREDS }), true);
});

it('Shangpeng alone → on  (the regression §171 exists to prevent)', () => {
  // If this ever reads false, a Shangpeng-only tenant is told printing is
  // unconfigured while their printer works. Total silent outage for them.
  assert.strictEqual(printers.anyEnabled({ spyun: SPYUN_CREDS }), true);
});

it('a HALF-filled vendor is not enabled', () => {
  assert.strictEqual(printers.anyEnabled({ spyun: { appid: 'x' } }), false);
  assert.strictEqual(printers.anyEnabled({ spyun: { appsecret: 'x' } }), false);
  assert.strictEqual(printers.anyEnabled({ feie: { user: 'x' } }), false);
  assert.strictEqual(printers.anyEnabled({ feie: { ukey: 'x' } }), false);
});

// ── 3 · credential isolation ─────────────────────────────────────────────
section('3 · one tenant, two accounts, no crossing');

it('credsFor reads each vendor its OWN key off the integrations bag', () => {
  const bag = { feie: FEIE_CREDS, spyun: SPYUN_CREDS };
  assert.deepStrictEqual(printers.credsFor('feie', bag), FEIE_CREDS);
  assert.deepStrictEqual(printers.credsFor('spyun', bag), SPYUN_CREDS);
});

it('credsFor on an unknown vendor yields the DEFAULT vendor\'s creds, not a mix', () => {
  const bag = { feie: FEIE_CREDS, spyun: SPYUN_CREDS };
  assert.deepStrictEqual(printers.credsFor('nope', bag), FEIE_CREDS);
});

it('a missing vendor key yields {} rather than undefined', () => {
  assert.deepStrictEqual(printers.credsFor('spyun', { feie: FEIE_CREDS }), {});
});

it('printContent refuses a row whose OWN vendor is unconfigured', async () => {
  // The other vendor being configured must not make this print "go".
  const r = await printers.printContent('x', { sn: '1', vendor: 'spyun' }, { feie: FEIE_CREDS });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.msg, 'not_configured');
});

it('printContent refuses a row with no SN before it looks at creds', async () => {
  const r = await printers.printContent('x', { vendor: 'feie' }, { feie: FEIE_CREDS });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.msg, 'no_sn');
});

// ── 4 · the Shangpeng signature ──────────────────────────────────────────
section('4 · sorted-params MD5, computed independently');

it('sign() matches a hand-computed digest', () => {
  const params = { sn: '1552634520', content: 'hello', appid: 'APP', timestamp: '1700000000' };
  // Independently: sort keys, join k=v with &, append &appsecret=<secret>, md5.
  const expectBase = 'appid=APP&content=hello&sn=1552634520&timestamp=1700000000&appsecret=SECRET';
  const expect = crypto.createHash('md5').update(expectBase).digest('hex');
  assert.strictEqual(spyun.sign(params, 'SECRET'), expect);
});

it('key order in the input object does NOT change the signature', () => {
  const a = { sn: '1', content: 'x', appid: 'A', timestamp: '9' };
  const b = { timestamp: '9', appid: 'A', content: 'x', sn: '1' };
  assert.strictEqual(spyun.sign(a, 'S'), spyun.sign(b, 'S'));
});

it('the secret actually participates', () => {
  const p = { sn: '1', appid: 'A', timestamp: '9' };
  assert.notStrictEqual(spyun.sign(p, 'S1'), spyun.sign(p, 'S2'));
});

it('it is a 32-char lowercase hex md5', () => {
  assert.match(spyun.sign({ a: '1' }, 'S'), /^[0-9a-f]{32}$/);
});

// ── 5 · markup translation loses styling, never words ────────────────────
section('5 · house markup in, vendor markup out, same words');

// The one property worth pinning. The tag NAMES are an unverified table by
// §171's own admission and may be corrected from a test print; what may never
// change is that the customer-facing text survives the trip.
function words(s) { return String(s).replace(/<\/?[A-Z]+>/g, ''); }

const SLIP = [
  '<CB>A100</CB>',
  '<C>Roots 有机</C>',
  '<BOLD>Olive \'n\' Cream ×2</BOLD>',
  '<L>￥142.00</L>',
  '<B>PICKUP 自提</B>',
  'plain line 普通行',
].join('\n');

it('translation preserves every word and every line', () => {
  assert.strictEqual(words(spyun.translate(SLIP)), words(SLIP));
  assert.strictEqual(spyun.translate(SLIP).split('\n').length, SLIP.split('\n').length);
});

it('a tag mapped to \'\' drops the styling and KEEPS the text', () => {
  // This is the escape hatch §171 promises: if a test print shows literal
  // <CB> on the paper, an entry becomes '' and the line prints plain.
  const saved = spyun.TAG_MAP.CB;
  try {
    spyun.TAG_MAP.CB = '';
    const out = spyun.translate('<CB>A100</CB>');
    assert.strictEqual(out, 'A100', 'text must survive a dropped tag');
  } finally { spyun.TAG_MAP.CB = saved; }
});

it('a remapped tag is rewritten on BOTH the open and the close', () => {
  const saved = spyun.TAG_MAP.BOLD;
  try {
    spyun.TAG_MAP.BOLD = 'STRONG';
    assert.strictEqual(spyun.translate('<BOLD>x</BOLD>'), '<STRONG>x</STRONG>');
  } finally { spyun.TAG_MAP.BOLD = saved; }
});

it('every house tag the renderers emit has an entry in the map', () => {
  // Read the tags OUT OF the renderer rather than restating them, so a new tag
  // added to a slip fails here instead of printing raw at a counter.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'feie.js'), 'utf8');
  const emitted = new Set([...src.matchAll(/<(CB|BOLD|B|L|C)>/g)].map(m => m[1]));
  assert.ok(emitted.size >= 4, `expected the renderers to emit several tags, saw ${emitted.size}`);
  for (const t of emitted) {
    assert.ok(Object.prototype.hasOwnProperty.call(spyun.TAG_MAP, t),
      `house tag <${t}> is emitted by a renderer but has no entry in spyun's TAG_MAP`);
  }
});

// Comments in that file DISCUSS translation at length — it is the file whose
// whole point is that it does none — so the check has to read code, not prose.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

it('the Feie adapter is a pass-through — house markup IS its markup', () => {
  assert.strictEqual(feieAdapter.id, 'feie');
  const src = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'printers', 'feie.js'), 'utf8'));
  assert.ok(!/translate|TAG_MAP|\.replace\(/.test(src),
    'the Feie adapter must not translate anything — that is why house markup is its tag set');
  // And it must delegate rather than reimplement: its printContent IS feie's.
  assert.strictEqual(feieAdapter.printContent, require('../lib/feie').printContent);
});

// ── 6 · the contract, and the renderer that must stay single ─────────────
section('6 · one renderer, forever');

it('every registered vendor satisfies the whole contract', () => {
  for (const v of printers.VENDORS) {
    assert.ok(v.id, 'vendor has an id');
    assert.strictEqual(typeof v.enabled, 'function', `${v.id}.enabled`);
    assert.strictEqual(typeof v.printContent, 'function', `${v.id}.printContent`);
    assert.ok(Array.isArray(v.credFields) && v.credFields.length, `${v.id}.credFields`);
    assert.ok(v.label_en && v.label_cn, `${v.id} labels`);
    assert.ok(Number.isFinite(v.MAX_CONTENT_BYTES), `${v.id}.MAX_CONTENT_BYTES`);
    assert.ok(Number.isFinite(v.BIG_WIDTH), `${v.id}.BIG_WIDTH`);
  }
});

it('vendor ids are unique', () => {
  const ids = printers.VENDORS.map(v => v.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

it('NO adapter defines a renderer — the §171 objection, pinned', () => {
  // The case against a second vendor was that slip templates would exist
  // twice and drift. The answer was one renderer plus a translation table.
  // If anyone ever puts a renderOrder/renderKitchen* in an adapter, this is
  // where that decision gets re-opened deliberately instead of by accident.
  const dir = path.join(__dirname, '..', 'lib', 'printers');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/function\s+render[A-Z]/.test(src),
      `${f} defines a renderer — slips are rendered once, in lib/feie.js (§171)`);
  }
});

it('credFields declare an env var each, so boot hydration needs no edit', () => {
  for (const f of printers.allCredFields()) {
    assert.ok(f.env && /^[A-Z][A-Z0-9_]+$/.test(f.env), `${f.vendor}.${f.key} env name`);
    assert.strictEqual(typeof f.secret, 'boolean', `${f.vendor}.${f.key} secret flag`);
  }
});

it('every declared cred env var is wired into boot hydration', () => {
  // lib/printers declares the fields; database.js maps storefront_config keys
  // back into process.env at boot. A field declared but unmapped would work
  // until the first restart and then silently stop.
  const db = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
  for (const f of printers.allCredFields()) {
    assert.ok(db.includes(`'${f.env}'`),
      `${f.vendor}.${f.key} declares ${f.env} but database.js never hydrates it`);
  }
});

it('every declared cred field reaches getTenantCreds', () => {
  const tc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tenant-creds.js'), 'utf8');
  for (const f of printers.allCredFields()) {
    assert.ok(tc.includes(`process.env.${f.env}`),
      `${f.vendor}.${f.key} (${f.env}) never reaches the Roots env bundle`);
  }
});

// ── 7 · the vendor picker's options ──────────────────────────────────────
section('7 · the picker names vendors, and composes no Chinese');

it('vendorOptions carries both brands with both labels', () => {
  const o = printers.vendorOptions();
  assert.strictEqual(o.length, printers.VENDORS.length);
  const byId = Object.fromEntries(o.map(v => [v.id, v]));
  assert.strictEqual(byId.feie.label_cn, '飞鹅');
  assert.strictEqual(byId.spyun.label_cn, '商鹏');
  assert.strictEqual(byId.spyun.label_en, 'Shangpeng');
});

it('Feie is offered first — it is what every pre-§171 row is', () => {
  assert.strictEqual(printers.vendorOptions()[0].id, 'feie');
});

// ── 8 · end to end, at the wire ──────────────────────────────────────────
section('8 · the row\'s brand decides which cloud is called');

// Everything above tests the registry's bookkeeping. This section is the one
// that would catch the registry and an adapter being wired to each other
// wrongly — a class of bug that passes every unit check above and then prints
// nothing at a real counter. `fetch` is stubbed; nothing leaves the machine.
function captureFetch(fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String((init && init.body) || ''), method: (init && init.method) || 'GET' });
    // Both vendors' success shapes at once, so the stub cannot decide the result.
    return { json: async () => ({ ret: 0, errorcode: 0, msg: 'ok', errormsg: 'ok', data: {} }) };
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = real; });
}

const BAG = { feie: FEIE_CREDS, spyun: SPYUN_CREDS };
let e2e = [];

// Async assertions are collected and asserted synchronously below, so the
// summary line stays honest about what ran.
const ready = (async () => {
  await captureFetch(async (calls) => {
    await printers.printContent('<CB>A100</CB>', { sn: 'FEIE-1', vendor: 'feie' }, BAG);
    e2e.push(['a feie row reaches feieyun and nowhere else', () => {
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].url, /feieyun\.cn/);
      assert.ok(!/spyun/.test(calls[0].url));
      assert.match(calls[0].body, /sn=FEIE-1/);
      // Feie's own account, never Shangpeng's.
      assert.ok(calls[0].body.includes(encodeURIComponent(FEIE_CREDS.user)));
      assert.ok(!calls[0].body.includes(SPYUN_CREDS.appid));
    }]);
  });

  await captureFetch(async (calls) => {
    await printers.printContent('<CB>A100</CB>', { sn: 'SP-1', vendor: 'spyun' }, BAG);
    e2e.push(['a spyun row reaches open.spyun.net and nowhere else', () => {
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].url, /open\.spyun\.net\/v1\/printer\/print$/);
      assert.ok(!/feieyun/.test(calls[0].url));
      assert.strictEqual(calls[0].method, 'POST');
      const q = new URLSearchParams(calls[0].body);
      assert.strictEqual(q.get('sn'), 'SP-1');
      assert.strictEqual(q.get('appid'), SPYUN_CREDS.appid);
      // The secret signs the request; it is never itself transmitted.
      assert.ok(!calls[0].body.includes(SPYUN_CREDS.appsecret),
        'the appsecret must never appear in the request body');
      assert.ok(!calls[0].body.includes(FEIE_CREDS.ukey), 'feie creds leaked into a spyun call');
    }]);
    e2e.push(['the transmitted signature verifies', () => {
      const q = new URLSearchParams(calls[0].body);
      const got = q.get('sign');
      const params = {};
      for (const [k, v] of q.entries()) if (k !== 'sign') params[k] = v;
      assert.strictEqual(got, spyun.sign(params, SPYUN_CREDS.appsecret),
        'the signature does not verify against the parameters actually sent');
    }]);
  });

  await captureFetch(async (calls) => {
    // The back-compat case, at the wire: no `vendor` at all.
    await printers.printContent('x', { sn: 'OLD-ROW' }, BAG);
    e2e.push(['a pre-§171 row with NO vendor still reaches feieyun', () => {
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].url, /feieyun\.cn/);
    }]);
  });

  await captureFetch(async (calls) => {
    const r = await printers.printContent('x', { sn: 'SP-1', vendor: 'spyun' }, { feie: FEIE_CREDS });
    e2e.push(['an unconfigured brand makes NO network call at all', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.msg, 'not_configured');
      assert.strictEqual(calls.length, 0, 'a print went out on credentials that do not exist');
    }]);
  });

  await captureFetch(async (calls) => {
    await printers.printContent('x', { sn: 'SP-1', vendor: 'spyun', copies: 3 }, BAG);
    e2e.push(['copies ride through as the vendor\'s own parameter', () => {
      assert.strictEqual(new URLSearchParams(calls[0].body).get('times'), '3');
    }]);
  });
})();

ready.then(() => {
  for (const [name, fn] of e2e) it(name, fn);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
});
