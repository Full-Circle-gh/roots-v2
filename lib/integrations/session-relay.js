'use strict';

// Login relay + session manager for scraper-based integrations (Phase 6).
//
// Meituan and Qingyun are "logged-in browser session" integrations: there is no
// official API, so a real login runs Playwright on a scraper WORKER host,
// egressing through that tenant's store box (see CHANNELS-LOGISTICS-PLUGINS-PLAN
// §3/§3b). The merchant can't paste a browser session into a form — instead the
// worker drives the portal login and, when the portal SMS-challenges, the tenant
// types the code into our wizard; we relay it to the worker holding the live
// browser context.
//
// This module owns the STATE MACHINE + control-plane persistence of that relay,
// and is deliberately transport-agnostic: the actual browser work is done by a
// DRIVER (below). In production the worker registers a real Playwright driver;
// in dev/test a simulation driver lets the whole wizard flow run end-to-end
// without a portal. Nothing here ever touches a real Meituan/Qingyun site — that
// lives behind the driver seam, on the worker.
//
// State machine (per tenant × kind × store):
//   idle → connecting → awaiting_sms → connecting → ok
//                    ↘ captcha ↗                  ↘ failed
//   ok can later become `expired` (session died) → re-run from connecting.

const mainDb = require('../../database');

// ── Schema (idempotent, control-plane only — never per-tenant) ─────────────
mainDb.exec(`
  CREATE TABLE IF NOT EXISTS integration_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    kind        TEXT NOT NULL,              -- 'meituan' | 'qingyun'
    store_code  TEXT NOT NULL,              -- one session per (tenant, kind, store)
    status      TEXT NOT NULL DEFAULT 'idle',
      -- idle | connecting | awaiting_sms | captcha | ok | failed | expired
    phone_hint  TEXT,                        -- masked phone the SMS went to (from the driver)
    last_error  TEXT,
    attempt_at  DATETIME,                    -- when the current attempt began
    connected_at DATETIME,                   -- when it last reached ok
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, kind, store_code),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
`);

const RELAY_KINDS = new Set(['meituan', 'qingyun']);
const now = () => new Date().toISOString();

// ── Driver seam ────────────────────────────────────────────────────────────
// A driver is how the relay actually talks to a browser. Contract:
//   begin({ tenant, kind, storeCode, username, password })
//     → { outcome: 'ok' } | { outcome: 'sms', phoneHint } | { outcome: 'captcha' }
//        | { outcome: 'failed', error }
//   submitSms({ tenant, kind, storeCode, code })
//     → { outcome: 'ok' } | { outcome: 'failed', error } | { outcome: 'sms' } (resend)
// The real worker registers its Playwright driver via registerDriver(); until
// then a kind resolves to the SIM driver so the wizard is demoable in dev.
const drivers = new Map();
function registerDriver(kind, driver) { drivers.set(kind, driver); }

// Simulation driver — models a portal that always SMS-challenges, accepts the
// code 000000, and rejects anything else. Lets the full relay + wizard be
// exercised without a real portal/worker. NEVER makes a network call.
const SIM_DRIVER = {
  begin() { return { outcome: 'sms', phoneHint: '138 **** 0000' }; },
  submitSms({ code }) {
    if (String(code || '').trim() === '000000') return { outcome: 'ok' };
    // Wrong code is recoverable — stay awaiting so the merchant can retry.
    return { outcome: 'sms', error: 'sms_code_incorrect' };
  },
};
// A driver that refuses — the honest default when no worker is attached AND the
// sim is disabled. Production with no worker should NOT silently "connect".
const NO_WORKER_DRIVER = {
  begin() { return { outcome: 'failed', error: 'no_worker_attached' }; },
  submitSms() { return { outcome: 'failed', error: 'no_worker_attached' }; },
};
function driverFor(kind) {
  if (drivers.has(kind)) return drivers.get(kind);
  // Dev/CI convenience: opt into the simulation driver explicitly.
  if (process.env.INTEGRATION_RELAY_SIM === '1') return SIM_DRIVER;
  return NO_WORKER_DRIVER;
}

// ── Persistence helpers ────────────────────────────────────────────────────
function getSession(tenantId, kind, storeCode) {
  return mainDb.prepare(
    'SELECT * FROM integration_sessions WHERE tenant_id = ? AND kind = ? AND store_code = ?'
  ).get(Number(tenantId), kind, storeCode) || null;
}

