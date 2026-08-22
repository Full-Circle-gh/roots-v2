import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';

/* ══ Inbox — two Worklists behind one sub-view strip ══════════════════════ */
const inboxHead = (status = true) => `
  <div class="page-head">
    <div style="flex:1;min-width:0">
      <h1>Inbox</h1>
      ${status ? '<p class="status-line">2 reviews need a reply</p>' : ''}
    </div>
  </div>`;
const inboxViews = (active) => `
  <div class="subviews">
    ${['Reviews', 'Feedback'].map(l => `<button class="subview${l === active ? ' on' : ''}">${l}</button>`).join('\n    ')}
  </div>
  <div style="height:16px;flex:none"></div>`;

const stars = (n) => `<span style="display:flex;align-items:center;gap:4px;color:var(--td-text2);font-size:13px" class="num">
          <span style="width:14px;height:14px;display:block;color:var(--td-amber-ink)">${I.star}</span>${n}</span>`;

const review = ({ name, rating, text, when, replied, unseen }) => `
      <div class="ordcard${unseen ? ' unseen' : ''}" style="gap:12px">
        <div class="ord-mid">
          <span style="display:flex;align-items:center;gap:12px;min-width:0">
            <span class="ord-name">${name}</span>${stars(rating)}
          </span>
          ${replied ? '<span class="pill p-mute">Replied</span>' : ''}
        </div>
        <p style="margin:0;font-size:15px;color:var(--td-text2)">${text}</p>
        <div class="ord-bot">
          <span class="num">${when}</span>
          ${replied ? '' : '<button class="btn btn-secondary btn-row" style="min-height:44px;padding:0 16px;font-size:13px">Reply</button>'}
        </div>
      </div>`;

const REVIEWS = [
  review({ name: 'Chen Meiling', rating: '5.0', text: 'Fast delivery, and the carrots were still cold when they arrived.', when: '2h ago', unseen: true }),
  review({ name: 'Zhang Wei', rating: '3.0', text: 'One parcel was a day late. Support sorted it out the same morning.', when: 'Yesterday', unseen: true }),
  review({ name: 'Sarah Lim', rating: '4.0', text: 'Great oat milk. I wish the cold brew came in a larger size.', when: 'Jul 27', replied: true }),
].join('');

writeFileSync(join(OUT, 'Inbox.dc.html'), doc('Inbox', `
<div class="screen">
  ${topbar()}
  ${inboxHead()}
  ${inboxViews('Reviews')}
  <div class="body" style="gap:16px">${REVIEWS}</div>
  ${tabbar('more', { more: true })}
</div>`));

writeFileSync(join(OUT, 'InboxEmpty.dc.html'), doc('Inbox · empty', `
<div class="screen">
  ${topbar({ inboxDot: false })}
  ${inboxHead(false)}
  ${inboxViews('Feedback')}
  <div class="body" style="justify-content:center;align-items:center;gap:16px;padding-bottom:80px;text-align:center">
    <p style="margin:0;font-size:18px;font-weight:500">Nothing needs you</p>
    <p style="margin:0;max-width:260px;font-size:15px;color:var(--td-text2)">Every note customers have sent has an answer. Enjoy it.</p>
  </div>
  ${tabbar('more')}
</div>`));

/* ══ The reply — the one write flow on this page ══════════════════════════ */
writeFileSync(join(OUT, 'Reply.dc.html'), doc('Reply', `
<div class="screen">
  ${topbar()}
  ${inboxHead()}
  ${inboxViews('Reviews')}
  <div class="body" style="gap:16px">${REVIEWS}</div>
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:480px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;padding:8px 16px 16px;border-bottom:1px solid var(--td-border)">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:18px;font-weight:500">Chen Meiling</span>
        ${stars('5.0')}
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:16px">
      <p style="margin:0;font-size:15px;color:var(--td-text2)">Fast delivery, and the carrots were still cold when they arrived.</p>
      <div style="margin-top:16px;border:1px solid var(--td-border);border-radius:8px;padding:12px 16px;min-height:120px;background:var(--td-surface)">
        <span style="font-size:15px;color:var(--td-text2)">Write a reply…</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" style="flex:1">Send reply</button>
      </div>
      <p class="cap" style="margin:16px 0 0">Replies appear under the review in the mini app, signed with the store name.</p>
    </div>
  </div>
</div>`));

/* ══ Delivery — A4 Console ════════════════════════════════════════════════ */
const crow = (label, desc, right) => `
        <div class="crow">
          <span class="crow-main"><b>${label}</b>${desc ? `<span class="cap" style="display:block">${desc}</span>` : ''}</span>
          ${right}
        </div>`;
const sw = (on) => `<span class="switch${on ? ' on' : ''}"><span></span></span>`;
const val = (v) => `<span class="crow-val">${v}</span><span style="flex:none;width:20px;height:20px;color:var(--td-text2);margin-left:8px">${I.chev}</span>`;
const group = (title, rows) => `
    <section style="flex:none">
      <h2 class="sec-title" style="margin-bottom:8px">${title}</h2>
      <div class="card" style="overflow:hidden">${rows}</div>
    </section>`;

