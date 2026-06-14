# -*- coding: utf-8 -*-
"""Generate the Simple Flash Sale Wizard plan as a branded PDF (Full Circle: Ink/Brass/Tea).

Parts:
  Part 1 — The wizard (front door, the many-products-one-discount unlock, ideas-from-sales,
           the 4-screen flow, the field map, plain words)
  Part 2 — When sales & coupons already exist (the smart heads-up / conflict matrix)
  Part 3 — Honest limits + the build (what it won't promise yet, reused vs new, build order)
  The screens — desktop + phone galleries (rendered mockups)
"""
import os, json
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
    ListFlowable, ListItem, KeepTogether, PageBreak, Image as RLImage
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

OUT = "Simple-Flash-Sale-Wizard-Plan.pdf"

# ── Embed a full-Unicode font so arrows (→), checks (✓), ≤, curly quotes all render ──
FONTDIR = "C:/Windows/Fonts"
REG, BLD, ITA, BIT = "FCSans", "FCSans-Bold", "FCSans-Italic", "FCSans-BoldItalic"
pdfmetrics.registerFont(TTFont(REG, os.path.join(FONTDIR, "arial.ttf")))
pdfmetrics.registerFont(TTFont(BLD, os.path.join(FONTDIR, "arialbd.ttf")))
pdfmetrics.registerFont(TTFont(ITA, os.path.join(FONTDIR, "ariali.ttf")))
pdfmetrics.registerFont(TTFont(BIT, os.path.join(FONTDIR, "arialbi.ttf")))
pdfmetrics.registerFontFamily(REG, normal=REG, bold=BLD, italic=ITA, boldItalic=BIT)

# ── Brand palette ──────────────────────────────────────────────────────────
INK    = colors.HexColor("#1d1d1a")
BRASS  = colors.HexColor("#b08d4a")
TEA    = colors.HexColor("#6B8E6F")
MUTED  = colors.HexColor("#6b6b63")
LINE   = colors.HexColor("#e3ded2")
PANEL  = colors.HexColor("#faf7f0")
TEASOFT= colors.HexColor("#eef2ec")
REDISH = colors.HexColor("#b2564b")

styles = getSampleStyleSheet()

def S(name, **kw):
    base = kw.pop("parent", styles["Normal"])
    return ParagraphStyle(name, parent=base, **kw)

title_st   = S("t",  fontName=BLD, fontSize=24, leading=27, textColor=INK, spaceAfter=2)
subtitle   = S("st", fontName=ITA, fontSize=11, leading=15, textColor=MUTED, spaceAfter=4)
h2_st      = S("h2", fontName=BLD, fontSize=14.5, leading=18, textColor=TEA, spaceBefore=16, spaceAfter=5)
h3_st      = S("h3", fontName=BLD, fontSize=11.5, leading=15, textColor=INK, spaceBefore=9, spaceAfter=3)
body_st    = S("b",  fontName=REG, fontSize=10, leading=14.5, textColor=INK, spaceAfter=5)
small_st   = S("sm", fontName=REG, fontSize=8.8, leading=12, textColor=INK)
small_mut  = S("smm",fontName=REG, fontSize=8.8, leading=12, textColor=MUTED)
th_st      = S("th", fontName=BLD, fontSize=8.8, leading=11, textColor=colors.white)
li_st      = S("li", fontName=REG, fontSize=10, leading=14, textColor=INK)
screen_lbl = S("scl",fontName=BLD, fontSize=10.5, leading=13, textColor=BRASS, spaceAfter=2)
kicker     = S("kic",fontName=BLD, fontSize=8, leading=10, textColor=BRASS, spaceAfter=2)
part_kick  = S("pk", fontName=BLD, fontSize=9, leading=11, textColor=BRASS, spaceAfter=1)
part_ttl   = S("pt", fontName=BLD, fontSize=17, leading=20, textColor=colors.white)
end_st     = S("end",fontName=ITA, fontSize=9.5, leading=13, textColor=MUTED)

def p(t, st=body_st): return Paragraph(t, st)

def bullets(items, st=li_st):
    return ListFlowable(
        [ListItem(Paragraph(i, st), leftIndent=12, value="•") for i in items],
        bulletType="bullet", start="•", leftIndent=10, bulletFontSize=8,
        bulletColor=TEA, spaceBefore=1, spaceAfter=6,
    )

