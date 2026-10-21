#!/usr/bin/env node
/**
 * The voice assistant (§495) — the sheet, in a browser.
 *
 *   CHROME_BIN=/path/to/chrome node scripts/test_mobile_assistant.js
 *
 * scripts/test_assistant_plan.js proves the server keeps only what exists.
 * This file proves the PHONE does the right thing with a plan:
 *   • the microphone is in the header only for an operator whose role carries
 *     `assistant:use` and whose tenant has the module switched on;
 *   • the sheet opens listening when the phone has a recogniser, and typed
 *     otherwise, with the language chip;
 *   • a plan is rows with tick boxes, the asked rows first and the suggested
 *     ones under their own heading, and Approve counts the ticks;
 *   • Approve calls each ticked row's route, in order, with the route's own
 *     body, and shows ✓ or ✗ per row with the refusal's words; nothing is
 *     called for an unticked row; nothing is called before Approve;
 *   • a question is buttons; a pick re-plans with the answer and teaches the
 *     one name the model could not place;
 *   • Back declines, Cancel cancels, and both tell the log;
 *   • no model key, the module not held, or the module off is said in words;
 *   • a question's answer is shown as words with nothing to approve, and a
 *     plan that is only answers offers Close, not Approve, and tells the log
 *     nothing more (the server marked it answered when it was shown);
 *   • a route that answers 200 with ok:false (a printer not set up) is a
 *     failed row with that reason.
 *
 * Drives Chromium through scripts/lib/m-probe, so it belongs in the slow
 * shard and is listed there by name in scripts/run-suites.js.
 */
'use strict';

const { run } = require('./lib/m-probe');

const NO_SR = 'window.SpeechRecognition=undefined; window.webkitSpeechRecognition=undefined;';
const FAKE_SR = `window.__sr=[]; window.SpeechRecognition=function(){ var me=this; me.start=function(){ window.__sr.push({lang:me.lang,ev:'start'}); };
  me.stop=function(){ window.__sr.push({ev:'stop'}); if(me.onend) me.onend(); }; me.abort=function(){ window.__sr.push({ev:'abort'}); }; };
  window.webkitSpeechRecognition=undefined;`;
const OWNER = "state.caps=null; state.cfg={features:{assistant:true}}; state.tab='home'; state.stack=[]; render();";
const WITH_CAP = "state.caps=['assistant:use','dashboard:view']; state.cfg={features:{assistant:true}}; state.tab='home'; state.stack=[]; render();";
const NO_CAP = "state.caps=['dashboard:view']; state.cfg={features:{assistant:true}}; state.tab='home'; state.stack=[]; render();";
const OFF = "state.caps=['assistant:use']; state.cfg={features:{assistant:false}}; state.tab='home'; state.stack=[]; render();";

const PLAN = {
  id: 77, say: 'Switch off Whole wheat bread on Open Toast at Yuexiu.',
  actions: [
    { key: 'a0', type: 'answer_switch', suggested: false, label_en: 'Switch off Whole wheat bread on Open Toast at Yuexiu', label_cn: '在越秀关闭开放三明治的全麦面包',
      cmd: { method: 'PUT', path: '/api/retail-admin/shops/20/listings/1/choices/1/off', body: { off: true } } },
    { key: 'a1', type: 'answer_switch', suggested: true, label_en: 'Switch off Whole wheat bread on Club Sandwich at Yuexiu', label_cn: '在越秀关闭俱乐部三明治的全麦面包',
      cmd: { method: 'PUT', path: '/api/retail-admin/shops/20/listings/2/choices/3/off', body: { off: true } } },
    { key: 'a2', type: 'shop_open', suggested: false, label_en: 'Close Yuexiu', label_cn: '关闭越秀',
      cmd: { method: 'POST', path: '/api/retail-admin/store-status/store/yuexiu', body: { open: false } } },
  ],
  question: null, unknown_names: [],
};
const QUESTION = { id: 78, say: '', actions: [], question: { kind: 'store', text: 'Which store is Ramada?', options: [{ id: 1, label: 'Tianhe' }, { id: 2, label: 'Yuexiu' }] }, unknown_names: ['Ramada'] };

/* fetch that answers the plan call with a given plan and records every call;
   `refuse` names a path that answers 403 with a refusal. */
