# -*- coding: utf-8 -*-
"""Emit standalone HTML for each individual phone wizard screen + a manifest
(slug + short caption). Render each with Chrome headless, trim, embed in the PDF."""
import json, os

OUTDIR = os.path.dirname(os.path.abspath(__file__))

HEAD = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont/dist/tabler-icons.min.css">
<style>
body{margin:0;background:#fff;}
.pw{display:inline-block;padding:16px;--ink:#1d1d1a;--brass:#b08d4a;--tea:#6B8E6F;--oat:#faf7f0;--oat2:#f2efe6;--line:#e3ded2;--mut:#6b6b63;font-family:'IBM Plex Sans',sans-serif;}
.pw *{box-sizing:border-box;}
.fcp{width:230px;background:var(--ink);border-radius:30px;padding:8px;}
.fcs{background:var(--oat);border-radius:23px;overflow:hidden;min-height:452px;display:flex;flex-direction:column;color:var(--ink);}
.fcst{display:flex;justify-content:space-between;align-items:center;padding:8px 15px 0;font-size:11px;color:var(--mut);}
.fch{padding:8px 15px;border-bottom:.5px solid var(--line);}
.fck{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);font-weight:500;}
.fctt{font-size:16px;font-weight:500;margin-top:1px;}
.fcb{flex:1;padding:13px 15px;display:flex;flex-direction:column;gap:10px;}
.fcf{padding:11px 15px;border-top:.5px solid var(--line);display:flex;flex-direction:column;gap:8px;}
.fcbtn{background:var(--tea);color:#fff;text-align:center;padding:10px;border-radius:10px;font-size:13.5px;font-weight:500;}
.fclab{font-size:11px;color:var(--mut);margin-bottom:3px;}
.fcin{background:#fff;border:.5px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;}
.fcopt{display:flex;align-items:center;gap:11px;background:#fff;border:.5px solid var(--line);border-radius:10px;padding:12px;font-size:13.5px;font-weight:500;}
.fcopt i{color:var(--brass);font-size:20px;}
.fcchip{display:inline-flex;align-items:center;gap:4px;background:var(--oat2);border-radius:20px;padding:5px 10px;font-size:11px;color:#5b5b53;}
.fctag{font-size:9.5px;color:var(--tea);border:.5px solid var(--tea);border-radius:10px;padding:1px 6px;font-weight:500;white-space:nowrap;}
.fcdots{display:flex;gap:5px;justify-content:center;}
.fcdot{width:6px;height:6px;border-radius:50%;background:var(--line);}.fcdot.on{background:var(--brass);}
.fctog{display:flex;gap:7px;}
.fctp{flex:1;text-align:center;padding:8px;border-radius:8px;border:.5px solid var(--line);font-size:12.5px;background:#fff;}
.fctp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
.fcph{background:var(--oat2);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#a59d88;}
.fcgap{background:#fff;border:.5px solid var(--line);border-radius:11px;padding:11px;display:flex;flex-direction:column;gap:9px;}
.fcmrow{display:flex;align-items:center;gap:8px;font-size:12px;}
</style></head><body>"""
FOOT = "</body></html>"

def shell(inner):
    return HEAD + '<div class="pw"><div class="fcp"><div class="fcs">' + inner + '</div></div></div>' + FOOT

ST = '<div class="fcst"><span>9:41</span><span><i class="ti ti-wifi"></i></span></div>'
def head(k, t):
    return '<div class="fch"><div class="fck">%s</div><div class="fctt">%s</div></div>' % (k, t)
def dots(active):
    return '<div class="fcdots">' + "".join('<span class="fcdot%s"></span>' % (" on" if i == active else "") for i in range(1, 5)) + '</div>'

SCREENS = []

SCREENS.append(("01_front", "Front door", ST + head("New product", "Add a product") +
    '<div class="fcb">'
    '<div style="font-size:12.5px;color:var(--mut);">How do you want to start?</div>'
    '<div class="fcopt"><i class="ti ti-camera"></i>Snap the label</div>'
    '<div class="fcopt"><i class="ti ti-clipboard-text"></i>Paste a description</div>'
    '<div class="fcopt"><i class="ti ti-copy"></i>Copy a product</div>'
    '<div class="fcopt"><i class="ti ti-pencil"></i>Start from scratch</div></div>'))

SCREENS.append(("02_step1", "Step 1 · What it is", ST + head("Step 1 of 4", "What it is") +
    '<div class="fcb">'
    '<div class="fcph" style="height:84px;"><div style="text-align:center;"><i class="ti ti-photo" style="font-size:24px;"></i><div style="font-size:11px;margin-top:3px;">Add photo</div></div></div>'
    '<div><div class="fclab">Name</div><div class="fcin">Chili crisp <span class="fctag">EN&rarr;CN</span></div></div>'
    '<div><div class="fclab">Section</div><div class="fcin">Sauces &amp; condiments <i class="ti ti-chevron-down"></i></div></div>'
    '<div style="font-size:10.5px;color:var(--mut);">Product code · FC-CHILI-200 <span style="color:var(--brass);">auto</span></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(1) + '</div>'))

SCREENS.append(("03_step2", "Step 2 · Price & stock", ST + head("Step 2 of 4", "Price &amp; stock") +
    '<div class="fcb">'
    '<div><div class="fclab">Comes in sizes / options?</div><div class="fctog"><span class="fctp on">No</span><span class="fctp">Yes</span></div></div>'
    '<div><div class="fclab">Price</div><div class="fcin">¥ 45.00</div></div>'
    '<div><div class="fclab">How many in stock</div><div class="fcin">20</div></div>'
    '<div style="display:flex;gap:6px;flex-wrap:wrap;"><span class="fcchip"><i class="ti ti-check"></i>Ships everywhere</span><span class="fcchip">On sale? No</span></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(2) + '</div>'))

SCREENS.append(("04_step3", "Step 3 · Details", ST + head("Step 3 of 4", "Details") +
    '<div class="fcb">'
    '<div style="background:#fff;border:.5px dashed var(--brass);border-radius:10px;padding:10px;">'
    '<div style="font-size:11px;color:var(--mut);margin-bottom:8px;">Paste anything you know…</div>'
    '<div style="display:inline-flex;align-items:center;gap:5px;background:var(--brass);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;"><i class="ti ti-sparkles"></i>AI fill</div></div>'
    '<div class="fcin">Origin · Guangzhou <span class="fctag">AI</span></div>'
    '<div class="fcin">Storage · Keep cool &amp; dry <span class="fctag">AI</span></div>'
    '<div class="fcin">Shelf life · 6 months <span class="fctag">AI</span></div>'
    '<div style="display:flex;gap:6px;flex-wrap:wrap;"><span class="fcchip"><i class="ti ti-check"></i>Nut-free</span><span class="fcchip"><i class="ti ti-check"></i>Gluten-free</span></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(3) + '</div>'))

SCREENS.append(("05_step4", "Step 4 · Review", ST + head("Step 4 of 4", "Review") +
    '<div class="fcb">'
    '<div style="background:#fff;border:.5px solid var(--line);border-radius:10px;overflow:hidden;">'
    '<div class="fcph" style="height:64px;border-radius:0;"><i class="ti ti-photo" style="font-size:22px;"></i></div>'
    '<div style="padding:8px 11px;"><div style="font-size:13px;font-weight:500;">Chili crisp</div><div style="font-size:11px;color:var(--brass);">¥45 · designed page</div></div></div>'
    '<div style="display:flex;gap:5px;flex-wrap:wrap;"><span class="fcchip"><i class="ti ti-check"></i>Photo</span><span class="fcchip"><i class="ti ti-check"></i>Price</span><span class="fcchip"><i class="ti ti-check"></i>Category</span></div>'
    '<div class="fctog"><span class="fctp on">Designed</span><span class="fctp">Plain</span></div></div>'
    '<div class="fcf"><div class="fcbtn">Put it in the shop</div><div style="text-align:center;font-size:11px;color:var(--mut);">Save as draft</div></div>'))

SCREENS.append(("06_finish", "Finish · missing info", ST + head("Finish your products", "Missing info") +
    '<div class="fcb">'
    '<div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-bottom:5px;"><span>Catalog complete</span><span style="color:var(--tea);font-weight:500;">87%</span></div><div style="height:8px;background:var(--oat2);border-radius:20px;overflow:hidden;"><div style="width:87%;height:100%;background:var(--tea);"></div></div></div>'
    '<div style="font-size:11px;color:var(--mut);">30 products · storage</div>'
    '<div class="fcgap">'
    '<div style="display:flex;align-items:center;gap:9px;"><div class="fcph" style="width:32px;height:32px;"><i class="ti ti-photo" style="font-size:15px;"></i></div><div style="font-size:12.5px;font-weight:500;">Chili crisp</div></div>'
    '<div style="font-size:11px;color:var(--mut);">Storage? <span style="color:var(--ink);">Keep cool &amp; dry</span> <span class="fctag">AI</span></div>'
    '<div style="display:flex;gap:6px;"><span style="flex:1;text-align:center;background:var(--tea);color:#fff;border-radius:8px;padding:6px;font-size:11px;font-weight:500;">Looks good</span><span class="fcchip">Edit</span><span class="fcchip">N/A</span></div></div></div>'
    '<div class="fcf"><div class="fcbtn"><i class="ti ti-sparkles"></i> Approve all 30</div></div>'))

SCREENS.append(("07_import", "Import · map a sheet", ST + head("Import", "Map your sheet") +
    '<div class="fcb">'
    '<div class="fcchip" style="align-self:flex-start;"><i class="ti ti-file-spreadsheet"></i>products.xlsx · 214 rows</div>'
    '<div class="fcmrow"><span class="fcin" style="flex:1;">Column A</span><i class="ti ti-arrow-right" style="color:var(--mut);"></i><span style="font-weight:500;flex:1;">Name</span><i class="ti ti-check" style="color:var(--tea);"></i></div>'
    '<div class="fcmrow"><span class="fcin" style="flex:1;">Column C</span><i class="ti ti-arrow-right" style="color:var(--mut);"></i><span style="font-weight:500;flex:1;">Price</span><i class="ti ti-check" style="color:var(--tea);"></i></div>'
    '<div class="fcmrow"><span class="fcin" style="flex:1;">Column D</span><i class="ti ti-arrow-right" style="color:var(--mut);"></i><span style="flex:1;color:var(--brass);">Ingredients?</span><i class="ti ti-help" style="color:var(--brass);"></i></div>'
    '<div style="font-size:10.5px;color:var(--mut);">Unknown columns parked, never dropped</div></div>'
    '<div class="fcf"><div class="fcbtn">Confirm mapping</div></div>'))

manifest = []
for slug, caption, inner in SCREENS:
    with open(os.path.join(OUTDIR, "_pm_%s.html" % slug), "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})
with open(os.path.join(OUTDIR, "wizard_ph_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("wrote %d phone screens + manifest" % len(SCREENS))
