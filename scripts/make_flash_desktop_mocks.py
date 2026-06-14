# -*- coding: utf-8 -*-
"""Emit standalone HTML files for the desktop (PC) FLASH-SALE-wizard screens, plus a
manifest (slug + caption) the PDF generator reads. Render each with Chrome headless.
Full Circle backend palette (Ink/Brass/Tea, IBM Plex). Simple, non-native-friendly copy."""
import json, os

OUTDIR = os.path.dirname(os.path.abspath(__file__))

HEAD = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont/dist/tabler-icons.min.css">
<style>
body{margin:0;background:#fff;}
.dw{width:1020px;--ink:#1d1d1a;--brass:#b08d4a;--tea:#6B8E6F;--oat:#faf7f0;--oat2:#f2efe6;--line:#e3ded2;--mut:#6b6b63;--red:#b2564b;padding:18px;font-family:'IBM Plex Sans',sans-serif;}
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
.dtag{font-size:10.5px;color:var(--tea);border:.5px solid var(--tea);border-radius:10px;padding:1px 7px;white-space:nowrap;}
.dtag.b{color:var(--brass);border-color:var(--brass);}
.dtag.r{color:var(--red);border-color:var(--red);}
.dprev{border-left:.5px solid var(--line);padding:20px 16px;background:var(--oat);}
.dprevl{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin-bottom:11px;}
.dmf{display:flex;justify-content:space-between;align-items:center;padding:15px 22px;border-top:.5px solid var(--line);}
.dbtn{background:var(--tea);color:#fff;border-radius:8px;padding:9px 20px;font-size:13.5px;font-weight:500;}
.dbtn.brass{background:var(--brass);}
.dbtno{background:#fff;border:.5px solid var(--brass);color:var(--brass);border-radius:8px;padding:9px 18px;font-size:13.5px;font-weight:500;}
.dghost{border:.5px solid var(--line);border-radius:8px;padding:9px 18px;font-size:13.5px;color:var(--mut);background:#fff;}
.ddots{display:flex;gap:5px;}.ddot{width:7px;height:7px;border-radius:50%;background:var(--line);}.ddot.on{background:var(--brass);}
.docard{display:flex;align-items:center;gap:13px;border:.5px solid var(--line);border-radius:10px;padding:15px;background:#fff;}
.docard i{color:var(--brass);font-size:24px;}
.doct{font-size:14px;font-weight:500;}.docs{font-size:11.5px;color:var(--mut);margin-top:2px;}
.dchip{display:inline-flex;align-items:center;gap:5px;background:var(--oat2);border-radius:20px;padding:5px 11px;font-size:12px;color:#5b5b53;}
.dchip.ok{color:var(--tea);}.dchip.on{background:var(--tea);color:#fff;}
.dpanel{background:#fff;border:.5px solid var(--line);border-radius:12px;padding:20px 22px;margin:0 auto;}
.dkick{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);}
.dtog{display:flex;gap:8px;}.dtp{padding:7px 18px;border-radius:7px;border:.5px solid var(--line);font-size:13px;background:#fff;}
.dtp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
.daibox{background:#fff;border:.5px dashed var(--brass);border-radius:9px;padding:12px;}
.daifill{display:inline-flex;align-items:center;gap:6px;background:var(--brass);color:#fff;border-radius:7px;padding:7px 12px;font-size:12.5px;font-weight:500;}
.didea{display:flex;align-items:center;gap:14px;border:.5px solid var(--line);border-radius:11px;padding:14px 16px;background:#fff;}
.didea .why{font-size:11px;color:var(--brass);font-weight:500;}
.didea .what{font-size:14px;font-weight:500;margin-top:3px;}
.didea .note{font-size:11px;color:var(--mut);margin-top:2px;}
.dnote{display:flex;gap:9px;align-items:flex-start;background:#fff;border:.5px solid var(--line);border-left:3px solid var(--tea);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--ink);line-height:1.45;}
.dnote i{font-size:16px;margin-top:1px;flex:0 0 auto;}
.dnote.tea{border-left-color:var(--tea);}.dnote.tea i{color:var(--tea);}
.dnote.brass{border-left-color:var(--brass);}.dnote.brass i{color:var(--brass);}
.dnote.red{border-left-color:var(--red);}.dnote.red i{color:var(--red);}
.dnote b{font-weight:600;}
.dnlink{color:var(--tea);font-weight:500;white-space:nowrap;}
/* ── flash-specific ─────────────────────────────────────────────── */
.dtype{flex:1;text-align:center;border:.5px solid var(--line);border-radius:11px;padding:16px 10px;background:#fff;}
.dtype.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.dtype i{font-size:24px;color:var(--brass);}.dtype.on i{color:var(--tea);}
.dtype .tt{font-size:13px;font-weight:500;margin-top:6px;}.dtype .ts{font-size:10.5px;color:var(--mut);margin-top:2px;}
/* product pick row */
.prow{display:flex;align-items:center;gap:12px;border:.5px solid var(--line);border-radius:9px;padding:9px 12px;background:#fff;}
.prow.on{border-color:var(--tea);background:var(--oat);}
.pbox{width:18px;height:18px;border-radius:5px;border:1.5px solid var(--line);flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;}
.prow.on .pbox{background:var(--tea);border-color:var(--tea);}
.pth{width:30px;height:30px;border-radius:6px;background:var(--oat2);flex:0 0 auto;}
.pnm{font-size:13px;font-weight:500;}.psub{font-size:10.5px;color:var(--mut);}
.ppr{margin-left:auto;font-size:12.5px;color:var(--mut);}
/* discount table */
.dtbl{width:100%;border-collapse:collapse;font-size:12px;}
.dtbl th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);font-weight:500;padding:6px 8px;border-bottom:.5px solid var(--line);}
.dtbl td{padding:8px;border-bottom:.5px solid var(--line);}
.dtbl .was{color:var(--mut);text-decoration:line-through;}
.dtbl .now{font-weight:600;color:var(--ink);}
.dtbl .sv{color:var(--tea);font-weight:500;}
.dtbl .bad{color:var(--red);font-weight:500;}
/* customer flash card */
.fcard{background:#fff;border:.5px solid var(--line);border-radius:12px;overflow:hidden;width:230px;}
.fcard .ph{height:96px;background:linear-gradient(135deg,#f2efe6,#e7e1d2);position:relative;}
.fbadge{position:absolute;top:8px;left:8px;background:#E96174;color:#fff;font-size:10px;font-weight:600;letter-spacing:.05em;border-radius:6px;padding:3px 8px;}
.fcard .bd{padding:11px 13px;}
.fcard .nm{font-size:12.5px;font-weight:500;}
.fprice{display:flex;align-items:baseline;gap:7px;margin-top:5px;}
.fnow{font-size:20px;font-weight:600;color:#E96174;line-height:1;}
.fwas{font-size:12px;color:var(--mut);text-decoration:line-through;}
.foff{font-size:10.5px;color:var(--tea);font-weight:500;margin-top:3px;}
.fcd{display:flex;align-items:center;gap:5px;margin-top:9px;}
.fcd .lb{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);}
.fcdcell{background:var(--ink);color:#fff;border-radius:5px;padding:3px 5px;font-size:11px;font-weight:600;min-width:21px;text-align:center;}
.fbar{height:6px;border-radius:4px;background:var(--oat2);margin-top:9px;overflow:hidden;}
.fbar > i{display:block;height:100%;width:62%;background:#E96174;}
.fbarlb{font-size:9.5px;color:var(--mut);margin-top:3px;}
</style></head><body>"""

FOOT = "</body></html>"

def shell(inner):
    top = ('<div class="dtop"><span class="wm">Full Circle</span>'
           '<span class="bc">Mini App Backend &middot; Marketing &middot; Flash sales &middot; New flash sale</span></div>')
    return (HEAD + '<div class="dw"><div class="dwin">' + top +
            '<div class="dpage">' + inner + '</div></div></div>' + FOOT)

RAIL = ["What&rsquo;s on sale", "The discount", "When &amp; how many", "Review"]
def rail(active, done):
    out = []
    for i, n in enumerate(RAIL, 1):
        cls = "dstep" + (" on" if i == active else "") + (" done" if i in done else "")
        out.append('<div class="%s"><span class="dnum">%s</span>%s</div>'
                   % (cls, ('&#10003;' if i in done else str(i)), n))
    return '<div class="drail">' + "".join(out) + '</div>'

def modal(title, active, done, form, preview, footer, cols="190px 1fr 250px", maxw=850):
    head = ('<div class="dmh"><div><div class="k">New flash sale</div><div class="t">%s</div></div>'
            '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>' % title)
    body = ('<div class="dgrid" style="grid-template-columns:%s;">%s<div class="dform">%s</div>%s</div>'
            % (cols, rail(active, done), form,
               ('<div class="dprev"><div class="dprevl">What shoppers see</div>%s</div>' % preview) if preview else ""))
    return ('<div class="dmod" style="max-width:%spx;">%s%s%s</div>'
            % (maxw, head, body, '<div class="dmf">%s</div>' % footer))

def dots(active):
    return '<div class="ddots">' + "".join(
        '<span class="ddot%s"></span>' % (" on" if i == active else "") for i in range(1, 5)) + '</div>'

def foot(active, primary="Next"):
    return ('<div style="display:flex;align-items:center;gap:14px;"><span class="dghost">Back</span>%s</div>'
            '<div style="display:flex;align-items:center;gap:12px;">'
            '<span style="font-size:12px;color:var(--mut);">Open the full editor</span>'
            '<span class="dbtn">%s</span></div>' % (dots(active), primary))

# Reusable customer flash card (the live preview).
def fcard(nm, now, was, off, days=None, h="06", m="12", s="40", bar="37 of 50 left at this price"):
    cd_days = '<span class="fcdcell">%s</span>:' % days if days else ''
    return ('<div class="fcard"><div class="ph"><span class="fbadge">FLASH &middot; 秒杀</span></div>'
            '<div class="bd"><div class="nm">%s</div>'
            '<div class="fprice"><span class="fnow">&yen;%s</span><span class="fwas">&yen;%s</span></div>'
            '<div class="foff">Save %s</div>'
            '<div class="fcd"><span class="lb">Ends in</span>%s<span class="fcdcell">%s</span>:<span class="fcdcell">%s</span>:<span class="fcdcell">%s</span></div>'
            '<div class="fbar"><i></i></div><div class="fbarlb">%s</div></div></div>'
            % (nm, now, was, off, cd_days, h, m, s, bar))

SCREENS = []

# 01 — front door
fd_cards = "".join([
    '<div class="docard"><i class="ti ti-calendar-bolt"></i><div><div class="doct">Weekend sale</div><div class="docs">A short price drop on a group of products</div></div></div>',
    '<div class="docard"><i class="ti ti-box-off"></i><div><div class="doct">Move old stock</div><div class="docs">Clear slow sellers with a deeper cut</div></div></div>',
    '<div class="docard"><i class="ti ti-flare"></i><div><div class="doct">Spotlight a few products</div><div class="docs">Hand-pick a few to pull people in</div></div></div>',
    '<div class="docard"><i class="ti ti-bolt"></i><div><div class="doct">One product, quick</div><div class="docs">The classic single-item flash</div></div></div>',
    '<div class="docard"><i class="ti ti-pencil"></i><div><div class="doct">Start fresh</div><div class="docs">Set it up myself</div></div></div>',
    '<div class="docard" style="border-style:dashed;border-color:var(--brass);"><i class="ti ti-bulb" style="color:var(--tea);"></i><div><div class="doct">Ideas from my sales</div><div class="docs">Let the numbers suggest one</div></div></div>',
])
fd = ('<div class="dmod" style="max-width:780px;">'
      '<div class="dmh"><div><div class="k">New flash sale</div><div class="t">Run a flash sale</div></div>'
      '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>'
      '<div style="padding:24px;"><div style="font-size:14px;color:var(--mut);margin-bottom:16px;">What kind of flash sale?</div>'
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' + fd_cards + '</div>'
      '<div class="daibox" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">'
      '<div style="font-size:12px;color:var(--mut);">Or just say it &mdash; &ldquo;20% off all dried fruit this weekend&rdquo;</div>'
      '<div class="daifill"><i class="ti ti-sparkles"></i>Set it up for me</div></div></div></div>')
SCREENS.append(("01_front", "Front door &mdash; pick the kind of flash sale in plain words, or describe it in one line.", fd))

# 02 — ideas from your sales
idea_rows = "".join([
    '<div class="didea"><div style="flex:1;"><div class="why">5 products have not sold in 30 days</div>'
    '<div class="what">Clear them out &mdash; 30% off, 3 days</div><div class="note">Turns dead stock into cash and shelf space</div></div>'
    '<span class="dbtn">Use this</span></div>',
    '<div class="didea"><div style="flex:1;"><div class="why">Your top sellers: Goji, Medjool Dates</div>'
    '<div class="what">Spotlight flash &mdash; 15% off, this weekend</div><div class="note">A small cut on what people already want pulls visits</div></div>'
    '<span class="dbtno">Use this</span></div>',
    '<div class="didea"><div style="flex:1;"><div class="why">Friday is your quietest day</div>'
    '<div class="what">Friday flash &mdash; 6pm to midnight</div><div class="note">Lifts your slowest hours</div></div>'
    '<span class="dbtno">Use this</span></div>',
])
ideas = ('<div class="dpanel" style="max-width:760px;">'
         '<div class="dkick">Ideas from your sales</div>'
         '<div style="font-size:17px;font-weight:500;margin:2px 0 4px;">Made from your own numbers</div>'
         '<div style="font-size:12.5px;color:var(--mut);margin-bottom:16px;">Tap one and the products, the discount and the timing are all filled in. You can still change anything.</div>'
         '<div style="display:flex;flex-direction:column;gap:12px;">' + idea_rows + '</div>'
         '<div style="font-size:11px;color:var(--mut);margin-top:16px;display:flex;align-items:center;gap:6px;">'
         '<i class="ti ti-info-circle" style="color:var(--brass);"></i>These come from your real orders. A brand-new shop sees the plain goals instead &mdash; never made-up advice.</div></div>')
SCREENS.append(("02_ideas", "Ideas from your sales &mdash; the blank page becomes &ldquo;pick a smart idea,&rdquo; each tied to a real number.", ideas))

# 03 — what's on sale (multi-select — the new capability)
def prow(on, nm, sub, pr):
    return ('<div class="prow%s"><span class="pbox">%s</span><span class="pth"></span>'
            '<div><div class="pnm">%s</div><div class="psub">%s</div></div><span class="ppr">&yen;%s</span></div>'
            % (" on" if on else "", "&#10003;" if on else "", nm, sub, pr))
pick_form = (
    '<div><div class="dlab">Pick the products on sale</div>'
    '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px;">'
    '<span class="dchip on"><i class="ti ti-list-check"></i>Pick one by one</span>'
    '<span class="dchip"><i class="ti ti-folder"></i>A whole section</span>'
    '<span class="dchip"><i class="ti ti-trophy"></i>My best sellers</span>'
    '<span class="dchip"><i class="ti ti-box-off"></i>Slow movers</span></div>'
    '<div class="din" style="margin-bottom:10px;"><span style="color:var(--mut);"><i class="ti ti-search"></i> Search products&hellip;</span></div>'
    '<div style="display:flex;flex-direction:column;gap:8px;">'
    + prow(True, "USDA Organic Goji Berries", "枸杞 &middot; 2-200", "47")
    + prow(True, "Medjool Dates (Jumbo)", "以色列帝王椰枣 &middot; 2-290", "92")
    + prow(True, "Deri Dates", "椰枣 &middot; 2-291", "26")
    + prow(False, "Dehydrated Sweet Mango", "凯特芒果干 &middot; 4-210", "27")
    + prow(True, "Sun-Dried Apricots", "阳光晒干杏脯 &middot; 2-220", "29")
    + '</div></div>')
pick_side = ('<div style="font-size:12px;color:var(--mut);">Selected</div>'
             '<div style="font-size:30px;font-weight:600;color:var(--ink);line-height:1.1;">12</div>'
             '<div style="font-size:11.5px;color:var(--mut);margin-bottom:14px;">products</div>'
             '<div class="dnote tea"><i class="ti ti-wand"></i><div>One discount sets the new price for <b>all 12</b> &mdash; no typing a price for each.</div></div>')
SCREENS.append(("03_pick", "What&rsquo;s on sale &mdash; the new part: pick many products at once (a section, your best sellers, or one by one).",
                modal("What&rsquo;s on sale", 1, set(), pick_form, pick_side, foot(1), cols="190px 1fr 220px")))

# 04 — the discount (percent -> per-product price, done for you)
disc_form = (
    '<div><div class="dlab">How much off?</div>'
    '<div style="display:flex;gap:12px;">'
    '<div class="dtype on"><i class="ti ti-percentage"></i><div class="tt">Percent off</div><div class="ts">same % on every product</div></div>'
    '<div class="dtype"><i class="ti ti-coin-yuan"></i><div class="tt">Money off each</div><div class="ts">a set &yen; off every product</div></div>'
    '<div class="dtype"><i class="ti ti-tag"></i><div class="tt">Set one price</div><div class="ts">only for a single product</div></div>'
    '</div></div>'
    '<div style="display:flex;align-items:center;gap:14px;">'
    '<div style="max-width:150px;"><div class="dlab">Take off</div><div class="din"><b>20</b> % off</div></div>'
    '<label style="font-size:12px;color:var(--ink);display:flex;align-items:center;gap:6px;margin-top:14px;"><span class="dtp on" style="padding:5px 10px;">&#10003; Round to nice prices</span></label></div>'
    '<div style="border:.5px solid var(--line);border-radius:9px;overflow:hidden;">'
    '<table class="dtbl"><tr><th>Product</th><th>Was</th><th>Now</th><th>They save</th></tr>'
    '<tr><td>Goji Berries</td><td class="was">&yen;47</td><td class="now">&yen;37</td><td class="sv">&yen;10 &middot; 20%</td></tr>'
    '<tr><td>Medjool Dates</td><td class="was">&yen;92</td><td class="now">&yen;73</td><td class="sv">&yen;19 &middot; 20%</td></tr>'
    '<tr><td>Deri Dates</td><td class="was">&yen;26</td><td class="now">&yen;21</td><td class="sv">&yen;5 &middot; 20%</td></tr>'
    '<tr><td>Sun-Dried Apricots</td><td class="was">&yen;29</td><td class="now">&yen;23</td><td class="sv">&yen;6 &middot; 20%</td></tr>'
    '<tr><td>Jackfruit Chips <span class="dtag r">already cheap</span></td><td class="was">&yen;24</td><td class="now bad">&yen;24</td><td class="bad">not cheaper &mdash; skipped</td></tr>'
    '</table></div>'
    '<div style="font-size:11.5px;color:var(--mut);">You set one percent. We work out each new price &mdash; and skip any product the cut would not actually make cheaper.</div>')
SCREENS.append(("04_discount", "The discount &mdash; set one percent; the wizard does the math for every product and flags any that would not really be cheaper.",
                modal("The discount", 2, {1}, disc_form, None, foot(2), cols="190px 1fr")))

# 05 — when & how many
when_form = (
    '<div><div class="dlab">How long does it run?</div>'
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
    '<span class="dchip"><i class="ti ti-moon"></i>Tonight, 6pm&ndash;midnight</span>'
    '<span class="dchip on"><i class="ti ti-calendar-week"></i>This weekend</span>'
    '<span class="dchip"><i class="ti ti-clock-hour-24"></i>Next 24 hours</span>'
    '<span class="dchip"><i class="ti ti-calendar"></i>3 days</span>'
    '<span class="dchip"><i class="ti ti-adjustments"></i>Pick exact times</span></div>'
    '<div style="font-size:11.5px;color:var(--tea);margin-top:2px;"><i class="ti ti-check"></i> Starts Fri 18:00, ends Sun 23:59 &mdash; shoppers see a live countdown.</div></div>'
    '<div><div class="dlab">Limit how many at this price?</div>'
    '<div style="display:flex;gap:8px;align-items:center;"><span class="dtp on">No limit</span><span class="dtp">Set a number</span>'
    '<span style="font-size:11.5px;color:var(--mut);">A limit adds an &ldquo;only 50 left&rdquo; urgency bar.</span></div></div>'
    '<div style="border-top:.5px solid var(--line);padding-top:13px;">'
    '<div class="dlab">Can shoppers also use a coupon on top?</div>'
    '<div class="dtog" style="margin-bottom:8px;"><span class="dtp">Yes, stack it</span><span class="dtp on">No &mdash; flash price is final</span></div>'
    '<div class="dnote brass"><i class="ti ti-info-circle"></i><div>If you allow stacking, a shopper with <b>SAVE10</b> pays <b>&yen;65.70</b> on a &yen;73 item &mdash; about 30% off in total.</div></div></div>')
when_side = fcard("Medjool Dates", "73", "92", "&yen;19 &middot; 20% off", h="47", m="12", s="08", bar="No limit set")
SCREENS.append(("05_when", "When &amp; how many &mdash; plain timing (&ldquo;this weekend&rdquo;), an optional stock cap, and the coupon-stacking choice in plain words.",
                modal("When &amp; how many", 3, {1, 2}, when_form, when_side, foot(3), cols="190px 1fr 250px")))

# 06 — review
rv_form = (
    '<div style="display:flex;gap:7px;flex-wrap:wrap;">'
    '<span class="dchip ok"><i class="ti ti-check"></i>12 products</span><span class="dchip ok"><i class="ti ti-check"></i>20% off</span>'
    '<span class="dchip ok"><i class="ti ti-check"></i>This weekend</span><span class="dchip">Fri 18:00 &rarr; Sun 23:59</span>'
    '<span class="dchip">No coupon on top</span><span class="dchip">No stock limit</span></div>'
    '<div class="dprevl" style="margin:6px 0 0;">Heads up</div>'
    '<div class="dnote tea"><i class="ti ti-bolt"></i><div>3 of these are already on a flash ending tomorrow. Saving <b>replaces</b> that window and starts the &ldquo;sold&rdquo; count again from zero.</div></div>'
    '<div class="dnote brass"><i class="ti ti-percentage"></i><div>Jackfruit Chips was skipped &mdash; 20% off was not below its current price.</div></div>')
rv_foot = ('<div><span class="dghost">Back</span></div>'
           '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:var(--mut);">Open the full editor</span>'
           '<span class="dghost">Save as draft</span><span class="dbtno">Schedule it</span><span class="dbtn">Turn on now</span></div>')
SCREENS.append(("06_review", "Review &mdash; the real shopper card, a one-line summary, plain heads-up, then save a draft, schedule it, or turn it on.",
                modal("Review", 4, {1, 2, 3},
                      fcard("Medjool Dates", "73", "92", "&yen;19 &middot; 20% off", h="47", m="12", s="08", bar="Live this weekend") + rv_form,
                      None, rv_foot, cols="190px 1fr")))

# 07 — smart heads-up close-up
hu = ('<div class="dpanel" style="max-width:820px;">'
      '<div class="dkick">Before you turn it on</div>'
      '<div style="font-size:17px;font-weight:500;margin:2px 0 4px;">How this flash fits with what is already running</div>'
      '<div style="font-size:12.5px;color:var(--mut);margin-bottom:16px;">You are putting <b style="color:var(--ink);">12 products at 20% off</b> live this weekend. Here is what to know.</div>'
      '<div style="display:flex;flex-direction:column;gap:10px;">'
      '<div class="dnote tea"><i class="ti ti-bolt"></i><div>3 products already have a flash ending tomorrow. Saving <b>replaces</b> it &mdash; one flash per product at a time. <span class="dnlink">See which 3</span></div></div>'
      '<div class="dnote brass"><i class="ti ti-stack-2"></i><div>You allowed coupons on top. With <b>SAVE10</b> live, a &yen;73 item becomes <b>&yen;65.70</b> &mdash; about <b>30% off</b> in total. Make the flash price final?</div></div>'
      '<div class="dnote red"><i class="ti ti-percentage"></i><div>Jackfruit Chips would not be cheaper at 20% off &mdash; left out so it never shows a fake discount.</div></div>'
      '<div class="dnote tea"><i class="ti ti-history"></i><div>Two of these ran a flash before. Their <b>sold count starts again from zero</b>, so a stock limit counts this run only.</div></div>'
      '<div class="dnote brass"><i class="ti ti-plus"></i><div>A chosen option (e.g. &ldquo;+ extra spice &yen;5&rdquo;) still adds on top of the flash price &mdash; the discount is on the base item.</div></div>'
      '</div>'
      '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;"><span class="dghost">Save as draft</span><span class="dbtno">Schedule it</span><span class="dbtn">Turn on now</span></div></div>')
SCREENS.append(("07_headsup", "The smart heads-up &mdash; reads your live sales and coupons and says, in plain words, what gets replaced, what stacks, what resets, what is skipped.", hu))

# 08 — what the customer sees
cust = ('<div class="dpanel" style="max-width:760px;">'
        '<div class="dkick">What the shopper sees</div>'
        '<div style="font-size:17px;font-weight:500;margin:2px 0 4px;">The same flash, in the mini app</div>'
        '<div style="font-size:12.5px;color:var(--mut);margin-bottom:18px;">Nothing new to build &mdash; the shop already shows the flash badge, the old price struck through, a live countdown, and an &ldquo;almost gone&rdquo; bar.</div>'
        '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;justify-content:center;">'
        + fcard("Medjool Dates (Jumbo)", "73", "92", "&yen;19 &middot; 20% off", h="47", m="12", s="08", bar="37 of 50 left at this price")
        + fcard("USDA Organic Goji Berries", "37", "47", "&yen;10 &middot; 20% off", h="47", m="12", s="08", bar="No limit &mdash; runs till Sun")
        + '<div style="flex:1;min-width:220px;">'
        '<div class="dnote tea"><i class="ti ti-flame"></i><div><b>FLASH &middot; 秒杀</b> badge + old price struck through + the new price in flash colour.</div></div>'
        '<div class="dnote brass" style="margin-top:9px;"><i class="ti ti-clock"></i><div>A live <b>countdown</b> to the end time. Before it starts, a <b>&ldquo;starts soon&rdquo;</b> teaser shows instead.</div></div>'
        '<div class="dnote tea" style="margin-top:9px;"><i class="ti ti-urgent"></i><div>If you set a limit, an <b>&ldquo;almost gone&rdquo;</b> bar fills as it sells &mdash; ends when the clock or the stock runs out, whichever is first.</div></div>'
        '</div></div></div>')
SCREENS.append(("08_customer", "What the shopper sees &mdash; the flash card already exists: badge, struck-through price, live countdown, and a stock bar.", cust))

manifest = []
for slug, caption, inner in SCREENS:
    path = os.path.join(OUTDIR, "_fdm_%s.html" % slug)
    with open(path, "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})

with open(os.path.join(OUTDIR, "flash_pc_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print("wrote %d desktop flash screens + manifest" % len(SCREENS))
for m in manifest:
    print(" ", m["slug"])