const FETCH = (plan, refuse) => `window.__sent=[];
  window.fetch=function(u,o){ u=String(u); window.__sent.push({u:u,b:o&&o.body,m:o&&o.method});
    if(u.indexOf('/assistant/plan')>-1) return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:${JSON.stringify(plan)}})}});
    if(${JSON.stringify(refuse || '')} && u.indexOf(${JSON.stringify(refuse || '')})>-1) return Promise.resolve({ok:false,status:403,json:function(){return Promise.resolve({error:'forbidden'})}});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;
const FAIL = (status, error) => `window.__sent=[];
  window.fetch=function(u,o){ u=String(u); window.__sent.push({u:u,b:o&&o.body,m:o&&o.method});
    if(u.indexOf('/assistant/plan')>-1) return Promise.resolve({ok:false,status:${status},json:function(){return Promise.resolve({success:false,error:${JSON.stringify(error)}})}});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

const MIC = "document.querySelector('#content button[onclick=\"APP.cmd(\\'asstOpen\\')\"]')";
const SAY = (text) => `APP.cmd('asstOpen'); APP.cmd('asstText',${JSON.stringify(text)}); APP.cmd('asstPlan');`;
const sent = (frag) => `window.__sent.filter(function(s){return s.u.indexOf(${JSON.stringify(frag)})>-1})`;
const overlay = () => "document.querySelector('.overlay')";
const otext = "(document.querySelector('.overlay')||{innerText:''}).innerText";

run('the voice assistant', [
  ['the microphone is in the header for the owner', OWNER + NO_SR, [
    ['there', `!!${MIC}`],
    ['beside the search', `${MIC}.nextElementSibling && ${MIC}.nextElementSibling.getAttribute('aria-label')==='Search'`],
  ]],
  ['and for a role carrying assistant:use', WITH_CAP + NO_SR, [['there', `!!${MIC}`]]],
  ['not for a role without it', NO_CAP + NO_SR, [['absent', `!${MIC}`]]],
  ['not when the tenant switched the module off', OFF + NO_SR, [['absent', `!${MIC}`]]],
  ['opening without a recogniser gives the field, the note and no chip', OWNER + NO_SR + "APP.cmd('asstOpen');", [
    ['the sheet', `${otext}.indexOf('Voice assistant')>-1`],
    ['the field has the keyboard', "document.activeElement&&document.activeElement.id==='mAsst'"],
    ['no chip', "!document.querySelector('.overlay .chip')"],
    ['the note', `${otext}.indexOf('Voice isn’t available in this browser')>-1`],
    ['an example to copy', `${otext}.indexOf('For example')>-1`],
  ]],
  ['opening with a recogniser listens at once, with the chips', OWNER + FAKE_SR + "try{localStorage.removeItem('roots_qs_voice_lang')}catch(e){} APP.cmd('asstOpen');", [
    ['started', "window.__sr.length===1 && window.__sr[0].ev==='start' && window.__sr[0].lang==='en-US'"],
    ['the English chip lit', "document.querySelector('.overlay .chip.on').innerText.trim()==='English'"],
    ['listening', `${otext}.indexOf('Listening…')>-1`],
  ]],
  ['the chip restarts the recogniser in Chinese and the device remembers', OWNER + FAKE_SR + "APP.cmd('asstOpen'); APP.cmd('asstLang','zh');", [
    ['restarted in Chinese', "window.__sr[window.__sr.length-1].lang==='zh-CN'"],
    ['remembered', "localStorage.getItem('roots_qs_voice_lang')==='zh'"],
  ]],
  ['Cancel from the field closes without telling the log', OWNER + NO_SR + FETCH(PLAN) + "APP.cmd('asstOpen'); APP.cmd('asstClose');", [
    ['closed', `!${overlay()}`],
    ['nothing sent', 'window.__sent.length===0'],
  ]],
], { settle: 200 });

run('the voice assistant, a plan', [
  ['a sentence becomes rows, asked first, suggested under their heading', OWNER + NO_SR + FETCH(PLAN) + SAY('whole wheat bread on open toast at yuexiu sold out, close yuexiu'), [
    ['the plan was asked for, typed, in English', `${sent('/assistant/plan')}.length===1 && JSON.parse(${sent('/assistant/plan')}[0].b).via==='typed' && JSON.parse(${sent('/assistant/plan')}[0].b).lang==='en'`],
    ['what was understood', `${otext}.indexOf('Switch off Whole wheat bread on Open Toast at Yuexiu.')>-1`],
    ['the asked rows', `${otext}.indexOf('Close Yuexiu')>-1`],
    ['the suggestion under its heading', `${otext}.indexOf('Also suggested')>-1 && ${otext}.indexOf('Club Sandwich')>-1`],
    ['all three ticked', "document.querySelectorAll('.overlay button[aria-pressed=\"true\"]').length===3"],
    ['Approve counts them', `${otext}.indexOf('Approve · 3')>-1`],
    ['nothing run yet', `${sent('/shops/')}.length===0 && ${sent('/store-status')}.length===0`],
  ]],
  ['Approve runs the ticked rows in order, with their routes and bodies, and marks each', OWNER + NO_SR + FETCH(PLAN) + SAY('x') + "setTimeout(function(){ APP.cmd('asstRun'); },60);", [
    ['three routes called', `${sent('/shops/')}.length===2 && ${sent('/store-status')}.length===1`],
    ['the first is the asked switch', `${sent('/shops/')}[0].u.indexOf('/shops/20/listings/1/choices/1/off')>-1 && ${sent('/shops/')}[0].m==='PUT' && JSON.parse(${sent('/shops/')}[0].b).off===true`],
    ['then the suggestion', `${sent('/shops/')}[1].u.indexOf('/listings/2/choices/3/off')>-1`],
    ['then the close, by store code', `${sent('/store-status')}[0].u.indexOf('/store-status/store/yuexiu')>-1 && JSON.parse(${sent('/store-status')}[0].b).open===false`],
    ['Done, 3 done', `${otext}.indexOf('3 done')>-1`],
    ['every row ticked off', "(document.querySelector('.overlay').innerText.match(/✓/g)||[]).length===3"],
    ['the log told what was approved and ran', `${sent('/assistant/outcome')}.length===1 && JSON.parse(${sent('/assistant/outcome')}[0].b).outcome==='approved' && JSON.parse(${sent('/assistant/outcome')}[0].b).approved.join()==='a0,a1,a2' && JSON.parse(${sent('/assistant/outcome')}[0].b).results.every(function(r){return r.ok})`],
    ['Close is offered', `${otext}.indexOf('Close')>-1`],
  ]],
  ['an unticked row is not run', OWNER + NO_SR + FETCH(PLAN) + SAY('x') + "setTimeout(function(){ APP.cmd('asstTick','a1'); APP.cmd('asstRun'); },60);", [
    ['two routes, not three', `${sent('/shops/')}.length===1 && ${sent('/store-status')}.length===1`],
    ['the suggestion skipped', `!${sent('/shops/')}.some(function(s){return s.u.indexOf('/listings/2/')>-1})`],
    ['2 done', `${otext}.indexOf('2 done')>-1`],
    ['the log names two', `JSON.parse(${sent('/assistant/outcome')}[0].b).approved.join()==='a0,a2'`],
  ]],
  ['a route that refuses marks its row with the refusal and the rest still run', OWNER + NO_SR + FETCH(PLAN, '/store-status') + SAY('x') + "setTimeout(function(){ APP.cmd('asstRun'); },60);", [
    ['two ✓ and one ✗', "(document.querySelector('.overlay').innerText.match(/✓/g)||[]).length===2 && (document.querySelector('.overlay').innerText.match(/✗/g)||[]).length===1"],
    ['the refusal in words', `${otext}.indexOf('permission')>-1`],
    ['2 done · 1 failed', `${otext}.indexOf('2 done')>-1 && ${otext}.indexOf('1 failed')>-1`],
    ['the log says which failed', `JSON.parse(${sent('/assistant/outcome')}[0].b).results.filter(function(r){return !r.ok}).length===1`],
  ]],
  ['Back declines and returns to the field with the sentence kept', OWNER + NO_SR + FETCH(PLAN) + SAY('close yuexiu') + "setTimeout(function(){ APP.cmd('asstBack'); },60);", [
    ['the field is back', "!!document.getElementById('mAsst') && document.getElementById('mAsst').value==='close yuexiu'"],
    ['declined', `${sent('/assistant/outcome')}.length===1 && JSON.parse(${sent('/assistant/outcome')}[0].b).outcome==='declined'`],
  ]],
  ['Cancel on a plan cancels it in the log', OWNER + NO_SR + FETCH(PLAN) + SAY('x') + "setTimeout(function(){ APP.cmd('asstClose'); },60);", [
    ['closed', `!${overlay()}`],
    ['cancelled', `JSON.parse(${sent('/assistant/outcome')}[0].b).outcome==='cancelled'`],
  ]],
  ['a question is buttons, and a pick re-plans with the answer and teaches the name', OWNER + NO_SR + FETCH(QUESTION) + SAY('ramada sold out of bagels') + "setTimeout(function(){ APP.cmd('asstAnswer',2); },60);", [
    ['the question was shown', `${sent('/assistant/plan')}.length===2`],
    ['the second plan carries the answer', `JSON.parse(${sent('/assistant/plan')}[1].b).answers.store_id===2`],
    ['and the name to learn', `JSON.parse(${sent('/assistant/plan')}[1].b).learn[0].heard==='Ramada' && JSON.parse(${sent('/assistant/plan')}[1].b).learn[0].kind==='store' && JSON.parse(${sent('/assistant/plan')}[1].b).learn[0].id===2`],
    ['on the same log row', `JSON.parse(${sent('/assistant/plan')}[1].b).log_id===78`],
  ]],
  ['the question offers a way out', OWNER + NO_SR + FETCH(QUESTION) + SAY('x'), [
    ['the question in words', `${otext}.indexOf('Which store is Ramada?')>-1 && ${otext}.indexOf('Tianhe')>-1 && ${otext}.indexOf('Yuexiu')>-1`],
    ['Something else', `${otext}.indexOf('Something else')>-1`],
  ]],
  ['no model key is said in words', OWNER + NO_SR + FAIL(503, 'not_configured') + SAY('x'), [
    ['the sentence', `${otext}.indexOf('needs the model key')>-1`],
    ['the field stays', "!!document.getElementById('mAsst')"],
  ]],
  ['a question is answered in words, with nothing to approve',
    OWNER + NO_SR + FETCH({ id: 80, say: 'Yuexiu has 3 orders today.', actions: [], answers: [{ what: 'orders_today', store_id: 2, text_en: '3 orders today at Yuexiu', text_cn: '越秀今天 3 单' }], question: null, unknown_names: [] }) + SAY('how many orders today at yuexiu'), [
      ['the answer', `${otext}.indexOf('3 orders today at Yuexiu')>-1`],
      ['no Approve', `${otext}.indexOf('Approve')===-1`],
      ['Close offered', "!!document.querySelector('.overlay button[onclick=\"APP.cmd(\\'asstClose\\')\"]')"],
      ['not the empty-plan line', `${otext}.indexOf('Nothing I can do')===-1`],
    ]],
  ['closing an answered plan tells the log nothing more',
    OWNER + NO_SR + FETCH({ id: 80, say: '', actions: [], answers: [{ what: 'status', text_en: 'Yuexiu is closed', text_cn: '越秀已关闭' }], question: null, unknown_names: [] }) + SAY('is yuexiu open') + "setTimeout(function(){ APP.cmd('asstClose'); },60);", [
      ['closed', `!${overlay()}`],
      ['no outcome sent', `${sent('/assistant/outcome')}.length===0`],
    ]],
  ['a refused answer is shown as the refusal',
    OWNER + NO_SR + FETCH({ id: 81, say: '', actions: [], answers: [{ what: 'orders_today', refused: true, text_en: 'You don’t have permission for this', text_cn: '你没有此操作的权限' }], question: null, unknown_names: [] }) + SAY('orders today'), [
      ['in words', `${otext}.indexOf('permission')>-1`],
    ]],
  ['an answer beside an action keeps the Approve for the action',
    OWNER + NO_SR + FETCH({ id: 82, say: '', actions: [PLAN.actions[2]], answers: [{ what: 'status', text_en: 'Yuexiu is open', text_cn: '越秀营业中' }], question: null, unknown_names: [] }) + SAY('is yuexiu open? close it'), [
      ['the answer', `${otext}.indexOf('Yuexiu is open')>-1`],
      ['the row', `${otext}.indexOf('Close Yuexiu')>-1`],
      ['Approve · 1', `${otext}.indexOf('Approve · 1')>-1`],
    ]],
  ['a route that says ok:false is a failed row with its reason',
    OWNER + NO_SR + FETCH({ id: 83, say: '', actions: [{ key: 'a0', type: 'reprint', suggested: false, label_en: 'Reprint the slip for order TC000001', label_cn: '重新打印订单 TC000001 的小票', cmd: { method: 'POST', path: '/api/retail-admin/orders/1/print', body: {} } }], answers: [], question: null, unknown_names: [] }).replace("return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}});", "return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(u.indexOf('/print')>-1?{success:true,ok:false,error:'no_printer_for_store'}:{success:true})}});") + SAY('x') + "setTimeout(function(){ APP.cmd('asstRun'); },60);", [
      ['one ✗', "(document.querySelector('.overlay').innerText.match(/✗/g)||[]).length===1"],
      ['the reason', `${otext}.indexOf('no_printer_for_store')>-1`],
      ['1 failed', `${otext}.indexOf('1 failed')>-1`],
    ]],
  ['a plan with nothing it can do says so', OWNER + NO_SR + FETCH({ id: 79, say: 'I cannot help with refunds.', actions: [], question: null, unknown_names: [] }) + SAY('refund order 5'), [
    ['the model\'s words', `${otext}.indexOf('I cannot help with refunds.')>-1`],
    ['and the sheet\'s', `${otext}.indexOf('Nothing I can do with that')>-1`],
    ['no Approve', `${otext}.indexOf('Approve')===-1`],
  ]],
], { settle: 400 });
