#!/usr/bin/env node
/**
 * A paint nobody asked for keeps the caret — rule 6 under PUTTING THE KEYBOARD
 * AWAY in public/m.html.
 *
 *   node scripts/test_mobile_keep_caret.js
 *
 * "keyboard going down automatically sometimes when I click on amount"
 * (2026-10-09). render() rebuilds the whole app; a paint that lands while
 * somebody is typing — a read answering, a timer — threw their field away and
 * the keyboard with it. What is proven here, in a real Chromium, is the rule
 * and its edges:
 *
 *   • a paint from a timer keeps the caret, where it was, by id or — for a
 *     field with no id — by what the field does;
 *   • a paint from a TAP does not: tapping away still puts the keyboard down;
 *   • a field that keeps its text nowhere else keeps its text too;
 *   • a field that cannot be told from its neighbours is not guessed at;
 *   • a caret request a handler armed is the handler's, and wins;
 *   • nobody typing, nothing is focused.
 *
 * Screens with no id-less fields that are easy to reach are rare, so three
 * cases swap screenExpense for a few lines of markup. That is still the shipped
 * render() doing the paint and the shipped rule doing the keeping.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const STUB = `
  window.fetch=function(u){ u=String(u); var j={success:true,data:{}};
    if(u.indexOf('/staff-expenses/meta')>=0) j={categories:[],stores:[{id:1,name_en:'Tianhe',name_cn:'天河店'}],recent:[]};
    if(u.indexOf('/staff-expenses/mine')>=0) j={rows:[],owed:0,waiting:0};
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(j)}}); };
  state.me={name:'Mei',role:'owner'}; state.caps=['expenses:submit']; state.stores=[{id:1,name_en:'Tianhe',name_cn:'天河店'}];
  APP.cmd('push','expense');`;
// A paint from a timer: no event is being dispatched, which is the case the rule is for.
const LATER = `setTimeout(function(){ render(); }, 30);`;
const focused = (sel) => `(function(){ var a=document.activeElement;
  if(!a||a===document.body) throw new Error('nothing focused');
  if(!a.matches(${JSON.stringify(sel)})) throw new Error('focused: '+a.outerHTML.slice(0,80)); return true; })()`;
const notTyping = `(function(){ var a=document.activeElement; return !a||!/^(INPUT|TEXTAREA)$/.test(a.tagName); })()`;
// Swap the expense screen for a handful of fields, so the cases below can have no ids.
const SCREEN = (html) => `screenExpense=function(){ return ${JSON.stringify(html)}; }; render();`;

const CASES = [
  ['a timer paints while the amount is being typed', STUB + `
     var f=document.getElementById('mExpAmt'); f.focus(); f.value='22.3';
     f.dispatchEvent(new Event('input',{bubbles:true})); f.setSelectionRange(2,2); window.__f=f;` + LATER, [
    ['the paint really rebuilt the field', `document.getElementById('mExpAmt')!==window.__f`],
    ['the caret is still in the amount', focused('#mExpAmt')],
    ['where it was', `document.getElementById('mExpAmt').selectionStart===2`],
    ['and the figure is still there', `document.getElementById('mExpAmt').value==='22.3'`],
  ]],
  ['a TAP that paints still puts the keyboard down', STUB + `
     var f=document.getElementById('mExpAmt'); f.focus();
     var b=[].slice.call(document.querySelectorAll('button.chip')).filter(function(b){return /Company/.test(b.textContent)})[0];
     b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click();`, [
    ['nothing typed is focused after the tap', notTyping],
  ]],
  ['a field with no id is found again by what it does', STUB + SCREEN(
    `<input oninput="APP.cmd('expNote',this.value)" aria-label="First"><input oninput="APP.cmd('expNote',this.value)" aria-label="Second">`) + `
     var f=document.querySelector('input[aria-label=Second]'); f.focus(); window.__f=f;` + LATER, [
    ['rebuilt', `document.querySelector('input[aria-label=Second]')!==window.__f`],
    ['the caret is back in the second field, not the first', focused('input[aria-label=Second]')],
  ]],
  ['identical id-less fields: the same one of them', STUB + SCREEN(
    `<input oninput="APP.cmd('expNote',this.value)"><input oninput="APP.cmd('expNote',this.value)"><input oninput="APP.cmd('expNote',this.value)">`) + `
     document.querySelectorAll('input')[1].focus();` + LATER, [
    ['the second of three', `document.activeElement===document.querySelectorAll('#content input')[1]`],
  ]],
  ['a field with nothing to know it by is not guessed at', STUB + SCREEN(`<input><input>`) + `
     document.querySelectorAll('#content input')[1].focus();` + LATER, [
    ['no caret is put anywhere', notTyping],
  ]],
  ['a field that keeps its text nowhere else keeps it through the paint', STUB + SCREEN(
    `<textarea id="mReply"></textarea>`) + `
     var t=document.getElementById('mReply'); t.focus(); t.value='Thanks, it ships tomorrow'; t.setSelectionRange(6,6);` + LATER, [
    ['the reply is still written', `document.getElementById('mReply').value==='Thanks, it ships tomorrow'`],
    ['and the caret is in it, where it was', `document.activeElement.id==='mReply'&&document.activeElement.selectionStart===6`],
  ]],
  ['a field that commits on change gets its caret, not invented text', STUB + SCREEN(
    `<input id="mDmg" value="1" onchange="window.__c=this.value">`) + `
     var f=document.getElementById('mDmg'); f.focus(); f.value='13';` + LATER, [
    ['focused', focused('#mDmg')],
    ['showing what the screen says, so a later change still fires', `document.getElementById('mDmg').value==='1'`],
  ]],
  ['a caret request a handler armed wins', STUB + `
     document.getElementById('mExpAmt').focus();
     setTimeout(function(){ state.focus={id:'mExpNote',pos:null}; render(); },30);`, [
    ['the note has it, as asked', focused('#mExpNote')],
  ]],
  ['nobody typing: a paint focuses nothing', STUB + LATER, [
    ['nothing focused', notTyping],
  ]],
  ['the expense form\'s own reads, answering late', STUB.replace('return Promise.resolve({ok','return new Promise(function(r){setTimeout(function(){r({ok').replace('json:function(){return Promise.resolve(j)}});','json:function(){return Promise.resolve(j)}})},120)});') .replace("APP.cmd('push','expense');", "state.exp.tried=false; state.exp.mineTried=false; APP.cmd('push','expense');") + `
     var f=document.getElementById('mExpAmt'); f.focus(); f.value='8'; f.dispatchEvent(new Event('input',{bubbles:true}));`, [
    ['the amount keeps the caret', focused('#mExpAmt')],
  ]],
];

run('keep-caret', CASES, { settle: 500 });
