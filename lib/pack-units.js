'use strict';

// How a channel option that sells more than one unit converts between the shelf
// and the platform.
//
// Meituan and Eleme both hang several 规格 off one listing, each with its own
// price and its own stock box. Usually those are variants of different products
// (the hand soap's three scents). Sometimes they are the SAME product in packs:
// "咖啡大师 Oatly Barista" sells one bottle as 1瓶 / 3瓶 / 6瓶, and a sale of the
// last one takes six bottles off the shelf.
//
// Both maps carry units_per_pack on the claim, and everything that crosses the
// boundary goes through here so the two directions can't drift apart:
//
//   push    floor(stock / units)  — what that box can still sell
//   order   qty × units           — what a sale of it took
//
// Kept deliberately total: a missing, zero, or junk unit count reads as 1, which
// is the pre-pack behaviour and the safe direction (it never invents stock and
// never over-deducts).

// A usable pack size. Anything unparseable, absent, or below 1 is 1.
function packUnits(units) {
  const n = parseInt(units, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// What to write into one option's stock box, given the product's shelf count.
// Floored: half a six-pack is not sellable, and rounding up is the one direction
// that oversells.
function packQty(stock, units) {
  const have = parseInt(stock, 10);
  if (!Number.isFinite(have) || have <= 0) return 0;
  return Math.floor(have / packUnits(units));
}

// What a sale of `qty` of one option takes off the shelf.
function packDeduct(qty, units) {
  const n = parseInt(qty, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * packUnits(units);
}

module.exports = { packUnits, packQty, packDeduct };
