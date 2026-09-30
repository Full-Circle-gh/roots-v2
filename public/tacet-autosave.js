/* Tacet autosave — the one engine a settings screen uses to save itself.
   Decisions §279. Loaded by the phone (public/m.html) and the desktop
   (public/retail-admin.html) alike, so a screen behaves the same on both.

   WHAT THE SCREEN GIVES IT
     read()            → the payload the screen would send now, normalised the way
                         the server stores it. Compared as JSON, so build it in a
                         fixed key order.
     hold(payload)     → '' to send, or a sentence saying why not yet (an empty
                         name). A held edit is not an error and is not sent.
     send(payload, note) → a Promise for the write. `note` is null for an edit,
                         'undo' or 'restore' otherwise; the server files it on the
                         history row so those steps are never folded into an edit.
     onChange()        → repaint the footer. Called on every state change.
     delay             → the pause after the last edit before it is sent (800ms).
     maxWait           → optional: the longest an edit may wait, however long the
                         typing goes on. Without it a steady typist postpones the
                         save for as long as they type — a plain debounce. The
                         Recipes record (§300) keeps the desktop's 1.2s / 8s.

   WHAT IT GIVES BACK
     start()           → the visit begins: what read() says now is both "saved"
                         and the point Undo returns to.
     touch()           → something changed; send after the pause.
     flush(note)       → send now (leaving the screen, Undo, a restore).
     undo(apply)       → apply(visitStartPayload) puts the screen back, then it
                         is sent with note 'undo'.
     state             → 'saved' | 'pending' | 'saving' | 'hold' | 'error'
     message           → the hold reason or the server's refusal
     canUndo()         → there is something since the visit began to take back
     busy()            → a write is pending or on the wire (the phone's reload
                         guard reads this)

   THE RULES IT KEEPS, because each is a bug somewhere else in this codebase:
   ONE WRITE IN FLIGHT — an edit made during a save is sent when it lands, never
   alongside it (recvFlush, pdAutoSaveNow). "SAVED" MEANS WHAT WAS SENT, not what
   came back: the server trims and fills names, and comparing the screen against
   its answer would read as a change forever and save in a loop. A FAILED WRITE
   IS NOT RETRIED ON ITS OWN — a refusal would repeat every 0.8s; the next edit,
   or leaving, tries again. */
(function (root) {
  'use strict';

  function create(opts) {
    var delay = opts.delay != null ? opts.delay : 800;
    var maxWait = opts.maxWait != null ? opts.maxWait : null;
    /* Set by the FIRST edit of a burst and not moved by the ones after it. */
    var deadline = 0;
    var timer = null, inFlight = false, again = false, againNote = null, running = null;
    var saved = null, visitStart = null;
    var ctl = { state: 'saved', message: '' };

    function now() { return JSON.stringify(opts.read()); }
    function set(state, message) {
      ctl.state = state; ctl.message = message || '';
      if (opts.onChange) opts.onChange(ctl);
    }
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }

    ctl.start = function () {
      clear(); deadline = 0; inFlight = false; again = false; againNote = null;
      saved = visitStart = now();
      ctl.state = 'saved'; ctl.message = '';
    };
    ctl.dirty = function () { return saved !== null && now() !== saved; };
    ctl.busy = function () { return !!timer || inFlight; };
    ctl.canUndo = function () { return visitStart !== null && (saved !== visitStart || now() !== visitStart); };

    ctl.touch = function () {
      clear();
      if (!ctl.dirty()) { deadline = 0; if (!inFlight) set('saved'); return; }
      var why = opts.hold ? opts.hold(opts.read()) : '';
      if (why) { set('hold', why); return; }
      set('pending');
      var wait = delay;
      if (maxWait != null) {
        var t = Date.now();
        if (!deadline) deadline = t + maxWait;
        wait = Math.max(0, Math.min(delay, deadline - t));
      }
      timer = setTimeout(function () { timer = null; ctl.flush(); }, wait);
    };

    ctl.flush = function (note) {
      clear(); deadline = 0;
      /* Queued behind the write on the wire; the promise handed back is that
         write's, which does not settle until the queued one has run too. */
      if (inFlight) { again = true; againNote = note || againNote; return running || Promise.resolve(); }
      var payload = opts.read();
      var json = JSON.stringify(payload);
      if (json === saved && !note) { set('saved'); return Promise.resolve(); }
      var why = opts.hold ? opts.hold(payload) : '';
      if (why) { set('hold', why); return Promise.resolve(); }
      inFlight = true; set('saving');
      /* The write STARTS in this task, not a microtask later: a flush on the
         way out (leaving the screen, the tab going away) must have its request
         on the wire before the page is torn down. */
      var sent;
      try { sent = Promise.resolve(opts.send(payload, note || null)); } catch (e) { sent = Promise.reject(e); }
      running = sent.then(function () {
        inFlight = false; saved = json;
        if (again) { var n = againNote; again = false; againNote = null; return ctl.flush(n); }
        if (ctl.dirty()) { ctl.touch(); return; }
        set('saved');
      }, function (e) {
        inFlight = false; again = false; againNote = null;
        if (e && String(e.message) === 'auth') return;
        set('error', (e && e.message) || '');
      });
      return running;
    };

    ctl.undo = function (apply) {
      if (visitStart === null) return Promise.resolve();
      clear();
      apply(JSON.parse(visitStart));
      return ctl.flush('undo');
    };

    ctl.stop = function () { clear(); };
    return ctl;
  }

  root.TacetAutosave = { create: create };

  /* Exported for Node so the engine can be asserted without a browser — the
     pattern td-datetime.js uses. */
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
