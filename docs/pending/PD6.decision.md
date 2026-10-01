## §NEW — A PRODUCT'S PHOTOS ARE MANAGED FROM THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The Details screen PD5 added now has the desktop editor's Photos card. It
shows the ordered gallery (up to eight, the first marked Main), with Add,
which shrinks each picture on the phone first, and From library, which picks
from the Media library. Each photo can be removed, moved up or moved down, or
tapped to see it large. The gallery is written the desktop's way: the whole
ordered list as `images` in the same `PATCH /products/:id` the screen
autosaves with. The server replaces the gallery with that list and keeps the
main photo on its first entry.

1. **`images` is sent only after the gallery was loaded and then changed
   here** (`_pdGalleryDirty`). The server replaces the whole gallery with
   what it is given, so a list sent from a phone that never saw the real one
   would wipe it. A gallery that did not load is said on the card with Try
   again, is not drawn as empty, offers no control, and is never sent.
   Another edit on the screen does not carry an untouched gallery with it.
2. **Add shrinks with the desktop's product preset**: a 1440 px long edge,
   JPEG at quality 0.88 (a transparent PNG flattens to white), a small JPEG
   under 200 KB passed through, anything over 25 MB refused. A picture that
   is too big or cannot be read is said on the card, and the others still go
   in. A shrink is confirmed in a toast, as on the desktop.
3. **From library** lists the Media library's pictures sixty at a time
   (`GET /media/list?mime=image`), with a search that waits for a pause and
   Load more. It allows only as many picks as the gallery has room for, and
   says so in the sheet rather than in a toast. Each pick is fetched and
   shrunk like an upload, so it lands self-contained, exactly as the
   desktop's does.
4. **Reorder is Move up / Move down instead of the desktop's drag.** It is the
   same reorder, done with a thumb. Moving a photo to the top makes it the
   main photo.
5. **A size showing a sibling's photos says so** in the desktop's sentence.
   Any change makes them this size's own, as on the desktop.
6. **Undo puts back the gallery as it was loaded and sends that list.** The
   catalogue card's picture follows the saved main photo.
