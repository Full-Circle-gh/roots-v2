#!/usr/bin/env node
/**
 * Settings, the Setup guide and Social proof — asserted against
 * 02-settings-ops.js, 17-setup-guide.js and lib/features.js.
 *
 *   node scripts/test_mobile_settings.js
 *
 * Settings offered five feature switches. The desktop has eight. The three
 * missing ones were socialProof, quickStock and kitchenAdd — switches that
 * decide whether shoppers see bought-counts, whether shop staff can open the
 * phone stock app, and whether kitchen staff can log what they just made. None
 * of them could be reached from a phone at all. The phone also had no notion
 * of the platform ENTITLEMENT ceiling, so it would have drawn a switch for a
 * feature the tenant is not entitled to and written a preference nobody would
 * ever honour.
 *
 * The Setup guide had three controls that did nothing — every step row was a
 * button with a chevron wired to noop, and so was "Continue setup" — and it
 * flattened /setup's two lists into one, so the two OPTIONAL steps counted
 * against progress the server computes from the five required ones. It threw
 * away every per-step detail the endpoint returns: how many stores, how many
 * products, which payment method, delivery or pickup.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const SETUP = `state.setup={percent:60,requiredDone:3,requiredTotal:5,allDone:false,
  steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:128},
         {key:'payment',done:true,method:'both'},{key:'fulfillment',done:false,delivery:false,pickup:false},
         {key:'open',done:false}],
  optional:[{key:'wechat',done:false},{key:'brand',done:true}]};
  APP.cmd('push','setup');`;

const btnTexts = "[].slice.call(document.querySelectorAll('#content button')).map(function(b){return b.innerText.trim()})";

const CASES = [
  ['every feature switch the desktop has', `APP.cmd('push','settings');`, [
    ['membership',   `txt('content').includes('Membership & points')`],
    ['referrals, by the desktop\'s name', `txt('content').includes('Referral program')`],
    ['reviews',      `txt('content').includes('Product reviews')`],
    ['feedback',     `txt('content').includes('Customer feedback')`],
    ['SOCIAL PROOF — was missing', `txt('content').includes('Social proof')`],
    ['help / FAQ',   `txt('content').includes('Help / FAQ')`],
    ['QUICK STOCK — was missing',  `txt('content').includes('Quick Stock')`],
    ['ADD STOCK — was missing',    `txt('content').includes('Add Stock')`],
  ]],
  ['the entitlement ceiling is honoured', `state.ent={socialProof:false,kitchenAdd:false}; APP.cmd('push','settings');`, [
    ['a feature the tenant cannot have carries no switch', `!txt('content').includes('Social proof')`],
    ['nor does the other one',                             `!txt('content').includes('Add Stock')`],
    ['the entitled ones are still there',                  `txt('content').includes('Quick Stock') && txt('content').includes('Product reviews')`],
  ]],
  ['a switched-off feature says what it costs',
   `state.cfg=Object.assign({},state.cfg,{features:{quickStock:false}}); APP.cmd('push','settings');`, [
    ['the consequence is spelled out', `txt('content').includes('staff open /stock and get a closed screen')`],
    ['and only for the off one',       `!txt('content').includes('no tiers and no points')`],
  ]],
  ['no dead chevrons in Settings', `APP.cmd('push','settings');`, [
    // Every row that shows a chevron must go somewhere. "Store profile" used to
    // draw one and do nothing at all.
    ['store profile says where it is edited', `txt('content').includes('on desktop')`],
    ['sign out is offered',                   `${btnTexts}.some(function(t){return t==='Sign out'})`],
  ]],
  ['the setup guide reports', SETUP, [
    ['progress is the server\'s',      `txt('content').includes('60%')`],
    ['and counts required steps only', `txt('content').includes('2 left')`],
    ['the next step is called out',    `txt('content').includes('Next: Set up delivery or pickup')`],
    ['how many stores',                `txt('content').includes('2 stores')`],
    ['how many products',              `txt('content').includes('128 products')`],
    ['which payment methods',          `txt('content').includes('WeChat Pay and Alipay')`],
    ['optional steps are separated',   `txt('content').includes('Optional')`],
    ['and said not to gate opening',   `txt('content').includes('do not gate opening')`],
    ['where the work happens',         `txt('content').includes('wizard on desktop')`],
  ]],
  ['and offers nothing it cannot do', SETUP, [
    // Three controls used to sit here wired to noop: every step row, and a
    // "Continue setup" call to action.
    ['no Continue setup button', `!${btnTexts}.some(function(t){return t.indexOf('Continue setup')>=0})`],
    ['no buttons at all in the step list',
     "document.querySelectorAll('#content .list button').length === 0"],
  ]],
  ['a finished setup', `state.setup={percent:100,requiredDone:5,requiredTotal:5,allDone:true,
     steps:[{key:'store',done:true,count:2},{key:'products',done:true,count:9},{key:'payment',done:true,method:'alipay'},
            {key:'fulfillment',done:true,pickup:true},{key:'open',done:true}],optional:[]};
     APP.cmd('push','setup');`, [
    ['says the store is open',   `txt('content').includes('Your store is open')`],
    ['no "left" count',          `!txt('content').includes('left')`],
    ['no next step',             `!txt('content').includes('Next:')`],
    ['pickup-only is named',     `txt('content').includes('Pickup only')`],
  ]],
  ['social proof states what it is doing', `APP.cmd('push','social');`, [
    ['on, and what shoppers see', `txt('content').includes('Showing recent buyers') && txt('content').includes('SOLD badge')`],
  ]],
  ['social proof switched off', `state.cfg=Object.assign({},state.cfg,{features:{socialProof:false}}); APP.cmd('push','social');`, [
    ['says it is off',            `txt('content').includes('Switched off')`],
    ['and what is not shown',     `txt('content').includes('are shown')`],
  ]],
];

run('settings', CASES);
