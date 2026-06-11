# -*- coding: utf-8 -*-
"""Generate the Simple Product Wizard plan as a branded PDF (Full Circle: Ink/Brass/Tea).

Two halves:
  Part 1 — Add: the Simple Product Wizard
  Part 2 — Finish: the missing-info backfill ("Finish your products")
"""
import os
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

OUT = "Simple-Product-Wizard-Plan.pdf"

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

# ── Page furniture ─────────────────────────────────────────────────────────
def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.6)
    canvas.line(20*mm, 14*mm, A4[0]-20*mm, 14*mm)
    canvas.setFont(REG, 8); canvas.setFillColor(MUTED)
    canvas.drawString(20*mm, 9.5*mm, "Full Circle · Mini App Backend")
    canvas.drawCentredString(A4[0]/2, 9.5*mm, "Simple Product Wizard — Plan")
    canvas.drawRightString(A4[0]-20*mm, 9.5*mm, "Page %d" % doc.page)
    canvas.restoreState()

story = []

# ══ COVER ══════════════════════════════════════════════════════════════════
story += [
    p("PRODUCT DESIGN PLAN", kicker),
    p("The Simple Product Wizard", title_st),
    p("A guided, plain-language &ldquo;add a product&rdquo; flow for non-technical sellers.", subtitle),
    rule(BRASS, 1.4, 6, 10),
]
story += [panel([
    p("<b>The whole idea in one line:</b> capture once, confirm, publish.", body_st),
    p("The wizard is a friendly front-door to the <b>same</b> product the full editor already edits "
      "&mdash; never a separate system, so anything created here stays fully editable later.", small_st),
    p("This plan has <b>two halves</b>: <b>Part 1 — Add</b> (the wizard) and "
      "<b>Part 2 — Finish</b> (backfilling the gaps so the catalog reaches 100%).", small_mut),
], bg=TEASOFT, border=TEA)]
story += [Spacer(1, 12)]

# ══ PART 1 ═════════════════════════════════════════════════════════════════
story += part_band("PART ONE — ADD", "The Simple Product Wizard")

story += [p("Why this is simple — the 5 levers", h2_st)]
story += [bullets([
    "<b>Stop asking for what a machine can get</b> — snap a label or paste a blurb, the AI fills the rest.",
    "<b>Pick from lists, never type</b> the structured things (category, size, unit).",
    "<b>Auto-generate the scary things</b> — the product code (SKU) especially.",
    "<b>Yes/No gates + smart defaults</b>; hide everything a beginner doesn&rsquo;t need.",
    "<b>Capture-then-confirm, not fill-then-enhance</b> — the AI goes first, you just check its work.",
])]

story += [p("How it starts — the front door", h2_st)]
story += [p("One friendly question before any form:", body_st)]
story += [panel([
    p("<b>How do you want to start?</b>", body_st),
    p("<b>Snap the label</b> &nbsp;·&nbsp; <b>Paste a description</b> &nbsp;·&nbsp; "
      "<b>Copy a product I already sell</b> &nbsp;·&nbsp; <b>Start from scratch</b>", body_st),
    p("The first three pre-fill almost everything; the wizard then becomes a series of <i>confirmations</i>. "
      "Only &ldquo;Start from scratch&rdquo; shows blank fields.", small_mut),
])]

story += [p("The flow — a simple product is 4 screens", h2_st)]
story += [p("Forks (sizes, bundle) appear <b>only</b> when relevant. Progress is shown as adaptive dots / "
            "&ldquo;almost done&rdquo; — never a lying &ldquo;Step 3 of 7.&rdquo;", body_st)]
