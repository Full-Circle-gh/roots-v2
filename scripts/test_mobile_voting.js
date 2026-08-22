#!/usr/bin/env node
/**
 * The phone's Voting screen, asserted against 10-extras.js.
 *
 *   node scripts/test_mobile_voting.js
 *
 * The phone drew ONE bar per poll: the leader's share and the leader's name.
 * A poll is a split. "62% · Leading: Matcha oat" says nothing about whether
 * second place was 38% or 4%, and the other options existed nowhere on this
 * device. It also dropped the reward points, the closing time, the featured
 * flag, and the fact that a draft is invisible to customers — and it carried
 * two invented polls in its source for whenever /polls came back empty.
 *
 * The one that matters most: display_min_total. It is a display-only floor —
 * customers are shown at least N votes whatever the real count is. An operator
 * reading a poll on their phone needs to know the number their customers see
 * is not the number in the ledger.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const POLLS = `[
  {id:1, question_en:'Next flavour', question_cn:'下款口味', status:'open', reward_points:5,
   is_featured:1, closes_at:'2026-08-30 12:00:00', total_votes:312,
   options:[{id:11,label_en:'Matcha oat',votes:193},{id:12,label_en:'Black sesame',votes:104},{id:13,label_en:'Yuzu',votes:15}]},
  {id:2, question_en:'Store hours', status:'draft', display_min_total:50, reward_points:0,
   options:[{id:21,label_en:'Until 21:00',votes:0},{id:22,label_en:'Until 22:00',votes:0}]},
  {id:3, question_en:'Bag design', status:'closed', winner_option_id:31, total_votes:80,
   options:[{id:31,label_en:'Kraft',votes:60},{id:32,label_en:'Canvas',votes:20}]}
]`;
const SEEDED = `state.pollsTried=true; state.polls=${POLLS}; APP.cmd('push','voting');`;

const CASES = [
  ['the list', SEEDED, [
    ['the polls are the server\'s',   `txt('content').includes('Next flavour')`],
    ['status is stated',              `txt('content').includes('Live') && txt('content').includes('Draft') && txt('content').includes('Closed')`],
    ['options are counted',           `txt('content').includes('3 options')`],
    ['votes are counted',             `txt('content').includes('312 votes')`],
    ['the reward is stated',          `txt('content').includes('+5 pts')`],
    ['and the closing date',          `txt('content').includes('closes')`],
    ['featured is marked',            `txt('content').includes('Featured')`],
    ['a draft says customers cannot see it', `txt('content').includes('Customers cannot see a draft')`],
    ['results are not shown until asked for', `!txt('content').includes('193 votes')`],
  ]],
  ['the whole split, not just the leader', SEEDED + `APP.cmd('pollOpen',1);`, [
    ['first place',        `txt('content').includes('Matcha oat')`],
    ['SECOND place',       `txt('content').includes('Black sesame')`],
    ['and last place',     `txt('content').includes('Yuzu')`],
    ['each with its count', `txt('content').includes('193 votes') && txt('content').includes('104 votes')`],
    ['each with its share', `txt('content').includes('62%') && txt('content').includes('33%')`],
    ['ordered by votes',    `txt('content').indexOf('Matcha oat') < txt('content').indexOf('Yuzu')`],
  ]],
  ['a decided poll marks its winner', SEEDED + `APP.cmd('pollOpen',3);`, [
    ['the winner is named as such', `txt('content').includes('winner')`],
    ['and the loser is still shown', `txt('content').includes('Canvas')`],
  ]],
  ['the display floor is surfaced', SEEDED, [
    ['it says customers see a floor', `txt('content').includes('Customers are shown at least 50 votes')`],
  ]],
  ['the action follows the status', SEEDED, [
    // Scoped to the buttons: "Open" is a substring of "Reopen" and "Close" of
    // "Closed", so a page-wide indexOf would pass on the wrong card.
    ['a draft offers Open',
     "[].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.trim()==='Open'})"],
    ['a live one offers Close',
     "[].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.trim()==='Close'})"],
    ['a closed one offers Reopen',
     "[].slice.call(document.querySelectorAll('#content button')).some(function(b){return b.innerText.trim()==='Reopen'})"],
  ]],
  ['no polls', `state.pollsTried=true; state.polls=[]; APP.cmd('push','voting');`, [
    ['says so',      `txt('content').includes('No polls yet')`],
    ['invents none', `!txt('content').includes('Next flavour') && !txt('content').includes('Matcha')`],
  ]],
  ['it would not load', `state.pollsTried=true; state.pollsErr='Could not load the polls.'; APP.cmd('push','voting');`, [
    ['says so',       `txt('content').includes('Could not load the polls')`],
    ['not "none yet"', `!txt('content').includes('No polls yet')`],
  ]],
];

run('voting', CASES);
