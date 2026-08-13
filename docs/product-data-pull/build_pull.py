#!/usr/bin/env python3
"""Raw product-data pull from the flat files checked into roots-v2.

No live DB and no API credentials exist on this machine, so every field below is
copied verbatim out of a repo file. Nothing is inferred or filled in. A field that
is absent in the sources stays empty.
"""
import json, re, html, csv, os
from collections import defaultdict
from datetime import date

R = '/home/user/roots-v2'
OUT = os.path.join(R, 'docs', 'product-data-pull')
os.makedirs(OUT, exist_ok=True)

def load(p):
    with open(os.path.join(R, p), encoding='utf-8') as f:
        return json.load(f)

# ── sources ────────────────────────────────────────────────────────────────
catalogue = load('scripts/products_import.json')['products']
textdump  = load('scripts/catalog_text_dump.json')
compliance= load('scripts/compliance_edits.json')
gz        = load('scripts/gzgrocery_import.json')
mini26    = load('scripts/miniapp_import.json')
mini25    = load('scripts/miniapp_2025_import.json')

# ── description parsing (literal extraction only) ──────────────────────────
def to_text(h):
    if not h:
        return ''
    h = re.sub(r'<!--.*?-->', '', h, flags=re.S)
    h = re.sub(r'<br\s*/?>', '\n', h, flags=re.I)
    h = re.sub(r'</(p|div|li|h\d)>', '\n', h, flags=re.I)
    h = re.sub(r'<li[^>]*>', '• ', h, flags=re.I)
    h = re.sub(r'<[^>]+>', '', h)
    t = html.unescape(h).replace('\xa0', ' ')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()

EMOJI = re.compile('[\U0001F300-\U0001FAFF☀-➿️]')

def clean_head(s):
    return EMOJI.sub('', s).strip(' :').upper()

def labelled(text, *labels):
    """Value of a `Label: value` line, verbatim."""
    for ln in text.split('\n'):
        ln = ln.strip()
        for lab in labels:
            m = re.match(rf'^{lab}\s*:\s*(.+)$', ln, flags=re.I)
            if m:
                return EMOJI.sub('', m.group(1)).strip()
    return ''

def is_heading(ln):
    """A section heading in these dumps is a short, all-caps, emoji-tagged line."""
    s = EMOJI.sub('', ln).strip()
    if not s or len(s) > 60:
        return False
    # Headings like "NUTRITION (Per 10g serving)" are caps apart from a
    # parenthetical qualifier, so judge the line with parentheticals removed.
    core = re.sub(r'\([^)]*\)', '', s).strip()
    if not re.search(r'[A-Z]', core):
        return False
    return not re.search(r'[a-z]', core)

def section(text, *heads):
    """Body under a heading, up to the next heading line."""
    want = {h.upper() for h in heads}
    body, grab = [], False
    for ln in text.split('\n'):
        if grab:
            if is_heading(ln):
                break
            if ln.strip():
                body.append(ln.strip())
        elif clean_head(ln) in want and is_heading(ln):
            grab = True
    out = ' '.join(body).strip()
    return EMOJI.sub('', out).strip()

PLACEHOLDER = re.compile(r'\[\s*fill\s*\]|\bTBD\b|\bXXX\b', re.I)

def real(v):
    """Drop authoring placeholders — an unfilled template slot is not data."""
    v = (v or '').strip()
    return '' if (not v or PLACEHOLDER.search(v)) else v

text_by_sku, desc_by_sku = {}, {}
for row in textdump:
    t = to_text(row.get('description_en'))
    if row.get('sku'):
        text_by_sku.setdefault(row['sku'], t)
cn_by_id = {c['id']: to_text(c.get('description_cn')) for c in compliance}
cn_by_sku = {}
for row in textdump:
    if row.get('sku') and row['id'] in cn_by_id:
        cn_by_sku.setdefault(row['sku'], cn_by_id[row['id']])

# ── sales, per SKU ─────────────────────────────────────────────────────────
# Requested window: the 6 months ending today.
TODAY = date(2026, 8, 13)
WIN_FROM, WIN_TO = date(2026, 2, 13), TODAY

alias = gz['sku_aliases']            # source sku -> catalogue sku
ext_to_sku = {p['external_id']: p['sku'] for p in catalogue if p.get('sku')}

gz_units = defaultdict(float)
gz_dates = []
for per in gz['periods']:
    mid = date.fromisoformat(per['midpoint'])
    gz_dates.append(mid)
    if not (WIN_FROM <= mid <= WIN_TO):
        continue
    for s in per['sales']:
        gz_units[alias.get(s['sku'], s['sku'])] += float(s.get('qty') or 0)

mini_units = defaultdict(float)
mini_dates = []
for src in (mini25, mini26):
    by_order = src['lines_by_order']
    for o in src['orders']:
        od = o.get('order_date')
        if not od:
            continue
        d = date.fromisoformat(od[:10])
        mini_dates.append(d)
        if not (WIN_FROM <= d <= WIN_TO):
            continue
        for ln in by_order.get(str(o.get('source_order_id')), []) or by_order.get(o.get('order_no'), []) or []:
            sku = ext_to_sku.get(ln.get('product_external_id'))
            if sku:
                mini_units[sku] += float(ln.get('units') or 0)