writeFileSync(join(OUT, 'Delivery.dc.html'), doc('Delivery', `
<div class="screen">
  ${topbar()}
  <div class="page-head"><div style="flex:1;min-width:0"><h1>Delivery</h1></div></div>
  <div class="body" style="gap:24px">
    ${group('Zones', crow('Guangzhou', '6 zones', val('')) + crow('Base fee', '', val('¥12')))}
    ${group('Timing', crow('Cut-off', 'Orders after this ship tomorrow', val('6:00 PM'))
      + crow('Lead time', '', val('90 min'))
      + crow('Holiday mode', 'Off. Orders are being accepted.', sw(false)))}
    ${group('Automation', `
        <div class="crow">
          <span class="crow-main"><b>Route to the nearest store</b><span class="cap" style="display:block">Picked Tianhe for 14 orders today.</span></span>
          <span class="pill" style="background:var(--td-dusk-tint);color:var(--td-dusk);gap:8px"><span class="dusk-dot"></span>On</span>
        </div>` + crow('Pause when stock runs out', '', sw(true)))}
  </div>
  ${tabbar('more', { more: true })}
</div>`));

/* ══ Sales — A5 Board ═════════════════════════════════════════════════════ */
const bcard = ({ glyph, name, status, dot, metrics, action, viewOnly }) => `
      <div class="bcard">
        <div class="bhead">
          <span class="bglyph">${glyph}</span>
          <span style="flex:1;min-width:0">
            <span style="display:flex;align-items:center;gap:8px;min-width:0">
              <span style="font-size:15px;font-weight:500">${name}</span>
              ${viewOnly ? '<span class="pill p-mute" style="font-style:italic">View only</span>' : ''}
            </span>
            <span style="display:flex;align-items:center;gap:8px;margin-top:4px">
              <span class="dot" style="background:var(--td-${dot})"></span>
              <span class="cap">${status}</span>
            </span>
          </span>
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px">
          <span class="cap num">${metrics}</span>
          <span style="display:flex;align-items:center;gap:4px;flex:none;font-size:15px;font-weight:500">${action}
            <span style="width:20px;height:20px;display:block;color:var(--td-text2)">${I.chev}</span></span>
        </div>
      </div>`;

const BOARD = [
  bcard({ glyph: I.miniapp, name: 'Mini app', status: 'Connected', dot: 'sage', metrics: '28 orders · ¥7,120', action: 'Manage' }),
  bcard({ glyph: I.web, name: 'Web store', status: 'Connected', dot: 'sage', metrics: '9 orders · ¥2,180', action: 'Manage' }),
  bcard({ glyph: I.bike, name: 'Meituan', status: 'Live · mirrored', dot: 'sage', metrics: '6 orders · ¥540', action: 'View', viewOnly: true }),
  bcard({ glyph: I.box, name: 'gzgrocery', status: 'Synced 4 min ago', dot: 'sage', metrics: '2 pickups · ¥1,600', action: 'View', viewOnly: true }),
  bcard({ glyph: I.utensils, name: 'Eleme', status: 'Not connected', dot: 'text2', metrics: 'Nothing is coming in from here', action: 'Set up' }),
].join('');

writeFileSync(join(OUT, 'Sales.dc.html'), doc('Sales', `
<div class="screen">
  ${topbar()}
  <div class="page-head"><div style="flex:1;min-width:0"><h1>Sales</h1></div></div>
  <div class="body" style="gap:16px">
    ${BOARD}
  </div>
  ${tabbar('more', { more: true })}
</div>`));

/* ══ Channel detail — a Console with a read-only Worklist under it ════════ */
writeFileSync(join(OUT, 'ChannelDetail.dc.html'), doc('Meituan', `
<div class="screen">
  ${topbar()}
  <div class="page-head" style="padding-top:12px">
    <div style="flex:1;min-width:0">
      <button class="btn btn-ghost" style="min-height:36px;margin:0 0 4px -8px;font-size:13px;font-weight:500;gap:4px">
        <span style="width:16px;height:16px;display:block">${I.back}</span>Sales</button>
      <h1>Meituan</h1>
    </div>
  </div>
  <div class="body" style="gap:24px">
    ${group('Connection', crow('Store', '', val('天河店')) + crow('Auto-accept orders', 'Orders enter Preparing without you', sw(true)) + crow('Menu sync', 'Last run 4 min ago', val('On')))}
    <section style="flex:none">
      <h2 class="sec-title" style="margin-bottom:4px">Orders from Meituan</h2>
      <p class="cap" style="margin:0 0 16px">Mirrored from the platform. Acted on there, never here.</p>
      <div class="card" style="overflow:hidden">
        ${[['MT-…044', 'Li Na', '¥95', 'Out for delivery'], ['MT-…031', 'Mr Wang', '¥142', 'Completed'], ['MT-…028', 'Ms Liu', '¥68', 'Completed']]
          .map(([id, name, total, status], i) => `
        <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;${i ? 'border-top:1px solid var(--td-border);' : ''}">
          <span style="flex:1;min-width:0">
            <span class="num" style="display:block;font-size:15px">${id}</span>
            <span class="cap" style="display:block">${name} · <span style="font-style:italic">${status}</span></span>
          </span>
          <span class="num" style="flex:none;font-size:15px">${total}</span>
        </div>`).join('')}
      </div>
    </section>
  </div>
  ${tabbar('more', { more: true })}
</div>`));

console.log('wrote Inbox, InboxEmpty, Reply, Delivery, Sales, ChannelDetail');