def rule(c=LINE, w=0.8, sb=4, sa=8):
    return HRFlowable(width="100%", thickness=w, color=c, spaceBefore=sb, spaceAfter=sa)

def make_table(data, col_widths, header=True, font=8.8):
    rows = []
    for r, row in enumerate(data):
        cells = []
        for c, val in enumerate(row):
            if r == 0 and header:
                cells.append(Paragraph(val, th_st))
            else:
                st = ParagraphStyle("c%d_%d" % (r, c), fontName=REG,
                                    fontSize=font, leading=font + 2.6, textColor=INK)
                if c == 0:
                    st.fontName = BLD
                cells.append(Paragraph(val, st))
        rows.append(cells)
    t = Table(rows, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("LINEAFTER", (0, 0), (-2, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), TEA),
                  ("TOPPADDING", (0, 0), (-1, 0), 6), ("BOTTOMPADDING", (0, 0), (-1, 0), 6)]
        for r in range(2, len(data), 2):
            style.append(("BACKGROUND", (0, r), (-1, r), PANEL))
    t.setStyle(TableStyle(style))
    return t

def panel(flowables, bg=PANEL, border=LINE, pad=9):
    inner = Table([[flowables]], colWidths=[None])
    inner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), pad), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
    ]))
    return inner

def part_band(kick, title):
    band = Table([[[Paragraph(kick, part_kick), Paragraph(title, part_ttl)]]], colWidths=[None])
    band.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), INK),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return [band, HRFlowable(width="100%", thickness=2, color=BRASS, spaceBefore=0, spaceAfter=10)]

def screen(num, name, lines):
    flow = [p("Screen %s — %s" % (num, name), screen_lbl), bullets(lines)]
    return KeepTogether(panel(flow, bg=PANEL))

cap_st = S("cap", fontName=ITA, fontSize=8.6, leading=11, textColor=MUTED, alignment=1, spaceBefore=4)

def framed_shot(path, w_pt):
    img = RLImage(path)
    ratio = img.imageHeight / float(img.imageWidth)
    img.drawWidth = w_pt
    img.drawHeight = w_pt * ratio
    t = Table([[img]], colWidths=[w_pt])
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    t.hAlign = "CENTER"
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.6)
    canvas.line(20*mm, 14*mm, A4[0]-20*mm, 14*mm)
    canvas.setFont(REG, 8); canvas.setFillColor(MUTED)
    canvas.drawString(20*mm, 9.5*mm, "Full Circle · Mini App Backend")
    canvas.drawCentredString(A4[0]/2, 9.5*mm, "Simple Flash Sale Wizard — Plan")
    canvas.drawRightString(A4[0]-20*mm, 9.5*mm, "Page %d" % doc.page)
    canvas.restoreState()

story = []

# ══ COVER ══════════════════════════════════════════════════════════════════
story += [
    p("PRODUCT DESIGN PLAN", kicker),
    p("The Simple Flash Sale Wizard", title_st),
    p("A guided, plain-language way to run a flash sale (限时秒杀) &mdash; built for sellers who are not "
      "techies, and for whom English is a second language.", subtitle),
    rule(BRASS, 1.4, 6, 10),
]
story += [panel([
    p("<b>The whole idea in one line:</b> pick what is on sale, set one discount, choose when, see the real "
      "card, turn it on.", body_st),
    p("The wizard is a friendly front-door to the <b>same</b> flash sale the Flash sales page already runs "
      "&mdash; never a separate system, so anything made here stays fully editable later.", small_st),
    p("Two promises run through it: <b>plain words</b> (no jargon, short sentences) and <b>draft-first</b> "
      "(nothing goes live by accident &mdash; you choose when to turn it on). And one new power the old form "
      "never had: <b>many products at once, with the price math done for you.</b>", small_mut),
], bg=TEASOFT, border=TEA)]
story += [Spacer(1, 12)]

# ══ PART 1 ═════════════════════════════════════════════════════════════════
story += part_band("PART ONE — THE WIZARD", "Run a flash sale in a few simple steps")

