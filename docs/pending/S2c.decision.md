## §NEW — A WHOLE-TREE SAVE FROM A STALE COPY IS REFUSED, NOT APPLIED

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Step S2c, the parity survey's defect 11. Two saves replace a whole structure with
the copy a screen loaded. The phone uses both from a screen that may have been
open for a while:
- **The category tree** (`PUT /category-tree`). The phone's banner editor saves
  the whole tree, because the banner lives on its node. If the desktop renames a
  category while the phone has the tree open, the phone's next banner change puts
  the old name back. A rename re-tags products, so reverting one re-tags them
  again.
- **The pop-ups list** (`PUT /config {popups.list}`). The phone's switch sends
  every pop-up. A pop-up added or edited on the desktop in the meantime
  disappears.

Both saves now use an optimistic version. The screen sends the version it loaded.
If the server's copy has changed since, the save is refused with 409, the current
copy and its version, and nothing is written. A caller that sends no version is
not checked, so the desktop and the mini-app editor work exactly as before.

1. **The version is a hash of what is stored** (`contentVersion`, the first 16
   hex characters of a SHA-1). It changes exactly when the stored value changes.
   An `updated_at` would not do: it has one-second resolution, so two saves in the
   same second would share it. The hash also needs no new column. For the tree it
   is the hash of the tree as served, including the built-in seed tree.
2. **The category tree.** `GET /category-tree` returns `version` beside `data`;
   `data` is unchanged. `PUT` accepts an optional `version`. If it is stale, the
   answer is `409 {error:'stale_tree', version, data}`. A successful save returns
   the new `version`.
3. **The pop-ups list, and any config key.**
   - `GET /config` returns `_versions` for the keys saved whole. That is
     `popups.list` today (`VERSIONED_CONFIG_KEYS`).
   - `PUT /config?expect=<key>:<version>` refuses a stale key with
     `409 {error:'stale_config', key, version, value}` and writes nothing from the
     body.
   - A malformed `expect` is refused (400 `bad_expect`), not ignored: a caller
     that asked for the check must not get an unchecked save.
   - The version is a query parameter, not a body field, because every body key
     is stored as a setting.
   - A successful save returns `_versions`.
4. **Checked twice.** The server checks once before the write, and again inside
   the transaction. Saves on the connection queue one after another, so no other
   save can land between the second check and the write.
5. **The phone.**
   - **Category banner.** The tree is loaded with its version (`apiRaw`, because
     `api()` keeps only `data`) and the save sends it back. When the save is
     refused, the phone reloads the tree, throws the stale copy away, and shows
     one sentence where the banner is: *"Somebody else changed this while you had
     it open. It has been reloaded — try again."*
   - **Pop-up switch.** It sends `expect` with the version it loaded. When
     refused, it shows the list the server sent back at the current version and
     shows the same sentence in its error line. No toast claims a save that did
     not happen. The next switch then saves.
6. **Not done here, deliberately:**
   - The desktop's category editor, the desktop's pop-up editor and the mini-app
     editor send no version, so they are unchecked. A desktop save can still
     overwrite a phone edit made in the meantime. Making them send one is a
     change to three editors, each with its own save and conflict wording, so it
     is a separate step.
   - The desktop pop-up card (`PU_CARD`) also rewrites the whole list each time it
     autosaves. That would need a version kept per open editor.
7. **Tests.**
   - `scripts/test_whole_save_versions.js` (fast shard, 54 checks) runs the real
     router over a scratch database. For the tree: a desktop rename while the
     phone has the tree open, the phone's stale save refused, the rename standing
     with its product still re-tagged, the retry saving. For the pop-ups: a
     desktop pop-up added while the phone has the list open, the phone's stale
     switch refused, the new pop-up kept, the rest of the refused body unwritten,
     a malformed `expect` refused, and the retry with the returned version saving.
     It also runs the phone's own `loadCategories` and pop-up switch from
     `public/m.html` against those answers and asserts every request field, the
     reload, the words, and the no-version path.
   - `scripts/test_mobile_category_banner.js` gains the version on the banner
     save and the refused-as-stale path.
8. **One string composed**: the stale sentence, built from the desktop's own
   refusal for the same situation. See the vocabulary entry.
