'use strict';

// Which marketing pop-ups the QR menu may show.
//
// popups.list is the mini app's campaign pop-up (Marketing → Pop-ups).
// "All pages" there means every mini-app page. It does not mean this menu:
// a pop-up already set to all pages must not start interrupting every table
// the day the menu learned to show one. The menu shows a pop-up only when
// its pages include 'qr-menu'. 'all' and 'qr-menu' may both be set; the
// mini app keeps reading 'all' and ignores 'qr-menu'.

const PAGE = 'qr-menu';

// The mini app's own clock for a pop-up's start and end (popup-manager.js
// todayKey): the UTC date, not the shop's. Both surfaces then open and close
// a pop-up on the same calendar line.
function todayUtc(now) {
  return new Date(now == null ? Date.now() : now).toISOString().slice(0, 10);
}

// Whether this phone should still see it. seenLocal / seenSession are the
// stored { ts, day } or null. The menu page inlines this function so the
// browser and the tests share one copy.
function showable(freq, seenLocal, seenSession, today) {
  if (freq === 'every_visit') return true;
  if (freq === 'session') return !seenSession;
  if (!seenLocal) return true;
  if (freq === 'once') return false;
  if (freq === 'daily') return seenLocal.day !== today;
  return true;
}

function safeImg(u) {
  const s = String(u || '').trim();
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

const FREQ = ['once', 'daily', 'session', 'every_visit'];

// The pop-ups this menu will consider, in list order. Frequency is left to
// the phone: the server does not know what that browser has already seen.
function forMenu(list, now) {
  const today = todayUtc(now);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || !p.id || !p.enabled) continue;
    const pages = Array.isArray(p.pages) ? p.pages : [];
    if (pages.indexOf(PAGE) < 0) continue;
    if (p.start_at && today < String(p.start_at)) continue;
    if (p.end_at && today > String(p.end_at)) continue;
    out.push({
      id: String(p.id),
      updated_at: p.updated_at || 0,
      trigger: p.trigger === 'after_seconds' ? 'after_seconds' : 'on_load',
      delay_seconds: Math.max(0, Number(p.delay_seconds) || 0),
      frequency: FREQ.indexOf(p.frequency) >= 0 ? p.frequency : 'once',
      dismissible: p.dismissible !== false,
      title_en: String(p.title_en || ''),
      title_cn: String(p.title_cn || ''),
      body_en: String(p.body_en || ''),
      body_cn: String(p.body_cn || ''),
      cta_label_en: String(p.cta_label_en || ''),
      cta_label_cn: String(p.cta_label_cn || ''),
      cta_target: String(p.cta_target || ''),
      image_url: safeImg(p.image_url),
    });
  }
  return out;
}

// Runs in the menu page. One pop-up, the first this browser has not already
// had, after its delay, and not over a sheet that is already open. The
// button adds the product it names, or scrolls to the category, then closes.
// Seen is remembered per version, the same key the mini app uses, so an edit
// shows the pop-up once more. The basket stays in memory only; this key is
// the pop-up's own stamp, not the order.
const CLIENT_SCRIPT = `(function(){
var showable=${showable.toString()};
function today(){return new Date().toISOString().slice(0,10)}
function read(store,k){try{var s=store.getItem(k);return s?JSON.parse(s):null}catch(e){return null}}
function write(store,k,v){try{store.setItem(k,v)}catch(e){/* private mode throws; the menu still opens */}}
function key(n){return 'popup_seen:'+n.getAttribute('data-id')+':'+(n.getAttribute('data-ver')||'0')}
function blocked(){
  var s=document.querySelectorAll('.sheet');
  for(var i=0;i<s.length;i++){if(!s[i].hidden&&s[i].className.indexOf('closing')<0)return true}
  var p=document.querySelectorAll('.pq');
  for(var j=0;j<p.length;j++){if(p[j].hasAttribute('data-qr-pop'))continue;if(!p[j].hidden)return true}
  return false}
function syncLock(){
  var up=blocked();
  var pops=document.querySelectorAll('[data-qr-pop]');
  for(var i=0;i<pops.length;i++){if(!pops[i].hidden)up=true}
  var r=document.documentElement;
  if(up)r.classList.add('sh-lock');else r.classList.remove('sh-lock')}
function hide(n){n.hidden=true;syncLock()}
function findAdd(id){
  var all=document.querySelectorAll('.add[data-add]');
  var hidden=null;
  for(var i=0;i<all.length;i++){
    if(all[i].getAttribute('data-add')!==id)continue;
    if(all[i].closest&&all[i].closest('.vadds')){if(!hidden)hidden=all[i]}
    else return all[i]}
  if(!hidden)return null;
  var card=hidden.closest?hidden.closest('.it'):null;
  return card?card.querySelector('.add[data-sizes]'):null}
function findNode(id){
  var all=document.querySelectorAll('[data-node]');
  for(var i=0;i<all.length;i++){if(all[i].getAttribute('data-node')===id)return all[i]}
  return null}
function act(n){
  var t=n.getAttribute('data-cta')||'';
  hide(n);
  var id='',kind='';
  if(t.indexOf('product:')===0){kind='product';id=t.slice(8)}
  else if(t.indexOf('category:')===0){kind='category';id=t.slice(9)}
  if(kind==='product'&&id){
    var btn=findAdd(id);
    if(!btn)return;
    var card=btn.closest?btn.closest('.it'):null;
    if(card&&card.scrollIntoView)card.scrollIntoView({block:'center'});
    setTimeout(function(){btn.click()},30);
    return}
  if(kind==='category'&&id){
    var el=findNode(id);
    if(el&&el.scrollIntoView)el.scrollIntoView({block:'start'})}}
var nodes=document.querySelectorAll('[data-qr-pop]');
var pick=null;
for(var i=0;i<nodes.length;i++){
  var n=nodes[i],freq=n.getAttribute('data-freq')||'once',k=key(n);
  var local=read(localStorage,k),sess=read(sessionStorage,k);
  if(showable(freq,local,sess,today())){pick=n;break}}
if(!pick)return;
function mark(n){
  var freq=n.getAttribute('data-freq')||'once';
  if(freq==='every_visit')return;
  var rec=JSON.stringify({ts:Date.now(),day:today()});
  write(freq==='session'?sessionStorage:localStorage,key(n),rec)}
var tries=0;
function reveal(){
  if(!pick.hidden)return;
  if(blocked()){if(++tries>40)return;setTimeout(reveal,500);return}
  pick.hidden=false;mark(pick);syncLock()}
var delay=pick.getAttribute('data-trig')==='after_seconds'?(parseInt(pick.getAttribute('data-delay'),10)||0):0;
if(delay<0)delay=0;
setTimeout(reveal,delay*1000);
document.addEventListener('click',function(e){
  var pop=e.target.closest?e.target.closest('[data-qr-pop]'):null;
  if(!pop||pop.hidden)return;
  e.preventDefault();e.stopPropagation();
  if(e.target.closest('[data-qr-x]')||e.target.closest('[data-qr-bg]')){
    if(pop.getAttribute('data-x')==='1')hide(pop);return}
  if(e.target.closest('[data-qr-go]'))act(pop);
},true);
})();`;

module.exports = { PAGE, todayUtc, showable, forMenu, CLIENT_SCRIPT };
