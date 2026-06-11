# -*- coding: utf-8 -*-
"""Emit standalone HTML files for the desktop (PC) VOUCHER-wizard screens, plus a
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
.dchip.ok{color:var(--tea);}
.dpanel{background:#fff;border:.5px solid var(--line);border-radius:12px;padding:20px 22px;margin:0 auto;}
.dkick{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);}
/* voucher-specific */
.dtype{flex:1;text-align:center;border:.5px solid var(--line);border-radius:11px;padding:16px 10px;background:#fff;}
.dtype.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.dtype i{font-size:24px;color:var(--brass);}.dtype.on i{color:var(--tea);}
.dtype .tt{font-size:13px;font-weight:500;margin-top:6px;}.dtype .ts{font-size:10.5px;color:var(--mut);margin-top:2px;}
.dpath{display:flex;align-items:flex-start;gap:11px;border:.5px solid var(--line);border-radius:10px;padding:13px;background:#fff;}
.dpath.on{border-color:var(--tea);background:var(--oat);box-shadow:inset 0 0 0 1px var(--tea);}
.dpath i.lead{color:var(--brass);font-size:21px;margin-top:1px;}.dpath.on i.lead{color:var(--tea);}
.dpath .pt{font-size:13.5px;font-weight:500;}.dpath .ps{font-size:11.5px;color:var(--mut);margin-top:2px;}
.dpradio{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--line);flex:0 0 auto;margin-top:2px;margin-left:auto;}
.dpath.on .dpradio{border-color:var(--tea);background:var(--tea);box-shadow:inset 0 0 0 2px #fff;}
.dticket{position:relative;background:#fff;border:.5px solid var(--line);border-left:4px solid var(--brass);border-radius:10px;padding:14px 16px;}
.dtk-big{font-size:27px;font-weight:600;color:var(--ink);line-height:1;}
.dtk-big span{font-size:14px;font-weight:500;color:var(--mut);}
.dtk-sub{font-size:11px;color:var(--mut);margin-top:3px;}
.dtk-ttl{font-size:13px;font-weight:500;margin-top:10px;}
.dtk-exp{font-size:10.5px;color:var(--mut);margin-top:3px;}
.dnote{display:flex;gap:9px;align-items:flex-start;background:#fff;border:.5px solid var(--line);border-left:3px solid var(--tea);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--ink);line-height:1.45;}
.dnote i{font-size:16px;margin-top:1px;flex:0 0 auto;}
.dnote.tea{border-left-color:var(--tea);}.dnote.tea i{color:var(--tea);}
.dnote.brass{border-left-color:var(--brass);}.dnote.brass i{color:var(--brass);}
.dnote.red{border-left-color:var(--red);}.dnote.red i{color:var(--red);}
.dnote b{font-weight:600;}
.dnlink{color:var(--tea);font-weight:500;white-space:nowrap;}
.didea{display:flex;align-items:center;gap:14px;border:.5px solid var(--line);border-radius:11px;padding:14px 16px;background:#fff;}
.didea .why{font-size:11px;color:var(--brass);font-weight:500;}
.didea .what{font-size:14px;font-weight:500;margin-top:3px;}
.didea .note{font-size:11px;color:var(--mut);margin-top:2px;}
.daibox{background:#fff;border:.5px dashed var(--brass);border-radius:9px;padding:12px;}
.daifill{display:inline-flex;align-items:center;gap:6px;background:var(--brass);color:#fff;border-radius:7px;padding:7px 12px;font-size:12.5px;font-weight:500;}
.dtog{display:flex;gap:8px;}.dtp{padding:7px 18px;border-radius:7px;border:.5px solid var(--line);font-size:13px;background:#fff;}
.dtp.on{background:var(--tea);color:#fff;border-color:var(--tea);}
</style></head><body>"""

FOOT = "</body></html>"

