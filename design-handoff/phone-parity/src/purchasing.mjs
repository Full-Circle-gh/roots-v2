import { I, hdrTop, hdrPush, moreBtn, tabbar, chips, seg, subv, search, pill, field, kv, li, qty, sw, tick, warn, sheet } from './kit.mjs';

const PUV = (on) => subv([['Orders', on === 'Orders'], ['Suppliers', on === 'Suppliers'], ['Invoices', on === 'Invoices'], ['Reorder', on === 'Reorder']]);
const poCard = (no, date, sup, store, lines, total, arrives, p, extra = '') => `
  <button class="card pad" style="display:flex;flex-direction:column;gap:6px;text-align:left;width:100%">
    <span style="display:flex;justify-content:space-between;gap:8px"><span class="cap num">${no} · ${date}</span>${p}</span>
    <span style="display:flex;justify-content:space-between;gap:8px"><span style="font-weight:500">${sup}</span><span class="num" style="font-weight:500">${total}</span></span>
    <span class="cap num" style="display:flex;justify-content:space-between;gap:8px"><span>${store} · ${lines}</span><span>${arrives}</span></span>${extra}
  </button>`;

const LIST = `
  ${hdrTop('Purchasing', { cta: '<button class="cta sm">New order</button>' })}
  <div class="scroll">
    <p class="status num">7 open · 1 late · ¥18,420 this month</p>
    ${PUV('Orders')}
    ${seg([['Open 7', true], ['Received 42', false], ['All 51', false]])}
    ${search('Order no., supplier or item')}
    <button class="card" style="width:100%;padding:0;overflow:hidden">${li('From the kitchen', '3 lines asked for · 1 urgent', { lead: I.utensils, r: pill('amber', '3') })}</button>
    ${poCard('PO-0231', '26 Sep', 'Guangzhou Dairy', 'Tianhe', '6 lines', '¥2,140', '<span style="color:var(--amber-ink)">Due 28 Sep · late</span>', pill('amber', 'Late'))}
    ${poCard('PO-0234', '29 Sep', 'Levant Foods', 'Yuexiu', '4 lines · 2 in', '¥1,380', 'Due 2 Oct', pill('mute', 'Part arrived'))}
    ${poCard('PO-0236', '30 Sep', '2 suppliers', 'Tianhe', '9 lines', '¥3,905', 'Due 3 Oct', pill('mute', 'Ordered'))}
    ${poCard('PO-0237', '30 Sep', 'Guangzhou Greens', 'Tianhe', '3 lines', '¥264', '—', pill('mute', 'Draft'))}
  </div>
  ${tabbar('more')}`;

const stepHead = (n, title) => `${hdrPush(`New order · ${n} of 3`)}`;

const NEW1 = `
  ${stepHead(1)}
  <div class="scroll">
    <div class="stepper" style="margin-top:16px"><span class="d now"></span><span>Who and where</span><span class="ln"></span><span class="d"></span><span>Lines</span><span class="ln"></span><span class="d"></span><span>Review</span></div>
    ${field('Supplier', 'Guangzhou Dairy', { icon: I.down, focus: true, hint: 'From your supplier book. Leave empty for a mixed order and pick a supplier per line.' })}
    ${field('Deliver to', 'Tianhe', { icon: I.down })}
    ${field('Order date', '30 Sep 2026', { icon: I.calendar })}
    <div class="field"><label>Note for the receiver</label><div class="inp" style="min-height:88px;align-items:flex-start;padding-top:12px"><span class="ph">Anything the receiver should know</span></div></div>
  </div>
  <div class="foot"><button class="cta">Next: lines</button></div>`;

