/* eslint-disable no-undef */
/* retail-admin app JS — the chart primitives, in one place.

   WHAT THIS IS
   ═══════════════════════════════════════════════════════════════════════
   Every chart in this admin is hand-rolled: inline SVG, or a CSS bar. There
   is no chart library and there is not going to be one. Until now the drawing
   code lived inside 03-dashboard.js, interleaved with the fetching, the copy
   and the tooltips, which is why the same shape had already been written
   twice under two names. This file is that drawing code and nothing else.

   WHAT A FUNCTION HERE MAY DO
   ═══════════════════════════════════════════════════════════════════════
   Take data plus options, return a markup string. That is the whole contract.
   No fetching. No reading DASH_DATA or any other screen's state. No
   document.getElementById, no innerHTML, no event wiring. No knowledge of
   which tab is drawing it. Anything the caller knows — how to format money,
   what its tooltip handler is called, what a bucket's label should read —
   arrives as an option or as data already shaped by the caller.

   The one exception is escapeHtml / escapeAttr from 01-core.js: escaping is
   not the caller's business, and a chart that took pre-escaped strings would
   be a chart that eventually gets handed an unescaped one.

   THE RULES THESE CHARTS KEEP
   ═══════════════════════════════════════════════════════════════════════
   No gridlines. No axis box. No gradient. One accent colour, only where it
   means something.

   Two of the charts moved here already break one of those, both from before
   this file existed, and both are reproduced exactly as they were — the move
   changed no pixels and was not the moment to change any:
     · chartTrend draws three gridlines with value labels (from the Reports
       mockup) — marked at the code.
     · chartSparkline fills under the curve with a linearGradient wash —
       marked at the code.
   They are flagged so the next person reads them as debts, not as licence.
   Do not copy either into a new chart.

   LOADING
   ═══════════════════════════════════════════════════════════════════════
   Registered in retail-admin.html BEFORE the numbered parts that call it,
   the same way /lib/ingredient-cost.js and /lib/recipe-cost.js are: a shared
   module the parts read, not a part of its own. It defines functions only —
   nothing runs at load time. */

// ── Trend: area + line over an even x-axis, with a hover column per point ──
// The Reports trend chart. `points` is [{ v, label }] in chart order — the
// caller has already picked the metric and shortened the label. opt:
//   fmtY(v)   → the string for a y-axis value (money, count, whatever)
//   onMove    → JS for each hover column's onmousemove="" (optional)
//   onLeave   → JS for the chart's onmouseleave="" (optional)
//   className → the svg's class (default 'db-chart')
// Empty data still draws: the axis labels and the baseline stay, so the card
// holds its shape and says "nothing here" rather than collapsing.
function chartTrend(points, opt) {
  opt = opt || {};
  const t = points || [];
  const fmtY = opt.fmtY || (v => String(Math.round(v)));
  const vals = t.map(p => Number(p.v || 0));
  const max = Math.max(1, ...vals);
  const W = 1000, H = 270, padL = 8, padR = 8, padT = 20, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = t.length || 1;
  const x = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = v => padT + innerH - (v / max) * innerH;

  // PRE-EXISTING RULE BREAK — "no gridlines". Three gridlines only (the
  // Reports mockup): a solid baseline at zero and dashed lines at the half and
  // full marks, each labelled just above its line at the left. Moved here as
  // it stood; a new chart does not get these.
  let grid = '';
  for (const g of [0, 2, 4]) {
    const gy = padT + (g / 4) * innerH;
    const gv = max * (1 - g / 4);
    grid += `<line class="grid-line${g === 4 ? '' : ' dash'}" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>`;
    grid += `<text class="ax" x="${padL + 2}" y="${(gy - 4).toFixed(1)}">${fmtY(gv)}</text>`;
  }
  const linePts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = n > 1 ? `<path class="area" d="M ${linePts.join(' L ')} L ${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z"/>` : '';
  const line = n > 1 ? `<polyline class="line" points="${linePts.join(' ')}" pathLength="1"/>` : '';
  // Last-point marker — the "you are here" dot the mockup ends the line with.
  const enddot = n > 1 ? `<circle class="enddot" cx="${x(n - 1).toFixed(1)}" cy="${y(vals[n - 1]).toFixed(1)}" r="4"/>` : '';

  // A handful of x-axis date labels (the mockup shows ~4), never per-point dots
  // — the line + end dot carry the shape; hover still reads every bucket.
  const labelEvery = Math.max(1, Math.ceil(n / 4));
  const moveAttr = opt.onMove ? ` onmousemove="${opt.onMove}"` : '';
  let xl = '', hover = '';
  t.forEach((p, i) => {
    const px = x(i);
    if (i % labelEvery === 0 || i === n - 1) {
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      xl += `<text class="ax" x="${px.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${escapeHtml(String(p.label == null ? '' : p.label))}</text>`;
    }
    const colW = innerW / Math.max(1, n - 1);  // tile contiguously, point-to-point
    hover += `<rect class="hovercol" data-i="${i}"${moveAttr} x="${(px - colW / 2).toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${innerH}"></rect>`;
  });

  const leaveAttr = opt.onLeave ? ` onmouseleave="${opt.onLeave}"` : '';
  return `<svg class="${opt.className || 'db-chart'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"${leaveAttr}>${grid}${area}${line}${enddot}${hover}${xl}</svg>`;
}

