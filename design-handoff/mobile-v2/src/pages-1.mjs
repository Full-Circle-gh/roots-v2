import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';

/* ══ Shell — the chrome all 34 pages inherit ══════════════════════════════ */
const shellRow = (n, title, caption, first) => `
      <div style="display:flex;gap:16px;padding:8px 0${first ? '' : ';border-top:1px solid var(--td-border)'}">
        <span class="num cap" style="flex:none;width:14px;line-height:1.45">${n}</span>
        <span style="min-width:0">
          <span style="display:block;font-size:15px;line-height:1.45">${title}</span>
          <span class="cap" style="display:block;line-height:1.45">${caption}</span>
        </span>
      </div>`;

writeFileSync(join(OUT, 'Shell.dc.html'), doc('Shell', `
<div class="screen">
  ${topbar()}
  <div class="body" style="padding-top:16px;gap:16px">
    <div>
      <h1 style="margin:0;font-size:24px;font-weight:500;letter-spacing:-.01em">The shell</h1>
      <p class="status-line">Two fixed regions. Everything between them is a page.</p>
    </div>
    <section>
      <h2 class="sec-title" style="margin-bottom:8px">Topbar · 56px</h2>
      ${shellRow(1, 'Brand lockup', 'Stroke held at 1.6px at 20px tall.', true)}
      ${shellRow(2, 'Co-brand slot', 'Merchant logo ≤ 72×20. No logo, no slot.')}
      ${shellRow(3, 'Search', 'The 320px field becomes one control.')}
      ${shellRow(4, 'Inbox', 'Unseen is one 6px Sage dot. Never red.')}
      ${shellRow(5, 'Account', 'Initials on a Dusk-tint square, never a circle.')}
    </section>
    <section>
      <h2 class="sec-title" style="margin-bottom:8px">Bottom nav · 64px + safe area</h2>
      ${shellRow(1, 'Five destinations', 'The other 29 live in More, flat.', true)}
      ${shellRow(2, 'Active is Ink', 'Ink 500 lit, Graphite 400 resting.')}
      ${shellRow(3, 'Labels stay words', '13px sentence case, one language.')}
      ${shellRow(4, 'Unseen is Sage', 'The topbar dot again. Never a count.')}
    </section>
  </div>
  ${tabbar('orders', { more: true })}
</div>`));

/* ══ Home — A6 Digest. Recap → needs you → everything else ════════════════ */
const recapRow = (n, text, first) => `
      <div style="display:flex;align-items:center;gap:16px;padding:8px 0${first ? '' : ';border-top:1px solid var(--td-border)'}">
        <span class="dusk-dot"></span>
        <span style="font-size:15px"><b style="font-weight:500" class="num">${n}</b> ${text}</span>
      </div>`;

const needsRow = (icon, sev, label, count, meta, first) => `
      <button style="display:flex;align-items:center;gap:16px;width:100%;min-height:64px;padding:8px 16px;background:none;border:0;${first ? '' : 'border-top:1px solid var(--td-border);'}text-align:left;font-family:var(--ui);color:var(--td-text);cursor:pointer">
        <span style="flex:none;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--td-${sev}-tint);color:var(--td-${sev}-ink)"><span style="width:20px;height:20px;display:block">${icon}</span></span>
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:15px;line-height:1.35">${label}</span>
          <span class="cap num" style="display:block;line-height:1.35">${meta}</span>
        </span>
        <span class="pill p-${sev} num">${count}</span>
        <span style="flex:none;width:20px;height:20px;color:var(--td-text2)">${I.chev}</span>
      </button>`;

const stat = (label, value, delta) => `
          <span style="min-width:0">
            <span class="cap" style="display:block;line-height:1.4">${label}</span>
            <span class="num" style="display:block;font-size:18px;font-weight:500;line-height:1.4">${value}</span>
            <span class="cap num" style="display:block;line-height:1.4">${delta}</span>
          </span>`;

writeFileSync(join(OUT, 'Main.dc.html'), doc('Home', `
<div class="screen">
  ${topbar()}
  <div class="page-head">
    <div style="flex:1;min-width:0">
      <h1>Good morning</h1>
      <p class="status-line">Wednesday, July 29</p>
    </div>
  </div>
  <div class="body" style="gap:16px">
    <section class="raised" style="padding:24px 24px 16px;flex:none">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px">
        <h2 class="sec-title" style="margin-bottom:0">While you were away</h2>
        <a href="#" style="font-size:15px;flex:none">Show the work</a>
      </div>
      <p class="cap num" style="margin:0 0 16px">since 11:42 PM</p>
      ${recapRow('14', 'orders paid — ¥4,820', true)}
      ${recapRow('6', 'orders dispatched')}
      ${recapRow('1', 'refund settled — ¥134')}
      <p style="margin:16px 0 0;font-size:15px;color:var(--td-text2)">Handled quietly. You're welcome.</p>
    </section>
    <section style="flex:none">
      <h2 class="sec-title">Needs you</h2>
      <div class="card" style="overflow:hidden">
        ${needsRow(I.truck, 'brick', 'Delivery needs a call', 2, 'oldest 4h', true)}
        ${needsRow(I.box, 'amber', 'Restock needed', 4, 'out of stock, 8 running low')}
      </div>
    </section>
    <section style="flex:none">
      <h2 class="sec-title">Today</h2>
      <div class="card" style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:16px;padding:16px">
        ${stat('Revenue', '¥12,840', '+8% vs a typical day')}
        ${stat('Orders', '37', '+5 vs a typical day')}
        ${stat('Avg. order', '¥347', 'vs a typical day')}
        ${stat('New customers', '6', '+2 vs a typical day')}
      </div>
    </section>
  </div>
  ${tabbar('home', { more: true })}
</div>`));

console.log('wrote Shell.dc.html, Main.dc.html');
