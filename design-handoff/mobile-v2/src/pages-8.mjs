/* ══ Batch five — Operations clarity. Two options, drawn to be chosen between.
   The argument, the evidence and a recommendation: docs/tacet-operations-clarity-options.md
   Re-run:  node src/pages-8.mjs
   ────────────────────────────────────────────────────────────────────────────
   ENGLISH ONLY, as every artboard here is (§1.11 — source carries the pair,
   one language ships). The proposed Chinese lives in the options document, with
   the live candidate it was copied or lifted from named for each one, and gets
   declared in docs/tacet-delivery-vocabulary.md by the build that ships it.
   Composing it here, for options that will mostly be discarded, would put
   rejected strings in the lock document. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, doc, OUT } from './build.mjs';
import { ordersHead } from './pages-2.mjs';

const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/* The rows this screen actually has carry fifteen icons build.mjs never needed.
   Same 24px grid, same 1.75 stroke, same one style — never emoji. */
const X = {
  filePlus:   S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 13v5"/><path d="M9.5 15.5h5"/>'),
  msg:        S('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 8h8"/><path d="M8 12h5"/>'),
  trendUp:    S('<path d="M3 17l6-6 4 4 7-7"/><path d="M14 8h6v6"/>'),
  cart:       S('<circle cx="9.5" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.2L21 7H6"/>'),
  trash:      S('<path d="M4 7h16"/><path d="M9.5 7V4h5v3"/><path d="M6.5 7l1 13h9l1-13"/>'),
  banknote:   S('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/>'),
  checkCheck: S('<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 15"/>'),
  calculator: S('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6.5h8"/><path d="M8.5 11h.01"/><path d="M12 11h.01"/><path d="M15.5 11h.01"/><path d="M8.5 15h.01"/><path d="M12 15h.01"/><path d="M15.5 15h.01"/><path d="M8.5 18.5h7"/>'),
  chefHat:    S('<path d="M7 18h10"/><path d="M7.5 14v4"/><path d="M16.5 14v4"/><path d="M12 3a4 4 0 0 0-3.7 2.5A3.5 3.5 0 0 0 7.5 14h9a3.5 3.5 0 0 0-.8-8.5A4 4 0 0 0 12 3z"/>'),
  boxPlus:    S('<path d="M20 12V7.5L12 3 4 7.5v9L12 21l3.5-2"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/><path d="M16.5 18.5h6"/><path d="M19.5 15.5v6"/>'),
  refresh:    S('<path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3.5 15.5"/><path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9l2.4 2.4"/><path d="M20.5 3.5v5h-5"/><path d="M3.5 20.5v-5h5"/>'),
  route:      S('<circle cx="6" cy="19" r="2.75"/><circle cx="18" cy="5" r="2.75"/><path d="M15.25 5H9.5a4 4 0 0 0 0 8h5a4 4 0 0 1 0 8H8.75"/>'),
  clipboard:  S('<rect x="8.5" y="2" width="7" height="4" rx="1"/><path d="M15.5 4H18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2.5"/><path d="M8.5 12h7"/><path d="M8.5 16h4.5"/>'),
  circleChk:  S('<circle cx="12" cy="12" r="9"/><path d="m8.25 12 2.5 2.5 5-5.5"/>'),
  receipt:    S('<path d="M5.5 3h13v18l-2.6-1.8-2.2 1.8-2.2-1.8-2.2 1.8L6.6 19.2 5.5 21z"/><path d="M9 8.5h6"/><path d="M9 12.5h6"/>'),
};

/* ── One More row. `pill` is the fact about the row that the label cannot
   carry: who it goes to, or that it is configuration rather than a task. It is
   always p-mute — a direction is a fact, not a state needing attention, the
   same reason tier pills are neutral (batch two). ───────────────────────── */
const row = (icon, label, first, pill) => `
        <div style="display:flex;align-items:center;gap:16px;width:100%;min-height:52px;padding:8px 16px;${first ? '' : 'border-top:1px solid var(--td-border);'}font-size:15px;color:var(--td-text)">
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${icon}</span>
          <span style="flex:1;min-width:0">${label}</span>
          ${pill ? `<span class="pill p-mute">${pill}</span>` : ''}
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${I.chev}</span>
        </div>`;
