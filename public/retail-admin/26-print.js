/* eslint-disable no-undef */
/* retail-admin app JS — documents somebody can put on paper (audit E-12).

   WHAT WAS MISSING
   ═══════════════════════════════════════════════════════════════════════
   An order could be printed, a purchase order had a proper sheet, and the shop
   printer had a receipt and a packing slip. There was no stock count sheet and
   no customer statement — the two documents a merchant is actually ASKED for
   by somebody standing in front of them: a clipboard for a stocktake, and "can
   I have that on paper" from a business customer.

   ONE SHEET, NOT TWO LAYOUTS
   ═══════════════════════════════════════════════════════════════════════
   tdPrintTable() is the whole document: a masthead with the shop's name, a
   short list of facts about the document, one table, and a foot. Both documents
   here are that shape, and so is the next one somebody adds.

   TWO THINGS IT DOES THAT THE OLDER PURCHASE-ORDER SHEET DID NOT
   ═══════════════════════════════════════════════════════════════════════
   It says the MERCHANT'S name, read from the account rather than written into
   the file. A document handed to a customer with the wrong shop's name on it is
   not a formatting problem.

   And it loads NO external fonts. The admin's own fonts were taken off a host
   that is unreachable where the first merchant trades (audit D-09); a print
   window that stalls on a font request is the same defect on the one screen
   where somebody is standing at a printer waiting. */

// The shop's own name, for the top of a document. Set from /api/backend/me when
// the admin boots; empty until then, and an empty masthead is better than
// somebody else's shop name on a customer's statement.
function tdPrintShopName() {
  return (typeof window !== 'undefined' && window.TD_SHOP_NAME) || '';
}

const _tdPrintEsc = (v) => String(v == null ? '' : v)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Open a printable document.
 *
 *   docEn/docCn  what the document IS — "Stock count", "Statement"
 *   subtitle     the one line under it (a store, a customer)
 *   meta         [[label, value]…] — the facts, top right
 *   columns      [{ h, r }] — heading, and `r` for a right-aligned column
 *   rows         [[cell…]] — cells are already-escaped-free strings; a cell may
 *                be { v, cls } for one that needs a class (a blank write-in box)
 *   note         a line at the foot, for what the reader has to know
 */
// The window every document opens in. A blocked pop-up is said, not swallowed:
// somebody pressed Print and nothing happening is the one answer they cannot
// act on.
function _tdPrintOpen() {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) toast(cuT('Allow pop-ups, then print again', '请允许弹窗后再打印'), 'err');
  return w || null;
}

// One stylesheet for every document here, so a recipe card and a count sheet
// cannot drift apart in how they print.
const _TD_PRINT_CSS = `  @page { size: A4; margin: 12mm; }
  /* No webfont. See the header: a print window that stalls on a font request is
     a person standing at a printer waiting for nothing. */
  :root { --ink:#000; --grey:#555; --hair:#C9C4B6;
          --sans:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; }
  * { box-sizing:border-box; }
  body { margin:0; background:#F2F1EC; font-family:var(--sans); color:var(--ink); }
  .toolbar { position:sticky; top:0; z-index:10; background:#111A2B; color:#FBF9F4; padding:10px 18px;
             display:flex; align-items:center; gap:10px; font-size:13px; }
  .toolbar button { font:inherit; font-size:13px; padding:6px 16px; border-radius:8px; cursor:pointer;
                    background:#FBF9F4; color:#111A2B; border:none; }
  .toolbar button.ghost { background:none; color:#FBF9F4; border:1px solid #58606E; }
  .sheet { background:#fff; max-width:210mm; margin:24px auto; padding:18mm 16mm; }
  .masthead { display:flex; justify-content:space-between; align-items:flex-end; gap:40px; padding-bottom:14px; }
  .shop { font-size:12px; color:var(--grey); letter-spacing:.14em; text-transform:uppercase; }
  h1 { margin:6px 0 0; font-size:26px; font-weight:400; line-height:1.1; }
  .cn { font-size:13px; color:var(--grey); margin-top:6px; letter-spacing:.18em; }
  .sub { font-size:13px; margin-top:8px; }
  .meta { font-size:12px; flex:none; }
  .meta dl { margin:0; display:grid; grid-template-columns:auto auto; gap:6px 22px; }
  .meta dt { color:var(--grey); }
  .meta dd { margin:0; text-align:right; }
  table { width:100%; border-collapse:collapse; margin-top:14px; }
  thead th { border-bottom:1.5px solid var(--ink); font-weight:500; font-size:11px; letter-spacing:.02em;
             padding:9px 10px; text-align:left; white-space:nowrap; }
  thead th.r { text-align:right; }
  tbody td { border-bottom:1px solid var(--hair); padding:11px 10px; font-size:12.5px; vertical-align:top; }
  tbody td.r { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.idx { color:var(--grey); font-size:11px; width:26px; }
  /* A box to write in. The whole point of a count sheet is the empty column. */
  td.write { border-bottom:1px solid var(--hair); }
  td.write::after { content:''; display:block; height:16px; border-bottom:1px solid var(--hair); width:64px; margin-left:auto; }
  .note { margin-top:22px; padding:10px 12px; border-left:2px solid var(--hair); font-size:12px;
          line-height:1.6; color:var(--grey); }
  .foot { margin-top:36px; padding-top:10px; border-top:1px solid var(--hair); display:flex;
          justify-content:space-between; font-size:10px; color:var(--grey); }
  .empty { padding:24px; text-align:center; color:var(--grey); font-size:12.5px; }
  @media print { body { background:#fff; } .toolbar { display:none; } .sheet { margin:0; padding:10mm; max-width:none; } }
`;

