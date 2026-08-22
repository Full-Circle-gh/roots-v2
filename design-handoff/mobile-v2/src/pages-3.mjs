import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, MARK, topbar, tabbar, doc, OUT } from './build.mjs';
import { ordersHead, ordersChips, ORDERS, chips } from './pages-2.mjs';

/* ══ More — the flat sheet. No drill-down on a phone ══════════════════════ */
const moreRow = (icon, label, first) => `
        <button style="display:flex;align-items:center;gap:16px;width:100%;min-height:52px;padding:8px 16px;background:none;border:0;${first ? '' : 'border-top:1px solid var(--td-border);'}text-align:left;font-family:var(--ui);font-size:15px;color:var(--td-text);cursor:pointer">
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${icon}</span>
          <span style="flex:1;min-width:0">${label}</span>
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${I.chev}</span>
        </button>`;
const moreGroup = (name, rows) => `
      <h3 style="margin:24px 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">${name}</h3>
      <div class="card" style="overflow:hidden">${rows.map((r, i) => moreRow(r[0], r[1], i === 0)).join('')}</div>`;

writeFileSync(join(OUT, 'MoreSheet.dc.html'), doc('More sheet', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  ${ordersChips}
  <div class="body" style="gap:16px">${ORDERS}</div>
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:692px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;padding:8px 16px 0">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <h2 style="margin:0;font-size:18px;font-weight:500">More</h2>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">
      ${moreGroup('Operations', [[I.invoice, 'Invoices'], [I.truck, 'Delivery'], [I.box, 'Purchasing'], [I.inbox, 'Inbox']])}
      ${moreGroup('Marketing', [[I.ticket, 'Coupons'], [I.chart, 'Flash sales'], [I.megaphone, 'Broadcasts']])}
      ${moreGroup('Loyalty & wallet', [[I.users, 'Members'], [I.wallet, 'Wallet']])}
    </div>
  </div>
</div>`));

/* ══ Orders · loading — skeleton at --td-raised, never a spinner ══════════ */
const bar = (w, h = 12, mt = 0) => `<span style="display:block;width:${w};height:${h}px;border-radius:999px;background:var(--td-raised)${mt ? `;margin-top:${mt}px` : ''}"></span>`;
const skelCard = () => `
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;gap:16px">${bar('40%')}${bar('20%')}</div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin-top:16px">${bar('34%', 16)}${bar('26%', 24)}</div>
        ${bar('56%', 12, 16)}
      </div>`;

writeFileSync(join(OUT, 'OrdersLoading.dc.html'), doc('Orders · loading', `
<div class="screen">
  ${topbar()}
  ${ordersHead({ status: false })}
  <div class="chiprow">${chips([['All'], ['Paid'], ['Preparing'], ['Dispatched'], ['Delivered']])}</div>
  <div style="height:16px;flex:none"></div>
  <div class="body" style="gap:16px">${skelCard()}${skelCard()}${skelCard()}${skelCard()}</div>
  ${tabbar('orders', { more: true })}
</div>`));

/* ══ Orders · empty — a compliment, not an apology ════════════════════════ */
const flatWave = `<span style="display:block;width:140px;height:46px;color:var(--td-border)">${MARK}</span>`;

writeFileSync(join(OUT, 'OrdersEmpty.dc.html'), doc('Orders · empty', `
<div class="screen">
  ${topbar({ inboxDot: false })}
  ${ordersHead({ status: false })}
  <div class="body" style="justify-content:center;align-items:center;gap:16px;padding-bottom:80px;text-align:center">
    ${flatWave}
    <p style="margin:0;font-size:18px;font-weight:500">No orders yet</p>
    <p style="margin:0;max-width:260px;font-size:15px;color:var(--td-text2)">New orders settle in here from every channel — mini app, web, Meituan.</p>
  </div>
  ${tabbar('orders')}
</div>`));

/* ══ Orders · no results — plenty here; the filter matched none of it ═════ */
writeFileSync(join(OUT, 'OrdersNoResults.dc.html'), doc('Orders · no results', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  <div class="chiprow">
    <span class="chip on">Chen Jing<span style="width:14px;height:14px;display:block;margin-right:-2px">${I.close}</span></span>
    ${chips([['All', 47], ['Paid', 8], ['Preparing', 6]])}
  </div>
  <div style="height:16px;flex:none"></div>
  <div class="body" style="justify-content:center;align-items:center;gap:16px;padding-bottom:120px;text-align:center">
    <p style="margin:0;font-size:18px;font-weight:500">No orders match “Chen Jing”</p>
    <p style="margin:0;max-width:250px;font-size:15px;color:var(--td-text2)">47 orders are here, behind the search.</p>
    <button class="btn btn-secondary">Clear search</button>
  </div>
  ${tabbar('orders', { more: true })}
</div>`));

/* ══ Write states — in flight, error, silent refresh ══════════════════════ */
const stateBlock = (title, caption, demo) => `
    <section>
      <h2 class="sec-title" style="margin-bottom:4px">${title}</h2>
      <p class="cap" style="margin:0 0 16px">${caption}</p>
      ${demo}
    </section>`;

writeFileSync(join(OUT, 'WriteStates.dc.html'), doc('Write states', `
<div style="width:390px;background:var(--td-paper);padding:24px 16px;display:flex;flex-direction:column;gap:32px">
  ${stateBlock('In flight', 'The control you pressed disables and says so. No spinner, no page dim, no overlay.',
    '<button class="btn btn-secondary" disabled style="width:100%">Marking dispatched…</button>')}
  ${stateBlock('Error', 'It renders where the operator is looking and stays until acknowledged. Never a toast.', `
      <div style="display:flex;gap:16px;padding:16px;border-radius:14px;background:var(--td-brick-tint)">
        <span style="flex:none;width:20px;height:20px;color:var(--td-brick-ink)">${I.warn}</span>
        <span style="min-width:0">
          <span style="display:block;font-size:15px;color:var(--td-brick-ink)">The refund did not go through.</span>
          <span class="cap" style="display:block;color:var(--td-brick-ink)">Meituan rejected it. Refund this order in Meituan, or try again in a minute.</span>
        </span>
      </div>`)}
  ${stateBlock('Silent refresh', 'Pollers repaint in place. The new order fades in carrying the unseen surface and its Sage edge — nothing turns red on arrival, nothing resizes, nothing jumps.', `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="ordcard unseen">
          <div class="ord-top"><span class="ord-id"><span style="width:16px;height:16px;display:block">${I.miniapp}</span>RT-…048 · 2:31 PM</span><span class="ord-total">¥94</span></div>
          <div class="ord-mid"><span class="ord-name">Zheng Hao</span><span class="pill p-sage">Paid</span></div>
        </div>
        <div class="ordcard">
          <div class="ord-top"><span class="ord-id"><span style="width:16px;height:16px;display:block">${I.miniapp}</span>RT-…047 · 2:22 PM</span><span class="ord-total">¥312</span></div>
          <div class="ord-mid"><span class="ord-name">Chen Meiling</span><span class="pill p-sage">Paid</span></div>
        </div>
      </div>
`)}
</div>`, { preview: '390,700' }));

console.log('wrote MoreSheet, OrdersLoading, OrdersEmpty, OrdersNoResults, WriteStates');
