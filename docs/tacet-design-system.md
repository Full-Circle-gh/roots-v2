# Tacet design system — v1.3

> Paste this entire document into Claude Design's project instructions (or hand it to any designer/developer). Every screen generated must follow it. The one-line style guide: **when in doubt, remove something.**
>
> **v1.3 (2026-07-26):** `--td-header` and `--td-unseen` shipped to the live
> `--td-*` block (`170b5c8a`) and are no longer mockup-only. Both status
> blocks corrected. Nothing else changed.

## What Tacet is

Tacet is a unified command dashboard with silent AI automations for e-commerce merchants exhausted by platform jumping. The brand sells operational peace of mind. *Tacet* is the musical notation meaning "rest — the orchestra plays without you." Every design decision should make the merchant feel calmer, never busier.

**Personality:** composed, quietly powerful, warm. Never loud, never urgent, never gamified.

---

## 1. Color

Use these exact values. Consistency comes from proportions, not just hex codes.

| Token | Hex | Ratio | Rule |
|---|---|---|---|
| Paper | `#FBF9F4` | ~65% | Default background of everything |
| Ink | `#111A2B` | ~25% | All primary text; dark surfaces |
| Graphite | `#58606E` | ~7% | Secondary text, borders, captions |
| Dusk | `#6E67AF` | ~2% | **The AI's color.** Primary CTAs and automation states ONLY |
| Sage | `#A3B49F` | ~1% | Success / all-clear states only |

Functional (product UI only): Amber `#C9954A` for warnings, Brick `#B4533E` for errors. Never pure red, never neon anything.

**The Dusk rule (most important rule in this system):** Dusk is scarce by design. When a merchant sees Dusk, it means exactly one thing — *Tacet did this for you.* One Dusk element per screen is the norm; two is the maximum. If a screen is full of Dusk, it is wrong.

**Dark mode:** Paper and Ink swap (Ink surfaces, Paper text). Every other color holds its role.

Tints for backgrounds: Dusk `#EEEDF6`, Sage `#EDF1EC`, Amber `#F7EEDE`, Brick `#F6E7E3`, raised surface `#F6F3EC`, border `#E4E0D5`.

### Table header surface — 2026-07-24 · ✅ SHIPPED 2026-07-26

**`--td-header`** — live in the `--td-*` block
- Light: `#DAD5C6`
- Dark: `#364058`

**The column-header band on EVERY table in the product**, not an Orders
value — Orders is just where it was decided. Deeper than `--td-raised`
(`#F6F3EC` / `#1E2A44`), which was too close to the body rows to separate
the header at a glance. Chosen from three variants (A `#E4E0D5` /
B `#DAD5C6` / C `#CFC9B8`) — B picked as the balanced option: clearly
darker than rows in both themes, keeps the 1px `--td-border` bottom rule
legible (at A the band *equals* the border and the rule disappears into
it), and doesn't tip into reading as a toolbar the way C does.

Header labels on this band are 13px Inter 500 sentence case in `--td-text`
(Ink), **not** `--td-text2` (Graphite). Size stays 13px — 15px was tried
and reads as another row rather than a header.

### Unseen-row surface — 2026-07-24 · ✅ SHIPPED 2026-07-26

**`--td-unseen`** — live in the `--td-*` block
- Light: `#F4F5F0`
- Dark: `#182329`

The row-state surface for a record the operator has not yet opened.
Deliberately **lighter** than `--td-header`: a row's unseen state is
transient content, and must never read as heavy as the page's own chrome.
**The hierarchy check is explicit — in every frame, the header band must
read visibly stronger than any unseen row.**

Paired with a left-edge marker: `box-shadow: inset 4px 0 0 var(--td-sage)`
(`#A3B49F`, same value in both themes). **Inset shadow, NOT a border** —
the marker must not change row height or padding. Seen and unseen rows are
identical in size and alignment; an indicator that resizes its row makes
the whole list jump as records get opened, which is the opposite of
"everything settles." Surface and edge always appear together, never one
without the other.

On open, surface and edge settle together to Paper and
`inset 4px 0 0 transparent`, ~600ms, `cubic-bezier(0.16, 1, 0.3, 1)`.

**Zero Dusk.** A record arriving is the *customer* acting, not the AI.
This replaces the live Orders page's Dusk "New" pill, which was a Dusk-rule
violation.

**STATUS (both tokens): ✅ SHIPPED 2026-07-26, commit `170b5c8a`.** Both are
in the live `--td-*` block, in `:root` (dark) and `:root[data-theme="light"]`,
with the "header deeper than raised, unseen lighter than header, don't
converge them" rule written in beside them. Added as a standalone additive
commit — nothing consumed them, so the product was pixel-identical after —
precisely so the Customers build could be page work rather than token work.

