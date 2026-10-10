'use strict';
// WHICH KITCHEN-REQUEST LINES ARE STILL WAITING ON THE BUYER — one clause, two
// readers: GET /material-requests/pending-lines (the Purchasing list) and the
// `kitchen_asks` fire on /dashboard/ops (Home's Needs you, §449). A fire that
// disagrees with the list it opens means one of the two is lying, so neither
// keeps its own copy.
//
// Drafts are out (somebody still typing), archived requests are out (withdrawn),
// lines already on a purchase order are out (sourced), and lines the buyer
// struck off are out (§174).
const PENDING_FROM = `material_request_items i
      JOIN material_requests r ON r.id = i.request_id`;
const PENDING_WHERE = `r.status IN ('sent', 'sourced')
       AND r.archived_at IS NULL
       AND i.sourced_po_id IS NULL
       AND i.declined_at IS NULL`;

module.exports = { PENDING_FROM, PENDING_WHERE };