def shell(inner):
    top = ('<div class="dtop"><span class="wm">Full Circle</span>'
           '<span class="bc">Mini App Backend &middot; Marketing &middot; New coupon</span></div>')
    return (HEAD + '<div class="dw"><div class="dwin">' + top +
            '<div class="dpage">' + inner + '</div></div></div>' + FOOT)

RAIL = ["The deal", "Who gets it", "Rules", "Review"]
def rail(active, done):
    out = []
    for i, n in enumerate(RAIL, 1):
        cls = "dstep" + (" on" if i == active else "") + (" done" if i in done else "")
        out.append('<div class="%s"><span class="dnum">%s</span>%s</div>'
                   % (cls, ('✓' if i in done else str(i)), n))
    return '<div class="drail">' + "".join(out) + '</div>'

def modal(title, active, done, form, preview, footer, cols="180px 1fr 230px", maxw=780):
    head = ('<div class="dmh"><div><div class="k">New coupon</div><div class="t">%s</div></div>'
            '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>' % title)
    body = ('<div class="dgrid" style="grid-template-columns:%s;">%s<div class="dform">%s</div>%s</div>'
            % (cols, rail(active, done), form,
               ('<div class="dprev"><div class="dprevl">What customers see</div>%s</div>' % preview) if preview else ""))
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

# The coupon-card preview, reused across steps.
def ticket(big, unit, sub, ttl, exp):
    return ('<div class="dticket"><div class="dtk-big">%s <span>%s</span></div>'
            '<div class="dtk-sub">%s</div><div class="dtk-ttl">%s</div>'
            '<div class="dtk-exp">%s</div></div>') % (big, unit, sub, ttl, exp)

SCREENS = []

# 01 — front door
fd_cards = "".join([
    '<div class="docard"><i class="ti ti-gift"></i><div><div class="doct">Welcome gift</div><div class="docs">A thank-you for new customers</div></div></div>',
    '<div class="docard"><i class="ti ti-discount-2"></i><div><div class="doct">Store sale</div><div class="docs">A discount that comes off by itself</div></div></div>',
    '<div class="docard"><i class="ti ti-ticket"></i><div><div class="doct">A coupon anyone can use</div><div class="docs">People find it and tap to save</div></div></div>',
    '<div class="docard"><i class="ti ti-truck-delivery"></i><div><div class="doct">Free shipping</div><div class="docs">Take the delivery fee off</div></div></div>',
    '<div class="docard"><i class="ti ti-pencil"></i><div><div class="doct">Start fresh</div><div class="docs">Set it up myself</div></div></div>',
    '<div class="docard" style="border-style:dashed;border-color:var(--brass);"><i class="ti ti-bulb" style="color:var(--tea);"></i><div><div class="doct">Ideas from my sales</div><div class="docs">Let the numbers suggest one</div></div></div>',
])
fd = ('<div class="dmod" style="max-width:760px;">'
      '<div class="dmh"><div><div class="k">New coupon</div><div class="t">Make a coupon</div></div>'
      '<i class="ti ti-x" style="color:var(--mut);font-size:19px;"></i></div>'
      '<div style="padding:24px;"><div style="font-size:14px;color:var(--mut);margin-bottom:16px;">What do you want to do?</div>'
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' + fd_cards + '</div>'
      '<div class="daibox" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">'
      '<div style="font-size:12px;color:var(--mut);">Or just tell me your deal &mdash; &ldquo;20 yuan off for new customers, first order&rdquo;</div>'
      '<div class="daifill"><i class="ti ti-sparkles"></i>Fill it for me</div></div></div></div>')
SCREENS.append(("01_front", "Front door &mdash; pick a goal in plain words, or just describe the deal.", fd))