**Customers is the first and so far ONLY consumer.** Live Orders still ships
its old header (`13.5px/700` on `--bg-pane`, `padding: 11px 10px`) and its
Dusk "New" pill. That is a known, recorded inconsistency from shipping
Customers alone, not drift — Orders gets the same pass and the pill is
replaced by the unseen-row treatment when it does.

The band's **typography and spacing** are not here — they live in
`tacet-desktop-patterns.md` §1.13a rule 3, with Orders as the anchor. This
file owns the two colours; the rulebook owns how the band is put together
and how it pins. Do not re-decide either per page.

## 2. Typography

Two typefaces, strictly divided (both free on Google Fonts):

- **Fraunces** (Light 300 / Regular 400) — the brand's voice. Marketing headlines, onboarding moments, deck titles. **Never inside working product UI.**
- **Inter** (400 / 500 only — nothing heavier, bold reads as shouting) — the product's hands. All UI, body, data.

Scale: Display 56px Fraunces Light · Headline 32px Fraunces · Title 18px Inter 500 · Body 15px Inter 400, line-height 1.6 · Caption 13px Inter, Graphite.

**Numbers rule:** every number in a dashboard uses tabular figures (`font-variant-numeric: tabular-nums`) so columns align. CJK pairing: Source Han Serif with Fraunces, Source Han Sans with Inter.

## 3. Space, shape, elevation

- 8px spacing base: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96. Default to the *larger* option — whitespace is the product.
- Radius: 8px controls, 14px cards, pill badges.
- Borders 1px `#E4E0D5`. Elevation: at most one soft ambient shadow (`0 4px 16px rgba(17,26,43,0.04)`). No layered shadows, no glassmorphism, no gradients anywhere.

## 4. Motion — "everything settles"

Nothing bounces, pops, springs, or slides in from the side. Elements decelerate into place like water going still.

- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (strong ease-out). Durations: 200ms controls, 350ms default, 600ms page-level.
- Signature animation: a waveform settling into a flat line, ending with a small Dusk dot pulsing gently. Used in exactly three places: app launch, website hero, loading states.
- The Dusk dot "breathes" (opacity 1 → 0.45 → 1, 2.4s loop) wherever an automation is live.
- Always respect `prefers-reduced-motion`.

## 5. Components

**Buttons.** Primary: Dusk fill, white text (one per screen, max). Secondary: transparent, 1px Graphite-tint border, Ink text. Ghost: text-only Graphite. Destructive: Brick outline, fills with Brick tint on hover — never a solid red slab. Labels are verbs: "Connect channel", never "Submit" or "OK!".

**Inputs.** White surface, 1px border, 8px radius; focus = border turns Dusk, no glow rings. Labels above in 13px Inter 500. Errors in Brick text below the field: what happened + how to fix, no apologies.

**Cards.** White on Paper, 1px border, 14px radius, 24px padding. Raised variant: cream `#F6F3EC`, no border. Cards enter with the settle animation (8px rise + fade).

**Badges.** Pill, tinted background, 13px. Sage tint = all clear · Amber tint = needs attention · Brick tint = error · Dusk tint + breathing dot = automation active.

**The Recap (signature component).** The daily digest card, first thing on the dashboard and app home. Headline in 18px Inter 500: "While you slept" / "While you were away". Rows of what Tacet handled, each with a Dusk dot. Numbers tabular. Ends with at most one dry-warm line ("You're welcome."). This card is the brand in component form — get it right first.

**Empty states.** A compliment, not an apology: "Nothing needs you. Enjoy it." Optionally the flat waveform line beneath. Never a sad illustration.

**Notifications.** Digests, never dings. At most one push per day unless something truly needs the merchant. In-app: quiet inline banners, no toasts flying in.

## 6. Voice in UI copy

1. State the outcome, imply the effort: "Your inventory matches everywhere. Always."
2. Short sentences. Then shorter. No exclamation marks — ever, even for good news.
3. Dry warmth: max one small human moment per screen.
4. Sentence case everywhere. Feature names are plain (Dashboard, Orders, Channels, Automations) except two: **The Recap** (daily digest) and **Arrangements** (automation library).

## 7. Layout principles

- One screen answers one question. The dashboard's question: *is everything okay?* Lead with The Recap, then anything needing attention, then everything else.
- Max content width 1120px on web; single column on mobile with 16px gutters.
- Marketing pages: hero = settling waveform + wordmark + one sentence ("One dashboard. Every channel. Quiet."). Fraunces headlines, Dusk CTA, enormous whitespace.
- Logo: lowercase `tacet` wordmark always; clear space = one wave height; the mark alone below 24px.

## 8. Logo assets

