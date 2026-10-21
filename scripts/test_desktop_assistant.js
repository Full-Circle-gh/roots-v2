#!/usr/bin/env node
/**
 * The voice assistant on the computer (§495 rule 13) — the wiring.
 *
 *   node scripts/test_desktop_assistant.js
 *
 * The desktop has no Chromium probe of its own (the m-probe harness is the
 * phone's), so this file locks what can be locked without a browser:
 *   • the top bar carries the mic button, hidden until the module finds it
 *     may show, beside Search, with no data-cap tag (the tagged-controls rule
 *     is for the seven consequential controls, and the button's gate is the
 *     module's own: body.feat-assistant and can('assistant:use'));
 *   • the module is preloaded and loaded right after the product page (the
 *     keyboard file deliberately ends the page);
 *   • the module parses, calls only the two assistant routes plus whatever
 *     route a row names, and never names a table or a vendor;
 *   • every string it draws is bilingual as two data-lang-block spans, never
 *     glued, and every pair it uses is one the phone already ships;
 *   • the sheet reuses the palette's chrome (.gsearch-overlay / .gsearch-box /
 *     .gsearch-item), and its own classes have styles.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '32-assistant.js'), 'utf8');
const phone = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

console.log('\nThe top bar');
{
  const mic = html.match(/<button class="gsearch-trigger asst-mic" id="asst-mic"[^>]*>/);
  ok(!!mic, 'the mic button is there');
  ok(mic && / hidden /.test(mic[0]), 'hidden until the module shows it');
  ok(mic && !/data-cap=/.test(mic[0]), 'with no data-cap tag — the gate is the module\'s own');
  ok(html.indexOf('id="asst-mic"') < html.indexOf('id="gsearch-trigger"'), 'beside Search, before it');
  ok(/<link rel="preload" href="\/assets\/retail-admin\/32-assistant\.js" as="script">/.test(html), 'preloaded');
  const scripts = [...html.matchAll(/<script src="\/assets\/retail-admin\/(\d+)-[a-z-]+\.js"><\/script>/g)].map(m => m[1]);
  // 27-keyboard.js is deliberately the last script on the page; this one sits
  // right after the product page, before it.
  ok(scripts.indexOf('32') === scripts.indexOf('31') + 1 && scripts[scripts.length - 1] === '27', 'loaded right after the product page, before the keyboard file that ends the page');
}

console.log('\nThe module');
{
  let parses = true;
  try { new Function(js); } catch (e) { parses = false; console.log('      ' + e.message); }
  ok(parses, 'parses');
  ok(/window\.asstOpen = open;/.test(js), 'opens from the window, so the button and a keyboard can reach it');
  const routes = [...js.matchAll(/'(\/api\/[a-z0-9/_-]+)'/g)].map(m => m[1]);
  ok(routes.every(r => r.startsWith('/api/retail-admin/assistant/')), 'it names only the assistant\'s own routes; every other route comes from a row');
  ok(!/anthropic|claude|openai/i.test(js), 'no vendor is named');
  ok(!/\b(shop_listings|retail_orders|retail_store_stock)\b/.test(js), 'no table is named');
  ok(/data-lang-block="en"/.test(js) && /data-lang-block="cn"/.test(js), 'bilingual text rides as data-lang-block spans');
  ok(!/[A-Za-z] · [一-鿿]/.test(js.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'and is never glued with a middle dot in code');
}

console.log('\nThe strings are the phone\'s');
{
  const pairs = [...js.matchAll(/(?:bi|T)\('([^']+)', '([^']+)'\)/g)].map(m => [m[1], m[2]]);
  ok(pairs.length >= 15, `the module draws ${pairs.length} bilingual pairs`);
  const missing = pairs.filter(([en, cn]) => phone.indexOf(cn) === -1 && !/^\d/.test(cn));
  ok(missing.length === 0, 'every Chinese string the desktop shows is one the phone already ships' + (missing.length ? ' — missing: ' + missing.map(p => p[1]).join(' | ') : ''));
}

console.log('\nThe chrome');
{
  ok(/className = 'gsearch-overlay asst-overlay'/.test(js) && /class="gsearch-box asst-box"/.test(js), 'the palette\'s overlay and box');
  for (const cls of ['asst-mic', 'asst-box', 'asst-head', 'asst-chip', 'asst-micbtn', 'asst-tick', 'asst-ans', 'asst-eyebrow', 'asst-line', 'asst-foot', 'asst-stat']) {
    ok(new RegExp('\\.' + cls + '\\b').test(css), `.${cls} is styled`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
