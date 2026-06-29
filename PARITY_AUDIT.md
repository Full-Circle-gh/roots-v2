# Mini-app ↔ Web Store Design Parity Audit

Read-only audit, 2026-06-27. Mini-app source (WXML/WXSS) is treated as the **design spec**;
the web store (`public/shop.html`) should conform. Both render from the same
`/api/retail/config`, so every divergence below lives in code, not data.

Confidence: ~90%. A handful of "missing on web" items sit inside web render
functions the readers didn't fully expand (flagged ⚠️ NEEDS-CONFIRM). Those I can
settle by rendering the web store myself with the preview tools — no screenshots needed.

---

## How to read this

Each divergence is one of three kinds:

- **TOKEN** — web hardcodes / drops a value the mini-app pulls from a shared token.
  Fix once, every page improves. Highest ROI.
- **STRUCTURAL** — web's markup/layout for a page drifted or a whole feature was
  never ported. Needs a build, not a restyle.
- **BY-DESIGN** — *correct* to differ (WeChat-only mechanics, desktop-vs-mobile
  responsive). Do NOT "fix" these.

---

## Bucket 1 — Systemic / token-level (fix once → helps every page)

| # | Issue | Mini-app (spec) | Web | Severity | Refs |
|---|-------|-----------------|-----|----------|------|
| 1 | **Global font scale missing** | `--font-scale: 1.15` multiplier on all text | absent — web text ~15% smaller than intended | High | app.wxss:76 vs shop.html (none) |
| 2 | **Color tokens dropped** | `--cucumber #A8D185`, `--avocado #73BF83`, `--almond #C37F4E` defined | not in shop.html `:root` → blocks referencing them fall back/break | High | app.wxss:44,57,58 vs shop.html:22-24 |
| 3 | **Kicker font mismatch** | section kickers use Toni Grotesk (`--f-toni`) | `.kicker` uses League Gothic (`--bf-gothic`) | Med | shop.wxss:39 vs shop.html:80 |
| 4 | **Border weight** | search bar / chips `3rpx solid --ink` | `2px solid --ink` (lighter) | Med | shop.wxss:99,199 vs shop.html:65,120 |
| 5 | **Tab badge color** | hardcoded `#e74c3c` | `--berry #E96174` (web is arguably *more* correct; mini-app hardcode) | Low | tab-bar.wxss:38 vs shop.html:324 |
| 6 | **Hardcoded vs token** | a few `#F2E7DF` / `#E96174` literals where a var exists | mixed | Low | various |
| 7 | **Font var aliasing** | uses `--f-*` only | carries duplicate `--bf-*` aliases alongside `--f-*` | Low (cleanup) | shop.html:27-37 |

**Note on rpx→px:** many readers flagged "web font 50% smaller (44rpx→22px)". That's
mostly a *false alarm* — 1rpx ≈ 0.5px at base width, so halving is correct on mobile.
The real systemic size gap is #1 (the 1.15 multiplier), not the rpx math.

---

## Bucket 2 — Structural feature gaps on web (need building)

These are the big visible differences — whole pieces of UI that exist in the
mini-app and are absent/simplified on web.

### Shop / product grid
- No view-switcher (mini-app has list / list-compact / gallery / grid-2 / grid-3).
- No filters: sort dropdown styling off, **no in-stock toggle, no price range, no dietary chips**.
- No quick-add (+) button on cards → no variant bottom-sheet; web forces full PDP visit.
- No left category drill-rail on desktop (mobile list port has it).
- "The garden" shop title replaced by a breadcrumb.

### Product detail (PDP)
- No floating back button, no favorite heart, no on-image stock badge.
- **No flash-sale countdown timer** (mini-app shows d/h/m/s).
- No social-proof rows, no supplier-direct notice, no badges row, no buy-together bundle.
- Rich-text description rendered as escaped HTML, not a parser.

### Checkout — **highest priority**
- ⚠️ **No out-of-stock fallback modal** (5-option) + substitute picker. Mini-app has a
  full flow; web has none. (Ties to your built-but-undeployed
  `feature_fallback_modal_never_deadend`.)
- "Right away" / Express delivery option rendering unconfirmed on web. ⚠️ NEEDS-CONFIRM.