function writeSession(tenantId, kind, storeCode, fields) {
  const cols = { status: 'idle', phone_hint: null, last_error: null, attempt_at: null, connected_at: null, ...fields };
  mainDb.prepare(`
    INSERT INTO integration_sessions (tenant_id, kind, store_code, status, phone_hint, last_error, attempt_at, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id, kind, store_code) DO UPDATE SET
      status = excluded.status,
      phone_hint = COALESCE(excluded.phone_hint, integration_sessions.phone_hint),
      last_error = excluded.last_error,
      attempt_at = COALESCE(excluded.attempt_at, integration_sessions.attempt_at),
      connected_at = COALESCE(excluded.connected_at, integration_sessions.connected_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(Number(tenantId), kind, storeCode, cols.status, cols.phone_hint, cols.last_error, cols.attempt_at, cols.connected_at);
  return getSession(tenantId, kind, storeCode);
}

// ── State transitions ──────────────────────────────────────────────────────
// Kick off a login attempt for one store. Credentials are used by the driver
// only — they are NOT persisted here (the wizard has already stored them via
// tenant-creds; the worker reads them there). Returns the resulting session.
function startLogin(tenantId, kind, storeCode, { username, password } = {}) {
  if (!RELAY_KINDS.has(kind)) throw new Error('not a relay integration: ' + kind);
  if (!storeCode) throw new Error('store_code required');
  writeSession(tenantId, kind, storeCode, { status: 'connecting', last_error: null, attempt_at: now() });
  let r;
  try { r = driverFor(kind).begin({ tenant: Number(tenantId), kind, storeCode, username, password }); }
  catch (e) { r = { outcome: 'failed', error: e.message }; }
  return applyOutcome(tenantId, kind, storeCode, r);
}

// Relay an SMS code the tenant typed into the wizard to the worker holding the
// live browser context.
function submitSms(tenantId, kind, storeCode, code) {
  const s = getSession(tenantId, kind, storeCode);
  if (!s || (s.status !== 'awaiting_sms' && s.status !== 'connecting')) {
    throw new Error('no login awaiting a code for this store');
  }
  writeSession(tenantId, kind, storeCode, { status: 'connecting' });
  let r;
  try { r = driverFor(kind).submitSms({ tenant: Number(tenantId), kind, storeCode, code }); }
  catch (e) { r = { outcome: 'failed', error: e.message }; }
  return applyOutcome(tenantId, kind, storeCode, r);
}

// Mark a live session dead (called by the daemon/worker when it detects the
// portal logged us out) → the card flips to "session expired — re-verify".
function markExpired(tenantId, kind, storeCode, error) {
  return writeSession(tenantId, kind, storeCode, { status: 'expired', last_error: error || 'session_expired' });
}

function applyOutcome(tenantId, kind, storeCode, r) {
  const o = (r && r.outcome) || 'failed';
  // 'sms' can carry an error (wrong code, resend) while staying recoverable —
  // the merchant retries the code without restarting the whole login.
  if (o === 'sms')      return writeSession(tenantId, kind, storeCode, { status: 'awaiting_sms', phone_hint: r.phoneHint || null, last_error: r.error || null });
  if (o === 'captcha')  return writeSession(tenantId, kind, storeCode, { status: 'captcha', last_error: null });
  if (o === 'ok')       return writeSession(tenantId, kind, storeCode, { status: 'ok', last_error: null, connected_at: now() });
  return writeSession(tenantId, kind, storeCode, { status: 'failed', last_error: (r && r.error) || 'login_failed' });
}

// A tenant-facing snapshot of all of a kind's per-store sessions, for the wizard
// + the integration card health line. Never throws.
function summary(tenantId, kind) {
  let rows = [];
  try {
    rows = mainDb.prepare('SELECT * FROM integration_sessions WHERE tenant_id = ? AND kind = ? ORDER BY store_code').all(Number(tenantId), kind);
  } catch (_) {}
  return rows.map(r => ({
    storeCode: r.store_code, status: r.status, phoneHint: r.phone_hint,
    lastError: r.last_error, connectedAt: r.connected_at, updatedAt: r.updated_at,
  }));
}

module.exports = {
  RELAY_KINDS,
  registerDriver, SIM_DRIVER,   // SIM_DRIVER exported for tests
  startLogin, submitSms, markExpired,
  getSession, summary,
};
