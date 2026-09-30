/* Shared kit for the phone-parity artboards (Recipes, Purchasing, Finance).
   Tokens and shell are the LIVE phone's (public/m.html :root block and
   headControls), not the older mobile-v2 canvas: one header bar carrying the
   page's name at 20px, search + the person's initials on top-level screens, a
   back link on pushed ones, the status line below the hairline in the scroll,
   and the five-tab bar. Re-run: node design-handoff/phone-parity/src/build.mjs <outdir> */

export const CSS = `
:root{
  --paper:#FBF9F4; --ink:#111A2B; --graphite:#58606E; --dusk:#6E67AF; --sage:#A3B49F;
  --amber:#C9954A; --brick:#B4533E;
  --dusk-tint:#EEEDF6; --sage-tint:#EDF1EC; --amber-tint:#F7EEDE; --brick-tint:#F6E7E3;
  --sage-ink:#5F7357; --amber-ink:#8A6425; --brick-ink:#B4533E; --dusk-ink:#524C8F;
  --raised:#F6F3EC; --border:#E4E0D5; --header:#DAD5C6; --unseen:#F4F5F0; --edge:#948B76;
  --surface:#FFFFFF; --settle:cubic-bezier(0.16,1,0.3,1);
  --ui:'Inter','Noto Sans SC','Source Han Sans SC',system-ui,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--ui);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font-family:inherit}
.num{font-variant-numeric:tabular-nums}
.screen{width:390px;height:844px;display:flex;flex-direction:column;background:var(--paper);overflow:hidden;position:relative}
.hdr{flex:none;height:56px;display:flex;align-items:center;gap:4px;padding:0 8px 0 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.hdr.push{padding-left:4px}
.hdr h1{margin:0;flex:1;min-width:0;font-size:20px;font-weight:500;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ico{width:44px;height:44px;flex:none;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:none;color:var(--graphite);padding:0}
.ico svg{width:20px;height:20px}
.acct{width:28px;height:28px;border-radius:8px;background:var(--dusk-tint);color:var(--dusk-ink);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500}
.scroll{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:16px;padding:0 16px 16px}
.status{margin:16px 0 0;font-size:15px;color:var(--graphite)}
.cap{font-size:13px;color:var(--graphite)}
.eyebrow{margin:8px 0 -8px;font-size:13px;font-weight:500;color:var(--graphite)}
.cta{border:0;border-radius:8px;background:var(--dusk);color:#FFFFFF;font-size:15px;font-weight:500;min-height:44px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.cta.sm{min-height:36px;padding:0 12px;font-size:13px}
.btn2{border:0;border-radius:8px;background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--edge);font-size:15px;font-weight:500;min-height:44px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.btn2.sm{min-height:36px;padding:0 12px;font-size:13px}
.btn2 svg,.cta svg,.danger svg{width:18px;height:18px}
.ghost{border:0;background:none;color:var(--graphite);font-size:15px;min-height:44px;padding:0 8px}
.danger{border:0;border-radius:8px;background:var(--surface);color:var(--brick-ink);box-shadow:inset 0 0 0 1px var(--brick);font-size:15px;font-weight:500;min-height:44px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px}
.raised{background:var(--raised);border-radius:14px}
.pad{padding:16px}
.li{display:flex;align-items:center;gap:12px;min-height:56px;padding:12px 16px;width:100%;border:0;background:none;text-align:left;color:var(--ink);font-size:15px}
.li + .li{border-top:1px solid var(--border)}
.li .m{flex:1;min-width:0}
.li .t{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.li .s{display:block;font-size:13px;color:var(--graphite);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.li .r{flex:none;text-align:right;font-variant-numeric:tabular-nums}
.li .r .s{text-align:right}
.li .chev{flex:none;width:18px;height:18px;color:var(--graphite)}
.li .lead{flex:none;width:20px;height:20px;color:var(--graphite)}
.li.unseen{background:var(--unseen);box-shadow:inset 4px 0 0 var(--sage)}
.kv{display:flex;justify-content:space-between;gap:16px;padding:10px 16px;font-size:15px}
.kv + .kv{border-top:1px solid var(--border)}
.kv .k{color:var(--graphite)}
.kv .v{font-variant-numeric:tabular-nums;text-align:right}
.kv.strong .k,.kv.strong .v{color:var(--ink);font-weight:500}
.kv.sub{padding-left:32px;font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:13px;white-space:nowrap;flex:none}
.p-sage{background:var(--sage-tint);color:var(--sage-ink)}
.p-amber{background:var(--amber-tint);color:var(--amber-ink)}
.p-brick{background:var(--brick-tint);color:var(--brick-ink)}
.p-mute{background:var(--raised);color:var(--graphite)}
.p-dusk{background:var(--dusk-tint);color:var(--dusk-ink)}
.chips{display:flex;gap:8px;overflow:hidden;flex:none;margin:0 -16px;padding:0 16px}
.chip{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--graphite);font-size:13px;white-space:nowrap;flex:none}
.chip .c{font-variant-numeric:tabular-nums}
.chip.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.chip svg{width:14px;height:14px}
.seg{display:flex;background:var(--raised);border-radius:8px;padding:3px;gap:3px;flex:none}
.seg button{flex:1;border:0;background:none;border-radius:6px;min-height:36px;font-size:13px;color:var(--graphite)}
.seg button.on{background:var(--surface);color:var(--ink);font-weight:500;box-shadow:0 1px 2px rgba(17,26,43,.08)}
.subv{display:flex;gap:20px;flex:none;margin:0 -16px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface)}
.subv button{border:0;background:none;height:44px;padding:0;font-size:15px;color:var(--graphite);position:relative;white-space:nowrap}
.subv button.on{color:var(--ink);font-weight:500;box-shadow:inset 0 -2px 0 var(--ink)}
.search{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--graphite);font-size:15px;flex:none}
.search svg{width:18px;height:18px}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:13px;font-weight:500}
.inp{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:15px;color:var(--ink)}
.inp.focus{border-color:var(--dusk)}
.inp .ph{color:var(--graphite)}
.inp .u{margin-left:auto;color:var(--graphite);font-size:13px}
.inp svg{width:18px;height:18px;color:var(--graphite);margin-left:auto}
.hint{font-size:13px;color:var(--graphite)}
.err{font-size:13px;color:var(--brick-ink)}
.row2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.qty{display:flex;align-items:center;gap:0;flex:none}
.qty .sb{width:36px;height:36px;border:0;border-radius:8px;background:var(--raised);color:var(--ink);font-size:18px;display:flex;align-items:center;justify-content:center}
.qty .qv{width:56px;height:36px;margin:0 6px;border:1px solid var(--border);border-radius:8px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;font-size:15px}
.switch{flex:none;width:44px;height:26px;border-radius:999px;position:relative;background:var(--border)}
.switch.on{background:var(--ink)}
.switch span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 2px rgba(17,26,43,.2)}
.switch.on span{left:21px}
.tick{flex:none;width:22px;height:22px;border-radius:6px;border:1.5px solid var(--edge);display:flex;align-items:center;justify-content:center;background:var(--surface)}
.tick.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.tick svg{width:14px;height:14px}
.tabs{display:flex;gap:4px;flex:none}
.tabs button{flex:1;border:0;background:none;height:40px;font-size:13px;color:var(--graphite);border-radius:0;box-shadow:inset 0 -1px 0 var(--border)}
.tabs button.on{color:var(--ink);font-weight:500;box-shadow:inset 0 -2px 0 var(--ink)}
.tabs .n{margin-left:4px;font-variant-numeric:tabular-nums}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--border);border:1px solid var(--border);border-radius:14px;overflow:hidden;flex:none}
.strip.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.strip.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.strip div{background:var(--surface);padding:10px 12px}
.strip .k{display:block;font-size:12px;color:var(--graphite)}
.strip .v{display:block;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums}
.warnbox{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:14px;font-size:13px}
.warnbox svg{width:18px;height:18px;flex:none;margin-top:1px}
.warnbox.amber{background:var(--amber-tint);color:var(--amber-ink)}
.warnbox.brick{background:var(--brick-tint);color:var(--brick-ink)}
.warnbox.mute{background:var(--raised);color:var(--graphite)}
.stepper{display:flex;align-items:center;gap:6px;flex:none;font-size:12px;color:var(--graphite)}
.stepper .d{width:8px;height:8px;border-radius:50%;background:var(--border)}
.stepper .d.done{background:var(--ink)}
.stepper .d.now{background:var(--surface);box-shadow:inset 0 0 0 2px var(--ink)}
.stepper .ln{flex:1;height:1px;background:var(--border)}
.tabbar{flex:none;display:flex;height:64px;background:var(--surface);border-top:1px solid var(--border)}
.tab{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;background:none;color:var(--graphite);font-size:12px;line-height:1}
.tab svg{width:22px;height:22px}
.tab.on{color:var(--ink);font-weight:500}
.foot{flex:none;display:flex;gap:8px;padding:12px 16px 16px;background:var(--surface);border-top:1px solid var(--border)}
.foot > *{flex:1}
.scrim{position:absolute;inset:0;background:rgba(17,26,43,.38)}
.sheet{position:absolute;left:0;right:0;bottom:0;background:var(--surface);border-radius:14px 14px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 4px 16px rgba(17,26,43,.04)}
.grab{width:38px;height:4px;border-radius:999px;background:var(--border);margin:8px auto 4px;flex:none}
.shead{flex:none;display:flex;align-items:center;gap:8px;padding:4px 8px 8px 16px}
.shead h2{margin:0;flex:1;font-size:18px;font-weight:500}
.sbody{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:16px;padding:0 16px 16px}
.bar{height:6px;border-radius:999px;background:var(--raised);overflow:hidden}
.bar i{display:block;height:100%;background:var(--graphite);border-radius:999px}
.dim{opacity:.55}
.grip{flex:none;width:16px;height:16px;color:var(--graphite)}
.line{display:flex;flex-direction:column;gap:8px;padding:12px 16px}
.line + .line{border-top:1px solid var(--border)}
.line .top{display:flex;align-items:center;gap:10px}
.line .nm{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line .bot{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--graphite)}
.line .bot .sp{flex:1}
`;