# 02 — ideas from your sales
idea_rows = "".join([
    '<div class="didea"><div style="flex:1;"><div class="why">Most orders are about &yen;120</div>'
    '<div class="what">&yen;20 off when you spend &yen;150</div><div class="note">Nudges baskets a little bigger</div></div>'
    '<span class="dbtn">Use this</span></div>',
    '<div class="didea"><div style="flex:1;"><div class="why">Many people buy once and do not come back</div>'
    '<div class="what">&yen;15 off for past customers</div><div class="note">A gentle win-back</div></div>'
    '<span class="dbtno">Use this</span></div>',
    '<div class="didea"><div style="flex:1;"><div class="why">Lots of carts stop near &yen;90</div>'
    '<div class="what">Free shipping over &yen;100</div><div class="note">Helps those carts finish</div></div>'
    '<span class="dbtno">Use this</span></div>',
])
ideas = ('<div class="dpanel" style="max-width:760px;">'
         '<div class="dkick">Ideas from your sales</div>'
         '<div style="font-size:17px;font-weight:500;margin:2px 0 4px;">Made from your own numbers</div>'
         '<div style="font-size:12.5px;color:var(--mut);margin-bottom:16px;">Tap one and the whole coupon is filled in. You can still change anything.</div>'
         '<div style="display:flex;flex-direction:column;gap:12px;">' + idea_rows + '</div>'
         '<div style="font-size:11px;color:var(--mut);margin-top:16px;display:flex;align-items:center;gap:6px;">'
         '<i class="ti ti-info-circle" style="color:var(--brass);"></i>These come from your real orders. A brand-new shop sees the plain goals instead &mdash; never made-up advice.</div></div>')
SCREENS.append(("02_ideas", "Ideas from your sales &mdash; the blank page becomes &ldquo;pick a smart idea,&rdquo; each with a real number.", ideas))

# 03 — describe -> AI fills
desc_left = ('<div class="daibox" style="margin-bottom:14px;">'
             '<div style="font-size:13px;color:var(--ink);line-height:1.5;">&ldquo;20 yuan off for new customers, first order, spend at least 100&rdquo;</div>'
             '<div style="display:flex;justify-content:flex-end;margin-top:10px;"><div class="daifill"><i class="ti ti-sparkles"></i>Fill it for me</div></div></div>'
             '<div style="font-size:11.5px;color:var(--mut);">Write it any way you like, in English or Chinese. The wizard turns it into the boxes below &mdash; you only check.</div>')
desc_right = "".join([
    '<div class="din">Save &middot; <b>&yen;20 off</b> <span class="dtag">filled</span></div>',
    '<div class="din">Who gets it &middot; <b>New customers</b> <span class="dtag">filled</span></div>',
    '<div class="din">Spend at least &middot; <b>&yen;100</b> <span class="dtag">filled</span></div>',
    '<div class="din">Code &middot; <b>WELCOME20</b> <span class="dtag b">made for you</span></div>',
    '<div class="din">Label customers see &middot; <b>&yen;20 off your first order</b> <span class="dtag b">EN &rarr; CN</span></div>',
])
desc = ('<div class="dpanel" style="max-width:820px;">'
        '<div class="dkick">Describe it</div>'
        '<div style="font-size:17px;font-weight:500;margin:2px 0 16px;">You write one line &mdash; the wizard fills the rest</div>'
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;">'
        '<div>' + desc_left + '</div>'
        '<div style="display:flex;flex-direction:column;gap:9px;">' + desc_right +
        '<div style="display:flex;justify-content:flex-end;margin-top:6px;"><span class="dbtn">Looks right &rarr; review</span></div></div>'
        '</div></div>')
SCREENS.append(("03_describe", "Describe it &mdash; one plain sentence, and the AI fills every box (code and label included).", desc))

# 04 — step 1: the deal
s1_form = (
    '<div><div class="dlab">What do customers save?</div>'
    '<div style="display:flex;gap:12px;">'
    '<div class="dtype on"><i class="ti ti-coin-yuan"></i><div class="tt">Money off</div><div class="ts">a set &yen; amount</div></div>'
    '<div class="dtype"><i class="ti ti-percentage"></i><div class="tt">Percent off</div><div class="ts">a % of the order</div></div>'
    '<div class="dtype"><i class="ti ti-truck-delivery"></i><div class="tt">Free shipping</div><div class="ts">no delivery fee</div></div>'
    '</div></div>'
    '<div style="max-width:200px;"><div class="dlab">How much?</div><div class="din">&yen; off <b style="margin-left:auto;">20</b></div></div>'
    '<div style="font-size:11.5px;color:var(--mut);">Example: &yen;20 off. The box shows &yen; or % so it is never mixed up.</div>')
