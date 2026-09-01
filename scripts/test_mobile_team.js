#!/usr/bin/env node
/**
 * Team — who has access, and switching one person off.
 *
 *   node scripts/test_mobile_team.js
 *
 * This is the one desktop tab no parity pass had ever looked at: it appears
 * nowhere in docs/tacet-mobile-parity.md, not even as a decided-against row.
 * Inviting somebody and setting a per-capability permission matrix is
 * authoring and stays on the desktop; what belongs on a phone is the roster and
 * the emergency switch — a staffer walks out, a phone goes missing.
 *
 * The two rules that make that safe are the SERVER's (routes/backend-team.js):
 * you cannot deactivate yourself, and you cannot leave the shop with no active
 * owner. The screen states both before a thumb finds them as a 400, so most of
 * what is asserted here is that the row REFUSES to be a control when it should.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// An owner (who is also the signed-in operator), a store-pinned manager, an
// invite that never landed, and somebody already switched off.
//
// state.roles is part of the roster payload now: roles are per-tenant records,
// so this screen names a role the way the shop does instead of carrying its own
// map of the nine that used to ship. A fixture without it is a shop whose role
// records are missing, which the screen handles by showing the raw key.
const TEAM = `state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'},{id:2,name_en:'Panyu store',name_cn:'番禺店'}];
  state.roles=[{key:'owner',nameEn:'Owner',nameCn:'负责人',storePinned:false},
    {key:'store_manager',nameEn:'Store manager',nameCn:'店长',storePinned:true},
    {key:'warehouse',nameEn:'Warehouse',nameCn:'仓库',storePinned:false},
    {key:'staff',nameEn:'Shop floor',nameCn:'门店',storePinned:false}];
  state.teamTried=true; state.teamEnforce=false; state.team=[
  {id:1,username:'mei',displayName:'Mei Chen',role:'owner',retailStoreId:null,isActive:true,isSelf:true,lastLogin:'2026-08-23 08:10:00'},
  {id:2,username:'lin',displayName:'Lin Hao',role:'store_manager',retailStoreId:1,isActive:true,isSelf:false,lastLogin:'2026-08-22 19:40:00'},
  {id:3,username:'wu',displayName:'Wu Jia',role:'warehouse',retailStoreId:2,isActive:true,isSelf:false,lastLogin:null},
  {id:4,username:'old',displayName:'Zhao Qing',role:'staff',retailStoreId:null,isActive:false,isSelf:false,lastLogin:'2026-06-02 11:00:00'}];`;
// Who may switch somebody off is the CAPABILITY the server checks, not two role
// names — a tenant can rename or delete the roles that used to be hardcoded here.
const AS_OWNER = `state.me={name:'Mei Chen',role:'owner'}; state.caps=['team:view','team:manage'];`;
const AS_STAFF = `state.me={name:'Lin Hao',role:'store_manager'}; state.caps=['orders:view','team:view'];`;

const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{}})}}); };`;
const sent = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const body = (frag) => `window.__sent.some(function(r){return (r.body||'').indexOf(${JSON.stringify(frag)})>=0})`;
const method = (m) => `window.__sent.some(function(r){return r.m===${JSON.stringify(m)}})`;

const CASES = [
  ['the roster is the server\'s', AS_OWNER + TEAM + `APP.cmd('push','team');`, [
    ['everyone is listed',        `['Mei Chen','Lin Hao','Wu Jia','Zhao Qing'].every(function(n){return txt('content').includes(n)})`],
    ['each with their role',      `txt('content').includes('Store manager') && txt('content').includes('Warehouse')`],
    ['a pinned role names its store', `txt('content').includes('Tianhe store') && txt('content').includes('Panyu store')`],
    // An invite that was sent and never used looks exactly like a working
    // account unless the roster says so.
    ['an invite that never landed says so', `txt('content').includes('never signed in')`],
    ['who can sign in, and who cannot',     `txt('content').includes('Can sign in') && txt('content').includes('Off')`],
    ['the head counts both',                `txt('content').includes('3 people with access · 1 switched off')`],
    // Roles that shape the view but stop nothing at the server is a fact with a
    // consequence, and the desktop is where that switch lives.
    ['unenforced roles are called out',     `txt('content').includes('not enforcing them yet')`],
    ['inviting is named as desktop work, and says where roles are shaped',
      `txt('content').includes('set on desktop') && txt('content').includes('Settings → Team → Roles')`],
  ]],

  // ── The two rules, stated rather than discovered ────────────────────────
  ['the rules are on the row, before the tap', AS_OWNER + TEAM + `APP.cmd('push','team');`, [
    ['you are marked as yourself',   `txt('content').includes('this is you')`],
  ]],
  // The other rule needs somebody else's roster: an admin looking at a shop
  // whose single owner is not them.
  ['the lone owner is marked too', `state.me={name:'Ana',role:'admin'};
    state.teamTried=true; state.team=[
      {id:9,username:'mei',displayName:'Mei Chen',role:'owner',isActive:true,isSelf:false,lastLogin:null},
      {id:8,username:'ana',displayName:'Ana Wu',role:'admin',isActive:true,isSelf:true,lastLogin:null}];
    APP.cmd('push','team');`, [
    ['said on the row',   `txt('content').includes('the only owner')`],
    ['and not a control', `document.querySelectorAll('#content .list button').length === 0`],
  ]],
  ['neither of them is a control', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamToggle',1);`, [
    // Mei is both self AND the only owner. Two reasons, one row, no action.
    ['tapping yourself does nothing', `!sheetText().includes('Switch') && !${sent('/team/')}`],
  ]],

  ['switching somebody off asks first', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamToggle',2);`, [
    ['it names them',            `sheetText().includes('Switch Lin Hao off?')`],
    ['says they cannot sign in anywhere', `sheetText().includes('cannot sign in on any device')`],
    // The first worry about deactivating somebody mid-shift is whether their
    // work goes with them. It does not, and the confirm says so.
    ['and that their work stays', `sheetText().includes('stays as it is, under their name')`],
    ['nothing sent yet',          `!${sent('/team/')}`],
  ]],
  ['confirming writes it', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamToggle',2); APP.cmd('askRun');`, [
    ['to that person\'s record', sent('/api/backend/team/2')],
    // Not /api/retail-admin/api/backend/... — apiURL takes an absolute path as
    // given, which is the whole reason this screen can reach the roster at all.
    ['at the backend path, unprefixed', `!${sent('/retail-admin/api/')}`],
    ['as a PUT',                 method('PUT')],
    ['is_active:false, not undefined', body('"is_active":false')],
  ]],
  ['and back on again', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamToggle',4); APP.cmd('askRun');`, [
    ['asks the other way',   `true`],
    ['with is_active:true',  body('"is_active":true')],
  ]],

  // ── Who may do it ──────────────────────────────────────────────────────
  // requireCap('team:manage') is what the server checks. Drawing an action a
  // store manager cannot use is the kind of promise this app has spent a long
  // time removing.
  ['an operator without team:manage sees the roster and no switch', STUB + AS_STAFF + TEAM + `APP.cmd('push','team'); APP.cmd('teamToggle',2);`, [
    ['the roster is still readable', `txt('content').includes('Lin Hao') && txt('content').includes('Wu Jia')`],
    ['it says what is missing',      `txt('content').includes('needs permission to manage the team')`],
    ['and the tap does nothing',     `!${sent('/team/')}`],
  ]],

  ['a shop of one', AS_OWNER + `state.teamTried=true; state.team=[]; APP.cmd('push','team');`, [
    ['says so',          `txt('content').includes('Nobody else yet')`],
    ['and says where people come from', `txt('content').includes('invited on desktop')`],
  ]],
  ['the roster would not load', AS_OWNER + `state.teamTried=true; state.teamErr='Could not load the team.'; APP.cmd('push','team');`, [
    ['says so',            `txt('content').includes('Could not load the team')`],
    ['rather than empty',  `!txt('content').includes('Nobody else yet')`],
  ]],
];

run('team', CASES);
