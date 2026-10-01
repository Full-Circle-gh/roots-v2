## §NEW — THE CHANNEL SYNC SCREEN ON THE PHONE GAINS THE DESKTOP'S PICKER, SEARCH AND SYNC SWITCH (§326.3)

**Built 2026-10-01 under §325.** This is step X8b, the second part of X8,
on the Settings / Channels / Dashboard / Billing lane. The phone's Channel
sync screen now has what the desktop page's tools have
(`29-channel-sync.js`).

1. **The channel picker.** "All channels" or one channel.
   - With a channel picked, each item is counted and filtered by that
     channel's own state; with none, by its worst. That is the desktop's
     `stateOf` / `countsFor`, so the chips' numbers follow the pick.
   - The phone now counts locally too (with no channel picked, the numbers
     are the same as the server's).
   - A **Name not checked** chip appears when something is in it, as on the
     desktop.
2. **The search.** Matches name (both languages), SKU and size.
   - It repaints the list alone, so typing keeps the keyboard.
   - It does not change the counts, as on the desktop.
   - It is cleared each time the screen opens.
3. **The Sync on / off switch, beside Sync now on each channel line.**
   §326.3 overturned §124's "the switch stays on the desktop" by name.
   - **What it sends:** the desktop's write,
     `POST /channel-sync/:channel/products/:id/sync {on}`.
   - **Who sees it:** it is drawn for `{channel}:map`, the key
     `lib/cap-routes.js` asks of that path. Without the key there is no
     switch and nothing is sent.
   - **Not drawn** where nothing is mapped.
4. **Turning sync off asks first** (§326.3). The confirm names the item and
   the channel. It says the channel keeps the number it shows now and stops
   following the shelf. It also says this is a lasting change that stays
   until somebody turns it back on, with no reminder.
   - Turning sync back on asks nothing, as on the desktop.
   - As with Sync now, the result shows when the list reloads; a refusal
     or a "somebody else changed this" answer is said on the row.
5. **Kept:** "Fix this on the desktop" still names the three reasons that
   need the channel's catalogue picker (`no_name`, `name_not_found`,
   `no_option`). Matching and claims are X8c.