// ── Bar list: label / value on one baseline, a thin track beneath ─────────
// rows: [{ k, kSub, kTitle, value, valueSub, frac (numeric weight), muted }].
// Widths are a share of the set's own max, so a list always fills its width
// and ranks at a glance. The fill keeps the `.db-track > span` shape so the
// phone clones' sweep animation still bites.
function chartBarList(rows) {
  const list = rows || [];
  const max = Math.max(1, ...list.map(r => r.frac || 0));
  return `<div class="db-bars">${list.map(r => `
    <div class="db-bar-row">
      <div class="k" title="${escapeAttr(r.kTitle || r.k)}">${escapeHtml(r.k)}${r.kSub ? ` <span class="sub">${escapeHtml(r.kSub)}</span>` : ''}</div>
      <div class="v">${escapeHtml(r.value)}${r.valueSub ? ` <span class="sub">${escapeHtml(r.valueSub)}</span>` : ''}</div>
      <div class="db-track"><span class="${r.muted ? 'muted' : ''}" style="width:${(((r.frac || 0) / max) * 100).toFixed(1)}%"></span></div>
    </div>`).join('')}</div>`;
}

// ── Magnitude rows: the bar IS the row's background tint ──────────────────
// A different shape from chartBarList — no track, no second line: the row
// itself carries a left-anchored tint scaled to the set's own max (--mag,
// read by the CSS). `opt.value(item)` drives the bar, `opt.display(item)` is
// the right-hand string, `opt.name(item)` the raw (un-escaped) left label.
// opt.variant picks the markup: 'db' = the dashboard's tile rows, 'fc' = the
// neutral KPI-strip rows every other tab uses. The two were separate copies
// of this function until this file; they differ only in the class they emit.
function chartBarRows(items, opt) {
  // Bars top out at BAR_CAP (not full width) so even the leader keeps a visible
  // right edge instead of washing the whole row into a flat tint. opt.curve =
  // 'sqrt' gives whale-skewed sets (e.g. revenue with one big customer) a
  // gentler ramp so the non-leaders stay distinguishable rather than all
  // collapsing into near-identical slivers.
  const BAR_CAP = 0.85;
  const fc = opt.variant === 'fc';
  const curve = opt.curve === 'sqrt' ? (x => Math.sqrt(x)) : (x => x);
  const vals = items.map(it => Math.max(0, Number(opt.value(it)) || 0));
  const max = Math.max(1, ...vals);
  return items.map((it, i) => {
    const v = vals[i];
    const mag = v <= 0 ? 0 : curve(Math.min(1, v / max)) * BAR_CAP;
    const cls = (fc ? 'fc-barrow' : 'db-tile-list-row') + ' has-bar' + (v <= 0 ? ' is-zero' : '');
    const name = `<span class="name">${escapeHtml(opt.name(it))}</span>`;
    const val = `<span class="val">${opt.display(it)}</span>`;
    // The two variants' line breaks are kept exactly as each emitted them
    // before the merge (one wrote its spans on their own lines, the other
    // concatenated) — the markup is byte-for-byte what it was.
    return fc
      ? `<div class="${cls}" style="--mag:${mag.toFixed(3)}">${name}${val}</div>`
      : `<div class="${cls}" style="--mag:${mag.toFixed(3)}">\n      ${name}\n      ${val}\n    </div>`;
  }).join('');
}

