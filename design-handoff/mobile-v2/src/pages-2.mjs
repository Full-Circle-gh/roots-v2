import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';

/* ══ Orders — A1 Worklist. Rows on desktop, cards on the phone ════════════ */
const chips = (rows) => rows.map(([label, count, on]) =>
  `<span class="chip${on ? ' on' : ''}">${label}${count != null ? `<span class="c">${count}</span>` : ''}</span>`).join('');

const STATUS_CHIPS = [['All', 47, true], ['Paid', 8], ['Preparing', 6], ['Dispatched', 11], ['Delivered', 15], ['Awaiting restock', 2]];
const CHANNEL_CHIPS = [['All channels', 47, true], ['Mini app', 28], ['Web', 9], ['Meituan', 6], ['Manual', 2]];

const ordCard = ({ ch, id, at, total, name, pill, pillKind, ship, by, byAmber, unseen, viewOnly }) => `
      <div class="ordcard${unseen ? ' unseen' : ''}">
        <div class="ord-top">
          <span class="ord-id"><span style="width:16px;height:16px;display:block">${ch}</span>${id} · ${at}</span>
          <span class="ord-total">${total}</span>
        </div>
        <div class="ord-mid">
          <span class="ord-name">${name}</span>
          <span class="pill p-${pillKind}">${pill}</span>
        </div>
        <div class="ord-bot">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ship}</span>
          ${viewOnly ? '<span class="pill p-mute" style="font-style:italic">View only</span>'
                     : `<span class="when${byAmber ? ' amber' : ''}">${by}</span>`}
        </div>
      </div>`;

const ORDERS = [
  ordCard({ ch: I.miniapp, id: 'RT-…047', at: '2:22 PM', total: '¥312', name: 'Chen Meiling', pill: 'Paid', pillKind: 'sage', ship: 'Guangzhou · Tianhe', by: 'Ship by 6:00 PM · 3h left', byAmber: true, unseen: true }),
  ordCard({ ch: I.web, id: 'RT-…046', at: '2:07 PM', total: '¥186', name: 'Sarah Lim', pill: 'Paid', pillKind: 'sage', ship: 'Guangzhou · Yuexiu', by: 'Ship by 6:00 PM', unseen: true }),
  ordCard({ ch: I.miniapp, id: 'RT-…045', at: '1:41 PM', total: '¥458', name: 'Wang Zhiqiang', pill: 'Preparing', pillKind: 'amber', ship: 'Pickup · Panyu store', by: 'Tomorrow 12:00 PM' }),
  ordCard({ ch: I.meituan, id: 'RT-…044', at: '1:15 PM', total: '¥95', name: 'Li Na', pill: 'Out for delivery', pillKind: 'amber', ship: 'Guangzhou · Haizhu', viewOnly: true }),
  ordCard({ ch: I.miniapp, id: 'RT-…039', at: '10:21 AM', total: '¥215', name: 'Huang Xiaoting', pill: 'Awaiting restock', pillKind: 'amber', ship: 'Guangzhou · Baiyun', by: 'Paused' }),
].join('');

const ordersHead = ({ status = true, cta = true } = {}) => `
  <div class="page-head">
    <div style="flex:1;min-width:0">
      <h1>Orders</h1>
      ${status ? '<p class="status-line">8 awaiting fulfilment</p>' : ''}
    </div>
    ${cta ? '<button class="btn btn-primary">New order</button>' : ''}
  </div>`;

const ordersChips = `
  <div class="chiprow">${chips(STATUS_CHIPS)}</div>
  <div style="height:8px;flex:none"></div>
  <div class="chiprow">${chips(CHANNEL_CHIPS)}</div>
  <div style="height:16px;flex:none"></div>`;

writeFileSync(join(OUT, 'Orders.dc.html'), doc('Orders', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  ${ordersChips}
  <div class="body" style="gap:16px">${ORDERS}</div>
  ${tabbar('orders', { more: true })}
</div>`));

/* ══ Order sheet — the drawer, on a phone ═════════════════════════════════ */
const sheetSection = (title, rows) => `
        <section style="padding:16px 0;border-top:1px solid var(--td-border)">
          <h3 style="margin:0 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">${title}</h3>
          ${rows}
        </section>`;
const kv = (k, v, opts = '') => `
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:4px 0">
            <span style="font-size:15px;min-width:0;${opts}">${k}</span>
            <span class="num" style="font-size:15px;flex:none">${v}</span>
          </div>`;

writeFileSync(join(OUT, 'OrderSheet.dc.html'), doc('Order sheet', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  ${ordersChips}
  <div class="body" style="gap:16px">${ORDERS}</div>
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:660px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;background:var(--td-surface);padding:8px 16px 16px">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <span class="num" style="font-size:18px;font-weight:500">RT-…047</span>
        <span class="pill p-sage">Paid</span>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" style="flex:1;min-height:44px">Mark dispatched</button>
        <button class="btn btn-secondary" style="width:44px;padding:0" aria-label="Print receipt"><span style="width:20px;height:20px;display:block">${I.printer}</span></button>
        <button class="btn btn-secondary" style="width:44px;padding:0" aria-label="More actions"><span style="width:20px;height:20px;display:block">${I.dots}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">
      ${sheetSection('Items', kv('2 × Oat milk 1L', '¥64') + kv('1 × Organic carrots 500g', '¥18') + kv('1 × Mixed nuts 250g', '¥45'))}
      ${sheetSection('Total', kv('Subtotal', '¥300') + kv('Delivery', '¥12') + `
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 0 0;margin-top:4px;border-top:1px solid var(--td-border)">
            <span style="font-size:15px;font-weight:500">Total</span>
            <span class="num" style="font-size:18px;font-weight:500">¥312</span>
          </div>`)}
      ${sheetSection('Fulfilment', `
          <div style="display:flex;align-items:center;gap:16px;padding:4px 0">
            <span style="font-size:15px">Tianhe store</span>
            <span class="pill" style="background:var(--td-dusk-tint);color:var(--td-dusk);gap:8px"><span class="dusk-dot"></span>Auto-routed</span>
          </div>
          <p class="cap" style="margin:4px 0 0">Nearest store to Tianhe, Guangzhou.</p>`)}
      ${sheetSection('Customer', kv('Chen Meiling', '138****2841') + kv('Tianhe, Guangzhou', '', 'color:var(--td-text2)'))}
    </div>
  </div>
</div>`));

console.log('wrote Orders.dc.html, OrderSheet.dc.html');

export { ordersHead, ordersChips, ORDERS, chips, ordCard };
