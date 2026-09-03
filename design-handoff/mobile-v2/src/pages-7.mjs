import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { I, topbar, tabbar, doc, OUT } from './build.mjs';
import { chips } from './pages-2.mjs';

/* ══════════════════════════════════════════════════════════════════════════
   BATCH FOUR — WASTE ON A PHONE.  Three options, drawn to be chosen between.
   ──────────────────────────────────────────────────────────────────────────
   Waste ships on the desktop (public/retail-admin/20-waste.js) and has a
   complete API (routes/retail-waste.js). It does NOT exist in the phone build:
   `waste` appears zero times in public/m.html — no More row, no ROUTE_CAP
   entry, no screen. So an operator holding waste:view and waste:record — which
   the `warehouse` and `store_manager` presets BOTH grant by default
   (lib/capabilities.js) — can record a loss at a desk and not on the shelf
   where the loss happened. Granting the permission changes nothing on a phone,
   because the screen is not there to gate.

   These artboards do not add a screen. They put the three honest answers side
   by side so the entry point can be decided once, in the open, rather than
   inherited from whichever one got built first.

     A  Its own More row + its own Worklist       — desktop parity
     B  A fourth sub-view under Products          — waste is a stock movement
     C  Capture-first: the form IS the screen     — the phone is where it happens

   WHAT EVERY OPTION INHERITS, because the API already decided it:
     · Products are counted in WHOLE units, and a quantity above on-hand is
       REFUSED, not clamped — so on-hand is shown while choosing, never at the
       refusal (routes/retail-waste.js POST /).
     · The cost is a snapshot the server takes once. A product with no cost on
       file records as "No cost" — never ¥0.00, never a dash (§32 rule 10).
     · Voiding writes a REVERSAL and both rows stay visible; the totals are
       always the live subset (§32 rule 11). waste:void is a separate
       capability that neither warehouse nor store_manager holds, so the Void
       control is drawn absent for them, not disabled.
     · Seven reason codes, served by GET /waste/reasons. The list is fixed and
       is not account-editable in this phase.

   DESIGN RULES THIS BATCH APPLIES:
     · No status line. Nothing in a waste ledger is WAITING on an operator —
       every row is finished business (§1.7's work rule; Customers is the
       reference case and the desktop screen already states this).
     · The pulse takes its line render, as Customers' does: four figures cannot
       share a 390px row.
     · ONE Dusk element — the record CTA. Recording a loss is the operator
       acting, but it is the page's single primary and the Dusk budget is per
       screen, so it takes the slot Orders and Products leave empty.
     · No unseen surface anywhere. A waste entry does not ARRIVE; a colleague
       wrote it.
   ══════════════════════════════════════════════════════════════════════════ */

