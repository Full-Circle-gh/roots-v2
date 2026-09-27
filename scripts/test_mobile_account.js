#!/usr/bin/env node
/**
 * The operator's own Account screen on the phone, asserted against
 * public/backend-account.html — the desktop page it copies.
 *
 *   node scripts/test_mobile_account.js
 *
 * Reported 2026-09-27 from a phone: "can't change picture profile inside
 * account mobile?" It could not. The header drew the photo and nothing changed
 * it; the menu's "Account" row opened the SHOP's Settings. The desktop's
 * account page has four tabs — My Info, Security, Devices, Notifications — and
 * none of them were on the phone.
 *
 * Every write is asserted on the REQUEST — endpoint, method and body — never
 * on the toast (§97's standing rule), and every guard the desktop puts in front
 * of a write is asserted to hold here too.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* Every fetch recorded; the answer depends on the path, so a read and a write
   in the same case each get the shape their screen expects. */
const STUB = `window.__sent=[];
  window.__answer=function(u,m){
    if(u.indexOf('/api/backend/recovery')>=0&&m==='GET') return {email:'a***@roots.cn',verified:true,phone:null,phoneVerified:false,twofaEmail:false,twofaSms:false,emailConfigured:true,smsConfigured:true};
    if(u.indexOf('/api/backend/sessions')>=0&&m==='GET') return {sessions:[
      {id:'s-this',current:true,label:'Chrome on Android',kind:'phone',lastSeen:'2026-09-27 00:00:00'},
      {id:'s-lap',current:false,label:'Chrome on Windows',kind:'desktop',lastSeen:'2026-09-26 10:00:00',location:'Guangzhou'}]};
    if(u.indexOf('/api/backend/push/pref')>=0&&m==='GET') return {enabled:true,events:[
      {key:'new_order',labelEn:'New orders',labelCn:'新订单',descEn:'When an order is paid.',descCn:'订单付款时。',on:true,reaches:true},
      {key:'waste',labelEn:'Waste logged',labelCn:'损耗',descEn:'When waste is recorded.',descCn:'记录损耗时。',on:true,reaches:false}]};
    if(u.indexOf('/api/backend/push/events')>=0) return {success:true,events:[
      {key:'new_order',labelEn:'New orders',labelCn:'新订单',descEn:'When an order is paid.',descCn:'订单付款时。',on:false,reaches:true},
      {key:'waste',labelEn:'Waste logged',labelCn:'损耗',descEn:'When waste is recorded.',descCn:'记录损耗时。',on:true,reaches:false}]};
    if(u.indexOf('/api/backend/avatar')>=0) return {success:true,avatarUrl:(JSON.parse(window.__lastBody||'{}').avatar)||null};
    if(u.indexOf('/api/backend/profile')>=0) return {success:true,displayName:'Ash Chen'};
    if(u.indexOf('/api/backend/recovery/start')>=0) return {success:true,email:'n***@roots.cn'};
    if(u.indexOf('/api/backend/sessions/revoke')>=0) return {success:true,wasCurrent:false};
    return {success:true};
  };
  window.fetch=function(u,o){ var m=(o&&o.method)||'GET'; window.__lastBody=(o&&o.body)||null;
    window.__sent.push({u:String(u), m:m, body:(o&&o.body)||null});
    var j=window.__answer(String(u),m);
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(j)}}); };
  state.me={name:'Ash',role:'owner',avatarUrl:null};`;
const FAIL = (status, error) => `window.fetch=function(u,o){ var m=(o&&o.method)||'GET';
    window.__sent.push({u:String(u), m:m, body:(o&&o.body)||null});
    if(m==='GET') return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(window.__answer(String(u),m))}});
    return Promise.resolve({ok:false,status:${status},json:function(){return Promise.resolve({error:${JSON.stringify(error)}})}}); };`;

