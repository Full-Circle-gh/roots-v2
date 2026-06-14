# -*- coding: utf-8 -*-
"""Emit standalone HTML for each individual phone FLASH-SALE-wizard screen + a manifest
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
.fcchip.ok{color:var(--tea);}.fcchip.on{background:var(--tea);color:#fff;}
.fctag{font-size:9.5px;color:var(--tea);border:.5px solid var(--tea);border-radius:10px;padding:1px 6px;font-weight:500;white-space:nowrap;}
.fctag.b{color:var(--brass);border-color:var(--brass);}.fctag.r{color:var(--red);border-color:var(--red);}
.fcdots{display:flex;gap:5px;justify-content:center;}
.fcdot{width:6px;height:6px;border-radius:50%;background:var(--line);}.fcdot.on{background:var(--brass);}
.fctog{display:flex;gap:7px;}
.fctp{flex:1;text-align:center;padding:8px;border-radius:8px;border:.5px solid var(--line);font-size:12px;background:#fff;}
.fctp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
.daibox{background:#fff;border:.5px dashed var(--brass);border-radius:10px;padding:10px;}
.daifill{display:inline-flex;align-items:center;gap:5px;background:var(--brass);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;}
.fctype{flex:1;text-align:center;border:.5px solid var(--line);border-radius:9px;padding:9px 4px;background:#fff;}
.fctype.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.fctype i{font-size:18px;color:var(--brass);}.fctype.on i{color:var(--tea);}
.fctype .tt{font-size:10.5px;font-weight:500;margin-top:3px;}
.fcnote{display:flex;gap:7px;align-items:flex-start;background:#fff;border:.5px solid var(--line);border-left:3px solid var(--tea);border-radius:8px;padding:8px 10px;font-size:10.5px;line-height:1.4;}
.fcnote i{font-size:14px;margin-top:1px;flex:0 0 auto;}
.fcnote.tea{border-left-color:var(--tea);}.fcnote.tea i{color:var(--tea);}
.fcnote.brass{border-left-color:var(--brass);}.fcnote.brass i{color:var(--brass);}
.fcnote.red{border-left-color:var(--red);}.fcnote.red i{color:var(--red);}
.fcnote b{font-weight:600;}
.fcidea{border:.5px solid var(--line);border-radius:10px;padding:11px;background:#fff;}
.fcidea .why{font-size:9.5px;color:var(--brass);font-weight:500;}
.fcidea .what{font-size:12.5px;font-weight:500;margin:2px 0 8px;}
/* product pick row */
.prow{display:flex;align-items:center;gap:9px;border:.5px solid var(--line);border-radius:8px;padding:8px 10px;background:#fff;}
.prow.on{border-color:var(--tea);background:var(--oat);}
.pbox{width:16px;height:16px;border-radius:4px;border:1.5px solid var(--line);flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;}
.prow.on .pbox{background:var(--tea);border-color:var(--tea);}
.pnm{font-size:11.5px;font-weight:500;}.ppr{margin-left:auto;font-size:11px;color:var(--mut);}
/* discount mini-table */
.mtbl{width:100%;border-collapse:collapse;font-size:10.5px;}
.mtbl td{padding:5px 4px;border-bottom:.5px solid var(--line);}
.mtbl .was{color:var(--mut);text-decoration:line-through;}
.mtbl .now{font-weight:600;}.mtbl .sv{color:var(--tea);}
/* customer flash card */
.fcard{background:#fff;border:.5px solid var(--line);border-radius:10px;overflow:hidden;}
.fcard .ph{height:74px;background:linear-gradient(135deg,#f2efe6,#e7e1d2);position:relative;}
.fbadge{position:absolute;top:7px;left:7px;background:#E96174;color:#fff;font-size:9px;font-weight:600;border-radius:5px;padding:2px 7px;}
.fcard .bd{padding:9px 11px;}
.fcard .nm{font-size:11.5px;font-weight:500;}
.fprice{display:flex;align-items:baseline;gap:6px;margin-top:4px;}
.fnow{font-size:17px;font-weight:600;color:#E96174;line-height:1;}
.fwas{font-size:11px;color:var(--mut);text-decoration:line-through;}
.foff{font-size:9.5px;color:var(--tea);font-weight:500;margin-top:2px;}
.fcd{display:flex;align-items:center;gap:4px;margin-top:7px;}
.fcd .lb{font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);}
.fcdcell{background:var(--ink);color:#fff;border-radius:4px;padding:2px 4px;font-size:10px;font-weight:600;min-width:18px;text-align:center;}
.fbar{height:5px;border-radius:3px;background:var(--oat2);margin-top:7px;overflow:hidden;}
.fbar > i{display:block;height:100%;width:62%;background:#E96174;}
.fbarlb{font-size:8.5px;color:var(--mut);margin-top:2px;}
</style></head><body>"""
FOOT = "</body></html>"

def shell(inner):
    return HEAD + '<div class="pw"><div class="fcp"><div class="fcs">' + inner + '</div></div></div>' + FOOT