story += [screen("1", "What it is", [
    "Name · Category (pre-suggested from the list) · Photo(s)",
    "<i>All pre-filled if they snapped/pasted — they just confirm and can swap in a nicer photo.</i>",
])]
story += [Spacer(1, 5), screen("2", "Price &amp; stock", [
    "<b>Top question (the one real fork):</b> &ldquo;Does it come in different sizes/options?&rdquo; → <b>No / Yes</b>",
    "<b>No</b> → Price · How many in stock · <i>(product code auto-filled, small, editable)</i>",
    "<b>Yes</b> → opens the <b>Sizes step</b>; the single price/stock is replaced by per-size rows",
    "<i>On sale?</i> and <i>Ships where?</i> sit here as pre-set chips from your store&rsquo;s usual pattern — tap to change, not questions.",
])]
story += [Spacer(1, 5), screen("3", "Details", [
    "One paste/snap box already did the work → facts come in pre-filled: Origin · Ingredients · Storage · Shelf life · Serving · Weight",
    "<b>Allergens</b> (&ldquo;free of&hellip;&rdquo;) — AI suggests from the ingredients, <b>you tick to confirm</b>",
    "<b>Story</b> (the marketing description) — optional, the leftover prose from the paste",
])]
story += [Spacer(1, 5), screen("4", "Review &amp; publish", [
    "Live preview of the finished product page",
    "The <b>look</b> lives here as a switch, not a step: &ldquo;Here&rsquo;s your page — [Designed ✓] [switch to plain]&rdquo; (designed is the default)",
    "Green readiness check: ✓ Photo &nbsp; ✓ Price &nbsp; ✓ Category — ready!",
    "<b>Put it in the shop</b> · or <b>Save as draft, keep editing</b> · or <b>Save &amp; add another</b>",
])]
story += [Spacer(1, 7), p("The two forks", h3_st)]
story += [bullets([
    "<b>Sizes step</b> (when &ldquo;yes&rdquo;) — rows of <i>option name · price (pre-filled) · stock · code (auto)</i>, &ldquo;+ Add another size,&rdquo; and an &ldquo;All the same price?&rdquo; shortcut.",
    "<b>Bundle add-on</b> (optional, before review) — &ldquo;Offer this in a bundle with other products? (skip)&rdquo; → pick products + a bundle price. Demoted here because it&rsquo;s rare and changes nothing about the product itself.",
])]

story += [p("Every product field → where it lives (nothing dropped)", h2_st)]
field_rows = [
    ["Field (today)", "Plain name", "Treatment", "Where"],
    ["name_en / name_cn", "Name", "Type one language, AI fills the other", "1"],
    ["images (≤8)", "Photos", "Upload, or reuse the snapped label; AI picks the clearest as main", "1"],
    ["top_category / subcategory", "Section", "<b>Pick from list</b> (starter set if store is empty)", "1"],
    ["sell_price", "Price", "One number", "2"],
    ["sku", "Product code", "<b>Auto-filled, editable</b> (migrators type their own)", "2"],
    ["<i>(variants)</i>", "Sizes / options", "Yes/No fork → per-size price/stock/code", "Sizes"],
    ["compare_at_price", "Original price", "&ldquo;On sale?&rdquo; yes reveals it; default off", "2"],
    ["ship_modes", "Ships where", "Default <b>everywhere</b> (store pattern); toggle <b>local-only</b>", "2"],
    ["stock by location", "In stock", "&ldquo;How many?&rdquo; per store <i>(here only if no sizes)</i>", "2 / Sizes"],
    ["product_facts (origin, ingredients, storage, shelf life, serving)", "Details", "<b>Paste/snap-fill</b>, then review", "3"],
    ["weight", "Weight", "Number + <b>unit dropdown</b> (g/kg/ml/pcs); AI-extracted", "3"],
    ["free_of", "Free of (allergens)", "AI suggests → <b>human confirms</b> (your guarantee)", "3"],
    ["description_en / cn", "Story", "Optional; leftover prose from paste", "3"],
    ["use_block_design", "Page look", "<b>Default designed</b>; switch on review", "4"],
    ["is_published", "In shop / draft", "Decided at the end", "4"],
    ["status", "—", "Hidden · default <b>Active</b>", "hidden"],
    ["tags (badge)", "—", "Hidden · default <b>Auto</b>", "hidden"],
    ["is_market / is_batch_made / is_restock_only", "—", "Hidden · default <b>off</b> (Roots-specific)", "hidden"],
    ["low_stock_threshold", "—", "Hidden · <b>store default</b>", "hidden"],
    ["notes", "—", "Not in wizard — full editor only", "—"],
]
story += [make_table(field_rows, [38*mm, 26*mm, 78*mm, 19*mm])]