The mark is a waveform settling into a straight line — chaos becoming calm. Use this exact SVG whenever the mark is needed; never redraw it freehand. Set `stroke` to Ink `#111A2B` on light surfaces or Paper `#FBF9F4` on dark. The Dusk dot at the line's end is optional and means "automation alive" (it may breathe: opacity 1 → 0.45 → 1, 2.4s loop).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 110" fill="none">
  <path d="M20 55 C30 15, 40 95, 50 55 C59 22, 68 88, 77 55 C85 30, 93 80, 101 55
           C109 38, 117 72, 125 55 C133 44, 141 66, 149 55 C160 50, 171 60, 182 55
           C215 55, 260 55, 305 55"
        stroke="#111A2B" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="305" cy="55" r="5" fill="#6E67AF"/>
</svg>
```

Wordmark: the word `tacet`, always lowercase, in Fraunces Light with generous letter-spacing (~0.2em), Ink. Lockups place the wave above (primary) or left of (horizontal) the wordmark. App icon: Ink rounded square (corner radius ≈ 22% of width), Paper wave, Dusk dot.

Rules: clear space around any lockup = one wave height · minimum wordmark height 24px, below that use the mark alone · never stretch, rotate, recolor outside Ink/Paper/Dusk, or set the wordmark uppercase.

### 8a. The mark at small size — NEW, 2026-07-25

**The stroke is set optically at small sizes, not scaled from the viewBox.**
At 20px tall — the size the mark renders in the topbar — the spec's
3.5-unit stroke resolves to **0.64px** and effectively disappears. Hold it
at **1.6px** instead.

The path itself is still used **verbatim**; only the stroke width is
adjusted. If a future survey "corrects" the stroke back to 3.5 for
fidelity, the mark vanishes from the chrome of all 34 pages and nobody
notices for a while, because a mark that isn't there looks like a spacing
choice. **The decay must stay visible:** big swings left, settling to a
dead-flat line right. If a render doesn't show that, it was redrawn.

### 8b. Co-brand — the merchant's logo box — NEW, 2026-07-25

Every merchant uploads their own logo (`#brandLogoTop`, swapped by
`applyBrand()`). It sits to the **right** of the tacet lockup, separated by
a 1px `#E4E0D5` hairline 24px tall with 16px either side. **Tacet first,
the merchant as the qualifier** — decided 2026-07-25 against the reverse.

**The fit rule, settled 2026-07-25 after drawing all three cases:**

| | Rule |
|---|---|
| Max height | **24px** |
| **Min rendered height** | **14px** — the floor |
| Max width | **210px** — the hard ceiling |
| Scaling | Fit inside the box. **Never crop, never stretch.** |
| Past the ceiling | The width ceiling wins and the logo renders **shorter than 14px**. Ugly, but bounded. |

*Why a floor exists at all:* under a plain 120px width cap, a 600×40 banner
logo renders at **120×8**. Eight pixels tall is not a logo, it is a smudge —
and it is the merchant's brand sitting on every page they will ever open.
The floor costs up to 90px of bar width, taken from spacer that is empty
anyway. *Why the ceiling exists:* "raise the width to whatever the floor
needs" is unbounded — a 1200×40 banner would demand 420px and eat the bar.

**🔴 The two are shown TOGETHER — a change to live behaviour, decided 2026-07-25.**
Live `body.cobrand` (`retail-admin.css:507–509`) *swaps*: `.brand-logo`
appears and `.brand-mark` + `.brand-name` are hidden, so a merchant with a
logo sees **no tacet at all** in the bar. That is a white-label model, and it
had a matching half — `#brandCredit` ("runs on tacet") at the foot of the
rail. **The approved bar replaces it with a true co-brand lockup:** the swap
rule comes out, both marks render side by side with the hairline between.
**Banned element:** the "runs on tacet" attribution mark is removed
product-wide and must not be reintroduced in any surface, mockup, print
template, or email.

**No logo uploaded → show nothing.** No placeholder, no grey box, no
initials tile, no invitation to upload. The hairline goes with the logo;
the tacet lockup simply sits alone, correctly spaced.

**Uppercase:** Tacet's no-uppercase rule (`tacet-desktop-patterns.md` §1.6)
governs **Tacet's own typography, not a merchant's uploaded artwork.** An
uppercase merchant logo is their brand and renders as supplied.

**Dark theme — UNRESOLVED, currently a proposal.** Most uploads are
dark-on-transparent and vanish on a dark bar. The interim fallback is to sit
the logo on a small Paper-tinted chip (6px radius, 3/7px padding). The real
fix is a **second upload slot for a light-on-dark variant**, with the chip as
fallback when the merchant hasn't supplied one. That is a Settings/branding
build and is parked to that design pass. **Do not treat the chip as settled.**

## 9. Never

No gradients · no glassmorphism · no neon or pure red · no bouncing animations · no exclamation marks · no confetti or streaks or gamification · no more than one Dusk CTA per screen · no Fraunces inside product UI · no uppercase wordmark · no notification badges with alarming counts.
