/* Builds the Tacet mobile v2 artboards (.dc.html) from the shared token sheet
   plus the per-page bodies below. Re-run after any edit:  node src/build.mjs   */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');
const CSS = readFileSync(join(HERE, '_shared.css'), 'utf8');

/* Icons — inline SVG, stroke-based, 24px grid, one style. Never emoji. */
const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  inbox: S('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  home: S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  orders: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>'),
  customers: S('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  products: S('<path d="M3 3h18l-2 14H5L3 3z"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M8 7h8"/>'),
  more: S('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  chev: S('<path d="m9 18 6-6-6-6"/>'),
  back: S('<path d="m15 18-6-6 6-6"/>'),
  close: S('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  miniapp: S('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>'),
  web: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>'),
  meituan: S('<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M9 17h5l3-7h-4"/><path d="M12 6h3"/>'),
  manual: S('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  truck: S('<path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  refund: S('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
  invoice: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>'),
  box: S('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/>'),
  printer: S('<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>'),
  dots: S('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  pin: S('<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  card: S('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>'),
  store: S('<path d="M4 9h16v11H4z"/><path d="M4 9 6 4h12l2 5"/><path d="M9 20v-6h6v6"/>'),
  ticket: S('<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4 2 2 0 0 1 0-4z"/>'),
  chart: S('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  wallet: S('<path d="M3 7a2 2 0 0 1 2-2h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M18 10h3v5h-3a2.5 2.5 0 0 1 0-5z"/>'),
  cog: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.7-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17.6 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 11a2 2 0 1 1 0 4z"/>'),
  megaphone: S('<path d="m3 11 15-6v14L3 13z"/><path d="M3 11H2v2h1"/><path d="M8 15v4h3"/>'),
  page: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  users: S('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>'),
  image: S('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 2.5-2.5L20 17"/>'),
  expand: S('<path d="M9 3H3v6"/><path d="M15 21h6v-6"/><path d="M3 3l7 7"/><path d="M21 21l-7-7"/>'),
  plusminus: S('<path d="M4 8h8"/><path d="M8 4v8"/><path d="M12 17h8"/>'),
  tag: S('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>'),
  warn: S('<path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
};

/* The Tacet mark — design-system §8 path verbatim; §8a holds the stroke
   optically at 1.6px when the mark renders 20px tall (8.8 user units). */
const MARK = `<svg viewBox="0 0 340 110" fill="none" aria-hidden="true"><path d="M20 55 C30 15, 40 95, 50 55 C59 22, 68 88, 77 55 C85 30, 93 80, 101 55 C109 38, 117 72, 125 55 C133 44, 141 66, 149 55 C160 50, 171 60, 182 55 C215 55, 260 55, 305 55" stroke="currentColor" stroke-width="8.8" stroke-linecap="round"/></svg>`;

const topbar = ({ inboxDot = true } = {}) => `
  <div class="topbar">
    <span class="lockup">${MARK}<span class="wordmark">tacet</span></span>
    <span class="spacer"></span>
    <button class="ico" aria-label="Search">${I.search}</button>
    <span class="ico-wrap"><button class="ico" aria-label="Inbox">${I.inbox}</button>${inboxDot ? '<span class="unseen-dot"></span>' : ''}</span>
    <span class="avatar">A</span>
  </div>`;

const TABS = [
  ['home', 'Home', I.home], ['orders', 'Orders', I.orders],
  ['customers', 'Customers', I.customers], ['products', 'Products', I.products],
  ['more', 'More', I.more],
];
const tabbar = (active, dots = {}) => `
  <nav class="tabbar" aria-label="Sections">
    ${TABS.map(([k, label, icon]) => `<button class="tab${k === active ? ' on' : ''}">${icon}<span class="lab">${label}</span>${dots[k] ? '<span class="dot"></span>' : ''}</button>`).join('\n    ')}
  </nav>`;

const doc = (title, body, { preview = '390,844', logic = '' } = {}) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Fraunces:opsz,wght@9..144,300&display=swap">
  <style>
${CSS}  </style>
</helmet>
${body}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${preview.split(',')[0]},"height":${preview.split(',')[1]}}}'>
class Component extends DCLogic {${logic}}
</script>
</body>
</html>
`;

export { I, MARK, topbar, tabbar, doc, OUT };