story += [p("Why this is simple — the levers", h2_st)]
story += [bullets([
    "<b>Pick a goal, do not build from parts.</b> Ready-made flash goals (weekend sale, clear out old "
    "stock, spotlight a few&hellip;) fill the products, the discount and the timing in.",
    "<b>Set a percent &mdash; we do the math.</b> Say &ldquo;20% off&rdquo; once; the wizard works out the new "
    "price for every product, so you never type a price for each one.",
    "<b>Pick many products at once.</b> A whole section, your best sellers, or tick them one by one &mdash; "
    "one discount covers them all.",
    "<b>Plain time, not a calendar puzzle.</b> &ldquo;This weekend&rdquo; or &ldquo;tonight 6pm&ndash;midnight&rdquo; "
    "becomes the exact start and end for you.",
    "<b>Smart defaults + draft-first.</b> Sensible values are pre-set; you can save a draft, schedule it, or "
    "turn it on now.",
])]

story += [p("How it starts — the front door", h2_st)]
story += [p("One friendly question before any form:", body_st)]
story += [panel([
    p("<b>What kind of flash sale?</b>", body_st),
    p("<b>Weekend sale</b> &nbsp;·&nbsp; <b>Move old stock</b> &nbsp;·&nbsp; <b>Spotlight a few products</b> "
      "&nbsp;·&nbsp; <b>One product, quick</b> &nbsp;·&nbsp; <b>Start fresh</b> &nbsp;·&nbsp; "
      "<b>Ideas from my sales</b>", body_st),
    p("Each goal pre-fills the whole wizard, so it becomes a series of <i>confirmations</i>. Or use the "
      "<b>&ldquo;just say it&rdquo;</b> box &mdash; type &ldquo;20% off all dried fruit this weekend&rdquo; and "
      "the wizard picks the products, sets the cut, and chooses the dates.", small_mut),
])]

story += [p("The new part — many products, one discount", h2_st)]
story += [p("Today the Flash sales form does <b>one product at a time</b>, and it asks for the exact final "
            "price in yuan &mdash; so a &ldquo;weekend sale on all dried fruit&rdquo; means repeating the form "
            "fifteen times and doing the discount math by hand. This is the single biggest thing the wizard "
            "fixes.", body_st)]
story += [make_table([
    ["The old form", "The wizard"],
    ["One product per save", "Pick a section / your best sellers / tick many &mdash; one save covers them all"],
    ["Type the exact flash price (&yen;73.60&hellip;)", "Set one percent; each new price is worked out for you"],
    ["No idea if it is really cheaper", "Any product the cut would not actually lower is <b>skipped</b>, with a note"],
    ["Prices look ugly (&yen;73.60)", "<b>Round to nice prices</b> is on by default (&yen;73)"],
], [80*mm, 81*mm])]
story += [panel([
    p("<b>How it works under the hood (no new pricing engine):</b> the wizard turns &ldquo;20% off&rdquo; into a "
      "real flash price per product (regular &times; 0.8, rounded), then saves each one the same way the form "
      "does today. The flash engine, the customer card and the countdown are all <b>reused exactly as-is</b> "
      "&mdash; the wizard only fills the boxes faster and for many products at once.", small_st),
], bg=TEASOFT, border=TEA)]

story += [p("Ideas from your sales — the blank page, solved", h2_st)]
story += [p("The hardest moment for a non-technical seller is the blank page: <i>which</i> products, and "
            "<i>what discount?</i> Their own sales answer it. The wizard reads the shop&rsquo;s real numbers and "
            "offers a few ready-to-use ideas &mdash; each tied to a real figure, each one filling in the part the "
            "seller would otherwise have to guess.", body_st)]
story += [make_table([
    ["Real number from your shop", "What the wizard suggests (plain)", "Fills in"],
    ["5 products have not sold in 30 days", "&ldquo;Clear them out &mdash; 30% off for 3 days&rdquo;", "products + discount"],
    ["Your best sellers are Goji &amp; Dates", "&ldquo;Spotlight flash &mdash; 15% off this weekend&rdquo;", "products + discount"],
    ["Friday is your quietest day", "&ldquo;Run a Friday flash, 6pm&ndash;midnight&rdquo;", "timing"],
    ["A past flash sold out in 2 hours", "&ldquo;Run that one again&rdquo;", "the whole sale"],
    ["A whole section is overstocked", "&ldquo;20% off all of Dry &amp; Pantry&rdquo;", "products + discount"],
], [50*mm, 78*mm, 33*mm])]
story += [panel([
    p("<b>The honesty rule:</b> every number is <i>measured from your real orders</i> &mdash; never invented. A "
      "brand-new shop with too little data sees the plain goals instead, with no made-up advice. And the wizard "
      "never suggests something the flash engine cannot actually do (see Part 3).", small_st),
], bg=TEASOFT, border=TEA)]

