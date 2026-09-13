#!/usr/bin/env node
/**
 * Permissions, from a phone — the four screens §112 put under Settings → Team.
 *
 *   node scripts/test_mobile_permissions.js
 *
 * docs/tacet-mobile-parity.md used to rule that inviting somebody, assigning a
 * role and setting a per-capability matrix was authoring and stayed on the
 * desktop. §112 reverses that: a shop run from a phone cannot have the question
 * of who may refund an order answered somewhere else. What this suite asserts
 * is the half that decision does NOT change — that every screen writes to the
 * route the desktop writes to, with the body that route expects, and that the
 * rules the server keeps are stated on the phone before a thumb finds them as
 * a 400.
 *
 * The roster and the emergency switch are scripts/test_mobile_team.js; this is
 * everything behind them.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./lib/m-probe');

// ── Static: the dashboard-default table exists twice, and must not drift ────
// The phone seeds the dashboard-card ticks for a role with no override yet from
// its own copy of what each board shows today. The desktop has the same table
// (RL_DASH_LAYOUT_DEFAULT) and the CSS it describes is a third place. Two
// copies that disagree mean the same tap saves a different board depending on
// which device made it — which is exactly the class of bug the phone's own
// comment promises this check will catch.
{
  const grab = (file, name) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const i = src.indexOf(`const ${name}=`) >= 0 ? src.indexOf(`const ${name}=`) : src.indexOf(`const ${name} = `);
    if (i < 0) { console.error(`FAIL static — ${name} is gone from ${file}`); process.exit(1); }
    const open = src.indexOf('{', i);
    const close = src.indexOf('};', open);
    return new Function(`return ${src.slice(open, close + 1)}`)();
  };
  const phone = grab('public/m.html', 'TM_DASH_DEFAULT');
  const desk = grab('public/retail-admin/02-settings-ops.js', 'RL_DASH_LAYOUT_DEFAULT');
  const keys = [...new Set([...Object.keys(phone), ...Object.keys(desk)])].sort();
  const bad = keys.filter((k) => {
    const a = phone[k] || [], b = desk[k] || [];
    return a.length !== b.length || a.some((x) => !b.includes(x));
  });
  if (bad.length) {
    for (const k of bad) console.error(`FAIL static — dashboard default for "${k}" differs between the phone and the desktop`);
    console.error('\nThe same role would open on a different board depending on which device saved it.');
    process.exit(1);
  }
  console.log(`  ✓ dashboard defaults match the desktop — ${keys.length} boards`);
}

// ── The fixture: a shop, its roles, and the catalogue behind them ──────────
const CAPS = `var CAPS=[
  {key:'dashboard:view',group:'run',section:'dashboard',labelEn:'View dashboard',labelCn:'查看概览'},
  {key:'orders:view',group:'run',section:'orders',labelEn:'See orders',labelCn:'查看订单'},
  {key:'orders:refund',group:'run',section:'orders',labelEn:'Refund an order',labelCn:'订单退款',money:'moves'},
  {key:'products:edit',group:'sell',section:'products',labelEn:'Edit products',labelCn:'编辑产品'}];`;

const ROLES_PAYLOAD = `{success:true,canEdit:true,layouts:['default','warehouse'],
  dashCards:['needs','recap','orders'],rbacEnforce:true,
  roles:[
    {key:'owner',nameEn:'Owner',nameCn:'负责人',isFixed:true,people:1,capCount:4,capTotal:4,caps:[],moneyMoves:1,moneyShows:0},
    {key:'store_manager',nameEn:'Store manager',nameCn:'店长',descEn:'Runs one shop',descCn:'负责一家门店',
     isFixed:false,people:2,exceptions:1,capCount:2,capTotal:4,caps:['dashboard:view','orders:view'],
     layout:'default',stockAppOnly:false,dashboardCards:null,storePinned:true,moneyMoves:0,moneyShows:0},
    {key:'warehouse',nameEn:'Warehouse',nameCn:'仓库',isFixed:false,people:0,exceptions:0,capCount:1,capTotal:4,
     caps:['orders:view'],layout:'warehouse',stockAppOnly:false,dashboardCards:null,moneyMoves:0,moneyShows:0}]}`;

const PERMS_PAYLOAD = `{success:true,role:'store_manager',roleName:{en:'Store manager',cn:'店长'},
  isOwner:false,isSelf:false,
  presetCaps:['dashboard:view','orders:view'],
  effective:['dashboard:view','orders:view','products:edit'],
  grants:['products:edit'],revokes:[],scopeAll:false,storeIds:[1]}`;

// Every write this suite makes is recorded, and every read is answered with the
// shape the real route answers with — api() unwraps `data` when it is there and
// hands the whole body back when it is not, which is what these routes do.
const STUB = `window.__sent=[];${CAPS}
  window.__reply=function(u){
    if(u.indexOf('/api/backend/capabilities')>=0) return {success:true,capabilities:CAPS,
      groups:['run','sell'],
      groupNames:{run:['Run the shop','日常运营'],sell:['Sell','销售']},
      sections:{dashboard:['Dashboard','概览'],orders:['Orders','订单'],products:['Products','产品']},
      moneyNotes:{'orders:refund':['Money leaves the shop.','资金流出店铺。']}};
    if(u.indexOf('/permissions')>=0) return ${PERMS_PAYLOAD};
    if(u.indexOf('/api/backend/roles')>=0) return ${ROLES_PAYLOAD};
    if(u.indexOf('/api/backend/team')>=0) return {success:true,hasCustomPerms:true,scopeAll:false,
      role:{key:'bookkeeper',nameEn:'Bookkeeper',nameCn:'会计'}};
    return {success:true,data:{}};
  };
  window.fetch=function(u,o){ window.__sent.push({u:String(u),m:(o&&o.method)||'GET',body:(o&&o.body)||null});
    var j=window.__reply(String(u));
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(j)}}); };`;

const TEAM = `state.stores=[{id:1,name_en:'Tianhe store',name_cn:'天河店'},{id:2,name_en:'Panyu store',name_cn:'番禺店'}];
  state.roles=[{key:'owner',nameEn:'Owner',nameCn:'负责人',storePinned:false},
    {key:'store_manager',nameEn:'Store manager',nameCn:'店长',descEn:'Runs one shop',descCn:'负责一家门店',storePinned:true},
    {key:'warehouse',nameEn:'Warehouse',nameCn:'仓库',storePinned:false}];
  state.teamTried=true; state.teamEnforce=false; state.team=[
  {id:1,username:'mei',displayName:'Mei Chen',role:'owner',isActive:true,isSelf:true,lastLogin:'2026-08-23 08:10:00'},
  {id:2,username:'lin',displayName:'Lin Hao',role:'store_manager',retailStoreId:1,isActive:true,isSelf:false,
   hasCustomPerms:true,scopeAll:false,lastLogin:'2026-08-22 19:40:00'},
  {id:3,username:'wu',displayName:'Wu Jia',role:'warehouse',isActive:true,isSelf:false,lastLogin:null}];`;

const AS_OWNER = `state.me={name:'Mei Chen',role:'owner'}; state.caps=['team:view','team:manage','team:permissions'];`;
/* WHO IS SIGNED IN IS THE ROSTER'S OWN isSelf ROW, not state.me — that is what
   the screen reads, because the roster is where the tenant says what somebody
   IS. A fixture whose caps belong to one person and whose isSelf flag belongs
   to another is a shop that cannot exist, and it would let a capability check
   pass for the wrong reason. These two put the flag where the caps are. */