s1_prev = ticket("&yen;20", "off", "any order", "&yen;20 off", "")
SCREENS.append(("04_deal", "Step 1 &mdash; The deal. Pick the kind, type one number; the unit is built into the box.",
                modal("The deal", 1, set(), s1_form, s1_prev, foot(1))))

# 05 — step 2: who gets it
paths = "".join([
    '<div class="dpath"><i class="ti ti-discount-2 lead"></i><div><div class="pt">Comes off the price by itself</div><div class="ps">Everyone, at checkout. No code. The best deal wins.</div></div><span class="dpradio"></span></div>',
    '<div class="dpath"><i class="ti ti-ticket lead"></i><div><div class="pt">Anyone can use it</div><div class="ps">Shows in the app, and a code you share also works.</div></div><span class="dpradio"></span></div>',
    '<div class="dpath on"><i class="ti ti-gift lead"></i><div><div class="pt">A welcome gift for new customers</div><div class="ps">Goes into new customers&rsquo; coupons. They tap it at checkout.</div></div><span class="dpradio"></span></div>',
    '<div class="dpath"><i class="ti ti-users lead"></i><div><div class="pt">I choose who gets it</div><div class="ps">You pick the customers yourself after saving.</div></div><span class="dpradio"></span></div>',
])
s2_form = (
    '<div><div class="dlab">How do customers get it?</div>'
    '<div style="display:flex;flex-direction:column;gap:10px;">' + paths + '</div></div>'
    '<div style="background:var(--oat);border:.5px solid var(--line);border-radius:9px;padding:11px 13px;display:flex;justify-content:space-between;align-items:center;">'
    '<div style="font-size:12.5px;">Also show it on the home page?</div>'
    '<div class="dtog"><span class="dtp">No</span><span class="dtp on">Yes</span></div></div>')
s2_prev = ticket("&yen;20", "off", "for new customers", "&yen;20 off your first order", "")
SCREENS.append(("05_who", "Step 2 &mdash; Who gets it. One plain choice replaces three confusing checkboxes.",
                modal("Who gets it", 2, {1}, s2_form, s2_prev, foot(2))))

# 06 — step 3: rules & dates
s3_form = (
    '<div style="font-size:12.5px;color:var(--mut);">All set with smart defaults. Change only what you want.</div>'
    '<div style="display:flex;gap:14px;">'
    '<div style="flex:1;"><div class="dlab">Spend at least</div><div class="din">&yen; 150 <span class="dtag b">your average is &yen;120</span></div></div>'
    '<div style="flex:1;"><div class="dlab">Ends on</div><div class="din">31 Aug 2026 <i class="ti ti-calendar"></i></div></div></div>'
    '<div style="font-size:11px;color:var(--mut);">Leave the date empty and it never ends.</div>'
    '<div style="border-top:.5px solid var(--line);padding-top:13px;">'
    '<div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--tea);font-weight:500;margin-bottom:10px;"><i class="ti ti-chevron-down"></i>More rules</div>'
    '<div style="display:flex;gap:14px;">'
    '<div style="flex:1;"><div class="dlab">Each person can use it</div><div class="din">1 time</div></div>'
    '<div style="flex:1;"><div class="dlab">Stop after</div><div class="din">no limit <span class="dtag b">cap if you like</span></div></div></div></div>')
s3_prev = ticket("&yen;20", "off", "orders &yen;150+", "&yen;20 off your first order", "Ends 31 Aug &middot; new customers")
SCREENS.append(("06_rules", "Step 3 &mdash; Rules &amp; dates. Optional, with smart defaults; the minimum is anchored to your average order.",
                modal("Rules", 3, {1, 2}, s3_form, s3_prev, foot(3))))