story += [p("The flow — four small screens", h2_st)]
story += [p("Forks and extra rules appear <b>only</b> when relevant. Progress is shown as gentle dots &mdash; "
            "never a lying &ldquo;Step 5 of 9.&rdquo;", body_st)]
story += [screen("1", "What&rsquo;s on sale", [
    "<b>Pick the products.</b> Tick them one by one, choose <b>a whole section</b>, or grab <b>your best "
    "sellers</b> / <b>slow movers</b> in one tap",
    "A running tally (&ldquo;12 selected&rdquo;) so a big sale never feels lost",
    "<i>One product, quick</i> from the front door lands you here with a single item already chosen",
])]
story += [Spacer(1, 5), screen("2", "The discount", [
    "<b>How much off?</b> &mdash; Percent off (the default for many) · Money off each · Set one price (for a "
    "single product)",
    "A live table: each product&rsquo;s <b>was &rarr; now</b> and what the shopper saves &mdash; computed for you",
    "<b>Round to nice prices</b> is on by default; anything not actually cheaper is flagged and left out",
])]
story += [Spacer(1, 5), screen("3", "When &amp; how many", [
    "<b>How long?</b> &mdash; Tonight · This weekend · Next 24 hours · 3 days · Pick exact times. Shown back in "
    "plain words (&ldquo;Starts Fri 18:00, ends Sun 23:59&rdquo;)",
    "<b>Limit how many at this price?</b> &mdash; No limit, or a number (adds an &ldquo;almost gone&rdquo; bar)",
    "<b>Can shoppers also use a coupon on top?</b> &mdash; one plain choice that replaces the &ldquo;no coupon on "
    "flash&rdquo; jargon, with the real effect shown",
])]
story += [Spacer(1, 5), screen("4", "Review", [
    "A live preview of the <b>real flash card</b> the shopper sees &mdash; struck-through price, countdown, stock bar",
    "A one-line plain summary + the <b>smart heads-up</b> (Part 2)",
    "Three honest buttons: <b>Save as draft</b> · <b>Schedule it</b> · <b>Turn on now</b>",
    "An <b>&ldquo;open the full editor&rdquo;</b> door on every screen &mdash; the wizard is the simple mode, not a cage",
])]

story += [p("Every setting → where it lives (nothing dropped)", h2_st)]
story += [make_table([
    ["Setting (today)", "Plain name", "Treatment", "Where"],
    ["product (one only)", "What&rsquo;s on sale", "<b>Pick many at once</b> &mdash; section / best sellers / one by one", "1"],
    ["flash_price", "The new price", "<b>Set a percent, math done for you</b> (or &yen; off / one price); rounded", "2"],
    ["flash_starts_at", "When it starts", "Plain time &rarr; exact start; blank = starts now", "3"],
    ["flash_ends_at", "When it ends", "Plain time &rarr; exact end; required, a past time is blocked", "3"],
    ["flash_stock_limit", "Limit at this price", "&ldquo;No limit&rdquo; default; a number adds the &ldquo;almost gone&rdquo; bar", "3"],
    ["no_coupon_on_flash", "Coupon on top?", "<b>One plain choice</b> &mdash; stack it, or flash price is final", "3"],
    ["flash_sold", "Sold counter", "Not asked &mdash; resets to zero on save; the heads-up explains it", "auto"],
    ["(turn on / schedule / draft)", "Go live", "<b>Draft</b> · <b>Schedule</b> (upcoming teaser) · <b>Turn on now</b>", "4"],
], [40*mm, 27*mm, 75*mm, 19*mm])]

story += [p("Plain words, not jargon", h2_st)]
story += [p("The whole point is that a non-native English speaker can read it once and understand. Short words, "
            "no terms.", body_st)]
