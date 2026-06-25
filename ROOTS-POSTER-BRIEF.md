# Roots — Marketing Poster Kit · Design Brief for Claude Design

A complete, self-contained brief. Hand this whole file to Claude Design, attach the
assets listed in §5, and it has everything needed to build the templates.

---

## 0. Ready-to-paste prompt

> Build a **marketing-poster template kit** for **Roots**, a vegan / plant-based
> grocery brand in Guangzhou. Output **two self-contained HTML/CSS templates** sized
> for sharing into WeChat group chats and broadcasts:
>
> 1. **Long poster (长图)** — tall, editorial, for product launches & features.
> 2. **Flash offer card** — compact 4:5, for daily deals / flash sales.
>
> Both must feel **100% Roots** (see brand kit below), be **bilingual EN + 中文**, and
> contain **empty, clearly-labelled image placeholder zones that a human fills in
> manually** with real photos (the product packshot + a lifestyle/usage shot such as
> peanut butter spread on bread) — do NOT generate or illustrate the product itself.
> Use real Roots tokens, fonts, the ROOtS wordmark image, and a black-ink mascot.
> Each template should be one product, one clear message, with a forest-green footer
> band carrying a scan-to-buy QR placeholder. Provide a colour-way variant or two per
> template. Deliver clean HTML/CSS at a 1080px base width, using CSS variables for all
> tokens and swappable `<img>` zones, exportable to PNG.
>
> Full brand kit, exact tokens, layout specs, image-zone specs, and content fields
> follow.

---

## 1. What we're making & how it's used

- **Use:** an operator picks a product, fills the image zones with real photos, and
  posts the exported PNG into WeChat **group chats / broadcasts (群发)**. A group chat
  can only show a flat **image**, so the deliverable is a rendered poster, not a live
  page.
- **"Scrolling poster"** = a tall **长图** (long image); it shows as a thumbnail in chat
  and expands on tap. So "long" vs "compact" is just poster height — same kit.
- The poster copy is **data-driven** from our product catalogue (see §8), but the
  **photos are dropped in by hand** (see §7). That manual-photo requirement is the
  single most important structural rule.

---

## 2. Brand voice

- **Name:** Roots (English in both markets — there is **no** Chinese brand name).
- **Taglines:** **"From Soil to Soul" / "从土壤到灵魂"**, and **"Food Made from Food."**
- **Voice:** editorial, plant-forward, celebratory — joy, not sacrifice. Concrete
  claims ("small batch", "stone-ground", "100% peanuts") over vague wellness talk.
  Playful, characterful (the mascots have personality), but grown-up and premium.
- Representative lines:
  - EN: *"We make plant-based food so good it changes how people eat."*
  - CN: *"把植物食物做到令人惊艳的好。"*

---

## 3. Colour tokens (exact)

Source of truth: `lib/brand-tokens.js`. Use these hex values exactly.

| Token | Hex | Role |
|---|---|---|
| **lime-leaf** | `#CCD900` | PRIMARY accent — CTAs, highlights, big offer numbers, rule lines |
| **forest-kale** | `#365329` | Deep green — footer band, secondary blocks, headings on cream |
| **oat-milk** | `#F2E7DF` | DEFAULT background (warm cream) |
| **ink** | `#1a1a17` | Primary text, mascots, wordmark |
| **berry-punch** | `#E96174` | Hot-pink accent / secondary CTA / "save" tags |
| **carrot-blaze** | `#FF6B0C` | Bright orange accent (energy) |
| **golden-corn** | `#F2CA6C` | Warm yellow callouts |
| **roasted-almond** | `#C37F4E` | Terracotta / craft warmth |
| **olive-moss** | `#6A6E2D` | Muted olive — supporting / muted text on cream |
| **pea-sprout** | `#7BBD3B` | Mid green supporting |
| pink-guava `#F4B8CB` · skyberry `#B2CFED` · lotus `#EEB8E4` · papaya-glow `#FFAF60` · citrus-zest `#E7E74C` | | Rare playful accents — use sparingly |
| white | `#FFFFFF` | Contrast |

