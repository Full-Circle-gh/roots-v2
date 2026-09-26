#!/usr/bin/env node
/**
 * Home's greeting on the phone, held to the desktop's.
 *
 *   node scripts/test_mobile_greeting.js
 *
 * The phone said "Good evening" to everyone while the desktop said "Good
 * evening, Asher" — the phone had the name all along (state.me) and never used
 * it. The hour bands differed too: the phone called 2am evening and turned to
 * evening an hour later than the desktop. Now one rule, the desktop's:
 *
 *   • 05–12 morning · 12–17 afternoon · 17–23 evening · 23–05 "Still up?"
 *   • first name for a Latin name, the whole name for a Chinese one, and no
 *     name at all (not a placeholder) until the account has loaded
 *   • the name is escaped — it is typed by an admin and lands in markup
 *
 * And the desktop's "one observation" beside the date: said only when today
 * is genuinely ahead of the same weekday behind it, silent otherwise, and
 * never to a role that sees no money.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// The handset's hour, pinned. greetKey reads getHours() off a fresh Date.
const at = (h) => `Date.prototype.getHours=function(){ return ${h}; };`;
const home = (me, extra) => `state.me=${me}; state.pos='owner'; ${extra || ''}
  APP.cmd('tab','home'); render();`;
const head = `document.querySelector('#content h1').innerText`;
const status = `((document.getElementById('mHeadStatus')||{}).innerText||'')`;
const BASE = (o) => `state.liveBaseline=Object.assign({days:4, weekday:6, best_in_weeks:false,
  revenue:{delta:3}}, ${o});`;

const CASES = [
  ['evening, with a name', at(19) + home(`{name:'Asher Li'}`), [
    ['first name only', `${head}==='Good evening, Asher'`],
  ]],
  ['evening starts at 17, as on the desktop', at(17) + home(`{name:'Asher'}`), [
    ['not afternoon', `${head}==='Good evening, Asher'`],
  ]],
  ['past 23 is late, not evening', at(2) + home(`{name:'Asher'}`), [
    ['still up', `${head}==='Still up, Asher?'`],
  ]],
  ['before the account loads', at(14) + home('null'), [
    ['no name, no placeholder', `${head}==='Good afternoon'`],
  ]],
  ['a Chinese name is kept whole', at(9) + home(`{name:'李明'}`, `LANG='zh'; state.lang='zh';`), [
    ['whole name', `${head}==='早上好，李明'`],
  ]],
  ['a name is text, not markup', at(9) + home(`{name:'<i>x</i>'}`), [
    ['shown literally', `${head}==='Good morning, <i>x</i>'`],
  ]],
  ['best same weekday in weeks', at(19) + home(`{name:'Asher'}`, BASE(`{best_in_weeks:true, revenue:{delta:22}}`)), [
    ['says so', `${status}.includes('Best Saturday in 4 weeks so far.')`],
    ['the rarer fact wins', `!${status}.includes('Ahead of')`],
  ]],
  ['clearly ahead of a typical one', at(19) + home(`{name:'Asher'}`, BASE(`{revenue:{delta:18}}`)), [
    ['says so', `${status}.includes('Ahead of a typical Saturday at this point.')`],
  ]],
  ['an ordinary day', at(19) + home(`{name:'Asher'}`, BASE('{}')), [
    ['says nothing', `!${status}.includes('Best') && !${status}.includes('Ahead of')`],
  ]],
  ['a role that sees no money', at(19) + home(`{name:'Asher'}`, BASE(`{best_in_weeks:true}`) + `state.pos='warehouse';`), [
    ['is not told', `!${status}.includes('Best')`],
  ]],
];

run('home greeting', CASES);