const sent = (path, m) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(path)})>=0 && r.m===${JSON.stringify(m)}})`;
const bodyOf = (path) => `(function(){var r=window.__sent.filter(function(r){return r.u.indexOf(${JSON.stringify(path)})>=0 && r.m!=='GET'}).pop(); return r?JSON.parse(r.body||'{}'):null})()`;
const noWrite = (path) => `!window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(path)})>=0 && r.m!=='GET'})`;
const type = (id, v) => `(function(){var e=document.getElementById('ask-${id}'); if(e){e.value=${JSON.stringify(v)};} })();`;
const OPEN = `APP.cmd('acctOpen','account');`;
// A 1×1 PNG, handed to the picker the way the OS hands over a chosen photo.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PICK = `(function(){var b=atob('${PNG}'),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
  var f=new File([a],'me.png',{type:'image/png'}); APP.cmd('acctPhoto',{files:[f],value:'x'});})();`;

const CASES = [
  // ── the door ────────────────────────────────────────────────────────────
  ['the menu\'s Account row opens the account, for everyone',
    "state.caps=['orders:view'];state.overflow=true;render();", [
      ['it is there for a role without Settings', "document.querySelector('.sheet').innerText.indexOf('Account')>-1"],
      ['and it goes to the account, not the shop\'s Settings',
       "document.querySelector('.sheet').innerHTML.indexOf(\"acctOpen','account'\")>-1 && document.querySelector('.sheet').innerHTML.indexOf(\"push','settings'\")<0"],
    ]],

  // ── My Info ─────────────────────────────────────────────────────────────
  ['the account screen carries every desktop section', STUB + OPEN, [
    ['the photo can be changed', "txt('content').includes('Change photo')"],
    ['name', "txt('content').includes('Name') && txt('content').includes('Ash')"],
    ['a verified email, masked as the server sent it', "txt('content').includes('a***@roots.cn') && txt('content').includes('Verified')"],
    ['a phone that can be added', "txt('content').includes('Add a phone')"],
    ['password', "txt('content').includes('Change password')"],
    ['two-step, with a switch only where a channel is verified', "txt('content').includes('Two-step verification') && txt('content').includes('Verify a phone under My Info to use this.')"],
    ['and says it is off', "txt('content').includes('Off — no code required at sign-in.')"],
    ['devices, counted', "txt('content').includes('2 devices signed in')"],
    ['which alerts', "txt('content').includes('Which alerts')"],
    ['no photo yet, so nothing to remove', "!txt('content').includes('Remove photo')"],
  ], { settle: 300 }],

  ['a chosen photo is squared and sent the desktop\'s way', STUB + OPEN + PICK, [
    ['PUT /api/backend/avatar', sent('/api/backend/avatar', 'PUT')],
    ['as a JPEG data URL — downscaled, never the camera original', `/^data:image\\/jpeg;base64,/.test((${bodyOf('/api/backend/avatar')}||{}).avatar||'')`],
    ['and the header button shows it at once', "/^data:image\\/jpeg/.test((state.me||{}).avatarUrl||'')"],
    ['so Remove photo appears', "txt('content').includes('Remove photo')"],
  ], { settle: 600 }],

  ['a file that is not a picture is refused before anything is sent', STUB + OPEN +
    `APP.cmd('acctPhoto',{files:[new File(['x'],'a.pdf',{type:'application/pdf'})],value:'x'});`, [
      ['nothing written', noWrite('/api/backend/avatar')],
      ['and it says why', "document.body.innerText.includes('Please choose an image file')"],
    ], { settle: 200 }],

  ['remove photo sends null, the desktop\'s clear', STUB + "state.me={name:'Ash',avatarUrl:'data:image/png;base64,AAAA'};" + OPEN +
    "APP.cmd('acctPhotoClear');", [
      ['PUT /api/backend/avatar', sent('/api/backend/avatar', 'PUT')],
      ['with avatar:null', `(${bodyOf('/api/backend/avatar')}||{x:1}).avatar===null`],
      ['and the photo is gone from the header', "!(state.me||{}).avatarUrl"],
    ], { settle: 300 }],

  ['the name is saved to /profile', STUB + OPEN + "APP.cmd('acctName');" + type('name', 'Ash Chen') + "APP.cmd('askRun','');", [
    ['PUT /api/backend/profile', sent('/api/backend/profile', 'PUT')],
    ['display_name is what was typed', `(${bodyOf('/api/backend/profile')}||{}).display_name==='Ash Chen'`],
    ['and the header follows', "(state.me||{}).name==='Ash Chen'"],
  ], { settle: 300 }],
  ['an empty name is refused on the sheet', STUB + OPEN + "APP.cmd('acctName');" + type('name', '') + "APP.cmd('askRun','');", [
    ['nothing written', noWrite('/api/backend/profile')],
    ['the sheet says why', "sheetText().includes('Enter a display name')"],
  ]],

  // ── Security ────────────────────────────────────────────────────────────
  ['a password change sends both passwords', STUB + OPEN + "APP.cmd('acctPass');" +
    type('cur', 'old-password-1') + type('nw', 'new-password-22') + type('nw2', 'new-password-22') + "APP.cmd('askRun','');", [
      ['PUT /api/backend/password', sent('/api/backend/password', 'PUT')],
      ['current_password and new_password, nothing else',
       `JSON.stringify(${bodyOf('/api/backend/password')})==='{"current_password":"old-password-1","new_password":"new-password-22"}'`],
    ], { settle: 300 }],
  ['the desktop\'s three guards hold before anything is sent', STUB + OPEN + "APP.cmd('acctPass');" +
    type('cur', 'x') + type('nw', 'short') + type('nw2', 'short') + "APP.cmd('askRun','');", [
      ['ten characters', "sheetText().includes('New password must be at least 10 characters')"],
      ['nothing written', noWrite('/api/backend/password')],
    ]],
  ['a confirm that does not match is refused', STUB + OPEN + "APP.cmd('acctPass');" +
    type('cur', 'x') + type('nw', 'new-password-22') + type('nw2', 'new-password-23') + "APP.cmd('askRun','');", [
      ['it says so', "sheetText().includes('New passwords don’t match')"],
      ['nothing written', noWrite('/api/backend/password')],
    ]],
  ['a wrong current password comes back ON the sheet, in this screen\'s language', STUB + FAIL(400, 'Current password is incorrect · 当前密码不正确') + OPEN +
    "APP.cmd('acctPass');" + type('cur', 'wrong-password') + type('nw', 'new-password-22') + type('nw2', 'new-password-22') + "APP.cmd('askRun','');", [
      ['the sheet is open again', "!!state.ask && sheetText().includes('Current password')"],
      ['with the server\'s English half only', "sheetText().includes('Current password is incorrect') && !sheetText().includes('当前密码不正确')"],
      ['and no password written back into the page', "!document.getElementById('ask-cur').value"],
    ], { settle: 300 }],

  ['a two-step switch writes the desktop\'s toggle', STUB + OPEN, [
    ['the email switch is drawn', "!!document.querySelector('#content [onclick*=\"acctTwofa\\',\\'email\"]')"],
    ['the SMS one is not — no verified phone', "!document.querySelector('#content [onclick*=\"acctTwofa\\',\\'sms\"]')"],
  ], { settle: 300 }],
  ['turning email two-step on', STUB + OPEN + "setTimeout(function(){APP.cmd('acctTwofa','email');},100);", [
    ['POST /api/backend/twofa/toggle', sent('/api/backend/twofa/toggle', 'POST')],
    ['channel email, enabled true', `JSON.stringify(${bodyOf('/api/backend/twofa/toggle')})==='{"channel":"email","enabled":true}'`],
    ['and the status line follows', "txt('content').includes('On — email code required at sign-in.')"],
  ], { settle: 500 }],

  // ── Email and phone ─────────────────────────────────────────────────────
  ['adding an email: address, then code', STUB + OPEN + "APP.cmd('acctEmailAdd');" + type('email', 'new@roots.cn') + "APP.cmd('askRun','');", [
    ['POST /api/backend/recovery/start', sent('/api/backend/recovery/start', 'POST')],
    ['with the address typed', `(${bodyOf('/api/backend/recovery/start')}||{}).email==='new@roots.cn'`],
    ['the code sheet names where it went, masked', "sheetText().includes('Enter the 6-digit code we emailed to') && sheetText().includes('n***@roots.cn')"],
  ], { settle: 300 }],
  ['the code is confirmed', STUB + OPEN + "APP.cmd('acctEmailAdd');" + type('email', 'new@roots.cn') + "APP.cmd('askRun','');" +
    "setTimeout(function(){" + type('code', '123456') + "APP.cmd('askRun','');},150);", [
      ['POST /api/backend/recovery/confirm', sent('/api/backend/recovery/confirm', 'POST')],
      ['code is what was typed', `(${bodyOf('/api/backend/recovery/confirm')}||{}).code==='123456'`],
    ], { settle: 500 }],
  ['a phone outside +86 is refused before sending, as on the desktop', STUB + OPEN + "APP.cmd('acctPhoneAdd');" +
    type('cc', '852') + type('phone', '91234567') + "APP.cmd('askRun','');", [
      ['it says why', "sheetText().includes('only +86 numbers can receive codes')"],
      ['nothing sent', noWrite('/api/backend/phone/start')],
    ]],
  ['a +86 phone is sent', STUB + OPEN + "APP.cmd('acctPhoneAdd');" + type('phone', '13800138000') + "APP.cmd('askRun','');", [
    ['POST /api/backend/phone/start', sent('/api/backend/phone/start', 'POST')],
    ['with the number typed', `(${bodyOf('/api/backend/phone/start')}||{}).phone==='13800138000'`],
  ], { settle: 300 }],
  ['a verified email can be removed', STUB + OPEN + "setTimeout(function(){APP.cmd('acctEmailMenu');APP.cmd('askRun','remove');},100);", [
    ['DELETE /api/backend/recovery', sent('/api/backend/recovery', 'DELETE')],
    ['and the row offers to add one again', "txt('content').includes('Add email')"],
  ], { settle: 500 }],

  // ── Devices ─────────────────────────────────────────────────────────────
  ['devices list where you are signed in', STUB + "APP.cmd('acctOpen','devices');", [
    ['this phone, marked', "txt('content').includes('Chrome on Android') && txt('content').includes('This device')"],
    ['the laptop, with where', "txt('content').includes('Chrome on Windows') && txt('content').includes('Guangzhou')"],
    ['sign out of all others is offered', "txt('content').includes('Sign out of all other devices')"],
  ], { settle: 300 }],
  ['one device is signed out by its session', STUB + "APP.cmd('acctOpen','devices');setTimeout(function(){APP.cmd('acctRevoke','s-lap');},100);", [
    ['POST /api/backend/sessions/revoke', sent('/api/backend/sessions/revoke', 'POST')],
    ['sid is that row\'s', `(${bodyOf('/api/backend/sessions/revoke')}||{}).sid==='s-lap'`],
    ['and it leaves the list', "!txt('content').includes('Chrome on Windows')"],
  ], { settle: 500 }],
  ['all others asks first, with the count', STUB + "APP.cmd('acctOpen','devices');setTimeout(function(){APP.cmd('acctRevokeOthers');},100);", [
    ['the sheet asks', "sheetText().includes('Sign out 1 other device?')"],
    ['and nothing is sent until it is confirmed', noWrite('/api/backend/sessions/revoke-others')],
  ], { settle: 300 }],

  // ── Which alerts ────────────────────────────────────────────────────────
  ['which alerts: per person, repainted from the server', STUB + "APP.cmd('acctOpen','alerts');setTimeout(function(){APP.cmd('acctAlert','new_order');},100);", [
    ['POST /api/backend/push/events', sent('/api/backend/push/events', 'POST')],
    ['event and on', `JSON.stringify(${bodyOf('/api/backend/push/events')})==='{"event":"new_order","on":false}'`],
    ['an event the role never gets says so, with no switch', "txt('content').includes('Your role doesn’t receive these.') && !document.querySelector('#content [onclick*=\"acctAlert\\',\\'waste\"]')"],
    ['and push being off here is said, not hidden', "txt('content').includes('Push is off on this device')"],
  ], { settle: 500 }],
  ['settings has the door to it', "APP.cmd('push','settings');", [
    ['Which alerts is in Notifications', "txt('content').includes('Which alerts')"],
  ]],

  // ── Chinese ─────────────────────────────────────────────────────────────
  ['in Chinese, every label is the desktop\'s', STUB + "LANG='zh';state.lang='zh';" + OPEN, [
    ['我的信息', "txt('content').includes('我的信息')"],
    ['更换照片', "txt('content').includes('更换照片')"],
    ['修改密码', "txt('content').includes('修改密码')"],
    ['两步验证', "txt('content').includes('两步验证')"],
    ['no English left over', "!/Change photo|Change password|Which alerts/.test(txt('content'))"],
  ], { settle: 300 }],
];

run('account', CASES.map(([n, s, c]) => [n, s, c]), { settle: 700 });
