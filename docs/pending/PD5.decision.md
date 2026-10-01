## §NEW — A PRODUCT'S CORE FIELDS AND DESCRIPTION ARE EDITED ON THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The product sheet gained a **Details** row, for `products:edit`, which opens
a screen holding the desktop editor's core fields: Basics (both names, SKU),
Where it shows (shop section, subcategory, badge, size), price and was-price,
the hand-typed cost where it is the operator's, the low-stock line, Product
details (the five facts in both languages), the two-language rich
Description, Shipping, Flags, Free of and Internal notes. It saves itself as
the desktop does: through the shared autosave engine (`tacet-autosave.js`),
800 ms after the last edit, one write in flight, `PATCH /products/:id`, with
Undo and Version history on its foot. Photos (PD6), sizes (PD9), bundles
(PD10), customer choices (PD11) and the page designer (§326.7) are not on it.

1. **It sends only the fields that changed, under the desktop's keys and
   meanings.** The desktop sends its whole form. The server writes only the
   keys it is given (an absent key means "not touched", the contract the
   cost and facts guards already depend on). So a smaller body is the same
   write, with fewer ways to put a stale value back over another screen's.
   The two descriptions always travel together with `description_format:
   'rich'`, and the cost always travels with its "not complete" tag.
2. **The desktop's autosave rules, each one asserted:**
   - nothing is sent until there is a name (the desktop's hold, in its words);
   - an emptied price is never sent, because it would make the product free;
   - a price that is not a number of 0 or more is held, with the phone's
     existing price sentence;
   - **`unit_cost` is sent only when it was loaded and is the operator's to
     type**: `products:costs` on a board that may read money, the server sent
     the key, the build-list read came back, and no recipe, bundle or build
     list owns the figure (`pdApplyCostSource`'s order). In every other case
     the box is not drawn and the key never leaves the phone. A build list
     that could not be read counts as "do not know", never as "none";
   - **Product facts are sent only once a box has been touched** (§156);
   - **`sku_taken`** names the product holding the code, in `skuTakenMsg`'s
     words, on the screen's foot. A refusal says why there too.
3. **Product facts keep keys the phone does not show.** The bag is generic, so
   a page editor or another product type can file keys beyond the five boxes.
   When the phone writes the bag, it carries those keys back rather than
   dropping them. The desktop's `pdFactsGet` drops them; that is recorded
   here as a desktop gap, not fixed.
4. **Rich text on a phone is the formatting a thumb can reach**: bold,
   italic, underline, bulleted and numbered lists, and clear formatting, with
   the desktop's own names. Everything else the desktop toolbar does (colour,
   highlight, alignment, indent, links, inline images, tables, rules,
   fullscreen) is not offered, but markup already in a description is kept
   as it is. A legacy plain description opens as HTML and saves as rich, as
   on the desktop.
5. **What it does not send.** Status is left alone (the desktop's dead field
   heals itself on its own saves). The shop switch, the out-of-stock rule and
   the supplier switches stay on the product sheet, where §325's safety step
   gated them. AI "Auto-fill from text" for the facts is not on the phone in
   this step.
6. **An upstream-catalogue tenant gets no Details door**, as its desktop shows
   no editor (the server refuses those core fields with `catalog_locked`).
7. **Leaving sends what is pending and hands back the product's sheet**, as
   Cost & Pricing does. After each save, the catalogue row the rest of the
   phone reads takes the saved name, code, price and section, and keeps its
   per-store stock.
