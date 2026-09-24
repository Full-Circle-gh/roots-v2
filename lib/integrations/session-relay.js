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

// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_batch.js.
const { seam } = require('../db-seam');
const mainDb = seam(require('../../database'));

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

// ── No login driver, by decision (§257) ────────────────────────────────────
// This file once also started logins: a wizard took a merchant's password and
// SMS code and handed them to a "driver" that was meant to drive the portal.
// No driver was ever registered, so every attempt ended `no_worker_attached`,
// while the password it collected was stored for nothing. Both halves are gone.
// A channel login is now a human at a genuine browser on the box (§252, §256).
// What stays is the session record the Integrations cards read.

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
// Mark a live session dead (called by the daemon/worker when it detects the
// portal logged us out) → the card flips to "session expired — re-verify". Also
// alerts the tenant's own operators (WeCom app) so they can re-verify before
// orders start failing — the recurring pain, not just first-time setup. The
// alert is best-effort and only fires on the transition INTO expired (not on
// repeated polls that find it already expired), so a stuck session doesn't spam.
function markExpired(tenantId, kind, storeCode, error) {
  const prev = getSession(tenantId, kind, storeCode);
  const row = writeSession(tenantId, kind, storeCode, { status: 'expired', last_error: error || 'session_expired' });
  if (!prev || prev.status !== 'expired') {
    try {
      const label = kind === 'meituan' ? '美团 Meituan' : (kind === 'qingyun' ? '青云 Qingyun' : kind);
      require('../tenant-notify')
        .notifyTenantOperators(tenantId, `⚠️ **${label} 登录已过期 · session expired** (${storeCode})\n请在「销售 · Sales」页面重新验证,以免订单/库存同步中断。\nRe-verify on the Sales page to keep orders & stock syncing.`)
        .catch(() => {});
    } catch (_) { /* notify is advisory, never load-bearing */ }
  }
  return row;
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
  markExpired,
  getSession, summary,
};
