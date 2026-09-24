'use strict';

// Sign a channel back in from Tacet (§250, §252).
//
// The login itself is the channel's own headed login script, run on the box by
// ops/ops-screen/login-trigger.js on a PRIVATE display (:98) that shows nothing
// but that one login window. This module decides who may start one, asks the
// trigger to start it, and decides who may watch the screen while it runs.
//
// Everything here serves the Roots account only: the channel daemons read and
// write the Roots database and no other (scripts/*-daemon.js, ROOTS_TENANT_ID).
// Another business pressing Sign in would be signing Roots' channels in.

const http = require('http');
const { ROOTS_TENANT_ID } = require('./tenant-db');

const CAP = 'integrations:signin';
const CHANNELS = ['meituan', 'eleme', 'guanyi'];
const TRIGGER = { host: '127.0.0.1', port: Number(process.env.OPS_SCREEN_CTL_PORT || 6090) };
// The private sign-in display's x11vnc. Loopback only, no VNC password: the
// only thing that can reach it is this process, and this process checks first.
const SCREEN = { host: '127.0.0.1', port: Number(process.env.SIGNIN_VNC_PORT || 5901) };
// A little longer than the trigger's own 7-minute lock, so the screen never
// closes on someone the trigger still thinks is signing in.
const GRANT_MS = 8 * 60 * 1000;

const CODE = /^[a-z0-9_-]{1,32}$/;

// Who may sign in, and to which store. Returns null when allowed, otherwise a
// stable reason code the route turns into a status.
function refusal(caller, tenantId, store) {
  if (!caller) return 'not_signed_in';
  if (Number(tenantId) !== Number(ROOTS_TENANT_ID)) return 'wrong_account';
  if (!caller.caps.has(CAP)) return 'no_permission';
  if (caller.scopeStores && (!store || caller.scopeStores.indexOf(store.id) === -1)) return 'out_of_scope';
  return null;
}

// The store a sign-in is for, from the Roots database, or null. Eleme also
// needs its shop id, which its login script takes as an argument.
function resolveStore(db, channel, code) {
  if (!CHANNELS.includes(channel) || !CODE.test(String(code || ''))) return null;
  // A Meituan store served by 闪购 is signed in through its holder Chrome, not
  // the 外卖 login this screen runs (lib/channel-sync-items.js withSignable).
  const shangou = String(process.env.SHANGOU_STORES || 'yuexiu').split(',').map((x) => x.trim());
  if (channel === 'meituan' && shangou.includes(code)) return null;
  const s = db.prepare('SELECT id, code FROM retail_stores WHERE code = ? AND is_active = 1').get(code);
  if (!s) return null;
  if (channel === 'eleme') {
    let shop = null;
    try { shop = db.prepare('SELECT shop_id FROM eleme_shops WHERE retail_store_id = ?').get(s.id); } catch (_) { /* a box with no Eleme table has no Eleme shop, which is the null below */ }
    const shopId = shop && String(shop.shop_id || '').trim();
    if (!shopId || !/^\d{1,20}$/.test(shopId)) return null;
    return { ...s, shopId };
  }
  return s;
}

// ── The trigger ─────────────────────────────────────────────────────────────
function trigger(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      ...TRIGGER, method, path, timeout: 5000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* a non-JSON reply is not the trigger we know; json stays null and the caller treats it as unavailable */ }
        resolve({ status: res.statusCode, json });
      });
    });
    // The trigger not running is a state the page must be able to say, not a crash.
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, json: null }));
    if (data) req.write(data);
    req.end();
  });
}

// ── Grants: who may watch the screen right now ──────────────────────────────
// One at a time, because there is one private display. Held in memory: a
// restart of the app drops it, and the page simply has to press Sign in again.
let grant = null; // { userId, channel, store, at }

function grantFor(userId, channel, store, now = Date.now()) {
  grant = { userId: Number(userId), channel, store, at: now };
  return grant;
}
function liveGrant(now = Date.now()) {
  if (grant && now - grant.at > GRANT_MS) grant = null;
  return grant;
}
function mayWatch(userId, now = Date.now()) {
  const g = liveGrant(now);
  return !!(g && g.userId === Number(userId));
}
function endGrant() { grant = null; }

// What a Sign in press does, from what the trigger says is running: 'start' a
// new login, 'join' the one already open for this same channel and store, or
// 'busy' when the one screen is showing a different channel's login.
function startDecision(running, channel, store) {
  if (!running) return 'start';
  return running.channel === channel && running.store === store ? 'join' : 'busy';
}

module.exports = {
  CAP, CHANNELS, TRIGGER, SCREEN, GRANT_MS,
  refusal, resolveStore, trigger,
  grantFor, liveGrant, mayWatch, endGrant, startDecision,
};
