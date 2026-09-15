/* ===========================================================================
   THE BACK OFFICE AS AN INSTALLED APP.

   Reported from a shop tablet: the installed "Tacet" app showed the phone
   companion — a portrait column with blue bars down both sides of a landscape
   screen — and nothing made it show the desktop back office.

   Nothing could. That app is m-manifest.webmanifest, start_url '/m', and '/m'
   IS Tacet Mobile: no device detection is involved, so no server change could
   re-point it. Meanwhile retail-admin.html linked no manifest at all, so the
   back office was not installable by anything. The manifest
   (public/admin-manifest.webmanifest) is the missing half; this file is the
   ask, and the service-worker registration without which Chrome and Edge will
   not offer an install however good the manifest is.

   ONE SURFACE, AND IT IS IN A MENU. The counter till got a strip across the
   top because a till is one screen a cashier meets fresh each morning. This is
   not that: it is a back office somebody has open all day, and a banner over
   it would be a nag on every screen in the product. The row sits in the
   account menu, where the other device-level choices already are — Appearance,
   and Profile → Notifications' "Push to this device" — and it is HIDDEN until
   the browser says the app can actually be installed.

   Safari gets nothing, and needs nothing: it fires no event and offers no API,
   and the apple-* meta tags in the head are the whole iOS path. A row that
   cannot do anything is worse than no row.
   =========================================================================== */
(function () {
  'use strict';

  /* Chrome's event, kept. It cannot be conjured later and prompt() may be
     called once per event; Chrome issues a fresh one on the next load while
     the app is still not installed, which is what puts the row back. */
  var installEvent = null;

  function $id(id) { return document.getElementById(id); }

  /* Already running as the app? Then there is nothing to offer. matchMedia is
     the browser's own answer for Chrome and Edge; navigator.standalone is the
     only one iOS gives. */
  function isInstalled() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
          || window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  function renderInstallRow() {
    var row = $id('acctInstall');
    if (!row) return;
    row.hidden = !installEvent || isInstalled();
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    /* Chrome's own mini-infobar is not ours to place: it lands across the
       bottom of the window, which in this product is where the orders table's
       own footer and the sticky save bars live. */
    e.preventDefault();
    installEvent = e;
    renderInstallRow();
  });

  window.addEventListener('appinstalled', function () {
    installEvent = null;
    renderInstallRow();
    /* No confirmation is drawn. On a desktop or a tablet the app window opens
       over this one and on Android the system says so itself; a toast here
       would be the third thing telling one person the same news. */
  });

  document.addEventListener('DOMContentLoaded', function () {
    var row = $id('acctInstall');
    if (row) {
      row.addEventListener('click', function () {
        if (!installEvent) return;
        var e = installEvent;
        // Spent the moment it is raised, and the row goes with it — the
        // browser's own dialog is the question now.
        installEvent = null;
        renderInstallRow();
        try { e.prompt(); } catch (err) { /* the dialog is the browser's */ }
      });
    }
    renderInstallRow();

    /* ── The service worker ────────────────────────────────────────────────
       THIS IS WHY THE BACK OFFICE CAN BE INSTALLED AT ALL. Chrome and Edge
       require a registered worker with a fetch handler before they will fire
       beforeinstallprompt or draw the omnibox install button; the manifest
       alone has never been enough.

       /sw.js is the one shared worker for this origin, at the one scope — /m
       registers it, the counter till now registers it, and THIS PAGE'S OWN
       Profile iframe (/backend/account) has been registering it all along for
       Web Push. So this is not a new worker on this page; it is the same one,
       registered before somebody happens to open Profile.

       NOTHING LISTENS FOR 'sw-updated' HERE, AND NOTHING SHOULD. The worker
       posts it to every client when a deploy lands and /m answers by reloading
       when it is safe to. This page must not: it is full of half-filled forms,
       unsaved rows and open composers, and a reload behind an operator throws
       all of it away. The back office picks up a new build on the next load.

       isSecureContext rather than a hand-rolled protocol check: it is the
       browser's own answer to the question a worker actually asks, and it
       already knows the exceptions a string comparison forgets. */
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
        // An installed app can go days without a navigation and browsers
        // throttle the automatic update check to about a day. Check when it
        // comes back to the foreground instead — same as /m and the till.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState !== 'visible') return;
          try { reg.update(); } catch (e) {
            /* Swallowed on purpose: a best-effort poll for a newer worker, run
               on every tab focus. A failure means the check did not happen this
               time — the next focus tries again, and the browser's own daily
               check runs regardless. Nothing to tell an operator. */
          }
        });
      }).catch(function () {
        // Swallowed on purpose: a failed registration costs the INSTALL OFFER
        // and nothing else. Every screen in the back office works without a
        // worker — it has for the life of the product — so there is nothing to
        // tell an operator here and nothing for them to do about it.
      });
    }
  });
})();