const NEW2 = `
  ${stepHead(2)}
  <div class="scroll">
    <div class="card" style="overflow:hidden">${li('Guangzhou Dairy → Tianhe', '30 Sep · no note', { r: '<span class="cap">Change</span>', chev: false })}</div>
    ${search('Add by name or SKU')}
    <div class="warnbox mute">${I.box}<span>Running low here: Sour cream 20% (2 left) · Feta (1 left). <b style="font-weight:500">Add both</b></span></div>
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="nm">Sour cream 20%</span><span class="num" style="font-weight:500">¥1,536</span></div>
        <div class="bot">${qty('12')}<span>case</span><span class="sp"></span><span class="num">¥128 each</span></div>
        <div class="bot"><span>On shelf 2 · last paid ¥124</span><span class="sp"></span><span style="color:var(--amber-ink)">Up 3%</span></div></div>
      <div class="line"><div class="top"><span class="nm">Feta, block</span><span class="num" style="font-weight:500">¥420</span></div>
        <div class="bot">${qty('6')}<span>kg</span><span class="sp"></span><span class="num">¥70 each</span></div>
        <div class="bot"><span>On shelf 1 · last paid ¥70</span></div></div>
      <div class="line"><div class="top"><span class="nm">Greek yoghurt</span><span class="num" style="font-weight:500">¥184</span></div>
        <div class="bot">${qty('4')}<span>tub</span><span class="sp"></span><span class="num">¥46 each</span></div></div>
    </div>
    <button class="btn2">${I.plus}Add a line not in the catalogue</button>
  </div>
  <div class="foot" style="align-items:center"><span class="num" style="flex:none;font-weight:500">3 lines · ¥2,140</span><button class="cta">Next: review</button></div>`;

const PRICE = sheet(NEW2, 'Sour cream 20%', `
    <p class="cap" style="margin:0">Who you have bought it from, and for how much.</p>
    <div class="strip three"><div><span class="k">Last paid</span><span class="v">¥124</span></div><div><span class="k">Average</span><span class="v">¥126</span></div><div><span class="k">Bought</span><span class="v">11×</span></div></div>
    <div class="card" style="overflow:hidden">
      ${li('Guangzhou Dairy', 'Preferred · last 26 Sep', { r: '¥128', rs: 'per case', chev: false })}
      ${li('Metro Wholesale', 'Cheapest · last 2 Aug', { r: '¥119', rs: 'per case', chev: false })}
      ${li('Fresh Hub', 'last 14 Jul', { r: '¥131', rs: 'per case', chev: false })}
    </div>`, { h: 520, foot: '<button class="btn2">Type it myself</button><button class="cta">Use ¥128</button>' });

const NEW3 = `
  ${stepHead(3)}
  <div class="scroll">
    <div class="stepper" style="margin-top:16px"><span class="d done"></span><span>Who and where</span><span class="ln"></span><span class="d done"></span><span>Lines</span><span class="ln"></span><span class="d now"></span><span>Review</span></div>
    <p style="margin:0;font-size:18px;font-weight:500;line-height:1.4">3 lines from Guangzhou Dairy, delivered to Tianhe, ¥2,140 in all.</p>
    <div class="card" style="overflow:hidden">${kv('Sour cream 20% · 12 case', '¥1,536')}${kv('Feta, block · 6 kg', '¥420')}${kv('Greek yoghurt · 4 tub', '¥184')}${kv('Total', '¥2,140', 'strong')}</div>
    <div class="warnbox mute">${I.wallet}<span>Nothing is spent yet. Finance counts this order when it is received, under Food cost.</span></div>
    <button class="ghost" style="color:var(--brick-ink);align-self:flex-start">Delete draft</button>
  </div>
  <div class="foot"><button class="btn2">Save as draft</button><button class="cta">Place order</button></div>`;

const ORDER = `
  ${hdrPush('PO-0234', { right: `<button class="ico" aria-label="Share">${I.share}</button>${moreBtn}` })}
  <div class="scroll">
    <p class="status num">Levant Foods → Yuexiu · placed 29 Sep · due 2 Oct</p>
    <div class="stepper"><span class="d done"></span><span>Draft</span><span class="ln"></span><span class="d done"></span><span>Sent</span><span class="ln"></span><span class="d now"></span><span>Part received</span><span class="ln"></span><span class="d"></span><span>Received</span></div>
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="nm">Tahini</span>${pill('sage', '10 of 10 in')}</div><div class="bot"><span class="num">10 kg × ¥96</span><span class="sp"></span><span>发票 Received</span></div></div>
      <div class="line"><div class="top"><span class="nm">Chickpeas, dried</span>${pill('amber', '18 of 25 in')}</div><div class="bot"><span class="num">25 kg × ¥14</span><span class="sp"></span><span>发票 Awaiting</span></div><div class="bot"><span>Tracking SF1402889311</span></div></div>
      <div class="line"><div class="top"><span class="nm">Za’atar</span>${pill('mute', 'Not yet')}</div><div class="bot"><span class="num">3 kg × ¥88</span><span class="sp"></span><span>发票 Awaiting</span></div></div>
    </div>
    <div class="card" style="overflow:hidden">
      ${li('Receive what arrived', 'Line by line', { lead: I.truck })}
      ${li('Back-order the 7 short', 'Opens a new order for what is missing', { lead: I.refund })}
      ${li('Landed cost', 'Freight ¥40 · tax — · handling —', { lead: I.wallet, r: '¥1,420' })}
      ${li('In Finance', 'Food cost ¥1,380 · Freight ¥40', { lead: I.chart })}
    </div>
    <p class="cap">Order again, back to draft, undo receiving and cancel sit under ⋯, each behind a confirm.</p>
  </div>`;