ST = '<div class="fcst"><span>9:41</span><span><i class="ti ti-wifi"></i></span></div>'
def head(k, t):
    return '<div class="fch"><div class="fck">%s</div><div class="fctt">%s</div></div>' % (k, t)
def dots(active):
    return '<div class="fcdots">' + "".join('<span class="fcdot%s"></span>' % (" on" if i == active else "") for i in range(1, 5)) + '</div>'

def fcard(nm, now, was, off, h="47", m="12", s="08", bar="37 of 50 left"):
    return ('<div class="fcard"><div class="ph"><span class="fbadge">FLASH &middot; 秒杀</span></div>'
            '<div class="bd"><div class="nm">%s</div>'
            '<div class="fprice"><span class="fnow">&yen;%s</span><span class="fwas">&yen;%s</span></div>'
            '<div class="foff">Save %s</div>'
            '<div class="fcd"><span class="lb">Ends in</span><span class="fcdcell">%s</span>:<span class="fcdcell">%s</span>:<span class="fcdcell">%s</span></div>'
            '<div class="fbar"><i></i></div><div class="fbarlb">%s</div></div></div>'
            % (nm, now, was, off, h, m, s, bar))

SCREENS = []

# 01 front door
SCREENS.append(("01_front", "Front door", ST + head("New flash sale", "Run a flash sale") +
    '<div class="fcb">'
    '<div style="font-size:12px;color:var(--mut);">What kind of flash sale?</div>'
    '<div class="fcopt"><i class="ti ti-calendar-bolt"></i>Weekend sale</div>'
    '<div class="fcopt"><i class="ti ti-box-off"></i>Move old stock</div>'
    '<div class="fcopt"><i class="ti ti-flare"></i>Spotlight a few</div>'
    '<div class="fcopt"><i class="ti ti-bolt"></i>One product, quick</div>'
    '<div class="daibox"><div style="font-size:10.5px;color:var(--mut);margin-bottom:7px;">Or say it &mdash; &ldquo;20% off dried fruit this weekend&rdquo;</div>'
    '<div class="daifill"><i class="ti ti-sparkles"></i>Set it up for me</div></div></div>'))

# 02 ideas
SCREENS.append(("02_ideas", "Ideas from sales", ST + head("Ideas from your sales", "Made from your numbers") +
    '<div class="fcb">'
    '<div class="fcidea"><div class="why">5 products unsold for 30 days</div><div class="what">Clear them out &mdash; 30% off</div><div class="fcbtn" style="padding:7px;">Use this</div></div>'
    '<div class="fcidea"><div class="why">Top sellers: Goji, Dates</div><div class="what">Spotlight flash &mdash; 15% off</div><div class="fcbtno" style="padding:7px;">Use this</div></div>'
    '<div class="fcidea"><div class="why">Friday is your quietest day</div><div class="what">Friday flash &mdash; 6pm&ndash;midnight</div><div class="fcbtno" style="padding:7px;">Use this</div></div>'
    '<div style="font-size:9.5px;color:var(--mut);">Real numbers only. New shop &rarr; plain goals.</div></div>'))

# 03 what's on sale (multi-select)
SCREENS.append(("03_pick", "What's on sale", ST + head("Step 1 of 4", "What&rsquo;s on sale") +
    '<div class="fcb">'
    '<div style="display:flex;gap:5px;flex-wrap:wrap;"><span class="fcchip on">One by one</span><span class="fcchip">A section</span><span class="fcchip">Best sellers</span></div>'
    '<div class="fcin"><span style="color:var(--mut);"><i class="ti ti-search"></i> Search&hellip;</span></div>'
    '<div class="prow on"><span class="pbox">&#10003;</span><span class="pnm">Goji Berries</span><span class="ppr">&yen;47</span></div>'
    '<div class="prow on"><span class="pbox">&#10003;</span><span class="pnm">Medjool Dates</span><span class="ppr">&yen;92</span></div>'
    '<div class="prow on"><span class="pbox">&#10003;</span><span class="pnm">Deri Dates</span><span class="ppr">&yen;26</span></div>'
    '<div class="prow"><span class="pbox"></span><span class="pnm">Sweet Mango</span><span class="ppr">&yen;27</span></div>'
    '<div class="fcnote tea"><i class="ti ti-wand"></i><div>One discount sets the price for <b>all 12</b>.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Next &middot; 12 picked</div>' + dots(1) + '</div>'))