# 07 — step 4: review with smart heads-up
s4_form = (
    ticket("&yen;20", "off", "orders &yen;150+", "&yen;20 off your first order", "Ends 31 Aug 2026 &middot; new customers") +
    '<div style="display:flex;gap:7px;flex-wrap:wrap;">'
    '<span class="dchip ok"><i class="ti ti-check"></i>New customers</span><span class="dchip ok"><i class="ti ti-check"></i>&yen;20 off</span>'
    '<span class="dchip ok"><i class="ti ti-check"></i>over &yen;150</span><span class="dchip">Ends 31 Aug</span><span class="dchip">Each person: 1</span></div>'
    '<div class="dprevl" style="margin:4px 0 0;">Heads up</div>'
    '<div class="dnote brass"><i class="ti ti-bulb"></i><div>This minimum (&yen;150) is a little above your average order (&yen;120) &mdash; good for growing baskets.</div></div>'
    '<div class="dnote tea"><i class="ti ti-gift"></i><div>New customers will also get your <b>WELCOME15</b> gift. They can use one per order. <span class="dnlink">Turn WELCOME15 off?</span></div></div>')
s4_foot = ('<div><span class="dghost">Back</span></div>'
           '<div style="display:flex;align-items:center;gap:12px;"><span style="font-size:12px;color:var(--mut);">Open the full editor</span>'
           '<span class="dbtno">Save &amp; turn on</span><span class="dbtn">Save as draft</span></div>')
SCREENS.append(("07_review", "Step 4 &mdash; Review. See the real card, read plain heads-up notices, then save a draft or turn it on.",
                modal("Review", 4, {1, 2, 3}, s4_form, None, s4_foot, cols="180px 1fr")))

# 08 — heads-up close-up (smart conflict analysis)
hu = ('<div class="dpanel" style="max-width:820px;">'
      '<div class="dkick">Before you turn it on</div>'
      '<div style="font-size:17px;font-weight:500;margin:2px 0 4px;">How your new deal fits with the ones already running</div>'
      '<div style="font-size:12.5px;color:var(--mut);margin-bottom:16px;">You are making a new automatic deal: <b style="color:var(--ink);">15% off any order</b>. Here is what to know.</div>'
      '<div style="display:flex;flex-direction:column;gap:10px;">'
      '<div class="dnote tea"><i class="ti ti-discount-2"></i><div>Already running by itself: <b>SAVE10</b> &mdash; 10% off any order. Customers get the <b>single best deal</b>, not both &mdash; these do not add together.</div></div>'
      '<div class="dnote brass"><i class="ti ti-trophy"></i><div>Your new <b>15% off</b> wins on every order, so <b>SAVE10</b> will almost never be used. <span class="dnlink">Turn SAVE10 off?</span></div></div>'
      '<div class="dnote tea"><i class="ti ti-user-check"></i><div>If a customer picks their own coupon, they still get whichever <b>saves more</b>.</div></div>'
      '<div class="dnote red"><i class="ti ti-history"></i><div>You used the code <b>SALE</b> before and turned it off. Saving will bring it back with these settings and <b>start its count from zero</b>.</div></div>'
      '</div>'
      '<div style="display:flex;justify-content:flex-end;gap:12px;margin-top:18px;"><span class="dbtno">Save &amp; turn on</span><span class="dbtn">Save as draft</span></div></div>')
SCREENS.append(("08_headsup", "The smart heads-up &mdash; reads your live coupons and says, in plain words, what wins, what overlaps, what resets.", hu))

manifest = []
for slug, caption, inner in SCREENS:
    path = os.path.join(OUTDIR, "_vdm_%s.html" % slug)
    with open(path, "w", encoding="utf-8") as f:
        f.write(shell(inner))
    manifest.append({"slug": slug, "caption": caption})

with open(os.path.join(OUTDIR, "voucher_pc_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print("wrote %d desktop voucher screens + manifest" % len(SCREENS))
for m in manifest:
    print(" ", m["slug"])
