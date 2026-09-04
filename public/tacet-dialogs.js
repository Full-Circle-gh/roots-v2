/* eslint-disable no-unused-vars */
// tacet-dialogs.js — shared replacement for window.confirm()/alert()/prompt().
// Self-contained: injects its own scoped stylesheet on first use, so it works
// on any page with just <script src="/tacet-dialogs.js"></script> — no other
// CSS or markup required. On pages that already define the retail-admin theme
// vars (--bg-pane, --line, --text-1, --text-2, --bg-overlay, --tacet-brick,
// --tacet-brick-tint, --tacet-ink) it inherits them (dark-mode aware); on
// plain pages it falls back to the raw Tacet paper palette.
//
// API (all Promise-based — replace `if (confirm(x))` with `if (await askConfirm(x))`,
// and the calling function must be `async`):
//   askConfirm(opts) -> Promise<boolean>
//     opts: { title|titleEn+titleCn, body|bodyEn+bodyCn (may contain simple HTML
//            like <b>), confirmLabel|confirmEn+confirmCn, cancelLabel|cancelEn+cancelCn,
//            danger: bool, matchWord: string (optional typed-confirmation gate),
//            hideCancel: bool — drops the Cancel button, turning the dialog into
//            an acknowledgement ("here is what happened") rather than a question.
//            Escape and the backdrop still dismiss it. }
//   askPrompt(opts) -> Promise<string|null>   -- single-line text input
//     opts: { title|titleEn+titleCn, label|labelEn+labelCn, value, placeholder|phEn+phCn,
//            submitLabel|submitEn+submitCn, cancelLabel|cancelEn+cancelCn, danger: bool }
//   askReason(opts) -> Promise<string|null>   -- same as askPrompt, textarea instead
//     opts also accepts sub|subEn+subCn (a one-line note under the title)
// Both askPrompt/askReason resolve '' if submitted empty (value is optional
// unless opts.required is set), null if dismissed (Escape / backdrop / Cancel).
//   askChoice(opts) -> Promise<string|null>   -- pick one from a list
//     opts: { title|titleEn+titleCn, sub|subEn+subCn, label|labelEn+labelCn,
//            options: [{ value, label }], value (preselected — omit for none,
//            which disables submit until a pick is made),
//            submitLabel|submitEn+submitCn, cancelLabel|cancelEn+cancelCn, danger }
//     Resolves the chosen value, or null if dismissed. Added for the Team
//     screen's "delete this role — where do its people go?", which used to be
//     window.prompt() with a numbered list and "Type a number:".
//   askCustom(kindClass, bodyHtml, footHtml, focusSel) -> { scrim, closer, ready }
//     The shell the three functions above build on, for a caller whose
//     content is more than a title/message/one field. kindClass is appended
//     to the modal's own class list (pass '' for none; 'tdlg-neutral' /
//     'tdlg-danger' pick the icon-tint variants those two use, irrelevant if
//     the caller's bodyHtml has no .tdlg-ic). scrim is the mounted DOM node —
//     query it for the caller's own fields/buttons and wire listeners after
//     the call. closer(result) closes the dialog and resolves `ready` with
//     `result`; call it from the caller's own submit handler, not just Cancel.
//     ALWAYS call this rather than building .tdlg-scrim/.tdlg-modal markup by
//     hand — this is the only thing that calls injectStyle(), so a hand-built
//     copy renders unstyled and unpositioned the first time it runs in a page
//     that hasn't opened a real dialog yet (see its own comment below).
(function () {
  if (window.askConfirm) return; // already loaded (e.g. two script tags)

  function injectStyle() {
    if (document.getElementById('tdlg-style')) return;
    const s = document.createElement('style');
    s.id = 'tdlg-style';
    s.textContent = `
      .tdlg-scrim {
        position: fixed; inset: 0; z-index: 2000;
        background: var(--bg-overlay, rgba(17,26,43,.32));
        display: flex; align-items: center; justify-content: center; padding: 24px;
        opacity: 0; pointer-events: none;
        transition: opacity 300ms cubic-bezier(.22,.61,.36,1);
      }
      .tdlg-scrim.on { opacity: 1; pointer-events: auto; }
      .tdlg-modal {
        width: 440px; max-width: 100%;
        background: var(--bg-pane, #FFFFFF); border: 1px solid var(--line, #E4E0D5);
        border-radius: 14px; box-shadow: 0 24px 64px rgba(17,26,43,.24);
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: var(--text-1, #111A2B);
        transform: translateY(10px) scale(.985); opacity: 0;
        transition: transform 300ms cubic-bezier(.22,.61,.36,1), opacity 300ms cubic-bezier(.22,.61,.36,1);
        /* The scrim centers this via flex with 24px padding on every side
           (below) — but with no cap here, content taller than the viewport
           just overflows past both edges instead of scrolling, since a
           flex-centered child isn't clipped by its container. askConfirm/
           askPrompt/askReason never hit this (one or two short fields), but
           askCustom() callers can have arbitrarily long content, so the cap
           lives here rather than in each caller. Column layout + .tdlg-body
           taking the scroll keeps .tdlg-foot's buttons pinned and reachable
           even when the body scrolls. */
        max-height: calc(100vh - 48px);
        display: flex; flex-direction: column;
      }
      .tdlg-scrim.on .tdlg-modal { transform: none; opacity: 1; }
      .tdlg-body { padding: 22px 22px 20px; overflow-y: auto; min-height: 0; flex: 1 1 auto; }
      .tdlg-ic { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
      .tdlg-ic svg { width: 19px; height: 19px; }
      .tdlg-modal.tdlg-danger .tdlg-ic { background: var(--tacet-brick-tint, #F6E7E3); color: var(--tacet-brick, #B4533E); }
      .tdlg-modal.tdlg-neutral .tdlg-ic { background: var(--tacet-dusk-tint, #EEEDF6); color: var(--tacet-dusk, #6E67AF); }
      .tdlg-title { font-size: 15.5px; font-weight: 600; letter-spacing: -.005em; margin: 0; line-height: 1.35; }
      .tdlg-sub { font-size: 12.5px; color: var(--text-2, #58606E); margin: 4px 0 0; }
      .tdlg-msg { font-size: 13.5px; color: var(--text-2, #58606E); margin: 8px 0 0; line-height: 1.55; }
      .tdlg-field { margin-top: 16px; }
      .tdlg-field label { display: block; font-size: 12px; font-weight: 500; color: var(--text-2, #58606E); margin-bottom: 5px; }
      .tdlg-field input, .tdlg-field textarea, .tdlg-field select {
        width: 100%; box-sizing: border-box; font: 400 13.5px inherit; color: var(--text-1, #111A2B);
        background: var(--bg-app, #FBF9F4); border: 1px solid var(--line, #E4E0D5); border-radius: 8px; padding: 9px 11px;
      }
      .tdlg-field textarea { resize: vertical; min-height: 64px; font-family: inherit; }
      .tdlg-field select { appearance: none; cursor: pointer; font-family: inherit; }
      .tdlg-field input:focus, .tdlg-field textarea:focus, .tdlg-field select:focus {
        outline: none; border-color: var(--tacet-dusk, #6E67AF); box-shadow: 0 0 0 3px var(--tacet-dusk-tint, #EEEDF6);
      }
      .tdlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--line, #E4E0D5); }
      .tdlg-btn { font: 500 13px inherit; border-radius: 8px; border: 1px solid transparent; padding: 8px 15px; cursor: pointer; }
      .tdlg-btn--ghost { background: transparent; color: var(--text-2, #58606E); border-color: var(--line, #E4E0D5); }
      .tdlg-btn--ghost:hover { color: var(--text-1, #111A2B); border-color: var(--text-2, #58606E); }
      .tdlg-btn--primary { background: var(--tacet-ink, #111A2B); color: #fff; }
      .tdlg-btn--primary:hover { background: #2A3550; }
      .tdlg-btn--danger { background: transparent; color: var(--tacet-brick, #B4533E); border-color: var(--tacet-brick, #B4533E); }
      .tdlg-btn--danger:hover { background: var(--tacet-brick-tint, #F6E7E3); }
      .tdlg-btn:disabled { opacity: .5; cursor: not-allowed; }
      @media (prefers-reduced-motion: reduce) { .tdlg-scrim, .tdlg-modal { transition: none; } }
    `;
    document.head.appendChild(s);
  }

  // Prefer an explicit single field; else join the En/Cn pair with " · "; else
  // whichever half is present; else ''. `bases` may be one name or several
  // (tried in order) so both the terse legacy field names (confirmEn/confirmCn,
  // phEn/phCn, submitEn/submitCn — from the original 04-orders.js askConfirm/
  // askReason) and clearer new-caller names (confirmLabel, placeholder,
  // submitLabel) resolve through the same implementation.
  function pick(o, bases) {
    bases = Array.isArray(bases) ? bases : [bases];
    for (const base of bases) {
      if (o[base] != null) return o[base];
      const en = o[base + 'En'], cn = o[base + 'Cn'];
      if (en != null && cn != null) return en + ' · ' + cn;
      if (en != null) return en;
      if (cn != null) return cn;
    }
    return '';
  }

  const ICONS = {
    danger: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
    neutral: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  };
  function iconSvg(kind) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + ICONS[kind] + '</svg>';
  }

  let activeClose = null;

  function openScrim(kindClass, bodyHtml, footHtml, focusSel) {
    injectStyle();
    const scrim = document.createElement('div');
    scrim.className = 'tdlg-scrim';
    scrim.innerHTML = `<div class="tdlg-modal ${kindClass}"><div class="tdlg-body">${bodyHtml}</div><div class="tdlg-foot">${footHtml}</div></div>`;
    document.body.appendChild(scrim);
    const lastFocus = document.activeElement;
    requestAnimationFrame(() => scrim.classList.add('on'));

    let done = false;
    function close(result, resolve) {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      scrim.classList.remove('on');
      setTimeout(() => scrim.remove(), 260);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      activeClose = null;
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') closer(null); }
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closer(null); });
    document.addEventListener('keydown', onKey);

    let closer;
    const ready = new Promise((resolve) => {
      closer = (result) => close(result, resolve);
      activeClose = () => closer(null);
    });
    setTimeout(() => {
      const f = scrim.querySelector(focusSel);
      if (f) f.focus();
    }, 40);
    return { scrim, closer, ready };
  }

  function askConfirm(opts) {
    opts = opts || {};
    const danger = !!opts.danger;
    const kindClass = danger ? 'tdlg-danger' : 'tdlg-neutral';
    const icon = iconSvg(danger ? 'danger' : 'neutral');
    const title = pick(opts, 'title');
    const body = pick(opts, 'body');
    const confirmLabel = pick(opts, ['confirm', 'confirmLabel']) || 'Confirm';
    const cancelLabel = pick(opts, ['cancel', 'cancelLabel']) || 'Cancel';
    const gateField = opts.matchWord
      ? `<div class="tdlg-field"><label for="tdlg-gate">Type ${opts.matchWord} to continue</label><input id="tdlg-gate" type="text" placeholder="${opts.matchWord}" autocomplete="off"></div>`
      : '';
    const bodyHtml = `
      <div class="tdlg-ic">${icon}</div>
      <h3 class="tdlg-title">${title}</h3>
      ${body ? `<p class="tdlg-msg">${body}</p>` : ''}
      ${gateField}`;
    // hideCancel turns this into an ACKNOWLEDGEMENT rather than a question:
    // one button, which closes it. For reporting an outcome the operator can do
    // nothing about — "14 moved, 3 could not, here is which three". Two buttons
    // that both mean "I have read this" is a choice that isn't one, and the
    // ghost button reads as "undo" when there is nothing to undo.
    // Escape and the scrim still close it, exactly as they always did.
    const footHtml = `
      ${opts.hideCancel ? '' : `<button class="tdlg-btn tdlg-btn--ghost" data-cancel>${cancelLabel}</button>`}
      <button class="tdlg-btn ${danger ? 'tdlg-btn--danger' : 'tdlg-btn--primary'}" data-submit ${opts.matchWord ? 'disabled' : ''}>${confirmLabel}</button>`;
    const focusSel = opts.matchWord ? '#tdlg-gate' : '[data-submit]';
    const { scrim, closer, ready } = openScrim(kindClass, bodyHtml, footHtml, focusSel);
    scrim.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => closer(false)));
    const submitBtn = scrim.querySelector('[data-submit]');
    submitBtn.addEventListener('click', () => closer(true));
    if (opts.matchWord) {
      const gate = scrim.querySelector('#tdlg-gate');
      gate.addEventListener('input', () => { submitBtn.disabled = gate.value.trim() !== opts.matchWord; });
    }
    return ready;
  }

  function askInput(opts, textarea) {
    opts = opts || {};
    const danger = !!opts.danger;
    const kindClass = danger ? 'tdlg-danger' : 'tdlg-neutral';
    const title = pick(opts, 'title');
    const sub = pick(opts, 'sub');
    const label = pick(opts, 'label');
    const placeholder = pick(opts, ['ph', 'placeholder']);
    const submitLabel = pick(opts, ['submit', 'submitLabel']) || 'Save';
    const cancelLabel = pick(opts, ['cancel', 'cancelLabel']) || 'Cancel';
    const value = opts.value != null ? String(opts.value) : '';
    const fieldHtml = textarea
      ? `<textarea id="tdlg-in" placeholder="${placeholder}">${value}</textarea>`
      : `<input id="tdlg-in" type="text" placeholder="${placeholder}" value="${value.replace(/"/g, '&quot;')}">`;
    const bodyHtml = `
      <h3 class="tdlg-title">${title}</h3>
      ${sub ? `<p class="tdlg-sub">${sub}</p>` : ''}
      <div class="tdlg-field">${label ? `<label for="tdlg-in">${label}</label>` : ''}${fieldHtml}</div>`;
    const footHtml = `
      <button class="tdlg-btn tdlg-btn--ghost" data-cancel>${cancelLabel}</button>
      <button class="tdlg-btn ${danger ? 'tdlg-btn--danger' : 'tdlg-btn--primary'}" data-submit>${submitLabel}</button>`;
    const { scrim, closer, ready } = openScrim(kindClass, bodyHtml, footHtml, '#tdlg-in');
    const input = scrim.querySelector('#tdlg-in');
    scrim.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => closer(null)));
    scrim.querySelector('[data-submit]').addEventListener('click', () => closer(input.value));
    if (!textarea) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') closer(input.value); });
    return ready;
  }

  function askPrompt(opts) { return askInput(opts, false); }
  function askReason(opts) { return askInput(opts, true); }

  // PICK ONE OF THESE. The missing member of the family: askConfirm answers
  // yes/no, askPrompt and askReason take typed text, and anything that needed a
  // CHOICE had to fall back to the browser's own prompt() with a numbered list
  // and "Type a number:" — which is how deleting a staff role who somebody
  // holds used to ask where those people should go.
  //
  //   options — [{ value, label }], drawn in the order given.
  //   value   — preselected value; omit for "nothing chosen yet", which
  //             disables the submit until the operator picks. There is
  //             deliberately no default: picking is the point.
  // Resolves with the chosen value, or null if cancelled.
  function askChoice(opts) {
    opts = opts || {};
    const danger = !!opts.danger;
    const title = pick(opts, 'title');
    const sub = pick(opts, 'sub');
    const label = pick(opts, 'label');
    const submitLabel = pick(opts, ['submit', 'submitLabel']) || 'Continue';
    const cancelLabel = pick(opts, ['cancel', 'cancelLabel']) || 'Cancel';
    const list = Array.isArray(opts.options) ? opts.options : [];
    const has = opts.value != null && list.some((o) => String(o.value) === String(opts.value));
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const optionsHtml = (has ? '' : '<option value="" selected disabled></option>')
      + list.map((o) => `<option value="${esc(o.value)}"${has && String(o.value) === String(opts.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const bodyHtml = `
      <h3 class="tdlg-title">${title}</h3>
      ${sub ? `<p class="tdlg-sub">${sub}</p>` : ''}
      <div class="tdlg-field">${label ? `<label for="tdlg-pick">${label}</label>` : ''}
        <select id="tdlg-pick">${optionsHtml}</select></div>`;
    const footHtml = `
      <button class="tdlg-btn tdlg-btn--ghost" data-cancel>${cancelLabel}</button>
      <button class="tdlg-btn ${danger ? 'tdlg-btn--danger' : 'tdlg-btn--primary'}" data-submit${has ? '' : ' disabled'}>${submitLabel}</button>`;
    const { scrim, closer, ready } = openScrim(danger ? 'tdlg-danger' : 'tdlg-neutral', bodyHtml, footHtml, '#tdlg-pick');
    const sel = scrim.querySelector('#tdlg-pick');
    const submitBtn = scrim.querySelector('[data-submit]');
    sel.addEventListener('change', () => { submitBtn.disabled = !sel.value; });
    scrim.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => closer(null)));
    submitBtn.addEventListener('click', () => { if (sel.value) closer(sel.value); });
    return ready;
  }

  window.askConfirm = askConfirm;
  window.askPrompt = askPrompt;
  window.askReason = askReason;
  window.askChoice = askChoice;
  // The shell askConfirm/askPrompt/askReason all build on, exposed directly
  // for a caller whose content is more than a title/message/one field —
  // search-and-pick, tabs, several fields (public/retail-admin/19-recipes.js's
  // materialize modal is the first caller). This is the ONLY thing that calls
  // injectStyle(): a caller who builds .tdlg-scrim/.tdlg-modal markup by hand
  // instead of through this function gets unstyled, unpositioned divs the
  // first time it runs in a page session that hasn't opened a real askConfirm
  // yet — no centering, no backdrop, no Escape/outside-click/focus-restore.
  // That is a from-scratch bug, not a coordinate to nudge; the fix is always
  // to call this, never to re-implement the shell.
  window.askCustom = openScrim;
})();