function tdPrintTable({ docEn, docCn, subtitle, meta, columns, rows, note }) {
  const w = _tdPrintOpen();
  if (!w) return null;
  const e = _tdPrintEsc;
  const shop = tdPrintShopName();
  const metaHtml = (meta || []).filter(Boolean)
    .map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('');
  const head = (columns || [])
    .map((c) => `<th${c.r ? ' class="r"' : ''}${c.w ? ` style="width:${c.w}"` : ''}>${e(c.h)}</th>`).join('');
  const body = (rows || []).map((r, i) => '<tr><td class="idx">' + (i + 1) + '</td>'
    + r.map((cell, ci) => {
      const col = (columns || [])[ci + 1] || {};
      if (cell && typeof cell === 'object') {
        return `<td class="${cell.cls || ''}${col.r ? ' r' : ''}">${e(cell.v || '')}</td>`;
      }
      return `<td${col.r ? ' class="r"' : ''}>${e(cell)}</td>`;
    }).join('') + '</tr>').join('');

  const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${e(docEn)}${shop ? ' — ' + e(shop) : ''}</title>
<style>
${_TD_PRINT_CSS}</style></head><body>
<div class="toolbar">${e(docEn)}<span style="flex:1"></span>
  <button onclick="window.print()">Print / Save as PDF</button>
  <button class="ghost" onclick="window.close()">Close 关闭</button>
</div>
<div class="sheet">
  <div class="masthead">
    <div>
      ${shop ? `<div class="shop">${e(shop)}</div>` : ''}
      <h1>${e(docEn)}</h1>
      ${docCn ? `<div class="cn">${e(docCn)}</div>` : ''}
      ${subtitle ? `<div class="sub">${e(subtitle)}</div>` : ''}
    </div>
    <div class="meta"><dl>${metaHtml}</dl></div>
  </div>
  <table>
    <thead><tr><th style="width:26px">#</th>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${(columns || []).length + 1}" class="empty">Nothing to show · 暂无内容</td></tr>`}</tbody>
  </table>
  ${note ? `<div class="note">${e(note)}</div>` : ''}
  <!-- The stamp carried no locale at all, so the same document was footed
       29/07/2026 on one laptop and 7/29/2026 on the next, on the operator's
       clock rather than the shop's. -->
  <div class="foot"><span>${e(shop)}</span><span>${e(tdWhen(new Date(), 'dateTime'))}</span></div>
</div>
</body></html>`;
  w.document.write(doc);
  w.document.close();
  return w;
}
window.tdPrintTable = tdPrintTable;

/* ── Recipe card ───────────────────────────────────────────────────────────
   What a cook needs to make the batch, in both languages, and nothing a cook
   should not see: NO cost, price or margin. The screen hides those from anyone
   without recipes:costs, and a sheet pinned to a kitchen wall is read by
   everyone who walks past it — so they are not passed in, not merely not shown.

   LAID OUT FOR SOMEBODY MID-TASK, NOT AT A DESK (Ash, 2026-09-25: "is that
   the best template for people that work in kitchen"). It is read at arm's
   length with busy hands, so the order is what a cook looks for first:
     1. the name, both languages at full size — a Chinese-reading cook reads
        the second line as the title, so it is not greyed or shrunk;
     2. what it makes and how it keeps, as a row of large figures under the
        name rather than small print tucked top right;
     3. the amount FIRST on each ingredient line, bold, so the eye does not
        travel across a wide row to find it and land on the wrong line;
     4. the SKUs last and quiet — purchasing reads them, a cook does not.
   Text is sized to be read off a wall, not a screen.

   The caller hands over text already paired ("Fridge · 冷藏"), because only
   the recipe screen knows both halves of its own option lists. Steps and notes
   are printed exactly as typed: there is one box for each, in whatever
   language somebody wrote it.

     nameEn/nameCn  the recipe's two names
     sku            its SKU, or ''
     facts          [[label, value]…] — servings, batch, shelf life, storage
     lines          [{ sku, en, cn, qty }] — cn '' prints the English alone
     steps          [{ name, text }]
     notes          the recipe's notes, or '' */
function tdPrintRecipe({ nameEn, nameCn, sku, facts, lines, steps, notes }) {
  const w = _tdPrintOpen();
  if (!w) return null;
  const e = _tdPrintEsc;
  const shop = tdPrintShopName();
  const factHtml = (facts || []).filter(Boolean)
    .map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('');
  const lineRows = (lines || []).map((l, i) => `<tr><td class="idx">${i + 1}</td>`
    + `<td class="qty">${e(l.qty)}</td>`
    + `<td>${e(l.en)}${l.cn ? `<span class="zh">${e(l.cn)}</span>` : ''}</td>`
    + `<td class="sku">${e(l.sku || '')}</td></tr>`).join('');
  const stepItems = (steps || []).map((s) => '<li><div>'
    + (s.name ? `<div class="sn">${e(s.name)}</div>` : '')
    + (s.text ? `<div class="st">${e(s.text)}</div>` : '')
    + '</div></li>').join('');

  const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${e(nameEn)}${shop ? ' — ' + e(shop) : ''}</title>
<style>${_TD_PRINT_CSS}
  .masthead { display:block; padding-bottom:12px; }
  h1 { font-size:32px; font-weight:600; }
  .cn-name { font-size:28px; font-weight:600; margin-top:4px; letter-spacing:.04em; }
  dl.facts { margin:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:0;
             border-top:2px solid var(--ink); border-bottom:2px solid var(--ink); }
  dl.facts > div { padding:10px 12px; border-left:1px solid var(--hair); }
  dl.facts > div:first-child { border-left:none; padding-left:0; }
  dl.facts dt { font-size:11.5px; color:var(--grey); }
  dl.facts dd { margin:3px 0 0; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; }
  h2 { font-size:17px; font-weight:700; margin:24px 0 0; }
  h2 span { font-weight:400; margin-left:8px; }
  table { margin-top:6px; }
  thead th { font-size:11.5px; }
  tbody td { padding:9px 10px; font-size:16px; line-height:1.35; }
  td.idx { font-size:12px; padding-top:12px; }
  td.qty { width:1%; white-space:nowrap; text-align:right; font-weight:700; font-size:17px;
           font-variant-numeric:tabular-nums; padding-right:18px; }
  td .zh { display:block; margin-top:2px; }
  td.sku { width:1%; white-space:nowrap; font-size:11.5px; color:var(--grey); padding-top:12px;
           font-variant-numeric:tabular-nums; }
  ol.steps { margin:8px 0 0; padding:0; list-style:none; counter-reset:s; }
  ol.steps li { counter-increment:s; display:grid; grid-template-columns:34px 1fr; gap:0 10px; padding:10px 0;
                border-bottom:1px solid var(--hair); font-size:15.5px; line-height:1.6; break-inside:avoid; }
  ol.steps li::before { content:counter(s); font-size:18px; font-weight:700; line-height:1.4; }
  ol.steps .sn { font-weight:700; }
  ol.steps .st, .notes { white-space:pre-line; }
  .notes { margin-top:10px; padding:10px 12px; border-left:3px solid var(--ink); font-size:15px; line-height:1.6; }
  /* One sheet of A4 for an ordinary recipe: the same sizes, less air. */
  @media print {
    .sheet { padding:0; }
    dl.facts > div { padding-top:6px; padding-bottom:6px; }
    h2 { margin-top:14px; }
    tbody td { padding-top:6px; padding-bottom:6px; }
    td.idx, td.sku { padding-top:9px; }
    ol.steps li { padding:6px 0; line-height:1.45; }
    .foot { margin-top:14px; }
  }
</style></head><body>
<div class="toolbar">Recipe · 食谱<span style="flex:1"></span>
  <button onclick="window.print()">Print / Save as PDF</button>
  <button class="ghost" onclick="window.close()">Close 关闭</button>
</div>
<div class="sheet">
  <div class="masthead">
    ${shop ? `<div class="shop">${e(shop)}</div>` : ''}
    <h1>${e(nameEn)}</h1>
    ${nameCn ? `<div class="cn-name">${e(nameCn)}</div>` : ''}
  </div>
  ${factHtml ? `<dl class="facts">${factHtml}</dl>` : ''}
  <h2>Ingredients<span>原料</span></h2>
  <table>
    <thead><tr><th style="width:26px">#</th><th class="r">Qty · 数量</th><th>Ingredient · 原料</th><th>SKU · 货号</th></tr></thead>
    <tbody>${lineRows || '<tr><td colspan="4" class="empty">Nothing to show · 暂无内容</td></tr>'}</tbody>
  </table>
  ${stepItems ? `<h2>Steps<span>步骤</span></h2><ol class="steps">${stepItems}</ol>` : ''}
  ${notes ? `<h2>Notes<span>备注</span></h2><div class="notes">${e(notes)}</div>` : ''}
  <div class="foot"><span>${e(shop)}${shop && sku ? ' · ' : ''}${sku ? 'SKU ' + e(sku) : ''}</span><span>${e(tdWhen(new Date(), 'dateTime'))}</span></div>
</div>
</body></html>`;
  w.document.write(doc);
  w.document.close();
  return w;
}
window.tdPrintRecipe = tdPrintRecipe;

