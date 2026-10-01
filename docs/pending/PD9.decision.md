## §NEW — A PRODUCT'S SIZES ARE EDITED FROM THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The phone's Details screen for a product gained a **Variants** card. It does
what the desktop editor's Variants table does. It lists every size of the
family in the order shoppers see, each with its photo, its label in both
languages, SKU and size, price and was-price, stock, and a per-size **Show**
switch. From the card an operator can add a size, delete a size, move sizes
up and down, change a size's labels and fields, give a size its own photo,
and set the word the shop's picker uses ("size", "flavour"). Every write is
the desktop's own request: `PUT /products/:id/variants {members, noun_en,
noun_cn}`, `PATCH /products/:sid`, `POST /products/:id/duplicate
{as_variant: true, label: ""}` and `DELETE /products/:sid`.

1. **Each action is one save, made when it is taken.** The desktop gathers
   labels, order and the other sizes' fields into the editor's Save. The
   phone has no Save button to gather them into. So:
   - labels, order and the picker word go at once, as the whole family in
     one PUT, which is what the server checks against;
   - another size's SKU, size, price and was-price go in one PATCH of that
     size, carrying only the fields that moved;
   - after every write the family and the catalogue are read again, so the
     product sheet's size chips follow;
   - while a write is out, the card's controls wait and the card says what
     is running;
   - a refusal stays on the card. A toast only confirms.
2. **The size that is open on the screen is edited through the boxes above
   the card.** Its SKU, size, price and was-price go into the Details fields
   and save with them. The desktop does the same (`vaSelfField`). This keeps
   one box per fact and avoids a second write that could disagree with the
   first. Its photo is the Photos card. It cannot be deleted from this card.
   Deleting the product itself is the single delete, which comes in PD14.
3. **A hidden size stays hidden (§294).** The Show switch on the card is the
   per-size tick box. It writes `is_published` for that one size and never
   uses the family switch. A new size arrives hidden, as on the desktop, and
   wears the Hidden label until someone turns it on. Its edit sheet opens
   straight away, as the desktop puts the cursor in the new row's label.
4. **The desktop's guards come with each write:**
   - an emptied price is never sent;
   - an emptied was-price is sent as 0, which means no strike-through;
   - a SKU another product already holds is named in the desktop's words,
     including which size it was typed on;
   - deleting asks the desktop's question first;
   - a photo over 25 MB is refused, and any other photo is shrunk with the
     product preset before it is sent.
5. **Gates are what the server checks.** `products:edit` covers the card,
   order, labels, fields, Show and photos. `products:create` covers Add,
   because a new size is a new product. `products:delete` covers Delete. The
   card's text does not offer a tap that would be refused. A tenant whose
   catalogue is kept upstream does not see the Details screen at all, as
   before.