story += [make_table([
    ["The old form said", "The wizard says"],
    ["Flash price &yen; (per product)", "How much off? &mdash; 20%; we work out each new price"],
    ["Stock limit", "Limit how many at this price (blank = no limit)"],
    ["No coupon on flash", "Can shoppers also use a coupon on top? &mdash; yes / no, flash price is final"],
    ["Starts at / Ends at (date &amp; time)", "How long? &mdash; Tonight · This weekend · 24 hours · Pick exact"],
    ["(you do the discount math)", "Set the percent; the new prices are worked out for you"],
], [70*mm, 91*mm])]

story += [p("Safety nets for beginners", h2_st)]
story += [bullets([
    "<b>Not a discount &rarr; stopped.</b> If a &ldquo;flash&rdquo; price is not below the regular price, the "
    "engine ignores it &mdash; so the wizard catches it first and skips that product with a plain note.",
    "<b>Brand-new shop, no sales yet</b> &rarr; the &ldquo;ideas&rdquo; row stays quiet; the plain goals carry "
    "the flow. No made-up advice.",
    "<b>Never an error &mdash; prevent it.</b> A percent over 100 is capped; an end time in the past, or before "
    "the start, is blocked with a plain message.",
    "<b>Draft-first, nothing goes live by accident.</b> Nothing is written until you choose Schedule or Turn on; "
    "close the wizard and nothing happened.",
    "<b>&ldquo;Open the full editor&rdquo; on every screen</b> &mdash; the wizard is the simple mode, not a wall.",
])]

# ══ PART 2 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART TWO — WHEN SALES & COUPONS ALREADY EXIST", "The smart heads-up")
story += [panel([
    p("<b>A real shop is never empty.</b> The moment that separates a toy wizard from a real one is what happens "
      "when you start a flash while other sales and coupons are already live. Before you turn anything on, the "
      "wizard reads your current flash sales and coupons and explains &mdash; in plain words &mdash; how the new "
      "one will behave next to them.", body_st),
], bg=TEASOFT, border=TEA)]

story += [p("Every situation, in plain words", h2_st)]
story += [p("Grounded in exactly how the flash engine resolves things today &mdash; not invented behaviour.", body_st)]
story += [make_table([
    ["Situation", "What the system really does", "What the wizard says"],
    ["The flash price is not below the regular price",
     "The engine ignores it &mdash; flash only applies when it is actually cheaper",
     "&ldquo;This is not a discount &mdash; &yen;24 is the same as the regular price. Lower it or skip it.&rdquo;"],
    ["A product is already on a flash sale",
     "There is one flash window per product; saving overwrites it",
     "&ldquo;Medjool Dates is already on flash until Sat. Saving replaces that window.&rdquo;"],
    ["A coupon is live and stacking is allowed",
     "Flash and coupon stack &mdash; the coupon comes off the flash-reduced price",
     "&ldquo;With SAVE10, a &yen;73 item becomes &yen;65.70 &mdash; about 30% off in total. OK?&rdquo;"],
    ["You choose &lsquo;flash price is final&rsquo;",
     "That line is removed from the coupon&rsquo;s base, so coupons skip it",
     "&ldquo;Coupons will not apply to these items. The flash price is what they pay.&rdquo;"],
    ["This product had a flash before",
     "The &lsquo;sold&rsquo; counter resets to zero when the price or window changes",
     "&ldquo;The sold count starts again from zero, so a stock limit counts this run only.&rdquo;"],
    ["You set it to start later",
     "A future start shows as &lsquo;upcoming&rsquo; &mdash; a teaser, charging nothing yet",
     "&ldquo;Until Friday it shows a &lsquo;starts soon&rsquo; badge. It is not hidden.&rdquo;"],
    ["You set a stock limit",
     "When the limit sells out, the flash ends early &mdash; clock or stock, whichever first",
     "&ldquo;Ends when the timer runs out or 50 are sold, whichever comes first.&rdquo;"],
    ["End time is in the past, or before the start",
     "The flash would never apply",
     "Blocked: &ldquo;That time has passed&rdquo; / &ldquo;The end must be after the start.&rdquo;"],
    ["A product has paid options (e.g. +&yen;5 spice)",
     "The option price is added on top of the flash price",
     "&ldquo;The discount is on the base item; a chosen extra still adds on top.&rdquo;"],
    ["You choose &lsquo;Turn on now&rsquo;",
     "Every matching product drops to the flash price immediately, for everyone",
     "&ldquo;From now on shoppers pay the flash price on these 12 products.&rdquo;"],
], [37*mm, 60*mm, 64*mm], font=8.4)]