/* ── Stock count sheet ─────────────────────────────────────────────────────
   A clipboard for a stocktake: what is on the shelf according to the system,
   and an empty box to write what is actually there.

   THE SYSTEM'S FIGURE IS PRINTED, and that is a deliberate choice with a cost.
   Printing it anchors the counter — somebody who sees "42" is likelier to write
   42 — but withholding it makes the sheet useless for its other job, which is
   spotting the line that is badly wrong while you are still standing in front
   of it. The difference column is there so the discrepancy is written down at
   the shelf rather than worked out afterwards from two lists. */
function paPrintCountSheet() {
  const store = (typeof PA_STORE !== 'undefined' && PA_STORE !== 'all')
    ? (PA_STORES || []).find((s) => s.id === PA_STORE) : null;
  const rows = (PA_PRODUCTS || [])
    .filter((p) => p.is_active !== 0)
    .map((p) => {
      const name = cuT(p.name_en || p.name_cn || ('#' + p.id), p.name_cn || p.name_en || ('#' + p.id));
      const counts = (typeof PA_STOCK !== 'undefined' && PA_STOCK[p.id]) || {};
      const sys = store ? (counts[store.id] != null ? counts[store.id] : '')
        : (p.effective_stock != null ? p.effective_stock : '');
      return [name, p.sku || '', String(sys), { cls: 'write' }, { cls: 'write' }];
    });
  tdPrintTable({
    docEn: 'Stock count', docCn: '盘点表',
    subtitle: store ? cuT(store.name_en || store.name_cn || '', store.name_cn || store.name_en || '')
      : cuT('All locations', '全部门店'),
    meta: [
      // No locale at all before this: a printed document carried whatever
      // date format the operator's OPERATING SYSTEM was set to, so the same
      // count sheet read 29/07/2026 on one laptop and 7/29/2026 on the next.
      [cuT('Date', '日期'), tdWhen(new Date(), 'date')],
      [cuT('Lines', '行数'), String(rows.length)],
      [cuT('Counted by', '盘点人'), '________'],
    ],
    columns: [
      { h: '#' },
      { h: cuT('Product 商品', '商品 Product') },
      { h: 'SKU', w: '110px' },
      { h: cuT('System 系统', '系统 System'), r: true, w: '76px' },
      { h: cuT('Counted 实盘', '实盘 Counted'), r: true, w: '90px' },
      { h: cuT('Difference 差异', '差异 Difference'), r: true, w: '90px' },
    ],
    rows,
    note: cuT('Write the counted figure at the shelf. Nothing here changes the system — enter the counts in Products afterwards.',
      '请在货架前填写实盘数量。此表不会更改系统库存 — 盘点后请在商品页录入。'),
  });
}
window.paPrintCountSheet = paPrintCountSheet;

