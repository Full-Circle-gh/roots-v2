/* eslint-disable no-undef */
/* retail-admin app JS — reachable from the keyboard (audit R-05, second half).

   THE FINDING, AND WHAT IS LEFT OF IT
   ═══════════════════════════════════════════════════════════════════════
   R-05 had three parts. Dialogs now trap focus and there is a skip link past
   the rail; this is the third: actions written as `onclick` on elements that
   are not buttons. A <div onclick="…"> is invisible to the keyboard — it takes
   no focus, Enter does nothing on it, and a screen reader announces a piece of
   text rather than something you can do.

   About a hundred of them exist across the shell and the ten app parts: rows,
   cards, chips, tiles, a few images. They are not going to be rewritten as
   buttons one at a time — a hundred edits across ten files, each a chance to
   change layout by accident, to fix something that has one shape.

   WHAT THIS DOES
   ═══════════════════════════════════════════════════════════════════════
   One sweep, and one key handler.

     - Anything carrying `onclick` that is not ALREADY operable — a button, a
       link with an href, an input, a select, a summary — is given
       `tabindex="0"` so it can be reached, and `role="button"` when it has no
       role of its own, so it is announced as something you can do.
     - Enter and Space on such an element click it, which is what those keys do
       on a real button.

   The sweep re-runs when the DOM changes, because every list in this admin is
   repainted from JavaScript and an element created after load would otherwise
   be reachable only by mouse — which is the same defect with a later start.

   WHAT IT DELIBERATELY DOES NOT TOUCH
   ═══════════════════════════════════════════════════════════════════════
   A ROW gets focus and the Enter key but keeps its own role. An order row is a
   row; announcing it as a button would be a worse description than none, and
   the row's real actions are the buttons inside it.

   Anything that is already operable is left exactly as it was. This never
   removes a tabindex, never overrides a role somebody wrote, and never adds a
   second handler to an element it has already seen — a sweep that fought with
   the code it is patching would be worse than the gap it fills. */

const KBD_NATIVE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION']);
// A row is focusable but is not a button. Keeping its role is the honest
// description; the actions on a row are the buttons inside it.
const KBD_KEEP_ROLE = new Set(['TR', 'TD', 'TH', 'LI']);

function _kbdAlreadyOperable(el) {
  if (KBD_NATIVE.has(el.tagName)) return true;
  if (el.tagName === 'A' && el.hasAttribute('href')) return true;
  if (el.hasAttribute('tabindex')) return true;          // somebody has already thought about it
  if (el.isContentEditable) return true;
  return false;
}

function kbdPromote(root) {
  const scope = root && root.querySelectorAll ? root : document;
  let list;
  try { list = scope.querySelectorAll('[onclick]'); } catch (e) { return 0; }
  let n = 0;
  for (const el of list) {
    if (el.dataset && el.dataset.kbdSeen) continue;
    // `data-kbd-skip` is the opt-out for a clickable that is not an action —
    // a scrim whose only job is "click anywhere to close", say, where a focus
    // stop announced as a button would be one more thing to tab past on the way
    // to the dialog. Escape already closes those.
    if (el.hasAttribute('data-kbd-skip')) { if (el.dataset) el.dataset.kbdSeen = '1'; continue; }
    if (_kbdAlreadyOperable(el)) { if (el.dataset) el.dataset.kbdSeen = '1'; continue; }
    el.setAttribute('tabindex', '0');
    if (!el.getAttribute('role') && !KBD_KEEP_ROLE.has(el.tagName)) el.setAttribute('role', 'button');
    // Two marks, not one. `kbdSeen` means "looked at" and is on everything,
    // including what was skipped, so a re-sweep is cheap and idempotent.
    // `kbdAdded` means "this element only takes focus because of this file",
    // and is what the focus ring in retail-admin.css hangs on — a button that
    // styles its own focus must never pick up a second outline from here.
    el.dataset.kbdAdded = '1';
    el.dataset.kbdSeen = '1';
    n++;
  }
  return n;
}
window.kbdPromote = kbdPromote;

// Enter and Space do what they do on a real button. Delegated at the document,
// so an element painted a second from now is covered without being re-bound.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const el = e.target;
  if (!el || !el.getAttribute || el !== document.activeElement) return;
  if (!el.hasAttribute('onclick') || _kbdNative(el)) return;
  // Space scrolls the page by default, and Enter submits a form. Both would
  // happen ALONGSIDE the action, which is the sort of double effect that makes
  // people stop using the keyboard.
  e.preventDefault();
  el.click();
});
// Same test as the sweep's, minus the tabindex clause: by the time a key
// arrives the sweep has ADDED that tabindex, so asking about it here would
// exclude every element this exists for.
function _kbdNative(el) {
  if (KBD_NATIVE.has(el.tagName)) return true;
  if (el.tagName === 'A' && el.hasAttribute('href')) return true;
  return false;
}