const KITCHEN = sheet(LIST, 'From the kitchen', `
    <p class="cap" style="margin:0">Tick what to buy. It becomes a draft order you can still change.</p>
    <div class="card" style="overflow:hidden">
      <div class="li">${tick(true)}<span class="m"><span class="t">Dill, fresh · 2 kg</span><span class="s">MR-088 · Mei · by 1 Oct</span></span>${pill('amber', 'Urgent')}<button class="ico" aria-label="Decline">${I.close}</button></div>
      <div class="li">${tick(true)}<span class="m"><span class="t">Lemons · 5 kg</span><span class="s">MR-088 · Mei · 30 Sep</span></span><button class="ico" aria-label="Decline">${I.close}</button></div>
      <div class="li">${tick(false)}<span class="m"><span class="t">Tub 200 ml · 500</span><span class="s">MR-090 · Jun · “for the weekend”</span></span><button class="ico" aria-label="Decline">${I.close}</button></div>
    </div>
    <div class="row2">${field('File under', 'Tianhe', { icon: I.down })}${field('Supplier', 'Optional', { ph: true, icon: I.down })}</div>`,
  { h: 600, foot: '<button class="cta">Draft 2 lines</button>' });

const RECEIVE = `
  ${hdrPush('Receive PO-0234')}
  <div class="scroll">
    <p class="status num">3 lines · 1 done · saves as you go</p>
    <div class="card" style="overflow:hidden">
      <div class="line"><div class="top"><span class="nm">Chickpeas, dried</span>${pill('amber', 'Short 7')}</div>
        <div class="bot">${qty('18')}<span>of 25 kg arrived</span></div>
        <div class="bot"><span>Why short</span><span class="sp"></span>${seg([['Short', true], ['Wrong item', false], ['Not sent', false]])}</div>
        ${field('Tracking number', 'SF1402889311')}
        <div class="bot"><span>发票</span><span class="sp"></span>${seg([['Awaiting', true], ['Received', false], ['None', false]])}</div>
      </div>
      <div class="line"><div class="top"><span class="nm">Tahini</span>${pill('sage', 'All in')}</div>
        <div class="bot"><span>10 of 10 kg · 1 damaged</span><span class="sp"></span><button class="btn2 sm">Send back</button></div></div>
    </div>
    <div class="card pad" style="display:flex;flex-direction:column;gap:12px">
      <span style="font-weight:500">Send back · Tahini</span>
      <div class="row2">${field('How many', '1', { unit: 'kg' })}${field('Date', '30 Sep', { icon: I.calendar })}</div>
      ${field('Reason', 'Damaged on arrival', { icon: I.down })}
      <span class="hint">The supplier owes you ¥96 back. Finance nets it off this order.</span>
    </div>
  </div>
  <div class="foot"><button class="cta">Record the return</button></div>`;

const INVOICES = `
  ${hdrTop('Purchasing', { cta: '<button class="cta sm">Add invoice</button>' })}
  <div class="scroll">
    <p class="status num">September · ¥18,420 bought · ¥4,210 not invoiced</p>
    ${PUV('Invoices')}
    ${seg([['By supplier', true], ['Recorded', false]])}
    ${chips([['Sep 2026', '', true], ['Aug', ''], ['Jul', '']])}
    <div class="strip two"><div><span class="k">Fully invoiced</span><span class="v">¥12,960</span></div><div><span class="k">Awaiting</span><span class="v">¥3,120</span></div><div><span class="k">Partial</span><span class="v">¥1,250</span></div><div><span class="k">No invoice</span><span class="v">¥1,090</span></div></div>
    <div class="card" style="overflow:hidden">
      ${li('Guangzhou Dairy', '4 orders · ¥1,480 awaiting', { r: pill('amber', 'Awaiting'), lead: I.phone })}
      ${li('Levant Foods', '2 orders · ¥1,250 partial', { r: pill('amber', 'Partial') })}
      ${li('Guangzhou Greens', '6 orders', { r: pill('sage', 'All in') })}
      ${li('Metro Wholesale', '1 order · marked no invoice', { r: pill('mute', 'None') })}
    </div>
    ${warn('amber', 'Credit due from Levant Foods: ¥96 on a return. Chase it with the next invoice.')}
  </div>
  ${tabbar('more')}`;