/* ── Customer statement ────────────────────────────────────────────────────
   Every order this customer has placed, with what each came to. The document a
   business customer asks for when they are reconciling their own books.

   IT IS NOT AN INVOICE, and it does not pretend to be: no tax lines, no payment
   terms, no "amount due". This platform has no tax anywhere yet (audit I-03),
   and a document that LOOKS like an invoice while getting the tax wrong is
   worse for the merchant than no document at all. */
async function cuPrintStatement(customerId) {
  const id = Number(customerId || (CU_CURRENT && CU_CURRENT.customer && CU_CURRENT.customer.id));
  if (!id) return;
  const c = (CU_CURRENT && CU_CURRENT.customer) || {};
  let orders = [];
  try {
    const j = await api('/api/retail-admin/orders?customer_id=' + id + '&limit=500');
    orders = j.data || [];
  } catch (e) {
    toast(cuT('Could not read the orders', '无法读取订单') + ': ' + (e.message || ''), 'err');
    return;
  }
  // Cancelled and unpaid orders are LISTED, not dropped, and say which they are.
  // A statement that quietly omits a cancelled order is a statement the customer
  // cannot reconcile against their own record of having placed it.
  const counted = orders.filter((o) => ['cancelled', 'refunded', 'pending_payment'].indexOf(o.status) < 0);
  const total = counted.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const rows = orders.map((o) => [
    (o.placed_at || '').slice(0, 10),
    o.order_no || ('#' + o.id),
    cuStatusWord(o.status),
    acMoney(Number(o.total) || 0),
  ]);
  tdPrintTable({
    docEn: 'Statement', docCn: '对账单',
    subtitle: c.nickname || c.phone || ('#' + id),
    meta: [
      // No locale at all before this: a printed document carried whatever
      // date format the operator's OPERATING SYSTEM was set to, so the same
      // count sheet read 29/07/2026 on one laptop and 7/29/2026 on the next.
      [cuT('Date', '日期'), tdWhen(new Date(), 'date')],
      [cuT('Orders', '订单数'), String(orders.length)],
      [cuT('Total', '合计'), acMoney(total)],
    ],
    columns: [
      { h: '#' },
      { h: cuT('Date 日期', '日期 Date'), w: '96px' },
      { h: cuT('Order 订单', '订单 Order') },
      { h: cuT('Status 状态', '状态 Status'), w: '110px' },
      { h: cuT('Total 金额', '金额 Total'), r: true, w: '110px' },
    ],
    rows,
    note: cuT('The total counts orders that were not cancelled, refunded or left unpaid. This is a record of orders, not an invoice.',
      '合计仅包含未取消、未退款且已付款的订单。本表为订单记录，非发票。'),
  });
}
window.cuPrintStatement = cuPrintStatement;

// The order status in one word, for a document a customer reads. The admin's
// own status vocabulary is written for staff; this is the short public version.
function cuStatusWord(s) {
  const m = {
    paid: ['Paid', '已付款'], preparing: ['Preparing', '备货中'], dispatched: ['Sent', '已发出'],
    delivered: ['Delivered', '已送达'], completed: ['Completed', '已完成'],
    cancelled: ['Cancelled', '已取消'], refunded: ['Refunded', '已退款'],
    pending_payment: ['Unpaid', '未付款'],
  }[s];
  return m ? cuT(m[0], m[1]) : String(s || '');
}