const SELF_ANA = `state.team[0].isSelf=false;
  state.team.push({id:4,username:'ana',displayName:'Ana Wu',role:'admin',isActive:true,isSelf:true,lastLogin:null});`;
const SELF_LIN = `state.team[0].isSelf=false; state.team[1].isSelf=true;`;
// Somebody who may add a person but not decide what anyone reaches. The server
// gates those on two different capabilities, so the phone has to as well.
const AS_MANAGER = `state.me={name:'Ana',role:'admin'}; state.caps=['team:view','team:manage'];`;
const AS_STAFF = `state.me={name:'Lin Hao',role:'store_manager'}; state.caps=['orders:view','team:view'];`;

const sent = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const sentWith = (frag, m) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0 && r.m===${JSON.stringify(m)}})`;
const body = (frag) => `window.__sent.some(function(r){return (r.body||'').indexOf(${JSON.stringify(frag)})>=0})`;

const CASES = [
  // ── One person ────────────────────────────────────────────────────────
  ['the roster opens a person', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',2);`, [
    ['named, with the account they sign in with', `txt('content').includes('Lin Hao') && txt('content').includes('@lin')`],
    ['their role is on the screen',   `txt('content').includes('Store manager')`],
    ['access is a switch, not a signpost', `!!document.querySelector('[onclick*="teamToggle"]')`],
    ['the role can be changed here',  `!!document.querySelector('[onclick*="teamRole"]')`],
    ['a store-pinned role names its store', `txt('content').includes('Tianhe store')`],
    ['a new password can be set',     `txt('content').includes('Reset password')`],
    ['permissions have a door',       `!!document.querySelector('[onclick*="teamPerms"]')`],
    // The roster's own chip for somebody who stands apart from their role,
    // reused here rather than a second word for one idea.
    ['and it says this one stands apart from their role', `txt('content').includes('Custom')`],
  ]],
  ['the owner cannot be narrowed, and it says why', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',1);`, [
    ['no door to a matrix',  `!document.querySelector('[onclick*="teamPerms"]')`],
    ['the reason is stated', `txt('content').includes('Owner always has full access')`],
    ['and you are not offered your own switch', `!document.querySelector('[onclick*="teamToggle"]')`],
  ]],

  // ── Changing a role ───────────────────────────────────────────────────
  ['changing a role asks which', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamRole',2);`, [
    ['the shop\'s own roles are the options', `sheetText().includes('Warehouse') && sheetText().includes('Store manager')`],
    ['the one they hold is marked',           `sheetText().includes('now')`],
    ['nothing sent until one is picked',      `!${sentWith('/api/backend/team/2', 'PUT')}`],
  ]],
  ['picking one writes it', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamRole',2); APP.cmd('askRun','warehouse');`, [
    ['to that person\'s record, as a PUT', sentWith('/api/backend/team/2', 'PUT')],
    ['carrying the role',                  body('"role":"warehouse"')],
  ]],
  // A role that runs one store must arrive WITH one. The route 400s otherwise,
  // and meeting that after the picker has closed would be the phone hiding a
  // question it already knew about.
  ['a store-pinned role asks for the store in the same breath',
    STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',3); APP.cmd('teamRole',3); APP.cmd('askRun','store_manager');`, [
      ['a second question, not a 400', `sheetText().includes('Which store?')`],
      ['nothing written yet',          `!${sentWith('/api/backend/team/3', 'PUT')}`],
    ]],
  ['and answering it writes both',
    STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',3); APP.cmd('teamRole',3); APP.cmd('askRun','store_manager'); APP.cmd('askRun','2');`, [
      ['the role',  body('"role":"store_manager"')],
      ['the store', body('"retail_store_id":2')],
    ]],

  // ── A new password ────────────────────────────────────────────────────
  ['a short password is refused before it is sent', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPass',2);
     document.getElementById('ask-pw').value='short'; APP.cmd('askRun');`, [
      ['the sheet stays open with the rule', `sheetText().includes('at least 10 characters')`],
      ['and nothing was sent',               `!${sent('/password')}`],
    ]],
  ['a long enough one is set', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPass',2);
     document.getElementById('ask-pw').value='seventeen-letters'; APP.cmd('askRun');`, [
      ['posted to the password route', sentWith('/api/backend/team/2/password', 'POST')],
      ['as new_password',              body('"new_password":"seventeen-letters"')],
    ]],

  // ── The matrix ────────────────────────────────────────────────────────
  ['one person\'s permissions', STUB + AS_OWNER + TEAM + `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
    ['read from the server',      sent('/api/backend/team/2/permissions')],
    ['the catalogue too',         sent('/api/backend/capabilities')],
    ['the role is named, with how far this person stands from it',
      `txt('content').includes('Store manager') && txt('content').includes('exception')`],
    ['groups are collapsed, and say how much is on',
      `txt('content').includes('Run the shop') && txt('content').includes('of 3 on')`],
    ['a hundred toggles are not on the glass', `!txt('content').includes('Refund an order')`],
  ], { settle: 60 }],
  ['opening a group shows what is in it', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
      ['then the rows are there', `(function(){ APP.cmd('tmGroup','run'); return txt('content').includes('Refund an order'); })()`],
      ['money is marked',         `txt('content').includes('moves money')`],
    ], { settle: 60 }],
  ['an exception says which way it goes', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
      // products:edit is granted on top of the role; turning orders:view off
      // takes away something the role gives. One tint for both would say an
      // exception exists and refuse to say what it is.
      ['granted reads Added', `(function(){ APP.cmd('tmGroup','sell'); return txt('content').includes('Added'); })()`],
      ['taken away reads Removed', `(function(){ APP.cmd('tmGroup','run'); APP.cmd('permCap','orders:view'); return txt('content').includes('Removed'); })()`],
    ], { settle: 60 }],
  ['saving writes the whole on-list', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
      ['as a PUT to the permissions route', `(function(){ APP.cmd('permSave'); return ${sentWith('/api/backend/team/2/permissions', 'PUT')}; })()`],
      ['carrying the effective set',        body('"orders:view"')],
      ['and the store scope it was read with', `${body('"scope_all":0')} && ${body('"store_ids":[1]')}`],
    ], { settle: 60 }],
  ['limited to no stores at all is refused here', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamOpen',2); APP.cmd('teamPerms',2);`, [
      ['the screen says what to do', `(function(){ APP.cmd('permStore',1); APP.cmd('permSave');
         return txt('content').includes('at least one store'); })()`],
      ['and nothing was written',    `!${sentWith('/api/backend/team/2/permissions', 'PUT')}`],
    ], { settle: 60 }],

  // ── Adding somebody ───────────────────────────────────────────────────
  ['the invite form refuses what the route refuses', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamInvite');
     APP.cmd('invField','username','Lin Hao'); APP.cmd('invField','password','longenoughpw'); APP.cmd('invSubmit');`, [
      ['a username with a space is stopped here', `txt('content').includes('letters, numbers')`],
      ['nothing posted',                          `!${sentWith('/api/backend/team', 'POST')}`],
    ]],
  ['a short password is stopped too', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamInvite');
     APP.cmd('invField','username','linhao'); APP.cmd('invField','password','short'); APP.cmd('invSubmit');`, [
      ['with the route\'s own floor', `txt('content').includes('at least 10 characters')`],
      ['nothing posted',              `!${sentWith('/api/backend/team', 'POST')}`],
    ]],
  ['a complete one is posted', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamInvite'); APP.cmd('invRole'); APP.cmd('askRun','warehouse');
     APP.cmd('invField','name','Zhou Li'); APP.cmd('invField','username','zhouli');
     APP.cmd('invField','password','longenoughpw'); APP.cmd('invSubmit');`, [
      ['to the roster route',  sentWith('/api/backend/team', 'POST')],
      ['with the username',    body('"username":"zhouli"')],
      ['the role',             body('"role":"warehouse"')],
      ['and the password',     body('"password":"longenoughpw"')],
    ]],
  ['and the credentials come back on the glass, not in a toast', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamInvite'); APP.cmd('invRole'); APP.cmd('askRun','warehouse');
     APP.cmd('invField','username','zhouli'); APP.cmd('invField','password','longenoughpw'); APP.cmd('invSubmit');`, [
      ['the username', `txt('content').includes('zhouli')`],
      ['the password', `txt('content').includes('longenoughpw')`],
      ['and it says it cannot be read again later', `txt('content').includes('not stored anywhere you can read it again')`],
    ], { settle: 60 }],
  ['a suggested password clears the route\'s floor', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamInvite'); APP.cmd('invSuggest');`, [
      ['twelve characters', `state.tm.inv.password.length===12`],
      ['no ambiguous letters or digits', `!/[O0l1I]/.test(state.tm.inv.password)`],
    ]],

  // ── Roles ─────────────────────────────────────────────────────────────
  ['the roles tab is the same records the desktop edits', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['read from the roles route', sent('/api/backend/roles')],
      ['every role is listed',      `txt('content').includes('Store manager') && txt('content').includes('Warehouse')`],
      ['with how much of the list is on, and who holds it',
        `txt('content').includes('2 of 4 permissions') && txt('content').includes('2 people')`],
      ['the fixed one says it is everything', `txt('content').includes('Everything, always')`],
    ], { settle: 60 }],
  ['a role opens onto who it reaches, before anything editable', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['the blast radius is stated', `(function(){ APP.cmd('roleOpen','store_manager');
         return txt('content').includes('2 people hold this role'); })()`],
      ['and the exceptions that survive the edit', `txt('content').includes('设有例外权限')||txt('content').includes('has an exception')||txt('content').includes('have exceptions')`],
      ['the tally counts what is on', `txt('content').includes('of 4 on')`],
      ['the dashboard is one block',  `txt('content').includes('Has a dashboard') && txt('content').includes('Dashboard layout')`],
    ], { settle: 60 }],
  ['editing a role writes the whole record', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['saving is a PUT to that role', `(function(){ APP.cmd('roleOpen','store_manager');
         APP.cmd('tmGroup','run'); APP.cmd('roleCap','orders:refund'); APP.cmd('roleSave');
         return ${sentWith('/api/backend/roles/store_manager', 'PUT')}; })()`],
      ['carrying the capability just added', body('"orders:refund"')],
      ['and the dashboard field, so an unset one stays unset', body('"dashboard_cards":null')],
    ], { settle: 60 }],
  ['nothing to save is not a button that saves nothing', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['it says so', `(function(){ APP.cmd('roleOpen','warehouse'); return txt('content').includes('No unsaved changes'); })()`],
      ['and one tick makes it dirty', `(function(){ APP.cmd('tmGroup','sell'); APP.cmd('roleCap','products:edit');
         return txt('content').includes('Unsaved changes'); })()`],
    ], { settle: 60 }],
  ['deleting a role nobody holds just asks', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['and says nothing changes for anyone', `(function(){ APP.cmd('roleOpen','warehouse'); APP.cmd('roleDelete');
         return sheetText().includes('Nobody holds this role'); })()`],
      ['nothing sent yet', `!${sentWith('/api/backend/roles/warehouse', 'DELETE')}`],
    ], { settle: 60 }],
  ['deleting one somebody holds asks where they go', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['a picker, with the other roles in it', `(function(){ APP.cmd('roleOpen','store_manager'); APP.cmd('roleDelete');
         return sheetText().includes('where do its people go') && sheetText().includes('Warehouse'); })()`],
      ['picking one confirms the move',        `(function(){ APP.cmd('askRun','warehouse');
         return sheetText().includes('move 2'); })()`],
      ['and only then is it sent',             `(function(){ var before=${sentWith('/api/backend/roles/store_manager', 'DELETE')};
         APP.cmd('askRun'); return !before && ${sentWith('/api/backend/roles/store_manager', 'DELETE')}; })()`],
      ['with the destination',                 body('"move_to":"warehouse"')],
    ], { settle: 60 }],
  // Everything after the tab switch happens inside the first check: adding a
  // role needs canEdit, which is the roles READ's answer, so a setup that asked
  // for it in the same task would be asking before the shop had said yes.
  ['a new role starts empty', STUB + AS_OWNER + TEAM +
    `APP.cmd('push','team'); APP.cmd('teamTab','roles');`, [
      ['posted to the roles route', `(function(){ APP.cmd('roleAdd');
         document.getElementById('ask-name').value='Bookkeeper'; APP.cmd('askRun');
         return ${sentWith('/api/backend/roles', 'POST')}; })()`],
      ['with the name',             body('"name_en":"Bookkeeper"')],
      ['and no permissions',        body('"caps":[]')],
    ], { settle: 60 }],

  // ── Enforcement ───────────────────────────────────────────────────────
  ['enforcement is the owner\'s switch', STUB + AS_OWNER + TEAM + `APP.cmd('push','team');`, [
    ['it is on the screen',            `txt('content').includes('Enforce permissions')`],
    ['and says what off means',        `txt('content').includes('not enforcing them yet')`],
    ['turning it on asks first',       `(function(){ APP.cmd('teamEnforce'); return sheetText().includes('Turn on enforcement'); })()`],
    ['and says the owner keeps access', `sheetText().includes('always keep full access')`],
    ['then writes it',                 `(function(){ APP.cmd('askRun'); return ${sentWith('/api/backend/rbac-enforce', 'PUT')}; })()`],
    ['as enforce:1',                   body('"enforce":1')],
  ]],
  ['somebody who is not the owner is not offered it', STUB + AS_MANAGER + TEAM + SELF_ANA + `APP.cmd('push','team');`, [
    ['no switch',       `!document.querySelector('[onclick*="teamEnforce"]')`],
    ['but the fact is still stated', `txt('content').includes('not enforcing them yet')`],
  ]],

  // ── Who may do any of it ──────────────────────────────────────────────
  // Two capabilities, two different answers — the split the server makes.
  ['managing the team is not the same as setting permissions', STUB + AS_MANAGER + TEAM + SELF_ANA +
    `APP.cmd('push','team');`, [
      ['they may add somebody',        `!!document.querySelector('[onclick*="teamInvite"]')`],
      ['and change a role',            `(function(){ APP.cmd('teamOpen',2); return !!document.querySelector('[onclick*="teamRole"]'); })()`],
      ['but not what one person reaches', `!document.querySelector('[onclick*="teamPerms"]')`],
      ['and it says which permission is missing', `txt('content').includes('needs permission to set permissions')`],
    ]],
  ['an operator with neither is offered neither', STUB + AS_STAFF + TEAM + SELF_LIN + `APP.cmd('push','team');`, [
    ['the roster still reads',   `txt('content').includes('Lin Hao')`],
    ['no add button',            `!document.querySelector('[onclick*="teamInvite"]')`],
    ['and the reason is stated', `txt('content').includes('needs permission to manage the team')`],
  ]],
  ['and the handlers check it too, not just the renderer', STUB + AS_STAFF + TEAM + SELF_LIN +
    `APP.cmd('push','team'); APP.cmd('teamRole',2); APP.cmd('teamPass',2); APP.cmd('teamPerms',2); APP.cmd('teamEnforce');`, [
      ['no sheet opened',   `!document.querySelector('.sheet')`],
      ['and nothing sent',  `!${sentWith('/api/backend/team/2', 'PUT')} && !${sent('/password')} && !${sent('/rbac-enforce')}`],
    ]],
];

/* Cases that start a fetch cannot be asserted in the task that started it, so
   each one carries its own settle where it needs one — the harness takes a
   per-run value, so the suite runs twice: the synchronous cases together, and
   the ones that wait, with the wait. */
const plain = CASES.filter((c) => !c[3]).map((c) => c.slice(0, 3));
const settled = CASES.filter((c) => c[3]).map((c) => c.slice(0, 3));
run('permissions', plain);
run('permissions (async)', settled, { settle: 120 });