story += [p("New-user safety nets (the edge cases that actually bite)", h2_st)]
story += [bullets([
    "<b>Empty store → no categories to pick.</b> The first-ever product offers a small <b>starter set</b>, or a one-tap &ldquo;create this section now.&rdquo;",
    "<b>Single-language store</b> → the other language&rsquo;s boxes never appear.",
    "<b>Never an error — prevent it.</b> Auto-code kills &ldquo;SKU required&rdquo;; a clash gets a gentle inline nudge. No photo? → &ldquo;Add one, or save as draft.&rdquo;",
    "<b>Draft-first, nothing lost.</b> A draft is created as soon as there&rsquo;s a name; it only goes live at Screen 4.",
    "<b>&ldquo;Open the full editor&rdquo; door on every screen</b> — the wizard is the <i>simple mode</i>, not a cage.",
    "<b>Allergen claims = the seller&rsquo;s promise.</b> Only pre-tick when ingredients look complete; otherwise &ldquo;tick only what you can guarantee.&rdquo;",
])]

story += [p("What already exists vs. what&rsquo;s new", h2_st)]
story += [p("<b>Reused (low risk — the engine is built):</b> the fact boxes + &ldquo;auto-fill from text&rdquo; AI, "
            "the <b>Design: On</b> compose step, <b>Duplicate</b> (powers Copy-existing), per-store stock, "
            "the category lists, the SKU-uniqueness check.", body_st)]
story += [make_table([
    ["New build", "Effort"],
    ["The wizard shell + 4-screen flow + the front-door chooser", "Moderate"],
    ["Store-pattern defaults (learn shipping/allergens/category from your products)", "Moderate"],
    ["Live preview that fills as you go", "Moderate"],
    ["Starter categories for empty stores", "Small"],
    ["Plain-word relabel layer", "Small"],
    ["Snap-the-label (vision) — the &ldquo;whoa&rdquo; feature", "Bigger"],
], [130*mm, 31*mm])]

story += [p("Suggested build order", h2_st)]
story += [p("<b>v1 — magic but buildable:</b> Front-door chooser → <b>Copy-existing</b> + <b>Paste-to-fill</b> "
            "(mostly there) → the 4-screen spine → <b>store-pattern defaults</b> → <b>single-language hide</b> → "
            "<b>live preview</b> + <b>plain words</b> + <b>skip-everything</b> → <b>starter categories</b>.", body_st)]
story += [p("<b>Fast-follow:</b> <b>Snap-the-label vision</b> (the hero), per-store nuance, "
            "&ldquo;Save &amp; add another&rdquo; momentum loop.", body_st)]

# ══ PART 2 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART TWO — FINISH", "Finish your products")
story += [panel([
    p("<b>The other half of the loop.</b> The wizard is deliberately permissive (&ldquo;skip — add later&rdquo;), "
      "so it <i>creates</i> gaps by design. This is the cleanup surface that pays the debt down — so "
      "&ldquo;add later&rdquo; never becomes &ldquo;never&rdquo; — and gets every product to 100%.", body_st),
], bg=TEASOFT, border=TEA)]

story += [p("The one move that makes it work: approve, don&rsquo;t type", h2_st)]
story += [p("If this page just lists gaps and asks people to type, nobody with 200 products ever finishes. "
            "The unlock: <b>most gaps, the AI can propose an answer to</b> — the user just taps ✓. "
            "So split every gap into two kinds:", body_st)]
