#!/usr/bin/env python3
"""Render the product pull as a self-contained page."""
import json, os

ROWS = json.load(open('/home/user/roots-v2/docs/product-data-pull/product-pull-raw.json'))
COLS = ['sku','barcode','category','name_en','name_cn','retail_price_cny','pack_size_net_weight',
        'storage_temp','ingredients','description_en','description_cn','free_of','tags','stock_qty',
        'sales_units_gzgrocery','sales_units_miniapp','gaps','unfilled_placeholders',
        'source','parent_sku','variant_label','external_id','full_description_text']

total      = len(ROWS)
no_desc    = sum(1 for r in ROWS if not r['full_description_text'].strip())
off_spine  = sum(1 for r in ROWS if r['source'] != 'products_import.json')
with_sales = sum(1 for r in ROWS if r['sales_units_gzgrocery'] + r['sales_units_miniapp'])
w_ing      = sum(1 for r in ROWS if r['ingredients'])
w_net      = sum(1 for r in ROWS if r['pack_size_net_weight'])
w_sto      = sum(1 for r in ROWS if r['storage_temp'])

payload = json.dumps({'cols': COLS, 'rows': ROWS}, ensure_ascii=False, separators=(',', ':'))
payload = payload.replace('</', '<\\/')

HTML = f"""<title>Roots Product Pull</title>
<style>
:root {{
  --ground:#FBFBF8; --surface:#FFFFFF; --sunk:#F2F3EF;
  --ink:#1A201C; --ink-2:#4A544D; --ink-3:#78837B;
  --line:#E1E4DE; --line-2:#CFD4CB;
  --accent:#2F5D45; --accent-soft:#E4EDE6;
  --miss:#9E3B2A; --miss-soft:#F6E6E2;
  --part:#8A6014; --part-soft:#F6EDDC;
  --ok:#2F5D45; --ok-soft:#E4EDE6;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}}
@media (prefers-color-scheme:dark) {{
  :root:not([data-theme="light"]) {{
    --ground:#12160F; --surface:#191E17; --sunk:#1F251D;
    --ink:#E9EEE6; --ink-2:#A9B4A6; --ink-3:#7C877A;
    --line:#2A3127; --line-2:#3A4236;
    --accent:#82BC96; --accent-soft:#1E2A22;
    --miss:#E08C79; --miss-soft:#2E1E1A;
    --part:#D6AC63; --part-soft:#2B2317;
    --ok:#82BC96; --ok-soft:#1E2A22;
  }}
}}
:root[data-theme="dark"] {{
  --ground:#12160F; --surface:#191E17; --sunk:#1F251D;
  --ink:#E9EEE6; --ink-2:#A9B4A6; --ink-3:#7C877A;
  --line:#2A3127; --line-2:#3A4236;
  --accent:#82BC96; --accent-soft:#1E2A22;
  --miss:#E08C79; --miss-soft:#2E1E1A;
  --part:#D6AC63; --part-soft:#2B2317;
  --ok:#82BC96; --ok-soft:#1E2A22;
}}
* {{ box-sizing:border-box; }}
body {{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:var(--sans); font-size:16px; line-height:1.55;
  -webkit-text-size-adjust:100%;
}}
.wrap {{ max-width:1080px; margin:0 auto; padding:28px 18px 72px; }}

header {{ display:flex; flex-direction:column; gap:10px; margin-bottom:26px; }}
.eyebrow {{
  font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--ink-3);
}}
h1 {{ margin:0; font-size:clamp(28px,6vw,40px); line-height:1.1; letter-spacing:-.02em; text-wrap:balance; }}
.standfirst {{
  font-family:var(--serif); font-size:clamp(16px,3.4vw,18px); line-height:1.6;
  color:var(--ink-2); margin:0; max-width:62ch;
}}

.warn {{
  display:flex; gap:12px; align-items:flex-start;
  border:1px solid var(--line); border-left:3px solid var(--miss);
  background:var(--surface); border-radius:3px; padding:14px 16px; margin:22px 0;
}}
.warn p {{ margin:0; font-size:14.5px; color:var(--ink-2); }}
.warn strong {{ color:var(--ink); }}
.warn .mk {{ font-family:var(--mono); font-size:11px; color:var(--miss); letter-spacing:.1em; padding-top:3px; }}

.tiles {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr)); gap:1px;
  background:var(--line); border:1px solid var(--line); border-radius:3px; overflow:hidden; margin-bottom:8px; }}
.tile {{ background:var(--surface); padding:14px 16px; display:flex; flex-direction:column; gap:2px; }}
.tile .v {{ font-size:27px; font-weight:650; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }}
.tile .k {{ font-size:12.5px; color:var(--ink-3); line-height:1.35; }}
.tile.bad .v {{ color:var(--miss); }}
.tile.part .v {{ color:var(--part); }}

.meter {{ display:flex; height:6px; border-radius:3px; overflow:hidden; background:var(--sunk);
  border:1px solid var(--line); margin:14px 0 4px; }}
.meter i {{ display:block; }}
.legend {{ display:flex; flex-wrap:wrap; gap:14px; font-size:12.5px; color:var(--ink-3); margin-bottom:26px; }}
.legend span {{ display:flex; align-items:center; gap:6px; }}
.dot {{ width:8px; height:8px; border-radius:2px; flex:none; }}

h2 {{ font-size:13px; font-family:var(--mono); letter-spacing:.12em; text-transform:uppercase;
  color:var(--ink-3); margin:34px 0 12px; font-weight:500; }}

.controls {{ display:flex; flex-direction:column; gap:10px; position:sticky; top:0; z-index:5;
  background:var(--ground); padding:10px 0 12px; border-bottom:1px solid var(--line); margin-bottom:14px; }}
.row1 {{ display:flex; gap:8px; }}
input[type=search] {{
  flex:1; min-width:0; font:inherit; font-size:15px; padding:10px 12px;
  border:1px solid var(--line-2); border-radius:3px; background:var(--surface); color:var(--ink);
}}
input[type=search]:focus-visible, button:focus-visible {{ outline:2px solid var(--accent); outline-offset:1px; }}
button {{ font:inherit; cursor:pointer; }}
.dl {{ padding:10px 15px; border:1px solid var(--accent); background:var(--accent); color:var(--ground);
  border-radius:3px; font-size:14.5px; font-weight:550; white-space:nowrap; }}
.dl:disabled {{ opacity:.5; cursor:default; }}
.chips {{ display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; -webkit-overflow-scrolling:touch; }}
.chip {{ padding:6px 11px; border:1px solid var(--line-2); background:var(--surface); color:var(--ink-2);
  border-radius:100px; font-size:13px; white-space:nowrap; }}
.chip[aria-pressed="true"] {{ background:var(--accent); border-color:var(--accent); color:var(--ground); }}
.count {{ font-family:var(--mono); font-size:12px; color:var(--ink-3); }}
.saved {{ font-size:13px; color:var(--ink-2); min-height:18px; }}

ul.list {{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:1px;
  background:var(--line); border:1px solid var(--line); border-radius:3px; overflow:hidden; }}
li.item {{ background:var(--surface); }}
.head {{ display:grid; grid-template-columns:1fr auto; gap:4px 12px; padding:13px 15px;
  cursor:pointer; align-items:baseline; width:100%; text-align:left; border:0; background:none; color:inherit; }}
.head:hover {{ background:var(--sunk); }}
.nm {{ font-size:15.5px; font-weight:560; line-height:1.3; }}
.cn {{ font-size:13.5px; color:var(--ink-2); }}
.sku {{ font-family:var(--mono); font-size:11.5px; color:var(--ink-3); }}
.price {{ font-variant-numeric:tabular-nums; font-size:15px; font-weight:560; white-space:nowrap; }}
.units {{ font-family:var(--mono); font-size:11.5px; color:var(--ink-3); white-space:nowrap; }}
.metaline {{ grid-column:1/-1; display:flex; flex-wrap:wrap; gap:6px; margin-top:5px; }}
.tag {{ font-size:11px; padding:2px 7px; border-radius:2px; letter-spacing:.02em; }}
.tag.miss {{ background:var(--miss-soft); color:var(--miss); }}
.tag.part {{ background:var(--part-soft); color:var(--part); }}
.tag.ok {{ background:var(--ok-soft); color:var(--ok); }}
.detail {{ display:none; padding:2px 15px 17px; border-top:1px solid var(--line); }}
li.open .detail {{ display:block; }}
dl {{ margin:0; display:grid; grid-template-columns:minmax(96px,auto) 1fr; gap:7px 14px; font-size:14px; }}
dt {{ font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ink-3); padding-top:3px; }}
dd {{ margin:0; color:var(--ink-2); overflow-wrap:anywhere; }}
dd.none {{ color:var(--miss); font-style:italic; }}
pre.copy {{ margin:10px 0 0; white-space:pre-wrap; font-family:var(--serif); font-size:14px;
  line-height:1.6; color:var(--ink-2); background:var(--sunk); border:1px solid var(--line);
  border-radius:3px; padding:12px 14px; max-height:320px; overflow:auto; }}
.empty {{ padding:34px 16px; text-align:center; color:var(--ink-3); font-size:14.5px; }}

table.src {{ width:100%; border-collapse:collapse; font-size:14px; }}
table.src th, table.src td {{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
  vertical-align:top; }}
table.src th {{ font-size:11px; font-family:var(--mono); text-transform:uppercase; letter-spacing:.08em;
  color:var(--ink-3); font-weight:500; }}
table.src td:first-child {{ font-family:var(--mono); font-size:12px; white-space:nowrap; }}
.scroll {{ overflow-x:auto; border:1px solid var(--line); border-radius:3px; background:var(--surface); }}
footer {{ margin-top:42px; padding-top:18px; border-top:1px solid var(--line);
  font-size:13px; color:var(--ink-3); }}
@media (prefers-reduced-motion:reduce) {{ * {{ animation:none!important; transition:none!important; }} }}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Raw pull · not yet analysed</div>
  <h1>Roots Product Pull</h1>
  <p class="standfirst">Every product this machine knows about, assembled from files committed to
  <span style="font-family:var(--mono);font-size:.9em">roots-v2</span>. Each value is copied
  verbatim from a source file — nothing is inferred, and a field the sources don't carry is left
  empty rather than filled in.</p>
</header>

<div class="warn">
  <div class="mk">NOTE</div>
  <p><strong>This is not a live export.</strong> There is no database and no API credentials on
  this machine — <span style="font-family:var(--mono);font-size:.92em">data/roots.db</span> doesn't
  exist and no <span style="font-family:var(--mono);font-size:.92em">.env</span> is present. Sales
  figures stop at <strong>30 May 2026</strong>, so June–August are absent from the requested
  six-month window.</p>
</div>

<div class="tiles">
  <div class="tile"><span class="v">{total}</span><span class="k">products, reconciled across all sources</span></div>
  <div class="tile bad"><span class="v">{no_desc}</span><span class="k">with no description at all</span></div>
  <div class="tile part"><span class="v">{off_spine}</span><span class="k">missing from the catalogue file</span></div>
  <div class="tile"><span class="v">{with_sales}</span><span class="k">with sales in the window</span></div>
</div>

<div class="meter" role="img" aria-label="{total - no_desc} of {total} products carry product copy">
  <i style="width:{(total-no_desc)/total*100:.1f}%;background:var(--ok)"></i>
  <i style="width:{no_desc/total*100:.1f}%;background:var(--miss)"></i>
</div>
<div class="legend">
  <span><i class="dot" style="background:var(--ok)"></i>{total-no_desc} described</span>
  <span><i class="dot" style="background:var(--miss)"></i>{no_desc} undescribed</span>
  <span>·</span>
  <span>{w_ing} ingredients</span><span>{w_net} net weight</span><span>{w_sto} storage temp</span>
</div>

<h2>The pull</h2>
<div class="controls">
  <div class="row1">
    <input type="search" id="q" placeholder="Search name, Chinese name, SKU…" aria-label="Search products">
    <button class="dl" id="dl">Download CSV</button>
  </div>
  <div class="chips" role="group" aria-label="Filters">
    <button class="chip" data-f="all" aria-pressed="true">All</button>
    <button class="chip" data-f="nodesc" aria-pressed="false">No description</button>
    <button class="chip" data-f="offspine" aria-pressed="false">Not in catalogue file</button>
    <button class="chip" data-f="desc" aria-pressed="false">Has copy</button>
    <button class="chip" data-f="sales" aria-pressed="false">Has sales</button>
    <button class="chip" data-f="nosales" aria-pressed="false">No sales</button>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
    <span class="count" id="count"></span><span class="saved" id="saved"></span>
  </div>
</div>

<ul class="list" id="list"></ul>

<h2>Where each field came from</h2>
<div class="scroll"><table class="src">
<thead><tr><th>File</th><th>What it supplies</th></tr></thead>
<tbody>
<tr><td>products_import.json</td><td>Catalogue spine — 259 products: SKU, barcode, category, names, price, stock. Carries no description, ingredients, weight or storage fields at all.</td></tr>
<tr><td>catalog_text_dump.json</td><td>The only long-form copy — 48 rows. Descriptions, ingredients, net weight and storage temp are parsed out of this.</td></tr>
<tr><td>compliance_edits.json</td><td>Chinese descriptions, 46 rows, joined on row id.</td></tr>
<tr><td>gzgrocery_import.json</td><td>Per-SKU quantities, periods to 30 May 2026, plus the variant list that revealed 43 products the catalogue file omits.</td></tr>
<tr><td>miniapp_import.json<br>miniapp_2025_import.json</td><td>Per-line units by product id, Jan 2025 – 29 Apr 2026.</td></tr>
<tr><td>meituan_*.json</td><td><strong>Deliberately unused.</strong> Records orders without line items, so it cannot yield volume per SKU.</td></tr>
</tbody>
</table></div>

<footer>Generated from commit <span style="font-family:var(--mono)">6edac4a</span> on branch
<span style="font-family:var(--mono)">claude/product-data-inventory-q62cyh</span>. Sales window
13 Feb – 13 Aug 2026 as requested; underlying data ends 30 May 2026.</footer>
</div>

<script>
const DATA = {payload};
const rows = DATA.rows, cols = DATA.cols;
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const savedEl = document.getElementById('saved');
let filter = 'all', query = '';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
const units = r => (r.sales_units_gzgrocery || 0) + (r.sales_units_miniapp || 0);
const described = r => (r.full_description_text || '').trim().length > 0;

function matches(r) {{
  if (query) {{
    const hay = (r.sku + ' ' + r.name_en + ' ' + (r.name_cn || '') + ' ' + (r.category || '')).toLowerCase();
    if (!hay.includes(query)) return false;
  }}
  switch (filter) {{
    case 'nodesc':   return !described(r);
    case 'desc':     return described(r);
    case 'offspine': return r.source !== 'products_import.json';
    case 'sales':    return units(r) > 0;
    case 'nosales':  return units(r) === 0;
    default:         return true;
  }}
}}

function field(label, val) {{
  const empty = val === null || val === undefined || String(val).trim() === '';
  return '<dt>' + label + '</dt><dd class="' + (empty ? 'none' : '') + '">' +
         (empty ? 'not in any source' : esc(val)) + '</dd>';
}}

function render() {{
  const shown = rows.filter(matches);
  countEl.textContent = shown.length + ' of ' + rows.length + ' products';
  if (!shown.length) {{ listEl.innerHTML = '<li class="empty">Nothing matches that.</li>'; return; }}
  listEl.innerHTML = shown.map((r, i) => {{
    const u = units(r);
    const tags = [];
    if (!described(r)) tags.push('<span class="tag miss">no description</span>');
    if (r.source !== 'products_import.json') tags.push('<span class="tag part">not in catalogue file</span>');
    if (r.ingredients) tags.push('<span class="tag ok">ingredients</span>');
    if (r.pack_size_net_weight) tags.push('<span class="tag ok">net weight</span>');
    if (r.storage_temp) tags.push('<span class="tag ok">storage</span>');
    if (r.unfilled_placeholders) tags.push('<span class="tag part">unfilled template slot</span>');
    const idx = rows.indexOf(r);
    return '<li class="item" data-i="' + idx + '">' +
      '<button class="head" aria-expanded="false">' +
        '<span><span class="nm">' + esc(r.name_en || '(no name)') + '</span>' +
          (r.name_cn ? ' <span class="cn">' + esc(r.name_cn) + '</span>' : '') +
          '<br><span class="sku">' + esc(r.sku) + (r.category ? ' · ' + esc(r.category) : '') + '</span></span>' +
        '<span style="text-align:right"><span class="price">' +
          (r.retail_price_cny === null ? '—' : '¥' + Number(r.retail_price_cny).toFixed(2)) +
          '</span><br><span class="units">' + (u ? u + ' units' : 'no sales') + '</span></span>' +
        (tags.length ? '<span class="metaline">' + tags.join('') + '</span>' : '') +
      '</button>' +
      '<div class="detail"></div></li>';
  }}).join('');
}}

listEl.addEventListener('click', e => {{
  const btn = e.target.closest('.head'); if (!btn) return;
  const li = btn.parentElement, open = li.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const box = li.querySelector('.detail');
  if (open && !box.dataset.built) {{
    const r = rows[+li.dataset.i];
    box.innerHTML = '<dl>' +
      field('Net weight', r.pack_size_net_weight) +
      field('Storage', r.storage_temp) +
      field('Ingredients', r.ingredients) +
      field('Free of', r.free_of) +
      field('Barcode', r.barcode) +
      field('Stock', r.stock_qty) +
      field('gzgrocery', r.sales_units_gzgrocery + ' units') +
      field('miniapp', r.sales_units_miniapp + ' units') +
      field('Source', r.source) +
      (r.parent_sku ? field('Variant of', r.parent_sku + (r.variant_label ? ' · ' + r.variant_label : '')) : '') +
    '</dl>' + (r.full_description_text.trim()
        ? '<pre class="copy">' + esc(r.full_description_text) + '</pre>'
        : '<pre class="copy" style="color:var(--miss);font-style:italic">No product copy exists for this SKU in any file on the machine.</pre>');
    box.dataset.built = '1';
  }}
}});

document.getElementById('q').addEventListener('input', e => {{ query = e.target.value.trim().toLowerCase(); render(); }});
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {{
  filter = c.dataset.f;
  document.querySelectorAll('.chip').forEach(o => o.setAttribute('aria-pressed', String(o === c)));
  render();
}}));

function toCSV() {{
  const q = v => {{
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }};
  return '\\ufeff' + [cols.join(',')].concat(rows.map(r => cols.map(c => q(r[c])).join(','))).join('\\r\\n');
}}

const dlBtn = document.getElementById('dl');
(async () => {{
  let downloads = null;
  try {{ downloads = await claude.use('downloads'); }} catch (e) {{ downloads = null; }}
  if (!downloads) {{
    dlBtn.disabled = true;
    savedEl.textContent = 'Downloads are unavailable in this view — use the GitHub link instead.';
    return;
  }}
  dlBtn.addEventListener('click', async () => {{
    dlBtn.disabled = true; savedEl.textContent = 'Preparing…';
    const csv = toCSV();
    try {{
      await downloads.save({{ filename: 'roots-product-pull.csv', data: csv }});
      savedEl.textContent = 'Saved.';
    }} catch (err) {{
      if (err && err.code === 'extension_not_enabled') {{
        try {{
          await downloads.save({{ filename: 'roots-product-pull.csv.txt', data: csv }});
          savedEl.textContent = 'Saved as .txt — rename to .csv to open it in a spreadsheet.';
        }} catch (e2) {{
          savedEl.textContent = e2 && e2.code === 'declined' ? 'Save cancelled.' :
            'Could not save (' + ((e2 && e2.code) || 'unknown') + ').';
        }}
      }} else if (err && err.code === 'declined') {{
        savedEl.textContent = 'Save cancelled.';
      }} else if (err && err.code === 'rate_limited') {{
        savedEl.textContent = 'A save prompt is already open — finish that one first.';
      }} else {{
        savedEl.textContent = 'Could not save (' + ((err && err.code) || 'unknown') + ').';
      }}
    }} finally {{ dlBtn.disabled = false; }}
  }});
}})();

render();
</script>
"""

os.makedirs('/home/user/roots-v2/docs/product-data-pull', exist_ok=True)
out = '/home/user/roots-v2/docs/product-data-pull/product-pull.html'
open(out, 'w', encoding='utf-8').write(HTML)
print('wrote', out, os.path.getsize(out), 'bytes')
