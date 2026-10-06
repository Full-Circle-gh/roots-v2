// Products added IN BULK that need the customer to answer a question first
// (§435). "Buy again", favourites "Add all", the home bundle block and the
// product page's "Buy together" used to call cart.add(p, qty, []) for every
// item, so a product with a required question went into the cart with no
// answer, and checkout refused it ("Please choose: Whole-Wheat Pita"). A
// customer who removed it and added it back the same way met the same refusal.
//
// Those screens now add only what needs no answer, and hand the rest to this
// queue. The queue opens each product page in turn with its choice sheet
// already up (`pick=1`); after the add, the product page moves on to the next
// one, and back to where the customer started after the last.
//
// The single-product quick adds (shop grid +, one favourite) use it too, with
// a batch of one: the + opens the product page with the sheet already up,
// rather than leaving the customer to tap "Add to basket" a second time.

const queue = [];

function url(entry) {
  return '/pages/product/product?id=' + entry.id + '&pick=1'
    + (Number(entry.qty) > 1 ? '&qty=' + Number(entry.qty) : '');
}

// entries: [{ id, qty }]. Opens the first; keeps the rest. Returns whether it
// opened anything, so a caller can skip its own "added" toast when nothing was.
function start(entries) {
  const list = (entries || []).filter(e => e && Number(e.id) > 0);
  queue.length = 0;
  if (!list.length) return false;
  queue.push(...list.slice(1));
  wx.navigateTo({ url: url(list[0]) });
  return true;
}

// The next product to open, or null when the queue is done.
function next() { return queue.length ? queue.shift() : null; }

// A product page opened any other way ends the batch: the customer has gone
// somewhere else, and walking them back into the queue later would surprise.
function clear() { queue.length = 0; }

module.exports = { start, next, clear, url };