const INVOICE_ADD = sheet(INVOICES, 'Add invoice', `
    <div class="row2">${field('Supplier', 'Guangzhou Dairy', { icon: I.down })}${field('Invoice no.', '44019283')}</div>
    <div class="row2">${field('Amount', '1,480.00', { unit: '¥', focus: true })}${field('Date', '30 Sep', { icon: I.calendar })}</div>
    <div style="display:flex;align-items:center;justify-content:space-between"><span style="font-weight:500">Covers these orders</span><button class="btn2 sm">Match to amount</button></div>
    <div class="card" style="overflow:hidden">
      <div class="li">${tick(true)}<span class="m"><span class="t">PO-0231 · 26 Sep</span><span class="s">¥2,140 · ¥1,040 left to invoice</span></span><span class="num">¥1,040</span></div>
      <div class="li">${tick(true)}<span class="m"><span class="t">PO-0219 · 12 Sep</span><span class="s">¥440 left to invoice</span></span><span class="num">¥440</span></div>
      <div class="li">${tick(false)}<span class="m"><span class="t">PO-0212 · 5 Sep</span><span class="s">¥620 left to invoice</span></span><span class="num cap">—</span></div>
    </div>
    ${pill('sage', 'Fully matched · ¥0 left over')}`, { h: 680, foot: '<button class="cta">Save invoice</button>' });

const REORDER = `
  ${hdrTop('Purchasing')}
  <div class="scroll">
    <p class="status num">3 suppliers have items running low</p>
    ${PUV('Reorder')}
    ${[['Guangzhou Dairy → Tianhe', '4 low', [['Sour cream 20%', '2 left · keep 6', '12 case'], ['Feta, block', '1 left · keep 4', '6 kg'], ['Greek yoghurt', '0 left · keep 3', '4 tub']]], ['Levant Foods → Yuexiu', '2 low', [['Tahini', '3 left · keep 8', '10 kg'], ['Za’atar', '0 left · keep 2', '3 kg']]]].map(([h, n, rows]) => `
    <div class="card" style="overflow:hidden">
      <div class="li" style="cursor:default"><span class="m"><span class="t">${h}</span></span>${pill('amber', n)}</div>
      ${rows.map(([a, b, c]) => `<div class="kv"><span class="k">${a}<br><span class="cap">${b}</span></span><span class="v">${c}</span></div>`).join('')}
      <div style="padding:12px 16px;border-top:1px solid var(--border)"><button class="btn2" style="width:100%">Open draft order</button></div>
    </div>`).join('')}
  </div>
  ${tabbar('more')}`;

const SUPPLIERS = `
  ${hdrTop('Purchasing', { cta: '<button class="cta sm">New supplier</button>' })}
  <div class="scroll">
    <p class="status num">24 suppliers · you owe 3 of them ¥5,860</p>
    ${PUV('Suppliers')}
    ${seg([['Active 24', true], ['Disabled 5', false]])}
    ${search('Name, 中文名 or contact')}
    <div class="card" style="overflow:hidden">
      ${li('Guangzhou Dairy', 'Dairy · Net 30 · Bank · 38 orders', { r: '¥3,420', rs: 'you owe' })}
      ${li('Levant Foods', 'Dry goods · Prepay · WeChat · 12 orders', { r: '¥1,600', rs: 'you owe' })}
      ${li('Guangzhou Greens', 'Produce · COD · Cash · 64 orders', { r: '—', rs: '' })}
      ${li('Metro Wholesale', 'General · Net 15 · Alipay · 9 orders', { r: '¥840', rs: 'you owe' })}
      ${li('Pack &amp; Go', 'Packaging · Prepay · 7 orders', { r: '—', rs: '' })}
    </div>
    <button class="btn2">${I.upload}Import suppliers from a file</button>
  </div>
  ${tabbar('more')}`;