story += [make_table([
    ["AI can propose — just approve", "Only you know — you supply"],
    ["Storage · shelf life · serving · ingredients · weight · the other language (translate) · "
     "allergens (from ingredients) · category (from the name) · story (from the facts)",
     "Price · a real photo · true origin · the real product code"],
], [95*mm, 66*mm])]
story += [p("A &ldquo;Let AI fill every gap it can → you review&rdquo; button can take a catalog from 60% to 95% "
            "in one pass. The human then only deals with the handful a machine genuinely can&rsquo;t know.", small_mut)]

story += [p("The interaction: a gap queue, batched by field", h2_st)]
story += [p("Not product-by-product (too much context-switching). Lead with <b>one field across many products</b> "
            "— a fast rhythm where you stay in one headspace:", body_st)]
story += [panel([
    p("&ldquo;30 products have no storage info. Here are the AI&rsquo;s suggestions — approve them all, or fix as you go.&rdquo;", body_st),
    p("Each card: thumbnail + name · the field · the <b>editable AI suggestion</b> · "
      "[✓ Looks good] [Edit] [Doesn&rsquo;t apply] [Skip]. Next. Thumb-friendly, progress dots. "
      "<b>Bulk-approve</b> a whole field at once. (You can still open a single product and fill all its gaps — "
      "but batch-by-field is the power mode.)", small_st),
])]

story += [p("What counts as &ldquo;missing&rdquo; — and the rules that keep it honest", h2_st)]
story += [bullets([
    "<b>&ldquo;Doesn&rsquo;t apply&rdquo; must reach 100%.</b> A service has no shelf life; some products have no allergens to declare. If there&rsquo;s no way to say N/A, the meter never hits 100% and people tune it out. Marking N/A satisfies completeness <b>and is remembered</b>, so it never asks again.",
    "<b>Only shopper-facing fields count.</b> It covers the full set <i>including ones the wizard skipped</i> (weight, badge, shipping, allergens), but <b>never</b> internal toggles (internal notes, low-stock threshold, Roots-only flags). Otherwise the score punishes you for things shoppers never see.",
    "<b>It descends into variants.</b> A size with no price or no stock is a real, sellable-blocking gap.",
])]

story += [p("Lead with impact, not volume", h2_st)]
story += [make_table([
    ["Priority", "What"],
    ["<font color='#b2564b'><b>Can&rsquo;t sell well — do first</b></font>", "Missing photo, price, or category. <i>&ldquo;5 products need your attention.&rdquo;</i>"],
    ["<font color='#b08d4a'><b>Worth polishing — the AI batch</b></font>", "Missing facts, story, weight, allergens."],
], [62*mm, 99*mm])]
story += [p("A per-product completeness % and a store-wide meter that <b>climbs as you go</b> — gentle motivation, "
            "not a scold. <b>Decided:</b> the meter is <i>gently visible</i> — a small &ldquo;87%&rdquo; on the "
            "Products page that climbs, never a nag.", small_mut)]

story += [p("It reuses the wizard — and frees it to be lazier", h2_st)]
story += [p("Same field definitions, same plain-word labels, same AI (extract-facts / compose / translate), same save "
            "endpoints, even the same snap/paste on-ramps applied to <i>existing</i> products. And because this safety "
            "net exists, the <b>wizard can be even more permissive</b> — &ldquo;just name + photo + price, do the rest "
            "later&rdquo; — knowing nothing falls through the cracks.", body_st)]

story += [p("It already has a real job at Roots", h2_st)]
story += [p("~102 product descriptions were imported from the old store, but those products mostly <i>don&rsquo;t have "
            "the structured facts</i> (origin / storage / shelf life as boxes) — the info is trapped in prose. This page "
            "is exactly the tool to <b>bulk-extract structured facts from existing descriptions</b> with AI, review, done. "
            "Day-one work, not hypothetical.", body_st)]

