import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';
import { chips } from './pages-2.mjs';

/* ══ Products — A1 Worklist with a sub-view strip (§1.7) ══════════════════ */
const prodHead = `
  <div class="page-head">
    <div style="flex:1;min-width:0"><h1>Products</h1></div>
    <button class="btn btn-primary">Add product</button>
  </div>`;

const subviews = (active) => `
  <div class="subviews">
    ${[['Catalogue'], ['Stock activity'], ['Categories']].map(([l]) =>
      `<button class="subview${l === active ? ' on' : ''}">${l}</button>`).join('\n    ')}
  </div>
  <div style="height:16px;flex:none"></div>`;

const prodCard = ({ name, meta, price, stock, kind }) => `
      <div class="reccard">
        <span class="thumb">${I.image}</span>
        <span class="rec-main">
          <span class="rec-name"><b>${name}</b></span>
          <span class="rec-sub">${meta}</span>
        </span>
        <span class="rec-side">
          <span class="num" style="display:block;font-size:15px;font-weight:500">${price}</span>
          ${kind === 'plain' ? `<span class="cap num" style="display:block">${stock}</span>`
                             : `<span class="pill p-${kind} num" style="margin-top:4px">${stock}</span>`}
        </span>
      </div>`;

const PRODUCTS = [
  prodCard({ name: 'Organic carrots 500g', meta: 'SKU 10231 · Fresh produce', price: '¥18', stock: '42 in stock', kind: 'plain' }),
  prodCard({ name: 'Oat milk 1L', meta: 'SKU 10188 · Plant-based', price: '¥32', stock: '8 left', kind: 'amber' }),
  prodCard({ name: 'Mixed nuts 250g', meta: 'SKU 10450 · Snacks', price: '¥45', stock: 'Out of stock', kind: 'brick' }),
  prodCard({ name: 'Sourdough loaf', meta: 'SKU 10012 · Bakery', price: '¥28', stock: '15 in stock', kind: 'plain' }),
  prodCard({ name: 'Cold brew 300ml', meta: 'SKU 10770 · Beverages', price: '¥22', stock: '60 in stock', kind: 'plain' }),
].join('');

const prodChips = `
  <div class="chiprow">${chips([['All', 128, true], ['Live', 112], ['Running low', 8], ['Out of stock', 4], ['Hidden', 4]])}</div>
  <div style="height:16px;flex:none"></div>`;

writeFileSync(join(OUT, 'Products.dc.html'), doc('Products', `
<div class="screen">
  ${topbar()}
  ${prodHead}
  ${subviews('Catalogue')}
  ${prodChips}
  <div class="body" style="gap:16px">${PRODUCTS}</div>
  ${tabbar('products', { more: true })}
</div>`));

/* ══ Stock activity — the second sub-view, same page ══════════════════════ */
const actRow = (name, meta, delta, auto, first) => `
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0${first ? '' : ';border-top:1px solid var(--td-border)'}">
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:15px">${name}</span>
          <span class="cap" style="display:block">${meta}</span>
        </span>
        ${auto ? `<span class="pill" style="background:var(--td-dusk-tint);color:var(--td-dusk);gap:8px"><span class="dusk-dot"></span>Automatic</span>` : ''}
        ${delta ? `<span class="num" style="flex:none;font-size:15px;font-weight:500">${delta}</span>` : ''}
      </div>`;

writeFileSync(join(OUT, 'StockActivity.dc.html'), doc('Stock activity', `
<div class="screen">
  ${topbar()}
  ${prodHead}
  ${subviews('Stock activity')}
  <div class="body" style="gap:24px">
    <section style="flex:none">
      <h2 class="sec-title" style="margin-bottom:0">Today</h2>
      ${actRow('Organic carrots 500g', 'Order RT-…047 · sold', '−4', false, true)}
      ${actRow('Mixed nuts 250g', 'Flagged out of stock', '', true)}
      ${actRow('Oat milk 1L', 'PO-…08 received · Tianhe', '+48')}
      ${actRow('Sourdough loaf', 'Order RT-…046 · sold', '−2')}
    </section>
    <section style="flex:none">
      <h2 class="sec-title" style="margin-bottom:0">Yesterday</h2>
      ${actRow('Cold brew 300ml', 'Counted at Panyu · staff', '+12', false, true)}
      ${actRow('Organic carrots 500g', 'Order RT-…041 · sold', '−6')}
    </section>
  </div>
  ${tabbar('products', { more: true })}
</div>`));

/* ══ Product record — the hybrid: a sheet with one door to the full page ══ */
const secRows = (title, rows) => `
        <section style="padding:16px 0;border-top:1px solid var(--td-border)">
          <h3 style="margin:0 0 8px;font-size:13px;font-weight:500;color:var(--td-text2)">${title}</h3>
          ${rows}
        </section>`;
const kv = (k, v, mute = false) => `
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:4px 0">
            <span style="font-size:15px${mute ? ';color:var(--td-text2)' : ''}">${k}</span>
            <span class="num" style="font-size:15px;flex:none">${v}</span>
          </div>`;

writeFileSync(join(OUT, 'ProductSheet.dc.html'), doc('Product record', `
<div class="screen">
  ${topbar()}
  ${prodHead}
  ${subviews('Catalogue')}
  ${prodChips}
  <div class="body" style="gap:16px">${PRODUCTS}</div>
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:660px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;background:var(--td-surface);padding:8px 16px 16px">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:16px">
        <span style="font-size:18px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Oat milk 1L</span>
        <span class="pill p-amber">Running low</span>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" style="flex:1;min-height:44px">Adjust stock</button>
        <button class="btn btn-secondary" style="width:44px;padding:0" aria-label="Open full page"><span style="width:20px;height:20px;display:block">${I.expand}</span></button>
        <button class="btn btn-secondary" style="width:44px;padding:0" aria-label="More actions"><span style="width:20px;height:20px;display:block">${I.dots}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0">
        <span class="thumb" style="width:64px;height:64px">${I.image}</span>
        <span style="min-width:0">
          <span class="num" style="display:block;font-size:18px;font-weight:500">¥32</span>
          <span class="cap num" style="display:block">SKU 10188 · Plant-based</span>
        </span>
      </div>
      ${secRows('Stock', kv('Tianhe store', '5') + kv('Panyu store', '3') + kv('Reorder at', '20', true))}
      ${secRows('Selling on', kv('Mini app', '¥32') + kv('Web store', '¥32') + kv('Meituan', 'Not listed', true))}
      ${secRows('Last movements', kv('PO-…08 received · Tianhe', '+48') + kv('Order RT-…047 · sold', '−2'))}
    </div>
  </div>
</div>`));

console.log('wrote Products, StockActivity, ProductSheet');
