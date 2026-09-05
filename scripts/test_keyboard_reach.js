#!/usr/bin/env node
/**
 * test_keyboard_reach.js — the clickables that were not reachable (audit R-05).
 *
 *   node scripts/test_keyboard_reach.js
 *
 * R-05 had three parts. Dialogs trap focus and there is a skip link past the
 * rail; this is the third — actions written as `onclick` on elements that are
 * not buttons. A <div onclick="…"> takes no focus, Enter does nothing on it,
 * and a screen reader announces a piece of text rather than something you can
 * do. About a hundred exist across the shell and the app parts.
 *
 * The module is driven in a sandbox with a hand-built DOM rather than a real
 * browser, because what is being checked is a RULE — which elements are touched
 * and which are left exactly alone — and a rule is easier to state wrongly than
 * to render wrongly. The two things it must never do are the two that would
 * make it worse than the gap it fills:
 *
 *   - never change an element that is already operable, and
 *   - never call a row a button.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// ── A DOM, by hand ────────────────────────────────────────────────────────
// Only what the module actually touches. A fake that answered more than the
// module asks would be a fake that could pass while the real page did not.
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this._a = { ...attrs };
    this.dataset = {};
    this.clicks = 0;
    this.isContentEditable = false;
  }
  getAttribute(k) { return k in this._a ? this._a[k] : null; }
  setAttribute(k, v) { this._a[k] = String(v); }
  hasAttribute(k) { return k in this._a; }
  click() { this.clicks++; }
}
function makeDoc(els) {
  const keydown = [];
  return {
    _keydown: keydown,
    readyState: 'complete',
    activeElement: null,
    documentElement: {},
    querySelectorAll: (sel) => (sel === '[onclick]' ? els.filter((e) => e.hasAttribute('onclick')) : []),
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); },
  };
}
function load(els) {
  const doc = makeDoc(els);
  const sandbox = {
    document: doc,
    window: {},
    MutationObserver: function () { this.observe = () => {}; },
    requestAnimationFrame: (fn) => fn(),
    console,
  };
  sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/retail-admin/26-keyboard.js'), 'utf8'),
    sandbox, { filename: '26-keyboard.js' });
  return { doc, sandbox };
}
// One keydown, as the browser would deliver it to the focused element.
function press(doc, key, target) {
  let prevented = false;
  doc.activeElement = target;
  const ev = { key, target, preventDefault: () => { prevented = true; } };
  doc._keydown.forEach((fn) => fn(ev));
  return prevented;
}

// ── §1 · what gets promoted ───────────────────────────────────────────────
section('1 · a clickable that was not reachable becomes reachable');
{
  const div = new El('div', { onclick: 'x()' });
  const span = new El('span', { onclick: 'x()' });
  const img = new El('img', { onclick: 'x()' });
  load([div, span, img]);
  is([div.getAttribute('tabindex'), span.getAttribute('tabindex'), img.getAttribute('tabindex')],
    ['0', '0', '0'], 'a div, a span and an image with an onclick can all be tabbed to');
  is(div.getAttribute('role'), 'button', 'and are announced as something you can do');
  is(div.dataset.kbdAdded, '1', 'and are marked as ours, so they get a focus ring to match');
  const css = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');
  yes(/\[data-kbd-added\]:focus-visible/.test(css),
    'which the stylesheet draws — reachable and invisible is barely better than unreachable');
}

section('2 · what is left exactly as it was');
{
  const btn = new El('button', { onclick: 'x()' });
  const link = new El('a', { onclick: 'x()', href: '/somewhere' });
  const input = new El('input', { onclick: 'x()' });
  const already = new El('div', { onclick: 'x()', tabindex: '-1' });
  const roled = new El('div', { onclick: 'x()', role: 'switch' });
  const skipped = new El('div', { onclick: 'x()', 'data-kbd-skip': '' });
  load([btn, link, input, already, roled, skipped]);
  is(btn.getAttribute('tabindex'), null, 'a real button is not touched');
  // The focus ring in retail-admin.css hangs on `data-kbd-added`, so a control
  // that styles its own focus must not carry it — only what this file made
  // focusable does.
  is(btn.dataset.kbdAdded, undefined, 'and picks up no focus ring of ours');
  is(link.getAttribute('tabindex'), null, 'nor a link with somewhere to go');
  is(input.getAttribute('tabindex'), null, 'nor an input');
  is(already.getAttribute('tabindex'), '-1',
    'a tabindex somebody wrote on purpose is never overwritten');
  is(roled.getAttribute('role'), 'switch', 'and neither is a role somebody chose');
  is(roled.getAttribute('tabindex'), '0', '…though it is still made reachable');
  is(skipped.getAttribute('tabindex'), null, 'data-kbd-skip opts an element out entirely');
}

section('3 · a row is not a button');
{
  const tr = new El('tr', { onclick: 'openOrder()' });
  const li = new El('li', { onclick: 'pick()' });
  load([tr, li]);
  is(tr.getAttribute('tabindex'), '0', 'an order row can be reached');
  is(tr.getAttribute('role'), null,
    'and stays a row — announcing it as a button is a worse description than none');
  is(li.getAttribute('role'), null, 'same for a list item');
}

section('4 · the keys do what they do on a button');
{
  const div = new El('div', { onclick: 'x()' });
  const btn = new El('button', { onclick: 'x()' });
  const { doc } = load([div, btn]);
  // press() returns whether the default was prevented, so each of these asserts
  // BOTH halves: the action happened, and the browser's own behaviour did not
  // happen alongside it. Space scrolls the page and Enter submits a form —
  // exactly the sort of double effect that makes people stop using the keyboard.
  yes(press(doc, 'Enter', div) && div.clicks === 1, 'Enter acts on it, and only it');
  yes(press(doc, ' ', div) && div.clicks === 2, 'Space acts on it, and does not scroll');
  press(doc, 'a', div);
  is(div.clicks, 2, 'any other key is left alone');
  press(doc, 'Enter', btn);
  is(btn.clicks, 0, 'a real button is left to the browser — otherwise it fires twice');
}
{
  // Focus somewhere else entirely: a keydown that bubbles up from a text field
  // inside a clickable card must not press the card.
  const card = new El('div', { onclick: 'open()' });
  const field = new El('input', {});
  const { doc } = load([card, field]);
  doc.activeElement = field;
  doc._keydown.forEach((fn) => fn({ key: 'Enter', target: card, preventDefault: () => {} }));
  is(card.clicks, 0, 'typing Enter in a field inside a card does not press the card');
}

section('5 · it can run again without doing it twice');
{
  const div = new El('div', { onclick: 'x()' });
  const { sandbox } = load([div]);
  div.setAttribute('tabindex', '3');           // as if somebody changed it after
  sandbox.kbdPromote(sandbox.document);
  is(div.getAttribute('tabindex'), '3',
    'an element already swept is skipped, so a repaint cannot fight the page');
}

section('6 · it is loaded, and it is the last word');
{
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  yes(html.includes('26-keyboard.js'), 'the shell loads it');
  const at = html.indexOf('26-keyboard.js');
  const others = [...html.matchAll(/retail-admin\/(\d\d)-[a-z-]+\.js/g)].map((m) => m.index);
  yes(others.every((i) => i <= at), 'after every part that paints, so the first sweep sees them all');
  const src = fs.readFileSync(path.join(ROOT, 'public/retail-admin/26-keyboard.js'), 'utf8');
  yes(/MutationObserver/.test(src),
    'and re-sweeps on repaint — every list here is painted from JavaScript');
  yes(/_kbdQueued/.test(src),
    'once per frame, not once per mutation: a hundred rows is one paint, not a hundred sweeps');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
