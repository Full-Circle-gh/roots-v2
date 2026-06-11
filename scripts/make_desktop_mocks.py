# -*- coding: utf-8 -*-
"""Emit standalone HTML files for the desktop (PC) wizard screens, plus a manifest
(slug + caption) the PDF generator reads. Render each with Chrome headless."""
import json, os

OUTDIR = os.path.dirname(os.path.abspath(__file__))

HEAD = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont/dist/tabler-icons.min.css">
<style>
body{margin:0;background:#fff;}
.dw{width:1020px;--ink:#1d1d1a;--brass:#b08d4a;--tea:#6B8E6F;--oat:#faf7f0;--oat2:#f2efe6;--line:#e3ded2;--mut:#6b6b63;padding:18px;font-family:'IBM Plex Sans',sans-serif;}
.dw *{box-sizing:border-box;}
.dwin{background:#fff;border:.5px solid var(--line);border-radius:14px;overflow:hidden;}
.dtop{background:var(--ink);color:#fff;display:flex;align-items:center;gap:12px;padding:11px 18px;font-size:13px;}
.dtop .wm{font-weight:500;}.dtop .bc{color:#b6b3a6;font-size:12px;}
.dpage{background:var(--oat2);padding:24px;}
.dmod{background:#fff;border:.5px solid var(--line);border-radius:12px;overflow:hidden;margin:0 auto;}
.dmh{display:flex;justify-content:space-between;align-items:center;padding:15px 22px;border-bottom:.5px solid var(--line);}
.dmh .t{font-size:17px;font-weight:500;}.dmh .k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);}
.dgrid{display:grid;}
.drail{border-right:.5px solid var(--line);padding:20px 18px;display:flex;flex-direction:column;gap:15px;background:var(--oat);}
.dstep{display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--mut);}
.dnum{width:23px;height:23px;border-radius:50%;border:.5px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:12px;background:#fff;flex:0 0 auto;}
.dstep.on{color:var(--ink);font-weight:500;}.dstep.on .dnum{background:var(--tea);color:#fff;border-color:var(--tea);}
.dstep.done .dnum{background:var(--brass);color:#fff;border-color:var(--brass);}
.dform{padding:22px;display:flex;flex-direction:column;gap:15px;}
.dlab{font-size:12px;color:var(--mut);margin-bottom:5px;}
.din{background:#fff;border:.5px solid var(--line);border-radius:7px;padding:9px 11px;font-size:13.5px;display:flex;justify-content:space-between;align-items:center;}
.dph{background:var(--oat2);border:.5px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#a59d88;}
.dtag{font-size:10.5px;color:var(--tea);border:.5px solid var(--tea);border-radius:10px;padding:1px 7px;white-space:nowrap;}
.dprev{border-left:.5px solid var(--line);padding:20px 16px;background:var(--oat);}
.dprevl{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin-bottom:11px;}
.dcard{background:#fff;border:.5px solid var(--line);border-radius:10px;overflow:hidden;}
.dcardimg{background:var(--oat2);height:90px;display:flex;align-items:center;justify-content:center;color:#a59d88;}
.dmf{display:flex;justify-content:space-between;align-items:center;padding:15px 22px;border-top:.5px solid var(--line);}
.dbtn{background:var(--tea);color:#fff;border-radius:8px;padding:9px 20px;font-size:13.5px;font-weight:500;}
.dghost{border:.5px solid var(--line);border-radius:8px;padding:9px 18px;font-size:13.5px;color:var(--mut);background:#fff;}
.ddots{display:flex;gap:5px;}.ddot{width:7px;height:7px;border-radius:50%;background:var(--line);}.ddot.on{background:var(--brass);}
.docard{display:flex;align-items:center;gap:13px;border:.5px solid var(--line);border-radius:10px;padding:15px;background:#fff;}
.docard i{color:var(--brass);font-size:24px;}
.doct{font-size:14px;font-weight:500;}.docs{font-size:11.5px;color:var(--mut);margin-top:2px;}
.dtog{display:flex;gap:8px;}.dtp{padding:7px 18px;border-radius:7px;border:.5px solid var(--line);font-size:13px;background:#fff;}
.dtp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
.dchip{display:inline-flex;align-items:center;gap:5px;background:var(--oat2);border-radius:20px;padding:5px 11px;font-size:12px;color:#5b5b53;}
table.dt{width:100%;border-collapse:collapse;font-size:13px;}
table.dt th{text-align:left;font-weight:500;color:var(--mut);font-size:11.5px;padding:7px 10px;border-bottom:.5px solid var(--line);}
table.dt td{padding:9px 10px;border-bottom:.5px solid var(--line);}
.dmeter{height:8px;background:var(--oat2);border-radius:20px;overflow:hidden;}.dmeter > div{height:100%;background:var(--tea);}
.dpanel{background:#fff;border:.5px solid var(--line);border-radius:12px;padding:20px 22px;margin:0 auto;}
</style></head><body>"""

FOOT = "</body></html>"

def shell(inner):
    top = ('<div class="dtop"><span class="wm">Full Circle</span>'
           '<span class="bc">Mini App Backend · Products · Add a product</span></div>')
    return (HEAD + '<div class="dw"><div class="dwin">' + top +
            '<div class="dpage">' + inner + '</div></div></div>' + FOOT)

def rail(active, done):
    names = ["What it is", "Price & stock", "Details", "Review"]
    out = []
    for i, n in enumerate(names, 1):
        cls = "dstep" + (" on" if i == active else "") + (" done" if i in done else "")
        out.append('<div class="%s"><span class="dnum">%s</span>%s</div>'
                   % (cls, ('✓' if i in done else str(i)), n))
    return '<div class="drail">' + "".join(out) + '</div>'

def modal(title, active, done, form, preview, footer, cols="180px 1fr 220px", maxw=760):
    head = ('<div class="dmh"><div><div class="k">New product</div><div class="t">%s</div></div>'
            '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>' % title)
    body = ('<div class="dgrid" style="grid-template-columns:%s;">%s<div class="dform">%s</div>%s</div>'
            % (cols, rail(active, done), form,
               ('<div class="dprev"><div class="dprevl">Live preview</div>%s</div>' % preview) if preview else ""))
    return ('<div class="dmod" style="max-width:%spx;">%s%s%s</div>'
            % (maxw, head, body, '<div class="dmf">%s</div>' % footer))

def dots(active):
    return '<div class="ddots">' + "".join(
        '<span class="ddot%s"></span>' % (" on" if i == active else "") for i in range(1, 5)) + '</div>'

def foot(active, primary="Next"):
    return ('<div style="display:flex;align-items:center;gap:14px;"><span class="dghost">Back</span>%s</div>'
            '<div style="display:flex;align-items:center;gap:12px;">'
            '<span style="font-size:12px;color:var(--mut);">Open full editor</span>'
            '<span class="dbtn">%s</span></div>' % (dots(active), primary))

PREV_CARD = ('<div class="dcard"><div class="dcardimg"><i class="ti ti-photo" style="font-size:22px;"></i></div>'
             '<div style="padding:10px 12px;"><div style="font-size:14px;font-weight:500;">Chili crisp</div>'
             '<div style="font-size:13px;color:var(--brass);margin-top:3px;">¥45</div></div></div>')

SCREENS = []

# 01 — front door
fd_cards = "".join([
    '<div class="docard"><i class="ti ti-camera"></i><div><div class="doct">Snap the label</div><div class="docs">AI reads name, facts, weight</div></div></div>',
    '<div class="docard"><i class="ti ti-clipboard-text"></i><div><div class="doct">Paste a description</div><div class="docs">AI splits it into fields</div></div></div>',
    '<div class="docard"><i class="ti ti-copy"></i><div><div class="doct">Copy a product</div><div class="docs">Reuse one you already sell</div></div></div>',
    '<div class="docard"><i class="ti ti-pencil"></i><div><div class="doct">Start from scratch</div><div class="docs">A blank form</div></div></div>',
])
fd = ('<div class="dmod" style="max-width:720px;">'
      '<div class="dmh"><div><div class="k">New product</div><div class="t">Add a product</div></div>'
      '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>'
      '<div style="padding:24px;"><div style="font-size:14px;color:var(--mut);margin-bottom:16px;">How do you want to start?</div>'
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' + fd_cards + '</div></div></div>')
SCREENS.append(("01_front", "Front door — meet people where their product already lives.", fd))

# 02 — step 1
s1_form = (
    '<div class="dph" style="height:96px;"><div style="text-align:center;"><i class="ti ti-photo" style="font-size:26px;"></i><div style="font-size:12px;margin-top:4px;">Drop photos, or snap the label</div></div></div>'
    '<div><div class="dlab">Name</div><div class="din">Chili crisp <span class="dtag">EN &rarr; CN auto</span></div></div>'
    '<div style="display:flex;gap:14px;"><div style="flex:1;"><div class="dlab">Section</div><div class="din">Sauces &amp; condiments <i class="ti ti-chevron-down"></i></div></div>'
    '<div style="flex:1;"><div class="dlab">Price</div><div class="din">¥ 45.00</div></div></div>'
    '<div style="font-size:11px;color:var(--mut);">Product code · FC-CHILI-200 <span style="color:var(--brass);">auto — edit if you have your own</span></div>')
s1_prev = PREV_CARD + '<div style="font-size:11px;color:var(--mut);margin-top:12px;line-height:1.5;">The shop card builds as you type.</div>'
SCREENS.append(("02_step1", "Step 1 — What it is. Pre-filled if they snapped or pasted; just confirm.",
                modal("What it is", 1, set(), s1_form, s1_prev, foot(1))))

# 03 — step 2 (sizes fork = yes -> per-option table)
s2_form = (
    '<div><div class="dlab">Comes in sizes / options?</div><div class="dtog"><span class="dtp">No</span><span class="dtp on">Yes</span></div></div>'
    '<table class="dt"><tr><th>Option</th><th>Price</th><th>In stock</th><th>Code</th></tr>'
    '<tr><td>200 g</td><td>¥45</td><td>20</td><td style="color:var(--mut);">FC-CHILI-200</td></tr>'
    '<tr><td>500 g</td><td>¥99</td><td>12</td><td style="color:var(--mut);">FC-CHILI-500</td></tr></table>'
    '<div style="display:flex;gap:14px;font-size:12.5px;"><span style="color:var(--tea);">+ Add another size</span><span style="color:var(--mut);">All the same price?</span></div>'
    '<div style="display:flex;gap:8px;"><span class="dchip"><i class="ti ti-check"></i>Ships everywhere</span><span class="dchip">On sale? No</span></div>')
s2_prev = ('<div class="dcard"><div class="dcardimg"><i class="ti ti-photo" style="font-size:22px;"></i></div>'
           '<div style="padding:10px 12px;"><div style="font-size:14px;font-weight:500;">Chili crisp</div>'
           '<div style="font-size:12px;color:var(--mut);margin-top:5px;display:flex;gap:6px;"><span class="dchip" style="padding:3px 9px;">200 g</span><span class="dchip" style="padding:3px 9px;">500 g</span></div></div></div>'
           '<div style="font-size:11px;color:var(--mut);margin-top:12px;line-height:1.5;">Stock is per size — asked here, not twice.</div>')
SCREENS.append(("03_step2", "Step 2 — the one real fork. “Yes” moves price &amp; stock per option.",
                modal("Price & stock", 2, {1}, s2_form, s2_prev, foot(2))))

# 04 — step 3 details
s3_form = (
    '<div style="background:#fff;border:.5px dashed var(--brass);border-radius:9px;padding:12px;display:flex;justify-content:space-between;align-items:center;">'
    '<div style="font-size:12px;color:var(--mut);">Paste anything you know, or snap the label…</div>'
    '<div style="display:inline-flex;align-items:center;gap:6px;background:var(--brass);color:#fff;border-radius:7px;padding:7px 12px;font-size:12.5px;font-weight:500;"><i class="ti ti-sparkles"></i>AI fill</div></div>'
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    '<div><div class="dlab">Origin</div><div class="din">Guangzhou <span class="dtag">AI</span></div></div>'
    '<div><div class="dlab">Weight</div><div class="din">200 g <span class="dtag">AI</span></div></div>'
    '<div style="grid-column:1/3;"><div class="dlab">Ingredients</div><div class="din">Chili, rapeseed oil, garlic, soy… <span class="dtag">AI</span></div></div>'
    '<div><div class="dlab">Storage</div><div class="din">Keep cool &amp; dry <span class="dtag">AI</span></div></div>'
    '<div><div class="dlab">Shelf life</div><div class="din">6 months <span class="dtag">AI</span></div></div></div>'
    '<div><div class="dlab">Free of (confirm what you guarantee)</div><div style="display:flex;gap:8px;"><span class="dchip"><i class="ti ti-check"></i>Nut-free</span><span class="dchip"><i class="ti ti-check"></i>Gluten-free</span></div></div>')
s3_prev = ('<div class="dcard"><div class="dcardimg" style="height:64px;"><i class="ti ti-photo" style="font-size:20px;"></i></div>'
           '<div style="padding:11px;"><div style="font-size:13px;font-weight:500;">Chili crisp</div>'
           '<div style="height:6px;background:var(--oat2);border-radius:4px;margin:9px 0;"></div>'
           '<div style="height:6px;width:70%;background:var(--oat2);border-radius:4px;"></div>'
           '<div style="font-size:10px;color:var(--brass);margin-top:10px;">Designed page · facts built in</div></div></div>')
SCREENS.append(("04_step3", "Step 3 — Details. One paste fills the facts; you glance and confirm.",
                modal("Details", 3, {1, 2}, s3_form, s3_prev, foot(3))))

# 05 — step 4 review
s4_form = (
    '<div class="dcard"><div class="dcardimg"><i class="ti ti-photo" style="font-size:24px;"></i></div>'
    '<div style="padding:14px 16px;"><div style="font-size:15px;font-weight:500;">Chili crisp</div>'
    '<div style="font-size:13px;color:var(--brass);margin:4px 0 10px;">¥45 · 200 g / 500 g</div>'
    '<div style="height:6px;background:var(--oat2);border-radius:4px;margin-bottom:7px;"></div>'
    '<div style="height:6px;width:80%;background:var(--oat2);border-radius:4px;"></div></div></div>'
    '<div style="display:flex;gap:8px;"><span class="dchip"><i class="ti ti-check"></i>Photo</span><span class="dchip"><i class="ti ti-check"></i>Price</span><span class="dchip"><i class="ti ti-check"></i>Category</span><span style="font-size:12px;color:var(--tea);align-self:center;">ready</span></div>'
    '<div><div class="dlab">Page look</div><div class="dtog"><span class="dtp on">Designed</span><span class="dtp">Plain</span></div></div>')
s4_foot = ('<div><span class="dghost">Back</span></div>'
           '<div style="display:flex;align-items:center;gap:12px;"><span style="font-size:12px;color:var(--mut);">Save as draft</span>'
           '<span class="dbtn">Put it in the shop</span></div>')
SCREENS.append(("05_step4", "Step 4 — Review &amp; publish. Designed page is the default; draft-first.",
                modal("Review", 4, {1, 2, 3}, s4_form, None, s4_foot, cols="180px 1fr")))

# 06 — Finish your products (full)
fin_rows = "".join([
    '<tr><td>Chili crisp</td><td>Keep cool &amp; dry <span class="dtag">AI</span></td><td style="text-align:right;"><span class="dbtn" style="padding:5px 12px;font-size:12px;">Looks good</span> <span class="dchip">Edit</span> <span class="dchip">N/A</span></td></tr>',
    '<tr><td>Black vinegar</td><td>Store at room temp <span class="dtag">AI</span></td><td style="text-align:right;"><span class="dbtn" style="padding:5px 12px;font-size:12px;">Looks good</span> <span class="dchip">Edit</span> <span class="dchip">N/A</span></td></tr>',
    '<tr><td>Sesame paste</td><td>Refrigerate after opening <span class="dtag">AI</span></td><td style="text-align:right;"><span class="dbtn" style="padding:5px 12px;font-size:12px;">Looks good</span> <span class="dchip">Edit</span> <span class="dchip">N/A</span></td></tr>',
])
fin = ('<div class="dpanel" style="max-width:880px;">'
       '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px;">'
       '<div><div class="dmh-k" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);">Finish your products</div>'
       '<div style="font-size:17px;font-weight:500;">Missing info</div></div>'
       '<div style="font-size:13px;color:var(--tea);">Catalog 87% complete</div></div>'
       '<div class="dmeter" style="margin-bottom:18px;"><div style="width:87%;"></div></div>'
       '<div style="font-size:13px;color:var(--mut);margin-bottom:8px;">Storage · 30 products missing — AI suggested, approve to apply</div>'
       '<table class="dt"><tr><th>Product</th><th>AI suggestion</th><th></th></tr>' + fin_rows + '</table>'
       '<div style="display:flex;justify-content:flex-end;margin-top:16px;"><span class="dbtn"><i class="ti ti-sparkles"></i> Approve all 30</span></div></div>')
SCREENS.append(("06_finish", "Finish — a gap queue batched by field. Approve the AI, don’t type.", fin))

# 07 — Import (full)
imp_rows = "".join([
    '<tr><td>Column A</td><td style="color:var(--mut);">Chili crisp</td><td style="text-align:center;color:var(--mut);"><i class="ti ti-arrow-right"></i></td><td style="font-weight:500;">Name</td><td style="color:var(--tea);"><i class="ti ti-check"></i> matched</td></tr>',
    '<tr><td>Column C</td><td style="color:var(--mut);">45</td><td style="text-align:center;color:var(--mut);"><i class="ti ti-arrow-right"></i></td><td style="font-weight:500;">Price</td><td style="color:var(--tea);"><i class="ti ti-check"></i> matched</td></tr>',
    '<tr><td>Column D</td><td style="color:var(--mut);">chili, oil, garlic…</td><td style="text-align:center;color:var(--mut);"><i class="ti ti-arrow-right"></i></td><td style="font-weight:500;">Ingredients</td><td style="color:var(--tea);"><i class="ti ti-check"></i> matched</td></tr>',
    '<tr><td>Column B</td><td style="color:var(--mut);">label.jpg</td><td style="text-align:center;color:var(--mut);"><i class="ti ti-arrow-right"></i></td><td style="font-weight:500;">Photo</td><td style="color:var(--brass);">match by filename</td></tr>',
    '<tr><td>Column E</td><td style="color:var(--mut);">supplier note</td><td style="text-align:center;color:var(--mut);"><i class="ti ti-arrow-right"></i></td><td style="color:var(--mut);">— parked —</td><td style="color:var(--mut);">kept, not dropped</td></tr>',
])
imp = ('<div class="dpanel" style="max-width:880px;">'
       '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
       '<div><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);">Import</div>'
       '<div style="font-size:17px;font-weight:500;">Map your sheet</div></div>'
       '<span class="dchip"><i class="ti ti-file-spreadsheet"></i> products.xlsx · 214 rows</span></div>'
       '<div style="font-size:13px;color:var(--mut);margin-bottom:8px;">AI matched your columns — confirm once, then it imports as drafts.</div>'
       '<table class="dt"><tr><th>Your column</th><th>Sample</th><th></th><th>Our field</th><th>Status</th></tr>' + imp_rows + '</table>'
       '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">'
       '<span style="font-size:12px;color:var(--mut);">Dedupe by code · undo any import</span><span class="dbtn">Confirm mapping</span></div></div>')
SCREENS.append(("07_import", "Import — AI maps any sheet to our fields; confirm once, lands as drafts.", imp))

manifest = []
for slug, caption, inner in SCREENS:
    path = os.path.join(OUTDIR, "_dm_%s.html" % slug)
    with open(path, "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})

with open(os.path.join(OUTDIR, "wizard_pc_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print("wrote %d desktop screens + manifest" % len(SCREENS))
for m in manifest:
    print(" ", m["slug"])
