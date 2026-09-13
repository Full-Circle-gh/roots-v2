#!/usr/bin/env node
/**
 * Customers on the phone — the roster's filters, and every write on the record.
 *
 *   node scripts/test_mobile_customers.js
 *
 * §116. Ash: "customer section on the mobile should be fully functional like
 * the pc version." What that turned out to mean, against public/retail-admin/
 * 08-customers.js, was twelve things — three filters that asked a narrower
 * question than the desktop's, six writes the phone had no way to make, two
 * blocks it rendered nothing for, and, worst, four buttons offered to every
 * operator regardless of what they may do.
 *
 * THE CAPABILITY CASES ARE THE ONES TO READ FIRST. `apiWrite` treats a 403 as a
 * lost session and sends the operator to /backend/login — so a write control
 * drawn for somebody who cannot use it does not fail politely, it logs them out
 * of the app mid-shift. lib/cap-routes.js is the source of which key gates
 * what: `customers:adjust` for points and wallet, `customers:block` for block,
 * unblock and force-logout, `customers:edit` for everything else.
 *
 * The write cases assert the REQUEST BODY, not the toast. A save that reports
 * success and sends the wrong field is the shape of bug this app has shipped
 * before (APP.cmd dropping its second argument), and no render test sees it.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// One record carrying every block the desktop's drawer carries, so a case can
// reach any of them without building its own. Shapes are the server's
// (GET /api/retail-admin/customers/:id → routes/retail.js), not the phone's.
const REC = `state.custId=1; state.custDetail={
  customer:{id:1,nickname:'Chen Meiling',phone:'13800002841',email:'mei@example.com',
    tier_key:'tree',points_balance:1240,balance:88,gender:2,birthday:'1990-04-02',
    note:'Allergic to nuts.',tags:'wholesale,pays late',created_at:'2025-02-01 09:00:00'},
  stats:{orders:{orders_count:9,revenue:4200,aov:466},active_sessions:2},
  addresses:[{id:7,recipient_name:'Chen Meiling',phone:'13800002841',province:'广东省',
    city:'广州市',district:'天河区',address:'天河路 1 号',detail:'3 楼 301',is_default:1},
    {id:8,recipient_name:'Lin Hao',phone:'13900000092',city:'深圳市',address:'深南大道 2 号'}],
  orders_by_month:[{month:'2026-08',n:5},{month:'2026-09',n:2}],
  affiliate:{referral_code:'AB12CD',affiliate_blocked:0,lifetime_mode:'selected',
    lifetime_eligible:0,summary:{total:3,converted:2,earned:40}},
  diagnostics:{error_count_7d:0}};
  state.custMounted=true;`;

// Every capability this section knows about, and the two narrowed accounts the
// gates exist for. `customer_service` is lib/capabilities.js's own preset.
const ALL   = `state.caps=['customers:view','customers:edit','customers:adjust','customers:block','customers:export'];`;
const VIEW  = `state.caps=['customers:view'];`;
const SERVE = `state.caps=['customers:view','customers:edit'];`;

const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{id:5}})}}); };`;
const sent   = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const body   = (frag) => `window.__sent.some(function(r){return (r.body||'').indexOf(${JSON.stringify(frag)})>=0})`;
const method = (m)    => `window.__sent.some(function(r){return r.m===${JSON.stringify(m)}})`;
// The roster read, as one URL — the filters all travel on it.
const query  = (frag) => `window.__sent.some(function(r){return r.u.indexOf('/customers?')>=0 && r.u.indexOf(${JSON.stringify(frag)})>=0})`;

// A field on the open ask sheet, filled the way a thumb would fill it.
const type = (id, v) => `(function(){var e=document.getElementById('ask-${id}'); if(e){e.value=${JSON.stringify(v)};} })();`;

const CASES = [
  // ── The roster's filters ────────────────────────────────────────────────
  // All three are the SERVER's, and all three are multi-select there. The phone
  // sent one value per row, so "Tree or Root" — a question the desktop can ask —
  // had no answer here.
  ['tier and channel take several at once', STUB + ALL + `
    APP.cmd('custTier','tree'); APP.cmd('custTier','root'); APP.cmd('custChan','web');`, [
    ['both tiers travel, comma-separated', query('tier=tree%2Croot')],
    ['alongside the channel',              query('channel=web')],
    ['and tapping one again drops it',
      `(function(){ APP.cmd('custTier','root'); return ${query('tier=tree&')} || window.__sent.some(function(r){return /[?&]tier=tree(&|$)/.test(r.u)}); })()`],
  ]],
  ['All is the row\'s clear, not a fourth choice', STUB + ALL + `
    state.custLoaded=true; state.customers=[]; APP.cmd('tab','customers');
    APP.cmd('custTier','tree'); APP.cmd('custTier','all'); render();`, [
    ['it empties the row',  `!(state.custTier||[]).length`],
    // The LAST read, not any read: the tap on Tree legitimately sent tier=tree a
    // moment ago, and asserting over the whole log would fail on that.
    ['so the read after it carries no tier',
      `(function(){ var r=window.__sent.filter(function(x){return x.u.indexOf('/customers?')>=0}).pop();
         return !!r && r.u.indexOf('tier=')<0; })()`],
    // The chip that lights when nothing is chosen — the thing that makes "All
    // tiers" a clear rather than a fourth tier that can sit lit beside Tree.
    ['and "All tiers" is the lit one',
      `[].slice.call(document.querySelectorAll('.chip.on')).some(function(b){return /All tiers/.test(b.innerText)})
       && ![].slice.call(document.querySelectorAll('.chip.on')).some(function(b){return /^Tree/.test(b.innerText)})`],
  ]],
  ['tags filter the roster', STUB + ALL + `
    state.custTagVocab=[{tag:'wholesale',count:4},{tag:'pays late',count:1}];
    state.custLoaded=true; state.customers=[]; APP.cmd('tab','customers');
    APP.cmd('custTagAt',0);`, [
    ['the vocabulary is drawn as chips', `txt('content').includes('wholesale') && txt('content').includes('pays late')`],
    ['with the server\'s counts',        `txt('content').includes('All tags')`],
    ['and the tap sends the tag',        query('tags=wholesale')],
  ]],
  // A shop that has tagged nobody gets no row — an empty filter is a control
  // that narrows nothing and reads as "this shop has no tags".
  ['no tags yet, no tag row', ALL + `state.custTagVocab=[]; state.custLoaded=true;
    state.customers=[]; APP.cmd('tab','customers');`, [
    ['the row is absent', `!txt('content').includes('All tags')`],
  ]],
  ['the sort turns over', STUB + ALL + `
    state.custSort='spend'; APP.cmd('custSortPick'); APP.cmd('askRun','spend');`, [
    ['picking the one you are on flips it', `state.custDir==='asc'`],
    ['and the direction is sent',           query('dir=asc')],
    ['a different one starts fresh',
      `(function(){ APP.cmd('custSortPick'); APP.cmd('askRun','name'); return state.custSort==='name' && state.custDir===null; })()`],
  ]],
  // THE COMMAND ITSELF IS NOT CALLED HERE, and that is not a gap in the check —
  // it navigates (the server answers with a Content-Disposition, so a browser
  // downloads and stays), which in a probe takes the harness page with it and
  // the run reports the CSV's own URL as the result. What is worth asserting is
  // the query it builds, which is the part that can be wrong: an export that
  // quietly ships the whole roster when the screen was showing one tier is a
  // file somebody then acts on.
  ['export asks for the file the screen is showing', ALL + `
    state.custTier=['tree']; state.custTags=['wholesale']; state.custQ='mei';
    state.custSeg='blocked';`, [
    ['every filter on the screen travels with it',
      `(function(){ var qs=custFilterParams(new URLSearchParams()).toString();
         return qs.indexOf('tier=tree')>=0 && qs.indexOf('tags=wholesale')>=0
             && qs.indexOf('q=mei')>=0 && qs.indexOf('segment=blocked')>=0; })()`],
    ['and it is the roster read\'s own builder, so the two cannot disagree',
      `custQuery(0).indexOf('tier=tree')>=0 && custQuery(0).indexOf('tags=wholesale')>=0`],
  ]],

  // ── What the record shows ───────────────────────────────────────────────
  ['the record carries what the shop knows', ALL + REC + `render();`, [
    ['the tags are on it',        `sheetText().includes('wholesale') && sheetText().includes('pays late')`],
    ['and the note',              `sheetText().includes('Allergic to nuts')`],
    ['every address, not three',  `sheetText().includes('天河路 1 号') && sheetText().includes('深南大道 2 号')`],
    ['with the street line, which a courier needs', `sheetText().includes('3 楼 301')`],
    ['the default one marked',    `sheetText().includes('Default')`],
    ['and the recipient, who may not be the customer', `sheetText().includes('Lin Hao')`],
    ['twelve months of activity', `sheetText().includes('Last 12 months') && sheetText().includes('Busiest')`],
    ['the referral state, not just the code', `sheetText().includes('AB12CD') && sheetText().includes('Ongoing share')`],
  ]],

  // ── The writes ──────────────────────────────────────────────────────────
  ['tags save lower-cased and deduped', STUB + ALL + REC + `render();
    APP.cmd('editCustTags'); ` + type('tags', 'VIP, wholesale, vip ,  ') + ` APP.cmd('askRun','');`, [
    ['through the profile PATCH',  `${sent('/customers/1')} && ${method('PATCH')}`],
    ['one "vip", not two',         body('"tags":"vip,wholesale"')],
  ]],
  ['the note saves', STUB + ALL + REC + `render();
    APP.cmd('editCustNote'); ` + type('note', 'Buzzer is broken.') + ` APP.cmd('askRun','');`, [
    ['as a note',   body('"note":"Buzzer is broken."')],
    ['as a PATCH',  method('PATCH')],
  ]],
  // The phone number was held back on 2026-08-22 because records dedupe on it.
  // The endpoint has refused a duplicate since its own check went in, and this
  // sheet already carried the wording for that refusal.
  ['the profile edit reaches all five fields', STUB + ALL + REC + `render();
    APP.cmd('editCustomer');`, [
    ['the phone is one of them',   `!!document.getElementById('ask-phone')`],
    ['so are gender and birthday', `!!document.getElementById('ask-gender') && !!document.getElementById('ask-birthday')`],
    ['and it no longer sends the operator to a desktop',
      `!sheetText().includes('changed on the desktop')`],
  ]],
  ['a phone number the server would refuse is refused here', STUB + ALL + REC + `render();
    APP.cmd('editCustomer'); ` + type('phone', '12') + ` APP.cmd('askRun','');`, [
    ['the sheet stays open with the reason', `sheetText().includes('phone number will not work')`],
    ['and nothing was sent',                 `!${method('PATCH')}`],
  ]],
  ['adding a customer needs a name or a number', STUB + ALL + `
    state.custLoaded=true; state.customers=[]; APP.cmd('tab','customers'); APP.cmd('custNew');
    APP.cmd('askRun','');`, [
    ['it says which',    `sheetText().includes('A name or a phone number')`],
    ['and sends nothing', `!${method('POST')}`],
  ]],
  ['and then posts one', STUB + ALL + `
    state.custLoaded=true; state.customers=[]; APP.cmd('tab','customers'); APP.cmd('custNew');
    ` + type('nickname', 'Walk-in') + type('phone', '13800000001') + ` APP.cmd('askRun','');`, [
    ['to the roster endpoint', sent('/customers')],
    ['as a POST',              method('POST')],
    ['carrying the number it dedupes on', body('"phone":"13800000001"')],
  ]],
  ['signing every device out', STUB + ALL + REC + `render();
    APP.cmd('forceLogout'); APP.cmd('askRun','');`, [
    ['names how many there are', `${sent('/force-logout')}`],
    ['as a POST',                method('POST')],
  ]],
  ['stopping somebody referring', STUB + ALL + REC + `render();
    APP.cmd('custRefBlock'); APP.cmd('askRun','');`, [
    ['hits affiliate-block',  sent('/affiliate-block')],
    ['and says what survives it', `true`],
  ]],
  ['the ongoing share', STUB + ALL + REC + `render();
    APP.cmd('custRefShare'); APP.cmd('askRun','');`, [
    ['is the affiliate endpoint, not a customers one', sent('/affiliate/eligible')],
    ['and names the customer',                         body('"customerId":1')],
  ]],
  // 'everyone' mode: this customer already earns the share, so a per-person
  // switch would be a control that changes nothing. The desktop's own rule.
  ['and it is absent where it would mean nothing', ALL + REC + `
    state.custDetail.affiliate.lifetime_mode='everyone'; render();`, [
    ['no switch', `!document.querySelector('[onclick*="custRefShare"]')`],
    ['no row',    `!sheetText().includes('Ongoing share')`],
  ]],
  ['reissuing the code', STUB + ALL + REC + `render();
    APP.cmd('custRefReissue'); APP.cmd('askRun','');`, [
    ['posts to referral-code', sent('/referral-code')],
  ]],

  // ── Addresses ───────────────────────────────────────────────────────────
  ['a new address reads its province off the picked city', STUB + ALL + REC + `render();
    APP.cmd('caddrOpen','');
    state.onw.cities=[{name_cn:'广州市',name_en:'Guangzhou',province_cn:'广东省'}];
    state.caddr.cityQ='广州'; render(); APP.cmd('caddrPickCity',0);`, [
    ['the city is set',          `state.caddr.city==='广州市'`],
    ['and the province with it', `state.caddr.province==='广东省'`],
    ['nobody typed it',          `!document.getElementById('mCaddr_province')`],
  ]],
  ['the three the endpoint requires are refused here first', STUB + ALL + REC + `render();
    APP.cmd('caddrOpen',''); APP.cmd('caddrSet','recipient_name','A'); APP.cmd('caddrSave');`, [
    ['the sheet says which', `state.caddr && state.caddr.err.indexOf('Recipient')>=0`],
    ['and nothing is sent',  `!${method('POST')}`],
  ]],
  ['a complete one saves', STUB + ALL + REC + `render();
    APP.cmd('caddrOpen','');
    APP.cmd('caddrSet','recipient_name','Chen Meiling');
    APP.cmd('caddrSet','phone','13800002841');
    APP.cmd('caddrSet','address','天河路 1 号');
    APP.cmd('caddrDefault'); APP.cmd('caddrSave');`, [
    ['to the addresses collection', sent('/customers/1/addresses')],
    ['as a POST',                   method('POST')],
    ['with the default flag',       body('"is_default":true')],
  ]],
  ['editing one is a PUT to its own id', STUB + ALL + REC + `render();
    APP.cmd('caddrOpen','7'); APP.cmd('caddrSet','detail','4 楼 402'); APP.cmd('caddrSave');`, [
    ['the form opens on that address', `state.caddr && state.caddr.id===7 && state.caddr.city==='广州市'`],
    ['and saves to it',                sent('/customers/1/addresses/7')],
    ['as a PUT',                       method('PUT')],
  ]],
  ['deleting one asks first', STUB + ALL + REC + `render(); APP.cmd('caddrDelete','8');`, [
    ['it shows which address', `sheetText().includes('深南大道 2 号')`],
    ['nothing sent yet',       `!${method('DELETE')}`],
  ]],
  ['and then deletes it', STUB + ALL + REC + `render(); APP.cmd('caddrDelete','8'); APP.cmd('askRun','');`, [
    ['by id',        sent('/customers/1/addresses/8')],
    ['as a DELETE',  method('DELETE')],
  ]],
  // The record sheet is the address sheet's parent and it cannot outlive it.
  ['closing the record takes the address form with it', ALL + REC + `render();
    APP.cmd('caddrOpen',''); APP.cmd('closeCustomer');`, [
    ['no orphan form', `state.caddr===null`],
  ]],

  // ── Who may do any of it ────────────────────────────────────────────────
  // The gate is not politeness. apiWrite reads a 403 as a lost session, so an
  // ungated control logs the operator out of the app.
  ['an operator who may only look sees nothing that writes', VIEW + REC + `render();`, [
    ['no Points',   `!document.querySelector('[onclick*="adjustPoints"]')`],
    ['no Wallet',   `!document.querySelector('[onclick*="adjustWallet"]')`],
    ['no Edit',     `!document.querySelector('[onclick*="editCustomer"]')`],
    ['no Message',  `!document.querySelector('[onclick*="messageCustomer"]')`],
    ['no Block',    `!document.querySelector('[onclick*="toggleBlock"]')`],
    ['no sign-out', `!document.querySelector('[onclick*="forceLogout"]')`],
    ['nothing beside the note or the tags', `!document.querySelector('[onclick*="editCustNote"]') && !document.querySelector('[onclick*="editCustTags"]')`],
    ['nor on the addresses', `!document.querySelector('[onclick*="caddrOpen"]') && !document.querySelector('[onclick*="caddrDelete"]')`],
    // …and the record is still fully readable. A gate that empties the screen
    // is the wrong gate: this operator's job is to read it.
    ['but the record still reads',  `sheetText().includes('Chen Meiling') && sheetText().includes('Allergic to nuts')`],
    ['addresses included',          `sheetText().includes('天河路 1 号')`],
  ]],
  ['and the command itself refuses, not only the button', STUB + VIEW + REC + `render();
    APP.cmd('adjustPoints'); APP.cmd('editCustomer'); APP.cmd('toggleBlock');
    APP.cmd('caddrOpen',''); APP.cmd('editCustNote');`, [
    // A guard the VIEW enforces is a guard APP.cmd walks straight past — the
    // §112 finding, in this section's own words.
    ['no ask sheet opened', `state.ask===null`],
    ['no address form',     `state.caddr===null`],
    ['and nothing sent',    `window.__sent.length===0`],
  ]],
  ['customer service may write but not move money', SERVE + REC + `render();`, [
    ['Message is offered',  `!!document.querySelector('[onclick*="messageCustomer"]')`],
    ['Edit is offered',     `!!document.querySelector('[onclick*="editCustomer"]')`],
    ['Points is not',       `!document.querySelector('[onclick*="adjustPoints"]')`],
    ['Wallet is not',       `!document.querySelector('[onclick*="adjustWallet"]')`],
    ['Block is not',        `!document.querySelector('[onclick*="toggleBlock"]')`],
    ['the addresses are theirs to fix', `!!document.querySelector('[onclick*="caddrOpen"]')`],
  ]],
  ['export is its own capability', SERVE + `state.custLoaded=true; state.customers=[];
    APP.cmd('tab','customers');`, [
    // The file carries wallet balances and lifetime spend out of the building,
    // which is why lib/capabilities.js marks customers:export money:'shows'.
    ['not offered without it', `!document.querySelector('[onclick*="custExport"]')`],
    ['though Add is',          `!!document.querySelector('[onclick*="custNew"]')`],
  ]],
  // Fail-open is deliberate and matches the desktop's can(): caps are null only
  // on a resolution hiccup, and locking an owner out of their own app over one
  // is worse than showing a row they cannot use.
  ['unknown permissions fail open', `state.caps=null;` + REC + `render();`, [
    ['everything is offered', `!!document.querySelector('[onclick*="adjustPoints"]') && !!document.querySelector('[onclick*="toggleBlock"]')`],
  ]],
];

run('customers', CASES);