**Hero duo = lime-leaf + forest-kale on an oat-milk ground, ink text.** Berry-punch and
carrot-blaze are the punchy secondary accents. A signature Roots move: stack a headline
where **each line is a different brand colour** (see the affiliate card reference: "JOIN
ME" in lime, "ON ROOTS" in berry).

CSS:

```css
:root{
  --lime:#CCD900; --forest:#365329; --olive:#6A6E2D; --oat:#F2E7DF;
  --ink:#1a1a17; --berry:#E96174; --carrot:#FF6B0C; --papaya:#FFAF60;
  --corn:#F2CA6C; --almond:#C37F4E; --pea:#7BBD3B;
}
```

---

## 4. Type system (exact)

Roots fonts. **Do not substitute** Fraunces / Anton / Inter / Space Grotesk or any other
font — those are NOT Roots.

| Font | Role | Notes |
|---|---|---|
| **Bear Serif** | Display headlines, product names | Chunky editorial serif. Its digits are thin, so digits/currency are mapped to **Lilita One** via `unicode-range` (see @font-face). |
| **Toni Grotesk** | Kickers, labels, eyebrows | Tight grotesk — always `text-transform:uppercase; letter-spacing:0.04em`. |
| **Aleo** | Body copy, descriptions, sublines | Warm slab serif. |
| **League Gothic** | Big stat callouts | Tall condensed; use sparingly for one hero number. |
| **Lilita One** | Big numbers / prices | Heavy rounded poster digits (also the digit map for Bear Serif). |
| **DF Yuan** | Chinese (CJK) | Rounded Chinese sans, weights 500/700/900. **First fallback in every chain** so EN+CN line up on the same baseline. |

`@font-face` (fonts are self-hosted on the Roots domain — use absolute URLs so they load
in the design sandbox; if the sandbox blocks that origin, upload the files from §5):

```css
@font-face{font-family:'Bear Serif';   src:url('https://rootskitchenchina.com/assets/fonts/LilitaOne.ttf') format('truetype'); unicode-range:U+0024,U+0025,U+0030-0039,U+00A5; font-display:swap;}
@font-face{font-family:'Bear Serif';   src:url('https://rootskitchenchina.com/assets/fonts/BearSerif.otf') format('opentype'); font-display:swap;}
@font-face{font-family:'Toni Grotesk'; src:url('https://rootskitchenchina.com/assets/fonts/ToniGroteskPro.otf') format('opentype'); font-display:swap;}
@font-face{font-family:'League Gothic';src:url('https://rootskitchenchina.com/assets/fonts/LeagueGothic.ttf') format('truetype'); font-display:swap;}
@font-face{font-family:'Aleo';         src:url('https://rootskitchenchina.com/assets/fonts/Aleo-Regular.otf') format('opentype'); font-display:swap;}
@font-face{font-family:'DF Yuan';      src:url('https://rootskitchenchina.com/assets/fonts/DFYuanW5.ttf') format('truetype'); font-weight:500; font-display:swap;}
@font-face{font-family:'DF Yuan';      src:url('https://rootskitchenchina.com/assets/fonts/DFYuanW7.ttf') format('truetype'); font-weight:700; font-display:swap;}
@font-face{font-family:'DF Yuan';      src:url('https://rootskitchenchina.com/assets/fonts/DFYuanW9.ttf') format('truetype'); font-weight:900; font-display:swap;}

:root{
  --bf-bear:'Bear Serif','DF Yuan','New York',Georgia,serif;
  --bf-toni:'Toni Grotesk','DF Yuan',-apple-system,sans-serif;
  --bf-gothic:'League Gothic','DF Yuan','Bebas Neue',Impact,sans-serif;
  --bf-aleo:'Aleo','DF Yuan',Georgia,serif;
}
```

> **Fallback note:** Aleo, League Gothic, and Lilita One are also free on Google Fonts
> (same names) if you need a preview fallback. **Bear Serif, Toni Grotesk and DF Yuan
> are proprietary** — they must load from the URLs above or from the uploaded files.

---

## 5. Assets to attach to the Claude Design project

Upload these from the repo so the templates use the real marks (paths relative to repo
root):

- **Wordmark (logo):** `miniapp/assets/brand/roots-wordmark.png` — the black "ROOtS"
  logotype (chunky, rounded, custom letterforms). **Always place this image as the
  logo. Never retype "Roots" in a font.**
- **Mascots (black-ink line drawings):**
  - `miniapp/assets/brand/mascot-flex-ink.png` — flexing muscle character (energy/strength)
  - `miniapp/assets/brand/ip-skater.jpg` — garlic (spreads / butters / jams → **use for peanut butter**)
  - `miniapp/assets/brand/ip-peas.jpg` — pea pod (legumes)
  - `miniapp/assets/brand/ip-flex.jpg` — bean trio (protein / powder)
  - `miniapp/assets/brand/ip-kombucha-gang.jpg` — microbe trio (drinks)
  - `miniapp/assets/brand/ip-radishes.jpg`, `ip-mushroom.jpg`, `ip-broccoli.jpg`, `ip-soilsoul.jpg` (onion, default), `ip-onion.png`
- **Fonts (if the sandbox can't reach the Roots domain):**
  `public/fonts/BearSerif.otf`, `public/fonts/ToniGroteskPro.otf` are in the repo;
  the rest (LilitaOne.ttf, LeagueGothic.ttf, Aleo-Regular.otf, DFYuanW5/W7/W9.ttf) live
  on the server at `/assets/fonts/`.
- **Visual-language references (match this look):**
  `miniapp/assets/brand/share-affiliate.png` (existing marketing card),
  `miniapp/assets/brand/welcome-roots.jpg` (wordmark + mascot hero),
  and the brand guideline set `design_bundle/roots-mini-app-2/project/uploads/roots 视觉应用-*.jpg`.

**Mascot-by-category map** (pick the mascot that matches the product's category; default
= onion / soilsoul):

| Category | Mascot |
|---|---|
| Spreads, butters, jams (**peanut butter**) | garlic — `ip-skater.jpg` |
| Legumes, beans, peas, lentils, chickpeas | pea pod — `ip-peas.jpg` |
| Protein, powder, supplement, flour | bean trio — `ip-flex.jpg` |
| Drinks, kombucha, juice, tea | microbe trio — `ip-kombucha-gang.jpg` |
| Roots, tubers, carrot, radish, beet | radish — `ip-radishes.jpg` |
| Mushroom / fungi | `ip-mushroom.jpg` |
| Broccoli, cabbage, leafy greens | `ip-broccoli.jpg` |
| _everything else (default)_ | onion — `ip-soilsoul.jpg` |

---

## 6. The two templates (presets)

Base width **1080px** for both. Generous margins (~72px safe area). Oat-milk ground
unless noted.

### Preset A — Long poster (长图)
Tall, editorial, calm-premium. Suggested canvas **1080 × 2400** (allow 1920–2700).
Top-to-bottom flow:
1. **ROOtS wordmark** (top-left, ink) + a Toni-Grotesk uppercase kicker (e.g. `广州 · 100% PLANT`).
2. **Hero lifestyle photo zone** — full-bleed (see §7, Zone 1).
3. **Bear Serif headline** (the hook) + Aleo italic subline + CN line under it.
4. **Product packshot zone** overlapping the photo/panel seam like a sticker (Zone 2).
5. A short **benefit row** (Toni Grotesk uppercase, lime dot separators) — 3 claims.
6. **Price block** — Bear Serif/Lilita One price, struck original, a lime "限时" tag.
7. Optional **second usage photo** band (Zone 3).
8. **Forest-kale footer band** with the **QR placeholder** (Zone 4) + "Scan to buy /
   扫码即买" + small mascot + the tagline "From Soil to Soul / 从土壤到灵魂".

### Preset B — Flash offer card
Compact, punchy, scroll-stopping. Canvas **1080 × 1350 (4:5)**.
- Toni-Grotesk uppercase kicker (e.g. `FLASH · 今日闪购`).
- **Huge price** (Lilita One) as the hero, with a berry-punch "save ¥X" tag and a
  rotated lime discount seal (`-30% / 省3成`).
- Product name (Bear Serif EN + CN).
- **Product packshot zone** (Zone A).
- Forest-kale footer with **QR placeholder** + "扫码下单" + ROOtS wordmark.

Also provide a **square 1080 × 1080** variant of Preset B if cheap to do.

---

## 7. Image placeholder zones — THE KEY REQUIREMENT

Every template ships with **empty image slots a human fills in by hand**. Do not put AI
or illustrated product art in them. In the **unfilled** state each zone shows a dashed
ink outline on oat-milk with a centred Toni-Grotesk uppercase label, e.g.
`PRODUCT PHOTO · drop here`. Filling = swapping one `<img src>` (or a `--zone-img` CSS
var). Each zone is `object-fit:cover` with a fixed aspect ratio so any photo crops
cleanly.

**Preset A (long):**
- **Zone 1 — Hero lifestyle photo** (required): full-bleed, **1080 × 1180** (~16:18).
  The in-context shot — e.g. toast with peanut butter, a breakfast scene.
- **Zone 2 — Product packshot** (required): **~560 × 560**, the jar/pack on a
  transparent or clean ground; sits as a sticker over the seam.
- **Zone 3 — Secondary usage photo** (optional): a **1080 × 560** band, or two
  **520 × 520** side-by-side, for a second use (spread on bread, ingredient flat-lay).
- **Zone 4 — QR / 小程序码** (required): **220 × 220** in the footer band.

**Preset B (flash card):**
- **Zone A — Product packshot** (required): **~620 × 620**.
- **Zone B — Lifestyle thumbnail** (optional): **~320 × 320** inset.
- **QR / 小程序码**: **200 × 200** in the footer band.

> The example the operator gave: *product = peanut butter → Zone 2/A holds the jar; Zone
> 1/3/B holds "peanut butter spread on bread."* They will supply both photos.

---

## 8. Content fields (what fills the copy)

These come from the product catalogue and an offer; design the template so each maps to
a clear text slot:

- `name_en`, `name_cn` — product name (Bear Serif)
- `weight` — e.g. `240g` (League Gothic / Aleo)
- `price`, `sale_price`, `discount_pct` — pricing (Lilita One numerals)
- `hero_claim_en` / `hero_claim_cn` — the hook headline (e.g. "Just peanuts.")
- `benefits[]` — 3 short claims (e.g. "No palm oil", "No added sugar", "Vegan & gluten-free") + CN
- `category` → selects the mascot (see §5 map)
- `tagline` — fixed: "From Soil to Soul / 从土壤到灵魂"
- `scan_cta` — fixed: "Scan to buy / 扫码即买 · 同城配送"

Use realistic placeholder copy for the mockups (e.g. **Crunchy Peanut Butter / 醇脆花生
酱 · 240g · ¥39 ~~¥49~~**), clearly marked so we know it's swappable.

---

## 9. Output specs

- **Base width 1080px.** Preset A: 1080×~2400 (长图). Preset B: 1080×1350 (4:5) +
  optional 1080×1080.
- Export target: **PNG** (or high-quality JPG) at 1× (1080) — also fine at 2× for crisp
  text.
- Bilingual EN + 中文 throughout; DF Yuan handles all CJK.
- All colours from §3; all type from §4; CSS variables for every token so re-skinning is
  one place.

---

## 10. Do / Don't (so it reads 100% Roots)

**Do**
- Oat-milk `#F2E7DF` ground, ink text, lime + forest as the hero duo.
- Bear Serif headlines; Toni Grotesk UPPERCASE kickers with 0.04em tracking; Aleo body;
  Lilita One for big numbers/prices.
- Place the **ROOtS wordmark PNG** as the logo.
- A **forest-kale footer band** with centred light CTA — a signature Roots device (see
  the affiliate card).
- Black-ink line **mascots** as playful, characterful accents (monochrome).
- Stacked multi-colour headline lines for punch, where it suits.
- Leave image zones **empty** with clear labels.

**Don't**
- No gradients, drop shadows, glow, neon, or generic "AI gradient" looks. Flat, printy,
  confident.
- No non-Roots fonts (Fraunces, Anton, Inter, Space Grotesk, etc.).
- Don't retype the wordmark in a font; don't invent a Chinese brand name.
- Don't generate/illustrate the product — those slots are for the operator's real
  photos.
- Don't over-decorate; Roots is warm + premium, not busy.

---

## 11. Reference files in this repo

- `miniapp/assets/brand/share-affiliate.png` — existing marketing card (closest match to target)
- `miniapp/assets/brand/welcome-roots.jpg` — wordmark + mascot hero
- `miniapp/assets/brand/roots-wordmark.png` — the logo
- `miniapp/assets/brand/ip-*.jpg`, `mascot-flex-ink.png` — mascots
- `design_bundle/roots-mini-app-2/project/uploads/roots 视觉应用-*.jpg` — brand guideline visuals
- `design_bundle/roots-mini-app-2/project/Roots Mini App.html` — original design handoff (full brand system in code)
- `lib/brand-tokens.js` — colour tokens · `lib/brand-fonts.js` — font library · `public/storefront.html` (head) — live @font-face + CSS vars
