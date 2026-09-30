# Phone parity mockups — Recipes, Purchasing, Finance

36 phone frames (390×844) for every page the phone still lacks in these three
areas. Survey and build order: `docs/tacet-phone-parity-recipes-purchasing-finance.md`.

Published canvas: https://claude.ai/artifact/JDAMQX1ZFomZpwHmUpDB8b

The frames are generated. Edit `src/` and run:

```
node design-handoff/phone-parity/src/build.mjs <outdir>
```

That writes `<outdir>/project/canvas.json` plus one `.dc.html` per frame.
`src/kit.mjs` holds the tokens (the live `public/m.html` `:root` block) and the
shell (one header bar with the page name, search and initials; a back link on
pushed screens; the status line below the hairline; the five-tab bar).

| Prefix | Page |
|---|---|
| `R01–R11` | Recipes, materials, product ↔ recipe |
| `P01–P14` | Purchasing: orders, new-order wizard, kitchen requests, receiving extras, 发票, reorder, suppliers, price history |
| `F01–F11` | Finance: summary, transactions, categories, approvals fixes, 发票 issue, reports |

English only in the frames. The live screens are bilingual, and every new
Chinese string is declared in `docs/tacet-delivery-vocabulary.md` when it is
built.