const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICO = {
  trash: S('<path d="M3.5 6.5h17"/><path d="M9 6.5V4.5h6v2"/><path d="M18.5 6.5 17.6 19a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6.5"/>'),
  plus: S('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  minus: S('<path d="M5 12h14"/>'),
  undo: S('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
};

/* ── The waste entry, as a card ────────────────────────────────────────────
   The Worklist row's phone render, carrying every load-bearing column the
   desktop table has: date, store, product, qty, reason, cost. Qty and reason
   share the sub-line because neither is legible alone — "4" means nothing
   without "spoiled" beside it.

   Cost sits on the right where money sits on every other card in this app.
   An uncosted row prints the words in Graphite instead of a figure: zero and
   unknown must not look alike. A voided row and its reversal both grey out —
   they are in the list so a correction cannot go unnoticed, not because they
   are still money. */
const wCard = ({ name, qty, reason, store, cost, when, mark, mute }) => `
      <div class="reccard">
        <span class="rec-main">
          <span class="rec-name"${mute ? ' style="color:var(--td-text2)"' : ''}><b>${name}</b>${mark ? `<span class="pill p-mute">${mark}</span>` : ''}</span>
          <span class="rec-sub">${qty} × · ${reason} · ${store}</span>
        </span>
        <span class="rec-side">
          <span class="num${mute || cost === 'No cost' ? ' zero' : ''}" style="display:block;font-size:15px;font-weight:500">${cost}</span>
          <span class="cap num" style="display:block">${when}</span>
        </span>
      </div>`;

const ENTRIES = [
  wCard({ name: 'Oat milk 1L', qty: 4, reason: 'Spoiled', store: 'Tianhe', cost: '¥96', when: '09:14' }),
  wCard({ name: 'Sourdough loaf', qty: 2, reason: 'Expired', store: 'Tianhe', cost: '¥34', when: '08:40' }),
  wCard({ name: 'Mixed nuts 250g', qty: 1, reason: 'Damaged', store: 'Panyu', cost: 'No cost', when: 'Yesterday' }),
  wCard({ name: 'Cold brew 300ml', qty: 6, reason: 'Staff consumption', store: 'Tianhe', cost: '¥84', when: 'Yesterday' }),
  wCard({ name: 'Organic carrots 500g', qty: 3, reason: 'Spoiled', store: 'Panyu', cost: '¥42', when: 'Mon', mark: 'Voided', mute: true }),
  wCard({ name: 'Organic carrots 500g', qty: 3, reason: 'Spoiled', store: 'Panyu', cost: '¥42', when: 'Mon', mark: 'Reversal', mute: true }),
].join('');

/* The pulse, as one line. The uncosted count travels WITH the total, always —
   a total shown alone reads as complete, and the whole point of the flag is
   that sometimes it is not. Voided is stated for the same reason: the reader
   can see corrections exist and that they are not in the number. */
const PULSE = '<p class="cap num" style="margin:0;padding:0 16px 16px;flex:none">¥256 written off · 1 with no cost · 1 voided</p>';

/* Two axes, both of them chips. The desktop filters on a date RANGE with two
   date inputs; a phone gets three presets instead — a native date picker twice
   over, to answer "this week", is four taps and a keyboard for a question with
   three usual answers. The range a preset cannot express stays on the desktop.
   Reasons are the desktop's dropdown, unrolled: seven codes fit a scroller and
   a select on a phone hides the one thing worth seeing, which is that
   staff consumption and sampling are counted separately. */
const RANGE_CHIPS = `<div class="chiprow">${chips([['Today', 4], ['7 days', 11, true], ['30 days', 38]])}</div>`;
const REASON_CHIPS = `<div class="chiprow">${chips([['All reasons', 11, true], ['Spoiled', 5], ['Expired', 3], ['Damaged', 2], ['Staff', 1]])}</div>`;
const FILTERS = `
  ${RANGE_CHIPS}
  <div style="height:8px;flex:none"></div>
  ${REASON_CHIPS}
  <div style="height:16px;flex:none"></div>`;

/* The header. Title, no status line, one Dusk CTA — three elements and there
   is no fourth. The CTA is gated on waste:record: an operator with view only
   gets the title alone and an empty slot, which is the finished answer. */
const wasteHead = ({ cta = true } = {}) => `
  <div class="page-head">
    <div style="flex:1;min-width:0"><h1>Waste</h1></div>
    ${cta ? `<button class="btn btn-primary" style="flex:none">Record</button>` : ''}
  </div>`;

/* ══ OPTION A — its own More row, its own Worklist ════════════════════════ */
writeFileSync(join(OUT, 'WasteList.dc.html'), doc('Waste · option A', `
<div class="screen">
  ${topbar()}
  ${wasteHead()}
  ${PULSE}
  ${FILTERS}
  <div class="body" style="gap:16px">${ENTRIES}</div>
  ${tabbar('more', { more: true })}
</div>`));

/* ══ The record sheet — shared by A and B ═════════════════════════════════
   §1.13: every field visible on open, fixed height, one commit. That is a
   sheet, and nothing here is abandonable-and-resumable.

   The order of the fields is the order of the questions a person holding a
   dropped jar actually asks: what, how many, why. Store leads only because
   the picker cannot run without it, and it collapses to a line of text for
   the single-store account — a picker that can only pick one thing is not a
   choice (§1.9).

   ON-HAND SITS UNDER THE PRODUCT, NOT UNDER THE STEPPER. The API refuses a
   quantity above it, and finding that out after pressing the button is the
   worse half of the same information.

   THE COST LINE IS THE PREVIEW ENDPOINT, not arithmetic done here — the same
   accessor the write uses, so the figure shown and the figure stored cannot
   disagree. It reads "No cost on file" for a product without one, in the same
   slot, so the operator hears it before the save and not next week. */
const field = (label, control) => `
      <div style="margin-top:16px">
        <span class="cap" style="display:block;font-weight:500;color:var(--td-text);margin-bottom:4px">${label}</span>
        ${control}
      </div>`;
const box = (inner, extra = '') => `<div style="border:1px solid var(--td-border);border-radius:8px;background:var(--td-surface);min-height:44px;display:flex;align-items:center;gap:8px;padding:0 12px;${extra}">${inner}</div>`;
const step = (glyph, dim) => `<button class="btn btn-secondary" style="width:44px;height:44px;padding:0;flex:none${dim ? ';opacity:.55' : ''}"><span style="width:20px;height:20px;display:block">${glyph}</span></button>`;

const recordSheet = `
  <div style="position:absolute;inset:0;background:rgba(17,26,43,.38)"></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:700px;background:var(--td-surface);border-radius:14px 14px 0 0;box-shadow:0 1px 2px rgba(17,26,43,.05), 0 4px 16px rgba(17,26,43,.04);display:flex;flex-direction:column;overflow:hidden">
    <div style="flex:none;padding:8px 16px 16px;border-bottom:1px solid var(--td-border)">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--td-border);margin:0 auto 16px"></div>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:18px;font-weight:500">Record waste</span>
        <span style="flex:1"></span>
        <button class="ico" style="margin-right:-8px" aria-label="Close"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
    </div>
    <div style="flex:1;min-height:0;overflow:hidden;padding:0 16px 16px">
      ${field('Store', box(`<span style="width:20px;height:20px;display:block;color:var(--td-text2);flex:none">${I.store}</span><span style="flex:1">Tianhe store</span><span style="width:20px;height:20px;display:block;color:var(--td-text2);flex:none;transform:rotate(90deg)">${I.chev}</span>`))}
      ${field('Product', box(`<span style="width:20px;height:20px;display:block;color:var(--td-text2);flex:none">${I.search}</span><span style="flex:1">Oat milk 1L</span>`)
        + `<p class="cap num" style="margin:4px 0 0">18 on hand · SKU 10188</p>`)}
      ${field('Quantity', `<div style="display:flex;align-items:center;gap:12px">
          ${step(ICO.minus)}
          <span class="num" style="flex:1;height:44px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:500;border:1px solid var(--td-border);border-radius:8px;background:var(--td-surface)">4</span>
          ${step(ICO.plus)}
        </div>`)}
      ${field('Reason', `<div style="display:flex;gap:8px;overflow:hidden">${chips([['Spoiled', null, true], ['Expired'], ['Damaged'], ['Preparation error']])}</div>
        <div style="display:flex;gap:8px;overflow:hidden;margin-top:8px">${chips([['Staff consumption'], ['Sampling'], ['Other']])}</div>`)}
      ${field('Note <span style="color:var(--td-text2);font-weight:400">· optional</span>', box('<span style="color:var(--td-text2)">Left out of the chiller overnight</span>'))}
    </div>
    <div style="flex:none;padding:16px;border-top:1px solid var(--td-border);display:flex;align-items:center;gap:16px">
      <span class="cap num" style="flex:1;min-width:0">Cost ¥96 · stock drops to 14</span>
      <button class="btn btn-primary" style="flex:none">Record waste</button>
    </div>
  </div>`;

writeFileSync(join(OUT, 'WasteRecord.dc.html'), doc('Waste · record', `
<div class="screen">
  ${topbar()}
  ${wasteHead()}
  ${PULSE}
  ${FILTERS}
  <div class="body" style="gap:16px">${ENTRIES}</div>
  ${recordSheet}
</div>`));

/* ══ OPTION B — a fourth sub-view under Products ══════════════════════════
   Waste IS a stock movement, so it sits beside Stock activity rather than in
   a list of its own. Costs nothing in More and nothing in the tab bar.

   THREE THINGS TO WEIGH, ALL DRAWN RATHER THAN ARGUED:
   1. THE STRIP NO LONGER FITS, and the artboard shows it rather than saying
      it. Measured in Chromium at 390px: Catalogue 76 + Stock activity 102 +
      Waste 46 + Categories 81, three 24px gaps and the 32px gutters = 409px
      of content in a 390px screen. Categories is clipped 8px past the right
      edge with nothing to indicate more is there. Fixing it means a
      scrolling strip (a nav that hides its own last item), a shorter label,
      or dropping one — and every one of those is a change to Products made
      to accommodate Waste, which is the tail wagging the dog.
   2. The page's Dusk CTA changes with the sub-view — the header is empty on
      Catalogue (no create flow on a phone) and Dusk here. A header that
      changes underneath the same title is a small cost, but it is a cost.
   3. It reaches waste through products:view. The API deliberately does NOT
      do that: the waste picker is gated on the waste capability alone,
      precisely because the kitchen screen's picker sat behind `products` and
      handed a waste-only operator an empty list (H13). Every preset that
      grants waste today also grants products:view, so nothing breaks now —
      but this option makes true in the navigation the coupling the API was
      written to break. */
const prodStrip = (active) => `
  <div class="subviews">
    ${['Catalogue', 'Stock activity', 'Waste', 'Categories'].map((l) =>
      `<button class="subview${l === active ? ' on' : ''}">${l}</button>`).join('\n    ')}
  </div>
  <div style="height:16px;flex:none"></div>`;

writeFileSync(join(OUT, 'WasteSubview.dc.html'), doc('Waste · option B', `
<div class="screen">
  ${topbar()}
  <div class="page-head">
    <div style="flex:1;min-width:0"><h1>Products</h1></div>
    <button class="btn btn-primary" style="flex:none">Record</button>
  </div>
  ${prodStrip('Waste')}
  ${PULSE}
  ${REASON_CHIPS}
  <div style="height:16px;flex:none"></div>
  <div class="body" style="gap:16px">${ENTRIES}</div>
  ${tabbar('products', { more: true })}
</div>`));

/* ══ OPTION C — capture-first: the form IS the screen ═════════════════════
   The premise the other two do not test: on a phone the loss is happening in
   front of you. You are holding the jar. Reading a 30-day ledger is a desk
   job and the desktop already does it well.

   So More carries "Record waste" — a verb, beside Add stock, which is the
   tool it is actually a sibling of — and the row lands on the form. The
   ledger under it is TODAY AT THIS STORE and nothing else: enough to see that
   your entry landed and that a colleague already logged the same tray, which
   is the only reading anyone does with a jar in one hand. "All entries" is
   one line at the foot, and on this option it opens the desktop screen.

   The steppers are 56px, matching Add stock (public/m.html screenStockAdd) —
   the same thumb, the same posture, the same aisle.

   THE SEARCH FIELD IS GONE, not hidden by the artboard. It is the screen's
   first control and it COLLAPSES INTO THE CARD once a product is chosen —
   the card's × puts it back. Drawn in the chosen state because that is the
   state the rest of the screen depends on, and because a search box kept
   above a picked product costs 64px that the ledger under it needs. The
   unpicked state is the same screen with the field where the card is and
   everything below it absent.

   WHAT THIS OPTION GIVES UP, stated rather than discovered later: no range
   filter, no reason filter, no history past today, and no void — voiding is a
   correction made from the record, and waste:void is an owner capability
   anyway. If the phone should be able to answer "what did we lose this
   month", this is the wrong option and A is the right one. */
const captureCard = `
    <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:8px;flex:none">
      <div style="display:flex;align-items:center;gap:12px">
        <span class="thumb">${I.image}</span>
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:18px;font-weight:500;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Oat milk 1L</span>
          <span class="cap num" style="display:block">18 on hand · SKU 10188</span>
        </span>
        <button class="ico" style="margin-right:-8px" aria-label="Clear"><span style="width:20px;height:20px;display:block">${I.close}</span></button>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
        <button class="btn btn-secondary" style="width:56px;height:56px;padding:0;flex:none"><span style="width:24px;height:24px;display:block">${ICO.minus}</span></button>
        <span class="num" style="flex:1;height:56px;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:500;letter-spacing:-.01em">4</span>
        <button class="btn btn-secondary" style="width:56px;height:56px;padding:0;flex:none"><span style="width:24px;height:24px;display:block">${ICO.plus}</span></button>
      </div>
    </div>`;

const todayRow = (name, meta, cost, first) => `
      <div style="display:flex;align-items:center;gap:16px;padding:12px 0${first ? '' : ';border-top:1px solid var(--td-border)'}">
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
          <span class="cap num" style="display:block">${meta}</span>
        </span>
        <span class="num" style="flex:none;font-size:15px">${cost}</span>
      </div>`;

writeFileSync(join(OUT, 'WasteCapture.dc.html'), doc('Waste · option C', `
<div class="screen">
  ${topbar()}
  <div class="page-head">
    <div style="flex:1;min-width:0">
      <h1>Record waste</h1>
      <p class="status-line">Tianhe store</p>
    </div>
  </div>
  <div class="body" style="gap:16px">
    ${captureCard}
    <div style="flex:none">
      <span class="cap" style="display:block;font-weight:500;color:var(--td-text);margin-bottom:8px">Reason</span>
      <div style="display:flex;gap:8px;overflow:hidden">${chips([['Spoiled', null, true], ['Expired'], ['Damaged'], ['Preparation error']])}</div>
      <div style="display:flex;gap:8px;overflow:hidden;margin-top:8px">${chips([['Staff consumption'], ['Sampling'], ['Other']])}</div>
    </div>
    <div style="display:flex;align-items:center;gap:16px;flex:none">
      <span class="cap num" style="flex:1;min-width:0">Cost ¥96 · stock drops to 14</span>
      <button class="btn btn-primary" style="flex:none">Record waste</button>
    </div>
    <section style="flex:none;border-top:1px solid var(--td-border);padding-top:16px">
      <h2 class="sec-title" style="margin-bottom:0;font-size:15px;color:var(--td-text2)">Today at Tianhe</h2>
      ${todayRow('Sourdough loaf', '2 × · Expired · 08:40 · Mei', '¥34', true)}
      ${todayRow('Mixed nuts 250g', '1 × · Damaged · 08:12 · Wei', 'No cost')}
      <p class="cap" style="margin:12px 0 0"><a href="#">All entries</a></p>
    </section>
  </div>
  ${tabbar('more', { more: true })}
</div>`));

/* ══ Empty — every option inherits this one ═══════════════════════════════
   A compliment, not an apology (§5), and it is the desktop's own line. The
   Dusk CTA stays: nothing has been recorded yet is exactly the moment the
   first record gets made.

   NOT DRAWN, and deliberately: the no-results state. It is Orders' —
   "Nothing matches those filters" with a clear — and it is inherited whole.
   Empty and no-results stay two states and two sentences. */
writeFileSync(join(OUT, 'WasteEmpty.dc.html'), doc('Waste · empty', `
<div class="screen">
  ${topbar()}
  ${wasteHead()}
  <div class="body" style="justify-content:center;align-items:center;gap:8px;padding-bottom:120px;text-align:center">
    <p style="margin:0;font-size:18px;font-weight:500">Nothing wasted yet</p>
    <p class="cap" style="margin:0;max-width:260px">Long may it last. Anything you write off here comes straight off the shelf count.</p>
  </div>
  ${tabbar('more', { more: true })}
</div>`));

/* ══ Where it lives in More — the entry point, for A and C ════════════════
   A and C differ by one word in one row, and the word is the whole argument:
   "Waste" opens a ledger you then act from; "Record waste" opens the act. Both
   sit in Operations after Receiving, beside Add stock, because that is the
   group whose rows are things you do while standing up.

   B has no row here at all — that is its case, drawn as an absence. */
const moreRow = (icon, label, sub) => `
        <div class="crow">
          <span style="width:20px;height:20px;flex:none;color:var(--td-text2);display:block">${icon}</span>
          <span class="crow-main"><b>${label}</b>${sub ? `<span class="cap" style="display:block">${sub}</span>` : ''}</span>
          <span style="width:20px;height:20px;flex:none;color:var(--td-text2);display:block">${I.chev}</span>
        </div>`;

writeFileSync(join(OUT, 'WasteMore.dc.html'), doc('Waste · in More', `
<div class="screen">
  ${topbar()}
  <div class="page-head"><div style="flex:1;min-width:0"><h1>More</h1></div></div>
  <div class="body" style="gap:24px">
    <section style="flex:none">
      <h2 class="sec-title" style="margin-bottom:8px">Operations</h2>
      <div class="card" style="overflow:hidden">
        ${moreRow(I.invoice, 'Invoices', '')}
        ${moreRow(I.truck, 'Purchasing', '')}
        ${moreRow(I.box, 'Receiving', '')}
        ${moreRow(ICO.trash, 'Waste', 'Option A — the ledger, act from it')}
        ${moreRow(ICO.trash, 'Record waste', 'Option C — the act, ledger under it')}
        ${moreRow(I.plusminus, 'Add stock', '')}
      </div>
    </section>
    <p class="cap" style="margin:0;flex:none">One row ships, not two. The row is hidden entirely for an operator without waste:view — the same rule every other row here follows, and the reason granting the permission has to change something a phone can see.</p>
  </div>
  ${tabbar('more', { more: true })}
</div>`));

console.log('wrote WasteList, WasteRecord, WasteSubview, WasteCapture, WasteEmpty, WasteMore');
