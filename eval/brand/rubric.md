# AI Brand Studio — scoring rubric

Two layers. The harness (`run.js`) scores the **deterministic** layer today; the
**judgement** layer is added in M4 once the render→vision path lands.

## Deterministic (0–100, automated)
| Dimension | Pts | Check |
|---|---|---|
| Accessibility | 30 | No contrast `errors` from `lib/brand-gates` (body text ≥ 4.5:1). |
| Discipline | 10 | −5 per advisory warning (too many colours, monochrome-CN…). |
| Palette completeness | 20 | All 5 palette roles present. |
| Layout depth | 15 | ≥ 4 blocks composed. |
| Lead block | 12 | Opens with `hero_banner` or `greeting`. |
| Product surface | 13 | Includes `product_grid` or `featured_item`. |

## Judgement (M4, LLM-judge on the rendered screenshot)
Scored 1–5 each, **for the brief's stated audience**, looking at the rendered
preview (both EN and CN states for bilingual briefs):
- **Brand fit** — does the look match the brief's words/mood?
- **Colour harmony** — is the palette coherent and intentional?
- **Hierarchy** — clear focal order, not flat.
- **Distinctiveness** — deliberate, not the generic AI default.
- **Consistency** — one system (radius/energy/colour) across blocks.

## Coverage rule
Briefs MUST span every archetype **and** all three audiences
(`chinese` / `international` / `mixed`) so a change can't silently regress one
segment while improving another. Keep the brief set frozen; add, don't edit.