// Re-sweep on repaint. Coalesced into one pass per frame: the order list alone
// replaces a hundred rows at a time, and a sweep per mutation would run a
// hundred times for one paint.
let _kbdQueued = false;
// BOUND to window on purpose: `(window.requestAnimationFrame || setTimeout)(fn)`
// calls rAF with the wrong receiver, which browsers reject as an illegal
// invocation — and the sweep would then never run again after the first paint.
const _kbdSoon = window.requestAnimationFrame
  ? window.requestAnimationFrame.bind(window)
  : (fn) => setTimeout(fn, 0);
function _kbdSchedule() {
  if (_kbdQueued) return;
  _kbdQueued = true;
  _kbdSoon(() => { _kbdQueued = false; kbdPromote(document); });
}
try {
  new MutationObserver(_kbdSchedule).observe(document.documentElement, { childList: true, subtree: true });
} catch (e) {
  // No observer (a very old browser): the load sweep below still covers the
  // shell's own markup, which is where the fixed controls live.
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => kbdPromote(document));
else kbdPromote(document);

/* ══════════════════════════════════════════════════════════════════════════
   MOVING THROUGH A LIST WITHOUT THE MOUSE (audit E-09)
   ══════════════════════════════════════════════════════════════════════════
   The only global keys were Ctrl/⌘+K to search and Escape to close. There was
   no way to move between rows, or to open one, from the keyboard — which is
   how a busy counter works, and the merchants this is built for run twenty
   locations.

   Four keys, and no more:

     j / ↓     next row          k / ↑     previous row
     /         jump to the search box on this screen
     ?         what the keys are

   Enter already opens a focused row; that was written with the row's own
   tabindex and is left alone.

   THERE IS DELIBERATELY NO STATUS KEY, though the audit suggests one.
   Advancing an order is a WRITE, and a single unmodified letter that writes is
   how the wrong order gets dispatched by somebody who thought they were still
   typing. Moving and opening are safe because they change nothing; the action
   stays a button somebody meant to press.

   Every key here bails while something is being typed — a text field, a select,
   anything editable — and while a dialog is open, where focus belongs to the
   dialog. A shortcut that fires mid-sentence is not a shortcut. */

// The rows that are click-to-open across the admin, plus an opt-in for any list
// added later. Deliberately the same set the Orders click handler recognises:
// if a row opens on a click, it should move under a key.
const KBD_ROWS = 'tr.order-row, tr.cul-row, tr.vch-row, .db-feed-row, .dp-work-row, [data-kbd-row]';

function _kbdTyping(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) >= 0;
}
function _kbdDialogOpen() {
  return !!document.querySelector('.tdlg-scrim');
}
function _kbdVisibleRows() {
  const out = [];
  for (const el of document.querySelectorAll(KBD_ROWS)) {
    // offsetParent is null for anything display:none — which is most of this
    // shell at any moment, since every section stays in the DOM.
    if (el.offsetParent !== null) out.push(el);
  }
  return out;
}
function kbdMoveRow(delta) {
  const rows = _kbdVisibleRows();
  if (!rows.length) return false;
  const cur = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest(KBD_ROWS) : null;
  let i = cur ? rows.indexOf(cur) : -1;
  // Nothing focused yet: j starts at the top and k at the bottom, which is what
  // those keys mean everywhere else they exist.
  i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + delta));
  const el = rows[i];
  if (!el) return false;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  el.focus();
  if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  return true;
}
window.kbdMoveRow = kbdMoveRow;

// The search box for whatever is on screen. The house convention is an id
// ending in `-q` — nine of them across the admin — so this finds the visible
// one rather than keeping a list that would go stale.
function kbdFocusSearch() {
  for (const el of document.querySelectorAll('input[data-kbd-search], input[id$="-q"]')) {
    if (el.offsetParent === null) continue;
    el.focus();
    if (el.select) el.select();
    return true;
  }
  return false;
}
window.kbdFocusSearch = kbdFocusSearch;

function kbdHelp() {
  if (typeof askConfirm !== 'function') return;
  const T = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
  askConfirm({
    title: T('Keyboard shortcuts', '键盘快捷键'),
    body: [
      'j / ↓ · ' + T('next row', '下一行'),
      'k / ↑ · ' + T('previous row', '上一行'),
      'Enter · ' + T('open the row', '打开该行'),
      '/ · ' + T('jump to search', '跳到搜索框'),
      'Ctrl/⌘ K · ' + T('search everything', '全局搜索'),
      'Esc · ' + T('close', '关闭'),
    ].join('  ·  '),
    confirm: T('Got it', '知道了'),
    hideCancel: true,
  });
}
window.kbdHelp = kbdHelp;

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;      // Ctrl+K and friends are not ours
  if (_kbdTyping(e.target) || _kbdDialogOpen()) return;
  const k = e.key;
  if (k === 'j' || k === 'ArrowDown')      { if (kbdMoveRow(1)) e.preventDefault(); return; }
  if (k === 'k' || k === 'ArrowUp')        { if (kbdMoveRow(-1)) e.preventDefault(); return; }
  if (k === '/')                           { if (kbdFocusSearch()) e.preventDefault(); return; }
  if (k === '?')                           { e.preventDefault(); kbdHelp(); }
});
