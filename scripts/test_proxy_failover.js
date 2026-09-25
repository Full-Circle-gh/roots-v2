#!/usr/bin/env node
/**
 * The Meituan proxy failover model (lib/proxy-manager.js).
 *
 *   node scripts/test_proxy_failover.js
 *
 * No network and no DB: a fake `curl` is put on PATH, so the real probe code
 * runs — argument building, socks5h rewriting, status parsing — against a status
 * code the test chooses. data/proxy-active.json is backed up and restored, so
 * this is safe to run on the box.
 *
 * Why this exists — the 天河 case. Both halves of a channel getting STUCK off the
 * residential exit are covered here:
 *
 *   1) The probe demanded a bare HTTP 200. The probe is unauthenticated, and an
 *      unauthenticated request to the merchant portal is answered with a 302 to
 *      the login page — so a healthy residential exit read as DOWN, tianhe failed
 *      over past GZ to 直连, and it could never fail back: the probe that would
 *      have cleared it could never return 200 either. 外卖 then ran from the HK
 *      datacenter IP, which is exactly what invites the 验证中心 challenge that
 *      the operator eventually sees as "the channel dropped off".
 *
 *   2) data/proxy-active.json was obeyed no matter how old it was. Nothing
 *      watches proxy-watchdog (health-watchdog only probes the storefront), so a
 *      dead watchdog's last choice stayed pinned in every launcher for as long as
 *      the box stayed up — silently, because 'direct' is always "healthy".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// ── Fake curl: answers with a per-path status code and records its args ──────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyprobe-'));
const LOG = path.join(TMP, 'calls.log');
fs.writeFileSync(path.join(TMP, 'curl'), `#!/bin/sh
echo "$*" >> "${LOG}"
case "$*" in
  *socks5h*) printf '%s' "\${FAKE_CODE_RES:-000}" ;;
  *-x*)      printf '%s' "\${FAKE_CODE_GZ:-000}" ;;
  *)         printf '%s' "\${FAKE_CODE_DIRECT:-000}" ;;
esac
`, { mode: 0o755 });
process.env.PATH = TMP + path.delimiter + process.env.PATH;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const clearCalls = () => { try { fs.unlinkSync(LOG); } catch (_) {} };

// Config the module reads at require time.
process.env.PROXY_PROBE_URL     = 'https://e.waimai.meituan.com/';
process.env.PROXY_STATE_TTL_MS  = '60000';
process.env.PROXY_RESIDENTIAL   = 'socks5://10.8.0.2:1080';
process.env.PROXY_GZ            = 'http://user:pw@8.163.120.72:8888';

const pm = require('../lib/proxy-manager');

// The state file is shared with a running box — put it back exactly as found.
const STATE = pm.STATE_FILE;
const hadState = fs.existsSync(STATE);
const savedState = hadState ? fs.readFileSync(STATE) : null;
const restore = () => {
  try {
    if (hadState) fs.writeFileSync(STATE, savedState);
    else if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};
process.on('exit', restore);

const setCodes = ({ res = '000', gz = '000', direct = '000' }) => {
  process.env.FAKE_CODE_RES = res;
  process.env.FAKE_CODE_GZ = gz;
  process.env.FAKE_CODE_DIRECT = direct;
};

(async () => {
console.log('\nproxy failover\n');

// ── 1. The probe's ruler ─────────────────────────────────────────────────────
await it('a 302 to the login page is a WORKING path, not a dead proxy', async () => {
  setCodes({ res: '302' });
  assert.strictEqual(await pm.probe('socks5://10.8.0.2:1080'), true,
    'the residential exit answering 302 was being condemned — this is the tianhe bug');
});

await it('403 (risk-control holding the IP) still proves the proxy relayed', async () => {
  setCodes({ res: '403' });
  assert.strictEqual(await pm.probe('socks5://10.8.0.2:1080'), true);
});

await it('200 is of course still healthy', async () => {
  setCodes({ res: '200' });
  assert.strictEqual(await pm.probe('socks5://10.8.0.2:1080'), true);
});

await it('000 — no reply, no tunnel — is the only DOWN', async () => {
  setCodes({ res: '000' });
  assert.strictEqual(await pm.probe('socks5://10.8.0.2:1080'), false);
});

await it('the same ruler the channel daemons use (200..599)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-manager.js'), 'utf8');
  assert.match(src, /code >= 200 && code < 600/,
    'proxy-manager must judge a path exactly as meituan/shangou/qingyun-daemon do');
});

await it('SOCKS5 is probed with remote DNS, and direct is probed with no -x', async () => {
  clearCalls();
  setCodes({ res: '200', direct: '200' });
  await pm.probe('socks5://10.8.0.2:1080');
  await pm.probe('');
  const [socks, direct] = calls();
  assert.match(socks, /-x socks5h:\/\/10\.8\.0\.2:1080/, 'socks5:// must be rewritten to socks5h://');
  assert.ok(!/ -x /.test(direct), 'direct mode must not pass a proxy to curl');
});

// ── 2. Election order ────────────────────────────────────────────────────────
await it('tianhe (外卖) tries residential → GZ → direct; yuexiu (闪购) has no GZ', async () => {
  assert.deepStrictEqual(pm.candidates('tianhe').map(c => c.label), ['residential', 'gz', 'direct']);
  assert.deepStrictEqual(pm.candidates('yuexiu').map(c => c.label), ['residential', 'direct']);
});

await it('a redirecting residential exit WINS tianhe (it used to lose to 直连)', async () => {
  setCodes({ res: '302', gz: '200', direct: '200' });
  const { active } = await pm.evaluate('tianhe');
  assert.strictEqual(active.label, 'residential');
  assert.strictEqual(active.url, 'socks5://10.8.0.2:1080');
});

await it('a genuinely dead residential exit still falls over to GZ, then to direct', async () => {
  setCodes({ res: '000', gz: '200', direct: '200' });
  assert.strictEqual((await pm.evaluate('tianhe')).active.label, 'gz');
  setCodes({ res: '000', gz: '000', direct: '200' });
  assert.strictEqual((await pm.evaluate('tianhe')).active.label, 'direct');
});

// ── 3. The written choice expires ────────────────────────────────────────────
const write = (entry, channel = 'tianhe') => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ [channel]: entry }, null, 2));
};

await it('writeState stamps every entry it is asked to assert', async () => {
  pm.writeState({ tianhe: { url: 'socks5://10.8.0.2:1080', label: 'residential', ts: pm.shStamp() } });
  const on = JSON.parse(fs.readFileSync(STATE, 'utf8')).tianhe;
  assert.ok(Number.isFinite(on.at), 'an entry with no date can never be judged stale');
  assert.ok(Math.abs(Date.now() - on.at) < 5000);
});

await it('a fresh choice is read back, direct ("") included', async () => {
  write({ url: 'socks5://10.8.0.2:1080', label: 'residential', at: Date.now() });
  assert.strictEqual(pm.readActive('tianhe'), 'socks5://10.8.0.2:1080');
  write({ url: '', label: 'direct', at: Date.now() });
  assert.strictEqual(pm.readActive('tianhe'), '', '"" is a real decision (direct), not a missing one');
});

await it('a choice older than the TTL is ignored — a dead watchdog stops being obeyed', async () => {
  write({ url: '', label: 'direct', at: Date.now() - 10 * 60_000 });
  assert.strictEqual(pm.readActive('tianhe'), undefined,
    'this is what pinned 外卖 to 直连 for as long as the box stayed up');
  assert.strictEqual(pm.isStale('tianhe'), true);
});

await it('a legacy ts-only entry is dated as Shanghai wall clock, not UTC', async () => {
  const sh = (ms) => new Date(Date.now() + 8 * 3600 * 1000 - ms).toISOString().slice(0, 19);
  write({ url: 'socks5://10.8.0.2:1080', label: 'residential', ts: sh(0) });
  assert.strictEqual(pm.readActive('tianhe'), 'socks5://10.8.0.2:1080',
    'read as UTC this stamp lands 8h in the future; it must read as fresh');
  write({ url: '', label: 'direct', ts: sh(10 * 60_000) });
  assert.strictEqual(pm.readActive('tianhe'), undefined, '10 min old, TTL is 1 min');
});

await it('an undateable entry is treated as stale, never as current', async () => {
  write({ url: '', label: 'direct' });
  assert.strictEqual(pm.readActive('tianhe'), undefined);
});

await it('writeChannel updates one channel and leaves the other alone', async () => {
  pm.writeState({
    tianhe: { url: 'socks5://10.8.0.2:1080', label: 'residential', ts: pm.shStamp() },
    yuexiu: { url: '', label: 'direct', ts: pm.shStamp() },
  });
  pm.writeChannel('tianhe', { url: '', label: 'direct', ts: pm.shStamp() });
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.strictEqual(s.tianhe.url, '');
  assert.strictEqual(s.yuexiu.label, 'direct', '闪购 must not be dropped by a 外卖 write');
});

// ── 4. Self-healing re-election ──────────────────────────────────────────────
await it('while the watchdog is writing, ensureFresh does nothing at all', async () => {
  write({ url: '', label: 'direct', at: Date.now() });
  clearCalls();
  assert.strictEqual(await pm.ensureFresh('tianhe'), null);
  assert.strictEqual(calls().length, 0, 'no probes while a current decision stands');
});

await it('with no watchdog, the channel re-elects itself back onto residential', async () => {
  write({ url: '', label: 'direct', at: Date.now() - 10 * 60_000 });
  setCodes({ res: '302', gz: '200', direct: '200' });
  const elected = await pm.ensureFresh('tianhe');
  assert.ok(elected, 'a stale choice must be re-elected, not obeyed');
  assert.strictEqual(elected.label, 'residential');
  assert.strictEqual(pm.readActive('tianhe'), 'socks5://10.8.0.2:1080');
  assert.strictEqual(pm.isStale('tianhe'), false, 'the re-election must be stamped, or it re-runs every tick');
});

await it('re-election is rate-limited, so a dead path is not a probe storm', async () => {
  write({ url: '', label: 'direct', at: Date.now() - 10 * 60_000 });
  clearCalls();
  assert.strictEqual(await pm.ensureFresh('tianhe'), null, 'already re-elected within the TTL');
  assert.strictEqual(calls().length, 0);
});

await it('the rate limit is per channel — 闪购 is not held back by 外卖', async () => {
  setCodes({ res: '302', direct: '200' });
  const elected = await pm.ensureFresh('yuexiu');
  assert.ok(elected && elected.label === 'residential', 'yuexiu must elect on its own clock');
  assert.ok(JSON.parse(fs.readFileSync(STATE, 'utf8')).tianhe, 'and must not wipe the other channel');
});

// ── 5. A closed location pages nobody (§217) ─────────────────────────────────
// A stand-in for the two store_business_status reads isStoreTradingOnChannel
// makes, so the real predicate runs with no database behind it.
const fakeDb = (row) => ({ prepare: () => ({ get: () => row }) });

await it('越秀 closed on 闪购 — its route is not trading, so the watchdog stays quiet', async () => {
  assert.strictEqual(pm.routeTrading(fakeDb({ fulfillment_open: 1, target_open: null, is_open: 0 }), 'yuexiu'), false);
});

await it('越秀 closed shop-wide (fulfillment_open = 0) is also quiet', async () => {
  assert.strictEqual(pm.routeTrading(fakeDb({ fulfillment_open: 0, target_open: null, is_open: 1 }), 'yuexiu'), false);
});

await it('越秀 trading — its route pages as before', async () => {
  assert.strictEqual(pm.routeTrading(fakeDb({ fulfillment_open: 1, target_open: null, is_open: 1 }), 'yuexiu'), true);
});

await it('tianhe always pages — 外卖 serves more than one store on that route', async () => {
  assert.strictEqual(pm.routeTrading(fakeDb({ fulfillment_open: 0, target_open: 0, is_open: 0 }), 'tianhe'), true);
});

await it('no DB, or a DB that throws, keeps paging — never silence a live route', async () => {
  assert.strictEqual(pm.routeTrading(null, 'yuexiu'), true);
  const broken = { prepare: () => { throw new Error('SQLITE_BUSY'); } };
  assert.strictEqual(pm.routeTrading(broken, 'yuexiu'), true);
});

await it('the watchdog asks routeTrading and drops only the page, not the failover', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'proxy-watchdog.js'), 'utf8');
  assert.match(src, /pm\.routeTrading\(getDb\(\), channel\)/, 'the watchdog must ask the shared predicate');
  assert.match(src, /if \(!quiet\) await pm\.sendProxyAlert\(text\)/, 'a closed location must not page');
  assert.doesNotMatch(src, /if \(quiet\)[^\n]*continue/, 'closed must not skip the probe and state write');
});

// ── 6. Hysteresis both ways, and relaunch spacing (§262) ─────────────────────
// Feed a run of probe results through nextPathHealth; return the down/up flags.
const run = (seq, opts) => {
  let s; const out = [];
  for (const ch of seq) { s = pm.nextPathHealth(s, ch === 'o', opts); out.push(s.down); }
  return out;
};
// Count down↔up transitions in a flag series — each one is a page and a relaunch.
const flips = (flags) => flags.reduce((n, d, i) => n + (i && d !== flags[i - 1] ? 1 : 0), 0);

await it('defaults: 2 fails to go down, 4 good probes to come back', async () => {
  assert.strictEqual(pm.FAIL_THRESHOLD, 2);
  assert.strictEqual(pm.UP_THRESHOLD, 4);
});

await it('a path never probed counts as up (cold start trusts it)', async () => {
  assert.strictEqual(pm.nextPathHealth(undefined, true).down, false);
  assert.strictEqual(pm.nextPathHealth(undefined, false).down, false, 'one failure is not down yet');
});

await it('two failures in a row take a path down', async () => {
  assert.deepStrictEqual(run('xx'), [false, true]);
});

await it('once down, it takes FOUR good probes in a row to come back — not one', async () => {
  assert.deepStrictEqual(run('xxoooo'), [false, true, true, true, true, false],
    'it used to come back on the first good probe, which is what made it ring');
});

await it('a failure during recovery starts the count again', async () => {
  const flags = run('xxoooxoooo');
  assert.strictEqual(flags[5], true, 'still down after the blip');
  assert.strictEqual(flags[8], true, '3 good since the blip is not enough');
  assert.strictEqual(flags[9], false, '4 good since the blip is');
});

await it('a single blip on a healthy path changes nothing', async () => {
  assert.deepStrictEqual(run('oxo'), [false, false, false]);
});

// The 2026-08-23 shape: a marginal tunnel, a good probe between short drops.
const MARGINAL = 'xxoxxoxxoxxoxxooooo';
await it('the old rule (up on the first success) rings on a marginal link', async () => {
  assert.ok(flips(run(MARGINAL, { upThreshold: 1 })) >= 8,
    'control: with upThreshold 1 this replay must reproduce the old ringing');
});

await it('the new rule rides the same link out with ONE switch away and ONE back', async () => {
  const flags = run(MARGINAL);
  assert.strictEqual(flips(flags), 2, `expected down once and up once, got ${flips(flags)} flips`);
  assert.strictEqual(flags[flags.length - 1], false, 'and it does come back once the link holds');
});

await it('relaunch spacing: no previous launch → a switch applies at once', async () => {
  assert.strictEqual(pm.switchAllowed(0), true);
  assert.strictEqual(pm.switchAllowed(undefined), true);
});

await it('relaunch spacing: a switch inside the gap is held, after it applies', async () => {
  const now = 1_000_000_000;
  assert.strictEqual(pm.SWITCH_MIN_GAP_MS, 60_000);
  assert.strictEqual(pm.switchAllowed(now - 30_000, now), false);
  assert.strictEqual(pm.switchAllowed(now - 60_000, now), true);
});

await it('the watchdog decides on nextPathHealth, not the old one-sided counter', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'proxy-watchdog.js'), 'utf8');
  assert.match(src, /pm\.nextPathHealth\(pathHealth\[key\], ok\)/);
  assert.doesNotMatch(src, /failCount\[key\] < FAIL_THRESHOLD/, 'the one-sided rule must be gone');
});

// 外卖's holder, run for real: getBrowser with only the Chromium launch stubbed.
// The instance takes the path the watchdog wrote, as the real init() does.
{
  const mb = require('../lib/meituan-browser');
  const P = mb.MeituanBrowser.prototype;
  let launches = 0;
  P.init    = async function () { launches++; this._proxyRaw = pm.readActive(this.storeCode) ?? ''; };
  P.isAlive = function () { return true; };
  P.close   = async function () {};
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const choose = (url, label) => pm.writeState({ tianhe: { url, label, ts: pm.shStamp() } });
  const RES = 'socks5://10.8.0.2:1080', GZ = 'http://user:pw@8.163.120.72:8888';
  try {
    await it('外卖: a switch within a minute of launch keeps the browser it has', async () => {
      choose(RES, 'residential');
      const b1 = await mb.getBrowser('tianhe');
      choose(GZ, 'gz');
      skew += 20_000;
      const b2 = await mb.getBrowser('tianhe');
      assert.strictEqual(b2, b1, 'the switch used to bypass every cooldown and relaunch at once');
      assert.strictEqual(launches, 1);
    });

    await it('外卖: once the minute is up, the held switch is applied', async () => {
      skew += 45_000;
      choose(GZ, 'gz');   // the watchdog re-writes its choice every tick; this file's TTL is 60s
      const b3 = await mb.getBrowser('tianhe');
      assert.strictEqual(launches, 2);
      assert.strictEqual(b3._proxyRaw, GZ);
    });

    await it('外卖: a choice that flips back inside the gap never relaunches', async () => {
      choose(RES, 'residential');
      skew += 10_000;
      await mb.getBrowser('tianhe');
      choose(GZ, 'gz');
      skew += 10_000;
      const b = await mb.getBrowser('tianhe');
      assert.strictEqual(launches, 2, 'there and back inside the gap is zero relaunches');
      assert.strictEqual(b._proxyRaw, GZ);
    });
  } finally {
    Date.now = realNow;
    await mb.closeAll();
  }
}

await it('闪购 holder spaces proxy-switch relaunches too', async () => {
  const sg = fs.readFileSync(path.join(__dirname, 'shangou-chrome.js'), 'utf8');
  assert.match(sg, /pm\.switchAllowed\(lastLaunchAt\)/, '闪购: the poll must hold a switch inside the gap');
  assert.match(sg, /lastLaunchAt = Date\.now\(\)/, '闪购: every launch must be stamped');
});

// ── 7. What pages the group (§263) ───────────────────────────────────────────
// The rule on its own first, then the real watchdog loop.
const step = (prev, facts, now) => pm.nextPage(prev, { ...facts, now, degradedPageMs: 30 * 60_000 });
const OFF = { onFirst: false, onDirect: false }, ON = { onFirst: true, onDirect: false };
const HK = { onFirst: false, onDirect: true };

await it('a short spell on the backup pages nobody, going or coming back', async () => {
  let r = step(undefined, OFF, 0);
  assert.strictEqual(r.page, null);
  r = step(r.state, OFF, 29 * 60_000);
  assert.strictEqual(r.page, null, 'under half an hour is the backup doing its job');
  r = step(r.state, ON, 29.5 * 60_000);
  assert.strictEqual(r.page, null, 'no "back" message for a page never sent');
});

await it('half an hour off the first choice pages once — and only once', async () => {
  let r = step(undefined, OFF, 0);
  r = step(r.state, OFF, 30 * 60_000);
  assert.strictEqual(r.page, 'degraded');
  r = step(r.state, OFF, 90 * 60_000);
  assert.strictEqual(r.page, null, 'still degraded is not news');
  r = step(r.state, ON, 91 * 60_000);
  assert.strictEqual(r.page, 'recovered', 'the person who went to check is told to stop');
  r = step(r.state, ON, 92 * 60_000);
  assert.strictEqual(r.page, null);
});

await it('landing on the Hong Kong line pages at once, and escalates a degraded page', async () => {
  let r = step(undefined, HK, 0);
  assert.strictEqual(r.page, 'direct');
  r = step(r.state, HK, 60_000);
  assert.strictEqual(r.page, null, 'still on Hong Kong is not news');
  let d = step(undefined, OFF, 0);
  d = step(d.state, OFF, 30 * 60_000);
  assert.strictEqual(d.page, 'degraded');
  d = step(d.state, HK, 31 * 60_000);
  assert.strictEqual(d.page, 'direct', 'getting worse is news');
});

await it('the "back" page is the live pair, word for word', async () => {
  const text = pm.pageText('recovered', 'tianhe', { cands: pm.candidates('tianhe'), active: pm.candidates('tianhe')[0] });
  assert.strictEqual(text, '🟢 天河 外卖：门店住宅代理 恢复可用\n天河 外卖: the shop\'s own internet can reach Meituan again. Nothing to do.');
});

await it('the pages that ask for someone say what to check, in both languages', async () => {
  const cands = pm.candidates('tianhe');
  const deg = pm.pageText('degraded', 'tianhe', { cands, active: cands[1] });
  assert.match(deg, /门店住宅代理已超过30分钟不可达，当前走 GZ 机房代理。请检查门店网络。/);
  assert.match(deg, /the shop's own internet has not reached Meituan for over 30 min\. Selling carries on through the Guangzhou relay\. Please check the shop's internet\./);
  const hk = pm.pageText('direct', 'tianhe', { cands, active: cands[2], down: ['residential', 'gz'] });
  assert.match(hk, /切换到 直连\(香港\)，门店住宅代理、GZ 机房代理 均不可达/);
  assert.match(hk, /the shop's own internet and the Guangzhou relay cannot reach Meituan/);
  assert.doesNotMatch(deg + hk, /nothing to do/i, 'a page that asks for a person must not also say there is nothing to do');
});

// The real loop: the watchdog's own tick(), with the fake curl above, a clock the
// test moves, and the page SENDER replaced by a recorder. The box's .env carries
// the real webhook, so nothing here may reach it.
{
  const sent = [];
  pm.sendProxyAlert = async (text) => { sent.push(text); return true; };
  const dbPath = require.resolve('../database');
  const trading = fakeDb({ fulfillment_open: 1, target_open: null, is_open: 1 });
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: trading };
  process.env.PROXY_WATCHDOG_NO_LOOP = '1';
  const wd = require('./proxy-watchdog');

  const realNow = Date.now, realLog = console.log;
  let skew = 0;
  Date.now = () => realNow() + skew;
  // One tick per 30s of fake time; `res` is 'o' (answers) or 'x' (no reply) per tick.
  const run = async (resSeq, { gz = '200' } = {}) => {
    for (const ch of resSeq) {
      setCodes({ res: ch === 'o' ? '302' : '000', gz, direct: '200' });
      skew += 30_000;
      console.log = () => {};   // the loop's own pm2 lines; the pages are what is checked
      try { await wd.tick(); } finally { console.log = realLog; }
    }
  };
  const pagesFor = (cn) => sent.filter(t => t.includes(cn));
  try {
    await run('o');
    sent.length = 0;

    await it('watchdog: a marginal night pages 天河 nothing at all', async () => {
      await run('xxoxxoxxoxxoxxoxxo');   // 9 min of the 08-23 shape
      await run('oooo');                // then it holds
      assert.deepStrictEqual(pagesFor('天河'), [],
        'it used to page every flap: down, switched, up, switched back');
    });

    await it('watchdog: 越秀 has no Guangzhou relay, so that night pages it twice — Hong Kong, then back', async () => {
      const y = pagesFor('越秀');
      assert.strictEqual(y.length, 2, y.join('\n---\n'));
      assert.match(y[0], /^🔴 越秀 闪购：切换到 直连\(香港\)/);
      assert.match(y[1], /^🟢 越秀 闪购：门店住宅代理 恢复可用/);
    });

    await it('watchdog: the shop link down for half an hour pages 天河 once, then once when it is back', async () => {
      sent.length = 0;
      await run('x'.repeat(62));        // 31 min
      await run('oooo');
      const t = pagesFor('天河');
      assert.strictEqual(t.length, 2, t.join('\n---\n'));
      assert.match(t[0], /^🟠 天河 外卖：门店住宅代理已超过30分钟不可达，当前走 GZ 机房代理。/);
      assert.match(t[1], /^🟢 天河 外卖：门店住宅代理 恢复可用/);
    });

    await it('watchdog: every relay down puts 天河 on Hong Kong, and that pages at once', async () => {
      sent.length = 0;
      await run('xx', { gz: '000' });
      const t = pagesFor('天河');
      assert.strictEqual(t.length, 1, t.join('\n---\n'));
      assert.match(t[0], /^🔴 天河 外卖：切换到 直连\(香港\)，门店住宅代理、GZ 机房代理 均不可达/);
      await run('oooo');
    });
  } finally {
    Date.now = realNow;
  }
}

await it('the old "nothing to do" pages are gone from the watchdog', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'proxy-watchdog.js'), 'utf8');
  assert.doesNotMatch(src, /Another route is being used instead/);
  assert.doesNotMatch(src, /switched itself to/);
  assert.doesNotMatch(src, /started up on a backup route/);
  assert.strictEqual((src.match(/await announce\(/g) || []).length, 1, 'one place pages, and it asks nextPage');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
