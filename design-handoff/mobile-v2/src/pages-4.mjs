import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';
import { chips } from './pages-2.mjs';

/* ══ Customers — A1 Worklist. Title alone: 693 records, none waiting ══════ */
const cusCard = ({ initial, name, phone, tier, orders, ordered, seen, unseen, blocked, zero }) => `
      <div class="reccard${unseen ? ' unseen' : ''}">
        <span class="mono">${initial}</span>
        <span class="rec-main">
          <span class="rec-name"><b>${name}</b><span class="pill ${tier[1]}">${tier[0]}</span>${blocked ? '<span class="pill p-brick">Blocked</span>' : ''}</span>
          <span class="rec-sub">${phone} · ${orders}</span>
        </span>
        <span class="rec-side">
          <span class="num${zero ? ' zero' : ''}" style="display:block;font-size:15px;font-weight:500">${ordered}</span>
          <span class="cap num" style="display:block">${seen}</span>
        </span>
      </div>`;

const CUSTOMERS = [
  cusCard({ initial: 'C', name: 'Chen Meiling', phone: '138****2841', tier: ['Tree', 'p-mute'], orders: '24 orders', ordered: '¥6,240', seen: '2h ago', unseen: true }),
  cusCard({ initial: 'S', name: 'Sarah Lim', phone: '159****7723', tier: ['Tree', 'p-mute'], orders: '18 orders', ordered: '¥4,180', seen: 'Yesterday', unseen: true }),
  cusCard({ initial: 'Z', name: 'Zhang Wei', phone: '186****0092', tier: ['Root', 'p-mute'], orders: '9 orders', ordered: '¥2,260', seen: 'Jul 24' }),
  cusCard({ initial: 'W', name: 'Wang Zhiqiang', phone: '137****5510', tier: ['Sprout', 'p-mute'], orders: '3 orders', ordered: '¥812', seen: 'Jun 30' }),
  cusCard({ initial: 'W', name: 'Wu Yaqi', phone: '188****3320', tier: ['Seed', 'p-mute'], orders: 'No orders', ordered: '¥0', seen: 'May 2', zero: true }),
].join('');

const cusHead = `
  <div class="page-head">
    <div style="flex:1;min-width:0"><h1>Customers</h1></div>
  </div>
  <p class="cap num" style="margin:0;padding:0 16px 16px;flex:none">412 buyers · 41% returning · 281 never ordered</p>`;

const cusChips = `
  <div class="chiprow">${chips([['All', 693, true], ['New this week', 12], ['Sleeping 60d+', 84]])}</div>
  <div style="height:8px;flex:none"></div>
  <div class="chiprow">${chips([['All tiers', null, true], ['Tree'], ['Root'], ['Sprout'], ['Seed']])}</div>
  <div style="height:16px;flex:none"></div>`;

writeFileSync(join(OUT, 'Customers.dc.html'), doc('Customers', `
<div class="screen">
  ${topbar()}
  ${cusHead}
  ${cusChips}
  <div class="body" style="gap:16px">${CUSTOMERS}</div>
  ${tabbar('customers', { more: true })}
</div>`));

/* ══ Customers · found but filtered — the state the live page ships ═══════ */
writeFileSync(join(OUT, 'CustomersFiltered.dc.html'), doc('Customers · filtered', `
<div class="screen">
  ${topbar()}
  ${cusHead}
  <div class="chiprow">
    <span class="chip on">Chen Jing<span style="width:14px;height:14px;display:block;margin-right:-4px">${I.close}</span></span>
    ${chips([['All', 693], ['New this week', 12]])}
  </div>
  <div style="height:16px;flex:none"></div>
  <div class="body" style="justify-content:center;align-items:center;gap:16px;padding-bottom:120px;text-align:center">
    <p style="margin:0;font-size:18px;font-weight:500">Found — but your filters are hiding them</p>
    <p style="margin:0;max-width:270px;font-size:15px;color:var(--td-text2)">1 customer matching “Chen Jing” is blocked, and blocked accounts show up nowhere but the Blocked list.</p>
    <button class="btn btn-secondary">Show the blocked match</button>
  </div>
  ${tabbar('customers', { more: true })}
</div>`));

/* ══ Customer record — the drawer, on a phone ═════════════════════════════ */
const snap = (label, value) => `
          <span style="min-width:0">
            <span class="cap" style="display:block;line-height:1.4">${label}</span>
            <span class="num" style="display:block;font-size:18px;font-weight:500;line-height:1.4">${value}</span>
          </span>`;
const ord = (id, when, total, first) => `
        <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;${first ? '' : 'border-top:1px solid var(--td-border);'}">
          <span style="flex:1;min-width:0">
            <span class="num" style="display:block;font-size:15px">${id}</span>
            <span class="cap num" style="display:block">${when}</span>
          </span>
          <span class="num" style="flex:none;font-size:15px">${total}</span>
        </div>`;
const acc = (label, count, first) => `
        <button style="display:flex;align-items:center;gap:16px;width:100%;min-height:56px;padding:8px 16px;background:none;border:0;${first ? '' : 'border-top:1px solid var(--td-border);'}text-align:left;font-family:var(--ui);font-size:15px;color:var(--td-text);cursor:pointer">
          <span style="flex:1;min-width:0">${label}</span>
          <span class="cap num" style="flex:none">${count}</span>
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${I.chev}</span>
        </button>`;

writeFileSync(join(OUT, 'CustomerSheet.dc.html'), doc('Customer record', `
<div class="screen">
  ${topbar()}
  ${cusHead}
  ${cusChips}
  <div class="body" style="gap:16px">${CUSTOMERS}</div>
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:660px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;background:var(--td-surface);padding:8px 16px 16px">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <span class="mono">C</span>
        <span style="font-size:18px;font-weight:500;min-width:0">Chen Meiling</span>
        <span class="pill p-mute">Tree</span>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
      <p class="cap num" style="margin:4px 0 0">138****2841</p>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">
      <div class="raised" style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:16px;padding:16px">
        ${snap('Ordered', '¥6,240')}
        ${snap('Orders', '24')}
        ${snap('Avg. order', '¥260')}
        ${snap('Points', '2,410')}
        ${snap('Wallet', '¥86')}
        ${snap('Since', 'Mar 2025')}
      </div>
      <p class="cap" style="margin:8px 0 16px">Ordered is the goods total before discounts — the same measure the list column shows.</p>
      <h3 style="margin:0 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">Recent orders</h3>
      <div class="card" style="overflow:hidden">
        ${ord('RT-…047', 'Jul 29', '¥312', true)}
        ${ord('RT-…041', 'Jul 27', '¥164')}
        ${ord('RT-…036', 'Jul 22', '¥298')}
      </div>
      <h3 style="margin:16px 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">Addresses</h3>
      <div class="card" style="padding:12px 16px;font-size:15px">Guangzhou · Tianhe · Tower B</div>
      <p class="cap" style="margin:16px 0 0">No app errors in 7 days</p>
    </div>
  </div>
</div>`));

console.log('wrote Customers, CustomersFiltered, CustomerSheet');