story += [p("A v1 that&rsquo;s mostly AI + a queue", h2_st)]
story += [bullets([
    "A <b>completeness score</b> + a banner on the Products page: &ldquo;23 products are missing info — finish them.&rdquo;",
    "The <b>gap queue</b>, batched by field, with <b>AI-suggested answers</b> and <b>bulk-approve</b>.",
    "<b>Easy photo upload</b> + a clear <b>price/category</b> nudge for the human-only gaps.",
    "<b>&ldquo;Doesn&rsquo;t apply&rdquo;</b> with memory.",
])]

story += [rule(BRASS, 1.0, 10, 5)]
story += [p("&ldquo;Finish your products&rdquo; turns &ldquo;add later&rdquo; into a catalog that actually reaches 100%.", end_st)]

# ══ PART 3 ═════════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("PART THREE — IMPORT", "Bring your products in")
story += [panel([
    p("<b>The switching-platforms moment.</b> A seller arrives with 200 products already living somewhere else. "
      "The rule: <b>they never reformat their data to fit us — we read whatever they have, they confirm once, it lands "
      "as drafts, and Part 2 finishes the gaps.</b> Import is just the wizard at scale, on the same engine.", body_st),
], bg=TEASOFT, border=TEA)]

story += [p("If they have a sheet (any structure)", h2_st)]
story += [p("AI-mapped import — five steps, and the only human step is one confirmation:", body_st)]
story += [bullets([
    "<b>Drop the file</b> — any .xlsx/.csv, any column order or names (&ldquo;Title,&rdquo; &ldquo;Item,&rdquo; English or Chinese headers), messy or clean.",
    "<b>AI maps their columns → our fields</b>; you <b>confirm the mapping once</b> (not per row). This is what makes it correct <i>regardless</i> of structure — the AI bends to their layout, the human sanity-checks the map.",
    "<b>Clean &amp; normalize</b> — strip ¥/$, parse &ldquo;200 g&rdquo; → 200 + unit, split combined cells, detect EN vs CN.",
    "<b>Preview as draft products</b> — scan, fix inline, see flags (&ldquo;row 14 has no price,&rdquo; &ldquo;this ¥4500 looks like a typo&rdquo;).",
    "<b>Import as DRAFTS</b> — never auto-publish, with one-click <b>undo this import</b>.",
])]
story += [p("The three things that actually go wrong in real sheets — and the fix", h3_st)]
story += [bullets([
    "<b>Images.</b> Sheets rarely hold real photos. URLs → we fetch them; filenames → <b>&ldquo;drag your images folder, we match by filename/SKU&rdquo;</b>; nothing → photos become the top human-only gap in Part 2.",
    "<b>Variants.</b> Sizes appear as <i>multiple rows</i> or as <i>columns</i> — AI detects which and groups them; you confirm.",
    "<b>Languages.</b> One language present → AI fills the other; both present → maps each to EN/CN.",
])]
story += [p("Two guarantees: <b>nothing is silently dropped</b> (an unrecognized column is parked, never deleted) and "
            "<b>dedupe by SKU/name</b> so a re-import updates instead of doubling.", small_mut)]

story += [p("If they don&rsquo;t have a sheet", h2_st)]
story += [p("The informal seller — products live on a phone, in WeChat, on Taobao, or in their head. On-ramps, easiest first:", body_st)]
story += [bullets([
    "<b>Photos-first bulk add (strongest).</b> &ldquo;Drop all your product photos&rdquo; → each photo → AI vision makes a draft (name / ingredients / weight from the label; you add price). The wizard&rsquo;s snap-the-label, in bulk.",
    "<b>Import from their existing online store.</b> Paste shop / product <b>links</b> (Taobao / Youzan / another mini-program / website) → AI reads the public pages → drafts. The real platform-switch answer.",
    "<b>Paste whatever they&rsquo;ve got.</b> A WeChat message, a typed list, a document → AI parses it into rows.",
    "<b>Just use the wizard</b> for a handful — bulk tools are for volume.",
])]

