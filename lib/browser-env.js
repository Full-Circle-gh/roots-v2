'use strict';

// Environment for every Chrome/Chromium we launch on the box.
//
// Chrome's browser process treats a DROPPED D-Bus connection as unrecoverable:
//
//   [FATAL:dbus/bus.cc:1245] D-Bus connection was disconnected. Aborting.
//
// It aborts the whole browser — not a tab, not the renderer — via IMMEDIATE_CRASH(),
// which lands as SIGTRAP/SI_KERNEL in the crash dump. Playwright then reports the
// far less helpful "Target page, context or browser has been closed", which is what
// the channel daemons have been logging.
//
// On this box the daemons inherit DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
// from whichever SSH login session last (re)started them, and root has Linger=no —
// so systemd tears that user bus down and recreates it as sessions come and go. Every
// Chrome connected to the old socket aborts at that moment, mid-whatever-it-was-doing.
// `pm2 restart --update-env`, which every deploy runs, re-imports the deploying
// session's address, so deploy-heavy days crash hardest: 41 aborts on 2026-07-26,
// 268 dumps in the pending folder, all the same fatal.
//
// For 外卖 that meant a stock push died partway through its batch, and (before the
// queue learned to retry) the remaining rows were written off as terminal errors —
// which is how 天河 ended up advertising stock it hadn't had since June.
//
// The fix is to never hold a connection that can be pulled: point Chrome at a bus
// address it cannot connect to, and it runs without a session bus instead of dying
// with one. Nothing here needs D-Bus — the password store is already forced to
// 'basic' and the proxy is passed explicitly rather than resolved through GSettings.
// (Belt and braces on the box itself: `loginctl enable-linger root` stops the user
// bus being torn down at all, which also covers the long-lived browser holders that
// are spawned once and never relaunched.)
function browserEnv(extra) {
  return { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null', ...(extra || {}) };
}

module.exports = { browserEnv };