const group = (name, rows, mt = 24) => `
      <h3 style="margin:${mt}px 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">${name}</h3>
      <div class="card" style="overflow:hidden">${rows.map((r, i) => row(r[0], r[1], i === 0, r[2])).join('')}</div>`;

/* ── The sheet chrome MoreSheet.dc.html draws, lifted so both options are
   framed identically and only their contents differ. ───────────────────── */
const sheet = (inner, h = 692) => `
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:${h}px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;padding:8px 16px 0">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <h2 style="margin:0;font-size:18px;font-weight:500">More</h2>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">${inner}</div>
  </div>`;

/* ══ TODAY — the twenty-two rows as they ship, one heading over all of them.
   Drawn so the two options are compared against the truth and not a memory of
   it. Labels and order verbatim from public/m.html:4148–4166. ════════════ */
const TODAY = [
  [X.filePlus, 'New order'], [X.msg, 'Inbox'], [I.store, 'Sales'], [X.trendUp, 'Trend'],
  [I.truck, 'Delivery'], [X.receipt, 'Invoices'], [X.cart, 'Purchasing'], [I.box, 'Receiving'],
  [X.trash, 'Waste'], [X.banknote, 'Expense'], [X.checkCheck, 'Approvals'],
  [X.calculator, 'Counter till'], [X.chefHat, 'Kitchen queue'], [X.boxPlus, 'Add stock'],
  [X.refresh, 'Channel sync'], [X.chefHat, 'Ask the kitchen'], [I.box, 'Ask for stock'],
  [X.cart, 'Ask to buy'], [X.circleChk, 'Ready from the kitchen'], [I.truck, 'Receive delivery'],
  [X.route, 'Pick'], [X.clipboard, 'Log a batch'],
];

writeFileSync(join(OUT, 'OpsToday.dc.html'), doc('Operations · today', `
<div style="width:390px;background:var(--td-surface);padding:16px 16px 24px;display:flex;flex-direction:column">
  ${group('Operations', TODAY, 0)}
</div>`, { preview: '390,1240' }));

/* ══ OPTION A — grouped by the job, three renames, a pill where the label
   cannot carry the fact. Eight headings; no row gains a subtitle. ════════ */
const A_GROUPS = [
  ['Take an order',        [[X.filePlus, 'New order'], [X.calculator, 'Counter till']]],
  ['Money and numbers',    [[I.store, 'Sales'], [X.trendUp, 'Trend'], [X.receipt, 'Issue tax invoices']]],
  ['Send it out',          [[X.route, 'Pick'], [I.truck, 'Delivery settings', 'Settings']]],
  ['Stock coming in',      [[X.cart, 'Purchasing'], [I.box, 'Receive from a supplier'], [I.truck, 'Receive from another shop'], [X.boxPlus, 'Add stock']]],
  ['Making things',        [[X.chefHat, 'Kitchen queue'], [X.clipboard, 'Log a batch'], [X.circleChk, 'Ready from the kitchen']]],
  ['Ask someone else',     [[X.chefHat, 'Ask the kitchen', 'Ask'], [I.box, 'Ask for stock', 'Ask'], [X.cart, 'Ask to buy', 'Ask']]],
  ['Record and review',    [[X.trash, 'Waste'], [X.banknote, 'Expense'], [X.checkCheck, 'Approvals', 'Approve']]],
  ['Messages and channels',[[X.msg, 'Inbox'], [X.refresh, 'Channel sync']]],
];

writeFileSync(join(OUT, 'OpsGrouped.dc.html'), doc('Operations · option A', `
<div style="width:390px;background:var(--td-surface);padding:16px 16px 24px;display:flex;flex-direction:column">
  ${A_GROUPS.map(([n, r], i) => group(n, r, i === 0 ? 0 : 24)).join('')}
</div>`, { preview: '390,1630' }));

/* The same option in the sheet it opens in, because a list that reads well
   flat can still be four screens of scrolling. What fits above the fold is the
   thing being chosen. */