// ── Mini curve: one quiet line above a baseline, on a fixed scale ─────────
// The cohort retention decay. Not chartTrend with the options turned off: no
// area, no end dot, no hover, no axis labels, and the y-scale is the fixed
// 0–opt.max (percent) rather than the series' own maximum — a curve that
// flattens near zero must LOOK like it flattened near zero.
// Fewer than two points is not a curve: returns '' and the caller draws
// whatever it draws when there is nothing to show.
function chartMiniCurve(values, opt) {
  opt = opt || {};
  const vals = (values || []).map(v => Number(v) || 0);
  if (vals.length < 2) return '';
  const W = 400, H = 80, padT = 6, padB = 8;
  const max = Number(opt.max) || 100;
  const ih = H - padT - padB;
  const xs = i => (i / (vals.length - 1)) * W;
  const ys = v => padT + ih - (v / max) * ih;
  const pts = vals.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
  return `<svg class="${opt.className || 'db-ret-curve'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="base" x1="0" y1="${H - padB}" x2="${W}" y2="${H - padB}"/>
      <polyline class="line" points="${pts}"/>
    </svg>`;
}

// ── Heat cells: one tinted square per bucket, in reading order ────────────
// The cells of an intensity grid and nothing else — the caller lays them out
// (7×24, 24×1, whatever its CSS says) and writes its own rail, legend and
// foot. `cells` is the grid flattened in the order it should be emitted; each
// entry is { v, title } or null for a bucket with no data. Colour is a
// scale, not a palette: one ink at a varying alpha, so a busy hour reads as
// more of the same thing rather than as a different thing.
//   opt.max     → the value that means full strength (default: the set's own)
//   opt.tint(a) → the fill at alpha `a`; opt.emptyBg → the fill for nothing
function chartHeatCells(cells, opt) {
  opt = opt || {};
  const list = cells || [];
  const emptyBg = opt.emptyBg || 'var(--td-raised)';
  const tint = opt.tint || (a => `rgba(var(--td-heat-rgb),${a})`);
  let max = Number(opt.max) || 1;
  if (!opt.max) list.forEach(c => { if (c && Number(c.v) > max) max = Number(c.v); });
  return list.map(c => {
    const intensity = c ? Number(c.v) / max : 0;
    const bg = intensity === 0 ? emptyBg : tint((0.1 + intensity * 0.75).toFixed(2));
    return `<i style="background:${bg}" title="${escapeAttr(c && c.title != null ? c.title : '')}"></i>`;
  }).join('');
}

