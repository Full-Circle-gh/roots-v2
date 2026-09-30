import { I, hdrTop, hdrPush, moreBtn, tabbar, chips, seg, subv, search, pill, field, kv, li, qty, sw, tick, warn, sheet } from './kit.mjs';

const FV = (on) => subv([['Summary', on === 'Summary'], ['Transactions', on === 'Transactions'], ['Approvals', on === 'Approvals'], ['Categories', on === 'Categories']]);
const RANGE = chips([['Today', ''], ['7 days', ''], ['30 days', '', true], ['90 days', ''], [`${'Custom'}`, '']]);
const step = (k, v, { strong = false, sub = false, open = null, note = '' } = {}) => `
  <div class="kv ${strong ? 'strong' : ''} ${sub ? 'sub' : ''}" style="align-items:center">
    <span class="k" style="display:flex;align-items:center;gap:6px">${open !== null ? `<span style="width:16px;height:16px;display:inline-flex">${open ? I.down : I.chev}</span>` : ''}${k}</span>
    <span class="v">${v}${note ? `<br><span class="cap">${note}</span>` : ''}</span></div>`;

const SUMMARY = `
  ${hdrTop('Finance')}
  <div class="scroll">
    <p class="status num">1 – 30 Sep · all stores</p>
    ${FV('Summary')}
    ${RANGE}
    <div class="card" style="overflow:hidden">
      ${step('Revenue', '¥128,640', { strong: true, open: true })}
      ${step('Mini app', '¥61,200', { sub: true })}
      ${step('Meituan', '¥38,410', { sub: true })}
      ${step('Counter till', '¥21,930', { sub: true })}
      ${step('Eleme · gzgrocery', '¥7,100', { sub: true })}
      ${step('of which tax', '¥7,280')}
      ${step('Cost of goods', '¥41,020', { open: false, note: 'Recorded on 88% of sales' })}
      ${step('Gross profit', '¥87,620', { strong: true })}
      ${step('Operating expenses', '¥52,300', { open: true })}
      ${step('Rent', '¥24,000', { sub: true, open: false })}
      ${step('Wages', '¥19,800', { sub: true, open: false })}
      ${step('Food cost (purchases)', '¥5,640', { sub: true, open: false })}
      ${step('Delivery &amp; freight', '¥2,860', { sub: true, open: false })}
      ${step('Net', '¥35,320', { strong: true })}
    </div>
    <p class="cap">Orders only. Wallet money counts when it is spent, not when it is topped up.</p>
  </div>
  ${tabbar('more')}`;

const CAT = sheet(SUMMARY, 'Delivery &amp; freight', `
    <p class="cap num" style="margin:0">1 – 30 Sep · 9 entries · ¥2,860</p>
    <div class="card" style="overflow:hidden">
      ${li('PO-0234 · Levant Foods', '29 Sep · Posted by Purchasing', { r: '¥40.00' })}
      ${li('Taxi to the market', '27 Sep · Staff claim · Jun', { r: '¥38.00', chev: false })}
      ${li('Lalamove van', '24 Sep · Carrier claim', { r: '¥260.00', chev: false })}
      ${li('SF express refund', '22 Sep · Return', { r: '−¥18.00', chev: false })}
      ${li('Monthly courier bill', '1 Sep · typed in by Ash', { r: '¥2,540.00', chev: false })}
    </div>
    <div class="eyebrow">PO-0234 · items</div>
    <div class="card" style="overflow:hidden">${kv('Freight · 1 × ¥40.00', '¥40.00')}</div>`, { h: 620 });

const CUSTOM = sheet(SUMMARY, 'Pick dates', `
    <div class="row2">${field('From', '1 Sep 2026', { icon: I.calendar, focus: true })}${field('To', '30 Sep 2026', { icon: I.calendar })}</div>
    ${chips([['This month', '', true], ['Last month', ''], ['This quarter', ''], ['Since 1 Aug', '']])}
    <p class="cap" style="margin:0">Finance starts on 1 August 2026. Earlier dates show what little was recorded before.</p>`, { h: 380, foot: '<button class="cta">Show these dates</button>' });