# 04 the discount
SCREENS.append(("04_discount", "The discount", ST + head("Step 2 of 4", "The discount") +
    '<div class="fcb">'
    '<div class="fclab">How much off?</div>'
    '<div style="display:flex;gap:6px;">'
    '<div class="fctype on"><i class="ti ti-percentage"></i><div class="tt">Percent off</div></div>'
    '<div class="fctype"><i class="ti ti-coin-yuan"></i><div class="tt">Money off</div></div>'
    '<div class="fctype"><i class="ti ti-tag"></i><div class="tt">Set price</div></div></div>'
    '<div class="fcin">Take off <b>20 % off</b></div>'
    '<table class="mtbl">'
    '<tr><td>Goji</td><td class="was">&yen;47</td><td class="now">&yen;37</td><td class="sv">&minus;20%</td></tr>'
    '<tr><td>Medjool</td><td class="was">&yen;92</td><td class="now">&yen;73</td><td class="sv">&minus;20%</td></tr>'
    '<tr><td>Deri</td><td class="was">&yen;26</td><td class="now">&yen;21</td><td class="sv">&minus;20%</td></tr></table>'
    '<div style="font-size:10px;color:var(--mut);">You set the percent. We work out each price.</div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(2) + '</div>'))

# 05 when & how many
SCREENS.append(("05_when", "When & how many", ST + head("Step 3 of 4", "When &amp; how many") +
    '<div class="fcb">'
    '<div class="fclab">How long does it run?</div>'
    '<div style="display:flex;gap:5px;flex-wrap:wrap;"><span class="fcchip">Tonight</span><span class="fcchip on">This weekend</span><span class="fcchip">24 hours</span><span class="fcchip">Exact</span></div>'
    '<div style="font-size:10px;color:var(--tea);"><i class="ti ti-check"></i> Fri 18:00 &rarr; Sun 23:59</div>'
    '<div class="fclab" style="margin-top:4px;">Limit how many at this price?</div>'
    '<div class="fctog"><span class="fctp on">No limit</span><span class="fctp">A number</span></div>'
    '<div class="fclab" style="margin-top:4px;">Coupon on top?</div>'
    '<div class="fctog"><span class="fctp">Yes, stack</span><span class="fctp on">No &mdash; final</span></div>'
    '<div class="fcnote brass"><i class="ti ti-info-circle"></i><div>With SAVE10, a &yen;73 item would be <b>&yen;65.70</b>.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Next</div>' + dots(3) + '</div>'))

# 06 review
SCREENS.append(("06_review", "Review", ST + head("Step 4 of 4", "Review") +
    '<div class="fcb">' + fcard("Medjool Dates", "73", "92", "&yen;19 &middot; 20% off", bar="Live this weekend") +
    '<div style="display:flex;gap:5px;flex-wrap:wrap;"><span class="fcchip ok"><i class="ti ti-check"></i>12 products</span><span class="fcchip ok"><i class="ti ti-check"></i>20% off</span><span class="fcchip">This weekend</span></div>'
    '<div class="fcnote tea"><i class="ti ti-bolt"></i><div>3 are already on flash &mdash; saving <b>replaces</b> it.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Turn on now</div><div class="fcbtno">Schedule it &middot; Save draft</div></div>'))

# 07 heads-up close-up
SCREENS.append(("07_headsup", "Heads up", ST + head("Before you turn it on", "How it fits") +
    '<div class="fcb">'
    '<div style="font-size:11px;color:var(--mut);"><b style="color:var(--ink);">12 products, 20% off</b>, this weekend.</div>'
    '<div class="fcnote tea"><i class="ti ti-bolt"></i><div>3 already on flash &mdash; saving <b>replaces</b> it. One flash per product.</div></div>'
    '<div class="fcnote brass"><i class="ti ti-stack-2"></i><div>Coupons allowed: SAVE10 makes &yen;73 &rarr; <b>&yen;65.70</b> (~30% off).</div></div>'
    '<div class="fcnote red"><i class="ti ti-percentage"></i><div>Jackfruit Chips skipped &mdash; 20% off was not cheaper.</div></div>'
    '<div class="fcnote tea"><i class="ti ti-history"></i><div>Sold count starts again from zero.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Turn on now</div><div class="fcbtno">Schedule &middot; Draft</div></div>'))

# 08 what the customer sees
SCREENS.append(("08_customer", "What the shopper sees", ST + head("What the shopper sees", "In the mini app") +
    '<div class="fcb">' + fcard("Medjool Dates", "73", "92", "&yen;19 &middot; 20% off", bar="37 of 50 left") +
    '<div class="fcnote tea"><i class="ti ti-flame"></i><div><b>FLASH</b> badge + old price struck through.</div></div>'
    '<div class="fcnote brass"><i class="ti ti-clock"></i><div>Live <b>countdown</b>; a <b>&ldquo;starts soon&rdquo;</b> teaser before it begins.</div></div>'
    '<div class="fcnote tea"><i class="ti ti-urgent"></i><div>A stock bar fills as it sells &mdash; ends on clock or sell-out.</div></div></div>'
    '<div class="fcf"><div class="fcbtn">Nothing new to build</div></div>'))

manifest = []
for slug, caption, inner in SCREENS:
    with open(os.path.join(OUTDIR, "_fpm_%s.html" % slug), "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})
with open(os.path.join(OUTDIR, "flash_ph_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("wrote %d phone flash screens + manifest" % len(SCREENS))
