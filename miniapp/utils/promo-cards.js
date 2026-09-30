// §296 — which promo cards show today.
//
// One place, because two surfaces draw the same cards: the promo_cards block
// (components/block-renderer) on Home and the editor-built pages, and the top
// of the Shop tab (pages/shop). If each decided "today" and "in its dates" on
// its own, a card could show on one and not the other on the same morning.
//
// A card: { id, image_url, target, start_at, end_at } — start_at / end_at are
// optional 'YYYY-MM-DD' days, the same shape the pop-ups use.

const MAX_CARDS = 5;

// Today on the shop's own calendar (China, UTC+8). A bare UTC date would keep
// a card that ends on the 31st alive until 08:00 on the 1st. The editor
// (public/cms.html promoToday) and the web renderer compute the same day.
function chinaToday(now) {
  const ms = now == null ? Date.now() : Number(now);
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

// Inside its start / end day, both inclusive. A missing bound is open.
function inDateWindow(item, today) {
  if (!item) return false;
  if (item.start_at && today < item.start_at) return false;
  if (item.end_at && today > item.end_at) return false;
  return true;
}

// The cards to draw, in the editor's order: a picture, inside its dates, five
// at most (the editor allows five; an over-long list saved another way still
// shows five).
function promoCardsToShow(cards, now) {
  const today = chinaToday(now);
  return (Array.isArray(cards) ? cards : [])
    .filter(c => c && c.image_url && inDateWindow(c, today))
    .slice(0, MAX_CARDS);
}

module.exports = { MAX_CARDS, chinaToday, inDateWindow, promoCardsToShow };