const SUPPLIER = `
  ${hdrPush('Guangzhou Dairy', { right: '<button class="cta sm">New order</button>' })}
  <div class="scroll">
    <p class="status num">Saved · 38 orders · last 26 Sep</p>
    <div class="strip"><div><span class="k">Orders</span><span class="v">38</span></div><div><span class="k">Spend</span><span class="v">¥46.2k</span></div><div><span class="k">发票 due</span><span class="v">¥1,480</span></div><div><span class="k">Products</span><span class="v">7</span></div></div>
    <div class="card" style="overflow:hidden">
      <div class="li" style="cursor:default"><span class="m"><span class="t">Buy on credit</span><span class="s">Track what you owe them</span></span>${sw(true)}</div>
      ${li('We owe ¥3,420', 'Last payment ¥2,000 on 15 Sep', { lead: I.wallet })}
    </div>
    <div class="row2">${field('Contact', 'Mr. Liang')}${field('Phone', '138 0000 1234')}</div>
    <div class="row2">${field('When you pay', 'Net 30', { icon: I.down })}${field('How', 'Bank', { icon: I.down })}</div>
    <div class="card" style="overflow:hidden">
      ${li('Price list', '7 products · last paid, average', { lead: I.tag })}
      ${li('Paperwork', 'Business licence · contract 2026', { lead: I.file, r: '2' })}
      ${li('Orders with them', '38 · 2 open', { lead: I.box })}
      ${li('Version history', 'Every change to this supplier', { lead: I.history })}
    </div>
    <button class="danger">Disable supplier</button>
  </div>`;

const HISTORY = `
  ${hdrPush('Sour cream 20%')}
  <div class="scroll">
    <p class="status num">Price history · bought 11 times since June</p>
    <div class="strip three"><div><span class="k">Last paid</span><span class="v">¥128</span></div><div><span class="k">Average</span><span class="v">¥126</span></div><div><span class="k">Range</span><span class="v">¥119–131</span></div></div>
    <div class="card pad">
      <svg viewBox="0 0 320 110" width="100%" height="110" aria-label="Price per case, June to September" role="img">
        <path d="M0 100 H320" stroke="#E4E0D5"/>
        <path d="M8 70 L38 64 L68 66 L98 52 L128 58 L158 44 L188 48 L218 40 L248 36 L278 30 L312 30" fill="none" stroke="#111A2B" stroke-width="1.75" stroke-linejoin="round"/>
        <circle cx="312" cy="30" r="3.5" fill="#111A2B"/>
      </svg>
      <div class="cap num" style="display:flex;justify-content:space-between"><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span></div>
    </div>
    <div class="eyebrow">Who sells it</div>
    <div class="card" style="overflow:hidden">
      ${li('Guangzhou Dairy', 'Preferred · 8 times', { r: '¥128', rs: 'last', chev: false })}
      ${li('Metro Wholesale', 'Cheapest · 2 times', { r: '¥119', rs: 'last', chev: false })}
      ${li('Fresh Hub', '1 time', { r: '¥131', rs: 'last', chev: false })}
    </div>
  </div>`;

export const PURCHASING = [
  ['P01-PurchasingOrders', 'Purchasing · orders', LIST],
  ['P02-NewOrderWho', 'New order · 1 who and where', NEW1],
  ['P03-NewOrderLines', 'New order · 2 lines', NEW2],
  ['P04-SupplierPrices', 'New order · supplier prices', PRICE],
  ['P05-NewOrderReview', 'New order · 3 review', NEW3],
  ['P06-OrderRecord', 'Order · manage', ORDER],
  ['P07-FromKitchen', 'From the kitchen', KITCHEN],
  ['P08-ReceiveExtras', 'Receive · tracking, 发票, return', RECEIVE],
  ['P09-Invoices', 'Invoices (发票)', INVOICES],
  ['P10-AddInvoice', 'Invoice · add and match', INVOICE_ADD],
  ['P11-Reorder', 'Reorder', REORDER],
  ['P12-Suppliers', 'Suppliers · list', SUPPLIERS],
  ['P13-Supplier', 'Supplier · record', SUPPLIER],
  ['P14-PriceHistory', 'Price history', HISTORY],
];