// ── Sparkline: a smooth curve in a 100×24 box, stretched to its wrap ──────
// Catmull-Rom → cubic-bézier path through the points: one flowing curve rather
// than straight segments. Tension is gentle and the Y of each control point is
// clamped to the box so the curve can't overshoot under the horizontal
// stretch. Anchor points stay exactly on the data vertices, so a dot or a
// hover-scrub placed with chartSparkPct still lands on the line.
let _chartSparkSeq = 0;
function chartSmoothPath(p, H, pad) {
  if (p.length < 2) return '';
  const cy = v => Math.max(pad, Math.min(H - pad, v));
  let d = `M ${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2, t = 0.85;
    const c1x = p1.x + (p2.x - p0.x) / 6 * t, c1y = cy(p1.y + (p2.y - p0.y) / 6 * t);
    const c2x = p2.x - (p3.x - p1.x) / 6 * t, c2y = cy(p2.y - (p3.y - p1.y) / 6 * t);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}
// Shared y-scale for a sparkline. When a ghost (typical-day) series of the SAME
// length is present, both curves scale to their combined max/min so their
// heights compare directly. The caller stashes this so a dot and a hover-scrub
// use the same scale as the drawn line.
function chartSparkScale(vals, ghost) {
  const v = (vals || []).map(x => Number(x) || 0);
  const g = (ghost || []).map(x => Number(x) || 0);
  const use = (g.length === v.length && g.length) ? v.concat(g) : v;
  return { max: Math.max(1, ...use), min: Math.min(0, ...use) };
}
// Percent position of point `idx` within the sparkline box — shared by the
// rendered dot and any hover-scrub so the dot always lands exactly on the line
// vertex. Mirrors chartSparkline's math. `scale` (optional) forces a y-scale —
// used when a ghost series widened it.
function chartSparkPct(vals, idx, scale) {
  const W = 100, H = 24, pad = 2, n = vals.length;
  if (n < 2) return { x: 50, y: 50 };
  const max = scale ? scale.max : Math.max(1, ...vals);
  const min = scale ? scale.min : Math.min(0, ...vals);
  const span = (max - min) || 1;
  return {
    x: (pad + (idx / (n - 1)) * (W - 2 * pad)) / W * 100,
    y: ((H - pad) - ((vals[idx] - min) / span) * (H - 2 * pad)) / H * 100,
  };
}
// The sparkline itself: stretched full-width via preserveAspectRatio="none" +
// non-scaling-stroke. opts.ghost draws a dotted reference series behind it;
// opts.dot adds an HTML last-point marker (opts.pulse = the softly breathing
// variant). Returns the svg, with the dot appended AFTER it — the dot is an
// HTML element, positioned in percentages against a position:relative wrap.
function chartSparkline(values, opts) {
  opts = opts || {};
  const vals = (values || []).map(v => Number(v) || 0);
  const ghost = (opts.ghost || []).map(v => Number(v) || 0);
  const W = 100, H = 24, pad = 2;
  const hasGhost = ghost.length >= 2 && ghost.length === vals.length && ghost.some(v => v > 0);
  const todayFlat = vals.length < 2 || vals.every(v => v <= 0);
  // Nothing today AND no ghost: draw a faint dashed baseline instead of
  // vanishing — the sparkline is always visibly present, saying "no activity".
  if (todayFlat && !hasGhost) {
    const midY = (H / 2).toFixed(1);
    return `<svg class="db-spark is-flat" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
      + `<line x1="${pad}" y1="${midY}" x2="${W - pad}" y2="${midY}" stroke="currentColor" stroke-width="1" `
      + `vector-effect="non-scaling-stroke" stroke-dasharray="2 3" opacity="0.35"/></svg>`;
  }
  const n = vals.length;
  const sc = chartSparkScale(vals, hasGhost ? ghost : null);
  const max = sc.max, min = sc.min, span = (max - min) || 1;
  const x = i => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = v => (H - pad) - ((v - min) / span) * (H - 2 * pad);
  // The typical-day ghost — a dotted curve behind today's line, same y-scale so
  // heights compare directly. No fill, no dot: a reference, not data.
  let ghostSvg = '';
  if (hasGhost) {
    const gp = ghost.map((v, i) => ({ x: x(i), y: y(v) }));
    ghostSvg = `<path class="db-spark-ghost" d="${chartSmoothPath(gp, H, pad)}" fill="none" stroke="currentColor" `
      + `stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-dasharray="1.5 2.5" stroke-linecap="round" opacity="0.4"/>`;
  }
  // Today may not have started yet (all zero) while the ghost carries shape —
  // show the ghost alone, no line/area/dot.
  if (todayFlat) {
    return `<svg class="db-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${ghostSvg}</svg>`;
  }
  const p = vals.map((v, i) => ({ x: x(i), y: y(v) }));
  const d = chartSmoothPath(p, H, pad);
  // PRE-EXISTING RULE BREAK — "no gradient". The wash under the curve fades the
  // brand ink down to nothing via a <linearGradient>. Unique gradient id per
  // render so multiple sparklines on one screen never share/clobber a <defs>
  // id. Moved here as it stood; a new chart does not get a gradient.
  const gid = 'dbSparkG' + (++_chartSparkSeq);
  const defs = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity="0.26"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>`;
  const area = `<path class="db-spark-area" d="${d} L ${x(n - 1).toFixed(1)} ${(H - pad).toFixed(1)} L ${x(0).toFixed(1)} ${(H - pad).toFixed(1)} Z" fill="url(#${gid})" stroke="none"/>`;
  const line = `<path class="db-spark-line" pathLength="1" d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
  // Last-point marker as an HTML overlay (not an SVG circle): the chart uses
  // preserveAspectRatio="none", which would squash a <circle> into an ellipse.
  // The wrap is position:relative, so percentage offsets land it on the point.
  // Computed with the shared scale (not chartSparkPct's own) so it sits on the
  // line when a ghost has changed the y-scale. W=100 → viewBox unit == percent.
  let dot = '';
  if (opts.dot) {
    const idx = n - 1;
    dot = `<i class="db-spark-dot${opts.pulse ? ' is-breathing' : ''}" style="left:${x(idx).toFixed(1)}%;top:${((y(vals[idx]) / H) * 100).toFixed(1)}%"></i>`;
  }
  return `<svg class="db-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${defs}${ghostSvg}${area}${line}</svg>${dot}`;
}