story += [p("How the smart heads-up decides what to warn about", h2_st)]
story += [p("It does not just <i>list</i> what is running &mdash; it works out, from your live sales and coupons, "
            "where the new flash collides:", body_st)]
story += [bullets([
    "<b>&ldquo;3 of these are already on flash&rdquo;</b> &mdash; it checks every product you picked against live "
    "windows and offers to show you which ones will be replaced.",
    "<b>&ldquo;With SAVE10, the real price is &yen;65.70&rdquo;</b> &mdash; it folds your live coupons into the "
    "preview, so the stacking surprise is shown before you turn it on, not discovered at checkout.",
    "<b>&ldquo;Jackfruit Chips was left out&rdquo;</b> &mdash; it names the products the cut would not actually "
    "lower, so a fake discount never reaches a shopper.",
])]
story += [p("<b>One honesty note carried from the engine:</b> when &ldquo;flash price is final&rdquo; is on, the "
            "mini-app preview of a coupon can briefly over-show the discount until the app sends the "
            "coupon-eligible subtotal &mdash; but the <i>amount actually charged is always correct</i>. The wizard "
            "says so plainly rather than pretending the edge case does not exist.", small_mut)]

# ══ PART 3 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART THREE — HONEST LIMITS + THE BUILD", "What it is, and what comes next")

story += [p("What it should not promise yet", h2_st)]
story += [p("These are real seller wishes the flash engine cannot do today. The wizard deliberately <b>does "
            "not</b> offer them, so it never makes a promise that quietly fails &mdash; each is a future "
            "backend job:", body_st)]
story += [bullets([
    "<b>Repeating flash sales</b> (&ldquo;every Friday&rdquo;) &mdash; a product holds one window at a time; there "
    "is no recurrence. The wizard can set up the next one, but it cannot make it repeat by itself.",
    "<b>Buy-one-get-one / bundle flash</b> &mdash; a flash is a single-line price cut, not a &ldquo;buy X get "
    "Y&rdquo; rule.",
    "<b>A section that auto-includes new products</b> &mdash; the wizard flashes the exact products you pick; a "
    "product added to that section <i>after</i> you save does not join on its own.",
    "<b>A &ldquo;below cost&rdquo; guard</b> &mdash; the shop stores the selling price, not the cost, so the wizard "
    "cannot warn that a discount dips under your margin. (Add a cost field later and this becomes possible.)",
    "<b>Tiered flash</b> (&ldquo;first 10 at 50%, next 20 at 30%&rdquo;) &mdash; there is one price and one optional "
    "stock cap per product.",
])]

story += [p("One honest limit: there is no &lsquo;draft&rsquo; switch for a flash", h2_st)]
story += [panel([
    p("<b>A coupon has an on/off flag; a flash does not.</b> A flash is defined purely by its price and its time "
      "window, so &ldquo;draft-first&rdquo; here means something slightly different, and the wizard is honest "
      "about it:", body_st),
    p("<b>Save as draft</b> keeps the prepared sale in the wizard and writes <i>nothing</i> to the shop &mdash; "
      "safe, but it lives only until you come back to it. <b>Schedule it</b> writes a real <i>upcoming</i> sale "
      "(a visible &lsquo;starts soon&rsquo; teaser) that you can undo any time with Clear. <b>Turn on now</b> "
      "makes it live. <b>Recommended small add:</b> a tiny &lsquo;parked flash&rsquo; store so a draft can be "
      "saved and resumed later &mdash; a small backend change, flagged here, not built in this round.", small_st),
], bg=PANEL, border=BRASS)]

story += [p("What is reused vs. new", h2_st)]
story += [p("<b>Reused (low risk &mdash; already built):</b> the whole flash engine (active / upcoming / ended "
            "states, &ldquo;is it really cheaper&rdquo;, the sold counter, the coupon-block rule), the product "
            "picker that the form already uses, the customer flash card with its badge / struck-through price / "
            "countdown / stock bar, the sales analytics behind the ideas, and the EN/CN language toggle.", body_st)]
