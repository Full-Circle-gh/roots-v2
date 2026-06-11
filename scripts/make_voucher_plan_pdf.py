# -*- coding: utf-8 -*-
"""Generate the Simple Voucher Wizard plan as a branded PDF (Full Circle: Ink/Brass/Tea).

Parts:
  Part 1 — The wizard (front door, ideas-from-sales, the 4-screen flow, the 4 honest paths)
  Part 2 — When coupons already exist (the scenario/conflict matrix + the smart heads-up)
  Part 3 — One honest limit + the build
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

OUT = "Simple-Voucher-Wizard-Plan.pdf"

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
    canvas.drawCentredString(A4[0]/2, 9.5*mm, "Simple Voucher Wizard — Plan")
    canvas.drawRightString(A4[0]-20*mm, 9.5*mm, "Page %d" % doc.page)
    canvas.restoreState()

story = []

# ══ COVER ══════════════════════════════════════════════════════════════════
story += [
    p("PRODUCT DESIGN PLAN", kicker),
    p("The Simple Voucher Wizard", title_st),
    p("A guided, plain-language way to make a coupon &mdash; built for sellers who are not techies, "
      "and for whom English is a second language.", subtitle),
    rule(BRASS, 1.4, 6, 10),
]
story += [panel([
    p("<b>The whole idea in one line:</b> pick a goal, answer a few plain questions, see the real coupon card, save.", body_st),
    p("The wizard is a friendly front-door to the <b>same</b> coupon the full Marketing page already edits &mdash; "
      "never a separate system, so anything made here stays fully editable later.", small_st),
    p("Two promises run through it: <b>plain words</b> (no jargon, short sentences) and <b>draft-first</b> "
      "(nothing goes live by accident &mdash; you choose when to turn it on).", small_mut),
], bg=TEASOFT, border=TEA)]
story += [Spacer(1, 12)]

# ══ PART 1 ═════════════════════════════════════════════════════════════════
story += part_band("PART ONE — THE WIZARD", "Make a coupon in a few simple steps")

story += [p("Why this is simple — the levers", h2_st)]
story += [bullets([
    "<b>Pick a goal, do not build from parts.</b> Ready-made coupon goals (welcome gift, store sale&hellip;) fill almost everything in.",
    "<b>Let the AI go first.</b> Describe the deal in one line and the wizard fills every box &mdash; you only check.",
    "<b>One plain question, not three checkboxes.</b> &ldquo;How do customers get it?&rdquo; replaces Public / Auto-grant / Auto-apply.",
    "<b>Auto-make the scary things</b> &mdash; the code is written for you (editable).",
    "<b>Smart defaults + draft-first.</b> Sensible values are pre-set; you save a draft and turn it on when ready.",
])]

story += [p("How it starts — the front door", h2_st)]
story += [p("One friendly question before any form:", body_st)]
story += [panel([
    p("<b>What do you want to do?</b>", body_st),
    p("<b>Welcome gift</b> &nbsp;·&nbsp; <b>Store sale</b> &nbsp;·&nbsp; <b>A coupon anyone can use</b> &nbsp;·&nbsp; "
      "<b>Free shipping</b> &nbsp;·&nbsp; <b>Start fresh</b> &nbsp;·&nbsp; <b>Ideas from my sales</b>", body_st),
    p("Each goal pre-fills the whole wizard, so it becomes a series of <i>confirmations</i>. Or use the "
      "<b>&ldquo;tell me your deal in words&rdquo;</b> box &mdash; type &ldquo;20 yuan off for new customers, first order&rdquo; "
      "and the AI fills it in.", small_mut),
])]

story += [p("Ideas from your sales — the blank page, solved", h2_st)]
story += [p("The hardest moment for a non-technical seller is the blank page: <i>what</i> coupon, and <i>what number?</i> "
            "Their own sales answer it. The wizard reads the shop&rsquo;s real numbers and offers a few ready-to-use ideas &mdash; "
            "each one tied to a real figure, and each one filling in a box the seller would otherwise have to guess.", body_st)]
story += [make_table([
    ["Real number from your shop", "What the wizard suggests (plain)", "Fills in"],
    ["Average order is about &yen;120", "&ldquo;&yen;20 off when you spend &yen;150&rdquo; &mdash; to grow baskets", "spend-at-least"],
    ["Many people buy once and never return", "&ldquo;&yen;15 off for past customers&rdquo; &mdash; a gentle win-back", "who gets it"],
    ["Lots of new first-time buyers", "&ldquo;A welcome gift&rdquo; &mdash; turns first orders into customers", "who gets it"],
    ["Your best past coupon: SUMMER10", "&ldquo;Run another like SUMMER10&rdquo;", "kind + amount"],
    ["A past 30%-off cost a lot for little", "&ldquo;Try 15% &mdash; still strong, keeps more margin&rdquo;", "amount"],
    ["Carts often stop near &yen;90", "&ldquo;Free shipping over &yen;100&rdquo; &mdash; to recover them", "kind / min"],
    ["About 150 coupons used a month", "&ldquo;Stop after 200 uses&rdquo; &mdash; to control spend", "total uses"],
], [44*mm, 88*mm, 29*mm])]
story += [panel([
    p("<b>The honesty rule:</b> every number is <i>measured from your real sales</i> &mdash; never invented. "
      "A brand-new shop with too little data sees the plain goals instead, with no made-up advice. And the wizard never "
      "suggests something a coupon cannot actually do (see Part 2).", small_st),
], bg=TEASOFT, border=TEA)]

story += [p("The flow — four small screens", h2_st)]
story += [p("Forks and extra rules appear <b>only</b> when relevant. Progress is shown as gentle dots &mdash; never a lying "
            "&ldquo;Step 5 of 9.&rdquo;", body_st)]
story += [screen("1", "The deal", [
    "<b>What do customers save?</b> &mdash; Money off (&yen;) · Percent off (%) · Free shipping (big tappable cards)",
    "One amount box with the unit <b>built in</b> (&ldquo;&yen; off&rdquo; or &ldquo;% off&rdquo;) &mdash; so &ldquo;does 20 mean &yen;20 or 20%?&rdquo; never happens",
])]
story += [Spacer(1, 5), screen("2", "Who gets it", [
    "<b>One plain choice</b> replaces the three confusing checkboxes: <i>Comes off by itself · Anyone can use it · A welcome gift for new customers · I choose who gets it</i>",
    "Each option says, in one line, exactly what the customer experiences",
    "The welcome-gift path adds a single yes/no: <i>&ldquo;Also show it on the home page?&rdquo;</i>",
])]
story += [Spacer(1, 5), screen("3", "Rules &amp; dates", [
    "<b>Optional</b> &mdash; smart defaults already set; the simple path skips this entirely",
    "<b>Spend at least</b> (pre-filled from your average order) · <b>Ends on</b> (empty = never) · and behind &ldquo;More rules&rdquo;: <b>each person</b> · <b>stop after</b>",
])]
story += [Spacer(1, 5), screen("4", "Review", [
    "A live preview of the <b>real coupon card</b> the customer will see",
    "A one-line plain summary + the <b>smart heads-up</b> (Part 2)",
    "Two buttons: <b>Save as draft</b> (the safe default) or <b>Save &amp; turn on</b>",
    "An <b>&ldquo;open the full editor&rdquo;</b> door on every screen &mdash; the wizard is the simple mode, not a cage",
])]

story += [p("Who gets it — one choice, four honest paths", h2_st)]
story += [p("This is the heart of the wizard. The old form exposed three raw checkboxes (Public / Auto-grant / Auto-apply) "
            "that combine into very different coupons. The wizard asks <b>one plain question</b> and sets the right flags itself:", body_st)]
story += [make_table([
    ["The seller picks", "What the customer experiences", "Set for them"],
    ["Comes off the price by itself", "Everyone, at checkout. No code to type. If two deals fit, the customer gets the better one.", "auto-apply"],
    ["Anyone can use it", "Shows in the app&rsquo;s coupon list; a code you share also works when typed.", "public + label"],
    ["A welcome gift for new customers", "Dropped into new customers&rsquo; coupons on first sign-in; they tap it at checkout.", "new-signup grant"],
    ["I choose who gets it", "Lands in the wallets of the customers you pick. No code, not listed.", "hand-grant"],
], [46*mm, 86*mm, 29*mm])]

story += [p("Every setting → where it lives (nothing dropped)", h2_st)]
story += [make_table([
    ["Setting (today)", "Plain name", "Treatment", "Where"],
    ["code", "Code", "<b>Auto-written</b>, editable (a typed code only works on a public coupon)", "4"],
    ["type", "Kind of deal", "<b>Pick a card</b>: Money off / Percent off / Free shipping", "1"],
    ["value", "How much", "One box with the unit built in (&yen; or %)", "1"],
    ["is_public / auto_grant / auto_apply", "Who gets it", "<b>One plain choice</b> &rarr; the right flags set for you", "2"],
    ["title_en / title_cn", "Label customers see", "<b>AI writes it</b> in simple EN + simple CN; needed for public coupons", "2 / 4"],
    ["min_subtotal", "Spend at least", "<b>Pre-filled from your average order</b>; blank = any order", "3"],
    ["expires_at", "Ends on", "Date picker; blank = never ends; a past date is blocked", "3"],
    ["per_customer_limit", "Each person can use it", "Default <b>1 time</b> (behind &ldquo;More rules&rdquo;)", "3"],
    ["max_uses", "Stop after", "Default <b>no limit</b>; suggest a cap from past volume", "3"],
    ["is_active", "Draft / on", "<b>Draft by default</b>; turned on at the end", "4"],
    ["description", "—", "Hidden · internal note, full editor only", "hidden"],
], [44*mm, 27*mm, 71*mm, 19*mm])]

story += [p("Plain words, not jargon", h2_st)]
story += [p("The whole point is that a non-native English speaker can read it once and understand. Short words, no terms.", body_st)]
story += [make_table([
    ["The old form said", "The wizard says"],
    ["Min subtotal &yen;", "Spend at least &yen;__ to use it (blank = any order)"],
    ["Per customer", "Each person can use it __ time(s)"],
    ["Max uses", "Stop after __ uses (blank = no limit)"],
    ["Auto-apply · Best one wins", "Comes off the price by itself"],
    ["Auto-grant · New signups", "A welcome gift for new customers"],
    ["Public · Browseable", "Anyone can use it"],
    ["Value (means &yen; or % &mdash; you must know which)", "&yen; off / % off (the unit is shown in the box)"],
], [70*mm, 91*mm])]

story += [p("Safety nets for beginners", h2_st)]
story += [bullets([
    "<b>Brand-new shop, no sales yet</b> &rarr; the &ldquo;ideas&rdquo; row stays quiet; the plain goals carry the flow. No made-up advice.",
    "<b>Single-language shop</b> &rarr; the other language&rsquo;s label box never appears.",
    "<b>Never an error &mdash; prevent it.</b> The code is auto-written; a percent over 100 is capped; an end date in the past is blocked with a plain message.",
    "<b>Draft-first, nothing goes live by accident.</b> A draft does nothing at all until you choose &ldquo;turn it on.&rdquo;",
    "<b>&ldquo;Open the full editor&rdquo; on every screen</b> &mdash; the wizard is the simple mode, not a wall.",
])]

# ══ PART 2 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART TWO — WHEN COUPONS ALREADY EXIST", "The smart heads-up")
story += [panel([
    p("<b>A real shop is never empty.</b> The moment that separates a toy wizard from a real one is what happens when "
      "you make a coupon while others are already live. Before you turn anything on, the wizard reads your current coupons "
      "and explains &mdash; in plain words &mdash; how the new one will behave next to them.", body_st),
], bg=TEASOFT, border=TEA)]

story += [p("Every situation, in plain words", h2_st)]
story += [p("Grounded in exactly how the system resolves coupons today &mdash; not invented behaviour.", body_st)]
story += [make_table([
    ["Situation", "What the system really does", "What the wizard says"],
    ["You pick a code that is already live", "It is refused &mdash; live codes are protected", "&ldquo;You already have a coupon SUMMER and it is on. Try SUMMER2, or turn the old one off.&rdquo;"],
    ["You pick a code from an old, off coupon", "It quietly brings that old one back and resets its count", "&ldquo;You used SPRING before. Saving reuses it and starts the count from zero. Use it again?&rdquo;"],
    ["A second &lsquo;comes off by itself&rsquo; deal exists", "Only the single best one applies &mdash; they never add up", "Lists them: &ldquo;Customers get the better one, not both.&rdquo;"],
    ["A customer also has their own coupon", "Whichever saves more wins; a tie keeps the customer&rsquo;s pick", "&ldquo;They still get whichever saves more.&rdquo;"],
    ["A second welcome gift exists", "New customers get both in their coupons (use one per order)", "&ldquo;New customers will get both. Turn the old one off?&rdquo;"],
    ["Who a welcome gift really reaches", "Brand-new customers only; returning ones are left out", "&ldquo;For brand-new customers. It goes into their coupons; they tap it at checkout.&rdquo;"],
    ["Is a public coupon &lsquo;secret&rsquo;?", "No &mdash; it is listed in everyone&rsquo;s coupon page", "&ldquo;Anyone can find this in the app, and a shared code also works.&rdquo;"],
    ["Percent over 100, or zero", "Capped at 100; zero saves nothing", "Box caps at 100; &ldquo;Enter how much they save.&rdquo;"],
    ["Money off bigger than the order", "Capped at the order total &mdash; never goes negative", "&ldquo;Never more than the order total.&rdquo;"],
    ["End date is in the past", "The coupon would never apply", "Blocked: &ldquo;That date has passed. Pick a later one.&rdquo;"],
    ["Free shipping that comes off by itself", "Works at checkout; the amount is known once delivery is picked", "&ldquo;Works at checkout. The amount shows once delivery is chosen.&rdquo;"],
    ["Saved as a draft", "Does nothing &mdash; not applied, not listed, not given out", "Safe by default; nothing happens until you turn it on"],
    ["You choose &lsquo;Save &amp; turn on&rsquo;", "It changes the whole shop now (or starts for future sign-ins)", "&ldquo;From now on, every order that fits gets this.&rdquo;"],
], [37*mm, 60*mm, 64*mm], font=8.4)]

story += [p("How the smart heads-up decides &lsquo;win or lose&rsquo;", h2_st)]
story += [p("For automatic deals it does not just <i>list</i> what is running &mdash; it works out, from your live coupons, "
            "where the new one actually helps:", body_st)]
story += [bullets([
    "<b>&ldquo;Your new 15% off wins on every order&rdquo;</b> &mdash; so an older, smaller automatic deal will barely be used (offer to turn it off).",
    "<b>&ldquo;This wins only on orders over &yen;150&rdquo;</b> &mdash; when the new deal has a higher minimum than an existing one.",
    "<b>&ldquo;This minimum is above your average order&rdquo;</b> &mdash; folding the sales numbers into the warning, not just the suggestion.",
])]
story += [p("Free shipping is compared fairly by valuing it at the live delivery fee, exactly as the checkout does &mdash; "
            "so the advice matches what the customer will really get.", small_mut)]

# ══ PART 3 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART THREE — ONE HONEST LIMIT + THE BUILD", "What it is, and what comes next")

story += [p("One honest limit: the &lsquo;secret code&rsquo;", h2_st)]
story += [panel([
    p("<b>A truly secret code you type is not supported today.</b> In this system, a code only works when the coupon "
      "is <i>public</i> &mdash; and a public coupon is automatically shown in everyone&rsquo;s coupon page. A private "
      "coupon has no working typed code at all; it can only be handed to the customers you pick.", body_st),
    p("<b>So for now</b> the wizard offers four honest paths, and &ldquo;a code I give out&rdquo; is the same as "
      "&ldquo;anyone can use it&rdquo; (the shared code works, but it is also listed). <b>Recommended small fix:</b> a "
      "<i>code-only</i> mode &mdash; a code that works when typed but stays hidden from the list &mdash; would add a clean "
      "fifth path. It is a small backend change, flagged here, not built in this round.", small_st),
], bg=PANEL, border=BRASS)]

story += [p("What it should not promise yet", h2_st)]
story += [p("These are real seller wishes the coupon engine cannot do today. The wizard deliberately <b>does not</b> offer "
            "them, so it never makes a promise that quietly fails &mdash; each is a future backend job:", body_st)]
story += [bullets([
    "<b>Slow-day / day-of-week deals</b> &mdash; coupons have an end date, but no day-of-week window.",
    "<b>One-product or one-category coupons</b> &mdash; discounts apply to the whole cart, not a single item.",
    "<b>Scheduled or auto-sent win-backs</b> &mdash; there is no start date or automatic trigger, only an end date.",
])]

story += [p("What is reused vs. new", h2_st)]
story += [p("<b>Reused (low risk &mdash; already built):</b> the whole coupon engine (kinds, eligibility, best-one-wins, "
            "grants, code reuse), the sales analytics that power the ideas, the AI text engine for codes and labels, and the "
            "EN/CN language toggle.", body_st)]
story += [make_table([
    ["New build", "Effort"],
    ["The wizard shell + 4-screen flow + the front-door goals", "Moderate"],
    ["&ldquo;One plain choice&rdquo; that sets the eligibility flags", "Small"],
    ["The live coupon-card preview", "Moderate"],
    ["The smart heads-up (read live coupons, explain win/lose)", "Moderate"],
    ["Ideas-from-your-sales (read analytics, AI-phrase + rank)", "Moderate"],
    ["Plain-word relabel layer + simple EN/CN label writer", "Small"],
    ["&lsquo;Code-only&rsquo; private code mode (the fifth path)", "Small (backend)"],
], [130*mm, 31*mm])]

story += [p("Suggested build order", h2_st)]
story += [p("<b>v1 &mdash; the spine:</b> front-door goals &rarr; the 4 screens &rarr; the one-plain-choice eligibility "
            "&rarr; smart defaults &rarr; live preview &rarr; the smart heads-up &rarr; draft-first. This already replaces "
            "the scary 12-field form.", body_st)]
story += [p("<b>Fast-follow:</b> ideas-from-your-sales (the advisor), the &ldquo;describe your deal in words&rdquo; box, "
            "and the small &lsquo;code-only&rsquo; backend mode for a true secret code.", body_st)]

story += [rule(BRASS, 1.0, 10, 5)]
story += [p("The Simple Voucher Wizard turns a 12-field form into a few plain questions &mdash; and, because it reads your "
            "live coupons and your real sales, it gives advice instead of just taking input.", end_st)]

# ══ THE SCREENS ════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("THE SCREENS", "What it looks like")
story += [p("Mockups in the Full Circle backend palette (Ink / Brass / Tea, IBM Plex). The desktop flow has a step rail and "
            "a live preview that builds as you go; the same flow fits a phone for operators on the move.", body_st)]
story += [Spacer(1, 6), p("Desktop flow — screen by screen", h3_st)]
with open("scripts/voucher_pc_manifest.json", encoding="utf-8") as _f:
    _pc = json.load(_f)
for _m in _pc:
    story += [KeepTogether([
        framed_shot("scripts/voucher_pc_%s.png" % _m["slug"], 165*mm),
        p(_m["caption"], cap_st),
    ]), Spacer(1, 11)]

story += [PageBreak(), p("Phone flow — the same steps in your pocket", h3_st)]
story += [p("Each step on a phone, thumb-friendly &mdash; for operators making a coupon on the move.", small_mut), Spacer(1, 8)]
with open("scripts/voucher_ph_manifest.json", encoding="utf-8") as _f:
    _ph = json.load(_f)
_PCOLS = 3
_prows = []
for _i in range(0, len(_ph), _PCOLS):
    _chunk = _ph[_i:_i + _PCOLS]
    _cells = [[framed_shot("scripts/voucher_ph_%s.png" % _m["slug"], 44*mm), p(_m["caption"], cap_st)]
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
    title="The Simple Voucher Wizard — Plan", author="Full Circle",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("WROTE", OUT, os.path.getsize(OUT), "bytes")
