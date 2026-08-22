#!/usr/bin/env node
/**
 * Membership, Top-up and Leaderboard — the three Roots Club screens, asserted
 * against 07-content-billing.js and the leaderboard config the server stores.
 *
 *   node scripts/test_mobile_club.js
 *
 * All three were making something up.
 *
 *   • Membership showed a fixed four-rung ladder — "Tree ≥ 2,000 pts" — whose
 *     thresholds were invented AND in the wrong unit. A tier threshold is
 *     LIFETIME SPEND in ¥. The ladder is editable (roots_club.tiers, with a
 *     points multiplier and a perks list per rung), so a shop that had renamed
 *     a tier or moved a threshold saw none of it.
 *   • Top-up led with "¥184,220 · 788 members" in 30px type. There is no
 *     endpoint that returns that; no fetch ever replaced it. And every
 *     transaction rendered as a green +¥ regardless of status, so a pending or
 *     failed top-up read as money in the till.
 *   • Leaderboard drew a board even when the board is switched off, called
 *     every value "pts" when the metric is configurable, and said nothing
 *     about reveal mode or seeded placeholder entries.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const TIERS = `[
  {key:'seed',   name_en:'Seed',   name_cn:'种子', threshold:0,    points_mult:1.0, perks_en:['5% off your first order','Member newsletter'], perks_cn:[]},
  {key:'sprout', name_en:'Sprout', name_cn:'幼苗', threshold:500,  points_mult:1.2, perks_en:[], perks_cn:[]},
  {key:'tree',   name_en:'Tree',   name_cn:'大树', threshold:5000, points_mult:2.0, perks_en:['20% off all orders','Birthday gift'], perks_cn:[]}
]`;
const ON = `state.sw=Object.assign({},state.sw,{membership:true});`;
const CLUB = ON + `state.tiersTried=true; state.tiers=${TIERS}; state.tierCounts={seed:186,sprout:44,tree:12}; APP.cmd('push','membership');`;

const TX = `[
  {id:9, nickname:'Chen Meiling', phone:'138****2841', amount:200, bonus_points:20, payment_method:'wechat', status:'success', created_at:'2026-08-22 09:00:00', paid_at:'2026-08-22 09:01:00'},
  {id:8, nickname:'Zhang Wei',    phone:'186****0092', amount:100, bonus_points:5,  payment_method:'wechat', status:'pending', created_at:'2026-08-22 08:00:00'},
  {id:7, nickname:'Wu Yaqi',      amount:50,  bonus_points:0, payment_method:'wechat', status:'failed', created_at:'2026-08-21 19:00:00'}
]`;
const TOPUPS = `state.tupTried=true; state.tup=${TX};
  state.tupPkgs=[{id:1,amount:200,bonus_points:20,title_en:'Starter',title_cn:'入门',is_active:1},
                 {id:2,amount:500,bonus_points:0,is_active:0}];
  APP.cmd('push','wallet');`;

const BOARD = `state.lbTried=true; state.lb={
  config:{enabled:true, title_en:'Top growers', title_cn:'排行榜', metric:'lifetime_spend', period:'month', top_n:20, reveal_mode:'first_char'},
  revealed_entries:[{rank:1,name:'C***',value:6240},{rank:2,name:'S***',value:4180}]};
  APP.cmd('push','leaderboard');`;

const CASES = [
  ['the ladder', CLUB, [
    ['the tiers are the shop\'s',        `txt('content').includes('Seed') && txt('content').includes('Tree')`],
    ['a threshold is LIFETIME SPEND',    `txt('content').includes('from ¥5,000 lifetime spend')`],
    ['and never points',                 `!txt('content').includes('≥ 2,000 pts') && !txt('content').includes('5,000 pts')`],
    ['the bottom rung says everyone starts there', `txt('content').includes('from ¥0 — everyone starts here')`],
    ['each rung carries its points multiplier',    `txt('content').includes('2× points') && txt('content').includes('1.2× points')`],
    ['a whole multiplier is not written 2.0',      `!txt('content').includes('2.0× points')`],
    ['live member counts',               `txt('content').includes('186 members') && txt('content').includes('12 members')`],
    ['perks are listed',                 `txt('content').includes('Birthday gift')`],
    ['a rung with no perks says so',     `txt('content').includes('No perks yet')`],
    ['rungs climb in order',             `txt('content').indexOf('Seed') < txt('content').indexOf('Tree')`],
    ['editing is named as a desktop job', `txt('content').includes('edited on desktop')`],
  ]],
  ['no ladder yet', ON + `state.tiersTried=true; state.tiers=[]; APP.cmd('push','membership');`, [
    ['says so',       `txt('content').includes('No tiers yet')`],
    ['invents none',  `!txt('content').includes('Sprout') && !txt('content').includes('Tree')`],
  ]],
  ['top-ups', TOPUPS, [
    ['the invented headline is gone',   `!txt('content').includes('184,220') && !txt('content').includes('788 members')`],
    ['and so is "Stored balance"',      `!txt('content').includes('Stored balance')`],
    ['who topped up',                   `txt('content').includes('Chen Meiling')`],
    ['their phone',                     `txt('content').includes('138****2841')`],
    ['the method',                      `txt('content').includes('wechat')`],
    ['bonus points where there are any', `txt('content').includes('+20 bonus points')`],
    ['a paid one reads Paid',           `txt('content').includes('Paid')`],
    ['a pending one reads Pending',     `txt('content').includes('Pending')`],
    ['a failed one reads Failed',       `txt('content').includes('Failed')`],
    ['only the paid one is a +amount',  `txt('content').split('+¥').length === 2`],
    ['pending work is surfaced at the top', `txt('content').includes('One top-up is waiting to be confirmed')`],
    ['the packages on offer are listed',    `txt('content').includes('Starter')`],
    ['an inactive package is not offered',  `!txt('content').includes('¥500')`],
  ]],
  ['finalizing asks first', TOPUPS + `APP.cmd('finalizeTopup',8);`, [
    ['it asks',                     `sheetText().includes('Mark this top-up successful?')`],
    ['naming the amount credited',  `sheetText().includes('¥100')`],
    ['and the bonus points',        `sheetText().includes('5 bonus points')`],
    ['and when to use it',          `sheetText().includes('callback did not')`],
    ['nothing has been sent yet',   `state.tupBusy === null`],
  ]],
  ['no top-ups yet', `state.tupTried=true; state.tup=[]; state.tupPkgs=[]; APP.cmd('push','wallet');`, [
    ['says so',            `txt('content').includes('No top-ups yet')`],
    ['and shows no money', `!txt('content').includes('184,220')`],
  ]],
  ['the board', BOARD, [
    ['it is named',                  `txt('content').includes('Top growers')`],
    ['and marked live',              `txt('content').includes('Live')`],
    ['the metric is stated',         `txt('content').includes('lifetime spend')`],
    ['the period too',               `txt('content').includes('past month')`],
    ['values are money, not "pts"',  `txt('content').includes('¥6,240') && !txt('content').includes('6,240 pts')`],
    ['ranks and names',              `txt('content').includes('C***')`],
    ['masking is explained',         `txt('content').includes('the way they appear below')`],
  ]],
  ['a board that is switched off', `state.lbTried=true; state.lb={config:{enabled:false,title_en:'Top growers',metric:'points_balance',period:'all',top_n:10,reveal_mode:'full',seed_enabled:true},revealed_entries:[{rank:1,name:'Real Person',value:900}]}; APP.cmd('push','leaderboard');`, [
    ['says it is off',                     `txt('content').includes('Off')`],
    ['and that customers cannot see it',   `txt('content').includes('customers cannot see it')`],
    ['seeded placeholders are flagged',    `txt('content').includes('Placeholder entries are switched on')`],
    ['a points metric reads pts',          `txt('content').includes('900 pts')`],
  ]],
  ['an empty board', `state.lbTried=true; state.lb={config:{enabled:true,title_en:'Top growers',metric:'orders_count',period:'week',top_n:5,reveal_mode:'full'},revealed_entries:[]}; APP.cmd('push','leaderboard');`, [
    ['says nobody is on it', `txt('content').includes('Nobody is on the board yet')`],
    ['and invents no names', `!txt('content').includes('Chen Meiling')`],
  ]],
];

run('roots club', CASES);