# ── assemble ───────────────────────────────────────────────────────────────
rows = []
for p in catalogue:
    sku = p.get('sku') or ''
    t   = text_by_sku.get(sku, '')
    ing = real(section(t, 'INGREDIENTS')) or real(labelled(t, 'Ingredients'))
    net = real(labelled(t, 'Net weight', 'Net volume', 'Net content', 'Net Content')) \
          or real(section(t, 'NET CONTENT & PACKAGING'))
    sto = real(labelled(t, 'Storage')) or real(section(t, 'STORAGE', 'STORAGE & SHELF LIFE'))
    desc = real(section(t, 'PRODUCT DESCRIPTION'))
    placeholders = sorted(set(m.group(0).lower() for m in PLACEHOLDER.finditer(t)))
    rows.append({
        'sku': sku,
        'barcode': p.get('barcode') or '',
        'category': p.get('category') or '',
        'name_en': p.get('name_en') or '',
        'name_cn': p.get('name_cn') or '',
        'retail_price_cny': p.get('sell_price'),
        'description_en': desc,
        'description_cn': cn_by_sku.get(sku, ''),
        'ingredients': ing,
        'pack_size_net_weight': net,
        'storage_temp': sto,
        'free_of': p.get('free_of') or '',
        'tags': p.get('tags') or '',
        'stock_qty': p.get('stock_qty'),
        'sales_units_gzgrocery': round(gz_units.get(sku, 0), 2),
        'sales_units_miniapp': round(mini_units.get(sku, 0), 2),
        'full_description_text': t,
        'external_id': p.get('external_id'),
        'unfilled_placeholders': ', '.join(placeholders),
    })

# ── gap flags ──────────────────────────────────────────────────────────────
def flag(r):
    f = []
    if not r['full_description_text'].strip():
        f.append('NO DESCRIPTION')
    elif len(r['description_en'].split()) < 12 and len(r['full_description_text'].split()) < 40:
        f.append('DESCRIPTION TOO THIN')
    if not r['ingredients']:
        f.append('no ingredients')
    if not r['pack_size_net_weight']:
        f.append('no pack size')
    if not r['storage_temp']:
        f.append('no storage temp')
    if r['unfilled_placeholders']:
        f.append(f"unfilled template slot ({r['unfilled_placeholders']})")
    return '; '.join(f)

for r in rows:
    r['gaps'] = flag(r)

cols = ['sku','barcode','category','name_en','name_cn','retail_price_cny','pack_size_net_weight',
        'storage_temp','ingredients','description_en','description_cn','free_of','tags','stock_qty',
        'sales_units_gzgrocery','sales_units_miniapp','gaps','unfilled_placeholders',
        'external_id','full_description_text']
with open(os.path.join(OUT, 'product-pull-raw.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    for r in rows:
        w.writerow({c: r[c] for c in cols})

json.dump(rows, open(os.path.join(OUT, 'product-pull-raw.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

# ── console table ──────────────────────────────────────────────────────────
def cut(s, n):
    s = (s or '').replace('\n', ' ').strip()
    return s if len(s) <= n else s[:n-1] + '…'

lines = []
hdr = ['SKU','Name (EN)','Name (CN)','¥','Net wt','Storage','Ingredients','Desc','6mo units']
lines.append('| ' + ' | '.join(hdr) + ' |')
lines.append('|' + '|'.join(['---'] * len(hdr)) + '|')
for r in sorted(rows, key=lambda x: (x['category'] or '', x['sku'])):
    words = len(r['full_description_text'].split())
    dcell = '—' if words == 0 else (f'{words}w' if words >= 40 else f'{words}w THIN')
    units = r['sales_units_gzgrocery'] + r['sales_units_miniapp']
    lines.append('| ' + ' | '.join([
        r['sku'] or '—',
        cut(r['name_en'], 42),
        cut(r['name_cn'], 18) or '—',
        f"{r['retail_price_cny']:g}" if r['retail_price_cny'] is not None else '—',
        cut(r['pack_size_net_weight'], 16) or '—',
        cut(r['storage_temp'], 22) or '—',
        cut(r['ingredients'], 30) or '—',
        dcell,
        f'{units:g}' if units else '0',
    ]) + ' |')
open(os.path.join(OUT, 'product-pull-table.md'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('\n'.join(lines))

# ── summary to stderr-ish tail ─────────────────────────────────────────────
import sys
n = len(rows)
no_desc = [r for r in rows if 'NO DESCRIPTION' in r['gaps']]
thin    = [r for r in rows if 'DESCRIPTION TOO THIN' in r['gaps']]
print(f"\nROWS {n} | no description {len(no_desc)} | thin {len(thin)} | "
      f"with ingredients {sum(1 for r in rows if r['ingredients'])} | "
      f"with net weight {sum(1 for r in rows if r['pack_size_net_weight'])} | "
      f"with storage temp {sum(1 for r in rows if r['storage_temp'])} | "
      f"with sales in window {sum(1 for r in rows if r['sales_units_gzgrocery']+r['sales_units_miniapp'])}")
print(f"gzgrocery period midpoints: {min(gz_dates)} → {max(gz_dates)}")
print(f"miniapp order dates:        {min(mini_dates)} → {max(mini_dates)}")
