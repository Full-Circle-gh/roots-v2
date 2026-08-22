#!/usr/bin/env node
/**
 * The phone's Stock activity ledger, asserted against 13-activity.js.
 *
 *   node scripts/test_mobile_activity.js
 *
 * What it was: five rows hard-coded into DB.activity — "Organic carrots · Order
 * RT-…047 · sold · −4" and four friends — overwritten by a live fetch only
 * `if (rows.length)`. A ledger is opened precisely on the days when you are not
 * sure anything moved, and on exactly those days it showed five movements that
 * had never happened. It also threw away everything a ledger is FOR: the time,
 * the store, the balance the move left behind, and who made it.
 *
 * The assertions below are about what a stock ledger has to be able to answer:
 * what moved, when, through which channel, at which store, to what balance, and
 * on whose say-so — plus the two read-first cards, and the honest empty.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// One mini-app sale, one manual recount that landed on zero, one Meituan sale.
// The summary is the server's UNFILTERED tally, which is what the channel
// counts are drawn from — they must not move when you switch channel.
const ENVELOPE = `{
  total: 3,
  rows: [
    {id:3, ts_local:'2026-08-22 09:12:00', source:'miniapp', store:'Tianhe', sku:'OM-1L', product:'Oat milk 1L', delta:-2, balance_after:10},
    {id:2, ts_local:'2026-08-22 08:40:00', source:'meituan_tianhe', store:'Tianhe', sku:'SD-01', product:'Sourdough', delta:-1, balance_after:4},
    {id:1, ts_local:'2026-08-22 08:02:00', source:'manual', store:'Tianhe', sku:'CR-01', product:'Carrots', delta:-6, balance_after:0, actor_label:'Mei', note:'binned, frost damage'}
  ],
  summary: [
    {source:'miniapp', events:1, units_out:2, units_in:0},
    {source:'meituan_tianhe', events:1, units_out:1, units_in:0},
    {source:'manual', events:1, units_out:6, units_in:0}
  ],
  digest: {
    zeroed: [{ts_local:'2026-08-22 08:02:00', product:'Carrots', sku:'CR-01', store:'Tianhe'}],
    big: [{ts_local:'2026-08-22 08:02:00', source:'manual', product:'Carrots', sku:'CR-01', delta:-6, actor_label:'Mei'}],
    zeroed_total: 1
  }
}`;

const SEEDED = `state.actTried=true; state.act=${ENVELOPE}; APP.cmd('push','activity');`;
const QUIET = `state.actTried=true; state.act={total:0,rows:[],summary:[],digest:{zeroed:[],big:[],zeroed_total:0}}; APP.cmd('push','activity');`;

const CASES = [
  ['the ledger', SEEDED, [
    ['what moved',              `txt('content').includes('Oat milk 1L')`],
    ['when it moved',           `txt('content').includes('09:12')`],
    ['through which channel',   `txt('content').includes('Mini-app')`],
    ['at which store',          `txt('content').includes('Tianhe')`],
    ['by how much',             `txt('content').includes('−2')`],
    ['to what balance',         `txt('content').includes('10')`],
    ['on whose say-so',         `txt('content').includes('Mei')`],
    ['and why',                 `txt('content').includes('binned, frost damage')`],
    ['Meituan is named per storefront', `txt('content').includes('Meituan Tianhe')`],
  ]],
  ['the caption and the channel chips', SEEDED, [
    ['the view is named',        `txt('content').includes('All channels')`],
    ['events are counted',       `/3\\s+events/.test(txt('content'))`],
    ['units out and in',         `/9\\s+out/.test(txt('content')) && /0\\s+in/.test(txt('content'))`],
    ['every channel is a chip',  `txt('content').includes('Manual') && txt('content').includes('Gzgrocery')`],
    ['a channel with no events is still listed, at zero',
     "[].slice.call(document.querySelectorAll('#content .chip')).some(function(b){return b.innerText.indexOf('Gzgrocery')>=0 && /\\b0\\b/.test(b.innerText)})"],
    ['and one with events carries its count',
     "[].slice.call(document.querySelectorAll('#content .chip')).some(function(b){return b.innerText.indexOf('Manual')>=0 && /\\b1\\b/.test(b.innerText)})"],
  ]],
  ['switching channel keeps the counts still', SEEDED + `APP.cmd('actSource','manual'); state.act=${ENVELOPE}; render();`, [
    ['the caption follows the channel', `txt('content').includes('Manual')`],
    ['its own units are stated',        `/6\\s+out/.test(txt('content'))`],
    ['the grand tally is not shown as this channel', `!/9\\s+out/.test(txt('content'))`],
  ]],
  ['the read-first cards', SEEDED, [
    ['what hit zero',            `txt('content').includes('Hit zero') && txt('content').includes('Carrots')`],
    ['the biggest moves',        `txt('content').includes('Big moves')`],
    ['a manual move is credited to the person', `txt('content').includes('Mei')`],
  ]],
  ['a quiet range', QUIET, [
    ['says nothing moved',       `txt('content').includes('Nothing moved in this range')`],
    ['invents no rows',          `!txt('content').includes('Organic carrots') && !txt('content').includes('Oat milk')`],
    ['says nothing hit zero',    `txt('content').includes('Nothing hit zero')`],
    ['and no unusual moves',     `txt('content').includes('No unusual moves')`],
    ['zero events, honestly',    `/0\\s+events/.test(txt('content'))`],
  ]],
  ['the range switch', QUIET, [
    ['today is the default, same as the endpoint', `state.actRange === 'today'`],
    ['and the other two are offered',              `txt('content').includes('7 days') && txt('content').includes('30 days')`],
  ]],
  ['it would not load', `state.actTried=true; state.actErr='Could not load stock activity.'; APP.cmd('push','activity');`, [
    ['says so',                 `txt('content').includes('Could not load stock activity')`],
    ['not "nothing moved"',     `!txt('content').includes('Nothing moved in this range')`],
    ['and the range switch survives', `txt('content').includes('7 days')`],
  ]],
  ['more to load', `state.actTried=true; state.act={total:120,rows:[{id:1,ts_local:'2026-08-22 09:00:00',source:'miniapp',store:'T',product:'X',delta:-1,balance_after:3}],summary:[{source:'miniapp',events:120,units_out:120,units_in:0}],digest:{zeroed:[],big:[],zeroed_total:0}}; APP.cmd('push','activity');`, [
    ['offers more',             `txt('content').includes('Show more')`],
    ['and says how far in you are', `txt('content').includes('1/120')`],
  ]],
];

run('stock activity', CASES);