const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  back: S('<path d="m15 18-6-6 6-6"/>'),
  chev: S('<path d="m9 18 6-6-6-6"/>'),
  down: S('<path d="m6 9 6 6 6-6"/>'),
  up: S('<path d="m18 15-6-6-6 6"/>'),
  close: S('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  dots: S('<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  plus: S('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  check: S('<path d="m5 12 5 5 9-10"/>'),
  warn: S('<path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  grip: S('<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>'),
  trash: S('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  printer: S('<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>'),
  share: S('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  history: S('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>'),
  archive: S('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  box: S('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/>'),
  link: S('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  utensils: S('<path d="M5 3v8a2 2 0 0 0 4 0V3"/><path d="M7 11v10"/><path d="M17 3c-1.5 1.5-2 3-2 5s.5 3 2 3v10"/>'),
  truck: S('<path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  file: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>'),
  upload: S('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>'),
  download: S('<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>'),
  calendar: S('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
  store: S('<path d="M4 9h16v11H4z"/><path d="M4 9 6 4h12l2 5"/><path d="M9 20v-6h6v6"/>'),
  phone: S('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  wallet: S('<path d="M3 7a2 2 0 0 1 2-2h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M18 10h3v5h-3a2.5 2.5 0 0 1 0-5z"/>'),
  refund: S('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
  tag: S('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>'),
  camera: S('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  pen: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  home: S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  orders: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>'),
  customers: S('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  products: S('<path d="M3 3h18l-2 14H5L3 3z"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M8 7h8"/>'),
  more: S('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  chart: S('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  scale: S('<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0z"/><path d="m19 7-3 7a3 3 0 0 0 6 0z"/>'),
};

/* ── Shell ───────────────────────────────────────────────────────────── */
export const hdrTop = (title, { cta = '' } = {}) => `
  <header class="hdr">
    <h1>${title}</h1>
    ${cta}
    <button class="ico" aria-label="Search">${I.search}</button>
    <button class="ico" aria-label="Account"><span class="acct">AS</span></button>
  </header>`;
export const hdrPush = (title, { right = '' } = {}) => `
  <header class="hdr push">
    <button class="ico" aria-label="Back">${I.back}</button>
    <h1>${title}</h1>
    ${right}
  </header>`;
export const moreBtn = `<button class="ico" aria-label="More actions">${I.dots}</button>`;

const TABS = [['home', 'Home', I.home], ['orders', 'Orders', I.orders], ['customers', 'Customers', I.customers], ['products', 'Products', I.products], ['more', 'More', I.more]];
export const tabbar = (active = 'more') => `
  <nav class="tabbar" aria-label="Sections">${TABS.map(([k, l, ic]) => `<button class="tab${k === active ? ' on' : ''}">${ic}<span>${l}</span></button>`).join('')}</nav>`;

export const chips = (items) => `<div class="chips">${items.map(([l, c, on]) => `<button class="chip${on ? ' on' : ''}">${l}${c !== undefined && c !== '' ? ` <span class="c">${c}</span>` : ''}</button>`).join('')}</div>`;
export const seg = (items) => `<div class="seg">${items.map(([l, on]) => `<button class="${on ? 'on' : ''}">${l}</button>`).join('')}</div>`;
export const subv = (items) => `<div class="subv">${items.map(([l, on]) => `<button class="${on ? 'on' : ''}">${l}</button>`).join('')}</div>`;
export const search = (ph) => `<div class="search">${I.search}<span>${ph}</span></div>`;
export const pill = (kind, l) => `<span class="pill p-${kind}">${l}</span>`;
export const field = (label, val, { ph = false, unit = '', icon = '', focus = false, hint = '', err = '' } = {}) => `
  <div class="field"><label>${label}</label>
    <div class="inp${focus ? ' focus' : ''}"><span class="${ph ? 'ph' : ''}">${val}</span>${unit ? `<span class="u">${unit}</span>` : ''}${icon}</div>
    ${hint ? `<span class="hint">${hint}</span>` : ''}${err ? `<span class="err">${err}</span>` : ''}
  </div>`;
export const kv = (k, v, cls = '') => `<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
export const li = (t, s = '', { r = '', rs = '', lead = '', chev = true, cls = '' } = {}) => `
  <button class="li ${cls}">${lead ? `<span class="lead">${lead}</span>` : ''}<span class="m"><span class="t">${t}</span>${s ? `<span class="s">${s}</span>` : ''}</span>${r || rs ? `<span class="r">${r ? `<span class="t">${r}</span>` : ''}${rs ? `<span class="s">${rs}</span>` : ''}</span>` : ''}${chev ? `<span class="chev">${I.chev}</span>` : ''}</button>`;
export const qty = (v) => `<span class="qty"><button class="sb" aria-label="Less">−</button><span class="qv">${v}</span><button class="sb" aria-label="More">+</button></span>`;
export const sw = (on) => `<span class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"><span></span></span>`;
export const tick = (on) => `<span class="tick${on ? ' on' : ''}">${on ? I.check : ''}</span>`;
export const warn = (kind, text) => `<div class="warnbox ${kind}">${I.warn}<span>${text}</span></div>`;

/* A sheet over a dimmed screen. `under` is the screen's own markup. */
export const sheet = (under, title, body, { h = 640, foot = '', right = '' } = {}) => `
  ${under}
  <div class="scrim"></div>
  <div class="sheet" style="height:${h}px">
    <div class="grab"></div>
    <div class="shead"><h2>${title}</h2>${right}<button class="ico" aria-label="Close">${I.close}</button></div>
    <div class="sbody">${body}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ''}
  </div>`;

export const doc = (title, inner) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&amp;display=swap">
<style>${CSS}</style>
</helmet>
<div class="screen">${inner}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":390,"height":844}}'>
class Component extends DCLogic {
renderVals() { return {}; }
}
</script>
</body>
</html>
`;