story += [make_table([
    ["New build", "Effort"],
    ["The wizard shell + 4-screen flow + the front-door goals", "Moderate"],
    ["<b>Pick many products at once</b> (section / best sellers / multi-tick)", "Moderate"],
    ["<b>Percent &rarr; per-product price</b> math + round-to-nice + skip-not-cheaper", "Small"],
    ["Plain-time scheduling (&ldquo;this weekend&rdquo; &rarr; exact start/end)", "Small"],
    ["The live flash-card preview inside the wizard", "Moderate"],
    ["The smart heads-up (read live flashes + coupons, explain collisions)", "Moderate"],
    ["Ideas-from-your-sales (read analytics, rank, phrase)", "Moderate"],
    ["A batch save endpoint, so many products go live as one all-or-nothing action", "Small (backend)"],
], [130*mm, 31*mm])]
story += [p("<b>Note on the batch save:</b> there is no multi-product flash endpoint today, so the wizard would "
            "either save each product in turn (simple, works now) or call one small new batch endpoint (cleaner, "
            "and all-or-nothing if a save fails). Either way the per-product save logic is unchanged.", small_mut)]

story += [p("Suggested build order", h2_st)]
story += [p("<b>v1 &mdash; the spine:</b> front-door goals &rarr; the 4 screens &rarr; <b>pick many + percent "
            "math</b> &rarr; plain-time scheduling &rarr; live card preview &rarr; the smart heads-up "
            "(replace / stack / not-cheaper) &rarr; draft / schedule / turn-on. This alone turns &ldquo;repeat "
            "the form fifteen times&rdquo; into one guided sale.", body_st)]
story += [p("<b>Fast-follow:</b> ideas-from-your-sales (the advisor), the &ldquo;just say it&rdquo; describe box, "
            "and the small backend extras &mdash; the batch save endpoint and the &lsquo;parked flash&rsquo; "
            "draft store.", body_st)]

story += [rule(BRASS, 1.0, 10, 5)]
story += [p("The Simple Flash Sale Wizard turns a one-product-at-a-time form into a single guided sale across "
            "many products &mdash; and, because it reads your live sales and coupons, it gives advice instead of "
            "just taking input.", end_st)]

# ══ THE SCREENS ════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("THE SCREENS", "What it looks like")
story += [p("Mockups in the Full Circle backend palette (Ink / Brass / Tea, IBM Plex). The desktop flow has a "
            "step rail and a live preview that builds as you go; the same flow fits a phone for operators on the "
            "move.", body_st)]
story += [Spacer(1, 6), p("Desktop flow — screen by screen", h3_st)]
with open("scripts/flash_pc_manifest.json", encoding="utf-8") as _f:
    _pc = json.load(_f)
for _m in _pc:
    story += [KeepTogether([
        framed_shot("scripts/flash_pc_%s.png" % _m["slug"], 165*mm),
        p(_m["caption"], cap_st),
    ]), Spacer(1, 11)]

story += [PageBreak(), p("Phone flow — the same steps in your pocket", h3_st)]
story += [p("Each step on a phone, thumb-friendly &mdash; for operators running a flash sale on the move.", small_mut), Spacer(1, 8)]
with open("scripts/flash_ph_manifest.json", encoding="utf-8") as _f:
    _ph = json.load(_f)
_PCOLS = 3
_prows = []
for _i in range(0, len(_ph), _PCOLS):
    _chunk = _ph[_i:_i + _PCOLS]
    _cells = [[framed_shot("scripts/flash_ph_%s.png" % _m["slug"], 44*mm), p(_m["caption"], cap_st)]
              for _m in _chunk]
    while len(_cells) < _PCOLS:
        _cells.append("")
    _prows.append(_cells)
_pgt = Table(_prows, colWidths=[(170/3.0)*mm] * _PCOLS)
_pgt.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 13),
    ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
]))
story += [_pgt]

# ── Build ──────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=20*mm,
    title="The Simple Flash Sale Wizard — Plan", author="Full Circle",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("WROTE", OUT, os.path.getsize(OUT), "bytes")
