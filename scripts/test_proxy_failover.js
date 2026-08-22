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

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