const TX = `
  ${hdrTop('Finance', { cta: '<button class="cta sm">New</button>' })}
  <div class="scroll">
    <p class="status num">1 – 30 Sep · 64 entries</p>
    ${FV('Transactions')}
    <div class="strip two"><div><span class="k">Money out</span><span class="v">¥57,940</span></div><div><span class="k">Money in</span><span class="v">¥1,200</span></div></div>
    ${chips([['All', 64, true], ['Money in', 3], ['Money out', 61], [`${I.download} Export CSV`, '']])}
    ${search('Filter these entries')}
    <div class="card" style="overflow:hidden">
      ${li('PO-0234 · Levant Foods', '29 Sep · Food cost · Purchasing', { r: '−¥1,420' })}
      ${li('Taxi to the market', '27 Sep · Freight · Jun, approved by Ash', { r: '−¥38' })}
      ${li('Rent, October', '25 Sep · Rent · typed in by Ash', { r: '−¥24,000' })}
      ${li('Sublet, back room', '25 Sep · Other income', { r: '+¥1,200' })}
      ${li('Return: tahini', '30 Sep · Food cost · net of PO-0234', { r: '+¥96' })}
    </div>
    <p class="cap">Sales revenue is on Summary. This list is money in and out that is not an order.</p>
  </div>
  ${tabbar('more')}`;

const NEWTX = sheet(TX, 'New transaction', `
    ${seg([['Money out', true], ['Money in', false]])}
    <div class="row2">${field('Amount', '2,540.00', { unit: '¥', focus: true })}${field('Date', '30 Sep', { icon: I.calendar })}</div>
    ${field('Category', 'Delivery &amp; freight', { icon: I.down, hint: 'Your own list, from Categories.' })}
    <div class="field"><label>Note</label><div class="inp" style="min-height:72px;align-items:flex-start;padding-top:12px"><span class="ph">Monthly courier bill</span></div></div>`, { h: 560, foot: '<button class="cta">Record it</button>' });

const ACTIONS = sheet(TX, 'Taxi to the market · ¥38', `
    <div class="card" style="overflow:hidden">${kv('Date', '27 Sep')}${kv('Category', 'Delivery &amp; freight')}${kv('Claimed by', 'Jun · own money')}${kv('Approved by', 'Ash')}</div>
    <div class="card" style="overflow:hidden">
      ${li('Change category', 'Re-files the claim', { lead: I.tag })}
      ${li('Record a return', 'Money back on this, up to ¥38', { lead: I.refund })}
      ${li('Open purchase order', 'Not on one', { lead: I.box, cls: 'dim' })}
    </div>
    <button class="danger">Void claim</button>`, { h: 560 });

const RETURN = sheet(TX, 'Record a return', `
    <p class="cap" style="margin:0">On: Rent, October · ¥24,000. Up to ¥24,000 can come back.</p>
    <div class="row2">${field('Amount', '4,000.00', { unit: '¥', focus: true })}${field('Date', '30 Sep', { icon: I.calendar })}</div>
    ${field('Reason', 'Refund from the landlord', { icon: I.down })}
    <div class="field"><label>Note</label><div class="inp" style="min-height:72px;align-items:flex-start;padding-top:12px"><span class="ph">Optional</span></div></div>`, { h: 540, foot: '<button class="cta">Record return</button>' });

const CATS = `
  ${hdrTop('Finance')}
  <div class="scroll">
    <p class="status num">14 categories · 2 hidden</p>
    ${FV('Categories')}
    <div style="display:flex;gap:8px"><div class="inp" style="flex:1"><span class="ph">New category name</span></div><button class="btn2">Add</button></div>
    <div class="card" style="overflow:hidden">
      ${[['Rent', 'Operating · 3 entries', true], ['Wages', 'Operating · 6 entries', true], ['Food cost', 'Operating · 41 entries', true], ['Delivery &amp; freight', 'Operating · 9 entries', true], ['Owner drawings', 'Not operating · 2 entries', false]].map(([n, s, op]) => `
      <div class="li" style="cursor:default"><span class="m"><span class="t">${n}</span><span class="s">${s}</span></span><span class="cap">Operating</span>${sw(op)}<button class="ico" aria-label="More">${I.dots}</button></div>`).join('')}
      <div class="li dim" style="cursor:default"><span class="m"><span class="t">Old equipment</span><span class="s">Hidden · 0 entries</span></span><button class="btn2 sm">Restore</button></div>
    </div>
    <p class="cap">⋯ renames, hides or deletes. A category with entries cannot be deleted, only hidden.</p>
  </div>
  ${tabbar('more')}`;

