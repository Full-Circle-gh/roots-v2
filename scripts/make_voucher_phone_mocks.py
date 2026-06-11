# -*- coding: utf-8 -*-
"""Emit standalone HTML for each individual phone VOUCHER-wizard screen + a manifest
(slug + short caption). Render each with Chrome headless, trim, embed in the PDF.
Full Circle backend palette (Ink/Brass/Tea, IBM Plex). Simple, non-native-friendly copy."""
import json, os

OUTDIR = os.path.dirname(os.path.abspath(__file__))

HEAD = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont/dist/tabler-icons.min.css">
<style>
body{margin:0;background:#fff;}
.pw{display:inline-block;padding:16px;--ink:#1d1d1a;--brass:#b08d4a;--tea:#6B8E6F;--oat:#faf7f0;--oat2:#f2efe6;--line:#e3ded2;--mut:#6b6b63;--red:#b2564b;font-family:'IBM Plex Sans',sans-serif;}
.pw *{box-sizing:border-box;}
.fcp{width:236px;background:var(--ink);border-radius:30px;padding:8px;}
.fcs{background:var(--oat);border-radius:23px;overflow:hidden;min-height:452px;display:flex;flex-direction:column;color:var(--ink);}
.fcst{display:flex;justify-content:space-between;align-items:center;padding:8px 15px 0;font-size:11px;color:var(--mut);}
.fch{padding:8px 15px;border-bottom:.5px solid var(--line);}
.fck{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);font-weight:500;}
.fctt{font-size:16px;font-weight:500;margin-top:1px;}
.fcb{flex:1;padding:13px 15px;display:flex;flex-direction:column;gap:10px;}
.fcf{padding:11px 15px;border-top:.5px solid var(--line);display:flex;flex-direction:column;gap:8px;}
.fcbtn{background:var(--tea);color:#fff;text-align:center;padding:10px;border-radius:10px;font-size:13.5px;font-weight:500;}
.fcbtno{background:#fff;border:.5px solid var(--brass);color:var(--brass);text-align:center;padding:9px;border-radius:10px;font-size:13px;font-weight:500;}
.fclab{font-size:11px;color:var(--mut);margin-bottom:3px;}
.fcin{background:#fff;border:.5px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;}
.fcopt{display:flex;align-items:center;gap:11px;background:#fff;border:.5px solid var(--line);border-radius:10px;padding:12px;font-size:13.5px;font-weight:500;}
.fcopt i{color:var(--brass);font-size:20px;}
.fcchip{display:inline-flex;align-items:center;gap:4px;background:var(--oat2);border-radius:20px;padding:5px 10px;font-size:11px;color:#5b5b53;}
.fcchip.ok{color:var(--tea);}
.fctag{font-size:9.5px;color:var(--tea);border:.5px solid var(--tea);border-radius:10px;padding:1px 6px;font-weight:500;white-space:nowrap;}
.fctag.b{color:var(--brass);border-color:var(--brass);}
.fcdots{display:flex;gap:5px;justify-content:center;}
.fcdot{width:6px;height:6px;border-radius:50%;background:var(--line);}.fcdot.on{background:var(--brass);}
.fctog{display:flex;gap:7px;}
.fctp{flex:1;text-align:center;padding:8px;border-radius:8px;border:.5px solid var(--line);font-size:12.5px;background:#fff;}
.fctp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
.daibox{background:#fff;border:.5px dashed var(--brass);border-radius:10px;padding:10px;}
.daifill{display:inline-flex;align-items:center;gap:5px;background:var(--brass);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;}
/* voucher-specific */
.fctype{flex:1;text-align:center;border:.5px solid var(--line);border-radius:9px;padding:9px 4px;background:#fff;}
.fctype.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.fctype i{font-size:18px;color:var(--brass);}.fctype.on i{color:var(--tea);}
.fctype .tt{font-size:10.5px;font-weight:500;margin-top:3px;}
.fcpath{display:flex;align-items:flex-start;gap:9px;border:.5px solid var(--line);border-radius:10px;padding:10px;background:#fff;}
.fcpath.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.fcpath i{color:var(--brass);font-size:18px;margin-top:1px;}.fcpath.on i{color:var(--tea);}
.fcpath .pt{font-size:12px;font-weight:500;}.fcpath .ps{font-size:10px;color:var(--mut);margin-top:1px;line-height:1.35;}
.fctk{position:relative;background:#fff;border:.5px solid var(--line);border-left:4px solid var(--brass);border-radius:9px;padding:11px 13px;}
.fctk-big{font-size:21px;font-weight:600;line-height:1;}.fctk-big span{font-size:11px;font-weight:500;color:var(--mut);}
.fctk-sub{font-size:10px;color:var(--mut);margin-top:2px;}
.fctk-ttl{font-size:11.5px;font-weight:500;margin-top:7px;}
.fctk-exp{font-size:9.5px;color:var(--mut);margin-top:2px;}
.fcnote{display:flex;gap:7px;align-items:flex-start;background:#fff;border:.5px solid var(--line);border-left:3px solid var(--tea);border-radius:8px;padding:8px 10px;font-size:10.5px;line-height:1.4;}
.fcnote i{font-size:14px;margin-top:1px;flex:0 0 auto;}
.fcnote.tea{border-left-color:var(--tea);}.fcnote.tea i{color:var(--tea);}
.fcnote.brass{border-left-color:var(--brass);}.fcnote.brass i{color:var(--brass);}
.fcnote.red{border-left-color:var(--red);}.fcnote.red i{color:var(--red);}
.fcnote b{font-weight:600;}
.fcidea{border:.5px solid var(--line);border-radius:10px;padding:11px;background:#fff;}
.fcidea .why{font-size:9.5px;color:var(--brass);font-weight:500;}
.fcidea .what{font-size:12.5px;font-weight:500;margin:2px 0 8px;}
</style></head><body>"""
FOOT = "</body></html>"

def shell(inner):
    return HEAD + '<div class="pw"><div class="fcp"><div class="fcs">' + inner + '</div></div></div>' + FOOT

ST = '<div class="fcst"><span>9:41</span><span><i class="ti ti-wifi"></i></span></div>'
def head(k, t):
    return '<div class="fch"><div class="fck">%s</div><div class="fctt">%s</div></div>' % (k, t)
def dots(active):
    return '<div class="fcdots">' + "".join('<span class="fcdot%s"></span>' % (" on" if i == active else "") for i in range(1, 5)) + '</div>'
def ticket(big, unit, sub, ttl, exp):
    return ('<div class="fctk"><div class="fctk-big">%s <span>%s</span></div><div class="fctk-sub">%s</div>'
            '<div class="fctk-ttl">%s</div><div class="fctk-exp">%s</div></div>') % (big, unit, sub, ttl, exp)

SCREENS = []

# 01 front door
SCREENS.append(("01_front", "Front door", ST + head("New coupon", "Make a coupon") +
    '<div class="fcb">'
    '<div style="font-size:12px;color:var(--mut);">What do you want to do?</div>'
    '<div class="fcopt"><i class="ti ti-gift"></i>Welcome gift</div>'
    '<div class="fcopt"><i class="ti ti-discount-2"></i>Store sale</div>'
    '<div class="fcopt"><i class="ti ti-ticket"></i>A coupon anyone can use</div>'
    '<div class="fcopt"><i class="ti ti-truck-delivery"></i>Free shipping</div>'
    '<div class="daibox"><div style="font-size:10.5px;color:var(--mut);margin-bottom:7px;">Or tell me your deal in words&hellip;</div>'
    '<div class="daifill"><i class="ti ti-sparkles"></i>Fill it for me</div></div></div>'))

# 02 ideas
SCREENS.append(("02_ideas", "Ideas from sales", ST + head("Ideas from your sales", "Made from your numbers") +
    '<div class="fcb">'
    '<div class="fcidea"><div class="why">Most orders are about &yen;120</div><div class="what">&yen;20 off when you spend &yen;150</div><div class="fcbtn" style="padding:7px;">Use this</div></div>'
    '<div class="fcidea"><div class="why">Many buy once, never return</div><div class="what">&yen;15 off for past customers</div><div class="fcbtno" style="padding:7px;">Use this</div></div>'
    '<div class="fcidea"><div class="why">Carts stop near &yen;90</div><div class="what">Free shipping over &yen;100</div><div class="fcbtno" style="padding:7px;">Use this</div></div>'
    '<div style="font-size:9.5px;color:var(--mut);">Real numbers only. New shop &rarr; plain goals instead.</div></div>'))

# 03 describe -> fills
SCREENS.append(("03_describe", "Describe it", ST + head("Describe it", "You write, I fill") +
    '<div class="fcb">'
    '<div class="daibox"><div style="font-size:11px;line-height:1.45;">&ldquo;20 yuan off for new customers, first order, spend 100&rdquo;</div>'
    '<div style="display:flex;justify-content:flex-end;margin-top:8px;"><div class="daifill"><i class="ti ti-sparkles"></i>Fill it</div></div></div>'
    '<div class="fcin">Save &middot; <b>&yen;20 off</b> <span class="fctag">filled</span></div>'
    '<div class="fcin">Who &middot; <b>New customers</b> <span class="fctag">filled</span></div>'
    '<div class="fcin">Code &middot; <b>WELCOME20</b> <span class="fctag b">made</span></div>'
    '<div class="fcin">Label &middot; <b>&yen;20 off first order</b> <span class="fctag b">EN&rarr;CN</span></div></div>'
    '<div class="fcf"><div class="fcbtn">Looks right &rarr; review</div></div>'))

# 04 the deal
SCREENS.append(("04_deal", "Step 1 · The deal", ST + head("Step 1 of 4", "The deal") +
    '<div class="fcb">'
    '<div class="fclab">What do customers save?</div>'
    '<div style="display:flex;gap:6px;">'
    '<div class="fctype on"><i class="ti ti-coin-yuan"></i><div class="tt">Money off</div></div>'
    '<div class="fctype"><i class="ti ti-percentage"></i><div class="tt">Percent off</div></div>'
    '<div class="fctype"><i class="ti ti-truck-delivery"></i><div class="tt">Free ship</div></div></div>'
    '<div><div class="fclab">How much?</div><div class="fcin">&yen; off <b>20</b></div></div>'
    '<div style="font-size:10px;color:var(--mut);">The box shows &yen; or % &mdash; never mixed up.</div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(1) + '</div>'))

# 05 who gets it
SCREENS.append(("05_who", "Step 2 · Who gets it", ST + head("Step 2 of 4", "Who gets it") +
    '<div class="fcb">'
    '<div class="fclab">How do customers get it?</div>'
    '<div class="fcpath"><i class="ti ti-discount-2"></i><div><div class="pt">Comes off by itself</div><div class="ps">Everyone, at checkout. No code.</div></div></div>'
    '<div class="fcpath"><i class="ti ti-ticket"></i><div><div class="pt">Anyone can use it</div><div class="ps">Shows in the app; a code works too.</div></div></div>'
    '<div class="fcpath on"><i class="ti ti-gift"></i><div><div class="pt">Welcome gift (new customers)</div><div class="ps">Into their coupons; tap at checkout.</div></div></div>'
    '<div class="fcpath"><i class="ti ti-users"></i><div><div class="pt">I choose who</div><div class="ps">Pick customers after saving.</div></div></div>'
    '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;"><span>Show on home page?</span><div class="fctog" style="width:110px;"><span class="fctp">No</span><span class="fctp on">Yes</span></div></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(2) + '</div>'))

# 06 rules
SCREENS.append(("06_rules", "Step 3 · Rules", ST + head("Step 3 of 4", "Rules &amp; dates") +
    '<div class="fcb">'
    '<div style="font-size:11px;color:var(--mut);">Smart defaults set. Change only what you want.</div>'
    '<div><div class="fclab">Spend at least</div><div class="fcin">&yen; 150 <span class="fctag b">avg &yen;120</span></div></div>'
    '<div><div class="fclab">Ends on</div><div class="fcin">31 Aug 2026 <i class="ti ti-calendar"></i></div></div>'
    '<div style="font-size:10px;color:var(--mut);">Empty date = never ends.</div>'
    '<div style="font-size:11.5px;color:var(--tea);font-weight:500;display:flex;align-items:center;gap:6px;"><i class="ti ti-chevron-down"></i>More rules</div>'
    '<div class="fcin">Each person &middot; <b>1 time</b></div>'
    '<div class="fcin">Stop after &middot; <b>no limit</b></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(3) + '</div>'))

# 07 review + heads-up
SCREENS.append(("07_review", "Step 4 · Review", ST + head("Step 4 of 4", "Review") +
    '<div class="fcb">' +
    ticket("&yen;20", "off", "orders &yen;150+", "&yen;20 off your first order", "Ends 31 Aug &middot; new customers") +
    '<div style="display:flex;gap:5px;flex-wrap:wrap;"><span class="fcchip ok"><i class="ti ti-check"></i>New customers</span><span class="fcchip ok"><i class="ti ti-check"></i>&yen;20 off</span><span class="fcchip">over &yen;150</span></div>'
    '<div class="fcnote brass"><i class="ti ti-bulb"></i><div>&yen;150 is just above your &yen;120 average &mdash; grows baskets.</div></div>'
    '<div class="fcnote tea"><i class="ti ti-gift"></i><div>New customers also get <b>WELCOME15</b>. One per order.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Save as draft</div><div class="fcbtno">Save &amp; turn on</div></div>'))

# 08 heads-up close-up
SCREENS.append(("08_headsup", "Heads up", ST + head("Before you turn it on", "How it fits") +
    '<div class="fcb">'
    '<div style="font-size:11px;color:var(--mut);">New automatic deal: <b style="color:var(--ink);">15% off any order</b>.</div>'
    '<div class="fcnote tea"><i class="ti ti-discount-2"></i><div>Already running: <b>SAVE10</b>. Customers get the <b>single best</b> deal &mdash; not both.</div></div>'
    '<div class="fcnote brass"><i class="ti ti-trophy"></i><div>Your 15% wins every time. SAVE10 barely used &mdash; turn it off?</div></div>'
    '<div class="fcnote tea"><i class="ti ti-user-check"></i><div>A customer&rsquo;s own coupon still wins if it saves more.</div></div>'
    '<div class="fcnote red"><i class="ti ti-history"></i><div>Code <b>SALE</b> was used before &mdash; saving resets its count.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Save as draft</div><div class="fcbtno">Save &amp; turn on</div></div>'))

manifest = []
for slug, caption, inner in SCREENS:
    with open(os.path.join(OUTDIR, "_vpm_%s.html" % slug), "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})
with open(os.path.join(OUTDIR, "voucher_ph_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("wrote %d phone voucher screens + manifest" % len(SCREENS))
