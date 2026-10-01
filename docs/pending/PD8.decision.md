## §NEW — CATEGORIES ARE ARRANGED FROM THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The phone's Categories screen gained everything the desktop's Products →
Categories shelf does, with taps instead of drags. It has the **Mini app /
QR menu** views (§288). In the QR menu's view, Move up / Move down and the
eye change only the QR menu, and Reset to mini app order is there. On an
open shelf, the products appear in the order of the view on screen, with Move
up / Move down inside their heading and Move to another shelf. The tree itself
can be changed: add, rename and remove top categories and subcategories, and
reorder them. Every write is the desktop's request:
`PUT /category-tree {tree, version}` (S2c's version check),
`PUT /category-tree/qr-order` (the whole small value),
`POST /products/reorder {ids}`, and
`PATCH /products/:id {top_category, subcategory}`.

1. **Each committed change is one save, made at once, and the screen waits
   for it.** The desktop autosaves a working copy 1.2 s after the last drag.
   A phone has no working copy to come back to. So the tree on screen is
   only ever the one the server last answered with, a second change cannot
   start while a save is out, and a refusal stays above the shelf. Toasts
   only confirm. A rename that re-tags products says how many, in the
   desktop's words.
2. **Every tree save carries the version it was read at.** A phone that
   loaded the tree before somebody else's edit is refused (`stale_tree`),
   says so, and reads the tree again, instead of putting the old tree back
   and re-tagging products a second time. This is the S2c check the brief
   reserved this part of PD8 for.
3. **The desktop's guards come with each write**:
   - the rename card's English-name requirement;
   - "The shop needs at least one category", checked before a remove is asked;
   - Remove category always asks, naming the subcategories that go with it;
   - Remove subcategory asks only when products stand under it, as on the
     desktop;
   - the server's own refusals (duplicate names) are shown as it words them.
4. **Gates are what the server checks**: `categories:edit` for the tree,
   the QR order and the eye, and `products:edit` for a product's order and
   shelf. A reader sees the shelves exactly as before and no control. A
   category editor without `products:edit` arranges the tree but not the
   products.
5. **The products on a shelf are grouped the way each menu draws them**
   (`catProdBuildGroups`):
   - In the mini app's view: headings in the tree's order, a heading the tree
     no longer names after them, and the products with no heading last.
   - In the QR menu's view: only products on a QR menu; the no-heading group
     comes first, with stray headings folded into it.
   - A variant family moves as one.
6. **Retired**: the phone note "Rename, reorder, add and remove on desktop".
   The slow browser suite's case that pinned it now pins the doors instead.
   It was edited, but not run, because the slow shard is not run.