const APPROVALS = `
  ${hdrTop('Finance')}
  <div class="scroll">
    <p class="status num">2 waiting · ¥458 owed to your team</p>
    ${FV('Approvals')}
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="nm">Lemons, 5 kg · Mei</span><span class="num" style="font-weight:500">¥60</span></div>
        <div class="bot"><span>30 Sep · own money · Food cost</span></div>
        <div class="bot">${pill('mute', 'Goes on a purchase order')}${pill('amber', 'Not arrived yet')}</div>
        <div style="display:flex;gap:8px"><button class="btn2 sm" style="flex:1">Reject</button><button class="btn2 sm" style="flex:1">Approve</button></div></div>
      <div class="line"><div class="top"><span class="nm">Taxi · Jun</span><span class="num" style="font-weight:500">¥38</span></div><div class="bot"><span>27 Sep · Freight</span><span class="sp"></span>${pill('mute', 'Voided')}</div></div>
    </div>
    <div class="eyebrow">Owed to your team</div>
    <div class="card" style="overflow:hidden">${li('Jun', '3 claims', { r: '¥398', chev: false })}${li('Mei', '1 claim', { r: '¥60', chev: false })}</div>
    ${warn('mute', 'Mark paid now asks first, as the desktop does. Voided claims read Voided, not Waiting.')}
  </div>
  ${tabbar('more')}`;

const FAPIAO = sheet(`${hdrPush('Order 20260930-0142')}<div class="scroll"><p class="status">Delivered · ¥268</p></div>`, '发票 · issue', `
    <div class="card" style="overflow:hidden">
      ${kv('Title', 'Guangzhou Bright Tech Co.')}
      ${kv('Tax ID', '91440101MA59XXXX0Q')}
      ${kv('Email', 'finance@bright.cn')}
      ${kv('Amount', '¥268.00')}
    </div>
    <button class="btn2">${I.copy}Copy for accounting</button>
    ${field('发票 number or link', 'Paste the number or link', { ph: true })}
    <button class="btn2">${I.camera}Add the PDF or a photo</button>
    <p class="cap" style="margin:0">Marking it issued tells the customer. Un-issue is under ⋯ and asks first.</p>`, { h: 640, foot: '<button class="cta">Mark issued</button>' });

const REPORTS = `
  ${hdrTop('Reports')}
  <div class="scroll">
    <p class="status num">1 – 30 Sep · Tianhe</p>
    ${chips([['7 days', ''], ['30 days', '', true], ['90 days', ''], ['Custom', ''], [`Tianhe ${I.down}`, '']])}
    <div class="strip two"><div><span class="k">Revenue</span><span class="v">¥71,380</span></div><div><span class="k">Orders</span><span class="v">1,912</span></div><div><span class="k">Average order</span><span class="v">¥37.33</span></div><div><span class="k">Refunded</span><span class="v">0.6%</span></div></div>
    <div class="card pad">
      <svg viewBox="0 0 320 110" width="100%" height="110" role="img" aria-label="Revenue per day, September">
        <path d="M0 100 H320" stroke="#E4E0D5"/>
        <path d="M4 70 L26 62 L48 66 L70 50 L92 58 L114 44 L136 52 L158 40 L180 48 L202 36 L224 42 L246 30 L268 38 L290 28 L316 34" fill="none" stroke="#111A2B" stroke-width="1.75" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="card" style="overflow:hidden">
      ${li('Payment and delivery split', 'WeChat Pay 58% · Meituan 30%', { lead: I.wallet })}
      ${li('Busiest hours', 'Heatmap · Fri 12–13 is the peak', { lead: I.calendar })}
      ${li('Returning customers', 'Cohorts by first month', { lead: I.chart })}
    </div>
  </div>
  ${tabbar('more')}`;

export const FINANCE = [
  ['F01-FinanceSummary', 'Finance · summary', SUMMARY],
  ['F02-CategoryDrill', 'Summary · a category opened', CAT],
  ['F03-CustomDates', 'Summary · pick dates', CUSTOM],
  ['F04-Transactions', 'Finance · transactions', TX],
  ['F05-NewTransaction', 'Transactions · new', NEWTX],
  ['F06-RowActions', 'Transactions · one entry', ACTIONS],
  ['F07-Return', 'Transactions · record a return', RETURN],
  ['F08-Categories', 'Finance · categories', CATS],
  ['F09-Approvals', 'Finance · approvals (two fixes)', APPROVALS],
  ['F10-FapiaoIssue', '发票 · issue from an order', FAPIAO],
  ['F11-Reports', 'Reports · dates and store', REPORTS],
];