writeFileSync(join(OUT, 'OpsGroupedPhone.dc.html'), doc('Operations · option A in the sheet', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  <div class="body"></div>
  ${sheet(A_GROUPS.slice(0, 4).map(([n, r], i) => group(n, r, i === 0 ? 0 : 24)).join(''))}
</div>`));

/* ══ OPTION B — the same grouped list, with plain questions above it. Not an
   alternative to A: it sits on top of A and can ship after it. ══════════ */
const ASKS = [
  ['Something arrived',              'Receive from a supplier · from another shop'],
  ['I need more stock',              'Ask for stock'],
  ['Something got thrown away',      'Waste'],
  ['I paid for something myself',    'Expense'],
  ['The kitchen needs to make something', 'Ask the kitchen'],
];
const askRow = (q, dest, first) => `
        <div style="display:flex;align-items:center;gap:16px;width:100%;min-height:56px;padding:10px 16px;${first ? '' : 'border-top:1px solid var(--td-border);'}">
          <span style="flex:1;min-width:0">
            <span style="display:block;font-size:15px;color:var(--td-text)">${q}</span>
            <span style="display:block;font-size:13px;color:var(--td-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${dest}</span>
          </span>
          <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${I.chev}</span>
        </div>`;

writeFileSync(join(OUT, 'OpsAsk.dc.html'), doc('Operations · option B', `
<div class="screen">
  ${topbar()}
  ${ordersHead()}
  <div class="body"></div>
  ${sheet(`
      <h3 style="margin:0 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">What do you need to do?</h3>
      <div class="card" style="overflow:hidden">${ASKS.map((a, i) => askRow(a[0], a[1], i === 0)).join('')}</div>
      ${A_GROUPS.slice(0, 2).map(([n, r]) => group(n, r)).join('')}`)}
</div>`));

/* ══ WHAT CHANGES — the pill vocabulary and the four renames, side by side,
   so the decision is about words and not about a screenshot. ════════════ */
const beforeAfter = (before, after, why) => `
      <div style="padding:16px 0;border-top:1px solid var(--td-border)">
        <div style="font-size:15px;color:var(--td-text2);text-decoration:line-through;text-decoration-color:var(--td-text2)">${before}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
          <span style="flex:none;width:14px;height:14px;color:var(--td-text2);display:block">${I.chev}</span>
          <span style="font-size:15px;font-weight:500">${after}</span>
        </div>
        <p class="cap" style="margin:4px 0 0">${why}</p>
      </div>`;

writeFileSync(join(OUT, 'OpsChanges.dc.html'), doc('Operations · what changes', `
<div style="width:390px;background:var(--td-paper);padding:24px 16px;display:flex;flex-direction:column;gap:32px">
  <section>
    <h2 class="sec-title" style="margin-bottom:4px">Three pills, and no pill is the default</h2>
    <p class="cap" style="margin:0 0 16px">A row you simply do wears nothing. The pill is spent only where the label cannot carry the fact — and it is always neutral, because a direction is a fact, not a state needing attention.</p>
    <div class="card" style="overflow:hidden">
      ${row(X.chefHat, 'Ask the kitchen', true, 'Ask')}
      ${row(X.checkCheck, 'Approvals', false, 'Approve')}
      ${row(I.truck, 'Delivery settings', false, 'Settings')}
      ${row(X.trash, 'Waste', false, null)}
    </div>
  </section>
  <section>
    <h2 class="sec-title" style="margin-bottom:4px">Four renames, and only these four</h2>
    <p class="cap" style="margin:0 0 4px">Every other row keeps the name it wears today. A verb invented for a screen is how “Add product” happened, and a rename costs muscle memory and search terms.</p>
    ${beforeAfter('Delivery', 'Delivery settings', 'It is not a delivery worklist. It is zones, holiday mode and the printer — the only configuration screen in a list of twenty-one tasks.')}
    ${beforeAfter('Receiving', 'Receive from a supplier', 'Half of a pair that shares one Chinese label today. This is the half that arrives from outside.')}
    ${beforeAfter('Receive delivery', 'Receive from another shop', 'The other half. Both read 收货 today, so a Chinese-reading operator sees one row twice.')}
    ${beforeAfter('Invoices', 'Issue tax invoices', 'Interim. In English it reads as supplier bills; it is 发票 a customer asked for. Batch three already decided the row folds into Orders as a filter — this holds until it does.')}
  </section>
</div>`, { preview: '390,1100' }));

console.log('wrote OpsToday, OpsGrouped, OpsGroupedPhone, OpsAsk, OpsChanges');