story += [p("Build it, or plug in a market tool?", h2_st)]
story += [p("There is a whole category of embeddable AI CSV importers — <b>Flatfile, OneSchema, Osmos, Dromo, "
            "Nuvo/Ingestro, CSVBox</b>, open-source <b>YoBulk</b>. They do real column-mapping, but for this product the "
            "recommendation is to <b>build thin on Claude</b>, not plug one in:", body_st)]
story += [make_table([
    ["Why build on the engine you already have", "What a market tool would (and wouldn&rsquo;t) add"],
    ["You already own the intelligence — column-mapping, normalizing, parsing text, reading photos — wired in through the model gateway. White-label single-vendor stays intact. Customer data stays on your China stack (PIPL / latency).",
     "Saves the mapping/validation <i>widget UI</i> only — not the brains. Adds a 2nd AI vendor, a monthly + per-row cost, and (mostly) ships catalogs to US servers. Covers Case A only — nothing for photos / links / paste."],
], [80*mm, 81*mm])]
story += [p("<b>Only revisit a tool</b> if you want to skip building the import widget — then look at <b>Dromo</b> "
            "(zero-retention) or self-host <b>YoBulk</b> (open-source) to keep data off a third party. Note: the China "
            "platforms (Youzan / Weidian / Taobao) have no turnkey catalog-API agent — your link-import + AI is as good as it gets.", small_mut)]

story += [p("A v1 for import", h2_st)]
story += [p("<b>AI-mapped CSV/XLSX import</b> (the confirm-the-mapping flow) + <b>photos-first bulk add</b> — those two "
            "cover &ldquo;I have a sheet&rdquo; and &ldquo;I have photos but no sheet.&rdquo; <b>Fast-follow:</b> "
            "import-from-link (platform switchers) and drag-your-image-folder matching.", body_st)]

story += [rule(BRASS, 1.2, 12, 6)]
story += [p("Three steps of one loop — <b>Add</b> fast, <b>Finish</b> the gaps, <b>Import</b> at scale — all on the same "
            "engine (Claude, already wired in), all landing as drafts you control.", end_st)]

# ══ THE SCREENS ════════════════════════════════════════════════════════════
story += [PageBreak()]
story += part_band("THE SCREENS", "What it looks like")
story += [p("Mockups in the Full Circle backend palette (Ink / Brass / Tea, IBM Plex). Phone-first for operators on the "
            "move; the same flow on desktop gains a step rail and a live preview that builds as you type.", body_st)]
story += [Spacer(1, 6), p("Desktop flow — the PC version, screen by screen", h3_st)]
import json
with open("scripts/wizard_pc_manifest.json", encoding="utf-8") as _f:
    _pc = json.load(_f)
for _m in _pc:
    story += [KeepTogether([
        framed_shot("scripts/wizard_pc_%s.png" % _m["slug"], 165*mm),
        p(_m["caption"], cap_st),
    ]), Spacer(1, 11)]

story += [PageBreak(), p("Phone flow — the same loop in your pocket", h3_st)]
story += [p("Each step on a phone, thumb-friendly — for operators adding products on the move.", small_mut), Spacer(1, 8)]
with open("scripts/wizard_ph_manifest.json", encoding="utf-8") as _f:
    _ph = json.load(_f)
_PCOLS = 3
_prows = []
for _i in range(0, len(_ph), _PCOLS):
    _chunk = _ph[_i:_i + _PCOLS]
    _cells = [[framed_shot("scripts/wizard_ph_%s.png" % _m["slug"], 44*mm), p(_m["caption"], cap_st)]
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
    title="The Simple Product Wizard — Plan", author="Full Circle",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("WROTE", OUT, os.path.getsize(OUT), "bytes")
