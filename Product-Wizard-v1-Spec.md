# Simple Product Wizard — v1 Spec (LOCKED 2026-06-13)

Guided, non-technical "Add a product" flow for the **Mini App Backend** (`retail-admin.html`,
the `#pd-editor` / `pd-*` form + the `opt*` / `va*` panels in `public/retail-admin/09-products.js`).
Draft-first, AI-goes-first, plain language. This is the source of truth for the mockups + PDF.

Style rule (see `feedback_plain_words_concrete`): one idea per line, lead with a concrete
example, plain verbs, explicit skip. **No CJK in the PDF/mockups** (Arial has no Chinese glyphs);
the real UI uses `cuT('en','中文')` and renders one live language.

---

## The flow (v1)

```
Front door  →  1 What it is  →  2 Sizes & price  →  3 Details  →  [Customize?]  →  4 Review & publish
```

`Customize?` is an optional gated step (default = No), between Details and Review.
Bundles and Buy-together are **out of v1** (editor-only) — see Deferred.

---

## Front door — how do you want to add it?

> **Add a product**
> Pick whatever's easiest. You can change anything later.
>
> **Take a photo of the label** — We'll read the name, size and details off the package for you.
> **Paste what you've already written** — Drop it in and we'll sort it into the right boxes.
> **Copy one you already sell** — Start from a similar product and change what's different. *(reuses `pdDuplicate`)*
> **Start from scratch** — A blank product. You fill it in.

---

## Step 1 — what is it?

> *(If you took a photo or pasted text, we've filled this in — just check it's right.)*
>
> **Name** → `Cacao Nibs`  — type one language, we add the other
> **Photo** `[ Add a photo ]` — A clear shot on a plain background looks best.
> **What kind of product is it?** `[ Pick a category ▾ ]` — e.g. Pantry · Drinks · Fresh & Deli
> **Price** ¥ `28`
> **Product code** → `CACAO-NIBS-200` — *we made this for you; type over it if you have your own*

Maps to: `pd-name-en/cn`, `pd-gallery`/`pd-img-file`, `pd-top-category` + `pd-subcategory`
(one picker, grouped by parent → sets both), `pd-price`, `pd-sku` (auto, editable).

---

## Step 2 — sizes & price

> **Does it come in different sizes?**  Like 250g and 500g, or Small and Large.
> `[ No, just one ]`   `[ Yes, it has sizes ]`

**No** →
> **Price** ¥ `28`   **In stock** `40`
> ☐ **It's on sale** → was ¥ `36`  *(shoppers see the old price crossed out)*

**Yes** → one row per size:
> `250g` — ¥ `28` — `40` in stock
> `500g` — ¥ `52` — `25` in stock
> `[ + Add a size ]`

Then, both paths:
> **Where can people get it?** *(already set to your usual)*
> ☑ Delivery  ☑ Pickup   ☐ Guangzhou delivery only

Maps to: `pd-price`, `pd-compare` (was price), per-store stock (`pd-store-stocks`),
the variants panel (`va*`), and the local-ship flag.

---

## Step 3 — the details

> **The details**
> Paste anything you've got — a description, the back of the package, a spec sheet.
> We'll fill in the boxes below. Or type them yourself.
> `[ Paste text & fill the boxes ]`  *(AI extract → `/api/retail-admin/ai/extract-facts`)*
>
> **Net weight** → `200g`
> **Where it's from** → `Peru`
> **What's in it** → `100% cacao`
> **How to store it** → `Cool, dry place`
> **Keeps for** → `12 months`
> **How to enjoy it** → `Add to smoothies, oats or baking`
>
> **Free from anything?** (optional) — we ticked what looks right, please check:
> ☑ Gluten-free  ☑ Vegan  ☐ Dairy-free  ☐ Nut-free  `[ + Add one ]`
> *This is your promise to shoppers, so make sure it's true.*

Maps to: `product_facts` boxes (`pd-fact-*`), `pd-weight`, and `free_of` (`pd-free-of`).
Nutrition is **deferred** (full editor only in v1).

---

## Customize? — optional, default No

> **Do customers get to pick anything?**
> For example: choosing a dressing, or paying a bit more for extra toppings.
> `[ No, it's the same for everyone ]`   `[ Yes, they can pick ]`

After **Yes** — two buttons:

**➕ A free pick** — *like choosing a dressing* → editor `single` option, all choices +¥0
> **What are they picking?** → `Choose your dressing`
> **Their options:** `Ranch` · `Caesar` · `No dressing`  `[ + Add another ]`
> ☐ They have to pick one before they can buy   ⭐ Show one as the usual pick

**➕ A paid extra** — *like extra pickles for ¥4* → editor `multi` option
> **What can they add?** → `Extra pickles`
> **How much extra?** ¥ `4`
> **Is this also a product you sell? (optional)**
> Connect it, and we'll keep the count right for you:
> • each one a customer adds comes off that product's stock
> • when it's sold out, customers stop seeing it
> *Skip this if it never runs out (like a sauce you always have).*  `[ Connect a product ]`

Maps 1:1 to `body.options`:
`{question_en/cn, type, is_required, choices:[{label_en/cn, price_delta, is_default, stock_product_id}]}`.
No backend change — the customer pipeline already reads this.

---

## Step 4 — take a look & publish

> **Take a look** — Here's your product page, exactly as shoppers will see it. `[ phone preview ]`
>
> **A few things you could still add** (no rush — you can finish later):
> ✓ Name, price, photo   ✓ Details   ⚠ No "how to enjoy it" yet
>
> **The nice designed page is on** — built from your details. `[ Use a plain page instead ]`
>
> `[ Save as draft ]`     `[ Publish it ]`
> Nothing goes live until you tap **Publish**.

Maps to: the Design:On compose (`pdAutoComposeBlocks`), `use_block_design`, `pd-published`.
Customizations show in the readiness summary.

---

## Deferred to v2 (editor-only in v1)

- **Bundle (sold as one)** (`bundle_items`, `bp*`) — structural; changes stock/price/facts model.
- **Buy together** upsell set (`bundle`, `bu*`) — semi-legacy (price/voucher fields the home block moved off).
- **Nutrition facts** — manual entry stays in the editor; the designed page still renders it.
- **"Type an answer"** option mode (free-text) — trivial to add as a 3rd customize button later.

## Hidden in the wizard (sensible defaults; full editor only)

Status → Active · Low-stock threshold → store default · Badge → Auto · Internal notes ·
Roots flags (Sold at markets / Made fresh in batches / Restock-only).
