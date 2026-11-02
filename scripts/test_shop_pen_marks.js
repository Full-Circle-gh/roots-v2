#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BLOCKS = fs.readFileSync(path.join(ROOT, 'public/shop/blocks.js'), 'utf8');

const win = { console, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
win.window = win;
win.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: {},
};
vm.createContext(win);
vm.runInContext(BLOCKS, win);
const SB = win.ShopBlocks;

SB.setContext({ lang: 'en', products: [], categories: [], flashSales: [], config: {} });

const subtitle =
  'Roots is a <<PEN>>100% plant-based café and fresh-food kitchen in Guangzhou, since 2017<</PEN>>. ' +
  'Grab-and-go yogurts, salads, wraps, soups and dips made fresh in our own kitchen, plus coffee, fresh juice and kombucha. ' +
  '<<PEN>>No additives, no preservatives, no refined sugar.<</PEN>> We took the junk out. You\'re welcome.';

const html = SB.render([{
  id: 'intro',
  type: 'hero_banner',
  view: 'split',
  headline_en: 'Landed in Guangzhou? Lunch is sorted.',
  subtitle_en: subtitle,
  image_url: '/assets/brand/welcome-roots.jpg',
  panel_bg_color: 'oat-milk',
  panel_fg_color: 'ink',
}]);

assert.match(html, /sb-pen-mark/);
assert.match(html, /100% plant-based café and fresh-food kitchen in Guangzhou, since 2017/);
assert.match(html, /No additives, no preservatives, no refined sugar\./);
assert.doesNotMatch(html, /<<PEN>>/);
assert.match(html, /Grab-and-go yogurts/);

console.log('test_shop_pen_marks: ok');