### Order detail / tracking
- No progress timeline.
- No status banners: air-delay, local-ETA, partial-shipment.
- No multi-shipment (split-parcel) cards.
- No refund-status banner.
- No action buttons: reorder, request-refund, cancel, add-to-order.
- No invoice-request CTA, no per-item review links.
- **No standalone `/track` page** — tracking only embedded in order detail.

### Account pages
- **Me:** no hero avatar; no "restore / bind phone" card for returning customers.
- **Wallet:** no how-to-earn modal; missing active-tab arrow accent.
- **Membership:** no forest hero; tier markers + perk cards replaced by a flat ladder.
- **Coupons:** ticket perforation-notch design simplified to a plain card.
- **Favorites:** no list-view toggle, no heart button (uses "Remove" text), no sold-out/
  price-drop tags, no sticky "Add all" bar.

### Content pages
- **Affiliate:** invite avatars missing; share buttons are text links vs styled buttons.
- **FAQ:** "Was this helpful?" 👍/👎 vote buttons missing.
- **About:** founder block is two-column on web vs vertical on mini-app.
- **Order-success:** confirmation screen rendering unconfirmed. ⚠️ NEEDS-CONFIRM.

---

## Bucket 3 — By-design, do NOT change

- WeChat-native pickers/share/getPhoneNumber bind → web correctly uses HTML
  equivalents (region cascade, clipboard/native-sheet share, login redirect).
  Affects: addresses bind flow, affiliate share, FAQ contact buttons.
- Custom tabBar mechanics, swiper galleries → web paradigm differs legitimately.
- Desktop responsive layout (web serves desktop too; mini-app is phone-only).

---

## Per-page severity tally

| Page | High | Med | Low | Notes |
|------|------|-----|-----|-------|
| Tokens (global) | 2 | 2 | 3 | fix first |
| Home | 3 | 2 | 3 | mostly auto-layout fallback |
| Shop | 9 | 3 | 4 | biggest structural gap |
| Product (PDP) | 8 | 6 | 4 | many floating elements missing |
| Cart | 1 | 1 | 6 | close to parity |
| Checkout | 2 (1 critical) | 2 | many | fallback modal is the big one |
| Order detail | 7 | 3 | — | many banners/actions missing |
| Track | 1 critical | 1 | 1 | page missing entirely |
| Me | 2 | 1 | 8 | |
| Wallet | 1 | 2 | 9 | |
| Membership | 3 | 2 | 2 | |
| Coupons | 2 | 2 | 6 | |
| Favorites | 5 | 3 | 3 | |
| Addresses | 2 (by-design) | 1 | 3 | |
| Affiliate | 3 | 3 | 2 | |
| Voting | — | 3 | 4 | |
| Notifications | — | — | 5 | near parity |
| Feedback (+thread) | 1 | 2 | 4 | |
| Invoices | — | 1 | 3 | |
| FAQ | 1 | 4 | 3 | |
| About | 1 | 1 | 7 | |
| Legal | — | — | 3 | parity |

---

## Recommended fix sequence

1. **Pass 1 — Tokens (1 commit, ~1 hour).** Add `--font-scale` support, the 3 missing
   color tokens, fix kicker font + border weights, de-hardcode literals. Kills Bucket 1
   and visibly lifts every page at once. Low risk.
2. **Pass 2 — High-severity styling on near-parity pages** (Cart, Me, Wallet, Coupons,
   Notifications, Invoices, Legal, About). Pure CSS/markup alignment, no new features.
3. **Pass 3 — Structural feature ports, ranked by customer impact:**
   1. Checkout out-of-stock fallback modal (critical — prevents dead-end orders).
   2. Order-detail banners + actions + timeline; standalone /track page.
   3. Shop filters + quick-add + variant sheet.
   4. PDP floating elements, flash countdown, bundles.
   5. Favorites list/heart/add-all; Membership hero/tiers; Coupons ticket design.
4. **Pass 4 — Confirm the ⚠️ NEEDS-CONFIRM items** by rendering the web store in the
   preview tools (no user screenshots required).

Each pass ships independently and is reviewable before the next.
